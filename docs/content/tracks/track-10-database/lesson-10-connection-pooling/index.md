---
id: track-10-lesson-10
title: "Connection Pooling — PgBouncer and HikariCP Tuning"
slug: connection-pooling
track: track-10
trackName: "Database & Data Architecture"
sequence: 10
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [connection-pool, PgBouncer, HikariCP, max-pool-size, transaction-mode]
prerequisites: [track-10-lesson-01]
---

# Connection Pooling — PgBouncer and HikariCP Tuning

> [!NOTE]
> PostgreSQL can sustain around 100–300 active connections before connection overhead degrades throughput. A payment platform with 20 microservices each running 10 instances with a pool of 20 connections each creates 4,000 potential connections — 10–40x over PostgreSQL's safe operating range. Connection pooling is not optional in production fintech systems.

## 1. Why PostgreSQL Connections Are Expensive

Each PostgreSQL connection is a separate backend process (not a thread):
- Consumes ~5–10 MB of RAM per connection
- Has a startup cost (~1ms) for each new connection
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

**Session mode**: One server connection held per client for the entire session. Equivalent to no pooling — only saves connection startup time.

**Transaction mode**: Server connection checked out at transaction start, returned at commit/rollback. This is the correct mode for microservices — most of the time, connections are idle between transactions.

**Statement mode**: Server connection returned after each statement. Breaks prepared statements and multi-statement transactions. Generally not recommended.

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

# Performance
max_prepared_statements = 0  # REQUIRED: disable in transaction mode
                              # (see Section 4 for why)

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

-- cl_waiting > 0 means clients are waiting for connections -- alert immediately
-- maxwait > 1000ms means severe pool exhaustion

-- Show connection stats
SHOW STATS;
-- total_query_time, total_wait_time, total_xact_count

-- Live query monitoring
SHOW CLIENTS;
SHOW SERVERS;
```

## 3. HikariCP — Application-Side Connection Pooling

HikariCP is the fastest JDBC connection pool available and Spring Boot's default.

### The Pool Sizing Formula

The classic formula from HikariCP's author:

```
pool_size = (core_count * 2) + effective_spindle_count

For a payment service with:
  - 4 vCPU application server
  - Connecting to PostgreSQL on NVMe SSD (effectively 1 "spindle")
  - pool_size = (4 * 2) + 1 = 9 connections

For a PostgreSQL server with:
  - 16 cores
  - 2 NVMe SSDs
  - Maximum useful pool = (16 * 2) + 2 = 34 connections
```

**Important**: This is the pool size per application instance. If you have 10 instances, the total PostgreSQL connections = 10 * 9 = 90.

### HikariCP Configuration

```java
@Configuration
public class DatabaseConfig {

    @Bean
    @Primary
    public DataSource primaryDataSource() {
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

        // Validation
        config.setConnectionTestQuery("SELECT 1");  // validate connection health

        // PostgreSQL-specific settings
        config.addDataSourceProperty("socketTimeout", "30");        // 30s socket timeout
        config.addDataSourceProperty("tcpKeepAlive", "true");
        config.addDataSourceProperty("ApplicationName", "payment-service");
        config.addDataSourceProperty("reWriteBatchedInserts", "true"); // batch insert optimization
        config.addDataSourceProperty("preparedStatementCacheQueries", "250");
        config.addDataSourceProperty("preparedStatementCacheSizeMiB", "5");

        // Note: When connecting via PgBouncer in transaction mode,
        // disable server-side prepared statements (PgBouncer can't route them)
        // This is handled by PgBouncer's max_prepared_statements=0 setting.
        // The JDBC driver's client-side prepared statements still work.

        // Pool name for metrics
        config.setPoolName("payments-primary");

        // Register metrics with Micrometer (requires micrometer-core)
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
      connection-test-query: SELECT 1
      data-source-properties:
        socketTimeout: 30
        tcpKeepAlive: true
        ApplicationName: payment-service
        reWriteBatchedInserts: true
```

## 4. Prepared Statements in PgBouncer Transaction Mode

PgBouncer in transaction mode cannot route server-side prepared statements because the prepared statement is tied to a specific backend connection, but transaction mode may assign different backends on consecutive transactions.

```sql
-- This fails in PgBouncer transaction mode:
PREPARE balance_lookup AS
    SELECT balance FROM accounts WHERE account_number = $1;
EXECUTE balance_lookup('ACC001');
-- ERROR: prepared statement "balance_lookup" does not exist
-- (PgBouncer assigned a different backend for the EXECUTE)
```

### Solutions

**Option 1: Disable server-side prepared statements (simplest)**

```
# pgbouncer.ini
max_prepared_statements = 0
```

The PostgreSQL JDBC driver will use client-side prepared statements (sent as full text after a threshold number of executions, with parameter substitution done client-side). This is slightly less efficient but works correctly.

**Option 2: Session mode for specific use cases requiring prepared statements**

```ini
# pgbouncer.ini — route specific users to session mode
[databases]
payments_transactions = host=postgres port=5432 dbname=payments pool_mode=transaction
payments_reporting = host=postgres port=5432 dbname=payments pool_mode=session
```

**Option 3: JDBC driver protocol_version = 3 with disable_prepared_statement**

```java
config.addDataSourceProperty("prepareThreshold", "0");  // never use server-side prepared
// All queries sent as simple text protocol — works with PgBouncer transaction mode
```

## 5. Pool Exhaustion — Symptoms and Solutions

### Detecting Pool Exhaustion

```java
@Component
@Slf4j
public class ConnectionPoolMonitor {

    private final HikariDataSource dataSource;
    private final MeterRegistry metrics;

    @Scheduled(fixedRate = 10_000)
    public void reportPoolMetrics() {
        HikariPoolMXBean pool = dataSource.getHikariPoolMXBean();

        int active = pool.getActiveConnections();
        int idle   = pool.getIdleConnections();
        int total  = pool.getTotalConnections();
        int waiting = pool.getThreadsAwaitingConnection();

        // Alert conditions
        double utilization = (double) active / total;
        if (utilization > 0.80) {
            log.warn("Connection pool high utilization: {}/{} ({:.0f}%)",
                active, total, utilization * 100);
        }

        if (waiting > 0) {
            log.error("Connection pool EXHAUSTED: {} threads waiting for connection. " +
                "Current: active={}, idle={}, total={}",
                waiting, active, idle, total);
            // This should fire a PagerDuty alert
        }

        metrics.gauge("db.pool.active", active);
        metrics.gauge("db.pool.idle", idle);
        metrics.gauge("db.pool.waiting", waiting);
        metrics.gauge("db.pool.utilization", utilization);
    }
}
```

### Common Causes and Fixes

| Symptom | Root Cause | Fix |
|---|---|---|
| Threads waiting for connection | Pool too small | Increase maximumPoolSize |
| Pool fills during batch jobs | Batch not using separate pool | Dedicated batch DataSource |
| Connections held too long | Missing transaction boundary | Add @Transactional, check for missing commit |
| `idle in transaction` accumulating | Transaction not closed | Set statement_timeout, fix code |
| PgBouncer cl_waiting > 0 | PgBouncer server pool full | Increase PgBouncer pool_size |

```sql
-- Find long-running "idle in transaction" connections (they hold locks)
SELECT
    pid,
    usename,
    application_name,
    state,
    query_start,
    EXTRACT(EPOCH FROM (NOW() - query_start))::INT AS seconds_in_state,
    LEFT(query, 100) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND query_start < NOW() - INTERVAL '30 seconds'
ORDER BY seconds_in_state DESC;

-- Kill runaway idle-in-transaction connections
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND query_start < NOW() - INTERVAL '5 minutes';
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
  - Formula check: (4 cores * 2) + 1 = 9. Close agreement.
  - Set maximumPoolSize = 10 per instance

PgBouncer configuration:
  - 10 instances * 10 connections = 100 potential application connections
  - PgBouncer pool_size: 25 (transaction mode multiplexes 100:25)
  - PostgreSQL max_connections: 50 (25 from app + 10 for ops/admin/monitoring)
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

        // Batch jobs use more connections but for shorter periods
        config.setMaximumPoolSize(5);      // limited: don't starve real-time
        config.setMinimumIdle(1);
        config.setConnectionTimeout(10_000); // batch can wait longer

        // Batch-specific settings
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
@SpringBootTest
@Testcontainers
class ConnectionPoolIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withCommand("-c", "max_connections=50");

    @Test
    void poolShouldNotExhaustUnderLoad() throws Exception {
        int concurrentThreads = 25;  // more than pool size
        CountDownLatch latch = new CountDownLatch(concurrentThreads);
        AtomicInteger successCount = new AtomicInteger(0);
        AtomicInteger timeoutCount = new AtomicInteger(0);

        ExecutorService executor = Executors.newFixedThreadPool(concurrentThreads);

        for (int i = 0; i < concurrentThreads; i++) {
            executor.submit(() -> {
                try {
                    jdbcTemplate.queryForObject("SELECT pg_sleep(0.1), 1", Integer.class);
                    successCount.incrementAndGet();
                } catch (DataAccessResourceFailureException e) {
                    if (e.getMessage().contains("timeout")) {
                        timeoutCount.incrementAndGet();
                    }
                } finally {
                    latch.countDown();
                }
            });
        }

        latch.await(10, TimeUnit.SECONDS);

        // Pool should handle at least maximumPoolSize (20) concurrent requests
        assertThat(successCount.get()).isGreaterThanOrEqualTo(20);
        // Remaining 5 may timeout or succeed (pool recycles)
    }
}
```

> [!WARNING]
> The most common production incident caused by connection pooling is `idle in transaction` connections. These hold database locks (sometimes table-level) while doing nothing. A single stuck connection can block an entire payment processing flow. Set `idle_in_transaction_session_timeout` in PostgreSQL to automatically kill connections stuck in a transaction for too long: `ALTER DATABASE payments SET idle_in_transaction_session_timeout = '30s';`

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment service has 10 instances, each with a 4 vCPU application server connecting to a PostgreSQL server with 16 cores and NVMe storage. Using the HikariCP formula, what is the recommended pool size per application instance?",
      "options": [
        "4 connections — one per application vCPU",
        "9 connections — (4 * 2) + 1 (application vCPUs * 2 + effective spindles)",
        "33 connections — based on the PostgreSQL server's (16 * 2) + 1",
        "20 connections — the HikariCP default maximum"
      ],
      "correct": 1,
      "explanation": "The HikariCP formula is pool_size = (core_count * 2) + effective_spindle_count, applied to the APPLICATION server's vCPUs (not the database server). With 4 application vCPUs and NVMe SSD (1 effective spindle): (4 * 2) + 1 = 9. The total connections to PostgreSQL = 10 instances * 9 = 90, which is manageable. The database server's core count is irrelevant for sizing the application pool — it's the application's ability to generate concurrent database requests that matters."
    },
    {
      "text": "PgBouncer is configured in transaction mode with max_prepared_statements = 0. A Spring JPA service using Hibernate's server-side prepared statement caching begins throwing errors: 'prepared statement does not exist'. What is the root cause?",
      "options": [
        "Hibernate prepared statement cache is too small and needs to be increased",
        "In transaction mode, PgBouncer routes each transaction to potentially a different backend server connection; server-side prepared statements are tied to a specific backend connection and become invalid when PgBouncer routes to a different one",
        "PgBouncer transaction mode is incompatible with JDBC drivers and session mode must be used",
        "PostgreSQL max_prepared_transactions is set to 0 and needs to be increased"
      ],
      "correct": 1,
      "explanation": "Server-side prepared statements in PostgreSQL are tied to a specific backend connection. In PgBouncer transaction mode, connections are reused across clients — a PREPARE in one transaction may land on backend-1, but the subsequent EXECUTE lands on backend-2 (which has no knowledge of that prepared statement). Setting max_prepared_statements = 0 in PgBouncer disables server-side prepared statements. The JDBC driver then uses client-side prepared statement emulation (substituting parameters client-side before sending full SQL), which works correctly with connection multiplexing."
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
      "explanation": "Connections in 'idle in transaction' state have an open transaction but are not currently executing any statement. This means they hold any locks acquired during that transaction — potentially blocking rows, pages, or the entire table from being modified or vacuumed. In a payment system, a single idle-in-transaction connection holding a row lock on a hot account can cascade into a queue of blocked payment transactions. Immediate mitigation: SELECT pg_terminate_backend(pid) for all such connections. Prevention: ALTER DATABASE payments SET idle_in_transaction_session_timeout = '30s'."
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
    {"id": "1", "description": "Using the HikariCP sizing formula, calculate the correct pool size for a payment service with the following profile: 15 instances, 2 vCPU each, connecting via PgBouncer to a PostgreSQL server with 8 cores and NVMe. Configure both the HikariCP application pool and PgBouncer server pool sizes. Show your calculation and explain the relationship between application pool size, PgBouncer pool size, and PostgreSQL max_connections."},
    {"id": "2", "description": "Build a Testcontainers integration test that deliberately exhausts the connection pool: configure a pool with maximumPoolSize=5 and connectionTimeout=1000ms, then submit 20 concurrent database operations each holding a connection for 500ms. Assert that the first 5 succeed within 500ms, the remaining 15 either succeed within 1500ms (queued) or fail with ConnectionTimeout. Add HikariCP metrics to verify the pool never exceeds maximumPoolSize."},
    {"id": "3", "description": "Write a runbook for diagnosing a production connection pool exhaustion incident. Include the specific SQL queries to run against pg_stat_activity to identify: total connections by state, 'idle in transaction' culprits with their last query and duration, connections by application and IP, and long-running active queries. Provide kill commands with appropriate safety checks."},
    {"id": "4", "description": "Implement a separate HikariCP pool for batch processing jobs with maximumPoolSize=3 and a routing DataSource that sends @Transactional(readOnly=true) operations to a read-replica pool. Write tests verifying that batch operations never starve real-time payment processing, and that read-only transactions actually route to the replica pool."}
  ]
}
-->
