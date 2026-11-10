---
id: track-10-lesson-14
title: "Audit Tables — Temporal Tables and History Tracking"
slug: audit-tables
track: track-10
trackName: "Database & Data Architecture"
sequence: 14
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [audit, temporal-table, history, bitemporal, trigger]
prerequisites: [track-10-lesson-01, track-10-lesson-03]
---

# Audit Tables — Temporal Tables and History Tracking

> [!NOTE]
> Audit logging is a compliance requirement in every regulated financial system. The question is not whether to build it, but how to build it correctly. Shadow tables driven by database triggers provide reliable, tamper-evident history that cannot be bypassed by application bugs. Bitemporal modelling adds the ability to answer "what did we know, when did we know it" — a question that arises in every regulatory investigation.

## Why Audit Logging Cannot Be Optional in Finance

Financial regulators require that institutions maintain complete, tamper-evident records of:
- Every change to account balances and payment statuses
- Who made configuration changes and when
- The state of a customer's KYC record at any point in time
- Every access to personally identifiable information (for GDPR Article 30)

Application-layer audit logging fails for a predictable reason: code paths that bypass the application (direct DB access, emergency fixes, batch scripts, migration scripts) produce no audit records. The only reliable way to audit every change is at the database layer, using triggers.

There are three progressive levels of audit sophistication:
1. **Append-only log table**: a separate table where each row is an insert-only record of a change event
2. **Shadow (history) table**: a copy of the target table structure, with every historical row version preserved
3. **Bitemporal table**: shadow table with two time dimensions — when the fact was valid in reality, and when we recorded it in the system

---

## Design 1: Append-Only Audit Log

The simplest approach: a generic audit log table with JSONB payload.

```sql
CREATE TABLE audit_log (
    id              BIGSERIAL   PRIMARY KEY,
    table_name      TEXT        NOT NULL,
    record_id       TEXT        NOT NULL,  -- the PK of the changed row
    operation       CHAR(1)     NOT NULL CHECK (operation IN ('I', 'U', 'D')),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by      TEXT,                  -- application user, set by SET LOCAL app.current_user
    old_values      JSONB,
    new_values      JSONB,
    diff            JSONB,                 -- computed: keys that changed
    db_user         TEXT        NOT NULL DEFAULT CURRENT_USER,
    client_ip       INET,
    application     TEXT
);

-- Partition by month for query performance on large audit logs
CREATE TABLE audit_log_2024_01 PARTITION OF audit_log
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Function to create future partitions
CREATE OR REPLACE FUNCTION create_audit_partition(target_month DATE)
RETURNS VOID AS $$
DECLARE
    partition_name TEXT;
    start_date     DATE;
    end_date       DATE;
BEGIN
    start_date     := DATE_TRUNC('month', target_month);
    end_date       := start_date + INTERVAL '1 month';
    partition_name := 'audit_log_' || TO_CHAR(start_date, 'YYYY_MM');

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log
         FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date
    );
END;
$$ LANGUAGE plpgsql;
```

---

## Design 2: Trigger-Based Shadow Table

A shadow table mirrors the structure of the target table with additional columns for history tracking. This approach preserves the full row state at each point in time.

```sql
-- Target table: payments
CREATE TABLE payments (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    amount_minor    BIGINT      NOT NULL,
    currency_code   CHAR(3)     NOT NULL,
    status          TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Shadow table: payments_history
-- Contains all columns from payments plus history-tracking columns
CREATE TABLE payments_history (
    -- History metadata
    history_id      BIGSERIAL   NOT NULL,
    history_op      CHAR(1)     NOT NULL CHECK (history_op IN ('I', 'U', 'D')),
    history_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    history_by      TEXT,                  -- set by application via SET LOCAL
    history_txid    BIGINT      NOT NULL DEFAULT txid_current(),

    -- All columns from payments (verbatim copy)
    id              UUID        NOT NULL,
    tenant_id       UUID        NOT NULL,
    amount_minor    BIGINT      NOT NULL,
    currency_code   CHAR(3)     NOT NULL,
    status          TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (history_id)
);

-- Indexes for common history queries
CREATE INDEX idx_payments_history_id      ON payments_history (id, history_at DESC);
CREATE INDEX idx_payments_history_at      ON payments_history (history_at DESC);
CREATE INDEX idx_payments_history_txid    ON payments_history (history_txid);
```

### The History Trigger Function

```sql
-- Generic trigger function usable across multiple tables
CREATE OR REPLACE FUNCTION capture_history()
RETURNS TRIGGER AS $$
DECLARE
    history_user TEXT;
BEGIN
    -- Application sets this via SET LOCAL app.current_user = 'user@example.com'
    BEGIN
        history_user := current_setting('app.current_user');
    EXCEPTION WHEN OTHERS THEN
        history_user := SESSION_USER;
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO payments_history (
            history_op, history_by,
            id, tenant_id, amount_minor, currency_code, status, created_at, updated_at
        ) VALUES (
            'I', history_user,
            NEW.id, NEW.tenant_id, NEW.amount_minor, NEW.currency_code,
            NEW.status, NEW.created_at, NEW.updated_at
        );
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO payments_history (
            history_op, history_by,
            id, tenant_id, amount_minor, currency_code, status, created_at, updated_at
        ) VALUES (
            'U', history_user,
            NEW.id, NEW.tenant_id, NEW.amount_minor, NEW.currency_code,
            NEW.status, NEW.created_at, NEW.updated_at
        );
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO payments_history (
            history_op, history_by,
            id, tenant_id, amount_minor, currency_code, status, created_at, updated_at
        ) VALUES (
            'D', history_user,
            OLD.id, OLD.tenant_id, OLD.amount_minor, OLD.currency_code,
            OLD.status, OLD.created_at, OLD.updated_at
        );
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach the trigger to the payments table
CREATE TRIGGER payments_history_trigger
    AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION capture_history();
```

### Generic Trigger Using JSONB

For organisations with many tables to audit, a generic JSONB-based trigger is more maintainable:

```sql
CREATE OR REPLACE FUNCTION capture_jsonb_history()
RETURNS TRIGGER AS $$
DECLARE
    history_user TEXT;
    old_row      JSONB;
    new_row      JSONB;
    diff_row     JSONB;
BEGIN
    BEGIN
        history_user := current_setting('app.current_user');
    EXCEPTION WHEN OTHERS THEN
        history_user := SESSION_USER;
    END;

    old_row := CASE WHEN TG_OP = 'INSERT' THEN NULL
                    ELSE row_to_json(OLD)::JSONB END;
    new_row := CASE WHEN TG_OP = 'DELETE' THEN NULL
                    ELSE row_to_json(NEW)::JSONB END;

    -- Compute diff: only keys where value changed
    IF TG_OP = 'UPDATE' THEN
        SELECT jsonb_object_agg(key, value)
        INTO diff_row
        FROM jsonb_each(new_row)
        WHERE (old_row -> key) IS DISTINCT FROM value;
    END IF;

    INSERT INTO audit_log (
        table_name, record_id, operation,
        changed_by, old_values, new_values, diff,
        client_ip, application
    ) VALUES (
        TG_TABLE_NAME,
        COALESCE(
            (row_to_json(COALESCE(NEW, OLD)) ->> 'id'),
            'unknown'
        ),
        LEFT(TG_OP, 1),
        history_user,
        old_row,
        new_row,
        diff_row,
        inet_client_addr(),
        current_setting('application_name', true)
    );

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Apply to any table with one line:
CREATE TRIGGER accounts_audit
    AFTER INSERT OR UPDATE OR DELETE ON accounts
    FOR EACH ROW EXECUTE FUNCTION capture_jsonb_history();

CREATE TRIGGER customers_audit
    AFTER INSERT OR UPDATE OR DELETE ON customers
    FOR EACH ROW EXECUTE FUNCTION capture_jsonb_history();
```

---

## Temporal Tables: System Time vs Application Time

Temporal tables introduce two time dimensions:

- **System time (transaction time)**: when the database row was created/modified — set by the database automatically
- **Application time (valid time)**: when the fact was true in the real world — set by the application

```sql
-- System-time temporal table: PostgreSQL 16+ native syntax (SQL:2011 standard)
-- For PostgreSQL < 16, use the trigger-based approach above

CREATE TABLE account_limits (
    account_id      UUID        NOT NULL,
    limit_type      TEXT        NOT NULL,     -- DAILY_DEBIT, MONTHLY_CREDIT, etc.
    limit_amount    BIGINT      NOT NULL,
    currency_code   CHAR(3)     NOT NULL,

    -- Application time: when this limit was/is valid
    valid_from      TIMESTAMPTZ NOT NULL,
    valid_to        TIMESTAMPTZ NOT NULL DEFAULT 'infinity',

    -- System time: when we recorded this in the database
    sys_period      TSTZRANGE   NOT NULL DEFAULT tstzrange(NOW(), 'infinity'),

    PRIMARY KEY (account_id, limit_type, valid_from)
);

-- Index for AS-OF queries
CREATE INDEX idx_account_limits_period ON account_limits
    USING GIST (account_id, sys_period);

CREATE INDEX idx_account_limits_valid ON account_limits
    (account_id, limit_type, valid_from, valid_to);
```

---

## Bitemporal Data Model

Bitemporal modelling tracks both when something was true in reality (valid time) and when we knew about it (transaction time). This is essential for financial audit because:

- Corrections can be backdated (valid time changes)
- We need to know what the system knew at any point (transaction time)
- Regulatory queries ask "what was the customer's limit on date X, as recorded before date Y"

```sql
-- Bitemporal payments limit history
CREATE TABLE account_limits_history (
    -- History metadata (transaction time)
    history_id      BIGSERIAL   NOT NULL PRIMARY KEY,
    history_op      CHAR(1)     NOT NULL,
    sys_period_start TIMESTAMPTZ NOT NULL,
    sys_period_end   TIMESTAMPTZ NOT NULL DEFAULT 'infinity',

    -- Application time (valid time)
    account_id      UUID        NOT NULL,
    limit_type      TEXT        NOT NULL,
    limit_amount    BIGINT      NOT NULL,
    currency_code   CHAR(3)     NOT NULL,
    valid_from      TIMESTAMPTZ NOT NULL,
    valid_to        TIMESTAMPTZ NOT NULL,

    -- Who made the change
    changed_by      TEXT,
    change_reason   TEXT
);

CREATE INDEX idx_account_limits_history_account
    ON account_limits_history (account_id, limit_type, valid_from, sys_period_start);

-- Trigger to maintain bitemporal history
CREATE OR REPLACE FUNCTION maintain_account_limits_history()
RETURNS TRIGGER AS $$
DECLARE
    history_user TEXT;
BEGIN
    BEGIN
        history_user := current_setting('app.current_user');
    EXCEPTION WHEN OTHERS THEN
        history_user := SESSION_USER;
    END;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        -- Close any open history row for this key
        UPDATE account_limits_history
        SET sys_period_end = NOW()
        WHERE account_id = NEW.account_id
          AND limit_type  = NEW.limit_type
          AND valid_from  = NEW.valid_from
          AND sys_period_end = 'infinity';

        -- Insert new history row
        INSERT INTO account_limits_history (
            history_op,
            sys_period_start,
            account_id, limit_type, limit_amount, currency_code,
            valid_from, valid_to,
            changed_by
        ) VALUES (
            LEFT(TG_OP, 1),
            NOW(),
            NEW.account_id, NEW.limit_type, NEW.limit_amount, NEW.currency_code,
            NEW.valid_from, NEW.valid_to,
            history_user
        );
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        UPDATE account_limits_history
        SET sys_period_end = NOW(),
            history_op     = 'D'
        WHERE account_id   = OLD.account_id
          AND limit_type   = OLD.limit_type
          AND valid_from   = OLD.valid_from
          AND sys_period_end = 'infinity';
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER account_limits_bitemporal
    AFTER INSERT OR UPDATE OR DELETE ON account_limits
    FOR EACH ROW EXECUTE FUNCTION maintain_account_limits_history();
```

---

## Spring Data Envers for JPA Audit

Spring Data Envers provides JPA-level audit without manual trigger maintenance. It is simpler for application teams but has limitations: it does not capture changes made outside the application.

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.springframework.data</groupId>
    <artifactId>spring-data-envers</artifactId>
</dependency>
<dependency>
    <groupId>org.hibernate.orm</groupId>
    <artifactId>hibernate-envers</artifactId>
</dependency>
```

```java
// Enable Envers auditing
@Configuration
@EnableJpaRepositories(repositoryFactoryBeanClass = EnversRevisionRepositoryFactoryBean.class)
public class JpaConfig {}

// Annotate entities to audit
@Entity
@Table(name = "payments")
@Audited  // Hibernate Envers annotation
public class Payment {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "amount_minor")
    private Long amountMinor;

    @Column(name = "currency_code")
    private String currencyCode;

    @Column(name = "status")
    private String status;

    // Envers creates a payments_aud table automatically:
    // payments_aud(id, REV, REVTYPE, amount_minor, currency_code, status)
    // REV = revision number (FK to REVINFO)
    // REVTYPE: 0=ADD, 1=MOD, 2=DEL
}

// Custom revision entity to capture the user who made the change
@Entity
@Table(name = "revinfo")
@RevisionEntity(UserRevisionListener.class)
public class UserRevisionEntity extends DefaultRevisionEntity {

    @Column(name = "changed_by")
    private String changedBy;

    // getter, setter
}

@Component
public class UserRevisionListener implements RevisionListener {

    @Override
    public void newRevision(Object revisionEntity) {
        UserRevisionEntity rev = (UserRevisionEntity) revisionEntity;
        // Obtain user from security context
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null) {
            rev.setChangedBy(auth.getName());
        }
    }
}

// Repository with Envers revision support
@Repository
public interface PaymentRepository
        extends JpaRepository<Payment, UUID>,
                RevisionRepository<Payment, UUID, Long> {
    // RevisionRepository adds:
    // - findRevisions(UUID id)
    // - findRevision(UUID id, Long revisionNumber)
    // - findLastChangeRevision(UUID id)
}

// Service: query history
@Service
@RequiredArgsConstructor
public class PaymentAuditService {

    private final PaymentRepository paymentRepository;

    public List<Revision<Long, Payment>> getPaymentHistory(UUID paymentId) {
        return paymentRepository.findRevisions(paymentId).getContent();
    }

    public Optional<Payment> getPaymentAtRevision(UUID paymentId, Long revision) {
        return paymentRepository.findRevision(paymentId, revision)
                                .map(Revision::getEntity);
    }
}
```

**Limitations of Envers**: changes made via JDBC templates, native SQL, Flyway migrations, or direct database access are not captured. For compliance-critical tables, database triggers are required in addition to or instead of Envers.

---

## Querying Point-in-Time State

```sql
-- What was the payment status at a specific point in time?
-- Using the shadow table approach
SELECT *
FROM payments_history
WHERE id = :payment_id
  AND history_at <= :as_of_time
ORDER BY history_at DESC
LIMIT 1;

-- Full change timeline for a payment
SELECT
    history_op,
    history_at,
    history_by,
    status,
    amount_minor
FROM payments_history
WHERE id = :payment_id
ORDER BY history_at;

-- What was a customer's daily debit limit on a specific date,
-- as recorded in the system before a specific system time?
-- (Bitemporal query: valid time AND system time)
SELECT
    limit_amount,
    valid_from,
    valid_to,
    sys_period_start AS recorded_at,
    changed_by
FROM account_limits_history
WHERE account_id      = :account_id
  AND limit_type      = 'DAILY_DEBIT'
  AND valid_from     <= :query_valid_date        -- fact was valid at this date
  AND valid_to        > :query_valid_date
  AND sys_period_start <= :query_system_time      -- and we knew it by this time
  AND sys_period_end   > :query_system_time
ORDER BY sys_period_start DESC
LIMIT 1;

-- Who changed a payment and when?
SELECT
    history_at,
    history_by,
    history_op,
    LAG(status) OVER (PARTITION BY id ORDER BY history_at) AS previous_status,
    status AS new_status
FROM payments_history
WHERE id = :payment_id
ORDER BY history_at;
```

---

## Compliance Audit Queries

```sql
-- Regulatory query: show all changes made by a specific operator
-- in a date range (for disciplinary investigation)
SELECT
    al.table_name,
    al.record_id,
    al.operation,
    al.changed_at,
    al.old_values,
    al.new_values,
    al.diff
FROM audit_log al
WHERE al.changed_by = :operator_email
  AND al.changed_at BETWEEN :from_date AND :to_date
ORDER BY al.changed_at;

-- Regulatory query: who changed a customer's risk rating and when?
SELECT
    al.changed_at,
    al.changed_by,
    al.old_values ->> 'aml_risk_band' AS old_risk_band,
    al.new_values ->> 'aml_risk_band' AS new_risk_band,
    al.diff ->> 'aml_risk_band' AS changed_field
FROM audit_log al
WHERE al.table_name = 'customer_compliance'
  AND al.record_id  = :customer_id::TEXT
  AND al.diff ? 'aml_risk_band'
ORDER BY al.changed_at;

-- GDPR: show all accesses to a specific customer's PII
SELECT
    al.changed_at,
    al.changed_by,
    al.operation,
    al.table_name
FROM audit_log al
WHERE al.record_id = :customer_id::TEXT
  AND al.table_name IN ('customers', 'customer_compliance', 'customer_documents')
ORDER BY al.changed_at DESC;

-- Summary: how many changes per table per hour (anomaly detection)
SELECT
    DATE_TRUNC('hour', changed_at) AS hour,
    table_name,
    operation,
    COUNT(*) AS change_count
FROM audit_log
WHERE changed_at > NOW() - INTERVAL '24 hours'
GROUP BY hour, table_name, operation
ORDER BY hour DESC, change_count DESC;
```

---

## Immutable Audit Log Design

For compliance, the audit log itself must be tamper-evident. Standard approaches:

```sql
-- Option 1: GRANT only INSERT, never UPDATE or DELETE
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
GRANT INSERT, SELECT ON audit_log TO app_user;

-- Option 2: Row-level security to prevent modification
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_insert_only ON audit_log
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Only allow INSERT for the trigger's SECURITY DEFINER function
-- Application user cannot DELETE or UPDATE

-- Option 3: Use PostgreSQL logical replication to stream audit logs
-- to an append-only store (e.g., S3-backed archival table, immutable S3 objects)

-- Option 4: Cryptographic chaining (hash of previous row's hash + content)
-- This is used in blockchain-style audit logs for high-assurance compliance
ALTER TABLE audit_log ADD COLUMN row_hash TEXT;
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;

-- Hash computed by trigger using pg_crypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Compute hash on insert
CREATE OR REPLACE FUNCTION set_audit_hash()
RETURNS TRIGGER AS $$
DECLARE
    prev_hash TEXT;
BEGIN
    SELECT row_hash INTO prev_hash
    FROM audit_log
    ORDER BY id DESC
    LIMIT 1;

    NEW.prev_hash := COALESCE(prev_hash, 'genesis');
    NEW.row_hash  := encode(
        digest(
            NEW.prev_hash || NEW.table_name || NEW.record_id ||
            NEW.operation || NEW.changed_at::TEXT || COALESCE(NEW.new_values::TEXT, ''),
            'sha256'
        ),
        'hex'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_hash
    BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION set_audit_hash();
```

---

## Performance Considerations

Audit triggers add overhead to every DML operation. Measure and tune:

```sql
-- Check trigger overhead (compare with/without trigger enabled)
EXPLAIN (ANALYZE, BUFFERS)
UPDATE payments SET status = 'SETTLED' WHERE id = :id;

-- If audit overhead is too high, consider:
-- 1. Asynchronous audit via LISTEN/NOTIFY + background worker
-- 2. Only audit status transitions, not every UPDATE
-- 3. Conditional trigger: only fire if relevant columns changed

-- Conditional trigger: only record when status changes
CREATE OR REPLACE FUNCTION capture_payment_status_changes()
RETURNS TRIGGER AS $$
BEGIN
    -- Only capture rows where status actually changed
    IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
        RETURN NEW;  -- no-op: nothing to record
    END IF;

    -- Insert history record...
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Deferred trigger: execute at commit, not immediately
-- This reduces contention in long transactions
CREATE TRIGGER payments_audit_deferred
    AFTER INSERT OR UPDATE OR DELETE ON payments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION capture_history();
```

---

## Key Takeaways

1. **Database triggers are the only reliable audit mechanism** — application-layer logging misses direct DB access, migrations, and emergency patches.
2. **Shadow tables** (one history row per change) provide better query performance for point-in-time lookup than append-only log tables with JSONB diffs.
3. **Bitemporal modelling** is mandatory for products where facts can be backdated (rate changes, limit changes, KYC reclassification).
4. **`SECURITY DEFINER` trigger functions** run as the trigger owner, not the calling application user — this prevents the application from bypassing audit by using a less-privileged connection.
5. **Spring Data Envers** is convenient for application-managed audit but must be supplemented with triggers for compliance tables that can be modified outside the application.
6. **Cryptographic chaining** provides tamper evidence for high-assurance audit logs but adds per-insert serialisation overhead.
7. **Conditional triggers** (only fire when relevant columns change) dramatically reduce audit overhead on high-write tables.
8. **Grant only INSERT on audit tables** — revoke DELETE and UPDATE to prevent tampering.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payments table has a AFTER UPDATE trigger that inserts a row into payments_audit. A developer connects directly to the database using psql (bypassing the application) and runs UPDATE payments SET status = 'settled' WHERE id = $1. Will the audit record be created?",
      "options": ["No, because the trigger only fires for application-layer changes", "Yes, because database triggers fire on all DML operations regardless of connection source", "No, because AFTER UPDATE triggers require the application to call a stored procedure to activate them", "Yes, but only if the trigger is defined as SECURITY DEFINER"],
      "correct": 1,
      "explanation": "Database triggers fire on every DML operation on the table regardless of where the connection originates — application code, psql, pgAdmin, migration scripts, or emergency patches. This is precisely why trigger-based audit is considered more reliable than application-layer logging: it cannot be bypassed by anyone with write access to the database."
    },
    {
      "text": "A financial product allows backdating of limit changes: a risk team member can record that a customer's credit limit was actually changed on a past date. Standard (system-time) audit tables record this as a change made today. What data modelling technique correctly captures both when the change was recorded in the system and when it was effective in the real world?",
      "options": ["Append-only event sourcing with a single created_at timestamp", "Bitemporal modelling with separate valid_time (business effective period) and system_time (transaction recorded period) dimensions", "Slowly Changing Dimension Type 2 with a single effective_date column", "Temporal tables using only SYSTEM TIME as defined in SQL:2011"],
      "correct": 1,
      "explanation": "Bitemporal modelling tracks two independent time axes: valid_time (when the fact was true in the business domain) and system_time (when the fact was recorded in the database). This allows queries like 'what did we believe on 2024-01-15 about a limit that was actually effective from 2024-01-01?' — a question that neither single-axis temporal tables nor event sourcing with one timestamp can answer correctly."
    },
    {
      "text": "A payments_audit table uses cryptographic chaining where each row stores SHA-256(previous_hash || current_row_data). An auditor wants to verify that no rows have been deleted or modified since the chain was established. What query pattern provides this verification?",
      "options": ["SELECT COUNT(*) FROM payments_audit to confirm row count has not decreased", "Recompute the chain hash sequentially from the first row and compare the final computed hash to the stored hash of the last row", "SELECT MAX(created_at) FROM payments_audit to verify the most recent entry matches the expected timestamp", "Compare the payments_audit row count to the payments table row count to detect missing entries"],
      "correct": 1,
      "explanation": "Cryptographic chaining provides tamper evidence through sequential hash dependency: each row's hash depends on the previous row's hash and the row's own data. To verify integrity, recompute hash(row_1_data) = stored_hash_1, then hash(stored_hash_1 || row_2_data) = stored_hash_2, and so on. If any row was modified or deleted, the chain breaks and the final computed hash will not match the stored hash on the last row."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design a Tamper-Evident Audit System for Payment State Transitions",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Create a generic JSONB-based audit trigger function capture_payment_history() that records: table_name, operation (INSERT/UPDATE/DELETE), changed_by (current_user), changed_at (NOW()), old_data (row_to_json(OLD)), new_data (row_to_json(NEW)), and changed_columns (array of column names that actually changed, computed by comparing OLD and NEW). Attach the trigger to the payments table as AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW. Verify that a direct psql UPDATE creates an audit record with the correct changed_columns list."
    },
    {
      "id": "2",
      "description": "Implement bitemporal modelling for payment_limits: add valid_from TIMESTAMPTZ and valid_to TIMESTAMPTZ columns (valid_time dimension) alongside system_period tstzrange generated by a system-time trigger. Write a query that answers: 'What credit limit did we have on record for account X as of system time 2024-06-01, that was effective on business date 2024-05-15?' Ensure the query uses both time dimensions correctly."
    },
    {
      "id": "3",
      "description": "Add cryptographic chaining to the payments_audit table: each row stores prev_hash TEXT and row_hash TEXT where row_hash = encode(sha256(prev_hash || table_name || operation || changed_at::text || COALESCE(new_data::text, old_data::text)), 'hex'). Implement a Java AuditChainVerifier.verifyChain(String tableName) method that reads the chain sequentially and returns a VerificationResult with isValid boolean and the index of the first broken link if invalid. Write a test that inserts 5 audit rows and verifies the chain, then manually updates one row's data and verifies the chain breaks."
    },
    {
      "id": "4",
      "description": "Implement a ConditionalAuditTrigger that only fires when payment-critical columns change (status, amount_cents, account_id) rather than all columns. Use a TG_OP = 'UPDATE' guard with an explicit column change check. Measure the per-row audit overhead using EXPLAIN ANALYZE on a batch UPDATE of 10,000 rows with the trigger enabled vs disabled. Document the overhead as a percentage of total execution time."
    }
  ]
}
-->
