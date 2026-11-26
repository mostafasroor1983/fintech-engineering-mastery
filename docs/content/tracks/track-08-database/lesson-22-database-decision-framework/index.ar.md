---
id: track-08-lesson-22
title: "إطار المهندس الرئيسي لقرارات قواعد البيانات"
slug: database-decision-framework
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 22
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, database, trade-offs, staff-engineer, selection]
prerequisites: [track-08-lesson-21]
---

# إطار قرارات قواعد البيانات للمهندس الرئيسي

> [!NOTE]
> أكلف خطأ في قواعد البيانات اختيار قاعدة البيانات الخطأ قبل أن تفهم حملك. وثاني أكلف خطأ البقاء مع قاعدة البيانات الخطأ مدة أطول من اللازم بعد أن يتطور الحمل. ودور المهندس الرئيسي إرساء معايير القرار، وفرض التقييم المقاس، ومنع التحسين المبكر والترحيل المبكر كليهما.

## 1. إطار اختيار قاعدة البيانات للخدمات المالية

يجب أن تتبع عملية الاختيار هذا التسلسل:
1. **قِس المشكلة** (لا تخمّن المتطلبات)
2. **استنفد تحسينات قاعدة البيانات الحالية** قبل التبديل
3. **ابنِ نموذجًا أوليًا ببيانات واقعية** (لا أمثلة لعبة)
4. **احسب الكلفة الإجمالية للملكية (TCO)** (الكلفة التشغيلية + الكلفة الهندسية + المخاطر)
5. **قرّر بمعايير صريحة** (اكتبها)

### شجرة القرار: SQL مقابل NoSQL مقابل NewSQL

```
Step 1: Do you need ACID transactions?
  YES -> Stay in SQL family (PostgreSQL, MySQL, CockroachDB, Spanner)
  NO  -> NoSQL may be appropriate (Cassandra for time-series, Redis for cache)
         (Note: very few financial use cases can safely use eventual consistency)

Step 2: What is your WRITE throughput requirement? (rough guides)
  < 10,000 TPS    -> Single PostgreSQL with optimized indexes
  10K-30K TPS     -> Tuned single primary: bigger hardware, batching,
                     partitioning, connection pooling
                     (read replicas only offload READS, not writes)
  30K-100K TPS    -> Citus (distributed PostgreSQL) or app-level sharding
  > 100K TPS      -> Citus at scale, CockroachDB or Spanner
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

## 2. دليل اختيار مستوى العزل

يحدد مستوى العزل الشذوذات الممكنة. ويجب أن تكون الأنظمة المالية صريحة في هذا.

```sql
-- PostgreSQL isolation levels (from weakest to strongest)
-- (READ UNCOMMITTED is accepted but behaves like READ COMMITTED)

-- READ COMMITTED (PostgreSQL default):
-- Each STATEMENT sees data committed before it started (not the transaction)
-- Anomalies possible: non-repeatable reads, phantoms, lost updates for
--   read-then-write code
-- Safe for writes when the write itself is atomic or locked:
--   UPDATE accounts SET balance = balance - 500 WHERE id = ? AND balance >= 500
--   or SELECT ... FOR UPDATE before the read-compute-write
-- Use for: most OLTP code WITH explicit row locks / atomic updates, reads

-- REPEATABLE READ (snapshot isolation in PostgreSQL):
-- The whole transaction sees one snapshot taken at its first statement
-- Prevents non-repeatable reads AND phantoms (stronger than the SQL standard)
-- A concurrent update of a row you modify -> serialization failure (retry)
-- Still allows WRITE SKEW (two transactions each read, then write
--   different rows based on what they read)
-- Use for: consistent multi-statement reads (reports, exports)

-- SERIALIZABLE (Serializable Snapshot Isolation):
-- Transactions behave as if run one at a time -- no anomalies
-- Cost: no extra blocking, but serialization failures (SQLSTATE 40001)
--   under contention -> every transaction needs a retry loop
-- Use for: complex invariants spanning several rows/tables (write skew
--   risks) where explicit locking is hard to get right
```

```java
// Isolation level selection in Spring
@Service
public class PaymentService {

    // Financial write with a multi-row invariant: SERIALIZABLE -- the
    // CALLER must retry on ConcurrencyFailureException (SQLSTATE 40001).
    // Alternative: READ COMMITTED + SELECT ... FOR UPDATE / atomic updates.
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void processPayment(PaymentRequest request) {
        // balance check + debit + transaction insert
    }

    // Idempotency pre-check: READ_COMMITTED is sufficient -- the real
    // guarantee is a UNIQUE constraint on the idempotency key at insert
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

## 3. إطار قرار استراتيجية الفهرسة

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
      (check replicas too: an index used only by replica queries shows 0
       scans on the primary)
   -> Drop unused indexes (DROP INDEX CONCURRENTLY)
```

```sql
-- Index decision checklist query
-- Run after 2+ weeks in production to identify unused indexes.
-- (pg_stat_user_indexes columns are relname / indexrelname; counters run
--  since the last statistics reset, which survives restarts since PG15)

SELECT
    s.schemaname,
    s.relname       AS table_name,
    s.indexrelname  AS index_name,
    pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
    s.idx_scan      AS scans_since_stats_reset,
    CASE
        WHEN s.idx_scan = 0 THEN 'UNUSED - consider dropping'
        WHEN s.idx_scan < 100 THEN 'RARELY USED - review'
        ELSE 'ACTIVE'
    END AS recommendation
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE NOT i.indisprimary
  AND NOT i.indisunique          -- unique indexes enforce rules even if unused
ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC
LIMIT 30;
```

## 4. متى تقسّم الجداول

```
Partition when:
  - Table size exceeds 100GB (without partitioning, VACUUM becomes slow)
  - Query patterns consistently filter by a date range (partition by date)
  - Archival strategy requires removing old data (detach + drop partition)
  - Hot indexes/tables need smaller units for maintenance (VACUUM, REINDEX)
    -- note: partitioning does NOT spread WAL; one server has one WAL stream

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

## 5. اختيار استراتيجية الأرشفة

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

## 6. التحجيم الصحيح لمجمع الاتصالات

```
Starting point (PostgreSQL wiki / HikariCP "About Pool Sizing"):
  useful ACTIVE connections = (DATABASE server cores * 2) + effective_spindles
  -- a TOTAL for all clients together, not a per-application-instance number

Example: DB server with 16 cores, NVMe (count as ~1 spindle) -> ~33

With PgBouncer (transaction mode):
  default_pool_size     ~ 30-35   (server connections per db/user pair)
  max_db_connections    ~ 40      (hard cap towards PostgreSQL)
  max_connections (PG)  = 40 + ~20 for ops/admin/monitoring = 60
  App pools: 10 instances * 10 = 100 client connections
  max_client_conn       >= 100 (+ headroom for deploys/scale-out)

Without PgBouncer:
  per-instance pool ~ 33 / 10 instances = 3-4

Per-instance check with Little's law:
  connections busy = transactions per second * seconds each one holds a
  connection (e.g. 400/s * 0.010 s = 4), plus headroom -- then load test

Changing max_connections requires a RESTART (pg_reload_conf is not enough):
  ALTER SYSTEM SET max_connections = 60;   -- then restart PostgreSQL
```

```java
// Self-documenting pool configuration: the size is DERIVED from measured
// numbers (Little's law), so the reasoning is visible in code review
@Configuration
public class DatabasePoolConfig {

    private static final double PEAK_TX_PER_SECOND   = 400;    // per instance, measured
    private static final double AVG_HOLD_SECONDS     = 0.010;  // 10 ms per transaction
    private static final double HEADROOM             = 2.0;    // bursts, slow periods
    private static final int    POOL_SIZE =
        (int) Math.ceil(PEAK_TX_PER_SECOND * AVG_HOLD_SECONDS * HEADROOM);  // = 8

    @Bean
    public HikariDataSource dataSource(DataSourceProperties props) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(props.getUrl());
        config.setUsername(props.getUsername());
        config.setPassword(props.getPassword());
        config.setMaximumPoolSize(POOL_SIZE);
        config.setMinimumIdle(POOL_SIZE);          // fixed-size pool (HikariCP advice)
        config.setPoolName("payments-pool-" + POOL_SIZE);
        return new HikariDataSource(config);
    }
}
```

## 7. أنماط استخدام نسخ القراءة

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

Replication lag monitoring (on the replica; this grows while the primary
is idle, so pair it with a heartbeat write or LSN comparison -- Lesson 08):
  SELECT NOW() - pg_last_xact_replay_timestamp() AS replication_lag;
  -- Alert if lag > 5 seconds for payment-related replicas
  -- Alert if lag > 60 seconds for reporting replicas
```

```java
@Configuration
public class RoutingDataSourceConfig {

    @Bean
    @Primary
    public DataSource dataSource(
            @Qualifier("primary") DataSource primary,
            @Qualifier("replica") DataSource replica) {
        AbstractRoutingDataSource routing = new AbstractRoutingDataSource() {
            @Override
            protected Object determineCurrentLookupKey() {
                return TransactionSynchronizationManager.isCurrentTransactionReadOnly()
                    ? "replica"
                    : "primary";
            }
        };
        routing.setTargetDataSources(Map.of("primary", primary, "replica", replica));
        routing.setDefaultTargetDataSource(primary);
        routing.afterPropertiesSet();   // not a bean itself -> call it explicitly

        // The lazy proxy fetches the real connection only at the first
        // statement -- by then the transaction's read-only flag is set.
        // Without it, JPA grabs the connection at transaction start and the
        // lookup key is decided too early.
        return new LazyConnectionDataSourceProxy(routing);
    }
}
```

## 8. الأنماط المضادة الشائعة لقواعد البيانات في التقنية المالية

### النمط المضاد 1: استعلامات N+1 من ORM

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

// CORRECT: Single query with JOIN (native SQL: LATERAL is not JPQL)
@Query(nativeQuery = true, value = """
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

### النمط المضاد 2: فهارس مفقودة على المفاتيح الأجنبية

```sql
-- PostgreSQL does NOT automatically index foreign key columns
-- (inserts into the child check the PARENT's primary key index -- that is
--  fine; the problem is the other direction)

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

-- Detection query: foreign keys whose columns are not the LEADING columns
-- of any index (an index where the FK column comes second does not help;
-- also handles multi-column FKs and schemas)
SELECT
    c.conrelid::regclass   AS table_name,
    c.conname              AS fk_name,
    pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = c.conrelid
      -- first N index columns (indkey is 0-based) contain the N FK columns
      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
  );
```

### النمط المضاد 3: الإفراط في التطبيع

```sql
-- WRONG: surrogate integer key for a stable code -> a JOIN everywhere
CREATE TABLE currencies (
    id          SERIAL PRIMARY KEY,
    code        CHAR(3) UNIQUE NOT NULL,
    minor_units SMALLINT NOT NULL
);

CREATE TABLE transactions (
    id          UUID PRIMARY KEY,
    currency_id INT NOT NULL REFERENCES currencies(id)
);
-- Every query that shows 'EUR' must JOIN currencies just to turn 7 into
-- 'EUR'; every insert must look the id up first

-- CORRECT: use the natural code as the key -- no JOIN for display, and
-- the foreign key still guarantees only known currencies are stored
CREATE TABLE currencies (
    code        CHAR(3) PRIMARY KEY,           -- ISO 4217
    minor_units SMALLINT NOT NULL              -- JPY 0, EUR 2, KWD 3
);

CREATE TABLE transactions (
    id       UUID PRIMARY KEY,
    currency CHAR(3) NOT NULL REFERENCES currencies(code)
);
-- Join to currencies only when you need its metadata (e.g. minor units).
-- Prefer this FK over a hard-coded CHECK (currency IN (...)): ISO codes do
-- change (e.g. HRK was replaced by EUR in 2023), and adding a row is
-- easier than re-validating a CHECK constraint on a huge table.
```

### النمط المضاد 4: ‏SELECT * في المسارات الساخنة

```java
// WRONG: loading all 50 columns when only 5 are needed
@Query(nativeQuery = true,
       value = "SELECT * FROM transactions WHERE account_id = :id ORDER BY created_at DESC LIMIT 50")
List<Transaction> findRecent(@Param("id") UUID accountId);

// CORRECT: project only needed columns (into an interface projection)
@Query(nativeQuery = true, value = """
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

### النمط المضاد 5: معاملات طويلة تمسك الأقفال

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

## 9. قائمة تحقق قواعد البيانات للمهندس الرئيسي

لأي تصميم قاعدة بيانات جديد أو تعديل كبير، تحقق من:

```
Schema design:
[ ] All foreign keys have indexes
[ ] Primary key type chosen deliberately: BIGINT identity, or UUID
    (prefer time-ordered UUIDv7 for index locality) when ids are generated
    outside the database or across shards
[ ] Timestamps use TIMESTAMPTZ (not TIMESTAMP without timezone)
[ ] Monetary amounts use NUMERIC(19,4) or integer minor units (never FLOAT/DOUBLE)
[ ] Status columns use VARCHAR with CHECK constraint (not unconstrained text)

Query patterns:
[ ] Top 5 queries by frequency have appropriate indexes
[ ] No SELECT * in hot paths
[ ] No N+1 patterns (verify with New Relic or query log analysis)
[ ] All queries against large tables include the partition key

Transactions:
[ ] Every financial write has an explicit concurrency strategy:
    SERIALIZABLE + retry loop, or row locks / atomic conditional updates
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
[ ] Index bloat monitored; REINDEX CONCURRENTLY when needed

Governance:
[ ] All schema changes use expand-contract pattern
[ ] All DDL migrations tested with Testcontainers
[ ] Rollback scripts exist for every migration
[ ] Performance baseline recorded before optimizations
[ ] Database decision documented in ADR (Architecture Decision Record)
```

## 10. الخلاصة — تفويض المهندس الرئيسي

لا يكتب المهندس الرئيسي معظم SQL — بل يرسي المعايير التي تمنع الأخطاء الشائعة، ويصعّد النقاشات التي تحتاج تصعيدًا.

**معايير يجب إرساؤها**:
1. استراتيجية تزامن صريحة ومراجَعة لكل كتابة مالية (SERIALIZABLE مع إعادة المحاولة، أو أقفال الصفوف / التحديثات الذرية المشروطة) — غير قابلة للتفاوض
2. مراجعة EXPLAIN ANALYZE مطلوبة قبل دمج أي استعلام جديد على جدول كبير
3. خط أساس للأداء في CI — التراجعات تُفشل البناء
4. اختبار استعادة النسخ الاحتياطية كل ربع سنة — مجدول، لا اختياري
5. سجلات قرارات معمارية لقواعد البيانات — كل اختيار مهم موثّق

**نقاشات يجب إطلاقها**:
- "هل قسنا TPS الفعلي قبل اقتراح ترحيل قاعدة البيانات؟"
- "ما أسوأ عاقبة لتقديم بيانات قديمة هنا؟"
- "ماذا يحدث لتطبيقنا حين تكون قاعدة البيانات هذه غير متاحة لمدة 5 دقائق؟"
- "ما هدف زمن الاستعادة لدينا، وهل اختبرنا تحقيقه؟"

> [!NOTE]
> أثمن مهارة قواعد بيانات للمهندس الرئيسي ليست معرفة كل معامل إعداد في PostgreSQL. بل معرفة متى تكون قاعدة البيانات هي الاختناق ومتى لا تكون. فمعظم مشكلات أداء التطبيقات ليست مشكلات قاعدة بيانات — بل مشكلات شيفرة (N+1، وفهارس مفقودة، وخوارزميات غير فعالة) تظهر في مقاييس قاعدة البيانات. فدرّب فريقك على تمييز الفرق قبل اللجوء إلى تقنية قاعدة بيانات جديدة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تستخدم خدمة دفع عزل READ COMMITTED. وتعمل معاملتان بالتزامن: تقرأ المعاملة A رصيد الحساب = 1000، وتقرأ المعاملة B رصيد الحساب = 1000، وتحسب كلتاهما الرصيد الجديد = 1000 - 500 = 500، وتكتب كلتاهما الرصيد = 500. فيكون الرصيد النهائي 500 بدل القيمة الصحيحة 0. ما اسم هذا الشذوذ وأي مستوى عزل يمنعه؟",
      "options": ["قراءة شبحية؛ يمنعها REPEATABLE READ", "تحديث مفقود؛ يمنعه REPEATABLE READ أو SERIALIZABLE، أو استخدام SELECT FOR UPDATE ضمن READ COMMITTED", "قراءة قذرة؛ يمنعها READ COMMITTED", "قراءة غير قابلة للتكرار؛ يمنعها SERIALIZABLE فقط"],
      "correct": 1,
      "explanation": "يحدث التحديث المفقود حين تقرأ معاملتان القيمة نفسها، وتحسب كل منهما تحديثًا باستقلال، ويستبدل الكاتب الثاني تحديث الكاتب الأول. ويمنع REPEATABLE READ التحديثات المفقودة في PostgreSQL لأنه يكتشف أن الصف عُدّل بعد أخذ لقطة المعاملة ويرفع فشل تسلسل. وبديلًا، يأخذ SELECT FOR UPDATE ضمن READ COMMITTED قفل صف يمنع القراءة الثانية حتى تلتزم المعاملة الأولى، فتقرأ المعاملة الثانية الرصيد المحدّث 500 وتنتج 0 بشكل صحيح."
    },
    {
      "text": "يُبلغ فريق هندسي أن استعلام دفع جديدًا يعمل جيدًا في التطوير لكنه يسبب تباطؤًا في الإنتاج. ويكشف التحقيق أن الاستعلام ينتج استدعاءات N+1 لقاعدة البيانات: استعلام واحد لجلب 100 دفعة، ثم استعلام لكل دفعة لجلب التاجر المرتبط. ما الإصلاح الصحيح ولماذا يضر هذا النمط الأنظمة المالية تحديدًا؟",
      "options": ["أضف فهرس قاعدة بيانات على merchant_id لجعل كل استعلام من الـ N أسرع", "استبدل نمط N+1 بـ JOIN أو استعلام دفعي (WHERE merchant_id IN (...)) لجلب كل التجار في جولة واحدة؛ ففي الأنظمة المالية تحت حجم معاملات عالٍ يضاعف N+1 حمل قاعدة البيانات بحجم الصفحة، فيحول استعلام 100 صف إلى 101 جولة لقاعدة البيانات", "انتقل إلى قاعدة بيانات NoSQL تتعامل مع البحث في المستندات المتداخلة بفعالية أكبر", "زِد حجم مجمع الاتصالات للتعامل مع الاستعلامات الإضافية"],
      "correct": 1,
      "explanation": "‏N+1 نمط مضاد في ORM حيث يطلق جلب مجموعة من N كيان N استعلامًا إضافيًا للبيانات المرتبطة. ولأنظمة الدفع التي تعالج آلاف الطلبات في الثانية، ينتج N+1 على صفحة من 100 عنصر 101 استعلام لكل طلب. وعند 1,000 طلب في الثانية يصبح هذا 101,000 استعلام في الثانية بدل 1,000 — تضخيم بمئة ضعف. والإصلاح JOIN، أو التحميل المسبق (@EntityGraph في JPA)، أو التحميل الدفعي بعبارة IN. والفهرسة تجعل كل استعلام أسرع قليلًا لكنها لا تصلح التضخيم الجوهري."
    },
    {
      "text": "يراجع مهندس رئيسي ترحيل قاعدة بيانات مقترحًا يضيف عمود NOT NULL بقيمة DEFAULT إلى جدول payments ‏(500 مليون صف). ويخطط المطوّر لتشغيل ALTER TABLE payments ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0. ما خطر الإنتاج وما النهج الأكثر أمانًا؟",
      "options": ["لا خطر؛ يخزن PostgreSQL قيم DEFAULT دون إعادة كتابة الجدول لأعمدة NOT NULL ذات القيمة الافتراضية الثابتة منذ PostgreSQL 11", "خطر عالٍ على PostgreSQL < 11: يعيد ALTER TABLE كتابة الـ 500 مليون صف كلها، ممسكًا بقفل ACCESS EXCLUSIVE لساعات؛ وعلى PostgreSQL 11+ مع قيمة ثابتة لا إعادة كتابة، لكن النهج يبقى خطرًا إن انطبقت أي مشغّلات أو تأخر نسخ", "خطر عالٍ على كل إصدارات PostgreSQL؛ استخدم دائمًا عمودًا قابلًا لـ NULL أولًا، ثم املأه رجعيًا، ثم أضف قيد NOT NULL", "لا خطر ما دام الترحيل يعمل خارج ساعات العمل في نافذة صيانة"],
      "correct": 0,
      "explanation": "منذ PostgreSQL 11، إضافة عمود بقيمة افتراضية غير متقلبة (ثابت، أو تعبير مستقر مثل now() يُقيّم مرة واحدة) عملية على البيانات الوصفية فقط — يخزن PostgreSQL القيمة الافتراضية في الكتالوج ويعيدها للصفوف القائمة دون إعادة كتابة الجدول. وفقط القيمة الافتراضية المتقلبة (random()، وclock_timestamp()، وgen_random_uuid()) ما زالت تفرض إعادة كتابة كاملة. وما زالت العبارة تحتاج قفل ACCESS EXCLUSIVE قصيرًا، فشغّلها مع lock_timeout قصير لتجنب الاصطفاف خلف معاملات طويلة. ويجب أن يتأكد المهندس الرئيسي من إصدار PostgreSQL ومن أن القيمة الافتراضية ليست متقلبة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء إطار لقرارات بنية قواعد البيانات وكشف الأنماط المضادة",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "نفّذ DatabaseAntiPatternDetector يستعلم pg_stat_statements ويُبلغ عن: (أ) مرشحي N+1: أزواج استعلامات يظهر أحدها كمجموعة فرعية صارمة من الآخر وتتجاوز نسبة إجمالي الاستدعاءات 10 أضعاف، (ب) مرشحي الفهارس المفقودة: جداول فيها seq_scan > 1000 وseq_tup_read / seq_scan > 10000 من pg_stat_user_tables، (ج) خطر المعاملات الطويلة: جداول فيها n_dead_tup > 100000 تدل على انتفاخ من معاملات طويلة. وأخرج تقرير JSON مهيكلًا بدرجة خطورة (HIGH/MEDIUM/LOW) لكل نتيجة."
    },
    {
      "id": "2",
      "description": "أنشئ صنف DatabaseDecisionFramework بدالة selectIsolationLevel(TransactionProfile profile) تعيد مستوى العزل المناسب في PostgreSQL. ويتضمن TransactionProfile: isFinancialWrite ‏(bool)، وinvolvesConcurrentUpdates ‏(bool)، وrequiresPhantomProtection ‏(bool)، وacceptsHigherLatency ‏(bool). ونفّذ شجرة القرار: SERIALIZABLE للكتابات المالية مع تحديثات متزامنة، وREPEATABLE READ للقراءات التي تحتاج حماية من الشبحيات، وREAD COMMITTED افتراضيًا. واكتب اختبارات لكل التركيبات الـ 16 للأعلام المنطقية الأربعة."
    },
    {
      "id": "3",
      "description": "اكتب سجل قرار معماري (ADR) للاختيار بين PostgreSQL وCockroachDB لمنصة دفع تعالج 50K TPS عبر 3 مناطق جغرافية مع اتفاقية مستوى خدمة لتوفر 99.99%. ويجب أن يتبع ADR الصيغة: السياق، والقرار، والمبررات، والعواقب، ومحفزات المراجعة. ويجب أن تتضمن المبررات مفاضلات مقاسة: أثر الزمن (عبء إجماع Raft)، ونسبة الكلفة (3 أضعاف لـ CockroachDB مقابل PostgreSQL مع النسخ)، ومتطلبات الخبرة التشغيلية. ويجب أن تحدد محفزات المراجعة مقاييس ملموسة تدفع إلى إعادة النظر."
    },
    {
      "id": "4",
      "description": "نفّذ مكوّن PrincipalEngineerChecklist يعمل عند بدء التطبيق ويتحقق من: (أ) أن كل دوال @Transactional في الخدمات الحرجة للدفع تعلن مستوى عزل صريحًا أو موسومة باستراتيجية قفل موثقة، (ب) عدم تسمية أي دالة مستودع findAll دون تعليق @Query يحد النتائج، (ج) أن لكل أعمدة المفاتيح الأجنبية فهارس مقابلة (يُفحص عبر information_schema.table_constraints JOIN pg_indexes)، (د) أن pg_stat_user_tables لا يُظهر أي جدول فيه seq_scan > idx_scan * 10 للجداول التي تتجاوز 10,000 صف. وسجّل WARNING عند البدء لكل مخالفة."
    }
  ]
}
-->
