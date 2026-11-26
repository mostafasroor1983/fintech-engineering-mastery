---
id: "track-07-lesson-04"
title: "قياس الأداء بـ JMH — القياس بالطريقة الصحيحة"
track: "track-07"
track-name: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 4
slug: "jmh-benchmarking"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-07-lesson-03"]

tags:
  - "JMH"
  - "benchmarking"
  - "warm-up"
  - "throughput"
  - "latency"

java-versions: [17, 21]

topics:
  - "JMH Maven Setup"
  - "Benchmark Annotation"
  - "State and Scope"
  - "Warmup and Measurement"
  - "BenchmarkMode"
  - "Parameterised Benchmarks"
  - "Dead Code Elimination Prevention"
  - "JVM Flags for Consistent Results"
  - "Payment Serialisation Benchmark"
  - "BigDecimal vs double Benchmark"

components:
  mermaid: false
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "JMH — Java Microbenchmark Harness — openjdk.org"
  - "Alexey Shipilev — JMH Samples — github.com/openjdk/jmh"
  - "Java Performance — Scott Oaks (2nd ed.)"
  - "Aleksey Shipilev — Nanotrusting Nanotime (blog)"
---

## نظرة عامة

الحدس دليل ضعيف لأداء Java. فمترجم JIT في JVM، ومتنبئ التفرعات في المعالج، والتوازي على مستوى التعليمات، وتسلسل الذاكرة الهرمي تجتمع لتنتج سلوكًا يفاجئ المهندسين ذوي الخبرة باستمرار. فالدالة التي "تبدو سريعة" قد يحذفها JIT بالتضمين. والحلقة التي "تبدو بطيئة" قد تُحوَّل تلقائيًا إلى تعليمات متجهية. ودون قياس، أنت تخمّن.

**JMH ‏(Java Microbenchmark Harness)** هي الأداة التي بناها مهندسو أداء JVM للقياس الصحيح. فهي تتعامل مع إحماء JIT، ومنع حذف الشيفرة الميتة، وتفريع عمليات JVM، والتجميع الإحصائي، وعشرات المزالق الأخرى التي تجعل المقاييس الساذجة غير موثوقة. وفي الخدمات المالية، حيث قد يعني الفرق بين `BigDecimal` و`double` أخطاء دقة في مراكز بمليارات الدولارات، فالقياس الصحيح ليس ترفًا أكاديميًا — بل يحدد أي شيفرة تصل إلى الإنتاج.

> [!NOTE]
> لا تقِس الأداء أبدًا داخل اختبار وحدة أو دالة main(). فالترجمة المتدرجة في JVM تعني أن الشيفرة المقيسة قبل اكتمال ترجمة JIT ستعطي نتائج أبطأ من الإنتاج بـ 10–100 مرة. وJMH يتعامل مع هذا بشكل صحيح؛ والمقاييس المرتجلة لا تفعل.

## أهداف التعلم

بنهاية هذا الدرس ستكون قادرًا على:

- ضبط JMH في مشروع Maven بشكل صحيح
- كتابة مقاييس باستخدام `@Benchmark` و`@State` و`@Warmup` و`@Measurement`
- اختيار `BenchmarkMode` المناسب لهدف القياس
- استخدام `@Param` للقياس عبر أبعاد مدخلات متعددة
- منع حذف الشيفرة الميتة باستخدام `Blackhole` والقيم المُعادة
- تطبيق خيارات JVM تنتج نتائج متسقة وقابلة للتكرار
- قياس تسلسل المدفوعات وحساب `BigDecimal` مقابل `double`

## 1. لماذا تكذب المقاييس العادية

لنأخذ هذا المقياس الساذج:

```java
// WRONG: This tells you nothing useful
public class NaiveBenchmark {
    public static void main(String[] args) {
        long start = System.currentTimeMillis();
        for (int i = 0; i < 1_000_000; i++) {
            processingPayment();
        }
        long elapsed = System.currentTimeMillis() - start;
        System.out.println("Time: " + elapsed + " ms");
    }
}
```

مشكلات هذا النهج:

1. **JIT غير مُحمّى**: التكرارات الأولى تعمل كـ bytecode مُفسَّر (أبطأ من المترجم بنحو 100 مرة)
2. **حذف الشيفرة الميتة**: إذا لم تُستخدم نتيجة `processingPayment()`، فقد يحذف JIT الاستدعاء كليًا
3. **ترجمة OSR**: قد تُترجم الحلقة نفسها بشكل مختلف عن مواضع الاستدعاء في الإنتاج
4. **ضجيج القياس**: دقة `currentTimeMillis()` تعتمد على نظام التشغيل (حتى 15 مللي ثانية على Windows)
5. **تداخل GC**: لا محاولة للتحكم في توقفات GC أو حسابها
6. **JVM واحد**: الحالة المستمرة في JVM من أصناف سابقة تلوّث النتائج

يعالج JMH كل هذه المشكلات.

## 2. إعداد Maven

```xml
<!-- pom.xml -->
<properties>
    <jmh.version>1.37</jmh.version>
    <java.version>21</java.version>
</properties>

<dependencies>
    <!-- JMH core -->
    <dependency>
        <groupId>org.openjdk.jmh</groupId>
        <artifactId>jmh-core</artifactId>
        <version>${jmh.version}</version>
    </dependency>
    <!-- Annotation processor that generates benchmark boilerplate -->
    <dependency>
        <groupId>org.openjdk.jmh</groupId>
        <artifactId>jmh-generator-annprocess</artifactId>
        <version>${jmh.version}</version>
        <scope>provided</scope>
    </dependency>
</dependencies>

<build>
    <plugins>
        <!-- Create a fat JAR with benchmarks for running in isolation -->
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-shade-plugin</artifactId>
            <version>3.5.0</version>
            <executions>
                <execution>
                    <phase>package</phase>
                    <goals><goal>shade</goal></goals>
                    <configuration>
                        <finalName>benchmarks</finalName>
                        <transformers>
                            <transformer implementation=
                                "org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                                <mainClass>org.openjdk.jmh.Main</mainClass>
                            </transformer>
                        </transformers>
                    </configuration>
                </execution>
            </executions>
        </plugin>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-compiler-plugin</artifactId>
            <configuration>
                <source>${java.version}</source>
                <target>${java.version}</target>
                <annotationProcessorPaths>
                    <path>
                        <groupId>org.openjdk.jmh</groupId>
                        <artifactId>jmh-generator-annprocess</artifactId>
                        <version>${jmh.version}</version>
                    </path>
                </annotationProcessorPaths>
            </configuration>
        </plugin>
    </plugins>
</build>
```

تشغيل المقاييس:

```bash
mvn clean package -DskipTests
java -jar target/benchmarks.jar
# Or run a specific benchmark:
java -jar target/benchmarks.jar PaymentSerializationBenchmark
```

## 3. التعليق التوضيحي ‎@Benchmark

يعلّم التعليق `@Benchmark` دالة كنقطة دخول للقياس. ويولّد JMH إطارًا يستدعيها في حلقة ضيقة داخل كل تكرار قياس.

```java
// PaymentHashBenchmark.java

import com.google.common.hash.Hashing;
import org.openjdk.jmh.annotations.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 5, time = 1, timeUnit = TimeUnit.SECONDS)
@Measurement(iterations = 10, time = 1, timeUnit = TimeUnit.SECONDS)
@Fork(2)
@State(Scope.Benchmark)
public class PaymentHashBenchmark {

    private String paymentId;

    @Setup
    public void setup() {
        paymentId = "PAY-20261108-" + "X".repeat(32);
    }

    @Benchmark
    public int hashCode_string() {
        // Careful: String caches its hash code after the first call, so this
        // mostly measures a field read -- a classic "benchmark measures the
        // wrong thing" trap. Returning the value is enough for JMH to consume it.
        return paymentId.hashCode();
    }

    @Benchmark
    public int hashCode_murmur() {
        // Guava's Murmur3: encodes the String and hashes it on every call
        return Hashing.murmur3_32_fixed()
            .hashString(paymentId, StandardCharsets.UTF_8)
            .asInt();
    }
}
```

## 4. ‏@State والنطاق (Scope)

يتحكم `@State` في دورة حياة الكائن ومشاركته بين الخيوط.

```java
// StateScope.java  (each @State class must be public, with a public
// no-arg constructor -- in real code put them in separate files or make
// them public static nested classes of the benchmark)

// Scope.Benchmark: ONE instance shared across all threads (simulates shared singleton)
@State(Scope.Benchmark)
public class SharedPaymentRepository {
    private final Map<String, BigDecimal> balanceCache = new ConcurrentHashMap<>();

    @Setup(Level.Trial)
    public void populateCache() {
        // runs once before all iterations
        for (int i = 0; i < 10_000; i++) {
            balanceCache.put("ACC-" + i, BigDecimal.valueOf(1000.00));
        }
    }
}

// Scope.Thread: ONE instance per thread (simulates thread-local state)
@State(Scope.Thread)
public class ThreadLocalPaymentContext {
    private PaymentRequest request;

    @Setup(Level.Iteration)
    public void setupIteration() {
        // runs before each measurement iteration
        request = PaymentRequest.builder()
            .amount(new BigDecimal("100.00"))
            .currency("USD")
            .build();
    }
}

// Scope.Group: ONE instance per thread group (for multi-threaded benchmarks)
// Used when you want to benchmark producer/consumer patterns
```

### 4.1 مستويات Setup وTearDown

```java
@State(Scope.Thread)
public class LedgerBenchmarkState {

    private Connection dbConnection;
    private PreparedStatement insertStmt;
    private PaymentRequest[] requests;

    @Setup(Level.Trial)
    public void openConnection() throws SQLException {
        // Once per benchmark run -- expensive setup
        dbConnection = DriverManager.getConnection(DB_URL, USER, PASS);
        insertStmt = dbConnection.prepareStatement(
            "INSERT INTO ledger_entries (id, account_id, amount, currency, created_at) " +
            "VALUES (?, ?, ?, ?, ?)"
        );
    }

    @Setup(Level.Iteration)
    public void prepareData() {
        // Once per measurement iteration -- medium setup
        requests = generatePaymentRequests(1000);
    }

    @Setup(Level.Invocation)
    public void resetState() {
        // Before EVERY benchmark method call -- use sparingly, adds overhead
        // OK for benchmarks where state must be pristine per call
    }

    @TearDown(Level.Trial)
    public void closeConnection() throws SQLException {
        if (dbConnection != null) dbConnection.close();
    }
}
```

## 5. ‏BenchmarkMode — اختيار القياس المناسب

```java
// BenchmarkModeExamples.java -- pick ONE per benchmark (or pass several
// in one annotation: @BenchmarkMode({Mode.Throughput, Mode.AverageTime}))

@BenchmarkMode(Mode.Throughput)         // ops/second -- for high-frequency operations
@BenchmarkMode(Mode.AverageTime)        // average time per op -- for latency analysis
@BenchmarkMode(Mode.SampleTime)         // distribution of times -- for P99/P999 analysis
@BenchmarkMode(Mode.SingleShotTime)     // one call per iteration -- cold/startup cost
@BenchmarkMode(Mode.All)                // run all modes
```

**لخدمات الدفع:**

| حالة الاستخدام | الوضع | الوحدة |
|---|---|---|
| إنتاجية المعاملات | `Throughput` | `ops/s` |
| زمن التسلسل | `AverageTime` | `MICROSECONDS` |
| زمن الاستجابة P99 | `SampleTime` | `MICROSECONDS` |
| تفويض البدء البارد | `SingleShotTime` | `MILLISECONDS` |

```java
// PaymentThroughputBenchmark.java

@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@Warmup(iterations = 5, time = 2)
@Measurement(iterations = 10, time = 2)
@Fork(3)
@State(Scope.Thread)
public class PaymentThroughputBenchmark {

    private PaymentRequest request;
    private PaymentValidator validator;

    @Setup
    public void setup() {
        validator = new PaymentValidator();
        request = new PaymentRequest(
            "PAY-001",
            new BigDecimal("100.00"),
            "USD",
            "ACC-FROM-001",
            "ACC-TO-002"
        );
    }

    @Benchmark
    public boolean validatePayment() {
        // Return value prevents dead code elimination
        return validator.validate(request);
    }
}
```

```java
// PaymentLatencyBenchmark.java -- P99 analysis

@BenchmarkMode(Mode.SampleTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 20, time = 2)
@Fork(2)
@State(Scope.Thread)
public class PaymentLatencyBenchmark {

    private PaymentSerializer serializer;
    private PaymentMessage message;

    @Setup
    public void setup() {
        serializer = new JsonPaymentSerializer();
        message = buildSampleMessage();
    }

    @Benchmark
    public byte[] serializePayment() {
        return serializer.serialize(message);
    }

    private PaymentMessage buildSampleMessage() {
        return PaymentMessage.builder()
            .messageId("MSG-20261108-001")
            .amount(new BigDecimal("9999.99"))
            .currency("USD")
            .debtorAccount("ACC-FROM-001")
            .creditorAccount("ACC-TO-002")
            .timestamp(Instant.now())
            .build();
    }
}
```

## 6. ‏@Warmup و@Measurement

```java
@Warmup(
    iterations = 5,                     // 5 warmup iterations (discarded)
    time = 1,                           // each iteration lasts 1 second
    timeUnit = TimeUnit.SECONDS,
    batchSize = 1                       // only used by SingleShotTime mode
)
@Measurement(
    iterations = 10,                    // 10 measurement iterations (kept)
    time = 2,                           // each lasts 2 seconds
    timeUnit = TimeUnit.SECONDS
)
```

**استراتيجية الإحماء لخدمات الدفع:**

- **مقاييس التسلسل**: 5 تكرارات إحماء مدة كل منها ثانية واحدة تكفي عادة
- **المقاييس التي تلمس قاعدة البيانات**: قد تحتاج 10+ تكرارات إحماء لتسخين الذاكرات المخبئية ومجمعات الاتصالات
- **المقاييس كثيفة JIT** (اجتياز رسوم كائنات معقدة): 10+ تكرارات إحماء
- **الدوال القصيرة** (< 100 نانوثانية): يستدعيها JMH أصلًا في حلقة ضيقة ويوزّع كلفته الخاصة؛ استخدم `NANOSECONDS` كوحدة إخراج. (‏`batchSize` لا ينطبق إلا على وضع `SingleShotTime` — فهو يجمّع الاستدعاءات حين يكون الاستدعاء الواحد أقصر من أن يُقاس وحده.)

```java
// Short-method benchmark: nanosecond output, no special batching needed
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Fork(2)
public class CurrencyLookupBenchmark {

    // Do NOT name this class "State": it would shadow the @State annotation
    @State(Scope.Benchmark)
    public static class Currencies {
        Map<String, Currency> byCode = Map.of(
            "USD", Currency.getInstance("USD"),
            "EUR", Currency.getInstance("EUR"),
            "GBP", Currency.getInstance("GBP"),
            "JPY", Currency.getInstance("JPY")
        );
        String code = "USD";   // non-final field: the key is not a constant
    }

    @Benchmark
    public Currency lookup(Currencies state) {
        return state.byCode.get(state.code);
    }
}
```

## 7. ‏@Param — مقاييس بمعاملات

يتيح لك `@Param` تشغيل المقياس نفسه عبر قيم مدخلات متعددة، فينتج مصفوفة من النتائج.

```java
// PaymentSerializationBenchmark.java

@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@Fork(2)
@State(Scope.Thread)
public class PaymentSerializationBenchmark {

    @Param({"JSON", "PROTOBUF", "AVRO"})
    private String serializerType;

    @Param({"1", "10", "100"})
    private int lineItemCount;

    private PaymentSerializer serializer;
    private PaymentMessage message;

    @Setup
    public void setup() {
        serializer = switch (serializerType) {
            case "JSON"     -> new JsonPaymentSerializer();
            case "PROTOBUF" -> new ProtobufPaymentSerializer();
            case "AVRO"     -> new AvroPaymentSerializer();
            default         -> throw new IllegalArgumentException("Unknown: " + serializerType);
        };

        message = buildMessage(lineItemCount);
    }

    @Benchmark
    public byte[] serialize() {
        return serializer.serialize(message);
    }

    @Benchmark
    public PaymentMessage deserialize() throws Exception {
        byte[] bytes = serializer.serialize(message);
        return serializer.deserialize(bytes, PaymentMessage.class);
    }

    private PaymentMessage buildMessage(int lineItems) {
        PaymentMessage.Builder builder = PaymentMessage.builder()
            .messageId("MSG-" + System.nanoTime())
            .amount(new BigDecimal("100.00"))
            .currency("USD");

        for (int i = 0; i < lineItems; i++) {
            builder.addLineItem(new PaymentLineItem(
                "ITEM-" + i,
                new BigDecimal("1.00"),
                "Service fee " + i
            ));
        }

        return builder.build();
    }
}
```

ينتج هذا مصفوفة نتائج 3×3:

```
Benchmark                                    (lineItemCount)  (serializerType)   Mode  Cnt   Score   Error  Units
PaymentSerializationBenchmark.serialize                    1              JSON  avgt   20   8.234 ± 0.123  us/op
PaymentSerializationBenchmark.serialize                    1          PROTOBUF  avgt   20   2.112 ± 0.034  us/op
PaymentSerializationBenchmark.serialize                   10              JSON  avgt   20  42.567 ± 1.234  us/op
PaymentSerializationBenchmark.serialize                   10          PROTOBUF  avgt   20   8.912 ± 0.198  us/op
...
```

## 8. تجنب حذف الشيفرة الميتة

يستطيع مترجم JIT حذف الحسابات التي لا تُستخدم نتائجها أبدًا. وهذا يجعل مقياسك لا يقيس شيئًا. واستراتيجيتا منع:

### 8.1 أعِد النتيجة

```java
// WRONG: JIT may eliminate the entire computation
@Benchmark
public void computeBalance_wrong() {
    BigDecimal balance = account.computeBalance(); // result discarded, may be eliminated
}

// CORRECT: return the result; JMH consumes it
@Benchmark
public BigDecimal computeBalance_correct() {
    return account.computeBalance(); // JMH uses the return value
}
```

### 8.2 استخدم Blackhole

حين تكون لديك قيم متعددة لاستهلاكها، أو لا تستطيع تغيير توقيع الدالة:

```java
// BlackholeExample.java

@Benchmark
public void processTransaction(Blackhole bh) {
    // Multiple outputs -- use Blackhole to consume all
    ValidationResult validation = validator.validate(request);
    BigDecimal fee = feeCalculator.calculateFee(request);
    RiskScore risk = riskEngine.score(request);

    bh.consume(validation);
    bh.consume(fee);
    bh.consume(risk);
}
```

### 8.3 منع طي الثوابت

يستطيع JIT أيضًا طي المدخلات الثابتة وقت الترجمة: فإذا كانت كل المدخلات ثوابت وقت الترجمة، يمكن حساب النتيجة مرة واحدة فلا يقيس المقياس شيئًا تقريبًا:

```java
// WRONG: all inputs are constants -- the JIT may precompute the result
@State(Scope.Benchmark)
public class ConstantFoldingProblem {
    private static final double PRINCIPAL = 10_000.0;  // static final == constant

    @Benchmark
    public double interest_problem() {
        return PRINCIPAL * Math.pow(1.0 + 0.05 / 365, 365);  // may be folded
    }
}

// CORRECT: read inputs from non-final @State fields
@State(Scope.Benchmark)
public class ConstantFoldingFixed {
    private double principal = 10_000.0;   // not final, not static
    private double annualRate = 0.05;

    @Benchmark
    public double interest_correct() {
        return principal * Math.pow(1.0 + annualRate / 365, 365);
    }
}
```

## 9. ‏BigDecimal مقابل double — مقياس في سياق مالي

هذا مقياس قياسي في التقنية المالية. فـ `BigDecimal` مطلوب للحساب النقدي (بلا أخطاء تقريب الفاصلة العائمة)، لكنه أبطأ بكثير من `double`. ومعرفة مقدار البطء بالضبط تُرشد القرارات المعمارية.

```java
// MonetaryArithmeticBenchmark.java

@BenchmarkMode({Mode.Throughput, Mode.AverageTime})
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@Warmup(iterations = 10, time = 1)
@Measurement(iterations = 20, time = 1)
@Fork(3)
@State(Scope.Thread)
public class MonetaryArithmeticBenchmark {

    @Param({"10", "100", "1000"})
    private int operationCount;

    private BigDecimal[] amounts;
    private double[] amountsDouble;
    private BigDecimal rate;   // created once, in setup

    @Setup
    public void setup() {
        rate = new BigDecimal("0.025");
        amounts = new BigDecimal[operationCount];
        amountsDouble = new double[operationCount];
        Random rng = new Random(42);

        for (int i = 0; i < operationCount; i++) {
            // Realistic payment amounts: 2 decimal places, up to $10,000
            double amount = Math.round(rng.nextDouble() * 10000 * 100.0) / 100.0;
            amounts[i] = BigDecimal.valueOf(amount);
            amountsDouble[i] = amount;
        }
    }

    // Benchmark: sum of BigDecimal amounts
    @Benchmark
    public BigDecimal sumBigDecimal() {
        BigDecimal sum = BigDecimal.ZERO;
        for (BigDecimal amount : amounts) {
            sum = sum.add(amount);
        }
        return sum;
    }

    // Benchmark: sum of double amounts
    @Benchmark
    public double sumDouble() {
        double sum = 0.0;
        for (double amount : amountsDouble) {
            sum += amount;
        }
        return sum;
    }

    // Benchmark: typical payment fee calculation
    // fee = amount * rate, rounded to 2 decimal places
    @Benchmark
    public BigDecimal feeCalc_bigDecimal() {
        BigDecimal rate = new BigDecimal("0.025");  // 2.5%
        BigDecimal total = BigDecimal.ZERO;
        for (BigDecimal amount : amounts) {
            BigDecimal fee = amount.multiply(rate)
                .setScale(2, RoundingMode.HALF_UP);
            total = total.add(fee);
        }
        return total;
    }

    @Benchmark
    public double feeCalc_double() {
        double rate = 0.025;
        double total = 0.0;
        for (double amount : amountsDouble) {
            double fee = Math.round(amount * rate * 100.0) / 100.0;
            total += fee;
        }
        return total;
    }

    // Benchmark: same calculation, but the rate is parsed once (in setup)
    // instead of from a String on every call -- a common, cheap optimisation
    @Benchmark
    public BigDecimal feeCalc_bigDecimalCached() {
        BigDecimal total = BigDecimal.ZERO;
        for (BigDecimal amount : amounts) {
            BigDecimal fee = amount.multiply(rate)
                .setScale(2, RoundingMode.HALF_UP);
            total = total.add(fee);
        }
        return total;
    }
}
```

**نتائج توضيحية** (Java 21، حاسوب محمول x86 حديث — أرقامك ستختلف):

```
Benchmark                                    (operationCount)  Mode  Cnt    Score    Error  Units
MonetaryArithmeticBenchmark.sumBigDecimal              100    avgt   60    1.210 ±  0.040  us/op
MonetaryArithmeticBenchmark.sumDouble                  100    avgt   60    0.045 ±  0.001  us/op
MonetaryArithmeticBenchmark.feeCalc_bigDecimal         100    avgt   60    6.480 ±  0.210  us/op
MonetaryArithmeticBenchmark.feeCalc_double             100    avgt   60    0.350 ±  0.010  us/op
```

**‏BigDecimal عادة أبطأ من double بعشرات المرات** (هنا نحو 20–30 مرة)، ويخصص كائنًا جديدًا لكل نتيجة. وبالأرقام المطلقة يبقى ذلك نانوثوانيَ فقط لكل عملية — ولمعظم خدمات الدفع ليس هو عنق الزجاجة.

التبعات لأنظمة الدفع:
- استخدم `BigDecimal` لكل القيم النقدية المخزنة والمرسلة
- للحسابات الداخلية عالية التكرار (تجميعات المخاطر، والأرباح والخسائر الفورية)، فكّر في `long` بالوحدات الصغرى (السنتات) — دقيق وسريع وبلا تخصيص، ما دمت تتعامل مع الفيضان (`Math.addExact`) والعملات ذات 0 أو 3 منازل عشرية
- لا تستخدم `double` أبدًا للقيم النقدية النهائية — فأخطاء التقريب تتراكم

## 10. خيارات JVM لنتائج قياس متسقة

شغّل المقاييس بهذه الخيارات لتقليل الضجيج:

```bash
java -jar target/benchmarks.jar \
  -jvmArgsAppend "-Xms2g -Xmx2g -XX:+AlwaysPreTouch" \
  -prof gc \
  PaymentSerializationBenchmark
# Keep the JVM's default tiered compilation -- that is what production runs.
# Run on a quiet machine: fixed CPU frequency, no other heavy processes.
```

الخيارات الأساسية:

| الخيار | الغرض |
|---|---|
| ‏`-Xms` = `-Xmx` | حجم heap ثابت — بلا إعادة تحجيم أثناء القياس |
| ‏`-XX:+AlwaysPreTouch` | حجز كل صفحات الـ heap مسبقًا عند البدء، لإزالة ضجيج أخطاء الصفحات في نظام التشغيل |
| الجامع نفسه كما في الإنتاج | اختيار GC يغيّر كلفة التخصيص والحواجز |
| تجنب `-XX:-TieredCompilation` و`-XX:+PrintCompilation` | تعطيل المستويات *ليس* ما يعمل في الإنتاج؛ وطباعة الترجمات تضيف ضجيجًا للمخرجات (و`-server` بلا أثر على JVM بـ 64 بت، و`CompileThreshold` يُتجاهل مع الترجمة المتدرجة) |

**مهم**: استخدم دائمًا `@Fork(2)` أو أكثر. فكل تفريع يبدأ عملية JVM جديدة، فلا تلوّث حالة JVM من مقاييس سابقة النتائج.

## 11. التوصيف داخل JMH

يدعم JMH أدوات التوصيف عبر الخيار `-prof`:

```bash
# GC profiler -- shows GC overhead per benchmark operation
java -jar target/benchmarks.jar -prof gc PaymentSerializationBenchmark

# async-profiler integration (needs the async-profiler native library)
java -jar target/benchmarks.jar -prof async:libPath=/opt/async-profiler/lib/libasyncProfiler.so PaymentSerializationBenchmark

# Stack profiler -- basic sampling profiler
java -jar target/benchmarks.jar -prof stack PaymentSerializationBenchmark

# JFR profiler -- Java Flight Recorder integration
java -jar target/benchmarks.jar -prof jfr PaymentSerializationBenchmark
```

مثال مخرجات موصّف GC:

```
Benchmark                                          (serializerType)  Mode  Cnt      Score     Error   Units
PaymentSerializationBenchmark.serialize                       JSON  avgt   20      8.234 ±   0.123   us/op
PaymentSerializationBenchmark.serialize:gc.alloc.rate         JSON  avgt   20   2048.123 ±  31.000  MB/sec
PaymentSerializationBenchmark.serialize:gc.alloc.rate.norm    JSON  avgt   20  16876.000 ±   0.010    B/op
PaymentSerializationBenchmark.serialize:gc.count              JSON  avgt   20     42.000            counts
PaymentSerializationBenchmark.serialize                   PROTOBUF  avgt   20      2.112 ±   0.034   us/op
PaymentSerializationBenchmark.serialize:gc.alloc.rate     PROTOBUF  avgt   20    512.456 ±   9.000  MB/sec
PaymentSerializationBenchmark.serialize:gc.alloc.rate.norm PROTOBUF avgt   20   1082.000 ±   0.010    B/op
PaymentSerializationBenchmark.serialize:gc.count          PROTOBUF  avgt   20     11.000            counts
```

يكشف هذا أن مُسلسِل JSON يخصص **ذاكرة أكثر بـ 15 مرة لكل عملية** — اكتشاف حاسم لقرارات ضبط GC.

## 12. التشغيل وتفسير النتائج

```java
// BenchmarkRunner.java -- programmatic execution (useful for CI integration)

import org.openjdk.jmh.annotations.Mode;
import org.openjdk.jmh.results.RunResult;
import org.openjdk.jmh.runner.Runner;
import org.openjdk.jmh.runner.RunnerException;
import org.openjdk.jmh.runner.options.Options;
import org.openjdk.jmh.runner.options.OptionsBuilder;

import java.util.Collection;
import java.util.concurrent.TimeUnit;

public class BenchmarkRunner {

    public static void main(String[] args) throws RunnerException {
        Options opts = new OptionsBuilder()
            .include(PaymentSerializationBenchmark.class.getSimpleName() + "\\.serialize$")
            .mode(Mode.Throughput)              // override the class's AverageTime
            .timeUnit(TimeUnit.SECONDS)         // so the score is ops/sec
            .warmupIterations(5)
            .measurementIterations(10)
            .forks(2)
            .jvmArgs("-Xms1g", "-Xmx1g", "-XX:+AlwaysPreTouch")
            .shouldFailOnError(true)
            .build();

        Collection<RunResult> results = new Runner(opts).run();

        // Assert performance requirements in CI.
        // Absolute thresholds are only meaningful on dedicated, stable hardware;
        // on shared CI runners, compare against a baseline from the SAME machine.
        for (RunResult result : results) {
            double score = result.getPrimaryResult().getScore();
            String name = result.getParams().getBenchmark() + " " + result.getParams().getParam("serializerType")
                + "/" + result.getParams().getParam("lineItemCount");

            // Fail the build if single-item serialisation drops below 50,000 ops/sec
            if ("1".equals(result.getParams().getParam("lineItemCount")) && score < 50_000) {
                throw new AssertionError(
                    "Performance regression: " + name +
                    " scored " + score + " ops/sec (expected > 50,000)"
                );
            }
        }

        System.out.println("All performance benchmarks passed.");
    }
}
```

## 13. قائمة فحص الإنتاج لمقاييس JMH

- [ ] كل دوال القياس معلّمة بـ `@Benchmark`
- [ ] ‏`@Fork(2)` كحد أدنى — نتائج التفريع الواحد غير موثوقة
- [ ] ‏`@Warmup` فيه 5 تكرارات على الأقل — الأقل قد لا يبلغ حالة JIT المستقرة
- [ ] حقول الحالة ليست `final` — يمنع طي الثوابت
- [ ] النتائج مستهلكة عبر القيمة المُعادة أو `Blackhole` — يمنع حذف الشيفرة الميتة
- [ ] ‏`@OutputTimeUnit` يطابق مدة العملية المتوقعة (ns لما دون الميكروثانية، وus للمعتاد)
- [ ] ‏`-XX:+AlwaysPreTouch` في خيارات JVM للمقاييس كثيفة الـ heap
- [ ] تشغيل موصّف GC ‏(`-prof gc`) للتحقق من معدل التخصيص بجانب الإنتاجية
- [ ] المقاييس تعمل على عتاد مستقر — لا على مشغلات CI مشتركة بحمل متغير
- [ ] النتائج مقارنة بخط أساس سابق، لا بالحدس

## اختبار المعرفة

1. ماذا يتحكم فيه التعليق `@Fork` في JMH، ولماذا لا يكفي `@Fork(1)` لنتائج موثوقة؟

2. دالة قياس نوع إرجاعها `void` وتستخدم متغيرًا محليًا يكتشف JIT أنه غير مستخدم. ماذا يحدث، وكيف تصلحه؟

3. ما الفرق بين `@Setup(Level.Trial)` و`@Setup(Level.Iteration)` و`@Setup(Level.Invocation)`؟ ومتى تستخدم كلًا منها؟

4. مقياس لحساب فائدة بـ `double` يُبلغ عن زمن صغير بشكل مريب (أقل بكثير من نانوثانية لكل عملية). وتلاحظ أن مدخلاته ثوابت `static final`. ما السبب الأرجح؟

5. تقيس تسلسل JSON فتجد الإنتاجية 1,000,000 عملية/ثانية. ويُظهر موصّف GC معدل تخصيص 500 ميغابايت/ثانية. وتعمل الخدمة بـ 100,000 معاملة في الثانية في الإنتاج. قدّر ضغط تخصيص GC واشرح ماذا يعني ذلك لتحجيم الـ heap.

## التحدي العملي

**الإعداد:** تستخدم خدمة معالجة دفع `BigDecimal` لكل الحساب النقدي بما فيه حساب الرسوم. ويريد الفريق التحقق مما إذا كان التحول إلى `long` (يمثل السنتات/وحدات العملة الصغرى) سيوفر تحسين أداء ذا معنى لمسار حساب الرسوم الساخن.

**المهمة:**
1. اكتب صنف قياس JMH كاملًا `FeeCalculationBenchmark` يقارن:
   - حساب الرسوم بـ `BigDecimal` مع تقريب `HALF_UP`
   - حساب الرسوم بـ `long` (السنتات) بدقة مكافئة
   - حساب الرسوم بـ `double` (كمرجع، مع الإقرار بفقد الدقة)
2. استخدم `@Param` لتغيير عدد المعاملات (10، و100، و1000)
3. ضمّن موصّف GC لقياس معدل التخصيص لكل عملية
4. اكتب تعليق تحليل موجزًا في الصنف يشرح أي تنفيذ توصي به لكل حالة استخدام (دفعات عالية التكرار، ومعاملة فردية فورية، والتقارير الرقابية)

**المخرج المتوقع:** ملف `FeeCalculationBenchmark.java` كامل قابل للتشغيل مع إعداد Maven وتعليقات التحليل.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ماذا يتحكم فيه التعليق `@Fork` في JMH، ولماذا لا يكفي `@Fork(1)` غالبًا؟",
      "options": [
        "يتحكم @Fork في عدد تكرارات القياس؛ و@Fork(1) يعطي نقاط بيانات قليلة جدًا",
        "يتحكم @Fork في عدد عمليات JVM المنفصلة؛ وكل تفريع يبدأ JVM جديدًا، فيعزل حالة JIT عن المقاييس السابقة",
        "يتحكم @Fork في عدد الخيوط؛ و@Fork(1) يعني خيطًا واحدًا ويفوّت آثار التزامن",
        "يتحكم @Fork في جولات الإحماء؛ و@Fork(1) يعني عدم إجراء أي إحماء"
      ],
      "correct": 1,
      "explanation": "يشغّل @Fork(N) المقياس في N عملية JVM منفصلة. وكل JVM جديد يبدأ بلا تاريخ ترجمة JIT، فيمنع التلوث من المقاييس السابقة. و@Fork(1) هو الحد الأدنى؛ و@Fork(2) أو أكثر يعطي ثقة بأن حالة JIT من مقياس لا تؤثر في آخر."
    },
    {
      "text": "مقياس JMH نوع إرجاعه void ويكتشف JIT أن القيمة المحسوبة غير مستخدمة. ماذا يحدث وكيف تصلحه؟",
      "options": [
        "يرمي JMH خطأ ترجمة؛ والإصلاح بإضافة @BenchmarkMode(Mode.Throughput)",
        "يحذف JIT الحساب كله (حذف الشيفرة الميتة)، فلا يقيس المقياس شيئًا؛ والإصلاح بإعادة القيمة أو استهلاكها عبر Blackhole",
        "يُدرج JMH تلقائيًا حاجز ذاكرة لمنع الحذف",
        "يعمل المقياس بشكل صحيح لأن @Benchmark يعطّل تحسينات JIT"
      ],
      "correct": 1,
      "explanation": "يستطيع مترجم JIT حذف الحسابات التي يثبت أن نتائجها غير مستخدمة. فدالة @Benchmark من نوع void بمتغير محلي غير مستهلك قد تُحسَّن إلى عملية فارغة. والإصلاح بإعادة النتيجة (يستهلكها JMH) أو تمريرها إلى معامل Blackhole."
    },
    {
      "text": "مقياس لحساب فائدة بـ double يُبلغ عن نتيجة صغيرة بشكل مريب (أقل بكثير من نانوثانية لكل عملية). ومدخلاته معرّفة كـ `static final`. ما السبب الأرجح؟",
      "options": [
        "حساب double غير آمن للخيوط ويسبب تنازعًا في @State(Scope.Benchmark)",
        "يطوي JIT مدخلات static final الثابتة ويحسب النتيجة مرة واحدة، فلا يقيس المقياس عملًا يُذكر",
        "يتطلب JMH أن تكون حقول @State من نوع volatile لمنع إعادة ترتيب التعليمات",
        "الكلمة final تمنع دوال @Setup من تهيئة الحقل بشكل صحيح"
      ],
      "correct": 1,
      "explanation": "حين تكون كل المدخلات ثوابت وقت الترجمة (حقول static final أو قيم حرفية)، يستطيع JIT حساب النتيجة مرة واحدة وإعادة استخدامها. فيقيس المقياس حينها كلفة إعادة ثابت — صفر تقريبًا. واقرأ المدخلات من حقول @State غير final وغير static كي يُجبر JIT على أداء العمل الحقيقي في كل استدعاء."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مقياس JMH لحساب الرسوم: BigDecimal مقابل long مقابل double",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "اكتب صنف قياس JMH كاملًا FeeCalculationBenchmark يقارن تنفيذات حساب الرسوم بـ BigDecimal ‏(تقريب HALF_UP)، وlong ‏(السنتات)، وdouble."},
    {"id": "2", "description": "استخدم @Param لتغيير عدد المعاملات بين 10 و100 و1000، لإنتاج مصفوفة نتائج 3×3 عبر التنفيذات الثلاثة."},
    {"id": "3", "description": "ضمّن إعداد موصّف GC ‏(-prof gc) وفسّر مخرجات gc.alloc.rate.norm لكل تنفيذ في تعليقات داخل صنف القياس."},
    {"id": "4", "description": "اكتب تعليقات تحليل في الصنف تشرح أي تنفيذ يُوصى به لـ: التجميع الدفعي عالي التكرار، وتفويض المعاملة الفردية الفوري، والتقارير الرقابية بدقة نقدية تامة."}
  ]
}
-->
