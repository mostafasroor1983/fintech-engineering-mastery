---
id: track-11-lesson-06
title: "JVM Diagnostics — Thread Dumps and Heap Analysis in Production"
slug: jvm-diagnostics
track: track-11
trackName: "Security & Observability"
sequence: 6
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [JVM-diagnostics, thread-dump, heap-dump, JFR, jcmd]
prerequisites: [track-11-lesson-05]
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

`jcmd` finds JVMs through `/tmp/hsperfdata_<user>/` and talks to them over the attach socket. It is safe for production: a thread dump stops the threads only briefly at a safepoint (typically milliseconds). It must run as the same user as the JVM — in Kubernetes via `kubectl exec`, or an ephemeral debug container (`kubectl debug --target=<container>`) when the image (e.g. distroless or a JRE) has no JDK tools.

**Method 2: jstack**

```bash
# Same result as jcmd Thread.print, different interface
jstack -l 12345 > /tmp/thread-dump.txt

# JVM completely unresponsive to the attach mechanism (JDK 9+: the old
# "jstack -F" moved to the serviceability agent)
jhsdb jstack --pid 12345 > /tmp/thread-dump-forced.txt
```

> [!WARNING]
> `jhsdb jstack` reads the process from the outside and suspends it for the whole read. Use it only when the JVM no longer answers `jcmd` at all.

**Method 3: kill -3 (last resort on Linux)**

```bash
# Sends SIGQUIT signal; JVM prints thread dump to stdout/stderr
kill -3 12345
# Output goes to process stdout — for systemd: journalctl -u payment-service --since "1 minute ago"
```

**Method 4: Spring Boot Actuator endpoint**

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

**Symptom**: Payment API returns 503s or times out despite the application being up. No Tomcat worker is idle (idle workers wait in `TaskQueue.poll`). The thread *state* alone does not tell the whole story — look at the stack frames:
- workers waiting for a free JDBC connection are `TIMED_WAITING (parking)` inside `HikariPool.getConnection`;
- workers stuck in a slow query are `RUNNABLE` in a socket read inside the JDBC driver;
- workers waiting for a lock are `BLOCKED` (synchronized) or `WAITING (parking)` (j.u.c locks).

```bash
# Count threads by state
jcmd 12345 Thread.print | grep "java.lang.Thread.State" | sort | uniq -c | sort -rn

# Exhaustion indicator: no worker idle in TaskQueue.poll
jcmd 12345 Thread.print | grep -c "TaskQueue.poll"    # 0 idle workers

# Find where the workers are stuck
jcmd 12345 Thread.print | grep -A 25 "http-nio-8080-exec" \
  | grep -E "HikariPool.getConnection|SocketInputStream|socketRead|PgStatement" | sort | uniq -c
```

Typical finding: almost all 200 Tomcat workers wait in `HikariPool.getConnection`, because the 20 connections are held by requests stuck in slow queries. The fix path: check HikariCP metrics (`hikaricp_connections_pending`, acquire time) → find the slow queries holding connections → optimize them. Increasing the pool size only helps if the database has spare capacity.

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

## Deadlock Detection

Deadlocks in payment services are rare but catastrophic—they silently halt all transaction processing. The JVM detects deadlocks between `synchronized` monitors and `java.util.concurrent` locks (ownable synchronizers, shown with `-l`) and reports them at the bottom of the thread dump.

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
# Collect heap dump to a file. By default only LIVE objects are dumped,
# which first runs a full GC; add -all to skip that GC (bigger file)
jcmd 12345 GC.heap_dump /tmp/heap-$(date +%Y%m%d-%H%M%S).hprof

# File size is roughly the used heap (at most about -Xmx):
# a 4GB heap with 2.5GB in use produces a ~2-3GB dump -- check disk space
```

> [!WARNING]
> Heap dump collection requires a stop-the-world pause. For a 4GB heap, this pause can be 10-30 seconds. Notify on-call team before collecting in production — and take the instance out of the load balancer first if possible. Treat the `.hprof` file as **highly sensitive data**: it contains every secret and customer record in memory. Store it encrypted, restrict access, and delete it after the analysis.

**Method 2: jmap with live filter**

```bash
# 'live' triggers a full GC first — smaller file, but longer pause
# (same behaviour as jcmd GC.heap_dump; jcmd is the preferred interface)
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

**Method 4: Spring Boot Actuator**

```bash
# Downloads heap dump as hprof file — suitable for smaller heaps (< 1GB);
# internal management port with authentication only (see above)
curl -O http://payment-service:8081/actuator/heapdump
```

Point `HeapDumpPath` at a directory, not a file: the JVM never overwrites an existing dump file, so after the first OOM a fixed file name would silently prevent all later dumps.

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
-- MAT's OQL works on objects and their FIELDS (no ORDER BY / GROUP BY;
-- use the Histogram view for counts and its column sorting for ordering)

-- Find large HashMaps (HashMap stores its size in the "size" field)
SELECT * FROM java.util.HashMap m WHERE m.size > 100000

-- List cache entries with their transaction IDs and creation time
SELECT toString(s.transactionId), s.createdAt
FROM com.example.payment.TransactionCacheEntry s
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

## Java Flight Recorder (JFR)

JFR is a low-overhead continuous profiling framework built into the JVM (open source since JDK 11, also in 8u262+). Unlike heap/thread dumps which are point-in-time, JFR records a continuous stream of events—method profiling, GC events, I/O, exceptions, thread locks. With the `default` settings the overhead is about 1%; the `profile` settings collect more detail at a somewhat higher cost and suit shorter, targeted recordings.

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
# ("default" settings for always-on; switch to "profile" for short recordings)
-XX:StartFlightRecording=name=continuous,maxage=1h,maxsize=250m,disk=true,settings=default
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

Lock contention in `AuditService` indicates a synchronized audit logger blocking payment threads. Batch the writes asynchronously — but **never drop audit events**: in a payment system the audit trail is a regulatory record, so a full queue must fall back to a synchronous write (back-pressure), not to discarding. (For audit records that must be exactly as durable as the payment itself, write them in the payment's own DB transaction, e.g. via an outbox table.)

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

**Class histogram** is the fastest leak detector available — far cheaper than a heap dump, though the default (live) mode does cause a full-GC pause:

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

## Production Diagnostic Workflow

When PagerDuty fires for high memory or slow response on a payment service:

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

## Monitoring JVM Health with Micrometer

Don't wait for a production incident—alert proactively on JVM health metrics.

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

## Key Takeaways

- Use `jcmd <pid> Thread.print -l` for thread dumps; collect three 10 seconds apart before concluding
- Thread states narrow the search, but the stack frames tell the story: no idle worker in `TaskQueue.poll` means the pool is exhausted, and the frames show whether workers wait for a connection, a lock, or a slow query
- JFR with `maxage=1h` always-on recording (default settings, ~1% overhead) lets you diagnose incidents retrospectively—enable this on every production JVM
- Eclipse MAT's dominator tree shows the objects retaining the most memory; retained heap is the meaningful metric, not shallow heap
- Class histograms (`jcmd GC.class_histogram`) provide fast leak detection without a heap dump — use them first (`-all` avoids the full GC)
- Heap dumps contain secrets and customer data: never expose `/actuator/heapdump` publicly, and handle `.hprof` files as sensitive
- In Spring Boot payment services, the most common leak sources are: unbounded caches, ThreadLocal not cleaned up in Tomcat threads, Hibernate L1 cache accumulation in batch jobs
- Configure `-XX:+HeapDumpOnOutOfMemoryError` and `-XX:+ExitOnOutOfMemoryError` on all production JVMs—the heap dump from the crash is your only evidence

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the safest way to take a heap dump from a production JVM with the least application pause?",
      "options": [
        "jmap -dump:format=b,file=heap.hprof <pid>",
        "jcmd <pid> GC.heap_dump /tmp/heap.hprof",
        "Kill the process with SIGQUIT",
        "curl http://service/actuator/heapdump"
      ],
      "correct": 1,
      "explanation": "jcmd GC.heap_dump is the recommended interface: it uses the attach mechanism, writes the dump inside the JVM, and offers -all to skip the full GC that a live-objects dump needs. Note that every heap dump is a stop-the-world operation — jcmd GC.heap_dump and jmap -dump:live both run a full GC first by default — so take the instance out of rotation if you can. SIGQUIT only produces thread dumps, not heap dumps. The actuator endpoint is acceptable for small heaps but transfers a large, highly sensitive file over HTTP and must never be exposed publicly."
    },
    {
      "text": "In Eclipse MAT's dominator tree, which metric is most useful for identifying the root cause of a memory leak?",
      "options": [
        "Shallow heap — the size of the object itself",
        "Retained heap — total memory freed if this object were collected",
        "Instance count — the number of objects of this class",
        "Reference count — the number of references to this object"
      ],
      "correct": 1,
      "explanation": "Retained heap represents the total memory that would be freed if a given object were garbage collected — including all objects exclusively reachable through it. This is the meaningful metric for leak detection because it shows the full cost of keeping a reference alive, not just the object's own footprint."
    },
    {
      "text": "What does the presence of multiple threads in BLOCKED state in a thread dump most commonly indicate?",
      "options": [
        "The JVM is performing garbage collection",
        "Lock contention — threads are waiting to acquire a monitor held by another thread",
        "The threads are waiting for I/O operations to complete",
        "The thread pool is idle, waiting for new work"
      ],
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
    {
      "id": "1",
      "description": "Configure a Spring Boot payment service with always-on JFR recording (default settings, maxage=2h, maxsize=512m), heap dump on OOM into a dedicated directory, actuator diagnostics only on an internal management port, and Micrometer JVM metrics exported to Prometheus. Verify that JVM heap, GC pause, and thread state metrics appear in Grafana."
    },
    {
      "id": "2",
      "description": "Introduce and diagnose a ThreadLocal leak: add a ThreadLocal to hold payment context that is never removed in the filter chain. Run load for 10 minutes, capture a class histogram with jcmd GC.class_histogram, identify the growing class, then fix the leak and verify heap stabilizes."
    },
    {
      "id": "3",
      "description": "Create a deadlock scenario between two payment processing threads acquiring AccountLock and TransactionLock in opposite orders. Collect three thread dumps 10 seconds apart using jcmd Thread.print, identify the deadlock section, and fix the code by enforcing consistent lock acquisition order."
    },
    {
      "id": "4",
      "description": "Run a 5-minute load test, then dump the JFR recording and open it in JDK Mission Control. Identify the top method by CPU samples, the top allocation class by allocated bytes, and any GC pauses exceeding 100ms. Propose and implement one optimization based on these findings."
    }
  ]
}
-->

