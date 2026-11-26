---
id: track-08-lesson-10
title: "Connection Pooling — PgBouncer and HikariCP Tuning"
slug: connection-pooling
track: track-08
trackName: "Database & Data Architecture"
sequence: 10
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [connection-pool, PgBouncer, HikariCP, max-pool-size, transaction-mode]
prerequisites: [track-08-lesson-01]
---

# Connection Pooling — PgBouncer and HikariCP Tuning

> [!NOTE]
> PostgreSQL can sustain around 100–300 active connections before connection overhead degrades throughput. A payment platform with 20 microservices each running 10 instances with a pool of 20 connections each creates 4,000 potential connections — 10–40x over PostgreSQL's safe operating range. Connection pooling is not optional in production fintech systems.

## 1. Why PostgreSQL Connections Are Expensive

Each PostgreSQL connection is a separate backend process (not a thread):
- Consumes several MB of private RAM per connection (more with large `work_mem` use or big catalog caches)
- Has a startup cost (process fork + authentication, typically a few milliseconds; more with TLS and SCRAM)
- Holds a slot in `pg_stat_activity` even when idle
- Requires authentication and session setup overhead

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

## 2. PgBouncer — Server-Side Connection Pooling

PgBouncer sits between application and PostgreSQL, multiplexing many client connections onto a small number of server connections.

```
Applications (4,000 potential connections)
    |
    v
PgBouncer (100 server connections)
    |
    v
PostgreSQL (100 actual backend processes)
```

### PgBouncer Modes

**Session mode**: One server connection held per client for the entire session. Server connections are reused after a client disconnects, but there is no multiplexing: N connected clients still need N server connections.

**Transaction mode**: Server connection checked out at transaction start, returned at commit/rollback. This is the correct mode for microservices — most of the time, connections are idle between transactions.

**Statement mode**: Server connection returned after each statement. Multi-statement transactions are not allowed at all. Generally not recommended.

### PgBouncer Configuration

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

### PgBouncer User Authentication

```bash
# Generate password hash for PgBouncer userlist
psql -c "SELECT concat('\"', usename, '\" \"', passwd, '\"') FROM pg_shadow WHERE usename='payments_app';"

# /etc/pgbouncer/userlist.txt
"payments_app" "SCRAM-SHA-256$4096:..."
"payments_ro" "SCRAM-SHA-256$4096:..."
```

### Monitoring PgBouncer

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

## 3. HikariCP — Application-Side Connection Pooling

HikariCP is a very fast, lightweight JDBC connection pool and Spring Boot's default.

### The Pool Sizing Formula

The classic starting point (from the PostgreSQL wiki, popularised by HikariCP's "About Pool Sizing" page):

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

**Important**: the formula is a starting point for the *database-wide* total, to be confirmed by load testing. Each application pool is a share of that total; with 10 instances, per-instance pools of 20 would allow 200 connections — far beyond what the server can execute concurrently. With PgBouncer in transaction mode, application pools can be larger, because PgBouncer funnels them into a server pool close to the formula's number. A quick per-instance check comes from Little's law (see Section 6).

### HikariCP Configuration

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

### application.yml Alternative

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

## 4. Prepared Statements in PgBouncer Transaction Mode

A server-side prepared statement lives in one backend connection, but transaction mode may assign a different backend to each transaction. Without help from PgBouncer, a statement prepared in one transaction is missing in the next. (The PostgreSQL JDBC driver switches to named server-side prepared statements after `prepareThreshold` = 5 executions of the same `PreparedStatement`, so this hits Java apps too.)

```sql
-- This fails in PgBouncer transaction mode:
PREPARE balance_lookup AS
    SELECT balance FROM accounts WHERE account_number = $1;
EXECUTE balance_lookup('ACC001');
-- ERROR: prepared statement "balance_lookup" does not exist
-- (PgBouncer assigned a different backend for the EXECUTE)
```

### Solutions

**Option 1: Let PgBouncer track prepared statements (PgBouncer 1.21+, recommended)**

```
# pgbouncer.ini
max_prepared_statements = 200
```

PgBouncer remembers protocol-level prepared statements (what the JDBC driver sends) and prepares them on whichever server connection the transaction gets. SQL-level `PREPARE`/`EXECUTE` statements, as in the example above, are still not supported.

**Option 2: Session mode for specific use cases requiring prepared statements**

```ini
# pgbouncer.ini — per-database pool mode
[databases]
payments_transactions = host=postgres port=5432 dbname=payments pool_mode=transaction
payments_reporting = host=postgres port=5432 dbname=payments pool_mode=session
```

**Option 3: Turn off named server-side prepares in the driver (older PgBouncer)**

```java
config.addDataSourceProperty("prepareThreshold", "0");  // never create named server-side statements
// The driver still uses the extended protocol with bind parameters (no SQL
// injection risk), but with unnamed statements that live only for one
// execution -- safe with PgBouncer transaction mode, at a small parsing cost
```

## 5. Pool Exhaustion — Symptoms and Solutions

### Detecting Pool Exhaustion

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

### Common Causes and Fixes

| Symptom | Root Cause | Fix |
|---|---|---|
| Threads waiting for connection | Pool too small | Increase maximumPoolSize |
| Pool fills during batch jobs | Batch not using separate pool | Dedicated batch DataSource |
| Connections held too long | Slow external calls (HTTP, Kafka) inside a transaction | Move external calls outside @Transactional |
| `idle in transaction` accumulating | Transaction not closed | Set idle_in_transaction_session_timeout, fix code |
| PgBouncer cl_waiting > 0 | PgBouncer server pool full | Find slow queries first; then raise default_pool_size (within max_db_connections) |

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

## 6. Right-Sizing Connection Pools for Payment Services

### Example: Payment Processing Microservice

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

### Configuration for Batch Processing

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

## 7. PgBouncer + HikariCP Stack — Full Configuration Reference

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
> One of the most common production incidents around connection pooling is `idle in transaction` connections. These hold database locks (sometimes table-level) and hold back VACUUM while doing nothing. A single stuck connection can block an entire payment processing flow. Set `idle_in_transaction_session_timeout` in PostgreSQL to automatically kill connections stuck in a transaction for too long: `ALTER DATABASE payments SET idle_in_transaction_session_timeout = '30s';`

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment service runs 10 instances (4 vCPU each) connecting directly — without PgBouncer — to a PostgreSQL server with 16 cores and NVMe storage. Using the classic formula connections = (core_count * 2) + effective_spindle_count as a starting point, what pool size per application instance is reasonable?",
      "options": [
        "4 connections — one per application vCPU",
        "About 3–4 connections — the formula applies to the DATABASE server, (16 * 2) + 1 ≈ 33 active connections in total, shared by 10 instances",
        "33 connections per instance — (16 * 2) + 1",
        "10 connections — the HikariCP default maximumPoolSize"
      ],
      "correct": 1,
      "explanation": "The formula estimates how many connections the DATABASE server can usefully run at once, using the database server's cores: (16 * 2) + 1 ≈ 33. That is a total for all clients, so 10 instances get about 3–4 each (confirm with a load test). Giving each instance 33 would allow 330 connections that mostly wait on each other. With PgBouncer in transaction mode the application pools can be larger, because PgBouncer funnels them into a server pool near the formula's number."
    },
    {
      "text": "PgBouncer (older than 1.21, or with max_prepared_statements = 0) runs in transaction mode. A Spring service using the PostgreSQL JDBC driver — which switches to named server-side prepared statements after 5 executions — starts throwing errors: 'prepared statement \"S_1\" does not exist'. What is the root cause?",
      "options": [
        "Hibernate prepared statement cache is too small and needs to be increased",
        "In transaction mode, PgBouncer routes each transaction to potentially a different backend server connection; server-side prepared statements are tied to a specific backend connection and become invalid when PgBouncer routes to a different one",
        "PgBouncer transaction mode is incompatible with JDBC drivers and session mode must be used",
        "PostgreSQL max_prepared_transactions is set to 0 and needs to be increased"
      ],
      "correct": 1,
      "explanation": "Server-side prepared statements live in one backend connection. In transaction mode, PgBouncer may give each transaction a different backend, so a statement prepared on backend-1 is unknown on backend-2. Fixes: upgrade to PgBouncer 1.21+ and set max_prepared_statements > 0 (PgBouncer then tracks protocol-level prepared statements and re-prepares them where needed), or set prepareThreshold=0 in the JDBC driver so it never creates named server-side statements."
    },
    {
      "text": "pg_stat_activity shows 15 connections in state 'idle in transaction' for over 5 minutes on the payments database. What is the most likely business impact and the fastest mitigation?",
      "options": [
        "No immediate impact — idle connections don't hold locks; kill them during the next maintenance window",
        "These connections hold row-level and potentially table-level locks, blocking other transactions; immediate mitigation is to run pg_terminate_backend() on them and set idle_in_transaction_session_timeout to prevent recurrence",
        "These connections consume 5-10MB of RAM each; reboot the PostgreSQL server to free memory",
        "These connections indicate a client timeout misconfiguration; increase connectionTimeout in HikariCP"
      ],
      "correct": 1,
      "explanation": "Connections in 'idle in transaction' state have an open transaction but are not executing anything. They keep every lock taken in that transaction — possibly blocking rows or a whole table — and hold back VACUUM. In a payment system, one such connection holding a row lock on a hot account can queue up many blocked payment transactions. Immediate mitigation: SELECT pg_terminate_backend(pid) for those connections (their work rolls back). Prevention: ALTER DATABASE payments SET idle_in_transaction_session_timeout = '30s', and fix the code path that leaves transactions open."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Connection Pool Sizing and Exhaustion Diagnosis",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {
      "id": "1",
      "description": "Size the pools for a payment service with this profile: 15 instances, 2 vCPU each, connecting via PgBouncer to a PostgreSQL server with 8 cores and NVMe. Use the (core_count * 2) + spindles formula on the DATABASE server for the PgBouncer server pool, and Little's law (throughput × time a connection is held) for each HikariCP application pool. Show your calculation and explain the relationship between application pool size, PgBouncer pool size, and PostgreSQL max_connections."
    },
    {
      "id": "2",
      "description": "Build a Testcontainers integration test that deliberately exhausts the connection pool: configure a pool with maximumPoolSize=5 and connectionTimeout=1000ms, then submit 20 concurrent database operations each holding a connection for 500ms. Assert that the first 5 succeed within 500ms, the remaining 15 either succeed within 1500ms (queued) or fail with ConnectionTimeout. Add HikariCP metrics to verify the pool never exceeds maximumPoolSize."
    },
    {
      "id": "3",
      "description": "Write a runbook for diagnosing a production connection pool exhaustion incident. Include the specific SQL queries to run against pg_stat_activity to identify: total connections by state, 'idle in transaction' culprits with their last query and duration, connections by application and IP, and long-running active queries. Provide kill commands with appropriate safety checks."
    },
    {
      "id": "4",
      "description": "Implement a separate HikariCP pool for batch processing jobs with maximumPoolSize=3 and a routing DataSource that sends @Transactional(readOnly=true) operations to a read-replica pool. Write tests verifying that batch operations never starve real-time payment processing, and that read-only transactions actually route to the replica pool."
    }
  ]
}
-->
