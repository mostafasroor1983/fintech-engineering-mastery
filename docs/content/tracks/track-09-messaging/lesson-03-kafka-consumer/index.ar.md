---
id: track-09-lesson-03
title: "مستهلك Kafka — إدارة الإزاحات وإعادة التوازن"
slug: kafka-consumer
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 3
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, consumer, offset, rebalance, commit-strategy]
prerequisites: [track-09-lesson-02]
---

# مستهلك Kafka — إدارة الإزاحات وإعادة التوازن

> [!NOTE]
> إدارة الإزاحات هي منبع معظم أخطاء مستهلكي Kafka في الأنظمة المالية الإنتاجية. والفرق بين المعالجة مرة واحدة على الأكثر، ومرة واحدة على الأقل، ومرة واحدة بالضبط يتحدد بالكامل بموعد التزامك بالإزاحات نسبة إلى موعد معالجة الرسائل. فإن أخطأت فيه إما أن تضيّع أحداث الدفع أو تعيد معالجتها عند كل إعادة تشغيل.

## نظرة عامة

يقرأ مستهلك Kafka السجلات من الأقسام، ويتتبع موضعه (الإزاحة) داخل كل قسم، ويلتزم بتلك الإزاحات في Kafka كي يستأنف من المكان الصحيح بعد إعادة التشغيل أو الأعطال. وتبدو الآليات بسيطة، لكن الحالات الحدية هي حيث تفشل الأنظمة المالية.

يغطي هذا الدرس آليات مجموعات المستهلكين، وكل استراتيجيات الالتزام بالإزاحات مع مفاضلاتها، وإعادة توازن الأقسام وأثرها على استمرارية المعالجة، والتكامل مع Spring Kafka، وأنماط معالجة الأخطاء في الإنتاج.

## 1. آليات مجموعات المستهلكين

### ما مجموعة المستهلكين؟

مجموعة المستهلكين مجموعة من المستهلكين يستهلكون موضوعًا بالتعاون. وتضمن Kafka أن كل قسم معيّن لمستهلك واحد بالضبط داخل المجموعة في أي لحظة.

```
Topic: payment-events (12 partitions)
Consumer Group: payment-processor

Consumer-1: partitions [0, 1, 2, 3]
Consumer-2: partitions [4, 5, 6, 7]
Consumer-3: partitions [8, 9, 10, 11]
```

يوفر هذا قابلية توسع أفقي: فإضافة مستهلكين للمجموعة توسّع إنتاجية الاستهلاك حتى عدد الأقسام. وبعده، يبقى المستهلكون الإضافيون خاملين.

### منسّق المجموعة

لكل مجموعة مستهلكين **منسّق مجموعة (Group Coordinator)** — وسيط مكلّف بإدارة عضوية المجموعة وتعيينات الأقسام. ويرسل المستهلكون نبضات دورية للمنسّق؛ فإذا فاتت نبضة خلال `session.timeout.ms`، يُعتبر المستهلك ميتًا وتنطلق إعادة توازن.

### تدفق تسجيل المستهلك

```
Consumer starts       → Sends JoinGroup request to Group Coordinator
Group Coordinator     → Selects one consumer as Group Leader
Group Leader          → Runs partition assignment algorithm
Group Leader          → Sends SyncGroup with assignments to Coordinator
Group Coordinator     → Distributes assignments to all consumers
All consumers         → Begin fetching from assigned partitions
```

## 2. تعمق في إعداد المستهلك

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

### علاقات التوقيت الحرجة

```
session.timeout.ms    = 30000  (broker considers consumer dead after this)
heartbeat.interval.ms = 3000   (send heartbeat every 3s, must be < session/3)
max.poll.interval.ms  = 300000 (time your ACTUAL processing must stay within)
```

(مع بروتوكول مجموعات المستهلكين الجديد في Kafka 4.0 — `group.protocol=consumer`، ‏KIP-848 — تُضبط مهلة الجلسة وفترة النبض على جانب الوسيط ويحسب الوسيط التعيين؛ وما زال `max.poll.interval.ms` ينطبق.)

إذا استغرقت معالجة الدفع أطول من `max.poll.interval.ms`، يُزال المستهلك قسرًا من المجموعة وتحدث إعادة توازن — حتى لو كان خيط النبض ما زال يعمل. وهذا السبب الأول لإعادة التوازن غير المتوقعة في الأنظمة التي تنفذ كتابات قاعدة بيانات أو استدعاءات API خارجية لكل رسالة.

## 3. استراتيجيات الالتزام بالإزاحات

### الاستراتيجية 1: الالتزام التلقائي (الافتراضي — خطر على البيانات المالية)

```java
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, true);
props.put(ConsumerConfig.AUTO_COMMIT_INTERVAL_MS_CONFIG, 5000);
```

يلتزم الالتزام التلقائي، أثناء `poll()` ‏(وعند `close()`)، بإزاحات السجلات التي أعادها الـ poll السابق. فإذا أنهيت معالجة كل دفعة قبل استدعاء `poll()` مجددًا، يبقى ذلك "مرة واحدة على الأقل". لكن ما إن تكون المعالجة **غير** منتهية عند الـ `poll()` التالي — سجلات سُلّمت لمجمع خيوط عاملة، أو كتابات مخزنة مؤقتًا — يصبح **مرة واحدة على الأكثر**:

```
poll() → returns records 0-99 → handed to a worker thread pool
poll() again → auto-commit commits offset 100 (workers still busy)
worker is at record 50 → process crashes
restart → consumer starts at 100
records 51-99 are LOST FOREVER
```

**لا تستخدم الالتزام التلقائي لمعالجة المدفوعات** — يجب أن تكون نقطة الالتزام صريحة. والاستخدام المقبول الوحيد للتحليلات حيث يُحتمل فقد بضعة سجلات.

### الاستراتيجية 2: ‏commitSync() اليدوي

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

يوفر `commitSync()` دلالات **مرة واحدة على الأقل**:

```
Scenario A — Normal:
poll() → records 0-99 → process all → commitSync() → offset 100 committed
consumer crashes → restart → starts at 100 (correct)

Scenario B — Crash before commit:
poll() → records 0-99 → process record 50 → consumer crashes
no commit happened → restart → starts at 0
reprocesses 0-49, then processes 50-99 (duplicates for 0-49)
```

العيب هو الأداء: يحجب `commitSync()` حلقة المستهلك حتى يؤكد الوسيط الالتزام — عادة 10–50ms من الزمن الإضافي لكل دفعة.

### الاستراتيجية 3: ‏commitAsync() اليدوي

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

‏`commitAsync()` غير حاجب وأسرع لكنه لا يعيد المحاولة عند الفشل. فإذا فشل الالتزام (مشكلة شبكة)، قد يعيد المستهلك معالجة تلك السجلات عند إعادة التشغيل التالية.

**نمط الإنتاج**: استخدم `commitAsync()` لمعظم الالتزامات، و`commitSync()` عند الإيقاف:

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

### الاستراتيجية 4: الالتزام لكل قسم (تحكم دقيق)

للتوازي داخل المستهلك، التزم بالإزاحات لكل قسم مع اكتمال العمل:

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

يجب أن تكون الإزاحة الملتزمة `record.offset() + 1` — إذ تفسرها Kafka بأنها "السجل التالي الذي يُجلب".

## 4. ‏@KafkaListener في Spring Kafka

### مستمع أساسي بتأكيد يدوي

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
            // Rethrow: the container's DefaultErrorHandler seeks back to this
            // record and redelivers it with back-off (merely not acknowledging
            // would NOT cause redelivery -- the next ack would commit past it)
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

### مصنع حاوية المستمع

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
        // Same partition number in the DLQ: the .dlq topic needs at least
        // as many partitions as the source topic
        DeadLetterPublishingRecoverer recoverer =
            new DeadLetterPublishingRecoverer(kafkaTemplate,
                (record, exception) -> new TopicPartition(
                    record.topic() + ".dlq",
                    record.partition()
                ));

        ExponentialBackOffWithMaxRetries backOff = new ExponentialBackOffWithMaxRetries(3);
        backOff.setInitialInterval(1_000L);
        backOff.setMultiplier(2.0);
        backOff.setMaxInterval(10_000L);

        DefaultErrorHandler errorHandler = new DefaultErrorHandler(recoverer, backOff);

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

### مستمع الدفعات

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

    // LinkedHashMap keeps the original (offset) order -- a plain toMap()
    // returns a HashMap and would scramble per-account ordering
    Map<String, PaymentEvent> eventMap = records.stream()
        .collect(Collectors.toMap(
            r -> r.value().getEventId(),
            ConsumerRecord::value,
            (a, b) -> b, // duplicates within the same batch: keep one
            LinkedHashMap::new
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

## 5. إعادة توازن الأقسام

### محفزات إعادة التوازن

تحدث إعادة توازن مجموعة المستهلكين حين:
1. ينضم مستهلك للمجموعة (بدء التطبيق، التوسع)
2. يغادر مستهلك المجموعة (إيقاف منظم، التقليص)
3. يُعتبر مستهلك ميتًا (تجاوز `session.timeout.ms` أو `max.poll.interval.ms`)
4. يتغير عدد أقسام الموضوع

### إعادة التوازن المتلهفة مقابل التعاونية

**البروتوكول المتلهف (eager)** (ما يفعله `RangeAssignor` الافتراضي؛ وما زال الافتراضي في البروتوكول الكلاسيكي اليوم ما لم تغيّر المُعيِّن):

```
Step 1: ALL consumers stop consuming ("stop-the-world")
Step 2: ALL consumers release their partition assignments
Step 3: Group Coordinator runs assignment algorithm
Step 4: ALL consumers receive new assignments and resume
Downtime: Several seconds — impacts throughput during scale events
```

**البروتوكول التعاوني (cooperative)** (Kafka 2.4+، Incremental Cooperative Sticky):

```
Step 1: Only consumers that MUST change assignments are notified
Step 2: Those consumers release only their reassigned partitions
Step 3: Revoked partitions are reassigned
Step 4: Other consumers never stop consuming
Downtime: Near-zero — only affected partitions pause briefly
```

### تفعيل إعادة التوازن التعاونية

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
> يتطلب ترحيل مجموعة عاملة من المتلهف إلى التعاوني **إعادتي تشغيل متدحرجتين**: أولًا انشر مع إدراج المُعيِّنين كليهما (`CooperativeStickyAssignor,RangeAssignor`)، ثم انشر مجددًا مع `CooperativeStickyAssignor` فقط. والتبديل المباشر لكل المثيلات في خطوة واحدة قد يكسر المجموعة بينما يختلف الأعضاء القدامى والجدد على البروتوكول. (بروتوكول المستهلك الجديد في Kafka 4.0، ‏`group.protocol=consumer`، يجعل كل إعادات التوازن تدريجية ويقودها الوسيط.)

### ‏ConsumerRebalanceListener — معالجة سحب الأقسام

عند استخدام الالتزامات اليدوية بالإزاحات، التزم بالإزاحات قبل سحب الأقسام:

```java
consumer.subscribe(List.of("payment-events"), new ConsumerRebalanceListener() {

    // Filled by the poll loop: last processed offset + 1 per partition
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
        // Called when partitions were taken away WITHOUT an orderly
        // revocation (e.g. this consumer missed its session timeout or was
        // fenced). Another member may already own them: do NOT commit.
        log.warn("Partitions lost: {}", partitions);
        // State may be inconsistent — invalidate and rebuild
        stateStore.invalidate(partitions);
    }
});
```

## 6. مراقبة تأخر المستهلك

تأخر المستهلك هو `Log End Offset (LEO) - consumer committed offset` (ولمستهلكي `read_committed`، تكون آخر إزاحة مستقرة النهاية الأدق). وهو مؤشر الصحة الأساسي لمستهلكي Kafka في الأنظمة المالية.

### فحص التأخر بسطر الأوامر

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

### حساب التأخر برمجيًا

```java
@Service
@Slf4j
public class ConsumerLagMonitor {

    private final AdminClient adminClient;
    private final MeterRegistry meterRegistry;
    // One holder per (group, topic, partition): each gauge is registered once
    private final Map<String, AtomicLong> lagHolders = new ConcurrentHashMap<>();

    private AtomicLong holder(String name, Tags tags) {
        return lagHolders.computeIfAbsent(name + tags, k -> {
            AtomicLong h = new AtomicLong();
            Gauge.builder(name, h, AtomicLong::get).tags(tags).register(meterRegistry);
            return h;
        });
    }

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

            Set<TopicPartition> partitions = committedOffsets.entrySet().stream()
                .filter(e -> e.getKey().topic().equals(topic) && e.getValue() != null)
                .map(Map.Entry::getKey)
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

                holder("kafka.consumer.lag", Tags.of(
                        "group_id", groupId,
                        "topic", topic,
                        "partition", String.valueOf(tp.partition())))
                    .set(lag);
            }

            holder("kafka.consumer.lag.total",
                    Tags.of("group_id", groupId, "topic", topic))
                .set(totalLag);

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

## 7. أنماط معالجة الأخطاء

### ‏DefaultErrorHandler مع تراجع أسي

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

### معالجة أخطاء فك التسلسل

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
// The listener needs no special code: when ErrorHandlingDeserializer
// fails, the container does not call the listener with garbage -- it
// passes a DeserializationException to the DefaultErrorHandler. That
// exception is not retryable by default, so the DeadLetterPublishingRecoverer
// immediately publishes the ORIGINAL raw bytes (plus exception headers) to
// the dead-letter topic and the consumer moves on.
@KafkaListener(topics = "payment-events")
public void handlePaymentEvent(PaymentEvent event, Acknowledgment ack) {
    processPaymentEvent(event);
    ack.acknowledge();
}

// Alert on it: count records arriving in the dead-letter topic, or add a
// retry listener / recoverer wrapper that raises a critical alert.
```

## 8. سلامة خيوط المستهلك

مستهلك Kafka **غير آمن للخيوط**. ويجب تنفيذ كل العمليات على مثيل `KafkaConsumer` من الخيط نفسه.

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

### الإيقاف المؤقت والاستئناف للضغط العكسي

أوقف المستهلك مؤقتًا لوقف الجلب دون إطلاق إعادة توازن:

```java
@Component
public class BackpressureAwareConsumer {

    @Autowired
    private KafkaListenerEndpointRegistry listenerRegistry;

    @KafkaListener(topics = "payment-events", id = "payment-consumer")
    public void handlePaymentEvent(PaymentEvent event, Acknowledgment ack) {
        if (downstreamCircuitBreaker.isOpen()) {
            pauseConsumer();
            // THROW, don't just return: the error handler seeks back to this
            // record, so it is delivered again after resume(). Returning
            // without an ack would let the following records be processed
            // and acknowledged -- committing past this one and losing it.
            throw new DownstreamUnavailableException("circuit open");
        }
        try {
            processingService.process(event);
            ack.acknowledge();
        } catch (DownstreamUnavailableException e) {
            downstreamCircuitBreaker.recordFailure();
            pauseConsumer();
            throw e;   // same reason: re-seek this record
        }
    }

    private void pauseConsumer() {
        // pause() stops fetching but keeps the consumer in the group
        // (it keeps polling internally, so no rebalance is triggered)
        MessageListenerContainer container =
            listenerRegistry.getListenerContainer("payment-consumer");
        if (container != null && !container.isPauseRequested()) {
            container.pause();
            log.warn("Payment consumer paused — downstream unavailable");
        }
    }

    @Scheduled(fixedDelay = 10_000)
    public void checkAndResume() {
        MessageListenerContainer container =
            listenerRegistry.getListenerContainer("payment-consumer");
        if (container != null
                && container.isPauseRequested()
                && downstreamCircuitBreaker.isClosed()) {
            container.resume();
            log.info("Payment consumer resumed — downstream recovered");
        }
    }
}
```

## 9. تصميم المستهلك idempotent

لأن Kafka تسلّم مرة واحدة على الأقل افتراضيًا، يجب أن يكون المستهلكون idempotent — معالجة السجل نفسه مرتين يجب أن تنتج النتيجة نفسها لمعالجته مرة.

```java
@Service
public class IdempotentPaymentProcessor {

    private final PaymentRepository paymentRepository;
    private final JdbcTemplate jdbcTemplate;

    @Transactional
    public void process(PaymentEvent event) {
        // Claim the event FIRST, relying on the primary key. A separate
        // "exists?" check followed by an insert is a race: two consumers
        // (e.g. old and new owner around a rebalance) can both see "no".
        int claimed = jdbcTemplate.update("""
            INSERT INTO processed_payment_events (event_id, event_type, processed_at)
            VALUES (?, ?, now())
            ON CONFLICT (event_id) DO NOTHING
            """, event.getEventId(), event.getEventType().name());

        if (claimed == 0) {
            log.info("Skipping duplicate event {}", event.getEventId());
            return; // Idempotent no-op
        }

        // Process the payment -- in the SAME transaction as the claim, so a
        // failure rolls back both and the redelivery can try again
        Payment payment = Payment.builder()
            .paymentId(event.getPaymentId())
            .accountId(event.getAccountId())
            .amount(event.getAmount())
            .status(PaymentStatus.PROCESSED)
            .processedAt(Instant.now())
            .build();

        paymentRepository.save(payment);
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

-- Keep records at least as long as an event could be redelivered: the
-- topic retention plus any planned replay window (e.g., 7 days)
-- Run cleanup job daily to remove old records
DELETE FROM processed_payment_events
WHERE processed_at < NOW() - INTERVAL '7 days';
```

## 10. استراتيجيات إعادة ضبط إزاحة المستهلك

يتحكم إعداد `auto.offset.reset` فيما يحدث حين لا تملك مجموعة مستهلكين إزاحة ملتزمة:

| الإعداد    | السلوك                                      | حالة الاستخدام                            |
|------------|-----------------------------------------------|-------------------------------------|
| ‏`earliest` | ابدأ من بداية السجلات المحفوظة     | مجموعات المستهلكين الجديدة، إعادة تشغيل الأحداث   |
| ‏`latest`   | ابدأ من الأحدث (الرسائل الجديدة فقط)         | المعالجة الفورية فقط           |
| ‏`none`     | ارمِ استثناء إن لم توجد إزاحة ملتزمة | "يجب وجود إزاحة ملتزمة" بصرامة |

```bash
# Reset consumer group to replay events (disaster recovery).
# The group must have NO active members (stop the consumers first);
# run without --execute (or with --dry-run) to preview the new offsets.
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

## 11. مرجع إعداد الإنتاج

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

## الخلاصة

| الاهتمام                     | التوصية                                              |
|-----------------------------|-------------------------------------------------------------|
| الالتزام بالإزاحات               | يدوي `MANUAL_IMMEDIATE`، والتأكيد بعد المعالجة     |
| الالتزام التلقائي                 | أبدًا للمستهلكين الماليين                               |
| بروتوكول إعادة التوازن          | التعاوني اللاصق — يزيل توقفات "إيقاف العالم"       |
| معالجة الأخطاء              | ‏`DefaultErrorHandler` + تراجع أسي + DLQ           |
| أخطاء فك التسلسل      | ‏`ErrorHandlingDeserializer` + DLQ للبايتات الخام                 |
| Idempotency                 | جدول إزالة تكرار داخل معاملة المعالجة نفسها   |
| مراقبة التأخر              | نبّه عند تأخر > 1,000 لمواضيع الدفع                     |
| ‏`max.poll.interval.ms`      | اضبطه على ضعف زمن المعالجة عند المئين 99              |
| سلامة الخيوط               | لا تشارك أبدًا KafkaConsumer عبر الخيوط                    |
| مستوى العزل             | ‏`read_committed` لتخطي السجلات المعاملاتية غير الملتزمة  |

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لمجموعة مستهلكين enable.auto.commit=true وauto.commit.interval.ms=5000. يستطلع المستهلك السجلات، ويبدأ المعالجة، ثم يتعطل بعد 3 ثوانٍ من المعالجة قبل أن ينطلق الالتزام التلقائي التالي. ماذا يحدث لتلك السجلات؟",
      "options": [
        "تضيع نهائيًا — فقد استطلعها المستهلك أصلًا",
        "تُعاد من آخر إزاحة ملتزمة — والتكرارات المحتملة يجب أن يعالجها مستهلك idempotent",
        "تعيد Kafka تلقائيًا الإزاحات غير الملتزمة إلى نقطة التفتيش السابقة",
        "يعيد منسّق المجموعة تعيين القسم ويتخطى السجلات المستطلعة أصلًا"
      ],
      "correct": 1,
      "explanation": "يسجل الالتزام التلقائي إزاحة آخر دفعة مستطلعة دوريًا، لا بعد اكتمال المعالجة. فإذا تعطل المستهلك قبل انطلاق فترة الالتزام التلقائي، لا تُلتزم الإزاحات. وحين يُعاد تعيين القسم، يبدأ المستهلك الجديد من آخر إزاحة ملتزمة ويعيد معالجة السجلات نفسها. ولهذا الالتزام التلقائي خطر على المعالجة المالية — فالمستهلكون idempotent أو commitSync اليدوي بعد المعالجة مطلوبان."
    },
    {
      "text": "ما الميزة الأساسية لإعادة التوازن التعاونية (CooperativeStickyAssignor) على إعادة التوازن المتلهفة (RangeAssignor) في مجموعة مستهلكين لمعالجة المدفوعات؟",
      "options": [
        "تعالج إعادة التوازن التعاونية رسائل أكثر في الثانية باستخدام خيوط متعددة",
        "تسحب إعادة التوازن التعاونية فقط الأقسام التي يجب نقلها، فيستمر معظم المستهلكين في المعالجة أثناء إعادة التوازن دون توقف شامل",
        "تضمن إعادة التوازن التعاونية التسليم مرة واحدة بالضبط أثناء إعادة تعيين الأقسام",
        "تتيح إعادة التوازن التعاونية لمستهلك واحد امتلاك كل الأقسام، فتزيد الإنتاجية"
      ],
      "correct": 1,
      "explanation": "توقف إعادة التوازن المتلهفة (الافتراضية) كل المستهلكين في المجموعة وتسحب كل الأقسام قبل إعادة التعيين. وهذا يخلق توقفًا شاملًا قد يدوم ثوانٍ ويسبب قفزات في تأخر المستهلكين. أما CooperativeStickyAssignor فينفذ إعادة توازن تدريجية: تُسحب فقط الأقسام التي يجب نقلها، ويتوقف فقط المستهلكون المعنيون. ويواصل الباقون المعالجة طبيعيًا، وهذا حاسم لخطوط الدفع منخفضة الزمن."
    },
    {
      "text": "يتراوح زمن معالجة المستهلك لكل دفعة بين 100 ms و45,000 ms بحسب حجم الدفعة. وmax.poll.interval.ms مضبوط على 30,000 ms ‏(30 ثانية). ماذا سيحدث حين تستغرق دفعة كبيرة 45 ثانية؟",
      "options": [
        "ستمدد Kafka فترة الاستطلاع تلقائيًا بناءً على زمن المعالجة الملحوظ",
        "سيعتبر منسّق المجموعة المستهلك ميتًا، وتُعاد تعيين أقسامه، فتنطلق إعادة توازن — وقد تُعالج الدفعة الجارية مرتين",
        "سيوقف المستهلك تسليم الرسائل مؤقتًا حتى تنتهي الدفعة الحالية، ثم يستأنف",
        "سيخزن الوسيط الرسائل للمستهلك البطيء حتى 60 ثانية قبل إطلاق إعادة توازن"
      ],
      "correct": 1,
      "explanation": "إذا لم يستدعِ المستهلك poll() خلال max.poll.interval.ms، يفترض منسّق المجموعة أنه تعطل ويطلق إعادة توازن. فتُعاد تعيين الأقسام لمستهلك آخر، سيعيد قراءة السجلات نفسها ومعالجتها (من آخر إزاحة ملتزمة). والإصلاح ضبط max.poll.interval.ms على ضعف أسوأ زمن معالجة على الأقل وضبط max.poll.records للتحكم في حجم الدفعة."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "مستهلك Kafka مرن مع إدارة يدوية للإزاحات",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "نفّذ @KafkaListener لموضوع payment-events باستخدام وضع التأكيد MANUAL_IMMEDIATE. وبعد المعالجة الناجحة، التزم بالإزاحة عبر Acknowledgment.acknowledge(). واضبط DefaultErrorHandler: ‏BusinessException غير قابل لإعادة المحاولة ويذهب إلى موضوع DLQ فورًا؛ وTransientException يُعاد رميه ويُعاد محاولته بتراجع أسي قبل أن يذهب إلى DLQ.",
    "اضبط CooperativeStickyAssignor ونفّذ ConsumerRebalanceListener يسجل الأقسام المعيّنة والمسحوبة، ويستدعي عند السحب commitSync() للإزاحات الحالية للأقسام المسحوبة لمنع إعادة المعالجة.",
    "اكتب اختبارًا باستخدام EmbeddedKafka ينتج 20 رسالة، ويوقف المستهلك في منتصف دفعة (بعد 10 رسائل مؤكدة)، ويبدأ مستهلكًا جديدًا، ويتحقق من معالجة كل رسالة (لا فجوات) ومن أن أي رسالة سُلّمت مرتين ليس لها أثر إضافي بفضل المعالج idempotent.",
    "اكشف تأخر المستهلك كمقياس Prometheus باستعلام currentLag() في KafkaConsumer لكل تعيين قسم. وأطلق تعليق تنبيه في المقياس حين يتجاوز التأخر 1000 لأي قسم. واكتب اختبار وحدة يتحقق من نشر المقياس وصحة إطلاق عتبة التنبيه."
  ]
}
-->

**الدرس التالي**: ‏Kafka Streams — معالجة التدفقات ذات الحالة
