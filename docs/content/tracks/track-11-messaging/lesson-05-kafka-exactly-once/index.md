---
id: track-11-lesson-05
title: "Exactly-Once Semantics — Transactions in Kafka"
slug: kafka-exactly-once
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 5
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [exactly-once, Kafka, transactions, idempotent-producer, EOS]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
---

# Exactly-Once Semantics — Transactions in Kafka

> [!NOTE]
> Exactly-once semantics (EOS) is the most misunderstood guarantee in distributed messaging. In financial systems, delivering a payment event twice or zero times is catastrophic. Kafka's transactional API provides true end-to-end exactly-once — but only within Kafka. Understanding where EOS holds and where it breaks is non-negotiable for principal engineers designing payment pipelines.

## The Three Delivery Guarantees

Before implementing EOS, understand what each guarantee actually means:

| Guarantee | Description | Financial Risk |
|-----------|-------------|----------------|
| At-most-once | Messages may be lost, never duplicated | Missing payment events |
| At-least-once | No loss, but duplicates possible | Double-charging customers |
| Exactly-once | No loss, no duplicates | Correct — but hardest to achieve |

The default Kafka producer operates at **at-least-once**: if the broker ACK is lost due to a network failure, the producer retries and may write the same message twice. For a payment event stream, this means a `FundsTransferred` event could appear twice, causing a downstream settlement service to transfer funds twice.

---

## EOS Building Blocks

Kafka EOS is built from two independent mechanisms that must both be enabled:

### 1. Idempotent Producer (Single-Session Deduplication)

An idempotent producer ensures that retries within a single producer session do not produce duplicates. The broker assigns each producer a **Producer ID (PID)** and tracks **sequence numbers** per `(PID, partition)`.

```
Producer                          Broker
   |--- Produce(PID=42, seq=0) -->|
   |<-- ACK(seq=0) --------------|
   |
   |--- Produce(PID=42, seq=1) -->|  [network hiccup]
   |   [timeout, retry]           |
   |--- Produce(PID=42, seq=1) -->|  [broker already has seq=1]
   |<-- ACK(seq=1) --------------|  [deduped, not written twice]
```

Enable with:

```java
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
// Automatically sets:
// acks=all
// retries=Integer.MAX_VALUE
// max.in.flight.requests.per.connection=5
```

**Limitation:** Idempotence only holds within a single producer session. If the producer restarts, it gets a new PID, and the broker cannot deduplicate across sessions. This is where transactions come in.

### 2. Transactions (Cross-Session, Multi-Partition Atomicity)

Transactions add a **transactional.id** that persists across producer restarts. The broker maintains a **transaction log** (the `__transaction_state` internal topic) that records the state of each transaction.

```java
props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-processor-1");
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true); // Required for transactions
```

The `transactional.id` must be stable and unique per producer instance. Use a naming convention like `{service-name}-{partition-number}` to ensure uniqueness across deployments.

---

## Producer Epochs and Zombie Fencing

A critical EOS mechanism is **producer epochs**. When a producer initialises with a `transactional.id`, the broker bumps the epoch number. If an old "zombie" producer (a previous instance still running due to a slow network or GC pause) tries to write, the broker rejects it because its epoch is stale.

```
Producer v1 (epoch=0)              Broker
   |--- initTransactions() ------->|  epoch=1 assigned
   |--- beginTransaction() ------->|
   |--- send(msg) ----------------->|
   |   [GC pause — 60 seconds]     |
   |                               |
Producer v2 (epoch=1) starts       |
   |--- initTransactions() ------->|  epoch=2 assigned (bumped)
   |--- beginTransaction() ------->|
   |--- send(msg) ----------------->|  OK
   |--- commitTransaction() ------->|  OK
   |                               |
Producer v1 (epoch=0) resumes      |
   |--- commitTransaction() ------->|  REJECTED (epoch=0 < current epoch=2)
```

This prevents double-writes from split-brain producer instances — a critical safety mechanism for financial pipelines.

---

## The Transaction API

```java
import org.apache.kafka.clients.producer.*;
import java.util.Properties;
import java.util.UUID;

public class PaymentTransactionalProducer {

    private final KafkaProducer<String, String> producer;
    private static final Logger log = LoggerFactory.getLogger(PaymentTransactionalProducer.class);

    public PaymentTransactionalProducer(String transactionalId) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, transactionalId);
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        // acks=all and retries=MAX_VALUE are set automatically

        this.producer = new KafkaProducer<>(props);
        // Must be called once before any transactions
        this.producer.initTransactions();
    }

    public void publishPaymentEvent(PaymentEvent event) {
        producer.beginTransaction();
        try {
            ProducerRecord<String, String> record = new ProducerRecord<>(
                    "payments.events",
                    event.getAccountId(),   // partition key — same account always same partition
                    event.toJson()
            );
            producer.send(record);

            // Optionally publish to a second topic in the same transaction
            ProducerRecord<String, String> auditRecord = new ProducerRecord<>(
                    "payments.audit",
                    event.getAccountId(),
                    buildAuditEntry(event)
            );
            producer.send(auditRecord);

            producer.commitTransaction();
            log.info("Transaction committed for payment {}", event.getPaymentId());

        } catch (ProducerFencedException | OutOfOrderSequenceException e) {
            // Fatal — this producer instance has been fenced (zombie scenario)
            // Do NOT abort — this producer is poisoned, must restart
            log.error("Producer fenced — shutting down", e);
            producer.close();
            throw new FatalProducerException("Producer fenced, restart required", e);

        } catch (KafkaException e) {
            // Retriable error — abort current transaction and retry
            log.warn("Kafka error in transaction, aborting", e);
            producer.abortTransaction();
            throw new RetriablePaymentException("Transaction aborted, retry", e);
        }
    }

    private String buildAuditEntry(PaymentEvent event) {
        return String.format(
            "{\"eventId\":\"%s\",\"accountId\":\"%s\",\"type\":\"%s\",\"timestamp\":\"%s\"}",
            event.getEventId(), event.getAccountId(),
            event.getEventType(), event.getTimestamp()
        );
    }

    public void close() {
        producer.close();
    }
}
```

### Error Handling Decision Tree

```
Transaction Error
├── ProducerFencedException
│   └── FATAL: Zombie producer. Close producer, restart process.
├── OutOfOrderSequenceException
│   └── FATAL: Internal sequence error. Close producer, restart process.
├── AuthorizationException
│   └── FATAL: ACL misconfiguration. Fix ACLs before retrying.
└── KafkaException (all others)
    └── RETRIABLE: Call abortTransaction(), then retry the business logic.
```

---

## Read-Process-Write Pattern

The most important EOS pattern for stream processing is **read-process-write**: consume a message, process it, and write the output — atomically. Without EOS, if the process crashes after writing the output but before committing the offset, the message is reprocessed and the output is duplicated.

```java
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.TopicPartition;
import java.time.Duration;
import java.util.*;

public class PaymentEnrichmentProcessor {

    private final KafkaConsumer<String, String> consumer;
    private final KafkaProducer<String, String> producer;
    private final PaymentEnrichmentService enrichmentService;
    private static final Logger log = LoggerFactory.getLogger(PaymentEnrichmentProcessor.class);

    public PaymentEnrichmentProcessor() {
        // Consumer: isolation.level=read_committed is CRITICAL
        Properties consumerProps = new Properties();
        consumerProps.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        consumerProps.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-enrichment-group");
        consumerProps.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed"); // KEY SETTING
        consumerProps.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);         // Manual offset commit
        consumerProps.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        consumerProps.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringDeserializer");
        consumerProps.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringDeserializer");
        this.consumer = new KafkaConsumer<>(consumerProps);

        // Producer: transactional
        Properties producerProps = new Properties();
        producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        producerProps.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-enrichment-1");
        producerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        producerProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        producerProps.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        this.producer = new KafkaProducer<>(producerProps);
        this.producer.initTransactions();

        this.enrichmentService = new PaymentEnrichmentService();
        this.consumer.subscribe(List.of("payments.raw"));
    }

    public void processLoop() {
        while (!Thread.currentThread().isInterrupted()) {
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));

            if (records.isEmpty()) continue;

            producer.beginTransaction();
            try {
                for (ConsumerRecord<String, String> record : records) {
                    RawPayment raw = RawPayment.fromJson(record.value());
                    EnrichedPayment enriched = enrichmentService.enrich(raw);

                    producer.send(new ProducerRecord<>(
                            "payments.enriched",
                            enriched.getAccountId(),
                            enriched.toJson()
                    ));
                }

                // Commit offsets WITHIN the transaction — atomic with the output
                Map<TopicPartition, OffsetAndMetadata> offsets = buildOffsetMap(records);
                producer.sendOffsetsToTransaction(offsets, consumer.groupMetadata());

                producer.commitTransaction();

            } catch (ProducerFencedException e) {
                log.error("Producer fenced during enrichment processing", e);
                producer.close();
                throw new FatalProcessorException(e);
            } catch (Exception e) {
                log.warn("Error processing batch, aborting transaction", e);
                producer.abortTransaction();
                // Offsets were NOT committed — same messages will be redelivered
            }
        }
    }

    private Map<TopicPartition, OffsetAndMetadata> buildOffsetMap(
            ConsumerRecords<String, String> records) {
        Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
        for (TopicPartition partition : records.partitions()) {
            List<ConsumerRecord<String, String>> partitionRecords = records.records(partition);
            long lastOffset = partitionRecords.get(partitionRecords.size() - 1).offset();
            // Commit offset+1 (next message to consume)
            offsets.put(partition, new OffsetAndMetadata(lastOffset + 1));
        }
        return offsets;
    }
}
```

### Why `sendOffsetsToTransaction` Is the Key

The standard `consumer.commitSync()` commits offsets independently of the producer transaction. If the process crashes between `producer.commitTransaction()` and `consumer.commitSync()`, offsets are not committed and the messages are reprocessed — a duplicate.

`producer.sendOffsetsToTransaction()` commits offsets **inside** the producer transaction. The offset commit and the output message write are atomic. Either both succeed or both fail.

---

## `isolation.level=read_committed`

Consumers that read from topics written by transactional producers must set `isolation.level=read_committed`. Without this, consumers read **all** messages including those in aborted transactions — duplicating data that should have been discarded.

```java
// WRONG — reads aborted transaction messages
consumerProps.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_uncommitted"); // DEFAULT

// CORRECT — only reads committed transaction messages
consumerProps.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");
```

**How it works:** Kafka uses **control records** to mark transaction boundaries. When a consumer with `read_committed` encounters a control record marking an `ABORT`, it discards all messages from that transaction.

```
Topic partition log:
[msg1 txn=A] [msg2 txn=A] [msg3 txn=B] [COMMIT txn=A] [ABORT txn=B] [msg4 txn=C]

read_uncommitted consumer sees: msg1, msg2, msg3, msg4 (as they arrive)
read_committed consumer sees:   msg1, msg2 (after COMMIT txn=A)
                                msg3 is discarded (ABORT txn=B)
                                msg4 (after COMMIT txn=C)
```

---

## Exactly-Once in Kafka Streams

Kafka Streams provides EOS out of the box with a single configuration property:

```java
import org.apache.kafka.streams.*;
import org.apache.kafka.streams.kstream.KStream;
import java.util.Properties;

public class PaymentStreamProcessor {

    public KafkaStreams buildStreams() {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "payment-stream-processor");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");

        // EOS v2 — available since Kafka 2.5, recommended in 3.0+
        // Uses one transactional producer per stream task (not per thread)
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
                StreamsConfig.EXACTLY_ONCE_V2);

        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.Serdes$StringSerde");
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.Serdes$StringSerde");

        StreamsBuilder builder = new StreamsBuilder();

        KStream<String, String> rawPayments = builder.stream("payments.raw");

        rawPayments
            .filter((key, value) -> isValidPayment(value))
            .mapValues(this::enrichPayment)
            .to("payments.enriched");

        // All writes in the same stream task are part of the same transaction
        rawPayments
            .filter((key, value) -> isDomestic(value))
            .to("payments.domestic");

        rawPayments
            .filter((key, value) -> isInternational(value))
            .to("payments.international");

        KafkaStreams streams = new KafkaStreams(builder.build(), props);
        streams.setUncaughtExceptionHandler(exception -> {
            log.error("Uncaught exception in Kafka Streams — replacing thread", exception);
            return StreamThreadExceptionResponse.REPLACE_THREAD;
        });
        return streams;
    }

    private boolean isValidPayment(String paymentJson) {
        return paymentJson != null && !paymentJson.isEmpty();
    }

    private String enrichPayment(String rawPaymentJson) {
        return rawPaymentJson; // add FX rates, merchant names, etc.
    }

    private boolean isDomestic(String paymentJson) {
        return paymentJson.contains("\"currency\":\"GBP\"");
    }

    private boolean isInternational(String paymentJson) {
        return !isDomestic(paymentJson);
    }
}
```

**EOS v2 vs EOS v1:**

| Feature | `exactly_once` (v1) | `exactly_once_v2` |
|---------|---------------------|-------------------|
| Kafka version | 0.11+ | 2.5+ |
| Transactions per | Thread | Task |
| Broker load | Higher | Lower |
| Throughput | Baseline | ~20% higher |
| Recommended | No (legacy) | Yes |

---

## EOS Performance Cost

EOS costs approximately **3–5% throughput reduction** for typical financial workloads. Sources of overhead:

1. **Transaction coordination** — broker writes to `__transaction_state` on begin/commit/abort
2. **Producer epoch bumps** — on restart, broker must fence old epoch
3. **Consumer read latency** — `read_committed` consumers wait for transaction commit markers
4. **Reduced batching** — transactions impose flushing boundaries

**Tuning:** Increase messages per transaction to amortise per-transaction overhead. A transaction with 1,000 messages has negligible per-message overhead; a transaction with 1 message does not.

```java
// High-throughput EOS: batch many records per transaction
public void processBatch(List<PaymentEvent> events) {
    producer.beginTransaction();
    try {
        // Send all events in one transaction
        for (PaymentEvent event : events) {
            producer.send(new ProducerRecord<>("payments.events",
                    event.getAccountId(), event.toJson()));
        }
        producer.commitTransaction();
        // Per-message overhead is now negligible
    } catch (KafkaException e) {
        producer.abortTransaction();
        throw e;
    }
}
```

---

## EOS Limitations

> [!WARNING]
> Exactly-once in Kafka only holds within Kafka. The moment your read-process-write pipeline involves an external system (database, REST API, another message broker), Kafka EOS cannot guarantee exactly-once end-to-end.

### Single Cluster Only

EOS works across topics on the **same** Kafka cluster. Cross-cluster scenarios (MirrorMaker 2 replication) do not preserve EOS guarantees.

### No Cross-System Exactly-Once

If your processor reads from Kafka and writes to PostgreSQL, you must use the **outbox pattern** or **idempotent consumer design** to achieve end-to-end EOS. Writing to a database inside a Kafka transaction does not make the database write transactional with Kafka.

```java
// BROKEN — not exactly-once end-to-end
producer.beginTransaction();
producer.send(new ProducerRecord<>("output-topic", key, value));
database.insert(record); // NOT part of the Kafka transaction
producer.commitTransaction();
// If this crashes after commitTransaction but before database.insert completes,
// the Kafka message is committed but the DB record is missing.

// CORRECT approach: use outbox pattern (Lesson 06)
```

---

## Spring Kafka `KafkaTransactionManager`

```java
import org.springframework.kafka.core.*;
import org.springframework.kafka.transaction.KafkaTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.stereotype.Service;

@Configuration
public class KafkaTransactionConfig {

    @Bean
    public ProducerFactory<String, String> transactionalProducerFactory() {
        Map<String, Object> config = new HashMap<>();
        config.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        config.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        config.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        config.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);

        DefaultKafkaProducerFactory<String, String> factory =
                new DefaultKafkaProducerFactory<>(config);
        // Spring appends a unique suffix per factory instance
        factory.setTransactionIdPrefix("payment-service-");
        return factory;
    }

    @Bean
    public KafkaTemplate<String, String> kafkaTemplate() {
        return new KafkaTemplate<>(transactionalProducerFactory());
    }

    @Bean
    public KafkaTransactionManager<String, String> kafkaTransactionManager(
            ProducerFactory<String, String> pf) {
        return new KafkaTransactionManager<>(pf);
    }
}

@Service
public class PaymentEventService {

    @Autowired
    private KafkaTemplate<String, String> kafkaTemplate;

    @Transactional("kafkaTransactionManager")
    public void publishPaymentCreated(PaymentCommand command) {
        // Both sends are in the same Kafka transaction
        kafkaTemplate.send("payments.events",
                command.getAccountId(),
                PaymentCreatedEvent.from(command).toJson());

        kafkaTemplate.send("payments.audit",
                command.getAccountId(),
                AuditEntry.from(command).toJson());

        // If any exception is thrown, both sends are aborted
    }
}
```

---

## Production Checklist

```
Producer Configuration:
  [ ] transactional.id — stable, unique per producer instance
  [ ] enable.idempotence=true
  [ ] acks=all (auto-set by idempotence)
  [ ] retries=Integer.MAX_VALUE (auto-set by idempotence)
  [ ] max.in.flight.requests.per.connection <= 5

Consumer Configuration:
  [ ] isolation.level=read_committed
  [ ] enable.auto.commit=false
  [ ] Use sendOffsetsToTransaction() not commitSync()

Kafka Streams:
  [ ] processing.guarantee=exactly_once_v2
  [ ] Handle uncaught exceptions with StreamThreadExceptionResponse

Error Handling:
  [ ] ProducerFencedException → close producer, restart process (FATAL)
  [ ] OutOfOrderSequenceException → close producer, restart process (FATAL)
  [ ] KafkaException → abortTransaction(), retry business logic

Operational:
  [ ] transaction.timeout.ms configured (default 60s)
  [ ] Monitor __transaction_state topic lag
  [ ] Alert on transaction abort rate spike
```

---

## Key Takeaways

- **Idempotent producer** deduplicates retries within a single session using PIDs and sequence numbers.
- **Transactional producer** provides cross-session deduplication and multi-partition atomicity via producer epochs.
- **Producer epochs** fence zombie producers — a critical safety mechanism for multi-instance deployments.
- **`sendOffsetsToTransaction`** is the cornerstone of read-process-write EOS — offsets and output are committed atomically.
- **`isolation.level=read_committed`** must be set on any consumer reading from transactional producers.
- EOS costs ~3–5% throughput — acceptable for payment pipelines; avoidable for high-throughput analytics via idempotent consumer design.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A transactional producer calls producer.send() for three records across two partitions, then calls producer.commitTransaction(). The broker crashes before the commit marker is written. What does a consumer with isolation.level=read_committed see?",
      "options": [
        "All three records, because they were already written to the partitions",
        "None of the three records — uncommitted transactional records are invisible to read_committed consumers",
        "Only the records from the partition whose broker did not crash",
        "The consumer blocks indefinitely waiting for the transaction to complete"
      ],
      "correct": 1,
      "explanation": "read_committed consumers only see records up to the Last Stable Offset (LSO), which is the offset just before the earliest open transaction. Records written inside an uncommitted transaction are physically present in the partition log but are withheld from read_committed consumers until the transaction commits (or aborted, in which case they are skipped). If the broker crashes mid-transaction, the transaction will eventually be aborted by the new coordinator and the records remain invisible."
    },
    {
      "text": "A new producer instance starts with the same transactional.id as an older producer that is still running (a zombie). What mechanism prevents the zombie from corrupting the topic?",
      "options": [
        "The zombie is detected by its consumer group membership and forcefully shut down",
        "The Transaction Coordinator bumps the producer epoch; subsequent writes from the zombie with the old epoch are rejected with ProducerFencedException",
        "Kafka uses a distributed lock on the transactional.id to prevent concurrent access",
        "The new producer kills the zombie's TCP connection via the Kafka admin API"
      ],
      "correct": 1,
      "explanation": "When a new producer registers the same transactional.id, the Transaction Coordinator increments the producer epoch. The zombie retains the old (lower) epoch. Any subsequent write or commit from the zombie is rejected by brokers with a ProducerFencedException, because they validate that the producer epoch matches the current epoch stored by the coordinator. This fencing is essential for preventing double-processing when a failed producer instance recovers."
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
      "explanation": "producer.sendOffsetsToTransaction() sends the consumer group offsets to the Transaction Coordinator as part of the current transaction. When the transaction commits, both the produced records and the consumer offsets are committed atomically. If the transaction aborts, neither the records nor the offset advance are visible. This prevents the scenario where processing succeeds but the offset is not committed (re-read) or the offset advances but the produced record is lost."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Exactly-Once Read-Process-Write Pipeline for Payment Transformation",
  "difficulty": "principal",
  "estimatedMinutes": 60,
  "tasks": [
    "Implement a transactional producer with transactional.id=payment-transformer-{instanceId} where instanceId comes from the pod's hostname. Initialize the transaction on startup and implement a read-process-write loop that consumes from payments.raw, enriches the payment, and produces to payments.enriched using sendOffsetsToTransaction to atomically commit both the produced record and the consumed offset.",
    "Implement the error handling decision tree: abort and retry the transaction on TRANSACTION_COORDINATOR_FENCED and NOT_ENOUGH_REPLICAS; abort and skip on SERIALIZATION_ERROR; abort and send to DLQ on unrecoverable errors. Write tests for each error path using a mock producer that simulates each exception.",
    "Configure a consumer for payments.enriched with isolation.level=read_committed and write a test using EmbeddedKafka that injects a crash mid-transaction (between send() and commitTransaction()), restarts the producer, and verifies the consumer sees exactly one copy of each payment event — no duplicates from the aborted transaction.",
    "Measure the throughput cost of EOS: run a benchmark producing 100,000 payment events through the transactional pipeline vs a non-transactional pipeline with idempotent producer only. Report the throughput difference as a percentage and determine whether it falls within the expected 3–5% range documented in the lesson."
  ]
}
-->
- EOS is Kafka-internal only — cross-system exactly-once requires the outbox pattern (Lesson 06).
