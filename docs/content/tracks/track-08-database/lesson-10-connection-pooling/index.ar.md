---
id: track-08-lesson-10
title: "تجميع الاتصالات — ضبط PgBouncer وHikariCP"
slug: connection-pooling
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 10
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [connection-pool, PgBouncer, HikariCP, max-pool-size, transaction-mode]
prerequisites: [track-08-lesson-01]
---

# تجميع الاتصالات — ضبط PgBouncer وHikariCP

> [!NOTE]
> يستطيع PostgreSQL تحمّل نحو 100–300 اتصال نشط قبل أن تُضعف كلفة الاتصالات الإنتاجية. ومنصة دفع بها 20 خدمة مصغّرة، تشغّل كل منها 10 نسخ بمجمع من 20 اتصالًا لكل نسخة، تخلق 4,000 اتصال محتمل — أي 10–40 ضعف نطاق التشغيل الآمن لـ PostgreSQL. وتجميع الاتصالات ليس اختياريًا في أنظمة التقنية المالية الإنتاجية.

## 1. لماذا اتصالات PostgreSQL مكلفة

كل اتصال بـ PostgreSQL عملية خلفية منفصلة (وليس خيطًا):
- يستهلك عدة ميغابايتات من الذاكرة الخاصة لكل اتصال (أكثر مع استخدام `work_mem` كبير أو ذاكرات كتالوج مؤقتة كبيرة)
- له كلفة بدء (إنشاء العملية + المصادقة، عادة بضع مللي ثوانٍ؛ أكثر مع TLS وSCRAM)
- يشغل خانة في `pg_stat_activity` حتى حين يكون خاملًا
- يتطلب كلفة المصادقة وإعداد الجلسة

```sql
-- Check current connections
SELECT
    COUNT(*) AS total_connections,
    COUNT(*) FILTER (WHERE state = 'active') AS active,
    COUNT(*) FILTER (WHERE state = 'idle') AS idle,
    COUNT(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn,
    MAX(EXTRACT(EPOCH FROM (NOW() - state_change)))::INT AS max_idle_seconds
FROM pg_stat_activity
WHERE datname = 'payments';

-- Show connections per application
SELECT
    application_name,
    client_addr,
    COUNT(*) AS connections,
    COUNT(*) FILTER (WHERE state = 'active') AS active
FROM pg_stat_activity
WHERE datname = 'payments'
  AND pid <> pg_backend_pid()
GROUP BY application_name, client_addr
ORDER BY connections DESC;
```

## 2. ‏PgBouncer — تجميع الاتصالات على جانب الخادم

يقع PgBouncer بين التطبيق وPostgreSQL، فيمرّر اتصالات عملاء كثيرة عبر عدد صغير من اتصالات الخادم.

```
Applications (4,000 potential connections)
    |
    v
PgBouncer (100 server connections)
    |
    v
PostgreSQL (100 actual backend processes)
```

### أوضاع PgBouncer

**وضع الجلسة**: اتصال خادم واحد محجوز لكل عميل طوال الجلسة. وتُعاد استخدام اتصالات الخادم بعد انفصال العميل، لكن لا يوجد تمرير متعدد: فـ N عميل متصل ما زالوا يحتاجون N اتصال خادم.

**وضع المعاملة**: يُستعار اتصال الخادم عند بدء المعاملة، ويُعاد عند الالتزام/التراجع. وهذا الوضع الصحيح للخدمات المصغّرة — ففي معظم الوقت تكون الاتصالات خاملة بين المعاملات.

**وضع العبارة**: يُعاد اتصال الخادم بعد كل عبارة. ولا يُسمح بالمعاملات متعددة العبارات إطلاقًا. ولا يُنصح به عمومًا.

### إعداد PgBouncer

```ini
# /etc/pgbouncer/pgbouncer.ini

[databases]
payments = host=postgres-primary port=5432 dbname=payments
payments_ro = host=postgres-replica port=5432 dbname=payments

[pgbouncer]
listen_port = 6432
listen_addr = *
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

# Pool mode — ALWAYS use transaction for microservices
pool_mode = transaction

# Server pool size: how many PostgreSQL connections PgBouncer maintains
# Rule of thumb: (num_cores * 2) + num_disks per PostgreSQL node
# For a 16-core server with NVMe: (16*2) + 1 = 33, round to 50 for headroom
default_pool_size = 50
max_client_conn = 2000       # max application-side connections
reserve_pool_size = 10       # extra connections for spikes
reserve_pool_timeout = 3     # wait 3s before using reserve pool

# Connection limits per database
max_db_connections = 100     # hard cap on PostgreSQL connections

# Timeouts
server_idle_timeout = 600    # close idle server connections after 10 min
server_lifetime = 3600       # recycle server connections every hour
client_idle_timeout = 300    # close idle client connections after 5 min
query_timeout = 30           # kill queries > 30s (payment processing SLA)
query_wait_timeout = 5       # client wait for available connection: 5s

# Prepared statements in transaction mode (PgBouncer 1.21+):
# > 0 makes PgBouncer track protocol-level prepared statements (the kind
# the JDBC driver uses) and re-prepare them on whichever server connection
# runs the transaction. 0 (the default on older setups) means no support --
# then turn server-side prepares off in the driver (see Section 4).
max_prepared_statements = 200

# Logging
log_connections = 0          # don't log every connection (too noisy)
log_disconnections = 0
log_pooler_errors = 1
stats_period = 60
```

### مصادقة مستخدمي PgBouncer

```bash
# Generate password hash for PgBouncer userlist
psql -c "SELECT concat('\"', usename, '\" \"', passwd, '\"') FROM pg_shadow WHERE usename='payments_app';"

# /etc/pgbouncer/userlist.txt
"payments_app" "SCRAM-SHA-256$4096:..."
"payments_ro" "SCRAM-SHA-256$4096:..."
```

### مراقبة PgBouncer

```sql
-- Connect to PgBouncer admin console
psql -p 6432 -U pgbouncer pgbouncer

-- Show pool statistics
SHOW POOLS;
-- database | user | cl_active | cl_waiting | sv_active | sv_idle | sv_used | maxwait
-- payments | app  | 45        | 0          | 48        | 2       | 0       | 0

-- cl_waiting > 0 sustained means clients are queueing for server connections -- alert
-- maxwait (seconds; maxwait_us adds the microseconds) >= 1 means severe pool exhaustion

-- Show connection stats
SHOW STATS;
-- total_query_time, total_wait_time, total_xact_count

-- Live query monitoring
SHOW CLIENTS;
SHOW SERVERS;
```

## 3. ‏HikariCP — تجميع الاتصالات على جانب التطبيق

‏HikariCP مجمع اتصالات JDBC سريع جدًا وخفيف، وهو الافتراضي في Spring Boot.

### معادلة تحجيم المجمع

نقطة البداية الكلاسيكية (من ويكي PostgreSQL، ونشرتها صفحة "About Pool Sizing" في HikariCP):

```
connections = (core_count * 2) + effective_spindle_count

core_count = cores of the DATABASE server (not the application server)
The result is the number of ACTIVE connections the database can usefully
work on at once -- in TOTAL, across all clients.

For a PostgreSQL server with:
  - 16 cores
  - NVMe SSD (count it as ~1 "spindle"; the formula predates SSDs)
  - Useful active connections = (16 * 2) + 1 = 33

Spread over 10 application instances (no PgBouncer):
  - ~33 / 10 = 3-4 active connections per instance
```

**مهم**: المعادلة نقطة بداية للإجمالي *على مستوى قاعدة البيانات*، ويجب تأكيدها باختبار الحمل. وكل مجمع تطبيق حصة من ذلك الإجمالي؛ فمع 10 نسخ، تسمح مجمعات من 20 لكل نسخة بـ 200 اتصال — أبعد بكثير مما يستطيع الخادم تنفيذه بالتزامن. ومع PgBouncer في وضع المعاملة، يمكن أن تكون مجمعات التطبيق أكبر، لأن PgBouncer يصبّها في مجمع خادم قريب من رقم المعادلة. ويأتي فحص سريع لكل نسخة من قانون Little ‏(انظر القسم 6).

### إعداد HikariCP

```java
@Configuration
public class DatabaseConfig {

    @Bean
    @Primary
    public DataSource primaryDataSource(MeterRegistry meterRegistry) {
        HikariConfig config = new HikariConfig();

        config.setJdbcUrl("jdbc:postgresql://pgbouncer:6432/payments");
        config.setUsername("payments_app");
        config.setPassword(resolveSecret("db.password"));
        config.setDriverClassName("org.postgresql.Driver");

        // Pool sizing
        // With PgBouncer in transaction mode, we can be more generous:
        // PgBouncer multiplexes our connections onto a smaller server pool
        config.setMaximumPoolSize(20);     // max connections in pool
        config.setMinimumIdle(5);          // keep 5 warm connections

        // Timeout configuration
        config.setConnectionTimeout(2_000);  // 2s to get a connection from pool
        config.setIdleTimeout(600_000);      // remove idle connections after 10 min
        config.setMaxLifetime(1_800_000);    // recycle connections every 30 min
        config.setKeepaliveTime(60_000);     // keepalive probes every 60s

        // Validation: do NOT set connectionTestQuery with a JDBC4 driver --
        // HikariCP then uses Connection.isValid(), which is cheaper

        // PostgreSQL-specific settings
        config.addDataSourceProperty("socketTimeout", "30");        // 30s socket timeout
        config.addDataSourceProperty("tcpKeepAlive", "true");
        config.addDataSourceProperty("ApplicationName", "payment-service");
        config.addDataSourceProperty("reWriteBatchedInserts", "true"); // batch insert optimization
        config.addDataSourceProperty("preparedStatementCacheQueries", "250");
        config.addDataSourceProperty("preparedStatementCacheSizeMiB", "5");

        // Via PgBouncer in transaction mode, server-side prepared statements
        // need PgBouncer 1.21+ with max_prepared_statements > 0. On older
        // PgBouncer, add prepareThreshold=0 so the driver never creates
        // named server-side statements (Section 4).

        // Pool name for metrics
        config.setPoolName("payments-primary");

        // Register metrics with Micrometer (Spring Boot does this automatically
        // for pools it creates; needed here because we build the pool ourselves)
        config.setMetricRegistry(meterRegistry);

        return new HikariDataSource(config);
    }

    @Bean
    @Qualifier("readOnly")
    public DataSource readOnlyDataSource() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:postgresql://pgbouncer:6432/payments_ro");
        config.setUsername("payments_ro");
        config.setPassword(resolveSecret("db.readonly.password"));
        config.setMaximumPoolSize(30);     // read replica can handle more concurrency
        config.setMinimumIdle(5);
        config.setConnectionTimeout(2_000);
        config.setReadOnly(true);          // driver-level read-only flag
        config.setPoolName("payments-replica");
        return new HikariDataSource(config);
    }
}
```

### بديل application.yml

```yaml
spring:
  datasource:
    url: jdbc:postgresql://pgbouncer:6432/payments
    username: payments_app
    password: ${DB_PASSWORD}
    hikari:
      pool-name: payments-primary
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 2000
      idle-timeout: 600000
      max-lifetime: 1800000
      keepalive-time: 60000
      data-source-properties:
        socketTimeout: 30
        tcpKeepAlive: true
        ApplicationName: payment-service
        reWriteBatchedInserts: true
```

## 4. العبارات المُعدّة في وضع المعاملة في PgBouncer

تعيش العبارة المُعدّة على جانب الخادم في اتصال خلفي واحد، لكن وضع المعاملة قد يعيّن اتصالًا خلفيًا مختلفًا لكل معاملة. ودون مساعدة من PgBouncer، تكون العبارة المُعدّة في معاملة مفقودة في التالية. (يتحول مشغّل JDBC لـ PostgreSQL إلى عبارات مُعدّة مسماة على جانب الخادم بعد `prepareThreshold` = 5 تنفيذات لنفس `PreparedStatement`، لذا يصيب هذا تطبيقات Java أيضًا.)

```sql
-- This fails in PgBouncer transaction mode:
PREPARE balance_lookup AS
    SELECT balance FROM accounts WHERE account_number = $1;
EXECUTE balance_lookup('ACC001');
-- ERROR: prepared statement "balance_lookup" does not exist
-- (PgBouncer assigned a different backend for the EXECUTE)
```

### الحلول

**الخيار 1: دع PgBouncer يتتبع العبارات المُعدّة (PgBouncer 1.21+، موصى به)**

```
# pgbouncer.ini
max_prepared_statements = 200
```

يتذكر PgBouncer العبارات المُعدّة على مستوى البروتوكول (ما يرسله مشغّل JDBC) ويُعدّها على أي اتصال خادم تحصل عليه المعاملة. أما عبارات `PREPARE`/`EXECUTE` على مستوى SQL، كما في المثال أعلاه، فما زالت غير مدعومة.

**الخيار 2: وضع الجلسة لحالات استخدام محددة تتطلب العبارات المُعدّة**

```ini
# pgbouncer.ini — per-database pool mode
[databases]
payments_transactions = host=postgres port=5432 dbname=payments pool_mode=transaction
payments_reporting = host=postgres port=5432 dbname=payments pool_mode=session
```

**الخيار 3: أوقف العبارات المسماة على جانب الخادم في المشغّل (PgBouncer الأقدم)**

```java
config.addDataSourceProperty("prepareThreshold", "0");  // never create named server-side statements
// The driver still uses the extended protocol with bind parameters (no SQL
// injection risk), but with unnamed statements that live only for one
// execution -- safe with PgBouncer transaction mode, at a small parsing cost
```

## 5. استنفاد المجمع — الأعراض والحلول

### كشف استنفاد المجمع

```java
// HikariCP already publishes hikaricp_connections_active / _idle / _pending
// / _timeout_total through Micrometer -- alert on those. This class only
// adds log lines; it reads the pool on each run and registers nothing.
@Component
@Slf4j
public class ConnectionPoolMonitor {

    private final HikariDataSource dataSource;

    public ConnectionPoolMonitor(HikariDataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Scheduled(fixedRate = 10_000)
    public void logPoolState() {
        HikariPoolMXBean pool = dataSource.getHikariPoolMXBean();
        if (pool == null) return;                 // pool not started yet

        int active  = pool.getActiveConnections();
        int idle    = pool.getIdleConnections();
        int total   = pool.getTotalConnections();
        int waiting = pool.getThreadsAwaitingConnection();

        int max = dataSource.getMaximumPoolSize();
        double utilization = max == 0 ? 0 : (double) active / max;
        if (utilization > 0.80) {
            log.warn("Connection pool high utilization: {}/{} ({}%)",
                active, max, Math.round(utilization * 100));
        }

        if (waiting > 0) {
            log.error("Connection pool EXHAUSTED: {} threads waiting for connection. " +
                "Current: active={}, idle={}, total={}",
                waiting, active, idle, total);
            // Page from the metric (hikaricp_connections_pending > 0 for 1m),
            // not from this log line
        }
    }
}
```

### الأسباب الشائعة والإصلاحات

| العَرَض | السبب الجذري | الإصلاح |
|---|---|---|
| خيوط تنتظر اتصالًا | المجمع صغير جدًا | زِد maximumPoolSize |
| المجمع يمتلئ أثناء المهام الدفعية | الدفعات لا تستخدم مجمعًا منفصلًا | مصدر بيانات مخصص للدفعات |
| اتصالات محجوزة طويلًا | استدعاءات خارجية بطيئة (HTTP، Kafka) داخل معاملة | انقل الاستدعاءات الخارجية خارج @Transactional |
| تراكم `idle in transaction` | معاملة لم تُغلق | اضبط idle_in_transaction_session_timeout، وأصلح الشيفرة |
| ‏cl_waiting > 0 في PgBouncer | مجمع خادم PgBouncer ممتلئ | ابحث عن الاستعلامات البطيئة أولًا؛ ثم ارفع default_pool_size (ضمن max_db_connections) |

```sql
-- Find long-running "idle in transaction" connections (they hold locks
-- and hold back VACUUM). state_change = when it went idle.
SELECT
    pid,
    usename,
    application_name,
    state,
    xact_start,
    EXTRACT(EPOCH FROM (NOW() - state_change))::INT AS seconds_in_state,
    LEFT(query, 100) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND state_change < NOW() - INTERVAL '30 seconds'
ORDER BY seconds_in_state DESC;

-- Kill runaway idle-in-transaction connections (their work is rolled back)
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND datname = 'payments'
  AND state_change < NOW() - INTERVAL '5 minutes';
```

## 6. التحجيم الصحيح لمجمعات الاتصالات لخدمات الدفع

### مثال: خدمة مصغّرة لمعالجة المدفوعات

```
Service profile:
  - Instances: 10
  - Per instance: 4 vCPUs
  - Mix: 70% short transactions (< 10ms), 30% longer operations (100ms avg)
  - Peak throughput: 1,000 TPS (100 TPS per instance)

Calculation:
  At 100 TPS per instance:
  - Short transactions (70%): 70 req/s * 10ms = 0.7 connections occupied at any time
  - Long operations (30%): 30 req/s * 100ms = 3.0 connections occupied at any time
  - Total steady-state: ~3.7 connections per instance
  - With 2x headroom: ~8 connections
  - Set maximumPoolSize = 10 per instance

Database-side check (formula from Section 3, DB server with 8 cores):
  - (8 * 2) + 1 = 17 useful active connections
  - Fleet steady state: 10 * 3.7 = ~37 busy connections at peak -- more
    than 17, so either queries must get faster or the DB needs more cores;
    load-test to find the real knee

PgBouncer configuration:
  - 10 instances * 10 connections = 100 potential application connections
  - PgBouncer default_pool_size: 25 (transaction mode multiplexes 100:25)
  - PostgreSQL max_connections: 50 (25 from PgBouncer + ~10 for
    ops/admin/monitoring, plus headroom)
```

### الإعداد للمعالجة الدفعية

```java
@Configuration
public class BatchDataSourceConfig {

    /**
     * Separate connection pool for batch jobs.
     * Prevents batch operations from starving real-time payment processing.
     */
    @Bean
    @Qualifier("batch")
    public DataSource batchDataSource() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:postgresql://pgbouncer:6432/payments");
        config.setUsername("payments_batch");
        config.setPassword(resolveSecret("db.batch.password"));

        // Small pool: batch work is throughput-oriented and must not take
        // database capacity away from real-time payments
        config.setMaximumPoolSize(5);
        config.setMinimumIdle(1);
        config.setConnectionTimeout(10_000); // batch can wait longer

        // Batch-specific settings (fetch size only streams rows when
        // autocommit is off, i.e. inside a transaction)
        config.addDataSourceProperty("defaultFetchSize", "1000");
        config.addDataSourceProperty("reWriteBatchedInserts", "true");

        config.setPoolName("payments-batch");
        return new HikariDataSource(config);
    }
}
```

## 7. حزمة PgBouncer + HikariCP — مرجع الإعداد الكامل

```
Application (HikariCP pool)         PgBouncer           PostgreSQL
  maxPoolSize = 20          -->    pool_size = 50  -->  max_connections = 100
  connectionTimeout = 2s          query_wait_timeout = 5s
  idleTimeout = 600s              server_idle_timeout = 600s
  maxLifetime = 1800s             server_lifetime = 3600s
  keepalive = 60s                 server_connect_timeout = 15s
```

```java
@SpringBootTest(properties = {
    "spring.datasource.hikari.maximum-pool-size=20",
    "spring.datasource.hikari.connection-timeout=2000"
})
@Testcontainers
class ConnectionPoolIntegrationTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withCommand("postgres", "-c", "max_connections=50");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void poolShouldQueueRatherThanFailUnderLoad() throws Exception {
        int concurrentThreads = 25;  // more than the pool size (20)
        AtomicInteger successCount = new AtomicInteger(0);
        AtomicInteger timeoutCount = new AtomicInteger(0);

        try (ExecutorService executor = Executors.newFixedThreadPool(concurrentThreads)) {
            for (int i = 0; i < concurrentThreads; i++) {
                executor.submit(() -> {
                    try {
                        // holds a connection for ~100 ms
                        jdbcTemplate.queryForObject(
                            "SELECT 1 FROM pg_sleep(0.1)", Integer.class);
                        successCount.incrementAndGet();
                    } catch (CannotGetJdbcConnectionException e) {
                        timeoutCount.incrementAndGet();   // waited > 2 s
                    }
                });
            }
        } // close() waits for all tasks (Java 19+)

        // The 5 extra requests wait ~100 ms for a free connection -- far less
        // than the 2 s connection timeout -- so every request succeeds
        assertThat(successCount.get()).isEqualTo(concurrentThreads);
        assertThat(timeoutCount.get()).isZero();
    }
}
```

> [!WARNING]
> من أشيع حوادث الإنتاج المتعلقة بتجميع الاتصالات اتصالات `idle in transaction`. فهي تمسك أقفال قاعدة البيانات (أحيانًا على مستوى الجدول) وتعيق VACUUM وهي لا تفعل شيئًا. واتصال عالق واحد يمكن أن يحجب تدفق معالجة المدفوعات كله. فاضبط `idle_in_transaction_session_timeout` في PostgreSQL لإنهاء الاتصالات العالقة في معاملة لفترة طويلة تلقائيًا: `ALTER DATABASE payments SET idle_in_transaction_session_timeout = '30s';`

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تشغّل خدمة دفع 10 نسخ (4 vCPU لكل منها) تتصل مباشرة — دون PgBouncer — بخادم PostgreSQL بـ 16 نواة وتخزين NVMe. باستخدام المعادلة الكلاسيكية connections = (core_count * 2) + effective_spindle_count كنقطة بداية، ما حجم المجمع المعقول لكل نسخة تطبيق؟",
      "options": ["4 اتصالات — واحد لكل vCPU في التطبيق", "نحو 3–4 اتصالات — المعادلة تنطبق على خادم قاعدة البيانات، (16 * 2) + 1 ≈ 33 اتصالًا نشطًا إجمالًا، تتقاسمها 10 نسخ", "33 اتصالًا لكل نسخة — (16 * 2) + 1", "10 اتصالات — القيمة الافتراضية لـ maximumPoolSize في HikariCP"],
      "correct": 1,
      "explanation": "تقدّر المعادلة عدد الاتصالات التي يستطيع خادم قاعدة البيانات تشغيلها بفائدة في آن واحد، باستخدام أنوية خادم قاعدة البيانات: (16 * 2) + 1 ≈ 33. وهذا إجمالي لكل العملاء، فتحصل 10 نسخ على نحو 3–4 لكل منها (أكّد ذلك باختبار حمل). وإعطاء كل نسخة 33 يسمح بـ 330 اتصالًا ينتظر معظمها بعضه بعضًا. ومع PgBouncer في وضع المعاملة يمكن أن تكون مجمعات التطبيق أكبر، لأن PgBouncer يصبّها في مجمع خادم قريب من رقم المعادلة."
    },
    {
      "text": "يعمل PgBouncer (أقدم من 1.21، أو مع max_prepared_statements = 0) في وضع المعاملة. وتبدأ خدمة Spring تستخدم مشغّل JDBC لـ PostgreSQL — الذي يتحول إلى عبارات مُعدّة مسماة على جانب الخادم بعد 5 تنفيذات — في رمي أخطاء: 'prepared statement S_1 does not exist'. ما السبب الجذري؟",
      "options": ["ذاكرة Hibernate المؤقتة للعبارات المُعدّة صغيرة جدًا وتحتاج زيادة", "في وضع المعاملة، قد يوجّه PgBouncer كل معاملة إلى اتصال خادم خلفي مختلف؛ والعبارات المُعدّة على جانب الخادم مرتبطة باتصال خلفي محدد وتصبح غير صالحة حين يوجّه PgBouncer إلى اتصال آخر", "وضع المعاملة في PgBouncer غير متوافق مع مشغّلات JDBC ويجب استخدام وضع الجلسة", "قيمة max_prepared_transactions في PostgreSQL مضبوطة على 0 وتحتاج زيادة"],
      "correct": 1,
      "explanation": "تعيش العبارات المُعدّة على جانب الخادم في اتصال خلفي واحد. وفي وضع المعاملة، قد يعطي PgBouncer كل معاملة اتصالًا خلفيًا مختلفًا، فالعبارة المُعدّة على backend-1 مجهولة على backend-2. والإصلاحات: الترقية إلى PgBouncer 1.21+ وضبط max_prepared_statements > 0 (فيتتبع PgBouncer العبارات المُعدّة على مستوى البروتوكول ويعيد إعدادها حيث يلزم)، أو ضبط prepareThreshold=0 في مشغّل JDBC كي لا ينشئ عبارات مسماة على جانب الخادم أبدًا."
    },
    {
      "text": "يُظهر pg_stat_activity ‏15 اتصالًا في حالة 'idle in transaction' لأكثر من 5 دقائق على قاعدة بيانات المدفوعات. ما الأثر التجاري الأرجح وأسرع إجراء للتخفيف؟",
      "options": ["لا أثر فوري — الاتصالات الخاملة لا تمسك أقفالًا؛ أنهها في نافذة الصيانة التالية", "تمسك هذه الاتصالات أقفالًا على مستوى الصف وربما على مستوى الجدول، فتحجب معاملات أخرى؛ والتخفيف الفوري تشغيل pg_terminate_backend() عليها وضبط idle_in_transaction_session_timeout لمنع التكرار", "تستهلك هذه الاتصالات 5–10 ميغابايت من الذاكرة لكل منها؛ أعد تشغيل خادم PostgreSQL لتحرير الذاكرة", "تدل هذه الاتصالات على سوء إعداد مهلة العميل؛ زِد connectionTimeout في HikariCP"],
      "correct": 1,
      "explanation": "للاتصالات في حالة 'idle in transaction' معاملة مفتوحة لكنها لا تنفذ شيئًا. فهي تحتفظ بكل قفل أُخذ في تلك المعاملة — وربما تحجب صفوفًا أو جدولًا كاملًا — وتعيق VACUUM. وفي نظام دفع، اتصال واحد كهذا يمسك قفل صف على حساب ساخن يمكن أن يصفّ خلفه معاملات دفع محجوبة كثيرة. والتخفيف الفوري: SELECT pg_terminate_backend(pid) لتلك الاتصالات (يُتراجع عن عملها). والوقاية: ALTER DATABASE payments SET idle_in_transaction_session_timeout = '30s'، وإصلاح مسار الشيفرة الذي يترك المعاملات مفتوحة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تحجيم مجمع الاتصالات وتشخيص الاستنفاد",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "حجّم المجمعات لخدمة دفع بهذا الوصف: 15 نسخة، 2 vCPU لكل منها، تتصل عبر PgBouncer بخادم PostgreSQL بـ 8 أنوية وNVMe. استخدم معادلة (core_count * 2) + spindles على خادم قاعدة البيانات لمجمع خادم PgBouncer، وقانون Little ‏(الإنتاجية × مدة حجز الاتصال) لكل مجمع تطبيق HikariCP. واعرض حسابك واشرح العلاقة بين حجم مجمع التطبيق وحجم مجمع PgBouncer وmax_connections في PostgreSQL."},
    {"id": "2", "description": "ابنِ اختبار تكامل بـ Testcontainers يستنفد مجمع الاتصالات عمدًا: اضبط مجمعًا بـ maximumPoolSize=5 وconnectionTimeout=1000ms، ثم قدّم 20 عملية قاعدة بيانات متزامنة تمسك كل منها اتصالًا لمدة 500ms. وتحقق من أن أول 5 تنجح خلال 500ms، وأن الـ 15 الباقية إما تنجح خلال 1500ms (مصفوفة) أو تفشل بمهلة اتصال. وأضف مقاييس HikariCP للتحقق من أن المجمع لا يتجاوز maximumPoolSize أبدًا."},
    {"id": "3", "description": "اكتب دليل تشغيل لتشخيص حادث استنفاد مجمع اتصالات في الإنتاج. وضمّن استعلامات SQL المحددة على pg_stat_activity لتحديد: إجمالي الاتصالات حسب الحالة، والمتسببين في 'idle in transaction' مع آخر استعلام ومدته، والاتصالات حسب التطبيق وعنوان IP، والاستعلامات النشطة طويلة التشغيل. وقدّم أوامر الإنهاء مع فحوص أمان مناسبة."},
    {"id": "4", "description": "نفّذ مجمع HikariCP منفصلًا لمهام المعالجة الدفعية بـ maximumPoolSize=3 ومصدر بيانات موجّهًا يرسل عمليات @Transactional(readOnly=true) إلى مجمع نسخة القراءة. واكتب اختبارات تتحقق من أن العمليات الدفعية لا تجوّع معالجة المدفوعات الفورية أبدًا، وأن المعاملات للقراءة فقط تُوجه فعلًا إلى مجمع النسخة."}
  ]
}
-->
