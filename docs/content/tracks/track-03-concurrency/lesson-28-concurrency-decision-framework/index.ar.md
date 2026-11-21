---
id: track-03-lesson-28
sequence: 28
title: "إطار المهندس الرئيسي لقرارات التزامن"
slug: concurrency-decision-framework
track: track-03
difficulty: principal
estimatedMinutes: 60
status: published
tags: [decision-framework, architecture, trade-offs, staff-engineer, principal-engineer]
java-versions: [17, 21]
---

# إطار اتخاذ قرارات التزامن

## نظرة عامة

التزامن مساحة تصميم لها إجابات صحيحة كثيرة. والفرق بين المهندس الأول والمهندس الرئيسي ليس معرفة تقنيات أكثر — بل معرفة أي تقنية يختار، ومتى، وكيف يبرر هذا الاختيار للفريق. ويجمع هذا الدرس المسار 3 في إطار قرار تطبقه على مشكلات الإنتاج الحقيقية وتشرحه للزملاء والمعماريين ومديري الهندسة.

## أهداف التعلم

في نهاية هذا الدرس ستستطيع:

- تطبيق عملية قرار منظمة على أي مشكلة تزامن في الأنظمة المالية
- تحديد القيد المهيمن (الإنتاجية، أو زمن الاستجابة، أو الاتساق، أو البساطة) وجعله يقود اختيار الأداة
- صياغة المقايضات بين استراتيجيات القفل بلغة مراجعات البنية
- التعرف على الحالات التي يكون فيها "لا تزامن" هو الإجابة الصحيحة
- كتابة سجلات تصميم تزامن تصمد أمام مراجعات الشيفرة وتحليلات ما بعد الحوادث

## مساحة مشكلات التزامن

تقع كل مشكلة تزامن في الأنظمة المالية في إحدى أربع فئات: **الحالة المشتركة** (من يملكها؟ — الأرصدة، والإعدادات، والذاكرات المؤقتة)، و**التنسيق** (من يبدأ أولًا؟ — بدء الخيوط، ومراحل الدفعات، وتقييد المعدّل)، و**التنفيذ غير المتزامن** (من يشغّله؟ — مسارات الدفع، والفحوص المتوازية، والمهام الخلفية)، و**حدود الموارد** (كم؟ — مجمّعات الخيوط، واتصالات قاعدة البيانات، وحدود معدّل الواجهات).

```
┌─────────────────────────────────────────────────────────┐
│              Concurrency Problem Space                  │
│                                                         │
│  ┌──────────────────┐    ┌──────────────────┐           │
│  │  SHARED STATE    │    │  COORDINATION    │           │
│  │  (Who owns it?)  │    │  (Who goes first?)│           │
│  │                  │    │                  │           │
│  │ • Balances       │    │ • Thread startup │           │
│  │ • Config         │    │ • Batch phases   │           │
│  │ • Caches         │    │ • Rate limiting  │           │
│  └──────────────────┘    └──────────────────┘           │
│                                                         │
│  ┌──────────────────┐    ┌──────────────────┐           │
│  │  ASYNC EXECUTION │    │  RESOURCE LIMITS │           │
│  │  (Who runs it?)  │    │  (How many?)     │           │
│  │                  │    │                  │           │
│  │ • Payment pipelines│  │ • Thread pools   │           │
│  │ • Parallel checks │  │ • DB connections │           │
│  │ • Background jobs │  │ • API rate limits│           │
│  └──────────────────┘    └──────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

## إطار القرار: خمسة أسئلة

لأي مشكلة تزامن، أجب عن هذه الأسئلة الخمسة بالترتيب:

### السؤال 1: هل تستطيع إلغاء الحالة المشتركة القابلة للتغيير؟

إن كان نعم — فافعل. فعدم القابلية للتغيير أقوى ضمان للصحة: لا تنافس على الأقفال، ولا مشكلات رؤية في الذاكرة، ولا حالات تسابق.

```
Is the data read-many, write-rarely?
  ├── YES → Immutable record + volatile/atomic reference swap
  │          Cost: GC pressure on updates; fine for config, routes, fee tables
  └── NO → Proceed to Q2
```

**التطبيق في نظام الدفع:** جداول الرسوم، وقواعد التوجيه، ومجموعات قواعد الاحتيال — حمّلها مرة، وانشرها عبر مرجع `volatile`، وأعد تحميلها أثناء التشغيل بتبديل المرجع. صفر تنافس على الأقفال، وصفر ضغط على جامع النفايات أثناء القراءات.

### السؤال 2: هل التنافس مشكلة فعلًا؟

قِس قبل التحسين. فكثير من الحسابات نادرًا ما يُتنافس عليها:

```
Is the resource genuinely contested?
  ├── NO (< 2 concurrent writers) → synchronized or simple AtomicXxx
  │   "The simplest correct tool. Premature optimisation kills readability."
  └── YES (high contention) → Proceed to Q3
```

**خطأ المهندس الرئيسي:** اللجوء إلى `ConcurrentHashMap` بدوال merge معقدة أو حلقات CAS خالية من الأقفال لبنى بيانات ليس لها إلا كاتب واحد. استخدم `synchronized` وحلّل الأداء قبل التحسين.

### السؤال 3: هل العملية كثيفة المعالجة أم الإدخال/الإخراج؟

```
Is the concurrent work primarily:
  ├── I/O-BOUND (database, HTTP, file) → Virtual threads (Java 21)
  │   "Thread-per-request without thread-pool exhaustion —
  │    but bound scarce resources (DB connections) with a Semaphore"
  │
  └── CPU-BOUND (crypto, compression, complex validation)
        ├── Divisible? → ForkJoinPool / parallel streams
        └── Not divisible? → Bounded ThreadPoolExecutor (about one thread per core)
```

**نمط مضاد شائع:** استخدام `CompletableFuture.supplyAsync()` مع المجمّع المشترك لعمليات الإدخال/الإخراج. فللمجمّع المشترك `#CPUs - 1` خيطًا فقط، فقد تشغلها كلها بضعة استعلامات بطيئة فتعطّل كل مستقبل آخر وكل تدفق متوازٍ في JVM. استخدم منفّذ إدخال/إخراج مخصصًا.

### السؤال 4: ما متطلب الاتساق؟

```
Consistency requirement:
  ├── ATOMIC READ-MODIFY-WRITE (single value)
  │     → AtomicLong / AtomicReference with CAS
  │
  ├── ATOMIC MULTI-FIELD UPDATE (snapshot atomicity)
  │     → Immutable record + AtomicReference<Record> swap
  │       OR synchronized block
  │
  ├── ATOMIC DATABASE OPERATION (business transaction)
  │     Single row      → one conditional UPDATE (WHERE balance >= :amount)
  │     Low contention → @Version optimistic locking + retry
  │     High contention → SELECT FOR UPDATE pessimistic locking
  │
  └── DISTRIBUTED CONSISTENCY (cross-service)
        → Saga + idempotency + compensating transactions
```

### السؤال 5: ما نمط الفشل الذي تتحمله؟

```
If the concurrent operation fails (timeout, exception, contention):
  ├── FAIL FAST (payment authorisation) → Small queue + reject with 503
  ├── RETRY (idempotent balance update) → Optimistic lock + exponential backoff
  ├── DEGRADE GRACEFULLY (fraud check) → a fallback decided by the RISK team,
  │     e.g. allow only low amounts on timeout, refer the rest to manual review
  └── DROP (metrics, analytics sampling) → DiscardPolicy or DiscardOldestPolicy
```

الفشل السريع لتفويض الدفع (طابور صغير ورفض بـ 503)، وإعادة المحاولة لتحديث رصيد عديم التكرار، والتدهور اللطيف لفحص الاحتيال بقرار بديل يحدده **فريق المخاطر** (مثل السماح بالمبالغ الصغيرة فقط عند انتهاء المهلة وإحالة الباقي للمراجعة اليدوية)، والإسقاط فقط للمقاييس وعينات التحليلات.

> [!IMPORTANT]
> لا تختر أبدًا `DiscardPolicy` للعمليات الحرجة للمدفوعات. ففقدان البيانات الصامت في نظام مالي فشل تنظيمي وفشل في ثقة العملاء. استخدم `DiscardPolicy` فقط للبيانات غير الحرجة فعلًا مثل عينات المقاييس أو أحداث التحليلات — لا لسجلات التدقيق أبدًا (فالفجوة في سجل التدقيق فشل امتثالي) ولا لإشعارات العملاء بحركة أموالهم.

## مصفوفة اختيار الأدوات

| المتطلب | الخيار الأول | متى ترتقي |
|-------------|-------------|-----------------|
| إعدادات مشتركة كثيفة القراءة | مرجع `volatile` إلى سجل غير قابل للتغيير | — |
| عدّاد واحد / محدد معدّل | `AtomicLong` / `LongAdder` | لا ترتقِ أبدًا للعدّ |
| لقطة ذرية متعددة الحقول | `AtomicReference<Record>` | إلى قاعدة البيانات إذا كانت دائمة |
| خصم بسيط لصف واحد | تحديث شرطي `UPDATE ... WHERE balance >= :amount` | قواعد متعددة الصفوف ← القفل أدناه |
| رصيد قليل التنافس | قفل متفائل `@Version` | نسبة إعادة محاولة > 20% ← متشائم |
| رصيد كثير التنافس | `SELECT FOR UPDATE` | موزع ← Saga |
| مسار إدخال/إخراج متوازٍ | `CompletableFuture` + منفّذ مخصص | Java 21 ← خيوط افتراضية |
| خيط لكل طلب (إدخال/إخراج) | خيوط افتراضية | — |
| توازٍ كثيف المعالجة | `ForkJoinPool` / تدفق متوازٍ | `ThreadPoolExecutor` مخصص |
| حد التزامن (N قيد التنفيذ) | `Semaphore` | Resilience4j Bulkhead |
| حد المعدّل (N في الثانية) | دلو الرموز / Resilience4j RateLimiter | محدد موزع (مثل Redis) |
| بوابة بدء لمرة واحدة | `CountDownLatch` | — |
| حاجز مراحل قابل لإعادة الاستخدام | `CyclicBarrier` | `Phaser` للعمال الديناميكيين |
| عزل المجمّعات | `ThreadPoolExecutor` منفصل لكل اهتمام | خيوط افتراضية (مسار الإدخال/الإخراج) |

## سلّم التعقيد

لا تصعد في السلّم إلا بقدر ما تتطلبه المشكلة. فكل درجة تضيف مساحة أكبر لأخطاء الصحة:

```
Complexity Rung 1: Avoid shared state entirely
  ↓ if unavoidable
Complexity Rung 2: Make state immutable and publish safely
  ↓ if mutable state required
Complexity Rung 3: Confine mutable state to one thread (thread confinement)
  ↓ if shared access required
Complexity Rung 4: Use volatile / AtomicXxx for single-variable coordination
  ↓ if multi-variable atomicity required
Complexity Rung 5: Use synchronized for guarded compound operations
  ↓ if performance or advanced locking required
Complexity Rung 6: Use ReentrantLock / StampedLock / ReadWriteLock
  ↓ if lock-free performance required
Complexity Rung 7: Use CAS / VarHandle / lock-free structures
  ↓ if distributed coordination required
Complexity Rung 8: Saga + idempotency + distributed consensus
```

**مبدأ المهندس الرئيسي:** ابدأ دائمًا من الدرجة 1، وبرّر كل خطوة نزول بالقياس لا بالحدس.

## شرح المقايضات: لغة مراجعة البنية

عند عرض تصميم تزامن على الزملاء أو في مراجعة بنية، رتّب حجتك هكذا:

```
1. The constraint we're optimising for
2. The option we chose
3. The options we rejected and why
4. The failure mode and how we handle it
5. The observability we've added
```

**مثال — قفل أرصدة الدفع:**

> *"نحن نحسّن للصحة على حساب الإنتاجية. اخترنا القفل المتشائم (`SELECT FOR UPDATE`) لحسابات التجار المعلّمة بأنها كثيرة التنافس، لأن القفل المتفائل كان يعيد المحاولة في 40% من الطلبات تحت ذروة الحمل المقيسة لدينا: 180 خصمًا متزامنًا على حساب واحد — فيولّد 72 رحلة مهدرة لقاعدة البيانات في الثانية. ورفضنا القفل المتفائل لهذه الشريحة لأن تضخم إعادة المحاولات يتجاوز كلفة التسلسل. ونعالج نمط الفشل بمهلة معاملة 5 ثوانٍ تُظهر استثناء `LockTimeoutException` محدد النوع ← HTTP 503 للمستدعين. وأضفنا مقاييس Micrometer لزمن انتظار القفل ونسبة انتهاء المهل، مع تنبيه عندما تتجاوز نسبة انتهاء المهل 0.5%."*

## أخطاء شائعة على مستوى المهندس الرئيسي

### الخطأ 1: حل المشكلة الخطأ

> "خدمة الدفع بطيئة تحت الحمل" ← تُضاف خيوط أكثر فورًا.

**تحقق من الواقع:** قد تجعل الخيوط الأكثر مشكلات الإدخال/الإخراج أسوأ (خيوط أكثر ← اتصالات قاعدة بيانات أكثر ← تنافس أقفال أكثر في قاعدة البيانات). حلّل الأداء أولًا. فالاختناق غالبًا في قاعدة البيانات لا في عدد الخيوط.

### الخطأ 2: نسخ الأنماط دون فهم

استخدام `ConcurrentHashMap.computeIfAbsent()` لكل شيء لأنه "متزامن" — دون فهم أن دالة الحساب يجب ألا تحجب على إدخال/إخراج، ولا تعدّل الخريطة، ولا تستغرق وقتًا طويلًا. وكسر هذه القاعدة يسبب جمودًا.

### الخطأ 3: قابلية ملاحظة غير كافية

بناء هيكل متطور خالٍ من الأقفال بلا مقاييس. فعندما يسيء التصرف في الإنتاج لا توجد بيانات. جهّز دائمًا: نسبة التنافس، وعدد إعادات المحاولة، ونسبة الرفض، وزمن احتجاز القفل.

### الخطأ 4: الثقة في الاختبارات على x86

قد يفشل اختبار ينجح في ملايين التكرارات على جهاز MacBook Pro للتطوير في أول تشغيل على AWS Graviton ‏(ARM). وJMM هو العقد — فاختبر على عتاد ضعيف الترتيب أو استخدم jcstress.

### الخطأ 5: تجاهل كلفة المسار السعيد

للقراءة المتفائلة في `StampedLock` كلفة حتى في المسار غير المتنافس عليه. ولقراءة ذاكرة مؤقتة تحدث 10 ملايين مرة في الثانية، حتى كلفة 10 نانوثانية تساوي 0.1 ثانية معالج في كل ثانية. فحلّل المسار الساخن قبل اختيار قفل "أذكى".

## قالب سجل القرار

عند اتخاذ قرار تصميم تزامن مهم، اكتب سجل قرار معماري (ADR) قصيرًا:

```markdown
## Concurrency Design Record: [Component Name]

**Date:** YYYY-MM-DD
**Author:** [name]
**Status:** Accepted

### Context
[Describe the shared state, its access pattern, and the constraint]

### Decision
[The concurrency mechanism chosen]

### Consequences
- **Correctness guarantee:** [What invariant is maintained]
- **Performance characteristic:** [Throughput/latency at expected concurrency]
- **Failure mode:** [What happens under overload]
- **Observability:** [Metrics/alerts in place]

### Alternatives Rejected
- [Option A]: rejected because [reason]
- [Option B]: rejected because [reason]
```

## خلاصة المسار 3: ما تعرفه الآن

لقد غطيت:

| الفئة | الدروس | الأداة/المفهوم الأساسي |
|----------|---------|-----------------|
| نموذج الذاكرة | 1، 22، 23، 26 | علاقة تحدث-قبل في JMM، والحقول النهائية، والحواجز |
| تصميم سلامة الخيوط | 2، 7 | عدم القابلية للتغيير، وأنماط حالات التسابق |
| المزامنة | 3، 8 | ‏ReentrantLock، ومنع الجمود |
| العمليات الذرية | 4، 5 | ‏CAS، ومشكلة ABA |
| المجموعات المتزامنة | 6 | ‏ConcurrentHashMap، وBlockingQueue |
| الأداء | 9، 17، 19 | المشاركة الزائفة، وJMH، والتنافس على الأقفال |
| إدارة الخيوط | 10، 20 | ‏ThreadPoolExecutor، والحواجز (bulkhead) |
| المسارات غير المتزامنة | 11 | ‏CompletableFuture |
| Java 21 | 12، 13، 14، 15 | الخيوط الافتراضية، والتزامن المهيكل، والقيم المحصورة |
| الاختبار والتشخيص | 16، 18 | ‏jcstress، وتفريغات الخيوط |
| أنماط النطاق | 21، 24، 25، 27 | إدارة الأرصدة، وأدوات المزامنة، ونشر السياق |
| الإطار | 28 | إطار القرار (هذا الدرس) |

## اختبار المعرفة

**س1:** يقترح فريق استبدال كل كتل `synchronized` في خدمة الدفع بـ `ReentrantLock` من أجل "أداء أفضل". كيف تقيّم هذا الاقتراح؟

**ج:** اطلب دليل تحليل أداء. يقدم `ReentrantLock` ميزات إضافية (`tryLock`، و`lockInterruptibly`، والوضع العادل، ومتغيرات `Condition` متعددة) لكنه لا يتفوق تلقائيًا على `synchronized` في الأقفال غير المتنافس عليها — فـ JVM تحسّن `synchronized` كثيرًا (القفل الخفيف، ودمج الأقفال، وإلغاء الأقفال). (والقفل المنحاز (biased locking)، الذي يُذكر كثيرًا هنا، عُطّل في JDK 15 وأُزيل في JDK 18.) وفي الأقفال المتنافس عليها تحت تزامن عالٍ قد يتفوق `ReentrantLock`، لكن السؤال هو هل خدمة الدفع محدودة فعلًا بالتنافس على الأقفال. انتقل فقط حيث يُظهر التحليل أن التنافس على المراقبات (أحداث JFR ‏`JavaMonitorEnter`، و`-e lock` في async-profiler) يساهم بشكل ملموس في زمن الاستجابة.

**س2:** يقترح معماري خدمة جديد استخدام `synchronized` على كل طريقة تحديث رصيد، بحجة أنه "الخيار الأكثر أمانًا". ويرد عضو في الفريق بأنه سيقتل الإنتاجية. من المحق، وماذا تفعل؟

**ج:** كلاهما محق جزئيًا — وكلاهما يفوت نقطة أكبر. فـ `synchronized` صحيح **داخل JVM واحدة فقط**. والأرصدة الحقيقية تعيش في قاعدة بيانات وتحدّثها عدة نسخ للخدمة، فقفل JVM وحده لا يحميها؛ ويجب أن يكون الحارس في قاعدة البيانات (`UPDATE` شرطي، أو `@Version`، أو `SELECT FOR UPDATE`). وحيث يناسب القفل في الذاكرة، يكون القلق على الإنتاجية مبالغًا فيه عادة: فـ `synchronized` غير المتنافس عليه يكلف نانوثوانٍ فقط. ولحساب ساخن واحد، كل آلية صحيحة تسلسل الوصول — فالإنتاجية محدودة بنحو `1 / زمن احتجاز القفل`، والرافعة هي تقصير زمن الاحتجاز. والإجابة الصحيحة: ضع الحارس حيث تعيش البيانات، وقِس التنافس (JFR، و`pg_locks`)، وحسّن الشرائح الساخنة فقط بدليل. ولا تصمم أبدًا لأسوأ حالة نظرية دون بيانات.

## التحدي العملي: محاكاة مراجعة بنية

يُعرض عليك التصميم التالي لخدمة معالجة دفع:

```java
public class PaymentProcessor {
    private static final Map<String, Long> balances = new HashMap<>();  // Not concurrent
    private static final List<Transaction> ledger   = new ArrayList<>(); // Not concurrent
    
    public synchronized void process(Payment p) {
        Long bal = balances.get(p.accountId());
        if (bal == null || bal < p.amount()) throw new InsufficientFundsException();
        balances.put(p.accountId(), bal - p.amount());
        ledger.add(new Transaction(p));
    }
}
```

**المهمة:** اكتب مراجعة مهندس رئيسي لهذا التصميم. وتناول:
1. ما الصحيح فيه
2. اختناق قابلية التوسع وعند أي مستوى تزامن يصبح مشكلة
3. ثلاثة تحسينات ملموسة مع مقايضاتها
4. المراقبة التي ستضيفها قبل أي تغيير
5. خطوة الانتقال الأولى التي توصي بها ولماذا

صُغ إجابتك وفق قالب لغة مراجعة البنية في هذا الدرس.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يقترح فريق استبدال كل كتل synchronized بـ ReentrantLock من أجل 'أداء أفضل'. كيف يجب أن يقيّم المهندس الرئيسي هذا الاقتراح؟",
      "options": [
        "اقبله فورًا — ReentrantLock دائمًا أسرع من synchronized",
        "ارفضه — synchronized دائمًا أسرع من ReentrantLock",
        "اطلب دليل تحليل أداء يُظهر أن التنافس على المراقبات يساهم بشكل ملموس في زمن الاستجابة؛ فـ ReentrantLock يقدم ميزات إضافية لكنه لا يتفوق تلقائيًا على synchronized في المسارات غير المتنافس عليها",
        "اقبله لكل الشيفرة الحرجة للمدفوعات، وارفضه لشيفرة الدفعات"
      ],
      "correct": 2,
      "explanation": "يقدم ReentrantLock ميزات إضافية (tryLock، وlockInterruptibly، والوضع العادل، ومتغيرات Condition متعددة) لكنه لا يتفوق تلقائيًا على synchronized في الأقفال غير المتنافس عليها — فـ JVM تحسّن synchronized كثيرًا (القفل الخفيف، ودمج الأقفال، وإلغاء الأقفال). وتحت التنافس الشديد يتقارب الاثنان في إصدارات JDK الحديثة. ولا يستطيع إلا تحليل الأداء (أحداث JFR ‏JavaMonitorEnter، و-e lock في async-profiler) تأكيد أن التنافس على المراقبات هو الاختناق فعلًا."
    },
    {
      "text": "وفقًا لسلّم التعقيد في هذا الدرس، متى يجب أن تلجأ أول مرة إلى عمليات AtomicXxx؟",
      "options": [
        "كخيار أول لأي حالة مشتركة قابلة للتغيير",
        "فقط بعد تحديد أن الحالة المشتركة لا يمكن إلغاؤها، ولا جعلها غير قابلة للتغيير، ولا حصرها في خيط واحد، وأنها تتطلب تنسيقًا بين الخيوط بذرية متغير واحد",
        "فقط عندما يسبب synchronized جمودًا",
        "للعدّادات فقط، لا لأنواع المراجع أبدًا"
      ],
      "correct": 1,
      "explanation": "يتطلب سلّم التعقيد استنفاد الخيارات الأبسط أولًا: (1) تجنب الحالة المشتركة كليًا، (2) جعل الحالة غير قابلة للتغيير ونشرها بأمان، (3) حصر الحالة القابلة للتغيير في خيط واحد. ولا تلجأ إلى volatile/AtomicXxx (الدرجة 4) إلا عندما تحتاج وصولًا مشتركًا قابلًا للتغيير عبر الخيوط بذرية متغير واحد. واللجوء المبكر إلى العمليات الذرية يضيف تعقيدًا وعبء صيانة غير ضروريين دون فائدة."
    },
    {
      "text": "تحتفظ خدمة دفع بلقطة في الذاكرة لبيانات الحسابات (وتبقى قاعدة البيانات مصدر الحقيقة): 90% قراءات و10% كتابات. والقيد هو إنتاجية القراءة. ما أفضل خيار أول وفقًا لإطار القرار؟",
      "options": [
        "‏StampedLock مع قراءات متفائلة لأقصى إنتاجية قراءة",
        "‏ConcurrentHashMap مع عمليات compute لسلامة الخيوط",
        "مرجع volatile إلى سجل غير قابل للتغيير — يُحدَّث بتبديل المرجع عند الكتابة، ويُقرأ دون أي مزامنة",
        "‏ReadWriteLock مع قراء كثيرين يتشاركون قفل كتابة واحدًا"
      ],
      "correct": 2,
      "explanation": "للبيانات كثيفة القراءة (90%) مثل لقطات الأرصدة، الخيار الأول سجل غير قابل للتغيير منشور عبر مرجع volatile. فيبدّل الكاتبون المرجع كاملًا ذريًا؛ ويقرأ القراء الحقل volatile دون أي قفل. وهذه الدرجة 2 في سلّم التعقيد (عدم القابلية للتغيير + النشر الآمن) — أبسط بكثير من StampedLock أو ReadWriteLock، بلا تنافس على الأقفال في مسار القراءة. ولا ترتقِ إلى StampedLock إلا إذا أظهر التحليل أن قراءة volatile اختناق، وهذا نادر."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مراجعة بنية بمستوى المهندس الرئيسي",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "راجع تصميم PaymentProcessor المقدَّم الذي يستخدم طريقة synchronized واحدة على صنف بحقلي HashMap وArrayList ساكنين. واكتب مراجعة مهندس رئيسي باستخدام قالب لغة مراجعة البنية: (1) ما الصحيح في التصميم، (2) اختناق قابلية التوسع وعند أي مستوى تزامن يصبح مشكلة، (3) ثلاثة تحسينات ملموسة مع مقايضاتها، (4) المراقبة التي ستضيفها قبل أي تغيير، (5) خطوة الانتقال الأولى التي توصي بها ولماذا."
    },
    {
      "id": "2",
      "description": "طبّق إطار القرار ذا الأسئلة الخمسة على السيناريو التالي: دفتر أستاذ مدفوعات يخزن الرصيد الجاري لـ 10 ملايين حساب. و95% من الطلبات قراءات رصيد، و5% كتابات خصم/إضافة. وذروة الحمل 50,000 قراءة في الثانية و2,500 كتابة في الثانية. واعمل على كل سؤال (إلغاء الحالة المشتركة؟ هل التنافس مشكلة؟ إدخال/إخراج أم معالجة؟ متطلب الاتساق؟ نمط الفشل؟) ووثّق الأداة التي تختارها في كل خطوة ولماذا توقفت."
    },
    {
      "id": "3",
      "description": "اكتب سجل تصميم تزامن (ADR) لذاكرة مؤقتة لقواعد الاحتيال تُقرأ 85,000 مرة في الثانية من 200 خيط تفويض وتُحدَّث كل 30 ثانية من خيط خلفي واحد. واستخدم قالب ADR من هذا الدرس: السياق، والقرار، والعواقب (ضمان الصحة، وخاصية الأداء، ونمط الفشل، وقابلية الملاحظة)، والبدائل المرفوضة مع الأسباب."
    },
    {
      "id": "4",
      "description": "حدد درجة سلّم التعقيد المناسبة لكل من المكونات التالية، وبرّر اختيارك، وسمِّ صنف Java أو النمط المحدد الذي تستخدمه: (أ) عدّاد طلبات للمقاييس، (ب) جدول رسوم يُحمَّل عند البدء ولا يتغير أبدًا، (ج) رصيد مؤقت مرتبط بالجلسة لمسار دفع متعدد الخطوات، (د) كائن إعدادات يُحدَّث كل ساعة عبر واجهة إدارية، (هـ) آلة حالات لمهمة دفعية بخمس حالات يتشاركها خيط منتج وخيط مستهلك."
    }
  ]
}
-->
