---
id: track-08-lesson-05
title: "استراتيجيات الفهرسة — B-Tree وGIN وGiST وBRIN"
slug: index-strategies
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 5
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [index, B-tree, GIN, BRIN, covering-index]
prerequisites: []
---

# استراتيجيات الفهارس — B-Tree وGIN وGiST وBRIN

> [!NOTE]
> اختيار الفهرس من أعلى القرارات أثرًا في هندسة قواعد البيانات. فالفرق بين مسح جدول كامل ومسح فهرس على جدول معاملات من 100 مليون صف هو الفرق بين استعلام مدته 30 ثانية واستعلام مدته 5 مللي ثوانٍ. ويعلّمك هذا الدرس مطابقة أنواع الفهارس لأنماط الوصول بدقة، وتجنب الخطأ الشائع في الإفراط بفهرسة الجداول المالية كثيفة التحديث.

## 1. كيف يختار PostgreSQL فهرسًا

يقرر مخطِّط الاستعلام استخدام فهرس بتقدير كلفة مسح الفهرس مقابل المسح المتتابع. والعوامل الأساسية:

- **الانتقائية:** كم صفًا يطابق الشرط؟ (انتقائية عالية = صفوف أقل = يُفضّل الفهرس)
- **ارتباط الفهرس:** ما مدى تطابق ترتيب الفهرس مع ترتيب الصفوف الفيزيائي؟
- **إحصاءات الجدول:** يحدّثها ANALYZE — والإحصاءات القديمة تؤدي إلى خطط سيئة
- **نسبة random_page_cost / seq_page_cost:** الافتراضي 4.0/1.0 — وتُخفض على SSD/NVMe إلى نحو 1.1/1.0

```sql
-- Always start with EXPLAIN ANALYZE to see which index is used
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM transactions
WHERE account_id = 'ACC-1001'
  AND transaction_date >= '2024-01-01'
  AND transaction_date < '2024-04-01';
```

ابحث عن:
- ‏`Index Scan using <index_name>` — الفهرس مستخدم بكفاءة
- ‏`Bitmap Index Scan` — شروط فهارس متعددة مدمجة
- ‏`Seq Scan` — لا فهرس مناسب، أو اختار المخطِّط عدم استخدامه
- ‏`Buffers: shared hit=X read=Y` — ‏X صفحة من الذاكرة المخبئية، وY من القرص

## 2. فهارس B-Tree

‏B-Tree نوع الفهرس الافتراضي في PostgreSQL. ينظم المفاتيح في شجرة متوازنة، ويدعم المساواة، والنطاق، والبادئة، والترتيب.

### 2.1 متى يتفوق B-Tree

```sql
-- Equality predicate: O(log N) lookup
SELECT * FROM accounts WHERE account_id = 'ACC-1001';

-- Range predicate: tree traversal from start key to end key
SELECT * FROM transactions
WHERE transaction_date BETWEEN '2024-01-01' AND '2024-01-31';

-- Sorted output without sort step (index order = requested order)
SELECT transaction_id, amount, transaction_date
FROM transactions
WHERE account_id = 'ACC-1001'
ORDER BY transaction_date DESC
LIMIT 50;

-- Multi-column B-tree: effective when prefix columns are used
CREATE INDEX idx_txn_account_date
ON transactions (account_id, transaction_date DESC);
-- Efficient for: WHERE account_id = ? AND transaction_date = ?
-- Efficient for: WHERE account_id = ? ORDER BY transaction_date DESC
-- NOT efficient for: WHERE transaction_date = ? (no account_id prefix)
```

### 2.2 ترتيب أعمدة الفهرس المركب

القاعدة المعتادة: الأعمدة المقارنة **بالمساواة** أولًا، وعمود **النطاق** (أو الترتيب) أخيرًا. وبين أعمدة المساواة، الترتيب أقل أهمية — فاختر ترتيبًا يخدم استعلامات أخرى أيضًا، لأنه لا يمكن استخدام إلا بادئة أولى من الفهرس بكفاءة:

```sql
-- Financial transaction lookup: account_id is highly selective, status is not
CREATE INDEX idx_txn_account_status_date
ON transactions (account_id, status, transaction_date);
-- Good for: WHERE account_id = ? AND status = 'pending'
-- Good for: WHERE account_id = ? AND status = ? AND transaction_date > ?

-- For status-only queries, this index is NOT useful (skips prefix)
-- Create a separate partial index for status-only queries:
CREATE INDEX idx_txn_pending
ON transactions (created_at)
WHERE status = 'pending';
```

### 2.3 ارتباط الفهرس

يقيس ارتباط الفهرس مدى تطابق ترتيب الفهرس مع ترتيب الـ heap (الفيزيائي). ‏1.0 = ارتباط تام؛ و0 = عشوائي. والارتباط المنخفض يعني أن مسوح الفهرس تسبب قراءات قرص عشوائية كثيرة.

```sql
-- Check index correlation
SELECT
    attname,
    correlation
FROM pg_stats
WHERE tablename = 'transactions'
  AND attname IN ('transaction_date', 'account_id', 'amount');
-- transaction_date: correlation ~0.99 (append-only, naturally ordered)
-- account_id: correlation ~0.01 (random, accounts created in any order)
```

للفهارس منخفضة الارتباط على الجداول الكبيرة، يُستخدم غالبًا Bitmap Index Scan (يجمع معرّفات الصفوف المطابقة أولًا، ثم يجلب صفحات الـ heap بالترتيب).

## 3. الفهارس المُغطية مع INCLUDE

يخزن الفهرس المُغطي أعمدة إضافية غير مفتاحية، فيتيح الإجابة عن الاستعلام كليًا من الفهرس دون لمس الـ heap ("مسح من الفهرس فقط").

### 3.1 فهرس مُغطٍّ لسجل المدفوعات

```sql
-- Query: get recent transactions for a customer view
-- Without covering index: index scan + heap fetch for each row
CREATE INDEX idx_txn_account_date
ON transactions (account_id, transaction_date DESC);

-- With covering index: index-only scan
CREATE INDEX idx_txn_account_date_covering
ON transactions (account_id, transaction_date DESC)
INCLUDE (amount, currency, status, reference_id);
-- Now this query never touches the heap:
SELECT transaction_date, amount, currency, status, reference_id
FROM transactions
WHERE account_id = 'ACC-1001'
ORDER BY transaction_date DESC
LIMIT 50;
```

### 3.2 متى يستحق INCLUDE

يتطلب المسح من الفهرس فقط أن تكون خريطة رؤية الـ heap حديثة (يحافظ عليها VACUUM): فالصفحات المتغيرة منذ آخر تنظيف ما زالت تحتاج زيارة الـ heap. وأوثق فحص هو `EXPLAIN (ANALYZE)` — فهو يُظهر `Heap Fetches: N` على عقدة Index Only Scan. ويعطي عرض الإحصاءات صورة تقريبية تراكمية:

```sql
SELECT
    indexrelname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE relname = 'transactions';
-- idx_tup_fetch counts live rows fetched from the heap by plain index scans;
-- a value far below idx_tup_read suggests index-only scans are working.
-- Confirm per query with EXPLAIN (ANALYZE) -> Heap Fetches
```

## 4. الفهارس الجزئية

تفهرس الفهارس الجزئية الصفوف المطابقة لشرط WHERE فقط. فهي أصغر وأسرع كثيرًا للاستعلامات التي تستهدف مجموعة فرعية من الصفوف.

### 4.1 فهرس المعاملات المعلقة

```sql
-- Only pending transactions need fast status-based lookup
-- Completed transactions (99% of rows) are excluded from the index
CREATE INDEX idx_txn_pending_created
ON transactions (created_at ASC, transaction_id)
WHERE status = 'pending';

-- This query uses the partial index efficiently:
SELECT transaction_id, amount, from_account, to_account
FROM transactions
WHERE status = 'pending'
ORDER BY created_at
LIMIT 100;

-- Index is tiny compared to the full table
-- VACUUM is faster because there are few pending transactions
```

### 4.2 فهرس الحسابات النشطة

```sql
-- Only active accounts need account lookups for new transactions
CREATE INDEX idx_accounts_active_customer
ON accounts (customer_id, account_id)
WHERE is_active = TRUE;

-- Closed accounts (potentially most accounts in a mature system)
-- are excluded from this index entirely
```

### 4.3 فهرس استبعاد NULL

```sql
-- B-tree indexes include NULL values, which can be wasteful if
-- a column is mostly NULL (e.g., external_reference only filled for
-- wire transfers — 5% of transactions)
CREATE INDEX idx_txn_external_ref
ON transactions (external_reference)
WHERE external_reference IS NOT NULL;

SELECT * FROM transactions
WHERE external_reference = 'WIRE-20240115-001';
-- Uses the partial index efficiently
```

## 5. فهارس التعابير

افهرس تعبيرًا محسوبًا بدل قيمة العمود مباشرة.

```sql
-- Case-insensitive search on beneficiary name
CREATE INDEX idx_beneficiary_name_lower
ON beneficiaries (lower(name));

-- Query must use the same expression:
SELECT * FROM beneficiaries
WHERE lower(name) = lower('John Smith');

-- Date truncation for month-based aggregation
-- (works because transaction_date is a DATE; on a TIMESTAMPTZ column
--  date_trunc depends on the session time zone and cannot be indexed)
CREATE INDEX idx_txn_month
ON transactions (date_trunc('month', transaction_date));

SELECT
    date_trunc('month', transaction_date) AS month,
    SUM(amount) AS total
FROM transactions
WHERE date_trunc('month', transaction_date) = '2024-01-01'
GROUP BY 1;

-- Last 4 digits of the card number for masked display / support search:
-- store them in their own column (PCI DSS allows keeping the last four).
-- The last characters of an encrypted value or hash are NOT the card's
-- last four digits.
CREATE INDEX idx_card_last4
ON payment_cards (card_last4, customer_id);
```

## 6. فهارس GIN لـ JSONB والمصفوفات

يفهرس GIN ‏(Generalized Inverted Index) كل عنصر في قيمة مركبة (مصفوفة، أو JSONB، أو متجه بحث نصي) على حدة، فيمكّن استعلامات الاحتواء والوجود بكفاءة.

### 6.1 بيانات وصف المعاملات بـ JSONB

تخزن الأنظمة المالية بشكل متزايد بيانات وصف مرنة كـ JSONB:

```sql
-- transactions.metadata is a JSONB column containing:
-- {"merchant": "ACME Corp", "category": "retail", "mcc": "5411", "tags": [...]}

-- GIN index on the entire JSONB document
CREATE INDEX idx_txn_metadata_gin
ON transactions USING GIN (metadata);

-- Query: all transactions at a specific merchant
SELECT * FROM transactions
WHERE metadata @> '{"merchant": "ACME Corp"}';

-- Query: all transactions with a specific tag
SELECT * FROM transactions
WHERE metadata @> '{"tags": ["recurring"]}';

-- Check if a key exists
SELECT * FROM transactions
WHERE metadata ? 'mcc';

-- GIN also supports jsonb_path_ops operator class (smaller index)
CREATE INDEX idx_txn_metadata_gin_path
ON transactions USING GIN (metadata jsonb_path_ops);
-- Supports @> and @? but not ? and ?|
```

### 6.2 فهرس مسار JSONB

لاستعلامات JSONB المتداخلة بعمق على مسار محدد:

```sql
-- Extract a specific field for indexing (more selective than full GIN)
CREATE INDEX idx_txn_merchant_id
ON transactions ((metadata->>'merchant_id'));
-- B-tree index on extracted scalar value
-- Supports = and range operators efficiently

-- Or use a GIN index on the specific path
CREATE INDEX idx_txn_risk_flags
ON transactions USING GIN ((metadata->'risk_flags'));
```

### 6.3 البحث النصي الكامل في أوصاف المعاملات

```sql
-- Add tsvector column for full-text search on transaction descriptions.
-- PostgreSQL 12+: a generated column keeps it in sync automatically
-- (this rewrites the table -- plan it like any table rewrite):
--   ALTER TABLE transactions ADD COLUMN search_vector TSVECTOR
--     GENERATED ALWAYS AS (to_tsvector('english', coalesce(description, ''))) STORED;
-- Older approach: plain column + trigger, as below
ALTER TABLE transactions ADD COLUMN search_vector TSVECTOR;

-- Populate from description (in batches on a large table)
UPDATE transactions
SET search_vector = to_tsvector('english', description);

-- GIN index on tsvector
CREATE INDEX idx_txn_description_fts
ON transactions USING GIN (search_vector);

-- Query with full-text search
SELECT transaction_id, description, amount
FROM transactions
WHERE search_vector @@ to_tsquery('english', 'wire & payment');

-- Trigger to keep search_vector updated
CREATE TRIGGER txn_search_vector_update
BEFORE INSERT OR UPDATE OF description ON transactions
FOR EACH ROW EXECUTE FUNCTION
    tsvector_update_trigger(search_vector, 'pg_catalog.english', description);
```

## 7. فهارس GiST لأنواع النطاقات

يدعم GiST ‏(Generalized Search Tree) الأنواع الهندسية، وأنواع النطاقات، والأنواع المخصصة. وفي التقنية المالية، أنواع النطاقات مفيدة لفترات الصلاحية، ونطاقات الأسعار، وجداول الرسوم.

### 7.1 نطاقات صلاحية أسعار الصرف

```sql
-- Exchange rates with validity periods (using tstzrange)
-- "=" on plain columns inside a GiST exclusion constraint needs btree_gist
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE exchange_rates (
    rate_id      BIGSERIAL PRIMARY KEY,
    from_currency CHAR(3) NOT NULL,
    to_currency   CHAR(3) NOT NULL,
    rate          NUMERIC(18, 8) NOT NULL,
    valid_during  TSTZRANGE NOT NULL,
    CONSTRAINT no_overlap EXCLUDE USING GIST (
        from_currency WITH =,
        to_currency WITH =,
        valid_during WITH &&  -- No overlapping validity ranges for same pair
    )
);

-- The exclusion constraint already created a GiST index on
-- (from_currency, to_currency, valid_during) -- the query below uses it.
-- No separate index is needed.

-- Query: find rate valid at a specific time
SELECT rate
FROM exchange_rates
WHERE from_currency = 'USD'
  AND to_currency = 'EUR'
  AND valid_during @> NOW()::TIMESTAMPTZ;
```

### 7.2 فهرس نطاق جدول الرسوم

```sql
-- Transaction fee schedule based on amount ranges
CREATE TABLE fee_schedules (
    schedule_id  BIGSERIAL PRIMARY KEY,
    product_code VARCHAR(20) NOT NULL,
    amount_range NUMRANGE NOT NULL,  -- e.g., [100, 1000)
    fee_percent  NUMERIC(5, 4) NOT NULL,
    CONSTRAINT no_fee_overlap EXCLUDE USING GIST (
        product_code WITH =,
        amount_range WITH &&
    )
);

-- (The exclusion constraint's GiST index also serves the lookup below;
--  btree_gist is needed for "product_code WITH =".)

-- Find applicable fee for a 500 transaction
SELECT fee_percent
FROM fee_schedules
WHERE product_code = 'WIRE_TRANSFER'
  AND amount_range @> 500.00::NUMERIC;
```

## 8. فهارس BRIN لبيانات السلاسل الزمنية

يخزن BRIN ‏(Block Range INdex) القيم الدنيا/القصوى لنطاقات من الكتل الفيزيائية. وهو صغير جدًا (كيلوبايتات مقابل ميغابايتات لـ B-tree) لكنه فعّال فقط حين ترتبط قيم العمود بترتيب التخزين الفيزيائي — وهذا صحيح طبيعيًا لبيانات السلاسل الزمنية التي تُضاف فقط.

### 8.1 سجل تدقيق المعاملات

```sql
-- audit_log is append-only, ordered by created_at naturally
CREATE TABLE audit_log (
    log_id      BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id   VARCHAR(50) NOT NULL,
    action      VARCHAR(20) NOT NULL,
    actor_id    VARCHAR(50) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload     JSONB
);

-- BRIN index: tiny size, effective for date range queries on this table
CREATE INDEX idx_audit_log_created_brin
ON audit_log USING BRIN (created_at)
WITH (pages_per_range = 128);  -- Default: 128 pages per range entry

-- Equivalent B-tree index would be hundreds of MB for a large table
-- BRIN index is a few KB

-- Query: audit log for yesterday (BRIN eliminates most block ranges)
SELECT * FROM audit_log
WHERE created_at >= '2024-01-14'
  AND created_at < '2024-01-15';
```

### 8.2 قيود BRIN

```sql
-- BRIN is NOT effective when:
-- 1. Column values are not correlated with physical order
-- 2. You need high-selectivity single-row lookups
-- 3. The table has frequent UPDATEs that change the target column

-- Check BRIN effectiveness
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) FROM audit_log
WHERE created_at >= NOW() - INTERVAL '1 day';
-- Look for "Bitmap Index Scan on idx_audit_log_created_brin"
-- and "Rows Removed by Index Recheck: X" — fewer is better
```

**قاعدة تقريبية لـ BRIN مقابل B-tree:**
- ‏BRIN: جداول الإضافة فقط، واستعلامات تمتد على نطاقات زمنية كبيرة، وجداول > 100 مليون صف، والتخزين مصدر قلق
- ‏B-tree: أنماط الوصول العشوائي، وعمليات البحث عن صف واحد، والبيانات غير الزمنية

## 9. مراقبة استخدام الفهارس

### 9.1 ‏pg_stat_user_indexes

```sql
-- Identify unused indexes (candidates for removal)
-- (pg_stat_user_indexes names its columns relname / indexrelname)
SELECT
    schemaname,
    relname      AS tablename,
    indexrelname AS indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan AS scan_count,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan < 10  -- Used fewer than 10 times since last stats reset
ORDER BY pg_relation_size(indexrelid) DESC;

-- Note: stats are reset by pg_stat_reset() or crash recovery (and on every
-- restart before PostgreSQL 15). Cover at least a full business cycle, keep
-- UNIQUE/primary-key indexes, and check read replicas (idx_scan is per server)
```

### 9.2 كشف الفهارس المفقودة

```sql
-- Tables with sequential scans — potential missing indexes
SELECT
    relname AS tablename,
    seq_scan,
    seq_tup_read,
    idx_scan,
    n_live_tup AS row_count,
    round(seq_scan::numeric / NULLIF(seq_scan + idx_scan, 0) * 100, 2)
        AS seq_scan_pct
FROM pg_stat_user_tables
WHERE seq_scan > 100
  AND n_live_tup > 10000
ORDER BY seq_tup_read DESC
LIMIT 20;
```

### 9.3 فحص انتفاخ الفهارس

```sql
-- B-tree index bloat: measure it with pgstatindex() (pgstattuple extension)
-- instead of rough formulas -- it reads the whole index, so run it off-peak
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT
    c.relname AS indexname,
    pg_size_pretty(pg_relation_size(c.oid)) AS current_size,
    round(s.avg_leaf_density::numeric, 1)   AS leaf_density_pct,  -- ~90 when fresh
    s.leaf_fragmentation
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am am   ON am.oid = c.relam AND am.amname = 'btree'
CROSS JOIN LATERAL pgstatindex(c.oid) s
WHERE i.indrelid = 'transactions'::regclass
ORDER BY s.avg_leaf_density
LIMIT 20;
```

## 10. إنشاء الفهارس المتزامن

استخدم دائمًا `CONCURRENTLY` لإنشاء الفهارس في الإنتاج:

```java
@Component
@Slf4j
public class SafeIndexCreator {

    private static final Pattern IDENTIFIER = Pattern.compile("[a-z_][a-z0-9_]*");

    private final JdbcTemplate jdbcTemplate;   // plain auto-commit connection

    public SafeIndexCreator(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * Creates an index concurrently without blocking production traffic.
     * CONCURRENTLY cannot run inside a transaction block -- never call this
     * from a @Transactional method.
     */
    public void createIndexConcurrently(String indexName,
                                        String tableName,
                                        String columnExpression) {
        // Names are spliced into SQL: accept only simple identifiers.
        // columnExpression must come from code, never from user input.
        if (!IDENTIFIER.matcher(indexName).matches()
                || !IDENTIFIER.matcher(tableName).matches()) {
            throw new IllegalArgumentException("Invalid identifier");
        }

        // An earlier failed CONCURRENTLY run leaves an INVALID index behind.
        // "IF NOT EXISTS" would then silently keep the broken index.
        Boolean valid = jdbcTemplate.query(
            "SELECT i.indisvalid FROM pg_index i " +
            "JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ?",
            rs -> rs.next() ? rs.getBoolean(1) : null, indexName);

        if (Boolean.TRUE.equals(valid)) {
            log.info("Index {} already exists and is valid, skipping", indexName);
            return;
        }
        if (Boolean.FALSE.equals(valid)) {
            log.warn("Index {} exists but is INVALID -- dropping it first", indexName);
            jdbcTemplate.execute("DROP INDEX CONCURRENTLY " + indexName);
        }

        log.info("Creating index {} on {}", indexName, tableName);
        // Both statements must run on the SAME pooled connection
        jdbcTemplate.execute((ConnectionCallback<Void>) con -> {
            try (Statement st = con.createStatement()) {
                st.execute("SET lock_timeout = '5s'");      // don't queue forever
                st.execute(String.format(
                    "CREATE INDEX CONCURRENTLY %s ON %s (%s)",
                    indexName, tableName, columnExpression));
                st.execute("RESET lock_timeout");           // clean pooled connection
            }
            return null;
        });
        log.info("Index {} created successfully", indexName);
    }
}
```

```sql
-- CONCURRENTLY scans the table twice and waits for running transactions
-- between the phases:
-- Pass 1: build index from current data
-- Pass 2: catch any changes made during pass 1
-- So it takes noticeably longer than a standard CREATE INDEX (and a long
-- transaction elsewhere can stall it), but reads and writes continue

CREATE INDEX CONCURRENTLY idx_txn_account_date_new
ON transactions (account_id, transaction_date DESC)
INCLUDE (amount, currency, status);

-- Check for invalid indexes (failed CONCURRENTLY creates)
SELECT c.relname AS indexname, i.indisvalid
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'transactions'::regclass
  AND NOT i.indisvalid;
-- Invalid indexes must be dropped and recreated
```

## 11. أنماط تصميم الفهارس المالية

### 11.1 استراتيجية فهارس خدمة الحسابات

```sql
-- Core account lookup indexes
-- (The PRIMARY KEY on account_id already has its own unique index --
--  never create a second one.)

CREATE INDEX idx_accounts_customer
ON accounts (customer_id)
INCLUDE (account_id, currency, status);  -- Covering for customer view
-- balance is deliberately NOT included: it changes on every payment, and
-- any indexed column prevents cheap HOT updates of the hottest table

CREATE INDEX idx_accounts_active_iban
ON accounts (iban)
WHERE status = 'active' AND iban IS NOT NULL;  -- Partial for IBAN lookups

-- Transaction index strategy
CREATE INDEX idx_txn_account_date
ON transactions (account_id, transaction_date DESC)
INCLUDE (amount, currency, status, reference_id);  -- Covering for history view

CREATE INDEX idx_txn_pending
ON transactions (account_id, created_at)
WHERE status = 'pending';  -- Partial for pending queue

CREATE INDEX idx_txn_reference
ON transactions (reference_id)
WHERE reference_id IS NOT NULL;  -- Deduplication lookups

-- Reporting index -- every extra index slows every insert; consider
-- running heavy reports on a read replica with its own needs in mind
-- (replicas share the primary's indexes, so weigh the write cost)
CREATE INDEX idx_txn_date_amount
ON transactions (transaction_date, amount)
INCLUDE (account_id, currency, merchant_category);
-- Supports date-range reports and amount-based analysis
```

### 11.2 جدول صيانة الفهارس

```sql
-- REINDEX CONCURRENTLY indexes whose MEASURED bloat calls for it
-- (pgstatindex, section 9.3) -- not on a fixed schedule.
-- Run during low-traffic windows
REINDEX INDEX CONCURRENTLY idx_txn_account_date;

-- Or use pg_repack for index-only repack
-- pg_repack -d payments_db -i idx_txn_account_date
```

## الخلاصة

تتطلب استراتيجية الفهارس الفعّالة لقواعد البيانات المالية مطابقة أنواع الفهارس لأنماط الوصول:

- **‏B-tree**: الافتراضي للمساواة، والنطاق، والترتيب، والاستعلامات المركبة — ترتيب الأعمدة مهم
- **الفهارس المُغطية (INCLUDE)**: تلغي جلب الـ heap للاستعلامات كثيفة القراءة — أثر كبير لسجل الحساب (وتجنب الأعمدة كثيرة التحديث)
- **الفهارس الجزئية**: تقلل حجم الفهرس كثيرًا للشروط المتفرقة — استخدمها لمجموعات المعلق/النشط
- **فهارس التعابير**: تمكّن البحث الفعّال على القيم المحسوبة — البحث غير الحساس لحالة الأحرف، والتواريخ المقتطعة
- **‏GIN**: احتواء JSONB، وعضوية المصفوفات، والبحث النصي الكامل — أساسي لبيانات الوصف المرنة
- **‏GiST**: أنواع النطاقات مع قيود الاستبعاد — صلاحية أسعار الصرف، وجداول الرسوم
- **‏BRIN**: السلاسل الزمنية للإضافة فقط — بصمة صغيرة لنطاقات التدقيق وتواريخ المعاملات
- راقب `pg_stat_user_indexes` لتحديد الفهارس غير المستخدمة وإزالتها — فكل فهرس حمل على الكتابة
- استخدم دائمًا `CREATE INDEX CONCURRENTLY` في الإنتاج

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يسترجع استعلام آخر 50 معاملة لحساب: SELECT transaction_date, amount, currency, status FROM transactions WHERE account_id = ? ORDER BY transaction_date DESC LIMIT 50. أي نوع فهرس سيتيح لـ PostgreSQL تلبية هذا الاستعلام دون لمس الـ heap (مسح من الفهرس فقط)؟",
      "options": ["فهرس B-tree على (account_id)", "فهرس B-tree على (account_id, transaction_date DESC)", "فهرس مُغطٍّ على (account_id, transaction_date DESC) INCLUDE (amount, currency, status)", "فهرس GIN على جدول المعاملات"],
      "correct": 2,
      "explanation": "يخزن الفهرس المُغطي مع INCLUDE الأعمدة المعروضة (amount، وcurrency، وstatus) بجانب أعمدة المفتاح في صفحات الفهرس الطرفية. فيستطيع PostgreSQL الإجابة عن هذا الاستعلام كليًا من الفهرس دون جلب صفحات الـ heap المقابلة، فينتج مسح من الفهرس فقط وإدخال/إخراج أقل كثيرًا."
    },
    {
      "text": "يحتوي جدول معاملات 500 مليون صف، 99% منها بحالة status = 'completed'. و1% فقط بحالة status = 'pending'. ويستعلم فريق الاحتيال عن المعاملات المعلقة كثيرًا حسب created_at. أي نوع فهرس يقلل حجم الفهرس وكلفة صيانته بأكبر فعالية لنمط الاستعلام هذا؟",
      "options": ["فهرس B-tree كامل على (status, created_at)", "فهرس جزئي على (created_at) WHERE status = 'pending'", "فهرس GIN على عمود status", "فهرس BRIN على (status, created_at)"],
      "correct": 1,
      "explanation": "الفهرس الجزئي مع WHERE status = 'pending' يفهرس فقط الجزء الصغير من الصفوف المطابقة للشرط، فيقلل حجم الفهرس كثيرًا (1% من فهرس كامل)، ويسرّع VACUUM، ويخفض حمل الكتابة. ويستخدمه مخطِّط الاستعلام للاستعلامات التي تتضمن شرط WHERE المطابق."
    },
    {
      "text": "جدول سجل تدقيق مالي فيه 10 مليارات صف للإضافة فقط مرتبة حسب created_at. والاستعلامات ترشّح دائمًا بنطاقات تاريخ تغطي عدة أيام. أي نوع فهرس يقدم أفضل توازن بين أداء الاستعلام والحد الأدنى من حمل التخزين لهذا النمط؟",
      "options": ["فهرس B-tree على created_at", "فهرس GIN على created_at", "فهرس BRIN على created_at", "فهرس Hash على created_at"],
      "correct": 2,
      "explanation": "يخزن BRIN ‏(Block Range INdex) القيم الدنيا/القصوى لنطاقات من الكتل الفيزيائية. وهو صغير جدًا (كيلوبايتات مقابل ميغابايتات لـ B-tree) وفعّال جدًا لجداول الإضافة فقط حيث ترتبط القيم طبيعيًا بالترتيب الفيزيائي — وهي حالة سجل التدقيق المرتب زمنيًا تمامًا. وتستبعد استعلامات نطاق التاريخ معظم نطاقات الكتل باستخدام بيانات الحد الأدنى/الأقصى."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تصميم استراتيجية فهارس كاملة لدفتر المدفوعات والتحقق منها",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "لجدول معاملات بالأعمدة (transaction_id، وaccount_id، وmerchant_id، وamount، وcurrency، وstatus، وtransaction_date، وcreated_at، وmetadata JSONB)، صمم وأنشئ استراتيجية الفهارس الكاملة لأنماط الاستعلام الخمسة هذه: (أ) سجل معاملات الحساب بنطاق تاريخ، (ب) طابور المعاملات المعلقة حسب الحساب، (ج) إجماليات تسوية التاجر، (د) بحث احتواء بيانات الوصف JSONB حسب المعالج، (هـ) استعلامات نطاق التدقيق للإضافة فقط. وبرر كل نوع فهرس مختار."},
    {"id": "2", "description": "أنشئ فهرسًا مُغطيًا لنمط استعلام سجل معاملات الحساب وتحقق بـ EXPLAIN (ANALYZE, BUFFERS) من أن PostgreSQL يستخدم Index Only Scan ‏(صفر جلب من الـ heap). وأدرج 100,000 صف وشغّل VACUUM لضمان حداثة خريطة الرؤية قبل الاختبار."},
    {"id": "3", "description": "اكتب صنف Java باسم SafeIndexCreator يتحقق من وجود الفهرس قبل محاولة CREATE INDEX CONCURRENTLY، ويسجّل تقدم الإنشاء، ويتعامل مع حالة ترك فيها تشغيل CONCURRENTLY سابق فهرسًا غير صالح (يُكتشف عبر pg_index.indisvalid). ويجب ألا يُستدعى الصنف داخل دالة @Transactional."},
    {"id": "4", "description": "ابنِ تقرير مراقبة فهارس يسرد: الفهارس غير المستخدمة (idx_scan < 10، مع استبعاد الفهارس الفريدة)، والفهارس التي ما زالت استعلاماتها تُظهر جلبًا كثيرًا من الـ heap (‏\"Heap Fetches\" في EXPLAIN ANALYZE على الاستعلامات الأساسية)، وانتفاخ B-tree المقيس بـ pgstatindex() (كثافة الصفحات الطرفية). واجمع الأرقام أسبوعيًا كمقاييس Prometheus ونبّه حين تنخفض كثافة صفحات فهرس الطرفية تحت نحو 60%."}
  ]
}
-->
