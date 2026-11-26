---
id: track-07-lesson-08
title: "تحسين الاستعلامات — EXPLAIN ANALYZE واستخدام الفهارس"
slug: query-optimization
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 8
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [query-optimization, EXPLAIN, index, sequential-scan, PostgreSQL]
prerequisites: [track-07-lesson-07]
---

# تحسين الاستعلامات — EXPLAIN ANALYZE واستخدام الفهارس

> [!NOTE]
> الاستعلام الذي يعمل في 2 مللي ثانية مع 10,000 صف كثيرًا ما سيعمل في 20 ثانية مع 10 ملايين صف. وقواعد البيانات المالية تنمو بلا توقف — ففهم كيف يخطط PostgreSQL للاستعلامات وينفذها ليس اختياريًا للمهندسين الذين يبنون بنية الدفع.

## 1. صيغة مخرجات EXPLAIN ANALYZE

‏`EXPLAIN ANALYZE` في PostgreSQL هو الأداة الحاسمة لفهم تنفيذ الاستعلام. فهو يجمع تقديرات كلفة المخطِّط مع قياسات وقت التشغيل الفعلية.

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT t.id, t.amount, t.status, a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.created_at >= NOW() - INTERVAL '30 days'
  AND t.status = 'COMPLETED'
ORDER BY t.created_at DESC
LIMIT 100;
```

مخرجات تمثيلية:

```
Limit  (cost=12834.56..12834.81 rows=100 width=72)
       (actual time=89.234..89.251 rows=100 loops=1)
  Buffers: shared hit=4821 read=1203
  ->  Sort  (cost=12834.56..12896.56 rows=24800 width=72)
            (actual time=89.231..89.237 rows=100 loops=1)
        Sort Key: t.created_at DESC
        Sort Method: top-N heapsort  Memory: 52kB
        Buffers: shared hit=4821 read=1203
        ->  Hash Join  (cost=1823.00..12462.00 rows=24800 width=72)
                       (actual time=12.431..85.123 rows=24800 loops=1)
              Hash Cond: (t.account_id = a.id)
              Buffers: shared hit=4821 read=1203
              ->  Index Scan using idx_transactions_created_at
                    on transactions t
                    (cost=0.56..9876.44 rows=24800 width=56)
                    (actual time=0.043..71.234 rows=24800 loops=1)
                  Index Cond: (created_at >= (now() - '30 days'::interval))
                  Filter: (status = 'COMPLETED'::transaction_status)
                  Rows Removed by Filter: 7200
                  Buffers: shared hit=4198 read=1203
              ->  Hash  (cost=823.00..823.00 rows=80000 width=24)
                        (actual time=11.432..11.432 rows=80000 loops=1)
                  Buckets: 131072  Batches: 1  Memory Usage: 4621kB
                  Buffers: shared hit=623
                  ->  Seq Scan on accounts a
                        (cost=0.00..823.00 rows=80000 width=24)
                        (actual time=0.012..6.234 rows=80000 loops=1)
                        Buffers: shared hit=623
Planning Time: 1.234 ms
Execution Time: 89.312 ms
```

### تشريح عقدة الكلفة

تُبلغ كل عقدة في شجرة الخطة عن مجموعتين من القيم:

| الحقل | المعنى |
|---|---|
| ‏`cost=startup..total` | الكلفة المقدرة من المخطِّط بوحدات اعتباطية (1.0 = قراءة صفحة متتابعة واحدة بحجم 8 كيلوبايت، `seq_page_cost`) |
| ‏`rows=N` | عدد صفوف المخرجات المقدر من المخطِّط |
| ‏`width=N` | متوسط عرض الصف المقدر بالبايت |
| ‏`actual time=start..end` | الوقت الفعلي بالمللي ثانية، **لكل حلقة** |
| ‏`actual rows=N` | الصفوف التي أنتجتها العقدة فعلًا، **لكل حلقة** (متوسط) |
| ‏`loops=N` | عدد مرات تنفيذ العقدة — اضرب الوقت والصفوف فيه |

**فكرة حاسمة**: حين يختلف `rows` (التقدير) كثيرًا عن `actual rows` (الواقع)، فقد اختار المخطِّط خطته بافتراضات خاطئة. والأسباب الشائعة: إحصاءات قديمة (شغّل `ANALYZE transactions;` وأعد الفحص)، أو أعمدة مترابطة (انظر الإحصاءات الموسعة في القسم 8)، أو تعابير ودوال لا يستطيع المخطِّط تقديرها.

### إحصاءات المخازن (Buffers)

```
Buffers: shared hit=4821 read=1203
```

- ‏`shared hit` — صفحات وُجدت في ذاكرة المخازن المشتركة لـ PostgreSQL (سريع، نحو 0.1 ميكروثانية)
- ‏`read` — صفحات قُرئت من ذاكرة صفحات نظام التشغيل أو القرص (أبطأ، 0.1–10 مللي ثانية)
- ‏`dirtied` / `written` — صفحات عدّلها هذا الاستعلام / اضطر لكتابتها بنفسه لتحرير مخازن (الكتابات المتكررة من العمليات تشير إلى أن `shared_buffers` أو الكاتب الخلفي لا يواكب)
- ‏`local hit/read` — الوصول إلى الجداول المؤقتة

ارتفاع عدد `read` لاستعلام يعمل كثيرًا إما مشكلة في تحجيم الذاكرة المخبئية أو استعلام يقرأ صفحات أكثر بكثير مما يحتاج (غالبًا فهرس مفقود). وقاعدة تقريبية: `shared_buffers` عادة نحو 25% من الذاكرة، وذاكرة صفحات نظام التشغيل تحمل معظم بقية مجموعة العمل.

## 2. المسح المتتابع مقابل مسح الفهرس مقابل المسح من الفهرس فقط

يختار المخطِّط استراتيجية المسح بناءً على تقديرات كلفة مشتقة من إحصاءات الجدول.

### المسح المتتابع (Sequential Scan)

```sql
-- PostgreSQL will likely choose Seq Scan here: the condition matches most rows
EXPLAIN SELECT COUNT(*) FROM transactions WHERE amount > 0;

-- Output:
-- Seq Scan on transactions  (cost=0.00..158432.00 rows=9876543 width=0)
--   Filter: (amount > '0'::numeric)
```

يقرأ المسح المتتابع كل صفحة في الجدول بالترتيب. ويفوز حين:
- يعيد الاستعلام نسبة كبيرة من الصفوف (تقريبًا أكثر من 5–15%؛ والنقطة الدقيقة تعتمد على حجم الصف والترتيب الفيزيائي)
- يكون الجدول صغيرًا
- لا يوجد فهرس مناسب

### مسح الفهرس (Index Scan)

```sql
-- Very few rows match: index scan wins
EXPLAIN SELECT * FROM transactions WHERE id = 'txn_abc123';

-- Output:
-- Index Scan using transactions_pkey on transactions
--   (cost=0.56..8.58 rows=1 width=256)
--   Index Cond: (id = 'txn_abc123'::text)
```

يتنقل مسح الفهرس في شجرة B-tree لإيجاد مؤشرات صفوف الـ heap، ثم يجلب كل صفحة heap. وللاستعلامات شديدة الانتقائية يكون أسرع بكثير من المسح المتتابع.

### المسح من الفهرس فقط (Index-Only Scan)

```sql
-- If the index covers all needed columns, heap access is skipped
CREATE INDEX idx_txn_account_amount ON transactions (account_id, amount);

EXPLAIN SELECT account_id, SUM(amount)
FROM transactions
WHERE account_id = 'acct_xyz'
GROUP BY account_id;

-- Output:
-- Index Only Scan using idx_txn_account_amount on transactions
--   (cost=0.56..421.33 rows=1250 width=24)
--   Index Cond: (account_id = 'acct_xyz'::text)
--   Heap Fetches: 0   <-- zero heap pages read
```

يتخطى المسح من الفهرس فقط الـ heap كليًا حين:
1. تكون كل الأعمدة المطلوبة في الفهرس
2. تُظهر خريطة الرؤية أن الصفحة مرئية بالكامل (كل صف فيها مرئي لكل المعاملات) — وهذا يضبطه VACUUM، لذا فالجداول ذات التحديثات الحديثة الكثيرة تحصل على جلب أكثر من الـ heap

**الأثر المالي**: لاستعلامات ملخص أرصدة الحسابات التي تعمل ملايين المرات يوميًا، تقلل عمليات المسح من الفهرس فقط الإدخال/الإخراج بمراتب كبيرة.

### مسح فهرس الخريطة النقطية (Bitmap Index Scan)

```sql
EXPLAIN SELECT * FROM transactions
WHERE account_id = 'acct_xyz'
  AND status = 'PENDING'
  AND created_at >= NOW() - INTERVAL '7 days';

-- Output:
-- Bitmap Heap Scan on transactions
--   Recheck Cond: (account_id = 'acct_xyz')
--   Filter: (status = 'PENDING' AND created_at >= ...)
--   ->  Bitmap Index Scan on idx_transactions_account_id
--         Index Cond: (account_id = 'acct_xyz'::text)
```

يبني مسح فهرس الخريطة النقطية خريطة نقطية في الذاكرة لمعرّفات الصفوف المطابقة، ثم يجلب صفحات الـ heap بترتيبها الفيزيائي — متجنبًا الإدخال/الإخراج العشوائي. ويفوز حين تكون الانتقائية متوسطة (صفوف أكثر من أن يناسبها مسح الفهرس، وأقل من أن يناسبها المسح المتتابع).

يمكن دمج عدة مسوح نقطية بـ `BitmapAnd` / `BitmapOr`:

```sql
-- If we have separate indexes on account_id and status:
-- ->  BitmapAnd
--       ->  Bitmap Index Scan on idx_transactions_account_id
--       ->  Bitmap Index Scan on idx_transactions_status
```

## 3. استراتيجيات الربط: Hash Join مقابل Nested Loop مقابل Merge Join

### ربط الحلقات المتداخلة (Nested Loop Join)

```
Nested Loop  (cost=0.56..9823.45 rows=1250 width=72)
  ->  Index Scan on transactions t (outer, 1250 rows)
  ->  Index Scan on accounts a     (inner, 1 row per outer)
        Index Cond: (a.id = t.account_id)
```

**الأفضل حين**: تكون العلاقة الخارجية صغيرة وللداخلية فهرس على مفتاح الربط. وهو كلاسيكي للبحث النقطي: اجلب معاملة واحدة، واربطها بحسابها الواحد.

**الكلفة**: O(صفوف_الخارجية × كلفة_مسح_الداخلية). وينهار إذا أنتجت الخارجية آلاف الصفوف.

### ربط التجزئة (Hash Join)

```
Hash Join  (cost=1823.00..12462.00 rows=24800 width=72)
  Hash Cond: (t.account_id = a.id)
  ->  Seq Scan on transactions t  (outer / probe side: 24800 rows)
  ->  Hash                         (inner / build side: hashed in memory)
        ->  Seq Scan on accounts a
```

**الأفضل حين**: ربط علاقتين كبيرتين دون فهرس مناسب. يبني جدول تجزئة من أحد المدخلين (عادة الأصغر — ابن عقدة `Hash`)، ثم يفحصه بكل صف من الآخر.

**الكلفة**: O(N+M) مع استخدام ذاكرة مرتفع. وإذا تجاوز جدول التجزئة حد ذاكرته (`work_mem` × `hash_mem_multiplier`، والافتراضي 2.0 منذ PostgreSQL 15)، فإنه يُسكب إلى القرص (Batches > 1 في مخرجات EXPLAIN — علامة تحذير).

```sql
-- Tune work_mem per session for a known-expensive report query
SET work_mem = '256MB';
EXPLAIN ANALYZE SELECT ...;  -- re-examine the plan
RESET work_mem;
```

### ربط الدمج (Merge Join)

```
Merge Join  (cost=45678.00..56789.00 rows=24800 width=72)
  Merge Cond: (t.account_id = a.id)
  ->  Sort on transactions (account_id)
  ->  Sort on accounts     (id)
```

**الأفضل حين**: تكون العلاقتان مرتبتين أصلًا على مفتاح الربط (مثلًا لكلتيهما فهارس تُستخدم للترتيب)، أو يجب ترتيب النتيجة على ذلك المفتاح على أي حال. وهو أقل شيوعًا في أحمال OLTP من ربط الحلقات المتداخلة وربط التجزئة.

### فرض استراتيجيات الربط للاختبار

```sql
-- Disable hash join to force nested loop (diagnostic only)
SET enable_hashjoin = off;
EXPLAIN ANALYZE SELECT ...;
SET enable_hashjoin = on;

-- Disable nested loop to force hash join
SET enable_nestloop = off;
```

لا تعطّل أبدًا استراتيجيات الربط في الإنتاج. واستخدم هذه فقط لفهم قرارات المخطِّط.

## 4. خطط الاستعلام المتوازية

للاستعلامات التحليلية الكبيرة (مثل تقارير التسوية اليومية)، يستطيع PostgreSQL موازاة التنفيذ.

```sql
-- Check parallel query settings
SHOW max_parallel_workers_per_gather;  -- default 2
SHOW parallel_tuple_cost;
SHOW min_parallel_table_scan_size;

-- Enable for session if needed
SET max_parallel_workers_per_gather = 4;
```

```
Gather  (cost=1000.00..125678.00 rows=9876543 width=24)
        (actual time=0.456..8923.123 rows=9876543 loops=1)
  Workers Planned: 4
  Workers Launched: 4
  ->  Parallel Seq Scan on transactions
        (cost=0.00..124234.56 rows=2469136 width=24)
        (actual time=0.034..1234.567 rows=2469136 loops=5)
        Filter: (created_at >= '2024-01-01')
```

تجمع عقدة `Gather` النتائج من عمليات العمال. و`loops=5` تعني أن القائد + 4 عمال عالج كل منهم نحو 2.5 مليون صف.

**حالة استخدام مالية**: المطابقة في نهاية اليوم، وتقييم الاحتيال الدفعي، والتقارير الرقابية — تستفيد كثيرًا من الخطط المتوازية.

```sql
-- Let the planner use more workers for scans of this table
-- (it does not force a parallel plan)
ALTER TABLE transactions SET (parallel_workers = 8);

-- Or for the current session (e.g. a reporting job)
SET max_parallel_workers_per_gather = 8;
SET parallel_setup_cost = 100;      -- lower barrier to parallel
SET parallel_tuple_cost = 0.01;     -- lower cost per parallel tuple
```

## 5. ‏pg_stat_statements — تحديد الاستعلامات البطيئة

يجمّع `pg_stat_statements` إحصاءات تنفيذ الاستعلامات عبر كل الاستدعاءات. وهو أول أداة يُلجأ إليها عند التحقيق في أداء الإنتاج.

```sql
-- 1) postgresql.conf (needs a server RESTART):
-- shared_preload_libraries = 'pg_stat_statements'
-- pg_stat_statements.track = all
-- pg_stat_statements.max = 10000

-- 2) then, in the database:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

### إيجاد أكثر الاستعلامات كلفة

```sql
-- Top 20 queries by total execution time
SELECT
    LEFT(query, 120)                              AS query_preview,
    calls,
    ROUND(total_exec_time::numeric, 2)            AS total_ms,
    ROUND(mean_exec_time::numeric, 4)             AS mean_ms,
    ROUND(stddev_exec_time::numeric, 4)           AS stddev_ms,
    ROUND((100 * total_exec_time /
        SUM(total_exec_time) OVER ())::numeric, 2) AS pct_total,
    rows,
    shared_blks_hit,
    shared_blks_read,
    ROUND(shared_blks_hit::numeric /
        NULLIF(shared_blks_hit + shared_blks_read, 0) * 100, 1) AS cache_hit_pct
FROM pg_stat_statements
WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND calls > 100
ORDER BY total_exec_time DESC
LIMIT 20;
```

### إيجاد الاستعلامات ذات التباين العالي (أداء متقلب)

```sql
-- Queries with high stddev relative to mean are inconsistent
SELECT
    LEFT(query, 120) AS query_preview,
    calls,
    ROUND(mean_exec_time::numeric, 2)   AS mean_ms,
    ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
    ROUND(max_exec_time::numeric, 2)    AS max_ms,
    ROUND(stddev_exec_time / NULLIF(mean_exec_time, 0), 2) AS cv
FROM pg_stat_statements
WHERE calls > 50
  AND mean_exec_time > 1
ORDER BY cv DESC
LIMIT 20;
```

معامل الاختلاف المرتفع (CV > 2) يدل على تنازع الأقفال، أو تداخل نقاط التفتيش (checkpoints)، أو عدم استقرار الخطة.

### إعادة ضبط الإحصاءات

```sql
-- Reset statistics after a deployment or optimization
SELECT pg_stat_statements_reset();
```

## 6. ‏auto_explain — التقاط الخطط البطيئة في الإنتاج

يُظهر `pg_stat_statements` إحصاءات مجمّعة لا الخطة الفعلية. أما `auto_explain` فيسجّل مخرجات EXPLAIN ANALYZE الكاملة للاستعلامات التي تتجاوز عتبة.

```sql
-- Configure in postgresql.conf (or ALTER SYSTEM; preload needs a restart):
-- shared_preload_libraries = 'auto_explain'
-- auto_explain.log_min_duration = 1000    -- log queries > 1 second
-- auto_explain.log_analyze = true         -- include actual rows/timing; adds
--                                          -- overhead to EVERY sampled query,
--                                          -- so combine with sample_rate and
-- auto_explain.log_timing = false         -- (optionally) skip per-node timing
-- auto_explain.log_buffers = true         -- include buffer stats
-- auto_explain.log_format = text          -- or json for tooling
-- auto_explain.log_nested_statements = true
-- auto_explain.sample_rate = 0.01         -- 1% sample in high-volume systems
```

للاختبار على مستوى الجلسة (دون إعادة تشغيل؛ و`LOAD` يتطلب مستخدمًا خارقًا):

```sql
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 100;  -- 100 ms threshold
SET auto_explain.log_analyze = true;
SET auto_explain.log_buffers = true;

-- Now run your payment query and check PostgreSQL logs
SELECT * FROM transactions
WHERE account_id = 'acct_test'
ORDER BY created_at DESC
LIMIT 50;
```

## 7. تحسين الاستعلامات الخاصة بالدفع

### النمط 1: البحث عن الرصيد بمعرّف الحساب

هذا أعلى الاستعلامات تكرارًا في معظم أنظمة الدفع — يُستدعى عند كل تفويض معاملة.

```sql
-- Schema
CREATE TABLE accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_number VARCHAR(20) UNIQUE NOT NULL,
    balance        NUMERIC(19,4) NOT NULL DEFAULT 0,
    currency       CHAR(3) NOT NULL,
    status         VARCHAR(20) NOT NULL,
    version        BIGINT NOT NULL DEFAULT 0,  -- optimistic lock
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query (before optimization)
SELECT balance, currency, status, version
FROM accounts
WHERE account_number = $1;

-- EXPLAIN output IF account_number had no index
-- (here the UNIQUE constraint already creates one):
-- Seq Scan on accounts  (cost=0.00..1823.00 rows=1 width=36)
--   Filter: (account_number = $1)
```

إضافة الفهرس المناسب تحوّل هذا:

```sql
-- The UNIQUE constraint already creates an index on account_number
-- But verify it's being used:
EXPLAIN (ANALYZE, BUFFERS)
SELECT balance, currency, status, version
FROM accounts
WHERE account_number = $1;

-- Expected output:
-- Index Scan using accounts_account_number_key on accounts
--   (cost=0.42..8.44 rows=1 width=36)
--   (actual time=0.034..0.036 rows=1 loops=1)
--   Index Cond: (account_number = $1)
--   Buffers: shared hit=3
-- Planning Time: 0.112 ms
-- Execution Time: 0.058 ms
```

يمكن لفهرس مُغطٍّ أن يحوّل هذا إلى مسح من الفهرس فقط:

```sql
CREATE INDEX idx_accounts_balance_lookup
    ON accounts (account_number)
    INCLUDE (balance, currency, status, version);
```

**احذر في هذا الجدول.** فـ `balance` و`version` يتغيران مع كل دفعة. والأعمدة الموجودة في فهرس (بما فيها أعمدة `INCLUDE`) تعطّل تحديثات HOT الرخيصة في PostgreSQL، فيجب أن يكتب كل تحديث رصيد مدخلات فهرس جديدة أيضًا — إدخال/إخراج كتابة أكثر وانتفاخ في الفهرس. والصفحات كثيرة التحديث نادرًا ما تكون مرئية بالكامل، فيزور المسح "من الفهرس فقط" الـ heap مع ذلك. وللصفوف الساخنة كثيرة التحديث، يكون الفهرس الفريد العادي (3 إصابات مخزن، أقل بكثير من مللي ثانية) عادة المفاضلة الأفضل.

### النمط 2: سجل المعاملات حسب نطاق التاريخ

يشغّل هذا الاستعلام موجزات المعاملات المواجهة للعملاء وتوليد الكشوف.

```sql
-- Table schema
CREATE TABLE transactions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id),
    amount       NUMERIC(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL,
    type         VARCHAR(30) NOT NULL,
    reference    VARCHAR(100),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at   TIMESTAMPTZ
);

-- Naive query
SELECT id, amount, currency, status, type, reference, created_at
FROM transactions
WHERE account_id = $1
  AND created_at BETWEEN $2 AND $3
ORDER BY created_at DESC
LIMIT 50 OFFSET $4;
```

دون فهرس مناسب:

```sql
-- Bad: sequential scan with filter
-- Seq Scan on transactions (cost=0.00..158432.00 rows=1234 width=96)
--   Filter: (account_id = $1 AND created_at BETWEEN $2 AND $3)
```

مع الفهرس المركب المناسب:

```sql
-- Composite index: account_id first (equality), then created_at (range)
CREATE INDEX idx_transactions_account_date
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status, type, reference);

-- Now EXPLAIN shows:
-- Index Only Scan using idx_transactions_account_date on transactions
--   (cost=0.56..12.78 rows=50 width=96)
--   Index Cond: ((account_id = $1) AND
--                (created_at >= $2) AND (created_at <= $3))
--   Heap Fetches: 0
```

**القاعدة الأساسية**: ضع شروط المساواة أولًا في الفهرس المركب، وشروط النطاق أخيرًا. فهذا يتيح لشجرة B-tree تضييق البحث إلى معاملات حساب واحد قبل مسح نطاق التاريخ. (قائمة `INCLUDE` تكبّر الفهرس، وتضمين `status` يعني أن تغيير الحالة لم يعد يمكن أن يكون تحديث HOT — فضمّن فقط الأعمدة التي يحتاجها الاستعلام الساخن فعلًا.)

### النمط 3: عدّ المعاملات المعلقة (فحص الاحتيال)

```sql
-- Check how many pending transactions an account has (velocity check)
SELECT COUNT(*), SUM(amount)
FROM transactions
WHERE account_id = $1
  AND status = 'PENDING'
  AND created_at > NOW() - INTERVAL '24 hours';
```

حسّنه بفهرس جزئي:

```sql
-- Partial index: only index PENDING transactions
-- Keeps index small since most transactions eventually settle
CREATE INDEX idx_transactions_pending
    ON transactions (account_id, created_at)
    WHERE status = 'PENDING';

-- The planner will use this only when status = 'PENDING' is in the WHERE clause
EXPLAIN SELECT COUNT(*), SUM(amount)
FROM transactions
WHERE account_id = $1
  AND status = 'PENDING'
  AND created_at > NOW() - INTERVAL '24 hours';

-- Index Scan using idx_transactions_pending on transactions
--   (actual time=0.021..0.187 rows=3 loops=1)
```

### النمط 4: مطابقة التسوية (دفعي)

```sql
-- Daily settlement: sum all COMPLETED transactions by currency
-- This runs once per day but must complete in < 2 minutes
SELECT
    currency,
    COUNT(*) AS transaction_count,
    SUM(amount) AS total_amount,
    MIN(settled_at) AS first_settlement,
    MAX(settled_at) AS last_settlement
FROM transactions
WHERE settled_at >= $1  -- start of business day
  AND settled_at < $2   -- end of business day
  AND status = 'COMPLETED'
GROUP BY currency;
```

لهذا الاستعلام الدفعي، يكون تقليم الأقسام (partition pruning، يُغطى في الدرس 19) هو التحسين الأساسي. وإن لم يكن الجدول مقسمًا:

```sql
CREATE INDEX idx_transactions_settlement_date
    ON transactions (settled_at)
    WHERE status = 'COMPLETED';

-- Enable parallel workers for this large aggregation
SET max_parallel_workers_per_gather = 8;
SET work_mem = '512MB';  -- reduce hash aggregate spills
```

## 8. صيانة الإحصاءات

تقديرات كلفة المخطِّط جيدة بقدر جودة الإحصاءات فقط. ويخزّن `pg_statistic` مدرجات الأعمدة التي يحدّثها `ANALYZE`.

```sql
-- Check when tables were last analyzed
SELECT
    schemaname,
    tablename,
    last_analyze,
    last_autoanalyze,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct
FROM pg_stat_user_tables
WHERE tablename IN ('transactions', 'accounts')
ORDER BY n_live_tup DESC;
```

للأعمدة شديدة الانحراف (مثل `status` بنسبة 95% COMPLETED)، زِد هدف الإحصاءات:

```sql
-- Default statistics_target is 100 (100 histogram buckets)
-- Increase for columns with complex distributions
ALTER TABLE transactions
    ALTER COLUMN account_id SET STATISTICS 500;

ALTER TABLE transactions
    ALTER COLUMN status SET STATISTICS 200;

-- Then re-analyze
ANALYZE transactions;
```

الإحصاءات الموسعة للأعمدة المترابطة:

```sql
-- If account_id and status are correlated (each account has a status pattern),
-- multi-column statistics improve row estimates
CREATE STATISTICS stat_txn_account_status
    ON account_id, status
    FROM transactions;

ANALYZE transactions;

-- Check that statistics were computed
SELECT stxname, stxkeys, stxkind
FROM pg_statistic_ext
WHERE stxrelid = 'transactions'::regclass;
```

## 9. التكامل مع Java — تسجيل خطط الاستعلام

```java
@Service
@Slf4j
public class TransactionQueryService {

    private final JdbcTemplate jdbcTemplate;
    private final MeterRegistry meterRegistry;
    private final boolean planLoggingEnabled;

    public TransactionQueryService(JdbcTemplate jdbcTemplate,
                                   MeterRegistry meterRegistry,
                                   @Value("${app.plan-logging:false}") boolean planLoggingEnabled) {
        this.jdbcTemplate = jdbcTemplate;
        this.meterRegistry = meterRegistry;
        this.planLoggingEnabled = planLoggingEnabled;
    }

    /**
     * Balance lookup with query plan logging in development.
     * Uses parameterized query to allow plan caching.
     */
    public AccountBalance getBalance(String accountNumber) {
        Timer.Sample sample = Timer.start(meterRegistry);

        try {
            return jdbcTemplate.queryForObject(
                """
                SELECT balance, currency, status, version
                FROM accounts
                WHERE account_number = ?
                """,
                (rs, rowNum) -> new AccountBalance(
                    rs.getBigDecimal("balance"),
                    rs.getString("currency"),
                    rs.getString("status"),
                    rs.getLong("version")
                ),
                accountNumber
            );
        } finally {
            sample.stop(meterRegistry.timer("db.query",
                "query", "balance_lookup",
                "table", "accounts"));
        }
    }

    /**
     * Log query plan for a specific query in a development/staging context.
     * Never run EXPLAIN ANALYZE in production hot paths: it really EXECUTES
     * the query (including any INSERT/UPDATE) and adds timing overhead.
     * (@Profile only works on beans/@Bean methods, not on an ordinary
     * method -- so guard with a flag instead.)
     */
    public void logQueryPlan(String accountNumber) {
        if (!planLoggingEnabled) {          // e.g. @Value("${app.plan-logging:false}")
            return;
        }
        // Text EXPLAIN returns one row per plan line -- collect them all
        List<String> lines = jdbcTemplate.queryForList(
            """
            EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT balance, currency, status, version
            FROM accounts
            WHERE account_number = ?
            """,
            String.class,
            accountNumber
        );
        log.info("Query plan for balance_lookup:\n{}", String.join("\n", lines));
    }

    /**
     * Transaction history with pagination.
     * Uses keyset pagination instead of OFFSET for large datasets.
     * Best supported by an index on (account_id, created_at DESC, id DESC).
     */
    public List<TransactionSummary> getTransactionHistory(
            UUID accountId,
            Instant from,
            Instant to,
            UUID lastSeenId,       // keyset cursor
            Instant lastSeenDate,  // keyset cursor
            int limit) {

        String sql;
        Object[] params;

        if (lastSeenId == null) {
            // First page
            sql = """
                SELECT id, amount, currency, status, type, reference, created_at
                FROM transactions
                WHERE account_id = ?
                  AND created_at BETWEEN ? AND ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """;
            params = new Object[]{accountId, Timestamp.from(from), Timestamp.from(to), limit};
        } else {
            // Subsequent pages (keyset — no OFFSET scan)
            sql = """
                SELECT id, amount, currency, status, type, reference, created_at
                FROM transactions
                WHERE account_id = ?
                  AND created_at BETWEEN ? AND ?
                  AND (created_at, id) < (?, ?)
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """;
            // pgjdbc does not bind java.time.Instant directly -- use Timestamp
            // (or OffsetDateTime)
            params = new Object[]{accountId, Timestamp.from(from), Timestamp.from(to),
                                  Timestamp.from(lastSeenDate), lastSeenId, limit};
        }

        return jdbcTemplate.query(sql, (rs, rowNum) ->
            new TransactionSummary(
                rs.getObject("id", UUID.class),
                rs.getBigDecimal("amount"),
                rs.getString("currency"),
                rs.getString("status"),
                rs.getString("type"),
                rs.getString("reference"),
                rs.getTimestamp("created_at").toInstant()
            ),
            params
        );
    }
}
```

## 10. تحديد تراجعات الخطط في CI

أتمت التحقق من الخطط باستخدام Testcontainers:

```java
@SpringBootTest
@Testcontainers
class QueryPlanRegressionTest {

    @Container
    @ServiceConnection          // Spring Boot 3.1+: points the DataSource at the container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withDatabaseName("fintech_test")
        .withInitScript("schema.sql");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void balanceLookupShouldUseIndexScan() {
        // Seed enough data for the planner to prefer an index
        seedAccounts(100_000);
        jdbcTemplate.execute("ANALYZE accounts");   // fresh statistics for the planner

        String plan = jdbcTemplate.queryForObject(
            "EXPLAIN SELECT balance FROM accounts WHERE account_number = 'ACC0001'",
            String.class
        );

        assertThat(plan)
            .as("Balance lookup must use index scan, not sequential scan")
            .contains("Index")
            .doesNotContain("Seq Scan");
    }

    @Test
    void transactionHistoryShouldNotUseOffset() {
        // This test validates keyset pagination is used in service layer
        seedTransactions(500_000);
        jdbcTemplate.execute("ANALYZE transactions");

        String plan = jdbcTemplate.queryForObject(
            """
            EXPLAIN SELECT id, amount FROM transactions
            WHERE account_id = '00000000-0000-0000-0000-000000000001'
              AND created_at > NOW() - INTERVAL '30 days'
            ORDER BY created_at DESC, id DESC
            LIMIT 50
            """,
            String.class
        );

        assertThat(plan)
            .contains("Index")
            .doesNotContain("Seq Scan on transactions");
    }

    @Test
    void hashJoinShouldNotSpillToDisk() {
        // Hash join spill means work_mem is too low
        String plan = jdbcTemplate.queryForObject(
            """
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT t.id, a.account_number
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE t.created_at > NOW() - INTERVAL '1 day'
            """,
            String.class
        );

        // JSON plans name the field "Hash Batches"; 1 means no spill
        assertThat(plan).contains("\"Hash Batches\": 1");
    }
}
```

## 11. أدوات عرض EXPLAIN

لخطط الربط المتعددة المعقدة، يصعب التعامل مع المخرجات النصية. استخدم هذه الأدوات:

- **explain.depesz.com** — الصق مخرجات EXPLAIN النصية، لتحصل على كلفة العقد ملوّنة
- **explain.dalibo.com ‏(pev2)** — شجرة تفاعلية بأشرطة توقيت لكل عقدة
- **pgMustard** — توصيات آلية من مخرجات EXPLAIN

(قد تكشف الخطط أسماء الجداول والقيم الحرفية — اتبع قواعد بياناتك قبل لصقها في خدمة خارجية.)

لصيغة JSON (أفضل للأدوات):

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ...;

-- Returns a JSON array — feed to pev2 or store in monitoring
```

## 12. الخلاصة وقائمة فحص القرار

حين يكون استعلام دفع بطيئًا، اتبع هذا التسلسل:

1. **التقط الخطة**: `EXPLAIN (ANALYZE, BUFFERS)` أو افحص سجلات `auto_explain`
2. **قارن التقديرات بالفعلي**: إذا اختلفت بأكثر من 10 أضعاف، شغّل `ANALYZE` على الجدول
3. **افحص إحصاءات المخازن**: عدد `read` مرتفع ← إخفاق ذاكرة مخبئية ← يحتاج فهرسًا أو زيادة `shared_buffers`
4. **حدد العقدة المكلفة**: العقدة ذات أعلى كلفة حصرية في `actual time`
5. **افحص استراتيجية الربط**: Hash join مع Batches > 1 ← زِد `work_mem`
6. **افحص استخدام الفهارس**: مسح متتابع على جدول كبير يعيد صفوفًا قليلة فقط ← يحتاج فهرسًا
7. **افحص صفوف المرشح**: "Rows Removed by Filter" كبير ← فكّر في فهرس جزئي
8. **تحقق من الإحصاءات**: `pg_stat_user_tables` ← إحصاءات قديمة ← شغّل `ANALYZE`
9. **اختبر الإصلاح**: أعد تشغيل `EXPLAIN ANALYZE` للتحقق من التحسن
10. **أضف اختبار تراجع**: تأكيد خطة بـ Testcontainers في CI

> [!WARNING]
> لا تشغّل أبدًا `EXPLAIN ANALYZE` على المسارات الساخنة في الإنتاج ضمن شيفرة آلية. فهو ينفذ الاستعلام فعلًا — و`EXPLAIN ANALYZE UPDATE` يغيّر البيانات ما لم يُغلّف بمعاملة تتراجع عنها — ويضيف توقيته حملًا. واستخدم `pg_stat_statements` و`auto_explain` لتشخيص الإنتاج.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تُظهر مخرجات EXPLAIN ANALYZE ‏'Rows Removed by Filter: 95000' تحت عقدة Seq Scan. ماذا يدل هذا وما الإصلاح المناسب؟",
      "options": [
        "الاستعلام يعمل بشكل صحيح؛ والصفوف المحذوفة بالمرشح طبيعية لعبارات WHERE",
        "قرأ المسح 95,000 صف وتخلص منها ليعيد صفوفًا قليلة فقط — فالشرط انتقائي، وفهرس على العمود المرشَّح سيتيح مسح فهرس بدلًا من ذلك",
        "الجدول يحتاج VACUUM لإزالة الصفوف الميتة التي تسبب نتائج إيجابية كاذبة",
        "إعداد work_mem منخفض جدًا، فيسبب السكب إلى القرص"
      ],
      "correct": 1,
      "explanation": "‏'Rows Removed by Filter' الكبير تحت Seq Scan يعني أن قاعدة البيانات تقرأ كل الصفوف وتتخلص من معظمها. فإذا كان الشرط انتقائيًا (صفوف قليلة تطابق)، فإضافة فهرس على عمود المرشح ستتيح لـ PostgreSQL استخدام مسح فهرس لجلب الصفوف المطابقة فقط مباشرة، فيزول مسح الجدول الكامل."
    },
    {
      "text": "تُظهر EXPLAIN ANALYZE ‏'Hash Batches: 4' على ربط تجزئة. ماذا يعني هذا وكيف تصلحه؟",
      "options": [
        "استخدم الربط 4 عمال متوازين؛ زِد max_parallel_workers لتحسين الإنتاجية",
        "سُكب جدول التجزئة إلى القرص في 4 دفعات لأنه تجاوز work_mem؛ زِد work_mem لجلسة هذا الاستعلام كي يتسع جدول التجزئة في الذاكرة",
        "قسم مخطِّط الاستعلام الربط إلى 4 أجزاء للأمان؛ وهذا دائمًا الأمثل",
        "Hash Batches: 4 تعني أن 4 فهارس استُخدمت؛ فكّر في حذف الفهارس غير المستخدمة"
      ],
      "correct": 1,
      "explanation": "‏Hash Batches > 1 تعني أن جدول التجزئة لم يتسع في حد ذاكرته (work_mem × hash_mem_multiplier) فكُتب إلى القرص في دفعات متعددة. وهذا يزيد الإدخال/الإخراج كثيرًا. والإصلاح بزيادة work_mem ‏(SET work_mem = '256MB') للجلسة التي تشغّل هذا الاستعلام، أو لدور التقارير — لا عالميًا، لأن كل عملية تجزئة وترتيب في كل اتصال قد تستخدم ذلك القدر."
    },
    {
      "text": "ما ترقيم الصفحات بالمفتاح (keyset pagination) ولماذا يُفضّل على ترقيم OFFSET لجداول سجل المعاملات الكبيرة؟",
      "options": [
        "ترقيم المفتاح يستخدم ذاكرة Redis مخبئية لتخطي الصفوف؛ وOFFSET يستخدم مسحًا لقاعدة البيانات",
        "ترقيم المفتاح يرشّح بقيم آخر صف مرئي باستخدام WHERE (created_at, id) < (?, ?)، متجنبًا المسح الكامل الذي يتطلبه OFFSET لتخطي N صف",
        "ترقيم المفتاح متاح فقط في PostgreSQL 14+؛ وOFFSET يعمل على كل الإصدارات",
        "هما متكافئان في الأداء؛ ويُفضّل ترقيم المفتاح فقط لقابلية قراءة الشيفرة"
      ],
      "correct": 1,
      "explanation": "‏OFFSET N يتطلب من PostgreSQL مسح N صف والتخلص منها قبل إعادة النتائج — فتنمو الكلفة خطيًا مع رقم الصفحة. أما ترقيم المفتاح فيضيف عبارة WHERE تستخدم قيم مؤشر الصفحة الأخيرة، فيتيح لـ PostgreSQL القفز مباشرة إلى الموضع الصحيح باستخدام فهرس. ولجدول من 10 ملايين صف، تمسح الصفحة 1000 في ترقيم OFFSET ‏50,000 صف؛ بينما يمسح ترقيم المفتاح حجم الصفحة فقط."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تحسين استعلامات رصيد الحساب وسجل المعاملات",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "لاستعلام بطيء على جدول معاملات من 10 ملايين صف، اكتب مخرجات EXPLAIN (ANALYZE, BUFFERS) التي تتوقعها قبل وبعد إضافة فهرس مركب على (account_id, created_at DESC) INCLUDE (amount, currency, status)."},
    {"id": "2", "description": "نفّذ ترقيم المفتاح لسجل المعاملات في مستودع Spring JdbcTemplate، مع دعم التنقل بالمؤشر باستخدام (created_at, id) كمؤشر مركب."},
    {"id": "3", "description": "اكتب اختبار QueryPlanRegressionTest قائمًا على Testcontainers يزرع 500,000 صف معاملات ويؤكد أن استعلام سجل المعاملات يستخدم مسح فهرس لا مسحًا متتابعًا."},
    {"id": "4", "description": "اضبط auto_explain في PostgreSQL لتسجيل الاستعلامات الأبطأ من 100 مللي ثانية، واكتب ApplicationRunner في Spring Boot يتحقق من أن auto_explain نشط عند البدء في البيئات غير الإنتاجية."}
  ]
}
-->
