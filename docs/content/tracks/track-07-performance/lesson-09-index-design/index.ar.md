---
id: track-07-lesson-09
title: "تصميم الفهارس — B-Tree وHash والفهارس الجزئية"
slug: index-design
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [index, B-tree, hash-index, partial-index, covering-index]
prerequisites: [track-07-lesson-08]
---

# تصميم الفهارس — B-Tree وHash والفهارس الجزئية

> [!NOTE]
> الفهارس أعلى أدوات الأداء أثرًا في قواعد البيانات العلائقية، لكن لكل فهرس كلفة وقت الكتابة. واستراتيجية فهارس سيئة التصميم تفرض ضريبة على كل INSERT وUPDATE وDELETE. وفي نظام دفع يعالج آلاف المعاملات في الثانية، تتضاعف هذه الضريبة بسرعة.

## 1. فهارس B-Tree — الحصان العامل الافتراضي

‏B-tree (الشجرة المتوازنة) هو نوع الفهرس الافتراضي في PostgreSQL. وفهم بنيته أساسي لتصميم فهارس فعّالة.

### البنية والخصائص

يحتفظ فهرس B-tree بقيم مفاتيح مرتبة في شجرة متوازنة حيث:
- كل العقد الطرفية على العمق نفسه
- كل عقدة داخلية تحتوي مفاتيح ومؤشرات إلى العقد الأبناء
- العقد الطرفية تحتوي قيم المفاتيح ومؤشرات TID ‏(معرّف الصف) في الـ heap
- العقد الطرفية المتجاورة مترابطة لمسح النطاقات بكفاءة

```
                    [500 | 1000]
                   /      |      \
         [100|200|300]  [600|700]  [1100|1200|1300]
         /   |   |   \   ...
     [TIDs] [TIDs] ...
```

**الخصائص**:
- ‏O(log N) للبحث النقطي
- ‏O(log N + K) لمسح النطاقات (K = صفوف النتيجة)
- يدعم `=`، و`<`، و`<=`، و`>`، و`>=`، و`BETWEEN`، و`IN`، و`LIKE 'prefix%'` (الأخير فقط مع ترتيب `C` أو فهرس `text_pattern_ops`)
- يدعم `ORDER BY` دون ترتيب إضافي
- يدعم `IS NULL` و`IS NOT NULL`

### إنشاء فهارس B-Tree لجداول الدفع

```sql
-- Primary key (B-tree by default)
CREATE TABLE transactions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL,
    amount       NUMERIC(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    type         VARCHAR(30) NOT NULL,
    reference    VARCHAR(100),
    idempotency_key VARCHAR(64) UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at   TIMESTAMPTZ
);

-- Simple B-tree on foreign key (always index FK columns)
CREATE INDEX idx_transactions_account_id
    ON transactions (account_id);

-- B-tree on timestamp for range queries
CREATE INDEX idx_transactions_created_at
    ON transactions (created_at DESC);

-- Verify indexes exist
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'transactions';
```

### ترتيب الأعمدة في فهرس B-Tree المركب

ترتيب الأعمدة في الفهرس المركب حاسم. والقاعدة: **شروط المساواة أولًا، وشروط النطاق أخيرًا، والأعمدة الأعلى انتقائية أولًا داخل كل فئة**.

```sql
-- Query: account transaction history in a date range
-- WHERE account_id = $1 AND created_at BETWEEN $2 AND $3

-- WRONG order: range first breaks the ability to skip to a specific account
CREATE INDEX idx_bad ON transactions (created_at, account_id);
-- PostgreSQL must scan ALL rows in the date range, then filter by account_id

-- RIGHT order: equality first, then range
CREATE INDEX idx_transactions_account_date
    ON transactions (account_id, created_at DESC);
-- PostgreSQL jumps directly to account_id's rows, then scans date range

-- Query with two equality columns + range
-- WHERE account_id = $1 AND status = 'COMPLETED' AND created_at > $2
CREATE INDEX idx_transactions_account_status_date
    ON transactions (account_id, status, created_at DESC);
```

### مقارنة أداء استعلامات النطاق

```sql
-- Illustrative: 10M row transactions table, one account with 50K transactions

-- With NO index usable for account_id:
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM transactions
WHERE account_id = 'acct-001' AND created_at > NOW() - INTERVAL '30 days'
LIMIT 50;
-- Seq Scan: actual time=1823.456..1891.234 ms

-- With composite index:
-- Index Scan: actual time=0.043..0.312 ms  (thousands of times faster)
```

## 2. فهارس Hash — مساواة فقط، أسرع للبحث النقطي

تربط فهارس Hash كل مفتاح بدلو تجزئة. وهي مثالية لعمليات البحث بالمساواة لكنها لا تدعم استعلامات النطاق أو الترتيب.

```sql
-- Hash index on an external gateway reference (pure equality, never range,
-- long values, no uniqueness needed)
CREATE INDEX idx_transactions_gateway_ref_hash
    ON transactions USING HASH (external_reference);

-- Verify hash index usage
EXPLAIN SELECT id FROM transactions
WHERE external_reference = 'gw-7f3a9c-000123';
-- Index Scan using idx_transactions_gateway_ref_hash

-- Hash lookups can be slightly faster than B-tree for equality, and a hash
-- index stores only a 4-byte hash per row, so it can be smaller for long keys.
-- But B-tree is usually preferred because hash indexes:
-- 1. cannot enforce UNIQUE constraints
-- 2. do not support range, ordering, IS NULL or multi-column keys
-- 3. cannot be used for index-only scans
-- (They are crash-safe and replicated only since PostgreSQL 10.)
-- Use hash only when you have measured a benefit
```

**متى تستخدم فهارس Hash في التقنية المالية**:
- البحث بأرقام المرجع الخارجية (معرّفات معاملات بوابة الدفع) حيث يُسمح بالتكرار
- **ليس** لمفاتيح الـ idempotency: فهذه تحتاج قيد `UNIQUE` ‏(B-tree) — وهذا القيد هو ما يمنع طلبًا مُعادًا من إنشاء دفعة ثانية
- أبدًا لـ `created_at`، أو `amount`، أو أي عمود يُستعلم عنه بالنطاق

## 3. الفهارس الجزئية — فهرسة مجموعة فرعية من الصفوف

تتضمن الفهارس الجزئية فقط الصفوف المطابقة لعبارة `WHERE`. فهي أصغر وأسرع وقوية جدًا للترشيح حسب الحالة.

### فهرس جزئي للمعاملات المعلقة

```sql
-- Only a small fraction of transactions are PENDING at any time
-- A full index on status wastes space on COMPLETED/FAILED rows
CREATE INDEX idx_transactions_pending_account
    ON transactions (account_id, created_at)
    WHERE status = 'PENDING';

-- This index is used ONLY when status = 'PENDING' appears in the WHERE clause
EXPLAIN SELECT COUNT(*), SUM(amount)
FROM transactions
WHERE account_id = 'acct-001'
  AND status = 'PENDING'
  AND created_at > NOW() - INTERVAL '24 hours';

-- Index Scan using idx_transactions_pending_account
-- (actual time=0.021..0.187 rows=3 loops=1)
-- Index is tiny because only ~0.1% of transactions are PENDING
```

لا يستخدم المخطِّط فهرسًا جزئيًا إلا حين يستطيع إثبات أن `WHERE` في الاستعلام تستلزم شرط الفهرس. فاكتب `status = 'PENDING'` كقيمة حرفية: فمع معامل ربط (`status = ?`) لا تستطيع خطة مُعدّة عامة استخدامه.

### فهرس جزئي لحالة الحساب

```sql
-- Useful when closed/frozen accounts are a LARGE share of all rows
-- (e.g. after years of churn) and the hot queries only want active ones
CREATE INDEX idx_accounts_active_number
    ON accounts (account_number)
    WHERE status = 'ACTIVE';

-- Frozen/closed accounts are excluded from this index
-- Keeps index small even as closed accounts accumulate over years
```

### فهرس جزئي للأعمدة الفارغة (NULL)

```sql
-- settled_at is NULL until a transaction completes
-- Unsettled transaction queries only need to scan NULL rows
CREATE INDEX idx_transactions_unsettled
    ON transactions (account_id, created_at)
    WHERE settled_at IS NULL;

-- Query: find all unsettled transactions for an account
SELECT id, amount, created_at
FROM transactions
WHERE account_id = 'acct-001'
  AND settled_at IS NULL
ORDER BY created_at DESC;
-- Uses idx_transactions_unsettled directly
```

### مقارنة أحجام الفهارس الجزئية

```sql
-- Compare index sizes
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    indpred IS NOT NULL AS is_partial
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_indexes idx ON idx.indexname = c.relname
WHERE idx.tablename = 'transactions'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Typical result for 50M row transactions table:
-- idx_transactions_account_date     : 2.1 GB  (full)
-- idx_transactions_pending_account  : 12 MB   (partial, 0.02% of rows)
-- Space savings: 99.4%
```

## 4. الفهارس المُغطية مع INCLUDE

يخزن الفهرس المُغطي أعمدة إضافية في الصفحات الطرفية بحيث يمكن تلبية الاستعلام كليًا من الفهرس دون لمس الـ heap.

```sql
-- Without covering index: index scan + heap fetch for each row
CREATE INDEX idx_basic ON transactions (account_id, created_at DESC);

-- With covering index: index-only scan possible
CREATE INDEX idx_transactions_account_date_covering
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status, type, reference);

-- Now this query needs ZERO heap access:
EXPLAIN (ANALYZE, BUFFERS)
SELECT amount, currency, status, type, reference, created_at
FROM transactions
WHERE account_id = 'acct-001'
ORDER BY created_at DESC
LIMIT 50;

-- Index Only Scan using idx_transactions_account_date_covering
-- Heap Fetches: 0
-- Buffers: shared hit=4  (only index pages)
```

**أعمدة INCLUDE مقابل أعمدة مفتاح الفهرس**:
- تُخزّن أعمدة INCLUDE في العقد الطرفية فقط، لا الداخلية — فالفهرس أصغر
- لا يمكن استخدام أعمدة INCLUDE للبحث في الفهرس أو لتوفير ORDER BY (في المسح من الفهرس فقط لا يمكن فحصها إلا كمرشح)
- أعمدة INCLUDE ليست جزءًا من قيد التفرد
- استخدم INCLUDE للأعمدة التي تعرضها ولا ترشّح/ترتّب عليها أبدًا — وتجنب الأعمدة كثيرة التحديث: فأي عمود مفهرس (بما فيه INCLUDE) يمنع تحديثات HOT الرخيصة

```sql
-- Pattern: minimal key for filtering + project-only columns in INCLUDE
CREATE INDEX idx_accounts_lookup
    ON accounts (account_number)              -- key: used for WHERE
    INCLUDE (balance, currency, status, version);  -- projected columns
```

## 5. فهارس التعابير

تفهرس فهارس التعابير نتيجة دالة أو تعبير بدل قيمة العمود.

```sql
-- Case-insensitive account number lookup
CREATE INDEX idx_accounts_number_lower
    ON accounts (LOWER(account_number));

-- Query must use the same expression
SELECT * FROM accounts WHERE LOWER(account_number) = LOWER($1);

-- Date-only index (strip time component for day-level queries).
-- DATE(created_at) on a TIMESTAMPTZ is NOT allowed in an index: its result
-- depends on the session TimeZone. Fix the time zone explicitly:
CREATE INDEX idx_transactions_date_utc
    ON transactions (((created_at AT TIME ZONE 'UTC')::date));

-- Query must use the same expression
SELECT COUNT(*) FROM transactions
WHERE (created_at AT TIME ZONE 'UTC')::date = '2024-01-15';
-- (A plain range on created_at with the normal B-tree index is often simpler:
--  created_at >= '2024-01-15 00:00Z' AND created_at < '2024-01-16 00:00Z')

-- JSONB expression index for a metadata column (metadata JSONB)
CREATE INDEX idx_transactions_metadata_type
    ON transactions ((metadata->>'payment_method'));

-- Query
SELECT * FROM transactions WHERE metadata->>'payment_method' = 'CARD';
```

**تحذير**: تتطلب فهارس التعابير أن يستخدم الاستعلام التعبير نفسه تمامًا. ‏`LOWER(account_number)` و`lower(account_number)` متماثلان، لكن `TRIM(LOWER(account_number))` ليس كذلك.

## 6. المسح من الفهرس فقط — متى ينطبق

يتخطى المسح من الفهرس فقط الـ heap كليًا. ويتطلب:
1. أن تكون كل الأعمدة المعروضة في الفهرس (كمفتاح أو INCLUDE)
2. أن تُظهر خريطة الرؤية الصفحة "مرئية بالكامل" (يضبطها VACUUM حين يكون كل صف في الصفحة مرئيًا لكل المعاملات)

```sql
-- Check visibility map coverage
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'transactions';

-- Many changes since the last vacuum mean many pages are not all-visible
-- -> index-only scans fall back to the heap ("Heap Fetches" grows)
-- Solution: vacuum more often
ALTER TABLE transactions SET (
    autovacuum_vacuum_scale_factor = 0.01,         -- vacuum at 1% dead tuples (default 20%)
    autovacuum_vacuum_insert_scale_factor = 0.01,  -- PG13+: also after inserts (append-heavy
                                                   -- tables otherwise rarely get vacuumed)
    autovacuum_analyze_scale_factor = 0.005        -- analyze at 0.5% changes (default 10%)
);
```

## 7. انتفاخ الفهارس — المراقبة والصيانة

تراكم الفهارس مدخلات ميتة مع تحديث الصفوف وحذفها. وانتفاخ الفهرس يزيد زمن المسح ويهدر مساحة القرص.

```sql
-- Monitor index size and usage
-- (pg_stat_user_indexes names its columns relname / indexrelname)
SELECT
    schemaname,
    relname      AS tablename,
    indexrelname AS indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    CASE WHEN idx_scan = 0 THEN 'UNUSED' ELSE 'USED' END AS usage
FROM pg_stat_user_indexes
WHERE relname IN ('transactions', 'accounts')
ORDER BY pg_relation_size(indexrelid) DESC;
```

```sql
-- Detailed B-tree bloat check: pgstatindex() from the pgstattuple extension
-- (it reads the whole index -- run it off-peak)
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT
    c.relname AS indexname,
    pg_size_pretty(pg_relation_size(c.oid)) AS index_size,
    ROUND(s.avg_leaf_density::numeric, 1)   AS fill_pct,
    s.leaf_fragmentation
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_am am   ON am.oid = c.relam AND am.amname = 'btree'
CROSS JOIN LATERAL pgstatindex(c.oid) s
WHERE t.relname = 'transactions'
ORDER BY s.avg_leaf_density;

-- avg_leaf_density < 50% = significant bloat -> consider REINDEX
-- (a fresh B-tree is ~90% full by default)
```

### ‏REINDEX CONCURRENTLY

```sql
-- Rebuild index without blocking reads/writes (PostgreSQL 12+)
REINDEX INDEX CONCURRENTLY idx_transactions_account_date;

-- Rebuild all indexes on a table
REINDEX TABLE CONCURRENTLY transactions;

-- Check progress
SELECT phase, blocks_done, blocks_total,
       ROUND(100.0 * blocks_done / NULLIF(blocks_total, 0), 1) AS pct_done
FROM pg_stat_progress_create_index
WHERE relid = 'transactions'::regclass;
```

**مهم**: يتطلب `REINDEX CONCURRENTLY` مساحة قرص إضافية (يبني الفهرس الجديد قبل حذف القديم)، ويستغرق وقتًا أطول من `REINDEX` العادي، ولا يمكن تشغيله داخل كتلة معاملة. وإذا فشل، فقد يترك فهرسًا `INVALID` (بلاحقة `_ccnew`) يجب أن تحذفه.

## 8. كشف الفهارس غير المستخدمة وإزالتها

```sql
-- Find indexes never used since the last statistics reset
SELECT
    s.schemaname,
    s.relname      AS tablename,
    s.indexrelname AS indexname,
    pg_size_pretty(pg_relation_size(s.indexrelid)) AS wasted_size,
    s.idx_scan AS scans_since_reset
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique        -- keep primary keys and UNIQUE constraints
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

```sql
-- Be cautious: statistics can be reset (pg_stat_reset(), crash recovery,
-- and on restart before PostgreSQL 15). Check how old they are:
SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();

-- Only trust zero-scan results if the statistics cover > 2 weeks AND a full
-- business cycle (month-end, quarter-end reports).
-- idx_scan counts only THIS server: an index used only by queries on a read
-- replica shows 0 on the primary -- check every replica before dropping.
```

حذف فهرس غير مستخدم:

```sql
-- Always use IF EXISTS and in a migration
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_old_reference;

-- Flyway migration
-- V20240115__drop_unused_transactions_reference_index.sql
-- CONCURRENTLY cannot run inside a transaction: tell Flyway with a script
-- config file V20240115__drop_unused_transactions_reference_index.sql.conf
-- containing: executeInTransaction=false
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_reference_old;
```

## 9. تصميم الفهارس للمخطط المالي الأساسي

إليك مجموعة فهارس كاملة جاهزة للإنتاج لجداول الدفع الأساسية:

```sql
-- =============================================
-- accounts table indexes
-- =============================================

-- PK already creates: btree on id
-- UNIQUE constraint already creates: btree on account_number

-- OPTIONAL covering index for balance lookup -- only if measurements show the
-- heap visit matters. balance/version change on every payment, so this index
-- turns every balance update into a non-HOT update (see lesson 08).
-- CREATE INDEX idx_accounts_balance_lookup
--     ON accounts (account_number)
--     INCLUDE (id, balance, currency, status, version);

-- (No separate "active accounts" index: the UNIQUE index on account_number
--  already finds any account in a few page reads.)

-- Customer's accounts list
CREATE INDEX idx_accounts_customer
    ON accounts (customer_id, status, created_at DESC)
    INCLUDE (account_number, balance, currency);

-- =============================================
-- transactions table indexes
-- =============================================

-- PK already creates: btree on id
-- UNIQUE constraint on idempotency_key already creates a B-tree -- it is what
-- guarantees a retried request cannot insert a second payment. Do not add
-- a second (hash) index on the same column: it only adds write cost.

-- Primary access pattern: account history (most frequent)
CREATE INDEX idx_transactions_account_history
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status, type, reference);

-- Settlement reconciliation
CREATE INDEX idx_transactions_settlement
    ON transactions (settled_at)
    WHERE settled_at IS NOT NULL AND status = 'COMPLETED';

-- Pending transaction velocity check (partial: tiny index)
CREATE INDEX idx_transactions_pending
    ON transactions (account_id, created_at)
    WHERE status = 'PENDING';

-- External reference lookup (payment gateway IDs; external_reference column)
CREATE INDEX idx_transactions_external_ref
    ON transactions (external_reference)
    WHERE external_reference IS NOT NULL;

-- Date-range query without account filter (admin/compliance)
CREATE INDEX idx_transactions_created_at
    ON transactions (created_at DESC)
    INCLUDE (account_id, amount, currency, status);
```

## 10. ‏Java — نمط مستودع واعٍ بالفهارس

```java
@Repository
public class TransactionRepository {

    private final JdbcTemplate jdbc;
    private final MeterRegistry metrics;

    // Uses idx_transactions_account_history (covering).
    // First page only -- see lesson 08 for the keyset cursor on later pages.
    public List<TransactionSummary> findByAccountId(
            UUID accountId,
            Instant from,
            Instant to,
            Pageable pageable) {

        // No OFFSET: later pages continue from the last (created_at, id)
        return jdbc.query(
            """
            SELECT id, amount, currency, status, type, reference, created_at
            FROM transactions
            WHERE account_id = ?
              AND created_at BETWEEN ? AND ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (rs, row) -> mapRow(rs),
            // pgjdbc does not bind java.time.Instant directly
            accountId, Timestamp.from(from), Timestamp.from(to), pageable.getPageSize()
        );
    }

    // Uses idx_transactions_pending (partial) — tiny, fast
    public VelocityCheckResult checkVelocity(UUID accountId, Instant since) {
        return jdbc.queryForObject(
            """
            SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
            FROM transactions
            WHERE account_id = ?
              AND status = 'PENDING'
              AND created_at > ?
            """,
            (rs, row) -> new VelocityCheckResult(
                rs.getInt("cnt"),
                rs.getBigDecimal("total")
            ),
            accountId, Timestamp.from(since)
        );
    }

    // Uses the UNIQUE (B-tree) index on idempotency_key
    public Optional<UUID> findIdByIdempotencyKey(String key) {
        List<UUID> results = jdbc.query(
            "SELECT id FROM transactions WHERE idempotency_key = ?",
            (rs, row) -> rs.getObject("id", UUID.class),
            key
        );
        return results.isEmpty() ? Optional.empty() : Optional.of(results.get(0));
    }
}
```

## 11. مراقبة صحة الفهارس في الإنتاج

```java
@Component
@Slf4j
public class IndexHealthMonitor {

    private final JdbcTemplate jdbc;
    private final MeterRegistry metrics;
    // One holder per index: a gauge is registered ONCE and then reads the
    // holder. (Calling metrics.gauge(..., rs.getLong(...)) every minute would
    // register a boxed number once and never update it.)
    private final Map<String, AtomicLong> scans = new ConcurrentHashMap<>();
    private final Map<String, AtomicLong> hitPctTimes10 = new ConcurrentHashMap<>();

    public IndexHealthMonitor(JdbcTemplate jdbc, MeterRegistry metrics) {
        this.jdbc = jdbc;
        this.metrics = metrics;
    }

    @Scheduled(fixedRate = 60_000)
    public void reportIndexStats() {
        jdbc.query(
            """
            SELECT s.indexrelname AS indexname, s.idx_scan,
                   ROUND(io.idx_blks_hit::numeric /
                       NULLIF(io.idx_blks_hit + io.idx_blks_read, 0) * 100, 1) AS hit_pct
            FROM pg_stat_user_indexes s
            JOIN pg_statio_user_indexes io USING (indexrelid)
            WHERE s.relname IN ('transactions', 'accounts')
            """,
            (RowCallbackHandler) rs -> {
                String index = rs.getString("indexname");
                holder(scans, "db.index.scans", index).set(rs.getLong("idx_scan"));
                holder(hitPctTimes10, "db.index.cache_hit_pct_x10", index)
                    .set(Math.round(rs.getDouble("hit_pct") * 10));
            }
        );
    }

    private AtomicLong holder(Map<String, AtomicLong> map, String name, String index) {
        return map.computeIfAbsent(index, i ->
            metrics.gauge(name, Tags.of("index", i), new AtomicLong()));
    }
}
```

## 12. إطار قرار تصميم الفهارس

| نمط الاستعلام | نوع الفهرس الموصى به |
|---|---|
| مساواة على عمود عالي التعدد | ‏B-tree أو Hash |
| نطاق على طابع زمني/مبلغ | ‏B-tree |
| مساواة + نطاق معًا | ‏B-tree مركب (المساواة أولًا) |
| مجموعة فرعية صغيرة من الصفوف (< 10%) | فهرس جزئي |
| تغطية الأعمدة المعروضة كثيرًا | مركب مع INCLUDE |
| دالة/تعبير في WHERE | فهرس تعبير |
| مساواة بحتة، بلا نطاق، بلا ترتيب | فهرس Hash |
| ترشيح NULL/NOT NULL | فهرس جزئي |

**القواعد الخمس لتصميم الفهارس في التقنية المالية**:
1. افهرس دائمًا أعمدة المفاتيح الأجنبية (`account_id`، و`customer_id`)
2. فهارس جزئية لأعمدة الحالة منخفضة التعدد
3. فهارس مُغطية لأكثر 5 أشكال استعلامات تكرارًا
4. لا تفهرس كل عمود "احتياطًا" — راقب `pg_stat_user_indexes`
5. ‏REINDEX CONCURRENTLY حين يستدعيه الانتفاخ المقيس (مثلًا كثافة طرفية أقل بكثير من نحو 50%)، لا وفق جدول ثابت

> [!WARNING]
> كل فهرس يضيف زمنًا لكل INSERT وUPDATE وDELETE. فجدول معاملات بـ 20 فهرسًا سيعالج الكتابات أبطأ بكثير من جدول بـ 8 فهارس مصممة جيدًا. وقِس إنتاجية الكتابة عند إضافة فهارس إلى الجداول عالية الحجم.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "متى يجب أن تستخدم فهرس Hash بدل فهرس B-tree في PostgreSQL؟",
      "options": [
        "حين يكون للعمود تعدد منخفض (قيم مميزة قليلة)",
        "حين تستخدم الاستعلامات شروط مساواة فقط على العمود ولا تستخدم أبدًا مسح النطاقات أو الترتيب أو المطابقة الجزئية",
        "فهارس Hash دائمًا أسرع من B-tree ويجب أن تكون الخيار الافتراضي",
        "حين يكون الجدول مقسمًا بالنطاق على العمود نفسه"
      ],
      "correct": 1,
      "explanation": "تدعم فهارس Hash مقارنات المساواة فقط (العمود = قيمة). ولا تدعم استعلامات النطاق، أو ORDER BY، أو مطابقة بادئة LIKE، أو التفرد، أو المسح من الفهرس فقط. ففكّر فيها لعمليات البحث بالمساواة البحتة على قيم طويلة عالية التعدد مثل مراجع البوابة — لا لمفاتيح الـ idempotency، التي تحتاج فهرس B-tree فريدًا لمنع المدفوعات المكررة. ويبقى B-tree الخيار الصحيح لأي استعلام يتطلب نطاقًا أو ترتيبًا أو وصولًا متعدد العوامل."
    },
    {
      "text": "ما الفهرس المُغطي ومتى يلغي جلب الـ heap؟",
      "options": [
        "يغطي الفهرس المُغطي جداول متعددة في JOIN، فيلغي الحاجة إلى ربط التجزئة",
        "يتضمن الفهرس المُغطي كل الأعمدة المشار إليها في عبارتي SELECT وWHERE للاستعلام عبر INCLUDE، فيتيح لـ PostgreSQL تلبية الاستعلام من الفهرس وحده دون زيارة الـ heap",
        "يغطي الفهرس المُغطي تلقائيًا الفهارس المرتبطة من أجل الاتساق",
        "يستخدم الفهرس المُغطي مساحة قرص أكبر لكنه مطابق للفهرس العادي في غير ذلك"
      ],
      "correct": 1,
      "explanation": "حين يحتوي الفهرس كل الأعمدة التي يحتاجها الاستعلام (أعمدة المفتاح بالإضافة إلى الأعمدة غير المفتاحية في INCLUDE)، يستطيع PostgreSQL إعادة النتائج من صفحات الفهرس دون جلب صفحات الـ heap (الجدول) — ما دامت تلك الصفحات معلّمة مرئية بالكامل بواسطة VACUUM. ولاستعلام سجل معاملات كثيف القراءة يجلب المبلغ والعملة والحالة، فإن تضمينها في الفهرس يزيل معظم عمليات جلب الـ heap."
    },
    {
      "text": "لماذا يجب استخدام CREATE INDEX CONCURRENTLY في الإنتاج بدل CREATE INDEX؟",
      "options": [
        "CONCURRENTLY أسرع؛ وإنشاء الفهرس غير المتزامن مُهمل في PostgreSQL 14",
        "يحصل CREATE INDEX على قفل SHARE يحجب كل الكتابات (INSERT، وUPDATE، وDELETE) طوال المدة؛ بينما يحصل CONCURRENTLY على SHARE UPDATE EXCLUSIVE فقط، فيتيح استمرار DML أثناء بناء الفهرس",
        "ينشئ CONCURRENTLY الفهرس على النسخ المتماثلة بالتوازي؛ وCREATE INDEX العادي يفهرس الأساسي فقط",
        "هما متكافئان؛ وCONCURRENTLY اسم مستعار بلا أثر للتوافق"
      ],
      "correct": 1,
      "explanation": "يحصل CREATE INDEX على قفل SHARE يمنع أي كتابات إلى الجدول حتى اكتمال الفهرسة. وعلى جدول معاملات من 100 مليون صف، قد يحجب هذا الكتابات لدقائق. أما CONCURRENTLY فيأخذ تمريرتين بأقفال أضعف، فيتيح الكتابات طوال الوقت. والمقابل أن CONCURRENTLY يستغرق وقتًا أطول ولا يمكن تشغيله داخل كتلة معاملة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "استراتيجية فهارس لجدول معاملات عالي الحجم",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "صمم استراتيجية فهارس كاملة لجدول معاملات (100 مليون صف، و5000 كتابة في الثانية) تدعم: استعلامات سجل الحساب حسب نطاق التاريخ، وطوابير المعاملات المعلقة حسب الحساب، وإزالة التكرار حسب reference_id، وتقارير التسوية الشهرية."},
    {"id": "2", "description": "اكتب كل عبارات CREATE INDEX CONCURRENTLY للفهارس المصممة، بما فيها أعمدة INCLUDE المناسبة وعبارات WHERE للفهارس الجزئية."},
    {"id": "3", "description": "اكتب ApplicationRunner في Spring Boot يستعلم pg_stat_user_indexes ويسجّل أي فهرس بـ idx_scan = 0 بعد عمل الخدمة 7 أيام أو أكثر، معلّمًا المرشحين للإزالة."},
    {"id": "4", "description": "اكتب استعلام SQL يحدد انتفاخ الفهارس على جدول المعاملات باستخدام pgstatindex() ‏(من امتداد pgstattuple) مع pg_stat_user_indexes، واشرح متى يجب جدولة REINDEX CONCURRENTLY."}
  ]
}
-->
