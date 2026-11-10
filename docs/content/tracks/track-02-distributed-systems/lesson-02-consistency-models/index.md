---
id: track-02-lesson-02
title: "Consistency Models — Strong, Eventual, and Causal"
slug: consistency-models
track: track-02
trackName: "Distributed Systems Engineering"
sequence: 2
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [consistency, linearisability, eventual-consistency, causal-consistency, monotonic-reads]
prerequisites: []
---

# Consistency Models — Strong, Eventual, and Causal

> [!NOTE]
> When a customer's payment is processed, they expect to see the updated balance immediately. When a fraudster's card is blocked, every payment terminal in the world must reflect that decision within milliseconds. These are not the same consistency requirement. Understanding the spectrum from strong to eventual consistency — and knowing which model applies to which data in a financial system — is foundational to distributed systems engineering in fintech.

## Why Consistency Models Matter

A "consistency model" specifies the guarantees that a distributed storage system provides about the ordering and visibility of operations. The wrong model for the wrong data produces:

- **Too strong**: Unnecessary latency and reduced availability (sacrificing the "A" in CAP when it was not required)
- **Too weak**: Stale reads that cause incorrect business decisions — a customer sees an old balance and over-draws; a fraud rule references data that is 500ms stale

The challenge is that real financial systems have dozens of data entities, each with different consistency requirements. The skill is mapping the right model to each entity.

```
Consistency Spectrum (strongest -> weakest):

Linearisability (strong)
       |   Every operation appears instantaneous at some point
       |   between its start and end. All observers agree on order.
       |
Sequential Consistency
       |   Operations occur in some sequential order consistent
       |   with per-process program order.
       |
Causal Consistency
       |   Causally related operations are seen in causal order.
       |   Concurrent (causally unrelated) operations may be seen
       |   in any order.
       |
Session Consistency (Read-Your-Writes, Monotonic Reads)
       |   Within a session, a client sees its own writes and
       |   never reads older values than previously read.
       |
Eventual Consistency (weakest practical model)
           If no new updates occur, all replicas eventually
           converge to the same value. No timing guarantees.
```

---

## Linearisability (Strong Consistency)

**Linearisability** (also called atomic consistency) is the gold standard: every operation appears to execute instantaneously at a single point in time between its invocation and response. All clients, regardless of which replica they connect to, see a consistent history.

### What Linearisability Guarantees

```
Scenario: Two clients read and write account balance

Timeline (time flows right):
Client A: [ write balance=£500 ────────────────────▶ ]
Client B:                     [ read balance ──▶ ]

Linearisable guarantee: Client B MUST see £500.
The write completed before B's read started.
If B sees £400, the system is NOT linearisable.
```

```java
// Linearisability in a payment system: balance updates
// PostgreSQL with SERIALIZABLE isolation provides linearisability
// for the operations within a transaction

@Service
public class BalanceService {

    private final DataSource dataSource;

    /**
     * Read the current balance and debit atomically.
     * With SERIALIZABLE isolation, this is linearisable:
     * no other transaction can modify the balance between
     * our read and write.
     */
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public DebitResult debit(String accountId, BigDecimal amount) {
        try (Connection conn = dataSource.getConnection()) {
            // Lock the row to prevent concurrent modifications
            PreparedStatement lock = conn.prepareStatement(
                "SELECT balance, currency FROM accounts " +
                "WHERE account_id = ? FOR UPDATE NOWAIT"
            );
            lock.setString(1, accountId);
            ResultSet rs = lock.executeQuery();

            if (!rs.next()) {
                throw new AccountNotFoundException(accountId);
            }

            BigDecimal currentBalance = rs.getBigDecimal("balance");
            String currency = rs.getString("currency");

            if (currentBalance.compareTo(amount) < 0) {
                return DebitResult.insufficientFunds(currentBalance, amount);
            }

            BigDecimal newBalance = currentBalance.subtract(amount);

            PreparedStatement update = conn.prepareStatement(
                "UPDATE accounts SET balance = ?, " +
                "version = version + 1, updated_at = NOW() " +
                "WHERE account_id = ?"
            );
            update.setBigDecimal(1, newBalance);
            update.setString(2, accountId);
            int rows = update.executeUpdate();

            if (rows != 1) {
                throw new OptimisticLockException(
                    "Account modified concurrently: " + accountId
                );
            }

            return DebitResult.success(newBalance, currency);
        }
    }
}
```

### Where Linearisability is Required in Fintech

- **Account balances**: The balance must reflect all committed transactions
- **Payment status transitions**: A payment cannot be in two states simultaneously
- **Idempotency key registry**: "Has this payment reference been seen before?"
- **Fraud rule enforcement**: A blocked card must be seen as blocked by all systems immediately
- **Distributed locks**: Acquiring a lock means no other process holds it

**Cost of linearisability**: It requires coordination between replicas (consensus protocol or single-master reads). This introduces latency proportional to the number of round-trips required. For a database cluster spanning two data centres 50ms apart, linearisable reads may add 50-100ms of latency per operation.

---

## Sequential Consistency

Sequential consistency is weaker than linearisability: operations must appear in some sequential order that is consistent with the order each individual process submitted them, but the interleaving of operations from different processes can be arbitrary.

```
Sequential Consistency vs Linearisability:

Linearisable:
  Real-time order is preserved. If write W completes before read R starts,
  R must observe W.

Sequentially consistent:
  Each process's operations appear in order, but the global ordering
  need not respect real time.

Client A: write(x=1)   ...   write(x=2)
Client B:          read(x)=1  ...  read(x)=2  <- Sequential: OK (B sees A's writes in order)
Client C:          read(x)=2  ...  read(x)=1  <- Sequential: VIOLATION (C sees newer value first)
```

Sequential consistency is rarely used as an explicit model in databases; it appears more often in CPU memory models and hardware. For financial systems, the practical choice is usually between linearisability (for critical data) and causal/eventual (for less critical data).

---

## Causal Consistency

**Causal consistency** captures the intuition: "if you know about X, you should see anything that causally depends on X." Operations that have a causal relationship are seen in causal order. Concurrent operations (no causal link) may be seen in different orders by different processes.

This is weaker than linearisability but stronger than eventual consistency, and it is achievable with lower latency because it does not require global coordination.

### Causal Relationships in Payments

```
Causal dependency chain in a payment flow:

1. Customer submits payment P1          -> event E1
2. Fraud service approves P1            -> event E2 (causally depends on E1)
3. Balance is debited for P1            -> event E3 (causally depends on E2)
4. Confirmation notification sent       -> event E4 (causally depends on E3)

Causal consistency guarantee:
Any observer that sees E4 (the notification) MUST also see E3 (the debit),
E2 (fraud approval), and E1 (the original submission).

It would be a violation to send a "Payment confirmed" notification to a 
customer whose balance was not yet debited in the system-of-record.
```

### Implementing Causal Consistency with Vector Clocks

```java
// Causal consistency tracking using vector clocks
// Each event carries the causal dependencies it observed

public record CausalEvent(
    String eventId,
    String eventType,
    Map<String, Long> vectorClock,  // {serviceId -> logicalTimestamp}
    Object payload,
    Instant wallClock
) {
    /**
     * Check if this event causally depends on another event.
     * this -> other means: this event cannot have caused other.
     */
    public boolean happensBefore(CausalEvent other) {
        return other.vectorClock().entrySet().stream()
            .allMatch(entry ->
                this.vectorClock.getOrDefault(entry.getKey(), 0L)
                    <= entry.getValue()
            )
            && !this.vectorClock.equals(other.vectorClock());
    }

    public boolean isConcurrentWith(CausalEvent other) {
        return !this.happensBefore(other) && !other.happensBefore(this);
    }
}

@Service
public class CausalEventProcessor {

    private final Map<String, Long> localClock = new ConcurrentHashMap<>();
    private final String serviceId;

    /**
     * Process an incoming event, ensuring causal dependencies are satisfied
     * before the event is applied to local state.
     */
    public void processEvent(CausalEvent event) {
        // Wait until all causally-prior events have been processed
        // In production, this would use a proper causal barrier implementation
        waitForCausalDependencies(event);

        // Merge vector clock
        event.vectorClock().forEach((svcId, ts) ->
            localClock.merge(svcId, ts, Math::max)
        );

        applyToLocalState(event);
    }

    public CausalEvent createEvent(String eventType, Object payload) {
        // Increment our local clock
        long newTimestamp = localClock.merge(serviceId, 1L, Long::sum);

        return new CausalEvent(
            UUID.randomUUID().toString(),
            eventType,
            new HashMap<>(localClock),
            payload,
            Instant.now()
        );
    }
}
```

### Practical Causal Consistency in Financial Event Streams

Kafka partitioning provides a form of causal consistency: events for the same account (same partition key) are always processed in order. Events across accounts may be processed concurrently.

```java
@Component
public class PaymentEventConsumer {

    /**
     * Kafka ensures causal ordering within a partition (per-accountId).
     * All events for account ACC-001 are processed sequentially.
     * Events for different accounts are processed concurrently.
     */
    @KafkaListener(topics = "payment-events",
                   containerFactory = "paymentEventContainerFactory")
    public void consumePaymentEvent(
            @Payload PaymentEvent event,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            Acknowledgment ack) {

        // The partition key (accountId) guarantees causal ordering per account
        try {
            processEvent(event);
            ack.acknowledge();
        } catch (OutOfOrderEventException ex) {
            // This event arrived before its causal predecessor was processed
            // Requeue with delay or use a causal buffer
            log.warn("Out-of-order event {}: expected sequence {} but got {}",
                      event.eventId(), ex.expectedSequence(), event.sequence());
            ack.nack(Duration.ofMillis(100));
        }
    }
}
```

---

## Eventual Consistency

**Eventual consistency** provides only one guarantee: if no new updates are made to a value, all replicas will eventually converge to the same value. It offers no bound on when convergence will occur.

This is the weakest practical model and the one that enables the highest availability. Many financial data types tolerate eventual consistency perfectly well.

### Where Eventual Consistency Is Appropriate in Fintech

- **Transaction history (read models)**: Displaying the last 90 days of transactions; a 2-second lag is unnoticeable to users
- **Analytics dashboards**: Merchant revenue reports, portfolio valuations, risk reports
- **Notification delivery status**: Whether an email was opened is not financially material
- **Reference data**: Exchange rates, BIC/IBAN lookup tables (updated periodically)
- **Search indexes**: Full-text search over customer records; a 500ms lag is acceptable

```java
// Read model for transaction history — eventually consistent
// Populated asynchronously from the event stream; reads from replica

@Repository
public class TransactionHistoryReadModel {

    private final JdbcTemplate replicaJdbc;

    /**
     * This read model is populated asynchronously by the transaction
     * history projection. It may be 1-2 seconds behind the write model.
     * This is acceptable for display purposes.
     */
    public Page<TransactionSummary> getHistory(String accountId,
                                                Pageable pageable) {
        return replicaJdbc.query(
            "SELECT t.transaction_id, t.amount, t.currency, " +
            "       t.transaction_type, t.counterparty_name, " +
            "       t.description, t.transaction_date, t.balance_after " +
            "FROM transaction_history_view t " +
            "WHERE t.account_id = ? " +
            "ORDER BY t.transaction_date DESC " +
            "LIMIT ? OFFSET ?",
            transactionSummaryMapper,
            accountId, pageable.getPageSize(), pageable.getOffset()
        );
    }
}
```

---

## Session Consistency: Monotonic Reads and Read-Your-Writes

Session consistency properties are the most practically important guarantees for user-facing financial applications.

### Read-Your-Writes

A client must always see the effects of its own writes. After a customer submits a payment, they must see that payment in their transaction history — even if the read replica has not yet caught up.

```java
@Service
public class SessionConsistentAccountService {

    private final AccountRepository       primaryRepo;    // writes + RYW reads
    private final AccountRepository       replicaRepo;    // other reads
    private final SessionReadVersionStore sessionStore;

    public PaymentResult submitPayment(String customerId,
                                        PaymentRequest request) {
        PaymentResult result = paymentService.process(request);

        // Record the write position so reads-after-write are routed to primary
        long writePosition = primaryRepo.getCurrentSequence();
        sessionStore.recordWrite(customerId, writePosition);

        return result;
    }

    public List<Transaction> getRecentTransactions(String customerId) {
        Long requiredPosition = sessionStore.getLastWritePosition(customerId);

        if (requiredPosition == null) {
            // No recent write — read from replica is safe
            return replicaRepo.getRecentTransactions(customerId);
        }

        // Check if replica has caught up to the required position
        long replicaPosition = replicaRepo.getCurrentSequence();
        if (replicaPosition >= requiredPosition) {
            sessionStore.clearWrite(customerId);  // Replica is current
            return replicaRepo.getRecentTransactions(customerId);
        }

        // Replica hasn't caught up yet — read from primary to satisfy RYW
        log.debug("Routing RYW read to primary for customer {}: " +
                   "required={}, replica={}", customerId,
                   requiredPosition, replicaPosition);
        return primaryRepo.getRecentTransactions(customerId);
    }
}
```

### Monotonic Reads

Once a client has read a value at time T, it must never subsequently read a value from before time T. This prevents a confusing user experience where a customer's balance appears to go backwards.

```java
@Component
public class MonotonicReadTracker {

    private final Map<String, Long> sessionReadTimestamps =
        new ConcurrentHashMap<>();

    /**
     * Ensure reads for a session never go backwards in time.
     * If the client's last read saw state at T, we must only return
     * state at T or later.
     */
    public BigDecimal getBalance(String accountId, String sessionId) {
        Long lastReadTimestamp = sessionReadTimestamps.get(sessionId);

        AccountSnapshot snapshot = lastReadTimestamp != null
            ? accountRepo.findSnapshotAfter(accountId, lastReadTimestamp)
            : accountRepo.findCurrentSnapshot(accountId);

        // Update the session's high-water mark
        sessionReadTimestamps.put(sessionId,
            Math.max(
                lastReadTimestamp != null ? lastReadTimestamp : 0L,
                snapshot.timestamp()
            )
        );

        return snapshot.balance();
    }
}
```

---

## Consistency in Practice: A Financial System Map

```
Financial System Consistency Requirements:

Entity                     Required Model        Rationale
─────────────────────────────────────────────────────────────────────
Account balance            Linearisable          Prevents double-spending
Payment status             Linearisable          Cannot be in two states
Idempotency key registry   Linearisable          Must prevent duplicate processing
Fraud block list           Linearisable + sync   Blocked card must be seen globally
Distributed lock           Linearisable          By definition of a lock

Customer preferences       Causal                Changes propagate causally
Session state              Read-your-writes      Customer sees own changes
Notification preferences   Eventual              Delay is acceptable

Transaction history        Monotonic + eventual  Never goes backwards; lag OK
Analytics dashboards       Eventual              30-min lag acceptable
Search indexes             Eventual              500ms lag acceptable
Reference data (BIC/IBAN)  Eventual              Updated hourly
```

---

## SQL: Consistency Control in PostgreSQL

```sql
-- Transaction isolation levels and their consistency guarantees

-- READ COMMITTED (default): protects against dirty reads
-- Does NOT protect against non-repeatable reads or phantom reads
-- Suitable for: read-only queries where stale reads are acceptable
BEGIN ISOLATION LEVEL READ COMMITTED;
    SELECT balance FROM accounts WHERE account_id = 'ACC-001';
COMMIT;

-- REPEATABLE READ: protects against dirty and non-repeatable reads
-- A snapshot is taken at transaction start; all reads see that snapshot
-- Suitable for: balance reports that must be internally consistent
BEGIN ISOLATION LEVEL REPEATABLE READ;
    SELECT SUM(balance) FROM accounts WHERE customer_id = 'CUST-001';
    -- Even if another transaction updates a balance here, we see the original
COMMIT;

-- SERIALIZABLE: strongest isolation, full linearisability within transactions
-- Serialises all concurrent transactions as if they ran one at a time
-- Required for: balance debits, payment processing, any read-modify-write
BEGIN ISOLATION LEVEL SERIALIZABLE;
    SELECT balance FROM accounts WHERE account_id = 'ACC-001' FOR UPDATE;
    UPDATE accounts SET balance = balance - 500 WHERE account_id = 'ACC-001';
    INSERT INTO ledger_entries (account_id, amount, type) VALUES ('ACC-001', -500, 'DEBIT');
COMMIT;

-- Advisory locks for distributed coordination (complement to row locks)
-- Useful for: ensuring only one process performs a migration step at a time
SELECT pg_try_advisory_lock(hashtext('payment-settlement-job-20240115'));
-- Returns true if lock was acquired, false if another process holds it
```

---

## Common Pitfalls

**1. Using Eventual Consistency for Financial-Critical Data**
Applying eventual consistency to account balances because "it scales better" is a critical error. A stale balance read in an eventually consistent system can allow a customer to spend the same money twice before the system converges. Balance data must be strongly consistent.

**2. Assuming Read Replicas are Acceptable for All Reads**
PostgreSQL read replicas have a replication lag (typically milliseconds, but can grow under load). Routing all reads to replicas for performance, without understanding which reads require read-your-writes guarantees, produces subtle and intermittent bugs that are hard to reproduce.

**3. Confusing ACID with Consistency Model**
ACID transactions guarantee consistency within a single node. Distributing data across multiple nodes (sharding, replication, multi-region) creates a separate layer of consistency concerns that ACID alone does not address.

**4. Ignoring the Network Partition Scenario**
Eventual consistency proponents often present it as "the same as strong consistency but faster." During a network partition between data centres, an eventually consistent system will serve stale reads. For a financial system, stale balance reads during a partition event can cause real financial harm.

**5. Not Documenting the Consistency Model per Data Entity**
Teams that do not document which consistency model applies to each data entity will make inconsistent choices over time. New engineers joining the team will add reads from replicas for data that must be strongly consistent.

---

## Production Tips

**Use Consistency Level Tags in Your Data Model**
Annotate repository interfaces or entity classes with the required consistency model:

```java
@ConsistencyLevel(ConsistencyModel.LINEARISABLE)
@Repository
public interface AccountBalanceRepository extends JpaRepository<Account, UUID> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<Account> findByAccountIdForUpdate(String accountId);
}

@ConsistencyLevel(ConsistencyModel.EVENTUAL)
@Repository
public interface TransactionHistoryReadModelRepository {
    Page<TransactionSummary> findByAccountId(String accountId, Pageable pageable);
}
```

**Test Consistency Boundaries Under Failure Conditions**
Chaos engineering tests that introduce network partitions, replica lag, and leader elections are the only reliable way to verify that your consistency model is correctly implemented. Test that balance debits work correctly when the primary database is under election.

**Monitor Replication Lag as a Financial Risk Metric**
Track `pg_stat_replication` lag for read replicas. When lag exceeds the threshold for a data entity that relies on eventual consistency for a time-bounded guarantee (e.g., "within 5 seconds"), raise an alert and optionally route reads back to primary.

```sql
-- Monitor replication lag
SELECT
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    write_lag,
    flush_lag,
    replay_lag,
    EXTRACT(EPOCH FROM replay_lag) AS replay_lag_seconds
FROM pg_stat_replication
ORDER BY replay_lag DESC;

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment system routes all database reads to a PostgreSQL read replica for performance, including account balance reads during payment authorisation. What specific production failure can this cause?",
      "options": [
        "The replica returns NULL for balance fields until replication fully catches up.",
        "A customer can spend money they do not have if the replica lags during high-write periods — the stale balance read shows sufficient funds when the actual balance is insufficient.",
        "Read replicas in PostgreSQL cannot handle SELECT FOR UPDATE queries, causing payment authorisation to fail entirely.",
        "The replica returns the balance in a different currency than the primary due to a replication configuration bug."
      ],
      "correct": 1,
      "explanation": "Account balance reads during payment authorisation require strong consistency. If the replica lags — even by milliseconds — a customer may pass a balance check on the replica while the primary already has a lower balance from a concurrent debit. The stale read allows a double-spend. Balance reads for payment decisions must always come from the primary (or a strongly consistent read path)."
    },
    {
      "text": "A customer submits a payment and immediately refreshes their transaction history. The history does not show the payment yet because the read model is eventually consistent. Which session consistency property is violated and how should it be remedied?",
      "options": [
        "Monotonic reads are violated — the customer sees older data than they previously read. The remedy is to route read-history calls to the primary.",
        "Read-your-writes is violated — the customer does not see their own submitted payment. The remedy is to route reads-after-write to the primary until the replica catches up to the write position.",
        "Causal consistency is violated — the payment submission event and the history read are causally related. The remedy is to use vector clocks across the read model projection.",
        "Linearisability is violated — the history read happened after the payment write completed. The remedy is to use SERIALIZABLE isolation for history queries."
      ],
      "correct": 1,
      "explanation": "This violates read-your-writes: a client must always see the effects of its own writes. The remedy is to record the write position (database sequence or LSN) after a write, then route subsequent reads for that session to the primary until the replica catches up to that position. Once the replica is current, reads can be routed to the replica again."
    },
    {
      "text": "Which of the following data entities in a payment system correctly requires linearisable consistency and why?",
      "options": [
        "Merchant analytics dashboards — revenue reports must reflect all transactions to avoid regulatory reporting errors.",
        "Account balances — prevents double-spending by ensuring all concurrent operations see a consistent current balance.",
        "Transaction history display — customers expect to see their recent transactions without any delay.",
        "Email delivery confirmation status — payment confirmation emails must be tracked in real time for compliance."
      ],
      "correct": 1,
      "explanation": "Account balances require linearisability because allowing two concurrent operations to both read a pre-debit balance before either write completes enables double-spending — a customer spending the same money twice. Merchant analytics, transaction history, and notification status can tolerate eventual consistency because staleness in those entities has bounded, non-financial impact."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Consistency Boundaries in a Payment System",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Implement a BalanceService that performs linearisable account debits using SERIALIZABLE isolation with SELECT FOR UPDATE NOWAIT. Write a concurrent test using two threads that simultaneously attempt to debit the same account where only one debit can succeed (insufficient funds for both). Verify that exactly one debit succeeds and the other receives an InsufficientFundsException, with no partial state left in the database."},
    {"id": "2", "description": "Implement a SessionConsistentAccountService that provides read-your-writes guarantees. After submitting a payment, the service must record the primary database write position in a SessionReadVersionStore. Subsequent transaction history reads must route to the primary if the replica has not yet caught up, and to the replica once the replica's sequence number meets or exceeds the recorded position. Write tests simulating replica lag and verifying that the payment appears in the history read immediately after submission."},
    {"id": "3", "description": "Create a @ConsistencyLevel annotation and annotate the following repository interfaces with the appropriate model from the financial system consistency map: AccountBalanceRepository (LINEARISABLE), PaymentStatusRepository (LINEARISABLE), TransactionHistoryReadModelRepository (EVENTUAL), and MerchantAnalyticsRepository (EVENTUAL). Write an ArchUnit test that verifies all repository interfaces in the persistence.primary package are annotated @ConsistencyLevel(LINEARISABLE) and all in persistence.replica are annotated @ConsistencyLevel(EVENTUAL)."},
    {"id": "4", "description": "Write a PostgreSQL monitoring query that checks replication lag for all connected replicas. Configure a Spring Boot @Scheduled job that runs every 30 seconds, reads the replication lag from pg_stat_replication, and publishes a Micrometer gauge metric for each replica. Write a Prometheus alerting rule that fires when any replica's replay_lag_seconds exceeds 5 seconds, and document which read operations in your service must be rerouted to the primary when this alert is active."}
  ]
}
-->
```
