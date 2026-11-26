---
id: track-09-lesson-02
title: "منتِج Kafka — الإقرار والتجميع والترتيب"
slug: kafka-producer
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 2
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Kafka, producer, acks, idempotent, ordering]
prerequisites: [track-09-lesson-01]
---

# منتج Kafka — التأكيد والتجميع والترتيب

> [!NOTE]
> منتج Kafka ليس عميلًا بسيطًا "أرسل وانسَ". ففي الأنظمة المالية، كل مقبض إعداد — acks، وretries، وlinger.ms، وidempotence — يقابل مباشرة ضمانًا للديمومة والترتيب. والخطأ فيها يعني مدفوعات مكررة، أو معاملات مفقودة، أو تلفًا صامتًا للبيانات على نطاق واسع.

## نظرة عامة

المنتج (producer) في Kafka مسؤول عن تسلسل السجلات، واختيار القسم، وتجميع الرسائل للكفاءة، وتسليمها إلى الوسطاء (brokers) بضمانات الديمومة التي تحددها. وفي أنظمة الدفع الرهانات عالية: فالمنتج سيئ الإعداد قد يُسقط المعاملات بصمت أو ينتج تكرارات تتطلب مطابقة مكلفة.

يمر هذا الدرس على كل إعداد حرج للمنتج من المبادئ الأولى، مع أمثلة Java بمستوى إنتاجي باستخدام Spring Kafka. وبنهايته ستفهم بالضبط ما يحدث داخل عميل المنتج من لحظة استدعاء `send()` حتى يؤكد الوسيط الكتابة.

## 1. داخلية المنتج: ماذا يحدث حين تستدعي send()

قبل ضبط الإعدادات، افهم دورة حياة `ProducerRecord` واحد:

1. **التسلسل** — يُسلسل المفتاح والقيمة باستخدام المسلسلات المُعدّة.
2. **التقسيم** — يعيّن المقسّم السجل لقسم (الافتراضي: تجزئة murmur2 للمفتاح؛ ودون مفتاح، يملأ السلوك "اللاصق" دفعة لقسم واحد قبل الانتقال).
3. **مُجمّع السجلات** — تُخزن السجلات مؤقتًا في `Deque<ProducerBatch>` لكل قسم. وتتراكم الدفعات حتى يُبلغ `batch.size` أو تنتهي `linger.ms`.
4. **خيط الإرسال** — يفرّغ خيط `Sender` خلفي المُجمّع ويجمّع الدفعات حسب الوسيط (قائد كل قسم).
5. **الطلبات قيد الإرسال** — تُرسل الدفعات كرسائل `ProduceRequest`. ويمكن أن يبقى حتى `max.in.flight.requests.per.connection` طلبًا معلقًا لكل اتصال بوسيط.
6. **التأكيد** — يرد الوسيط بنجاح أو خطأ، ويُكمل المنتج الـ future الخاص بالاستدعاء الراجع.

لهذا الخط آثار عميقة على الإنتاجية، والزمن، والترتيب، والديمومة.

## 2. أوضاع التأكيد (acks)

يتحكم إعداد `acks` في عدد نسخ الوسطاء التي يجب أن تؤكد الكتابة قبل أن يعتبرها المنتج ناجحة.

### ‏acks=0 — أرسل وانسَ

```java
props.put(ProducerConfig.ACKS_CONFIG, "0");
```

لا ينتظر المنتج أي تأكيد. أقصى إنتاجية، وصفر ديمومة. **لا تستخدمه أبدًا في الأنظمة المالية.** فإذا تعطل الوسيط بعد استلام السجل وقبل كتابته، تضيع البيانات بصمت.

### ‏acks=1 — تأكيد القائد

```java
props.put(ProducerConfig.ACKS_CONFIG, "1");
```

يكتب قائد القسم السجل في سجله المحلي ويؤكد. سريع، لكن إذا تعطل القائد قبل أن ينسخ التابعون، يضيع السجل. مقبول للمقاييس غير الحرجة؛ لا لأحداث الدفع.

### ‏acks=all ‏(أو acks=-1) — تأكيد كل النسخ المتزامنة

```java
props.put(ProducerConfig.ACKS_CONFIG, "all");
```

ينتظر القائد تأكيد كل النسخ المتزامنة (ISR) قبل الرد. ومع `min.insync.replicas=2` على الوسيط/الموضوع، يضمن هذا نجاة السجل من فشل أي وسيط واحد.

```java
// Broker/topic configuration (not producer-side):
// min.insync.replicas=2
// replication.factor=3
```

**قاعدة الإنتاج**: يجب أن تستخدم المواضيع المالية `acks=all` مع `min.insync.replicas >= 2`. وهذا غير قابل للتفاوض.

## 3. إعادة المحاولة وidempotence

### مشكلة إعادة المحاولة

مع `acks=all`، قد تجعل مهلات الشبكة المنتج يعيد إرسال طلب التزم به الوسيط أصلًا. ودون idempotence، ينتج هذا تكرارات:

```
Producer sends batch → Network timeout → Producer retries → Broker committed BOTH
Result: duplicate payment event
```

### تفعيل المنتج idempotent

```java
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
```

حين تُفعّل idempotence:
- يُعطى كل مثيل منتج **معرّف منتج (PID)** من الوسيط.
- تحمل كل دفعة سجلات **رقمًا تسلسليًا** لكل قسم.
- يزيل الوسيط تكرارات إعادة المحاولة باستخدام `(PID, partition, sequence_number)`.

تتطلب idempotence ‏`acks=all`، و`retries > 0`، و`max.in.flight.requests.per.connection <= 5` — وهي القيم الافتراضية (`acks=all`، و`retries=Integer.MAX_VALUE`، و5 طلبات قيد الإرسال). ومنذ Kafka 3.0 تكون idempotence **مفعّلة افتراضيًا** حين لا يتعارض معها شيء.

القيد: إزالة التكرار تعمل لكل جلسة منتج. فإذا أُعيد تشغيل *تطبيق* المنتج وأعاد إرسال سجل، يحصل على PID جديد ولا يستطيع الوسيط التعرف على التكرار — وهذا يحتاج المعاملات (`transactional.id`) أو مستهلكين idempotent.

```java
// Idempotent producer configuration
Map<String, Object> producerProps = new HashMap<>();
producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG,
    "kafka-broker-1:9092,kafka-broker-2:9092");
producerProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
producerProps.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
producerProps.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
producerProps.put(ProducerConfig.ACKS_CONFIG, "all");
producerProps.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
producerProps.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
producerProps.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000); // 2 minutes total
```

> [!WARNING]
> يجب أن تكون `max.in.flight.requests.per.connection` ‏<= 5 من أجل idempotence. فإذا ضبطت `enable.idempotence=true` صراحة مع قيمة أعلى (أو `acks` غير `all`)، يفشل المنتج عند البدء بـ `ConfigException`. وإذا لم تضبط idempotence صراحة، فإن الإعداد المتعارض يطفئ idempotence الافتراضية بصمت — لذا اضبط دائمًا `enable.idempotence=true` صراحة في المنتجين الماليين.

## 4. إعداد التجميع

التجميع (batching) الآلية الأساسية للإنتاجية. فيُجمّع المنتج السجلات في دفعات قبل الإرسال.

### ‏batch.size

أقصى عدد من **البايتات** (لا السجلات) في دفعة واحدة لكل قسم. وحين تبلغ الدفعة هذا الحجم، تُرسل فورًا بغض النظر عن `linger.ms`.

```java
props.put(ProducerConfig.BATCH_SIZE_CONFIG, 65536); // 64 KB
```

الافتراضي 16 KB. ولتدفقات أحداث الدفع عالية الإنتاجية، يشيع 64 KB إلى 1 MB. والدفعات الأكبر تعني نسب ضغط أفضل لكن زمنًا أعلى للسجلات الفردية.

### ‏linger.ms

أقصى وقت ينتظره المنتج قبل إرسال دفعة غير مكتملة. وهو مفاضلة متعمدة بين الزمن والإنتاجية.

```java
props.put(ProducerConfig.LINGER_MS_CONFIG, 5); // Wait up to 5ms to fill a batch
```

الافتراضي 0 (إرسال فوري) — وغيّرت Kafka 4.0 الافتراضي إلى 5 ms. ولمعالجة المدفوعات حيث لديك معدلات رسائل عالية لكن تحتمل 5–20ms من الزمن الإضافي، يمكن أن تضاعف `linger.ms=5` الإنتاجية بتحسين امتلاء الدفعات كثيرًا.

### ‏buffer.memory

إجمالي الذاكرة المتاحة للمنتج لتخزين السجلات مؤقتًا. فإذا كان المنتج ينتج أسرع مما يستطيع الإرسال، تُحجب استدعاءات `send()` حتى تتوفر مساحة أو تنتهي `max.block.ms`.

```java
props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67108864L); // 64 MB
props.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 60_000L);    // Block up to 60 seconds
```

## 5. الضغط

يقلل الضغط عرض النطاق الشبكي وتخزين الوسيط مقابل المعالج. ولأحداث مالية مسلسلة بـ JSON، تشيع نسب ضغط من 5:1 إلى 10:1.

```java
props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "snappy");
// Options: none, gzip, snappy, lz4, zstd
```

| الخوارزمية | كلفة المعالج | نسبة الضغط | الإنتاجية |
|-----------|-----------|-------------------|------------|
| none      | صفر      | 1:1               | خط الأساس   |
| gzip      | عالية      | عالية              | الأدنى     |
| snappy    | منخفضة       | متوسطة            | عالية       |
| lz4       | منخفضة جدًا  | متوسطة            | الأعلى    |
| zstd      | متوسطة    | الأعلى           | جيدة       |

**التوصية لأنظمة الدفع**: ‏`lz4` للمسارات الحساسة للزمن، و`zstd` لمواضيع الأرشفة حيث يهم التخزين أكثر من المعالج.

```java
// High-throughput payment event producer configuration
@Bean
public ProducerFactory<String, PaymentEvent> paymentProducerFactory() {
    Map<String, Object> props = new HashMap<>();
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaBootstrapServers);
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
    props.put(ProducerConfig.ACKS_CONFIG, "all");
    props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");
    props.put(ProducerConfig.BATCH_SIZE_CONFIG, 65536);
    props.put(ProducerConfig.LINGER_MS_CONFIG, 5);
    props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67108864L);
    props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000);
    props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 30_000);
    return new DefaultKafkaProducerFactory<>(props);
}
```

## 6. مفاتيح الرسائل وضمانات الترتيب

تضمن Kafka الترتيب **داخل القسم، لا عبر الأقسام**. ويتحدد قسم السجل بمفتاحه.

### لماذا تهم المفاتيح في الأنظمة المالية

الترتيب موجود فقط لكل مفتاح، فاختر المفتاح بسؤال *أي الأحداث يجب أن تبقى مرتبة بالنسبة لبعضها*:

- كل أحداث **حساب** واحد (تغييرات الرصيد) يجب أن تكون مرتبة ← المفتاح = معرّف الحساب.
- كل أحداث **دفعة** واحدة (`INITIATED → AUTHORISED → SETTLED`) يجب أن تكون مرتبة ← المفتاح = معرّف الدفعة.

التحويل يلمس حسابين. فمع المفتاح بالحساب، يقع حدث الخصم من A وحدث الإضافة إلى B في قسمين مختلفين ويمكن معالجتهما بأي ترتيب نسبة لبعضهما. فإذا كان ذلك مهمًا، انشر حدث `TransferCompleted` واحدًا مفتاحه معرّف التحويل ودع كل مستهلك يستنتج الطرفين، أو صمم المستهلكين بحيث لا يعتمد الطرفان على ترتيب بعضهما.

```java
// Always use account_id or payment_id as the partition key
ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
    "payment-events",
    payment.getAccountId(),   // KEY: determines partition
    paymentEvent              // VALUE
);
kafkaTemplate.send(record);
```

مع هذا الإعداد، تقع كل أحداث `account_id=ACC-001` في القسم نفسه، ويعالجها المستهلك بالترتيب.

### اعتبارات تصميم المفاتيح

**المفاتيح عالية التعدد** (معرّفات الحسابات، ومعرّفات المدفوعات) تتوزع جيدًا لكنها تجعل الترتيب الشامل مستحيلًا.

**المفاتيح منخفضة التعدد** (نوع الدفع، والمنطقة) قد تسبب بؤرًا ساخنة حيث يستقبل قسم واحد 80% من الحركة.

```java
// Anti-pattern: low-cardinality key causes hot partition
ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
    "payment-events",
    payment.getPaymentType(), // BAD: only 5 payment types → 5 hot partitions
    paymentEvent
);

// Better: key by the high-cardinality entity whose events must stay in order
ProducerRecord<String, PaymentEvent> keyed = new ProducerRecord<>(
    "payment-events",
    payment.getAccountId(),   // millions of accounts -> even spread
    paymentEvent
);
// (A few huge accounts can still create hot partitions -- watch
//  per-partition throughput)
```

## 7. استراتيجيات تعيين الأقسام

### التقسيم الافتراضي

دون ضبط `partitioner.class`، يستخدم المنتج تجزئة murmur2 لبايتات المفتاح بباقي القسمة على عدد الأقسام. وهذا يوفر توزيعًا جيدًا للمفاتيح عالية التعدد. (صنف `DefaultPartitioner` القديم مُهمل منذ Kafka 3.3 — فقط اترك `partitioner.class` دون ضبط.)

### السلوك اللاصق للسجلات بلا مفاتيح

للسجلات **بلا مفاتيح**، يملأ المنتج دفعة لقسم واحد، ثم ينتقل لآخر (التقسيم اللاصق، Kafka 2.4+؛ وحُسّن في 3.3 لتفضيل الوسطاء الأسرع). وهذا يحسن التجميع كثيرًا مقارنة بسلوك التدوير القديم. وصنف `UniformStickyPartitioner` المنفصل مُهمل؛ ولتجاهل المفاتيح كليًا، استخدم:

```java
props.put(ProducerConfig.PARTITIONER_IGNORE_KEYS_CONFIG, true);  // keys no longer pick the partition
```

### مقسّم مخصص لعزل المناطق أو المستأجرين

يستطيع مقسّم مخصص حجز نطاقات أقسام للمناطق أو المستأجرين (مثلًا لعزل مستأجر مزعج أو لجعل مجموعة مستهلكين إقليمية تقرأ نطاقها فقط). **لكنه لا يوفر إقامة البيانات:** فكل أقسام الموضوع تعيش على وسطاء العنقود نفسه، أينما كانوا. وإقامة البيانات تتطلب عناقيد منفصلة (أو مواضيع على عناقيد) لكل ولاية قضائية.

```java
public class RegionalPartitioner implements Partitioner {

    private static final Map<String, Integer> REGION_PARTITION_BASE = Map.of(
        "EU",   0,   // EU events go to partitions 0-3
        "US",   4,   // US events go to partitions 4-7
        "APAC", 8    // APAC events go to partitions 8-11
    );
    private static final int RANGE_SIZE = 4;
    private static final int REQUIRED_PARTITIONS = 12;

    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {
        int numPartitions = cluster.partitionsForTopic(topic).size();
        if (numPartitions < REQUIRED_PARTITIONS) {
            throw new IllegalStateException(topic + " needs at least "
                + REQUIRED_PARTITIONS + " partitions, has " + numPartitions);
        }
        // murmur2 like the default; toPositive avoids the
        // Math.abs(Integer.MIN_VALUE) < 0 trap
        int keyHash = keyBytes != null ? Utils.toPositive(Utils.murmur2(keyBytes)) : 0;

        if (value instanceof PaymentEvent event) {
            Integer base = REGION_PARTITION_BASE.get(event.getRegion());
            if (base == null) {
                throw new IllegalArgumentException("Unknown region: " + event.getRegion());
            }
            return base + (keyHash % RANGE_SIZE);
        }

        return keyHash % numPartitions;
    }

    @Override
    public void close() {}

    @Override
    public void configure(Map<String, ?> configs) {}
}
```

## 8. ‏KafkaTemplate في Spring Kafka

يغلّف `KafkaTemplate` في Spring Kafka المنتج الأصلي بواجهات ملائمة لـ Spring تشمل الإعداد التلقائي، ودعم المعاملات، وخطافات المراقبة.

### الإعداد الأساسي

```java
@Configuration
public class KafkaProducerConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Bean
    public ProducerFactory<String, PaymentEvent> producerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.LINGER_MS_CONFIG, 5);
        props.put(ProducerConfig.BATCH_SIZE_CONFIG, 65536);
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");
        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    public KafkaTemplate<String, PaymentEvent> kafkaTemplate() {
        return new KafkaTemplate<>(producerFactory());
    }
}
```

### الإرسال مع الاستدعاءات الراجعة والمراقبة

```java
@Service
@Slf4j
public class PaymentEventPublisher {

    private static final String PAYMENT_EVENTS_TOPIC = "payment-events";

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;
    private final MeterRegistry meterRegistry;

    public PaymentEventPublisher(KafkaTemplate<String, PaymentEvent> kafkaTemplate,
                                  MeterRegistry meterRegistry) {
        this.kafkaTemplate = kafkaTemplate;
        this.meterRegistry = meterRegistry;
    }

    public CompletableFuture<SendResult<String, PaymentEvent>> publishPaymentEvent(
            PaymentEvent event) {

        ProducerRecord<String, PaymentEvent> record = new ProducerRecord<>(
            PAYMENT_EVENTS_TOPIC,
            event.getAccountId(),  // partition key — guarantees per-account ordering
            event
        );

        // Propagate distributed tracing context via headers
        record.headers().add("correlation-id",
            event.getCorrelationId().getBytes(StandardCharsets.UTF_8));
        record.headers().add("event-type",
            event.getEventType().name().getBytes(StandardCharsets.UTF_8));
        record.headers().add("producer-timestamp",
            String.valueOf(System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8));

        long startTime = System.currentTimeMillis();

        return kafkaTemplate.send(record)
            .thenApply(result -> {
                long latency = System.currentTimeMillis() - startTime;
                meterRegistry.timer("kafka.producer.publish.latency",
                    "topic", PAYMENT_EVENTS_TOPIC,
                    "event_type", event.getEventType().name()
                ).record(latency, TimeUnit.MILLISECONDS);

                log.debug("Published payment event {} to partition {} offset {}",
                    event.getEventId(),
                    result.getRecordMetadata().partition(),
                    result.getRecordMetadata().offset());
                return result;
            })
            .exceptionally(ex -> {
                meterRegistry.counter("kafka.producer.publish.error",
                    "topic", PAYMENT_EVENTS_TOPIC,
                    "error_type", ex.getClass().getSimpleName()
                ).increment();

                log.error("Failed to publish payment event {}: {}",
                    event.getEventId(), ex.getMessage(), ex);
                throw new PaymentEventPublishException(
                    "Failed to publish event: " + event.getEventId(), ex);
            });
    }
}
```

## 9. المنتج المعاملاتي

لدلالات مرة واحدة بالضبط، استخدم واجهة المنتج المعاملاتي. وهذا مشروح بعمق في الدرس 5، لكن النمط الأساسي:

```java
@Bean
public ProducerFactory<String, PaymentEvent> transactionalProducerFactory() {
    Map<String, Object> props = new HashMap<>();
    // ... base props ...
    // Do NOT set transactional.id yourself: the factory generates one per
    // producer from this prefix. The prefix must be unique per application
    // instance (e.g. include the pod name) to avoid fencing each other.
    DefaultKafkaProducerFactory<String, PaymentEvent> factory =
        new DefaultKafkaProducerFactory<>(props);
    factory.setTransactionIdPrefix("payment-tx-" + instanceId + "-");
    return factory;
}

@Bean
public KafkaTemplate<String, PaymentEvent> transactionalKafkaTemplate() {
    return new KafkaTemplate<>(transactionalProducerFactory());
}
```

```java
@Service
public class TransactionalPaymentPublisher {

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    public void publishPaymentWithTransaction(PaymentEvent debit, PaymentEvent credit) {
        kafkaTemplate.executeInTransaction(ops -> {
            ops.send("payment-events", debit.getAccountId(), debit);
            ops.send("payment-events", credit.getAccountId(), credit);
            return null; // Both committed atomically, or neither
        });
    }
}
```

## 10. مراقبة مقاييس المنتج

يكشف منتج Kafka مقاييس JMX حرجة للعمليات الإنتاجية.

### مقاييس المنتج الأساسية

| المقياس                         | الوصف                            | عتبة التنبيه          |
|--------------------------------|----------------------------------------|--------------------------|
| ‏`record-send-rate`             | السجلات المرسلة في الثانية                | تحت عتبة SLA      |
| ‏`record-error-rate`            | الإرسالات الفاشلة في الثانية                 | > 0 للمواضيع المالية |
| ‏`request-latency-avg`          | متوسط زمن طلبات الوسيط         | > 100ms                  |
| ‏`request-latency-max`          | أقصى زمن لطلبات الوسيط         | > 500ms                  |
| ‏`batch-size-avg`               | متوسط حجم الدفعة بالبايت            | راقب صحة التجميع  |
| ‏`records-per-request-avg`      | متوسط السجلات لكل طلب            | منخفض = تجميع ضعيف      |
| ‏`buffer-available-bytes`       | ما تبقى من مخزن المنتج المؤقت              | < 10% يطلق تنبيهًا     |
| ‏`record-queue-time-avg`        | الوقت في مُجمّع السجلات       | ارتفاعه = وسيط بطيء     |

### التكامل مع Micrometer

```java
// Spring Boot registers this automatically for the producer factory it
// creates. For a factory you build yourself, add the listener explicitly:
@Bean
public ProducerFactory<String, PaymentEvent> producerFactory(MeterRegistry registry) {
    DefaultKafkaProducerFactory<String, PaymentEvent> factory =
        new DefaultKafkaProducerFactory<>(producerProps());
    // Binds the native client metrics (record-send-rate, request-latency-avg,
    // ...) to Micrometer, tagged per producer
    factory.addListener(new MicrometerProducerListener<>(registry));
    return factory;
}
```

### معترض منتج مخصص للمراقبة

```java
public class PaymentProducerInterceptor
        implements ProducerInterceptor<String, PaymentEvent> {

    private static final Logger log =
        LoggerFactory.getLogger(PaymentProducerInterceptor.class);
    private final AtomicLong totalSent = new AtomicLong(0);
    private final AtomicLong totalErrors = new AtomicLong(0);

    @Override
    public ProducerRecord<String, PaymentEvent> onSend(
            ProducerRecord<String, PaymentEvent> record) {
        // Stamp send timestamp for end-to-end latency tracking
        record.headers().add("producer-timestamp",
            String.valueOf(System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8));
        return record;
    }

    @Override
    public void onAcknowledgement(RecordMetadata metadata, Exception exception) {
        if (exception == null) {
            totalSent.incrementAndGet();
        } else {
            totalErrors.incrementAndGet();
            log.error("Producer acknowledgement error: {}", exception.getMessage());
        }
    }

    @Override
    public void close() {
        log.info("Producer closing. Total sent: {}, Total errors: {}",
            totalSent.get(), totalErrors.get());
    }

    @Override
    public void configure(Map<String, ?> configs) {}
}
```

```java
// Register the interceptor
props.put(ProducerConfig.INTERCEPTOR_CLASSES_CONFIG,
    PaymentProducerInterceptor.class.getName());
```

## 11. مرجع إعداد الإنتاج

### منتج أحداث الدفع (ديمومة عالية، إنتاجية متوسطة)

```yaml
# application.yml
# Only some producer settings have dedicated Spring Boot keys; the rest go
# under "properties" with their native Kafka names
spring:
  kafka:
    bootstrap-servers: kafka-broker-1:9092,kafka-broker-2:9092,kafka-broker-3:9092
    producer:
      acks: all
      retries: 2147483647
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      compression-type: lz4
      batch-size: 64KB
      buffer-memory: 64MB
      properties:
        enable.idempotence: true
        linger.ms: 5
        max.in.flight.requests.per.connection: 5
        delivery.timeout.ms: 120000
        request.timeout.ms: 30000
        max.block.ms: 60000
        metadata.max.age.ms: 300000
```

### منتج سجل التدقيق (أقصى ديمومة، إنتاجية منخفضة)

```yaml
spring:
  kafka:
    producer:
      acks: all
      retries: 2147483647
      compression-type: zstd
      batch-size: 16KB        # Default batch size
      properties:
        enable.idempotence: true
        linger.ms: 0          # No batching delay for audit events
```

## 12. مزالق شائعة في منتجي Kafka الماليين

### المزلق 1: مشاركة KafkaTemplate عبر المعاملات

```java
// WRONG: one raw transactional KafkaProducer shared by several threads
KafkaProducer<String, PaymentEvent> shared = new KafkaProducer<>(txProps);
shared.initTransactions();
// ThreadA: shared.beginTransaction(); ... send ...
// ThreadB: shared.beginTransaction();  -> IllegalStateException, or ThreadB's
// sends end up inside ThreadA's transaction. A KafkaProducer can only run
// ONE transaction at a time.
```

```java
// CORRECT: let Spring manage transactional producers
@Bean
public ProducerFactory<String, PaymentEvent> producerFactory() {
    DefaultKafkaProducerFactory<String, PaymentEvent> factory =
        new DefaultKafkaProducerFactory<>(props);
    factory.setTransactionIdPrefix("payment-tx-");
    return factory;
    // The factory caches transactional producers; each Kafka transaction
    // (executeInTransaction, or a KafkaTransactionManager-driven
    // @Transactional method) gets its OWN producer for its duration --
    // no interleaving between threads
}
```

### المزلق 2: ‏send() الحاجب في خيط العمل

```java
// WRONG: Blocks the calling thread until broker responds
SendResult<String, PaymentEvent> result = kafkaTemplate.send(record).get();
// If broker is slow, your payment API latency spikes

// BETTER: Non-blocking with explicit timeout, and react to the outcome
CompletableFuture<SendResult<String, PaymentEvent>> future = kafkaTemplate.send(record);
future.orTimeout(5, TimeUnit.SECONDS)
      .whenComplete((result, ex) -> {
          if (ex != null) {
              // alert / metric; the event must not be lost -- which is why
              // payment events are better written via the transactional
              // outbox (Lesson 06) than sent directly from the API path
              publishFailures.increment();
          }
      });
```

### المزلق 3: عدم معالجة امتلاء المخزن المؤقت

```java
// WRONG: fire and forget -- nobody looks at the outcome
kafkaTemplate.send(topic, key, event);
// When the buffer is full, send() BLOCKS the calling thread for up to
// max.block.ms and then fails (BufferExhaustedException / TimeoutException,
// thrown directly or via the returned future). Ignored, the event is lost.

// CORRECT: handle both the synchronous failure and the future's failure
try {
    kafkaTemplate.send(topic, key, event)
        .whenComplete((r, ex) -> { if (ex != null) handlePublishFailure(event, ex); });
} catch (KafkaException | org.apache.kafka.common.errors.TimeoutException e) {
    handlePublishFailure(event, e);   // buffer full / metadata unavailable
}
// handlePublishFailure: metric + alert + retry from a durable store.
// For payment events, the robust design is to write the event to an
// OUTBOX table in the same DB transaction as the business change, and
// publish from there (Lesson 06) -- a fallback written only after Kafka
// failed is no longer atomic with the business transaction.
```

### المزلق 4: مفاتيح أقسام غير متسقة للكيان نفسه

```java
// WRONG: Same account uses different key formats in different services
// Service A: key = "ACC-001"
// Service B: key = "account-ACC-001"
// These land in DIFFERENT partitions — ordering guarantee broken

// CORRECT: Centralize key normalization
public class KafkaKeyNormalizer {
    public static String forAccount(String rawAccountId) {
        // Strip all prefixes, normalize to canonical form
        return rawAccountId.replaceAll("^(account-|acct-)", "").toUpperCase();
    }
}
```

## 13. اختبار إعداد المنتج

```java
@SpringBootTest
@EmbeddedKafka(
    partitions = 12,
    topics = {"payment-events"},
    bootstrapServersProperty = "spring.kafka.bootstrap-servers",
    brokerProperties = {
        "transaction.state.log.replication.factor=1",
        "transaction.state.log.min.isr=1"
    }
)
class PaymentEventPublisherTest {

    @Autowired
    private PaymentEventPublisher publisher;

    @Autowired
    private EmbeddedKafkaBroker embeddedKafka;

    private KafkaConsumer<String, String> testConsumer;

    @BeforeEach
    void setup() {
        // Unique group per test: the broker is shared across tests, and an
        // "earliest" consumer in a reused group would see older test data
        Map<String, Object> consumerProps = KafkaTestUtils.consumerProps(
            "test-consumer-" + UUID.randomUUID(), "true", embeddedKafka);
        consumerProps.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        testConsumer = new KafkaConsumer<>(consumerProps,
            new StringDeserializer(), new StringDeserializer());
        testConsumer.subscribe(List.of("payment-events"));
    }

    @AfterEach
    void tearDown() {
        testConsumer.close();
    }

    @Test
    void shouldPublishPaymentEventToCorrectPartition() throws Exception {
        String accountId = "ACC-" + UUID.randomUUID();   // unique per test run
        PaymentEvent event = PaymentEvent.builder()
            .eventId(UUID.randomUUID().toString())
            .accountId(accountId)
            .amount(new BigDecimal("500.00"))
            .eventType(PaymentEventType.PAYMENT_INITIATED)
            .correlationId(UUID.randomUUID().toString())
            .build();

        publisher.publishPaymentEvent(event).get(10, TimeUnit.SECONDS);

        ConsumerRecord<String, String> received = StreamSupport.stream(
                KafkaTestUtils.getRecords(testConsumer, Duration.ofSeconds(5)).spliterator(), false)
            .filter(r -> accountId.equals(r.key()))
            .findFirst().orElseThrow();
        assertThat(received.key()).isEqualTo(accountId);
    }

    @Test
    void shouldMaintainOrderingForSameAccount() throws Exception {
        String accountId = "ACC-" + UUID.randomUUID();
        List<PaymentEvent> events = IntStream.range(0, 10)
            .mapToObj(i -> PaymentEvent.builder()
                .eventId("EVT-" + i)
                .accountId(accountId)
                .sequenceNumber(i)
                .correlationId(UUID.randomUUID().toString())
                .build())
            .collect(Collectors.toList());

        for (PaymentEvent event : events) {
            publisher.publishPaymentEvent(event).get(10, TimeUnit.SECONDS);
        }

        // wait until at least 10 records arrived (a single poll may return fewer)
        List<ConsumerRecord<String, String>> mine = StreamSupport.stream(
                KafkaTestUtils.getRecords(testConsumer, Duration.ofSeconds(10), 10).spliterator(), false)
            .filter(r -> accountId.equals(r.key()))
            .toList();

        // All events for the same account must be in the same partition...
        assertThat(mine).extracting(ConsumerRecord::partition).containsOnly(mine.get(0).partition());
        assertThat(mine).hasSize(10);
        // ...and arrive in the order they were sent
        for (int i = 0; i < mine.size(); i++) {
            assertThat(mine.get(i).value()).contains("\"EVT-" + i + "\"");
        }
    }
}
```

## الخلاصة

| الإعداد                     | القيمة للنظام المالي                              |
|-----------------------------------|-----------------------------------------------------|
| ‏`acks=all`                        | لا فقد بيانات إذا فشل أي وسيط واحد             |
| ‏`enable.idempotence=true`         | لا أحداث مكررة من إعادة المحاولة                    |
| ‏`linger.ms=5`                     | دفعات أكمل ← إنتاجية أعلى بكثير غالبًا، مقابل ≤5ms من الزمن |
| ‏`batch.size=65536`                | تجميع فعال لأحداث الدفع عالية الحجم   |
| ‏`compression.type=lz4`            | تقليل عرض النطاق بنسبة 50–80% بكلفة معالج ضئيلة      |
| معرّف الحساب كمفتاح                 | ضمان الترتيب لكل الأحداث داخل الحساب |
| ‏`max.in.flight=5`                 | عمق خط مثالي متوافق مع idempotence  |
| ‏`delivery.timeout.ms=120000`      | ميزانية إعادة المحاولة الإجمالية قبل الاستسلام                 |

منتج Kafka خط معالجة متطور. وفي الأنظمة المالية، عامله كأي مكوّن بنية تحتية حرج: اضبطه صراحة، وراقبه بشمول، واختبر أنماط الفشل قبل حدوثها في الإنتاج.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "منتج مدفوعات مُعدّ بـ acks=1. يؤكد الوسيط القائد الكتابة، ثم يتعطل فورًا قبل النسخ. ما النتيجة؟",
      "options": [
        "الرسالة آمنة — سيُرقّى التابع ويحتفظ بها",
        "الرسالة تضيع — acks=1 ينتظر القائد فقط، لا التابعين",
        "سيعيد المنتج المحاولة تلقائيًا ويعيد تسليم الرسالة",
        "يمنع عامل النسخ في Kafka أي فقد بيانات بغض النظر عن إعداد acks"
      ],
      "correct": 1,
      "explanation": "يعني acks=1 أن المنتج يعتبر الكتابة ناجحة بعد تأكيد القائد، دون انتظار نسخ التابعين. فإذا تعطل القائد قبل اكتمال النسخ، تضيع الرسالة. وفي الأنظمة المالية، يلزم acks=all (أو acks=-1) مع min.insync.replicas=2 لضمان الديمومة."
    },
    {
      "text": "مع enable.idempotence=true، يرسل منتج رسالة، وتنتهي مهلته وهو ينتظر التأكيد، فيعيد المحاولة. ما الذي يمنع وجود سجل مكرر في الموضوع؟",
      "options": [
        "يفحص الوسيط تجزئة حمولة الرسالة لكشف التكرارات",
        "يستخدم المنتج معرّف منتج (PID) ورقمًا تسلسليًا متزايدًا؛ ويرفض الوسيط السجلات ذات تسلسل رآه من قبل",
        "يتوقف المنتج وينتظر تأكيد المستهلك قبل إعادة المحاولة",
        "تستخدم Kafka أقفالًا موزعة لمنع الكتابات المتزامنة للمفتاح نفسه"
      ],
      "correct": 1,
      "explanation": "يعطي المنتج idempotent معرّف منتج (PID) فريدًا لكل مثيل منتج ويرفق رقمًا تسلسليًا متزايدًا باطراد بكل سجل. ويتتبع الوسطاء أعلى تسلسل رأوه لكل PID لكل قسم ويتجاهلون التكرارات بصمت. وهذا شفاف للتطبيق ويضيف عبئًا ضئيلًا."
    },
    {
      "text": "تضبط linger.ms=50 وbatch.size=65536 على منتج دفع عالي الإنتاجية. تحت حمل ثقيل، أي عبارة تصف سلوك التجميع أفضل وصف؟",
      "options": [
        "تُرسل السجلات فورًا حين يُبلغ batch.size، أو بعد 50 ms إن لم تمتلئ الدفعة — أيهما أسبق",
        "تُحتجز السجلات دائمًا 50 ms بالضبط قبل الإرسال، بغض النظر عن حجم الدفعة",
        "يُتجاهل batch.size حين يُضبط linger.ms؛ ويتحكم المؤقت وحده في الإرسال",
        "ينتظر المنتج حتى يتحقق الشرطان معًا: الدفعة ممتلئة و50 ms مرت"
      ],
      "correct": 0,
      "explanation": "‏linger.ms وbatch.size كلاهما محفز — أيهما يُطلق أولًا يسبب إرسال الدفعة. وتحت الحمل الثقيل تمتلئ الدفعة بسرعة وتُرسل قبل مهلة linger، فتعطي إنتاجية عالية. وتحت الحمل المنخفض، يضمن linger.ms عدم احتجاز الرسائل إلى ما لا نهاية. ويعمل الإعدادان معًا، لا بالتتابع."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "منتج Kafka بمستوى إنتاجي لأحداث الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    "اضبط KafkaProducer بـ acks=all، وenable.idempotence=true (مضبوطة صراحة)، وmax.in.flight.requests.per.connection=5، وضغط lz4، وأنشئ الموضوع بـ min.insync.replicas=2 (إعداد للموضوع/الوسيط، لا للمنتج). واكتب اختبار وحدة يتحقق من قيم إعداد المنتج قبل إنشائه.",
    "نفّذ PaymentEventPublisher يستخدم accountId كمفتاح القسم ويرفق ترويسة event-id من نوع UUID لتتبع idempotency على جانب المستهلك. وأضف تسجيلًا مهيكلًا للقسم والإزاحة المعادين في الاستدعاء الراجع لـ RecordMetadata.",
    "باستخدام MockProducer ‏(errorNext)، تحقق من أن الناشر يسجل مقياس خطأ ويُظهر للمستدعي خطأً غير قابل لإعادة المحاولة (مثل InvalidTopicException). ثم اشرح، مع العميل الحقيقي، أي الأخطاء يعيد محاولتها داخليًا (مثل NotLeaderOrFollowerException) وكيف يحد delivery.timeout.ms تلك المحاولات.",
    "ابنِ مكوّن مراقبة للمنتج يكشف record-send-rate، وrecord-error-rate، وrequest-latency-avg عبر Micrometer ‏(MicrometerProducerListener). واكتب اختبار تكامل ينشر 1000 رسالة ويتحقق من بقاء معدل الأخطاء صفرًا وبقاء زمن الإرسال p99 تحت 100 ms."
  ]
}
-->

**الدرس التالي**: مستهلك Kafka — إدارة الإزاحات وإعادة التوازن
