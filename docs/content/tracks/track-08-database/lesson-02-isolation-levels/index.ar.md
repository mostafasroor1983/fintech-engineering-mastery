---
id: track-08-lesson-02
title: "مستويات عزل المعاملات — شذوذ القراءة وعلاجه"
slug: isolation-levels
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 2
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [isolation-levels, dirty-read, phantom, serializable, read-committed]
prerequisites: []
---

# مستويات عزل المعاملات — شذوذ القراءة وإصلاحاته

> [!NOTE]
> اختيار مستوى العزل الخطأ في نظام مالي ليس مشكلة أداء — بل مشكلة صحة. فالقراءات القذرة، والقراءات غير القابلة للتكرار، والقراءات الشبحية تُترجم مباشرة إلى سحب على المكشوف، وتحصيل مكرر، وأخطاء في التقارير الرقابية. ويعلّمك هذا الدرس التفكير في العزل بدقة كي تتخذ مفاضلات مقصودة بدل قبول الافتراضيات عمياء.

## 1. لماذا يهم العزل في التقنية المالية

كل قاعدة بيانات مالية تتعامل مع معاملات متزامنة. وفي أي ثانية، قد تقرأ آلاف الخيوط أرصدة الحسابات، وتسجل الخصومات، وتشغّل التقارير الرقابية، وتطابق الدفاتر — كلها على البيانات نفسها. ويجب أن تعطي قاعدة البيانات كل معاملة رؤية متماسكة للعالم دون أن تتصادم بطرق تفسد منطق العمل.

يعرّف معيار SQL أربعة مستويات عزل كطيف بين الأداء والصحة:

| مستوى العزل | القراءة القذرة | القراءة غير القابلة للتكرار | القراءة الشبحية |
|----------------------|-----------|---------------------|--------------|
| READ UNCOMMITTED | ممكنة | ممكنة | ممكنة |
| READ COMMITTED | ممنوعة | ممكنة | ممكنة |
| REPEATABLE READ | ممنوعة | ممنوعة | ممكنة |
| SERIALIZABLE | ممنوعة | ممنوعة | ممنوعة |

الافتراضي في PostgreSQL هو **READ COMMITTED**. وتكتشف تطبيقات مالية كثيرة — بألم غالبًا — أن READ COMMITTED غير كافٍ لعمليات معينة.

## 2. شذوذ القراءة الثلاثة

### 2.1 القراءة القذرة

تحدث القراءة القذرة حين تقرأ المعاملة A بيانات كتبتها المعاملة B ولم تلتزم بعد. فإذا تراجعت B لاحقًا، تكون A قد تصرفت على بيانات لم توجد رسميًا قط.

```sql
-- Session A: begins but does not commit
BEGIN;
UPDATE accounts SET balance = balance - 500.00
WHERE account_id = 'ACC-1001';
-- (no COMMIT yet)

-- Session B (READ UNCOMMITTED): reads uncommitted change from A
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 500 less than the real balance — A might still rollback!
COMMIT;
```

**الأثر المالي:** خدمة تقييم احتيال تقرأ خصمًا غير ملتزم وتعلّم الحساب بأنه منخفض الرصيد. ثم تتراجع الجلسة A. فيكون الحساب قد عُلّم دون داعٍ. والأسوأ: بوابة دفع توافق على تحويل بناءً على رصيد لم يلتزم قط.

لا ينفذ PostgreSQL القراءات القذرة حتى عند READ UNCOMMITTED — بل يتصرف ببساطة مثل READ COMMITTED في ذلك المستوى. لكن MySQL وSQL Server تدعمان READ UNCOMMITTED حقيقيًا (وOracle لا يوفره أصلًا). فلا تعتمد أبدًا على سلوك خاص بقاعدة بيانات لضمانات الصحة.

### 2.2 القراءة غير القابلة للتكرار

تحدث القراءة غير القابلة للتكرار حين تقرأ المعاملة A الصف نفسه مرتين داخل المعاملة نفسها فتحصل على قيم مختلفة لأن المعاملة B التزمت بتغيير بين القراءتين.

```sql
-- Session A: READ COMMITTED (default)
BEGIN;
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 1000.00

-- Session B: commits a debit
BEGIN;
UPDATE accounts SET balance = balance - 300.00
WHERE account_id = 'ACC-1001';
COMMIT;

-- Session A: reads again
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 700.00 — different from the first read!
COMMIT;
```

**الأثر المالي:** خدمة تحويل برقي تقرأ رصيد المرسل، وتقرر أن التحويل صالح (1000 >= مبلغ التحويل 800)، ثم تعيد قراءة الرصيد لتسجيل المبلغ قبل التحويل — فتحصل على 700. فيكون سجل التدقيق خاطئًا. والأسوأ: إذا فصل أي التزام وسيط بين التحقق والخصم الفعلي، فقد يسبب الخصم سحبًا على المكشوف.

### 2.3 القراءة الشبحية

تحدث القراءة الشبحية حين تنفذ المعاملة A استعلام النطاق نفسه مرتين فتحصل على مجموعات صفوف مختلفة لأن المعاملة B أدرجت (أو حذفت) صفوفًا في ذلك النطاق بين القراءتين.

```sql
-- Session A: READ COMMITTED
BEGIN;
SELECT SUM(amount) AS daily_total
FROM daily_transactions
WHERE account_id = 'ACC-1001'
  AND transaction_date = CURRENT_DATE;
-- Returns 2500.00 (5 transactions)

-- Session B: inserts a new transaction (commits)
INSERT INTO daily_transactions (account_id, amount, transaction_date)
VALUES ('ACC-1001', 500.00, CURRENT_DATE);
COMMIT;

-- Session A: same query
SELECT SUM(amount) AS daily_total
FROM daily_transactions
WHERE account_id = 'ACC-1001'
  AND transaction_date = CURRENT_DATE;
-- Returns 3000.00 — a phantom row appeared!
COMMIT;
```

**الأثر المالي:** فحص حد إنفاق يومي يقرأ الإنفاق الإجمالي 2500 ويوافق على معاملة بـ 400 (الحد: 3000). وفي الأثناء تسللت معاملة أخرى. فيتجاوز الحساب حده اليومي بـ 400.

## 3. مستويات العزل الأربعة بالتفصيل

### 3.1 ‏READ UNCOMMITTED

يسمح بالقراءات القذرة. ولا يجب أن يستخدم أي نظام مالي هذا المستوى للبيانات التعاملية. وله استخدام هامشي في التحليلات على بيانات غير حرجة حيث تُقبل القراءات القديمة والأداء هو الأهم.

```sql
-- Explicitly setting (almost never appropriate in fintech)
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
```

### 3.2 ‏READ COMMITTED

الافتراضي في PostgreSQL. فكل عبارة داخل المعاملة ترى فقط البيانات الملتزمة قبل بدء تلك العبارة. وقد ترى المعاملة نفسها لقطات مختلفة عبر عبارات مختلفة.

```sql
-- This is the default; shown for clarity
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

BEGIN;
-- Statement 1 snapshot: everything committed before this statement
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';

-- If another session commits between here and the next SELECT,
-- Statement 2 will capture that new commit
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
COMMIT;
```

**متى يكون READ COMMITTED مقبولًا:**
- قراءات بسيطة لصف واحد حيث يتعامل التطبيق مع إعادات المحاولة
- عمليات إدراج فقط دون نمط قراءة-تعديل-كتابة
- تقارير متسقة بشكل فضفاض حيث يُحتمل تقادم طفيف

**متى لا يكون READ COMMITTED مقبولًا:**
- فحوص الرصيد التي يليها خصم في المعاملة نفسها (دون أقفال صفوف)
- المطابقة متعددة العبارات
- الحسابات التي تجمّع البيانات ثم تتصرف بناءً على المجموع

### 3.3 ‏REPEATABLE READ

ترى كل معاملة لقطة متسقة تؤخذ في بدايتها. فالصفوف المقروءة في البداية تبقى دون تغيير من منظور المعاملة، حتى لو عدّلتها جلسات أخرى والتزمت بها.

في PostgreSQL، يُنفذ REPEATABLE READ عبر MVCC (يُغطى في الدرس 03) كعزل لقطة: فيمنع القراءات القذرة، والقراءات غير القابلة للتكرار **و**القراءات الشبحية (يشترط معيار SQL الأوليين فقط).

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- Snapshot taken here
SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Returns 1000.00

-- External session commits UPDATE reducing balance to 700.00
-- Our snapshot is unaffected

SELECT balance FROM accounts WHERE account_id = 'ACC-1001';
-- Still returns 1000.00 — repeatable!

-- However: if we try to UPDATE the same row that another session
-- updated and committed after our snapshot, PostgreSQL raises
-- ERROR 40001: could not serialize access due to concurrent update
-- and the transaction must be retried
COMMIT;
```

**تحفظ انحراف الكتابة:** لا يمنع REPEATABLE READ انحراف الكتابة (write skew). فقد تقرأ معاملتان لقطتين متسقتين وتتخذان قرارات صالحة فرديًا لكنها غير متسقة مجتمعة. ويُغطى هذا بعمق في درس MVCC.

### 3.4 ‏SERIALIZABLE

أعلى مستويات العزل. تُنفذ المعاملات كأنها تعمل واحدة تلو الأخرى بترتيب تسلسلي ما. وينفذ PostgreSQL هذا باستخدام عزل اللقطة القابل للتسلسل (SSI)، الذي يتتبع اعتماديات القراءة/الكتابة ويُلغي المعاملات التي قد تخلق نتائج غير قابلة للتسلسل.

```sql
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Full snapshot isolation + serialization conflict detection
SELECT SUM(balance) FROM accounts
WHERE customer_id = 'CUST-5050';

-- Make a decision based on that sum...
INSERT INTO transfers (from_account, to_account, amount, initiated_at)
VALUES ('ACC-1001', 'ACC-1002', 500.00, NOW());

COMMIT;
-- If PostgreSQL detects a serialization anomaly, COMMIT raises:
-- ERROR 40001: could not serialize access due to read/write dependencies
-- Application MUST catch this and retry the transaction
```

**السلوك الأساسي:** قد تُلغى معاملات SERIALIZABLE بـ `ERROR 40001 (serialization_failure)`. ويجب أن يلتقط التطبيق هذا ويعيد المعاملة من البداية.

## 4. متى تستخدم SERIALIZABLE في التقنية المالية

### 4.1 فحص الرصيد + الخصم (الحالة الكلاسيكية)

حالة الاستخدام القياسية في التقنية المالية: اقرأ الرصيد الحالي، وتحقق من كفايته، ثم اخصم.

```java
@Service
public class TransferService {

    @Transactional(isolation = Isolation.SERIALIZABLE)
    public TransferResult executeTransfer(String fromAccount,
                                          String toAccount,
                                          BigDecimal amount) {
        // With SERIALIZABLE, these reads are part of a consistent
        // snapshot with write-dependency tracking
        Account sender = accountRepository.findByIdForUpdate(fromAccount);
        Account recipient = accountRepository.findByIdForUpdate(toAccount);

        if (sender.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException(fromAccount);
        }

        sender.debit(amount);
        recipient.credit(amount);

        accountRepository.save(sender);
        accountRepository.save(recipient);

        return TransferResult.success(sender.getBalance());
    }
}
```

لاحظ أنه في هذا النمط المحدد، يحقق `SELECT FOR UPDATE` (المغطى في درس الأقفال) ضمان الصحة نفسه بكفاءة أكبر باستخدام القفل التشاؤمي بدل SSI المتفائل. ويتألق SERIALIZABLE حين لا تستطيع استخدام FOR UPDATE — مثلًا حين تُحدد مجموعة القراءة ديناميكيًا أو تمتد عبر جداول متعددة.

### 4.2 فرض الحد اليومي

```java
@Transactional(isolation = Isolation.SERIALIZABLE)
public void enforceAndRecordDailyLimit(String accountId,
                                        BigDecimal transactionAmount) {
    BigDecimal todaySpend = transactionRepository
        .sumByAccountAndDate(accountId, LocalDate.now());

    BigDecimal limit = limitRepository.getDailyLimit(accountId);

    if (todaySpend.add(transactionAmount).compareTo(limit) > 0) {
        throw new DailyLimitExceededException(accountId);
    }

    transactionRepository.recordTransaction(accountId, transactionAmount);
}
```

دون عزل SERIALIZABLE، قد يقرأ استدعاءان متزامنان `todaySpend` بقيمة 2400، ويجتاز كلاهما فحص معاملة بـ 400 مقابل حد 3000، ويلتزم كلاهما — فينتج إنفاق 3200، أي 200 فوق الحد كان يجب رفضها.

### 4.3 فحوص رموز الـ Idempotency

```java
@Transactional(isolation = Isolation.SERIALIZABLE)
public PaymentResult processWithIdempotency(String idempotencyKey,
                                             PaymentRequest request) {
    // Check if already processed
    Optional<Payment> existing = paymentRepository
        .findByIdempotencyKey(idempotencyKey);

    if (existing.isPresent()) {
        return PaymentResult.alreadyProcessed(existing.get());
    }

    // Process payment
    Payment payment = processPayment(request);
    payment.setIdempotencyKey(idempotencyKey);
    paymentRepository.save(payment);

    return PaymentResult.success(payment);
}
```

دون SERIALIZABLE، قد يجد طلبان متزامنان بمفتاح idempotency نفسه أنه لا سجل موجود ويُدرج كلاهما — فينشأ تحصيل مكرر.

تحذيران:
- **أبسط وأقوى:** قيد `UNIQUE` على `idempotency_key` (مع `INSERT ... ON CONFLICT DO NOTHING`، أو التقاط خطأ المفتاح المكرر) يمنع التكرارات عند أي مستوى عزل.
- **لا تستدعِ أبدًا أنظمة خارجية داخل معاملة قد تُعاد.** فإذا كانت `processPayment` تحصّل من بطاقة عبر بوابة ثم أُعيدت المعاملة بعد عطل تسلسل، تُحصّل البطاقة مجددًا. فاحجز المفتاح والتزم أولًا؛ واستدعِ البوابة خارج المعاملة المُعادة، بمفتاح idempotency نفسه.

## 5. ضبط العزل في Spring @Transactional

### 5.1 التعليق على مستوى الدالة

```java
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountService {

    // Default: uses database default (READ COMMITTED for PostgreSQL)
    @Transactional
    public AccountSummary getAccountSummary(String accountId) {
        return buildSummary(accountId);
    }

    // Explicit READ COMMITTED for read-heavy operations
    @Transactional(isolation = Isolation.READ_COMMITTED, readOnly = true)
    public List<Transaction> getTransactionHistory(String accountId,
                                                    LocalDate from,
                                                    LocalDate to) {
        return transactionRepository.findByAccountAndDateRange(
            accountId, from, to);
    }

    // REPEATABLE READ for multi-statement reads that must be consistent
    @Transactional(isolation = Isolation.REPEATABLE_READ)
    public ReconciliationResult reconcileAccount(String accountId) {
        BigDecimal openingBalance = ledgerRepository
            .getOpeningBalance(accountId);
        List<Transaction> transactions = transactionRepository
            .findTodayTransactions(accountId);
        BigDecimal closingBalance = accountRepository
            .getCurrentBalance(accountId);

        return ReconciliationResult.compute(
            openingBalance, transactions, closingBalance);
    }

    // SERIALIZABLE for critical write operations with read checks
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void transferFunds(TransferRequest request) {
        performTransfer(request);
    }
}
```

### 5.2 منطق إعادة المحاولة لأعطال التسلسل

يجب إعادة معاملات SERIALIZABLE عند عطل التسلسل. ويتكامل Spring Retry بسلاسة:

```java
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.dao.ConcurrencyFailureException;

@Service
public class TransferService {

    // SQLSTATE 40001 / 40P01 reach the application as different Spring
    // exceptions depending on the stack (JDBC vs Hibernate): e.g.
    // CannotSerializeTransactionException or CannotAcquireLockException.
    // Their common parent ConcurrencyFailureException covers both (and
    // deadlocks, which are retryable too).
    // @Retryable runs OUTSIDE @Transactional here (Spring Retry's advice has
    // higher precedence), so every attempt is a fresh transaction.
    @Retryable(
        retryFor = ConcurrencyFailureException.class,
        maxAttempts = 3,
        backoff = @Backoff(delay = 50, multiplier = 2, random = true)
    )
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public TransferResult transfer(TransferRequest request) {
        return executeTransfer(request);
    }

    @Recover
    public TransferResult transferFailed(
            ConcurrencyFailureException ex,
            TransferRequest request) {
        log.error("Transfer failed after retries: {}", request.getTransferId());
        throw new TransferFailedException("Concurrent modification conflict", ex);
    }
}
```

### 5.3 الإدارة البرمجية للمعاملات

للتحكم الدقيق، استخدم `TransactionTemplate`:

```java
@Service
public class BalanceService {

    private final TransactionTemplate serializableTx;
    private final TransactionTemplate readCommittedTx;

    public BalanceService(PlatformTransactionManager txManager) {
        this.serializableTx = new TransactionTemplate(txManager);
        this.serializableTx.setIsolationLevel(
            TransactionDefinition.ISOLATION_SERIALIZABLE);

        this.readCommittedTx = new TransactionTemplate(txManager);
        this.readCommittedTx.setIsolationLevel(
            TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.readCommittedTx.setReadOnly(true);
    }

    public BalanceSnapshot getBalance(String accountId) {
        return readCommittedTx.execute(status ->
            accountRepository.findBalance(accountId));
    }

    public void adjustBalance(String accountId, BigDecimal delta) {
        serializableTx.execute(status -> {
            Account account = accountRepository.findById(accountId)
                .orElseThrow();
            account.adjustBalance(delta);
            accountRepository.save(account);
            return null;
        });
    }
}
```

## 6. تبعات الأداء

فهم كلفة الأداء لكل مستوى عزل يساعدك على اتخاذ مفاضلات مستنيرة.

### 6.1 خصائص أداء READ COMMITTED

- كل عبارة تحصل على لقطة جديدة — حمل منخفض
- أقفال الصفوف (عند التحديث) تُمسك حتى نهاية المعاملة، والقراءات لا تحجب
- أعلى تزامن، وأدنى تنازع
- مناسب لـ: الخدمات كثيفة القراءة، والتقارير، والتحليلات على بيانات غير حرجة

### 6.2 خصائص أداء REPEATABLE READ

- تؤخذ اللقطة عند بدء المعاملة — وتُمسك طوال مدتها
- المعاملة الأطول تعني حمل MVCC أكبر (نسخ صفوف ميتة أكثر)
- تُكتشف تعارضات الكتابة حين تحاول المعاملة تحديث صف غيّرته معاملة أخرى بعد اللقطة — فتفشل بـ 40001 ويجب إعادتها
- الكلفة الإضافية تعتمد على الحمل (إعادات المحاولة، واللقطات الممسوكة أطول)؛ فقِسها

### 6.3 خصائص أداء SERIALIZABLE

يسجّل تنفيذ SSI في PostgreSQL ما قرأته كل معاملة قابلة للتسلسل (كـ "أقفال مسندات" **SIRead** غير حاجبة) ويراقب **الاعتماديات العكسية للقراءة-الكتابة (rw-antidependencies)**: المعاملة T1 تقرأ بيانات تكتبها بعدها معاملة متزامنة T2. وحين يجد "بنية خطرة" — تعارضين من هذا النوع متتاليين بين معاملات متزامنة — يُلغي إحدى المعاملات بـ 40001. (أما تعارضات الكتابة-الكتابة على الصف نفسه فتعالجها أقفال الصفوف العادية.)

```sql
-- SSI bookkeeping in production: predicate locks held right now
SELECT count(*) AS siread_locks
FROM pg_locks
WHERE mode = 'SIReadLock';
-- Many locks get combined into coarser ones (page/relation) when
-- max_pred_locks_per_transaction is reached -> more false-positive aborts

-- Rollbacks per database (serialization failures are part of this count;
-- PostgreSQL has no separate counter -- count 40001 errors in the app)
SELECT xact_commit, xact_rollback
FROM pg_stat_database
WHERE datname = current_database();
```

أثر SERIALIZABLE على الأداء:
- تعتمد كلفة الإنتاجية على الحمل — قِسها تحت تزامن واقعي
- حمل ذاكرة لتتبع أقفال المسندات
- يزداد معدل الإلغاء مع التنازع (خطط لإعادات المحاولة؛ وأبقِ المعاملات قصيرة)
- لمعظم المسارات الحرجة في التقنية المالية: حمل مقبول مقابل ضمان الصحة

### 6.4 مستوى العزل حسب حالة الاستخدام

| حالة الاستخدام | المستوى الموصى به | المبرر |
|----------|------------------|---------------|
| قراءة رصيد الحساب (للعرض) | READ COMMITTED | التقادم بالمللي ثواني مقبول |
| قائمة سجل المعاملات | READ COMMITTED | لا قرار كتابة بناءً على القراءة |
| مطابقة متعددة الخطوات | REPEATABLE READ | رؤية متسقة مطلوبة؛ لا خطر انحراف كتابة |
| تحويل مع فحص الرصيد | SERIALIZABLE أو SELECT FOR UPDATE | قرار كتابة بناءً على قراءة |
| فرض الحد اليومي | SERIALIZABLE | خطر شبحي على قراءة تجميعية |
| فحص الـ idempotency + إدراج | قيد UNIQUE ‏(+ ON CONFLICT) | قاعدة البيانات ترفض التكرار عند أي مستوى عزل |
| توليد تقرير دفعي | REPEATABLE READ | لقطة متسقة للتقرير |
| البحث عن درجة الاحتيال | READ COMMITTED | غير حرج، حساس للزمن |

## 7. أمثلة شذوذ بـ SQL — سيناريوهات إنتاج

### 7.1 كشف الشذوذ المحتمل في الشيفرة القائمة

قبل رفع مستويات العزل، حدد الأنماط الخطرة:

```sql
-- Find long-running transactions (potential for stale reads)
SELECT pid,
       now() - pg_stat_activity.query_start AS duration,
       query,
       state
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > INTERVAL '5 minutes'
  AND state != 'idle'
ORDER BY duration DESC;
```

```java
// DANGEROUS pattern: READ COMMITTED + read-modify-write without locking
@Transactional  // Default: READ COMMITTED
public void dangerousTransfer(String fromId, String toId, BigDecimal amount) {
    // READ: snapshot 1
    Account from = accountRepository.findById(fromId).orElseThrow();

    // Another transaction may commit a debit here
    if (from.getBalance().compareTo(amount) < 0) {
        throw new InsufficientFundsException();
    }

    // READ: snapshot 2 (possibly different from snapshot 1 in READ COMMITTED!)
    Account fromAgain = accountRepository.findById(fromId).orElseThrow();
    // fromAgain.getBalance() may now be LESS than the validated amount!

    fromAgain.debit(amount);  // Potential overdraft!
    accountRepository.save(fromAgain);
}
```

### 7.2 النمط الصحيح بالقفل الصريح

```java
// SAFE pattern: SELECT FOR UPDATE under READ COMMITTED
@Transactional
public void safeTransfer(String fromId, String toId, BigDecimal amount) {
    // Locks the row; no other transaction can modify it until we commit
    Account from = accountRepository.findByIdWithLock(fromId);
    Account to = accountRepository.findByIdWithLock(toId);

    if (from.getBalance().compareTo(amount) < 0) {
        throw new InsufficientFundsException();
    }

    from.debit(amount);
    to.credit(amount);

    accountRepository.save(from);
    accountRepository.save(to);
}
```

```java
// Repository with pessimistic write lock
public interface AccountRepository extends JpaRepository<Account, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.id = :id")
    Account findByIdWithLock(@Param("id") String id);
}
```

### 7.3 مثال انحراف الكتابة وإصلاحه

انحراف الكتابة شذوذ دقيق لا يمنعه REPEATABLE READ:

```sql
-- Scenario: Two transactions check that at least one doctor is on-call
-- Both read that there are 2 on-call doctors
-- Both decide to go off-call (each is valid individually)
-- Result: zero on-call doctors — collectively invalid

-- Fintech equivalent: Two transactions read total collateral posted
-- Both approve a margin increase based on current total collateral
-- Both commit, resulting in over-leveraged positions

-- FIX 1: Use SERIALIZABLE
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- PostgreSQL tracks the dependency and aborts one transaction on conflict

-- FIX 2: Use SELECT FOR UPDATE on a "guard" row
BEGIN;
SELECT total_collateral FROM position_summary
WHERE portfolio_id = 'PORT-001'
FOR UPDATE;  -- Serializes all margin decisions for this portfolio
-- ... check and act ...
COMMIT;
```

## 8. ملاحظات سلوك خاصة بـ PostgreSQL

### 8.1 ‏SET مقابل ALTER

```sql
-- Set for current transaction only
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Set for current session (all future transactions)
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Set default for a specific database role (DBA action)
ALTER ROLE payment_service
SET default_transaction_isolation = 'serializable';

-- Set default for the entire database
ALTER DATABASE payments_db
SET default_transaction_isolation = 'read committed';
```

### 8.2 فحص مستوى العزل الحالي

```sql
-- Check current transaction isolation level
SHOW transaction_isolation;

-- Check session default
SHOW default_transaction_isolation;
```

### 8.3 دقائق READ COMMITTED

يحدّث PostgreSQL اللقطة بين العبارات في READ COMMITTED. وهذا يعني أن `SELECT ... FOR UPDATE` داخل معاملة READ COMMITTED ستعيد قراءة الصفوف الملتزمة:

```sql
BEGIN;  -- READ COMMITTED (default)
SELECT * FROM accounts WHERE balance > 1000 FOR UPDATE;
-- Locks all rows where balance > 1000 at statement start

-- Another session commits an UPDATE changing a balance from 500 to 1500
-- (a row that was NOT in our original result set)

-- If we re-execute the same query:
SELECT * FROM accounts WHERE balance > 1000 FOR UPDATE;
-- Now includes the new row! (READ COMMITTED re-reads per statement)
COMMIT;
```

هذا سلوك مقصود في PostgreSQL. وإذا احتجت مجموعة صفوف ثابتة، فاستخدم REPEATABLE READ أو SERIALIZABLE.

## 9. المراقبة والقابلية للملاحظة

### 9.1 مقاييس تعارض المعاملات

```sql
-- NOTE: pg_stat_database_conflicts counts queries cancelled on a STANDBY
-- because of recovery conflicts (useful for read replicas) -- it does NOT
-- count serialization failures on the primary
SELECT confl_tablespace,
       confl_lock,
       confl_snapshot,
       confl_bufferpin,
       confl_deadlock
FROM pg_stat_database_conflicts
WHERE datname = current_database();

-- Transactions holding a transaction id, oldest first
-- (long-running ones keep old row versions alive)
SELECT pid,
       backend_xid,
       backend_xmin,
       state,
       query_start,
       left(query, 80) AS query_snippet
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL
ORDER BY query_start;
```

### 9.2 مقاييس التطبيق التي يجب تتبعها

```java
@Component
public class TransactionIsolationMetrics {

    private final MeterRegistry registry;

    public TransactionIsolationMetrics(MeterRegistry registry) {
        this.registry = registry;
    }

    // Counter.increment() takes an amount, not tags: tagged counters are
    // looked up (and cached by Micrometer) per tag combination
    public void recordSerializationFailure(String operationName) {
        registry.counter("db.serialization.failures",
                "operation", operationName)
            .increment();
    }

    public void recordRetrySuccess(String operationName, int attemptNumber) {
        registry.counter("db.serialization.retries.success",
                "operation", operationName,
                "attempt", String.valueOf(attemptNumber))
            .increment();
    }
}
```

## 10. قائمة فحص الإنتاج

**قبل نشر عملية مالية جديدة:**

- [ ] حدد كل قراءة تؤثر في قرار كتابة في المعاملة نفسها
- [ ] حدد ما إذا كان التنفيذ المتزامن للعملية قد ينتج نتائج خاطئة
- [ ] اختر أدنى مستوى عزل يمنع الشذوذ المحدد
- [ ] إذا استخدمت SERIALIZABLE، نفّذ منطق إعادة المحاولة مع تراجع أسي
- [ ] أضف مقاييس مراقبة لأعطال التسلسل ومعدلات إعادة المحاولة
- [ ] اختبر العملية بالحمل تحت تزامن واقعي لقياس معدلات الإلغاء
- [ ] وثّق اختيار مستوى العزل والشذوذ الذي يمنعه في تعليقات الشيفرة
- [ ] فكّر فيما إذا كان القفل التشاؤمي (`SELECT FOR UPDATE`) حلًا أبسط

**علامات تحذير في الشيفرة القائمة:**

- ‏`@Transactional` دون تحديد `isolation` على دالة تقرأ ثم تكتب
- معاملات متعددة العبارات تحت READ COMMITTED مع قراءات تجميعية
- فحوص idempotency دون قيد UNIQUE أو قفل أو SERIALIZABLE
- تحقق من الرصيد منفصل عن الخصم بأي قدر من الشيفرة غير التافهة

## الخلاصة

تمثل مستويات عزل SQL الأربعة طيفًا بين التزامن والصحة. وفي التقنية المالية، كثيرًا ما يكون READ COMMITTED الافتراضي غير كافٍ. فاعرف أنواع الشذوذ:

- **القراءة القذرة:** قراءة بيانات غير ملتزمة — ممنوعة عند READ COMMITTED وما فوقه
- **القراءة غير القابلة للتكرار:** الصف نفسه يعيد قيمًا مختلفة في معاملة واحدة — ممنوعة عند REPEATABLE READ وما فوقه
- **القراءة الشبحية:** استعلام النطاق نفسه يعيد صفوفًا مختلفة — ممنوعة عند SERIALIZABLE (ومن قِبل REPEATABLE READ في PostgreSQL أيضًا)
- **انحراف الكتابة:** معاملتان تتخذان قرارات صالحة فرديًا لكنها غير صالحة مجتمعة — لا يمنعه إلا SERIALIZABLE

استخدم `@Transactional(isolation = Isolation.SERIALIZABLE)` للفحوص التجميعية مثل فرض الحدود، وقيود UNIQUE للـ idempotency. ونفّذ دائمًا منطق إعادة المحاولة لأعطال التسلسل — وأبقِ الاستدعاءات الخارجية خارج المعاملات المُعادة. وحين يكون القفل التشاؤمي أبسط، فإن `SELECT FOR UPDATE` تحت READ COMMITTED بديل صالح لحالات الصف الواحد.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تستخدم خدمة دفع عزل READ COMMITTED. تقرأ المعاملة A رصيد الحساب = 1,000 جنيه، ثم تلتزم المعاملة B بخصم يخفض الرصيد إلى 600 جنيه. وتقرأ المعاملة A الرصيد ثانية في المعاملة نفسها. ماذا ترى المعاملة A في القراءة الثانية؟",
      "options": [
        "1,000 جنيه — READ COMMITTED يمنع ظهور أي تغييرات في منتصف المعاملة",
        "600 جنيه — READ COMMITTED يسمح بالقراءات غير القابلة للتكرار؛ فكل عبارة ترى أحدث البيانات الملتزمة",
        "خطأ — يُكتشف تعديل متزامن وتُلغى المعاملة",
        "إما 1,000 أو 600 جنيه بحسب ترتيب الحصول على الأقفال"
      ],
      "correct": 1,
      "explanation": "يأخذ READ COMMITTED لقطة جديدة عند بدء كل عبارة، لا عند بدء المعاملة. فترى عبارة SELECT الثانية تحديث المعاملة B الملتزم. وهذه قراءة غير قابلة للتكرار — شذوذ معروف في READ COMMITTED. وللعمليات متعددة القراءات المتسقة، يلزم REPEATABLE READ أو SERIALIZABLE."
    },
    {
      "text": "تقرأ معاملتان متزامنتان الإنفاق اليومي لعميل بقيمة 2,400 جنيه مقابل حد 3,000 جنيه. وتوافق كلتاهما على معاملة جديدة بـ 400 جنيه وتلتزمان. ما الشذوذ الذي حدث وأي مستوى عزل كان سيمنعه؟",
      "options": [
        "قراءة قذرة — يمنعها READ COMMITTED",
        "قراءة غير قابلة للتكرار — يمنعها REPEATABLE READ",
        "قراءة شبحية — يمنعها عزل SERIALIZABLE",
        "انحراف كتابة — لا يمنعه إلا عزل SERIALIZABLE"
      ],
      "correct": 3,
      "explanation": "هذا انحراف كتابة: كل معاملة تقرأ لقطة متسقة (الإنفاق المجمّع = 2,400 جنيه) وتتخذ قرارًا صالحًا فرديًا (2,400 + 400 = 2,800 < 3,000). لكن موافقتين متزامنتين تنتجان 2,400 + 400 + 400 = 3,200، فتتجاوزان الحد. ويمنع REPEATABLE READ تغير الصف نفسه في منتصف المعاملة لكنه لا يمنع انحراف الكتابة على القراءات التجميعية. ولا يكتشف إحدى المعاملتين المتعارضتين ويُلغيها إلا SERIALIZABLE ‏(عبر SSI في PostgreSQL)."
    },
    {
      "text": "ترمي معاملة SERIALIZABLE في PostgreSQL الخطأ `ERROR 40001: could not serialize access due to read/write dependencies`. ما الرد الصحيح من التطبيق؟",
      "options": [
        "سجّل الخطأ وأعد 500 Internal Server Error للعميل",
        "أعد المعاملة كاملة من البداية مع تراجع أسي",
        "اخفض المستوى إلى READ COMMITTED وأعد العمليات نفسها",
        "زِد max_connections في PostgreSQL لتقليل التنازع"
      ],
      "correct": 1,
      "explanation": "الخطأ 40001 عطل تسلسل — اكتشف PostgreSQL أن السماح للمعاملة بالالتزام سينتهك قابلية التسلسل. والرد الصحيح إعادة المعاملة كاملة من البداية (إعادة قراءة كل البيانات، وإعادة تطبيق منطق العمل، وإعادة محاولة الالتزام)، لعدد محدود من المرات مع تراجع. ومع Spring Retry، أعد المحاولة على ConcurrencyFailureException ‏(الذي يغطي CannotSerializeTransactionException وCannotAcquireLockException). وخفض العزل يُبطل الغرض وقد يُدخل الشذوذ نفسه الذي كنت تمنعه."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تدقيق مستوى العزل وفرض الحد اليومي",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "دقّق خدمة Spring قائمة تعالج المدفوعات باستخدام @Transactional الافتراضي (READ COMMITTED). وحدد كل أنماط القراءة-التعديل-الكتابة وصنّف كلًا منها: آمن (صف واحد مع FOR UPDATE)، أو معرض للخطر (قراءات تجميعية)، أو خطر (قراءة ثم كتابة دون قفل). ووثّق الشذوذ المحدد الذي قد يحدث لكل نمط معرض للخطر."},
    {"id": "2", "description": "نفّذ فحص حد إنفاق يومي صحيحًا تحت الحمل المتزامن. يجب أن يقرأ الفحص مجموع معاملات اليوم لحساب ويرفض المعاملة الجديدة إذا كان المجموع سيتجاوز الحد. اكتب التنفيذ باستخدام عزل SERIALIZABLE مع Spring Retry، ثم نسخة ثانية تقفل صفًا حارسًا (صف الحساب) بـ SELECT ... FOR UPDATE، واشرح لماذا لن ينجح قفل صفوف المعاملات الموجودة فقط (الصفوف الجديدة لا تُقفل)."},
    {"id": "3", "description": "اكتب اختبار JUnit متعدد الخيوط باستخدام 20 خيطًا متزامنًا يقدّم كل منها دفعة بـ 400 جنيه للحساب نفسه بحد يومي 3,000 جنيه. ودون عزل SERIALIZABLE، بيّن أن أكثر من 7 مدفوعات تنجح (إثبات حالة التسابق). ومع عزل SERIALIZABLE، تحقق من نجاح 7 مدفوعات بالضبط ورفض الباقي أو إعادته بشكل صحيح."},
    {"id": "4", "description": "أضف مقاييس Micrometer لتتبع معدل أعطال التسلسل ومعدل نجاح إعادة المحاولة لكل نوع عملية. وعرّف عتبات تنبيه: ما معدل أعطال التسلسل الذي يدل على مشكلة تصميم تتطلب مراجعة معمارية لا مجرد إعادات محاولة أكثر؟"}
  ]
}
-->
