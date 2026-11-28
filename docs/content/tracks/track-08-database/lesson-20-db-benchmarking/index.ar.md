---
id: track-08-lesson-20
title: "قياس أداء قواعد البيانات — pgbench وأحمال العمل المخصصة"
slug: db-benchmarking
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 20
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [pgbench, benchmarking, TPS, workload-simulation, latency]
prerequisites: [track-08-lesson-01]
---

# قياس أداء قواعد البيانات — pgbench وأحمال العمل المخصصة

> [!NOTE]
> يخدم قياس أداء قواعد البيانات في التقنية المالية غرضين: إرساء خط أساس للأداء قبل التحسينات، والتحقق من خيارات البنية التحتية (نوع النسخة، وإعداد التخزين، وتحجيم مجمع الاتصالات). فدون خط أساس يمثل الإنتاج، لا تستطيع قياس أثر أي تغيير. ودون قياس قابل للتكرار، فأنت تخمّن.

## 1. حمل TPC-B المدمج في pgbench

يحاكي الحمل الافتراضي لـ pgbench معيار TPC-B: نموذج معاملات مصرفية مبسط بحسابات، وفروع، وصرّافين، وسجل تاريخي.

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

### تشغيل القياس

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

### فهم مخرج TPS

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

## 2. سكربتات pgbench مخصصة لأحمال الدفع

الافتراضي TPC-B لا يطابق حمل دفع حقيقيًا. فاكتب سكربتات مخصصة.

تنتج دالة `random()` في pgbench **أعدادًا صحيحة**، بينما `accounts.id` لدينا من نوع UUID — ولا يمكن ببساطة تحويل عدد صحيح إلى `uuid`. لذا تفترض السكربتات أدناه أن بيانات القياس زُرعت بمعرّفات حتمية، بحيث يقابل أي رقم من 1 إلى N حسابًا موجودًا:

```sql
-- Seed 10M accounts whose id is derived from the number n
INSERT INTO accounts (id, balance, currency, status, version)
SELECT md5(n::text)::uuid, 1000000, 'USD', 'ACTIVE', 0
FROM generate_series(1, 10000000) AS n;
```

### السكربت 1: الاستعلام عن الرصيد (كثيف القراءة)

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

### السكربت 2: خصم معاملة (كثيف الكتابة)

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

### السكربت 3: تحويل متزامن (أعلى تنازع)

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

### السكربت 4: حمل مختلط (واقعي)

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

## 3. معاملات pgbench — ‏-c و-j و-T

| المعامل | الغرض | قاعدة عملية |
|---|---|---|
| ‏`-c` / `--client` | العملاء المتزامنون | طابق جلسات التطبيق المتزامنة في الذروة |
| ‏`-j` / `--jobs` | خيوط عمل pgbench | طابق أنوية المعالج على جهاز القياس |
| ‏`-T` / `--time` | المدة بالثواني | 5 أضعاف فترة الإحماء على الأقل (عادة 300 ثانية فأكثر) |
| ‏`-n` / `--no-vacuum` | تخطي VACUUM قبل الاختبار | استخدمه لقياسات الحالة المستقرة |
| ‏`-M` / `--protocol` | بروتوكول الاستعلام | ‏`prepared` لمحاكاة التطبيقات التي تستخدم عبارات مُعدّة على جانب الخادم |
| ‏`--log` | تسجيل كل معاملة | فعّله لتحليل توزيع الزمن (مع `--sampling-rate` عند TPS عالٍ) |
| ‏`--aggregate-interval` | مع `--log`: يكتب سطر ملخص واحدًا كل N ثانية بدل سطر لكل معاملة | ‏10–30 ثانية (واستخدم تشغيلًا منفصلًا لمئينات كل معاملة) |

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

## 4. تفسير نتائج TPS/الزمن

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

## 5. ‏pg_stat_statements لتحليل الحمل

أثناء تشغيل القياس، يجمع `pg_stat_statements` إحصاءات الاستعلامات الفعلية.

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

## 6. ‏HammerDB لأحمال OLTP/OLAP المختلطة

يدعم HammerDB أحمال TPC-C (أكثر واقعية من TPC-B) وTPC-H (تحليلية).

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

يحاكي TPC-C مورّد جملة بخمسة أنواع معاملات: طلب جديد، ودفع، وحالة طلب، وتوصيل، ومستوى مخزون. ومزيجه أغنى من TPC-B، ما يجعله مفيدًا لمقارنة العتاد والإعدادات — لكنه ما زال ليس حملك، لذا تبقى السكربتات المخصصة التي تعكس استعلاماتك الحقيقية الأهم.

## 7. قياسات خط الأساس قبل التحسين

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

## 8. سيناريوهات القياس لخدمات الدفع

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

## 9. التكامل مع Java — التحقق من القياس في CI

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

## 10. الخلاصة — أفضل ممارسات القياس

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
> لا تشغّل أبدًا قياسًا مدمرًا (يعدّل البيانات بكثافة) على قاعدة بيانات إنتاج أو نسخة منها. فالقياسات التي تنفذ آلاف عمليات UPDATE في الثانية تولّد WAL كبيرًا وقد تسبب تأخر النسخ على الخوادم الاحتياطية. واستخدم دائمًا نسخة قياس مخصصة مُجهّزة من لقطة حديثة لبيانات الإنتاج.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يُبلغ تشغيل pgbench عن: tps = 4,823 (دون إنشاء الاتصال الأولي). ويُبلغ تشغيل ثانٍ بـ -c 200 -j 8 عن: tps = 3,102. علامَ يدل انخفاض TPS؟",
      "options": ["قاعدة البيانات سيئة الإعداد وتحتاج زيادة max_connections", "بلغ النظام نقطة تشبع حيث تزيد إضافة التزامن بما يتجاوز قدرة العتاد على التوازي من التنازع وتقلل الإنتاجية", "يُبلغ pgbench عن نتائج خاطئة لأن -j 8 منخفض جدًا لـ -c 200", "يحتاج القياس العمل مدة أطول بـ -T 300 لتثبيت قياس TPS"],
      "correct": 1,
      "explanation": "حين تنخفض TPS مع زيادة التزامن، يكون النظام قد تجاوز نقطة تشبعه على منحنى قانون قابلية التوسع العام (Universal Scalability Law). فبعد مستوى التزامن الأمثل، يضيف العملاء الإضافيون تنازعًا على الأقفال، وكلفة تبديل السياق، وكلفة إدارة الاتصالات أكثر مما يضيفون من إنتاجية. والإصلاح ليس زيادة max_connections بل فهم الاختناق: استخدم pg_stat_statements لتحديد أكثر الاستعلامات تنازعًا وpg_locks لإيجاد سلاسل انتظار الأقفال."
    },
    {
      "text": "يُظهر pg_stat_statements أن SELECT id, amount_minor, created_at FROM payments WHERE merchant_id = $1 AND status = 'pending' له mean_exec_time = 0.3ms لكن total_exec_time = 847,000ms. علامَ يدل هذا المزيج من المقاييس وما الإجراء المناسب؟",
      "options": ["الاستعلام بطيء ويحتاج فهرسًا على merchant_id", "الاستعلام سريع منفردًا لكنه يُستدعى كثيرًا جدًا (نحو 2.8 مليون مرة)؛ قلّل كلفته الإجمالية — اسأل أولًا هل يحتاج أن يعمل بهذا التكرار (تخزين مؤقت، تجميع)، ثم اجعل كل استدعاء أرخص، مثلًا فهرس على (merchant_id, status) INCLUDE (id, amount_minor, created_at) لمسوح الفهرس فقط", "للاستعلام تباين عالٍ؛ والمتوسط مضلل ويجب التحقيق في زمن p99 بدلًا منه", "‏total_exec_time مقياس تراكمي مدى الحياة؛ أعد ضبط pg_stat_statements وأعد القياس على نافذة ساعة واحدة"],
      "correct": 1,
      "explanation": "‏total_exec_time / mean_exec_time ≈ 2.8 مليون استدعاء. وكل استدعاء سريع، لكن الكلفة الإجمالية عالية جدًا. وبهذا التكرار، حتى تحسين بـ 0.1ms يوفر نحو 280 ثانية من وقت قاعدة البيانات في كل نافذة قياس — وتجنب الاستدعاءات غير الضرورية (التخزين المؤقت، والتجميع) يوفر أكثر. والفهرس الشامل (كل الأعمدة المختارة في المفتاح أو INCLUDE) يتيح مسوح الفهرس فقط التي تتخطى جلب صفوف الكومة، ما يقلل كثيرًا زمن الاستدعاء إلى النصف لمثل هذه الاستعلامات."
    },
    {
      "text": "يحاكي سكربت pgbench مخصص معالجة المدفوعات. ويعمل القياس 300 ثانية بـ -c 100 -j 4. وتُظهر النتائج latency average = 48ms لكن latency stddev = 312ms. علامَ يدل الانحراف المعياري العالي؟",
      "options": ["في سكربت القياس خطأ يجعل بعض المعاملات تُحسب عدة مرات", "يوجد زمن ثنائي النمط: معظم المعاملات تكتمل بسرعة لكن مجموعة فرعية تعاني زمنًا أعلى بكثير بسبب انتظار الأقفال، أو تدخل autovacuum، أو قفزات إدخال/إخراج نقاط التفتيش", "يتضمن stddev في pgbench زمن إنشاء الاتصال ما يضخم التباين", "عدد الخيوط -j 4 غير كافٍ لـ -c 100 عميل ما يسبب اصطفافًا على مستوى العميل"],
      "correct": 1,
      "explanation": "انحراف معياري 312ms مع متوسط 48ms (معامل اختلاف > 6) يدل على توزيع زمن ثنائي النمط جدًا أو بذيل ثقيل. وفي PostgreSQL يعني هذا عادة: بعض المعاملات تصطدم بتنازع الأقفال وتنتظر (فتنتج قيمًا شاذة بمئات أو آلاف المللي ثواني) بينما يكتمل معظمها في أقل من 20ms. والخطوة التشخيصية الصحيحة التقاط مئينات الزمن (p50، وp95، وp99، وp99.9) باستخدام --sampling-rate وتحليل الذيل — فـ p99 هو ما يختبره العملاء أثناء حمل الذروة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تصميم قياس دفع يمثل الإنتاج وتنفيذه",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "اكتب سكربت pgbench مخصصًا payment_workload.sql يحاكي مزيج دفع واقعيًا: 60% قراءات رصيد (SELECT balance FROM accounts WHERE id = :account_id)، و30% إدراجات مدفوعات (INSERT INTO payments ... RETURNING id)، و10% تحديثات حالة (UPDATE payments SET status = 'settled' WHERE id = :payment_id). واستخدم \\set لتوليد معرّفات حسابات ومدفوعات عشوائية من جداول مزروعة مسبقًا. وشغّل القياس بـ -c 50 -j 4 -T 120 والتقط TPS، ومتوسط الزمن، والانحراف المعياري."
    },
    {
      "id": "2",
      "description": "شغّل قياس الدفع عند خمسة مستويات تزامن: -c 10، و25، و50، و100، و200 (مع إبقاء -j = التزامن/4). ولكل مستوى التقط: TPS، ومتوسط الزمن بالمللي ثانية، وزمن p95 بالمللي ثانية (استخدم --sampling-rate=0.01 وعالج السجل لاحقًا). وارسم النتائج أو جدولها. وحدد نقطة التشبع (مستوى التزامن الذي تتوقف عنده TPS عن الزيادة أو تنخفض). ووثّق هل يبدو الاختناق في المعالج، أو الإدخال/الإخراج، أو تنازع الأقفال بناءً على نمط الانحراف المعياري للزمن."
    },
    {
      "id": "3",
      "description": "بعد تشغيل القياس، استعلم pg_stat_statements ‏(ORDER BY total_exec_time DESC LIMIT 10) لتحديد أعلى الاستعلامات حسب الزمن التراكمي. ولأعلى استعلام، شغّل EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) وحدد: (أ) عدد الصفوف الفعلي مقابل المقدّر، (ب) هل تهيمن shared_hit أم shared_read على استخدام المخازن، (ج) هل تستخدم الخطة مسح فهرس أم مسحًا تتابعيًا. وإذا انحرف تقدير عدد الصفوف بأكثر من 10 أضعاف، فشغّل ANALYZE على الجدول واشرح لماذا تسبب الإحصاءات القديمة خيارات خطط سيئة."
    },
    {
      "id": "4",
      "description": "نفّذ BenchmarkReportParser في Java يقرأ ملف سجل pgbench (مخرج --log) ويحسب: زمن p50، وp95، وp99، وp99.9 بالمللي ثانية، وTPS في كل نافذة 10 ثوانٍ، والطابع الزمني لأسوأ قفزة لمدة ثانية. ويجب أن يتعامل المحلل مع صيغة سجل pgbench: 'client_id transaction_no time_us script_no time_epoch time_us_part' (الزمن بالميكروثانية في العمود 3). واكتب اختبار وحدة باستخدام ملف سجل اصطناعي من 10,000 سطر يتحقق من دقة حساب المئينات ضمن 1ms."
    }
  ]
}
-->
