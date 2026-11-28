---
id: track-06-lesson-12
title: "Kafka High Availability — Replication and Partition Leadership"
slug: kafka-ha
track: track-06
trackName: "Reliability & Production Engineering"
sequence: 12
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, HA, replication-factor, ISR, leader-election]
prerequisites: [track-06-lesson-02]
---

# Kafka High Availability — Replication and Partition Leadership

> [!NOTE]
> Kafka's durability guarantees are only as strong as your configuration. Since Kafka 3.0 the *producer* defaults are safe (`acks=all`, idempotence on), but the *broker* defaults (`default.replication.factor=1`, `min.insync.replicas=1`) still mean you can lose messages on a single broker failure. For payment event processing, losing a "PAYMENT_DEBITED" event means the debit is unrecorded and the customer's balance is wrong. The correct configuration for fintech — replication.factor=3, min.insync.replicas=2, acks=all — gives durability comparable to a synchronously replicated database write. (Kafka acknowledges once the in-sync replicas have the record in memory/page cache; its durability comes from replication across machines, not from an fsync per message.)

## Kafka HA Architecture for Fintech

```
Broker 0 (AZ-a)    Broker 1 (AZ-b)    Broker 2 (AZ-c)
─────────────────  ─────────────────  ─────────────────
payment-events-0   payment-events-0   payment-events-0
  Leader             Replica ISR         Replica ISR

payment-events-1   payment-events-1   payment-events-1
  Replica ISR         Leader              Replica ISR

payment-events-2   payment-events-2   payment-events-2
  Replica ISR         Replica ISR         Leader
```

Partitions are spread across brokers in different availability zones. When a broker fails, Kafka elects a new leader from the ISR (In-Sync Replicas) set for each affected partition.

---

## 1. Topic Configuration for Fintech

```java
@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic paymentEventsTopic() {
        return TopicBuilder.name("payment-events")
                .partitions(12)        // size for expected throughput
                .replicas(3)           // RF=3: survive 1 broker failure
                .config(TopicConfig.MIN_IN_SYNC_REPLICAS_CONFIG, "2")
                .config(TopicConfig.UNCLEAN_LEADER_ELECTION_ENABLE_CONFIG, "false")
                .config(TopicConfig.RETENTION_MS_CONFIG,
                        String.valueOf(Duration.ofDays(7).toMillis()))
                .config(TopicConfig.COMPRESSION_TYPE_CONFIG, "lz4")
                .config(TopicConfig.MAX_MESSAGE_BYTES_CONFIG,
                        String.valueOf(1024 * 1024))  // 1MB max message
                .build();
    }

    @Bean
    public NewTopic fraudAlertsTopic() {
        return TopicBuilder.name("fraud-alerts")
                .partitions(6)
                .replicas(3)
                .config(TopicConfig.MIN_IN_SYNC_REPLICAS_CONFIG, "2")
                .config(TopicConfig.UNCLEAN_LEADER_ELECTION_ENABLE_CONFIG, "false")
                .config(TopicConfig.RETENTION_MS_CONFIG,
                        String.valueOf(Duration.ofDays(30).toMillis()))
                .build();
    }
}
```

### Critical Configuration Parameters

```properties
# NEVER set unclean.leader.election.enable=true in fintech
# This would allow an out-of-sync replica to become leader, losing messages
unclean.leader.election.enable=false

# min.insync.replicas: producer acks=all requires at least 2 replicas to ACK
# With RF=3 and min.insync.replicas=2:
# - Tolerate 1 broker failure: RF-1=2 replicas remain, meeting min.insync=2
# - Tolerate 2 broker failures: 1 replica remains, BELOW min.insync — PRODUCER BLOCKS
# This is the correct trade-off: durability over availability
min.insync.replicas=2
```

---

## 2. Producer Configuration for Durability

```java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, Object> producerFactory(
            KafkaProperties kafkaProperties) {
        Map<String, Object> props = new HashMap<>(
                kafkaProperties.buildProducerProperties());

        // acks=all: wait for all ISR replicas to acknowledge
        // This is the strongest durability guarantee Kafka offers
        props.put(ProducerConfig.ACKS_CONFIG, "all");

        // Idempotent producer: exactly-once per partition
        // Prevents duplicate messages on producer retry
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);

        // Retries: idempotent producer handles duplicate detection
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000);  // 2 min total
        props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG,  30_000);   // 30s per attempt
        props.put(ProducerConfig.RETRY_BACKOFF_MS_CONFIG,    100);

        // Batching
        props.put(ProducerConfig.BATCH_SIZE_CONFIG,     16_384);  // 16KB
        props.put(ProducerConfig.LINGER_MS_CONFIG,      5);       // wait 5ms to batch
        props.put(ProducerConfig.BUFFER_MEMORY_CONFIG,  33_554_432); // 32MB

        // Compression
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");

        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    public KafkaTemplate<String, Object> kafkaTemplate(
            ProducerFactory<String, Object> factory) {
        KafkaTemplate<String, Object> template = new KafkaTemplate<>(factory);
        // Observe send results for monitoring
        template.setObservationEnabled(true);
        return template;
    }
}
```

### Payment Event Producer

```java
@Service
public class PaymentEventProducer {

    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(PaymentEventProducer.class);

    /**
     * Returns the send future so the CALLER can react to a failure.
     * Throwing inside whenComplete() would be lost: that callback runs later,
     * on the producer's I/O thread, after this method has already returned.
     * (For events that must never be lost, write them to an outbox in the
     *  same DB transaction as the payment and let a relay publish them.)
     */
    public CompletableFuture<SendResult<String, Object>> publishPaymentEvent(PaymentEvent event) {
        // Key by payment ID: ensures ordering within a payment's lifecycle
        String key = event.getPaymentId();

        ProducerRecord<String, Object> record =
                new ProducerRecord<>("payment-events", key, event);

        // Add tracing headers
        record.headers()
              .add("correlation-id", event.getCorrelationId()
                      .getBytes(StandardCharsets.UTF_8))
              .add("event-type", event.getEventType().name()
                      .getBytes(StandardCharsets.UTF_8));

        return kafkaTemplate.send(record)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        // acks=all failure: message was NOT durably stored
                        meterRegistry.counter("kafka.publish.failure",
                                "topic", "payment-events").increment();
                        log.error("Failed to publish payment event: id={} type={}",
                                event.getPaymentId(), event.getEventType(), ex);
                    } else {
                        meterRegistry.counter("kafka.publish.success",
                                "topic", "payment-events").increment();
                        log.debug("Payment event published: id={} partition={} offset={}",
                                event.getPaymentId(),
                                result.getRecordMetadata().partition(),
                                result.getRecordMetadata().offset());
                    }
                });
    }

    /** Caller that must not proceed without a durable event: wait, bounded. */
    public void publishOrFail(PaymentEvent event) {
        try {
            publishPaymentEvent(event).get(10, TimeUnit.SECONDS);
        } catch (Exception e) {
            throw new PaymentEventPublishException("Failed to publish payment event", e);
        }
    }
}
```

---

## 3. Consumer Configuration for Reliability

```java
@Configuration
public class KafkaConsumerConfig {

    @Bean
    public ConsumerFactory<String, Object> consumerFactory(
            KafkaProperties kafkaProperties) {
        Map<String, Object> props = new HashMap<>(
                kafkaProperties.buildConsumerProperties());

        // Manual offset commit: only commit after successful processing
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);

        // Read from earliest on first assignment — never miss events
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");

        // Session timeout: how long before broker considers consumer dead
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, 30_000);

        // Heartbeat interval: should be ~1/3 of session.timeout.ms
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, 10_000);

        // Max poll interval: how long processing can take before rebalance
        // Set conservatively for payment processing
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 300_000);  // 5 min

        // Fetch settings
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 100);
        props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, 1024);
        props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, 500);

        return new DefaultKafkaConsumerFactory<>(props);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, Object>
            kafkaListenerContainerFactory(
                    ConsumerFactory<String, Object> factory) {
        var containerFactory =
                new ConcurrentKafkaListenerContainerFactory<String, Object>();
        containerFactory.setConsumerFactory(factory);
        containerFactory.setConcurrency(3);  // 3 threads, one per partition group
        // Manual ACK mode: commit offset after successful processing
        containerFactory.getContainerProperties()
                .setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);
        return containerFactory;
    }
}
```

### Payment Event Consumer

```java
@Component
public class PaymentEventConsumer {

    private final PaymentProcessingService processingService;
    private final DeadLetterQueueService dlqService;
    private static final Logger log = LoggerFactory.getLogger(PaymentEventConsumer.class);

    @KafkaListener(
        topics = "payment-events",
        groupId = "payment-processor",
        containerFactory = "kafkaListenerContainerFactory"
    )
    public void processPaymentEvent(
            ConsumerRecord<String, PaymentEvent> record,
            Acknowledgment ack) {

        PaymentEvent event = record.value();
        try {
            processingService.process(event);
            // Only commit offset after successful processing
            ack.acknowledge();
            log.debug("Processed payment event: id={} offset={}",
                    event.getPaymentId(), record.offset());

        } catch (RetryableException e) {
            // Don't acknowledge: rethrow, and the container's error handler
            // (DefaultErrorHandler) seeks back to this record and retries it
            // with backoff — processing must be idempotent
            log.warn("Retryable error processing payment event: id={}",
                    event.getPaymentId(), e);
            throw e;

        } catch (NonRetryableException e) {
            // Poison pill: send to DLQ and acknowledge to avoid blocking partition
            log.error("Non-retryable error: sending to DLQ: id={}",
                    event.getPaymentId(), e);
            dlqService.sendToDeadLetterQueue(record, e);
            ack.acknowledge();
        }
    }
}
```

---

## 4. KRaft Mode (No ZooKeeper)

Kafka 3.x introduced KRaft mode, eliminating the ZooKeeper dependency. KRaft has been production-ready since Kafka 3.3, and Kafka 4.0 (2025) removed ZooKeeper support entirely — so every current cluster runs KRaft. The combined broker+controller node below is fine for small clusters and tests; larger production clusters usually run dedicated controller nodes.

```properties
# KRaft configuration (no ZooKeeper)
# server.properties for a combined broker+controller node

process.roles=broker,controller
node.id=1
controller.quorum.voters=1@kafka-1:9093,2@kafka-2:9093,3@kafka-3:9093

# Listeners
listeners=PLAINTEXT://kafka-1:9092,CONTROLLER://kafka-1:9093
inter.broker.listener.name=PLAINTEXT
controller.listener.names=CONTROLLER

# Storage
log.dirs=/var/lib/kafka/data

# Cluster ID (generated once: kafka-storage.sh random-uuid)
# Format storage on first setup:
# kafka-storage.sh format --config server.properties --cluster-id <uuid>
```

---

## 5. Rack-Awareness for Zone Spread

Kafka's rack-awareness feature ensures that replicas are placed on different racks (availability zones). Without it, all three replicas might end up on brokers in the same AZ — a single AZ failure takes all replicas down.

```properties
# broker.properties: set broker.rack to availability zone
# broker 0
broker.rack=us-east-1a
# broker 1
broker.rack=us-east-1b
# broker 2
broker.rack=us-east-1c
```

```java
// Verify rack-awareness is configured correctly
@Component
@Slf4j
public class KafkaRackAwarenessValidator {

    private final Map<String, Object> adminProps;

    public KafkaRackAwarenessValidator(KafkaAdmin kafkaAdmin) {
        this.adminProps = kafkaAdmin.getConfigurationProperties();
    }

    @PostConstruct
    public void validate() {
        // try-with-resources: an AdminClient holds threads and connections
        try (AdminClient admin = AdminClient.create(adminProps)) {
            // List brokers and their rack assignments
            DescribeClusterResult cluster = admin.describeCluster();
            Collection<Node> nodes = cluster.nodes().get(10, TimeUnit.SECONDS);

            long brokersWithRack = nodes.stream()
                    .filter(n -> n.rack() != null && !n.rack().isEmpty())
                    .count();

            if (brokersWithRack < nodes.size()) {
                log.warn("Not all brokers have rack configured: {}/{} have rack",
                        brokersWithRack, nodes.size());
            }

            // Check that at least 3 distinct racks are configured
            long distinctRacks = nodes.stream()
                    .map(Node::rack)
                    .filter(Objects::nonNull)
                    .distinct()
                    .count();

            if (distinctRacks < 3) {
                log.error("Insufficient rack diversity: {} distinct racks. " +
                          "Replicas may not be spread across AZs.", distinctRacks);
            }

        } catch (Exception e) {
            log.error("Kafka rack validation failed", e);
        }
    }
}
```

---

## 6. ISR Shrinkage Monitoring

When a replica falls behind and is removed from the ISR, the effective durability of commits decreases. If ISR drops below min.insync.replicas, producers with acks=all will block.

```java
@Component
public class ISRShrinkageMonitor {

    private final AdminClient adminClient;
    private final MeterRegistry meterRegistry;
    private final AlertService alertService;
    private static final Logger log = LoggerFactory.getLogger(ISRShrinkageMonitor.class);

    // One holder per topic-partition, registered as a gauge ONCE
    // (re-registering a primitive every run leaves the gauge frozen or NaN)
    private final Map<String, AtomicInteger> isrSizes = new ConcurrentHashMap<>();

    @Scheduled(fixedRate = 30_000)
    public void monitorISR() {
        try {
            // Get metadata for all payment-related topics
            DescribeTopicsResult result = adminClient.describeTopics(
                    List.of("payment-events", "fraud-alerts", "settlement-events"));

            result.allTopicNames().get().forEach((topic, description) -> {
                for (TopicPartitionInfo partition : description.partitions()) {
                    int replicationFactor = partition.replicas().size();
                    int isrSize          = partition.isr().size();

                    // Track ISR size per partition
                    isrSizes.computeIfAbsent(topic + "-" + partition.partition(), k ->
                        meterRegistry.gauge("kafka.isr.size",
                            Tags.of("topic", topic,
                                    "partition", String.valueOf(partition.partition())),
                            new AtomicInteger()))
                        .set(isrSize);

                    // Alert if ISR has shrunk
                    if (isrSize < replicationFactor) {
                        log.warn("ISR shrinkage: topic={} partition={} isr={}/{}",
                                topic, partition.partition(),
                                isrSize, replicationFactor);

                        if (isrSize == 1) {
                            // ISR=1: no redundancy; min.insync.replicas=2 means
                            // producers will BLOCK on next write
                            alertService.critical("KAFKA_ISR_CRITICAL",
                                    String.format(
                                        "ISR=1 on %s partition %d. " +
                                        "Producer will block when min.insync.replicas=2 " +
                                        "cannot be satisfied.",
                                        topic, partition.partition()));
                        } else {
                            alertService.warning("KAFKA_ISR_DEGRADED",
                                    String.format("ISR shrunk to %d/%d on %s partition %d",
                                            isrSize, replicationFactor,
                                            topic, partition.partition()));
                        }
                    }
                }
            });
        } catch (Exception e) {
            log.error("Failed to check ISR health", e);
        }
    }
}
```

---

## 7. Broker Failure Impact and Recovery

```
Scenario: Broker 1 fails (leader for 4 out of 12 partitions)

Immediate impact:
- Kafka detects broker failure via the KRaft broker session timeout (~9s default)
- Controller triggers leader election for affected partitions (~1-2s per partition)
- Producers get NOT_LEADER_OR_FOLLOWER error during election (~2-5s per partition)
- KafkaTemplate.send() with retries: queues messages, retries automatically
- Consumers: brief pause during partition reassignment

Configuration mitigation:
- producer.delivery.timeout.ms=120000: messages queued during 2-5s election
- consumer.session.timeout.ms=30000: consumer considered dead after 30s
- replica.lag.time.max.ms=30000: replica kicked from ISR after 30s lag

Recovery:
1. Bring broker back online
2. Kafka syncs broker from ISR (may take minutes for large lag)
3. Preferred leader election:
   kafka-leader-election.sh --election-type PREFERRED --all-topic-partitions ...
   (the old kafka-preferred-replica-election.sh was removed in Kafka 3.0)
   Or rely on auto.leader.rebalance.enable=true (default)
```

---

## 8. Payment Event Durability Guarantees

```java
// Exactly-once semantics for payment events using Kafka transactions.
// Requirements: a transactional producer (spring.kafka.producer.transaction-id-prefix)
// AND consumers with isolation.level=read_committed — otherwise consumers also
// read records from ABORTED transactions. The transaction covers Kafka writes
// only; a database write in the same method is NOT part of it (use an outbox).
@Service
public class TransactionalPaymentEventService {

    private final KafkaTemplate<String, Object> kafkaTemplate;

    // Kafka transactions ensure atomicity across multiple topic writes
    // Use when a single business operation writes to multiple topics
    @Transactional("kafkaTransactionManager")
    public void publishPaymentLifecycleEvents(Payment payment) {
        // All three publishes are atomic — either all committed or none
        kafkaTemplate.send("payment-events",
                payment.getId(),
                PaymentInitiatedEvent.from(payment));

        kafkaTemplate.send("fraud-scoring-requests",
                payment.getId(),
                FraudScoringRequest.from(payment));

        kafkaTemplate.send("audit-events",
                payment.getId(),
                PaymentAuditEvent.from(payment));
    }

    // For single-topic publishes: idempotent producer is sufficient
    public void publishSingleEvent(PaymentEvent event) {
        kafkaTemplate.send("payment-events", event.getPaymentId(), event);
    }
}
```

---

## 9. Monitoring Dashboard Metrics

| Metric | Threshold | Action |
|---|---|---|
| `kafka.isr.size` < replication-factor | Warning | Investigate lagging broker |
| `kafka.isr.size` == 1 | Critical | Immediate investigation; producer may block |
| `kafka.consumer.lag` > 10,000 | Warning | Consumer performance issue |
| `kafka.consumer.lag` > 100,000 | Critical | Consumer is not keeping up; backpressure risk |
| `kafka.producer.record.error.rate` > 0 | Warning | Producer not reaching ISR; delivery failure |
| Broker disk utilisation > 70% | Warning | Increase retention or add broker |
| Broker network bytes > 80% capacity | Warning | Scale out brokers |

---

## 10. Summary

Kafka HA for fintech requires three configuration layers: topic configuration (RF=3, min.insync.replicas=2, unclean leader election disabled), producer configuration (acks=all, idempotent), and consumer configuration (manual offset commit, appropriate session timeouts). KRaft mode removes ZooKeeper as a separate system to run and secure. Rack-awareness ensures replicas span availability zones. ISR monitoring is the critical operational metric — when ISR drops below min.insync.replicas, the payment processing pipeline will block until a replica catches up. This is by design: durability over availability for financial messages.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What happens to a Kafka producer with acks=all and min.insync.replicas=2 when only 1 replica is in the ISR?",
      "options": ["The producer switches to acks=1 automatically", "The producer successfully publishes to the single remaining replica", "The producer blocks (throws NotEnoughReplicasException) until a second replica rejoins the ISR", "The producer drops the message silently"],
      "correct": 2,
      "explanation": "With acks=all and min.insync.replicas=2, a producer requires at least 2 in-sync replicas to acknowledge the write. If only 1 replica is in the ISR, the broker returns a NotEnoughReplicasException and the producer blocks/retries. This is intentional — it prevents data loss by refusing to acknowledge writes that cannot meet the durability requirement."
    },
    {
      "text": "Why should unclean.leader.election.enable=false be set for payment-related Kafka topics?",
      "options": ["It improves producer throughput", "It prevents an out-of-sync replica from becoming leader and causing message loss", "It reduces leader election time", "It enables exactly-once semantics"],
      "correct": 1,
      "explanation": "If unclean leader election is enabled, a replica that is behind the ISR can be elected leader during a failure. This replica is missing messages that were committed on the previous leader — those messages are permanently lost. For payment events, losing a PAYMENT_DEBITED event means the debit is unrecorded, creating a financial error."
    },
    {
      "text": "Why must Kafka consumers use manual offset commit (ENABLE_AUTO_COMMIT=false) for payment event processing?",
      "options": ["Auto-commit is not supported by Kafka", "Auto-commit may commit offsets before processing completes, causing missed events on consumer restart", "Manual commit is faster than auto-commit", "Auto-commit causes rebalance issues"],
      "correct": 1,
      "explanation": "Auto-commit periodically commits the latest offset regardless of processing status. If the consumer crashes after committing but before successfully processing a payment event, that event is never processed. Manual commit only advances the offset after confirmed successful processing, ensuring at-least-once delivery guarantees."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Durable Kafka Payment Event Pipeline with HA Configuration",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Create Kafka topic definitions for payment-events (12 partitions, RF=3, min.insync.replicas=2, unclean.leader.election=false, 7-day retention) and fraud-alerts (6 partitions, same durability settings, 30-day retention) using Spring Kafka's TopicBuilder."
    },
    {
      "id": "2",
      "description": "Configure an idempotent producer (enable.idempotence=true, acks=all, retries=MAX_VALUE, delivery.timeout=120s) and implement a PaymentEventProducer that publishes with payment ID as the key, adds correlation-id and event-type headers, and surfaces send failures to the caller (by returning the send future, plus a publishOrFail() that waits with a bounded timeout and throws PaymentEventPublishException) — explaining why throwing inside whenComplete() does not work."
    },
    {
      "id": "3",
      "description": "Build an ISRShrinkageMonitor @Scheduled(fixedRate=30000) that queries AdminClient for all payment topic partitions, tracks ISR size per partition as a Prometheus gauge, sends warning when ISR < replication factor, and sends critical alert when ISR == 1."
    },
    {
      "id": "4",
      "description": "Implement a transactional payment event service using @Transactional(kafkaTransactionManager) that atomically publishes to payment-events, fraud-scoring-requests, and audit-events in a single Kafka transaction. Write an integration test with a read_committed consumer that verifies all three topics receive the event or none do when a mid-publish exception occurs."
    }
  ]
}
-->

