---
id: track-03-lesson-21
sequence: 21
title: "Concurrent Balance Management Patterns"
slug: concurrent-balance-management
track: track-03
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [balance-management, optimistic-locking, pessimistic-locking, SELECT-FOR-UPDATE]
java-versions: [17, 21]
---

## Overview

Balance management is the most financially consequential concurrent programming problem you will face. An overdraft caused by a race condition is not just a bug — it is a regulatory failure, a fraud vector, and a customer trust crisis. This lesson covers the full spectrum of approaches from in-memory atomic operations to distributed database locking, and when each is appropriate.

## Learning Objectives

By the end of this lesson you will be able to:

- Identify the three failure modes in concurrent balance updates (lost update, check-then-act overdraft, duplicate processing)
- Implement in-memory balance management with AtomicLong and CAS-based overdraft guards
- Use a single conditional `UPDATE` as the simplest safe database debit
- Apply optimistic locking with JPA `@Version` for low-contention balance updates
- Use pessimistic locking (`SELECT FOR UPDATE`) correctly for high-contention payment accounts
- Design idempotent balance operations that survive duplicate requests
- Choose the correct isolation level for read-your-writes consistency

## Business Context

A mobile wallet processes 8,000 transactions per second at peak. Customer accounts are read far more than written (90% read, 10% write). However, top-tier merchant accounts receive hundreds of simultaneous debits from payment terminals. The balance management strategy must handle both: lightweight reads for most accounts, contention-safe writes for high-traffic ones.

## The Three Failure Modes

### Lost Update

Two threads read the same balance, both compute new values, and one overwrites the other:

```
Thread A: read balance = 1000
Thread B: read balance = 1000
Thread A: write balance = 1000 - 200 = 800   ✓ debit 200
Thread B: write balance = 1000 - 300 = 700   ✗ LOST Thread A's debit
                                             ✗ Net debit should be 500, actual is 300
```

### Phantom Overdraft

Thread A checks balance (sufficient), Thread B drains the balance, Thread A debits below zero:

```
Thread A: read balance = 500  → check: 500 >= 300 ✓
Thread B: debit 400           → balance = 100
Thread A: debit 300           → balance = -200  ✗ OVERDRAFT
```

### Double Credit / Double Debit

A network retry submits the same transaction twice. Without idempotency, the balance changes twice.

## In-Memory Balance: AtomicLong with Guard

For accounts managed entirely in memory (caches, rate limiters, in-process wallets), `AtomicLong` provides lock-free correctness:

```java
public class InMemoryBalance {

    private final AtomicLong balanceCents;
    private final String     accountId;

    public InMemoryBalance(String accountId, long initialCents) {
        this.accountId    = accountId;
        this.balanceCents = new AtomicLong(initialCents);
    }

    // Simple credit — no overflow guard needed in most cases
    public long credit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException("Credit must be positive");
        return balanceCents.addAndGet(amountCents);
    }

    // Debit with overdraft prevention using CAS loop
    public DebitResult debit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException("Debit must be positive");

        while (true) {
            long current = balanceCents.get();
            if (current < amountCents) {
                return DebitResult.insufficientFunds(current, amountCents);
            }
            long next = current - amountCents;
            if (balanceCents.compareAndSet(current, next)) {
                return DebitResult.success(next);
            }
            // CAS failed — another thread modified balance; retry
        }
    }

    // Read current balance — single atomic read
    public long getBalance() {
        return balanceCents.get();
    }

    public record DebitResult(boolean success, long remainingBalance,
                              long requested, String failureReason) {
        static DebitResult success(long remaining) {
            return new DebitResult(true, remaining, 0, null);
        }
        static DebitResult insufficientFunds(long current, long requested) {
            return new DebitResult(false, current, requested,
                "Insufficient funds: balance=" + current + " requested=" + requested);
        }
    }
}
```

> [!WARNING]
> `AtomicLong` in-memory balance is correct within a single JVM process, but loses state on restart and cannot be shared across service instances. It is appropriate for: rate limiters, session-scoped temporary quotas, and testing. It is **not** appropriate for real account balances — not even with a write-behind cache, because a crash loses every change not yet written. The database is the source of truth.

## Database-Backed Balance: One Conditional UPDATE

For a single-account debit, the simplest safe option needs no application lock at all. The check and the change happen in **one** statement, so the database applies them atomically and holds the row lock only for that statement:

```sql
-- Debit only if the funds are there. 0 rows updated = insufficient funds
-- (or unknown account). No read-then-write race is possible.
UPDATE accounts
   SET balance_cents = balance_cents - :amount,
       version       = version + 1
 WHERE account_id = :id
   AND balance_cents >= :amount;
```

Use the patterns below when you need the whole entity in Java (several rules to check, several rows to change).

## Database-Backed Balance: Optimistic Locking

Optimistic locking assumes conflicts are rare. Each read includes a version number; on write, the version is compared. If another transaction modified the row, the version differs and the update fails — the caller retries.

### JPA Entity with @Version

```java
@Entity
@Table(name = "accounts")
public class Account {

    @Id
    private String accountId;

    @Column(nullable = false)
    private long balanceCents;

    @Version
    private long version;   // JPA increments this on every UPDATE

    @Column(nullable = false)
    private String currency;

    // Encapsulate mutation — never set balance directly from outside
    public void credit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException();
        this.balanceCents += amountCents;
    }

    public void debit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException();
        if (this.balanceCents < amountCents) {
            throw new InsufficientFundsException(accountId, balanceCents, amountCents);
        }
        this.balanceCents -= amountCents;
    }
}
```

### Service with Optimistic Retry

```java
@Service
public class OptimisticBalanceService {

    @Autowired private AccountRepository accountRepo;
    @Autowired private TransactionRepository txRepo;
    @Autowired private TransactionTemplate txTemplate;   // REQUIRED propagation

    private static final int MAX_RETRIES = 3;

    // NO @Transactional here: each attempt must run in its OWN transaction,
    // and the version conflict is only detected when that transaction
    // flushes/commits — so the retry loop must sit OUTSIDE the transaction.
    // (A private @Transactional method called via `this` would be ignored
    //  by the Spring proxy, so TransactionTemplate is used instead.)
    public void debit(String accountId, long amountCents, String idempotencyKey) {

        for (int attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                txTemplate.executeWithoutResult(status ->
                    doDebit(accountId, amountCents, idempotencyKey));
                return;  // Success (or duplicate — see doDebit)

            } catch (ObjectOptimisticLockingFailureException ex) {
                if (attempt == MAX_RETRIES - 1) {
                    throw new BalanceUpdateConflictException(
                        "Could not update balance after " + MAX_RETRIES + " attempts", ex);
                }
                // Backoff before retry
                try {
                    Thread.sleep(10L * (attempt + 1));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException(ie);
                }
            }
        }
    }

    // Runs inside the transaction opened by txTemplate: a fresh persistence
    // context, so the account is reloaded with its latest version
    private void doDebit(String accountId, long amountCents, String idempotencyKey) {
        // Claim the idempotency key FIRST: INSERT ... ON CONFLICT DO NOTHING.
        // The UNIQUE constraint — not an exists() check — is what stops a
        // concurrent duplicate: the second INSERT waits for the first
        // transaction, then inserts 0 rows
        if (txRepo.claimIdempotencyKey(idempotencyKey, accountId, -amountCents) == 0) {
            return;  // Already processed (or being processed) — no second debit
        }
        Account account = accountRepo.findById(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));
        account.debit(amountCents);
        // JPA checks @Version on flush at commit → ObjectOptimisticLockingFailureException;
        // the whole transaction (including the claimed key) rolls back and is retried
    }
}
```

**When to use optimistic locking:**
- Low contention: most accounts have few concurrent transactions
- Short transactions: read + validate + write completes quickly
- Acceptable to retry: customer-facing flows where retry is transparent

**When NOT to use optimistic locking:**
- High contention: merchant accounts receiving hundreds of simultaneous debits will retry continuously
- Long-held logical locks: multi-step workflows where the account must stay locked across service calls

## Database-Backed Balance: Pessimistic Locking

Pessimistic locking acquires a database row lock at read time. Other transactions that try to lock or update the same row wait until the lock is released. (In PostgreSQL, plain `SELECT`s are not blocked — MVCC lets them read the last committed version.)

### SELECT FOR UPDATE

```java
// Repository
public interface AccountRepository extends JpaRepository<Account, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.accountId = :id")
    Optional<Account> findByIdForUpdate(@Param("id") String id);
}
```

Generated SQL: `SELECT * FROM accounts WHERE account_id = ? FOR UPDATE`

```java
@Service
public class PessimisticBalanceService {

    @Autowired private AccountRepository accountRepo;
    @Autowired private TransactionRepository txRepo;

    @Transactional(isolation = Isolation.READ_COMMITTED, timeout = 5)
    public void debit(String accountId, long amountCents, String idempotencyKey) {

        // Claim the idempotency key in THIS transaction (INSERT ... ON CONFLICT
        // DO NOTHING). A concurrent duplicate waits on the unique index, then
        // gets 0 rows once we commit. A plain exists() check would let two
        // concurrent duplicates both pass.
        if (txRepo.claimIdempotencyKey(idempotencyKey, accountId, -amountCents) == 0) {
            return;
        }

        // Acquire row lock — blocks concurrent writers on this account
        Account account = accountRepo.findByIdForUpdate(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));

        account.debit(amountCents);   // throws → whole transaction (and claim) rolls back
        // Lock released on transaction commit/rollback
    }
}
```

### Lock Ordering for Multi-Account Operations

Transfers between accounts require locking two rows. Always lock in a canonical order (e.g. lexicographic account ID order) to prevent deadlock:

```java
@Transactional(isolation = Isolation.READ_COMMITTED, timeout = 10)
public void transfer(String fromId, String toId, long amountCents, String idempotencyKey) {

    if (fromId.equals(toId)) throw new IllegalArgumentException("Same account");

    // Claim the key first — the unique constraint stops concurrent duplicates
    if (txRepo.claimTransferKey(idempotencyKey, fromId, toId, amountCents) == 0) return;

    // Canonical lock order — prevents deadlock when two transfers go in opposite directions
    String firstId  = fromId.compareTo(toId) < 0 ? fromId : toId;
    String secondId = fromId.compareTo(toId) < 0 ? toId   : fromId;

    Account first  = accountRepo.findByIdForUpdate(firstId)
        .orElseThrow(() -> new AccountNotFoundException(firstId));
    Account second = accountRepo.findByIdForUpdate(secondId)
        .orElseThrow(() -> new AccountNotFoundException(secondId));

    Account from = fromId.equals(firstId) ? first : second;
    Account to   = fromId.equals(firstId) ? second : first;

    from.debit(amountCents);
    to.credit(amountCents);
}
```

### SKIP LOCKED: Work Queue Pattern

For batch debit processing, `SKIP LOCKED` lets multiple workers process different accounts concurrently without blocking each other:

```java
// Acquire up to 10 unsettled transactions, skip any already locked by other workers
// (Hibernate 6 HQL supports LIMIT; the lock timeout hint -2 means SKIP LOCKED)
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))  // SKIP LOCKED
@Query("SELECT t FROM PendingTransaction t WHERE t.status = 'PENDING' ORDER BY t.createdAt LIMIT 10")
List<PendingTransaction> claimBatch();
// The row locks last only until the transaction ends: process the rows (and
// set status = 'DONE') in the SAME transaction, or mark them 'CLAIMED' with a
// claim timestamp so a crashed worker's rows can be picked up again
```

Generated SQL: `SELECT ... FROM pending_transactions WHERE status='PENDING' ORDER BY ... LIMIT 10 FOR UPDATE SKIP LOCKED`

## Idempotent Balance Operations

Every balance mutation must be idempotent: processing the same request twice must produce the same end state as processing it once.

### Database-Level Idempotency

```sql
CREATE TABLE transactions (
    transaction_id  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,  -- unique constraint = idempotency
    account_id      VARCHAR(100) NOT NULL,
    amount_cents    BIGINT       NOT NULL,
    status          VARCHAR(50)  NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

```sql
-- Claim the key. Returns 1 row inserted for a new request, 0 for a duplicate.
-- Unlike catching a unique-violation error, ON CONFLICT DO NOTHING does not
-- abort the PostgreSQL transaction, so we can still read the original result.
INSERT INTO transactions (idempotency_key, account_id, amount_cents, status)
VALUES (:key, :account, :amount, 'PROCESSING')
ON CONFLICT (idempotency_key) DO NOTHING;
```

```java
@Transactional
public TransactionResult credit(String accountId, long amountCents, String idempotencyKey) {
    // Claim the idempotency key first — the unique constraint prevents duplicates
    int inserted = transactionRepo.claimIdempotencyKey(idempotencyKey, accountId, amountCents);
    if (inserted == 0) {
        // Duplicate key — return the original result
        return transactionRepo.findByIdempotencyKey(idempotencyKey)
            .map(TransactionResult::fromExisting)
            .orElseThrow();
    }

    Account account = accountRepo.findByIdForUpdate(accountId)
        .orElseThrow(() -> new AccountNotFoundException(accountId));
    account.credit(amountCents);
    transactionRepo.markCompleted(idempotencyKey, account.getBalanceCents());
    return TransactionResult.success(account.getBalanceCents());
}
```

## Choosing the Right Strategy

```
                    ┌──────────────────────────────────────┐
                    │        Balance Operation              │
                    └──────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
              Single JVM?                        Distributed?
                    │                                   │
        ┌───────────┴───────────┐           ┌──────────┴──────────┐
        │                       │           │                     │
   Temporary?             Persistent?  Low contention?    High contention?
        │                       │           │                     │
  AtomicLong             Database —     Optimistic           Pessimistic
   CAS loop              conditional    @Version +           SELECT FOR
                          UPDATE        retry (3×)           UPDATE + lock
                                                             ordering
```

| Scenario | Recommended Approach |
|----------|---------------------|
| Rate limiting, session quota | `AtomicLong` CAS in memory |
| Simple single-account debit or credit | One conditional `UPDATE ... WHERE balance_cents >= :amount` |
| Typical retail customer account | Optimistic locking (`@Version`) |
| Merchant receiving 100+ concurrent charges | Pessimistic (`SELECT FOR UPDATE`) |
| Batch settlement across thousands of accounts | `SKIP LOCKED` work queue |
| Cross-service distributed wallet | Saga + idempotency + eventual consistency |

## Knowledge Check

**Q1:** You use optimistic locking (`@Version`) on a merchant account receiving 500 concurrent debits. After running for 10 minutes in production, you observe `ObjectOptimisticLockingFailureException` flooding logs and 30% of debits failing after 3 retries. What should you do?

**A:** Switch to pessimistic locking (`SELECT FOR UPDATE`) for high-contention accounts. Optimistic locking assumes rare conflicts; at 500 concurrent debits, virtually every attempt collides. Each collision wastes a full transaction round-trip, then retries, amplifying database load. With pessimistic locking, threads queue at the database level and proceed sequentially — no wasted retries.

**Q2:** A debit request arrives twice with the same `idempotencyKey` within 5 seconds (network retry). Your pessimistic lock service has committed the first debit. What happens to the second?

**A:** The idempotency claim at the start of the transaction (`INSERT ... ON CONFLICT DO NOTHING`) inserts 0 rows, so the service returns early without locking or debiting. The balance is unchanged. If the duplicate arrives while the first request is still running, its INSERT waits on the unique index and then inserts 0 rows once the first commits — so even concurrent duplicates cannot double-charge.

## Practical Challenge

Design a balance management service for a payment wallet with the following requirements:

1. **Low-contention retail accounts** (< 10 concurrent transactions): Use optimistic locking with up to 3 retries, a new transaction per attempt, and 50 ms exponential backoff between attempts
2. **High-contention merchant accounts** (flagged via `account.highContention = true`): Use pessimistic `SELECT FOR UPDATE` with 5-second transaction timeout
3. **Idempotency**: All debit and credit operations require an `idempotencyKey`, claimed first via a unique constraint; duplicate keys return the original result
4. **Transfer**: Atomic cross-account transfer with canonical lock ordering to prevent deadlock
5. **Testing**: Write a jcstress-style concurrent test with 50 threads debiting 1 unit each from a balance of 50, asserting final balance is exactly 0 (no overdraft, no lost updates)

Provide entity class, repository interfaces with appropriate `@Lock` annotations, service class with routing logic, and the concurrent test.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A merchant account receives 500 concurrent debit requests using optimistic locking (@Version). After 10 minutes you observe 30% of debits failing with ObjectOptimisticLockingFailureException after 3 retries. What is the correct response?",
      "options": [
        "Increase the retry count from 3 to 10 to reduce failures",
        "Switch to pessimistic locking (SELECT FOR UPDATE) for high-contention accounts",
        "Use AtomicLong in-memory balance instead of database locking",
        "Add more database replicas to distribute the load"
      ],
      "correct": 1,
      "explanation": "Optimistic locking assumes rare conflicts. At 500 concurrent debits on the same account, virtually every attempt collides, causing retries that amplify database load. Pessimistic locking (SELECT FOR UPDATE) queues transactions at the database level and processes them one by one — no wasted retries. For a simple debit, a single conditional UPDATE (WHERE balance_cents >= :amount) is even cheaper."
    },
    {
      "text": "A debit request with idempotencyKey 'PAY-001' is submitted twice within 5 seconds (network retry). The first request was committed successfully. What happens to the second request with a correctly implemented idempotency check?",
      "options": [
        "The second request acquires the row lock and processes the debit again, causing a double charge",
        "The second request's idempotency claim (INSERT ... ON CONFLICT DO NOTHING) inserts 0 rows, so it returns early without locking or debiting, leaving the balance unchanged",
        "The second request throws a DuplicateKeyException which must be caught by the caller",
        "The database unique constraint causes the second request to wait until the first transaction expires"
      ],
      "correct": 1,
      "explanation": "The idempotency key is claimed first with INSERT ... ON CONFLICT DO NOTHING against a UNIQUE constraint. For the duplicate, 0 rows are inserted, so the service returns the original result without locking or debiting. Because the guard is the unique constraint (not an exists() check), it also works when both requests arrive at the same moment: the second INSERT waits for the first transaction and then inserts nothing."
    },
    {
      "text": "When implementing an atomic transfer between two accounts using pessimistic locking, why must the row locks be acquired in a canonical order (e.g., lexicographic by account ID)?",
      "options": [
        "To improve database query performance through index ordering",
        "To prevent deadlock when two concurrent transfers lock the same two accounts in opposite order",
        "Because PostgreSQL requires rows to be locked in primary key order",
        "To ensure the debit account is always locked before the credit account"
      ],
      "correct": 1,
      "explanation": "Without canonical lock ordering, two concurrent transfers (A→B and B→A) can deadlock: transfer 1 locks account A and waits for B, while transfer 2 locks account B and waits for A. By always locking in a consistent order (e.g., lexicographic account ID), both transfers lock in the same order, so the second waits for the first to complete rather than creating a cycle."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Concurrent Balance Management Service",
  "difficulty": "advanced",
  "estimatedMinutes": 75,
  "tasks": [
    {
      "id": "1",
      "description": "Implement an Account JPA entity with @Version for optimistic locking, encapsulated debit() and credit() methods that enforce business rules (no overdraft, positive amounts), and an AccountRepository with both a standard findById and a @Lock(PESSIMISTIC_WRITE) findByIdForUpdate method using @Query."
    },
    {
      "id": "2",
      "description": "Implement an OptimisticBalanceService with a debit(accountId, amountCents, idempotencyKey) method that runs each attempt in a new transaction (TransactionTemplate — no transaction around the retry loop), retries up to 3 times with 50ms exponential backoff on ObjectOptimisticLockingFailureException, and claims the idempotency key with INSERT ... ON CONFLICT DO NOTHING inside each attempt. Implement a PessimisticBalanceService that uses SELECT FOR UPDATE with READ_COMMITTED isolation and a 5-second transaction timeout."
    },
    {
      "id": "3",
      "description": "Implement a BalanceServiceRouter that selects OptimisticBalanceService for accounts where account.highContention == false and PessimisticBalanceService for high-contention accounts. Implement a transfer(fromId, toId, amountCents, idempotencyKey) method with canonical lock ordering (lexicographic by account ID) to prevent deadlock."
    },
    {
      "id": "4",
      "description": "Write a concurrent correctness test using 50 threads each debiting 1 unit from an account with an initial balance of 50. Assert that the final balance is exactly 0 (no overdraft, no lost updates). Also write a test for the transfer method that launches 100 concurrent threads performing random transfers between 10 accounts and asserts that the sum of all account balances equals the initial total (conservation of funds invariant)."
    }
  ]
}
-->
