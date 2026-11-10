---
id: track-10-lesson-02
title: "Transaction Isolation Levels — Read Anomalies and Fixes"
slug: isolation-levels
track: track-10
trackName: "Database & Data Architecture"
sequence: 2
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [isolation-levels, dirty-read, phantom, serializable, read-committed]
prerequisites: []
---

# Transaction Isolation Levels — Read Anomalies and Fixes

> [!NOTE]
> Choosing the wrong isolation level in a financial system is not a performance issue — it is a correctness issue. Dirty reads, non-repeatable reads, and phantom reads translate directly into overdrafts, duplicate charges, and regulatory reporting errors. This lesson teaches you to reason about isolation precisely so you can make deliberate trade-offs rather than accepting defaults blindly.

---

## 1. Why Isolation Matters in Fintech

Every financial database handles concurrent transactions. At any given second, thousands of threads may be reading account balances, posting debits, running regulatory reports, and reconciling ledgers — all against the same underlying data. The database must give each transaction a coherent view of the world without letting them collide in ways that corrupt business logic.

The SQL standard defines four isolation levels as a spectrum between performance and correctness:

| Isolation Level      | Dirty Read | Non-Repeatable Read | Phantom Read |
|----------------------|-----------|---------------------|--------------|
| READ UNCOMMITTED     | Possible  | Possible            | Possible     |
| READ COMMITTED       | Prevented | Possible            | Possible     |
| REPEATABLE READ      | Prevented | Prevented           | Possible     |
| SERIALIZABLE         | Prevented | Prevented           | Prevented    |

PostgreSQL's default is **READ COMMITTED**. Many financial applications discover — often painfully — that READ COMMITTED is insufficient for certain operations.

---

## 2. The Three Read Anomalies

### 2.1 Dirty Read

A dirty read occurs when Transaction A reads data written by Transaction B that has not yet committed. If B subsequently rolls back, A has acted on data that never officially existed.

```sql
-- Session A: begins but does not commit
BEGIN;
UPDATE accounts SET balance = balance - 500.00
WHERE account_id = 'ACC-1001';
-- (no COMMIT yet)

-- Session B (READ UNCOMMITTED): reads uncommitted change from A
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 500 less than the real balance — A might still rollback!
COMMIT;
```

**Financial impact:** A fraud-scoring service reads an uncommitted debit and flags the account as low-balance. Session A rolls back. The account was flagged unnecessarily. Worse: a payment gateway approves a transfer based on a balance that was never committed.

PostgreSQL does not implement dirty reads even at READ UNCOMMITTED — it simply behaves like READ COMMITTED at that level. However, MySQL, SQL Server, and Oracle support true READ UNCOMMITTED. Never rely on database-specific behaviour for correctness guarantees.

### 2.2 Non-Repeatable Read

A non-repeatable read occurs when Transaction A reads the same row twice within the same transaction and gets different values because Transaction B committed a change between the two reads.

```sql
-- Session A: READ COMMITTED (default)
BEGIN;
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 1000.00

-- Session B: commits a debit
BEGIN;
UPDATE accounts SET balance = balance - 300.00
WHERE account_id = 'ACC-1001';
COMMIT;

-- Session A: reads again
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 700.00 — different from the first read!
COMMIT;
```

**Financial impact:** A wire transfer service reads a sender's balance, decides the transfer is valid (1000 >= transfer amount 800), and then re-reads the balance to log the pre-transfer amount — getting 700. The audit log is wrong. Worse: if the validation and the actual debit are separated by any intervening commit, the debit can overdraft the account.

### 2.3 Phantom Read

A phantom read occurs when Transaction A executes the same range query twice and gets different sets of rows because Transaction B inserted (or deleted) rows in that range between the two reads.

```sql
-- Session A: READ COMMITTED
BEGIN;
SELECT SUM(amount) AS daily_total
FROM daily_transactions
WHERE account_id = 'ACC-1001'
  AND transaction_date = CURRENT_DATE;
-- Returns 2500.00 (5 transactions)

-- Session B: inserts a new transaction (commits)
INSERT INTO daily_transactions (account_id, amount, transaction_date)
VALUES ('ACC-1001', 500.00, CURRENT_DATE);
COMMIT;

-- Session A: same query
SELECT SUM(amount) AS daily_total
FROM daily_transactions
WHERE account_id = 'ACC-1001'
  AND transaction_date = CURRENT_DATE;
-- Returns 3000.00 — a phantom row appeared!
COMMIT;
```

**Financial impact:** A daily spending limit check reads aggregate spend as 2500 and approves a 400 transaction (limit: 3000). Meanwhile another transaction snuck in. The account now exceeds its daily limit by 400.

---

## 3. The Four Isolation Levels in Detail

### 3.1 READ UNCOMMITTED

Permits dirty reads. No financial system should use this level for transactional data. It has marginal use in analytics against non-critical data where stale reads are acceptable and performance is paramount.

```sql
-- Explicitly setting (almost never appropriate in fintech)
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
```

### 3.2 READ COMMITTED

The PostgreSQL default. Each statement within the transaction sees only data committed before that statement began. The same transaction can see different snapshots across different statements.

```sql
-- This is the default; shown for clarity
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

BEGIN;
-- Statement 1 snapshot: everything committed before this statement
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';

-- If another session commits between here and the next SELECT,
-- Statement 2 will capture that new commit
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
COMMIT;
```

**When READ COMMITTED is acceptable:**
- Simple single-row reads where the application handles retries
- Insert-only operations with no read-modify-write pattern
- Loosely consistent reporting where slight staleness is tolerable

**When READ COMMITTED is NOT acceptable:**
- Balance checks followed by debits in the same transaction
- Multi-statement reconciliation
- Calculations that aggregate data and then act on the aggregate

### 3.3 REPEATABLE READ

Each transaction sees a consistent snapshot taken at the start of the transaction. Rows read at the beginning remain unchanged from the transaction's perspective, even if they are modified and committed by other sessions.

In PostgreSQL, REPEATABLE READ is implemented via MVCC (covered in Lesson 03) and prevents both dirty reads and non-repeatable reads. PostgreSQL's REPEATABLE READ also prevents most phantom reads in practice, though the SQL standard does not require this.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- Snapshot taken here
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 1000.00

-- External session commits UPDATE reducing balance to 700.00
-- Our snapshot is unaffected

SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Still returns 1000.00 — repeatable!

-- However: if we try to UPDATE the same row that another session
-- already updated and committed, PostgreSQL will raise an error
-- forcing the transaction to retry
COMMIT;
```

**Write skew caveat:** REPEATABLE READ does not prevent write skew. Two transactions can each read consistent snapshots and make decisions that are individually valid but collectively inconsistent. This is covered in depth in the MVCC lesson.

### 3.4 SERIALIZABLE

The highest isolation level. Transactions execute as if they ran one at a time in some serial order. PostgreSQL implements this using Serializable Snapshot Isolation (SSI), which tracks read/write dependencies and aborts transactions that would create non-serializable outcomes.

```sql
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Full snapshot isolation + serialization conflict detection
SELECT SUM(balance) FROM accounts
WHERE customer_id = 'CUST-5050';

-- Make a decision based on that sum...
INSERT INTO transfers (from_account, to_account, amount, initiated_at)
VALUES ('ACC-1001', 'ACC-1002', 500.00, NOW());

COMMIT;
-- If PostgreSQL detects a serialization anomaly, COMMIT raises:
-- ERROR 40001: could not serialize access due to read/write dependencies
-- Application MUST catch this and retry the transaction
```

**Key behaviour:** SERIALIZABLE transactions may abort with `ERROR 40001 (serialization_failure)`. Applications must catch this and retry the transaction from scratch.

---

## 4. When to Use SERIALIZABLE in Fintech

### 4.1 Balance Check + Debit (Classic Case)

The canonical fintech use case: read the current balance, verify it is sufficient, then debit.

```java
@Service
public class TransferService {

    @Transactional(isolation = Isolation.SERIALIZABLE)
    public TransferResult executeTransfer(String fromAccount,
                                          String toAccount,
                                          BigDecimal amount) {
        // With SERIALIZABLE, these reads are part of a consistent
        // snapshot with write-dependency tracking
        Account sender = accountRepository.findByIdForUpdate(fromAccount);
        Account recipient = accountRepository.findByIdForUpdate(toAccount);

        if (sender.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException(fromAccount);
        }

        sender.debit(amount);
        recipient.credit(amount);

        accountRepository.save(sender);
        accountRepository.save(recipient);

        return TransferResult.success(sender.getBalance());
    }
}
```

Note that in this specific pattern, `SELECT FOR UPDATE` (covered in the locking lesson) achieves the same correctness guarantee more efficiently by using pessimistic locking rather than optimistic SSI. SERIALIZABLE shines when you cannot use FOR UPDATE — for instance, when the read set is determined dynamically or spans multiple tables.

### 4.2 Daily Limit Enforcement

```java
@Transactional(isolation = Isolation.SERIALIZABLE)
public void enforceAndRecordDailyLimit(String accountId,
                                        BigDecimal transactionAmount) {
    BigDecimal todaySpend = transactionRepository
        .sumByAccountAndDate(accountId, LocalDate.now());

    BigDecimal limit = limitRepository.getDailyLimit(accountId);

    if (todaySpend.add(transactionAmount).compareTo(limit) > 0) {
        throw new DailyLimitExceededException(accountId);
    }

    transactionRepository.recordTransaction(accountId, transactionAmount);
}
```

Without SERIALIZABLE isolation, two concurrent calls could both read `todaySpend` as 2400, both pass a 400-transaction check against a 3000 limit, and both commit — resulting in 2800 of spend that should have been rejected.

### 4.3 Idempotency Token Checks

```java
@Transactional(isolation = Isolation.SERIALIZABLE)
public PaymentResult processWithIdempotency(String idempotencyKey,
                                             PaymentRequest request) {
    // Check if already processed
    Optional<Payment> existing = paymentRepository
        .findByIdempotencyKey(idempotencyKey);

    if (existing.isPresent()) {
        return PaymentResult.alreadyProcessed(existing.get());
    }

    // Process payment
    Payment payment = processPayment(request);
    payment.setIdempotencyKey(idempotencyKey);
    paymentRepository.save(payment);

    return PaymentResult.success(payment);
}
```

Without SERIALIZABLE, two concurrent requests with the same idempotency key could both find no existing record and both insert — creating duplicate charges.

---

## 5. Spring @Transactional Isolation Configuration

### 5.1 Method-Level Annotation

```java
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountService {

    // Default: uses database default (READ COMMITTED for PostgreSQL)
    @Transactional
    public AccountSummary getAccountSummary(String accountId) {
        return buildSummary(accountId);
    }

    // Explicit READ COMMITTED for read-heavy operations
    @Transactional(isolation = Isolation.READ_COMMITTED, readOnly = true)
    public List<Transaction> getTransactionHistory(String accountId,
                                                    LocalDate from,
                                                    LocalDate to) {
        return transactionRepository.findByAccountAndDateRange(
            accountId, from, to);
    }

    // REPEATABLE READ for multi-statement reads that must be consistent
    @Transactional(isolation = Isolation.REPEATABLE_READ)
    public ReconciliationResult reconcileAccount(String accountId) {
        BigDecimal openingBalance = ledgerRepository
            .getOpeningBalance(accountId);
        List<Transaction> transactions = transactionRepository
            .findTodayTransactions(accountId);
        BigDecimal closingBalance = accountRepository
            .getCurrentBalance(accountId);

        return ReconciliationResult.compute(
            openingBalance, transactions, closingBalance);
    }

    // SERIALIZABLE for critical write operations with read checks
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void transferFunds(TransferRequest request) {
        performTransfer(request);
    }
}
```

### 5.2 Retry Logic for Serialization Failures

SERIALIZABLE transactions must be retried on serialization failure. Spring Retry integrates cleanly:

```java
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.dao.CannotSerializeTransactionException;

@Service
public class TransferService {

    @Retryable(
        retryFor = CannotSerializeTransactionException.class,
        maxAttempts = 3,
        backoff = @Backoff(delay = 50, multiplier = 2, random = true)
    )
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public TransferResult transfer(TransferRequest request) {
        return executeTransfer(request);
    }

    @Recover
    public TransferResult transferFailed(
            CannotSerializeTransactionException ex,
            TransferRequest request) {
        log.error("Transfer failed after retries: {}", request.getTransferId());
        throw new TransferFailedException("Concurrent modification conflict", ex);
    }
}
```

### 5.3 Programmatic Transaction Management

For fine-grained control, use `TransactionTemplate`:

```java
@Service
public class BalanceService {

    private final TransactionTemplate serializableTx;
    private final TransactionTemplate readCommittedTx;

    public BalanceService(PlatformTransactionManager txManager) {
        this.serializableTx = new TransactionTemplate(txManager);
        this.serializableTx.setIsolationLevel(
            TransactionDefinition.ISOLATION_SERIALIZABLE);

        this.readCommittedTx = new TransactionTemplate(txManager);
        this.readCommittedTx.setIsolationLevel(
            TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.readCommittedTx.setReadOnly(true);
    }

    public BalanceSnapshot getBalance(String accountId) {
        return readCommittedTx.execute(status ->
            accountRepository.findBalance(accountId));
    }

    public void adjustBalance(String accountId, BigDecimal delta) {
        serializableTx.execute(status -> {
            Account account = accountRepository.findById(accountId)
                .orElseThrow();
            account.adjustBalance(delta);
            accountRepository.save(account);
            return null;
        });
    }
}
```

---

## 6. Performance Implications

Understanding the performance cost of each isolation level helps you make informed trade-offs.

### 6.1 READ COMMITTED Performance Characteristics

- Each statement acquires a fresh snapshot — low overhead
- Short-lived row locks released immediately after each statement
- Highest concurrency, lowest contention
- Appropriate for: read-heavy services, reporting, analytics on non-critical data

### 6.2 REPEATABLE READ Performance Characteristics

- Snapshot taken at transaction start — held for the transaction's duration
- Longer-lived transaction means more MVCC overhead (more dead tuple versions)
- Write conflicts detected at commit time (transaction may need to retry or fail)
- Approximately 10–30% more overhead than READ COMMITTED for update-heavy workloads

### 6.3 SERIALIZABLE Performance Characteristics

PostgreSQL's SSI implementation tracks three types of dependency conflicts:
- **rw-anti-dependency:** T1 reads a row that T2 later writes
- **wr-dependency:** T1 writes a row that T2 reads
- **ww-dependency:** T1 and T2 both write the same row

```sql
-- Check SSI overhead in production
SELECT pid, query, wait_event_type, wait_event, state
FROM pg_stat_activity
WHERE wait_event = 'relation'
  AND state = 'active';

-- Monitor serialization failures via rollback stats
SELECT pg_stat_get_db_conflicts(oid) AS conflicts,
       pg_stat_get_db_xact_rollback(oid) AS rollbacks
FROM pg_database
WHERE datname = current_database();
```

Performance impact of SERIALIZABLE:
- 10–40% throughput reduction under high concurrency
- Memory overhead for tracking predicate locks
- Abort rate increases with contention (plan for retries)
- For most fintech critical paths: acceptable overhead given correctness guarantee

### 6.4 Isolation Level by Use Case

| Use Case | Recommended Level | Justification |
|----------|------------------|---------------|
| Account balance read (display) | READ COMMITTED | Stale by milliseconds is acceptable |
| Transaction history list | READ COMMITTED | No write decision based on read |
| Multi-step reconciliation | REPEATABLE READ | Consistent view needed; no write skew risk |
| Transfer with balance check | SERIALIZABLE or SELECT FOR UPDATE | Write decision based on aggregate read |
| Daily limit enforcement | SERIALIZABLE | Phantom risk on aggregate read |
| Idempotency check + insert | SERIALIZABLE | Phantom risk on existence check |
| Batch report generation | REPEATABLE READ | Consistent snapshot for the report |
| Fraud score lookup | READ COMMITTED | Non-critical, latency sensitive |

---

## 7. Anomaly Examples with SQL — Production Scenarios

### 7.1 Detecting Potential Anomalies in Existing Code

Before upgrading isolation levels, identify risky patterns:

```sql
-- Find long-running transactions (potential for stale reads)
SELECT pid,
       now() - pg_stat_activity.query_start AS duration,
       query,
       state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > INTERVAL '5 minutes'
  AND state != 'idle'
ORDER BY duration DESC;
```

```java
// DANGEROUS pattern: READ COMMITTED + read-modify-write without locking
@Transactional  // Default: READ COMMITTED
public void dangerousTransfer(String fromId, String toId, BigDecimal amount) {
    // READ: snapshot 1
    Account from = accountRepository.findById(fromId).orElseThrow();

    // Another transaction may commit a debit here
    if (from.getBalance().compareTo(amount) < 0) {
        throw new InsufficientFundsException();
    }

    // READ: snapshot 2 (possibly different from snapshot 1 in READ COMMITTED!)
    Account fromAgain = accountRepository.findById(fromId).orElseThrow();
    // fromAgain.getBalance() may now be LESS than the validated amount!

    fromAgain.debit(amount);  // Potential overdraft!
    accountRepository.save(fromAgain);
}
```

### 7.2 Correct Pattern with Explicit Locking

```java
// SAFE pattern: SELECT FOR UPDATE under READ COMMITTED
@Transactional
public void safeTransfer(String fromId, String toId, BigDecimal amount) {
    // Locks the row; no other transaction can modify it until we commit
    Account from = accountRepository.findByIdWithLock(fromId);
    Account to = accountRepository.findByIdWithLock(toId);

    if (from.getBalance().compareTo(amount) < 0) {
        throw new InsufficientFundsException();
    }

    from.debit(amount);
    to.credit(amount);

    accountRepository.save(from);
    accountRepository.save(to);
}
```

```java
// Repository with pessimistic write lock
public interface AccountRepository extends JpaRepository<Account, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.id = :id")
    Account findByIdWithLock(@Param("id") String id);
}
```

### 7.3 Write Skew Example and Fix

Write skew is a subtle anomaly that REPEATABLE READ does not prevent:

```sql
-- Scenario: Two transactions check that at least one doctor is on-call
-- Both read that there are 2 on-call doctors
-- Both decide to go off-call (each is valid individually)
-- Result: zero on-call doctors — collectively invalid

-- Fintech equivalent: Two transactions read total collateral posted
-- Both approve a margin increase based on current total collateral
-- Both commit, resulting in over-leveraged positions

-- FIX 1: Use SERIALIZABLE
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- PostgreSQL tracks the dependency and aborts one transaction on conflict

-- FIX 2: Use SELECT FOR UPDATE on a "guard" row
BEGIN;
SELECT total_collateral FROM position_summary
WHERE portfolio_id = 'PORT-001'
FOR UPDATE;  -- Serializes all margin decisions for this portfolio
-- ... check and act ...
COMMIT;
```

---

## 8. PostgreSQL-Specific Behaviour Notes

### 8.1 SET vs ALTER

```sql
-- Set for current transaction only
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Set for current session (all future transactions)
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Set default for a specific database role (DBA action)
ALTER ROLE payment_service
SET default_transaction_isolation = 'serializable';

-- Set default for the entire database
ALTER DATABASE payments_db
SET default_transaction_isolation = 'read committed';
```

### 8.2 Checking Current Isolation Level

```sql
-- Check current transaction isolation level
SHOW transaction_isolation;

-- Check session default
SHOW default_transaction_isolation;
```

### 8.3 READ COMMITTED Subtleties

PostgreSQL refreshes the snapshot between statements in READ COMMITTED. This means a `SELECT ... FOR UPDATE` inside a READ COMMITTED transaction will re-read committed rows:

```sql
BEGIN;  -- READ COMMITTED (default)
SELECT * FROM accounts WHERE balance > 1000 FOR UPDATE;
-- Locks all rows where balance > 1000 at statement start

-- Another session commits an UPDATE changing a balance from 500 to 1500
-- (a row that was NOT in our original result set)

-- If we re-execute the same query:
SELECT * FROM accounts WHERE balance > 1000 FOR UPDATE;
-- Now includes the new row! (READ COMMITTED re-reads per statement)
COMMIT;
```

This is intentional PostgreSQL behaviour. If you need a fixed row set, use REPEATABLE READ or SERIALIZABLE.

---

## 9. Monitoring and Observability

### 9.1 Transaction Conflict Metrics

```sql
-- PostgreSQL conflict statistics by database
SELECT confl_tablespace,
       confl_lock,
       confl_snapshot,
       confl_bufferpin,
       confl_deadlock
FROM pg_stat_database_conflicts
WHERE datname = current_database();

-- Active transactions by isolation level
SELECT pid,
       backend_xid,
       backend_xmin,
       state,
       query_start,
       left(query, 80) AS query_snippet
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL
ORDER BY query_start;
```

### 9.2 Application Metrics to Track

```java
@Component
public class TransactionIsolationMetrics {

    private final Counter serializationFailures;
    private final Counter retrySuccesses;

    public TransactionIsolationMetrics(MeterRegistry registry) {
        this.serializationFailures = Counter.builder("db.serialization.failures")
            .description("Serialization failures requiring retry")
            .register(registry);
        this.retrySuccesses = Counter.builder("db.serialization.retries.success")
            .description("Successful retries after serialization failure")
            .register(registry);
    }

    public void recordSerializationFailure(String operationName) {
        serializationFailures.increment(
            Tags.of("operation", operationName));
    }

    public void recordRetrySuccess(String operationName, int attemptNumber) {
        retrySuccesses.increment(
            Tags.of("operation", operationName,
                    "attempt", String.valueOf(attemptNumber)));
    }
}
```

---

## 10. Production Checklist

**Before deploying a new financial operation:**

- [ ] Identify every read that influences a write decision in the same transaction
- [ ] Determine whether concurrent execution of the operation can produce incorrect outcomes
- [ ] Choose the minimum isolation level that prevents the identified anomalies
- [ ] If using SERIALIZABLE, implement retry logic with exponential back-off
- [ ] Add observability metrics for serialization failures and retry rates
- [ ] Load test the operation under realistic concurrency to measure abort rates
- [ ] Document the isolation level choice and the anomaly it prevents in code comments
- [ ] Consider whether pessimistic locking (`SELECT FOR UPDATE`) is a simpler solution

**Red flags in existing code:**

- `@Transactional` with no `isolation` specified on a method that reads then writes
- Multi-statement transactions under READ COMMITTED with aggregate reads
- Idempotency checks without locking or SERIALIZABLE
- Balance validation separated from the debit by any amount of non-trivial code

---

## Summary

The four SQL isolation levels represent a spectrum between concurrency and correctness. In fintech, the default READ COMMITTED is frequently insufficient. Know your anomalies:

- **Dirty read:** reading uncommitted data — prevented at READ COMMITTED and above
- **Non-repeatable read:** same row returns different values in one transaction — prevented at REPEATABLE READ and above
- **Phantom read:** same range query returns different rows — prevented at SERIALIZABLE (and largely in PostgreSQL's REPEATABLE READ)
- **Write skew:** two transactions make individually-valid decisions that are collectively invalid — only prevented by SERIALIZABLE

Use `@Transactional(isolation = Isolation.SERIALIZABLE)` for balance checks, limit enforcement, and idempotency patterns. Always implement retry logic for serialization failures. When pessimistic locking is simpler, `SELECT FOR UPDATE` under READ COMMITTED is a valid alternative for single-row cases.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment service uses READ COMMITTED isolation. Transaction A reads account balance = £1,000, then Transaction B commits a debit reducing the balance to £600. Transaction A reads the balance again in the same transaction. What does Transaction A see on the second read?",
      "options": [
        "£1,000 — READ COMMITTED prevents any changes from being visible mid-transaction",
        "£600 — READ COMMITTED allows non-repeatable reads; each statement sees the latest committed data",
        "An error — concurrent modification is detected and the transaction is aborted",
        "Either £1,000 or £600 depending on lock acquisition order"
      ],
      "correct": 1,
      "explanation": "READ COMMITTED takes a fresh snapshot at the start of each statement, not at transaction start. So the second SELECT sees Transaction B's committed update. This is a non-repeatable read — a known anomaly of READ COMMITTED. For consistent multi-read operations, REPEATABLE READ or SERIALIZABLE is needed."
    },
    {
      "text": "Two concurrent transactions both read a customer's daily spend as £2,400 against a £3,000 limit. Both approve a new £400 transaction and commit. What anomaly has occurred and which isolation level would have prevented it?",
      "options": [
        "Dirty read — prevented by READ COMMITTED",
        "Non-repeatable read — prevented by REPEATABLE READ",
        "Phantom read — prevented by SERIALIZABLE isolation",
        "Write skew — only prevented by SERIALIZABLE isolation"
      ],
      "correct": 3,
      "explanation": "This is write skew: each transaction reads a consistent snapshot (combined spend = £2,400) and makes an individually valid decision (£2,400 + £400 = £2,800 < £3,000). But two concurrent approvals result in £2,400 + £400 + £400 = £3,200, exceeding the limit. REPEATABLE READ prevents the same row changing mid-transaction but does not prevent write skew on aggregate reads. Only SERIALIZABLE (via PostgreSQL's SSI) detects and aborts one of the conflicting transactions."
    },
    {
      "text": "A SERIALIZABLE transaction in PostgreSQL throws `ERROR 40001: could not serialize access due to read/write dependencies`. What is the correct application response?",
      "options": [
        "Log the error and return a 500 Internal Server Error to the client",
        "Retry the entire transaction from scratch with exponential backoff",
        "Downgrade to READ COMMITTED and retry the same operations",
        "Increase max_connections in PostgreSQL to reduce contention"
      ],
      "correct": 1,
      "explanation": "ERROR 40001 is a serialization failure — PostgreSQL detected that allowing the transaction to commit would violate serializability. The correct response is to retry the entire transaction from scratch (re-read all data, re-apply business logic, re-attempt commit). Spring Retry with @Retryable(CannotSerializeTransactionException.class) is the standard pattern. Downgrading isolation would defeat the purpose and could introduce the very anomaly you were preventing."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Isolation Level Audit and Daily Limit Enforcement",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Audit an existing Spring service that processes payments using default @Transactional (READ COMMITTED). Identify all read-modify-write patterns and classify each as: safe (single-row with FOR UPDATE), at-risk (aggregate reads), or dangerous (read then write without locking). Document the specific anomaly that could occur for each at-risk pattern."},
    {"id": "2", "description": "Implement a daily spending limit check that is correct under concurrent load. The check must read the sum of today's transactions for an account and reject the new transaction if the sum would exceed the limit. Write the implementation using SERIALIZABLE isolation with Spring Retry, and explain why SELECT FOR UPDATE alone would not work for this aggregate check."},
    {"id": "3", "description": "Write a multi-threaded JUnit test using 20 concurrent threads that each submit a £400 payment for the same account with a £3,000 daily limit. Without SERIALIZABLE isolation, demonstrate that more than 7 payments succeed (proving the race condition). With SERIALIZABLE isolation, verify that exactly 7 payments succeed and the rest are rejected or retried correctly."},
    {"id": "4", "description": "Add Micrometer metrics to track serialization failure rate and retry success rate per operation type. Define alert thresholds: what serialization failure rate would indicate a design problem requiring architectural review rather than just more retries?"}
  ]
}
-->
