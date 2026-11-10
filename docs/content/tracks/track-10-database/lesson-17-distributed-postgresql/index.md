---
id: track-10-lesson-17
title: "Distributed PostgreSQL — Citus and Distributed Queries"
slug: distributed-postgresql
track: track-10
trackName: "Database & Data Architecture"
sequence: 17
difficulty: principal
estimatedMinutes: 85
status: published
tags: [Citus, distributed, co-location, cross-shard, PostgreSQL]
prerequisites: [track-10-lesson-06, track-10-lesson-07]
---

# Distributed PostgreSQL — Citus and Distributed Queries

> [!NOTE]
> Citus extends PostgreSQL into a distributed database without sacrificing the SQL dialect, ACID guarantees, or existing tooling. For payment workloads that have outgrown a single PostgreSQL server's write capacity, Citus is the highest-fidelity scale-out option — before resorting to application-level sharding or migrating to a different database engine.

## 1. Citus Architecture

Citus uses a coordinator-worker topology:

```
Application
    |
    v
Coordinator (single PostgreSQL instance)
    |-- receives queries, creates distributed plans
    |-- metadata: which shard holds which data
    |
    +--------+--------+--------+
    v        v        v        v
Worker-1  Worker-2  Worker-3  Worker-4
(shards)  (shards)  (shards)  (shards)
```

- **Coordinator**: accepts client connections, parses SQL, creates distributed query plans, aggregates results
- **Workers**: store shards of distributed tables, execute partial queries
- **Shard**: a physical PostgreSQL table on a worker, containing a subset of rows

Each distributed table is split into N shards (default 32) distributed across workers.

## 2. Citus Extension Setup

```sql
-- Install on coordinator and all workers
CREATE EXTENSION citus;

-- Add worker nodes to the coordinator
SELECT master_add_node('worker-1.internal', 5432);
SELECT master_add_node('worker-2.internal', 5432);
SELECT master_add_node('worker-3.internal', 5432);
SELECT master_add_node('worker-4.internal', 5432);

-- Verify cluster
SELECT * FROM master_get_active_worker_nodes();
```

## 3. Distribution Column Selection

The distribution column determines which shard a row goes to (via hash). **This is the most critical architectural decision in a Citus deployment.**

Principles for choosing the distribution column:
1. The column appears in most queries' WHERE clauses (enables shard pruning)
2. High cardinality (many distinct values distribute data evenly)
3. Used as the join key between frequently joined tables (enables co-location)
4. Immutable after insert (changing the distribution key requires re-sharding)

```sql
-- For a payment system, account_id is the natural distribution column:
-- - Every transaction has an account_id
-- - Every query filters by account_id
-- - account_id joins transactions to accounts
-- - account_id never changes for a transaction

-- Create distributed transaction table
CREATE TABLE transactions (
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL,
    amount       NUMERIC(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

SELECT create_distributed_table('transactions', 'account_id');
-- Creates 32 shards distributed across 4 workers (8 shards per worker)

-- Create distributed accounts table with SAME distribution column
-- This enables co-location (accounts and transactions for the same account_id
-- live on the same worker shard)
CREATE TABLE accounts (
    id           UUID PRIMARY KEY,
    account_number VARCHAR(20) UNIQUE NOT NULL,
    balance      NUMERIC(19,4) NOT NULL DEFAULT 0,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL
);

SELECT create_distributed_table('accounts', 'id');
-- accounts distributed on 'id' column, transactions on 'account_id'
-- Both are the same logical concept -> they will be co-located
```

## 4. Table Co-location

Co-location ensures that rows from multiple tables with the same distribution key value land on the same shard/worker. This enables joins without network round-trips between workers.

```sql
-- Verify co-location
SELECT logicalrelid, colocationid
FROM pg_dist_partition
WHERE logicalrelid IN ('transactions'::regclass, 'accounts'::regclass);
-- Both should have the same colocationid

-- Query that benefits from co-location (join happens on same worker)
EXPLAIN SELECT t.id, t.amount, a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.account_id = 'acct-001';

-- Coordinator plan output:
-- Custom Scan (Citus Adaptive)  (cost=0.00..0.00 rows=0 width=0)
--   Task Count: 1              <- only 1 shard queried! shard pruning works
--   Tasks Shown: One of 1
--   ->  Task
--         Node: host=worker-2 port=5432 dbname=payments
--         ->  Index Scan on transactions_102345 t
--               Index Cond: (account_id = 'acct-001')
--               ->  Hash Join
--                     Hash Cond: (t.account_id = a.id)
--                     ->  Seq Scan on accounts_102346 a
-- The join happens entirely on worker-2 — no cross-node data movement
```

## 5. Distributed Transactions — Limitations

Citus supports 2-phase commit (2PC) for distributed transactions, but with important caveats:

```sql
-- Single-shard transactions: fully ACID, same as regular PostgreSQL
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 'acct-001';
INSERT INTO transactions (account_id, amount, ...) VALUES ('acct-001', 100, ...);
COMMIT;
-- Both rows go to the same shard (co-located) -> single-node ACID

-- Cross-shard transactions: 2PC (slower, more failure modes)
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 'acct-001'; -- shard A
UPDATE accounts SET balance = balance + 100 WHERE id = 'acct-999'; -- shard B
INSERT INTO transactions (account_id, amount, ...) VALUES ('acct-001', -100, ...);
INSERT INTO transactions (account_id, amount, ...) VALUES ('acct-999',  100, ...);
COMMIT;
-- This requires 2PC across shards:
-- 1. Coordinator sends PREPARE TRANSACTION to both workers
-- 2. Both workers prepare (write to WAL, hold locks)
-- 3. Coordinator sends COMMIT PREPARED
-- If coordinator crashes between steps 2 and 3: orphaned prepared transactions
-- Must be resolved manually: SELECT recover_prepared_transactions();
```

**Design principle**: Structure your data model so that most transactions touch a single shard. For payment transfers between accounts, use a saga or ledger pattern that makes individual writes idempotent rather than requiring 2PC across shards.

## 6. Reference Tables — Small Lookup Data

Reference tables are replicated to all workers, enabling local joins without cross-shard queries.

```sql
-- Currency table: small, rarely changes, used in joins everywhere
CREATE TABLE currencies (
    code        CHAR(3) PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    decimal_places INT NOT NULL
);

-- Make it a reference table: replicated to all workers
SELECT create_reference_table('currencies');

-- Now this join is local on each worker (no cross-node query):
SELECT t.id, t.amount, c.name AS currency_name
FROM transactions t
JOIN currencies c ON t.currency = c.code
WHERE t.account_id = 'acct-001';
```

Other candidates for reference tables in a payment system:
- `countries` — country codes, regions
- `fee_schedules` — fee tier configurations
- `payment_method_types` — card type definitions
- `bank_codes` — routing numbers, BIC codes

## 7. Real-Time Aggregation on Distributed Data

```sql
-- SUM across all shards: Citus parallelizes across workers
-- Workers compute partial aggregates, coordinator combines
EXPLAIN
SELECT
    DATE_TRUNC('hour', created_at) AS hour,
    currency,
    COUNT(*) AS transaction_count,
    SUM(amount) AS total_amount
FROM transactions
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY hour, currency
ORDER BY hour DESC;

-- Plan shows:
-- Custom Scan (Citus Adaptive)
--   Task Count: 32  <- all shards queried in parallel
--   ->  Partial GroupAggregate (on each worker)
--         ->  Seq Scan on transactions_XXXXX (partition pruned by date)

-- Performance: 4 workers * 8 shards each = 32 parallel partial aggregates
-- Then coordinator combines 32 partial results
-- Wall time ≈ single-shard time (not 32x sequential)
```

## 8. Citus for High-Write Payment Workloads

```sql
-- Write throughput comparison

-- Single PostgreSQL (1 writer):
-- INSERT throughput: ~10,000 TPS (NVMe SSD, WAL bottleneck)

-- Citus (4 workers, 32 shards):
-- INSERT throughput: ~35,000-40,000 TPS (shards distribute WAL across workers)
-- Linear scaling is not achieved due to coordinator overhead,
-- but 3-4x improvement is typical

-- Check shard distribution balance
SELECT
    worker_node,
    COUNT(*) AS shard_count,
    SUM(shard_size) AS total_bytes
FROM (
    SELECT
        nodename AS worker_node,
        shardid,
        result::bigint AS shard_size
    FROM run_command_on_shards(
        'transactions',
        'SELECT pg_relation_size(%s)'
    )
    JOIN pg_dist_shard_placement USING (shardid)
) sub
GROUP BY worker_node
ORDER BY worker_node;
```

## 9. Comparison with Application-Level Sharding

| Dimension | Citus | Application-Level Sharding |
|---|---|---|
| Transparency | Fully transparent — standard SQL | Application must route queries manually |
| Cross-shard queries | Handled automatically (2PC/routing) | Application must federate |
| Schema changes | Standard DDL (replicated) | Must apply to all shards manually |
| Rebalancing | `rebalance_table_shards()` | Custom ETL required |
| Operational complexity | Medium (Citus expertise) | High (custom sharding logic) |
| Join support | Full (within co-location group) | Limited (must join in application) |
| Learning curve | Medium (SQL expertise + Citus) | High (custom distributed systems) |
| Write throughput | 3-5x vs single node | Near-linear with more shards |

```java
// Application-level sharding: routing logic must be in the application
@Service
public class ShardedTransactionRepository {

    private final Map<Integer, JdbcTemplate> shardTemplates;

    private int getShard(UUID accountId) {
        return Math.abs(accountId.hashCode()) % shardTemplates.size();
    }

    public Transaction save(Transaction transaction) {
        int shard = getShard(transaction.getAccountId());
        JdbcTemplate jdbc = shardTemplates.get(shard);
        // ... execute on correct shard
    }

    public List<Transaction> findByAccount(UUID accountId) {
        int shard = getShard(accountId);
        JdbcTemplate jdbc = shardTemplates.get(shard);
        // ... query correct shard
    }

    // Cross-shard query: must fan out to all shards
    public List<Transaction> findByDateRange(Instant from, Instant to) {
        return shardTemplates.values().parallelStream()
            .flatMap(jdbc -> jdbc.query(...).stream())
            .sorted(Comparator.comparing(Transaction::getCreatedAt))
            .collect(Collectors.toList());
        // Complex, slow, error-prone: Citus handles this automatically
    }
}
```

**When to choose application-level sharding over Citus**:
- When shard count needs to exceed what Citus supports (thousands of shards)
- When different shards need entirely different schemas (multi-tenant isolation)
- When shard placement needs fine-grained control (geo-residency enforcement)
- When the team already has application-sharding expertise and infrastructure

## 10. Cloud-Managed Citus — Azure Cosmos DB for PostgreSQL

```yaml
# terraform/azure-cosmos-postgres.tf
resource "azurerm_cosmosdb_postgresql_cluster" "payments" {
  name                = "payments-distributed"
  resource_group_name = var.resource_group_name
  location            = var.location

  administrator_login_password = var.db_admin_password

  coordinator_storage_quota_in_mb = 524288   # 512GB coordinator
  coordinator_vcore_count         = 4
  coordinator_server_edition      = "GeneralPurpose"

  node_count              = 4
  node_storage_quota_in_mb = 524288    # 512GB per worker
  node_vcores             = 8
  node_server_edition     = "MemoryOptimized"

  citus_version = "12.1"
  postgresql_version = "16"

  ha_enabled = true

  tags = {
    environment = "production"
    team        = "payments-infrastructure"
  }
}
```

Azure Cosmos DB for PostgreSQL (formerly Azure Database for PostgreSQL - Hyperscale) provides managed Citus with:
- Automated backups and PITR
- High availability with standby replicas
- Automated minor version updates
- Built-in monitoring in Azure Monitor

## 11. When Citus Makes Sense in Fintech

Decision criteria for adopting Citus:

```
Choose Citus when:
  - Single PostgreSQL server write throughput is saturated (> 10,000 TPS writes)
  - Data volume exceeds single-server storage (> 10TB of hot data)
  - Team has strong PostgreSQL expertise
  - Queries are predominantly account-scoped (shard pruning works well)
  - Regulatory requirements allow distributed storage within a jurisdiction

Do NOT choose Citus when:
  - Throughput problem is actually a query optimization problem (try indexes first)
  - Workload is primarily analytical (consider read replicas + columnar storage)
  - Cross-shard queries are frequent (application-level sharding or NewSQL)
  - Team lacks distributed systems operational experience
  - Data volume is manageable on a single server with partitioning
```

> [!WARNING]
> The distribution column in Citus is immutable for the lifetime of the distributed table. Changing it requires re-distributing all data, which is a significant operational event. Spend considerable time validating the distribution column choice with realistic query patterns before creating distributed tables in production. A wrong choice costs weeks of re-sharding work.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A Citus cluster distributes the transactions table on account_id. A query filters only by created_at (no account_id predicate). How does Citus execute this query?",
      "options": [
        "Citus uses the created_at index on each shard in parallel, making it as fast as a single-node query",
        "Citus fans the query out to all 32 shards (or however many exist), executes it on each in parallel, and aggregates results at the coordinator — no shard pruning is possible without the distribution column in the predicate",
        "Citus routes the query to the first shard and returns results, as shards are identical copies",
        "Citus rejects the query because cross-shard queries without the distribution column are not supported"
      ],
      "correct": 1,
      "explanation": "Shard pruning — the key performance benefit of Citus — only works when the distribution column appears in the WHERE clause. Without account_id in the predicate, Citus cannot determine which shard(s) contain the relevant rows and must fan the query out to all shards. This is expensive for point-in-time queries but can still be fast for aggregations because all shards execute in parallel. This is why choosing a distribution column that appears in most WHERE clauses is the most critical architectural decision in a Citus deployment."
    },
    {
      "text": "In Citus, what is the purpose of co-location, and what must be true for two distributed tables to be co-located?",
      "options": [
        "Co-location means tables are stored on the same physical server; both tables must have the same number of rows",
        "Co-location means rows with the same distribution key value from multiple tables are stored on the same shard/worker; achieved by distributing both tables on logically equivalent columns (e.g., accounts on 'id' and transactions on 'account_id')",
        "Co-location means tables are always joined at the coordinator; no special setup is required",
        "Co-location is only for reference tables that are replicated to all workers"
      ],
      "correct": 1,
      "explanation": "Co-location ensures that for a given distribution key value (e.g., account_id = 'acct-001'), the accounts row and all transactions rows for that account live on the same shard on the same worker. This enables the JOIN to execute entirely on one worker without cross-node network round trips. To co-locate, both tables must be distributed on the same logical concept (here: the account identifier), and Citus assigns them the same colocationid in pg_dist_partition. Without co-location, a JOIN fans out to all workers and aggregates at the coordinator."
    },
    {
      "text": "When should you choose Citus over application-level sharding for a payment platform?",
      "options": [
        "Always — Citus is strictly better in every dimension than application-level sharding",
        "When write throughput exceeds single PostgreSQL capacity (> 10,000 TPS writes), queries are predominantly account-scoped enabling shard pruning, and the team has PostgreSQL expertise but wants to maintain standard SQL without custom routing logic in the application",
        "Only when storing more than 10TB of data, regardless of query patterns or write throughput",
        "When geo-residency requires specific rows to live in specific data centers — Citus handles this automatically"
      ],
      "correct": 1,
      "explanation": "Citus is the right choice when: (1) you have outgrown single-node PostgreSQL write capacity, (2) your query patterns are account-scoped so shard pruning works, and (3) you want to avoid baking sharding logic into every service. Application-level sharding is preferable when you need thousands of shards, per-tenant schema isolation, fine-grained geo-placement, or when the team already has application sharding infrastructure. The key advantage of Citus is transparency — standard SQL works without change, and cross-shard queries (while slower) are handled automatically."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Citus Distribution Strategy for Payment Workloads",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Design the distribution strategy for a payment platform with these tables: accounts, transactions, ledger_entries, settlement_batches, and fee_schedules. For each table, choose between: distributed (and on which column), reference table, or local table. Justify each choice with reference to: query patterns, join requirements, write frequency, and data size. Identify any cross-shard join risks in your design."},
    {"id": "2", "description": "Using a local Citus cluster (Docker Compose with 1 coordinator + 2 workers), demonstrate shard pruning: insert 1,000,000 transaction rows distributed on account_id. Run EXPLAIN on a query with an account_id predicate and verify 'Task Count: 1' (single shard). Run EXPLAIN on a query without account_id and verify all shards are queried. Measure the latency difference between the two query patterns."},
    {"id": "3", "description": "Implement a cross-shard money transfer using the saga pattern instead of 2PC. The saga should: (1) debit the source account, (2) publish a TransferInitiated event, (3) credit the destination account, (4) publish a TransferCompleted event. Implement the compensating transaction for each step. Write a test that simulates a failure between steps 2 and 3 and verifies the saga correctly compensates by reversing the debit."},
    {"id": "4", "description": "Benchmark the Citus cluster write throughput against a single PostgreSQL instance using a custom pgbench script that simulates payment debits on the transactions table. Record TPS at 50, 100, and 200 concurrent clients for both configurations. Document the crossover point where Citus outperforms single-node PostgreSQL, and identify any latency regression introduced by the Citus coordinator overhead."}
  ]
}
-->
