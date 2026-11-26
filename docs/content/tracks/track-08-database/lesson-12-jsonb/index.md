---
id: track-08-lesson-12
title: "JSONB and Semi-Structured Data in PostgreSQL"
slug: jsonb-semi-structured
track: track-08
trackName: "Database Engineering"
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

# JSONB and Semi-Structured Data in PostgreSQL

Financial systems frequently encounter data that does not fit neatly into a fixed relational schema: payment metadata varies by payment rail (SEPA mandate IDs, SWIFT BIC codes, Open Banking consent IDs), audit log payloads capture arbitrary system state, and feature flags carry heterogeneous configuration objects. PostgreSQL's JSONB type lets you store and index semi-structured data inside the relational engine — without sacrificing ACID guarantees or query capability.

---

## 1. JSON vs JSONB

PostgreSQL offers two JSON types. Choosing the wrong one is a common mistake.

### 1.1 Storage and Representation

| Property | JSON | JSONB |
|----------|------|-------|
| Storage format | Plain text, verbatim | Binary decomposed |
| Preserves whitespace | Yes | No |
| Preserves key order | Yes | No (keys sorted) |
| Preserves duplicate keys | Yes (last write wins on read) | No (last key wins on insert) |
| Indexable with GIN | No | Yes |
| Operator support | Extraction only (`->`, `->>`, `#>`, `#>>`) | Extraction plus `@>`, `?`, `?&`, `?|`, `@?`, `@@` |
| Write performance | Faster (no parsing) | Slightly slower (must parse + decompose) |
| Read/query performance | Slower (re-parse on every access) | Faster (binary, no re-parse) |

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

**Rule of thumb for fintech:** Always use JSONB. JSON is only appropriate if you need to preserve the exact byte representation of an external payload (e.g., storing a webhook body for replay). For any data you will query, JSONB is superior in every way that matters.

---

## 2. JSONB Operators

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

## 3. GIN Indexes on JSONB

Without an index, every JSONB query performs a sequential scan — PostgreSQL parses and inspects every row. GIN (Generalized Inverted Index) enables fast key/containment lookups.

### 3.1 Default GIN vs jsonb_path_ops

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

Comparison:

| Feature | Default GIN | jsonb_path_ops GIN |
|---------|-------------|-------------------|
| Supported operators | `@>`, `?`, `?&`, `?|`, `@?`, `@@` | `@>`, `@?`, `@@` |
| Index size | Larger | Usually noticeably smaller |
| `@>` query speed | Fast | Faster |
| Key existence `?` queries | Yes | No |
| Recommended for | Mixed query patterns | Containment / jsonpath queries only |

### 3.2 Partial GIN Index

For large tables, partial indexes dramatically reduce index size when only a subset of rows need indexing:

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

## 4. jsonpath Queries

PostgreSQL 12+ supports SQL/JSON Path Language — a powerful way to query nested JSONB structures.

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

## 5. Payment Metadata in Practice

### 5.1 Schema Design: Flexible Extra Fields

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

### 5.2 Querying Metadata

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

## 6. Audit Log Payloads in JSONB

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

## 7. Schema Validation with CHECK Constraint

JSONB is schemaless by default. Enforce structure at the DB level using `jsonb_matches_schema()` (from the pg_jsonschema extension) or a hand-crafted CHECK constraint. On a big existing table, add the constraint `NOT VALID` and run `VALIDATE CONSTRAINT` afterwards (Lesson 09), so the full check does not run under a strong lock.

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

## 8. JSONB vs EAV Table

The Entity-Attribute-Value (EAV) pattern is an older approach to storing flexible attributes. JSONB is almost always preferable.

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

**When to prefer a proper relational table over JSONB:**
- When you query specific keys frequently in WHERE clauses with high cardinality (use a real column with a B-tree index instead)
- When you need foreign key constraints between the JSON value and another table
- When the data is truly tabular with known, stable columns

**When JSONB is the right choice:**
- Attributes vary by type/subtype and cannot be known at schema design time
- Number of attributes varies widely (0-50 per entity)
- Attributes are mostly read as a whole object, not filtered individually
- You need to keep external payloads (e.g. partner responses) for reference — use JSON or TEXT instead if the exact bytes must be preserved

---

## 9. JSONB Aggregation Queries

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

## 10. Production Pitfalls

### Pitfall 1: Not Indexing Queried Keys — Sequential Scans on Large Tables

The most common JSONB mistake: adding a GIN index but then querying in ways that cannot use it.

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

### Pitfall 2: Storing Arrays as JSONB Instead of a Junction Table

When you need to query individual array elements or maintain referential integrity, arrays in JSONB are the wrong choice.

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

### Pitfall 3: Using JSONB for Everything "Because Flexible"

JSONB is a powerful escape hatch, not a replacement for a proper relational schema.

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

## 11. Checklist

- [ ] All JSONB columns use JSONB type, not JSON (unless verbatim text preservation is required)
- [ ] GIN index created on every JSONB column used in WHERE clauses
- [ ] Queries use `@>` containment or `?` key-exists, not `->>` with `=` (which bypasses GIN)
- [ ] High-cardinality extracted keys have a functional B-tree index: `((metadata ->> 'key'))`
- [ ] Schema validation applied via `jsonb_matches_schema` or CHECK constraint on critical rails
- [ ] Core transactional fields (amount, accounts, status) are proper columns, not JSONB keys
- [ ] Related entities stored as junction tables, not arrays inside JSONB
- [ ] `jsonb_set` used for atomic partial updates (not read-modify-write in application code)
- [ ] Audit log payloads include a `diff` key for fast inspection without comparing full before/after
- [ ] EXPLAIN ANALYZE run on all JSONB queries to verify index usage before deployment
- [ ] Partial GIN indexes considered for JSONB columns with heterogeneous document types

---

<!-- KNOWLEDGE-CHECK
{"questions": [{"text": "You have a GIN index on a JSONB column `metadata` and run: SELECT * FROM payments WHERE metadata ->> 'rail' = 'SWIFT'. Does this query use the GIN index?", "options": ["a) Yes, the GIN index on JSONB supports all operators including ->>", "b) No, the ->> operator extracts a text value and PostgreSQL cannot use the GIN index for a text equality comparison on an extracted value", "c) Yes, but only if the GIN index was created with jsonb_path_ops", "d) It depends on whether the query planner estimates more than 1,000 matching rows"], "correct": 1, "explanation": "The GIN index on a JSONB column supports containment (@>), key-existence (?), and jsonpath (@@, @?) operators. Extracting a value with ->> and comparing it with = is a text comparison on a derived expression, which the GIN index cannot serve. PostgreSQL will perform a sequential scan. To use an index, either rewrite the query as: WHERE metadata @> '{\"rail\": \"SWIFT\"}' (uses GIN), or create a functional B-tree index: CREATE INDEX ON payments ((metadata ->> 'rail')) and keep the ->> query form."}, {"text": "Why is storing a list of related payment IDs as a JSONB array (e.g., {\"payment_ids\": [\"uuid1\", \"uuid2\"]}) problematic in a financial system?", "options": ["a) JSONB arrays are not supported in PostgreSQL 14 and earlier", "b) Foreign keys cannot be enforced on array elements, every membership change rewrites the whole JSONB document, and counting or paginating members needs unnesting — a junction table avoids all of this", "c) JSONB arrays have a maximum size of 255 elements", "d) JSON arrays cannot store UUIDs — they must be stored as strings which prevents indexing"], "correct": 1, "explanation": "Storing related IDs in a JSONB array causes several problems in fintech: (1) PostgreSQL cannot enforce a foreign key on array elements — an id in the array may reference a non-existent payment; (2) adding or removing one member rewrites the whole document, and concurrent changes to the same batch conflict; (3) you cannot directly count members, paginate, or sort by membership attributes without unnesting. (A GIN index can find the batch containing a payment, so lookup speed is not the main issue.) A batch_payments junction table with (batch_id, payment_id) and an index on payment_id solves all of these."}, {"text": "What is the difference between the default GIN operator class and jsonb_path_ops for JSONB indexes?", "options": ["a) jsonb_path_ops is faster for all operations; the default GIN is deprecated", "b) The default GIN supports @>, ?, ?&, ?| (and jsonpath) and is larger; jsonb_path_ops supports @> and jsonpath but not key existence, and produces a smaller index that is faster for containment queries", "c) jsonb_path_ops supports jsonpath expressions while the default GIN does not", "d) The default GIN indexes values only; jsonb_path_ops indexes both keys and values"], "correct": 1, "explanation": "The default GIN operator class indexes every key and value separately, supporting containment (@>), key existence (?, ?&, ?|) and the jsonpath operators (@?, @@). jsonb_path_ops indexes hashes of path+value combinations, so it supports @> and jsonpath but not key existence, and it is usually noticeably smaller and faster for containment lookups. Choose the default when you need key-existence queries; choose jsonb_path_ops when you only use @> / jsonpath."}]}
-->

<!-- PRACTICAL-CHALLENGE
{"title": "JSONB Payment Metadata: Indexing, Querying, and Schema Validation", "difficulty": "advanced", "estimatedMinutes": 80, "tasks": [{"id": "1", "description": "Create a payments table with columnar core fields (id, from_account, to_account, amount_minor, currency, status, payment_rail) and a JSONB metadata column. Insert 100,000 rows: 60,000 SEPA payments with metadata containing sepa_mandate_id, creditor_bic, and purpose_code; 30,000 SWIFT payments with swift_bic and charge_bearer; 10,000 Open Banking payments with consent_id. Create a GIN index on metadata. Run EXPLAIN ANALYZE on a containment query filtering by rail and confirm the query uses the GIN index, not a sequential scan."}, {"id": "2", "description": "Demonstrate the ->> pitfall: run EXPLAIN ANALYZE on SELECT * FROM payments WHERE metadata ->> 'rail' = 'SWIFT' and capture the sequential scan output. Then create a functional B-tree index on (metadata ->> 'rail') and run the same query again. Compare the execution plans and execution times. Write a SQL comment explaining when you would choose the functional B-tree index vs rewriting the query to use @> with the GIN index."}, {"id": "3", "description": "Add a CHECK constraint using either pg_jsonschema (if available) or a manual CHECK that enforces SEPA payments have a non-empty sepa_mandate_id and a creditor_bic matching the BIC format regex. Write a test: attempt to insert a SEPA payment without sepa_mandate_id and verify the INSERT fails with a check constraint violation. Write a Java @Service method that catches DataIntegrityViolationException and translates it to a domain-specific SepaMetadataValidationException."}, {"id": "4", "description": "Build a payment audit log table with before_state JSONB, after_state JSONB, and diff JSONB columns. Write a PostgreSQL trigger function that fires AFTER UPDATE on payments, captures the old and new row state as JSONB using to_jsonb(OLD) and to_jsonb(NEW), computes a diff containing only the changed column names, and inserts a row into the audit log. Test it by updating a payment status and verifying the audit log row contains the correct before_state, after_state, and diff. Create a GIN index on after_state and verify a query searching for all payments that reached status COMPLETED uses the index."}]}
-->
