---
id: "track-07-lesson-07"
title: "ضبط JDBC — مجمّعات الاتصالات والعمليات الدفعية"
track: "track-07"
track-name: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 7
slug: "jdbc-tuning"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-07-lesson-04"]

tags:
  - "JDBC"
  - "HikariCP"
  - "batch-insert"
  - "prepared-statement"
  - "connection-pool"

java-versions: [17, 21]

topics:
  - "HikariCP Configuration"
  - "Connection Pool Sizing Formula"
  - "PreparedStatement Caching"
  - "JDBC Batch Inserts"
  - "Statement vs PreparedStatement"
  - "pgjdbc Specific Settings"
  - "Connection Pool Monitoring with Micrometer"

components:
  mermaid: false
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "HikariCP — github.com/brettwooldridge/HikariCP"
  - "PostgreSQL JDBC Driver — jdbc.postgresql.org"
  - "About Pool Sizing — github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing"
  - "PgBouncer documentation — pgbouncer.org"
---

## نظرة عامة

مجمع الاتصالات هو الجسر بين تطبيق Java وقاعدة البيانات. فقلة الاتصالات تجعل الخيوط تصطف منتظرة، فيقفز الزمن وتنهار الإنتاجية. وكثرتها تجعل حمل الذاكرة لكل اتصال في PostgreSQL يدفع خادم قاعدة البيانات إلى التبديل (swap)، فيقدم أداءً أسوأ مما كان سيقدمه مجمع أصغر.

ولخدمات الدفع حيث تلمس كل معاملة قاعدة البيانات — فحوص الأرصدة، وإدراجات الدفتر، وسجلات التدقيق — فإن ضبط إعداد مجمع الاتصالات ليس اختياريًا. ولا فهم عمليات JDBC الدفعية: فمعالج تسوية يُدرج 10,000 قيد دفتر صفًا صفًا سيكون أبطأ بـ 10–50 مرة من معالج يستخدم دفعات JDBC.

يغطي هذا الدرس إعداد HikariCP من المبادئ الأولى، ورياضيات تحجيم المجمع، وتخزين PreparedStatement، والعمليات الدفعية لإدراج قيود الدفتر، وإعدادات مشغّل JDBC لـ PostgreSQL، ومراقبة الإنتاج.

> [!NOTE]
> لـ PostgreSQL حد صارم للاتصالات (الافتراضي 100). وكل اتصال يبقيه تطبيقك مفتوحًا غير متاح للتطبيقات الأخرى، وpgBouncer، والجلسات الإدارية، وأدوات المراقبة. حجّم مجمعك بتحفظ واستخدم pgBouncer لتعدد إرسال الاتصالات في النشرات عالية التزامن.

## أهداف التعلم

بنهاية هذا الدرس ستكون قادرًا على:

- ضبط HikariCP بشكل صحيح لحمل خدمة دفع
- حساب حجم المجمع الأمثل باستخدام معادلة تحجيم مجمع الاتصالات
- فهم تخزين PreparedStatement وضبطه
- تنفيذ إدراجات JDBC الدفعية لعمليات الدفتر عالية الإنتاجية
- ضبط إعدادات pgjdbc الخاصة لأداء PostgreSQL
- مراقبة صحة مجمع الاتصالات باستخدام Micrometer

## 1. كلفة الخطأ في تجميع الاتصالات

### اتصالات قليلة جدًا

```
Scenario: 200 TPS, each transaction needs 20 ms DB time, pool size = 5

Connections needed = 200 TPS * 0.020 s = 4 connections (at 100% utilisation)
Pool size = 5 means no queuing at steady state

BUT: if DB slows to 50 ms per query during a slow disk flush:
  Connections needed = 200 TPS * 0.050 s = 10 connections
  Pool size = 5 -> the pool can serve only half the arriving work
  The queue grows without limit -> timeouts -> cascading failure
```

### اتصالات كثيرة جدًا

```
Scenario: PostgreSQL server with 16 CPU cores, 1,000 connections open

Memory: each backend is a separate OS process. An idle one costs a few MB;
  an active one can use work_mem (default 4 MB) PER sort/hash operation,
  so 1,000 busy connections can run the server out of RAM.
CPU: if 300 of them run queries at once on 16 cores, the OS keeps
  switching between processes, and lock/latch contention rises.
  Each query gets slower, so connections are held longer -> even more
  concurrent work.

Rule of thumb: keep ACTIVE connections around a small multiple of the
database's CPU cores; use a pooler (PgBouncer) when many app instances
need many mostly-idle connections.
```

## 2. ‏HikariCP — المجمع القياسي لـ Java في الإنتاج

‏HikariCP أسرع مجمعات اتصالات JDBC لـ Java وأكثرها موثوقية. وهو الافتراضي في Spring Boot منذ الإصدار 2.x.

### 2.1 الإعداد الأساسي

```java
// HikariCpConfiguration.java

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class HikariCpConfiguration {

    @Bean
    public HikariDataSource dataSource(HikariProperties props,
                                        MeterRegistry meterRegistry) {
        HikariConfig config = new HikariConfig();

        // ---- Connection settings ----
        config.setJdbcUrl(props.getUrl());
        config.setUsername(props.getUsername());
        config.setPassword(props.getPassword());
        config.setDriverClassName("org.postgresql.Driver");

        // ---- Pool sizing ----
        // Starting point: (DB core_count * 2) + effective_spindle_count
        // For an 8-core DATABASE server with SSD (spindle = 1):
        //   (8 * 2) + 1 = 17 -> 20 (then validate with load tests, and
        //   divide among app instances -- see section 3)
        config.setMaximumPoolSize(20);
        config.setMinimumIdle(5);  // keep at least 5 warm connections

        // ---- Timeout settings ----
        // connectionTimeout: how long a thread waits for a connection from the pool
        // Set low enough to fail fast rather than queue
        config.setConnectionTimeout(3_000);  // 3 seconds

        // idleTimeout: how long an idle connection stays in the pool
        config.setIdleTimeout(600_000);     // 10 minutes

        // maxLifetime: maximum lifetime of a connection. Set it a little below any
        // limit imposed by the infrastructure (firewalls, NAT, proxies, PgBouncer
        // server_lifetime). PostgreSQL itself has no connection lifetime limit.
        config.setMaxLifetime(1_800_000);   // 30 minutes

        // keepaliveTime: send keepalive query to prevent firewall timeouts
        config.setKeepaliveTime(60_000);    // 1 minute

        // ---- Validation ----
        // Do NOT set connectionTestQuery with a JDBC4 driver such as pgjdbc:
        // HikariCP then uses Connection.isValid(), which is faster.
        config.setValidationTimeout(2_000);         // must complete in 2 s

        // ---- Performance settings ----
        // Every unit of work then MUST commit explicitly (Spring's
        // @Transactional does). With JPA, also set
        // hibernate.connection.provider_disables_autocommit=true
        config.setAutoCommit(false);

        // ---- PostgreSQL-specific properties ----
        config.addDataSourceProperty("ApplicationName", "payment-auth-service");
        config.addDataSourceProperty("socketTimeout", "30");        // seconds
        config.addDataSourceProperty("connectTimeout", "5");        // seconds
        config.addDataSourceProperty("preparedStatementCacheQueries", "250");
        config.addDataSourceProperty("preparedStatementCacheSizeMiB", "10");
        config.addDataSourceProperty("reWriteBatchedInserts", "true");  // critical for batch
        config.addDataSourceProperty("defaultRowFetchSize", "100");     // cursor fetch size

        // ---- Pool name and monitoring ----
        config.setPoolName("payment-service-pool");
        config.setMetricRegistry(meterRegistry);  // expose Micrometer metrics

        return new HikariDataSource(config);
    }
}
```

### 2.2 المكافئ في application.yml

```yaml
# application.yml
spring:
  datasource:
    url: jdbc:postgresql://db-primary:5432/payments?sslmode=require
    username: ${DB_USER}
    password: ${DB_PASSWORD}
    driver-class-name: org.postgresql.Driver
    hikari:
      pool-name: payment-service-pool
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 3000
      idle-timeout: 600000
      max-lifetime: 1800000
      keepalive-time: 60000
      auto-commit: false
      data-source-properties:
        ApplicationName: payment-auth-service
        socketTimeout: 30
        connectTimeout: 5
        preparedStatementCacheQueries: 250
        preparedStatementCacheSizeMiB: 10
        reWriteBatchedInserts: true
```

## 3. معادلة تحجيم المجمع

أشهر نقطة بداية هي المعادلة في صفحة ويكي HikariCP ‏"About Pool Sizing"، وأصلها من مجتمع PostgreSQL. وتعامل معها كتقدير أول لعدد الاتصالات التي تستطيع **قاعدة البيانات** إبقاءها مشغولة بكفاءة، ثم أكّدها باختبارات الحمل:

```
Optimal pool size = (core_count * 2) + effective_spindle_count

Where:
  core_count          = number of CPU cores on the DATABASE server
  effective_spindle_count = number of disk spindles (0 if the working set
                            is fully cached; ~1 for SSD; 1-4 for RAID HDDs)

Example: 16-core database server with NVMe SSD:
  pool_size = (16 * 2) + 1 = 33

Example: 8-core database server with 4-disk RAID HDD array:
  pool_size = (8 * 2) + 4 = 20
```

**مهم**: المعادلة تصف قاعدة البيانات، لا عميلًا واحدًا. فإذا شغّلت 10 نسخ من خدمة الدفع بمجمع من 33 لكل منها، فالإجمالي `10 * 33 = 330` اتصالًا — وقد يتجاوز `max_connections` في PostgreSQL، وهو أكثر بكثير من 33 استعلامًا *نشطًا* يتعامل معها الخادم جيدًا. والأداة أدناه تبقي الإجمالي ضمن `max_connections`؛ فإن أمكن أن يكون كثير من تلك الاتصالات مشغولًا في اللحظة نفسها، فخفّض مجمعات النسخ أكثر أو ضع PgBouncer في الأمام.

```java
// ConnectionPoolSizer.java -- utility for calculating pool size

public class ConnectionPoolSizer {

    public record DatabaseSpec(int coreCount, int effectiveSpindleCount) {}

    public record PoolRecommendation(
        int poolSizePerInstance,
        int maxInstances,       // max instances before hitting DB connection limit
        int recommendedPoolSize // adjusted pool size
    ) {}

    /**
     * Calculate optimal pool size per application instance.
     *
     * @param dbSpec       database server specification
     * @param appInstances number of application instances
     * @param dbMaxConns   PostgreSQL max_connections setting
     * @param reservedConns connections reserved for DBA/monitoring/migrations
     */
    public static PoolRecommendation calculate(DatabaseSpec dbSpec,
                                                int appInstances,
                                                int dbMaxConns,
                                                int reservedConns) {
        int ideal = (dbSpec.coreCount() * 2) + dbSpec.effectiveSpindleCount();
        int availableForApp = dbMaxConns - reservedConns;
        int maxInstances = availableForApp / ideal;
        int adjustedPerInstance = Math.min(ideal, availableForApp / appInstances);

        return new PoolRecommendation(ideal, maxInstances, adjustedPerInstance);
    }

    public static void main(String[] args) {
        // 16-core DB server, SSD, 100 max_connections, 10 reserved
        // 5 application instances
        PoolRecommendation rec = calculate(
            new DatabaseSpec(16, 1),  // 16-core SSD server
            5,                         // 5 app instances
            100,                       // PostgreSQL max_connections=100
            10                         // reserve 10 for DBA/monitoring
        );

        System.out.printf("Ideal pool size: %d per instance%n", rec.poolSizePerInstance());
        System.out.printf("Max instances at ideal size: %d%n", rec.maxInstances());
        System.out.printf("Recommended (5 instances): %d per instance%n",
            rec.recommendedPoolSize());

        // Output:
        // Ideal pool size: 33 per instance
        // Max instances at ideal size: 2
        // Recommended (5 instances): 18 per instance
    }
}
```

## 4. تخزين PreparedStatement

مع pgjdbc، يُرسل `PreparedStatement` في البداية كعبارة غير مسماة؛ وبعد تنفيذه `prepareThreshold` مرة (الافتراضي 5) على الاتصال نفسه، يتحول المشغّل إلى **عبارة مُعدّة مسماة على الخادم**، فيتوقف PostgreSQL عن إعادة تحليلها. ويحتفظ المشغّل بها لكل اتصال في ذاكرة العبارات (`preparedStatementCacheQueries`، الافتراضي 256)، حتى بعد أن تغلق شيفرتك كائن `PreparedStatement`. وقد يعيد PostgreSQL حينها استخدام خطة عامة بدل التخطيط في كل تنفيذ.

```java
// PreparedStatementCachingExample.java

@Repository
public class PaymentRepository {

    private final DataSource dataSource;

    // preparedStatementCacheQueries=250: pgjdbc keeps up to 250 server-side
    // prepared statements per connection, so repeated SQL is not re-parsed.

    public PaymentRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    // FOR UPDATE only makes sense inside a transaction that goes on to update
    // the row -- in real code this runs within @Transactional
    private static final String BALANCE_QUERY =
        "SELECT balance FROM accounts WHERE account_id = ? AND currency = ? FOR UPDATE";

    public BigDecimal getBalanceForUpdate(String accountId, String currency)
            throws SQLException {
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(BALANCE_QUERY)) {
            // First executions on a connection: parsed each time;
            // from the 5th: a named server-side statement, no re-parse
            ps.setString(1, accountId);
            ps.setString(2, currency);

            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getBigDecimal("balance");
                }
                throw new AccountNotFoundException(accountId);
            }
        }
    }
}
```

### 4.1 ‏Statement مقابل PreparedStatement — لا تستخدم Statement أبدًا

```java
// WRONG: String concatenation -- SQL injection risk AND no plan caching
public BigDecimal getBalance_wrong(String accountId) throws SQLException {
    try (Connection conn = dataSource.getConnection();
         Statement stmt = conn.createStatement()) {
        // Vulnerable to SQL injection
        // No server-side plan caching
        // Parsed and planned on EVERY call
        ResultSet rs = stmt.executeQuery(
            "SELECT balance FROM accounts WHERE account_id = '" + accountId + "'"
        );
        // ...
    }
}

// CORRECT: PreparedStatement -- safe, cached, fast
public BigDecimal getBalance_correct(String accountId) throws SQLException {
    try (Connection conn = dataSource.getConnection();
         PreparedStatement ps = conn.prepareStatement(
             "SELECT balance FROM accounts WHERE account_id = ?")) {
        ps.setString(1, accountId);
        try (ResultSet rs = ps.executeQuery()) {
            return rs.next() ? rs.getBigDecimal("balance") : BigDecimal.ZERO;
        }
    }
}
```

## 5. إدراجات JDBC الدفعية لقيود الدفتر

تتطلب معالجة التسوية غالبًا إدراج آلاف قيود الدفتر ذريًا. والإدراجات الفردية بطيئة بشكل كارثي مقارنة بالإدراجات الدفعية.

```
Illustrative comparison (PostgreSQL, 10,000 inserts, ~1 ms network round trip):
  Individual inserts, autocommit=true:  ~45 seconds (network round-trip per insert)
  Individual inserts, one transaction:  ~8 seconds
  JDBC batch inserts:                   ~0.8 seconds
  JDBC batch + reWriteBatchedInserts:   ~0.3 seconds
```

### 5.1 إدراج JDBC دفعي أساسي

```java
// LedgerEntryRepository.java

@Repository
public class LedgerEntryRepository {

    private final DataSource dataSource;
    private static final Logger log = LoggerFactory.getLogger(LedgerEntryRepository.class);

    private static final String INSERT_SQL =
        "INSERT INTO ledger_entries " +
        "(id, account_id, transaction_id, entry_type, amount, currency, " +
        " balance_after, created_at, batch_id) " +
        "VALUES (?, ?, ?, ?::entry_type, ?, ?, ?, ?, ?)";

    // Optimal batch size: 100-500 for most PostgreSQL workloads
    // Larger batches: more memory, diminishing returns
    // Smaller batches: more round trips
    private static final int BATCH_SIZE = 250;

    public int[] insertBatch(List<LedgerEntry> entries) throws SQLException {
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);

            try (PreparedStatement ps = conn.prepareStatement(INSERT_SQL)) {
                int batchCount = 0;
                int[] totalResults = new int[entries.size()];
                int resultOffset = 0;

                for (LedgerEntry entry : entries) {
                    ps.setString(1, entry.getId());
                    ps.setString(2, entry.getAccountId());
                    ps.setString(3, entry.getTransactionId());
                    ps.setString(4, entry.getEntryType().name());
                    ps.setBigDecimal(5, entry.getAmount());
                    ps.setString(6, entry.getCurrency());
                    ps.setBigDecimal(7, entry.getBalanceAfter());
                    ps.setTimestamp(8, Timestamp.from(entry.getCreatedAt()));
                    ps.setString(9, entry.getBatchId());

                    ps.addBatch();  // Queue this row
                    batchCount++;

                    if (batchCount == BATCH_SIZE) {
                        // Execute accumulated batch
                        int[] results = ps.executeBatch();
                        System.arraycopy(results, 0, totalResults, resultOffset, results.length);
                        resultOffset += results.length;
                        batchCount = 0;
                        log.debug("Executed batch of {} ledger entries", BATCH_SIZE);
                    }
                }

                // Execute remaining rows
                if (batchCount > 0) {
                    int[] results = ps.executeBatch();
                    System.arraycopy(results, 0, totalResults, resultOffset, results.length);
                }

                conn.commit();
                // Note: with reWriteBatchedInserts=true the counts are
                // Statement.SUCCESS_NO_INFO (-2), not 1 per row
                return totalResults;

            } catch (SQLException e) {
                conn.rollback();
                log.error("Batch insert failed, rolled back {} entries", entries.size(), e);
                throw e;
            }
        }
    }
}
```

### 5.2 ‏reWriteBatchedInserts — تحسين مشغّل PostgreSQL

يعيد خيار `reWriteBatchedInserts=true` في مشغّل pgjdbc كتابة دفعة من عبارات `INSERT` أحادية الصف إلى عبارات INSERT متعددة الصفوف (على أجزاء حتى 128 صفًا):

```sql
-- Without reWriteBatchedInserts: N separate statements. pgjdbc already sends
-- them pipelined, but the server executes them one by one:
INSERT INTO ledger_entries VALUES (?, ?, ?, ...);
INSERT INTO ledger_entries VALUES (?, ?, ?, ...);
INSERT INTO ledger_entries VALUES (?, ?, ?, ...);

-- With reWriteBatchedInserts: one statement per chunk of rows:
INSERT INTO ledger_entries VALUES (?, ?, ?, ...), (?, ?, ?, ...), (?, ?, ?, ...);
```

غالبًا ما يعطي هذا **تسريعًا بمقدار 2–3 أضعاف (وأكثر أحيانًا)** لأحمال الإدراج الدفعي، دون كلفة في الشيفرة — فقِسه على حملك. وفعّله عبر عنوان JDBC أو خصائص DataSource. (وللتحميل الجماعي لآلاف كثيرة من الصفوف، فإن `COPY` في PostgreSQL — ‏`CopyManager` في pgjdbc — أسرع أيضًا.)

### 5.3 إدراجات Spring Data JPA الدفعية

لـ JPA/Hibernate آلية دفعات خاصة تعمل مع دفعات JDBC:

```yaml
# application.yml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 250          # match your JDBC batch size
          batch_versioned_data: true
        order_inserts: true        # hibernate.order_inserts: group inserts by entity type
        order_updates: true        # hibernate.order_updates: group updates by entity type

# Entity must NOT use GenerationType.IDENTITY for batching to work
# IDENTITY requires a separate DB round-trip per insert to get the generated ID
# Use GenerationType.SEQUENCE instead:
```

```java
// LedgerEntry.java -- JPA entity configured for batch insert

@Entity
@Table(name = "ledger_entries")
public class LedgerEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE,
                    generator = "ledger_entry_seq")
    @SequenceGenerator(name = "ledger_entry_seq",
                       sequenceName = "ledger_entry_id_seq",
                       allocationSize = 50)  // 50 IDs per round-trip -- the DB sequence
                                             // must use INCREMENT BY 50 to match
    private Long id;

    @Column(name = "account_id", nullable = false)
    private String accountId;

    @Column(name = "amount", nullable = false, precision = 19, scale = 4)
    private BigDecimal amount;

    // ... other fields

    // equals/hashCode on a business key, not the generated id: the id is null
    // until the entity is persisted, so id-based equality breaks Sets and
    // collections that hold new entities. (Hibernate's persistence context
    // itself tracks entities by id, not by equals.)
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof LedgerEntry other)) return false;
        return transactionId != null && transactionId.equals(other.transactionId)
            && entrySequence == other.entrySequence;
    }

    @Override
    public int hashCode() {
        return Objects.hash(transactionId, entrySequence);
    }
}
```

## 6. مراقبة مجمع الاتصالات باستخدام Micrometer

يُصدر HikariCP مقاييس Micrometer حين يُقدَّم `MeterRegistry` (ويربط Spring Boot ذلك تلقائيًا لمجمعه المُعدّ تلقائيًا). والمقاييس الأساسية:

```java
// ConnectionPoolMonitor.java

@Component
public class ConnectionPoolMonitor {

    private static final Logger log = LoggerFactory.getLogger(ConnectionPoolMonitor.class);
    private final MeterRegistry meterRegistry;

    public ConnectionPoolMonitor(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    // HikariCP registers these metrics, tagged with pool=<poolName>:
    // hikaricp.connections.active      -- connections in use by application code
    // hikaricp.connections.idle        -- connections available in pool
    // hikaricp.connections.pending     -- threads waiting for a connection
    // hikaricp.connections.max         -- maximumPoolSize
    // hikaricp.connections.min         -- minimumIdle
    // hikaricp.connections.timeout     -- counter of connection timeouts
    //                                     (hikaricp_connections_timeout_total in Prometheus)
    // hikaricp.connections.acquire     -- time to acquire a connection (histogram)
    // hikaricp.connections.usage       -- time a connection is held by application

    @Scheduled(fixedDelay = 30_000)
    public void logPoolHealth() {
        // Spring Boot Actuator exposes these automatically
        // This method adds alerting logic

        Double activeConnections = getGauge("hikaricp.connections.active");
        Double maxConnections = getGauge("hikaricp.connections.max");
        Double pendingThreads = getGauge("hikaricp.connections.pending");

        if (activeConnections != null && maxConnections != null) {
            double utilisation = activeConnections / maxConnections;

            if (utilisation > 0.9) {
                log.warn("Connection pool critically saturated: {}/{} ({}%)",
                    activeConnections.intValue(),
                    maxConnections.intValue(),
                    Math.round(utilisation * 100)
                );
            }
        }

        if (pendingThreads != null && pendingThreads > 5) {
            log.warn("Connection pool: {} threads waiting for connection. " +
                "Consider increasing pool size or reducing query duration.",
                pendingThreads.intValue()
            );
        }
    }

    private Double getGauge(String metricName) {
        Gauge gauge = meterRegistry.find(metricName).gauge();
        return gauge != null ? gauge.value() : null;
    }
}
```

**عتبات التنبيه الأساسية:**

| المقياس | تحذير | حرج |
|---|---|---|
| الاتصالات النشطة / الحد الأقصى | > 70% | > 90% |
| الخيوط المنتظرة | > 0 لأكثر من 5 ثوانٍ | > 5 |
| P99 لزمن الحصول على اتصال | > 100 مللي ثانية | > 500 مللي ثانية |
| عدد مهل الاتصال | أي قيمة | استدعاء مناوب فوري |
| P99 لمدة استخدام الاتصال | > SLA الاستعلام | > ضعف SLA الاستعلام |

## 7. التعامل مع استنفاد مجمع الاتصالات برشاقة

```java
// PaymentTransactionService.java

@Service
@Slf4j
public class PaymentTransactionService {

    private final TransactionTemplate tx;
    private final Counter poolExhaustionCounter;

    public PaymentTransactionService(PlatformTransactionManager txManager,
                                     MeterRegistry meterRegistry) {
        this.tx = new TransactionTemplate(txManager);
        this.poolExhaustionCounter = Counter.builder("db.pool.exhaustion")
            .description("Connection pool exhaustion events")
            .register(meterRegistry);
    }

    // NOT annotated @Transactional: with @Transactional the connection is
    // taken by the transaction interceptor BEFORE this method runs, so a
    // try/catch inside the method would never see the pool timeout.
    public PaymentResult processPayment(PaymentRequest request) {
        try {
            return tx.execute(status -> doProcessPayment(request));
        } catch (CannotCreateTransactionException | CannotGetJdbcConnectionException e) {
            // HikariCP throws SQLTransientConnectionException after
            // connectionTimeout; Spring wraps it in one of these exceptions.
            // The pool was exhausted -- no SQL was run, so failing is safe.
            poolExhaustionCounter.increment();
            log.error("DB connection pool exhausted processing payment {}",
                request.getId(), e);

            // Fail fast (e.g. HTTP 503 + Retry-After) rather than retry here:
            // retrying while the pool is exhausted makes the problem worse
            throw new PaymentServiceUnavailableException(
                "Payment service temporarily unavailable -- please retry", e
            );
        }
    }

    private PaymentResult doProcessPayment(PaymentRequest request) {
        // ... actual processing (runs inside the transaction)
        return null;
    }
}
```

## 8. قائمة فحص الإنتاج

لكل خدمة متصلة بقاعدة بيانات في الإنتاج:

- [ ] ‏`maximumPoolSize` محسوب باستخدام معادلة تحجيم المجمع
- [ ] ‏`connectionTimeout` مضبوط للفشل السريع (2–5 ثوانٍ) لا للانتظار بلا حد
- [ ] ‏`maxLifetime` مضبوط أقل ببضع ثوانٍ/دقائق من أي حد لعمر الاتصال تفرضه البنية التحتية (جدار ناري، أو NAT، أو وكيل، أو PgBouncer)
- [ ] ‏`keepaliveTime` مضبوط لمنع إسقاط الاتصالات من الجدار الناري/موازن الحمل
- [ ] ‏`autoCommit=false` لخدمات الدفع التي تدير معاملات صريحة
- [ ] ‏`reWriteBatchedInserts=true` في pgjdbc لأحمال الإدراج الدفعي
- [ ] ‏`preparedStatementCacheQueries=250` في pgjdbc
- [ ] مقاييس Micrometer مفعّلة (`config.setMetricRegistry(meterRegistry)`)
- [ ] تنبيهات على: النشط/الأقصى > 85%، والمنتظر > 0، وعدد المهل > 0
- [ ] لا استخدام لـ `Statement` — فقط `PreparedStatement`
- [ ] حجم الدفعة مضبوط على 250–500 لأحمال الدفتر المعتادة
- [ ] ‏`GenerationType.SEQUENCE` مع `allocationSize` للتوافق مع الإدراج الدفعي في JPA

## اختبار المعرفة

1. باستخدام معادلة تحجيم المجمع، احسب حجم المجمع الموصى به لكل نسخة لـ: خادم قاعدة بيانات بـ 16 نواة وSSD، و8 نسخ تطبيق، و`max_connections=200` في PostgreSQL، و20 اتصالًا محجوزًا للصيانة.

2. ما أثر `reWriteBatchedInserts=true` في pgjdbc؟ وما تحويل SQL الذي يجريه ومتى ينطبق؟

3. لماذا يمنع `GenerationType.IDENTITY` ‏Hibernate من تجميع عبارات INSERT في دفعات؟

4. لخدمة دفع `connectionTimeout=30000` (30 ثانية). وأثناء تباطؤ قاعدة البيانات، تصطف الخيوط منتظرة الاتصالات. ما المشكلة التي يسببها ذلك وما القيمة التي ستضبطها بدلًا منها؟

5. يقفز المقياس `hikaricp.connections.pending` إلى 50 أثناء الذروة. حجم المجمع 20، والخدمة تنفذ 2,000 استعلام في الثانية في الذروة، وكل منها يحتجز اتصالًا 15 مللي ثانية في المتوسط. باستخدام قانون Little (الاتصالات المستخدمة = المعدل × مدة الاحتجاز)، كم اتصالًا مشغولًا في المتوسط — وهل المجمع الأكبر هو الإصلاح الصحيح، أم أن شيئًا آخر يحتجز الاتصالات؟

## التحدي العملي

**الإعداد:** يُدرج معالج تسوية 100,000 قيد دفتر خلال دفعة ليلية. ويعمل حاليًا في 180 ثانية (إدراجات أحادية الصف مع autocommit). ويتطلب العمل إكماله خلال 30 ثانية للوفاء بنافذة التسوية.

**المهمة:**
1. اكتب صنفًا باسم `SettlementBatchInserter`:
   - يقبل `List<LedgerEntry>` ويُدرج باستخدام دفعات JDBC بحجم دفعة قابل للضبط
   - ينفذ معالجة دفعية متوازية عبر اتصالات قاعدة بيانات متعددة
   - يسجّل المقاييس: المدة الكلية، والصفوف في الثانية، وعدد الدفعات
   - يتعامل مع الفشل الجزئي بدلالات تراجع مناسبة
2. اكتب مقياس JMH باسم `ConnectionPoolBenchmark` يقيس أثر أحجام المجمع المختلفة (5، و10، و20) وأحجام الدفعات (50، و250، و500) على إنتاجية إدراج 100,000 صف
3. اشرح خصائص pgjdbc التي ستضبطها ولماذا لهذا الحمل

**المخرج المتوقع:** صنف Java كامل مع إعداد مجمع الاتصالات، ومقياس JMH، ومقتطف إعداد مشروح.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "باستخدام معادلة تحجيم المجمع، ما حجم المجمع الموصى به لكل نسخة لخادم قاعدة بيانات بـ 16 نواة وSSD مع 8 نسخ تطبيق، وmax_connections=200، و20 اتصالًا محجوزًا؟",
      "options": [
        "10 اتصالات لكل نسخة",
        "22 اتصالًا لكل نسخة",
        "33 اتصالًا لكل نسخة",
        "40 اتصالًا لكل نسخة"
      ],
      "correct": 1,
      "explanation": "المعادلة: المثالي = (16 * 2) + 1 = 33. المتاح للتطبيق = 200 - 20 = 180. لكل نسخة = 180 / 8 = 22. والحجم المعدّل 22 لأن المثالي 33 مضروبًا في 8 نسخ (264) سيتجاوز الاتصالات المتاحة البالغة 180."
    },
    {
      "text": "لماذا يمنع GenerationType.IDENTITY ‏Hibernate من تجميع عبارات INSERT في دفعات؟",
      "options": [
        "أعمدة IDENTITY تتطلب جولة شبكة منفصلة لاسترجاع المعرّف المولّد قبل أن يضيف Hibernate الكيان إلى ذاكرته من المستوى الأول، فتكسر تجميع الدفعة",
        "IDENTITY غير مدعوم في PostgreSQL ويرجع بصمت إلى إدراجات أحادية الصف",
        "يجمع Hibernate التحديثات فقط في دفعات، لا الإدراجات أبدًا، بغض النظر عن استراتيجية توليد المعرّف",
        "استراتيجية IDENTITY تتطلب autocommit=true، وهو ما يعطّل دفعات مجمع الاتصالات"
      ],
      "correct": 0,
      "explanation": "مع استراتيجية IDENTITY، تولّد قاعدة البيانات المعرّف عند INSERT ويجب على Hibernate تنفيذ INSERT فورًا للحصول على المفتاح المولّد (المطلوب لخريطة هوية الكيانات). وهذا يمنع تجميع الدفعة. واستخدم SEQUENCE مع allocationSize بدلًا من ذلك، فهو يجلب كتل معرّفات مسبقًا فيتيح لـ Hibernate تجميع إدراجات كثيرة قبل التفريغ."
    },
    {
      "text": "ما أثر reWriteBatchedInserts=true في pgjdbc، ومتى ينطبق؟",
      "options": [
        "يعيد كتابة عبارات UPDATE كـ INSERT ... ON CONFLICT من أجل الـ idempotency",
        "يعيد كتابة عبارات INSERT أحادية الصف المتعددة المنفذة في دفعة JDBC إلى عبارات INSERT VALUES (...), (...), (...) متعددة الصفوف، فيقلل العمل لكل عبارة على الخادم",
        "يفعّل تخزين العبارات المُعدّة على الخادم للعمليات الدفعية",
        "يقسم الدفعات الكبيرة تلقائيًا إلى دفعات فرعية أصغر لتجنب مهل الأقفال"
      ],
      "correct": 1,
      "explanation": "يجعل reWriteBatchedInserts=true مشغّل pgjdbc يحوّل استدعاء executeBatch() لـ N عبارة INSERT أحادية الصف إلى عبارات INSERT VALUES(...), (...), ... متعددة الصفوف (على أجزاء حتى 128 صفًا). ولأن pgjdbc يرسل العبارات الدفعية بالتوالي أصلًا، يأتي المكسب من أن الخادم ينفذ عبارات أقل بكثير — غالبًا تحسين في الإنتاجية بمقدار 2–3 أضعاف لأحمال الإدراج الدفعي. وهو ينطبق على دفعات INSERT فقط."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مُدرج دفعات التسوية — 100 ألف صف في 30 ثانية",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "اكتب صنف SettlementBatchInserter يقبل List<LedgerEntry>، ويُدرج باستخدام دفعات JDBC بحجم دفعة قابل للضبط، وينفذ معالجة متوازية عبر اتصالات قاعدة بيانات متعددة، ويسجّل المقاييس بما فيها المدة الكلية والصفوف في الثانية وعدد الدفعات."},
    {"id": "2", "description": "أضف دلالات تراجع مناسبة: إذا فشلت أي دفعة، تراجع عن معاملة تلك الدفعة فقط مع الحفاظ على الدفعات الملتزمة بنجاح، وسجّل أرقام الدفعات التي فشلت."},
    {"id": "3", "description": "اكتب مقياس JMH باسم ConnectionPoolBenchmark يقيس أثر أحجام المجمع المختلفة (5، و10، و20) وأحجام الدفعات (50، و250، و500) على إنتاجية إدراج 100,000 صف."},
    {"id": "4", "description": "وثّق خصائص pgjdbc التي ستضبطها لهذا الحمل (reWriteBatchedInserts، وpreparedStatementCacheQueries، وsocketTimeout) وبرر كل إعداد."}
  ]
}
-->
