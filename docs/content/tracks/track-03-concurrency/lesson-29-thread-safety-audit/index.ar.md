---
id: track-03-lesson-29
title: "مراجعة أمان الخيوط — على مستوى الصنف والوحدة والتطبيق"
slug: thread-safety-audit
track: track-03
trackName: "هندسة التزامن وأمان الخيوط"
sequence: 29
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [thread-safety, audit, shared-state, concurrent-design, review-checklist]
prerequisites: [track-03-lesson-02, track-03-lesson-07]
---

# تدقيق سلامة الخيوط — على مستوى الصنف والوحدة والتطبيق

أخطاء التزامن أخطر فئة عيوب في أنظمة التقنية المالية. فهي كامنة، وغير حتمية، وشبه غير مرئية في اختبارات الوحدة. وتظهر تحت حمل الإنتاج، غالبًا في أسوأ لحظة ممكنة — أثناء ساعات التداول الذروة، أو تسوية نهاية اليوم، أو موجة مدفوعات الجمعة السوداء. ويقدم هذا الدرس إطار تدقيق منهجيًا وعمليًا يعمل على ثلاثة مستويات من الدقة: الصنف، والوحدة/الخدمة، والتطبيق. ولكل مستوى أنماط فشله، واستراتيجيات اكتشافه، وأنماط معالجته.

## 1. لماذا تهم تدقيقات سلامة الخيوط

### أخطاء التزامن كامنة

قد يعيش خطأ سلامة خيوط في قاعدة الشيفرة أشهرًا أو سنوات قبل أن يظهر. فاختبارات الوحدة تعمل بالتتابع افتراضيًا. ونادرًا ما تحاكي اختبارات التكامل آلاف المستخدمين المتزامنين يضغطون على الحساب نفسه. ومراجعة الشيفرة تلتقط مشكلات الأسلوب والمنطق، لكن المراجع لا يستطيع محاكاة تداخل خمسين خيطًا في ذهنه.

الشروط الكلاسيكية لظهور خطأ تزامن:

- أكثر من خيط يصل إلى الكائن القابل للتغيير نفسه
- خيط واحد على الأقل يكتب فيه
- لا مزامنة تحكم ترتيب الوصول

في التطوير تتعامل خدمتك مع عشرة طلبات في الدقيقة، فلا يظهر الخطأ أبدًا. وفي الإنتاج تتعامل مع عشرة آلاف طلب في الدقيقة، فيقرأ خيطان فجأة رصيد الحساب نفسه في اللحظة نفسها، ويقرر كلاهما أن الرصيد كافٍ، ويخصم كلاهما، فينتهي العميل برصيد سالب — أو الأسوأ، يستغل محتال النافذة للسحب مرتين.

### حوادث تقنية مالية نموذجية سببها فشل سلامة الخيوط

*أمثلة مركّبة، مبنية على أنماط فشل شائعة في الصناعة — لا على شركات بعينها.*

**فساد الأرصدة:** احتفظت بوابة دفع بذاكرة مؤقتة لأرصدة المستخدمين في `HashMap`. واستدعى خيطان `updateBalance()` في الوقت نفسه على مفتاح المستخدم نفسه. وعملية إعادة التحجيم الداخلية في HashMap ليست آمنة للخيوط؛ فأثناءها قد تتكون حلقة لا نهائية في بنية القائمة المترابطة الداخلية، فتستهلك المعالج وتتجمد الخدمة. وحتى قبل إعادة التحجيم، قد يمحو تحديث ضائع زيادة في الرصيد بصمت.

**معالجة معاملات مكررة:** استخدم نظام إدارة طلبات كائنًا وحيدًا `OrderProcessor` بحقل نسخة `private Order currentOrder`. وتحت الحمل المتزامن عيّن الخيط A القيمة `currentOrder = orderA`، ثم عيّن الخيط B ‏`currentOrder = orderB`. ثم عالج الخيط A الطلب `orderB` ببيانات `orderA`. والنتيجة: خُصم orderA ولم يُنفّذ؛ ونُفّذ orderB ولم يُخصم.

**تحديثات ضائعة في التسوية:** حدّثت مهمة تسوية دفعية ومعالج دفعات واردة مدخل دفتر الأستاذ نفسه. فقرأت مهمة التسوية الرصيد، وكتب معالج الدفع رصيدًا جديدًا، ثم كتبت مهمة التسوية رصيدها القديم — فمحت تحديث معالج الدفع. فبدا الحساب وكأنه تلقى دفعة لا تنعكس في رصيده.

**ذاكرة مؤقتة قديمة تؤدي إلى تجاوز الحدود:** خزّنت خدمة كشف احتيال حدود الإنفاق اليومية لكل مستخدم. وسمحت حالة تسابق بين إبطال الذاكرة المؤقتة وفحص الحد لمستخدم بتجاوز حده اليومي بإرسال معاملات متزامنة سريعة، قرأت كل منها الذاكرة قبل أن تطلق أي منها الإبطال.

### التدقيق كنشاط هندسي أساسي

يجب ألا تكون تدقيقات سلامة الخيوط أمرًا ثانويًا. بل يجب أن تكون:

- بوابة رسمية في قائمة مراجعة الشيفرة لأي صنف سيُستخدم في سياق متزامن
- نشاطًا متكررًا عند إدخال مهندسين جدد إلى خدمة قائمة
- خطوة إلزامية قبل أي إعادة هيكلة مهمة لمكونات البنية المشتركة
- موثّقة كجزء من عقد الصنف أو الخدمة (Javadoc ‏`@GuardedBy` و`@ThreadSafe` و`@NotThreadSafe`)

تقابل مستويات التدقيق الثلاثة ثلاثة أسئلة متمايزة:

| المستوى | السؤال |
|---|---|
| الصنف | هل هذا الصنف المنفرد آمن عند الوصول إليه من خيوط متعددة؟ |
| الوحدة/الخدمة | هل هذه الخدمة آمنة عندما تدير حاوية Spring دورة حياتها وتتشاركها خيوط طلبات متعددة؟ |
| التطبيق | هل هذا النظام آمن من حالات التسابق التي تعبر حدود العمليات — قواعد البيانات، والذاكرات المؤقتة، ووسطاء الرسائل؟ |

## 2. المستوى 1: تدقيق على مستوى الصنف

يفحص تدقيق مستوى الصنف صنف Java واحدًا منفردًا. والهدف تحديد هل يمكن استدعاء كل طريقة عامة من خيوط متزامنة متعددة دون نتائج خاطئة.

### السيناريو: حالة مشتركة قابلة للتغيير

**حدد كل حقول النسخة القابلة للتغيير.** فأي حقل نسخة ليس `final` وليس غير قابل للتغيير مرشح لمشكلة سلامة خيوط إذا استُخدم الصنف ككائن وحيد مشترك.

**غير آمن — عدّاد بدائي في حبة وحيدة:**

```java
// UNSAFE: non-atomic increment in a shared singleton
@Component
public class TransactionCounter {

    // Multiple threads will read-modify-write this field concurrently.
    // The ++ operator is NOT atomic: it compiles to a read, an increment, and a write.
    // Under concurrent access, increments are silently lost.
    private int processedCount = 0;

    public void recordTransaction() {
        processedCount++; // RACE CONDITION: lost updates guaranteed under load
    }

    public int getProcessedCount() {
        return processedCount; // May return a stale or inconsistent value
    }
}
```

**آمن — AtomicInteger:**

```java
// SAFE: AtomicInteger provides atomic read-modify-write operations
@Component
public class TransactionCounter {

    private final AtomicInteger processedCount = new AtomicInteger(0);

    public void recordTransaction() {
        processedCount.incrementAndGet(); // Atomic; no lost updates
    }

    public int getProcessedCount() {
        return processedCount.get(); // Always consistent
    }
}
```

**غير آمن — HashMap كذاكرة مؤقتة للأرصدة في كائن وحيد:**

```java
// UNSAFE: HashMap is not thread-safe. Concurrent puts can corrupt internal state.
// Even concurrent reads during a resize can cause infinite loops (Java 7 and below)
// or silent data loss (Java 8+).
@Component
public class BalanceCacheService {

    private final Map<String, BigDecimal> balanceCache = new HashMap<>();

    public BigDecimal getBalance(String accountId) {
        return balanceCache.get(accountId); // UNSAFE under concurrent access
    }

    public void updateBalance(String accountId, BigDecimal balance) {
        balanceCache.put(accountId, balance); // UNSAFE: can corrupt map structure
    }
}
```

**آمن — ConcurrentHashMap:**

```java
// SAFE: ConcurrentHashMap uses segment-level locking (Java 7) or CAS operations
// (Java 8+) to allow safe concurrent reads and writes.
@Component
public class BalanceCacheService {

    private final ConcurrentMap<String, BigDecimal> balanceCache = new ConcurrentHashMap<>();

    public BigDecimal getBalance(String accountId) {
        return balanceCache.get(accountId); // Safe; no locking needed for reads
    }

    public void updateBalance(String accountId, BigDecimal balance) {
        balanceCache.put(accountId, balance); // Safe; atomic put
    }
}
```

### السيناريو: عمليات مركبة غير ذرية

العملية الذرية المنفردة (مثل `ConcurrentHashMap.put`) آمنة للخيوط وحدها، لكن تسلسل عمليتين أو أكثر ذريتين منفردتين **ليس** مضمون الذرية ككل. فالفجوة بين العمليات نافذة تسابق.

**غير آمن — فحص-ثم-تنفيذ مع نافذة تسابق:**

```java
// UNSAFE: containsKey and get are individually safe on ConcurrentHashMap,
// but the check-then-act sequence is not atomic. Another thread can insert
// between containsKey and get, or remove between containsKey and get.
@Component
public class FeeScheduleCache {

    private final ConcurrentMap<String, BigDecimal> feeSchedule = new ConcurrentHashMap<>();

    public BigDecimal getFee(String productCode) {
        // RACE WINDOW: another thread could remove productCode between these two calls
        if (feeSchedule.containsKey(productCode)) {
            return feeSchedule.get(productCode); // May return null despite the check
        }
        return loadFeeFromDatabase(productCode);
    }
}
```

**آمن — تخزين المستقبليات مع putIfAbsent:**

```java
@Component
public class FeeScheduleCache {

    // Cache FUTURES, not values: putIfAbsent is atomic, and the slow database
    // call runs OUTSIDE the map. (Calling the DB inside computeIfAbsent would
    // hold a map bin lock during I/O and block other keys in that bin.)
    private final ConcurrentMap<String, CompletableFuture<BigDecimal>> feeSchedule =
        new ConcurrentHashMap<>();

    public BigDecimal getFee(String productCode) {
        CompletableFuture<BigDecimal> fresh = new CompletableFuture<>();
        CompletableFuture<BigDecimal> existing = feeSchedule.putIfAbsent(productCode, fresh);
        if (existing != null) {
            return existing.join();          // another thread is loading / has loaded it
        }
        try {
            // We won the race: load exactly once per productCode
            BigDecimal fee = loadFeeFromDatabase(productCode);
            fresh.complete(fee);
            return fee;
        } catch (RuntimeException e) {
            feeSchedule.remove(productCode, fresh);   // allow a retry later
            fresh.completeExceptionally(e);
            throw e;
        }
    }

    private BigDecimal loadFeeFromDatabase(String productCode) {
        return feeRepository.findFeeByProductCode(productCode);
    }
}
```

تُخزّن الذاكرة **مستقبليات** لا قيمًا: `putIfAbsent` ذري، واستدعاء قاعدة البيانات البطيء يعمل **خارج** الخريطة. (فاستدعاء قاعدة البيانات داخل `computeIfAbsent` يحتجز قفل حاوية في الخريطة أثناء الإدخال/الإخراج ويحجب مفاتيح أخرى في تلك الحاوية.)

**غير آمن — قراءة-تعديل-كتابة دون مزامنة:**

```java
// UNSAFE: reading balance and writing the updated balance is a compound operation.
// Thread A reads balance = 1000. Thread B reads balance = 1000. Thread A writes 900.
// Thread B writes 900. The first debit is silently lost. Balance should be 800.
public class AccountLedger {

    private BigDecimal balance = BigDecimal.ZERO;

    public void debit(BigDecimal amount) {
        // RACE CONDITION: read-modify-write is not atomic
        balance = balance.subtract(amount);
    }
}
```

**آمن — AtomicReference مع compareAndSet:**

```java
public class AccountLedger {

    private final AtomicReference<BigDecimal> balance =
        new AtomicReference<>(BigDecimal.ZERO);

    public void debit(BigDecimal amount) {
        // CAS loop: retry until we win the compare-and-swap
        BigDecimal current;
        BigDecimal updated;
        do {
            current = balance.get();
            updated = current.subtract(amount);
            if (updated.compareTo(BigDecimal.ZERO) < 0) {
                throw new InsufficientFundsException("Balance would go negative");
            }
        } while (!balance.compareAndSet(current, updated));
        // compareAndSet succeeds only if no other thread modified balance since we read it
    }

    public BigDecimal getBalance() {
        return balance.get();
    }
}
```

### السيناريو: تهيئة كسولة غير آمنة

التهيئة الكسولة لكائن وحيد مصدر متكرر لأخطاء سلامة الخيوط. ونمط القفل مزدوج الفحص الكلاسيكي معطوب دون `volatile`.

**غير آمن — قفل مزدوج الفحص دون volatile:**

```java
// UNSAFE: without volatile, the JVM may reorder the instructions inside the
// constructor. A partially initialized object can be assigned to 'instance'
// before its fields are fully written. A second thread can then read a
// non-null but corrupt 'instance'.
public class PaymentGatewayClient {

    private static PaymentGatewayClient instance; // MISSING volatile

    private final String apiKey;
    private final HttpClient httpClient;

    private PaymentGatewayClient() {
        this.apiKey = ConfigLoader.getApiKey();
        this.httpClient = HttpClient.newHttpClient(); // May not be visible to other threads
    }

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {                      // Check 1 (no lock)
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {              // Check 2 (with lock)
                    instance = new PaymentGatewayClient(); // UNSAFE: partial init visible
                }
            }
        }
        return instance; // May return partially constructed object
    }
}
```

**آمن — قفل مزدوج الفحص مع volatile:**

```java
public class PaymentGatewayClient {

    // volatile ensures that the write to 'instance' happens-before any read of it.
    // This prevents the partial initialization visibility problem.
    private static volatile PaymentGatewayClient instance;

    private final String apiKey;
    private final HttpClient httpClient;

    private PaymentGatewayClient() {
        this.apiKey = ConfigLoader.getApiKey();
        this.httpClient = HttpClient.newHttpClient();
    }

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {
                    instance = new PaymentGatewayClient(); // Safe: volatile write
                }
            }
        }
        return instance;
    }
}
```

**الأفضل — أسلوب الصنف الحامل للتهيئة عند الطلب (مفضّل):**

```java
// The JVM guarantees that the static initializer of a nested class runs
// exactly once, under the class initialization lock, the first time the
// class is used.
// This is simpler, safer, and performs as well as double-checked locking.
public class PaymentGatewayClient {

    private PaymentGatewayClient() {
        // private constructor
    }

    // The JVM loads this class only when getInstance() is first called.
    // Class loading is inherently thread-safe.
    private static final class Holder {
        static final PaymentGatewayClient INSTANCE = new PaymentGatewayClient();
    }

    public static PaymentGatewayClient getInstance() {
        return Holder.INSTANCE; // No synchronization needed here
    }
}
```

### السيناريو: كائن قابل للتغيير يُعاد من دالة قراءة

إعادة مرجع إلى مجموعة داخلية قابلة للتغيير من دالة قراءة يسرّب الحالة الداخلية. فيستطيع أي مستدعٍ تعديل المجموعة دون علم الصنف، ربما بينما يمر عليها خيط آخر.

**غير آمن — إعادة القائمة الداخلية الحية:**

```java
@Component
public class PendingPaymentRegistry {

    // This list is the internal state of the registry
    private final List<Payment> pendingPayments = new ArrayList<>();

    public void register(Payment payment) {
        pendingPayments.add(payment);
    }

    // UNSAFE: caller receives a reference to the actual internal list.
    // Caller can call .clear(), .add(), .remove(), or iterate while
    // another thread is modifying it — causing ConcurrentModificationException
    // or silent data loss.
    public List<Payment> getPendingPayments() {
        return pendingPayments;
    }
}
```

**آمن — أعد عرضًا غير قابل للتعديل أو نسخة دفاعية:**

```java
@Component
public class PendingPaymentRegistry {

    private final List<Payment> pendingPayments =
        Collections.synchronizedList(new ArrayList<>());

    public void register(Payment payment) {
        pendingPayments.add(payment);
    }

    // Option 1: unmodifiable view — prevents writes but still a live view
    // (callers must still synchronize on the list while iterating it)
    public List<Payment> getPendingPayments() {
        return Collections.unmodifiableList(pendingPayments);
    }

    // Option 2: defensive copy — snapshot at the time of the call (preferred for safety)
    public List<Payment> getPendingPaymentsSnapshot() {
        synchronized (pendingPayments) {
            return new ArrayList<>(pendingPayments);
        }
    }
}
```

العرض غير القابل للتعديل يمنع الكتابة لكنه ما زال عرضًا حيًا (فيجب على المستدعين المزامنة على القائمة أثناء المرور عليها). والنسخة الدفاعية لقطة وقت الاستدعاء — وهي المفضلة للأمان.

### السيناريو: تسرب `this` في المُنشئ

نشر مرجع `this` قبل اكتمال المُنشئ يسمح لخيوط أخرى برؤية كائن مبني جزئيًا.

**غير آمن — تسرب `this` عبر تسجيل مستمع:**

```java
// UNSAFE: registering 'this' in the constructor publishes the reference
// before the constructor finishes. If the EventBus delivers an event to
// onPaymentEvent() before the constructor sets this.processorId, the handler
// reads a null processorId.
public class PaymentEventHandler {

    private final String processorId;

    public PaymentEventHandler(EventBus bus) {
        bus.register(this); // 'this' escapes before processorId is set
        this.processorId = UUID.randomUUID().toString(); // Too late!
    }

    public void onPaymentEvent(PaymentEvent event) {
        // processorId may be null here if an event was delivered during construction
        log.info("Processor {} handling event {}", processorId, event.getId());
    }
}
```

**آمن — نمط طريقة المصنع:**

```java
public class PaymentEventHandler {

    private final String processorId;
    private final EventBus bus;

    // Private constructor: does not publish 'this'
    private PaymentEventHandler(EventBus bus) {
        this.processorId = UUID.randomUUID().toString();
        this.bus = bus;
        // 'this' is NOT published here; all fields are fully initialized
    }

    // Factory method: registers only after the object is fully constructed
    public static PaymentEventHandler create(EventBus bus) {
        PaymentEventHandler handler = new PaymentEventHandler(bus);
        bus.register(handler); // Safe: handler is fully initialized
        return handler;
    }

    public void onPaymentEvent(PaymentEvent event) {
        log.info("Processor {} handling event {}", processorId, event.getId());
    }
}
```

### قائمة تدقيق مستوى الصنف

- [ ] **حدد كل حقول النسخة غير النهائية.** فكل منها مرشح لمشكلة سلامة خيوط إذا استُخدم الصنف ككائن وحيد مشترك.
- [ ] **افحص الرؤية لكل حقل قابل للتغيير.** هل كل كتابة تحدث-قبل كل قراءة لاحقة؟ إن لم يكن كذلك فيلزم `volatile` أو مزامنة.
- [ ] **للعدّادات الرقمية استخدم AtomicInteger / AtomicLong.** لا تستخدم أبدًا `++` أو `+= N` على `int` أو `long` عادي في صنف مشترك.
- [ ] **لحقول المراجع التي تُبدّل، استخدم `volatile` أو `AtomicReference`.** كتابة المرجع ذرية دائمًا (فقط كتابات `long`/`double` غير volatile قد تنقسم)، لكن دون `volatile` قد لا تراها الخيوط الأخرى — والتبديل المشروط يحتاج CAS.
- [ ] **استبدل HashMap/HashSet/ArrayList في الكائنات الوحيدة ببدائل آمنة للخيوط.** استخدم `ConcurrentHashMap` أو `CopyOnWriteArrayList` أو زامن صراحة.
- [ ] **حدد كل العمليات المركبة (فحص-ثم-تنفيذ، وقراءة-تعديل-كتابة، والمرور-مع-التعديل).** فكل منها يجب أن تُنفّذ كعملية ذرية واحدة أو تحت قفل.
- [ ] **دقّق كل تهيئة كسولة.** استخدم القفل مزدوج الفحص مع `volatile` أو أسلوب الصنف الحامل؛ ولا تستخدم أبدًا القفل مزدوج الفحص العادي.
- [ ] **دقّق كل دوال القراءة التي تعيد كائنات قابلة للتغيير.** أعد عروضًا غير قابلة للتعديل أو نسخًا دفاعية بدل المراجع الداخلية.
- [ ] **افحص كل المُنشئات بحثًا عن تسرب `this`.** فإذا وجب نشر `this` قبل اكتمال المُنشئ، فاستخدم طريقة مصنع بدلًا من ذلك.
- [ ] **افحص `synchronized` على الكائن الخطأ.** ‏`synchronized (this)` صحيح فقط إذا زامن المستدعون أيضًا على النسخة نفسها؛ و`synchronized` على متغير محلي خطأ دائمًا.
- [ ] **علّم الصنف بـ `@ThreadSafe` أو `@NotThreadSafe` أو `@Immutable`.** واجعل عقد سلامة الخيوط صريحًا في Javadoc.
- [ ] **تحقق من وجود تعليقات `@GuardedBy` على كل حقل يتطلب قفلًا.** يفرضها فحص `GuardedBy` في Error Prone وقت الترجمة؛ ويكشف SpotBugs المزامنة غير المتسقة.

## 3. المستوى 2: تدقيق على مستوى الوحدة / الخدمة

يفحص تدقيق مستوى الوحدة كيف تتفاعل حبة يديرها Spring مع دورة حياتها ومع خيوط الطلبات المتزامنة. فينشئ Spring نسخة واحدة من كل حبة `@Service` و`@Component` و`@Repository` ويتشاركها بين كل خيوط الطلبات. فأي حقل نسخة في هذه الحبوب حالة مشتركة.

### السيناريو: حبوب Spring ذات حالة

**غير آمن — حالة كل طلب مخزنة في حقل نسخة:**

```java
// UNSAFE: Spring creates one instance of PaymentProcessingService.
// All request threads share this single instance.
// Thread A sets currentPayment = paymentA, then Thread B sets currentPayment = paymentB.
// Thread A then calls processCurrentPayment() and processes paymentB with paymentA's context.
// This is a classic data contamination bug.
@Service
public class PaymentProcessingService {

    // UNSAFE: this field is shared across all concurrent request threads
    private Payment currentPayment;
    private String currentCorrelationId;

    public PaymentResult process(Payment payment, String correlationId) {
        this.currentPayment = payment;              // Thread A writes paymentA
        this.currentCorrelationId = correlationId; // Thread B may overwrite before A reads

        validatePayment();     // Uses this.currentPayment — may be wrong thread's payment
        enrichPayment();       // Uses this.currentPayment — same problem
        return submitPayment(); // Uses this.currentPayment — submits wrong payment
    }

    private void validatePayment() {
        validator.validate(currentPayment); // Which thread's payment is this?
    }
}
```

**آمن — مرر الحالة كمعاملات للطرق:**

```java
// SAFE: no instance fields hold per-request state.
// All state is passed explicitly through the call stack.
// Spring can safely share this instance across all threads.
@Service
public class PaymentProcessingService {

    // Only stateless collaborators as fields — these are themselves thread-safe
    private final PaymentValidator validator;
    private final PaymentEnricher enricher;
    private final PaymentGatewayClient gatewayClient;

    public PaymentProcessingService(PaymentValidator validator,
                                    PaymentEnricher enricher,
                                    PaymentGatewayClient gatewayClient) {
        this.validator = validator;
        this.enricher = enricher;
        this.gatewayClient = gatewayClient;
    }

    public PaymentResult process(Payment payment, String correlationId) {
        validatePayment(payment);           // payment is local to this invocation
        Payment enriched = enrichPayment(payment, correlationId);
        return submitPayment(enriched, correlationId);
    }

    private void validatePayment(Payment payment) {
        validator.validate(payment); // No shared state touched
    }
}
```

### السيناريو: تسربات ThreadLocal

‏`ThreadLocal` أداة مشروعة لعزل الحالة لكل خيط، لكن يجب تنظيفها. ففي بيئة مجمّع الخيوط (التي تستخدمها كل خوادم التطبيقات) يُعاد استخدام الخيوط عبر الطلبات. فقيمة `ThreadLocal` عُيّنت أثناء الطلب N ستبقى موجودة أثناء الطلب N+1 على الخيط نفسه.

**غير آمن — ThreadLocal دون تنظيف:**

```java
// UNSAFE: if the thread is returned to the pool without cleanup,
// the next request on this thread will find the previous request's
// correlationId in the ThreadLocal — leading to logging under the wrong
// correlation ID or, worse, using stale state for business logic.
@Component
public class CorrelationContext {

    private static final ThreadLocal<String> CORRELATION_ID = new ThreadLocal<>();

    public void set(String correlationId) {
        CORRELATION_ID.set(correlationId);
    }

    public String get() {
        return CORRELATION_ID.get();
    }

    // remove() exists but is never called — LEAK
}
```

**آمن — ThreadLocal مع تنظيف مضمون في كتلة finally:**

```java
@Component
public class CorrelationContext {

    private static final ThreadLocal<String> CORRELATION_ID = new ThreadLocal<>();

    public void set(String correlationId) {
        CORRELATION_ID.set(correlationId);
    }

    public String get() {
        return CORRELATION_ID.get();
    }

    public void clear() {
        CORRELATION_ID.remove(); // Must be called remove(), not set(null)
    }
}

// In a servlet filter or request interceptor:
@Component
public class CorrelationFilter implements Filter {

    private final CorrelationContext context;

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {

        String correlationId = UUID.randomUUID().toString();
        context.set(correlationId);
        try {
            chain.doFilter(req, res);
        } finally {
            context.clear(); // Always executed, even if the request throws
        }
    }
}
```

### السيناريو: ذاكرة مؤقتة مشتركة مع إبطال متزامن

قراءة الذاكرة المؤقتة يليها قرار منطق عمل يليه إبطال الذاكرة عملية مركبة. فقد يتداخل أي جزء منها مع التسلسل المطابق لخيط آخر.

**غير آمن — تسابق بين الإبطال والقراءة:**

```java
// UNSAFE: Thread A reads limit = 5000. Thread B also reads limit = 5000.
// Thread A processes payment of 4000 and invalidates cache (new limit = 1000).
// Thread B, having already read limit = 5000, also processes payment of 4000.
// Both pass the limit check. Combined spending = 8000, which exceeds the 5000 limit.
@Service
public class PaymentLimitService {

    private final Map<String, BigDecimal> limitCache = new ConcurrentHashMap<>();

    public boolean canProcess(String userId, BigDecimal amount) {
        BigDecimal currentLimit = limitCache.get(userId); // Read
        if (currentLimit == null) {
            currentLimit = loadLimitFromDb(userId);
            limitCache.put(userId, currentLimit);
        }
        return amount.compareTo(currentLimit) <= 0; // Check — RACE WINDOW BEFORE NEXT LINE
    }

    public void recordPayment(String userId, BigDecimal amount) {
        // Between canProcess and here, another thread may have also passed the check
        limitCache.remove(userId); // Invalidate — too late
    }
}
```

**آمن — ReadWriteLock للوصول المنسق إلى الذاكرة المؤقتة:**

```java
@Service
public class PaymentLimitService {

    // NOTE: a JVM lock protects ONE instance only. With several instances,
    // the remaining limit must be checked-and-reserved atomically in a shared
    // store (database conditional UPDATE or a Redis script — see Level 3)
    private final Map<String, BigDecimal> limitCache = new HashMap<>();
    private final ReadWriteLock lock = new ReentrantReadWriteLock();

    public boolean canProcessAndReserve(String userId, BigDecimal amount) {
        // Load OUTSIDE the lock — never hold a lock during a database call
        BigDecimal loaded = limitCache.containsKey(userId) ? null : loadLimitFromDb(userId);

        lock.writeLock().lock(); // Exclusive lock: no other thread can read or write
        try {
            BigDecimal currentLimit = limitCache.get(userId);
            if (currentLimit == null) {
                currentLimit = (loaded != null) ? loaded : loadLimitFromDb(userId);
                limitCache.put(userId, currentLimit);
            }
            if (amount.compareTo(currentLimit) > 0) {
                return false;
            }
            // Check and reserve happen under the same lock: no race window
            limitCache.put(userId, currentLimit.subtract(amount));
            return true;
        } finally {
            lock.writeLock().unlock();
        }
    }

    /** Remaining limit if cached, otherwise null (the caller loads it). */
    public BigDecimal getCurrentLimit(String userId) {
        lock.readLock().lock(); // Shared lock: multiple readers allowed concurrently
        try {
            return limitCache.get(userId);
        } finally {
            lock.readLock().unlock();
        }
    }

    public void invalidateLimit(String userId) {
        lock.writeLock().lock();
        try {
            limitCache.remove(userId);
        } finally {
            lock.writeLock().unlock();
        }
    }
}
```

يحدث الفحص والحجز تحت القفل نفسه: لا نافذة تسابق. ويُحمّل الحد من قاعدة البيانات **خارج** القفل — فلا تحتجز قفلًا أبدًا أثناء استدعاء قاعدة بيانات. ولاحظ أن قفل JVM يحمي نسخة **واحدة** فقط: فمع عدة نسخ يجب فحص الحد المتبقي وحجزه ذريًا في مخزن مشترك (تحديث شرطي في قاعدة البيانات أو سكربت Redis — انظر المستوى 3).

### السيناريو: سلامة خيوط مجمّع الاتصالات

اتصالات JDBC ذات حالة وغير آمنة للخيوط. فالاتصال يحمل حالة المعاملة، وموضع المؤشر، وإعدادات الالتزام التلقائي. ومشاركة اتصال واحد بين الخيوط تفسد كل ذلك.

**غير آمن — نسخة اتصال مشتركة:**

```java
// UNSAFE: one Connection shared across all threads.
// Thread A begins a transaction. Thread B commits it accidentally.
// Thread A's ResultSet is closed by Thread B's query.
// Thread safety contract of java.sql.Connection: "A Connection object is NOT thread-safe."
@Repository
public class PaymentRepository {

    // UNSAFE: single connection shared across all concurrent threads
    private final Connection sharedConnection;

    public PaymentRepository(DataSource dataSource) throws SQLException {
        this.sharedConnection = dataSource.getConnection(); // Never do this
    }

    public Payment findById(String id) throws SQLException {
        PreparedStatement ps = sharedConnection.prepareStatement(
            "SELECT * FROM payments WHERE id = ?"); // Shared state corruption
        ps.setString(1, id);
        return mapResult(ps.executeQuery());
    }
}
```

**آمن — اتصال يُحصل عليه لكل عملية من المجمّع:**

```java
// SAFE: each operation acquires its own connection from the pool,
// uses it, and returns it. HikariCP and similar pools are designed for this.
@Repository
public class PaymentRepository {

    private final DataSource dataSource; // DataSource is thread-safe; Connection is not

    public PaymentRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public Payment findById(String id) throws SQLException {
        // try-with-resources ensures connection is returned to pool even on exception
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(
                 "SELECT * FROM payments WHERE id = ?")) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? mapResult(rs) : null;
            }
        }
    }
}
```

### السيناريو: طرق خدمة غير متزامنة/متعددة الخيوط

يجعل `@Async` في Spring الطريقة تعمل على خيط منفصل عن المستدعي. فإذا وصلت الطريقة غير المتزامنة إلى حالة مشتركة أو عدّلتها، يجب مزامنة تلك الحالة صراحة.

**غير آمن — طريقة `@Async` تعدّل حالة مشتركة:**

```java
// UNSAFE: notificationsSent is a plain list in a singleton bean.
// @Async causes sendNotification() to run on a different thread.
// Multiple concurrent async calls all add to the same unsynchronized list.
@Service
public class NotificationService {

    private final List<String> notificationsSent = new ArrayList<>(); // UNSAFE

    @Async
    public void sendNotification(String userId, String message) {
        emailClient.send(userId, message);
        notificationsSent.add(userId); // ConcurrentModificationException or lost update
    }

    public List<String> getSentNotifications() {
        return notificationsSent; // Returns a live unsynchronized list
    }
}
```

**آمن — طريقة غير متزامنة بلا حالة، والحالة مخزنة في بنى آمنة للخيوط:**

```java
@Service
public class NotificationService {

    // CopyOnWriteArrayList: thread-safe, good for read-heavy, infrequent-write patterns
    private final List<String> notificationsSent = new CopyOnWriteArrayList<>();

    @Async
    public void sendNotification(String userId, String message) {
        // All inputs arrive as parameters — no shared mutable state read here
        emailClient.send(userId, message);
        notificationsSent.add(userId); // Thread-safe add
    }

    public List<String> getSentNotifications() {
        return Collections.unmodifiableList(notificationsSent);
    }
}
```

### قائمة تدقيق مستوى الوحدة

- [ ] **افحص كل `@Service` و`@Component` و`@Repository` و`@Controller` بحثًا عن حقول نسخة قابلة للتغيير.** يجب ألا يوجد أي منها؛ وكل الحالة يجب أن تمر عبر معاملات الطرق.
- [ ] **تحقق من أن كل الحبوب المتعاونة المحقونة في الكائنات الوحيدة آمنة للخيوط بنفسها.** فإذا كانت اعتمادية بنطاق `@Scope("prototype")`، فليس آمنًا حملها كحقل في كائن وحيد.
- [ ] **دقّق كل استخدام لـ `ThreadLocal`.** وتأكد من استدعاء `remove()` في كتلة `finally` في نهاية دورة حياة كل طلب.
- [ ] **حدد كل تسلسل قراءة-ثم-تنفيذ على الذاكرة المؤقتة.** فإذا لم يُنفّذ الفحص والتنفيذ تحت القفل نفسه، فالتسلسل حالة تسابق.
- [ ] **تأكد من أن اتصالات JDBC لا تُخزن أبدًا كحقول نسخة أو حقول ساكنة.** يجب الحصول على الاتصالات لكل عملية من `DataSource`.
- [ ] **دقّق كل طرق `@Async`.** يجب أن تكون بلا حالة (كل الحالة تمر كمعاملات) أو لا تصل إلا إلى حالة مشتركة آمنة للخيوط.
- [ ] **افحص حبوب `@Scope("session")` أو `@Scope("request")` المحقونة في كائنات وحيدة.** فهذا يتطلب وكلاء نطاق (`@Scope(proxyMode = ScopedProxyMode.TARGET_CLASS)`) وإلا ستتشارك الحقن الحالة بصمت.
- [ ] **راجع كل الحقول `static`.** فالحقول الساكنة مشتركة بين كل النسخ وكل الخيوط في JVM. وكل منها يجب أن يكون غير قابل للتغيير أو متزامنًا صراحة.
- [ ] **تحقق من أن الحبوب بنطاق prototype يُحصل عليها عبر `ApplicationContext.getBean()` أو حقن `@Lookup`، لا كحقل.** فحبة prototype المحقونة كحقل تُنشأ مرة واحدة وتُشارك — فيضيع غرضها.
- [ ] **افحص كل مستمعي الأحداث (`@EventListener` و`ApplicationListener`).** فهم يعملون على خيط الناشر افتراضيًا. وأي حالة مشتركة يصلون إليها يجب أن تكون آمنة للخيوط.

## 4. المستوى 3: تدقيق على مستوى التطبيق

حالات التسابق على مستوى التطبيق الأخطر لأنها لا تُصلح بأدوات مزامنة Java. فهي تشمل عمليات JVM متعددة، ومعاملات قواعد بيانات، ومكونات أنظمة موزعة. وأقفال Java تحمي ذاكرة الكومة المشتركة داخل JVM واحدة؛ ولا تحمي من حالات التسابق العابرة لحدود العمليات.

### السيناريو: حالات تسابق على مستوى قاعدة البيانات (TOCTOU)

حالات تسابق "وقت الفحص إلى وقت الاستخدام" (TOCTOU) متوطنة في التقنية المالية. والنمط الكلاسيكي: فحص شرط في عبارة SQL، ثم التنفيذ بناءً عليه في عبارة أخرى. وبين العبارتين تغيّر معاملة أخرى البيانات.

**غير آمن — SELECT ثم UPDATE مشروط:**

```java
// UNSAFE: SELECT and UPDATE are two separate database round-trips.
// Between them, another transaction (from another application instance,
// another thread, or a background job) can modify the balance.
// Two concurrent threads both read balance = 1000, both pass the >= 500 check,
// both debit 500, resulting in balance = 0 instead of the correct rejection of the second.
@Service
public class FundsTransferService {

    @Transactional
    public void debit(String accountId, BigDecimal amount) {
        BigDecimal balance = accountRepository.findBalance(accountId); // SELECT
        if (balance.compareTo(amount) < 0) {
            throw new InsufficientFundsException();
        }
        // RACE WINDOW: another transaction can debit here before we do
        accountRepository.updateBalance(accountId, balance.subtract(amount)); // UPDATE
    }
}
```

**آمن (الأبسط) — تحديث شرطي واحد:** `UPDATE accounts SET balance = balance - :amount WHERE id = :id AND balance >= :amount` — تحديث صفر صفوف يعني رصيدًا غير كافٍ. فالفحص والتغيير عبارة ذرية واحدة.

**آمن — SELECT FOR UPDATE (القفل المتشائم):**

```java
@Service
public class FundsTransferService {

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void debit(String accountId, BigDecimal amount) {
        // SELECT FOR UPDATE acquires a row-level exclusive lock.
        // All other transactions attempting to SELECT FOR UPDATE on this row
        // will block until this transaction commits or rolls back.
        // This eliminates the TOCTOU race.
        Account account = accountRepository.findByIdForUpdate(accountId); // SELECT FOR UPDATE

        if (account.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException();
        }
        account.setBalance(account.getBalance().subtract(amount));
        accountRepository.save(account); // UPDATE within the same transaction
    }
}

// In the repository:
@Repository
public interface AccountRepository extends JpaRepository<Account, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.id = :id")
    Optional<Account> findByIdForUpdate(@Param("id") String id);
}
```

**آمن — القفل المتفائل مع `@Version`:**

```java
// Optimistic locking is better for low-contention scenarios.
// @Version adds a version column. Hibernate automatically appends
// WHERE version = :expectedVersion to every UPDATE.
// If the version has changed, the commit fails with Spring's
// ObjectOptimisticLockingFailureException.
@Entity
public class Account {

    @Id
    private String id;

    private BigDecimal balance;

    @Version
    private Long version; // Hibernate manages this automatically
}

// The RETRY must sit OUTSIDE the transaction: the conflict is detected at
// commit, and each attempt needs a fresh transaction that reloads the row.
// So put @Retryable on a different bean that calls the @Transactional one.
@Service
public class FundsTransferFacade {

    private final FundsTransferService service;

    @Retryable(retryFor = ObjectOptimisticLockingFailureException.class,
               maxAttempts = 3, backoff = @Backoff(delay = 20, multiplier = 2))
    public void debit(String accountId, BigDecimal amount) {
        service.debit(accountId, amount);   // new transaction per attempt
    }
}

@Service
public class FundsTransferService {

    @Transactional
    public void debit(String accountId, BigDecimal amount) {
        Account account = accountRepository.findById(accountId)
            .orElseThrow(AccountNotFoundException::new);

        if (account.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException();
        }
        account.setBalance(account.getBalance().subtract(amount));
        // Hibernate at commit: UPDATE accounts SET balance=?, version=version+1
        //                      WHERE id=? AND version=?
        // 0 rows updated → ObjectOptimisticLockingFailureException → facade retries
    }
}
```

يجب أن تكون إعادة المحاولة **خارج** المعاملة: فالتعارض يُكتشف عند الالتزام، وكل محاولة تحتاج معاملة جديدة تعيد تحميل الصف. لذا ضع `@Retryable` على حبة أخرى تستدعي الحبة المعلّمة بـ `@Transactional`.

### السيناريو: عدم اتساق الذاكرة المؤقتة الموزعة

عندما تتشارك عدة نسخ تطبيق ذاكرة مؤقتة موزعة (Redis، وMemcached)، قد يسمح تسابق القراءة القديمة لعدة نسخ بأن تستنتج في الوقت نفسه أن الإجراء نفسه آمن التنفيذ.

**غير آمن — عدة نسخ، قراءة ذاكرة قديمة:**

```java
// UNSAFE: Instance A reads daily_spend[userId] = 4500 from Redis.
// Instance B also reads daily_spend[userId] = 4500 from Redis.
// Instance A approves a 400-unit transaction (4500 + 400 = 4900 < 5000 limit).
// Instance B also approves a 400-unit transaction (4500 + 400 = 4900 < 5000 limit).
// Both write 4900 to Redis. The user has actually spent 5300, exceeding the 5000 limit.
@Service
public class DailySpendingLimitService {

    private final RedisTemplate<String, BigDecimal> redis;

    public boolean approveTransaction(String userId, BigDecimal amount) {
        BigDecimal dailySpend = redis.opsForValue().get("daily_spend:" + userId);
        BigDecimal limit = BigDecimal.valueOf(5000);
        if (dailySpend == null) dailySpend = BigDecimal.ZERO;

        if (dailySpend.add(amount).compareTo(limit) > 0) {
            return false; // TOCTOU: stale read; another instance may also be checking
        }
        redis.opsForValue().set("daily_spend:" + userId, dailySpend.add(amount));
        return true;
    }
}
```

**آمن — فحص وإضافة ذريان واحدان على خادم Redis:**

ينفّذ Redis سكربت Lua كخطوة ذرية واحدة، فلا يمكن أن يتداخل الفحص والزيادة مع نسخة أخرى. وتُخزن المبالغ بوحدات صغرى صحيحة (سنتات) ليعمل `INCRBY`. (وقفل موزع حول GET وSET منفصلين سيعمل أيضًا، لكنه يضيف مخاطر انتهاء صلاحية القفل ورحلة إضافية.)

```java
@Service
public class DailySpendingLimitService {

    private final StringRedisTemplate redis;

    // Returns the new total, or -1 if the limit would be exceeded
    private static final RedisScript<Long> CHECK_AND_ADD = RedisScript.of("""
        local spent  = tonumber(redis.call('GET', KEYS[1]) or '0')
        local amount = tonumber(ARGV[1])
        local limit  = tonumber(ARGV[2])
        if spent + amount > limit then
            return -1
        end
        local total = redis.call('INCRBY', KEYS[1], amount)
        if redis.call('TTL', KEYS[1]) < 0 then
            redis.call('EXPIRE', KEYS[1], ARGV[3])   -- reset after the day ends
        end
        return total
        """, Long.class);

    public boolean approveTransaction(String userId, long amountCents) {
        Long result = redis.execute(CHECK_AND_ADD,
            List.of("daily_spend:" + userId),
            String.valueOf(amountCents),
            String.valueOf(500_000L),          // limit: 5,000.00 in cents
            String.valueOf(secondsUntilMidnight()));
        return result != null && result >= 0;
        // If the payment later FAILS, release the amount (DECRBY) — the
        // reservation must not stay counted against the limit
    }
}
```

إذا **فشل** الدفع لاحقًا، فحرّر المبلغ (`DECRBY`) — فيجب ألا يبقى الحجز محسوبًا على الحد.

### السيناريو: توازي مستهلكي Kafka

يضمن Kafka التسليم المرتب داخل القسم. فإذا عالجت رسائل من القسم نفسه في عدة خيوط متزامنة، تكسر ضمان الترتيب وتُدخل حالات تسابق على الحالة المشتركة المفتاحها الكيان نفسه.

**غير آمن — معالجة متزامنة للقسم نفسه:**

```java
// UNSAFE: a custom ExecutorService dispatches messages from the same partition
// to multiple threads. Two messages for account "ACC-123" may be processed
// concurrently, with the second message's debit applied before the first's credit.
// (It also commits offsets for messages that are still being processed.)
@Component
public class PaymentEventConsumer {

    private final ExecutorService executor = Executors.newFixedThreadPool(10);

    @KafkaListener(topics = "payment-events")
    public void onMessage(ConsumerRecord<String, PaymentEvent> record) {
        // UNSAFE: message for key "ACC-123" can be on this thread while another
        // "ACC-123" message is on a different thread in the pool
        executor.submit(() -> processEvent(record.value()));
    }
}
```

**آمن — خيط واحد لكل قسم، ومعالجة تتابعية داخل القسم:**

```java
// SAFE: Kafka's default behavior — one consumer thread per partition.
// All messages for a given account key are routed to the same partition
// (by key hash), so they are always processed sequentially.
// No external synchronization needed for per-account state.
@Component
public class PaymentEventConsumer {

    private final PaymentEventProcessor processor;

    @KafkaListener(
        topics = "payment-events",
        concurrency = "3" // 3 threads, each assigned its own partitions
    )
    public void onMessage(ConsumerRecord<String, PaymentEvent> record) {
        // This method is called sequentially within a partition.
        // Events for the same account key (routed to the same partition) are ordered.
        processor.processEvent(record.value());
    }
}
```

### السيناريو: تعارض المجدول وخادم التطبيق

قد تحاول مهمة `@Scheduled` ومعالج طلبات HTTP تعديل التجميع نفسه (مثل دفعة تسوية) في الوقت نفسه. ولا تستطيع أقفال Java المساعدة هنا إذا عمل التطبيق على عدة عقد.

**غير آمن — تعارض المجدول ومعالج الطلبات:**

```java
// UNSAFE: in a multi-instance deployment, all instances run the @Scheduled job.
// Two instances simultaneously run the settlement job. They both read the same
// unsettled payments. They both process them. Payments are settled twice.
@Service
public class SettlementService {

    @Scheduled(cron = "0 0 1 * * *") // 1 AM daily
    public void runDailySettlement() {
        List<Payment> unsettled = paymentRepository.findUnsettled();
        for (Payment p : unsettled) {
            settle(p); // Multiple instances execute this simultaneously
        }
    }
}
```

**آمن — قفل موزع على المجدول:**

```java
@Service
public class SettlementService {

    private final RedissonClient redisson;

    @Scheduled(cron = "0 0 1 * * *")
    public void runDailySettlement() {
        RLock lock = redisson.getLock("settlement_job_lock");
        // tryLock with 0 wait: if another instance already holds the lock, skip
        if (!lock.tryLock()) {
            log.info("Settlement job already running on another instance. Skipping.");
            return;
        }
        try {
            List<Payment> unsettled = paymentRepository.findUnsettled();
            for (Payment p : unsettled) {
                // Defence in depth: a distributed lock can be lost (network
                // partition, long GC pause). Make each settlement idempotent by
                // claiming the row: UPDATE payments SET status='SETTLING'
                // WHERE id=? AND status='UNSETTLED' — skip it if 0 rows
                settle(p);
            }
        } finally {
            lock.unlock();
        }
    }
}
```

دفاع متعمق: قد يُفقد القفل الموزع (انقسام شبكة، أو توقف GC طويل). فاجعل كل تسوية عديمة التكرار بحجز الصف: `UPDATE payments SET status='SETTLING' WHERE id=? AND status='UNSETTLED'` — وتخطّه إذا أعاد صفر صفوف.

### السيناريو: مشاركة جلسة HTTP ذات حالة

قد يصل طلبان متزامنان من المستخدم نفسه إلى جلسات HTTP (تبويبات المتصفح، واستدعاءات AJAX المتوازية). وتخزين حالة عمل قابلة للتغيير في `HttpSession` دون مزامنة خطأ سلامة خيوط.

**غير آمن — وصول متزامن إلى الجلسة دون مزامنة:**

```java
// UNSAFE: two concurrent AJAX calls from the same browser session both
// call this endpoint. Both read pendingAmount, both check it, both modify it.
// The result is unpredictable.
@RestController
public class CheckoutController {

    @PostMapping("/checkout/add-item")
    public ResponseEntity<Void> addItem(HttpSession session, @RequestBody Item item) {
        BigDecimal pendingAmount = (BigDecimal) session.getAttribute("pendingAmount");
        if (pendingAmount == null) pendingAmount = BigDecimal.ZERO;
        // RACE: another request may also be adding an item at the same time
        session.setAttribute("pendingAmount", pendingAmount.add(item.getPrice()));
        return ResponseEntity.ok().build();
    }
}
```

**آمن — تصميم بلا حالة مع سلة على الخادم مخزنة في قاعدة بيانات:**

```java
// SAFE: session stores only an immutable cart ID. All cart state lives in the
// database, protected by optimistic locking. No mutable state in the session.
@RestController
public class CheckoutController {

    private final CartService cartService;

    @PostMapping("/checkout/add-item")
    public ResponseEntity<Void> addItem(HttpSession session, @RequestBody Item item) {
        String cartId = (String) session.getAttribute("cartId");
        if (cartId == null) {
            cartId = cartService.createCart();
            session.setAttribute("cartId", cartId); // Immutable ID, safe to store
        }
        // Cart state is in the database; addItem uses optimistic locking (@Version)
        cartService.addItem(cartId, item);
        return ResponseEntity.ok().build();
    }
}
```

### قائمة تدقيق مستوى التطبيق

- [ ] **حدد كل تسلسل قراءة-ثم-كتابة-مشروطة يمتد عبر عبارتي SQL.** فكل منها يجب أن يصبح `UPDATE` شرطيًا واحدًا، أو يُحمى بـ `SELECT FOR UPDATE` (متشائم) أو `@Version` (متفائل).
- [ ] **دقّق كل تسلسل قراءة-ثم-تنفيذ على ذاكرة مؤقتة موزعة.** فعبر عدة نسخ استخدم عملية ذرية على الخادم (سكربت Lua، أو `INCRBY`)، أو قفلًا موزعًا، أو آلية مفاتيح عدم تكرار.
- [ ] **تحقق من إعدادات تزامن مستهلكي Kafka.** وتأكد من أن رسائل مفتاح الكيان نفسه تُوجَّه إلى القسم نفسه (تجزئة متسقة بالمفتاح) وتعالجها خيط واحد لكل قسم.
- [ ] **دقّق كل مهام `@Scheduled`.** ففي نشر متعدد النسخ يجب أن تحصل كل مهمة على قفل موزع قبل التنفيذ أو تُنشر فقط على عقدة مجدول مخصصة.
- [ ] **راجع كل استخدامات `HttpSession`.** فيجب ألا تخزن الجلسات إلا معرّفات غير قابلة للتغيير، لا كائنات عمل قابلة للتغيير أبدًا.
- [ ] **حدد كل نمط كتابة-بعد-قراءة يمتد عبر استدعاء شبكة.** فأي قراءة من خدمة تليها كتابة في خدمة أخرى بناءً على نتيجة القراءة حالة TOCTOU محتملة.
- [ ] **دقّق معالجة مفاتيح عدم التكرار.** فالتسليم المكرر للرسائل (Kafka "مرة على الأقل"، وإعادة محاولة HTTP) يجب أن يُعالج بمفاتيح عدم تكرار مخزنة في قاعدة البيانات بقيد فريد.
- [ ] **راجع أنماط مصادر الأحداث / outbox.** يجب أن يكتب نمط outbox المعاملاتي الحدث وتغيير الحالة في معاملة قاعدة البيانات نفسها. ولا تحدّث أبدًا قاعدة البيانات وتنشر إلى الوسيط كخطوتين منفصلتين في عملية عمل واحدة (مشكلة الكتابة المزدوجة) — بل دع ناقلًا ينشر من outbox.
- [ ] **دقّق كل المعاملات الطويلة.** فالمعاملات المفتوحة طوال طلب HTTP تزيد نافذة TOCTOU واحتمال الجمود.
- [ ] **تحقق من أن منطق إعادة محاولة القفل المتفائل له عدد محاولات محدود وتراجع أسي.** فإعادات المحاولة غير المحدودة تحت التنافس العالي قد تضخم المشكلة بدل حلها.

## 5. عملية تدقيق سلامة الخيوط

يكون تدقيق سلامة الخيوط أكثر فعالية عندما يُنظم على مراحل، من الاكتشاف الآلي إلى المراجعة البشرية إلى التحقق التجريبي.

### المرحلة 1: التحليل الساكن

**‏`@GuardedBy` مع Error Prone وSpotBugs:**

علّم كل حقل يتطلب قفلًا بـ `@GuardedBy` (من `net.jcip:jcip-annotations` أو تعليقات Error Prone). يفرضه فحص `GuardedBy` في **Error Prone** وقت الترجمة؛ ويكشف **SpotBugs** المزامنة غير المتسقة (`IS2_INCONSISTENT_SYNC`) — حقل يُوصل إليه أحيانًا مع القفل وأحيانًا دونه:

```java
import net.jcip.annotations.GuardedBy;
import net.jcip.annotations.ThreadSafe;

@ThreadSafe
public class PaymentLedger {

    private final Object lock = new Object();

    @GuardedBy("lock")
    private BigDecimal balance = BigDecimal.ZERO;

    public void credit(BigDecimal amount) {
        synchronized (lock) {
            balance = balance.add(amount);
        }
    }
}
```

سيرفض Error Prone أي وصول إلى `balance` ليس داخل كتلة `synchronized (lock)`.

**قواعد SonarQube الواجب تفعيلها:**

- ‏`java:S2886` — يجب مزامنة دوال القراءة والتعيين معًا
- ‏`java:S3077` — يجب ألا تكون الحقول غير البدائية `volatile` (فـ volatile لا يجعل محتوى الكائن آمنًا للخيوط)
- ‏`java:S2445` — يجب أن تتزامن الكتل على حقول `private final`
- ‏`java:S2222` — يجب تحرير الأقفال في كل المسارات
- ‏SpotBugs ‏`IS2_INCONSISTENT_SYNC` (عبر إضافة SpotBugs) — حقل يُوصل إليه مع المزامنة ودونها

**إعداد إضافة Maven:**

```xml
<plugin>
  <groupId>com.github.spotbugs</groupId>
  <artifactId>spotbugs-maven-plugin</artifactId>
  <version>4.8.3.0</version>
  <configuration>
    <effort>Max</effort>
    <threshold>Low</threshold>
    <includeFilterFile>spotbugs-include.xml</includeFilterFile>
  </configuration>
  <executions>
    <execution>
      <goals><goal>check</goal></goals>
    </execution>
  </executions>
</plugin>
```

### المرحلة 2: المرور على قائمة مراجعة الشيفرة

لكل طلب سحب يمس صنفًا مستخدمًا في سياق متزامن، يجب على المراجع:

1. تطبيق قوائم تدقيق مستوى الصنف والوحدة والتطبيق أعلاه على كل ملف متغير.
2. السؤال: "إذا استدعت خمسون خيطًا كل طريقة عامة في هذا الصنف في الوقت نفسه، فماذا سيحدث؟"
3. السؤال: "هل لهذه الطريقة آثار جانبية على حالة مشتركة؟"
4. السؤال: "هل تفترض هذه الطريقة أي حالة عُيّنت في استدعاء طريقة سابق؟"
5. توثيق النتائج وطلب الإصلاحات قبل الدمج.

### المرحلة 3: اختبار الحمل بمستخدمين متزامنين

التحليل الساكن ومراجعة الشيفرة ضروريان لكنهما غير كافيين. فاختبار الحمل تحت تزامن واقعي مطلوب للتحقق من عدم حدوث فساد في البيانات.

```bash
# Gatling load test: 100 concurrent users, 60 seconds, targeting the payment endpoint
mvn gatling:test -Dgatling.simulationClass=PaymentLoadSimulation

# Verify post-test: check for balance inconsistencies, duplicate transactions,
# and negative balances in the test database
psql -d testdb -c "SELECT id, balance FROM accounts WHERE balance < 0;"
psql -d testdb -c "SELECT payment_id, COUNT(*) FROM settled_payments GROUP BY payment_id HAVING COUNT(*) > 1;"
```

### المرحلة 4: ‏jcstress لاختبارات التزامن منخفضة المستوى

‏[jcstress](https://github.com/openjdk/jcstress) أداة OpenJDK لكتابة وتشغيل اختبارات إجهاد التزامن على مستوى JVM. وهي مفيدة خاصة لاختبار آليات المزامنة المخصصة، وحلقات CAS في `AtomicReference`، وضمانات الرؤية.

```java
// Initial balance 50; two actors each try to debit 50 with a CAS loop.
// r1/r2 = 1 if that actor's debit succeeded, 0 if it was refused.
@JCStressTest
@Outcome(id = "1, 0", expect = ACCEPTABLE, desc = "Actor 1 debited, actor 2 refused")
@Outcome(id = "0, 1", expect = ACCEPTABLE, desc = "Actor 2 debited, actor 1 refused")
@Outcome(id = "1, 1", expect = FORBIDDEN,  desc = "Both debited — balance went negative")
@Outcome(id = "0, 0", expect = FORBIDDEN,  desc = "Both refused — a debit was lost")
@State
public class BalanceCasTest {

    final AtomicReference<BigDecimal> balance =
        new AtomicReference<>(BigDecimal.valueOf(50));

    private int tryDebit(BigDecimal amount) {
        BigDecimal cur, upd;
        do {
            cur = balance.get();
            upd = cur.subtract(amount);
            if (upd.signum() < 0) return 0;          // refuse: insufficient funds
        } while (!balance.compareAndSet(cur, upd));
        return 1;
    }

    @Actor
    public void actor1(II_Result r) {
        r.r1 = tryDebit(BigDecimal.valueOf(50));
    }

    @Actor
    public void actor2(II_Result r) {
        r.r2 = tryDebit(BigDecimal.valueOf(50));
    }
}
```

رصيد ابتدائي 50، وفاعلان يحاول كل منهما خصم 50 بحلقة CAS. والنتيجة "1, 1" محظورة (خُصم الاثنان فأصبح الرصيد سالبًا)، و"0, 0" محظورة أيضًا (رُفض الاثنان فضاع خصم).

### ملخص الأدوات

| الأداة | الغرض | نقطة التكامل |
|---|---|---|
| SpotBugs | اكتشاف ساكن لأخطاء التزامن الشائعة | بناء Maven/Gradle، ومسار CI |
| Error Prone | فرض `@GuardedBy` وقت الترجمة | المترجم |
| SonarQube | جودة شيفرة مستمرة تشمل قواعد سلامة الخيوط | بوابة CI/CD |
| IntelliJ IDEA | فحوص فورية: synchronized على حقل غير نهائي، وThreadLocal دون remove | بيئة التطوير |
| jcstress | اختبار إجهاد التزامن منخفض المستوى في JVM | مجموعة اختبارات مخصصة |
| Gatling / k6 | اختبار حمل على مستوى التطبيق لكشف فساد البيانات | مسار ما قبل الإنتاج |
| Redisson | قفل موزع للتنسيق بين النسخ المتعددة | مكتبة وقت التشغيل |

## 6. مرجع سريع: أدوات سلامة الخيوط في Java

اختيار الأداة الخطأ خطر بقدر عدم استخدام أي مزامنة. ويقدم هذا الجدول إرشادات للقرار.

| الأداة | استخدمها عندما | تجنبها عندما |
|---|---|---|
| `synchronized` | استبعاد متبادل بسيط على كائن واحد؛ أقسام حرجة قصيرة | عمليات طويلة (تسبب تنافسًا)؛ لا حاجة لمحاولة القفل |
| `ReentrantLock` | تحتاج `tryLock()` أو `lockInterruptibly()` أو `Condition`؛ تحكم أدق | الحالات البسيطة التي يكفي فيها `synchronized` |
| `AtomicInteger/Long` | عدّاد رقمي واحد مع زيادة/نقصان/CAS | تنسيق تحديثات عبر عدة حقول مترابطة |
| `AtomicReference` | مرجع واحد مع CAS؛ بناء بنى بيانات خالية من الأقفال | تنسيق عدة حقول (استخدم `synchronized` بدلًا منه) |
| `volatile` | ضمان رؤية حقل واحد؛ الأعلام وحقول الحالة | العمليات المركبة (قراءة-تعديل-كتابة تحتاج CAS أو قفلًا) |
| `ConcurrentHashMap` | مخزن مفتاح-قيمة عالي التزامن؛ عمليات منفردة ذرية | عمليات مركبة عبر عدة مفاتيح (تحتاج قفلًا خارجيًا) |
| `CopyOnWriteArrayList` | مجموعات كثيفة القراءة بكتابات نادرة | مجموعات كثيفة الكتابة (النسخ عند كل كتابة مكلف) |
| `ReadWriteLock` | قراء كثيرون وكتّاب قليلون؛ القراءة رخيصة والكتابة نادرة | أحمال كثيفة الكتابة (القراء يحجبون الكتّاب؛ والكتّاب يحجبون الجميع) |
| الكائنات غير القابلة للتغيير | حالة لا تتغير بعد البناء؛ كائنات القيمة | كائنات يجب أن تتغير كثيرًا |
| `ThreadLocal` | سياق لكل خيط (معرّف الترابط، وسياق الأمان) | حالة عمل يجب مشاركتها بين الخيوط |

## 7. مزالق الإنتاج

### المزلق 1: المزامنة على حقل غير نهائي

```java
// UNSAFE: if 'lock' is reassigned between two synchronized blocks,
// the two synchronized blocks protect different monitor objects.
// No mutual exclusion is achieved.
public class PaymentProcessor {

    private Object lock = new Object(); // UNSAFE: non-final

    public void process(Payment p) {
        synchronized (lock) { // Uses lock@address1
            // ...
        }
    }

    public void reconfigure() {
        lock = new Object(); // Reassigns lock — now process() uses a different monitor
    }
}

// SAFE: lock is final; it is always the same object
public class PaymentProcessor {

    private final Object lock = new Object(); // SAFE: final, never reassigned

    public void process(Payment p) {
        synchronized (lock) {
            // ...
        }
    }
}
```

### المزلق 2: التقاط InterruptedException دون إعادة المقاطعة

```java
// UNSAFE: swallowing InterruptedException prevents the thread pool from
// shutting down cleanly. The interrupted flag is cleared by catch; if the
// thread pool needs to stop, it will hang.
public void waitForSettlement() {
    try {
        settlementLatch.await();
    } catch (InterruptedException e) {
        log.warn("Interrupted while waiting"); // WRONG: flag is cleared, shutdown hangs
    }
}

// SAFE: re-interrupt the thread so callers can observe the interruption
public void waitForSettlement() {
    try {
        settlementLatch.await();
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt(); // Restore the interrupted flag
        throw new PaymentProcessingException("Settlement wait interrupted", e);
    }
}
```

### المزلق 3: استخدام `size()` لحراسة عملية على مجموعة

```java
// UNSAFE: even on a ConcurrentLinkedQueue, size() and poll() are two
// separate operations. The queue may become empty between the size() check
// and the poll() call. This is not a data corruption bug here, but it is
// a logic error that is symptomatic of incorrect reasoning about atomicity.
// In a ConcurrentHashMap, checking size() before putIfAbsent() is a classic
// race condition.
ConcurrentLinkedQueue<Payment> queue = new ConcurrentLinkedQueue<>();

if (queue.size() > 0) {           // Queue has elements... maybe
    Payment p = queue.poll();     // May return null if another thread emptied it
    processPayment(p);            // NullPointerException
}

// SAFE: use the return value of the atomic operation directly
Payment p = queue.poll();
if (p != null) {
    processPayment(p); // Safe: p is a local variable captured from the queue
}
```

### المزلق 4: استدعاء `wait()` خارج حلقة `while`

```java
// UNSAFE: Java's Object.wait() can return spuriously (without notify being called).
// Using if() instead of while() means the spurious wake-up is treated as a
// legitimate signal. The balance may still be insufficient when processing begins.
public synchronized void processWhenFunded(BigDecimal required) throws InterruptedException {
    if (balance.compareTo(required) < 0) { // WRONG: use while
        wait(); // May wake up spuriously
    }
    // Balance may still be < required here — spurious wake-up was not a real signal
    debitBalance(required);
}

// SAFE: always loop on the condition in a while loop
public synchronized void processWhenFunded(BigDecimal required) throws InterruptedException {
    while (balance.compareTo(required) < 0) { // CORRECT: re-checks condition after every wake
        wait();
    }
    // Here, balance is guaranteed to be >= required
    debitBalance(required);
}
```


<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لحبة Spring وحيدة @Service حقل نسخة 'private List<Payment> pending = new ArrayList<>()'. وتستدعي خيوط طلبات متعددة طرق هذه الحبة بالتزامن. أي عبارة تصف خطر سلامة الخيوط بأفضل شكل؟",
      "options": [
        "لا خطر لأن Spring يدير دورة حياة الحبة ويزامن الوصول تلقائيًا.",
        "الخطر محدود بـ ConcurrentModificationException أثناء المرور، ويمكن كتمه بـ try-catch.",
        "تتشارك كل خيوط الطلبات المتزامنة ArrayList دون مزامنة، فتتعرض لتحديثات ضائعة، وConcurrentModificationException، وفساد بيانات صامت.",
        "يوجد الخطر فقط إذا تجاوزت القائمة سعتها الابتدائية وأطلقت إعادة تحجيم."
      ],
      "correct": 2,
      "explanation": "ينشئ Spring نسخة واحدة من الحبة الوحيدة ويتشاركها بين كل خيوط الطلبات. وArrayList ليست آمنة للخيوط؛ فالقراءات والكتابات المتزامنة قد تفسد مصفوفتها الداخلية، أو تضيّع تحديثات، أو ترمي ConcurrentModificationException أثناء المرور. ولا يوفر Spring أي مزامنة تلقائية لحقول الحبوب. والإصلاح الصحيح إزالة الحالة القابلة للتغيير من الحبوب الوحيدة كليًا أو استخدام مجموعة آمنة للخيوط مثل CopyOnWriteArrayList."
    },
    {
      "text": "تقرأ عملية خصم رصيد الرصيد الحالي عبر SELECT، وتفحص هل يكفي، ثم تنفّذ UPDATE في عبارة SQL منفصلة — كل ذلك في طريقة @Transactional واحدة بعزل READ_COMMITTED. ويُحصل على ReentrantLock في بداية الطريقة ويُحرر في نهايتها. هل يكفي هذا الأسلوب لمنع الخصم المزدوج في نشر متعدد النسخ موسّع أفقيًا؟",
      "options": [
        "نعم. ‏@Transactional مع READ_COMMITTED وReentrantLock يضمنان الذرية عبر كل النسخ.",
        "نعم. عزل READ_COMMITTED يمنع القراءات القذرة، فلا خصم مزدوج ممكن.",
        "لا. ‏ReentrantLock محلي في JVM؛ ولا ينسّق بين نسخ تطبيق منفصلة. ويلزم UPDATE شرطي، أو SELECT FOR UPDATE، أو @Version، أو قفل موزع.",
        "لا. يجب أن يستخدم @Transactional عزل SERIALIZABLE لمنع هذا التسابق؛ وREAD_COMMITTED غير كافٍ."
      ],
      "correct": 2,
      "explanation": "يعيش ReentrantLock في كومة JVM لعملية واحدة. وفي نشر متعدد النسخ، لكل نسخة كائن قفلها؛ والحصول عليه في JVM لا أثر له في الأخرى. ولمنع التعديل المتزامن للصف نفسه عبر النسخ استخدم: (1) UPDATE شرطيًا واحدًا (WHERE balance >= :amount)، (2) SELECT FOR UPDATE لأخذ قفل صف داخل المعاملة، (3) القفل المتفائل بـ @Version، أو (4) قفلًا موزعًا. ولا يمنع عزل READ_COMMITTED وحده هذا التسابق TOCTOU."
    },
    {
      "text": "يستخدم مطوّر نمط القفل مزدوج الفحص التالي لتهيئة عميل دفع مشترك بكسل: 'private static PaymentClient instance; ... if (instance == null) { synchronized(...) { if (instance == null) { instance = new PaymentClient(); } } }'. ما العيب الدقيق في هذه الشيفرة؟",
      "options": [
        "فحص null الخارجي زائد؛ وحذفه سيصلح المشكلة.",
        "دون الكلمة volatile على 'instance'، قد تعيد JVM ترتيب الكتابات داخل مُنشئ PaymentClient، فيصبح كائن مهيأ جزئيًا مرئيًا للخيوط التي تقرأ 'instance' في فحص null الخارجي.",
        "يجب أن تستخدم كتلة synchronized كائن قفل منفصلًا عن كائن الصنف لمنع الجمود.",
        "القفل مزدوج الفحص معطوب بطبيعته في Java أيًا كان volatile، ويجب استبداله بـ getInstance() متزامنة."
      ],
      "correct": 1,
      "explanation": "دون volatile، يسمح نموذج ذاكرة Java بإعادة ترتيب الكتابات التي تهيئ حقول PaymentClient مع الإسناد إلى 'instance'. فقد يرى خيط يقرأ 'instance' في الفحص الخارجي مرجعًا غير null إلى كائن لم تظهر كتابات مُنشئه بعد — فقد تحمل الحقول غير النهائية null أو صفرًا. وإعلان 'instance' كـ volatile ينشئ علاقة تحدث-قبل: فكتابات المُنشئ مرئية لأي خيط يقرأ المرجع غير null. والبديل أسلوب الصنف الحامل للتهيئة عند الطلب، الذي يتجنب volatile بالاعتماد على قفل تهيئة الأصناف في JVM."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مختبر تدقيق سلامة الخيوط: خدمة معالجة المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "task-01",
      "description": "لديك حبة وحيدة PaymentProcessingService بثلاثة حقول نسخة: ‏HashMap<String, BigDecimal> للذاكرة المؤقتة للأرصدة، وعدّاد int عادي للمقاييس، وحقل Payment لحالة كل طلب. أجرِ تدقيقًا على مستوى الصنف: حدد كل انتهاكات سلامة الخيوط، وصنّف كلًا منها كحالة مشتركة قابلة للتغيير، أو عملية مركبة غير ذرية، أو قيمة معادة قابلة للتغيير، وقدّم نسخة معاد هيكلتها من الصنف تزيل كل الانتهاكات. ووثّق كل إصلاح بتعليق يشرح ضمان نموذج ذاكرة Java المحدد الذي يعتمد عليه."
    },
    {
      "id": "task-02",
      "description": "نفّذ PaymentLimitService آمنًا للخيوط يجب أن: (1) يخزن مؤقتًا حدود الإنفاق اليومية لكل مستخدم المحمّلة من قاعدة البيانات (حمّلها خارج أي قفل أو دالة compute)، (2) يفحص ذريًا هل تتجاوز معاملة جديدة الحد، وإن لم تتجاوز يحجز المبلغ، (3) يدعم الإبطال المتزامن للذاكرة المؤقتة عند إعادة ضبط الحدود. اكتب التنفيذ باستخدام ReadWriteLock، ثم تنفيذًا ثانيًا باستخدام ConcurrentHashMap.compute() (مع عمل سريع في الذاكرة فقط داخل compute). واكتب اختبار jcstress يتحقق من عدم تجاوز أي حد تحت فاعلين متزامنين يحاولون كلهم حجز مبالغ يتجاوز مجموعها الحد. وأخيرًا اشرح لماذا يكون التنفيذان صحيحين داخل JVM واحدة فقط."
    },
    {
      "id": "task-03",
      "description": "تعمل مهمة تسوية دفعية عبر @Scheduled(cron = ...) وتعرض أيضًا نقطة HTTP للتشغيل اليدوي. ويعمل التطبيق على ثلاث نسخ. نفّذ حلًا باستخدام أقفال Redisson الموزعة يضمن: (1) أن نسخة واحدة فقط تشغّل المهمة في أي وقت أيًا كان مصدر التشغيل، (2) إذا أُطلق التشغيل عبر HTTP بينما المهمة المجدولة تعمل، يعيد 409 Conflict برسالة ذات معنى بدل الحجب، (3) أن القفل يُحرر دائمًا حتى لو رمت المهمة RuntimeException. وضمّن اختبار وحدة يحاكي Redisson ويتحقق من مسار 409 ومسار التنظيف عند الاستثناء."
    },
    {
      "id": "task-04",
      "description": "أجرِ تدقيقًا على مستوى التطبيق للسيناريو التالي: مستهلك Kafka يعالج رسائل AccountFundedEvent، ولكل حدث يقرأ الحساب من قاعدة البيانات، ويحسب مكافأة إحالة، ويكتبها. وعدة خيوط مستهلك نشطة؛ وللموضوع 10 أقسام؛ ومعرّفات الحسابات تُستخدم كمفتاح رسالة Kafka. وحدد: (1) هل تكفي استراتيجية مفتاح القسم الحالية لمنع إضافة مكافأة مكررة، (2) تحت أي سيناريو فشل (تعطل المستهلك، أو إعادة التوازن) قد يحدث تكرار مع ذلك، (3) ونفّذ آلية مفتاح عدم تكرار باستخدام جدول processed_events بقيد فريد على (account_id, event_id) تمنع المكافآت المكررة حتى بعد إعادة التسليم."
    }
  ]
}
-->
