---
id: track-07-lesson-19
title: "Database Partitioning — Range, Hash, and List Strategies"
slug: db-partitioning-strategies
track: track-07
trackName: "Performance Engineering"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - partitioning
  - range-partition
  - hash-partition
  - list-partition
  - PostgreSQL
  - performance
prerequisites:
  - track-07-lesson-18
---

# Database Partitioning — Range, Hash, and List Strategies

A fintech transaction table that accumulates one billion rows over three years is not an edge case — it is the routine. A single monolithic PostgreSQL table at that scale produces three concrete problems: query plans must scan enormous B-tree indexes, `VACUUM` and `ANALYZE` run for hours and compete with production load, and dropping old data requires a full table scan via `DELETE`. Declarative partitioning, introduced as a first-class feature in PostgreSQL 10 and significantly matured in PostgreSQL 12-15, solves all three by physically dividing the data into smaller child tables while presenting a single logical table to the application.

---

## 1. Why Partitioning?

Before reaching for partitioning, understand the three distinct problems it solves:

### 1.1 Table Bloat and Index Size

A B-tree index on a 1-billion-row table can occupy 20-50 GB on disk. When the hot part of the index does not fit in memory (`shared_buffers` plus the OS page cache), lookups turn into physical I/O. Partitioning splits the index across child tables — a query filtering by `transaction_date` only loads the index for that month's partition.

### 1.2 Query Performance via Partition Pruning

The query planner examines partition bounds and eliminates partitions that cannot contain matching rows. This is called **partition pruning**. A query for last month's transactions on a range-partitioned table scans one partition (say 50 million rows) instead of three years of data (1 billion rows) — a 20x reduction in work.

### 1.3 Maintenance Efficiency

**VACUUM:** PostgreSQL's autovacuum works partition-by-partition. Old partitions with no writes need no vacuuming. Only the current partition generates dead tuples.

**Data lifecycle:** Dropping three-year-old data is `DROP TABLE transactions_2021_01` (instantaneous) instead of `DELETE FROM transactions WHERE transaction_date < '2022-01-01'` (hours of I/O, bloat, WAL amplification).

---

## 2. PostgreSQL Declarative Partitioning

Since PostgreSQL 10, you declare partitioning strategy on the parent table and create child partitions with `FOR VALUES`.

### 2.1 Partitioning Strategy Selection

```
Decision tree for partition strategy:

Is your primary query filter a time-range column (created_at, transaction_date)?
  YES → Range partitioning on that column

Is your primary goal even data distribution for parallel query or write scaling?
  YES → Hash partitioning on the distribution key (account_id, customer_id)

Do you need to co-locate data by a categorical value (region, currency, status)?
  YES → List partitioning on that category
```

---

## 3. Range Partitioning by Transaction Date

Range partitioning is the most common strategy for fintech. Payment and transaction tables grow over time, queries most often filter by recent dates, and old data has predictable retention requirements (set by financial record-keeping and AML rules — often 5 to 7+ years depending on jurisdiction — then drop).

### 3.1 Create the Partitioned Parent Table

```sql
-- Parent table: no data lives here, only structure
CREATE TABLE transactions (
    transaction_id      BIGSERIAL,
    account_id          BIGINT          NOT NULL,
    transaction_date    DATE            NOT NULL,
    amount_cents        BIGINT          NOT NULL,
    currency            CHAR(3)         NOT NULL,
    transaction_type    VARCHAR(20)     NOT NULL,
    status              VARCHAR(20)     NOT NULL DEFAULT 'PENDING',
    reference           VARCHAR(100),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (transaction_id, transaction_date)  -- partition key must be in PK
) PARTITION BY RANGE (transaction_date);
```

**Important:** The partition key (`transaction_date`) must be included in the primary key. This is a PostgreSQL constraint — unique indexes and primary keys must include the partition key.

### 3.2 Create Monthly Partitions

```sql
-- 2024 partitions
CREATE TABLE transactions_2024_01
    PARTITION OF transactions
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE transactions_2024_02
    PARTITION OF transactions
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

CREATE TABLE transactions_2024_03
    PARTITION OF transactions
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');

-- ... continue for all months

CREATE TABLE transactions_2024_12
    PARTITION OF transactions
    FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');

-- Default partition catches rows that do not match any explicit partition
-- Use this as a safety net; monitor it and move rows to proper partitions.
-- Caveats: creating a new partition must check the default partition (and
-- FAILS if it already holds rows for the new range), and
-- DETACH ... CONCURRENTLY is not allowed while a default partition exists.
CREATE TABLE transactions_default
    PARTITION OF transactions
    DEFAULT;
```

### 3.3 Partition Indexes

Indexes on the parent table are automatically created on each child partition:

```sql
-- Index on parent = index on all partitions (created automatically for new partitions)
CREATE INDEX idx_transactions_account_date
    ON transactions (account_id, transaction_date);

CREATE INDEX idx_transactions_status
    ON transactions (status)
    WHERE status IN ('PENDING', 'PROCESSING');  -- partial index

-- For a specific high-traffic partition, you can add an extra index
CREATE INDEX idx_transactions_2024_12_created
    ON transactions_2024_12 (created_at)
    INCLUDE (amount_cents, currency);
```

### 3.4 Verifying Partition Pruning

Run `EXPLAIN` to verify PostgreSQL prunes partitions correctly:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT transaction_id, amount_cents, currency
FROM transactions
WHERE account_id = 42
  AND transaction_date >= '2024-11-01'
  AND transaction_date  < '2024-12-01';
```

Expected output excerpt (only ONE partition appears in the plan):

```
Index Scan using transactions_2024_11_account_id_transaction_date_idx
      on transactions_2024_11 transactions
  Index Cond: ((account_id = 42) AND (transaction_date >= '2024-11-01'::date)
               AND (transaction_date < '2024-12-01'::date))
  Buffers: shared hit=4
```

Partitions pruned at plan time simply do not appear in the plan. When pruning happens at run time (for example with bind parameters in a generic prepared plan), the plan shows `Subplans Removed: N` under the `Append` node instead.

If every partition appears in the plan, the partition key is not in the WHERE clause, or a function is applied to it (`WHERE EXTRACT(MONTH FROM transaction_date) = 11` disables pruning — use range predicates directly).

---

## 4. Hash Partitioning by Account ID

Hash partitioning divides data by computing a hash of the partition key modulo the number of partitions. Use this when:
- You need even write distribution across partitions (no hot partitions)
- Your queries frequently filter by the hash key (account_id)
- You want to parallelise operations across partitions

### 4.1 Create Hash-Partitioned Table

```sql
CREATE TABLE account_balances (
    account_id      BIGINT          NOT NULL,
    currency        CHAR(3)         NOT NULL,
    balance_cents   BIGINT          NOT NULL,
    last_updated    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    version         BIGINT          NOT NULL DEFAULT 0,  -- for optimistic locking
    PRIMARY KEY (account_id, currency)
) PARTITION BY HASH (account_id);
```

### 4.2 Create Hash Partitions

```sql
-- 8 partitions: PostgreSQL computes (hash(account_id) % 8) to route rows
CREATE TABLE account_balances_p0
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 0);

CREATE TABLE account_balances_p1
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 1);

CREATE TABLE account_balances_p2
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 2);

CREATE TABLE account_balances_p3
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 3);

CREATE TABLE account_balances_p4
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 4);

CREATE TABLE account_balances_p5
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 5);

CREATE TABLE account_balances_p6
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 6);

CREATE TABLE account_balances_p7
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 7);
```

**Choosing partition count:** Powers of 2 make future repartitioning easier. Start with the number of CPU cores on your largest read replica, or the number of parallel workers (`max_parallel_workers_per_gather`). For account_balances with 100 million accounts and 8 partitions, each partition holds ~12.5 million rows — a comfortable index size.

### 4.3 Even Distribution Verification

```sql
SELECT
    tableoid::regclass AS partition,
    COUNT(*)           AS row_count
FROM account_balances
GROUP BY tableoid
ORDER BY partition;

-- Expected (should be within 2% of each other):
-- account_balances_p0 | 12,489,344
-- account_balances_p1 | 12,502,117
-- account_balances_p2 | 12,494,890
-- ...
```

---

## 5. List Partitioning by Region

List partitioning assigns specific values to specific partitions. Typical fintech uses are per-region operations (different retention, maintenance windows or batch jobs per region) and keeping regional data separable. Note on **data residency**: GDPR does not require EU data to be stored in the EU — it restricts *transfers* outside the EEA (adequacy decisions, standard contractual clauses). Some national or sector rules and customer contracts do require local storage; PCI DSS has no data-location rule.

### 5.1 Create List-Partitioned Table

```sql
CREATE TABLE customer_profiles (
    customer_id     BIGINT          NOT NULL,
    region          VARCHAR(10)     NOT NULL,  -- EU, US, APAC, LATAM
    email           VARCHAR(255)    NOT NULL,
    full_name       VARCHAR(200)    NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    gdpr_consent    BOOLEAN         NOT NULL DEFAULT false,
    PRIMARY KEY (customer_id, region)
) PARTITION BY LIST (region);
```

### 5.2 Create List Partitions

```sql
-- Each partition can have multiple values
CREATE TABLE customer_profiles_eu
    PARTITION OF customer_profiles
    FOR VALUES IN ('EU', 'UK', 'CH', 'NO');

CREATE TABLE customer_profiles_us
    PARTITION OF customer_profiles
    FOR VALUES IN ('US', 'CA', 'MX');

CREATE TABLE customer_profiles_apac
    PARTITION OF customer_profiles
    FOR VALUES IN ('APAC', 'AU', 'NZ', 'SG', 'JP');

CREATE TABLE customer_profiles_latam
    PARTITION OF customer_profiles
    FOR VALUES IN ('LATAM', 'BR', 'AR', 'CO');

-- Default partition for regions not yet explicitly mapped
CREATE TABLE customer_profiles_other
    PARTITION OF customer_profiles
    DEFAULT;
```

### 5.3 Tablespaces Are Not Data Residency

A tablespace is just a directory on the **same database server**. You can put partitions on different disks (for example, old partitions on cheaper storage), but you cannot place one partition of a table in another data centre: mounting remote storage for PostgreSQL data files is unsafe, and the server, its WAL, backups and replicas would still be in one place.

```sql
-- Legitimate use: move cold partitions to cheaper local storage
CREATE TABLESPACE archive_storage LOCATION '/mnt/archive-disk/pgdata';
ALTER TABLE transactions_2021_01 SET TABLESPACE archive_storage;
-- (SET TABLESPACE rewrites the table under an ACCESS EXCLUSIVE lock)
```

When data really must stay in a country or region, run a **separate database cluster in that region** (with its own replicas and backups) and route customers to it in the application layer.

---

## 6. Partition Maintenance Operations

### 6.1 Adding a New Partition

Always create the next partition before data arrives. Use a scheduled job or pg_partman.

```sql
-- Create next month's partition (run this in mid-month)
CREATE TABLE transactions_2025_01
    PARTITION OF transactions
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

### 6.2 Detaching a Partition for Archival

DETACH makes the child table a standalone table (a metadata change). A plain `DETACH PARTITION` takes an `ACCESS EXCLUSIVE` lock on the parent — brief, but it blocks queries while it waits. `DETACH ... CONCURRENTLY` (PostgreSQL 14+) avoids that, but it cannot run inside a transaction block and is not allowed while the table has a default partition.

```sql
-- Step 1: Detach (PostgreSQL 14+, no default partition on the table)
ALTER TABLE transactions
    DETACH PARTITION transactions_2021_01 CONCURRENTLY;

-- Without CONCURRENTLY (or before PostgreSQL 14) the detach takes a
-- brief ACCESS EXCLUSIVE lock on the parent -- set a lock_timeout

-- Step 2: Verify data, then archive or drop
-- Archive to cold storage (export to Parquet/S3 first if needed)
DROP TABLE transactions_2021_01;  -- Near-instant, no bloat, minimal WAL
```

### 6.3 Attaching an Existing Table as a Partition

You can attach a pre-populated table as a partition. PostgreSQL validates that all rows satisfy the partition constraint.

```sql
-- Pre-populate in a separate table (e.g., migrated from legacy system)
CREATE TABLE transactions_2019_legacy (LIKE transactions INCLUDING ALL);
-- ... bulk load data ...

-- Attach: PostgreSQL scans the table to validate constraints
ALTER TABLE transactions
    ATTACH PARTITION transactions_2019_legacy
    FOR VALUES FROM ('2019-01-01') TO ('2020-01-01');
```

To skip the full table scan during attach (when you know the data is valid):

```sql
-- Add constraint first (fast CHECK, no scan needed)
ALTER TABLE transactions_2019_legacy
    ADD CONSTRAINT chk_date
    CHECK (transaction_date >= '2019-01-01' AND transaction_date < '2020-01-01')
    NOT VALID;

-- Validate: this DOES scan the table, but with a weaker lock
-- (SHARE UPDATE EXCLUSIVE), so normal reads and writes continue
ALTER TABLE transactions_2019_legacy VALIDATE CONSTRAINT chk_date;

-- Now attach without rescan (PostgreSQL trusts the validated constraint)
ALTER TABLE transactions
    ATTACH PARTITION transactions_2019_legacy
    FOR VALUES FROM ('2019-01-01') TO ('2020-01-01');
```

---

## 7. pg_partman for Automated Partition Management

Manual partition creation is error-prone in production. `pg_partman` is a PostgreSQL extension that automates partition creation, maintenance, and retention.

### 7.1 Installation

```sql
-- Install extension (requires pg_partman to be installed on the OS)
-- Ubuntu/Debian: apt install postgresql-16-partman
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION pg_partman SCHEMA partman;
```

### 7.2 Configure Auto-Management

```sql
-- Set up pg_partman (5.x syntax) to manage the transactions table
-- Creates monthly partitions, premake=4 means create 4 future partitions in advance.
-- pg_partman also creates its own default partition by default -- do not
-- create a second one by hand.
SELECT partman.create_parent(
    p_parent_table   => 'public.transactions',
    p_control        => 'transaction_date',
    p_type           => 'range',
    p_interval       => '1 month',
    p_premake        => 4,       -- create 4 months ahead
    p_start_partition => '2024-01-01'::text
);

-- Configure retention (drop partitions older than 7 years)
UPDATE partman.part_config
SET retention              = '7 years',
    retention_keep_table   = false,  -- actually drop
    infinite_time_partitions = true,
    automatic_maintenance  = 'on'
WHERE parent_table = 'public.transactions';
```

### 7.3 Scheduled Maintenance

```sql
-- Run from pg_cron or an external scheduler (every 1 hour)
SELECT partman.run_maintenance();

-- Or configure pg_cron:
-- CREATE EXTENSION pg_cron;
-- SELECT cron.schedule('0 * * * *', 'SELECT partman.run_maintenance()');
```

---

## 8. Cross-Partition Queries and Their Cost

### 8.1 When Pruning Cannot Help

```sql
-- BAD: No partition key in WHERE clause — full scan of all partitions
SELECT COUNT(*)
FROM transactions
WHERE status = 'FAILED';

-- EXPLAIN shows:
-- Append (all 36 partitions scanned)
-- estimated rows: 1,000,000,000
```

For this query pattern, you have two options:
1. **Partial index on each partition:** `CREATE INDEX ON transactions (status) WHERE status = 'FAILED'` — fast per-partition, but all 36 partitions are still visited.
2. **Separate summary/aggregate table:** Maintain a `transaction_status_counts` table updated by triggers or the application. Cross-partition aggregates become a single-row lookup.

### 8.2 Foreign Keys Across Partitioned Tables

Foreign keys referencing a partitioned table are supported from PostgreSQL 12, but they come with a caveat:

```sql
-- This works in PostgreSQL 12+
ALTER TABLE transaction_line_items
    ADD CONSTRAINT fk_transaction
    FOREIGN KEY (transaction_id, transaction_date)
    REFERENCES transactions (transaction_id, transaction_date);
```

The FK check scans the correct partition (pruning applies), so performance is acceptable. However, the FK must include the partition key — another reason to always include `transaction_date` in the primary key.

### 8.3 Parallel Query Across Partitions

PostgreSQL can query partitions in parallel using `max_parallel_workers_per_gather`:

```sql
-- Enable parallel query for cross-partition aggregation
SET max_parallel_workers_per_gather = 8;

-- The planner may now use up to 8 workers (also limited by
-- max_parallel_workers and max_worker_processes), e.g. a Parallel Append
-- that spreads partitions across workers
SELECT
    DATE_TRUNC('month', transaction_date) AS month,
    SUM(amount_cents) AS total_volume,
    COUNT(*)          AS transaction_count
FROM transactions
WHERE transaction_date >= '2024-01-01'
GROUP BY 1
ORDER BY 1;
```

---

## 9. Partition Strategy Comparison

```
+------------------+-----------+------------+-----------+-----------+
| Criterion        | Range     | Hash       | List      | None      |
+------------------+-----------+------------+-----------+-----------+
| Time-based query | Excellent | Poor       | Poor      | Poor      |
| Write hot spots  | High      | None       | Medium    | High      |
| Data residency   | Possible  | No         | Natural   | No        |
| Pruning ease     | Automatic | Needs key  | Automatic | N/A       |
| Data archival    | Trivial   | Manual     | Manual    | Expensive |
| Partition count  | Bounded   | Fixed      | Variable  | N/A       |
| Maintenance      | pg_partman| Manual     | Manual    | None      |
+------------------+-----------+------------+-----------+-----------+
```

---

## 10. Production Pitfalls

### Pitfall 1: Missing Partition Causes Insert Failure

**The problem:** Without a default partition, inserting a row whose partition key value does not match any existing partition raises an error. If pg_partman has not yet created next month's partition and an end-of-month timestamp crosses the boundary, your payment inserts fail.

**Failing example:**

```sql
-- It is 2024-12-31 23:59:59. The 2025-01 partition does not exist yet.
INSERT INTO transactions (account_id, transaction_date, amount_cents, currency, transaction_type, status)
VALUES (42, '2025-01-01', 10000, 'USD', 'DEBIT', 'PENDING');

-- ERROR:  no partition of relation "transactions" found for row
-- DETAIL:  Failing row contains (42, 2025-01-01, 10000, USD, DEBIT, PENDING).
```

**Correct approach:**

```sql
-- Always have a default partition as a safety net
CREATE TABLE transactions_default
    PARTITION OF transactions
    DEFAULT;

-- Monitor the default partition for unexpected rows
CREATE OR REPLACE FUNCTION alert_on_default_partition_growth()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    row_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO row_count FROM transactions_default;
    IF row_count > 1000 THEN
        RAISE WARNING 'Default partition has % rows — a named partition may be missing', row_count;
    END IF;
END;
$$;
```

Also configure pg_partman with `p_premake = 4` and schedule `run_maintenance()` to run every hour, not once a day. Remember: once rows sit in the default partition, creating the matching named partition fails until you move those rows out — so alert early.

---

### Pitfall 2: Functions on the Partition Key (or the Wrong Column) Disable Pruning

**The problem:** Pruning only works on the partition key itself, used directly. Applying a function to it — or filtering on another column such as `created_at` when the table is partitioned by `transaction_date` — means the planner cannot rule partitions out. The result is a scan across all partitions.

**Failing example:**

```sql
-- BAD: function applied to the partition key — pruning disabled
EXPLAIN SELECT * FROM transactions
WHERE EXTRACT(MONTH FROM transaction_date) = 11
  AND EXTRACT(YEAR  FROM transaction_date) = 2024;

-- Result: Append (all 36 partitions scanned)

-- ALSO BAD: created_at is not the partition key
EXPLAIN SELECT * FROM transactions
WHERE created_at >= '2024-11-15' AND created_at < '2024-11-16';
```

**Correct approach:**

```sql
-- GOOD: a range predicate directly on the partition column
EXPLAIN SELECT * FROM transactions
WHERE transaction_date >= '2024-11-01'
  AND transaction_date  < '2024-12-01';

-- Result: only transactions_2024_11 is scanned
```

This applies to all function calls: `EXTRACT(YEAR FROM ...)`, `TO_CHAR(...)`, `CAST(... AS DATE)`. Always use direct range predicates on the partition key. If an ORM or report tool generates function-wrapped filters, fix the query generation — and if users mostly search by another timestamp, add the partition-key range to those queries too (for example `transaction_date` between the day before and the day after).

---

### Pitfall 3: Global Unique Constraints Are Not Possible Across Partitions

**The problem:** PostgreSQL cannot create a unique index across all partitions of a partitioned table unless the unique index includes the partition key. This breaks the common pattern of enforcing uniqueness on a business key like `reference` or `idempotency_key`.

**Failing example:**

```sql
-- FAILS: reference is not part of the partition key (transaction_date)
CREATE UNIQUE INDEX uq_transactions_reference
    ON transactions (reference);

-- ERROR: insufficient columns in UNIQUE constraint definition
-- DETAIL: UNIQUE constraint on table "transactions" lacks column "transaction_date"
-- which is part of the partition key.
```

**Correct approaches:**

```sql
-- Option 1: Include partition key in unique constraint
-- This allows the same reference to appear in different months (acceptable for
-- some payment references that are scoped to a time period)
CREATE UNIQUE INDEX uq_transactions_reference_date
    ON transactions (reference, transaction_date);

-- Option 2: Enforce global uniqueness in a separate lookup table
CREATE TABLE transaction_idempotency (
    idempotency_key VARCHAR(100) PRIMARY KEY,
    transaction_id  BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Application inserts here first (single non-partitioned table),
-- then inserts into the partitioned transactions table.
-- This separates uniqueness enforcement from bulk storage.
```

Application-level approach using the lookup table — claim the key **first**, so two concurrent duplicates cannot both get through:

```java
@Transactional
public PaymentResult submitPayment(PaymentRequest request) {
    long transactionId = transactionRepository.nextId();   // from the sequence

    // 1) Claim the idempotency key FIRST (non-partitioned table, so the
    //    global UNIQUE constraint works):
    //    INSERT INTO transaction_idempotency (idempotency_key, transaction_id)
    //    VALUES (?, ?) ON CONFLICT (idempotency_key) DO NOTHING
    //    A concurrent duplicate waits on the unique index until we commit,
    //    then inserts nothing.
    boolean claimed = idempotencyRepository.insertIfAbsent(
        request.idempotencyKey(), transactionId);

    if (!claimed) {
        // Duplicate: return the ORIGINAL result (and, ideally, check that the
        // request body matches the original -- same key + different payload
        // is a client error)
        return PaymentResult.duplicate(
            idempotencyRepository.findTransactionId(request.idempotencyKey()));
    }

    // 2) Insert into the partitioned table -- same transaction, so if this
    //    fails, the claimed key is rolled back too
    transactionRepository.insert(Transaction.from(request, transactionId));

    return PaymentResult.created(transactionId);
}
```

---

## 11. Operational Checklist

- [ ] Parent table created with `PARTITION BY` clause; no data stored directly in parent
- [ ] Primary key includes the partition key column(s)
- [ ] Default partition exists as a safety net for out-of-range rows
- [ ] Default partition is monitored for unexpected growth (alert at >1000 rows)
- [ ] pg_partman configured with `p_premake >= 4` to create future partitions in advance
- [ ] `run_maintenance()` scheduled hourly (not daily) to avoid boundary gaps
- [ ] All query templates use direct range predicates on partition columns (no functions)
- [ ] `EXPLAIN` output verified to show only the expected partitions (or `Subplans Removed: N` for run-time pruning) for time-range queries
- [ ] Partition detach uses `CONCURRENTLY` (PostgreSQL 14+, no default partition) or a short `lock_timeout` to avoid blocking
- [ ] Retention policy documented and automated (retention column in `part_config`)
- [ ] Foreign keys include partition key
- [ ] Global uniqueness requirements handled via separate non-partitioned lookup table
- [ ] `max_parallel_workers_per_gather` tuned for cross-partition aggregate queries
- [ ] Monthly partition size verified to stay under 50 million rows (re-evaluate interval if larger)

---

<!-- KNOWLEDGE-CHECK {"questions": [{"text": "A table is range-partitioned by transaction_date. You run EXPLAIN on a query that should hit one month and see all 36 partitions in the plan. What is the most likely cause?", "options": ["The table has no indexes", "The partition key is wrapped in a function in the WHERE clause (e.g. EXTRACT(MONTH FROM transaction_date) = 11), or the query filters on another column such as created_at", "The query is a cross-partition aggregate", "PostgreSQL version is older than 10"], "correct": 1, "explanation": "Partition pruning requires the query predicate to use the partition key column directly, in a form the planner can compare with the partition bounds. Applying a function such as EXTRACT(), TO_CHAR() or a cast to the partition key — or filtering only on a different column — means the planner cannot tell which partitions can match, so it must scan them all. Always use direct range predicates: WHERE transaction_date >= '2024-11-01' AND transaction_date < '2024-12-01'."}, {"text": "Why must the primary key of a partitioned table include the partition key column?", "options": ["PostgreSQL requires it because unique indexes cannot span partition boundaries", "It improves partition pruning performance", "It is required only for hash-partitioned tables", "It is a recommendation, not a hard requirement"], "correct": 0, "explanation": "PostgreSQL enforces that any unique index (including the primary key) on a partitioned table must include the partition key. This is because PostgreSQL implements uniqueness per-partition: without the partition key, a row in partition A and a row in partition B could have identical values for the unique column, and PostgreSQL cannot prevent it without a global index (which does not exist for partitioned tables). If you need global uniqueness on a non-partition-key column, use a separate non-partitioned lookup table."}, {"text": "What is the operationally safe way to remove old data from a range-partitioned table in PostgreSQL?", "options": ["DELETE FROM transactions WHERE transaction_date < '2021-01-01'", "TRUNCATE TABLE transactions WHERE transaction_date < '2021-01-01'", "ALTER TABLE transactions DETACH PARTITION transactions_2020_12 CONCURRENTLY, then DROP TABLE transactions_2020_12", "UPDATE transactions SET deleted = true WHERE transaction_date < '2021-01-01'"], "correct": 2, "explanation": "DETACH PARTITION followed by DROP TABLE is the correct approach. DETACH is a metadata operation; with CONCURRENTLY (PostgreSQL 14+, and only when the table has no default partition) it does not block concurrent reads or writes on the parent — otherwise it needs a brief ACCESS EXCLUSIVE lock. DROP TABLE on the detached child is near-instant and generates minimal WAL. In contrast, DELETE touches every old row, generates massive WAL, creates dead-tuple bloat requiring VACUUM, and competes with production load. TRUNCATE ... WHERE is not valid SQL."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"PostgreSQL Partitioning Implementation","difficulty":"advanced","estimatedMinutes":90,"tasks":[{"id":"task-1","description":"Create a range-partitioned transactions table partitioned by transaction_date (DATE type). Create 12 monthly partitions for 2024, a default partition, and a composite index on (account_id, transaction_date). Run EXPLAIN ANALYZE on a query filtering for a single month and confirm that the output shows all other partitions removed. Document the EXPLAIN output in a comment in your SQL file."},{"id":"task-2","description":"Create a hash-partitioned account_balances table partitioned by account_id with 8 partitions. Insert 100,000 rows with randomly distributed account IDs (1 to 1,000,000). Run the distribution verification query and confirm that no partition has more than 15,000 more rows than any other partition. Record the row counts in a SQL comment."},{"id":"task-3","description":"Demonstrate the global uniqueness pitfall: attempt to create a unique index on transactions(reference) without including transaction_date and document the exact PostgreSQL error message. Then implement the two-table solution (transaction_idempotency lookup table + partitioned transactions table). Write a Java @Transactional method that inserts to both tables and handles DataIntegrityViolationException as a duplicate payment signal."},{"id":"task-4","description":"Install pg_partman (or simulate its logic with a PL/pgSQL function) and configure automated monthly partition creation for the transactions table with 4 months premake and 7-year retention. Write a SQL query that counts rows in the default partition and raises a WARNING if the count exceeds 500. Schedule it using pg_cron or document the cron expression that should be used to run run_maintenance() hourly."}]} -->
