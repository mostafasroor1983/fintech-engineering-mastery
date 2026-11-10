---
id: track-11-lesson-05
title: "Exactly-Once Semantics — Transactions in Kafka"
slug: kafka-exactly-once
track: track-11
trackName: "Messaging & Event Streaming"
sequence: 5
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [exactly-once, idempotent-producer, kafka-transactions, EOS, deduplication]
prerequisites: [track-11-lesson-04]
---

# Exactly-Once Semantics — Transactions in Kafka

> [!NOTE]
> Duplicate payment events are a critical failure mode: a customer charged twice, a transfer executed twice, or a fraud signal counted twice. Kafka's exactly-once semantics (EOS) eliminate duplicates within the Kafka ecosystem through two mechanisms: idempotent producers and transactional producers. This lesson covers both mechanisms, their configuration, their limits, and how to build a consumer-side deduplication table as an independent safety net.

## Delivery Guarantee Comparison

Three delivery guarantees exist in distributed messaging:

```
At-Most-Once:
  Producer sends, broker may or may not ack.
  On timeout, producer does NOT retry.
  Result: messages may be LOST.
  Use when: loss is acceptable (metrics, non-critical logs).

At-Least-Once:
  Producer retries on failure. Broker may receive duplicate.
  Consumer processes every message, possibly multiple times.
  Result: messages are NOT lost but may be DUPLICATED.
  Use when: idempotent consumers handle duplicates downstream.

Exactly-Once:
  Each message is delivered and processed exactly once.
  Result: no loss, no duplicates — within the Kafka cluster.
  Use when: financial transactions, payment processing, ledger updates.
```

| Guarantee | Loss Risk | Duplicate Risk | Latency | Throughput |
|-----------|-----------|---------------|---------|------------|
| At-most-once | High | None | Lowest | Highest |
| At-least-once | None | High | Medium | Medium |
| Exactly-once | None | None | +3-5% | -3-5% |

---

## Idempotent Producer

The idempotent producer prevents duplicates caused by **producer retries**. When a network timeout occurs, the producer retries and may send the same message twice. Without idempotence, the broker accepts both. With idempotence, the broker deduplicates.

### How It Works

Each producer is assigned a **Producer ID (PID)** and maintains a **sequence number** per partition. The broker tracks the last sequence number per (PID, partition) pair and rejects duplicates.

```
Producer (PID=42)
  │── send(msg, seq=0) → Broker receives, stores
  │── TIMEOUT — did broker get it?
  │── send(msg, seq=0) → Broker rejects (DuplicateSequenceException, internally silent)
  │── Broker ACKs the first delivery
```

### Configuration

```java
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.KafkaProducer;
import java.util.Properties;

public class IdempotentProducerFactory {

    public static KafkaProducer<String, String> create(String bootstrapServers) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");

        // Enable idempotence — prevents duplicate sends from retries
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);

        // Required by idempotence: acks=all ensures all replicas confirm
        props.put(ProducerConfig.ACKS_CONFIG, "all");

        // Required by idempotence: max in-flight requests per connection <= 5
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);

        // Required by idempotence: retries must be > 0
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);

        return new KafkaProducer<>(props);
    }
}
```

> **Important:** `enable.idempotence=true` only prevents duplicates within a single producer session. If the producer process restarts with a new PID, sequence numbers reset and the broker cannot detect cross-session duplicates.

---

## Transactional Producer

The transactional producer extends idempotence to provide **atomic writes across multiple partitions and topics**. All records in a transaction are either all visible or none visible to `read_committed` consumers.

### Transaction Lifecycle

```
initTransactions()          — Register with Transaction Coordinator, get epoch
beginTransaction()          — Start a transaction fence (epoch++)
  send(record1)             — Buffered in transaction
  send(record2)             — Buffered in transaction
  sendOffsetsToTransaction() — Atomically commit consumer offsets with the records
commitTransaction()         — Make all records visible atomically
  OR
abortTransaction()          — Discard all buffered records
```

### Full Transactional Producer Implementation

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.springframework.stereotype.Service;
import java.util.Map;
import java.util.Properties;

@Service
public class TransactionalPaymentProducer {

    private final KafkaProducer<String, String> producer;
    private final String transactionalId;

    public TransactionalPaymentProducer(String bootstrapServers, String instanceId) {
        this.transactionalId = "payment-processor-" + instanceId;

        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");

        // Enable idempotence (required for transactions)
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);

        // Transactional ID — must be unique per producer instance
        // Kafka uses this to fence zombie producers from previous epochs
        props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, this.transactionalId);

        // Transaction timeout — abort if commit/abort not called within this window
        props.put(ProducerConfig.TRANSACTION_TIMEOUT_CONFIG, 60_000); // 60 seconds

        this.producer = new KafkaProducer<>(props);

        // Must be called once before any transactions — registers with coordinator
        this.producer.initTransactions();
    }

    /**
     * Read-Process-Write: consume from payments.raw, produce to payments.enriched.
     * Consumer offsets and produced records are committed atomically.
     */
    public void processPaymentAtomically(
            ConsumerRecord<String, String> rawRecord,
            String enrichedPayload,
            String consumerGroupId,
            Map<TopicPartition, OffsetAndMetadata> offsetsToCommit) {

        producer.beginTransaction();
        try {
            // Produce to output topic
            ProducerRecord<String, String> enriched = new ProducerRecord<>(
                    "payments.enriched",
                    rawRecord.partition(),  // Same partition for ordering
                    rawRecord.key(),
                    enrichedPayload
            );
            producer.send(enriched);

            // Atomically commit the consumed offset as part of the transaction.
            // If the transaction aborts, the consumer will re-read this record.
            producer.sendOffsetsToTransaction(offsetsToCommit,
                    new ConsumerGroupMetadata(consumerGroupId));

            producer.commitTransaction();

        } catch (ProducerFencedException | OutOfOrderSequenceException e) {
            // Fatal — this producer instance has been fenced.
            // A new producer with the same transactional.id has taken over.
            // Shut down this instance immediately — do not retry.
            log.error("Producer fenced — shutting down transactionalId={}", transactionalId, e);
            producer.close();
            throw new FatalProducerException("Producer fenced", e);

        } catch (KafkaException e) {
            // Transient error — abort and allow retry
            producer.abortTransaction();
            throw new RetryableProcessingException("Transaction aborted — will retry", e);
        }
    }
}
```

### Zombie Fencing

When a producer crashes and a new instance starts with the same `transactional.id`, Kafka increments the **epoch**. The old producer (zombie) is fenced — any `commitTransaction()` from the old epoch returns `ProducerFencedException`.

```
Instance A (epoch=1):  beginTransaction()... process... CRASH
Instance B (epoch=2):  initTransactions() → epoch bumped to 2
                        beginTransaction()... process... commitTransaction() ✓
Instance A (zombie):   tries commitTransaction(epoch=1) → ProducerFencedException ✗
```

---

## `read_committed` Consumer Isolation

A consumer with the default `isolation.level=read_uncommitted` sees all records, including those from aborted transactions. Use `read_committed` to only see committed records.

```java
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.consumer.ConsumerConfig;

Properties consumerProps = new Properties();
consumerProps.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
consumerProps.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-enrichment-consumer");
consumerProps.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
        "org.apache.kafka.common.serialization.StringDeserializer");
consumerProps.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
        "org.apache.kafka.common.serialization.StringDeserializer");

// CRITICAL: only see committed records — ignore in-flight and aborted transactions
consumerProps.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");

// Do NOT auto-commit — use sendOffsetsToTransaction for atomic offset management
consumerProps.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(consumerProps);
```

---

## Spring Kafka `KafkaTransactionManager`

Spring Kafka integrates transactions with `@Transactional` through `KafkaTransactionManager`.

```java
import org.springframework.kafka.transaction.KafkaTransactionManager;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class KafkaTransactionConfig {

    @Bean
    public ProducerFactory<String, String> transactionalProducerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "${kafka.bootstrap-servers}");
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-svc-${spring.application.name}");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);

        DefaultKafkaProducerFactory<String, String> factory =
                new DefaultKafkaProducerFactory<>(props);
        factory.setTransactionIdPrefix("payment-svc-");
        return factory;
    }

    @Bean
    public KafkaTransactionManager<String, String> kafkaTransactionManager(
            ProducerFactory<String, String> producerFactory) {
        return new KafkaTransactionManager<>(producerFactory);
    }
}

@Service
@Slf4j
public class PaymentEnrichmentService {

    @Autowired private KafkaTemplate<String, String> kafkaTemplate;
    @Autowired private PaymentEnricher enricher;

    // Spring @Transactional wraps the method in a Kafka transaction
    @Transactional("kafkaTransactionManager")
    public void enrichAndPublish(String paymentId, String rawPayload) {
        String enriched = enricher.enrich(rawPayload);

        kafkaTemplate.send("payments.enriched", paymentId, enriched);
        kafkaTemplate.send("payments.audit", paymentId, buildAuditRecord(rawPayload, enriched));

        // Both sends are committed atomically when the method returns.
        // If an exception is thrown, both are aborted.
        log.info("Enriched payment {} published to payments.enriched and payments.audit", paymentId);
    }
}
```

---

## Kafka Streams EOS

Kafka Streams provides exactly-once processing with `processing.guarantee=exactly_once_v2` (KIP-447, Kafka 2.5+).

```java
import org.apache.kafka.streams.StreamsConfig;
import org.apache.kafka.streams.KafkaStreams;
import org.apache.kafka.streams.StreamsBuilder;
import java.util.Properties;

public class PaymentStreamsApp {

    public static KafkaStreams buildApp(String bootstrapServers) {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "payment-enrichment-streams");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);

        // EOS v2 — uses one epoch per consumer group member (more efficient than v1)
        // exactly_once_v2 requires Kafka 2.5+ and brokers with >= 3 replicas
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
                StreamsConfig.EXACTLY_ONCE_V2);

        // Commit interval controls how often the EOS transaction is committed
        props.put(StreamsConfig.COMMIT_INTERVAL_MS_CONFIG, 100);

        StreamsBuilder builder = new StreamsBuilder();

        builder.stream("payments.raw")
               .mapValues(PaymentEnricher::enrich)
               .filter((key, value) -> value != null)
               .to("payments.enriched");

        return new KafkaStreams(builder.build(), props);
    }
}
```

**EOS v1 vs EOS v2:**

| Property | exactly_once (v1) | exactly_once_v2 |
|----------|-------------------|-----------------|
| Kafka version | 0.11+ | 2.5+ |
| Transactions per task | Per thread | Per task group |
| Broker load | Higher | Lower |
| Recommended | No | Yes |

---

## Consumer-Side Deduplication Table

EOS is Kafka-internal. If you consume from Kafka and write to a database, Kafka EOS does not prevent duplicates at the database layer. Use a deduplication table as a safety net.

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.dao.DuplicateKeyException;

@Service
public class IdempotentPaymentProcessor {

    @Autowired private PaymentRepository paymentRepository;
    @Autowired private DeduplicationRepository deduplicationRepository;

    @Transactional
    public void processPayment(String eventId, PaymentEvent event) {
        // Check deduplication table BEFORE processing
        if (deduplicationRepository.existsByEventId(eventId)) {
            log.info("Duplicate event detected: eventId={} — skipping", eventId);
            return;
        }

        // Process business logic
        Payment payment = Payment.from(event);
        paymentRepository.save(payment);

        // Record event ID as processed — in the same DB transaction
        deduplicationRepository.save(new ProcessedEvent(
                eventId,
                event.getAggregateId(),
                Instant.now()
        ));

        log.info("Payment processed: paymentId={} eventId={}", event.getPaymentId(), eventId);
    }
}
```

```sql
-- Deduplication table schema
CREATE TABLE processed_events (
    event_id    VARCHAR(255) PRIMARY KEY,
    aggregate_id VARCHAR(255) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX idx_processed_events_at ON processed_events (processed_at);

-- Cleanup old records (keep last 7 days for audit)
DELETE FROM processed_events
WHERE processed_at < NOW() - INTERVAL '7 days';
```

---

## Production Pitfalls

### Pitfall 1: Reusing `transactional.id` Across Multiple Instances

**Problem:** Multiple producer instances share the same `transactional.id`. Instance A is mid-transaction when Instance B calls `initTransactions()`. Instance B fences Instance A, causing B's transaction to succeed but A's data is lost.

**Fix:** Ensure each producer instance has a **unique** `transactional.id` incorporating a stable identifier — the pod name, instance index, or a UUID persisted to disk.

```java
// BAD — all instances share the same id
props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-processor");

// GOOD — each instance has a unique id
String podName = System.getenv("POD_NAME"); // e.g., "payment-svc-7d8f9b-0"
props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-processor-" + podName);
```

### Pitfall 2: Not Handling `ProducerFencedException` as Fatal

**Problem:** An application catches `ProducerFencedException` and retries, calling `beginTransaction()` again on the same fenced producer. This results in endless `ProducerFencedException` errors and a stalled consumer.

**Fix:** `ProducerFencedException` and `OutOfOrderSequenceException` are **fatal**. Close the producer and let the process restart (Kubernetes will schedule a new pod).

```java
catch (ProducerFencedException | OutOfOrderSequenceException e) {
    // Do NOT retry — this producer instance is dead
    log.error("FATAL: producer fenced. Initiating shutdown.", e);
    producer.close();
    System.exit(1);  // Or: throw a non-retryable exception to the container
}
```

### Pitfall 3: Using `read_uncommitted` on Consumers Downstream of Transactional Producers

**Problem:** A consumer with the default `isolation.level=read_uncommitted` processes records from an in-flight transaction, then the transaction aborts. The consumer has processed records that were never committed — resulting in phantom payments or phantom fraud signals.

**Fix:** Always set `isolation.level=read_committed` on consumers that read from topics written to by transactional producers.

```java
// In application.properties for Spring Boot consumers:
spring.kafka.consumer.properties.isolation.level=read_committed
```

---

## Production Checklist

- [ ] `enable.idempotence=true` on all payment producers
- [ ] `acks=all` and `max.in.flight.requests.per.connection <= 5` set alongside idempotence
- [ ] `transactional.id` is unique per producer instance using pod name or stable index
- [ ] `initTransactions()` is called once during application startup
- [ ] `ProducerFencedException` causes application shutdown — not retry
- [ ] `isolation.level=read_committed` on all consumers reading from transactional topics
- [ ] `enable.auto.commit=false` on consumers in read-process-write pipelines
- [ ] `sendOffsetsToTransaction()` used to atomically commit offsets with produced records
- [ ] Consumer-side deduplication table in place as a cross-system safety net
- [ ] `processing.guarantee=exactly_once_v2` for Kafka Streams topologies
- [ ] Transaction timeout set to a value less than the max consumer `session.timeout.ms`
- [ ] DLQ configured for messages that repeatedly cause transaction aborts

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the difference between at-least-once and exactly-once delivery guarantees in Kafka?",
      "options": [
        "At-least-once never loses messages and never duplicates; exactly-once only avoids loss",
        "At-least-once retries on failure and may deliver duplicates; exactly-once eliminates both loss and duplicates within Kafka",
        "Exactly-once is only available for Kafka Streams, not regular producers and consumers",
        "At-least-once requires acks=all; exactly-once works with acks=1"
      ],
      "correct": 1,
      "explanation": "At-least-once retries failed sends, ensuring no message is lost but potentially delivering the same message more than once. Exactly-once (enabled via idempotent and transactional producers) eliminates both message loss and duplicates within the Kafka cluster. It does not cover cross-system atomicity with external databases — that requires the outbox pattern or consumer-side deduplication."
    },
    {
      "text": "What happens when two producer instances share the same transactional.id and both call initTransactions()?",
      "options": [
        "Both producers operate independently with separate transaction logs",
        "The broker rejects the second initTransactions() call with a configuration error",
        "The second instance fences the first — the first producer's subsequent commitTransaction() fails with ProducerFencedException",
        "Kafka automatically assigns unique epochs to avoid conflicts"
      ],
      "correct": 2,
      "explanation": "The transactional.id is used for zombie fencing. When a second producer calls initTransactions() with the same id, Kafka increments the epoch for that id. The first producer (zombie) now has a stale epoch. Any attempt by the first producer to commitTransaction() returns ProducerFencedException, preventing the zombie from committing."
    },
    {
      "text": "In a read-process-write pipeline (consume from topic A, transform, produce to topic B), which API call ensures that the consumed offsets and the produced records are committed atomically?",
      "options": [
        "consumer.commitSync() called before producer.commitTransaction()",
        "producer.sendOffsetsToTransaction(offsets, groupMetadata) called inside the transaction before commitTransaction()",
        "Setting isolation.level=read_committed on both the consumer and producer",
        "Using a two-phase commit protocol between the consumer group coordinator and the producer"
      ],
      "correct": 1,
      "explanation": "producer.sendOffsetsToTransaction() sends the consumer group offsets to the Transaction Coordinator as part of the current transaction. When the transaction commits, both the produced records and the consumer offsets are committed atomically. If the transaction aborts, neither the records nor the offset advance are visible."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Exactly-Once Read-Process-Write Pipeline for Payment Transformation",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "Implement a transactional producer with transactional.id=payment-transformer-{instanceId} where instanceId comes from the POD_NAME environment variable. Call initTransactions() on startup. Implement a read-process-write loop that consumes from payments.raw, enriches the payment, and produces to payments.enriched using sendOffsetsToTransaction to atomically commit both the produced record and the consumed offset within the same transaction."
    },
    {
      "id": "2",
      "description": "Implement the error handling decision tree: abort and retry the transaction on KafkaException (transient); close the producer and exit on ProducerFencedException or OutOfOrderSequenceException (fatal); abort and send to DLQ on unrecoverable business exceptions. Write unit tests for each error path using a mock producer that throws each exception type."
    },
    {
      "id": "3",
      "description": "Configure a consumer for payments.enriched with isolation.level=read_committed and write an integration test using EmbeddedKafka that injects a crash mid-transaction (between send() and commitTransaction()), restarts the producer, and verifies the consumer sees exactly one copy of each payment event — confirming no duplicates from the aborted transaction are visible."
    },
    {
      "id": "4",
      "description": "Implement a consumer-side deduplication table (processed_events) as a cross-system safety net. The processPayment method must check the table before applying business logic and insert the eventId within the same database transaction as the business operation. Write a test that calls processPayment with the same eventId twice and verifies the business logic runs only once."
    }
  ]
}
-->
