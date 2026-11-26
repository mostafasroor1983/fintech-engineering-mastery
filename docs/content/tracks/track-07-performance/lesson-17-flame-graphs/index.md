---
id: track-07-lesson-17
title: "Flame Graphs — Visualising CPU and Memory Hotspots"
slug: flame-graphs
track: track-07
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
- Samples with OS signals (perf_events or timers on Linux) and walks Java stacks with `AsyncGetCallTrace` — no safepoint bias
- Works on running JVMs without code changes
- Minimal overhead (~1-3% CPU)
- Generates flame graphs directly

### Installation

```bash
# Download async-profiler
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar xf async-profiler-3.0-linux-x64.tar.gz -C /opt
export ASPROF=/opt/async-profiler-3.0-linux-x64/bin/asprof
```

### CPU Flame Graph Commands

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

### Allocation Flame Graph Commands

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

---

## Reading a CPU Flame Graph — Payment Service Example

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

---

## Generating Flame Graphs from Java Code

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

---

## Differential Flame Graphs — Regression Analysis

Differential flame graphs compare two profiles to highlight what changed between versions. This is essential for performance regression analysis.

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

Interpreting a differential **wall-clock** flame graph from a payment service regression (a CPU profile would barely show this change, because a thread waiting on HTTP uses no CPU):

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

---

## JFR Flame Graphs in JDK Mission Control

Java Flight Recorder (JFR) is built into the JDK and captures events with minimal overhead:

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

