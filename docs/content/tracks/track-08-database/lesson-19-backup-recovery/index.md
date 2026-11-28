---
id: track-08-lesson-19
title: "Backup and Recovery — Point-in-Time Recovery for Finance"
slug: backup-recovery
track: track-08
trackName: "Database & Data Architecture"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [backup, PITR, pg_basebackup, WAL-archiving, recovery]
prerequisites: [track-08-lesson-11]
---

# Backup and Recovery — Point-in-Time Recovery for Finance

> [!NOTE]
> "You don't have a backup until you've restored it." This is not a cliché — it is the first principle of backup engineering. Financial systems that have never tested recovery from their backups will discover their backup was invalid during a production incident. Test recovery quarterly, measure RTO and RPO, and treat backup validation as a first-class engineering discipline.

## 1. Recovery Objectives Defined

Before configuring backups, define the targets:

```
RPO (Recovery Point Objective): 
  How much data can we afford to lose?
  
  Example: RPO = 5 minutes
  Meaning: In a disaster, we accept losing at most 5 minutes of transactions
  Achieved by: WAL archiving with continuous streaming + 5-minute archive interval

RTO (Recovery Time Objective):
  How long can we afford to be down during recovery?
  
  Example: RTO = 30 minutes
  Meaning: We must restore from backup and resume processing within 30 minutes
  Achieved by: Base backup size, network bandwidth, instance provisioning time
```

**Financial institution typical targets**:
- Core payment processing: RPO = 0 (zero data loss), RTO = 15 minutes — RPO 0 cannot come from backups alone; it needs synchronous replication to a standby (Lesson 08), with backups as the second line of defence
- Reporting databases: RPO = 1 hour, RTO = 4 hours
- Archive databases: RPO = 24 hours, RTO = 48 hours

## 2. pg_basebackup — Base Backups

`pg_basebackup` creates a consistent snapshot of the entire PostgreSQL cluster directory.

```bash
# Full base backup (tar format, compressed), later uploaded to S3.
# This backup can be used as the starting point for PITR.
set -euo pipefail
BACKUP_DIR=$(date +%Y%m%d_%H%M%S)

# --wal-method=stream: WAL needed to make the backup consistent is streamed
#   alongside it (PG10+ uses a TEMPORARY replication slot for this, so no
#   permanent slot is left behind to retain WAL forever)
# No --write-recovery-conf: that would make the restored copy a STANDBY
#   of the primary, which is not what a PITR backup should do
pg_basebackup \
  --host=db-primary.internal \
  --port=5432 \
  --username=backup_user \
  --pgdata="/var/backups/postgresql/${BACKUP_DIR}" \
  --format=tar \
  --gzip \
  --checkpoint=fast \
  --progress \
  --wal-method=stream

# Upload to S3
aws s3 sync "/var/backups/postgresql/${BACKUP_DIR}" \
  "s3://company-db-backups/postgresql/base/${BACKUP_DIR}/" \
  --sse aws:kms \
  --sse-kms-key-id "${KMS_KEY_ARN}"

# Verify the upload (a real check is a test RESTORE -- see Section 10)
aws s3 ls "s3://company-db-backups/postgresql/base/${BACKUP_DIR}/" --recursive
```

```sql
-- Create a dedicated backup user (principle of least privilege):
-- REPLICATION is all pg_basebackup needs
CREATE ROLE backup_user WITH REPLICATION LOGIN PASSWORD 'from-your-secret-store';

-- pg_hba.conf on the primary must allow it to use the replication protocol:
-- hostssl replication backup_user 10.0.5.0/24 scram-sha-256
```

## 3. Continuous WAL Archiving to S3

PITR requires both a base backup AND the WAL segments generated after the base backup. `archive_command` sends each completed WAL segment to storage.

```bash
# /etc/postgresql/16/main/postgresql.conf

wal_level = replica                           # minimum for archiving
archive_mode = on
archive_command = 'aws s3 cp %p s3://company-db-backups/postgresql/wal/%f --sse aws:kms'
# %p = path to WAL segment, %f = its file name
# archive_command must return non-zero on ANY failure (PostgreSQL then
# keeps the segment and retries) and should never overwrite an existing
# archived file. Starting the AWS CLI per 16MB segment is also slow; in
# production prefer a purpose-built tool: pgBackRest (archive-push, below)
# or WAL-G, which handle retries, parallelism, compression and checksums.

archive_timeout = 60     # switch to a new segment if any WAL was written in
                         # the last 60 s -> archived WAL is at most ~60 s
                         # (plus upload time) behind; costs more, partly
                         # empty 16MB files in the archive

# Restore command (used during PITR)
restore_command = 'aws s3 cp s3://company-db-backups/postgresql/wal/%f %p'
```

### Verifying WAL Archiving

```sql
-- Check archive status
SELECT
    archived_count,
    last_archived_wal,
    last_archived_time,
    failed_count,
    last_failed_wal,
    last_failed_time,
    NOW() - last_archived_time AS time_since_last_archive
FROM pg_stat_archiver;

-- Alert conditions:
-- failed_count > 0: archive_command is failing (S3 unreachable, permission error)
-- time_since_last_archive > 2 minutes: archiving may be stalled
-- last_failed_wal IS NOT NULL: specific segment failed to archive
```

```java
@Component
@Slf4j
public class WalArchiveMonitor {

    private final JdbcTemplate jdbcTemplate;
    // Gauges are registered ONCE on these holders; the job only updates them
    private final AtomicLong failedCount = new AtomicLong();
    private final AtomicLong secondsSinceArchive = new AtomicLong();

    public WalArchiveMonitor(JdbcTemplate jdbcTemplate, MeterRegistry metrics) {
        this.jdbcTemplate = jdbcTemplate;
        Gauge.builder("wal.archive.failed_count", failedCount, AtomicLong::get)
            .register(metrics);
        Gauge.builder("wal.archive.seconds_since_last", secondsSinceArchive, AtomicLong::get)
            .baseUnit("seconds")
            .register(metrics);
    }

    @Scheduled(fixedRate = 60_000)
    public void monitorArchiving() {
        Map<String, Object> row = jdbcTemplate.queryForMap("""
            SELECT failed_count,
                   EXTRACT(EPOCH FROM (NOW() - last_archived_time))::BIGINT
                       AS seconds_since_archive
            FROM pg_stat_archiver
            """);

        long failed = ((Number) row.get("failed_count")).longValue();
        // NULL = nothing archived yet since the stats were reset
        Number since = (Number) row.get("seconds_since_archive");
        long secondsSince = since == null ? Long.MAX_VALUE : since.longValue();

        failedCount.set(failed);
        secondsSinceArchive.set(secondsSince);

        // failed_count is cumulative: alert on its INCREASE (or on
        // last_failed_time > last_archived_time), not on "> 0" forever
        if (secondsSince > 180) {
            log.warn("WAL archiving stalled: {} seconds since last archive", secondsSince);
        }
    }
}
```

## 4. PITR Configuration and Recovery

Point-in-Time Recovery allows restoring the database to any moment between the oldest base backup and the newest archived WAL. `archive_timeout` decides how far the newest archived WAL can lag behind the live database.

### Recovery Configuration

```bash
# Step 1: Stop the failed PostgreSQL instance
systemctl stop postgresql

# Step 2: Move the corrupted data directory aside
mv /var/lib/postgresql/16/main /var/lib/postgresql/16/main_corrupted

# Step 3: Restore the base backup
mkdir /var/lib/postgresql/16/main
aws s3 sync \
  s3://company-db-backups/postgresql/base/20240115_020000/ \
  /tmp/base_backup_restore/

tar xzf /tmp/base_backup_restore/base.tar.gz -C /var/lib/postgresql/16/main/
chown -R postgres:postgres /var/lib/postgresql/16/main/

# Step 4: Create recovery configuration
cat > /var/lib/postgresql/16/main/recovery.signal << 'EOF'
# This file triggers recovery mode on startup
EOF

# Step 5: Configure recovery (Debian/Ubuntu keep postgresql.conf in /etc;
# remove these settings again once recovery is finished)
cat >> /etc/postgresql/16/main/postgresql.conf << 'EOF'
restore_command = 'aws s3 cp s3://company-db-backups/postgresql/wal/%f %p'

# Recover to a specific point in time (PITR)
# Example: recover to just before an accidental DELETE at 14:32:15 UTC
recovery_target_time = '2024-01-15 14:32:00 UTC'
recovery_target_action = 'promote'   # become primary after reaching target
recovery_target_inclusive = false    # stop BEFORE the target time
EOF

# Step 6: Start PostgreSQL — it will apply WAL until the target time
systemctl start postgresql

# Step 7: Monitor recovery progress
tail -f /var/log/postgresql/postgresql-16-main.log
# Look for: "recovery stopping before commit of transaction ..."
# Then: "database system is ready to accept connections"
# After promotion the server runs on a NEW timeline. Make sure the restored
# server does not archive into the same WAL location as the old primary
# unless that is intended (pgBackRest/WAL-G track timelines for you).
```

### Recovery Target Options

```ini
# Recover to a specific time (most useful for accidental data corruption)
recovery_target_time = '2024-01-15 14:32:00 UTC'

# Recover to a specific LSN (useful when you know the exact WAL position)
recovery_target_lsn = '1/2345678'

# Recover to a named restore point (best practice: create restore points before risky operations)
recovery_target_name = 'before_migration_v45'

# Before running risky DDL, create the restore point in psql:
#   SELECT pg_create_restore_point('before_migration_v45');
# Then run the migration. If it fails: recover to 'before_migration_v45'
```

## 5. pgBackRest — Enterprise-Grade Backup Management

`pgBackRest` is a full-featured backup tool with features pg_basebackup lacks: incremental backups, parallel restore, backup catalog, encryption, and S3 integration.

```ini
# /etc/pgbackrest/pgbackrest.conf

[global]
repo1-type=s3
repo1-s3-bucket=company-db-backups
repo1-s3-endpoint=s3.amazonaws.com
repo1-s3-region=us-east-1
repo1-s3-key-type=auto          # credentials from the instance's IAM role
repo1-cipher-type=aes-256-cbc
# repo1-cipher-pass: do not keep it in this file -- set it from a secret
# store via the PGBACKREST_REPO1_CIPHER_PASS environment variable

# Retention: keep full backups (and the WAL needed to restore them) for
# 14 days; without -type=time, retention values are COUNTS of backups
repo1-retention-full-type=time
repo1-retention-full=14
repo1-retention-diff=4           # keep the last 4 differential backups

# Logging
log-level-console=info
log-level-file=detail
log-path=/var/log/pgbackrest

[payments]
pg1-path=/var/lib/postgresql/16/main
pg1-host=db-primary.internal
pg1-user=pgbackrest
```

```bash
# Create a full backup
pgbackrest --stanza=payments --log-level-console=info backup

# Create a differential backup (faster than full, based on last full)
pgbackrest --stanza=payments --type=diff backup

# Create an incremental backup (based on last full or diff)
pgbackrest --stanza=payments --type=incr backup

# List available backups
pgbackrest --stanza=payments info

# Restore to latest
pgbackrest --stanza=payments restore

# Restore to specific time (PITR)
pgbackrest --stanza=payments restore \
  --target="2024-01-15 14:32:00+00" \
  --target-action=promote \
  --type=time

# Restore one database only: the other databases are restored as empty
# placeholders and must be dropped afterwards
pgbackrest --stanza=payments restore --db-include=payments_reporting
```

### pgBackRest Backup Schedule

```bash
# Crontab (or systemd timers)

# Full backup: weekly (Sunday 01:00)
0 1 * * 0 pgbackrest --stanza=payments --type=full backup

# Differential backup: daily except Sunday (02:00)
0 2 * * 1-6 pgbackrest --stanza=payments --type=diff backup

# WAL archiving: continuous (via archive_command)
# archive_command = 'pgbackrest --stanza=payments archive-push %p'
```

## 6. Backup Encryption

Financial data backups must be encrypted at rest and in transit.

```bash
# pgBackRest: symmetric encryption (AES-256-CBC)
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=passphrase_from_vault

# S3 server-side encryption (additional layer)
# Apply via S3 bucket policy requiring SSE-KMS
aws s3api put-bucket-encryption --bucket company-db-backups \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "arn:aws:kms:us-east-1:123456789:key/abc-def"
      },
      "BucketKeyEnabled": true
    }]
  }'
```

## 7. RTO/RPO Measurement

```bash
#!/bin/bash
# measure_rto.sh — Run quarterly in a production-like staging environment
set -euo pipefail

START_TIME=$(date +%s)
echo "Recovery test started at $(date -u)"

# Step 1: Note the target recovery time
TARGET_TIME="2024-01-15 14:30:00+00"
echo "Target recovery time: ${TARGET_TIME}"

# Step 2: Restore base backup (PostgreSQL must be stopped; --delta reuses
# matching files in the existing data directory)
systemctl stop postgresql
pgbackrest --stanza=payments restore --delta \
  --target="${TARGET_TIME}" \
  --target-action=promote \
  --type=time
RESTORE_CMD_TIME=$(date +%s)
echo "Base backup restored at $(date -u). Elapsed: $((RESTORE_CMD_TIME - START_TIME))s"

# Step 3: Start PostgreSQL and wait until WAL replay is FINISHED.
# pg_isready alone is not enough: with hot_standby = on the server accepts
# read-only connections while it is still replaying.
systemctl start postgresql
until [ "$(psql -h localhost -U postgres -XAtq -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = "f" ]; do
  sleep 5
done
READY_TIME=$(date +%s)
echo "Database promoted at $(date -u). Total RTO: $((READY_TIME - START_TIME))s"

# Step 4: Verify data integrity
ROW_COUNT=$(psql -h localhost -U postgres -d payments -XAtq \
  -c "SELECT COUNT(*) FROM transactions WHERE created_at < '${TARGET_TIME}'")
echo "Transactions recovered: ${ROW_COUNT}"

# Step 5: Rows after the target time (approximate RPO check: created_at is
# set by the application, recovery stops on COMMIT time)
FUTURE_ROWS=$(psql -h localhost -U postgres -d payments -XAtq \
  -c "SELECT COUNT(*) FROM transactions WHERE created_at >= '${TARGET_TIME}'")
echo "Transactions after target (should be ~0): ${FUTURE_ROWS}"

echo "Recovery test complete. RTO: $((READY_TIME - START_TIME)) seconds"
```

## 8. Cloud-Managed Backups — AWS RDS

```
AWS RDS Automated Backups:
  - Daily snapshot (taken during the backup window)
  - Transaction logs uploaded to S3 every 5 minutes
  - Retention: 1-35 days (configure based on recovery needs)
  - PITR: restore to any second within the retention period; the
    "latest restorable time" is usually within the last 5 minutes
  - Cost: backup storage up to the size of the provisioned database
    storage (per region) is included; beyond that it is billed

AWS RDS Manual Snapshots:
  - Triggered manually or via automation (or AWS Backup plans)
  - Persist until explicitly deleted
  - Used for pre-migration snapshots, long-term retention
  - Cross-region copy for DR

Best practice: RDS automated backups + manual snapshot before every migration
```

```java
@Service
@Slf4j
public class RdsBackupService {

    private final RdsClient rdsClient;   // AWS SDK v2 (v1 is end-of-support)

    /**
     * Create a manual snapshot before schema migration.
     * Naming convention: pre-migration-{version}-{timestamp}
     */
    public String createPreMigrationSnapshot(String dbInstanceId, String migrationVersion) {
        // Snapshot ids: letters, digits and hyphens only
        String snapshotId = String.format("pre-migration-%s-%s",
            migrationVersion.replaceAll("[^A-Za-z0-9-]", "-"),
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
                .withZone(ZoneOffset.UTC).format(Instant.now()));

        rdsClient.createDBSnapshot(CreateDbSnapshotRequest.builder()
            .dbSnapshotIdentifier(snapshotId)
            .dbInstanceIdentifier(dbInstanceId)
            .tags(
                Tag.builder().key("migration-version").value(migrationVersion).build(),
                Tag.builder().key("created-by").value("payment-deployment").build(),
                Tag.builder().key("auto-delete-after")
                    .value(LocalDate.now(ZoneOffset.UTC).plusDays(30).toString()).build())
            .build());

        log.info("Creating pre-migration snapshot: {}", snapshotId);

        // SDK waiter: polls until "available"; throws if the snapshot fails
        // or the waiter times out -- the migration must not start then
        rdsClient.waiter().waitUntilDBSnapshotAvailable(
            DescribeDbSnapshotsRequest.builder()
                .dbSnapshotIdentifier(snapshotId)
                .build());

        log.info("Snapshot {} is available", snapshotId);
        return snapshotId;
    }
}
```

## 9. Backup Monitoring Dashboard

```sql
-- Check backup health from pgBackRest info
-- (run from application or monitoring job)

-- Expected pgBackRest info output:
-- stanza: payments
--     status: ok
--     cipher: aes-256-cbc
--     db (current)
--         wal archive min/max (16): 000000010000000100000001/000000010000000100000050
--     full backup: 20240114-010000F
--         size: 85GB  delta: 85GB
--         runtime: 45min
--         backup start/stop: 2024-01-14 01:00:00 / 2024-01-14 01:45:00
--     diff backup: 20240115-020000D
--         prior backup: 20240114-010000F
--         size: 85GB  delta: 2.1GB  (small delta since full)
--         runtime: 8min
```

```java
@Component
@Slf4j
public class BackupHealthCheck {

    private final JdbcTemplate jdbcTemplate;
    private final AlertService alertService;

    // @Scheduled belongs on the METHOD; zone set explicitly
    @Scheduled(cron = "0 0 6 * * *", zone = "UTC")  // 06:00 UTC daily
    public void verifyBackupHealth() {
        // Check WAL archiving is current
        jdbcTemplate.queryForObject(
            """
            SELECT
                last_archived_time,
                failed_count,
                EXTRACT(EPOCH FROM (NOW() - last_archived_time)) AS lag_seconds
            FROM pg_stat_archiver
            """,
            (rs, row) -> {
                double lagSeconds = rs.getDouble("lag_seconds");
                long failedCount = rs.getLong("failed_count");

                if (failedCount > 0) {
                    alertService.critical("WAL archive failures: " + failedCount);
                }

                if (lagSeconds > 300) {  // 5 minutes
                    alertService.warning("WAL archiving lag: " + (int)lagSeconds + "s");
                }

                return null;
            }
        );
    }
}
```

## 10. Recovery Testing Procedure

```
Quarterly Recovery Test Checklist:

Pre-test:
[ ] Notify stakeholders of scheduled recovery test
[ ] Provision recovery environment (separate from production)
[ ] Record current production metrics for comparison

Recovery test:
[ ] Choose a random recovery point from the past 30 days
[ ] Start timer
[ ] Restore base backup to recovery environment
[ ] Apply WAL to reach recovery point
[ ] Record time when database accepts connections (RTO measurement)
[ ] Verify row counts match expected at recovery point
[ ] Verify no data exists after recovery point (RPO measurement)
[ ] Run application smoke tests against recovered database

Post-test:
[ ] Record measured RTO and RPO
[ ] Compare against targets (RTO < 30min, RPO < 5min)
[ ] Document findings in recovery runbook
[ ] If targets are missed: open engineering work to improve backup infrastructure
[ ] Archive test results for audit trail

Annual comprehensive test:
[ ] Full DR simulation: restore to different AWS region
[ ] Include Kafka topic restoration (if applicable)
[ ] Include Redis cache rebuilding procedure
[ ] Test upstream system failover (payment gateway connections)
[ ] Measure total system recovery time (not just database)
```

> [!WARNING]
> RDS automated backups are retained for a maximum of 35 days. For multi-year record retention they are NOT sufficient. Retention rules are about keeping the *records*: the usual answer is an archival pipeline (Lesson 18), optionally plus long-lived snapshots (manual snapshots or AWS Backup plans with multi-year retention). Note that old full-database backups also complicate GDPR erasure, because deleted personal data lives on in them. Long-term retention must be designed and configured explicitly — it will not happen automatically.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment database has archive_timeout = 300 (5 minutes). A burst of 10,000 transactions is processed at 09:00, then no transactions occur until 15:00. What is the worst-case RPO (data loss window) during the quiet period?",
      "options": [
        "0 seconds — WAL is archived immediately when each transaction commits",
        "About 5 minutes — archive_timeout forces a segment switch at most 5 minutes after WAL was written, so the burst's WAL is archived by about 09:05; during the idle period nothing new is written, so nothing more can be lost",
        "6 hours — the entire quiet period between 09:00 and 15:00 is at risk",
        "It depends on the archive_command execution time"
      ],
      "correct": 1,
      "explanation": "WAL segments are archived when they are full (16MB by default) OR when archive_timeout expires — but a switch only happens if some WAL was written since the last switch. So the partly filled segment holding the 09:00 burst is switched and archived within about 5 minutes (plus upload time). During the quiet period no WAL is written, no switches happen, and there is no new data at risk. For an RPO of about 1 minute, set archive_timeout = 60 (at the cost of more, mostly empty 16MB files in the archive); for RPO 0, use synchronous replication."
    },
    {
      "text": "During a PITR recovery, you set recovery_target_time = '2024-01-15 14:32:00 UTC' and recovery_target_inclusive = false. A malicious DELETE statement executed at exactly 14:32:00. Will this row be recovered?",
      "options": [
        "No — the target time exactly matches the DELETE, so with inclusive=false the DELETE is excluded and the row survives",
        "Yes — the DELETE is included because it committed before 14:32:00 (even by microseconds)",
        "It depends on the transaction commit time — if the transaction committed at 14:32:00.000 exactly, it is ambiguous",
        "recovery_target_inclusive only affects the final WAL record, not specific transactions"
      ],
      "correct": 0,
      "explanation": "recovery_target_inclusive = false means PostgreSQL stops recovery BEFORE the target time, excluding any transactions whose commit timestamp is at or after the target. If the DELETE committed at exactly 14:32:00, it is excluded — the row survives the recovery. This is intentional behavior for 'recover to just before the incident at 14:32:00'. If you want to recover including all transactions up to and at that exact second, set recovery_target_inclusive = true. Using pg_create_restore_point before risky operations is more reliable than time-based recovery."
    },
    {
      "text": "A financial services company relies solely on RDS automated backups with a 35-day retention period for their transaction database. BSA regulations require 7-year transaction retention. What is the compliance gap and the correct remediation?",
      "options": [
        "No gap — RDS backups can be extended to 7 years by increasing the retention period setting",
        "RDS automated backups max at 35 days. The gap is 7 years minus 35 days. Remediation requires a separate long-term retention strategy: monthly pg_dump exports to S3 with a 7-year retention lifecycle policy, or pgBackRest configured with S3 and repo retention settings for 7 years",
        "RDS Manual Snapshots automatically extend to 7 years for regulated industries",
        "The gap is covered by the application-level transaction logs stored in Kafka"
      ],
      "correct": 1,
      "explanation": "RDS automated backups have a maximum retention of 35 days — a hard limit. Multi-year BSA/AML retention needs a separate, explicit strategy: (1) the tiered archival pipeline from Lesson 18 (partition + export to Parquet with an S3 lifecycle and Object Lock), (2) long-lived snapshots — manual snapshots or AWS Backup plans with multi-year retention, and/or (3) pgBackRest with a long time-based repository retention. The key point: compliance retention requires explicit engineering effort — it does not happen by default with any managed database service."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "PITR Configuration and Recovery Validation",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {
      "id": "1",
      "description": "Configure a complete PITR setup for a Testcontainers PostgreSQL 16 instance: set wal_level=replica, enable archive_mode=on, write an archive_command that copies WAL segments to a local directory (simulating S3), and set archive_timeout=60. Insert 1,000 transactions, capture a restore point with pg_create_restore_point('before_delete'), then DELETE 100 transactions. Perform a full PITR to the named restore point and verify the 100 deleted transactions are restored."
    },
    {
      "id": "2",
      "description": "Implement the quarterly RTO measurement script from this lesson as a runnable shell script. The script should: provision a fresh PostgreSQL instance, restore a pgBackRest backup to a specified target time, wait for database readiness, verify row counts at the recovery point, and output a JSON report with measured RTO in seconds, RPO accuracy in seconds, and rows recovered. Add assertions that fail if measured RTO > 1800 seconds or RPO > 300 seconds."
    },
    {
      "id": "3",
      "description": "Build the WAL archive monitoring service from this lesson as a production-ready Spring Boot component: schedule it to run every 60 seconds, expose the archive status as Micrometer gauges registered once (wal.archive.failed_count, wal.archive.seconds_since_last), define alert conditions for an increase of failed_count and for lag > 180 seconds, and write unit tests with a mocked JdbcTemplate that verify the correct alerts fire for each condition."
    },
    {
      "id": "4",
      "description": "Design the backup governance policy for a payment platform with these requirements: RPO = 5 minutes for the core payments database, RPO = 1 hour for the reporting database, 7-year retention for transaction data, 90-day retention for session and rate-limit data. Write the pgBackRest and S3 lifecycle configurations for each database, calculate the monthly storage cost for each tier, and document the runbook for each recovery scenario (single table corruption, full instance failure, region failure)."
    }
  ]
}
-->
