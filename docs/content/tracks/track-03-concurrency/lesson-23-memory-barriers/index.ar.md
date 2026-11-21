---
id: track-03-lesson-23
sequence: 23
title: "حواجز الذاكرة وإعادة ترتيب التعليمات"
slug: memory-barriers
track: track-03
difficulty: principal
estimatedMinutes: 70
status: published
tags: [memory-barriers, instruction-reordering, acquire-release, JMM-internals]
java-versions: [17, 21]
---

# حواجز الذاكرة (Memory Barriers) — الأساس العتادي للتزامن

## نظرة عامة

حواجز الذاكرة هي الآلية العتادية التي تقوم عليها كل أدوات التزامن عالية المستوى في Java. فـ `volatile` و`synchronized` و`VarHandle` تُصدر كلها في النهاية تعليمات حواجز ذاكرة. والمهندسون الرئيسيون الذين يفهمون الحواجز يستطيعون الاستدلال على ضمانات JMM دون حفظ القواعد — فيشتقون السلوك الصحيح من المبادئ الأولى، ويصممون بنى بيانات خالية من الأقفال، ويفسرون مخرجات التفكيك (disassembly) من محللات الأداء.

## أهداف التعلم

في نهاية هذا الدرس ستستطيع:

- شرح ما إعادة ترتيب التعليمات ولماذا تفعلها المعالجات ومترجمات JIT
- وصف أنواع حواجز الذاكرة الأربعة (LoadLoad، وLoadStore، وStoreLoad، وStoreStore)
- ربط عمليات التزامن في Java بالحواجز التي تُصدرها
- تفسير دلالات الاكتساب-التحرير (acquire-release) بلغة الحواجز
- استخدام `VarHandle` بأنماط حواجز صريحة لتحكم دقيق
- شرح لماذا تكون قراءات `volatile` أرخص من كتاباتها على x86

## سياق العمل

تعالج منصة تداول عالي التردد تحديثات بيانات السوق بمعدل مليوني حدث في الثانية. ويفكر الفريق في استبدال تغذية أسعار مبنية على `volatile` بمخزن حلقي (ring buffer) مخصص خالٍ من الأقفال. وفهم حواجز الذاكرة — تحديدًا هل يحتاجون حاجز `StoreLoad` كاملًا أم حاجز `StoreStore` فقط — يحدد هل تصميم المخزن الحلقي صحيح على x86 مقابل ARM، وهل يستحق التحسين تعقيده.

## لماذا تُعاد ترتيب التعليمات

تعيد المعالجات الحديثة ومترجمات JIT ترتيب التعليمات من أجل الأداء. ولإعادة الترتيب ثلاثة مصادر:

### 1. إعادة ترتيب المترجم

يعيد JIT ترتيب الشيفرة عندما يستطيع إثبات أن إعادة الترتيب غير ملحوظة داخل خيط واحد:

```
// Written as:
x = 1;
y = 2;

// May compile as:
y = 2;    // reordered — single-threaded behaviour identical
x = 1;
```

### 2. التنفيذ خارج الترتيب في المعالج

تنفّذ المعالجات الحديثة التعليمات خارج ترتيب البرنامج باستخدام مخزن إعادة الترتيب. فتذهب الكتابات إلى مخزن الكتابة (store buffer)، وقد تتجاوز القراءات مخزن الكتابة وتقرأ من الذاكرة المؤقتة:

```
// Store buffer: writes are queued, not immediately visible to other cores
Core 1: write x=1 → store buffer (not yet flushed to L3 cache)
Core 2: read x    → reads from cache → sees 0  (not yet 1)
Core 1: flush store buffer
Core 2: read x    → reads from cache → sees 1
```

### 3. إعادة الترتيب في نظام الذاكرة

قد تلاحظ الأنوية المختلفة القراءات والكتابات بترتيبات مختلفة بسبب بروتوكولات اتساق الذاكرة المؤقتة (MESI، وMOESI) ومسارات تمرير الكتابة.

## أنواع حواجز الذاكرة الأربعة

يمنع حاجز الذاكرة (fence) فئات محددة من إعادة الترتيب عبره:

| الحاجز | يمنع | الوصف |
|---------|----------|-------------|
| `LoadLoad` | إعادة ترتيب قراءة←قراءة | كل القراءات قبل الحاجز تكتمل قبل القراءات بعده |
| `LoadStore` | إعادة ترتيب قراءة←كتابة | كل القراءات قبل الحاجز تكتمل قبل الكتابات بعده |
| `StoreStore` | إعادة ترتيب كتابة←كتابة | كل الكتابات قبل الحاجز مرئية قبل الكتابات بعده |
| `StoreLoad` | إعادة ترتيب كتابة←قراءة | كل الكتابات قبل الحاجز مرئية قبل القراءات بعده (الأغلى — حاجز كامل) |

### لماذا يكون StoreLoad الأغلى

يتطلب `StoreLoad` تفريغ مخزن الكتابة — جعل كل الكتابات المصطفة مرئية — قبل أي قراءة لاحقة. وعلى x86 تُصدر HotSpot تعليمة بالبادئة lock (`lock addl $0,(rsp)`) أو تستخدم `xchg`، بكلفة عشرات الدورات أو أكثر. والحواجز الثلاثة الأخرى مجانية على x86 (فـ TSO توفر ذلك الترتيب أصلًا)، لكنها تحتاج تعليمات فعلية على ARM (ضعيف الترتيب).

```
x86 (approximate, varies by CPU):
  LoadLoad:   free (x86 TSO provides this automatically)
  LoadStore:  free
  StoreStore: free (TSO keeps ordinary stores in order)
  StoreLoad:  tens of cycles or more (lock-prefixed instruction or MFENCE)

ARMv8 (AArch64):
  Acquire load:   LDAR  — a load with acquire ordering built in
  Release store:  STLR  — a store with release ordering built in
  Full fence:     DMB ISH (data memory barrier, inner shareable)
  Java volatile read  → LDAR;  Java volatile write → STLR
  (LDAR/STLR are cheaper than a separate full DMB fence)
```

## عمليات Java والحواجز التي تُصدرها

### قراءة volatile

تُصدر قراءة `volatile` حاجز `LoadLoad` + `LoadStore` بعد القراءة:

```
  load  x  (volatile)
  ──────────────────── LoadLoad + LoadStore barrier
  load  y  (normal)   │ cannot be moved above the volatile read
  store z  (normal)   │ cannot be moved above the volatile read
```

على x86 تُترجم قراءة `volatile` إلى قراءة ذاكرة عادية (بلا تعليمة حاجز) لأن TSO توفر ترتيب LoadLoad تلقائيًا.

### كتابة volatile

تُصدر كتابة `volatile` حاجز `StoreStore` + `LoadStore` قبلها و`StoreLoad` بعدها:

```
  store a  (normal)   ┐
  store b  (normal)   │ cannot be moved below the volatile write
  ──────────────────── StoreStore + LoadStore barrier
  store x  (volatile)
  ──────────────────── StoreLoad barrier
  load  y  (normal)   │ cannot be moved above the volatile write
```

على x86 تترجم HotSpot كتابة `volatile` إلى `MOV` تليها تعليمة بالبادئة lock ‏(`lock addl $0,(rsp)`) — أو `XCHG` — للحصول على حاجز `StoreLoad`.

ولهذا تكون **كتابات `volatile` أغلى من قراءاتها** — فحاجز `StoreLoad` أغلى أنواع الحواجز.

### synchronized ‏(monitorenter / monitorexit)

```
monitorenter:
  ──────────────────── acquire barrier (LoadLoad + LoadStore)
  ... critical section ...
monitorexit:
  ──────────────────── release barrier (LoadStore + StoreStore)
```

الحصول على القفل = حاجز اكتساب: لا تُنقل القراءات والكتابات في القسم الحرج إلى ما قبل الحصول على القفل.

تحرير القفل = حاجز تحرير: لا تُنقل القراءات والكتابات في القسم الحرج إلى ما بعد تحرير القفل. وهذا مصدر علاقة تحدث-قبل في `synchronized`.

## دلالات الاكتساب-التحرير

الاكتساب-التحرير ترتيب ذاكرة أضعف من الاتساق التتابعي (`volatile`)، لكنه كافٍ لأنماط كثيرة:

**دلالة الاكتساب (قراءة):** لا تُنقل أي قراءة أو كتابة بعد هذه القراءة إلى ما قبلها. وهذا ما يوفره `synchronized(lock)` عند الدخول — فالحصول على القفل له دلالة اكتساب.

**دلالة التحرير (كتابة):** لا تُنقل أي قراءة أو كتابة قبل هذه الكتابة إلى ما بعدها. وهذا ما يوفره `synchronized(lock)` عند الخروج — فتحرير القفل له دلالة تحرير.

```
Thread 1 (producer)              Thread 2 (consumer)
────────────────────             ──────────────────
data.value = 42;                 if (ready.get()) {       // acquire read
ready.set(true);  // release         use(data.value);     // guaranteed to see 42
                                 }
```

إذا كان `ready` من نوع `volatile`، فللكتابة فيه دلالة تحرير وللقراءة منه دلالة اكتساب. وتضمن علاقة تحدث-قبل رؤية `data.value = 42` في الخيط 2.

## VarHandle: تحكم صريح في الحواجز

يعرض `VarHandle` ‏(Java 9+) أنماط الحواجز صراحة، فيسمح بتحكم أدق من `volatile`:

```java
import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;

public class PriceFeed {

    private long bidPrice;   // Not volatile — controlled via VarHandle
    private long askPrice;

    private static final VarHandle BID;
    private static final VarHandle ASK;

    static {
        try {
            MethodHandles.Lookup lookup = MethodHandles.lookup();
            BID = lookup.findVarHandle(PriceFeed.class, "bidPrice", long.class);
            ASK = lookup.findVarHandle(PriceFeed.class, "askPrice", long.class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    // Producer: publish with release semantics
    // (earlier loads and stores cannot move below this store)
    // NOTE: each field is ordered separately — a reader can still see the new
    // bid with the old ask. For a consistent pair, publish one immutable
    // snapshot object instead (see the Practical Challenge)
    public void updatePrices(long bid, long ask) {
        BID.setRelease(this, bid);  // LoadStore + StoreStore before this store
        ASK.setRelease(this, ask);  // LoadStore + StoreStore before this store
    }

    // Consumer: read with acquire semantics
    // (later loads and stores cannot move above this load)
    public long getBid() {
        return (long) BID.getAcquire(this);  // LoadLoad + LoadStore after this load
    }

    public long getAsk() {
        return (long) ASK.getAcquire(this);  // LoadLoad + LoadStore after this load
    }

    // For CAS operations on price — full volatile semantics
    public boolean compareAndSetBid(long expected, long newBid) {
        return BID.compareAndSet(this, expected, newBid);
    }
}
```

لاحظ أن كل حقل يُرتّب منفصلًا — فقد يرى القارئ سعر الشراء الجديد مع سعر البيع القديم. وللحصول على زوج متسق، انشر كائن لقطة واحدًا غير قابل للتغيير بدلًا من ذلك (راجع التحدي العملي).

### مرجع أنماط الوصول في VarHandle

| النمط | الحاجز | المكافئ في Java | الكلفة |
|------|---------|----------------|------|
| `get()` | لا شيء (حتى `long`/`double` غير مضمونة الذرية) | قراءة عادية | الأرخص |
| `getOpaque()` | ذري ومتسق لهذا المتغير؛ بلا ترتيب مع غيره | - | منخفضة |
| `getAcquire()` | اكتساب (LoadLoad + LoadStore بعده) | - | منخفضة (مجانية على x86) |
| `set()` | لا شيء | كتابة عادية | الأرخص |
| `setOpaque()` | ذري ومتسق لهذا المتغير؛ بلا ترتيب مع غيره | - | منخفضة |
| `setRelease()` | تحرير (LoadStore + StoreStore قبله) | ‏`lazySet()` في أصناف Atomic | منخفضة (مجانية على x86) |
| `getVolatile()` / `setVolatile()` | كامل (الأربعة) | قراءة/كتابة `volatile` | الأغلى |
| `compareAndSet()` | كامل | ‏`AtomicXxx.compareAndSet()` | مكلفة |

## مخزن حلقي خالٍ من الأقفال: تحليل الحواجز

هذا نوع البنى الذي تؤتي فيه معرفة الحواجز ثمارها. فالمخزن الحلقي بمنتج واحد ومستهلك واحد (SPSC) يمكن تنفيذه بـ `setRelease` / `getAcquire` فقط — دون حاجز `StoreLoad` كامل:

```java
public class SpscRingBuffer<T> {

    private final Object[] buffer;
    private final int      mask;

    // These two are the only shared mutable state
    private long writeIndex = 0;
    private long readIndex  = 0;

    private static final VarHandle WRITE_INDEX;
    private static final VarHandle READ_INDEX;
    private static final VarHandle BUFFER_ELEMENT;

    static {
        try {
            MethodHandles.Lookup lookup = MethodHandles.lookup();
            WRITE_INDEX    = lookup.findVarHandle(SpscRingBuffer.class, "writeIndex", long.class);
            READ_INDEX     = lookup.findVarHandle(SpscRingBuffer.class, "readIndex",  long.class);
            BUFFER_ELEMENT = MethodHandles.arrayElementVarHandle(Object[].class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public SpscRingBuffer(int capacity) {
        if (capacity < 2) throw new IllegalArgumentException("capacity must be >= 2");
        int size = Integer.highestOneBit(capacity - 1) << 1;  // next power of 2
        buffer   = new Object[size];
        mask     = size - 1;
    }

    // Producer thread only
    public boolean offer(T item) {
        long wi = (long) WRITE_INDEX.get(this);              // plain read (producer only)
        long ri = (long) READ_INDEX.getAcquire(this);        // acquire: see consumer's progress
        if (wi - ri >= buffer.length) return false;          // full

        BUFFER_ELEMENT.setRelease(buffer, (int)(wi & mask), item);  // release: publish item
        WRITE_INDEX.setRelease(this, wi + 1);                       // release: advance index

        return true;
    }

    // Consumer thread only
    @SuppressWarnings("unchecked")
    public T poll() {
        long ri = (long) READ_INDEX.get(this);               // plain read (consumer only)
        long wi = (long) WRITE_INDEX.getAcquire(this);       // acquire: see producer's index
        if (ri == wi) return null;                            // empty

        T item = (T) BUFFER_ELEMENT.getAcquire(buffer, (int)(ri & mask));  // acquire: see item
        BUFFER_ELEMENT.set(buffer, (int)(ri & mask), null);  // plain: clear for GC
        READ_INDEX.setRelease(this, ri + 1);                  // release: advance index

        return item;
    }
}
```

**تحليل الحواجز:**
- يقدّم المنتج `writeIndex` بـ `setRelease` ← فلا تنتقل كتابة العنصر قبله (وحقول كائن العنصر نفسه) إلى ما بعد كتابة الفهرس
- يقرأ المستهلك `writeIndex` بـ `getAcquire` ← فلا تنتقل قراءة العنصر بعده إلى ما قبل قراءة الفهرس؛ ويرى كل ما كتبه المنتج قبل التحرير
- والاقتران نفسه بالعكس (`setRelease(readIndex)` / `getAcquire(readIndex)`) يخبر المنتج أن خانة صارت فارغة، فلا يكتب أبدًا فوق عنصر ما زال المستهلك يقرؤه
- و`setRelease`/`getAcquire` على عنصر المخزن نفسه أمان إضافي؛ فزوج الفهرس وحده يرتّب الوصول إلى العنصر

لا حاجة إلى حاجز `StoreLoad` — فاقتران الاكتساب-التحرير بين `setRelease(writeIndex)` لدى المنتج و`getAcquire(writeIndex)` لدى المستهلك ينشئ حد المزامنة. وعلى x86 يزيل هذا التعليمة ذات البادئة lock من كل كتابة، وكثيرًا ما يكون أسرع بعدة مرات من مسار كتابة `volatile` (قِس على عتادك).

> [!WARNING]
> المخازن الحلقية SPSC صحيحة **فقط** مع خيط منتج واحد بالضبط وخيط مستهلك واحد. فإذا أضفت منتجًا أو مستهلكًا ثانيًا ينهار تحليل الحواجز وتحتاج تنفيذًا كاملًا مبنيًا على CAS (مثل المخزن الحلقي متعدد المنتجين في `Disruptor`).

## x86 مقابل ARM: لماذا تهم المعمارية

```
x86 (Total Store Order):
  - Most reorderings are forbidden by hardware
  - Only StoreLoad reorder is allowed
  - volatile reads: plain MOV (no fence instruction)
  - volatile writes: expensive (lock-prefixed instruction or XCHG)
  - Bugs from missing barriers rarely surface on x86 (but the JIT can still reorder)

ARM (Weakly Ordered):
  - Most reorderings are permitted by hardware
  - Ordering must be requested explicitly
  - volatile reads: LDAR (load-acquire)
  - volatile writes: STLR (store-release)
  - Bugs from missing barriers surface much more often on ARM
```

لهذا قد تفشل الشيفرة التي "تعمل" دون حواجز صحيحة على أجهزة تطوير x86 في نسخ إنتاج ARM ‏(AWS Graviton، وApple M-series). وقد صُمم JMM ليكون محافظًا — فإذا اتبعت قواعد JMM تكون شيفرتك صحيحة على كل المعماريات. فلا تعتمد أبدًا على الترتيب الأقوى في x86.

## اختبار المعرفة

**س1:** لديك حقلا `volatile` يُحدَّثان معًا:
```java
volatile long timestamp;
volatile long price;

void update(long ts, long p) {
    timestamp = ts;
    price = p;
}
```
هل يستطيع خيط قارئ رؤية `price` الجديد مع `timestamp` القديم؟

**ج:** نعم. فكل كتابة `volatile` تنشئ علاقة تحدث-قبل خاصة بها، لكن الكتابتين ليستا ذريتين كوحدة. فقد يرى القارئ `price = p` (الجديد) ثم يقرأ `timestamp` ويجد القيمة القديمة إذا قرأ بين الكتابتين. ولتحديث الاثنين ذريًا استخدم `synchronized`، أو خزّنهما في سجل واحد غير قابل للتغيير يُنشر عبر تبديل مرجع `volatile` واحد.

**س2:** ‏`VarHandle.setRelease()` أرخص من `setVolatile()`. متى يكون استخدام `setRelease()` بدل `setVolatile()` آمنًا؟

**ج:** يكون `setRelease()` آمنًا عندما لا تحتاج إلا هذا الضمان: كل ما كُتب قبل هذه الكتابة سيكون مرئيًا لأي خيط يقرأ هذا الموقع بـ `getAcquire()` أو أقوى. ولا تحصل على حاجز `StoreLoad` اللاحق (الجزء المكلف في `setVolatile()`). وهذا مناسب لتسليم البيانات من المنتج إلى المستهلك (مخزن حلقي SPSC: انشر عنصرًا ثم قدّم مؤشرًا). لكنه **غير** كافٍ عندما يجب ألا تنتقل **قراءات الخيط الكاتب نفسه اللاحقة** إلى ما قبل هذه الكتابة — والحالة الكلاسيكية الاستبعاد المتبادل على نمط Dekker: "عيّن علَمي، ثم اقرأ علَمك". فمع التحرير/الاكتساب وحدهما قد يقرأ كل خيط القيمة القديمة لعلَم الآخر فيدخل الاثنان.

## التحدي العملي

صمّم ذاكرة أسعار مؤقتة عالية الأداء لنظام تداول تنشر أسعار الشراء/البيع/الأخير إلى 500 خيط مستهلك. المتطلبات:

1. **مسار الكتابة:** خيط بيانات سوق واحد يحدّث الأسعار نحو 100,000 مرة في الثانية. قلّل زمن الكتابة — استخدم أدنى قوة حاجز لازمة للصحة
2. **مسار القراءة:** ‏500 خيط مستهلك تقرأ الأسعار مع كل نبضة سوق — قلّل زمن القراءة
3. **الاتساق:** يجب أن يرى القراء إما الثلاثية القديمة كاملة (شراء، بيع، أخير) أو الثلاثية الجديدة كاملة — لا مزيجًا أبدًا
4. **صحة JMM:** يجب أن تكون الشيفرة صحيحة على ARM، لا على x86 فقط

**تلميح:** فكّر في استخدام مرجع `volatile` إلى لقطة أسعار غير قابلة للتغيير (record) بدل ثلاثة حقول `volatile` منفصلة. وحلّل عدد الحواجز المُصدرة مقابل أسلوب الحقول الثلاثة واشرح أيهما أقل في مسار التحديث.

قدّم التنفيذ مع تعليق صريح على الحاجز الذي يُصدره كل نمط وصول في `VarHandle` ولماذا يكفي.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا تكون كتابات volatile أغلى من قراءاتها على عتاد x86؟",
      "options": [
        "قراءات volatile تتطلب حاجز StoreLoad كاملًا بينما كتاباتها لا تتطلبه",
        "كتابات volatile تُصدر حاجز StoreLoad (أغلى حاجز، يتطلب تفريغ مخزن الكتابة) بينما قراءاتها تتطلب حاجز LoadLoad+LoadStore فقط وهو مجاني على x86 TSO",
        "قراءات volatile تتطلب تعليمة قفل بينما كتاباتها لا تتطلبها",
        "لهما الكلفة نفسها على x86 لأن TSO توفر كل الترتيب تلقائيًا"
      ],
      "correct": 1,
      "explanation": "على x86 ‏(TSO) يوفر العتاد ترتيب LoadLoad وLoadStore، فتُترجم قراءة volatile إلى MOV عادية بلا حاجز. أما كتابة volatile فتحتاج حاجز StoreLoad — تستخدم HotSpot تعليمة بالبادئة lock (أو XCHG) — يفرّغ مخزن الكتابة وهو أغلى أنواع الحواجز. فالقراءات شبه مجانية بينما تكلف الكتابات أكثر بوضوح."
    },
    {
      "text": "في مخزن حلقي بمنتج واحد ومستهلك واحد، يستخدم المنتج VarHandle.setRelease() لتقديم فهرس الكتابة، ويستخدم المستهلك VarHandle.getAcquire() لقراءته. لماذا يكفي هذا الزوج للصحة دون حاجز StoreLoad كامل؟",
      "options": [
        "لا يكفي — كتابة volatile كاملة مطلوبة للصحة",
        "ينشئ زوج setRelease/getAcquire علاقة تحدث-قبل: كل الكتابات قبل setRelease مرئية لأي خيط يستدعي getAcquire لاحقًا على المتغير نفسه",
        "يكفي على x86 فقط لا على ARM",
        "يقرأ getAcquire تلقائيًا من الذاكرة الرئيسية متجاوزًا كل الذاكرات المؤقتة"
      ],
      "correct": 1,
      "explanation": "ينشئ زوج الاكتساب-التحرير علاقة تحدث-قبل: كل ما كتبه المنتج قبل setRelease مرئي للمستهلك بعد getAcquire. وحاجز StoreLoad الذي يضيفه setVolatile لا يلزم إلا عندما يجب ألا تنتقل قراءات الخيط اللاحقة إلى ما قبل كتابته (نمط Dekker: 'عيّن علَمي، ثم اقرأ علَمك'). وتسليم SPSC لا يحتاج ذلك، فـ setRelease/getAcquire صحيح وأرخص من setVolatile — على ARM كما على x86."
    },
    {
      "text": "شيفرة بلا مزامنة 'تعمل' على أجهزة تطوير x86 لأشهر لكنها تفشل على AWS Graviton ‏(ARM) في الإنتاج. ما السبب الجذري؟",
      "options": [
        "معالجات ARM أبطأ ترددًا من x86، فتكشف أخطاء التوقيت",
        "توفر TSO في x86 ترتيب ذاكرة أقوى مما يتطلبه JMM، فتخفي سباقات بيانات يكشفها نموذج ذاكرة ARM الأضعف",
        "يستخدم AWS Graviton إصدار JVM مختلفًا بسلوك مختلف",
        "لمعالجات ARM ذاكرات مؤقتة أصغر، فتكثر الإخفاقات وتنكشف حالات التسابق"
      ],
      "correct": 1,
      "explanation": "تستخدم x86 ترتيب الكتابة الكلي (TSO)، الذي يوفر معظم ترتيب الذاكرة تلقائيًا فيخفي كثيرًا من انتهاكات JMM. أما ARM فضعيف الترتيب: قد تُعاد ترتيب القراءات والكتابات ما لم تطلب الشيفرة الترتيب (LDAR/STLR، وDMB). فقد تبدو الشيفرة ذات سباقات البيانات صحيحة على x86 لكنها تفشل على ARM. وJMM هو العقد — يجب أن تكون الشيفرة صحيحة وفق JMM، لا وفق عتاد x86."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "ذاكرة أسعار مؤقتة خالية من الأقفال مع تحليل حواجز VarHandle",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {
      "id": "1",
      "description": "صمّم سجل PriceSnapshot غير قابل للتغيير (bid وask وlast كحقول long بالسنتات) وصنف PriceCache يحمل مرجع PriceSnapshot واحدًا. استخدم VarHandle مع setRelease() للكاتب (خيط بيانات سوق واحد ينشر نحو 100,000 تحديث في الثانية) وgetAcquire() للقراء (500 خيط مستهلك). ولا تستخدم volatile على الحقل. ووثّق بالضبط الحواجز التي يُصدرها كل نمط وصول ولماذا تكفي."
    },
    {
      "id": "2",
      "description": "أثبت صحة التصميم: اشرح لماذا يرى القراء إما PriceSnapshot القديمة كاملة أو الجديدة كاملة، ولا يرون أبدًا ثلاثية أسعار محدّثة جزئيًا. وقارن عدد الحواجز التي يُصدرها هذا الأسلوب (setRelease واحد لتبديل المرجع) مقابل بديل الحقول volatile الثلاثة المنفصلة (ثلاثة استدعاءات setVolatile كل منها مع حاجز StoreLoad)."
    },
    {
      "id": "3",
      "description": "نفّذ SpscRingBuffer<T> (منتج واحد ومستهلك واحد) باستخدام VarHandle مع setRelease/getAcquire لإدارة الفهارس ولوصول عناصر المخزن. واكتب تعليقات صريحة على كل استدعاء VarHandle تشرح أي إعادات الترتيب يمنعها. وضمّن إثبات صحة: لماذا ينشئ اقتران setRelease(writeIndex) لدى المنتج مع getAcquire(writeIndex) لدى المستهلك علاقة تحدث-قبل اللازمة لرؤية العنصر؟"
    },
    {
      "id": "4",
      "description": "اكتب اختبار أداء JMH يقارن ثلاثة تنفيذات لـ PriceCache: ‏(1) حقول عادية بلا مزامنة (خط أساس سريع لكنه خاطئ)، (2) حقول volatile لكل قيمة سعر، (3) VarHandle مع setRelease/getAcquire على مرجع واحد إلى PriceSnapshot غير قابلة للتغيير. وقِس إنتاجية القراءة بخيط واحد وإنتاجية القراءة المتزامنة بـ 500 خيط. واشرح نتائج الاختبار بلغة الحواجز المُصدرة وكلفة تفريغ مخزن الكتابة."
    }
  ]
}
-->
