---
id: track-11-lesson-13
title: "Kafka Performance Tuning — Throughput vs Latency"
slug: kafka-performance
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 13
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, performance, throughput, latency, compression]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
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
      linger.ms=0       │█
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
        // Default: 0 (send immediately) — increase for throughput at cost of latency
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

        // Minimum batch size — send as soon as 1 record available
        props.put(ProducerConfig.BATCH_SIZE_CONFIG, 1);

        // No wait — send immediately
        props.put(ProducerConfig.LINGER_MS_CONFIG, 0);

        // No compression — avoids CPU serialisation latency
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "none");

        // Single in-flight for ordering (payment events must be ordered)
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 1);

        // Acks=1 for lower latency (at cost of durability) — use for non-critical data
        // Acks=all for financial data
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
        // Default: 1 (fetch immediately) — increase to reduce broker load
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

**Parallelism tuning:** Consumer throughput scales linearly with the number of partitions (up to the partition count). To double consumer throughput, double the partition count and the number of consumer instances.

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

    // Sample payment event JSON (~200 bytes uncompressed)
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

# Request handler threads: execute produce/fetch/metadata requests
num.replica.fetchers=4

# Socket buffer sizes
socket.send.buffer.bytes=1048576     # 1MB (default: 100KB)
socket.receive.buffer.bytes=1048576  # 1MB (default: 100KB)
socket.request.max.bytes=104857600   # 100MB max request size

# Log flush — do NOT flush after every message (OS page cache handles this)
log.flush.interval.messages=100000
log.flush.interval.ms=10000

# Log retention
log.retention.hours=168   # 7 days
log.segment.bytes=1073741824  # 1GB per segment

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
mount -o noatime,nodiratime,nobarrier /dev/nvme1n1 /kafka/data

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

# File descriptors — Kafka opens many files
fs.file-max=1000000

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
    - More leader election work during broker failures
    - Higher end-to-end latency (leader election, ISR sync)
    - More file handles on brokers
    - Rebalance time increases proportionally

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
# Throughput test: 1 million records, 100-byte payload
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

# Expected output:
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
| Throughput (MB/s) | > 100 MB/s per partition | < 10 MB/s |
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

// Use Case 2: Fraud event publishing (low latency, acks=1 acceptable)
public static Properties fraudEventProducer() {
    Properties p = new Properties();
    p.put(ProducerConfig.ACKS_CONFIG, "1");       // Leader ACK only
    p.put(ProducerConfig.BATCH_SIZE_CONFIG, 1);   // No batching
    p.put(ProducerConfig.LINGER_MS_CONFIG, 0);    // Send immediately
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
    p.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 10);
    return p;
}
```

---

## Key Takeaways

- Throughput and latency are fundamentally in tension — tune for your use case's SLA, not for maximum throughput.
- **Producer throughput:** increase `batch.size` (64-256KB) and `linger.ms` (5-100ms); use `lz4` compression.
- **Producer low latency:** `batch.size=1`, `linger.ms=0`, no compression.
- **Consumer throughput:** increase `fetch.min.bytes`, `max.poll.records`; scale consumers to match partition count.
- **Compression:** `lz4` for payment events (best throughput/CPU balance); `zstd` for archival (best ratio).
- Partition count is the primary throughput lever — plan carefully as reductions require topic recreation.
- OS tuning (XFS filesystem, `vm.swappiness=1`, network buffers) can double Kafka throughput on the same hardware.
- Use `kafka-producer-perf-test.sh` before capacity planning, not just to verify after problems.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which producer configuration settings are correct for minimizing latency at the cost of throughput?",
      "options": [
        "batch.size=262144, linger.ms=100, compression.type=zstd",
        "batch.size=1, linger.ms=0, compression.type=none",
        "batch.size=65536, linger.ms=5, compression.type=lz4",
        "acks=1, batch.size=32768, linger.ms=10"
      ],
      "correct": 1,
      "explanation": "Minimum latency requires sending immediately without batching: batch.size=1 (or very small) and linger.ms=0 forces the producer to send each record as soon as it arrives. Disabling compression removes CPU processing time. This sacrifices throughput for the lowest possible latency."
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
    {"id": "1", "description": "Configure and benchmark three producer profiles: (a) payment events (acks=all, batch.size=32768, linger.ms=5, lz4 compression), (b) fraud detection events (acks=1, batch.size=1, linger.ms=0, no compression), (c) compliance archival (acks=1, batch.size=262144, linger.ms=100, zstd compression). Use kafka-producer-perf-test.sh to measure throughput and 99th percentile latency for each."},
    {"id": "2", "description": "Tune consumer settings for high-throughput settlement processing: set fetch.min.bytes=50000, fetch.max.wait.ms=500, and max.poll.records=500. Measure the impact on settlement service throughput vs processing latency. Determine the optimal max.poll.records value given a 2-second processing time per batch."},
    {"id": "3", "description": "Apply OS-level tuning to a Kafka broker: set vm.swappiness=1, vm.dirty_ratio=80, configure XFS filesystem with noatime mount option, and increase socket buffer sizes. Run before/after benchmarks to quantify the throughput improvement."},
    {"id": "4", "description": "Analyze a hot partition scenario where a high-volume merchant account generates 60% of all payment events. Implement the sub-partitioning strategy using sequence number suffixes (accountId + '-' + (seqNum % 4)) and add application-level sequence number reordering in the consumer to restore per-account ordering."}
  ]
}
-->
