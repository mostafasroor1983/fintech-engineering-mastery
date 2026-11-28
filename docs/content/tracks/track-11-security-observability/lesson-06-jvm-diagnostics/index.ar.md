---
id: track-11-lesson-06
title: "تشخيص JVM — تفريغ الخيوط وتحليل الكومة في بيئة الإنتاج"
slug: jvm-diagnostics
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 6
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [JVM-diagnostics, thread-dump, heap-dump, JFR, jcmd]
prerequisites: [track-11-lesson-05]
---

# تشخيص JVM — تفريغات الخيوط وتحليل الكومة في الإنتاج

> [!NOTE]
> حين تبدأ خدمة دفع في الاستجابة ببطء أو تسريب الذاكرة في الإنتاج، يكون لديك دقائق — لا ساعات — لتشخيص المشكلة دون إعادة تشغيل JVM وفقدان الأدلة. وإتقان أدوات تشخيص JVM هو الفرق بين حل في 15 دقيقة وانقطاع لساعات.

## لماذا يهم تشخيص JVM في التقنية المالية

مشكلات JVM الإنتاجية في أنظمة الدفع عالية المخاطر بشكل خاص. فمجمّع خيوط مستنفد بسبب استعلامات قاعدة بيانات بطيئة يعني توقف المدفوعات. وتسرب في الكومة يسبب ضغطًا على جامع القمامة يطلق زمنًا متتاليًا عبر خط المعاملات. وبخلاف الخدمات عديمة الحالة، تحمل JVM حالة حية: معاملات نشطة، ومجمّعات اتصالات، ورسائل جارية. فلا يمكنك ببساطة إعادة التشغيل للتحقيق — بل تحتاج استخراج التشخيصات والعملية حية.

يغطي هذا الدرس عُدة التشخيص كاملة: تفريغات الخيوط لمشكلات التزامن، وتفريغات الكومة لمشكلات الذاكرة، وJava Flight Recorder للتنميط المستمر. وكل أمر وتقنية متحقق منهما للاستخدام على JVM إنتاجية حية بأقل أثر على الأداء.

---

## جمع تفريغات الخيوط

تفريغ الخيوط لقطة في لحظة زمنية لتتبع المكدس وحالة كل خيط. ولمشكلات التزامن — الجمود (deadlocks)، وتشبع مجمّع الخيوط، والتنافس على الأقفال — هو أداة التشخيص الأساسية.

### طرق الجمع

**الطريقة 1: jcmd (المفضّلة للإنتاج)**

```bash
# List running JVM processes
jcmd

# Output example:
# 12345 com.example.payment.PaymentServiceApplication
# 23456 org.apache.kafka.kafka.Kafka

# Collect thread dump from payment service PID 12345
jcmd 12345 Thread.print

# Save to file for analysis
jcmd 12345 Thread.print > /tmp/thread-dump-$(date +%Y%m%d-%H%M%S).txt

# Include locked synchronizers (critical for diagnosing deadlocks)
jcmd 12345 Thread.print -l > /tmp/thread-dump-with-locks.txt
```

يجد `jcmd` أجهزة JVM عبر `/tmp/hsperfdata_<user>/` ويتواصل معها عبر مقبس الربط (attach socket). وهو آمن للإنتاج: يوقف تفريغ الخيوط الخيوط لفترة وجيزة فقط عند نقطة أمان (safepoint) (عادةً ملي ثوانٍ). ويجب أن يعمل بالمستخدم نفسه الذي يشغّل JVM — في Kubernetes عبر `kubectl exec`، أو حاوية تصحيح مؤقتة (`kubectl debug --target=<container>`) حين لا تحوي الصورة (مثل distroless أو JRE) أدوات JDK.

**الطريقة 2: jstack**

```bash
# Same result as jcmd Thread.print, different interface
jstack -l 12345 > /tmp/thread-dump.txt

# JVM completely unresponsive to the attach mechanism (JDK 9+: the old
# "jstack -F" moved to the serviceability agent)
jhsdb jstack --pid 12345 > /tmp/thread-dump-forced.txt
```

> [!WARNING]
> يقرأ `jhsdb jstack` العملية من الخارج ويعلّقها طوال القراءة. استخدمه فقط حين لا تعود JVM تستجيب لـ `jcmd` إطلاقًا.

**الطريقة 3: kill -3 (ملاذ أخير على Linux)**

```bash
# Sends SIGQUIT signal; JVM prints thread dump to stdout/stderr
kill -3 12345
# Output goes to process stdout — for systemd: journalctl -u payment-service --since "1 minute ago"
```

**الطريقة 4: نقطة Spring Boot Actuator**

```yaml
# application.yml -- expose diagnostics only on a separate, internal
# management port, behind authentication. A heap dump contains every secret
# and every piece of customer data in memory (card numbers, tokens,
# passwords): never reachable from outside the cluster.
management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: threaddump, heapdump, health, metrics
```

```bash
# Collect via HTTP (useful when kubectl exec is unavailable)
curl -s http://payment-service:8081/actuator/threaddump \
  | jq '.threads[] | {name: .threadName, state: .threadState}' \
  | head -50
```

### جمع لقطات متعددة

تفريغ خيوط واحد نادرًا ما يكفي. اجمع ثلاثة تفريغات بفاصل 10 ثوانٍ للتمييز بين الحالات العابرة والمشكلات المستمرة:

```bash
#!/bin/bash
PID=$1
INTERVAL=10
COUNT=3

for i in $(seq 1 $COUNT); do
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  OUTPUT="/tmp/thread-dump-${TIMESTAMP}.txt"
  jcmd $PID Thread.print -l > "$OUTPUT"
  echo "Collected dump $i: $OUTPUT"
  if [ $i -lt $COUNT ]; then
    sleep $INTERVAL
  fi
done

echo "Compare: threads stuck in same state across all three captures indicate persistent blocking"
```

---

## فهم حالات الخيوط

يحمل كل خيط في التفريغ حالة تضيّق فورًا مجال التشخيص.

### مرجع حالات الخيوط

| الحالة | المعنى | السبب الشائع في خدمات الدفع |
|-------|---------|----------------------------------|
| `RUNNABLE` | ينفّذ أو جاهز للتنفيذ | تنفيذ طبيعي؛ والعدد الكبير يشير إلى تشبع المعالج |
| `BLOCKED` | ينتظر الحصول على قفل `synchronized` | تنافس على الأقفال في الذاكرات المؤقتة المشتركة أو مجمّعات الاتصالات |
| `WAITING` | ينتظر دون حد (`Object.wait()`، و`LockSupport.park()`) | خيوط مجمّع خاملة؛ شيفرة مدفوعة بالأحداث تنتظر عملًا |
| `TIMED_WAITING` | ينتظر بمهلة (`sleep`، و`wait(timeout)`) | متوقع للاستطلاع بمهلة؛ والعدد المفرط يعني خدمة سابقة بطيئة |
| `NEW` | خيط أُنشئ لكن لم يبدأ | غير معتاد إن استمر |
| `TERMINATED` | خيط اكتمل | طبيعي؛ ويُنظّف عادةً بسرعة |

### قراءة مُدخل تفريغ خيط

```
"http-nio-8080-exec-42" #139 daemon prio=5 os_prio=0 cpu=234.17ms elapsed=892.45s
   java.lang.Thread.State: TIMED_WAITING (parking)
        at sun.misc.Unsafe.park(Native Method)
        - parking to wait for <0x00000000c0f5d0a8>
            (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
        at java.util.concurrent.LinkedBlockingQueue.poll(LinkedBlockingQueue.java:467)
        at org.apache.tomcat.util.threads.TaskQueue.poll(TaskQueue.java:85)
        at java.util.concurrent.ThreadPoolExecutor.getTask(ThreadPoolExecutor.java:1053)
        at java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1114)
        at java.lang.Thread.run(Thread.java:829)
```

الحقول الأساسية:
- اسم الخيط: `http-nio-8080-exec-42` — خيط عامل HTTP رقم 42 في Tomcat
- الحالة: `TIMED_WAITING (parking)` — خامل، ينتظر عملًا من الطابور
- ‏`cpu=234.17ms elapsed=892.45s` — الخيط حي منذ 892 ثانية لكنه استخدم 234ms من المعالج فقط (خمول سليم)

### تشخيص استنفاد مجمّع الخيوط

**العَرَض**: تعيد واجهة الدفع أخطاء 503 أو تنتهي مهلتها رغم أن التطبيق يعمل. ولا يوجد عامل Tomcat خامل (العمال الخاملون ينتظرون في `TaskQueue.poll`). والحالة وحدها لا تروي القصة كلها — انظر إلى إطارات المكدس:
- العمال الذين ينتظرون اتصال JDBC متاحًا في حالة `TIMED_WAITING (parking)` داخل `HikariPool.getConnection`؛
- العمال العالقون في استعلام بطيء في حالة `RUNNABLE` في قراءة مقبس داخل مشغّل JDBC؛
- العمال الذين ينتظرون قفلًا في حالة `BLOCKED` ‏(synchronized) أو `WAITING (parking)` ‏(أقفال j.u.c).

```bash
# Count threads by state
jcmd 12345 Thread.print | grep "java.lang.Thread.State" | sort | uniq -c | sort -rn

# Exhaustion indicator: no worker idle in TaskQueue.poll
jcmd 12345 Thread.print | grep -c "TaskQueue.poll"    # 0 idle workers

# Find where the workers are stuck
jcmd 12345 Thread.print | grep -A 25 "http-nio-8080-exec" \
  | grep -E "HikariPool.getConnection|SocketInputStream|socketRead|PgStatement" | sort | uniq -c
```

النتيجة المعتادة: ينتظر تقريبًا كل عمال Tomcat الـ 200 في `HikariPool.getConnection`، لأن الاتصالات العشرين محجوزة لطلبات عالقة في استعلامات بطيئة. ومسار الإصلاح: افحص مقاييس HikariCP ‏(`hikaricp_connections_pending`، وزمن الحصول) ← جد الاستعلامات البطيئة التي تحجز الاتصالات ← حسّنها. وزيادة حجم المجمّع تساعد فقط إذا كان لدى قاعدة البيانات سعة فائضة.

```yaml
# HikariCP configuration for payment services (application.yml).
# Spring Boot binds these properties and registers the Hikari metrics with
# Micrometer automatically -- no hand-written DataSource bean needed
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 3000        # 3s -- fail fast instead of piling up
      idle-timeout: 600000            # 10 min
      max-lifetime: 1800000           # 30 min (below DB/proxy idle limits)
      leak-detection-threshold: 60000 # warn if a connection is held > 60s
```

---

## اكتشاف الجمود

الجمود في خدمات الدفع نادر لكنه كارثي — يوقف كل معالجة المعاملات بصمت. وتكتشف JVM الجمود بين مراقبات `synchronized` وأقفال `java.util.concurrent` (المزامنات المملوكة، الظاهرة مع `-l`) وتُبلغ عنه في أسفل تفريغ الخيوط.

### تحديد الجمود

```
Found one Java-level deadlock:
=============================
"payment-processor-1":
  waiting to lock monitor 0x00007f3a8c001000
      (object 0x00000000c0f5d0a8, a com.example.payment.FraudCheckCache),
  which is held by "payment-processor-2"

"payment-processor-2":
  waiting to lock monitor 0x00007f3a8c002000
      (object 0x00000000c0f5d1b0, a com.example.payment.RuleEngine),
  which is held by "payment-processor-1"

Java stack information:
=======================
"payment-processor-1":
        at com.example.payment.FraudCheckService.evaluate(FraudCheckService.java:87)
        - waiting to lock <0x00000000c0f5d0a8> (a FraudCheckCache)
        - locked <0x00000000c0f5d1b0> (a RuleEngine)

"payment-processor-2":
        at com.example.payment.RuleEngine.apply(RuleEngine.java:56)
        - waiting to lock <0x00000000c0f5d1b0> (a RuleEngine)
        - locked <0x00000000c0f5d0a8> (a FraudCheckCache)
```

**السبب الجذري**: خيطان يحصلان على القفلين نفسيهما بترتيب معاكس.

```java
// BEFORE — deadlock-prone: threads acquire locks in different orders
synchronized (fraudCheckCache) {
    synchronized (ruleEngine) {         // Thread 1: holds cache, wants engine
        ruleEngine.apply(payment);
    }
}
// Elsewhere:
synchronized (ruleEngine) {
    synchronized (fraudCheckCache) {    // Thread 2: holds engine, wants cache
        fraudCheckCache.update(result);
    }
}

// AFTER — consistent lock ordering + timeout to avoid indefinite deadlock
private static final int LOCK_ID_CACHE  = 1;
private static final int LOCK_ID_ENGINE = 2;
private static final ReentrantLock CACHE_LOCK  = new ReentrantLock();
private static final ReentrantLock ENGINE_LOCK = new ReentrantLock();

// Rule: always acquire lower-id lock first — documented in architecture decision record
private void withCacheAndEngine(Runnable action) throws InterruptedException {
    // Always acquire CACHE_LOCK (id=1) before ENGINE_LOCK (id=2) — consistent order
    if (!CACHE_LOCK.tryLock(100, TimeUnit.MILLISECONDS)) {
        throw new PaymentProcessingException("Cache lock timeout — possible contention");
    }
    try {
        if (!ENGINE_LOCK.tryLock(100, TimeUnit.MILLISECONDS)) {
            throw new PaymentProcessingException("Engine lock timeout");
        }
        try {
            action.run();
        } finally {
            ENGINE_LOCK.unlock();
        }
    } finally {
        CACHE_LOCK.unlock();
    }
}
```

---

## جمع تفريغات الكومة

تلتقط تفريغات الكومة الحالة الكاملة لكومة JVM — كل كائن، وحجمه، والمراجع بينها. وهي الأداة الأساسية لتشخيص تسربات الذاكرة و`OutOfMemoryError`.

### طرق الجمع

**الطريقة 1: jcmd (JVM حية، المفضّلة)**

```bash
# Collect heap dump to a file. By default only LIVE objects are dumped,
# which first runs a full GC; add -all to skip that GC (bigger file)
jcmd 12345 GC.heap_dump /tmp/heap-$(date +%Y%m%d-%H%M%S).hprof

# File size is roughly the used heap (at most about -Xmx):
# a 4GB heap with 2.5GB in use produces a ~2-3GB dump -- check disk space
```

> [!WARNING]
> يتطلب جمع تفريغ الكومة توقفًا كاملًا (stop-the-world). ولكومة 4GB، قد يستغرق هذا التوقف 10-30 ثانية. أبلغ فريق المناوبة قبل الجمع في الإنتاج — وأخرج النسخة من موازن الحمل أولًا إن أمكن. وعامل ملف `.hprof` كـ **بيانات بالغة الحساسية**: فهو يحوي كل سر وكل سجل عميل في الذاكرة. خزّنه مشفرًا، وقيّد الوصول إليه، واحذفه بعد التحليل.

**الطريقة 2: jmap مع مرشح live**

```bash
# 'live' triggers a full GC first — smaller file, but longer pause
# (same behaviour as jcmd GC.heap_dump; jcmd is the preferred interface)
jmap -dump:live,format=b,file=/tmp/heap.hprof 12345
```

**الطريقة 3: تلقائيًا عند OOM (اضبط هذا دائمًا)**

```bash
# JVM startup flags for every production service
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/payment-service/heap-dumps/
-XX:+ExitOnOutOfMemoryError   # Restart cleanly rather than limping in degraded state
```

```yaml
# kubernetes/deployment.yaml
spec:
  containers:
  - name: payment-service
    env:
    - name: JAVA_TOOL_OPTIONS      # read by every JVM (JAVA_OPTS only by some start scripts)
      value: >-
        -Xms2g -Xmx4g
        -XX:+HeapDumpOnOutOfMemoryError
        -XX:HeapDumpPath=/heap-dumps/
        -XX:+ExitOnOutOfMemoryError
        -XX:+UseG1GC
        -XX:MaxGCPauseMillis=200
    volumeMounts:
    - name: heap-dump-storage
      mountPath: /heap-dumps
  volumes:
  - name: heap-dump-storage
    persistentVolumeClaim:
      claimName: heap-dump-pvc
```

**الطريقة 4: Spring Boot Actuator**

```bash
# Downloads heap dump as hprof file — suitable for smaller heaps (< 1GB);
# internal management port with authentication only (see above)
curl -O http://payment-service:8081/actuator/heapdump
```

---

## التحليل بـ Eclipse MAT

أداة Eclipse Memory Analyzer ‏(MAT) الأداة القياسية لتحليل تفريغات الكومة. نزّلها من eclipse.dev/mat. وللتفريغات الكبيرة (>2GB)، زد كومة MAT نفسها: عدّل `MemoryAnalyzer.ini` واضبط `-Xmx6g`.

### المفاهيم الأساسية

**الكومة الضحلة (Shallow heap)**: الذاكرة التي يستهلكها الكائن نفسه — حقوله ومراجعه (المؤشرات)، لا الكائنات التي يشير إليها. وهي صغيرة عادةً (عشرات البايتات).

**الكومة المحتجزة (Retained heap)**: الذاكرة التي ستُحرر إذا جُمع هذا الكائن — بما فيها كل الكائنات التي لا يمكن الوصول إليها إلا عبره. وهذا المقياس ذو المعنى لتحليل التسرب.

**شجرة الهيمنة (Dominator tree)**: شجرة يهيمن فيها كل عقدة على شجرتها الفرعية. فإذا أزلت العقدة X، تصبح كل الكائنات في شجرتها الفرعية غير قابلة للوصول. وتُظهر شجرة الهيمنة فورًا الكائنات التي تحتجز أكبر قدر من الذاكرة.

### تحليل تفريغ كومة لخدمة دفع

**الخطوة 1: شغّل تقرير المشتبهين بالتسرب (Leak Suspects)**

يولّد MAT تلقائيًا تقرير "Leak Suspects" عند الفتح. ولخدمة دفع بذاكرة جلسات مؤقتة غير محدودة:

```
Problem Suspect 1
=================
One instance of "com.example.payment.TransactionCacheService"
loaded by "jdk.internal.loader.ClassLoaders$AppClassLoader"
occupies 2,847,234,560 bytes (68.2% of heap).

The memory is accumulated in one instance of
"java.util.concurrent.ConcurrentHashMap$Node[]"

Keywords: TransactionCacheEntry, ConcurrentHashMap, 4,234,891 instances
```

**الخطوة 2: افحص شجرة الهيمنة**

```
Dominator Tree — Top Retained Heap
====================================
Class Name                                  Shallow    Retained
com.example.payment.TransactionCacheService    48 B    2,847 MB  (68%)
  └─ java.util.concurrent.ConcurrentHashMap   112 B    2,847 MB
       └─ Node[]                              2.1 GB    2.1 GB
            └─ TransactionCacheEntry[]          ...       ...
```

**الخطوة 3: افحص بـ OQL ‏(Object Query Language)**

```sql
-- MAT's OQL works on objects and their FIELDS (no ORDER BY / GROUP BY;
-- use the Histogram view for counts and its column sorting for ordering)

-- Find large HashMaps (HashMap stores its size in the "size" field)
SELECT * FROM java.util.HashMap m WHERE m.size > 100000

-- List cache entries with their transaction IDs and creation time
SELECT toString(s.transactionId), s.createdAt
FROM com.example.payment.TransactionCacheEntry s
```

**الخطوة 4: أصلح التسرب**

```java
// BEFORE — unbounded cache with no eviction policy
@Component
public class TransactionCacheService {
    // Grows indefinitely — no size limit, no TTL
    private final Map<String, TransactionDetails> cache = new ConcurrentHashMap<>();

    public void put(String txId, TransactionDetails details) {
        cache.put(txId, details);  // Never evicted
    }
}

// AFTER — bounded Caffeine cache with TTL and metrics
@Configuration
public class CacheConfig {

    @Bean
    public Cache<String, TransactionDetails> transactionCache(MeterRegistry registry) {
        return Caffeine.newBuilder()
            .maximumSize(10_000)                     // Hard size limit
            .expireAfterWrite(15, TimeUnit.MINUTES)   // TTL — completed transactions expire
            .expireAfterAccess(5, TimeUnit.MINUTES)   // Also expire if not accessed
            .recordStats()   // hit/miss stats; publish with CaffeineCacheMetrics.monitor(...)
            .removalListener((key, val, cause) -> {
                if (cause == RemovalCause.SIZE) {
                    registry.counter("cache.eviction", "cause", "size").increment();
                }
            })
            .build();
    }
}
```

---

## ‏Java Flight Recorder ‏(JFR)

‏JFR إطار تنميط مستمر منخفض العبء مدمج في JVM (مفتوح المصدر منذ JDK 11، ومتوفر أيضًا في 8u262+). وبخلاف تفريغات الكومة/الخيوط التي تمثل لحظة زمنية، يسجل JFR تدفقًا مستمرًا من الأحداث — تنميط الطرق، وأحداث جامع القمامة، والإدخال/الإخراج، والاستثناءات، وأقفال الخيوط. ومع إعدادات `default` يكون العبء نحو 1%؛ وتجمع إعدادات `profile` تفاصيل أكثر بكلفة أعلى قليلًا وتناسب التسجيلات الأقصر والموجهة.

### بدء JFR على JVM عاملة

```bash
# Start a 5-minute recording
jcmd 12345 JFR.start \
  name=payment-profile \
  duration=5m \
  filename=/tmp/payment-$(date +%Y%m%d-%H%M%S).jfr \
  settings=profile

# Check recording status
jcmd 12345 JFR.check

# Dump without stopping (snapshot while recording continues)
jcmd 12345 JFR.dump name=payment-profile filename=/tmp/snapshot.jfr

# Stop and dump
jcmd 12345 JFR.stop name=payment-profile filename=/tmp/final.jfr
```

### التسجيل الدائم (موصى به للإنتاج)

```bash
# JVM startup flags — keeps a rolling 1-hour window on disk
# ("default" settings for always-on; switch to "profile" for short recordings)
-XX:StartFlightRecording=name=continuous,maxage=1h,maxsize=250m,disk=true,settings=default
```

حين يقع حادث، فرّغ الساعة الأخيرة من التسجيلات دون إعادة التشغيل:

```bash
jcmd 12345 JFR.dump name=continuous filename=/tmp/incident-$(date +%Y%m%d-%H%M%S).jfr
```

هذه أثمن قدرة تصحيح في الإنتاج: التنميط بأثر رجعي من قبل بدء الحادث.

### تحليل JFR بـ JDK Mission Control

نزّل JDK Mission Control ‏(JMC) من adoptium.net. وأهم عروض التحليل:

**تنميط الطرق** — أين يُنفق وقت المعالج؟

```
Hot Methods (self time)
=======================
com.example.payment.FraudScoreCalculator.calculate()     34.2%
java.util.regex.Pattern.matcher()                         8.7%   <- suspicious
com.example.payment.IbanValidator.validate()              7.1%   <- suspicious
org.hibernate.dialect.PostgreSQLDialect.toString()        4.2%
```

مطابقة التعابير النمطية في مسارات معالجة الدفع الساخنة مشكلة أداء شائعة. ترجم الأنماط مسبقًا:

```java
// BEFORE — Pattern compiled on every call (expensive)
public boolean isValidIban(String iban) {
    return iban.matches("^[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}$");
}

// AFTER — Pattern compiled once at class load time
private static final Pattern IBAN_PATTERN =
    Pattern.compile("^[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}$");

public boolean isValidIban(String iban) {
    if (iban == null || iban.length() < 15 || iban.length() > 34) return false;
    return IBAN_PATTERN.matcher(iban).matches();
}
```

**تحليل الأقفال** — أين يحدث التنافس على الأقفال؟

```
Lock Events
===========
java.util.logging.Logger (synchronized)    Count: 42,891   Avg wait: 2.3ms
com.example.payment.AuditService           Count: 18,234   Avg wait: 4.7ms
```

يشير التنافس على الأقفال في `AuditService` إلى مسجّل تدقيق متزامن يحجب خيوط الدفع. اجمع الكتابات في دفعات غير متزامنة — لكن **لا تُسقط أحداث التدقيق أبدًا**: ففي نظام دفع، مسار التدقيق سجل تنظيمي، فيجب أن يرجع الطابور الممتلئ إلى كتابة متزامنة (ضغط عكسي)، لا إلى التخلص. (ولسجلات التدقيق التي يجب أن تكون بديمومة الدفعة نفسها تمامًا، اكتبها في معاملة قاعدة بيانات الدفعة نفسها، مثلًا عبر جدول outbox.)

```java
@Component
public class AuditService {
    private final BlockingQueue<AuditEvent> auditQueue =
        new LinkedBlockingQueue<>(10_000);  // Bounded — prevents memory growth

    private final AuditRepository auditRepository;
    private final Counter auditSyncFallbackCounter;

    public AuditService(AuditRepository auditRepository, MeterRegistry registry) {
        this.auditRepository = auditRepository;
        this.auditSyncFallbackCounter = registry.counter("audit.events.sync_fallback");
    }

    // Called from payment thread — normally non-blocking
    public void recordPayment(PaymentAuditEvent event) {
        if (!auditQueue.offer(event)) {
            // Queue full: write synchronously instead of dropping. The payment
            // thread slows down (back-pressure) but no audit record is lost.
            auditSyncFallbackCounter.increment();
            auditRepository.save(event);
        }
    }

    // Background thread drains queue in batches
    @Scheduled(fixedDelay = 100)
    void flushAuditQueue() {
        List<AuditEvent> batch = new ArrayList<>(100);
        auditQueue.drainTo(batch, 100);
        if (!batch.isEmpty()) {
            auditRepository.saveAll(batch);  // Single DB round-trip for 100 events
        }
    }

    // Flush what is still queued on shutdown (in-memory events would
    // otherwise be lost on a restart -- one reason regulatory audit records
    // often go through the transactional outbox instead)
    @PreDestroy
    void drainOnShutdown() {
        List<AuditEvent> rest = new ArrayList<>();
        auditQueue.drainTo(rest);
        if (!rest.isEmpty()) auditRepository.saveAll(rest);
    }
}
```

**تحليل جامع القمامة** — أنماط ضغط جمع القمامة:

```
GC Events
=========
G1 Young Generation Collections: 1,842 events
  Avg pause: 12ms, Max pause: 487ms   <- 487ms pause will cause timeout failures

G1 Full Collections: 3 events         <- Any full GC is a problem in production
  Avg pause: 8,432ms                  <- 8 second pause = complete payment outage
```

تشير عمليات الجمع الكاملة (Full GC) إلى ضغط على الكومة. تحقق: هل الكومة صغيرة جدًا؟ هل معدل التخصيص مرتفع جدًا؟ هل يوجد تسرب ذاكرة؟ ويُظهر عرض تفاصيل GC في JFR نقاط التخصيص الساخنة — حيث تُخصص الكائنات أسرع.

---

## مرجع أوامر jcmd التشخيصية

```bash
# List all available commands for a PID
jcmd 12345 help

# JVM flags (what flags are active)
jcmd 12345 VM.flags

# System properties
jcmd 12345 VM.system_properties

# Class histogram — top classes by instance count. No heap dump, but by
# default it counts LIVE objects and therefore runs a full GC first;
# "-all" skips the GC (counts unreachable objects too)
jcmd 12345 GC.class_histogram -all | head -30
# Output format:
#  num     #instances         #bytes  class name
# -------------------------------------------------------
#    1:       4,234,891    135,516,512  com.example.payment.TransactionCacheEntry
#    2:         892,344     42,832,512  java.lang.String

# Memory usage breakdown by JVM memory areas
# (needs -XX:NativeMemoryTracking=summary at startup)
jcmd 12345 VM.native_memory summary

# Run a full GC (rarely needed: a live heap dump or histogram does this itself)
jcmd 12345 GC.run

# JVM uptime
jcmd 12345 VM.uptime

# Version and JVM info
jcmd 12345 VM.version

# Metaspace usage (class metadata)
jcmd 12345 VM.metaspace

# Code cache status
jcmd 12345 VM.codecache

# Compiler statistics
jcmd 12345 Compiler.stats
```

**المدرج التكراري للأصناف (class histogram)** أسرع كاشف للتسرب متاح — أرخص بكثير من تفريغ الكومة، وإن كان الوضع الافتراضي (live) يسبب توقف جمع كامل:

```bash
# Collect histograms 60 seconds apart and diff them
jcmd 12345 GC.class_histogram > /tmp/hist1.txt
sleep 60
jcmd 12345 GC.class_histogram > /tmp/hist2.txt

# If TransactionCacheEntry count increased by thousands in 60 seconds, it is leaking
```

---

## تشخيص تسربات الذاكرة في خدمات دفع Spring Boot

### أنماط التسرب الشائعة وإصلاحاتها

**النمط 1: تسرب ThreadLocal في مجمّعات خيوط Tomcat**

يعيد Tomcat استخدام خيوط العمال. فـ ThreadLocal المضبوط أثناء طلب دون إزالته يبقى في الطلب التالي على الخيط نفسه.

```java
// WRONG — ThreadLocal never cleaned up
public class PaymentContextHolder {
    private static final ThreadLocal<PaymentContext> CONTEXT = new ThreadLocal<>();
    public static void set(PaymentContext ctx) { CONTEXT.set(ctx); }
    public static void remove() { CONTEXT.remove(); }
    // Bug: nobody calls remove() — the context of one request leaks into the
    // next request on the same pooled thread
}

// CORRECT — clean up in a servlet filter's finally block
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class PaymentContextFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req,
                                    HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        try {
            PaymentContextHolder.set(buildContext(req));
            chain.doFilter(req, res);
        } finally {
            PaymentContextHolder.remove();  // Always runs — prevents leak between requests
        }
    }
}
```

**النمط 2: ذاكرة Hibernate المؤقتة من المستوى الأول في المعالجة الدفعية**

```java
// WRONG — processing 1 million transactions keeps all in Hibernate L1 cache
@Transactional
public void reconcileAllTransactions() {
    transactionRepository.findAll().forEach(tx -> {
        processTransaction(tx);
        // Every tx object accumulates in the Hibernate session's L1 cache
    });
}

// CORRECT — stream with periodic flush/clear
@Transactional
public void reconcileAllTransactions() {
    try (Stream<Transaction> txStream = transactionRepository.streamAll()) {
        AtomicLong count = new AtomicLong(0);
        txStream.forEach(tx -> {
            processTransaction(tx);
            if (count.incrementAndGet() % 1000 == 0) {
                entityManager.flush();
                entityManager.clear();  // Clears L1 cache — prevents unbounded growth
            }
        });
    }
}
```

**النمط 3: مستمع لم يُلغَ تسجيله**

```java
// WRONG — anonymous inner class holds reference to outer class indefinitely
@Service
public class PaymentEventService {
    @Autowired
    public void init(EventBus eventBus) {
        eventBus.register(new Object() {   // Anonymous class holds implicit reference to PaymentEventService
            @Subscribe
            public void onPayment(PaymentEvent event) {
                PaymentEventService.this.process(event);
            }
        });
        // Listener is never unregistered — it (and the service) stay reachable
        // from the EventBus. For a singleton that's harmless; for prototype
        // or request-scoped beans it is a leak that grows with every instance
    }
}

// CORRECT — register/unregister as a bean lifecycle method
@Service
public class PaymentEventService implements DisposableBean {
    private final EventBus eventBus;

    public PaymentEventService(EventBus eventBus) {
        this.eventBus = eventBus;
        eventBus.register(this);  // Register 'this', not an anonymous class
    }

    @Subscribe
    public void onPayment(PaymentEvent event) { process(event); }

    @Override
    public void destroy() {
        eventBus.unregister(this);  // Spring calls this on shutdown
    }
}
```

---

## سير عمل التشخيص في الإنتاج

حين يطلق PagerDuty تنبيهًا لذاكرة مرتفعة أو استجابة بطيئة في خدمة دفع:

```
PHASE 1 — SAFE (no measurable JVM impact)
  jcmd <pid> VM.flags                  Confirm heap size settings
  GET /actuator/metrics/jvm.memory.used  Current heap consumption
  GET /actuator/metrics/jvm.gc.pause   Recent GC pause times
  jcmd <pid> GC.class_histogram -all   Check for obvious leak classes (no GC)

PHASE 2 — THREAD ANALYSIS (brief safepoint pause, milliseconds)
  Collect 3 thread dumps 10s apart:
    jcmd <pid> Thread.print -l > dump1.txt
  Count threads by state
  Search for deadlock section at bottom of dump
  Identify threads with same stack frame across all 3 dumps

PHASE 3 — JFR SNAPSHOT (< 2% overhead if already running)
  jcmd <pid> JFR.dump name=continuous filename=incident.jfr
  Open in JMC: method profiling → GC events → lock contention

PHASE 4 — HEAP DUMP (last resort — stop-the-world pause)
  Notify team: "collecting heap dump, service will pause 10-30s"
  jcmd <pid> GC.heap_dump /tmp/heap-$(date +%Y%m%d-%H%M%S).hprof
  Open in Eclipse MAT: Leak Suspects → Dominator Tree → OQL

PHASE 5 — REMEDIATE
  Immediate: restart if necessary, scale out for headroom
  Root cause: code fix, deploy, verify metrics recover
  Follow-up: postmortem with prevention measures
```

---

## مراقبة صحة JVM بـ Micrometer

لا تنتظر حادثًا إنتاجيًا — نبّه استباقيًا على مقاييس صحة JVM.

```yaml
# prometheus-alerts.yml
groups:
  - name: jvm_health
    rules:
      - alert: JvmHeapPressure
        # Micrometer reports heap PER POOL (eden, survivor, old gen): sum
        # the pools per instance before dividing
        expr: |
          sum by(instance) (jvm_memory_used_bytes{area="heap"})
          / sum by(instance) (jvm_memory_max_bytes{area="heap"}) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "JVM heap usage above 85% on {{ $labels.instance }}"
          runbook_url: "https://wiki.example.com/runbooks/jvm-heap-pressure"

      - alert: JvmGcPauseHigh
        expr: jvm_gc_pause_seconds_max > 1.0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "JVM GC pause > 1s on {{ $labels.instance }} — payments may be timing out"

      - alert: JvmMemoryLeak
        # live data after GC is a GAUGE: use delta(), not increase()
        # (increase() is for counters)
        expr: |
          delta(jvm_gc_live_data_size_bytes[1h]) > 100 * 1024 * 1024
        for: 2h
        labels:
          severity: warning
        annotations:
          summary: "JVM live data growing > 100MB/hour — possible memory leak"

      - alert: JvmLockContention
        expr: |
          jvm_threads_states_threads{state="blocked"}
          / jvm_threads_live_threads > 0.5
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "More than 50% of threads BLOCKED — heavy lock contention"
          # Pool exhaustion shows in pool metrics instead (e.g.
          # hikaricp_connections_pending, tomcat_threads_busy_threads)
```

---

## الخلاصات الأساسية

- استخدم `jcmd <pid> Thread.print -l` لتفريغات الخيوط؛ واجمع ثلاثة بفاصل 10 ثوانٍ قبل الاستنتاج
- حالات الخيوط تضيّق البحث، لكن إطارات المكدس تروي القصة: غياب أي عامل خامل في `TaskQueue.poll` يعني استنفاد المجمّع، وتُظهر الإطارات هل ينتظر العمال اتصالًا، أو قفلًا، أو استعلامًا بطيئًا
- التسجيل الدائم بـ JFR مع `maxage=1h` (إعدادات default، ونحو 1% عبء) يتيح تشخيص الحوادث بأثر رجعي — فعّله على كل JVM إنتاجية
- تُظهر شجرة الهيمنة في Eclipse MAT الكائنات التي تحتجز أكبر قدر من الذاكرة؛ والكومة المحتجزة هي المقياس ذو المعنى، لا الضحلة
- توفر المدرجات التكرارية للأصناف (`jcmd GC.class_histogram`) كشفًا سريعًا للتسرب دون تفريغ كومة — استخدمها أولًا (`-all` يتجنب الجمع الكامل)
- تفريغات الكومة تحوي أسرارًا وبيانات عملاء: لا تكشف `/actuator/heapdump` للعامة أبدًا، وتعامل مع ملفات `.hprof` كبيانات حساسة
- في خدمات دفع Spring Boot، أشيع مصادر التسرب: الذاكرات المؤقتة غير المحدودة، وThreadLocal غير المنظف في خيوط Tomcat، وتراكم ذاكرة Hibernate من المستوى الأول في المهام الدفعية
- اضبط `-XX:+HeapDumpOnOutOfMemoryError` و`-XX:+ExitOnOutOfMemoryError` على كل JVM إنتاجية — فتفريغ الكومة من الانهيار دليلك الوحيد

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الطريقة الأكثر أمانًا لأخذ تفريغ كومة من JVM إنتاجية بأقل توقف للتطبيق؟",
      "options": ["jmap -dump:format=b,file=heap.hprof <pid>", "jcmd <pid> GC.heap_dump /tmp/heap.hprof", "إنهاء العملية بـ SIGQUIT", "curl http://service/actuator/heapdump"],
      "correct": 1,
      "explanation": "‏jcmd GC.heap_dump هو الواجهة الموصى بها: يستخدم آلية الربط، ويكتب التفريغ داخل JVM، ويقدم -all لتجاوز الجمع الكامل الذي يحتاجه تفريغ الكائنات الحية. ولاحظ أن كل تفريغ كومة عملية توقف كامل — فكل من jcmd GC.heap_dump وjmap -dump:live يشغّلان جمعًا كاملًا أولًا افتراضيًا — فأخرج النسخة من الدوران إن استطعت. وSIGQUIT ينتج تفريغات خيوط فقط، لا تفريغات كومة. ونقطة actuator مقبولة للكومات الصغيرة لكنها تنقل ملفًا كبيرًا وبالغ الحساسية عبر HTTP ويجب ألا تُكشف للعامة أبدًا."
    },
    {
      "text": "في شجرة الهيمنة في Eclipse MAT، أي مقياس هو الأكثر فائدة لتحديد السبب الجذري لتسرب الذاكرة؟",
      "options": ["الكومة الضحلة — حجم الكائن نفسه", "الكومة المحتجزة — إجمالي الذاكرة المحررة إذا جُمع هذا الكائن", "عدد النسخ — عدد كائنات هذا الصنف", "عدد المراجع — عدد المراجع إلى هذا الكائن"],
      "correct": 1,
      "explanation": "تمثل الكومة المحتجزة إجمالي الذاكرة التي ستُحرر إذا جُمع كائن ما — بما فيها كل الكائنات التي لا يمكن الوصول إليها إلا عبره. وهذا المقياس ذو المعنى لاكتشاف التسرب لأنه يُظهر الكلفة الكاملة لإبقاء مرجع حيًا، لا حجم الكائن وحده."
    },
    {
      "text": "علامَ يدل وجود خيوط متعددة في حالة BLOCKED في تفريغ الخيوط غالبًا؟",
      "options": ["أن JVM تنفذ جمع القمامة", "تنافس على الأقفال — خيوط تنتظر الحصول على مراقب يحتجزه خيط آخر", "أن الخيوط تنتظر اكتمال عمليات الإدخال/الإخراج", "أن مجمّع الخيوط خامل، ينتظر عملًا جديدًا"],
      "correct": 1,
      "explanation": "تعني حالة BLOCKED تحديدًا أن الخيط ينتظر الحصول على مراقب كائن (كتلة/طريقة synchronized) يحتجزه خيط آخر. وهذا يدل على تنافس على الأقفال. أما WAITING/TIMED_WAITING فلعمليات النوم/الانتظار. وRUNNABLE تشمل الخيوط التي تؤدي إدخالًا/إخراجًا. والنسبة العالية من الخيوط BLOCKED إشارة إلى تنافس على الأقفال أو جمود محتمل."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تشخيص مشكلات ذاكرة وخيوط JVM في خدمة دفع وحلها",
  "difficulty": "advanced",
  "estimatedMinutes": 80,
  "tasks": [
    {"id": "1", "description": "اضبط خدمة دفع Spring Boot بتسجيل JFR دائم (إعدادات default، وmaxage=2h، وmaxsize=512m)، وتفريغ الكومة عند OOM في مجلد مخصص، وتشخيصات actuator فقط على منفذ إدارة داخلي، ومقاييس JVM من Micrometer مصدّرة إلى Prometheus. وتحقق من ظهور مقاييس الكومة، وتوقف GC، وحالات الخيوط في Grafana."},
    {"id": "2", "description": "أدخل تسرب ThreadLocal وشخّصه: أضف ThreadLocal لحمل سياق الدفع لا يُزال أبدًا في سلسلة المرشحات. وشغّل حملًا لمدة 10 دقائق، والتقط مدرجًا تكراريًا للأصناف بـ jcmd GC.class_histogram، وحدد الصنف المتنامي، ثم أصلح التسرب وتحقق من استقرار الكومة."},
    {"id": "3", "description": "أنشئ سيناريو جمود بين خيطي معالجة دفع يحصلان على AccountLock وTransactionLock بترتيبين متعاكسين. واجمع ثلاثة تفريغات خيوط بفاصل 10 ثوانٍ باستخدام jcmd Thread.print، وحدد قسم الجمود، وأصلح الشيفرة بفرض ترتيب حصول متسق على الأقفال."},
    {"id": "4", "description": "شغّل اختبار حمل لمدة 5 دقائق، ثم فرّغ تسجيل JFR وافتحه في JDK Mission Control. وحدد الطريقة الأولى حسب عينات المعالج، وصنف التخصيص الأول حسب البايتات المخصصة، وأي توقفات GC تتجاوز 100ms. واقترح تحسينًا واحدًا بناءً على هذه النتائج ونفّذه."}
  ]
}
-->
