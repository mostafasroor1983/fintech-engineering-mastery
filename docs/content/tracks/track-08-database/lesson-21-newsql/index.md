---
id: track-08-lesson-21
title: "NewSQL — CockroachDB and Google Spanner Architecture"
slug: newsql
track: track-08
trackName: "Database & Data Architecture"
sequence: 21
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [NewSQL, CockroachDB, Spanner, serializable, geo-partitioning]
prerequisites: [track-08-lesson-17]
---

# NewSQL — CockroachDB and Google Spanner Architecture

> [!NOTE]
> NewSQL databases promise the best of both worlds: the SQL interface and ACID guarantees of traditional databases, with the horizontal scale-out of NoSQL. The tradeoff is latency — distributed transactions require multiple network round-trips for consensus. For financial systems, understanding where this latency materializes is essential for making an informed architectural choice.

## 1. NewSQL Definition

NewSQL databases share three properties:
1. **Full SQL support**: relational model, joins, indexes, transactions
2. **Horizontal scalability**: scale writes (not just reads) by adding nodes
3. **Distributed ACID transactions**: serializable isolation without single-writer bottleneck

Traditional RDBMS achieves (1) and (3) but not (2).
NoSQL achieves (2) but abandons (1) and weakens (3).
NewSQL claims to achieve all three.

```
Database Evolution:
  Traditional RDBMS (PostgreSQL, MySQL): SQL + ACID, single-writer bottleneck
  NoSQL (Cassandra, MongoDB):            Scale-out, eventual consistency
  NewSQL (CockroachDB, Spanner):         SQL + ACID + horizontal write scale
```

## 2. CockroachDB Architecture

CockroachDB is a distributed SQL database inspired by Google Spanner. It uses Raft consensus for each data range.

### Key Architecture Concepts

```
Data organization:
  - Data is split into "ranges" (up to 512 MiB each by default)
  - Each range is replicated across N nodes (default 3)
  - Each range has a Raft leader elected from its replicas
  - Writes go to the Raft leader; leader replicates to followers
  - Reads can be served from any replica (follower reads for stale reads)
  - Leaseholder node handles reads (usually co-located with Raft leader)

Cluster example (3 nodes, 3 replicas):
  Node 1: leaseholder for ranges 1-100, replica for 101-300
  Node 2: leaseholder for ranges 101-200, replica for 1-100, 201-300
  Node 3: leaseholder for ranges 201-300, replica for 1-200
```

### CockroachDB Setup and Schema

```sql
-- Connect to CockroachDB (PostgreSQL wire protocol compatible), from a shell:
--   cockroach sql --certs-dir=certs --host=cockroach-1:26257
-- (--insecure is for local experiments only)

-- Create the payments database
CREATE DATABASE payments;
USE payments;

-- Schema is similar to PostgreSQL with minor differences
CREATE TABLE accounts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_number VARCHAR(20) UNIQUE NOT NULL,
    balance      DECIMAL(19,4) NOT NULL DEFAULT 0,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    region       STRING AS (
        CASE
            WHEN account_number LIKE 'EU%' THEN 'EU'
            WHEN account_number LIKE 'US%' THEN 'US'
            ELSE 'GLOBAL'
        END
    ) STORED,
    version      INT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE transactions (
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id),
    amount       DECIMAL(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    type         VARCHAR(30) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, created_at, id)  -- co-locate by account
);

-- Indexes work the same as PostgreSQL
CREATE INDEX idx_transactions_status
    ON transactions (status, created_at DESC)
    WHERE status = 'PENDING';
```

### Serializable Isolation in CockroachDB

```sql
-- CockroachDB default isolation: SERIALIZABLE
-- This is stronger than PostgreSQL's default READ COMMITTED
-- (PostgreSQL requires SET default_transaction_isolation = 'serializable' explicitly)
-- Recent CockroachDB versions (24.1+) also offer READ COMMITTED,
-- which needs far fewer client-side retries -- but weaker guarantees

-- Check isolation level
SHOW transaction isolation level;
-- serializable

-- Serializable transactions may retry under contention
-- CockroachDB recommends retry logic in applications:
BEGIN;
SAVEPOINT cockroach_restart;

-- ... execute transaction ...

RELEASE SAVEPOINT cockroach_restart;
COMMIT;
-- If a serialization anomaly is detected, CockroachDB may throw
-- SERIALIZATION_FAILURE error -> client should retry from SAVEPOINT
```

```java
@Service
@Slf4j
public class CockroachPaymentService {

    private final JdbcTemplate jdbcTemplate;
    private final TransactionTemplate txTemplate;   // SERIALIZABLE by default on CockroachDB

    /**
     * CockroachDB retry logic for serializable transactions.
     * SQLSTATE 40001 is translated by Spring into a ConcurrencyFailureException
     * (e.g. CannotSerializeTransactionException) -- a raw SQLException never
     * reaches this method, so retrying on SQLException would never fire.
     *
     * The retry must wrap the WHOLE transaction: each attempt runs a fresh
     * transaction via TransactionTemplate. (Putting @Retryable and
     * @Transactional on the same method depends on proxy ordering -- easy to
     * get wrong.)
     */
    @Retryable(
        retryFor = ConcurrencyFailureException.class,
        maxAttempts = 5,
        backoff = @Backoff(delay = 50, multiplier = 2, random = true)  // jitter
    )
    public void transferFunds(UUID fromAccountId, UUID toAccountId, BigDecimal amount) {
        txTemplate.executeWithoutResult(status -> {
            int debited = jdbcTemplate.update(
                "UPDATE accounts SET balance = balance - ? WHERE id = ? AND balance >= ?",
                amount, fromAccountId, amount);
            if (debited != 1) {
                throw new InsufficientFundsException(fromAccountId);   // not retried
            }
            jdbcTemplate.update(
                "UPDATE accounts SET balance = balance + ? WHERE id = ?",
                amount, toAccountId);
        });
    }

    @Recover
    void retriesExhausted(ConcurrencyFailureException e,
                          UUID fromAccountId, UUID toAccountId, BigDecimal amount) {
        log.error("Transfer {} -> {} failed after retries", fromAccountId, toAccountId, e);
        throw e;
    }
}
```

## 3. Google Spanner — TrueTime and External Consistency

Spanner is Google's globally distributed relational database. Its key innovation is TrueTime — a globally synchronized clock with bounded uncertainty.

### TrueTime Architecture

```
Conventional databases: use logical clocks (Lamport timestamps, sequence numbers)
  - Don't reflect real time
  - Cross-datacenter ordering requires coordination

Spanner TrueTime:
  - GPS receivers and atomic clocks in each Google data center
  - API: TT.now() returns interval [earliest, latest] (uncertainty ε:
    1-7ms in the original 2012 paper, usually well under that today)
  - Commit wait: Spanner waits until uncertainty passes before returning COMMIT
    to ensure the transaction timestamp is in the past for all observers

Consequence:
  - External consistency: if transaction T1 commits before T2 starts,
    T2's timestamp is guaranteed > T1's timestamp
  - This enables linearizable globally distributed transactions
```

### Spanner SQL — Familiar but Distributed

```sql
-- Spanner SQL (similar to standard SQL)
-- Table design: interleaved tables for co-location

CREATE TABLE accounts (
    AccountId   STRING(36) NOT NULL,
    AccountNum  STRING(20) NOT NULL,
    Balance     NUMERIC NOT NULL,
    Currency    STRING(3) NOT NULL,
    Status      STRING(20) NOT NULL,
    UpdatedAt   TIMESTAMP NOT NULL
) PRIMARY KEY (AccountId);

-- Interleaved table: Transaction rows are stored physically adjacent to
-- their parent Account row on the same split (Spanner's range equivalent)
CREATE TABLE transactions (
    AccountId     STRING(36) NOT NULL,
    TransactionId STRING(36) NOT NULL,
    Amount        NUMERIC NOT NULL,
    Status        STRING(20) NOT NULL,
    CreatedAt     TIMESTAMP NOT NULL
) PRIMARY KEY (AccountId, TransactionId),
  INTERLEAVE IN PARENT accounts ON DELETE CASCADE;
-- Interleaving is Spanner's equivalent of CockroachDB co-location
-- Queries joining accounts + transactions on AccountId are served from one split
```

### Spanner Java Client

```java
// Google Cloud Spanner Java client
@Service
public class SpannerPaymentService {

    private final DatabaseClient spannerClient;

    public Optional<BigDecimal> getBalance(String accountId) {
        // Strong read: sees all committed data; a nearby replica can serve it
        // once it is up to date (it may need to check with the leader)
        Statement statement = Statement.newBuilder(
            "SELECT Balance FROM accounts WHERE AccountId = @accountId"
        ).bind("accountId").to(accountId).build();

        try (ResultSet rs = spannerClient
                .singleUse(TimestampBound.strong())
                .executeQuery(statement)) {
            if (rs.next()) {
                return Optional.of(rs.getBigDecimal("Balance"));
            }
            return Optional.empty();
        }
    }

    public void transferFunds(String fromId, String toId, BigDecimal amount) {
        // run() retries the function automatically if Spanner aborts the
        // transaction -- so the lambda must have no side effects outside it
        spannerClient.readWriteTransaction().run(txn -> {
            // Read both accounts in a single round trip
            Map<String, Struct> accounts = new HashMap<>();
            try (ResultSet rs = txn.read(
                    "accounts",
                    KeySet.newBuilder()
                        .addKey(Key.of(fromId))
                        .addKey(Key.of(toId))
                        .build(),
                    Arrays.asList("AccountId", "Balance", "Status"))) {
                while (rs.next()) {
                    accounts.put(rs.getString("AccountId"), rs.getCurrentRowAsStruct());
                }
            }

            // Validate (both exist, active, enough balance)
            validateAccounts(accounts, fromId, toId, amount);

            BigDecimal fromBalance = accounts.get(fromId).getBigDecimal("Balance");
            BigDecimal toBalance   = accounts.get(toId).getBigDecimal("Balance");

            // Write mutations (applied atomically at commit)
            txn.buffer(List.of(
                Mutation.newUpdateBuilder("accounts")
                    .set("AccountId").to(fromId)
                    .set("Balance").to(fromBalance.subtract(amount))
                    .set("UpdatedAt").to(Value.COMMIT_TIMESTAMP)
                    .build(),
                Mutation.newUpdateBuilder("accounts")
                    .set("AccountId").to(toId)
                    .set("Balance").to(toBalance.add(amount))
                    .set("UpdatedAt").to(Value.COMMIT_TIMESTAMP)
                    .build()));
            return null;
        });
    }
}
// (UpdatedAt needs allow_commit_timestamp = true in its column options)
```

## 4. Geo-Partitioning for Data Residency (GDPR)

Both CockroachDB and Spanner support geo-partitioning — placing data physically in specific regions.

Note: placing the *primary* copy in a region is not automatically full data residency — also check where non-voting replicas, backups, logs and changefeeds end up.

### CockroachDB Geo-Partitioning

```sql
-- Current CockroachDB: multi-region SQL abstractions (21.1+).
-- (The older manual way -- PARTITION BY LIST + zone configs -- requires
--  the partition column to be a PREFIX of the primary key, e.g.
--  PRIMARY KEY (region, id); a plain "PRIMARY KEY (id)" table cannot be
--  list-partitioned by region.)

ALTER DATABASE payments PRIMARY REGION "europe-west1";
ALTER DATABASE payments ADD REGION "us-east1";

-- Each row is homed in the region stored in the hidden crdb_region column
ALTER TABLE accounts SET LOCALITY REGIONAL BY ROW;

-- Set the home region from the customer's residency on insert
INSERT INTO accounts (crdb_region, account_number, currency)
VALUES ('europe-west1', 'EU-1001', 'EUR');

-- Keep ALL replicas (including non-voting ones) inside the home region
-- -- needed for strict data domiciling
ALTER DATABASE payments PLACEMENT RESTRICTED;

-- Now EU customer data physically lives in the EU region
-- A query from Frankfurt accessing EU accounts has local latency (~2ms)
-- A query from Frankfurt accessing US accounts has cross-Atlantic latency (~80ms)
```

### Spanner Geo-Distribution

```
Spanner multi-region configuration:
  - Regional: single region (lowest latency, regional HA only)
  - Multi-regional: 2 or more regions (global HA, higher latency for commits)
  - Instance configs: nam4 (N. America), eur3 (Europe), asia1 (Asia), etc.

For GDPR:
  - Create separate Spanner instances per region
  - EU instance: eur3 (Belgium + Netherlands)
  - Route EU customers to EU Spanner instance
  - Cross-instance transactions not supported (design to avoid them)
```

## 5. Latency Implications of Distributed Transactions

This is the most important section for financial system architects.

```
(illustrative orders of magnitude -- measure your own setup)

CockroachDB write latency (Raft consensus):
  Single-region (3 replicas, same DC):   2-5ms per commit
  Multi-region (replicas in 3 regions):  ~ round trip to the nearest replica
                                         that completes a majority (tens of ms)
  Multi-range transactions:              "parallel commits" usually keep this
                                         to about one consensus round

Spanner write latency (Paxos + TrueTime):
  Regional (single region):              5-10ms (commit wait for TrueTime uncertainty)
  Multi-regional:                        20-100ms (depends on replica spread)

PostgreSQL single-node comparison:
  Local commit (NVMe SSD, synchronous):  0.1-1ms
  With synchronous replication (1 standby, same DC): 1-3ms
```

```java
// Latency measurement comparison
// JMH sketch (the *State classes hold a JdbcTemplate per database)
public class LatencyComparison {

    @Benchmark
    public void postgresLocalWrite(PostgresState state) {
        state.jdbcTemplate.update(
            "INSERT INTO transactions (id, account_id, amount, currency, status) VALUES (?, ?, ?, 'USD', 'PENDING')",
            UUID.randomUUID(), state.accountId, BigDecimal.TEN
        );
        // Typical: 0.5ms (SSD, synchronous_commit=on)
    }

    @Benchmark
    public void cockroachDBSingleRegionWrite(CockroachState state) {
        state.jdbcTemplate.update(
            "INSERT INTO transactions (id, account_id, amount, currency, status) VALUES (?, ?, ?, 'USD', 'PENDING')",
            UUID.randomUUID(), state.accountId, BigDecimal.TEN
        );
        // Typical: 3ms (Raft consensus, 3 replicas, same DC)
        // CockroachDB has 3-6x higher write latency than PostgreSQL local
    }

    @Benchmark
    public void spannerRegionalWrite(SpannerState state) {
        // Typical: 7ms (commit wait for TrueTime uncertainty)
    }
}
```

## 6. When NewSQL Makes Sense in Fintech

```
Choose NewSQL (CockroachDB or Spanner) when:

1. Global payment processing with multi-region active-active requirement
   - Customers in EU and US must transact simultaneously
   - Both regions must accept writes (not read-replica architecture)
   - Acceptable latency: 5-50ms per transaction

2. Write scale exceeds single PostgreSQL server
   - Sustained write throughput > 20,000 TPS
   - Horizontal scale-out is preferable to vertical scaling (cost, limits)
   - After having exhausted: indexes, partitioning, connection pooling, Citus

3. Operational simplicity of cloud-managed multi-region
   - Spanner eliminates the complexity of managing PostgreSQL streaming replication
   - Google/Cockroach Labs handles failover, compaction, sharding
   - Team lacks distributed systems expertise for manual sharding

Do NOT choose NewSQL when:

1. Write throughput is manageable on a single PostgreSQL server
   - Most fintech startups don't reach PostgreSQL's ceiling for years

2. Latency SLA requires < 2ms writes
   - CockroachDB/Spanner cannot achieve sub-2ms consistently
   - PostgreSQL local commits with NVMe: 0.1-0.5ms

3. Complex analytical queries are frequent
   - NewSQL is optimized for OLTP; analytical queries run slower due to
     distributed aggregation overhead
   - Consider columnar/HTAP databases for analytics

4. Team lacks experience with distributed transaction patterns
   - Serialization retries, 2PC failure handling, stale read patterns
   - PostgreSQL is significantly simpler to operate correctly
```

## 7. Migration Considerations

```java
// CockroachDB is PostgreSQL wire-protocol compatible
// Spring Boot applications need minimal changes

// Before migration:
@Configuration
public class PostgresConfig {
    @Bean
    public DataSource dataSource() {
        return DataSourceBuilder.create()
            .url("jdbc:postgresql://postgres:5432/payments")
            .build();
    }
}

// After migration to CockroachDB:
@Configuration
public class CockroachConfig {
    @Bean
    public DataSource dataSource() {
        return DataSourceBuilder.create()
            .url("jdbc:postgresql://cockroach-1:26257/payments?sslmode=verify-full")
            // CockroachDB uses PostgreSQL JDBC driver
            .build();
    }
}

// Key differences to handle in application code:
// 1. Add retry logic for SERIALIZATION_FAILURE (40001)
// 2. Avoid sequence-based IDs: sequences exist but serialise inserts on
//    one range -- use UUIDs (or unique_rowid())
// 3. Check FOR UPDATE SKIP LOCKED / NOWAIT support in your version
// 4. pg_advisory_lock and friends are not supported
// 5. Test prepared statement behaviour (minor differences)
```

```sql
-- PostgreSQL-to-CockroachDB compatibility issues to test
-- (support changes quickly -- check the docs for YOUR version)
-- 1. Some type casts and default types differ (e.g. INT is 64-bit)
-- 2. RETURNING on UPDATE (supported)
-- 3. ON CONFLICT DO NOTHING/UPDATE (supported)
-- 4. Window functions (supported)
-- 5. LISTEN/NOTIFY (not supported -- use changefeeds (CDC) / Kafka instead)
-- 6. Stored procedures and PL/pgSQL (added in 23.x, still a subset)
-- 7. Triggers (only in recent versions, 24.3+; check limitations)
-- 8. Extensions such as PostGIS-style features or pg_trgm: some built in,
--    most PostgreSQL extensions are not available
```

## 8. Summary — NewSQL Decision Matrix

(Rough, illustrative ranges — real numbers depend heavily on hardware, schema and workload.)

| Requirement | PostgreSQL | Citus | CockroachDB | Spanner |
|---|---|---|---|---|
| Write TPS | 10K-30K | 30K-100K | 50K-200K | 100K+ |
| Read latency p99 | <5ms | <10ms | 5-20ms | 10-50ms |
| Write latency p99 | <2ms | <5ms | 5-15ms | 10-50ms |
| Multi-region active-active | No | No | Yes | Yes |
| Operational complexity | Low | Medium | Medium | Low (managed) |
| SQL compatibility | Full | Full | High (wire-compatible, some gaps) | GoogleSQL or PostgreSQL dialect (subset) |
| Cost at scale | Medium | Medium | High | Very High |
| Team expertise required | Standard | Intermediate | Advanced | Advanced |

> [!WARNING]
> The most common NewSQL adoption mistake in fintech is choosing CockroachDB or Spanner prematurely — before PostgreSQL has been properly optimized. Before evaluating NewSQL, verify that you have: (1) proper indexes on all query patterns, (2) connection pooling configured, (3) partitioning implemented for large tables, (4) read replicas for read-heavy workloads, and (5) a measured TPS ceiling with production workloads. Most financial systems reach their PostgreSQL ceiling far later than initially estimated.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A CockroachDB transaction fails with error: TransactionRetryWithProtoRefreshError: TransactionRetryError: retry txn (REASON_TS_CACHE_REJECTED). What is the correct application-level handling and why does CockroachDB require it?",
      "options": [
        "Catch the error and immediately abort the entire operation; CockroachDB does not support retries at the application level",
        "Catch the error, roll back the transaction, and retry the entire transaction from the beginning using exponential backoff; CockroachDB uses optimistic concurrency control and cannot internally retry transactions that have already sent results to the client",
        "Increase the transaction timeout using SET statement_timeout; the error indicates a slow transaction that needs more time",
        "Switch to READ COMMITTED isolation; REASON_TS_CACHE_REJECTED only occurs under SERIALIZABLE isolation"
      ],
      "correct": 1,
      "explanation": "CockroachDB uses optimistic concurrency control with MVCC. When a serialisability conflict is detected, it raises a retryable error (SQLSTATE 40001) rather than blocking. CockroachDB retries some transactions automatically on the server, but once results have been returned to the client it cannot — the application must roll back and run the whole transaction logic again, with backoff. Use your own retry loop (or Spring Retry around a TransactionTemplate), or Cockroach Labs' JDBC wrapper, which can retry transparently."
    },
    {
      "text": "Google Spanner uses TrueTime to assign globally ordered commit timestamps. A transaction commits with TrueTime interval [T-ε, T+ε] where ε is the clock uncertainty. What does Spanner do before making the committed data visible to readers?",
      "options": [
        "It immediately makes the data visible and relies on readers to handle uncertainty by re-reading",
        "It waits for the commit wait period (at least 2ε) until the commit timestamp is guaranteed to be in the past before making the data visible, ensuring external consistency",
        "It uses a central timestamp oracle to resolve the uncertainty before assigning a final timestamp",
        "It requests a GPS time update to reduce ε before committing high-priority transactions"
      ],
      "correct": 1,
      "explanation": "Spanner's commit wait ensures external consistency: after choosing a commit timestamp T, Spanner waits until TrueTime.now().earliest > T before making the commit visible and acknowledging it. Any transaction that starts afterwards therefore gets a timestamp greater than T and sees the committed data. The wait is about the clock uncertainty (a few milliseconds at most, usually much less today), and it is what gives Spanner globally consistent reads without a central timestamp oracle."
    },
    {
      "text": "A payment platform currently runs on PostgreSQL with 15K TPS at p99 = 8ms. The engineering team proposes migrating to CockroachDB for multi-region active-active capability. What should a principal engineer verify BEFORE approving the migration?",
      "options": [
        "That CockroachDB supports all PostgreSQL extensions currently used, including pg_trgm and PostGIS",
        "That the team has exhausted PostgreSQL scaling options (read replicas, partitioning, connection pooling, index optimisation) and has a specific, measured multi-region requirement that justifies the operational complexity and 2-3x cost increase",
        "That the development team has completed CockroachDB certification training",
        "That the existing application code uses only ANSI SQL with no PostgreSQL-specific syntax"
      ],
      "correct": 1,
      "explanation": "15K TPS at p99 = 8ms is well within what an optimised PostgreSQL can do. CockroachDB's write latency is typically several milliseconds even in a single region because of Raft consensus, so the migration may worsen latency. A principal engineer must require: (a) evidence that PostgreSQL has been fully optimised, (b) a specific business requirement for multi-region active-active (not just disaster recovery, which active-passive handles), and (c) a cost-benefit analysis including the operational expertise needed and the usually much higher licensing and compute costs."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement CockroachDB Retry Logic and Evaluate NewSQL Migration Readiness",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Implement a CockroachDBTransactionTemplate class that wraps a Supplier<T> in a retry loop. The loop must: (a) detect TransactionRetryWithProtoRefreshError by checking the SQL state '40001', (b) roll back and retry up to 5 times with exponential backoff starting at 50ms, (c) propagate the original exception after max retries, (d) log each retry attempt with attempt number and backoff duration. Write a unit test using a mock DataSource that throws the retryable exception twice and succeeds on the third attempt, verifying the result is returned correctly."
    },
    {
      "id": "2",
      "description": "Design a CockroachDB multi-region schema for a payments table where EU customer data must remain in EU nodes and US customer data in US nodes. Use the multi-region abstractions (PRIMARY REGION / ADD REGION, LOCALITY REGIONAL BY ROW with crdb_region set from customer residency, and PLACEMENT RESTRICTED). Write the DDL. Then write a query that demonstrates follower reads for a reporting use case: SELECT ... AS OF SYSTEM TIME follower_read_timestamp() to read from the nearest replica without crossing region boundaries."
    },
    {
      "id": "3",
      "description": "Create a NewSQLMigrationReadinessReport class that evaluates whether a PostgreSQL deployment is ready for NewSQL migration. The report must check: (a) current peak TPS from pg_stat_statements, (b) whether read replicas are configured (pg_stat_replication), (c) whether table partitioning is in use (pg_partman schema), (d) p99 latency from pg_stat_statements mean_exec_time, (e) connection pool utilisation. Output a structured report with a readiness score (0-100) and specific recommendations for each gap found."
    },
    {
      "id": "4",
      "description": "Implement a distributed payment saga that avoids distributed transactions across two CockroachDB nodes: PaymentInitiationSaga orchestrates (1) DebitAccountStep and (2) CreditMerchantStep as independent local transactions with compensating steps (RefundDebitStep, ReverseCreditStep). Use an outbox table pattern for step coordination. Write an integration test that simulates CreditMerchantStep failure and verifies that RefundDebitStep is invoked, leaving the system in a consistent state."
    }
  ]
}
-->
