---
id: "track-03-lesson-17"
title: "JMH Microbenchmarking for Concurrent Code"
track: "track-03"
track-name: "Concurrency & Thread Safety Engineering"
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

## Overview

Performance claims about concurrent code without measurements are guesses. The JVM's JIT compiler, CPU caches, branch predictors, and instruction reordering produce behaviour that defies intuition. `synchronized` may outperform `ReentrantLock` for uncontended paths. `AtomicLong` may lose to `LongAdder` only beyond a specific thread count. Measuring incorrectly produces worse results than not measuring at all.

**JMH** (Java Microbenchmark Harness) is the gold standard for JVM performance measurement. It handles JIT warmup, dead code elimination, constant folding, and loop unrolling — the pitfalls that make naïve benchmarks meaningless. This lesson covers JMH from setup through interpreting results, with direct application to concurrent financial code.

## Learning Objectives

By the end of this lesson you will be able to:

- Explain the JVM pitfalls that make naïve benchmarks invalid
- Set up JMH in a Maven project
- Write correct benchmarks for throughput, average time, and tail latency
- Use `Blackhole` to prevent dead code elimination
- Choose the correct `@State` scope for concurrent benchmarks
- Benchmark `synchronized` vs `ReentrantLock` vs `AtomicLong` vs `LongAdder`
- Measure virtual thread overhead vs platform threads
- Interpret JMH output and avoid common misinterpretations

## Why Naïve Benchmarks Are Wrong

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

**JVM pitfalls that invalidate naïve benchmarks:**

| Pitfall | Description | JMH Fix |
|---|---|---|
| **Dead code elimination** | JIT removes code with no observable effect | `Blackhole.consume()` |
| **Constant folding** | JIT precomputes expressions at compile time | Use `@State` fields, not literals |
| **JIT warmup** | First iterations run interpreted, not compiled | Warmup iterations before measurement |
| **JIT deoptimisation** | Code profile changes invalidate optimisations mid-run | Multiple forks, steady-state measurement |
| **GC interference** | GC pauses distort latency measurements | Multiple iterations, percentile reporting |
| **Loop unrolling** | JIT unrolls loops — per-iteration cost changes | JMH controls iteration count |
| **CPU frequency scaling** | OS throttles CPU under sustained load | Fixed-clock test environments |

## JMH Setup

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
mvn clean package -DskipTests
java -jar target/benchmarks.jar

# Run specific benchmark with options
java -jar target/benchmarks.jar ".*CounterBenchmark.*" -wi 5 -i 10 -f 2 -t 8
# -wi 5: 5 warmup iterations
# -i 10: 10 measurement iterations
# -f 2: 2 JVM forks (independent JVM processes)
# -t 8: 8 threads
```

## Core JMH Annotations

```java17
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

## Benchmark: Concurrent Counter Strategies

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
// Typical results on 8 cores, 8 threads (ops/ms — higher is better):
// volatile_increment:       ~40,000  (data race — incorrect but fast for comparison)
// synchronized_increment:   ~18,000  (global lock — serialised)
// reentrantLock_increment:  ~20,000  (similar to synchronized — overhead comparable)
// atomicLong_increment:     ~35,000  (CAS — good under moderate contention)
// longAdder_increment:      ~95,000  (striped — excellent under high contention)
```

## Blackhole — Preventing Dead Code Elimination

```java17
@State(Scope.Thread) // Each thread gets its own instance
public class ExchangeRateBenchmark {

    private final ExchangeRateCache cache = new ExchangeRateCache();
    private final CurrencyPair pair = CurrencyPair.of("GBP", "USD");

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

## State Scopes for Concurrent Benchmarks

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

## Benchmark: Lock Strategies at Different Thread Counts

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
// Results (read-heavy, 8 threads, ops/ms — higher is better):
// volatile_read:            ~850,000  (fastest — single memory barrier)
// atomicLong_get:           ~820,000  (essentially volatile read)
// stampedLock_optimistic:   ~700,000  (validate() adds a small cost)
// rwLock_read:              ~280,000  (lock acquisition overhead)
// reentrantLock_read:       ~150,000  (exclusive lock — serialises all reads)
```

## Benchmarking Virtual Threads

```java21
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@Warmup(iterations = 3)
@Measurement(iterations = 5)
@Fork(2)
public class VirtualThreadBenchmark {

    private static final ExecutorService PLATFORM_POOL =
        Executors.newFixedThreadPool(200);
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
// Typical result (200 concurrent 10ms I/O tasks):
// platformThreads_ioSimulated: ~8 ops/sec  (200 threads × 10ms = all block simultaneously)
// virtualThreads_ioSimulated: ~95 ops/sec  (carrier threads stay busy scheduling)
```

## Reading JMH Output

```
Benchmark                           Mode  Cnt      Score     Error   Units
CounterBenchmark.atomicLong         thrpt   20  35421.234 ± 892.111  ops/ms
CounterBenchmark.longAdder          thrpt   20  95234.891 ± 456.234  ops/ms
CounterBenchmark.synchronized_incr  thrpt   20  18234.123 ± 234.789  ops/ms
```

**How to read this:**
- `Score`: the measured value (ops/ms for throughput)
- `Error`: 99.9% confidence interval — results overlap if error ranges overlap
- `Cnt`: total samples (warmup × forks + measurement × forks)
- If `longAdder Score ± Error` and `atomicLong Score ± Error` overlap → **not statistically significant**

```java17
// Always check: are the differences outside the error bounds?
// longAdder:  95,234 ± 456  → range 94,778 – 95,690
// atomicLong: 35,421 ± 892  → range 34,529 – 36,313
// No overlap → difference is statistically significant ✓

// synchronized: 18,234 ± 234  → range 18,000 – 18,468
// reentrantLock: 20,891 ± 312 → range 20,579 – 21,203
// No overlap → reentrantLock is measurably faster ✓ (but both are slower than atomic)
```

---

<!-- KNOWLEDGE-CHECK [
  {
    "id": "kc-jmh-01",
    "question": "A JMH benchmark calls `computeExpensiveValue()` but does not use or return the result. After the warmup phase, throughput is 10,000x higher than expected. What most likely happened?",
    "options": [
      "The benchmark is correct — the method is genuinely that fast",
      "The JIT eliminated the call via dead code elimination because the result has no observable effect",
      "JMH measured warmup iterations instead of measurement iterations",
      "The @Fork annotation is set too high, inflating results"
    ],
    "correct": 1,
    "explanation": "Dead code elimination is the most common JMH pitfall. The JIT compiler determines that computeExpensiveValue() has no observable side effect (its result is not used and it doesn't modify global state), so it eliminates the call entirely. The benchmark measures near-zero — the cost of a no-op loop. Fix: return the value from the benchmark method (JMH auto-consumes it) or pass it to Blackhole.consume()."
  },
  {
    "id": "kc-jmh-02",
    "question": "A `@State(Scope.Benchmark)` ConcurrentHashMap is shared across 8 benchmark threads. A `@State(Scope.Thread)` HashMap gives each thread its own instance. What does comparing their throughput measure?",
    "options": [
      "The difference in algorithmic complexity between ConcurrentHashMap and HashMap",
      "The overhead of concurrent access and synchronization in ConcurrentHashMap vs uncontended single-threaded HashMap access",
      "The memory usage difference between the two implementations",
      "Nothing useful — the comparison is invalid"
    ],
    "correct": 1,
    "explanation": "Scope.Benchmark creates one instance shared by all 8 threads — this measures ConcurrentHashMap under real contention. Scope.Thread creates one instance per thread — this measures HashMap with zero contention (each thread operates independently). The delta between the two scores quantifies the cost of concurrent synchronization in ConcurrentHashMap. This is the standard way to isolate synchronization overhead."
  },
  {
    "id": "kc-jmh-03",
    "question": "JMH results show: `longAdder_increment: 95,234 ± 456 ops/ms` and `atomicLong_increment: 94,891 ± 523 ops/ms`. What can you conclude?",
    "options": [
      "LongAdder is 343 ops/ms faster — use LongAdder",
      "The difference is within the error bounds and not statistically significant — no conclusion can be drawn at this thread count",
      "AtomicLong is faster because its error range is wider",
      "Both results are invalid — the error should be near zero"
    ],
    "correct": 1,
    "explanation": "LongAdder range: 94,778–95,690. AtomicLong range: 94,368–95,414. These ranges overlap significantly. When error intervals overlap, the difference is not statistically significant — you cannot conclude one is faster than the other at this thread count. LongAdder typically outperforms AtomicLong under higher contention (16+ threads). At low thread counts, their performance is similar. Run the benchmark at higher thread counts to find the crossover point."
  },
  {
    "id": "kc-jmh-04",
    "question": "A benchmark runs in a single JVM process (`@Fork(0)`). After 5 warmup iterations, results stabilise. Is this sufficient for a valid benchmark?",
    "options": [
      "Yes — warmup iterations ensure the JIT is compiled before measurement",
      "No — a single JVM fork means JIT profile pollution from previous benchmarks may affect results; use @Fork(2) minimum for independent JVM processes",
      "No — @Fork(0) disables benchmarking entirely",
      "Yes — multiple forks only matter for multi-threaded benchmarks"
    ],
    "correct": 1,
    "explanation": "With @Fork(0), all benchmarks run in the same JVM process. JIT compiler profiles are shared: earlier benchmarks can alter the JIT's optimisation decisions for later ones (profile pollution). Additionally, GC state, JIT compilation state, and CPU cache state from earlier benchmarks contaminate later measurements. @Fork(2) runs each benchmark in two independent JVM processes — each starts with a clean JIT state, making results comparable and reproducible."
  }
] -->

---

<!-- PRACTICAL-CHALLENGE {
  "id": "pc-jmh-benchmarking",
  "title": "Concurrent Code Performance Measurement",
  "description": "Design and run JMH benchmarks to make data-driven decisions about concurrent data structure choices.",
  "tasks": [
    {
      "id": "pc-jmh-01",
      "description": "Benchmark five counter strategies (volatile, synchronized, ReentrantLock, AtomicLong, LongAdder) at thread counts: 1, 2, 4, 8, 16, 32. Plot throughput vs thread count. At what thread count does LongAdder begin to outperform AtomicLong? Document the crossover point and explain why it occurs."
    },
    {
      "id": "pc-jmh-02",
      "description": "Benchmark ExchangeRateCache read performance: (a) synchronized method, (b) ReentrantReadWriteLock readLock, (c) StampedLock optimistic read, (d) AtomicReference.get(). Use Scope.Benchmark for all (shared state). Run at 1, 4, 16 reader threads with 0 and 1 writer thread. When does StampedLock optimistic win? When does write contention eliminate its advantage?"
    },
    {
      "id": "pc-jmh-03",
      "description": "Benchmark I/O-bound throughput: 1000 tasks each sleeping 5ms. Compare: (a) 50-thread platform pool, (b) 200-thread platform pool, (c) virtual thread executor. Measure: wall-clock completion time, peak memory, and GC events. Use @BenchmarkMode(Mode.SampleTime) to capture P99 latency for each."
    },
    {
      "id": "pc-jmh-04",
      "description": "Benchmark PaymentService.processPayment() end-to-end using @BenchmarkMode(Mode.SampleTime) to measure P50, P95, P99, and P99.9 latency at 50 concurrent threads. Identify which percentile shows the highest variability and correlate it with GC pauses or lock contention using async-profiler."
    }
  ]
} -->
