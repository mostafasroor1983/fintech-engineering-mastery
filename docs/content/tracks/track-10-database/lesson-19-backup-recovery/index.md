---
id: track-10-lesson-19
title: "Backup and Recovery — Point-in-Time Recovery for Finance"
slug: backup-recovery
track: track-10
trackName: "Database & Data Architecture"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [backup, PITR, pg_basebackup, WAL-archiving, recovery]
prerequisites: [track-10-lesson-11]
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
- Core payment processing: RPO = 0 (zero data loss), RTO = 15 minutes
- Reporting databases: RPO = 1 hour, RTO = 4 hours
- Archive databases: RPO = 24 hours, RTO = 48 hours

## 2. pg_basebackup — Base Backups

`pg_basebackup` creates a consistent snapshot of the entire PostgreSQL cluster directory.

```bash
# Full base backup to S3 (streamed through compression)
# This backup can be used as the starting point for PITR

pg_basebackup \
  --host=db-primary.internal \
  --port=5432 \
  --username=backup_user \
  --pgdata=/var/backups/postgresql/$(date +%Y%m%d_%H%M%S) \
  --format=tar \
  --gzip \
  --compress=9 \
  --checkpoint=fast \
  --progress \
  --write-recovery-conf \
  --slot=base_backup_slot \  # use replication slot to track WAL needed
  --wal-method=stream        # stream WAL during backup (reduces post-backup WAL gap)

# Upload to S3
aws s3 sync /var/backups/postgresql/${BACKUP_DIR} \
  s3://company-db-backups/postgresql/base/${BACKUP_DIR}/ \
  --server-side-encryption aws:kms \
  --sse-kms-key-id ${KMS_KEY_ARN}

# Verify backup
aws s3 ls s3://company-db-backups/postgresql/base/${BACKUP_DIR}/ --recursive
```

```sql
-- Create a dedicated backup user (principle of least privilege)
CREATE USER backup_user WITH REPLICATION LOGIN PASSWORD 'strong_backup_password';
GRANT SELECT ON pg_catalog.pg_tablespace TO backup_user;

-- Create a replication slot for base backup
-- This ensures WAL isn't cleaned up before the base backup completes
SELECT pg_create_physical_replication_slot('base_backup_slot', true);
```

## 3. Continuous WAL Archiving to S3

PITR requires both a base backup AND the WAL segments generated after the base backup. `archive_command` sends each completed WAL segment to storage.

```bash
# /etc/postgresql/16/main/postgresql.conf

wal_level = replica                           # minimum for archiving
archive_mode = on
archive_command = 'aws s3 cp %p s3://company-db-backups/postgresql/wal/%f \
                   --server-side-encryption aws:kms \
                   --sse-kms-key-id ${KMS_KEY_ARN} \
                   && echo "Archived: %p -> %f"'
# %p = absolute path to WAL segment
# %f = filename of WAL segment

archive_timeout = 60     # force WAL segment switch every 60 seconds
                         # ensures RPO <= 60 seconds even during low activity

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
    private final MeterRegistry metrics;

    @Scheduled(fixedRate = 60_000)
    public void monitorArchiving() {
        jdbcTemplate.queryForObject(
            """
            SELECT archived_count, failed_count,
                   EXTRACT(EPOCH FROM (NOW() - last_archived_time)) AS seconds_since_archive
            FROM pg_stat_archiver
            """,
            (rs, row) -> {
                long failed = rs.getLong("failed_count");
                double secondsSince = rs.getDouble("seconds_since_archive");

                metrics.gauge("wal.archive.failed_count", failed);
                metrics.gauge("wal.archive.seconds_since_last", secondsSince);

                if (failed > 0) {
                    log.error("WAL archiving failures detected: {} segments failed", failed);
                }
                if (secondsSince > 180) {
                    log.warn("WAL archiving stalled: {} seconds since last archive", secondsSince);
                }
                return null;
            }
        );
    }
}
```

## 4. PITR Configuration and Recovery

Point-in-Time Recovery allows restoring the database to any moment in history, up to the resolution of `archive_timeout`.

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

# Step 5: Configure postgresql.conf for recovery
cat >> /var/lib/postgresql/16/main/postgresql.conf << 'EOF'
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
```

### Recovery Target Options

```bash
# Recover to a specific time (most useful for accidental data corruption)
recovery_target_time = '2024-01-15 14:32:00 UTC'

# Recover to a specific LSN (useful when you know the exact WAL position)
recovery_target_lsn = '1/2345678'

# Recover to a named restore point (best practice: create restore points before risky operations)
recovery_target_name = 'before_migration_v45'

# Create restore point before running risky DDL
SELECT pg_create_restore_point('before_migration_v45');
-- Then run the migration
-- If migration fails: recover to 'before_migration_v45'
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
repo1-s3-key=/run/secrets/s3-access-key
repo1-s3-key-secret=/run/secrets/s3-secret-key
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=strong_encryption_passphrase

# Retention: keep 7 full backups, 14 days of WAL
repo1-retention-full=7
repo1-retention-diff=4
repo1-retention-archive=14

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
  --target="2024-01-15 14:32:00" \
  --target-action=promote \
  --type=time

# Restore specific database only (tablespace restore)
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

START_TIME=$(date +%s)
echo "Recovery test started at $(date -u)"

# Step 1: Note the target recovery time
TARGET_TIME="2024-01-15 14:30:00 UTC"
echo "Target recovery time: ${TARGET_TIME}"

# Step 2: Restore base backup
pgbackrest --stanza=payments restore \
  --target="${TARGET_TIME}" \
  --target-action=promote \
  --type=time
RESTORE_CMD_TIME=$(date +%s)
echo "Base backup restored at $(date -u). Elapsed: $((RESTORE_CMD_TIME - START_TIME))s"

# Step 3: Wait for PostgreSQL to start and replay WAL
systemctl start postgresql
while ! pg_isready -h localhost -U postgres; do
  sleep 5
done
READY_TIME=$(date +%s)
echo "Database ready at $(date -u). Total RTO: $((READY_TIME - START_TIME))s"

# Step 4: Verify data integrity
ROW_COUNT=$(psql -h localhost -U postgres -d payments \
  -t -c "SELECT COUNT(*) FROM transactions WHERE created_at < '${TARGET_TIME}'")
echo "Transactions recovered: ${ROW_COUNT}"

# Step 5: Verify no transactions after target time (RPO validation)
FUTURE_ROWS=$(psql -h localhost -U postgres -d payments \
  -t -c "SELECT COUNT(*) FROM transactions WHERE created_at >= '${TARGET_TIME}'")
echo "Transactions after target (should be 0): ${FUTURE_ROWS}"

echo "Recovery test complete. RTO: $((READY_TIME - START_TIME)) seconds"
```

## 8. Cloud-Managed Backups — AWS RDS

```
AWS RDS Automated Backups:
  - Daily full backup (taken during maintenance window)
  - Continuous transaction log backup (every 5 minutes)
  - Retention: 1-35 days (configure based on RPO requirements)
  - PITR granularity: 5 minutes
  - Cost: storage for backup = same as database storage

AWS RDS Manual Snapshots:
  - Triggered manually or via automation
  - Persist until explicitly deleted
  - Used for pre-migration snapshots, long-term retention
  - Cross-region copy for DR

Best practice: RDS automated backups + manual snapshot before every migration
```

```java
@Service
@Slf4j
public class RdsBackupService {

    private final AmazonRDS rdsClient;

    /**
     * Create a manual snapshot before schema migration.
     * Naming convention: pre-migration-{version}-{timestamp}
     */
    public String createPreMigrationSnapshot(String dbInstanceId, String migrationVersion) {
        String snapshotId = String.format("pre-migration-%s-%s",
            migrationVersion,
            Instant.now().toString().replace(":", "-").replace(".", "-")
        );

        CreateDBSnapshotRequest request = new CreateDBSnapshotRequest()
            .withDBSnapshotIdentifier(snapshotId)
            .withDBInstanceIdentifier(dbInstanceId)
            .withTags(
                new Tag().withKey("migration-version").withValue(migrationVersion),
                new Tag().withKey("created-by").withValue("payment-deployment"),
                new Tag().withKey("auto-delete-after").withValue(
                    LocalDate.now().plusDays(30).toString()
                )
            );

        DBSnapshot snapshot = rdsClient.createDBSnapshot(request);

        log.info("Created pre-migration snapshot: {} (status: {})",
            snapshotId, snapshot.getStatus());

        // Wait for snapshot to complete
        waitForSnapshot(snapshotId);

        return snapshotId;
    }

    private void waitForSnapshot(String snapshotId) {
        while (true) {
            DescribeDBSnapshotsResult result = rdsClient.describeDBSnapshots(
                new DescribeDBSnapshotsRequest()
                    .withDBSnapshotIdentifier(snapshotId)
            );

            String status = result.getDBSnapshots().get(0).getStatus();

            if ("available".equals(status)) {
                log.info("Snapshot {} is available", snapshotId);
                return;
            }

            if ("failed".equals(status)) {
                throw new RuntimeException("Snapshot failed: " + snapshotId);
            }

            log.info("Snapshot {} status: {}", snapshotId, status);
            try { Thread.sleep(30_000); } catch (InterruptedException e) { break; }
        }
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
@Scheduled(cron = "0 0 6 * * *")  // 06:00 UTC daily
@Slf4j
public class BackupHealthCheck {

    private final JdbcTemplate jdbcTemplate;
    private final AlertService alertService;

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
> RDS automated backups are retained for a maximum of 35 days. For the 7-year regulatory retention requirement, automated backups are NOT sufficient. You must separately export database dumps or snapshots to S3 with an appropriate retention policy, or use pgBackRest configured for long-term S3 retention. The regulatory requirement for 7-year retention must be explicitly configured — it will not happen automatically.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment database has archive_timeout = 300 (5 minutes). A burst of 10,000 transactions is processed at 09:00, then no transactions occur until 15:00. What is the worst-case RPO (data loss window) during the quiet period?",
      "options": [
        "0 seconds — WAL is archived immediately when each transaction commits",
        "5 minutes — archive_timeout forces a WAL segment switch every 5 minutes even without writes, ensuring WAL is archived at that interval",
        "6 hours — the entire quiet period between 09:00 and 15:00 is at risk",
        "It depends on the archive_command execution time"
      ],
      "correct": 1,
      "explanation": "WAL segments are archived when they are full (16MB by default) OR when archive_timeout expires. During low-activity periods, a WAL segment may remain partially filled for a long time before being archived. archive_timeout = 300 forces PostgreSQL to switch to a new WAL segment every 300 seconds, even if the current segment is not full, ensuring the last segment is archived within 5 minutes. For RPO = 5 minutes, set archive_timeout = 300. For RPO = 1 minute, set archive_timeout = 60 (at the cost of more small WAL files in S3)."
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
      "explanation": "RDS automated backups have a maximum retention of 35 days — this is a hard limit in the AWS API. For 7-year BSA/AML retention, a completely separate archival strategy is required. Options include: (1) monthly RDS snapshot exports to S3 with explicit S3 lifecycle configured for 7-year retention, (2) pgBackRest with repo1-retention-full configured and S3 as the repository, (3) the tiered archival approach from Lesson 18 (partition + export to Parquet). The key point is that BSA compliance requires explicit engineering effort — it does not happen by default with any managed database service."
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
    {"id": "1", "description": "Configure a complete PITR setup for a Testcontainers PostgreSQL 16 instance: set wal_level=replica, enable archive_mode=on, write an archive_command that copies WAL segments to a local directory (simulating S3), and set archive_timeout=60. Insert 1,000 transactions, capture a restore point with pg_create_restore_point('before_delete'), then DELETE 100 transactions. Perform a full PITR to the named restore point and verify the 100 deleted transactions are restored."},
    {"id": "2", "description": "Implement the quarterly RTO measurement script from this lesson as a runnable shell script. The script should: provision a fresh PostgreSQL instance, restore a pgBackRest backup to a specified target time, wait for database readiness, verify row counts at the recovery point, and output a JSON report with measured RTO in seconds, RPO accuracy in seconds, and rows recovered. Add assertions that fail if measured RTO > 1800 seconds or RPO > 300 seconds."},
    {"id": "3", "description": "Build the WAL archive monitoring service from this lesson as a production-ready Spring Boot component: schedule it to run every 60 seconds, expose the archive status as Micrometer gauges (wal.archive.failed_count, wal.archive.seconds_since_last), define alert conditions for failed_count > 0 and lag > 180 seconds, and write unit tests with a mocked JdbcTemplate that verify the correct alerts fire for each condition."},
    {"id": "4", "description": "Design the backup governance policy for a payment platform with these requirements: RPO = 5 minutes for the core payments database, RPO = 1 hour for the reporting database, 7-year retention for transaction data, 90-day retention for session and rate-limit data. Write the pgBackRest and S3 lifecycle configurations for each database, calculate the monthly storage cost for each tier, and document the runbook for each recovery scenario (single table corruption, full instance failure, region failure)."}
  ]
}
-->
