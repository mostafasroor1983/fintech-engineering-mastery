---
id: track-07-lesson-14
title: "تحديد حجم مجمّعات الخيوط — قانون Little والتزامن الأمثل"
slug: thread-pool-sizing
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 14
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [thread-pool, Little's-law, queuing-theory, executor, sizing]
prerequisites: []
---

# تحجيم مجمعات الخيوط — قانون Little والتزامن الأمثل

> [!NOTE]
> مجمعات الخيوط الأصغر من اللازم تسبب اصطفاف الطلبات وقفزات الزمن تحت الحمل. والمجمعات الأكبر من اللازم تهدر الذاكرة (كل خيط منصة يحجز مكدسًا، نحو 1 ميغابايت افتراضيًا، بالإضافة إلى موارد النواة)، وتزيد تبديل السياق، وتخفض الإنتاجية. ويوفر قانون Little الأساس الرياضي لتحجيم مجمعات الخيوط بشكل صحيح لمعالجات الدفع — لكن المعادلة تتطلب قياس زمن الخدمة الفعلي ومعدل الوصول في ظروف الإنتاج.

## كلفة الخطأ في تحجيم مجمعات الخيوط

*مثال مركّب:* تشهد خدمة معالجة دفع قفزات في زمن p99 من 85 مللي ثانية إلى أكثر من 4 ثوانٍ خلال ساعات الذروة. والسبب الجذري: مجمع خيوط مضبوط بـ 50 خيطًا (رقم "يبدو معقولًا") لخدمة تستقبل 800 طلب في الثانية بزمن متوسط 120 مللي ثانية. ويخبرك قانون Little فورًا لماذا يفشل هذا: تحتاج L = λW = 800 × 0.120 = **96 خيطًا متزامنًا** في الحالة المستقرة، دون أي هامش للقفزات.

مجمعات الخيوط سيئة الإعداد من أكثر مصادر تراجع الزمن شيوعًا في الخدمات المالية — ومن أسهلها إصلاحًا متى فهمت نظرية الطوابير الكامنة.

## قانون Little — الأساس

ينص قانون Little على أنه في نظام طوابير مستقر:

```
L = λ × W

Where:
  L = average number of requests in the system (being served + waiting)
  λ = average arrival rate (requests per second)
  W = average time each request spends in the system (service latency in seconds)
```

يسري هذا القانون بغض النظر عن توزيع الوصول، أو توزيع زمن الخدمة، أو عدد الخوادم. وهو متين على نحو لافت.

### تطبيق قانون Little على خدمات الدفع

```
Payment authorization service:
  λ (arrival rate)    = 500 requests/second at peak
  W (avg latency)     = 150ms = 0.150s
  L (threads needed)  = 500 × 0.150 = 75 threads

Add headroom for a slowdown (if latency for ALL requests rose to
today's p99 of ≈ 400ms, e.g. a slow downstream):
  L (slow scenario)   = 500 × 0.400 = 200 threads
  (Little's Law uses averages -- this is a planning heuristic, not a law)

Sizing recommendation:
  corePoolSize   = 75   (steady state)
  maxPoolSize    = 200  (p99 spike headroom)
  queueCapacity  = 50   (small queue to fail fast vs accumulate backlog)
```

**كيف ينمو `ThreadPoolExecutor` فعلًا** (مفاجأة متكررة): مع طابور محدود ينشئ خيوطًا حتى `corePoolSize`، ثم يضع المهام الجديدة في **الطابور**، ولا يضيف خيوطًا حتى `maxPoolSize` إلا حين يكون الطابور **ممتلئًا**. فلا يُبلغ عدد الخيوط "الأقصى" إلا بعد امتلاء الطابور — سبب آخر لإبقاء الطابور صغيرًا (أو جعل core كبيرًا بما يكفي للذروات المعتادة).

## تحليل الأحمال المقيدة بالمعالج مقابل المقيدة بالإدخال/الإخراج

يعتمد تحجيم مجمع الخيوط كثيرًا على كون حملك مقيدًا بالمعالج أو بالإدخال/الإخراج.

### الأحمال المقيدة بالمعالج

```
Optimal threads ≈ number of CPU cores (N_cpu)
                = Runtime.getRuntime().availableProcessors()
                  (container-aware: reflects the CPU limit on modern JVMs)

For a fraud scoring service doing ML inference:
  N_cpu = 16 cores
  corePoolSize = 16
  maxPoolSize  = 16  (more threads = more context switching, not more throughput)

Adding threads beyond N_cpu for CPU-bound work increases context switching overhead
without increasing throughput — the CPU is already saturated.
```

### الأحمال المقيدة بالإدخال/الإخراج

```
Optimal threads = N_cpu × (1 + W/C)

Where:
  W = average IO wait time per request
  C = average CPU compute time per request

For a payment gateway calling external APIs:
  N_cpu = 16 cores
  W     = 95ms (network IO wait — JDBC, HTTP calls)
  C     = 5ms  (actual CPU work — parsing, validation)
  W/C   = 95/5 = 19

  Optimal threads = 16 × (1 + 19) = 320 threads

This represents the classic IO-bound multiplier: each core can handle
19 IO-waiting threads while 1 thread is doing CPU work.
```

### قياس W وC في الإنتاج

```java
@Component
public class ThreadPoolSizingMetrics {

    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    private final MeterRegistry meterRegistry;

    public ThreadPoolSizingMetrics(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    /**
     * Measure, for one request, wall time and the CPU time this thread used.
     * W (waiting) = wall - CPU;  C = CPU.
     * Run under realistic load to get real W and C values.
     */
    public <T> T measure(String operationName, Callable<T> work) throws Exception {
        long wallStart = System.nanoTime();
        long cpuStart  = THREADS.getCurrentThreadCpuTime();   // CPU time, not wall time
        try {
            return work.call();
        } finally {
            long cpu  = THREADS.getCurrentThreadCpuTime() - cpuStart;
            long wall = System.nanoTime() - wallStart;
            meterRegistry.timer(operationName + ".cpu.time")
                .record(cpu, TimeUnit.NANOSECONDS);
            meterRegistry.timer(operationName + ".wait.time")
                .record(Math.max(0, wall - cpu), TimeUnit.NANOSECONDS);
            // Compute W/C in your dashboard from the two timers' means.
            // (Do not call meterRegistry.gauge(name, double) per request: it
            //  registers once and never updates.)
        }
    }
}
```

## تعمق في معاملات ThreadPoolExecutor

```java
public class PaymentThreadPoolFactory {

    /**
     * Purpose-built thread pool for payment authorization service.
     *
     * Parameters explained:
     *   corePoolSize   = minimum threads kept alive (even when idle)
     *   maxPoolSize    = maximum threads ever created
     *   keepAliveTime  = how long idle threads above core survive
     *   workQueue      = queue for tasks when all core threads are busy
     *   threadFactory  = names threads for debugging
     *   rejectedHandler= what to do when queue is full AND maxPool threads are busy
     */
    public static ThreadPoolExecutor buildPaymentAuthorizationPool(
            int corePoolSize,    // from Little's Law steady state
            int maxPoolSize,     // from Little's Law p99 scenario
            int queueCapacity) { // keep small to fail fast

        BlockingQueue<Runnable> workQueue = queueCapacity > 0
            ? new LinkedBlockingQueue<>(queueCapacity)  // bounded — rejects when full
            : new SynchronousQueue<>();                 // zero queue: reject immediately

        ThreadFactory namedFactory = new ThreadFactoryBuilder()
            .setNameFormat("payment-auth-%d")
            .setDaemon(false)   // non-daemon; still shut the pool down gracefully
            .build();

        ThreadPoolExecutor executor = new ThreadPoolExecutor(
            corePoolSize,
            maxPoolSize,
            60, TimeUnit.SECONDS,  // idle thread timeout
            workQueue,
            namedFactory,
            new PaymentRejectedExecutionHandler()  // custom rejection handler
        );

        // Allow core threads to time out when idle — saves memory in off-peak hours
        executor.allowCoreThreadTimeOut(true);

        return executor;
    }

    /**
     * Custom rejection handler for payment operations.
     * Callers MUST handle RejectedExecutionException and return HTTP 503.
     * Never silently drop payment requests.
     */
    static class PaymentRejectedExecutionHandler implements RejectedExecutionHandler {

        private final Counter rejectedCounter;

        PaymentRejectedExecutionHandler() {
            this.rejectedCounter = Counter.builder("payment.thread.pool.rejected")
                .description("Payment requests rejected due to thread pool saturation")
                .register(Metrics.globalRegistry);
        }

        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
            rejectedCounter.increment();
            // Log pool state for capacity planning
            log.warn("Payment thread pool saturated: active={}, queue={}, maxPool={}",
                executor.getActiveCount(),
                executor.getQueue().size(),
                executor.getMaximumPoolSize());
            // Throw so the caller gets a 503, not a silent drop
            throw new RejectedExecutionException(
                "Payment authorization pool saturated — apply backpressure");
        }
    }
}
```

## أثر عمق الطابور على الزمن

عمق الطابور معامل حاسم لكنه كثيرًا ما يُساء فهمه. فالطابور الكبير يخفي التشبع ويخلق قفزات زمن.

```java
/**
 * Demonstration of queue depth impact on p99 latency.
 *
 * Scenario: Payment auth service, 150ms avg latency, 100 threads
 * Load test at 800 req/s (pool capacity ≈ 100/0.15 = 667 req/s)
 *
 * Arrivals exceed capacity by 800 - 667 = 133 req/s, so the queue grows
 * by ~133 requests EVERY SECOND for as long as the overload lasts.
 *
 * With queue=1000:
 *   - Service appears healthy (no errors) for ~7.5 s while the queue fills
 *   - A full queue means each new request waits 1000 / 667 ≈ 1.5 s extra
 *   - p99 latency ≈ 150ms + 1.5 s, and then rejections start anyway
 *   - With queue=10_000: ~75 s of silent build-up and ~15 s waits
 *
 * With queue=50:
 *   - Extra wait is at most 50 / 667 ≈ 75 ms
 *   - Service returns HTTP 503 when overloaded
 *   - Caller applies exponential backoff and retries
 *   - Successful requests keep near-normal latency
 *   - Clients see failures immediately, not delayed timeouts
 *
 * Recommendation: Keep queue short. Fail fast is better than slow degradation.
 */
public class QueueDepthExample {

    // BAD: large queue accumulates invisible backlog
    private final ThreadPoolExecutor badPool = new ThreadPoolExecutor(
        100, 100, 0, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(10_000),  // hides saturation for minutes
        Executors.defaultThreadFactory(),
        new AbortPolicy()
    );

    // GOOD: small queue exposes saturation immediately
    private final ThreadPoolExecutor goodPool = new ThreadPoolExecutor(
        100, 150, 60, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(50),      // fail fast when saturated
        new ThreadFactoryBuilder().setNameFormat("payment-fast-%d").build(),
        new AbortPolicy()  // throw RejectedExecutionException → 503
    );
}
```

## مراقبة مجمعات الخيوط باستخدام Micrometer

```java
@Component
public class ThreadPoolMetricsRegistrar {

    private final MeterRegistry meterRegistry;
    private final ThreadPoolExecutor pool;   // the pool the service REALLY uses

    public ThreadPoolMetricsRegistrar(MeterRegistry meterRegistry,
                                      @Qualifier("paymentAuthPool") ThreadPoolExecutor pool) {
        this.meterRegistry = meterRegistry;
        this.pool = pool;
    }

    /**
     * Register all thread pool metrics with Micrometer.
     * These feed dashboards showing pool utilisation, queue depth, and rejection rate.
     * Alert thresholds: pool utilisation > 80%, queue depth > 20.
     */
    @PostConstruct
    public void registerMetrics() {
        // (Creating a NEW pool here would monitor an executor nobody uses.)

        // Pool utilisation — alert > 80%
        Gauge.builder("thread.pool.active", pool, ThreadPoolExecutor::getActiveCount)
            .tag("pool", "payment-auth")
            .description("Active threads processing payment authorizations")
            .register(meterRegistry);

        Gauge.builder("thread.pool.size", pool, ThreadPoolExecutor::getPoolSize)
            .tag("pool", "payment-auth")
            .register(meterRegistry);

        Gauge.builder("thread.pool.queue.size", pool, e -> e.getQueue().size())
            .tag("pool", "payment-auth")
            .description("Queued payment requests waiting for a thread")
            .register(meterRegistry);

        Gauge.builder("thread.pool.utilisation", pool,
            e -> (double) e.getActiveCount() / e.getMaximumPoolSize())
            .tag("pool", "payment-auth")
            .description("Pool utilisation ratio (0.0 to 1.0)")
            .register(meterRegistry);

        // Completed task count (use rate() in Prometheus queries)
        FunctionCounter.builder("thread.pool.completed", pool,
            ThreadPoolExecutor::getCompletedTaskCount)
            .tag("pool", "payment-auth")
            .register(meterRegistry);
    }

    /**
     * Prometheus alerting rules (prometheus-rules.yml):
     *
     * - alert: PaymentPoolSaturated
     *   expr: thread_pool_utilisation{pool="payment-auth"} > 0.8
     *   for: 2m
     *   annotations:
     *     summary: "Payment auth thread pool at {{ $value | humanizePercentage }} utilisation"
     *
     * - alert: PaymentQueueBuilding
     *   expr: thread_pool_queue_size{pool="payment-auth"} > 20
     *   for: 1m
     *   annotations:
     *     summary: "{{ $value }} payment requests queued — pool may be undersized"
     */
}
```

## التحجيم لمعالجات الدفع — سيناريو انتظار إدخال/إخراج مرتفع

مثال عملي كامل لمعالج دفع:

```java
/**
 * Payment Processing Service — Thread Pool Sizing Analysis
 *
 * Illustrative service profile:
 *   - Receives 1,200 payment requests/second at peak
 *   - Each request makes 3 downstream calls:
 *       1. Fraud service: 45ms avg, 95ms p99
 *       2. Database read (account limits): 8ms avg, 25ms p99
 *       3. Payment gateway (Visa/MC): 85ms avg, 220ms p99
 *   - Total end-to-end latency: 140ms avg, 380ms p99
 *   - Server has 32 CPU cores
 *   - CPU utilisation per request: ~5ms (parsing, validation, serialization)
 *
 * Calculations:
 *   W/C ratio = 135ms IO / 5ms CPU = 27
 *   Theoretical optimal = 32 × (1 + 27) = 896 threads
 *
 *   But: validate with Little's Law:
 *   L (steady) = 1200 × 0.140 = 168 threads
 *   L (p99)    = 1200 × 0.380 = 456 threads
 *
 *   Take the lower of formula and Little's Law for initial sizing,
 *   then tune based on monitoring.
 *
 *   Recommendation:
 *     corePoolSize  = 168   (Little's Law steady state)
 *     maxPoolSize   = 456   (slow-downstream scenario; only reached after
 *                            the queue is full -- see "How ThreadPoolExecutor
 *                            actually grows")
 *     queueCapacity = 50    (fail fast — small buffer only for burst smoothing)
 *
 *   Also check what the threads WAIT on: 456 threads calling a database
 *   through a 30-connection pool just queue inside the connection pool.
 */
@Configuration
public class PaymentProcessorPoolConfig {

    @Value("${payment.pool.core-size:168}")
    private int coreSize;

    @Value("${payment.pool.max-size:456}")
    private int maxSize;

    @Value("${payment.pool.queue-capacity:50}")
    private int queueCapacity;

    @Bean("paymentAuthorizationExecutor")
    public ThreadPoolTaskExecutor paymentAuthorizationExecutor(
            MeterRegistry meterRegistry) {

        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(coreSize);
        executor.setMaxPoolSize(maxSize);
        executor.setQueueCapacity(queueCapacity);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("payment-auth-");
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);

        // Abort policy: throw RejectedExecutionException for circuit breaker to catch
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.initialize();

        // Register metrics
        ExecutorServiceMetrics.monitor(
            meterRegistry,
            executor.getThreadPoolExecutor(),
            "payment-auth",
            "pool", "payment-auth"
        );

        return executor;
    }

    /**
     * Separate pool for bulk/batch payment processing.
     * Bulk jobs are lower priority — use separate pool to prevent
     * bulk operations from starving real-time authorization requests.
     */
    @Bean("bulkPaymentExecutor")
    public ThreadPoolTaskExecutor bulkPaymentExecutor(MeterRegistry meterRegistry) {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setMaxPoolSize(30);
        executor.setQueueCapacity(10_000);  // bulk can queue — latency less critical
        executor.setThreadNamePrefix("payment-bulk-");
        // (Thread priorities are mostly ignored by the OS scheduler on Linux;
        //  isolation comes from the SEPARATE pool, not from priority.)
        executor.initialize();

        ExecutorServiceMetrics.monitor(
            meterRegistry, executor.getThreadPoolExecutor(),
            "payment-bulk", "pool", "payment-bulk");

        return executor;
    }
}
```

## أثر الخيوط الافتراضية على التحجيم

تغيّر الخيوط الافتراضية في Java 21 جذريًا نموذج التحجيم للأحمال المقيدة بالإدخال/الإخراج:

```java
@Configuration
@ConditionalOnProperty("payment.virtual-threads.enabled")
public class VirtualThreadPoolConfig {

    /**
     * With virtual threads, the optimal "pool size" question changes:
     *
     * Platform threads: limited resource, stack ~1MB each
     *   → size carefully to match L = λW
     *
     * Virtual threads: cheap, millions possible, ~few KB each
     *   → no pool needed for IO-bound work; use one virtual thread per request
     *
     * The platform thread pool underneath (carrier threads) should be:
     *   coreSize = N_cpu (default: matches availableProcessors())
     *
     * For payment processors: replace ThreadPoolExecutor with virtual threads
     * and let the JVM scheduler manage carrier thread allocation.
     */
    @Bean("paymentVirtualExecutor")
    public ExecutorService paymentVirtualExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }

    /**
     * Spring Boot 3.2+ — enable virtual threads globally:
     *
     * spring.threads.virtual.enabled=true
     *
     * This switches Tomcat's request handling, @Async, and @Scheduled
     * to virtual threads automatically. No explicit pool sizing needed
     * for IO-bound workloads.
     *
     * CAVEATS:
     * - Before JDK 24, blocking inside synchronized pins the carrier thread
     *   (covered in lesson 15); JDK 24 (JEP 491) removed most of this.
     * - Without a pool, nothing limits concurrency any more: 10,000 virtual
     *   threads can all try to use a 30-connection DB pool or a rate-limited
     *   gateway. Limit access to scarce resources explicitly (connection
     *   pools, Semaphore, bulkheads).
     */
}
```

## التحجيم التكيفي للمجمع

للخدمات التي يتغير حملها كثيرًا بين ساعات العمل وخارج الذروة:

```java
@Component
@Slf4j
public class AdaptivePoolSizer {

    private final ThreadPoolTaskExecutor pool;
    private final MeterRegistry meterRegistry;
    private final AtomicInteger targetMax = new AtomicInteger();
    private long lastCount = -1;
    private double lastTotalSeconds;
    private long lastSampleNanos;

    public AdaptivePoolSizer(@Qualifier("paymentAuthorizationExecutor") ThreadPoolTaskExecutor pool,
                             MeterRegistry meterRegistry) {
        this.pool = pool;
        this.meterRegistry = meterRegistry;
        meterRegistry.gauge("thread.pool.target.size",
            Tags.of("pool", "payment-auth"), targetMax);      // registered ONCE
    }

    /**
     * Resize the pool from RECENT Little's Law inputs, every 30 seconds.
     * Caution: if latency rises because a downstream is struggling, adding
     * threads sends it MORE concurrent load. Keep firm upper bounds.
     */
    @Scheduled(fixedRate = 30_000)
    public void adjustPoolSize() {
        Timer timer = meterRegistry.find("http.server.requests")
            .tag("uri", "/v1/payments/authorize").timer();
        if (timer == null) return;

        long count = timer.count();
        double totalSeconds = timer.totalTime(TimeUnit.SECONDS);
        long now = System.nanoTime();
        if (lastCount < 0) {                       // first sample: just remember
            lastCount = count; lastTotalSeconds = totalSeconds; lastSampleNanos = now;
            return;
        }

        long requests = count - lastCount;
        double elapsed = (now - lastSampleNanos) / 1e9;
        double arrivalRate = requests / elapsed;                     // λ: req/s
        double avgLatency = requests > 0
            ? (totalSeconds - lastTotalSeconds) / requests : 0.150;  // W: seconds
        lastCount = count; lastTotalSeconds = totalSeconds; lastSampleNanos = now;

        // Little's Law: L = λW, plus 50% headroom, clamped to safe bounds
        int steadyState = (int) Math.ceil(arrivalRate * avgLatency);
        int newCore = Math.max(10, Math.min(steadyState, 500));
        int newMax  = Math.max(newCore, Math.min((int) (steadyState * 1.5), 600));

        if (newMax != pool.getMaxPoolSize() || newCore != pool.getCorePoolSize()) {
            log.info("Resizing payment pool: core={}->{} max={}->{} (λ={} req/s, W={} ms)",
                pool.getCorePoolSize(), newCore, pool.getMaxPoolSize(), newMax,
                Math.round(arrivalRate), Math.round(avgLatency * 1000));

            // Order matters: core may never exceed max (IllegalArgumentException)
            if (newMax >= pool.getMaxPoolSize()) {
                pool.setMaxPoolSize(newMax);
                pool.setCorePoolSize(newCore);
            } else {
                pool.setCorePoolSize(newCore);
                pool.setMaxPoolSize(newMax);
            }
            targetMax.set(newMax);
        }
    }
}
```

## أخطاء التحجيم الشائعة في الخدمات المالية

| الخطأ | الأثر | الإصلاح |
|---------|--------|-----|
| ‏`corePoolSize = 10, maxPoolSize = 200, queue = 10000` | ‏10,000 طلب تصطف بصمت؛ وp99 يقفز إلى دقائق | اضبط `queue = 50`، ودع المستدعين يرون 503 ويعيدون المحاولة |
| ‏`maxPoolSize = Integer.MAX_VALUE` | نفاد الذاكرة تحت الحمل — إنشاء ملايين الخيوط | حدّه بتقدير p99 من قانون Little + هامش |
| المجمع نفسه للفوري والدفعي | المهام الدفعية تملأ المجمع وتحجب التفويضات | مجمعات منفصلة للأحمال الفورية مقابل الدفعية |
| عدم مراقبة مقاييس المجمع أبدًا | مشكلات التحجيم غير مرئية حتى الانقطاع | نبّه على استخدام > 80% وعمق طابور > 20 |
| ‏`corePoolSize = maxPoolSize = 500` | ‏500 خيط تبقى حية في الخمول، تحجز نحو 500 ميغابايت من فضاء عناوين المكدس بالإضافة إلى موارد النواة | استخدم `allowCoreThreadTimeOut(true)` وcore منخفضًا |
| حجم المجمع مكتوب في الشيفرة | لا يمكن الضبط دون إعادة نشر | أخرجه إلى الإعداد عبر `@Value` / إعداد Spring |

## مرجع قرار التحجيم

```
┌─────────────────────────────────────────────────────────────────┐
│                   Thread Pool Sizing Checklist                  │
├─────────────────────────────────────────────────────────────────┤
│ 1. Measure λ (arrival rate) under peak load                     │
│ 2. Measure W (avg latency) including p99                        │
│ 3. Calculate L = λW for steady state                            │
│ 4. Calculate L_p99 = λ × W_p99 for spike headroom              │
│ 5. Set corePoolSize = L (steady state)                          │
│ 6. Set maxPoolSize = L_p99 (used only once the queue is full)   │
│ 7. Set queueCapacity = small (10-100) for real-time services    │
│ 8. Register pool metrics with Micrometer                        │
│ 9. Alert on utilisation > 80%, queue depth > 20                 │
│10. Separate pools for real-time vs batch workloads              │
│11. Consider virtual threads for IO-bound Java 21 services       │
└─────────────────────────────────────────────────────────────────┘
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تعالج خدمة تفويض دفع 500 طلب في الثانية بزمن متوسط 20 مللي ثانية. باستخدام قانون Little، ما حجم مجمع الخيوط المطلوب للتشغيل في الحالة المستقرة؟",
      "options": [
        "5 خيوط",
        "10 خيوط",
        "25 خيطًا",
        "500 خيط"
      ],
      "correct": 1,
      "explanation": "قانون Little: ‏L = λ × W. ‏λ = 500 طلب/ثانية، وW = 0.020 ثانية. ‏L = 500 × 0.020 = 10 خيوط. وهذا هو التزامن في الحالة المستقرة. ويجب تحجيم المجمع إلى L في الحالة المستقرة، مع maxPoolSize عند L_p99 للتعامل مع القفزات."
    },
    {
      "text": "لماذا يكون ضبط corePoolSize=10، وmaxPoolSize=200، وqueueCapacity=10000 خطيرًا لخدمة تفويض دفع؟",
      "options": [
        "الطابور صغير جدًا؛ وستُرفض الطلبات فورًا عند 11 طلبًا متزامنًا",
        "مع طابور من 10,000 عنصر، تُخفى قفزات الزمن — فقد يصطف 10,000 طلب بصمت بينما يصعد زمن الاستجابة المتوسط إلى دقائق، ولا يستلم المستدعون أي إشارة ضغط عكسي",
        "maxPoolSize=200 ينشئ خيوطًا كثيرة جدًا؛ فلا يستطيع JVM إدارة أكثر من 100 خيط",
        "يجب أن يتساوى corePoolSize وmaxPoolSize دائمًا؛ والقيم المختلفة تسبب حالات تسابق"
      ],
      "correct": 1,
      "explanation": "طابور من 10,000 عنصر يعني أن المجمع لن ينشئ خيوطًا إضافية بعد corePoolSize حتى يمتلئ الطابور. وأثناء تباطؤ قاعدة البيانات، يصطف 10,000 طلب بصمت وينتظر كل منها تصريف الطابور. وقد يبلغ زمن P99 دقائق بينما تبدو الخدمة متعاملة مع الحمل. فأبقِ queueCapacity صغيرًا (50–100) لإظهار الضغط العكسي للمستدعين فورًا."
    },
    {
      "text": "متى يجب استخدام مجمعات خيوط منفصلة لعمليات دفع مختلفة بدل مجمع مشترك واحد؟",
      "options": [
        "دائمًا — يجب أن يكون لكل نوع عملية دفع مجمع خيوط خاص للصحة",
        "حين قد يُجوّع نوع حمل بطيء أو متقطع (التسوية الدفعية) الأحمال الحساسة للوقت (التفويض الفوري) بشغل كل خيوط المجمع",
        "فقط حين تعالج الخدمة أكثر من 10,000 معاملة في الثانية",
        "عزل مجمعات الخيوط مطلوب فقط للخدمات التفاعلية؛ والخدمات الحاجبة يمكنها مشاركة المجمعات"
      ],
      "correct": 1,
      "explanation": "إذا تشاركت مهام التسوية الدفعية والتفويض الفوري مجمع خيوط، فقد تملأ مهام التسوية كل خيوط المجمع أثناء تشغيل دفعة، فلا تبقى خيوط للتفويضات. وتتطلب SLAs الدفع تفويضًا في أقل من 100 مللي ثانية؛ والمجمع المشترك مع التسوية يخلق زمنًا بلا حدود. فاستخدم مجمعات منفصلة بتحجيم ومراقبة وحدود طوابير منفصلة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تحجيم مجمعات الخيوط ومراقبتها لخدمة تفويض دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "باستخدام قانون Little، احسب corePoolSize، وmaxPoolSize، وqueueCapacity لخدمة تفويض دفع تتعامل مع 1000 طلب/ثانية عند P50=15 مللي ثانية، وP99=80 مللي ثانية، بهدف SLO قدره 150 مللي ثانية P99."},
    {"id": "2", "description": "أنشئ صنف PaymentThreadPoolConfig يعرّف أوعية ThreadPoolTaskExecutor منفصلة للتفويض الفوري، والتسوية الدفعية، والإشعارات غير المتزامنة، لكل منها تحجيم مناسب وإعداد خارجي عبر @Value."},
    {"id": "3", "description": "نفّذ مقاييس Micrometer لكل مجمع: الخيوط النشطة، وعمق الطابور، والمهام المكتملة، وعدد الرفض. واضبط تنبيهات حين يتجاوز الاستخدام 80% أو يتجاوز عمق الطابور 20."},
    {"id": "4", "description": "اكتب اختبار حمل باستخدام ExecutorService يحاكي 1500 طلب/ثانية مستمرة لمدة 30 ثانية و3000 طلب/ثانية لقفزة مدتها 5 ثوانٍ، ثم يرسم استخدام المجمع عبر الزمن للتحقق من التحجيم."}
  ]
}
-->
