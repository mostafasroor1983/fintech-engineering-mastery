---
id: track-08-lesson-08
title: "النسخ المقروءة — توجيه الاستعلامات وإدارة التأخر"
slug: read-replicas
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 8
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [read-replica, replication-lag, query-routing, consistency, CQRS]
prerequisites: []
---

# نسخ القراءة — توجيه الاستعلامات وإدارة التأخر

> [!NOTE]
> نسخ القراءة (read replicas) بسيطة الإعداد على نحو خادع ومعقدة التشغيل الصحيح على نحو مفاجئ. فالفجوة بين "النسخة تعمل" و"النسخة آمنة للإنتاج" تحوي فخاخ اتساق دقيقة، وأخطاء ناتجة عن التأخر، ونقاطًا عمياء في المراقبة. ويغطي هذا الدرس دورة الحياة الكاملة: آليات النسخ، واستراتيجيات التوجيه، وإدارة التأخر، وضمانات الاتساق التي تحتاجها التطبيقات المالية فعلًا.

## 1. بنية النسخ التدفقي في PostgreSQL

### 1.1 كيف يعمل النسخ التدفقي

يقوم النسخ في PostgreSQL على WAL ‏(سجل الكتابة المسبقة). فيرسل الخادم الأساسي سجلات WAL إلى النسخ الاحتياطية، التي تطبقها باستمرار.

```
Primary Database
     │
     │ WAL segments (continuous stream)
     │ (wal_sender process)
     ▼
Standby (Read Replica)
     │
     │ (walreceiver process receives WAL)
     │ (startup process applies WAL)
     ▼
  Replica Data Files (eventually consistent copy)
```

```sql
-- On the primary: check WAL sender status
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    write_lag,
    flush_lag,
    replay_lag
FROM pg_stat_replication;
-- replay_lag = how far behind the replica is (time-based)
-- (sent_lsn - replay_lsn) = how much WAL is in transit
```

### 1.2 النسخ المتزامن مقابل غير المتزامن

**غير المتزامن (الافتراضي):** يلتزم الأساسي قبل أن تؤكد النسخة. واحتمال فقد البيانات عند فشل الأساسي يساوي تأخر النسخ.

**المتزامن:** ينتظر الأساسي تأكيد النسخة قبل إعادة النجاح للعميل. فلا يضيع أي التزام مؤكد إذا فشل الأساسي (ما دمت تتحول إلى نسخة متزامنة)، لكن كل كتابة تدفع جولة النسخة — وإذا لم تتوفر نسخة متزامنة، تنتظر عمليات الالتزام.

```sql
-- Configure synchronous replication for a critical replica
-- postgresql.conf on primary:
synchronous_standby_names = 'FIRST 1 (replica1, replica2)'
-- FIRST 1: wait for at least 1 of the named standbys to confirm

-- Synchronous confirmation levels:
-- synchronous_commit = remote_write  (replica wrote to OS buffer)
-- synchronous_commit = remote_apply  (replica applied changes — readable)
-- synchronous_commit = on            (replica flushed to disk)
```

```sql
-- For a fintech system: use synchronous replication for the primary replica
-- Use asynchronous for read-only reporting replicas
-- postgresql.conf:
synchronous_standby_names = 'FIRST 1 (replica_sync)'
-- replica_sync: synchronous, used for critical reads
-- replica_reporting: asynchronous, used for heavy analytics
```

## 2. قياس تأخر النسخ

### 2.1 قياس التأخر على الأساسي

```sql
-- Primary side: detailed lag view
SELECT
    application_name,
    client_addr AS replica_address,
    state,
    sync_state,
    pg_wal_lsn_diff(sent_lsn, replay_lsn) AS bytes_behind,
    write_lag,
    flush_lag,
    replay_lag  -- Most important: how old is the replica's data?
FROM pg_stat_replication
ORDER BY replay_lag DESC NULLS LAST;
```

### 2.2 قياس التأخر على النسخة

```sql
-- Replica side: check how far behind we are
SELECT
    now() - pg_last_xact_replay_timestamp() AS replication_lag,
    pg_last_wal_receive_lsn() AS received_lsn,
    pg_last_wal_replay_lsn() AS replayed_lsn,
    pg_is_in_recovery() AS is_replica,
    pg_last_xact_replay_timestamp() AS last_applied_at;
```

**احذر:** ‏`now() - pg_last_xact_replay_timestamp()` هو الوقت منذ آخر *معاملة أعيد تشغيلها*. فحين يكون الأساسي خاملًا (لا كتابات)، يستمر في النمو رغم أن النسخة لحقت تمامًا. فقارن مواضع LSN ‏(`pg_last_wal_receive_lsn()` مقابل `pg_last_wal_replay_lsn()`، أو `pg_stat_replication.replay_lag` على الأساسي)، أو اجعل الأساسي يكتب صف نبض كل بضع ثوانٍ كي يبقى الطابع الزمني ذا معنى.

### 2.3 مقاييس Prometheus لتأخر النسخ

```java
@Component
@Slf4j
public class ReplicationLagMetrics {

    private final JdbcTemplate replicaJdbc;
    private final AtomicLong replicaLagSeconds = new AtomicLong(Long.MAX_VALUE);

    public ReplicationLagMetrics(@Qualifier("replicaJdbc") JdbcTemplate replicaJdbc,
                                 MeterRegistry meterRegistry) {
        this.replicaJdbc = replicaJdbc;
        // Register the gauge ONCE; the scheduled job only updates the holder
        Gauge.builder("db.replication.lag.seconds", replicaLagSeconds, AtomicLong::get)
            .description("Replication lag in seconds (Long.MAX_VALUE = unknown)")
            .tag("replica", "read_replica_1")
            .register(meterRegistry);
    }

    @Scheduled(fixedDelay = 5000)  // Check every 5 seconds
    public void measureReplicationLag() {
        try {
            // Assumes the primary writes a heartbeat row every second, so the
            // replay timestamp does not grow while the system is idle
            Long lagSeconds = replicaJdbc.queryForObject(
                """
                SELECT EXTRACT(EPOCH FROM (
                    now() - pg_last_xact_replay_timestamp()
                ))::BIGINT AS lag_seconds
                """, Long.class);

            // NULL = nothing replayed yet: treat as UNKNOWN, not as "fresh"
            replicaLagSeconds.set(lagSeconds != null ? lagSeconds : Long.MAX_VALUE);

        } catch (Exception e) {
            log.error("Failed to measure replication lag", e);
            replicaLagSeconds.set(Long.MAX_VALUE);  // Mark as unknown/unavailable
        }
    }

    public long getCurrentLagSeconds() {
        return replicaLagSeconds.get();
    }

    public boolean isReplicaAcceptablyFresh(long maxLagSeconds) {
        return replicaLagSeconds.get() <= maxLagSeconds;
    }
}
```

## 3. ‏AbstractRoutingDataSource في Spring لتوجيه القراءة/الكتابة

### 3.1 تنفيذ توجيه مصدر البيانات

```java
public enum DataSourceType {
    PRIMARY, REPLICA
}
```

```java
public class RoutingDataSourceContext {

    private static final ThreadLocal<DataSourceType> context =
        new ThreadLocal<>();

    public static void setDataSourceType(DataSourceType type) {
        context.set(type);
    }

    public static DataSourceType getDataSourceType() {
        return context.get();
    }

    public static void clearDataSourceType() {
        context.remove();
    }

    public static boolean isReplicaRequested() {
        return REPLICA.equals(context.get());
    }
}
```

```java
@Component
public class ReplicationRoutingDataSource
    extends AbstractRoutingDataSource {

    private final ReplicationLagMetrics lagMetrics;

    @Value("${db.replica.max-lag-seconds:5}")
    private long maxAcceptableLagSeconds;

    public ReplicationRoutingDataSource(
            @Qualifier("primaryDataSource") DataSource primary,
            @Qualifier("replicaDataSource") DataSource replica,
            ReplicationLagMetrics lagMetrics) {
        this.lagMetrics = lagMetrics;

        Map<Object, Object> dataSources = new HashMap<>();
        dataSources.put(DataSourceType.PRIMARY, primary);
        dataSources.put(DataSourceType.REPLICA, replica);

        setTargetDataSources(dataSources);
        setDefaultTargetDataSource(primary);
        afterPropertiesSet();
    }

    @Override
    protected Object determineCurrentLookupKey() {
        DataSourceType requested =
            RoutingDataSourceContext.getDataSourceType();

        // Route to replica only if explicitly requested AND lag is acceptable
        if (DataSourceType.REPLICA.equals(requested)) {
            if (lagMetrics.isReplicaAcceptablyFresh(maxAcceptableLagSeconds)) {
                return DataSourceType.REPLICA;
            } else {
                log.warn("Replica lag too high ({}s), routing to primary",
                    lagMetrics.getCurrentLagSeconds());
                return DataSourceType.PRIMARY;
            }
        }

        return DataSourceType.PRIMARY;
    }
}
```

يُقيّم مفتاح البحث حين **يُحصل على اتصال**. ومع JPA، يأخذ `@Transactional` الاتصال عند بدء المعاملة، لذا يجب اتخاذ قرار التوجيه قبل ذلك (القسم التالي). وتغليف مصدر البيانات الموجّه بـ `LazyConnectionDataSourceProxy` من Spring يؤخر جلب الاتصال الفعلي حتى أول عبارة، فيجعل التوجيه أكثر تسامحًا.

### 3.2 ‏AOP للتوجيه التلقائي

```java
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface ReadFromReplica {
    boolean fallbackToPrimary() default true;
}
```

```java
@Aspect
@Component
// Must run BEFORE @Transactional. The transaction advisor has the lowest
// precedence by default, so any higher-precedence order such as 1 works.
// (Note: "@annotation(...)" matches method-level annotations only.)
@Order(1)
public class ReadReplicaRoutingAspect {

    @Around("@annotation(readFromReplica)")
    public Object routeToReplica(ProceedingJoinPoint joinPoint,
                                  ReadFromReplica readFromReplica) throws Throwable {
        RoutingDataSourceContext.setDataSourceType(DataSourceType.REPLICA);
        try {
            return joinPoint.proceed();
        } finally {
            RoutingDataSourceContext.clearDataSourceType();
        }
    }
}
```

```java
@Service
public class TransactionHistoryService {

    // Automatically routes to replica
    @ReadFromReplica
    @Transactional(readOnly = true, isolation = Isolation.READ_COMMITTED)
    public Page<TransactionSummary> getTransactionHistory(
            String accountId,
            LocalDate from,
            LocalDate to,
            Pageable pageable) {
        return transactionRepository.findByAccountAndDateRange(
            accountId, from, to, pageable);
    }

    // Always uses primary (default — no annotation)
    @Transactional
    public Transaction recordTransaction(TransactionRequest request) {
        return transactionRepository.save(Transaction.from(request));
    }
}
```

## 4. مشكلة اتساق "اقرأ ما كتبت"

أشيع مشكلات الاتساق مع نسخ القراءة وأخطرها: يكتب مستخدم بيانات إلى الأساسي، ثم يقرأ فورًا من نسخة لم تنسخ التغيير بعد — فيرى بيانات قديمة.

### 4.1 السيناريو

```
Time 0: User submits payment → written to PRIMARY
Time 1: User requests confirmation page → reads from REPLICA
Time 2: Replication lag = 500ms
Result: Confirmation page shows "payment not found" or old balance
```

هذا خطر على تدفق تأكيد الدفع: فقد يعيد المستخدمون المحاولة، ودون حماية idempotency، ينشئون مدفوعات مكررة.

### 4.2 "اقرأ ما كتبت" القائم على الجلسة

```java
@Service
public class ConsistencyAwareAccountService {

    private final ReplicationRoutingDataSource routingDataSource;

    private final ReadConsistencyContext readConsistencyContext;

    /**
     * After a write, force this USER's reads to the primary for a while.
     * The confirmation page is usually a NEW HTTP request, so the flag must
     * outlive the current request: keep it in the user's session (or a
     * short-lived cookie / Redis entry keyed by user).
     */
    @Transactional
    public Payment createPayment(PaymentRequest request) {
        Payment payment = paymentRepository.save(Payment.from(request));

        // For the next few seconds, this user's reads go to the primary
        readConsistencyContext.requirePrimaryFor(Duration.ofSeconds(5));

        return payment;
    }
}
```

```java
// Session scope: survives the redirect to the confirmation page.
// (Injected into the singleton routing DataSource through a scoped proxy;
//  outside an HTTP request -- scheduled jobs, consumers -- there is no
//  session, so the routing code must treat that case as "not required".)
@Component
@SessionScope
public class ReadConsistencyContext implements Serializable {

    private Instant primaryRequiredUntil = Instant.MIN;

    public void requirePrimaryFor(Duration duration) {
        this.primaryRequiredUntil = Instant.now().plus(duration);
    }

    public boolean isPrimaryRequired() {
        return Instant.now().isBefore(primaryRequiredUntil);
    }
}
```

```java
// Update the routing datasource to check consistency context
@Override
protected Object determineCurrentLookupKey() {
    // Check session-level primary requirement first
    if (readConsistencyContext.isPrimaryRequired()) {
        return DataSourceType.PRIMARY;
    }

    DataSourceType requested = RoutingDataSourceContext.getDataSourceType();
    if (DataSourceType.REPLICA.equals(requested)
            && lagMetrics.isReplicaAcceptablyFresh(maxAcceptableLagSeconds)) {
        return DataSourceType.REPLICA;
    }

    return DataSourceType.PRIMARY;
}
```

### 4.3 "اقرأ ما كتبت" القائم على LSN ‏(متقدم)

نهج أدق: بعد أن **تلتزم** الكتابة، التقط موضع LSN الحالي للأساسي وانتظر حتى تعيد النسخة التشغيل إلى ذلك الموضع على الأقل قبل القراءة منها. (التقاط LSN داخل المعاملة التي ما زالت مفتوحة خطأ: فسجل الالتزام يأتي لاحقًا، فقد تبلغ النسخة ذلك الموضع دون أن ترى الدفعة. وتبديل مصدر البيانات داخل معاملة مفتوحة لا يعمل أيضًا — فالاتصال مربوط أصلًا.)

```java
@Service
public class LsnAwareReadService {

    // NOT @Transactional: the write must commit before we look at the LSN
    public PaymentConfirmation submitAndConfirm(PaymentRequest request) {
        // 1. Write to primary and COMMIT
        Payment payment = primaryTx.execute(status ->
            paymentRepository.save(Payment.from(request)));

        // 2. Capture the primary's WAL position AFTER the commit
        String primaryLsn = primaryJdbc.queryForObject(
            "SELECT pg_current_wal_lsn()::text", String.class);

        // 3. Wait for replica to catch up to this LSN (up to 2 seconds)
        boolean replicaCaughtUp = waitForReplicaLsn(primaryLsn, Duration.ofSeconds(2));

        // 4. Read in a NEW transaction: replica if caught up, primary if not
        if (replicaCaughtUp) {
            RoutingDataSourceContext.setDataSourceType(DataSourceType.REPLICA);
        }
        try {
            return readOnlyTx.execute(status ->
                paymentRepository.findConfirmationById(payment.getId()));
        } finally {
            RoutingDataSourceContext.clearDataSourceType();
        }
    }

    private boolean waitForReplicaLsn(String targetLsn, Duration timeout) {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            Boolean caught = replicaJdbc.queryForObject(
                "SELECT pg_last_wal_replay_lsn() >= ?::pg_lsn",
                Boolean.class, targetLsn);

            if (Boolean.TRUE.equals(caught)) return true;

            LockSupport.parkNanos(Duration.ofMillis(10).toNanos());
        }
        return false;
    }
}
```

## 5. النسخة لاستعلامات التقارير

يجب ألا تعمل استعلامات التقارير الثقيلة (توليد الكشوف الشهرية، وتجميعات المخاطر، وتقارير الامتثال) على الأساسي أبدًا. فهي تخلق معاملات طويلة التشغيل تحجب VACUUM وتنافس الأحمال التعاملية.

وعلى النسخة تواجه مشكلة مختلفة: **تعارضات التعافي**. فحين ينظف الأساسي نسخ صفوف ما زال استعلام طويل على النسخة يحتاجها، يجب على النسخة إما إيقاف إعادة تشغيل WAL مؤقتًا (فيزيد التأخر) أو إلغاء الاستعلام (`canceling statement due to conflict with recovery`). والمقابض: `max_standby_streaming_delay` (كم يمكن أن تنتظر إعادة التشغيل — نسخة تقارير مخصصة تحتمل دقائق، ونسخة تُستخدم لقراءات حديثة لا تحتمل) و`hot_standby_feedback = on` (لا إلغاءات، لكن الأساسي يبقي الصفوف الميتة أطول — انتفاخ أكثر هناك). وهذا سبب آخر لإبقاء التقارير على نسختها الخاصة.

### 5.1 نسخة تقارير مخصصة

```java
@Configuration
public class ReportingDataSourceConfig {

    @Bean("reportingDataSource")
    @ConfigurationProperties("spring.datasource.reporting")
    public DataSource reportingDataSource() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(reportingReplicaUrl);
        // Reporting queries are long-running: use larger statement timeout
        config.setConnectionInitSql("SET statement_timeout = '10min'");
        // Smaller pool: reporting is batch, not interactive
        config.setMaximumPoolSize(5);
        return new HikariDataSource(config);
    }
}
```

```java
@Service
public class MonthlyStatementService {

    @Autowired
    @Qualifier("reportingDataSource")
    private DataSource reportingDataSource;

    public MonthlyStatement generateStatement(String accountId,
                                               YearMonth month) {
        // Runs on dedicated reporting replica
        // Will NOT affect primary transactional workload
        JdbcTemplate reportingJdbc = new JdbcTemplate(reportingDataSource);

        return reportingJdbc.query(
            """
            SELECT
                t.transaction_id,
                t.transaction_date,
                t.amount,
                t.currency,
                t.description,
                t.balance_after,
                t.reference_id
            FROM transactions t
            WHERE t.account_id = ?
              AND t.transaction_date >= ?
              AND t.transaction_date < ?
            ORDER BY t.transaction_date, t.transaction_id
            """,
            rs -> {
                List<TransactionLine> lines = new ArrayList<>();
                while (rs.next()) {
                    lines.add(mapTransactionLine(rs));
                }
                return MonthlyStatement.of(accountId, month, lines);
            },
            accountId,
            month.atDay(1),
            month.plusMonths(1).atDay(1));
    }
}
```

## 6. نموذج قراءة CQRS على النسخة

فصل مسؤولية الأوامر عن الاستعلامات (CQRS) ملاءمة طبيعية لبنى نسخ القراءة. فنموذج الكتابة (الأوامر) يذهب إلى الأساسي؛ ونموذج القراءة (الاستعلامات) يعمل على النسخة.

### 6.1 نمط مستودع نموذج القراءة

```java
// COMMAND side: writes to primary
@Repository
public interface AccountCommandRepository
    extends JpaRepository<Account, String> {
    // Uses primary datasource
}

// QUERY side: reads from replica (the routing comes from @ReadFromReplica on
// the calling service -- a @Qualifier on the repository does not route)
@Repository
public interface AccountQueryRepository extends Repository<Account, String> {

    @Query(value = """
        SELECT
            a.account_id,
            a.balance,
            a.currency,
            a.account_type,
            c.full_name AS customer_name,
            COUNT(t.transaction_id) AS transaction_count_30d,
            SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)
                AS credits_30d,
            SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END)
                AS debits_30d
        FROM accounts a
        JOIN customers c ON c.customer_id = a.customer_id
        LEFT JOIN transactions t ON t.account_id = a.account_id
            AND t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
        WHERE a.account_id = :accountId
        GROUP BY a.account_id, a.balance, a.currency,
                 a.account_type, c.full_name
        """, nativeQuery = true)
    AccountDashboardView getDashboard(@Param("accountId") String accountId);
}
```

```java
@Service
public class AccountQueryService {

    private final AccountQueryRepository queryRepo;

    @ReadFromReplica
    @Transactional(readOnly = true)
    public AccountDashboardView getAccountDashboard(String accountId) {
        return queryRepo.getDashboard(accountId);
    }
}

@Service
public class AccountCommandService {

    private final AccountCommandRepository commandRepo;
    private final AccountEventPublisher eventPublisher;

    @Transactional  // Writes to primary
    public Account openAccount(OpenAccountRequest request) {
        Account account = Account.open(request);
        account = commandRepo.save(account);
        // Publish via an outbox row in this same transaction (track 05),
        // so the event cannot be lost or sent for a rolled-back account
        eventPublisher.publish(new AccountOpenedEvent(account));
        return account;
    }
}
```

## 7. التوجيه الواعي بالتأخر — لا توجّه إلى نسخة متأخرة

### 7.1 عتبة تأخر ديناميكية

للعمليات المختلفة تسامحات مختلفة مع التأخر:

```java
@Service
public class AdaptiveReplicaRouter {

    private final Map<String, Duration> operationLagTolerances = Map.of(
        "account.balance.display",    Duration.ofSeconds(10),  // Tolerate 10s
        "transaction.history",        Duration.ofSeconds(30),  // Tolerate 30s
        "fraud.check",                Duration.ofSeconds(0),   // Always primary
        "reporting.monthly",          Duration.ofMinutes(5)    // Tolerate 5min
    );

    public DataSourceType routeForOperation(String operationName) {
        Duration tolerance = operationLagTolerances
            .getOrDefault(operationName, Duration.ofSeconds(5));

        // Zero tolerance = ALWAYS primary. (Lag is measured in whole seconds,
        // so a replica 0.8 s behind reports 0 -- "0 <= 0" would wrongly
        // send fraud checks to it.)
        if (tolerance.isZero()) {
            return DataSourceType.PRIMARY;
        }

        long lagSeconds = lagMetrics.getCurrentLagSeconds();

        if (lagSeconds <= tolerance.toSeconds()) {
            return DataSourceType.REPLICA;
        } else {
            // Tag by operation only: putting the lag VALUE in a tag would
            // create a new time series for every value (cardinality explosion)
            Metrics.counter("db.routing.fallback_to_primary",
                "operation", operationName)
                .increment();
            return DataSourceType.PRIMARY;
        }
    }
}
```

### 7.2 قاطع دائرة لتوفر النسخة

```java
@Component
public class ReplicaCircuitBreaker {

    private final CircuitBreaker circuitBreaker;
    private final ReplicationLagMetrics lagMetrics;

    public ReplicaCircuitBreaker(CircuitBreakerRegistry registry,
                                  ReplicationLagMetrics lagMetrics) {
        this.lagMetrics = lagMetrics;
        this.circuitBreaker = registry.circuitBreaker("replica",
            CircuitBreakerConfig.custom()
                .failureRateThreshold(50)       // Open at 50% failure rate
                .waitDurationInOpenState(Duration.ofSeconds(30))
                .permittedNumberOfCallsInHalfOpenState(5)
                .build());
    }

    public <T> T executeOnReplica(Supplier<T> replicaQuery,
                                   Supplier<T> primaryFallback) {
        if (circuitBreaker.getState() == CircuitBreaker.State.OPEN
                || lagMetrics.getCurrentLagSeconds() > 60) {
            // Circuit open or lag too high: go to primary
            return primaryFallback.get();
        }

        try {
            return circuitBreaker.executeSupplier(replicaQuery);
        } catch (Exception e) {
            // Replica failed (or the breaker just opened): use the primary
            return primaryFallback.get();
        }
    }
}
```

## 8. مراقبة صحة النسخ

### 8.1 المقاييس الأساسية للتنبيه عليها

```sql
-- Primary: check all replica states
SELECT
    application_name,
    sync_state,
    replay_lag,
    CASE
        WHEN replay_lag > INTERVAL '30 seconds' THEN 'CRITICAL'
        WHEN replay_lag > INTERVAL '5 seconds'  THEN 'WARNING'
        ELSE 'OK'
    END AS lag_status
FROM pg_stat_replication;

-- Replica: check if replication is active
SELECT
    CASE
        WHEN pg_is_in_recovery() = FALSE THEN 'NOT A REPLICA'
        WHEN pg_last_xact_replay_timestamp() IS NULL THEN 'NEVER REPLICATED'
        WHEN now() - pg_last_xact_replay_timestamp() > INTERVAL '60 seconds'
            THEN 'LAG CRITICAL'
        WHEN now() - pg_last_xact_replay_timestamp() > INTERVAL '10 seconds'
            THEN 'LAG WARNING'
        ELSE 'OK'
    END AS replication_status,
    now() - pg_last_xact_replay_timestamp() AS current_lag;
```

### 8.2 إعداد التنبيه (Prometheus AlertManager)

```yaml
# prometheus-rules.yaml
# (metric names depend on your exporter -- e.g. postgres_exporter or a
#  custom gauge such as db_replication_lag_seconds from the code above)
groups:
  - name: postgresql_replication
    rules:
      - alert: PostgreSQLReplicationLagHigh
        expr: pg_replication_lag_seconds > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "PostgreSQL replication lag > 10s"
          description: "Replica {{ $labels.replica }} is {{ $value }}s behind primary"

      - alert: PostgreSQLReplicationLagCritical
        expr: pg_replication_lag_seconds > 60
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL replication lag > 60s — replica routing disabled"

      - alert: PostgreSQLReplicationDown
        # the lag gauge from section 2.3 reports Long.MAX_VALUE = "unknown"
        # (replica unreachable or nothing replayed)
        expr: db_replication_lag_seconds > 1e9
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL replication stopped"
```

## 9. إعداد الإنتاج

```ini
# postgresql.conf on primary
wal_level = replica           # Minimum for streaming replication
max_wal_senders = 10          # Max concurrent WAL sender processes
wal_keep_size = 1GB           # Keep this much WAL for lagging replicas (PG13+)

# postgresql.conf on the standby
hot_standby = on              # Allow queries on standbys (on by default)
max_standby_streaming_delay = 30s   # how long replay may wait for queries

# Replication slot (for persistent WAL retention — use with Debezium/CDC)
# WARNING: slots that fall behind cause WAL accumulation and disk fill
# Monitor pg_replication_slots.restart_lsn vs pg_current_wal_lsn()

# pg_hba.conf on primary (allow replica connections)
# host replication replication_user replica_ip/32 scram-sha-256
```

```yaml
# application.yml: Spring multi-datasource configuration
spring:
  datasource:
    primary:
      url: jdbc:postgresql://primary.db.internal:5432/payments
      username: app_user
      hikari:
        maximum-pool-size: 20
        minimum-idle: 5
        connection-timeout: 3000
    replica:
      url: jdbc:postgresql://replica.db.internal:5432/payments
      username: app_readonly
      hikari:
        maximum-pool-size: 30     # More readers than writers
        minimum-idle: 5
        read-only: true           # Prevents accidental writes
        connection-timeout: 3000
        connection-init-sql: "SET default_transaction_read_only = on"

db:
  replica:
    max-lag-seconds: 5          # Route to primary if lag exceeds this
```

## الخلاصة

تتطلب نسخ القراءة في التقنية المالية أكثر من سلاسل اتصال — بل تتطلب استراتيجية اتساق متماسكة:

- **النسخ التدفقي** ينسخ WAL من الأساسي إلى النسخ الاحتياطية باستمرار؛ والتأخر هو القيد الجوهري
- **النسخ المتزامن** يلغي خطر فقد البيانات لكنه يضيف زمنًا للكتابة — استخدمه انتقائيًا للنسخ الحرجة
- **‏AbstractRoutingDataSource** مع تعليقات AOP يوفر توجيهًا نظيفًا وشفافًا في Spring
- **التوجيه الواعي بالتأخر** يمنع تقديم بيانات قديمة — لا توجّه أبدًا إلى نسخة تتجاوز تسامح عمليتك
- **اتساق "اقرأ ما كتبت"** يكسره التوجيه الساذج إلى النسخة بعد الكتابات — أصلحه بسياق الجلسة، أو الانتظار القائم على LSN، أو الرجوع إلى الأساسي
- **‏CQRS** يضفي الطابع الرسمي على الفصل: الأوامر إلى الأساسي، والاستعلامات إلى النسخة — فيقلل الاقتران العرضي
- **قاطع الدائرة** يحمي التطبيق حين تتأخر نسخة أو تصبح غير متاحة
- نبّه على تأخر النسخ عند عتبة التحذير (5–10 ثوانٍ) والعتبة الحرجة (60 ثانية) — فالتأخر الصامت خطأ صحة

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يقدّم مستخدم دفعة في الوقت T=0. وتُكتب الدفعة إلى الأساسي. وفي T=0.3 ثانية، يُعاد توجيه المستخدم إلى صفحة تأكيد. ويُوجه استعلام صفحة التأكيد إلى نسخة قراءة بتأخر نسخ 500 مللي ثانية. ما المشكلة التي تحدث وما أوثق إصلاح؟",
      "options": ["لا مشكلة لأن تأخر 500 مللي ثانية ضمن الحدود المقبولة", "تُظهر صفحة التأكيد بيانات قديمة أو 'الدفعة غير موجودة'، ما قد يجعل المستخدم يعيد المحاولة وينشئ دفعة مكررة؛ والإصلاح بإجبار القراءات على الأساسي لنافذة قصيرة بعد الكتابات", "سترفض النسخة الاستعلام بسبب كشف التأخر", "زِد max_wal_senders لتقليل تأخر النسخ"],
      "correct": 1,
      "explanation": "هذه مشكلة اتساق \"اقرأ ما كتبت\". فبعد كتابة إلى الأساسي، قد تعيد قراءة من نسخة متأخرة الحالة السابقة، فيرى المستخدم 'الدفعة غير موجودة' وقد يعيد المحاولة. والإصلاح تذكّر أن هذا المستخدم كتب للتو (في الجلسة، أو كعكة قصيرة العمر، أو عبر LSN) وإرسال قراءاته إلى الأساسي لنافذة قصيرة، أو حتى تعيد النسخة التشغيل بعد التزام الكتابة."
    },
    {
      "text": "أي ترتيب للتعليقات مطلوب كي يعمل توجيه AbstractRoutingDataSource عبر AOP بشكل صحيح مع @Transactional؟",
      "options": ["يجب أن يعمل @Transactional قبل @ReadFromReplica", "يجب أن يعمل مظهر @ReadFromReplica قبل @Transactional (مثلًا @Order(1)؛ مستشار المعاملات له أدنى أولوية افتراضيًا) كي يُختار مصدر البيانات قبل فتح الاتصال", "لا يهم الترتيب لأنهما يعملان على اهتمامات مختلفة", "يجب أن يكون @Transactional والتوجيه في طبقتي خدمة منفصلتين"],
      "correct": 1,
      "explanation": "تفتح إدارة المعاملات في Spring اتصال قاعدة بيانات حين يبدأ @Transactional. فإذا عمل مظهر التوجيه بعد @Transactional، يكون مفتاح بحث مصدر البيانات قد استُخدم والاتصال من المصدر الخطأ. لذا يجب أن يعمل مظهر التوجيه أولًا (رقم ترتيب أقل = أولوية أعلى) كي يُختار مصدر البيانات الصحيح قبل الحصول على الاتصال."
    },
    {
      "text": "لدى منصة دفع خدمة فحص احتيال تقرأ سجل الحساب لكشف الشذوذ. ويجب أن يعكس فحص الاحتيال البيانات المكتوبة خلال آخر 500 مللي ثانية. وتأخر النسخ حاليًا 8 ثوانٍ. ماذا يجب أن يفعل مصدر البيانات الموجّه؟",
      "options": ["التوجيه إلى النسخة وقبول البيانات القديمة", "التوجيه إلى الأساسي لأن تأخر النسخة (8 ثوانٍ) يتجاوز تسامح العملية (0.5 ثانية)، وزيادة مقياس عدّاد الرجوع", "حجب فحص الاحتيال حتى تلحق النسخة", "تعطيل النسخ واستخدام الأساسي فقط"],
      "correct": 1,
      "explanation": "يجب أن يقارن التوجيه الواعي بالتأخر تأخر النسخ الحالي بتسامح العملية المحددة. ولفحوص الاحتيال التي تتطلب بيانات حديثة (تسامح 0.5 ثانية)، ستعيد نسخة متأخرة 8 ثوانٍ بيانات قديمة خطيرة. فيجب أن يرجع منطق التوجيه إلى الأساسي ويسجّل مقياسًا. وهذا نمط التوجيه التكيفي حيث للعمليات المختلفة تسامحات تأخر مختلفة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء نظام توجيه واعٍ بالتأخر لنسخ القراءة",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ ReplicationLagMetrics يستطلع النسخة كل 5 ثوانٍ باستخدام pg_last_xact_replay_timestamp() ويكشف التأخر كمقياس Micrometer من نوع Gauge. ويجب ضبط المقياس على Long.MAX_VALUE حين تكون النسخة غير قابلة للوصول، ويجب أن تعيد دالة isReplicaAcceptablyFresh(long maxLagSeconds) القيمة false حين يكون التأخر مجهولًا."},
    {"id": "2", "description": "نفّذ ReplicationRoutingDataSource الذي يرث AbstractRoutingDataSource بدالة determineCurrentLookupKey() التي: (أ) توجّه دائمًا إلى الأساسي إذا كانت ReadConsistencyContext.isPrimaryRequired() صحيحة، (ب) توجّه إلى النسخة فقط إذا طُلبت REPLICA وكان التأخر مقبولًا، (ج) ترجع إلى الأساسي مع تحذير مسجّل حين يتجاوز التأخر العتبة. واكتب اختبار وحدة بـ lagMetrics وهمي يتحقق من مسارات التوجيه الثلاثة."},
    {"id": "3", "description": "أنشئ مظهر AOP باسم @ReadFromReplica بـ @Order(1) يضبط سياق مصدر البيانات قبل أن يفتح @Transactional اتصالًا. وطبّقه على دالة TransactionHistoryService.getHistory(). واكتب اختبار تكامل باستخدام Testcontainers يتحقق من أن الاستعلام يُنفذ على اتصال النسخة (بفحص pg_stat_activity.client_addr أو اسم مجمع الاتصالات)."},
    {"id": "4", "description": "نفّذ اتساق \"اقرأ ما كتبت\" القائم على LSN لتدفق تأكيد الدفع: التزم بإدراج الدفعة أولًا، ثم التقط pg_current_wal_lsn() من الأساسي، ثم استطلع pg_last_wal_replay_lsn() على النسخة حتى يبلغ LSN الملتقط أو تنتهي مهلة ثانيتين. فإذا لحقت النسخة، اقرأ التأكيد منها في معاملة جديدة؛ وإلا ارجع إلى الأساسي. وقِس زمن الانتظار وسجّله كمقياس."}
  ]
}
-->
