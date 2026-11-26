---
id: "track-07-lesson-06"
title: "تحليل الذاكرة — فحص الكومة واكتشاف التسرّب"
track: "track-07"
track-name: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 6
slug: "memory-profiling"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-07-lesson-05"]

tags:
  - "memory-profiling"
  - "heap-dump"
  - "MAT"
  - "object-retention"
  - "memory-leak"

java-versions: [17, 21]

topics:
  - "Heap Dump Analysis with Eclipse MAT"
  - "Dominator Tree"
  - "Retained vs Shallow Heap"
  - "GC Root Paths"
  - "Memory Leaks"
  - "ThreadLocal Leaks"
  - "Static Caches"
  - "Listener Leaks"
  - "Heap Histogram via jcmd"
  - "Allocation Profiling with async-profiler"
  - "JFR Memory Events"
  - "Common Memory Leaks in Spring Boot"

components:
  mermaid: false
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "Eclipse Memory Analyser Tool — eclipse.org/mat"
  - "Java Platform, Standard Edition Troubleshooting Guide — docs.oracle.com"
  - "Kirk Pepperdine — Garbage Collection and Memory Leaks (blog)"
  - "async-profiler alloc mode — github.com/async-profiler/async-profiler"
---

## نظرة عامة

تسربات الذاكرة في Java خبيثة. فهي لا تسبب فشلًا فوريًا. بل تسبب نموًا تدريجيًا في الـ heap، ودورات GC متزايدة التكرار، وأزمنة توقف أطول تدريجيًا، وأخيرًا `OutOfMemoryError` في الثالثة فجرًا أثناء ذروة معالجة التسوية. وجامع القمامة في JVM لا يزيل تسربات الذاكرة — بل يزيل القمامة. فإذا كان هناك مرجع محتفظ به (عمدًا أو خطأً)، فالكائن ليس قمامة، ولا يستطيع GC جمعه.

وفي الخدمات المالية، تتجاوز عواقب تسربات الذاكرة توفر الخدمة. فخدمة دفع تستنفد الذاكرة أثناء التسوية قد تترك معاملات في حالات غير محددة. وخدمة حساب مخاطر تسرّب بيانات أسعار تاريخية قد تراكم غيغابايتات من الكائنات القديمة، مستهلكة ذاكرة يجب أن تكون متاحة لمراكز المخاطر الحية.

يعلّمك هذا الدرس التحقيق المنهجي في تسربات الذاكرة باستخدام Eclipse MAT، ومدرجات heap من `jcmd`، ووضع التخصيص في async-profiler، وأحداث ذاكرة JFR. وستصنّف أيضًا أكثر أنماط تسرب الذاكرة شيوعًا في خدمات الدفع المبنية على Spring Boot.

> [!NOTE]
> فعّل `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/log/app/heap-dump.hprof` في كل JVM إنتاجي. فدون ذلك يكون OOME صندوقًا أسود. ومعه تملك لقطة كاملة لحالة الـ heap لحظة الفشل.

## أهداف التعلم

بنهاية هذا الدرس ستكون قادرًا على:

- التقاط تفريغات heap وتحليلها باستخدام Eclipse MAT
- التمييز بين الـ heap السطحي (shallow) والـ heap المحتجز (retained)
- التنقل في شجرة المهيمنات (dominator tree) لإيجاد أكبر مستهلكي الذاكرة
- تتبع مسارات جذور GC لفهم سبب عدم جمع الكائنات
- تحديد تسربات ThreadLocal، وتسربات الذاكرات المخبئية الثابتة، وتسربات المستمعين
- استخدام `jcmd` لمدرجات heap خفيفة دون تفريغ كامل
- استخدام وضع التخصيص في async-profiler لإيجاد النقاط الساخنة للتخصيص
- تشخيص أكثر أنماط تسرب الذاكرة شيوعًا في Spring Boot

## 1. التقاط تفريغات الـ heap

### 1.1 التفريغ التلقائي عند OOME

```bash
# Always set these in production
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/app/heap-dump.hprof
-XX:+ExitOnOutOfMemoryError   # Prevents zombie state after OOME
```

### 1.2 التفريغ اليدوي عبر jcmd

```bash
# Capture heap dump without killing the process.
# By default only LIVE objects are dumped: the JVM runs a full GC first,
# so no separate GC.run is needed. The JVM is paused while the dump is
# written (seconds for large heaps) -- take the instance out of traffic.
jcmd <pid> GC.heap_dump /var/tmp/payment-service-heap.hprof

# Include unreachable objects too (no forced GC)
jcmd <pid> GC.heap_dump -all /var/tmp/payment-service-heap-all.hprof

# Heap dumps contain customer data (account numbers, names...) --
# store and transfer them like production data, and delete them after use.
```

### 1.3 مدرج الـ heap (خفيف — لا يتطلب ملف تفريغ)

```bash
# Histogram -- object counts and sizes by class (live objects only:
# it triggers a full GC first; add -all to skip that)
jcmd <pid> GC.class_histogram | head -50

# Output:
#  num     #instances         #bytes  class name (module)
# -----------------------------------------------------------
#    1:        945,234    151,237,440  byte[]
#    2:        234,567     45,678,900  java.lang.String
#    3:         89,123     28,519,360  com.example.payment.PaymentRequest
#    4:         78,456     21,567,200  com.example.payment.FraudScoreCache$Entry
#    5:          2,345      1,890,120  com.example.payment.AuditLogEntry
```

إذا استمر عدد `PaymentRequest` في النمو بين مدرجات ملتقطة بفارق 5 دقائق، فلديك تسرب.

```bash
# Script: capture histograms at intervals and compare instance counts by class
for i in 1 2 3; do
  jcmd "$PID" GC.class_histogram > /tmp/histogram-$i.txt
  sleep 300  # 5 minutes
done
# Join on class name (last column) and print the biggest growth in instances
awk 'NR==FNR && $1 ~ /:$/ {before[$4]=$2; next}
     $1 ~ /:$/ {print $2 - before[$4], $4}' \
  /tmp/histogram-1.txt /tmp/histogram-3.txt | sort -rn | head -20
# (a plain diff is useless: the rows re-order as sizes change)
```

## 2. الـ heap السطحي مقابل الـ heap المحتجز

هذا التمييز أساسي لتحليل MAT.

**الـ heap السطحي (Shallow heap)**: الذاكرة التي يستهلكها الكائن نفسه — رأس الكائن بالإضافة إلى حقوله المباشرة. ولـ `String` على JVM بـ 64 بت مع المراجع المضغوطة، يكون عادة 24 بايت (رأس 12 بايت + مرجع مصفوفة `value` + `hash` المخزن + بايت `coder`، مع الحشو). وتعيش بيانات الأحرف في `byte[]` منفصلة.

**الـ heap المحتجز (Retained heap)**: الذاكرة التي ستُحرر لو جُمع هذا الكائن — الـ heap السطحي بالإضافة إلى كل الكائنات التي لا يمكن الوصول إليها إلا عبره.

```
Example:
  PaymentBatch object:
    shallow heap:  32 bytes  (the batch object itself)
    retained heap: ~2-3 MB   (the batch + all 10,000 PaymentRequest objects
                              of ~200 bytes each that only it references)

MAT shows retained heap because that's what you save by fixing a leak.
```

```java
// RetainedHeapExample.java

public class PaymentBatch {
    private final String batchId;                      // shallow: reference (4 bytes*)
    private final List<PaymentRequest> payments;       // shallow: reference (4 bytes*)
    private final Map<String, BigDecimal> runningTotals; // shallow: reference (4 bytes*)
    private final Instant createdAt;                   // shallow: reference (4 bytes*)
    // * with compressed references (the default for heaps < 32 GB); 8 without

    // Shallow heap of PaymentBatch: ~32 bytes (12-byte header + 4 references, padded)
    //
    // Retained heap of PaymentBatch: ~32 bytes
    //   + List (48 bytes) + underlying array (~8 KB for 1000 entries)
    //   + each PaymentRequest (~200 bytes * 1000 = 200 KB)
    //   + Map + underlying arrays + BigDecimal entries
    //   TOTAL: potentially many MB per PaymentBatch

    // If a static cache holds even ONE PaymentBatch, it retains all of this.
}
```

## 3. ‏Eclipse MAT — سير عمل عملي

### 3.1 فتح تفريغ heap

```bash
# Download Eclipse MAT
# https://eclipse.dev/mat/downloads.php

# Launch with enough heap for large dumps
./MemoryAnalyzer -vmargs -Xmx16g

# Or use command-line mode (better for CI)
./ParseHeapDump.sh /tmp/payment-service-heap.hprof \
  org.eclipse.mat.api:suspects \
  org.eclipse.mat.api:overview \
  org.eclipse.mat.api:top_components
```

### 3.2 تحليل شجرة المهيمنات

تُظهر **شجرة المهيمنات** الكائنات التي "تهيمن" على أكبر heap محتجز. فإذا كان الكائن A على كل مسار من جذر GC إلى الكائن B، فإن A يهيمن على B. وإزالة A من الذاكرة ستحرر A وB معًا.

```
MAT Dominator Tree view:
  Object                              Retained Heap    % of Total Heap
  ─────────────────────────────────────────────────────────────────────
  FraudHistoryCache                   2.1 GB           52%        <-- LEAK
  ├─ HashMap$Node[]                  2.0 GB           50%
  │   ├─ FraudEvent (2.4M instances)  1.8 GB           45%
  │   │   ├─ byte[] (feature vectors) 1.6 GB           40%
  │   └─ ...
  PaymentAuditLog                     800 MB           20%
  ├─ ArrayList                        790 MB           19%
  │   └─ AuditEntry (5M instances)    780 MB           19%

(Illustrative output.)
Diagnosis: FraudHistoryCache is retaining 2.1 GB.
  Likely cause: unbounded cache with no eviction policy.
  Fix: add size limit or TTL (Caffeine or Redis).
```

### 3.3 تحليل مسار جذور GC

جذور GC هي نقاط البداية لتحليل قابلية الوصول: مكدسات الخيوط، والحقول الثابتة، ومراجع JNI. ويكون الكائن حيًا إذا أمكن الوصول إليه من أي جذر GC.

```
MAT Path to GC Roots for a suspected leaked object:

[Leaked FraudEvent instance]
  └── retained by FraudHistoryCache$CacheEntry.value
      └── retained by HashMap$Node.value
          └── retained by FraudHistoryCache.cache (field)
              └── retained by FraudHistoryCache.INSTANCE (static field)
                  └── GC ROOT: java.lang.Class (FraudHistoryCache)

Finding: A static singleton holds a HashMap that retains all FraudEvent instances.
The cache has no eviction -- every fraud event since service start is retained.
```

## 4. أنماط تسرب الذاكرة الشائعة في خدمات الدفع بـ Spring Boot

### 4.1 تسربات ThreadLocal

متغيرات `ThreadLocal` مع مجمعات الخيوط تخلق تسربات. فحين يُعاد استخدام خيط من المجمع، تبقى بيانات `ThreadLocal` من الطلب السابق موجودة على الخيط. والذاكرة المحتجزة محدودة بعدد الخيوط، لكن كل قيمة قد تُبقي رسمًا كبيرًا من الكائنات حيًا — وقد تتسرب البيانات القديمة *إلى الطلب التالي* (مشكلة صحة وأمان: سياق عميل يُرى أثناء خدمة عميل آخر). ومع إعادة تحميل الأصناف (إعادة النشر في خادم تطبيقات) قد تثبّت أيضًا محمّل أصناف كاملًا.

```java
// LEAK: ThreadLocal without cleanup in a thread pool context
public class PaymentContextHolder {

    // This ThreadLocal is never cleaned up
    private static final ThreadLocal<PaymentContext> CONTEXT =
        new ThreadLocal<>();

    public static void setContext(PaymentContext context) {
        CONTEXT.set(context);  // Set on thread pool thread
    }

    public static PaymentContext getContext() {
        return CONTEXT.get();
    }

    public static void remove() {
        CONTEXT.remove();
    }

    // If remove() is never called, the PaymentContext stays on the thread
    // Thread pool = same threads used for many requests = leak accumulates
}

// FIX: Always use try-finally to clean up ThreadLocal
public class PaymentContextFilter implements Filter {

    @Override
    public void doFilter(ServletRequest request, ServletResponse response,
                          FilterChain chain) throws IOException, ServletException {
        try {
            PaymentContext context = extractContext((HttpServletRequest) request);
            PaymentContextHolder.setContext(context);
            chain.doFilter(request, response);
        } finally {
            // CRITICAL: clean up regardless of exception
            PaymentContextHolder.remove();
        }
    }
}

// Alternatives: Spring's RequestContextHolder (cleared by Spring's own
// filters), @RequestScope beans, or Java's ScopedValue (final in JDK 25),
// which is bound to a block of code and cannot outlive it
```

### 4.2 ذاكرة مخبئية ثابتة بلا إخلاء

```java
// LEAK: Unbounded static cache
public class ExchangeRateCache {

    // This map grows forever -- no eviction, no size limit
    private static final Map<String, BigDecimal> rateCache = new HashMap<>();

    public static BigDecimal getRate(String currencyPair) {
        return rateCache.computeIfAbsent(currencyPair, ExchangeRateCache::fetchFromProvider);
    }

    private static BigDecimal fetchFromProvider(String pair) {
        // Imagine this returns different values for subtly different pair strings
        // "USD/EUR", "USD-EUR", "USDEUR" -- all treated as different keys
        return ExchangeRateProvider.fetch(pair);
    }
}

// FIX: Use Caffeine with size and time limits
@Configuration
public class CacheConfiguration {

    @Bean
    public Cache<String, BigDecimal> exchangeRateCache() {
        return Caffeine.newBuilder()
            .maximumSize(1_000)              // hard upper bound
            .expireAfterWrite(5, TimeUnit.MINUTES)  // staleness control
            .recordStats()                   // expose via Micrometer
            .build();
    }
}
```

### 4.3 تسربات مستمعي الأحداث / المراقبين

```java
// LEAK: Observer pattern without deregistration
public class PaymentEventBus {

    private final List<PaymentEventListener> listeners = new CopyOnWriteArrayList<>();

    public void register(PaymentEventListener listener) {
        listeners.add(listener);  // Adding is easy
    }

    // No deregister method!
    // Every registered listener is retained by this bus
    // If the bus is a singleton (common in Spring), it retains all listeners forever
}

// LEAK when the registering object is SHORT-LIVED (prototype/request-scoped
// beans, per-session objects): each instance registers a listener and is
// then kept alive by the singleton bus. (For a singleton like this one the
// cost is small, but the pattern is the same.)
@Service
public class FraudMonitor {

    @Autowired
    private PaymentEventBus eventBus;

    @PostConstruct
    public void init() {
        // The lambda calls an instance method, so it captures 'this':
        // FraudMonitor cannot be GC'd as long as the event bus is alive
        eventBus.register(event -> {
            // 'this' (FraudMonitor) is captured
            this.analyseForFraud(event);
        });
    }

    // No @PreDestroy to deregister -- leak!
    private void analyseForFraud(PaymentEvent event) { /* ... */ }
}

// FIX: Proper lifecycle management
@Service
public class FraudMonitor {

    private final PaymentEventBus eventBus;   // the bus now also has deregister()
    private PaymentEventListener registeredListener;

    public FraudMonitor(PaymentEventBus eventBus) {
        this.eventBus = eventBus;
    }

    @PostConstruct
    public void init() {
        this.registeredListener = this::analyseForFraud;  // method reference
        eventBus.register(registeredListener);
    }

    @PreDestroy
    public void cleanup() {
        eventBus.deregister(registeredListener);  // clean up on shutdown
    }

    private void analyseForFraud(PaymentEvent event) { /* ... */ }
}
```

### 4.4 تسربات HttpClient / الاتصالات

```java
// LEAK: Creating new HttpClient instances per request
@Service
public class FraudApiClient {

    public FraudScore check(PaymentRequest request) throws IOException {
        // Creates a new HttpClient on EVERY call: each has its own selector
        // thread and connection pool. Nothing closes them (close() only
        // exists since JDK 21), so they linger until the GC happens to
        // collect them -- under load, threads and sockets pile up
        HttpClient client = HttpClient.newHttpClient();
        HttpRequest httpRequest = HttpRequest.newBuilder()
            .uri(URI.create(FRAUD_API_URL))
            .POST(HttpRequest.BodyPublishers.ofString(toJson(request)))
            .build();
        // ...
    }
}

// FIX: Singleton HttpClient, shared across all calls
@Service
public class FraudApiClient {

    private final HttpClient client;  // shared, thread-safe

    public FraudApiClient() {
        this.client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .executor(Executors.newVirtualThreadPerTaskExecutor())
            .build();
    }

    public FraudScore check(PaymentRequest request) throws Exception {
        HttpRequest httpRequest = HttpRequest.newBuilder()
            .uri(URI.create(FRAUD_API_URL))
            .timeout(Duration.ofSeconds(3))
            .POST(HttpRequest.BodyPublishers.ofString(toJson(request)))
            .build();

        HttpResponse<String> response = client.send(
            httpRequest, HttpResponse.BodyHandlers.ofString()
        );
        return parseScore(response.body());
    }
}
```

### 4.5 خرائط غير محدودة مفاتيحها من مدخلات المستخدم

```java
// LEAK: an unbounded map keyed by user input
public class PaymentRouter {

    private final Map<String, Route> routeCache = new HashMap<>();   // also not thread-safe

    public Route getRoute(String paymentType) {
        // Every distinct value a caller sends ("SEPA", "sepa", "SEPA ", random
        // junk from a fuzzer...) adds a permanent entry
        return routeCache.computeIfAbsent(paymentType.intern(), this::loadRoute);
        // intern() does not help: since Java 7 the string table lives in the
        // heap and unreferenced interned strings ARE collected -- but here the
        // map keeps every key alive, and a huge string table costs GC time
    }
}

// FIX: validate against the known set (an enum), or use a bounded cache
public Route getRoute(String paymentType) {
    PaymentType type = PaymentType.valueOf(paymentType.trim().toUpperCase(Locale.ROOT)); // rejects junk
    return routes.get(type);   // EnumMap filled at startup -- fixed size
}
```

## 5. توصيف التخصيص باستخدام async-profiler

يأخذ موصّف التخصيص عينات من تخصيصات الكائنات باستخدام أحداث TLAB ‏(مخزن التخصيص المحلي للخيط):

```bash
# Profile allocations for 60 seconds
./asprof -e alloc -d 60 -f /tmp/payment-alloc.html <pid>

# Sample more often: one sample per 1 KB allocated (default 512 KB).
# Smaller interval = more detail and more overhead
./asprof -e alloc -d 60 --alloc 1k -f /tmp/payment-alloc-detailed.html <pid>
```

**قراءة مخططات لهب التخصيص:**

```
Top allocation sites in a typical payment service:

PaymentAuthorisationService.authorise (100%)
  |- ObjectMapper.writeValueAsBytes (45%)      <-- JSON serialisation
  |    |- byte[] allocations (40%)
  |    |- String allocations (5%)
  |- FraudEngine.score (25%)
  |    |- BigDecimal operations (20%)           <-- BigDecimal multiplication
  |    |- ArrayList (5%)
  |- PaymentRequest builder (15%)              <-- DTO construction
  |- Other (15%)
```

**بنود العمل من توصيف التخصيص:**

1. ‏`byte[] في ObjectMapper` -- اكتب مباشرة إلى تدفق المخرجات (`writer.writeValue(outputStream, msg)`) بدل بناء `byte[]` وسيطة، وأعد استخدام كاتب مبني مسبقًا
2. ‏`ضرب BigDecimal` -- أنشئ الثوابت مرة واحدة، وتجنب `setScale` المتكرر، أو استخدم `long` بالوحدات الصغرى في الحلقات الساخنة
3. ‏`باني PaymentRequest` -- أزل النسخ الوسيطة؛ فتجميع الكائنات (object pooling) نادرًا ما يفيد مع جامعات GC الحديثة (الكائنات قصيرة العمر رخيصة) ويضيف أخطاء

## 6. أحداث ذاكرة JFR

```java
// JfrMemoryMonitor.java

import jdk.jfr.consumer.RecordingStream;

@Component
@Slf4j
public class JfrMemoryMonitor implements ApplicationRunner, DisposableBean {

    private final AtomicLong heapUsedAfterGc = new AtomicLong();
    private RecordingStream stream;

    public JfrMemoryMonitor(MeterRegistry meterRegistry) {
        // Register the gauge ONCE; JFR events only update the holder
        Gauge.builder("app.heap.used.after.gc.bytes", heapUsedAfterGc, AtomicLong::get)
             .register(meterRegistry);
    }

    @Override
    public void run(ApplicationArguments args) {
        stream = new RecordingStream();

        // Heap summary is emitted before and after every GC
        stream.enable("jdk.GCHeapSummary");

        // Allocations outside a TLAB are the large ones; skip the stack
        // trace to keep the overhead low. (Do NOT enable
        // jdk.ObjectAllocationInNewTLAB in production -- it is very frequent;
        // jdk.ObjectAllocationSample, JDK 16+, is the throttled alternative.)
        stream.enable("jdk.ObjectAllocationOutsideTLAB").withoutStackTrace();

        stream.onEvent("jdk.GCHeapSummary", event -> {
            if ("After GC".equals(event.getString("when"))) {
                heapUsedAfterGc.set(event.getLong("heapUsed"));
            }
        });

        stream.onEvent("jdk.ObjectAllocationOutsideTLAB", event -> {
            long size = event.getLong("allocationSize");
            if (size > 10 * 1024 * 1024) {  // > 10 MB: unexpectedly large
                log.warn("Large allocation outside TLAB: {} bytes of {}",
                    size, event.getClass("objectClass").getName());
            }
        });

        stream.startAsync();
    }

    @Override
    public void destroy() {
        if (stream != null) stream.close();
    }
}
```

## 7. أتمتة كشف تسرب الذاكرة

```java
// MemoryLeakDetector.java
// Monitors heap growth trend to detect leaks proactively

@Component
public class MemoryLeakDetector implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(MemoryLeakDetector.class);
    private final MeterRegistry meterRegistry;
    private final Deque<Long> heapSamples = new ArrayDeque<>();
    private static final int SAMPLE_COUNT = 10;

    public MemoryLeakDetector(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    @Override
    public void run(ApplicationArguments args) {
        // Sample heap every 5 minutes
        ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(
                r -> Thread.ofVirtual().name("memory-leak-detector").unstarted(r)
            );

        scheduler.scheduleAtFixedRate(this::checkHeapTrend, 5, 5, TimeUnit.MINUTES);
    }

    private void checkHeapTrend() {
        // Use heap usage AFTER the last GC: plain "used" includes garbage
        // and jumps up and down with every collection
        long usedHeap = ManagementFactory.getMemoryPoolMXBeans().stream()
            .filter(p -> p.getType() == MemoryType.HEAP && p.getCollectionUsage() != null)
            .mapToLong(p -> p.getCollectionUsage().getUsed())
            .sum();
        long maxHeap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getMax();

        heapSamples.addLast(usedHeap);
        if (heapSamples.size() > SAMPLE_COUNT) {
            heapSamples.pollFirst();
        }

        if (heapSamples.size() == SAMPLE_COUNT) {
            long[] samples = heapSamples.stream().mapToLong(Long::longValue).toArray();
            double trend = computeLinearTrend(samples);  // bytes per 5-minute interval

            // If heap is growing > 50 MB per 5 minutes consistently, alert
            if (trend > 50 * 1024 * 1024) {
                log.warn("Possible memory leak: heap growing at {} MB per 5 minutes. " +
                    "Current usage after GC: {} MB / {} MB",
                    String.format("%.1f", trend / (1024 * 1024)),
                    usedHeap / (1024 * 1024),
                    maxHeap / (1024 * 1024)
                );

                meterRegistry.counter("jvm.memory.leak.alerts").increment();
            }
        }
    }

    // Least-squares linear regression over the sample window
    private double computeLinearTrend(long[] samples) {
        int n = samples.length;
        double sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

        for (int i = 0; i < n; i++) {
            sumX += i;
            sumY += samples[i];
            sumXY += (long) i * samples[i];
            sumX2 += (long) i * i;
        }

        double denom = n * sumX2 - sumX * sumX;
        return denom == 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    }
}
```

## 8. قائمة فحص الإنتاج

لكل نشر لخدمة دفع في الإنتاج:

- [ ] ‏`-XX:+HeapDumpOnOutOfMemoryError` و`-XX:HeapDumpPath` مضبوطان
- [ ] ‏`-XX:+ExitOnOutOfMemoryError` مضبوط (يمنع العمليات الميتة الحية)
- [ ] تسجيل JFR المستمر مفعّل بمخزن دائري
- [ ] تنبيه مراقبة اتجاه الـ heap مضبوط (نمو > X ميغابايت لكل فترة)
- [ ] كل الذاكرات المخبئية (Caffeine، والخرائط في الذاكرة) لها حدود حجم صريحة
- [ ] كل استخدامات ThreadLocal فيها `remove()` داخل كتل `finally`
- [ ] كل تسجيلات مستمعي الأحداث لها إلغاء تسجيل مقابل عند الإيقاف
- [ ] نسخ HttpClient / RestTemplate مفردة (singletons) (لا لكل طلب)
- [ ] لا خرائط غير محدودة مفاتيحها من مدخلات المستخدم (ولا `String.intern()` عليها)
- [ ] خط أساس لمدرج الـ heap ملتقط بعد البدء لمقارنة الانحراف
- [ ] سكربت مدرج heap بـ `jcmd` في دليل التشغيل لمهندسي المناوبة

## اختبار المعرفة

1. ما الفرق بين الـ heap السطحي والـ heap المحتجز؟ ولماذا يعرض MAT الـ heap المحتجز في شجرة المهيمنات بدل السطحي؟

2. متغير ThreadLocal يخزن كائن `PaymentContext` (‏100 كيلوبايت لكل منها). وتستخدم الخدمة مجمع خيوط من 50 خيطًا. بعد مليون طلب، كم من الذاكرة قد يحتجز هذا التسرب إذا لم يُستدعَ `remove()` أبدًا؟

3. اشرح نمط تسرب مستمعي الأحداث. وما التغييران اللذان يمنعانه؟

4. تشغّل `jcmd <pid> GC.class_histogram` في 10:00، ثم مجددًا في 10:05. فينمو عدد `FraudHistoryCache$Entry` من 50,000 إلى 85,000. ماذا يشير هذا وما خطوتك التشخيصية التالية؟

5. ماذا يفعل الخيار `-XX:+ExitOnOutOfMemoryError`، ولماذا هو أفضل عمومًا من السماح لـ JVM بالاستمرار بعد OOME؟

## التحدي العملي

**الإعداد:** تعمل خدمة دفع بـ Spring Boot منذ 72 ساعة في بيئة تجريبية. ونما استخدام الـ heap من 2 غيغابايت عند البدء إلى 7.5 غيغابايت (من heap بحجم 8 غيغابايت). ويعمل GC باستمرار ويتدهور زمن P99.

**المهمة:**
1. اكتب أوامر `jcmd` وbash من أجل: (أ) إطلاق GC والتقاط مدرج بعد GC، (ب) التقاط تفريغ heap، (ج) مقارنة المدرجات بفترات 10 دقائق
2. اكتب صنف Java باسم `HeapHistogramComparator`:
   - يحلل ملفي مخرجات مدرج jcmd
   - ينتج فرقًا يُظهر الأصناف ذات أكبر نمو في عدد النسخ
   - يعلّم أي صنف نما عدد نسخه > 50% بين العينتين
3. اذكر الأسباب الخمسة الأرجح للتسرب المرصود بناءً على أنماط Spring Boot المغطاة في هذا الدرس، مرتبة حسب تكرارها في أنظمة الإنتاج

**المخرج المتوقع:** أوامر صدفة، وصنف Java، وقائمة مشتبهات مرتبة بالأولوية مع خطوات تحقيق لكل منها.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق بين الـ heap السطحي والـ heap المحتجز، ولماذا يستخدم MAT الـ heap المحتجز في شجرة المهيمنات؟",
      "options": [
        "الـ heap السطحي هو إجمالي الـ heap الذي يستخدمه التطبيق؛ والمحتجز هو الذاكرة المحررة بعد Full GC",
        "الـ heap السطحي هو الذاكرة التي يشغلها الكائن نفسه؛ والمحتجز هو إجمالي الذاكرة التي ستُحرر لو جُمع الكائن، بما فيها كل الكائنات التي لا يمكن الوصول إليها إلا عبره",
        "الـ heap السطحي يتضمن bytecode الدوال؛ والمحتجز يستبعده",
        "هما متكافئان للكائنات التي لا تشير إلى كائنات أخرى"
      ],
      "correct": 1,
      "explanation": "الـ heap السطحي هو حجم حقول الكائن نفسه فقط. أما المحتجز فيشمل كل ما سيُحرر لو جُمع هذا الكائن — الرسم الفرعي الكامل من الكائنات التي لا يمكن الوصول إليها إلا عبره. ويستخدم MAT الـ heap المحتجز لأنه يحدد أي الكائنات مسؤولة فعلًا عن استهلاك الذاكرة، لا أيها موجود فحسب."
    },
    {
      "text": "يخزن ThreadLocal كائن PaymentContext ‏(100 كيلوبايت لكل منها) في مجمع من 50 خيطًا. إذا لم يُستدعَ remove() أبدًا، فما أقصى ذاكرة قد يحتجزها هذا التسرب؟",
      "options": [
        "100 كيلوبايت — توجد قيمة ThreadLocal واحدة فقط لكل نسخة ThreadLocal",
        "5 ميغابايت — 50 خيطًا × 100 كيلوبايت لكل منها، محتجزة إلى أجل غير مسمى ما دام مجمع الخيوط حيًا",
        "تنمو الذاكرة بلا حدود لأن مجمعات الخيوط تنشئ خيوطًا جديدة لكل طلب",
        "صفر — يجمع JVM قيم ThreadLocal حين تكتمل الطلبات"
      ],
      "correct": 1,
      "explanation": "يُعاد استخدام خيوط المجمع عبر الطلبات. ودون remove()، يحتفظ كل خيط دائمًا بـ PaymentContext واحد من طلب سابق. ومع 50 خيطًا و100 كيلوبايت لكل منها، يكون ذلك 5 ميغابايت من الذاكرة المسربة. ولا تُجمع السياقات من الطلبات السابقة لأن الخيط الحي يُبقيها قابلة للوصول."
    },
    {
      "text": "ماذا يفعل `-XX:+ExitOnOutOfMemoryError`، ولماذا هو أفضل عمومًا من السماح لـ JVM بالاستمرار بعد OOME؟",
      "options": [
        "ينفذ تفريغ heap ثم يستأنف التشغيل الطبيعي",
        "ينهي عملية JVM فورًا، فيتيح للمنسّق إعادة تشغيل نسخة نظيفة بدل السماح لـ JVM فاشل جزئيًا بخدمة حالة تالفة",
        "يطلق دورة Full GC قبل رمي OOME إلى التطبيق",
        "يمنع OOME بزيادة حجم الـ heap تلقائيًا حتى ذاكرة النظام المتاحة"
      ],
      "correct": 1,
      "explanation": "بعد OOME، قد يكون JVM في حالة غير متسقة — فبعض التخصيصات فشلت في منتصف العملية، وقد تكون الذاكرات المخبئية مهيأة جزئيًا، وقد تكون مجمعات الخيوط فشلت في قبول العمل. والاستمرار في خدمة الطلبات في هذه الحالة يخاطر بتقديم نتائج خاطئة. ويسبب ExitOnOutOfMemoryError إيقافًا نظيفًا، فيتيح لـ Kubernetes أو systemd إعادة تشغيل نسخة سليمة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "التحقيق في تسرب ذاكرة في خدمة دفع تعمل منذ 72 ساعة",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "اكتب أوامر jcmd والصدفة من أجل: (أ) إطلاق GC والتقاط مدرج بعد GC، (ب) التقاط تفريغ heap إلى ملف، (ج) مقارنة المدرجات بفترات 10 دقائق."},
    {"id": "2", "description": "اكتب صنف Java باسم HeapHistogramComparator يحلل ملفي مخرجات GC.class_histogram من jcmd، وينتج فرقًا يُظهر الأصناف ذات أكبر نمو في عدد النسخ، ويعلّم أي صنف نما عدد نسخه بأكثر من 50% بين العينتين."},
    {"id": "3", "description": "اذكر الأسباب الجذرية الخمسة الأرجح لنمو الـ heap من 2 غيغابايت إلى 7.5 غيغابايت خلال 72 ساعة في خدمة دفع بـ Spring Boot، مرتبة حسب تكرارها في أنظمة الإنتاج."},
    {"id": "4", "description": "لكل سبب جذري، اكتب خطوة التشخيص المحددة (أمر jcmd، أو استعلام MAT، أو محور مراجعة الشيفرة) التي تؤكده أو تستبعده."}
  ]
}
-->
