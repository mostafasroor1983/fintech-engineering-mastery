---
id: track-08-lesson-12
title: "JSONB والبيانات شبه المنظمة في PostgreSQL"
slug: jsonb-semi-structured
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 12
difficulty: advanced
estimatedMinutes: 65
status: published
tags:
  - JSONB
  - PostgreSQL
  - GIN-index
  - jsonpath
  - schema-flexibility
prerequisites:
  - track-08-lesson-11
---

# ‏JSONB والبيانات شبه المهيكلة في PostgreSQL

تصادف الأنظمة المالية كثيرًا بيانات لا تتلاءم بدقة مع مخطط علائقي ثابت: فبيانات الدفع الوصفية تختلف حسب قناة الدفع (معرّفات تفويضات SEPA، ورموز SWIFT BIC، ومعرّفات موافقات Open Banking)، وحمولات سجلات التدقيق تلتقط حالة نظام اعتباطية، وأعلام الميزات تحمل كائنات إعداد غير متجانسة. ويتيح نوع JSONB في PostgreSQL تخزين البيانات شبه المهيكلة وفهرستها داخل المحرك العلائقي — دون التضحية بضمانات ACID أو قدرة الاستعلام.

---

## 1. ‏JSON مقابل JSONB

يقدم PostgreSQL نوعين لـ JSON. واختيار الخطأ منهما خطأ شائع.

### 1.1 التخزين والتمثيل

| الخاصية | JSON | JSONB |
|----------|------|-------|
| صيغة التخزين | نص عادي حرفيًا | ثنائي مُفكّك |
| يحفظ المسافات البيضاء | نعم | لا |
| يحفظ ترتيب المفاتيح | نعم | لا (المفاتيح مرتبة) |
| يحفظ المفاتيح المكررة | نعم (الأخير يفوز عند القراءة) | لا (المفتاح الأخير يفوز عند الإدراج) |
| قابل للفهرسة بـ GIN | لا | نعم |
| دعم المعاملات | الاستخراج فقط (`->`، `->>`، `#>`، `#>>`) | الاستخراج إضافة إلى `@>`، `?`، `?&`، `?|`، `@?`، `@@` |
| أداء الكتابة | أسرع (بلا تحليل) | أبطأ قليلًا (يجب التحليل + التفكيك) |
| أداء القراءة/الاستعلام | أبطأ (إعادة تحليل عند كل وصول) | أسرع (ثنائي، بلا إعادة تحليل) |

```sql
-- JSON stores exact text bytes
CREATE TABLE demo_json (data JSON);
INSERT INTO demo_json VALUES ('{"b": 1, "a": 2,  "a": 3}');
SELECT data FROM demo_json;
-- Returns: {"b": 1, "a": 2,  "a": 3}  — whitespace preserved, duplicate key kept

-- JSONB decomposes into binary on write
CREATE TABLE demo_jsonb (data JSONB);
INSERT INTO demo_jsonb VALUES ('{"b": 1, "a": 2,  "a": 3}');
SELECT data FROM demo_jsonb;
-- Returns: {"a": 3, "b": 1}  — whitespace removed, keys sorted, last "a" wins
```

**قاعدة عملية للتقنية المالية:** استخدم JSONB دائمًا. فـ JSON مناسب فقط إذا احتجت حفظ التمثيل البايتي الدقيق لحمولة خارجية (مثل تخزين جسم webhook لإعادة تشغيله). ولأي بيانات ستستعلمها، JSONB أفضل في كل ما يهم.

---

## 2. معاملات JSONB

```sql
-- Payment metadata table
CREATE TABLE payment_metadata (
    payment_id  UUID        PRIMARY KEY,
    metadata    JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sample SEPA payment metadata
INSERT INTO payment_metadata (payment_id, metadata) VALUES
(
  '550e8400-e29b-41d4-a716-446655440000',
  '{
    "rail": "SEPA_DIRECT_DEBIT",
    "sepa_mandate_id": "MNDT-2024-EU-98765",
    "creditor_bic": "DEUTDEDB",
    "debtor_iban": "DE44500105175407324931",
    "end_to_end_id": "NOTPROVIDED",
    "purpose_code": "INSU",
    "remittance_info": "Insurance premium January 2024",
    "amount": {"value": 350000, "currency": "EUR"},
    "compliance": {"kyc_verified": true, "sanctions_checked": true}
  }'
),
(
  '550e8400-e29b-41d4-a716-446655440001',
  '{
    "rail": "SWIFT",
    "swift_bic": "BARCGB22",
    "correspondent_bic": "CHASUS33",
    "charge_bearer": "SHA",
    "amount": {"value": 1250000, "currency": "USD"},
    "compliance": {"kyc_verified": true, "sanctions_checked": true, "fatf_risk": "low"}
  }'
);

-- Operator: -> returns JSONB child by key
SELECT metadata -> 'rail' FROM payment_metadata;
-- Returns: "SEPA_DIRECT_DEBIT"  (JSONB — includes quotes)

-- Operator: ->> returns text child by key
SELECT metadata ->> 'rail' FROM payment_metadata;
-- Returns: SEPA_DIRECT_DEBIT  (text — no quotes)

-- Operator: -> for nested path
SELECT metadata -> 'amount' -> 'currency' FROM payment_metadata;
-- Returns: "EUR"

-- Operator: #> for path as array
SELECT metadata #> '{amount, currency}' FROM payment_metadata;
-- Returns: "EUR"

-- Operator: #>> for path as text
SELECT metadata #>> '{amount, value}' FROM payment_metadata;
-- Returns: 350000

-- Operator: @> containment — does this JSONB contain this sub-document?
SELECT payment_id FROM payment_metadata
WHERE metadata @> '{"rail": "SEPA_DIRECT_DEBIT"}';
-- Returns the SEPA payment UUID

-- Operator: ? — does key exist at top level?
SELECT payment_id FROM payment_metadata
WHERE metadata ? 'swift_bic';
-- Returns the SWIFT payment UUID

-- Operator: ?& — do ALL of these keys exist?
SELECT payment_id FROM payment_metadata
WHERE metadata ?& ARRAY['rail', 'amount', 'compliance'];

-- Operator: ?| — does ANY of these keys exist?
SELECT payment_id FROM payment_metadata
WHERE metadata ?| ARRAY['sepa_mandate_id', 'swift_bic'];
```

---

## 3. فهارس GIN على JSONB

دون فهرس، ينفذ كل استعلام JSONB مسحًا تسلسليًا — فيحلل PostgreSQL كل صف ويفحصه. ويتيح GIN ‏(الفهرس المقلوب المعمم) عمليات بحث سريعة عن المفاتيح والاحتواء.

### 3.1 ‏GIN الافتراضي مقابل jsonb_path_ops

```sql
-- Default GIN index: supports @>, ?, ?&, ?| (and the jsonpath operators @? / @@)
-- Indexes every key and value
CREATE INDEX idx_payment_metadata_gin
    ON payment_metadata USING GIN (metadata);

-- jsonb_path_ops GIN: supports @> and the jsonpath operators @? / @@,
-- but NOT the key-existence operators ?, ?&, ?|
-- Smaller index, faster for containment queries
CREATE INDEX idx_payment_metadata_gin_path
    ON payment_metadata USING GIN (metadata jsonb_path_ops);
```

المقارنة:

| الميزة | GIN الافتراضي | GIN بـ jsonb_path_ops |
|---------|-------------|-------------------|
| المعاملات المدعومة | `@>`، `?`، `?&`، `?|`، `@?`، `@@` | `@>`، `@?`، `@@` |
| حجم الفهرس | أكبر | أصغر بشكل ملحوظ عادة |
| سرعة استعلام `@>` | سريع | أسرع |
| استعلامات وجود المفتاح `?` | نعم | لا |
| موصى به لـ | أنماط استعلام مختلطة | استعلامات الاحتواء / jsonpath فقط |

### 3.2 فهرس GIN جزئي

في الجداول الكبيرة، تقلل الفهارس الجزئية حجم الفهرس كثيرًا حين تحتاج مجموعة فرعية فقط من الصفوف إلى فهرسة:

```sql
-- Only index SWIFT payments — the metadata has richer structure
-- and is more frequently queried for compliance
CREATE INDEX idx_payment_metadata_swift_gin
    ON payment_metadata USING GIN (metadata)
    WHERE metadata @> '{"rail": "SWIFT"}';

-- Only index payments requiring sanctions re-check
CREATE INDEX idx_payment_metadata_sanctions_gin
    ON payment_metadata USING GIN (metadata)
    WHERE (metadata -> 'compliance' ->> 'sanctions_checked')::boolean = false;

-- Verify index is used
EXPLAIN (ANALYZE, BUFFERS)
SELECT payment_id
FROM payment_metadata
WHERE metadata @> '{"rail": "SWIFT"}'
  AND metadata @> '{"compliance": {"fatf_risk": "low"}}';
-- Should show: Bitmap Index Scan on idx_payment_metadata_swift_gin
-- (GIN indexes are always used through bitmap scans)
```

---

## 4. استعلامات jsonpath

يدعم PostgreSQL 12+ لغة مسارات SQL/JSON — طريقة قوية لاستعلام بنى JSONB المتداخلة.

```sql
-- @? operator: does this jsonpath match anything in the document?
-- Find payments where amount > 100,000 (in minor units)
SELECT payment_id
FROM payment_metadata
WHERE metadata @? '$.amount.value ? (@ > 100000)';

-- @@ operator: apply jsonpath and return boolean
SELECT payment_id,
       metadata @@ '$.compliance.kyc_verified == true' AS kyc_ok
FROM payment_metadata;

-- jsonb_path_query: return matching elements
SELECT payment_id,
       jsonb_path_query(metadata, '$.amount') AS amount_obj
FROM payment_metadata;

-- jsonb_path_query_first: return first match
SELECT jsonb_path_query_first(metadata, '$.rail')
FROM payment_metadata
WHERE payment_id = '550e8400-e29b-41d4-a716-446655440000';

-- Complex jsonpath: find SWIFT payments with high amounts in USD
SELECT payment_id
FROM payment_metadata
WHERE metadata @? '$ ? (@.rail == "SWIFT" && @.amount.currency == "USD" && @.amount.value > 500000)';

-- Both GIN operator classes can serve @? and @@ (for the parts of the
-- jsonpath they understand, mainly equality checks; a range test such as
-- @ > 100000 is checked on the rows, not in the index).
-- The jsonb_path_ops index from Section 3.1 already covers this table.
```

---

## 5. البيانات الوصفية للدفع عمليًا

### 5.1 تصميم المخطط: حقول إضافية مرنة

```sql
-- payments table: core fields are columnar, variable fields in metadata
CREATE TABLE payments (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    reference       VARCHAR(35)     NOT NULL UNIQUE,
    from_account    VARCHAR(34)     NOT NULL,
    to_account      VARCHAR(34)     NOT NULL,
    amount_minor    BIGINT          NOT NULL CHECK (amount_minor > 0),
    currency        CHAR(3)         NOT NULL,
    status          VARCHAR(20)     NOT NULL DEFAULT 'PENDING',
    payment_rail    VARCHAR(30)     NOT NULL,
    -- Variable fields: SEPA mandate, SWIFT BIC, Open Banking consent, etc.
    metadata        JSONB           NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Practical metadata schemas per rail:
-- SEPA Direct Debit (the mandate authorises the creditor to collect)
-- {"sepa_mandate_id": "...", "creditor_bic": "...", "purpose_code": "INSU",
--  "end_to_end_id": "...", "remittance_info": "..."}

-- SWIFT
-- {"swift_bic": "...", "correspondent_bic": "...", "charge_bearer": "SHA",
--  "correspondent_charge": {"amount": 2500, "currency": "USD"}}

-- Open Banking / UK Faster Payments
-- {"consent_id": "urn:alphabank:...", "aspsp_id": "alphabank",
--  "debtor_name": "John Smith", "category_purpose": "DCRD"}

-- GIN index for all metadata queries
CREATE INDEX idx_payments_metadata ON payments USING GIN (metadata);

-- Targeted index for Open Banking consent lookups (compliance queries)
CREATE INDEX idx_payments_ob_consent
    ON payments USING BTREE ((metadata ->> 'consent_id'))
    WHERE payment_rail = 'OPEN_BANKING';
```

### 5.2 استعلام البيانات الوصفية

```sql
-- Find all payments under a SEPA mandate
SELECT id, reference, amount_minor, currency, status
FROM payments
WHERE metadata @> '{"sepa_mandate_id": "MNDT-2024-EU-98765"}';

-- Find Open Banking payments missing a consent_id (data quality check)
SELECT id, reference, created_at
FROM payments
WHERE payment_rail = 'OPEN_BANKING'
  AND NOT (metadata ? 'consent_id');

-- Aggregate: total SEPA amounts by purpose code
SELECT
    metadata ->> 'purpose_code'    AS purpose_code,
    COUNT(*)                       AS payment_count,
    SUM(amount_minor) / 100.0      AS total_amount_eur
FROM payments
WHERE payment_rail = 'SEPA_DIRECT_DEBIT'
  AND metadata ? 'purpose_code'
GROUP BY metadata ->> 'purpose_code'
ORDER BY total_amount_eur DESC;

-- Update a nested JSONB field
-- (jsonb_set only creates the LAST path element: if "compliance" does not
--  exist, nothing changes -- add the parent object first if needed)
UPDATE payments
SET metadata = jsonb_set(
    metadata,
    '{compliance, sanctions_re_checked}',
    'true'::jsonb
)
WHERE id = '550e8400-e29b-41d4-a716-446655440000';

-- Remove a key
UPDATE payments
SET metadata = metadata - 'temporary_hold_reason'
WHERE status = 'COMPLETED'
  AND metadata ? 'temporary_hold_reason';   -- don't rewrite rows that lack it
```

---

## 6. حمولات سجل التدقيق في JSONB

```sql
-- Audit log: captures arbitrary before/after state for compliance
CREATE TABLE payment_audit_log (
    id           BIGSERIAL    PRIMARY KEY,
    payment_id   UUID         NOT NULL REFERENCES payments(id),
    action       VARCHAR(50)  NOT NULL,
    actor_id     VARCHAR(100) NOT NULL,
    actor_type   VARCHAR(20)  NOT NULL, -- 'USER', 'SERVICE', 'SYSTEM'
    before_state JSONB,
    after_state  JSONB,
    diff         JSONB,       -- computed delta for fast inspection
    ip_address   INET,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- GIN index for auditor queries such as "every change that ended in
-- COMPLETED": WHERE after_state @> '{"status": "COMPLETED"}'
CREATE INDEX idx_audit_after_state ON payment_audit_log
    USING GIN (after_state jsonb_path_ops);

-- Record a status change
INSERT INTO payment_audit_log
    (payment_id, action, actor_id, actor_type, before_state, after_state, diff)
VALUES (
    '550e8400-e29b-41d4-a716-446655440000',
    'STATUS_CHANGED',
    'settlement-service',
    'SERVICE',
    '{"status": "PROCESSING", "updated_at": "2024-01-15T14:00:00Z"}',
    '{"status": "COMPLETED", "updated_at": "2024-01-15T14:00:05Z",
      "transaction_ref": "BACS-20240115-00123456"}',
    '{"changed_fields": ["status", "updated_at"],
      "old_status": "PROCESSING", "new_status": "COMPLETED"}'
);

-- Auditor query: all changes to a payment in chronological order
SELECT
    action,
    actor_id,
    actor_type,
    diff ->> 'old_status' AS from_status,
    diff ->> 'new_status' AS to_status,
    created_at
FROM payment_audit_log
WHERE payment_id = '550e8400-e29b-41d4-a716-446655440000'
ORDER BY created_at;
```

---

## 7. التحقق من المخطط بقيد CHECK

‏JSONB بلا مخطط افتراضيًا. ففرض البنية على مستوى قاعدة البيانات باستخدام `jsonb_matches_schema()` ‏(من امتداد pg_jsonschema) أو بقيد CHECK مكتوب يدويًا. وعلى جدول كبير قائم، أضف القيد بـ `NOT VALID` وشغّل `VALIDATE CONSTRAINT` لاحقًا (الدرس 09)، كي لا يعمل الفحص الكامل تحت قفل قوي.

```sql
-- Install pg_jsonschema (available on some platforms such as Supabase;
-- not on most managed services such as Amazon RDS -- check before relying on it)
CREATE EXTENSION IF NOT EXISTS pg_jsonschema;

-- Validate SEPA metadata has required fields
ALTER TABLE payments
ADD CONSTRAINT chk_sepa_metadata_valid
CHECK (
    payment_rail != 'SEPA_DIRECT_DEBIT'
    OR jsonb_matches_schema(
        '{
          "type": "object",
          "required": ["sepa_mandate_id", "creditor_bic", "purpose_code"],
          "properties": {
            "sepa_mandate_id": {"type": "string", "minLength": 1},
            "creditor_bic": {"type": "string", "pattern": "^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$"},
            "purpose_code": {"type": "string", "enum": ["INSU", "SUPP", "LOAN", "OTHR"]}
          }
        }',
        metadata
    )
);

-- Without pg_jsonschema: hand-crafted CHECK for critical fields.
-- Check the JSON type BEFORE casting: a cast of "abc" would raise an error
-- instead of a clean constraint violation. CASE guarantees the order
-- (AND/OR in SQL do not promise left-to-right evaluation).
ALTER TABLE payments
ADD CONSTRAINT chk_metadata_amount_valid
CHECK (
    metadata -> 'amount' IS NULL
    OR CASE
         WHEN jsonb_typeof(metadata -> 'amount' -> 'value') = 'number'
          AND jsonb_typeof(metadata -> 'amount' -> 'currency') = 'string'
         THEN (metadata -> 'amount' ->> 'value')::numeric > 0
          AND length(metadata -> 'amount' ->> 'currency') = 3
         ELSE false
       END
) NOT VALID;
```

---

## 8. ‏JSONB مقابل جدول EAV

نمط الكيان-السمة-القيمة (EAV) نهج أقدم لتخزين السمات المرنة. وJSONB مفضل في أغلب الأحوال.

```sql
-- EAV approach (avoid this in fintech)
CREATE TABLE payment_attributes (
    payment_id  UUID        NOT NULL,
    attr_key    VARCHAR(50) NOT NULL,
    attr_value  TEXT        NOT NULL,
    PRIMARY KEY (payment_id, attr_key)
);

-- To reconstruct a payment's metadata, you need a pivot:
SELECT
    payment_id,
    MAX(CASE WHEN attr_key = 'sepa_mandate_id' THEN attr_value END) AS sepa_mandate_id,
    MAX(CASE WHEN attr_key = 'creditor_bic' THEN attr_value END) AS creditor_bic
FROM payment_attributes
GROUP BY payment_id;
-- This is fragile, slow, and impossible to index efficiently.

-- JSONB approach (use this)
-- Single row per payment, all metadata in one column
-- Indexable, queryable, updateable with jsonb_set
-- No pivot query needed
SELECT
    payment_id,
    metadata ->> 'sepa_mandate_id' AS sepa_mandate_id,
    metadata ->> 'creditor_bic'    AS creditor_bic
FROM payment_metadata;
```

**متى تفضّل جدولًا علائقيًا حقيقيًا على JSONB:**
- حين تستعلم مفاتيح محددة كثيرًا في عبارات WHERE بتعدد عالٍ (استخدم عمودًا حقيقيًا بفهرس B-tree بدلًا من ذلك)
- حين تحتاج قيود مفاتيح أجنبية بين قيمة JSON وجدول آخر
- حين تكون البيانات جدولية فعلًا بأعمدة معروفة ومستقرة

**متى يكون JSONB الاختيار الصحيح:**
- تختلف السمات حسب النوع/النوع الفرعي ولا يمكن معرفتها وقت تصميم المخطط
- يختلف عدد السمات كثيرًا (0–50 لكل كيان)
- تُقرأ السمات غالبًا ككائن كامل، لا تُرشّح فرديًا
- تحتاج الاحتفاظ بحمولات خارجية (مثل ردود الشركاء) للرجوع إليها — واستخدم JSON أو TEXT بدلًا من ذلك إذا وجب حفظ البايتات الدقيقة

---

## 9. استعلامات تجميع JSONB

```sql
-- Build a JSON object from query results
SELECT
    jsonb_build_object(
        'payment_id', id,
        'amount', jsonb_build_object('value', amount_minor, 'currency', currency),
        'metadata', metadata
    ) AS full_payload
FROM payments
WHERE id = '550e8400-e29b-41d4-a716-446655440000';

-- Aggregate: build JSON array of recent payments per account
SELECT
    from_account,
    jsonb_agg(
        jsonb_build_object(
            'id', id,
            'amount', amount_minor,
            'status', status,
            'created_at', created_at
        ) ORDER BY created_at DESC
    ) AS recent_payments
FROM payments
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY from_account;

-- Expand JSONB array into rows
SELECT
    payment_id,
    jsonb_array_elements_text(metadata -> 'tags') AS tag
FROM payment_metadata
WHERE metadata ? 'tags';

-- jsonb_each: expand object keys into rows
SELECT
    payment_id,
    key,
    value
FROM payment_metadata,
     jsonb_each(metadata -> 'compliance');
-- Returns: (payment_id, 'kyc_verified', 'true'), (payment_id, 'sanctions_checked', 'true'), ...
```

---

## 10. مزالق الإنتاج

### المزلق 1: عدم فهرسة المفاتيح المستعلمة — مسوح تسلسلية على جداول كبيرة

أشيع خطأ في JSONB: إضافة فهرس GIN ثم الاستعلام بطرق لا تستطيع استخدامه.

```sql
-- Table: 50M payment rows, GIN index on metadata

-- USES the GIN index — containment operator @>
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM payments
WHERE metadata @> '{"rail": "SWIFT"}';
-- Bitmap Index Scan on idx_payments_metadata
-- -> Bitmap Heap Scan: 25,000 rows in 15ms ✓

-- DOES NOT use the GIN index — extracting a key with -> and comparing as text
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM payments
WHERE metadata ->> 'rail' = 'SWIFT';
-- Seq Scan on payments (cost=0.00..1850000)
-- Rows: 50,000,000 — full table scan, 45 seconds ✗

-- FIX option 1: use @> containment (uses GIN index)
WHERE metadata @> '{"rail": "SWIFT"}'

-- FIX option 2: create a functional B-tree index on the extracted key
CREATE INDEX idx_payments_rail ON payments ((metadata ->> 'rail'));
-- Now the ->> 'rail' = 'SWIFT' query uses this B-tree index

-- Which to choose:
-- B-tree on the extracted key: =, ranges and ORDER BY on that one key;
--   small and cheap to maintain
-- GIN: containment across many different keys with one index
-- Either way, an index only helps for selective values -- if 'SWIFT'
-- matches a large share of the rows, a sequential scan is the right plan
```

### المزلق 2: تخزين المصفوفات في JSONB بدل جدول وصل

حين تحتاج استعلام عناصر مصفوفة فردية أو الحفاظ على السلامة المرجعية، تكون المصفوفات في JSONB الاختيار الخطأ.

```sql
-- WRONG — storing related IDs as a JSONB array
CREATE TABLE batches (
    id          UUID PRIMARY KEY,
    metadata    JSONB NOT NULL
    -- metadata contains: {"payment_ids": ["uuid1", "uuid2", ...]}
);

-- Query: find the batch that contains a specific payment
SELECT id FROM batches
WHERE metadata @> '{"payment_ids": ["550e8400-e29b-41d4-a716-446655440000"]}';
-- A GIN index CAN serve this lookup. The real problems are elsewhere:

-- You cannot enforce that payment_ids reference valid payments.id
-- You cannot cascade deletes or updates
-- Adding one payment rewrites the whole (possibly huge, TOASTed) document,
--   and concurrent additions to the same batch conflict
-- You cannot count, paginate or sort membership without unnesting

-- CORRECT — use a proper junction table
CREATE TABLE batch_payments (
    batch_id    UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    payment_id  UUID NOT NULL REFERENCES payments(id),
    sequence    INT  NOT NULL,
    PRIMARY KEY (batch_id, payment_id)
);

CREATE INDEX idx_batch_payments_payment ON batch_payments (payment_id);

-- Now finding the batch for a payment is a simple index lookup:
SELECT b.id FROM batches b
JOIN batch_payments bp ON b.id = bp.batch_id
WHERE bp.payment_id = '550e8400-e29b-41d4-a716-446655440000';
-- Index Scan on idx_batch_payments_payment — sub-millisecond
```

### المزلق 3: استخدام JSONB لكل شيء "لأنه مرن"

‏JSONB مخرج طوارئ قوي، وليس بديلًا عن مخطط علائقي سليم.

```sql
-- WRONG — storing core transactional data in JSONB to "stay flexible"
CREATE TABLE payments_bad (
    id      UUID PRIMARY KEY,
    data    JSONB NOT NULL  -- everything in here: amount, accounts, status, timestamps
);

-- Problems you will hit in production:
-- 1. No NOT NULL enforcement on critical fields
INSERT INTO payments_bad (id, data) VALUES (gen_random_uuid(), '{}');
-- This succeeds — empty payment, no amount, no accounts!

-- 2. No type enforcement — amount stored as string
INSERT INTO payments_bad (id, data) VALUES
    (gen_random_uuid(), '{"amount": "one hundred pounds"}');
-- SUM((data ->> 'amount')::bigint) will throw a cast error at query time

-- 3. No foreign key constraints
-- data ->> 'from_account' could reference a non-existent account — no enforcement

-- 4. Aggregates are expensive
SELECT SUM((data ->> 'amount')::bigint) FROM payments_bad;
-- Full table scan + text-to-int cast on every row

-- CORRECT — columnar for core fields, JSONB only for truly variable extras
CREATE TABLE payments_good (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    from_account    VARCHAR(34)  NOT NULL,
    to_account      VARCHAR(34)  NOT NULL,
    amount_minor    BIGINT  NOT NULL CHECK (amount_minor > 0),
    currency        CHAR(3) NOT NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    -- Only the genuinely variable, rail-specific fields go in JSONB
    metadata        JSONB   NOT NULL DEFAULT '{}'
);

-- SUM on a real column needs no parsing or casting per row
SELECT SUM(amount_minor) FROM payments_good WHERE currency = 'GBP';
-- Still a scan of the matching rows, but far cheaper per row; for
-- dashboards over 100M rows, use pre-aggregated rollups (Lesson 13)
```

---

## 11. قائمة التحقق

- [ ] كل أعمدة JSONB تستخدم نوع JSONB، لا JSON (إلا إذا لزم حفظ النص حرفيًا)
- [ ] فهرس GIN منشأ على كل عمود JSONB مستخدم في عبارات WHERE
- [ ] الاستعلامات تستخدم احتواء `@>` أو وجود المفتاح `?`، لا `->>` مع `=` (الذي يتجاوز GIN)
- [ ] المفاتيح المستخرجة عالية التعدد لها فهرس B-tree دالي: `((metadata ->> 'key'))`
- [ ] التحقق من المخطط مطبق عبر `jsonb_matches_schema` أو قيد CHECK على القنوات الحرجة
- [ ] حقول المعاملات الجوهرية (المبلغ، والحسابات، والحالة) أعمدة حقيقية، لا مفاتيح JSONB
- [ ] الكيانات المرتبطة مخزنة كجداول وصل، لا كمصفوفات داخل JSONB
- [ ] ‏`jsonb_set` مستخدم للتحديثات الجزئية الذرية (لا قراءة-تعديل-كتابة في شيفرة التطبيق)
- [ ] حمولات سجل التدقيق تتضمن مفتاح `diff` للفحص السريع دون مقارنة before/after كاملين
- [ ] تشغيل EXPLAIN ANALYZE على كل استعلامات JSONB للتحقق من استخدام الفهارس قبل النشر
- [ ] النظر في فهارس GIN الجزئية لأعمدة JSONB ذات أنواع المستندات غير المتجانسة

---

<!-- KNOWLEDGE-CHECK
{"questions":[{"text":"لديك فهرس GIN على عمود JSONB باسم `metadata` وتشغّل: SELECT * FROM payments WHERE metadata ->> 'rail' = 'SWIFT'. هل يستخدم هذا الاستعلام فهرس GIN؟","options":["أ) نعم، فهرس GIN على JSONB يدعم كل المعاملات بما فيها ->>","ب) لا، المعامل ->> يستخرج قيمة نصية ولا يستطيع PostgreSQL استخدام فهرس GIN لمقارنة مساواة نصية على قيمة مستخرجة","ج) نعم، لكن فقط إذا أُنشئ فهرس GIN بـ jsonb_path_ops","د) يعتمد على ما إذا قدّر المخطِّط أكثر من 1,000 صف مطابق"],"correct":1,"explanation":"يدعم فهرس GIN على عمود JSONB معاملات الاحتواء (@>)، ووجود المفتاح (?)، وjsonpath ‏(@@، @?). واستخراج قيمة بـ ->> ومقارنتها بـ = مقارنة نصية على تعبير مشتق، لا يستطيع فهرس GIN خدمتها. فسينفذ PostgreSQL مسحًا تسلسليًا. ولاستخدام فهرس، إما أعد كتابة الاستعلام كـ: WHERE metadata @> '{\"rail\": \"SWIFT\"}' (يستخدم GIN)، أو أنشئ فهرس B-tree داليًا: CREATE INDEX ON payments ((metadata ->> 'rail')) وأبقِ صيغة ->>."},{"text":"لماذا يُعد تخزين قائمة معرّفات مدفوعات مرتبطة كمصفوفة JSONB (مثل {\"payment_ids\": [\"uuid1\", \"uuid2\"]}) مشكلة في نظام مالي؟","options":["أ) مصفوفات JSONB غير مدعومة في PostgreSQL 14 وما قبله","ب) لا يمكن فرض المفاتيح الأجنبية على عناصر المصفوفة، وكل تغيير في العضوية يعيد كتابة مستند JSONB كله، والعدّ أو تقسيم الأعضاء إلى صفحات يحتاج فك المصفوفة — وجدول الوصل يتجنب كل هذا","ج) لمصفوفات JSONB حد أقصى 255 عنصرًا","د) لا تستطيع مصفوفات JSON تخزين UUID — فيجب تخزينها كنصوص ما يمنع الفهرسة"],"correct":1,"explanation":"تخزين المعرّفات المرتبطة في مصفوفة JSONB يسبب عدة مشكلات في التقنية المالية: (1) لا يستطيع PostgreSQL فرض مفتاح أجنبي على عناصر المصفوفة — فقد يشير معرّف في المصفوفة إلى دفعة غير موجودة؛ (2) إضافة عضو واحد أو إزالته تعيد كتابة المستند كله، والتغييرات المتزامنة على الدفعة نفسها تتعارض؛ (3) لا يمكنك عدّ الأعضاء أو تقسيمهم إلى صفحات أو ترتيبهم حسب سمات العضوية مباشرة دون فك المصفوفة. (يستطيع فهرس GIN إيجاد الدفعة التي تحوي دفعة معينة، فسرعة البحث ليست المشكلة الأساسية.) وجدول وصل batch_payments بـ (batch_id، payment_id) وفهرس على payment_id يحل كل هذا."},{"text":"ما الفرق بين صنف معاملات GIN الافتراضي وjsonb_path_ops لفهارس JSONB؟","options":["أ) jsonb_path_ops أسرع لكل العمليات؛ وGIN الافتراضي مُهمل","ب) يدعم GIN الافتراضي @> و? و?& و?| (وjsonpath) وهو أكبر؛ ويدعم jsonb_path_ops ‏@> وjsonpath لكن لا يدعم وجود المفتاح، وينتج فهرسًا أصغر أسرع لاستعلامات الاحتواء","ج) يدعم jsonb_path_ops تعبيرات jsonpath بينما لا يدعمها GIN الافتراضي","د) يفهرس GIN الافتراضي القيم فقط؛ ويفهرس jsonb_path_ops المفاتيح والقيم معًا"],"correct":1,"explanation":"يفهرس صنف معاملات GIN الافتراضي كل مفتاح وقيمة على حدة، فيدعم الاحتواء (@>)، ووجود المفتاح (?، ?&، ?|)، ومعاملات jsonpath ‏(@?، @@). أما jsonb_path_ops فيفهرس تجزئات تركيبات المسار+القيمة، فيدعم @> وjsonpath لكن لا يدعم وجود المفتاح، وهو عادة أصغر بشكل ملحوظ وأسرع لعمليات بحث الاحتواء. اختر الافتراضي حين تحتاج استعلامات وجود المفتاح؛ واختر jsonb_path_ops حين تستخدم @> / jsonpath فقط."}]}
-->

<!-- PRACTICAL-CHALLENGE
{"title":"البيانات الوصفية للدفع في JSONB: الفهرسة والاستعلام والتحقق من المخطط","difficulty":"advanced","estimatedMinutes":80,"tasks":[{"id":"1","description":"أنشئ جدول payments بحقول جوهرية كأعمدة (id، from_account، to_account، amount_minor، currency، status، payment_rail) وعمود metadata من نوع JSONB. وأدرج 100,000 صف: 60,000 دفعة SEPA ببيانات وصفية تحوي sepa_mandate_id وcreditor_bic وpurpose_code؛ و30,000 دفعة SWIFT بـ swift_bic وcharge_bearer؛ و10,000 دفعة Open Banking بـ consent_id. وأنشئ فهرس GIN على metadata. وشغّل EXPLAIN ANALYZE على استعلام احتواء يرشّح حسب القناة وتأكد من أن الاستعلام يستخدم فهرس GIN، لا مسحًا تسلسليًا."},{"id":"2","description":"أظهر مزلق ->>: شغّل EXPLAIN ANALYZE على SELECT * FROM payments WHERE metadata ->> 'rail' = 'SWIFT' والتقط مخرج المسح التسلسلي. ثم أنشئ فهرس B-tree داليًا على (metadata ->> 'rail') وشغّل الاستعلام نفسه مجددًا. وقارن خطط التنفيذ وأزمنته. واكتب تعليق SQL يشرح متى تختار فهرس B-tree الدالي مقابل إعادة كتابة الاستعلام لاستخدام @> مع فهرس GIN."},{"id":"3","description":"أضف قيد CHECK باستخدام pg_jsonschema (إن توفر) أو CHECK يدوي يفرض أن لدفعات SEPA قيمة sepa_mandate_id غير فارغة وcreditor_bic يطابق تعبير صيغة BIC النمطي. واكتب اختبارًا: حاول إدراج دفعة SEPA دون sepa_mandate_id وتحقق من فشل الإدراج بانتهاك قيد CHECK. واكتب دالة Java في @Service تلتقط DataIntegrityViolationException وتترجمها إلى SepaMetadataValidationException خاص بالمجال."},{"id":"4","description":"ابنِ جدول سجل تدقيق للمدفوعات بأعمدة before_state وafter_state وdiff من نوع JSONB. واكتب دالة مشغّل (trigger) في PostgreSQL تعمل AFTER UPDATE على payments، تلتقط حالة الصف القديمة والجديدة كـ JSONB باستخدام to_jsonb(OLD) وto_jsonb(NEW)، وتحسب diff يحوي أسماء الأعمدة المتغيرة فقط، وتدرج صفًا في سجل التدقيق. واختبرها بتحديث حالة دفعة والتحقق من أن صف سجل التدقيق يحوي before_state وafter_state وdiff الصحيحة. وأنشئ فهرس GIN على after_state وتحقق من أن استعلامًا يبحث عن كل المدفوعات التي بلغت الحالة COMPLETED يستخدم الفهرس."}]}
-->
