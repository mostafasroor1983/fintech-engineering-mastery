---
id: "track-07-lesson-07"
title: "JDBC Tuning — Connection Pools and Batch Operations"
track: "track-07"
track-name: "Performance Engineering"
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

## Overview

The connection pool is the bridge between your Java application and the database. Too few connections and threads queue waiting, latency spikes, and throughput collapses. Too many connections and PostgreSQL's per-connection memory overhead causes the database server to swap, delivering worse performance than a smaller pool would.

For payment services where every transaction touches the database — balance checks, ledger inserts, audit logs — getting connection pool configuration right is not optional. Neither is understanding JDBC batch operations: a settlement processor that inserts 10,000 ledger entries one row at a time will be 10-50x slower than one using JDBC batch.

This lesson covers HikariCP configuration from first principles, the mathematics of pool sizing, PreparedStatement caching, batch operations for ledger entry insertion, PostgreSQL JDBC driver settings, and production monitoring.

> [!NOTE]
> PostgreSQL has a hard limit on connections (default 100). Every connection that your application holds open is unavailable to other applications, pgBouncer, administrative sessions, and monitoring tools. Size your pool conservatively and use pgBouncer for connection multiplexing in high-concurrency deployments.

## Learning Objectives

By the end of this lesson you will be able to:

- Configure HikariCP correctly for a payment service workload
- Calculate the optimal pool size using the connection pool sizing formula
- Understand and configure PreparedStatement caching
- Implement JDBC batch inserts for high-throughput ledger operations
- Configure pgjdbc-specific settings for PostgreSQL performance
- Monitor connection pool health using Micrometer

---

## 1. The Cost of Getting Connection Pooling Wrong

### Too Few Connections

```
Scenario: 200 TPS, each transaction needs 20 ms DB time, pool size = 5

Connections needed = 200 TPS * 0.020 s = 4 connections (at 100% utilisation)
Pool size = 5 means no queuing at steady state

BUT: if DB slows to 50 ms per query during a slow disk flush:
  Connections needed = 200 TPS * 0.050 s = 10 connections
  Pool size = 5 -> the pool can serve only half the arriving work
  The queue grows without limit -> timeouts -> cascading failure
```

### Too Many Connections

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

---

## 2. HikariCP — The Standard Pool for Production Java

HikariCP is the fastest, most reliable JDBC connection pool for Java. It is the default in Spring Boot since 2.x.

### 2.1 Core Configuration

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

### 2.2 application.yml Equivalent

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

---

## 3. Pool Sizing Formula

The best-known starting point is the formula in the HikariCP wiki page "About Pool Sizing", which comes from the PostgreSQL community. Treat it as a first estimate of how many connections the **database** can keep busy efficiently, then confirm with load tests:

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

**Important**: the formula describes the database, not one client. If you run 10 payment service instances each with a pool of 33, the total is `10 * 33 = 330` connections — which may exceed PostgreSQL's `max_connections`, and is far more than 33 *active* queries the server handles well. The utility below keeps the total within `max_connections`; if many of those connections could be busy at the same moment, lower the per-instance pools further or put PgBouncer in front.

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

---

## 4. PreparedStatement Caching

With pgjdbc, a `PreparedStatement` is sent as an unnamed statement at first; after it has been executed `prepareThreshold` times (default 5) on the same connection, the driver switches to a **named server-side prepared statement**, so PostgreSQL stops re-parsing it. The driver keeps these per connection in its statement cache (`preparedStatementCacheQueries`, default 256), even after your code closes the `PreparedStatement` object. PostgreSQL may then also reuse a generic plan instead of planning every execution.

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

### 4.1 Statement vs PreparedStatement — Never Use Statement

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

---

## 5. JDBC Batch Inserts for Ledger Entries

Settlement processing often requires inserting thousands of ledger entries atomically. Individual inserts are catastrophically slow compared to batch inserts.

```
Illustrative comparison (PostgreSQL, 10,000 inserts, ~1 ms network round trip):
  Individual inserts, autocommit=true:  ~45 seconds (network round-trip per insert)
  Individual inserts, one transaction:  ~8 seconds
  JDBC batch inserts:                   ~0.8 seconds
  JDBC batch + reWriteBatchedInserts:   ~0.3 seconds
```

### 5.1 Basic JDBC Batch Insert

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

### 5.2 reWriteBatchedInserts — PostgreSQL Driver Optimisation

The pgjdbc driver's `reWriteBatchedInserts=true` property rewrites a batch of single-row `INSERT`s into multi-row INSERTs (in chunks of up to 128 rows):

```sql
-- Without reWriteBatchedInserts: N separate statements. pgjdbc already sends
-- them pipelined, but the server executes them one by one:
INSERT INTO ledger_entries VALUES (?, ?, ?, ...);
INSERT INTO ledger_entries VALUES (?, ?, ?, ...);
INSERT INTO ledger_entries VALUES (?, ?, ?, ...);

-- With reWriteBatchedInserts: one statement per chunk of rows:
INSERT INTO ledger_entries VALUES (?, ?, ?, ...), (?, ?, ?, ...), (?, ?, ?, ...);
```

This often gives a **2-3x (sometimes larger) speedup** for batch insert workloads, at no code cost — measure it on yours. Enable it via the JDBC URL or DataSource properties. (For bulk loads of many thousands of rows, PostgreSQL's `COPY` — `CopyManager` in pgjdbc — is faster still.)

### 5.3 Spring Data JPA Batch Inserts

JPA/Hibernate has its own batching mechanism that works alongside JDBC batching:

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

---

## 6. Connection Pool Monitoring with Micrometer

HikariCP emits Micrometer metrics when a `MeterRegistry` is provided (Spring Boot wires this automatically for its auto-configured pool). The key metrics:

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

**Key alert thresholds:**

| Metric | Warning | Critical |
|---|---|---|
| Active connections / Max connections | > 70% | > 90% |
| Pending threads | > 0 for > 5s | > 5 |
| Connection acquire time P99 | > 100 ms | > 500 ms |
| Connection timeout count | Any | Immediate page |
| Connection usage P99 | > query SLA | > 2x query SLA |

---

## 7. Handling Connection Pool Exhaustion Gracefully

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

---

## 8. Production Checklist

For every production database-connected service:

- [ ] `maximumPoolSize` calculated using the pool sizing formula
- [ ] `connectionTimeout` set to fail fast (2-5 seconds) not wait indefinitely
- [ ] `maxLifetime` set a few seconds/minutes below any infrastructure connection-lifetime limit (firewall, NAT, proxy, PgBouncer)
- [ ] `keepaliveTime` set to prevent firewall/load-balancer connection drops
- [ ] `autoCommit=false` for payment services managing explicit transactions
- [ ] `reWriteBatchedInserts=true` for pgjdbc with batch insert workloads
- [ ] `preparedStatementCacheQueries=250` for pgjdbc
- [ ] Micrometer metrics enabled (`config.setMetricRegistry(meterRegistry)`)
- [ ] Alerts on: active/max > 85%, pending > 0, timeout count > 0
- [ ] No `Statement` usage — only `PreparedStatement`
- [ ] Batch size tuned to 250-500 for typical ledger workloads
- [ ] `GenerationType.SEQUENCE` with `allocationSize` for JPA batch insert compatibility

---

## Knowledge Check

1. Using the pool sizing formula, calculate the recommended pool size per instance for: a 16-core SSD database server, 8 application instances, PostgreSQL `max_connections=200`, 20 connections reserved for maintenance.

2. What is the effect of `reWriteBatchedInserts=true` in pgjdbc? What SQL transformation does it perform and when does it apply?

3. Why does `GenerationType.IDENTITY` prevent Hibernate from batching INSERT statements?

4. A payment service has `connectionTimeout=30000` (30 seconds). During a database slow-down, threads queue waiting for connections. What problem does this cause and what value would you set instead?

5. The `hikaricp.connections.pending` metric spikes to 50 during peak load. The pool size is 20, the service runs 2,000 queries per second at peak, and each holds a connection for 15 ms on average. Using Little's law (connections in use = rate × hold time), how many connections are busy on average — and is a bigger pool the right fix, or is something else holding connections?

---

## Practical Challenge

**Setup:** A settlement processor inserts 100,000 ledger entries during a nightly batch. It currently runs in 180 seconds (single-row inserts with autocommit). The business requires this to complete within 30 seconds to meet the settlement window.

**Task:**
1. Write a `SettlementBatchInserter` class that:
   - Accepts a `List<LedgerEntry>` and inserts using JDBC batch with configurable batch size
   - Implements parallel batch processing across multiple DB connections
   - Records metrics: total duration, rows per second, batch count
   - Handles partial failures with appropriate rollback semantics
2. Write a `ConnectionPoolBenchmark` JMH benchmark that measures the impact of different pool sizes (5, 10, 20) and batch sizes (50, 250, 500) on 100,000-row insert throughput
3. Explain what pgjdbc properties you would set and why for this workload

**Expected output:** Complete Java class with connection pool configuration, JMH benchmark, and annotated configuration snippet.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Using the pool sizing formula, what is the recommended pool size per instance for a 16-core SSD database server with 8 application instances, max_connections=200, and 20 reserved connections?",
      "options": [
        "10 connections per instance",
        "22 connections per instance",
        "33 connections per instance",
        "40 connections per instance"
      ],
      "correct": 1,
      "explanation": "Formula: ideal = (16 * 2) + 1 = 33. Available for app = 200 - 20 = 180. Per instance = 180 / 8 = 22. The adjusted pool size is 22 because the ideal 33 multiplied by 8 instances (264) would exceed the available 180 connections."
    },
    {
      "text": "Why does GenerationType.IDENTITY prevent Hibernate from batching INSERT statements?",
      "options": [
        "IDENTITY columns require a separate network round-trip to retrieve the generated ID before Hibernate can add the entity to its first-level cache, breaking batch accumulation",
        "IDENTITY is not supported in PostgreSQL and silently falls back to single-row inserts",
        "Hibernate only batches updates, never inserts, regardless of ID generation strategy",
        "IDENTITY strategy requires autocommit=true, which disables connection pool batching"
      ],
      "correct": 0,
      "explanation": "With IDENTITY strategy, the database generates the ID on INSERT and Hibernate must immediately execute the INSERT to get the generated key (required for the entity identity map). This prevents batch accumulation. Use SEQUENCE with allocationSize instead, which pre-fetches ID blocks allowing Hibernate to batch many inserts before flushing."
    },
    {
      "text": "What effect does reWriteBatchedInserts=true have in pgjdbc, and when does it apply?",
      "options": [
        "It rewrites UPDATE statements as INSERT ... ON CONFLICT for idempotency",
        "It rewrites multiple single-row INSERT statements executed in a JDBC batch into multi-row INSERT VALUES (...), (...), (...) statements, reducing per-statement work on the server",
        "It enables server-side prepared statement caching for batch operations",
        "It automatically partitions large batches into smaller sub-batches to avoid lock timeouts"
      ],
      "correct": 1,
      "explanation": "reWriteBatchedInserts=true causes pgjdbc to transform a JDBC executeBatch() of N single-row INSERTs into multi-row INSERT VALUES(...), (...), ... statements (in chunks of up to 128 rows). pgjdbc already pipelines batched statements, so the gain comes from the server executing far fewer statements — often a 2-3x throughput improvement for batch insert workloads. It applies only to INSERT batches."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Settlement Batch Inserter — 100K Rows in 30 Seconds",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write a SettlementBatchInserter class that accepts a List<LedgerEntry>, inserts using JDBC batch with configurable batch size, implements parallel processing across multiple DB connections, and records metrics including total duration, rows per second, and batch count."},
    {"id": "2", "description": "Add appropriate rollback semantics: if any batch fails, roll back only that batch's transaction while preserving successfully committed batches, and log which batch numbers failed."},
    {"id": "3", "description": "Write a ConnectionPoolBenchmark JMH benchmark that measures the impact of different pool sizes (5, 10, 20) and batch sizes (50, 250, 500) on 100,000-row insert throughput."},
    {"id": "4", "description": "Document the pgjdbc properties you would configure for this workload (reWriteBatchedInserts, preparedStatementCacheQueries, socketTimeout) and justify each setting."}
  ]
}
-->

