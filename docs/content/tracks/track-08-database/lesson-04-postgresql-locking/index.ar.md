---
id: track-08-lesson-04
title: "الأقفال في PostgreSQL — أقفال الصفوف والصفحات والأقفال الاستشارية"
slug: postgresql-locking
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 4
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [PostgreSQL, locking, row-lock, advisory-lock, deadlock]
prerequisites: []
---

# الأقفال في PostgreSQL — أقفال الصفوف والصفحات والأقفال الاستشارية

> [!NOTE]
> نظام الأقفال في PostgreSQL أداة دقيقة. فحين تُستخدم بشكل صحيح، تكون الأقفال ما يجعل المعاملات المالية المتزامنة آمنة. وحين تُستخدم بإهمال، تنتج حالات جمود، وطوابير أقفال، وأخطاء صحة صامتة. ويغطي هذا الدرس كل أوضاع الأقفال، وتفاعلاتها، والأنماط التي تجعل الأنظمة المالية عالية الإنتاجية صحيحة وسريعة معًا.

## 1. تسلسل أوضاع الأقفال

يعرّف PostgreSQL ثمانية أوضاع أقفال على مستوى الجدول، مرتبة من الأقل إلى الأكثر تقييدًا:

| وضع القفل | يحصل عليه | يتعارض مع |
|-----------|------------|----------------|
| ACCESS SHARE | SELECT | ACCESS EXCLUSIVE فقط |
| ROW SHARE | SELECT FOR UPDATE/SHARE | EXCLUSIVE، ACCESS EXCLUSIVE |
| ROW EXCLUSIVE | INSERT، UPDATE، DELETE | SHARE، SHARE ROW EXCLUSIVE، EXCLUSIVE، ACCESS EXCLUSIVE |
| SHARE UPDATE EXCLUSIVE | VACUUM، ANALYZE، CREATE INDEX CONCURRENTLY | SHARE UPDATE EXCLUSIVE، SHARE، SHARE ROW EXCLUSIVE، EXCLUSIVE، ACCESS EXCLUSIVE |
| SHARE | CREATE INDEX | ROW EXCLUSIVE، SHARE UPDATE EXCLUSIVE، SHARE ROW EXCLUSIVE، EXCLUSIVE، ACCESS EXCLUSIVE |
| SHARE ROW EXCLUSIVE | CREATE TRIGGER، ADD FOREIGN KEY، بعض صيغ ALTER TABLE | ROW EXCLUSIVE، SHARE UPDATE EXCLUSIVE، SHARE، SHARE ROW EXCLUSIVE، EXCLUSIVE، ACCESS EXCLUSIVE |
| EXCLUSIVE | REFRESH MATERIALIZED VIEW CONCURRENTLY | الكل عدا ACCESS SHARE |
| ACCESS EXCLUSIVE | معظم صيغ ALTER TABLE، وDROP TABLE، وTRUNCATE، وVACUUM FULL، وREINDEX، وCLUSTER | كل أوضاع الأقفال |

التمييز الأهم عمليًا للأنظمة المالية:
- **القراءات والكتابات العادية** (SELECT، وINSERT، وUPDATE، وDELETE) تتعايش دون تعارضات على مستوى الجدول
- **عمليات DDL** (ALTER TABLE، وDROP، وTRUNCATE) تحصل على ACCESS EXCLUSIVE وتحجب كل شيء
- **إنشاء الفهرس أثناء العمل** (CREATE INDEX CONCURRENTLY) يستخدم SHARE UPDATE EXCLUSIVE، فيتيح استمرار DML

## 2. أقفال مستوى الصف

تحكم أقفال مستوى الجدول التزامن على مستوى المخطط. وتحكم أقفال مستوى الصف أي المعاملات تستطيع تعديل صفوف محددة في الوقت نفسه.

### 2.1 ‏SELECT FOR UPDATE

يحصل على قفل صف حصري على الصفوف المختارة. وستُحجب المعاملات الأخرى التي تحاول قفل هذه الصفوف أو تحديثها حتى تلتزم المعاملة الأولى أو تتراجع.

```sql
-- Transfer: lock both rows atomically to prevent concurrent modification
BEGIN;

SELECT account_id, balance
FROM accounts
WHERE account_id IN ('ACC-1001', 'ACC-1002')
ORDER BY account_id  -- Always lock in consistent order to prevent deadlocks!
FOR UPDATE;

-- Now safely update knowing no other transaction can touch these rows
UPDATE accounts
SET balance = balance - 500.00
WHERE account_id = 'ACC-1001';

UPDATE accounts
SET balance = balance + 500.00
WHERE account_id = 'ACC-1002';

COMMIT;
```

**قاعدة حاسمة:** احصل دائمًا على أقفال صفوف متعددة **بترتيب ثابت** (مثلًا مرتبة بالمفتاح الأساسي). فمعاملتان تقفلان الصفوف نفسها بترتيب معاكس ستقعان في جمود (deadlock).

### 2.2 ‏SELECT FOR SHARE

يحصل على قفل صف مشترك. ويمكن لمعاملات متعددة أن تمسك FOR SHARE في الوقت نفسه، لكن لا معاملة تستطيع الحصول على FOR UPDATE أو تعديل الصف ما دام قفل FOR SHARE ممسوكًا.

```sql
-- Read a row that must not change during a multi-step validation
BEGIN;

SELECT limit_amount, current_usage, limit_type
FROM credit_limits
WHERE account_id = 'ACC-1001'
FOR SHARE;

-- Multiple concurrent readers can hold FOR SHARE on this row
-- But no updater can proceed until all FOR SHARE holders release

-- Perform validation logic (read-only)
-- ...

COMMIT;  -- Releases FOR SHARE lock
```

**متى تستخدم FOR SHARE مقابل FOR UPDATE:**
- ‏FOR UPDATE: ستعدّل الصف
- ‏FOR SHARE: تحتاج قراءة الصف ومنع تعديله، لكن يجب أن يستطيع مدققون متعددون العمل بالتزامن

### 2.3 ‏SELECT FOR NO KEY UPDATE

نسخة أضعف من FOR UPDATE لا تتعارض مع FOR KEY SHARE. ومفيدة حين تحتاج تحديث أعمدة غير مفتاحية دون حجب فحوص المفاتيح الأجنبية.

```sql
-- Update metadata without blocking FK referencing transactions
SELECT *
FROM accounts
WHERE account_id = 'ACC-1001'
FOR NO KEY UPDATE;
-- Does NOT block SELECT FOR KEY SHARE (used by FK checks)
-- DOES block SELECT FOR UPDATE and SELECT FOR SHARE
```

يأخذ `UPDATE` العادي الذي لا يغيّر أعمدة المفتاح هذا القفل تلقائيًا — ولهذا لا يحجب إدراج صفوف أبناء (فحص المفتاح الأجنبي يأخذ FOR KEY SHARE على الأب) تحديثات رصيد الأب.

### 2.4 ‏SELECT FOR KEY SHARE

أضعف أقفال الصفوف. يمنع حذف الصف أو تحديث أعمدة المفتاح، لكنه يسمح بتحديث الأعمدة غير المفتاحية. ويستخدمه PostgreSQL داخليًا لفرض المفاتيح الأجنبية.

## 3. ‏SKIP LOCKED لمعالجة الطوابير

من أثمن ميزات PostgreSQL للأنظمة المالية: يتيح `SKIP LOCKED` لاستعلام تخطي الصفوف المقفلة حاليًا من معاملة أخرى، فيمكّن معالجة طوابير متزامنة بكفاءة.

### 3.1 نمط طابور الدفع

```sql
-- Create a payment processing queue
CREATE TABLE payment_queue (
    queue_id        BIGSERIAL PRIMARY KEY,
    payment_id      VARCHAR(50) NOT NULL UNIQUE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    amount          NUMERIC(19, 4) NOT NULL,
    from_account    VARCHAR(20) NOT NULL,
    to_account      VARCHAR(20) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_node VARCHAR(50)
);

CREATE INDEX idx_payment_queue_status_created
ON payment_queue (status, created_at)
WHERE status = 'pending';
```

```sql
-- Worker: atomically claim a pending payment (no duplicates; items locked by other workers are skipped)
BEGIN;

SELECT queue_id, payment_id, amount, from_account, to_account
FROM payment_queue
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;  -- Skip rows locked by other workers

-- If no rows returned, queue is empty or all pending items are being processed

UPDATE payment_queue
SET status = 'processing',
    processing_node = 'worker-07'
WHERE queue_id = :claimed_queue_id;

COMMIT;
```

يلتزم الحجز بسرعة؛ وتُعالج الدفعة نفسها بعد ذلك. وأمران أساسيان حينها:
- **العناصر العالقة:** إذا مات عامل بعد الحجز، يبقى الصف `processing` إلى الأبد. فخزّن طابعًا زمنيًا `claimed_at` (عقد إيجار) ودع مُكنِّسًا يعيد العناصر التي انتهى عقدها إلى `pending`.
- **المعالجة الـ idempotent:** قد يكون العنصر المستعاد قد عولج جزئيًا، لذا يجب أن تكون خطوة المعالجة آمنة للتكرار (مفتاح idempotency نحو البوابة، وقيود تفرد على قيود الدفتر).

### 3.2 تنفيذ عامل الطابور بـ Java

```java
@Service
public class PaymentQueueWorker {

    @Transactional
    public Optional<QueuedPayment> claimNextPayment(String workerId) {
        // SKIP LOCKED ensures concurrent workers don't step on each other
        Optional<QueuedPayment> claimed = paymentQueueRepository
            .findNextPendingWithSkipLocked();

        claimed.ifPresent(payment -> {
            payment.setStatus(PaymentStatus.PROCESSING);
            payment.setProcessingNode(workerId);
            paymentQueueRepository.save(payment);
        });

        return claimed;
    }
}
```

```java
// Repository
public interface PaymentQueueRepository
    extends JpaRepository<QueuedPayment, Long> {

    @Query(value = """
        SELECT * FROM payment_queue
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        """, nativeQuery = true)
    Optional<QueuedPayment> findNextPendingWithSkipLocked();
}
```

### 3.3 معالجة الطابور على دفعات

```java
@Transactional
public List<QueuedPayment> claimBatch(String workerId, int batchSize) {
    List<QueuedPayment> batch = paymentQueueRepository
        .findPendingBatchWithSkipLocked(batchSize);

    batch.forEach(payment -> {
        payment.setStatus(PaymentStatus.PROCESSING);
        payment.setProcessingNode(workerId);
    });

    return paymentQueueRepository.saveAll(batch);
}
```

```java
@Query(value = """
    SELECT * FROM payment_queue
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT :batchSize
    FOR UPDATE SKIP LOCKED
    """, nativeQuery = true)
List<QueuedPayment> findPendingBatchWithSkipLocked(
    @Param("batchSize") int batchSize);
```

## 4. الأقفال الاستشارية (Advisory Locks)

الأقفال الاستشارية أقفال على مستوى التطبيق تديرها قاعدة البيانات. فهي لا تقفل بيانات فعلية — بل تتتبع قاعدة البيانات أن تطبيقك يمسك قفلًا مسمى. وهي مثالية للتنسيق الموزع في الأنظمة المالية.

### 4.1 الأقفال الاستشارية على مستوى الجلسة

تُمسك الأقفال الاستشارية على مستوى الجلسة حتى تُحرر صراحة أو تنتهي الجلسة:

```sql
-- Acquire an exclusive advisory lock by integer ID
-- pg_try_advisory_lock returns false if already locked (non-blocking)
SELECT pg_try_advisory_lock(12345);  -- Returns true/false

-- Acquire and block until available
SELECT pg_advisory_lock(12345);

-- Release
SELECT pg_advisory_unlock(12345);

-- Lock using bigint to represent a business entity
-- Hash account_id to get a stable integer lock key
-- (hashtext returns a 32-bit value: different accounts can collide and
--  then share a lock -- harmless for correctness, but it adds contention)
SELECT pg_try_advisory_lock(hashtext('ACC-1001'));
```

**احذر مع مجمعات الاتصالات:** قفل مستوى الجلسة ينتمي إلى اتصال قاعدة البيانات، لا إلى خيطك. فإذا أعادت الشيفرة الاتصال إلى المجمع دون فك القفل (في مسار استثناء)، يبقى القفل ممسوكًا من اتصال خامل في المجمع. وخلف PgBouncer في وضع المعاملة، قد تعمل العبارات المتتالية حتى على اتصالات خادم مختلفة، فلا تعمل الأقفال الاستشارية على مستوى الجلسة إطلاقًا. ففضّل الأقفال على مستوى المعاملة.

### 4.2 الأقفال الاستشارية على مستوى المعاملة

تُحرر الأقفال الاستشارية على مستوى المعاملة تلقائيًا حين تلتزم المعاملة أو تتراجع — أكثر أمانًا كثيرًا لشيفرة التطبيق:

```sql
BEGIN;

-- Acquire transaction-level advisory lock
SELECT pg_try_advisory_xact_lock(hashtext('ACC-1001'));
-- Returns true if acquired, false if already locked by another transaction

-- Now perform operations on account ACC-1001
UPDATE accounts SET balance = balance - 500 WHERE account_id = 'ACC-1001';

COMMIT;  -- Lock automatically released
```

### 4.3 الأقفال الاستشارية للتنسيق الموزع

```java
@Service
public class DistributedAccountLockService {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Acquires a distributed advisory lock for an account.
     * Uses transaction-level lock — automatically released at commit/rollback.
     * Returns false immediately if another node holds the lock.
     */
    @Transactional
    public boolean tryLockAccount(String accountId) {
        // String.hashCode() is 32-bit and may collide: two accounts would then
        // share a lock (safe, just more contention)
        long lockKey = accountId.hashCode();
        Boolean acquired = jdbcTemplate.queryForObject(
            "SELECT pg_try_advisory_xact_lock(?)",
            Boolean.class, lockKey);
        return Boolean.TRUE.equals(acquired);
    }

    /**
     * Execute an operation with distributed lock guarantee.
     * Retries up to maxAttempts times if lock is contended.
     */
    @Transactional
    public <T> T withAccountLock(String accountId,
                                  Supplier<T> operation,
                                  int maxAttempts) {
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            if (tryLockAccount(accountId)) {
                return operation.get();
            }
            if (attempt < maxAttempts) {
                LockSupport.parkNanos(Duration.ofMillis(10 * attempt).toNanos());
            }
        }
        throw new LockAcquisitionException(
            "Could not acquire lock for account: " + accountId);
    }
}
```

### 4.4 قفل استشاري لتنفيذ مهمة منفردة

```java
@Service
public class ReconciliationJobLock {

    private static final long RECONCILIATION_LOCK_ID = 9876543210L;

    // NOTE: the xact lock lives as long as THIS transaction, so the whole
    // reconciliation runs inside one transaction. For a job that runs for
    // many minutes, that long transaction holds back VACUUM -- use a
    // session-level lock on a dedicated connection instead (and always
    // unlock in finally).
    @Transactional
    public boolean tryRunReconciliation(Runnable reconciliationLogic) {
        // Only one node in the cluster runs reconciliation at a time
        Boolean acquired = jdbcTemplate.queryForObject(
            "SELECT pg_try_advisory_xact_lock(?)",
            Boolean.class, RECONCILIATION_LOCK_ID);

        if (!Boolean.TRUE.equals(acquired)) {
            log.info("Reconciliation already running on another node");
            return false;
        }

        reconciliationLogic.run();
        return true;
    }
}
```

## 5. كشف حالات الجمود ومنعها

### 5.1 كيف يكتشف PostgreSQL حالات الجمود

يشغّل PostgreSQL خوارزمية كشف الجمود حين يتجاوز انتظار قفل `deadlock_timeout` (الافتراضي: ثانية واحدة). فيبني رسم انتظار، ويجد الدورات، ويُلغي معاملة واحدة ("الضحية") بـ:

```
ERROR 40P01: deadlock detected
DETAIL: Process 1234 waits for ShareLock on transaction 90211;
        blocked by process 5678.
        Process 5678 waits for ShareLock on transaction 90207;
        blocked by process 1234.
```

### 5.2 سيناريو جمود كلاسيكي

```sql
-- Transaction T1
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE account_id = 'ACC-1001';
-- (T1 holds lock on ACC-1001, waiting for ACC-1002)
UPDATE accounts SET balance = balance + 100 WHERE account_id = 'ACC-2002';

-- Transaction T2 (concurrent)
BEGIN;
UPDATE accounts SET balance = balance - 200 WHERE account_id = 'ACC-2002';
-- (T2 holds lock on ACC-2002, waiting for ACC-1001)
UPDATE accounts SET balance = balance + 200 WHERE account_id = 'ACC-1001';

-- DEADLOCK: T1 waits for T2, T2 waits for T1
-- PostgreSQL aborts one of them after deadlock_timeout
```

### 5.3 المنع: ترتيب أقفال ثابت

```java
@Transactional
public TransferResult transfer(String fromAccountId,
                                String toAccountId,
                                BigDecimal amount) {
    // Always lock in ascending account_id order
    // This guarantees T1 and T2 always acquire locks in the same sequence
    String firstId = fromAccountId.compareTo(toAccountId) < 0
        ? fromAccountId : toAccountId;
    String secondId = fromAccountId.compareTo(toAccountId) < 0
        ? toAccountId : fromAccountId;

    Account first = accountRepository.findByIdWithLock(firstId);
    Account second = accountRepository.findByIdWithLock(secondId);

    Account from = first.getId().equals(fromAccountId) ? first : second;
    Account to = first.getId().equals(toAccountId) ? first : second;

    if (from.getBalance().compareTo(amount) < 0) {
        throw new InsufficientFundsException();
    }

    from.debit(amount);
    to.credit(amount);

    accountRepository.save(from);
    accountRepository.save(to);

    return TransferResult.success(from.getBalance(), to.getBalance());
}
```

### 5.4 المنع: مهلة القفل

```sql
-- Set a lock acquisition timeout for the session
SET lock_timeout = '5s';  -- Fail after 5 seconds of waiting for a lock

-- Set for a specific transaction
BEGIN;
SET LOCAL lock_timeout = '2s';
SELECT * FROM accounts WHERE account_id = 'ACC-1001' FOR UPDATE;
-- If lock not acquired in 2 seconds: ERROR 55P03: lock timeout
COMMIT;
```

```java
// In Spring, configure lock_timeout via connection properties
@Bean
public DataSource dataSource(DataSourceProperties properties) {
    HikariDataSource ds = properties.initializeDataSourceBuilder()
        .type(HikariDataSource.class)
        .build();
    // Apply lock_timeout for all connections
    ds.setConnectionInitSql("SET lock_timeout = '5s'");
    return ds;
}
```

### 5.5 مراقبة حالات الجمود

```sql
-- Count deadlocks since last stats reset
SELECT deadlocks, blks_hit, blks_read
FROM pg_stat_database
WHERE datname = current_database();

-- Check deadlock_timeout setting
SHOW deadlock_timeout;

-- Check log_lock_waits (enable to log slow lock acquisitions)
SHOW log_lock_waits;
-- Enable: SET log_lock_waits = on;
```

## 6. مراقبة الأقفال — pg_locks

### 6.1 عرض الأقفال النشطة

أسرع طريقة لرؤية من يحجب من (PostgreSQL 9.6+):

```sql
SELECT pid,
       pg_blocking_pids(pid) AS blocked_by,
       wait_event_type,
       now() - xact_start AS xact_age,
       left(query, 80) AS query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

ويُظهر الربط المفصل على `pg_locks` أوضاع الأقفال المعنية:

```sql
-- Full view of current locks with blocking relationship
SELECT
    blocked.pid,
    blocked.usename,
    blocked_activity.application_name,
    blocked_activity.query AS blocked_query,
    blocking.pid AS blocking_pid,
    blocking_activity.query AS blocking_query,
    blocked_locks.locktype,
    blocked_locks.relation::regclass AS locked_table,
    blocked_locks.mode AS requested_mode,
    blocking_locks.mode AS held_mode
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity
    ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity
    ON blocking_activity.pid = blocking_locks.pid
JOIN pg_catalog.pg_stat_activity blocked
    ON blocked.pid = blocked_locks.pid
WHERE NOT blocked_locks.granted;
```

### 6.2 تحديد بؤر تنازع الأقفال

```sql
-- Find relations with the most lock contention
SELECT
    relation::regclass AS table_name,
    mode,
    count(*) AS lock_count,
    count(*) FILTER (WHERE NOT granted) AS waiting_count
FROM pg_locks
WHERE relation IS NOT NULL
GROUP BY relation, mode
ORDER BY waiting_count DESC, lock_count DESC
LIMIT 20;
```

## 7. أقفال DDL وتغييرات المخطط أثناء العمل

### 7.1 لماذا أقفال DDL خطرة في الإنتاج

يحصل `ALTER TABLE` على ACCESS EXCLUSIVE — فيحجب كل استعلام على الجدول. وفي نظام دفع يعالج 10,000 معاملة في الثانية، حتى ALTER TABLE مدته 100 مللي ثانية يجعل آلاف الاستعلامات تصطف.

```sql
-- DANGEROUS: Blocks all reads and writes on the accounts table
ALTER TABLE accounts ADD COLUMN kyc_verified BOOLEAN;
-- ACCESS EXCLUSIVE acquired — all sessions wait
```

الخطر الإضافي: تصطف الاستعلامات المحجوبة. وحين يكتمل DDL، تُنفذ كل الاستعلامات المصطفة معًا، فتخلق قطيعًا هائجًا.

### 7.2 أنماط DDL الآمنة

```sql
-- FAST: Adding a nullable column needs no table rewrite.
-- It still takes ACCESS EXCLUSIVE briefly -- and waits behind any running
-- query on the table while blocking everyone queued after it, so always
-- combine DDL with a short lock_timeout (section 7.3)
ALTER TABLE accounts ADD COLUMN kyc_tier SMALLINT;

-- FAST: Adding a column with a constant (non-volatile) default (PostgreSQL 11+)
-- PostgreSQL 11+ stores the default in the catalog without rewriting rows
ALTER TABLE accounts ADD COLUMN kyc_verified BOOLEAN DEFAULT FALSE;
-- Pre-PostgreSQL 11: this rewrote the entire table! On PG11+ it is instant.

-- SAFE: Create index without blocking
CREATE INDEX CONCURRENTLY idx_accounts_kyc_verified
ON accounts (kyc_verified)
WHERE kyc_verified = TRUE;
-- CONCURRENTLY: takes ShareUpdateExclusiveLock (allows reads and writes)
-- Takes longer but does not block production traffic
```

### 7.3 ضبط مهلة قفل DDL

```sql
-- Set a DDL statement timeout to avoid holding up the queue indefinitely
BEGIN;
SET LOCAL lock_timeout = '100ms';  -- Give up if DDL can't get a lock quickly
SET LOCAL statement_timeout = '30s';  -- Don't run forever if it does start

ALTER TABLE transactions ADD COLUMN risk_score SMALLINT;

COMMIT;
-- If the lock cannot be acquired in 100ms, the statement fails fast
-- Application can retry at a quieter time
```

### 7.4 تغييرات المخطط الثقيلة على خطوات

بعض تغييرات المخطط تعيد كتابة الجدول كاملًا أو تمسحه تحت ACCESS EXCLUSIVE (`SET NOT NULL` يمسح الجدول؛ ومعظم تغييرات نوع العمود تعيد كتابته). فقسّمها إلى خطوات أثناء العمل:

```bash
# Add a NOT NULL column without a long lock
# Step 1: Add nullable column (fast)
psql -c "ALTER TABLE transactions ADD COLUMN payment_channel VARCHAR(20)"

# Step 2: Backfill in small batches (short transactions, no lock storms)

# Step 3: Prove NOT NULL with a CHECK constraint, validated online
psql -c "ALTER TABLE transactions ADD CONSTRAINT payment_channel_nn
         CHECK (payment_channel IS NOT NULL) NOT VALID"        # brief lock
psql -c "ALTER TABLE transactions VALIDATE CONSTRAINT payment_channel_nn"
                                          # scans, but only SHARE UPDATE EXCLUSIVE

# Step 4: SET NOT NULL now skips the scan (PostgreSQL 12+ uses the valid
#         CHECK constraint), then drop the helper constraint
psql -c "ALTER TABLE transactions ALTER COLUMN payment_channel SET NOT NULL"
psql -c "ALTER TABLE transactions DROP CONSTRAINT payment_channel_nn"

# Changing a column TYPE: pg_repack cannot do this. Use expand/contract:
# add a new column, write both, backfill, switch reads, drop the old column
# (lesson 9). pg_repack is for removing bloat online:
pg_repack -d payments_db -t transactions --no-kill-backend
```

## 8. مرجع سريع لأوضاع الأقفال في عمليات DDL المالية

| عملية DDL | وضع القفل | يحجب |
|--------------|-----------|--------|
| ‏`SELECT` | ACCESS SHARE | ‏ACCESS EXCLUSIVE فقط |
| ‏`INSERT/UPDATE/DELETE` | ROW EXCLUSIVE | ‏SHARE وما فوقه |
| ‏`CREATE INDEX` | SHARE | ‏ROW EXCLUSIVE وما فوقه (يحجب الكتابات) |
| ‏`CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | أدنى — يسمح بـ DML |
| ‏`VACUUM` | SHARE UPDATE EXCLUSIVE | أدنى — يسمح بـ DML |
| ‏`ANALYZE` | SHARE UPDATE EXCLUSIVE | أدنى — يسمح بـ DML |
| ‏`ALTER TABLE ADD COLUMN` (قابل للفراغ، PG11+) | ‏ACCESS EXCLUSIVE (قصير، بلا إعادة كتابة) | الكل |
| ‏`ALTER TABLE ADD CONSTRAINT ... CHECK` | ‏ACCESS EXCLUSIVE (قصير مع NOT VALID) | الكل |
| ‏`ALTER TABLE ADD FOREIGN KEY` | ‏SHARE ROW EXCLUSIVE على الجدولين | الكتابات (استخدم NOT VALID + VALIDATE) |
| ‏`ALTER TABLE VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | أدنى — يسمح بـ DML |
| ‏`TRUNCATE` | ACCESS EXCLUSIVE | الكل |
| ‏`DROP TABLE` | ACCESS EXCLUSIVE | الكل |

## 9. أفضل ممارسات الأقفال في الإنتاج

### 9.1 قائمة فحص الأقفال على مستوى التطبيق

```java
@Service
public class FinancialTransactionService {

    // Best practice 1: Always use explicit locking for read-modify-write
    @Transactional
    public void processPayment(PaymentRequest request) {
        // Lock in consistent order (sorted account IDs)
        List<String> accountIds = Stream.of(
            request.getFromAccount(), request.getToAccount())
            .sorted()
            .collect(Collectors.toList());

        // Lock all accounts in one query. The query MUST contain
        // ORDER BY id: "WHERE id IN (...) FOR UPDATE" locks rows in the order
        // the scan finds them, not in the order of the list you pass
        //   SELECT ... WHERE id IN (:ids) ORDER BY id FOR UPDATE
        List<Account> accounts = accountRepository
            .findAllByIdInWithLock(accountIds);

        // Best practice 2: Fail fast on insufficient balance before modifying
        Account from = findAccount(accounts, request.getFromAccount());
        if (from.getBalance().compareTo(request.getAmount()) < 0) {
            throw new InsufficientFundsException(request.getFromAccount());
        }

        // Modify after validation
        Account to = findAccount(accounts, request.getToAccount());
        from.debit(request.getAmount());
        to.credit(request.getAmount());
        accountRepository.saveAll(List.of(from, to));
    }
}
```

### 9.2 التنبيه على تنازع الأقفال

```java
@EventListener
@Async
public void onSlowLockAcquisition(LockAcquisitionSlowEvent event) {
    meterRegistry.counter("db.lock.slow_acquisition",
        Tags.of(
            "table", event.getTableName(),
            "operation", event.getOperationType()
        )).increment();

    if (event.getDurationMs() > 1000) {
        alertingService.sendAlert(
            AlertSeverity.WARNING,
            String.format("Lock wait > 1s on table %s for %s",
                event.getTableName(), event.getOperationType()));
    }
}
```

## الخلاصة

يعطيك نظام الأقفال في PostgreSQL تحكمًا دقيقًا في التزامن في التطبيقات المالية:

- **‏SELECT FOR UPDATE** يسلسل عمليات القراءة-التعديل-الكتابة على صفوف محددة — العمود الفقري لتحديثات الرصيد الآمنة
- **‏SELECT FOR SHARE** يحمي الصفوف من التعديل مع السماح بقرّاء متزامنين — مفيد لسير عمل التحقق
- **‏SKIP LOCKED** يمكّن معالجة طوابير متزامنة عالية الإنتاجية دون حمل تنسيق
- **الأقفال الاستشارية** توفر أدوات تنسيق موزع لتنفيذ المهام المنفردة والتسلسل عبر الخدمات
- **منع الجمود** يتطلب ترتيب أقفال ثابتًا — اقفل دائمًا الصفوف المتعددة بتسلسل محدد
- **تغييرات DDL** في الإنتاج تتطلب عناية — استخدم `CREATE INDEX CONCURRENTLY`، واضبط `lock_timeout`، وقسّم التغييرات الثقيلة إلى خطوات أثناء العمل
- **راقب pg_locks** استباقيًا — تنازع الأقفال مؤشر مبكر على أخطاء الصحة وتدهور الأداء

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تحتاج خدمة تحويل مالي تحديث صفي حسابين في الوقت نفسه. ما التقنية الأهم لمنع الجمود عند الحصول على أقفال مستوى الصف على الصفين؟",
      "options": ["استخدم SELECT FOR SHARE على الصفين", "احصل دائمًا على الأقفال بترتيب ثابت مرتب (مثلًا حسب account_id)", "استخدم الأقفال الاستشارية بدل أقفال مستوى الصف", "زِد deadlock_timeout إلى 10 ثوانٍ"],
      "correct": 1,
      "explanation": "يحدث الجمود حين تحصل معاملتان على الأقفال بترتيب معاكس. وترتيب معرّفات الحسابات وقفل المعرّف الأصغر أولًا دائمًا يضمن أن تتبع كل المعاملات ترتيب الحصول نفسه، فيزول شرط الانتظار الدائري الذي يسبب الجمود."
    },
    {
      "text": "يستخدم نظام الدفع لديك جدول طابور في قاعدة البيانات. ويجب أن يحجز كل عامل من عدة عقد دفعة معلقة واحدة بالضبط دون أن يحجز عاملان الدفعة نفسها. أي عبارة SQL تمكّن نمط معالجة الطابور المتزامن هذا؟",
      "options": ["SELECT FOR SHARE", "SELECT FOR UPDATE NOWAIT", "SELECT FOR UPDATE SKIP LOCKED", "SELECT FOR NO KEY UPDATE"],
      "correct": 2,
      "explanation": "يجعل SKIP LOCKED الاستعلام يتخطى الصفوف المقفلة أصلًا من معاملة أخرى. فيحجز كل عامل دفعة معلقة غير مقفلة ذريًا، فيمنع حجز عاملين للعنصر نفسه، ما يجعله مثاليًا لمعالجة الطوابير المتزامنة."
    },
    {
      "text": "عملية ALTER TABLE على جدول مدفوعات كثيف الاستخدام في الإنتاج تجعل كل الاستعلامات تصطف وتنتهي مهلتها. ما النهج الصحيح لإضافة فهرس دون حجب حركة الإنتاج؟",
      "options": ["شغّل ALTER TABLE خلال نافذة صيانة", "استخدم CREATE INDEX (العادي) مع lock_timeout قصير", "استخدم CREATE INDEX CONCURRENTLY للسماح بـ DML أثناء إنشاء الفهرس", "احذف الجدول وأعد إنشاءه بالفهرس الجديد"],
      "correct": 2,
      "explanation": "يحصل CREATE INDEX CONCURRENTLY على قفل SHARE UPDATE EXCLUSIVE فقط، الذي يسمح باستمرار القراءات والكتابات المتزامنة (DML) أثناء إنشاء الفهرس. ويأخذ تمريرتين على الجدول وهو أبطأ من CREATE INDEX العادي، لكنه لا يحجب حركة الإنتاج."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ خدمة تحويل آمنة من الجمود مع الأقفال الاستشارية",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ دالة Java باسم TransferService.transfer(fromId, toId, amount) باستخدام SELECT FOR UPDATE مع ترتيب أقفال ثابت (رتّب معرّفات الحسابات قبل الحصول عليها) لمنع الجمود. واكتب اختبار وحدة باستخدام خيطين متزامنين يحاولان تحويلات في اتجاهين متعاكسين وتحقق من عدم حدوث جمود."},
    {"id": "2", "description": "ابنِ PaymentQueueWorker يستخدم SELECT FOR UPDATE SKIP LOCKED لحجز المدفوعات المعلقة من جدول طابور. ويجب أن يحدّث العامل حالة الصف المحجوز إلى 'processing' وprocessing_node في المعاملة نفسها. واستخدم CountDownLatch لاختبار 10 عمال متزامنين يحجزون من طابور من 10 عناصر وتحقق من حجز كل دفعة مرة واحدة بالضبط."},
    {"id": "3", "description": "نفّذ DistributedAccountLockService باستخدام pg_try_advisory_xact_lock يسلسل العمليات على الحساب نفسه عبر نسخ JVM. ويجب أن تتضمن الخدمة منطق إعادة محاولة مع تراجع أسي حتى 3 محاولات، وأن ترمي LockAcquisitionException إذا فشلت كل المحاولات."},
    {"id": "4", "description": "أنشئ أداة SafeDDLMigration تغلّف عمليات DDL بـ SET LOCAL lock_timeout = '100ms' للفشل السريع إذا كان الجدول مشغولًا. واختبر الأداة بتشغيلها بالتزامن مع معاملة SELECT FOR UPDATE طويلة وتحقق من أن DDL يفشل بخطأ وصفي بدل الحجب إلى ما لا نهاية."}
  ]
}
-->
