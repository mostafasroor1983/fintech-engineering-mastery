---
id: track-07-lesson-17
title: "مخططات اللهب (Flame Graphs) — تصوير نقاط الضغط في المعالج والذاكرة"
slug: flame-graphs
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 17
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [flame-graph, async-profiler, CPU, allocation, visualisation]
prerequisites: []
---

# مخططات اللهب — عرض النقاط الساخنة في المعالج والذاكرة

> [!NOTE]
> مخططات اللهب (flame graphs) أكفأ أداة لتحديد النقاط الساخنة في المعالج والذاكرة في خدمات JVM الإنتاجية. فمخطط لهب واحد للمعالج مدته 30 ثانية لخدمة تفويض دفع كثيرًا ما يكشف الدالة الدقيقة التي تستهلك معالجًا غير متوقع — سواء كانت تسلسل JSON، أو ربط نتائج JDBC، أو حلقة تقييم قواعد احتيال غير فعّالة — دون تغييرات في الشيفرة أو إعادة تشغيل الخدمة.

## تشريح مخطط اللهب

يعرض مخطط اللهب تمثيلًا مرئيًا لتتبعات مكدس مأخوذة بالعينات:

```
▲ Stack Depth (y-axis)
│
│    [PaymentController.authorize]
│    ████████████████████████████████████████████████████
│         [AuthorizationService.check]
│         ████████████████████████████
│              [FraudRuleEngine.evaluate]
│              ████████████████████████
│                   [JsonMapper.readTree]    [RegexPattern.match]
│                   ████████████           ████████████
│                        [ObjectMapper...]  [Pattern.compile]
│                        ████████           ████████
│────────────────────────────────────────────────────────
  Width (x-axis) = proportion of time spent (alphabetically ordered)
```

**المحور X**: المكدسات مرتبة أبجديًا (ليس زمنيًا). ويمثل العرض نسبة وقت المعالج الكلي المقضي في إطار المكدس ذاك.

**المحور Y**: عمق المكدس. والأسفل دائمًا جذر الخيط (عادة `Thread.run`). وكل مستوى أعلى هو علاقة المستدعي/المستدعى.

**تفسير العرض**: الإطار العريض في أعلى المخطط يعني أن تلك الشيفرة كثيرًا ما تكون "على المعالج" — فهي تؤدي عملًا فعليًا أو مستدعٍ شائع. والإطار العريض بأبناء ضيقين يعني أن الإطار نفسه هو النقطة الساخنة، لا مستدعَياته.

**الهضبة (قمة مسطحة)**: دالة عريضة بلا أبناء مرئيين تعني أن تلك الدالة تستهلك المعالج مباشرة — نقطة ساخنة.

## مخططات اللهب للمعالج مقابل التخصيص مقابل الوقت الفعلي

| النوع | ما يُظهره | حالة الاستخدام |
|------|--------------|----------|
| المعالج | الدوال المستهلكة لدورات المعالج | استخدام معالج مرتفع، وخوارزميات غير فعّالة |
| التخصيص | الدوال التي تخصص كائنات في الـ heap | ضغط GC، واضطراب الذاكرة، ونقاط إنشاء الكائنات الساخنة |
| الوقت الفعلي (Wall-clock) | الدوال الموجودة "على المكدس" (معالج + انتظار إدخال/إخراج) | التحقيق في الزمن، واختناقات الإدخال/الإخراج |
| تنازع الأقفال | الدوال المحجوبة بانتظار الأقفال | اختناقات التزامن، وتنازع الأقفال |

لخدمات الدفع:
- استخدم **مخططات لهب المعالج** حين يكون استخدام المعالج مرتفعًا
- استخدم **مخططات لهب التخصيص** حين يكون معدل توقفات GC مرتفعًا
- استخدم **مخططات لهب الوقت الفعلي** حين يكون الزمن مرتفعًا لكن المعالج منخفضًا (انتظار إدخال/إخراج)

## ‏async-profiler — موصّف JVM المفضل

‏async-profiler أفضل أداة لتوصيف JVM في الإنتاج:
- يأخذ العينات بإشارات نظام التشغيل (perf_events أو المؤقتات في Linux) ويمشي مكدسات Java بـ `AsyncGetCallTrace` — بلا انحياز نقاط الأمان
- يعمل على أجهزة JVM قيد التشغيل دون تغييرات في الشيفرة
- حمل ضئيل (نحو 1–3% من المعالج)
- يولّد مخططات اللهب مباشرة

### التثبيت

```bash
# Download async-profiler
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar xf async-profiler-3.0-linux-x64.tar.gz -C /opt
export ASPROF=/opt/async-profiler-3.0-linux-x64/bin/asprof
```

### أوامر مخطط لهب المعالج

```bash
# Profile for 30 seconds, generate flame graph
# Replace <pid> with payment service PID
$ASPROF -d 30 -f /tmp/payment-cpu-flame.html <pid>

# Longer sampling interval = fewer samples, less overhead (default: 10ms)
$ASPROF -d 30 -i 20ms -f /tmp/payment-cpu-flame.html <pid>

# Profile CPU with thread separation (see per-thread breakdown)
$ASPROF -d 30 --threads -f /tmp/payment-cpu-flame-threads.html <pid>

# Only user-mode samples (leave out kernel frames)
$ASPROF -d 30 -e cpu --all-user -f /tmp/payment-cpu.html <pid>

# Interactive: start and stop manually
$ASPROF start -e cpu <pid>
# ... run your load test for 60 seconds ...
$ASPROF stop -f /tmp/payment-cpu.html <pid>
```

### أوامر مخطط لهب التخصيص

```bash
# Allocation flame graph: shows what code allocates the most heap
# Tracks object allocations, not CPU time
$ASPROF -d 30 -e alloc -f /tmp/payment-alloc-flame.html <pid>

# Sample more often: one sample per 512 KB allocated is the default;
# --alloc sets this sampling interval (smaller = more detail, more overhead)
$ASPROF -d 30 -e alloc --alloc 128k -f /tmp/payment-alloc-detailed.html <pid>

# Wall-clock mode: includes threads waiting on IO
# Essential for latency investigation
$ASPROF -d 30 -e wall -t -f /tmp/payment-wall.html <pid>
```

## قراءة مخطط لهب للمعالج — مثال خدمة دفع

```
Common flame graph patterns in payment services (illustrative):

PATTERN 1: JSON serialization hotspot
─────────────────────────────────────
PaymentController.authorize [████████████████████████████████████████]
  AuthorizationService.check [████████████████]  ObjectMapper.writeValueAsString [████████████]
                                                    JsonGenerator.writeString [██████████]
                                                      UTF8JsonGenerator._writeByte [████████]

FINDING: ObjectMapper consumes 35% of total CPU time.
ACTION: Enable ObjectMapper reuse (it is thread-safe), use byte[] output
        instead of String, consider pre-compiled serializers.

PATTERN 2: Regex compilation hotspot
──────────────────────────────────────
FraudRuleEngine.evaluate [████████████████████████████████]
  PatternMatchRule.check [████████████████]
    Pattern.compile [████████████]  ← HOTSPOT: compiling regex on every call
      Pattern.<init> [████████]

FINDING: Pattern.compile called on every fraud evaluation (10,000+/sec).
         Each Pattern.compile call can cost tens to hundreds of µs.
         (String.matches / replaceAll / split with a regex compile too.)
ACTION: Cache Pattern instances at class initialization.
        @PostConstruct: patterns = rules.stream()
            .map(r -> Pattern.compile(r.getRegex()))
            .toList();

PATTERN 3: JDBC result set mapping
────────────────────────────────────
AccountRepository.findById [████████████████████████████████]
  PgResultSet.getString [████████████████████]
    String.<init> / decoding [██████████]  ← many String allocations

FINDING: ResultSet mapping allocates thousands of String objects per query.
ACTION: SELECT only the columns you need, read numbers with getLong /
        getBigDecimal instead of parsing strings, and avoid loading rows
        you then filter in Java.
```

## توليد مخططات اللهب من شيفرة Java

```java
/**
 * Programmatic flame graph generation using async-profiler Java API.
 * Useful for capturing profiles around specific operations.
 */
@Service
@Slf4j
public class FlameGraphCapture {

    private final AsyncProfiler profiler = AsyncProfiler.getInstance();
    private final AtomicBoolean profiling = new AtomicBoolean(false);

    /**
     * Start profiling around a specific endpoint under load.
     * Call startCpuProfiling() before the load test, stopAndSaveFlameGraph() after.
     */
    public void startCpuProfiling() throws IOException {
        if (!profiling.compareAndSet(false, true)) return;   // already running
        profiler.execute("start,event=cpu,interval=10ms");
        log.info("CPU profiling started");
    }

    public void stopAndSaveFlameGraph(String outputPath) throws IOException {
        if (!profiling.compareAndSet(true, false)) return;
        // "stop,file=x.html" stops and writes an HTML flame graph
        // (the format follows the file extension)
        profiler.execute("stop,file=" + outputPath);
        log.info("Flame graph saved to {}", outputPath);
    }

    /**
     * Profile a specific code block and generate a flame graph.
     * Usage: profileBlock(() -> runLoadTest(), "/tmp/profile.html")
     */
    public <T> T profileBlock(Callable<T> block, String outputPath) throws Exception {
        startCpuProfiling();
        try {
            return block.call();
        } finally {
            stopAndSaveFlameGraph(outputPath);
        }
    }
}
```

## مخططات اللهب التفاضلية — تحليل التراجع

تقارن مخططات اللهب التفاضلية بين ملفي توصيف لإبراز ما تغير بين الإصدارات. وهذا أساسي لتحليل تراجع الأداء.

```bash
# Step 1: Profile the baseline as collapsed stacks (one line per stack)
$ASPROF -d 60 -o collapsed -f /tmp/baseline.txt <baseline-pid>

# Step 2: Deploy new version, profile again UNDER THE SAME LOAD
$ASPROF -d 60 -o collapsed -f /tmp/new.txt <new-pid>

# (A recording saved as .jfr can be converted later with the jfrconv
#  tool that ships with async-profiler.)

# Step 3: Generate differential flame graph
# Using Brendan Gregg's diff tools:
./flamegraph/difffolded.pl /tmp/baseline.txt /tmp/new.txt > /tmp/diff.txt
./flamegraph/flamegraph.pl /tmp/diff.txt > /tmp/diff-flame.svg

# Red frames: MORE time in new version (regression)
# Blue frames: LESS time in new version (improvement)
```

تفسير مخطط لهب تفاضلي **للوقت الفعلي** من تراجع في خدمة دفع (فتوصيف المعالج بالكاد كان سيُظهر هذا التغيير، لأن الخيط المنتظر على HTTP لا يستخدم المعالج):

```
Differential Flame Graph: v2.1.0 vs v2.2.0

RED (regression, much more wall-clock time):
  PaymentValidator.validate [████████████████████]  ← NEW: validation added
    AccountValidator.checkKycStatus [████████████]  ← added in v2.2.0
      KycService.fetchStatus [████████]              ← synchronous HTTP call
        HttpClient.send [████████]                   ← blocks on IO

FINDING: v2.2.0 added synchronous KYC validation that calls external HTTP service.
         This adds ~40ms of waiting to every authorization.
ACTION:
  1. Cache KYC status per account WITH event-driven invalidation (status
     changes are rare but must take effect immediately — e.g. a newly
     restricted customer)
  2. Or have the KYC service push status changes to this service
  3. Moving the check after authorisation is only acceptable if policy
     and regulation allow it — KYC is usually a gate, not an audit
```

## مخططات لهب JFR في JDK Mission Control

‏Java Flight Recorder ‏(JFR) مدمج في JDK ويلتقط الأحداث بحمل ضئيل:

```java
/**
 * Enable JFR for payment service with performance-focused settings.
 * JFR can run continuously in production with ~1% overhead
 * (using the "default" settings).
 * Equivalent to: java -XX:StartFlightRecording=name=payment-service,
 *                     settings=default,maxage=6h,maxsize=1g
 */
@Component
public class JfrConfiguration implements DisposableBean {

    private Recording recording;

    @PostConstruct
    public void configureJfr() throws IOException, ParseException {
        recording = new Recording(Configuration.getConfiguration("default"));
        recording.setName("payment-service");
        recording.setMaxAge(Duration.ofHours(6));     // keep the last 6 hours
        recording.setMaxSize(1024L * 1024 * 1024);    // ...or at most 1 GB
        recording.setToDisk(true);

        // CPU samples (the event is called jdk.ExecutionSample)
        recording.enable("jdk.ExecutionSample").withPeriod(Duration.ofMillis(20));
        recording.enable("jdk.JavaMonitorEnter").withThreshold(Duration.ofMillis(10));
        recording.enable("jdk.ThreadPark").withThreshold(Duration.ofMillis(10));
        // Allocation: the throttled sampler, NOT ObjectAllocationInNewTLAB,
        // which fires far too often for continuous production use
        recording.enable("jdk.ObjectAllocationSample");

        recording.start();
        // Dump on demand: jcmd <pid> JFR.dump name=payment-service filename=/tmp/dump.jfr
    }

    @Override
    public void destroy() {
        if (recording != null) recording.close();
    }
}
```

```bash
# Start JFR recording on running JVM
jcmd <pid> JFR.start name=payment-profile \
    settings=profile \
    duration=120s \
    filename=/tmp/payment-profile.jfr

# Dump JFR on demand (without stopping)
jcmd <pid> JFR.dump name=payment-profile filename=/tmp/now.jfr

# Stop recording
jcmd <pid> JFR.stop name=payment-profile

# Open in JDK Mission Control (JMC)
jmc /tmp/payment-profile.jfr
# JMC 8+: open the "Flame Graph" view (Window → Show View → Flame Graph)
```

## أنماط النقاط الساخنة الشائعة في خدمات الدفع

```java
/**
 * Pattern 1: ObjectMapper instantiation in hot path
 * BAD: creates new ObjectMapper on every request (expensive)
 */
@RestController
public class BadPaymentController {
    @PostMapping("/payments")
    public String authorize(@RequestBody String body) throws Exception {
        ObjectMapper mapper = new ObjectMapper();  // BAD: costly to create, and
                                                   // its serializer caches start empty
        Payment payment = mapper.readValue(body, Payment.class);
        // ...
    }
}

/**
 * GOOD: shared singleton ObjectMapper (thread-safe)
 */
@RestController
public class GoodPaymentController {
    private final ObjectMapper mapper;  // injected singleton

    @PostMapping("/payments")
    public String authorize(@RequestBody String body) throws Exception {
        Payment payment = mapper.readValue(body, Payment.class);  // 0.1ms
        // ...
    }
}

// Flame graph signature of the BAD pattern:
// ObjectMapper.<init> [████████████]  ← wide frame under every request
// plus BeanDeserializerFactory / introspection frames that never go away,
// because every new mapper must rebuild its (de)serializers
```

```java
/**
 * Pattern 2: String concatenation in loops
 * BAD: creates a new, ever longer String on every iteration --
 * O(n) objects and O(n²) bytes copied
 */
public String buildAuditLog(List<Transaction> transactions) {
    String log = "";
    for (Transaction tx : transactions) {
        log = log + tx.getId() + "," + tx.getAmount() + "\n";  // BAD
    }
    return log;
}

/**
 * GOOD: StringBuilder
 */
public String buildAuditLog(List<Transaction> transactions) {
    StringBuilder sb = new StringBuilder(transactions.size() * 50);
    for (Transaction tx : transactions) {
        sb.append(tx.getId()).append(',').append(tx.getAmount()).append('\n');
    }
    return sb.toString();
}

// Allocation flame graph signature of the BAD pattern:
// buildAuditLog [████████████████]
//   string concatenation helpers (StringConcatHelper on Java 9+) [████████]
//     byte[] allocations  ← a larger copy on every iteration
```

```java
/**
 * Pattern 3: Excessive logging with string interpolation
 * BAD: string formatted even when log level is disabled
 */
public void processPayment(Payment p) {
    log.debug("Processing payment: " + p.getId() +
        " amount=" + p.getAmount() + " account=" + p.getAccountId());  // BAD
    // Even at INFO level, string is built before log.debug checks level
}

/**
 * GOOD: parameterised logging -- the message is only formatted if DEBUG is
 * enabled (the argument expressions themselves still run). For expensive
 * arguments, use the SLF4J 2 fluent API with a Supplier, or check
 * log.isDebugEnabled() first.
 */
public void processPayment(Payment p) {
    log.debug("Processing payment: {} amount={} account={}",
        p.getId(), p.getAmount(), p.getAccountId());  // GOOD: formatted only if DEBUG
}

// Allocation flame graph signature of BAD:
// String.concat [████████]
//   StringBuilder.append [████]  ← log message built for every transaction
```

## قائمة فحص مخططات اللهب للتحقيق في خدمة دفع

```
When CPU is high (>70% utilisation):
  1. Generate CPU flame graph: asprof -d 30 -e cpu -f cpu.html <pid>
  2. Look for wide plateaus at the top — these are hotspots
  3. Check for: JSON parsing, regex, String operations, reflection
  4. Compare with known-good baseline using differential flame graph

When GC pressure is high (>5% time in GC):
  1. Generate allocation flame graph: asprof -d 30 -e alloc -f alloc.html <pid>
  2. Look for wide allocation sites — these create garbage
  3. Check for: temporary objects in hot loops, String concatenation, boxing
  4. Use primitives (avoid boxing), pre-size collections, and reuse objects
     only where measured -- object pooling rarely pays off on modern GCs

When latency is high but CPU is low (<20%):
  1. Generate wall-clock flame graph: asprof -d 30 -e wall -t -f wall.html <pid>
  2. Look for thread pool threads all blocked in the same IO call
  3. Check for: connection pool exhaustion, slow downstream services
  4. Correlate with thread pool queue depth metrics
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "في مخطط لهب للمعالج، ماذا تدل هضبة عريضة مسطحة قرب أعلى المكدس؟",
      "options": [
        "دالة تُستدعى كثيرًا لكنها تكتمل بسرعة — معدل استدعاء مرتفع، وكلفة منخفضة لكل استدعاء",
        "دالة تقضي جزءًا كبيرًا من وقت المعالج — إما لأنها تُستدعى كثيرًا جدًا أو لأنها مكلفة لكل استدعاء؛ وهي هدف التحسين الأساسي",
        "توقف GC استهلك وقت المعالج أثناء نافذة التوصيف",
        "دالة ضمّنها مترجم JIT فهي غير مرئية في التنفيذ الفعلي"
      ],
      "correct": 1,
      "explanation": "في مخطط اللهب، يمثل العرض نسبة العينات التي كانت فيها الدالة على مكدس الاستدعاء. والهضبة العريضة قرب الأعلى (حيث المكدس أعمق، أي المستدعى الأكثر تحديدًا) تدل على دالة استهلكت حصة كبيرة من وقت المعالج. وهذه هي النقطة الساخنة التي يجب التحقيق فيها للتحسين."
    },
    {
      "text": "متى يجب استخدام مخطط لهب للوقت الفعلي بدل مخطط لهب للمعالج لتشخيص زمن خدمة دفع؟",
      "options": [
        "مخططات الوقت الفعلي مفضلة دائمًا؛ ومخططات المعالج تُستخدم فقط لتحليل GC",
        "حين يكون استخدام المعالج منخفضًا (< 30%) لكن زمن P99 مرتفعًا — فالخيوط تنتظر الإدخال/الإخراج، أو ردود قاعدة البيانات، أو طوابير مجمع الخيوط بدل استهلاك المعالج؛ ووضع الوقت الفعلي يلتقط الخيوط المحجوبة",
        "مخططات الوقت الفعلي تُستخدم فقط لتوصيف المهام الدفعية، لا الخدمات الفورية",
        "وضع الوقت الفعلي يتطلب صلاحيات الجذر في Linux وغير متاح في البيئات المحوّاة"
      ],
      "correct": 1,
      "explanation": "مخططات لهب المعالج لا تلتقط إلا الخيوط التي تعمل فعليًا على نواة معالج. فالخيط المنتظر اتصال قاعدة بيانات أو المحجوب على طابور ممتلئ لا يستخدم المعالج وهو غير مرئي. أما وضع الوقت الفعلي (-e wall) فيأخذ عينات كل الخيوط بما فيها المحجوبة، فهو أساسي لتشخيص الزمن الناتج عن الإدخال/الإخراج أو التنازع أو تجويع الخيوط بدل المسارات الساخنة المقيدة بالمعالج."
    },
    {
      "text": "لماذا يظهر ربط النصوص في استدعاء سجل تصحيح مثل log.debug('Processing: ' + payment.getId()) كنقطة ساخنة في مخطط لهب التخصيص؟",
      "options": [
        "العامل + يطلق التغليف التلقائي لكائن الدفع إلى String",
        "ربط النصوص يخصص كائن String جديدًا في كل استدعاء بغض النظر عن تفعيل سجل DEBUG، فيخلق قمامة تساهم في ضغط GC على المسارات الساخنة",
        "لا يستطيع JIT تضمين ربط النصوص، فيجعله مكلفًا بشكل غير عادي",
        "log.debug يقيّم معاملاته دائمًا عند مستوى INFO أيضًا، فتتضاعف كلفة التخصيص"
      ],
      "correct": 1,
      "explanation": "في Java، يبني 'Processing: ' + payment.getId() النص المربوط قبل استدعاء log.debug(). فحتى لو لم يكن مستوى DEBUG مفعّلًا، يُخصص النص. وعند 5000 معاملة في الثانية، يخلق هذا 5000 كائن String قصير العمر في الثانية تساهم في ضغط GC على الجيل الشاب. والإصلاح بالتسجيل بالمعاملات: log.debug('Processing: {}', payment.getId()) — فلا يُبنى النص إلا إذا كان المستوى مفعّلًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "التحقيق بمخططات اللهب في خدمة دفع عالية استهلاك المعالج",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "اكتب أوامر asprof لتوليد ثلاثة مخططات لهب في الوقت نفسه لخدمة دفع قيد التشغيل: توصيف المعالج (-e cpu)، وتوصيف التخصيص (-e alloc)، وتوصيف الوقت الفعلي (-e wall -t)، كل منها لمدة 60 ثانية بمخرجات HTML."},
    {"id": "2", "description": "لمخطط لهب معالج يُظهر ObjectMapper.writeValueAsBytes يأخذ 38% من المعالج في مسار تسلسل دفع، اكتب صنف OptimisedPaymentSerializer باستخدام نسخ ObjectWriter وObjectReader محسوبة مسبقًا لإزالة تحليل النوع لكل استدعاء."},
    {"id": "3", "description": "اكتب صنف DifferentialFlameGraphComparator يقارن ملفي مكدسات مطوية من async-profiler (قبل/بعد تغيير في الشيفرة) ويُبلغ عن أعلى 10 دوال في زيادة استخدام المعالج ونقصانه."},
    {"id": "4", "description": "أنشئ وثيقة دليل تشغيل للتوصيف في الإنتاج (كتعليقات شيفرة في صنف ProfilingRunbook.java) تسرد الإجراء خطوة بخطوة لربط async-profiler بأمان بخدمة دفع إنتاجية، بما فيها الضمانات وخطوات التراجع."}
  ]
}
-->
