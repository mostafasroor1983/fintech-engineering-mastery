---
id: track-09-lesson-13
title: "Kafka Performance Tuning — Throughput vs Latency"
slug: kafka-performance
track: track-09
trackName: "Kafka & Event-Driven Architecture"
sequence: 13
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, performance, throughput, latency, compression]
prerequisites: ["track-09-lesson-01", "track-09-lesson-02", "track-09-lesson-03"]
---

# Kafka Performance Tuning — Throughput vs Latency

> [!NOTE]
> Kafka performance tuning requires understanding a fundamental trade-off: throughput and latency are in direct tension. Configurations that maximise throughput (larger batches, longer waits, compression) increase latency. Configurations that minimise latency (immediate sends, no batching) reduce throughput. Payment systems have different requirements across the pipeline — fraud detection needs <50ms, settlement can tolerate 500ms, compliance archival can tolerate minutes.

## The Throughput vs Latency Trade-off

```
                    Throughput
                        ↑
                        │
      batch.size=65536  │███████████████
      linger.ms=50      │██████████
      compression=lz4   │███
                        │
      batch.size=16384  │███
      linger.ms=5       │██
                        │
      linger.ms=0       │█        (illustrative shape, not measurements)
                        └──────────────────────► Latency
                        0ms    10ms    50ms   100ms
```

There is no single optimal configuration. Choose based on your use case's SLA.

---

## Producer Throughput Tuning

### Batching Configuration

```java
import org.apache.kafka.clients.producer.ProducerConfig;
import java.util.Properties;

public class HighThroughputProducerConfig {

    public static Properties build() {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");

        // Batch size: how many bytes to accumulate before sending a batch
        // Default: 16384 (16KB) — increase for higher throughput
        props.put(ProducerConfig.BATCH_SIZE_CONFIG, 65536);  // 64KB

        // Linger: how long to wait for more records before sending
        // Default: 0 (send immediately; 5 ms since Kafka 4.0) — increase for
        // throughput at cost of latency
        // For settlement topic: 5ms acceptable. For fraud checks: 0ms required.
        props.put(ProducerConfig.LINGER_MS_CONFIG, 5);       // 5ms

        // Buffer: total memory for all unsent batches
        props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67108864L);  // 64MB

        // Max block: how long to wait if buffer is full
        props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 60000);

        // Compression: lz4 provides best throughput/CPU trade-off
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");

        // Reliability: required for financial data
        props.put(ProducerConfig.ACKS_CONFIG, "all");

        // In-flight requests: 5 is max for idempotent producer
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);

        return props;
    }
}
```

### Low-Latency Producer Configuration

```java
public class LowLatencyProducerConfig {

    public static Properties build() {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");

        // No wait — send immediately (explicit: the default is 5 ms in Kafka 4.0)
        props.put(ProducerConfig.LINGER_MS_CONFIG, 0);

        // Keep the default batch.size (16 KB). Do NOT set it to 1: that puts
        // every record into its own request, so under load requests queue up
        // and latency gets WORSE. With linger.ms=0, records are sent at once
        // anyway; batching only happens naturally when records pile up.

        // No compression — avoids compression CPU on the hot path
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "none");

        // Idempotence keeps per-partition ordering with up to 5 in-flight
        // requests -- no need to drop to 1 (which would cost throughput)
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);

        // acks=all for financial data (acks=1 only for non-critical data)
        props.put(ProducerConfig.ACKS_CONFIG, "all");

        return props;
    }
}
```

---

## Consumer Throughput Tuning

```java
import org.apache.kafka.clients.consumer.ConsumerConfig;

public class HighThroughputConsumerConfig {

    public static Properties build() {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");

        // Minimum bytes to fetch in one request — wait until this much is available
        // Default: 1 (fetch immediately) — increase to reduce broker load.
        // Cost: on a quiet topic each fetch waits up to fetch.max.wait.ms
        // (500 ms below) -- not for latency-sensitive consumers
        props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, 50000);  // 50KB

        // Max wait time for fetch.min.bytes to be satisfied
        props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, 500);  // 500ms max wait

        // Max bytes per partition per fetch request
        props.put(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, 1048576);  // 1MB

        // Max records per poll — tune based on processing time
        // If each record takes 1ms, 500 records = 500ms processing per poll
        // Ensure max.poll.interval.ms > (max.poll.records * avg processing time)
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 500);

        // Max poll interval — session timeout for slow consumers
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 300000);  // 5 minutes

        props.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-processor");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");

        return props;
    }
}
```

**Parallelism tuning:** Consumer throughput scales roughly with the number of consumer instances, up to the partition count — as long as the downstream (database, APIs) keeps up. To double consumer throughput you may need to double both the partition count and the number of consumer instances (and remember that adding partitions changes the key → partition mapping).

```
Topic: payments.events (8 partitions)
Consumer Group: payment-processor

Deployment A: 4 consumers × 2 partitions each = moderate throughput
Deployment B: 8 consumers × 1 partition each = maximum throughput
Deployment C: 16 consumers × 1 partition each = same as B (extra consumers idle)
```

---

## Compression Algorithm Comparison

| Algorithm | Compression Ratio | CPU Cost | Latency | Use Case |
|-----------|------------------|----------|---------|----------|
| `none` | 1.0x | Zero | Lowest | Low-volume, latency critical |
| `gzip` | 2.5-4x | High | High | Archival, low throughput |
| `snappy` | 2x | Low | Low | General purpose |
| `lz4` | 2.5x | Very Low | Very Low | High throughput (recommended) |
| `zstd` | 3-4x | Medium | Low | Best ratio/CPU trade-off |

**Recommendation for payment event topics:** `lz4` — excellent compression with minimal CPU overhead. Payment events are typically small JSON objects that compress well.

```java
// Compression benchmark setup
public class CompressionBenchmark {

    // Sample payment event JSON (~200 bytes uncompressed). Kafka compresses
    // whole BATCHES, so the ratio depends on batch size and data similarity;
    // the numbers below are illustrative
    private static final String SAMPLE_PAYMENT = """
        {"paymentId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890",
         "accountId":"acc-9876","amount":125.50,"currency":"GBP",
         "status":"PENDING","createdAt":1699200000000,
         "reference":"PYMT-20261108-001"}
        """;

    // For 1000 payment events:
    // none:   200 KB
    // lz4:    82 KB  (59% reduction, negligible CPU overhead)
    // zstd:   66 KB  (67% reduction, slightly more CPU)
    // gzip:   61 KB  (70% reduction, significant CPU overhead)
}
```

---

## Broker Configuration

```properties
# server.properties — broker performance tuning

# Network threads: handle incoming network requests
# Default: 3 — increase for high connection count
num.network.threads=8

# IO threads: perform disk I/O for fetch and produce
# Default: 8 — typically 2× num.network.threads
num.io.threads=16

# Replica fetcher threads: how many threads each broker uses to copy data
# from partition leaders (helps followers keep up / stay in the ISR)
num.replica.fetchers=4

# Socket buffer sizes
# 1MB (default: 100KB)
socket.send.buffer.bytes=1048576
# 1MB (default: 100KB)
socket.receive.buffer.bytes=1048576
# 100MB max request size
socket.request.max.bytes=104857600

# Log flush — leave the defaults (no forced fsync): Kafka relies on
# replication across brokers plus the OS page cache for durability.
# Forcing periodic flushes (log.flush.interval.messages / .ms) mainly
# costs throughput.

# Log retention
# 7 days
log.retention.hours=168
# 1GB per segment
log.segment.bytes=1073741824

# ISR management
min.insync.replicas=2
default.replication.factor=3
```

---

## OS-Level Tuning

Kafka's performance is heavily dependent on the OS, particularly filesystem and page cache behaviour.

### Filesystem Choice

```bash
# XFS is recommended over ext4 for Kafka data directories
# XFS provides better performance for large sequential writes
# ext4 provides acceptable performance but slightly lower throughput

# Format disk with XFS
mkfs.xfs -f /dev/nvme1n1
mount -o noatime /dev/nvme1n1 /kafka/data
# (no "nobarrier": it risks data loss on power failure and was removed from
#  XFS in Linux 4.19; noatime already implies nodiratime)

# /etc/fstab
/dev/nvme1n1  /kafka/data  xfs  defaults,noatime,nodiratime  0 2
```

### Linux Kernel Parameters

```bash
# /etc/sysctl.conf
# Virtual memory — give more to page cache
vm.swappiness=1               # Almost no swapping (default: 60)
vm.dirty_ratio=80             # Allow up to 80% of RAM dirty (default: 20)
vm.dirty_background_ratio=5   # Start background flush at 5% (default: 10)

# Network buffers
net.core.rmem_default=262144
net.core.rmem_max=16777216
net.core.wmem_default=262144
net.core.wmem_max=16777216
net.core.netdev_max_backlog=2500

# File descriptors — Kafka opens many files (segments + sockets).
# Also raise the per-process limit for the kafka user, e.g. LimitNOFILE=100000
# in the systemd unit (fs.file-max alone is not enough)
fs.file-max=1000000
vm.max_map_count=262144       # memory-mapped index files: one pair per segment

# Apply without reboot
sysctl -p
```

### JVM Tuning

```bash
# KAFKA_HEAP_OPTS in kafka-server-start.sh
# 6-8GB heap for high-throughput brokers
export KAFKA_HEAP_OPTS="-Xmx6G -Xms6G"

# G1GC is recommended for Kafka brokers
# ZGC or Shenandoah for <10ms GC pauses (Kafka 3.0+)
export KAFKA_JVM_PERFORMANCE_OPTS="-server \
    -XX:+UseG1GC \
    -XX:MaxGCPauseMillis=20 \
    -XX:InitiatingHeapOccupancyPercent=35 \
    -XX:+ExplicitGCInvokesConcurrent \
    -Djava.awt.headless=true"
```

---

## Partition Count Impact

Partition count is the primary scaling lever, but it has diminishing returns and trade-offs:

```
Increasing partitions:
  BENEFITS:
    + Higher throughput (more parallelism)
    + More consumer instances can run simultaneously
  COSTS:
    - More leader election work during broker failures (longer unavailability)
    - More replication work, file handles and memory on brokers
    - Rebalances and metadata get heavier
    - Adding partitions later changes the key → partition mapping

Rule of thumb:
  - Start with max(target MB/s ÷ 10, consumers × 2)
  - payments.events: target 50 MB/s → 5 partitions minimum
  - Multiply by 2-3 for growth headroom: 10-15 partitions

You CANNOT reduce partitions without topic recreation.
Increase conservatively.
```

---

## Benchmarking with `kafka-producer-perf-test.sh`

```bash
# Throughput test: 1 million records, 200-byte payload
kafka-producer-perf-test.sh \
    --topic payments.benchmark \
    --num-records 1000000 \
    --record-size 200 \
    --throughput -1 \
    --producer-props \
        bootstrap.servers=kafka:9092 \
        acks=all \
        batch.size=65536 \
        linger.ms=5 \
        compression.type=lz4

# Example output (illustrative -- depends entirely on hardware/network):
# 1000000 records sent, 185432.21 records/sec (35.37 MB/sec),
# 2.84 ms avg latency, 112.00 ms max latency,
# 1 ms 50th, 5 ms 95th, 15 ms 99th, 112 ms 99.9th.

# Consumer throughput test
kafka-consumer-perf-test.sh \
    --bootstrap-server kafka:9092 \
    --topic payments.benchmark \
    --messages 1000000 \
    --group perf-test-group \
    --threads 1
```

**Interpreting results:**

| Metric | Good | Needs Tuning |
|--------|------|-------------|
| Throughput (MB/s) | Meets your target with headroom (often tens of MB/s per partition) | Below target, or far below the disk/network limit |
| Avg latency | < 5ms | > 50ms |
| 99th pct latency | < 50ms | > 500ms |
| Max latency spike | < 500ms | > 5s |

---

## Performance Tuning by Use Case

```java
// CONFIGURATION TEMPLATES

// Use Case 1: Payment event publishing (acks=all, ordered, moderate throughput)
public static Properties paymentEventProducer() {
    Properties p = new Properties();
    p.put(ProducerConfig.ACKS_CONFIG, "all");
    p.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
    p.put(ProducerConfig.BATCH_SIZE_CONFIG, 32768);
    p.put(ProducerConfig.LINGER_MS_CONFIG, 5);
    p.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");
    p.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
    return p;
}

// Use Case 2: Fraud signals for a real-time dashboard (low latency).
// acks=1 is only acceptable if losing a signal on a leader failure is
// tolerable -- fraud DECISIONS that block payments need acks=all
public static Properties fraudEventProducer() {
    Properties p = new Properties();
    p.put(ProducerConfig.ACKS_CONFIG, "1");       // Leader ACK only
    p.put(ProducerConfig.LINGER_MS_CONFIG, 0);    // Send immediately (default batch.size)
    p.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "none");
    return p;
}

// Use Case 3: Analytics/compliance archival (maximum throughput, latency insensitive)
public static Properties analyticsEventProducer() {
    Properties p = new Properties();
    p.put(ProducerConfig.ACKS_CONFIG, "1");
    p.put(ProducerConfig.BATCH_SIZE_CONFIG, 262144);  // 256KB batches
    p.put(ProducerConfig.LINGER_MS_CONFIG, 100);       // 100ms linger
    p.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "zstd");  // Best ratio
    // > 5 in flight requires idempotence OFF: retries may then reorder or
    // duplicate records -- acceptable only for analytics-style data
    p.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, false);
    p.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 10);
    return p;
}
```

---

## Key Takeaways

- Throughput and latency are fundamentally in tension — tune for your use case's SLA, not for maximum throughput.
- **Producer throughput:** increase `batch.size` (64-256KB) and `linger.ms` (5-100ms); use `lz4` compression.
- **Producer low latency:** `linger.ms=0` with the default `batch.size`, no compression (a tiny `batch.size` makes latency worse under load).
- **Consumer throughput:** increase `fetch.min.bytes`, `max.poll.records`; scale consumers to match partition count.
- **Compression:** `lz4` for payment events (best throughput/CPU balance); `zstd` for archival (best ratio).
- Partition count is the primary throughput lever — plan carefully as reductions require topic recreation.
- OS tuning (XFS, `noatime`, `vm.swappiness=1`, file-descriptor limits, network buffers) removes avoidable bottlenecks — measure the gain on your hardware.
- Use `kafka-producer-perf-test.sh` before capacity planning, not just to verify after problems.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which producer configuration settings are correct for minimizing latency at the cost of throughput?",
      "options": [
        "batch.size=262144, linger.ms=100, compression.type=zstd",
        "linger.ms=0 with the default batch.size, compression.type=none",
        "batch.size=65536, linger.ms=5, compression.type=lz4",
        "acks=1, batch.size=32768, linger.ms=10"
      ],
      "correct": 1,
      "explanation": "Minimum latency means sending immediately without waiting: linger.ms=0 sends each record as soon as the sender thread can, and disabling compression removes compression CPU time. Keep the default batch.size: making it tiny (e.g. 1) does not make sends faster — it forces one request per record, which queues up under load and increases latency."
    },
    {
      "text": "What is the recommended compression format for payment event archival where storage efficiency is the priority?",
      "options": [
        "lz4 — best throughput/CPU balance",
        "snappy — lowest CPU overhead",
        "zstd — best compression ratio",
        "gzip — universally supported"
      ],
      "correct": 2,
      "explanation": "zstd (Zstandard) provides the best compression ratio of Kafka's supported codecs, making it optimal for archival use cases where storage cost and data transfer cost matter more than CPU overhead. For real-time payment events, lz4 is preferred for its better CPU-to-ratio balance."
    },
    {
      "text": "Why is partition count the primary throughput scaling lever, and what is the key constraint on increasing it?",
      "options": [
        "More partitions increase broker disk I/O but can be safely reduced later",
        "More partitions enable more parallel consumers and producers but partition count cannot be reduced without topic recreation",
        "More partitions increase replication overhead proportionally with no throughput benefit",
        "Partition count only affects consumer throughput, not producer throughput"
      ],
      "correct": 1,
      "explanation": "Each partition can be consumed by one consumer instance in a group, so partition count determines maximum consumer parallelism. Producers also benefit from more partitions through parallel writes. The critical constraint is that Kafka cannot reduce partition count — you can only increase it, making the initial choice important."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Tune Kafka for Three Payment Processing Use Cases",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {
      "id": "1",
      "description": "Configure and benchmark three producer profiles: (a) payment events (acks=all, idempotence, batch.size=32768, linger.ms=5, lz4 compression), (b) real-time fraud signals (acks=1, linger.ms=0, default batch.size, no compression), (c) compliance archival (acks=1, batch.size=262144, linger.ms=100, zstd compression). Use kafka-producer-perf-test.sh to measure throughput and 99th percentile latency for each, and also try batch.size=1 for (b) to see why it hurts under load."
    },
    {
      "id": "2",
      "description": "Tune consumer settings for high-throughput settlement processing: set fetch.min.bytes=50000, fetch.max.wait.ms=500, and max.poll.records=500. Measure the impact on settlement service throughput vs processing latency. Determine the optimal max.poll.records value given a 2-second processing time per batch."
    },
    {
      "id": "3",
      "description": "Apply OS-level tuning to a Kafka broker: set vm.swappiness=1, vm.dirty_background_ratio=5, mount the XFS data volume with noatime, raise the kafka user's file-descriptor limit and increase socket buffer sizes. Run before/after benchmarks to quantify the throughput improvement."
    },
    {
      "id": "4",
      "description": "Analyze a hot partition scenario where a high-volume merchant account generates 60% of all payment events. Implement the sub-partitioning strategy using sequence number suffixes (accountId + '-' + (seqNum % 4)) and add application-level sequence number reordering in the consumer to restore per-account ordering."
    }
  ]
}
-->
