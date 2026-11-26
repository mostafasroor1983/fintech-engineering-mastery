---
id: track-09-lesson-08
title: "Kafka Connect — بنية موصلات المصدر والوجهة"
slug: kafka-connect
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 8
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Kafka-Connect, source-connector, sink-connector, SMT, worker]
prerequisites: [kafka-architecture, outbox-cdc-debezium]
---

# ‏Kafka Connect — بنية موصّلات المصدر والمصب

> [!NOTE]
> ‏Kafka Connect هي طبقة التكامل في منظومة Kafka. فبدل كتابة شيفرة منتج/مستهلك مخصصة لكل مصدر بيانات ومصب، توفر Connect إطارًا بموصّلات مثبتة ومختبرة إنتاجيًا لقواعد البيانات، ومخازن الكائنات، ومحركات البحث، وغيرها. وللأنظمة المالية، تتولى التعقيد التشغيلي لاستطلاع قواعد البيانات، وقراءة WAL، وإدارة الإزاحات، ومنطق إعادة المحاولة — فيركز مهندسوك على منطق العمل.

## ما Kafka Connect

‏Kafka Connect إطار لبناء الموصّلات وتشغيلها — مكونات تنسخ البيانات بين Kafka والأنظمة الخارجية. وتتولى:

- **إدارة الإزاحات** — تتبع ما استُهلك/أُنتج
- **توزيع العمال** — توزيع مهام الموصّلات على عقد العمال
- **واجهة REST** — إدارة دورة حياة الموصّلات
- **معالجة الأخطاء** — إعادة المحاولة، ومواضيع الرسائل الميتة، والإبلاغ عن الأخطاء
- **التحويلات** — تحويلات الرسالة الواحدة (SMT) للتعديل الخفيف للرسائل

```
External Systems             Kafka Connect              Kafka
                           ┌──────────────────┐
PostgreSQL ──(JDBC Source)─┤                  ├──► payments.db.events
                           │  Kafka Connect   │
Kafka ──────(S3 Sink)──────┤  Worker Cluster  ├──► S3 Bucket (archival)
                           │                  │
Kafka ──────(ES Sink)──────┤                  ├──► Elasticsearch (search)
                           └──────────────────┘
```

## بنية الوضع الموزع

في الإنتاج، تعمل Kafka Connect في **الوضع الموزع** — مثيلات عمال متعددة تتقاسم عمل تشغيل الموصّلات.

```
Worker 1                    Worker 2                    Worker 3
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│ Connector A     │         │ Connector A     │         │ Connector B     │
│   Task 0        │         │   Task 1        │         │   Task 0        │
│   Task 2        │         │                 │         │   Task 1        │
│                 │         │ Connector B     │         │                 │
│ Connector C     │         │   Task 2        │         │                 │
│   Task 0        │         │                 │         │                 │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                           │                            │
         └───────────── Kafka (config, offset, status topics) ───┘
```

يستخدم العمال ثلاثة مواضيع Kafka داخلية للتنسيق:
- ‏`connect-configs` — إعدادات الموصّلات والمهام
- ‏`connect-offsets` — إزاحات القراءة لموصّلات المصدر
- ‏`connect-status` — حالة الموصّلات والمهام

```properties
# Worker configuration (connect-distributed.properties)
bootstrap.servers=kafka:9092
group.id=connect-cluster

config.storage.topic=connect-configs
offset.storage.topic=connect-offsets
status.storage.topic=connect-status

config.storage.replication.factor=3
offset.storage.replication.factor=3
status.storage.replication.factor=3

key.converter=org.apache.kafka.connect.json.JsonConverter
value.converter=org.apache.kafka.connect.json.JsonConverter
key.converter.schemas.enable=false
value.converter.schemas.enable=false

# For Avro with Schema Registry
# key.converter=io.confluent.connect.avro.AvroConverter
# value.converter=io.confluent.connect.avro.AvroConverter
# value.converter.schema.registry.url=http://schema-registry:8081
```

## موصّل مصدر JDBC (استطلاع قاعدة البيانات)

يستطلع موصّل مصدر JDBC جدول قاعدة بيانات أو استعلامًا وفق جدول زمني، فينشر الصفوف الجديدة/المتغيرة كرسائل Kafka.

```json
{
    "name": "payments-jdbc-source",
    "config": {
        "connector.class": "io.confluent.connect.jdbc.JdbcSourceConnector",
        "connection.url": "jdbc:postgresql://postgres:5432/payments_db",
        "connection.user": "kafka_connect_user",
        "connection.password": "${file:/secrets/jdbc.properties:password}",

        "mode": "timestamp+incrementing",
        "timestamp.column.name": "updated_at",
        "timestamp.delay.interval.ms": "5000",
        "incrementing.column.name": "id",
        "table.whitelist": "payments",

        "topic.prefix": "jdbc.",
        "poll.interval.ms": "5000",
        "batch.max.rows": "1000",

        "transforms": "createKey,extractKey",
        "transforms.createKey.type": "org.apache.kafka.connect.transforms.ValueToKey",
        "transforms.createKey.fields": "id",
        "transforms.extractKey.type": "org.apache.kafka.connect.transforms.ExtractField$Key",
        "transforms.extractKey.field": "id"
    }
}
```

**أوضاع الاستطلاع:**

| الوضع | الوصف | حالة الاستخدام |
|------|-------------|----------|
| ‏`incrementing` | يستخدم عمودًا متزايدًا تلقائيًا | جداول الإلحاق فقط |
| ‏`timestamp` | يستخدم طابع آخر تعديل | جداول فيها تحديثات |
| ‏`timestamp+incrementing` | الاثنان — الأمتن | الاستخدام العام |
| ‏`bulk` | الجدول كاملًا في كل استطلاع | الجداول المرجعية الصغيرة |

**القيد مقارنة بـ CDC:** يفوّت استطلاع JDBC عمليات الحذف وأي تحديثات وسيطة بين استطلاعين (فهو يرى الصف الحالي فقط)، وزمنه أعلى، ويضيف حملًا على قاعدة البيانات. وقد تفوّت أوضاع الطابع الزمني أيضًا صفوفًا من معاملات طويلة تلتزم بـ `updated_at` أقدم من آخر استطلاع — ويقلل `timestamp.delay.interval.ms` (أعلاه) هذا الخطر بالانتظار قليلًا قبل قراءة الصفوف الحديثة. واستخدم Debezium CDC ‏(الدرس 06) حين يمكن؛ واستخدم JDBC حين لا يتوفر النسخ المنطقي أو لا يُسمح به. وأبقِ الأسرار خارج JSON الموصّل — استخدم مزود إعدادات (`${file:...}`) كما هو موضح.

## موصّل مصب S3 (الأرشفة)

يقرأ موصّل مصب S3 من مواضيع Kafka ويكتب إلى Amazon S3، فيتيح التخزين طويل الأمد والتكامل مع بحيرة البيانات.

```json
{
    "name": "payments-s3-sink",
    "config": {
        "connector.class": "io.confluent.connect.s3.S3SinkConnector",
        "tasks.max": "4",
        "topics": "payments.events,payments.audit",

        "s3.region": "eu-west-1",
        "s3.bucket.name": "fintech-payments-archive",
        "s3.part.size": "67108864",

        "storage.class": "io.confluent.connect.s3.storage.S3Storage",
        "format.class": "io.confluent.connect.s3.format.parquet.ParquetFormat",

        "flush.size": "50000",
        "rotate.interval.ms": "3600000",
        "rotate.schedule.interval.ms": "3600000",

        "locale": "en_GB",
        "timezone": "UTC",
        "timestamp.extractor": "RecordField",
        "timestamp.field": "createdAt",

        "s3.ssea.name": "aws:kms",
        "s3.sse.kms.key.id": "arn:aws:kms:eu-west-1:123456789:key/abc-123",

        "partitioner.class": "io.confluent.connect.storage.partitioner.TimeBasedPartitioner",
        "path.format": "'year'=YYYY/'month'=MM/'day'=dd/'hour'=HH",

        "schema.compatibility": "FULL"
    }
}
```

ملاحظات: تحتاج صيغة Parquet سجلات **ذات مخطط** — فاستخدم محوّل Avro/Protobuf/JSON Schema لهذا الموصّل، لا محوّل JSON بلا مخطط من إعدادات العامل الافتراضية. ويتخلى `rotate.schedule.interval.ms` (تدوير بساعة الحائط) عن مخرجات الملفات بمرة واحدة بالضبط في الموصّل؛ وللملفات الحتمية اعتمد على `flush.size` و`rotate.interval.ms` فقط.

ينشئ هذا بحيرة بيانات Parquet مقسّمة في:

```
s3://fintech-payments-archive/
  payments.events/
    year=2026/month=11/day=08/hour=14/
      payments.events+0+0000050000.parquet
      payments.events+1+0000050000.parquet
```

## تحويلات الرسالة الواحدة (SMT)

‏SMT تحويلات خفيفة تُطبق على كل رسالة أثناء مرورها عبر موصّل. وهي متسلسلة وتُطبق بالترتيب.

### إخفاء الحقول (دفاع متعدد الطبقات)

أخفِ الحقول الحساسة قبل أن تصل إلى مصبات معينة. ومهم لـ PCI DSS: **يجب ألا يُخزن رمز CVV إطلاقًا** بعد التفويض — فيجب ألا يُكتب في Kafka أصلًا — ويجب ترميز أرقام البطاقات الكاملة (PAN) **قبل** النشر، لأن كل موضوع ووسيط يحمل PAN يقع ضمن نطاق PCI. والإخفاء في موصّل مصب مجرد شبكة أمان إضافية:

```json
{
    "transforms": "maskCardNumber",
    "transforms.maskCardNumber.type":
        "org.apache.kafka.connect.transforms.MaskField$Value",
    "transforms.maskCardNumber.fields": "cardNumber",
    "transforms.maskCardNumber.replacement": "MASKED"
}
```

### التوجيه (اختيار الموضوع)

أعد تسمية موضوع الوجهة باستخدام تعبير نمطي على **اسم الموضوع** (لا يستطيع RegexRouter النظر في قيم الحقول — فالتوجيه حسب المحتوى يحتاج SMT مخصصًا أو معالج تدفقات):

```json
{
    "transforms": "routeByRegion",
    "transforms.routeByRegion.type":
        "org.apache.kafka.connect.transforms.RegexRouter",
    "transforms.routeByRegion.regex": "payments\\.(.+)",
    "transforms.routeByRegion.replacement": "payments-emea.$1"
}
```

### الترشيح (إسقاط السجلات غير المرغوبة)

(‏`io.confluent.connect.transforms.Filter` تحويل SMT مرخّص من Confluent. أما `Filter` المدمج في Apache Kafka فيعمل مع *شروط (predicates)* على أسماء المواضيع، أو الترويسات، أو سجلات الحذف، لا على قيم الحقول.)

```json
{
    "transforms": "filterSmallPayments",
    "transforms.filterSmallPayments.type":
        "io.confluent.connect.transforms.Filter$Value",
    "transforms.filterSmallPayments.filter.condition":
        "$[?(@.amount > 10000)]",
    "transforms.filterSmallPayments.filter.type": "include"
}
```

### إضافة الحقول (الإثراء)

```json
{
    "transforms": "addTimestamp",
    "transforms.addTimestamp.type":
        "org.apache.kafka.connect.transforms.InsertField$Value",
    "transforms.addTimestamp.timestamp.field": "kafka_ingested_at"
}
```

### ‏SMT مخصص لمعالجة المدفوعات

```java
import org.apache.kafka.common.config.ConfigDef;
import org.apache.kafka.connect.connector.ConnectRecord;
import org.apache.kafka.connect.errors.DataException;
import org.apache.kafka.connect.transforms.Transformation;
import java.util.HashMap;
import java.util.Map;

/**
 * Custom SMT that adds a data_classification field based on payment amount.
 * Used to route high-value payments to enhanced monitoring topics.
 * This version handles SCHEMALESS values (Map, e.g. JsonConverter with
 * schemas.enable=false); records with a schema arrive as Struct and need
 * a schema-aware variant that builds a new Schema + Struct.
 */
public class PaymentClassificationSMT<R extends ConnectRecord<R>>
        implements Transformation<R> {

    private static final String AMOUNT_FIELD = "amount";
    private static final long HIGH_VALUE_THRESHOLD = 100_000_00L; // 100,000.00 in minor units

    @Override
    @SuppressWarnings("unchecked")
    public R apply(R record) {
        if (record.value() == null) return record;   // tombstone
        if (!(record.value() instanceof Map)) {
            throw new DataException("PaymentClassificationSMT expects schemaless (Map) values");
        }

        Map<String, Object> value = (Map<String, Object>) record.value();
        // JSON numbers may arrive as Integer or Long -- read as Number
        Object rawAmount = value.get(AMOUNT_FIELD);
        if (!(rawAmount instanceof Number amount)) return record;

        Map<String, Object> updatedValue = new HashMap<>(value);
        boolean highValue = amount.longValue() >= HIGH_VALUE_THRESHOLD;
        updatedValue.put("data_classification", highValue ? "HIGH_VALUE" : "STANDARD");
        updatedValue.put("enhanced_monitoring", highValue);

        return record.newRecord(
                record.topic(), record.kafkaPartition(),
                record.keySchema(), record.key(),
                null, updatedValue,                    // still schemaless
                record.timestamp()
        );
    }

    @Override
    public ConfigDef config() {
        return new ConfigDef(); // No configuration needed
    }

    @Override
    public void configure(Map<String, ?> configs) {}

    @Override
    public void close() {}
}
```

## دورة حياة الموصّل (واجهة REST)

تكشف Kafka Connect واجهة REST لإدارة الموصّلات. وبهذا يتفاعل المشغّلون وخطوط CI/CD مع Connect.

```bash
# Create a connector
curl -X POST http://connect:8083/connectors \
  -H "Content-Type: application/json" \
  -d @payments-s3-sink.json

# List all connectors
curl http://connect:8083/connectors

# Get connector status
curl http://connect:8083/connectors/payments-s3-sink/status
# Response:
# {
#   "name": "payments-s3-sink",
#   "connector": {"state": "RUNNING", "worker_id": "worker-1:8083"},
#   "tasks": [
#     {"id": 0, "state": "RUNNING", "worker_id": "worker-1:8083"},
#     {"id": 1, "state": "FAILED", "worker_id": "worker-2:8083",
#      "trace": "org.apache.kafka.connect.errors.ConnectException: ..."}
#   ]
# }

# Pause a connector (stops consuming/producing, retains config)
curl -X PUT http://connect:8083/connectors/payments-s3-sink/pause

# Resume a paused connector
curl -X PUT http://connect:8083/connectors/payments-s3-sink/resume

# Restart a failed task
curl -X POST http://connect:8083/connectors/payments-s3-sink/tasks/1/restart

# Restart the connector and only its FAILED tasks in one call (Kafka 3.0+)
curl -X POST "http://connect:8083/connectors/payments-s3-sink/restart?includeTasks=true&onlyFailed=true"

# Update connector configuration
curl -X PUT http://connect:8083/connectors/payments-s3-sink/config \
  -H "Content-Type: application/json" \
  -d '{"tasks.max": "8", ...}'

# Delete a connector
curl -X DELETE http://connect:8083/connectors/payments-s3-sink
```

### إدارة الموصّلات عبر Spring

```java
import org.springframework.web.client.RestTemplate;
import org.springframework.stereotype.Service;
import java.util.Map;

@Service
public class KafkaConnectManager {

    private final RestTemplate restTemplate;
    private final String connectUrl = "http://connect:8083";

    public KafkaConnectManager(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public ConnectorStatus getStatus(String connectorName) {
        String url = connectUrl + "/connectors/" + connectorName + "/status";
        return restTemplate.getForObject(url, ConnectorStatus.class);
    }

    public void restartFailedTasks(String connectorName) {
        ConnectorStatus status = getStatus(connectorName);
        for (TaskStatus task : status.getTasks()) {
            if ("FAILED".equals(task.getState())) {
                String url = connectUrl + "/connectors/" + connectorName
                        + "/tasks/" + task.getId() + "/restart";
                restTemplate.postForObject(url, null, Void.class);
                log.info("Restarted failed task {} for connector {}",
                        task.getId(), connectorName);
            }
        }
    }
}
```

## إدارة الإزاحات

لـ **موصّلات المصدر**، تتتبع Connect آخر موضع قراءة باستخدام موضوع `connect-offsets`. والمفتاح معرّف قسم المصدر؛ والقيمة آخر إزاحة معالجة.

```
Key:   ["payments-jdbc-source", {"query": "", "table": "payments"}]
Value: {"incrementing": 1000247, "timestamp": 1699200000000}
```

تُلتزم هذه الإزاحة بعد إرسال كل دفعة سجلات إلى Kafka بنجاح. فإذا تعطل الموصّل، يستأنف من آخر إزاحة ملتزمة — تسليم مرة واحدة على الأقل.

ولـ **موصّلات المصب**، تُتتبع الإزاحات عبر آلية مجموعات المستهلكين القياسية في Kafka (لا يُستخدم موضوع `connect-offsets`).

## معالجة الأخطاء ومواضيع الرسائل الميتة

```json
{
    "errors.tolerance": "all",
    "errors.log.enable": true,
    "errors.log.include.messages": true,
    "errors.deadletterqueue.topic.name": "payments.connect.dlq",
    "errors.deadletterqueue.topic.replication.factor": 3,
    "errors.deadletterqueue.context.headers.enable": true
}
```

حين يكون `errors.tolerance=all`، تُتخطى السجلات التي تفشل في **التحويل أو التحول** (وتُكتب إلى DLQ في موصّلات **المصب**) بدل إيقاف الموصّل. وقيدان: مواضيع الرسائل الميتة موجودة لموصّلات المصب فقط، وأخطاء الكتابة إلى النظام الخارجي نفسه لا يغطيها `errors.tolerance`. ولبيانات الدفع، قد يُسقط "تحمّل الكل" السجلات بصمت — فنبّه على كل رسالة تصل إلى DLQ. وتحتوي ترويسات رسائل DLQ على تفاصيل الخطأ:

```
Header: __connect.errors.topic = payments.events
Header: __connect.errors.partition = 2
Header: __connect.errors.offset = 44821
Header: __connect.errors.connector.name = payments-s3-sink
Header: __connect.errors.exception.class.name = org.apache.kafka.connect.errors.DataException
Header: __connect.errors.exception.message = Failed to convert value...
```

## مراقبة الموصّلات

```java
// Spring Boot actuator endpoint for Connect health. Use it for dashboards /
// readiness of the dependent feature -- NOT as a Kubernetes liveness probe
// (a broken connector is no reason to restart this application)
@Component
public class KafkaConnectHealthIndicator implements HealthIndicator {

    @Autowired
    private KafkaConnectManager connectManager;

    private static final List<String> MONITORED_CONNECTORS = List.of(
            "payment-outbox-connector",
            "payments-s3-sink",
            "payments-jdbc-source"
    );

    @Override
    public Health health() {
        boolean allHealthy = true;
        Map<String, Object> details = new HashMap<>();

        for (String connector : MONITORED_CONNECTORS) {
            try {
                ConnectorStatus status = connectManager.getStatus(connector);
                boolean isRunning = "RUNNING".equals(status.getConnector().getState());
                long failedTasks = status.getTasks().stream()
                        .filter(t -> "FAILED".equals(t.getState()))
                        .count();

                details.put(connector, Map.of(
                        "state", status.getConnector().getState(),
                        "failedTasks", failedTasks
                ));

                if (!isRunning || failedTasks > 0) {
                    allHealthy = false;
                }
            } catch (Exception e) {
                details.put(connector, "UNREACHABLE");
                allHealthy = false;
            }
        }

        return allHealthy
                ? Health.up().withDetails(details).build()
                : Health.down().withDetails(details).build();
    }
}
```

## الخلاصات الأساسية

- يشغّل الوضع الموزع لـ Kafka Connect الموصّلات عبر عقد عمال متعددة، مع استخدام مواضيع Kafka للتنسيق.
- **موصّلات المصدر** تجلب البيانات إلى Kafka (استطلاع JDBC، وDebezium CDC)؛ و**موصّلات المصب** تكتب البيانات من Kafka إلى أنظمة خارجية (S3، وElasticsearch، وJDBC).
- يستطلع موصّل مصدر JDBC وفق جدول زمني — أبسط من CDC لكنه يفوّت عمليات الحذف ويضيف حملًا على قاعدة البيانات.
- ينشئ موصّل مصب S3 بحيرات بيانات Parquet مقسّمة للأرشفة والتحليلات.
- **‏SMT** الأداة الصحيحة لإخفاء الحقول، والتوجيه، والتحويل الخفيف — والمنطق المعقد مكانه Kafka Streams.
- تدير واجهة REST دورة حياة الموصّل كاملة: الإنشاء، والإيقاف المؤقت، والاستئناف، وإعادة تشغيل المهام الفاشلة، والحذف.
- معالجة الأخطاء بـ `errors.tolerance=all` ومواضيع الرسائل الميتة تمنع السجلات السيئة المفردة من إيقاف الموصّلات.
- راقب حالة الموصّلات وأعداد المهام الفاشلة — فالمهام FAILED تتوقف عن المعالجة بصمت حتى يُعاد تشغيلها.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما القيد الأساسي لموصّل مصدر JDBC مقارنة بـ Debezium CDC؟",
      "options": [
        "لا يدعم موصّل مصدر JDBC قاعدة PostgreSQL",
        "يفوّت موصّل مصدر JDBC عمليات DELETE، ويضيف حمل استعلامات على قاعدة البيانات، وزمنه أعلى",
        "لا يستطيع موصّل مصدر JDBC التعامل مع تغييرات المخطط",
        "يدعم موصّل مصدر JDBC وضع incrementing فقط"
      ],
      "correct": 1,
      "explanation": "يفوّت استطلاع JDBC عمليات DELETE (فهي لا تنتج تحديثًا يمكن كشفه)، ويضيف حمل استعلامات مجدولة على قاعدة البيانات، وزمنه أعلى (فترة الاستطلاع) مقارنة بـ Debezium الذي يقرأ WAL شبه فوري بعبء ضئيل على قاعدة البيانات."
    },
    {
      "text": "لأي غرض صُممت تحويلات الرسالة الواحدة (SMT) في Kafka Connect؟",
      "options": [
        "منطق معالجة تدفقات معقد مثل الربط والتجميع",
        "تحويلات خفيفة لكل رسالة مثل إخفاء الحقول، والتوجيه، والإثراء",
        "التحقق من المخططات وفرضها",
        "إدارة إزاحات المستهلك"
      ],
      "correct": 1,
      "explanation": "صُممت SMT لتحويلات خفيفة بلا حالة لكل رسالة — إخفاء حقول البيانات الشخصية، والتوجيه إلى مواضيع مختلفة، وإضافة حقول بيانات وصفية. والمنطق المعقد ذو الحالة (الربط، والتجميع) مكانه Kafka Streams، لا SMT."
    },
    {
      "text": "كيف تتعامل Kafka Connect مع حالة الإزاحات لموصّلات المصدر عبر إعادات تشغيل العمال؟",
      "options": [
        "تُخزن الإزاحات في نظام الملفات المحلي للموصّل",
        "تُخزن الإزاحات في موضوع Kafka مخصص (connect-offsets) مشترك بين كل العمال",
        "تُخزن الإزاحات في نظام المصدر الخارجي",
        "تُعاد حساب الإزاحات من الصفر عند كل إعادة تشغيل"
      ],
      "correct": 1,
      "explanation": "في الوضع الموزع، تخزن Kafka Connect إزاحات قراءة موصّلات المصدر في موضوع Kafka الداخلي 'connect-offsets'. وهذا يتيح لأي عامل في العنقود استئناف موصّل من الموضع الصحيح بعد إعادة تشغيل أو إعادة توازن."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء خط بيانات للمدفوعات باستخدام Kafka Connect",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "انشر عنقود Kafka Connect في الوضع الموزع واضبط مواضيع التنسيق الداخلية الثلاثة (connect-configs، وconnect-offsets، وconnect-status) بعامل نسخ 3. ونفّذ فحص صحة KafkaConnectHealthIndicator في Spring Boot يتحقق من أن كل الموصّلات المراقبة في حالة RUNNING دون مهام فاشلة."},
    {"id": "2", "description": "أنشئ إعداد موصّل مصب S3 يؤرشف 'payments.events' في دلو S3 بصيغة Parquet (مع محوّل يعرف المخطط مثل Avro)، مقسّمًا حسب السنة/الشهر/اليوم/الساعة باستخدام حقل createdAt في الحدث، مع تشفير KMS على جانب الخادم وحجم تفريغ 50,000 رسالة."},
    {"id": "3", "description": "نفّذ SMT مخصصًا (PaymentClassificationSMT) يقرأ حقل amount من كل حدث دفع ويضيف حقل 'data_classification' ‏('HIGH_VALUE' للمبالغ >= 100,000 وحدة صغرى، و'STANDARD' خلاف ذلك)، إضافة إلى علم منطقي 'enhanced_monitoring'."},
    {"id": "4", "description": "اضبط الموصّل بـ errors.tolerance=all وموضوع رسائل ميتة 'payments.connect.dlq' مع تفعيل ترويسات السياق. ونفّذ منطق إعادة تشغيل آلي للمهام يكشف المهام FAILED كل 5 دقائق ويطلق إعادة التشغيل عبر واجهة REST في Connect."}
  ]
}
-->
