---
id: track-08-lesson-08
title: "Read Replicas — Query Routing and Lag Management"
slug: read-replicas
track: track-08
trackName: "Database & Data Architecture"
sequence: 8
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [read-replica, replication-lag, query-routing, consistency, CQRS]
prerequisites: []
---

# Read Replicas — Query Routing and Lag Management

> [!NOTE]
> Read replicas are deceptively simple to set up and surprisingly complex to operate correctly. The gap between "replica is running" and "replica is production-safe" contains subtle consistency traps, lag-induced bugs, and monitoring blind spots. This lesson covers the full lifecycle: replication mechanics, routing strategies, lag management, and consistency guarantees that financial applications actually require.

---

## 1. PostgreSQL Streaming Replication Architecture

### 1.1 How Streaming Replication Works

PostgreSQL replication is WAL (Write-Ahead Log) based. The primary streams WAL records to standbys, which apply them continuously.

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

### 1.2 Synchronous vs Asynchronous Replication

**Asynchronous (default):** Primary commits before replica confirms. Potential data loss on primary failure equal to the replication lag.

**Synchronous:** Primary waits for replica acknowledgment before returning success to the client. No acknowledged commit is lost if the primary fails (as long as you fail over to a synchronous standby), but every write pays the replica round trip — and if no synchronous standby is available, commits wait.

```ini
# Configure synchronous replication for a critical replica
# postgresql.conf on primary:
synchronous_standby_names = 'FIRST 1 (replica1, replica2)'
# FIRST 1: wait for at least 1 of the named standbys to confirm

# Synchronous confirmation levels:
# synchronous_commit = remote_write  (replica wrote to OS buffer)
# synchronous_commit = remote_apply  (replica applied changes — readable)
# synchronous_commit = on            (replica flushed to disk)
```

```ini
# For a fintech system: use synchronous replication for the primary replica
# Use asynchronous for read-only reporting replicas
# postgresql.conf:
synchronous_standby_names = 'FIRST 1 (replica_sync)'
# replica_sync: synchronous, used for critical reads
# replica_reporting: asynchronous, used for heavy analytics
```

---

## 2. Replication Lag Measurement

### 2.1 Measuring Lag on the Primary

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

### 2.2 Measuring Lag on the Replica

```sql
-- Replica side: check how far behind we are
SELECT
    now() - pg_last_xact_replay_timestamp() AS replication_lag,
    pg_last_wal_receive_lsn() AS received_lsn,
    pg_last_wal_replay_lsn() AS replayed_lsn,
    pg_is_in_recovery() AS is_replica,
    pg_last_xact_replay_timestamp() AS last_applied_at;
```

**Careful:** `now() - pg_last_xact_replay_timestamp()` is the time since the last *replayed transaction*. When the primary is idle (no writes), it keeps growing although the replica is fully caught up. Compare LSNs (`pg_last_wal_receive_lsn()` vs `pg_last_wal_replay_lsn()`, or the primary's `pg_stat_replication.replay_lag`), or have the primary write a heartbeat row every few seconds so the timestamp stays meaningful.

### 2.3 Prometheus Metrics for Replication Lag

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

---

## 3. Spring AbstractRoutingDataSource for Read/Write Routing

### 3.1 DataSource Routing Implementation

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

The lookup key is evaluated when a **connection is obtained**. With JPA, `@Transactional` grabs the connection at the start of the transaction, so the routing decision must be made before that (next section). Wrapping the routing DataSource in Spring's `LazyConnectionDataSourceProxy` delays fetching the physical connection until the first statement, which makes routing more forgiving.

### 3.2 AOP for Automatic Routing

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

---

## 4. The Read-Your-Writes Consistency Problem

The most common and dangerous consistency issue with read replicas: a user writes data to the primary, then immediately reads from a replica that hasn't replicated the change yet — and sees stale data.

### 4.1 The Scenario

```
Time 0: User submits payment → written to PRIMARY
Time 1: User requests confirmation page → reads from REPLICA
Time 2: Replication lag = 500ms
Result: Confirmation page shows "payment not found" or old balance
```

This is dangerous for a payment confirmation flow: users may retry and, without idempotency protection, create duplicate payments.

### 4.2 Session-Based Read-Your-Writes

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

### 4.3 LSN-Based Read-Your-Writes (Advanced)

A more precise approach: after the write has **committed**, capture the primary's current LSN and wait for the replica to replay at least that far before reading from it. (Capturing the LSN inside the still-open transaction is wrong: the commit record comes later, so the replica could reach that LSN without seeing the payment. Switching DataSource inside an open transaction does not work either — the connection is already bound.)

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

---

## 5. Replica for Reporting Queries

Heavy reporting queries (generating monthly statements, running risk aggregations, compliance reports) should never run against the primary. They create long-running transactions that block VACUUM and compete with transactional workloads.

On a replica they meet a different problem: **recovery conflicts**. When the primary vacuums away row versions that a long replica query still needs, the replica must either pause WAL replay (lag grows) or cancel the query (`canceling statement due to conflict with recovery`). The knobs: `max_standby_streaming_delay` (how long replay may wait — a dedicated reporting replica can afford minutes, a replica used for fresh reads cannot) and `hot_standby_feedback = on` (no cancellations, but the primary keeps dead rows longer — more bloat there). This is one more reason to keep reporting on its own replica.

### 5.1 Dedicated Reporting Replica

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

---

## 6. CQRS Read Model on Replica

Command Query Responsibility Segregation (CQRS) is a natural fit for read replica architectures. The write model (commands) goes to the primary; the read model (queries) runs on the replica.

### 6.1 Read Model Repository Pattern

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

---

## 7. Lag-Aware Routing — Don't Route to a Lagging Replica

### 7.1 Dynamic Lag Threshold

Different operations have different lag tolerances:

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

### 7.2 Circuit Breaker for Replica Availability

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

---

## 8. Monitoring Replication Health

### 8.1 Key Metrics to Alert On

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

### 8.2 Alerting Configuration (Prometheus AlertManager)

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

---

## 9. Production Configuration

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

---

## Summary

Read replicas in fintech require more than connection strings — they require a coherent consistency strategy:

- **Streaming replication** copies WAL from primary to standbys continuously; lag is the fundamental constraint
- **Synchronous replication** eliminates data loss risk but adds write latency — use selectively for critical standbys
- **AbstractRoutingDataSource** with AOP annotations provides clean, transparent routing in Spring
- **Lag-aware routing** prevents serving stale data — never route to a replica beyond your operation's tolerance
- **Read-your-writes** consistency is broken by naive replica routing after writes — fix with session context, LSN-based waiting, or primary fallback
- **CQRS** formalises the separation: commands to primary, queries to replica — reduces accidental coupling
- **Circuit breaker** protects the application when a replica falls behind or becomes unavailable
- Alert on replication lag at both warning (5-10s) and critical (60s) thresholds — silent lag is a correctness bug

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A user submits a payment at time T=0. The payment is written to the primary. At T=0.3s, the user is redirected to a confirmation page. The confirmation page query is routed to a read replica with 500ms replication lag. What problem occurs and what is the most reliable fix?",
      "options": [
        "No problem occurs because 500ms lag is within acceptable bounds",
        "The confirmation page shows stale data or 'payment not found', potentially causing the user to retry and create a duplicate payment; fix by forcing reads to the primary for a short window after writes",
        "The replica will refuse the query due to lag detection",
        "Increase max_wal_senders to reduce replication lag"
      ],
      "correct": 1,
      "explanation": "This is the read-your-writes consistency problem. After a write to the primary, a read from a lagging replica may return the previous state, so the user sees 'payment not found' and may retry. The fix is to remember that this user just wrote (in the session, a short-lived cookie, or by LSN) and send their reads to the primary for a short window, or until the replica has replayed past the write's commit."
    },
    {
      "text": "Which Spring annotation order is required for AbstractRoutingDataSource AOP routing to work correctly with @Transactional?",
      "options": [
        "@Transactional must run before @ReadFromReplica",
        "The @ReadFromReplica aspect must run BEFORE @Transactional (e.g. @Order(1); the transaction advisor has the lowest precedence by default) so the DataSource is selected before the connection is opened",
        "The order does not matter because they operate on different concerns",
        "@Transactional and routing must be in separate service layers"
      ],
      "correct": 1,
      "explanation": "Spring's transaction management opens a database connection when @Transactional begins. If the routing aspect runs after @Transactional, the DataSource lookup key has already been used and the connection is already from the wrong source. The routing aspect must run first (lower order number = higher priority) so the correct DataSource is selected before the connection is obtained."
    },
    {
      "text": "A payment platform has a fraud check service that reads account history to detect anomalies. The fraud check must reflect data written within the last 500ms. The replication lag is currently 8 seconds. What should the routing datasource do?",
      "options": [
        "Route to the replica and accept the stale data",
        "Route to the primary because the replica's lag (8s) exceeds the operation's tolerance (0.5s), and increment a fallback counter metric",
        "Block the fraud check until the replica catches up",
        "Disable replication and use only the primary"
      ],
      "correct": 1,
      "explanation": "Lag-aware routing must compare the current replication lag against the specific operation's tolerance. For fraud checks requiring fresh data (0.5s tolerance), an 8-second lagging replica would return dangerously stale data. The routing logic should fall back to the primary and record a metric. This is the adaptive routing pattern where different operations have different lag tolerances."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Lag-Aware Read Replica Routing System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Implement ReplicationLagMetrics that polls the replica every 5 seconds using pg_last_xact_replay_timestamp() and exposes the lag as a Micrometer Gauge. The metric must be set to Long.MAX_VALUE when the replica is unreachable, and the isReplicaAcceptablyFresh(long maxLagSeconds) method must return false when lag is unknown."
    },
    {
      "id": "2",
      "description": "Implement ReplicationRoutingDataSource extending AbstractRoutingDataSource with a determineCurrentLookupKey() that: (a) always routes to primary if ReadConsistencyContext.isPrimaryRequired() is true, (b) routes to replica only if REPLICA is requested AND lag is acceptable, and (c) falls back to primary with a logged warning when lag exceeds the threshold. Write a unit test with a mocked lagMetrics that verifies all three routing paths."
    },
    {
      "id": "3",
      "description": "Create a @ReadFromReplica AOP aspect with @Order(1) that sets the DataSource context before @Transactional opens a connection. Apply it to a TransactionHistoryService.getHistory() method. Write an integration test using Testcontainers that verifies the query executes on the replica connection (by checking pg_stat_activity.client_addr or connection pool name)."
    },
    {
      "id": "4",
      "description": "Implement LSN-based read-your-writes consistency for the payment confirmation flow: commit the payment insert first, then capture pg_current_wal_lsn() from the primary, then poll the replica's pg_last_wal_replay_lsn() until it reaches the captured LSN or a 2-second timeout expires. If the replica catches up, read the confirmation from the replica in a new transaction; otherwise fall back to primary. Measure and log the wait time as a metric."
    }
  ]
}
-->
