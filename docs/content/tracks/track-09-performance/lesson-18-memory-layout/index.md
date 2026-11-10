---
id: track-09-lesson-18
title: "Memory Layout — Object Padding, Cache Lines, and False Sharing"
slug: memory-layout
track: track-09
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
> False sharing is a silent performance killer in concurrent financial systems. When two threads on different CPU cores modify fields that happen to share the same 64-byte cache line, they invalidate each other's cache on every write — causing 10–50x slowdowns in high-throughput counters, payment rate limiters, and concurrent balance accumulators. The fix is a single `@Contended` annotation, but you must first know where to look.

## Java Object Memory Layout

Every Java object has a header followed by its fields. The JVM aligns fields to minimize padding and optimize memory access.

### Object Header Structure

```
Java Object Header (Compressed OOPs enabled, 64-bit JVM):
┌───────────────────────────────────┐
│  Mark Word  (8 bytes)             │
│    - Identity hash code (25 bits) │
│    - GC age (4 bits)              │
│    - Lock state (2 bits)          │
│    - Biased lock (1 bit)          │
├───────────────────────────────────┤
│  Class Pointer (4 bytes)          │
│    - Compressed pointer to Class  │
├───────────────────────────────────┤
│  [Array length if array] (4 bytes)│
└───────────────────────────────────┘
Total header: 12 bytes (compressed OOPs)
              16 bytes (without compression, or arrays)
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

The JVM reordered fields: longs first (8-byte aligned), then ints, then booleans — minimizing padding from 7 bytes to 2 bytes.

---

## Cache Lines — The 64-Byte Boundary

Modern CPUs transfer memory in **cache lines** — 64 bytes at a time. When you read a single `long`, the CPU loads the entire 64-byte cache line containing it.

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
  → Throughput drops 10-50x for what appears to be a simple counter update
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
 * GOOD: @Contended pads each counter to its own cache line.
 * Requires JVM flag: -XX:-RestrictContended (or -XX:+EnableContended)
 * JDK 17+: use --add-opens java.base/jdk.internal.vm.annotation=ALL-UNNAMED
 */
@SuppressWarnings("restriction")
public class ContendedCounters {

    @Contended
    private volatile long authorizedCount = 0;

    @Contended
    private volatile long declinedCount   = 0;

    @Contended
    private volatile long errorCount      = 0;

    @Contended
    private volatile long pendingCount    = 0;

    // Each field now has 128 bytes of padding around it
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
    "-XX:-RestrictContended"
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

Benchmark results:

```
Benchmark                        Mode  Cnt        Score        Error    Units
FalseSharingBenchmark.shared    thrpt   20   28,341,235 ± 1,234,000  ops/ms
FalseSharingBenchmark.padded    thrpt   20  312,897,441 ± 4,567,000  ops/ms

Padded counters: 11x higher throughput — false sharing eliminated.
The gap grows with more cores and higher write frequency.
```

---

## LongAdder — Built-In False Sharing Solution

`LongAdder` (Java 8+) uses cell padding internally to avoid false sharing:

```java
/**
 * java.util.concurrent.atomic.LongAdder uses @Contended internally.
 * Each contended increment uses a different Cell (padded to cache line).
 *
 * Use LongAdder instead of AtomicLong for high-contention counters.
 * Trade-off: LongAdder.sum() is not atomic (snapshot), AtomicLong.get() is.
 *
 * For payment metrics: LongAdder is correct — you want throughput, not
 * exact point-in-time counts (use Micrometer Counter anyway).
 */
@Service
public class PaymentMetricsCounter {

    // GOOD: LongAdder scales linearly with thread count
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
 * Transaction processing state — optimized memory layout.
 *
 * Hot fields (read/written frequently) are grouped together
 * on the same cache line to maximize cache utilization.
 *
 * Cold fields (seldom accessed) are separated.
 */
public class OptimizedTransactionState {

    // ── HOT FIELDS: modified during authorization (same cache line) ────────
    // These 4 fields fit in 24 bytes; header takes 12 bytes; total = 36 bytes
    // All fit in one cache line — good for sequential access patterns

    private volatile long    amount;        // 8 bytes — most frequently read
    private volatile int     version;       // 4 bytes — optimistic locking
    private volatile int     status;        // 4 bytes — frequently checked
    private volatile boolean authorized;    // 1 byte
    private volatile boolean reversed;      // 1 byte
    // 2 bytes padding (JVM auto-inserts)

    // ── COLD FIELDS: metadata set once, seldom read ────────────────────────
    // These don't need to share a cache line with hot fields

    private String  transactionId;      // set once at creation
    private String  accountId;          // set once at creation
    private String  merchantId;         // set once at creation
    private long    createdTimestamp;   // set once at creation
    private String  referenceNumber;    // set once at creation
    private String  currencyCode;       // set once at creation

    // Constructor: sets cold fields
    public OptimizedTransactionState(String txId, String accountId,
            long amount, int status) {
        this.transactionId = txId;
        this.accountId = accountId;
        this.amount = amount;
        this.status = status;
        this.createdTimestamp = System.currentTimeMillis();
    }
}
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
 * Real-world scenario: Payment rate limiter for per-account limits.
 *
 * Problem: 10,000 accounts, each with their own counter.
 * With naive implementation, counters for adjacent accounts share cache lines.
 * Under heavy load (many threads incrementing different accounts simultaneously),
 * false sharing degrades throughput.
 */
@Component
public class PaymentRateLimiter {

    // NAIVE: array of counters — adjacent entries share cache lines
    private final long[] naiveCounters = new long[10_000];

    // PADDED: each counter occupies its own cache line (8 longs = 64 bytes)
    // 8 padding longs + 1 counter long = 9 longs per slot = 72 bytes
    // Rounded up to cache line: 128 bytes per entry
    private final long[] paddedCounters = new long[10_000 * 16]; // 16 longs per entry

    private static final int PADDING = 16;  // stride in padded array

    public boolean tryAuthorize(int accountId) {
        // Padded array access: each account's counter is cache-line isolated
        int index = accountId * PADDING;
        if (paddedCounters[index] >= getLimit(accountId)) {
            return false;
        }
        paddedCounters[index]++;
        return true;
    }

    /**
     * PREFERRED: Use LongAdder[] with one adder per account.
     * LongAdder handles padding internally and is thread-safe.
     */
    private final LongAdder[] countsByAccount = new LongAdder[10_000];

    @PostConstruct
    public void initCounters() {
        for (int i = 0; i < countsByAccount.length; i++) {
            countsByAccount[i] = new LongAdder();
        }
    }

    public boolean tryAuthorizeWithAdder(int accountId) {
        LongAdder counter = countsByAccount[accountId];
        if (counter.longValue() >= getLimit(accountId)) {
            return false;
        }
        counter.increment();
        return true;
    }

    private long getLimit(int accountId) {
        return 100;  // 100 payments per time window
    }
}
```

---

## Memory Layout Summary for Payment Engineers

| Object | Naive Size | Padded Size | Notes |
|--------|-----------|-------------|-------|
| `long` counter array | 8 bytes/entry | 128 bytes/entry | @Contended or stride-16 access |
| `Transaction` (20 fields) | 112 bytes | 112 bytes | No padding needed if not contended |
| Payment rate limit counter | 8 bytes | Use LongAdder | LongAdder handles padding |
| Authorizations-per-second metric | AtomicLong: 24B | LongAdder: ~200B | LongAdder is 10-50x faster at high contention |

---

## Key Takeaways for Financial Engineers

1. **False sharing silently kills throughput** — concurrent writes to fields sharing a cache line cause 10–50x performance degradation, with no obvious error messages
2. **Use `@Contended`** for fields that are frequently written by different threads simultaneously — per-account counters, global metrics, rate limiters
3. **Use `LongAdder` instead of `AtomicLong`** for high-contention counters (authorization counts, error rates, throughput metrics)
4. **JOL reveals actual memory layout** — do not assume field order matches source code order; the JVM reorders fields for alignment
5. **Cache line awareness matters for arrays** — if multiple threads write to adjacent array elements, consider stride-16 access patterns or use separate `LongAdder` instances
6. **Hot/cold field separation** — group frequently-read fields together (better cache utilisation) and separate them from cold metadata fields
7. **64 bytes is the magic number** — on x86/ARM modern CPUs, design data structures so that frequently co-accessed fields fit within 64 bytes, and that frequently independently-written fields are at least 64 bytes apart

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is false sharing and how does it cause 10-50x performance degradation in concurrent payment systems?",
      "options": [
        "False sharing occurs when two threads read the same data, causing inconsistency",
        "False sharing occurs when two threads write to different variables that happen to reside on the same CPU cache line; each write invalidates the other thread's cached copy, causing expensive cache coherence traffic",
        "False sharing is a Redis term for two services caching the same key with different TTLs",
        "False sharing occurs when a thread pool shares a queue between CPU-bound and I/O-bound tasks"
      ],
      "correct": 1,
      "explanation": "CPU cache lines are typically 64 bytes. If thread A updates a counter at offset 0 and thread B updates a counter at offset 8, both are in the same cache line. Each write by either thread invalidates the cache line in the other CPU's L1/L2 cache via the MESI protocol, forcing a cache line fetch. This cache coherence traffic dominates execution time, causing 10-50x slowdown for high-contention counters."
    },
    {
      "text": "Why should you use LongAdder instead of AtomicLong for a payment authorization counter under high contention?",
      "options": [
        "LongAdder supports floating-point precision; AtomicLong only stores integers",
        "AtomicLong uses a single CAS-contested location; under high contention, threads spin retrying CAS. LongAdder uses an array of cells with one cell per thread, reducing contention to near zero at the cost of a sum() call to read the value",
        "LongAdder is thread-safe; AtomicLong requires external synchronization",
        "AtomicLong cannot exceed Integer.MAX_VALUE; LongAdder handles larger values"
      ],
      "correct": 1,
      "explanation": "AtomicLong has one memory location that all threads compete to CAS-update. Under high contention (many threads incrementing simultaneously), most CAS operations fail and retry, wasting CPU. LongAdder maintains a striped array of cells. Each thread typically updates its own cell with minimal contention. sum() adds all cells. For throughput metrics in a payment service, LongAdder can be 10-50x faster than AtomicLong under contention."
    },
    {
      "text": "What does the @Contended annotation do in Java, and when should it be applied to fields in a payment service?",
      "options": [
        "@Contended marks a field as requiring locking for thread safety",
        "@Contended adds 64-byte padding around a field to ensure it occupies its own cache line, preventing false sharing with other fields; use it on fields that are frequently written by different threads concurrently",
        "@Contended enables JIT vectorization of array operations on the annotated field",
        "@Contended marks a field as volatile, ensuring visibility across threads without synchronization"
      ],
      "correct": 1,
      "explanation": "@Contended (sun.misc.Contended, available since Java 8, requires -XX:-RestrictContended in production) causes the JVM to add padding around the annotated field so it occupies its own cache line. This prevents false sharing when multiple threads write different @Contended fields. Use it for per-account rate limit counters, global throughput metrics, and other high-contention counters in the payment hot path."
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

