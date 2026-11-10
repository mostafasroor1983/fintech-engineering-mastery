---
id: track-10-lesson-16
title: "Query Plan Analysis — EXPLAIN, ANALYZE, and Visualisation"
slug: query-plan-analysis
track: track-10
trackName: "Database & Data Architecture"
sequence: 16
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [EXPLAIN, ANALYZE, query-plan, cost-model, visualisation]
prerequisites: [track-10-lesson-05]
---

# Query Plan Analysis — EXPLAIN, ANALYZE, and Visualisation

> [!NOTE]
> This lesson complements Track 09 Lesson 08 with a deeper focus on the database engineering perspective: cost model internals, statistics management, and production tooling for plan analysis. The two lessons together form a complete reference for query plan mastery.

## 1. EXPLAIN Output Structure — Cost Estimates

```sql
EXPLAIN SELECT t.id, t.amount, a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.created_at >= NOW() - INTERVAL '7 days';
```

```
Hash Join  (cost=2104.00..45678.00 rows=35000 width=56)
  Hash Cond: (t.account_id = a.id)
  ->  Seq Scan on transactions t  (cost=0.00..41234.00 rows=35000 width=36)
        Filter: (created_at >= (now() - '7 days'::interval))
  ->  Hash  (cost=1823.00..1823.00 rows=80000 width=24)
        ->  Seq Scan on accounts a  (cost=0.00..1823.00 rows=80000 width=24)
```

### Understanding Cost Numbers

Costs are in arbitrary units proportional to 8KB disk page fetches:

```sql
-- Cost unit defaults in postgresql.conf:
-- seq_page_cost = 1.0        (sequential page read = 1 unit)
-- random_page_cost = 4.0     (random page read = 4 units, reflects disk seek)
-- cpu_tuple_cost = 0.01      (processing one tuple)
-- cpu_index_tuple_cost = 0.005
-- cpu_operator_cost = 0.0025

-- Node cost = startup_cost + (rows * cpu_tuple_cost) + (pages * page_cost)
-- Hash Join cost = cost(build_hash) + cost(probe)
```

**Startup cost**: cost to produce the first row (e.g., sorting for a Sort node has high startup).
**Total cost**: cost to produce all rows.

**Important**: The planner minimizes `total_cost` for most queries, but `LIMIT` queries minimize startup cost (since we only need a few rows).

```sql
-- Without LIMIT: planner minimizes total cost
-- Sort is cheap here (sort + return all)
EXPLAIN SELECT * FROM transactions ORDER BY created_at DESC;

-- With LIMIT 10: planner minimizes startup cost
-- Index scan wins (can return first 10 rows without full sort)
EXPLAIN SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10;
```

## 2. EXPLAIN (ANALYZE, BUFFERS) — Runtime Statistics

```sql
EXPLAIN (ANALYZE, BUFFERS, TIMING, VERBOSE, FORMAT TEXT)
SELECT
    t.id,
    t.amount,
    t.status,
    a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.account_id = 'acct-001'
  AND t.created_at >= NOW() - INTERVAL '30 days'
ORDER BY t.created_at DESC
LIMIT 50;
```

Output annotation guide:

```
Index Scan using idx_transactions_account_history on transactions t
  (cost=0.56..12.78 rows=50 width=72)
  (actual time=0.043..0.312 rows=50 loops=1)
  --              ^                ^      ^
  --    startup_ms    total_ms   actual_rows  loops

  Index Cond: ((account_id = 'acct-001') AND (created_at >= ...))
  Buffers: shared hit=4 read=0 dirtied=0 written=0
  --              ^         ^
  --   pages from cache   pages from disk
```

**Detecting plan vs reality mismatch**:

```sql
-- rows estimate vs actual rows:
-- estimate: rows=50, actual: rows=50  -> GOOD
-- estimate: rows=5, actual: rows=50000  -> BAD (run ANALYZE)
-- estimate: rows=50000, actual: rows=5  -> BAD (index not used optimally)
```

The ratio `actual_rows / estimated_rows` is the **estimation error factor**. Values outside [0.5, 2.0] indicate stale statistics.

## 3. Sequential Scan vs Index Scan Decision

The planner calculates the cost of both options and chooses the cheaper one based on table statistics.

### Why the Planner Chooses Sequential Scan

```sql
-- Check the planner's cost calculation
SET enable_seqscan = off;  -- force index scan to compare costs
EXPLAIN SELECT * FROM transactions WHERE status = 'COMPLETED';

-- If this shows:
-- Index Scan: cost=0.56..1234567.00 rows=9000000
-- But with seqscan enabled:
-- Seq Scan: cost=0.00..158432.00 rows=9000000
-- Then seq scan is correctly chosen: status='COMPLETED' returns 90% of rows
```

```sql
-- Calculate breakeven selectivity
-- Index scan cost = index_pages * random_page_cost + result_rows * cpu_tuple_cost
-- Seq scan cost = table_pages * seq_page_cost + all_rows * cpu_tuple_cost
-- Index wins when result_rows / table_rows < ~10-15% (depends on table layout)

-- Check current statistics for selectivity estimation
SELECT
    attname,
    n_distinct,
    correlation,
    null_frac,
    most_common_vals,
    most_common_freqs
FROM pg_stats
WHERE tablename = 'transactions'
  AND attname = 'status';
```

**Correlation**: measures physical ordering of data vs index ordering. When `correlation = 1.0`, heap pages are in index order (each index entry points to the next physical page — very cache-friendly). When `correlation = 0.0`, heap pages are in random order (each index lookup fetches a different page — random I/O).

```sql
-- Low correlation = random heap access = index scan more expensive
-- transactions.status has correlation ~ 0 (random status across pages)
-- transactions.created_at has correlation ~ 1.0 (new rows always appended)

-- For low correlation columns, reduce random_page_cost to reflect NVMe SSD
ALTER SYSTEM SET random_page_cost = 1.1;  -- NVMe SSD (vs default 4.0 for HDD)
SELECT pg_reload_conf();

-- Now the planner will prefer index scans more aggressively
```

## 4. Nested Loop vs Hash Join Cost Comparison

```sql
-- Analyze join costs for a payment query
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT t.id, t.amount, a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.created_at >= NOW() - INTERVAL '24 hours'
  AND a.status = 'ACTIVE';
```

### Understanding Join Selection

```sql
-- Nested Loop: best for small outer + indexed inner
-- Cost ≈ outer_rows * (index_scan_cost per inner row)
-- Example: 10 rows outer * 0.01ms per inner lookup = 0.1ms total

-- Hash Join: best for large relations, no index on join key
-- Cost ≈ build_cost(smaller_relation) + probe_cost(larger_relation)
-- Memory: hash table must fit in work_mem

-- Check if hash join is spilling to disk (Batches > 1)
-- Hash  (cost=... rows=80000 width=24)
--   Buckets: 65536  Batches: 1  Memory Usage: 4096kB
--                   ^^^^^^^^^
-- Batches: 1 = fits in work_mem (GOOD)
-- Batches: 4 = spilling to disk (BAD - increase work_mem)
```

```sql
-- Adjust work_mem for the session when running large aggregations
SET work_mem = '256MB';
EXPLAIN (ANALYZE, BUFFERS)
SELECT a.currency, SUM(t.amount)
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.created_at >= NOW() - INTERVAL '30 days'
GROUP BY a.currency;
-- Verify: Batches: 1 in Hash node
RESET work_mem;
```

## 5. pg_stat_statements — Identifying Top Slow Queries

```sql
-- Top queries by total time (most impact)
SELECT
    queryid,
    LEFT(query, 150)                               AS query,
    calls,
    ROUND(total_exec_time::numeric / 1000, 2)      AS total_sec,
    ROUND(mean_exec_time::numeric, 2)              AS mean_ms,
    ROUND(stddev_exec_time::numeric, 2)            AS stddev_ms,
    rows,
    ROUND(100.0 * shared_blks_hit /
        NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
FROM pg_stat_statements
WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND calls > 100
ORDER BY total_exec_time DESC
LIMIT 20;
```

```sql
-- Find queries with poor cache hit rates (reading too much from disk)
SELECT
    LEFT(query, 150) AS query,
    calls,
    shared_blks_read,
    shared_blks_hit,
    ROUND(100.0 * shared_blks_hit /
        NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
FROM pg_stat_statements
WHERE shared_blks_read > 10000
  AND calls > 10
ORDER BY shared_blks_read DESC
LIMIT 20;
-- cache_hit_pct < 90% on a hot query is a problem: either missing index or
-- working set doesn't fit in shared_buffers
```

```sql
-- Find queries generating the most WAL (high write amplification)
SELECT
    LEFT(query, 150) AS query,
    calls,
    ROUND(wal_bytes / 1024.0 / calls, 1) AS wal_kb_per_call,
    wal_records
FROM pg_stat_statements
WHERE wal_bytes > 0
ORDER BY wal_bytes DESC
LIMIT 10;
-- High WAL per call indicates updates that touch many columns unnecessarily
-- Fix: only UPDATE the columns that changed
```

## 6. auto_explain — Capturing Slow Plans in Production

```sql
-- Enable auto_explain (requires shared_preload_libraries = 'auto_explain')
-- Apply at database level for all sessions
ALTER DATABASE payments SET
    auto_explain.log_min_duration = '1000';   -- log queries > 1 second

ALTER DATABASE payments SET
    auto_explain.log_analyze = 'true';

ALTER DATABASE payments SET
    auto_explain.log_buffers = 'true';

ALTER DATABASE payments SET
    auto_explain.log_format = 'text';

ALTER DATABASE payments SET
    auto_explain.sample_rate = '0.01';        -- 1% sample in high-volume systems

-- For specific sessions (e.g., load testing):
SET auto_explain.log_min_duration = 100;
SET auto_explain.log_analyze = true;
SET auto_explain.log_buffers = true;
```

Log output format (in PostgreSQL logs):

```
2024-01-15 10:30:05.123 UTC [1234] payments_app@payments LOG:
  duration: 1234.567 ms  plan:
  Index Scan using idx_transactions_account_history on transactions
    (cost=0.56..12.78 rows=50 width=96)
    (actual time=0.043..1234.512 rows=50000 loops=1)
    Index Cond: (account_id = 'acct-001'::uuid)
    Rows Removed by Index Recheck: 49950
  Buffers: shared hit=1203 read=4821
```

## 7. Common Plan Misestimates and Fixes

### Misestimate 1: Stale Statistics

```sql
-- Symptom: estimate=5, actual=50000 (10000x off)
-- Root cause: ANALYZE hasn't run since a large data insert

-- Fix: manual analyze
ANALYZE transactions;

-- For large tables, run with verbose to see column stats updated
ANALYZE VERBOSE transactions;

-- Check when last analyzed
SELECT relname, last_analyze, last_autoanalyze, n_live_tup
FROM pg_stat_user_tables
WHERE relname = 'transactions';

-- Configure more aggressive autovacuum analyze
ALTER TABLE transactions SET (
    autovacuum_analyze_scale_factor = 0.01,  -- analyze after 1% change
    autovacuum_analyze_threshold = 1000
);
```

### Misestimate 2: Correlated Column Underestimation

```sql
-- Symptom: WHERE account_id = X AND status = 'PENDING' returns 1 row,
--          but planner estimates 500 rows

-- Root cause: planner treats columns as independent:
--   p(account_id=X) = 1/100000 = 0.00001
--   p(status='PENDING') = 0.001
--   Combined estimate: 0.00001 * 0.001 * 10M = 0.1 rows -> rounded to 1? No, 500 rows

-- Fix: multi-column statistics
CREATE STATISTICS stat_txn_account_status (dependencies)
    ON account_id, status
    FROM transactions;

ANALYZE transactions;

-- Verify statistics created
SELECT stxname, stxkind, stxrelid::regclass
FROM pg_statistic_ext
WHERE stxrelid = 'transactions'::regclass;
```

### Misestimate 3: Range Predicate with Skewed Data

```sql
-- Symptom: WHERE created_at > '2024-01-01' estimates 1000 rows,
--          actual is 9,500,000 (nearly all data was inserted this year)

-- Root cause: default statistics bucket (100) can't capture this skew
ALTER TABLE transactions ALTER COLUMN created_at SET STATISTICS 500;
ANALYZE transactions;

-- Check the new histogram
SELECT
    histogram_bounds::text
FROM pg_stats
WHERE tablename = 'transactions'
  AND attname = 'created_at';
```

## 8. Plan Visualisation Tools

### explain.depesz.com

Paste plain `EXPLAIN` output. Each node is highlighted with color based on estimated cost:
- Green: low cost
- Yellow: medium cost
- Red: high cost

**Use for**: quick identification of the most expensive nodes.

### explain.dalibo.com (pev2)

Interactive tree visualization with:
- Timing bars proportional to actual time
- Estimates vs actuals comparison
- Filter efficiency metrics

```sql
-- Generate JSON output for pev2
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT t.id, t.amount, a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.account_id = 'acct-001'
  AND t.created_at >= NOW() - INTERVAL '30 days'
ORDER BY t.created_at DESC
LIMIT 50;

-- Copy the JSON array output and paste into explain.dalibo.com
```

### pgMustard

Automated analysis tool that reads EXPLAIN output and provides specific recommendations:

```
pgMustard recommendations:
  - WARNING: Hash join batches=4 (spilling to disk). Increase work_mem to 256MB.
  - WARNING: Rows removed by filter: 95,000 (99.9% removal rate). 
             Consider partial index WHERE status = 'PENDING'.
  - INFO: Table transactions has not been analyzed in 7 days (n_dead_tup=15%).
          Run ANALYZE transactions.
```

## 9. Capturing Slow Query Plans Programmatically

```java
@Aspect
@Component
@Slf4j
@Profile("!production")  // only in dev/staging
public class SlowQueryPlanCapture {

    private final JdbcTemplate jdbcTemplate;
    private static final long SLOW_QUERY_THRESHOLD_MS = 500;

    @Around("@annotation(captureSlowQueryPlan)")
    public Object capturePlan(ProceedingJoinPoint pjp,
                               CaptureSlowQueryPlan annotation) throws Throwable {
        long start = System.currentTimeMillis();
        Object result = pjp.proceed();
        long elapsed = System.currentTimeMillis() - start;

        if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
            String sql = extractSql(annotation);
            if (sql != null) {
                captureAndLogPlan(sql, elapsed);
            }
        }
        return result;
    }

    private void captureAndLogPlan(String sql, long elapsed) {
        try {
            String plan = jdbcTemplate.queryForObject(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) " + sql,
                String.class
            );
            log.warn("SLOW QUERY ({}ms):\nSQL: {}\nPLAN:\n{}",
                elapsed, sql, plan);
        } catch (Exception e) {
            log.debug("Could not capture query plan: {}", e.getMessage());
        }
    }
}

// Custom annotation
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface CaptureSlowQueryPlan {
    String value() default "";
}
```

## 10. Plan Analysis Workflow

Systematic approach for a reported slow query in production:

```
1. Identify the query
   - pg_stat_statements: top by total_exec_time
   - auto_explain logs: queries > 1 second
   - APM trace: distributed trace showing DB as bottleneck

2. Reproduce in staging
   - Use production data volumes (Testcontainers with dump)
   - Set statistics to match production: ANALYZE with real data

3. Run EXPLAIN (ANALYZE, BUFFERS)
   - Is estimate vs actual far off? -> ANALYZE first
   - Is there a Seq Scan on a large table? -> index opportunity
   - Is there a Hash Join with Batches > 1? -> work_mem issue
   - Are many rows removed by filter? -> partial index opportunity

4. Test the fix
   - Apply proposed index (CREATE INDEX CONCURRENTLY in staging)
   - Re-run EXPLAIN ANALYZE: verify plan changes
   - Run load test: verify p99 improvement

5. Deploy to production
   - CREATE INDEX CONCURRENTLY (doesn't block)
   - Monitor pg_stat_statements before/after
   - Check for regression in related queries

6. Add regression test
   - Testcontainers test asserting plan contains "Index" not "Seq Scan"
   - Automated in CI
```

> [!WARNING]
> `EXPLAIN ANALYZE` executes the query. Never run it on a destructive query (`DELETE`, `UPDATE`, `INSERT`) against production data. Wrap in a transaction and roll back: `BEGIN; EXPLAIN ANALYZE DELETE FROM ...; ROLLBACK;`

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "EXPLAIN ANALYZE shows: `Seq Scan on transactions (cost=0.00..158000.00 rows=9500000 actual rows=9500000)`. An index exists on the status column. The query is `SELECT * FROM transactions WHERE status = 'COMPLETED'`. Why does the planner choose a sequential scan over the index?",
      "options": [
        "The index is corrupted and needs to be rebuilt with REINDEX",
        "The status column cardinality is too low to be indexed efficiently",
        "The planner estimates that 'COMPLETED' matches ~95% of rows; fetching 95% of a table via an index requires far more random I/O than a sequential scan, making sequential scan cheaper",
        "The query uses SELECT * which forces a sequential scan regardless of available indexes"
      ],
      "correct": 2,
      "explanation": "The index scan / sequential scan choice is based on estimated result set size relative to table size. When a predicate matches a large fraction of rows (here ~95%), random index-based heap access requires one disk page read per result row (scattered across the table). A sequential scan reads the whole table in sequential order — vastly more cache-friendly and cheaper for high-selectivity predicates. The index is correctly unused. To verify this, you can SET enable_seqscan = off and compare costs in EXPLAIN output."
    },
    {
      "text": "EXPLAIN (ANALYZE, BUFFERS) shows: `Hash (Buckets: 65536 Batches: 4 Memory Usage: 32768kB)`. What does Batches: 4 indicate and what is the fix?",
      "options": [
        "The hash join used 4 parallel workers for better performance",
        "The hash table was split into 4 batches because it did not fit in work_mem, causing spills to disk; increase work_mem for this session or query",
        "The query plan has 4 nested hash joins, which is normal for complex queries",
        "PostgreSQL partitioned the hash table into 4 for cache efficiency"
      ],
      "correct": 1,
      "explanation": "Batches: 1 means the hash table fit entirely in work_mem (ideal). Batches > 1 means the hash table was too large for work_mem and PostgreSQL spilled portions to disk (temp files). Each batch requires additional disk reads, significantly increasing query time. The fix is to increase work_mem: either globally in postgresql.conf or per-session with SET work_mem = '256MB'. The hash table size equals the smaller relation in the join × average row width — use EXPLAIN output to estimate the required work_mem."
    },
    {
      "text": "pg_stat_statements shows a query with calls=50,000, mean_ms=250, stddev_ms=800. What does the high standard deviation relative to mean indicate, and what should you investigate first?",
      "options": [
        "The query is fast on average; high stddev is normal for database queries",
        "High stddev relative to mean indicates bimodal performance: most executions are fast but some are very slow; investigate lock contention, cache misses (shared_blks_read spikes), and auto_explain logs for the slow instances",
        "The query plan is unstable and PostgreSQL is choosing different plans; force a plan with pg_hint_plan",
        "The stddev is caused by network latency variation and is outside PostgreSQL's control"
      ],
      "correct": 1,
      "explanation": "stddev/mean = 800/250 = 3.2 is very high, indicating the execution time is not clustered around the mean. This typically means bimodal performance: most queries execute in ~20-50ms (cache hits, no contention) but some execute in 1-5 seconds (cache miss, lock wait, or autovacuum interference). To diagnose: check shared_blks_read vs shared_blks_hit for cache miss patterns; check pg_stat_activity for lock wait events during peak periods; enable auto_explain to capture the full query plan during slow executions."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Query Plan Investigation and Optimization",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Using pg_stat_statements on a test PostgreSQL instance with the payments schema, identify the top 3 queries by total_exec_time after simulating 1 hour of payment processing with pgbench. For each query, run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), identify the most expensive node, and determine whether the bottleneck is a missing index, stale statistics, or work_mem insufficiency."},
    {"id": "2", "description": "Demonstrate statistics staleness: insert 5 million rows into a transactions table, then run EXPLAIN on a range predicate query. The estimate will be wildly off. Run ANALYZE and show the before/after estimation error factor. Then create multi-column statistics for correlated columns (account_id, status) and show the improvement in the estimate for a compound predicate."},
    {"id": "3", "description": "Configure auto_explain in a Testcontainers PostgreSQL instance to log all queries over 100ms. Write a test that generates a slow query (hash join with Batches > 1 due to small work_mem), captures the auto_explain log output, parses the plan JSON to extract the Batches value, and fails the test if Batches > 1. This validates that work_mem is correctly sized in CI."},
    {"id": "4", "description": "Build a Spring Boot @Aspect that intercepts all repository method calls, runs EXPLAIN (FORMAT JSON) on the SQL before execution (in non-production environments), checks for Seq Scan nodes on tables with more than 100,000 rows, and logs a WARNING with the full plan. Add a test that verifies a known slow query triggers this warning, ensuring the aspect correctly identifies missing index usage."}
  ]
}
-->
