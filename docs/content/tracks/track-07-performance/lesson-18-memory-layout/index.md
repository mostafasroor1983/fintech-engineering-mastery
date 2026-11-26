---
id: track-07-lesson-18
title: "Memory Layout — Object Padding, Cache Lines, and False Sharing"
slug: memory-layout
track: track-07
trackName: "Performance Engineering"
sequence: 18
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [memory-layout, cache-line, false-sharing, padding, jol]
prerequisites: []
---

# Memory Layout — Object Padding, Cache Lines, and False Sharing

> [!NOTE]
> False sharing is a silent performance killer in concurrent financial systems. When two threads on different CPU cores modify fields that happen to share the same 64-byte cache line, they invalidate each other's cache on every write — which can slow high-throughput counters, payment rate limiters, and concurrent accumulators by an order of magnitude. The fixes are simple (`LongAdder`, padding, or the JDK-internal `@Contended`), but you must first know where to look.

## Java Object Memory Layout

Every Java object has a header followed by its fields. The JVM aligns fields to minimize padding and optimize memory access.

### Object Header Structure

```
Java Object Header (64-bit HotSpot, compressed class pointers — the default):
┌───────────────────────────────────┐
│  Mark Word  (8 bytes)             │
│    - Identity hash code (31 bits) │
│    - GC age (4 bits)              │
│    - Lock state (2 bits)          │
│    (biased locking was removed    │
│     in JDK 18)                    │
├───────────────────────────────────┤
│  Class Pointer (4 bytes)          │
│    - Compressed pointer to Class  │
├───────────────────────────────────┤
│  [Array length if array] (4 bytes)│
└───────────────────────────────────┘
Total header: 12 bytes (objects), 16 bytes (arrays)
              16 bytes for objects without compressed class pointers
(JDK 24 adds experimental 8-byte "compact object headers", JEP 450.)
```

### Field Alignment and Padding

The JVM reorders fields to minimize padding and align to their natural alignment:

```java
// Define a transaction object — observe actual memory layout
public class Transaction {
    private boolean processed;   // 1 byte
    private long    amount;      // 8 bytes — requires 8-byte alignment
    private int     version;     // 4 bytes
    private boolean reversed;    // 1 byte
    private long    timestamp;   // 8 bytes
    private int     accountId;   // 4 bytes
}
```

Using JOL (Java Object Layout) to inspect the actual layout:

```bash
# Add JOL to pom.xml:
# <dependency>
#   <groupId>org.openjdk.jol</groupId>
#   <artifactId>jol-core</artifactId>
#   <version>0.17</version>
# </dependency>
```

```java
import org.openjdk.jol.info.ClassLayout;
import org.openjdk.jol.info.GraphLayout;

public class LayoutInspector {

    public static void main(String[] args) {
        System.out.println(ClassLayout.parseClass(Transaction.class).toPrintable());
    }
}
```

Output (JVM reorders fields for alignment):

```
com.fintech.Transaction object internals:
OFFSET  SIZE      TYPE DESCRIPTION                VALUE
     0     4           (object header)            01 00 00 00
     4     4           (object header)            00 00 00 00
     8     4           (object header)            XX XX XX XX  (class pointer)
    12     4       int Transaction.version
    16     8      long Transaction.amount
    24     8      long Transaction.timestamp
    32     4       int Transaction.accountId
    36     1   boolean Transaction.processed
    37     1   boolean Transaction.reversed
    38     2           (alignment/padding gap)
Instance size: 40 bytes
Space losses: 2 bytes internal + 0 bytes external = 2 bytes total
```

The JVM reordered fields: it filled the gap after the header with an int, then placed the longs (8-byte aligned), then the remaining int, then the booleans — cutting padding from 7 bytes to 2 bytes.

---

## Cache Lines — The 64-Byte Boundary

Modern CPUs transfer memory in **cache lines** — 64 bytes at a time on most x86 and ARM server CPUs (Apple M-series use 128-byte lines, and Intel's adjacent-line prefetcher often moves pairs of 64-byte lines — which is why the JVM's `@Contended` pads with 128 bytes). When you read a single `long`, the CPU loads the entire 64-byte cache line containing it.

```
CPU Cache Line (64 bytes):
┌────────────────────────────────────────────────────────────────┐
│  Byte 0-7: Transaction.amount                                  │
│  Byte 8-15: Transaction.timestamp                              │
│  Byte 16-23: (padding / next object's data)                    │
│  ...                                                           │
│  Byte 56-63: (more data)                                       │
└────────────────────────────────────────────────────────────────┘
```

**Cache line consequence**: If two frequently-accessed fields are within 64 bytes of each other, reads to either field may bring both into the L1 cache — this is good (spatial locality).

---

## False Sharing — When Cache Lines Work Against You

False sharing occurs when two threads on different CPU cores write to **different** variables that happen to reside on the **same** cache line:

```
Core 1 (payment-auth-thread-1): writes to counter.authorizedCount
Core 2 (payment-auth-thread-2): writes to counter.declinedCount

If authorizedCount and declinedCount are adjacent in memory (same cache line):
  → Core 1 writes authorizedCount: invalidates cache line on Core 2
  → Core 2 writes declinedCount: invalidates cache line on Core 1
  → Both cores ping-pong the cache line across the CPU interconnect
  → Throughput can drop by an order of magnitude for what looks like a
    simple counter update
```

### Demonstrating False Sharing

```java
/**
 * Payment authorization counter — naive implementation with false sharing.
 */
public class FalseSharingCounters {

    // BAD: both counters on the same cache line
    private volatile long authorizedCount = 0;   // offset 0-7 of cache line
    private volatile long declinedCount   = 0;   // offset 8-15 of cache line
    private volatile long errorCount      = 0;   // offset 16-23 of cache line
    private volatile long pendingCount    = 0;   // offset 24-31 of cache line
    // All four counters share ONE 64-byte cache line
    // Concurrent writes from multiple threads cause constant cache line invalidation

    // ALSO WRONG: ++ on a volatile is not atomic (read, add, write) --
    // two threads incrementing the same counter lose updates.
    // This class shows the LAYOUT problem only; use LongAdder in real code.
    public void recordAuthorized() { authorizedCount++; }
    public void recordDeclined()   { declinedCount++;   }
    public void recordError()      { errorCount++;      }
    public void recordPending()    { pendingCount++;     }
}
```

---

## @Contended Annotation — The Fix

```java
import jdk.internal.vm.annotation.Contended;

/**
 * @Contended pads each counter to its own cache line.
 * It is a JDK-INTERNAL annotation (sun.misc.Contended in Java 8,
 * jdk.internal.vm.annotation.Contended since Java 9). Outside the JDK it is
 * ignored unless you run with -XX:-RestrictContended, and you must compile
 * and run with --add-exports java.base/jdk.internal.vm.annotation=ALL-UNNAMED.
 * Prefer LongAdder (below) or manual padding in application code.
 */
public class ContendedCounters {

    @Contended
    private volatile long authorizedCount = 0;

    @Contended
    private volatile long declinedCount   = 0;

    @Contended
    private volatile long errorCount      = 0;

    @Contended
    private volatile long pendingCount    = 0;

    // Each field now has padding around it (128 bytes by default,
    // -XX:ContendedPaddingWidth)
    // No two counters share a cache line
    // Concurrent increments no longer invalidate each other's caches
}
```

What `@Contended` does to memory layout:

```
Without @Contended (false sharing):
┌─────────────────────────────────────────────────────┐  Cache line 1
│  authorizedCount [8] | declinedCount [8] | error [8]│
│  pendingCount [8] | (padding 24 bytes)              │
└─────────────────────────────────────────────────────┘

With @Contended (no false sharing):
┌─────────────────────────────────────────────────────┐  Cache line 1
│  authorizedCount [8] | padding [56 bytes]           │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐  Cache line 2
│  declinedCount [8]  | padding [56 bytes]            │
└─────────────────────────────────────────────────────┘
...and so on
```

---

## JMH False Sharing Benchmark

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Benchmark)
@Fork(value = 2, jvmArgs = {
    "-Xms2g", "-Xmx2g",
    "-XX:-RestrictContended",
    "--add-exports", "java.base/jdk.internal.vm.annotation=ALL-UNNAMED"
})
@Warmup(iterations = 5, time = 10)
@Measurement(iterations = 10, time = 10)
public class FalseSharingBenchmark {

    // ── False sharing setup ───────────────────────────────────────────────

    static class SharedCounters {
        volatile long authorizedCount = 0;
        volatile long declinedCount   = 0;
    }

    // ── No false sharing setup ────────────────────────────────────────────

    static class PaddedCounters {
        @Contended volatile long authorizedCount = 0;
        @Contended volatile long declinedCount   = 0;
    }

    private final SharedCounters  shared  = new SharedCounters();
    private final PaddedCounters  padded  = new PaddedCounters();

    // Thread 1 increments authorizedCount, Thread 2 increments declinedCount
    // Both operations happening concurrently

    @Benchmark
    @Group("shared")
    @GroupThreads(1)
    public void sharedAuthorized() {
        shared.authorizedCount++;
    }

    @Benchmark
    @Group("shared")
    @GroupThreads(1)
    public void sharedDeclined() {
        shared.declinedCount++;
    }

    @Benchmark
    @Group("padded")
    @GroupThreads(1)
    public void paddedAuthorized() {
        padded.authorizedCount++;
    }

    @Benchmark
    @Group("padded")
    @GroupThreads(1)
    public void paddedDeclined() {
        padded.declinedCount++;
    }
}
```

Illustrative results (2 threads on different cores):

```
Benchmark                        Mode  Cnt        Score        Error    Units
FalseSharingBenchmark.shared    thrpt   20       41,300 ±      1,900  ops/ms
FalseSharingBenchmark.padded    thrpt   20      612,800 ±      9,400  ops/ms

Padded counters: ~15x higher throughput — false sharing eliminated.
The exact gap depends on the CPU and on whether the threads share a core.
```

---

## LongAdder — Built-In False Sharing Solution

`LongAdder` (Java 8+) uses cell padding internally to avoid false sharing:

```java
/**
 * java.util.concurrent.atomic.LongAdder uses @Contended internally.
 * Under contention, threads spread their increments over striped Cells
 * (up to about one per CPU), each padded to its own cache line.
 *
 * Use LongAdder instead of AtomicLong for high-contention counters.
 * Trade-off: LongAdder.sum() is not atomic (snapshot), AtomicLong.get() is.
 *
 * For payment metrics: LongAdder is correct — you want throughput, not
 * exact point-in-time counts (use Micrometer Counter anyway).
 */
@Service
public class PaymentMetricsCounter {

    // GOOD: LongAdder scales well as more threads update it
    private final LongAdder authorizedCount  = new LongAdder();
    private final LongAdder declinedCount    = new LongAdder();
    private final LongAdder totalAmountCents = new LongAdder();

    // BAD for high contention: AtomicLong uses CAS, contends on single memory location
    // private final AtomicLong authorizedCount = new AtomicLong(0);

    public void recordAuthorized(long amountCents) {
        authorizedCount.increment();
        totalAmountCents.add(amountCents);
    }

    public void recordDeclined() {
        declinedCount.increment();
    }

    public PaymentStats getStats() {
        return new PaymentStats(
            authorizedCount.sum(),   // snapshot — not atomic across all cells
            declinedCount.sum(),
            totalAmountCents.sum()
        );
    }
}
```

---

## Padding Strategies for Transaction Objects

For high-frequency objects that are modified on critical paths:

```java
/**
 * Transaction processing state — hot/cold separation.
 *
 * IMPORTANT: the JVM decides field order itself (by size, see the JOL
 * output above) -- the order you write fields in the source does NOT
 * control the layout. To keep hot fields together and apart from cold
 * ones, put them in SEPARATE OBJECTS.
 */
public class OptimizedTransactionState {

    // ── HOT: modified during authorization — a small object of its own ────
    // 12-byte header + 8 + 4 + 4 + 1 + 1 = 30 bytes -> 32 with padding:
    // fits easily in one cache line
    static final class Hot {
        volatile long    amount;        // most frequently read
        volatile int     version;       // optimistic locking
        volatile int     status;        // frequently checked
        volatile boolean authorized;
        volatile boolean reversed;
    }

    private final Hot hot = new Hot();

    // ── COLD: metadata set once, seldom read ──────────────────────────────
    private final String transactionId;
    private final String accountId;
    private final long   createdTimestamp;
    private String merchantId;
    private String referenceNumber;
    private String currencyCode;

    public OptimizedTransactionState(String txId, String accountId,
            long amount, int status) {
        this.transactionId = txId;
        this.accountId = accountId;
        this.createdTimestamp = System.currentTimeMillis();
        this.hot.amount = amount;
        this.hot.status = status;
    }
}
// Only worth doing for objects that are measured hot. For most payment
// code, readable classes matter far more than field placement.
```

---

## Inspecting Transaction Objects with JOL

```java
@Component
public class MemoryLayoutAnalyzer {

    @PostConstruct
    public void analyzeLayouts() {
        // Analyze Payment object
        ClassLayout paymentLayout = ClassLayout.parseClass(Payment.class);
        log.info("Payment layout:\n{}", paymentLayout.toPrintable());

        // Analyze Transaction object
        ClassLayout txLayout = ClassLayout.parseClass(Transaction.class);
        log.info("Transaction layout:\n{}", txLayout.toPrintable());

        // Measure instance size
        log.info("Payment instance size: {} bytes", paymentLayout.instanceSize());
        log.info("Transaction instance size: {} bytes", txLayout.instanceSize());

        // Calculate objects per cache line
        int paymentSize = (int) paymentLayout.instanceSize();
        double perCacheLine = 64.0 / paymentSize;
        log.info("Payment objects per 64-byte cache line: {}", perCacheLine);

        // For arrays: check element spacing
        ClassLayout arrayLayout = ClassLayout.parseInstance(new Payment[1]);
        log.info("Payment[] layout:\n{}", arrayLayout.toPrintable());
    }

    /**
     * Calculate memory footprint of a list of transactions.
     * Essential for capacity planning: how much heap does
     * 1 million in-flight transactions consume?
     */
    public long estimateHeapUsage(Class<?> objectClass, long objectCount) {
        ClassLayout layout = ClassLayout.parseClass(objectClass);
        // SHALLOW size only: the Strings, BigDecimals and lists the object
        // points to are extra. For the deep size of a real instance use
        // GraphLayout.parseInstance(obj).totalSize().
        long bytesPerObject = layout.instanceSize();
        // Object reference: 4 bytes (compressed OOPs) or 8 bytes
        long referenceSize = 4;
        return objectCount * (bytesPerObject + referenceSize);
    }
}
```

---

## Impact on Concurrent Financial Counters

```java
/**
 * Scenario: payment rate limiter for per-account limits.
 *
 * Problem: 10,000 accounts, each with their own counter.
 * With a plain array, counters for adjacent accounts share cache lines.
 * Under heavy load (many threads updating different accounts at once),
 * false sharing degrades throughput.
 *
 * But first: CORRECTNESS. "check the count, then increment" is a race --
 * two threads can both see 99 and both allow payment number 100.
 * A limiter needs an ATOMIC update.
 */
@Component
public class PaymentRateLimiter {

    // NAIVE: plain long[] — adjacent entries share cache lines,
    // AND the check-then-increment below is not atomic (can exceed the limit)
    private final long[] naiveCounters = new long[10_000];

    public boolean tryAuthorizeNaive(int accountId) {
        if (naiveCounters[accountId] >= getLimit(accountId)) return false;
        naiveCounters[accountId]++;           // race: lost updates, over-limit
        return true;
    }

    // BETTER: atomic counters, spaced 16 longs (128 bytes) apart so that
    // each account's counter sits on its own cache line(s)
    private static final int STRIDE = 16;
    private final AtomicLongArray paddedCounters = new AtomicLongArray(10_000 * STRIDE);

    public boolean tryAuthorize(int accountId) {
        int index = accountId * STRIDE;
        long newCount = paddedCounters.incrementAndGet(index);   // atomic
        if (newCount > getLimit(accountId)) {
            paddedCounters.decrementAndGet(index);              // undo: over limit
            return false;
        }
        return true;
    }

    // (LongAdder is great for METRICS, but it cannot do an atomic
    //  "increment only if below the limit" -- don't use it for enforcement.)

    private long getLimit(int accountId) {
        return 100;  // 100 payments per time window
    }
}
// In a multi-instance service the limit must be shared anyway (e.g. Redis,
// lesson 11) -- an in-memory limiter only limits ONE instance.
```

---

## Memory Layout Summary for Payment Engineers

| Object | Naive Size | Padded Size | Notes |
|--------|-----------|-------------|-------|
| `long` counter array | 8 bytes/entry | 128 bytes/entry | @Contended or stride-16 access |
| `Transaction` (20 fields) | 112 bytes | 112 bytes | No padding needed if not contended |
| Payment rate limit counter | 8 bytes | 128 bytes (padded atomic slot) | Needs an atomic check-and-increment |
| Authorizations-per-second metric | AtomicLong: 24B | LongAdder: larger, grows under contention | LongAdder is much faster at high contention |

---

## Key Takeaways for Financial Engineers

1. **False sharing silently kills throughput** — concurrent writes to fields sharing a cache line can cost an order of magnitude, with no obvious error messages
2. **Pad fields that different threads write at the same time** — use `LongAdder` or manual padding/stride in application code; `@Contended` is JDK-internal and needs special JVM flags
3. **Use `LongAdder` instead of `AtomicLong`** for high-contention counters (authorization counts, error rates, throughput metrics)
4. **JOL reveals actual memory layout** — do not assume field order matches source code order; the JVM reorders fields for alignment
5. **Cache line awareness matters for arrays** — if multiple threads write to adjacent array elements, consider stride-16 access patterns or use separate `LongAdder` instances
6. **Hot/cold field separation** — the JVM orders fields itself, so separate hot fields from cold metadata by putting them in different objects
7. **64 bytes is the usual number** — on most x86/ARM server CPUs, design data structures so that frequently co-accessed fields fit within 64 bytes, and frequently independently-written fields are at least 64 bytes apart (128 to be safe with adjacent-line prefetching or 128-byte lines)

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is false sharing and how can it slow concurrent payment systems by an order of magnitude?",
      "options": [
        "False sharing occurs when two threads read the same data, causing inconsistency",
        "False sharing occurs when two threads write to different variables that happen to reside on the same CPU cache line; each write invalidates the other thread's cached copy, causing expensive cache coherence traffic",
        "False sharing is a Redis term for two services caching the same key with different TTLs",
        "False sharing occurs when a thread pool shares a queue between CPU-bound and I/O-bound tasks"
      ],
      "correct": 1,
      "explanation": "CPU cache lines are typically 64 bytes. If thread A updates a counter at offset 0 and thread B updates a counter at offset 8, both are in the same cache line. Each write by either thread invalidates the cache line in the other core's cache (cache-coherence protocols such as MESI), forcing the line to move between cores. This coherence traffic can dominate execution time and slow high-contention counters by an order of magnitude."
    },
    {
      "text": "Why should you use LongAdder instead of AtomicLong for a payment authorization counter under high contention?",
      "options": [
        "LongAdder supports floating-point precision; AtomicLong only stores integers",
        "AtomicLong uses a single CAS-contested location; under high contention, threads spin retrying CAS. LongAdder spreads updates over striped cells (up to about one per CPU), reducing contention to near zero at the cost of a sum() call to read the value",
        "LongAdder is thread-safe; AtomicLong requires external synchronization",
        "AtomicLong cannot exceed Integer.MAX_VALUE; LongAdder handles larger values"
      ],
      "correct": 1,
      "explanation": "AtomicLong has one memory location that all threads compete to CAS-update. Under high contention, many CAS operations fail and retry, wasting CPU. LongAdder keeps a base value plus a striped array of padded cells; contending threads update different cells, and sum() adds them up. For throughput metrics in a payment service, LongAdder can be many times faster than AtomicLong under contention. It cannot, however, do an atomic conditional update — so it is for metrics, not limit enforcement."
    },
    {
      "text": "What does the @Contended annotation do in Java, and when should it be applied to fields in a payment service?",
      "options": [
        "@Contended marks a field as requiring locking for thread safety",
        "@Contended adds padding (128 bytes by default) around a field so it occupies its own cache line(s), preventing false sharing with other fields; it suits fields that different threads write concurrently — but it is JDK-internal and needs JVM flags in application code",
        "@Contended enables JIT vectorization of array operations on the annotated field",
        "@Contended marks a field as volatile, ensuring visibility across threads without synchronization"
      ],
      "correct": 1,
      "explanation": "@Contended (sun.misc.Contended in Java 8, jdk.internal.vm.annotation.Contended since Java 9) makes the JVM pad the annotated field so it sits on its own cache line(s), preventing false sharing between fields that different threads write. The JDK uses it itself (for example in LongAdder's cells and Thread fields). In application code it is ignored unless the JVM runs with -XX:-RestrictContended, and you need --add-exports to compile against it — so LongAdder or manual padding is usually the better choice."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "False Sharing Detection and Fix for Payment Rate Limiters",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Write a JMH benchmark that demonstrates false sharing: create an array of 8 long counters (one per thread), measure throughput with threads writing to adjacent array indices vs stride-16 indices that place each counter on a separate cache line."},
    {"id": "2", "description": "Implement a PerAccountRateLimiter that uses @Contended or LongAdder to maintain per-account authorization counters without false sharing, supporting concurrent reads and writes from multiple threads."},
    {"id": "3", "description": "Use Java Object Layout (JOL) to print the memory layout of a PaymentRequest class and identify any unexpected field ordering or padding. Restructure the class to co-locate frequently-read fields in the first 64 bytes."},
    {"id": "4", "description": "Write a ConcurrentCounterBenchmark comparing AtomicLong, LongAdder, and a @Contended long field under 8-thread contention, reporting operations per second for each implementation."}
  ]
}
-->

