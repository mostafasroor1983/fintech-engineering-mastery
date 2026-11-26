---
id: track-08-lesson-19
title: "النسخ الاحتياطي والاستعادة — الاستعادة لنقطة زمنية في القطاع المالي"
slug: backup-recovery
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [backup, PITR, pg_basebackup, WAL-archiving, recovery]
prerequisites: [track-08-lesson-11]
---

# النسخ الاحتياطي والاستعادة — الاستعادة لنقطة زمنية في المال

> [!NOTE]
> "ليس لديك نسخة احتياطية حتى تستعيدها." هذه ليست عبارة مبتذلة — إنها المبدأ الأول لهندسة النسخ الاحتياطي. والأنظمة المالية التي لم تختبر أبدًا الاستعادة من نسخها الاحتياطية ستكتشف أن نسختها غير صالحة أثناء حادث إنتاج. فاختبر الاستعادة كل ربع سنة، وقِس RTO وRPO، وعامل التحقق من النسخ الاحتياطية كتخصص هندسي من الدرجة الأولى.

## 1. تعريف أهداف الاستعادة

قبل إعداد النسخ الاحتياطية، حدد الأهداف:

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

**الأهداف المعتادة في المؤسسات المالية**:
- معالجة المدفوعات الجوهرية: RPO = 0 (لا فقد بيانات)، RTO = 15 دقيقة — ولا يمكن أن يأتي RPO 0 من النسخ الاحتياطية وحدها؛ بل يحتاج نسخًا متزامنًا إلى نسخة احتياطية جاهزة (الدرس 08)، مع النسخ الاحتياطية كخط دفاع ثانٍ
- قواعد بيانات التقارير: RPO = ساعة، RTO = 4 ساعات
- قواعد بيانات الأرشيف: RPO = 24 ساعة، RTO = 48 ساعة

## 2. ‏pg_basebackup — النسخ الأساسية

ينشئ `pg_basebackup` لقطة متسقة لمجلد عنقود PostgreSQL كاملًا.

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

## 3. الأرشفة المستمرة لـ WAL إلى S3

تتطلب PITR نسخة أساسية ومقاطع WAL المولّدة بعدها معًا. ويرسل `archive_command` كل مقطع WAL مكتمل إلى التخزين.

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

### التحقق من أرشفة WAL

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

## 4. إعداد PITR والاستعادة

تتيح الاستعادة لنقطة زمنية (PITR) استعادة قاعدة البيانات إلى أي لحظة بين أقدم نسخة أساسية وأحدث WAL مؤرشف. ويحدد `archive_timeout` إلى أي مدى قد يتأخر أحدث WAL مؤرشف عن قاعدة البيانات الحية.

### إعداد الاستعادة

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

### خيارات هدف الاستعادة

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

## 5. ‏pgBackRest — إدارة نسخ احتياطية بمستوى المؤسسات

‏`pgBackRest` أداة نسخ احتياطي متكاملة بميزات يفتقدها pg_basebackup: نسخ تزايدية، واستعادة متوازية، وفهرس للنسخ، وتشفير، وتكامل مع S3.

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

### جدول نسخ pgBackRest

```bash
# Crontab (or systemd timers)

# Full backup: weekly (Sunday 01:00)
0 1 * * 0 pgbackrest --stanza=payments --type=full backup

# Differential backup: daily except Sunday (02:00)
0 2 * * 1-6 pgbackrest --stanza=payments --type=diff backup

# WAL archiving: continuous (via archive_command)
# archive_command = 'pgbackrest --stanza=payments archive-push %p'
```

## 6. تشفير النسخ الاحتياطية

يجب تشفير النسخ الاحتياطية للبيانات المالية أثناء التخزين وأثناء النقل.

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

## 7. قياس RTO/RPO

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

## 8. النسخ الاحتياطية المُدارة سحابيًا — AWS RDS

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

## 9. لوحة مراقبة النسخ الاحتياطية

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

## 10. إجراء اختبار الاستعادة

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
> تُحفظ النسخ الاحتياطية الآلية في RDS لمدة أقصاها 35 يومًا. ولا تكفي للاحتفاظ بالسجلات لسنوات متعددة. فقواعد الاحتفاظ تتعلق بحفظ *السجلات*: والإجابة المعتادة خط أرشفة (الدرس 18)، مع لقطات طويلة الأمد اختياريًا (لقطات يدوية أو خطط AWS Backup باحتفاظ لسنوات). ولاحظ أن النسخ الاحتياطية القديمة لقاعدة البيانات كاملة تعقّد أيضًا المحو بموجب GDPR، لأن البيانات الشخصية المحذوفة تبقى حية فيها. ويجب تصميم الاحتفاظ طويل الأمد وإعداده صراحة — فلن يحدث تلقائيًا.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "قاعدة بيانات مدفوعات بها archive_timeout = 300 (5 دقائق). وتُعالج دفعة من 10,000 معاملة عند 09:00، ثم لا تحدث معاملات حتى 15:00. ما أسوأ RPO (نافذة فقد البيانات) أثناء فترة الهدوء؟",
      "options": [
        "0 ثانية — يُؤرشف WAL فورًا عند التزام كل معاملة",
        "نحو 5 دقائق — يفرض archive_timeout تبديل المقطع خلال 5 دقائق على الأكثر من كتابة WAL، فيُؤرشف WAL الدفعة بحلول 09:05 تقريبًا؛ وأثناء فترة الخمول لا يُكتب شيء جديد، فلا يمكن فقد المزيد",
        "6 ساعات — فترة الهدوء كلها بين 09:00 و15:00 معرضة للخطر",
        "يعتمد على زمن تنفيذ archive_command"
      ],
      "correct": 1,
      "explanation": "تُؤرشف مقاطع WAL حين تمتلئ (16MB افتراضيًا) أو حين تنتهي مهلة archive_timeout — لكن التبديل يحدث فقط إذا كُتب WAL منذ آخر تبديل. فالمقطع الممتلئ جزئيًا الذي يحمل دفعة 09:00 يُبدّل ويُؤرشف خلال نحو 5 دقائق (إضافة إلى زمن الرفع). وأثناء فترة الهدوء لا يُكتب WAL، ولا تحدث تبديلات، ولا توجد بيانات جديدة معرضة للخطر. ولـ RPO بنحو دقيقة، اضبط archive_timeout = 60 (مقابل ملفات 16MB أكثر وفارغة غالبًا في الأرشيف)؛ ولـ RPO 0، استخدم النسخ المتزامن."
    },
    {
      "text": "أثناء استعادة PITR، تضبط recovery_target_time = '2024-01-15 14:32:00 UTC' وrecovery_target_inclusive = false. ونُفذت عبارة DELETE خبيثة عند 14:32:00 بالضبط. هل سيُستعاد هذا الصف؟",
      "options": [
        "لا — يطابق الزمن المستهدف DELETE بالضبط، فمع inclusive=false يُستبعد DELETE ويبقى الصف",
        "نعم — يُضمّن DELETE لأنه التزم قبل 14:32:00 (ولو بأجزاء من الثانية)",
        "يعتمد على زمن التزام المعاملة — فإذا التزمت عند 14:32:00.000 بالضبط، يكون الأمر ملتبسًا",
        "‏recovery_target_inclusive يؤثر فقط على آخر سجل WAL، لا على معاملات محددة"
      ],
      "correct": 0,
      "explanation": "يعني recovery_target_inclusive = false أن PostgreSQL يوقف الاستعادة قبل الزمن المستهدف، مستبعدًا أي معاملات طابع التزامها عند الهدف أو بعده. فإذا التزم DELETE عند 14:32:00 بالضبط، يُستبعد — ويبقى الصف بعد الاستعادة. وهذا سلوك مقصود لـ 'الاستعادة إلى ما قبل الحادث عند 14:32:00 مباشرة'. وإذا أردت تضمين كل المعاملات حتى تلك الثانية بالضبط وعندها، فاضبط recovery_target_inclusive = true. واستخدام pg_create_restore_point قبل العمليات الخطرة أوثق من الاستعادة القائمة على الزمن."
    },
    {
      "text": "تعتمد شركة خدمات مالية فقط على النسخ الاحتياطية الآلية في RDS بفترة احتفاظ 35 يومًا لقاعدة بيانات معاملاتها. وتشترط أنظمة BSA الاحتفاظ بالمعاملات 7 سنوات. ما فجوة الامتثال والمعالجة الصحيحة؟",
      "options": [
        "لا فجوة — يمكن تمديد نسخ RDS إلى 7 سنوات بزيادة إعداد فترة الاحتفاظ",
        "الحد الأقصى للنسخ الآلية في RDS هو 35 يومًا. والفجوة 7 سنوات ناقص 35 يومًا. وتتطلب المعالجة استراتيجية احتفاظ طويلة الأمد منفصلة: تصديرات pg_dump شهرية إلى S3 بسياسة دورة حياة احتفاظ 7 سنوات، أو pgBackRest مُعدّ مع S3 وإعدادات احتفاظ المستودع لـ 7 سنوات",
        "تمتد لقطات RDS اليدوية تلقائيًا إلى 7 سنوات للصناعات الخاضعة للتنظيم",
        "تغطي سجلات المعاملات على مستوى التطبيق المخزنة في Kafka الفجوة"
      ],
      "correct": 1,
      "explanation": "للنسخ الاحتياطية الآلية في RDS حد أقصى للاحتفاظ 35 يومًا — حد صارم. والاحتفاظ متعدد السنوات بموجب BSA/AML يحتاج استراتيجية منفصلة وصريحة: (1) خط الأرشفة على طبقات من الدرس 18 (تقسيم + تصدير إلى Parquet مع دورة حياة S3 وObject Lock)، (2) لقطات طويلة الأمد — لقطات يدوية أو خطط AWS Backup باحتفاظ لسنوات، و/أو (3) pgBackRest باحتفاظ مستودع زمني طويل. والنقطة الأساسية: احتفاظ الامتثال يتطلب جهدًا هندسيًا صريحًا — ولا يحدث افتراضيًا مع أي خدمة قاعدة بيانات مُدارة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "إعداد PITR والتحقق من الاستعادة",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "اضبط إعداد PITR كاملًا لنسخة PostgreSQL 16 في Testcontainers: اضبط wal_level=replica، وفعّل archive_mode=on، واكتب archive_command ينسخ مقاطع WAL إلى مجلد محلي (محاكاة S3)، واضبط archive_timeout=60. وأدرج 1,000 معاملة، والتقط نقطة استعادة بـ pg_create_restore_point('before_delete')، ثم احذف 100 معاملة. ونفّذ PITR كاملة إلى نقطة الاستعادة المسماة وتحقق من استعادة المعاملات المحذوفة المئة."},
    {"id": "2", "description": "نفّذ سكربت قياس RTO الفصلي من هذا الدرس كسكربت shell قابل للتشغيل. ويجب أن يقوم السكربت بما يلي: تجهيز نسخة PostgreSQL جديدة، واستعادة نسخة pgBackRest إلى زمن مستهدف محدد، وانتظار جاهزية قاعدة البيانات، والتحقق من أعداد الصفوف عند نقطة الاستعادة، وإخراج تقرير JSON بقيمة RTO المقاسة بالثواني، ودقة RPO بالثواني، والصفوف المستعادة. وأضف تأكيدات تفشل إذا كان RTO المقاس > 1800 ثانية أو RPO > 300 ثانية."},
    {"id": "3", "description": "ابنِ خدمة مراقبة أرشفة WAL من هذا الدرس كمكوّن Spring Boot جاهز للإنتاج: جدولها لتعمل كل 60 ثانية، واكشف حالة الأرشفة كمقاييس Micrometer من نوع Gauge مسجلة مرة واحدة (wal.archive.failed_count، وwal.archive.seconds_since_last)، وعرّف شروط تنبيه لزيادة failed_count وللتأخر > 180 ثانية، واكتب اختبارات وحدة بـ JdbcTemplate وهمي تتحقق من إطلاق التنبيهات الصحيحة لكل شرط."},
    {"id": "4", "description": "صمم سياسة حوكمة النسخ الاحتياطي لمنصة دفع بهذه المتطلبات: RPO = 5 دقائق لقاعدة بيانات المدفوعات الجوهرية، وRPO = ساعة لقاعدة بيانات التقارير، واحتفاظ 7 سنوات لبيانات المعاملات، واحتفاظ 90 يومًا لبيانات الجلسات وحدود المعدل. واكتب إعدادات pgBackRest ودورة حياة S3 لكل قاعدة بيانات، واحسب كلفة التخزين الشهرية لكل طبقة، ووثّق دليل التشغيل لكل سيناريو استعادة (تلف جدول واحد، وفشل النسخة كاملة، وفشل المنطقة)."}
  ]
}
-->
