---
id: track-10-lesson-03
title: "MVCC — Multi-Version Concurrency Control Deep Dive"
slug: mvcc
track: track-10
trackName: "Database & Data Architecture"
sequence: 3
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [MVCC, versioning, snapshot-isolation, vacuum, bloat]
prerequisites: []
---

# MVCC — Multi-Version Concurrency Control Deep Dive

> [!NOTE]
> MVCC is what allows PostgreSQL to serve thousands of concurrent transactions without readers blocking writers. Understanding it at the internals level is essential for diagnosing mysterious query slowdowns, preventing transaction ID wraparound outages, and designing update-heavy financial schemas that do not silently accumulate bloat until they fall over.

---

## 1. The Core Problem MVCC Solves

Classic locking databases have one version of each row. If a reader wants to read while a writer holds a lock, the reader blocks. In a high-throughput payment system processing thousands of transactions per second, blocking readers with writers would be catastrophic for latency.

MVCC solves this by keeping **multiple versions of each row simultaneously**. Writers create new versions. Readers see the version appropriate for their transaction snapshot. No blocking between readers and writers.

The price: old versions accumulate and must be cleaned up — the job of **VACUUM**.

---

## 2. PostgreSQL MVCC Internals — xmin and xmax

### 2.1 The Hidden System Columns

Every PostgreSQL row (called a "tuple") carries two hidden system columns:

| Column  | Meaning |
|---------|---------|
| `xmin`  | Transaction ID that created (inserted) this tuple |
| `xmax`  | Transaction ID that deleted or updated this tuple (0 if still live) |

```sql
-- See the hidden columns on the accounts table
SELECT xmin, xmax, ctid, account_id, balance
FROM accounts
WHERE account_id = 'ACC-1001';

-- ctid is the physical location: (page, row_offset)
-- xmin is when this version was created
-- xmax is when this version was superseded (0 = still current)
```

Sample output:
```
 xmin  | xmax  |  ctid  | account_id  | balance
-------+-------+--------+-------------+---------
 15420 |     0 | (0,42) | ACC-1001    | 1500.00
```

### 2.2 What Happens During UPDATE

When you UPDATE a row, PostgreSQL does NOT modify the existing tuple in place. It:
1. Marks the old tuple's `xmax` with the current transaction ID
2. Inserts a **new tuple** with `xmin` = current transaction ID and the new column values

```sql
-- Before UPDATE:
-- xmin=15420, xmax=0, balance=1500.00

UPDATE accounts SET balance = 1200.00 WHERE account_id = 'ACC-1001';

-- After UPDATE (two tuples exist simultaneously):
-- Old: xmin=15420, xmax=15500, balance=1500.00  (dead to transactions >= 15500)
-- New: xmin=15500, xmax=0,     balance=1200.00  (visible to transactions >= 15500)
```

This is why updates are more expensive than you might expect — they write new data to new pages.

### 2.3 DELETE

DELETE sets `xmax` on the existing tuple to the deleting transaction's ID. The tuple remains physically on disk until VACUUM removes it.

```sql
-- Before DELETE:
-- xmin=15420, xmax=0, balance=1500.00

DELETE FROM accounts WHERE account_id = 'ACC-1001';

-- After DELETE:
-- xmin=15420, xmax=15600, balance=1500.00  (dead to transactions >= 15600)
-- The row still occupies space on disk — VACUUM needed to reclaim it
```

---

## 3. Transaction Snapshots and Visibility Rules

### 3.1 How Snapshots Work

When a transaction begins (or a statement executes, depending on isolation level), PostgreSQL captures a **snapshot** containing:

- **xmin:** The lowest active transaction ID
- **xmax:** The next unassigned transaction ID (highest committed + 1)
- **xip_list:** List of active (not yet committed) transaction IDs in [xmin, xmax)

A tuple is **visible** to a snapshot if:
1. `tuple.xmin` is committed and less than snapshot's `xmax`, AND
2. `tuple.xmin` is not in `xip_list` (i.e., not still running when snapshot was taken)
3. `tuple.xmax` is 0, OR `tuple.xmax` is not yet committed, OR `tuple.xmax` >= snapshot's `xmax`

```sql
-- Inspect current transaction snapshot
SELECT txid_current_snapshot();
-- Returns something like: 15490:15502:15491,15499
-- Format: xmin:xmax:xip_list
-- xmin=15490: oldest active transaction
-- xmax=15502: next unassigned ID
-- xip_list=15491,15499: these are running and not visible yet
```

### 3.2 Snapshot Isolation vs Statement-Level Snapshots

This is the key difference between READ COMMITTED and REPEATABLE READ:

```sql
-- READ COMMITTED: snapshot per STATEMENT
BEGIN;
-- Statement 1: takes snapshot S1 at this point
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- (another session commits an update here)
-- Statement 2: takes snapshot S2 — includes the new commit
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns updated value!
COMMIT;

-- REPEATABLE READ: snapshot at TRANSACTION START
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- Snapshot S1 taken at transaction start
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- (another session commits an update here)
-- Still uses snapshot S1
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns original value — repeatable!
COMMIT;
```

---

## 4. Snapshot Isolation and Write Skew

REPEATABLE READ prevents non-repeatable reads and phantom reads, but it does NOT prevent write skew — a subtle anomaly where two transactions read overlapping data and make decisions that are individually valid but collectively inconsistent.

### 4.1 Write Skew in Payment Authorisation

```sql
-- Scenario: an account has two sub-accounts. Combined balance must stay >= 0.
-- ACC-1001: balance = 500
-- ACC-1002: balance = 500

-- Transaction T1 (payment from ACC-1001):
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- T1 reads combined balance: 500 + 500 = 1000
-- T1 decides: 800 is ok (1000 - 800 = 200 >= 0)
-- T1 debits ACC-1001: balance becomes -300... wait, that's wrong
-- Actually T1 reads ACC-1001 = 500, wants to debit 600:
SELECT SUM(balance) FROM accounts WHERE customer_id = 'CUST-001';
-- Returns 1000: proceed with 600 debit from ACC-1001

-- Transaction T2 (concurrent payment from ACC-1002):
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- T2 also reads combined balance: 500 + 500 = 1000 (same snapshot!)
SELECT SUM(balance) FROM accounts WHERE customer_id = 'CUST-001';
-- Returns 1000: proceed with 600 debit from ACC-1002

-- T1 commits: ACC-1001 = -100 (500 - 600)
-- T2 commits: ACC-1002 = -100 (500 - 600)
-- Total balance = -200! Both transactions passed validation but combined they're wrong
```

### 4.2 Fixing Write Skew

```java
// Option 1: Use SERIALIZABLE isolation
@Transactional(isolation = Isolation.SERIALIZABLE)
public void authorisePayment(String customerId, String accountId,
                              BigDecimal amount) {
    // PostgreSQL SSI detects the rw-anti-dependency and aborts one transaction
    BigDecimal combinedBalance = accountRepository
        .sumBalanceByCustomer(customerId);

    if (combinedBalance.subtract(amount).compareTo(BigDecimal.ZERO) < 0) {
        throw new InsufficientFundsException();
    }

    accountRepository.debit(accountId, amount);
}

// Option 2: Lock a "guardian" row to serialize the check
@Transactional
public void authorisePaymentWithLock(String customerId, String accountId,
                                      BigDecimal amount) {
    // Lock the customer record — serializes all payment authorisations
    // for this customer
    customerRepository.lockForUpdate(customerId);

    BigDecimal combinedBalance = accountRepository
        .sumBalanceByCustomer(customerId);

    if (combinedBalance.subtract(amount).compareTo(BigDecimal.ZERO) < 0) {
        throw new InsufficientFundsException();
    }

    accountRepository.debit(accountId, amount);
}
```

---

## 5. VACUUM and Dead Tuples

### 5.1 Why VACUUM Exists

After UPDATE and DELETE operations, dead tuples accumulate. Without cleanup:
1. Tables grow indefinitely (bloat)
2. Queries must scan more pages to find live tuples
3. Transaction ID wraparound can crash the database (covered below)

VACUUM removes dead tuples that are no longer visible to any active transaction.

```sql
-- Manually run VACUUM on the accounts table
VACUUM accounts;

-- VACUUM ANALYZE: clean dead tuples AND update statistics
VACUUM ANALYZE accounts;

-- VACUUM VERBOSE: show detailed progress
VACUUM VERBOSE accounts;
```

### 5.2 AUTOVACUUM

PostgreSQL's autovacuum daemon automatically runs VACUUM based on configurable thresholds:

```sql
-- Check autovacuum activity
SELECT schemaname,
       relname AS tablename,
       last_autovacuum,
       last_autoanalyze,
       n_dead_tup,
       n_live_tup,
       round(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2)
           AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

Default autovacuum trigger: fires when dead tuples exceed `autovacuum_vacuum_threshold` (50) + `autovacuum_vacuum_scale_factor` (0.2) × table row count.

For a 1,000,000-row table: fires at 50 + 200,000 = 200,050 dead tuples.

**Problem:** A financial transactions table that receives 10,000 updates/second will accumulate dead tuples faster than default autovacuum can handle.

### 5.3 Tuning AUTOVACUUM for Financial Tables

```sql
-- Per-table autovacuum tuning for high-churn financial tables
ALTER TABLE accounts SET (
    autovacuum_vacuum_scale_factor = 0.01,  -- 1% (default: 20%)
    autovacuum_analyze_scale_factor = 0.005, -- 0.5% (default: 10%)
    autovacuum_vacuum_cost_delay = 2,         -- ms between cost checks (default: 2)
    autovacuum_vacuum_cost_limit = 400        -- cost units per round (default: 200)
);

-- For extremely hot tables (e.g., balance updates on main accounts):
ALTER TABLE accounts SET (
    autovacuum_vacuum_scale_factor = 0.001,  -- 0.1%
    autovacuum_vacuum_threshold = 100,        -- absolute row threshold
    autovacuum_analyze_scale_factor = 0.001
);
```

```ini
# postgresql.conf global settings for high-volume fintech
autovacuum_max_workers = 6          # default: 3
autovacuum_vacuum_cost_delay = 2ms  # default: 2ms
autovacuum_vacuum_cost_limit = 400  # default: 200
autovacuum_naptime = 15s            # default: 1min — check more frequently
```

---

## 6. Table Bloat — Measuring and Remediating

### 6.1 Understanding Bloat

Bloat is the gap between the logical size of a table (live data) and its physical size on disk (live + dead tuples + empty space from previous vacuums). Heavy UPDATE workloads in financial systems are particularly prone to bloat.

```sql
-- Quick bloat estimate using pgstattuple extension
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT *
FROM pgstattuple('accounts');
-- Returns: table_len, tuple_count, tuple_len, dead_tuple_count,
--          dead_tuple_len, free_space, free_percent
```

```sql
-- More comprehensive bloat query (works without pgstattuple extension)
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
    n_dead_tup,
    n_live_tup,
    round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
ORDER BY n_dead_tup DESC;
```

### 6.2 VACUUM FULL vs pg_repack

`VACUUM FULL` rewrites the entire table, fully reclaiming bloat but holding an `ACCESS EXCLUSIVE` lock (blocks all reads and writes):

```sql
-- DANGEROUS in production: locks the table completely
VACUUM FULL accounts;
```

For production financial systems, use `pg_repack` which rewrites tables online with minimal locking:

```bash
# Install pg_repack
apt-get install postgresql-14-repack

# Repack a bloated table online (no long locks)
pg_repack -d payments_db -t accounts --no-kill-backend

# Repack an index (also reclaims index bloat)
pg_repack -d payments_db -i accounts_account_id_idx
```

### 6.3 Monitoring Index Bloat

```sql
-- Estimate index bloat
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Check for unused indexes (candidates for removal)
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan AS times_used
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND schemaname NOT IN ('pg_catalog')
ORDER BY pg_relation_size(indexrelid) DESC;
```

---

## 7. VACUUM FREEZE and Transaction ID Wraparound

### 7.1 The Wraparound Problem

PostgreSQL uses 32-bit transaction IDs. At roughly 2 billion transactions, the ID wraps around. Any tuple with an `xmin` older than 2 billion transactions would appear to be "in the future" and become invisible — effectively data loss.

This is not theoretical. In production financial systems processing millions of transactions per day, wraparound is a real operational risk.

### 7.2 How VACUUM FREEZE Works

VACUUM FREEZE replaces `xmin` values in old tuples with a special "frozen" transaction ID (`FrozenTransactionId = 2`), which is always considered visible. This permanently marks a tuple as committed and removes it from wraparound risk.

```sql
-- Check current transaction ID distance from wraparound
SELECT
    datname,
    age(datfrozenxid) AS xid_age,
    2000000000 - age(datfrozenxid) AS xids_remaining
FROM pg_database
ORDER BY age(datfrozenxid) DESC;
-- WARNING: If xid_age approaches 2 billion, you face a forced shutdown

-- Check per-table frozen XID age
SELECT
    schemaname,
    relname,
    age(relfrozenxid) AS xid_age,
    n_dead_tup
FROM pg_class c
JOIN pg_stat_user_tables t ON c.relname = t.relname
ORDER BY age(relfrozenxid) DESC
LIMIT 20;
```

```ini
# postgresql.conf: aggressive freeze settings for high-TPS systems
vacuum_freeze_min_age = 50000000          # default: 50M — freeze at 50M xid age
vacuum_freeze_table_age = 150000000       # default: 150M — force full scan
autovacuum_freeze_max_age = 200000000     # default: 200M — force autovacuum
```

### 7.3 Emergency Freeze

```sql
-- If xid_age is dangerously high (approaching 1.5B), force a freeze
VACUUM FREEZE VERBOSE accounts;

-- For the entire database (very expensive, blocks autovacuum workers)
-- Only in an emergency
VACUUM FREEZE;
```

PostgreSQL will also automatically enter a "read-only" emergency mode when any database's transaction ID age exceeds `autovacuum_freeze_max_age` and forcibly runs autovacuum. This can appear as a sudden performance degradation with no apparent cause — monitor `age(datfrozenxid)` proactively.

---

## 8. MVCC Impact on Financial Update-Heavy Tables

### 8.1 Hot Tables in Payment Systems

The `accounts` balance table is typically the hottest table in a payment system:
- Every payment debits a sender and credits a recipient (2 UPDATEs per transaction)
- At 1,000 transactions/second: 2,000 account row updates/second
- Each UPDATE creates a new tuple version
- At default autovacuum settings, bloat accumulates rapidly

### 8.2 HOT Updates (Heap-Only Tuples)

PostgreSQL has an optimization called HOT (Heap-Only Tuple) that reduces UPDATE overhead when:
1. The updated columns are not part of any index
2. The new tuple version fits on the same page as the old version

HOT updates avoid creating new index entries, significantly reducing write amplification.

```sql
-- Check HOT update efficiency for accounts table
SELECT
    relname,
    n_tup_upd AS total_updates,
    n_tup_hot_upd AS hot_updates,
    round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 2) AS hot_pct
FROM pg_stat_user_tables
WHERE relname = 'accounts';
-- Hot PCT below 50% suggests index-heavy table or high fillfactor issues
```

### 8.3 FILLFACTOR Tuning for HOT Updates

The `fillfactor` controls how full pages are packed initially. Leaving free space allows HOT updates to place the new tuple version on the same page as the old one.

```sql
-- Set fillfactor to 70% for the accounts table
-- This leaves 30% free space on each page for in-place HOT updates
ALTER TABLE accounts SET (fillfactor = 70);

-- Rebuild the table to apply the new fillfactor
VACUUM FULL accounts;  -- Or use pg_repack for online rebuild

-- After setting fillfactor, monitor HOT update percentage
-- Should increase significantly
```

**Rule of thumb for financial account tables:**
- Very high UPDATE rate, few columns indexed: `fillfactor = 70`
- Moderate UPDATE rate: `fillfactor = 80`
- Mostly INSERTs/SELECTs: `fillfactor = 90-100` (default 100)

### 8.4 Schema Design to Minimise MVCC Overhead

```sql
-- BAD: Storing balance on the account row causes heavy MVCC overhead
-- Every transaction updates a hot row
CREATE TABLE accounts_bad (
    account_id  VARCHAR(20) PRIMARY KEY,
    customer_id VARCHAR(20) NOT NULL,
    balance     NUMERIC(19, 4) NOT NULL,  -- Updated on every transaction
    updated_at  TIMESTAMPTZ NOT NULL
);

-- BETTER: Compute balance from an immutable transaction ledger
-- Only append INSERTs, never UPDATEs on the main ledger
CREATE TABLE ledger_entries (
    entry_id        BIGSERIAL PRIMARY KEY,
    account_id      VARCHAR(20) NOT NULL,
    amount          NUMERIC(19, 4) NOT NULL,  -- positive=credit, negative=debit
    transaction_ref VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Balance is a query, not a stored value
-- For performance, maintain a materialized balance with controlled update frequency
CREATE TABLE account_balances (
    account_id      VARCHAR(20) PRIMARY KEY,
    balance         NUMERIC(19, 4) NOT NULL,
    as_of_entry_id  BIGINT NOT NULL,  -- last ledger entry included in balance
    updated_at      TIMESTAMPTZ NOT NULL
);
```

---

## 9. Diagnosing MVCC Issues in Production

### 9.1 Identifying Long-Running Transactions

Long-running transactions prevent VACUUM from cleaning dead tuples created after they started:

```sql
-- Find transactions older than 5 minutes
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    backend_start,
    xact_start,
    now() - xact_start AS duration,
    state,
    left(query, 100) AS current_query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
  AND now() - xact_start > INTERVAL '5 minutes'
ORDER BY xact_start;

-- Kill a problematic long-running transaction (graceful)
SELECT pg_cancel_backend(pid);

-- Kill forcefully (last resort)
SELECT pg_terminate_backend(pid);
```

### 9.2 Checking Replication Slots Blocking VACUUM

Replication slots (used by CDC tools like Debezium) can block VACUUM if the downstream consumer falls behind:

```sql
-- Check replication slot lag
SELECT
    slot_name,
    plugin,
    slot_type,
    active,
    restart_lsn,
    confirmed_flush_lsn,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
        AS retained_wal_size
FROM pg_replication_slots;

-- If retained WAL is large and growing, the consumer is lagging
-- This prevents VACUUM from reclaiming dead tuples
```

### 9.3 Full MVCC Health Check Query

```sql
-- Comprehensive MVCC health check
SELECT
    'XID Age' AS metric,
    age(datfrozenxid)::text AS value,
    CASE
        WHEN age(datfrozenxid) > 1500000000 THEN 'CRITICAL'
        WHEN age(datfrozenxid) > 500000000  THEN 'WARNING'
        ELSE 'OK'
    END AS status
FROM pg_database WHERE datname = current_database()

UNION ALL

SELECT
    'Dead Tuple % (accounts)' AS metric,
    round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2)::text AS value,
    CASE
        WHEN n_dead_tup::float / NULLIF(n_live_tup + n_dead_tup, 0) > 0.2 THEN 'WARNING'
        ELSE 'OK'
    END AS status
FROM pg_stat_user_tables
WHERE relname = 'accounts';
```

---

## 10. Production Configuration Reference

```ini
# postgresql.conf settings for a high-TPS fintech PostgreSQL instance

# MVCC and VACUUM
autovacuum = on
autovacuum_max_workers = 6
autovacuum_naptime = 15s
autovacuum_vacuum_threshold = 50
autovacuum_vacuum_scale_factor = 0.01   # 1% for most tables
autovacuum_analyze_threshold = 50
autovacuum_analyze_scale_factor = 0.005 # 0.5%
autovacuum_vacuum_cost_delay = 2ms
autovacuum_vacuum_cost_limit = 400
autovacuum_freeze_max_age = 200000000
vacuum_freeze_min_age = 50000000
vacuum_freeze_table_age = 150000000

# Shared buffers and memory (affects how many dead tuples stay in memory)
shared_buffers = 4GB                   # 25% of RAM
work_mem = 64MB                        # per sort/hash operation
maintenance_work_mem = 1GB             # used by VACUUM
```

---

## Summary

MVCC is the foundation of PostgreSQL's concurrency model. Every UPDATE and DELETE creates dead tuple versions that must be cleaned by VACUUM. Key takeaways for financial systems:

- **xmin/xmax** are the versioning bookmarks on every tuple — understand them to reason about visibility
- **Snapshot isolation** gives each transaction (or statement in READ COMMITTED) a consistent point-in-time view
- **Write skew** is the REPEATABLE READ blind spot — use SERIALIZABLE or explicit locking for financial decisions
- **AUTOVACUUM** must be aggressively tuned for hot financial tables — increase workers, reduce scale factors
- **HOT updates** reduce write amplification when balance columns are not indexed — tune fillfactor accordingly
- **Transaction ID wraparound** is a database shutdown risk — monitor `age(datfrozenxid)` in production
- **Long-running transactions** and **replication slot lag** are VACUUM blockers — alert on both

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A PostgreSQL UPDATE on the accounts table sets the balance for 500 rows. How many tuple versions exist on disk immediately after the UPDATE completes (assuming no VACUUM has run)?",
      "options": [
        "500 — only the new versions exist; PostgreSQL replaces tuples in place",
        "1,000 — 500 old versions with xmax set and 500 new versions with xmin set",
        "500 new versions plus any old versions still visible to active transactions",
        "It depends on whether the update used HOT (Heap-Only Tuple) optimization"
      ],
      "correct": 1,
      "explanation": "PostgreSQL MVCC never modifies tuples in place. Each UPDATE creates a new tuple version (xmin = current transaction ID) and marks the old version as deleted (xmax = current transaction ID). Both versions coexist on disk until VACUUM removes the dead versions. So 500 UPDATEs create 500 old dead tuples + 500 new live tuples = 1,000 physical tuples for 500 logical rows."
    },
    {
      "text": "Your payment service's accounts table has 10 million rows updated at 2,000 rows/second (every payment debits sender and credits recipient). The default autovacuum_vacuum_scale_factor is 0.2 (20%). How many dead tuples accumulate before autovacuum fires?",
      "options": [
        "50 dead tuples (the autovacuum_vacuum_threshold default)",
        "2,000,050 dead tuples (20% of 10M rows + 50 threshold)",
        "200,000 dead tuples per minute (2,000 * 60 seconds * the scale factor does not matter)",
        "It fires immediately because the table is a hot financial table"
      ],
      "correct": 1,
      "explanation": "Autovacuum fires when dead tuples exceed: autovacuum_vacuum_threshold (50) + autovacuum_vacuum_scale_factor (0.2) * n_live_tup (10M) = 50 + 2,000,000 = 2,000,050 dead tuples. At 2,000 updates/second, this threshold is reached in about 1,000 seconds (~17 minutes). During those 17 minutes, dead tuples accumulate — causing table bloat and slower queries. The fix is per-table tuning: autovacuum_vacuum_scale_factor = 0.01 reduces the trigger to 100,050 dead tuples."
    },
    {
      "text": "A Debezium CDC connector's replication slot has been inactive for 48 hours due to a connector crash. What is the operational risk and correct remediation?",
      "options": [
        "No risk — PostgreSQL will automatically clean the stale slot after 24 hours",
        "WAL segments cannot be cleaned up while the slot is active, potentially filling the disk; drop the slot with pg_drop_replication_slot() after ensuring the data gap can be recovered via re-snapshot",
        "The slot will cause transaction ID wraparound because it holds old xmin values",
        "Restart PostgreSQL to clear the stale replication slot"
      ],
      "correct": 1,
      "explanation": "Replication slots prevent PostgreSQL from cleaning WAL segments that the slot has not yet consumed. An inactive slot for 48 hours means 48 hours of WAL accumulation — which can easily fill a disk on a high-TPS payment database. PostgreSQL will NOT auto-clean stale slots. The correct remediation is: (1) verify the Debezium connector is truly dead, (2) drop the slot with pg_drop_replication_slot(), (3) restart the connector which will perform a re-snapshot and resume from the current WAL position. The gap in CDC events must be handled in the downstream system."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "MVCC Health Monitoring and Autovacuum Tuning",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Write a SQL monitoring query that produces a health report for each financial table (accounts, transactions, ledger_entries) showing: dead tuple percentage, time since last autovacuum, estimated pages of bloat, HOT update percentage, and transaction ID age. Classify each metric as OK/WARNING/CRITICAL with appropriate thresholds for a high-TPS payment system."},
    {"id": "2", "description": "Using a Testcontainers PostgreSQL instance, demonstrate table bloat accumulation: insert 100,000 rows into an accounts table, then update all rows 5 times (500,000 total UPDATEs with no VACUUM). Measure the physical table size before and after to quantify bloat. Then run VACUUM ANALYZE and measure the size reduction."},
    {"id": "3", "description": "Configure per-table autovacuum settings for an accounts table that receives 2,000 UPDATEs/second. The goal is to prevent dead tuples from exceeding 1% of live tuples at any time. Calculate the required autovacuum_vacuum_scale_factor and autovacuum_vacuum_cost_limit settings, then validate with a pgbench workload."},
    {"id": "4", "description": "Build a Spring Boot scheduled job that monitors pg_stat_archiver and pg_replication_slots, fires PagerDuty-style alerts when WAL archiving lag exceeds 2 minutes or replication slot lag exceeds 100MB. Include a circuit breaker that drops a named replication slot after 1GB of lag accumulation (with appropriate logging and audit trail)."}
  ]
}
-->
