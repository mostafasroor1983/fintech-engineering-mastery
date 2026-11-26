---
id: track-06-lesson-11
title: "الإتاحة العالية لقواعد البيانات — أنماط PostgreSQL HA"
slug: database-ha
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 11
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [PostgreSQL, HA, Patroni, replication, failover]
prerequisites: [track-06-lesson-02]
---

# التوفر العالي لقاعدة البيانات — أنماط التوفر العالي في PostgreSQL

> [!NOTE]
> ‏PostgreSQL هي قاعدة البيانات العلائقية الافتراضية لتطبيقات التقنية المالية. ونسخها المتدفق المدمج، مع Patroni للتحول الآلي وPgBouncer لإدارة الاتصالات، يوفر توفرًا عاليًا بمستوى المؤسسات دون كلفة تراخيص Oracle. وفي أنظمة الدفع، ليس الاختيار بين النسخ المتزامن وغير المتزامن مفاضلة أداء — بل مفاضلة ديمومة بيانات بعواقب مالية مباشرة.

## نظرة عامة على بنية التوفر العالي

تتكون مجموعة PostgreSQL إنتاجية عالية التوفر من:

```
                    ┌─────────────────────┐
                    │  Patroni DCS         │
                    │  (etcd cluster)      │
                    └──────────┬──────────┘
                               │ leader election
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────┴──────┐    ┌──────────┴───────┐    ┌────────┴───────┐
│  Primary      │    │  Replica 1        │    │  Replica 2      │
│  PostgreSQL   │───▶│  (sync standby)   │    │  (async standby)│
│  Patroni      │───▶│  Patroni          │    │  Patroni        │
└──────┬───────┘    └──────────────────┘    └────────────────┘
       │
┌──────┴───────┐
│  PgBouncer   │  ← Application connects here
│  (pool)      │
└─────────────┘
```

## 1. النسخ المتدفق في PostgreSQL

النسخ المتدفق هو الأساس. فالخادم الرئيسي يبث سجل الكتابة المسبقة (WAL) إلى الخوادم الاحتياطية، التي تعيد تشغيله باستمرار.

```ini
# postgresql.conf (primary)
wal_level = replica              # minimum for replication
max_wal_senders = 10             # max concurrent replication connections
wal_keep_size = 1GB              # retain WAL segments for replication lag
hot_standby = on                 # allow reads on standby
archive_mode = on                # archive WAL for PITR
archive_command = 'aws s3 cp %p s3://pg-wal-archive/%f'

# Synchronous replication — critical for payment systems
# 'ANY 1 (replica1, replica2)' means at least one replica must confirm.
# (When Patroni runs with synchronous_mode, Patroni manages this setting
#  itself — do not also set it by hand.)
synchronous_standby_names = 'ANY 1 (replica1, replica2)'

# Connection for replication
# pg_hba.conf — scram-sha-256, not the older md5
host replication replicator 10.0.0.0/8 scram-sha-256
```

```ini
# postgresql.conf (standby)
hot_standby = on
hot_standby_feedback = on        # fewer query cancellations on the standby
                                 # (cost: vacuum on the primary waits -> some bloat)

# recovery.conf no longer exists (PostgreSQL 12+): these settings go in
# postgresql.conf, plus an empty standby.signal file in the data directory.
# Keep the password out of the config (e.g. a .pgpass file for the replicator user).
primary_conninfo = 'host=pg-primary port=5432 user=replicator application_name=replica1'
primary_slot_name = 'replica1_slot'  # replication slot ensures no WAL gap
```

## 2. إعداد Patroni

‏Patroni هو مدير التوفر العالي القياسي لـ PostgreSQL. ويستخدم مخزن إعدادات موزعًا (etcd، أو Consul، أو ZooKeeper) لانتخاب القائد وتنسيق التحول.

```yaml
# /etc/patroni/patroni.yml
scope: payment-postgres-cluster
namespace: /service/
name: pg-node-1

restapi:
  listen: 0.0.0.0:8008
  connect_address: 10.0.1.10:8008

etcd:
  hosts: 10.0.0.1:2379,10.0.0.2:2379,10.0.0.3:2379

bootstrap:
  dcs:
    ttl: 30                          # DCS lease TTL in seconds
    loop_wait: 10                    # Patroni loop interval
    retry_timeout: 30
    maximum_lag_on_failover: 1048576 # 1MB: reject failover if replica lag > 1MB

    # Critical for fintech: prevent data loss on failover
    synchronous_mode: true           # Patroni manages synchronous_standby_names and
                                     # fails over only to a synchronous standby
    synchronous_mode_strict: false   # false: if NO sync standby is available, the
                                     # primary keeps accepting writes asynchronously
                                     # (availability first). true: writes BLOCK until a
                                     # sync standby returns (zero data loss first).
                                     # Decide deliberately for a payment ledger.

    postgresql:
      use_pg_rewind: true            # fast rejoin after failover
      use_slots: true                # replication slots prevent WAL gap
      parameters:
        wal_level: replica
        max_wal_senders: 10
        max_replication_slots: 10
        wal_keep_size: 1GB
        hot_standby: on
        archive_mode: on
        archive_command: 'aws s3 cp %p s3://pg-wal-archive/%f'

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 10.0.1.10:5432
  data_dir: /var/lib/postgresql/data
  config_dir: /etc/postgresql
  authentication:
    replication:
      username: replicator
      password: "{{ replicator_password }}"
    superuser:
      username: postgres
      password: "{{ postgres_password }}"
    rewind:
      username: rewind_user
      password: "{{ rewind_password }}"
```

## 3. إدارة اتصالات PgBouncer أثناء التحول

يقف PgBouncer بين التطبيق وPostgreSQL. ولا يعرف بـ Patroni من تلقاء نفسه: فأثناء التحول تنقطع اتصالاته بالخادم الرئيسي القديم، وتفشل المعاملات قيد التنفيذ، وتنتظر الاستعلامات الجديدة (حتى `query_wait_timeout`) إلى أن يمكن فتح اتصال بالرئيسي الجديد. ويمكنك جعل ذلك أنعم بجعل دالة رد في Patroni تشغّل أمر `PAUSE` في PgBouncer قبل التبديل و`RESUME` بعده — فيرى العملاء توقفًا مؤقتًا بدل الأخطاء. وتحفظان لتجميع المعاملات: ميزات الجلسة (`SET`، والأقفال الاستشارية بنطاق الجلسة، و`LISTEN`) لا تعمل عبر المعاملات، والجمل المحضّرة تحتاج إما PgBouncer ‏1.21+ مع `max_prepared_statements` أو `prepareThreshold=0` في عنوان JDBC.

```ini
# pgbouncer.ini
[databases]
# payment_db points to Patroni's HAProxy VIP or DNS that updates on failover
payment_db = host=pg-vip port=5432 dbname=payment_db

[pgbouncer]
pool_mode = transaction             # transaction pooling for fintech (not session)
listen_addr = *
listen_port = 6432
max_client_conn = 500
default_pool_size = 20              # connections per database per user
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

# Failover behaviour
server_connect_timeout = 15        # max time to open a server connection
server_login_retry = 3             # SECONDS to wait before retrying a failed login
query_wait_timeout = 60            # a client query may wait up to 60s for a server connection

# Connection health
server_check_query = SELECT 1
server_check_delay = 30
server_lifetime = 3600
server_idle_timeout = 600
```

## 4. مراقبة تأخر النسخ

```sql
-- Monitor replication lag on the primary
SELECT
    client_addr,
    application_name,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    write_lag,
    flush_lag,
    replay_lag,
    sync_state
FROM pg_stat_replication
ORDER BY replay_lag DESC;

-- Alert if any replica is lagging > 10 seconds
-- Or LSN difference > 10MB (potential data loss in async failover)
SELECT
    application_name,
    pg_wal_lsn_diff(sent_lsn, replay_lsn) AS lag_bytes
FROM pg_stat_replication
WHERE pg_wal_lsn_diff(sent_lsn, replay_lsn) > 10 * 1024 * 1024;
```

```java
@Component
public class ReplicationLagMonitor {

    private final DataSource primaryDataSource;
    private final MeterRegistry meterRegistry;
    private final AlertService alertService;
    private static final Logger log = LoggerFactory.getLogger(ReplicationLagMonitor.class);

    // One holder per replica, registered as a gauge ONCE. (Calling
    // meterRegistry.gauge(name, tags, aDouble) every 30s registers a boxed value
    // that gets garbage-collected, and later calls return the first gauge.)
    private final Map<String, AtomicLong> lagMillis = new ConcurrentHashMap<>();
    private final Map<String, AtomicLong> lagBytesByReplica = new ConcurrentHashMap<>();

    public ReplicationLagMonitor(DataSource primaryDataSource, MeterRegistry meterRegistry,
                                 AlertService alertService) {
        this.primaryDataSource = primaryDataSource;
        this.meterRegistry = meterRegistry;
        this.alertService = alertService;
    }

    private static final String LAG_QUERY = """
        SELECT
            application_name,
            COALESCE(EXTRACT(EPOCH FROM replay_lag), 0)::FLOAT AS lag_seconds,
            pg_wal_lsn_diff(sent_lsn, replay_lsn)  AS lag_bytes
        FROM pg_stat_replication
        """;

    @Scheduled(fixedRate = 30_000)
    public void monitorReplicationLag() {
        try (Connection conn = primaryDataSource.getConnection();
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(LAG_QUERY)) {

            while (rs.next()) {
                String replicaName = rs.getString("application_name");
                double lagSeconds  = rs.getDouble("lag_seconds");
                long   lagBytes    = rs.getLong("lag_bytes");

                holder(lagMillis, "postgresql.replication.lag.millis", replicaName)
                    .set((long) (lagSeconds * 1000));
                holder(lagBytesByReplica, "postgresql.replication.lag.bytes", replicaName)
                    .set(lagBytes);

                // Alert thresholds
                if (lagSeconds > 120) {
                    alertService.critical("PG_REPLICATION_LAG_CRITICAL",
                            String.format("Replica %s lag critical: %.1fs",
                                    replicaName, lagSeconds));
                } else if (lagSeconds > 30) {
                    alertService.warning("PG_REPLICATION_LAG",
                            String.format("Replica %s lag: %.1fs / %d bytes",
                                    replicaName, lagSeconds, lagBytes));
                }
            }
        } catch (SQLException e) {
            log.error("Failed to query replication lag", e);
        }
    }

    private AtomicLong holder(Map<String, AtomicLong> map, String metric, String replica) {
        return map.computeIfAbsent(replica, r ->
            meterRegistry.gauge(metric, Tags.of("replica", r), new AtomicLong()));
    }
}
```

## 5. مفاضلة النسخ المتزامن مقابل غير المتزامن

هذا أهم قرار في التوفر العالي لـ PostgreSQL في التقنية المالية:

| النمط | الديمومة | الأداء | خطر التحول |
|---|---|---|---|
| متزامن (ANY 1) | مضمونة: البيانات الملتزمة على عقدتين أو أكثر | إنتاجية أقل: ينتظر إقرار النسخة | صفر فقدان للبيانات — إذا ذهب التحول إلى نسخة متزامنة (يضمن ذلك synchronous_mode في Patroni) |
| غير متزامن | غير مضمونة: قد تتأخر النسخة | إنتاجية أعلى: لا انتظار للنسخة | فقدان بيانات حتى `replay_lag` ثانية |

**لأنظمة الدفع**: استخدم النسخ المتزامن. فالخصم الملتزم على الرئيسي وغير المنسوخ إلى النسخة قد "يضيع" إذا فشل الرئيسي ورُقّيت النسخة غير المتزامنة. فقد قيل للعميل إن الدفعة نجحت — وربما غادر المال بالفعل عبر شبكة خارجية — لكن الرئيسي الجديد لا يملك أي سجل لها: خطأ مالي بأثر نقدي مباشر.

```java
@Component
public class SynchronousReplicationValidator {

    private final DataSource dataSource;
    private static final Logger log = LoggerFactory.getLogger(
            SynchronousReplicationValidator.class);

    // On startup, verify that synchronous replication is configured.
    // With Patroni (synchronous_mode, non-strict) the value can become EMPTY
    // later, when no sync standby is available — so also run this check on a
    // schedule (and alert on Patroni's own metrics), not only at startup.
    @PostConstruct
    public void validateSyncReplication() throws SQLException {
        try (Connection conn = dataSource.getConnection();
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(
                     "SHOW synchronous_standby_names")) {
            if (rs.next()) {
                String syncStandby = rs.getString(1);
                if (syncStandby == null || syncStandby.isBlank()) {
                    log.error("CRITICAL: synchronous_standby_names is not set. " +
                              "Payment system running with async replication — " +
                              "DATA LOSS RISK on failover.");
                    // Don't throw — we can still operate; but alert immediately
                    alertService.critical("ASYNC_REPLICATION_RISK",
                            "synchronous_standby_names is empty. " +
                            "Payment commits are not replicated synchronously.");
                } else {
                    log.info("Synchronous replication configured: {}", syncStandby);
                }
            }
        }
    }
}
```

## 6. إعادة اتصال DataSource في Spring Boot عند التحول

يجب أن يتعامل التطبيق برشاقة مع الانقطاع القصير أثناء التحول. وHikariCP بإعداد مناسب يتعامل مع ذلك تلقائيًا.

```yaml
# application.yml
spring:
  datasource:
    url: jdbc:postgresql://pg-vip:6432/payment_db
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 10000        # 10s — allows Patroni failover to complete
      idle-timeout: 300000             # 5 minutes
      max-lifetime: 1800000            # 30 minutes — recycle connections
      keepalive-time: 60000            # heartbeat every 60s
      validation-timeout: 3000
      # No connection-test-query: with a JDBC4 driver HikariCP uses
      # Connection.isValid(), which is cheaper and recommended
      initialization-fail-timeout: -1 # don't fail startup if the DB is briefly unavailable
      # HikariCP has no retry setting: after connection-timeout the request fails,
      # and the APPLICATION must retry (only operations that are safe to retry)
```

```java
@Component
public class DatabaseFailoverHandler {

    private final DataSource dataSource;
    private static final Logger log = LoggerFactory.getLogger(DatabaseFailoverHandler.class);

    // Test that application reconnects correctly after failover
    // Run this in chaos engineering exercises
    public void simulateFailoverRecovery() throws InterruptedException {
        log.info("Testing failover recovery...");

        // Test 1: Connection after failover (HikariCP should auto-reconnect)
        for (int attempt = 0; attempt < 10; attempt++) {
            try (Connection conn = dataSource.getConnection()) {
                try (Statement stmt = conn.createStatement()) {
                    stmt.execute("SELECT 1");
                    log.info("Connection OK on attempt {}", attempt + 1);
                    return;
                }
            } catch (SQLException e) {
                log.warn("Connection failed on attempt {}: {}",
                        attempt + 1, e.getMessage());
                Thread.sleep(3000);
            }
        }
        log.error("Failed to reconnect after 10 attempts");
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        // Log primary server identity on startup for debugging
        try (Connection conn = dataSource.getConnection();
             ResultSet rs = conn.createStatement()
                     .executeQuery("SELECT inet_server_addr(), pg_is_in_recovery()")) {
            if (rs.next()) {
                String host   = rs.getString(1);
                boolean isStandby = rs.getBoolean(2);
                log.info("Connected to PostgreSQL host={} isStandby={}",
                        host, isStandby);
                if (isStandby) {
                    alertService.warning("APP_CONNECTED_TO_STANDBY",
                            "Application is connected to a standby server. " +
                            "Writes will fail.");
                }
            }
        } catch (SQLException e) {
            log.error("Failed to identify PostgreSQL host", e);
        }
    }
}
```

## 7. منع الدماغ المنقسم (Split-Brain)

يحدث الدماغ المنقسم عندما تعتقد عقدتان كلتاهما أنها الرئيسية. ويمنعه Patroni باستخدام عقد إيجار مخزن الإعدادات الموزع (DCS): فالعقدة التي تمسك عقد الإيجار وحدها هي الرئيسية. وإذا لم يتوفر المخزن، يخفض Patroni الرئيسي (يضحي بالتوفر لصالح الاتساق). (يضيف Patroni ‏3.0+ نمطًا اختياريًا `failsafe_mode`: إذا تعطل المخزن لكن الرئيسي ما زال يصل إلى كل الأعضاء الآخرين، فقد يبقى رئيسيًا — استثناء متعمد من القاعدة.)

```yaml
# Patroni DCS settings — these prevent split-brain
bootstrap:
  dcs:
    ttl: 30                     # DCS lease expires after 30s
    loop_wait: 10               # check DCS every 10s
    retry_timeout: 30           # retry DCS operations for 30s before giving up

    # If primary can't reach DCS for ttl seconds, it demotes itself
    # This prevents split-brain but causes brief unavailability
    # For fintech: availability sacrifice is correct trade-off
```

```java
// Application-level protection: reject writes if connected to standby.
// Belt and braces only: the real protection is targetServerType=primary /
// the pooler pointing at the leader, and PostgreSQL itself rejects writes on
// a standby ("cannot execute ... in a read-only transaction").
// Use YOUR OWN annotation (e.g. com.bank.db.WriteOperation) — not Spring
// Boot Actuator's @WriteOperation, which has another meaning.
@Aspect
@Component
public class StandbyWriteProtection {

    private final DataSource dataSource;
    private volatile Boolean isStandby = null;

    @Around("@annotation(WriteOperation)")
    public Object protectFromStandbyWrite(ProceedingJoinPoint pjp) throws Throwable {
        if (Boolean.TRUE.equals(isStandby)) {
            throw new StandbyWriteException(
                    "Write operation rejected: connected to PostgreSQL standby");
        }
        return pjp.proceed();
    }

    @Scheduled(fixedRate = 10_000)
    public void refreshStandbyStatus() {
        try (Connection conn = dataSource.getConnection();
             ResultSet rs = conn.createStatement()
                     .executeQuery("SELECT pg_is_in_recovery()")) {
            if (rs.next()) {
                isStandby = rs.getBoolean(1);
            }
        } catch (SQLException e) {
            // Keep the last known status; the database still rejects writes on
            // a standby, so a failed check must not block all writes
            log.warn("Cannot determine standby status: {}", e.getMessage());
        }
    }
}
```

## 8. ترقية نسخة (تحول يدوي)

```bash
# Check cluster state
patronictl -c /etc/patroni/patroni.yml list

# Output:
# + Cluster: payment-postgres-cluster --------+----+-----------+
# | Member      | Host           | Role    | State   | TL | Lag in MB |
# +-------------+----------------+---------+---------+----+-----------+
# | pg-node-1   | 10.0.1.10:5432 | Leader  | running |  5 |           |
# | pg-node-2   | 10.0.1.11:5432 | Replica | running |  5 |         0 |
# | pg-node-3   | 10.0.1.12:5432 | Replica | running |  5 |         0 |

# Manual failover to a specific node
# (--leader; the old --master option was removed in Patroni 4)
# For a PLANNED switch of a healthy primary, prefer "switchover"
patronictl -c /etc/patroni/patroni.yml failover payment-postgres-cluster \
    --candidate pg-node-2 \
    --force

patronictl -c /etc/patroni/patroni.yml switchover payment-postgres-cluster \
    --leader pg-node-1 \
    --candidate pg-node-2
```

## 9. دليل التشغيل: الاستجابة للتحول

```
P1 Incident: PostgreSQL Primary Failure

T+0:  Patroni detects primary failure (DCS lease expires: 30s max)
T+30: Patroni elects new primary from sync replicas (< 10s election)
T+40: DNS / VIP updates to point to new primary
T+45: PgBouncer reconnects to new primary (server_connect_timeout: 15s)
T+60: Application connections resume (in-flight transactions failed and
      are retried by the application where safe)
T+90: Old primary comes back — Patroni runs pg_rewind, rejoins as replica

Engineer Actions:
1. Acknowledge PagerDuty alert
2. patronictl list — confirm new leader
3. Check application error rate (should be recovering)
4. Verify PgBouncer is connected to new primary
5. Monitor replication lag on new primary
6. Investigate root cause of original failure
7. Confirm the old primary rejoined as a replica (Patroni runs pg_rewind
   automatically with use_pg_rewind; do it by hand only if that failed)
8. File PIR within 24 hours
```

## 10. الخلاصة

يوفر التوفر العالي لـ PostgreSQL مع Patroni تحولًا آليًا في 30–90 ثانية دون فقدان بيانات عندما يُضبط النسخ المتزامن ويذهب التحول إلى نسخة متزامنة. والقرارات الأساسية لأنظمة الدفع: استخدم النسخ المتزامن (ANY 1) لمنع فقدان البيانات، واستخدم PgBouncer لإدارة الاتصالات أثناء التحول، واضبط مهل HikariCP ليفشل المستدعون بسرعة ويعيدوا المحاولة بأمان. ومنع الدماغ المنقسم عبر عقد إيجار المخزن يعني أن Patroni يضحي بالتوفر لصالح الاتساق — وهو الخيار الصحيح للبيانات المالية. وراقب تأخر النسخ باستمرار، ونبّه عند تأخر 30 ثانية، وصعّد عند 120 ثانية.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا يجب أن يستخدم نظام دفع النسخ المتزامن (synchronous_standby_names) بدل النسخ غير المتزامن؟",
      "options": ["النسخ المتزامن أسرع للقراءات", "النسخ غير المتزامن قد يفقد بيانات ملتزمة عند التحول، فيسبب خصومات غير مسجلة", "النسخ المتزامن يستخدم مساحة قرص أقل", "النسخ غير المتزامن يتطلب عقد وسيط أكثر"],
      "correct": 1,
      "explanation": "مع النسخ غير المتزامن، قد يضيع خصم دفعة التُزم به على الرئيسي ولم يُنسخ بعد إذا فشل الرئيسي. فلا تملك النسخة المرقّاة أي سجل للخصم، فينشأ خطأ مالي خُصم فيه العميل بينما لا يُظهر النظام أي سجل. ويضمن النسخ المتزامن وجود الالتزامات على نسخة واحدة على الأقل قبل الإقرار."
    },
    {
      "text": "ما الغرض من عقد إيجار مخزن الإعدادات الموزع (DCS) في Patroni في سيناريو الدماغ المنقسم؟",
      "options": ["تخزين النسخ الاحتياطية لقاعدة البيانات", "ضمان ألا تعمل كرئيسية إلا العقدة الممسكة بعقد الإيجار، بالتضحية بالتوفر لصالح الاتساق", "توجيه حركة التطبيق إلى العقدة الصحيحة", "إدارة تجميع اتصالات قاعدة البيانات"],
      "correct": 1,
      "explanation": "إذا فقد الرئيسي الاتصال بالمخزن الموزع، يخفض نفسه طوعًا بدل المخاطرة بدماغ منقسم تعتقد فيه عقدتان أنهما رئيسيتان. وهذا يضحي بالتوفر (توقف قصير) لصالح الاتساق (لا رئيسيتين)، وهي المفاضلة الصحيحة للبيانات المالية."
    },
    {
      "text": "أثناء تحول Patroni، ماذا يجب أن يختبر التطبيق إذا ضُبط HikariCP بشكل صحيح؟",
      "options": ["أخطاء اتصال فورية تتطلب إعادة تشغيل يدوية", "اضطراب قصير: تفشل المعاملات قيد التنفيذ وقد تنتهي مهلة طلبات الاتصال الجديدة حتى يصبح الرئيسي الجديد قابلًا للوصول (نحو 30–90 ثانية)؛ ثم يعيد المجمع الاتصال تلقائيًا، ويعيد التطبيق محاولة ما هو آمن لإعادة المحاولة", "فقدان دائم للبيانات يتطلب تعافيًا يدويًا", "لا انقطاع إطلاقًا ولا أخطاء ظاهرة، لأن HikariCP يعيد محاولة كل استعلام نيابة عنك"],
      "correct": 1,
      "explanation": "أثناء نافذة تحول Patroni ‏(30–90 ثانية) تنقطع الاتصالات بالرئيسي القديم: فتفشل المعاملات قيد التنفيذ، وتجعل مهلة connection-timeout في HikariCP ‏(مثلًا 10 ثوانٍ) طلبات الاتصال الجديدة تفشل بسرعة بدل التعلق. وليس في HikariCP إعادة محاولة مدمجة للاستعلامات — فحين يصبح الرئيسي الجديد قابلًا للوصول، يفتح ببساطة اتصالات جديدة. لذلك يجب أن يعيد التطبيق محاولة العمليات الآمنة لإعادة المحاولة (الـ idempotent)، وأن يتعامل بحذر مع الكتابة ذات نتيجة الالتزام المجهولة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "إعداد التوفر العالي لـ PostgreSQL مع Patroni والتحقق من التحول",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "اكتب YAML لإعداد Patroni لمجموعة PostgreSQL دفع من 3 عقد مع synchronous_mode=true (فيدير Patroni حينها synchronous_standby_names — لا تضبطه يدويًا)، واختيار متعمد لـ synchronous_mode_strict، وmaximum_lag_on_failover=1MB، وttl=30s، وأرشفة WAL إلى S3. واشرح ما الذي سيغيّره synchronous_mode_strict=true لدفتر مدفوعات."},
    {"id": "2", "description": "نفّذ مكوّن SynchronousReplicationValidator بـ @PostConstruct يستعلم SHOW synchronous_standby_names عند البدء، ويسجل تنبيهًا حرجًا ويستدعي المناوب إذا كان فارغًا (اكتُشف النمط غير المتزامن)، ويسجل تأكيدًا إذا كان النسخ المتزامن نشطًا."},
    {"id": "3", "description": "ابنِ ReplicationLagMonitor بـ @Scheduled(fixedRate=30000) يستعلم pg_stat_replication عن lag_seconds وlag_bytes لكل نسخة، وينشرهما كمقاييس gauge في Prometheus بوسوم النسخ، ويرسل تحذيرًا عند تأخر 30 ثانية وتنبيهًا حرجًا عند 120 ثانية."},
    {"id": "4", "description": "نفّذ @Aspect باسم StandbyWriteProtection يعترض الدوال المعلّمة بتعليق @WriteOperation خاص بك (لا تعليق Actuator)، ويفحص pg_is_in_recovery() كل 10 ثوانٍ (مخزنًا، مع الإبقاء على آخر قيمة معروفة إذا فشل فحص)، ويرمي StandbyWriteException إذا كان التطبيق متصلًا بخادم احتياطي."}
  ]
}
-->
