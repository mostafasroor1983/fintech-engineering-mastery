---
id: track-09-lesson-04
title: "Kafka Streams — معالجة التدفقات ذات الحالة"
slug: kafka-streams
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 4
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [Kafka-Streams, KStream, KTable, state-store, windowing]
prerequisites: [track-09-lesson-03]
---

# ‏Kafka Streams — معالجة التدفقات ذات الحالة

> [!NOTE]
> ليست Kafka Streams مجرد مكتبة تدفق — بل محرك حوسبة ذو حالة، موزع ومتحمل للأعطال، يعمل داخل تطبيق Java الخاص بك. وللأنظمة المالية، يعني هذا أنك تستطيع حساب الأرصدة الجارية، وكشف أنماط الاحتيال، وتجميع أحجام المدفوعات فوريًا دون عنقود منفصل مثل Flink أو Spark.

## نظرة عامة

تحوّل Kafka Streams مواضيع Kafka إلى رسم حوسبة قابل للبرمجة. وعلى خلاف أنماط المستهلك فقط، تدير Kafka Streams الحالة، وتتعامل مع التعافي من الأعطال، وتوفر دلالات مرة واحدة بالضبط — كلها مضمنة في ملف JAR الخاص بتطبيقك.

يغطي هذا الدرس طوبولوجيا Streams الكاملة: ‏KStream لتدفقات الأحداث، وKTable لجداول سجل التغييرات، وGlobalKTable لعمليات البحث المنسوخة لكل مثيل، ومخازن الحالة المدعومة بـ RocksDB، والنوافذ الزمنية للتجميعات المحدودة زمنيًا، وحالات استخدام مالية عملية تشمل التجميع الفوري للمدفوعات وكشف الاحتيال.

## 1. بنية Kafka Streams

### مفاهيم الطوبولوجيا

يعرّف تطبيق Kafka Streams **طوبولوجيا** — رسمًا موجهًا غير دوري لعمليات معالجة التدفق:

```
Source Processor (Kafka Topic)
    ↓
Filter Processor (remove invalid events)
    ↓
Map Processor (transform/enrich)
    ↓
Aggregate Processor (sum amounts per account)
    ↓
Sink Processor (write to output Kafka topic)
         ↑
    State Store (RocksDB for aggregation state)
```

### ‏Streams مقابل المستهلك

| الجانب              | مستهلك Kafka          | Kafka Streams                        |
|---------------------|-------------------------|--------------------------------------|
| إدارة الحالة    | شيفرتك               | مدمجة (RocksDB، في الذاكرة)        |
| تحمل الأعطال     | شيفرتك               | استعادة تلقائية للحالة من سجل التغييرات |
| مرة واحدة بالضبط        | تنفيذ يدوي   | مدمجة (`processing.guarantee=exactly_once_v2`) |
| التوازي         | تعيين الأقسام    | مهام التدفق (واحدة لكل قسم)     |
| النشر          | تطبيق مستقل          | مضمنة في تطبيق Spring Boot الخاص بك     |

## 2. إعداد Kafka Streams مع Spring Boot

### الاعتماديات

```xml
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>
<dependency>
    <groupId>org.apache.kafka</groupId>
    <artifactId>kafka-streams</artifactId>
</dependency>
```

### الإعداد الأساسي

```java
@Configuration
@EnableKafkaStreams
public class KafkaStreamsConfig {

    @Bean(name = KafkaStreamsDefaultConfiguration.DEFAULT_STREAMS_CONFIG_BEAN_NAME)
    public KafkaStreamsConfiguration kafkaStreamsConfig() {
        Map<String, Object> props = new HashMap<>();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "payment-aggregator");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG,
            "kafka-broker-1:9092,kafka-broker-2:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        // State store directory for RocksDB
        props.put(StreamsConfig.STATE_DIR_CONFIG, "/var/kafka-streams/payment-aggregator");

        // Exactly-once semantics (v2: one transactional producer per thread)
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
            StreamsConfig.EXACTLY_ONCE_V2);

        // Replication factor for internal topics (changelog, repartition)
        props.put(StreamsConfig.REPLICATION_FACTOR_CONFIG, 3);

        // Number of stream processing threads per instance
        props.put(StreamsConfig.NUM_STREAM_THREADS_CONFIG, 4);

        // Commit interval for state stores and offsets (100 ms is already the
        // default under exactly-once; at-least-once defaults to 30 s)
        props.put(StreamsConfig.COMMIT_INTERVAL_MS_CONFIG, 100L);

        return new KafkaStreamsConfiguration(props);
    }
}
```

## 3. ‏KStream — معالجة تدفق الأحداث

يمثل `KStream` تسلسلًا غير محدود من السجلات. وكل سجل حدث مستقل.

### عمليات KStream الأساسية

```java
@Component
public class PaymentStreamTopology {

    @Autowired
    public void buildTopology(StreamsBuilder streamsBuilder) {
        // Source: consume payment-events topic
        KStream<String, PaymentEvent> paymentStream = streamsBuilder
            .stream("payment-events",
                Consumed.with(Serdes.String(), paymentEventSerde()));

        // Filter: only process COMPLETED payments
        KStream<String, PaymentEvent> completedPayments = paymentStream
            .filter((accountId, event) ->
                event.getStatus() == PaymentStatus.COMPLETED);

        // Map: transform to enriched payment record
        KStream<String, EnrichedPayment> enrichedStream = completedPayments
            .mapValues((accountId, event) -> enrichPayment(event));

        // Branch: route to different topics based on amount
        Map<String, KStream<String, EnrichedPayment>> branches = enrichedStream
            .split(Named.as("payment-tier-"))
            .branch((key, payment) -> payment.getAmount().compareTo(HIGH_VALUE_THRESHOLD) >= 0,
                Branched.as("high-value"))
            .branch((key, payment) -> payment.getAmount().compareTo(LOW_VALUE_THRESHOLD) < 0,
                Branched.as("low-value"))
            .defaultBranch(Branched.as("standard"));

        branches.get("payment-tier-high-value")
            .to("high-value-payments", Produced.with(Serdes.String(), enrichedPaymentSerde()));
        branches.get("payment-tier-standard")
            .to("standard-payments", Produced.with(Serdes.String(), enrichedPaymentSerde()));
        branches.get("payment-tier-low-value")
            .to("low-value-payments", Produced.with(Serdes.String(), enrichedPaymentSerde()));
    }

    private static final BigDecimal HIGH_VALUE_THRESHOLD = new BigDecimal("10000");
    private static final BigDecimal LOW_VALUE_THRESHOLD = new BigDecimal("100");
}
```

### إعادة تعيين مفاتيح التدفقات

تعلّم إعادة تعيين المفتاح التدفق لإعادة التقسيم: فقبل العملية التالية القائمة على المفتاح (تجميع، ربط)، تكتب Kafka Streams السجلات إلى موضوع إعادة تقسيم داخلي كي تنتهي كل السجلات ذات المفتاح الجديد في القسم نفسه:

```java
// Rekey from account_id to merchant_id for merchant-level aggregations
KStream<String, PaymentEvent> rekeyedByMerchant = paymentStream
    .selectKey((accountId, event) -> event.getMerchantId());
// The next groupByKey()/join() creates an internal repartition topic
// (extra write + read through Kafka); after it, all events with the same
// merchantId are in the same partition
```

## 4. ‏KTable — تدفق سجل التغييرات (عرض مُجسّد)

يمثل `KTable` أحدث قيمة لكل مفتاح — إنه عرض مضغوط حيث تستبدل القيم الأحدث القيم الأقدم.

```java
// KTable from a topic (treats topic as changelog)
KTable<String, AccountBalance> balanceTable = streamsBuilder
    .table("account-balances",
        Consumed.with(Serdes.String(), accountBalanceSerde()),
        Materialized.as("account-balance-store"));

// KTable from a KStream aggregation
KTable<String, BigDecimal> runningTotals = paymentStream
    .groupByKey(Grouped.with(Serdes.String(), paymentEventSerde()))  // value serde
    .aggregate(
        () -> BigDecimal.ZERO,                              // Initializer
        (accountId, payment, currentTotal) ->              // Aggregator
            currentTotal.add(payment.getAmount()),
        Materialized.<String, BigDecimal, KeyValueStore<Bytes, byte[]>>as("running-totals-store")
            .withKeySerde(Serdes.String())
            .withValueSerde(bigDecimalSerde())
    );

// Output the KTable as a stream
runningTotals.toStream()
    .to("account-running-totals",
        Produced.with(Serdes.String(), bigDecimalSerde()));
```

## 5. ‏GlobalKTable — جدول بحث منسوخ لكل مثيل

يُنسخ `GlobalKTable` كاملًا إلى كل مثيل للتطبيق (كل أقسام الموضوع، يقرؤها خيط عام مخصص ويحمّلها كاملة عند البدء)، فيجعله مثاليًا لعمليات بحث الإثراء التي لا تتطلب تقسيمًا مشتركًا:

```java
// GlobalKTable for account metadata (small dataset, needs to be on every node)
GlobalKTable<String, AccountMetadata> accountMetadata = streamsBuilder
    .globalTable("account-metadata",
        Consumed.with(Serdes.String(), accountMetadataSerde()),
        Materialized.as("account-metadata-store"));

// Join payment events with account metadata
KStream<String, EnrichedPaymentEvent> enrichedPayments = paymentStream
    .join(accountMetadata,
        (paymentKey, payment) -> payment.getAccountId(), // Key extractor for GlobalKTable
        (payment, metadata) -> EnrichedPaymentEvent.builder()
            .payment(payment)
            .accountHolder(metadata.getHolderName())
            .accountTier(metadata.getTier())
            .riskScore(metadata.getRiskScore())
            .build()
    );
```

**متى تستخدم GlobalKTable مقابل ربط KTable**: استخدم `GlobalKTable` للبيانات المرجعية الصغيرة (بيانات الحسابات، بيانات التجار) التي تتسع في الذاكرة. واستخدم ربط `KTable` حين يكون الطرفان كبيرين ويجب تقسيمهما بشكل مشترك.

## 6. مخازن الحالة

مخازن الحالة قلب معالجة التدفقات ذات الحالة. وتدعم Kafka Streams تنفيذين خلفيين:

### مخزن حالة في الذاكرة

```java
// Fast, loses data on restart (restored from changelog topic)
Materialized<String, BigDecimal, KeyValueStore<Bytes, byte[]>> inMemoryStore =
    Materialized.<String, BigDecimal, KeyValueStore<Bytes, byte[]>>as("in-memory-store")
        .withKeySerde(Serdes.String())
        .withValueSerde(bigDecimalSerde())
        .withStoreType(Materialized.StoreType.IN_MEMORY);
```

### مخزن حالة RocksDB الدائم

```java
// Survives restarts, restored from local disk then changelog
Materialized<String, BigDecimal, KeyValueStore<Bytes, byte[]>> rocksDbStore =
    Materialized.<String, BigDecimal, KeyValueStore<Bytes, byte[]>>as("rocks-db-store")
        .withKeySerde(Serdes.String())
        .withValueSerde(bigDecimalSerde())
        .withStoreType(Materialized.StoreType.ROCKS_DB);
```

### إعداد مخصص لمخزن الحالة

```java
// RocksDB with custom configuration for high-throughput financial aggregations
props.put(StreamsConfig.ROCKSDB_CONFIG_SETTER_CLASS_CONFIG,
    PaymentRocksDbConfigSetter.class);

public class PaymentRocksDbConfigSetter implements RocksDBConfigSetter {

    // setConfig runs for EVERY store instance (one per store per task/partition).
    // A 256 MB cache per instance would multiply quickly (20 stores x 12
    // tasks = 60 GB!), so share ONE cache and ONE write-buffer budget.
    private static final long TOTAL_OFF_HEAP = 512 * 1024 * 1024L;     // 512 MB
    private static final long TOTAL_MEMTABLES = 128 * 1024 * 1024L;    // 128 MB of it
    private static final Cache SHARED_CACHE = new LRUCache(TOTAL_OFF_HEAP);
    private static final WriteBufferManager WRITE_BUFFER_MANAGER =
        new WriteBufferManager(TOTAL_MEMTABLES, SHARED_CACHE);

    @Override
    public void setConfig(String storeName, Options options,
                          Map<String, Object> configs) {
        // Modify the table config Kafka Streams already set up -- creating a
        // new BlockBasedTableConfig would drop its defaults (e.g. bloom filters)
        BlockBasedTableConfig tableConfig = (BlockBasedTableConfig) options.tableFormatConfig();
        tableConfig.setBlockCache(SHARED_CACHE);
        tableConfig.setCacheIndexAndFilterBlocks(true);   // count them in the budget
        tableConfig.setBlockSize(16 * 1024L);              // 16 KB blocks
        options.setTableFormatConfig(tableConfig);
        options.setWriteBufferManager(WRITE_BUFFER_MANAGER);

        // Compression for on-disk storage
        options.setCompressionType(CompressionType.LZ4_COMPRESSION);
    }

    @Override
    public void close(String storeName, Options options) {
        // Shared static cache: do NOT close it here (other stores still use it)
    }
}
```

## 7. النوافذ الزمنية

تجمّع النوافذ الأحداث داخل فترات زمنية محدودة.

### النوافذ المتعاقبة (ثابتة، غير متداخلة)

```java
// Sum payment amounts per account per hour (non-overlapping 1-hour windows)
KTable<Windowed<String>, BigDecimal> hourlyPaymentSums = paymentStream
    .groupByKey(Grouped.with(Serdes.String(), paymentEventSerde()))
    .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofHours(1)))
    .aggregate(
        () -> BigDecimal.ZERO,
        (accountId, payment, sum) -> sum.add(payment.getAmount()),
        Materialized.<String, BigDecimal, WindowStore<Bytes, byte[]>>as("hourly-payment-sums")
            .withKeySerde(Serdes.String())
            .withValueSerde(bigDecimalSerde())
    );

hourlyPaymentSums.toStream()
    .map((windowedKey, sum) -> KeyValue.pair(
        windowedKey.key(),
        HourlyPaymentSummary.builder()
            .accountId(windowedKey.key())
            .windowStart(windowedKey.window().startTime())
            .windowEnd(windowedKey.window().endTime())
            .totalAmount(sum)
            .build()
    ))
    .to("hourly-payment-summaries",
        Produced.with(Serdes.String(), hourlyPaymentSummarySerde()));
```

### النوافذ القافزة (ثابتة، متداخلة)

```java
// 1-hour window, advancing every 15 minutes (overlapping windows for real-time dashboards)
KTable<Windowed<String>, BigDecimal> rollingPaymentSums = paymentStream
    .groupByKey(Grouped.with(Serdes.String(), paymentEventSerde()))
    .windowedBy(TimeWindows.ofSizeAndGrace(Duration.ofHours(1), Duration.ofMinutes(5))
        .advanceBy(Duration.ofMinutes(15)))
    .aggregate(
        () -> BigDecimal.ZERO,
        (accountId, payment, sum) -> sum.add(payment.getAmount()),
        Materialized.<String, BigDecimal, WindowStore<Bytes, byte[]>>as("rolling-payment-sums")
            .withKeySerde(Serdes.String())
            .withValueSerde(bigDecimalSerde())
    );
```

### نوافذ الجلسات (قائمة على النشاط)

```java
// Group payments into sessions (burst of activity) with 30-minute inactivity gap
KTable<Windowed<String>, SessionSummary> paymentSessions = paymentStream
    .groupByKey(Grouped.with(Serdes.String(), paymentEventSerde()))
    .windowedBy(SessionWindows.ofInactivityGapWithNoGrace(Duration.ofMinutes(30)))
    .aggregate(
        SessionSummary::empty,
        (accountId, payment, session) -> session.addPayment(payment), // Aggregator
        (key, session1, session2) -> session1.merge(session2),         // Merger
        Materialized.<String, SessionSummary, SessionStore<Bytes, byte[]>>as("payment-sessions")
            .withKeySerde(Serdes.String())
            .withValueSerde(sessionSummarySerde())
    );
```

### فترة السماح — التعامل مع البيانات المتأخرة

```java
// Allow events up to 5 minutes late (they can arrive out-of-order due to network delays)
KTable<Windowed<String>, BigDecimal> hourlyWithGrace = paymentStream
    .groupByKey(Grouped.with(Serdes.String(), paymentEventSerde()))
    .windowedBy(TimeWindows.ofSizeAndGrace(
        Duration.ofHours(1),
        Duration.ofMinutes(5)  // Grace period for late-arriving events
    ))
    .aggregate(
        () -> BigDecimal.ZERO,
        (key, payment, total) -> total.add(payment.getAmount()),
        Materialized.<String, BigDecimal, WindowStore<Bytes, byte[]>>as("hourly-with-grace")
            .withKeySerde(Serdes.String())
            .withValueSerde(bigDecimalSerde())
    );
// Events later than window end + grace are DROPPED (counted in the
// dropped-records metric) -- monitor it; with ofSizeWithNoGrace any
// out-of-order event after the window closes is dropped
```

## 8. الربط بين تدفقين وبين تدفق وجدول

### ربط تدفق بجدول (إثراء الأحداث بأحدث حالة)

```java
// Enrich payment events with the current account balance.
// Both topics must be CO-PARTITIONED: same key (account id), same number
// of partitions, same partitioner. The join uses the table's value at
// processing time (versioned stores, Kafka 3.5+, allow timestamp-accurate
// lookups).
KTable<String, AccountBalance> balanceTable = streamsBuilder
    .table("account-balances", Consumed.with(Serdes.String(), balanceSerde()));

KStream<String, PaymentWithBalance> enrichedPayments = paymentStream
    .join(balanceTable,
        (payment, balance) -> PaymentWithBalance.builder()
            .payment(payment)
            .balanceAtTime(balance.getCurrent())
            .balanceAfter(balance.getCurrent().subtract(payment.getAmount()))
            .build()
    );
```

### ربط تدفق بتدفق (ربط تدفقي أحداث)

```java
// Correlate payment authorizations with payment captures (must arrive within
// 24 hours). Both streams keyed by payment id and co-partitioned; the join
// keeps 24h of both sides in window stores
KStream<String, Authorization> authStream = streamsBuilder
    .stream("payment-authorizations",
        Consumed.with(Serdes.String(), authSerde()));

KStream<String, Capture> captureStream = streamsBuilder
    .stream("payment-captures",
        Consumed.with(Serdes.String(), captureSerde()));

KStream<String, AuthCapturePair> correlatedPayments = authStream
    .join(captureStream,
        (authorization, capture) -> AuthCapturePair.of(authorization, capture),
        JoinWindows.ofTimeDifferenceWithNoGrace(Duration.ofHours(24)),
        StreamJoined.with(Serdes.String(), authSerde(), captureSerde())
    );
```

## 9. الاستعلامات التفاعلية — تقديم بيانات مخازن الحالة

تكشف Kafka Streams مخازن الحالة للاستعلامات التفاعلية — مفيد لواجهات الأرصدة الفورية. وتحفظان: كل مثيل يحمل مخازن أقسامه فقط (استخدم `queryMetadataForKey(...)` لإيجاد المثيل الذي يملك مفتاحًا ووجّه الطلب إليه)، والمخازن غير متاحة أثناء إعادة التوازن والاستعادة (`InvalidStateStoreException` — أعد المحاولة أو أعد 503).

```java
@Service
public class PaymentStateQueryService {

    // With Spring: StreamsBuilderFactoryBean#getKafkaStreams()
    private final KafkaStreams kafkaStreams;

    public Optional<BigDecimal> getRunningTotal(String accountId) {
        // (production: first check queryMetadataForKey(...) -- if another
        //  instance owns this key, call that instance's endpoint instead)
        ReadOnlyKeyValueStore<String, BigDecimal> store =
            kafkaStreams.store(StoreQueryParameters.fromNameAndType(
                "running-totals-store",
                QueryableStoreTypes.keyValueStore()
            ));

        return Optional.ofNullable(store.get(accountId));
    }

    public List<HourlyPaymentSummary> getHourlySummaries(String accountId) {
        ReadOnlyWindowStore<String, BigDecimal> windowStore =
            kafkaStreams.store(StoreQueryParameters.fromNameAndType(
                "hourly-payment-sums",
                QueryableStoreTypes.windowStore()
            ));

        // Query last 24 hours
        Instant from = Instant.now().minus(24, ChronoUnit.HOURS);
        Instant to = Instant.now();

        List<HourlyPaymentSummary> summaries = new ArrayList<>();
        try (WindowStoreIterator<BigDecimal> iterator =
                windowStore.fetch(accountId, from, to)) {
            while (iterator.hasNext()) {
                KeyValue<Long, BigDecimal> entry = iterator.next();
                summaries.add(HourlyPaymentSummary.builder()
                    .accountId(accountId)
                    .windowStart(Instant.ofEpochMilli(entry.key))
                    .totalAmount(entry.value)
                    .build());
            }
        }

        return summaries;
    }
}
```

## 10. مثال التجميع الفوري للمدفوعات

حالة الاستخدام المالية النموذجية: جمع مبالغ الدفع لكل حساب في كل ساعة، مع محفزات كشف الاحتيال:

```java
@Component
@Slf4j
public class PaymentAggregationTopology {

    private static final BigDecimal FRAUD_THRESHOLD = new BigDecimal("50000");
    private static final Duration WINDOW_SIZE = Duration.ofHours(1);
    private static final Duration GRACE_PERIOD = Duration.ofMinutes(5);

    @Autowired
    public void buildTopology(StreamsBuilder builder) {
        Serde<PaymentEvent> paymentSerde = new JsonSerde<>(PaymentEvent.class);
        Serde<HourlyPaymentAggregation> aggregationSerde =
            new JsonSerde<>(HourlyPaymentAggregation.class);
        Serde<FraudAlert> alertSerde = new JsonSerde<>(FraudAlert.class);

        KStream<String, PaymentEvent> payments = builder.stream(
            "payment-events",
            Consumed.with(Serdes.String(), paymentSerde)
        );

        // Only aggregate completed payments
        KStream<String, PaymentEvent> completedPayments = payments
            .filter((accountId, event) ->
                event.getStatus() == PaymentStatus.COMPLETED
                && event.getAmount().compareTo(BigDecimal.ZERO) > 0
            );

        // Aggregate: total amount per account per hour
        KTable<Windowed<String>, HourlyPaymentAggregation> hourlyAggregation =
            completedPayments
                .groupByKey(Grouped.with(Serdes.String(), paymentSerde))
                .windowedBy(TimeWindows.ofSizeAndGrace(WINDOW_SIZE, GRACE_PERIOD))
                .aggregate(
                    HourlyPaymentAggregation::empty,
                    (accountId, payment, agg) -> agg.addPayment(payment),
                    Materialized.<String, HourlyPaymentAggregation, WindowStore<Bytes, byte[]>>
                        as("hourly-aggregation-store")
                        .withKeySerde(Serdes.String())
                        .withValueSerde(aggregationSerde)
                        .withRetention(Duration.ofDays(2))
                );

        // NOTE: a windowed aggregation emits an UPDATE for every incoming
        // payment (modulo caching), not one result per window.

        // Sink 1: FINAL hourly totals only -- suppress until the window
        // (plus grace) has closed, then emit exactly one record per window
        hourlyAggregation
            .suppress(Suppressed.untilWindowCloses(Suppressed.BufferConfig.unbounded()))
            .toStream()
            .map((windowedKey, agg) -> KeyValue.pair(windowedKey.key(),
                agg.withWindow(windowedKey.window().startTime(),   // real window bounds
                               windowedKey.window().endTime())))
            .to("hourly-payment-aggregations",
                Produced.with(Serdes.String(), aggregationSerde));

        // Sink 2: fraud alerts EARLY, from the running updates. The same
        // window will produce further updates above the threshold, so the
        // alert id is DETERMINISTIC (account + window start): downstream
        // consumers de-duplicate on it instead of receiving N random alerts.
        hourlyAggregation.toStream()
            .filter((windowedKey, agg) ->
                agg != null && agg.getTotalAmount().compareTo(FRAUD_THRESHOLD) > 0)
            .map((windowedKey, agg) -> KeyValue.pair(windowedKey.key(), FraudAlert.builder()
                .alertId(windowedKey.key() + ":" + windowedKey.window().start())
                .accountId(windowedKey.key())
                .alertType(FraudAlertType.VELOCITY_BREACH)
                .detectedAmount(agg.getTotalAmount())
                .threshold(FRAUD_THRESHOLD)
                .windowStart(windowedKey.window().startTime())
                .windowEnd(windowedKey.window().endTime())
                .paymentCount(agg.getPaymentCount())
                .detectedAt(Instant.now())
                .build()))
            .to("fraud-alerts", Produced.with(Serdes.String(), alertSerde));

        log.info("Payment aggregation topology built successfully");
    }
}

@Value
@Builder(toBuilder = true)
public class HourlyPaymentAggregation {

    String accountId;
    BigDecimal totalAmount;
    int paymentCount;
    Instant windowStart;   // set from the Windowed key when emitting
    Instant windowEnd;

    public static HourlyPaymentAggregation empty() {
        return HourlyPaymentAggregation.builder()
            .totalAmount(BigDecimal.ZERO)
            .paymentCount(0)
            .build();
    }

    public HourlyPaymentAggregation addPayment(PaymentEvent payment) {
        return toBuilder()
            .accountId(payment.getAccountId())
            .totalAmount(this.totalAmount.add(payment.getAmount()))
            .paymentCount(this.paymentCount + 1)
            .build();
    }

    public HourlyPaymentAggregation withWindow(Instant start, Instant end) {
        return toBuilder().windowStart(start).windowEnd(end).build();
    }
}
```

## 11. المعالجة مرة واحدة بالضبط في Kafka Streams

```java
// Enable exactly-once v2 (requires Kafka 2.5+ brokers)
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
    StreamsConfig.EXACTLY_ONCE_V2);

// EOS v2 is more efficient than EOS v1 (removed in Kafka 4.0):
// - Uses one transactional producer per stream THREAD (not per task)
// - Zombie fencing via the consumer group metadata (KIP-447) instead of
//   one transactional.id per input partition
// - Lower overhead, better throughput
```

**كلفة EOS**: تكلّف المعاملات بعض الإنتاجية، ولا تصبح المخرجات مرئية لمستهلكي `read_committed` إلا حين تلتزم المعاملة — كل `commit.interval.ms` ‏(100 ms افتراضيًا تحت EOS)، ما يضيف زمنًا من الطرف إلى الطرف. ومقدار الإنتاجية المفقودة يعتمد كثيرًا على الحمل وفترة الالتزام؛ فقِسه (وكثيرًا ما يكون متواضعًا). وللأنظمة المالية حيث الصحة غير قابلة للتفاوض، يكون هذا مقبولًا عادة. ولمواضيع التحليلات عالية الإنتاجية، فكّر في "مرة واحدة على الأقل" مع مستهلكين idempotent.

## 12. معالجة الأخطاء في Kafka Streams

```java
// For PAYMENT streams, skipping a record silently loses a payment: fail,
// or use a handler that sends the raw record to a dead-letter topic.
// (Config names: DEFAULT_... in 3.x; Kafka 4.0 renamed them without the
//  DEFAULT_ prefix.)
props.put(StreamsConfig.DEFAULT_DESERIALIZATION_EXCEPTION_HANDLER_CLASS_CONFIG,
    LogAndFailExceptionHandler.class);
// Options: LogAndContinueExceptionHandler (skip -- OK for metrics/analytics),
//          LogAndFailExceptionHandler (stop -- default)

props.put(StreamsConfig.DEFAULT_PRODUCTION_EXCEPTION_HANDLER_CLASS_CONFIG,
    DefaultProductionExceptionHandler.class);
```

```java
// Custom production exception handler for financial streams
public class PaymentStreamProductionExceptionHandler
        implements ProductionExceptionHandler {

    @Override
    public ProductionExceptionHandlerResponse handle(
            ProducerRecord<byte[], byte[]> record,
            Exception exception) {

        String key = record.key() == null ? "null"
            : new String(record.key(), StandardCharsets.UTF_8);
        log.error("Production error for record key={}: {}",
            key, exception.getMessage(), exception);

        if (exception instanceof RecordTooLargeException) {
            // A payment output that cannot be written must not vanish:
            // alert and FAIL (CONTINUE would drop it and commit past it).
            // CONTINUE is only acceptable for non-critical outputs.
            alertingService.sendAlert("Kafka Streams: record too large", exception);
        }

        // Fail the stream — requires operator intervention
        // (Kafka 3.9+ also offers a handle(ErrorHandlerContext, ...) variant)
        return ProductionExceptionHandlerResponse.FAIL;
    }
}
```

## الخلاصة

| المفهوم           | حالة الاستخدام المالية                                       |
|-------------------|---------------------------------------------------------|
| ‏`KStream`         | ترشيح أحداث الدفع وتحويلها وتوجيهها             |
| ‏`KTable`          | الحفاظ على الحالة الحالية (مثل رصيد الحساب الجاري) |
| ‏`GlobalKTable`    | إثراء الأحداث بالبيانات المرجعية (بيانات الحساب)   |
| النافذة المتعاقبة   | إجماليات الدفع بالساعة لفحص السرعة             |
| النافذة القافزة    | رصيد متدحرج فوري لعرض لوحات المعلومات        |
| نافذة الجلسة    | تجميع دفقات النشاط للتحليلات السلوكية       |
| الاستعلام التفاعلي | تقديم بيانات الرصيد الفورية عبر REST API               |
| ‏EOS v2            | تجميع مرة واحدة بالضبط لإجماليات مالية قابلة للتدقيق |
| مخزن RocksDB     | حالة دائمة تنجو من إعادة تشغيل التطبيق        |

**الدرس التالي**: دلالات مرة واحدة بالضبط — المعاملات في Kafka

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق الأساسي بين KTable وKStream في Kafka Streams؟",
      "options": [
        "‏KTable أسرع من KStream لكل العمليات",
        "يمثل KStream سجل أحداث غير محدود بينما يمثل KTable أحدث قيمة لكل مفتاح",
        "يدعم KTable النوافذ الزمنية بينما لا يدعمها KStream",
        "‏KStream مدعوم بـ RocksDB بينما KTable في الذاكرة فقط"
      ],
      "correct": 1,
      "explanation": "ينمذج KStream تسلسلًا غير محدود من الأحداث المستقلة. وينمذج KTable سجل تغييرات حيث يستبدل كل سجل جديد لمفتاح القيمة السابقة — فيمثل الحالة الحالية لكل مفتاح."
    },
    {
      "text": "متى يجب استخدام GlobalKTable بدل ربط KTable؟",
      "options": [
        "حين تكون مجموعتا البيانات كبيرتين ويجب تقسيمهما بشكل مشترك",
        "حين تحتاج دلالات مرة واحدة بالضبط",
        "حين تكون مجموعة البيانات المرجعية صغيرة ويجب أن تتوفر على كل مثيل",
        "حين تلزم تجميعات النوافذ الزمنية"
      ],
      "correct": 2,
      "explanation": "يُنسخ GlobalKTable كاملًا (كل الأقسام) إلى كل مثيل للتطبيق، فيجعله مثاليًا لمجموعات البيانات المرجعية الصغيرة (بيانات الحسابات، بيانات التجار) التي يجب أن تتوفر لعمليات بحث الإثراء دون اشتراط التقسيم المشترك."
    },
    {
      "text": "ما الكلفة الأساسية لتفعيل دلالات مرة واحدة بالضبط (EOS v2) في Kafka Streams؟",
      "options": [
        "لا كلفة إطلاقًا — EOS v2 مجانية",
        "بعض فقد الإنتاجية بسبب المعاملات وزمن إضافي من الطرف إلى الطرف، لأن النتائج تصبح مرئية لمستهلكي read_committed فقط عند كل التزام (كل commit.interval.ms، ‏100 ms افتراضيًا)؛ والمقدار يعتمد على الحمل — فقِسه",
        "تقليل الإنتاجية بنسبة 50% بالضبط",
        "تعطّل مخازن الحالة، فيجب نقل العمليات ذات الحالة إلى قاعدة بيانات"
      ],
      "correct": 1,
      "explanation": "تغلّف EOS v2 مخرجات كل فترة التزام وإزاحاتها في معاملة Kafka. وهذا يكلّف بعض الإنتاجية (كثيرًا ما يكون متواضعًا، لكنه يعتمد على الحمل) ويؤخر رؤية النتائج لمستهلكي read_committed حتى التزام المعاملة، كل commit.interval.ms ‏(100 ms افتراضيًا تحت EOS). وللأنظمة المالية حيث الصحة غير قابلة للتفاوض، تكون هذه المفاضلة مقبولة عادة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء طوبولوجيا كشف احتيال فوري للمدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "أنشئ طوبولوجيا Kafka Streams تستهلك من موضوع 'payment-events'، وترشّح المدفوعات COMPLETED، وتجمّع حسب معرّف الحساب باستخدام نوافذ متعاقبة مدتها ساعة لحساب إجماليات مبالغ الدفع."},
    {"id": "2", "description": "أضف خطوة إثراء GlobalKTable تربط كل حدث دفع ببيانات الحساب (شريحة المخاطر، واسم صاحب الحساب) من موضوع 'account-metadata' لإنتاج أحداث دفع مُثراة."},
    {"id": "3", "description": "نفّذ منطق كشف الاحتيال: رشّح نتائج التجميع بالنوافذ للحسابات التي يتجاوز إجماليها بالساعة 50,000 جنيه، وانشر أحداث FraudAlert إلى موضوع 'fraud-alerts' بالمبلغ المكتشف والطوابع الزمنية للنافذة."},
    {"id": "4", "description": "اكشف نقطة نهاية استعلام تفاعلي باستخدام واجهة مخازن KafkaStreams تقدّم الإجمالي الجاري الحالي لمعرّف حساب معين، وأضف فترة سماح 5 دقائق للتعامل مع أحداث الدفع المتأخرة."}
  ]
}
-->
