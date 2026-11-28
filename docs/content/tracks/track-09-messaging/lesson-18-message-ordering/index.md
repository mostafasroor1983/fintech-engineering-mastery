---
id: track-09-lesson-18
title: "Message Ordering — Global vs Partition-Level Guarantees"
slug: message-ordering
track: track-09
trackName: "Kafka & Event-Driven Architecture"
sequence: 18
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [message-ordering, partition-key, global-order, sequence-number]
prerequisites: ["track-09-lesson-01", "track-09-lesson-02", "track-09-lesson-03"]
---

# Message Ordering — Global vs Partition-Level Guarantees

> [!NOTE]
> Kafka guarantees strict ordering within a partition, but not across partitions. For payment systems, this distinction is critical: processing a debit before its corresponding credit, or processing an account close before the final transaction, can corrupt financial data. Understanding and designing for Kafka's ordering guarantees is non-negotiable at the principal level.

## Kafka's Ordering Guarantee

```
Topic: payments.events (3 partitions)

Partition 0 (account: acc-123):    [E1: Deposit] → [E2: Withdraw] → [E3: Transfer]
Partition 1 (account: acc-456):    [E4: Create]  → [E5: Deposit]
Partition 2 (account: acc-789):    [E6: Freeze]  → [E7: Close]

Guarantee:
  Within partition 0: E1 is ALWAYS before E2, E2 is ALWAYS before E3
  Within partition 1: E4 is ALWAYS before E5
  Within partition 2: E6 is ALWAYS before E7

NOT guaranteed:
  Cross-partition ordering: E1 vs E4 vs E6 can arrive in any order
  E3 might be consumed before E4 depending on partition assignment
```

**Implication for payment processing:** Events for the same account must always go to the same partition. Use the **account ID as the partition key**.

The guarantee also depends on the producer: with retries and more than one in-flight request, a failed-then-retried batch could land behind a later one — unless the producer is **idempotent** (the default since Kafka 3.0), which keeps per-partition order with up to 5 in-flight requests. And the consumer must not process one partition's records in parallel threads.

---

## Partition Key Design for Account Events

```java
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.KafkaProducer;

@Service
public class AccountEventPublisher {

    @Autowired private KafkaProducer<String, String> producer;

    public void publish(AccountEvent event) {
        ProducerRecord<String, String> record = new ProducerRecord<>(
                "account-events",
                event.getAccountId(),   // KEY — determines partition
                event.toJson()          // VALUE
        );

        // All events for account "acc-123" go to the same partition
        // Built-in partitioner: partition = toPositive(murmur2(keyBytes)) % numPartitions
        producer.send(record);
    }
}
```

```java
// Verifying partition assignment for a given key (same formula as the
// built-in partitioner, with StringSerializer's UTF-8 key bytes)
public int calculatePartition(String key, int numPartitions) {
    int hash = Utils.murmur2(key.getBytes(StandardCharsets.UTF_8));
    // toPositive (hash & 0x7fffffff), NOT Math.abs(hash % n): for negative
    // hashes the two give different partitions
    return Utils.toPositive(hash) % numPartitions;
}

// For account acc-123 with 8 partitions:
// partition = toPositive(murmur2("acc-123")) % 8  (same result on every call)
// Every event for acc-123 always goes to that partition -- as long as the
// partition count stays 8
```

---

## Global Ordering Problem and Alternatives

Global ordering (all messages in one total order) is impossible in a distributed system without a bottleneck:

```
Option A: Single Partition (Global Order — Bottleneck)
  Topic: payments.events (1 partition)
  → All events globally ordered
  → Throughput limited to what ONE partition (one leader broker) can take
  → One consumer thread processes everything
  → The leader broker carries all write load (replicas still give failover)

Option B: Partition-per-Account (Local Order — No Cross-Account Order)
  Topic: payments.events (N partitions, key = accountId)
  → Events for each account are locally ordered
  → Cross-account events have no ordering guarantee
  → Throughput scales roughly with partition count
  → This is the correct approach for most payment use cases

Option C: Sequence Numbers (Application-Level Ordering)
  Topic: payments.events (N partitions, key = accountId)
  → Each event carries a sequence number per account
  → Consumers detect and handle out-of-order delivery
  → Most flexible — works across replicas and regions
```

For the vast majority of financial use cases, **Option B** is correct and sufficient. Cross-account ordering is not a business requirement — what matters is that for a given account, its debit happens before its credit reversal.

---

## Sequence Numbers for Detecting Out-of-Order Events

Application-level sequence numbers allow consumers to detect and handle ordering violations:

```java
// Producer: attach sequence number per account
@Service
public class SequencedAccountEventPublisher {

    @Autowired private AccountSequenceRepository sequenceRepo;
    @Autowired private KafkaProducer<String, String> producer;

    // The sequence number and the event must be written TOGETHER: publish
    // through an outbox row in this transaction (Lesson 06). A direct
    // producer.send() here could fail after the counter was incremented --
    // leaving a GAP that ordered consumers would wait for forever.
    @Transactional
    public void publish(AccountEvent event) {
        // Atomically increment and get the next sequence number for this account:
        // UPDATE account_sequences SET current_sequence = current_sequence + 1
        //  WHERE account_id = ? RETURNING current_sequence
        // (row lock -> concurrent publishers get distinct, gapless numbers)
        long sequenceNumber = sequenceRepo.nextSequenceFor(event.getAccountId());

        SequencedAccountEvent sequencedEvent = SequencedAccountEvent.builder()
                .eventId(event.getEventId())
                .accountId(event.getAccountId())
                .eventType(event.getEventType())
                .payload(event.toJson())
                .sequenceNumber(sequenceNumber)
                .occurredAt(event.getOccurredAt())
                .build();

        ProducerRecord<String, String> record = new ProducerRecord<>(
                "account-events",
                event.getAccountId(),
                objectMapper.writeValueAsString(sequencedEvent)
        );

        outbox.save(record);   // relayed to Kafka by CDC / outbox relay
    }
}

@Entity
@Table(name = "account_sequences")
public class AccountSequence {
    @Id
    private String accountId;

    @Column(name = "current_sequence")
    private long currentSequence;

    public long nextSequence() {
        return ++currentSequence;
    }
}
```

### Consumer: Detecting Out-of-Order Events

```java
@Component
public class OrderEnforcingAccountConsumer {

    // The last applied sequence per account lives in the PROJECTION DATABASE
    // (same transaction as the projection update) -- not in a HashMap: after
    // a restart or rebalance an in-memory map would be empty, every event
    // would look like "from the future", and processing would stall.
    @Autowired private AccountProjectionService projectionService;
    @Autowired private PendingEventBuffer pendingBuffer;   // durable table, see below

    @KafkaListener(topics = "account-events", groupId = "account-projection")
    @Transactional
    public void consume(ConsumerRecord<String, String> record) {
        SequencedAccountEvent event = parseEvent(record.value());
        String accountId = event.getAccountId();
        long expectedSequence = projectionService.lastAppliedSequence(accountId) + 1;

        if (event.getSequenceNumber() == expectedSequence) {
            // In order — process immediately (updates the stored sequence)
            projectionService.apply(event);

            // Check if buffered events can now be processed
            drainBuffer(accountId);

        } else if (event.getSequenceNumber() > expectedSequence) {
            // Future event arrived before earlier events (possible with
            // sub-partitioned keys or multi-region input). Buffer it in a
            // TABLE -- its offset will be committed, so an in-memory buffer
            // would lose it on a crash -- and alert if the gap stays open.
            log.warn("Out-of-order event for account={} expected={} got={}",
                    accountId, expectedSequence, event.getSequenceNumber());
            pendingBuffer.add(accountId, event);

        } else {
            // Duplicate — already processed this sequence
            log.info("Duplicate event for account={} seq={} — skipping (idempotent)",
                    accountId, event.getSequenceNumber());
        }
    }

    private void drainBuffer(String accountId) {
        while (true) {
            long nextExpected = projectionService.lastAppliedSequence(accountId) + 1;
            SequencedAccountEvent buffered = pendingBuffer.peek(accountId, nextExpected);

            if (buffered == null) break;

            pendingBuffer.remove(accountId, nextExpected);
            projectionService.apply(buffered);
        }
    }
}
```

---

## Ordering in Payment Processing

The critical ordering requirements in payment processing:

```
REQUIREMENT 1: Account events ordered per account
  Debit must be processed before the debit reversal
  Account creation must be processed before any subsequent events
  → Solution: accountId as partition key

REQUIREMENT 2: Payment saga steps ordered per payment
  PaymentInitiated must precede FraudCheckPassed
  FraudCheckPassed must precede FundsTransferred
  → Solution: paymentId as partition key on saga topic

REQUIREMENT 3: Settlement batch ordering
  All transactions in a batch must be processed before the batch is closed
  → Solution: batchId as partition key; sequence numbers for intra-batch ordering

REQUIREMENT 4: Cross-account transfer
  Debit source account THEN credit destination account
  → NOT a Kafka ordering problem — use Saga pattern (Lesson 15)
  → Saga orchestrator ensures the sequence
```

---

## Hot Partition Problem

Using `accountId` as the key works well when accounts have similar volumes. For high-volume merchant accounts, a single account may generate 70% of all events, overloading partition 3 — and since one key always maps to one partition, adding partitions does not help that key:

```
Partition 0: acc-001 to acc-100 → moderate load
Partition 1: acc-101 to acc-200 → moderate load
Partition 2: acc-201 to acc-300 → moderate load
Partition 3: acc-MERCHANT-X     → 70% of all traffic (HOT PARTITION)
```

**Solutions:**

```java
// Option 1: Sub-partition high-volume accounts
public ProducerRecord<String, String> createRecord(AccountEvent event) {
    String accountId = event.getAccountId();
    String partitionKey;

    if (isHighVolumeAccount(accountId)) {
        // Distribute across multiple partitions using a suffix
        int subPartition = (int) (event.getSequenceNumber() % 4);
        partitionKey = accountId + "-" + subPartition;
        // Events may arrive out-of-order — use sequence numbers to reorder
    } else {
        partitionKey = accountId;
    }

    return new ProducerRecord<>("account-events", partitionKey, event.toJson());
}

// Option 2: Separate topic for high-volume accounts -- isolates the noisy
// neighbour so other accounts are not slowed down, but the hot account itself
// still lands on ONE partition of that topic (one key = one partition)
public ProducerRecord<String, String> createRecord(AccountEvent event) {
    String topic = isHighVolumeAccount(event.getAccountId())
            ? "account-events-high-volume"
            : "account-events";

    return new ProducerRecord<>(topic, event.getAccountId(), event.toJson());
}

// Option 3 (often the best): ask whether per-MERCHANT ordering is really
// needed. Usually only per-PAYMENT order matters -- then key by paymentId
// (or merchantId + terminalId) and the load spreads naturally
```

---

## Testing Ordering Guarantees

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.junit.jupiter.api.Test;

class KafkaOrderingGuaranteeTest {

    @Test
    void accountEventsAreConsumedInProducedOrder() throws Exception {
        String accountId = "test-account-" + UUID.randomUUID();
        List<String> producedOrder = new ArrayList<>();
        List<String> consumedOrder = new ArrayList<>();

        // Produce 100 events rapidly
        try (KafkaProducer<String, String> producer = createProducer()) {
            for (int i = 1; i <= 100; i++) {
                String eventJson = buildEvent(accountId, i);
                producedOrder.add(eventJson);
                producer.send(new ProducerRecord<>("account-events", accountId, eventJson));
            }
            producer.flush();
        }

        // Consume all events
        try (KafkaConsumer<String, String> consumer = createConsumer()) {
            consumer.subscribe(List.of("account-events"));
            int received = 0;

            while (received < 100) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(5));
                for (ConsumerRecord<String, String> record : records) {
                    if (record.key().equals(accountId)) {
                        consumedOrder.add(record.value());
                        received++;
                    }
                }
            }
        }

        // Assert ordering
        assertEquals(producedOrder.size(), consumedOrder.size(),
                "All produced events should be consumed");
        assertEquals(producedOrder, consumedOrder,
                "Events should be consumed in the same order they were produced");
    }

    @Test
    void differentAccountsCanBeConsumedConcurrently() throws Exception {
        // Produce events for 4 accounts
        List<String> accountIds = List.of("acc-A", "acc-B", "acc-C", "acc-D");
        Map<String, List<Integer>> producedSequences = new HashMap<>();
        Map<String, List<Integer>> consumedSequences = new ConcurrentHashMap<>();

        try (KafkaProducer<String, String> producer = createProducer()) {
            for (String accountId : accountIds) {
                List<Integer> sequences = new ArrayList<>();
                for (int i = 1; i <= 50; i++) {
                    producer.send(new ProducerRecord<>("account-events",
                            accountId, buildSequencedEvent(accountId, i)));
                    sequences.add(i);
                }
                producedSequences.put(accountId, sequences);
            }
            producer.flush();
        }

        // Consume and verify per-account ordering
        // (cross-account ordering is not guaranteed — this test does not check it)
        try (KafkaConsumer<String, String> consumer = createConsumer()) {
            consumer.subscribe(List.of("account-events"));
            long deadline = System.currentTimeMillis() + 30_000;
            int received = 0;
            while (received < 200 && System.currentTimeMillis() < deadline) {
                for (ConsumerRecord<String, String> r : consumer.poll(Duration.ofSeconds(1))) {
                    if (accountIds.contains(r.key())) {
                        consumedSequences.computeIfAbsent(r.key(), k -> new ArrayList<>())
                            .add(parseSequence(r.value()));
                        received++;
                    }
                }
            }
        }

        for (String accountId : accountIds) {
            List<Integer> sequences = consumedSequences.get(accountId);
            assertEquals(producedSequences.get(accountId), sequences,
                    "All events for " + accountId + " must arrive, in order");
            for (int i = 1; i < sequences.size(); i++) {
                assertTrue(sequences.get(i) > sequences.get(i - 1),
                        "Events for " + accountId + " must be in order");
            }
        }
    }
}
```

---

## Compensation for Out-of-Order Events

Within one partition Kafka does not reorder events, and a rebalance causes *duplicates* (re-delivery from the last commit), not reordering. Out-of-order arrival does happen with sub-partitioned keys, input merged from several regions or topics, or a non-idempotent producer retrying. Design compensating logic — but only where the operation allows it:

```java
@Service
public class OutOfOrderEventCompensator {

    @Autowired private AccountProjectionRepository projectionRepo;

    public void handleOutOfOrderDeposit(FundsDeposited deposit, long expectedSequence) {
        log.warn("Received out-of-order deposit: account={} expected={} got={}",
                deposit.getAccountId(), expectedSequence, deposit.getSequenceNumber());

        // Buffer for a grace period — wait for gap to fill
        // If gap doesn't fill within 5 seconds, it may be a bug
        // In practice: compensate by applying the event and flagging for audit

        AccountProjection projection = projectionRepo.findById(deposit.getAccountId())
                .orElseThrow();

        // Apply deposit even out of order — balance will be correct
        // (addition is commutative — order doesn't matter for the SUM).
        // This is NOT true for order-sensitive events: a withdrawal checked
        // against the balance, an account freeze/close, a status change --
        // those must wait for the gap or go to manual review
        projection.applyDeposit(deposit.getAmount());
        projection.flagForAudit("OUT_OF_ORDER_EVENT_seq=" + deposit.getSequenceNumber());
        projectionRepo.save(projection);

        // Alert ops team for investigation
        alertService.sendAlert(AlertSeverity.MEDIUM,
                String.format("Out-of-order event detected for account %s — audited",
                        deposit.getAccountId()));
    }
}
```

---

## Key Takeaways

- Kafka guarantees ordering only **within a partition** — not across partitions.
- Use the **account ID as the partition key** to ensure all events for an account go to the same partition in the same order.
- Global ordering requires a single partition — a throughput bottleneck. Design to avoid this requirement.
- **Application-level sequence numbers** enable detection and handling of out-of-order events when cross-partition ordering matters.
- Hot partitions from high-volume accounts can be mitigated with sub-partitioning (key suffix) or dedicated high-volume topics.
- Cross-account ordering (debit before credit in a transfer) is not a Kafka problem — use the Saga pattern to enforce sequence.
- Always test ordering guarantees in integration tests: produce events rapidly, consume, verify FIFO per key.
- When out-of-order events occur in production, buffer them durably for a short while; commutative ones (deposits to a sum) can then be applied with an audit flag, order-sensitive ones (withdrawals, status changes) must wait or go to review.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A topic has 8 partitions. All events for account acc-123 use the partition key 'acc-123'. A new service team adds a 9th partition to handle increased load. What happens to ordering for acc-123?",
      "options": [
        "Nothing changes — Kafka maintains the same partition assignment for existing keys",
        "The partition assignment for acc-123 changes because hash('acc-123') % 9 produces a different result than hash('acc-123') % 8, potentially causing new events to go to a different partition than old events",
        "Kafka automatically migrates old events to the new partition to maintain ordering",
        "The key-based partitioner only reassigns new keys; existing keys always stay on the same partition"
      ],
      "correct": 1,
      "explanation": "Kafka's built-in partitioner computes partition = toPositive(murmur2(keyBytes)) % numPartitions. When numPartitions changes, the modulo changes, so the same key may map to a different partition. Old events remain on the original partition while new events go to the new one. A consumer can then process new events for acc-123 before the remaining old ones, because there is no ordering across partitions. Adding partitions to a live topic needs coordination — e.g. drain the topic first, migrate to a new topic, or rely on application-level sequence numbers."
    },
    {
      "text": "A single merchant account generates 70% of all payment events, causing partition 3 to be severely overloaded (hot partition). What is the recommended solution that preserves ordering for the merchant account?",
      "options": [
        "Switch to random partitioning for the merchant account to distribute load evenly",
        "Sub-partition the merchant account using key = merchantId + '-' + (sequenceNumber % N), and use application-level sequence numbers to reorder events within the consumer",
        "Create a separate consumer for partition 3 with more threads to handle the load",
        "Increase the replication factor for partition 3 to distribute read load"
      ],
      "correct": 1,
      "explanation": "Sub-partitioning spreads the merchant's events across N partitions, eliminating the hot partition. Since events for one merchant now go to multiple partitions, Kafka's partition-level ordering guarantee no longer applies across them. Application-level sequence numbers (attached by the producer) allow the consumer to detect and buffer out-of-order events, then process them in the correct sequence. The replication factor and consumer thread count do not affect partition write throughput."
    },
    {
      "text": "In a cross-account transfer (debit source account, then credit destination account), which mechanism enforces that the debit is always processed before the credit?",
      "options": [
        "Using the same partition key for both events so they land on the same partition",
        "The Saga pattern — an orchestrator or choreography ensures the credit event is only published after the debit event is confirmed processed",
        "Setting max.in.flight.requests.per.connection=1 to prevent out-of-order delivery",
        "Using Kafka's global ordering mode by reducing partitions to 1"
      ],
      "correct": 1,
      "explanation": "The debit event (source account) and credit event (destination account) have different account IDs, so they go to different partitions with no ordering guarantee between them. Using the same partition key would force both onto one partition but would not guarantee the cross-service processing order. The Saga pattern solves this at the application level: the credit step is only initiated after the debit service confirms completion, either via orchestration (explicit response) or choreography (listening for a DebitConfirmed event)."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Ordered Account Event Processing with Hot Partition Mitigation",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "Implement a SequencedAccountEventPublisher that atomically increments a per-account sequence number in PostgreSQL (UPDATE ... RETURNING, or SELECT FOR UPDATE) and writes the sequenced event to an outbox table in the same transaction. Write a test that publishes 100 concurrent events for the same account and verifies sequence numbers are unique and gapless.",
    "Implement an OrderEnforcingConsumer that stores the last applied sequence number per account in the projection database (same transaction as the projection update). For in-order events, process immediately. For future events (gap detected), buffer them in a durable table keyed by (account, sequence). For past events (duplicate), skip and log. Write tests covering all three code paths, including a restart in the middle.",
    "Identify a 'hot account' scenario: produce 1,000 events for one merchant account and 100 events each for 10 normal accounts to a 4-partition topic. Measure the per-partition message count. Then implement sub-partitioning for the merchant account (key = merchantId + '-' + (seq % 4)) and re-run, verifying the merchant's events are spread across all 4 partitions.",
    "Write an integration test using EmbeddedKafka that simulates a partition rebalance mid-processing (by closing and reopening the consumer) and verifies that the OrderEnforcingConsumer resumes from the last committed offset without applying any event twice (re-delivered events are recognised by their sequence numbers) and without missing any event."
  ]
}
-->
