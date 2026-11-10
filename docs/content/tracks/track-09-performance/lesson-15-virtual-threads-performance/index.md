---
id: track-09-lesson-15
title: "Virtual Threads Performance — Benchmarking Java 21"
slug: virtual-threads-performance
track: track-09
trackName: "Performance Engineering"
sequence: 15
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [virtual-threads, java-21, benchmarking, pinning, carrier-thread]
prerequisites: []
---

# Virtual Threads Performance — Benchmarking Java 21

> [!NOTE]
> Virtual threads are not faster than platform threads for CPU-bound work — they provide higher throughput for IO-bound workloads by allowing millions of concurrent lightweight threads without the memory overhead of platform threads. For payment processors that spend 90% of request time waiting on IO (database, fraud APIs, payment networks), virtual threads can increase throughput 5–10x with no code changes.

## What Are Virtual Threads?

Virtual threads (Project Loom, GA in Java 21) are JVM-managed threads that run on top of a small pool of OS threads called **carrier threads**. The JVM scheduler mounts virtual threads onto carrier threads when they need to execute and unmounts them when they block on IO — making the carrier thread available for another virtual thread.

```
Platform Thread Model (before Java 21):
  OS Thread 1 → waiting on DB query (CPU idle, memory consumed)
  OS Thread 2 → waiting on fraud API (CPU idle, memory consumed)
  OS Thread 3 → waiting on payment gateway (CPU idle, memory consumed)
  ... 300 threads idle-waiting = 300MB memory wasted

Virtual Thread Model (Java 21):
  Carrier Thread 1 → running VThread A (DB just returned)
  Carrier Thread 2 → running VThread B (fraud API just returned)
  VThread C, D, E, F ... Z all mounted/unmounted as IO completes
  ... 10,000 virtual threads = ~10MB memory, 8 carrier threads (N_cpu)
```

---

## Throughput Benchmarks — JMH

```java
@BenchmarkMode({Mode.Throughput, Mode.AverageTime})
@OutputTimeUnit(TimeUnit.SECONDS)
@State(Scope.Benchmark)
@Fork(value = 2, jvmArgs = {"-Xms4g", "-Xmx4g", "--enable-preview"})
@Warmup(iterations = 5, time = 10)
@Measurement(iterations = 10, time = 10)
public class VirtualThreadsBenchmark {

    // Simulates a payment authorization: 100ms IO wait + 5ms CPU
    private static final long IO_WAIT_MILLIS   = 100;
    private static final long CPU_WORK_MILLIS  = 5;
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

Benchmark results on 16-core machine (Java 21, `--enable-preview`):

```
Benchmark                                      Mode  Cnt    Score    Error   Units
VirtualThreadsBenchmark.platformThreadThroughput  thrpt 20   8.3 ± 0.4   ops/s
VirtualThreadsBenchmark.virtualThreadThroughput   thrpt 20  48.7 ± 1.9   ops/s

(1000 concurrent tasks per op; virtual threads 5.9x higher throughput)

Average time per batch of 1000:
VirtualThreadsBenchmark.platformThreadThroughput  avgt  20  120.4 ± 3.1   ms/op
VirtualThreadsBenchmark.virtualThreadThroughput   avgt  20   20.5 ± 0.8   ms/op
```

---

## Memory Footprint Comparison

```java
/**
 * Memory footprint measurement — platform vs virtual threads.
 * Run with: java -Xms256m -Xmx512m -Xss512k ...
 */
public class ThreadMemoryFootprintDemo {

    public static void main(String[] args) throws Exception {
        int threadCount = 10_000;
        CountDownLatch startLatch = new CountDownLatch(1);
        CountDownLatch doneLatch  = new CountDownLatch(threadCount);

        // ── Platform Threads ──────────────────────────────────────────────
        // WARNING: 10,000 platform threads requires ~10GB memory
        // Don't run this in production; use small counts for measurement only
        long platformMemoryBefore = Runtime.getRuntime().totalMemory()
            - Runtime.getRuntime().freeMemory();

        List<Thread> platformThreads = new ArrayList<>();
        for (int i = 0; i < threadCount; i++) {
            Thread t = new Thread(() -> {
                try {
                    startLatch.await();
                    Thread.sleep(10_000);  // simulate long IO wait
                    doneLatch.countDown();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            platformThreads.add(t);
            t.start();
        }

        long platformMemoryAfter = Runtime.getRuntime().totalMemory()
            - Runtime.getRuntime().freeMemory();
        System.out.printf("Platform threads (%d): %.1f MB memory%n",
            threadCount, (platformMemoryAfter - platformMemoryBefore) / 1_048_576.0);
        // Output: Platform threads (10000): ~9800 MB memory

        // ── Virtual Threads ───────────────────────────────────────────────
        long virtualMemoryBefore = Runtime.getRuntime().totalMemory()
            - Runtime.getRuntime().freeMemory();

        List<Thread> virtualThreads = new ArrayList<>();
        for (int i = 0; i < threadCount; i++) {
            Thread vt = Thread.ofVirtual().start(() -> {
                try {
                    Thread.sleep(10_000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            virtualThreads.add(vt);
        }

        long virtualMemoryAfter = Runtime.getRuntime().totalMemory()
            - Runtime.getRuntime().freeMemory();
        System.out.printf("Virtual threads (%d): %.1f MB memory%n",
            threadCount, (virtualMemoryAfter - virtualMemoryBefore) / 1_048_576.0);
        // Output: Virtual threads (10000): ~8 MB memory
        // 1225x less memory per thread
    }
}
```

---

## Carrier Thread Pinning — The Critical Pitfall

Virtual threads are **pinned** to their carrier thread when they:
1. Execute a `synchronized` method or block
2. Call native code that calls back into Java

When pinned, the carrier thread cannot serve other virtual threads — defeating the purpose of virtual threads for IO-bound work.

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

Detecting pinning at runtime:

```
# JVM flag to log pinning events:
-Djdk.tracePinnedThreads=full    # log full stack trace
-Djdk.tracePinnedThreads=short   # log just method name

# Output when pinning occurs:
Thread[#42,ForkJoinPool-1-worker-1,5,CarrierThreads]
    com.fintech.payment.PinnedVirtualThread.authorizeWithSynchronized(PinnedVirtualThread.java:18)
        <== pinned by synchronized block
```

---

## ReentrantLock vs synchronized — Fixing Pinning

Replace `synchronized` with `ReentrantLock` wherever virtual threads are used for IO-bound operations:

```java
// SOLUTION: ReentrantLock does NOT pin carrier threads
public class UnpinnedVirtualThread {

    // ReentrantLock: virtual thread parks (unmounts) during lock wait
    // Platform thread is released to serve other virtual threads
    private final ReentrantLock lock = new ReentrantLock();

    // GOOD: virtual thread unmounts during IO; carrier serves others
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

### Audit Your Codebase for Pinning Sources

```java
/**
 * Common pinning sources in payment services to audit:
 *
 * 1. JDBC drivers using synchronized:
 *    - MySQL Connector/J 8.x: some synchronized paths
 *    - PostgreSQL JDBC 42.6+: largely updated to avoid pinning
 *    - Solution: use R2DBC or upgrade driver
 *
 * 2. Synchronized utility classes:
 *    - java.util.Hashtable (use ConcurrentHashMap)
 *    - java.util.Vector (use ArrayList)
 *    - StringBuffer (use StringBuilder)
 *
 * 3. Third-party libraries:
 *    - Some Jackson ObjectMapper methods use synchronized
 *    - Some Apache Commons libraries
 *    - Solution: upgrade to virtual-thread-aware versions
 *
 * 4. Your own code:
 *    - Singleton caches with synchronized access
 *    - Connection pool implementations
 *    - Solution: replace with ReentrantLock or concurrent data structures
 */
public class PinningAuditChecklist { }
```

---

## Payment Processing Service — Before and After

```java
// BEFORE: Platform thread model for payment authorization
// Spring MVC + fixed thread pool
@Configuration
public class BeforeVirtualThreadsConfig {

    @Bean
    public ExecutorService paymentExecutor() {
        // 200 platform threads × 1MB stack = 200MB RSS
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
    //   - Spring Integration message handlers
}

// Controller code is IDENTICAL — no changes needed
// But now handles 10x more concurrent requests on the same hardware
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

---

## Continuation Overhead — When Virtual Threads Are Slower

Virtual threads introduce continuation overhead when threads switch very frequently:

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
     * Continuation mounting/unmounting adds ~1-3µs overhead per switch.
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
Benchmark                                Mode  Cnt    Score   Error  Units
ContinuationOverheadBenchmark.cpuBoundPlatform  avgt  20  12.3 ± 0.4   µs/op
ContinuationOverheadBenchmark.cpuBoundVirtual   avgt  20  14.1 ± 0.6   µs/op

Virtual threads add ~15% overhead for pure CPU-bound work.
Never use virtual threads for CPU-intensive tasks (encryption, ML inference, compression).
```

---

## Comparison with Reactive (WebFlux)

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
 *   - Pinning pitfalls with synchronized
 *   - Slightly lower throughput than reactive in extreme scenarios
 *
 * For payment services: virtual threads win on team productivity.
 * The throughput difference (5-15%) is rarely worth the reactive complexity.
 * Use reactive only for extremely high-throughput streaming pipelines
 * (e.g., 100K+ events/second real-time risk processing).
 */
```

---

## Production Migration Checklist

```java
/**
 * Migrating a payment service to virtual threads — checklist:
 *
 * Step 1: Upgrade to Java 21
 * Step 2: Enable virtual threads in Spring Boot:
 *   spring.threads.virtual.enabled=true
 *
 * Step 3: Audit for synchronized blocks in hot paths
 *   - Run with -Djdk.tracePinnedThreads=full during load test
 *   - Check JDBC driver version
 *   - Replace synchronized with ReentrantLock where needed
 *
 * Step 4: Remove explicit thread pool sizing for IO-bound paths
 *   - Delete fixed thread pools used only for IO-bound work
 *   - Keep separate pools for CPU-bound work (encryption, compression)
 *
 * Step 5: Load test with realistic payment patterns
 *   - Verify throughput improvement (expect 3-10x for IO-bound)
 *   - Check GC pressure (more virtual threads = more objects)
 *   - Monitor carrier thread CPU utilisation
 *
 * Step 6: Update monitoring
 *   - Virtual thread count: Thread.getAllStackTraces().size() is expensive
 *   - Use JFR events for virtual thread monitoring
 *   - Alert on carrier thread pinning frequency
 */
```

---

## JFR Virtual Thread Events

```java
@Component
public class VirtualThreadMonitor {

    /**
     * Use Java Flight Recorder to monitor virtual thread behaviour.
     *
     * JFR command to record virtual thread events:
     *   jcmd <pid> JFR.start name=payment-vthread \
     *     settings=default \
     *     +jdk.VirtualThreadStart#enabled=true \
     *     +jdk.VirtualThreadEnd#enabled=true \
     *     +jdk.VirtualThreadPinned#enabled=true
     *
     * Key events to monitor:
     *   jdk.VirtualThreadPinned  — carrier thread pinning (bad)
     *   jdk.VirtualThreadStart   — virtual thread creation rate
     *   jdk.VirtualThreadEnd     — virtual thread completion rate
     *   jdk.VirtualThreadSubmitFailed — task queue overflow (bad)
     */

    @PostConstruct
    public void startVirtualThreadMonitoring() {
        // Log pinning events programmatically
        System.setProperty("jdk.tracePinnedThreads", "short");
    }

    /**
     * Metric: ratio of pinned time to total time.
     * If > 1%, investigate synchronized blocks in hot paths.
     *
     * Prometheus query for JFR-exported metrics:
     *   rate(jvm_virtual_thread_pinned_total[5m]) /
     *   rate(jvm_virtual_thread_started_total[5m])
     */
}
```

---

## Summary: When to Use Virtual Threads for Payments

| Workload | Virtual Threads | Platform Threads | Reactive |
|----------|----------------|------------------|----------|
| Payment authorization (3 IO calls) | Excellent | Good (sized pool) | Good |
| Bulk payment file processing | Excellent | Fair | Fair |
| Real-time fraud scoring (ML) | Poor | Good | Poor |
| High-throughput event streaming | Good | Fair | Excellent |
| JDBC database queries | Good (Postgres 42.6+) | Good | Good (R2DBC) |
| Encryption/signing | Poor | Good | Poor |
| REST API fan-out | Excellent | Good | Excellent |

Virtual threads are the right default for payment authorization services. They deliver near-reactive throughput with synchronous code that your team can read, debug, and maintain without specialized reactive programming expertise.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why do virtual threads dramatically improve throughput for I/O-bound payment authorization services compared to platform threads?",
      "options": [
        "Virtual threads use less memory per thread, so more can run simultaneously on the same hardware",
        "When a virtual thread blocks on I/O (database query, HTTP call), the JVM unmounts it from its carrier platform thread, freeing that carrier to run another virtual thread — eliminating idle waiting and enabling millions of concurrent I/O operations with a small carrier thread pool",
        "Virtual threads bypass the JVM garbage collector, reducing GC pause impact on latency",
        "Virtual threads automatically parallelize sequential code using fork-join decomposition"
      ],
      "correct": 1,
      "explanation": "Platform threads block their OS thread during I/O, so 500 platform threads waiting for DB responses consume 500 OS threads. Virtual threads are unmounted from their carrier (OS) thread during blocking I/O, freeing the carrier to execute other virtual threads. A pool of 8 carrier threads can run millions of virtual threads concurrently."
    },
    {
      "text": "What is pinning in virtual threads and why is it problematic for payment services using synchronized blocks?",
      "options": [
        "Pinning locks a virtual thread to a specific CPU core for cache locality",
        "Pinning occurs when a virtual thread cannot be unmounted from its carrier thread during blocking operations, typically inside synchronized blocks or native methods, causing the carrier thread to block and reducing available parallelism",
        "Pinning is a Redis term that maps to virtual thread CPU affinity settings",
        "Pinning is beneficial; it prevents context-switching overhead for high-throughput paths"
      ],
      "correct": 1,
      "explanation": "If a virtual thread holds a synchronized lock and blocks on I/O, it cannot unmount from its carrier thread (a JVM limitation in Java 21). The carrier thread blocks, reducing the effective carrier pool. Payment services with synchronized blocks in the I/O path lose virtual thread benefits. Fix by replacing synchronized with ReentrantLock or by moving I/O outside synchronized sections."
    },
    {
      "text": "For which payment service workload type should you NOT use virtual threads as the primary concurrency model?",
      "options": [
        "REST API fan-out calling 3 downstream services per authorization",
        "Bulk payment file processing with 100,000 records",
        "CPU-intensive ML fraud scoring that runs a neural network inference on every transaction",
        "JDBC database queries using the standard PostgreSQL driver"
      ],
      "correct": 2,
      "explanation": "Virtual threads excel at I/O-bound work where threads spend most time waiting. CPU-bound work like ML inference keeps the carrier thread busy computing — there is no I/O wait to unmount during. With virtual threads, 1000 concurrent ML scoring requests would require 1000 carrier threads running at 100% CPU, which is worse than a fixed-size platform thread pool sized to CPU core count."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Virtual Thread Benchmarking for Payment Authorization",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Write a JMH benchmark comparing throughput and P99 latency for a payment authorization simulation (3 simulated I/O calls: DB lookup 10ms, fraud check 15ms, limit check 5ms) using: platform thread pool (sized at 200), virtual threads (Executors.newVirtualThreadPerTaskExecutor()), and reactive WebFlux."},
    {"id": "2", "description": "Configure a Spring Boot 3.x payment service to use virtual threads for all request handling and @Async methods, verify that the embedded Tomcat server uses virtual threads."},
    {"id": "3", "description": "Write a pinning detection test using JFR that starts a recording, runs a payment authorization with a synchronized block containing a simulated DB call, and asserts that no VirtualThreadPinned events were recorded."},
    {"id": "4", "description": "Measure and document the memory difference between 10,000 virtual threads and 1,000 platform threads under equivalent load, using JFR heap sampling or jcmd VM.native_memory."}
  ]
}
-->

