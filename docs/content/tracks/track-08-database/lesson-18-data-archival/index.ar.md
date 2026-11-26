---
id: track-08-lesson-18
title: "أرشفة البيانات — التخزين البارد وإدارة البيانات متعددة المستويات"
slug: data-archival
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 18
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [archival, cold-storage, data-lifecycle, tiering, S3]
prerequisites: [track-08-lesson-06]
---

# أرشفة البيانات — التخزين البارد وإدارة البيانات على طبقات

> [!NOTE]
> يشترط قانون السرية المصرفية الأمريكي (BSA) الاحتفاظ بسجلات المعاملات 5 سنوات على الأقل؛ وكثيرًا ما تحدد الأنظمة الأخرى والسياسات الداخلية 5–10 سنوات (و7 اختيار شائع في السياسات). والاحتفاظ بـ 7 سنوات من المعاملات في جدول PostgreSQL ساخن واحد مكلف وثقيل تشغيليًا. والأرشفة على طبقات تنقل البيانات القديمة إلى تخزين أرخص تدريجيًا مع الحفاظ على القدرة على استعلامها للامتثال.

## 1. متطلبات الاحتفاظ التنظيمية

```
Financial data retention schedule (US, simplified -- always confirm
the exact rules with your legal/compliance team):
  - Transaction records (BSA/AML): 5 years (many firms keep 7 by policy)
  - Customer identification (CIP/KYC): 5 years after account closure
  - Suspicious Activity Reports (SARs) and supporting documents: 5 years
  - Wire transfer records: 5 years
  - Customer agreements: often 7 years (firm policy / contract law)

GDPR (EU) consideration:
  - Data kept because of a "legal obligation" is exempt from the right to
    erasure during the mandatory retention period (Art. 17(3)(b))
  - After the retention period expires: delete or anonymise it, unless
    another lawful basis applies (storage limitation principle)
  - Implement automated deletion at the end of the retention period
```

## 2. استراتيجية الطبقات الساخنة/الدافئة/الباردة

```
Tier     Storage          Cost/GB/month  Query latency   Data age
------   -------          -------------  -------------   --------
HOT      PostgreSQL RDS   $0.115         <10ms           0-6 months
WARM     PostgreSQL RDS   $0.115         <10ms           6-24 months
         (smaller instance, read-only replica)
COLD     S3 Standard      $0.023         1-5 seconds     2-7 years
         (pg_dump files, Parquet on Athena)
FROZEN   S3 Glacier       ~$0.004        minutes-hours   legal hold only
         (data past retention that must be kept for a dispute/investigation)
```

لنظام بـ 10 ملايين معاملة شهريًا بنحو 1KB لكل منها:
- ‏7 سنوات = 840 مليون معاملة = ‏840GB من البيانات الخام
- الطبقة الساخنة (6 أشهر): 60 مليون صف = ‏60GB على RDS = ‏$6.90 شهريًا
- الطبقة الباردة (6.5 سنة الباقية): 780 مليون صف = ‏780GB على S3 = ‏$17.94 شهريًا
- مقابل إبقاء كل شيء ساخنًا: $96.60 شهريًا
- **توفير في التخزين بنحو 75% عبر الطبقات** (أسعار قائمة توضيحية؛ التخزين فقط — والمكاسب الأكبر كثيرًا ما تكون نسخًا أصغر، ونسخًا احتياطية واستعادات أسرع، وصيانة أخف)

## 3. خط أرشفة قائم على الأقسام

سير عمل الأرشفة القائم على الأقسام:

```
1. Transactions table is partitioned monthly (see Lesson 06)
2. At month N+2, partition for month N is "cool" (no new writes)
3. At month N+13, partition for month N is detached from parent table
4. Detached partition is exported to S3 as compressed CSV or Parquet
5. Detached partition is dropped from PostgreSQL
6. S3 data is indexed in AWS Glue catalog for Athena queries
```

### الخطوة 1: فصل القسم القديم

```sql
-- Detach the January 2023 partition (safe: no new data written there)
-- CONCURRENTLY (PostgreSQL 14+): avoids blocking queries on the parent.
-- Limits: cannot run inside a transaction block (so not inside a
-- function/procedure), and not allowed while the table has a DEFAULT partition.
ALTER TABLE transactions
    DETACH PARTITION transactions_2023_01 CONCURRENTLY;

-- The partition is now a standalone table in public schema
-- transactions table: no longer includes Jan 2023 data
-- transactions_2023_01: independent table with Jan 2023 data
```

### الخطوة 2: التصدير إلى S3

```bash
#!/bin/bash
# archive_partition.sh
set -euo pipefail

PARTITION_NAME="transactions_2023_01"
BUCKET="company-financial-archive"
KEY="transactions/year=2023/month=01/${PARTITION_NAME}.csv.gz"

# Record the source row count -- the verification step compares against it
ROWS=$(psql -h "${DB_HOST}" -U "${DB_USER}" -d payments -XAtq \
  -c "SELECT count(*) FROM ${PARTITION_NAME}")

# Stream straight to S3: no unencrypted copy of customer data on local disk
psql -h "${DB_HOST}" -U "${DB_USER}" -d payments \
  -c "\COPY ${PARTITION_NAME} TO STDOUT CSV HEADER" \
  | gzip \
  | aws s3 cp - "s3://${BUCKET}/${KEY}" \
      --sse aws:kms --sse-kms-key-id "${KMS_KEY_ARN}" \
      --metadata "row-count=${ROWS}"

# Verify the object exists and carries the expected row count
aws s3api head-object --bucket "${BUCKET}" --key "${KEY}" \
  --query 'Metadata."row-count"' --output text | grep -qx "${ROWS}"

echo "Archive complete: ${PARTITION_NAME} (${ROWS} rows) -> s3://${BUCKET}/${KEY}"
# Next: record PENDING in archival_log; a separate check (e.g. Athena
# COUNT(*)) sets it to VERIFIED before the partition may be dropped
```

### الخطوة 3: التصدير بصيغة Parquet (لأداء استعلامات Athena)

```python
# convert_to_parquet.py
import os
import psycopg2
from psycopg2 import sql
import pyarrow as pa
import pyarrow.parquet as pq
from pyarrow import fs

def export_partition_to_parquet(partition_name: str, year: str, month: str) -> int:
    conn = psycopg2.connect(
        host=os.environ['DB_HOST'],
        dbname='payments',
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'],
    )
    s3 = fs.S3FileSystem()   # credentials from the environment / IAM role
    # Same year=/month= layout as the Athena table below
    path = (f"company-financial-archive/transactions/"
            f"year={year}/month={month}/{partition_name}.parquet")

    chunk_size = 100_000
    total_rows = 0
    writer = None
    try:
        # A NAMED cursor is a server-side cursor: rows arrive in chunks.
        # (A normal cursor would load the whole partition into memory.)
        with conn.cursor(name='archive_cursor') as cur:
            cur.itersize = chunk_size
            # Identifier quoting instead of an f-string: no SQL injection
            cur.execute(sql.SQL("SELECT * FROM {}").format(
                sql.Identifier(partition_name)))
            while True:
                rows = cur.fetchmany(chunk_size)
                if not rows:
                    break
                columns = [d[0] for d in cur.description]
                batch = pa.Table.from_pylist([dict(zip(columns, r)) for r in rows])
                if writer is None:
                    writer = pq.ParquetWriter(path, batch.schema,
                                              filesystem=s3, compression='snappy')
                writer.write_table(batch)      # stream chunk by chunk
                total_rows += batch.num_rows
    finally:
        if writer is not None:
            writer.close()
        conn.close()

    print(f"Exported {total_rows} rows to s3://{path}")
    return total_rows
```

### الخطوة 4: حذف القسم المحلي

```sql
-- Verify S3 upload is complete before dropping
-- (check row count in S3 matches PostgreSQL)

-- Count rows in archived file (via Athena or local verification):
-- SELECT COUNT(*) FROM s3_transactions WHERE year='2023' AND month='01';

-- After verification, drop the local partition
DROP TABLE transactions_2023_01;

-- Verify the partition is gone
SELECT relname FROM pg_class
WHERE relname = 'transactions_2023_01';
-- (0 rows) -- partition successfully dropped
```

## 4. ‏AWS S3 Intelligent-Tiering

لبيانات مالية مؤرشفة، ينقل S3 Intelligent-Tiering الكائنات تلقائيًا بين طبقات الوصول بحسب أنماط الوصول.

```json
{
  "Rules": [{
    "ID": "financial-archive-tiering",
    "Status": "Enabled",
    "Filter": {"Prefix": "transactions/"},
    "Transitions": [
      {
        "Days": 0,
        "StorageClass": "INTELLIGENT_TIERING"
      }
    ],
    "NoncurrentVersionTransitions": [{
      "NoncurrentDays": 30,
      "StorageClass": "GLACIER"
    }],
    "Expiration": {
      "Days": 2557
    }
  }]
}
```

طبقات Intelligent-Tiering (التوفير تقريبي مقارنة بالوصول المتكرر):
- **الوصول المتكرر (Frequent Access)**: كائنات وُصل إليها مؤخرًا
- **الوصول غير المتكرر (Infrequent Access)**: لم يُوصل إليها 30 يومًا (كلفة أقل بنحو 40%)
- **الأرشيف بوصول فوري (Archive Instant Access)**: لم يُوصل إليها 90 يومًا (كلفة أقل بنحو 68%، استرجاع بالمللي ثانية)
- **الأرشيف (Archive Access)** (اختياري): بعد 90 يومًا فأكثر (استرجاع بالساعات)
- **الأرشيف العميق (Deep Archive Access)** (اختياري): بعد 180 يومًا فأكثر (كلفة أقل بنحو 95%، استرجاع خلال ~12 ساعة)

يستطيع Athena قراءة الكائنات في الطبقات الثلاث الأولى فقط؛ أما الكائنات في طبقات الأرشيف الاختيارية فيجب استعادتها أولًا. وللحماية بنمط WORM من الحذف أو العبث، فعّل أيضًا **S3 Object Lock** (وضع الامتثال) على دلو الأرشيف.

## 5. استعلام البيانات المؤرشفة — AWS Athena

```sql
-- AWS Glue Data Catalog: define the schema for S3 data
-- This runs once to register the schema

CREATE EXTERNAL TABLE transactions_archive (
    id           STRING,
    account_id   STRING,
    amount       DECIMAL(19,4),
    currency     CHAR(3),
    status       STRING,
    type         STRING,
    reference    STRING,
    created_at   TIMESTAMP,
    settled_at   TIMESTAMP
)
PARTITIONED BY (year STRING, month STRING)
STORED AS PARQUET
LOCATION 's3://company-financial-archive/transactions/'
TBLPROPERTIES ('parquet.compression'='SNAPPY');

-- Load partitions (run after adding new archived data)
MSCK REPAIR TABLE transactions_archive;

-- Regulatory query: find all transactions for a customer in 2022
-- This triggers S3 reads for the relevant month partitions only
SELECT
    id,
    account_id,
    amount,
    currency,
    status,
    created_at
FROM transactions_archive
WHERE year = '2022'
  AND account_id IN (
    -- accounts live in PostgreSQL, not in Athena: query a reference copy
    -- exported to S3 (accounts_reference)
    SELECT CAST(id AS VARCHAR) FROM accounts_reference WHERE customer_id = 'cust-001'
  )
ORDER BY created_at;
-- Cost: Athena charges $5/TB scanned. With partitioning + Parquet, typical query
-- scans ~100MB instead of the full year's data -> ~$0.0005 per query
```

## 6. أداء استعلامات الامتثال على البيانات المؤرشفة

```java
@Service
@Slf4j
public class ComplianceDataService {

    private static final DateTimeFormatter ATHENA_TS =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS").withZone(ZoneOffset.UTC);

    private final AthenaClient athenaClient;          // AWS SDK v2
    private final JdbcTemplate jdbcTemplate;
    private final ArchivalBoundaryService archivalBoundary;

    /**
     * Regulatory or data-subject-access request: all transactions of a
     * customer in [from, to). May span hot (PostgreSQL) and cold (Athena/S3).
     */
    public List<TransactionRecord> getTransactionsForCompliance(
            UUID customerId, Instant from, Instant to) {

        // The real boundary: start of the oldest month still attached in
        // PostgreSQL (read from archival_log) -- NOT a fixed "now - 2 years",
        // which would drift away from what was actually archived
        Instant hotCutoff = archivalBoundary.oldestHotMonthStart();

        List<TransactionRecord> results = new ArrayList<>();

        // Hot tier: [max(from, cutoff), to)
        if (to.isAfter(hotCutoff)) {
            Instant hotFrom = from.isAfter(hotCutoff) ? from : hotCutoff;
            results.addAll(queryHotTier(customerId, hotFrom, to));
        }

        // Cold tier: [from, min(to, cutoff)) -- half-open ranges on both
        // sides, so a row exactly at the cutoff is returned once, not twice
        if (from.isBefore(hotCutoff)) {
            Instant coldTo = to.isBefore(hotCutoff) ? to : hotCutoff;
            results.addAll(queryColdTier(customerId, from, coldTo));
        }

        results.sort(Comparator.comparing(TransactionRecord::getCreatedAt));
        return results;
    }

    private List<TransactionRecord> queryHotTier(
            UUID customerId, Instant from, Instant to) {
        return jdbcTemplate.query(
            """
            SELECT t.id, t.amount, t.currency, t.status, t.created_at
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE a.customer_id = ?
              AND t.created_at >= ? AND t.created_at < ?
            ORDER BY t.created_at
            """,
            this::mapRow,
            customerId, Timestamp.from(from), Timestamp.from(to));
    }

    private List<TransactionRecord> queryColdTier(
            UUID customerId, Instant from, Instant to) {
        // Parameterised Athena query (executionParameters) -- no string
        // concatenation of values into SQL. The year predicate keeps the
        // scan (and the bill) to the needed partitions.
        String athenaQuery = """
            SELECT id, amount, currency, status, created_at
            FROM transactions_archive
            WHERE year BETWEEN ? AND ?
              AND account_id IN (
                SELECT CAST(id AS VARCHAR) FROM accounts_reference
                WHERE customer_id = ?
              )
              AND created_at >= CAST(? AS TIMESTAMP)
              AND created_at <  CAST(? AS TIMESTAMP)
            ORDER BY created_at
            """;
        List<String> params = List.of(
            quote(String.valueOf(from.atZone(ZoneOffset.UTC).getYear())),
            quote(String.valueOf(to.atZone(ZoneOffset.UTC).getYear())),
            quote(customerId.toString()),
            quote(ATHENA_TS.format(from)),
            quote(ATHENA_TS.format(to)));

        return executeAthenaQuery(athenaQuery, params);
    }

    private static String quote(String value) {     // Athena parameters are SQL literals
        return "'" + value.replace("'", "''") + "'";
    }

    private List<TransactionRecord> executeAthenaQuery(String sql, List<String> params) {
        StartQueryExecutionRequest request = StartQueryExecutionRequest.builder()
            .queryString(sql)
            .executionParameters(params)
            .queryExecutionContext(QueryExecutionContext.builder()
                .database("financial_archive")
                .build())
            .workGroup("compliance-queries")   // output location set on the workgroup
            .build();

        String executionId = athenaClient.startQueryExecution(request)
            .queryExecutionId();

        return pollForResults(executionId);    // GetQueryExecution until SUCCEEDED
    }
}
```

## 7. أتمتة خط الأرشفة باستخدام pg_cron

```sql
-- Install pg_cron (needs shared_preload_libraries = 'pg_cron'; jobs run in
-- the database named by cron.database_name -- use cron.schedule_in_database
-- to run them elsewhere)
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE IF NOT EXISTS archival_log (
    partition_name TEXT        NOT NULL,
    status         TEXT        NOT NULL,   -- PENDING / VERIFIED / FAILED / DROPPED_LOCAL
    row_count      BIGINT,
    s3_path        TEXT,
    completed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create the archival procedure
CREATE OR REPLACE PROCEDURE archive_old_partition(
    months_ago INT DEFAULT 13
) LANGUAGE plpgsql AS $$
DECLARE
    v_target_date    DATE;
    v_partition      TEXT;   -- "v_" prefix: a variable named like a column
                             -- (partition_name) makes queries ambiguous
BEGIN
    v_target_date := DATE_TRUNC('month', NOW() - make_interval(months => months_ago));
    v_partition   := 'transactions_' || TO_CHAR(v_target_date, 'YYYY_MM');

    -- Check if partition exists
    IF to_regclass('public.' || v_partition) IS NULL THEN
        RAISE NOTICE 'Partition % does not exist, skipping', v_partition;
        RETURN;
    END IF;

    -- Step 1: only proceed if the archive was VERIFIED independently
    -- (row count compared via Athena by the export job)
    IF NOT EXISTS (
        SELECT 1 FROM archival_log
        WHERE partition_name = v_partition AND status = 'VERIFIED'
    ) THEN
        RAISE WARNING 'Partition % not verified in S3, skipping drop', v_partition;
        RETURN;
    END IF;

    -- Step 2: Detach partition. DETACH ... CONCURRENTLY is not allowed here
    -- (a procedure body runs inside a transaction), so use a plain DETACH
    -- with a short lock_timeout; the job retries next run if it cannot lock
    SET LOCAL lock_timeout = '5s';
    EXECUTE format('ALTER TABLE transactions DETACH PARTITION %I', v_partition);
    RAISE NOTICE 'Detached partition: %', v_partition;

    -- Step 3: Drop the partition
    EXECUTE format('DROP TABLE %I', v_partition);
    RAISE NOTICE 'Dropped partition: %', v_partition;

    -- Step 4: Log the archival
    INSERT INTO archival_log (partition_name, status)
    VALUES (v_partition, 'DROPPED_LOCAL');
END;
$$;

-- Schedule: run on the 1st of each month at 02:00 UTC
SELECT cron.schedule(
    'monthly-archival',
    '0 2 1 * *',
    'CALL archive_old_partition(13)'
);

-- View scheduled jobs
SELECT * FROM cron.job;

-- View job run history
SELECT * FROM cron.job_run_details ORDER BY end_time DESC LIMIT 20;
```

## 8. تحليل الكلفة — RDS مقابل S3

```
Scenario: Payment system with 7-year retention, 10M transactions/month

Option A: Keep everything in PostgreSQL RDS
  Data volume: 7 years * 12 months * 10M rows * 1KB = 840GB
  RDS storage: 840GB * $0.115/GB/month = $96.60/month
  Read IOPS for compliance queries: included
  Total cost: ~$1,160/year for storage alone

Option B: Tiered archival (hot 1 year + cold 6 years)
  Hot tier (12 months, PostgreSQL RDS):
    120M rows * 1KB = 120GB * $0.115 = $13.80/month

  Cold tier (remaining 6 years, S3):
    720M rows * 0.3KB compressed = 216GB * $0.023 = $4.97/month
    (Parquet + Snappy achieves ~3x compression over raw CSV)

  Athena queries (compliance, ~10/month): negligible ($0.05/month)
  Total: $18.82/month = $225.84/year
  Savings vs Option A: 80.5% (storage only, illustrative list prices)

Option C: Partitioned PostgreSQL (hot, no cold tier)
  Same RDS cost as Option A: $96.60/month
  Benefit: instant queries, no Athena complexity
  Recommended if: compliance queries are frequent (> 100/month)
  Recommended if: regulatory queries require < 1 second response time
```

## 9. استعادة الأقسام المؤرشفة عند الطلب

```sql
-- Regulatory request: need all transactions from Q1 2021 immediately
-- (Often simpler: query them in Athena, or restore into a separate
--  "restore" schema without attaching to the live table.)
-- Step 1: Create staging tables
CREATE TABLE transactions_2021_01_restored (LIKE transactions INCLUDING ALL);
CREATE TABLE transactions_2021_02_restored (LIKE transactions INCLUDING ALL);
CREATE TABLE transactions_2021_03_restored (LIKE transactions INCLUDING ALL);
```

```bash
# Step 2: Stream from S3 and load (no decompressed copy on disk)
set -euo pipefail
for month in 01 02 03; do
  for key in $(aws s3api list-objects-v2 \
                 --bucket company-financial-archive \
                 --prefix "transactions/year=2021/month=${month}/" \
                 --query 'Contents[?ends_with(Key, `.csv.gz`)].Key' --output text); do
    aws s3 cp "s3://company-financial-archive/${key}" - \
      | gunzip \
      | psql -h "${DB_HOST}" -U "${DB_USER}" -d payments \
          -c "\COPY transactions_2021_${month}_restored FROM STDIN CSV HEADER"
  done
  echo "Restored 2021-${month}"
done
```

```sql
-- Step 3: Attach to parent table for transparent querying.
-- A matching CHECK constraint first lets ATTACH skip its full validation
-- scan (which would run under a lock on the new partition)
ALTER TABLE transactions_2021_01_restored
    ADD CONSTRAINT chk_range CHECK (created_at >= '2021-01-01' AND created_at < '2021-02-01');
ALTER TABLE transactions
    ATTACH PARTITION transactions_2021_01_restored
    FOR VALUES FROM ('2021-01-01') TO ('2021-02-01');
-- (same for 02 and 03)

-- Now compliance query works transparently
SELECT * FROM transactions
WHERE account_id = :account_id
  AND created_at >= '2021-01-01'
  AND created_at < '2021-04-01';

-- Step 4: After compliance work, detach and drop the restored partition
ALTER TABLE transactions
    DETACH PARTITION transactions_2021_01_restored CONCURRENTLY;
DROP TABLE transactions_2021_01_restored;
```

## 10. الخلاصة — قائمة تحقق تنفيذ الأرشفة

```
Before implementing archival:
[ ] Confirm regulatory retention requirements with legal/compliance team
[ ] Design partition strategy aligned with archival boundaries (monthly)
[ ] Choose archive format: CSV (simple) or Parquet (queryable, compressed)
[ ] Implement S3 bucket lifecycle policy (Intelligent-Tiering, expiration)
[ ] Implement encryption at rest (S3 SSE-KMS)
[ ] Test restore procedure with a sample partition

Production implementation:
[ ] Deploy pg_cron archival job
[ ] Add archival log table to track what has been archived
[ ] Implement S3 archive verification before local drop
[ ] Set up CloudWatch alerts for archival failures
[ ] Document restore procedure in runbook
[ ] Run quarterly disaster recovery test (restore a random archived partition)

Compliance validation:
[ ] Verify Athena queries return correct results
[ ] Test cross-tier queries (spanning hot and cold data)
[ ] Run compliance query time test: must complete within SLA
[ ] Verify deleted data cannot be queried after GDPR erasure
```

> [!WARNING]
> لا تحذف أبدًا قسمًا من PostgreSQL قبل التحقق المستقل من أن البيانات المؤرشفة في S3 كاملة وقابلة للاستعلام. فشغّل مقارنة عدد الصفوف (عدد PostgreSQL مقابل عدد Athena) وتحقق من عينة من السجلات قبل تنفيذ DROP TABLE. فقسم واحد مفقود لا يمكن استعادته سيكون إخفاقًا في الامتثال التنظيمي.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يخزن نظام دفع 7 سنوات من بيانات المعاملات كما تشترط أنظمة BSA. وكل البيانات محفوظة في جدول PostgreSQL ساخن واحد (دون تقسيم). ما أخطر مشكلتين تشغيليتين يسببهما هذا؟",
      "options": [
        "بدء تشغيل أبطأ للتطبيق وزيادة حجم ملف JAR",
        "إزالة البيانات المنتهية تحتاج عمليات DELETE ضخمة (WAL هائل، وانتفاخ، وVACUUM طويل) بدل مجرد حذف قسم، وكل مهمة صيانة — VACUUM وتجميد منع الالتفاف، وإعادة بناء الفهارس، والاستعادات — يجب أن تعالج الجدول كله متعدد السنوات",
        "لا يستطيع PostgreSQL التعامل مع جداول أكبر من 32TB فسيفشل النظام في النهاية",
        "تستغرق النسخ الاحتياطية وقتًا أطول لأن pg_basebackup ينسخ قاعدة البيانات كاملة"
      ],
      "correct": 1,
      "explanation": "مع جدول ضخم واحد، يُفرض الاحتفاظ عبر DELETE: فحذف مليارات الصفوف ينتج كميات WAL هائلة، ويترك انتفاخًا، ويطلق عمليات VACUUM طويلة جدًا. وتتناسب الصيانة أيضًا مع الجدول كله: فتجميد منع الالتفاف، وإعادة بناء الفهارس، والاستعادات كلها تعالج 7 سنوات من البيانات دفعة واحدة. ومع التقسيم الزمني، تُزال الأشهر المنتهية بـ DETACH + DROP (فوري تقريبًا)، وتعمل الصيانة لكل قسم، وتستفيد استعلامات النطاق الزمني من تقليم الأقسام. وهذه الأسباب التشغيلية الجوهرية لتقسيم البيانات المالية الزمنية."
    },
    {
      "text": "قبل حذف قسم PostgreSQL أُرشف إلى S3، ما خطوات التحقق المطلوبة ولماذا؟",
      "options": [
        "يكفي فقط مقارنة عدد الصفوف بين PostgreSQL وS3",
        "التحقق من عدد الصفوف، وفحص عينة من السجلات لصحة البيانات، وتأكيد أن بيانات Athena/S3 قابلة للاستعلام قبل تنفيذ DROP TABLE — لأن البيانات المؤرشفة يجب أن تلبي المتطلبات التنظيمية، والأرشيف التالف أو المفقود يخلق إخفاق امتثال لا يمكن تداركه",
        "لا يلزم تحقق إذا اكتمل pg_dump دون أخطاء",
        "تحقق فقط من أن دلو S3 يحوي العدد الصحيح من الملفات؛ وأعداد الصفوف غير ضرورية"
      ],
      "correct": 1,
      "explanation": "يجب الاحتفاظ بالبيانات المالية 5–7 سنوات بموجب أنظمة BSA/AML. وحذف قسم دون التحقق من الأرشيف يخلق فجوة لا تُستدرك في سجل المعاملات. والتحققات المطلوبة: (1) تطابق عدد الصفوف بين SELECT COUNT(*) في PostgreSQL وCOUNT(*) في Athena للقسم، (2) فحص عينة من السجلات لتأكيد سلامة البيانات (لا عدد الصفوف فقط)، (3) اختبار استعلام شامل عبر Athena لتأكيد إمكانية الوصول للبيانات. فملف أرشيف تالف واحد من تصدير فاشل قد يمر دون كشف بعدد الصفوف وحده."
    },
    {
      "text": "يحتاج فريق الامتثال استعلام كل معاملات عميل معين من يناير 2020 (البيانات مؤرشفة في S3). وتحتفظ طبقة PostgreSQL الساخنة بآخر 24 شهرًا فقط. ما خصائص زمن استجابة استعلام Athena على هذه البيانات المؤرشفة مقارنة باستعلام PostgreSQL؟",
      "options": [
        "استعلامات Athena سريعة كاستعلامات PostgreSQL لأن كليهما يستخدم التخزين الأساسي نفسه",
        "تستغرق استعلامات Athena عادة بضع ثوانٍ (وأحيانًا عشرات الثواني) لاستعلام امتثال (قراءات S3 + معالجة موزعة)، مقارنة بالمللي ثواني في PostgreSQL — مقبول لاستعلامات الامتثال غير المتكررة لكن ليس للميزات الفورية الموجهة للعملاء",
        "تستغرق استعلامات Athena دائمًا أكثر من 10 دقائق بسبب استرجاع التخزين البارد من Glacier",
        "لا تستطيع استعلامات Athena الترشيح حسب customer_id لأن S3 لا يدعم البحث المفهرس"
      ],
      "correct": 1,
      "explanation": "يقرأ Athena مباشرة من S3 (Standard، أو طبقات Intelligent-Tiering المتكرر / غير المتكرر / الأرشيف الفوري) بزمن بضع ثوانٍ لبيانات Parquet مقسّمة جيدًا. ومع التقسيم حسب السنة/الشهر وصيغة Parquet العمودية، قد يمسح استعلام امتثال لعميل واحد 10–100MB فقط بدل السنة كاملة، بكلفة جزء من السنت. وهذا مناسب لاستعلامات الامتثال التي تعمل عشرات المرات شهريًا، لا عشرات المرات في الثانية. ويجب أن تستخدم الميزات الفورية الموجهة للعملاء طبقة PostgreSQL الساخنة فقط."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "خط أرشفة آلي مع التحقق من الامتثال",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "نفّذ خط الأرشفة الكامل من 4 خطوات لقسم معاملات شهري: (1) التصدير إلى S3 بصيغة Parquet باستخدام قالب سكربت Python من هذا الدرس، (2) التسجيل في كتالوج AWS Glue والتحقق من عدد الصفوف عبر Athena (وتعليمه VERIFIED في archival_log)، (3) فصل القسم (DETACH ... CONCURRENTLY من مهمة خارجية، أو DETACH عادي مع lock_timeout داخل إجراء)، (4) DROP TABLE للأقسام VERIFIED فقط. وغلّف جانب قاعدة البيانات في إجراء مجدول عبر pg_cron مع معالجة الأخطاء — فإذا فشلت أي خطوة، يجب أن يسجل الفشل ويتوقف دون المتابعة إلى DROP TABLE."},
    {"id": "2", "description": "ابنِ خدمة استعلامات امتثال عبر الطبقات في Java تستعلم بشفافية طبقة PostgreSQL الساخنة (آخر 24 شهرًا) وطبقة S3/Athena الباردة (البيانات الأقدم) بحسب النطاق الزمني المطلوب. ويجب أن تدمج الخدمة النتائج من الطبقتين وترتبها. واكتب اختبار تكامل باستخدام Testcontainers لـ PostgreSQL وLocalStack لـ S3 (محاكاة Athena تحتاج النسخة المدفوعة من LocalStack — وإلا فاستبدل عميل Athena بنسخة وهمية) يتحقق من أن استعلامًا لمدة 3 سنوات يمتد عبر الطبقتين يعيد كل السجلات بترتيب زمني صحيح."},
    {"id": "3", "description": "صمم ونفّذ جدول سجل الأرشفة الذي يتتبع كل عملية أرشفة: اسم القسم، وعدد الصفوف قبل وبعد، ومسار S3، وطابع زمن الأرشفة، وحالة التحقق (PENDING / VERIFIED / FAILED)، والمشغّل الذي وافق على DROP. واكتب SQL لاستعلام هذا الجدول عن حالة الأرشفة الحالية لكل الأقسام، مُظهرًا أيها في PostgreSQL، وأيها متحقق منه في S3، وأيها بانتظار التحقق."},
    {"id": "4", "description": "نفّذ سير عمل حق المحو في GDPR للبيانات المؤرشفة. فحين يطلب عميل الحذف، يجب حذف بيانات معاملاته من طبقة PostgreSQL الساخنة وتنقيحها في ملفات S3 المؤرشفة. وصمم استراتيجية التنقيح (لا يمكنك تعديل ملفات Parquet في مكانها — فما الخيارات؟)، ونفّذ آلية تتبع لطلبات المحو المعلقة في الأقسام المؤرشفة، واكتب الإجراء الذي ينشئ ملف Parquet جديدًا منقّحًا ويستبدل الأصلي في S3."}
  ]
}
-->
