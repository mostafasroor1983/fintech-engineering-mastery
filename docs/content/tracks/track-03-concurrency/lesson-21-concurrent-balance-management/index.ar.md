---
id: track-03-lesson-21
sequence: 21
title: "أنماط إدارة الأرصدة المتزامنة"
slug: concurrent-balance-management
track: track-03
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [balance-management, optimistic-locking, pessimistic-locking, SELECT-FOR-UPDATE]
java-versions: [17, 21]
---

# إدارة الأرصدة المتزامنة — من الذاكرة إلى قاعدة البيانات

## نظرة عامة

إدارة الأرصدة أكثر مشكلات البرمجة المتزامنة أثرًا ماليًا. فالسحب على المكشوف الناتج عن حالة تسابق ليس مجرد خطأ برمجي — بل فشل تنظيمي، وباب للاحتيال، وأزمة ثقة مع العملاء. ويغطي هذا الدرس الطيف الكامل للأساليب، من العمليات الذرية في الذاكرة إلى قفل قاعدة البيانات الموزعة، ومتى يناسب كل منها.

## أهداف التعلم

في نهاية هذا الدرس ستستطيع:

- تحديد أنماط الفشل الثلاثة في تحديثات الأرصدة المتزامنة (التحديث الضائع، والسحب على المكشوف بسبب الفحص-ثم-التنفيذ، والمعالجة المكررة)
- تنفيذ إدارة أرصدة في الذاكرة بـ AtomicLong وحراسات ضد السحب على المكشوف مبنية على CAS
- استخدام تحديث `UPDATE` شرطي واحد كأبسط خصم آمن في قاعدة البيانات
- تطبيق القفل المتفائل بـ `@Version` في JPA لتحديثات الأرصدة قليلة التنافس
- استخدام القفل المتشائم (`SELECT FOR UPDATE`) بشكل صحيح لحسابات الدفع كثيرة التنافس
- تصميم عمليات أرصدة عديمة التكرار (idempotent) تصمد أمام الطلبات المكررة
- اختيار مستوى العزل الصحيح لاتساق "اقرأ ما كتبت"

## سياق العمل

تعالج محفظة جوال 8,000 معاملة في الثانية في الذروة. وتُقرأ حسابات العملاء أكثر بكثير مما تُكتب (90% قراءة، و10% كتابة). لكن حسابات كبار التجار تتلقى مئات الخصوم المتزامنة من أجهزة الدفع. فيجب أن تتعامل استراتيجية إدارة الأرصدة مع الحالتين: قراءات خفيفة لمعظم الحسابات، وكتابات آمنة من التنافس للحسابات كثيفة الحركة.

## أنماط الفشل الثلاثة

### التحديث الضائع

يقرأ خيطان الرصيد نفسه، ويحسب كل منهما قيمة جديدة، فيكتب أحدهما فوق الآخر:

```
Thread A: read balance = 1000
Thread B: read balance = 1000
Thread A: write balance = 1000 - 200 = 800   ✓ debit 200
Thread B: write balance = 1000 - 300 = 700   ✗ LOST Thread A's debit
                                             ✗ Net debit should be 500, actual is 300
```

### السحب على المكشوف الخفي

يفحص الخيط A الرصيد (كافٍ)، ثم يستنزف الخيط B الرصيد، ثم يخصم الخيط A تحت الصفر:

```
Thread A: read balance = 500  → check: 500 >= 300 ✓
Thread B: debit 400           → balance = 100
Thread A: debit 300           → balance = -200  ✗ OVERDRAFT
```

### الإضافة المزدوجة / الخصم المزدوج

ترسل إعادة محاولة في الشبكة المعاملة نفسها مرتين. ودون عدم تكرار (idempotency) يتغير الرصيد مرتين.

## الرصيد في الذاكرة: AtomicLong مع حارس

للحسابات المُدارة كليًا في الذاكرة (ذاكرات مؤقتة، ومحددات معدّل، ومحافظ داخل العملية)، يقدم `AtomicLong` صحة خالية من الأقفال:

```java
public class InMemoryBalance {

    private final AtomicLong balanceCents;
    private final String     accountId;

    public InMemoryBalance(String accountId, long initialCents) {
        this.accountId    = accountId;
        this.balanceCents = new AtomicLong(initialCents);
    }

    // Simple credit — no overflow guard needed in most cases
    public long credit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException("Credit must be positive");
        return balanceCents.addAndGet(amountCents);
    }

    // Debit with overdraft prevention using CAS loop
    public DebitResult debit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException("Debit must be positive");

        while (true) {
            long current = balanceCents.get();
            if (current < amountCents) {
                return DebitResult.insufficientFunds(current, amountCents);
            }
            long next = current - amountCents;
            if (balanceCents.compareAndSet(current, next)) {
                return DebitResult.success(next);
            }
            // CAS failed — another thread modified balance; retry
        }
    }

    // Read current balance — single atomic read
    public long getBalance() {
        return balanceCents.get();
    }

    public record DebitResult(boolean success, long remainingBalance,
                              long requested, String failureReason) {
        static DebitResult success(long remaining) {
            return new DebitResult(true, remaining, 0, null);
        }
        static DebitResult insufficientFunds(long current, long requested) {
            return new DebitResult(false, current, requested,
                "Insufficient funds: balance=" + current + " requested=" + requested);
        }
    }
}
```

إذا فشل CAS فقد عدّل خيط آخر الرصيد، فتُعاد المحاولة بالقيمة الجديدة. والفحص والخصم يحدثان معًا ذريًا عبر `compareAndSet`.

> [!WARNING]
> رصيد `AtomicLong` في الذاكرة صحيح داخل عملية JVM واحدة، لكنه يفقد حالته عند إعادة التشغيل ولا يمكن مشاركته بين نسخ الخدمة. وهو مناسب لـ: محددات المعدّل، والحصص المؤقتة المرتبطة بالجلسة، والاختبار. وهو **غير** مناسب لأرصدة الحسابات الحقيقية — ولا حتى مع ذاكرة مؤقتة بكتابة مؤجلة (write-behind)، لأن التعطل يفقد كل تغيير لم يُكتب بعد. فقاعدة البيانات هي مصدر الحقيقة.

## الرصيد في قاعدة البيانات: تحديث UPDATE شرطي واحد

لخصم من حساب واحد، أبسط خيار آمن لا يحتاج أي قفل في التطبيق. فالفحص والتغيير يحدثان في عبارة **واحدة**، فتطبقهما قاعدة البيانات ذريًا وتحتجز قفل الصف مدة تلك العبارة فقط:

```sql
-- Debit only if the funds are there. 0 rows updated = insufficient funds
-- (or unknown account). No read-then-write race is possible.
UPDATE accounts
   SET balance_cents = balance_cents - :amount,
       version       = version + 1
 WHERE account_id = :id
   AND balance_cents >= :amount;
```

استخدم الأنماط التالية عندما تحتاج إلى الكيان كاملًا في Java (عدة قواعد للفحص، أو عدة صفوف للتغيير).

## الرصيد في قاعدة البيانات: القفل المتفائل

يفترض القفل المتفائل أن التعارضات نادرة. فكل قراءة تتضمن رقم إصدار، وعند الكتابة يُقارن الإصدار. فإذا عدّلت معاملة أخرى الصف، يختلف الإصدار ويفشل التحديث — فيعيد المستدعي المحاولة.

### كيان JPA مع @Version

```java
@Entity
@Table(name = "accounts")
public class Account {

    @Id
    private String accountId;

    @Column(nullable = false)
    private long balanceCents;

    @Version
    private long version;   // JPA increments this on every UPDATE

    @Column(nullable = false)
    private String currency;

    // Encapsulate mutation — never set balance directly from outside
    public void credit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException();
        this.balanceCents += amountCents;
    }

    public void debit(long amountCents) {
        if (amountCents <= 0) throw new IllegalArgumentException();
        if (this.balanceCents < amountCents) {
            throw new InsufficientFundsException(accountId, balanceCents, amountCents);
        }
        this.balanceCents -= amountCents;
    }
}
```

### خدمة مع إعادة محاولة متفائلة

```java
@Service
public class OptimisticBalanceService {

    @Autowired private AccountRepository accountRepo;
    @Autowired private TransactionRepository txRepo;
    @Autowired private TransactionTemplate txTemplate;   // REQUIRED propagation

    private static final int MAX_RETRIES = 3;

    // NO @Transactional here: each attempt must run in its OWN transaction,
    // and the version conflict is only detected when that transaction
    // flushes/commits — so the retry loop must sit OUTSIDE the transaction.
    // (A private @Transactional method called via `this` would be ignored
    //  by the Spring proxy, so TransactionTemplate is used instead.)
    public void debit(String accountId, long amountCents, String idempotencyKey) {

        for (int attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                txTemplate.executeWithoutResult(status ->
                    doDebit(accountId, amountCents, idempotencyKey));
                return;  // Success (or duplicate — see doDebit)

            } catch (ObjectOptimisticLockingFailureException ex) {
                if (attempt == MAX_RETRIES - 1) {
                    throw new BalanceUpdateConflictException(
                        "Could not update balance after " + MAX_RETRIES + " attempts", ex);
                }
                // Backoff before retry
                try {
                    Thread.sleep(10L * (attempt + 1));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException(ie);
                }
            }
        }
    }

    // Runs inside the transaction opened by txTemplate: a fresh persistence
    // context, so the account is reloaded with its latest version
    private void doDebit(String accountId, long amountCents, String idempotencyKey) {
        // Claim the idempotency key FIRST: INSERT ... ON CONFLICT DO NOTHING.
        // The UNIQUE constraint — not an exists() check — is what stops a
        // concurrent duplicate: the second INSERT waits for the first
        // transaction, then inserts 0 rows
        if (txRepo.claimIdempotencyKey(idempotencyKey, accountId, -amountCents) == 0) {
            return;  // Already processed (or being processed) — no second debit
        }
        Account account = accountRepo.findById(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));
        account.debit(amountCents);
        // JPA checks @Version on flush at commit → ObjectOptimisticLockingFailureException;
        // the whole transaction (including the claimed key) rolls back and is retried
    }
}
```

لا يوجد `@Transactional` على طريقة إعادة المحاولة: فيجب أن تعمل كل محاولة في معاملتها **الخاصة**، ولا يُكتشف تعارض الإصدار إلا عند تفريغ تلك المعاملة أو التزامها — فيجب أن تكون حلقة إعادة المحاولة **خارج** المعاملة. (والطريقة الخاصة `private` المعلّمة بـ `@Transactional` والمستدعاة عبر `this` يتجاهلها وكيل Spring، لذا يُستخدم `TransactionTemplate`.) وتُحجز مفتاح عدم التكرار **أولًا** بـ `INSERT ... ON CONFLICT DO NOTHING`: فالقيد الفريد — لا فحص `exists()` — هو ما يوقف التكرار المتزامن.

**متى تستخدم القفل المتفائل:**
- تنافس منخفض: لمعظم الحسابات معاملات متزامنة قليلة
- معاملات قصيرة: القراءة + التحقق + الكتابة تكتمل بسرعة
- إعادة المحاولة مقبولة: مسارات العملاء التي تكون فيها إعادة المحاولة شفافة

**متى لا تستخدم القفل المتفائل:**
- تنافس عالٍ: حسابات التجار التي تتلقى مئات الخصوم المتزامنة ستعيد المحاولة باستمرار
- أقفال منطقية طويلة: مسارات عمل متعددة الخطوات يجب أن يبقى فيها الحساب مقفلًا عبر استدعاءات خدمات

## الرصيد في قاعدة البيانات: القفل المتشائم

يحصل القفل المتشائم على قفل صف في قاعدة البيانات وقت القراءة. والمعاملات الأخرى التي تحاول قفل الصف نفسه أو تحديثه تنتظر حتى يُحرر القفل. (وفي PostgreSQL لا تُحجب عبارات `SELECT` العادية — فـ MVCC يسمح لها بقراءة آخر إصدار ملتزم.)

### SELECT FOR UPDATE

```java
// Repository
public interface AccountRepository extends JpaRepository<Account, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.accountId = :id")
    Optional<Account> findByIdForUpdate(@Param("id") String id);
}
```

عبارة SQL المولّدة: `SELECT * FROM accounts WHERE account_id = ? FOR UPDATE`

```java
@Service
public class PessimisticBalanceService {

    @Autowired private AccountRepository accountRepo;
    @Autowired private TransactionRepository txRepo;

    @Transactional(isolation = Isolation.READ_COMMITTED, timeout = 5)
    public void debit(String accountId, long amountCents, String idempotencyKey) {

        // Claim the idempotency key in THIS transaction (INSERT ... ON CONFLICT
        // DO NOTHING). A concurrent duplicate waits on the unique index, then
        // gets 0 rows once we commit. A plain exists() check would let two
        // concurrent duplicates both pass.
        if (txRepo.claimIdempotencyKey(idempotencyKey, accountId, -amountCents) == 0) {
            return;
        }

        // Acquire row lock — blocks concurrent writers on this account
        Account account = accountRepo.findByIdForUpdate(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));

        account.debit(amountCents);   // throws → whole transaction (and claim) rolls back
        // Lock released on transaction commit/rollback
    }
}
```

يُحجز مفتاح عدم التكرار في **هذه** المعاملة. والطلب المكرر المتزامن ينتظر على الفهرس الفريد، ثم لا يُدرج أي صف بعد التزامنا. أما فحص `exists()` العادي فيسمح لطلبين مكررين متزامنين بالمرور معًا.

### ترتيب الأقفال للعمليات متعددة الحسابات

تتطلب التحويلات بين الحسابات قفل صفين. فاقفل دائمًا بترتيب قياسي (مثل الترتيب المعجمي لمعرّف الحساب) لمنع الجمود:

```java
@Transactional(isolation = Isolation.READ_COMMITTED, timeout = 10)
public void transfer(String fromId, String toId, long amountCents, String idempotencyKey) {

    if (fromId.equals(toId)) throw new IllegalArgumentException("Same account");

    // Claim the key first — the unique constraint stops concurrent duplicates
    if (txRepo.claimTransferKey(idempotencyKey, fromId, toId, amountCents) == 0) return;

    // Canonical lock order — prevents deadlock when two transfers go in opposite directions
    String firstId  = fromId.compareTo(toId) < 0 ? fromId : toId;
    String secondId = fromId.compareTo(toId) < 0 ? toId   : fromId;

    Account first  = accountRepo.findByIdForUpdate(firstId)
        .orElseThrow(() -> new AccountNotFoundException(firstId));
    Account second = accountRepo.findByIdForUpdate(secondId)
        .orElseThrow(() -> new AccountNotFoundException(secondId));

    Account from = fromId.equals(firstId) ? first : second;
    Account to   = fromId.equals(firstId) ? second : first;

    from.debit(amountCents);
    to.credit(amountCents);
}
```

### SKIP LOCKED: نمط طابور العمل

في معالجة الخصوم الدفعية، يسمح `SKIP LOCKED` لعدة عمال بمعالجة حسابات مختلفة بالتزامن دون أن يحجب بعضهم بعضًا:

```java
// Acquire up to 10 unsettled transactions, skip any already locked by other workers
// (Hibernate 6 HQL supports LIMIT; the lock timeout hint -2 means SKIP LOCKED)
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))  // SKIP LOCKED
@Query("SELECT t FROM PendingTransaction t WHERE t.status = 'PENDING' ORDER BY t.createdAt LIMIT 10")
List<PendingTransaction> claimBatch();
// The row locks last only until the transaction ends: process the rows (and
// set status = 'DONE') in the SAME transaction, or mark them 'CLAIMED' with a
// claim timestamp so a crashed worker's rows can be picked up again
```

عبارة SQL المولّدة: `SELECT ... FROM pending_transactions WHERE status='PENDING' ORDER BY ... LIMIT 10 FOR UPDATE SKIP LOCKED`

تدوم أقفال الصفوف حتى نهاية المعاملة فقط: فعالج الصفوف (واضبط `status = 'DONE'`) في المعاملة **نفسها**، أو علّمها `'CLAIMED'` مع وقت الحجز حتى يمكن التقاط صفوف عامل متعطل من جديد.

## عمليات أرصدة عديمة التكرار

يجب أن يكون كل تغيير على الرصيد عديم التكرار: معالجة الطلب نفسه مرتين يجب أن تنتج الحالة النهائية نفسها كمعالجته مرة واحدة.

### عدم التكرار على مستوى قاعدة البيانات

```sql
CREATE TABLE transactions (
    transaction_id  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,  -- unique constraint = idempotency
    account_id      VARCHAR(100) NOT NULL,
    amount_cents    BIGINT       NOT NULL,
    status          VARCHAR(50)  NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

```sql
-- Claim the key. Returns 1 row inserted for a new request, 0 for a duplicate.
-- Unlike catching a unique-violation error, ON CONFLICT DO NOTHING does not
-- abort the PostgreSQL transaction, so we can still read the original result.
INSERT INTO transactions (idempotency_key, account_id, amount_cents, status)
VALUES (:key, :account, :amount, 'PROCESSING')
ON CONFLICT (idempotency_key) DO NOTHING;
```

على خلاف التقاط خطأ انتهاك القيد الفريد، لا يُجهض `ON CONFLICT DO NOTHING` معاملة PostgreSQL، فنستطيع بعدها قراءة النتيجة الأصلية.

```java
@Transactional
public TransactionResult credit(String accountId, long amountCents, String idempotencyKey) {
    // Claim the idempotency key first — the unique constraint prevents duplicates
    int inserted = transactionRepo.claimIdempotencyKey(idempotencyKey, accountId, amountCents);
    if (inserted == 0) {
        // Duplicate key — return the original result
        return transactionRepo.findByIdempotencyKey(idempotencyKey)
            .map(TransactionResult::fromExisting)
            .orElseThrow();
    }

    Account account = accountRepo.findByIdForUpdate(accountId)
        .orElseThrow(() -> new AccountNotFoundException(accountId));
    account.credit(amountCents);
    transactionRepo.markCompleted(idempotencyKey, account.getBalanceCents());
    return TransactionResult.success(account.getBalanceCents());
}
```

## اختيار الاستراتيجية الصحيحة

```
                    ┌──────────────────────────────────────┐
                    │        Balance Operation              │
                    └──────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
              Single JVM?                        Distributed?
                    │                                   │
        ┌───────────┴───────────┐           ┌──────────┴──────────┐
        │                       │           │                     │
   Temporary?             Persistent?  Low contention?    High contention?
        │                       │           │                     │
  AtomicLong             Database —     Optimistic           Pessimistic
   CAS loop              conditional    @Version +           SELECT FOR
                          UPDATE        retry (3×)           UPDATE + lock
                                                             ordering
```

| السيناريو | الأسلوب الموصى به |
|----------|---------------------|
| تحديد المعدّل، وحصة الجلسة | ‏`AtomicLong` مع CAS في الذاكرة |
| خصم أو إضافة بسيطة لحساب واحد | تحديث شرطي واحد `UPDATE ... WHERE balance_cents >= :amount` |
| حساب عميل تجزئة عادي | قفل متفائل (`@Version`) |
| تاجر يتلقى أكثر من 100 عملية دفع متزامنة | متشائم (`SELECT FOR UPDATE`) |
| تسوية دفعية عبر آلاف الحسابات | طابور عمل بـ `SKIP LOCKED` |
| محفظة موزعة بين خدمات | ‏Saga + عدم تكرار + اتساق نهائي |

## اختبار المعرفة

**س1:** تستخدم القفل المتفائل (`@Version`) على حساب تاجر يتلقى 500 خصم متزامن. وبعد 10 دقائق في الإنتاج تلاحظ أن `ObjectOptimisticLockingFailureException` تغمر السجلات و30% من الخصوم تفشل بعد 3 محاولات. ماذا تفعل؟

**ج:** انتقل إلى القفل المتشائم (`SELECT FOR UPDATE`) للحسابات كثيرة التنافس. فالقفل المتفائل يفترض تعارضات نادرة؛ ومع 500 خصم متزامن تتصادم كل محاولة تقريبًا. وكل تصادم يهدر رحلة معاملة كاملة ثم يعيد المحاولة، فيتضاعف حمل قاعدة البيانات. ومع القفل المتشائم تصطف الخيوط على مستوى قاعدة البيانات وتتقدم بالتتابع — دون محاولات مهدرة.

**س2:** يصل طلب خصم مرتين بمفتاح `idempotencyKey` نفسه خلال 5 ثوانٍ (إعادة محاولة في الشبكة). وقد التزمت خدمة القفل المتشائم بالخصم الأول. ماذا يحدث للثاني؟

**ج:** يُدرج حجز عدم التكرار في بداية المعاملة (`INSERT ... ON CONFLICT DO NOTHING`) صفر صفوف، فتعود الخدمة مبكرًا دون قفل أو خصم. ويبقى الرصيد دون تغيير. وإذا وصل الطلب المكرر بينما الأول ما زال يعمل، ينتظر إدراجه على الفهرس الفريد ثم يُدرج صفر صفوف بعد التزام الأول — فحتى الطلبات المكررة المتزامنة لا تستطيع الخصم مرتين.

## التحدي العملي

صمّم خدمة إدارة أرصدة لمحفظة دفع بالمتطلبات التالية:

1. **حسابات التجزئة قليلة التنافس** (أقل من 10 معاملات متزامنة): استخدم القفل المتفائل مع حتى 3 محاولات، ومعاملة جديدة لكل محاولة، وتراجع أسي 50ms بين المحاولات
2. **حسابات التجار كثيرة التنافس** (معلّمة عبر `account.highContention = true`): استخدم `SELECT FOR UPDATE` المتشائم مع مهلة معاملة 5 ثوانٍ
3. **عدم التكرار**: تتطلب كل عمليات الخصم والإضافة `idempotencyKey` يُحجز أولًا عبر قيد فريد؛ والمفاتيح المكررة تعيد النتيجة الأصلية
4. **التحويل**: تحويل ذري بين الحسابات مع ترتيب أقفال قياسي لمنع الجمود
5. **الاختبار**: اكتب اختبارًا متزامنًا على نمط jcstress بـ 50 خيطًا يخصم كل منها وحدة واحدة من رصيد 50، يؤكد أن الرصيد النهائي 0 بالضبط (لا سحب على المكشوف، ولا تحديثات ضائعة)

قدّم صنف الكيان، وواجهات المستودعات مع تعليقات `@Lock` المناسبة، وصنف الخدمة مع منطق التوجيه، والاختبار المتزامن.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يتلقى حساب تاجر 500 طلب خصم متزامن باستخدام القفل المتفائل (@Version). وبعد 10 دقائق تلاحظ أن 30% من الخصوم تفشل بـ ObjectOptimisticLockingFailureException بعد 3 محاولات. ما الاستجابة الصحيحة؟",
      "options": [
        "زد عدد المحاولات من 3 إلى 10 لتقليل الإخفاقات",
        "انتقل إلى القفل المتشائم (SELECT FOR UPDATE) للحسابات كثيرة التنافس",
        "استخدم رصيد AtomicLong في الذاكرة بدل قفل قاعدة البيانات",
        "أضف نسخًا مقروءة لقاعدة البيانات لتوزيع الحمل"
      ],
      "correct": 1,
      "explanation": "يفترض القفل المتفائل تعارضات نادرة. ومع 500 خصم متزامن على الحساب نفسه تتصادم كل محاولة تقريبًا، فتتسبب إعادة المحاولات في مضاعفة حمل قاعدة البيانات. أما القفل المتشائم (SELECT FOR UPDATE) فيصف المعاملات على مستوى قاعدة البيانات ويعالجها واحدة تلو الأخرى — دون محاولات مهدرة. ولخصم بسيط، يكون تحديث شرطي واحد (WHERE balance_cents >= :amount) أرخص حتى من ذلك."
    },
    {
      "text": "يُرسل طلب خصم بمفتاح idempotencyKey ‏'PAY-001' مرتين خلال 5 ثوانٍ (إعادة محاولة في الشبكة). وقد التُزم الطلب الأول بنجاح. ماذا يحدث للطلب الثاني مع فحص عدم تكرار منفّذ بشكل صحيح؟",
      "options": [
        "يحصل الطلب الثاني على قفل الصف ويعالج الخصم مرة أخرى، فيحدث خصم مزدوج",
        "يُدرج حجز عدم التكرار للطلب الثاني (INSERT ... ON CONFLICT DO NOTHING) صفر صفوف، فيعود مبكرًا دون قفل أو خصم، ويبقى الرصيد دون تغيير",
        "يرمي الطلب الثاني DuplicateKeyException يجب أن يلتقطها المستدعي",
        "يجعل القيد الفريد في قاعدة البيانات الطلب الثاني ينتظر حتى تنتهي صلاحية المعاملة الأولى"
      ],
      "correct": 1,
      "explanation": "يُحجز مفتاح عدم التكرار أولًا بـ INSERT ... ON CONFLICT DO NOTHING مقابل قيد UNIQUE. ففي الطلب المكرر يُدرج صفر صفوف، فتعيد الخدمة النتيجة الأصلية دون قفل أو خصم. ولأن الحارس هو القيد الفريد (لا فحص exists())، فهو يعمل أيضًا عندما يصل الطلبان في اللحظة نفسها: ينتظر الإدراج الثاني المعاملة الأولى ثم لا يُدرج شيئًا."
    },
    {
      "text": "عند تنفيذ تحويل ذري بين حسابين باستخدام القفل المتشائم، لماذا يجب الحصول على أقفال الصفوف بترتيب قياسي (مثل الترتيب المعجمي لمعرّف الحساب)؟",
      "options": [
        "لتحسين أداء استعلام قاعدة البيانات عبر ترتيب الفهارس",
        "لمنع الجمود عندما يقفل تحويلان متزامنان الحسابين نفسيهما بترتيب معاكس",
        "لأن PostgreSQL تتطلب قفل الصفوف بترتيب المفتاح الأساسي",
        "لضمان قفل حساب الخصم دائمًا قبل حساب الإضافة"
      ],
      "correct": 1,
      "explanation": "دون ترتيب أقفال قياسي، قد يقع تحويلان متزامنان (A←B وB←A) في جمود: يقفل التحويل 1 الحساب A وينتظر B، بينما يقفل التحويل 2 الحساب B وينتظر A. وبالقفل دائمًا بترتيب ثابت (مثل الترتيب المعجمي لمعرّف الحساب)، يقفل التحويلان بالترتيب نفسه، فينتظر الثاني اكتمال الأول بدل إنشاء دورة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "خدمة إدارة أرصدة متزامنة",
  "difficulty": "advanced",
  "estimatedMinutes": 75,
  "tasks": [
    {
      "id": "1",
      "description": "نفّذ كيان JPA ‏Account مع @Version للقفل المتفائل، وطريقتي debit() وcredit() مغلفتين تفرضان قواعد العمل (لا سحب على المكشوف، ومبالغ موجبة)، ومستودع AccountRepository فيه findById العادية وطريقة findByIdForUpdate معلّمة بـ @Lock(PESSIMISTIC_WRITE) باستخدام @Query."
    },
    {
      "id": "2",
      "description": "نفّذ OptimisticBalanceService بطريقة debit(accountId, amountCents, idempotencyKey) تشغّل كل محاولة في معاملة جديدة (TransactionTemplate — لا معاملة حول حلقة إعادة المحاولة)، وتعيد المحاولة حتى 3 مرات مع تراجع أسي 50ms عند ObjectOptimisticLockingFailureException، وتحجز مفتاح عدم التكرار بـ INSERT ... ON CONFLICT DO NOTHING داخل كل محاولة. ونفّذ PessimisticBalanceService تستخدم SELECT FOR UPDATE مع عزل READ_COMMITTED ومهلة معاملة 5 ثوانٍ."
    },
    {
      "id": "3",
      "description": "نفّذ BalanceServiceRouter يختار OptimisticBalanceService للحسابات التي فيها account.highContention == false وPessimisticBalanceService للحسابات كثيرة التنافس. ونفّذ طريقة transfer(fromId, toId, amountCents, idempotencyKey) مع ترتيب أقفال قياسي (معجمي حسب معرّف الحساب) لمنع الجمود."
    },
    {
      "id": "4",
      "description": "اكتب اختبار صحة متزامنًا بـ 50 خيطًا يخصم كل منها وحدة واحدة من حساب رصيده الابتدائي 50. وأكّد أن الرصيد النهائي 0 بالضبط (لا سحب على المكشوف، ولا تحديثات ضائعة). واكتب أيضًا اختبارًا لطريقة التحويل يطلق 100 خيط متزامن تجري تحويلات عشوائية بين 10 حسابات، ويؤكد أن مجموع أرصدة كل الحسابات يساوي الإجمالي الابتدائي (ثابت حفظ الأموال)."
    }
  ]
}
-->
