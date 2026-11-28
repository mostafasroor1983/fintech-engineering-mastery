---
id: track-09-lesson-14
title: "Kafka متعدد المناطق — MirrorMaker 2 والنسخ المتماثل"
slug: multi-region-kafka
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 14
difficulty: principal
estimatedMinutes: 85
status: published
tags: [MirrorMaker, multi-region, geo-replication, failover, Kafka]
prerequisites: ["track-09-lesson-01", "track-09-lesson-08"]
---

# ‏Kafka متعدد المناطق — MirrorMaker 2 والنسخ

> [!NOTE]
> عنقود Kafka في منطقة واحدة نقطة فشل واحدة لكل معالجة المدفوعات. وتحتاج المؤسسات المالية Kafka متعدد المناطق للتعافي من الكوارث، والامتثال الجغرافي (إقامة البيانات)، والوصول منخفض الزمن من الخدمات الإقليمية. وMirrorMaker 2، المبني على Kafka Connect، هو الحل بمستوى إنتاجي — لكن آلية ترجمة الإزاحات فيه وإجراء التحول عند الفشل يتطلبان فهمًا عميقًا لتشغيله بشكل صحيح.

## لماذا Kafka متعدد المناطق

```
Single Region — Single Point of Failure:
  ┌──────────────────────────────────────────────────────┐
  │  AWS eu-west-1 (London)                              │
  │  Kafka Cluster + All Payment Services                │
  │  → Data centre outage = ALL payment processing stops │
  └──────────────────────────────────────────────────────┘

Multi-Region — Active-Passive:
  ┌─────────────────────┐         ┌─────────────────────┐
  │  eu-west-1 (Active) │───────► │  eu-west-2 (Standby)│
  │  Primary Cluster    │  Mirror │  Replica Cluster    │
  │  All writes here    │  Maker 2│  Reads in failover  │
  └─────────────────────┘         └─────────────────────┘

Multi-Region — Active-Active:
  ┌─────────────────────┐         ┌─────────────────────┐
  │  eu-west-1          │◄──────► │  us-east-1          │
  │  EU payment writes  │  Bidirec│  US payment writes  │
  │  Reads EU events    │  tional │  Reads US events    │
  └─────────────────────┘         └─────────────────────┘
```

**إقامة البيانات:** تشترط بعض الجهات الرقابية على المدفوعات بقاء بيانات معاملات عملاء الاتحاد الأوروبي داخل الاتحاد الأوروبي. ويتيح النسخ الانتقائي للمواضيع الامتثال: تُنسخ مواضيع مدفوعات الاتحاد الأوروبي داخل الاتحاد الأوروبي فقط؛ ومواضيع الولايات المتحدة داخل الولايات المتحدة فقط.

## بنية MirrorMaker 2

‏MirrorMaker 2 ‏(MM2) مبني على Kafka Connect. ويعمل كعنقود Kafka Connect يستخدم موصّلات داخلية لنسخ المواضيع بين العناقيد.

```
Source Cluster (eu-west-1)        MM2 (Kafka Connect)        Target Cluster (eu-west-2)
payments.events ───────────────► MirrorSourceConnector ─────► eu-west-1.payments.events
                                 MirrorCheckpointConnector ──► eu-west-1.checkpoints.internal
                                 MirrorHeartbeatConnector ───► heartbeats
```

**ثلاثة موصّلات داخلية:**

| الموصّل | الغرض |
|-----------|---------|
| ‏`MirrorSourceConnector` | ينسخ بيانات المواضيع من المصدر إلى الهدف |
| ‏`MirrorCheckpointConnector` | ينسخ إزاحات مجموعات المستهلكين (مترجمة) |
| ‏`MirrorHeartbeatConnector` | يراقب صحة النسخ |

**اصطلاح تسمية المواضيع:** مع سياسة النسخ الافتراضية، تُسبق المواضيع المنسوخة باسم عنقود المصدر المستعار. فيصبح `payments.events` على `eu-west-1` هو `eu-west-1.payments.events` على `eu-west-2`. وهذا يمنع تصادم الأسماء وحلقات النسخ في إعدادات النشط-النشط. (لنسخة تعافٍ من الكوارث نشطة-خاملة بحتة، يحتفظ `replication.policy.class=org.apache.kafka.connect.mirror.IdentityReplicationPolicy` ‏(Kafka 3.0+) بالأسماء الأصلية — لكن يجب حينها استبعاد الحلقات بالتصميم.)

## إعداد MirrorMaker 2

```properties
# mm2.properties — MirrorMaker 2 configuration

# Cluster aliases
clusters = eu-west-1, eu-west-2

# Source cluster connection
eu-west-1.bootstrap.servers = kafka-eu1-broker1:9092,kafka-eu1-broker2:9092,kafka-eu1-broker3:9092
eu-west-1.security.protocol = SASL_SSL
eu-west-1.sasl.mechanism = SCRAM-SHA-512
eu-west-1.sasl.jaas.config = org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="mm2-replicator" password="${file:/etc/mm2/secrets.properties:eu1.password}";

# Target cluster connection
eu-west-2.bootstrap.servers = kafka-eu2-broker1:9092,kafka-eu2-broker2:9092,kafka-eu2-broker3:9092
eu-west-2.security.protocol = SASL_SSL
eu-west-2.sasl.mechanism = SCRAM-SHA-512
eu-west-2.sasl.jaas.config = org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="mm2-replicator" password="${file:/etc/mm2/secrets.properties:eu2.password}";
config.providers = file
config.providers.file.class = org.apache.kafka.common.config.provider.FileConfigProvider

# Replication flow: eu-west-1 → eu-west-2
eu-west-1->eu-west-2.enabled = true
eu-west-1->eu-west-2.topics = payments\..*, accounts\..*, audit\..*
eu-west-1->eu-west-2.groups = payment-processor, settlement-service

# Topic replication config
replication.factor = 3
checkpoints.topic.replication.factor = 3
heartbeats.topic.replication.factor = 3
offset-syncs.topic.replication.factor = 3

# (MM2 has no "max lag" setting -- replication lag is MONITORED through
#  its metrics, e.g. replication-latency-ms, and alerted on; see below)

# Consumer group offset replication interval
emit.checkpoints.interval.seconds = 10
emit.heartbeats.interval.seconds = 1

# Sync consumer group offsets for failover (Kafka 2.7+): MM2 writes the
# TRANSLATED offsets directly into the target cluster's consumer groups
# (only while those groups are inactive there), so consumers that start on
# eu-west-2 with the same group id resume from the right place
sync.group.offsets.enabled = true
sync.group.offsets.interval.seconds = 60
```

## ترجمة الإزاحات

هذا المفهوم الحاسم الذي يجعل التحول عند الفشل في MM2 يعمل. فالإزاحات على عنقود المصدر وعنقود الهدف **مختلفة**: يعيّن الهدف إزاحاته الخاصة (قد يبدأ النسخ من نقطة مختلفة، وقد يحذف الاحتفاظ أو الضغط سجلات، ولا تُنسخ علامات المعاملات). فالإزاحة 1000 في `payments.events` على `eu-west-1` ليست عمومًا الإزاحة 1000 في `eu-west-1.payments.events` على `eu-west-2`.

```
Source (eu-west-1):              Target (eu-west-2):
payments.events partition 0      eu-west-1.payments.events partition 0
  offset 500: msg-A                offset 0: msg-A   (replication began here)
  offset 501: msg-B                offset 1: msg-B
  offset 502: msg-C  [replicated]  offset 2: msg-C
  offset 503: msg-D ←───────────── [not yet replicated — replication lag]
  offset 504: msg-E

Consumer group "settlement":
  Source committed offset: 503 (has consumed msg-A, msg-B, msg-C)
  Translated target offset: 3 (= next record after msg-C on the target)

MM2 records offset pairs (offset-syncs) only from time to time, so the
translation is CONSERVATIVE: after failover a consumer may re-read a few
records it already processed -- consumers must be idempotent.
```

يكتب `MirrorCheckpointConnector` في MM2 إزاحات مجموعات المستهلكين المترجمة إلى `eu-west-1.checkpoints.internal` على عنقود الهدف. ومع `sync.group.offsets.enabled=true` تُطبق أيضًا على مجموعات المستهلكين في الهدف تلقائيًا؛ وإلا فاقرأها بواجهة العميل أدناه.

### قراءة الإزاحات المترجمة في Java

```java
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.connect.mirror.RemoteClusterUtils;
import java.time.Duration;
import java.util.Map;

public class FailoverConsumerManager {

    private final Map<String, Object> targetClusterProps;   // bootstrap.servers + security of eu-west-2

    /**
     * On failover: read the translated consumer group offsets from the
     * TARGET cluster's checkpoint topic. The returned keys are already the
     * REMOTE topic partitions (e.g. eu-west-1.payments.events-0) -- do not
     * add the prefix a second time.
     */
    public Map<TopicPartition, OffsetAndMetadata> getTranslatedOffsets(
            String consumerGroup, String sourceClusterAlias) throws Exception {
        return RemoteClusterUtils.translateOffsets(
                targetClusterProps, sourceClusterAlias, consumerGroup,
                Duration.ofSeconds(30));
    }

    /**
     * Apply translated offsets to a consumer before starting it on the target cluster.
     * (Not needed when sync.group.offsets.enabled=true already wrote them
     *  into the target consumer group.)
     */
    public void seekToTranslatedOffsets(
            KafkaConsumer<?, ?> consumer,
            Map<TopicPartition, OffsetAndMetadata> translatedOffsets) {

        consumer.assign(translatedOffsets.keySet());
        translatedOffsets.forEach((tp, om) -> consumer.seek(tp, om.offset()));
        log.info("Consumer seeked to translated offsets after failover: {}", translatedOffsets);
    }
}
```

## النشط-النشط مقابل النشط-الخامل

### النشط-الخامل (موصى به للمدفوعات)

```
Normal operation:
  eu-west-1 (active): all payment writes + reads
  eu-west-2 (passive): receives replicated data, no writes, no reads

Failover:
  eu-west-1 goes down
  Consumers switch to eu-west-2, seek to translated offsets
  New writes go to eu-west-2
  When eu-west-1 recovers: start replicating from eu-west-2 back to eu-west-1
  Then switch back (optional)

Pros: Simple, no conflict resolution needed
Cons: eu-west-2 resources underutilised during normal operation
```

### النشط-النشط (معقد — استخدمه بحذر)

```
Normal operation:
  eu-west-1: handles EU customer payments
  us-east-1: handles US customer payments
  Each cluster replicates to the other bidirectionally

Complexity:
  - Avoid replicating back to origin (infinite loop)
    → MM2 uses provenance to detect and stop loops
    → Topics: eu-west-1.payments.events ≠ payments.events
  - Conflict resolution for same-entity updates
  - Consumer group offset sync must be bidirectional

Pros: Both clusters active, lower latency per region
Cons: Conflict resolution complexity, harder to reason about consistency
```

**توصية المهندس الرئيسي:** استخدم النشط-الخامل لأنظمة الدفع المالية ما لم يكن لديك متطلب زمن محدد يفرض النشط-النشط. فالتعقيد التشغيلي لحل التعارضات في النشط-النشط كبير.

## إجراء التحول عند الفشل

دليل تشغيل موثّق لتحويل المستهلكين من eu-west-1 إلى eu-west-2:

```
FAILOVER RUNBOOK: eu-west-1 → eu-west-2

Pre-condition: eu-west-1 Kafka is unavailable or degraded.

Step 1: Assess replication lag (before eu-west-1 fails)
  - Check MM2 metrics: kafka_connect_mirror_source_connector_replication_latency_ms
  - If lag > 5 seconds: some recent messages may not be replicated

Step 2: Stop consumers and producers on eu-west-1 (if still accessible)
  - Scale the applications that use eu-west-1 to zero, so nobody keeps
    writing to or consuming from the old cluster (split brain)

Step 3: Get translated offsets for each consumer group
  - Use MirrorClient.remoteConsumerOffsets() (see code above)
  - Or: kafka-consumer-groups.sh --bootstrap-server kafka-eu2:9092 \
      --group settlement-service --describe
      (shows offsets from eu-west-1.checkpoints.internal)

Step 4: Start consumers on eu-west-2 with translated offsets
  - Update application configuration: BOOTSTRAP_SERVERS=kafka-eu2-broker1:9092
  - Seek to translated offsets before starting consumption
  - Topic names change: payments.events → eu-west-1.payments.events
    (unless IdentityReplicationPolicy is used)
  - Expect a few re-processed messages (conservative offset translation):
    consumers must be idempotent

Step 5: Verify consumers are processing normally
  - Monitor consumer lag on eu-west-2
  - Verify payment processing metrics are normal

Step 6: Handle the gap (messages that didn't replicate)
  - If eu-west-1 recovers: replay un-replicated messages manually
  - If eu-west-1 is permanently lost: accept the gap, audit and compensate
```

## مراقبة تأخر نسخ MirrorMaker 2

```java
@Component
public class MirrorMaker2Monitor {

    @Autowired private AdminClient targetAdminClient;
    @Autowired private AlertService alertService;

    private static final Duration LAG_ALERT_THRESHOLD = Duration.ofSeconds(10);
    private final AtomicLong lagMsHolder = new AtomicLong();

    // Gauge registered ONCE; the scheduled job only updates the holder
    @Autowired
    void registerGauge(MeterRegistry meterRegistry) {
        Gauge.builder("kafka.mm2.replication.lag.ms", lagMsHolder, AtomicLong::get)
            .tags("source", "eu-west-1", "target", "eu-west-2")
            .register(meterRegistry);
    }

    @Scheduled(fixedDelay = 30_000)
    public void monitorReplicationLag() {
        try {
            // Read replication lag from MM2's JMX metrics, e.g.
            // kafka.connect.mirror:type=MirrorSourceConnector,target=eu-west-2,
            //   topic=eu-west-1.payments.events,partition=0
            //   attribute replication-latency-ms-max
            double lagMs = getMm2ReplicationLagMs();
            lagMsHolder.set(Math.round(lagMs));

            if (lagMs > LAG_ALERT_THRESHOLD.toMillis()) {
                alertService.sendAlert(AlertSeverity.HIGH,
                        String.format("MirrorMaker 2 replication lag is %.0fms (threshold: %dms)",
                                lagMs, LAG_ALERT_THRESHOLD.toMillis()));
            }

        } catch (Exception e) {
            log.error("Failed to monitor MM2 replication lag", e);
            alertService.sendAlert(AlertSeverity.CRITICAL,
                    "Cannot read MM2 replication lag — monitoring failure");
        }
    }

    // Check that all topics are being replicated
    @Scheduled(fixedDelay = 300_000)
    public void verifyTopicReplication() throws Exception {
        List<String> expectedTopics = List.of(
                "eu-west-1.payments.events",
                "eu-west-1.payments.audit",
                "eu-west-1.account.events"
        );

        Set<String> existingTopics = targetAdminClient.listTopics().names().get();

        for (String topic : expectedTopics) {
            if (!existingTopics.contains(topic)) {
                alertService.sendAlert(AlertSeverity.CRITICAL,
                        "Replicated topic " + topic + " not found on target cluster");
            }
        }
    }
}
```

**المقاييس الأساسية للمراقبة:**

```yaml
# Prometheus alert rules for MM2
groups:
  - name: mirrormaker2
    rules:
      - alert: MM2ReplicationLagHigh
        expr: kafka_mm2_replication_lag_ms > 10000
        for: 2m
        annotations:
          summary: "MM2 replication lag > 10s — failover readiness degraded"

      - alert: MM2ConnectorNotRunning
        # metric name depends on your Connect exporter
        expr: kafka_connect_connector_status{connector="MirrorSourceConnector"} != 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "MM2 source connector not running — replication stopped"
```

## إقامة البيانات بالنسخ الانتقائي

للامتثال لـ GDPR وFCA، انسخ انتقائيًا المواضيع غير الحساسة أو المسموح بها فقط:

```properties
# Replicate payment and account events -- an explicit allow-list (safest
# for compliance)
eu-west-1->eu-west-2.topics = ^(payments|accounts|audit)\..*$

# Additionally exclude PII topics by name (topics.exclude, Kafka 2.7+;
# the old name topics.blacklist is deprecated)
eu-west-1->eu-west-2.topics.exclude = customers\.pii, identity\.documents
```

## الخلاصات الأساسية

- ‏MirrorMaker 2 مبني على Kafka Connect — يستخدم موصّلات المصدر ونقاط التفتيش والنبض لنسخ المواضيع وإزاحات مجموعات المستهلكين.
- تُسبق المواضيع المنسوخة باسم عنقود المصدر المستعار: ‏`payments.events` ← `eu-west-1.payments.events`.
- **ترجمة الإزاحات** آلية التحول الحاسمة — فإزاحات المصدر لا تقابل إزاحات الهدف مباشرة؛ فعّل `sync.group.offsets.enabled` أو استخدم `RemoteClusterUtils.translateOffsets()`، وأبقِ المستهلكين idempotent (فالترجمة محافظة).
- **النشط-الخامل** موصى به لأنظمة الدفع — أبسط، بلا حل تعارضات، وأسهل في التفكير في الاتساق.
- **النشط-النشط** قابل للتطبيق على الأحمال المقسّمة جغرافيًا (كتابات الاتحاد الأوروبي إلى عنقوده، وكتابات الولايات المتحدة إلى عنقودها) لكنه يضيف تعقيدًا تشغيليًا كبيرًا.
- راقب تأخر النسخ باستمرار — فما لم يُنسخ بعد حين يفشل المصدر يكون مفقودًا على الهدف (ذلك التأخر هو RPO لديك).
- النسخ الانتقائي للمواضيع أساسي للامتثال لإقامة البيانات — انسخ فقط ما تسمح به الأنظمة.
- وثّق دليل التحول وتدرّب عليه كل ربع سنة — فإجراءات التحول غير المختبرة ستفشل تحت الضغط.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما اصطلاح التسمية الذي يطبقه MirrorMaker 2 على المواضيع المنسوخة، ولماذا يهم للتحول عند الفشل؟",
      "options": [
        "تُنسخ المواضيع بأسماء مطابقة؛ ولا يحتاج المستهلكون تغيير الإعداد",
        "تُسبق المواضيع باسم عنقود المصدر المستعار (مثل 'eu-west-1.payments.events')، فيحتاج المستهلكون تحديث اشتراكهم في الموضوع أثناء التحول",
        "تُلحق المواضيع باللاحقة '.replica' لتمييزها عن مواضيع المصدر",
        "يستخدم MirrorMaker 2 مساحات أسماء منفصلة ولا تُطبق إعادة تسمية"
      ],
      "correct": 1,
      "explanation": "يسبق MM2 المواضيع المنسوخة باسم عنقود المصدر المستعار لمنع حلقات النسخ اللانهائية ولتمييز بيانات المصدر عن النسخة. وأثناء التحول، يجب أن يحدّث المستهلكون اشتراكهم من 'payments.events' إلى 'eu-west-1.payments.events' على عنقود الهدف."
    },
    {
      "text": "لماذا لا يمكن استخدام إزاحات مجموعات المستهلكين في المصدر مباشرة على عنقود الهدف بعد التحول؟",
      "options": [
        "يستخدم عنقود الهدف صيغة إزاحات مختلفة",
        "يعيّن عنقود الهدف إزاحاته الخاصة (قد يبدأ النسخ من نقطة مختلفة، وقد يحذف الاحتفاظ أو الضغط سجلات، ولا تُنسخ علامات المعاملات)، فقد يشير رقم الإزاحة نفسه إلى رسالة مختلفة",
        "لا ينسخ MirrorMaker 2 إزاحات مجموعات المستهلكين",
        "أقسام عنقود الهدف تحوي دائمًا رسائل أقل من المصدر"
      ],
      "correct": 1,
      "explanation": "ينسخ MM2 السجلات لكن لا ينسخ إزاحاتها: فموضوع الهدف يرقّم السجلات بنفسه، والفجوات الناتجة عن الاحتفاظ أو الضغط أو علامات المعاملات تجعل الأرقام تتباعد. لذلك يسجل MM2 أزواج الإزاحات ويترجم إزاحات مجموعات المستهلكين (نقاط التفتيش)؛ ومع sync.group.offsets.enabled يطبقها على مجموعات الهدف. والترجمة محافظة، فقد تُعاد معالجة بضعة سجلات بعد التحول — فيجب أن يكون المستهلكون idempotent."
    },
    {
      "text": "لماذا يُوصى بالنشط-الخامل بدل النشط-النشط لأنظمة الدفع المالية؟",
      "options": [
        "يوفر النشط-الخامل إنتاجية أعلى من النشط-النشط",
        "يتطلب النشط-النشط موصّلات MirrorMaker 2 أكثر من المتاح",
        "يتجنب النشط-الخامل تعقيد حل التعارضات الناتج عن الكتابات المتزامنة للكيان نفسه عبر المناطق",
        "النشط-الخامل أرخص تشغيلًا من النشط-النشط"
      ],
      "correct": 2,
      "explanation": "يسمح النشط-النشط بالكتابة إلى العنقودين في آن واحد. فإذا عالجت منطقتان تحديثات للحساب نفسه بالتزامن، يلزم حل التعارضات. وفي الأنظمة المالية حيث صحة رصيد الحساب حرجة، يكون تعقيد حل التعارضات في النشط-النشط خطرًا تشغيليًا كبيرًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تصميم واختبار تحول Kafka متعدد المناطق عند الفشل لمعالجة المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "اضبط MirrorMaker 2 لنسخ 'payments.events' و'account.events' من eu-west-1 إلى eu-west-2 بطوبولوجيا نشطة-خاملة. وأعدّ MirrorSourceConnector، وMirrorCheckpointConnector، وMirrorHeartbeatConnector. واضبط النسخ الانتقائي بتعبير نمطي لقائمة مسموحة من المواضيع يستبعد مواضيع البيانات الشخصية للعملاء."},
    {"id": "2", "description": "نفّذ مكوّن MirrorMaker2Monitor يقرأ مقاييس تأخر النسخ كل 30 ثانية، ويسجل مقياس Prometheus من نوع Gauge لزمن النسخ، ويرسل تنبيهات HIGH حين يتجاوز التأخر 10 ثوانٍ وتنبيهات CRITICAL حين لا يعمل MirrorSourceConnector."},
    {"id": "3", "description": "اكتب إجراء التحول عند الفشل: (1) قِس تأخر النسخ الحالي، (2) احصل على إزاحات مجموعة المستهلكين المترجمة لـ 'settlement-service' (عبر sync.group.offsets.enabled، أو RemoteClusterUtils.translateOffsets())، (3) أوقف التطبيقات على eu-west-1 وحدّث إعداد خوادم bootstrap للمستهلك إلى وسطاء eu-west-2، (4) انقل المستهلكين إلى الإزاحات المترجمة قبل استئناف الاستهلاك من 'eu-west-1.payments.events'، وتحقق من امتصاص التكرارات بالمعالجة idempotent."},
    {"id": "4", "description": "نفّذ وأتمت تدريب تحول فصليًا: حاكِ عدم توفر eu-west-1، ونفّذ دليل التحول، وتحقق من استئناف معالجة المدفوعات على eu-west-2 دون رسائل مكررة أو مفقودة، وقِس RTO المحقق، ووثّق الفجوة بين RTO المستهدف والفعلي."}
  ]
}
-->
