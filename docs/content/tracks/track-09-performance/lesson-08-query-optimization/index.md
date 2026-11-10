---
id: track-09-lesson-08
title: "Query Optimization — EXPLAIN ANALYZE and Index Usage"
slug: query-optimization
track: track-09
trackName: "Performance Engineering"
sequence: 8
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [query-optimization, EXPLAIN, index, sequential-scan, PostgreSQL]
prerequisites: [track-09-lesson-07]
---

# Query Optimization — EXPLAIN ANALYZE and Index Usage

> [!NOTE]
> A query that runs in 2 ms with 10,000 rows will often run in 20 seconds with 10 million rows. Financial databases grow relentlessly — understanding how PostgreSQL plans and executes queries is not optional for engineers building payment infrastructure.

## 1. The EXPLAIN ANALYZE Output Format

PostgreSQL's `EXPLAIN ANALYZE` is the definitive tool for understanding query execution. It combines the planner's cost estimates with actual runtime measurements.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT t.id, t.amount, t.status, a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.created_at >= NOW() - INTERVAL '30 days'
  AND t.status = 'COMPLETED'
ORDER BY t.created_at DESC
LIMIT 100;
```

A representative output:

```
Limit  (cost=12834.56..12834.81 rows=100 width=72)
       (actual time=89.234..89.251 rows=100 loops=1)
  Buffers: shared hit=4821 read=1203
  ->  Sort  (cost=12834.56..12896.56 rows=24800 width=72)
            (actual time=89.231..89.237 rows=100 loops=1)
        Sort Key: t.created_at DESC
        Sort Method: top-N heapsort  Memory: 52kB
        Buffers: shared hit=4821 read=1203
        ->  Hash Join  (cost=1823.00..12462.00 rows=24800 width=72)
                       (actual time=12.431..85.123 rows=24800 loops=1)
              Hash Cond: (t.account_id = a.id)
              Buffers: shared hit=4821 read=1203
              ->  Index Scan using idx_transactions_created_at
                    on transactions t
                    (cost=0.56..9876.44 rows=24800 width=56)
                    (actual time=0.043..71.234 rows=24800 loops=1)
                  Index Cond: (created_at >= (now() - '30 days'::interval))
                  Filter: (status = 'COMPLETED'::transaction_status)
                  Rows Removed by Filter: 7200
                  Buffers: shared hit=4198 read=1203
              ->  Hash  (cost=823.00..823.00 rows=80000 width=24)
                        (actual time=11.432..11.432 rows=80000 loops=1)
                  Buckets: 131072  Batches: 1  Memory Usage: 4621kB
                  Buffers: shared hit=623
                  ->  Seq Scan on accounts a
                        (cost=0.00..823.00 rows=80000 width=24)
                        (actual time=0.012..6.234 rows=80000 loops=1)
                        Buffers: shared hit=623
Planning Time: 1.234 ms
Execution Time: 89.312 ms
```

### Anatomy of a Cost Node

Each node in the plan tree reports two cost tuples:

| Field | Meaning |
|---|---|
| `cost=startup..total` | Planner's estimated cost in arbitrary units (8KB pages) |
| `rows=N` | Planner's estimated output rows |
| `width=N` | Estimated average row width in bytes |
| `actual time=start..end` | Real wall-clock time in milliseconds |
| `actual rows=N` | Rows actually produced by this node |
| `loops=N` | How many times this node was executed |

**Critical insight**: When `rows` (estimate) diverges significantly from `actual rows` (reality), the planner made a bad decision based on stale statistics. Run `ANALYZE transactions;` and re-examine.

### Buffer Statistics

```
Buffers: shared hit=4821 read=1203
```

- `shared hit` — pages found in PostgreSQL's shared buffer cache (fast, ~0.1 µs)
- `read` — pages read from OS page cache or disk (slower, 0.1–10 ms)
- `written` — dirty pages flushed during the query (indicates checkpoint pressure)
- `local hit/read` — temporary table access

A high `read` count on a query that runs frequently is a cache-sizing problem. The rule of thumb: working set should fit in `shared_buffers` (typically 25% of RAM).

## 2. Sequential Scan vs Index Scan vs Index-Only Scan

The planner chooses a scan strategy based on cost estimates derived from table statistics.

### Sequential Scan

```sql
-- PostgreSQL will likely choose Seq Scan here (high selectivity)
EXPLAIN SELECT COUNT(*) FROM transactions WHERE amount > 0;

-- Output:
-- Seq Scan on transactions  (cost=0.00..158432.00 rows=9876543 width=0)
--   Filter: (amount > '0'::numeric)
```

Sequential scan reads every page of the table in order. It wins when:
- Selectivity is low (returning > ~5–15% of rows)
- The table fits in shared_buffers
- There is no suitable index

### Index Scan

```sql
-- High selectivity: index scan wins
EXPLAIN SELECT * FROM transactions WHERE id = 'txn_abc123';

-- Output:
-- Index Scan using transactions_pkey on transactions
--   (cost=0.56..8.58 rows=1 width=256)
--   Index Cond: (id = 'txn_abc123'::text)
```

Index scan navigates the B-tree to find heap tuple pointers, then fetches each heap page. For highly selective queries it is dramatically faster than sequential scan.

### Index-Only Scan

```sql
-- If the index covers all needed columns, heap access is skipped
CREATE INDEX idx_txn_account_amount ON transactions (account_id, amount);

EXPLAIN SELECT account_id, SUM(amount)
FROM transactions
WHERE account_id = 'acct_xyz'
GROUP BY account_id;

-- Output:
-- Index Only Scan using idx_txn_account_amount on transactions
--   (cost=0.56..421.33 rows=1250 width=24)
--   Index Cond: (account_id = 'acct_xyz'::text)
--   Heap Fetches: 0   <-- zero heap pages read
```

Index-only scans skip the heap entirely when:
1. All projected columns are in the index
2. The visibility map shows the page is all-visible (no dead tuples to check)

**Financial impact**: For account balance summary queries running millions of times per day, index-only scans reduce I/O by orders of magnitude.

### Bitmap Index Scan

```sql
EXPLAIN SELECT * FROM transactions
WHERE account_id = 'acct_xyz'
  AND status = 'PENDING'
  AND created_at >= NOW() - INTERVAL '7 days';

-- Output:
-- Bitmap Heap Scan on transactions
--   Recheck Cond: (account_id = 'acct_xyz')
--   Filter: (status = 'PENDING' AND created_at >= ...)
--   ->  Bitmap Index Scan on idx_transactions_account_id
--         Index Cond: (account_id = 'acct_xyz'::text)
```

Bitmap index scan builds an in-memory bitmap of matching TIDs, then fetches heap pages in physical order — avoiding random I/O. It wins when selectivity is medium (too many rows for index scan, too few for seq scan).

Multiple bitmap scans can be combined with `BitmapAnd` / `BitmapOr`:

```sql
-- If we have separate indexes on account_id and status:
-- ->  BitmapAnd
--       ->  Bitmap Index Scan on idx_transactions_account_id
--       ->  Bitmap Index Scan on idx_transactions_status
```

## 3. Join Strategies: Hash Join vs Nested Loop vs Merge Join

### Nested Loop Join

```
Nested Loop  (cost=0.56..9823.45 rows=1250 width=72)
  ->  Index Scan on transactions t (outer, 1250 rows)
  ->  Index Scan on accounts a     (inner, 1 row per outer)
        Index Cond: (a.id = t.account_id)
```

**Best when**: outer relation is small and inner has an index on the join key. Classic for point lookups: fetch 1 transaction, join to its 1 account.

**Cost**: O(outer_rows × inner_scan_cost). Falls apart if outer produces thousands of rows.

### Hash Join

```
Hash Join  (cost=1823.00..12462.00 rows=24800 width=72)
  Hash Cond: (t.account_id = a.id)
  ->  Seq Scan on transactions t  (build side: 24800 rows)
  ->  Hash
        ->  Seq Scan on accounts a  (probe side: 80000 rows)
```

**Best when**: joining two large relations without a suitable index. Builds a hash table on the smaller relation, probes with the larger.

**Cost**: O(N+M) with high memory usage. If the hash table exceeds `work_mem`, it spills to disk (Batches > 1 in EXPLAIN output — a red flag).

```sql
-- Tune work_mem per session for a known-expensive report query
SET work_mem = '256MB';
EXPLAIN ANALYZE SELECT ...;  -- re-examine the plan
RESET work_mem;
```

### Merge Join

```
Merge Join  (cost=45678.00..56789.00 rows=24800 width=72)
  Merge Cond: (t.account_id = a.id)
  ->  Sort on transactions (account_id)
  ->  Sort on accounts     (id)
```

**Best when**: both relations are already sorted on the join key (e.g., both have indexes used for sorting). Rarely seen in practice unless the planner can avoid the sort step.

### Forcing Join Strategies for Testing

```sql
-- Disable hash join to force nested loop (diagnostic only)
SET enable_hashjoin = off;
EXPLAIN ANALYZE SELECT ...;
SET enable_hashjoin = on;

-- Disable nested loop to force hash join
SET enable_nestloop = off;
```

Never disable join strategies in production. Use these only to understand planner decisions.

## 4. Parallel Query Plans

For large analytical queries (e.g., daily settlement reports), PostgreSQL can parallelize execution.

```sql
-- Check parallel query settings
SHOW max_parallel_workers_per_gather;  -- default 2
SHOW parallel_tuple_cost;
SHOW min_parallel_table_scan_size;

-- Enable for session if needed
SET max_parallel_workers_per_gather = 4;
```

```
Gather  (cost=1000.00..125678.00 rows=9876543 width=24)
        (actual time=0.456..8923.123 rows=9876543 loops=1)
  Workers Planned: 4
  Workers Launched: 4
  ->  Parallel Seq Scan on transactions
        (cost=0.00..124234.56 rows=2469136 width=24)
        (actual time=0.034..1234.567 rows=2469136 loops=5)
        Filter: (created_at >= '2024-01-01')
```

The `Gather` node collects results from worker processes. `loops=5` means 1 leader + 4 workers each processed ~2.5M rows.

**Financial use case**: End-of-day reconciliation, fraud batch scoring, regulatory reporting — these benefit enormously from parallel plans.

```sql
-- Force parallel scan for large batch queries
ALTER TABLE transactions SET (parallel_workers = 8);

-- Or set per query
SET max_parallel_workers_per_gather = 8;
SET parallel_setup_cost = 100;      -- lower barrier to parallel
SET parallel_tuple_cost = 0.01;     -- lower cost per parallel tuple
```

## 5. pg_stat_statements — Identifying Slow Queries

`pg_stat_statements` aggregates query execution statistics across all calls. It is the first tool to reach for when investigating production performance.

```sql
-- Enable the extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- postgresql.conf settings:
-- shared_preload_libraries = 'pg_stat_statements'
-- pg_stat_statements.track = all
-- pg_stat_statements.max = 10000
```

### Finding the Most Expensive Queries

```sql
-- Top 20 queries by total execution time
SELECT
    LEFT(query, 120)                              AS query_preview,
    calls,
    ROUND(total_exec_time::numeric, 2)            AS total_ms,
    ROUND(mean_exec_time::numeric, 4)             AS mean_ms,
    ROUND(stddev_exec_time::numeric, 4)           AS stddev_ms,
    ROUND((100 * total_exec_time /
        SUM(total_exec_time) OVER ())::numeric, 2) AS pct_total,
    rows,
    shared_blks_hit,
    shared_blks_read,
    ROUND(shared_blks_hit::numeric /
        NULLIF(shared_blks_hit + shared_blks_read, 0) * 100, 1) AS cache_hit_pct
FROM pg_stat_statements
WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND calls > 100
ORDER BY total_exec_time DESC
LIMIT 20;
```

### Finding Queries with High Variance (Erratic Performance)

```sql
-- Queries with high stddev relative to mean are inconsistent
SELECT
    LEFT(query, 120) AS query_preview,
    calls,
    ROUND(mean_exec_time::numeric, 2)   AS mean_ms,
    ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
    ROUND(max_exec_time::numeric, 2)    AS max_ms,
    ROUND(stddev_exec_time / NULLIF(mean_exec_time, 0), 2) AS cv
FROM pg_stat_statements
WHERE calls > 50
  AND mean_exec_time > 1
ORDER BY cv DESC
LIMIT 20;
```

High coefficient of variation (CV > 2) indicates lock contention, checkpoint interference, or plan instability.

### Resetting Statistics

```sql
-- Reset statistics after a deployment or optimization
SELECT pg_stat_statements_reset();
```

## 6. auto_explain — Capturing Slow Plans in Production

`pg_stat_statements` shows aggregate statistics but not the actual plan. `auto_explain` logs the full EXPLAIN ANALYZE output for queries exceeding a threshold.

```sql
-- Load the extension
LOAD 'auto_explain';

-- Configure in postgresql.conf (or ALTER SYSTEM):
-- shared_preload_libraries = 'auto_explain'
-- auto_explain.log_min_duration = 1000    -- log queries > 1 second
-- auto_explain.log_analyze = true         -- include actual timing
-- auto_explain.log_buffers = true         -- include buffer stats
-- auto_explain.log_format = text          -- or json for tooling
-- auto_explain.log_nested_statements = true
-- auto_explain.sample_rate = 0.01         -- 1% sample in high-volume systems
```

For session-level testing (no restart required):

```sql
SET auto_explain.log_min_duration = 100;  -- 100 ms threshold
SET auto_explain.log_analyze = true;
SET auto_explain.log_buffers = true;

-- Now run your payment query and check PostgreSQL logs
SELECT * FROM transactions
WHERE account_id = 'acct_test'
ORDER BY created_at DESC
LIMIT 50;
```

## 7. Optimizing Payment-Specific Queries

### Pattern 1: Balance Lookup by Account ID

This is the highest-frequency query in most payment systems — called on every transaction authorization.

```sql
-- Schema
CREATE TABLE accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_number VARCHAR(20) UNIQUE NOT NULL,
    balance        NUMERIC(19,4) NOT NULL DEFAULT 0,
    currency       CHAR(3) NOT NULL,
    status         VARCHAR(20) NOT NULL,
    version        BIGINT NOT NULL DEFAULT 0,  -- optimistic lock
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query (before optimization)
SELECT balance, currency, status, version
FROM accounts
WHERE account_number = $1;

-- EXPLAIN output (without index on account_number):
-- Seq Scan on accounts  (cost=0.00..1823.00 rows=1 width=36)
--   Filter: (account_number = $1)
```

Adding the right index transforms this:

```sql
-- The UNIQUE constraint already creates an index on account_number
-- But verify it's being used:
EXPLAIN (ANALYZE, BUFFERS)
SELECT balance, currency, status, version
FROM accounts
WHERE account_number = $1;

-- Expected output:
-- Index Scan using accounts_account_number_key on accounts
--   (cost=0.42..8.44 rows=1 width=36)
--   (actual time=0.034..0.036 rows=1 loops=1)
--   Index Cond: (account_number = $1)
--   Buffers: shared hit=3
-- Planning Time: 0.112 ms
-- Execution Time: 0.058 ms
```

For a covering index (index-only scan when version/status are frequently read with balance):

```sql
CREATE INDEX idx_accounts_balance_lookup
    ON accounts (account_number)
    INCLUDE (balance, currency, status, version);
```

### Pattern 2: Transaction History by Date Range

This query powers customer-facing transaction feeds and statement generation.

```sql
-- Table schema
CREATE TABLE transactions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id),
    amount       NUMERIC(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL,
    type         VARCHAR(30) NOT NULL,
    reference    VARCHAR(100),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at   TIMESTAMPTZ
);

-- Naive query
SELECT id, amount, currency, status, type, reference, created_at
FROM transactions
WHERE account_id = $1
  AND created_at BETWEEN $2 AND $3
ORDER BY created_at DESC
LIMIT 50 OFFSET $4;
```

Without a proper index:

```sql
-- Bad: sequential scan with filter
-- Seq Scan on transactions (cost=0.00..158432.00 rows=1234 width=96)
--   Filter: (account_id = $1 AND created_at BETWEEN $2 AND $3)
```

With the right composite index:

```sql
-- Composite index: account_id first (equality), then created_at (range)
CREATE INDEX idx_transactions_account_date
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status, type, reference);

-- Now EXPLAIN shows:
-- Index Only Scan using idx_transactions_account_date on transactions
--   (cost=0.56..12.78 rows=50 width=96)
--   Index Cond: ((account_id = $1) AND
--                (created_at >= $2) AND (created_at <= $3))
--   Heap Fetches: 0
```

**Key rule**: Place equality conditions first in the composite index, range conditions last. This allows the B-tree to narrow down to a single account's transactions before scanning the date range.

### Pattern 3: Pending Transaction Count (Fraud Check)

```sql
-- Check how many pending transactions an account has (velocity check)
SELECT COUNT(*), SUM(amount)
FROM transactions
WHERE account_id = $1
  AND status = 'PENDING'
  AND created_at > NOW() - INTERVAL '24 hours';
```

Optimize with a partial index:

```sql
-- Partial index: only index PENDING transactions
-- Keeps index small since most transactions eventually settle
CREATE INDEX idx_transactions_pending
    ON transactions (account_id, created_at)
    WHERE status = 'PENDING';

-- The planner will use this only when status = 'PENDING' is in the WHERE clause
EXPLAIN SELECT COUNT(*), SUM(amount)
FROM transactions
WHERE account_id = $1
  AND status = 'PENDING'
  AND created_at > NOW() - INTERVAL '24 hours';

-- Index Scan using idx_transactions_pending on transactions
--   (actual time=0.021..0.187 rows=3 loops=1)
```

### Pattern 4: Settlement Reconciliation (Batch)

```sql
-- Daily settlement: sum all COMPLETED transactions by currency
-- This runs once per day but must complete in < 2 minutes
SELECT
    currency,
    COUNT(*) AS transaction_count,
    SUM(amount) AS total_amount,
    MIN(settled_at) AS first_settlement,
    MAX(settled_at) AS last_settlement
FROM transactions
WHERE settled_at >= $1  -- start of business day
  AND settled_at < $2   -- end of business day
  AND status = 'COMPLETED'
GROUP BY currency;
```

For this batch query, partition pruning (covered in lesson 19) is the primary optimization. If not partitioned:

```sql
CREATE INDEX idx_transactions_settlement_date
    ON transactions (settled_at)
    WHERE status = 'COMPLETED';

-- Enable parallel workers for this large aggregation
SET max_parallel_workers_per_gather = 8;
SET work_mem = '512MB';  -- reduce hash aggregate spills
```

## 8. Statistics Maintenance

The planner's cost estimates are only as good as the statistics. `pg_statistic` stores column histograms updated by `ANALYZE`.

```sql
-- Check when tables were last analyzed
SELECT
    schemaname,
    tablename,
    last_analyze,
    last_autoanalyze,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct
FROM pg_stat_user_tables
WHERE tablename IN ('transactions', 'accounts')
ORDER BY n_live_tup DESC;
```

For highly skewed columns (e.g., `status` with 95% COMPLETED), increase statistics target:

```sql
-- Default statistics_target is 100 (100 histogram buckets)
-- Increase for columns with complex distributions
ALTER TABLE transactions
    ALTER COLUMN account_id SET STATISTICS 500;

ALTER TABLE transactions
    ALTER COLUMN status SET STATISTICS 200;

-- Then re-analyze
ANALYZE transactions;
```

Extended statistics for correlated columns:

```sql
-- If account_id and status are correlated (each account has a status pattern),
-- multi-column statistics improve row estimates
CREATE STATISTICS stat_txn_account_status
    ON account_id, status
    FROM transactions;

ANALYZE transactions;

-- Check that statistics were computed
SELECT stxname, stxkeys, stxkind
FROM pg_statistic_ext
WHERE stxrelid = 'transactions'::regclass;
```

## 9. Java Integration — Query Plan Logging

```java
@Service
@Slf4j
public class TransactionQueryService {

    private final JdbcTemplate jdbcTemplate;
    private final MeterRegistry meterRegistry;

    public TransactionQueryService(JdbcTemplate jdbcTemplate,
                                   MeterRegistry meterRegistry) {
        this.jdbcTemplate = jdbcTemplate;
        this.meterRegistry = meterRegistry;
    }

    /**
     * Balance lookup with query plan logging in development.
     * Uses parameterized query to allow plan caching.
     */
    public AccountBalance getBalance(String accountNumber) {
        Timer.Sample sample = Timer.start(meterRegistry);

        try {
            return jdbcTemplate.queryForObject(
                """
                SELECT balance, currency, status, version
                FROM accounts
                WHERE account_number = ?
                """,
                (rs, rowNum) -> new AccountBalance(
                    rs.getBigDecimal("balance"),
                    rs.getString("currency"),
                    rs.getString("status"),
                    rs.getLong("version")
                ),
                accountNumber
            );
        } finally {
            sample.stop(meterRegistry.timer("db.query",
                "query", "balance_lookup",
                "table", "accounts"));
        }
    }

    /**
     * Log query plan for a specific query in a development/staging context.
     * Never run EXPLAIN ANALYZE in production hot paths — it disables caching.
     */
    @Profile("!production")
    public void logQueryPlan(String accountNumber) {
        String plan = jdbcTemplate.queryForObject(
            """
            EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT balance, currency, status, version
            FROM accounts
            WHERE account_number = ?
            """,
            String.class,
            accountNumber
        );
        log.info("Query plan for balance_lookup:\n{}", plan);
    }

    /**
     * Transaction history with pagination.
     * Uses keyset pagination instead of OFFSET for large datasets.
     */
    public List<TransactionSummary> getTransactionHistory(
            UUID accountId,
            Instant from,
            Instant to,
            UUID lastSeenId,       // keyset cursor
            Instant lastSeenDate,  // keyset cursor
            int limit) {

        String sql;
        Object[] params;

        if (lastSeenId == null) {
            // First page
            sql = """
                SELECT id, amount, currency, status, type, reference, created_at
                FROM transactions
                WHERE account_id = ?
                  AND created_at BETWEEN ? AND ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """;
            params = new Object[]{accountId, from, to, limit};
        } else {
            // Subsequent pages (keyset — no OFFSET scan)
            sql = """
                SELECT id, amount, currency, status, type, reference, created_at
                FROM transactions
                WHERE account_id = ?
                  AND created_at BETWEEN ? AND ?
                  AND (created_at, id) < (?, ?)
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """;
            params = new Object[]{accountId, from, to,
                                  lastSeenDate, lastSeenId, limit};
        }

        return jdbcTemplate.query(sql, (rs, rowNum) ->
            new TransactionSummary(
                UUID.fromString(rs.getString("id")),
                rs.getBigDecimal("amount"),
                rs.getString("currency"),
                rs.getString("status"),
                rs.getString("type"),
                rs.getString("reference"),
                rs.getTimestamp("created_at").toInstant()
            ),
            params
        );
    }
}
```

## 10. Identifying Plan Regressions in CI

Automate plan validation using Testcontainers:

```java
@SpringBootTest
@Testcontainers
class QueryPlanRegressionTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withDatabaseName("fintech_test")
        .withInitScript("schema.sql");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void balanceLookupShouldUseIndexScan() {
        // Seed enough data for the planner to prefer an index
        seedAccounts(100_000);

        String plan = jdbcTemplate.queryForObject(
            "EXPLAIN SELECT balance FROM accounts WHERE account_number = 'ACC0001'",
            String.class
        );

        assertThat(plan)
            .as("Balance lookup must use index scan, not sequential scan")
            .contains("Index")
            .doesNotContain("Seq Scan");
    }

    @Test
    void transactionHistoryShouldNotUseOffset() {
        // This test validates keyset pagination is used in service layer
        seedTransactions(500_000);

        String plan = jdbcTemplate.queryForObject(
            """
            EXPLAIN SELECT id, amount FROM transactions
            WHERE account_id = '00000000-0000-0000-0000-000000000001'
              AND created_at > NOW() - INTERVAL '30 days'
            ORDER BY created_at DESC, id DESC
            LIMIT 50
            """,
            String.class
        );

        assertThat(plan)
            .contains("Index")
            .doesNotContain("Seq Scan on transactions");
    }

    @Test
    void hashJoinShouldNotSpillToDisk() {
        // Hash join spill means work_mem is too low
        String plan = jdbcTemplate.queryForObject(
            """
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT t.id, a.account_number
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE t.created_at > NOW() - INTERVAL '1 day'
            """,
            String.class
        );

        // Parse JSON and check Batches == 1 (no spill)
        assertThat(plan).contains("\"Batches\": 1");
    }
}
```

## 11. EXPLAIN Visualisation Tools

For complex multi-join plans, text output is unwieldy. Use these tools:

- **explain.depesz.com** — paste text EXPLAIN output, get colour-coded node costs
- **explain.dalibo.com (pev2)** — interactive tree with per-node timing bars
- **pgMustard** — automated recommendations from EXPLAIN output

For JSON format (better for tooling):

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ...;

-- Returns a JSON array — feed to pev2 or store in monitoring
```

## 12. Summary and Decision Checklist

When a payment query is slow, follow this sequence:

1. **Capture the plan**: `EXPLAIN (ANALYZE, BUFFERS)` or check `auto_explain` logs
2. **Check estimates vs actuals**: If off by > 10×, run `ANALYZE` on the table
3. **Check buffer stats**: High `read` count → cache miss → needs index or `shared_buffers` increase
4. **Identify the expensive node**: The node with the highest `actual time` exclusive cost
5. **Check join strategy**: Hash join with Batches > 1 → increase `work_mem`
6. **Check index usage**: Seq scan on a large table with high selectivity → needs an index
7. **Check partial filter rows**: Large "Rows Removed by Filter" → consider a partial index
8. **Verify statistics**: `pg_stat_user_tables` → stale stats → run `ANALYZE`
9. **Test the fix**: Re-run `EXPLAIN ANALYZE` to verify improvement
10. **Add a regression test**: Testcontainers plan assertion in CI

> [!WARNING]
> Never run `EXPLAIN ANALYZE` on production hot paths in automated code. It executes the query and disables caching for that execution. Use `pg_stat_statements` and `auto_explain` for production diagnosis.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "An EXPLAIN ANALYZE output shows 'Rows Removed by Filter: 95000' under a Seq Scan node. What does this indicate and what is the appropriate fix?",
      "options": [
        "The query is working correctly; rows removed by filter is normal for WHERE clauses",
        "The planner estimated 95,000 rows would be removed but only a few remain after filtering, indicating high selectivity — an index on the filtered column would allow an Index Scan instead",
        "The table needs VACUUM to remove dead tuples causing false positives",
        "The work_mem setting is too low, causing disk spills"
      ],
      "correct": 1,
      "explanation": "Large 'Rows Removed by Filter' under a Seq Scan means the database is reading all rows and discarding most of them. If the predicate is selective (few rows match), adding an index on the filter column would let PostgreSQL use an Index Scan to fetch only matching rows directly, eliminating the full table scan."
    },
    {
      "text": "EXPLAIN ANALYZE shows 'Hash Batches: 4' on a hash join. What does this mean and how do you fix it?",
      "options": [
        "The join used 4 parallel workers; increase max_parallel_workers to improve throughput",
        "The hash table spilled to disk in 4 batches because the hash table exceeded work_mem; increase work_mem for this query session to fit the hash table in memory",
        "The query planner split the join into 4 chunks for safety; this is always optimal",
        "Hash Batches: 4 means 4 indexes were used; consider dropping unused indexes"
      ],
      "correct": 1,
      "explanation": "Hash Batches > 1 means the hash table was too large to fit in work_mem and was written to disk in multiple batches. This dramatically increases I/O. Fix by increasing work_mem (SET work_mem = '256MB') for the session running this query, or globally for reporting workloads."
    },
    {
      "text": "What is keyset pagination and why is it preferred over OFFSET pagination for large transaction history tables?",
      "options": [
        "Keyset pagination uses a Redis cache to skip over rows; OFFSET uses a database scan",
        "Keyset pagination filters by the last seen row's values using WHERE (created_at, id) < (?, ?), avoiding the full scan that OFFSET requires to skip N rows",
        "Keyset pagination is only available in PostgreSQL 14+; OFFSET works on all versions",
        "They are equivalent in performance; keyset is preferred only for code readability"
      ],
      "correct": 1,
      "explanation": "OFFSET N requires PostgreSQL to scan and discard N rows before returning results — cost grows linearly with page number. Keyset pagination adds a WHERE clause using the last page's cursor values, allowing PostgreSQL to seek directly to the right position using an index. For a table with 10 million rows, page 1000 of OFFSET pagination scans 50,000 rows; keyset pagination scans only the page size."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Query Optimisation for Account Balance and Transaction History",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Given a slow query on a transactions table with 10 million rows, write the EXPLAIN (ANALYZE, BUFFERS) output you would expect before and after adding a composite index on (account_id, created_at DESC) INCLUDE (amount, currency, status)."},
    {"id": "2", "description": "Implement keyset pagination for transaction history in a Spring JdbcTemplate repository, supporting cursor-based navigation using (created_at, id) as the composite cursor."},
    {"id": "3", "description": "Write a Testcontainers-based QueryPlanRegressionTest that seeds 500,000 transaction rows and asserts that the transaction history query uses an Index Scan and not a Seq Scan."},
    {"id": "4", "description": "Configure auto_explain in PostgreSQL to log queries slower than 100 ms, and write a Spring Boot ApplicationRunner that verifies auto_explain is active on startup in non-production environments."}
  ]
}
-->

