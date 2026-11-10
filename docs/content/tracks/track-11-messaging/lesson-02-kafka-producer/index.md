---
id: track-11-lesson-02
title: "Kafka Producer — Acknowledgement, Batching, and Ordering"
slug: kafka-producer
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 2
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, producer, acks, idempotent, ordering]
prerequisites: [track-11-lesson-01]
---

# Kafka Producer — Acknowledgement, Batching, and Ordering

> [!NOTE]
> The Kafka producer is not a simple fire-and-forget client. In financial systems, every configuration knob — acks, retries, linger.ms, idempotence — directly maps to a durability and ordering guarantee. Getting these wrong means duplicate payments, lost transactions, or silent data corruption at scale.

## Overview

The Kafka producer is responsible for serializing records, selecting a partition, batching messages for efficiency, and delivering them to brokers with the durability guarantees you specify. For payment systems, the stakes are high: an under-configured producer can silently drop transactions or produce duplicates that require expensive reconciliation.

This lesson walks through every critical producer configuration from first principles, with production-grade Java examples using Spring Kafka. By the end, you will understand exactly what happens inside the producer client from the moment `send()` is called until the broker acknowledges the write.

---

## 1. Producer Internals: What Happens When You Call send()

Before tuning configuration, understand the lifecycle of a single `ProducerRecord`:

1. **Serialization** — Key and value are serialized using configured serializers.
2. **Partitioning** — A partitioner assigns the record to a partition (default: hash of key, or round-robin if no key).
3. **Record Accumulator** — Records are buffered in a per-partition `Deque<ProducerBatch>`. Batches accumulate until `batch.size` is reached or `linger.ms` expires.
4. **Sender Thread** — A background `Sender` thread drains the accumulator and groups batches by broker (leader for each partition).
5. **In-Flight Requests** — Batches are sent as `ProduceRequest` messages. Up to `max.in.flight.requests.per.connection` requests can be outstanding per broker connection.
6. **Acknowledgement** — The broker responds with success or error, and the producer resolves the callback future.

This pipeline has profound implications for throughput, latency, ordering, and durability.

---

## 2. Acknowledgement Modes (acks)

The `acks` setting controls how many broker replicas must confirm a write before the producer considers it successful.

### acks=0 — Fire and Forget

```java
props.put(ProducerConfig.ACKS_CONFIG, "0");
```

The producer does not wait for any acknowledgement. Maximum throughput, zero durability. **Never use in financial systems.** If the broker crashes after receiving the record but before writing it, the data is silently lost.

### acks=1 — Leader Acknowledgement

```java
props.put(ProducerConfig.ACKS_CONFIG, "1");
```

The partition leader writes the record to its local log and acknowledges. Fast, but if the leader crashes before followers replicate, the record is lost. Acceptable for non-critical metrics; not for payment events.

### acks=all (or acks=-1) — Full In-Sync Replica Acknowledgement

```java
props.put(ProducerConfig.ACKS_CONFIG, "all");
```

The leader waits for all in-sync replicas (ISR) to acknowledge before responding. Combined with `min.insync.replicas=2` on the broker/topic, this guarantees the record survives the failure of any single broker.

```java
// Broker/topic configuration (not producer-side):
// min.insync.replicas=2
// replication.factor=3
```

**Production rule**: Financial topics must use `acks=all` with `min.insync.replicas >= 2`. This is non-negotiable.

---

## 3. Retries and Idempotence

### The Retry Problem

With `acks=all`, network timeouts can cause the producer to retry a request that the broker already committed. Without idempotence, this produces duplicates:

```
Producer sends batch → Network timeout → Producer retries → Broker committed BOTH
Result: duplicate payment event
```

### Enabling Idempotent Producer

```java
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
```

When idempotence is enabled:
- Each producer instance is assigned a **Producer ID (PID)** by the broker.
- Each record batch carries a **sequence number** per partition.
- The broker deduplicates retries using `(PID, partition, sequence_number)`.

Idempotence also automatically sets:
- `acks=all`
- `retries=Integer.MAX_VALUE`
- `max.in.flight.requests.per.connection=5`

```java
// Idempotent producer configuration
Map<String, Object> producerProps = new HashMap<>();
producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG,
    "kafka-broker-1:9092,kafka-broker-2:9092");
producerProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
producerProps.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
producerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
producerProps.put(ProducerConfig.ACKS_CONFIG, "all");
producerProps.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
producerProps.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
producerProps.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000); // 2 minutes total
```

> [!WARNING]
> `max.in.flight.requests.per.connection` must be <= 5 when idempotence is enabled. Setting it higher disables the deduplication guarantee and will throw a `ConfigException` at startup.

---

## 4. Batching Configuration

Batching is the primary mechanism for throughput. The producer accumulates records into batches before sending.

### batch.size

The maximum number of **bytes** (not records) in a single batch per partition. When a batch reaches this size, it is immediately sent regardless of `linger.ms`.

```java
props.put(ProducerConfig.BATCH_SIZE_CONFIG, 65536); // 64 KB
```

Default is 16 KB. For high-throughput payment event streams, 64 KB to 1 MB is common. Larger batches mean better compression ratios but higher latency for individual records.

### linger.ms

The maximum time the producer will wait before sending an incomplete batch. This is a deliberate latency trade-off for throughput.

```java
props.put(ProducerConfig.LINGER_MS_CONFIG, 5); // Wait up to 5ms to fill a batch
```

Default is 0 (send immediately). For payment processing where you have high message rates but can tolerate 5–20ms of additional latency, `linger.ms=5` can double throughput by dramatically improving batch fill rates.

### buffer.memory

Total memory available to the producer for buffering records. If the producer is producing faster than it can send, calls to `send()` block until space is available or `max.block.ms` expires.

```java
props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67108864L); // 64 MB
props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 60_000L);    // Block up to 60 seconds
```

---

## 5. Compression

Compression reduces network bandwidth and broker storage at the cost of CPU. For JSON-serialized financial events, compression ratios of 5:1 to 10:1 are typical.

```java
props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "snappy");
// Options: none, gzip, snappy, lz4, zstd
```

| Algorithm | CPU Cost  | Compression Ratio | Throughput |
|-----------|-----------|-------------------|------------|
| none      | Zero      | 1:1               | Baseline   |
| gzip      | High      | High              | Lowest     |
| snappy    | Low       | Medium            | High       |
| lz4       | Very Low  | Medium            | Highest    |
| zstd      | Medium    | Highest           | Good       |

**Recommendation for payment systems**: `lz4` for latency-sensitive paths, `zstd` for archival topics where storage matters more than CPU.

```java
// High-throughput payment event producer configuration
@Bean
public ProducerFactory<String, PaymentEvent> paymentProducerFactory() {
    Map<String, Object> props = new HashMap<>();
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaBootstrapServers);
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
    props.put(ProducerConfig.ACKS_CONFIG, "all");
    props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");
    props.put(ProducerConfig.BATCH_SIZE_CONFIG, 65536);
    props.put(ProducerConfig.LINGER_MS_CONFIG, 5);
    props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67108864L);
    props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000);
    props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 30_000);
    return new DefaultKafkaProducerFactory<>(props);
}
```

---

## 6. Message Keys and Ordering Guarantees

Kafka guarantees ordering **within a partition, not across partitions**. The partition assignment of a record is determined by its key.

### Why Keys Matter for Financial Systems

Consider a payment transfer between two accounts. The sequence `DEBIT account A → CREDIT account B` must be processed in order. If these two events land in different partitions, consumers in different threads can process them out of order.

The solution is to use a consistent key that maps semantically related events to the same partition:

```java
// Always use account_id or payment_id as the partition key
ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
    "payment-events",
    payment.getAccountId(),   // KEY: determines partition
    paymentEvent              // VALUE
);
kafkaTemplate.send(record);
```

With this setup, all events for `account_id=ACC-001` land in the same partition, and the consumer processes them in order.

### Key Design Considerations

**High-cardinality keys** (account IDs, payment IDs) distribute well but make global ordering impossible.

**Low-cardinality keys** (payment type, region) can cause partition hot-spots where one partition receives 80% of traffic.

```java
// Anti-pattern: low-cardinality key causes hot partition
ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
    "payment-events",
    payment.getPaymentType(), // BAD: only 5 payment types → 5 hot partitions
    paymentEvent
);

// Better: composite key balances load while maintaining ordering per entity
String compositeKey = payment.getAccountId() + ":" + payment.getRegion();
ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
    "payment-events",
    compositeKey,
    paymentEvent
);
```

---

## 7. Partition Assignment Strategies

### Default Partitioner

The `DefaultPartitioner` uses a murmur2 hash of the key's bytes modulo the number of partitions. This provides good distribution for high-cardinality keys.

```java
// Default behavior — explicit for clarity
props.put(ProducerConfig.PARTITIONER_CLASS_CONFIG, DefaultPartitioner.class);
```

### Sticky Partitioner (Kafka 2.4+)

For records **without keys**, the `UniformStickyPartitioner` batches records to the same partition until the batch is sent, then moves to the next partition. This dramatically improves batching efficiency compared to the old round-robin behavior.

```java
props.put(ProducerConfig.PARTITIONER_CLASS_CONFIG,
    "org.apache.kafka.clients.producer.UniformStickyPartitioner");
```

### Custom Partitioner for Data Residency

For regulatory compliance (data residency), you may need to route events to specific partitions based on jurisdiction:

```java
public class RegionalPartitioner implements Partitioner {

    private static final Map<String, Integer> REGION_PARTITION_BASE = Map.of(
        "EU",   0,   // EU events go to partitions 0-3
        "US",   4,   // US events go to partitions 4-7
        "APAC", 8    // APAC events go to partitions 8-11
    );
    private static final int RANGE_SIZE = 4;

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {
        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);

        if (value instanceof PaymentEvent event) {
            String region = event.getRegion();
            int basePartition = REGION_PARTITION_BASE.getOrDefault(region, 0);
            int keyHash = keyBytes != null ? Math.abs(Arrays.hashCode(keyBytes)) : 0;
            return basePartition + (keyHash % RANGE_SIZE);
        }

        return Math.abs(Arrays.hashCode(keyBytes)) % partitions.size();
    }

    @Override
    public void close() {}

    @Override
    public void configure(Map<String, ?> configs) {}
}
```

---

## 8. Spring Kafka KafkaTemplate

Spring Kafka's `KafkaTemplate` wraps the native producer with Spring-friendly APIs including auto-configuration, transaction support, and observability hooks.

### Basic Setup

```java
@Configuration
public class KafkaProducerConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Bean
    public ProducerFactory<String, PaymentEvent> producerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.LINGER_MS_CONFIG, 5);
        props.put(ProducerConfig.BATCH_SIZE_CONFIG, 65536);
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");
        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    public KafkaTemplate<String, PaymentEvent> kafkaTemplate() {
        return new KafkaTemplate<>(producerFactory());
    }
}
```

### Sending with Callbacks and Observability

```java
@Service
@Slf4j
public class PaymentEventPublisher {

    private static final String PAYMENT_EVENTS_TOPIC = "payment-events";

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;
    private final MeterRegistry meterRegistry;

    public PaymentEventPublisher(KafkaTemplate<String, PaymentEvent> kafkaTemplate,
                                  MeterRegistry meterRegistry) {
        this.kafkaTemplate = kafkaTemplate;
        this.meterRegistry = meterRegistry;
    }

    public CompletableFuture<SendResult<String, PaymentEvent>> publishPaymentEvent(
            PaymentEvent event) {

        ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
            PAYMENT_EVENTS_TOPIC,
            event.getAccountId(),  // partition key — guarantees per-account ordering
            event
        );

        // Propagate distributed tracing context via headers
        record.headers().add("correlation-id",
            event.getCorrelationId().getBytes(StandardCharsets.UTF_8));
        record.headers().add("event-type",
            event.getEventType().name().getBytes(StandardCharsets.UTF_8));
        record.headers().add("producer-timestamp",
            String.valueOf(System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8));

        long startTime = System.currentTimeMillis();

        return kafkaTemplate.send(record)
            .thenApply(result -> {
                long latency = System.currentTimeMillis() - startTime;
                meterRegistry.timer("kafka.producer.publish.latency",
                    "topic", PAYMENT_EVENTS_TOPIC,
                    "event_type", event.getEventType().name()
                ).record(latency, TimeUnit.MILLISECONDS);

                log.debug("Published payment event {} to partition {} offset {}",
                    event.getEventId(),
                    result.getRecordMetadata().partition(),
                    result.getRecordMetadata().offset());
                return result;
            })
            .exceptionally(ex -> {
                meterRegistry.counter("kafka.producer.publish.error",
                    "topic", PAYMENT_EVENTS_TOPIC,
                    "error_type", ex.getClass().getSimpleName()
                ).increment();

                log.error("Failed to publish payment event {}: {}",
                    event.getEventId(), ex.getMessage(), ex);
                throw new PaymentEventPublishException(
                    "Failed to publish event: " + event.getEventId(), ex);
            });
    }
}
```

---

## 9. Transactional Producer

For exactly-once semantics, use the transactional producer API. This is covered in depth in Lesson 5, but the basic pattern is:

```java
@Bean
public ProducerFactory<String, PaymentEvent> transactionalProducerFactory() {
    Map<String, Object> props = new HashMap<>();
    // ... base props ...
    // Transactional ID must be unique and stable per producer instance
    props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-producer-" + instanceId);
    DefaultKafkaProducerFactory<String, PaymentEvent> factory =
        new DefaultKafkaProducerFactory<>(props);
    factory.setTransactionIdPrefix("payment-tx-");
    return factory;
}

@Bean
public KafkaTemplate<String, PaymentEvent> transactionalKafkaTemplate() {
    return new KafkaTemplate<>(transactionalProducerFactory());
}
```

```java
@Service
public class TransactionalPaymentPublisher {

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    public void publishPaymentWithTransaction(PaymentEvent debit, PaymentEvent credit) {
        kafkaTemplate.executeInTransaction(ops -> {
            ops.send("payment-events", debit.getAccountId(), debit);
            ops.send("payment-events", credit.getAccountId(), credit);
            return null; // Both committed atomically, or neither
        });
    }
}
```

---

## 10. Monitoring Producer Metrics

The Kafka producer exposes JMX metrics that are critical for production operations.

### Key Producer Metrics

| Metric                         | Description                            | Alert Threshold          |
|--------------------------------|----------------------------------------|--------------------------|
| `record-send-rate`             | Records sent per second                | Below SLA threshold      |
| `record-error-rate`            | Failed sends per second                | > 0 for financial topics |
| `request-latency-avg`          | Average broker request latency         | > 100ms                  |
| `request-latency-max`          | Maximum broker request latency         | > 500ms                  |
| `batch-size-avg`               | Average batch size in bytes            | Monitor batching health  |
| `records-per-request-avg`      | Average records per request            | Low = poor batching      |
| `buffer-available-bytes`       | Remaining producer buffer              | < 10% triggers alert     |
| `record-queue-time-avg`        | Time spent in record accumulator       | Rising = slow broker     |

### Micrometer Integration

```java
@Configuration
public class KafkaMetricsConfig {

    @Bean
    public MicrometerProducerListener<String, PaymentEvent> producerListener(
            MeterRegistry registry) {
        return new MicrometerProducerListener<>(registry);
    }
}
```

### Custom Producer Interceptor for Observability

```java
public class PaymentProducerInterceptor
        implements ProducerInterceptor<String, PaymentEvent> {

    private static final Logger log =
        LoggerFactory.getLogger(PaymentProducerInterceptor.class);
    private final AtomicLong totalSent = new AtomicLong(0);
    private final AtomicLong totalErrors = new AtomicLong(0);

    @Override
    public ProducerRecord<String, PaymentEvent> onSend(
            ProducerRecord<String, PaymentEvent> record) {
        // Stamp send timestamp for end-to-end latency tracking
        record.headers().add("producer-timestamp",
            String.valueOf(System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8));
        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        if (exception == null) {
            totalSent.incrementAndGet();
        } else {
            totalErrors.incrementAndGet();
            log.error("Producer acknowledgement error: {}", exception.getMessage());
        }
    }

    @Override
    public void close() {
        log.info("Producer closing. Total sent: {}, Total errors: {}",
            totalSent.get(), totalErrors.get());
    }

    @Override
    public void configure(Map<String, ?> configs) {}
}
```

```java
// Register the interceptor
props.put(ProducerConfig.INTERCEPTOR_CLASSES_CONFIG,
    PaymentProducerInterceptor.class.getName());
```

---

## 11. Production Configuration Reference

### Payment Event Producer (High Durability, Moderate Throughput)

```yaml
# application.yml
spring:
  kafka:
    bootstrap-servers: kafka-broker-1:9092,kafka-broker-2:9092,kafka-broker-3:9092
    producer:
      acks: all
      retries: 2147483647
      enable-idempotence: true
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      compression-type: lz4
      batch-size: 65536
      linger-ms: 5
      buffer-memory: 67108864
      max-in-flight-requests-per-connection: 5
      delivery-timeout-ms: 120000
      request-timeout-ms: 30000
      properties:
        max.block.ms: 60000
        metadata.max.age.ms: 300000
```

### Audit Log Producer (Maximum Durability, Low Throughput)

```yaml
spring:
  kafka:
    producer:
      acks: all
      retries: 2147483647
      enable-idempotence: true
      compression-type: zstd
      linger-ms: 0            # No batching delay for audit events
      batch-size: 16384       # Default batch size
```

---

## 12. Common Pitfalls in Financial Kafka Producers

### Pitfall 1: Sharing KafkaTemplate Across Transactions

```java
// WRONG: Sharing a transactional producer across threads causes transaction corruption
@Autowired
private KafkaTemplate<String, PaymentEvent> template;

// ThreadA and ThreadB both call template.send() inside @Transactional methods
// They share the underlying producer, causing transaction interleaving
```

```java
// CORRECT: DefaultKafkaProducerFactory manages a thread-local pool
@Bean
public ProducerFactory<String, PaymentEvent> producerFactory() {
    DefaultKafkaProducerFactory<String, PaymentEvent> factory =
        new DefaultKafkaProducerFactory<>(props);
    factory.setTransactionIdPrefix("payment-tx-");
    return factory;
    // One producer instance per thread — no interleaving
}
```

### Pitfall 2: Blocking send() in a Business Thread

```java
// WRONG: Blocks the calling thread until broker responds
SendResult<String, PaymentEvent> result = kafkaTemplate.send(record).get();
// If broker is slow, your payment API latency spikes

// BETTER: Non-blocking with explicit timeout
CompletableFuture<SendResult<String, PaymentEvent>> future = kafkaTemplate.send(record);
future.orTimeout(5, TimeUnit.SECONDS)
      .exceptionally(ex -> {
          // Handle timeout — circuit breaker, fallback to outbox
          throw new PaymentPublishTimeoutException(ex);
      });
```

### Pitfall 3: Not Handling Buffer Exhaustion

```java
// WRONG: No handling when producer buffer is full
kafkaTemplate.send(topic, key, event); // Silently fails if max.block.ms exceeded

// CORRECT: Handle MaxBlockMsExceededException with outbox fallback
try {
    kafkaTemplate.send(topic, key, event).get(30, TimeUnit.SECONDS);
} catch (ExecutionException e) {
    if (e.getCause() instanceof BufferExhaustedException) {
        // Producer buffer full — broker unreachable or producing too fast
        outboxRepository.save(toOutboxEntry(event));
        log.warn("Kafka buffer exhausted, wrote to outbox: {}", event.getEventId());
    }
}
```

### Pitfall 4: Inconsistent Partition Keys for the Same Entity

```java
// WRONG: Same account uses different key formats in different services
// Service A: key = "ACC-001"
// Service B: key = "account-ACC-001"
// These land in DIFFERENT partitions — ordering guarantee broken

// CORRECT: Centralize key normalization
public class KafkaKeyNormalizer {
    public static String forAccount(String rawAccountId) {
        // Strip all prefixes, normalize to canonical form
        return rawAccountId.replaceAll("^(account-|acct-)", "").toUpperCase();
    }
}
```

---

## 13. Testing Producer Configuration

```java
@SpringBootTest
@EmbeddedKafka(
    partitions = 12,
    topics = {"payment-events"},
    brokerProperties = {
        "transaction.state.log.replication.factor=1",
        "transaction.state.log.min.isr=1"
    }
)
class PaymentEventPublisherTest {

    @Autowired
    private PaymentEventPublisher publisher;

    @Autowired
    private EmbeddedKafkaBroker embeddedKafka;

    private KafkaConsumer<String, String> testConsumer;

    @BeforeEach
    void setup() {
        Map<String, Object> consumerProps = KafkaTestUtils.consumerProps(
            "test-consumer", "true", embeddedKafka);
        consumerProps.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        testConsumer = new KafkaConsumer<>(consumerProps,
            new StringDeserializer(), new StringDeserializer());
        testConsumer.subscribe(List.of("payment-events"));
    }

    @Test
    void shouldPublishPaymentEventToCorrectPartition() throws Exception {
        PaymentEvent event = PaymentEvent.builder()
            .eventId(UUID.randomUUID().toString())
            .accountId("ACC-001")
            .amount(new BigDecimal("500.00"))
            .eventType(PaymentEventType.PAYMENT_INITIATED)
            .correlationId(UUID.randomUUID().toString())
            .build();

        publisher.publishPaymentEvent(event).get(10, TimeUnit.SECONDS);

        ConsumerRecords<String, String> records =
            KafkaTestUtils.getRecords(testConsumer, Duration.ofSeconds(5));

        assertThat(records.count()).isEqualTo(1);
        ConsumerRecord<String, String> received = records.iterator().next();
        assertThat(received.key()).isEqualTo("ACC-001");
    }

    @Test
    void shouldMaintainOrderingForSameAccount() throws Exception {
        String accountId = "ACC-002";
        List<PaymentEvent> events = IntStream.range(0, 10)
            .mapToObj(i -> PaymentEvent.builder()
                .eventId("EVT-" + i)
                .accountId(accountId)
                .sequenceNumber(i)
                .correlationId(UUID.randomUUID().toString())
                .build())
            .collect(Collectors.toList());

        for (PaymentEvent event : events) {
            publisher.publishPaymentEvent(event).get(10, TimeUnit.SECONDS);
        }

        ConsumerRecords<String, String> records =
            KafkaTestUtils.getRecords(testConsumer, Duration.ofSeconds(10));

        // All events for the same account must be in the same partition
        Set<Integer> partitions = new HashSet<>();
        records.forEach(r -> partitions.add(r.partition()));
        assertThat(partitions).hasSize(1); // All in same partition
        assertThat(records.count()).isEqualTo(10);
    }
}
```

---

## Summary

| Configuration                     | Financial System Value                              |
|-----------------------------------|-----------------------------------------------------|
| `acks=all`                        | No data loss if any single broker fails             |
| `enable.idempotence=true`         | No duplicate events from retries                    |
| `linger.ms=5`                     | 2-5x throughput improvement at cost of 5ms latency  |
| `batch.size=65536`                | Efficient batching for high-volume payment events   |
| `compression.type=lz4`            | 50-80% bandwidth reduction with minimal CPU cost    |
| Account ID as key                 | Ordering guarantee for all events within an account |
| `max.in.flight=5`                 | Optimal pipeline depth compatible with idempotence  |
| `delivery.timeout.ms=120000`      | Total retry budget before giving up                 |

The Kafka producer is a sophisticated pipeline. In financial systems, treat it like any other critical infrastructure component: configure it explicitly, monitor it comprehensively, and test failure modes before they occur in production.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment producer is configured with acks=1. The leader broker acknowledges the write, but then immediately crashes before replication. What is the outcome?",
      "options": [
        "The message is safe — the follower will promote and retain it",
        "The message is lost — acks=1 only waits for the leader, not followers",
        "The producer will automatically retry and re-deliver the message",
        "Kafka's replication factor prevents any data loss regardless of acks setting"
      ],
      "correct": 1,
      "explanation": "acks=1 means the producer considers the write successful after the leader acknowledges it, without waiting for follower replication. If the leader crashes before replication completes, the message is lost. For financial systems, acks=all (or acks=-1) combined with min.insync.replicas=2 is required to guarantee durability."
    },
    {
      "text": "With enable.idempotence=true, a producer sends a message, times out waiting for the acknowledgement, and retries. What prevents a duplicate record in the topic?",
      "options": [
        "The broker checks the message payload hash to detect duplicates",
        "The producer uses a Producer ID (PID) and monotonic sequence number; the broker rejects records with a sequence it has already seen",
        "The producer pauses and waits for the consumer to acknowledge before retrying",
        "Kafka uses distributed locking to prevent concurrent writes for the same key"
      ],
      "correct": 1,
      "explanation": "The idempotent producer assigns a unique Producer ID (PID) to each producer instance and attaches a monotonically increasing sequence number to every record. Brokers track the highest sequence seen per PID per partition and silently discard duplicates. This is transparent to the application and adds negligible overhead."
    },
    {
      "text": "You set linger.ms=50 and batch.size=65536 on a high-throughput payment producer. Under heavy load, which statement best describes the batching behaviour?",
      "options": [
        "Records are sent immediately when batch.size is reached, or after 50 ms if the batch is not full — whichever comes first",
        "Records are always held for exactly 50 ms before sending, regardless of batch size",
        "batch.size is ignored when linger.ms is set; only the timer governs dispatch",
        "The producer waits until both conditions are true: batch is full AND 50 ms has elapsed"
      ],
      "correct": 0,
      "explanation": "linger.ms and batch.size are both triggers — whichever fires first causes the batch to be sent. Under heavy load the batch fills quickly and is sent before the linger timeout, giving high throughput. Under low load, linger.ms ensures messages are not held indefinitely. The two settings work together, not in sequence."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Production-Grade Kafka Producer for Payment Events",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    "Configure a KafkaProducer with acks=all, enable.idempotence=true, max.in.flight.requests.per.connection=5, min.insync.replicas=2, and lz4 compression. Write a unit test that verifies the producer configuration values are set correctly before the producer is constructed.",
    "Implement a PaymentEventPublisher that uses accountId as the partition key and attaches a UUID message key header for idempotency tracking. Add structured logging of the partition and offset returned in the RecordMetadata callback.",
    "Simulate a retriable error (LEADER_NOT_AVAILABLE) and a non-retriable error (INVALID_TOPIC_EXCEPTION) in a test using MockProducer. Verify that the retriable error is retried up to retries=3 and the non-retriable error is surfaced immediately without retry.",
    "Build a producer monitoring component that exposes record-send-rate, record-error-rate, and request-latency-avg as Prometheus gauges using Micrometer. Write an integration test that publishes 1000 messages and asserts that error-rate remains zero and p99 latency stays below 100 ms."
  ]
}
-->

**Next lesson**: Kafka Consumer — Offset Management and Rebalancing
