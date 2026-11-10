---
id: "track-09-lesson-04"
title: "JMH Benchmarking — Measuring Performance Correctly"
track: "track-09"
track-name: "Performance Engineering"
sequence: 4
slug: "jmh-benchmarking"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-09-lesson-03"]

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

## Overview

Intuition is a poor guide to Java performance. The JVM's JIT compiler, CPU branch predictor, instruction-level parallelism, and memory hierarchy combine to produce behaviour that consistently surprises experienced engineers. A method that "looks fast" may be inlined away by the JIT. A loop that "looks slow" may be auto-vectorised. Without measurement, you are guessing.

**JMH (Java Microbenchmark Harness)** is the tool built by JVM performance engineers to measure correctly. It handles JIT warm-up, dead code elimination prevention, forking JVM processes, statistical aggregation, and dozens of other pitfalls that make naive benchmarks unreliable. In financial services, where the difference between `BigDecimal` and `double` can mean precision errors on billion-dollar positions, correct measurement is not academic — it determines what code ships to production.

> [!NOTE]
> Never benchmark inside a unit test or main() method. The JVM's tiered compilation means code measured before JIT compilation is complete will give results 10-100x slower than production. JMH handles this correctly; ad-hoc benchmarks do not.

## Learning Objectives

By the end of this lesson you will be able to:

- Configure JMH in a Maven project correctly
- Write benchmarks using `@Benchmark`, `@State`, `@Warmup`, and `@Measurement`
- Choose the right `BenchmarkMode` for your measurement goal
- Use `@Param` to benchmark across multiple input dimensions
- Prevent dead code elimination using `Blackhole` and return values
- Apply JVM flags that produce consistent, reproducible results
- Benchmark payment serialisation and `BigDecimal` vs `double` arithmetic

---

## 1. Why Standard Benchmarks Lie

Consider this naive benchmark:

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

Problems with this approach:

1. **JIT not warmed up**: First iterations run as interpreted bytecode (~100x slower than compiled)
2. **Dead code elimination**: If `processingPayment()` result is unused, JIT may eliminate the call entirely
3. **OSR compilation**: The loop itself may be compiled differently than production call sites
4. **Measurement noise**: `currentTimeMillis()` resolution is OS-dependent (up to 15 ms on Windows)
5. **GC interference**: No attempt to control or account for GC pauses
6. **Single JVM**: Persistent JVM state from previous classes contaminates results

JMH addresses all of these.

---

## 2. Maven Setup

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

Run benchmarks:

```bash
mvn clean package -DskipTests
java -jar target/benchmarks.jar
# Or run a specific benchmark:
java -jar target/benchmarks.jar PaymentSerializationBenchmark
```

---

## 3. The @Benchmark Annotation

The `@Benchmark` annotation marks a method as a benchmark entry point. JMH generates a harness that calls it in a tight loop within each measurement iteration.

```java
// PaymentHashBenchmark.java

import org.openjdk.jmh.annotations.*;
import org.openjdk.jmh.infra.Blackhole;
import java.util.concurrent.TimeUnit;

@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
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
    public int hashCode_string(Blackhole bh) {
        // JVM may cache String.hashCode(), but let's measure
        int h = paymentId.hashCode();
        bh.consume(h);
        return h;
    }

    @Benchmark
    public int hashCode_murmur(Blackhole bh) {
        int h = MurmurHash3.hash32(paymentId.getBytes(), 0);
        bh.consume(h);
        return h;
    }
}
```

---

## 4. @State and Scope

`@State` controls object lifecycle and sharing across threads.

```java
// StateScope.java

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

### 4.1 Setup and TearDown Levels

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

---

## 5. BenchmarkMode — Choosing the Right Measurement

```java
// BenchmarkModeExamples.java

@BenchmarkMode(Mode.Throughput)         // ops/second -- for high-frequency operations
@BenchmarkMode(Mode.AverageTime)        // average time per op -- for latency analysis
@BenchmarkMode(Mode.SampleTime)         // distribution of times -- for P99/P999 analysis
@BenchmarkMode(Mode.SingleShotTime)     // cold performance -- for startup benchmarks
@BenchmarkMode(Mode.All)               // run all modes
```

**For payment services:**

| Use Case | Mode | Unit |
|---|---|---|
| Transaction throughput | `Throughput` | `ops/s` |
| Serialisation latency | `AverageTime` | `MICROSECONDS` |
| P99 response time | `SampleTime` | `MICROSECONDS` |
| Cold-start auth | `SingleShotTime` | `MILLISECONDS` |

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

---

## 6. @Warmup and @Measurement

```java
@Warmup(
    iterations = 5,                     // 5 warmup iterations (discarded)
    time = 1,                           // each iteration lasts 1 second
    timeUnit = TimeUnit.SECONDS,
    batchSize = 1                       // 1 benchmark call per batch
)
@Measurement(
    iterations = 10,                    // 10 measurement iterations (kept)
    time = 2,                           // each lasts 2 seconds
    timeUnit = TimeUnit.SECONDS
)
```

**Warmup strategy for payment services:**

- **Serialisation benchmarks**: 5 warmup iterations of 1s each is usually sufficient
- **Database-touching benchmarks**: May need 10+ warmup iterations to warm caches and connection pools
- **JIT-intensive benchmarks** (complex object graph traversal): 10+ warmup iterations
- **Short methods** (< 100 ns): Use `batchSize = 1000` to amortise invocation overhead

```java
// Short-method benchmark requiring batch size
@Warmup(iterations = 5, time = 1, batchSize = 1000)
@Measurement(iterations = 10, time = 1, batchSize = 1000)
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
public class CurrencyLookupBenchmark {

    @State(Scope.Benchmark)
    public static class State {
        final Map<String, Currency> currencies = Map.of(
            "USD", Currency.getInstance("USD"),
            "EUR", Currency.getInstance("EUR"),
            "GBP", Currency.getInstance("GBP"),
            "JPY", Currency.getInstance("JPY")
        );
    }

    @Benchmark
    public Currency lookupUSD(State state) {
        return state.currencies.get("USD");
    }
}
```

---

## 7. @Param — Parameterised Benchmarks

`@Param` allows you to run the same benchmark across multiple input values, producing a matrix of results.

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

This produces a 3x3 result matrix:

```
Benchmark                                    (lineItemCount)  (serializerType)   Mode  Cnt   Score   Error  Units
PaymentSerializationBenchmark.serialize                    1              JSON  avgt   20   8.234 ± 0.123  us/op
PaymentSerializationBenchmark.serialize                    1          PROTOBUF  avgt   20   2.112 ± 0.034  us/op
PaymentSerializationBenchmark.serialize                   10              JSON  avgt   20  42.567 ± 1.234  us/op
PaymentSerializationBenchmark.serialize                   10          PROTOBUF  avgt   20   8.912 ± 0.198  us/op
...
```

---

## 8. Avoiding Dead Code Elimination

The JIT compiler can eliminate computations whose results are never used. This would make your benchmark measure nothing. Two prevention strategies:

### 8.1 Return the Result

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

### 8.2 Use Blackhole

When you have multiple values to consume, or cannot change the method signature:

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

### 8.3 Constant Folding Prevention

The JIT can also fold constant inputs at compile time, making your benchmark measure the constant-folding overhead rather than the actual computation:

```java
// WRONG: JIT may precompute this at JIT time
@State(Scope.Benchmark)
public class ConstantFoldingProblem {
    private final String accountId = "ACC-001";  // final == constant!

    @Benchmark
    public int hash_problem() {
        return accountId.hashCode();  // JIT may compute this once and cache forever
    }
}

// CORRECT: Use @State fields that are not final
@State(Scope.Benchmark)
public class ConstantFoldingFixed {
    private String accountId;  // not final

    @Setup
    public void setup() {
        accountId = "ACC-" + System.nanoTime();  // non-deterministic at JIT time
    }

    @Benchmark
    public int hash_correct() {
        return accountId.hashCode();
    }
}
```

---

## 9. BigDecimal vs double — A Financial Context Benchmark

This is a canonical fintech benchmark. `BigDecimal` is required for monetary arithmetic (no floating-point rounding errors), but it is significantly slower than `double`. Understanding exactly how much slower informs architectural decisions.

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

    @Setup
    public void setup() {
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

    // Benchmark: BigDecimal with pre-cached instances (common optimisation)
    @Benchmark
    public BigDecimal feeCalc_bigDecimalCached() {
        // Using valueOf instead of new BigDecimal() -- JVM caches common values
        BigDecimal rate = new BigDecimal("0.025");
        BigDecimal scale = BigDecimal.valueOf(100);
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

**Typical results** (Java 21, modern hardware):

```
Benchmark                                    (operationCount)  Mode  Cnt    Score    Error  Units
MonetaryArithmeticBenchmark.sumBigDecimal              100    avgt   60  312.456 ± 12.123  us/op
MonetaryArithmeticBenchmark.sumDouble                  100    avgt   60    0.045 ±  0.001  us/op
MonetaryArithmeticBenchmark.feeCalc_bigDecimal         100    avgt   60  891.234 ± 45.678  us/op
MonetaryArithmeticBenchmark.feeCalc_double             100    avgt   60    0.123 ±  0.003  us/op
```

**BigDecimal is ~2000-7000x slower than double for arithmetic operations.**

Implications for payment systems:
- Use `BigDecimal` for all monetary values stored and transmitted
- For high-frequency internal computations (risk aggregations, real-time P&L), consider `long` (cents) representation
- Never use `double` for final monetary values — rounding errors accumulate

---

## 10. JVM Flags for Consistent Benchmark Results

Run benchmarks with these flags to minimise noise:

```bash
java -jar target/benchmarks.jar \
  -jvmArgs "-XX:+UseG1GC \
            -Xms2g -Xmx2g \
            -XX:+AlwaysPreTouch \
            -XX:-TieredCompilation \
            -XX:+PrintCompilation \
            -server" \
  -prof gc \
  PaymentSerializationBenchmark
```

Key flags:

| Flag | Purpose |
|---|---|
| `-XX:+AlwaysPreTouch` | Pre-fault all heap pages at startup, eliminating OS page-fault noise |
| `-XX:-TieredCompilation` | Use only C2 compiler (maximum optimisation level), consistent with long-running production |
| `-server` | Force server JVM mode |
| `-XX:CompileThreshold=100` | Lower JIT threshold — useful for quick benchmarks but changes inlining |

**Important**: always use `@Fork(2)` or higher. Each fork starts a fresh JVM process, ensuring JVM state from previous benchmarks does not contaminate results.

---

## 11. Profiling Within JMH

JMH supports profilers via the `-prof` flag:

```bash
# GC profiler -- shows GC overhead per benchmark operation
java -jar target/benchmarks.jar -prof gc PaymentSerializationBenchmark

# async-profiler integration (requires async-profiler on classpath)
java -jar target/benchmarks.jar -prof async PaymentSerializationBenchmark

# Stack profiler -- basic sampling profiler
java -jar target/benchmarks.jar -prof stack PaymentSerializationBenchmark

# JFR profiler -- Java Flight Recorder integration
java -jar target/benchmarks.jar -prof jfr PaymentSerializationBenchmark
```

GC profiler output example:

```
Benchmark                             Score    Error  Units  gc.alloc.rate  gc.alloc.rate.norm  gc.count
PaymentSerializationBenchmark.json    8.234 ±  0.123  us/op   2048.123 MB/s          16876.000  B/op  42
PaymentSerializationBenchmark.proto   2.112 ±  0.034  us/op    512.456 MB/s           1082.000  B/op  11
```

This reveals that the JSON serialiser allocates **15x more memory per operation** — a critical finding for GC tuning decisions.

---

## 12. Running and Interpreting Results

```java
// BenchmarkRunner.java -- programmatic execution (useful for CI integration)

import org.openjdk.jmh.results.RunResult;
import org.openjdk.jmh.runner.Runner;
import org.openjdk.jmh.runner.RunnerException;
import org.openjdk.jmh.runner.options.Options;
import org.openjdk.jmh.runner.options.OptionsBuilder;

import java.util.Collection;

public class BenchmarkRunner {

    public static void main(String[] args) throws RunnerException {
        Options opts = new OptionsBuilder()
            .include(PaymentSerializationBenchmark.class.getSimpleName())
            .warmupIterations(5)
            .measurementIterations(10)
            .forks(2)
            .jvmArgs("-Xms1g", "-Xmx1g", "-XX:+AlwaysPreTouch")
            .shouldFailOnError(true)
            .build();

        Collection<RunResult> results = new Runner(opts).run();

        // Assert performance requirements in CI
        for (RunResult result : results) {
            double score = result.getPrimaryResult().getScore();
            String benchmarkName = result.getPrimaryResult().getLabel();

            // Fail build if serialisation throughput drops below 50,000 ops/sec
            if (benchmarkName.contains("serialize") && score < 50_000) {
                throw new AssertionError(
                    "Performance regression: " + benchmarkName +
                    " scored " + score + " ops/sec (expected > 50,000)"
                );
            }
        }

        System.out.println("All performance benchmarks passed.");
    }
}
```

---

## 13. Production Checklist for JMH Benchmarks

- [ ] All benchmark methods annotated with `@Benchmark`
- [ ] `@Fork(2)` minimum — single-fork results are unreliable
- [ ] `@Warmup` has at least 5 iterations — fewer may not reach JIT steady state
- [ ] State fields are not `final` — prevents constant folding
- [ ] Results consumed via return value or `Blackhole` — prevents dead code elimination
- [ ] `@OutputTimeUnit` matches the expected operation duration (ns for sub-microsecond, us for typical)
- [ ] `-XX:+AlwaysPreTouch` in JVM args for heap-intensive benchmarks
- [ ] GC profiler (`-prof gc`) run to check allocation rate alongside throughput
- [ ] Benchmarks run on stable hardware — not shared CI runners with variable load
- [ ] Results compared against previous baseline, not intuition

---

## Knowledge Check

1. What does the JMH `@Fork` annotation control, and why is `@Fork(1)` insufficient for reliable results?

2. A benchmark method has a `void` return type and uses a local variable that the JIT detects as unused. What happens, and how do you fix it?

3. What is the difference between `@Setup(Level.Trial)`, `@Setup(Level.Iteration)`, and `@Setup(Level.Invocation)`? When would you use each?

4. A `BigDecimal` addition benchmark shows 10x worse performance than expected. You notice the `@State` field holding the `BigDecimal` values is `final`. What is the likely cause?

5. You benchmark JSON serialisation and find the throughput is 1,000,000 ops/sec. The GC profiler shows 500 MB/s allocation rate. The service runs at 100,000 TPS in production. Estimate the GC allocation pressure and explain what this means for heap sizing.

---

## Practical Challenge

**Setup:** A payment processing service uses `BigDecimal` for all monetary arithmetic including fee calculations. The team wants to validate whether switching to a `long` (representing cents/minor currency units) would provide a meaningful performance improvement for the fee calculation hot path.

**Task:**
1. Write a complete JMH benchmark class `FeeCalculationBenchmark` that compares:
   - `BigDecimal` fee calculation with `HALF_UP` rounding
   - `long` (cents) fee calculation with equivalent precision
   - `double` fee calculation (as a reference, acknowledging precision loss)
2. Use `@Param` to vary the number of transactions (10, 100, 1000)
3. Include GC profiler to measure allocation rate per operation
4. Write a brief analysis comment in the class explaining which implementation you would recommend for each use case (high-frequency batch, real-time single-transaction, regulatory reporting)

**Expected output:** A complete, runnable `FeeCalculationBenchmark.java` file with Maven configuration and analysis comments.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What does the JMH `@Fork` annotation control, and why is `@Fork(1)` often insufficient?",
      "options": [
        "@Fork controls the number of measurement iterations; @Fork(1) gives too few data points",
        "@Fork controls the number of separate JVM processes; each fork starts a fresh JVM, isolating JIT state from previous benchmarks",
        "@Fork controls thread count; @Fork(1) means single-threaded and misses concurrency effects",
        "@Fork controls warmup rounds; @Fork(1) means no warmup is performed"
      ],
      "correct": 1,
      "explanation": "@Fork(N) runs the benchmark in N separate JVM processes. Each fresh JVM starts with no JIT compilation history, preventing contamination from previous benchmarks. @Fork(1) is the minimum; @Fork(2) or higher gives confidence that JIT state from one benchmark does not influence another."
    },
    {
      "text": "A JMH benchmark has a void return type and the JIT detects the computed value is unused. What happens and how do you fix it?",
      "options": [
        "JMH throws a compilation error; fix by adding @BenchmarkMode(Mode.Throughput)",
        "The JIT eliminates the entire computation (dead code elimination), making the benchmark measure nothing; fix by returning the value or consuming it via Blackhole",
        "JMH automatically inserts a memory barrier to prevent elimination",
        "The benchmark runs correctly because @Benchmark disables JIT optimisations"
      ],
      "correct": 1,
      "explanation": "The JIT compiler can eliminate computations whose results are provably unused. A void @Benchmark method with an unconsumed local variable may be optimised to a no-op. Fix by returning the result (JMH consumes it) or passing it to a Blackhole parameter."
    },
    {
      "text": "BigDecimal arithmetic benchmarks show 10x worse performance than expected. The @State field holding the values is declared `final`. What is the likely cause?",
      "options": [
        "BigDecimal is not thread-safe and causes contention in @State(Scope.Benchmark)",
        "The JIT constant-folds the final field and inlines the computed result, eliminating the actual work and making the benchmark measure near-zero",
        "JMH requires @State fields to be volatile to prevent instruction reordering",
        "The final keyword prevents @Setup methods from initialising the field correctly"
      ],
      "correct": 1,
      "explanation": "If a @State field is final, the JIT may constant-fold it at compile time, treating the value as a compile-time constant. The benchmark then measures the cost of using a constant rather than a variable, which is essentially zero for arithmetic. Remove the final modifier from @State fields."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "JMH Fee Calculation Benchmark for BigDecimal vs long vs double",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write a complete JMH benchmark class FeeCalculationBenchmark comparing BigDecimal (HALF_UP rounding), long (cents), and double fee calculation implementations."},
    {"id": "2", "description": "Use @Param to vary transaction count across 10, 100, and 1000, producing a 3x3 matrix of results across the three implementations."},
    {"id": "3", "description": "Include the GC profiler (-prof gc) configuration and interpret the gc.alloc.rate.norm output for each implementation in comments within the benchmark class."},
    {"id": "4", "description": "Write analysis comments in the class explaining which implementation to recommend for: high-frequency batch aggregation, real-time single-transaction authorisation, and regulatory reporting with exact monetary precision."}
  ]
}
-->

