---
id: "track-09-lesson-05"
title: "CPU Profiling — Finding Hot Methods with async-profiler"
track: "track-09"
track-name: "Performance Engineering"
sequence: 5
slug: "cpu-profiling"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-09-lesson-04"]

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

## Overview

Code review and JMH benchmarks tell you what is fast in isolation. CPU profiling tells you what is actually burning CPU in production under real load. The two answers are often completely different.

A payment serialisation method that benchmarks at 2 microseconds per call may be responsible for 40% of CPU time in production because it is called 200 million times per day. A fraud check that runs in 10 ms per call may dominate the latency profile because it is on the critical path of every authorisation. Without a profiler attached to a live or load-tested service, you are optimising the wrong thing.

This lesson covers **async-profiler** — the modern, production-safe, low-overhead CPU profiler for the JVM — and **Java Flight Recorder (JFR)**, the built-in profiling and monitoring infrastructure. You will learn to generate flame graphs, read them correctly, and act on what they reveal for payment processing workloads.

> [!NOTE]
> async-profiler uses OS-level `perf_events` (Linux) and `dtrace` (macOS) to sample stack traces without the safepoint bias that makes traditional JVMTI profilers misleading. This is critical for accurate hot-method identification.

## Learning Objectives

By the end of this lesson you will be able to:

- Attach async-profiler to a running JVM process and collect CPU samples
- Generate and interpret flame graphs
- Use JFR for continuous production profiling with minimal overhead
- Identify serialisation hot spots, reflection overhead, and JIT deoptimisation
- Profile a payment processing service under realistic load
- Avoid common profiling pitfalls (safepoint bias, profiling non-production JVM state)

---

## 1. The Safepoint Bias Problem

Traditional JVMTI-based profilers (JProfiler, YourKit in JVMTI mode) sample at **safepoints** — points where the JVM can safely inspect thread state. This creates systematic bias: code between safepoints (long loops, native calls) is underrepresented because the profiler cannot sample there.

```
Traditional profiler sampling:
  Thread state: ... [busy in tight loop, no safepoints] ... [safepoint] ... [safepoint] ...
  Samples taken:                                                    ^              ^
  
  Result: tight loops appear fast; safepoint-reaching code appears slow
  WRONG: the loop is actually the bottleneck
```

async-profiler uses `perf_events` (Linux `AsyncGetCallTrace` + kernel-level sampling) to sample at arbitrary wall-clock or CPU-time intervals, independent of safepoints. This eliminates the bias.

**When safepoint bias matters for payment services:**
- Tight deserialisation loops (reading fixed-width fields from byte arrays)
- Hash computation (Murmur, SHA256) in hot paths
- BigDecimal arithmetic on large datasets
- Netty I/O pipeline loops

---

## 2. Installing and Attaching async-profiler

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

# Collect as flamegraph SVG
./asprof -d 30 -f /tmp/payment-cpu.svg --format svg 12345

# Collect as JFR file (can be opened in JDK Mission Control)
./asprof -d 30 -f /tmp/payment-cpu.jfr --format jfr 12345
```

### 2.1 Profiling Modes

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

For payment service diagnosis:
- **CPU mode**: find what is burning CPU (serialisation, computation)
- **Wall mode**: find what is blocking (I/O, database, external calls)
- **Allocation mode**: find GC pressure sources

### 2.2 Filtering and Precision

```bash
# Increase sampling frequency (default: 10 ms)
./asprof -e cpu -i 1ms -d 30 -f /tmp/cpu.html <pid>

# Filter to specific threads (e.g., http-nio threads)
./asprof -e cpu -d 30 -f /tmp/cpu.html --filter http-nio <pid>

# Include native frames (kernel, libc) for I/O-intensive services
./asprof -e cpu -d 30 -f /tmp/cpu.html --include-native <pid>
```

---

## 3. Reading Flame Graphs

A flame graph is a hierarchical visualisation of stack traces. Each box is a stack frame. Width represents the proportion of time spent in that frame and its callees.

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

**What to look for:**

1. **Wide plateaus at the top**: CPU-intensive leaf methods — the actual hot code
2. **Wide towers**: method with many deep callees — refactoring target
3. **Jackson/reflection stacks**: serialisation overhead — consider pre-cached ObjectMapper or alternative serialisers
4. **sun.reflect stacks**: reflection-based invocation — expensive, consider MethodHandle
5. **Interpreted frames** (marked `Interpreter` or `~`): code not yet JIT-compiled — indicates cold code or deoptimisation

---

## 4. Generating Flame Graphs Programmatically

```java
// AsyncProfilerIntegration.java
// Integrates async-profiler with Spring Boot for on-demand profiling

import one.profiler.AsyncProfiler;
import one.profiler.Events;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.file.Path;

@RestController
@RequestMapping("/internal/profiler")
public class AsyncProfilerController {

    private static final AsyncProfiler profiler = AsyncProfiler.getInstance();
    private volatile boolean profiling = false;

    /**
     * Start CPU profiling for N seconds.
     * Restricted to internal network only -- never expose publicly.
     */
    @PostMapping("/cpu/start")
    public String startCpuProfile(@RequestParam(defaultValue = "30") int durationSeconds,
                                   @RequestParam(defaultValue = "1ms") String interval)
            throws IOException {

        if (profiling) {
            return "Profiling already in progress";
        }

        Path outputFile = Path.of("/tmp/profile-" + System.currentTimeMillis() + ".html");
        profiling = true;

        // Start profiling -- non-blocking
        profiler.execute(
            "start,event=cpu,interval=" + interval + ",file=" + outputFile + ",format=html"
        );

        // Schedule stop after duration
        Thread.startVirtualThread(() -> {
            try {
                Thread.sleep(durationSeconds * 1000L);
                profiler.execute("stop");
                profiling = false;
            } catch (InterruptedException | IOException e) {
                Thread.currentThread().interrupt();
            }
        });

        return "Profiling started. Output: " + outputFile;
    }

    @PostMapping("/cpu/stop")
    public String stopProfile() throws IOException {
        profiler.execute("stop");
        profiling = false;
        return "Profiling stopped";
    }

    @GetMapping("/status")
    public String status() {
        return profiling ? "profiling" : "idle";
    }
}
```

---

## 5. JFR — Java Flight Recorder

JFR is built into the JDK (since Java 11, free since Java 11) and provides continuous, low-overhead profiling and monitoring. It records hundreds of event types: GC, compilation, class loading, file I/O, socket I/O, exceptions, and CPU samples.

### 5.1 Starting JFR

```bash
# Start JFR recording via jcmd (attach to running process)
jcmd <pid> JFR.start name=payment-profile duration=60s \
  settings=profile \
  filename=/tmp/payment.jfr

# Start at JVM startup
java -XX:StartFlightRecording=duration=60s,filename=/tmp/startup.jfr,settings=profile \
  -jar payment-service.jar

# Start continuous recording (circular buffer, dumps on demand)
java -XX:StartFlightRecording=name=continuous,maxage=10m,maxsize=250m,settings=profile \
  -jar payment-service.jar

# Dump the continuous recording
jcmd <pid> JFR.dump name=continuous filename=/tmp/on-demand-dump.jfr
```

### 5.2 JFR CPU Events in Code

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

### 5.3 Analysing JFR Recordings

```bash
# View JFR recording summary
jfr summary /tmp/payment.jfr

# Print specific events
jfr print --events CPUSample /tmp/payment.jfr | head -100

# Print custom events
jfr print --events com.example.payment.AuthorisationEvent /tmp/payment.jfr

# Open in JDK Mission Control (GUI)
jmc /tmp/payment.jfr
```

---

## 6. Profiling Payment Processing Under Load

The most valuable profiling is done under realistic production load. Here is a systematic approach:

### 6.1 Load Generation Setup

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
        List<Long> latenciesNs = new CopyOnWriteArrayList<>();

        while (System.currentTimeMillis() < endTime) {
            long start = System.nanoTime();

            executor.submit(() -> {
                long reqStart = System.nanoTime();
                try {
                    PaymentRequest req = generateRealisticRequest();
                    authService.authorise(req);
                    successCount.incrementAndGet();
                    latenciesNs.add(System.nanoTime() - reqStart);
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

### 6.2 Identifying Serialisation Hot Spots

A common finding when profiling payment services: Jackson ObjectMapper is consuming 25-40% of CPU. Typical flame graph node:

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

Action: Pre-configure serialiser per type, avoid reflection at runtime:

```java
// OptimisedPaymentSerializer.java

@Component
public class OptimisedPaymentSerializer {

    private final ObjectMapper mapper;
    // Pre-computed writer -- avoids type lookup on every call
    private final ObjectWriter paymentWriter;
    private final ObjectReader paymentReader;

    public OptimisedPaymentSerializer() {
        this.mapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            // Pre-compute serialisers for all registered types at startup
            .disable(MapperFeature.USE_ANNOTATIONS);  // faster if annotations unused

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

### 6.3 Identifying Reflection Overhead

```java
// BEFORE: reflection-heavy approach (shows up as sun.reflect in flame graph)
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

---

## 7. JIT Compilation Effects on Profiling

The JIT compiler can produce misleading profiling results in several ways:

### 7.1 Inlined Methods are Invisible

When the JIT inlines a method, it disappears from the call stack. If a hot method is inlined into its caller, the flame graph shows the caller as hot, not the inlined method.

```java
// PaymentFeeCalculator.java -- frequently inlined methods

public class PaymentFeeCalculator {

    // This method will be inlined -- it won't appear in flame graphs
    // even if it's called 10 million times per second
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

**Implication**: if profiling shows a method as hot and simple, the actual work may be in its callees that have been inlined into it.

### 7.2 Deoptimisation Events

JIT deoptimisation causes code to fall back to interpreted mode temporarily. This appears in flame graphs as `Interpreter` frames and dramatically increases CPU usage:

```bash
# Check for deoptimisation events in JFR
jfr print --events Deoptimization /tmp/payment.jfr | head -50

# Example output showing problematic deoptimisations:
# com.example.payment.PaymentValidator.validate()
#   Reason: null_check -- a field that the JIT assumed non-null was null
#   This causes recompilation -- expensive during high load
```

Fix: add `Objects.requireNonNull()` checks or `@NonNull` annotations to give the JIT stable type information.

---

## 8. Profiling Under Load — Practical Script

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
PID=$(jps -l | grep "$SERVICE_NAME" | awk '{print $1}')
if [ -z "$PID" ]; then
    echo "ERROR: $SERVICE_NAME not found"
    exit 1
fi

echo "Profiling PID $PID for ${DURATION}s..."

# Collect CPU flame graph
./asprof -d "$DURATION" \
  -e cpu \
  -i 1ms \
  -f "$OUTPUT_DIR/cpu-${TIMESTAMP}.html" \
  --title "Payment Service CPU Profile - $TIMESTAMP" \
  "$PID"

echo "CPU profile: $OUTPUT_DIR/cpu-${TIMESTAMP}.html"

# Collect allocation profile
./asprof -d "$DURATION" \
  -e alloc \
  -f "$OUTPUT_DIR/alloc-${TIMESTAMP}.html" \
  --title "Payment Service Allocation Profile - $TIMESTAMP" \
  "$PID"

echo "Allocation profile: $OUTPUT_DIR/alloc-${TIMESTAMP}.html"

# Collect JFR for correlation
jcmd "$PID" JFR.start \
  name="profile-${TIMESTAMP}" \
  duration="${DURATION}s" \
  settings=profile \
  filename="$OUTPUT_DIR/jfr-${TIMESTAMP}.jfr"

echo "JFR recording: $OUTPUT_DIR/jfr-${TIMESTAMP}.jfr"
echo "Done. Open HTML files in a browser."
```

---

## 9. Production Checklist

Before and after profiling a payment service:

- [ ] Profile under realistic production load (not idle JVM — JIT state is different)
- [ ] Use `-e cpu` for CPU-bound diagnosis, `-e wall` for latency/blocking diagnosis
- [ ] Run for at least 30 seconds to get statistically meaningful samples
- [ ] Use `@Fork(1)` JVM when profiling from JMH to allow async-profiler to attach
- [ ] Check for `Interpreter` frames in flame graph — indicates deoptimisation
- [ ] Check for `sun.reflect`/`jdk.internal.reflect` — indicates reflective hot paths
- [ ] Check ObjectMapper allocation in alloc profile — common in Spring MVC services
- [ ] Verify JFR is enabled in production with `maxage=10m` circular buffer for reactive diagnosis
- [ ] Correlate CPU flame graph with GC allocation profile — high allocation often drives CPU

---

## Knowledge Check

1. What is safepoint bias and why does it make traditional JVMTI profilers unreliable for identifying hot loops?

2. In a CPU flame graph, you see `BeanSerializer.serialize` taking 35% of CPU. What two changes would you make to the Jackson configuration to reduce this overhead?

3. You profile a payment authorisation service and find `Interpreter` frames in the flame graph consuming 15% of CPU. What does this indicate and how do you investigate further?

4. The difference between `-e cpu` mode and `-e wall` mode in async-profiler: when would each be misleading for a payment service that calls an external fraud API?

5. How does JIT method inlining affect what you see in a flame graph? Give an example where a hot method might be invisible.

---

## Practical Challenge

**Setup:** A payment authorisation service processes 2,000 TPS. The team observes CPU usage at 85% despite the service seeming "fast enough" at P50 latency. P99 latency is 180 ms.

**Task:**
1. Write the shell commands to capture both a CPU flame graph and allocation profile simultaneously, with appropriate duration and sampling interval
2. Write a `ProfilingSession` Java class that:
   - Starts async-profiler programmatically via the Java API
   - Triggers both CPU and allocation profiles for a configurable duration
   - Writes output files with timestamped names
   - Exposes start/stop via Spring Boot actuator endpoint
3. List the top 5 things you would look for in the resulting flame graphs for a Spring Boot + Jackson + PostgreSQL payment service

**Expected output:** Shell script, Java class, and analysis checklist.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is safepoint bias, and why does it make traditional JVMTI-based profilers unreliable for identifying hot loops?",
      "options": [
        "Safepoint bias causes the profiler to over-sample GC events instead of application code",
        "JVMTI profilers can only take samples at safepoints; code between safepoints (tight loops) is invisible, causing hot loops to be under-reported",
        "Safepoint bias only affects ZGC and not G1GC-based profiling sessions",
        "JVMTI profilers are biased toward I/O-bound methods because safepoints occur during blocking calls"
      ],
      "correct": 1,
      "explanation": "Traditional JVMTI-based profilers (like older versions of YourKit) take samples only at JVM safepoints. Tight loops often execute for many iterations without reaching a safepoint, making them invisible in the profile. async-profiler uses OS signals (perf_events on Linux) to sample at any point, overcoming safepoint bias."
    },
    {
      "text": "In a CPU flame graph, BeanSerializer.serialize takes 35% of CPU due to reflection. Which two Jackson changes would reduce this?",
      "options": [
        "Enable lazy deserialization and increase thread pool size",
        "Pre-build ObjectWriter and ObjectReader instances per type at startup, and register module types so Jackson avoids per-call type discovery via reflection",
        "Switch from JSON to XML serialization and use JAXB annotations",
        "Add @JsonIgnore to all non-essential fields to reduce serialized size"
      ],
      "correct": 1,
      "explanation": "Pre-computing ObjectWriter/ObjectReader via mapper.writerFor(Type.class) eliminates per-call type lookup. Registering JavaTimeModule and disabling annotation introspection further reduces reflection overhead. These are the two highest-impact Jackson CPU optimizations."
    },
    {
      "text": "What is the key difference between async-profiler's `-e cpu` mode and `-e wall` mode for diagnosing a payment service with slow P99 latency?",
      "options": [
        "cpu mode samples all threads; wall mode only samples the main thread",
        "cpu mode shows time spent on-CPU (misses I/O wait); wall mode shows elapsed wall-clock time per thread, revealing blocking calls and thread pool starvation",
        "cpu mode requires root privileges; wall mode runs as the application user",
        "wall mode is only available on Windows; cpu mode works on all platforms"
      ],
      "correct": 1,
      "explanation": "cpu mode uses CPU cycles and only captures threads actively running on a CPU core. A thread waiting for a database response or blocked on a full connection pool consumes zero CPU time and is invisible in cpu mode. wall mode samples all threads including blocked ones, making it essential for diagnosing latency caused by I/O or thread contention."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "CPU Profiling a High-TPS Payment Authorisation Service",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Write shell commands to simultaneously capture a CPU flame graph and allocation profile of a running payment service using async-profiler, with 60-second duration and 1ms CPU sampling interval."},
    {"id": "2", "description": "Implement a ProfilingSession Spring Boot component that starts async-profiler programmatically via its Java API, captures both cpu and alloc profiles for a configurable duration, and writes timestamped HTML output files."},
    {"id": "3", "description": "Expose the ProfilingSession as a Spring Boot Actuator endpoint at /internal/profiler/start and /internal/profiler/stop, restricted to internal network access only."},
    {"id": "4", "description": "List the top five patterns to investigate in the resulting flame graphs for a Spring Boot + Jackson + PostgreSQL payment service, ordered by frequency of occurrence in production systems."}
  ]
}
-->

