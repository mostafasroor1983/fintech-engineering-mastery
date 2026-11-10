---
id: track-13-lesson-06
title: "JVM Diagnostics — Thread Dumps and Heap Analysis in Production"
slug: jvm-diagnostics
track: track-13
trackName: "Security & Observability"
sequence: 6
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [JVM-diagnostics, thread-dump, heap-dump, JFR, jcmd]
prerequisites: [track-13-lesson-05]
---

# JVM Diagnostics — Thread Dumps and Heap Analysis in Production

> [!NOTE]
> When a payment service starts responding slowly or leaking memory in production, you have minutes—not hours—to diagnose the problem without restarting the JVM and losing the evidence. Mastering JVM diagnostics tools is the difference between a 15-minute resolution and a multi-hour outage.

## Why JVM Diagnostics Matter in Fintech

Production JVM issues in payment systems are uniquely high-stakes. A thread pool exhausted by slow database queries means payments stall. A heap leak that causes GC pressure triggers cascading latency across the transaction pipeline. Unlike stateless services, the JVM holds live state: active transactions, connection pools, in-flight messages. You cannot simply restart to investigate—you need to extract diagnostics while the process is alive.

This lesson covers the full diagnostic toolkit: thread dumps for concurrency issues, heap dumps for memory problems, and Java Flight Recorder for continuous profiling. Every command and technique is validated for use against live production JVMs with minimal performance impact.

---

## Thread Dump Collection

A thread dump is a point-in-time snapshot of every thread's stack trace and state. For concurrency issues—deadlocks, thread pool saturation, lock contention—it is the primary diagnostic artifact.

### Collection Methods

**Method 1: jcmd (preferred for production)**

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

`jcmd` attaches to the JVM via the UNIX domain socket in `/tmp/hsperfdata_<user>/`. It is non-disruptive and does not pause the JVM.

**Method 2: jstack**

```bash
# Same result as jcmd Thread.print, different interface
jstack 12345 > /tmp/thread-dump.txt

# Force attach if JVM is unresponsive (use cautiously in production)
jstack -F 12345 > /tmp/thread-dump-forced.txt
```

> [!WARNING]
> `jstack -F` forces a thread dump by suspending all threads. Avoid in production unless the JVM is completely unresponsive—it pauses the entire service momentarily.

**Method 3: kill -3 (last resort on Linux)**

```bash
# Sends SIGQUIT signal; JVM prints thread dump to stdout/stderr
kill -3 12345
# Output goes to process stdout — for systemd: journalctl -u payment-service --since "1 minute ago"
```

**Method 4: Spring Boot Actuator endpoint**

```yaml
# application.yml
management:
  endpoints:
    web:
      exposure:
        include: threaddump, heapdump, health, metrics
  endpoint:
    threaddump:
      enabled: true
```

```bash
# Collect via HTTP (useful when kubectl exec is unavailable)
curl -s http://payment-service:8080/actuator/threaddump \
  | jq '.threads[] | {name: .threadName, state: .threadState}' \
  | head -50
```

### Collecting Multiple Snapshots

A single thread dump is rarely enough. Collect three dumps 10 seconds apart to distinguish transient conditions from persistent problems:

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

## Understanding Thread States

Each thread in the dump carries a state that immediately narrows the diagnostic space.

### Thread State Reference

| State | Meaning | Common Cause in Payment Services |
|-------|---------|----------------------------------|
| `RUNNABLE` | Executing or ready to execute | Normal execution; high count suggests CPU saturation |
| `BLOCKED` | Waiting to acquire a `synchronized` lock | Lock contention on shared caches or connection pools |
| `WAITING` | Indefinitely waiting (`Object.wait()`, `LockSupport.park()`) | Thread pool idle threads; event-driven code waiting for work |
| `TIMED_WAITING` | Waiting with timeout (`sleep`, `wait(timeout)`) | Expected for timeout-based polling; excessive count means slow upstream |
| `NEW` | Thread created but not started | Unusual if persistent |
| `TERMINATED` | Thread completed | Normal; typically cleaned up quickly |

### Reading a Thread Dump Entry

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

Key fields:
- Thread name: `http-nio-8080-exec-42` — Tomcat HTTP worker thread 42
- State: `TIMED_WAITING (parking)` — idle, waiting for work from the queue
- `cpu=234.17ms elapsed=892.45s` — thread alive 892 seconds but only used 234ms CPU (healthy idle)

### Diagnosing Thread Pool Exhaustion

**Symptom**: Payment API returns 503 errors despite the application being up. All Tomcat threads are `RUNNABLE` or `BLOCKED`, none are in `TIMED_WAITING`.

```bash
# Count threads by state
jcmd 12345 Thread.print | grep "java.lang.Thread.State" | sort | uniq -c | sort -rn

# Exhaustion indicator:
#  200 java.lang.Thread.State: RUNNABLE
#    0 java.lang.Thread.State: TIMED_WAITING (parking)

# Find what those RUNNABLE threads are doing
jcmd 12345 Thread.print | grep -A 25 "http-nio-8080-exec" | grep -E "RUNNABLE|jdbc|postgres|HikariPool"
```

Typical finding: all 200 Tomcat threads are blocked waiting for a JDBC connection from HikariCP because the pool is exhausted. The fix path: check HikariCP metrics → find slow queries holding connections → optimize query or increase pool size.

```java
// HikariCP configuration for payment services
@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("spring.datasource.hikari")
    public HikariDataSource dataSource() {
        HikariDataSource ds = new HikariDataSource();
        ds.setMaximumPoolSize(20);
        ds.setMinimumIdle(5);
        ds.setConnectionTimeout(3000);      // 3s timeout — fail fast
        ds.setIdleTimeout(600000);          // 10 min idle
        ds.setMaxLifetime(1800000);         // 30 min max
        ds.setLeakDetectionThreshold(60000); // Warn if connection held > 60s
        ds.setMetricsTrackerFactory(
            new MicrometerMetricsTrackerFactory(meterRegistry)
        );
        return ds;
    }
}
```

---

## Deadlock Detection

Deadlocks in payment services are rare but catastrophic—they silently halt all transaction processing. The JVM detects deadlocks involving `synchronized` blocks automatically and reports them at the bottom of the thread dump.

### Identifying Deadlocks

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

**Root cause**: Two threads acquire the same two locks in opposite order.

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

## Heap Dump Collection

Heap dumps capture the complete state of the JVM heap—every object, its size, and references between them. They are the primary tool for diagnosing memory leaks and `OutOfMemoryError`.

### Collection Methods

**Method 1: jcmd (live JVM, preferred)**

```bash
# Collect heap dump to a file (triggers stop-the-world pause)
jcmd 12345 GC.heap_dump /tmp/heap-$(date +%Y%m%d-%H%M%S).hprof

# File size is typically 1-3x the heap size (-Xmx)
# A 4GB heap produces a ~2-3GB dump file
```

> [!WARNING]
> Heap dump collection requires a stop-the-world pause. For a 4GB heap, this pause can be 10-30 seconds. Notify on-call team before collecting in production.

**Method 2: jmap with live filter**

```bash
# 'live' triggers GC first — reduces file size significantly by excluding dead objects
jmap -dump:live,format=b,file=/tmp/heap.hprof 12345
```

**Method 3: Automatic on OOM (always configure this)**

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
    - name: JAVA_OPTS
      value: >-
        -Xms2g -Xmx4g
        -XX:+HeapDumpOnOutOfMemoryError
        -XX:HeapDumpPath=/heap-dumps/heap.hprof
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

**Method 4: Spring Boot Actuator**

```bash
# Downloads heap dump as hprof file — suitable for smaller heaps (< 1GB)
curl -O http://payment-service:8080/actuator/heapdump
```

---

## Eclipse MAT Analysis

Eclipse Memory Analyzer Tool (MAT) is the standard tool for heap dump analysis. Download from eclipse.dev/mat. For large dumps (>2GB), increase MAT's own heap: edit `MemoryAnalyzer.ini`, set `-Xmx6g`.

### Key Concepts

**Shallow heap**: Memory consumed by the object itself—its fields and references (pointers), not the objects they point to. Typically small (dozens of bytes).

**Retained heap**: Memory that would be freed if this object were garbage collected—includes all objects only reachable through this object. This is the meaningful metric for leak analysis.

**Dominator tree**: A tree where each node dominates its subtree. If you remove node X, all objects in its subtree become unreachable. The dominator tree immediately shows the objects retaining the most memory.

### Analyzing a Payment Service Heap Dump

**Step 1: Run the Leak Suspects report**

MAT automatically generates a "Leak Suspects" report on opening. For a payment service with an unbounded session cache:

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

**Step 2: Examine the dominator tree**

```
Dominator Tree — Top Retained Heap
====================================
Class Name                                  Shallow    Retained
com.example.payment.TransactionCacheService    48 B    2,847 MB  (68%)
  └─ java.util.concurrent.ConcurrentHashMap   112 B    2,847 MB
       └─ Node[]                              2.1 GB    2.1 GB
            └─ TransactionCacheEntry[]          ...       ...
```

**Step 3: Inspect with OQL (Object Query Language)**

```sql
-- Find all large collections
SELECT * FROM java.util.Map WHERE size() > 100000

-- Find oldest cache entries (sort by creation time)
SELECT s.transactionId, s.createdAt, s.amount
FROM com.example.payment.TransactionCacheEntry s
ORDER BY s.createdAt ASC

-- Count by class
SELECT l.class.name, count(*) FROM java.lang.Object l GROUP BY l.class.name
```

**Step 4: Fix the leak**

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
            .recordStats()                            // Micrometer integration
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

## Java Flight Recorder (JFR)

JFR is a low-overhead continuous profiling framework built into the JVM (JDK 11+). Unlike heap/thread dumps which are point-in-time, JFR records a continuous stream of events—method profiling, GC events, I/O, exceptions, thread locks—with less than 2% overhead.

### Starting JFR on a Running JVM

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

### Always-On Recording (Recommended for Production)

```bash
# JVM startup flags — keeps a rolling 1-hour window on disk
-XX:StartFlightRecording=name=continuous,maxage=1h,maxsize=250m,disk=true,settings=profile
```

When an incident occurs, dump the last hour of recordings without restarting:

```bash
jcmd 12345 JFR.dump name=continuous filename=/tmp/incident-$(date +%Y%m%d-%H%M%S).jfr
```

This is the most valuable production debugging capability: retroactive profiling from before the incident started.

### Analyzing JFR with JDK Mission Control

Download JDK Mission Control (JMC) from adoptium.net. Key analysis views:

**Method Profiling** — Where is CPU time spent?

```
Hot Methods (self time)
=======================
com.example.payment.FraudScoreCalculator.calculate()     34.2%
java.util.regex.Pattern.matcher()                         8.7%   <- suspicious
com.example.payment.IbanValidator.validate()              7.1%   <- suspicious
org.hibernate.dialect.PostgreSQLDialect.toString()        4.2%
```

Regex matching in hot payment processing paths is a common performance issue. Pre-compile patterns:

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

**Lock Analysis** — Where is lock contention occurring?

```
Lock Events
===========
java.util.logging.Logger (synchronized)    Count: 42,891   Avg wait: 2.3ms
com.example.payment.AuditService           Count: 18,234   Avg wait: 4.7ms
```

Lock contention in `AuditService` indicates a synchronized audit logger blocking payment threads. Replace with an async queue:

```java
@Component
public class AuditService {
    private final BlockingQueue<AuditEvent> auditQueue =
        new LinkedBlockingQueue<>(10_000);  // Bounded — prevents memory growth

    private final Counter auditDropCounter;

    public AuditService(MeterRegistry registry) {
        this.auditDropCounter = registry.counter("audit.events.dropped");
    }

    // Called from payment thread — must be non-blocking
    public void recordPayment(PaymentAuditEvent event) {
        boolean offered = auditQueue.offer(event);
        if (!offered) {
            // Drop is acceptable for audit; never block the payment thread
            log.warn("Audit queue full, dropping event txId={}", event.getTransactionId());
            auditDropCounter.increment();
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
}
```

**GC Analysis** — Garbage collection pressure patterns:

```
GC Events
=========
G1 Young Generation Collections: 1,842 events
  Avg pause: 12ms, Max pause: 487ms   <- 487ms pause will cause timeout failures

G1 Full Collections: 3 events         <- Any full GC is a problem in production
  Avg pause: 8,432ms                  <- 8 second pause = complete payment outage
```

Full GCs indicate heap pressure. Investigate: heap sized too small? Allocation rate too high? Memory leak? The JFR GC detail view shows allocation hotspots—where objects are being allocated fastest.

---

## jcmd Diagnostic Commands Reference

```bash
# List all available commands for a PID
jcmd 12345 help

# JVM flags (what flags are active)
jcmd 12345 VM.flags

# System properties
jcmd 12345 VM.system_properties

# Class histogram — top classes by instance count (no heap dump required, low impact)
jcmd 12345 GC.class_histogram | head -30
# Output format:
#  num     #instances         #bytes  class name
# -------------------------------------------------------
#    1:       4,234,891    135,516,512  com.example.payment.TransactionCacheEntry
#    2:         892,344     42,832,512  java.lang.String

# Memory usage breakdown by JVM memory areas
jcmd 12345 VM.native_memory

# Run GC (clear garbage before collecting heap dump to reduce dump size)
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

**Class histogram** is the fastest leak detector available—it requires no heap dump pause:

```bash
# Collect histograms 60 seconds apart and diff them
jcmd 12345 GC.class_histogram > /tmp/hist1.txt
sleep 60
jcmd 12345 GC.class_histogram > /tmp/hist2.txt

# If TransactionCacheEntry count increased by thousands in 60 seconds, it is leaking
```

---

## Diagnosing Memory Leaks in Spring Boot Payment Services

### Common Leak Patterns and Fixes

**Pattern 1: ThreadLocal leak in Tomcat thread pools**

Tomcat reuses worker threads. A ThreadLocal set during one request but not removed persists into the next request on the same thread.

```java
// WRONG — ThreadLocal never cleaned up
public class PaymentContextHolder {
    private static final ThreadLocal<PaymentContext> CONTEXT = new ThreadLocal<>();
    public static void set(PaymentContext ctx) { CONTEXT.set(ctx); }
    // Missing: remove() call — payment context from one request leaks into next
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

**Pattern 2: Hibernate L1 cache in batch processing**

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

**Pattern 3: Listener not deregistered**

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
        // Listener is never unregistered — PaymentEventService cannot be GC'd
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

## Production Diagnostic Workflow

When PagerDuty fires for high memory or slow response on a payment service:

```
PHASE 1 — SAFE (zero JVM impact)
  jcmd <pid> VM.flags                  Confirm heap size settings
  jcmd <pid> GC.class_histogram        Check for obvious leak classes
  GET /actuator/metrics/jvm.memory.used  Current heap consumption
  GET /actuator/metrics/jvm.gc.pause   Recent GC pause times

PHASE 2 — THREAD ANALYSIS (minimal impact, < 1ms)
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

## Monitoring JVM Health with Micrometer

Don't wait for a production incident—alert proactively on JVM health metrics.

```yaml
# prometheus-alerts.yml
groups:
  - name: jvm_health
    rules:
      - alert: JvmHeapPressure
        expr: |
          jvm_memory_used_bytes{area="heap"}
          / jvm_memory_max_bytes{area="heap"} > 0.85
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
        expr: |
          increase(jvm_gc_live_data_size_bytes[1h]) > 100 * 1024 * 1024
        for: 2h
        labels:
          severity: warning
        annotations:
          summary: "JVM live data growing > 100MB/hour — possible memory leak"

      - alert: JvmThreadPoolExhaustion
        expr: |
          jvm_threads_states_threads{state="BLOCKED"}
          / jvm_threads_live_threads > 0.5
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "More than 50% of threads BLOCKED — probable lock contention or pool exhaustion"
```

---

## Key Takeaways

- Use `jcmd <pid> Thread.print -l` for thread dumps; collect three 10 seconds apart before concluding
- Thread states tell you the story immediately: all RUNNABLE with no TIMED_WAITING means thread pool exhaustion
- JFR with `maxage=1h` always-on recording lets you diagnose incidents retrospectively with under 2% overhead—enable this on every production JVM
- Eclipse MAT's dominator tree shows the objects retaining the most memory; retained heap is the meaningful metric, not shallow heap
- Class histograms (`jcmd GC.class_histogram`) provide fast leak detection without a heap dump pause—use them first
- In Spring Boot payment services, the most common leak sources are: unbounded caches, ThreadLocal not cleaned up in Tomcat threads, Hibernate L1 cache accumulation in batch jobs
- Configure `-XX:+HeapDumpOnOutOfMemoryError` and `-XX:+ExitOnOutOfMemoryError` on all production JVMs—the heap dump from the crash is your only evidence

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the safest way to take a heap dump from a production JVM with the least application pause?",
      "options": ["jmap -dump:format=b,file=heap.hprof <pid>", "jcmd <pid> GC.heap_dump /tmp/heap.hprof", "Kill the process with SIGQUIT", "curl http://service/actuator/heapdump"],
      "correct": 1,
      "explanation": "jcmd GC.heap_dump is the recommended approach because it requires only a brief stop-the-world pause to enumerate live objects. jmap triggers a full GC first, which can pause the JVM for many seconds in production. SIGQUIT only produces thread dumps, not heap dumps. The actuator endpoint is acceptable for small heaps but transfers data over HTTP which adds latency."
    },
    {
      "text": "In Eclipse MAT's dominator tree, which metric is most useful for identifying the root cause of a memory leak?",
      "options": ["Shallow heap — the size of the object itself", "Retained heap — total memory freed if this object were collected", "Instance count — the number of objects of this class", "Reference count — the number of references to this object"],
      "correct": 1,
      "explanation": "Retained heap represents the total memory that would be freed if a given object were garbage collected — including all objects exclusively reachable through it. This is the meaningful metric for leak detection because it shows the full cost of keeping a reference alive, not just the object's own footprint."
    },
    {
      "text": "What does the presence of multiple threads in BLOCKED state in a thread dump most commonly indicate?",
      "options": ["The JVM is performing garbage collection", "Lock contention — threads are waiting to acquire a monitor held by another thread", "The threads are waiting for I/O operations to complete", "The thread pool is idle, waiting for new work"],
      "correct": 1,
      "explanation": "BLOCKED state specifically means a thread is waiting to acquire an object monitor (synchronized block/method) that is held by another thread. This indicates lock contention. WAITING/TIMED_WAITING are for sleep/wait operations. RUNNABLE includes threads doing I/O. A high proportion of BLOCKED threads is a signal of lock contention or potential deadlock."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Diagnose and Resolve JVM Memory and Thread Issues in a Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 80,
  "tasks": [
    {"id": "1", "description": "Configure a Spring Boot payment service with always-on JFR recording (maxage=2h, maxsize=512m), heap dump on OOM, and Micrometer JVM metrics exported to Prometheus. Verify that JVM heap, GC pause, and thread state metrics appear in Grafana."},
    {"id": "2", "description": "Introduce and diagnose a ThreadLocal leak: add a ThreadLocal to hold payment context that is never removed in the filter chain. Run load for 10 minutes, capture a class histogram with jcmd GC.class_histogram, identify the growing class, then fix the leak and verify heap stabilizes."},
    {"id": "3", "description": "Create a deadlock scenario between two payment processing threads acquiring AccountLock and TransactionLock in opposite orders. Collect three thread dumps 10 seconds apart using jcmd Thread.print, identify the deadlock section, and fix the code by enforcing consistent lock acquisition order."},
    {"id": "4", "description": "Run a 5-minute load test, then dump the JFR recording and open it in JDK Mission Control. Identify the top method by CPU samples, the top allocation class by allocated bytes, and any GC pauses exceeding 100ms. Propose and implement one optimization based on these findings."}
  ]
}
-->

