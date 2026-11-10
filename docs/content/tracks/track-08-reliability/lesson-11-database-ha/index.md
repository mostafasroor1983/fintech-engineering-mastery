---
id: track-08-lesson-11
title: "Database High Availability — PostgreSQL HA Patterns"
slug: database-ha
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 11
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [PostgreSQL, HA, Patroni, replication, failover]
prerequisites: [track-08-lesson-02]
---

# Database High Availability — PostgreSQL HA Patterns

> [!NOTE]
> PostgreSQL is the default relational database for fintech applications. Its built-in streaming replication, combined with Patroni for automated failover and PgBouncer for connection management, provides enterprise-grade HA without Oracle licensing costs. For payment systems, the choice of synchronous vs asynchronous replication is not a performance trade-off — it is a data durability trade-off with direct financial consequences.

## HA Architecture Overview

A production PostgreSQL HA cluster consists of:

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

---

## 1. PostgreSQL Streaming Replication

Streaming replication is the foundation. The primary streams WAL (Write-Ahead Log) to standby servers, which replay it continuously.

```ini
# postgresql.conf (primary)
wal_level = replica              # minimum for replication
max_wal_senders = 10             # max concurrent replication connections
wal_keep_size = 1GB              # retain WAL segments for replication lag
hot_standby = on                 # allow reads on standby
archive_mode = on                # archive WAL for PITR
archive_command = 'aws s3 cp %p s3://pg-wal-archive/%f'

# Synchronous replication — critical for payment systems
# 'ANY 1 (replica1, replica2)' means at least one replica must confirm
synchronous_standby_names = 'ANY 1 (replica1, replica2)'

# Connection for replication
# pg_hba.conf
host replication replicator 10.0.0.0/8 md5
```

```ini
# postgresql.conf (standby)
hot_standby = on
hot_standby_feedback = on        # prevents vacuum conflicts on queries

# recovery.conf equivalent (PostgreSQL 12+: postgresql.conf)
primary_conninfo = 'host=pg-primary port=5432 user=replicator password=xxx application_name=replica1'
primary_slot_name = 'replica1_slot'  # replication slot ensures no WAL gap
```

---

## 2. Patroni Configuration

Patroni is the standard HA manager for PostgreSQL. It uses a Distributed Configuration Store (etcd, Consul, or ZooKeeper) for leader election and coordinates failover.

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
    synchronous_mode: true           # require sync replica before failover
    synchronous_mode_strict: false   # allow failover to async if no sync replica available

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

---

## 3. PgBouncer Connection Management During Failover

PgBouncer sits between the application and PostgreSQL. During a failover, PgBouncer pauses connections briefly while Patroni promotes the new primary, then reconnects. Applications see a brief pause (10-30 seconds) rather than connection errors.

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
server_connect_timeout = 15        # wait up to 15s for new primary
server_login_retry = 3             # retry failed connections
query_wait_timeout = 60            # queue client queries for 60s during failover

# Connection health
server_check_query = SELECT 1
server_check_delay = 30
server_lifetime = 3600
server_idle_timeout = 600
```

---

## 4. Replication Lag Monitoring

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

    private static final String LAG_QUERY = """
        SELECT
            application_name,
            EXTRACT(EPOCH FROM replay_lag)::FLOAT AS lag_seconds,
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

                meterRegistry.gauge("postgresql.replication.lag.seconds",
                        Tags.of("replica", replicaName), lagSeconds);
                meterRegistry.gauge("postgresql.replication.lag.bytes",
                        Tags.of("replica", replicaName), lagBytes);

                // Alert thresholds
                if (lagSeconds > 30) {
                    alertService.warning("PG_REPLICATION_LAG",
                            String.format("Replica %s lag: %.1fs / %d bytes",
                                    replicaName, lagSeconds, lagBytes));
                }
                if (lagSeconds > 120) {
                    alertService.critical("PG_REPLICATION_LAG_CRITICAL",
                            String.format("Replica %s lag critical: %.1fs",
                                    replicaName, lagSeconds));
                }
            }
        } catch (SQLException e) {
            log.error("Failed to query replication lag", e);
        }
    }
}
```

---

## 5. Synchronous vs Asynchronous Replication Trade-off

This is the most important decision in PostgreSQL HA for fintech:

| Mode | Durability | Performance | Failover Risk |
|---|---|---|---|
| Synchronous (ANY 1) | Guaranteed: committed data on 2+ nodes | Lower TPS: waits for replica ACK | Zero data loss on failover |
| Asynchronous | Not guaranteed: replica may lag | Higher TPS: no replica wait | Up to `replay_lag` seconds of data loss |

**For payment systems**: use synchronous replication. A debit that is committed on the primary but not replicated to the replica can be "lost" if the primary fails and the async replica is promoted. The customer sees their account debited for a payment that the system has no record of — a financial error with direct monetary impact.

```java
@Component
public class SynchronousReplicationValidator {

    private final DataSource dataSource;
    private static final Logger log = LoggerFactory.getLogger(
            SynchronousReplicationValidator.class);

    // On startup, verify that synchronous replication is configured
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

---

## 6. Spring Boot DataSource Reconnect on Failover

The application must handle the brief disconnection during failover gracefully. HikariCP with appropriate configuration handles this automatically.

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
      connection-test-query: SELECT 1
      # Retry on connection failure — critical for failover
      initialization-fail-timeout: -1 # don't fail startup on DB unavailable
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

---

## 7. Split-Brain Prevention

Split-brain occurs when both nodes believe they are primary. Patroni prevents this using the DCS lease: only the node holding the DCS lease is the primary. If the DCS is unavailable, Patroni demotes the primary (sacrifices availability for consistency).

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
// Application-level protection: reject writes if connected to standby
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
            // If we can't check, assume worst case
            log.warn("Cannot determine standby status: {}", e.getMessage());
        }
    }
}
```

---

## 8. Promoting a Replica (Manual Failover)

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
patronictl -c /etc/patroni/patroni.yml failover payment-postgres-cluster \
    --master pg-node-1 \
    --candidate pg-node-2 \
    --force
```

---

## 9. Operational Runbook: Failover Response

```
P1 Incident: PostgreSQL Primary Failure

T+0:  Patroni detects primary failure (DCS lease expires: 30s max)
T+30: Patroni elects new primary from sync replicas (< 10s election)
T+40: DNS / VIP updates to point to new primary
T+45: PgBouncer reconnects to new primary (server_connect_timeout: 15s)
T+60: Application connections resume via HikariCP retry
T+90: Old primary comes back — Patroni runs pg_rewind, rejoins as replica

Engineer Actions:
1. Acknowledge PagerDuty alert
2. patronictl list — confirm new leader
3. Check application error rate (should be recovering)
4. Verify PgBouncer is connected to new primary
5. Monitor replication lag on new primary
6. Investigate root cause of original failure
7. Run pg_rewind on old primary to rejoin as replica
8. File PIR within 24 hours
```

---

## 10. Summary

PostgreSQL HA with Patroni provides automated failover in 30-90 seconds with zero data loss when synchronous replication is configured. The key decisions for payment systems: use synchronous replication (ANY 1) to prevent data loss, use PgBouncer for connection management during failover, and configure HikariCP with appropriate timeout and retry settings. Split-brain prevention via DCS lease means Patroni sacrifices availability for consistency — the correct choice for financial data. Monitor replication lag continuously and alert at 30 seconds lag, escalate at 120 seconds.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why should a payment system use synchronous replication (synchronous_standby_names) rather than asynchronous replication?",
      "options": ["Synchronous replication is faster for reads", "Asynchronous replication can lose committed data on failover, potentially causing unrecorded debits", "Synchronous replication uses less disk space", "Asynchronous replication requires more broker nodes"],
      "correct": 1,
      "explanation": "With asynchronous replication, a payment debit committed on the primary but not yet replicated can be lost if the primary fails. The promoted replica has no record of the debit, creating a financial error where the customer was charged but the system shows no record. Synchronous replication guarantees commits are on at least one replica before acknowledging."
    },
    {
      "text": "What is the purpose of Patroni's DCS (Distributed Configuration Store) lease during a split-brain scenario?",
      "options": ["To store database backups", "To ensure only the node holding the lease can act as primary, sacrificing availability for consistency", "To route application traffic to the correct node", "To manage database connection pooling"],
      "correct": 1,
      "explanation": "If the primary loses connectivity to the DCS, it voluntarily demotes itself rather than risk a split-brain scenario where two nodes both believe they are primary. This sacrifices availability (brief downtime) in favor of consistency (no two primaries), which is the correct trade-off for financial data."
    },
    {
      "text": "During a Patroni failover, what should the application experience if HikariCP is correctly configured?",
      "options": ["Immediate connection errors requiring manual restart", "A brief pause (30-90 seconds) followed by automatic reconnection via HikariCP retry", "Permanent data loss requiring manual recovery", "Zero interruption with no visible errors"],
      "correct": 1,
      "explanation": "With HikariCP configured with appropriate connectionTimeout (10s), keepaliveTime, and retry settings, the application experiences a brief pause during Patroni's failover window (30-90s). HikariCP queues queries and retries connections automatically. Applications see a delay, not an error, if properly configured."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "PostgreSQL HA Setup with Patroni and Failover Validation",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Write a Patroni configuration YAML for a 3-node payment PostgreSQL cluster with synchronous_mode=true, maximum_lag_on_failover=1MB, ttl=30s, and WAL archiving to S3. Include synchronous_standby_names='ANY 1 (replica1, replica2)' in the PostgreSQL parameters section."},
    {"id": "2", "description": "Implement a SynchronousReplicationValidator @PostConstruct bean that queries SHOW synchronous_standby_names on startup, logs a critical alert and pages on-call if it is empty (async mode detected), and logs confirmation if synchronous replication is active."},
    {"id": "3", "description": "Build a ReplicationLagMonitor @Scheduled(fixedRate=30000) that queries pg_stat_replication for lag_seconds and lag_bytes per replica, publishes both as Prometheus gauges with replica tags, and sends warning at 30s lag and critical alert at 120s lag."},
    {"id": "4", "description": "Implement a StandbyWriteProtection @Aspect that intercepts methods annotated with @WriteOperation, checks pg_is_in_recovery() every 10 seconds (cached), and throws StandbyWriteException if the application is connected to a standby server."}
  ]
}
-->

