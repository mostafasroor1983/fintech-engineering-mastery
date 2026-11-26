---
id: track-08-lesson-21
title: "NewSQL — بنية CockroachDB وGoogle Spanner"
slug: newsql
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 21
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [NewSQL, CockroachDB, Spanner, serializable, geo-partitioning]
prerequisites: [track-08-lesson-17]
---

# ‏NewSQL — بنية CockroachDB وGoogle Spanner

> [!NOTE]
> تعد قواعد بيانات NewSQL بأفضل ما في العالمين: واجهة SQL وضمانات ACID لقواعد البيانات التقليدية، مع التوسع الأفقي لـ NoSQL. والمقابل هو زمن الاستجابة — فالمعاملات الموزعة تتطلب جولات شبكة متعددة للإجماع. وللأنظمة المالية، فهم أين يظهر هذا الزمن أساسي لاتخاذ قرار معماري مستنير.

## 1. تعريف NewSQL

تشترك قواعد بيانات NewSQL في ثلاث خصائص:
1. **دعم SQL كامل**: النموذج العلائقي، والربط، والفهارس، والمعاملات
2. **قابلية التوسع الأفقي**: توسيع الكتابات (لا القراءات فقط) بإضافة عقد
3. **معاملات ACID موزعة**: عزل قابل للتسلسل دون اختناق الكاتب الواحد

تحقق قواعد البيانات العلائقية التقليدية (1) و(3) لكن لا (2).
وتحقق NoSQL ‏(2) لكنها تتخلى عن (1) وتضعف (3).
وتدّعي NewSQL تحقيق الثلاثة.

```
Database Evolution:
  Traditional RDBMS (PostgreSQL, MySQL): SQL + ACID, single-writer bottleneck
  NoSQL (Cassandra, MongoDB):            Scale-out, eventual consistency
  NewSQL (CockroachDB, Spanner):         SQL + ACID + horizontal write scale
```

## 2. بنية CockroachDB

‏CockroachDB قاعدة بيانات SQL موزعة مستوحاة من Google Spanner. وتستخدم إجماع Raft لكل نطاق بيانات.

### مفاهيم البنية الأساسية

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

### إعداد CockroachDB والمخطط

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

### العزل القابل للتسلسل في CockroachDB

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

## 3. ‏Google Spanner — TrueTime والاتساق الخارجي

‏Spanner قاعدة بيانات علائقية موزعة عالميًا من Google. وابتكارها الأساسي TrueTime — ساعة متزامنة عالميًا بعدم يقين محدود.

### بنية TrueTime

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

### ‏Spanner SQL — مألوف لكنه موزع

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

### عميل Spanner في Java

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

## 4. التقسيم الجغرافي لإقامة البيانات (GDPR)

يدعم CockroachDB وSpanner كلاهما التقسيم الجغرافي — وضع البيانات فيزيائيًا في مناطق محددة.

ملاحظة: وضع النسخة *الأساسية* في منطقة ليس تلقائيًا إقامة بيانات كاملة — فتحقق أيضًا من أين تنتهي النسخ غير المصوِّتة، والنسخ الاحتياطية، والسجلات، وتدفقات التغييرات.

### التقسيم الجغرافي في CockroachDB

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

### التوزيع الجغرافي في Spanner

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

## 5. أثر المعاملات الموزعة على زمن الاستجابة

هذا أهم قسم لمعماريي الأنظمة المالية.

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

## 6. متى تكون NewSQL منطقية في التقنية المالية

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

## 7. اعتبارات الترحيل

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

## 8. الخلاصة — مصفوفة قرار NewSQL

(نطاقات تقريبية توضيحية — فالأرقام الحقيقية تعتمد كثيرًا على العتاد، والمخطط، والحمل.)

| المتطلب | PostgreSQL | Citus | CockroachDB | Spanner |
|---|---|---|---|---|
| ‏TPS الكتابة | 10K-30K | 30K-100K | 50K-200K | 100K+ |
| زمن قراءة p99 | <5ms | <10ms | 5-20ms | 10-50ms |
| زمن كتابة p99 | <2ms | <5ms | 5-15ms | 10-50ms |
| نشط-نشط متعدد المناطق | لا | لا | نعم | نعم |
| التعقيد التشغيلي | منخفض | متوسط | متوسط | منخفض (مُدار) |
| توافق SQL | كامل | كامل | عالٍ (متوافق على مستوى البروتوكول، مع بعض الفجوات) | لهجة GoogleSQL أو PostgreSQL (مجموعة فرعية) |
| الكلفة على نطاق واسع | متوسطة | متوسطة | عالية | عالية جدًا |
| الخبرة المطلوبة من الفريق | قياسية | متوسطة | متقدمة | متقدمة |

> [!WARNING]
> أشيع خطأ في اعتماد NewSQL في التقنية المالية اختيار CockroachDB أو Spanner قبل الأوان — قبل تحسين PostgreSQL كما يجب. فقبل تقييم NewSQL، تحقق من أن لديك: (1) فهارس مناسبة لكل أنماط الاستعلام، (2) تجميع اتصالات مُعدًّا، (3) تقسيمًا منفذًا للجداول الكبيرة، (4) نسخ قراءة للأحمال كثيفة القراءة، (5) سقف TPS مقاسًا بأحمال الإنتاج. ومعظم الأنظمة المالية تبلغ سقف PostgreSQL أبعد بكثير مما يُقدّر في البداية.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تفشل معاملة في CockroachDB بالخطأ: TransactionRetryWithProtoRefreshError: TransactionRetryError: retry txn (REASON_TS_CACHE_REJECTED). ما المعالجة الصحيحة على مستوى التطبيق ولماذا يتطلبها CockroachDB؟",
      "options": ["التقط الخطأ وأجهض العملية كلها فورًا؛ لا يدعم CockroachDB إعادة المحاولة على مستوى التطبيق", "التقط الخطأ، وتراجع عن المعاملة، وأعد محاولة المعاملة كاملة من البداية مع تراجع أسي؛ يستخدم CockroachDB تحكمًا تفاؤليًا في التزامن ولا يستطيع إعادة محاولة المعاملات داخليًا بعد أن أرسلت نتائج للعميل", "زِد مهلة المعاملة باستخدام SET statement_timeout؛ يدل الخطأ على معاملة بطيئة تحتاج وقتًا أطول", "انتقل إلى عزل READ COMMITTED؛ يحدث REASON_TS_CACHE_REJECTED فقط تحت عزل SERIALIZABLE"],
      "correct": 1,
      "explanation": "يستخدم CockroachDB تحكمًا تفاؤليًا في التزامن مع MVCC. وحين يُكتشف تعارض في قابلية التسلسل، يرفع خطأ قابلًا لإعادة المحاولة (SQLSTATE 40001) بدل الحجب. ويعيد CockroachDB بعض المعاملات تلقائيًا على الخادم، لكن بعد إعادة نتائج للعميل لا يستطيع — فيجب على التطبيق التراجع وتشغيل منطق المعاملة كاملًا مجددًا مع تراجع زمني. واستخدم حلقة إعادة محاولة خاصة بك (أو Spring Retry حول TransactionTemplate)، أو مغلّف JDBC من Cockroach Labs الذي يستطيع إعادة المحاولة بشفافية."
    },
    {
      "text": "يستخدم Google Spanner ‏TrueTime لتعيين طوابع التزام مرتبة عالميًا. وتلتزم معاملة بفترة TrueTime ‏[T-ε, T+ε] حيث ε عدم يقين الساعة. ماذا يفعل Spanner قبل جعل البيانات الملتزمة مرئية للقراء؟",
      "options": ["يجعل البيانات مرئية فورًا ويعتمد على القراء للتعامل مع عدم اليقين بإعادة القراءة", "ينتظر فترة انتظار الالتزام (2ε على الأقل) حتى يُضمن أن طابع الالتزام في الماضي قبل جعل البيانات مرئية، فيضمن الاتساق الخارجي", "يستخدم مصدر طوابع زمنية مركزيًا لحل عدم اليقين قبل تعيين طابع نهائي", "يطلب تحديث وقت GPS لتقليل ε قبل التزام المعاملات عالية الأولوية"],
      "correct": 1,
      "explanation": "يضمن انتظار الالتزام في Spanner الاتساق الخارجي: فبعد اختيار طابع الالتزام T، ينتظر Spanner حتى يصبح TrueTime.now().earliest > T قبل جعل الالتزام مرئيًا وتأكيده. فأي معاملة تبدأ بعد ذلك تحصل على طابع أكبر من T وترى البيانات الملتزمة. والانتظار بمقدار عدم يقين الساعة (بضع مللي ثوانٍ على الأكثر، وعادة أقل بكثير اليوم)، وهو ما يمنح Spanner قراءات متسقة عالميًا دون مصدر طوابع زمنية مركزي."
    },
    {
      "text": "تعمل منصة دفع حاليًا على PostgreSQL بـ 15K TPS وp99 = 8ms. ويقترح الفريق الهندسي الترحيل إلى CockroachDB لقدرة النشط-النشط متعدد المناطق. ما الذي يجب أن يتحقق منه المهندس الرئيسي قبل الموافقة على الترحيل؟",
      "options": ["أن CockroachDB يدعم كل امتدادات PostgreSQL المستخدمة حاليًا، بما فيها pg_trgm وPostGIS", "أن الفريق استنفد خيارات توسيع PostgreSQL (نسخ القراءة، والتقسيم، وتجميع الاتصالات، وتحسين الفهارس) ولديه متطلب متعدد المناطق محدد ومقاس يبرر التعقيد التشغيلي وزيادة الكلفة بمرتين إلى ثلاث", "أن فريق التطوير أكمل تدريب شهادة CockroachDB", "أن شيفرة التطبيق القائمة تستخدم ANSI SQL فقط دون صيغة خاصة بـ PostgreSQL"],
      "correct": 1,
      "explanation": "‏15K TPS مع p99 = 8ms ضمن ما يستطيعه PostgreSQL المحسّن. وزمن الكتابة في CockroachDB عادة عدة مللي ثوانٍ حتى في منطقة واحدة بسبب إجماع Raft، فقد يزيد الترحيل الزمن سوءًا. ويجب أن يشترط المهندس الرئيسي: (أ) دليلًا على أن PostgreSQL حُسّن بالكامل، (ب) متطلب عمل محددًا للنشط-النشط متعدد المناطق (لا مجرد التعافي من الكوارث، الذي يعالجه النشط-الخامل)، (ج) تحليل كلفة-فائدة يشمل الخبرة التشغيلية المطلوبة وكلف الترخيص والحوسبة الأعلى بكثير عادة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ منطق إعادة المحاولة في CockroachDB وتقييم جاهزية الترحيل إلى NewSQL",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "نفّذ صنف CockroachDBTransactionTemplate يغلّف Supplier<T> في حلقة إعادة محاولة. ويجب أن تقوم الحلقة بما يلي: (أ) كشف TransactionRetryWithProtoRefreshError بفحص حالة SQL ‏'40001'، (ب) التراجع وإعادة المحاولة حتى 5 مرات بتراجع أسي يبدأ من 50ms، (ج) نشر الاستثناء الأصلي بعد بلوغ الحد الأقصى للمحاولات، (د) تسجيل كل محاولة برقمها ومدة التراجع. واكتب اختبار وحدة باستخدام DataSource وهمي يرمي الاستثناء القابل لإعادة المحاولة مرتين وينجح في المحاولة الثالثة، متحققًا من إعادة النتيجة بشكل صحيح."
    },
    {
      "id": "2",
      "description": "صمم مخطط CockroachDB متعدد المناطق لجدول payments حيث يجب أن تبقى بيانات عملاء الاتحاد الأوروبي في عقد الاتحاد الأوروبي وبيانات العملاء الأمريكيين في العقد الأمريكية. واستخدم تجريدات تعدد المناطق (PRIMARY REGION / ADD REGION، وLOCALITY REGIONAL BY ROW مع ضبط crdb_region من إقامة العميل، وPLACEMENT RESTRICTED). واكتب DDL. ثم اكتب استعلامًا يُظهر قراءات التابع لحالة استخدام التقارير: SELECT ... AS OF SYSTEM TIME follower_read_timestamp() للقراءة من أقرب نسخة دون عبور حدود المناطق."
    },
    {
      "id": "3",
      "description": "أنشئ صنف NewSQLMigrationReadinessReport يقيّم هل نشر PostgreSQL جاهز للترحيل إلى NewSQL. ويجب أن يفحص التقرير: (أ) ذروة TPS الحالية من pg_stat_statements، (ب) هل نسخ القراءة مُعدّة (pg_stat_replication)، (ج) هل تقسيم الجداول مستخدم (مخطط pg_partman)، (د) زمن p99 من mean_exec_time في pg_stat_statements، (هـ) استغلال مجمع الاتصالات. وأخرج تقريرًا مهيكلًا بدرجة جاهزية (0–100) وتوصيات محددة لكل فجوة موجودة."
    },
    {
      "id": "4",
      "description": "نفّذ Saga دفع موزعة تتجنب المعاملات الموزعة عبر عقدتي CockroachDB: ينسّق PaymentInitiationSaga ‏(1) DebitAccountStep و(2) CreditMerchantStep كمعاملات محلية مستقلة مع خطوات تعويضية (RefundDebitStep، وReverseCreditStep). واستخدم نمط جدول outbox لتنسيق الخطوات. واكتب اختبار تكامل يحاكي فشل CreditMerchantStep ويتحقق من استدعاء RefundDebitStep، تاركًا النظام في حالة متسقة."
    }
  ]
}
-->
