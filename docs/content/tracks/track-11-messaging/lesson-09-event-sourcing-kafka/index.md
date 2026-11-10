---
id: track-11-lesson-09
title: "Event Sourcing with Kafka — Event Store Architecture"
slug: event-sourcing-kafka
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 9
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [event-sourcing, event-store, append-only, snapshot, projection]
prerequisites: [kafka-architecture, kafka-exactly-once, outbox-cdc-debezium]
---

# Event Sourcing with Kafka — Event Store Architecture

> [!NOTE]
> Event sourcing is not just an architecture pattern — it is a fundamentally different way of thinking about state in financial systems. Instead of storing the current balance of an account, you store every transaction that led to that balance. This provides perfect auditability, temporal queries, and the ability to rebuild any derived view from first principles. Kafka's compacted topics make it a natural event store for financial aggregates.

## What Event Sourcing Is

Traditional (state-based) persistence stores the **current state** of an entity:

```sql
-- payments table (state-based)
UPDATE accounts SET balance = 9500.00 WHERE id = 'acc-123';
```

The fact that there was a debit of £500 is gone — only the resulting balance survives.

Event sourcing stores the **sequence of events** that led to the current state:

```
Event 1: AccountCreated    { accountId: acc-123, initialBalance: 10000.00 }
Event 2: FundsDeposited    { accountId: acc-123, amount: 500.00 }
Event 3: FundsWithdrawn    { accountId: acc-123, amount: 1000.00 }
Current balance = 10000 + 500 - 1000 = 9500.00
```

The event log **is** the source of truth. The current state is derived.

**Benefits for financial systems:**
- **Complete audit trail** — every change is recorded with who did it and when
- **Temporal queries** — reconstruct balance at any point in time
- **Debugging** — replay the exact sequence of events that led to a problem
- **Projections** — build any read model from the same event stream
- **Compliance** — event log satisfies regulatory requirements (PSD2, SOX)

---

## Kafka as an Event Store

Kafka's log-based storage makes it a natural fit for event sourcing:

| Requirement | Kafka Feature |
|-------------|---------------|
| Append-only storage | Topics are immutable logs |
| Event ordering per aggregate | Partition-per-aggregate or key-based partitioning |
| Replay from beginning | `--offset earliest` |
| Long-term retention | Unlimited retention with compaction |
| Multiple readers | Consumer groups |
| Scalability | Partition-based horizontal scaling |

### Topic Design for Event Sourcing

```
Option A: One topic per aggregate type (recommended for most cases)
  account-events          (all AccountCreated, FundsDeposited, etc.)
  payment-events          (all PaymentCreated, PaymentApproved, etc.)

  Partition key = aggregateId → all events for one account go to same partition
  Ordering guaranteed within partition (= within one aggregate)

Option B: One partition per aggregate (maximum ordering guarantees)
  account-events-{accountId}  (one topic per account)
  — Impractical at scale (millions of accounts = millions of topics)

Option C: Compacted topic (for current-state snapshots)
  account-snapshots       (key = accountId, value = latest snapshot)
  Kafka retains only the latest value per key after compaction
```

**Production recommendation:** Use option A with `account-id` as the partition key. This guarantees ordering per aggregate (all events for account X are in the same partition, in order).

---

## Payment Account Aggregate and Event Types

```java
// Event definitions
public sealed interface AccountEvent {
    String getAccountId();
    String getEventId();
    Instant getOccurredAt();
    long getVersion();
}

public record AccountCreated(
        String accountId,
        String eventId,
        String customerId,
        String accountType,
        BigDecimal initialBalance,
        String currency,
        Instant occurredAt,
        long version
) implements AccountEvent {}

public record FundsDeposited(
        String accountId,
        String eventId,
        BigDecimal amount,
        String reference,
        String channel,
        Instant occurredAt,
        long version
) implements AccountEvent {}

public record FundsWithdrawn(
        String accountId,
        String eventId,
        BigDecimal amount,
        String reference,
        String channel,
        Instant occurredAt,
        long version
) implements AccountEvent {}

public record TransferInitiated(
        String accountId,
        String eventId,
        String destinationAccountId,
        BigDecimal amount,
        String currency,
        String transferId,
        Instant occurredAt,
        long version
) implements AccountEvent {}

public record TransferCompleted(
        String accountId,
        String eventId,
        String transferId,
        BigDecimal amount,
        Instant occurredAt,
        long version
) implements AccountEvent {}

public record TransferFailed(
        String accountId,
        String eventId,
        String transferId,
        String reason,
        Instant occurredAt,
        long version
) implements AccountEvent {}

public record AccountFrozen(
        String accountId,
        String eventId,
        String reason,
        String authorisedBy,
        Instant occurredAt,
        long version
) implements AccountEvent {}

public record AccountClosed(
        String accountId,
        String eventId,
        String reason,
        Instant occurredAt,
        long version
) implements AccountEvent {}
```

---

## Payment Account Aggregate

```java
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

public class AccountAggregate {

    private String accountId;
    private String customerId;
    private BigDecimal balance;
    private String currency;
    private AccountStatus status;
    private long version;

    // Uncommitted events (to be published to Kafka)
    private final List<AccountEvent> uncommittedEvents = new ArrayList<>();

    // Private constructor — use factory methods
    private AccountAggregate() {}

    // --- Command handlers (business logic + validation) ---

    public static AccountAggregate createAccount(
            String customerId, String currency, BigDecimal initialBalance) {
        AccountAggregate account = new AccountAggregate();
        String accountId = UUID.randomUUID().toString();

        AccountCreated event = new AccountCreated(
                accountId, UUID.randomUUID().toString(),
                customerId, "CURRENT", initialBalance, currency,
                Instant.now(), 1L
        );

        account.apply(event);
        account.uncommittedEvents.add(event);
        return account;
    }

    public void depositFunds(BigDecimal amount, String reference, String channel) {
        if (status == AccountStatus.FROZEN) {
            throw new AccountFrozenException("Cannot deposit to frozen account " + accountId);
        }
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new InvalidAmountException("Deposit amount must be positive");
        }

        FundsDeposited event = new FundsDeposited(
                accountId, UUID.randomUUID().toString(),
                amount, reference, channel,
                Instant.now(), version + 1
        );

        apply(event);
        uncommittedEvents.add(event);
    }

    public void withdrawFunds(BigDecimal amount, String reference, String channel) {
        if (status == AccountStatus.FROZEN) {
            throw new AccountFrozenException("Cannot withdraw from frozen account " + accountId);
        }
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new InvalidAmountException("Withdrawal amount must be positive");
        }
        if (balance.compareTo(amount) < 0) {
            throw new InsufficientFundsException(
                    String.format("Balance %s insufficient for withdrawal %s", balance, amount));
        }

        FundsWithdrawn event = new FundsWithdrawn(
                accountId, UUID.randomUUID().toString(),
                amount, reference, channel,
                Instant.now(), version + 1
        );

        apply(event);
        uncommittedEvents.add(event);
    }

    // --- Event application (state mutation — no validation here) ---

    private void apply(AccountEvent event) {
        switch (event) {
            case AccountCreated e -> {
                this.accountId = e.accountId();
                this.customerId = e.customerId();
                this.balance = e.initialBalance();
                this.currency = e.currency();
                this.status = AccountStatus.ACTIVE;
                this.version = e.version();
            }
            case FundsDeposited e -> {
                this.balance = this.balance.add(e.amount());
                this.version = e.version();
            }
            case FundsWithdrawn e -> {
                this.balance = this.balance.subtract(e.amount());
                this.version = e.version();
            }
            case TransferInitiated e -> {
                // Debit the source account
                this.balance = this.balance.subtract(e.amount());
                this.version = e.version();
            }
            case TransferCompleted e -> {
                // Transfer confirmed — balance already debited
                this.version = e.version();
            }
            case TransferFailed e -> {
                // Compensating — refund the debit
                AccountEvent original = findTransferInitiated(e.transferId());
                if (original instanceof TransferInitiated ti) {
                    this.balance = this.balance.add(ti.amount());
                }
                this.version = e.version();
            }
            case AccountFrozen e -> {
                this.status = AccountStatus.FROZEN;
                this.version = e.version();
            }
            case AccountClosed e -> {
                this.status = AccountStatus.CLOSED;
                this.version = e.version();
            }
        }
    }

    // --- Reconstitution from event stream ---

    public static AccountAggregate reconstitute(List<AccountEvent> events) {
        AccountAggregate account = new AccountAggregate();
        for (AccountEvent event : events) {
            account.apply(event);
        }
        return account;
    }

    public List<AccountEvent> getUncommittedEvents() {
        return Collections.unmodifiableList(uncommittedEvents);
    }

    public void clearUncommittedEvents() {
        uncommittedEvents.clear();
    }

    // Getters...
    public String getAccountId() { return accountId; }
    public BigDecimal getBalance() { return balance; }
    public AccountStatus getStatus() { return status; }
    public long getVersion() { return version; }
}
```

---

## Event Store with Kafka

```java
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.clients.consumer.*;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.concurrent.ExecutionException;

@Repository
public class KafkaEventStore {

    private final KafkaProducer<String, String> producer;
    private final KafkaConsumer<String, String> consumer;
    private final ObjectMapper objectMapper;

    private static final String ACCOUNT_EVENTS_TOPIC = "account-events";

    public KafkaEventStore(KafkaProducer<String, String> producer,
                           KafkaConsumer<String, String> consumer,
                           ObjectMapper objectMapper) {
        this.producer = producer;
        this.consumer = consumer;
        this.objectMapper = objectMapper;
    }

    /**
     * Append events to the event store.
     * Uses the accountId as the partition key to ensure ordering.
     */
    public void appendEvents(String accountId, List<AccountEvent> events, long expectedVersion) {
        for (AccountEvent event : events) {
            try {
                String eventJson = objectMapper.writeValueAsString(new EventEnvelope(
                        event.getEventId(),
                        event.getClass().getSimpleName(),
                        event.getAccountId(),
                        objectMapper.writeValueAsString(event),
                        event.getOccurredAt(),
                        event.getVersion()
                ));

                ProducerRecord<String, String> record = new ProducerRecord<>(
                        ACCOUNT_EVENTS_TOPIC,
                        null,           // No explicit partition — key-based routing
                        event.getOccurredAt().toEpochMilli(), // Timestamp
                        accountId,      // Key — determines partition
                        eventJson
                );

                // Synchronous send for event store writes — ordering is critical
                RecordMetadata metadata = producer.send(record).get();
                log.debug("Appended event {} to partition {} offset {}",
                        event.getClass().getSimpleName(),
                        metadata.partition(), metadata.offset());

            } catch (InterruptedException | ExecutionException e) {
                throw new EventStoreException("Failed to append event to Kafka", e);
            } catch (JsonProcessingException e) {
                throw new EventSerializationException("Failed to serialize event", e);
            }
        }
    }

    /**
     * Load all events for an aggregate from the beginning.
     * For high event-count aggregates, use loadFromSnapshot() instead.
     */
    public List<AccountEvent> loadEvents(String accountId) {
        // In a real implementation, use a dedicated consumer per aggregate
        // or a Kafka Streams GlobalKTable for in-memory caching
        // This simplified version shows the concept
        return loadEventsFromOffset(accountId, 0L);
    }

    public List<AccountEvent> loadEventsFromOffset(String accountId, long fromOffset) {
        List<AccountEvent> events = new ArrayList<>();

        // Assign the specific partition for this account
        int partition = resolvePartition(accountId);
        TopicPartition tp = new TopicPartition(ACCOUNT_EVENTS_TOPIC, partition);
        consumer.assign(List.of(tp));
        consumer.seek(tp, fromOffset);

        boolean done = false;
        while (!done) {
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
            for (ConsumerRecord<String, String> record : records) {
                if (record.key().equals(accountId)) {
                    AccountEvent event = deserializeEvent(record.value());
                    events.add(event);
                }
            }
            // Stop when we've caught up to the end of the partition
            done = records.isEmpty() ||
                   consumer.position(tp) >= getEndOffset(tp);
        }

        return events;
    }

    private int resolvePartition(String accountId) {
        // Use Kafka's default partitioner logic
        return Math.abs(accountId.hashCode() % getPartitionCount());
    }

    private AccountEvent deserializeEvent(String json) {
        try {
            EventEnvelope envelope = objectMapper.readValue(json, EventEnvelope.class);
            return switch (envelope.eventType()) {
                case "AccountCreated"    -> objectMapper.readValue(envelope.payload(), AccountCreated.class);
                case "FundsDeposited"    -> objectMapper.readValue(envelope.payload(), FundsDeposited.class);
                case "FundsWithdrawn"    -> objectMapper.readValue(envelope.payload(), FundsWithdrawn.class);
                case "TransferInitiated" -> objectMapper.readValue(envelope.payload(), TransferInitiated.class);
                case "TransferCompleted" -> objectMapper.readValue(envelope.payload(), TransferCompleted.class);
                case "TransferFailed"    -> objectMapper.readValue(envelope.payload(), TransferFailed.class);
                case "AccountFrozen"     -> objectMapper.readValue(envelope.payload(), AccountFrozen.class);
                case "AccountClosed"     -> objectMapper.readValue(envelope.payload(), AccountClosed.class);
                default -> throw new UnknownEventTypeException(envelope.eventType());
            };
        } catch (JsonProcessingException e) {
            throw new EventDeserializationException("Failed to deserialize event", e);
        }
    }
}
```

---

## Snapshot Strategy

Replaying thousands of events on every load is expensive. Use snapshots to avoid full replay:

```java
public record AccountSnapshot(
        String accountId,
        BigDecimal balance,
        String currency,
        AccountStatus status,
        long version,           // The event version this snapshot represents
        long kafkaOffset,       // The Kafka offset this snapshot was taken at
        Instant createdAt
) {}

@Repository
public class AccountRepository {

    @Autowired private KafkaEventStore eventStore;
    @Autowired private SnapshotStore snapshotStore;

    private static final int SNAPSHOT_THRESHOLD = 50; // Snapshot every 50 events

    public AccountAggregate load(String accountId) {
        // 1. Try to load from snapshot
        Optional<AccountSnapshot> snapshot = snapshotStore.findLatest(accountId);

        AccountAggregate account;
        long fromOffset;

        if (snapshot.isPresent()) {
            AccountSnapshot s = snapshot.get();
            account = AccountAggregate.reconstitute(s); // Reconstitute from snapshot
            fromOffset = s.kafkaOffset() + 1;            // Load only events after snapshot
        } else {
            account = null;
            fromOffset = 0L;                             // Full replay
        }

        // 2. Load and apply events since snapshot
        List<AccountEvent> events = eventStore.loadEventsFromOffset(accountId, fromOffset);

        if (account == null) {
            account = AccountAggregate.reconstitute(events);
        } else {
            for (AccountEvent event : events) {
                account.applyEvent(event);
            }
        }

        return account;
    }

    public void save(AccountAggregate account) {
        List<AccountEvent> events = account.getUncommittedEvents();
        eventStore.appendEvents(account.getAccountId(), events, account.getVersion());
        account.clearUncommittedEvents();

        // Create snapshot if we've exceeded the threshold
        if (account.getVersion() % SNAPSHOT_THRESHOLD == 0) {
            snapshotStore.save(AccountSnapshot.from(account));
            log.info("Created snapshot for account {} at version {}",
                    account.getAccountId(), account.getVersion());
        }
    }
}
```

---

## Projection Building

Projections are read models built by consuming the event stream. Each consumer group represents one projection:

```java
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Account Balance Projection — maintains a denormalized balance table
 * for fast queries without replaying the full event stream.
 */
@Component
public class AccountBalanceProjection {

    @Autowired private AccountBalanceRepository balanceRepository;

    @KafkaListener(
        topics = "account-events",
        groupId = "account-balance-projection",
        containerFactory = "kafkaListenerContainerFactory"
    )
    @Transactional
    public void handleEvent(ConsumerRecord<String, String> record) {
        EventEnvelope envelope = deserialize(record.value());

        switch (envelope.eventType()) {
            case "AccountCreated" -> {
                AccountCreated event = deserialize(envelope, AccountCreated.class);
                AccountBalanceView view = new AccountBalanceView(
                        event.accountId(), event.customerId(),
                        event.initialBalance(), event.currency(),
                        "ACTIVE", event.occurredAt(), event.version()
                );
                balanceRepository.save(view);
            }
            case "FundsDeposited" -> {
                FundsDeposited event = deserialize(envelope, FundsDeposited.class);
                balanceRepository.incrementBalance(event.accountId(), event.amount());
                balanceRepository.updateVersion(event.accountId(), event.version());
            }
            case "FundsWithdrawn", "TransferInitiated" -> {
                FundsWithdrawn event = deserialize(envelope, FundsWithdrawn.class);
                balanceRepository.decrementBalance(event.accountId(), event.amount());
                balanceRepository.updateVersion(event.accountId(), event.version());
            }
            case "AccountFrozen" -> {
                AccountFrozen event = deserialize(envelope, AccountFrozen.class);
                balanceRepository.updateStatus(event.accountId(), "FROZEN");
            }
        }
    }
}

/**
 * Transaction History Projection — append-only record of all transactions.
 * Used for account statement queries.
 */
@Component
public class TransactionHistoryProjection {

    @Autowired private TransactionHistoryRepository historyRepository;

    @KafkaListener(
        topics = "account-events",
        groupId = "transaction-history-projection"
    )
    @Transactional
    public void handleEvent(ConsumerRecord<String, String> record) {
        EventEnvelope envelope = deserialize(record.value());

        switch (envelope.eventType()) {
            case "FundsDeposited" -> {
                FundsDeposited event = deserialize(envelope, FundsDeposited.class);
                historyRepository.save(TransactionHistoryEntry.credit(
                        event.accountId(), event.amount(),
                        event.reference(), event.channel(), event.occurredAt()
                ));
            }
            case "FundsWithdrawn" -> {
                FundsWithdrawn event = deserialize(envelope, FundsWithdrawn.class);
                historyRepository.save(TransactionHistoryEntry.debit(
                        event.accountId(), event.amount(),
                        event.reference(), event.channel(), event.occurredAt()
                ));
            }
            case "TransferInitiated" -> {
                TransferInitiated event = deserialize(envelope, TransferInitiated.class);
                historyRepository.save(TransactionHistoryEntry.transfer(
                        event.accountId(), event.destinationAccountId(),
                        event.amount(), event.currency(),
                        event.transferId(), event.occurredAt()
                ));
            }
        }
    }
}
```

---

## Idempotent Projection Updates

Consumers must handle redelivery. Use the event's `version` as an optimistic lock:

```java
@Repository
public class AccountBalanceRepository {

    @Autowired private JdbcTemplate jdbc;

    @Transactional
    public void incrementBalance(String accountId, BigDecimal amount, long expectedVersion) {
        // Idempotent: only update if our version is ahead
        int updated = jdbc.update(
            "UPDATE account_balances " +
            "SET balance = balance + ?, version = ? " +
            "WHERE account_id = ? AND version < ?",
            amount, expectedVersion, accountId, expectedVersion
        );

        if (updated == 0) {
            log.debug("Skipping already-applied event for account {} version {}",
                    accountId, expectedVersion);
        }
    }
}
```

---

## Compensating Events

In event sourcing, you never delete or modify events. When a mistake is made, you emit a **compensating event**:

```java
// A payment was incorrectly credited — issue a correction event
public void correctIncorrectCredit(String accountId, BigDecimal incorrectAmount,
        String originalEventId, String reason) {
    // Do NOT delete the FundsDeposited event
    // Issue a compensating withdrawal
    FundsWithdrawn correction = new FundsWithdrawn(
            accountId, UUID.randomUUID().toString(),
            incorrectAmount,
            "CORRECTION:" + originalEventId,
            "BACKOFFICE",
            Instant.now(),
            currentVersion + 1
    );

    eventStore.appendEvents(accountId, List.of(correction), currentVersion);
    log.info("Issued compensating event for incorrect credit {} on account {}",
            originalEventId, accountId);
}
```

---

## Key Takeaways

- Event sourcing stores the sequence of events, not the current state — the current state is always derived.
- Kafka's compacted topics make it a natural event store: append-only, replay capable, multi-consumer.
- Use `aggregateId` as the partition key to guarantee ordering of events per aggregate.
- Aggregates separate **command handlers** (business logic + validation) from **event appliers** (state mutation only).
- Snapshots every N events prevent full replay from the beginning — critical for high-event-count aggregates.
- Each projection is a separate consumer group — the same event stream can power multiple read models.
- Projections must be idempotent — use event version as an optimistic lock.
- **Never delete or modify events** — use compensating events for corrections.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "In event sourcing, what is the source of truth for an aggregate's current state?",
      "options": [
        "The latest snapshot stored in a snapshot store",
        "The current-state table updated by projections",
        "The append-only sequence of events in the event log",
        "The in-memory representation held by the aggregate service"
      ],
      "correct": 2,
      "explanation": "In event sourcing, the event log is the source of truth. The current state is always derived by replaying events. Snapshots are a performance optimization only — they are not authoritative."
    },
    {
      "text": "Why is using the account ID as the Kafka partition key critical for event sourcing?",
      "options": [
        "It ensures even load distribution across all partitions",
        "It guarantees that all events for the same aggregate are in the same partition and therefore ordered",
        "It enables GlobalKTable lookups for account metadata",
        "It allows multiple consumers to process the same account simultaneously"
      ],
      "correct": 1,
      "explanation": "Kafka guarantees ordering only within a partition. Using the aggregate ID (e.g., accountId) as the partition key ensures all events for one aggregate land in the same partition and are consumed in production order — a fundamental requirement for correct state reconstruction."
    },
    {
      "text": "How should incorrect financial events be corrected in an event-sourced system?",
      "options": [
        "Delete the incorrect event from the Kafka topic using admin tools",
        "Update the event payload using the topic compaction mechanism",
        "Issue a compensating event that reverses the effect of the incorrect event",
        "Roll back the Kafka offset to before the incorrect event and re-produce"
      ],
      "correct": 2,
      "explanation": "Events in an event-sourced system are immutable — you never delete or modify them. Corrections are made by appending a compensating event (e.g., a FundsWithdrawn event to correct an incorrect FundsDeposited), maintaining the complete, auditable history."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build an Event-Sourced Account Aggregate with Kafka",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Implement an AccountAggregate class with sealed AccountEvent interface (AccountCreated, FundsDeposited, FundsWithdrawn, AccountFrozen). Separate command handlers (business validation) from event appliers (pure state mutation). Implement the reconstitute(List<AccountEvent>) static factory method."},
    {"id": "2", "description": "Build a KafkaEventStore that appends events to the 'account-events' topic using the accountId as the partition key with synchronous sends. Implement loadEventsFromOffset(accountId, fromOffset) that seeks to the correct partition offset and reads only events matching the given accountId."},
    {"id": "3", "description": "Add a snapshot strategy: take a snapshot every 50 events using an AccountSnapshot record (accountId, balance, status, version, kafkaOffset). Implement the AccountRepository.load() method to first check for a snapshot, then load only the delta events since the snapshot offset."},
    {"id": "4", "description": "Build an AccountBalanceProjection consumer group that maintains a denormalized account_balances table. Use the event version as an optimistic lock in UPDATE statements (WHERE version < :newVersion) to ensure idempotent processing of redelivered events."}
  ]
}
-->
