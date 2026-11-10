---
id: "track-09-lesson-06"
title: "Memory Profiling — Heap Analysis and Leak Detection"
track: "track-09"
track-name: "Performance Engineering"
sequence: 6
slug: "memory-profiling"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-09-lesson-05"]

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

## Overview

Memory leaks in Java are insidious. They do not cause immediate failure. They cause gradual heap growth, increasingly frequent GC cycles, progressively longer pause times, and finally an `OutOfMemoryError` at 3 AM during peak settlement processing. The JVM's GC does not eliminate memory leaks — it eliminates garbage. If a reference is held (intentionally or accidentally), the object is not garbage, and GC cannot collect it.

In financial services, the consequences of memory leaks extend beyond service availability. A payment service that exhausts memory during settlement may leave transactions in indeterminate states. A risk calculation service that leaks historical price data may accumulate gigabytes of stale objects, consuming memory that should be available for live risk positions.

This lesson teaches systematic memory leak investigation using Eclipse MAT, `jcmd` heap histograms, async-profiler allocation mode, and JFR memory events. You will also catalogue the most common memory leak patterns in Spring Boot payment services.

> [!NOTE]
> Enable `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/log/app/heap-dump.hprof` in every production JVM. Without this, an OOME is a black box. With it, you have a complete snapshot of heap state at the moment of failure.

## Learning Objectives

By the end of this lesson you will be able to:

- Capture and analyse heap dumps using Eclipse MAT
- Distinguish shallow heap from retained heap
- Navigate the dominator tree to find the largest memory consumers
- Trace GC root paths to understand why objects are not collected
- Identify ThreadLocal leaks, static cache leaks, and listener leaks
- Use `jcmd` for lightweight heap histograms without full heap dumps
- Use async-profiler allocation mode to find allocation hot spots
- Diagnose the most common Spring Boot memory leak patterns

---

## 1. Capturing Heap Dumps

### 1.1 Automatic Dump on OOME

```bash
# Always set these in production
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/app/heap-dump.hprof
-XX:+ExitOnOutOfMemoryError   # Prevents zombie state after OOME
```

### 1.2 Manual Dump via jcmd

```bash
# Capture heap dump without killing the process
jcmd <pid> GC.heap_dump /tmp/payment-service-heap.hprof

# Force GC before dump (reduces false positives from short-lived garbage)
jcmd <pid> GC.run
jcmd <pid> GC.heap_dump /tmp/payment-service-heap-postgc.hprof
```

### 1.3 Heap Histogram (Lightweight — No Dump File Required)

```bash
# Fast histogram -- shows object counts and sizes by class
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

If `PaymentRequest` count keeps growing between histograms captured 5 minutes apart, you have a leak.

```bash
# Script: capture histograms at intervals and diff
for i in 1 2 3; do
  jcmd "$PID" GC.class_histogram > /tmp/histogram-$i.txt
  sleep 300  # 5 minutes
done
diff /tmp/histogram-1.txt /tmp/histogram-3.txt | grep "^[<>]" | head -30
```

---

## 2. Shallow Heap vs Retained Heap

This distinction is fundamental to MAT analysis.

**Shallow heap**: The memory consumed by the object itself — the object header plus its direct fields. For a `String`, this is typically 24 bytes (header + char[] reference + offset + count fields).

**Retained heap**: The memory that would be freed if this object were collected — shallow heap plus all objects exclusively reachable through it.

```
Example:
  PaymentBatch object:
    shallow heap:  48 bytes  (the batch object itself)
    retained heap: 48 MB     (the batch + all 10,000 PaymentRequest objects it holds)

MAT shows retained heap because that's what you save by fixing a leak.
```

```java
// RetainedHeapExample.java

public class PaymentBatch {
    private final String batchId;                      // shallow: reference (8 bytes)
    private final List<PaymentRequest> payments;       // shallow: reference (8 bytes)
    private final Map<String, BigDecimal> runningTotals; // shallow: reference (8 bytes)
    private final Instant createdAt;                   // shallow: reference (8 bytes)

    // Shallow heap of PaymentBatch: ~48 bytes (header + 4 references)
    //
    // Retained heap of PaymentBatch: ~48 bytes
    //   + List (48 bytes) + underlying array (~8 KB for 1000 entries)
    //   + each PaymentRequest (~200 bytes * 1000 = 200 KB)
    //   + Map + underlying arrays + BigDecimal entries
    //   TOTAL: potentially many MB per PaymentBatch

    // If a static cache holds even ONE PaymentBatch, it retains all of this.
}
```

---

## 3. Eclipse MAT — Practical Workflow

### 3.1 Opening a Heap Dump

```bash
# Download Eclipse MAT
# https://eclipse.org/mat/downloads.php

# Launch with enough heap for large dumps
./MemoryAnalyzer -vmargs -Xmx16g

# Or use command-line mode (better for CI)
./ParseHeapDump.sh /tmp/payment-service-heap.hprof \
  org.eclipse.mat.api:suspects \
  org.eclipse.mat.api:overview \
  org.eclipse.mat.api:top_components
```

### 3.2 Dominator Tree Analysis

The **dominator tree** shows the objects that "dominate" the most retained heap. If object A is on every path from a GC root to object B, then A dominates B. Eliminating A from memory would free both A and B.

```
MAT Dominator Tree view:
  Object                              Retained Heap    % of Total Heap
  ─────────────────────────────────────────────────────────────────────
  FraudHistoryCache                   2.1 GB           52%        <-- LEAK
  ├─ HashMap$Entry[]                  2.0 GB           50%
  │   ├─ FraudEvent (2.4M instances)  1.8 GB           45%
  │   │   ├─ byte[] (feature vectors) 1.6 GB           40%
  │   └─ ...
  PaymentAuditLog                     800 MB           20%
  ├─ ArrayList                        790 MB           19%
  │   └─ AuditEntry (5M instances)    780 MB           19%

Diagnosis: FraudHistoryCache is retaining 2.1 GB.
  Likely cause: unbounded cache with no eviction policy.
  Fix: add size limit or TTL (Caffeine or Redis).
```

### 3.3 GC Root Path Analysis

GC roots are the starting points for reachability analysis: thread stacks, static fields, JNI references. An object is live if it is reachable from any GC root.

```
MAT Path to GC Roots for a suspected leaked object:

[Leaked FraudEvent instance]
  └── retained by FraudHistoryCache$CacheEntry.value
      └── retained by HashMap$Entry.value
          └── retained by FraudHistoryCache.cache (field)
              └── retained by FraudHistoryCache.INSTANCE (static field)
                  └── GC ROOT: java.lang.Class (FraudHistoryCache)

Finding: A static singleton holds a HashMap that retains all FraudEvent instances.
The cache has no eviction -- every fraud event since service start is retained.
```

---

## 4. Common Memory Leak Patterns in Spring Boot Payment Services

### 4.1 ThreadLocal Leaks

`ThreadLocal` variables in combination with thread pools create leaks. When a thread pool thread is reused, the previous request's `ThreadLocal` data is still present on the thread.

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

// Better: Spring's RequestContextHolder handles this automatically
// Or: use a scope-based approach with @RequestScope beans
```

### 4.2 Static Cache Without Eviction

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

### 4.3 Event Listener / Observer Leaks

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

// LEAK: Anonymous inner class registered as listener
@Service
public class FraudMonitor {

    @Autowired
    private PaymentEventBus eventBus;

    @PostConstruct
    public void init() {
        // Anonymous class holds an implicit reference to FraudMonitor
        // FraudMonitor cannot be GC'd as long as the event bus is alive
        eventBus.register(event -> {
            // 'this' (FraudMonitor) is captured implicitly
            this.analyseForFraud(event);
        });
    }

    // No @PreDestroy to deregister -- leak!
    private void analyseForFraud(PaymentEvent event) { /* ... */ }
}

// FIX: Proper lifecycle management
@Service
public class FraudMonitor {

    private final PaymentEventBus eventBus;
    private PaymentEventListener registeredListener;

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

### 4.4 HttpClient / Connection Leaks

```java
// LEAK: Creating new HttpClient instances per request
@Service
public class FraudApiClient {

    public FraudScore check(PaymentRequest request) throws IOException {
        // Creates a new HttpClient with its own thread pool on EVERY call
        // These are never closed -- threads and connections leak
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

### 4.5 String Interning Leaks

```java
// LEAK: Interning user-provided strings fills the string pool (PermGen/Metaspace-adjacent)
public class PaymentRouter {

    private final Map<String, Route> routeCache = new HashMap<>();

    public Route getRoute(String paymentType) {
        // NEVER intern user-provided strings
        // The string pool is never GC'd for interned strings
        String internedType = paymentType.intern();  // WRONG
        return routeCache.computeIfAbsent(internedType, this::loadRoute);
    }
}
```

---

## 5. Allocation Profiling with async-profiler

The allocation profiler samples object allocations using TLAB (Thread-Local Allocation Buffer) events:

```bash
# Profile allocations for 60 seconds
./asprof -e alloc -d 60 -f /tmp/payment-alloc.html <pid>

# Profile with allocation size threshold (only show allocations > 1 KB)
./asprof -e alloc -d 60 --alloc 1k -f /tmp/payment-alloc-large.html <pid>
```

**Reading allocation flame graphs:**

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

**Action items from allocation profile:**

1. `byte[] in ObjectMapper` -- switch to pooled byte buffers or pre-computed writers
2. `BigDecimal multiplication` -- cache intermediate results, pre-scale constants
3. `PaymentRequest builder` -- consider object pooling for ultra-high-throughput paths

---

## 6. JFR Memory Events

```java
// JfrMemoryMonitor.java

import jdk.jfr.consumer.RecordingStream;

@Component
public class JfrMemoryMonitor implements ApplicationRunner, DisposableBean {

    private final MeterRegistry meterRegistry;
    private RecordingStream stream;

    public JfrMemoryMonitor(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    @Override
    public void run(ApplicationArguments args) {
        stream = new RecordingStream();

        // Track allocation in TLAB -- fired when TLAB is exhausted
        stream.enable("jdk.ObjectAllocationInNewTLAB")
              .withThreshold(Duration.ZERO);

        // Track large allocations outside TLAB
        stream.enable("jdk.ObjectAllocationOutsideTLAB")
              .withThreshold(Duration.ZERO);

        // Track heap usage
        stream.enable("jdk.GCHeapSummary").withPeriod(Duration.ofSeconds(10));

        stream.onEvent("jdk.GCHeapSummary", event -> {
            long usedHeap = event.getLong("heapUsed");
            long committedHeap = event.getLong("heapSpace.committedSize");

            Gauge.builder("jvm.heap.used.bytes.jfr", () -> usedHeap)
                 .register(meterRegistry);
        });

        stream.onEvent("jdk.ObjectAllocationOutsideTLAB", event -> {
            String className = event.getClass("objectClass").getName();
            long size = event.getLong("allocationSize");

            // Alert on unexpectedly large allocations
            if (size > 10 * 1024 * 1024) {  // > 10 MB
                log.warn("Large allocation outside TLAB: {} bytes of {}",
                    size, className);
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

---

## 7. Memory Leak Detection Automation

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
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
        long usedHeap = memory.getHeapMemoryUsage().getUsed();
        long maxHeap = memory.getHeapMemoryUsage().getMax();

        heapSamples.addLast(usedHeap);
        if (heapSamples.size() > SAMPLE_COUNT) {
            heapSamples.pollFirst();
        }

        if (heapSamples.size() == SAMPLE_COUNT) {
            long[] samples = heapSamples.stream().mapToLong(Long::longValue).toArray();
            double trend = computeLinearTrend(samples);  // bytes per 5-minute interval

            // If heap is growing > 50 MB per 5 minutes consistently, alert
            if (trend > 50 * 1024 * 1024) {
                log.warn("Possible memory leak: heap growing at {:.1f} MB per 5 minutes. " +
                    "Current usage: {} MB / {} MB",
                    trend / (1024 * 1024),
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

---

## 8. Production Checklist

For every production payment service deployment:

- [ ] `-XX:+HeapDumpOnOutOfMemoryError` and `-XX:HeapDumpPath` configured
- [ ] `-XX:+ExitOnOutOfMemoryError` set (prevents zombie processes)
- [ ] JFR continuous recording enabled with circular buffer
- [ ] Heap trend monitoring alert configured (> X MB growth per interval)
- [ ] All caches (Caffeine, in-memory maps) have explicit size bounds
- [ ] All ThreadLocal usages have `remove()` in `finally` blocks
- [ ] All event listener registrations have corresponding deregistration on shutdown
- [ ] HttpClient / RestTemplate instances are singletons (not per-request)
- [ ] No `String.intern()` on user-provided input
- [ ] Heap histogram baseline captured post-startup for drift comparison
- [ ] `jcmd` heap histogram script in runbook for on-call engineers

---

## Knowledge Check

1. What is the difference between shallow heap and retained heap? Why does MAT display retained heap in the dominator tree rather than shallow heap?

2. A ThreadLocal variable stores a `PaymentContext` object (100 KB each). The service uses a thread pool of 50 threads. After 1 million requests, how much memory could this leak retain if `remove()` is never called?

3. Explain the event listener leak pattern. What two changes prevent it?

4. You run `jcmd <pid> GC.class_histogram` at 10:00, then again at 10:05. The count of `FraudHistoryCache$Entry` grows from 50,000 to 85,000. What does this suggest and what is your next diagnostic step?

5. What does the `-XX:+ExitOnOutOfMemoryError` flag do, and why is it generally preferable to allowing the JVM to continue running after OOME?

---

## Practical Challenge

**Setup:** A Spring Boot payment service has been running for 72 hours in a staging environment. Heap usage has grown from 2 GB at startup to 7.5 GB (of an 8 GB heap). GC runs constantly and P99 latency is degrading.

**Task:**
1. Write the `jcmd` and bash commands to: (a) trigger GC and capture post-GC histogram, (b) capture a heap dump, (c) compare histograms at 10-minute intervals
2. Write a `HeapHistogramComparator` Java class that:
   - Parses two jcmd histogram output files
   - Produces a diff showing classes with the most instance count growth
   - Flags any class whose instance count grew > 50% between samples
3. List the five most likely causes for the observed leak based on the Spring Boot patterns covered in this lesson, ordered by frequency in production systems

**Expected output:** Shell commands, Java class, and prioritised suspect list with investigation steps for each.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the difference between shallow heap and retained heap, and why does MAT use retained heap in the dominator tree?",
      "options": [
        "Shallow heap is the total heap used by an application; retained heap is memory freed after a full GC",
        "Shallow heap is the memory occupied by the object itself; retained heap is the total memory that would be freed if the object were garbage collected, including all exclusively-reachable objects",
        "Shallow heap includes method bytecode; retained heap excludes it",
        "They are equivalent for objects without references to other objects"
      ],
      "correct": 1,
      "explanation": "Shallow heap is just the size of the object's own fields. Retained heap includes everything that would be freed if this object were collected — the full subgraph of exclusively reachable objects. MAT uses retained heap because it identifies which objects are truly responsible for memory consumption, not just which objects exist."
    },
    {
      "text": "A ThreadLocal stores a PaymentContext (100 KB each) on a thread pool of 50 threads. If remove() is never called, what is the maximum memory this leak can retain?",
      "options": [
        "100 KB — only one ThreadLocal value exists per ThreadLocal instance",
        "5 MB — 50 threads × 100 KB each, retained indefinitely as long as the thread pool lives",
        "Memory grows unboundedly because thread pools create new threads per request",
        "Zero — the JVM garbage-collects ThreadLocal values when requests complete"
      ],
      "correct": 1,
      "explanation": "Thread pool threads are reused across requests. Without remove(), each thread permanently holds one PaymentContext from a previous request. With 50 threads and 100 KB each, that is 5 MB of leaked memory. The contexts from earlier requests are never collected because the thread stack root keeps them reachable."
    },
    {
      "text": "What does `-XX:+ExitOnOutOfMemoryError` do, and why is it generally preferable to allowing the JVM to continue after OOME?",
      "options": [
        "It performs a heap dump and then resumes normal operation",
        "It immediately terminates the JVM process, allowing the orchestrator to restart a clean instance rather than allowing a partially-failed JVM to serve corrupted state",
        "It triggers a full GC cycle before throwing the OOME to the application",
        "It prevents OOME by automatically increasing heap size up to available system memory"
      ],
      "correct": 1,
      "explanation": "After an OOME, the JVM may be in an inconsistent state — some allocations failed mid-operation, caches may be partially initialized, thread pools may have failed to submit work. Continuing to serve requests in this state risks serving incorrect results. ExitOnOutOfMemoryError causes a clean shutdown, letting Kubernetes or systemd restart a healthy instance."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Memory Leak Investigation in a 72-Hour Running Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write the jcmd and shell commands to: (a) trigger GC and capture a post-GC histogram, (b) capture a heap dump to a file, and (c) compare histograms at 10-minute intervals."},
    {"id": "2", "description": "Write a HeapHistogramComparator Java class that parses two jcmd GC.class_histogram output files, produces a diff showing classes with the most instance count growth, and flags any class whose instance count grew more than 50% between samples."},
    {"id": "3", "description": "List the five most likely root causes for heap growth from 2 GB to 7.5 GB over 72 hours in a Spring Boot payment service, ordered by frequency in production systems."},
    {"id": "4", "description": "For each root cause, write the specific diagnostic step (jcmd command, MAT query, or code review focus) that would confirm or rule it out."}
  ]
}
-->

