---
id: track-11-lesson-18
title: "Message Ordering — Global vs Partition-Level Guarantees"
slug: message-ordering
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 18
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [message-ordering, partition-key, global-order, sequence-number]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
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
        // Kafka's default partitioner: partition = hash(key) % numPartitions
        producer.send(record);
    }
}
```

```java
// Verifying partition assignment for a given key
public int calculatePartition(String key, int numPartitions) {
    // Kafka's DefaultPartitioner uses murmur2 hash
    int hash = Utils.murmur2(key.getBytes(StandardCharsets.UTF_8));
    return Math.abs(hash % numPartitions);
}

// For account acc-123 with 8 partitions:
// partition = abs(murmur2("acc-123") % 8) = 3  (consistent across all calls)
// Every event for acc-123 always goes to partition 3
```

---

## Global Ordering Problem and Alternatives

Global ordering (all messages in one total order) is impossible in a distributed system without a bottleneck:

```
Option A: Single Partition (Global Order — Bottleneck)
  Topic: payments.events (1 partition)
  → All events globally ordered
  → Max throughput: ~100MB/s on a single broker
  → Single broker handles all payment events
  → Single point of failure for payment processing

Option B: Partition-per-Account (Local Order — No Cross-Account Order)
  Topic: payments.events (N partitions, key = accountId)
  → Events for each account are locally ordered
  → Cross-account events have no ordering guarantee
  → Throughput scales linearly with partition count
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

    @Transactional
    public void publish(AccountEvent event) {
        // Atomically increment and get the next sequence number for this account
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

        producer.send(record);
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

    // Track last processed sequence per account
    private final ConcurrentHashMap<String, Long> lastProcessedSequence
            = new ConcurrentHashMap<>();

    @Autowired private PendingEventBuffer pendingBuffer;
    @Autowired private AccountProjectionService projectionService;

    @KafkaListener(topics = "account-events", groupId = "account-projection")
    public void consume(ConsumerRecord<String, String> record) {
        SequencedAccountEvent event = parseEvent(record.value());
        String accountId = event.getAccountId();
        long expectedSequence = lastProcessedSequence.getOrDefault(accountId, 0L) + 1;

        if (event.getSequenceNumber() == expectedSequence) {
            // In order — process immediately
            processEvent(event);
            lastProcessedSequence.put(accountId, event.getSequenceNumber());

            // Check if buffered events can now be processed
            drainBuffer(accountId);

        } else if (event.getSequenceNumber() > expectedSequence) {
            // Future event arrived before earlier events
            // Buffer it and wait for the gap to be filled
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
            long nextExpected = lastProcessedSequence.getOrDefault(accountId, 0L) + 1;
            SequencedAccountEvent buffered = pendingBuffer.peek(accountId, nextExpected);

            if (buffered == null) break;

            pendingBuffer.remove(accountId, nextExpected);
            processEvent(buffered);
            lastProcessedSequence.put(accountId, buffered.getSequenceNumber());
        }
    }

    private void processEvent(SequencedAccountEvent event) {
        projectionService.apply(event);
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

Using `accountId` as the key works well when accounts have similar volumes. For high-volume merchant accounts, a single account may generate 70% of all events, overloading partition 3:

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

// Option 2: Separate topic for high-volume accounts
public ProducerRecord<String, String> createRecord(AccountEvent event) {
    String topic = isHighVolumeAccount(event.getAccountId())
            ? "account-events-high-volume"  // Dedicated topic with more partitions
            : "account-events";

    return new ProducerRecord<>(topic, event.getAccountId(), event.toJson());
}
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
        // ... consume and verify each account's sequence is monotonically increasing
        for (String accountId : accountIds) {
            List<Integer> sequences = consumedSequences.get(accountId);
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

In rare cases (partition rebalance during lag, multi-region consumption), events may arrive out of order. Design compensating logic:

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
        // (addition is commutative — order doesn't matter for balance calculation)
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
- When out-of-order events occur in production, buffer briefly (5–10 seconds), then apply with an audit flag — prioritise system availability over ordering perfection.

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
      "explanation": "Kafka's default partitioner computes partition = abs(murmur2(key) % numPartitions). When numPartitions changes, the modulo changes, so the same key may hash to a different partition. Old events remain on the original partition while new events go to the new one. A consumer reading all events for acc-123 will now read from two partitions, and cross-partition ordering is not guaranteed. Adding partitions to a live topic requires careful coordination — rekey events or use application-level sequence numbers."
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
    "Implement a SequencedAccountEventPublisher that atomically increments a per-account sequence number in PostgreSQL (using SELECT FOR UPDATE) and attaches it to every event before publishing to Kafka. Write a test that publishes 100 concurrent events for the same account and verifies sequence numbers are unique and gapless.",
    "Implement an OrderEnforcingConsumer that tracks the last processed sequence number per account in a ConcurrentHashMap. For in-order events, process immediately. For future events (gap detected), buffer in a priority queue keyed by sequence number. For past events (duplicate), skip and log. Write tests covering all three code paths.",
    "Identify a 'hot account' scenario: produce 1,000 events for one merchant account and 100 events each for 10 normal accounts to a 4-partition topic. Measure the per-partition message count. Then implement sub-partitioning for the merchant account (key = merchantId + '-' + (seq % 4)) and re-run, verifying the merchant's events are spread across all 4 partitions.",
    "Write an integration test using EmbeddedKafka that simulates a partition rebalance mid-processing (by closing and reopening the consumer) and verifies that the OrderEnforcingConsumer correctly resumes from the last committed offset without processing any event twice or missing any event, using the sequence numbers to validate completeness."
  ]
}
-->
