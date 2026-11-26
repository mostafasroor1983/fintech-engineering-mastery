---
id: track-09-lesson-01
title: "Kafka Architecture — Topics, Partitions, and Consumer Groups"
slug: kafka-architecture
track: track-09
trackName: Messaging, Streaming & Enterprise Integration
sequence: 1
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [Kafka, topic, partition, consumer-group, broker]
prerequisites: []
---

# Kafka Architecture — Topics, Partitions, and Consumer Groups

> [!NOTE]
> Apache Kafka is the dominant messaging platform in financial services — not because it's simple, but because it provides the combination of durability, throughput, and replay capability that event-driven financial systems require. This lesson builds the architectural mental model needed to use Kafka correctly.

## Why Kafka Exists — The Problem It Solves

Traditional message queues (classic RabbitMQ queues, ActiveMQ) delete messages once they are consumed and acknowledged. This creates problems for financial systems:

- **Replay** — if a consumer has a bug, you cannot re-process historical events
- **Multiple consumers** — adding a new service (analytics, compliance) requires its own queue, fed from the moment it is created (no history)
- **Throughput** — a single queue is usually limited by one node; very high volumes need careful sharding
- **Ordering** — with competing consumers on one queue, strict ordering is hard to keep once messages are redelivered or processed in parallel

(RabbitMQ has since added *streams*, a log-style structure — Lesson 19 compares the two.)

Kafka solves these by being a **distributed, partitioned, replicated commit log**. Messages are written to a persistent log. Consumers read from the log at their own pace. The log is not deleted after consumption — it is retained for a configurable period.

---

## Core Architecture

```mermaid
graph TB
    subgraph Cluster ["Kafka Cluster"]
        subgraph B1 ["Broker 1 (Leader for P0, P2)"]
            P0L["payments\nPartition 0\nLeader"]
            P2L["payments\nPartition 2\nLeader"]
        end
        subgraph B2 ["Broker 2 (Leader for P1)"]
            P1L["payments\nPartition 1\nLeader"]
            P0F["payments\nPartition 0\nFollower"]
        end
        subgraph B3 ["Broker 3"]
            P1F["payments\nPartition 1\nFollower"]
            P2F["payments\nPartition 2\nFollower"]
        end
    end
    
    P[Producer\nPayment Service] -->|key: account_id| B1
    P --> B2
    
    CG1[Consumer Group 1\nSettlement Service\nC1 → P0, C2 → P1, P2]
    CG2[Consumer Group 2\nAudit Service\nC1 → P0, P1, P2]
    
    B1 --> CG1
    B2 --> CG1
    B1 --> CG2
```

### Topics — The Logical Channel

A **topic** is a named, ordered sequence of records. Topics are durable — records are retained regardless of whether they have been consumed.

```
Topic: payments
  Partition 0: [event1] [event2] [event3] [event4] ...
  Partition 1: [event5] [event6] [event7] ...
  Partition 2: [event8] [event9] ...
```

Each record in a partition has a **monotonically increasing offset** — the position within that partition's log.

### Partitions — Parallelism and Ordering

Partitions are the unit of:
- **Parallelism** — consumers process partitions concurrently
- **Ordering** — ordering is guaranteed within a partition, not across partitions

**Partition selection** determines which partition a message goes to:
```java
// Explicit key — messages with the same key always go to the same partition
// (as long as the partition count does not change)
// This guarantees ordering for a given account
ProducerRecord<String, PaymentEvent> keyed = new ProducerRecord<>(
    "payments",
    payment.getAccountId(),   // partition key — all events for this account go to same partition
    paymentEvent
);

// No key — spread across partitions, no ordering guarantee.
// (Not strict round-robin: since Kafka 2.4 the "sticky" partitioner fills
//  a batch for one partition, then moves on -- bigger batches, same spread)
ProducerRecord<String, PaymentEvent> unkeyed = new ProducerRecord<>(
    "payments",
    null,                     // no key
    paymentEvent
);
```

**Choosing partition count** is a critical design decision:

| Factor | Recommendation |
|---|---|
| Consumer parallelism | Partitions ≥ max consumers in group |
| Throughput | Measure per-partition throughput on your hardware (often tens of MB/s); size for 3-5x headroom |
| Ordering requirement | Key-based routing; order only guaranteed within a partition |
| Rebalance and overhead | More partitions = more work in rebalances, leader elections and replication |
| Future growth | Adding partitions later CHANGES the key → partition mapping (per-key ordering breaks during the switch) — choose generously up front |

For a payments topic with 1M events/day (~12/s on average, a few hundred/s at peak), throughput needs very few partitions; the count is driven by consumer parallelism and growth — 12-24 partitions is a common choice.

### Replication — Durability and High Availability

Each partition has one **leader** (handles all reads and writes) and multiple **followers** (replicate from leader).

```
Replication factor = 3 (minimum for production financial systems)
min.insync.replicas = 2 (at least 2 replicas must acknowledge a write)
acks = all (producer waits for all in-sync replicas)

This configuration: withstands loss of 1 broker without data loss or availability impact
```

```java
// Producer configuration for financial-grade durability
Properties props = new Properties();
props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaBrokers);
props.put(ProducerConfig.ACKS_CONFIG, "all");                     // all ISR must acknowledge
props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);      // retry forever
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);        // no duplicates from retries (per partition)
props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5); // idempotent: safe to have 5
props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000);    // 2 minutes total delivery timeout
props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 30_000);      // 30 seconds per request attempt
```

---

## Consumer Groups — Parallel Processing

A **consumer group** is a set of consumers that jointly consume a topic. Each partition is assigned to exactly one consumer within the group.

```mermaid
graph LR
    T["payments topic\n(3 partitions)"]
    
    T -->|P0| C1["Consumer 1\nSettlement"]
    T -->|P1| C2["Consumer 2\nSettlement"]
    T -->|P2| C2
    
    T -->|P0| C3["Consumer 1\nAudit — separate group"]
    T -->|P1| C3
    T -->|P2| C3
    
    style C1 fill:#1e3a5f,color:#fff
    style C2 fill:#1e3a5f,color:#fff
    style C3 fill:#2d4a1e,color:#fff
```

**Key properties:**
- Consumer groups are independent — adding an audit group doesn't affect the settlement group
- If consumers < partitions: some consumers process multiple partitions
- If consumers > partitions: extra consumers are idle (they receive no partitions)
- If a consumer crashes: Kafka **rebalances** — reassigns that consumer's partitions to remaining consumers

### Consumer Configuration for Financial Systems

```java
Properties props = new Properties();
props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaBrokers);
props.put(ConsumerConfig.GROUP_ID_CONFIG, "settlement-service");
props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");   // start from beginning if no offset
props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);       // NEVER auto-commit in finance
props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 100);           // process 100 records per poll
props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 300_000);   // 5 min max between polls
props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, 30_000);      // 30s to detect consumer failure
props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, 10_000);   // heartbeat every 10s

KafkaConsumer<String, PaymentEvent> consumer = new KafkaConsumer<>(props, 
    new StringDeserializer(), 
    new JsonDeserializer<>(PaymentEvent.class));
```

> [!WARNING]
> **Avoid `enable.auto.commit=true` in financial systems.** Auto-commit commits, on a timer during `poll()`, the offsets of records returned by earlier polls — it does not know whether your processing succeeded. If records are handed to other threads, buffered, or written asynchronously, the offset can be committed before the work is durable; a crash then loses those messages silently. Manual commits put the commit point exactly where processing is finished. (Spring Kafka's listener containers already disable Kafka's auto-commit and commit for you according to their `AckMode`.)

### Manual Offset Commit Pattern

```java
// Commit only after successful processing — at-least-once delivery.
// Failures are NOT handled by "just not acknowledging": the consumer would
// simply continue with the next records, and the next acknowledge() would
// commit past the failed one. Instead, throw -- the container's
// DefaultErrorHandler seeks back, retries with back-off, and finally hands
// the record to a DeadLetterPublishingRecoverer (topic payments.DLT).
@KafkaListener(topics = "payments", groupId = "settlement-service",
               containerFactory = "manualAckKafkaListenerContainerFactory")
public void processPayment(ConsumerRecord<String, PaymentEvent> record,
                           Acknowledgment ack) {
    // Process the payment (idempotent: redelivery must be harmless)
    settlementService.processPayment(record.value());

    // Only commit offset after successful processing
    ack.acknowledge();
    // TransientException (DB timeout, etc.) -> propagates -> retried
    // PermanentException (invalid message) -> registered as not-retryable
    //   -> published to the DLT at once, then the offset moves on
}

@Bean
DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
    DefaultErrorHandler handler = new DefaultErrorHandler(
        new DeadLetterPublishingRecoverer(template),
        new ExponentialBackOff(500, 2.0));               // 0.5s, 1s, 2s, ...
    handler.addNotRetryableExceptions(PermanentException.class);
    return handler;
}
```

---

## The Offset Model — Exactly-Once vs At-Least-Once

Understanding offset management is critical to achieving your desired delivery semantics.

```mermaid
sequenceDiagram
    participant K as Kafka Broker
    participant C as Consumer
    participant DB as Database

    K->>C: Poll: messages [offset 100, 101, 102]
    C->>DB: Process offset 100 → persist result
    C->>DB: Process offset 101 → persist result  
    Note over C: Crash before processing 102 and committing

    C->>K: Reconnect — committed offset is 100 (= next record to read)
    K->>C: Redeliver: messages [offset 100, 101, 102]
    
    Note over C,DB: Offsets 100 and 101 are redelivered\nMust be idempotent to handle re-processing
```

**At-Least-Once** (manual commit after processing): messages may be redelivered. Processing must be **idempotent** — safe to execute multiple times.

**Exactly-Once** (Kafka transactions): consume, process, and produce in a single atomic transaction. More complex, and it only covers Kafka-to-Kafka work: the output records and the consumer offsets commit together. Side effects outside Kafka (database writes, HTTP calls) are not part of the transaction and still need idempotency. Downstream consumers must read with `isolation.level=read_committed`.

```java
// Exactly-once: consume from input topic, produce to output topic atomically
// (producer has transactional.id set; consumer has enable.auto.commit=false
//  and isolation.level=read_committed)
producer.initTransactions();
consumer.subscribe(List.of("payment-instructions"));

while (true) {
    ConsumerRecords<String, PaymentInstruction> records = consumer.poll(Duration.ofMillis(100));
    if (records.isEmpty()) continue;

    producer.beginTransaction();
    try {
        for (ConsumerRecord<String, PaymentInstruction> record : records) {
            PaymentResult result = processPayment(record.value());   // pure computation

            // Produce result to output topic
            producer.send(new ProducerRecord<>("payment-results",
                record.key(), result));
        }

        // Commit offsets AND output messages in a single atomic transaction
        // (offset to commit = last processed offset + 1, per partition)
        Map<TopicPartition, OffsetAndMetadata> offsets = calculateOffsets(records);
        producer.sendOffsetsToTransaction(offsets, consumer.groupMetadata());
        producer.commitTransaction();

    } catch (ProducerFencedException e) {
        producer.close();     // another instance took over this transactional.id
        throw e;
    } catch (KafkaException e) {
        producer.abortTransaction();  // rolls back both output messages and offset commit
        // Rewind the consumer: otherwise the next poll() would continue
        // AFTER the aborted batch and those records would be skipped
        for (TopicPartition tp : records.partitions()) {
            OffsetAndMetadata committed = consumer.committed(Set.of(tp)).get(tp);
            consumer.seek(tp, committed != null ? committed.offset() : 0L);
        }
    }
}
```

---

## Topic Design for Financial Events

### Event Naming Conventions

```
Domain events (immutable facts):
  payments.submitted        — payment submitted by customer
  payments.authorised       — payment authorisation decision made  
  payments.settled          — settlement confirmed
  payments.failed           — payment permanently failed

Command topics (instructions):
  payment-commands          — instructions to process payments
  
Internal state topics (compacted):
  account-balances          — latest balance per account (log-compacted)
```

### Log Compaction for State Topics

Log compaction retains only the latest record per key. Use for state topics where you only need the current value:

```java
// Topic configuration: account balances (compacted — keep only latest per account)
Map<String, String> accountBalancesConfig = Map.of(
    "cleanup.policy",     "compact",
    "min.cleanable.dirty.ratio", "0.1",
    "segment.ms",         String.valueOf(Duration.ofHours(24).toMillis()),
    // how long delete markers (tombstones) are kept: a consumer offline
    // longer than this can miss deletions -- size it to your longest outage
    "delete.retention.ms", String.valueOf(Duration.ofDays(1).toMillis())
);

// Sending a compacted message: same key = later message replaces earlier
producer.send(new ProducerRecord<>(
    "account-balances",
    accountId.toString(),              // partition and compaction key
    new AccountBalance(accountId, newBalance, Instant.now())
));
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "A payments topic has 6 partitions. The settlement consumer group has 8 consumers. What happens?",
      "options": [
        "Error — Kafka requires consumer count ≤ partition count",
        "All 8 consumers are assigned partitions (each partition gets multiple consumers)",
        "6 consumers are assigned one partition each; 2 consumers are idle",
        "Kafka automatically creates 2 more partitions to match consumer count"
      ],
      "correct": 2,
      "explanation": "Each partition can only be assigned to ONE consumer within a group. With 6 partitions and 8 consumers, 6 consumers each get one partition and 2 consumers receive no partitions (idle). This is not an error — the idle consumers act as standby and receive partitions if another consumer fails."
    },
    {
      "id": "q2",
      "text": "Payment events for Account A must be processed in order. How should you configure the Kafka producer?",
      "options": [
        "Set acks=all and replication-factor=3",
        "Use Account A's ID as the message key — Kafka routes all messages with the same key to the same partition, guaranteeing partition-level ordering",
        "Use a single-partition topic for all payment events",
        "Set max.in.flight.requests.per.connection=1"
      ],
      "correct": 1,
      "explanation": "Kafka guarantees ordering within a partition. By using the account ID as the message key, the hash-based partitioner routes all events for that account to the same partition, guaranteeing they are delivered to consumers in order. A single-partition topic would work but eliminates all parallelism."
    },
    {
      "id": "q3",
      "text": "Why is `enable.auto.commit=true` dangerous for financial Kafka consumers?",
      "options": [
        "Auto-commit causes messages to be delivered twice",
        "Auto-commit advances the offset on a timer regardless of processing success — if the consumer crashes after auto-commit but before persisting the result, the message is permanently skipped",
        "Auto-commit reduces consumer throughput by 50%",
        "Auto-commit is incompatible with Avro serialisation"
      ],
      "correct": 1,
      "explanation": "Auto-commit commits offsets every auto.commit.interval.ms (default 5 seconds) during poll(), for records returned by earlier polls — it does not know whether processing succeeded. If the application processes records asynchronously (hands them to a thread pool, buffers writes), the offset of a payment can be committed while its processing is still in flight; if the consumer then crashes, the payment is never redelivered — it is silently lost. Manual commits after durable processing avoid this."
    },
    {
      "id": "q4",
      "text": "You are consuming payment events at-least-once. The same payment arrives twice (duplicate delivery after a consumer crash). How must your payment processing be designed?",
      "options": [
        "The consumer should check the offset to detect duplicates",
        "Payment processing must be idempotent — processing the same payment event twice must have the same effect as processing it once (use payment ID as idempotency key)",
        "Duplicates are impossible with acks=all configuration",
        "Use a single consumer with no consumer group to prevent rebalancing"
      ],
      "correct": 1,
      "explanation": "At-least-once delivery inherently allows redelivery. The only safe approach is idempotent processing: check if the payment ID has already been processed before executing the payment. This can be done with a database UNIQUE constraint on the payment ID or an idempotency key store with a TTL."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Kafka Architecture — Topics, Partitions, and Consumer Groups — Production Implementation",
  "difficulty": "advanced",
  "estimatedMinutes": 90,
  "tasks": [
    {
      "id": "1",
      "description": "Calculate the partition count for a payments topic: 5M events/day today with peaks of 10x the average, 3x growth expected in two years, and a settlement service that needs up to 24 parallel consumers. Show the throughput calculation, the parallelism requirement, and explain why adding partitions later would break per-account ordering."
    },
    {
      "id": "2",
      "description": "Write the topic creation command (kafka-topics.sh or AdminClient) for the payments topic with replication factor 3, min.insync.replicas=2, a 7-day retention, and the partition count from task 1. Also create a compacted account-balances topic and explain each setting you chose."
    },
    {
      "id": "3",
      "description": "Write the producer configuration for financial-grade durability (acks=all, idempotence, delivery timeout, account_id as key) and a test that proves events for one account arrive in order in a single partition, while events for different accounts are spread across partitions."
    },
    {
      "id": "4",
      "description": "Design the consumer group strategy for settlement (processing) and audit (independent reader): group ids, manual commits, a DefaultErrorHandler with back-off and a dead-letter topic, and idempotent processing keyed on payment id. Write a test that kills a consumer mid-batch and verifies that no payment is lost and duplicates have no effect."
    }
  ]
}
-->
