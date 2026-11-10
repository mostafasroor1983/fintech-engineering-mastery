---
id: track-10-lesson-22
title: "Principal Engineer's Database Decision Framework"
slug: database-decision-framework
track: track-10
trackName: "Database & Data Architecture"
sequence: 22
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, database, trade-offs, staff-engineer, selection]
prerequisites: [track-10-lesson-21]
---

# Principal Engineer's Database Decision Framework

> [!NOTE]
> The most expensive database mistake is choosing the wrong database before you understand your workload. The second most expensive is staying with the wrong database too long after the workload has evolved. The principal engineer's role is to establish the decision criteria, enforce measured evaluation, and prevent both premature optimization and premature migration.

## 1. Database Selection Framework for Financial Services

The selection process must follow this sequence:
1. **Measure the problem** (don't guess at requirements)
2. **Exhaust current database optimizations** before switching
3. **Prototype with realistic data** (not toy examples)
4. **Calculate TCO** (operational cost + engineering cost + risk)
5. **Decide with explicit criteria** (write them down)

### Decision Tree: SQL vs NoSQL vs NewSQL

```
Step 1: Do you need ACID transactions?
  YES -> Stay in SQL family (PostgreSQL, MySQL, CockroachDB, Spanner)
  NO  -> NoSQL may be appropriate (Cassandra for time-series, Redis for cache)
         (Note: very few financial use cases can safely use eventual consistency)

Step 2: What is your write throughput requirement?
  < 10,000 TPS    -> Single PostgreSQL with optimized indexes
  10K-30K TPS     -> PostgreSQL with read replicas + connection pooling
  30K-100K TPS    -> Citus (distributed PostgreSQL)
  > 100K TPS      -> CockroachDB or Spanner
  (Note: measure actual workload before assuming you need high end)

Step 3: What is your geographic distribution requirement?
  Single region         -> PostgreSQL with streaming replication
  Multi-region active-passive -> PostgreSQL + cross-region standby
  Multi-region active-active  -> CockroachDB or Spanner

Step 4: What are your analytical query requirements?
  OLTP only         -> PostgreSQL, CockroachDB
  Mixed OLTP/OLAP   -> PostgreSQL + read replica, or Citus columnar
  Pure analytics    -> Redshift, BigQuery, Snowflake (separate system)
```

## 2. Isolation Level Selection Guide

The isolation level determines what anomalies are possible. Financial systems must be explicit about this.

```sql
-- PostgreSQL isolation levels (from weakest to strongest)

-- READ COMMITTED (PostgreSQL default):
-- Sees committed data at the START of each statement (not transaction)
-- Anomalies possible: non-repeatable reads, phantom reads
-- Use for: read-only reporting queries, dashboard data
-- NOT for: balance updates, transaction writes

-- REPEATABLE READ:
-- Sees data committed before transaction started
-- Anomalies possible: phantom reads (new rows inserted by others can be invisible)
-- PostgreSQL's implementation also prevents phantom reads in practice
-- Use for: multi-statement reads that must see consistent snapshot

-- SERIALIZABLE:
-- Strongest isolation: transactions appear to execute serially
-- No anomalies possible
-- Cost: higher lock contention, serialization failures under high concurrency
-- Use for: ALL financial writes (balance updates, transaction inserts)
```

```java
// Isolation level selection in Spring
@Service
public class PaymentService {

    // Financial writes: always SERIALIZABLE
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void processPayment(PaymentRequest request) {
        // balance check + debit + transaction insert
    }

    // Idempotency check: READ_COMMITTED is sufficient
    // (we re-check inside a serializable transaction anyway)
    @Transactional(isolation = Isolation.READ_COMMITTED, readOnly = true)
    public Optional<Transaction> checkIdempotency(String key) {
        return transactionRepository.findByIdempotencyKey(key);
    }

    // Balance read for display (slight staleness acceptable):
    @Transactional(isolation = Isolation.READ_COMMITTED, readOnly = true)
    public Money getDisplayBalance(UUID accountId) {
        return accountRepository.findBalanceById(accountId);
    }

    // Report generation (long-running, needs consistent snapshot):
    @Transactional(isolation = Isolation.REPEATABLE_READ, readOnly = true)
    public SettlementReport generateSettlementReport(LocalDate date) {
        // Multiple queries must see the same snapshot
        return reportingService.generate(date);
    }
}
```

## 3. Indexing Strategy Decision Framework

```
For each table, answer these questions:

1. What are the top 5 query patterns? (measure with pg_stat_statements)
   -> Create composite indexes covering those patterns

2. Are there any high-cardinality lookup columns?
   -> B-tree or Hash index

3. Are there status/type columns with low cardinality that filter most queries?
   -> Partial index (WHERE status = 'PENDING')

4. Are there frequently projected columns that could enable index-only scans?
   -> Covering index with INCLUDE

5. Are there expression or function-based predicates?
   -> Expression index

6. After creating indexes: measure impact
   -> pg_stat_user_indexes: idx_scan should be > 0 within 2 weeks
   -> Drop unused indexes
```

```sql
-- Index decision checklist query
-- Run after 2 weeks in production to identify unused and bloated indexes

SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    idx_scan AS scans_since_restart,
    CASE
        WHEN idx_scan = 0 THEN 'UNUSED - consider dropping'
        WHEN idx_scan < 100 THEN 'RARELY USED - review'
        ELSE 'ACTIVE'
    END AS recommendation
FROM pg_stat_user_indexes
LEFT JOIN pg_index ON pg_index.indexrelid = pg_stat_user_indexes.indexrelid
WHERE indisprimary = false
  AND indisunique = false
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
LIMIT 30;
```

## 4. When to Partition

```
Partition when:
  - Table size exceeds 100GB (without partitioning, VACUUM becomes slow)
  - Query patterns consistently filter by a date range (partition by date)
  - Archival strategy requires removing old data (detach + drop partition)
  - Write throughput benefits from distributing WAL across partitions (hash partition)

Do NOT partition when:
  - Table is small (< 10GB): partitioning overhead not worth it
  - Queries rarely include the partition key: no pruning benefit
  - Team lacks operational experience with partitioned tables

Partition key selection:
  - Time-series data: RANGE on created_at (most common in fintech)
  - Multi-tenant: LIST or HASH on tenant_id
  - Regional: LIST on region/country
  - Even write distribution: HASH on a high-cardinality column
```

## 5. Archival Strategy Selection

```
Data retention requirements drive archival strategy:

Short retention (< 1 year):
  -> Keep everything in hot PostgreSQL tier
  -> Use partitioning for maintenance (VACUUM, table size)
  -> No archival pipeline needed

Medium retention (1-3 years):
  -> Hot tier (12 months): partitioned PostgreSQL
  -> Warm tier (12-24 months): partitioned PostgreSQL read replica
  -> No cold archival needed if storage cost is acceptable

Long retention (3-7+ years, regulatory requirement):
  -> Hot tier: last 12-24 months in PostgreSQL
  -> Cold tier: older data in S3 (pg_dump / Parquet)
  -> Query layer: AWS Athena for cold tier compliance queries
  -> Automated pipeline: pg_cron for detach + export + drop
```

## 6. Connection Pool Right-Sizing

```
Formula: pool_size_per_instance = (vCPU_count * 2) + disk_spindle_count

Practical rules:
  - For NVMe SSD: treat as 1 "spindle" (effectively random_page_cost ~ 1.0)
  - For cloud instances: use the formula, then validate with pgbench

Total PostgreSQL connections = instances * pool_size_per_instance + ops_headroom

Example: 10 instances, 4 vCPU each, NVMe
  pool_per_instance = (4*2) + 1 = 9 -> round to 10
  total = 10 * 10 = 100
  Add 20 for ops/admin/monitoring: max_connections = 120

PgBouncer configuration (transaction mode):
  default_pool_size = max_connections * 1.2 = 144 -> round to 150
  max_client_conn = instances * pool_per_instance * 2 = 200

Adjust max_connections in PostgreSQL:
  ALTER SYSTEM SET max_connections = 120;
  SELECT pg_reload_conf();
```

```java
// Self-documenting pool configuration
@Configuration
public class DatabasePoolConfig {

    private static final int VCPU_COUNT = 4;
    private static final int DISK_SPINDLES = 1;  // NVMe SSD
    private static final int POOL_SIZE = (VCPU_COUNT * 2) + DISK_SPINDLES;  // = 9
    private static final int OPS_HEADROOM = 2;  // admin connections per instance

    @Bean
    public HikariConfig hikariConfig() {
        HikariConfig config = new HikariConfig();
        config.setMaximumPoolSize(POOL_SIZE + OPS_HEADROOM);  // 11
        config.setMinimumIdle(POOL_SIZE / 2);                 // 4
        config.setPoolName(String.format(
            "payments-pool-%dvCPU-%ddisks", VCPU_COUNT, DISK_SPINDLES));
        return config;
    }
}
```

## 7. Read Replica Usage Patterns

```
Use read replicas for:
  - Reporting queries (settlement reports, reconciliation)
  - Customer-facing read-heavy APIs (transaction history, balance display)
  - Analytics and dashboards
  - Backfill and batch processing

Do NOT use read replicas for:
  - Balance reads used in transaction authorization (replication lag = stale balance)
  - Any read that affects a subsequent write in the same transaction
  - Idempotency checks (must read from primary to avoid race conditions)

Replication lag monitoring:
  SELECT NOW() - pg_last_xact_replay_timestamp() AS replication_lag;
  -- Alert if lag > 5 seconds for payment-related replicas
  -- Alert if lag > 60 seconds for reporting replicas
```

```java
@Configuration
public class RoutingDataSourceConfig {

    @Bean
    public DataSource routingDataSource(
            @Qualifier("primary") DataSource primary,
            @Qualifier("replica") DataSource replica) {
        return new AbstractRoutingDataSource() {
            @Override
            protected Object determineCurrentLookupKey() {
                return TransactionSynchronizationManager.isCurrentTransactionReadOnly()
                    ? "replica"
                    : "primary";
            }

            {
                setTargetDataSources(Map.of(
                    "primary", primary,
                    "replica", replica
                ));
                setDefaultTargetDataSource(primary);
            }
        };
    }
}
```

## 8. Common Database Anti-Patterns in Fintech

### Anti-Pattern 1: N+1 Queries from ORM

```java
// WRONG: 1 query to load accounts + N queries for each account's transactions
@Service
public class AccountService {
    public List<AccountSummary> getAccountSummaries(List<UUID> accountIds) {
        return accountIds.stream()
            .map(id -> {
                Account account = accountRepo.findById(id).get();
                List<Transaction> recent = txnRepo.findRecent5(id); // N+1 problem!
                return new AccountSummary(account, recent);
            })
            .collect(Collectors.toList());
    }
}

// CORRECT: Single query with JOIN
@Query("""
    SELECT a.id, a.balance, a.currency,
           t.id AS txn_id, t.amount AS txn_amount, t.created_at
    FROM accounts a
    LEFT JOIN LATERAL (
        SELECT id, amount, created_at
        FROM transactions
        WHERE account_id = a.id
        ORDER BY created_at DESC
        LIMIT 5
    ) t ON true
    WHERE a.id IN (:accountIds)
    """)
List<AccountWithTransactionsRow> findAccountsWithRecentTransactions(
    @Param("accountIds") List<UUID> accountIds);
```

### Anti-Pattern 2: Missing Indexes on Foreign Keys

```sql
-- PostgreSQL does NOT automatically index foreign key columns
-- Without the index, every FK constraint check requires a sequential scan

-- WRONG: transactions.account_id is a FK but has no index
CREATE TABLE transactions (
    id         UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id)
    -- ... no index on account_id
);

-- DELETE FROM accounts WHERE id = ? will sequential scan transactions to check FK
-- UPDATE to accounts PK will also scan transactions
-- Any query filtering by account_id will sequential scan

-- CORRECT: Always index FK columns
CREATE INDEX idx_transactions_account_id ON transactions (account_id);

-- Detection query: find FK columns without indexes
SELECT
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS referenced_table
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid
        AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = (tc.table_name)::regclass
      AND a.attname = kcu.column_name
  );
```

### Anti-Pattern 3: Over-Normalisation

```sql
-- WRONG: separate table for currency, joined on every query
CREATE TABLE currency_codes (
    code  CHAR(3) PRIMARY KEY,
    name  VARCHAR(50)
);

CREATE TABLE transactions (
    id          UUID PRIMARY KEY,
    currency_id CHAR(3) REFERENCES currency_codes(code)
);

-- Every transaction query requires a JOIN to currency_codes for a 3-char string
-- Benefit: none (currency codes never change, referential integrity available via CHECK)
-- Cost: JOIN overhead on every transaction query

-- CORRECT: denormalize stable reference data
CREATE TABLE transactions (
    id       UUID PRIMARY KEY,
    currency CHAR(3) NOT NULL
        CHECK (currency IN ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'))
);
-- No JOIN needed, constraint validates values, easy to extend with ALTER TABLE
```

### Anti-Pattern 4: SELECT * in Hot Paths

```java
// WRONG: loading all 50 columns when only 3 are needed
@Query("SELECT * FROM transactions WHERE account_id = :id ORDER BY created_at DESC LIMIT 50")
List<Transaction> findRecent(@Param("id") UUID accountId);

// CORRECT: project only needed columns
@Query("""
    SELECT id, amount, currency, status, created_at
    FROM transactions
    WHERE account_id = :id
    ORDER BY created_at DESC
    LIMIT 50
    """)
List<TransactionSummary> findRecentSummaries(@Param("id") UUID accountId);

// Benefits:
// 1. Less data transferred from DB to application
// 2. Smaller ResultSet to deserialize
// 3. Enables covering index (index-only scan possible)
```

### Anti-Pattern 5: Long-Running Transactions Holding Locks

```java
// WRONG: Transaction open while doing external API call
@Transactional
public PaymentResult processPayment(PaymentRequest request) {
    // Begin transaction (holds lock on account row from here)
    Account account = accountRepo.findByIdForUpdate(request.getAccountId());

    // DANGER: external call inside transaction (could take 5+ seconds)
    // During this time: account row is LOCKED, blocking all other transactions
    // for this account
    FraudCheckResult fraud = fraudService.checkExternal(request); // 100-500ms!

    // ... rest of processing
    return result;
    // Transaction commits here, lock released
}

// CORRECT: External calls outside transaction
public PaymentResult processPayment(PaymentRequest request) {
    // Check fraud BEFORE opening transaction
    FraudCheckResult fraud = fraudService.checkExternal(request); // No lock held

    // Open transaction only for the DB operations
    return transactionTemplate.execute(status -> {
        Account account = accountRepo.findByIdForUpdate(request.getAccountId());
        // ... write operations (< 10ms with no external calls)
        return result;
    });
}
```

## 9. The Principal Engineer's Database Checklist

For any new database design or significant modification, verify:

```
Schema design:
[ ] All foreign keys have indexes
[ ] Primary keys use UUID (not sequential int) for distributed safety
[ ] Timestamps use TIMESTAMPTZ (not TIMESTAMP without timezone)
[ ] Monetary amounts use NUMERIC(19,4) (not FLOAT or DOUBLE)
[ ] Status columns use VARCHAR with CHECK constraint (not unconstrained text)

Query patterns:
[ ] Top 5 queries by frequency have appropriate indexes
[ ] No SELECT * in hot paths
[ ] No N+1 patterns (verify with New Relic or query log analysis)
[ ] All queries against large tables include the partition key

Transactions:
[ ] Financial writes use SERIALIZABLE isolation
[ ] No external service calls inside transactions
[ ] No unbounded transactions (each has a maximum duration)
[ ] Idempotency implemented for all write operations

Operations:
[ ] Connection pool sized correctly (formula applied, not guessed)
[ ] PgBouncer in transaction mode (not session mode)
[ ] pg_stat_statements enabled and monitored
[ ] auto_explain configured for queries > 1 second
[ ] Backup and PITR tested quarterly
[ ] Replication lag monitored and alerted
[ ] Table bloat monitored (autovacuum health)
[ ] Index bloat monitored and REINDEX scheduled

Governance:
[ ] All schema changes use expand-contract pattern
[ ] All DDL migrations tested with Testcontainers
[ ] Rollback scripts exist for every migration
[ ] Performance baseline recorded before optimizations
[ ] Database decision documented in ADR (Architecture Decision Record)
```

## 10. Summary — The Principal Engineer's Mandate

The principal engineer does not write most of the SQL — they establish the standards that prevent the common mistakes, and they escalate the conversations that need escalation.

**Standards to establish**:
1. Serializable isolation for all financial writes — not negotiable
2. EXPLAIN ANALYZE review required before merging any new query on a large table
3. Performance baseline in CI — regressions fail the build
4. Quarterly backup restore test — scheduled, not optional
5. Database architecture decision records — every significant choice documented

**Conversations to initiate**:
- "Have we measured the actual TPS before proposing a database migration?"
- "What is the worst-case consequence of serving stale data here?"
- "What happens to our application when this database is unavailable for 5 minutes?"
- "What is our recovery time objective, and have we tested meeting it?"

> [!NOTE]
> The most valuable database skill for a principal engineer is not knowing every PostgreSQL configuration parameter. It is knowing when the database is the bottleneck and when it is not. Most application performance problems are not database problems — they are code problems (N+1, missing indexes, inefficient algorithms) that happen to manifest in DB metrics. Train your team to identify the difference before reaching for a new database technology.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment service uses READ COMMITTED isolation. Two transactions run concurrently: Transaction A reads account balance = 1000, Transaction B reads account balance = 1000, both compute new balance = 1000 - 500 = 500, and both write balance = 500. The final balance is 500 instead of the correct 0. What is this anomaly called and what isolation level prevents it?",
      "options": ["Phantom read; prevented by REPEATABLE READ", "Lost update; prevented by REPEATABLE READ or SERIALIZABLE, or by using SELECT FOR UPDATE within READ COMMITTED", "Dirty read; prevented by READ COMMITTED", "Non-repeatable read; prevented by SERIALIZABLE only"],
      "correct": 1,
      "explanation": "A lost update occurs when two transactions read the same value, compute an update independently, and the second writer overwrites the first writer's update. REPEATABLE READ prevents lost updates in PostgreSQL because it detects that the row was modified after the transaction's snapshot was taken and raises a serialisation failure. Alternatively, SELECT FOR UPDATE within READ COMMITTED acquires a row lock preventing the second read until the first transaction commits, causing the second transaction to read the updated balance of 500 and correctly produce 0."
    },
    {
      "text": "An engineering team reports that a new payment query runs fine in development but causes production slowdowns. Investigation reveals the query produces N+1 database calls: one query to fetch 100 payments, then one query per payment to fetch the associated merchant. What is the correct fix and why does this pattern specifically harm financial systems?",
      "options": ["Add a database index on merchant_id to make each of the N queries faster", "Replace the N+1 pattern with a JOIN or a batch query (WHERE merchant_id IN (...)) to fetch all merchants in one round trip; in financial systems N+1 under high transaction volume multiplies database load by the page size, turning a 100-row query into 101 database round trips", "Switch to a NoSQL database that handles nested document lookups more efficiently", "Increase the connection pool size to handle the additional queries"],
      "correct": 1,
      "explanation": "N+1 is an ORM anti-pattern where fetching a collection of N entities triggers N additional queries for associated data. For payment systems processing thousands of requests per second, N+1 on a 100-item page produces 101 queries per request. At 1,000 RPS this is 101,000 queries/second instead of 1,000 — a 100x amplification. The fix is JOIN, eager loading (@EntityGraph in JPA), or batch loading with an IN clause. Indexing makes each query slightly faster but does not fix the fundamental amplification."
    },
    {
      "text": "A principal engineer is reviewing a proposed database migration that adds a NOT NULL column with a DEFAULT value to the payments table (500 million rows). The developer plans to run ALTER TABLE payments ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0. What is the production risk and what is the safer approach?",
      "options": ["No risk; PostgreSQL stores DEFAULT values without rewriting the table for NOT NULL columns with a constant default since PostgreSQL 11", "High risk on PostgreSQL < 11: the ALTER TABLE rewrites all 500 million rows, holding an ACCESS EXCLUSIVE lock for hours; on PostgreSQL 11+ with a constant default there is no rewrite, but the approach is still risky if any triggers or replication lag applies", "High risk on all PostgreSQL versions; always use a nullable column first, backfill, then add NOT NULL constraint", "No risk as long as the migration runs during off-hours in a maintenance window"],
      "correct": 0,
      "explanation": "Since PostgreSQL 11, adding a NOT NULL column with a constant default value is a metadata-only operation — PostgreSQL stores the default in the catalog and returns it for existing rows without rewriting the table. The lock duration is milliseconds. This is a significant improvement from earlier versions that required a full table rewrite. However, if the DEFAULT involves a function call (e.g., DEFAULT now()), PostgreSQL still rewrites the table on older versions. The principal engineer should verify the PostgreSQL version and confirm the default is a constant before approving the migration."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Database Architecture Decision and Anti-Pattern Detection Framework",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Implement a DatabaseAntiPatternDetector that queries pg_stat_statements and reports: (a) N+1 candidates: query pairs where one query appears as a strict subset of another and the total call count ratio exceeds 10x, (b) missing index candidates: tables where seq_scan count > 1000 AND seq_tup_read / seq_scan > 10000 from pg_stat_user_tables, (c) long transaction risk: tables with n_dead_tup > 100000 indicating bloat from long transactions. Output a structured JSON report with severity (HIGH/MEDIUM/LOW) for each finding."
    },
    {
      "id": "2",
      "description": "Create a DatabaseDecisionFramework class with a method selectIsolationLevel(TransactionProfile profile) that returns the appropriate PostgreSQL isolation level. The TransactionProfile includes: isFinancialWrite (bool), involvesConcurrentUpdates (bool), requiresPhantomProtection (bool), acceptsHigherLatency (bool). Implement the decision tree: SERIALIZABLE for financial writes with concurrent updates, REPEATABLE READ for reads requiring phantom protection, READ COMMITTED as default. Write tests for all 8 combinations of the boolean flags."
    },
    {
      "id": "3",
      "description": "Write an ArchitectureDecisionRecord (ADR) for the choice between PostgreSQL and CockroachDB for a payment platform processing 50K TPS across 3 geographic regions with a 99.99% availability SLA. The ADR must follow the format: Context, Decision, Rationale, Consequences, Review Triggers. The rationale must include quantified trade-offs: latency impact (Raft consensus overhead), cost ratio (3x for CockroachDB vs PostgreSQL+replicas), and operational expertise requirements. The review triggers must specify concrete metrics that would prompt reconsideration."
    },
    {
      "id": "4",
      "description": "Implement a PrincipalEngineerChecklist bean that runs at application startup and validates: (a) all @Transactional methods on payment-critical services use a non-default isolation level annotation, (b) no repository method is named findAll without a @Query annotation limiting results, (c) all foreign key columns have corresponding indexes (checked via information_schema.table_constraints JOIN pg_indexes), (d) pg_stat_user_tables shows no table with seq_scan > idx_scan * 10 for tables over 10,000 rows. Log a startup WARNING for each violation found."
    }
  ]
}
-->
