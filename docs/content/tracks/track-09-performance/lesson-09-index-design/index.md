---
id: track-09-lesson-09
title: "Index Design — B-Tree, Hash, and Partial Indexes"
slug: index-design
track: track-09
trackName: "Performance Engineering"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [index, B-tree, hash-index, partial-index, covering-index]
prerequisites: [track-09-lesson-08]
---

# Index Design — B-Tree, Hash, and Partial Indexes

> [!NOTE]
> Indexes are the single highest-leverage performance tool in relational databases, but every index has a write-time cost. A poorly designed index strategy taxes every INSERT, UPDATE, and DELETE. In a payment system processing thousands of transactions per second, this tax compounds rapidly.

## 1. B-Tree Indexes — The Default Workhorse

B-tree (balanced tree) is PostgreSQL's default index type. Understanding its structure is essential for designing effective indexes.

### Structure and Properties

A B-tree index maintains sorted key values in a balanced tree where:
- All leaf nodes are at the same depth
- Each internal node contains keys and pointers to child nodes
- Leaf nodes contain key values and heap TID (tuple identifier) pointers
- Adjacent leaf nodes are linked for efficient range scans

```
                    [500 | 1000]
                   /      |      \
         [100|200|300]  [600|700]  [1100|1200|1300]
         /   |   |   \   ...
     [TIDs] [TIDs] ...
```

**Properties**:
- O(log N) for point lookups
- O(log N + K) for range scans (K = result rows)
- Supports `=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `IN`, `LIKE 'prefix%'`
- Supports `ORDER BY` without an additional sort
- Supports `IS NULL` and `IS NOT NULL`

### Creating B-Tree Indexes for Payment Tables

```sql
-- Primary key (B-tree by default)
CREATE TABLE transactions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL,
    amount       NUMERIC(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    type         VARCHAR(30) NOT NULL,
    reference    VARCHAR(100),
    idempotency_key VARCHAR(64) UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at   TIMESTAMPTZ
);

-- Simple B-tree on foreign key (always index FK columns)
CREATE INDEX idx_transactions_account_id
    ON transactions (account_id);

-- B-tree on timestamp for range queries
CREATE INDEX idx_transactions_created_at
    ON transactions (created_at DESC);

-- Verify indexes exist
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'transactions';
```

### Composite B-Tree Index Column Ordering

The order of columns in a composite index is critical. The rule: **equality predicates first, range predicates last, high-selectivity columns first within each tier**.

```sql
-- Query: account transaction history in a date range
-- WHERE account_id = $1 AND created_at BETWEEN $2 AND $3

-- WRONG order: range first breaks the ability to skip to a specific account
CREATE INDEX idx_bad ON transactions (created_at, account_id);
-- PostgreSQL must scan ALL rows in the date range, then filter by account_id

-- RIGHT order: equality first, then range
CREATE INDEX idx_transactions_account_date
    ON transactions (account_id, created_at DESC);
-- PostgreSQL jumps directly to account_id's rows, then scans date range

-- Query with two equality columns + range
-- WHERE account_id = $1 AND status = 'COMPLETED' AND created_at > $2
CREATE INDEX idx_transactions_account_status_date
    ON transactions (account_id, status, created_at DESC);
```

### Range Query Performance Comparison

```sql
-- Benchmark: 10M row transactions table, one account with 50K transactions

-- Without account_id+created_at composite index:
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM transactions
WHERE account_id = 'acct-001' AND created_at > NOW() - INTERVAL '30 days'
LIMIT 50;
-- Seq Scan: actual time=1823.456..1891.234 ms

-- With composite index:
-- Index Scan: actual time=0.043..0.312 ms  (~6000x faster)
```

## 2. Hash Indexes — Equality-Only, Faster for Point Lookups

Hash indexes map each key to a hash bucket. They are optimal for equality lookups but cannot support range queries or sorting.

```sql
-- Hash index on idempotency key (pure equality, never range)
CREATE INDEX idx_transactions_idempotency_hash
    ON transactions USING HASH (idempotency_key);

-- Verify hash index usage
EXPLAIN SELECT id FROM transactions
WHERE idempotency_key = 'idem-abc123-xyz';
-- Index Scan using idx_transactions_idempotency_hash

-- Hash is faster than B-tree for equality: O(1) vs O(log N)
-- But B-tree is typically preferred because:
-- 1. Hash indexes are larger in practice due to bucket collisions
-- 2. Hash indexes do not support range, IS NULL, ordering
-- 3. UNIQUE constraints require B-tree
-- Use hash only when you have measured that equality lookups are the bottleneck
```

**When to use hash indexes in fintech**:
- Idempotency key lookups (pure equality, very high frequency)
- External reference number lookups (payment gateway transaction IDs)
- Never for `created_at`, `amount`, or any range-queried column

## 3. Partial Indexes — Indexing a Subset of Rows

Partial indexes include only rows matching a `WHERE` clause. They are smaller, faster, and extremely powerful for status-based filtering.

### PENDING Transaction Partial Index

```sql
-- Only a small fraction of transactions are PENDING at any time
-- A full index on status wastes space on COMPLETED/FAILED rows
CREATE INDEX idx_transactions_pending_account
    ON transactions (account_id, created_at)
    WHERE status = 'PENDING';

-- This index is used ONLY when status = 'PENDING' appears in the WHERE clause
EXPLAIN SELECT COUNT(*), SUM(amount)
FROM transactions
WHERE account_id = 'acct-001'
  AND status = 'PENDING'
  AND created_at > NOW() - INTERVAL '24 hours';

-- Index Scan using idx_transactions_pending_account
-- (actual time=0.021..0.187 rows=3 loops=1)
-- Index is tiny because only ~0.1% of transactions are PENDING
```

### Account Status Partial Index

```sql
-- Active accounts are a small subset of all accounts
-- Fraud checks and velocity rules only apply to active accounts
CREATE INDEX idx_accounts_active_number
    ON accounts (account_number)
    WHERE status = 'ACTIVE';

-- Frozen/closed accounts are excluded from this index
-- Keeps index small even as closed accounts accumulate over years
```

### Partial Index for NULL Columns

```sql
-- settled_at is NULL until a transaction completes
-- Unsettled transaction queries only need to scan NULL rows
CREATE INDEX idx_transactions_unsettled
    ON transactions (account_id, created_at)
    WHERE settled_at IS NULL;

-- Query: find all unsettled transactions for an account
SELECT id, amount, created_at
FROM transactions
WHERE account_id = 'acct-001'
  AND settled_at IS NULL
ORDER BY created_at DESC;
-- Uses idx_transactions_unsettled directly
```

### Partial Index Size Comparison

```sql
-- Compare index sizes
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    indpred IS NOT NULL AS is_partial
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_indexes idx ON idx.indexname = c.relname
WHERE idx.tablename = 'transactions'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Typical result for 50M row transactions table:
-- idx_transactions_account_date     : 2.1 GB  (full)
-- idx_transactions_pending_account  : 12 MB   (partial, 0.02% of rows)
-- Space savings: 99.4%
```

## 4. Covering Indexes with INCLUDE

A covering index stores additional columns in the leaf pages so that the query can be satisfied entirely from the index without touching the heap.

```sql
-- Without covering index: index scan + heap fetch for each row
CREATE INDEX idx_basic ON transactions (account_id, created_at DESC);

-- With covering index: index-only scan possible
CREATE INDEX idx_transactions_account_date_covering
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status, type, reference);

-- Now this query needs ZERO heap access:
EXPLAIN (ANALYZE, BUFFERS)
SELECT amount, currency, status, type, reference, created_at
FROM transactions
WHERE account_id = 'acct-001'
ORDER BY created_at DESC
LIMIT 50;

-- Index Only Scan using idx_transactions_account_date_covering
-- Heap Fetches: 0
-- Buffers: shared hit=4  (only index pages)
```

**INCLUDE vs index key columns**:
- INCLUDE columns are stored only in leaf nodes, not internal nodes — index is smaller
- INCLUDE columns cannot be used in WHERE conditions or ORDER BY
- INCLUDE columns are not part of the uniqueness constraint
- Use INCLUDE for columns you project but never filter/sort on

```sql
-- Pattern: minimal key for filtering + project-only columns in INCLUDE
CREATE INDEX idx_accounts_lookup
    ON accounts (account_number)              -- key: used for WHERE
    INCLUDE (balance, currency, status, version);  -- projected columns
```

## 5. Expression Indexes

Expression indexes index the result of a function or expression rather than a column value.

```sql
-- Case-insensitive account number lookup
CREATE INDEX idx_accounts_number_lower
    ON accounts (LOWER(account_number));

-- Query must use the same expression
SELECT * FROM accounts WHERE LOWER(account_number) = LOWER($1);

-- Date-only index (strip time component for day-level queries)
CREATE INDEX idx_transactions_date
    ON transactions (DATE(created_at));

-- Query using date truncation
SELECT COUNT(*) FROM transactions WHERE DATE(created_at) = '2024-01-15';

-- JSONB expression index for metadata column
CREATE INDEX idx_transactions_metadata_type
    ON transactions ((metadata->>'payment_method'));

-- Query
SELECT * FROM transactions WHERE metadata->>'payment_method' = 'CARD';
```

**Warning**: Expression indexes require the query to use the exact same expression. `LOWER(account_number)` and `lower(account_number)` are the same, but `TRIM(LOWER(account_number))` is not.

## 6. Index-Only Scans — When They Apply

Index-only scans skip the heap entirely. They require:
1. All projected columns are in the index (as key or INCLUDE)
2. The visibility map shows the page as "all visible" (no dead tuples)

```sql
-- Check visibility map coverage
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'transactions';

-- High dead_pct means visibility map is stale -> index-only scans fall back to heap
-- Solution: vacuum more aggressively
ALTER TABLE transactions SET (
    autovacuum_vacuum_scale_factor = 0.01,  -- vacuum at 1% dead tuples (default 20%)
    autovacuum_analyze_scale_factor = 0.005 -- analyze at 0.5% changes
);
```

## 7. Index Bloat — Monitoring and Maintenance

Indexes accumulate dead entries as rows are updated and deleted. Index bloat increases scan time and wastes disk space.

```sql
-- Monitor index bloat
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    CASE WHEN idx_scan = 0 THEN 'UNUSED' ELSE 'USED' END AS usage
FROM pg_stat_user_indexes
WHERE tablename IN ('transactions', 'accounts')
ORDER BY pg_relation_size(indexrelid) DESC;
```

```sql
-- Detailed bloat estimation using pgstattuple extension
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT
    indexname,
    pg_size_pretty(index_size) AS index_size,
    ROUND(avg_leaf_density, 1) AS fill_pct,
    leaf_fragmentation
FROM (
    SELECT
        c.relname AS indexname,
        pg_relation_size(c.oid) AS index_size,
        (pgstattuple(c.oid)).avg_leaf_density,
        (pgstattuple(c.oid)).leaf_fragmentation
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'transactions'
) sub
ORDER BY leaf_fragmentation DESC;

-- avg_leaf_density < 50% = significant bloat -> consider REINDEX
-- leaf_fragmentation > 30% = heavy fragmentation
```

### REINDEX CONCURRENTLY

```sql
-- Rebuild index without blocking reads/writes (PostgreSQL 12+)
REINDEX INDEX CONCURRENTLY idx_transactions_account_date;

-- Rebuild all indexes on a table
REINDEX TABLE CONCURRENTLY transactions;

-- Check progress
SELECT phase, blocks_done, blocks_total,
       ROUND(100.0 * blocks_done / NULLIF(blocks_total, 0), 1) AS pct_done
FROM pg_stat_progress_create_index
WHERE relid = 'transactions'::regclass;
```

**Important**: `REINDEX CONCURRENTLY` requires extra disk space (builds new index before dropping old), and it cannot be run inside a transaction block.

## 8. Unused Index Detection and Removal

```sql
-- Find indexes never used since last statistics reset
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS wasted_size,
    idx_scan AS scans_since_reset
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexname NOT LIKE '%_pkey'       -- keep primary keys
  AND indexname NOT LIKE '%_unique%'    -- keep unique constraints
ORDER BY pg_relation_size(indexrelid) DESC;
```

```sql
-- Be cautious: statistics reset on restart; check uptime first
SELECT NOW() - pg_postmaster_start_time() AS uptime;

-- Only trust zero-scan results if uptime > 2 weeks (covers all business cycles)
-- Before dropping, verify the index isn't used by a weekly/monthly report
```

Dropping an unused index:

```sql
-- Always use IF EXISTS and in a migration
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_old_reference;

-- Flyway migration
-- V20240115__drop_unused_transactions_reference_index.sql
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_reference_old;
```

## 9. Index Design for the Core Financial Schema

Here is a complete, production-ready index set for the payment core tables:

```sql
-- =============================================
-- accounts table indexes
-- =============================================

-- PK already creates: btree on id
-- UNIQUE constraint already creates: btree on account_number

-- Covering index for balance lookup (most frequent read path)
CREATE INDEX idx_accounts_balance_lookup
    ON accounts (account_number)
    INCLUDE (id, balance, currency, status, version);

-- Active account lookup (partial: excludes CLOSED/FROZEN)
CREATE INDEX idx_accounts_active
    ON accounts (account_number)
    WHERE status = 'ACTIVE';

-- Customer's accounts list
CREATE INDEX idx_accounts_customer
    ON accounts (customer_id, status, created_at DESC)
    INCLUDE (account_number, balance, currency);

-- =============================================
-- transactions table indexes
-- =============================================

-- PK already creates: btree on id
-- UNIQUE constraint on idempotency_key (use HASH for equality-only)
CREATE INDEX idx_transactions_idempotency
    ON transactions USING HASH (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Primary access pattern: account history (most frequent)
CREATE INDEX idx_transactions_account_history
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status, type, reference);

-- Settlement reconciliation
CREATE INDEX idx_transactions_settlement
    ON transactions (settled_at)
    WHERE settled_at IS NOT NULL AND status = 'COMPLETED';

-- Pending transaction velocity check (partial: tiny index)
CREATE INDEX idx_transactions_pending
    ON transactions (account_id, created_at)
    WHERE status = 'PENDING';

-- External reference lookup (payment gateway IDs)
CREATE INDEX idx_transactions_external_ref
    ON transactions (external_reference)
    WHERE external_reference IS NOT NULL;

-- Date-range query without account filter (admin/compliance)
CREATE INDEX idx_transactions_created_at
    ON transactions (created_at DESC)
    INCLUDE (account_id, amount, currency, status);
```

## 10. Java — Index-Aware Repository Pattern

```java
@Repository
public class TransactionRepository {

    private final JdbcTemplate jdbc;
    private final MeterRegistry metrics;

    // Uses idx_transactions_account_history (covering)
    public Page<TransactionSummary> findByAccountId(
            UUID accountId,
            Instant from,
            Instant to,
            Pageable pageable) {

        // Keyset pagination — avoids OFFSET scan degradation
        return jdbc.query(
            """
            SELECT id, amount, currency, status, type, reference, created_at
            FROM transactions
            WHERE account_id = ?
              AND created_at BETWEEN ? AND ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            rs -> {
                List<TransactionSummary> results = new ArrayList<>();
                while (rs.next()) {
                    results.add(mapRow(rs));
                }
                return new PageImpl<>(results, pageable, results.size());
            },
            accountId, from, to, pageable.getPageSize()
        );
    }

    // Uses idx_transactions_pending (partial) — tiny, fast
    public VelocityCheckResult checkVelocity(UUID accountId, Instant since) {
        return jdbc.queryForObject(
            """
            SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
            FROM transactions
            WHERE account_id = ?
              AND status = 'PENDING'
              AND created_at > ?
            """,
            (rs, row) -> new VelocityCheckResult(
                rs.getInt("cnt"),
                rs.getBigDecimal("total")
            ),
            accountId, since
        );
    }

    // Uses idx_transactions_idempotency (hash) — O(1) lookup
    public Optional<UUID> findIdByIdempotencyKey(String key) {
        List<UUID> results = jdbc.query(
            "SELECT id FROM transactions WHERE idempotency_key = ?",
            (rs, row) -> UUID.fromString(rs.getString("id")),
            key
        );
        return results.isEmpty() ? Optional.empty() : Optional.of(results.get(0));
    }
}
```

## 11. Monitoring Index Health in Production

```java
@Component
@Slf4j
public class IndexHealthMonitor {

    private final JdbcTemplate jdbc;
    private final MeterRegistry metrics;

    @Scheduled(fixedRate = 60_000)
    public void reportIndexStats() {
        // Report cache hit ratio per index
        jdbc.query(
            """
            SELECT indexname, idx_scan, idx_blks_hit, idx_blks_read,
                   ROUND(idx_blks_hit::numeric /
                       NULLIF(idx_blks_hit + idx_blks_read, 0) * 100, 1) AS hit_pct
            FROM pg_stat_user_indexes
            JOIN pg_statio_user_indexes USING (indexrelid)
            WHERE tablename IN ('transactions', 'accounts')
            """,
            rs -> {
                while (rs.next()) {
                    String indexName = rs.getString("indexname");
                    metrics.gauge("db.index.scans",
                        Tags.of("index", indexName),
                        rs.getLong("idx_scan"));
                    metrics.gauge("db.index.cache_hit_pct",
                        Tags.of("index", indexName),
                        rs.getDouble("hit_pct"));
                }
            }
        );
    }
}
```

## 12. Index Design Decision Framework

| Query Pattern | Recommended Index Type |
|---|---|
| Equality on high-cardinality column | B-tree or Hash |
| Range on timestamp/amount | B-tree |
| Equality + range combined | Composite B-tree (equality first) |
| Small subset of rows (< 10%) | Partial index |
| Covering frequently projected columns | Composite with INCLUDE |
| Function/expression in WHERE | Expression index |
| Pure equality, no range, no sort | Hash index |
| NULL/NOT NULL filtering | Partial index |

**The 5 rules of fintech index design**:
1. Always index foreign key columns (`account_id`, `customer_id`)
2. Partial indexes for status columns with low cardinality
3. Covering indexes for the top 5 most frequent query shapes
4. Never index every column "just in case" — monitor `pg_stat_user_indexes`
5. REINDEX CONCURRENTLY quarterly or after major bulk loads

> [!WARNING]
> Each index adds latency to every INSERT, UPDATE, and DELETE. A transaction table with 20 indexes will process writes significantly slower than one with 8 well-designed indexes. Profile write throughput when adding indexes to high-volume tables.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "When should you use a Hash index instead of a B-tree index in PostgreSQL?",
      "options": [
        "When the column has low cardinality (few distinct values)",
        "When queries use only equality predicates on the column and never range scans, sorts, or partial match operations",
        "Hash indexes are always faster than B-tree and should be the default choice",
        "When the table is partitioned by range on the same column"
      ],
      "correct": 1,
      "explanation": "Hash indexes are optimized for equality comparisons only (column = value). They cannot support range queries, ORDER BY, or LIKE prefix matching. Use them for pure equality lookups on high-cardinality columns like idempotency keys or payment references. B-tree remains the right choice for any query requiring range, sort, or multi-operator access."
    },
    {
      "text": "What is a covering index and when does it eliminate a heap fetch?",
      "options": [
        "A covering index covers multiple tables in a JOIN, replacing the need for a hash join",
        "A covering index includes all columns referenced in a query's SELECT and WHERE clauses via INCLUDE, allowing PostgreSQL to satisfy the query from the index alone without visiting the heap",
        "A covering index automatically covers related indexes for consistency",
        "A covering index uses more disk space but is otherwise identical to a regular index"
      ],
      "correct": 1,
      "explanation": "When an index contains all columns needed by a query (key columns in the index predicate plus non-key columns in INCLUDE), PostgreSQL can return results directly from the index pages without fetching the corresponding heap (table) pages. For a read-heavy transaction history query fetching amount, currency, and status, including those in the index eliminates the heap fetch on every row."
    },
    {
      "text": "Why should you use CREATE INDEX CONCURRENTLY in production instead of CREATE INDEX?",
      "options": [
        "CONCURRENTLY is faster; non-concurrent index creation is deprecated in PostgreSQL 14",
        "CREATE INDEX acquires a SHARE lock that blocks all writes (INSERT, UPDATE, DELETE) for the duration; CONCURRENTLY acquires only SHARE UPDATE EXCLUSIVE, allowing DML to continue while the index builds",
        "CONCURRENTLY creates the index on replicas in parallel; regular CREATE INDEX only indexes the primary",
        "They are equivalent; CONCURRENTLY is a no-op alias provided for compatibility"
      ],
      "correct": 1,
      "explanation": "CREATE INDEX acquires a SHARE lock which prevents any writes to the table until indexing completes. On a 100 million row transactions table, this could block writes for minutes. CONCURRENTLY takes two passes with weaker locks, allowing writes throughout. The tradeoff is that CONCURRENTLY takes longer and cannot run inside a transaction block."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Index Strategy for a High-Volume Transactions Table",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Design a complete index strategy for a transactions table (100M rows, 5000 TPS writes) that supports: account history queries by date range, pending transaction queues by account, deduplication by reference_id, and monthly settlement reports."},
    {"id": "2", "description": "Write all CREATE INDEX CONCURRENTLY statements for the designed indexes, including appropriate INCLUDE columns and partial index WHERE clauses."},
    {"id": "3", "description": "Write a Spring Boot ApplicationRunner that queries pg_stat_user_indexes and logs any index with idx_scan = 0 after the service has been running for 7+ days, flagging candidates for removal."},
    {"id": "4", "description": "Write a SQL query that identifies index bloat on the transactions table using pg_stat_user_indexes and pg_statio_user_indexes, and explain when REINDEX CONCURRENTLY should be scheduled."}
  ]
}
-->

