---
id: track-08-lesson-18
title: "Data Archival — Cold Storage and Tiered Data Management"
slug: data-archival
track: track-08
trackName: "Database & Data Architecture"
sequence: 18
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [archival, cold-storage, data-lifecycle, tiering, S3]
prerequisites: [track-08-lesson-06]
---

# Data Archival — Cold Storage and Tiered Data Management

> [!NOTE]
> The US Bank Secrecy Act (BSA) requires retention of transaction records for at least 5 years; other regimes and internal policies often set 5–10 years (7 is a common policy choice). Keeping 7 years of transactions in a single hot PostgreSQL table is expensive and operationally heavy. Tiered archival moves old data to progressively cheaper storage while maintaining the ability to query it for compliance.

## 1. Regulatory Retention Requirements

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

## 2. Hot/Warm/Cold Tiering Strategy

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

For a system with 10M transactions/month at ~1KB each:
- 7 years = 840M transactions = 840GB of raw data
- Hot tier (6 months): 60M rows = 60GB on RDS = $6.90/month
- Cold tier (remaining 6.5 years): 780M rows = 780GB on S3 = $17.94/month
- vs keeping everything hot: $96.60/month
- **Storage savings: ~75% by tiering** (illustrative list prices; storage only — the bigger wins are often smaller instances, faster backups/restores and lighter maintenance)

## 3. Partition-Based Archival Pipeline

The partition-based archival workflow:

```
1. Transactions table is partitioned monthly (see Lesson 06)
2. At month N+2, partition for month N is "cool" (no new writes)
3. At month N+13, partition for month N is detached from parent table
4. Detached partition is exported to S3 as compressed CSV or Parquet
5. Detached partition is dropped from PostgreSQL
6. S3 data is indexed in AWS Glue catalog for Athena queries
```

### Step 1: Detach Old Partition

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

### Step 2: Export to S3

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

### Step 3: Export as Parquet (for Athena Query Performance)

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

### Step 4: Drop the Local Partition

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

## 4. AWS S3 Intelligent-Tiering

For archived financial data, S3 Intelligent-Tiering automatically moves objects between access tiers based on access patterns.

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

Intelligent-Tiering tiers (approximate savings vs Frequent Access):
- **Frequent Access**: objects accessed recently
- **Infrequent Access**: not accessed for 30 days (~40% lower cost)
- **Archive Instant Access**: not accessed for 90 days (~68% lower cost, millisecond retrieval)
- **Archive Access** (opt-in): after 90+ days (retrieval in hours)
- **Deep Archive Access** (opt-in): after 180+ days (~95% lower cost, retrieval within ~12 hours)

Athena can only read objects in the first three tiers; objects in the opt-in archive tiers must be restored first. For WORM protection against deletion or tampering, also enable **S3 Object Lock** (compliance mode) on the archive bucket.

## 5. Querying Archived Data — AWS Athena

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

## 6. Compliance Query Performance on Archived Data

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

## 7. Archival Pipeline Automation with pg_cron

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

## 8. Cost Analysis — RDS vs S3

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

## 9. Restoring Archived Partitions On-Demand

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

## 10. Summary — Archival Implementation Checklist

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
> Never drop a partition from PostgreSQL before independently verifying that the archived data in S3 is complete and queryable. Run a row count comparison (PostgreSQL count vs Athena count) and verify a sample of records before executing the DROP TABLE. A single missing partition that cannot be recovered would be a regulatory compliance failure.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment system stores 7 years of transaction data as required by BSA regulations. All data is kept in a single hot PostgreSQL table (no partitioning). What are the two most critical operational problems this causes?",
      "options": [
        "Slower application startup and increased JAR file size",
        "Removing expired data needs huge DELETEs (massive WAL, bloat, long VACUUMs) instead of simply dropping a partition, and every maintenance task — VACUUM and anti-wraparound freezing, index rebuilds, restores — has to process the whole multi-year table",
        "PostgreSQL cannot handle tables larger than 32TB so the system will eventually fail",
        "Backups take longer because pg_basebackup copies the entire database"
      ],
      "correct": 1,
      "explanation": "With one huge table, retention is enforced by DELETE: billions of rows deleted produce huge WAL volumes, leave bloat behind and trigger very long VACUUMs. Maintenance also scales with the whole table: anti-wraparound freezing, index rebuilds and restores all handle 7 years of data at once. With time-based partitioning, expired months are removed with DETACH + DROP (almost instant), maintenance works per partition, and date-range queries benefit from partition pruning. These are the core operational reasons to partition time-series financial data."
    },
    {
      "text": "Before dropping a PostgreSQL partition that has been archived to S3, what verification steps are required and why?",
      "options": [
        "Only a row count comparison between PostgreSQL and S3 is needed",
        "Row count verification, spot-check of a sample of records for data correctness, and confirmation that the Athena/S3 data is queryable before executing DROP TABLE — because the archived data must meet regulatory requirements and a corrupted or missing archive creates an unrecoverable compliance failure",
        "No verification is needed if pg_dump completed without errors",
        "Only verify that the S3 bucket has the correct number of files; row counts are not necessary"
      ],
      "correct": 1,
      "explanation": "Financial data must be retained for 5-7 years under BSA/AML regulations. Dropping a partition without verifying the archive creates an irrecoverable gap in the transaction record. Required verifications: (1) row count match between PostgreSQL SELECT COUNT(*) and Athena COUNT(*) for the partition, (2) spot-check of several records to confirm data integrity (not just row count), (3) end-to-end query test through Athena to confirm the data is accessible. A single corrupted or empty archive file from a failed export would go undetected by row count alone."
    },
    {
      "text": "A compliance team needs to query all transactions for a specific customer from January 2020 (data is archived in S3). The hot PostgreSQL tier only holds the last 24 months. What is the latency characteristics of an Athena query against this archived data compared to a PostgreSQL query?",
      "options": [
        "Athena queries are as fast as PostgreSQL queries because both use the same underlying storage",
        "Athena queries typically take a few seconds (sometimes tens of seconds) for a compliance query (S3 reads + distributed processing), compared to milliseconds in PostgreSQL — acceptable for infrequent compliance queries but not for real-time customer-facing features",
        "Athena queries always take more than 10 minutes due to Glacier cold storage retrieval",
        "Athena queries cannot filter by customer_id because S3 does not support indexed lookups"
      ],
      "correct": 1,
      "explanation": "Athena reads directly from S3 (Standard, or the Intelligent-Tiering Frequent / Infrequent / Archive Instant tiers) with latencies of a few seconds for well-partitioned Parquet data. With year/month partitioning and columnar Parquet, a compliance query for one customer may scan only 10–100MB instead of the whole year, costing a fraction of a cent. That is fine for compliance queries that run tens of times per month, not tens of times per second. Real-time customer-facing features should only use the hot PostgreSQL tier."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Automated Archival Pipeline with Compliance Validation",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "Implement the full 4-step archival pipeline for a monthly transactions partition: (1) export to S3 as Parquet using the Python script template from this lesson, (2) register in the AWS Glue catalog and verify the row count via Athena (mark VERIFIED in archival_log), (3) DETACH the partition (CONCURRENTLY from an external job, or a plain DETACH with lock_timeout inside a procedure), (4) DROP TABLE only for VERIFIED partitions. Wrap the database side in a pg_cron scheduled procedure with error handling — if any step fails, it must log the failure and halt without proceeding to DROP TABLE."
    },
    {
      "id": "2",
      "description": "Build a cross-tier compliance query service in Java that transparently queries both the hot PostgreSQL tier (last 24 months) and the cold S3/Athena tier (older data) based on the requested date range. The service should merge and sort results from both tiers. Write an integration test using Testcontainers for PostgreSQL and LocalStack for S3 (Athena emulation needs LocalStack's paid edition — otherwise stub the Athena client) that verifies a 3-year query spanning both tiers returns all records in correct chronological order."
    },
    {
      "id": "3",
      "description": "Design and implement the archival log table that tracks every archival operation: partition name, row count before and after, S3 path, archive timestamp, verification status (PENDING / VERIFIED / FAILED), and the operator who approved the DROP. Write the SQL to query this table for the current archival status of all partitions, showing which are in PostgreSQL, which are verified in S3, and which are pending verification."
    },
    {
      "id": "4",
      "description": "Implement the GDPR right-to-erasure workflow for archived data. When a customer requests deletion, their transaction data must be deleted from both the hot PostgreSQL tier AND redacted in archived S3 files. Design the redaction strategy (you cannot modify Parquet files in place — what are the options?), implement a tracking mechanism for pending erasure requests in archived partitions, and write the procedure that creates a new redacted Parquet file and replaces the original in S3."
    }
  ]
}
-->
