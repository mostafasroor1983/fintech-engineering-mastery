---
id: track-06-lesson-12
title: "الإتاحة العالية في Kafka — النسخ المتماثل وقيادة الأقسام"
slug: kafka-ha
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 12
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, HA, replication-factor, ISR, leader-election]
prerequisites: [track-06-lesson-02]
---

# التوفر العالي لـ Kafka — النسخ وقيادة الأقسام

> [!NOTE]
> ضمانات الديمومة في Kafka قوية بقدر إعدادك فقط. فمنذ Kafka 3.0 صارت القيم الافتراضية *للمنتج* آمنة (`acks=all` والـ idempotence مفعّلة)، لكن القيم الافتراضية *للوسيط* (`default.replication.factor=1` و`min.insync.replicas=1`) ما زالت تعني أنك قد تفقد رسائل عند فشل وسيط واحد. وفي معالجة أحداث الدفع، فقدان حدث "PAYMENT_DEBITED" يعني أن الخصم غير مسجل ورصيد العميل خاطئ. والإعداد الصحيح للتقنية المالية — replication.factor=3 وmin.insync.replicas=2 وacks=all — يعطي ديمومة مماثلة لكتابة قاعدة بيانات منسوخة بشكل متزامن. (يُقرّ Kafka حين تكون السجلات لدى النسخ المتزامنة في الذاكرة/ذاكرة الصفحات؛ فديمومته تأتي من النسخ عبر الأجهزة، لا من fsync لكل رسالة.)

## بنية التوفر العالي لـ Kafka في التقنية المالية

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

تُوزع الأقسام عبر وسطاء في مناطق توفر مختلفة. وعندما يفشل وسيط، ينتخب Kafka قائدًا جديدًا من مجموعة النسخ المتزامنة (ISR) لكل قسم متأثر.

## 1. إعداد المواضيع للتقنية المالية

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

### معاملات الإعداد الحرجة

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

## 2. إعداد المنتج للديمومة

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

### منتج أحداث الدفع

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

## 3. إعداد المستهلك للموثوقية

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

### مستهلك أحداث الدفع

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

## 4. نمط KRaft (دون ZooKeeper)

قدّم Kafka 3.x نمط KRaft، فألغى الاعتماد على ZooKeeper. وKRaft جاهز للإنتاج منذ Kafka 3.3، وأزال Kafka 4.0 ‏(2025) دعم ZooKeeper كليًا — فكل مجموعة حالية تعمل بـ KRaft. والعقدة المدمجة (وسيط+متحكم) أدناه مناسبة للمجموعات الصغيرة والاختبارات؛ أما المجموعات الإنتاجية الأكبر فتشغّل عادة عقد متحكم مخصصة.

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

## 5. الوعي بالرفوف لتوزيع المناطق

تضمن ميزة الوعي بالرفوف (rack-awareness) في Kafka وضع النسخ على رفوف مختلفة (مناطق توفر). ودونها قد تنتهي النسخ الثلاث كلها على وسطاء في منطقة التوفر نفسها — ففشل منطقة توفر واحدة يُسقط كل النسخ.

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

## 6. مراقبة انكماش ISR

عندما تتأخر نسخة وتُزال من ISR، تنخفض الديمومة الفعلية للالتزامات. وإذا انخفضت ISR تحت min.insync.replicas، تُحجب المنتجات ذات acks=all.

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

## 7. أثر فشل الوسيط والتعافي

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

## 8. ضمانات ديمومة أحداث الدفع

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

## 9. مقاييس لوحة المراقبة

| المقياس | العتبة | الإجراء |
|---|---|---|
| `kafka.isr.size` < عامل النسخ | تحذير | تحقق من الوسيط المتأخر |
| `kafka.isr.size` == 1 | حرج | تحقيق فوري؛ قد يُحجب المنتج |
| `kafka.consumer.lag` > 10,000 | تحذير | مشكلة أداء في المستهلك |
| `kafka.consumer.lag` > 100,000 | حرج | المستهلك لا يواكب؛ خطر ضغط عكسي |
| `kafka.producer.record.error.rate` > 0 | تحذير | المنتج لا يصل إلى ISR؛ فشل تسليم |
| استخدام قرص الوسيط > 70% | تحذير | زد الاحتفاظ أو أضف وسيطًا |
| بايتات شبكة الوسيط > 80% من السعة | تحذير | وسّع الوسطاء |

## 10. الخلاصة

يتطلب التوفر العالي لـ Kafka في التقنية المالية ثلاث طبقات إعداد: إعداد المواضيع (RF=3، وmin.insync.replicas=2، وتعطيل انتخاب القائد غير النظيف)، وإعداد المنتج (acks=all، وidempotent)، وإعداد المستهلك (التزام إزاحة يدوي، ومهل جلسات مناسبة). ويزيل نمط KRaft نظام ZooKeeper كنظام منفصل يجب تشغيله وتأمينه. ويضمن الوعي بالرفوف امتداد النسخ عبر مناطق التوفر. ومراقبة ISR هي المقياس التشغيلي الحرج — فعندما تنخفض ISR تحت min.insync.replicas، سيُحجب خط معالجة الدفع حتى تلحق نسخة. وهذا مقصود: الديمومة قبل التوفر للرسائل المالية.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ماذا يحدث لمنتج Kafka بـ acks=all وmin.insync.replicas=2 عندما تكون نسخة واحدة فقط في ISR؟",
      "options": ["يتحول المنتج إلى acks=1 تلقائيًا", "ينشر المنتج بنجاح إلى النسخة الوحيدة المتبقية", "يُحجب المنتج (يرمي NotEnoughReplicasException) حتى تعود نسخة ثانية إلى ISR", "يُسقط المنتج الرسالة بصمت"],
      "correct": 2,
      "explanation": "مع acks=all وmin.insync.replicas=2، يتطلب المنتج إقرار نسختين متزامنتين على الأقل للكتابة. فإذا كانت نسخة واحدة فقط في ISR، يعيد الوسيط NotEnoughReplicasException ويُحجب المنتج/يعيد المحاولة. وهذا مقصود — فهو يمنع فقدان البيانات برفض إقرار كتابات لا تستوفي متطلب الديمومة."
    },
    {
      "text": "لماذا يجب ضبط unclean.leader.election.enable=false لمواضيع Kafka المتعلقة بالدفع؟",
      "options": ["يحسّن إنتاجية المنتج", "يمنع نسخة غير متزامنة من أن تصبح قائدًا وتسبب فقدان الرسائل", "يقلل زمن انتخاب القائد", "يفعّل دلالات المرة الواحدة بالضبط"],
      "correct": 1,
      "explanation": "إذا فُعّل انتخاب القائد غير النظيف، فقد تُنتخب نسخة متأخرة عن ISR قائدًا أثناء الفشل. وهذه النسخة تنقصها رسائل التُزم بها على القائد السابق — فتضيع تلك الرسائل إلى الأبد. ولأحداث الدفع، فقدان حدث PAYMENT_DEBITED يعني أن الخصم غير مسجل، فينشأ خطأ مالي."
    },
    {
      "text": "لماذا يجب أن يستخدم مستهلكو Kafka التزام الإزاحة اليدوي (ENABLE_AUTO_COMMIT=false) لمعالجة أحداث الدفع؟",
      "options": ["الالتزام التلقائي غير مدعوم في Kafka", "قد يلتزم الالتزام التلقائي بالإزاحات قبل اكتمال المعالجة، فتُفوَّت أحداث عند إعادة تشغيل المستهلك", "الالتزام اليدوي أسرع من التلقائي", "الالتزام التلقائي يسبب مشكلات إعادة التوازن"],
      "correct": 1,
      "explanation": "يلتزم الالتزام التلقائي دوريًا بأحدث إزاحة بغض النظر عن حالة المعالجة. فإذا تعطل المستهلك بعد الالتزام لكن قبل معالجة حدث دفع بنجاح، فلن يُعالج ذلك الحدث أبدًا. أما الالتزام اليدوي فلا يقدّم الإزاحة إلا بعد معالجة ناجحة مؤكدة، فيضمن التسليم مرة واحدة على الأقل."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "خط أحداث دفع متين في Kafka بإعداد توفر عالٍ",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "أنشئ تعريفات مواضيع Kafka لـ payment-events ‏(12 قسمًا، RF=3، min.insync.replicas=2، unclean.leader.election=false، احتفاظ 7 أيام) وfraud-alerts ‏(6 أقسام، إعدادات الديمومة نفسها، احتفاظ 30 يومًا) باستخدام TopicBuilder في Spring Kafka."},
    {"id": "2", "description": "اضبط منتجًا idempotent ‏(enable.idempotence=true، وacks=all، وretries=MAX_VALUE، وdelivery.timeout=120s) ونفّذ PaymentEventProducer ينشر بمعرّف الدفعة كمفتاح، ويضيف ترويستي correlation-id وevent-type، ويوصل إخفاقات الإرسال إلى المستدعي (بإعادة مستقبل الإرسال، بالإضافة إلى publishOrFail() ينتظر بمهلة محدودة ويرمي PaymentEventPublishException) — شارحًا لماذا لا يعمل الرمي داخل whenComplete()."},
    {"id": "3", "description": "ابنِ ISRShrinkageMonitor بـ @Scheduled(fixedRate=30000) يستعلم AdminClient عن كل أقسام مواضيع الدفع، ويتتبع حجم ISR لكل قسم كمقياس gauge في Prometheus، ويرسل تحذيرًا عندما تكون ISR أقل من عامل النسخ، وتنبيهًا حرجًا عندما تكون ISR == 1."},
    {"id": "4", "description": "نفّذ خدمة أحداث دفع معاملاتية باستخدام @Transactional(kafkaTransactionManager) تنشر ذريًا إلى payment-events وfraud-scoring-requests وaudit-events في معاملة Kafka واحدة. واكتب اختبار تكامل بمستهلك read_committed يتحقق من أن المواضيع الثلاثة كلها تتلقى الحدث أو لا يتلقاه أي منها عند حدوث استثناء في منتصف النشر."}
  ]
}
-->
