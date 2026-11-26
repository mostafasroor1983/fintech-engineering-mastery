---
id: track-07-lesson-15
title: "Virtual Threads Performance — Benchmarking Java 21"
slug: virtual-threads-performance
track: track-07
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
> Virtual threads are not faster than platform threads for CPU-bound work — they provide higher throughput for IO-bound workloads by allowing millions of concurrent lightweight threads without the memory overhead of platform threads. For payment processors that spend most of each request waiting on IO (database, fraud APIs, payment networks), virtual threads remove the thread-pool ceiling on concurrency with little or no code change — throughput then rises until the next limit (database connections, downstream rate limits, CPU) is reached.

## What Are Virtual Threads?

Virtual threads (Project Loom, GA in Java 21) are JVM-managed threads that run on top of a small pool of OS threads called **carrier threads**. The JVM scheduler mounts virtual threads onto carrier threads when they need to execute and unmounts them when they block on IO — making the carrier thread available for another virtual thread.

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

---

## Throughput Benchmarks — JMH

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

Illustrative results on a 16-core machine (Java 21). You can predict them with simple arithmetic — which is the point:

```
Benchmark                                         Mode  Cnt    Score    Error   Units
VirtualThreadsBenchmark.platformThreadThroughput  thrpt  20    1.9 ±  0.1   ops/s
VirtualThreadsBenchmark.virtualThreadThroughput   thrpt  20    5.8 ±  0.3   ops/s

Platform pool of 200: 1000 tasks run in 5 "waves" of ~101 ms  -> ~0.51 s per op
Virtual threads: all 1000 sleep at once (100 ms), then 1000 × 1 ms of CPU
spread over 16 cores (~63 ms)                                  -> ~0.17 s per op
```

Two lessons from the arithmetic: the gain comes from removing the 200-thread limit (a platform pool of 1,000 threads would do about as well here), and as CPU work per request grows, the cores — not the threads — become the limit (with 5 ms of CPU per task, the virtual-thread run already takes ~0.41 s).

---

## Memory Footprint Comparison

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

---

## Carrier Thread Pinning — The Critical Pitfall (Java 21–23)

On Java 21–23, a virtual thread is **pinned** to its carrier thread while it:
1. Runs inside a `synchronized` method or block
2. Runs native code that calls back into Java

Pinning only hurts when the virtual thread **blocks** while pinned (IO, `sleep`, waiting for a lock): the carrier thread then blocks too and cannot serve other virtual threads — defeating the purpose of virtual threads for IO-bound work. Short `synchronized` sections that never block are harmless.

**JDK 24 (JEP 491)** reimplemented `synchronized` so that virtual threads can unmount inside it; on JDK 24+ the remaining pinning cases are rare (native frames, class initialisers). If you can run JDK 24+, most of this section becomes a historical note.

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

---

## ReentrantLock vs synchronized — Fixing Pinning

On Java 21–23, replace `synchronized` with `ReentrantLock` where virtual threads block while holding the lock:

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

### Audit Your Codebase for Pinning Sources

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

---

## Payment Processing Service — Before and After

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

---

## Production Migration Checklist

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

---

## JFR Virtual Thread Events

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
      "explanation": "If a virtual thread is inside a synchronized block and blocks on I/O, on Java 21–23 it cannot unmount from its carrier thread. The carrier thread blocks, reducing the effective carrier pool. Payment services with synchronized blocks around I/O lose virtual thread benefits. Fix by moving I/O outside synchronized sections, replacing synchronized with ReentrantLock, or upgrading to JDK 24+, where JEP 491 removed most synchronized pinning."
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
      "explanation": "Virtual threads excel at I/O-bound work where threads spend most time waiting. CPU-bound work like ML inference keeps the carrier thread busy computing — there is no I/O wait during which to unmount, so there is nothing to gain. Worse, virtual threads are not time-sliced: many CPU-heavy virtual threads can occupy every carrier thread (one per core) and delay the I/O-bound virtual threads, such as authorisations. A bounded platform-thread pool sized to the core count is the better fit."
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
    {
      "id": "1",
      "description": "Write a JMH benchmark comparing throughput and P99 latency for a payment authorization simulation (3 simulated I/O calls: DB lookup 10ms, fraud check 15ms, limit check 5ms) using: platform thread pool (sized at 200), virtual threads (Executors.newVirtualThreadPerTaskExecutor()), and reactive WebFlux."
    },
    {
      "id": "2",
      "description": "Configure a Spring Boot 3.x payment service to use virtual threads for all request handling and @Async methods, verify that the embedded Tomcat server uses virtual threads."
    },
    {
      "id": "3",
      "description": "Write a pinning detection test using JFR (RecordingStream on jdk.VirtualThreadPinned): on JDK 21–23, run a payment authorization with a synchronized block around a simulated DB call and assert that VirtualThreadPinned events are recorded; then switch to ReentrantLock (or run on JDK 24+) and assert that none are recorded."
    },
    {
      "id": "4",
      "description": "Measure and document the memory difference between 10,000 virtual threads and 1,000 platform threads under equivalent load: heap usage for the parked virtual threads, and jcmd VM.native_memory summary (Native Memory Tracking, Thread section: reserved vs committed) for the platform threads."
    }
  ]
}
-->

