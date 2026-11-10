---
id: track-11-lesson-03
title: "Kafka Consumer — Offset Management and Rebalancing"
slug: kafka-consumer
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 3
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, consumer, offset, rebalance, commit-strategy]
prerequisites: [track-11-lesson-02]
---

# Kafka Consumer — Offset Management and Rebalancing

> [!NOTE]
> Offset management is where most Kafka consumer bugs originate in production financial systems. The difference between at-most-once, at-least-once, and exactly-once processing is determined entirely by when you commit offsets relative to when you process messages. Get this wrong and you either lose payment events or reprocess them on every restart.

## Overview

A Kafka consumer reads records from partitions, tracks its position (offset) within each partition, and commits those offsets back to Kafka so it can resume from the right place after restarts or failures. The mechanics sound simple, but the edge cases are where financial systems fail.

This lesson covers consumer group mechanics, every offset commit strategy with their trade-offs, partition rebalancing and its impact on processing continuity, Spring Kafka integration, and production error handling patterns.

---

## 1. Consumer Group Mechanics

### What Is a Consumer Group?

A consumer group is a set of consumers that cooperatively consume a topic. Kafka ensures that each partition is assigned to exactly one consumer within the group at any point in time.

```
Topic: payment-events (12 partitions)
Consumer Group: payment-processor

Consumer-1: partitions [0, 1, 2, 3]
Consumer-2: partitions [4, 5, 6, 7]
Consumer-3: partitions [8, 9, 10, 11]
```

This provides horizontal scalability: adding consumers to the group scales consumption throughput up to the partition count. Beyond that, additional consumers sit idle.

### Group Coordinator

Each consumer group has a **Group Coordinator** — a broker designated to manage group membership and partition assignments. Consumers periodically send heartbeats to the coordinator; if a heartbeat is missed within `session.timeout.ms`, the consumer is considered dead and a rebalance is triggered.

### Consumer Registration Flow

```
Consumer starts       → Sends JoinGroup request to Group Coordinator
Group Coordinator     → Selects one consumer as Group Leader
Group Leader          → Runs partition assignment algorithm
Group Leader          → Sends SyncGroup with assignments to Coordinator
Group Coordinator     → Distributes assignments to all consumers
All consumers         → Begin fetching from assigned partitions
```

---

## 2. Consumer Configuration Deep Dive

```java
@Bean
public ConsumerFactory<String, PaymentEvent> consumerFactory() {
    Map<String, Object> props = new HashMap<>();
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG,
        "kafka-broker-1:9092,kafka-broker-2:9092");
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-processor-v1");
    props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, JsonDeserializer.class);

    // Offset reset: what to do when no committed offset exists for this group
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");

    // How many records to return in a single poll() call
    props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 500);

    // Maximum time between poll() calls before consumer is considered dead
    // Must exceed your slowest processing time
    props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 300_000); // 5 minutes

    // Heartbeat interval (must be < session.timeout.ms / 3)
    props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, 3_000);

    // Session timeout — if no heartbeat, rebalance triggers
    props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, 30_000);

    // Fetch configuration
    props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, 1);
    props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, 500);
    props.put(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, 1_048_576); // 1 MB

    // Only read committed transactional messages (critical for EOS consumers)
    props.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");

    return new DefaultKafkaConsumerFactory<>(props);
}
```

### Critical Timing Relationships

```
session.timeout.ms    = 30000  (broker considers consumer dead after this)
heartbeat.interval.ms = 3000   (send heartbeat every 3s, must be < session/3)
max.poll.interval.ms  = 300000 (time your ACTUAL processing must stay within)
```

If your payment processing takes longer than `max.poll.interval.ms`, the consumer is forcibly removed from the group and a rebalance occurs — even if the heartbeat thread is still running. This is the number one cause of unexpected rebalances in systems that perform database writes or external API calls per message.

---

## 3. Offset Commit Strategies

### Strategy 1: Auto-Commit (Default — Dangerous for Financial Data)

```java
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, true);
props.put(ConsumerConfig.AUTO_COMMIT_INTERVAL_MS_CONFIG, 5000);
```

Auto-commit periodically commits the offset of the last polled record. This creates **at-most-once** processing:

```
poll() → returns records 0-99
consumer processes record 50 → consumer crashes
auto-commit already committed offset 100
restart → consumer starts at 100
records 51-99 are LOST FOREVER
```

**Never use auto-commit for payment processing.** The only acceptable use is for idempotent read-only analytics where losing a few records is tolerable.

### Strategy 2: Manual commitSync()

```java
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
```

```java
// In consumer loop:
ConsumerRecords<String, PaymentEvent> records = consumer.poll(Duration.ofMillis(500));
for (ConsumerRecord<String, PaymentEvent> record : records) {
    processPaymentEvent(record.value());
}
consumer.commitSync(); // Block until broker confirms offset commit
```

`commitSync()` provides **at-least-once** semantics:

```
Scenario A — Normal:
poll() → records 0-99 → process all → commitSync() → offset 100 committed
consumer crashes → restart → starts at 100 (correct)

Scenario B — Crash before commit:
poll() → records 0-99 → process record 50 → consumer crashes
no commit happened → restart → starts at 0
reprocesses 0-49, then processes 50-99 (duplicates for 0-49)
```

The downside is performance: `commitSync()` blocks the consumer loop until the broker acknowledges the commit — typically 10-50ms of extra latency per batch.

### Strategy 3: Manual commitAsync()

```java
consumer.poll(Duration.ofMillis(500));
// Process records
consumer.commitAsync((offsets, exception) -> {
    if (exception != null) {
        log.error("Offset commit failed: {}", exception.getMessage());
        // Note: commitAsync does NOT retry — next poll may recommit a higher offset
    }
});
```

`commitAsync()` is non-blocking and faster but does not retry on failure. If the commit fails (network issue), the consumer may reprocess those records on the next restart.

**Production pattern**: Use `commitAsync()` for most commits, `commitSync()` for shutdown:

```java
try {
    while (running) {
        ConsumerRecords<String, PaymentEvent> records =
            consumer.poll(Duration.ofMillis(500));
        processRecords(records);
        consumer.commitAsync((offsets, exception) -> {
            if (exception != null) {
                log.warn("Async commit failed, next poll will recommit: {}",
                    exception.getMessage());
            }
        });
    }
} finally {
    // Synchronous commit on shutdown ensures no reprocessing on clean restart
    try {
        consumer.commitSync();
    } finally {
        consumer.close();
    }
}
```

### Strategy 4: Per-Partition Commit (Fine-Grained Control)

For parallelism within a consumer, commit offsets per-partition as work completes:

```java
Map<TopicPartition, OffsetAndMetadata> offsetsToCommit = new HashMap<>();

for (ConsumerRecord<String, PaymentEvent> record : records) {
    processPaymentEvent(record.value());
    // Commit offset = current_record_offset + 1 (next record to fetch)
    offsetsToCommit.put(
        new TopicPartition(record.topic(), record.partition()),
        new OffsetAndMetadata(record.offset() + 1,
            "processed-at:" + Instant.now())
    );
}

consumer.commitSync(offsetsToCommit);
```

The committed offset must be `record.offset() + 1` — Kafka interprets this as "the next record to fetch from."

---

## 4. Spring Kafka @KafkaListener

### Basic Listener with Manual Acknowledgement

```java
@Component
@Slf4j
public class PaymentEventConsumer {

    private final PaymentProcessingService processingService;
    private final DeadLetterPublisher dlqPublisher;

    public PaymentEventConsumer(PaymentProcessingService processingService,
                                 DeadLetterPublisher dlqPublisher) {
        this.processingService = processingService;
        this.dlqPublisher = dlqPublisher;
    }

    @KafkaListener(
        topics = "payment-events",
        groupId = "payment-processor-v1",
        containerFactory = "paymentKafkaListenerContainerFactory"
    )
    public void handlePaymentEvent(
            @Payload PaymentEvent event,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            @Header(KafkaHeaders.RECEIVED_TIMESTAMP) long timestamp,
            Acknowledgment acknowledgment) {

        log.debug("Processing payment event {} from partition {} offset {}",
            event.getEventId(), partition, offset);

        try {
            processingService.process(event);
            acknowledgment.acknowledge(); // Commit after successful processing
        } catch (RetryableException e) {
            // Don't acknowledge — record will be redelivered after container restart
            // Spring Kafka's error handler will manage the retry cycle
            log.warn("Retryable error on event {}: {}", event.getEventId(), e.getMessage());
            throw e;
        } catch (NonRetryableException e) {
            // Skip the poison pill but publish to DLQ for investigation
            log.error("Non-retryable error for event {}, publishing to DLQ",
                event.getEventId(), e);
            dlqPublisher.publish("payment-events.dlq", event, e);
            acknowledgment.acknowledge(); // Move past this record
        }
    }
}
```

### Listener Container Factory

```java
@Configuration
public class KafkaConsumerConfig {

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, PaymentEvent>
            paymentKafkaListenerContainerFactory(
                ConsumerFactory<String, PaymentEvent> consumerFactory,
                KafkaTemplate<String, Object> kafkaTemplate) {

        ConcurrentKafkaListenerContainerFactory<String, PaymentEvent> factory =
            new ConcurrentKafkaListenerContainerFactory<>();

        factory.setConsumerFactory(consumerFactory);

        // Manual acknowledgement — commit explicitly after listener method returns
        factory.getContainerProperties()
            .setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);

        // Number of consumer threads (must not exceed partition count)
        factory.setConcurrency(4);

        // Error handler with dead-letter publishing
        DeadLetterPublishingRecoverer recoverer =
            new DeadLetterPublishingRecoverer(kafkaTemplate,
                (record, exception) -> new TopicPartition(
                    record.topic() + ".dlq",
                    record.partition()
                ));

        DefaultErrorHandler errorHandler = new DefaultErrorHandler(
            recoverer,
            new ExponentialBackOffWithMaxRetries(3) {{
                setInitialInterval(1_000L);
                setMultiplier(2.0);
                setMaxInterval(10_000L);
            }}
        );

        // Non-retryable exceptions — send straight to DLQ
        errorHandler.addNotRetryableExceptions(
            ValidationException.class,
            DataIntegrityViolationException.class,
            DeserializationException.class
        );

        factory.setCommonErrorHandler(errorHandler);
        return factory;
    }
}
```

### Batch Listener

```java
@KafkaListener(
    topics = "payment-events",
    groupId = "payment-batch-processor",
    containerFactory = "batchKafkaListenerContainerFactory"
)
public void handlePaymentBatch(
        List<ConsumerRecord<String, PaymentEvent>> records,
        Acknowledgment acknowledgment) {

    log.info("Processing batch of {} payment events", records.size());

    Map<String, PaymentEvent> eventMap = records.stream()
        .collect(Collectors.toMap(
            r -> r.value().getEventId(),
            ConsumerRecord::value,
            (a, b) -> b // Last-write wins for duplicates within same batch
        ));

    try {
        processingService.processBatch(new ArrayList<>(eventMap.values()));
        acknowledgment.acknowledge(); // Commit all offsets in batch
    } catch (PartialFailureException e) {
        // Handle partial batch failures — requeue failed events individually
        e.getFailedEvents().forEach(event ->
            dlqPublisher.publish("payment-events.dlq", event, e));
        acknowledgment.acknowledge(); // Don't block on partial failures
    }
}
```

---

## 5. Partition Rebalancing

### Rebalance Triggers

A consumer group rebalance occurs when:
1. A consumer joins the group (application startup, scale-out)
2. A consumer leaves the group (graceful shutdown, scale-in)
3. A consumer is considered dead (`session.timeout.ms` or `max.poll.interval.ms` exceeded)
4. Topic partition count changes

### Eager vs Cooperative Rebalancing

**Eager protocol** (default before Kafka 2.4):
```
Step 1: ALL consumers stop consuming ("stop-the-world")
Step 2: ALL consumers release their partition assignments
Step 3: Group Coordinator runs assignment algorithm
Step 4: ALL consumers receive new assignments and resume
Downtime: Several seconds — impacts throughput during scale events
```

**Cooperative protocol** (Kafka 2.4+, Incremental Cooperative Sticky):
```
Step 1: Only consumers that MUST change assignments are notified
Step 2: Those consumers release only their reassigned partitions
Step 3: Revoked partitions are reassigned
Step 4: Other consumers never stop consuming
Downtime: Near-zero — only affected partitions pause briefly
```

### Enabling Cooperative Rebalancing

```java
props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
    CooperativeStickyAssignor.class.getName());
```

```yaml
# application.yml
spring:
  kafka:
    consumer:
      properties:
        partition.assignment.strategy: >
          org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

> [!WARNING]
> When migrating from eager to cooperative, you must perform a rolling upgrade using the `CooperativeStickyAssignor` with the transition strategy. Direct switch from `RangeAssignor` to `CooperativeStickyAssignor` requires at least two rolling restarts.

### ConsumerRebalanceListener — Handling Partition Revocation

When using manual offset commits, commit offsets before partitions are revoked:

```java
consumer.subscribe(List.of("payment-events"), new ConsumerRebalanceListener() {

    private final Map<TopicPartition, OffsetAndMetadata> pendingOffsets =
        new ConcurrentHashMap<>();

    @Override
    public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
        log.info("Partitions being revoked: {}", partitions);

        // CRITICAL: Commit progress for revoked partitions before releasing them
        // If omitted, the new partition owner re-reads from last committed offset
        Map<TopicPartition, OffsetAndMetadata> offsetsToCommit = pendingOffsets.entrySet()
            .stream()
            .filter(e -> partitions.contains(e.getKey()))
            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));

        if (!offsetsToCommit.isEmpty()) {
            consumer.commitSync(offsetsToCommit);
        }

        // Flush any in-memory state for these partitions
        stateStore.flushAndEvict(partitions);
    }

    @Override
    public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
        log.info("Partitions assigned: {}", partitions);
        // Load any state needed for newly assigned partitions
        stateStore.initialize(partitions);
    }

    @Override
    public void onPartitionsLost(Collection<TopicPartition> partitions) {
        // Called only during eager rebalance when partitions are taken immediately
        log.warn("Partitions lost without revocation (eager rebalance): {}", partitions);
        // State may be inconsistent — invalidate and rebuild
        stateStore.invalidate(partitions);
    }
});
```

---

## 6. Consumer Lag Monitoring

Consumer lag is `Log End Offset (LEO) - consumer committed offset`. It is the primary health indicator for Kafka consumers in financial systems.

### Checking Lag with CLI

```bash
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --group payment-processor-v1 \
  --describe

# GROUP                   TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# payment-processor-v1   payment-events  0          15420           15420           0
# payment-processor-v1   payment-events  1          15380           15385           5
# payment-processor-v1   payment-events  2          15200           15400           200  <- ALERT
```

### Programmatic Lag Calculation

```java
@Service
@Slf4j
public class ConsumerLagMonitor {

    private final AdminClient adminClient;
    private final MeterRegistry meterRegistry;

    @Scheduled(fixedDelay = 30_000)
    public void reportConsumerLag() {
        calculateAndReportLag("payment-processor-v1", "payment-events");
    }

    public Map<TopicPartition, Long> calculateAndReportLag(
            String groupId, String topic) {

        Map<TopicPartition, Long> lagByPartition = new HashMap<>();

        try {
            // Get committed offsets for the consumer group
            Map<TopicPartition, OffsetAndMetadata> committedOffsets =
                adminClient.listConsumerGroupOffsets(groupId)
                    .partitionsToOffsetAndMetadata()
                    .get(30, TimeUnit.SECONDS);

            Set<TopicPartition> partitions = committedOffsets.keySet().stream()
                .filter(tp -> tp.topic().equals(topic))
                .collect(Collectors.toSet());

            // Get the end offsets for all relevant partitions
            Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> endOffsetResults =
                adminClient.listOffsets(partitions.stream()
                    .collect(Collectors.toMap(tp -> tp, tp -> OffsetSpec.latest())))
                    .all()
                    .get(30, TimeUnit.SECONDS);

            long totalLag = 0;
            for (TopicPartition tp : partitions) {
                long committed = committedOffsets.get(tp).offset();
                long endOffset = endOffsetResults.get(tp).offset();
                long lag = Math.max(0, endOffset - committed);
                lagByPartition.put(tp, lag);
                totalLag += lag;

                meterRegistry.gauge("kafka.consumer.lag",
                    Tags.of(
                        "group_id", groupId,
                        "topic", topic,
                        "partition", String.valueOf(tp.partition())
                    ),
                    lag);
            }

            meterRegistry.gauge("kafka.consumer.lag.total",
                Tags.of("group_id", groupId, "topic", topic),
                totalLag);

            if (totalLag > 10_000) {
                log.warn("High consumer lag detected for group {}: {} messages",
                    groupId, totalLag);
            }

        } catch (Exception e) {
            log.error("Failed to calculate consumer lag for group {}: {}",
                groupId, e.getMessage(), e);
        }

        return lagByPartition;
    }
}
```

---

## 7. Error Handling Patterns

### DefaultErrorHandler with Exponential Backoff

```java
@Bean
public DefaultErrorHandler defaultErrorHandler(
        KafkaTemplate<String, Object> kafkaTemplate) {

    DeadLetterPublishingRecoverer recoverer =
        new DeadLetterPublishingRecoverer(kafkaTemplate,
            (record, ex) -> {
                // Route to partition-specific DLQ
                String dlqTopic = record.topic() + ".dlq";
                log.error("Publishing to DLQ {}: {}",
                    dlqTopic, ex.getMessage());
                return new TopicPartition(dlqTopic, record.partition());
            });

    ExponentialBackOffWithMaxRetries backoff =
        new ExponentialBackOffWithMaxRetries(5);
    backoff.setInitialInterval(500L);
    backoff.setMultiplier(2.0);
    backoff.setMaxInterval(30_000L); // Max 30 seconds between retries

    DefaultErrorHandler handler = new DefaultErrorHandler(recoverer, backoff);

    // These exceptions indicate bad data — don't waste time retrying
    handler.addNotRetryableExceptions(
        IllegalArgumentException.class,
        ValidationException.class,
        JsonProcessingException.class,
        DataIntegrityViolationException.class
    );

    // Log retries for observability
    handler.setRetryListeners((record, ex, deliveryAttempt) ->
        log.warn("Retry attempt {} for record at partition {} offset {}: {}",
            deliveryAttempt, record.partition(), record.offset(),
            ex.getMessage()));

    return handler;
}
```

### Handling Deserialization Errors

```java
@Bean
public ConsumerFactory<String, PaymentEvent> consumerFactory() {
    Map<String, Object> props = new HashMap<>();
    // ... base props ...

    // Error handling deserializer wraps the actual deserializer
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
        ErrorHandlingDeserializer.class);
    props.put(ErrorHandlingDeserializer.VALUE_DESERIALIZER_CLASS,
        JsonDeserializer.class.getName());

    // Trusted packages for JSON deserialization
    props.put(JsonDeserializer.TRUSTED_PACKAGES,
        "com.bank.payments.events");

    return new DefaultKafkaConsumerFactory<>(props);
}
```

```java
// In the listener — check for deserialization errors in headers
@KafkaListener(topics = "payment-events")
public void handlePaymentEvent(
        ConsumerRecord<String, PaymentEvent> record,
        Acknowledgment ack) {

    // Check if deserialization failed
    Header deserializationException = record.headers()
        .lastHeader(ErrorHandlingDeserializer.VALUE_DESERIALIZER_EXCEPTION_HEADER);

    if (deserializationException != null) {
        // Raw bytes available — log, alert, publish raw bytes to DLQ
        log.error("Deserialization failed for record at partition {} offset {}",
            record.partition(), record.offset());
        alertingService.sendCriticalAlert("Payment event deserialization failure",
            record.partition(), record.offset());
        // Publish raw record to DLQ for manual investigation
        rawDlqPublisher.publish("payment-events.deserialization-errors",
            record.key(), record.headers());
        ack.acknowledge();
        return;
    }

    // Normal processing
    processPaymentEvent(record.value());
    ack.acknowledge();
}
```

---

## 8. Consumer Thread Safety

The Kafka consumer is **NOT thread-safe**. All operations on a `KafkaConsumer` instance must be performed by the same thread.

```java
// WRONG: Sharing a KafkaConsumer across threads
KafkaConsumer<String, PaymentEvent> consumer = new KafkaConsumer<>(props);
ExecutorService executor = Executors.newFixedThreadPool(4);
executor.submit(() -> consumer.poll(Duration.ofMillis(500))); // Thread 1
executor.submit(() -> consumer.commitAsync());               // Thread 2 — ConcurrentModificationException
```

```java
// CORRECT: Spring Kafka manages thread-per-consumer automatically
// Setting concurrency=4 creates 4 KafkaConsumer instances, one per thread
@Bean
public ConcurrentKafkaListenerContainerFactory<String, PaymentEvent> factory(
        ConsumerFactory<String, PaymentEvent> cf) {
    ConcurrentKafkaListenerContainerFactory<String, PaymentEvent> factory =
        new ConcurrentKafkaListenerContainerFactory<>();
    factory.setConsumerFactory(cf);
    factory.setConcurrency(4); // 4 threads, 4 KafkaConsumer instances
    return factory;
}
```

### Pause and Resume for Backpressure

Pause the consumer to stop fetching without triggering a rebalance:

```java
@Component
public class BackpressureAwareConsumer {

    @Autowired
    private KafkaListenerEndpointRegistry listenerRegistry;

    @KafkaListener(topics = "payment-events", id = "payment-consumer")
    public void handlePaymentEvent(PaymentEvent event, Acknowledgment ack,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition) {
        try {
            if (downstreamCircuitBreaker.isOpen()) {
                // Don't acknowledge — pause the container
                pauseConsumer();
                return;
            }
            processingService.process(event);
            ack.acknowledge();
        } catch (DownstreamUnavailableException e) {
            downstreamCircuitBreaker.recordFailure();
            pauseConsumer();
        }
    }

    private void pauseConsumer() {
        MessageListenerContainer container =
            listenerRegistry.getListenerContainer("payment-consumer");
        if (container != null && !container.isContainerPaused()) {
            container.pause();
            log.warn("Payment consumer paused — downstream unavailable");
        }
    }

    @Scheduled(fixedDelay = 10_000)
    public void checkAndResume() {
        MessageListenerContainer container =
            listenerRegistry.getListenerContainer("payment-consumer");
        if (container != null
                && container.isContainerPaused()
                && downstreamCircuitBreaker.isClosed()) {
            container.resume();
            log.info("Payment consumer resumed — downstream recovered");
        }
    }
}
```

---

## 9. Idempotent Consumer Design

Since Kafka delivers at-least-once by default, consumers must be idempotent — processing the same record twice must produce the same result as processing it once.

```java
@Service
@Transactional
public class IdempotentPaymentProcessor {

    private final PaymentRepository paymentRepository;
    private final ProcessedEventRepository processedEventRepository;

    public void process(PaymentEvent event) {
        // Check for duplicate processing using event ID
        if (processedEventRepository.existsByEventId(event.getEventId())) {
            log.info("Skipping duplicate event {}", event.getEventId());
            return; // Idempotent no-op
        }

        // Process the payment
        Payment payment = Payment.builder()
            .paymentId(event.getPaymentId())
            .accountId(event.getAccountId())
            .amount(event.getAmount())
            .status(PaymentStatus.PROCESSED)
            .processedAt(Instant.now())
            .build();

        paymentRepository.save(payment);

        // Record this event as processed within the same transaction
        processedEventRepository.save(ProcessedEvent.builder()
            .eventId(event.getEventId())
            .eventType(event.getEventType().name())
            .processedAt(Instant.now())
            .build());
    }
}
```

```sql
-- Deduplication table
CREATE TABLE processed_payment_events (
    event_id     VARCHAR(64)              PRIMARY KEY,
    event_type   VARCHAR(64)              NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Index for cleanup queries
CREATE INDEX idx_ppe_processed_at ON processed_payment_events(processed_at);

-- Keep records for at least consumer retention window (e.g., 7 days)
-- Run cleanup job daily to remove old records
DELETE FROM processed_payment_events
WHERE processed_at < NOW() - INTERVAL '7 days';
```

---

## 10. Consumer Offset Reset Strategies

The `auto.offset.reset` configuration controls what happens when a consumer group has no committed offset:

| Setting    | Behavior                                      | Use Case                            |
|------------|-----------------------------------------------|-------------------------------------|
| `earliest` | Start from the beginning of retained logs     | New consumer groups, event replay   |
| `latest`   | Start from latest (new messages only)         | Real-time-only processing           |
| `none`     | Throw exception if no committed offset exists | Strict "must have committed offset" |

```bash
# Reset consumer group to replay events (disaster recovery)
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --group payment-processor-v1 \
  --topic payment-events \
  --reset-offsets --to-earliest --execute

# Reset to a specific datetime (e.g., replay from yesterday)
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --group payment-processor-v1 \
  --topic payment-events \
  --reset-offsets --to-datetime 2026-11-07T00:00:00.000 --execute
```

---

## 11. Production Configuration Reference

```yaml
# application.yml — payment consumer production settings
spring:
  kafka:
    consumer:
      group-id: payment-processor-v1
      auto-offset-reset: earliest
      enable-auto-commit: false
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      max-poll-records: 500
      properties:
        spring.deserializer.value.delegate.class: >
          org.springframework.kafka.support.serializer.JsonDeserializer
        spring.json.trusted.packages: "com.bank.payments.events"
        max.poll.interval.ms: 300000
        session.timeout.ms: 30000
        heartbeat.interval.ms: 3000
        fetch.min.bytes: 1
        fetch.max.wait.ms: 500
        isolation.level: read_committed
        partition.assignment.strategy: >
          org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

---

## Summary

| Concern                     | Recommendation                                              |
|-----------------------------|-------------------------------------------------------------|
| Offset commit               | Manual `MANUAL_IMMEDIATE`, acknowledge after processing     |
| Auto-commit                 | Never for financial consumers                               |
| Rebalance protocol          | Cooperative sticky — eliminates stop-the-world pauses       |
| Error handling              | `DefaultErrorHandler` + exponential backoff + DLQ           |
| Deserialization errors      | `ErrorHandlingDeserializer` + raw bytes DLQ                 |
| Idempotency                 | Deduplication table inside same transaction as processing   |
| Lag monitoring              | Alert at lag > 1,000 for payment topics                     |
| `max.poll.interval.ms`      | Set to 2x your 99th-percentile processing time              |
| Thread safety               | Never share KafkaConsumer across threads                    |
| Isolation level             | `read_committed` to skip uncommitted transactional records  |

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A consumer group has enable.auto.commit=true and auto.commit.interval.ms=5000. The consumer polls records, begins processing, then crashes 3 seconds into processing before the next auto-commit fires. What happens to those records?",
      "options": [
        "They are permanently lost — the consumer already polled them",
        "They are redelivered from the last committed offset — potential duplicates must be handled by an idempotent consumer",
        "Kafka automatically rolls back the uncommitted offsets to the previous checkpoint",
        "The consumer group coordinator reassigns the partition and skips already-polled records"
      ],
      "correct": 1,
      "explanation": "Auto-commit records the offset of the last polled batch periodically, not after processing completes. If the consumer crashes before the auto-commit interval fires, the offsets are not committed. When the partition is reassigned, the new consumer starts from the last committed offset and reprocesses the same records. This is why auto-commit is dangerous for financial processing — idempotent consumers or manual commitSync after processing are required."
    },
    {
      "text": "What is the primary advantage of cooperative rebalancing (CooperativeStickyAssignor) over eager rebalancing (RangeAssignor) in a payment processing consumer group?",
      "options": [
        "Cooperative rebalancing processes more messages per second by using multiple threads",
        "Cooperative rebalancing only revokes partitions that need to move, so most consumers continue processing during the rebalance with no stop-the-world pause",
        "Cooperative rebalancing guarantees exactly-once delivery during partition reassignment",
        "Cooperative rebalancing allows a single consumer to hold all partitions, increasing throughput"
      ],
      "correct": 1,
      "explanation": "Eager rebalancing (the default) stops ALL consumers in the group and revokes ALL partitions before reassigning. This creates a stop-the-world pause that can last seconds and cause consumer lag spikes. CooperativeStickyAssignor performs incremental rebalancing: only partitions that need to move are revoked, and only the consumers involved pause. The rest continue processing normally, which is critical for low-latency payment pipelines."
    },
    {
      "text": "A consumer's processing time per batch varies from 100 ms to 45,000 ms depending on batch size. max.poll.interval.ms is set to 30,000 ms (30 s). What will happen when a large batch takes 45 seconds to process?",
      "options": [
        "Kafka will extend the poll interval automatically based on the observed processing time",
        "The consumer will be considered dead by the Group Coordinator, its partitions reassigned, triggering a rebalance — the in-progress batch may be processed twice",
        "The consumer will pause message delivery until the current batch finishes, then resume",
        "The broker will buffer messages for the slow consumer for up to 60 seconds before triggering a rebalance"
      ],
      "correct": 1,
      "explanation": "If a consumer does not call poll() within max.poll.interval.ms, the Group Coordinator assumes it has crashed and triggers a rebalance. The partitions are reassigned to another consumer, which will re-read and re-process the same records (from the last committed offset). The fix is to set max.poll.interval.ms to at least 2x the worst-case processing time and tune max.poll.records to control batch size."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Resilient Kafka Consumer with Manual Offset Management",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "Implement a @KafkaListener for a payment-events topic using MANUAL_IMMEDIATE ack mode. After successful processing, commit the specific partition offset using Acknowledgment.acknowledge(). On BusinessException, send the record to a DLQ topic and commit. On TransientException, do not commit — allow redelivery on rebalance.",
    "Configure CooperativeStickyAssignor and implement a ConsumerRebalanceListener that logs which partitions are assigned and revoked, and on revocation calls commitSync() for the current offsets of the revoked partitions to prevent reprocessing.",
    "Write a test using EmbeddedKafka that produces 20 messages, kills the consumer mid-batch (after 10 messages), starts a new consumer, and verifies that exactly the remaining 10 messages are processed — no duplicates, no gaps.",
    "Expose consumer lag as a Prometheus metric by querying the KafkaConsumer's currentLag() per partition assignment. Emit an alert annotation in the metric when lag exceeds 1000 for any partition. Write a unit test that verifies the metric is published and the alert threshold triggers correctly."
  ]
}
-->

**Next lesson**: Kafka Streams — Stateful Stream Processing
