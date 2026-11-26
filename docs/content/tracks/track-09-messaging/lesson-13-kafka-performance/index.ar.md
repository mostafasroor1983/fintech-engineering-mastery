---
id: track-09-lesson-13
title: "ضبط أداء Kafka — الإنتاجية مقابل الكمون"
slug: kafka-performance
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 13
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, performance, throughput, latency, compression]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
---

# ضبط أداء Kafka — الإنتاجية مقابل زمن الاستجابة

> [!NOTE]
> يتطلب ضبط أداء Kafka فهم مفاضلة جوهرية: الإنتاجية وزمن الاستجابة في توتر مباشر. فالإعدادات التي تعظّم الإنتاجية (دفعات أكبر، وانتظار أطول، وضغط) تزيد الزمن. والإعدادات التي تقلل الزمن (إرسال فوري، بلا تجميع) تقلل الإنتاجية. ولأنظمة الدفع متطلبات مختلفة عبر خط المعالجة — يحتاج كشف الاحتيال أقل من 50ms، وتحتمل التسوية 500ms، وتحتمل أرشفة الامتثال دقائق.

## مفاضلة الإنتاجية مقابل الزمن

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

لا يوجد إعداد مثالي واحد. فاختر بناءً على اتفاقية مستوى الخدمة لحالة استخدامك.

## ضبط إنتاجية المنتج

### إعداد التجميع

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

### إعداد منتج منخفض الزمن

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

## ضبط إنتاجية المستهلك

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

**ضبط التوازي:** تتناسب إنتاجية المستهلك تقريبًا مع عدد مثيلات المستهلكين، حتى عدد الأقسام — ما دامت الأنظمة اللاحقة (قاعدة البيانات، والواجهات) تواكب. ولمضاعفة إنتاجية المستهلك قد تحتاج مضاعفة عدد الأقسام وعدد مثيلات المستهلكين كليهما (وتذكّر أن إضافة أقسام تغيّر ربط المفتاح ← القسم).

```
Topic: payments.events (8 partitions)
Consumer Group: payment-processor

Deployment A: 4 consumers × 2 partitions each = moderate throughput
Deployment B: 8 consumers × 1 partition each = maximum throughput
Deployment C: 16 consumers × 1 partition each = same as B (extra consumers idle)
```

## مقارنة خوارزميات الضغط

| الخوارزمية | نسبة الضغط | كلفة المعالج | الزمن | حالة الاستخدام |
|-----------|------------------|----------|---------|----------|
| ‏`none` | 1.0x | صفر | الأدنى | حجم منخفض، زمن حرج |
| ‏`gzip` | 2.5–4x | عالية | عالٍ | الأرشفة، إنتاجية منخفضة |
| ‏`snappy` | 2x | منخفضة | منخفض | الاستخدام العام |
| ‏`lz4` | 2.5x | منخفضة جدًا | منخفض جدًا | إنتاجية عالية (موصى به) |
| ‏`zstd` | 3–4x | متوسطة | منخفض | أفضل موازنة بين النسبة والمعالج |

**التوصية لمواضيع أحداث الدفع:** ‏`lz4` — ضغط ممتاز بعبء معالج ضئيل. وأحداث الدفع عادة كائنات JSON صغيرة تنضغط جيدًا.

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

## إعداد الوسيط

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
socket.send.buffer.bytes=1048576     # 1MB (default: 100KB)
socket.receive.buffer.bytes=1048576  # 1MB (default: 100KB)
socket.request.max.bytes=104857600   # 100MB max request size

# Log flush — leave the defaults (no forced fsync): Kafka relies on
# replication across brokers plus the OS page cache for durability.
# Forcing periodic flushes (log.flush.interval.messages / .ms) mainly
# costs throughput.

# Log retention
log.retention.hours=168   # 7 days
log.segment.bytes=1073741824  # 1GB per segment

# ISR management
min.insync.replicas=2
default.replication.factor=3
```

## الضبط على مستوى نظام التشغيل

يعتمد أداء Kafka كثيرًا على نظام التشغيل، خاصة نظام الملفات وسلوك ذاكرة الصفحات.

### اختيار نظام الملفات

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

### معاملات نواة Linux

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

### ضبط JVM

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

## أثر عدد الأقسام

عدد الأقسام رافعة التوسع الأساسية، لكن لها عوائد متناقصة ومفاضلات:

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

## القياس باستخدام `kafka-producer-perf-test.sh`

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

**تفسير النتائج:**

| المقياس | جيد | يحتاج ضبطًا |
|--------|------|-------------|
| الإنتاجية (MB/s) | تلبي هدفك بهامش (كثيرًا ما تكون عشرات MB/s لكل قسم) | تحت الهدف، أو أقل بكثير من حد القرص/الشبكة |
| متوسط الزمن | < 5ms | > 50ms |
| زمن المئين 99 | < 50ms | > 500ms |
| أقصى قفزة زمن | < 500ms | > 5s |

## ضبط الأداء حسب حالة الاستخدام

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

## الخلاصات الأساسية

- الإنتاجية والزمن في توتر جوهري — اضبط لاتفاقية مستوى خدمة حالة استخدامك، لا لأقصى إنتاجية.
- **إنتاجية المنتج:** زِد `batch.size` ‏(64–256KB) و`linger.ms` ‏(5–100ms)؛ واستخدم ضغط `lz4`.
- **زمن المنتج المنخفض:** ‏`linger.ms=0` مع `batch.size` الافتراضي، بلا ضغط (فـ `batch.size` الصغير جدًا يجعل الزمن أسوأ تحت الحمل).
- **إنتاجية المستهلك:** زِد `fetch.min.bytes` و`max.poll.records`؛ ووسّع المستهلكين لمطابقة عدد الأقسام.
- **الضغط:** ‏`lz4` لأحداث الدفع (أفضل موازنة بين الإنتاجية والمعالج)؛ و`zstd` للأرشفة (أفضل نسبة).
- عدد الأقسام رافعة الإنتاجية الأساسية — خطّط بعناية لأن التقليل يتطلب إعادة إنشاء الموضوع.
- ضبط نظام التشغيل (XFS، و`noatime`، و`vm.swappiness=1`، وحدود واصفات الملفات، ومخازن الشبكة) يزيل اختناقات يمكن تجنبها — فقِس المكسب على عتادك.
- استخدم `kafka-producer-perf-test.sh` قبل تخطيط السعة، لا للتحقق بعد المشكلات فقط.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "أي إعدادات المنتج صحيحة لتقليل الزمن على حساب الإنتاجية؟",
      "options": [
        "batch.size=262144، وlinger.ms=100، وcompression.type=zstd",
        "linger.ms=0 مع batch.size الافتراضي، وcompression.type=none",
        "batch.size=65536، وlinger.ms=5، وcompression.type=lz4",
        "acks=1، وbatch.size=32768، وlinger.ms=10"
      ],
      "correct": 1,
      "explanation": "يعني أدنى زمن الإرسال فورًا دون انتظار: يرسل linger.ms=0 كل سجل حالما يستطيع خيط الإرسال، وتعطيل الضغط يزيل زمن معالجة الضغط. وأبقِ batch.size الافتراضي: فجعله صغيرًا جدًا (مثل 1) لا يجعل الإرسال أسرع — بل يفرض طلبًا لكل سجل، فتصطف الطلبات تحت الحمل ويزيد الزمن."
    },
    {
      "text": "ما صيغة الضغط الموصى بها لأرشفة أحداث الدفع حيث كفاءة التخزين هي الأولوية؟",
      "options": [
        "lz4 — أفضل موازنة بين الإنتاجية والمعالج",
        "snappy — أدنى عبء على المعالج",
        "zstd — أفضل نسبة ضغط",
        "gzip — مدعوم عالميًا"
      ],
      "correct": 2,
      "explanation": "يوفر zstd ‏(Zstandard) أفضل نسبة ضغط بين برامج الترميز المدعومة في Kafka، فيجعله الأمثل لحالات الأرشفة حيث تهم كلفة التخزين ونقل البيانات أكثر من عبء المعالج. ولأحداث الدفع الفورية، يُفضل lz4 لموازنته الأفضل بين المعالج والنسبة."
    },
    {
      "text": "لماذا عدد الأقسام رافعة توسيع الإنتاجية الأساسية، وما القيد الأساسي على زيادته؟",
      "options": [
        "الأقسام الأكثر تزيد الإدخال/الإخراج على قرص الوسيط لكن يمكن تقليلها بأمان لاحقًا",
        "الأقسام الأكثر تتيح مستهلكين ومنتجين متوازيين أكثر لكن لا يمكن تقليل عدد الأقسام دون إعادة إنشاء الموضوع",
        "الأقسام الأكثر تزيد عبء النسخ بالتناسب دون فائدة للإنتاجية",
        "عدد الأقسام يؤثر على إنتاجية المستهلك فقط، لا المنتج"
      ],
      "correct": 1,
      "explanation": "يمكن أن يستهلك كل قسم مثيل مستهلك واحد في المجموعة، فيحدد عدد الأقسام أقصى توازٍ للمستهلكين. ويستفيد المنتجون أيضًا من الأقسام الأكثر عبر الكتابات المتوازية. والقيد الحاسم أن Kafka لا تستطيع تقليل عدد الأقسام — بل زيادته فقط، فيصبح الاختيار الأولي مهمًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "ضبط Kafka لثلاث حالات استخدام لمعالجة المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "اضبط وقِس ثلاثة ملفات تعريف للمنتج: (أ) أحداث الدفع (acks=all، وidempotence، وbatch.size=32768، وlinger.ms=5، وضغط lz4)، (ب) إشارات الاحتيال الفورية (acks=1، وlinger.ms=0، وbatch.size الافتراضي، بلا ضغط)، (ج) أرشفة الامتثال (acks=1، وbatch.size=262144، وlinger.ms=100، وضغط zstd). واستخدم kafka-producer-perf-test.sh لقياس الإنتاجية وزمن المئين 99 لكل منها، وجرّب أيضًا batch.size=1 لـ (ب) لترى لماذا يضر تحت الحمل."},
    {"id": "2", "description": "اضبط إعدادات المستهلك لمعالجة تسوية عالية الإنتاجية: اضبط fetch.min.bytes=50000، وfetch.max.wait.ms=500، وmax.poll.records=500. وقِس الأثر على إنتاجية خدمة التسوية مقابل زمن المعالجة. وحدد القيمة المثلى لـ max.poll.records بمعطى زمن معالجة ثانيتين لكل دفعة."},
    {"id": "3", "description": "طبّق ضبطًا على مستوى نظام التشغيل لوسيط Kafka: اضبط vm.swappiness=1، وvm.dirty_background_ratio=5، واربط وحدة بيانات XFS بخيار noatime، وارفع حد واصفات الملفات لمستخدم kafka وزِد أحجام مخازن المقابس. وشغّل قياسات قبل وبعد لتحديد تحسن الإنتاجية."},
    {"id": "4", "description": "حلّل سيناريو قسم ساخن حيث يولّد حساب تاجر عالي الحجم 60% من كل أحداث الدفع. ونفّذ استراتيجية التقسيم الفرعي باستخدام لواحق أرقام تسلسلية (accountId + '-' + (seqNum % 4)) وأضف إعادة ترتيب بالأرقام التسلسلية على مستوى التطبيق في المستهلك لاستعادة الترتيب لكل حساب."}
  ]
}
-->
