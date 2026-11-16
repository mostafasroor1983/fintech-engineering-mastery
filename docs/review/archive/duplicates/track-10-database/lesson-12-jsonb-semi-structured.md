---
id: track-10-lesson-12
title: "JSONB and Semi-Structured Data in PostgreSQL"
slug: jsonb-semi-structured
track: track-10
trackName: "Database & Data Architecture"
sequence: 12
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [JSONB, semi-structured, index, GIN, document-store]
prerequisites: [track-10-lesson-05, track-10-lesson-01]
---

# JSONB and Semi-Structured Data in PostgreSQL

> [!NOTE]
> JSONB is not a NoSQL escape hatch — it is a precision tool. Used correctly, it eliminates entire join hierarchies for flexible attributes while keeping ACID guarantees. Used incorrectly, it hides schema debt and destroys query performance. This lesson teaches you to tell the difference.

## Why Semi-Structured Data Exists in Financial Systems

Financial products evolve faster than database schemas. A wire transfer has 20 fields. An ISO 20022 payment message has 2,000 potential fields depending on message type, country, correspondent bank rules, and regulatory jurisdiction. Modelling every possible field as a separate column creates unmaintainable schemas with hundreds of nullable columns, constant migrations, and application-layer branching logic.

Semi-structured data stored as JSONB in PostgreSQL provides a disciplined middle path: a small, stable set of core columns with strict types, plus a JSONB `attributes` or `metadata` column for the flexible remainder. This pattern appears in:

- **Payment metadata**: processor-specific fields, 3DS authentication data, card network response codes
- **Compliance attributes**: KYC/AML check results that differ by jurisdiction and provider
- **Fraud scores**: feature vectors and model outputs that change with model versions
- **Webhook payloads**: third-party event data with provider-specific schemas
- **Configuration**: per-tenant product configuration that varies by institution

Understanding when to use JSONB and when to normalise is a principal-level design decision that this lesson addresses rigorously.

---

## JSON vs JSONB: Storage Internals

PostgreSQL offers two JSON types. Choosing the wrong one is an easy mistake with significant performance consequences.

**JSON** stores the raw text of the JSON document verbatim. This means:
- Whitespace is preserved
- Duplicate keys are preserved (last-write-wins on read)
- No indexing support beyond expression indexes on specific paths
- Parsing happens on every read — the string is re-parsed each time you access it
- Input validation ensures it is well-formed JSON, nothing more

**JSONB** decomposes the JSON into a binary representation on write:
- Whitespace is stripped
- Duplicate keys are deduplicated (last one wins, as per RFC 7159)
- Keys are sorted for fast key lookup
- Full GIN index support — can index all keys and values simultaneously
- Parsed once on insert; subsequent reads work directly on the binary format
- Slightly higher write cost (~10-15% overhead) due to binary decomposition
- Significantly lower read cost for key access and containment queries

For any operational workload, always use `jsonb`. The JSON type is appropriate only for audit log storage where you need bit-perfect preservation of the original document and you will never query into it.

```sql
-- Never do this for queryable payment attributes
CREATE TABLE payment_events_bad (
    id          UUID PRIMARY KEY,
    payload     JSON  -- parsed on every access, no GIN index support
);

-- Do this instead
CREATE TABLE payment_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID NOT NULL REFERENCES payments(id),
    event_type      TEXT NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attributes      JSONB NOT NULL DEFAULT '{}'
);
```

### Internal JSONB Layout

JSONB uses a custom binary format. Keys are stored as sorted arrays for O(log n) lookup. Nested objects recursively apply the same structure. This means key existence checks and simple key-value extractions are fast even on documents with hundreds of keys — no sequential scan of the text representation.

A practical measurement: on a 1KB JSONB document with 50 keys, extracting a specific key via `->>` is roughly 10x faster than parsing the equivalent JSON text, and the advantage grows with document size.

---

## JSONB Operators: The Complete Reference

PostgreSQL provides a rich set of operators for JSONB. Mastering these is prerequisite to writing efficient queries.

### Extraction Operators

```sql
-- Sample: payment with JSONB metadata
INSERT INTO payment_events (payment_id, event_type, attributes) VALUES
(
    'a1b2c3d4-0000-0000-0000-000000000001',
    'AUTHORISATION_RESPONSE',
    '{
        "processor": "stripe",
        "processor_ref": "ch_3NZvMXKZ2eZvKYlo1FwpnFrA",
        "network": "visa",
        "auth_code": "V12345",
        "risk_score": 23,
        "three_ds": {
            "version": "2.2",
            "eci": "05",
            "cavv": "AAABBJg7AAAAAAAvgdWxEAE="
        },
        "mcc": "5411",
        "terminal_id": "TRM-00492",
        "partial_approval": false,
        "response_codes": ["00"],
        "metadata_version": 3
    }'
);

-- -> returns JSONB (preserves type, includes quotes for strings)
SELECT attributes -> 'processor'          -- returns "stripe"
FROM payment_events;

-- ->> returns TEXT (unwraps to plain string)
SELECT attributes ->> 'processor'         -- returns stripe
FROM payment_events;

-- Nested access via chained -> operators
SELECT attributes -> 'three_ds' -> 'eci'  -- returns "05" (JSONB)
FROM payment_events;

-- #> path operator accepts an array of keys
SELECT attributes #> '{three_ds,version}'  -- returns "2.2" (JSONB)
FROM payment_events;

-- #>> path operator returning text
SELECT attributes #>> '{three_ds,version}' -- returns 2.2 (text)
FROM payment_events;

-- Array element access by index
SELECT attributes -> 'response_codes' -> 0  -- returns "00" (first element)
FROM payment_events;
```

### Containment and Existence Operators

These operators are the foundation for GIN-indexed queries:

```sql
-- @> containment: does the left side contain the right?
SELECT *
FROM payment_events
WHERE attributes @> '{"processor": "stripe", "risk_score": 23}';

-- <@ reverse containment
SELECT *
FROM payment_events
WHERE '{"processor": "stripe"}' <@ attributes;

-- ? key existence
SELECT *
FROM payment_events
WHERE attributes ? 'three_ds';

-- ?| any key exists
SELECT *
FROM payment_events
WHERE attributes ?| ARRAY['three_ds', 'level3_data'];

-- ?& all keys exist
SELECT *
FROM payment_events
WHERE attributes ?& ARRAY['processor', 'auth_code', 'network'];
```

### Modification Operators

```sql
-- || merge operator (right side wins on key conflict)
UPDATE payment_events
SET attributes = attributes || '{"fraud_review": "pending"}'
WHERE id = 'some-uuid';

-- - delete key
UPDATE payment_events
SET attributes = attributes - 'temp_flag'
WHERE id = 'some-uuid';

-- #- delete nested path
UPDATE payment_events
SET attributes = attributes #- '{three_ds,cavv}'  -- remove PCI-sensitive CAVV after processing
WHERE id = 'some-uuid';

-- jsonb_set: update a specific path value
UPDATE payment_events
SET attributes = jsonb_set(attributes, '{risk_score}', '45')
WHERE id = 'some-uuid';

-- jsonb_set with create_missing=true (creates path if absent)
UPDATE payment_events
SET attributes = jsonb_set(attributes, '{fraud_decision,reason}', '"velocity_breach"', true)
WHERE id = 'some-uuid';
```

---

## GIN Indexing for JSONB

GIN (Generalized Inverted Index) is the index type designed for JSONB. Understanding its internals is essential to writing queries that use it.

### How GIN Works for JSONB

A GIN index inverts the JSONB document: instead of indexing the document as a whole, it indexes every individual key-value pair, creating a posting list (list of document IDs) for each. This makes it ideal for containment queries (`@>`) and key existence queries (`?`, `?|`, `?&`).

There are two GIN operator classes for JSONB:

1. **`jsonb_ops`** (default): indexes every key and value. Supports `@>`, `?`, `?|`, `?&`.
2. **`jsonb_path_ops`**: indexes only values (not keys). Smaller index, faster for `@>` containment queries. Does NOT support `?`, `?|`, `?&`.

```sql
-- Default GIN index (jsonb_ops): general purpose
CREATE INDEX idx_payment_events_attrs_gin
    ON payment_events USING GIN (attributes);

-- Path-ops GIN index: optimised for containment queries only
CREATE INDEX idx_payment_events_attrs_path_ops
    ON payment_events USING GIN (attributes jsonb_path_ops);

-- Partial GIN index: only index high-volume event types
CREATE INDEX idx_payment_events_auth_attrs
    ON payment_events USING GIN (attributes)
    WHERE event_type = 'AUTHORISATION_RESPONSE';

-- Expression index on a specific extracted value
-- Use when you query a single key repeatedly with equality
CREATE INDEX idx_payment_events_processor
    ON payment_events ((attributes ->> 'processor'));

-- Expression index with type cast for numeric comparisons
CREATE INDEX idx_payment_events_risk_score
    ON payment_events (((attributes ->> 'risk_score')::INTEGER));
```

### GIN Index Size and Maintenance Cost

GIN indexes are large. A table with 100 million JSONB rows with 20-key documents will have a GIN index several times larger than the table itself. This has implications:

- **Write amplification**: every insert updates potentially dozens of GIN postings
- **Vacuuming**: GIN indexes accumulate pending list entries that require periodic cleanup
- **Autovacuum tuning**: JSONB-heavy tables need more aggressive autovacuum settings

```sql
-- Check index sizes
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE tablename = 'payment_events'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Monitor GIN pending list (large pending list = slower queries until vacuumed)
SELECT
    relname,
    n_dead_tup,
    n_live_tup,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'payment_events';

-- Force GIN cleanup if pending list is large
SELECT gin_clean_pending_list('idx_payment_events_attrs_gin'::regclass);
```

---

## jsonb_path_query: SQL/JSON Path Language

PostgreSQL 12+ supports the SQL/JSON path language through `jsonb_path_query` and related functions. This provides XPath-like navigation with filter expressions.

```sql
-- Basic path query: extract processor from all events
SELECT jsonb_path_query(attributes, '$.processor')
FROM payment_events;

-- Filter: find events where risk_score > 50
SELECT *
FROM payment_events
WHERE jsonb_path_exists(attributes, '$.risk_score ? (@ > 50)');

-- Extract all response codes as an array
SELECT jsonb_path_query_array(attributes, '$.response_codes[*]')
FROM payment_events;

-- Nested filter: find events with 3DS version 2.2
SELECT *
FROM payment_events
WHERE jsonb_path_exists(attributes, '$.three_ds.version ? (@ == "2.2")');

-- Complex filter: high-risk Visa transactions missing 3DS
SELECT
    payment_id,
    attributes ->> 'risk_score' AS risk_score,
    attributes ->> 'network'    AS network
FROM payment_events
WHERE event_type = 'AUTHORISATION_RESPONSE'
  AND jsonb_path_exists(attributes, '$.risk_score ? (@ > 70)')
  AND attributes ->> 'network' = 'visa'
  AND NOT (attributes ? 'three_ds');
```

---

## Production Pattern: Payment Metadata in JSONB

This is the canonical pattern for financial services: a strongly-typed core schema with JSONB for extensible attributes.

```sql
-- Core payments table: everything that participates in business logic is a column
CREATE TABLE payments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    external_ref     TEXT NOT NULL,
    amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
    currency_code    CHAR(3) NOT NULL,
    status           TEXT NOT NULL,
    payment_method   TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Separate JSONB columns per concern (better than one monolithic blob)
    -- Keys in each column are documented in /docs/payment-metadata-schema.md
    processor_data   JSONB NOT NULL DEFAULT '{}',   -- auth codes, network refs, MCC
    risk_data        JSONB NOT NULL DEFAULT '{}',   -- fraud scores, model versions
    compliance_data  JSONB NOT NULL DEFAULT '{}'    -- KYC checks, AML flags
);

-- GIN indexes per concern: smaller and more targeted than a single giant index
CREATE INDEX idx_payments_processor_data ON payments USING GIN (processor_data jsonb_path_ops);
CREATE INDEX idx_payments_risk_data       ON payments USING GIN (risk_data jsonb_path_ops);
CREATE INDEX idx_payments_compliance_data ON payments USING GIN (compliance_data jsonb_path_ops);

-- Specific expression index for high-frequency processor reference lookup
CREATE INDEX idx_payments_processor_ref
    ON payments ((processor_data ->> 'processor_ref'))
    WHERE processor_data ? 'processor_ref';
```

### Java Integration: Reading and Writing JSONB

```java
// build.gradle
// implementation 'org.postgresql:postgresql:42.7.1'
// implementation 'com.fasterxml.jackson.core:jackson-databind:2.16.0'

@Entity
@Table(name = "payments")
public class Payment {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "amount_minor", nullable = false)
    private Long amountMinor;

    @Column(name = "currency_code", nullable = false, length = 3)
    private String currencyCode;

    // Map JSONB to Java Map using custom JPA converter
    @Convert(converter = JsonbConverter.class)
    @Column(name = "processor_data", columnDefinition = "jsonb")
    private Map<String, Object> processorData = new HashMap<>();

    @Convert(converter = JsonbConverter.class)
    @Column(name = "risk_data", columnDefinition = "jsonb")
    private Map<String, Object> riskData = new HashMap<>();

    @Convert(converter = JsonbConverter.class)
    @Column(name = "compliance_data", columnDefinition = "jsonb")
    private Map<String, Object> complianceData = new HashMap<>();
}

@Converter
public class JsonbConverter implements AttributeConverter<Map<String, Object>, String> {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public String convertToDatabaseColumn(Map<String, Object> attribute) {
        if (attribute == null || attribute.isEmpty()) {
            return "{}";
        }
        try {
            return MAPPER.writeValueAsString(attribute);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Cannot serialize JSONB attribute", e);
        }
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> convertToEntityAttribute(String dbData) {
        if (dbData == null || dbData.isBlank() || dbData.equals("{}")) {
            return new HashMap<>();
        }
        try {
            return MAPPER.readValue(dbData, Map.class);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Cannot deserialize JSONB: " + dbData, e);
        }
    }
}
```

### Spring Data Repository with JSONB Queries

```java
@Repository
public interface PaymentRepository extends JpaRepository<Payment, UUID> {

    // Native query for GIN-indexed containment search
    @Query(value = """
        SELECT * FROM payments
        WHERE processor_data @> :filter::jsonb
        ORDER BY created_at DESC
        LIMIT :limit
        """, nativeQuery = true)
    List<Payment> findByProcessorData(
        @Param("filter") String filter,
        @Param("limit") int limit
    );

    // Find high-risk payments for review queue
    @Query(value = """
        SELECT p.* FROM payments p
        WHERE (p.risk_data ->> 'fraud_score')::INTEGER > :threshold
          AND p.status = 'PENDING_REVIEW'
          AND p.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY (p.risk_data ->> 'fraud_score')::INTEGER DESC
        """, nativeQuery = true)
    List<Payment> findHighRiskPendingReview(@Param("threshold") int threshold);

    // Compliance query: payments with sanctions match
    @Query(value = """
        SELECT p.* FROM payments p
        WHERE p.compliance_data @> '{"sanctions_status": "MATCH_FOUND"}'::jsonb
          AND p.created_at BETWEEN :from AND :to
        ORDER BY p.created_at DESC
        """, nativeQuery = true)
    List<Payment> findSanctionsMatches(
        @Param("from") Instant from,
        @Param("to") Instant to
    );
}

@Service
@RequiredArgsConstructor
public class PaymentQueryService {

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    // Surgical JSONB update using jsonb_set — avoids overwriting sibling keys
    public void attachRiskScore(UUID paymentId, int score, String modelVersion) {
        jdbcTemplate.update("""
            UPDATE payments
            SET risk_data = jsonb_set(
                jsonb_set(risk_data, '{fraud_score}', ?::jsonb),
                '{model_version}', ?::jsonb
            ),
            updated_at = NOW()
            WHERE id = ?
            """,
            String.valueOf(score),
            "\"" + modelVersion + "\"",
            paymentId
        );
    }
}
```

---

## Schema-on-Read vs Schema-on-Write

This is the central design tension in JSONB usage. Understanding the trade-offs prevents both over-engineering and under-engineering.

**Schema-on-write** (traditional relational): The schema is enforced at insert time. Invalid data cannot enter the database. Queries are type-safe, optimiser statistics are accurate, and foreign keys work. The cost is migration friction when the schema needs to change.

**Schema-on-read** (JSONB without constraints): Any valid JSON is accepted. The application interprets the shape at query time. The benefit is flexibility; the cost is data quality drift, absent type safety, and query complexity.

**The right approach for financial systems**: a hybrid. Use schema-on-write for the core business entity (amount, currency, status, timestamps, foreign keys), and schema-on-read for the extensible attributes column — but enforce schema-on-read discipline through:

1. Application-layer validation before writing
2. Documentation of all known keys and their types
3. Generated columns to promote frequently-queried JSONB paths to real columns

```sql
-- Promote a hot JSONB path to a generated column for query performance
-- This is the escape hatch when a JSONB key becomes a first-class attribute
ALTER TABLE payments
    ADD COLUMN fraud_score_cache INTEGER
    GENERATED ALWAYS AS ((risk_data ->> 'fraud_score')::INTEGER) STORED;

CREATE INDEX idx_payments_fraud_score ON payments (fraud_score_cache)
    WHERE fraud_score_cache IS NOT NULL;

-- The generated column participates in planner statistics, CHECK constraints,
-- and avoids repeated casting in queries
SELECT *
FROM payments
WHERE fraud_score_cache > 75
  AND status = 'AUTHORISED'
ORDER BY fraud_score_cache DESC;
```

---

## JSONB vs Separate Columns: Performance Decision Matrix

| Factor | Separate Column | JSONB Key |
|---|---|---|
| Query frequency | High (>1% of queries) | Low (<1%) |
| Filtering/ordering | Yes | No or rare |
| Foreign key reference | Needed | Not needed |
| NULL frequency | Low (<10%) | High (>50%) |
| Type safety required | Yes | Negotiable |
| Schema change frequency | Low | High |
| Planner statistics needed | Yes | No |

```sql
-- Benchmark: separate integer column vs JSONB extraction
-- (Run on a table with 10 million rows, with appropriate indexes on both)

-- Option A: separate integer column with B-tree index
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*)
FROM payments
WHERE fraud_score > 75;

-- Option B: JSONB extraction with expression index
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*)
FROM payments
WHERE (risk_data ->> 'fraud_score')::INTEGER > 75;

-- For range queries on numeric fields accessed in >5% of queries,
-- a generated column or separate column is mandatory.
-- For exact-match containment queries, GIN index on JSONB is competitive.
```

A common fintech anti-pattern: storing `account_id`, `currency`, and `amount` in JSONB because "it's flexible." These are core business attributes. They belong in typed columns with indexes and foreign keys. Putting them in JSONB destroys join performance, removes referential integrity, and makes the query planner unable to produce accurate cost estimates.

---

## Flexible Compliance Attributes in JSONB

Compliance requirements vary by jurisdiction, product type, and regulatory change cycle. JSONB is well-suited for compliance attributes that:
- Differ by country (US AML vs EU AML vs APAC requirements)
- Evolve with regulatory change without requiring schema migrations
- Include third-party enrichment data (KYC provider responses)

```sql
CREATE TABLE customer_compliance (
    customer_id     UUID PRIMARY KEY REFERENCES customers(id),
    kyc_status      TEXT NOT NULL DEFAULT 'PENDING',  -- core attribute: column
    aml_risk_band   TEXT,                              -- core attribute: column
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     UUID REFERENCES users(id),

    -- Jurisdiction-specific, provider-specific, evolving attributes
    kyc_attributes  JSONB NOT NULL DEFAULT '{}',
    aml_attributes  JSONB NOT NULL DEFAULT '{}',
    pep_attributes  JSONB NOT NULL DEFAULT '{}'   -- politically exposed person data
);

CREATE INDEX idx_customer_compliance_kyc ON customer_compliance USING GIN (kyc_attributes);
CREATE INDEX idx_customer_compliance_aml ON customer_compliance USING GIN (aml_attributes);
CREATE INDEX idx_customer_compliance_pep ON customer_compliance USING GIN (pep_attributes);

-- Sample KYC document from a Jumio-style provider:
-- {
--   "provider": "jumio",
--   "check_id": "jm_7x8K2nP...",
--   "id_type": "PASSPORT",
--   "id_country": "GBR",
--   "id_expiry": "2029-04-15",
--   "liveness_score": 0.98,
--   "similarity_score": 0.95,
--   "document_checks": ["MRZ_OK", "CHIP_OK", "EXPIRY_OK"],
--   "face_match": true,
--   "enhanced_verification": {
--     "peps_sanction_match": false,
--     "adverse_media_match": false
--   }
-- }

-- Query: customers with passport expiring within 90 days
SELECT
    c.id,
    c.email,
    cc.kyc_attributes ->> 'id_expiry' AS id_expiry,
    cc.kyc_attributes ->> 'id_country' AS id_country
FROM customer_compliance cc
JOIN customers c ON c.id = cc.customer_id
WHERE cc.kyc_attributes ? 'id_expiry'
  AND (cc.kyc_attributes ->> 'id_expiry')::DATE
      BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'
ORDER BY (cc.kyc_attributes ->> 'id_expiry')::DATE;

-- Query: enhanced verification failures (sanctions or adverse media)
SELECT c.id, c.email
FROM customer_compliance cc
JOIN customers c ON c.id = cc.customer_id
WHERE cc.kyc_attributes @> '{"enhanced_verification": {"peps_sanction_match": true}}'
   OR cc.kyc_attributes @> '{"enhanced_verification": {"adverse_media_match": true}}';
```

---

## Updating JSONB Safely Under Concurrency

Concurrent JSONB updates are a source of subtle bugs. The `||` merge operator replaces the entire document, creating lost-update race conditions.

```sql
-- DANGEROUS: lost update race condition
-- Thread A and Thread B both read risk_data = {"fraud_score": 23}
-- Thread A updates fraud_score to 45: {"fraud_score": 45}
-- Thread B runs: risk_data = {"fraud_score": 23} || {"model_version": "v2"}
--              = {"fraud_score": 23, "model_version": "v2"}
-- Thread A's update to fraud_score is LOST

UPDATE payments
SET risk_data = risk_data || '{"model_version": "v2"}'  -- UNSAFE
WHERE id = :id;

-- SAFE: jsonb_set only modifies the specific path; acquire row lock first
BEGIN;
SELECT id FROM payments WHERE id = :id FOR UPDATE;  -- acquires row-level lock

UPDATE payments
SET risk_data = jsonb_set(risk_data, '{model_version}', '"v2"')
WHERE id = :id;
COMMIT;

-- ALTERNATIVE: for high-contention attribute updates, use a key-value satellite table
CREATE TABLE payment_attributes (
    payment_id  UUID NOT NULL REFERENCES payments(id),
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (payment_id, key)
);
-- This avoids JSONB update contention at the cost of a join
-- INSERT ... ON CONFLICT (payment_id, key) DO UPDATE provides true upsert semantics
```

---

## Useful JSONB Functions for Financial Queries

```sql
-- jsonb_each: expand object to (key, value) rows
SELECT key, value
FROM payment_events, jsonb_each(attributes)
WHERE id = 'some-uuid';

-- jsonb_object_keys: enumerate all keys in a document
SELECT DISTINCT jsonb_object_keys(attributes) AS key
FROM payment_events
ORDER BY key;

-- jsonb_array_elements: expand array to rows
SELECT elem
FROM payment_events,
     jsonb_array_elements(attributes -> 'response_codes') AS elem
WHERE id = 'some-uuid';

-- jsonb_typeof: check type at a path before casting
SELECT jsonb_typeof(attributes -> 'risk_score')  -- 'number', 'string', 'boolean', etc.
FROM payment_events
WHERE id = 'some-uuid';

-- jsonb_strip_nulls: remove null-valued keys before storage
INSERT INTO payment_events (payment_id, event_type, attributes)
VALUES (:payment_id, 'TOKENISATION', jsonb_strip_nulls(:raw_attributes::jsonb));

-- jsonb_build_object: construct JSONB in a query
SELECT
    p.id,
    jsonb_build_object(
        'payment_id',  p.id,
        'amount',      p.amount_minor,
        'currency',    p.currency_code,
        'fraud_score', p.risk_data -> 'fraud_score',
        'processor',   p.processor_data -> 'processor'
    ) AS summary
FROM payments p
WHERE p.status = 'AUTHORISED'
  AND p.created_at > NOW() - INTERVAL '1 hour';

-- Aggregate JSONB across rows
SELECT
    DATE_TRUNC('hour', occurred_at) AS hour,
    jsonb_agg(attributes -> 'processor') AS processors_seen
FROM payment_events
WHERE event_type = 'AUTHORISATION_RESPONSE'
  AND occurred_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour;
```

---

## Monitoring JSONB Performance

```sql
-- Identify queries doing JSONB seq scans instead of GIN scans
SELECT
    query,
    calls,
    ROUND(mean_exec_time::NUMERIC, 2) AS mean_ms,
    ROUND(total_exec_time::NUMERIC, 2) AS total_ms
FROM pg_stat_statements
WHERE query ILIKE '%risk_data%'
   OR query ILIKE '%processor_data%'
ORDER BY total_exec_time DESC
LIMIT 20;

-- Check index usage on JSONB indexes
SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE indexname LIKE '%gin%'
ORDER BY idx_scan DESC;

-- Table bloat check: JSONB updates cause HOT chain growth
SELECT
    relname,
    n_dead_tup,
    n_live_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE relname IN ('payments', 'payment_events', 'customer_compliance')
ORDER BY dead_pct DESC;
```

---

## Key Takeaways

1. **Always use JSONB, never JSON** for queryable semi-structured data. JSON is only for archival of original documents.
2. **GIN index with `jsonb_path_ops`** for containment queries (`@>`); use default `jsonb_ops` when you also need key existence queries (`?`).
3. **Expression indexes** `((attributes ->> 'key')::TYPE)` for single-key equality or range queries accessed frequently.
4. **Separate JSONB columns by concern** (`processor_data`, `risk_data`, `compliance_data`) rather than one monolithic blob.
5. **Generated columns** to promote hot JSONB paths to real columns without application changes.
6. **`jsonb_set` over `||` merge** for concurrent updates to avoid lost-update races.
7. **Core business attributes belong in columns** — amount, currency, account IDs, status.
8. **Monitor GIN pending list size** — large pending lists degrade query performance until vacuum runs.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payments table has a JSONB column risk_data. Two concurrent transactions both read risk_data = {\"fraud_score\": 23} and then each attempt to add a different key: Transaction A does UPDATE SET risk_data = risk_data || '{\"model_version\": \"v2\"}' and Transaction B does UPDATE SET risk_data = risk_data || '{\"fraud_score\": 45}'. Transaction A commits first, then Transaction B commits. What is the final state of risk_data?",
      "options": ["{\"fraud_score\": 45, \"model_version\": \"v2\"}", "{\"fraud_score\": 23, \"model_version\": \"v2\"}", "{\"fraud_score\": 45}", "A deadlock error is raised"],
      "correct": 2,
      "explanation": "The || merge operator replaces the entire document with the merged result. Transaction B read risk_data when it was {\"fraud_score\": 23}, merged with {\"fraud_score\": 45}, and wrote {\"fraud_score\": 45} — overwriting Transaction A's model_version update. This is a lost-update race condition. The fix is to use jsonb_set to modify only the specific path, combined with SELECT FOR UPDATE to serialize access."
    },
    {
      "text": "A query filters payments using: WHERE processor_data @> '{\"network\": \"visa\"}'. The table has two GIN indexes: one with jsonb_ops and one with jsonb_path_ops. Which index does PostgreSQL use for this containment query, and what is the difference in which operators each supports?",
      "options": ["jsonb_ops for containment; jsonb_path_ops only supports full-text search", "Either can be used; jsonb_path_ops is smaller and faster for @> but does not support key existence operators (?, ?|, ?&), while jsonb_ops supports all operators", "Only jsonb_ops supports @> containment; jsonb_path_ops cannot handle it", "jsonb_path_ops must be used for containment; jsonb_ops is for key existence only"],
      "correct": 1,
      "explanation": "Both GIN operator classes support the @> containment operator. jsonb_path_ops creates a smaller index (indexes values, not keys) and is faster for @> queries. jsonb_ops creates a larger index but additionally supports key existence operators (?, ?|, ?&). For a pure containment query, either works, but jsonb_path_ops is preferred for performance when you don't need key existence queries."
    },
    {
      "text": "A fraud_score stored in JSONB risk_data is queried in over 20% of all payment queries and is used in ORDER BY and range comparisons. What architectural change produces the best query performance?",
      "options": ["Create a GIN index on risk_data", "Create an expression index on ((risk_data ->> 'fraud_score')::INTEGER)", "Promote fraud_score to a generated column: GENERATED ALWAYS AS ((risk_data ->> 'fraud_score')::INTEGER) STORED with a B-tree index", "Move all JSONB fields to separate columns"],
      "correct": 2,
      "explanation": "A generated column promotes the JSONB value to a first-class typed column without application changes. It participates in planner statistics (enabling accurate cost estimates), supports B-tree indexes for range and equality queries, can have CHECK constraints, and avoids per-query type casting overhead. For a field accessed in >5% of queries, this is the correct evolution path from JSONB."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Optimize a JSONB-Backed Payment Metadata System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design a payments table with separate JSONB columns for processor_data, risk_data, and compliance_data. Create appropriate GIN indexes (using jsonb_path_ops for containment-heavy columns). Write queries for: (a) find all Stripe payments, (b) find payments with fraud_score > 70, (c) find payments with sanctions matches. Use EXPLAIN ANALYZE to verify each query uses a GIN index scan, not a sequential scan."},
    {"id": "2", "description": "Implement a PaymentQueryService.attachRiskScore(UUID paymentId, int score, String modelVersion) method that uses jsonb_set to surgically update only the fraud_score and model_version keys within risk_data, without overwriting other keys. Write a concurrent test where 10 threads simultaneously attach different risk scores to the same payment and verify no lost updates occur (use SELECT FOR UPDATE to serialize access)."},
    {"id": "3", "description": "Create a Flyway migration that promotes the high-frequency fraud_score JSONB path to a generated column (GENERATED ALWAYS AS ((risk_data ->> 'fraud_score')::INTEGER) STORED) and adds a B-tree index. The migration must backfill any nulls in risk_data where fraud_score is missing. Write a Testcontainers test verifying the generated column is populated correctly and the index is used for WHERE fraud_score_cache > 75."},
    {"id": "4", "description": "Build a JSONB monitoring service that checks: (a) GIN index pending list size via gin_clean_pending_list(), alerting if > 10,000 pending entries, (b) dead tuple percentage for JSONB-heavy tables, alerting if > 15%, and (c) identifies queries doing sequential scans on JSONB columns using pg_stat_statements. Run this as a scheduled job every hour and expose results as Prometheus metrics."}
  ]
}
-->
