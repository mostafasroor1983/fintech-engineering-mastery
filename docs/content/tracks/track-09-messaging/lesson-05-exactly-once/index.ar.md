---
id: track-09-lesson-05
title: "المعالجة مرة واحدة فقط — المعاملات في Kafka"
slug: kafka-exactly-once
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 5
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [exactly-once, idempotent-producer, kafka-transactions, EOS, deduplication]
prerequisites: [track-09-lesson-04]
---

# دلالات مرة واحدة بالضبط — المعاملات في Kafka

> [!NOTE]
> أحداث الدفع المكررة نمط فشل حرج: عميل يُخصم منه مرتين، أو تحويل يُنفذ مرتين، أو إشارة احتيال تُحسب مرتين. وتزيل دلالات مرة واحدة بالضبط (EOS) في Kafka التكرارات داخل منظومة Kafka عبر آليتين: المنتجين idempotent والمنتجين المعاملاتيين. ويغطي هذا الدرس الآليتين، وإعدادهما، وحدودهما، وكيف تبني جدول إزالة تكرار على جانب المستهلك كشبكة أمان مستقلة.

## مقارنة ضمانات التسليم

توجد ثلاثة ضمانات تسليم في المراسلة الموزعة:

```
At-Most-Once:
  Producer sends, broker may or may not ack.
  On timeout, producer does NOT retry.
  Result: messages may be LOST.
  Use when: loss is acceptable (metrics, non-critical logs).

At-Least-Once:
  Producer retries on failure. Broker may receive duplicate.
  Consumer processes every message, possibly multiple times.
  Result: messages are NOT lost but may be DUPLICATED.
  Use when: idempotent consumers handle duplicates downstream.

Exactly-Once:
  Each message is delivered and processed exactly once.
  Result: no loss, no duplicates — within the Kafka cluster.
  Use when: financial transactions, payment processing, ledger updates.
```

| الضمان | خطر الفقد | خطر التكرار | الزمن | الإنتاجية |
|-----------|-----------|---------------|---------|------------|
| مرة واحدة على الأكثر | عالٍ | لا شيء | الأدنى | الأعلى |
| مرة واحدة على الأقل | لا شيء | ممكن (عند إعادة المحاولة/إعادة التشغيل) | متوسط | متوسطة |
| مرة واحدة بالضبط | لا شيء | لا شيء (داخل Kafka) | + حتى فترة التزام واحدة | بعض الفقد (يعتمد على الحمل — فقِسه) |

## المنتج idempotent

يمنع المنتج idempotent التكرارات الناتجة عن **إعادة محاولات المنتج**. فحين تحدث مهلة شبكة، يعيد المنتج المحاولة وقد يرسل الرسالة نفسها مرتين. ودون idempotence، يقبل الوسيط الاثنتين. ومع idempotence، يزيل الوسيط التكرار.

### كيف يعمل

يُعطى كل منتج **معرّف منتج (PID)** ويحتفظ **برقم تسلسلي** لكل قسم. ويتتبع الوسيط آخر رقم تسلسلي لكل زوج (PID، قسم) ويرفض التكرارات.

```
Producer (PID=42)
  │── send(msg, seq=0) → Broker receives, stores
  │── TIMEOUT — did broker get it?
  │── retry send(msg, seq=0) → Broker sees seq=0 already written for PID=42
  │                            → does NOT write it again, returns success
  │── Producer gets one acknowledgement; the log holds ONE copy
```

### الإعداد

```java
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.KafkaProducer;
import java.util.Properties;

public class IdempotentProducerFactory {

    public static KafkaProducer<String, String> create(String bootstrapServers) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");

        // Enable idempotence — prevents duplicate sends from retries
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);

        // Required by idempotence: acks=all ensures all replicas confirm
        props.put(ProducerConfig.ACKS_CONFIG, "all");

        // Required by idempotence: max in-flight requests per connection <= 5
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);

        // Required by idempotence: retries must be > 0
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);

        return new KafkaProducer<>(props);
    }
}
```

> **مهم:** يمنع `enable.idempotence=true` التكرارات داخل جلسة منتج واحدة فقط. فإذا أعيد تشغيل عملية المنتج بـ PID جديد، تُعاد ضبط الأرقام التسلسلية ولا يستطيع الوسيط كشف التكرارات عبر الجلسات.

## المنتج المعاملاتي

يوسّع المنتج المعاملاتي idempotence لتوفير **كتابات ذرية عبر أقسام ومواضيع متعددة**. فكل السجلات في معاملة إما مرئية كلها أو غير مرئية كلها لمستهلكي `read_committed`.

### دورة حياة المعاملة

```
initTransactions()          — Register with Transaction Coordinator; bumps the
                              epoch for this transactional.id (fences older
                              instances) and aborts their open transaction
beginTransaction()          — Start a transaction (local state only)
  send(record1)             — Buffered in transaction
  send(record2)             — Buffered in transaction
  sendOffsetsToTransaction() — Atomically commit consumer offsets with the records
commitTransaction()         — Make all records visible atomically
  OR
abortTransaction()          — Discard all buffered records
```

### تنفيذ كامل للمنتج المعاملاتي

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.springframework.stereotype.Service;
import java.util.Map;
import java.util.Properties;

@Service
public class TransactionalPaymentProducer {

    private final KafkaProducer<String, String> producer;
    private final String transactionalId;

    public TransactionalPaymentProducer(String bootstrapServers, String instanceId) {
        this.transactionalId = "payment-processor-" + instanceId;

        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                "org.apache.kafka.common.serialization.StringSerializer");

        // Enable idempotence (required for transactions)
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);

        // Transactional ID — must be unique per producer instance
        // Kafka uses this to fence zombie producers from previous epochs
        props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, this.transactionalId);

        // Transaction timeout — abort if commit/abort not called within this window
        props.put(ProducerConfig.TRANSACTION_TIMEOUT_CONFIG, 60_000); // 60 seconds

        this.producer = new KafkaProducer<>(props);

        // Must be called once before any transactions — registers with coordinator
        this.producer.initTransactions();
    }

    /**
     * Read-Process-Write: consume from payments.raw, produce to payments.enriched.
     * Consumer offsets and produced records are committed atomically.
     */
    public void processPaymentAtomically(
            ConsumerRecord<String, String> rawRecord,
            String enrichedPayload,
            ConsumerGroupMetadata groupMetadata,       // = consumer.groupMetadata()
            Map<TopicPartition, OffsetAndMetadata> offsetsToCommit) {

        producer.beginTransaction();
        try {
            // Produce to output topic -- partitioned by KEY, not by copying
            // the input partition number (the output topic may have a
            // different partition count)
            ProducerRecord<String, String> enriched = new ProducerRecord<>(
                    "payments.enriched",
                    rawRecord.key(),
                    enrichedPayload
            );
            producer.send(enriched);

            // Atomically commit the consumed offset as part of the transaction.
            // Pass the consumer's FULL group metadata (generation, member id):
            // the broker then fences zombies from an older group generation
            // (KIP-447). The old groupId-only overload is deprecated.
            producer.sendOffsetsToTransaction(offsetsToCommit, groupMetadata);

            producer.commitTransaction();

        } catch (ProducerFencedException | OutOfOrderSequenceException
                 | AuthorizationException e) {
            // Fatal — this producer instance has been fenced.
            // A new producer with the same transactional.id has taken over.
            // Shut down this instance immediately — do not retry.
            log.error("Producer fenced — shutting down transactionalId={}", transactionalId, e);
            producer.close();
            throw new FatalProducerException("Producer fenced", e);

        } catch (KafkaException e) {
            // Transient error — abort and allow retry. The CALLER must also
            // seek the consumer back to the last committed offsets, otherwise
            // its next poll() continues after the aborted records.
            producer.abortTransaction();
            throw new RetryableProcessingException("Transaction aborted — will retry", e);
        }
    }
}
```

### إقصاء الزومبي (Zombie Fencing)

حين يتعطل منتج ويبدأ مثيل جديد بـ `transactional.id` نفسه، تزيد Kafka **الحقبة (epoch)**. فيُقصى المنتج القديم (الزومبي) — وأي `commitTransaction()` من الحقبة القديمة يعيد `ProducerFencedException`.

```
Instance A (epoch=1):  beginTransaction()... process... CRASH
Instance B (epoch=2):  initTransactions() → epoch bumped to 2
                        beginTransaction()... process... commitTransaction() ✓
Instance A (zombie):   tries commitTransaction(epoch=1) → ProducerFencedException ✗
```

## عزل المستهلك `read_committed`

يرى المستهلك بالقيمة الافتراضية `isolation.level=read_uncommitted` كل السجلات، بما فيها سجلات المعاملات المُجهضة. واستخدم `read_committed` لرؤية السجلات الملتزمة فقط.

```java
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.consumer.ConsumerConfig;

Properties consumerProps = new Properties();
consumerProps.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
consumerProps.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-enrichment-consumer");
consumerProps.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
        "org.apache.kafka.common.serialization.StringDeserializer");
consumerProps.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
        "org.apache.kafka.common.serialization.StringDeserializer");

// CRITICAL: only see committed records — ignore in-flight and aborted transactions
consumerProps.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");

// Do NOT auto-commit — use sendOffsetsToTransaction for atomic offset management
consumerProps.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(consumerProps);
```

## ‏`KafkaTransactionManager` في Spring Kafka

يدمج Spring Kafka المعاملات مع `@Transactional` عبر `KafkaTransactionManager`.

```java
import org.springframework.kafka.transaction.KafkaTransactionManager;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class KafkaTransactionConfig {

    @Bean
    public ProducerFactory<String, String> transactionalProducerFactory(
            // ${...} placeholders are only resolved in annotations/properties,
            // NOT inside Java string literals -- inject the values
            @Value("${kafka.bootstrap-servers}") String bootstrapServers,
            @Value("${POD_NAME}") String podName) {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);

        DefaultKafkaProducerFactory<String, String> factory =
                new DefaultKafkaProducerFactory<>(props);
        // Do not set transactional.id yourself: the factory derives one per
        // producer from this prefix. For producer-only transactions the
        // prefix must be unique per application INSTANCE.
        factory.setTransactionIdPrefix("payment-svc-" + podName + "-");
        return factory;
    }

    @Bean
    public KafkaTemplate<String, String> kafkaTemplate(
            ProducerFactory<String, String> transactionalProducerFactory) {
        return new KafkaTemplate<>(transactionalProducerFactory);
    }

    @Bean
    public KafkaTransactionManager<String, String> kafkaTransactionManager(
            ProducerFactory<String, String> producerFactory) {
        return new KafkaTransactionManager<>(producerFactory);
    }
}

@Service
@Slf4j
public class PaymentEnrichmentService {

    @Autowired private KafkaTemplate<String, String> kafkaTemplate;
    @Autowired private PaymentEnricher enricher;

    // Spring @Transactional wraps the method in a Kafka transaction
    @Transactional("kafkaTransactionManager")
    public void enrichAndPublish(String paymentId, String rawPayload) {
        String enriched = enricher.enrich(rawPayload);

        kafkaTemplate.send("payments.enriched", paymentId, enriched);
        kafkaTemplate.send("payments.audit", paymentId, buildAuditRecord(rawPayload, enriched));

        // Both sends are committed atomically when the method returns.
        // If an exception is thrown, both are aborted.
        log.info("Enriched payment {} published to payments.enriched and payments.audit", paymentId);
    }
}
```

## ‏EOS في Kafka Streams

توفر Kafka Streams معالجة مرة واحدة بالضبط عبر `processing.guarantee=exactly_once_v2` ‏(KIP-447، Kafka 2.5+).

```java
import org.apache.kafka.streams.StreamsConfig;
import org.apache.kafka.streams.KafkaStreams;
import org.apache.kafka.streams.StreamsBuilder;
import java.util.Properties;

public class PaymentStreamsApp {

    public static KafkaStreams buildApp(String bootstrapServers) {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "payment-enrichment-streams");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);

        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        // EOS v2 — one transactional producer per stream thread (v1: one per task)
        // Requires brokers 2.5+; the broker's internal transaction log defaults
        // (replication factor 3, min ISR 2) need at least 3 brokers
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
                StreamsConfig.EXACTLY_ONCE_V2);

        // Commit interval controls how often the EOS transaction is committed
        props.put(StreamsConfig.COMMIT_INTERVAL_MS_CONFIG, 100);

        StreamsBuilder builder = new StreamsBuilder();

        builder.stream("payments.raw")
               .mapValues(PaymentEnricher::enrich)
               .filter((key, value) -> value != null)
               .to("payments.enriched");

        return new KafkaStreams(builder.build(), props);
    }
}
```

**‏EOS v1 مقابل EOS v2:**

| الخاصية | exactly_once (v1) | exactly_once_v2 |
|----------|-------------------|-----------------|
| إصدار الوسيط | 0.11+ | 2.5+ |
| المنتجون المعاملاتيون | واحد لكل مهمة (قسم إدخال) | واحد لكل خيط تدفق |
| حمل الوسيط | أعلى | أدنى |
| الحالة | مُهمل، وأُزيل في Kafka 4.0 | موصى به |

## جدول إزالة التكرار على جانب المستهلك

‏EOS داخلية في Kafka. فإذا استهلكت من Kafka وكتبت إلى قاعدة بيانات، لا تمنع EOS في Kafka التكرارات على مستوى قاعدة البيانات. فاستخدم جدول إزالة تكرار كشبكة أمان.

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class IdempotentPaymentProcessor {

    @Autowired private PaymentRepository paymentRepository;
    @Autowired private JdbcTemplate jdbcTemplate;

    @Transactional
    public void processPayment(String eventId, PaymentEvent event) {
        // Claim the event FIRST via the primary key. An "exists?" check
        // followed by a later insert is a race: two deliveries processed
        // concurrently (e.g. around a rebalance) could both see "not yet".
        int claimed = jdbcTemplate.update("""
                INSERT INTO processed_events (event_id, aggregate_id)
                VALUES (?, ?)
                ON CONFLICT (event_id) DO NOTHING
                """, eventId, event.getAggregateId());

        if (claimed == 0) {
            log.info("Duplicate event detected: eventId={} — skipping", eventId);
            return;
        }

        // Process business logic — same DB transaction as the claim, so a
        // failure rolls both back and the redelivery is processed normally
        Payment payment = Payment.from(event);
        paymentRepository.save(payment);

        log.info("Payment processed: paymentId={} eventId={}", event.getPaymentId(), eventId);
    }
}
```

```sql
-- Deduplication table schema
CREATE TABLE processed_events (
    event_id    VARCHAR(255) PRIMARY KEY,
    aggregate_id VARCHAR(255) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX idx_processed_events_at ON processed_events (processed_at);

-- Cleanup old records: keep them longer than any possible redelivery
-- (topic retention + replay window), e.g. 7 days
DELETE FROM processed_events
WHERE processed_at < NOW() - INTERVAL '7 days';
```

## مزالق الإنتاج

### المزلق 1: إعادة استخدام `transactional.id` عبر مثيلات متعددة

**المشكلة:** تتشارك مثيلات منتجين متعددة `transactional.id` نفسه. المثيل A في منتصف معاملة حين يستدعي المثيل B ‏`initTransactions()`: فيزيد استدعاء B الحقبة، ويجهض معاملة A المفتوحة، ويقصي A. وحين يُعاد تشغيل A يقصي B بدوره — فتظل المثيلات تقتل معاملات بعضها، وتنهار الإنتاجية، وتتعطل الحاويات في حلقة.

**الإصلاح:** تأكد من أن لكل مثيل منتج `transactional.id` **فريدًا** — مثلًا يتضمن اسم الحاوية (pod). (لمعالجة القراءة-المعالجة-الكتابة مع عملاء ووسطاء Kafka 2.5+، يتم إقصاء الزومبي عبر بيانات مجموعة المستهلكين، فلا يلزم أن تبقى المعرّفات ثابتة عبر إعادات التشغيل — وتبقى أسماء الحاويات الثابتة في StatefulSet خيارًا بسيطًا وآمنًا.)

```java
// BAD — all instances share the same id
props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-processor");

// GOOD — each instance has a unique id
String podName = System.getenv("POD_NAME"); // e.g., "payment-svc-7d8f9b-0"
props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "payment-processor-" + podName);
```

### المزلق 2: عدم معاملة `ProducerFencedException` كخطأ قاتل

**المشكلة:** يلتقط تطبيق `ProducerFencedException` ويعيد المحاولة، مستدعيًا `beginTransaction()` مجددًا على المنتج المُقصى نفسه. فينتج عن ذلك أخطاء `ProducerFencedException` لا نهائية ومستهلك متوقف.

**الإصلاح:** ‏`ProducerFencedException` و`OutOfOrderSequenceException` **قاتلان**. فأغلق المنتج ودع العملية تُعاد تشغيلها (سيجدول Kubernetes حاوية جديدة).

```java
catch (ProducerFencedException | OutOfOrderSequenceException e) {
    // Do NOT retry — this producer instance is dead
    log.error("FATAL: producer fenced. Initiating shutdown.", e);
    producer.close();
    System.exit(1);  // Or: throw a non-retryable exception to the container
}
```

### المزلق 3: استخدام `read_uncommitted` على المستهلكين اللاحقين للمنتجين المعاملاتيين

**المشكلة:** يعالج مستهلك بالقيمة الافتراضية `isolation.level=read_uncommitted` سجلات من معاملة قيد التنفيذ، ثم تُجهض المعاملة. فيكون المستهلك قد عالج سجلات لم تُلتزم أبدًا — فتنتج مدفوعات شبحية أو إشارات احتيال شبحية.

**الإصلاح:** اضبط دائمًا `isolation.level=read_committed` على المستهلكين الذين يقرؤون من مواضيع يكتب إليها منتجون معاملاتيون.

```java
// In application.properties for Spring Boot consumers:
spring.kafka.consumer.properties.isolation.level=read_committed
```

## قائمة تحقق الإنتاج

- [ ] ‏`enable.idempotence=true` على كل منتجي الدفع
- [ ] ‏`acks=all` و`max.in.flight.requests.per.connection <= 5` مضبوطة مع idempotence
- [ ] ‏`transactional.id` فريد لكل مثيل منتج باستخدام اسم الحاوية أو فهرس ثابت
- [ ] ‏`initTransactions()` يُستدعى مرة واحدة أثناء بدء التطبيق
- [ ] ‏`ProducerFencedException` يسبب إيقاف التطبيق — لا إعادة المحاولة
- [ ] ‏`isolation.level=read_committed` على كل المستهلكين الذين يقرؤون من مواضيع معاملاتية
- [ ] ‏`enable.auto.commit=false` على المستهلكين في خطوط القراءة-المعالجة-الكتابة
- [ ] ‏`sendOffsetsToTransaction()` مستخدم للالتزام بالإزاحات ذريًا مع السجلات المنتجة
- [ ] جدول إزالة تكرار على جانب المستهلك كشبكة أمان عبر الأنظمة
- [ ] ‏`processing.guarantee=exactly_once_v2` لطوبولوجيات Kafka Streams
- [ ] ‏`transaction.timeout.ms` أطول من أبطأ معاملة لديك (بما فيها المعالجة) ولا يتجاوز `transaction.max.timeout.ms` في الوسيط (15 دقيقة افتراضيًا)
- [ ] ‏DLQ مُعدّ للرسائل التي تسبب إجهاض المعاملات مرارًا

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق بين ضماني التسليم مرة واحدة على الأقل ومرة واحدة بالضبط في Kafka؟",
      "options": [
        "مرة واحدة على الأقل لا تفقد الرسائل أبدًا ولا تكررها أبدًا؛ ومرة واحدة بالضبط تتجنب الفقد فقط",
        "مرة واحدة على الأقل تعيد المحاولة عند الفشل وقد تسلّم تكرارات؛ ومرة واحدة بالضبط تزيل الفقد والتكرار معًا داخل Kafka",
        "مرة واحدة بالضبط متاحة فقط لـ Kafka Streams، لا للمنتجين والمستهلكين العاديين",
        "مرة واحدة على الأقل تتطلب acks=all؛ ومرة واحدة بالضبط تعمل مع acks=1"
      ],
      "correct": 1,
      "explanation": "تعيد مرة واحدة على الأقل محاولة الإرسالات الفاشلة، فتضمن عدم فقد أي رسالة لكنها قد تسلّم الرسالة نفسها أكثر من مرة. وتزيل مرة واحدة بالضبط (المفعّلة عبر المنتجين idempotent والمعاملاتيين) فقد الرسائل والتكرارات معًا داخل عنقود Kafka. ولا تغطي الذرية عبر الأنظمة مع قواعد البيانات الخارجية — فذلك يتطلب نمط outbox أو إزالة التكرار على جانب المستهلك."
    },
    {
      "text": "ماذا يحدث حين يتشارك مثيلا منتج transactional.id نفسه ويستدعي كلاهما initTransactions()؟",
      "options": [
        "يعمل المنتجان باستقلال بسجلات معاملات منفصلة",
        "يرفض الوسيط استدعاء initTransactions() الثاني بخطأ إعداد",
        "يقصي المثيل الثاني الأول — فيفشل commitTransaction() اللاحق للمنتج الأول بـ ProducerFencedException",
        "تعيّن Kafka تلقائيًا حقبًا فريدة لتجنب التعارضات"
      ],
      "correct": 2,
      "explanation": "يُستخدم transactional.id لإقصاء الزومبي. فحين يستدعي منتج ثانٍ initTransactions() بالمعرّف نفسه، تزيد Kafka حقبة ذلك المعرّف. فيصبح للمنتج الأول (الزومبي) حقبة قديمة. وأي محاولة من المنتج الأول لـ commitTransaction() تعيد ProducerFencedException، فتمنع الزومبي من الالتزام."
    },
    {
      "text": "في خط قراءة-معالجة-كتابة (استهلاك من الموضوع A، وتحويل، وإنتاج إلى الموضوع B)، أي استدعاء API يضمن الالتزام ذريًا بالإزاحات المستهلكة والسجلات المنتجة؟",
      "options": [
        "‏consumer.commitSync() يُستدعى قبل producer.commitTransaction()",
        "‏producer.sendOffsetsToTransaction(offsets, groupMetadata) يُستدعى داخل المعاملة قبل commitTransaction()",
        "ضبط isolation.level=read_committed على المستهلك والمنتج كليهما",
        "استخدام بروتوكول الالتزام ثنائي المرحلة بين منسّق مجموعة المستهلكين والمنتج"
      ],
      "correct": 1,
      "explanation": "يرسل producer.sendOffsetsToTransaction() إزاحات مجموعة المستهلكين إلى منسّق المعاملات كجزء من المعاملة الحالية. وحين تلتزم المعاملة، تُلتزم السجلات المنتجة وإزاحات المستهلك ذريًا. وإذا أُجهضت المعاملة، فلا السجلات ولا تقدم الإزاحة مرئيان."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "خط قراءة-معالجة-كتابة بمرة واحدة بالضبط لتحويل المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "نفّذ منتجًا معاملاتيًا بـ transactional.id=payment-transformer-{instanceId} حيث يأتي instanceId من متغير البيئة POD_NAME. واستدعِ initTransactions() عند البدء. ونفّذ حلقة قراءة-معالجة-كتابة تستهلك من payments.raw، وتثري الدفعة، وتنتج إلى payments.enriched باستخدام sendOffsetsToTransaction للالتزام ذريًا بالسجل المنتج والإزاحة المستهلكة داخل المعاملة نفسها."
    },
    {
      "id": "2",
      "description": "نفّذ شجرة قرار معالجة الأخطاء: أجهض المعاملة وأعد محاولتها عند KafkaException (عابر)؛ وأغلق المنتج واخرج عند ProducerFencedException أو OutOfOrderSequenceException (قاتل)؛ وأجهض وأرسل إلى DLQ عند استثناءات العمل غير القابلة للتعافي. واكتب اختبارات وحدة لكل مسار خطأ باستخدام منتج وهمي يرمي كل نوع استثناء."
    },
    {
      "id": "3",
      "description": "اضبط مستهلكًا لـ payments.enriched بـ isolation.level=read_committed واكتب اختبار تكامل باستخدام EmbeddedKafka يحقن تعطلًا في منتصف معاملة (بين send() وcommitTransaction())، ويعيد تشغيل المنتج، ويتحقق من أن المستهلك يرى نسخة واحدة بالضبط من كل حدث دفع — مؤكدًا عدم ظهور أي تكرارات من المعاملة المُجهضة."
    },
    {
      "id": "4",
      "description": "نفّذ جدول إزالة تكرار على جانب المستهلك (processed_events) كشبكة أمان عبر الأنظمة. ويجب أن تفحص دالة processPayment الجدول قبل تطبيق منطق العمل وتُدرج eventId داخل معاملة قاعدة البيانات نفسها لعملية العمل. واكتب اختبارًا يستدعي processPayment بـ eventId نفسه مرتين ويتحقق من تشغيل منطق العمل مرة واحدة فقط."
    }
  ]
}
-->
