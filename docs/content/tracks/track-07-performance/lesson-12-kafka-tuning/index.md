---
id: track-07-lesson-12
title: "Kafka Producer Tuning — Throughput, Latency, and Financial Durability"
slug: kafka-tuning
track: track-07
trackName: Performance Engineering & JVM Internals
sequence: 12
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, producer-tuning, batching, compression, linger]
prerequisites: [track-07-lesson-01]
---

# Kafka Producer Tuning — Throughput, Latency, and Financial Durability

> [!NOTE]
> Kafka producer configuration has a direct impact on throughput, end-to-end latency, and message durability. Since Kafka 3.0 the producer defaults are durable (`acks=all`, `enable.idempotence=true`), but they are not tuned for throughput, and many systems still run older clients or override the defaults. For financial systems, set every durability-related value explicitly and tune batching for your workload.

## Learning Objectives

By the end of this lesson you will be able to:

1. Explain the throughput vs latency trade-off controlled by `linger.ms` and `batch.size`
2. Select the correct compression codec for financial message payloads
3. Configure `acks=all` with idempotent producers for financial-grade durability
4. Set `max.in.flight.requests.per.connection` correctly with idempotence enabled
5. Size `buffer.memory` and `max.block.ms` to handle backpressure without silent data loss
6. Configure `retries` and `delivery.timeout.ms` to prevent message loss on transient failures
7. Use `RecordMetadata` to confirm that a message has been accepted by the broker
8. Apply consumer-side tuning with `fetch.min.bytes` and `max.poll.records`

## Business Context

*Composite example:* a payment processor's producers ran with `acks=1` — the default for Kafka clients before 3.0, and still a common "performance" override. The broker acknowledged messages after only the leader replica had written them. When a broker failed mid-replication, several hundred payment events were lost: the leader had acknowledged them, but the followers had not yet received them. The lost events were payment confirmation callbacks that downstream settlement services never received. Reconciliation caught the discrepancy many hours later, after a large accounting imbalance and a long incident. The fix was a configuration change: `acks=all` (with `min.insync.replicas=2`). The lesson: check what your producers actually run with — never assume the defaults.

---

## Throughput vs Latency — The Fundamental Trade-off

Kafka producers do not send each message individually by default. They batch messages together before transmitting to the broker, which dramatically improves throughput at the cost of added latency per message.

```mermaid
sequenceDiagram
    participant App as Application Thread
    participant Acc as RecordAccumulator
    participant Sender as Sender Thread
    participant Broker as Kafka Broker

    App->>Acc: send(record1) → partition 0 batch
    App->>Acc: send(record2) → partition 0 batch
    App->>Acc: send(record3) → partition 0 batch
    Note over Acc: linger.ms timer starts on first record
    App->>Acc: send(record4) → partition 0 batch
    Note over Acc: batch.size reached OR linger.ms expired
    Acc->>Sender: flush batch (4 records)
    Sender->>Broker: ProduceRequest (4 records compressed)
    Broker-->>Sender: ProduceResponse (offsets)
    Sender-->>App: Future<RecordMetadata> resolved
```

**`linger.ms`** — How long the producer waits to accumulate records before sending a batch. The default was `0` (send immediately — maximum latency predictability, minimum throughput) and is `5` since Kafka 4.0 (KIP-1030). Setting `linger.ms=5` tells the producer to wait up to 5ms for more records to arrive, filling the batch before transmission.

**`batch.size`** — Maximum byte size of a single batch per partition. Default is `16384` (16KB). The batch is sent as soon as it reaches this size, regardless of `linger.ms`. Increasing to `65536` (64KB) or `131072` (128KB) improves throughput for high-volume payment event streams.

```java
// Low-latency configuration — payment authorisation confirmations
// Latency matters: each ms adds to SLO
Properties lowLatency = new Properties();
lowLatency.put(ProducerConfig.LINGER_MS_CONFIG, 0);           // Send immediately
lowLatency.put(ProducerConfig.BATCH_SIZE_CONFIG, 16_384);     // 16KB batch
lowLatency.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4"); // Fast compression

// High-throughput configuration — payment event log, audit trail
// Throughput matters: millions of events/second
Properties highThroughput = new Properties();
highThroughput.put(ProducerConfig.LINGER_MS_CONFIG, 10);        // Wait 10ms
highThroughput.put(ProducerConfig.BATCH_SIZE_CONFIG, 131_072);  // 128KB batch
highThroughput.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "zstd"); // Best ratio
```

---

## Compression — Codec Selection for Financial Payloads

Kafka supports four compression codecs. For financial message payloads (JSON payment events, Avro-encoded transactions), compression reduces network bandwidth and broker disk usage by 60-80%.

| Codec | Compression Ratio | CPU Cost | Best For |
|---|---|---|---|
| `none` | 1.0x | None | Debugging only |
| `gzip` | 2.5-3.5x | High | Low-volume, archival |
| `snappy` | 1.8-2.5x | Low | Balanced default |
| `lz4` | 1.6-2.2x | Very low | Latency-sensitive |
| `zstd` | 2.8-4.0x | Medium | High-volume audit logs |

For payment event streams where message bodies are JSON-encoded `PaymentEvent` objects (~500 bytes each), `lz4` delivers a 40% reduction in network bytes with negligible CPU overhead on modern hardware. For high-volume audit logs where batches contain thousands of structurally similar events, `zstd` achieves 70-80% compression.

```java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, PaymentEvent> paymentEventProducerFactory(
            @Value("${kafka.bootstrap-servers}") String bootstrapServers) {
        Map<String, Object> config = new HashMap<>();

        // "${...}" inside a Java string is NOT resolved -- inject the value
        config.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        config.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        config.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);

        // Compression — lz4 for latency-sensitive payment events
        config.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");

        // Batching — tuned for payment volumes (~50K TPS)
        config.put(ProducerConfig.LINGER_MS_CONFIG, 5);
        config.put(ProducerConfig.BATCH_SIZE_CONFIG, 65_536);  // 64KB

        // Durability — financial grade
        config.put(ProducerConfig.ACKS_CONFIG, "all");
        config.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        config.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);

        // Reliability
        config.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        config.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000); // 2 minutes

        // Buffer sizing
        config.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67_108_864L); // 64MB
        config.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 60_000);       // 1 minute block

        return new DefaultKafkaProducerFactory<>(config);
    }
}
```

---

## Financial Durability — acks, Idempotence, and In-Flight Requests

For financial data, three configuration parameters must be set together. Setting any one without the others leaves a gap.

**`acks=all`** — The broker only acknowledges a produce request after all in-sync replicas (ISR) have written the message. This ensures that if the leader fails, a follower that becomes the new leader already has the message.

```java
// WRONG — acks=1 means only leader persists before ack
// A leader failure before replication = message loss
config.put(ProducerConfig.ACKS_CONFIG, "1");  // DO NOT USE for financial data

// CORRECT — acks=all waits for all ISR replicas
config.put(ProducerConfig.ACKS_CONFIG, "all");
// Also set min.insync.replicas=2 on the topic (with replication factor 3):
// kafka-configs.sh --bootstrap-server broker:9092 --alter \
//   --entity-type topics --entity-name payment-events \
//   --add-config min.insync.replicas=2
```

**`enable.idempotence=true`** — Without idempotence, a network timeout during a produce request can cause the producer to retry and the broker to write the message twice. For payment events this means duplicate processing. Idempotence assigns a producer ID and sequence number to each record, allowing the broker to detect and discard duplicates.

**`max.in.flight.requests.per.connection`** — With idempotence enabled, this can be up to 5 (Kafka 1.1+). Without idempotence, setting it above 1 risks message reordering when retries occur. The combination of `enable.idempotence=true` and `max.in.flight.requests.per.connection=5` means producer retries cause no duplicates and no reordering within a partition, while keeping the pipeline full. It is not end-to-end exactly-once: a restarted producer gets a new ID, and consumers can still process a record twice, so consumers must be idempotent too (or use Kafka transactions for read-process-write flows).

```java
// The three-way configuration that provides financial-grade producer guarantees
config.put(ProducerConfig.ACKS_CONFIG, "all");
config.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
config.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
// Together: no loss once acknowledged + no duplicates from retries, per partition
// (Since Kafka 3.0 these are the defaults -- set them explicitly anyway)
```

> [!WARNING]
> `enable.idempotence=true` requires `acks=all`. If you explicitly set `enable.idempotence=true` with `acks=1` or `acks=0`, the producer throws a `ConfigException` at start-up. (If you only set `acks=1` and leave idempotence at its default, Kafka 3.x silently turns idempotence off.) These settings must be used together.

---

## Buffer Memory and Backpressure

`buffer.memory` controls the total bytes of memory the producer uses for buffering records waiting to be sent. When the buffer is full, `send()` blocks the calling thread for up to `max.block.ms`; after that the send fails with a `BufferExhaustedException` (a `TimeoutException`), reported through the returned future and callback.

```java
// Default buffer.memory is 32MB — often too small for high-volume payment processors
// A payment processor at 50K TPS with 500-byte messages produces 25MB/s
// If the broker is slow (GC pause, network hiccup), buffer fills in ~1 second

config.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 134_217_728L); // 128MB
config.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 30_000);        // 30 seconds

// Handle send failures explicitly — do NOT silently drop payments.
// (The most robust design is the transactional outbox from track 05: write the
//  event in the SAME database transaction as the payment and relay it to Kafka
//  afterwards, so no event depends on the producer buffer at all.)
KafkaTemplate<String, PaymentEvent> kafkaTemplate = new KafkaTemplate<>(producerFactory);
kafkaTemplate.setProducerListener(new ProducerListener<>() {
    @Override
    public void onError(ProducerRecord<String, PaymentEvent> record,
                        RecordMetadata metadata,
                        Exception exception) {
        // Called for ANY send failure (buffer full, delivery timeout, ...).
        // CRITICAL: a payment event that could not be sent must be persisted elsewhere
        // Options: write to outbox table, circuit break the payment, alert on-call
        log.error("Failed to buffer payment event: {}", record.value().getPaymentId(), exception);
        outboxService.persistForRetry(record.value());
        alertingService.notify(AlertLevel.P2, "Kafka producer buffer full — payment events queued to outbox");
    }
});
```

---

## Retries and Delivery Timeout

`retries` controls how many times the producer retries a failed send. `delivery.timeout.ms` is the upper bound on total time from `send()` to either acknowledgement or terminal failure — it encompasses all retries, waits, and in-flight time.

```java
// Set retries to Integer.MAX_VALUE and control total retry window via delivery.timeout.ms
// This is the Kafka-recommended approach since version 2.1
config.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
config.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000); // 2-minute delivery window
config.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 30_000);   // 30s per request attempt
config.put(ProducerConfig.RETRY_BACKOFF_MS_CONFIG, 100);        // 100ms between retries

// Using RecordMetadata for explicit confirmation
public CompletableFuture<PaymentConfirmation> sendPaymentEvent(PaymentEvent event) {
    ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
        "payment-events",
        event.getAccountId().toString(),  // partition key — same account → same partition → ordered
        event
    );

    return kafkaTemplate.send(record)
        .thenApply(result -> {
            RecordMetadata metadata = result.getRecordMetadata();
            log.debug("Payment event confirmed: topic={} partition={} offset={}",
                metadata.topic(), metadata.partition(), metadata.offset());
            return new PaymentConfirmation(
                event.getPaymentId(),
                metadata.topic(),
                metadata.partition(),
                metadata.offset(),
                Instant.ofEpochMilli(metadata.timestamp())
            );
        })
        .exceptionally(ex -> {
            log.error("Payment event delivery failed after retries: paymentId={}",
                event.getPaymentId(), ex);
            // Terminal failure — escalate to outbox/DLT.
            // Careful: a delivery timeout does NOT prove the broker never wrote
            // the record. Re-sending from the outbox can create a duplicate,
            // so consumers must de-duplicate (e.g. by paymentId).
            throw new PaymentEventDeliveryException(event.getPaymentId(), ex);
        });
}
```

---

## Consumer-Side Tuning

Producer tuning must be complemented by consumer tuning. A well-tuned producer that creates large batches will be bottlenecked by a consumer fetching one record at a time.

```java
@Bean
public ConsumerFactory<String, PaymentEvent> paymentEventConsumerFactory(
        @Value("${kafka.bootstrap-servers}") String bootstrapServers) {
    Map<String, Object> config = new HashMap<>();

    config.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
    config.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-processor-group");
    config.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
    config.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, JsonDeserializer.class);
    config.put(JsonDeserializer.TRUSTED_PACKAGES, "com.example.payments.events");

    // If producers use Kafka transactions, read only committed records
    config.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");

    // Fetch tuning — wait until at least 1KB is available before returning
    // Reduces fetch request count under light load
    config.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, 1_024);        // 1KB minimum
    config.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, 500);        // Wait up to 500ms
    config.put(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, 1_048_576); // 1MB per partition

    // Batch size — process up to 500 records per poll
    // Tune based on processing time: max.poll.interval.ms must exceed batch processing time
    config.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 500);
    config.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 300_000); // 5 minutes

    // Offset management — manual commit for financial data
    // Auto-commit can mark messages as processed before your code actually processes them
    config.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);

    return new DefaultKafkaConsumerFactory<>(config);
}
```

> [!TIP]
> For financial consumers, disable Kafka's auto-commit (`ENABLE_AUTO_COMMIT_CONFIG=false`) and let the listener container commit — its default `AckMode.BATCH` commits after your listener returns, or use `MANUAL` / `MANUAL_IMMEDIATE` to commit yourself. Auto-commit commits on a timer, not on successful processing: if work is handed to other threads, offsets can be committed for records that were never processed, and a crash then loses them. Commit only after your business logic has completed — and make processing idempotent, because after a crash some records will be delivered again.

---

## Benchmarking Results — Default vs Tuned

Illustrative results for a 3-broker cluster with payment event messages of about 480 bytes. Your numbers will differ — always measure on your own hardware and payloads.

| Configuration | Throughput (msg/s) | P99 Produce Latency | P99.9 Produce Latency | Compression Ratio |
|---|---|---|---|---|
| Default (`acks=1`, `linger=0`, `batch=16KB`, none) | 42,000 | 12ms | 48ms | 1.0x |
| `acks=all`, idempotent, `linger=0`, none | 31,000 | 18ms | 65ms | 1.0x |
| `acks=all`, idempotent, `linger=5ms`, lz4 | 78,000 | 22ms | 55ms | 1.6x |
| `acks=all`, idempotent, `linger=10ms`, zstd, 128KB batch | 124,000 | 28ms | 70ms | 2.9x |

In this example the tuned configuration delivers about 3x the throughput of the old defaults while keeping the durability guarantees. The extra ~10ms of P99 latency from batching is negligible for most financial event processing — only a few paths, such as authorisation confirmations, need very low Kafka produce latency.

---

## Knowledge Check

**Q1: Your payment event producer is configured with `acks=1`, `enable.idempotence=false`, and `max.in.flight.requests.per.connection=5`. A broker leader fails during replication. What is the worst-case outcome?**

**A:** With `acks=1`, the leader acknowledges messages before replication completes. When the leader fails, messages that were acknowledged but not yet replicated to ISR followers are permanently lost. The new leader (a former follower) does not have those messages. For a payment event stream this means lost payment events that settlement services never receive, requiring manual reconciliation. The fix is `acks=all` with `min.insync.replicas=2` on the topic.

**Q2: You increase `batch.size` from 16KB to 128KB on a payment event producer. Throughput increases significantly but P99 latency increases from 15ms to 85ms. What is causing the latency increase and how do you fix it?**

**A:** `batch.size` alone does not delay sending: with `linger.ms=0` a batch is sent as soon as the sender is free. The usual cause is a non-zero `linger.ms` (explicitly set, or the default of 5 ms since Kafka 4.0, or a larger value): with a bigger `batch.size` the batch is full less often, so more records wait for the whole linger time. Larger requests also take longer to send and replicate, and if `buffer.memory` fills up, `send()` itself starts blocking. Check `linger.ms`, the producer metrics `record-queue-time-avg/max` and `bufferpool-wait-time`, and keep `linger.ms` small (1–5 ms) relative to the SLO — for payment events, `batch.size=64KB` with `linger.ms=5` is a balanced starting point.

---

## Practical Challenge

**Scenario:** You are optimising a Kafka-based payment event pipeline that currently runs at 28,000 messages/second (target: 100,000 msg/s) with P99 latency of 95ms (SLO: 50ms). The producer uses default configuration except `acks=all`.

**Tasks:**

1. **Configuration audit**: list all default producer configuration values that are likely bottlenecking throughput at 28K msg/s. For each, propose the tuned value and explain the expected impact.

2. **Idempotence setup**: write the complete producer configuration (as a Java `Map<String, Object>`) for a financial-grade idempotent producer that achieves >80K msg/s with P99 latency <50ms. Include a comment justifying each non-default setting.

3. **Consumer implementation**: write a Spring Kafka `@KafkaListener` method that processes a batch of `PaymentEvent` records with manual offset commit. The method must: (a) process all records in the batch, (b) commit offsets only on full batch success, (c) handle individual record processing failures without losing other records in the batch, and (d) publish a dead-letter record for permanently failed events.

4. **Backpressure test**: write a JUnit integration test using an embedded Kafka broker that demonstrates `BufferExhaustedException` when the producer buffer is full. Configure the test with `buffer.memory=16384` (16KB), send 1,000 records, and assert that records are redirected to the outbox table when the buffer is exhausted.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment event producer uses acks=1, enable.idempotence=false, and max.in.flight.requests.per.connection=5. A broker leader fails during replication. What is the worst-case outcome?",
      "options": [
        "The producer retries and all messages are delivered exactly once",
        "Messages acknowledged by the failed leader but not yet replicated to ISR followers are permanently lost, requiring manual reconciliation",
        "The producer automatically switches to acks=all on leader failure",
        "Only messages in the current batch are lost; previously sent messages are safe"
      ],
      "correct": 1,
      "explanation": "With acks=1, the leader acknowledges messages before they are replicated. When the leader fails, the new leader (a former follower) may not have the acknowledged messages. These are permanently lost. For payment events, this means settlement services never receive those events. Fix: use acks=all with min.insync.replicas=2 and enable.idempotence=true."
    },
    {
      "text": "Why does increasing batch.size from 16KB to 128KB cause P99 latency to increase from 15ms to 85ms in some configurations?",
      "options": [
        "Larger batches cause the Kafka broker to hold the message longer before committing to disk",
        "With a larger batch size, partially-filled batches wait longer to accumulate enough data before being sent, especially if linger.ms is non-zero; the latency increase indicates linger.ms is causing batches to wait",
        "Larger batches require more compression CPU time, increasing producer latency linearly",
        "128KB batches exceed Kafka's max.message.bytes default and are silently rejected and retried"
      ],
      "correct": 1,
      "explanation": "batch.size alone does not add latency — the producer sends as soon as a batch is full or the sender is free. If latency increased significantly, linger.ms is above 0 (explicitly, or the 5 ms default since Kafka 4.0), so records wait for linger.ms. With a larger batch.size the batch fills less often, and linger.ms becomes the dominant latency factor. The fix is to keep linger.ms small (1-5ms) relative to the SLO."
    },
    {
      "text": "What is the purpose of enable.idempotence=true in a financial Kafka producer, and what configuration constraint does it impose?",
      "options": [
        "It prevents duplicate consumers by tracking consumer group offsets",
        "It prevents duplicates and reordering caused by producer retries by giving each producer a PID and per-partition sequence numbers; it requires acks=all and max.in.flight.requests.per.connection <= 5",
        "It enables Kafka transactions for atomic multi-topic writes",
        "It is a no-op in Kafka 3.x where idempotence is always enabled by default"
      ],
      "correct": 1,
      "explanation": "enable.idempotence=true gives the producer a Producer ID (PID) and numbers each record per partition. The broker uses the sequence numbers to discard duplicates and reject out-of-order batches caused by retries. It requires acks=all (so an acknowledged write cannot be lost on a leader change, which would break the sequence) and max.in.flight.requests.per.connection <= 5 (the number of batches the broker tracks per producer). It has been the default since Kafka 3.0. It is not end-to-end exactly-once: consumers must still be idempotent, or use transactions."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Kafka Producer Tuning for 100K Message/Second Payment Event Pipeline",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write the complete producer configuration Map<String, Object> for a financial-grade idempotent producer targeting >80K msg/s with P99 latency <50ms, with a comment justifying each non-default setting."},
    {"id": "2", "description": "Implement a Spring Kafka @KafkaListener method that processes a batch of PaymentEvent records with manual offset commit, handling individual record failures without losing other records in the batch, and publishing dead-letter records for permanently failed events."},
    {"id": "3", "description": "Write an outbox pattern fallback that redirects payment events to a PostgreSQL outbox table when Kafka's producer buffer is exhausted (BufferExhaustedException), with a background poller that retries outbox entries."},
    {"id": "4", "description": "Write a JUnit integration test using an embedded Kafka broker that verifies: idempotent delivery (send same event twice, assert consumer receives it once), and buffer exhaustion fallback to outbox when buffer.memory=16384."}
  ]
}
-->

