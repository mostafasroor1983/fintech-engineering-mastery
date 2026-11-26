---
id: track-08-lesson-03
title: "MVCC — التحكم في التزامن متعدد الإصدارات بالتفصيل"
slug: mvcc
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 3
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [MVCC, versioning, snapshot-isolation, vacuum, bloat]
prerequisites: []
---

# ‏MVCC — تعمق في التحكم في التزامن متعدد النسخ

> [!NOTE]
> ‏MVCC هو ما يتيح لـ PostgreSQL خدمة آلاف المعاملات المتزامنة دون أن يحجب القرّاء الكتّاب. وفهمه على مستوى الداخليات أساسي لتشخيص تباطؤ الاستعلامات الغامض، ومنع انقطاعات التفاف معرّفات المعاملات، وتصميم مخططات مالية كثيفة التحديث لا تراكم الانتفاخ بصمت حتى تنهار.

## 1. المشكلة الأساسية التي يحلها MVCC

لقواعد البيانات الكلاسيكية القائمة على الأقفال نسخة واحدة من كل صف. فإذا أراد قارئ القراءة بينما يمسك كاتب قفلًا، يُحجب القارئ. وفي نظام دفع عالي الإنتاجية يعالج آلاف المعاملات في الثانية، فإن حجب القرّاء بالكتّاب سيكون كارثيًا على الزمن.

يحل MVCC ذلك بالاحتفاظ **بنسخ متعددة من كل صف في الوقت نفسه**. فينشئ الكتّاب نسخًا جديدة. ويرى القرّاء النسخة المناسبة للقطة معاملتهم. ولا حجب بين القرّاء والكتّاب.

والثمن: تتراكم النسخ القديمة ويجب تنظيفها — وهي مهمة **VACUUM**.

## 2. داخليات MVCC في PostgreSQL — ‏xmin وxmax

### 2.1 أعمدة النظام المخفية

يحمل كل صف في PostgreSQL (يُسمى "tuple") عمودي نظام مخفيين:

| العمود | المعنى |
|---------|---------|
| ‏`xmin` | معرّف المعاملة التي أنشأت (أدرجت) هذه النسخة |
| ‏`xmax` | معرّف المعاملة التي حذفت هذه النسخة أو حدّثتها (0 إن كانت ما تزال حية) |

```sql
-- See the hidden columns on the accounts table
SELECT xmin, xmax, ctid, account_id, balance
FROM accounts
WHERE account_id = 'ACC-1001';

-- ctid is the physical location: (page, row_offset)
-- xmin is when this version was created
-- xmax is when this version was superseded (0 = still current)
```

مخرجات نموذجية:

```
 xmin  | xmax  |  ctid  | account_id  | balance
-------+-------+--------+-------------+---------
 15420 |     0 | (0,42) | ACC-1001    | 1500.00
```

### 2.2 ماذا يحدث أثناء UPDATE

حين تحدّث صفًا، لا يعدّل PostgreSQL النسخة الموجودة في مكانها. بل:
1. يعلّم `xmax` في النسخة القديمة بمعرّف المعاملة الحالية
2. يُدرج **نسخة جديدة** بـ `xmin` = معرّف المعاملة الحالية وقيم الأعمدة الجديدة

```sql
-- Before UPDATE:
-- xmin=15420, xmax=0, balance=1500.00

UPDATE accounts SET balance = 1200.00 WHERE account_id = 'ACC-1001';

-- After UPDATE (two tuples exist simultaneously):
-- Old: xmin=15420, xmax=15500, balance=1500.00
--      (still visible to snapshots taken before 15500 committed)
-- New: xmin=15500, xmax=0,     balance=1200.00
--      (visible to snapshots taken after 15500 committed)
-- Visibility depends on COMMIT status and snapshots, not on comparing ids
```

لهذا تكون التحديثات أكلف مما قد تتوقع — فكل تحديث يكتب نسخة صف جديدة كاملة (ومدخلات فهرس جديدة أيضًا، ما لم يكن تحديث HOT — القسم 8.2).

### 2.3 ‏DELETE

يضبط DELETE ‏`xmax` على النسخة الموجودة بمعرّف المعاملة الحاذفة. وتبقى النسخة على القرص فيزيائيًا حتى يزيلها VACUUM.

```sql
-- Before DELETE:
-- xmin=15420, xmax=0, balance=1500.00

DELETE FROM accounts WHERE account_id = 'ACC-1001';

-- After DELETE:
-- xmin=15420, xmax=15600, balance=1500.00
-- (invisible to snapshots taken after 15600 committed)
-- The row still occupies space on disk — VACUUM needed to reclaim it
```

## 3. لقطات المعاملات وقواعد الرؤية

### 3.1 كيف تعمل اللقطات

حين تبدأ معاملة (أو تُنفذ عبارة، بحسب مستوى العزل)، يلتقط PostgreSQL **لقطة** تحتوي:

- **xmin:** أدنى معرّف معاملة ما زالت تعمل (كل ما دونه انتهى)
- **xmax:** واحد بعد أعلى معرّف معاملة منتهية (كل ما بعده "في المستقبل")
- **xip_list:** معرّفات المعاملات في [xmin, xmax) التي كانت ما تزال تعمل عند أخذ اللقطة

بتبسيط، تكون النسخة **مرئية** للقطة إذا:
1. التزم `tuple.xmin`، وكان أقل من `xmax` في اللقطة، وليس في `xip_list` (أو كان تغيير المعاملة الحالية نفسها)، و
2. كان `tuple.xmax` صفرًا (أو أُلغيت المعاملة الحاذفة)، أو كانت المعاملة الحاذفة غير مرئية للقطة — ما زالت في `xip_list`، أو عند `xmax` أو فوقه، أو غير ملتزمة

```sql
-- Inspect current transaction snapshot
-- (pg_current_snapshot() since PostgreSQL 13; txid_current_snapshot() is the
--  older, deprecated name)
SELECT pg_current_snapshot();
-- Returns something like: 15490:15502:15491,15499
-- Format: xmin:xmax:xip_list
-- xmin=15490: oldest active transaction
-- xmax=15502: next unassigned ID
-- xip_list=15491,15499: these are running and not visible yet
```

### 3.2 عزل اللقطة مقابل لقطات العبارة

هذا هو الفرق الأساسي بين READ COMMITTED وREPEATABLE READ:

```sql
-- READ COMMITTED: snapshot per STATEMENT
BEGIN;
-- Statement 1: takes snapshot S1 at this point
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- (another session commits an update here)
-- Statement 2: takes snapshot S2 — includes the new commit
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns updated value!
COMMIT;

-- REPEATABLE READ: snapshot at TRANSACTION START
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- Snapshot S1 taken at transaction start
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- (another session commits an update here)
-- Still uses snapshot S1
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns original value — repeatable!
COMMIT;
```

## 4. عزل اللقطة وانحراف الكتابة

يمنع REPEATABLE READ القراءات غير القابلة للتكرار والقراءات الشبحية، لكنه لا يمنع انحراف الكتابة — شذوذ دقيق تقرأ فيه معاملتان بيانات متداخلة وتتخذان قرارات صالحة فرديًا لكنها غير متسقة مجتمعة.

### 4.1 انحراف الكتابة في تفويض الدفع

```sql
-- Scenario: an account has two sub-accounts. Combined balance must stay >= 0.
-- ACC-1001: balance = 500
-- ACC-1002: balance = 500

-- Transaction T1 (payment of 600 from ACC-1001):
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT SUM(balance) FROM accounts WHERE customer_id = 'CUST-001';
-- Returns 1000: 1000 - 600 = 400 >= 0, so proceed
UPDATE accounts SET balance = balance - 600 WHERE account_id = 'ACC-1001';

-- Transaction T2 (concurrent payment from ACC-1002):
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- T2 also reads combined balance: 500 + 500 = 1000 (same snapshot!)
SELECT SUM(balance) FROM accounts WHERE customer_id = 'CUST-001';
-- Returns 1000: proceed with 600 debit from ACC-1002
UPDATE accounts SET balance = balance - 600 WHERE account_id = 'ACC-1002';

-- T1 commits: ACC-1001 = -100 (500 - 600)
-- T2 commits: ACC-1002 = -100 (500 - 600)
-- Total balance = -200! Both passed validation, but combined they're wrong.
-- They updated DIFFERENT rows, so no row lock or update conflict stopped them.
```

### 4.2 إصلاح انحراف الكتابة

```java
// Option 1: Use SERIALIZABLE isolation
@Transactional(isolation = Isolation.SERIALIZABLE)
public void authorisePayment(String customerId, String accountId,
                              BigDecimal amount) {
    // PostgreSQL SSI detects the rw-anti-dependency and aborts one transaction
    BigDecimal combinedBalance = accountRepository
        .sumBalanceByCustomer(customerId);

    if (combinedBalance.subtract(amount).compareTo(BigDecimal.ZERO) < 0) {
        throw new InsufficientFundsException();
    }

    accountRepository.debit(accountId, amount);
}

// Option 2: Lock a "guardian" row to serialize the check
@Transactional
public void authorisePaymentWithLock(String customerId, String accountId,
                                      BigDecimal amount) {
    // Lock the customer record — serializes all payment authorisations
    // for this customer
    customerRepository.lockForUpdate(customerId);

    BigDecimal combinedBalance = accountRepository
        .sumBalanceByCustomer(customerId);

    if (combinedBalance.subtract(amount).compareTo(BigDecimal.ZERO) < 0) {
        throw new InsufficientFundsException();
    }

    accountRepository.debit(accountId, amount);
}
```

## 5. ‏VACUUM والنسخ الميتة

### 5.1 لماذا يوجد VACUUM

بعد عمليات UPDATE وDELETE، تتراكم النسخ الميتة. ودون تنظيف:
1. تنمو الجداول بلا حد (الانتفاخ)
2. يجب أن تمسح الاستعلامات صفحات أكثر لإيجاد النسخ الحية
3. قد يوقف التفاف معرّفات المعاملات قاعدة البيانات (يُغطى أدناه)

يزيل VACUUM النسخ الميتة التي لم تعد مرئية لأي معاملة نشطة.

```sql
-- Manually run VACUUM on the accounts table
VACUUM accounts;

-- VACUUM ANALYZE: clean dead tuples AND update statistics
VACUUM ANALYZE accounts;

-- VACUUM VERBOSE: show detailed progress
VACUUM VERBOSE accounts;
```

### 5.2 ‏AUTOVACUUM

يشغّل عفريت autovacuum في PostgreSQL ‏VACUUM تلقائيًا بناءً على عتبات قابلة للضبط:

```sql
-- Check autovacuum activity
SELECT schemaname,
       relname AS tablename,
       last_autovacuum,
       last_autoanalyze,
       n_dead_tup,
       n_live_tup,
       round(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2)
           AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

المُطلق الافتراضي لـ autovacuum: ينطلق حين تتجاوز النسخ الميتة `autovacuum_vacuum_threshold` ‏(50) + `autovacuum_vacuum_scale_factor` ‏(0.2) × عدد صفوف الجدول.

لجدول من 1,000,000 صف: ينطلق عند 50 + 200,000 = 200,050 نسخة ميتة.

**المشكلة:** جدول معاملات مالية يستقبل 10,000 تحديث في الثانية سيراكم نسخًا ميتة أسرع مما يستطيع autovacuum الافتراضي معالجته.

### 5.3 ضبط AUTOVACUUM للجداول المالية

```sql
-- Per-table autovacuum tuning for high-churn financial tables
ALTER TABLE accounts SET (
    autovacuum_vacuum_scale_factor = 0.01,  -- 1% (default: 20%)
    autovacuum_analyze_scale_factor = 0.005, -- 0.5% (default: 10%)
    autovacuum_vacuum_cost_delay = 2,         -- ms between cost checks (default: 2)
    autovacuum_vacuum_cost_limit = 400        -- cost units per round (default: 200)
);

-- For extremely hot tables (e.g., balance updates on main accounts):
ALTER TABLE accounts SET (
    autovacuum_vacuum_scale_factor = 0.001,  -- 0.1%
    autovacuum_vacuum_threshold = 100,        -- absolute row threshold
    autovacuum_analyze_scale_factor = 0.001
);
```

```ini
# postgresql.conf global settings for high-volume fintech
autovacuum_max_workers = 6          # default: 3
autovacuum_vacuum_cost_delay = 2ms  # default: 2ms
autovacuum_vacuum_cost_limit = 400  # default: 200
autovacuum_naptime = 15s            # default: 1min — check more frequently
```

## 6. انتفاخ الجداول — القياس والمعالجة

### 6.1 فهم الانتفاخ

الانتفاخ هو الفجوة بين الحجم المنطقي للجدول (البيانات الحية) وحجمه الفيزيائي على القرص (الحية + الميتة + المساحة الفارغة من عمليات تنظيف سابقة). وأحمال UPDATE الثقيلة في الأنظمة المالية معرضة للانتفاخ بشكل خاص.

```sql
-- Quick bloat estimate using pgstattuple extension
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT *
FROM pgstattuple('accounts');
-- Returns: table_len, tuple_count, tuple_len, dead_tuple_count,
--          dead_tuple_len, free_space, free_percent
```

```sql
-- Dead tuples and table size per table (no extension needed; a rough
-- signal, not an exact bloat measurement)
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
    n_dead_tup,
    n_live_tup,
    round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
ORDER BY n_dead_tup DESC;
```

### 6.2 ‏VACUUM FULL مقابل pg_repack

يعيد `VACUUM FULL` كتابة الجدول كاملًا، فيستعيد الانتفاخ تمامًا لكنه يمسك قفل `ACCESS EXCLUSIVE` (يحجب كل القراءات والكتابات):

```sql
-- DANGEROUS in production: locks the table completely
VACUUM FULL accounts;
```

للأنظمة المالية الإنتاجية، استخدم `pg_repack`، الذي يعيد كتابة الجداول أثناء العمل. ويحتاج مفتاحًا أساسيًا (أو فهرسًا فريدًا) على الجدول، ومساحة قرص إضافية للنسخة، ويأخذ أقفال `ACCESS EXCLUSIVE` قصيرة في البداية والنهاية:

```bash
# Install pg_repack (package name matches your PostgreSQL major version)
apt-get install postgresql-16-repack

# Repack a bloated table online (no long locks)
pg_repack -d payments_db -t accounts --no-kill-backend

# Repack an index (also reclaims index bloat)
pg_repack -d payments_db -i accounts_account_id_idx
```

### 6.3 مراقبة انتفاخ الفهارس

```sql
-- Index sizes and usage
-- (pg_stat_user_indexes names its columns relname / indexrelname)
SELECT
    relname      AS tablename,
    indexrelname AS indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Check for unused indexes (candidates for removal -- but keep UNIQUE /
-- primary key indexes, and check read replicas first: idx_scan counts
-- only this server)
SELECT
    s.schemaname,
    s.relname      AS tablename,
    s.indexrelname AS indexname,
    pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
    s.idx_scan AS times_used
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

## 7. ‏VACUUM FREEZE والتفاف معرّفات المعاملات

### 7.1 مشكلة الالتفاف

يستخدم PostgreSQL معرّفات معاملات بـ 32 بت تُقارن في دائرة: فلا يمكن أن يكون إلا نحو ملياري معرّف "في الماضي" في أي وقت. والنسخة التي يكون `xmin` لها أقدم من ذلك ستبدو فجأة "في المستقبل" وتصبح غير مرئية. ويمنع PostgreSQL فقد البيانات هذا **برفض تعيين معرّفات معاملات جديدة** (لا كتابات بعدها) حين يقترب أقدم معرّف غير مجمّد من ذلك الحد — انقطاع حتى يجمّد VACUUM الصفوف القديمة.

هذا ليس نظريًا. ففي الأنظمة المالية الإنتاجية التي تعالج ملايين المعاملات يوميًا، انقطاع الحماية من الالتفاف خطر تشغيلي حقيقي.

### 7.2 كيف يعمل التجميد (FREEZE)

يعلّم التجميد النسخ القديمة بأنها "مجمّدة": مرئية لكل معاملة، مهما تقدم عداد المعرّفات. (منذ PostgreSQL 9.4 هذا بت علم على النسخة؛ والإصدارات الأقدم كانت تستبدل `xmin` بـ `FrozenTransactionId = 2`.) ويجمّد ‏(auto)vacuum العادي النسخ الأقدم من `vacuum_freeze_min_age`؛ و`VACUUM FREEZE` يجمّد كل ما يستطيع.

```sql
-- Check current transaction ID distance from wraparound
SELECT
    datname,
    age(datfrozenxid) AS xid_age,
    2000000000 - age(datfrozenxid) AS xids_remaining
FROM pg_database
ORDER BY age(datfrozenxid) DESC;
-- WARNING: If xid_age approaches 2 billion, you face a forced shutdown

-- Check per-table frozen XID age (join on the OID, not the name:
-- the same table name can exist in several schemas)
SELECT
    t.schemaname,
    t.relname,
    age(c.relfrozenxid) AS xid_age,
    t.n_dead_tup
FROM pg_class c
JOIN pg_stat_user_tables t ON c.oid = t.relid
ORDER BY age(c.relfrozenxid) DESC
LIMIT 20;
```

```ini
# postgresql.conf: freeze settings (the DEFAULTS are shown -- start here,
# and make sure autovacuum keeps up before changing them)
vacuum_freeze_min_age = 50000000          # freeze tuples older than 50M xids
vacuum_freeze_table_age = 150000000       # aggressive (whole-table) vacuum at 150M
autovacuum_freeze_max_age = 200000000     # anti-wraparound autovacuum at 200M,
                                          # even if autovacuum is disabled
```

### 7.3 التجميد الطارئ

```sql
-- If xid_age is dangerously high (approaching 1.5B), force a freeze
VACUUM FREEZE VERBOSE accounts;

-- For the entire database (very expensive, blocks autovacuum workers)
-- Only in an emergency
VACUUM FREEZE;
```

ما يحدث مع نمو العمر:
- فوق `autovacuum_freeze_max_age` ‏(200 مليون): يفرض PostgreSQL **عمليات autovacuum لمنع الالتفاف** — مسوح ثقيلة للجدول كاملًا قد تظهر كتدهور أداء مفاجئ بلا سبب ظاهر.
- فوق `vacuum_failsafe_age` ‏(1.6 مليار، PostgreSQL 14+): يتحول vacuum إلى وضع "أمان" سريع، يتخطى التقييد القائم على الكلفة وتنظيف الفهارس.
- قبل الحد بنحو 40 مليون معرّف: تظهر تحذيرات في السجل.
- قبل الحد بنحو 3 ملايين معرّف: يتوقف PostgreSQL عن تعيين معرّفات المعاملات — فتفشل الكتابات حتى تُنظّف قاعدة البيانات.

راقب `age(datfrozenxid)` استباقيًا ونبّه قبل أي من هذه بوقت طويل.

## 8. أثر MVCC على الجداول المالية كثيفة التحديث

### 8.1 الجداول الساخنة في أنظمة الدفع

جدول أرصدة `accounts` هو عادة أسخن جدول في نظام الدفع:
- كل دفعة تخصم من مرسل وتضيف إلى مستلم (تحديثان لكل معاملة)
- عند 1,000 معاملة في الثانية: 2,000 تحديث لصفوف الحسابات في الثانية
- كل UPDATE ينشئ نسخة صف جديدة
- بإعدادات autovacuum الافتراضية، يتراكم الانتفاخ بسرعة

### 8.2 تحديثات HOT ‏(Heap-Only Tuples)

لدى PostgreSQL تحسين يسمى HOT ‏(Heap-Only Tuple) يقلل حمل UPDATE حين:
1. لا تكون الأعمدة المحدّثة جزءًا من أي فهرس
2. تتسع النسخة الجديدة في الصفحة نفسها التي فيها النسخة القديمة

تتجنب تحديثات HOT إنشاء مدخلات فهرس جديدة، فتقلل تضخيم الكتابة كثيرًا.

```sql
-- Check HOT update efficiency for accounts table
SELECT
    relname,
    n_tup_upd AS total_updates,
    n_tup_hot_upd AS hot_updates,
    round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 2) AS hot_pct
FROM pg_stat_user_tables
WHERE relname = 'accounts';
-- Hot PCT below 50% suggests index-heavy table or high fillfactor issues
```

### 8.3 ضبط FILLFACTOR لتحديثات HOT

يتحكم `fillfactor` في مدى امتلاء الصفحات مبدئيًا. وترك مساحة فارغة يتيح لتحديثات HOT وضع النسخة الجديدة في الصفحة نفسها التي فيها القديمة.

```sql
-- Set fillfactor to 70% for the accounts table
-- This leaves 30% free space on each page for in-place HOT updates
ALTER TABLE accounts SET (fillfactor = 70);

-- Rebuild the table to apply the new fillfactor
VACUUM FULL accounts;  -- Or use pg_repack for online rebuild

-- After setting fillfactor, monitor HOT update percentage
-- Should increase significantly
```

**قاعدة تقريبية لجداول الحسابات المالية:**
- معدل UPDATE مرتفع جدًا، وأعمدة مفهرسة قليلة: `fillfactor = 70`
- معدل UPDATE متوسط: `fillfactor = 80`
- إدراجات/قراءات في الغالب: `fillfactor = 90-100` (الافتراضي 100)

### 8.4 تصميم المخطط لتقليل حمل MVCC

```sql
-- BAD: Storing balance on the account row causes heavy MVCC overhead
-- Every transaction updates a hot row
CREATE TABLE accounts_bad (
    account_id  VARCHAR(20) PRIMARY KEY,
    customer_id VARCHAR(20) NOT NULL,
    balance     NUMERIC(19, 4) NOT NULL,  -- Updated on every transaction
    updated_at  TIMESTAMPTZ NOT NULL
);

-- BETTER: Compute balance from an immutable transaction ledger
-- Only append INSERTs, never UPDATEs on the main ledger
CREATE TABLE ledger_entries (
    entry_id        BIGSERIAL PRIMARY KEY,
    account_id      VARCHAR(20) NOT NULL,
    amount          NUMERIC(19, 4) NOT NULL,  -- positive=credit, negative=debit
    transaction_ref VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Balance is a query, not a stored value
-- For performance, maintain a materialized balance with controlled update frequency
CREATE TABLE account_balances (
    account_id      VARCHAR(20) PRIMARY KEY,
    balance         NUMERIC(19, 4) NOT NULL,
    as_of_entry_id  BIGINT NOT NULL,  -- last ledger entry included in balance
    updated_at      TIMESTAMPTZ NOT NULL
);
```

## 9. تشخيص مشكلات MVCC في الإنتاج

### 9.1 تحديد المعاملات طويلة التشغيل

المعاملات طويلة التشغيل تمنع VACUUM من تنظيف النسخ الميتة التي نشأت بعد بدئها:

```sql
-- Find transactions older than 5 minutes
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    backend_start,
    xact_start,
    now() - xact_start AS duration,
    state,
    left(query, 100) AS current_query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
  AND now() - xact_start > INTERVAL '5 minutes'
ORDER BY xact_start;

-- Kill a problematic long-running transaction (graceful)
SELECT pg_cancel_backend(pid);

-- Kill forcefully (last resort)
SELECT pg_terminate_backend(pid);
```

### 9.2 فحص فتحات النسخ التي تحجب VACUUM

تسبب فتحات النسخ (replication slots، التي تستخدمها أدوات CDC مثل Debezium، والنسخ المتماثلة) مشكلتين حين يتأخر المستهلك أو يختفي: يحتفظ الخادم الأساسي **بكل WAL** لم تستهلكه الفتحة (فقد يمتلئ القرص)، ويمنع `xmin` / `catalog_xmin` في الفتحة VACUUM من إزالة الصفوف الأحدث من تلك النقطة (الفتحات المنطقية تؤخر جداول النظام؛ والفتحات الفيزيائية مع `hot_standby_feedback` تؤخر كل الجداول).

```sql
-- Check replication slot lag
SELECT
    slot_name,
    plugin,
    slot_type,
    active,
    xmin,
    catalog_xmin,
    restart_lsn,
    confirmed_flush_lsn,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
        AS retained_wal_size
FROM pg_replication_slots;

-- If retained WAL is large and growing, the consumer is lagging.
-- Safety net (PostgreSQL 13+): max_slot_wal_keep_size = '50GB' -- a slot
-- that would need more WAL than this is invalidated instead of filling
-- the disk (the consumer must then re-snapshot).
```

### 9.3 استعلام فحص صحة MVCC الكامل

```sql
-- Comprehensive MVCC health check
SELECT
    'XID Age' AS metric,
    age(datfrozenxid)::text AS value,
    CASE
        WHEN age(datfrozenxid) > 1500000000 THEN 'CRITICAL'
        WHEN age(datfrozenxid) > 500000000  THEN 'WARNING'
        ELSE 'OK'
    END AS status
FROM pg_database WHERE datname = current_database()

UNION ALL

SELECT
    'Dead Tuple % (accounts)' AS metric,
    round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2)::text AS value,
    CASE
        WHEN n_dead_tup::float / NULLIF(n_live_tup + n_dead_tup, 0) > 0.2 THEN 'WARNING'
        ELSE 'OK'
    END AS status
FROM pg_stat_user_tables
WHERE relname = 'accounts';
```

## 10. مرجع إعداد الإنتاج

```ini
# postgresql.conf settings for a high-TPS fintech PostgreSQL instance

# MVCC and VACUUM
autovacuum = on
autovacuum_max_workers = 6
autovacuum_naptime = 15s
autovacuum_vacuum_threshold = 50
autovacuum_vacuum_scale_factor = 0.01   # 1% for most tables
autovacuum_analyze_threshold = 50
autovacuum_analyze_scale_factor = 0.005 # 0.5%
autovacuum_vacuum_cost_delay = 2ms
autovacuum_vacuum_cost_limit = 400
autovacuum_freeze_max_age = 200000000
vacuum_freeze_min_age = 50000000
vacuum_freeze_table_age = 150000000

# Shared buffers and memory (affects how many dead tuples stay in memory)
shared_buffers = 4GB                   # 25% of RAM
work_mem = 64MB                        # per sort/hash operation, per query node
                                       # (x many connections: size carefully)
maintenance_work_mem = 1GB             # manual VACUUM, CREATE INDEX
autovacuum_work_mem = 512MB            # per autovacuum worker (x max_workers)
```

## الخلاصة

‏MVCC أساس نموذج التزامن في PostgreSQL. فكل UPDATE وDELETE ينشئ نسخ صفوف ميتة يجب أن ينظفها VACUUM. والخلاصات الأساسية للأنظمة المالية:

- **‏xmin/xmax** علامتا الإصدار على كل نسخة — افهمهما للتفكير في الرؤية
- **عزل اللقطة** يعطي كل معاملة (أو عبارة في READ COMMITTED) رؤية متسقة في لحظة زمنية
- **انحراف الكتابة** هو النقطة العمياء لـ REPEATABLE READ — استخدم SERIALIZABLE أو القفل الصريح للقرارات المالية
- **‏AUTOVACUUM** يجب ضبطه بحدة للجداول المالية الساخنة — زِد العمال، وخفّض معاملات المقياس
- **تحديثات HOT** تقلل تضخيم الكتابة حين لا تكون أعمدة الرصيد مفهرسة — اضبط fillfactor وفقًا لذلك
- **التفاف معرّفات المعاملات** خطر إيقاف لقاعدة البيانات — راقب `age(datfrozenxid)` في الإنتاج
- **المعاملات طويلة التشغيل** و**تأخر فتحات النسخ** تحجب VACUUM — نبّه على كليهما

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يضبط UPDATE في PostgreSQL على جدول الحسابات الرصيد لـ 500 صف. كم نسخة صف توجد على القرص فور اكتمال UPDATE (بافتراض عدم تشغيل VACUUM)؟",
      "options": [
        "500 — النسخ الجديدة فقط موجودة؛ فـ PostgreSQL يستبدل النسخ في مكانها",
        "1,000 — 500 نسخة قديمة بـ xmax مضبوط و500 نسخة جديدة بـ xmin مضبوط",
        "500 نسخة جديدة بالإضافة إلى أي نسخ قديمة ما زالت مرئية للمعاملات النشطة",
        "يعتمد على ما إذا كان التحديث استخدم تحسين HOT ‏(Heap-Only Tuple)"
      ],
      "correct": 1,
      "explanation": "لا يعدّل MVCC في PostgreSQL النسخ في مكانها أبدًا. فكل UPDATE ينشئ نسخة جديدة (xmin = معرّف المعاملة الحالية) ويعلّم النسخة القديمة كمحذوفة (xmax = معرّف المعاملة الحالية). وتتعايش النسختان على القرص حتى يزيل VACUUM النسخ الميتة. فـ 500 تحديث تنشئ 500 نسخة قديمة ميتة + 500 نسخة جديدة حية = 1,000 نسخة فيزيائية لـ 500 صف منطقي."
    },
    {
      "text": "يحتوي جدول حسابات خدمة الدفع لديك 10 ملايين صف تُحدّث بمعدل 2,000 صف في الثانية (كل دفعة تخصم من مرسل وتضيف إلى مستلم). والقيمة الافتراضية لـ autovacuum_vacuum_scale_factor هي 0.2 ‏(20%). كم نسخة ميتة تتراكم قبل أن ينطلق autovacuum؟",
      "options": [
        "50 نسخة ميتة (القيمة الافتراضية لـ autovacuum_vacuum_threshold)",
        "2,000,050 نسخة ميتة (20% من 10 ملايين صف + عتبة 50)",
        "200,000 نسخة ميتة في الدقيقة (2,000 × 60 ثانية ولا يهم معامل المقياس)",
        "ينطلق فورًا لأن الجدول جدول مالي ساخن"
      ],
      "correct": 1,
      "explanation": "ينطلق autovacuum حين تتجاوز النسخ الميتة: autovacuum_vacuum_threshold ‏(50) + autovacuum_vacuum_scale_factor ‏(0.2) × n_live_tup ‏(10 ملايين) = 50 + 2,000,000 = 2,000,050 نسخة ميتة. وعند 2,000 تحديث في الثانية، تُبلغ هذه العتبة في نحو 1,000 ثانية (نحو 17 دقيقة). وخلال تلك الدقائق الـ 17 تتراكم النسخ الميتة — فيسبب ذلك انتفاخ الجدول واستعلامات أبطأ. والإصلاح ضبط لكل جدول: autovacuum_vacuum_scale_factor = 0.01 يخفض المُطلق إلى 100,050 نسخة ميتة."
    },
    {
      "text": "فتحة نسخ لموصّل Debezium CDC غير نشطة منذ 48 ساعة بسبب تعطل الموصّل. ما الخطر التشغيلي والمعالجة الصحيحة؟",
      "options": [
        "لا خطر — سينظف PostgreSQL الفتحة القديمة تلقائيًا بعد 24 ساعة",
        "لا يمكن إزالة مقاطع WAL التي لم تستهلكها الفتحة، فقد يمتلئ القرص؛ احذف الفتحة بـ pg_drop_replication_slot() بعد التأكد من إمكانية استعادة فجوة البيانات عبر لقطة جديدة",
        "تؤثر الفتحة على النسخة المتماثلة أو الموصّل فقط، لا على قاعدة البيانات الأساسية أبدًا",
        "أعد تشغيل PostgreSQL لمسح فتحة النسخ القديمة"
      ],
      "correct": 1,
      "explanation": "تمنع فتحات النسخ PostgreSQL من إزالة مقاطع WAL التي لم تستهلكها الفتحة بعد. والفتحة غير النشطة لمدة 48 ساعة تعني 48 ساعة من تراكم WAL — ما قد يملأ القرص بسهولة في قاعدة بيانات دفع عالية المعاملات. (والفتحة المنطقية تؤخر أيضًا catalog_xmin، فيتأخر تنظيف جداول النظام.) ولا يحذف PostgreSQL الفتحات القديمة بنفسه؛ ومنذ الإصدار 13 يمكن لـ max_slot_wal_keep_size إبطال فتحة تتأخر كثيرًا. والمعالجة: (1) تحقق من أن الموصّل ميت فعلًا، (2) احذف الفتحة بـ pg_drop_replication_slot()، (3) أعد تشغيل الموصّل، فيأخذ لقطة جديدة ويستأنف من موضع WAL الحالي. ويجب معالجة الفجوة في أحداث CDC في النظام اللاحق."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مراقبة صحة MVCC وضبط Autovacuum",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "اكتب استعلام مراقبة SQL ينتج تقرير صحة لكل جدول مالي (accounts، وtransactions، وledger_entries) يُظهر: نسبة النسخ الميتة، والوقت منذ آخر autovacuum، والصفحات المقدرة للانتفاخ، ونسبة تحديثات HOT، وعمر معرّف المعاملة. وصنّف كل مقياس OK/WARNING/CRITICAL بعتبات مناسبة لنظام دفع عالي المعاملات."},
    {"id": "2", "description": "باستخدام نسخة PostgreSQL في Testcontainers، بيّن تراكم انتفاخ الجدول: أدرج 100,000 صف في جدول حسابات، ثم حدّث كل الصفوف 5 مرات (500,000 تحديث إجمالًا دون VACUUM). وقِس الحجم الفيزيائي للجدول قبل وبعد لتحديد الانتفاخ. ثم شغّل VACUUM ANALYZE وقِس انخفاض الحجم."},
    {"id": "3", "description": "اضبط إعدادات autovacuum لكل جدول لجدول حسابات يستقبل 2,000 تحديث في الثانية. والهدف منع النسخ الميتة من تجاوز 1% من النسخ الحية في أي وقت. واحسب إعدادات autovacuum_vacuum_scale_factor وautovacuum_vacuum_cost_limit المطلوبة، ثم تحقق منها بحمل pgbench."},
    {"id": "4", "description": "ابنِ مهمة Spring Boot مجدولة تراقب pg_stat_archiver وpg_replication_slots وتطلق تنبيهات بأسلوب PagerDuty حين يتجاوز تأخر أرشفة WAL دقيقتين أو يتجاوز تأخر فتحة النسخ 100 ميغابايت. واضبط max_slot_wal_keep_size كشبكة أمان على جانب قاعدة البيانات، ووثّق دليل التشغيل لحذف فتحة ميتة (مع مسار تدقيق) بدل حذف الفتحات آليًا من التطبيق."}
  ]
}
-->
