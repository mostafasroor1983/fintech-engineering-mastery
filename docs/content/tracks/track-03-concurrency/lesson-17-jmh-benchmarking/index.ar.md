---
id: "track-03-lesson-17"
title: "قياس أداء الشيفرة المتزامنة بـ JMH"
track: "track-03"
track-name: "هندسة التزامن وأمان الخيوط"
sequence: 17
slug: "jmh-benchmarking"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-07"

prerequisites:
  - "track-03-lesson-04"
  - "track-03-lesson-09"

tags:
  - "JMH"
  - "benchmarking"
  - "microbenchmark"
  - "throughput"
  - "latency"
  - "Blackhole"
  - "warmup"

java-versions: [17, 21]

topics:
  - "JVM benchmarking pitfalls"
  - "JMH setup and annotations"
  - "BenchmarkMode: Throughput vs AverageTime vs SampleTime"
  - "Blackhole — preventing dead code elimination"
  - "State scopes"
  - "Benchmarking concurrent primitives"
  - "Measuring virtual thread overhead"

components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "JMH — Java Microbenchmark Harness (Aleksey Shipilev, OpenJDK)"
  - "Aleksey Shipilev — JMH Samples"
  - "Brian Goetz — Java Performance, O'Reilly"
  - "JMH Maven archetype — openjdk.java.net/projects/code-tools/jmh"
---

# قياس الأداء بـ JMH — اختبارات أداء دقيقة صحيحة

## نظرة عامة

ادعاءات الأداء عن الشيفرة المتزامنة دون قياس مجرد تخمينات. فمترجم JIT في JVM، وذاكرات المعالج المؤقتة، ومتنبئات التفرع، وإعادة ترتيب التعليمات تنتج سلوكًا يخالف الحدس. فقد يتفوق `synchronized` على `ReentrantLock` في المسارات غير المتنافس عليها. وقد لا يخسر `AtomicLong` أمام `LongAdder` إلا بعد عدد خيوط معين. والقياس الخاطئ ينتج نتائج أسوأ من عدم القياس أصلًا.

‏**JMH** ‏(Java Microbenchmark Harness) هو المعيار الذهبي لقياس الأداء في JVM. فهو يتعامل مع إحماء JIT، وحذف الشيفرة الميتة، وطي الثوابت، وفك الحلقات — وهي المزالق التي تجعل اختبارات الأداء الساذجة بلا معنى. ويغطي هذا الدرس JMH من الإعداد حتى تفسير النتائج، مع تطبيق مباشر على الشيفرة المالية المتزامنة.

## أهداف التعلم

في نهاية هذا الدرس ستستطيع:

- شرح مزالق JVM التي تجعل اختبارات الأداء الساذجة غير صالحة
- إعداد JMH في مشروع Maven
- كتابة اختبارات أداء صحيحة للإنتاجية، ومتوسط الزمن، وزمن الذيل (tail latency)
- استخدام `Blackhole` لمنع حذف الشيفرة الميتة
- اختيار نطاق `@State` الصحيح لاختبارات الأداء المتزامنة
- قياس `synchronized` مقابل `ReentrantLock` مقابل `AtomicLong` مقابل `LongAdder`
- قياس كلفة الخيوط الافتراضية مقابل خيوط المنصة
- تفسير مخرجات JMH وتجنب أخطاء التفسير الشائعة

## لماذا تكون اختبارات الأداء الساذجة خاطئة

```java17
// WRONG: naïve benchmark — invalid for multiple reasons
public class NaiveBenchmark {
    public static void main(String[] args) {
        long start = System.nanoTime();
        for (int i = 0; i < 1_000_000; i++) {
            Math.sqrt(i); // JIT may eliminate entirely — no side effect!
        }
        long elapsed = System.nanoTime() - start;
        System.out.println("Time: " + elapsed + "ns");
    }
}
```

**مزالق JVM التي تبطل اختبارات الأداء الساذجة:**

| المزلق | الوصف | إصلاح JMH |
|---|---|---|
| **حذف الشيفرة الميتة** | يحذف JIT الشيفرة التي لا أثر ملحوظًا لها | ‏`Blackhole.consume()` |
| **طي الثوابت** | يحسب JIT التعبيرات مسبقًا وقت الترجمة | استخدم حقول `@State` غير النهائية، لا القيم الحرفية ولا الحقول `final` |
| **إحماء JIT** | التكرارات الأولى تُفسَّر لا تُترجم | تكرارات إحماء قبل القياس |
| **إلغاء تحسين JIT** | تغيّر ملف التنفيذ يبطل التحسينات أثناء التشغيل | عدة تفرعات (forks)، وقياس في الحالة المستقرة |
| **تدخل جامع النفايات** | توقفات GC تشوّه قياسات زمن الاستجابة | عدة تكرارات، وتقارير بالمئينات |
| **فك الحلقات** | يفك JIT الحلقات — فتتغير كلفة التكرار الواحد | يتحكم JMH في عدد التكرارات |
| **تغيير تردد المعالج** | يخفّض نظام التشغيل تردد المعالج تحت الحمل المستمر | بيئات اختبار بتردد ثابت |

## إعداد JMH

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.openjdk.jmh</groupId>
    <artifactId>jmh-core</artifactId>
    <version>1.37</version>
</dependency>
<dependency>
    <groupId>org.openjdk.jmh</groupId>
    <artifactId>jmh-generator-annprocess</artifactId>
    <version>1.37</version>
    <scope>provided</scope>
</dependency>

<!-- Build as an uber-jar for standalone execution -->
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-shade-plugin</artifactId>
    <executions>
        <execution>
            <phase>package</phase>
            <goals><goal>shade</goal></goals>
        </execution>
    </executions>
    <configuration>
        <finalName>benchmarks</finalName>
        <transformers>
            <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                <mainClass>org.openjdk.jmh.Main</mainClass>
            </transformer>
        </transformers>
    </configuration>
</plugin>
```

```bash
# Build and run
# (JDK 23+ no longer runs annotation processors by default: list
#  jmh-generator-annprocess in maven-compiler-plugin <annotationProcessorPaths>
#  or pass -proc:full, otherwise the jar contains no benchmarks)
mvn clean package -DskipTests
java -jar target/benchmarks.jar

# Run specific benchmark with options
java -jar target/benchmarks.jar ".*CounterBenchmark.*" -wi 5 -i 10 -f 2 -t 8
# -wi 5: 5 warmup iterations
# -i 10: 10 measurement iterations
# -f 2: 2 JVM forks (independent JVM processes)
# -t 8: 8 threads
```

تنبيه: لم يعد JDK 23+ يشغّل معالجات التعليقات (annotation processors) افتراضيًا: فاذكر `jmh-generator-annprocess` في `<annotationProcessorPaths>` لـ maven-compiler-plugin أو مرّر `-proc:full`، وإلا لن يحتوي الملف الناتج على أي اختبار أداء.

## تعليقات JMH الأساسية

```java17
// Choose ONE mode per benchmark (or list several: @BenchmarkMode({...}))
@BenchmarkMode(Mode.Throughput)      // ops/second
@BenchmarkMode(Mode.AverageTime)     // average time per op
@BenchmarkMode(Mode.SampleTime)      // samples latency distribution (percentiles)
@BenchmarkMode(Mode.SingleShotTime)  // cold start time (no warmup)

@OutputTimeUnit(TimeUnit.MICROSECONDS) // Unit for time-based modes
@Warmup(iterations = 5, time = 1, timeUnit = TimeUnit.SECONDS)  // JIT warmup
@Measurement(iterations = 10, time = 1, timeUnit = TimeUnit.SECONDS)
@Fork(2)        // Run in 2 independent JVM processes
@Threads(8)     // 8 concurrent threads per benchmark method
```

## اختبار أداء: استراتيجيات العدّادات المتزامنة

```java17
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@Fork(2)
@State(Scope.Benchmark) // One instance shared across all threads
public class CounterBenchmark {

    // The four counter implementations to compare
    private volatile long          volatileCounter;
    private final Object           syncLock      = new Object();
    private long                   syncCounter;
    private final AtomicLong       atomicCounter = new AtomicLong();
    private final LongAdder        adderCounter  = new LongAdder();
    private final ReentrantLock    reentrantLock = new ReentrantLock();
    private long                   reentrantCounter;

    @Benchmark
    @Threads(8)
    public void volatile_increment() {
        volatileCounter++; // NOT atomic — demonstrates data race; for comparison only
    }

    @Benchmark
    @Threads(8)
    public void synchronized_increment() {
        synchronized (syncLock) {
            syncCounter++;
        }
    }

    @Benchmark
    @Threads(8)
    public void reentrantLock_increment() {
        reentrantLock.lock();
        try {
            reentrantCounter++;
        } finally {
            reentrantLock.unlock();
        }
    }

    @Benchmark
    @Threads(8)
    public void atomicLong_increment() {
        atomicCounter.incrementAndGet();
    }

    @Benchmark
    @Threads(8)
    public void longAdder_increment() {
        adderCounter.increment();
    }
}
// Illustrative results on 8 cores, 8 threads (ops/ms — higher is better;
// real numbers vary widely by CPU and JDK):
// volatile_increment:       ~40,000  (data race — incorrect but fast for comparison)
// synchronized_increment:   ~18,000  (global lock — serialised)
// reentrantLock_increment:  ~20,000  (similar to synchronized — overhead comparable)
// atomicLong_increment:     ~35,000  (CAS — good under moderate contention)
// longAdder_increment:      ~95,000  (striped — excellent under high contention)
```

الأرقام توضيحية وتختلف كثيرًا حسب المعالج وإصدار JDK. وزيادة `volatile` ليست ذرية — فهي سباق بيانات، وموجودة للمقارنة فقط.

## Blackhole — منع حذف الشيفرة الميتة

```java17
@State(Scope.Thread) // Each thread gets its own instance
public class ExchangeRateBenchmark {

    private ExchangeRateCache cache = new ExchangeRateCache();
    private CurrencyPair pair = CurrencyPair.of("GBP", "USD"); // non-final: avoids constant folding

    // WRONG: JIT may eliminate the getRate() call if result is unused
    @Benchmark
    public void getRate_noBlackhole() {
        cache.getRate(pair); // Return value discarded — JIT may eliminate entirely
    }

    // CORRECT: Blackhole consumes the result — JIT cannot eliminate the call
    @Benchmark
    public void getRate_withBlackhole(Blackhole bh) {
        bh.consume(cache.getRate(pair)); // Result consumed — call cannot be eliminated
    }

    // SIMPLER: return the value — JMH automatically consumes it
    @Benchmark
    public ExchangeRate getRate_return() {
        return cache.getRate(pair); // Return value → JMH auto-blackholes
    }
}
```

إذا لم تُستخدم القيمة المعادة فقد يحذف JIT الاستدعاء كله. والحل: استهلك النتيجة بـ `Blackhole`، أو أعدها ببساطة من الطريقة فيستهلكها JMH تلقائيًا. والحقول غير نهائية لتجنب طي الثوابت.

## نطاقات الحالة لاختبارات الأداء المتزامنة

```java17
@State(Scope.Benchmark) // Single shared instance — all threads share it (contention testing)
public class SharedStateBenchmark {
    ConcurrentHashMap<String, Long> sharedMap = new ConcurrentHashMap<>();
}

@State(Scope.Thread)    // Per-thread instance — no sharing (throughput upper bound)
public class ThreadLocalStateBenchmark {
    HashMap<String, Long> threadLocalMap = new HashMap<>(); // No contention
}

@State(Scope.Group)     // Per-group instance — for producer/consumer benchmarks
// Caution: blocking put()/take() can hang at the end of an iteration when one
// side stops first; offer()/poll() with a short timeout is safer in practice
public class ProducerConsumerBenchmark {
    BlockingQueue<Payment> queue = new ArrayBlockingQueue<>(1000);

    @Benchmark
    @Group("pc")
    @GroupThreads(4) // 4 producer threads
    public void producer(Blackhole bh) throws InterruptedException {
        queue.put(Payment.sample());
    }

    @Benchmark
    @Group("pc")
    @GroupThreads(2) // 2 consumer threads
    public void consumer(Blackhole bh) throws InterruptedException {
        bh.consume(queue.take());
    }
}
```

‏`Scope.Benchmark`: نسخة واحدة تتشاركها كل الخيوط (لاختبار التنافس). و`Scope.Thread`: نسخة لكل خيط بلا مشاركة (الحد الأعلى للإنتاجية). و`Scope.Group`: نسخة لكل مجموعة، لاختبارات المنتج/المستهلك. وانتبه: قد يعلق `put()`/`take()` الحاجبان في نهاية التكرار عندما يتوقف أحد الطرفين أولًا؛ و`offer()`/`poll()` بمهلة قصيرة أكثر أمانًا عمليًا.

## اختبار أداء: استراتيجيات القفل بأعداد خيوط مختلفة

```java17
// Benchmark lock strategies across 1, 2, 4, 8, 16, 32 threads
// to find where each approach's performance crosses over

@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@Warmup(iterations = 3)
@Measurement(iterations = 5)
@Fork(2)
@State(Scope.Benchmark)
public class LockScalingBenchmark {

    private final ReentrantLock           lock         = new ReentrantLock();
    private final ReentrantReadWriteLock  rwLock       = new ReentrantReadWriteLock();
    private final StampedLock             stampedLock  = new StampedLock();
    private final AtomicLong              atomic       = new AtomicLong();
    private volatile long                 volatileVal  = 42L;
    private long                          lockVal      = 42L;

    // Run each at 1, 2, 4, 8, 16, 32 threads using -t flag at CLI

    @Benchmark public long reentrantLock_read() {
        lock.lock(); try { return lockVal; } finally { lock.unlock(); }
    }

    @Benchmark public long rwLock_read() {
        rwLock.readLock().lock(); try { return lockVal; } finally { rwLock.readLock().unlock(); }
    }

    @Benchmark public long stampedLock_optimistic() {
        long stamp = stampedLock.tryOptimisticRead();
        long val = lockVal;
        if (!stampedLock.validate(stamp)) {
            stamp = stampedLock.readLock();
            try { val = lockVal; } finally { stampedLock.unlockRead(stamp); }
        }
        return val;
    }

    @Benchmark public long atomicLong_get() {
        return atomic.get(); // Effectively a volatile read
    }

    @Benchmark public long volatile_read() {
        return volatileVal;
    }
}
// Illustrative results (read-heavy, 8 threads, ops/ms — higher is better):
// volatile_read:            ~850,000  (fastest — single memory barrier)
// atomicLong_get:           ~820,000  (essentially volatile read)
// stampedLock_optimistic:   ~700,000  (validate() adds a small cost)
// rwLock_read:              ~280,000  (lock acquisition overhead)
// reentrantLock_read:       ~150,000  (exclusive lock — serialises all reads)
```

شغّل كل اختبار عند 1 و2 و4 و8 و16 و32 خيطًا (بالخيار `-t`) لإيجاد نقطة التقاطع في أداء كل أسلوب. وفي القراءة الكثيفة تكون القراءة `volatile` الأسرع، ثم `AtomicLong.get()`، ثم القراءة المتفائلة في `StampedLock`، ثم قفل القراءة/الكتابة، وأبطؤها القفل الحصري الذي يسلسل كل القراءات.

## قياس أداء الخيوط الافتراضية

```java21
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@Warmup(iterations = 3)
@Measurement(iterations = 5)
@Fork(2)
public class VirtualThreadBenchmark {

    // The pool is SMALLER than the number of tasks — the realistic case:
    // a platform pool is sized for steady load, not for every burst
    private static final ExecutorService PLATFORM_POOL =
        Executors.newFixedThreadPool(50);
    private static final ExecutorService VIRTUAL_EXEC =
        Executors.newVirtualThreadPerTaskExecutor();

    // Simulate I/O-bound task: 10ms sleep (represents a DB call)
    @Benchmark
    public void platformThreads_ioSimulated() throws Exception {
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            futures.add(PLATFORM_POOL.submit(() -> {
                Thread.sleep(10); // Simulated I/O
                return null;
            }));
        }
        for (Future<?> f : futures) f.get();
    }

    @Benchmark
    public void virtualThreads_ioSimulated() throws Exception {
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            futures.add(VIRTUAL_EXEC.submit(() -> {
                Thread.sleep(10); // Virtual thread parks — carrier is freed
                return null;
            }));
        }
        for (Future<?> f : futures) f.get();
    }
}
// Illustrative result (200 concurrent 10ms I/O tasks):
// platformThreads_ioSimulated: ~24 ops/sec  (50 threads → 4 waves × 10ms ≈ 40ms per op)
// virtualThreads_ioSimulated: ~95 ops/sec  (all 200 sleep at once ≈ 10ms per op)
// Note: a 200-thread platform pool would score about the same as virtual
// threads here — the difference appears when tasks outnumber pool threads
```

المجمّع **أصغر** من عدد المهام — وهي الحالة الواقعية: فمجمّع المنصة يُحدد حجمه للحمل المستقر لا لكل دفعة مفاجئة. فمع 50 خيطًا تُنفّذ المهام الـ 200 في 4 موجات (نحو 40ms للعملية)، بينما تنام الخيوط الافتراضية الـ 200 معًا (نحو 10ms). ولو كان المجمّع 200 خيط لكانت النتيجة قريبة من الخيوط الافتراضية هنا — فالفرق يظهر عندما تفوق المهام عدد خيوط المجمّع.

## قراءة مخرجات JMH

```
Benchmark                           Mode  Cnt      Score     Error   Units
CounterBenchmark.atomicLong         thrpt   20  35421.234 ± 892.111  ops/ms
CounterBenchmark.longAdder          thrpt   20  95234.891 ± 456.234  ops/ms
CounterBenchmark.synchronized_incr  thrpt   20  18234.123 ± 234.789  ops/ms
```

**كيف تقرؤها:**
- ‏`Score`: القيمة المقيسة (عمليات/ms للإنتاجية)
- ‏`Error`: نصف عرض فترة الثقة 99.9%
- ‏`Cnt`: عدد العينات المقيسة (تكرارات القياس × التفرعات — لا يُحسب الإحماء)
- إذا تداخل `Score ± Error` لـ longAdder و`Score ± Error` لـ atomicLong ← اعتبر الفرق **غير مثبت** (قاعدة تقريبية، لا اختبار إحصائي رسمي)

```java17
// Always check: are the differences outside the error bounds?
// longAdder:  95,234 ± 456  → range 94,778 – 95,690
// atomicLong: 35,421 ± 892  → range 34,529 – 36,313
// No overlap → difference is statistically significant ✓

// synchronized: 18,234 ± 234  → range 18,000 – 18,468
// reentrantLock: 20,891 ± 312 → range 20,579 – 21,203
// No overlap → reentrantLock is measurably faster ✓ (but both are slower than atomic)
```


<!-- KNOWLEDGE-CHECK [
  {
    "id": "kc-jmh-01",
    "question": "يستدعي اختبار أداء JMH الطريقة `computeExpensiveValue()` لكنه لا يستخدم النتيجة ولا يعيدها. وبعد مرحلة الإحماء تكون الإنتاجية أعلى من المتوقع بعشرة آلاف مرة. ما الذي حدث على الأرجح؟",
    "options": [
      "الاختبار صحيح — الطريقة سريعة إلى هذا الحد فعلًا",
      "حذف JIT الاستدعاء عبر حذف الشيفرة الميتة لأن النتيجة لا أثر ملحوظًا لها",
      "قاس JMH تكرارات الإحماء بدل تكرارات القياس",
      "قيمة @Fork عالية جدًا فتضخّم النتائج"
    ],
    "correct": 1,
    "explanation": "حذف الشيفرة الميتة أشهر مزالق JMH. فيحدد مترجم JIT أن computeExpensiveValue() لا أثر جانبيًا ملحوظًا لها (نتيجتها غير مستخدمة ولا تعدّل حالة عامة)، فيحذف الاستدعاء كليًا. فيقيس الاختبار شبه صفر — كلفة حلقة فارغة. والإصلاح: أعد القيمة من طريقة الاختبار (يستهلكها JMH تلقائيًا) أو مررها إلى Blackhole.consume()."
  },
  {
    "id": "kc-jmh-02",
    "question": "يُشارك `ConcurrentHashMap` بنطاق `@State(Scope.Benchmark)` بين 8 خيوط اختبار. ويعطي `HashMap` بنطاق `@State(Scope.Thread)` كل خيط نسخته. ماذا تقيس مقارنة إنتاجيتهما؟",
    "options": [
      "الفرق في التعقيد الخوارزمي بين ConcurrentHashMap وHashMap",
      "كلفة الوصول المتزامن والمزامنة في ConcurrentHashMap مقابل وصول HashMap أحادي الخيط بلا تنافس",
      "فرق استخدام الذاكرة بين التنفيذين",
      "لا شيء مفيد — المقارنة غير صالحة"
    ],
    "correct": 1,
    "explanation": "ينشئ Scope.Benchmark نسخة واحدة تتشاركها الخيوط الثمانية — فيقيس ConcurrentHashMap تحت تنافس حقيقي. وينشئ Scope.Thread نسخة لكل خيط — فيقيس HashMap بلا أي تنافس (كل خيط يعمل مستقلًا). والفرق بين النتيجتين يحدد كلفة المزامنة المتزامنة في ConcurrentHashMap. وهذه الطريقة المعيارية لعزل كلفة المزامنة."
  },
  {
    "id": "kc-jmh-03",
    "question": "تُظهر نتائج JMH: ‏`longAdder_increment: 95,234 ± 456 ops/ms` و`atomicLong_increment: 94,891 ± 523 ops/ms`. ماذا تستنتج؟",
    "options": [
      "‏LongAdder أسرع بـ 343 عملية/ms — استخدم LongAdder",
      "الفرق داخل حدود الخطأ وغير ذي دلالة إحصائية — لا يمكن استنتاج شيء عند هذا العدد من الخيوط",
      "‏AtomicLong أسرع لأن نطاق خطئه أوسع",
      "النتيجتان غير صالحتين — يجب أن يكون الخطأ قريبًا من الصفر"
    ],
    "correct": 1,
    "explanation": "نطاق LongAdder: ‏94,778–95,690. ونطاق AtomicLong: ‏94,368–95,414. والنطاقان متداخلان كثيرًا. وعندما تتداخل فترات الخطأ لا يكون الفرق ذا دلالة إحصائية — فلا تستطيع استنتاج أن أحدهما أسرع عند هذا العدد من الخيوط. ويتفوق LongAdder عادة على AtomicLong تحت تنافس أعلى (16 خيطًا فأكثر). وعند أعداد خيوط منخفضة يتشابه أداؤهما. فشغّل الاختبار بأعداد خيوط أعلى لإيجاد نقطة التقاطع."
  },
  {
    "id": "kc-jmh-04",
    "question": "يعمل اختبار أداء في عملية JVM واحدة (`@Fork(0)`). وبعد 5 تكرارات إحماء تستقر النتائج. هل هذا كافٍ لاختبار أداء صالح؟",
    "options": [
      "نعم — تكرارات الإحماء تضمن ترجمة JIT قبل القياس",
      "لا — دون تفرع تعمل الاختبارات داخل JVM أداة JMH نفسها وتتشارك ملفات تنفيذ JIT؛ استخدم @Fork(2) أو أكثر لعمليات JVM مستقلة",
      "لا — ‏@Fork(0) يعطّل قياس الأداء كليًا",
      "نعم — التفرعات المتعددة تهم فقط في الاختبارات متعددة الخيوط"
    ],
    "correct": 1,
    "explanation": "مع @Fork(0) تعمل كل الاختبارات في عملية JVM نفسها. فتُشارك ملفات تنفيذ مترجم JIT: وقد تغيّر الاختبارات السابقة قرارات التحسين للاختبارات اللاحقة (تلوث الملف). كما تلوّث حالة GC وحالة ترجمة JIT وحالة ذاكرة المعالج المؤقتة من الاختبارات السابقة القياسات اللاحقة. ويشغّل @Fork(2) كل اختبار في عمليتي JVM مستقلتين — تبدأ كل منهما بحالة JIT نظيفة، فتصبح النتائج قابلة للمقارنة والتكرار."
  }
] -->


<!-- PRACTICAL-CHALLENGE {
  "id": "pc-jmh-benchmarking",
  "title": "قياس أداء الشيفرة المتزامنة",
  "description": "صمّم اختبارات أداء JMH وشغّلها لاتخاذ قرارات مبنية على البيانات بشأن اختيار بنى البيانات المتزامنة.",
  "tasks": [
    {
      "id": "pc-jmh-01",
      "description": "قِس خمس استراتيجيات عدّادات (volatile، وsynchronized، وReentrantLock، وAtomicLong، وLongAdder) عند أعداد الخيوط: 1، 2، 4، 8، 16، 32. وارسم الإنتاجية مقابل عدد الخيوط. عند أي عدد خيوط يبدأ LongAdder في التفوق على AtomicLong؟ ووثّق نقطة التقاطع واشرح سببها."
    },
    {
      "id": "pc-jmh-02",
      "description": "قِس أداء القراءة في ExchangeRateCache: ‏(أ) طريقة synchronized، (ب) readLock من ReentrantReadWriteLock، (ج) قراءة StampedLock المتفائلة، (د) AtomicReference.get(). استخدم Scope.Benchmark للجميع (حالة مشتركة). وشغّل عند 1 و4 و16 خيط قراءة مع 0 و1 خيط كتابة. متى تفوز القراءة المتفائلة في StampedLock؟ ومتى يلغي تنافس الكتابة ميزتها؟"
    },
    {
      "id": "pc-jmh-03",
      "description": "قِس إنتاجية الإدخال/الإخراج: 1000 مهمة تنام كل منها 5ms. وقارن: (أ) مجمّع منصة من 50 خيطًا، (ب) مجمّع منصة من 200 خيط، (ج) منفّذ خيوط افتراضية. وقِس: زمن الإكمال الفعلي، وذروة الذاكرة، وأحداث GC. واستخدم @BenchmarkMode(Mode.SampleTime) لالتقاط زمن P99 لكل منها."
    },
    {
      "id": "pc-jmh-04",
      "description": "قِس أداء PaymentService.processPayment() من البداية للنهاية باستخدام @BenchmarkMode(Mode.SampleTime) لقياس زمن P50 وP95 وP99 وP99.9 عند 50 خيطًا متزامنًا. وحدد أي مئين يُظهر أعلى تقلب، واربطه بتوقفات GC أو تنافس الأقفال باستخدام async-profiler."
    }
  ]
} -->
