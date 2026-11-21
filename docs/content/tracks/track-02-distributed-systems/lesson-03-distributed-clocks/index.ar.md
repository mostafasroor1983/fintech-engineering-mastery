---
id: track-02-lesson-03
title: "الساعات الموزعة — ساعات Lamport والساعات المتجهة وTrueTime"
slug: distributed-clocks
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 3
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Lamport-clock, vector-clock, TrueTime, clock-sync, NTP]
prerequisites: []
---

# الساعات الموزعة — ساعات Lamport والساعات المتجهة وTrueTime

> [!NOTE]
> في منصة دفع موزعة، فكرة أن خادمين استلما دفعة "في الوقت نفسه" وهم. فالساعات تنحرف، ومزامنة NTP غير كاملة، و"2024-01-15 10:00:00.000" على العقدة A قد تقابل 10:00:00.015 على العقدة B. ولترتيب المعاملات المالية، وتسلسل التسوية، وسلامة سجل التدقيق، ليس فهم الساعات الموزعة تمرينًا أكاديميًا — بل متطلب إنتاجي.

## لماذا تفشل ساعات الحائط في الأنظمة الموزعة

يصادف كل مهندس أنظمة موزعة في النهاية **مشكلة انحراف الساعات**: لا تستطيع عقدتان في نظام موزع الاتفاق على الوقت الحالي، والخلاف غير محدود عند وقوع الأعطال.

```
Clock Skew in a Payment Network:

Node A (payment-service-1): clock is accurate
Node B (payment-service-2): clock is 15ms AHEAD of real time

Real time 09:59:59.990  Payment P2 arrives at Node B
                        Node B stamps it 10:00:00.005   (15ms ahead)
Real time 10:00:00.000  Payment P1 arrives at Node A
                        Node A stamps it 10:00:00.000

Sorted by timestamp:  P1 (10:00:00.000) before P2 (10:00:00.005)
What really happened: P2 arrived 10ms BEFORE P1

The timestamps reverse the real order. If both payments draw on the same
balance, the wrong one may be declined for insufficient funds — and no
log line will show why.
```

في هذا المثال تصل الدفعة P2 فعليًا قبل P1 بـ 10ms، لكن ساعة العقدة B متقدمة 15ms، فتختم P2 بوقت لاحق. فالطوابع الزمنية تعكس الترتيب الحقيقي. وإذا كانت الدفعتان تسحبان من الرصيد نفسه، قد تُرفض الدفعة الخطأ لعدم كفاية الرصيد — ولن يُظهر أي سطر في السجلات السبب.

### NTP لا يكفي للترتيب المالي

يحافظ بروتوكول NTP عادة على الساعات ضمن مللي ثانية تقريبًا في شبكة محلية جيدة، وضمن عشرات المللي ثواني عبر الإنترنت، وقد يكبر الفرق إلى مئات المللي ثواني أثناء اضطراب الشبكة. ولترتيب معاملات مالية تصل بفارق ميكروثوانٍ، هذا غير دقيق إطلاقًا.

```
NTP limitations:
- Typical accuracy: under 1ms to a few ms on a LAN, 10-100ms over the internet
- Leap second handling can cause time to repeat or go backwards
- During NTP re-sync, time may be stepped forward or backward
- Virtualisation adds extra uncertainty (VM pauses, live migration)
- Quartz oscillator drift: tens of microseconds per second (seconds per day)
  without correction

Impact on financial systems:
- Two transactions a few ms apart on different nodes have no reliable wall-clock order
- A backward clock step can produce negative transaction durations in logs
- The 2012 leap second caused well-known outages (Linux kernel livelocks)
```

الدقة النموذجية أقل من مللي ثانية إلى بضع مللي ثوانٍ في الشبكة المحلية، و10-100ms عبر الإنترنت. وقد يتكرر الوقت أو يعود إلى الوراء عند الثواني الكبيسة أو عند إعادة المزامنة. وانحراف مذبذب الكوارتز عشرات الميكروثواني في الثانية (ثوانٍ في اليوم) دون تصحيح. وقد سببت الثانية الكبيسة في 2012 أعطالًا معروفة.

> [!NOTE]
> التنظيم يضع حدودًا صارمة هنا. فلائحة MiFID II ‏(RTS 25) تُلزم شركات التداول في الاتحاد الأوروبي بإبقاء ساعات العمل ضمن 100 ميكروثانية من UTC للتداول عالي التردد، وضمن مللي ثانية واحدة للتداول الخوارزمي الآخر. ولا يستطيع NTP وحده عادة تحقيق ذلك؛ فتستخدم الشركات PTP ‏(IEEE 1588) مع ساعات منضبطة بـ GPS.

---

## ساعات Lamport المنطقية

قدّمت ورقة Leslie Lamport عام 1978 فكرة بسيطة لكنها قوية: بدل استخدام ساعات الحائط، تتبّع السببية بعدّاد منطقي يضمن التقدم بطريقة تتوافق مع علاقة "حدث قبل" (happened-before).

### علاقة "حدث قبل"

```
Happened-Before (denoted →):
  - If event a and event b occur in the same process, and a occurs before b, then a → b
  - If event a is the sending of a message, and event b is the receipt of that message, then a → b
  - If a → b and b → c, then a → c (transitivity)
  - If neither a → b nor b → a, then a and b are concurrent
```

إذا وقع الحدثان a وb في العملية نفسها وa أولًا، فإن a → b. وإذا كان a إرسال رسالة وb استلامها، فإن a → b. والعلاقة متعدية. وإذا لم يتحقق a → b ولا b → a، فالحدثان متزامنان.

### خوارزمية ساعة Lamport

```java
// Lamport Logical Clock implementation
public class LamportClock {

    private final AtomicLong counter = new AtomicLong(0);
    private final String nodeId;

    public LamportClock(String nodeId) {
        this.nodeId = nodeId;
    }

    /**
     * Rule 1: Increment the counter before each local event.
     */
    public long tick() {
        return counter.incrementAndGet();
    }

    /**
     * Rule 2: When sending a message, include the current timestamp.
     */
    public LamportTimestamp send() {
        return new LamportTimestamp(nodeId, counter.incrementAndGet());
    }

    /**
     * Rule 3: When receiving a message, set the clock to
     * max(local, received) + 1
     */
    public long receive(long receivedTimestamp) {
        return counter.updateAndGet(current ->
            Math.max(current, receivedTimestamp) + 1
        );
    }

    public long current() {
        return counter.get();
    }
}

public record LamportTimestamp(String nodeId, long logicalTime)
        implements Comparable<LamportTimestamp> {
    /**
     * Total ordering: compare by logical time, break ties by node ID.
     * This gives a consistent total order across all nodes.
     */
    @Override
    public int compareTo(LamportTimestamp other) {
        int timeComparison = Long.compare(this.logicalTime, other.logicalTime);
        return timeComparison != 0
            ? timeComparison
            : this.nodeId.compareTo(other.nodeId);
    }
}
```

القواعد الثلاث: زِد العدّاد قبل كل حدث محلي؛ وأرسل الطابع الحالي مع كل رسالة؛ وعند الاستلام اضبط الساعة على max(المحلي، المستلم) + 1. وللحصول على ترتيب كلي، تُكسر حالات التعادل بمعرّف العقدة.

### ساعات Lamport في ترتيب المدفوعات

```java
@Service
public class PaymentOrderingService {

    private final LamportClock clock;
    private final PaymentRepository paymentRepo;
    private final EventPublisher eventBus;

    /**
     * Submit a payment with a Lamport timestamp for ordering.
     * Even if two nodes submit payments "simultaneously", the
     * Lamport timestamp provides a consistent total order.
     */
    public PaymentSubmissionResult submitPayment(PaymentRequest request) {
        // Get a Lamport timestamp for this event
        LamportTimestamp timestamp = clock.send();

        Payment payment = Payment.builder()
            .paymentId(request.paymentId())
            .amount(request.amount())
            .currency(request.currency())
            .lamportTimestamp(timestamp.logicalTime())
            .submittingNodeId(timestamp.nodeId())
            .build();

        payment = paymentRepo.save(payment);

        // Publish with Lamport timestamp in the message header
        PaymentSubmittedEvent event = new PaymentSubmittedEvent(
            payment, timestamp
        );
        eventBus.publish(event);

        return new PaymentSubmissionResult(payment.paymentId(), timestamp);
    }

    /**
     * When receiving a payment event from another node,
     * update our Lamport clock.
     */
    public void handleIncomingPaymentEvent(PaymentSubmittedEvent event) {
        // Update clock: max(local, received) + 1
        long updatedClock = clock.receive(event.lamportTimestamp());

        // Now process the event knowing our clock is consistent
        processPaymentEvent(event, updatedClock);
    }
}
```

### حدود ساعات Lamport

تضمن ساعات Lamport أنه إذا كان `a → b` فإن `clock(a) < clock(b)`. لكن العكس غير صحيح: `clock(a) < clock(b)` لا يعني `a → b`. فقد يكون لحدثين متزامنين أي ترتيب لطوابع Lamport. لذلك تعطي ساعة Lamport ترتيبًا كليًا لا يناقض السببية أبدًا، لكنها لا تستطيع أن تخبرك هل كان حدثان مرتبطين سببيًا أم متزامنين — وهذا يحتاج الساعات المتجهة.

---

## الساعات المتجهة

تحل الساعات المتجهة قصور ساعات Lamport بتتبع السببية بدقة. فكل عقدة تحتفظ بمتجه من العدّادات — عدّاد لكل عقدة في النظام.

### خوارزمية الساعة المتجهة

```java
public class VectorClock {

    private final String nodeId;
    private final Map<String, Long> clock;

    public VectorClock(String nodeId, Set<String> allNodes) {
        this.nodeId     = nodeId;
        this.clock      = new HashMap<>();
        allNodes.forEach(node -> clock.put(node, 0L));
    }

    /**
     * Increment this node's component before a local event or send.
     */
    public synchronized Map<String, Long> tick() {
        clock.merge(nodeId, 1L, Long::sum);
        return Collections.unmodifiableMap(new HashMap<>(clock));
    }

    /**
     * Merge incoming vector clock (component-wise max) and increment local.
     */
    public synchronized Map<String, Long> receive(Map<String, Long> incoming) {
        incoming.forEach((node, ts) ->
            clock.merge(node, ts, Math::max)
        );
        clock.merge(nodeId, 1L, Long::sum);
        return Collections.unmodifiableMap(new HashMap<>(clock));
    }

    /**
     * a happened-before b: a.clock[i] <= b.clock[i] for all i,
     * and a.clock[j] < b.clock[j] for at least one j.
     */
    public static boolean happensBefore(Map<String, Long> a,
                                         Map<String, Long> b) {
        Set<String> allNodes = new HashSet<>();
        allNodes.addAll(a.keySet());
        allNodes.addAll(b.keySet());

        boolean strictlyLessForSome = false;
        for (String node : allNodes) {
            long aTs = a.getOrDefault(node, 0L);
            long bTs = b.getOrDefault(node, 0L);
            if (aTs > bTs) return false;         // a[i] > b[i] -> not before
            if (aTs < bTs) strictlyLessForSome = true;
        }
        return strictlyLessForSome;
    }

    /**
     * a concurrent with b: neither a→b nor b→a
     */
    public static boolean areConcurrent(Map<String, Long> a,
                                         Map<String, Long> b) {
        return !happensBefore(a, b) && !happensBefore(b, a);
    }
}
```

يسبق a الحدث b عندما يكون كل مدخل في a أصغر من المدخل المقابل في b أو يساويه، ويكون مدخل واحد على الأقل أصغر تمامًا. وإذا لم يسبق أي منهما الآخر فهما متزامنان.

### الساعات المتجهة لاكتشاف التعارض

```java
@Service
public class DistributedAccountUpdateService {

    private final VectorClock vectorClock;
    private final AccountRepository accountRepo;
    private final ConflictResolutionRepository conflictResolutionRepo;

    /**
     * Multi-master update of account CONTACT details (never balances).
     * The client sends the vector clock of the version it read (readClock).
     * If the stored version has changes the client never saw, the two
     * updates are concurrent: a conflict.
     */
    public UpdateResult updateAccountDetails(String accountId,
                                              AccountUpdateRequest update) {
        Account existing = accountRepo.findById(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));

        Map<String, Long> stored = existing.vectorClock() != null
            ? existing.vectorClock() : Map.of();
        Map<String, Long> seen   = update.readClock();

        boolean clientSawLatest = stored.equals(seen)
            || VectorClock.happensBefore(stored, seen);

        if (!clientSawLatest) {
            // Concurrent update: record it for audit before resolving
            log.warn("Concurrent update conflict for account {}: stored={}, seen={}",
                     accountId, stored, seen);
            conflictResolutionRepo.save(ConflictResolution.builder()
                .accountId(accountId)
                .existingVersion(stored)
                .incomingVersion(seen)
                .strategy(ConflictResolutionStrategy.LAST_WRITER_WINS)
                .resolvedAt(Instant.now())
                .build());
            // Contact details: last-writer-wins is acceptable.
            // Financial-critical data: reject and require manual resolution.
        }

        // The new version dominates both histories: merge, then tick
        Map<String, Long> newClock = vectorClock.receive(stored);

        Account updated = existing.toBuilder()
            .address(update.address())
            .emailAddress(update.emailAddress())
            .vectorClock(newClock)
            .lastUpdated(Instant.now())
            .build();

        return UpdateResult.success(accountRepo.save(updated));
    }
}
```

يرسل العميل الساعة المتجهة للنسخة التي قرأها. فإذا احتوت النسخة المخزنة على تغييرات لم يرها العميل، فالتحديثان متزامنان: تعارض. ويُسجَّل التعارض للتدقيق، ثم يُطبق "آخر كاتب يفوز" لبيانات الاتصال فقط. وتُدمج الساعتان ثم تُزاد الساعة المحلية، فتسيطر النسخة الجديدة على التاريخين. أما البيانات المالية الحرجة مثل الأرصدة فلا تُستخدم معها قاعدة "آخر كاتب يفوز" أبدًا.

---

## الساعات المنطقية الهجينة (HLC)

تجمع الساعات المنطقية الهجينة بين الساعات الفيزيائية (ساعات الحائط) والساعات المنطقية. ومثل ساعة Lamport، تضمن HLC أنه إذا كان a → b فإن hlc(a) < hlc(b)؛ لكن على خلاف ساعة Lamport، تبقى قيمتها قريبة من الوقت الفيزيائي، فتكون مقروءة ومفيدة لتصحيح الأخطاء. ولا تكتشف التزامن — فهذا ما زال يحتاج الساعات المتجهة. وتستخدم CockroachDB وYugabyteDB ساعات HLC.

```java
/**
 * Hybrid Logical Clock (HLC) — provides:
 * - Physical time component: for human readability and approximate ordering
 * - Logical counter: keeps the order consistent with causality within the same millisecond
 *
 * Based on Kulkarni et al., "Logical Physical Clocks and Consistent Snapshots"
 */
public class HybridLogicalClock {

    private volatile long physicalMs = 0L;   // physical time component (ms since epoch)
    private volatile long counter    = 0L;   // logical counter within same millisecond
    private final    Object lock     = new Object();

    /**
     * Generate a new HLC timestamp for a local event or send.
     */
    public HlcTimestamp now() {
        synchronized (lock) {
            long wallMs = System.currentTimeMillis();

            if (wallMs > physicalMs) {
                physicalMs = wallMs;
                counter    = 0L;
            } else {
                // Physical clock hasn't advanced (or went backwards)
                counter++;
            }

            return new HlcTimestamp(physicalMs, counter);
        }
    }

    /**
     * Receive a remote HLC timestamp and update local clock.
     */
    public HlcTimestamp receive(HlcTimestamp remote) {
        synchronized (lock) {
            long wallMs = System.currentTimeMillis();

            long newPhysical = Math.max(wallMs, Math.max(physicalMs, remote.physicalMs()));
            long newCounter;

            if (newPhysical == physicalMs && newPhysical == remote.physicalMs()) {
                newCounter = Math.max(counter, remote.counter()) + 1;
            } else if (newPhysical == physicalMs) {
                newCounter = counter + 1;
            } else if (newPhysical == remote.physicalMs()) {
                newCounter = remote.counter() + 1;
            } else {
                newCounter = 0L;
            }

            physicalMs = newPhysical;
            counter    = newCounter;

            return new HlcTimestamp(physicalMs, counter);
        }
    }
}

public record HlcTimestamp(long physicalMs, long counter)
        implements Comparable<HlcTimestamp> {

    /**
     * Convert to a sortable string representation.
     * This can be used as a database column value that is both
     * human-readable (approximate time visible) and causally ordered.
     */
    public String toSortableString() {
        return "%016x-%016x".formatted(physicalMs, counter);
    }

    public Instant toInstantApproximation() {
        return Instant.ofEpochMilli(physicalMs);
    }

    @Override
    public int compareTo(HlcTimestamp other) {
        int physicalComparison = Long.compare(this.physicalMs, other.physicalMs);
        return physicalComparison != 0
            ? physicalComparison
            : Long.compare(this.counter, other.counter);
    }
}
```

### HLC في دفتر أستاذ مدفوعات موزع

```java
@Entity
@Table(name = "ledger_entries")
public class LedgerEntry {

    @Id
    private UUID id;

    @Column(name = "account_id", nullable = false)
    private String accountId;

    @Column(name = "amount", nullable = false, precision = 20, scale = 4)
    private BigDecimal amount;

    // Store HLC as two columns for precise causality ordering
    @Column(name = "hlc_physical_ms", nullable = false)
    private long hlcPhysicalMs;

    @Column(name = "hlc_counter", nullable = false)
    private long hlcCounter;

    // Wall-clock timestamp for human readability (may not be ordered)
    @Column(name = "wall_clock_at", nullable = false)
    private Instant wallClockAt;
}
```

```sql
-- Query ledger entries in causal order using HLC
-- Even if wall_clock_at has skew, hlc ordering is correct

SELECT
    account_id,
    amount,
    entry_type,
    -- Approximate wall-clock time from HLC physical component
    to_timestamp(hlc_physical_ms / 1000.0) AS approximate_time,
    hlc_physical_ms,
    hlc_counter,
    -- Running balance requires causal ordering
    SUM(amount) OVER (
        PARTITION BY account_id
        ORDER BY hlc_physical_ms, hlc_counter
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_balance
FROM ledger_entries
WHERE account_id = 'ACC-001'
ORDER BY hlc_physical_ms, hlc_counter;
```

تُخزن HLC في عمودين (المكوّن الفيزيائي والعدّاد)، ويُرتب بهما. فحتى لو كان في `wall_clock_at` انحراف، يبقى ترتيب HLC متسقًا مع السببية.

---

## Google TrueTime ‏(Spanner)

تستخدم قاعدة بيانات Spanner من Google أسلوبًا مبتكرًا: بدل ادعاء معرفة الوقت الحالي بدقة، تكشف TrueTime **فترة عدم اليقين** حول الوقت الحالي. فتعيد الواجهة حدّين `[earliest, latest]` للوقت الفعلي.

```
TrueTime API:
  TT.now()   -> TTInterval {earliest, latest}
              where actual_time ∈ [earliest, latest]
              typical uncertainty: 1-7ms
  TT.after(t) -> true if actual_time > t (definitely after t)
  TT.before(t) -> true if actual_time < t (definitely before t)
```

### انتظار الالتزام: ضمان الاتساق الخارجي في Spanner

```
Spanner Commit Protocol:

1. Transaction T1 acquires locks and prepares to commit
2. Spanner calls TT.now() -> [t_earliest, t_latest]
3. The commit timestamp is set to t_latest (the latest possible time)
4. WAIT until TT.after(t_latest) is true
   (i.e., until the CURRENT real time is definitely past t_latest)
5. Only then release locks and return to client

Effect: Any transaction that starts AFTER T1 commits will get a
TT.now() timestamp that is definitely after T1's commit timestamp.
This provides external consistency: the global order of commits matches
the real-time order in which they were observed.

Cost: the wait is about the width of the uncertainty interval (2 x epsilon),
a few ms; Spanner overlaps it with Paxos replication to hide most of it
```

تأخذ المعاملة أقفالها، ثم يُضبط طابع الالتزام على الحد الأعلى `latest`، ثم **تنتظر** حتى يصبح الوقت الحقيقي بالتأكيد بعد ذلك الطابع، وبعدها فقط تُحرر الأقفال ويُرد على العميل. فأي معاملة تبدأ بعد الالتزام تحصل على طابع بعده بالتأكيد. ومدة الانتظار تقارب عرض فترة عدم اليقين (2 × epsilon)، أي بضع مللي ثوانٍ، وتُخفي Spanner معظمها بتداخلها مع نسخ Paxos.

لهذا تستطيع Spanner تقديم اتساق قوي عالمي: بانتظار انقضاء عدم يقين الساعة قبل إظهار الالتزام، تضمن أن طابع الالتزام صار في الماضي بلا لبس عندما تبدأ أي معاملة لاحقة.

```java
// Illustrative TrueTime-style API — not actual Spanner API
// Shows the concept of commit wait for external consistency

public class TrueTimeCommitService {

    private final TrueTimeClock truetime;

    public CommitResult commitTransaction(Transaction transaction) {
        // Acquire all necessary locks
        lockManager.acquireLocks(transaction.affectedKeys());

        try {
            // Get current time interval
            TimeInterval now = truetime.now();

            // Use the latest bound as the commit timestamp
            Instant commitTimestamp = now.latest();

            // Execute the write
            storage.write(transaction, commitTimestamp);

            // COMMIT WAIT: do not release locks until real time
            // has passed the commit timestamp
            while (!truetime.after(commitTimestamp)) {
                Thread.sleep(1);  // spin wait (Spanner uses more sophisticated mechanism)
            }

            // Now it is safe to release locks and return to client
            lockManager.releaseLocks(transaction.affectedKeys());

            return CommitResult.success(commitTimestamp);

        } catch (Exception ex) {
            lockManager.releaseLocks(transaction.affectedKeys());
            throw ex;
        }
    }
}
```

---

## أثر انحراف الساعات على ترتيب المعاملات المالية

```java
@Service
public class TransactionOrderingAnalysisService {

    /**
     * Find causal inversions: pairs where event a causally happened before b
     * (by vector clock) but a's wall-clock timestamp is LATER than b's.
     * Every inversion proves the clocks were skewed by at least the gap.
     * O(n^2): run it on a sample, not on the full day.
     */
    public OrderingAnalysisReport analyseOrderingRisk(List<Transaction> transactions) {
        List<OrderingConflict> inversions = new ArrayList<>();
        Duration maxObservedSkew = Duration.ZERO;

        for (Transaction a : transactions) {
            for (Transaction b : transactions) {
                if (a == b) continue;
                boolean causallyBefore =
                    VectorClock.happensBefore(a.vectorClock(), b.vectorClock());
                if (causallyBefore && a.wallClockAt().isAfter(b.wallClockAt())) {
                    Duration gap = Duration.between(b.wallClockAt(), a.wallClockAt());
                    inversions.add(new OrderingConflict(a.transactionId(), b.transactionId(), gap));
                    if (gap.compareTo(maxObservedSkew) > 0) maxObservedSkew = gap;
                }
            }
        }

        return new OrderingAnalysisReport(
            transactions.size(),
            inversions.size(),
            maxObservedSkew,   // a lower bound on the real clock skew
            inversions.isEmpty()
                ? "No causal inversions in this sample"
                : "Wall-clock order contradicts causality %d times (skew >= %s)"
                    .formatted(inversions.size(), maxObservedSkew)
        );
    }
}
```

تبحث الخدمة عن الانعكاسات السببية: أزواج يسبق فيها الحدث a الحدث b سببيًا (حسب الساعة المتجهة) لكن طابع ساعة الحائط لـ a أحدث من طابع b. وكل انعكاس يُثبت أن الساعات كانت منحرفة بمقدار الفجوة على الأقل. والخوارزمية من الرتبة O(n²)، فشغّلها على عينة لا على اليوم كاملًا.

---

## توصيات عملية للأنظمة المالية

### أي ساعة تستخدم، ومتى

```
Clock Selection Guide:

Requirement                                 Recommended Approach
───────────────────────────────────────────────────────────────────
Display timestamps to users                 Wall clock (Instant/OffsetDateTime)
                                            Stored in UTC, displayed in customer TZ

Idempotency key expiry                      Wall clock + sufficient TTL buffer
                                            (add 5x expected clock skew as buffer)

Event ordering within single node           Local sequence counter (wall clock can
                                            step backwards; nanoTime only for durations)

Event ordering across multiple nodes        Lamport clock or HLC

Causality tracking across nodes             Vector clock (Lamport/HLC give an order
                                            consistent with causality, not detection)

Settlement sequencing (must be            Sequence number from single coordinator
  unambiguous)                              (not a clock at all)

Audit trail timestamps                      Wall clock for human readability +
                                            Lamport/HLC for causal ordering

Distributed coordination timeout            Wall clock with generous drift buffer
                                            (timeout = desired_timeout + 2 * max_skew)
```

- **عرض الطوابع للمستخدمين**: ساعة الحائط، مخزنة بتوقيت UTC وتُعرض بمنطقة العميل الزمنية.
- **الترتيب داخل عقدة واحدة**: عدّاد تسلسلي محلي (ساعة الحائط قد تعود إلى الوراء؛ وnanoTime للمدد فقط).
- **الترتيب عبر عدة عقد**: ساعة Lamport أو HLC.
- **تتبع السببية عبر العقد**: الساعة المتجهة.
- **تسلسل التسوية**: رقم تسلسلي من منسّق واحد — وليس ساعة أصلًا.
- **مهل التنسيق الموزع**: ساعة الحائط مع هامش انحراف سخي.

---

## أخطاء شائعة

**1. استخدام `System.currentTimeMillis()` لترتيب المعاملات**
لا يوجد ترتيب محدد لمعاملتين بالطابع نفسه بالمللي ثانية. وتحت إنتاجية عالية، قد تتشارك آلاف المعاملات الطابع نفسه، فيصبح ترتيب ساعة الحائط بلا معنى.

**2. الثقة في NTP دون قياس الانحراف**
تقارب NTP ليس لحظيًا. فبعد انقسام شبكة أو إعادة تشغيل خادم، قد يحتاج NTP دقائق ليتقارب، وقد تنحرف الساعة كثيرًا خلالها. راقب فرق NTP كمقياس لصحة الخدمة.

**3. تخزين الطوابع الزمنية كنصوص**
الطوابع المخزنة كنصوص (مثل "2024-01-15 10:00:00") تُرتب أبجديًا، وهذا صحيح إذا كانت الصيغة ثابتة — لكن المناطق الزمنية، والتوقيت الصيفي، واختلاف الصيغ بين الخدمات تسبب أخطاء ترتيب دقيقة. خزّنها دائمًا كـ `TIMESTAMPTZ` في PostgreSQL أو كمللي ثوانٍ منذ epoch في عمود رقمي.

**4. عودة الساعة إلى الوراء في الحاويات**
قد تتعرض الأجهزة الافتراضية والحاويات لقفزات في الساعة، خاصة بعد الترحيل الحي. استخدم `System.nanoTime()` لقياس المدة المنقضية (رتيب)، لا `System.currentTimeMillis()` (قد يقفز). ولا تقارن أبدًا قيم `nanoTime()` بين عمليات JVM مختلفة.

**5. تجاهل انحراف الساعات في انتهاء الإيجارات والأقفال**
الأقفال الموزعة التي تنتهي بعد N ثانية تعتمد على اتفاق كل العقد على انقضاء N ثانية. ومع انحراف 50ms ومدة قفل ثانية واحدة، قد يكون القفل "منتهيًا" على عقدة و"صالحًا" على أخرى. أضف هامش أمان لا يقل عن ضعف أقصى انحراف متوقع لكل الإيجارات الزمنية.

---

## نصائح للإنتاج

**استخدم NTP بمصادر متعددة وراقب الفرق**
في مراكز البيانات الخاصة، اضبط الخوادم على 4 مصادر NTP على الأقل من مزودين مختلفين. وفي AWS/GCP/Azure استخدم خدمة الوقت لدى المزود (مثل Amazon Time Sync Service)، فهي عادة أدق مصدر للأجهزة الافتراضية. وفي الحالتين راقب فرق الساعة (مثل مخرجات tracking في chrony أو `node_timex_offset_seconds` في node_exporter) وأطلق تنبيهًا إذا تجاوز 10ms.

**أضف تسلسلًا منطقيًا لكل حدث في Kafka**
حتى مع ساعات متزامنة جيدًا، تعطي إزاحات أقسام Kafka ترتيبًا مثاليًا داخل القسم. استخدم إزاحة Kafka كرقم تسلسلي نهائي للأحداث داخل قسم الحساب، وأكملها بـ HLC للترتيب بين الأقسام.

**تحقق من انحراف الساعات في اختبارات التكامل**
أضف اختبارًا يشغّل خدمتين بساعتين منحرفتين عمدًا (استخدم `java.time.Clock.fixed()` بإزاحات مختلفة) ويتحقق من أن منطق الترتيب لديك يعطي نتائج صحيحة رغم الانحراف. فهذا يكشف افتراضات الترتيب قبل أن تسبب حوادث إنتاج.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تصل الدفعة P2 إلى العقدة B في الوقت الحقيقي 09:59:59.990، وساعة العقدة B متقدمة 15ms، فتختم P2 بـ 10:00:00.005. وتصل الدفعة P1 إلى العقدة A (ساعتها دقيقة) بعد 10ms وتُختم بـ 10:00:00.000. ما الخطأ الذي يحدث إذا رتّب النظام المدفوعات بهذه الطوابع؟",
      "options": [
        "لا شيء — انحراف 15ms ضمن تسامح NTP، فيبقى الترتيب صحيحًا.",
        "تعكس الطوابع الترتيب الحقيقي: تأتي P1 قبل P2 رغم أن P2 وصلت أولًا، فقد يعمل فحص الرصيد أو تسلسل التسوية على الدفعة الخطأ أولًا.",
        "ترفض قاعدة البيانات إحدى الدفعتين لأن طابعين لا يمكن أن يكونا ضمن 15ms من بعضهما.",
        "يعيّن بروتوكول ISO 8583 تلقائيًا أرقامًا تسلسلية تتجاوز ترتيب ساعة الحائط."
      ],
      "correct": 1,
      "explanation": "انحراف العقدة B البالغ 15ms أكبر من الفجوة الحقيقية البالغة 10ms بين الدفعتين، فتضع الطوابع P1 أولًا رغم أن P2 وصلت أولًا فعلًا. فطوابع ساعات الحائط من عقد مختلفة لا تستطيع ترتيب أحداث أقرب إلى بعضها من مقدار الانحراف. استخدم مُرتِّبًا واحدًا، أو ساعة منطقية، أو HLC للترتيب، واحتفظ بساعة الحائط للعرض."
    },
    {
      "text": "ما القصور الحاسم في ساعات Lamport الذي يجعلها غير كافية للاتساق السببي في نظام دفع موزع؟",
      "options": [
        "قد يفيض عدّاد ساعات Lamport عند وقوع أكثر من 2^63 حدثًا، فتتصادم الطوابع.",
        "إذا كان clock(a) < clock(b) فهذا لا يعني أن الحدث a سبق الحدث b سببيًا — فقد يكون لأحداث متزامنة أي ترتيب لطوابع Lamport.",
        "تتطلب ساعات Lamport منسّقًا مركزيًا لتعيين الطوابع، فلا تناسب الأنظمة الموزعة بلا عقدة واحدة.",
        "لا تعمل ساعات Lamport بشكل صحيح إلا إذا كانت ساعات الحائط في كل العقد متزامنة تمامًا، وهذا يُلغي فائدة الساعة المنطقية."
      ],
      "correct": 1,
      "explanation": "تضمن ساعات Lamport أنه إذا كان a → b (حدث a قبل b) فإن clock(a) < clock(b). لكن العكس غير صحيح: clock(a) < clock(b) لا يعني a → b. فقد يكون لحدثين متزامنين غير مرتبطين سببيًا أي ترتيب لطوابع Lamport. ولاكتشاف العلاقات السببية (والتزامن) تحتاج الساعات المتجهة؛ أما HLC فمثل ساعات Lamport تعطي فقط ترتيبًا متسقًا مع السببية."
    },
    {
      "text": "تستخدم Google Spanner ساعة TrueTime و'انتظار الالتزام' لتقديم اتساق خارجي. ما الغرض من خطوة انتظار الالتزام؟",
      "options": [
        "السماح للعقد الأخرى بنسخ المعاملة قبل ظهورها، لضمان تزامن كل النسخ قبل أن يتلقى العميل ردًا.",
        "الانتظار حتى يتجاوز الوقت الحقيقي بالتأكيد طابع التزام المعاملة، فتحصل أي معاملة لاحقة على فترة TrueTime مضمون أنها بعد طابع الالتزام.",
        "أخذ أقفال موزعة من كل الأجزاء المشاركة قبل إطلاق نتائج المعاملة للعميل.",
        "السماح بتفريغ سجل الكتابة المسبقة إلى القرص في كل النسخ قبل اعتبار المعاملة دائمة."
      ],
      "correct": 1,
      "explanation": "يضمن انتظار الالتزام الاتساق الخارجي: تضبط Spanner طابع الالتزام على أحدث وقت حالي ممكن (الحد الأعلى في TrueTime)، ثم تنتظر حتى يتجاوز الوقت الحقيقي ذلك الطابع بالتأكيد. فأي معاملة لاحقة تحصل على فترة TrueTime تبدأ بعد طابع الالتزام، فيطابق الترتيب العام لطوابع الالتزام الترتيب الزمني الحقيقي للالتزامات — دون خدمة طوابع مركزية."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ ترتيب الساعات الموزعة لدفتر أستاذ مدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "نفّذ صنف LamportClock بالطرق tick() وsend() وreceive(long receivedTimestamp). ونفّذ سجل LamportTimestamp بطريقة compareTo تكسر التعادل بمعرّف العقدة للحصول على ترتيب كلي. واكتب PaymentOrderingService تختم كل إرسال دفعة بطابع Lamport وتنشره إلى Kafka مع الطابع في ترويسة الرسالة. واكتب اختبار وحدة بعقدتين محاكاتين يُظهر أن الدفعات المرسلة 'في الوقت نفسه' تحصل على ترتيب كلي متسق عبر طوابع Lamport."},
    {"id": "2", "description": "نفّذ صنف VectorClock بالطرق tick() وreceive(Map<String, Long> incoming) والطريقتين الساكنتين happensBefore(Map a, Map b) وareConcurrent(Map a, Map b). واكتب DistributedAccountUpdateService يحمل فيها كل تحديث الساعة المتجهة للنسخة التي قرأها العميل؛ اكتشف التحديثات المتزامنة لبيانات اتصال الحساب، وطبّق 'آخر كاتب يفوز'، وسجّل كل تعارض في جدول تدقيق conflict_resolutions. واكتب اختبارات تغطي التحديثات المتتابعة (بلا تعارض)، والتحديثات المتزامنة (اكتشاف التعارض)، والتحديثات المرتبة سببيًا."},
    {"id": "3", "description": "نفّذ HybridLogicalClock بالطريقتين now() وreceive(HlcTimestamp remote). وخزّن طوابع HLC في كيان JPA باسم LedgerEntry كعمودين (hlc_physical_ms وhlc_counter). واكتب استعلام SQL يحسب رصيدًا تراكميًا لحساب مرتبًا بـ HLC بدل ساعة الحائط، وبيّن باختبار أن قيدين في دفتر الأستاذ بالمللي ثانية نفسها في ساعة الحائط ما زالا مرتبين بشكل صحيح بمكوّن العدّاد في HLC."},
    {"id": "4", "description": "اكتب TransactionOrderingAnalysisService تأخذ عينة من المعاملات تحمل طوابع ساعة الحائط والساعات المتجهة معًا، وتجد الانعكاسات السببية: أزواج يسبق فيها a الحدث b حسب الساعة المتجهة لكن طابع ساعة الحائط لـ a أحدث. واكتب اختبارًا بخمس معاملات عبر عقدتين محاكاتين بانحراف ساعة 20ms، وتحقق من الانعكاسات ومن الحد الأدنى للانحراف المرصود. وأضف مهمة @Scheduled تحلل عينة من معاملات الدقيقة الأخيرة وتنشر عدد الانعكاسات وأقصى انحراف مرصود كمقاييس gauge في Micrometer."}
  ]
}
-->
