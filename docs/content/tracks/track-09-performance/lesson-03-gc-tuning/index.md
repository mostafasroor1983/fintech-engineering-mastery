---
id: "track-09-lesson-03"
title: "GC Tuning — G1GC and ZGC for Low-Latency Finance"
track: "track-09"
track-name: "Performance Engineering"
sequence: 3
slug: "gc-tuning"
difficulty: "advanced"
estimated-minutes: 85
status: "published"
last-updated: "2026-11-08"

prerequisites: ["track-09-lesson-01", "track-09-lesson-02"]

tags:
  - "GC-tuning"
  - "G1GC"
  - "ZGC"
  - "heap-sizing"
  - "latency"

java-versions: [17, 21]

topics:
  - "G1GC Architecture and Region Model"
  - "G1GC Tuning Flags"
  - "ZGC Sub-millisecond Pauses"
  - "Heap Sizing for Payment Services"
  - "GC Ergonomics"
  - "Humongous Object Handling"
  - "GC Log Analysis"
  - "ZGC vs G1GC Tradeoffs"

components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "OpenJDK G1GC Tuning Guide — openjdk.org"
  - "ZGC — A Scalable Low-Latency Garbage Collector — Per Liden (2018)"
  - "JVM Performance Engineering — Monica Beckwith"
  - "Java Performance — Scott Oaks (2nd ed.)"
---

## Overview

Garbage collection pauses are among the most insidious latency sources in Java-based payment systems. A 200 ms stop-the-world pause during peak settlement is not a JVM curiosity — it is a customer-visible outage, a potential SLA breach, and in some jurisdictions a regulatory reporting event. Understanding and tuning the garbage collector is therefore a core competency for any engineer operating high-throughput financial infrastructure on the JVM.

This lesson dissects the two collectors that dominate production fintech deployments: **G1GC** (the default since Java 9) and **ZGC** (production-ready since Java 15, with generational support in Java 21). You will understand their internal mechanics, learn which flags actually move the needle, size heaps correctly for payment workload shapes, and diagnose GC problems from logs before they become incidents.

> [!NOTE]
> The single most impactful GC tuning decision is usually heap size and object allocation rate — not collector flag tweaking. Profile allocation first, tune flags second.

## Learning Objectives

By the end of this lesson you will be able to:

- Explain the G1GC region model and how it drives pause-time goals
- Apply the critical G1GC flags with justification
- Configure ZGC for sub-millisecond pauses on payment services
- Size JVM heaps correctly given transaction throughput and object lifetimes
- Identify humongous object problems and fix them
- Read GC logs to distinguish minor issues from pre-failure patterns
- Choose between G1GC and ZGC for a given financial workload

---

## 1. Why GC Pauses Hurt Finance More Than Other Domains

Consider a card-present POS authorisation path. The issuer has 150 ms to respond before the terminal times out. The network round trip consumes ~40 ms. TLS handshake and connection setup consume another ~20 ms. The remaining ~90 ms is the entire budget for your Java service — including deserialization, database lookup, fraud check, and serialisation.

A single G1GC full GC pause on a service with a 4 GB heap and poor tuning can easily consume 500 ms. Even a mixed GC pause with default settings can reach 50–80 ms. The math is unforgiving.

```
Payment authorisation SLA: 150 ms end-to-end
Network + TLS:              60 ms
Database round trip:        20 ms
Available for Java service: 70 ms
Default G1GC mixed pause:   50–80 ms  <-- catastrophic overlap
```

Three scenarios where GC pauses cause direct financial harm:

1. **Real-time authorisation** — pause breaches issuer response timeout; transaction declines
2. **Market data processing** — stale prices during pause window cause missed fills or bad executions
3. **Settlement batch windows** — 2-hour regulatory window; GC-induced slowdown risks deadline miss

---

## 2. G1GC Architecture — The Region Model

G1GC divides the heap into equal-sized **regions** (1–32 MB, always a power of two). Unlike previous collectors, there is no fixed young/old generation boundary on the address space. Instead, regions are tagged dynamically:

```
Heap (8 GB, 512 regions of 16 MB each)
+---------+---------+---------+---------+
|  Eden   |  Eden   |  Surv   |  Old    |
|  Eden   |  Old    |  Old    |  Eden   |
|  Surv   |  Old    |  Free   |  Humong |
+---------+---------+---------+---------+
E = Eden   S = Survivor   O = Old   H = Humongous   F = Free
```

**Key insight**: G1 collects regions with the most garbage first ("Garbage First"). A mixed GC pause evacuates all young regions plus the N old regions with the highest garbage density, targeting the `-XX:MaxGCPauseMillis` goal.

### 2.1 G1GC Collection Cycle

```
Young GC (stop-the-world)
  -> Eden regions evacuated to Survivor or promoted to Old
  -> Triggered when Eden fills

Concurrent Marking (mostly concurrent)
  -> Initial Mark (piggybacks on Young GC -- STW)
  -> Root Region Scan (concurrent)
  -> Concurrent Mark (concurrent)
  -> Remark (STW, short)
  -> Cleanup (STW for accounting, concurrent for reclamation)

Mixed GC (stop-the-world)
  -> Evacuates remaining young + selected old regions
  -> Runs for G1MixedGCCountTarget cycles (default: 8)

Full GC (stop-the-world -- MUST NEVER HAPPEN IN PRODUCTION)
  -> Single-threaded serial compaction
  -> Triggered when G1 cannot evacuate live objects
```

---

## 3. Critical G1GC Tuning Flags

### 3.1 MaxGCPauseMillis — The Pause Target

```bash
-XX:MaxGCPauseMillis=50
```

This is a **soft goal**, not a hard limit. G1 will try to stay under it by limiting how many regions it collects per pause. Violation does not cause an error — it triggers adaptive resizing.

For payment services:
- **Authorisation services**: 20–50 ms (must stay well under response SLA)
- **Settlement batch services**: 100–200 ms (throughput matters more than latency)
- **Market data consumers**: 10–20 ms (or use ZGC instead)

Do not set this below 10 ms with G1GC — below that threshold G1 cannot collect enough garbage per pause to keep up with allocation, causing promotion failures and Full GC.

### 3.2 G1HeapRegionSize — Controlling Region Granularity

```bash
-XX:G1HeapRegionSize=16m
```

Region size controls two important things:
1. **Humongous object threshold** — objects larger than 50% of a region are "humongous" and bypass normal collection
2. **Mixed GC granularity** — smaller regions allow finer-grained incremental collection

**Sizing formula:**

```
Target region size = heap_size / 2048

Examples:
  4 GB heap  -> 2 MB  regions (2048 regions)
  8 GB heap  -> 4 MB  regions (2048 regions)
  16 GB heap -> 8 MB  regions (2048 regions)
  32 GB heap -> 16 MB regions (2048 regions)
```

If you are storing large cached objects (e.g., a payment routing table loaded into memory), you may want to increase region size to avoid humongous allocation for those objects.

### 3.3 InitiatingHeapOccupancyPercent — Concurrent Mark Trigger

```bash
-XX:InitiatingHeapOccupancyPercent=35
```

This controls when concurrent marking begins. When old generation exceeds this percentage of the total heap, G1 starts the concurrent marking cycle.

- **Too high** (> 60%): Not enough time for concurrent marking to complete before allocation fills the heap — promotion failure — Full GC
- **Too low** (< 20%): Concurrent marking runs too frequently, wasting CPU cycles on mostly-live data

For payment services with spiky allocation (e.g., batch processing that fills old gen quickly):

```bash
-XX:InitiatingHeapOccupancyPercent=25
```

Lower IHOP gives G1 more runway to complete marking before the heap fills.

### 3.4 G1NewSizePercent and G1MaxNewSizePercent

```bash
-XX:G1NewSizePercent=20
-XX:G1MaxNewSizePercent=40
```

Controls the minimum and maximum young generation size as a percentage of the heap. Payment services with high short-lived object rates (request/response objects) benefit from a larger young gen, reducing promotion to old gen.

### 3.5 ParallelGCThreads and ConcGCThreads

```bash
-XX:ParallelGCThreads=8      # STW parallel threads (default: num CPUs)
-XX:ConcGCThreads=2          # Concurrent marking threads
```

`ConcGCThreads` defaults to `ParallelGCThreads / 4`. On containers with limited CPU, explicitly set both to avoid G1 miscalculating available parallelism.

**Container-aware heap sizing** (Java 10+, essential for Kubernetes deployments):

```bash
-XX:+UseContainerSupport          # Enabled by default in Java 10+
-XX:MaxRAMPercentage=75.0         # Use 75% of container memory as heap
-XX:InitialRAMPercentage=50.0     # Start at 50%
```

---

## 4. Complete G1GC Configuration for Payment Services

```java
/**
 * JVM flags for a payment authorisation service.
 *
 * Service profile:
 *   - Target: < 50 ms GC pauses (P99)
 *   - Heap:   8 GB on 16 GB container
 *   - Load:   5,000 TPS, primarily short-lived objects (auth requests)
 *   - Spikes: batch settlement runs at 23:00 creating larger long-lived objects
 *
 * Full JVM flag set (append to java command or JAVA_OPTS):
 *
 * -Xms8g -Xmx8g
 * -XX:+UseG1GC
 * -XX:MaxGCPauseMillis=50
 * -XX:G1HeapRegionSize=8m
 * -XX:InitiatingHeapOccupancyPercent=30
 * -XX:G1NewSizePercent=20
 * -XX:G1MaxNewSizePercent=40
 * -XX:G1MixedGCCountTarget=8
 * -XX:G1MixedGCLiveThresholdPercent=85
 * -XX:G1HeapWastePercent=5
 * -XX:ParallelGCThreads=8
 * -XX:ConcGCThreads=2
 * -XX:+ParallelRefProcEnabled
 * -XX:+UseStringDeduplication
 * -XX:+DisableExplicitGC
 * -Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m
 */
public final class PaymentServiceJvmConfig {
    private PaymentServiceJvmConfig() {}

    public static final String GC_LOG_FLAG =
        "-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m";

    public static final String HEAP_FLAGS = "-Xms8g -Xmx8g";
}
```

### 4.1 Why -Xms Equals -Xmx

Setting initial heap equal to maximum heap prevents the JVM from resizing the heap at runtime, which involves an OS mmap/munmap call that can itself cause latency spikes. For latency-sensitive payment services, pre-allocate the full heap at startup.

---

## 5. ZGC — Sub-millisecond Pauses

ZGC is a concurrent, region-based collector designed for two properties:
- **Sub-millisecond pause times** (typically < 1 ms, regardless of heap size)
- **Linear pause time scaling** — 10 GB or 10 TB heaps have similar pause times

ZGC achieves this via **load barriers** — bytecode inserted at every heap reference load that performs concurrent relocation without stopping all application threads. The cost is a ~10–15% throughput overhead compared to G1GC.

### 5.1 ZGC Phases (Generational ZGC, Java 21+)

```
Young Collection (concurrent + tiny STW):
  Young Mark Start     (STW < 1 ms)
  Young Mark           (concurrent)
  Young Mark End       (STW < 1 ms)
  Young Relocate Start (STW < 1 ms)
  Young Relocate       (concurrent)

Old Collection (concurrent + tiny STW):
  Old Mark Start       (STW < 1 ms)
  Old Mark             (concurrent)
  Old Mark End         (STW < 1 ms)
  Old Relocate Start   (STW < 1 ms)
  Old Relocate         (concurrent)
```

The generational model (Java 21+) dramatically reduces CPU overhead compared to non-generational ZGC, making it viable for high-throughput services.

### 5.2 ZGC Configuration

```bash
# Java 21+ Generational ZGC (recommended)
-XX:+UseZGC
-XX:+ZGenerational

# Heap: larger is generally better for ZGC
# ZGC needs headroom for concurrent relocation
-Xms16g -Xmx16g

# ZGC auto-tunes most parameters, but you can hint:
-XX:ZCollectionInterval=0      # 0 = only collect when needed (default)
-XX:ZFragmentationLimit=25     # max fragmentation before compaction (%)
-XX:SoftMaxHeapSize=12g        # soft limit, leaves 4 GB for relocation buffer

# GC logging
-Xlog:gc*:file=/var/log/app/gc-zgc.log:time,uptime:filecount=5,filesize=100m
```

### 5.3 ZGC Heap Sizing Guidance

ZGC needs more headroom than G1GC because it relocates objects concurrently while the application runs. During relocation, both the old and new copies of an object may be live simultaneously.

```
ZGC heap sizing rule of thumb:
  heap = max_live_data * 4

Examples:
  Max live data: 2 GB  ->  heap: 8 GB  (minimum)
  Max live data: 4 GB  ->  heap: 16 GB
  Max live data: 8 GB  ->  heap: 32 GB
```

If you observe `OutOfMemoryError` with ZGC, the allocation rate is likely exceeding the concurrent relocation bandwidth. Increase heap size or reduce allocation rate.

---

## 6. Humongous Objects — The Silent G1GC Killer

An object is "humongous" in G1GC if it exceeds **50% of the region size**. Humongous objects are:
- Allocated directly in old-generation regions
- Never compacted (until Full GC)
- Collected only during concurrent marking cycles (not young GC)

A common source of humongous objects in payment services:

```java
// PaymentBatchProcessor.java

public class PaymentBatchProcessor {

    // PROBLEM: allocating large byte arrays in hot path
    public void processSettlementFile(InputStream settlementData) throws IOException {
        // This creates a humongous object if file > region_size/2
        // With 8 MB regions, any array > 4 MB is humongous
        byte[] fileBuffer = new byte[8 * 1024 * 1024]; // 8 MB -- HUMONGOUS

        int bytesRead = settlementData.read(fileBuffer);
        processBuffer(fileBuffer, bytesRead);
    }

    // SOLUTION: stream processing avoids large intermediary allocations
    public void processSettlementFileStreaming(InputStream settlementData) throws IOException {
        // 64 KB buffer -- well within any reasonable region size
        byte[] buffer = new byte[64 * 1024];
        int bytesRead;
        PaymentRecordParser parser = new PaymentRecordParser();

        while ((bytesRead = settlementData.read(buffer)) != -1) {
            parser.feed(buffer, 0, bytesRead);
            while (parser.hasRecord()) {
                PaymentRecord record = parser.nextRecord();
                processRecord(record);
            }
        }
    }

    private void processBuffer(byte[] buffer, int length) { /* ... */ }
    private void processRecord(PaymentRecord record) { /* ... */ }
}
```

### 6.1 Detecting Humongous Allocations via GC Logs

```
# In GC log -- look for lines like:
[2026-11-08T14:23:01.234+0000][gc,humongous] GC(45) Humongous allocation request size: 8388608 (8.0M)
[2026-11-08T14:23:01.235+0000][gc,humongous] GC(45) Humongous allocation in region: 42
```

**Programmatic detection using GC notification listener:**

```java
// HumongousAllocationMonitor.java

import com.sun.management.GarbageCollectionNotificationInfo;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import javax.management.NotificationEmitter;

@Component
public class HumongousAllocationMonitor {

    private final Counter humongousAllocCounter;

    public HumongousAllocationMonitor(MeterRegistry meterRegistry) {
        this.humongousAllocCounter = Counter.builder("jvm.gc.humongous.allocations")
            .description("Count of humongous object allocation events")
            .register(meterRegistry);

        installGcListener();
    }

    private void installGcListener() {
        for (GarbageCollectorMXBean gcBean : ManagementFactory.getGarbageCollectorMXBeans()) {
            if (gcBean instanceof NotificationEmitter emitter) {
                emitter.addNotificationListener(this::handleGcNotification, null, null);
            }
        }
    }

    private void handleGcNotification(javax.management.Notification notification,
                                       Object handback) {
        if (!notification.getType().equals(
                GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION)) {
            return;
        }

        GarbageCollectionNotificationInfo info =
            GarbageCollectionNotificationInfo.from(
                (javax.management.openmbean.CompositeData) notification.getUserData());

        // G1GC uses cause "G1 Humongous Allocation" for humongous-triggered collections
        String cause = info.getGcCause();
        if ("G1 Humongous Allocation".equals(cause)) {
            humongousAllocCounter.increment();
        }
    }
}
```

### 6.2 Increasing Region Size to Avoid Humongous Allocations

If your code legitimately needs large objects (e.g., caching encoded payment messages):

```bash
# If objects are ~10 MB, use 32 MB regions
# so objects < 16 MB are non-humongous
-XX:G1HeapRegionSize=32m
```

---

## 7. GC Overhead and Throughput Limits

The JVM throws `OutOfMemoryError: GC overhead limit exceeded` when more than **98% of time is spent in GC** and less than **2% of heap is recovered**. These flags control the threshold:

```bash
-XX:GCTimeLimit=90           # Throw OOME if > 90% time in GC
-XX:GCHeapFreeLimit=5        # Throw OOME if < 5% heap freed
```

For payment services, alert long before hitting these limits:

```java
// GcOverheadMonitor.java

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;

@Component
public class GcOverheadMonitor implements ApplicationRunner {

    private final MeterRegistry meterRegistry;

    public GcOverheadMonitor(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    @Override
    public void run(ApplicationArguments args) {
        // Alert threshold: > 5% of wall time in GC is a warning sign
        Gauge.builder("jvm.gc.overhead.estimate", this, GcOverheadMonitor::calculateGcOverhead)
            .description("Estimated fraction of time spent in GC (0.0-1.0)")
            .register(meterRegistry);
    }

    private double calculateGcOverhead() {
        long totalGcTimeMs = ManagementFactory.getGarbageCollectorMXBeans().stream()
            .mapToLong(GarbageCollectorMXBean::getCollectionTime)
            .sum();

        long uptimeMs = ManagementFactory.getRuntimeMXBean().getUptime();
        return uptimeMs > 0 ? (double) totalGcTimeMs / uptimeMs : 0.0;
    }
}
```

---

## 8. GC Log Analysis

Always enable GC logging in production. The overhead is negligible (< 0.1%) and the diagnostic value is immense.

### 8.1 Logging Flags (Java 9+ Unified Logging)

```bash
# Comprehensive logging -- recommended for production
-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m

# Minimal logging -- for extreme latency sensitivity
-Xlog:gc:file=/var/log/app/gc-min.log:time,uptime:filecount=5,filesize=20m

# Debug level -- for troubleshooting only, never in production
-Xlog:gc*=debug:file=/var/log/app/gc-debug.log:time,uptime,level,tags:filecount=3,filesize=100m
```

### 8.2 Reading G1GC Logs

```
# Young GC -- normal, should be fast
[2026-11-08T14:23:01.100+0000][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 2048M->1024M(8192M) 18.432ms

# Mixed GC -- expected, reclaims old gen
[2026-11-08T14:23:15.200+0000][gc] GC(43) Pause Young (Mixed) (G1 Evacuation Pause) 3072M->1536M(8192M) 32.187ms

# Concurrent Mark -- good, running in background
[2026-11-08T14:23:30.300+0000][gc] GC(44) Concurrent Mark Cycle

# ALERT: Full GC -- investigate immediately
[2026-11-08T14:23:45.400+0000][gc] GC(45) Pause Full (G1 Compaction Pause) 7680M->2048M(8192M) 4521.834ms
```

### 8.3 GC Log Parser Utility

```java
// GcLogAnalyzer.java

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.DoubleSummaryStatistics;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class GcLogAnalyzer {

    private static final Pattern PAUSE_PATTERN = Pattern.compile(
        "GC\\((\\d+)\\) Pause (\\w+) .*?(\\d+\\.\\d+)ms$"
    );

    public record GcPauseEvent(int gcId, String pauseType, double durationMs) {}

    public record GcPauseStats(double avgMs, double maxMs, double p99Ms, long fullGcCount) {
        public boolean isHealthy() {
            return p99Ms < 100.0 && fullGcCount == 0;
        }
    }

    public List<GcPauseEvent> parseLog(Path logFile) throws IOException {
        List<GcPauseEvent> events = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(logFile)) {
            String line;
            while ((line = reader.readLine()) != null) {
                Matcher m = PAUSE_PATTERN.matcher(line);
                if (m.find()) {
                    events.add(new GcPauseEvent(
                        Integer.parseInt(m.group(1)),
                        m.group(2),
                        Double.parseDouble(m.group(3))
                    ));
                }
            }
        }
        return events;
    }

    public GcPauseStats computeStats(List<GcPauseEvent> events) {
        if (events.isEmpty()) {
            return new GcPauseStats(0, 0, 0, 0);
        }

        DoubleSummaryStatistics stats = events.stream()
            .mapToDouble(GcPauseEvent::durationMs)
            .summaryStatistics();

        double[] sorted = events.stream()
            .mapToDouble(GcPauseEvent::durationMs)
            .sorted()
            .toArray();

        int p99Index = Math.max(0, (int) Math.ceil(sorted.length * 0.99) - 1);
        double p99 = sorted[p99Index];

        long fullGcCount = events.stream()
            .filter(e -> "Full".equals(e.pauseType()))
            .count();

        return new GcPauseStats(stats.getAverage(), stats.getMax(), p99, fullGcCount);
    }
}
```

---

## 9. G1GC vs ZGC — Decision Matrix for Financial Workloads

| Criterion | G1GC | ZGC (Generational, Java 21) |
|---|---|---|
| Pause time P99 | 20-100 ms (tunable) | < 1 ms |
| Throughput overhead | Low (~5%) | Moderate (~10-15%) |
| Heap minimum | 1 GB workable | 4 GB+ recommended |
| Configuration complexity | Moderate | Low (self-tuning) |
| CPU overhead | Low | Moderate (concurrent phases) |
| Best for | Batch, settlement, medium latency | Real-time auth, market data |
| Java version | Java 8+ | Java 21+ for GenZGC |
| Humongous objects | Problematic | Handled transparently |
| Container awareness | Good (Java 10+) | Excellent |

### 9.1 Recommended Selection by Service Type

```
Payment Authorisation API (< 50 ms SLA):
  -> ZGC with GenerationalZGC on Java 21
  -> Heap: 4x max live data

Settlement Batch Service (throughput priority):
  -> G1GC with MaxGCPauseMillis=200
  -> Heap: sized to avoid Full GC

Fraud Detection (rule evaluation, medium latency):
  -> G1GC with MaxGCPauseMillis=50
  -> Tune IHOP aggressively: 25-30%

Market Data Processor (< 10 ms latency):
  -> ZGC with GenerationalZGC
  -> Heap: 2x max live data minimum
```

---

## 10. Typical JVM Flag Set for Production Payment Processor

```bash
#!/usr/bin/env bash
# payment-service-jvm-opts.sh
# Tested on Java 21, 16 GB container, 5000 TPS payment authorisation

# ---- Heap ----
-Xms8g
-Xmx8g

# ---- GC: G1GC with low-latency tuning ----
-XX:+UseG1GC
-XX:MaxGCPauseMillis=50
-XX:G1HeapRegionSize=8m
-XX:InitiatingHeapOccupancyPercent=30
-XX:G1NewSizePercent=20
-XX:G1MaxNewSizePercent=40
-XX:G1MixedGCCountTarget=8
-XX:G1MixedGCLiveThresholdPercent=85
-XX:G1HeapWastePercent=5
-XX:ParallelGCThreads=8
-XX:ConcGCThreads=2
-XX:+ParallelRefProcEnabled

# ---- String deduplication (saves 10-20% heap for many services) ----
-XX:+UseStringDeduplication

# ---- Prevent application code from triggering Full GC ----
-XX:+DisableExplicitGC

# ---- Metaspace: cap to avoid runaway class loading ----
-XX:MetaspaceSize=256m
-XX:MaxMetaspaceSize=512m

# ---- GC Logging ----
-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50m

# ---- JVM crash diagnostics ----
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/app/heap-dump.hprof
-XX:+ExitOnOutOfMemoryError

# ---- Container support ----
-XX:+UseContainerSupport
-XX:ActiveProcessorCount=8

# ---- Alternative: ZGC for stricter latency requirements ----
# Replace the GC section above with:
# -XX:+UseZGC
# -XX:+ZGenerational
# -Xms16g -Xmx16g
# -XX:SoftMaxHeapSize=12g
```

---

## 11. Production Checklist

Before deploying a new service or after a GC incident, verify:

- [ ] Heap sized to 2-4x max live data (not just peak throughput)
- [ ] `-Xms` equals `-Xmx` (prevents heap resize latency spikes)
- [ ] GC logging enabled with file rotation
- [ ] `HeapDumpOnOutOfMemoryError` and `ExitOnOutOfMemoryError` set
- [ ] `DisableExplicitGC` set (prevents `System.gc()` from triggering Full GC)
- [ ] Micrometer `JvmGcMetrics` registered (auto-registers with Spring Boot Actuator)
- [ ] Alert on: GC pause P99 > 100 ms, Full GC count > 0, heap usage > 85%
- [ ] Region size checked against max object size (avoid humongous allocations)
- [ ] `UseContainerSupport` set for Kubernetes deployments
- [ ] GC log rotated and shipped to log aggregator (ELK, Splunk, Datadog)

---

## Knowledge Check

1. What is the difference between `-XX:MaxGCPauseMillis` and a hard pause limit? What happens when G1GC violates the goal?

2. An 8 GB heap with 8 MB regions experiences frequent humongous allocations for 5 MB byte arrays. What are two ways to fix this?

3. Why does ZGC require more heap headroom than G1GC?

4. A payment service's GC log shows Full GC pauses every 30 minutes lasting 2 seconds. The heap is 4 GB with IHOP at default (45%). What flag change would you try first?

5. A container running a payment service is allocated 8 GB. The JVM is set to `-Xmx6g`. What additional flag should you check is present to ensure the JVM respects container memory limits?

---

## Practical Challenge

**Setup:** A payment authorisation service processes 3,000 TPS. The heap is 4 GB with default G1GC settings. Load testing shows GC pause P99 at 180 ms and occasional Full GC pauses during load spikes.

**Task:**
1. Enumerate the default G1GC settings that are likely causing the problem
2. Write a complete JVM flag set targeting < 50 ms P99 pause
3. Write a `GcPauseAlertEvaluator` class that reads `GcPauseStats` and returns a list of `AlertEvent` records describing any violations, with severity levels (WARN/CRITICAL)

**Expected output:** A JVM flags shell snippet and a Java class with unit tests covering healthy, degraded, and critical GC scenarios.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the difference between `-XX:MaxGCPauseMillis` and a hard pause limit in G1GC?",
      "options": [
        "They are identical — G1GC always meets the target",
        "MaxGCPauseMillis is a soft goal; G1GC adjusts region sizes to try to meet it but may exceed it",
        "MaxGCPauseMillis sets a hard limit; exceeding it triggers an OutOfMemoryError",
        "MaxGCPauseMillis only applies to ZGC, not G1GC"
      ],
      "correct": 1,
      "explanation": "MaxGCPauseMillis is a soft goal. G1GC uses it to guide region sizing and mixed GC scheduling, but it cannot guarantee the target will never be exceeded, especially under memory pressure or when the heap is nearly full."
    },
    {
      "text": "Why should `-Xms` be set equal to `-Xmx` in a low-latency payment service?",
      "options": [
        "It reduces total memory consumption",
        "It prevents the JVM from performing heap resizing operations, which cause OS mmap/munmap latency spikes",
        "It enables ZGC to operate in generational mode",
        "It disables G1GC humongous allocation handling"
      ],
      "correct": 1,
      "explanation": "When Xms equals Xmx, the JVM pre-allocates the full heap at startup. This eliminates runtime heap resize operations (mmap/munmap OS calls) that can introduce latency spikes — especially problematic for sub-50ms SLA payment authorisation services."
    },
    {
      "text": "A payment service with an 8 GB heap and 8 MB G1 regions experiences frequent humongous allocations for 5 MB byte arrays. What is the correct fix?",
      "options": [
        "Increase `-XX:MaxGCPauseMillis` to 500 ms",
        "Switch to ZGC which handles all humongous objects transparently",
        "Increase `-XX:G1HeapRegionSize` to 16 MB so 5 MB objects are non-humongous",
        "Set `-XX:InitiatingHeapOccupancyPercent=10` to trigger earlier collection"
      ],
      "correct": 2,
      "explanation": "Humongous objects are those larger than half the region size. With 8 MB regions, objects larger than 4 MB are humongous. Setting G1HeapRegionSize=16m makes the threshold 8 MB, so 5 MB arrays become normal young-gen objects."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "G1GC Production Tuning for Payment Authorisation Service",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Enumerate the default G1GC settings that are likely causing 180 ms P99 GC pauses on a 4 GB heap at 3,000 TPS, and explain the impact of each."},
    {"id": "2", "description": "Write a complete JVM flag set targeting < 50 ms P99 pause for a 16 GB container running a 5,000 TPS payment authorisation service, with justification for each non-default flag."},
    {"id": "3", "description": "Write a GcPauseAlertEvaluator class that reads GcPauseStats (average, max, p99, fullGcCount) and returns a list of AlertEvent records with WARN/CRITICAL severity levels."},
    {"id": "4", "description": "Write unit tests for the GcPauseAlertEvaluator covering: healthy state (no alerts), degraded state (p99 > 100 ms = WARN), and critical state (Full GC > 0 or p99 > 500 ms = CRITICAL)."}
  ]
}
-->

