---
id: track-10-lesson-05
title: "Index Strategies — B-Tree, GIN, GiST, and BRIN"
slug: index-strategies
track: track-10
trackName: "Database & Data Architecture"
sequence: 5
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [index, B-tree, GIN, BRIN, covering-index]
prerequisites: []
---

# Index Strategies — B-Tree, GIN, GiST, and BRIN

> [!NOTE]
> Index selection is one of the highest-leverage decisions in database engineering. The difference between a full table scan and an index scan on a 100-million-row transaction table is the difference between a 30-second query and a 5-millisecond one. This lesson teaches you to match index types to access patterns with precision, and to avoid the common mistake of over-indexing update-heavy financial tables.

---

## 1. How PostgreSQL Chooses an Index

The query planner decides whether to use an index by estimating the cost of an index scan versus a sequential scan. Key factors:

- **Selectivity:** How many rows does the predicate match? (High selectivity = fewer rows = index preferred)
- **Index correlation:** How well does the index order match physical row order?
- **Table statistics:** Updated by ANALYZE — stale statistics lead to bad plans
- **random_page_cost / seq_page_cost ratio:** Default 4.0/1.0 — tuned down on SSD/NVMe to ~1.1/1.0

```sql
-- Always start with EXPLAIN ANALYZE to see which index is used
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM transactions
WHERE account_id = 'ACC-1001'
  AND transaction_date >= '2024-01-01'
  AND transaction_date < '2024-04-01';
```

Look for:
- `Index Scan using <index_name>` — index used efficiently
- `Bitmap Index Scan` — multiple index conditions combined
- `Seq Scan` — no suitable index, or planner chose not to use one
- `Buffers: shared hit=X read=Y` — X pages from cache, Y from disk

---

## 2. B-Tree Indexes

B-Tree is PostgreSQL's default index type. It organises keys in a balanced tree, supporting equality, range, prefix, and sorting.

### 2.1 When B-Tree Excels

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

### 2.2 Composite Index Column Order

The most selective column should generally be first (reduces tree traversal):

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

### 2.3 Index Correlation

Index correlation measures how well index order matches heap (physical) order. 1.0 = perfectly correlated; 0 = random. Low correlation means index scans cause many random disk reads.

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

For low-correlation indexes on large tables, a Bitmap Index Scan is often used (collects matching TIDs first, then fetches heap pages in order).

---

## 3. Covering Indexes with INCLUDE

A covering index stores additional non-key columns, allowing the query to be answered entirely from the index without touching the heap ("index-only scan").

### 3.1 Payment History Covering Index

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

### 3.2 When INCLUDE Is Worthwhile

Index-only scans require the heap's visibility map to be current (maintained by VACUUM). Check index-only scan effectiveness:

```sql
SELECT
    indexrelname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE relname = 'transactions';
-- idx_tup_fetch = 0 means all scans are index-only (ideal)
-- idx_tup_fetch > 0 means heap fetches are occurring (VACUUM needed or INCLUDE)
```

---

## 4. Partial Indexes

Partial indexes index only rows matching a WHERE condition. Dramatically smaller and faster for queries targeting a subset of rows.

### 4.1 Pending Transactions Index

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

### 4.2 Active Accounts Index

```sql
-- Only active accounts need account lookups for new transactions
CREATE INDEX idx_accounts_active_customer
ON accounts (customer_id, account_id)
WHERE is_active = TRUE;

-- Closed accounts (potentially most accounts in a mature system)
-- are excluded from this index entirely
```

### 4.3 Null Exclusion Index

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

---

## 5. Expression Indexes

Index a computed expression rather than a column value directly.

```sql
-- Case-insensitive search on beneficiary name
CREATE INDEX idx_beneficiary_name_lower
ON beneficiaries (lower(name));

-- Query must use the same expression:
SELECT * FROM beneficiaries
WHERE lower(name) = lower('John Smith');

-- Date truncation for month-based aggregation
CREATE INDEX idx_txn_month
ON transactions (date_trunc('month', transaction_date));

SELECT
    date_trunc('month', transaction_date) AS month,
    SUM(amount) AS total
FROM transactions
WHERE date_trunc('month', transaction_date) = '2024-01-01'
GROUP BY 1;

-- Last 4 digits of card number for masked display queries
CREATE INDEX idx_card_last4
ON payment_cards (right(card_number_encrypted_hash, 4));
```

---

## 6. GIN Indexes for JSONB and Arrays

GIN (Generalized Inverted Index) indexes each element in a composite value (array, JSONB, text search vector) separately, enabling efficient containment and existence queries.

### 6.1 JSONB Transaction Metadata

Financial systems increasingly store flexible metadata as JSONB:

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

### 6.2 JSONB Path Index

For deeply nested JSONB queries on a specific path:

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

### 6.3 Full-Text Search on Financial Descriptions

```sql
-- Add tsvector column for full-text search on transaction descriptions
ALTER TABLE transactions ADD COLUMN search_vector TSVECTOR;

-- Populate from description
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

---

## 7. GiST Indexes for Range Types

GiST (Generalized Search Tree) supports geometric, range, and custom data types. In fintech, range types are useful for validity periods, rate bands, and fee schedules.

### 7.1 Exchange Rate Validity Ranges

```sql
-- Exchange rates with validity periods (using tstzrange)
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

-- GiST index on the range column
CREATE INDEX idx_exchange_rates_valid
ON exchange_rates USING GIST (from_currency, to_currency, valid_during);

-- Query: find rate valid at a specific time
SELECT rate
FROM exchange_rates
WHERE from_currency = 'USD'
  AND to_currency = 'EUR'
  AND valid_during @> NOW()::TIMESTAMPTZ;
```

### 7.2 Fee Schedule Range Index

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

CREATE INDEX idx_fee_schedule_range
ON fee_schedules USING GIST (product_code, amount_range);

-- Find applicable fee for a 500 transaction
SELECT fee_percent
FROM fee_schedules
WHERE product_code = 'WIRE_TRANSFER'
  AND amount_range @> 500.00::NUMERIC;
```

---

## 8. BRIN Indexes for Time-Series Data

BRIN (Block Range INdex) stores min/max values for ranges of physical blocks. Extremely small (kilobytes vs megabytes for B-tree) but only effective when column values are correlated with physical storage order — which is naturally true for append-only time-series data.

### 8.1 Transaction Audit Log

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

### 8.2 BRIN Limitations

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

**Rule of thumb for BRIN vs B-tree:**
- BRIN: append-only tables, queries spanning large time ranges, table > 100M rows, storage is a concern
- B-tree: random access patterns, single-row lookups, non-time-series data

---

## 9. Index Usage Monitoring

### 9.1 pg_stat_user_indexes

```sql
-- Identify unused indexes (candidates for removal)
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan AS scan_count,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan < 10  -- Used fewer than 10 times since last stats reset
ORDER BY pg_relation_size(indexrelid) DESC;

-- Note: stats are reset by pg_stat_reset() or server restart
-- Run for at least a week before drawing conclusions
```

### 9.2 Missing Index Detection

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

### 9.3 Index Bloat Check

```sql
-- B-tree index bloat estimation
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS current_size,
    round(100.0 * (relpages - estimated_pages) / NULLIF(relpages, 0), 2)
        AS bloat_pct
FROM (
    SELECT
        c.relname AS indexname,
        c.oid AS indexrelid,
        c.relpages,
        ceil(c.reltuples * 1.0
             / floor((8192 - 24) / (8 + 6))) AS estimated_pages
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND c.relname NOT LIKE 'pg_%'
) sub
WHERE relpages > 10
ORDER BY bloat_pct DESC
LIMIT 20;
```

---

## 10. Concurrent Index Creation

Always use `CONCURRENTLY` for index creation in production:

```java
@Component
public class SafeIndexCreator {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    /**
     * Creates an index concurrently without blocking production traffic.
     * Note: Cannot be called inside a transaction (Spring @Transactional).
     * CONCURRENTLY requires the statement to run outside any transaction block.
     */
    public void createIndexConcurrently(String indexName,
                                         String tableName,
                                         String columnExpression) {
        // Check if index already exists
        Integer count = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM pg_indexes WHERE indexname = ?",
            Integer.class, indexName);

        if (count != null && count > 0) {
            log.info("Index {} already exists, skipping creation", indexName);
            return;
        }

        log.info("Creating index {} on {}", indexName, tableName);
        // Note: executeUpdate on a non-transactional JdbcTemplate
        jdbcTemplate.execute(String.format(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS %s ON %s (%s)",
            indexName, tableName, columnExpression));

        log.info("Index {} created successfully", indexName);
    }
}
```

```sql
-- CONCURRENTLY takes two passes over the table:
-- Pass 1: build index from current data
-- Pass 2: catch any changes made during pass 1
-- This means it takes ~2x longer than a standard CREATE INDEX
-- but allows reads and writes throughout

CREATE INDEX CONCURRENTLY idx_txn_account_date_new
ON transactions (account_id, transaction_date DESC)
INCLUDE (amount, currency, status);

-- Check for invalid indexes (failed CONCURRENTLY creates)
SELECT indexname, indisvalid
FROM pg_indexes
JOIN pg_class ON pg_class.relname = indexname
JOIN pg_index ON pg_index.indexrelid = pg_class.oid
WHERE tablename = 'transactions'
  AND NOT indisvalid;
-- Invalid indexes must be dropped and recreated
```

---

## 11. Financial Index Design Patterns

### 11.1 Account Service Index Strategy

```sql
-- Core account lookup indexes
CREATE UNIQUE INDEX idx_accounts_pk
ON accounts (account_id);  -- Primary key (implicit)

CREATE INDEX idx_accounts_customer
ON accounts (customer_id)
INCLUDE (account_id, balance, currency, status);  -- Covering for customer view

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

-- Reporting index (separate from OLTP indexes)
CREATE INDEX idx_txn_date_amount
ON transactions (transaction_date, amount)
INCLUDE (account_id, currency, merchant_category);
-- Supports date-range reports and amount-based analysis
```

### 11.2 Index Maintenance Schedule

```sql
-- Schedule regular REINDEX CONCURRENTLY for bloated indexes
-- Run during low-traffic windows
REINDEX INDEX CONCURRENTLY idx_txn_account_date;

-- Or use pg_repack for index-only repack
-- pg_repack -d payments_db -i idx_txn_account_date
```

---

## Summary

Effective index strategy for financial databases requires matching index types to access patterns:

- **B-tree**: the default for equality, range, sort, and composite queries — column order matters
- **Covering indexes (INCLUDE)**: eliminate heap fetches for read-heavy queries — high impact for account history
- **Partial indexes**: dramatically reduce index size for sparse predicates — use for pending/active subsets
- **Expression indexes**: enable efficient search on computed values — case-insensitive lookups, truncated dates
- **GIN**: JSONB containment, array membership, full-text search — essential for flexible metadata
- **GiST**: range types with exclusion constraints — exchange rate validity, fee schedules
- **BRIN**: append-only time-series — tiny footprint for audit and transaction date ranges
- Monitor `pg_stat_user_indexes` to identify unused indexes and remove them — every index is a write overhead
- Always use `CREATE INDEX CONCURRENTLY` in production

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A query retrieves the most recent 50 transactions for an account: SELECT transaction_date, amount, currency, status FROM transactions WHERE account_id = ? ORDER BY transaction_date DESC LIMIT 50. Which index type would allow PostgreSQL to satisfy this query without touching the heap (index-only scan)?",
      "options": ["A B-tree index on (account_id)", "A B-tree index on (account_id, transaction_date DESC)", "A covering index on (account_id, transaction_date DESC) INCLUDE (amount, currency, status)", "A GIN index on the transactions table"],
      "correct": 2,
      "explanation": "A covering index with INCLUDE stores the projected columns (amount, currency, status) alongside the key columns in the index leaf pages. PostgreSQL can then answer this query entirely from the index without fetching the corresponding heap pages, resulting in an index-only scan and significantly lower I/O."
    },
    {
      "text": "A transactions table has 500 million rows, 99% of which have status = 'completed'. Only 1% have status = 'pending'. A fraud team queries pending transactions frequently by created_at. What index type reduces index size and maintenance cost most effectively for this query pattern?",
      "options": ["A full B-tree index on (status, created_at)", "A partial index on (created_at) WHERE status = 'pending'", "A GIN index on the status column", "A BRIN index on (status, created_at)"],
      "correct": 1,
      "explanation": "A partial index with WHERE status = 'pending' indexes only the small fraction of rows matching the predicate, dramatically reducing index size (1% of a full index), faster VACUUM, and lower write overhead. The query planner uses it for queries that include the matching WHERE condition."
    },
    {
      "text": "A financial audit log table has 10 billion append-only rows ordered by created_at. Queries always filter by date ranges covering multiple days. Which index type offers the best balance of query performance and minimal storage overhead for this pattern?",
      "options": ["B-tree index on created_at", "GIN index on created_at", "BRIN index on created_at", "Hash index on created_at"],
      "correct": 2,
      "explanation": "BRIN (Block Range INdex) stores min/max values for ranges of physical blocks. It is extremely small (kilobytes vs megabytes for B-tree) and highly effective for append-only tables where values are naturally correlated with physical order — exactly the case for a time-ordered audit log. Date range queries eliminate most block ranges using the min/max metadata."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Validate a Complete Index Strategy for a Payment Ledger",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Given a transactions table with columns (transaction_id, account_id, merchant_id, amount, currency, status, transaction_date, created_at, metadata JSONB), design and create the complete index strategy for these five query patterns: (a) account transaction history with date range, (b) pending transaction queue by account, (c) merchant settlement totals, (d) JSONB metadata containment search by processor, (e) append-only audit range queries. Justify each index type chosen."},
    {"id": "2", "description": "Create a covering index for the account transaction history query pattern and verify with EXPLAIN (ANALYZE, BUFFERS) that PostgreSQL uses an Index Only Scan (zero heap fetches). Insert 100,000 rows and run VACUUM to ensure the visibility map is current before testing."},
    {"id": "3", "description": "Write a SafeIndexCreator Java class that checks if an index already exists before attempting CREATE INDEX CONCURRENTLY, logs the creation progress, and handles the case where a previous CONCURRENTLY run left an invalid index (detected via pg_index.indisvalid). The class must not be called inside a @Transactional method."},
    {"id": "4", "description": "Build an index monitoring dashboard query that reports: unused indexes (idx_scan < 10), indexes with high heap fetch ratios (idx_tup_fetch > 0 for read-heavy indexes), and estimated index bloat percentage. Schedule this as a weekly Prometheus metric collection job and set an alert if any index exceeds 30% bloat."}
  ]
}
-->
