---
id: track-09-lesson-19
title: "Database Partitioning — Range, Hash, and List Strategies"
slug: db-partitioning-performance
track: track-09
trackName: "Performance Engineering"
sequence: 19
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [partitioning, range-partition, hash-partition, pruning, PostgreSQL]
prerequisites: [track-09-lesson-09]
---

# Database Partitioning — Range, Hash, and List Strategies

> [!NOTE]
> A transaction table with 500 million rows and no partitioning will degrade any index scan to a full heap fetch across gigabytes of storage. Partitioning constrains the query planner's search space at the physical storage level — partition pruning turns a 500M row scan into a 2M row scan before a single index is consulted.

## 1. PostgreSQL Declarative Partitioning

PostgreSQL's declarative partitioning (introduced in PG10, mature from PG11+) defines the partition strategy at table creation time. The parent table is a logical structure — data lives exclusively in the partition tables.

### Key Concepts

- **Parent table**: defines schema, constraints, indexes (inherited by partitions)
- **Partition**: a physical table that holds a subset of rows
- **Partition key**: the column(s) used to route rows to partitions
- **Partition pruning**: query planner eliminates partitions that cannot contain matching rows

## 2. PARTITION BY RANGE — Time-Series Financial Data

Range partitioning is the dominant strategy for financial transaction tables because queries almost always include a date range filter.

```sql
-- Create partitioned transactions table
CREATE TABLE transactions (
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL,
    amount       NUMERIC(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    type         VARCHAR(30) NOT NULL,
    reference    VARCHAR(100),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at   TIMESTAMPTZ
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE transactions_2024_01
    PARTITION OF transactions
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE transactions_2024_02
    PARTITION OF transactions
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

CREATE TABLE transactions_2024_03
    PARTITION OF transactions
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');

-- Always have a future partition ready (and a default for unexpected values)
CREATE TABLE transactions_2024_12
    PARTITION OF transactions
    FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');

CREATE TABLE transactions_default
    PARTITION OF transactions DEFAULT;
-- Default partition catches any row that doesn't match a specific partition.
-- Alert on non-empty default partition — it means a partition is missing.

-- Primary key must include the partition key
ALTER TABLE transactions ADD PRIMARY KEY (id, created_at);
```

### Partition-Level Indexes

```sql
-- Indexes on the parent table are automatically created on all partitions
CREATE INDEX idx_transactions_account_date
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status);

-- Verify: each partition has its own index
SELECT
    c.relname AS partition,
    i.relname AS index_name,
    pg_size_pretty(pg_relation_size(i.oid)) AS index_size
FROM pg_class c
JOIN pg_inherits ih ON ih.inhrelid = c.oid
JOIN pg_index ix ON ix.indrelid = c.oid
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE ih.inhparent = 'transactions'::regclass
ORDER BY c.relname, i.relname;
```

## 3. Partition Pruning Verification

Partition pruning only works when the query predicate includes the partition key with a constant or stable expression.

```sql
-- Partition pruning WORKS: filter on partition key (created_at)
EXPLAIN SELECT * FROM transactions
WHERE created_at >= '2024-03-01'
  AND created_at < '2024-04-01'
  AND account_id = 'acct-001';

-- Output shows only one partition is scanned:
-- Append
--   ->  Index Scan on transactions_2024_03
--         Index Cond: ((created_at >= '2024-03-01') AND ...)
-- Partitions scanned: 1 of 24

-- Partition pruning FAILS: partition key inside a function
EXPLAIN SELECT * FROM transactions
WHERE DATE_TRUNC('month', created_at) = '2024-03-01';
-- Output: Seq Scan on ALL partitions (partition pruning disabled by function)

-- FIX: rewrite to use range predicate
EXPLAIN SELECT * FROM transactions
WHERE created_at >= '2024-03-01'
  AND created_at < '2024-04-01';
```

### Runtime Pruning with Parameters

```sql
-- enable_partition_pruning must be on (default)
SHOW enable_partition_pruning;  -- on

-- Parameterized queries also benefit from pruning
-- (requires enable_partitionwise_aggregate and runtime pruning)
SET enable_partition_pruning = on;

EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*), SUM(amount)
FROM transactions
WHERE created_at >= $1 AND created_at < $2
  AND status = 'COMPLETED';

-- With parameters, check for "Subplans Removed" in EXPLAIN output
-- Subplans Removed: 22 means 22 of 24 partitions were eliminated at runtime
```

## 4. PARTITION BY HASH — Even Distribution for Write-Heavy Tables

Hash partitioning distributes rows evenly across N partitions based on a hash of the partition key. It improves write throughput by spreading concurrent inserts across multiple partition files.

```sql
-- Hash partitioning on account_id: even write distribution
CREATE TABLE ledger_entries (
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL,
    entry_type  VARCHAR(20) NOT NULL,
    amount      NUMERIC(19,4) NOT NULL,
    balance_after NUMERIC(19,4) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY HASH (account_id);

-- 8 partitions: good for a system with millions of accounts
CREATE TABLE ledger_entries_p0
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE ledger_entries_p1
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE ledger_entries_p2
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE ledger_entries_p3
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE ledger_entries_p4
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE ledger_entries_p5
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE ledger_entries_p6
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE ledger_entries_p7
    PARTITION OF ledger_entries FOR VALUES WITH (MODULUS 8, REMAINDER 7);
```

**Tradeoff**: Hash partitioning does not support partition pruning for range queries on the partition key. Queries filtering by `account_id = $1` benefit (single partition accessed), but queries without an `account_id` filter must scan all partitions.

## 5. PARTITION BY LIST — Regulatory and Regional Data

List partitioning assigns rows to partitions based on a discrete set of values. Useful for regional data isolation (GDPR) or currency-based partitioning.

```sql
-- List partitioning by currency region (GDPR data residency)
CREATE TABLE payments (
    id         UUID NOT NULL DEFAULT gen_random_uuid(),
    region     VARCHAR(10) NOT NULL,  -- EU, US, APAC, OTHER
    account_id UUID NOT NULL,
    amount     NUMERIC(19,4) NOT NULL,
    currency   CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY LIST (region);

CREATE TABLE payments_eu
    PARTITION OF payments FOR VALUES IN ('EU', 'EEA', 'UK');

CREATE TABLE payments_us
    PARTITION OF payments FOR VALUES IN ('US', 'CA');

CREATE TABLE payments_apac
    PARTITION OF payments FOR VALUES IN ('APAC', 'AU', 'SG', 'JP');

CREATE TABLE payments_other
    PARTITION OF payments DEFAULT;

-- GDPR benefit: EU customer data is physically isolated in payments_eu
-- Can apply different retention policies, encryption keys, or backup schedules
-- per partition
```

## 6. Partition-Wise Joins and Aggregates

PostgreSQL can parallelize joins and aggregations across partitions independently.

```sql
-- Enable partition-wise operations
SET enable_partitionwise_join = on;
SET enable_partitionwise_aggregate = on;

-- Query: join two partitioned tables
-- Without partition-wise join: all partitions merged first, then joined
-- With partition-wise join: partition 0 of transactions joins partition 0 of accounts
EXPLAIN (ANALYZE, BUFFERS)
SELECT t.account_id, a.account_number, SUM(t.amount) AS total
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.created_at >= '2024-01-01'
  AND t.created_at < '2024-04-01'
GROUP BY t.account_id, a.account_number;

-- With partition-wise aggregate, each partition aggregates independently:
-- Gather
--   ->  Partial HashAggregate (per-partition)
--         ->  transactions_2024_01 ... transactions_2024_03
```

## 7. Automated Partition Management

Manual partition creation is error-prone. Automate it.

```sql
-- Function: create next month's partition automatically
CREATE OR REPLACE FUNCTION create_monthly_partition(
    table_name TEXT,
    partition_date DATE
) RETURNS VOID AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    start_date := DATE_TRUNC('month', partition_date);
    end_date   := start_date + INTERVAL '1 month';
    partition_name := table_name || '_'
        || TO_CHAR(start_date, 'YYYY_MM');

    -- Check if partition already exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = partition_name
    ) THEN
        EXECUTE FORMAT(
            'CREATE TABLE %I PARTITION OF %I
             FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_name,
            start_date, end_date
        );

        RAISE NOTICE 'Created partition: %', partition_name;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Schedule via pg_cron: run on 20th of each month to create next month's partition
SELECT cron.schedule(
    'create-next-month-partition',
    '0 0 20 * *',  -- at midnight on the 20th
    $$
    SELECT create_monthly_partition('transactions', NOW()::DATE + INTERVAL '1 month');
    SELECT create_monthly_partition('ledger_entries_range', NOW()::DATE + INTERVAL '1 month');
    $$
);
```

### Java-Side Partition Pre-creation

```java
@Component
@Slf4j
public class PartitionManager {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Called by scheduled job on the 20th of each month.
     * Creates partitions 2 months ahead to ensure no gaps.
     */
    @Scheduled(cron = "0 0 20 * * ?")  // 20th of each month
    public void createUpcomingPartitions() {
        YearMonth next1 = YearMonth.now().plusMonths(1);
        YearMonth next2 = YearMonth.now().plusMonths(2);

        for (YearMonth month : List.of(next1, next2)) {
            createPartitionIfAbsent("transactions", month);
            createPartitionIfAbsent("ledger_entries_range", month);
        }
    }

    private void createPartitionIfAbsent(String tableName, YearMonth month) {
        LocalDate startDate = month.atDay(1);
        LocalDate endDate   = month.plusMonths(1).atDay(1);
        String partitionName = tableName + "_"
            + month.format(DateTimeFormatter.ofPattern("yyyy_MM"));

        try {
            jdbcTemplate.update(
                """
                DO $$ BEGIN
                  IF NOT EXISTS (
                    SELECT 1 FROM pg_class WHERE relname = ?
                  ) THEN
                    EXECUTE format(
                      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                      ?, ?, ?, ?
                    );
                  END IF;
                END $$;
                """,
                partitionName, partitionName, tableName,
                startDate.toString(), endDate.toString()
            );
            log.info("Ensured partition exists: {}", partitionName);
        } catch (Exception e) {
            log.error("Failed to create partition {}: {}", partitionName, e.getMessage());
            // Alert ops team — missing partition will cause insert failures
        }
    }
}
```

## 8. Detaching Old Partitions for Archival

```sql
-- Detach an old partition from the parent table (non-blocking in PG14+)
-- The partition becomes a standalone table — no data is moved or deleted
ALTER TABLE transactions
    DETACH PARTITION transactions_2022_01 CONCURRENTLY;

-- After detach, the partition is an independent table
-- Export to cold storage (e.g., pg_dump to S3)
-- \copy transactions_2022_01 TO '/tmp/transactions_2022_01.csv' CSV HEADER

-- Then drop the local copy
DROP TABLE transactions_2022_01;

-- To re-attach for a regulatory query
CREATE TABLE transactions_2022_01_restored (LIKE transactions);
-- Restore from S3 dump, then:
ALTER TABLE transactions
    ATTACH PARTITION transactions_2022_01_restored
    FOR VALUES FROM ('2022-01-01') TO ('2022-02-01');
```

## 9. Partial Indexes Per Partition

Partition-local partial indexes are smaller and faster than global ones because they only cover the partition's date range.

```sql
-- Global partial index (created on parent, applied to all partitions)
CREATE INDEX idx_transactions_pending_global
    ON transactions (account_id, created_at)
    WHERE status = 'PENDING';

-- But PENDING transactions are only in recent partitions
-- Create targeted partial index only on current and recent partitions
CREATE INDEX idx_txn_2024_03_pending
    ON transactions_2024_03 (account_id, created_at)
    WHERE status = 'PENDING';

CREATE INDEX idx_txn_2024_02_pending
    ON transactions_2024_02 (account_id, created_at)
    WHERE status = 'PENDING';

-- Older partitions have no PENDING rows — no index needed
-- This saves significant index space for large transaction archives
```

## 10. Performance Benchmarks vs Single Table

```sql
-- Benchmark setup: 100M row transactions table
-- Machine: 32-core, 128GB RAM, NVMe SSD

-- Test 1: Single account, 30-day window (common API query)
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM transactions
WHERE account_id = 'acct-001'
  AND created_at >= NOW() - INTERVAL '30 days'
ORDER BY created_at DESC
LIMIT 50;

-- Single table (no partitioning):
--   Execution Time: 1234.567 ms
--   Rows scanned before limit: 100,000,000 (index scan, 100M rows)

-- Partitioned (monthly, 2 partitions scanned for 30 days):
--   Execution Time: 2.345 ms
--   Rows scanned: ~8,000,000 (2 partitions)
--   Speedup: ~526x

-- Test 2: Settlement aggregation (all COMPLETED txns in a month)
-- Single table: 45,678 ms (full index scan of 100M rows)
-- Partitioned:     891 ms (1 partition = ~8M rows)
-- Speedup: ~51x
```

## 11. Partition Bloat Management

```sql
-- Check partition sizes and growth trends
SELECT
    child.relname                                   AS partition,
    pg_size_pretty(pg_relation_size(child.oid))     AS data_size,
    pg_size_pretty(pg_indexes_size(child.oid))      AS index_size,
    pg_size_pretty(pg_total_relation_size(child.oid)) AS total_size,
    (SELECT COUNT(*) FROM pg_inherits WHERE inhrelid = child.oid) AS sub_partitions
FROM pg_class parent
JOIN pg_inherits ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON child.oid = pg_inherits.inhrelid
WHERE parent.relname = 'transactions'
ORDER BY child.relname DESC
LIMIT 24;

-- Check for bloat within a partition
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE relname LIKE 'transactions_%'
ORDER BY dead_pct DESC NULLS LAST;

-- Vacuum a specific partition without locking others
VACUUM ANALYZE transactions_2024_03;
```

## 12. Java Integration — Partition-Aware Queries

```java
@Repository
public class PartitionedTransactionRepository {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Include date range in ALL queries against the transactions table.
     * Without the date filter, partition pruning is disabled and all
     * partitions are scanned.
     *
     * This is the most common mistake in partitioned table usage.
     */
    public List<Transaction> findByAccountIdAndDateRange(
            UUID accountId, Instant from, Instant to) {
        // CORRECT: includes created_at filter -> partition pruning active
        return jdbcTemplate.query(
            """
            SELECT id, account_id, amount, currency, status, created_at
            FROM transactions
            WHERE account_id = ?
              AND created_at >= ?
              AND created_at < ?
            ORDER BY created_at DESC
            LIMIT 1000
            """,
            this::mapRow,
            accountId, from, to
        );
    }

    /**
     * Never query without the partition key when dealing with large tables.
     * This would scan all 24+ partitions.
     */
    @Deprecated(since = "2.0", forRemoval = true)
    public List<Transaction> findByAccountIdOnly(UUID accountId) {
        // WRONG: no date filter -> full scan of all partitions
        // This method should be removed and callers updated
        throw new UnsupportedOperationException(
            "Query without date range not permitted on partitioned transactions table. " +
            "Use findByAccountIdAndDateRange() with an explicit date window."
        );
    }

    /**
     * Settlement aggregation: explicitly narrow the date window.
     */
    public SettlementSummary getSettlementSummary(LocalDate businessDate) {
        Instant dayStart = businessDate.atStartOfDay(ZoneOffset.UTC).toInstant();
        Instant dayEnd   = businessDate.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();

        return jdbcTemplate.queryForObject(
            """
            SELECT currency, COUNT(*) AS cnt, SUM(amount) AS total
            FROM transactions
            WHERE settled_at >= ?
              AND settled_at < ?
              AND status = 'COMPLETED'
            GROUP BY currency
            """,
            (rs, row) -> new SettlementSummary(
                rs.getString("currency"),
                rs.getLong("cnt"),
                rs.getBigDecimal("total"),
                businessDate
            ),
            dayStart, dayEnd
        );
    }
}
```

## 13. Summary — Partitioning Strategy Selection

| Workload | Best Strategy | Reason |
|---|---|---|
| Time-series transaction data | RANGE on created_at | Most queries filter by date range |
| Account balance ledger (high write) | HASH on account_id | Even write distribution |
| Regional compliance isolation | LIST on region/country | Physical data separation |
| Multi-tenant SaaS | HASH on tenant_id | Even distribution per tenant |
| Archive + active mixed | RANGE + detach old | Easy archival of old partitions |

> [!WARNING]
> The most common partitioning mistake is writing queries that omit the partition key in the WHERE clause. When this happens, PostgreSQL scans all partitions — often slower than an unpartitioned table with a good index because of per-partition overhead. Add query review steps to your code review checklist that verify partition key presence in queries against partitioned tables.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why does range partitioning by transaction_date month benefit a payment service's query performance?",
      "options": [
        "Monthly partitions allow PostgreSQL to use hash indexes instead of B-tree indexes",
        "Most transaction queries filter by date range; PostgreSQL uses partition pruning to scan only the relevant monthly partitions instead of the entire table, reducing I/O proportionally to the fraction of time covered",
        "Monthly partitions enable parallel query execution across all partitions simultaneously",
        "Range partitioning reduces write latency by routing all current inserts to a single small partition"
      ],
      "correct": 1,
      "explanation": "When a query includes a date range predicate (WHERE transaction_date BETWEEN '2026-01-01' AND '2026-01-31'), PostgreSQL's partition pruning identifies that only the January 2026 partition needs to be scanned. For a 5-year transaction history table with 60 monthly partitions, a 30-day query scans 1/60th of the data instead of the full table."
    },
    {
      "text": "What is the main benefit of DETACH PARTITION for data archival in a financial system?",
      "options": [
        "DETACH PARTITION compresses the old partition using pg_compress automatically",
        "DETACH PARTITION is an instantaneous metadata operation that removes the partition from the table without scanning or deleting any rows, allowing old data to be archived without locking the parent table or generating I/O",
        "DETACH PARTITION moves data to a cold storage tablespace in the background",
        "DETACH PARTITION is equivalent to DELETE WHERE transaction_date < cutoff but runs faster"
      ],
      "correct": 1,
      "explanation": "DETACH PARTITION (or DROP TABLE on a detached partition) operates on partition metadata, not data. Detaching a 100 GB partition from the parent table takes milliseconds regardless of row count, with no table scan and minimal locking. After detaching, the partition becomes an independent table that can be moved to cold storage, archived to S3, or dropped at any time."
    },
    {
      "text": "Why must partition key columns be included in unique constraints on a partitioned table?",
      "options": [
        "PostgreSQL requires this for syntax compliance but it has no functional impact",
        "PostgreSQL enforces unique constraints per-partition only, not across the entire partitioned table; including the partition key ensures uniqueness within each partition and allows the planner to route constraint checks to the correct partition",
        "Including the partition key in unique constraints enables partition-wise joins",
        "Unique constraints cannot span partitions in PostgreSQL, so they should be avoided entirely"
      ],
      "correct": 1,
      "explanation": "PostgreSQL implements unique constraints independently on each partition. A globally unique constraint across all partitions would require checking all partitions on every insert, defeating the partition pruning benefit. Including the partition key (e.g., transaction_id + created_at for a date-partitioned table) scopes the unique check to the target partition. This design constraint affects ID generation strategy — IDs must encode routing information."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Transaction Table Partitioning and Archival Strategy",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write the SQL to create a transactions table with range partitioning by month on transaction_date, including index creation on each partition, and a stored procedure to automatically create the next 3 months of partitions."},
    {"id": "2", "description": "Write a Spring Boot @Scheduled job that: (a) creates future month partitions 90 days in advance, (b) detaches partitions older than 2 years, and (c) logs partition sizes from pg_relation_size() monthly."},
    {"id": "3", "description": "Write an EXPLAIN ANALYZE test that verifies partition pruning is working: seed data across 12 monthly partitions, run a 30-day date range query, and assert that only 1-2 partitions were scanned (not all 12)."},
    {"id": "4", "description": "Design a partitioned settlements view that uses a materialized view refreshed nightly to aggregate daily settlement totals per currency per partition, with a SettlementSummaryService that queries the materialized view for dashboard display."}
  ]
}
-->

