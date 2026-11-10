---
id: track-10-lesson-18
title: "Data Archival — Cold Storage and Tiered Data Management"
slug: data-archival
track: track-10
trackName: "Database & Data Architecture"
sequence: 18
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [archival, cold-storage, data-lifecycle, tiering, S3]
prerequisites: [track-10-lesson-06]
---

# Data Archival — Cold Storage and Tiered Data Management

> [!NOTE]
> The Bank Secrecy Act (BSA) requires retention of transaction records for at least 5 years; anti-money laundering regulations commonly require 7 years. Storing 7 years of transactions in a single hot PostgreSQL table is prohibitively expensive. Tiered archival moves old data to progressively cheaper storage while maintaining the ability to query it for compliance.

## 1. Regulatory Retention Requirements

```
Financial data retention schedule (US, common framework):
  - Transaction records (AML/BSA): 5-7 years
  - Customer identification (KYC): 5 years after account closure
  - Suspicious Activity Reports (SARs): 5 years
  - Wire transfer records: 5 years
  - Customer agreements: 7 years

GDPR (EU) consideration:
  - Financial data processed under "legal obligation" basis is exempt from
    the right to erasure during the mandatory retention period
  - After retention period expires: deletion is REQUIRED (not optional)
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
FROZEN   S3 Glacier       $0.004         3-5 hours       >7 years
         (compliance only, pre-deletion)
```

For a system with 10M transactions/month at ~1KB each:
- 7 years = 840M transactions = 840GB of raw data
- Hot tier (6 months): 60M rows = 60GB on RDS = $6.90/month
- Cold tier (remaining 6.5 years): 780M rows = 780GB on S3 = $17.94/month
- vs keeping everything hot: $96.60/month
- **Savings: ~80% by tiering data properly**

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
-- CONCURRENTLY: non-blocking in PostgreSQL 14+
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

PARTITION_NAME="transactions_2023_01"
S3_BUCKET="s3://company-financial-archive"
S3_PATH="${S3_BUCKET}/transactions/year=2023/month=01/"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Export as compressed CSV (simple, universally readable)
psql -h ${DB_HOST} -U ${DB_USER} -d payments \
  -c "\COPY ${PARTITION_NAME} TO STDOUT CSV HEADER" \
  | gzip > "/tmp/${PARTITION_NAME}_${TIMESTAMP}.csv.gz"

# Upload to S3
aws s3 cp "/tmp/${PARTITION_NAME}_${TIMESTAMP}.csv.gz" \
  "${S3_PATH}${PARTITION_NAME}_${TIMESTAMP}.csv.gz" \
  --server-side-encryption aws:kms \
  --sse-kms-key-id "${KMS_KEY_ARN}" \
  --storage-class STANDARD_IA

# Verify upload
aws s3api head-object \
  --bucket "company-financial-archive" \
  --key "transactions/year=2023/month=01/${PARTITION_NAME}_${TIMESTAMP}.csv.gz"

echo "Archive complete: ${PARTITION_NAME} -> S3"
```

### Step 3: Export as Parquet (for Athena Query Performance)

```python
# convert_to_parquet.py
import psycopg2
import pyarrow as pa
import pyarrow.parquet as pq
import boto3
import pandas as pd

def export_partition_to_parquet(partition_name: str, s3_path: str):
    conn = psycopg2.connect(
        host=os.environ['DB_HOST'],
        dbname='payments',
        user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD']
    )

    # Read in chunks to avoid memory exhaustion
    chunk_size = 100_000
    chunks = []

    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM {partition_name}")
        total_rows = cur.fetchone()[0]
        print(f"Exporting {total_rows} rows from {partition_name}")

        cur.execute(f"SELECT * FROM {partition_name}")

        while True:
            rows = cur.fetchmany(chunk_size)
            if not rows:
                break
            df = pd.DataFrame(rows, columns=[desc[0] for desc in cur.description])
            chunks.append(pa.Table.from_pandas(df))

    # Write partitioned Parquet files
    combined = pa.concat_tables(chunks)
    pq.write_to_dataset(
        combined,
        root_path=s3_path,
        partition_cols=['currency'],  # partition by currency for efficient Athena queries
        compression='snappy',
        use_dictionary=True
    )

    print(f"Exported {total_rows} rows to {s3_path}")
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

Intelligent-Tiering tiers:
- **Frequent Access**: objects accessed recently
- **Infrequent Access**: objects not accessed for 30 days (45% lower cost)
- **Archive Instant Access**: 90 days (68% lower cost, millisecond retrieval)
- **Archive Access**: 90-180 days (71% lower cost, 3-5 minute retrieval)
- **Deep Archive**: >180 days (95% lower cost, 12 hour retrieval)

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
    SELECT id FROM accounts WHERE customer_id = 'cust-001'
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

    private final AmazonAthena athenaClient;
    private final JdbcTemplate jdbcTemplate;

    /**
     * Regulatory query: retrieve all transactions for a subject access request (SAR).
     * May span both hot (PostgreSQL) and cold (Athena/S3) data.
     */
    public List<TransactionRecord> getTransactionsForCompliance(
            UUID customerId,
            Instant from,
            Instant to) {

        List<TransactionRecord> results = new ArrayList<>();

        // Hot tier: PostgreSQL (last 2 years)
        Instant hotCutoff = Instant.now().minus(Duration.ofDays(730));

        if (to.isAfter(hotCutoff)) {
            Instant hotFrom = from.isAfter(hotCutoff) ? from : hotCutoff;
            results.addAll(queryHotTier(customerId, hotFrom, to));
        }

        // Cold tier: Athena/S3 (data older than 2 years)
        if (from.isBefore(hotCutoff)) {
            Instant coldTo = to.isBefore(hotCutoff) ? to : hotCutoff;
            results.addAll(queryColdTier(customerId, from, coldTo));
        }

        return results.stream()
            .sorted(Comparator.comparing(TransactionRecord::getCreatedAt))
            .collect(Collectors.toList());
    }

    private List<TransactionRecord> queryHotTier(
            UUID customerId, Instant from, Instant to) {
        return jdbcTemplate.query(
            """
            SELECT t.id, t.amount, t.currency, t.status, t.created_at
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE a.customer_id = ?
              AND t.created_at BETWEEN ? AND ?
            ORDER BY t.created_at
            """,
            this::mapRow,
            customerId, from, to
        );
    }

    private List<TransactionRecord> queryColdTier(
            UUID customerId, Instant from, Instant to) {
        // Build Athena query with partition predicates for cost efficiency
        String years = getYearRange(from, to);
        String athenaQuery = String.format(
            """
            SELECT id, amount, currency, status, created_at
            FROM transactions_archive
            WHERE year IN (%s)
              AND account_id IN (
                SELECT CAST(id AS VARCHAR) FROM accounts_reference
                WHERE customer_id = '%s'
              )
              AND created_at BETWEEN TIMESTAMP '%s' AND TIMESTAMP '%s'
            ORDER BY created_at
            """,
            years, customerId, from, to
        );

        return executeAthenaQuery(athenaQuery);
    }

    private List<TransactionRecord> executeAthenaQuery(String sql) {
        StartQueryExecutionRequest request = StartQueryExecutionRequest.builder()
            .queryString(sql)
            .queryExecutionContext(QueryExecutionContext.builder()
                .database("financial_archive")
                .build())
            .resultConfiguration(ResultConfiguration.builder()
                .outputLocation("s3://company-athena-results/compliance-queries/")
                .build())
            .workGroup("compliance-queries")
            .build();

        String executionId = athenaClient.startQueryExecution(request)
            .queryExecutionId();

        return pollForResults(executionId);
    }
}
```

## 7. Archival Pipeline Automation with pg_cron

```sql
-- Install pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Create the archival procedure
CREATE OR REPLACE PROCEDURE archive_old_partition(
    months_ago INT DEFAULT 13
) LANGUAGE plpgsql AS $$
DECLARE
    target_date DATE;
    partition_name TEXT;
    archive_status TEXT;
BEGIN
    target_date := DATE_TRUNC('month', NOW() - (months_ago || ' months')::INTERVAL);
    partition_name := 'transactions_' || TO_CHAR(target_date, 'YYYY_MM');

    -- Check if partition exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = partition_name
    ) THEN
        RAISE NOTICE 'Partition % does not exist, skipping', partition_name;
        RETURN;
    END IF;

    -- Step 1: Verify archive exists in S3 (call external validation)
    -- This is a placeholder: in practice, call an external service or check a table
    SELECT status INTO archive_status
    FROM archival_log
    WHERE partition_name = partition_name
      AND status = 'ARCHIVED';

    IF archive_status IS NULL THEN
        RAISE WARNING 'Partition % not yet archived to S3, skipping drop', partition_name;
        RETURN;
    END IF;

    -- Step 2: Detach partition
    EXECUTE FORMAT(
        'ALTER TABLE transactions DETACH PARTITION %I CONCURRENTLY',
        partition_name
    );
    RAISE NOTICE 'Detached partition: %', partition_name;

    -- Step 3: Drop the partition
    EXECUTE FORMAT('DROP TABLE %I', partition_name);
    RAISE NOTICE 'Dropped partition: %', partition_name;

    -- Step 4: Log the archival
    INSERT INTO archival_log (partition_name, action, completed_at)
    VALUES (partition_name, 'DROPPED_LOCAL', NOW());
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
  Savings vs Option A: 80.5%

Option C: Partitioned PostgreSQL (hot, no cold tier)
  Same RDS cost as Option A: $96.60/month
  Benefit: instant queries, no Athena complexity
  Recommended if: compliance queries are frequent (> 100/month)
  Recommended if: regulatory queries require < 1 second response time
```

## 9. Restoring Archived Partitions On-Demand

```sql
-- Regulatory request: need all transactions from Q1 2021 immediately
-- Step 1: Create staging table
CREATE TABLE transactions_2021_01_restored (LIKE transactions INCLUDING ALL);
CREATE TABLE transactions_2021_02_restored (LIKE transactions INCLUDING ALL);
CREATE TABLE transactions_2021_03_restored (LIKE transactions INCLUDING ALL);
```

```bash
# Step 2: Download from S3 and restore
for month in 01 02 03; do
  aws s3 cp \
    "s3://company-financial-archive/transactions/year=2021/month=${month}/" \
    "/tmp/restore_2021_${month}/" \
    --recursive

  # Decompress and load
  gunzip /tmp/restore_2021_${month}/*.csv.gz

  psql -h ${DB_HOST} -U ${DB_USER} -d payments \
    -c "\COPY transactions_2021_${month}_restored FROM '/tmp/restore_2021_${month}/transactions.csv' CSV HEADER"

  echo "Restored 2021-${month}"
done
```

```sql
-- Step 3: Attach to parent table for transparent querying
ALTER TABLE transactions
    ATTACH PARTITION transactions_2021_01_restored
    FOR VALUES FROM ('2021-01-01') TO ('2021-02-01');

-- Now compliance query works transparently
SELECT * FROM transactions
WHERE account_id = 'acct-001'
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
        "VACUUM becomes increasingly slow as the table grows (autovacuum must scan more pages to find dead tuples), and query performance degrades because even date-filtered queries cannot prune rows without an index scan over the full table",
        "PostgreSQL cannot handle tables larger than 32TB so the system will eventually fail",
        "Backups take longer because pg_basebackup copies the entire database"
      ],
      "correct": 1,
      "explanation": "Without partitioning, VACUUM must scan the entire table to find dead tuples, even if only recent partitions have activity. This becomes prohibitively slow for multi-hundred-GB tables. Additionally, queries filtering by date must still access the full table's index pages. With time-based partitioning, VACUUM operates per-partition (only the active partition has dead tuples), and date-range queries benefit from partition pruning (the planner eliminates irrelevant partitions from the execution plan). These are the core operational reasons to partition time-series financial data."
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
        "Athena queries take 1-5 seconds for a typical compliance query (S3 read + distributed processing), compared to milliseconds in PostgreSQL — acceptable for infrequent compliance queries but not for real-time customer-facing features",
        "Athena queries always take more than 10 minutes due to Glacier cold storage retrieval",
        "Athena queries cannot filter by customer_id because S3 does not support indexed lookups"
      ],
      "correct": 1,
      "explanation": "Athena reads directly from S3 Standard (or Intelligent-Tiering Frequent/Infrequent tier) with latencies in the 1-5 second range for well-partitioned Parquet data. With proper S3 partitioning by year/month and Parquet columnar format, a compliance query scanning one year of data for one customer might scan only 10-100MB instead of 100GB (the full year), costing ~$0.0005 per query. This is acceptable for compliance queries that occur tens of times per month, not tens of times per second. For real-time customer-facing features, only the hot PostgreSQL tier should be used."
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
    {"id": "1", "description": "Implement the full 4-step archival pipeline for a monthly transactions partition: (1) DETACH PARTITION CONCURRENTLY, (2) export to S3 as Parquet using the Python script template from this lesson, (3) register in AWS Glue catalog, (4) verify row counts match before DROP TABLE. Wrap this in a pg_cron scheduled procedure with error handling — if any step fails, the procedure must log the failure and halt without proceeding to DROP TABLE."},
    {"id": "2", "description": "Build a cross-tier compliance query service in Java that transparently queries both the hot PostgreSQL tier (last 24 months) and the cold S3/Athena tier (older data) based on the requested date range. The service should merge and sort results from both tiers. Write an integration test using Testcontainers for PostgreSQL and LocalStack for S3/Athena that verifies a 3-year query spanning both tiers returns all records in correct chronological order."},
    {"id": "3", "description": "Design and implement the archival log table that tracks every archival operation: partition name, row count before and after, S3 path, archive timestamp, verification status (PENDING / VERIFIED / FAILED), and the operator who approved the DROP. Write the SQL to query this table for the current archival status of all partitions, showing which are in PostgreSQL, which are verified in S3, and which are pending verification."},
    {"id": "4", "description": "Implement the GDPR right-to-erasure workflow for archived data. When a customer requests deletion, their transaction data must be deleted from both the hot PostgreSQL tier AND redacted in archived S3 files. Design the redaction strategy (you cannot modify Parquet files in place — what are the options?), implement a tracking mechanism for pending erasure requests in archived partitions, and write the procedure that creates a new redacted Parquet file and replaces the original in S3."}
  ]
}
-->
