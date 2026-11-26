---
id: track-09-lesson-07
title: "سجل المخططات — Avro وProtobuf وتطور المخطط"
slug: schema-registry
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 7
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [schema-registry, Avro, Protobuf, schema-evolution, compatibility]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
---

# ‏Schema Registry — ‏Avro وProtobuf وتطور المخططات

> [!NOTE]
> المخططات عقود. ففي الأنظمة المالية حيث تنتج فرق متعددة أحداث الدفع وتستهلكها، قد يوقف تغيير مخطط يكسر مستهلكًا لاحقًا بصمت التسوية، أو يطلق مطابقة مزدوجة، أو يفسد سجلات الامتثال. وSchema Registry هو طبقة الإنفاذ التي تجعل تطور المخططات آمنًا، ومرقّمًا بإصدارات، وقابلًا للتدقيق.

## لماذا يوجد Schema Registry

دون Schema Registry، تكون رسائل Kafka بايتات معتمة. فتستخدم الفرق تسلسلًا ارتجاليًا (سلاسل JSON، وصيغ ثنائية مخصصة) وتعتمد على التنسيق والتوثيق لإدارة التغييرات. وهذا يفشل عمليًا:

- يضيف مطوّر حقلًا إلزاميًا إلى حدث دفع
- يتوقع المستهلكون القائمون المخطط القديم — فيفشلون في فك التسلسل
- تتعطل خدمة التسوية بصمت، فلا تعالج أي مدفوعات
- وحين تنبّه المراقبة، تكون تسويات بالملايين قد تأخرت

يحل Schema Registry ذلك عبر:
1. **تسجيل** المخططات بأرقام إصدارات
2. **فرض قواعد التوافق** قبل قبول تغييرات المخطط
3. **تضمين** معرّف المخطط في كل رسالة — فيعرف المستهلكون دائمًا أي مخطط يستخدمون
4. **توفير عقد مركزي** يرجع إليه كل المنتجين والمستهلكين

## بنية Confluent Schema Registry

```
Producer                    Schema Registry           Consumer
   │                               │                     │
   │── register schema ──────────►│                     │
   │◄── schema_id=42 ─────────────│                     │
   │                               │                     │
   │── produce(msg with id=42) ──────────────────────►  │
   │                               │                     │
   │                               │◄── fetch schema 42 ─│
   │                               │── return schema ──► │
   │                               │                     │── deserialise ──►
```

صيغة الرسالة على السلك:

```
Byte 0:   Magic byte (0x00) — indicates Confluent format
Bytes 1-4: Schema ID (int32) — 4-byte big-endian integer
Bytes 5+:  Serialised payload (Avro/Protobuf/JSON Schema)
```

هذه البادئة المكونة من البايت السحري + معرّف المخطط هي الفكرة الأساسية: كل رسالة تحمل مؤشرًا إلى مخططها. فيفك المستهلكون التسلسل بشكل صحيح دائمًا حتى مع تطور المخططات.

## تعريف مخطط Avro

‏Apache Avro أشيع صيغة لـ Kafka في الخدمات المالية. فهو يوفر تسلسلًا ثنائيًا مضغوطًا، ودعمًا غنيًا لتطور المخططات، وصيغة مخطط JSON مقروءة للبشر.

### تعريف مخطط حدث دفع

```json
{
    "namespace": "com.fintech.payments.avro",
    "type": "record",
    "name": "PaymentCreated",
    "doc": "Event published when a new payment is created",
    "fields": [
        {
            "name": "paymentId",
            "type": "string",
            "doc": "Unique identifier for the payment (UUID format)"
        },
        {
            "name": "accountId",
            "type": "string",
            "doc": "Source account identifier"
        },
        {
            "name": "destinationAccountId",
            "type": "string",
            "doc": "Destination account identifier"
        },
        {
            "name": "amount",
            "type": {
                "type": "bytes",
                "logicalType": "decimal",
                "precision": 18,
                "scale": 2
            },
            "doc": "Payment amount with 2 decimal places (exact decimal -- never float/double for money; currencies with 0 or 3 minor digits need their own scale, or use integer minor units)"
        },
        {
            "name": "currency",
            "type": {
                "type": "enum",
                "name": "Currency",
                "symbols": ["GBP", "USD", "EUR", "JPY"]
            },
            "doc": "ISO 4217 currency code. Careful: adding a symbol later breaks old readers unless the enum declares a default symbol (Avro 1.9+) -- a plain string is often the safer choice for currencies"
        },
        {
            "name": "status",
            "type": {
                "type": "enum",
                "name": "PaymentStatus",
                "symbols": ["PENDING", "APPROVED", "REJECTED", "SETTLED"]
            }
        },
        {
            "name": "createdAt",
            "type": {
                "type": "long",
                "logicalType": "timestamp-millis"
            },
            "doc": "Event creation time in milliseconds since epoch"
        },
        {
            "name": "metadata",
            "type": {
                "type": "map",
                "values": "string"
            },
            "default": {},
            "doc": "Optional key-value metadata (e.g., channel, region)"
        }
    ]
}
```

### توليد شيفرة Java من Avro

استخدام إضافة Avro في Maven لتوليد أصناف Java من ملفات `.avsc`:

```xml
<!-- pom.xml -->
<plugin>
    <groupId>org.apache.avro</groupId>
    <artifactId>avro-maven-plugin</artifactId>
    <version>1.11.3</version>
    <executions>
        <execution>
            <phase>generate-sources</phase>
            <goals><goal>schema</goal></goals>
            <configuration>
                <sourceDirectory>${project.basedir}/src/main/avro</sourceDirectory>
                <outputDirectory>${project.build.directory}/generated-sources/avro</outputDirectory>
                <!-- generate BigDecimal (not ByteBuffer) for decimal logical types -->
                <enableDecimalLogicalType>true</enableDecimalLogicalType>
            </configuration>
        </execution>
    </executions>
</plugin>
```

## أوضاع توافق المخططات

يُضبط وضع التوافق لكل **موضوع تسجيل (subject)** (هوية مخطط في السجل). فاختر بعناية — فهو يحدد تغييرات المخطط المسموح بها.

### توافق BACKWARD (الافتراضي — موصى به)

يمكن استخدام المخطط الجديد لقراءة البيانات المكتوبة بالمخطط السابق.

```
Old producers write:                   New consumer reads:
  { paymentId, accountId, amountMinor }  { paymentId, accountId, amountMinor, [referenceId=null] }
```

**القاعدة:** يمكنك إضافة حقول **ذات** قيم افتراضية وحذف حقول (يتجاهلها القارئ الجديد ببساطة). ورقِّ **المستهلكين أولًا**، ثم المنتجين.

```json
// V1 — Original schema
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amountMinor", "type": "long"}
    ]
}

// V2 — BACKWARD compatible: added optional field with default
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amountMinor", "type": "long"},
        {
            "name": "referenceId",
            "type": ["null", "string"],
            "default": null,
            "doc": "Optional payment reference (e.g., bank reference)"
        }
    ]
}
```

### توافق FORWARD

يستطيع المستهلكون القدامى قراءة البيانات المكتوبة بالمخطط الجديد.

**القاعدة:** يمكنك إضافة حقول (يتخطى القراء القدامى الحقول المجهولة، فلا تلزم قيمة افتراضية) وحذف الحقول التي **لها** قيمة افتراضية في المخطط القديم فقط (يملؤها القراء القدامى). ورقِّ **المنتجين أولًا**، ثم المستهلكين.

```json
// V2 — FORWARD compatible: old consumer reads V2 data, ignores new field
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amountMinor", "type": "long"},
        {"name": "region", "type": "string"}  // No default — old consumers skip it
    ]
}
```

### توافق FULL

‏BACKWARD وFORWARD معًا. الخيار الأكثر أمانًا للأنظمة المالية: يمكنك فقط إضافة أو حذف الحقول ذات القيم الافتراضية، ويمكن ترقية المنتجين والمستهلكين بأي ترتيب.

### ‏NONE

لا فحوص توافق. استخدمه فقط أثناء التطوير الأولي أو حين تتحكم في كل المنتجين والمستهلكين وتنشرهم في آن واحد. ولا تستخدمه أبدًا في الأنظمة المالية الإنتاجية.

**الاستراتيجية الموصى بها للخدمات المالية:**

```
Default: FULL_TRANSITIVE
  - All versions must be compatible with ALL previous versions
  - Not just the last version
  - Use BACKWARD if FULL is too restrictive for your use case
```

## أمثلة تطور المخطط

### آمن: إضافة حقل اختياري

```json
// V1
{"name": "paymentId", "type": "string"},
{"name": "amountMinor", "type": "long"}

// V2 — BACKWARD and FORWARD compatible
{"name": "paymentId", "type": "string"},
{"name": "amountMinor", "type": "long"},
{"name": "merchantId", "type": ["null", "string"], "default": null}
```

المستهلكون القدامى الذين يقرؤون بيانات V2: يعرفون أن `merchantId` اختياري، فيتخطونه.
المستهلكون الجدد الذين يقرؤون بيانات V1: ‏`merchantId` قيمته null (تُطبق القيمة الافتراضية).

### آمن: توسيع نوع الاتحاد

```json
// V1
{"name": "region", "type": "string"}

// V2 — BACKWARD compatible
{"name": "region", "type": ["string", "null"], "default": "UNKNOWN"}
```

### كاسر للمستهلكين القدامى: حذف حقل بلا قيمة افتراضية

```json
// V1
{"name": "paymentId", "type": "string"},
{"name": "accountId", "type": "string"},
{"name": "amountMinor", "type": "long"}

// V2 — BREAKING: removed "accountId"
{"name": "paymentId", "type": "string"},
{"name": "amountMinor", "type": "long"}
// Old consumers (still on V1) need accountId and have no default for it
// -> they fail. FORWARD/FULL reject this change; BACKWARD accepts it, which
// is only safe if ALL consumers were upgraded before the producers
```

### كاسر: إعادة تسمية حقل

```json
// V1
{"name": "accountId", "type": "string"}

// V2 — BREAKING: renamed to "sourceAccountId"
// Old consumers look for "accountId" — it's gone, they get null/error
{"name": "sourceAccountId", "type": "string"}
```

يستطيع قراء Avro إعلان `"aliases": ["accountId"]` على الحقل الجديد، فيستطيع قارئ جديد قراءة البيانات القديمة — لكن القارئ القديم لا يجد الاسم الجديد في البيانات الجديدة.

**استراتيجية إعادة التسمية:** أضف الحقل الجديد (بقيمة افتراضية)، وأهمل الحقل القديم، وانقل المستهلكين، ثم احذف الحقل القديم عبر إصدارين منفصلين للمخطط.

## مزايا Protobuf في تطور المخططات

تقدم Protocol Buffers دلالات تطور أفضل من Avro لأنها تستخدم **أرقام الحقول** بدل أسمائها. فإعادة تسمية حقل آمنة ما دام الرقم ثابتًا.

```protobuf
// payment_created.proto  (V1 and V2 shown together for comparison --
// they are two versions of the same file, not one file)
syntax = "proto3";

package com.fintech.payments.proto;

message PaymentCreated {
    string payment_id = 1;        // Field number 1 — never change this
    string account_id = 2;         // Field number 2
    int64 amount_minor = 3;        // Field number 3 (minor units, never double)
    string currency = 4;
    int64 created_at_millis = 5;

    // Safe to rename account_id to source_account_id as long as field number 2 is preserved
    // Old consumers: wire format unchanged (still field 2), just the name changed
}

// V2 — added field — backward and forward safe
message PaymentCreated {
    string payment_id = 1;
    string account_id = 2;
    int64 amount_minor = 3;
    string currency = 4;
    int64 created_at_millis = 5;
    string merchant_id = 6;         // New field — old consumers ignore field 6
    string reference_id = 7;        // Another new field
}
```

**قواعد تطور Protobuf:**
- لا تعِد استخدام رقم حقل أبدًا (حتى للحقول المحذوفة — استخدم `reserved`)
- لا تغيّر نوع الحقل أبدًا
- إعادة التسمية آمنة لصيغة السلك الثنائية — فأرقام الحقول هي المهمة هناك (لكن ليس لتمثيل JSON في Protobuf، الذي يستخدم الأسماء)

```protobuf
message PaymentCreated {
    reserved 8, 9;                  // Reserved for deleted fields
    reserved "old_field_name";      // Reserved field names (optional)
    string payment_id = 1;
    // ...
}
```

## استراتيجيات تسمية مواضيع التسجيل

**موضوع التسجيل (subject)** هو الاسم الذي يُسجّل تحته المخطط في Schema Registry. وتحدد الاستراتيجية كيف تُسمى مواضيع التسجيل.

### ‏TopicNameStrategy (الافتراضية)

```
Topic: payments.events
Subject for key schema:   payments.events-key
Subject for value schema: payments.events-value
```

يجب أن يستخدم كل المنتجين إلى `payments.events` إصدار المخطط نفسه. وهي جيدة للمواضيع المتجانسة (نوع حدث واحد لكل موضوع).

### ‏RecordNameStrategy

```
Schema class: com.fintech.payments.avro.PaymentCreated
Subject: com.fintech.payments.avro.PaymentCreated
```

يُسجّل المخطط تحت الاسم الكامل المؤهل للصنف. فيمكن نشر أنواع أحداث متعددة إلى الموضوع نفسه دون تعارض — وهو مفيد لمواضيع event sourcing التي تحمل عدة أنواع أحداث لتجمّع واحد (تعمل `TopicRecordNameStrategy` أدناه أيضًا؛ وخيار آخر مخطط اتحاد مع مراجع مخططات تحت الاستراتيجية الافتراضية).

```java
// Producer configuration for RecordNameStrategy
props.put("value.subject.name.strategy",
        "io.confluent.kafka.serializers.subject.RecordNameStrategy");
```

### ‏TopicRecordNameStrategy

تجمع اسم الموضوع واسم السجل:

```
Subject: payments.events-com.fintech.payments.avro.PaymentCreated
```

تتيح تطورًا مختلفًا للمخطط لكل موضوع لكل نوع سجل.

## مسلسل/مفكك Avro في Spring Kafka

```xml
<!-- pom.xml -->
<dependency>
    <groupId>io.confluent</groupId>
    <artifactId>kafka-avro-serializer</artifactId>
    <version>7.6.0</version>
</dependency>
```

### إعداد المنتج

```java
import io.confluent.kafka.serializers.KafkaAvroSerializer;
import io.confluent.kafka.serializers.AbstractKafkaSchemaSerDeConfig;
import com.fintech.payments.avro.PaymentCreated;

@Configuration
public class AvroProducerConfig {

    @Bean
    public ProducerFactory<String, PaymentCreated> paymentProducerFactory() {
        Map<String, Object> config = new HashMap<>();
        config.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        config.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        config.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, KafkaAvroSerializer.class);
        config.put(AbstractKafkaSchemaSerDeConfig.SCHEMA_REGISTRY_URL_CONFIG,
                "http://schema-registry:8081");
        // Auto-register schemas in dev, disable in production
        config.put(AbstractKafkaSchemaSerDeConfig.AUTO_REGISTER_SCHEMAS, false);
        return new DefaultKafkaProducerFactory<>(config);
    }

    @Bean
    public KafkaTemplate<String, PaymentCreated> paymentKafkaTemplate() {
        return new KafkaTemplate<>(paymentProducerFactory());
    }
}

@Service
public class PaymentEventPublisher {

    @Autowired
    private KafkaTemplate<String, PaymentCreated> kafkaTemplate;

    public void publishPaymentCreated(Payment payment) {
        PaymentCreated event = PaymentCreated.newBuilder()
                .setPaymentId(payment.getId())
                .setAccountId(payment.getAccountId())
                .setDestinationAccountId(payment.getDestinationAccountId())
                .setAmount(payment.getAmount())
                .setCurrency(Currency.valueOf(payment.getCurrency()))
                .setStatus(PaymentStatus.PENDING)
                .setCreatedAt(System.currentTimeMillis())
                .build();

        kafkaTemplate.send("payments.events", payment.getId(), event);
        log.info("Published PaymentCreated event for payment {}", payment.getId());
    }
}
```

### إعداد المستهلك

```java
import io.confluent.kafka.serializers.KafkaAvroDeserializer;
import io.confluent.kafka.serializers.KafkaAvroDeserializerConfig;

@Configuration
public class AvroConsumerConfig {

    @Bean
    public ConsumerFactory<String, PaymentCreated> paymentConsumerFactory() {
        Map<String, Object> config = new HashMap<>();
        config.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        config.put(ConsumerConfig.GROUP_ID_CONFIG, "settlement-service");
        config.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        config.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, KafkaAvroDeserializer.class);
        config.put(AbstractKafkaSchemaSerDeConfig.SCHEMA_REGISTRY_URL_CONFIG,
                "http://schema-registry:8081");
        // Use specific Avro type (generated class) rather than GenericRecord
        config.put(KafkaAvroDeserializerConfig.SPECIFIC_AVRO_READER_CONFIG, true);
        return new DefaultKafkaConsumerFactory<>(config);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, PaymentCreated>
            paymentListenerFactory() {
        ConcurrentKafkaListenerContainerFactory<String, PaymentCreated> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(paymentConsumerFactory());
        return factory;
    }
}

@Service
public class PaymentSettlementConsumer {

    @KafkaListener(
        topics = "payments.events",
        groupId = "settlement-service",
        containerFactory = "paymentListenerFactory"
    )
    public void handlePaymentCreated(PaymentCreated event) {
        log.info("Received PaymentCreated: paymentId={}, amount={}, currency={}",
                event.getPaymentId(), event.getAmount(), event.getCurrency());

        settlementService.processSettlement(
                event.getPaymentId(),
                event.getAmount(),
                event.getCurrency().toString()
        );
    }
}
```

## واجهة REST في Schema Registry

يكشف Schema Registry واجهة REST لإدارة المخططات. وهي مفيدة للتحقق من المخططات في CI/CD:

```bash
# Register a schema
curl -X POST http://schema-registry:8081/subjects/payments.events-value/versions \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "{\"type\":\"record\",\"name\":\"PaymentCreated\",...}"}'

# Check compatibility before registering
curl -X POST http://schema-registry:8081/compatibility/subjects/payments.events-value/versions/latest \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "..."}'

# List all versions
curl http://schema-registry:8081/subjects/payments.events-value/versions

# Get schema by version
curl http://schema-registry:8081/subjects/payments.events-value/versions/2

# Set compatibility mode per subject
curl -X PUT http://schema-registry:8081/config/payments.events-value \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"compatibility": "FULL"}'
```

### فحص توافق المخططات في CI/CD

```yaml
# .github/workflows/schema-check.yml
- name: Check schema compatibility
  run: |
    mvn schema-registry:test-compatibility \
      -Dschema.registry.url=http://schema-registry:8081

# Maven plugin configuration (pom.xml)
<plugin>
    <groupId>io.confluent</groupId>
    <artifactId>kafka-schema-registry-maven-plugin</artifactId>
    <version>7.6.0</version>
    <configuration>
        <schemaRegistryUrls>
            <param>http://schema-registry:8081</param>
        </schemaRegistryUrls>
        <subjects>
            <payments.events-value>
                src/main/avro/payment_created.avsc
            </payments.events-value>
        </subjects>
    </configuration>
</plugin>
```

## الخلاصات الأساسية

- يخزن Schema Registry المخططات بإصدارات ويفرض قواعد التوافق قبل نشر إصدارات جديدة.
- تحتوي كل رسالة Kafka على معرّف مخطط من 4 بايتات، فيستطيع المستهلكون دائمًا فك التسلسل بشكل صحيح.
- توافق **BACKWARD** (الافتراضي): يستطيع المستهلكون الجدد قراءة البيانات المكتوبة بالمخطط القديم — أضف الحقول بقيم افتراضية فقط؛ ورقِّ المستهلكين أولًا.
- توافق **FORWARD**: يستطيع المستهلكون القدامى قراءة البيانات المكتوبة بالمخطط الجديد — فهم يتخطون الحقول المجهولة؛ ورقِّ المنتجين أولًا.
- توافق **FULL** يتطلب الاثنين — الخيار الأكثر أمانًا للأنظمة المالية الإنتاجية.
- **إعادة تسمية حقل تكسر مستهلكي Avro القدامى** (الأسماء البديلة aliases تساعد القراء الجدد فقط) — استخدم نمط الترحيل بالإضافة ثم الحذف.
- يتعامل Protobuf مع إعادة تسمية الحقول بأمان لأن صيغة السلك تستخدم أرقام الحقول، لا الأسماء.
- ‏`RecordNameStrategy` تتيح المواضيع غير المتجانسة (أنواع أحداث متعددة على موضوع واحد).
- عطّل `AUTO_REGISTER_SCHEMAS` في الإنتاج — يجب مراجعة المخططات وتسجيلها عبر CI/CD.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ماذا يتطلب وضع توافق BACKWARD لتطور مخططات Avro؟",
      "options": [
        "يمكن إضافة حقول جديدة دون قيم افتراضية؛ ويمكن حذف الحقول القديمة بحرية",
        "يجب أن تكون للحقول الجديدة قيم افتراضية؛ ويمكن حذف الحقول (يتجاهلها القارئ الجديد ببساطة) — لذا يُرقّى المستهلكون أولًا",
        "يجب أن يكون المخطط مطابقًا للإصدار السابق",
        "يمكن تغيير أنواع الحقول فقط؛ ويجب أن تبقى أسماء الحقول وأعدادها كما هي"
      ],
      "correct": 1,
      "explanation": "يعني توافق BACKWARD أن المستهلكين الجدد يستطيعون قراءة البيانات المكتوبة بالمخطط القديم. فأي حقل جديد يحتاج قيمة افتراضية (البيانات القديمة لا تحتويه)، بينما حذف حقل مسموح لأن القارئ الجديد يتجاهله فقط. ولأن المستهلكين القدامى غير محميين، يُرقّى المستهلكون قبل المنتجين."
    },
    {
      "text": "لماذا تكسر إعادة تسمية حقل مستهلكي Avro القدامى لكن لا تكسر مستهلكي Protobuf القدامى؟",
      "options": [
        "يستخدم Avro فهارس الحقول بينما يستخدم Protobuf أسماء الحقول على السلك",
        "يستخدم Avro أسماء الحقول للمطابقة؛ ويستخدم Protobuf أرقام الحقول",
        "ينشئ Protobuf أسماء بديلة تلقائيًا للحقول المعاد تسميتها",
        "لا يدعم Avro الحقول الاختيارية بينما يدعمها Protobuf"
      ],
      "correct": 1,
      "explanation": "يحل Avro الحقول بالاسم عند القراءة. فبعد إعادة التسمية، يبحث القارئ القديم عن الاسم القديم ولا يجده (يستطيع القارئ الجديد إعلان اسم بديل للاسم القديم، لكن القراء القدامى لا يملكون مثله). أما Protobuf فيحدد الحقول بالرقم على السلك — ويظهر الاسم في الشيفرة المولّدة فقط — فإعادة التسمية آمنة للصيغة الثنائية ما دام الرقم ثابتًا."
    },
    {
      "text": "أي استراتيجية لتسمية مواضيع التسجيل تتيح لأنواع أحداث متعددة مشاركة موضوع Kafka واحد بتسجيل كل مخطط تحت الاسم الكامل المؤهل لسجله؟",
      "options": [
        "‏TopicNameStrategy — تتعامل مع أنواع متعددة افتراضيًا",
        "‏TopicRecordNameStrategy فقط",
        "‏RecordNameStrategy — تسجل المخططات تحت الاسم الكامل المؤهل للصنف",
        "‏DefaultNamingStrategy — لا يلزم إعداد"
      ],
      "correct": 2,
      "explanation": "تسجّل TopicNameStrategy موضوع تسجيل واحدًا لكل موضوع (topic-value)، فيجب أن تكون كل الرسائل على الموضوع إصدارات متوافقة من مخطط واحد. وتسجّل RecordNameStrategy المخططات تحت الاسم الكامل المؤهل للسجل، فتتيح أنواع أحداث عدة على موضوع واحد. (تتيحه أيضًا TopicRecordNameStrategy، بحصر موضوع التسجيل لكل موضوع؛ ومخططات الاتحاد مع مراجع المخططات خيار آخر.)"
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ أحداث دفع تحكمها المخططات باستخدام Avro",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "عرّف مخطط Avro ‏(payment_created.avsc) لحدث PaymentCreated بحقول paymentId، وaccountId، وamount (نوع منطقي decimal)، وcurrency (enum)، وstatus (enum)، وcreatedAt (timestamp-millis). وسجّل المخطط تحت موضوع التسجيل 'payments.events-value' بوضع توافق FULL."},
    {"id": "2", "description": "اضبط منتج Kafka في Spring Boot باستخدام KafkaAvroSerializer مع AUTO_REGISTER_SCHEMAS=false وRecordNameStrategy. ونفّذ PaymentEventPublisher يولّد سجلات Avro من نوع PaymentCreated باستخدام صنف Java المولّد وينشرها إلى 'payments.events'."},
    {"id": "3", "description": "طوّر المخطط بإضافة حقل اختياري 'merchantId' (اتحاد null وstring بقيمة افتراضية null) وتحقق من توافق FULL عبر واجهة REST في Schema Registry قبل التسجيل. وحدّث المنتج لملء الحقل الجديد."},
    {"id": "4", "description": "أضف فحص توافق للمخطط في CI/CD باستخدام kafka-schema-registry-maven-plugin يمنع الدمج إلى main إذا لم يكن تغيير المخطط المقترح متوافقًا FULL مع الإصدار المسجل."}
  ]
}
-->
