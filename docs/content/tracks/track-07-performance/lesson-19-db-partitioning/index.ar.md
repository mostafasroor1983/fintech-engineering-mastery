---
id: track-07-lesson-19
title: "تقسيم قواعد البيانات — استراتيجيات النطاق والتجزئة والقائمة"
slug: db-partitioning-strategies
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - partitioning
  - range-partition
  - hash-partition
  - list-partition
  - PostgreSQL
  - performance
prerequisites:
  - track-07-lesson-18
---

# تقسيم قاعدة البيانات — استراتيجيات النطاق والتجزئة والقائمة

جدول معاملات في التقنية المالية يراكم مليار صف خلال ثلاث سنوات ليس حالة حدية — بل هو المعتاد. وجدول PostgreSQL واحد ضخم بهذا الحجم ينتج ثلاث مشكلات ملموسة: يجب أن تمسح خطط الاستعلام فهارس B-tree هائلة، ويعمل `VACUUM` و`ANALYZE` لساعات وينافسان حمل الإنتاج، وحذف البيانات القديمة يتطلب مسحًا كاملًا للجدول عبر `DELETE`. والتقسيم التصريحي (declarative partitioning)، الذي قُدّم كميزة أساسية في PostgreSQL 10 ونضج كثيرًا في PostgreSQL 12–15، يحل المشكلات الثلاث بتقسيم البيانات فيزيائيًا إلى جداول أبناء أصغر مع تقديم جدول منطقي واحد للتطبيق.

## 1. لماذا التقسيم؟

قبل اللجوء إلى التقسيم، افهم المشكلات الثلاث المتمايزة التي يحلها:

### 1.1 انتفاخ الجدول وحجم الفهرس

قد يشغل فهرس B-tree على جدول من مليار صف 20–50 غيغابايت على القرص. وحين لا يتسع الجزء الساخن من الفهرس في الذاكرة (`shared_buffers` بالإضافة إلى ذاكرة صفحات نظام التشغيل)، تتحول عمليات البحث إلى إدخال/إخراج فيزيائي. ويقسم التقسيمُ الفهرسَ عبر الجداول الأبناء — فالاستعلام الذي يرشّح بـ `transaction_date` لا يحمّل إلا فهرس قسم ذلك الشهر.

### 1.2 أداء الاستعلام عبر تقليم الأقسام

يفحص مخطِّط الاستعلام حدود الأقسام ويستبعد الأقسام التي لا يمكن أن تحتوي صفوفًا مطابقة. ويسمى هذا **تقليم الأقسام (partition pruning)**. فاستعلام عن معاملات الشهر الماضي على جدول مقسم بالنطاق يمسح قسمًا واحدًا (لنقل 50 مليون صف) بدل ثلاث سنوات من البيانات (مليار صف) — تخفيض بمقدار 20 مرة في العمل.

### 1.3 كفاءة الصيانة

**‏VACUUM:** يعمل autovacuum في PostgreSQL قسمًا قسمًا. والأقسام القديمة التي لا كتابات فيها لا تحتاج تنظيفًا. والقسم الحالي وحده يولّد صفوفًا ميتة.

**دورة حياة البيانات:** حذف بيانات عمرها ثلاث سنوات هو `DROP TABLE transactions_2021_01` (فوري) بدل `DELETE FROM transactions WHERE transaction_date < '2022-01-01'` (ساعات من الإدخال/الإخراج، والانتفاخ، وتضخيم WAL).

## 2. التقسيم التصريحي في PostgreSQL

منذ PostgreSQL 10، تصرّح باستراتيجية التقسيم على الجدول الأب وتنشئ الأقسام الأبناء بـ `FOR VALUES`.

### 2.1 اختيار استراتيجية التقسيم

```
Decision tree for partition strategy:

Is your primary query filter a time-range column (created_at, transaction_date)?
  YES → Range partitioning on that column

Is your primary goal even data distribution for parallel query or write scaling?
  YES → Hash partitioning on the distribution key (account_id, customer_id)

Do you need to co-locate data by a categorical value (region, currency, status)?
  YES → List partitioning on that category
```

## 3. التقسيم بالنطاق حسب تاريخ المعاملة

التقسيم بالنطاق أكثر الاستراتيجيات شيوعًا في التقنية المالية. فجداول المدفوعات والمعاملات تنمو مع الوقت، وأكثر الاستعلامات ترشّح بالتواريخ الحديثة، وللبيانات القديمة متطلبات احتفاظ متوقعة (تحددها قواعد حفظ السجلات المالية ومكافحة غسل الأموال — غالبًا 5 إلى 7+ سنوات بحسب الولاية القضائية — ثم تُحذف).

### 3.1 إنشاء الجدول الأب المقسم

```sql
-- Parent table: no data lives here, only structure
CREATE TABLE transactions (
    transaction_id      BIGSERIAL,
    account_id          BIGINT          NOT NULL,
    transaction_date    DATE            NOT NULL,
    amount_cents        BIGINT          NOT NULL,
    currency            CHAR(3)         NOT NULL,
    transaction_type    VARCHAR(20)     NOT NULL,
    status              VARCHAR(20)     NOT NULL DEFAULT 'PENDING',
    reference           VARCHAR(100),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    PRIMARY KEY (transaction_id, transaction_date)  -- partition key must be in PK
) PARTITION BY RANGE (transaction_date);
```

**مهم:** يجب تضمين مفتاح التقسيم (`transaction_date`) في المفتاح الأساسي. وهذا قيد في PostgreSQL — فالفهارس الفريدة والمفاتيح الأساسية يجب أن تتضمن مفتاح التقسيم.

### 3.2 إنشاء أقسام شهرية

```sql
-- 2024 partitions
CREATE TABLE transactions_2024_01
    PARTITION OF transactions
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE transactions_2024_02
    PARTITION OF transactions
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

CREATE TABLE transactions_2024_03
    PARTITION OF transactions
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');

-- ... continue for all months

CREATE TABLE transactions_2024_12
    PARTITION OF transactions
    FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');

-- Default partition catches rows that do not match any explicit partition
-- Use this as a safety net; monitor it and move rows to proper partitions.
-- Caveats: creating a new partition must check the default partition (and
-- FAILS if it already holds rows for the new range), and
-- DETACH ... CONCURRENTLY is not allowed while a default partition exists.
CREATE TABLE transactions_default
    PARTITION OF transactions
    DEFAULT;
```

### 3.3 فهارس الأقسام

تُنشأ الفهارس على الجدول الأب تلقائيًا على كل قسم ابن:

```sql
-- Index on parent = index on all partitions (created automatically for new partitions)
CREATE INDEX idx_transactions_account_date
    ON transactions (account_id, transaction_date);

CREATE INDEX idx_transactions_status
    ON transactions (status)
    WHERE status IN ('PENDING', 'PROCESSING');  -- partial index

-- For a specific high-traffic partition, you can add an extra index
CREATE INDEX idx_transactions_2024_12_created
    ON transactions_2024_12 (created_at)
    INCLUDE (amount_cents, currency);
```

### 3.4 التحقق من تقليم الأقسام

شغّل `EXPLAIN` للتحقق من أن PostgreSQL يقلّم الأقسام بشكل صحيح:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT transaction_id, amount_cents, currency
FROM transactions
WHERE account_id = 42
  AND transaction_date >= '2024-11-01'
  AND transaction_date  < '2024-12-01';
```

مقتطف المخرجات المتوقعة (قسم واحد فقط يظهر في الخطة):

```
Index Scan using transactions_2024_11_account_id_transaction_date_idx
      on transactions_2024_11 transactions
  Index Cond: ((account_id = 42) AND (transaction_date >= '2024-11-01'::date)
               AND (transaction_date < '2024-12-01'::date))
  Buffers: shared hit=4
```

الأقسام المقلّمة وقت التخطيط لا تظهر في الخطة ببساطة. وحين يحدث التقليم وقت التشغيل (مثلًا مع معاملات الربط في خطة مُعدّة عامة)، تُظهر الخطة `Subplans Removed: N` تحت عقدة `Append` بدلًا من ذلك.

إذا ظهر كل قسم في الخطة، فمفتاح التقسيم ليس في عبارة WHERE، أو طُبّقت عليه دالة (`WHERE EXTRACT(MONTH FROM transaction_date) = 11` يعطّل التقليم — استخدم شروط النطاق مباشرة).

## 4. التقسيم بالتجزئة حسب معرّف الحساب

يقسم التقسيم بالتجزئة البيانات بحساب تجزئة مفتاح التقسيم مقسومة على عدد الأقسام (باقي القسمة). استخدمه حين:
- تحتاج توزيعًا متساويًا للكتابات عبر الأقسام (بلا أقسام ساخنة)
- ترشّح استعلاماتك كثيرًا بمفتاح التجزئة (account_id)
- تريد موازاة العمليات عبر الأقسام

### 4.1 إنشاء جدول مقسم بالتجزئة

```sql
CREATE TABLE account_balances (
    account_id      BIGINT          NOT NULL,
    currency        CHAR(3)         NOT NULL,
    balance_cents   BIGINT          NOT NULL,
    last_updated    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    version         BIGINT          NOT NULL DEFAULT 0,  -- for optimistic locking
    PRIMARY KEY (account_id, currency)
) PARTITION BY HASH (account_id);
```

### 4.2 إنشاء أقسام التجزئة

```sql
-- 8 partitions: PostgreSQL computes (hash(account_id) % 8) to route rows
CREATE TABLE account_balances_p0
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 0);

CREATE TABLE account_balances_p1
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 1);

CREATE TABLE account_balances_p2
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 2);

CREATE TABLE account_balances_p3
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 3);

CREATE TABLE account_balances_p4
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 4);

CREATE TABLE account_balances_p5
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 5);

CREATE TABLE account_balances_p6
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 6);

CREATE TABLE account_balances_p7
    PARTITION OF account_balances
    FOR VALUES WITH (MODULUS 8, REMAINDER 7);
```

**اختيار عدد الأقسام:** قوى العدد 2 تسهّل إعادة التقسيم مستقبلًا. وابدأ بعدد أنوية المعالج في أكبر نسخة قراءة لديك، أو عدد العمال المتوازين (`max_parallel_workers_per_gather`). ولـ account_balances بـ 100 مليون حساب و8 أقسام، يحمل كل قسم نحو 12.5 مليون صف — حجم فهرس مريح.

### 4.3 التحقق من التوزيع المتساوي

```sql
SELECT
    tableoid::regclass AS partition,
    COUNT(*)           AS row_count
FROM account_balances
GROUP BY tableoid
ORDER BY partition;

-- Expected (should be within 2% of each other):
-- account_balances_p0 | 12,489,344
-- account_balances_p1 | 12,502,117
-- account_balances_p2 | 12,494,890
-- ...
```

## 5. التقسيم بالقائمة حسب المنطقة

يعيّن التقسيم بالقائمة قيمًا محددة لأقسام محددة. والاستخدامات المعتادة في التقنية المالية هي العمليات لكل منطقة (احتفاظ مختلف، أو نوافذ صيانة، أو مهام دفعية لكل منطقة) وإبقاء البيانات الإقليمية قابلة للفصل. ملاحظة عن **إقامة البيانات (data residency)**: لا يشترط GDPR تخزين بيانات الاتحاد الأوروبي داخله — بل يقيّد *نقلها* خارج المنطقة الاقتصادية الأوروبية (قرارات الكفاية، والبنود التعاقدية القياسية). وبعض القواعد الوطنية أو القطاعية وعقود العملاء تشترط التخزين المحلي فعلًا؛ وليس في PCI DSS قاعدة لموقع البيانات.

### 5.1 إنشاء جدول مقسم بالقائمة

```sql
CREATE TABLE customer_profiles (
    customer_id     BIGINT          NOT NULL,
    region          VARCHAR(10)     NOT NULL,  -- EU, US, APAC, LATAM
    email           VARCHAR(255)    NOT NULL,
    full_name       VARCHAR(200)    NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    gdpr_consent    BOOLEAN         NOT NULL DEFAULT false,
    PRIMARY KEY (customer_id, region)
) PARTITION BY LIST (region);
```

### 5.2 إنشاء أقسام القائمة

```sql
-- Each partition can have multiple values
CREATE TABLE customer_profiles_eu
    PARTITION OF customer_profiles
    FOR VALUES IN ('EU', 'UK', 'CH', 'NO');

CREATE TABLE customer_profiles_us
    PARTITION OF customer_profiles
    FOR VALUES IN ('US', 'CA', 'MX');

CREATE TABLE customer_profiles_apac
    PARTITION OF customer_profiles
    FOR VALUES IN ('APAC', 'AU', 'NZ', 'SG', 'JP');

CREATE TABLE customer_profiles_latam
    PARTITION OF customer_profiles
    FOR VALUES IN ('LATAM', 'BR', 'AR', 'CO');

-- Default partition for regions not yet explicitly mapped
CREATE TABLE customer_profiles_other
    PARTITION OF customer_profiles
    DEFAULT;
```

### 5.3 مساحات الجداول ليست إقامة بيانات

مساحة الجداول (tablespace) مجرد مجلد على **خادم قاعدة البيانات نفسه**. فتستطيع وضع الأقسام على أقراص مختلفة (مثلًا الأقسام القديمة على تخزين أرخص)، لكنك لا تستطيع وضع قسم من جدول في مركز بيانات آخر: فتركيب تخزين بعيد لملفات بيانات PostgreSQL غير آمن، والخادم وسجل WAL والنسخ الاحتياطية والنسخ المتماثلة ستبقى في مكان واحد.

```sql
-- Legitimate use: move cold partitions to cheaper local storage
CREATE TABLESPACE archive_storage LOCATION '/mnt/archive-disk/pgdata';
ALTER TABLE transactions_2021_01 SET TABLESPACE archive_storage;
-- (SET TABLESPACE rewrites the table under an ACCESS EXCLUSIVE lock)
```

حين يجب أن تبقى البيانات فعلًا في بلد أو منطقة، شغّل **عنقود قاعدة بيانات منفصلًا في تلك المنطقة** (بنسخه المتماثلة ونسخه الاحتياطية الخاصة) ووجّه العملاء إليه في طبقة التطبيق.

## 6. عمليات صيانة الأقسام

### 6.1 إضافة قسم جديد

أنشئ دائمًا القسم التالي قبل وصول البيانات. واستخدم مهمة مجدولة أو pg_partman.

```sql
-- Create next month's partition (run this in mid-month)
CREATE TABLE transactions_2025_01
    PARTITION OF transactions
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

### 6.2 فصل قسم للأرشفة

يجعل DETACH الجدول الابن جدولًا مستقلًا (تغيير في البيانات الوصفية). ويأخذ `DETACH PARTITION` العادي قفل `ACCESS EXCLUSIVE` على الأب — قصيرًا، لكنه يحجب الاستعلامات أثناء انتظاره. ويتجنب `DETACH ... CONCURRENTLY` ‏(PostgreSQL 14+) ذلك، لكنه لا يعمل داخل كتلة معاملة ولا يُسمح به ما دام للجدول قسم افتراضي.

```sql
-- Step 1: Detach (PostgreSQL 14+, no default partition on the table)
ALTER TABLE transactions
    DETACH PARTITION transactions_2021_01 CONCURRENTLY;

-- Without CONCURRENTLY (or before PostgreSQL 14) the detach takes a
-- brief ACCESS EXCLUSIVE lock on the parent -- set a lock_timeout

-- Step 2: Verify data, then archive or drop
-- Archive to cold storage (export to Parquet/S3 first if needed)
DROP TABLE transactions_2021_01;  -- Near-instant, no bloat, minimal WAL
```

### 6.3 ربط جدول موجود كقسم

تستطيع ربط جدول مملوء مسبقًا كقسم. ويتحقق PostgreSQL من أن كل الصفوف تحقق قيد القسم.

```sql
-- Pre-populate in a separate table (e.g., migrated from legacy system)
CREATE TABLE transactions_2019_legacy (LIKE transactions INCLUDING ALL);
-- ... bulk load data ...

-- Attach: PostgreSQL scans the table to validate constraints
ALTER TABLE transactions
    ATTACH PARTITION transactions_2019_legacy
    FOR VALUES FROM ('2019-01-01') TO ('2020-01-01');
```

لتخطي المسح الكامل للجدول أثناء الربط (حين تعرف أن البيانات صالحة):

```sql
-- Add constraint first (fast CHECK, no scan needed)
ALTER TABLE transactions_2019_legacy
    ADD CONSTRAINT chk_date
    CHECK (transaction_date >= '2019-01-01' AND transaction_date < '2020-01-01')
    NOT VALID;

-- Validate: this DOES scan the table, but with a weaker lock
-- (SHARE UPDATE EXCLUSIVE), so normal reads and writes continue
ALTER TABLE transactions_2019_legacy VALIDATE CONSTRAINT chk_date;

-- Now attach without rescan (PostgreSQL trusts the validated constraint)
ALTER TABLE transactions
    ATTACH PARTITION transactions_2019_legacy
    FOR VALUES FROM ('2019-01-01') TO ('2020-01-01');
```

## 7. ‏pg_partman لإدارة الأقسام آليًا

إنشاء الأقسام يدويًا عرضة للخطأ في الإنتاج. و`pg_partman` امتداد لـ PostgreSQL يؤتمت إنشاء الأقسام وصيانتها والاحتفاظ بها.

### 7.1 التثبيت

```sql
-- Install extension (requires pg_partman to be installed on the OS)
-- Ubuntu/Debian: apt install postgresql-16-partman
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION pg_partman SCHEMA partman;
```

### 7.2 ضبط الإدارة الآلية

```sql
-- Set up pg_partman (5.x syntax) to manage the transactions table
-- Creates monthly partitions, premake=4 means create 4 future partitions in advance.
-- pg_partman also creates its own default partition by default -- do not
-- create a second one by hand.
SELECT partman.create_parent(
    p_parent_table   => 'public.transactions',
    p_control        => 'transaction_date',
    p_type           => 'range',
    p_interval       => '1 month',
    p_premake        => 4,       -- create 4 months ahead
    p_start_partition => '2024-01-01'::text
);

-- Configure retention (drop partitions older than 7 years)
UPDATE partman.part_config
SET retention              = '7 years',
    retention_keep_table   = false,  -- actually drop
    infinite_time_partitions = true,
    automatic_maintenance  = 'on'
WHERE parent_table = 'public.transactions';
```

### 7.3 الصيانة المجدولة

```sql
-- Run from pg_cron or an external scheduler (every 1 hour)
SELECT partman.run_maintenance();

-- Or configure pg_cron:
-- CREATE EXTENSION pg_cron;
-- SELECT cron.schedule('0 * * * *', 'SELECT partman.run_maintenance()');
```

## 8. الاستعلامات عبر الأقسام وكلفتها

### 8.1 حين لا يساعد التقليم

```sql
-- BAD: No partition key in WHERE clause — full scan of all partitions
SELECT COUNT(*)
FROM transactions
WHERE status = 'FAILED';

-- EXPLAIN shows:
-- Append (all 36 partitions scanned)
-- estimated rows: 1,000,000,000
```

لنمط الاستعلام هذا خياران:
1. **فهرس جزئي على كل قسم:** `CREATE INDEX ON transactions (status) WHERE status = 'FAILED'` — سريع لكل قسم، لكن كل الأقسام الـ 36 ما زالت تُزار.
2. **جدول ملخص/تجميع منفصل:** احتفظ بجدول `transaction_status_counts` تحدّثه المشغّلات (triggers) أو التطبيق. فتصبح التجميعات عبر الأقسام بحثًا عن صف واحد.

### 8.2 المفاتيح الأجنبية عبر الجداول المقسمة

المفاتيح الأجنبية التي تشير إلى جدول مقسم مدعومة منذ PostgreSQL 12، لكن مع تحفظ:

```sql
-- This works in PostgreSQL 12+
ALTER TABLE transaction_line_items
    ADD CONSTRAINT fk_transaction
    FOREIGN KEY (transaction_id, transaction_date)
    REFERENCES transactions (transaction_id, transaction_date);
```

فحص المفتاح الأجنبي يمسح القسم الصحيح (يُطبّق التقليم)، فالأداء مقبول. لكن يجب أن يتضمن المفتاح الأجنبي مفتاح التقسيم — سبب آخر لتضمين `transaction_date` دائمًا في المفتاح الأساسي.

### 8.3 الاستعلام المتوازي عبر الأقسام

يستطيع PostgreSQL الاستعلام عن الأقسام بالتوازي باستخدام `max_parallel_workers_per_gather`:

```sql
-- Enable parallel query for cross-partition aggregation
SET max_parallel_workers_per_gather = 8;

-- The planner may now use up to 8 workers (also limited by
-- max_parallel_workers and max_worker_processes), e.g. a Parallel Append
-- that spreads partitions across workers
SELECT
    DATE_TRUNC('month', transaction_date) AS month,
    SUM(amount_cents) AS total_volume,
    COUNT(*)          AS transaction_count
FROM transactions
WHERE transaction_date >= '2024-01-01'
GROUP BY 1
ORDER BY 1;
```

## 9. مقارنة استراتيجيات التقسيم

```
+------------------+-----------+------------+-----------+-----------+
| Criterion        | Range     | Hash       | List      | None      |
+------------------+-----------+------------+-----------+-----------+
| Time-based query | Excellent | Poor       | Poor      | Poor      |
| Write hot spots  | High      | None       | Medium    | High      |
| Data residency   | Possible  | No         | Natural   | No        |
| Pruning ease     | Automatic | Needs key  | Automatic | N/A       |
| Data archival    | Trivial   | Manual     | Manual    | Expensive |
| Partition count  | Bounded   | Fixed      | Variable  | N/A       |
| Maintenance      | pg_partman| Manual     | Manual    | None      |
+------------------+-----------+------------+-----------+-----------+
```

## 10. مزالق الإنتاج

### المزلق 1: القسم المفقود يسبب فشل الإدراج

**المشكلة:** دون قسم افتراضي، يرفع إدراج صف لا تطابق قيمة مفتاح تقسيمه أي قسم موجود خطأً. فإذا لم يكن pg_partman قد أنشأ قسم الشهر التالي بعد وعبر طابع زمني في نهاية الشهر الحد، تفشل إدراجات الدفع لديك.

**مثال فاشل:**

```sql
-- It is 2024-12-31 23:59:59. The 2025-01 partition does not exist yet.
INSERT INTO transactions (account_id, transaction_date, amount_cents, currency, transaction_type, status)
VALUES (42, '2025-01-01', 10000, 'USD', 'DEBIT', 'PENDING');

-- ERROR:  no partition of relation "transactions" found for row
-- DETAIL:  Failing row contains (42, 2025-01-01, 10000, USD, DEBIT, PENDING).
```

**النهج الصحيح:**

```sql
-- Always have a default partition as a safety net
CREATE TABLE transactions_default
    PARTITION OF transactions
    DEFAULT;

-- Monitor the default partition for unexpected rows
CREATE OR REPLACE FUNCTION alert_on_default_partition_growth()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    row_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO row_count FROM transactions_default;
    IF row_count > 1000 THEN
        RAISE WARNING 'Default partition has % rows — a named partition may be missing', row_count;
    END IF;
END;
$$;
```

واضبط أيضًا pg_partman بـ `p_premake = 4` وجدول `run_maintenance()` ليعمل كل ساعة، لا مرة يوميًا. وتذكّر: حالما تستقر صفوف في القسم الافتراضي، يفشل إنشاء القسم المسمى المطابق حتى تنقل تلك الصفوف — فنبّه مبكرًا.

### المزلق 2: الدوال على مفتاح التقسيم (أو العمود الخطأ) تعطّل التقليم

**المشكلة:** لا يعمل التقليم إلا على مفتاح التقسيم نفسه مستخدمًا مباشرة. وتطبيق دالة عليه — أو الترشيح بعمود آخر مثل `created_at` حين يكون الجدول مقسمًا بـ `transaction_date` — يعني أن المخطِّط لا يستطيع استبعاد أقسام. والنتيجة مسح عبر كل الأقسام.

**مثال فاشل:**

```sql
-- BAD: function applied to the partition key — pruning disabled
EXPLAIN SELECT * FROM transactions
WHERE EXTRACT(MONTH FROM transaction_date) = 11
  AND EXTRACT(YEAR  FROM transaction_date) = 2024;

-- Result: Append (all 36 partitions scanned)

-- ALSO BAD: created_at is not the partition key
EXPLAIN SELECT * FROM transactions
WHERE created_at >= '2024-11-15' AND created_at < '2024-11-16';
```

**النهج الصحيح:**

```sql
-- GOOD: a range predicate directly on the partition column
EXPLAIN SELECT * FROM transactions
WHERE transaction_date >= '2024-11-01'
  AND transaction_date  < '2024-12-01';

-- Result: only transactions_2024_11 is scanned
```

ينطبق هذا على كل استدعاءات الدوال: `EXTRACT(YEAR FROM ...)`، و`TO_CHAR(...)`، و`CAST(... AS DATE)`. فاستخدم دائمًا شروط نطاق مباشرة على مفتاح التقسيم. وإذا ولّدت أداة ORM أو أداة تقارير مرشحات مغلفة بدوال، فأصلح توليد الاستعلام — وإذا كان المستخدمون يبحثون غالبًا بطابع زمني آخر، فأضف نطاق مفتاح التقسيم إلى تلك الاستعلامات أيضًا (مثلًا `transaction_date` بين اليوم السابق واليوم التالي).

### المزلق 3: القيود الفريدة الشاملة غير ممكنة عبر الأقسام

**المشكلة:** لا يستطيع PostgreSQL إنشاء فهرس فريد عبر كل أقسام جدول مقسم ما لم يتضمن الفهرس الفريد مفتاح التقسيم. وهذا يكسر النمط الشائع لفرض التفرد على مفتاح عمل مثل `reference` أو `idempotency_key`.

**مثال فاشل:**

```sql
-- FAILS: reference is not part of the partition key (transaction_date)
CREATE UNIQUE INDEX uq_transactions_reference
    ON transactions (reference);

-- ERROR: insufficient columns in UNIQUE constraint definition
-- DETAIL: UNIQUE constraint on table "transactions" lacks column "transaction_date"
-- which is part of the partition key.
```

**النُّهج الصحيحة:**

```sql
-- Option 1: Include partition key in unique constraint
-- This allows the same reference to appear in different months (acceptable for
-- some payment references that are scoped to a time period)
CREATE UNIQUE INDEX uq_transactions_reference_date
    ON transactions (reference, transaction_date);

-- Option 2: Enforce global uniqueness in a separate lookup table
CREATE TABLE transaction_idempotency (
    idempotency_key VARCHAR(100) PRIMARY KEY,
    transaction_id  BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Application inserts here first (single non-partitioned table),
-- then inserts into the partitioned transactions table.
-- This separates uniqueness enforcement from bulk storage.
```

نهج على مستوى التطبيق باستخدام جدول البحث — احجز المفتاح **أولًا**، كي لا يمر مكرران متزامنان معًا:

```java
@Transactional
public PaymentResult submitPayment(PaymentRequest request) {
    long transactionId = transactionRepository.nextId();   // from the sequence

    // 1) Claim the idempotency key FIRST (non-partitioned table, so the
    //    global UNIQUE constraint works):
    //    INSERT INTO transaction_idempotency (idempotency_key, transaction_id)
    //    VALUES (?, ?) ON CONFLICT (idempotency_key) DO NOTHING
    //    A concurrent duplicate waits on the unique index until we commit,
    //    then inserts nothing.
    boolean claimed = idempotencyRepository.insertIfAbsent(
        request.idempotencyKey(), transactionId);

    if (!claimed) {
        // Duplicate: return the ORIGINAL result (and, ideally, check that the
        // request body matches the original -- same key + different payload
        // is a client error)
        return PaymentResult.duplicate(
            idempotencyRepository.findTransactionId(request.idempotencyKey()));
    }

    // 2) Insert into the partitioned table -- same transaction, so if this
    //    fails, the claimed key is rolled back too
    transactionRepository.insert(Transaction.from(request, transactionId));

    return PaymentResult.created(transactionId);
}
```

## 11. قائمة الفحص التشغيلية

- [ ] الجدول الأب منشأ بعبارة `PARTITION BY`؛ ولا بيانات مخزنة مباشرة في الأب
- [ ] المفتاح الأساسي يتضمن عمود (أعمدة) مفتاح التقسيم
- [ ] يوجد قسم افتراضي كشبكة أمان للصفوف خارج النطاق
- [ ] القسم الافتراضي مراقب للنمو غير المتوقع (تنبيه عند > 1000 صف)
- [ ] ‏pg_partman مضبوط بـ `p_premake >= 4` لإنشاء الأقسام المستقبلية مسبقًا
- [ ] ‏`run_maintenance()` مجدول كل ساعة (لا يوميًا) لتجنب فجوات الحدود
- [ ] كل قوالب الاستعلامات تستخدم شروط نطاق مباشرة على أعمدة التقسيم (بلا دوال)
- [ ] مخرجات `EXPLAIN` مُتحقق منها لتُظهر الأقسام المتوقعة فقط (أو `Subplans Removed: N` للتقليم وقت التشغيل) لاستعلامات النطاق الزمني
- [ ] فصل الأقسام يستخدم `CONCURRENTLY` ‏(PostgreSQL 14+، بلا قسم افتراضي) أو `lock_timeout` قصيرًا لتجنب الحجب
- [ ] سياسة الاحتفاظ موثقة ومؤتمتة (عمود retention في `part_config`)
- [ ] المفاتيح الأجنبية تتضمن مفتاح التقسيم
- [ ] متطلبات التفرد الشامل مُعالجة عبر جدول بحث منفصل غير مقسم
- [ ] ‏`max_parallel_workers_per_gather` مضبوط لاستعلامات التجميع عبر الأقسام
- [ ] حجم القسم الشهري مُتحقق منه ليبقى تحت 50 مليون صف (أعد تقييم الفترة إن كان أكبر)

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"جدول مقسم بالنطاق حسب transaction_date. تشغّل EXPLAIN على استعلام يجب أن يصيب شهرًا واحدًا فترى كل الأقسام الـ 36 في الخطة. ما السبب الأرجح؟","options":["ليس للجدول فهارس","مفتاح التقسيم مغلف بدالة في عبارة WHERE (مثل EXTRACT(MONTH FROM transaction_date) = 11)، أو يرشّح الاستعلام بعمود آخر مثل created_at","الاستعلام تجميع عبر الأقسام","إصدار PostgreSQL أقدم من 10"],"correct":1,"explanation":"يتطلب تقليم الأقسام أن يستخدم شرط الاستعلام عمود مفتاح التقسيم مباشرة، بصيغة يستطيع المخطِّط مقارنتها بحدود الأقسام. وتطبيق دالة مثل EXTRACT() أو TO_CHAR() أو تحويل نوع على مفتاح التقسيم — أو الترشيح بعمود مختلف فقط — يعني أن المخطِّط لا يستطيع معرفة الأقسام التي يمكن أن تطابق، فيجب أن يمسحها كلها. فاستخدم دائمًا شروط نطاق مباشرة: WHERE transaction_date >= '2024-11-01' AND transaction_date < '2024-12-01'."},{"text":"لماذا يجب أن يتضمن المفتاح الأساسي لجدول مقسم عمود مفتاح التقسيم؟","options":["يشترطه PostgreSQL لأن الفهارس الفريدة لا تستطيع تجاوز حدود الأقسام","يحسّن أداء تقليم الأقسام","مطلوب فقط للجداول المقسمة بالتجزئة","إنه توصية، لا متطلب صارم"],"correct":0,"explanation":"يفرض PostgreSQL أن أي فهرس فريد (بما فيه المفتاح الأساسي) على جدول مقسم يجب أن يتضمن مفتاح التقسيم. وذلك لأن PostgreSQL ينفذ التفرد لكل قسم: فدون مفتاح التقسيم، قد يكون لصف في القسم A وصف في القسم B قيم متطابقة للعمود الفريد، ولا يستطيع PostgreSQL منع ذلك دون فهرس شامل (غير موجود للجداول المقسمة). وإذا احتجت تفردًا شاملًا على عمود ليس مفتاح التقسيم، فاستخدم جدول بحث منفصلًا غير مقسم."},{"text":"ما الطريقة الآمنة تشغيليًا لإزالة البيانات القديمة من جدول مقسم بالنطاق في PostgreSQL؟","options":["DELETE FROM transactions WHERE transaction_date < '2021-01-01'","TRUNCATE TABLE transactions WHERE transaction_date < '2021-01-01'","ALTER TABLE transactions DETACH PARTITION transactions_2020_12 CONCURRENTLY، ثم DROP TABLE transactions_2020_12","UPDATE transactions SET deleted = true WHERE transaction_date < '2021-01-01'"],"correct":2,"explanation":"DETACH PARTITION ثم DROP TABLE هو النهج الصحيح. وDETACH عملية على البيانات الوصفية؛ ومع CONCURRENTLY ‏(PostgreSQL 14+، وفقط حين لا يكون للجدول قسم افتراضي) لا يحجب القراءات أو الكتابات المتزامنة على الأب — وإلا فيحتاج قفل ACCESS EXCLUSIVE قصيرًا. وDROP TABLE على الابن المفصول شبه فوري ويولّد WAL ضئيلًا. وفي المقابل، يلمس DELETE كل صف قديم، ويولّد WAL هائلًا، وينشئ انتفاخ صفوف ميتة يتطلب VACUUM، وينافس حمل الإنتاج. وTRUNCATE ... WHERE ليست SQL صالحة."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"تنفيذ التقسيم في PostgreSQL","difficulty":"advanced","estimatedMinutes":90,"tasks":[{"id":"task-1","description":"أنشئ جدول معاملات مقسمًا بالنطاق حسب transaction_date ‏(نوع DATE). وأنشئ 12 قسمًا شهريًا لعام 2024، وقسمًا افتراضيًا، وفهرسًا مركبًا على (account_id, transaction_date). وشغّل EXPLAIN ANALYZE على استعلام يرشّح لشهر واحد وأكّد أن المخرجات تُظهر استبعاد كل الأقسام الأخرى. ووثّق مخرجات EXPLAIN في تعليق في ملف SQL."},{"id":"task-2","description":"أنشئ جدول account_balances مقسمًا بالتجزئة حسب account_id بـ 8 أقسام. وأدرج 100,000 صف بمعرّفات حسابات موزعة عشوائيًا (من 1 إلى 1,000,000). وشغّل استعلام التحقق من التوزيع وأكّد أن أي قسم لا يزيد على أي قسم آخر بأكثر من 15,000 صف. وسجّل أعداد الصفوف في تعليق SQL."},{"id":"task-3","description":"بيّن مزلق التفرد الشامل: حاول إنشاء فهرس فريد على transactions(reference) دون تضمين transaction_date ووثّق رسالة خطأ PostgreSQL الدقيقة. ثم نفّذ حل الجدولين (جدول بحث transaction_idempotency + جدول معاملات مقسم). واكتب دالة Java بـ @Transactional تُدرج في الجدولين وتتعامل مع DataIntegrityViolationException كإشارة دفعة مكررة."},{"id":"task-4","description":"ثبّت pg_partman (أو حاكِ منطقه بدالة PL/pgSQL) واضبط إنشاء أقسام شهرية آليًا لجدول المعاملات مع إنشاء 4 أشهر مسبقًا واحتفاظ 7 سنوات. واكتب استعلام SQL يعدّ الصفوف في القسم الافتراضي ويرفع WARNING إذا تجاوز العدد 500. وجدوله باستخدام pg_cron أو وثّق تعبير cron الذي يجب استخدامه لتشغيل run_maintenance() كل ساعة."}]} -->
