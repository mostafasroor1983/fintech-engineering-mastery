---
id: track-09-lesson-17
title: "مراقبة Kafka — تأخر المستهلكين ومقاييس الوسطاء"
slug: kafka-monitoring
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 17
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [Kafka, monitoring, consumer-lag, JMX, Prometheus]
prerequisites: ["track-09-lesson-01", "track-09-lesson-03"]
---

# مراقبة Kafka — تأخر المستهلكين ومقاييس الوسطاء

> [!NOTE]
> الصحة التشغيلية لـ Kafka غير مرئية دون مراقبة فعالة. فمجموعة المستهلكين التي تتأخر — تعالج المدفوعات أبطأ مما تصل — لن ترمي استثناء أو تسجل خطأ واضحًا. والإشارة الوحيدة مقياس تأخر مستهلك متزايد. وحين يلاحظ أحد أصحاب المصلحة في العمل أن المدفوعات تتأخر، قد يمثل التأخر ساعات من التراكم. فابنِ المراقبة قبل أن تحتاجها.

## ما الذي يُراقب

تعمل مراقبة Kafka على ثلاثة مستويات:

```
Level 1: Broker Health
  → Is the cluster healthy? Is the leader balanced? Are replicas in sync?
  → Metrics: UnderReplicatedPartitions, ActiveControllerCount, ISR changes

Level 2: Consumer Group Lag
  → Are consumers keeping up with producers?
  → Metrics: records-lag, records-lag-max, consumer group offset vs end offset

Level 3: Producer Health
  → Is production working? Are records being written successfully?
  → Metrics: record-send-rate, record-error-rate, request-latency
```

## مقاييس JMX

تكشف Kafka كل مقاييسها الداخلية عبر JMX ‏(Java Management Extensions). ولكل وسيط ومنتج ومستهلك مئات مقاييس JMX. والتحدي اختيار الصحيح منها.

### تفعيل JMX على الوسطاء

```bash
# Recommended: run the Prometheus JMX exporter as a Java AGENT inside the
# broker JVM -- it reads the MBeans in-process and serves /metrics on 9404,
# so no remote JMX port has to be opened at all
export KAFKA_OPTS="-javaagent:/opt/jmx_prometheus_javaagent.jar=9404:/etc/jmx-exporter/config.yml"

# If you must open remote JMX (e.g. for a sidecar or jconsole), never do it
# unauthenticated and unencrypted outside a locked-down network:
# export JMX_PORT=9999
# export KAFKA_JMX_OPTS="-Dcom.sun.management.jmxremote \
#     -Dcom.sun.management.jmxremote.authenticate=true \
#     -Dcom.sun.management.jmxremote.ssl=true \
#     -Dcom.sun.management.jmxremote.port=9999 \
#     -Djava.rmi.server.hostname=broker1.kafka.internal"
```

### إعداد Prometheus JMX Exporter

```yaml
# jmx-exporter-config.yml
startDelaySeconds: 0
ssl: false
lowercaseOutputName: true
lowercaseOutputLabelNames: true
rules:
  # Broker request metrics
  - pattern: "kafka.server<type=BrokerTopicMetrics, name=(.+), topic=(.+)><>(Count|OneMinuteRate)"
    name: "kafka_server_broker_topic_metrics_$1"
    labels:
      topic: "$2"
      type: "$3"

  # Controller metrics
  - pattern: "kafka.controller<type=KafkaController, name=(.+)><>Value"
    name: "kafka_controller_$1"

  # Consumer metrics
  - pattern: "kafka.consumer<type=consumer-fetch-manager-metrics, client-id=(.+)><>records-lag-max"
    name: "kafka_consumer_records_lag_max"
    labels:
      client_id: "$1"

  # Producer metrics
  - pattern: "kafka.producer<type=producer-metrics, client-id=(.+)><>record-send-rate"
    name: "kafka_producer_record_send_rate"
    labels:
      client_id: "$1"
```

```yaml
# Alternative: JMX exporter as a sidecar (needs remote JMX from the broker,
# see the note above -- the in-process agent is simpler and safer)
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: kafka
      image: confluentinc/cp-kafka:7.6.0
    - name: jmx-exporter
      image: bitnami/jmx-exporter:0.19.0
      args: ["9404", "/etc/jmx-exporter/config.yml"]
      ports:
        - containerPort: 9404
          name: jmx-metrics
```

## مقاييس الوسطاء الحرجة

### ‏UnderReplicatedPartitions

```
kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions

Healthy value: 0
Alert threshold: > 0 for more than 60 seconds

Meaning: Partitions where not all replicas have caught up with the leader.
  - Value > 0 means data durability is reduced
  - If a broker fails while partitions are under-replicated, messages may be lost
  - Common cause: broker is overloaded, network issue, or rebalancing

Immediate action: Check broker logs, check network connectivity,
  check disk space and I/O on the lagging broker.
```

### ‏ActiveControllerCount

```
kafka.controller:type=KafkaController,name=ActiveControllerCount

Healthy value: 1 for the whole cluster — each node reports 1 if it is the
active controller, else 0, so alert on the SUM across nodes
(KRaft: the controller nodes report it)
Alert threshold: sum != 1

Sum = 0: No active controller — existing partition leaders keep serving,
         but no metadata changes are possible: no leader elections (a
         failed broker's partitions stay offline), no topic changes
Sum > 1: Multiple controllers (critical failure; with KRaft quorum
         this should only appear briefly during an election)
```

### ‏RequestHandlerAvgIdlePercent

```
kafka.server:type=KafkaRequestHandlerPool,name=RequestHandlerAvgIdlePercent

Healthy value: > 0.3 (30% idle — handlers have headroom)
Alert threshold: < 0.2 for more than 5 minutes

Meaning: If request handlers are < 20% idle, the broker is overloaded.
  - Slow responses to producers and consumers
  - Replication may fall behind
  - Consider adding brokers or reducing load
```

### فحص صحة الوسطاء الكامل

```java
import org.apache.kafka.clients.admin.*;
import org.springframework.stereotype.Component;
import org.springframework.scheduling.annotation.Scheduled;

@Component
public class KafkaBrokerHealthChecker {

    @Autowired private AdminClient adminClient;
    @Autowired private AlertService alertService;

    // Gauges registered ONCE on holders (meterRegistry.gauge(name, number)
    // called on every run would keep reporting the first value only)
    private final AtomicInteger brokerCount = new AtomicInteger();
    private final AtomicInteger underReplicatedHolder = new AtomicInteger();
    private final AtomicInteger offlineHolder = new AtomicInteger();

    @Autowired
    void registerGauges(MeterRegistry registry) {
        Gauge.builder("kafka.cluster.broker.count", brokerCount, AtomicInteger::get).register(registry);
        Gauge.builder("kafka.partitions.under_replicated", underReplicatedHolder, AtomicInteger::get).register(registry);
        Gauge.builder("kafka.partitions.offline", offlineHolder, AtomicInteger::get).register(registry);
    }

    @Scheduled(fixedDelay = 60_000)
    public void checkBrokerHealth() throws Exception {
        // Check under-replicated partitions via describe topics
        DescribeClusterResult cluster = adminClient.describeCluster();
        Collection<Node> nodes = cluster.nodes().get();

        brokerCount.set(nodes.size());

        // Check topic partition health
        ListTopicsResult topics = adminClient.listTopics();
        Set<String> topicNames = topics.names().get();

        DescribeTopicsResult topicDetails = adminClient.describeTopics(
                new ArrayList<>(topicNames));
        Map<String, TopicDescription> descriptions = topicDetails.all().get();

        int underReplicated = 0;
        int offlinePartitions = 0;

        for (TopicDescription td : descriptions.values()) {
            for (TopicPartitionInfo pi : td.partitions()) {
                if (pi.replicas().size() != pi.isr().size()) {
                    underReplicated++;
                }
                if (pi.leader() == null) {
                    offlinePartitions++;
                }
            }
        }

        underReplicatedHolder.set(underReplicated);
        offlineHolder.set(offlinePartitions);

        if (underReplicated > 0) {
            alertService.sendAlert(AlertSeverity.HIGH,
                    "Kafka has " + underReplicated + " under-replicated partitions");
        }
        if (offlinePartitions > 0) {
            alertService.sendAlert(AlertSeverity.CRITICAL,
                    "Kafka has " + offlinePartitions + " offline partitions");
        }
    }
}
```

## مراقبة تأخر المستهلكين

تأخر المستهلك أهم مقياس تشغيلي لأنظمة Kafka المالية. فهو يجيب مباشرة: "كم نحن متأخرون في معالجة المدفوعات؟"

```
Consumer Lag = End Offset (latest message) − Current Offset (last consumed)

Example:
  payments.events partition 0:
    Latest offset: 1,000,000
    Consumer group "settlement-service" committed offset: 999,500
    Lag = 500 messages
```

### مقاييس تأخر المستهلك في Spring Boot

يربط Spring Boot مقاييس عميل Kafka للمستهلكين الذين ينشئهم بـ Micrometer تلقائيًا (KafkaClientMetrics) — فلا شيء يلزم تفعيله. ويُبلغ كل مستهلك عن تأخر الأقسام التي يملكها حاليًا:

```
kafka.consumer.fetch.manager.records.lag{client.id="...", topic="...", partition="..."}
kafka.consumer.fetch.manager.records.lag.max{client.id="..."}
# Prometheus: kafka_consumer_fetch_manager_records_lag, ...
```

لأن المستهلك المتوقف أو المتعطل لا يُبلغ عن شيء، احسب التأخر أيضًا من الخارج (الإزاحات الملتزمة مقابل إزاحات النهاية)، كما أدناه. وتذكّر أن التأخر **بالرسائل** يحتاج سياقًا: 1,000 رسالة متأخرة عند 10,000 رسالة/ثانية تعني 0.1 ثانية، وعند 10 رسائل/ثانية تعني 100 ثانية — فنبّه على التأخر الزمني المقدّر (التأخر ÷ معدل الاستهلاك) حيث يمكن.

### المراقبة اليدوية للتأخر

```java
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.ListConsumerGroupOffsetsResult;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;

@Component
public class ConsumerLagMonitor {

    @Autowired private AdminClient adminClient;
    @Autowired private MeterRegistry meterRegistry;
    @Autowired private AlertService alertService;

    // One holder per meter id -- each gauge registered once, then updated
    private final Map<String, AtomicLong> holders = new ConcurrentHashMap<>();

    private void setGauge(String name, Tags tags, long value) {
        holders.computeIfAbsent(name + tags, k -> {
            AtomicLong h = new AtomicLong();
            Gauge.builder(name, h, AtomicLong::get).tags(tags).register(meterRegistry);
            return h;
        }).set(value);
    }

    private static final Map<String, Long> LAG_ALERT_THRESHOLDS = Map.of(
            "settlement-service", 1_000L,       // Alert if 1000+ messages behind
            "notification-service", 5_000L,     // Less critical — higher threshold
            "compliance-archival", 50_000L      // Batch processing — high threshold OK
    );

    @Scheduled(fixedDelay = 30_000)
    public void monitorConsumerLag() throws Exception {
        for (Map.Entry<String, Long> entry : LAG_ALERT_THRESHOLDS.entrySet()) {
            String groupId = entry.getKey();
            long alertThreshold = entry.getValue();

            Map<TopicPartition, Long> lag = calculateLag(groupId);

            long totalLag = lag.values().stream().mapToLong(Long::longValue).sum();
            long maxPartitionLag = lag.values().stream().mapToLong(Long::longValue).max()
                    .orElse(0L);

            // Record metrics
            setGauge("kafka.consumer.group.lag.total", Tags.of("group", groupId), totalLag);
            setGauge("kafka.consumer.group.lag.max.partition", Tags.of("group", groupId), maxPartitionLag);

            // Alert if threshold exceeded
            if (totalLag > alertThreshold) {
                alertService.sendAlert(AlertSeverity.HIGH,
                        String.format("Consumer group %s lag = %d (threshold: %d)",
                                groupId, totalLag, alertThreshold));
            }

            // Per-partition breakdown for debugging (always set -- also back
            // to 0 -- so a recovered partition does not keep its old value)
            lag.forEach((tp, partLag) ->
                setGauge("kafka.consumer.partition.lag",
                        Tags.of("group", groupId, "topic", tp.topic(),
                                "partition", String.valueOf(tp.partition())),
                        partLag));
        }
    }

    private Map<TopicPartition, Long> calculateLag(String groupId) throws Exception {
        // Get committed offsets for the consumer group
        Map<TopicPartition, OffsetAndMetadata> committedOffsets =
                adminClient.listConsumerGroupOffsets(groupId)
                        .partitionsToOffsetAndMetadata().get();

        if (committedOffsets.isEmpty()) {
            return Map.of();
        }

        // Get the end offsets (latest message position)
        Map<TopicPartition, Long> endOffsets =
                adminClient.listOffsets(
                        committedOffsets.keySet().stream()
                                .collect(Collectors.toMap(
                                        tp -> tp,
                                        tp -> OffsetSpec.latest()
                                ))
                ).all().get()
                .entrySet().stream()
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        e -> e.getValue().offset()
                ));

        // Calculate lag per partition (skip partitions without a commit)
        return committedOffsets.entrySet().stream()
                .filter(e -> e.getValue() != null)
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        e -> Math.max(0, endOffsets.getOrDefault(e.getKey(), 0L)
                                - e.getValue().offset())
                ));
    }
}
```

### فحص التأخر بسطر الأوامر

```bash
# Check consumer group lag for all topics
kafka-consumer-groups.sh \
    --bootstrap-server kafka:9092 \
    --group settlement-service \
    --describe

# Output:
# GROUP              TOPIC            PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# settlement-service payments.events  0          998432          999001          569
# settlement-service payments.events  1          997861          998400          539
# settlement-service payments.events  2          999100          999200          100

# Total lag = 569 + 539 + 100 = 1208 messages
```

## ‏Burrow لمراقبة تأخر المستهلكين

‏**Burrow** من LinkedIn أداة مخصصة لمراقبة مستهلكي Kafka تقيّم صحة مجموعات المستهلكين عبر الزمن، بدل استخدام عتبات ثابتة. (تحقق من نشاط المشروع الحالي قبل اعتماده؛ والبدائل الشائعة *Kafka Exporter* لـ Prometheus مع قواعد تنبيه، أو عروض التأخر في خدمات Kafka المُدارة وواجهات Kafka.)

```toml
# burrow.toml — Burrow configuration
[zookeeper]
servers=["zk1:2181", "zk2:2181", "zk3:2181"]

[kafka.payment-cluster]
servers=["broker1:9092", "broker2:9092", "broker3:9092"]

[consumer.payment-cluster]
cluster="payment-cluster"
servers=["broker1:9092"]

[httpserver.default]
address=":8000"

[storage.default]
class="inmemory"
intervals=10
expire-group=604800  # 7 days
```

يصنّف Burrow مجموعات المستهلكين إلى:
- ‏`OK` — يستهلك أسرع مما يُنتج
- ‏`WARNING` — التأخر ينمو ببطء
- ‏`ERROR` — التأخر ينمو بسرعة أو توقف المستهلك

## لوحة Grafana لـ Kafka

اللوحات الأساسية في لوحة Grafana لـ Kafka:

```json
{
    "panels": [
        {
            "title": "Consumer Lag by Group",
            "type": "timeseries",
            "targets": [{
                "expr": "sum by (group) (kafka_consumer_group_lag_total)",
                "legendFormat": "{{group}}"
            }]
        },
        {
            "title": "Under-Replicated Partitions",
            "type": "stat",
            "targets": [{
                "expr": "kafka_partitions_under_replicated",
                "thresholds": {"steps": [{"value": 0, "color": "green"}, {"value": 1, "color": "red"}]}
            }]
        },
        {
            "title": "Broker Request Handler Idle %",
            "type": "timeseries",
            "targets": [{
                "expr": "kafka_server_request_handler_avg_idle_percent",
                "legendFormat": "{{broker}}"
            }]
        },
        {
            "title": "Messages In Per Second (by topic)",
            "type": "timeseries",
            "targets": [{
                "expr": "rate(kafka_server_broker_topic_metrics_messagesin_count[5m])",
                "legendFormat": "{{topic}}"
            }]
        }
    ]
}
```

## قواعد التنبيه

```yaml
# prometheus-alerts.yml
groups:
  - name: kafka-critical
    rules:
      - alert: KafkaOfflinePartitions
        expr: kafka_partitions_offline > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "{{ $value }} offline partitions — cluster data loss risk"

      - alert: KafkaUnderReplicatedPartitions
        expr: kafka_partitions_under_replicated > 0
        for: 60s
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} under-replicated partitions"

      - alert: KafkaConsumerLagSpike
        expr: kafka_consumer_group_lag_total{group="settlement-service"} > 1000
        for: 5m
        labels:
          severity: high
        annotations:
          summary: "Settlement service consumer lag = {{ $value }} messages"

      - alert: KafkaBrokerDown
        expr: kafka_cluster_broker_count < 3
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Kafka cluster has only {{ $value }} brokers (expected 3)"

      - alert: KafkaRequestHandlerOverloaded
        expr: kafka_server_request_handler_avg_idle_percent < 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka request handlers < 20% idle — broker may be overloaded"
```

## الخلاصات الأساسية

- **تأخر المستهلك** أهم مقياس تشغيلي — فالمستهلك المتأخر فشل صامت يتحول إلى حادث عمل.
- اكشف مقاييس JMX عبر Prometheus JMX Exporter؛ واستخدم Micrometer في Spring Boot لمقاييس المستهلكين التلقائية.
- **‏UnderReplicatedPartitions=0** يجب أن يتحقق دائمًا — فأي قيمة فوق 0 تقلل ديمومة البيانات.
- **‏ActiveControllerCount** مجموعًا على العنقود يجب أن يساوي 1 بالضبط — فالصفر يعني استحالة تغييرات البيانات الوصفية (لا انتخاب قادة)، وأكثر من 1 تعارض بين المتحكمات.
- **‏RequestHandlerAvgIdlePercent > 0.3** — تحت 20% يكون الوسيط محمّلًا فوق طاقته ويحتاج سعة.
- استخدم `kafka-consumer-groups.sh` لفحوص التأخر السريعة؛ وابنِ مراقبة آلية للتنبيه المستمر.
- اضبط عتبات تنبيه التأخر لكل مجموعة مستهلكين بحسب اتفاقية مستوى خدمة العمل: التسوية (صارمة)، والإشعارات (متساهلة)، والأرشفة (متساهلة جدًا).
- تأخر المستهلكين + لوحة Grafana + تنبيهات Prometheus هي الحد الأدنى لحزمة المراقبة لعنقود Kafka مالي إنتاجي.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "علامَ يدل تأخر المستهلك ولماذا هو أهم مقياس تشغيلي لنظام Kafka للمدفوعات؟",
      "options": [
        "زمن الشبكة بين المنتج والوسيط",
        "عدد الأقسام بلا مستهلك نشط",
        "الفرق بين أحدث إزاحة في القسم والإزاحة الملتزمة لمجموعة المستهلكين — فيقيس مباشرة مدى تأخر معالجة المدفوعات",
        "الوقت منذ آخر إعادة تشغيل للوسيط"
      ],
      "correct": 2,
      "explanation": "تأخر المستهلك = إزاحة النهاية - الإزاحة الملتزمة. ولمستهلك تسوية المدفوعات، يعني التأخر مباشرة 'هذا العدد من المدفوعات ينتظر المعالجة'. والتأخر المتزايد فشل صامت — لا يُرمى استثناء، لكن تسوية المدفوعات تتأخر، فيصبح حادث عمل."
    },
    {
      "text": "علامَ يدل مجموع ActiveControllerCount على مستوى العنقود حين لا يساوي 1؟",
      "options": [
        "لدى العنقود وسطاء أكثر من اللازم للحمل الحالي",
        "مجموع 0 يعني عدم وجود متحكم نشط، فلا يمكن حدوث تغييرات في البيانات الوصفية (انتخاب القادة، وتغييرات المواضيع)؛ ومجموع أكبر من 1 يدل على متحكمات متعارضة",
        "عامل المراقبة لا يقرأ مقاييس JMX بشكل صحيح",
        "وسيط واحد ينفذ انتخاب قائد وهذا طبيعي"
      ],
      "correct": 1,
      "explanation": "يجب أن تكون عقدة واحدة بالضبط هي المتحكم النشط. ودون متحكم، تواصل الأقسام التي ما زال قائدها حيًا خدمة المنتجين والمستهلكين، لكن لا يمكن أي تغيير في البيانات الوصفية: فإذا فشل وسيط، لا تحصل أقسامه على قائد جديد وتبقى غير متصلة، ولا يمكن إنشاء المواضيع أو تغييرها. ووجود أكثر من متحكم نشط سيكون تعارضًا (انقسام في الدماغ). وكلاهما تنبيه حرج يتطلب استجابة فورية."
    },
    {
      "text": "لماذا يجب أن تختلف عتبات تنبيه التأخر بين مجموعات مستهلكين مثل settlement-service وcompliance-archival؟",
      "options": [
        "تستخدم المجموعات المختلفة صيغ تسلسل مختلفة تؤثر على حساب التأخر",
        "لمجموعات المستهلكين المختلفة اتفاقيات مستوى خدمة عمل مختلفة — فالتسوية تتطلب معالجة شبه فورية بينما تحتمل الأرشفة تراكمات كبيرة",
        "تعالج أرشفة الامتثال حمولات رسائل أكبر فلها تأخر أعلى بطبيعتها",
        "يجب أن تكون عتبات التنبيه متطابقة دائمًا من أجل الاتساق"
      ],
      "correct": 1,
      "explanation": "تعالج خدمة التسوية معاملات مالية — فتأخر 1,000 رسالة قد يعني مدفوعات متأخرة. وتخزن أرشفة الامتثال السجلات للتدقيق — فتأخر 50,000 رسالة مقبول إذا لحقت خلال ساعات. ويجب أن تعكس العتبات اتفاقيات مستوى خدمة العمل، لا التماثل التقني."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء حزمة مراقبة Kafka كاملة لمنصة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "نفّذ ConsumerLagMonitor يستخدم AdminClient لحساب التأخر لكل قسم لثلاث مجموعات مستهلكين (عتبة settlement-service: ‏1,000؛ وnotification-service: ‏5,000؛ وcompliance-archival: ‏50,000). وسجّل مقاييس Prometheus من نوع Gauge لإجمالي التأخر وأقصى تأخر قسم لكل مجموعة. وأرسل تنبيهات بخطورة HIGH حين تُتجاوز العتبات."},
    {"id": "2", "description": "اكشف مقاييس JMX للوسطاء عبر عامل Java لـ Prometheus JMX Exporter لـ UnderReplicatedPartitions، وActiveControllerCount، وOfflinePartitionsCount، وRequestHandlerAvgIdlePercent. واضبط جمع Prometheus ونفّذ قواعد التنبيه: UnderReplicatedPartitions>0 (تحذير)، وsum(ActiveControllerCount)!=1 (حرج)، وOfflinePartitions>0 (حرج)، وRequestHandlerAvgIdlePercent<0.2 (تحذير)."},
    {"id": "3", "description": "ابنِ لوحة Grafana بأربع لوحات فرعية: (1) سلسلة زمنية لتأخر المستهلكين حسب المجموعة، (2) إحصائية الأقسام ناقصة النسخ بعتبة حمراء عند 1، (3) سلسلة زمنية لنسبة خمول معالجات طلبات الوسيط بخط تنبيه عند 20%، (4) الرسائل الواردة في الثانية حسب الموضوع. وصدّر JSON اللوحة للنشر عبر GitOps."},
    {"id": "4", "description": "اضبط Burrow لمراقبة payment-cluster، وتصنيف مجموعات المستهلكين إلى OK/WARNING/ERROR، وكشف حالة الصحة عبر واجهة HTTP الخاصة به. ونفّذ مؤشر صحة في Spring Boot يستعلم واجهة Burrow ويُبلغ DOWN إذا كانت أي مجموعة مستهلكين مراقبة في حالة ERROR لأكثر من 5 دقائق."}
  ]
}
-->
