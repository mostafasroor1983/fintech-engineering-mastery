---
id: track-10-lesson-04
title: "PostgreSQL Locking — Row, Page, and Advisory Locks"
slug: postgresql-locking
track: track-10
trackName: "Database & Data Architecture"
sequence: 4
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [PostgreSQL, locking, row-lock, advisory-lock, deadlock]
prerequisites: []
---

# PostgreSQL Locking — Row, Page, and Advisory Locks

> [!NOTE]
> PostgreSQL's locking system is a precision instrument. Used correctly, locks are what make concurrent financial transactions safe. Used carelessly, they produce deadlocks, lock queues, and silent correctness bugs. This lesson covers every lock mode, their interactions, and the patterns that make high-throughput financial systems both correct and fast.

---

## 1. Lock Mode Hierarchy

PostgreSQL defines eight table-level lock modes, ordered from least to most restrictive:

| Lock Mode | Acquired By | Conflicts With |
|-----------|------------|----------------|
| ACCESS SHARE | SELECT | ACCESS EXCLUSIVE only |
| ROW SHARE | SELECT FOR UPDATE/SHARE | EXCLUSIVE, ACCESS EXCLUSIVE |
| ROW EXCLUSIVE | INSERT, UPDATE, DELETE | SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| SHARE UPDATE EXCLUSIVE | VACUUM, ANALYZE, CREATE INDEX CONCURRENTLY | SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| SHARE | CREATE INDEX | ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| SHARE ROW EXCLUSIVE | CREATE TRIGGER, ALTER TABLE | ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| EXCLUSIVE | (rarely acquired directly) | All except ACCESS SHARE |
| ACCESS EXCLUSIVE | ALTER TABLE, DROP TABLE, VACUUM FULL, TRUNCATE | All lock modes |

The most practically important distinction for financial systems:
- **Normal reads and writes** (SELECT, INSERT, UPDATE, DELETE) coexist without table-level conflicts
- **DDL operations** (ALTER TABLE, DROP, TRUNCATE) acquire ACCESS EXCLUSIVE and block everything
- **Online index creation** (CREATE INDEX CONCURRENTLY) uses SHARE UPDATE EXCLUSIVE, allowing DML to proceed

---

## 2. Row-Level Locks

Table-level locks govern schema-level concurrency. Row-level locks govern which transactions can modify specific rows simultaneously.

### 2.1 SELECT FOR UPDATE

Acquires an exclusive row lock on selected rows. Other transactions trying to lock or update these rows will block until the first transaction commits or rolls back.

```sql
-- Transfer: lock both rows atomically to prevent concurrent modification
BEGIN;

SELECT account_id, balance
FROM accounts
WHERE account_id IN ('ACC-1001', 'ACC-1002')
ORDER BY account_id  -- Always lock in consistent order to prevent deadlocks!
FOR UPDATE;

-- Now safely update knowing no other transaction can touch these rows
UPDATE accounts
SET balance = balance - 500.00
WHERE account_id = 'ACC-1001';

UPDATE accounts
SET balance = balance + 500.00
WHERE account_id = 'ACC-1002';

COMMIT;
```

**Critical rule:** Always acquire multiple row locks in a **consistent order** (e.g., sorted by primary key). Two transactions locking the same rows in opposite orders will deadlock.

### 2.2 SELECT FOR SHARE

Acquires a shared row lock. Multiple transactions can hold FOR SHARE simultaneously, but no transaction can acquire FOR UPDATE or modify the row while a FOR SHARE lock is held.

```sql
-- Read a row that must not change during a multi-step validation
BEGIN;

SELECT limit_amount, current_usage, limit_type
FROM credit_limits
WHERE account_id = 'ACC-1001'
FOR SHARE;

-- Multiple concurrent readers can hold FOR SHARE on this row
-- But no updater can proceed until all FOR SHARE holders release

-- Perform validation logic (read-only)
-- ...

COMMIT;  -- Releases FOR SHARE lock
```

**When to use FOR SHARE vs FOR UPDATE:**
- FOR UPDATE: you will modify the row
- FOR SHARE: you need to read the row and prevent modification, but multiple validators should be able to run concurrently

### 2.3 SELECT FOR NO KEY UPDATE

A weaker variant of FOR UPDATE that does not conflict with FOR KEY SHARE. Useful when you need to update non-key columns without blocking foreign key checks.

```sql
-- Update metadata without blocking FK referencing transactions
SELECT *
FROM accounts
WHERE account_id = 'ACC-1001'
FOR NO KEY UPDATE;
-- Does NOT block SELECT FOR KEY SHARE (used by FK checks)
-- DOES block SELECT FOR UPDATE and SELECT FOR SHARE
```

### 2.4 SELECT FOR KEY SHARE

The weakest row lock. Prevents the row from being deleted or key columns from being updated, but allows non-key column updates. Used internally by PostgreSQL for foreign key enforcement.

---

## 3. SKIP LOCKED for Queue Processing

One of the most valuable PostgreSQL features for financial systems: `SKIP LOCKED` allows a query to skip rows that are currently locked by another transaction, enabling efficient concurrent queue processing.

### 3.1 Payment Queue Pattern

```sql
-- Create a payment processing queue
CREATE TABLE payment_queue (
    queue_id        BIGSERIAL PRIMARY KEY,
    payment_id      VARCHAR(50) NOT NULL UNIQUE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    amount          NUMERIC(19, 4) NOT NULL,
    from_account    VARCHAR(20) NOT NULL,
    to_account      VARCHAR(20) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_node VARCHAR(50)
);

CREATE INDEX idx_payment_queue_status_created
ON payment_queue (status, created_at)
WHERE status = 'pending';
```

```sql
-- Worker: atomically claim a pending payment (no duplicates, no skipping busy items)
BEGIN;

SELECT queue_id, payment_id, amount, from_account, to_account
FROM payment_queue
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;  -- Skip rows locked by other workers

-- If no rows returned, queue is empty or all pending items are being processed

UPDATE payment_queue
SET status = 'processing',
    processing_node = 'worker-07'
WHERE queue_id = :claimed_queue_id;

COMMIT;
```

### 3.2 Java Implementation of Queue Worker

```java
@Service
public class PaymentQueueWorker {

    @Transactional
    public Optional<QueuedPayment> claimNextPayment(String workerId) {
        // SKIP LOCKED ensures concurrent workers don't step on each other
        Optional<QueuedPayment> claimed = paymentQueueRepository
            .findNextPendingWithSkipLocked();

        claimed.ifPresent(payment -> {
            payment.setStatus(PaymentStatus.PROCESSING);
            payment.setProcessingNode(workerId);
            paymentQueueRepository.save(payment);
        });

        return claimed;
    }
}
```

```java
// Repository
public interface PaymentQueueRepository
    extends JpaRepository<QueuedPayment, Long> {

    @Query(value = """
        SELECT * FROM payment_queue
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        """, nativeQuery = true)
    Optional<QueuedPayment> findNextPendingWithSkipLocked();
}
```

### 3.3 Batch Queue Processing

```java
@Transactional
public List<QueuedPayment> claimBatch(String workerId, int batchSize) {
    List<QueuedPayment> batch = paymentQueueRepository
        .findPendingBatchWithSkipLocked(batchSize);

    batch.forEach(payment -> {
        payment.setStatus(PaymentStatus.PROCESSING);
        payment.setProcessingNode(workerId);
    });

    return paymentQueueRepository.saveAll(batch);
}
```

```java
@Query(value = """
    SELECT * FROM payment_queue
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT :batchSize
    FOR UPDATE SKIP LOCKED
    """, nativeQuery = true)
List<QueuedPayment> findPendingBatchWithSkipLocked(
    @Param("batchSize") int batchSize);
```

---

## 4. Advisory Locks

Advisory locks are application-level locks managed by the database. They do not lock actual data — the database just tracks that your application holds a named lock. They are ideal for distributed coordination in financial systems.

### 4.1 Session-Level Advisory Locks

Session-level advisory locks are held until explicitly released or the session ends:

```sql
-- Acquire an exclusive advisory lock by integer ID
-- pg_try_advisory_lock returns false if already locked (non-blocking)
SELECT pg_try_advisory_lock(12345);  -- Returns true/false

-- Acquire and block until available
SELECT pg_advisory_lock(12345);

-- Release
SELECT pg_advisory_unlock(12345);

-- Lock using bigint to represent a business entity
-- Hash account_id to get a stable integer lock key
SELECT pg_try_advisory_lock(hashtext('ACC-1001'));
```

### 4.2 Transaction-Level Advisory Locks

Transaction-level advisory locks are automatically released when the transaction commits or rolls back — much safer for application code:

```sql
BEGIN;

-- Acquire transaction-level advisory lock
SELECT pg_try_advisory_xact_lock(hashtext('ACC-1001'));
-- Returns true if acquired, false if already locked by another transaction

-- Now perform operations on account ACC-1001
UPDATE accounts SET balance = balance - 500 WHERE account_id = 'ACC-1001';

COMMIT;  -- Lock automatically released
```

### 4.3 Advisory Locks for Distributed Coordination

```java
@Service
public class DistributedAccountLockService {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Acquires a distributed advisory lock for an account.
     * Uses transaction-level lock — automatically released at commit/rollback.
     * Returns false immediately if another node holds the lock.
     */
    @Transactional
    public boolean tryLockAccount(String accountId) {
        long lockKey = accountId.hashCode();  // Or use a hash function
        Boolean acquired = jdbcTemplate.queryForObject(
            "SELECT pg_try_advisory_xact_lock(?)",
            Boolean.class, lockKey);
        return Boolean.TRUE.equals(acquired);
    }

    /**
     * Execute an operation with distributed lock guarantee.
     * Retries up to maxAttempts times if lock is contended.
     */
    @Transactional
    public <T> T withAccountLock(String accountId,
                                  Supplier<T> operation,
                                  int maxAttempts) {
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            if (tryLockAccount(accountId)) {
                return operation.get();
            }
            if (attempt < maxAttempts) {
                LockSupport.parkNanos(Duration.ofMillis(10 * attempt).toNanos());
            }
        }
        throw new LockAcquisitionException(
            "Could not acquire lock for account: " + accountId);
    }
}
```

### 4.4 Advisory Lock for Singleton Job Execution

```java
@Service
public class ReconciliationJobLock {

    private static final long RECONCILIATION_LOCK_ID = 9876543210L;

    @Transactional
    public boolean tryRunReconciliation(Runnable reconciliationLogic) {
        // Only one node in the cluster runs reconciliation at a time
        Boolean acquired = jdbcTemplate.queryForObject(
            "SELECT pg_try_advisory_xact_lock(?)",
            Boolean.class, RECONCILIATION_LOCK_ID);

        if (!Boolean.TRUE.equals(acquired)) {
            log.info("Reconciliation already running on another node");
            return false;
        }

        reconciliationLogic.run();
        return true;
    }
}
```

---

## 5. Deadlock Detection and Prevention

### 5.1 How PostgreSQL Detects Deadlocks

PostgreSQL runs a deadlock detection algorithm when a lock wait exceeds `deadlock_timeout` (default: 1 second). It builds a wait-for graph, finds cycles, and aborts one transaction (the "victim") with:

```
ERROR 40P01: deadlock detected
DETAIL: Process 1234 waits for ShareLock on transaction 5678;
        blocked by process 5678.
        Process 5678 waits for ShareLock on transaction 1234;
        blocked by process 1234.
```

### 5.2 Classic Deadlock Scenario

```sql
-- Transaction T1
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE account_id = 'ACC-1001';
-- (T1 holds lock on ACC-1001, waiting for ACC-1002)
UPDATE accounts SET balance = balance + 100 WHERE account_id = 'ACC-2002';

-- Transaction T2 (concurrent)
BEGIN;
UPDATE accounts SET balance = balance - 200 WHERE account_id = 'ACC-2002';
-- (T2 holds lock on ACC-2002, waiting for ACC-1001)
UPDATE accounts SET balance = balance + 200 WHERE account_id = 'ACC-1001';

-- DEADLOCK: T1 waits for T2, T2 waits for T1
-- PostgreSQL aborts one of them after deadlock_timeout
```

### 5.3 Prevention: Consistent Lock Ordering

```java
@Transactional
public TransferResult transfer(String fromAccountId,
                                String toAccountId,
                                BigDecimal amount) {
    // Always lock in ascending account_id order
    // This guarantees T1 and T2 always acquire locks in the same sequence
    String firstId = fromAccountId.compareTo(toAccountId) < 0
        ? fromAccountId : toAccountId;
    String secondId = fromAccountId.compareTo(toAccountId) < 0
        ? toAccountId : fromAccountId;

    Account first = accountRepository.findByIdWithLock(firstId);
    Account second = accountRepository.findByIdWithLock(secondId);

    Account from = first.getId().equals(fromAccountId) ? first : second;
    Account to = first.getId().equals(toAccountId) ? first : second;

    if (from.getBalance().compareTo(amount) < 0) {
        throw new InsufficientFundsException();
    }

    from.debit(amount);
    to.credit(amount);

    accountRepository.save(from);
    accountRepository.save(to);

    return TransferResult.success(from.getBalance(), to.getBalance());
}
```

### 5.4 Prevention: Lock Timeout

```sql
-- Set a lock acquisition timeout for the session
SET lock_timeout = '5s';  -- Fail after 5 seconds of waiting for a lock

-- Set for a specific transaction
BEGIN;
SET LOCAL lock_timeout = '2s';
SELECT * FROM accounts WHERE account_id = 'ACC-1001' FOR UPDATE;
-- If lock not acquired in 2 seconds: ERROR 55P03: lock timeout
COMMIT;
```

```java
// In Spring, configure lock_timeout via connection properties
@Bean
public DataSource dataSource(DataSourceProperties properties) {
    HikariDataSource ds = properties.initializeDataSourceBuilder()
        .type(HikariDataSource.class)
        .build();
    // Apply lock_timeout for all connections
    ds.setConnectionInitSql("SET lock_timeout = '5s'");
    return ds;
}
```

### 5.5 Deadlock Monitoring

```sql
-- Count deadlocks since last stats reset
SELECT deadlocks, blks_hit, blks_read
FROM pg_stat_database
WHERE datname = current_database();

-- Check deadlock_timeout setting
SHOW deadlock_timeout;

-- Check log_lock_waits (enable to log slow lock acquisitions)
SHOW log_lock_waits;
-- Enable: SET log_lock_waits = on;
```

---

## 6. Lock Monitoring — pg_locks

### 6.1 Viewing Active Locks

```sql
-- Full view of current locks with blocking relationship
SELECT
    blocked.pid,
    blocked.usename,
    blocked_activity.application_name,
    blocked_activity.query AS blocked_query,
    blocking.pid AS blocking_pid,
    blocking_activity.query AS blocking_query,
    blocked_locks.locktype,
    blocked_locks.relation::regclass AS locked_table,
    blocked_locks.mode AS requested_mode,
    blocking_locks.mode AS held_mode
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity
    ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity
    ON blocking_activity.pid = blocking_locks.pid
JOIN pg_catalog.pg_stat_activity blocked
    ON blocked.pid = blocked_locks.pid
WHERE NOT blocked_locks.granted;
```

### 6.2 Identifying Lock Contention Hotspots

```sql
-- Find relations with the most lock contention
SELECT
    relation::regclass AS table_name,
    mode,
    count(*) AS lock_count,
    count(*) FILTER (WHERE NOT granted) AS waiting_count
FROM pg_locks
WHERE relation IS NOT NULL
GROUP BY relation, mode
ORDER BY waiting_count DESC, lock_count DESC
LIMIT 20;
```

---

## 7. DDL Locking and Online Schema Changes

### 7.1 Why DDL Locks Are Dangerous in Production

`ALTER TABLE` acquires ACCESS EXCLUSIVE — blocking every query against the table. In a payment system processing 10,000 transactions/second, even a 100ms ALTER TABLE causes thousands of queries to queue.

```sql
-- DANGEROUS: Blocks all reads and writes on the accounts table
ALTER TABLE accounts ADD COLUMN kyc_verified BOOLEAN;
-- ACCESS EXCLUSIVE acquired — all sessions wait
```

The added danger: blocked queries queue up. When the DDL completes, all queued queries execute simultaneously, creating a thundering herd.

### 7.2 Safe DDL Patterns

```sql
-- SAFE: Adding a nullable column is instant in modern PostgreSQL
-- PostgreSQL 11+: no rewrite needed for nullable columns with no default
ALTER TABLE accounts ADD COLUMN kyc_tier SMALLINT;

-- SAFE: Adding a column with a constant default (PostgreSQL 11+)
-- PostgreSQL 11+ stores the default in catalog without rewriting rows
ALTER TABLE accounts ADD COLUMN kyc_verified BOOLEAN DEFAULT FALSE;
-- Pre-PostgreSQL 11: this rewrote the entire table! On PG11+ it is instant.

-- SAFE: Create index without blocking
CREATE INDEX CONCURRENTLY idx_accounts_kyc_verified
ON accounts (kyc_verified)
WHERE kyc_verified = TRUE;
-- CONCURRENTLY: takes ShareUpdateExclusiveLock (allows reads and writes)
-- Takes longer but does not block production traffic
```

### 7.3 Setting DDL Lock Timeout

```sql
-- Set a DDL statement timeout to avoid holding up the queue indefinitely
BEGIN;
SET LOCAL lock_timeout = '100ms';  -- Give up if DDL can't get a lock quickly
SET LOCAL statement_timeout = '30s';  -- Don't run forever if it does start

ALTER TABLE transactions ADD COLUMN risk_score SMALLINT;

COMMIT;
-- If the lock cannot be acquired in 100ms, the statement fails fast
-- Application can retry at a quieter time
```

### 7.4 pg_repack for Online Table Rewrites

When schema changes require a table rewrite (adding a NOT NULL column with a non-trivial default pre-PG11, changing column type, etc.), use `pg_repack`:

```bash
# Add a NOT NULL column with default safely (PostgreSQL 10 and earlier style)
# Step 1: Add nullable column (instant)
psql -c "ALTER TABLE transactions ADD COLUMN payment_channel VARCHAR(20)"

# Step 2: Backfill with a background UPDATE (batch to avoid lock storms)
# Step 3: Add NOT NULL constraint with VALIDATE (uses ShareUpdateExclusiveLock)
psql -c "ALTER TABLE transactions ALTER COLUMN payment_channel SET NOT NULL"

# For true table rewrites (changing column types):
pg_repack -d payments_db -t transactions --no-kill-backend
```

---

## 8. Lock Mode Quick Reference for Financial DDL Operations

| DDL Operation | Lock Mode | Blocks |
|--------------|-----------|--------|
| `SELECT` | ACCESS SHARE | Only ACCESS EXCLUSIVE |
| `INSERT/UPDATE/DELETE` | ROW EXCLUSIVE | SHARE and above |
| `CREATE INDEX` | SHARE | ROW EXCLUSIVE and above (blocks writes) |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | Minimal — allows DML |
| `VACUUM` | SHARE UPDATE EXCLUSIVE | Minimal — allows DML |
| `ANALYZE` | SHARE UPDATE EXCLUSIVE | Minimal — allows DML |
| `ALTER TABLE ADD COLUMN` (nullable, PG11+) | ACCESS EXCLUSIVE | ALL |
| `ALTER TABLE ADD CONSTRAINT` | ACCESS EXCLUSIVE | ALL |
| `TRUNCATE` | ACCESS EXCLUSIVE | ALL |
| `DROP TABLE` | ACCESS EXCLUSIVE | ALL |

---

## 9. Production Locking Best Practices

### 9.1 Application-Level Lock Checklist

```java
@Service
public class FinancialTransactionService {

    // Best practice 1: Always use explicit locking for read-modify-write
    @Transactional
    public void processPayment(PaymentRequest request) {
        // Lock in consistent order (sorted account IDs)
        List<String> accountIds = Stream.of(
            request.getFromAccount(), request.getToAccount())
            .sorted()
            .collect(Collectors.toList());

        // Lock all accounts in one query (more efficient than N separate queries)
        List<Account> accounts = accountRepository
            .findAllByIdInWithLock(accountIds);

        // Best practice 2: Fail fast on insufficient balance before modifying
        Account from = findAccount(accounts, request.getFromAccount());
        if (from.getBalance().compareTo(request.getAmount()) < 0) {
            throw new InsufficientFundsException(request.getFromAccount());
        }

        // Modify after validation
        Account to = findAccount(accounts, request.getToAccount());
        from.debit(request.getAmount());
        to.credit(request.getAmount());
        accountRepository.saveAll(List.of(from, to));
    }
}
```

### 9.2 Lock Contention Alerting

```java
@EventListener
@Async
public void onSlowLockAcquisition(LockAcquisitionSlowEvent event) {
    meterRegistry.counter("db.lock.slow_acquisition",
        Tags.of(
            "table", event.getTableName(),
            "operation", event.getOperationType()
        )).increment();

    if (event.getDurationMs() > 1000) {
        alertingService.sendAlert(
            AlertSeverity.WARNING,
            String.format("Lock wait > 1s on table %s for %s",
                event.getTableName(), event.getOperationType()));
    }
}
```

---

## Summary

PostgreSQL's locking system gives you precision control over concurrency in financial applications:

- **SELECT FOR UPDATE** serializes read-modify-write operations on specific rows — the backbone of safe balance updates
- **SELECT FOR SHARE** protects rows from modification while allowing concurrent readers — useful for validation workflows
- **SKIP LOCKED** enables high-throughput concurrent queue processing without coordination overhead
- **Advisory locks** provide distributed coordination primitives for singleton job execution and cross-service serialisation
- **Deadlock prevention** requires consistent lock ordering — always lock multiple rows in a deterministic sequence
- **DDL changes** in production require care — use `CREATE INDEX CONCURRENTLY`, set `lock_timeout`, and use `pg_repack` for table rewrites
- **Monitor pg_locks** proactively — lock contention is a leading indicator of correctness bugs and performance degradation

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A financial transfer service needs to update two account rows simultaneously. What is the most critical technique to prevent deadlocks when acquiring row-level locks on both rows?",
      "options": ["Use SELECT FOR SHARE on both rows", "Always acquire locks in a consistent, sorted order (e.g., by account_id)", "Use advisory locks instead of row-level locks", "Increase deadlock_timeout to 10 seconds"],
      "correct": 1,
      "explanation": "Deadlocks occur when two transactions acquire locks in opposite orders. Sorting account IDs and always locking the lower ID first ensures all transactions follow the same acquisition order, eliminating the circular wait condition that causes deadlocks."
    },
    {
      "text": "Your payment system uses a database queue table. Multiple worker nodes must each claim exactly one pending payment without any worker claiming the same payment. Which SQL clause enables this concurrent queue processing pattern?",
      "options": ["SELECT FOR SHARE", "SELECT FOR UPDATE NOWAIT", "SELECT FOR UPDATE SKIP LOCKED", "SELECT FOR NO KEY UPDATE"],
      "correct": 2,
      "explanation": "SKIP LOCKED causes the query to skip over rows that are already locked by another transaction. Each worker claims an unlocked pending payment atomically, preventing any two workers from claiming the same item, making it ideal for concurrent queue processing."
    },
    {
      "text": "An ALTER TABLE operation on a heavily-used payments table in production is causing all queries to queue up and timeout. What is the correct approach to add an index without blocking production traffic?",
      "options": ["Run ALTER TABLE during a maintenance window", "Use CREATE INDEX (standard) with a short lock_timeout", "Use CREATE INDEX CONCURRENTLY to allow DML during index creation", "Drop and recreate the table with the new index"],
      "correct": 2,
      "explanation": "CREATE INDEX CONCURRENTLY acquires only a SHARE UPDATE EXCLUSIVE lock, which allows concurrent reads and writes (DML) to continue during index creation. It takes two passes over the table and is slower than standard CREATE INDEX, but it does not block production traffic."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Deadlock-Safe Transfer Service with Advisory Locks",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a Java TransferService.transfer(fromId, toId, amount) method using SELECT FOR UPDATE with consistent lock ordering (sort account IDs before acquiring) to prevent deadlocks. Write a unit test using two concurrent threads that attempt transfers in opposite directions and verify no deadlock occurs."},
    {"id": "2", "description": "Build a PaymentQueueWorker that uses SELECT FOR UPDATE SKIP LOCKED to claim pending payments from a queue table. The worker should update the claimed row's status to 'processing' and processing_node within the same transaction. Use a CountDownLatch to test 10 concurrent workers claiming from a 10-item queue and verify each payment is claimed exactly once."},
    {"id": "3", "description": "Implement a DistributedAccountLockService using pg_try_advisory_xact_lock that serializes operations on the same account across JVM instances. The service must include retry logic with exponential backoff for up to 3 attempts, and throw LockAcquisitionException if all attempts fail."},
    {"id": "4", "description": "Create a SafeDDLMigration utility that wraps DDL operations with SET LOCAL lock_timeout = '100ms' to fail fast if the table is busy. Test the utility by running it concurrently with a long-running SELECT FOR UPDATE transaction and verify the DDL fails with a descriptive error rather than blocking indefinitely."}
  ]
}
-->
