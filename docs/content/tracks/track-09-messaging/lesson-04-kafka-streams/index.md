---
id: track-09-lesson-04
title: "Kafka Streams — Stateful Stream Processing"
slug: kafka-streams
track: track-09
trackName: "Kafka & Event-Driven Architecture"
sequence: 4
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [Kafka-Streams, KStream, KTable, state-store, windowing]
prerequisites: [track-09-lesson-03]
---

# Kafka Streams — Stateful Stream Processing

> [!NOTE]
> Kafka Streams is not just a streaming library — it is a distributed, fault-tolerant stateful computation engine that runs inside your Java application. For financial systems, this means you can compute running balances, detect fraud patterns, and aggregate payment volumes in real-time without a separate cluster like Flink or Spark.

## Overview

Kafka Streams turns Kafka topics into a programmable computation graph. Unlike consumer-only patterns, Kafka Streams manages state, handles failure recovery, and provides exactly-once semantics — all embedded in your application JAR.

This lesson covers the full Streams topology: KStream for event streams, KTable for changelog tables, GlobalKTable for broadcast lookups, state stores backed by RocksDB, windowing for time-bounded aggregations, and practical financial use cases including real-time payment aggregation and fraud detection.

---

## 1. Kafka Streams Architecture

### Topology Concepts

A Kafka Streams application defines a **topology** — a directed acyclic graph of stream processing operations:

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

### Streams vs Consumer

| Aspect              | Kafka Consumer          | Kafka Streams                        |
|---------------------|-------------------------|--------------------------------------|
| State management    | Your code               | Built-in (RocksDB, in-memory)        |
| Fault tolerance     | Your code               | Automatic state restore from changelog |
| Exactly-once        | Manual implementation   | Built-in (`processing.guarantee=exactly_once_v2`) |
| Parallelism         | Partition assignment    | Stream tasks (one per partition)     |
| Deployment          | Standalone app          | Embedded in your Spring Boot app     |

---

## 2. Setting Up Kafka Streams with Spring Boot

### Dependencies

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

### Basic Configuration

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

---

## 3. KStream — Event Stream Processing

A `KStream` represents an unbounded sequence of records. Each record is an independent event.

### Basic KStream Operations

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

### Rekeying Streams

Rekeying marks the stream for repartitioning: before the next key-based operation (aggregation, join), Kafka Streams writes the records to an internal repartition topic so that all records with the new key end up in the same partition:

```java
// Rekey from account_id to merchant_id for merchant-level aggregations
KStream<String, PaymentEvent> rekeyedByMerchant = paymentStream
    .selectKey((accountId, event) -> event.getMerchantId());
// The next groupByKey()/join() creates an internal repartition topic
// (extra write + read through Kafka); after it, all events with the same
// merchantId are in the same partition
```

---

## 4. KTable — Changelog Stream (Materialized View)

A `KTable` represents the latest value for each key — it is a compacted view where newer values override older ones.

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

---

## 5. GlobalKTable — Broadcast Lookup Table

A `GlobalKTable` is fully copied to EVERY application instance (all partitions of the topic, read by a dedicated global thread and loaded completely at startup), making it ideal for enrichment lookups that don't require co-partitioning:

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

**When to use GlobalKTable vs KTable join**: Use `GlobalKTable` for small reference data (account metadata, merchant data) that fits in memory. Use `KTable` join when both sides are large and must be co-partitioned.

---

## 6. State Stores

State stores are the heart of stateful stream processing. Kafka Streams supports two backend implementations:

### In-Memory State Store

```java
// Fast, loses data on restart (restored from changelog topic)
Materialized<String, BigDecimal, KeyValueStore<Bytes, byte[]>> inMemoryStore =
    Materialized.<String, BigDecimal, KeyValueStore<Bytes, byte[]>>as("in-memory-store")
        .withKeySerde(Serdes.String())
        .withValueSerde(bigDecimalSerde())
        .withStoreType(Materialized.StoreType.IN_MEMORY);
```

### Persistent RocksDB State Store

```java
// Survives restarts, restored from local disk then changelog
Materialized<String, BigDecimal, KeyValueStore<Bytes, byte[]>> rocksDbStore =
    Materialized.<String, BigDecimal, KeyValueStore<Bytes, byte[]>>as("rocks-db-store")
        .withKeySerde(Serdes.String())
        .withValueSerde(bigDecimalSerde())
        .withStoreType(Materialized.StoreType.ROCKS_DB);
```

### Custom State Store Configuration

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

---

## 7. Windowing

Windows aggregate events within bounded time intervals.

### Tumbling Windows (Fixed, Non-Overlapping)

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

### Hopping Windows (Fixed, Overlapping)

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

### Session Windows (Activity-Based)

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

### Grace Period — Late Data Handling

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

---

## 8. Stream-Stream Joins and Stream-Table Joins

### Stream-Table Join (Enrich Events with Latest State)

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

### Stream-Stream Join (Correlate Two Event Streams)

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

---

## 9. Interactive Queries — Serving State Store Data

Kafka Streams exposes state stores for interactive queries — useful for real-time balance APIs. Two caveats: each instance holds only the stores of ITS partitions (use `queryMetadataForKey(...)` to find the instance that owns a key and forward the request there), and stores are unavailable during rebalances and restoration (`InvalidStateStoreException` — retry or return 503).

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

---

## 10. Real-Time Payment Aggregation Example

The canonical financial use case: sum payment amounts per account per hour, with fraud detection triggers:

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

---

## 11. Exactly-Once Processing in Kafka Streams

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

**EOS cost**: transactions cost some throughput, and output becomes visible to `read_committed` consumers only when a transaction commits — every `commit.interval.ms` (100 ms by default under EOS), which adds end-to-end latency. How much throughput you lose depends heavily on the workload and the commit interval; measure it (it is often modest). For financial systems where correctness is non-negotiable, this is usually acceptable. For high-throughput analytics topics, consider at-least-once with idempotent consumers.

---

## 12. Error Handling in Kafka Streams

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

---

## Summary

| Concept           | Financial Use Case                                       |
|-------------------|---------------------------------------------------------|
| `KStream`         | Filter, transform, and route payment events             |
| `KTable`          | Maintain current state (e.g., running account balance) |
| `GlobalKTable`    | Enrich events with reference data (account metadata)   |
| Tumbling window   | Hourly payment totals for velocity checking             |
| Hopping window    | Real-time rolling balance for dashboard displays        |
| Session window    | Group bursts of activity for behavioral analytics       |
| Interactive query | Serve real-time balance data via REST API               |
| EOS v2            | Exactly-once aggregation for auditable financial totals |
| RocksDB store     | Durable state that survives application restarts        |

**Next lesson**: Exactly-Once Semantics — Transactions in Kafka

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the key difference between a KTable and a KStream in Kafka Streams?",
      "options": [
        "KTable is faster than KStream for all operations",
        "KStream represents an unbounded event log while KTable represents the latest value per key",
        "KTable supports windowing while KStream does not",
        "KStream is backed by RocksDB while KTable is in-memory only"
      ],
      "correct": 1,
      "explanation": "A KStream models an unbounded sequence of independent events. A KTable models a changelog where each new record for a key overwrites the previous value — representing the current state per key."
    },
    {
      "text": "When should you use a GlobalKTable instead of a KTable join?",
      "options": [
        "When both datasets are large and must be co-partitioned",
        "When you need exactly-once semantics",
        "When the reference dataset is small and must be available on every stream task instance",
        "When windowing aggregations are required"
      ],
      "correct": 2,
      "explanation": "A GlobalKTable copies the whole table (all partitions) to every application instance, making it ideal for small reference datasets (account metadata, merchant data) that need to be available for enrichment lookups without requiring co-partitioning."
    },
    {
      "text": "What is the main cost of enabling exactly-once semantics (EOS v2) in Kafka Streams?",
      "options": [
        "No cost at all — EOS v2 is free",
        "Some throughput loss from transactions and extra end-to-end latency, because results become visible to read_committed consumers only at each commit (every commit.interval.ms, 100 ms by default); the size depends on the workload — measure it",
        "Exactly 50% throughput reduction",
        "It disables state stores, so stateful operations must be moved to a database"
      ],
      "correct": 1,
      "explanation": "EOS v2 wraps each commit interval's output and offsets in a Kafka transaction. That costs some throughput (often modest, but workload-dependent) and delays visibility of results for read_committed consumers until the transaction commits, every commit.interval.ms (100 ms by default under EOS). For financial systems where correctness is non-negotiable, this trade-off is usually acceptable."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Real-Time Payment Fraud Detection Topology",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Create a Kafka Streams topology that consumes from a 'payment-events' topic, filters for COMPLETED payments, and groups by account ID using tumbling 1-hour windows to compute total payment amounts."},
    {"id": "2", "description": "Add a GlobalKTable enrichment step that joins each payment event with account metadata (risk tier, account holder name) from an 'account-metadata' topic to produce enriched payment events."},
    {"id": "3", "description": "Implement fraud detection logic: filter the windowed aggregation results for accounts where the hourly total exceeds £50,000, and publish FraudAlert events to a 'fraud-alerts' topic with the detected amount and window timestamps."},
    {"id": "4", "description": "Expose an interactive query endpoint using the KafkaStreams store API that serves the current running total for a given account ID, and add a grace period of 5 minutes to handle late-arriving payment events."}
  ]
}
-->
