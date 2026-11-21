---
id: "track-03-lesson-13"
title: "Virtual Thread Pinning — Synchronized Blocks and Carrier Threads"
track: "track-03"
track-name: "Concurrency & Thread Safety Engineering"
sequence: 13
slug: "virtual-thread-pinning"
difficulty: "advanced"
estimated-minutes: 70
status: "published"
last-updated: "2026-11-07"

prerequisites:
  - "track-03-lesson-12"
  - "track-03-lesson-03"

tags:
  - "virtual-threads"
  - "pinning"
  - "synchronized"
  - "ReentrantLock"
  - "java-21"
  - "carrier-thread"
  - "JVM-flags"

java-versions: [21]

topics:
  - "What pinning is and when it occurs"
  - "synchronized as the primary pinning cause"
  - "native method pinning"
  - "Detecting pinning with JVM flags"
  - "Fixing pinning: synchronized → ReentrantLock"
  - "Third-party library pinning"
  - "Java 21 pinning monitoring"

components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: false
  knowledge-check: true
  practical-challenge: true

references:
  - "JEP 444 — Virtual Threads (Java 21)"
  - "Ron Pressler — Virtual Threads: What, Why, and How (JVM Summit 2023)"
  - "Spring Framework 6.1 — Virtual Thread Pinning Notes"
  - "Hibernate ORM — Virtual Thread Compatibility Notes"
---

## Overview

Virtual threads park on blocking I/O, freeing their carrier thread for other work. But there is a critical exception: **pinning**. When a virtual thread is pinned, it cannot be unmounted from its carrier thread even when blocking. The carrier thread blocks with it — exactly like a platform thread.

Pinning is the most important virtual thread compatibility concern for real-world financial applications. Legacy codebases built on platform threads typically contain hundreds of `synchronized` blocks — every one of them is a potential pinning point that silently degrades virtual thread performance.

This lesson covers what causes pinning, how to detect it, and the systematic refactoring approach for eliminating it.

> [!NOTE]
> **Java version matters.** On Java 21–23, blocking inside `synchronized` pins the carrier. **JDK 24 (JEP 491) removed this cause**: virtual threads can now unmount while holding a monitor. Native methods and foreign-function calls still pin on every version. If you can run on JDK 24+, most of the `synchronized` refactoring in this lesson becomes unnecessary — but many banks are still on Java 21 LTS, so the techniques remain important.

## Learning Objectives

By the end of this lesson you will be able to:

- Explain precisely what pinning is and why it occurs
- Identify the two root causes of pinning: `synchronized` blocks and native methods
- Enable pinning diagnostics with `-Djdk.tracePinnedThreads` (Java 21–23) and the JFR event `jdk.VirtualThreadPinned`
- Systematically audit a codebase for pinning hotspots
- Refactor `synchronized` blocks to `ReentrantLock` to eliminate pinning
- Identify third-party libraries with known pinning issues
- Apply the correct migration strategy for each pinning scenario

## What is Pinning?

A virtual thread is **pinned** when it cannot be unmounted from its carrier thread. While pinned, any blocking operation blocks the carrier OS thread — the virtual thread behaves identically to a platform thread.

```mermaid
sequenceDiagram
    participant VT as Virtual Thread
    participant CT as Carrier Thread (OS Thread)
    participant DB as Database

    Note over VT,CT: Normal (unpinned) blocking
    VT->>CT: mounted, running
    VT->>DB: JDBC query (blocking)
    VT-->>CT: UNMOUNTED — parks in heap
    Note over CT: Carrier is FREE to run other virtual threads
    DB-->>VT: result arrives
    VT->>CT: REMOUNTED on any available carrier

    Note over VT,CT: Pinned blocking
    VT->>CT: mounted, inside synchronized block
    VT->>DB: JDBC query (blocking, PINNED)
    Note over CT: Carrier BLOCKED — cannot run other virtual threads
    DB-->>CT: result arrives — carrier unblocks
```

## Causes of Pinning

### Cause 1: synchronized Blocks and Methods

On Java 21–23, a virtual thread inside a `synchronized` block (or `synchronized` method) **cannot be unmounted**. The HotSpot monitor implementation recorded the lock owner as the carrier thread, so the virtual thread could not leave the carrier while holding a monitor. Calling `Object.wait()` inside `synchronized` also pins. JDK 24 (JEP 491) changed the monitor implementation and removed this limitation.

```java21
// PINNING: virtual thread blocks inside synchronized — carrier is pinned
public class PinningExample {
    private final Object lock = new Object();
    private long balance;

    public long getBalance() {
        synchronized (lock) {           // Virtual thread enters monitor
            return database.fetch(id);  // Blocking I/O inside synchronized — PINNED
            // Carrier thread is blocked for the duration of the DB call
        }
    }
}

// NON-PINNING: ReentrantLock — virtual thread parks, carrier is freed
public class NonPinningExample {
    private final ReentrantLock lock = new ReentrantLock();
    private long balance;

    public long getBalance() {
        lock.lock();
        try {
            return database.fetch(id);  // Blocking I/O — virtual thread PARKS (not pinned)
            // Carrier thread is FREE to run other virtual threads
        } finally {
            lock.unlock();
        }
    }
}
```

> [!IMPORTANT]
> **Not all `synchronized` blocks cause harmful pinning.** A `synchronized` block that contains only fast, non-blocking operations (arithmetic, in-memory reads/writes) holds the carrier briefly and releases it. The performance impact is negligible. Pinning is only harmful when a blocking operation occurs **while the virtual thread is pinned** — the carrier blocks for the duration of the I/O wait.

### Cause 2: Native Methods and Foreign Functions

Virtual threads also pin when executing native methods (`native` keyword) or when inside a Foreign Function & Memory API call that calls native code. This is a JVM-level constraint — the native call stack cannot be represented as a heap object.

```java21
// Native methods pin virtual threads — cannot be avoided without changing the native code
// Common sources: JDBC drivers with native implementations, cryptographic libraries,
// file system APIs on some platforms, JNI calls

// Detection: JFR event jdk.VirtualThreadPinned with stacktrace shows the native frame
```

## Detecting Pinning

### JVM Flag: -Djdk.tracePinnedThreads

```java21
// JVM startup flag — prints a stack trace whenever a virtual thread is pinned
// Two severity levels:
//   full  — prints complete stack trace (verbose, good for initial audit)
//   short — prints only the pinning frame (less noise, good for ongoing monitoring)

// application startup (Java 21–23 only — the property was removed in JDK 24,
// where JFR is the way to find the remaining native-frame pinning):
// java -Djdk.tracePinnedThreads=full -jar payment-service.jar

// Simplified output when pinning occurs:
/*
Thread[#45,ForkJoinPool-1-worker-1,5,CarrierThreads]
    ...
    com.bank.payment.AccountService.getBalance(AccountService.java:42) <== monitors:1
    com.bank.payment.PaymentProcessor.process(PaymentProcessor.java:87)
*/
// "<== monitors:1" marks the frame that holds 1 monitor (the synchronized block)
```

### Java Flight Recorder (JFR)

```java21
// JFR event: jdk.VirtualThreadPinned
// Records: thread name, duration of pin, stack trace

// Enable during application run:
// jcmd <pid> JFR.start name=pinning-audit settings=default duration=60s filename=pinning.jfr
// jcmd <pid> JFR.stop name=pinning-audit

// Open in JDK Mission Control — filter for jdk.VirtualThreadPinned events
// Sort by duration to find the most impactful pinning hotspots

// Programmatic JFR (useful in integration tests) — jdk.jfr API:
// (the event's default threshold is 20ms; lower it to catch short pins)
try (Recording recording = new Recording()) {
    recording.enable("jdk.VirtualThreadPinned").withThreshold(Duration.ofMillis(10));
    recording.start();
    // ... run payment processing under load ...
    recording.stop();
    Path file = Files.createTempFile("pinning", ".jfr");
    recording.dump(file);
    List<RecordedEvent> events = RecordingFile.readAllEvents(file).stream()
        .filter(e -> e.getEventType().getName().equals("jdk.VirtualThreadPinned"))
        .toList();
}
```

### Programmatic Detection (Test-Level)

```java21
// In integration tests: assert that specific code paths do not pin
// Uses a JFR RecordingStream (JDK 14+; stop() is JDK 20+)
public class PinningTest {

    @Test
    public void paymentProcessing_shouldNotPinCarrierThread() throws Exception {
        AtomicLong pinnedCount = new AtomicLong(0);

        try (RecordingStream rs = new RecordingStream()) {
            rs.enable("jdk.VirtualThreadPinned").withThreshold(Duration.ZERO);
            rs.onEvent("jdk.VirtualThreadPinned", e -> pinnedCount.incrementAndGet());
            rs.startAsync();

            // Run the code under test on a virtual thread
            Thread vt = Thread.ofVirtual().start(() ->
                paymentService.processPayment(testRequest));
            vt.join();

            rs.stop();   // flushes remaining events before returning
        }

        // Assert no pinning occurred (or an agreed threshold)
        assertThat(pinnedCount.get()).isZero();
    }
}
```

## Fixing Pinning: synchronized → ReentrantLock

The standard fix for `synchronized`-caused pinning is replacing the intrinsic lock with `ReentrantLock`. The refactoring is mechanical:

```java21
// BEFORE: synchronized — causes pinning when blocking I/O occurs inside
public class AccountRepository {
    private final Object writeLock = new Object();

    public void updateBalance(String accountId, long newBalance) {
        synchronized (writeLock) {
            jdbcTemplate.update(                           // Blocking I/O — PINNED
                "UPDATE accounts SET balance=? WHERE id=?",
                newBalance, accountId
            );
            auditLog.write(accountId, newBalance);        // Blocking I/O — PINNED
        }
    }

    public synchronized AccountBalance findById(String accountId) {  // Method-level synchronized
        return jdbcTemplate.queryForObject(               // Blocking I/O — PINNED
            "SELECT * FROM accounts WHERE id=?",
            AccountBalance.ROW_MAPPER, accountId
        );
    }
}

// AFTER: ReentrantLock — virtual thread parks, carrier is freed
// (Design note: a JVM lock only protects ONE instance of the service. With
//  several instances, protect balances in the database — a row lock
//  (SELECT ... FOR UPDATE) or an atomic UPDATE — and drop the JVM lock.)
public class AccountRepository {
    private final ReentrantLock writeLock = new ReentrantLock();

    public void updateBalance(String accountId, long newBalance) {
        writeLock.lock();
        try {
            jdbcTemplate.update(                          // Blocking I/O — virtual thread PARKS
                "UPDATE accounts SET balance=? WHERE id=?",
                newBalance, accountId
            );
            auditLog.write(accountId, newBalance);        // Blocking I/O — virtual thread PARKS
        } finally {
            writeLock.unlock();                           // ALWAYS in finally
        }
    }

    // findById: does it even need a lock?
    // JDBC connections come from a pool — each call gets its own connection
    // No shared mutable state → no lock needed at all
    public AccountBalance findById(String accountId) {
        return jdbcTemplate.queryForObject(              // Lock removed entirely — correct
            "SELECT * FROM accounts WHERE id=?",
            AccountBalance.ROW_MAPPER, accountId
        );
    }
}
```

## Migration Strategy: Auditing a Codebase

For a large financial codebase, the migration is a phased audit:

```mermaid
flowchart TD
    Z{Can you run\non JDK 24+?} --> |Yes: synchronized\nno longer pins| A
    Z --> |No: Java 21-23| A
    A[Enable JFR jdk.VirtualThreadPinned\nor -Djdk.tracePinnedThreads=full] --> B[Run load test / integration suite]
    B --> C[Collect pinning stack traces]
    C --> D{Pinning source?}
    D --> |Own code synchronized| E[Replace with ReentrantLock]
    D --> |Third-party library| F[Check library virtual thread support]
    D --> |Native method| G[Isolate on platform thread pool]
    E --> H[Re-run load test]
    F --> |Fixed version available| I[Upgrade library]
    F --> |No fix available| G
    G --> J[Document as known pinning hotspot]
    H --> K{More pinning?}
    K --> |Yes| C
    K --> |No| L[Done]
```

## Third-Party Library Pinning

Libraries pinned for the same reasons as your own code: `synchronized` around socket I/O (Java 21–23) or native calls. Many libraries changed this in versions released after Java 21. The status changes from version to version, so **measure with JFR on your exact versions** instead of trusting a table:

| Library type | Typical pinning risk (Java 21–23) | What to check |
|---|---|---|
| **JDBC drivers** | Older drivers used `synchronized` around socket reads | Use versions that replaced it with locks (e.g. PostgreSQL pgjdbc 42.6.0+, MySQL Connector/J 9.0+) |
| **Connection pools (HikariCP, etc.)** | Pool acquisition paths | Release notes of your version; JFR under load |
| **ORM (Hibernate)** | Internal `synchronized` sections | Release notes; JFR under load |
| **Lettuce (Redis)** | Low — Netty-based, I/O runs off the caller thread | — |
| **Blocking clients (Jedis, older HTTP clients)** | `synchronized` around socket I/O in some versions | JFR under load; upgrade or isolate |
| **H2 (test DB)** | Heavy use of `synchronized` | Usually acceptable in tests only |
| **Your own code** | Most common source | `-Djdk.tracePinnedThreads` / JFR |

```java21
// Workaround for third-party library pinning: isolate on a platform thread pool
// The library code runs on a platform thread — pinning is irrelevant for platform threads
@Service
public class LegacyLibraryService {

    // Platform thread pool for code that cannot be fixed
    private final ExecutorService platformPool = Executors.newFixedThreadPool(
        20,
        Thread.ofPlatform().name("legacy-", 0).factory()
    );

    public CompletableFuture<Result> callLegacyLibrary(Request request) {
        // Offload to platform thread pool — virtual threads not involved
        return CompletableFuture.supplyAsync(
            () -> legacyLibrary.process(request), // Pinning on platform thread is harmless
            platformPool
        );
    }
}
```

## synchronized Blocks That Do NOT Need Fixing

Not every `synchronized` block needs refactoring. Apply the fix only when both conditions are true:

1. The `synchronized` block may execute on a virtual thread
2. A blocking operation (I/O, `sleep`, `Object.wait()`, another lock acquisition) occurs inside the block
3. You run on Java 21–23 (on JDK 24+, `synchronized` no longer pins)

```java21
// SAFE: synchronized with no blocking I/O — brief, non-pinning in practice
// (Technically still pins, but duration is so short it doesn't matter)
public class InMemoryCache {
    private final Map<String, Rate> cache = new HashMap<>();

    public synchronized Rate get(String key) {
        return cache.get(key);     // Pure memory access — microseconds
    }

    public synchronized void put(String key, Rate rate) {
        cache.put(key, rate);      // Pure memory access — microseconds
    }
    // Fine to leave as synchronized — no blocking I/O, pin duration is negligible
    // But ConcurrentHashMap would be better here anyway
}

// MUST FIX: synchronized with blocking I/O
public class DatabaseRepository {
    public synchronized Account findById(String id) {
        return jdbcTemplate.queryForObject(...); // Blocking — MUST fix to ReentrantLock
    }
}
```

---

<!-- KNOWLEDGE-CHECK [
  {
    "id": "kc-pin-01",
    "question": "On Java 21, a virtual thread is inside a `synchronized` block and calls `Thread.sleep(1000)`. What happens to the carrier thread?",
    "options": [
      "The carrier thread is freed for other virtual threads during the sleep",
      "The carrier thread blocks for 1000ms — it is pinned by the synchronized block",
      "An UnsupportedOperationException is thrown — sleep is not allowed in synchronized blocks",
      "The virtual thread is automatically upgraded to a platform thread"
    ],
    "correct": 1,
    "explanation": "On Java 21–23, synchronized blocks pin the virtual thread to its carrier thread. Any blocking operation inside a synchronized block — including Thread.sleep(), I/O, or Object.wait() — blocks the carrier OS thread for the duration. The carrier cannot run other virtual threads, which negates the benefit of virtual threads. The fix: replace synchronized with ReentrantLock (virtual threads park on ReentrantLock.lock() without pinning), or upgrade to JDK 24+, where JEP 491 removed this cause of pinning."
  },
  {
    "id": "kc-pin-02",
    "question": "What is the correct JVM flag to print a stack trace every time a virtual thread is pinned?",
    "options": [
      "-XX:+PrintVirtualThreadPinning",
      "-Djdk.tracePinnedThreads=full",
      "-Djava.util.concurrent.pinning=true",
      "-XX:VirtualThreadPinningThreshold=0"
    ],
    "correct": 1,
    "explanation": "-Djdk.tracePinnedThreads=full prints a stack trace (including the synchronized frame or native frame) whenever a virtual thread blocks while pinned. Use it during load testing to audit your codebase. The 'short' option prints a condensed trace. The property exists on Java 21–23 and was removed in JDK 24; the JFR event jdk.VirtualThreadPinned works on all versions and is better for production monitoring."
  },
  {
    "id": "kc-pin-03",
    "question": "An `AccountRepository` has `public synchronized AccountBalance findById(String id)` with a JDBC call inside. When migrated to virtual threads, what is the impact and what is the fix?",
    "options": [
      "No impact — synchronized on a repository method does not cause pinning",
      "Carrier thread pins for each DB call duration; fix by replacing synchronized with ReentrantLock or removing it if the method has no actual shared mutable state",
      "The method throws an exception on virtual threads",
      "The method automatically uses platform threads when synchronized is detected"
    ],
    "correct": 1,
    "explanation": "synchronized on a method is equivalent to synchronized(this). Inside, the JDBC call blocks — causing carrier thread pinning for the DB query duration. The fix has two steps: (1) determine if the lock is actually needed — most repository methods operate on a connection-pool connection, not shared mutable state, so the synchronized may be removable entirely. (2) If locking is genuinely needed, replace with ReentrantLock."
  },
  {
    "id": "kc-pin-04",
    "question": "An older version of your ORM library pins carrier threads on Java 21. The upgrade is blocked by other dependencies. What is the correct interim strategy?",
    "options": [
      "Disable virtual threads entirely until Hibernate is upgraded",
      "Run the ORM operations on a dedicated platform thread pool — pinning on platform threads is harmless",
      "Replace all Hibernate calls with JDBC to avoid pinning",
      "Increase the carrier thread pool size to 500 to absorb the pinning"
    ],
    "correct": 1,
    "explanation": "Platform threads are not affected by pinning — pinning is only a virtual thread concept. By offloading the ORM calls to a dedicated platform thread pool (CompletableFuture.supplyAsync(ormCall, platformPool)), the pinning happens on platform threads where it is irrelevant. The rest of the application can use virtual threads normally. This buys time for the upgrade without blocking the virtual thread migration."
  }
] -->

---

<!-- PRACTICAL-CHALLENGE {
  "id": "pc-virtual-thread-pinning",
  "title": "Pinning Audit and Remediation",
  "description": "Identify and eliminate virtual thread pinning in a payment service codebase.",
  "tasks": [
    {
      "id": "pc-pin-01",
      "description": "Enable -Djdk.tracePinnedThreads=full on a Spring Boot payment service and run your integration test suite. Capture all pinning stack traces. Categorise each by: own code synchronized, third-party library, native method. Count total pinning events per category."
    },
    {
      "id": "pc-pin-02",
      "description": "Refactor the top 3 pinning hotspots in your own code (synchronized with JDBC calls inside). Replace synchronized with ReentrantLock. Re-run the integration suite and confirm pinning events drop to zero for those methods. Verify correctness — the ReentrantLock must be released in finally."
    },
    {
      "id": "pc-pin-03",
      "description": "On Java 21, write a JMH benchmark comparing throughput of a payment service method (100ms JDBC call) run on (a) a 50-thread platform pool, (b) virtual threads with pinning (synchronized wrapping the JDBC call), (c) virtual threads without pinning (ReentrantLock). Measure ops/second at 200 concurrent requests. Expected for I/O-bound work: (c) >> (a) > (b), because pinned virtual threads are limited to the number of carriers. Then repeat (b) on JDK 24+ and explain the difference."
    },
    {
      "id": "pc-pin-04",
      "description": "Implement a Spring Boot health indicator that uses a JFR RecordingStream to count jdk.VirtualThreadPinned events per minute. Set health to WARN if more than 10 pinning events per minute are recorded in production. Document the threshold rationale."
    }
  ]
} -->
