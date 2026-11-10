---
id: track-10-lesson-13
title: "Time-Series Data — TimescaleDB and Hypertables"
slug: time-series-data
track: track-10
trackName: "Database & Data Architecture"
sequence: 13
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [time-series, TimescaleDB, hypertable, compression, continuous-aggregate]
prerequisites: [track-10-lesson-06, track-10-lesson-01]
---

# Time-Series Data — TimescaleDB and Hypertables

> [!NOTE]
> Financial systems generate enormous volumes of time-ordered data: transaction rates, balance snapshots, fraud scores, exchange rates, and market data. TimescaleDB transforms PostgreSQL into a first-class time-series engine without abandoning SQL, ACID, or your existing toolchain. The key concept is the hypertable: a partitioned structure that makes time-range queries blindingly fast while keeping aggregation simple.

## The Time-Series Problem in Financial Services

Consider the operational data a mid-sized payment processor generates:
- **Transaction events**: 50,000 authorisation attempts per second at peak
- **Balance snapshots**: account balance recorded after every debit/credit
- **Fraud score timelines**: ML model scores for every transaction attempt
- **Exchange rate ticks**: FX rates sampled every second for 200+ currency pairs
- **Settlement position**: real-time net position per counterparty, per currency
- **System metrics**: latency percentiles, error rates, queue depths per service

These workloads share a critical pattern: data is always written with a timestamp, and queries almost always filter by time range. A vanilla PostgreSQL table with 5 billion rows and no time-based partitioning will perform sequential scans or use B-tree indexes with high fan-out, producing multi-second queries for what should be millisecond lookups.

TimescaleDB solves this by automatically partitioning data into time-based "chunks" so that a query covering the last 7 days touches only the relevant chunks, not the entire dataset. It also adds native columnar compression, continuous aggregates, and data retention policies — all as SQL extensions.

---

## TimescaleDB Architecture

TimescaleDB is a PostgreSQL extension (not a fork). You install it into an existing PostgreSQL instance and it adds:

1. **Hypertable**: the user-facing table abstraction that is transparently partitioned by time
2. **Chunks**: the actual physical sub-tables, one per time interval (e.g., one per day)
3. **Chunk exclusion**: the query planner skips chunks whose time range cannot satisfy the WHERE clause
4. **Chunk compression**: individual chunks can be compressed after they age out of the hot write window
5. **Continuous aggregates**: materialised views that are automatically incrementally refreshed
6. **Data retention policies**: background jobs that drop old chunks

```sql
-- Install the extension (once per database)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Verify installation
SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';

-- Check TimescaleDB version and license
SELECT * FROM timescaledb_information.edition;
```

---

## Creating Hypertables

The workflow is: create a regular PostgreSQL table, then convert it to a hypertable.

```sql
-- Step 1: Create a standard PostgreSQL table
CREATE TABLE transaction_metrics (
    captured_at         TIMESTAMPTZ NOT NULL,
    tenant_id           UUID        NOT NULL,
    payment_method      TEXT        NOT NULL,
    currency_code       CHAR(3)     NOT NULL,
    transaction_count   BIGINT      NOT NULL DEFAULT 0,
    amount_sum_minor    BIGINT      NOT NULL DEFAULT 0,
    amount_avg_minor    NUMERIC(18,2),
    success_count       BIGINT      NOT NULL DEFAULT 0,
    failure_count       BIGINT      NOT NULL DEFAULT 0,
    avg_latency_ms      NUMERIC(10,2),
    p99_latency_ms      NUMERIC(10,2)
);

-- Step 2: Convert to hypertable, partitioned by captured_at
-- chunk_time_interval: each chunk covers this duration
-- TimescaleDB will create one physical sub-table per interval
SELECT create_hypertable(
    'transaction_metrics',
    'captured_at',
    chunk_time_interval => INTERVAL '1 day'
);

-- Verify the hypertable was created
SELECT
    hypertable_name,
    num_chunks,
    num_dimensions
FROM timescaledb_information.hypertables;
```

### Chunk Interval Selection

Choosing the right chunk interval is critical for performance. The goal is chunks that are:
- Large enough to avoid too many chunks (planner overhead)
- Small enough that recent chunks fit in memory (cache effectiveness)

| Write Rate | Data Retention | Recommended Chunk Interval |
|---|---|---|
| < 1,000 rows/sec | 1 year | 1 week |
| 1,000–10,000 rows/sec | 90 days | 1 day |
| 10,000–100,000 rows/sec | 30 days | 1 hour or 6 hours |
| > 100,000 rows/sec | 7 days | 15 minutes or 1 hour |

**Rule of thumb**: the most recent 2–4 chunks should fit in your shared_buffers. For a table with 10 GB/day of data and 16 GB shared_buffers, a 1-day chunk interval is appropriate.

```sql
-- Check current chunk sizes
SELECT
    chunk_name,
    chunk_tablespace,
    range_start,
    range_end,
    pg_size_pretty(total_bytes) AS total_size,
    pg_size_pretty(table_bytes) AS table_size,
    pg_size_pretty(index_bytes) AS index_size
FROM timescaledb_information.chunks
WHERE hypertable_name = 'transaction_metrics'
ORDER BY range_start DESC
LIMIT 10;

-- Change chunk interval for new chunks (does not affect existing chunks)
SELECT set_chunk_time_interval('transaction_metrics', INTERVAL '6 hours');
```

---

## Indexes on Hypertables

Indexes are defined on the hypertable and automatically propagated to every new chunk.

```sql
-- Primary key must include the time column (TimescaleDB requirement)
CREATE TABLE account_balances (
    recorded_at     TIMESTAMPTZ NOT NULL,
    account_id      UUID        NOT NULL,
    balance_minor   BIGINT      NOT NULL,
    currency_code   CHAR(3)     NOT NULL,
    ledger_version  BIGINT      NOT NULL,
    PRIMARY KEY (recorded_at, account_id)
);

SELECT create_hypertable('account_balances', 'recorded_at',
    chunk_time_interval => INTERVAL '1 day');

-- Index on account_id for single-account queries
CREATE INDEX idx_account_balances_account
    ON account_balances (account_id, recorded_at DESC);

-- TimescaleDB automatically creates one equivalent index per chunk
-- Query the index usage per chunk
SELECT
    chunk_name,
    index_name,
    pg_size_pretty(pg_relation_size(format('%s.%s', chunk_schema, chunk_name)::regclass)) AS chunk_size
FROM timescaledb_information.chunks
WHERE hypertable_name = 'account_balances'
ORDER BY range_start DESC;
```

---

## Native Compression

TimescaleDB compression converts row-oriented chunk storage to a columnar format, achieving 60–90% space savings. Compressed chunks are immutable: you can read them but not perform standard DML. They are ideal for data older than the write window.

```sql
-- Enable compression on the hypertable
-- orderby: controls the sort order within compressed segments
-- segmentby: creates one segment per unique value (like a partition within a chunk)
ALTER TABLE transaction_metrics
    SET (
        timescaledb.compress,
        timescaledb.compress_orderby = 'captured_at DESC',
        timescaledb.compress_segmentby = 'tenant_id, payment_method'
    );

-- Manual compression: compress a specific chunk
SELECT compress_chunk(
    show_chunks('transaction_metrics', older_than => INTERVAL '7 days')
);

-- Automate compression via a policy: compress chunks older than 7 days
SELECT add_compression_policy('transaction_metrics', INTERVAL '7 days');

-- Check compression ratios
SELECT
    chunk_name,
    before_compression_total_bytes,
    after_compression_total_bytes,
    ROUND(
        100.0 * (before_compression_total_bytes - after_compression_total_bytes)
            / NULLIF(before_compression_total_bytes, 0),
        1
    ) AS compression_pct
FROM chunk_compression_stats('transaction_metrics')
ORDER BY chunk_name DESC;

-- Decompress a chunk if you need to backfill or delete specific rows
SELECT decompress_chunk('<chunk_schema>.<chunk_name>');
```

### Compression Internals

TimescaleDB compression works by:
1. Grouping rows by the `segmentby` columns (e.g., one segment per `tenant_id, payment_method` combination)
2. Within each segment, sorting by `orderby` column
3. Using array-based columnar storage with per-column delta encoding and dictionary compression
4. Storing multiple original rows in a single physical row in the compressed chunk

This is why `segmentby` cardinality matters: too many segments (e.g., segmenting by `payment_id`) produces tiny segments with no compression benefit. Segment by dimensions you filter on in queries; that also allows the decompressor to skip segments that don't match the WHERE clause.

---

## Continuous Aggregates

Continuous aggregates are materialised views that TimescaleDB incrementally maintains as new data arrives. They are the primary tool for pre-computing rollups — hourly totals, daily summaries, moving averages.

```sql
-- Create a continuous aggregate: 1-hour rollup of transaction metrics
CREATE MATERIALIZED VIEW transaction_metrics_1h
    WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', captured_at) AS hour,
    tenant_id,
    payment_method,
    currency_code,
    SUM(transaction_count)             AS transaction_count,
    SUM(amount_sum_minor)              AS amount_sum_minor,
    SUM(success_count)                 AS success_count,
    SUM(failure_count)                 AS failure_count,
    AVG(avg_latency_ms)                AS avg_latency_ms,
    MAX(p99_latency_ms)                AS max_p99_latency_ms
FROM transaction_metrics
GROUP BY hour, tenant_id, payment_method, currency_code
WITH NO DATA;  -- don't populate immediately; let the policy do it

-- Add a refresh policy: refresh hourly, covering the last 2 hours
SELECT add_continuous_aggregate_policy('transaction_metrics_1h',
    start_offset => INTERVAL '2 hours',
    end_offset   => INTERVAL '1 minute',  -- leave the last minute for data to arrive
    schedule_interval => INTERVAL '1 hour'
);

-- Enable real-time aggregation: queries include non-materialised data automatically
ALTER MATERIALIZED VIEW transaction_metrics_1h
    SET (timescaledb.materialized_only = false);

-- Manually refresh if needed (e.g., backfill)
CALL refresh_continuous_aggregate(
    'transaction_metrics_1h',
    '2024-01-01',
    '2024-01-31'
);
```

### Hierarchical Continuous Aggregates (Cascaded)

TimescaleDB 2.9+ supports creating continuous aggregates on top of other continuous aggregates, eliminating recomputation from raw data.

```sql
-- Daily rollup built on top of the hourly rollup
CREATE MATERIALIZED VIEW transaction_metrics_1d
    WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', hour) AS day,
    tenant_id,
    payment_method,
    currency_code,
    SUM(transaction_count)      AS transaction_count,
    SUM(amount_sum_minor)       AS amount_sum_minor,
    SUM(success_count)          AS success_count,
    SUM(failure_count)          AS failure_count,
    AVG(avg_latency_ms)         AS avg_latency_ms
FROM transaction_metrics_1h
GROUP BY day, tenant_id, payment_method, currency_code
WITH NO DATA;

SELECT add_continuous_aggregate_policy('transaction_metrics_1d',
    start_offset      => INTERVAL '2 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 day'
);
```

---

## Data Retention Policies

Financial regulations require data retention (typically 7 years for transaction records), but operational databases should not hold all 7 years online. Retention policies drop old chunks automatically.

```sql
-- Drop chunks older than 90 days (operational retention; archival handled separately)
SELECT add_retention_policy('transaction_metrics', INTERVAL '90 days');

-- View all policies
SELECT * FROM timescaledb_information.jobs
WHERE proc_name IN (
    'policy_compression',
    'policy_retention',
    'policy_refresh_continuous_aggregate'
)
ORDER BY hypertable_name;

-- Run a job manually (e.g., to test)
SELECT run_job(1001);  -- job_id from timescaledb_information.jobs

-- Show upcoming job runs
SELECT
    job_id,
    proc_name,
    hypertable_name,
    schedule_interval,
    next_start
FROM timescaledb_information.job_stats
ORDER BY next_start;
```

---

## time_bucket() Function

`time_bucket()` is TimescaleDB's equivalent of `DATE_TRUNC` but with arbitrary interval support and optional offsets. It is the core aggregation function for time-series analysis.

```sql
-- Standard time buckets
SELECT
    time_bucket('5 minutes', captured_at) AS bucket,
    SUM(transaction_count) AS txn_count,
    AVG(avg_latency_ms) AS avg_latency
FROM transaction_metrics
WHERE captured_at > NOW() - INTERVAL '1 hour'
GROUP BY bucket
ORDER BY bucket;

-- Weekly buckets aligned to Monday (not the Unix epoch)
SELECT
    time_bucket('1 week', recorded_at, '2024-01-01'::TIMESTAMPTZ) AS week,
    SUM(amount_sum_minor) AS weekly_volume
FROM transaction_metrics
GROUP BY week
ORDER BY week;

-- time_bucket_gapfill: fills missing buckets with NULL or interpolated values
-- Requires TimescaleDB; essential for complete time-series in dashboards
SELECT
    time_bucket_gapfill('1 hour', captured_at) AS hour,
    tenant_id,
    COALESCE(SUM(transaction_count), 0) AS txn_count,
    interpolate(AVG(avg_latency_ms))    AS avg_latency_interpolated
FROM transaction_metrics
WHERE captured_at BETWEEN '2024-01-15 00:00:00+00' AND '2024-01-15 23:59:59+00'
  AND tenant_id = 'some-tenant-uuid'
GROUP BY hour, tenant_id
ORDER BY hour;
```

---

## Use Cases: Transaction Rates, Balance History, Fraud Scores

### Transaction Rate Monitoring

```sql
-- Real-time transaction rate table (written every second by aggregation job)
CREATE TABLE txn_rate_seconds (
    ts              TIMESTAMPTZ NOT NULL,
    region          TEXT NOT NULL,
    tps             NUMERIC(10, 2) NOT NULL,
    error_rate_pct  NUMERIC(5, 2) NOT NULL
);

SELECT create_hypertable('txn_rate_seconds', 'ts',
    chunk_time_interval => INTERVAL '1 hour');

-- Enable compression for data older than 1 hour
ALTER TABLE txn_rate_seconds
    SET (
        timescaledb.compress,
        timescaledb.compress_orderby = 'ts DESC',
        timescaledb.compress_segmentby = 'region'
    );
SELECT add_compression_policy('txn_rate_seconds', INTERVAL '1 hour');

-- Dashboard query: 5-minute TPS trend for the last 2 hours
SELECT
    time_bucket('5 minutes', ts) AS bucket,
    region,
    AVG(tps)           AS avg_tps,
    MAX(tps)           AS peak_tps,
    AVG(error_rate_pct) AS avg_error_rate
FROM txn_rate_seconds
WHERE ts > NOW() - INTERVAL '2 hours'
GROUP BY bucket, region
ORDER BY bucket, region;
```

### Balance History

```sql
CREATE TABLE account_balance_history (
    recorded_at     TIMESTAMPTZ NOT NULL,
    account_id      UUID        NOT NULL,
    balance_minor   BIGINT      NOT NULL,
    ledger_entry_id UUID        NOT NULL REFERENCES ledger_entries(id)
);

SELECT create_hypertable('account_balance_history', 'recorded_at',
    chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_balance_history_account
    ON account_balance_history (account_id, recorded_at DESC);

-- Point-in-time balance for a single account
SELECT balance_minor
FROM account_balance_history
WHERE account_id = :account_id
  AND recorded_at <= :as_of_time
ORDER BY recorded_at DESC
LIMIT 1;

-- Daily closing balance for the last 30 days
SELECT DISTINCT ON (day, account_id)
    DATE_TRUNC('day', recorded_at) AS day,
    account_id,
    balance_minor AS closing_balance
FROM account_balance_history
WHERE account_id = :account_id
  AND recorded_at >= NOW() - INTERVAL '30 days'
ORDER BY day, account_id, recorded_at DESC;

-- Balance trend for a customer across all accounts
SELECT
    time_bucket('1 day', recorded_at) AS day,
    SUM(balance_minor)                AS total_balance
FROM account_balance_history
WHERE account_id = ANY(:account_ids)
  AND recorded_at >= NOW() - INTERVAL '90 days'
GROUP BY day
ORDER BY day;
```

### Fraud Scores Over Time

```sql
CREATE TABLE fraud_score_history (
    scored_at       TIMESTAMPTZ NOT NULL,
    transaction_id  UUID        NOT NULL,
    model_version   TEXT        NOT NULL,
    fraud_score     NUMERIC(5, 4) NOT NULL CHECK (fraud_score BETWEEN 0 AND 1),
    feature_hash    TEXT,
    decision        TEXT        NOT NULL  -- APPROVE / REVIEW / DECLINE
);

SELECT create_hypertable('fraud_score_history', 'scored_at',
    chunk_time_interval => INTERVAL '1 day');

-- Fraud score distribution per model version over the last 7 days
SELECT
    time_bucket('1 hour', scored_at) AS hour,
    model_version,
    COUNT(*)                         AS score_count,
    AVG(fraud_score)                 AS avg_score,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fraud_score) AS median_score,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY fraud_score) AS p95_score,
    COUNT(*) FILTER (WHERE decision = 'DECLINE') AS decline_count
FROM fraud_score_history
WHERE scored_at > NOW() - INTERVAL '7 days'
GROUP BY hour, model_version
ORDER BY hour, model_version;

-- Model drift detection: compare score distributions across versions
SELECT
    model_version,
    AVG(fraud_score)         AS avg_score,
    STDDEV(fraud_score)      AS score_stddev,
    COUNT(*) FILTER (WHERE decision = 'DECLINE')::FLOAT / COUNT(*) AS decline_rate
FROM fraud_score_history
WHERE scored_at > NOW() - INTERVAL '24 hours'
GROUP BY model_version;
```

---

## Comparison with Vanilla PostgreSQL Partitioning

TimescaleDB builds on PostgreSQL declarative partitioning. Understanding the differences helps you justify the extension or avoid it when it is not needed.

| Feature | Vanilla PostgreSQL Partitioning | TimescaleDB Hypertable |
|---|---|---|
| Partition creation | Manual (`CREATE TABLE ... PARTITION OF`) | Automatic when new time interval starts |
| Chunk exclusion | Built-in constraint exclusion | Same, plus optimised planner hooks |
| Compression | None (requires pg_partman + custom) | Native columnar compression |
| Continuous aggregates | Manual materialised views | Automatic incremental refresh |
| Retention policies | Manual cron job or pg_partman | Built-in background worker |
| Indexes per partition | Separate DDL per partition | Automatically propagated from hypertable |
| Monitoring | pg_stat_user_tables per partition | timescaledb_information views |
| Space queries | Manual SUM across partitions | Built-in hypertable_size() |

**When to skip TimescaleDB**:
- Table has < 50 million rows and < 1 year retention — vanilla partitioning suffices
- You cannot install extensions (managed database services without extension support)
- Write rate is < 100 rows/sec — overhead is not justified

**When TimescaleDB is mandatory**:
- Table has > 1 billion rows or > 100 GB
- You need compression without migrating to a different system
- You need continuous aggregates that stay fresh automatically
- Write rate is > 10,000 rows/sec

---

## Java Integration with Spring Boot

```java
@Entity
@Table(name = "transaction_metrics")
public class TransactionMetric {

    @Id
    @Column(name = "captured_at")
    private Instant capturedAt;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "payment_method", nullable = false)
    private String paymentMethod;

    @Column(name = "currency_code", nullable = false)
    private String currencyCode;

    @Column(name = "transaction_count")
    private Long transactionCount;

    @Column(name = "amount_sum_minor")
    private Long amountSumMinor;

    @Column(name = "avg_latency_ms")
    private BigDecimal avgLatencyMs;

    @Column(name = "p99_latency_ms")
    private BigDecimal p99LatencyMs;
}

@Repository
public interface TransactionMetricRepository extends JpaRepository<TransactionMetric, Instant> {

    // Hourly aggregation query using continuous aggregate view
    @Query(value = """
        SELECT
            time_bucket('1 hour', captured_at) AS hour,
            SUM(transaction_count)             AS transaction_count,
            SUM(amount_sum_minor)              AS amount_sum_minor,
            AVG(avg_latency_ms)                AS avg_latency_ms,
            MAX(p99_latency_ms)                AS max_p99_latency_ms
        FROM transaction_metrics
        WHERE tenant_id = :tenantId
          AND captured_at BETWEEN :from AND :to
        GROUP BY hour
        ORDER BY hour
        """, nativeQuery = true)
    List<Object[]> findHourlyMetrics(
        @Param("tenantId") UUID tenantId,
        @Param("from") Instant from,
        @Param("to") Instant to
    );
}

// Bulk insert service: use COPY or batch INSERT for high-throughput ingestion
@Service
@RequiredArgsConstructor
public class MetricsIngestionService {

    private final DataSource dataSource;

    // Batch insert via JDBC executeBatch for 10x throughput vs individual inserts
    public void bulkInsert(List<TransactionMetric> metrics) {
        String sql = """
            INSERT INTO transaction_metrics
                (captured_at, tenant_id, payment_method, currency_code,
                 transaction_count, amount_sum_minor, avg_latency_ms, p99_latency_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
            """;

        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {

            conn.setAutoCommit(false);
            for (TransactionMetric m : metrics) {
                ps.setObject(1, m.getCapturedAt());
                ps.setObject(2, m.getTenantId());
                ps.setString(3, m.getPaymentMethod());
                ps.setString(4, m.getCurrencyCode());
                ps.setLong(5, m.getTransactionCount());
                ps.setLong(6, m.getAmountSumMinor());
                ps.setBigDecimal(7, m.getAvgLatencyMs());
                ps.setBigDecimal(8, m.getP99LatencyMs());
                ps.addBatch();
            }
            ps.executeBatch();
            conn.commit();
        } catch (SQLException e) {
            throw new DataAccessException("Bulk insert failed", e) {};
        }
    }
}
```

---

## Monitoring TimescaleDB

```sql
-- Overall hypertable sizes
SELECT
    hypertable_name,
    pg_size_pretty(hypertable_size(format('%s', hypertable_name)::regclass)) AS total_size,
    num_chunks
FROM timescaledb_information.hypertables
ORDER BY hypertable_name;

-- Chunk details: identify large or uncompressed chunks
SELECT
    chunk_name,
    range_start,
    range_end,
    is_compressed,
    pg_size_pretty(total_bytes) AS total_size
FROM timescaledb_information.chunks
WHERE hypertable_name = 'transaction_metrics'
ORDER BY range_start DESC
LIMIT 20;

-- Background job health
SELECT
    job_id,
    proc_name,
    hypertable_name,
    last_run_status,
    last_run_duration,
    next_start
FROM timescaledb_information.job_stats
WHERE last_run_status != 'Success'
  OR next_start < NOW() - INTERVAL '1 hour';

-- Compression savings summary
SELECT
    hypertable_name,
    pg_size_pretty(SUM(before_compression_total_bytes)) AS before,
    pg_size_pretty(SUM(after_compression_total_bytes))  AS after,
    ROUND(
        100.0 * (1 - SUM(after_compression_total_bytes)::FLOAT
                     / NULLIF(SUM(before_compression_total_bytes), 0)),
        1
    ) AS savings_pct
FROM chunk_compression_stats('transaction_metrics')
GROUP BY hypertable_name;
```

---

## Key Takeaways

1. **Hypertable chunk interval** must match your write rate and working set size — target 2–4 recent chunks fitting in `shared_buffers`.
2. **Compression** is non-negotiable at scale: 60–90% space savings with no schema changes, using `compress_segmentby` aligned to your most common filter dimensions.
3. **Continuous aggregates** eliminate expensive real-time aggregation over raw data — build them at multiple granularities (1 min, 1 hour, 1 day) and query the coarsest one that meets precision requirements.
4. **Data retention policies** drop old chunks atomically and instantaneously (DROP TABLE semantics) — far faster than DELETE.
5. **`time_bucket_gapfill`** is essential for dashboard queries that need complete time series with no missing buckets.
6. **Bulk insert** using JDBC batch or COPY protocol — never insert time-series rows one at a time in a production ingestion path.
7. **Hierarchical continuous aggregates** (cascading) avoid recomputing hourly data from raw seconds data when building daily rollups.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A TimescaleDB hypertable stores payment events with chunk_time_interval = '1 day'. After 90 days the table holds 90 chunks. A query runs: SELECT * FROM payment_events WHERE event_time BETWEEN NOW() - INTERVAL '2 days' AND NOW(). How many chunks does PostgreSQL scan?",
      "options": ["All 90 chunks, because TimescaleDB does not support chunk exclusion", "2 chunks, because the planner uses chunk pruning to exclude irrelevant time ranges", "3 chunks, because an off-by-one boundary overlap causes one extra chunk to be included", "1 chunk, because TimescaleDB merges adjacent chunks at query time"],
      "correct": 1,
      "explanation": "TimescaleDB implements chunk exclusion (partition pruning) so the planner identifies and scans only the chunks whose time range overlaps the query predicate. A 2-day window intersects at most 2 daily chunks, making queries on recent data O(chunks_in_range) rather than O(total_chunks)."
    },
    {
      "text": "You have a continuous aggregate payment_hourly_stats that materialises hourly totals from raw payment_events. You now need a daily summary. What is the most efficient approach?",
      "options": ["Query payment_events directly and GROUP BY date_trunc('day', event_time)", "Create a second continuous aggregate on top of payment_hourly_stats using hierarchical (cascading) aggregates", "Create a second continuous aggregate reading directly from payment_events with a 1-day bucket", "Use a cron job that runs INSERT INTO payment_daily_stats SELECT ... FROM payment_events every midnight"],
      "correct": 1,
      "explanation": "Hierarchical continuous aggregates (cascading) allow a daily aggregate to materialise from the already-compressed hourly aggregate instead of re-scanning the raw table. This avoids redundant work: the hourly aggregate has already processed and compressed the raw rows. TimescaleDB 2.9+ supports this natively via CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) on top of an existing continuous aggregate."
    },
    {
      "text": "A TimescaleDB compression policy is set with compress_segmentby = 'account_id' and compress_orderby = 'event_time DESC'. A query filters on account_id = $1 AND event_time > NOW() - INTERVAL '30 days'. What performance characteristic does this configuration optimise?",
      "options": ["It minimises storage size regardless of query patterns by compressing all columns equally", "It enables segment-level pruning so only segments for the target account_id are decompressed, reducing I/O proportional to cardinality", "It sorts rows by event_time within each compressed segment allowing TimescaleDB to skip segments outside the time range even before decompression", "Both B and C: segment-level pruning on account_id and within-segment time ordering together minimise decompressed data for per-account time-range queries"],
      "correct": 3,
      "explanation": "compress_segmentby groups rows with the same account_id into the same compressed segment, so a query for a single account only decompresses that account's segment. compress_orderby stores rows in time order within each segment allowing further skipping of time ranges. Together they produce columnar-style predicate pushdown that minimises both I/O and CPU for the most common per-account time-range access pattern."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a TimescaleDB-Backed Payment Metrics Pipeline",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Create a TimescaleDB hypertable payment_events(event_time TIMESTAMPTZ NOT NULL, account_id UUID, merchant_id UUID, amount_cents BIGINT, currency CHAR(3), status TEXT, processor_response JSONB) with chunk_time_interval = '1 day'. Enable compression with compress_segmentby = 'account_id, merchant_id' and compress_orderby = 'event_time DESC'. Add a compression policy to compress chunks older than 7 days. Verify the setup with SELECT * FROM timescaledb_information.compression_settings."
    },
    {
      "id": "2",
      "description": "Create a continuous aggregate payment_hourly_stats materialising: time_bucket('1 hour', event_time) AS bucket, merchant_id, currency, COUNT(*) AS tx_count, SUM(amount_cents) AS total_cents, AVG(amount_cents) AS avg_cents, COUNT(*) FILTER (WHERE status = 'failed') AS failed_count. Set refresh_start = -2 hours and refresh_end = -1 hour in the refresh policy. Then create a hierarchical daily aggregate payment_daily_stats on top of the hourly one."
    },
    {
      "id": "3",
      "description": "Implement a Java PaymentMetricsRepository using Spring JDBC with two methods: (a) getHourlyMetrics(UUID merchantId, Instant from, Instant to) querying payment_hourly_stats, and (b) getDailyMetricsWithGapfill(UUID merchantId, LocalDate from, LocalDate to) using time_bucket_gapfill to return zero-filled rows for days with no transactions. Write an integration test using Testcontainers with the TimescaleDB Docker image (timescale/timescaledb:latest-pg15) verifying that gap-filled rows have tx_count = 0."
    },
    {
      "id": "4",
      "description": "Add a data retention policy that drops chunks older than 90 days. Implement a DataRetentionAuditService that queries timescaledb_information.chunks to list all chunks with range_end < NOW() - INTERVAL '90 days' and logs a WARNING if any exist (indicating the retention policy has not run). Schedule this service via @Scheduled(cron = '0 0 6 * * *'). Write a unit test that mocks the chunk query and verifies the warning is logged when stale chunks are present."
    }
  ]
}
-->
