---
id: track-07-lesson-18
title: "تخطيط الذاكرة — حشو الكائنات وخطوط الذاكرة والمشاركة الزائفة"
slug: memory-layout
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 18
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [memory-layout, cache-line, false-sharing, padding, jol]
prerequisites: []
---

# تخطيط الذاكرة — حشو الكائنات وخطوط الذاكرة المخبئية والمشاركة الزائفة

> [!NOTE]
> المشاركة الزائفة (false sharing) قاتل أداء صامت في الأنظمة المالية المتزامنة. فحين يعدّل خيطان على أنوية معالج مختلفة حقولًا تقع صدفة في خط ذاكرة مخبئية واحد بحجم 64 بايت، يُبطل كل منهما ذاكرة الآخر المخبئية مع كل كتابة — ما قد يُبطئ العدادات عالية الإنتاجية، ومحددات معدل الدفع، والمراكمات المتزامنة بمرتبة كاملة. والإصلاحات بسيطة (`LongAdder`، أو الحشو، أو `@Contended` الداخلي في JDK)، لكن يجب أن تعرف أولًا أين تبحث.

## تخطيط كائن Java في الذاكرة

لكل كائن Java ترويسة تليها حقوله. ويرصف JVM الحقول لتقليل الحشو وتحسين الوصول إلى الذاكرة.

### بنية ترويسة الكائن

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

### رصف الحقول والحشو

يعيد JVM ترتيب الحقول لتقليل الحشو ورصفها وفق رصفها الطبيعي:

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

استخدام JOL ‏(Java Object Layout) لفحص التخطيط الفعلي:

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

المخرجات (يعيد JVM ترتيب الحقول للرصف):

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

أعاد JVM ترتيب الحقول: ملأ الفجوة بعد الترويسة بحقل int، ثم الأنواع long (برصف 8 بايت)، ثم int، ثم boolean — فقلّل الحشو من 7 بايت إلى 2 بايت.

## خطوط الذاكرة المخبئية — حدود الـ 64 بايت

تنقل المعالجات الحديثة الذاكرة في **خطوط ذاكرة مخبئية (cache lines)** — 64 بايت في كل مرة على معظم معالجات الخوادم بمعمارية x86 وARM (تستخدم معالجات Apple M خطوطًا بحجم 128 بايت، وكثيرًا ما ينقل مُحضِر الخط المجاور في Intel أزواجًا من خطوط 64 بايت — ولهذا يحشو `@Contended` في JVM بـ 128 بايت). فحين تقرأ `long` واحدًا، يحمّل المعالج خط الـ 64 بايت كاملًا الذي يحتويه.

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

**نتيجة خط الذاكرة المخبئية**: إذا كان حقلان كثيرا الوصول ضمن 64 بايت من بعضهما، فقد تجلب القراءة لأي منهما كليهما إلى ذاكرة L1 المخبئية — وهذا جيد (المحلية المكانية).

## المشاركة الزائفة — حين تعمل خطوط الذاكرة المخبئية ضدك

تحدث المشاركة الزائفة حين يكتب خيطان على أنوية معالج مختلفة إلى متغيرات **مختلفة** تقع صدفة في خط الذاكرة المخبئية **نفسه**:

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

### توضيح المشاركة الزائفة

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

## التعليق التوضيحي ‎@Contended — الإصلاح

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

ما يفعله `@Contended` بتخطيط الذاكرة:

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

## مقياس JMH للمشاركة الزائفة

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

```
Benchmark                        Mode  Cnt        Score        Error    Units
FalseSharingBenchmark.shared    thrpt   20       41,300 ±      1,900  ops/ms
FalseSharingBenchmark.padded    thrpt   20      612,800 ±      9,400  ops/ms

Padded counters: ~15x higher throughput — false sharing eliminated.
The exact gap depends on the CPU and on whether the threads share a core.
```

## ‏LongAdder — حل مدمج للمشاركة الزائفة

يستخدم `LongAdder` ‏(Java 8+) حشو الخلايا داخليًا لتجنب المشاركة الزائفة:

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

## استراتيجيات الحشو لكائنات المعاملات

للكائنات عالية التكرار التي تُعدّل على المسارات الحرجة:

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

## فحص كائنات المعاملات بـ JOL

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

## الأثر على العدادات المالية المتزامنة

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

## ملخص تخطيط الذاكرة لمهندسي الدفع

| الكائن | الحجم الساذج | الحجم المحشو | ملاحظات |
|--------|-----------|-------------|-------|
| مصفوفة عدادات `long` | ‏8 بايت/مدخل | ‏128 بايت/مدخل | ‏@Contended أو وصول بخطوة 16 |
| ‏`Transaction` ‏(20 حقلًا) | ‏112 بايت | ‏112 بايت | لا حاجة للحشو إن لم يكن متنازعًا عليه |
| عداد حد معدل الدفع | ‏8 بايت | ‏128 بايت (خانة ذرية محشوة) | يحتاج فحصًا وزيادة ذريين |
| مقياس التفويضات في الثانية | ‏AtomicLong: ‏24 بايت | ‏LongAdder: أكبر، وينمو تحت التنازع | ‏LongAdder أسرع كثيرًا تحت التنازع العالي |

## الخلاصات الأساسية للمهندسين الماليين

1. **المشاركة الزائفة تقتل الإنتاجية بصمت** — الكتابات المتزامنة إلى حقول تتشارك خط ذاكرة مخبئية قد تكلف مرتبة كاملة، دون رسائل خطأ واضحة
2. **احشُ الحقول التي تكتبها خيوط مختلفة في الوقت نفسه** — استخدم `LongAdder` أو الحشو/الخطوة اليدوية في شيفرة التطبيق؛ فـ `@Contended` داخلي في JDK ويحتاج خيارات JVM خاصة
3. **استخدم `LongAdder` بدل `AtomicLong`** للعدادات عالية التنازع (أعداد التفويض، ونسب الأخطاء، ومقاييس الإنتاجية)
4. **‏JOL يكشف تخطيط الذاكرة الفعلي** — لا تفترض أن ترتيب الحقول يطابق ترتيبها في الشيفرة المصدرية؛ فـ JVM يعيد ترتيب الحقول للرصف
5. **الوعي بخطوط الذاكرة المخبئية مهم للمصفوفات** — إذا كتبت خيوط متعددة إلى عناصر مصفوفة متجاورة، ففكّر في أنماط وصول بخطوة 16 أو استخدم نسخ `LongAdder` منفصلة
6. **فصل الحقول الساخنة عن الباردة** — يرتّب JVM الحقول بنفسه، فافصل الحقول الساخنة عن بيانات الوصف الباردة بوضعها في كائنات مختلفة
7. **‏64 بايت هو الرقم المعتاد** — على معظم معالجات الخوادم x86/ARM، صمم هياكل البيانات بحيث تتسع الحقول التي يُوصل إليها معًا ضمن 64 بايت، وتبعد الحقول المكتوبة باستقلال كثيرًا 64 بايت على الأقل (128 للأمان مع الإحضار المسبق للخط المجاور أو الخطوط بحجم 128 بايت)

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما المشاركة الزائفة وكيف يمكن أن تُبطئ أنظمة الدفع المتزامنة بمرتبة كاملة؟",
      "options": [
        "تحدث المشاركة الزائفة حين يقرأ خيطان البيانات نفسها، فيسبب ذلك عدم اتساق",
        "تحدث المشاركة الزائفة حين يكتب خيطان إلى متغيرات مختلفة تقع صدفة في خط الذاكرة المخبئية نفسه في المعالج؛ فكل كتابة تُبطل النسخة المخبأة لدى الخيط الآخر، ما يسبب حركة تماسك ذاكرة مخبئية مكلفة",
        "المشاركة الزائفة مصطلح في Redis لخدمتين تخزنان المفتاح نفسه بـ TTL مختلف",
        "تحدث المشاركة الزائفة حين يتشارك مجمع خيوط طابورًا بين مهام مقيدة بالمعالج وأخرى مقيدة بالإدخال/الإخراج"
      ],
      "correct": 1,
      "explanation": "خطوط الذاكرة المخبئية في المعالج عادة 64 بايت. فإذا حدّث الخيط A عدادًا عند الإزاحة 0 وحدّث الخيط B عدادًا عند الإزاحة 8، فكلاهما في خط الذاكرة المخبئية نفسه. وكل كتابة من أي منهما تُبطل الخط في ذاكرة النواة الأخرى (بروتوكولات تماسك مثل MESI)، فيُجبر الخط على التنقل بين الأنوية. وقد تهيمن حركة التماسك هذه على زمن التنفيذ فتُبطئ العدادات عالية التنازع بمرتبة كاملة."
    },
    {
      "text": "لماذا يجب استخدام LongAdder بدل AtomicLong لعداد تفويضات دفع تحت تنازع عالٍ؟",
      "options": [
        "يدعم LongAdder دقة الفاصلة العائمة؛ وAtomicLong يخزن أعدادًا صحيحة فقط",
        "يستخدم AtomicLong موقعًا واحدًا متنازعًا عليه بـ CAS؛ وتحت التنازع العالي تدور الخيوط في إعادة محاولة CAS. أما LongAdder فيوزع التحديثات على خلايا مخططة (حتى نحو خلية لكل معالج)، فيقلل التنازع إلى قرب الصفر مقابل استدعاء sum() لقراءة القيمة",
        "LongAdder آمن للخيوط؛ وAtomicLong يتطلب تزامنًا خارجيًا",
        "لا يمكن أن يتجاوز AtomicLong قيمة Integer.MAX_VALUE؛ وLongAdder يتعامل مع قيم أكبر"
      ],
      "correct": 1,
      "explanation": "لـ AtomicLong موقع ذاكرة واحد تتنافس كل الخيوط على تحديثه بـ CAS. وتحت التنازع العالي، تفشل كثير من عمليات CAS وتُعاد، فيُهدر المعالج. أما LongAdder فيحتفظ بقيمة أساسية بالإضافة إلى مصفوفة مخططة من الخلايا المحشوة؛ فتحدّث الخيوط المتنازعة خلايا مختلفة، ويجمعها sum(). ولمقاييس الإنتاجية في خدمة دفع، قد يكون LongAdder أسرع بمرات كثيرة من AtomicLong تحت التنازع. لكنه لا يستطيع إجراء تحديث شرطي ذري — فهو للمقاييس، لا لفرض الحدود."
    },
    {
      "text": "ماذا يفعل التعليق ‎@Contended في Java، ومتى يجب تطبيقه على الحقول في خدمة دفع؟",
      "options": [
        "يعلّم ‎@Contended حقلًا بأنه يتطلب قفلًا لأمان الخيوط",
        "يضيف ‎@Contended حشوًا (128 بايت افتراضيًا) حول حقل كي يشغل خط (خطوط) ذاكرة مخبئية خاصًا به، فيمنع المشاركة الزائفة مع حقول أخرى؛ ويناسب الحقول التي تكتبها خيوط مختلفة بالتزامن — لكنه داخلي في JDK ويحتاج خيارات JVM في شيفرة التطبيق",
        "يفعّل ‎@Contended التحويل المتجهي في JIT لعمليات المصفوفات على الحقل المعلّم",
        "يعلّم ‎@Contended حقلًا بأنه volatile، فيضمن الرؤية عبر الخيوط دون تزامن"
      ],
      "correct": 1,
      "explanation": "‏@Contended ‏(sun.misc.Contended في Java 8، وjdk.internal.vm.annotation.Contended منذ Java 9) يجعل JVM يحشو الحقل المعلّم كي يقع في خط (خطوط) ذاكرة مخبئية خاص به، فيمنع المشاركة الزائفة بين حقول تكتبها خيوط مختلفة. ويستخدمه JDK نفسه (مثلًا في خلايا LongAdder وحقول Thread). وفي شيفرة التطبيق يُتجاهل ما لم يعمل JVM بـ -XX:-RestrictContended، وتحتاج --add-exports للترجمة مقابله — لذا فـ LongAdder أو الحشو اليدوي عادة الخيار الأفضل."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "كشف المشاركة الزائفة وإصلاحها لمحددات معدل الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "اكتب مقياس JMH يبيّن المشاركة الزائفة: أنشئ مصفوفة من 8 عدادات long (واحد لكل خيط)، وقِس الإنتاجية مع خيوط تكتب إلى فهارس مصفوفة متجاورة مقابل فهارس بخطوة 16 تضع كل عداد في خط ذاكرة مخبئية منفصل."},
    {"id": "2", "description": "نفّذ PerAccountRateLimiter يستخدم ‎@Contended أو LongAdder للحفاظ على عدادات تفويض لكل حساب دون مشاركة زائفة، مع دعم القراءات والكتابات المتزامنة من خيوط متعددة."},
    {"id": "3", "description": "استخدم Java Object Layout ‏(JOL) لطباعة تخطيط الذاكرة لصنف PaymentRequest وحدد أي ترتيب حقول أو حشو غير متوقع. وأعد هيكلة الصنف لوضع الحقول كثيرة القراءة معًا في أول 64 بايت."},
    {"id": "4", "description": "اكتب ConcurrentCounterBenchmark يقارن AtomicLong، وLongAdder، وحقل long معلّمًا بـ ‎@Contended تحت تنازع 8 خيوط، ويُبلغ عن العمليات في الثانية لكل تنفيذ."}
  ]
}
-->
