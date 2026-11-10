---
id: track-11-lesson-04
title: "Kafka Streams — Stateful Stream Processing"
slug: kafka-streams
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 4
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [Kafka-Streams, KStream, KTable, state-store, windowing]
prerequisites: [track-11-lesson-03]
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

        // Exactly-once semantics (v2 uses epochs, not fencing)
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
            StreamsConfig.EXACTLY_ONCE_V2);

        // Replication factor for internal topics (changelog, repartition)
        props.put(StreamsConfig.REPLICATION_FACTOR_CONFIG, 3);

        // Number of stream processing threads per instance
        props.put(StreamsConfig.NUM_STREAM_THREADS_CONFIG, 4);

        // Commit interval for state stores and offsets
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

Rekeying triggers a repartition, which changes the partition an event belongs to. This is necessary before aggregating on a different key:

```java
// Rekey from account_id to merchant_id for merchant-level aggregations
KStream<String, PaymentEvent> rekeyedByMerchant = paymentStream
    .selectKey((accountId, event) -> event.getMerchantId());
// This triggers an internal repartition topic
// All events with the same merchantId now go to the same partition
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
    .groupByKey()
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

A `GlobalKTable` is replicated across ALL stream task instances, making it ideal for enrichment lookups that don't require partitioning:

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

    @Override
    public void setConfig(String storeName, Options options,
                          Map<String, Object> configs) {
        // Configure block cache size (default 50 MB per store — increase for large datasets)
        BlockBasedTableConfig tableConfig = new BlockBasedTableConfig();
        tableConfig.setBlockCacheSize(256 * 1024 * 1024L); // 256 MB
        tableConfig.setBlockSize(16 * 1024L);               // 16 KB blocks
        options.setTableFormatConfig(tableConfig);

        // Write buffer size
        options.setWriteBufferSize(64 * 1024 * 1024L); // 64 MB
        options.setMaxWriteBufferNumber(3);

        // Compression for on-disk storage
        options.setCompressionType(CompressionType.LZ4_COMPRESSION);
    }

    @Override
    public void close(String storeName, Options options) {
        // Release any native resources
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
    .groupByKey()
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
    .groupByKey()
    .windowedBy(TimeWindows.ofSizeAndGrace(Duration.ofHours(1), Duration.ofMinutes(5))
        .advanceBy(Duration.ofMinutes(15)))
    .aggregate(
        () -> BigDecimal.ZERO,
        (accountId, payment, sum) -> sum.add(payment.getAmount()),
        Materialized.as("rolling-payment-sums")
    );
```

### Session Windows (Activity-Based)

```java
// Group payments into sessions (burst of activity) with 30-minute inactivity gap
KTable<Windowed<String>, SessionSummary> paymentSessions = paymentStream
    .groupByKey()
    .windowedBy(SessionWindows.ofInactivityGapWithNoGrace(Duration.ofMinutes(30)))
    .aggregate(
        SessionSummary::empty,
        (accountId, payment, session) -> session.addPayment(payment), // Aggregator
        (key, session1, session2) -> session1.merge(session2),         // Merger
        Materialized.as("payment-sessions")
    );
```

### Grace Period — Late Data Handling

```java
// Allow events up to 5 minutes late (they can arrive out-of-order due to network delays)
KTable<Windowed<String>, BigDecimal> hourlyWithGrace = paymentStream
    .groupByKey()
    .windowedBy(TimeWindows.ofSizeAndGrace(
        Duration.ofHours(1),
        Duration.ofMinutes(5)  // Grace period for late-arriving events
    ))
    .aggregate(
        () -> BigDecimal.ZERO,
        (key, payment, total) -> total.add(payment.getAmount()),
        Materialized.as("hourly-with-grace")
    );
```

---

## 8. Stream-Stream Joins and Stream-Table Joins

### Stream-Table Join (Enrich Events with Latest State)

```java
// Enrich payment events with the current account balance
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
// Correlate payment authorizations with payment captures (must arrive within 24 hours)
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

Kafka Streams exposes state stores for interactive queries — useful for real-time balance APIs:

```java
@Service
public class PaymentStateQueryService {

    private final KafkaStreams kafkaStreams;

    public Optional<BigDecimal> getRunningTotal(String accountId) {
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

        // Stream aggregation results
        KStream<String, HourlyPaymentAggregation> aggregationStream =
            hourlyAggregation.toStream()
                .map((windowedKey, agg) -> KeyValue.pair(windowedKey.key(), agg));

        // Sink: publish aggregations
        aggregationStream.to("hourly-payment-aggregations",
            Produced.with(Serdes.String(), aggregationSerde));

        // Fraud detection: alert if hourly total exceeds threshold
        aggregationStream
            .filter((accountId, agg) ->
                agg.getTotalAmount().compareTo(FRAUD_THRESHOLD) > 0)
            .mapValues((accountId, agg) -> FraudAlert.builder()
                .alertId(UUID.randomUUID().toString())
                .accountId(accountId)
                .alertType(FraudAlertType.VELOCITY_BREACH)
                .detectedAmount(agg.getTotalAmount())
                .threshold(FRAUD_THRESHOLD)
                .windowStart(agg.getWindowStart())
                .windowEnd(agg.getWindowEnd())
                .paymentCount(agg.getPaymentCount())
                .detectedAt(Instant.now())
                .build())
            .to("fraud-alerts", Produced.with(Serdes.String(), alertSerde));

        log.info("Payment aggregation topology built successfully");
    }
}

@Value
@Builder
public class HourlyPaymentAggregation {

    String accountId;
    BigDecimal totalAmount;
    int paymentCount;
    Instant windowStart;
    Instant windowEnd;

    public static HourlyPaymentAggregation empty() {
        return HourlyPaymentAggregation.builder()
            .totalAmount(BigDecimal.ZERO)
            .paymentCount(0)
            .build();
    }

    public HourlyPaymentAggregation addPayment(PaymentEvent payment) {
        return HourlyPaymentAggregation.builder()
            .accountId(payment.getAccountId())
            .totalAmount(this.totalAmount.add(payment.getAmount()))
            .paymentCount(this.paymentCount + 1)
            .windowStart(this.windowStart != null
                ? this.windowStart : payment.getEventTime())
            .windowEnd(payment.getEventTime())
            .build();
    }
}
```

---

## 11. Exactly-Once Processing in Kafka Streams

```java
// Enable exactly-once v2 (requires Kafka 2.5+ brokers)
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
    StreamsConfig.EXACTLY_ONCE_V2);

// EOS v2 is more efficient than EOS v1:
// - Uses one transactional producer per stream thread (not per task)
// - Uses epoch-based fencing instead of zombie fencing
// - Lower overhead, better throughput
```

**EOS Performance Cost**: Enabling exactly-once reduces throughput by approximately 20-30% due to transactional overhead. For financial systems where correctness is non-negotiable, this is acceptable. For high-throughput analytics topics, consider at-least-once with idempotent consumers.

---

## 12. Error Handling in Kafka Streams

```java
props.put(StreamsConfig.DEFAULT_DESERIALIZATION_EXCEPTION_HANDLER_CLASS_CONFIG,
    LogAndContinueExceptionHandler.class);
// Options: LogAndContinueExceptionHandler (skip), LogAndFailExceptionHandler (crash)

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

        log.error("Production error for record key={}: {}",
            new String(record.key()), exception.getMessage(), exception);

        if (exception instanceof RecordTooLargeException) {
            // Skip oversized records — alert and continue
            alertingService.sendAlert("Kafka Streams: record too large", exception);
            return ProductionExceptionHandlerResponse.CONTINUE;
        }

        // For all other errors, fail the stream — requires operator intervention
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
      "explanation": "GlobalKTable replicates the entire table to every stream task instance, making it ideal for small reference datasets (account metadata, merchant data) that need to be available for enrichment lookups without requiring co-partitioning."
    },
    {
      "text": "What is the performance cost of enabling exactly-once semantics (EOS v2) in Kafka Streams?",
      "options": [
        "No measurable cost — EOS v2 is fully optimized",
        "Approximately 20-30% throughput reduction due to transactional overhead",
        "Exactly 50% throughput reduction",
        "EOS v2 increases latency but not throughput cost"
      ],
      "correct": 1,
      "explanation": "Enabling EOS v2 reduces throughput by approximately 20-30% due to the overhead of coordinating transactions. For financial systems where correctness is non-negotiable, this trade-off is acceptable."
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
