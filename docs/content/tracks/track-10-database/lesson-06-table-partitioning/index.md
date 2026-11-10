---
id: track-10-lesson-06
title: "Table Partitioning — Range and Hash for Financial Data"
slug: table-partitioning
track: track-10
trackName: "Database & Data Architecture"
sequence: 6
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [partitioning, range-partition, hash-partition, pruning, archival]
prerequisites: []
---

# Table Partitioning — Range and Hash for Financial Data

> [!NOTE]
> A transaction table with 5 billion rows and no partitioning is a ticking operational time bomb. VACUUM struggles, index bloat accumulates, and queries that should be fast become slow. Partitioning is not an optimisation — for large financial datasets it is a maintenance necessity. This lesson teaches you to partition correctly from the start and retrofit partitioning safely.

---

## 1. Why Partition Financial Data

Three primary motivations for partitioning in fintech:

**Query performance via partition pruning:** A query for January 2024 transactions touches only the January partition, not 10 years of data.

**Maintenance efficiency:** VACUUM, ANALYZE, and REINDEX run per-partition. A 50GB monthly partition is vastly faster to maintain than a monolithic 600GB annual table.

**Data lifecycle management:** Archiving or dropping old data is `DETACH PARTITION` + `DROP TABLE` — instant operations — rather than a DELETE that generates tombstones and bloat.

---

## 2. Declarative Partitioning Syntax

PostgreSQL 10+ supports declarative (native) partitioning. The parent table defines the structure; child partitions hold the data.

```sql
-- Step 1: Create the partitioned parent table
CREATE TABLE transactions (
    transaction_id  VARCHAR(50)      NOT NULL,
    account_id      VARCHAR(20)      NOT NULL,
    amount          NUMERIC(19, 4)   NOT NULL,
    currency        CHAR(3)          NOT NULL,
    status          VARCHAR(20)      NOT NULL,
    transaction_date DATE            NOT NULL,
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    reference_id    VARCHAR(100),
    metadata        JSONB
) PARTITION BY RANGE (transaction_date);

-- Step 2: Create child partitions
CREATE TABLE transactions_2024_01
    PARTITION OF transactions
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE transactions_2024_02
    PARTITION OF transactions
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- ... and so on for each month

-- Step 3: Create indexes on the PARENT — they propagate to all partitions
CREATE INDEX idx_txn_account_date
ON transactions (account_id, transaction_date DESC)
INCLUDE (amount, currency, status);

CREATE INDEX idx_txn_status
ON transactions (status, created_at)
WHERE status IN ('pending', 'processing');
```

---

## 3. Range Partitioning for Transaction History

### 3.1 Monthly Partition Strategy

Monthly partitioning is the most common for financial transaction tables. It aligns naturally with statement generation, regulatory reporting, and archival cycles.

```sql
-- Create a year's worth of monthly partitions in one go
DO $$
DECLARE
    start_date DATE := '2024-01-01';
    partition_date DATE;
    partition_name TEXT;
    end_date DATE;
BEGIN
    FOR i IN 0..11 LOOP
        partition_date := start_date + (i || ' months')::INTERVAL;
        end_date := partition_date + '1 month'::INTERVAL;
        partition_name := 'transactions_' || TO_CHAR(partition_date, 'YYYY_MM');

        EXECUTE FORMAT(
            'CREATE TABLE IF NOT EXISTS %I
             PARTITION OF transactions
             FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            partition_date,
            end_date
        );

        RAISE NOTICE 'Created partition: %', partition_name;
    END LOOP;
END $$;
```

### 3.2 Automatic Future Partition Creation

Use pg_partman for automatic partition management:

```sql
-- Install pg_partman extension
CREATE EXTENSION pg_partman;

-- Configure automatic monthly partitioning for transactions
SELECT partman.create_parent(
    p_parent_table => 'public.transactions',
    p_control => 'transaction_date',
    p_type => 'range',
    p_interval => 'monthly',
    p_premake => 3,  -- Pre-create 3 future partitions
    p_start_partition => '2024-01-01'
);

-- pg_partman will automatically create new partitions before they're needed
-- Schedule maintenance via pg_cron:
SELECT cron.schedule('0 1 * * *',
    $$SELECT partman.run_maintenance(p_analyze := FALSE)$$);
```

### 3.3 Yearly Partitioning for Very Long-Lived Data

For compliance data that must be retained for 7+ years:

```sql
-- Top-level yearly partitions
CREATE TABLE audit_records (
    record_id    BIGSERIAL,
    entity_type  VARCHAR(50)   NOT NULL,
    entity_id    VARCHAR(50)   NOT NULL,
    action       VARCHAR(20)   NOT NULL,
    actor_id     VARCHAR(50)   NOT NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    payload      JSONB
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_records_2024
    PARTITION OF audit_records
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')
    PARTITION BY RANGE (created_at);  -- Sub-partitioned by month!

CREATE TABLE audit_records_2024_01
    PARTITION OF audit_records_2024
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
```

---

## 4. Hash Partitioning for Account Data

Range partitioning works well for time-series data. For account data accessed by account_id, hash partitioning distributes load evenly across a fixed number of partitions.

### 4.1 Account Balance Table

```sql
-- Hash partition accounts by account_id into 16 buckets
-- Even distribution regardless of account_id format
CREATE TABLE accounts (
    account_id     VARCHAR(20)      NOT NULL,
    customer_id    VARCHAR(20)      NOT NULL,
    balance        NUMERIC(19, 4)   NOT NULL DEFAULT 0,
    currency       CHAR(3)          NOT NULL,
    account_type   VARCHAR(20)      NOT NULL,
    status         VARCHAR(20)      NOT NULL DEFAULT 'active',
    created_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id)
) PARTITION BY HASH (account_id);

-- Create 16 hash partitions
DO $$
BEGIN
    FOR i IN 0..15 LOOP
        EXECUTE FORMAT(
            'CREATE TABLE accounts_p%s
             PARTITION OF accounts
             FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
            i, i
        );
    END LOOP;
END $$;
```

### 4.2 Choosing the Number of Partitions

```
Guidelines for hash partition count:
- Should be a power of 2 (easy future splitting)
- Target 10–50 GB per partition (sweet spot for VACUUM and index maintenance)
- More partitions = more parallel VACUUM workers can help
- Too many partitions = planning overhead (PostgreSQL has to check constraints for each)

Typical sizing:
- < 100M rows: 4–8 partitions
- 100M–1B rows: 16–32 partitions
- 1B+ rows: 64+ partitions (consider sharding instead)
```

```sql
-- Check partition sizes after loading data
SELECT
    child.relname AS partition_name,
    pg_size_pretty(pg_total_relation_size(child.oid)) AS total_size,
    pg_size_pretty(pg_relation_size(child.oid)) AS data_size
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON pg_inherits.inhrelid = child.oid
WHERE parent.relname = 'accounts'
ORDER BY child.relname;
```

---

## 5. List Partitioning by Region or Currency

For financial systems operating across multiple regions, list partitioning enables co-locating data by jurisdiction — useful for data residency requirements.

```sql
-- Partition customer data by region for GDPR compliance
CREATE TABLE customers (
    customer_id  VARCHAR(20)   NOT NULL,
    email        VARCHAR(255)  NOT NULL,
    region       VARCHAR(10)   NOT NULL,  -- 'EU', 'US', 'APAC'
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, region)
) PARTITION BY LIST (region);

CREATE TABLE customers_eu
    PARTITION OF customers
    FOR VALUES IN ('EU', 'UK');  -- EU and UK in same region for now

CREATE TABLE customers_us
    PARTITION OF customers
    FOR VALUES IN ('US', 'CA');

CREATE TABLE customers_apac
    PARTITION OF customers
    FOR VALUES IN ('APAC', 'AU', 'SG', 'JP');

-- Default partition for other regions
CREATE TABLE customers_other
    PARTITION OF customers DEFAULT;
```

### 5.1 Currency-Based Partitioning for FX Tables

```sql
-- FX positions partitioned by base currency
CREATE TABLE fx_positions (
    position_id    BIGSERIAL,
    portfolio_id   VARCHAR(20)    NOT NULL,
    base_currency  CHAR(3)        NOT NULL,
    quote_currency CHAR(3)        NOT NULL,
    notional       NUMERIC(19, 4) NOT NULL,
    value_date     DATE           NOT NULL
) PARTITION BY LIST (base_currency);

CREATE TABLE fx_positions_usd PARTITION OF fx_positions
    FOR VALUES IN ('USD');

CREATE TABLE fx_positions_eur PARTITION OF fx_positions
    FOR VALUES IN ('EUR');

CREATE TABLE fx_positions_gbp PARTITION OF fx_positions
    FOR VALUES IN ('GBP');

CREATE TABLE fx_positions_other PARTITION OF fx_positions DEFAULT;
```

---

## 6. Partition Pruning — Verification with EXPLAIN

Partition pruning is the planner's ability to skip irrelevant partitions based on query predicates. It must be verified — wrong data types or implicit casts can silently disable pruning.

### 6.1 Verifying Pruning Works

```sql
-- Check that the query only scans relevant partitions
EXPLAIN (ANALYZE, BUFFERS)
SELECT transaction_id, amount, currency
FROM transactions
WHERE transaction_date >= '2024-01-01'
  AND transaction_date < '2024-02-01';

-- Expected output includes:
-- Partitions selected: 1
-- Partitions pruned: N-1
-- NOT:
-- Seq Scan on transactions_2024_01, transactions_2024_02, ... (all scanned)
```

### 6.2 Common Pruning Pitfalls

```sql
-- WRONG: Implicit cast prevents pruning
-- transaction_date is DATE, but we're passing TIMESTAMPTZ
EXPLAIN SELECT * FROM transactions
WHERE transaction_date >= '2024-01-01 00:00:00+00';
-- PostgreSQL may not prune because of type mismatch

-- RIGHT: Use matching types
EXPLAIN SELECT * FROM transactions
WHERE transaction_date >= '2024-01-01'::DATE
  AND transaction_date < '2024-02-01'::DATE;

-- WRONG: Function on partition key prevents pruning
EXPLAIN SELECT * FROM transactions
WHERE DATE_TRUNC('month', transaction_date) = '2024-01-01';
-- Pruning disabled! Function wrapping the partition key

-- RIGHT: Use range on the key itself
EXPLAIN SELECT * FROM transactions
WHERE transaction_date >= '2024-01-01'
  AND transaction_date < '2024-02-01';
```

### 6.3 Runtime Pruning

For dynamic queries where partition values are only known at runtime:

```sql
-- enable_partition_pruning is on by default in PostgreSQL 11+
SHOW enable_partition_pruning;  -- should be 'on'

-- For prepared statements, runtime pruning applies parameters at execution time
PREPARE txn_lookup AS
    SELECT * FROM transactions
    WHERE transaction_date >= $1 AND transaction_date < $2;

EXECUTE txn_lookup('2024-01-01', '2024-02-01');
-- Runtime pruning evaluates $1 and $2 and prunes at execution
```

---

## 7. Global vs Local Indexes

### 7.1 Partitioned (Global) Indexes

By default, indexes created on the parent table propagate to all child partitions. Each partition has its own independent index — these are called "local indexes." There is no single global B-tree spanning all partitions.

```sql
-- This creates a LOCAL index on each partition
CREATE INDEX idx_txn_account_date
ON transactions (account_id, transaction_date DESC);

-- PostgreSQL creates:
-- idx_txn_account_date_transactions_2024_01
-- idx_txn_account_date_transactions_2024_02
-- ... etc.
```

This means:
- Queries that specify the partition key (transaction_date) benefit from pruning + local index
- Queries that do NOT specify the partition key scan all partitions (expensive!)

### 7.2 Unique Constraints Across Partitions

Unique constraints and primary keys must include the partition key in partitioned tables:

```sql
-- WORKS: partition key included in unique constraint
CREATE TABLE transactions (
    transaction_id  VARCHAR(50)    NOT NULL,
    transaction_date DATE          NOT NULL,
    ...
    PRIMARY KEY (transaction_id, transaction_date)
    -- partition key (transaction_date) included
) PARTITION BY RANGE (transaction_date);

-- FAILS: PostgreSQL cannot enforce global uniqueness without partition key
-- CREATE UNIQUE INDEX ... ON transactions (transaction_id);
-- ERROR: unique constraint on partitioned table must include all partitioning columns
```

**Workaround for global uniqueness:** Use a separate "routing table" or UUID strategy:

```java
// Application-level uniqueness: embed date in transaction_id
// e.g., TXN-20240115-UUID
// The date in the ID ensures it always routes to the correct partition
// AND serves as a natural partition key
public String generateTransactionId(LocalDate date) {
    return String.format("TXN-%s-%s",
        date.format(DateTimeFormatter.BASIC_ISO_DATE),
        UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase());
}
```

---

## 8. Partition Management — Adding, Detaching, and Archiving

### 8.1 Adding Future Partitions

```java
@Component
@Scheduled(cron = "0 0 1 * * *")  // Run daily at midnight
public class PartitionMaintenanceJob {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Ensure partitions exist for the next 3 months.
     * Idempotent — safe to run repeatedly.
     */
    public void ensureFuturePartitions() {
        LocalDate today = LocalDate.now();

        for (int monthsAhead = 1; monthsAhead <= 3; monthsAhead++) {
            LocalDate partitionMonth = today.plusMonths(monthsAhead)
                .withDayOfMonth(1);
            LocalDate nextMonth = partitionMonth.plusMonths(1);
            String partitionName = "transactions_"
                + partitionMonth.format(DateTimeFormatter.ofPattern("yyyy_MM"));

            String sql = """
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_tables
                        WHERE tablename = '%s'
                    ) THEN
                        CREATE TABLE %s
                        PARTITION OF transactions
                        FOR VALUES FROM ('%s') TO ('%s');
                        RAISE NOTICE 'Created partition: %s';
                    END IF;
                END $$;
                """.formatted(
                partitionName, partitionName,
                partitionMonth, nextMonth,
                partitionName);

            jdbcTemplate.execute(sql);
            log.info("Ensured partition exists: {}", partitionName);
        }
    }
}
```

### 8.2 Detaching Old Partitions for Archival

```sql
-- Step 1: Detach the old partition from the parent
-- This is INSTANT — no data movement, just metadata change
-- After detach: queries against 'transactions' no longer touch this partition
ALTER TABLE transactions
DETACH PARTITION transactions_2022_01;

-- transactions_2022_01 now exists as a standalone table
-- Queries can still run against it directly for archival reads

-- Step 2: Optionally move to a tablespace on cheaper storage
ALTER TABLE transactions_2022_01
SET TABLESPACE archive_tablespace;

-- Step 3: Create a compressed dump and store externally
-- (application-level archival process)

-- Step 4: When data is no longer needed (after retention period)
DROP TABLE transactions_2022_01;  -- Instant, no bloat
```

### 8.3 Online Detach (PostgreSQL 14+)

```sql
-- PostgreSQL 14+ supports DETACH CONCURRENTLY
-- Uses a weaker lock — does not block queries against other partitions
ALTER TABLE transactions
DETACH PARTITION transactions_2022_01 CONCURRENTLY;

-- Takes a ShareUpdateExclusiveLock instead of ACCESS EXCLUSIVE
-- Safe to run during business hours in production
```

### 8.4 Archival Service in Java

```java
@Service
public class PartitionArchivalService {

    @Transactional(propagation = Propagation.NEVER)
    public ArchivalResult archiveOldPartition(YearMonth month) {
        String partitionName = "transactions_"
            + month.format(DateTimeFormatter.ofPattern("yyyy_MM"));

        // 1. Verify partition exists and is old enough
        LocalDate partitionStart = month.atDay(1);
        if (!partitionStart.isBefore(LocalDate.now().minusMonths(13))) {
            throw new PartitionTooRecentException(
                "Cannot archive partitions less than 13 months old");
        }

        // 2. Count rows for audit
        long rowCount = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM " + partitionName, Long.class);

        // 3. Export to cold storage (S3, Azure Blob, etc.)
        archivalStorageService.exportPartition(partitionName);

        // 4. Detach from parent
        jdbcTemplate.execute(
            "ALTER TABLE transactions DETACH PARTITION "
            + partitionName + " CONCURRENTLY");

        // 5. Record archival in audit log
        archivalAuditRepository.save(new ArchivalRecord(
            partitionName, rowCount, Instant.now()));

        // 6. Drop (after cold storage confirmed)
        jdbcTemplate.execute("DROP TABLE " + partitionName);

        return ArchivalResult.success(partitionName, rowCount);
    }
}
```

---

## 9. Performance Considerations

### 9.1 Planning Overhead with Many Partitions

```sql
-- PostgreSQL must check partition constraints during planning
-- With 1000+ partitions, planning time can dominate
-- Monitor planning time in slow query log

-- Set a planning time warning threshold
-- Look for high planning time in pg_stat_statements:
SELECT
    left(query, 80) AS query_snippet,
    calls,
    round(mean_exec_time::numeric, 2) AS mean_ms,
    round(mean_plan_time::numeric, 2) AS mean_plan_ms,
    total_exec_time::bigint AS total_exec_ms
FROM pg_stat_statements
WHERE mean_plan_time > mean_exec_time  -- Planning dominates execution
ORDER BY mean_plan_time DESC
LIMIT 10;
```

### 9.2 Partition-wise Join and Aggregation

```sql
-- Enable partition-wise operations (may improve large aggregations)
SET enable_partitionwise_join = on;
SET enable_partitionwise_aggregate = on;

-- Partition-wise aggregate: PostgreSQL aggregates each partition
-- independently, then combines results (exploits parallelism)
SELECT
    DATE_TRUNC('month', transaction_date) AS month,
    currency,
    SUM(amount) AS total_volume
FROM transactions
WHERE transaction_date >= '2023-01-01'
GROUP BY 1, 2;
-- With enable_partitionwise_aggregate: each partition aggregated in parallel
```

### 9.3 Cross-Partition Queries

```sql
-- Queries without partition key must scan all partitions
-- This is EXPECTED for certain reporting queries
EXPLAIN SELECT SUM(amount)
FROM transactions
WHERE account_id = 'ACC-1001';
-- Scans all date partitions — no pruning possible without date filter

-- For account-centric queries that must span all dates,
-- consider a separate hash-partitioned table or materialized view
CREATE MATERIALIZED VIEW account_transaction_summary AS
SELECT
    account_id,
    COUNT(*) AS transaction_count,
    SUM(amount) AS total_amount,
    MIN(transaction_date) AS first_date,
    MAX(transaction_date) AS last_date
FROM transactions
GROUP BY account_id;

REFRESH MATERIALIZED VIEW CONCURRENTLY account_transaction_summary;
```

---

## 10. Partitioning Decision Framework

| Question | Answer | Recommendation |
|----------|--------|---------------|
| Does the table grow > 1M rows/month? | Yes | Partition |
| Is data accessed primarily by date range? | Yes | Range partition by date |
| Is data accessed primarily by entity ID? | Yes | Hash partition by ID |
| Do you need data residency by region? | Yes | List partition by region |
| Is table size > 50GB? | Yes | Partition is urgent |
| Does VACUUM take > 1 hour? | Yes | Partition immediately |
| Do you need to drop old data regularly? | Yes | Range partition for easy detach |

---

## Summary

Partitioning transforms unmanageable monolithic tables into operationally sound data structures. Key principles for financial systems:

- **Range partition** transaction history by month — aligns with reporting cycles and enables instant archival via `DETACH PARTITION`
- **Hash partition** account and customer data — even distribution, no hot spots
- **List partition** by region/currency — data residency and jurisdiction alignment
- **Verify pruning** with `EXPLAIN` before deploying — wrong types or function wrapping silently disable pruning
- **Plan for uniqueness** — partition key must be included in unique constraints; design IDs to include routing information
- **Pre-create future partitions** — a missing partition causes insert errors; use pg_partman or a scheduled job
- **Detach, don't delete** — old partition archival is an instant metadata operation, not a DELETE storm
- **Watch planning overhead** — hundreds of partitions increase query planning time; monitor with pg_stat_statements

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A query runs against a monthly range-partitioned transactions table: SELECT * FROM transactions WHERE DATE_TRUNC('month', transaction_date) = '2024-01-01'. EXPLAIN shows all partitions being scanned. What is the root cause and fix?",
      "options": ["The index is missing on transaction_date", "Wrapping the partition key in a function (DATE_TRUNC) disables partition pruning; rewrite as a range predicate on the key itself", "The partition type should be hash instead of range", "enable_partition_pruning is set to off"],
      "correct": 1,
      "explanation": "PostgreSQL's partition pruning works by comparing predicate values against partition bounds. When the partition key is wrapped in a function like DATE_TRUNC, the planner cannot determine which partitions match without evaluating the function for every partition. The fix is to rewrite as: WHERE transaction_date >= '2024-01-01' AND transaction_date < '2024-02-01'."
    },
    {
      "text": "A transactions table partitioned by RANGE (transaction_date) needs a unique constraint on transaction_id alone (without including transaction_date). What happens when you attempt: CREATE UNIQUE INDEX ON transactions (transaction_id)?",
      "options": ["It succeeds and enforces global uniqueness across all partitions", "It fails because unique constraints on partitioned tables must include all partitioning columns", "It creates a unique index only on the default partition", "It creates a local unique index per partition that enforces uniqueness within each partition"],
      "correct": 1,
      "explanation": "PostgreSQL cannot enforce global uniqueness across partitions without the partition key, because each partition has its own independent index. The unique constraint must include all partitioning columns (transaction_date in this case). The workaround is to design transaction_id to embed the date, or use a separate routing/deduplication table."
    },
    {
      "text": "A financial platform needs to archive 2-year-old transaction partitions to cold storage and remove them from the active database. What is the correct operational sequence to accomplish this with minimal impact?",
      "options": ["DELETE all rows from the old partition during low-traffic hours", "DROP TABLE transactions_2022_01 directly", "ALTER TABLE transactions DETACH PARTITION transactions_2022_01 CONCURRENTLY, then export and DROP the detached table", "Truncate the old partition and rebuild it"],
      "correct": 2,
      "explanation": "DETACH PARTITION CONCURRENTLY (PostgreSQL 14+) uses a weaker lock than ACCESS EXCLUSIVE, allowing reads and writes to other partitions to continue. After detachment, the old partition becomes a standalone table that can be exported to S3 or cold storage, then dropped. This is an instantaneous metadata operation with no data scanning."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Operate a Partitioned Financial Transaction Table",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Create a monthly range-partitioned transactions table covering the current year (12 partitions). Create a composite index on (account_id, transaction_date DESC) INCLUDE (amount, currency, status) on the parent table and verify it propagates to all child partitions. Use EXPLAIN ANALYZE to confirm partition pruning works for a single-month date range query."},
    {"id": "2", "description": "Implement a Java PartitionMaintenanceJob scheduled with @Scheduled that runs daily and ensures partitions exist for the next 3 months. The job must be idempotent (safe to run multiple times), log each partition it creates or finds already existing, and handle the case where the job fails midway."},
    {"id": "3", "description": "Design a hash-partitioned accounts table with 16 partitions. After inserting 1 million test accounts, run a query to verify distribution skew is within 10% of ideal (each partition should have ~62,500 rows). Document the query you used to measure skew."},
    {"id": "4", "description": "Implement a PartitionArchivalService that: (1) validates the partition is at least 13 months old before archiving, (2) counts rows for the audit record, (3) detaches the partition using DETACH PARTITION CONCURRENTLY, (4) records the archival event in an audit table with row count and timestamp, and (5) drops the detached partition. Include rollback handling if any step fails."}
  ]
}
-->
