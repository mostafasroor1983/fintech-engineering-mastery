---
id: track-03-lesson-20
sequence: 20
title: "استنفاد مجمّعات الخيوط في أنظمة المدفوعات"
slug: thread-pool-exhaustion
track: track-03
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [thread-pool-exhaustion, bulkhead, executor-isolation, back-pressure]
java-versions: [17, 21]
---

# نفاد مجمّعات الخيوط — الحواجز والضغط العكسي

## نظرة عامة

نفاد مجمّع الخيوط من أشيع أسباب انقطاع أنظمة الدفع. وهو بسيط بشكل مخادع: يمتلئ منفّذ مشترك، فيصطف المستدعون بلا حد، ويقفز زمن الاستجابة، وتتوقف الخدمة كلها عن الاستجابة — دون رمي استثناء واحد. وفهم كيف تنفد المجمّعات، واكتشاف ذلك مبكرًا، وتصميم حدود حواجز (bulkheads) تفصل المسارات الحرجة عن العمل غير الحرج، كفاءة أساسية للمهندس الرئيسي.

## أهداف التعلم

في نهاية هذا الدرس ستستطيع:

- شرح التسلسل الدقيق للأحداث من الاعتماديات البطيئة إلى النفاد الكامل للمجمّع
- تحديد تجويع مجمّع الخيوط في مقاييس الإنتاج وتفريغات الخيوط
- تطبيق نمط الحواجز لعزل مجمّعات المنفّذات الحرجة للمدفوعات
- إعداد سياسات رفض تحافظ على استجابة النظام بدل فقدان العمل بصمت
- تجهيز المنفّذات بالمقاييس لإظهار صحة المجمّع قبل النفاد

## سياق العمل

*مثال مركّب (مبني على أنماط فشل شائعة في الصناعة، لا على شركة بعينها):* شغّل معالج مدفوعات منفّذًا مشتركًا واحدًا بـ 200 خيط لكل العمليات: تفويض المدفوعات، وفحوص الاحتيال، ودفعات التسوية، وتوليد التقارير. وفي إحدى الأمسيات طالت مهام التسوية الدفعية بسبب تراجع في أداء استعلام قاعدة بيانات. وخلال دقائق انشغلت الخيوط الـ 200 كلها بالعمل الدفعي. فبدأت تفويضات الدفع تصطف في طابور `LinkedBlockingQueue` غير المحدود للمنفّذ. وقفز زمن الاستجابة من 50ms إلى 45 ثانية. وعندما استُدعي المناوب كانت آلاف المعاملات قد انتهت مهلتها لدى العميل. وبلغ الأثر التجاري ملايين في مدفوعات ضائعة ومعكوسة. والسبب الجذري: لا عزل للمجمّعات، ولا مراقبة لعمق الطابور، وطابور غير محدود يخفي المشكلة.

## كيف يحدث نفاد مجمّع الخيوط

### التتالي

```
                   Single Shared Executor (200 threads)
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
  Payment Auth          Fraud Checks        Batch Settlement
  (fast: 50ms)         (fast: 100ms)       (slow: 60s+)
         │                    │                    │
                                           Threads fill here ───►
                                           Queue grows ──────────►
                                           Auth tasks wait ───────►
                                           Latency → timeout ─────►
```

### فخ الطابور غير المحدود

‏`LinkedBlockingQueue` بلا حد سعة أخطر إعداد افتراضي للمنفّذ:

```java
// Dangerous — this is what Executors.newFixedThreadPool() uses internally
new ThreadPoolExecutor(
    200, 200,
    0L, TimeUnit.MILLISECONDS,
    new LinkedBlockingQueue<>()   // unbounded! exhaustion hides here
);
```

السلوك تحت الحمل:
1. يبلغ المجمّع `corePoolSize` ‏(200) — كل الخيوط مشغولة
2. تصطف المهام في `LinkedBlockingQueue` — لا خيوط تُضاف ولا رفض
3. ينمو الطابور إلى عشرات الآلاف من المهام
4. يزداد الضغط على الذاكرة
5. تُنفَّذ المهام المصطفة في النهاية — لكن مهلتها انتهت لدى المستدعي
6. لا يُطلق `RejectedExecutionException` أبدًا؛ ولا شيء ينبّه

### الفرق مع ArrayBlockingQueue

```java
// Bounded queue — rejection fires when both pool and queue are full
new ThreadPoolExecutor(
    200, 200,
    0L, TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(500),     // bounded: triggers rejection at 500
    new ThreadPoolExecutor.AbortPolicy() // or a custom handler (below);
                                         // CallerRunsPolicy only for non-request work
);
```

يطلق الطابور المحدود الرفض عندما يمتلئ المجمّع والطابور معًا. واستخدم `AbortPolicy` أو معالجًا مخصصًا (أدناه)؛ و`CallerRunsPolicy` فقط للعمل الذي ليس طلبًا من مستخدم.

## نمط الحواجز: عزل المجمّعات

يعزل نمط الحواجز (من هندسة السفن — المقصورات المانعة لتسرب الماء) مجمّعات الخيوط بحيث لا يستطيع فشل في مجال أن يستنفد موارد مجال آخر.

### بنية بثلاثة مجمّعات

```
┌─────────────────────────────────────────────────────────────┐
│                   Payment Service                           │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────┐  │
│  │  payment-exec    │  │   fraud-exec     │  │batch-exec│  │
│  │  core:50 max:50  │  │  core:30 max:50  │  │core:5    │  │
│  │  queue:100       │  │  queue:500       │  │max:10    │  │
│  │                  │  │                  │  │queue:50  │  │
│  │  PAYMENT AUTH    │  │  FRAUD CHECKS    │  │BATCH JOBS│  │
│  │  SETTLEMENT      │  │  SANCTIONS       │  │REPORTS   │  │
│  └──────────────────┘  └──────────────────┘  └──────────┘  │
│                                                             │
│  batch-exec exhaustion → NO IMPACT on payment-exec         │
└─────────────────────────────────────────────────────────────┘
```

### إعداد الحواجز في Spring Boot

```java
@Configuration
public class ExecutorBulkheadConfig {

    // Critical path: payment authorisation and settlement
    @Bean(name = "paymentExecutor")
    public ThreadPoolTaskExecutor paymentExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(50);
        exec.setMaxPoolSize(50);
        exec.setQueueCapacity(100);           // small queue — fast rejection
        exec.setThreadNamePrefix("payment-");
        exec.setRejectedExecutionHandler(new PaymentRejectionHandler());
        exec.setWaitForTasksToCompleteOnShutdown(true);
        exec.setAwaitTerminationSeconds(30);
        exec.initialize();
        return exec;
    }

    // Fraud/sanctions checks — higher tolerance for queuing
    @Bean(name = "fraudExecutor")
    public ThreadPoolTaskExecutor fraudExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(30);
        exec.setMaxPoolSize(50);
        exec.setQueueCapacity(500);
        exec.setThreadNamePrefix("fraud-");
        // The caller is a payment thread: when full, the payment thread runs the
        // check itself — slower, but a fraud check is never skipped
        exec.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        exec.initialize();
        return exec;
    }

    // Non-critical: batch, reports, notifications
    @Bean(name = "batchExecutor")
    public ThreadPoolTaskExecutor batchExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(5);
        exec.setMaxPoolSize(10);
        exec.setQueueCapacity(50);
        exec.setThreadNamePrefix("batch-");
        // Never silently drop batch work: a dropped settlement or report job is
        // a missed obligation. CallerRunsPolicy slows the batch scheduler instead
        exec.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        exec.initialize();
        return exec;
    }
}
```

مجمّع المدفوعات بطابور صغير ورفض سريع. ومجمّع الاحتيال يستخدم `CallerRunsPolicy`: المستدعي خيط دفع، فعند الامتلاء ينفّذ خيط الدفع الفحص بنفسه — أبطأ، لكن فحص الاحتيال لا يُتخطى أبدًا. ومجمّع الدفعات أيضًا `CallerRunsPolicy`: لا تُسقط عمل الدفعات بصمت أبدًا — فمهمة تسوية أو تقرير مُسقطة التزام فائت.

### معالج رفض المسار الحرج

في عمليات الدفع، `DiscardPolicy` خاطئة — فقدان بيانات صامت. و`AbortPolicy` العادية آمنة لكنها ترمي استثناء عامًا بلا سجل ولا مقياس. فاستخدم معالجًا يسجّل، ويزيد المقاييس، ويُظهر استثناء ذا معنى ونوع محدد:

```java
public class PaymentRejectionHandler implements RejectedExecutionHandler {

    private static final Logger log = LoggerFactory.getLogger(PaymentRejectionHandler.class);
    private final Counter rejectedCounter;

    public PaymentRejectionHandler() {
        this.rejectedCounter = Metrics.counter("payment.executor.rejected");
    }

    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        rejectedCounter.increment();

        log.error(
            "Payment executor rejected task. Pool size={}/{}, queue={}/{}",
            executor.getPoolSize(),
            executor.getMaximumPoolSize(),
            executor.getQueue().size(),
            executor.getQueue().size() + executor.getQueue().remainingCapacity()
        );

        // Throw typed exception — callers can catch and return HTTP 503
        throw new PaymentExecutorExhaustedException(
            "Payment processing pool exhausted: " +
            executor.getPoolSize() + " threads busy, " +
            executor.getQueue().size() + " queued"
        );
    }
}
```

## اكتشاف النفاد قبل حدوثه

### مؤشر صحة المنفّذ

```java
@Component
public class ExecutorHealthIndicator implements HealthIndicator {

    @Qualifier("paymentExecutor")
    @Autowired
    private ThreadPoolTaskExecutor paymentExecutor;

    @Override
    public Health health() {
        ThreadPoolExecutor tpe = paymentExecutor.getThreadPoolExecutor();

        int active      = tpe.getActiveCount();
        int poolSize    = tpe.getPoolSize();
        int maxPool     = tpe.getMaximumPoolSize();
        int queueSize   = tpe.getQueue().size();
        int queueCap    = tpe.getQueue().size() + tpe.getQueue().remainingCapacity();
        double utilPct  = poolSize == 0 ? 0 : (double) active / maxPool * 100;
        double queuePct = queueCap == 0 ? 0 : (double) queueSize / queueCap * 100;

        // Put this indicator in the READINESS group only: DOWN then stops new
        // traffic to this instance. In the liveness group it would make
        // Kubernetes restart busy pods — and overload the remaining ones
        Health.Builder builder = utilPct > 90 || queuePct > 80
            ? Health.down()
            : utilPct > 70 || queuePct > 50
                ? Health.status("DEGRADED")   // custom status — still reported as healthy
                : Health.up();

        return builder
            .withDetail("activeThreads",  active)
            .withDetail("poolSize",       poolSize)
            .withDetail("maxPoolSize",    maxPool)
            .withDetail("utilisation",    String.format("%.1f%%", utilPct))
            .withDetail("queueSize",      queueSize)
            .withDetail("queueCapacity",  queueCap)
            .withDetail("queueFill",      String.format("%.1f%%", queuePct))
            .build();
    }
}
```

ضع هذا المؤشر في مجموعة **الجاهزية** (readiness) فقط: فحالة DOWN توقف حينها الحركة الجديدة إلى هذه النسخة. أما في مجموعة **الحيوية** (liveness) فستجعل Kubernetes يعيد تشغيل الحاويات المشغولة — فيزيد الحمل على البقية.

### مقاييس المنفّذ في Micrometer

يجهّز Spring Boot تلقائيًا حبوب `ThreadPoolTaskExecutor` بالمقاييس (موسومة باسم الحبة) عند وجود Micrometer. واربطها يدويًا فقط للمنفّذات التي لا يديرها Boot (وإلا سُجّلت المقاييس مرتين)، واعرضها لـ Prometheus/Grafana:

```java
@Bean(name = "paymentExecutor")
public ThreadPoolTaskExecutor paymentExecutor(MeterRegistry registry) {
    ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
    exec.setCorePoolSize(50);
    exec.setMaxPoolSize(50);
    exec.setQueueCapacity(100);
    exec.setThreadNamePrefix("payment-");
    exec.initialize();

    // Manual binding (only if the executor is not auto-instrumented,
    // otherwise the meters are registered twice)
    new ExecutorServiceMetrics(
        exec.getThreadPoolExecutor(),
        "payment-executor",
        List.of(Tag.of("pool", "payment"))
    ).bindTo(registry);

    return exec;
}
```

المقاييس الأساسية للتنبيه:
| المقياس | عتبة التنبيه |
|--------|----------------|
| `executor.active` / `executor.pool.max` | > 90% |
| `executor.queued` / (`executor.queued` + `executor.queue.remaining`) | > 70% |
| معدّل `executor.rejected.total` | أي قيمة غير صفرية |
| انخفاض معدّل `executor.completed.total` | انخفاض > 50% عن خط الأساس |

## نشر الضغط العكسي

يجب أن ينتشر النفاد عائدًا إلى المستدعين — لا أن يمتص الحمل الزائد بصمت.

### الضغط العكسي في طبقة HTTP

```java
@RestController
@RequestMapping("/api/payments")
public class PaymentController {

    @Autowired
    @Qualifier("paymentExecutor")
    private ThreadPoolTaskExecutor paymentExecutor;

    @Autowired
    private PaymentService paymentService;

    @PostMapping("/authorise")
    public CompletableFuture<AuthorisationResponse> authorise(
            @RequestBody AuthorisationRequest request) {

        // Check pool pressure before submitting
        ThreadPoolExecutor tpe = paymentExecutor.getThreadPoolExecutor();
        int queueSize = tpe.getQueue().size();
        int remaining = tpe.getQueue().remainingCapacity();

        if (remaining == 0 || (double) queueSize / (queueSize + remaining) > 0.9) {
            // Proactive 503 before hitting rejection handler
            throw new PaymentExecutorExhaustedException(
                "Payment service temporarily overloaded");
        }

        // Submit to the underlying ThreadPoolExecutor: ThreadPoolTaskExecutor.execute()
        // would wrap our handler's exception in Spring's TaskRejectedException
        return CompletableFuture.supplyAsync(
            () -> paymentService.authorise(request),
            tpe
        );
    }

    @ExceptionHandler(PaymentExecutorExhaustedException.class)
    public ResponseEntity<ErrorResponse> handleExhaustion(PaymentExecutorExhaustedException ex) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
            .header(HttpHeaders.RETRY_AFTER, "2")       // tell clients when to retry
            .body(ErrorResponse.of("EXECUTOR_EXHAUSTED", ex.getMessage()));
    }
}
```

يفحص المتحكم ضغط المجمّع قبل الإرسال ويعيد 503 استباقيًا. ويُرسل العمل إلى `ThreadPoolExecutor` الأساسي مباشرة، لأن `ThreadPoolTaskExecutor.execute()` كان سيغلّف استثناء معالجنا في `TaskRejectedException` من Spring. ويضيف معالج الاستثناء الترويسة `Retry-After` ليعرف العملاء متى يعيدون المحاولة.

### الخيوط الافتراضية علاجًا للنفاد (Java 21)

في أحمال الدفع كثيفة الإدخال/الإخراج، تزيل الخيوط الافتراضية نفاد **الخيوط** — فالإدخال/الإخراج الحاجب يفك خيط الحمل بدل احتجازه. لكن الحد ينتقل إلى الموارد اللاحقة الشحيحة (اتصالات قاعدة البيانات، وحدود معدّل الشركاء)، فقيّدها بحجم مجمّع الاتصالات أو بـ `Semaphore`:

```java
// Java 21: no THREAD exhaustion for I/O-bound work
@Bean(name = "paymentExecutor")
public Executor paymentExecutor() {
    // Thread-per-task with virtual threads — scales to millions
    return Executors.newVirtualThreadPerTaskExecutor();
}
```

> [!IMPORTANT]
> تحل الخيوط الافتراضية نفاد الإدخال/الإخراج لا نفاد المعالجة. فإذا كانت معالجة الدفع كثيفة المعالجة (عمليات تشفير، أو تحقق معقد)، ما زلت تحتاج مجمّعات خيوط منصة محدودة. استخدم الخيوط الافتراضية لمسار الإدخال/الإخراج، واحتفظ بمجمّع منفصل للحساب.

## إعادة النظر في التحجيم: استراتيجية عمق الطابور

| نوع الطابور | استراتيجية العمق | حالة الاستخدام |
|-----------|---------------------|----------|
| تفويض الدفع | صغير (< 2× المجمّع) | رفض سريع، والحفاظ على اتفاقية مستوى الخدمة |
| فحص الاحتيال | متوسط (5–10× المجمّع) | تحمّل الدفعات المفاجئة؛ زمن الاحتيال أقل حساسية |
| الدفعات/التقارير | كبير أو غير محدود | عمل خلفي بلا اتفاقية زمن استجابة |
| كثيف المعالجة | صغير، مع `CallerRunsPolicy` | تبطيء طبيعي للمنتج |

لتفويض دفع تستغرق فيه المهمة 50ms، مع 50 خيطًا وميزانية زمن استجابة 250ms:
- إنتاجية المجمّع: ‏50 خيطًا / 0.05 ث = 1,000 طلب/ث
- الزمن المقبول للانتظار في الطابور: ‏250ms − 50ms = 200ms
- الحد الأقصى للطابور: ‏1,000 طلب/ث × 0.2 ث = 200 مهمة — اضبط `queueCapacity=200`

## اختبار المعرفة

**س1:** لديك `ThreadPoolExecutor` بقيم `corePoolSize=10` و`maximumPoolSize=50` وطابور `LinkedBlockingQueue` غير محدود. تحت حمل مستمر، ما أقصى عدد خيوط سيُنشأ؟

**ج:** ‏10 — حجم النواة. فمع طابور غير محدود لا تُنشأ خيوط فوق `corePoolSize` إلا عندما يمتلئ الطابور. و`LinkedBlockingQueue` لا يمتلئ أبدًا، فلا يُبلغ `maximumPoolSize` أبدًا. وهذا خطأ إعداد شائع: لا تحصل على أي من سعة الذروة التي توقعتها.

**س2:** ضُبطت `CallerRunsPolicy` على منفّذ الدفع. ما الخطر في خدمة دفع؟

**ج:** ينفّذ الخيط المستدعي (عادة خيط معالج HTTP من مجمّع حاوية Tomcat) المهمة المرفوضة. فيُحجب خيط HTTP طوال مدة معالجة الدفع، فينفد مجمّع خيوط Tomcat — فتنتقل المشكلة ببساطة من منفّذ الدفع إلى حاوية الويب. استخدم استثناءات رفض محددة النوع بدلًا من ذلك، وأعد HTTP 503 فورًا.

## التحدي العملي

تستخدم خدمة الدفع لديك `ThreadPoolExecutor` مشتركًا بـ 100 خيط وطابور غير محدود. وفي ساعات الذروة تستهلك مهام التسوية الدفعية الخيوط المئة كلها، فتصطف تفويضات الدفع حتى 90 ثانية قبل انتهاء مهلتها.

**المهمة:** نفّذ بنية حواجز بالمتطلبات التالية:

1. **منفّذ الدفع:** ‏60 خيطًا، وسعة طابور 150، ورفض مخصص يزيد عدّاد Micrometer ويرمي `PaymentExecutorExhaustedException`
2. **منفّذ الدفعات:** ‏15 خيطًا، وسعة طابور 30، و`CallerRunsPolicy` (يجب ألا يُسقط عمل الدفعات بصمت أبدًا)
3. **نقطة صحة** في `/actuator/health` تُبلغ `DOWN` عندما يتجاوز استخدام خيوط منفّذ الدفع 85% أو امتلاء الطابور 75%
4. **متحكم** يعيد HTTP 503 مع الترويسة `Retry-After: 2` عند إطلاق معالج الرفض

وتحقق بكتابة اختبار إجهاد يرسل 500 مهمة دفع متزامنة و200 مهمة دفعية متزامنة، ثم يؤكد أن 400 مهمة دفع على الأقل تكتمل بنجاح (والباقي يُرفض بـ 503، لا يُسقط بصمت).

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يُعدّ ThreadPoolExecutor بقيم corePoolSize=10 وmaximumPoolSize=100 وطابور LinkedBlockingQueue غير محدود. تحت حمل عالٍ مستمر، كم خيطًا سيُنشأ فعلًا؟",
      "options": [
        "حتى 100 خيط، كما يحدد maximumPoolSize",
        "‏10 خيوط بالضبط، لأن LinkedBlockingQueue لا يمتلئ أبدًا فلا يُبلغ maximumPoolSize أبدًا",
        "‏100 خيط بالضبط فور البدء",
        "بين 10 و100 حسب عمق الطابور"
      ],
      "correct": 1,
      "explanation": "مع LinkedBlockingQueue غير محدود، لا تُنشأ خيوط فوق corePoolSize إلا عندما يمتلئ الطابور. ولأن LinkedBlockingQueue بلا حد سعة فهو لا يمتلئ أبدًا، فلا يُبلغ maximumPoolSize أبدًا. فتنتهي بـ corePoolSize خيطًا بالضبط مهما كان الحمل."
    },
    {
      "text": "تستخدم خدمة دفع CallerRunsPolicy على منفّذ الدفع. ما الخطر الأساسي لهذه السياسة على المسار الحرج للدفع؟",
      "options": [
        "تُسقط مهام الدفع بصمت عند نفاد المجمّع",
        "تجعل خيط معالج HTTP ينفّذ المهمة المرفوضة، مما قد يستنفد مجمّع خيوط حاوية الويب",
        "ترمي RejectedExecutionException فتنهار الخدمة",
        "تنشئ خيوطًا فوق maximumPoolSize فتسبب أخطاء نفاد الذاكرة"
      ],
      "correct": 1,
      "explanation": "تجعل CallerRunsPolicy الخيط المُرسل (خيط معالج HTTP) ينفّذ المهمة المرفوضة مباشرة. فيُحجب خيط HTTP طوال مدة معالجة الدفع، مما قد يستنفد مجمّع خيوط حاوية الويب (مثل Tomcat) — فتنتقل المشكلة بدل أن تُحل. وفي المسارات الحرجة للدفع أعد HTTP 503 بدلًا من ذلك."
    },
    {
      "text": "أي تركيبة مقاييس يجب أن تطلق تنبيهًا يدل على نفاد وشيك لمجمّع خيوط في منفّذ دفع؟",
      "options": [
        "معدّل executor.completed.total يزداد بثبات",
        "executor.active / executor.pool.max > 90% و executor.queued / (executor.queued + executor.queue.remaining) > 70%",
        "executor.rejected.total يساوي صفرًا",
        "executor.active.count يساوي executor.core.size"
      ],
      "correct": 1,
      "explanation": "التنبيه على استخدام الخيوط فوق 90% **و**امتلاء الطابور فوق 70% معًا يعطي إنذارًا مبكرًا قبل حدوث رفض فعلي. فانتظار rejected.total > 0 يعني أن المهام تُرفض بالفعل. والجمع بين استخدام الخيوط والطابور المرتفعين يدل على اقتراب المجمّع من حدوده، ويمكن أن يكون إشارة لإعادة 503 استباقيًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بنية حواجز لخدمة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "نفّذ إعداد حواجز بثلاثة مجمّعات باستخدام حبوب ThreadPoolTaskExecutor: منفّذ دفع (60 خيطًا، وطابور 150، وPaymentRejectionHandler مخصص يزيد عدّاد Micrometer ويرمي PaymentExecutorExhaustedException)، ومنفّذ احتيال (30 خيطًا، وطابور 500، وCallerRunsPolicy)، ومنفّذ دفعات (10 خيوط، وطابور 50، وCallerRunsPolicy — يجب ألا يُسقط عمل الدفعات بصمت أبدًا)."
    },
    {
      "id": "2",
      "description": "نفّذ PaymentRejectionHandler المخصص الذي يسجّل حالة المجمّع (الخيوط النشطة/الحد الأقصى، وحجم الطابور/سعته)، ويزيد عدّاد Micrometer باسم 'payment.executor.rejected'، ويرمي PaymentExecutorExhaustedException برسالة وصفية تتضمن مقاييس المجمّع الحالية."
    },
    {
      "id": "3",
      "description": "نفّذ ExecutorHealthIndicator (يطبّق HealthIndicator) يُبلغ DOWN عندما يتجاوز استخدام خيوط منفّذ الدفع 85% أو امتلاء الطابور 75%، وUP بخلاف ذلك. وأضفه إلى مجموعة صحة الجاهزية فقط (لا الحيوية)، مع تفاصيل تشمل activeThreads ونسبة الاستخدام وqueueSize ونسبة queueFill."
    },
    {
      "id": "4",
      "description": "نفّذ PaymentController بنقطة /api/payments/authorise تفحص امتلاء الطابور استباقيًا قبل الإرسال (وتعيد HTTP 503 مع الترويسة Retry-After: 2 عندما يتجاوز الامتلاء 90%)، ومعالج استثناء يحوّل PaymentExecutorExhaustedException إلى HTTP 503. واكتب اختبار إجهاد متزامنًا بـ 500 مهمة دفع و200 مهمة دفعية في الوقت نفسه، يؤكد أن 400 مهمة دفع على الأقل تكتمل بنجاح وأن لا شيء يُسقط بصمت."
    }
  ]
}
-->
