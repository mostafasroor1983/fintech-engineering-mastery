---
id: track-05-lesson-17
sequence: 17
title: "Pessimistic Locking — SELECT FOR UPDATE and Advisory Locks"
slug: pessimistic-locking
track: track-05
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [pessimistic-locking, SELECT-FOR-UPDATE, advisory-locks, deadlock, PostgreSQL]
java-versions: [17, 21]
---

## Overview

Pessimistic locking assumes the worst: another transaction is about to touch the same row, so the database acquires an exclusive lock the moment you read it. In payment systems this is not paranoia — it is the correct default for any operation where the cost of a conflict exceeds the cost of waiting. Optimistic locking wins when conflicts are rare; pessimistic locking wins when they are not, and when user-facing correctness cannot tolerate a retry loop.

## Learning Objectives

- Explain the semantics of `SELECT FOR UPDATE`, `SKIP LOCKED`, and `NOWAIT` and when to choose each
- Implement `@Lock(LockModeType.PESSIMISTIC_WRITE)` on a Spring Data repository method
- Prevent deadlocks in fund-transfer flows by enforcing canonical lock ordering
- Describe how PostgreSQL detects deadlocks via its wait-for graph algorithm
- Use PostgreSQL advisory locks for distributed leader election and background job exclusivity
- Query `pg_locks` and `pg_stat_activity` to diagnose lock contention in production

## Business Context

*Composite example:* a mid-sized UK payments processor experiences a P1 incident during end-of-month bulk settlement. A batch job retried 12,000 failed payment records while the reconciliation job ran concurrently. Both jobs used optimistic locking with a single retry. Because 94% of the records were contested by both jobs simultaneously, the conflict rate exploded to 87% and each retry re-entered the same hot rows. The system issued 3.1× the expected database writes before the connection pool was exhausted. Settlement was delayed by 47 minutes, missing an internal settlement cut-off and triggering a formal incident review.

Post-incident review concluded that the batch job — which processed rows sequentially and never needed concurrent access to the *same* row from two threads — should have used `SELECT FOR UPDATE SKIP LOCKED` from the start. That variant is entirely non-blocking: each worker claims a row exclusively and skips any row already claimed by a peer. The incident drove the team to mandate pessimistic locking for all batch consumers and reserve optimistic locking for real-time, user-initiated mutations on low-contention accounts.

## SELECT FOR UPDATE: Row-Level Exclusive Locks

`SELECT FOR UPDATE` appends an exclusive lock to each row in the result set before returning them to the application. No other transaction can acquire a conflicting lock on those rows until the holding transaction commits or rolls back. The rows are still visible to plain `SELECT` queries (PostgreSQL uses MVCC for readers), but any attempt to lock them — including another `SELECT FOR UPDATE` — will block.

```sql
-- PostgreSQL: lock one account row for the duration of this transaction
BEGIN;
SELECT id, balance, version
  FROM accounts
 WHERE id = $1
   FOR UPDATE;

UPDATE accounts
   SET balance = balance - $2
 WHERE id = $1;

COMMIT;
```

In JPA, the equivalent is `LockModeType.PESSIMISTIC_WRITE`. Declare a dedicated repository method so the lock intent is explicit at the call site.

```java
@Repository
public interface AccountRepository extends JpaRepository<Account, UUID> {

    // Standard read — no lock
    Optional<Account> findById(UUID id);

    // Exclusive lock — must be called inside a transaction
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.id = :id")
    Optional<Account> findByIdForUpdate(@Param("id") UUID id);
}
```

```java
@Service
@RequiredArgsConstructor
public class WithdrawalService {

    private final AccountRepository accountRepository;

    @Transactional
    public void withdraw(UUID accountId, BigDecimal amount) {
        Account account = accountRepository.findByIdForUpdate(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));

        if (account.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException(accountId, amount);
        }

        account.setBalance(account.getBalance().subtract(amount));
        // JPA flushes the UPDATE on commit; the lock is released at that point
    }
}
```

> [!IMPORTANT]
> `findByIdForUpdate` must be called inside the same `@Transactional` method that performs the update. Outside a transaction, Hibernate rejects a locking query with `TransactionRequiredException`. Worse is the silent case: if only the repository call runs in its own tiny transaction, the lock is released the moment that call returns — before your update — and protects nothing.

## SKIP LOCKED and NOWAIT

PostgreSQL provides two non-blocking variants for specific use cases.

**`SKIP LOCKED`** skips rows that are already locked rather than waiting for them. This is the correct choice for work-queue consumers: multiple threads can process independent rows in parallel with zero contention.

```java
@Repository
public interface PaymentJobRepository extends JpaRepository<PaymentJob, UUID> {

    // Claim up to 50 unprocessed jobs; skip any already claimed by a peer worker
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
    @Query("""
        SELECT j FROM PaymentJob j
         WHERE j.status = com.example.payments.JobStatus.PENDING
         ORDER BY j.createdAt
         LIMIT 50
        """)
    List<PaymentJob> claimNextBatch();
}
```

The hint value `-2` maps to `FOR UPDATE SKIP LOCKED` in Hibernate's PostgreSQL dialect. Value `0` maps to `FOR UPDATE NOWAIT`. (`LIMIT` in a JPQL query needs Hibernate 6; on older versions use a native query.) The claimed rows stay locked only until the transaction ends, so process them — or mark them `PROCESSING` — inside that transaction.

**`NOWAIT`** raises an error immediately if any row in the result is already locked. Use this for user-facing operations where forcing the user to wait is unacceptable — the application can return a fast 409 Conflict rather than hanging until the holder commits.

```java
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "0"))
@Query("SELECT a FROM Account a WHERE a.id = :id")
Optional<Account> findByIdNowait(@Param("id") UUID id);
```

```java
@Transactional
public void processUserTransfer(UUID accountId, BigDecimal amount) {
    try {
        Account account = accountRepository.findByIdNowait(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));
        // ... debit logic
    } catch (PessimisticLockingFailureException ex) {
        // Another request is mid-flight on this account; tell the caller to retry
        throw new AccountTemporarilyUnavailableException(accountId);
    }
}
```

> [!NOTE]
> The value `-2` is Hibernate-specific. In a PostgreSQL deployment `jakarta.persistence.lock.timeout = 0` translates to `FOR UPDATE NOWAIT` and `-2` translates to `FOR UPDATE SKIP LOCKED` (Spring Boot 2 / Hibernate 5 used the `javax.persistence.*` name). Always verify the generated SQL after upgrading Hibernate or switching database vendors.

## Deadlock Prevention: Canonical Lock Ordering

A deadlock occurs when Transaction A holds a lock that Transaction B wants, while Transaction B holds a lock that Transaction A wants. For fund transfers — which must lock two account rows — the risk is real: two simultaneous transfers in opposite directions will deadlock if each transaction locks its own source account first.

```
Transfer A→B: locks account A, then tries to lock account B  ─┐
Transfer B→A: locks account B, then tries to lock account A  ─┴─ DEADLOCK
```

PostgreSQL detects deadlocks with its wait-for graph (a directed graph where an edge from T1 to T2 means T1 is waiting for a lock T2 holds). A backend that has waited for a lock longer than `deadlock_timeout` (default 1 second) checks the graph; if it finds a cycle, one transaction is rolled back with error code `40P01`. So a deadlock costs at least a second of hanging before the error is raised.

The classical prevention technique is **canonical lock ordering**: always acquire locks in the same global order. For account transfers, sort by account ID before locking. If every transaction acquires the numerically smaller UUID first, a cycle in the wait-for graph is structurally impossible.

```java
@Service
@RequiredArgsConstructor
public class TransferService {

    private final AccountRepository accountRepository;

    @Transactional
    public void transfer(UUID fromId, UUID toId, BigDecimal amount) {
        if (fromId.equals(toId)) {
            throw new IllegalArgumentException("Source and destination must differ");
        }
        // Canonical ordering: lock the account with the smaller UUID value first.
        // Both transfer directions will acquire locks in the same order,
        // making a deadlock cycle impossible.
        UUID firstId  = fromId.compareTo(toId) < 0 ? fromId : toId;
        UUID secondId = fromId.compareTo(toId) < 0 ? toId   : fromId;

        Account first  = accountRepository.findByIdForUpdate(firstId)
            .orElseThrow(() -> new AccountNotFoundException(firstId));
        Account second = accountRepository.findByIdForUpdate(secondId)
            .orElseThrow(() -> new AccountNotFoundException(secondId));

        // Re-map to semantic roles now that both rows are safely locked
        Account source      = first.getId().equals(fromId) ? first  : second;
        Account destination = first.getId().equals(fromId) ? second : first;

        if (source.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException(source.getId(), amount);
        }

        source.setBalance(source.getBalance().subtract(amount));
        destination.setBalance(destination.getBalance().add(amount));
    }
}
```

```mermaid
sequenceDiagram
    participant T1 as Transfer A→B
    participant T2 as Transfer B→A
    participant DB as PostgreSQL

    Note over T1,T2: Both sort account IDs — A < B in both cases

    T1->>DB: SELECT ... FROM accounts WHERE id=A FOR UPDATE
    DB-->>T1: Lock granted (A)
    T2->>DB: SELECT ... FROM accounts WHERE id=A FOR UPDATE
    DB-->>T2: Waiting for A...

    T1->>DB: SELECT ... FROM accounts WHERE id=B FOR UPDATE
    DB-->>T1: Lock granted (B)
    T1->>DB: UPDATE both rows, COMMIT
    DB-->>T1: Done — locks on A and B released

    DB-->>T2: Lock on A granted
    T2->>DB: SELECT ... FROM accounts WHERE id=B FOR UPDATE
    DB-->>T2: Lock granted (B)
    T2->>DB: UPDATE both rows, COMMIT
    DB-->>T2: Done
```

> [!WARNING]
> Canonical ordering only prevents deadlocks within a single code path. If a third service acquires locks on the same rows in a different order — for example, a background reconciliation job that sorts by `account_number` rather than UUID — deadlocks will still occur between services. Enforce lock ordering across *all* services that touch the same tables and document the rule in a shared Architecture Decision Record. Note that even "sort by UUID" is not automatically one rule: Java's `UUID.compareTo` compares the two halves as *signed* longs, which can differ from PostgreSQL's `ORDER BY` on a `uuid` column. The safest form is to lock all rows in one statement — `SELECT ... WHERE id IN (...) ORDER BY id FOR UPDATE` — so the database's own ordering applies everywhere.

## PostgreSQL Advisory Locks

Advisory locks are application-level locks managed by PostgreSQL but entirely outside the row/table locking system. They carry no semantic meaning to the database; they are simply named mutex slots that your application can acquire and release. They are ideal for:

- **Distributed leader election**: ensure only one pod runs a scheduled job at a time across a multi-instance deployment
- **Background job exclusivity**: prevent two instances from processing the same logical entity simultaneously without holding a row lock for the full processing duration

The key is a `BIGINT`. For domain objects, `hashtext(key_string)::bigint` produces a stable hash (a 32-bit hash, so unrelated keys can collide — a collision only makes two jobs wait for each other, but keep it in mind). Use `pg_try_advisory_xact_lock` for transaction-scoped locks (auto-released on commit/rollback) or `pg_try_advisory_lock` for session-scoped locks that must be explicitly released.

```java
@Component
@RequiredArgsConstructor
public class AdvisoryLocks {

    private final JdbcTemplate jdbc;   // joins the current Spring transaction's connection

    // Transaction-scoped: automatically released when the transaction ends.
    // Must be called inside a @Transactional method.
    // Returns true if the lock was acquired; false if another holder exists.
    public boolean tryAcquireTransactionLock(long key) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT pg_try_advisory_xact_lock(?)", Boolean.class, key));
    }
}
```

```java
@Service
@RequiredArgsConstructor
public class SettlementJobService {

    private final AdvisoryLocks       advisoryLocks;
    private final SettlementProcessor processor;

    // A fixed key ensures only one JVM instance runs settlement at a time.
    private static final long SETTLEMENT_LOCK_KEY = 0x5345544C4D4E5401L;

    @Transactional
    public void runDailySettlement(LocalDate settlementDate) {
        boolean acquired = advisoryLocks.tryAcquireTransactionLock(SETTLEMENT_LOCK_KEY);
        if (!acquired) {
            log.info("Settlement already running on another instance — skipping");
            return;
        }
        // Lock held for the duration of this transaction; released on commit
        processor.settle(settlementDate);
    }
}
```

For long-running processing that spans multiple transactions, use a session-scoped advisory lock. A session lock belongs to one *database connection*, so lock and unlock must happen on the same connection — never through a pooled call per statement, which may hand you a different connection each time:

```java
// Runs outside any transaction; holds ONE dedicated connection for the lock
public void processPaymentFile(UUID fileId) throws SQLException {
    long lockKey = fileId.getMostSignificantBits() ^ fileId.getLeastSignificantBits();

    try (Connection lockConn = dataSource.getConnection()) {
        if (!tryLock(lockConn, "SELECT pg_try_advisory_lock(?)", lockKey)) {
            log.warn("File {} is already being processed on another instance", fileId);
            return;
        }
        try {
            fileProcessor.process(fileId); // may span several internal transactions
        } finally {
            // Unlock on the SAME connection that took the lock
            tryLock(lockConn, "SELECT pg_advisory_unlock(?)", lockKey);
        }
    }
}

private static boolean tryLock(Connection c, String sql, long key) throws SQLException {
    try (PreparedStatement ps = c.prepareStatement(sql)) {
        ps.setLong(1, key);
        try (ResultSet rs = ps.executeQuery()) {
            rs.next();
            return rs.getBoolean(1);
        }
    }
}
```

> [!NOTE]
> Session-scoped advisory locks are **not** released by transaction rollback — only by an explicit unlock or by closing the connection. If the process dies, its connections close and the locks go with them. The dangerous case is a pooled connection: if the unlock is skipped, or runs on a different connection, the lock stays held by a connection that lives on in the pool, possibly for hours. For this reason, prefer transaction-scoped advisory locks whenever the work fits inside a single transaction boundary.

## Monitoring Lock Contention

Two PostgreSQL system views are essential for diagnosing lock problems in production.

**`pg_locks`** shows every lock currently held or awaited across all sessions; together with the function `pg_blocking_pids()` it tells you who is blocking whom:

```sql
-- Find all blocked sessions and the sessions blocking them.
-- pg_blocking_pids() covers every lock type (row, table, advisory).
SELECT
    blocked.pid                          AS blocked_pid,
    left(blocked.query, 120)             AS blocked_query,
    blocking.pid                         AS blocking_pid,
    left(blocking.query, 120)            AS blocking_query,
    blocking.state                       AS blocking_state,   -- 'idle in transaction' is a red flag
    blocked.wait_event                   AS wait_event,
    now() - blocked.query_start          AS blocked_duration
FROM pg_stat_activity AS blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON true
JOIN pg_stat_activity AS blocking
    ON blocking.pid = b.pid
ORDER BY blocked_duration DESC;
```

**`pg_stat_activity`** provides full query text and wait-event type. Filter on `wait_event_type = 'Lock'` to isolate transactions waiting on row locks specifically:

```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    wait_event_type,
    wait_event,
    now() - query_start  AS query_age,
    left(query, 120)     AS query_snippet
FROM pg_stat_activity
WHERE wait_event_type = 'Lock'
ORDER BY query_age DESC;
```

Add an alert when any transaction has been waiting longer than 5 seconds. In a healthy system under normal load, lock waits should be sub-millisecond; waits in the seconds range indicate missing canonical ordering, a long-running transaction holding locks, or an unexpected workload spike.

```java
@Component
public class LockWaitMetrics {

    private final JdbcTemplate jdbc;
    private final AtomicInteger waiting = new AtomicInteger();

    public LockWaitMetrics(JdbcTemplate jdbc, MeterRegistry meterRegistry) {
        this.jdbc = jdbc;
        // Register the gauge ONCE; it reads the AtomicInteger on every scrape.
        // (Re-registering inside the scheduled method would return the first
        //  gauge again, frozen on its first value.)
        Gauge.builder("db.lock.waiting_transactions", waiting, AtomicInteger::get)
             .description("Transactions currently waiting for a lock")
             .register(meterRegistry);
    }

    @Scheduled(fixedDelay = 10_000)
    public void recordLockWaitCount() {
        Integer count = jdbc.queryForObject("""
            SELECT COUNT(*)
              FROM pg_stat_activity
             WHERE wait_event_type = 'Lock'
            """, Integer.class);
        waiting.set(count != null ? count : 0);
    }
}
```

> [!WARNING]
> Be careful running lock diagnostic queries against a heavily loaded production database. `pg_locks` and `pg_stat_activity` are virtual views, but joining them on a 1,000-connection instance can consume noticeable CPU. They must run on the **primary** — lock information is per server, so a replica cannot see the primary's locks — so use a dedicated small connection pool with a `statement_timeout`, and do not poll more often than every few seconds.

## Knowledge Check

**Q1: A payment API endpoint must debit an account and return a response within 200 ms. The account row is currently locked by another transaction that has held it for 150 ms. Which variant should you use — `FOR UPDATE`, `FOR UPDATE NOWAIT`, or `FOR UPDATE SKIP LOCKED` — and why?**

Use `FOR UPDATE NOWAIT`. The endpoint must not wait an unknown duration for the holder to release. `NOWAIT` causes PostgreSQL to raise an error immediately, which the service translates into an HTTP 409 Conflict response. The client can retry after a short backoff. `SKIP LOCKED` does not apply here because the endpoint must process *this specific* account, not any available row from a pool. Plain `FOR UPDATE` would block until the holder commits, almost certainly violating the 200 ms SLA. (A middle ground is `SET LOCAL lock_timeout = '50ms'` before the locking read: a short, bounded wait instead of none.)

**Q2: Two services both use canonical lock ordering, but the transfer service sorts by UUID while the reconciliation service was recently updated to sort by `account_number` (VARCHAR). Can a deadlock still occur?**

Yes. Canonical ordering only prevents deadlocks when *all* participants use the *same* ordering. Sorting by UUID may produce the order [A, B] for two accounts. Sorting by `account_number` may produce the order [B, A] for the same accounts. This creates the classic conditions for a cycle in the wait-for graph. The fix is to establish a single global ordering rule — UUID or a stable numeric surrogate — and enforce it via a shared library method such as `LockOrderingUtils.sortForLocking(List<UUID> ids)` used by every service.

## Practical Challenge

A fintech startup runs a micro-lending platform. Each evening a batch job processes up to 50,000 loan repayment records. The job runs across four pods, each pulling records from a PostgreSQL table `loan_repayments(id UUID, loan_id UUID, status TEXT, amount NUMERIC, due_at TIMESTAMPTZ)`. Records have `status = 'PENDING'` when awaiting processing.

**Task 1 — Claim without contention.** Implement a Spring Data repository method `claimNextBatch(int batchSize)` that selects up to `batchSize` PENDING records, locks them with `SKIP LOCKED` so pods do not compete, and returns the claimed records. Provide the native SQL query and the repository method signature with appropriate JPA annotations.

**Task 2 — Safe concurrent transfer.** Upon processing a repayment, the batch job must debit the borrower's `wallet_accounts` row and credit the lender's row in a single transaction. Both rows must be locked before either balance is modified. Implement `RepaymentProcessor.applyRepayment(UUID borrowerId, UUID lenderId, BigDecimal amount)` with correct canonical lock ordering. Show how you sort the two IDs before calling `findByIdForUpdate`.

**Task 3 — Exclusive job guard.** Only one pod should run the daily interest-accrual job. Implement `InterestAccrualJob.run(LocalDate date)` using a transaction-scoped advisory lock. Derive the lock key deterministically from the job name and date using `hashtext('interest_accrual:' || date::text)::bigint`. Provide the native query and the service method.

**Task 4 — Monitoring alert.** Write a SQL query that returns, for each table currently involved in a lock wait, the table name, the count of blocked transactions, and the maximum wait duration. Explain how you would surface this as a Micrometer gauge in a Spring Boot application and what alert threshold you would configure for a payments system with a 500 ms P99 SLA.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment API endpoint must debit a specific account and return within 200 ms. The account row is currently locked by another transaction that has held it for 150 ms. Which SELECT FOR UPDATE variant should you use and why?",
      "options": [
        "FOR UPDATE — wait for the lock to be released; 150 ms hold means the account will be free in time",
        "FOR UPDATE SKIP LOCKED — skip this account and process a different one from the pool",
        "FOR UPDATE NOWAIT — raise an error immediately so the service can return a fast 409, allowing the client to retry after a short backoff rather than hanging and violating the SLA",
        "Plain SELECT without locking — the endpoint does not need to modify the row for a balance check"
      ],
      "correct": 2,
      "explanation": "FOR UPDATE NOWAIT causes PostgreSQL to raise an error immediately if any row in the result is already locked. The service catches PessimisticLockingFailureException and returns HTTP 409 Conflict, allowing the client to retry. FOR UPDATE would block for an unknown duration — the holder's remaining hold time is unknown and could easily exceed the 200 ms SLA. SKIP LOCKED applies to work queues where any available row is acceptable, not to endpoints that must process a specific account."
    },
    {
      "text": "Two services use canonical lock ordering, but the transfer service sorts by UUID while the reconciliation service was recently updated to sort by account_number (VARCHAR). Can a deadlock occur between them?",
      "options": [
        "No — both services still acquire exactly two locks, so the total lock count prevents cycles",
        "Yes — sorting by UUID may produce order [A, B] while sorting by account_number may produce [B, A] for the same two accounts, creating a cycle in the wait-for graph",
        "No — PostgreSQL's deadlock detection algorithm resolves this automatically within 1 second",
        "Yes — but only when both services run the exact same transaction concurrently, which is rare"
      ],
      "correct": 1,
      "explanation": "Canonical ordering only prevents deadlocks when ALL participants use the SAME ordering. If UUID order produces [A, B] but account_number order produces [B, A] for accounts A and B, the classic deadlock conditions exist: service 1 locks A then waits for B, service 2 locks B then waits for A — a cycle. The fix is a single global ordering rule enforced via a shared LockOrderingUtils.sortForLocking() method used by every service that touches the same tables."
    },
    {
      "text": "What is the correct use case for transaction-scoped advisory locks (pg_try_advisory_xact_lock) versus session-scoped advisory locks (pg_try_advisory_lock), and what is the operational risk of using session-scoped locks?",
      "options": [
        "Transaction-scoped locks are for single-row operations; session-scoped locks are for multi-table operations",
        "Transaction-scoped locks auto-release on commit/rollback and are preferred when work fits in one transaction; session-scoped locks persist across transactions and are NOT released on rollback — if the unlock is skipped or runs on a different pooled connection, the lock stays held by a connection that lives on in the pool",
        "Session-scoped locks are more efficient because they avoid re-acquiring the lock on each transaction retry",
        "Transaction-scoped locks can only be used with FOR UPDATE while session-scoped locks work independently"
      ],
      "correct": 1,
      "explanation": "Transaction-scoped advisory locks (pg_try_advisory_xact_lock) are released automatically when the transaction commits or rolls back. Session-scoped locks (pg_try_advisory_lock) belong to one database connection, persist across transactions and must be released explicitly with pg_advisory_unlock on that same connection. The critical risk is connection pooling: a skipped unlock, or an unlock sent on a different pooled connection, leaves the lock held by a connection that stays alive in the pool. Prefer transaction-scoped locks whenever work fits in a single transaction."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Pessimistic Locking for a Multi-Pod Loan Repayment Batch Processor",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a Spring Data repository method claimNextBatch(int batchSize) for the loan_repayments table that selects up to batchSize PENDING records using FOR UPDATE SKIP LOCKED so multiple pods do not compete for the same rows. Provide the native SQL query and the repository method signature with @Lock, @QueryHints, and @Query annotations. Explain why SKIP LOCKED is correct here rather than NOWAIT."},
    {"id": "2", "description": "Implement RepaymentProcessor.applyRepayment(UUID borrowerId, UUID lenderId, BigDecimal amount) that debits the borrower's wallet_accounts row and credits the lender's row in a single transaction. Both rows must be locked before either balance is modified. Implement canonical lock ordering by sorting the two UUIDs before calling findByIdForUpdate. Explain in a code comment why this ordering prevents deadlocks when two concurrent repayments involve the same two wallets in opposite roles."},
    {"id": "3", "description": "Implement InterestAccrualJob.run(LocalDate date) using a transaction-scoped advisory lock. Derive the lock key deterministically using hashtext('interest_accrual:' || date::text)::bigint via a native query. The job must check the lock result and log a message if another instance is already running, returning immediately without processing. Provide both the native query bean and the service method."},
    {"id": "4", "description": "Write a SQL query against pg_locks and pg_stat_activity that returns: table_name, blocked_transaction_count, max_wait_duration_ms for all tables currently involved in lock waits. Implement this as a Micrometer Gauge updated every 10 seconds using @Scheduled. Configure an alert threshold: for a 500 ms P99 SLA, at what max_wait_duration_ms should you fire a P2 alert? Justify your threshold with reference to Little's Law and typical lock hold times."}
  ]
}
-->
