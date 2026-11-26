---
id: track-07-lesson-15
title: "أداء الخيوط الافتراضية — قياس Java 21"
slug: virtual-threads-performance
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 15
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [virtual-threads, java-21, benchmarking, pinning, carrier-thread]
prerequisites: []
---

# أداء الخيوط الافتراضية — قياس Java 21

> [!NOTE]
> الخيوط الافتراضية ليست أسرع من خيوط المنصة للعمل المقيد بالمعالج — بل توفر إنتاجية أعلى للأحمال المقيدة بالإدخال/الإخراج بإتاحة ملايين الخيوط الخفيفة المتزامنة دون حمل الذاكرة الخاص بخيوط المنصة. ولمعالجات الدفع التي تقضي معظم وقت كل طلب في انتظار الإدخال/الإخراج (قاعدة البيانات، وواجهات الاحتيال، وشبكات الدفع)، تزيل الخيوط الافتراضية سقف مجمع الخيوط عن التزامن بتغيير قليل في الشيفرة أو بلا تغيير — ثم ترتفع الإنتاجية حتى يُبلغ الحد التالي (اتصالات قاعدة البيانات، أو حدود المعدل في الخدمات اللاحقة، أو المعالج).

## ما الخيوط الافتراضية؟

الخيوط الافتراضية (Project Loom، متاحة رسميًا في Java 21) خيوط يديرها JVM وتعمل فوق مجمع صغير من خيوط نظام التشغيل تُسمى **الخيوط الحاملة (carrier threads)**. ويركّب مجدول JVM الخيوط الافتراضية على الخيوط الحاملة حين تحتاج للتنفيذ ويفكها حين تحجب على الإدخال/الإخراج — فيصبح الخيط الحامل متاحًا لخيط افتراضي آخر.

```
Platform Thread Model (before Java 21):
  OS Thread 1 → waiting on DB query (CPU idle, memory consumed)
  OS Thread 2 → waiting on fraud API (CPU idle, memory consumed)
  OS Thread 3 → waiting on payment gateway (CPU idle, memory consumed)
  ... 300 threads idle-waiting = 300 OS threads, each with its own
      stack (~1MB reserved, part of it committed) and kernel resources

Virtual Thread Model (Java 21):
  Carrier Thread 1 → running VThread A (DB just returned)
  Carrier Thread 2 → running VThread B (fraud API just returned)
  VThread C, D, E, F ... Z all mounted/unmounted as IO completes
  ... 10,000 parked virtual threads = a few to a few tens of MB of heap
      (their stacks are small heap objects), 8 carrier threads (N_cpu)
```

## مقاييس الإنتاجية — JMH

```java
@BenchmarkMode({Mode.Throughput, Mode.AverageTime})
@OutputTimeUnit(TimeUnit.SECONDS)
@State(Scope.Benchmark)
@Fork(value = 2, jvmArgs = {"-Xms4g", "-Xmx4g"})   // virtual threads are final in Java 21: no --enable-preview
@Warmup(iterations = 5, time = 10)
@Measurement(iterations = 10, time = 10)
public class VirtualThreadsBenchmark {

    // Simulates a payment authorization: 100ms IO wait + 1ms CPU
    private static final long IO_WAIT_MILLIS   = 100;
    private static final long CPU_WORK_MILLIS  = 1;
    private static final int  CONCURRENT_TASKS = 1000;

    private ExecutorService platformPool;
    private ExecutorService virtualPool;

    @Setup
    public void setup() {
        // Platform thread pool — typical production sizing
        platformPool = Executors.newFixedThreadPool(200);  // Little's Law sizing

        // Virtual thread executor — no pool needed; create per task
        virtualPool = Executors.newVirtualThreadPerTaskExecutor();
    }

    @TearDown
    public void tearDown() {
        platformPool.shutdown();
        virtualPool.shutdown();
    }

    // ── Throughput: Platform Threads ──────────────────────────────────────

    @Benchmark
    public long platformThreadThroughput() throws InterruptedException {
        List<Future<Long>> futures = new ArrayList<>(CONCURRENT_TASKS);

        for (int i = 0; i < CONCURRENT_TASKS; i++) {
            futures.add(platformPool.submit(() -> simulatePaymentAuth()));
        }

        long sum = 0;
        for (Future<Long> f : futures) {
            try { sum += f.get(); } catch (ExecutionException e) { /* ignore */ }
        }
        return sum;
    }

    // ── Throughput: Virtual Threads ───────────────────────────────────────

    @Benchmark
    public long virtualThreadThroughput() throws InterruptedException {
        List<Future<Long>> futures = new ArrayList<>(CONCURRENT_TASKS);

        for (int i = 0; i < CONCURRENT_TASKS; i++) {
            futures.add(virtualPool.submit(() -> simulatePaymentAuth()));
        }

        long sum = 0;
        for (Future<Long> f : futures) {
            try { sum += f.get(); } catch (ExecutionException e) { /* ignore */ }
        }
        return sum;
    }

    private long simulatePaymentAuth() throws InterruptedException {
        // Simulate IO wait (database + fraud API + payment network)
        Thread.sleep(IO_WAIT_MILLIS);  // virtual thread: unmounts carrier; platform: blocks OS thread

        // Simulate CPU work (parsing, validation, serialization)
        long result = 0;
        long deadline = System.currentTimeMillis() + CPU_WORK_MILLIS;
        while (System.currentTimeMillis() < deadline) {
            result += System.nanoTime() % 1000;  // keep CPU busy
        }
        return result;
    }
}
```

نتائج توضيحية على جهاز بـ 16 نواة (Java 21). ويمكنك توقعها بحساب بسيط — وهذا هو المقصود:

```
Benchmark                                         Mode  Cnt    Score    Error   Units
VirtualThreadsBenchmark.platformThreadThroughput  thrpt  20    1.9 ±  0.1   ops/s
VirtualThreadsBenchmark.virtualThreadThroughput   thrpt  20    5.8 ±  0.3   ops/s

Platform pool of 200: 1000 tasks run in 5 "waves" of ~101 ms  -> ~0.51 s per op
Virtual threads: all 1000 sleep at once (100 ms), then 1000 × 1 ms of CPU
spread over 16 cores (~63 ms)                                  -> ~0.17 s per op
```

درسان من هذا الحساب: يأتي المكسب من إزالة حد الـ 200 خيط (مجمع منصة من 1,000 خيط سيؤدي قريبًا من ذلك هنا)، ومع زيادة عمل المعالج لكل طلب تصبح الأنوية — لا الخيوط — هي الحد (فمع 5 مللي ثانية من المعالج لكل مهمة، يستغرق تشغيل الخيوط الافتراضية نحو 0.41 ثانية أصلًا).

## مقارنة البصمة في الذاكرة

```java
/**
 * Memory footprint measurement — platform vs virtual threads.
 *
 * Where the memory lives:
 *  - Platform thread stacks are NATIVE memory (outside the heap): ~1MB is
 *    reserved per thread, but only the pages actually used are committed.
 *    Measure them with Native Memory Tracking:
 *      java -XX:NativeMemoryTracking=summary ...
 *      jcmd <pid> VM.native_memory summary     (see the "Thread" section)
 *  - Virtual thread stacks are small objects ON THE HEAP while parked, so a
 *    heap measurement does capture them.
 * (Runtime.totalMemory() - freeMemory() measures only the heap, so it shows
 *  almost nothing for platform threads -- do not use it to compare.)
 */
public class ThreadMemoryFootprintDemo {

    public static void main(String[] args) throws Exception {
        int threadCount = 10_000;

        // ── Virtual threads: heap usage of 10,000 parked threads ──────────
        System.gc();
        long heapBefore = usedHeap();
        List<Thread> virtualThreads = new ArrayList<>();
        for (int i = 0; i < threadCount; i++) {
            virtualThreads.add(Thread.ofVirtual().start(() -> {
                try {
                    Thread.sleep(10_000);   // parked: stack moved to the heap
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }));
        }
        Thread.sleep(500);                  // let them all reach sleep()
        System.out.printf("Virtual threads (%d): ~%.1f MB heap%n",
            threadCount, (usedHeap() - heapBefore) / 1_048_576.0);
        // Typically a few MB: a few hundred bytes to a few KB per thread,
        // depending on stack depth

        // ── Platform threads: compare with NMT, not with the heap ─────────
        // Start e.g. 1,000 sleeping platform threads and run:
        //   jcmd <pid> VM.native_memory summary
        // "Thread" shows ~1MB RESERVED per thread and a much smaller
        // COMMITTED amount -- plus one OS thread each in the kernel.

        for (Thread t : virtualThreads) t.join();
    }

    private static long usedHeap() {
        Runtime rt = Runtime.getRuntime();
        return rt.totalMemory() - rt.freeMemory();
    }
}
```

## تثبيت الخيط الحامل — المزلق الحرج (Java 21–23)

في Java 21–23، يُثبَّت (pinned) الخيط الافتراضي على خيطه الحامل بينما:
1. يعمل داخل دالة أو كتلة `synchronized`
2. يعمل في شيفرة أصلية تستدعي Java بدورها

ولا يضر التثبيت إلا حين **يحجب** الخيط الافتراضي وهو مثبّت (إدخال/إخراج، أو `sleep`، أو انتظار قفل): فيحجب الخيط الحامل أيضًا ولا يستطيع خدمة خيوط افتراضية أخرى — ما يُبطل غرض الخيوط الافتراضية للعمل المقيد بالإدخال/الإخراج. أما أقسام `synchronized` القصيرة التي لا تحجب أبدًا فلا ضرر منها.

**‏JDK 24 ‏(JEP 491)** أعاد تنفيذ `synchronized` كي تستطيع الخيوط الافتراضية الانفكاك داخله؛ وعلى JDK 24+ صارت حالات التثبيت المتبقية نادرة (الإطارات الأصلية، ومهيئات الأصناف). فإن استطعت التشغيل على JDK 24+، يصبح معظم هذا القسم ملاحظة تاريخية.

```java
// PROBLEM: synchronized causes carrier thread pinning
public class PinnedVirtualThread {

    private final Object lock = new Object();

    // BAD: synchronized block pins carrier thread for entire DB operation
    public PaymentResult authorizeWithSynchronized(Payment payment) {
        synchronized (lock) {           // ← PINS carrier thread here
            // All this IO happens while carrier is pinned:
            validatePayment(payment);   // 2ms CPU
            FraudResult fraud = callFraudApi(payment);    // 45ms IO  ← blocked
            AccountLimits limits = queryDatabase(payment);// 8ms IO   ← blocked
            return processDecision(fraud, limits);         // 5ms CPU
        }
        // Carrier thread was stuck for 60ms serving only this virtual thread
    }
}
```

كشف التثبيت وقت التشغيل:

```
# JDK 21-23 system property to log pinning (removed in JDK 24):
-Djdk.tracePinnedThreads=full    # log full stack trace
-Djdk.tracePinnedThreads=short   # log just method name
# All versions: the JFR event jdk.VirtualThreadPinned (on by default,
# recorded when a pinned thread blocks for more than 20 ms)

# Output when pinning occurs:
Thread[#42,ForkJoinPool-1-worker-1,5,CarrierThreads]
    com.fintech.payment.PinnedVirtualThread.authorizeWithSynchronized(PinnedVirtualThread.java:18)
        <== pinned by synchronized block
```

## ‏ReentrantLock مقابل synchronized — إصلاح التثبيت

في Java 21–23، استبدل `synchronized` بـ `ReentrantLock` حيث تحجب الخيوط الافتراضية وهي تمسك القفل:

```java
// SOLUTION: ReentrantLock does NOT pin carrier threads
public class UnpinnedVirtualThread {

    // ReentrantLock: virtual thread parks (unmounts) during lock wait
    // Platform thread is released to serve other virtual threads
    private final ReentrantLock lock = new ReentrantLock();

    // BETTER: virtual thread unmounts during IO; carrier serves others.
    // (But one global lock around IO still serialises EVERY payment --
    //  this fixes pinning, not the design. See the next method.)
    public PaymentResult authorizeWithReentrantLock(Payment payment) {
        lock.lock();
        try {
            validatePayment(payment);
            FraudResult fraud   = callFraudApi(payment);    // virtual thread unmounts here
            AccountLimits limits = queryDatabase(payment);  // virtual thread unmounts here
            return processDecision(fraud, limits);
        } finally {
            lock.unlock();
        }
    }

    // EVEN BETTER: minimize lock scope — only protect shared state, not IO
    public PaymentResult authorizeOptimized(Payment payment) {
        // IO outside the lock — no synchronization needed for read-only IO
        validatePayment(payment);
        FraudResult fraud    = callFraudApi(payment);    // no lock needed
        AccountLimits limits = queryDatabase(payment);   // no lock needed

        // Lock only for the critical section that modifies shared state
        lock.lock();
        try {
            return processDecision(fraud, limits);  // pure CPU — no IO while locked
        } finally {
            lock.unlock();
        }
    }
}
```

### دقّق شيفرتك بحثًا عن مصادر التثبيت

```java
/**
 * Common pinning sources in payment services to audit (Java 21–23).
 * What matters: code that BLOCKS while inside synchronized.
 *
 * 1. JDBC drivers:
 *    - PostgreSQL JDBC 42.6+: replaced synchronized with locks
 *    - MySQL Connector/J 9.0+: virtual-thread friendly
 *    - Older drivers: upgrade them
 *
 * 2. Connection pools and HTTP clients that lock around IO:
 *    - check versions (recent HikariCP, Apache HttpClient 5, OkHttp are fine)
 *
 * 3. Synchronized utility classes (Hashtable, Vector, StringBuffer):
 *    - harmless unless code blocks while holding their monitor
 *
 * 4. Your own code:
 *    - synchronized blocks that call a database, HTTP or Thread.sleep
 *    - Solution: move the IO outside the lock, or use ReentrantLock
 *
 * Simplest fix of all: run on JDK 24+ (JEP 491).
 */
```

## خدمة معالجة الدفع — قبل وبعد

```java
// BEFORE: Platform thread model for payment authorization
// Spring MVC + fixed thread pool
@Configuration
public class BeforeVirtualThreadsConfig {

    @Bean
    public ExecutorService paymentExecutor() {
        // 200 platform threads, each with its own stack (~1MB reserved)
        // Throughput limited by pool size (Little's Law)
        return Executors.newFixedThreadPool(200);
    }
}

@RestController
public class PaymentControllerBefore {

    @PostMapping("/v1/payments/authorize")
    public ResponseEntity<AuthorizationResponse> authorize(
            @RequestBody AuthorizationRequest request) {
        // Runs on Tomcat thread from fixed pool
        // Thread blocks on each IO call
        AuthorizationResponse response = authorizationService.authorize(request);
        return ResponseEntity.ok(response);
    }
}
```

```java
// AFTER: Virtual thread model — Spring Boot 3.2+
// application.yml: spring.threads.virtual.enabled=true

@Configuration
public class AfterVirtualThreadsConfig {
    // No explicit pool configuration needed!
    // Spring Boot automatically uses virtual threads for:
    //   - Tomcat request handling
    //   - @Async methods
    //   - @Scheduled tasks
}

// Controller code is IDENTICAL — no changes needed.
// It can now hold far more requests in flight on the same hardware --
// until the next limit (DB connection pool, downstream rate limits) is hit.
// Keep those limits explicit: they are now the real concurrency control.
@RestController
public class PaymentControllerAfter {

    @PostMapping("/v1/payments/authorize")
    public ResponseEntity<AuthorizationResponse> authorize(
            @RequestBody AuthorizationRequest request) {
        // Now runs on a virtual thread
        // Automatically unmounts during each IO call
        // Carrier threads (= N_cpu) serve thousands of virtual threads
        AuthorizationResponse response = authorizationService.authorize(request);
        return ResponseEntity.ok(response);
    }
}
```

## حمل الاستمرارية — حين تكون الخيوط الافتراضية أبطأ

تُدخل الخيوط الافتراضية حمل استمرارية (continuation) حين تتبدل الخيوط كثيرًا جدًا:

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@State(Scope.Benchmark)
public class ContinuationOverheadBenchmark {

    private ExecutorService platformPool;
    private ExecutorService virtualPool;

    @Setup
    public void setup() {
        platformPool = Executors.newFixedThreadPool(
            Runtime.getRuntime().availableProcessors());
        virtualPool  = Executors.newVirtualThreadPerTaskExecutor();
    }

    /**
     * CPU-bound work with no IO: virtual threads offer NO advantage.
     * (This mostly measures task hand-off: creating/scheduling a virtual
     *  thread vs reusing a pooled one. The difference is small.)
     */
    @Benchmark
    public long cpuBoundPlatform() throws Exception {
        return platformPool.submit(() -> {
            long sum = 0;
            for (int i = 0; i < 10_000; i++) sum += i * i;
            return sum;
        }).get();
    }

    @Benchmark
    public long cpuBoundVirtual() throws Exception {
        return virtualPool.submit(() -> {
            long sum = 0;
            for (int i = 0; i < 10_000; i++) sum += i * i;
            return sum;
        }).get();
    }
}
```

```
Illustrative:
Benchmark                                       Mode  Cnt    Score   Error  Units
ContinuationOverheadBenchmark.cpuBoundPlatform  avgt  20  12.3 ± 0.4   µs/op
ContinuationOverheadBenchmark.cpuBoundVirtual   avgt  20  14.1 ± 0.6   µs/op

Virtual threads add a little overhead for pure CPU-bound work and bring
no benefit. Worse: virtual threads are not time-sliced, so long CPU-heavy
tasks (encryption, ML inference, compression) can occupy all carrier
threads and delay the IO-bound virtual threads. Run CPU-heavy work on a
bounded platform-thread pool sized to the cores.
```

## المقارنة مع البرمجة التفاعلية (WebFlux)

```java
/**
 * Virtual Threads vs Reactive (WebFlux) — when to use each
 *
 * REACTIVE (WebFlux/Project Reactor):
 *   + Maximum throughput for extreme IO scenarios
 *   + Explicit backpressure control
 *   + Mature ecosystem (R2DBC, WebClient)
 *   - Complex code — callbacks, flatMap, error handling chains
 *   - Hard to debug (async stack traces)
 *   - Difficult to integrate with blocking libraries
 *   - High cognitive load for teams
 *
 * VIRTUAL THREADS:
 *   + Simple synchronous code — easy to understand and debug
 *   + Same stack traces as platform threads
 *   + Drop-in replacement for most platform thread code
 *   + Works with blocking JDBC, synchronous libraries
 *   - Cannot exceed carrier thread count for CPU-bound work
 *   - Pinning pitfalls with synchronized (Java 21–23)
 *   - No built-in backpressure: limit concurrency yourself
 *
 * For payment services: virtual threads win on team productivity.
 * The throughput difference is usually small and rarely worth the
 * reactive complexity.
 * Use reactive only for extremely high-throughput streaming pipelines
 * (e.g., 100K+ events/second real-time risk processing).
 */
```

## قائمة فحص الترحيل في الإنتاج

```java
/**
 * Migrating a payment service to virtual threads — checklist:
 *
 * Step 1: Upgrade to Java 21+ (JDK 24+ removes most synchronized pinning)
 * Step 2: Enable virtual threads in Spring Boot:
 *   spring.threads.virtual.enabled=true
 *
 * Step 3: Audit for synchronized blocks in hot paths
 *   - JDK 21–23: run with -Djdk.tracePinnedThreads=full during load test,
 *     or record the JFR event jdk.VirtualThreadPinned
 *   - Check JDBC driver version
 *   - Replace synchronized with ReentrantLock where needed
 *
 * Step 4: Remove explicit thread pool sizing for IO-bound paths
 *   - Delete fixed thread pools used only for IO-bound work
 *   - ...but keep (or add) explicit limits for scarce resources:
 *     DB pool size, Semaphores/bulkheads per downstream
 *   - Keep separate pools for CPU-bound work (encryption, compression)
 *
 * Step 5: Load test with realistic payment patterns
 *   - Verify throughput improvement (expect 3-10x for IO-bound)
 *   - Check GC pressure (more virtual threads = more objects)
 *   - Monitor carrier thread CPU utilisation
 *
 * Step 6: Update monitoring
 *   - Thread.getAllStackTraces() does not include virtual threads
 *   - Use JFR events or Micrometer's VirtualThreadMetrics
 *   - Alert on carrier thread pinning frequency
 */
```

## أحداث JFR للخيوط الافتراضية

```java
@Component
public class VirtualThreadMonitor implements DisposableBean {

    /**
     * Use Java Flight Recorder to monitor virtual thread behaviour.
     *
     * JFR command to record virtual thread events:
     *   jcmd <pid> JFR.start name=payment-vthread settings=default \
     *     jdk.VirtualThreadStart#enabled=true \
     *     jdk.VirtualThreadEnd#enabled=true
     *   (jdk.VirtualThreadPinned and jdk.VirtualThreadSubmitFailed are
     *    enabled by default; Start/End are off because they are frequent)
     *
     * Key events to monitor:
     *   jdk.VirtualThreadPinned       — pinned thread blocked > 20 ms (bad)
     *   jdk.VirtualThreadStart / End  — creation / completion rate
     *   jdk.VirtualThreadSubmitFailed — scheduler could not accept a task (bad)
     */
    private final RecordingStream stream = new RecordingStream();
    private final Counter pinned;

    public VirtualThreadMonitor(MeterRegistry registry) {
        this.pinned = Counter.builder("app.virtual_threads.pinned")
            .description("Pinned virtual threads that blocked (JFR)")
            .register(registry);
        // (Setting -Djdk.tracePinnedThreads at runtime via System.setProperty
        //  has no reliable effect -- it is read at JVM start, and gone in JDK 24.)
        stream.enable("jdk.VirtualThreadPinned");
        stream.onEvent("jdk.VirtualThreadPinned", e -> pinned.increment());
        stream.startAsync();
    }

    @Override
    public void destroy() {
        stream.close();
    }

    /**
     * Alternatively, Micrometer's VirtualThreadMetrics (micrometer-java21)
     * publishes jvm.threads.virtual.pinned and
     * jvm.threads.virtual.submit.failed from the same JFR events.
     * Investigate when pinning appears regularly in hot paths.
     */
}
```

## الخلاصة: متى تستخدم الخيوط الافتراضية للمدفوعات

| الحمل | الخيوط الافتراضية | خيوط المنصة | التفاعلي |
|----------|----------------|------------------|----------|
| تفويض الدفع (3 استدعاءات إدخال/إخراج) | ممتاز | جيد (مجمع محجّم) | جيد |
| معالجة ملفات المدفوعات الجماعية | ممتاز | مقبول | مقبول |
| تقييم الاحتيال الفوري (تعلم آلي) | ضعيف | جيد | ضعيف |
| تدفق الأحداث عالي الإنتاجية | جيد | مقبول | ممتاز |
| استعلامات قاعدة بيانات JDBC | جيد (Postgres 42.6+) | جيد | جيد (R2DBC) |
| التشفير/التوقيع | ضعيف | جيد | ضعيف |
| توزيع استدعاءات REST | ممتاز | جيد | ممتاز |

الخيوط الافتراضية هي الخيار الافتراضي الصحيح لخدمات تفويض الدفع. فهي تقدم إنتاجية قريبة من التفاعلي بشيفرة متزامنة يستطيع فريقك قراءتها وتصحيحها وصيانتها دون خبرة متخصصة في البرمجة التفاعلية.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا تحسّن الخيوط الافتراضية الإنتاجية كثيرًا لخدمات تفويض الدفع المقيدة بالإدخال/الإخراج مقارنة بخيوط المنصة؟",
      "options": [
        "تستخدم الخيوط الافتراضية ذاكرة أقل لكل خيط، فيمكن تشغيل عدد أكبر منها معًا على العتاد نفسه",
        "حين يحجب خيط افتراضي على إدخال/إخراج (استعلام قاعدة بيانات، أو استدعاء HTTP)، يفكه JVM من خيط المنصة الحامل، فيتحرر الحامل لتشغيل خيط افتراضي آخر — فيزول الانتظار الخامل وتصبح ملايين عمليات الإدخال/الإخراج المتزامنة ممكنة بمجمع صغير من الخيوط الحاملة",
        "تتجاوز الخيوط الافتراضية جامع القمامة في JVM، فيقل أثر توقفات GC على الزمن",
        "توازي الخيوط الافتراضية تلقائيًا الشيفرة التسلسلية باستخدام تفكيك fork-join"
      ],
      "correct": 1,
      "explanation": "تحجب خيوط المنصة خيط نظام التشغيل أثناء الإدخال/الإخراج، فـ 500 خيط منصة تنتظر ردود قاعدة البيانات تستهلك 500 خيط نظام تشغيل. أما الخيوط الافتراضية فتُفك من خيطها الحامل (خيط نظام التشغيل) أثناء الإدخال/الإخراج الحاجب، فيتحرر الحامل لتنفيذ خيوط افتراضية أخرى. ومجمع من 8 خيوط حاملة يستطيع تشغيل ملايين الخيوط الافتراضية بالتزامن."
    },
    {
      "text": "ما التثبيت (pinning) في الخيوط الافتراضية ولماذا يمثل مشكلة لخدمات الدفع التي تستخدم كتل synchronized؟",
      "options": [
        "يقفل التثبيت خيطًا افتراضيًا على نواة معالج معينة لمحلية الذاكرة المخبئية",
        "يحدث التثبيت حين لا يمكن فك خيط افتراضي من خيطه الحامل أثناء العمليات الحاجبة، عادة داخل كتل synchronized أو الدوال الأصلية، فيحجب الخيط الحامل ويقل التوازي المتاح",
        "التثبيت مصطلح في Redis يقابل إعدادات تقارب المعالج للخيوط الافتراضية",
        "التثبيت مفيد؛ فهو يمنع حمل تبديل السياق للمسارات عالية الإنتاجية"
      ],
      "correct": 1,
      "explanation": "إذا كان خيط افتراضي داخل كتلة synchronized وحجب على إدخال/إخراج، فلا يستطيع في Java 21–23 الانفكاك من خيطه الحامل. فيحجب الخيط الحامل، ويقل المجمع الفعلي للحوامل. وخدمات الدفع التي فيها كتل synchronized حول الإدخال/الإخراج تفقد فوائد الخيوط الافتراضية. والإصلاح بنقل الإدخال/الإخراج خارج أقسام synchronized، أو استبدال synchronized بـ ReentrantLock، أو الترقية إلى JDK 24+، حيث أزال JEP 491 معظم تثبيت synchronized."
    },
    {
      "text": "لأي نوع حمل في خدمات الدفع يجب ألا تستخدم الخيوط الافتراضية كنموذج تزامن أساسي؟",
      "options": [
        "توزيع استدعاءات REST إلى 3 خدمات لاحقة لكل تفويض",
        "معالجة ملفات المدفوعات الجماعية بـ 100,000 سجل",
        "تقييم احتيال بتعلم آلي كثيف المعالج يشغّل استدلال شبكة عصبية على كل معاملة",
        "استعلامات قاعدة بيانات JDBC باستخدام مشغّل PostgreSQL القياسي"
      ],
      "correct": 2,
      "explanation": "تتفوق الخيوط الافتراضية في العمل المقيد بالإدخال/الإخراج حيث تقضي الخيوط معظم وقتها في الانتظار. أما العمل المقيد بالمعالج مثل استدلال التعلم الآلي فيبقي الخيط الحامل مشغولًا بالحساب — فلا انتظار إدخال/إخراج يُفك فيه، فلا مكسب. والأسوأ أن الخيوط الافتراضية لا تُقسَّم زمنيًا: فكثير من الخيوط الافتراضية كثيفة المعالج قد تشغل كل خيط حامل (واحد لكل نواة) وتؤخر الخيوط الافتراضية المقيدة بالإدخال/الإخراج، مثل التفويضات. ومجمع خيوط منصة محدود محجّم بعدد الأنوية أنسب."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "قياس الخيوط الافتراضية لتفويض الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "اكتب مقياس JMH يقارن الإنتاجية وزمن P99 لمحاكاة تفويض دفع (3 استدعاءات إدخال/إخراج محاكاة: بحث قاعدة بيانات 10 مللي ثانية، وفحص احتيال 15 مللي ثانية، وفحص حدود 5 مللي ثانية) باستخدام: مجمع خيوط منصة (بحجم 200)، والخيوط الافتراضية (Executors.newVirtualThreadPerTaskExecutor())، وWebFlux التفاعلي."},
    {"id": "2", "description": "اضبط خدمة دفع بـ Spring Boot 3.x لاستخدام الخيوط الافتراضية لكل معالجة الطلبات ودوال @Async، وتحقق من أن خادم Tomcat المضمّن يستخدم الخيوط الافتراضية."},
    {"id": "3", "description": "اكتب اختبار كشف تثبيت باستخدام JFR ‏(RecordingStream على jdk.VirtualThreadPinned): على JDK 21–23، شغّل تفويض دفع بكتلة synchronized حول استدعاء قاعدة بيانات محاكى وأكّد تسجيل أحداث VirtualThreadPinned؛ ثم انتقل إلى ReentrantLock (أو شغّل على JDK 24+) وأكّد عدم تسجيل أي منها."},
    {"id": "4", "description": "قِس ووثّق فرق الذاكرة بين 10,000 خيط افتراضي و1,000 خيط منصة تحت حمل مكافئ: استخدام الـ heap للخيوط الافتراضية المتوقفة، وjcmd VM.native_memory summary ‏(تتبع الذاكرة الأصلية، قسم Thread: المحجوز مقابل الملتزم) لخيوط المنصة."}
  ]
}
-->
