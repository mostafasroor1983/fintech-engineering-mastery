---
id: "track-07-lesson-05"
title: "تحليل استهلاك المعالج — إيجاد الدوال الساخنة بـ async-profiler"
track: "track-07"
track-name: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 5
slug: "cpu-profiling"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-07-lesson-04"]

tags:
  - "CPU-profiling"
  - "async-profiler"
  - "flame-graph"
  - "JFR"
  - "hot-method"

java-versions: [17, 21]

topics:
  - "async-profiler Usage"
  - "CPU Mode Profiling"
  - "Flame Graph Generation"
  - "Reading Flame Graphs"
  - "JFR CPU Events"
  - "Profiling Payment Processing Under Load"
  - "Serialisation Hot Spots"
  - "Reflection Overhead"
  - "JIT Effects on Profiling"

components:
  mermaid: false
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "async-profiler — github.com/async-profiler/async-profiler"
  - "Brendan Gregg — Flame Graphs — brendangregg.com/flamegraphs"
  - "Java Flight Recorder — docs.oracle.com"
  - "Nitsan Wakart — JVM Profiling Pitfalls (blog)"
---

## نظرة عامة

مراجعة الشيفرة ومقاييس JMH تخبرك بما هو سريع بمعزل عن غيره. أما توصيف المعالج (CPU profiling) فيخبرك بما يستهلك المعالج فعلًا في الإنتاج تحت حمل حقيقي. وكثيرًا ما تختلف الإجابتان تمامًا.

دالة تسلسل مدفوعات تُقاس بميكروثانيتين لكل استدعاء قد تكون مسؤولة عن 40% من وقت المعالج في الإنتاج لأنها تُستدعى 200 مليون مرة يوميًا. وفحص احتيال يستغرق 10 مللي ثانية لكل استدعاء قد يهيمن على ملف الزمن لأنه على المسار الحرج لكل تفويض. ودون موصّف مرتبط بخدمة حية أو مختبرة بالحمل، أنت تحسّن الشيء الخطأ.

يغطي هذا الدرس **async-profiler** — موصّف المعالج الحديث لـ JVM الآمن للإنتاج منخفض الحمل — و**Java Flight Recorder ‏(JFR)**، بنية التوصيف والمراقبة المدمجة. وستتعلم توليد مخططات اللهب (flame graphs)، وقراءتها بشكل صحيح، والتصرف بناءً على ما تكشفه لأحمال معالجة الدفع.

> [!NOTE]
> يقاطع async-profiler الخيوط بمؤقتات نظام التشغيل أو `perf_events` ‏(Linux) ويمشي مكدس Java بـ `AsyncGetCallTrace` من HotSpot (أو بماشي مكدس خاص به)، فيأخذ العينات دون انحياز نقاط الأمان (safepoint bias) الذي يجعل موصّفات JVMTI التقليدية مضللة. وهذا حاسم لتحديد الدوال الساخنة بدقة.

## أهداف التعلم

بنهاية هذا الدرس ستكون قادرًا على:

- ربط async-profiler بعملية JVM قيد التشغيل وجمع عينات المعالج
- توليد مخططات اللهب وتفسيرها
- استخدام JFR للتوصيف المستمر في الإنتاج بأقل حمل
- تحديد النقاط الساخنة في التسلسل، وحمل الانعكاس (reflection)، وإلغاء تحسين JIT
- توصيف خدمة معالجة دفع تحت حمل واقعي
- تجنب مزالق التوصيف الشائعة (انحياز نقاط الأمان، وتوصيف حالة JVM غير الإنتاجية)

## 1. مشكلة انحياز نقاط الأمان

موصّفات أخذ العينات التقليدية المبنية على تفريغ مكدسات JVMTI (مثل موصّف العينات الكلاسيكي في VisualVM، أو الموصّفات التجارية الأقدم في وضع العينات الافتراضي) تأخذ عيناتها عند **نقاط الأمان (safepoints)** — نقاط يستطيع فيها JVM فحص حالة الخيط بأمان. وهذا يخلق انحيازًا منهجيًا: فالشيفرة بين نقاط الأمان (الحلقات الطويلة، والاستدعاءات الأصلية) ممثلة بأقل من حجمها لأن الموصّف لا يستطيع أخذ عينة هناك.

```
Traditional profiler sampling:
  Thread state: ... [busy in tight loop, no safepoints] ... [safepoint] ... [safepoint] ...
  Samples taken:                                                    ^              ^
  
  Result: tight loops appear fast; safepoint-reaching code appears slow
  WRONG: the loop is actually the bottleneck
```

يستخدم async-profiler إشارات على مستوى نظام التشغيل (من `perf_events` أو مؤقتات الفترات) بالإضافة إلى `AsyncGetCallTrace` لأخذ العينات على فترات اعتباطية من الوقت الفعلي أو وقت المعالج، مستقلة عن نقاط الأمان. وهذا يزيل الانحياز.

**متى يهم انحياز نقاط الأمان لخدمات الدفع:**
- حلقات إلغاء التسلسل الضيقة (قراءة حقول ثابتة العرض من مصفوفات البايت)
- حساب التجزئة (Murmur، وSHA256) في المسارات الساخنة
- حساب BigDecimal على مجموعات بيانات كبيرة
- حلقات خط إدخال/إخراج Netty

## 2. تثبيت async-profiler وربطه

```bash
# Download async-profiler (Linux x64)
curl -L -o async-profiler.tar.gz \
  https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar -xzf async-profiler.tar.gz
cd async-profiler-3.0-linux-x64

# Find your JVM process ID
jps -l
# Output:
# 12345 com.example.payment.PaymentAuthService

# Attach to running JVM and collect 30 seconds of CPU samples
./asprof -d 30 -f /tmp/payment-cpu.html 12345

# The output format follows the file extension (.html = interactive flame
# graph, .jfr = JFR file for JDK Mission Control). Use -o for others:
./asprof -d 30 -o collapsed -f /tmp/payment-cpu.txt 12345   # collapsed stacks
./asprof -d 30 -f /tmp/payment-cpu.jfr 12345
```

### 2.1 أوضاع التوصيف

```bash
# CPU mode (default): samples CPU time (threads on-CPU)
./asprof -e cpu -d 30 -f /tmp/cpu.html <pid>

# Wall-clock mode: samples wall time (includes threads blocked on I/O)
./asprof -e wall -d 30 -f /tmp/wall.html <pid>

# Allocation mode: samples object allocations (for memory analysis)
./asprof -e alloc -d 30 -f /tmp/alloc.html <pid>

# Lock mode: samples lock contention
./asprof -e lock -d 30 -f /tmp/lock.html <pid>
```

لتشخيص خدمة الدفع:
- **وضع cpu**: اعثر على ما يستهلك المعالج (التسلسل، والحساب)
- **وضع wall**: اعثر على ما يحجب (الإدخال/الإخراج، وقاعدة البيانات، والاستدعاءات الخارجية)
- **وضع alloc**: اعثر على مصادر ضغط GC

### 2.2 الترشيح والدقة

```bash
# Increase sampling frequency (default: 10 ms)
./asprof -e cpu -i 1ms -d 30 -f /tmp/cpu.html <pid>

# Split the flame graph by thread (thread name becomes the bottom frame)
./asprof -e cpu -d 30 -t -f /tmp/cpu.html <pid>

# Keep only stacks that contain a matching frame
./asprof -e cpu -d 30 --include '*PaymentAuthorisationService*' -f /tmp/cpu.html <pid>

# Native and kernel frames are included in cpu mode by default;
# --cstack controls how native stacks are walked (fp, dwarf, vm, no)
./asprof -e cpu -d 30 --cstack vm -f /tmp/cpu.html <pid>
```

## 3. قراءة مخططات اللهب

مخطط اللهب تمثيل مرئي هرمي لتتبعات المكدس. كل صندوق إطار مكدس. ويمثل العرض نسبة الوقت المقضي في ذلك الإطار والدوال التي يستدعيها.

```
Reading rules:
  1. Width = time proportion. Wide frames = hot code.
  2. Height = call depth. Top frames = leaf methods (where CPU time is spent).
  3. Left-to-right order is arbitrary (sorted alphabetically by default).
  4. Colour is arbitrary (varies by tool).

Example flame graph (text representation):

[Full width: total CPU time]
+--------------------------------------------------+
|           main thread CPU time                   |  PaymentAuthService
+-------------------------------+------------------+
|  handleAuthorisation (60%)    | other (40%)      |
+------------------+------------+                  |
| validate (25%)   |serialize   |                  |
|                  | (35%)      |                  |
+------+--------+--+--+---------+                  |
|regex |schema  |  |json|jackson|                  |
|(5%)  |valid   |  |map |intern |                  |
|      |(20%)   |  |(5%)|.(30%) |                  |
+------+--------+  +----+---------+                +
```

**ما الذي تبحث عنه:**

1. **هضاب عريضة في الأعلى**: دوال طرفية كثيفة المعالج — الشيفرة الساخنة الفعلية
2. **أبراج عريضة**: دالة بكثير من المستدعَيات العميقة — هدف لإعادة الهيكلة
3. **مكدسات Jackson/الانعكاس**: حمل التسلسل — عادة مُسلسِل يُنشأ لكل استدعاء؛ شارك ObjectMapper واحدًا مُعدًّا مسبقًا، أو فكّر في مُسلسِلات بديلة
4. **مكدسات `jdk.internal.reflect` / `DirectMethodHandleAccessor`** (في JDK الأقدم: `sun.reflect`): انعكاس في مسار ساخن — استبدله باستدعاءات مباشرة
5. **الإطارات المفسَّرة** (يرسمها async-profiler بلون خاص؛ وفي المخرجات المطوية تنتهي بـ `_[i]`): شيفرة لم يترجمها JIT بعد — تدل على شيفرة باردة أو إلغاء تحسين

## 4. توليد مخططات اللهب برمجيًا

```java
// AsyncProfilerController.java
// Integrates async-profiler with Spring Boot for on-demand profiling.
// SECURITY: this endpoint runs native code in your JVM -- expose it only
// on an internal management port, behind authentication.

import one.profiler.AsyncProfiler;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
@RequestMapping("/internal/profiler")
public class AsyncProfilerController {

    // Loads libasyncProfiler.so; pass its path if it is not on java.library.path
    private static final AsyncProfiler profiler =
        AsyncProfiler.getInstance("/opt/async-profiler/lib/libasyncProfiler.so");
    private final AtomicBoolean profiling = new AtomicBoolean(false);

    /** Start CPU profiling for N seconds (both inputs validated). */
    @PostMapping("/cpu/start")
    public String startCpuProfile(@RequestParam(defaultValue = "30") int durationSeconds,
                                  @RequestParam(defaultValue = "1000") int intervalMicros)
            throws IOException {

        // Never build the command from raw strings: "interval=1ms,file=/etc/x"
        // would let a caller write arbitrary files
        if (durationSeconds < 1 || durationSeconds > 300
                || intervalMicros < 100 || intervalMicros > 100_000) {
            throw new IllegalArgumentException("duration 1-300 s, interval 100-100000 us");
        }
        if (!profiling.compareAndSet(false, true)) {
            return "Profiling already in progress";
        }

        Path outputFile = Path.of("/var/tmp/profiles/profile-" + System.currentTimeMillis() + ".html");
        long intervalNs = intervalMicros * 1_000L;
        profiler.execute("start,event=cpu,interval=" + intervalNs);

        // Stop after the duration (virtual thread: cheap to park)
        Thread.startVirtualThread(() -> {
            try {
                Thread.sleep(durationSeconds * 1000L);
                stopAndDump(outputFile);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });

        return "Profiling started. Output: " + outputFile;
    }

    @PostMapping("/cpu/stop")
    public String stopProfile() {
        Path outputFile = Path.of("/var/tmp/profiles/profile-" + System.currentTimeMillis() + ".html");
        return stopAndDump(outputFile) ? "Profiling stopped: " + outputFile : "Not profiling";
    }

    @GetMapping("/status")
    public String status() {
        return profiling.get() ? "profiling" : "idle";
    }

    private boolean stopAndDump(Path outputFile) {
        if (!profiling.compareAndSet(true, false)) {
            return false;                       // already stopped by the other path
        }
        try {
            profiler.execute("stop,file=" + outputFile);   // writes the flame graph
            return true;
        } catch (IOException e) {
            throw new IllegalStateException("Could not write profile", e);
        }
    }
}
```

## 5. ‏JFR — مسجّل رحلة Java

‏JFR مدمج في JDK (مفتوح المصدر ومجاني الاستخدام منذ JDK 11، وفي OpenJDK 8u262+) ويوفر توصيفًا ومراقبة مستمرين منخفضي الحمل. ويسجّل مئات أنواع الأحداث: GC، والترجمة، وتحميل الأصناف، وإدخال/إخراج الملفات، وإدخال/إخراج المقابس، والاستثناءات، وعينات المعالج.

### 5.1 بدء JFR

```bash
# Start JFR recording via jcmd (attach to running process)
jcmd <pid> JFR.start name=payment-profile duration=60s \
  settings=profile \
  filename=/tmp/payment.jfr

# Start at JVM startup
java -XX:StartFlightRecording=duration=60s,filename=/tmp/startup.jfr,settings=profile \
  -jar payment-service.jar

# Start continuous recording (circular buffer, dumps on demand).
# Use the 'default' settings for always-on recording (~1% overhead);
# 'profile' collects more detail and costs more.
java -XX:StartFlightRecording=name=continuous,maxage=10m,maxsize=250m,settings=default \
  -jar payment-service.jar

# Dump the continuous recording
jcmd <pid> JFR.dump name=continuous filename=/tmp/on-demand-dump.jfr
```

### 5.2 أحداث JFR في الشيفرة

```java
// PaymentProcessingWithJfr.java
// Custom JFR events for payment-specific telemetry

import jdk.jfr.*;

@Name("com.example.payment.AuthorisationEvent")
@Label("Payment Authorisation")
@Description("Tracks individual payment authorisation requests")
@Category({"Payment", "Performance"})
public class AuthorisationEvent extends Event {

    @Label("Payment ID")
    public String paymentId;

    @Label("Amount (cents)")
    public long amountCents;

    @Label("Currency")
    public String currency;

    @Label("Validation Result")
    public boolean validationPassed;

    @Label("Fraud Score")
    public double fraudScore;
}

@Service
public class PaymentAuthorisationService {

    public AuthorisationResult authorise(PaymentRequest request) {
        AuthorisationEvent event = new AuthorisationEvent();
        event.begin();  // Start timing

        try {
            event.paymentId = request.getId();
            event.amountCents = request.getAmountCents();
            event.currency = request.getCurrency();

            ValidationResult validation = validator.validate(request);
            event.validationPassed = validation.isPassed();

            if (!validation.isPassed()) {
                return AuthorisationResult.declined(validation.getReason());
            }

            RiskScore risk = riskEngine.score(request);
            event.fraudScore = risk.getScore();

            if (risk.getScore() > FRAUD_THRESHOLD) {
                return AuthorisationResult.declined("FRAUD_RISK");
            }

            return AuthorisationResult.approved(generateApprovalCode());

        } finally {
            event.commit();  // Record the event with duration
        }
    }
}
```

### 5.3 تحليل تسجيلات JFR

```bash
# View JFR recording summary
jfr summary /tmp/payment.jfr

# Print specific events (CPU samples are "jdk.ExecutionSample")
jfr print --events jdk.ExecutionSample /tmp/payment.jfr | head -100

# Print custom events
jfr print --events com.example.payment.AuthorisationEvent /tmp/payment.jfr

# Open in JDK Mission Control (GUI)
jmc /tmp/payment.jfr
```

## 6. توصيف معالجة الدفع تحت الحمل

أثمن التوصيف هو ما يُجرى تحت حمل إنتاج واقعي. وإليك نهجًا منهجيًا:

### 6.1 إعداد توليد الحمل

فضّل أداة حمل خارجية (Gatling، وk6 — انظر الدرس 16): فمولّد الحمل داخل JVM المُوصَّف يظهر في التوصيف وينافس على المعالج نفسه. ولتجربة سريعة داخل العملية، يبدو مولّد بسيط هكذا:

```java
// PaymentLoadGenerator.java
// Generates realistic payment load for profiling sessions

@Component
public class PaymentLoadGenerator {

    private final PaymentAuthorisationService authService;
    private final ExecutorService executor;
    private static final Logger log = LoggerFactory.getLogger(PaymentLoadGenerator.class);

    public PaymentLoadGenerator(PaymentAuthorisationService authService) {
        this.authService = authService;
        // Use virtual threads for high-concurrency load generation
        this.executor = Executors.newVirtualThreadPerTaskExecutor();
    }

    public LoadStats generateLoad(int targetTps, Duration duration) throws InterruptedException {
        long endTime = System.currentTimeMillis() + duration.toMillis();
        long intervalNs = 1_000_000_000L / targetTps;

        AtomicLong successCount = new AtomicLong(0);
        AtomicLong errorCount = new AtomicLong(0);
        // HdrHistogram: constant memory, thread-safe recording.
        // (A CopyOnWriteArrayList would copy the whole list on EVERY add.)
        ConcurrentHistogram latenciesNs = new ConcurrentHistogram(3);

        while (System.currentTimeMillis() < endTime) {
            long start = System.nanoTime();

            executor.submit(() -> {
                long reqStart = System.nanoTime();
                try {
                    PaymentRequest req = generateRealisticRequest();
                    authService.authorise(req);
                    successCount.incrementAndGet();
                    latenciesNs.recordValue(System.nanoTime() - reqStart);
                } catch (Exception e) {
                    errorCount.incrementAndGet();
                    log.debug("Load gen error: {}", e.getMessage());
                }
            });

            // Rate limiting
            long elapsed = System.nanoTime() - start;
            long sleepNs = intervalNs - elapsed;
            if (sleepNs > 10_000) {  // only sleep if > 10 microseconds
                LockSupport.parkNanos(sleepNs);
            }
        }

        return new LoadStats(successCount.get(), errorCount.get(), latenciesNs);
    }

    private PaymentRequest generateRealisticRequest() {
        // Mix of transaction types reflecting real-world distribution
        ThreadLocalRandom rng = ThreadLocalRandom.current();
        double amount = Math.round(rng.nextDouble() * 500 * 100.0) / 100.0;

        return PaymentRequest.builder()
            .id("PAY-" + UUID.randomUUID())
            .amount(BigDecimal.valueOf(amount))
            .currency(CURRENCIES[rng.nextInt(CURRENCIES.length)])
            .debtorAccount("ACC-" + rng.nextInt(10_000))
            .creditorAccount("ACC-" + rng.nextInt(10_000))
            .build();
    }

    private static final String[] CURRENCIES = {"USD", "EUR", "GBP", "JPY", "CHF"};
}
```

### 6.2 تحديد النقاط الساخنة في التسلسل

اكتشاف شائع عند توصيف خدمات الدفع: Jackson يستهلك حصة كبيرة من المعالج. تفصيل توضيحي لمخطط اللهب:

```
PaymentAuthorisationService.authorise (100%)
  |- PaymentSerializer.serialize (38%)
  |    |- ObjectMapper.writeValueAsBytes (38%)
  |         |- SerializerProvider.serializeValue (35%)
  |              |- BeanSerializer.serialize (30%)
  |                   |- AnnotationIntrospector.findSerializer (12%)
  |                        |- ReflectionUtils.getDeclaredFields (8%)
  |- FraudEngine.score (25%)
  |- DatabaseRepository.save (22%)
  |- Other (15%)
```

يخزّن Jackson المُسلسِل لكل نوع *داخل ObjectMapper*. فإذا بقيت إطارات الاستبطان (`AnnotationIntrospector`، و`getDeclaredFields`) ساخنة بعد الإحماء، فالسبب المعتاد هو **إنشاء ObjectMapper جديد لكل استدعاء أو لكل طلب**، فيعيد كل استدعاء عمل الانعكاس. والإصلاح: مُسلسِل واحد مشترك مُعدّ مسبقًا، مع كاتب/قارئ مبني مسبقًا لكل نوع:

```java
// OptimisedPaymentSerializer.java

@Component
public class OptimisedPaymentSerializer {

    private final ObjectMapper mapper;
    // Pre-built writer -- skips the per-call root type lookup
    private final ObjectWriter paymentWriter;
    private final ObjectReader paymentReader;

    public OptimisedPaymentSerializer() {
        // ONE mapper for the whole application -- it is thread-safe once configured
        this.mapper = JsonMapper.builder()
            .addModule(new JavaTimeModule())
            .addModule(new BlackbirdModule())  // optional: replaces reflection with generated accessors
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .build();

        // Pre-build typed writers/readers
        this.paymentWriter = mapper.writerFor(PaymentMessage.class);
        this.paymentReader = mapper.readerFor(PaymentMessage.class);
    }

    public byte[] serialize(PaymentMessage message) throws JsonProcessingException {
        // Uses pre-computed serialiser -- no type lookup
        return paymentWriter.writeValueAsBytes(message);
    }

    public PaymentMessage deserialize(byte[] bytes) throws IOException {
        // Uses pre-computed deserialiser
        return paymentReader.readValue(bytes);
    }
}
```

### 6.3 تحديد حمل الانعكاس

```java
// BEFORE: reflection-heavy approach (shows up as jdk.internal.reflect frames)
public class ReflectionHeavyValidator {

    private final Map<String, Method> validatorMethods = new HashMap<>();

    public ValidationResult validate(PaymentRequest request) throws Exception {
        for (Field field : request.getClass().getDeclaredFields()) {
            String validatorName = "validate" + capitalise(field.getName());
            Method method = validatorMethods.computeIfAbsent(
                validatorName,
                name -> {
                    try {
                        return this.getClass().getDeclaredMethod(name, field.getType());
                    } catch (NoSuchMethodException e) {
                        return null;
                    }
                }
            );
            if (method != null) {
                field.setAccessible(true);  // reflection -- expensive
                method.invoke(this, field.get(request));  // reflective call
            }
        }
        return ValidationResult.passed();
    }
}

// AFTER: direct method calls (JIT-inlinable, no reflection cost)
public class DirectValidator {

    public ValidationResult validate(PaymentRequest request) {
        List<String> errors = new ArrayList<>();

        validateAmount(request.getAmount(), errors);
        validateCurrency(request.getCurrency(), errors);
        validateAccountId(request.getDebtorAccount(), errors);
        validateAccountId(request.getCreditorAccount(), errors);

        return errors.isEmpty()
            ? ValidationResult.passed()
            : ValidationResult.failed(errors);
    }

    private void validateAmount(BigDecimal amount, List<String> errors) {
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            errors.add("Amount must be positive");
        }
        if (amount != null && amount.scale() > 2) {
            errors.add("Amount must have at most 2 decimal places");
        }
    }

    private void validateCurrency(String currency, List<String> errors) {
        if (currency == null || currency.length() != 3) {
            errors.add("Currency must be a 3-character ISO 4217 code");
        }
    }

    private void validateAccountId(String accountId, List<String> errors) {
        if (accountId == null || accountId.isBlank()) {
            errors.add("Account ID must not be blank");
        }
    }
}
```

## 7. آثار ترجمة JIT على التوصيف

يمكن لمترجم JIT أن ينتج نتائج توصيف مضللة بعدة طرق:

### 7.1 الدوال المُضمَّنة (Inlined)

حين يضمّن JIT دالة، لا يعود لها إطار خاص بها في شيفرة الآلة. والموصّفات الجيدة لـ JVM ‏(async-profiler، وJFR) تعيد بناء الإطارات المضمنة من معلومات التصحيح في JIT، فتظهر الدالة مع ذلك — بل يلوّن async-profiler الإطارات المضمنة بلون مختلف. أما الأدوات التي لا ترى إلا شيفرة الآلة (‏`perf` العادي دون خريطة رموز JIT، وبعض وكلاء APM) فتنسب الوقت إلى المستدعي بدلًا من ذلك.

```java
// PaymentFeeCalculator.java -- frequently inlined methods

public class PaymentFeeCalculator {

    // Small and hot: the JIT will inline it into its callers.
    // async-profiler still shows it (as an inlined frame); a profiler that
    // only sees machine code would charge its time to the caller.
    public long calculateFee(long amountCents, int basisPoints) {
        return (amountCents * basisPoints + 5000) / 10_000;  // round half-up
    }

    // This method is too large to inline -- it WILL appear in flame graphs
    public FeeBreakdown calculateFullFeeBreakdown(PaymentRequest request) {
        long baseFee = calculateFee(request.getAmountCents(), 25);
        long networkFee = calculateNetworkFee(request);
        long regulatoryFee = calculateRegulatoryFee(request);
        // ... 50+ more lines
        return new FeeBreakdown(baseFee, networkFee, regulatoryFee);
    }
}
```

**التبعة**: إذا بدت دالة بسيطة ساخنة في أداة لا ترى الإطارات المضمنة، فقد يكون العمل الحقيقي في مستدعَيات مضمنة فيها. وتذكّر أيضًا أن التضمين يتيح لـ JIT التحسين عبر حدود الدوال، فقد تتغير كلفة دالة بحسب المكان الذي تُضمَّن فيه.

### 7.2 أحداث إلغاء التحسين

يجعل إلغاء تحسين JIT الشيفرة ترجع إلى الوضع المفسَّر مؤقتًا. ويظهر ذلك في مخططات اللهب كإطارات `Interpreter` ويزيد استخدام المعالج كثيرًا:

```bash
# Check for deoptimisation events in JFR
jfr print --events Deoptimization /tmp/payment.jfr | head -50

# Simplified example of a problematic pattern:
# com.example.payment.PaymentValidator.validate()
#   reason: class_check   -- a call site the JIT compiled for ONE type
#                            started receiving a second type
#   reason: unstable_if   -- a branch never taken during profiling was taken
#   Each one throws away compiled code and recompiles -- costly under load
```

بضع عمليات إلغاء تحسين بعد الإحماء أمر طبيعي. أما **المتكررة** للدالة نفسها فهي المشكلة. والإصلاحات المعتادة: أحمِ بحركة واقعية (كي تُرى الفروع النادرة وكل الأنواع الشائعة قبل الترجمة)، وأبقِ مواضع الاستدعاء الساخنة أحادية الشكل — مثلًا تجنب تمرير أصناف تنفيذ كثيرة مختلفة عبر استدعاء واجهة ساخن واحد. والتعليقات مثل `@NonNull` **لا** تغيّر ما يفعله JIT.

## 8. التوصيف تحت الحمل — سكربت عملي

```bash
#!/usr/bin/env bash
# profile-payment-service.sh
# Attaches async-profiler to a running payment service under load

set -euo pipefail

SERVICE_NAME="payment-auth-service"
DURATION=${1:-60}  # seconds, default 60
OUTPUT_DIR="/tmp/profiles"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$OUTPUT_DIR"

# Find PID
PID=$(jps -l | grep "$SERVICE_NAME" | awk '{print $1}' | head -n1)
if [ -z "$PID" ]; then
    echo "ERROR: $SERVICE_NAME not found"
    exit 1
fi

echo "Profiling PID $PID for ${DURATION}s..."

# Collect CPU and allocation samples in ONE run (same time window), as JFR
./asprof -d "$DURATION" \
  -e cpu -i 1ms \
  --alloc 512k \
  -f "$OUTPUT_DIR/profile-${TIMESTAMP}.jfr" \
  "$PID"

# Convert to separate flame graphs (jfrconv ships with async-profiler)
./jfrconv --cpu   "$OUTPUT_DIR/profile-${TIMESTAMP}.jfr" "$OUTPUT_DIR/cpu-${TIMESTAMP}.html"
./jfrconv --alloc "$OUTPUT_DIR/profile-${TIMESTAMP}.jfr" "$OUTPUT_DIR/alloc-${TIMESTAMP}.html"

echo "CPU profile:        $OUTPUT_DIR/cpu-${TIMESTAMP}.html"
echo "Allocation profile: $OUTPUT_DIR/alloc-${TIMESTAMP}.html"
echo "Raw recording (JDK Mission Control): $OUTPUT_DIR/profile-${TIMESTAMP}.jfr"
echo "Done. Open the HTML files in a browser."
```

## 9. قائمة فحص الإنتاج

قبل توصيف خدمة دفع وبعده:

- [ ] وصّف تحت حمل إنتاج واقعي (لا JVM خاملًا — فحالة JIT مختلفة)
- [ ] استخدم `-e cpu` لتشخيص ما هو مقيد بالمعالج، و`-e wall` لتشخيص الزمن/الحجب
- [ ] شغّل 30 ثانية على الأقل للحصول على عينات ذات دلالة إحصائية
- [ ] عند توصيف مقياس JMH، استخدم `-prof async` من JMH (يربط async-profiler بكل JVM مُفرَّع)
- [ ] ابحث عن إطارات `Interpreter` في مخطط اللهب — تدل على إلغاء التحسين
- [ ] ابحث عن إطارات `jdk.internal.reflect` / `sun.reflect` — تدل على مسارات ساخنة بالانعكاس
- [ ] افحص تخصيصات ObjectMapper في توصيف التخصيص — شائع في خدمات Spring MVC
- [ ] تحقق من تفعيل JFR في الإنتاج بمخزن دائري `maxage=10m` للتشخيص بعد الحدث
- [ ] اربط مخطط لهب المعالج بتوصيف تخصيص GC — فالتخصيص العالي كثيرًا ما يقود استهلاك المعالج

## اختبار المعرفة

1. ما انحياز نقاط الأمان ولماذا يجعل موصّفات JVMTI التقليدية غير موثوقة لتحديد الحلقات الساخنة؟

2. في مخطط لهب للمعالج، ترى `BeanSerializer.serialize` يأخذ 35% من المعالج. ما التغييران اللذان ستجريهما على إعداد Jackson لتقليل هذا الحمل؟

3. توصّف خدمة تفويض دفع فتجد إطارات `Interpreter` في مخطط اللهب تستهلك 15% من المعالج. ماذا يدل هذا وكيف تحقق أكثر؟

4. الفرق بين وضع `-e cpu` ووضع `-e wall` في async-profiler: متى يكون كل منهما مضللًا لخدمة دفع تستدعي واجهة احتيال خارجية؟

5. كيف يؤثر تضمين الدوال في JIT على ما تراه في مخطط اللهب؟ وأي الأدوات تُظهر الدوال المضمنة مع ذلك، وأيها تنسب وقتها إلى المستدعي؟

## التحدي العملي

**الإعداد:** تعالج خدمة تفويض دفع 2,000 معاملة في الثانية. ويلاحظ الفريق استخدام المعالج عند 85% رغم أن الخدمة تبدو "سريعة بما يكفي" في زمن P50. وزمن P99 يبلغ 180 مللي ثانية.

**المهمة:**
1. اكتب أوامر الصدفة لالتقاط مخطط لهب للمعالج وتوصيف تخصيص معًا، بمدة وفترة أخذ عينات مناسبتين
2. اكتب صنف Java باسم `ProfilingSession`:
   - يبدأ async-profiler برمجيًا عبر واجهة Java
   - يطلق توصيفي المعالج والتخصيص لمدة قابلة للضبط
   - يكتب ملفات المخرجات بأسماء تتضمن الطابع الزمني
   - يكشف البدء/الإيقاف عبر نقطة نهاية Spring Boot actuator
3. اذكر أهم 5 أشياء ستبحث عنها في مخططات اللهب الناتجة لخدمة دفع بـ Spring Boot + Jackson + PostgreSQL

**المخرج المتوقع:** سكربت صدفة، وصنف Java، وقائمة فحص للتحليل.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما انحياز نقاط الأمان، ولماذا يجعل الموصّفات التقليدية المبنية على JVMTI غير موثوقة لتحديد الحلقات الساخنة؟",
      "options": [
        "يجعل انحياز نقاط الأمان الموصّف يفرط في أخذ عينات أحداث GC بدل شيفرة التطبيق",
        "موصّفات JVMTI لا تأخذ العينات إلا عند نقاط الأمان؛ فالشيفرة بين نقاط الأمان (الحلقات الضيقة) غير مرئية، فيُبلَّغ عن الحلقات الساخنة بأقل من حجمها",
        "انحياز نقاط الأمان يؤثر على ZGC فقط لا على جلسات التوصيف المبنية على G1GC",
        "موصّفات JVMTI منحازة نحو الدوال المقيدة بالإدخال/الإخراج لأن نقاط الأمان تحدث أثناء الاستدعاءات الحاجبة"
      ],
      "correct": 1,
      "explanation": "الموصّفات التي تأخذ العينات عبر تفريغ مكدسات JVMTI لا تستطيع أخذ العينات إلا عند نقاط أمان JVM. والحلقات الضيقة كثيرًا ما تعمل تكرارات عديدة دون بلوغ نقطة أمان، فيُنسب وقتها إلى موضع نقطة الأمان التالية وتبدو أرخص مما هي. أما async-profiler فيقاطع الخيوط بإشارات نظام التشغيل (perf_events أو المؤقتات) ويمشي المكدس بـ AsyncGetCallTrace في أي نقطة، فيتغلب على انحياز نقاط الأمان."
    },
    {
      "text": "في مخطط لهب للمعالج، تأخذ إطارات BeanSerializer والاستبطان في Jackson ‏35% من المعالج حتى بعد الإحماء. أي تغييرين سيقللان ذلك؟",
      "options": [
        "تفعيل إلغاء التسلسل الكسول وزيادة حجم مجمع الخيوط",
        "مشاركة ObjectMapper واحد مُعدّ مسبقًا بدل إنشاء واحد لكل استدعاء، وبناء نسخ ObjectWriter/ObjectReader مسبقًا لكل نوع عند البدء كي يُعاد استخدام مُسلسِلات Jackson المخزنة",
        "التحول من JSON إلى تسلسل XML واستخدام تعليقات JAXB",
        "إضافة @JsonIgnore لكل الحقول غير الأساسية لتقليل الحجم المُسلسَل"
      ],
      "correct": 1,
      "explanation": "يخزّن Jackson المُسلسِلات لكل ObjectMapper، فالمُسلسِل الذي يُنشأ لكل استدعاء يكرر عمل الانعكاس في كل مرة — وهو السبب المعتاد لبقاء الاستبطان ساخنًا. ومشاركة مُسلسِل واحد مُعدّ وبناء الكتّاب/القرّاء مسبقًا بـ mapper.writerFor(Type.class) يزيل ذلك العمل المتكرر. وإضافة وحدة مثل Blackbird قد تقلل الانعكاس أكثر."
    },
    {
      "text": "ما الفرق الأساسي بين وضع `-e cpu` ووضع `-e wall` في async-profiler لتشخيص خدمة دفع بزمن P99 بطيء؟",
      "options": [
        "وضع cpu يأخذ عينات كل الخيوط؛ ووضع wall يأخذ عينات الخيط الرئيسي فقط",
        "وضع cpu يُظهر الوقت المقضي على المعالج (ويفوّت انتظار الإدخال/الإخراج)؛ ووضع wall يُظهر الوقت الفعلي المنقضي لكل خيط، كاشفًا الاستدعاءات الحاجبة وتجويع مجمع الخيوط",
        "وضع cpu يتطلب صلاحيات الجذر؛ ووضع wall يعمل كمستخدم التطبيق",
        "وضع wall متاح على Windows فقط؛ ووضع cpu يعمل على كل المنصات"
      ],
      "correct": 1,
      "explanation": "وضع cpu يستخدم دورات المعالج ولا يلتقط إلا الخيوط التي تعمل فعليًا على نواة معالج. فالخيط المنتظر رد قاعدة بيانات أو المحجوب على مجمع اتصالات ممتلئ لا يستهلك وقت معالج وهو غير مرئي في وضع cpu. أما وضع wall فيأخذ عينات كل الخيوط بما فيها المحجوبة، فهو أساسي لتشخيص الزمن الناتج عن الإدخال/الإخراج أو تنازع الخيوط."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "توصيف المعالج لخدمة تفويض دفع عالية الإنتاجية",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "اكتب أوامر صدفة لالتقاط مخطط لهب للمعالج وتوصيف تخصيص في الوقت نفسه لخدمة دفع قيد التشغيل باستخدام async-profiler، بمدة 60 ثانية وفترة أخذ عينات للمعالج قدرها 1 مللي ثانية."},
    {"id": "2", "description": "نفّذ مكوّن Spring Boot باسم ProfilingSession يبدأ async-profiler برمجيًا عبر واجهة Java، ويلتقط توصيفي cpu وalloc لمدة قابلة للضبط، ويكتب ملفات مخرجات HTML بأسماء تتضمن الطابع الزمني."},
    {"id": "3", "description": "اكشف ProfilingSession كنقطة نهاية Spring Boot Actuator عند /internal/profiler/start و/internal/profiler/stop، مقيدة بالوصول من الشبكة الداخلية فقط."},
    {"id": "4", "description": "اذكر أهم خمسة أنماط يجب التحقيق فيها في مخططات اللهب الناتجة لخدمة دفع بـ Spring Boot + Jackson + PostgreSQL، مرتبة حسب تكرار حدوثها في أنظمة الإنتاج."}
  ]
}
-->
