---
id: "track-07-lesson-03"
title: "ضبط GC — G1GC وZGC للخدمات المالية منخفضة الكمون"
track: "track-07"
track-name: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 3
slug: "gc-tuning"
difficulty: "advanced"
estimated-minutes: 85
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-07-lesson-01", "track-07-lesson-02"]

tags:
  - "GC-tuning"
  - "G1GC"
  - "ZGC"
  - "heap-sizing"
  - "latency"

java-versions: [17, 21]

topics:
  - "G1GC Architecture and Region Model"
  - "G1GC Tuning Flags"
  - "ZGC Sub-millisecond Pauses"
  - "Heap Sizing for Payment Services"
  - "GC Ergonomics"
  - "Humongous Object Handling"
  - "GC Log Analysis"
  - "ZGC vs G1GC Tradeoffs"

components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "OpenJDK G1GC Tuning Guide — openjdk.org"
  - "ZGC — A Scalable Low-Latency Garbage Collector — Per Liden (2018)"
  - "JVM Performance Engineering — Monica Beckwith"
  - "Java Performance — Scott Oaks (2nd ed.)"
---

## نظرة عامة

توقفات جمع القمامة من أخبث مصادر الزمن في أنظمة الدفع المبنية على Java. فتوقف stop-the-world لمدة 200 مللي ثانية أثناء ذروة التسوية ليس فضولًا تقنيًا في JVM — بل انقطاع يراه العميل، وخرق محتمل للـ SLA، وفي بعض الولايات القضائية حدث يستوجب الإبلاغ الرقابي. لذلك ففهم جامع القمامة وضبطه كفاءة أساسية لأي مهندس يشغّل بنية مالية عالية الإنتاجية على JVM.

يفكك هذا الدرس الجامعَين المهيمنَين على نشرات التقنية المالية في الإنتاج: **G1GC** (الافتراضي منذ Java 9) و**ZGC** (جاهز للإنتاج منذ Java 15؛ وتوليدي منذ Java 21، وتوليدي فقط منذ Java 24). ستفهم آلياتهما الداخلية، وتتعلم أي الخيارات تُحدث فرقًا فعلًا، وتحجّم الـ heap بشكل صحيح لأشكال أحمال الدفع، وتشخّص مشكلات GC من السجلات قبل أن تصبح حوادث.

> [!NOTE]
> أكثر قرارات ضبط GC أثرًا هو عادة حجم الـ heap ومعدل تخصيص الكائنات — لا العبث بخيارات الجامع. وصّف التخصيص أولًا، واضبط الخيارات ثانيًا.

## أهداف التعلم

بنهاية هذا الدرس ستكون قادرًا على:

- شرح نموذج المناطق في G1GC وكيف يقود أهداف زمن التوقف
- تطبيق خيارات G1GC الحرجة مع التبرير
- ضبط ZGC لتوقفات أقل من مللي ثانية في خدمات الدفع
- تحجيم heap الـ JVM بشكل صحيح بحسب إنتاجية المعاملات وأعمار الكائنات
- تحديد مشكلات الكائنات الضخمة وإصلاحها
- قراءة سجلات GC للتمييز بين المشكلات البسيطة وأنماط ما قبل الفشل
- الاختيار بين G1GC وZGC لحمل مالي معين

## 1. لماذا تؤذي توقفات GC المالية أكثر من المجالات الأخرى

لنأخذ مسار تفويض بطاقة حددت فيه مؤسستك ميزانية زمن داخلية قدرها 150 مللي ثانية من الطرف إلى الطرف (مهل الشبكات أطول، لكن الـ SLO الخاص بك هو ما يشعر به العملاء). تستهلك جولات الشبكة وTLS نحو 60 مللي ثانية. وتأخذ جولة قاعدة البيانات نحو 20 مللي ثانية أخرى. والـ 70 مللي ثانية المتبقية هي كامل ميزانية شيفرة Java لديك — إلغاء التسلسل، وفحص الاحتيال، ومنطق العمل، والتسلسل.

يمكن لتوقف Full GC واحد في G1GC على خدمة بـ heap حجمه 4 غيغابايت وضبط سيئ أن يستهلك 500 مللي ثانية بسهولة. وحتى توقف Mixed GC بالإعدادات الافتراضية قد يبلغ 50–80 مللي ثانية. والحساب لا يرحم.

```
Payment authorisation SLA: 150 ms end-to-end
Network + TLS:              60 ms
Database round trip:        20 ms
Available for Java service: 70 ms
Default G1GC mixed pause:   50–80 ms  <-- catastrophic overlap
```

ثلاثة سيناريوهات تسبب فيها توقفات GC ضررًا ماليًا مباشرًا:

1. **التفويض الفوري** — يخرق التوقف مهلة استجابة المُصدر؛ فتُرفض المعاملة
2. **معالجة بيانات السوق** — أسعار قديمة خلال نافذة التوقف تسبب تنفيذات فائتة أو سيئة
3. **نوافذ دفعات التسوية** — أوقات قطع ثابتة؛ والتباطؤ الناتج عن GC يهدد بتفويت الموعد

## 2. بنية G1GC — نموذج المناطق

يقسم G1GC الـ heap إلى **مناطق** متساوية الحجم (1–32 ميغابايت، ودائمًا قوة للعدد 2). وعلى خلاف الجامعات السابقة، لا يوجد حد ثابت بين الجيل الشاب والقديم في فضاء العناوين. بل تُوسم المناطق ديناميكيًا:

```
Heap (8 GB, 512 regions of 16 MB each)
+---------+---------+---------+---------+
|  Eden   |  Eden   |  Surv   |  Old    |
|  Eden   |  Old    |  Old    |  Eden   |
|  Surv   |  Old    |  Free   |  Humong |
+---------+---------+---------+---------+
E = Eden   S = Survivor   O = Old   H = Humongous   F = Free
```

**الفكرة الأساسية**: يجمع G1 المناطق ذات أكثر قمامة أولًا ("Garbage First"). ويُخلي توقف Mixed GC كل المناطق الشابة بالإضافة إلى N منطقة قديمة ذات أعلى كثافة قمامة، مستهدفًا `-XX:MaxGCPauseMillis`.

### 2.1 دورة جمع G1GC

```
Young GC (stop-the-world)
  -> Eden regions evacuated to Survivor or promoted to Old
  -> Triggered when Eden fills

Concurrent Marking (mostly concurrent)
  -> Concurrent Start (piggybacks on a Young GC -- STW;
     called "Initial Mark" before JDK 9 logs)
  -> Root Region Scan (concurrent)
  -> Concurrent Mark (concurrent)
  -> Remark (STW, short)
  -> Cleanup (STW for accounting, concurrent for reclamation)

Mixed GC (stop-the-world)
  -> Evacuates remaining young + selected old regions
  -> Spread over up to G1MixedGCCountTarget collections (default: 8)

Full GC (stop-the-world -- treat every one in production as an incident)
  -> Compacts the whole heap (parallel since JDK 10, but still long)
  -> Triggered when G1 cannot evacuate live objects or find free regions
```

## 3. خيارات ضبط G1GC الحرجة

### 3.1 ‏MaxGCPauseMillis — هدف التوقف

```bash
-XX:MaxGCPauseMillis=50
```

هذا **هدف مرن**، لا حد صارم. يحاول G1 البقاء تحته بتقييد عدد المناطق التي يجمعها في كل توقف. وتجاوزه لا يسبب خطأ — بل يطلق إعادة تحجيم تكيفية.

لخدمات الدفع:
- **خدمات التفويض**: 20–50 مللي ثانية (يجب البقاء أقل بوضوح من SLA الاستجابة)
- **خدمات دفعات التسوية**: 100–200 مللي ثانية (الإنتاجية أهم من الزمن)
- **مستهلكو بيانات السوق**: 10–20 مللي ثانية (أو استخدم ZGC بدلًا من ذلك)

لا تضبطه تحت 10 مللي ثانية مع G1GC — فتحت هذه العتبة لا يستطيع G1 جمع قمامة كافية في كل توقف لمواكبة التخصيص، فيسبب فشل الترقية وFull GC.

### 3.2 ‏G1HeapRegionSize — التحكم في دقة المناطق

```bash
-XX:G1HeapRegionSize=16m
```

يتحكم حجم المنطقة في أمرين مهمين:
1. **عتبة الكائنات الضخمة** — الكائنات التي تبلغ 50% من المنطقة أو أكثر "ضخمة" وتحصل على مناطق مخصصة خارج Eden
2. **دقة Mixed GC** — المناطق الأصغر تتيح جمعًا تدريجيًا أدق

**معادلة التحجيم:**

```
Default region size = heap_size / 2048, rounded to a power of two
(between 1 MB and 32 MB unless set explicitly)

Examples:
  4 GB heap  -> 2 MB  regions (2048 regions)
  8 GB heap  -> 4 MB  regions (2048 regions)
  16 GB heap -> 8 MB  regions (2048 regions)
  32 GB heap -> 16 MB regions (2048 regions)
```

إذا كنت تخزّن كائنات كبيرة مخبأة (مثل جدول توجيه مدفوعات محمّل في الذاكرة)، فقد ترغب في زيادة حجم المنطقة لتجنب التخصيص الضخم لتلك الكائنات.

### 3.3 ‏InitiatingHeapOccupancyPercent — مُطلق الوسم المتزامن

```bash
-XX:InitiatingHeapOccupancyPercent=35
```

يتحكم هذا في متى يبدأ الوسم المتزامن. فعندما يتجاوز الجيل القديم هذه النسبة من الـ heap الكلي، يبدأ G1 دورة الوسم المتزامن.

- **مرتفع جدًا** (> 60%): لا وقت كافٍ لإتمام الوسم المتزامن قبل أن يملأ التخصيص الـ heap — فشل ترقية — Full GC
- **منخفض جدًا** (< 20%): يعمل الوسم المتزامن كثيرًا جدًا، مهدرًا دورات المعالج على بيانات حية في معظمها

لخدمات الدفع ذات التخصيص المتقطع (مثل المعالجة الدفعية التي تملأ الجيل القديم بسرعة):

```bash
-XX:InitiatingHeapOccupancyPercent=25
```

يعطي IHOP الأدنى لـ G1 مساحة أكبر لإتمام الوسم قبل امتلاء الـ heap.

ملاحظة: منذ JDK 9 يستخدم G1 **IHOP تكيفيًا** افتراضيًا (`-XX:+G1UseAdaptiveIHOP`) — فالقيمة التي تضبطها مجرد نقطة بداية، ثم يتعلم G1 عتبة أفضل من أزمنة الوسم ومعدلات التخصيص المرصودة. ولا تخفضها إلا حين تُظهر سجلات GC أن الوسم ينتهي متأخرًا مرارًا ("to-space exhausted" أو Full GC).

### 3.4 ‏G1NewSizePercent وG1MaxNewSizePercent

```bash
-XX:+UnlockExperimentalVMOptions   # both flags below are EXPERIMENTAL
-XX:G1NewSizePercent=20
-XX:G1MaxNewSizePercent=40
```

يتحكمان في الحد الأدنى والأقصى لحجم الجيل الشاب كنسبة من الـ heap (الافتراضي: 5% و60%). وخدمات الدفع ذات معدلات الكائنات قصيرة العمر العالية (كائنات الطلب/الاستجابة) قد تستفيد من حد أدنى أكبر للجيل الشاب، فتقل الترقية إلى الجيل القديم. واستخدمهما بحذر: فـ G1 يعيد تحجيم الجيل الشاب لتحقيق هدف التوقف، وتضييق نطاقه يسلبه هذه الأداة. ولا تضبط أبدًا `-Xmn`/`NewSize` مع G1 — فهذا يعطّل تحجيم الجيل الشاب الموجّه بزمن التوقف.

### 3.5 ‏ParallelGCThreads وConcGCThreads

```bash
-XX:ParallelGCThreads=8      # STW parallel threads (default: = CPUs up to 8, then 8 + 5/8 of the rest)
-XX:ConcGCThreads=2          # Concurrent marking threads
```

القيمة الافتراضية لـ `ConcGCThreads` نحو `ParallelGCThreads / 4`. وتقرأ أجهزة JVM الحديثة حد المعالج في الحاوية؛ فإن كانت منصتك تخفيه (أو تستخدم حصص المعالج فقط)، فاضبط `-XX:ActiveProcessorCount` أو عددي الخيوط صراحة.

**تحجيم الـ heap الواعي بالحاويات** (Java 10+، أساسي لنشرات Kubernetes):

```bash
-XX:+UseContainerSupport          # Enabled by default in Java 10+ (and 8u191+)
-XX:MaxRAMPercentage=75.0         # Use 75% of container memory as heap
-XX:InitialRAMPercentage=50.0     # Start at 50%
```

## 4. إعداد G1GC كامل لخدمات الدفع

```java
/**
 * JVM flags for a payment authorisation service.
 *
 * Service profile:
 *   - Target: < 50 ms GC pauses (P99)
 *   - Heap:   8 GB on 16 GB container
 *   - Load:   5,000 TPS, primarily short-lived objects (auth requests)
 *   - Spikes: batch settlement runs at 23:00 creating larger long-lived objects
 *
 * Full JVM flag set (append to java command or JAVA_OPTS):
 *
 * -Xms8g -Xmx8g
 * -XX:+UseG1GC
 * -XX:MaxGCPauseMillis=50
 * -XX:G1HeapRegionSize=8m
 * -XX:InitiatingHeapOccupancyPercent=30
 * -XX:+UnlockExperimentalVMOptions
 * -XX:G1NewSizePercent=20
 * -XX:G1MaxNewSizePercent=40
 * -XX:G1MixedGCCountTarget=8
 * -XX:G1MixedGCLiveThresholdPercent=85
 * -XX:G1HeapWastePercent=5
 * -XX:ParallelGCThreads=8
 * -XX:ConcGCThreads=2
 * -XX:+ParallelRefProcEnabled
 * -XX:+UseStringDeduplication
 * -XX:+ExplicitGCInvokesConcurrent
 * -Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m
 */
public final class PaymentServiceJvmConfig {
    private PaymentServiceJvmConfig() {}

    public static final String GC_LOG_FLAG =
        "-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m";

    public static final String HEAP_FLAGS = "-Xms8g -Xmx8g";
}
```

### 4.1 لماذا يساوي ‎-Xms‎ قيمة ‎-Xmx

ضبط الـ heap الابتدائي مساويًا للأقصى يمنع JVM من تكبير الـ heap وتصغيره وقت التشغيل. فإعادة التحجيم تعني حجز الذاكرة وتحريرها مع نظام التشغيل، والتكبير يحدث تمامًا حين يرتفع الحمل — أسوأ لحظة لزمن إضافي. ولخدمات الدفع الحساسة للزمن، خصّص الـ heap كاملًا عند البدء.

## 5. ‏ZGC — توقفات أقل من مللي ثانية

ZGC جامع متزامن قائم على المناطق مصمم لخاصيتين:
- **أزمنة توقف أقل من مللي ثانية** (عادة < 1 مللي ثانية، بغض النظر عن حجم الـ heap)
- **ثبات زمن التوقف مع الحجم** — heap بحجم 10 غيغابايت أو 10 تيرابايت له أزمنة توقف متقاربة

يحقق ZGC ذلك عبر **الحواجز (barriers)** — قطع صغيرة من شيفرة الآلة يُدرجها JIT عند تحميل مراجع الـ heap (وعند تخزينها في ZGC التوليدي). وهي تتيح لـ ZGC نقل الكائنات بالتزامن دون إيقاف خيوط التطبيق. والكلفة بعض الإنتاجية والمعالج مقارنة بـ G1GC؛ ومقدارها يعتمد على الحمل، فقِسه.

### 5.1 مراحل ZGC ‏(ZGC التوليدي، Java 21+)

```
Young Collection (concurrent + tiny STW):
  Young Mark Start     (STW < 1 ms)
  Young Mark           (concurrent)
  Young Mark End       (STW < 1 ms)
  Young Relocate Start (STW < 1 ms)
  Young Relocate       (concurrent)

Old Collection (concurrent + tiny STW):
  Old Mark Start       (STW < 1 ms)
  Old Mark             (concurrent)
  Old Mark End         (STW < 1 ms)
  Old Relocate Start   (STW < 1 ms)
  Old Relocate         (concurrent)
```

النموذج التوليدي (Java 21+) يقلل كثيرًا حمل المعالج والذاكرة مقارنة بـ ZGC القديم غير التوليدي. وأصبح الوضع الافتراضي لـ ZGC في Java 23، وأزيل الوضع غير التوليدي في Java 24.

### 5.2 إعداد ZGC

```bash
# Generational ZGC (recommended)
-XX:+UseZGC
-XX:+ZGenerational   # needed on Java 21-22 only; default on 23, obsolete on 24+

# Heap: larger is generally better for ZGC
# ZGC needs headroom for concurrent relocation
-Xms16g -Xmx16g

# ZGC auto-tunes most parameters, but you can hint:
-XX:ZCollectionInterval=0      # 0 = only collect when needed (default)
-XX:ZFragmentationLimit=25     # max fragmentation before compaction (%)
-XX:SoftMaxHeapSize=12g        # soft limit, leaves 4 GB for relocation buffer

# GC logging
-Xlog:gc*:file=/var/log/app/gc-zgc.log:time,uptime:filecount=5,filesize=100m
```

### 5.3 إرشادات تحجيم heap في ZGC

يحتاج ZGC هامشًا أكبر من G1GC لأنه ينقل الكائنات بالتزامن أثناء عمل التطبيق. وأثناء النقل، قد تكون النسختان القديمة والجديدة لكائن ما حيتين في الوقت نفسه.

```
ZGC heap sizing starting point (verify with load tests):
  heap = max_live_data * 3 to 4

Examples:
  Max live data: 2 GB  ->  heap: 8 GB  (minimum)
  Max live data: 4 GB  ->  heap: 16 GB
  Max live data: 8 GB  ->  heap: 32 GB
```

إذا أظهرت سجلات ZGC **توقفات تخصيص (allocation stalls)** (خيوط التطبيق تنتظر الذاكرة)، فمعدل التخصيص يسبق الجمع المتزامن. فزِد حجم الـ heap، أو أعطِ ZGC مزيدًا من المعالج، أو قلّل معدل التخصيص. وتظهر هذه التوقفات كقفزات زمن قبل أي `OutOfMemoryError` بوقت طويل.

## 6. الكائنات الضخمة — القاتل الصامت في G1GC

يكون الكائن "ضخمًا" في G1GC إذا بلغ **50% على الأقل من حجم المنطقة**. والكائنات الضخمة:
- تُخصص في مناطق مخصصة متجاورة خارج Eden (تُحسب ضمن الجيل القديم)
- لا تنقلها الجمعات العادية أبدًا — فقد تجزّئ الـ heap
- تُستعاد في الجمع الشاب فقط إذا كانت مصفوفات بدائية لا يشير إليها أحد ("الاستعادة المبكرة")؛ وإلا فبعد دورة وسم متزامن فقط

مصدر شائع للكائنات الضخمة في خدمات الدفع:

```java
// PaymentBatchProcessor.java

public class PaymentBatchProcessor {

    // PROBLEM: allocating large byte arrays in hot path
    public void processSettlementFile(InputStream settlementData) throws IOException {
        // This creates a humongous object if file > region_size/2
        // With 8 MB regions, any array > 4 MB is humongous
        byte[] fileBuffer = new byte[8 * 1024 * 1024]; // 8 MB -- HUMONGOUS

        int bytesRead = settlementData.read(fileBuffer);
        processBuffer(fileBuffer, bytesRead);
    }

    // SOLUTION: stream processing avoids large intermediary allocations
    public void processSettlementFileStreaming(InputStream settlementData) throws IOException {
        // 64 KB buffer -- well within any reasonable region size
        byte[] buffer = new byte[64 * 1024];
        int bytesRead;
        PaymentRecordParser parser = new PaymentRecordParser();

        while ((bytesRead = settlementData.read(buffer)) != -1) {
            parser.feed(buffer, 0, bytesRead);
            while (parser.hasRecord()) {
                PaymentRecord record = parser.nextRecord();
                processRecord(record);
            }
        }
    }

    private void processBuffer(byte[] buffer, int length) { /* ... */ }
    private void processRecord(PaymentRecord record) { /* ... */ }
}
```

### 6.1 كشف التخصيصات الضخمة عبر سجلات GC

```
# In GC logs -- look for:
# 1) young pauses whose CAUSE is a humongous allocation
[2026-11-08T14:23:01.234+0000][gc] GC(45) Pause Young (Concurrent Start) (G1 Humongous Allocation) 5120M->4864M(8192M) 31.204ms
# 2) humongous region counts (with -Xlog:gc+heap=info)
[2026-11-08T14:23:01.234+0000][gc,heap] GC(45) Humongous regions: 96->64
# 3) per-object detail with -Xlog:gc+humongous=debug (verbose; staging only)
```

**الكشف البرمجي باستخدام مستمع إشعارات GC** (يعدّ هذا دورات GC التي *أطلقتها* تخصيصات ضخمة — مؤشر جيد لعدد المرات التي تؤذيك فيها):

```java
// HumongousAllocationMonitor.java

import com.sun.management.GarbageCollectionNotificationInfo;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import javax.management.NotificationEmitter;

@Component
public class HumongousAllocationMonitor {

    private final Counter humongousAllocCounter;

    public HumongousAllocationMonitor(MeterRegistry meterRegistry) {
        this.humongousAllocCounter = Counter.builder("app.gc.humongous.triggered")
            .description("GC cycles triggered by humongous allocations")
            .register(meterRegistry);

        installGcListener();
    }

    private void installGcListener() {
        for (GarbageCollectorMXBean gcBean : ManagementFactory.getGarbageCollectorMXBeans()) {
            if (gcBean instanceof NotificationEmitter emitter) {
                emitter.addNotificationListener(this::handleGcNotification, null, null);
            }
        }
    }

    private void handleGcNotification(javax.management.Notification notification,
                                       Object handback) {
        if (!notification.getType().equals(
                GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION)) {
            return;
        }

        GarbageCollectionNotificationInfo info =
            GarbageCollectionNotificationInfo.from(
                (javax.management.openmbean.CompositeData) notification.getUserData());

        // G1GC uses cause "G1 Humongous Allocation" for humongous-triggered collections
        String cause = info.getGcCause();
        if ("G1 Humongous Allocation".equals(cause)) {
            humongousAllocCounter.increment();
        }
    }
}
```

### 6.2 زيادة حجم المنطقة لتجنب التخصيصات الضخمة

إذا كانت شيفرتك تحتاج فعلًا كائنات كبيرة (مثل تخزين رسائل دفع مرمّزة):

```bash
# If objects are ~10 MB, use 32 MB regions
# so objects < 16 MB are non-humongous
-XX:G1HeapRegionSize=32m
```

## 7. حمل GC وحدود الإنتاجية

مع جامع Parallel، يرمي JVM ‏`OutOfMemoryError: GC overhead limit exceeded` عندما يُقضى أكثر من **98% من الوقت في GC** ويُستعاد أقل من **2% من الـ heap** (`-XX:+UseGCOverheadLimit`). ولا تعتمد على هذا الفحص مع G1 أو ZGC — ففي معظم إصدارات JDK لا ينفذانه، فتزداد الخدمة المتعثرة بطئًا فحسب. وتضبط هذه الخيارات العتبة حيث تنطبق:

```bash
-XX:GCTimeLimit=98           # default: OOME if > 98% of time in GC ...
-XX:GCHeapFreeLimit=2        # ... and < 2% of the heap freed
```

لخدمات الدفع، نبّه قبل بلوغ هذه الحدود بكثير:

```java
// GcOverheadMonitor.java

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;

@Component
public class GcOverheadMonitor {

    private long lastGcTimeMs = totalPauseTimeMs();
    private long lastWallMs   = System.currentTimeMillis();
    private volatile double recentOverhead = 0.0;   // read by the gauge

    public GcOverheadMonitor(MeterRegistry meterRegistry) {
        // Registered ONCE; the gauge reads the latest sampled value.
        // Alert threshold: > 5% of wall time in GC pauses is a warning sign
        Gauge.builder("app.gc.overhead.recent", this, m -> m.recentOverhead)
            .description("Fraction of wall time spent in GC pauses over the last interval (0.0-1.0)")
            .register(meterRegistry);
    }

    // Measure the RECENT window: an average since JVM start hides today's problem
    @Scheduled(fixedRate = 10_000)
    void sample() {
        long gc = totalPauseTimeMs();
        long now = System.currentTimeMillis();
        long wall = now - lastWallMs;
        if (wall > 0) {
            recentOverhead = (double) (gc - lastGcTimeMs) / wall;
        }
        lastGcTimeMs = gc;
        lastWallMs = now;
    }

    private static long totalPauseTimeMs() {
        return ManagementFactory.getGarbageCollectorMXBeans().stream()
            // G1 (JDK 20+) and ZGC also expose beans that time CONCURRENT
            // work, e.g. "G1 Concurrent GC" or "ZGC Major Cycles" -- skip them
            .filter(b -> !b.getName().contains("Concurrent") && !b.getName().contains("Cycles"))
            .mapToLong(GarbageCollectorMXBean::getCollectionTime)
            .sum();
    }
}
```

## 8. تحليل سجلات GC

فعّل دائمًا تسجيل GC في الإنتاج. فالحمل صغير (عادة أقل بوضوح من 1%) والقيمة التشخيصية هائلة.

### 8.1 خيارات التسجيل (التسجيل الموحد Java 9+)

```bash
# Comprehensive logging -- recommended for production
-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m

# Minimal logging -- for extreme latency sensitivity
-Xlog:gc:file=/var/log/app/gc-min.log:time,uptime:filecount=5,filesize=20m

# Debug level -- for troubleshooting only, never in production
-Xlog:gc*=debug:file=/var/log/app/gc-debug.log:time,uptime,level,tags:filecount=3,filesize=100m
```

### 8.2 قراءة سجلات G1GC

```
# Young GC -- normal, should be fast
[2026-11-08T14:23:01.100+0000][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 2048M->1024M(8192M) 18.432ms

# Mixed GC -- expected, reclaims old gen
[2026-11-08T14:23:15.200+0000][gc] GC(43) Pause Young (Mixed) (G1 Evacuation Pause) 3072M->1536M(8192M) 32.187ms

# Concurrent Mark -- good, running in background
[2026-11-08T14:23:30.300+0000][gc] GC(44) Concurrent Mark Cycle

# ALERT: Full GC -- investigate immediately
[2026-11-08T14:23:45.400+0000][gc] GC(45) Pause Full (G1 Compaction Pause) 7680M->2048M(8192M) 4521.834ms
```

### 8.3 أداة تحليل سجلات GC

```java
// GcLogAnalyzer.java

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.DoubleSummaryStatistics;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class GcLogAnalyzer {

    private static final Pattern PAUSE_PATTERN = Pattern.compile(
        "GC\\((\\d+)\\) Pause (\\w+) .*?(\\d+\\.\\d+)ms$"
    );

    public record GcPauseEvent(int gcId, String pauseType, double durationMs) {}

    public record GcPauseStats(double avgMs, double maxMs, double p99Ms, long fullGcCount) {
        public boolean isHealthy() {
            return p99Ms < 100.0 && fullGcCount == 0;
        }
    }

    public List<GcPauseEvent> parseLog(Path logFile) throws IOException {
        List<GcPauseEvent> events = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(logFile)) {
            String line;
            while ((line = reader.readLine()) != null) {
                Matcher m = PAUSE_PATTERN.matcher(line);
                if (m.find()) {
                    events.add(new GcPauseEvent(
                        Integer.parseInt(m.group(1)),
                        m.group(2),
                        Double.parseDouble(m.group(3))
                    ));
                }
            }
        }
        return events;
    }

    public GcPauseStats computeStats(List<GcPauseEvent> events) {
        if (events.isEmpty()) {
            return new GcPauseStats(0, 0, 0, 0);
        }

        DoubleSummaryStatistics stats = events.stream()
            .mapToDouble(GcPauseEvent::durationMs)
            .summaryStatistics();

        double[] sorted = events.stream()
            .mapToDouble(GcPauseEvent::durationMs)
            .sorted()
            .toArray();

        int p99Index = Math.max(0, (int) Math.ceil(sorted.length * 0.99) - 1);
        double p99 = sorted[p99Index];

        long fullGcCount = events.stream()
            .filter(e -> "Full".equals(e.pauseType()))
            .count();

        return new GcPauseStats(stats.getAverage(), stats.getMax(), p99, fullGcCount);
    }
}
```

## 9. ‏G1GC مقابل ZGC — مصفوفة قرار للأحمال المالية

| المعيار | G1GC | ZGC ‏(توليدي، Java 21) |
|---|---|---|
| زمن التوقف P99 | 20–100 مللي ثانية (قابل للضبط) | < 1 مللي ثانية |
| حمل الإنتاجية | منخفض | أعلى قليلًا (يعتمد على الحمل) |
| الحد الأدنى للـ heap | ‏1 غيغابايت يكفي | ‏4 غيغابايت+ موصى به |
| تعقيد الإعداد | متوسط | منخفض (ضبط ذاتي) |
| حمل المعالج | منخفض | متوسط (مراحل متزامنة) |
| الأنسب لـ | الدفعات، والتسوية، والزمن المتوسط | التفويض الفوري، وبيانات السوق |
| إصدار Java | ‏Java 8+ (افتراضي منذ 9) | ‏Java 21+ لـ GenZGC (الوضع الافتراضي لـ ZGC منذ 23) |
| الكائنات الكبيرة | مناطق ضخمة — مشكلة | لا مشكلة مناطق ضخمة (الكائنات الكبيرة تحصل على صفحات خاصة) |
| الوعي بالحاويات | جيد (Java 10+) | ممتاز |

### 9.1 الاختيار الموصى به حسب نوع الخدمة

```
Payment Authorisation API (< 50 ms SLA):
  -> ZGC with GenerationalZGC on Java 21
  -> Heap: 4x max live data

Settlement Batch Service (throughput priority):
  -> G1GC with MaxGCPauseMillis=200
  -> Heap: sized to avoid Full GC

Fraud Detection (rule evaluation, medium latency):
  -> G1GC with MaxGCPauseMillis=50
  -> Tune IHOP aggressively: 25-30%

Market Data Processor (< 10 ms latency):
  -> ZGC with GenerationalZGC
  -> Heap: 3-4x max live data
```

## 10. مجموعة خيارات JVM نموذجية لمعالج دفع في الإنتاج

```bash
#!/usr/bin/env bash
# payment-service-jvm-opts.sh
# Tested on Java 21, 16 GB container, 5000 TPS payment authorisation

# ---- Heap ----
-Xms8g
-Xmx8g

# ---- GC: G1GC with low-latency tuning ----
-XX:+UseG1GC
-XX:MaxGCPauseMillis=50
-XX:G1HeapRegionSize=8m
-XX:InitiatingHeapOccupancyPercent=30   # initial value; adaptive IHOP adjusts it
-XX:+UnlockExperimentalVMOptions
-XX:G1NewSizePercent=20
-XX:G1MaxNewSizePercent=40
-XX:G1MixedGCCountTarget=8
-XX:G1MixedGCLiveThresholdPercent=85
-XX:G1HeapWastePercent=5
-XX:ParallelGCThreads=8
-XX:ConcGCThreads=2
-XX:+ParallelRefProcEnabled

# ---- String deduplication (can save heap in String-heavy services) ----
-XX:+UseStringDeduplication

# ---- Turn System.gc() into a concurrent cycle instead of a Full GC ----
# (prefer this to -XX:+DisableExplicitGC: the JDK calls System.gc() to
#  free direct buffers, and disabling it can cause direct-memory OOMEs)
-XX:+ExplicitGCInvokesConcurrent

# ---- Metaspace: cap to avoid runaway class loading ----
-XX:MetaspaceSize=256m
-XX:MaxMetaspaceSize=512m

# ---- GC Logging ----
-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m

# ---- JVM crash diagnostics ----
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/app/heap-dump.hprof
-XX:+ExitOnOutOfMemoryError

# ---- Container support ----
-XX:+UseContainerSupport      # default; shown for clarity
-XX:ActiveProcessorCount=8

# ---- Alternative: ZGC for stricter latency requirements ----
# Replace the GC section above with:
# -XX:+UseZGC
# -XX:+ZGenerational          # Java 21-22 only
# -Xms16g -Xmx16g
# -XX:SoftMaxHeapSize=12g
```

## 11. قائمة فحص الإنتاج

قبل نشر خدمة جديدة أو بعد حادث GC، تحقق من:

- [ ] الـ heap محجّم بـ 2–4 أضعاف أقصى بيانات حية (لا بذروة الإنتاجية فقط)
- [ ] ‏`-Xms` يساوي `-Xmx` (يمنع قفزات زمن إعادة تحجيم الـ heap)
- [ ] تسجيل GC مفعّل مع تدوير الملفات
- [ ] ‏`HeapDumpOnOutOfMemoryError` و`ExitOnOutOfMemoryError` مضبوطان
- [ ] ‏`ExplicitGCInvokesConcurrent` مضبوط (كي لا يسبب `System.gc()` من المكتبات Full GC)
- [ ] ‏`JvmGcMetrics` من Micrometer مسجّل (يُسجّل تلقائيًا مع Spring Boot Actuator)
- [ ] تنبيه على: P99 لتوقف GC > 100 مللي ثانية، وعدد Full GC > 0، واستخدام الـ heap > 85%
- [ ] حجم المنطقة مُتحقق منه مقابل أقصى حجم كائن (تجنب التخصيصات الضخمة)
- [ ] ‏`UseContainerSupport` مضبوط لنشرات Kubernetes
- [ ] سجل GC مُدوَّر ومُرسل إلى مجمّع السجلات (ELK، وSplunk، وDatadog)

## اختبار المعرفة

1. ما الفرق بين `-XX:MaxGCPauseMillis` وحد توقف صارم؟ وماذا يحدث عندما يتجاوز G1GC الهدف؟

2. heap بحجم 8 غيغابايت بمناطق 8 ميغابايت يشهد تخصيصات ضخمة متكررة لمصفوفات بايت بحجم 5 ميغابايت. ما طريقتان لإصلاح ذلك؟

3. لماذا يحتاج ZGC هامش heap أكبر من G1GC؟

4. يُظهر سجل GC لخدمة دفع توقفات Full GC كل 30 دقيقة مدتها ثانيتان. الـ heap حجمه 4 غيغابايت وIHOP على الافتراضي (45%). ما تغيير الخيار الذي ستجربه أولًا؟

5. حاوية تشغّل خدمة دفع مخصص لها 8 غيغابايت. وJVM مضبوط على `-Xmx6g`. ما الخيار الإضافي الذي يجب أن تتحقق من وجوده لضمان احترام JVM لحدود ذاكرة الحاوية؟

## التحدي العملي

**الإعداد:** تعالج خدمة تفويض دفع 3,000 معاملة في الثانية. الـ heap حجمه 4 غيغابايت بإعدادات G1GC الافتراضية. ويُظهر اختبار الحمل P99 لتوقف GC عند 180 مللي ثانية وتوقفات Full GC عرضية أثناء قفزات الحمل.

**المهمة:**
1. عدّد إعدادات G1GC الافتراضية التي يُرجح أنها تسبب المشكلة
2. اكتب مجموعة خيارات JVM كاملة تستهدف P99 للتوقف < 50 مللي ثانية
3. اكتب صنف `GcPauseAlertEvaluator` يقرأ `GcPauseStats` ويعيد قائمة سجلات `AlertEvent` تصف أي انتهاكات، بمستويات خطورة (WARN/CRITICAL)

**المخرج المتوقع:** مقتطف صدفة لخيارات JVM وصنف Java مع اختبارات وحدة تغطي سيناريوهات GC السليمة والمتدهورة والحرجة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق بين `-XX:MaxGCPauseMillis` وحد توقف صارم في G1GC؟",
      "options": [
        "هما متطابقان — G1GC يحقق الهدف دائمًا",
        "MaxGCPauseMillis هدف مرن؛ يعدّل G1GC حجم الجيل الشاب وعدد المناطق القديمة في كل جمع مختلط لمحاولة تحقيقه، لكنه قد يتجاوزه",
        "MaxGCPauseMillis يضبط حدًا صارمًا؛ وتجاوزه يطلق OutOfMemoryError",
        "MaxGCPauseMillis ينطبق على ZGC فقط، لا على G1GC"
      ],
      "correct": 1,
      "explanation": "MaxGCPauseMillis هدف مرن. يستخدمه G1GC لتحجيم الجيل الشاب ولتقرير عدد المناطق القديمة التي يأخذها كل جمع مختلط، لكنه لا يضمن عدم تجاوز الهدف أبدًا، خاصة تحت ضغط الذاكرة أو حين يكون الـ heap شبه ممتلئ."
    },
    {
      "text": "لماذا يجب ضبط `-Xms` مساويًا لـ `-Xmx` في خدمة دفع منخفضة الزمن؟",
      "options": [
        "يقلل الاستهلاك الكلي للذاكرة",
        "يمنع JVM من تكبير الـ heap وتصغيره وقت التشغيل، وهو ما يحجز الذاكرة ويحررها وقد يضيف زمنًا تمامًا حين يرتفع الحمل",
        "يتيح لـ ZGC العمل في الوضع التوليدي",
        "يعطّل تعامل G1GC مع التخصيصات الضخمة"
      ],
      "correct": 1,
      "explanation": "حين يساوي Xms قيمة Xmx، يبدأ الـ heap بحجمه الكامل ولا يُعاد تحجيمه أبدًا. وهذا يزيل عمل التكبير/التصغير وقت التشغيل (حجز الذاكرة وتحريرها مع نظام التشغيل)، الذي يميل إلى الحدوث حين يتغير الحمل — وهو غير مرحب به خاصة لخدمات تفويض الدفع ذات SLA أقل من 50 مللي ثانية. وأضف -XX:+AlwaysPreTouch للمس الصفحات أيضًا عند البدء."
    },
    {
      "text": "خدمة دفع بـ heap حجمه 8 غيغابايت ومناطق G1 بحجم 8 ميغابايت تشهد تخصيصات ضخمة متكررة لمصفوفات بايت بحجم 5 ميغابايت. ما الإصلاح الصحيح؟",
      "options": [
        "زِد `-XX:MaxGCPauseMillis` إلى 500 مللي ثانية",
        "انتقل إلى ZGC الذي يتعامل مع كل الكائنات الضخمة بشفافية",
        "زِد `-XX:G1HeapRegionSize` إلى 16 ميغابايت كي لا تبقى كائنات 5 ميغابايت ضخمة",
        "اضبط `-XX:InitiatingHeapOccupancyPercent=10` لإطلاق الجمع مبكرًا"
      ],
      "correct": 2,
      "explanation": "الكائنات الضخمة هي التي تبلغ نصف حجم المنطقة على الأقل. فمع مناطق 8 ميغابايت، تكون الكائنات بحجم 4 ميغابايت أو أكثر ضخمة. وضبط G1HeapRegionSize=16m يجعل العتبة 8 ميغابايت، فتصبح مصفوفات 5 ميغابايت كائنات عادية في الجيل الشاب. (وتقليل حجم الكائن — مثلًا بالمعالجة كتدفق — هو الإصلاح الآخر.)"
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "ضبط G1GC في الإنتاج لخدمة تفويض دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "عدّد إعدادات G1GC الافتراضية التي يُرجح أنها تسبب توقفات GC بـ P99 قدره 180 مللي ثانية على heap بحجم 4 غيغابايت عند 3,000 معاملة في الثانية، واشرح أثر كل منها."},
    {"id": "2", "description": "اكتب مجموعة خيارات JVM كاملة تستهدف P99 للتوقف < 50 مللي ثانية لحاوية بحجم 16 غيغابايت تشغّل خدمة تفويض دفع بـ 5,000 معاملة في الثانية، مع تبرير لكل خيار غير افتراضي."},
    {"id": "3", "description": "اكتب صنف GcPauseAlertEvaluator يقرأ GcPauseStats ‏(المتوسط، والأقصى، وp99، وfullGcCount) ويعيد قائمة سجلات AlertEvent بمستويات خطورة WARN/CRITICAL."},
    {"id": "4", "description": "اكتب اختبارات وحدة لـ GcPauseAlertEvaluator تغطي: الحالة السليمة (لا تنبيهات)، والحالة المتدهورة (p99 > 100 مللي ثانية = WARN)، والحالة الحرجة (Full GC > 0 أو p99 > 500 مللي ثانية = CRITICAL)."}
  ]
}
-->
