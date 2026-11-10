---
id: track-09-lesson-17
title: "Flame Graphs — Visualising CPU and Memory Hotspots"
slug: flame-graphs
track: track-09
trackName: "Performance Engineering"
sequence: 17
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [flame-graph, async-profiler, CPU, allocation, visualisation]
prerequisites: []
---

# Flame Graphs — Visualising CPU and Memory Hotspots

> [!NOTE]
> Flame graphs are the most efficient tool for identifying CPU and memory hotspots in production JVM services. A single 30-second CPU flame graph of a payment authorization service often reveals the exact method consuming unexpected CPU — whether it is JSON serialization, JDBC result set mapping, or an inefficient fraud rule evaluation loop — without requiring code changes or service restarts.

## Flame Graph Anatomy

A flame graph displays a sampled stack trace visualization:

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

**X-axis**: Stacks are sorted alphabetically (NOT chronologically). Width represents the proportion of total CPU time spent in that stack frame.

**Y-axis**: Stack depth. The bottom is always the thread root (usually `Thread.run`). Each level up is the caller/callee relationship.

**Width interpretation**: A wide frame at the top of the graph means that code is frequently "on CPU" — it is doing actual work or is a common caller. A wide frame with narrow children means the frame itself is the hotspot, not its callees.

**Plateau (flat top)**: A wide method with no children visible means that method is consuming CPU directly — a hotspot.

---

## CPU vs Allocation vs Wall-Clock Flame Graphs

| Type | What it shows | Use case |
|------|--------------|----------|
| CPU | Methods consuming CPU cycles | High CPU utilisation, inefficient algorithms |
| Allocation | Methods allocating heap objects | GC pressure, memory churn, object creation hotspots |
| Wall-clock | Methods that are "on the stack" (CPU + IO wait) | Latency investigation, IO bottlenecks |
| Lock contention | Methods blocked waiting for locks | Concurrency bottlenecks, lock contention |

For payment services:
- Use **CPU flame graphs** when CPU utilisation is high
- Use **allocation flame graphs** when GC pause rate is high
- Use **wall-clock flame graphs** when latency is high but CPU is low (IO wait)

---

## async-profiler — The Go-To JVM Profiler

async-profiler is the best tool for production JVM profiling:
- Uses Linux perf_events (AsyncGetCallTrace API) — no safepoint bias
- Works on running JVMs without code changes
- Minimal overhead (~1-3% CPU)
- Generates flame graphs directly

### Installation

```bash
# Download async-profiler
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar xf async-profiler-3.0-linux-x64.tar.gz
export ASPROF=/opt/async-profiler-3.0-linux-x64/bin/asprof
```

### CPU Flame Graph Commands

```bash
# Profile for 30 seconds, generate flame graph
# Replace <pid> with payment service PID
$ASPROF -d 30 -f /tmp/payment-cpu-flame.html <pid>

# Profile with higher sampling interval (less overhead)
$ASPROF -d 30 -i 10ms -f /tmp/payment-cpu-flame.html <pid>

# Profile CPU with thread separation (see per-thread breakdown)
$ASPROF -d 30 --threads -f /tmp/payment-cpu-flame-threads.html <pid>

# Profile with Java frame context (shows JIT-compiled code properly)
$ASPROF -d 30 -e cpu --all-user -f /tmp/payment-cpu.html <pid>

# Interactive: start and stop manually
$ASPROF start -e cpu <pid>
# ... run your load test for 60 seconds ...
$ASPROF stop -f /tmp/payment-cpu.html <pid>
```

### Allocation Flame Graph Commands

```bash
# Allocation flame graph: shows what code allocates the most heap
# Tracks object allocations, not CPU time
$ASPROF -d 30 -e alloc -f /tmp/payment-alloc-flame.html <pid>

# Filter: only show allocations >= 512 bytes
$ASPROF -d 30 -e alloc --alloc 512b -f /tmp/payment-alloc-large.html <pid>

# Wall-clock mode: includes threads waiting on IO
# Essential for latency investigation
$ASPROF -d 30 -e wall -t -f /tmp/payment-wall.html <pid>
```

---

## Reading a CPU Flame Graph — Payment Service Example

```
Common flame graph patterns in payment services:

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
         Each Pattern.compile call takes ~200µs.
ACTION: Cache Pattern instances at class initialization.
        @PostConstruct: patterns = rules.stream()
            .map(r -> Pattern.compile(r.getRegex()))
            .toList();

PATTERN 3: JDBC result set mapping
────────────────────────────────────
AccountRepository.findById [████████████████████████████████]
  ResultSet.getString [████████████████████]
    AbstractResultSet.getString [██████████]
      StringFactory.newString [████████]  ← many String allocations

FINDING: ResultSet mapping allocates thousands of String objects per query.
ACTION: Use primitive types where possible. Consider ResultSet.getBytes()
        for binary data. Batch queries to reduce result set processing overhead.
```

---

## Generating Flame Graphs from Java Code

```java
/**
 * Programmatic flame graph generation using async-profiler Java API.
 * Useful for capturing profiles around specific operations.
 */
@Service
public class FlameGraphCapture {

    private final AsyncProfiler profiler = AsyncProfiler.getInstance();
    private volatile boolean profiling = false;

    /**
     * Start profiling around a specific endpoint under load.
     * Call startProfiling() before load test, stopAndSave() after.
     */
    public void startCpuProfiling(String outputPath) throws IOException {
        if (profiling) return;
        profiling = true;
        profiler.start(Events.CPU, 10_000_000);  // 10ms interval
        log.info("CPU profiling started, output: {}", outputPath);
    }

    public void stopAndSaveFlameGraph(String outputPath) throws IOException {
        if (!profiling) return;
        profiling = false;
        profiler.stop();

        // Write flame graph HTML
        profiler.dumpFlame(outputPath, "");
        log.info("Flame graph saved to {}", outputPath);
    }

    /**
     * Profile a specific code block and generate flame graph.
     * Usage: wrapWithProfiling(() -> runLoadTest(), "/tmp/profile.html")
     */
    public <T> T profileBlock(Callable<T> block, String outputPath) throws Exception {
        profiler.start(Events.CPU, 10_000_000);
        try {
            return block.call();
        } finally {
            profiler.stop();
            profiler.dumpFlame(outputPath, "");
        }
    }
}
```

---

## Differential Flame Graphs — Regression Analysis

Differential flame graphs compare two profiles to highlight what changed between versions. This is essential for performance regression analysis.

```bash
# Step 1: Profile production (or baseline)
$ASPROF -d 60 -f /tmp/baseline.jfr -o jfr <baseline-pid>

# Step 2: Deploy new version, profile again
$ASPROF -d 60 -f /tmp/new-version.jfr -o jfr <new-pid>

# Step 3: Convert to collapsed stacks for diff
$ASPROF convert --jfr2collapsed /tmp/baseline.jfr > /tmp/baseline.txt
$ASPROF convert --jfr2collapsed /tmp/new-version.jfr > /tmp/new.txt

# Step 4: Generate differential flame graph
# Using Brendan Gregg's diff tools:
./flamegraph/difffolded.pl /tmp/baseline.txt /tmp/new.txt > /tmp/diff.txt
./flamegraph/flamegraph.pl /tmp/diff.txt > /tmp/diff-flame.svg

# Red frames: MORE time in new version (regression)
# Blue frames: LESS time in new version (improvement)
```

Interpreting a differential flame graph from a payment service regression:

```
Differential Flame Graph: v2.1.0 vs v2.2.0

RED (regression, 40% more CPU):
  PaymentValidator.validate [████████████████████]  ← NEW: validation added
    AccountValidator.checkKycStatus [████████████]  ← added in v2.2.0
      KycService.fetchStatus [████████]              ← synchronous HTTP call
        HttpClient.send [████████]                   ← blocks on IO

FINDING: v2.2.0 added synchronous KYC validation that calls external HTTP service.
         This adds 40ms CPU-equivalent wait time to every authorization.
ACTION: 
  1. Make KYC check asynchronous — cache KYC status per account
  2. Or prefetch KYC status on account login, cache for session duration
  3. Or move KYC check to async post-authorization audit
```

---

## JFR Flame Graphs in JDK Mission Control

Java Flight Recorder (JFR) is built into the JDK and captures events with minimal overhead:

```java
/**
 * Enable JFR for payment service with performance-focused settings.
 * JFR can run continuously in production with ~1% overhead.
 */
@Component
public class JfrConfiguration {

    @PostConstruct
    public void configureJfr() throws ParseException {
        // Configure JFR recording for production
        // Equivalent to: java -XX:StartFlightRecording=...
        Map<String, String> settings = new HashMap<>();
        settings.put("jdk.CPUSample#enabled", "true");
        settings.put("jdk.CPUSample#period", "10ms");
        settings.put("jdk.GCHeapSummary#enabled", "true");
        settings.put("jdk.JavaMonitorWait#enabled", "true");
        settings.put("jdk.JavaMonitorEnter#enabled", "true");
        settings.put("jdk.ThreadPark#enabled", "true");
        settings.put("jdk.ObjectAllocationInNewTLAB#enabled", "true");
        settings.put("jdk.ObjectAllocationOutsideTLAB#enabled", "true");

        // Start continuous recording — rotates every hour, keeps last 6 hours
        // Dump on demand: jcmd <pid> JFR.dump name=payment-service filename=/tmp/dump.jfr
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
# Navigate to: Code → Hot Methods → "Flame Graph" view
```

---

## Common Hotspot Patterns in Payment Services

```java
/**
 * Pattern 1: ObjectMapper instantiation in hot path
 * BAD: creates new ObjectMapper on every request (expensive)
 */
@RestController
public class BadPaymentController {
    @PostMapping("/payments")
    public String authorize(@RequestBody String body) throws Exception {
        ObjectMapper mapper = new ObjectMapper();  // BAD: 2-5ms to create
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
// ObjectMapper.<init> [████████████]  ← wide plateau at top level
//   Jackson2ObjectMapperBuilder.build [████████]
//     DeserializationContext.<init> [████]
```

```java
/**
 * Pattern 2: String concatenation in loops
 * BAD: creates O(n) String objects
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
// StringBuilder.append [████████████████]  ← many String.concat calls
//   AbstractStringBuilder.ensureCapacityInternal [████████]
//     Arrays.copyOf [████████]  ← array resizing on every iteration
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
 * GOOD: lazy evaluation with lambda
 */
public void processPayment(Payment p) {
    log.debug("Processing payment: {} amount={} account={}",
        p.getId(), p.getAmount(), p.getAccountId());  // GOOD: formatted only if DEBUG
}

// Allocation flame graph signature of BAD:
// String.concat [████████]
//   StringBuilder.append [████]  ← log message built for every transaction
```

---

## Flame Graph Checklist for Payment Service Investigation

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
  4. Use @Contended, object pooling, or primitive types to reduce allocation

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
      "text": "In a CPU flame graph, what does a wide, flat plateau near the top of the stack indicate?",
      "options": [
        "A method that is called frequently but completes quickly — high call rate, low per-call cost",
        "A method that is spending a large fraction of CPU time — either it is called very often or it is expensive per call; it is the primary optimization target",
        "A GC pause that consumed CPU time during the profiling window",
        "A method that was inlined by the JIT compiler and is therefore invisible in the actual execution"
      ],
      "correct": 1,
      "explanation": "In a flame graph, width represents the fraction of samples where that method was on the call stack. A wide plateau near the top (where the stack is deepest, meaning the most specific callee) indicates a method that consumed a large share of CPU time. This is the hotspot to investigate for optimization."
    },
    {
      "text": "When should you use a wall-clock flame graph instead of a CPU flame graph for diagnosing payment service latency?",
      "options": [
        "Wall-clock graphs are always preferred; CPU graphs are only used for GC analysis",
        "When CPU utilization is low (<30%) but P99 latency is high — threads are waiting on I/O, database responses, or thread pool queues rather than consuming CPU; wall-clock mode captures blocked threads",
        "Wall-clock graphs are used only for profiling batch jobs, not real-time services",
        "Wall-clock mode requires root privileges on Linux and is unavailable in containerized environments"
      ],
      "correct": 1,
      "explanation": "CPU flame graphs only capture threads that are actively running on a CPU core. A thread waiting for a database connection or blocked on a full queue uses zero CPU and is invisible. Wall-clock mode (-e wall) samples all threads including blocked ones, making it essential for diagnosing latency caused by I/O, contention, or thread starvation rather than CPU-bound hot paths."
    },
    {
      "text": "Why does string concatenation in a debug log call like log.debug('Processing: ' + payment.getId()) show up as a hotspot in an allocation flame graph?",
      "options": [
        "The + operator triggers autoboxing of the payment object to String",
        "String concatenation allocates a new String object for every call regardless of whether DEBUG logging is enabled, creating garbage that contributes to GC pressure on hot paths",
        "The JIT cannot inline string concatenation, making it unusually expensive",
        "log.debug always evaluates its arguments at INFO level too, doubling allocation cost"
      ],
      "correct": 1,
      "explanation": "In Java, 'Processing: ' + payment.getId() builds the concatenated string before calling log.debug(). Even if the DEBUG level is not enabled, the String is allocated. At 5000 TPS, this creates 5000 short-lived String objects per second that contribute to young-gen GC pressure. Fix with parametrized logging: log.debug('Processing: {}', payment.getId()) — the string is only built if the level is enabled."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Flame Graph Investigation of a High-CPU Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Write the asprof commands to generate three flame graphs simultaneously for a running payment service: CPU profile (-e cpu), allocation profile (-e alloc), and wall-clock profile (-e wall -t), each for 60 seconds with HTML output."},
    {"id": "2", "description": "Given a CPU flame graph showing ObjectMapper.writeValueAsBytes taking 38% of CPU in a payment serialization path, write the OptimisedPaymentSerializer class using pre-computed ObjectWriter and ObjectReader instances to eliminate per-call type resolution."},
    {"id": "3", "description": "Write a DifferentialFlameGraphComparator class that compares two async-profiler collapsed stacks files (before/after a code change) and reports the top 10 methods with the most CPU usage increase and decrease."},
    {"id": "4", "description": "Create a production profiling runbook document (as code comments in a ProfilingRunbook.java class) listing the step-by-step procedure for safely attaching async-profiler to a production payment service, including safeguards and rollback steps."}
  ]
}
-->

