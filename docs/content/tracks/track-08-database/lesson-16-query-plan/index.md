---
id: track-08-lesson-16
title: "Query Plan Analysis — EXPLAIN, ANALYZE, and Visualisation"
slug: query-plan-analysis
track: track-08
trackName: "Database Engineering"
sequence: 16
difficulty: advanced
estimatedMinutes: 70
status: published
tags:
  - EXPLAIN
  - ANALYZE
  - query-plan
  - seq-scan
  - index-scan
  - PostgreSQL
  - performance
prerequisites:
  - track-08-lesson-15
---

# Query Plan Analysis — EXPLAIN, ANALYZE, and Visualisation

Understanding what PostgreSQL actually does when it executes a query is the single most important debugging skill for a database engineer. A query that runs in 2 ms on a table with 10,000 rows might take 45 seconds on a table with 50 million rows — not because the query changed, but because the execution strategy did. This lesson teaches you to read, interpret, and act on query execution plans.

---

## 1. The Three Levels of EXPLAIN

PostgreSQL provides three progressive levels of introspection, each revealing more information at greater cost.

### EXPLAIN (estimated only)

```sql
EXPLAIN
SELECT p.id, p.amount, p.status, a.holder_name
FROM   payments p
JOIN   accounts a ON a.id = p.source_account_id
WHERE  p.created_at >= NOW() - INTERVAL '7 days'
  AND  p.status = 'PENDING';
```

Output:

```
Hash Join  (cost=1842.55..9201.33 rows=4120 width=52)
  Hash Cond: (p.source_account_id = a.id)
  ->  Seq Scan on payments p  (cost=0.00..6945.20 rows=4120 width=36)
        Filter: ((status = 'PENDING') AND (created_at >= (now() - '7 days'::interval)))
  ->  Hash  (cost=1105.00..1105.00 rows=59004 width=24)
        ->  Seq Scan on accounts a  (cost=0.00..1105.00 rows=59004 width=24)
```

The numbers are **estimates** produced from table statistics — no SQL is executed. The planner uses `pg_statistic` (exposed through `pg_stats`) to estimate row counts and costs.

**Cost notation:** `cost=startup..total`
- `startup`: cost to produce the first row (e.g., sorting requires reading all rows before returning any)
- `total`: cost to produce all rows
- Cost units are arbitrary but consistent — by default 1.0 equals one sequential page read (`seq_page_cost`)

**Width:** average row width in bytes

### EXPLAIN ANALYZE (runs the query)

```sql
EXPLAIN ANALYZE
SELECT p.id, p.amount, p.status, a.holder_name
FROM   payments p
JOIN   accounts a ON a.id = p.source_account_id
WHERE  p.created_at >= NOW() - INTERVAL '7 days'
  AND  p.status = 'PENDING';
```

Output (abbreviated):

```
Hash Join  (cost=1842.55..9201.33 rows=4120 width=52)
           (actual time=38.212..412.831 rows=5891 loops=1)
  Hash Cond: (p.source_account_id = a.id)
  ->  Seq Scan on payments p  (cost=0.00..6945.20 rows=4120 width=36)
                               (actual time=0.041..389.342 rows=5891 loops=1)
        Filter: ((status = 'PENDING') AND (created_at >= ...))
        Rows Removed by Filter: 744108
  ->  Hash  (cost=1105.00..1105.00 rows=59004 width=24)
            (actual time=37.814..37.814 rows=59004 loops=1)
        Buckets: 65536  Batches: 1  Memory Usage: 3528kB
        ->  Seq Scan on accounts a  (cost=0.00..1105.00 rows=59004 width=24)
                                    (actual time=0.015..19.223 rows=59004 loops=1)
Planning Time: 1.231 ms
Execution Time: 413.904 ms
```

Key differences: `actual time` and `actual rows` let you compare estimates vs reality. A difference like 4,120 estimated vs 5,891 actual is normal. A large one (10x or more) points to stale statistics — or to correlated columns the planner treats as independent (fix those with `CREATE STATISTICS`). Note that `actual time` is in milliseconds and, for nodes with `loops > 1`, is per loop.

### EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT p.id, p.amount
FROM   payments p
WHERE  p.status = 'PENDING'
  AND  p.created_at >= NOW() - INTERVAL '7 days';
```

The `BUFFERS` option reveals cache behavior:

```json
{
  "Node Type": "Seq Scan",
  "Actual Rows": 5891,
  "Shared Hit Blocks": 342,
  "Shared Read Blocks": 6103,
  "Shared Dirtied Blocks": 0,
  "Shared Written Blocks": 0
}
```

- `Shared Hit Blocks`: pages served from `shared_buffers` (RAM) — fast
- `Shared Read Blocks`: pages read from disk (or OS cache) — slow
- A high read-to-hit ratio means your working set does not fit in `shared_buffers`

**FORMAT JSON** produces machine-readable output for tools such as [explain.dalibo.com](https://explain.dalibo.com) (accepts JSON or text) or your own scripts; [explain.depesz.com](https://explain.depesz.com) expects the text format.

---

## 2. Node Types Reference

```mermaid
graph TD
    A[Query] --> B{Join Strategy}
    B -->|small inner| C[Nested Loop]
    B -->|sorted inputs| D[Merge Join]
    B -->|large unsorted| E[Hash Join]
    A --> F{Scan Strategy}
    F -->|no index or low selectivity| G[Seq Scan]
    F -->|high selectivity + btree| H[Index Scan]
    F -->|medium selectivity| I[Bitmap Heap Scan]
    I --> J[Bitmap Index Scan]
    A --> K{Aggregation}
    K -->|group by with index| L[Index Scan + GroupAggregate]
    K -->|group by no index| M[HashAggregate]
```

### Seq Scan

Reads every page of the table sequentially. Fast for large result sets (roughly a few percent of the table or more, depending on row order and storage) because sequential I/O is efficient. The planner prefers it when:

- No suitable index exists
- The filter is not selective (most rows match)
- Table statistics suggest the index would read nearly as many pages as a seq scan

### Index Scan

Follows the B-tree index for each matching key, then fetches heap rows individually. Efficient for high selectivity (few rows). Can cause random I/O on large result sets.

### Bitmap Heap Scan

Two phases: first builds an in-memory bitmap of matching TIDs from the index (`Bitmap Index Scan`), then fetches heap pages in physical order. Efficient for medium selectivity — avoids random I/O by sorting page fetches.

```
Bitmap Heap Scan on payments  (cost=94.21..2871.45 rows=4120 width=36)
  Recheck Cond: (created_at >= (now() - '7 days'::interval))
  ->  Bitmap Index Scan on idx_payments_created_at
        Index Cond: (created_at >= (now() - '7 days'::interval))
```

### Hash Join

Build phase: reads the smaller table and builds a hash table in `work_mem`. Probe phase: reads the larger table and probes the hash. When the hash table does not fit in `work_mem`, it spills to disk (`Batches > 1`).

### Nested Loop

For each row in the outer relation, probe the inner relation. Efficient when the outer has few rows and the inner has an index. Disastrous when the outer has many rows without an index on the inner.

### Merge Join

Both inputs must be sorted on the join key. Efficient when inputs are already sorted (index scan) or when doing ORDER BY anyway.

---

## 3. When PostgreSQL Chooses a Seq Scan

The planner calculates the cost of each access path and chooses the cheapest. It chooses a seq scan over an index when:

1. **Low selectivity**: the filter matches a large fraction of rows. Reading heap pages randomly via an index costs more than a sequential scan when you need most of the pages anyway.

2. **Small table**: for tables that fit in a few pages, a seq scan is always cheaper.

3. **Stale statistics**: `n_distinct` or the histogram in `pg_stats` is out of date, causing the planner to underestimate or overestimate row counts.

4. **Cost misconfiguration**: `random_page_cost` is set too high relative to `seq_page_cost` (default 4.0 vs 1.0). On SSDs, `random_page_cost = 1.1` is more accurate.

```sql
-- How closely does the physical row order follow this column's order?
SELECT attname, correlation
FROM   pg_stats
WHERE  tablename = 'payments'
  AND  attname = 'created_at';
```

A correlation near 1.0 or -1.0 means the physical row order matches the index order — index scans are cheap. Near 0 means random I/O.

---

## 4. pg_stats — Column Statistics

PostgreSQL collects per-column statistics during `ANALYZE`. The `pg_stats` view exposes them:

```sql
SELECT
    attname,
    n_distinct,
    null_frac,
    avg_width,
    most_common_vals,
    most_common_freqs,
    histogram_bounds
FROM pg_stats
WHERE tablename = 'payments'
ORDER BY attname;
```

| Column | Meaning |
|---|---|
| `n_distinct` | Estimated number of distinct values. Negative = fraction of rows |
| `null_frac` | Fraction of rows that are NULL |
| `most_common_vals` | Top N values (default N=100, controlled by `default_statistics_target`) |
| `most_common_freqs` | Frequency of each most-common value |
| `histogram_bounds` | Bucket boundaries for non-common values |

Increasing statistics target for a selective column:

```sql
-- Increase statistics resolution for the status column
ALTER TABLE payments ALTER COLUMN status SET STATISTICS 500;
ANALYZE payments;
```

---

## 5. ANALYZE — Keeping Statistics Fresh

```sql
-- Analyze a single table immediately (non-blocking)
ANALYZE payments;

-- Analyze with verbose output
ANALYZE VERBOSE payments;

-- Check when a table was last analyzed
SELECT relname, last_analyze, last_autoanalyze, n_live_tup, n_dead_tup
FROM   pg_stat_user_tables
WHERE  relname = 'payments';
```

`autovacuum` runs `ANALYZE` automatically, but it can lag after:
- Bulk inserts (millions of rows inserted in one statement)
- Initial data loads
- Partitioned tables: autovacuum analyzes each partition, but never the partitioned parent itself — run `ANALYZE` on the parent manually (e.g. after loads) so queries over the whole table get good estimates

Trigger a manual analyze after every bulk load in your ETL pipelines.

---

## 6. work_mem Impact on Sort and Hash Operations

`work_mem` controls how much RAM a single sort or hash operation can use before spilling to disk. Each query can use multiple `work_mem` allocations simultaneously.

```sql
-- Check current setting
SHOW work_mem;

-- Set per-session for a large analytical query
SET work_mem = '256MB';

EXPLAIN (ANALYZE, BUFFERS)
SELECT account_id, SUM(amount) as total
FROM   payments
WHERE  created_at >= '2024-01-01'
GROUP  BY account_id
ORDER  BY total DESC;
```

**Without sufficient work_mem:**

```
Sort  (cost=98421.50..98673.50 rows=100800 width=16)
      (actual time=4821.332..5891.221 rows=100800 loops=1)
  Sort Key: (sum(amount)) DESC
  Sort Method: external merge  Disk: 3824kB    -- SPILLING TO DISK
```

**With sufficient work_mem:**

```
Sort  (cost=15421.50..15673.50 rows=100800 width=16)
      (actual time=312.441..381.223 rows=100800 loops=1)
  Sort Key: (sum(amount)) DESC
  Sort Method: quicksort  Memory: 10240kB    -- IN MEMORY
```

The `Sort Method: external merge Disk` line is the signal to increase `work_mem` for this query class. Never set `work_mem` globally too high — a connection executing 10 parallel nodes × 500 MB = 5 GB RAM consumed by one session.

---

## 7. pg_stat_statements — Identifying Slow Queries

```sql
-- Needs shared_preload_libraries = 'pg_stat_statements' (restart), then
-- once per database (as a superuser or a role allowed to create it):
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Find the top 10 slowest queries by total execution time
SELECT
    left(query, 120)                AS query_snippet,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    round(mean_exec_time::numeric, 2)  AS mean_ms,
    round(stddev_exec_time::numeric, 2) AS stddev_ms,
    rows
FROM   pg_stat_statements
ORDER  BY total_exec_time DESC
LIMIT  10;

-- Queries that are slow on average: candidates for EXPLAIN (ANALYZE)
-- (pg_stat_statements has no plan estimates -- compare estimated vs
--  actual rows in the plan itself, or log plans with auto_explain)
SELECT
    left(query, 120) AS query_snippet,
    calls,
    round(mean_exec_time::numeric, 2) AS mean_ms
FROM   pg_stat_statements
WHERE  mean_exec_time > 100
ORDER  BY mean_exec_time DESC;
```

Reset statistics after a schema or index change to get a clean baseline:

```sql
SELECT pg_stat_statements_reset();
```

---

## 8. auto_explain — Automatic Slow Query Logging

The `auto_explain` extension captures plans for slow queries without manual instrumentation:

```sql
-- In postgresql.conf or via ALTER SYSTEM:
-- shared_preload_libraries = 'auto_explain'
-- auto_explain.log_min_duration = 1000   -- log queries > 1 second
-- auto_explain.log_analyze = on
-- auto_explain.log_buffers = on
-- auto_explain.log_format = json

-- log_analyze adds timing overhead to EVERY query (not just logged ones);
-- auto_explain.log_timing = off keeps row counts but removes most of it

-- Enable per-session for testing (LOAD needs superuser)
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_analyze = true;
```

After enabling, slow query plans appear in the PostgreSQL log:

```
LOG:  duration: 1832.491 ms  plan:
{
  "Node Type": "Hash Join",
  "Total Cost": 9201.33,
  "Actual Total Time": 1831.22,
  ...
}
```

---

## 9. explain.depesz.com Format

Pasting output into [explain.depesz.com](https://explain.depesz.com) or [explain.dalibo.com](https://explain.dalibo.com) produces an interactive visualisation with colour-coded nodes highlighting the most expensive operations. For CI pipelines, capture the JSON format and check it with your own tooling. (pgBadger is a different tool: it analyses PostgreSQL *log files*, including plans logged by auto_explain.)

```bash
# Capture JSON plan to file
# -X: ignore .psqlrc  -A: unaligned  -t: rows only  -q: quiet
psql -XAtq -d fintech \
  -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ..." > plan.json
```

---

## 10. Real Example — Slow Payment History Query

### Before: table scan on 50M rows

```sql
-- Query: fetch last 90 days of payments for a customer portal
SELECT p.id, p.amount, p.status, p.created_at, a.holder_name
FROM   payments p
JOIN   accounts a ON a.id = p.source_account_id
WHERE  p.customer_id = 42001
  AND  p.created_at >= NOW() - INTERVAL '90 days'
ORDER  BY p.created_at DESC
LIMIT  100;
```

```
EXPLAIN (ANALYZE, BUFFERS):

Limit  (cost=89421.50..89421.75 rows=100 width=60)
       (actual time=14821.33..14821.42 rows=100 loops=1)
  ->  Sort  (cost=89421.50..89441.50 rows=8000 width=60)
            (actual time=14821.33..14821.38 rows=100 loops=1)
        Sort Key: p.created_at DESC
        Sort Method: top-N heapsort  Memory: 52kB
        ->  Hash Join  (cost=1842.55..89101.33 rows=8000 width=60)
                       (actual time=38.21..14801.22 rows=8213 loops=1)
              ->  Seq Scan on payments p
                  (actual time=0.04..14721.33 rows=8213 loops=1)
                  Filter: ((customer_id = 42001) AND (created_at >= ...))
                  Rows Removed by Filter: 49991787
              ->  Hash ... accounts a
```

Execution time: **14.8 seconds** (illustrative numbers). The seq scan reads all 50 million rows to find 8,213.

### Create the right index

```sql
-- Composite index: equality on customer_id, range + ORDER BY on created_at.
-- INCLUDE covers every other payments column the query reads (id, amount,
-- status, source_account_id), so an index-only scan is possible.
CREATE INDEX CONCURRENTLY idx_payments_customer_created
    ON payments (customer_id, created_at DESC)
    INCLUDE (id, amount, status, source_account_id);

-- VACUUM sets the visibility map, which index-only scans need to skip
-- heap visits; ANALYZE refreshes statistics
VACUUM (ANALYZE) payments;
```

### After: index scan

```
EXPLAIN (ANALYZE, BUFFERS):

Limit  (cost=0.99..412.21 rows=100 width=60)
       (actual time=0.142..1.891 rows=100 loops=1)
  ->  Nested Loop  (actual time=0.141..1.882 rows=100 loops=1)
        ->  Index Only Scan using idx_payments_customer_created on payments p
              (actual time=0.120..0.402 rows=100 loops=1)
              Index Cond: ((customer_id = 42001)
                           AND (created_at >= (now() - '90 days'::interval)))
              Heap Fetches: 0
        ->  Index Scan using accounts_pkey on accounts a
              (actual time=0.012..0.012 rows=1 loops=100)
              Index Cond: (id = p.source_account_id)
```

Execution time: **1.9 ms**. A ~7,800x improvement: the index returns rows already in `created_at DESC` order, so the scan stops after 100 rows — no sort, no full scan.

---

## 11. Production Pitfalls

### Pitfall 1 — Stale Statistics After Bulk Load

After a bulk import of historical payment data, the query planner still uses the old statistics and chooses a seq scan instead of an index scan.

```sql
-- BAD: Bulk load without updating statistics
INSERT INTO payments SELECT * FROM payments_staging;
-- Autovacuum has not caught up yet; planner uses stale row counts

-- GOOD: Always ANALYZE after a significant bulk operation
INSERT INTO payments SELECT * FROM payments_staging;
ANALYZE payments;  -- Run immediately after the load

-- For very large tables, check how far behind auto-analyze is.
-- Auto-analyze runs after autovacuum_analyze_threshold +
-- autovacuum_analyze_scale_factor * rows have changed (defaults: 50 + 10%)
SELECT relname, n_live_tup, n_mod_since_analyze, last_analyze, last_autoanalyze
FROM   pg_stat_user_tables
WHERE  relname = 'payments';

SHOW autovacuum_analyze_scale_factor;
SELECT reloptions FROM pg_class WHERE relname = 'payments';  -- per-table overrides
```

Practical rule: run `ANALYZE` explicitly in every ETL script that modifies more than 1% of a table's rows.

### Pitfall 2 — Low work_mem Forcing Disk Sorts

Month-end reconciliation reports scan millions of rows and sort them, but `work_mem` is set at the default 4 MB. The sort spills to disk repeatedly.

```sql
-- BAD: global work_mem too low, disk sorts in reconciliation report
-- postgresql.conf: work_mem = 4MB  (default)

-- Check if sorts/hashes are spilling: temp_blks_written counts temporary
-- file blocks written by a statement (set log_temp_files = 0 to log each)
SELECT left(query, 100) AS query, calls, temp_blks_written
FROM   pg_stat_statements
WHERE  temp_blks_written > 0
ORDER  BY temp_blks_written DESC
LIMIT  10;

-- GOOD: set work_mem at the transaction level for heavy analytical queries
BEGIN;
SET LOCAL work_mem = '512MB';

SELECT
    DATE_TRUNC('day', created_at) AS day,
    currency,
    SUM(amount)                   AS daily_volume,
    COUNT(*)                      AS tx_count
FROM   payments
WHERE  created_at >= '2024-01-01'
  AND  created_at <  '2024-02-01'
GROUP  BY 1, 2
ORDER  BY 1, 2;

COMMIT;
-- work_mem resets to global value after COMMIT/ROLLBACK
```

### Pitfall 3 — Unused Index Due to Type Mismatch

The column is `BIGINT`, but the application binds a `BigDecimal` (for example, a number parsed from JSON). PostgreSQL has no `bigint = numeric` operator that an index on the column can use, so it casts the **column** to `numeric` on every row — and the B-tree index on `customer_id` is useless.

```sql
-- Table definition
CREATE TABLE payments (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL,
    ...
);
CREATE INDEX idx_payments_customer ON payments (customer_id);

-- BAD: numeric parameter -- the column is cast, index cannot be used
EXPLAIN SELECT * FROM payments WHERE customer_id = 42001::numeric;
-- -> Seq Scan  Filter: ((customer_id)::numeric = '42001'::numeric)

-- GOOD: same type as the column
EXPLAIN SELECT * FROM payments WHERE customer_id = 42001;
-- -> Index Scan using idx_payments_customer

-- In Java (Spring JDBC / JPA), always bind the column's Java type:
// BAD (binds as numeric)
jdbcTemplate.queryForList(
    "SELECT * FROM payments WHERE customer_id = ?",
    new BigDecimal("42001"));

// GOOD (binds as bigint)
jdbcTemplate.queryForList(
    "SELECT * FROM payments WHERE customer_id = ?",
    42001L);
```

(The reverse — comparing a `VARCHAR` column with an integer — does not silently degrade: PostgreSQL rejects it with `operator does not exist: character varying = integer`.) The same problem appears when a query wraps the column in a function, e.g. `WHERE date(created_at) = ...` or `lower(email) = ...`: either rewrite the condition as a range on the bare column, or create an expression index.


## 12. Query Plan Analysis Checklist

- [ ] Run `EXPLAIN (ANALYZE, BUFFERS)` — never deploy without seeing the actual plan
- [ ] Check `actual rows` vs `rows` (estimate) — a 10x+ discrepancy means stale stats
- [ ] Look for `Seq Scan` on large tables — verify the filter selectivity justifies it
- [ ] Look for `Sort Method: external merge Disk` — increase `work_mem` for the query
- [ ] Check `Shared Read Blocks` — high values mean cache miss, check `shared_buffers`
- [ ] Look for `Rows Removed by Filter` after a scan — may need a better index
- [ ] Look for `Batches: N > 1` in Hash Join — hash table spilling to disk
- [ ] Run `ANALYZE` after any bulk load
- [ ] Check `pg_stat_statements` weekly for new slow query patterns
- [ ] Set `random_page_cost = 1.1` on SSD-backed instances
- [ ] Use `CONCURRENTLY` when creating indexes on live tables
- [ ] Verify index is being used after creation (`EXPLAIN` again)
- [ ] For type-cast issues: ensure the application binds the same type as the column, and avoid functions on indexed columns

---

<!-- KNOWLEDGE-CHECK
{"questions": [{"text": "In an EXPLAIN ANALYZE output, the node shows cost=100..5000 rows=200 and actual time=50..8000 actual rows=12000. What does this indicate?", "options": ["The query ran faster than estimated", "Statistics are stale — the planner severely underestimated row count", "The index is being used correctly", "work_mem needs to be reduced"], "correct": 1, "explanation": "When actual rows (12000) far exceed estimated rows (200), the planner worked with wrong cardinality estimates. The usual cause is stale statistics — run ANALYZE. If the estimate stays wrong after ANALYZE, look for correlated predicates (fix with CREATE STATISTICS) or a too-small statistics target."}, {"text": "A Hash Join node shows Batches: 8. What is the most effective way to fix this?", "options": ["Add an index on the join column", "Increase work_mem for this query session", "Run VACUUM ANALYZE", "Change the join to a Nested Loop"], "correct": 1, "explanation": "Batches > 1 means the hash table did not fit in memory (work_mem × hash_mem_multiplier) and was split into batches written to temporary files. Raising work_mem for this query (SET LOCAL work_mem = '256MB' inside the transaction) lets it stay in memory and removes that disk I/O."}, {"text": "An index exists on payments(customer_id BIGINT), but EXPLAIN shows a Seq Scan with Filter: ((customer_id)::numeric = '42'::numeric). What is the root cause?", "options": ["The index is corrupt and needs REINDEX", "The table statistics are stale", "The application binds a numeric value (e.g. a Java BigDecimal) instead of a long, so PostgreSQL casts the column to numeric on every row and cannot use the index", "The index needs to be a GIN index instead of B-tree"], "correct": 2, "explanation": "An index on customer_id can only be used when the condition compares the bare column with a value of a compatible type. With a numeric parameter, PostgreSQL casts the column, (customer_id)::numeric, for every row, which defeats the B-tree index. Fix it by binding the column's type (a Long / bigint): WHERE customer_id = 42."}]}
-->

<!-- PRACTICAL-CHALLENGE
{"title": "Diagnose and Fix a Slow Payment History Query", "difficulty": "advanced", "estimatedMinutes": 60, "tasks": [{"id": "1", "description": "Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the payment history query: SELECT p.id, p.amount, p.status, p.created_at FROM payments p WHERE p.customer_id = ? AND p.created_at >= NOW() - INTERVAL '90 days' ORDER BY p.created_at DESC LIMIT 100. Identify and document: the scan type, actual vs estimated rows, whether disk spill is occurring, and cache hit ratio."}, {"id": "2", "description": "Create a composite index on payments(customer_id, created_at DESC) INCLUDE (id, amount, status) using CONCURRENTLY. Run VACUUM (ANALYZE) payments. Re-run the EXPLAIN and confirm the plan changes from Seq Scan to an Index Only Scan with Heap Fetches close to 0. Record the execution time before and after."}, {"id": "3", "description": "Write a SQL query against pg_stat_statements to find the top 5 queries by mean execution time where mean_exec_time > 50ms. For each, identify whether the slowness is likely due to missing index, stale stats, or low work_mem based on the plan."}, {"id": "4", "description": "Simulate a stale-statistics pitfall: INSERT 500,000 rows into a test payments table in one statement without running ANALYZE. Run EXPLAIN ANALYZE on a selective query and observe the row count discrepancy. Then run ANALYZE and re-run the plan. Document the difference in estimated vs actual rows and the resulting change in execution plan."}]}
-->
