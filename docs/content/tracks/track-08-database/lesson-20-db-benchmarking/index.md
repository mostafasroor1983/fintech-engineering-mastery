---
id: track-08-lesson-20
title: "Database Benchmarking — pgbench and Custom Workloads"
slug: db-benchmarking
track: track-08
trackName: "Database & Data Architecture"
sequence: 20
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [pgbench, benchmarking, TPS, workload-simulation, latency]
prerequisites: [track-08-lesson-01]
---

# Database Benchmarking — pgbench and Custom Workloads

> [!NOTE]
> Database benchmarking in fintech serves two purposes: establishing a performance baseline before optimizations and validating infrastructure choices (instance type, storage configuration, connection pool sizing). Without a production-representative baseline, you cannot quantify the impact of any change. Without a reproducible benchmark, you are guessing.

## 1. pgbench Built-In TPC-B Workload

pgbench's default workload simulates the TPC-B benchmark: a simplified banking transaction model with accounts, branches, tellers, and a history log.

```bash
# Initialize the benchmark schema
# -s = scale factor (1 = 100,000 accounts)
# A production-representative scale requires matching your actual account count
# For 10M accounts: -s 100

pgbench \
  --initialize \
  --scale=100 \
  --host=db.internal \
  --port=5432 \
  --username=benchmark_user \
  payments_benchmark

# Tables created:
# pgbench_accounts:  10,000,000 rows (100 * 100,000)
# pgbench_tellers:   1,000 rows
# pgbench_branches:  100 rows
# pgbench_history:   empty (append-only)
```

### Running the Benchmark

```bash
# Basic run: 100 clients, 4 threads, 60 seconds
pgbench \
  --client=100 \
  --jobs=4 \
  --time=60 \
  --progress=5 \
  --host=db.internal \
  --port=5432 \
  --username=benchmark_user \
  payments_benchmark

# Output interpretation:
# transaction type: TPC-B (sort of)
# scaling factor: 100
# number of clients: 100
# number of threads: 4
# duration: 60 s
# number of transactions actually processed: 95,423
# latency average = 62.880 ms
# latency stddev = 23.456 ms
# initial connection time = 456.789 ms
# tps = 1590.283333 (without initial connection time)
```

### Understanding TPS Output

```
TPS (Transactions Per Second) = number of transactions / test duration

The pgbench TPC-B default transaction:
  BEGIN;
  UPDATE pgbench_accounts SET abalance = abalance + :delta WHERE aid = :aid;
  SELECT abalance FROM pgbench_accounts WHERE aid = :aid;
  UPDATE pgbench_tellers SET tbalance = tbalance + :delta WHERE tid = :tid;
  UPDATE pgbench_branches SET bbalance = bbalance + :delta WHERE bid = :bid;
  INSERT INTO pgbench_history (tid, bid, aid, delta, mtime) VALUES (:tid,:bid,:aid,:delta,CURRENT_TIMESTAMP);
  END;

This models a debit/credit transaction with:
  - 3 UPDATE statements (account, teller, branch)
  - 1 SELECT statement
  - 1 INSERT statement
  - Explicit transaction boundary
```

## 2. Custom pgbench Scripts for Payment Workloads

The TPC-B default doesn't match a real payment workload. Write custom scripts.

pgbench's `random()` produces **integers**, but our `accounts.id` is a UUID — an integer cannot simply be cast to `uuid`. The scripts below therefore assume the benchmark data was seeded with deterministic ids, so that any number 1..N maps to an existing account:

```sql
-- Seed 10M accounts whose id is derived from the number n
INSERT INTO accounts (id, balance, currency, status, version)
SELECT md5(n::text)::uuid, 1000000, 'USD', 'ACTIVE', 0
FROM generate_series(1, 10000000) AS n;
```

### Script 1: Balance Lookup (Read-Heavy)

```sql
-- File: balance_lookup.sql
\set account_id random(1, 10000000)

SELECT
    id,
    balance,
    currency,
    status,
    version
FROM accounts
WHERE id = md5(:account_id::text)::uuid;
```

```bash
# Run balance lookup benchmark
pgbench \
  --client=200 \
  --jobs=8 \
  --time=120 \
  --file=balance_lookup.sql \
  --progress=10 \
  --host=db.internal \
  payments_benchmark
```

### Script 2: Transaction Debit (Write-Heavy)

```sql
-- File: debit_transaction.sql
\set account_id random(1, 10000000)
\set amount random(100, 10000)

BEGIN;

-- Check balance and version
SELECT balance, version
FROM accounts
WHERE id = md5(:account_id::text)::uuid
FOR UPDATE;

-- Record transaction
INSERT INTO transactions (
    account_id,
    amount,
    currency,
    status,
    type,
    idempotency_key,
    created_at
) VALUES (
    md5(:account_id::text)::uuid,
    (:amount / 100.0)::numeric,
    'USD',
    'PENDING',
    'DEBIT',
    gen_random_uuid()::text,
    NOW()
);

-- Update account balance
UPDATE accounts
SET
    balance = balance - (:amount / 100.0),
    version = version + 1,
    updated_at = NOW()
WHERE id = md5(:account_id::text)::uuid;

COMMIT;
```

### Script 3: Concurrent Transfer (Highest Contention)

```sql
-- File: transfer.sql
\set source_account random(1, 10000000)
\set target_account random(1, 10000000)
\set amount random(100, 5000)

BEGIN;

-- Lock both accounts in consistent order to avoid deadlock:
-- always lock the lower NUMBER first (pgbench expressions have least() /
-- greatest(); there is no ?: operator)
\set min_account least(:source_account, :target_account)
\set max_account greatest(:source_account, :target_account)

SELECT id, balance FROM accounts WHERE id = md5(:min_account::text)::uuid FOR UPDATE;
SELECT id, balance FROM accounts WHERE id = md5(:max_account::text)::uuid FOR UPDATE;

UPDATE accounts SET balance = balance - (:amount / 100.0)
WHERE id = md5(:source_account::text)::uuid;

UPDATE accounts SET balance = balance + (:amount / 100.0)
WHERE id = md5(:target_account::text)::uuid;

INSERT INTO transactions (account_id, amount, currency, status, type, created_at)
VALUES (md5(:source_account::text)::uuid, -(:amount / 100.0), 'USD', 'COMPLETED', 'TRANSFER', NOW());

INSERT INTO transactions (account_id, amount, currency, status, type, created_at)
VALUES (md5(:target_account::text)::uuid, (:amount / 100.0), 'USD', 'COMPLETED', 'TRANSFER', NOW());

COMMIT;
```

### Script 4: Mixed Workload (Realistic)

```bash
# pgbench picks one script per transaction, weighted: --file=script@weight
# Compose: 70% balance reads, 20% debits, 10% transfers

pgbench \
  --client=200 \
  --jobs=8 \
  --time=300 \
  --file=balance_lookup.sql@70 \
  --file=debit_transaction.sql@20 \
  --file=transfer.sql@10 \
  --progress=30 \
  payments_benchmark
```

## 3. pgbench Parameters — -c, -j, -T

| Parameter | Purpose | Rule of Thumb |
|---|---|---|
| `-c` / `--client` | Concurrent clients | Match peak concurrent application sessions |
| `-j` / `--jobs` | pgbench worker threads | Match CPU cores on the benchmark client machine |
| `-T` / `--time` | Duration in seconds | At least 5x the warmup period (usually 300s+) |
| `-n` / `--no-vacuum` | Skip VACUUM before test | Use for steady-state benchmarks |
| `-M` / `--protocol` | Query protocol | `prepared` to mimic apps using server-side prepared statements |
| `--log` | Log each transaction | Enable for latency distribution analysis (with `--sampling-rate` at high TPS) |
| `--aggregate-interval` | With `--log`: write one summary line per N seconds instead of one line per transaction | 10-30 seconds (use a separate run for per-transaction percentiles) |

```bash
# Production-like benchmark parameters
#   500 concurrent sessions, 8 worker threads on the benchmark machine,
#   10 minutes (long enough to include checkpoints), progress every 60 s,
#   prepared statements (like production), no VACUUM (already done),
#   per-transaction log for 10% of transactions (for percentiles)
pgbench \
  --client=500 \
  --jobs=8 \
  --time=600 \
  --progress=60 \
  --protocol=prepared \
  --no-vacuum \
  --log \
  --sampling-rate=0.1 \
  --file=payment_workload.sql \
  payments_benchmark

# Post-process the transaction log for percentiles
# (column 3 = transaction latency in microseconds)
awk '{print $3}' pgbench_log.* | sort -n | \
  awk 'BEGIN{count=0} {data[count++]=$1} END {
    p50=data[int(count*0.50)]; p95=data[int(count*0.95)]; p99=data[int(count*0.99)];
    printf "p50: %gms p95: %gms p99: %gms\n", p50/1000, p95/1000, p99/1000
  }'
```

## 4. Interpreting TPS/Latency Results

```
Example benchmark output (500 clients, 300 seconds, payment workload):

latency average = 48.234 ms
latency stddev = 31.567 ms
tps = 10,367 (without connection setup)

Interpreting:
  - Average 48ms: each payment transaction completes in 48ms on average
  - Stddev 31ms: high variance — some are very fast, some are slow
  - 10,367 TPS: system can sustain this throughput under load

High stddev relative to mean (31/48 = 64%) indicates:
  - Lock contention (some transactions wait for locks)
  - Variable I/O (some queries hit disk, most hit cache)
  - Checkpoint or autovacuum I/O spikes

For payment processing, care about:
  - p99 latency (what's the worst case a customer experiences?)
  - Throughput at p99 SLO (what TPS can we sustain while meeting SLA?)
```

```bash
# Compute percentiles from pgbench log
# per-transaction log format:
#   client_id transaction_no time_us script_no time_epoch time_us_part
sort -k3 -n pgbench_log.* > sorted_latencies.txt

TOTAL=$(wc -l < sorted_latencies.txt)
P50_LINE=$((TOTAL * 50 / 100))
P95_LINE=$((TOTAL * 95 / 100))
P99_LINE=$((TOTAL * 99 / 100))

P50=$(sed -n "${P50_LINE}p" sorted_latencies.txt | awk '{printf "%.2f", $3/1000}')
P95=$(sed -n "${P95_LINE}p" sorted_latencies.txt | awk '{printf "%.2f", $3/1000}')
P99=$(sed -n "${P99_LINE}p" sorted_latencies.txt | awk '{printf "%.2f", $3/1000}')

echo "P50: ${P50}ms  P95: ${P95}ms  P99: ${P99}ms"
```

## 5. pg_stat_statements for Workload Analysis

During a benchmark run, `pg_stat_statements` accumulates actual query statistics.

```sql
-- Reset statistics before the benchmark run
SELECT pg_stat_statements_reset();

-- Run your benchmark...

-- After the run: analyze what actually happened
SELECT
    LEFT(query, 100) AS query_preview,
    calls,
    ROUND(total_exec_time::numeric / 1000, 2) AS total_sec,
    ROUND(mean_exec_time::numeric, 2) AS mean_ms,
    ROUND(max_exec_time::numeric, 2) AS max_ms,
    rows / calls AS rows_per_call,
    shared_blks_hit,
    shared_blks_read,
    ROUND(100.0 * shared_blks_hit /
        NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
FROM pg_stat_statements
WHERE userid != (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
  AND calls > 100
ORDER BY total_exec_time DESC
LIMIT 20;
```

```sql
-- Analyze lock wait times during the benchmark
SELECT
    wait_event_type,
    wait_event,
    COUNT(*) AS occurrences
FROM pg_stat_activity
WHERE state != 'idle'
  AND wait_event IS NOT NULL
GROUP BY wait_event_type, wait_event
ORDER BY occurrences DESC;

-- Sample this every few seconds during the run (one snapshot proves little)
-- If 'Lock' wait events dominate: row/table lock contention is the bottleneck
-- If 'LWLock' (e.g. WALWrite, BufferMapping) dominates: internal contention
-- If 'IO' wait events dominate: I/O is the bottleneck (check indexes/shared_buffers)
-- Active sessions with wait_event IS NULL are running on CPU -- many of
-- them plus a saturated CPU means compute is the bottleneck
```

## 6. HammerDB for Mixed OLTP/OLAP

HammerDB supports TPC-C (more realistic than TPC-B) and TPC-H (analytical) workloads.

```tcl
# HammerDB TCL script for TPC-C on PostgreSQL
dbset db pg
dbset bm TPC-C

# Configure connection
diset connection pg_host db.internal
diset connection pg_port 5432
diset connection pg_sslmode prefer

# Configure workload
diset tpcc pg_count_ware 100   # warehouses (scale factor)
diset tpcc pg_num_vu 8         # virtual users used to BUILD the schema
diset tpcc pg_driver timed     # timed test with rampup + duration
diset tpcc pg_rampup 2         # 2 minutes warmup
diset tpcc pg_duration 10      # 10 minutes test

# Build, then run with 50 virtual users
buildschema
loadscript
vuset vu 50
vuset logtotemp 1
tcstart
vucreate
vurun
vudestroy
tcstop
```

TPC-C simulates a wholesale supplier with 5 transaction types: New Order, Payment, Order Status, Delivery, and Stock Level. Its mix is richer than TPC-B, which makes it useful for comparing hardware and configurations — but it is still not your workload, so custom scripts that mirror your real queries matter most.

## 7. Baseline Benchmarks Before Optimization

```bash
#!/bin/bash
# baseline_benchmark.sh — Run before any optimization, record results

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_FILE="benchmarks/baseline_${TIMESTAMP}.json"
mkdir -p benchmarks

# Run benchmark
pgbench \
  --client=200 \
  --jobs=4 \
  --time=300 \
  --file=payment_workload.sql \
  payments_benchmark 2>&1 | tee "benchmarks/pgbench_${TIMESTAMP}.log"

# Parse results
TPS=$(grep "^tps" "benchmarks/pgbench_${TIMESTAMP}.log" | awk '{print $3}')
# "latency average = 48.234 ms" -> the number is field 4
AVG_LAT=$(grep "latency average" "benchmarks/pgbench_${TIMESTAMP}.log" | awk '{print $4}')
STDDEV_LAT=$(grep "latency stddev" "benchmarks/pgbench_${TIMESTAMP}.log" | awk '{print $4}')

# Save structured results
cat > "${RESULTS_FILE}" << EOF
{
  "timestamp": "${TIMESTAMP}",
  "test": "payment_workload_200c_300s",
  "tps": ${TPS},
  "avg_latency_ms": ${AVG_LAT},
  "stddev_latency_ms": ${STDDEV_LAT},
  "environment": {
    "_comment": "record the REAL values of the system under test",
    "db_instance": "db.r6g.2xlarge",
    "storage": "io1 20000 IOPS",
    "shared_buffers_gb": 8,
    "max_connections": 200
  }
}
EOF

echo "Baseline recorded: ${RESULTS_FILE}"
```

## 8. Benchmarking Scenarios for Payment Services

```bash
# Scenario 1: Balance check under high read concurrency
# Models: 1000 customers checking balance simultaneously
pgbench -c 1000 -j 8 -T 120 -f balance_lookup.sql payments_benchmark
# Example target: > 50,000 TPS (primary-key lookups, mostly cached)
# (1000 direct connections need max_connections >= 1000 -- or put
#  PgBouncer in front, as production would)
# All "expected" numbers here are example targets: they depend entirely
# on hardware, data size and configuration

# Scenario 2: Payment authorization (debit + write)
# Models: 200 concurrent payment authorizations
pgbench -c 200 -j 4 -T 300 -f debit_transaction.sql payments_benchmark
# Expected: > 2,000 TPS (limited by write throughput + WAL)

# Scenario 3: Concurrent transfers (high contention)
# Models: 50 concurrent inter-account transfers
pgbench -c 50 -j 2 -T 300 -f transfer.sql payments_benchmark
# Expected: > 500 TPS (limited by lock contention)

# Scenario 4: Settlement aggregation (analytical)
# Models: 10 concurrent settlement queries (settlement_query.sql = your
# own reporting query)
pgbench -c 10 -j 2 -T 60 -f settlement_query.sql payments_benchmark
# Expected: > 10 queries/second (each query < 1 second with partitioning)
```

## 9. Java Integration — Benchmark Validation in CI

```java
@SpringBootTest
@Tag("performance-benchmark")
@Slf4j
class DatabaseBenchmarkTest {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AccountRepository accountRepository;

    private static final int WARMUP_ITERATIONS = 1000;
    private static final int BENCHMARK_ITERATIONS = 10_000;

    private List<UUID> sampleIds;

    @BeforeEach
    void loadSampleIds() {
        // Pick test ids ONCE, outside the measurement. (A per-iteration
        // "ORDER BY random() LIMIT 1" sorts the whole table every time and
        // would dominate the numbers.)
        sampleIds = jdbcTemplate.queryForList(
            "SELECT id FROM accounts TABLESAMPLE SYSTEM (1) LIMIT 5000", UUID.class);
        assertThat(sampleIds).isNotEmpty();
    }

    @Test
    void balanceLookupShouldMeetLatencySla() {
        ThreadLocalRandom rnd = ThreadLocalRandom.current();

        // Warmup
        for (int i = 0; i < WARMUP_ITERATIONS; i++) {
            accountRepository.findBalanceById(sampleIds.get(rnd.nextInt(sampleIds.size())));
        }

        // Benchmark (single thread: this measures LATENCY; throughput under
        // concurrency belongs in pgbench / Gatling, not in a unit test)
        long[] latencies = new long[BENCHMARK_ITERATIONS];
        long startTime = System.nanoTime();

        for (int i = 0; i < BENCHMARK_ITERATIONS; i++) {
            UUID accountId = sampleIds.get(rnd.nextInt(sampleIds.size()));
            long queryStart = System.nanoTime();
            accountRepository.findBalanceById(accountId);
            latencies[i] = System.nanoTime() - queryStart;
        }

        double totalSeconds = (System.nanoTime() - startTime) / 1e9;
        double callsPerSecond = BENCHMARK_ITERATIONS / totalSeconds;

        // Compute percentiles
        Arrays.sort(latencies);
        double p50 = latencies[BENCHMARK_ITERATIONS / 2] / 1e6;
        double p95 = latencies[(int) (BENCHMARK_ITERATIONS * 0.95)] / 1e6;
        double p99 = latencies[(int) (BENCHMARK_ITERATIONS * 0.99)] / 1e6;

        log.info("Balance lookup: {} calls/s (1 thread) p50={}ms p95={}ms p99={}ms",
            Math.round(callsPerSecond),
            String.format("%.2f", p50), String.format("%.2f", p95), String.format("%.2f", p99));

        // Assertions: enforce the latency SLA (CI hardware varies -- keep
        // the bound generous and compare against a stored baseline)
        assertThat(p99).as("p99 latency must be < 20ms").isLessThan(20.0);
    }
}
```

## 10. Summary — Benchmarking Best Practices

```
1. Environment parity: benchmark on hardware identical to production
   (or cloud instance of the same type and storage configuration)

2. Data volume: benchmark with production-scale data
   (pgbench -s 100 for 10M accounts, not -s 1 for 100K)

3. Warmup period: allow 2-5 minutes for caches to warm before measuring
   (pgbench has no ramp-up option: run a separate warm-up first, or
   discard the first N seconds using --progress output / log timestamps)

4. Duration: run for at least 5 minutes (300 seconds)
   (longer tests expose steady-state behavior including WAL checkpoint impact)

5. Measure percentiles, not just average
   (average hides tail latency; p99 is what customers experience)

6. Isolate variables: change one setting at a time
   (don't change shared_buffers AND add an index in the same benchmark run)

7. Record everything: timestamp, environment, parameters, results
   (you need to compare tomorrow's results with today's baseline)

8. Test realistic concurrency: not just peak throughput
   (measure TPS at 100, 200, 500, 1000 concurrent clients)

9. Run under realistic I/O conditions
   (prime the buffer cache with the pg_prewarm extension before benchmarking,
   or test with a cold cache to simulate restart behavior)
```

> [!WARNING]
> Never run a destructive benchmark (one that heavily modifies data) against a production or production-replica database. Benchmarks that do thousands of UPDATEs per second generate significant WAL and may cause replication lag on standby servers. Always use a dedicated benchmark instance provisioned from a recent snapshot of production data.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A pgbench run reports: tps = 4,823 (without initial connection establishment). A second run with -c 200 -j 8 reports: tps = 3,102. What does the decrease in TPS indicate?",
      "options": [
        "The database is misconfigured and needs max_connections increased",
        "The system has reached a saturation point where adding concurrency beyond the hardware's parallelism capacity increases contention and reduces throughput",
        "pgbench is reporting incorrect results because -j 8 is too low for -c 200",
        "The benchmark needs to run longer with -T 300 to stabilise the TPS measurement"
      ],
      "correct": 1,
      "explanation": "When TPS decreases as concurrency increases, the system has passed its saturation point on the Universal Scalability Law curve. Beyond the optimal concurrency level, additional clients add more lock contention, context-switching overhead, and connection management cost than they add throughput. The fix is not to increase max_connections but to understand the bottleneck: use pg_stat_statements to identify the most contended queries and pg_locks to find lock wait chains."
    },
    {
      "text": "pg_stat_statements shows that SELECT id, amount_minor, created_at FROM payments WHERE merchant_id = $1 AND status = 'pending' has mean_exec_time = 0.3ms but total_exec_time = 847,000ms. What does this combination of metrics indicate and what is the appropriate action?",
      "options": [
        "The query is slow and needs an index on merchant_id",
        "The query is individually fast but called extremely often (about 2.8 million times); reduce its total cost — first ask whether it needs to run that often (caching, batching), then make each call cheaper, e.g. an index on (merchant_id, status) INCLUDE (id, amount_minor, created_at) for index-only scans",
        "The query has high variance; the mean is misleading and p99 latency should be investigated instead",
        "The total_exec_time is a cumulative lifetime metric; reset pg_stat_statements and re-measure over a 1-hour window"
      ],
      "correct": 1,
      "explanation": "total_exec_time / mean_exec_time ≈ 2.8 million calls. Each call is fast, but the aggregate cost is very high. At this frequency even a 0.1ms improvement saves about 280 seconds of database time per measurement window — and avoiding unnecessary calls (caching, batching) saves even more. A covering index (all selected columns in the key or INCLUDE) allows index-only scans that skip heap fetches, which often halves the per-call time for such lookups."
    },
    {
      "text": "A custom pgbench script simulates payment processing. The benchmark runs for 300 seconds with -c 100 -j 4. The results show latency average = 48ms but latency stddev = 312ms. What does the high standard deviation indicate?",
      "options": [
        "The benchmark script has a bug causing some transactions to be counted multiple times",
        "There is bimodal latency: most transactions complete quickly but a subset experiences dramatically higher latency due to lock waits, autovacuum interference, or checkpoint I/O spikes",
        "pgbench stddev includes connection establishment time which inflates the variance",
        "The -j 4 thread count is insufficient for -c 100 clients causing queuing at the client level"
      ],
      "correct": 1,
      "explanation": "A standard deviation of 312ms with a mean of 48ms (coefficient of variation > 6) indicates highly bimodal or heavy-tailed latency distribution. In PostgreSQL this typically means: some transactions hit lock contention and wait (producing outliers of hundreds or thousands of ms) while most complete in under 20ms. The correct diagnostic step is to capture latency percentiles (p50, p95, p99, p99.9) using --sampling-rate and analyse the tail — the p99 is what customers experience during peak load."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Execute a Production-Representative Payment Benchmark",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Write a custom pgbench script payment_workload.sql that simulates a realistic payment mix: 60% balance reads (SELECT balance FROM accounts WHERE id = :account_id), 30% payment inserts (INSERT INTO payments ... RETURNING id), and 10% status updates (UPDATE payments SET status = 'settled' WHERE id = :payment_id). Use \\set to generate random account IDs and payment IDs from pre-seeded tables. Run the benchmark with -c 50 -j 4 -T 120 and capture TPS, mean latency, and stddev."
    },
    {
      "id": "2",
      "description": "Run the payment benchmark at five concurrency levels: -c 10, 25, 50, 100, 200 (keep -j = concurrency/4). For each level capture: TPS, mean latency ms, p95 latency ms (use --sampling-rate=0.01 and post-process the log). Plot or tabulate the results. Identify the saturation point (concurrency level where TPS stops increasing or decreases). Document whether the bottleneck appears to be CPU, I/O, or lock contention based on the latency stddev pattern."
    },
    {
      "id": "3",
      "description": "After the benchmark run, query pg_stat_statements (ORDER BY total_exec_time DESC LIMIT 10) to identify the top queries by cumulative time. For the top query, run EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) and identify: (a) the actual vs estimated row count, (b) whether shared_hit or shared_read dominates buffer usage, (c) whether the plan uses an index scan or sequential scan. If the row count estimate is off by more than 10x, run ANALYZE on the table and explain why stale statistics cause poor plan choices."
    },
    {
      "id": "4",
      "description": "Implement a Java BenchmarkReportParser that reads a pgbench log file (--log output) and computes: p50, p95, p99, p99.9 latency in milliseconds, TPS over each 10-second window, and the timestamp of the worst 1-second spike. The parser must handle the pgbench log format: 'client_id transaction_no time_us script_no time_epoch time_us_part' (latency in microseconds in column 3). Write a unit test using a synthetic 10,000-line log file verifying the percentile calculation is accurate to within 1ms."
    }
  ]
}
-->
