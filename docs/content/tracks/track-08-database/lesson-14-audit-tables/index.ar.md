---
id: track-08-lesson-14
title: "جداول التدقيق — الجداول الزمنية وتتبّع السجل التاريخي"
slug: audit-tables
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 14
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [audit, temporal-table, history, bitemporal, trigger]
prerequisites: [track-08-lesson-01, track-08-lesson-03]
---

# جداول التدقيق — الجداول الزمنية وتتبع السجل التاريخي

> [!NOTE]
> سجل التدقيق متطلب امتثال في كل نظام مالي خاضع للتنظيم. والسؤال ليس هل تبنيه، بل كيف تبنيه بشكل صحيح. فجداول الظل التي تغذيها مشغّلات (triggers) قاعدة البيانات توفر سجلًا تاريخيًا موثوقًا لا تستطيع أخطاء التطبيق والأبواب الجانبية تخطيه (فقط الأدوار المميزة القادرة على تعطيل المشغّلات تستطيع ذلك — فقيّد تلك الأدوار وراقبها). ويضيف النمذجة ثنائية الزمن (bitemporal) القدرة على الإجابة عن "ماذا كنا نعرف، ومتى عرفناه" — سؤال يُطرح كثيرًا في التحقيقات الرقابية.

## لماذا لا يمكن أن يكون سجل التدقيق اختياريًا في المال

تشترط الجهات الرقابية المالية أن تحتفظ المؤسسات بسجلات كاملة تكشف أي عبث، لـ:
- كل تغيير في أرصدة الحسابات وحالات المدفوعات
- من أجرى تغييرات الإعدادات ومتى
- حالة سجل KYC للعميل في أي لحظة زمنية
- الوصول إلى البيانات الشخصية حيث يلزم (مبدأ المساءلة في GDPR) — ولاحظ أن المشغّلات ترى *التغييرات* فقط؛ أما القراءات فتحتاج آلية منفصلة مثل pgAudit أو سجلات وصول التطبيق

يفشل سجل التدقيق على مستوى التطبيق لسبب متوقع: مسارات الشيفرة التي تتجاوز التطبيق (الوصول المباشر لقاعدة البيانات، والإصلاحات الطارئة، والسكربتات الدفعية، وسكربتات الترحيل) لا تنتج سجلات تدقيق. وأوثق مكان لتدقيق كل تغيير هو طبقة قاعدة البيانات: المشغّلات (هذا الدرس) أو CDC من WAL ‏(الدرس 11).

هناك ثلاثة مستويات متدرجة لتطور التدقيق:
1. **جدول سجل للإلحاق فقط**: جدول منفصل كل صف فيه سجل إدراج فقط لحدث تغيير
2. **جدول ظل (تاريخي)**: نسخة من بنية الجدول المستهدف، تُحفظ فيها كل نسخة تاريخية من الصف
3. **جدول ثنائي الزمن**: جدول ظل ببعدين زمنيين — متى كانت الحقيقة صالحة في الواقع، ومتى سجلناها في النظام

## التصميم 1: سجل تدقيق للإلحاق فقط

أبسط نهج: جدول سجل تدقيق عام بحمولة JSONB.

```sql
CREATE TABLE audit_log (
    id              BIGSERIAL,
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
    application     TEXT,
    -- on a partitioned table the primary key must include the partition key
    PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);

-- Partition by month for query performance and cheap archival of old months
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

## التصميم 2: جدول ظل قائم على المشغّلات

يعكس جدول الظل بنية الجدول المستهدف مع أعمدة إضافية لتتبع السجل التاريخي. ويحفظ هذا النهج حالة الصف الكاملة في كل لحظة زمنية.

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

### دالة المشغّل التاريخي

```sql
-- Trigger function for payments (table-specific; see the generic JSONB
-- version below for many tables)
CREATE OR REPLACE FUNCTION capture_history()
RETURNS TRIGGER AS $$
DECLARE
    history_user TEXT;
BEGIN
    -- Application sets this via SET LOCAL app.current_user = 'user@example.com'
    -- missing_ok = true: NULL instead of an error when the app did not set it
    -- (no EXCEPTION block -- that would start a subtransaction per row)
    history_user := COALESCE(NULLIF(current_setting('app.current_user', true), ''),
                             SESSION_USER);

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
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;  -- always pin search_path in SECURITY DEFINER

-- Attach the trigger to the payments table
CREATE TRIGGER payments_history_trigger
    AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION capture_history();
```

### مشغّل عام باستخدام JSONB

للمؤسسات التي لديها جداول كثيرة تحتاج تدقيقًا، يكون المشغّل العام القائم على JSONB أسهل صيانة:

```sql
CREATE OR REPLACE FUNCTION capture_jsonb_history()
RETURNS TRIGGER AS $$
DECLARE
    history_user TEXT;
    old_row      JSONB;
    new_row      JSONB;
    diff_row     JSONB;
BEGIN
    -- missing_ok = true: NULL instead of an error when the app did not set it
    -- (no EXCEPTION block -- that would start a subtransaction per row)
    history_user := COALESCE(NULLIF(current_setting('app.current_user', true), ''),
                             SESSION_USER);

    old_row := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
    new_row := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

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
        COALESCE(COALESCE(new_row, old_row) ->> 'id', 'unknown'),
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
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;  -- always pin search_path in SECURITY DEFINER

-- Apply to any table with one line:
CREATE TRIGGER accounts_audit
    AFTER INSERT OR UPDATE OR DELETE ON accounts
    FOR EACH ROW EXECUTE FUNCTION capture_jsonb_history();

CREATE TRIGGER customers_audit
    AFTER INSERT OR UPDATE OR DELETE ON customers
    FOR EACH ROW EXECUTE FUNCTION capture_jsonb_history();
```

## الجداول الزمنية: زمن النظام مقابل زمن التطبيق

تُدخل الجداول الزمنية بعدين زمنيين:

- **زمن النظام (زمن المعاملة)**: متى أُنشئ صف قاعدة البيانات أو عُدّل — تضبطه قاعدة البيانات تلقائيًا
- **زمن التطبيق (الزمن الصالح)**: متى كانت الحقيقة صحيحة في العالم الواقعي — يضبطه التطبيق

```sql
-- PostgreSQL has NO native system-versioned tables (SQL:2011 SYSTEM
-- VERSIONING). The period columns below are plain columns maintained by
-- triggers (or the temporal_tables extension).
-- PostgreSQL 18 adds WITHOUT OVERLAPS keys for application-time periods.
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- "=" on UUID inside GiST

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

-- No two validity periods for the same account + limit may overlap
ALTER TABLE account_limits ADD CONSTRAINT no_overlapping_validity
    EXCLUDE USING gist (account_id WITH =, limit_type WITH =,
                        tstzrange(valid_from, valid_to) WITH &&);

-- Index for AS-OF queries
CREATE INDEX idx_account_limits_period ON account_limits
    USING GIST (account_id, sys_period);

CREATE INDEX idx_account_limits_valid ON account_limits
    (account_id, limit_type, valid_from, valid_to);
```

## نموذج البيانات ثنائي الزمن

تتتبع النمذجة ثنائية الزمن متى كان الشيء صحيحًا في الواقع (الزمن الصالح) ومتى عرفنا به (زمن المعاملة). وهذا أساسي للتدقيق المالي لأن:

- التصحيحات يمكن أن تُؤرخ بأثر رجعي (يتغير الزمن الصالح)
- نحتاج معرفة ما كان النظام يعرفه في أي لحظة (زمن المعاملة)
- الاستعلامات الرقابية تسأل "ما كان حد العميل في التاريخ X، كما سُجل قبل التاريخ Y"

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
    -- missing_ok = true: NULL instead of an error when the app did not set it
    -- (no EXCEPTION block -- that would start a subtransaction per row)
    history_user := COALESCE(NULLIF(current_setting('app.current_user', true), ''),
                             SESSION_USER);

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        -- On UPDATE, close the open history row of the OLD key (the key
        -- itself -- e.g. valid_from -- may have changed)
        IF TG_OP = 'UPDATE' THEN
            UPDATE account_limits_history
            SET sys_period_end = NOW()
            WHERE account_id = OLD.account_id
              AND limit_type  = OLD.limit_type
              AND valid_from  = OLD.valid_from
              AND sys_period_end = 'infinity';
        END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;  -- always pin search_path in SECURITY DEFINER

CREATE TRIGGER account_limits_bitemporal
    AFTER INSERT OR UPDATE OR DELETE ON account_limits
    FOR EACH ROW EXECUTE FUNCTION maintain_account_limits_history();
```

## ‏Spring Data Envers لتدقيق JPA

يوفر Spring Data Envers تدقيقًا على مستوى JPA دون صيانة يدوية للمشغّلات. وهو أبسط لفرق التطبيقات لكن له قيود: فهو لا يلتقط التغييرات التي تحدث خارج التطبيق.

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

    // Envers writes to a payments_aud table (generated by Hibernate's
    // schema tool in dev; in production create it with a Flyway migration):
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
                RevisionRepository<Payment, UUID, Integer> {
    // Integer: DefaultRevisionEntity uses an int revision number
    // RevisionRepository adds:
    // - findRevisions(UUID id)
    // - findRevision(UUID id, Integer revisionNumber)
    // - findLastChangeRevision(UUID id)
}

// Service: query history
@Service
@RequiredArgsConstructor
public class PaymentAuditService {

    private final PaymentRepository paymentRepository;

    public List<Revision<Integer, Payment>> getPaymentHistory(UUID paymentId) {
        return paymentRepository.findRevisions(paymentId).getContent();
    }

    public Optional<Payment> getPaymentAtRevision(UUID paymentId, Integer revision) {
        return paymentRepository.findRevision(paymentId, revision)
                                .map(Revision::getEntity);
    }
}
```

**قيود Envers**: التغييرات التي تتم عبر JDBC templates، أو SQL الأصلي، أو عبارات JPQL الجماعية `UPDATE`/`DELETE`، أو ترحيلات Flyway، أو الوصول المباشر لقاعدة البيانات لا تُلتقط. وللجداول الحرجة للامتثال، المشغّلات مطلوبة إضافة إلى Envers أو بدلًا منه.

## استعلام الحالة في لحظة زمنية

```sql
-- What was the payment status at a specific point in time?
-- Using the shadow table approach
SELECT *
FROM payments_history
WHERE id = :payment_id
  AND history_at <= :as_of_time
ORDER BY history_at DESC, history_id DESC   -- tie-break: same-transaction changes
LIMIT 1;
-- If the returned row has history_op = 'D', the payment no longer existed

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

## استعلامات تدقيق الامتثال

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

-- GDPR: all CHANGES to a specific customer's personal data
-- (reads are not captured by triggers -- use pgAudit or app access logs)
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

## تصميم سجل تدقيق غير قابل للتغيير

للامتثال، يجب أن يكون سجل التدقيق نفسه كاشفًا للعبث. والنُهج المعتادة:

```sql
-- Option 1: the application role gets no direct rights at all; only the
-- SECURITY DEFINER trigger function (owned by a separate audit_owner role)
-- writes. Readers get SELECT only.
REVOKE ALL ON audit_log FROM app_user;
GRANT SELECT ON audit_log TO auditor;
-- (the table owner and superusers can still modify it -- keep those roles
--  out of daily use and alert on their activity)

-- Option 2: Row-level security as a second line of defence
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;   -- applies to the owner too

-- Policies exist only for INSERT and SELECT. With RLS on, UPDATE and DELETE
-- have no policy, so they match no rows.
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_read   ON audit_log FOR SELECT USING (true);

-- Option 3: Stream the audit log out of the database via CDC (Lesson 11)
-- into an append-only store, e.g. Kafka -> S3 with Object Lock (WORM)

-- Option 4: Cryptographic chaining (hash of previous row's hash + content)
-- This is used in blockchain-style audit logs for high-assurance compliance
ALTER TABLE audit_log ADD COLUMN row_hash TEXT;
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;

ALTER TABLE audit_log ADD COLUMN chain_seq BIGINT;
CREATE INDEX idx_audit_log_chain_seq ON audit_log (chain_seq);

-- Hash computed by trigger using pgcrypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Compute hash on insert
CREATE OR REPLACE FUNCTION set_audit_hash()
RETURNS TRIGGER AS $$
DECLARE
    v_prev_hash TEXT;
    v_prev_seq  BIGINT;
BEGIN
    -- Serialise chain appends: without this lock, two concurrent inserts
    -- would both link to the same previous row and fork the chain.
    -- The lock is held until commit -- this is the throughput cost.
    PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));

    SELECT row_hash, chain_seq INTO v_prev_hash, v_prev_seq
    FROM audit_log
    ORDER BY chain_seq DESC NULLS LAST
    LIMIT 1;

    -- chain_seq is assigned under the lock, so it follows chain order
    -- (BIGSERIAL ids are handed out before the lock and can be out of order)
    NEW.chain_seq := COALESCE(v_prev_seq, 0) + 1;
    NEW.prev_hash := COALESCE(v_prev_hash, 'genesis');
    NEW.row_hash  := encode(
        digest(
            -- explicit separators, NULL-safe fields, and the timestamp as an
            -- epoch number (its text form would depend on the TimeZone setting)
            concat_ws('|',
                NEW.chain_seq, NEW.prev_hash, NEW.table_name, NEW.record_id,
                NEW.operation, EXTRACT(EPOCH FROM NEW.changed_at),
                COALESCE(NEW.changed_by, ''),
                COALESCE(NEW.old_values::TEXT, ''),
                COALESCE(NEW.new_values::TEXT, '')),
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

## اعتبارات الأداء

تضيف مشغّلات التدقيق كلفة إلى كل عملية DML. فقِسها واضبطها:

```sql
-- Check trigger overhead (compare with/without trigger enabled)
EXPLAIN (ANALYZE, BUFFERS)
UPDATE payments SET status = 'SETTLED' WHERE id = :id;

-- If audit overhead is too high, consider:
-- 1. Asynchronous audit via CDC (Lesson 11) -- durable, unlike
--    LISTEN/NOTIFY, whose messages are lost if no listener is connected
-- 2. Only audit status transitions, not every UPDATE
-- 3. Conditional trigger: only fire if relevant columns changed

-- Best: a WHEN clause -- the function is not even called otherwise
CREATE TRIGGER payments_status_audit
    AFTER UPDATE ON payments
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION capture_history();

-- Alternative: the same check inside the function
CREATE OR REPLACE FUNCTION capture_payment_status_changes()
RETURNS TRIGGER AS $$
BEGIN
    -- Only capture rows where status actually changed (NULL-safe)
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
        RETURN NEW;  -- no-op: nothing to record
    END IF;

    -- Insert history record...
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;  -- always pin search_path in SECURITY DEFINER

-- Deferred trigger: runs at commit instead of after each statement.
-- Only CONSTRAINT triggers can be deferred. It moves the work to commit
-- time; it does not reduce the total work or the row locks held.
CREATE CONSTRAINT TRIGGER payments_audit_deferred
    AFTER INSERT OR UPDATE OR DELETE ON payments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION capture_history();
```

## الخلاصات الأساسية

1. **الالتقاط على مستوى قاعدة البيانات (المشغّلات أو CDC) هو آلية التدقيق الموثوقة** — فسجل التطبيق يفوته الوصول المباشر لقاعدة البيانات، والترحيلات، والإصلاحات الطارئة.
2. **جداول الظل** (صف تاريخي واحد لكل تغيير) توفر أداء استعلام أفضل للبحث في لحظة زمنية من جداول السجل للإلحاق فقط مع فروق JSONB.
3. **النمذجة ثنائية الزمن** إلزامية للمنتجات التي يمكن أن تُؤرخ فيها الحقائق بأثر رجعي (تغييرات الأسعار، وتغييرات الحدود، وإعادة تصنيف KYC).
4. **دوال المشغّلات بـ `SECURITY DEFINER`** تعمل بصلاحيات مالك الدالة، لا مستخدم التطبيق المستدعي — فيستطيع المشغّل الكتابة إلى جداول تاريخية لا يستطيع دور التطبيق نفسه تعديلها. وثبّت دائمًا `search_path` على هذه الدوال.
5. **‏Spring Data Envers** مريح للتدقيق الذي يديره التطبيق لكن يجب استكماله بالمشغّلات للجداول الحرجة للامتثال التي يمكن تعديلها خارج التطبيق.
6. **التسلسل التشفيري** يوفر كشف العبث لسجلات التدقيق عالية الضمان لكنه يضيف كلفة تسلسل لكل إدراج.
7. **المشغّلات الشرطية** (تعمل فقط حين تتغير الأعمدة المعنية) تقلل كلفة التدقيق كثيرًا على الجداول كثيفة الكتابة.
8. **لا تعطِ أدوار التطبيق UPDATE/DELETE على جداول التدقيق** (والأفضل ألا تعطيها أي صلاحيات مباشرة) وقيّد الأدوار القادرة على تعطيل المشغّلات.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لجدول payments مشغّل AFTER UPDATE يدرج صفًا في payments_audit. ويتصل مطوّر مباشرة بقاعدة البيانات عبر psql (متجاوزًا التطبيق) ويشغّل UPDATE payments SET status = 'settled' WHERE id = $1. هل سيُنشأ سجل التدقيق؟",
      "options": ["لا، لأن المشغّل يعمل فقط لتغييرات طبقة التطبيق", "نعم، لأن مشغّلات قاعدة البيانات تعمل على كل عمليات DML بغض النظر عن مصدر الاتصال", "لا، لأن مشغّلات AFTER UPDATE تتطلب أن يستدعي التطبيق إجراءً مخزنًا لتفعيلها", "نعم، لكن فقط إذا عُرّف المشغّل بـ SECURITY DEFINER"],
      "correct": 1,
      "explanation": "تعمل مشغّلات قاعدة البيانات على كل عملية DML على الجدول بغض النظر عن مصدر الاتصال — شيفرة التطبيق، أو psql، أو pgAdmin، أو سكربتات الترحيل، أو الإصلاحات الطارئة. ولهذا يكون التدقيق القائم على المشغّلات أوثق من سجل طبقة التطبيق: فالكتّاب العاديون لا يستطيعون تخطيه. وفقط الأدوار القادرة على تعطيل المشغّلات (مالكو الجداول، والمستخدمون الخارقون، أو جلسة بـ session_replication_role = replica) تستطيع تجاوزه — فأبقِ تلك الأدوار مقيدة ومراقبة."
    },
    {
      "text": "يتيح منتج مالي تأريخ تغييرات الحدود بأثر رجعي: يستطيع عضو في فريق المخاطر تسجيل أن حد ائتمان عميل تغير فعليًا في تاريخ سابق. وتسجل جداول التدقيق القياسية (بزمن النظام) هذا كتغيير تم اليوم. ما تقنية نمذجة البيانات التي تلتقط بشكل صحيح متى سُجل التغيير في النظام ومتى كان نافذًا في العالم الواقعي؟",
      "options": ["Event sourcing للإلحاق فقط بطابع زمني واحد created_at", "النمذجة ثنائية الزمن ببعدين منفصلين valid_time (فترة النفاذ في العمل) وsystem_time (فترة تسجيل المعاملة)", "Slowly Changing Dimension من النوع 2 بعمود effective_date واحد", "الجداول الزمنية باستخدام SYSTEM TIME فقط كما عرّفها SQL:2011"],
      "correct": 1,
      "explanation": "تتتبع النمذجة ثنائية الزمن محورين زمنيين مستقلين: valid_time (متى كانت الحقيقة صحيحة في مجال العمل) وsystem_time (متى سُجلت الحقيقة في قاعدة البيانات). وهذا يتيح استعلامات مثل 'ماذا كنا نعتقد في 2024-01-15 عن حد كان نافذًا فعليًا من 2024-01-01؟' — سؤال لا تستطيع الجداول الزمنية أحادية المحور ولا event sourcing بطابع زمني واحد الإجابة عنه بشكل صحيح."
    },
    {
      "text": "يستخدم جدول payments_audit تسلسلًا تشفيريًا حيث يخزن كل صف SHA-256(previous_hash || current_row_data). ويريد مدقق التحقق من عدم حذف أي صفوف أو تعديلها منذ إنشاء السلسلة. أي نمط استعلام يوفر هذا التحقق؟",
      "options": ["SELECT COUNT(*) FROM payments_audit للتأكد من أن عدد الصفوف لم ينقص", "أعد حساب تجزئة السلسلة تتابعيًا من الصف الأول وقارن التجزئة المحسوبة النهائية بالتجزئة المخزنة في الصف الأخير", "SELECT MAX(created_at) FROM payments_audit للتحقق من أن أحدث إدخال يطابق الطابع الزمني المتوقع", "قارن عدد صفوف payments_audit بعدد صفوف جدول payments لكشف الإدخالات المفقودة"],
      "correct": 1,
      "explanation": "يوفر التسلسل التشفيري كشف العبث عبر اعتماد تتابعي للتجزئات: فتجزئة كل صف تعتمد على تجزئة الصف السابق وبيانات الصف نفسه. وللتحقق من السلامة، أعد حساب hash(row_1_data) = stored_hash_1، ثم hash(stored_hash_1 || row_2_data) = stored_hash_2، وهكذا. فإذا عُدّل أي صف أو حُذف، تنكسر السلسلة ولن تطابق التجزئة المحسوبة النهائية التجزئة المخزنة في الصف الأخير."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تصميم نظام تدقيق كاشف للعبث لانتقالات حالة المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "أنشئ دالة مشغّل تدقيق عامة قائمة على JSONB باسم capture_payment_history() تسجل: table_name، وoperation ‏(INSERT/UPDATE/DELETE)، وchanged_by ‏(current_user)، وchanged_at ‏(NOW())، وold_data ‏(row_to_json(OLD))، وnew_data ‏(row_to_json(NEW))، وchanged_columns (مصفوفة بأسماء الأعمدة التي تغيرت فعلًا، تُحسب بمقارنة OLD وNEW). واربط المشغّل بجدول payments كـ AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW. وتحقق من أن UPDATE مباشرًا عبر psql ينشئ سجل تدقيق بقائمة changed_columns الصحيحة."
    },
    {
      "id": "2",
      "description": "نفّذ النمذجة ثنائية الزمن لـ payment_limits: أضف عمودي valid_from TIMESTAMPTZ وvalid_to TIMESTAMPTZ (بعد الزمن الصالح) إلى جانب system_period من نوع tstzrange يولّده مشغّل زمن النظام. واكتب استعلامًا يجيب عن: 'ما حد الائتمان المسجل لدينا للحساب X حتى زمن النظام 2024-06-01، والذي كان نافذًا في تاريخ العمل 2024-05-15؟' وتأكد من أن الاستعلام يستخدم البعدين الزمنيين بشكل صحيح."
    },
    {
      "id": "3",
      "description": "أضف تسلسلًا تشفيريًا إلى جدول payments_audit: يخزن كل صف chain_seq BIGINT وprev_hash TEXT وrow_hash TEXT حيث row_hash = encode(sha256(convert_to(concat_ws('|', chain_seq, prev_hash, table_name, operation, extract(epoch from changed_at), COALESCE(new_data::text, old_data::text)), 'UTF8')), 'hex')، وتُسلسل عمليات الإلحاق بقفل استشاري (advisory lock). ونفّذ دالة Java باسم AuditChainVerifier.verifyChain(String tableName) تقرأ السلسلة بترتيب chain_seq وتعيد VerificationResult بقيمة isValid المنطقية وفهرس أول حلقة مكسورة إن كانت غير صالحة. واكتب اختبارًا يدرج 5 صفوف تدقيق ويتحقق من السلسلة، ثم يحدّث بيانات صف واحد يدويًا ويتحقق من انكسار السلسلة."
    },
    {
      "id": "4",
      "description": "نفّذ ConditionalAuditTrigger يعمل فقط حين تتغير الأعمدة الحرجة للدفع (status، وamount_minor، وaccount_id) بدل كل الأعمدة. واستخدم عبارة WHEN في المشغّل مع فحوص IS DISTINCT FROM على تلك الأعمدة. وقِس كلفة التدقيق لكل صف باستخدام EXPLAIN ANALYZE على UPDATE دفعي لـ 10,000 صف مع تفعيل المشغّل مقابل تعطيله. ووثّق الكلفة كنسبة مئوية من زمن التنفيذ الإجمالي."
    }
  ]
}
-->
