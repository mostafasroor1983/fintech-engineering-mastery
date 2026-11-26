---
id: track-09-lesson-06
title: "نمط Transactional Outbox مع Debezium CDC"
slug: outbox-cdc-debezium
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 6
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [outbox, transactional-outbox, Debezium, CDC, WAL, Kafka-Connect]
prerequisites: [track-09-lesson-05]
---

# نمط Outbox المعاملاتي مع Debezium CDC

> [!NOTE]
> الكتابة إلى قاعدة بيانات والنشر إلى Kafka في العملية نفسها مستحيلة ذريًا دون بنية تحتية خاصة. فإذا نجحت كتابة قاعدة البيانات وفشل النشر إلى Kafka، لا تعلم الخدمات اللاحقة أبدًا بالحدث. وإذا نجح Kafka وفشلت كتابة قاعدة البيانات، يصف الحدث شيئًا لم يحدث أبدًا. ويحل نمط Outbox المعاملاتي ذلك بجعل النشر إلى Kafka نتيجة لكتابة قاعدة البيانات — لا عملية موازية.

## مشكلة الكتابة المزدوجة

ينشر التنفيذ الساذج إلى Kafka داخل دالة الخدمة نفسها التي تكتب إلى قاعدة البيانات:

```java
// BROKEN: Dual-write — not atomic
@Transactional
public Payment createPayment(CreatePaymentCommand cmd) {
    Payment payment = new Payment(cmd);
    paymentRepository.save(payment);    // Step 1: DB write
    kafkaTemplate.send("payments.created", payment.toEvent()); // Step 2: Kafka publish
    return payment;
}
```

أنماط الفشل:

```
Scenario A: DB write succeeds, Kafka publish fails
  → Payment exists in DB but no event published
  → Downstream services (settlement, notifications) never see it
  → System inconsistency — silent data loss

Scenario B: DB write fails (exception thrown after Kafka send is called)
  → Spring rolls back the DB transaction
  → But Kafka has already received the message (Kafka ignores DB rollback)
  → Event published for a payment that does not exist
  → Phantom transaction in downstream systems
```

## حل Outbox المعاملاتي

اكتب إلى جدول outbox **داخل معاملة قاعدة البيانات نفسها** التي تكتب كيان العمل. فسجل outbox هو الالتزام بأن الحدث سيُنشر — ويقرأ الناشر من outbox ويمرره إلى Kafka.

```
Application
  │── BEGIN TRANSACTION
  │   │── INSERT INTO payments (...)       ← business entity
  │   └── INSERT INTO outbox_events (...)  ← event to publish
  └── COMMIT

CDC (Debezium)
  │── Reads WAL (Write-Ahead Log) from PostgreSQL
  │── Sees new outbox_events row
  └── Publishes to Kafka automatically
```

الفكرة الأساسية: **تلتزم قاعدة البيانات بصف outbox وصف الدفعة ذريًا**. فإذا فشلت المعاملة، لا يُلتزم أي منهما. وإذا نجحت، يوجد الاثنان وسينشر Debezium الحدث في النهاية.

## مخطط جدول Outbox

```sql
CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  VARCHAR(100) NOT NULL,   -- e.g., 'Payment'
    aggregate_id    VARCHAR(255) NOT NULL,   -- e.g., payment UUID
    event_type      VARCHAR(100) NOT NULL,   -- e.g., 'PaymentCreated'
    payload         JSONB NOT NULL,          -- event payload
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed       BOOLEAN NOT NULL DEFAULT FALSE  -- polling relay only (CDC never sets it)
);

-- Index for CDC monitoring and polling relay
CREATE INDEX idx_outbox_created_at ON outbox_events (created_at);
CREATE INDEX idx_outbox_processed   ON outbox_events (processed, created_at)
    WHERE processed = FALSE;
```

## طبقة التطبيق: الكتابة إلى Outbox

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.UUID;

@Service
@Slf4j
public class PaymentService {

    @Autowired private PaymentRepository paymentRepository;
    @Autowired private OutboxEventRepository outboxEventRepository;
    @Autowired private ObjectMapper objectMapper;

    /**
     * Creates a payment AND an outbox event in a single atomic transaction.
     * Kafka publication happens asynchronously via Debezium CDC — not here.
     */
    @Transactional
    public Payment createPayment(CreatePaymentCommand cmd) {
        // Step 1: Validate and create the business entity
        Payment payment = Payment.builder()
                .id(UUID.randomUUID().toString())
                .sourceAccountId(cmd.getSourceAccountId())
                .destinationAccountId(cmd.getDestinationAccountId())
                .amount(cmd.getAmount())
                .currency(cmd.getCurrency())
                .status(PaymentStatus.PENDING)
                .createdAt(Instant.now())
                .build();

        paymentRepository.save(payment);

        // Step 2: Write the outbox event in the SAME transaction
        PaymentCreatedEvent event = PaymentCreatedEvent.builder()
                .paymentId(payment.getId())
                .sourceAccountId(payment.getSourceAccountId())
                .destinationAccountId(payment.getDestinationAccountId())
                .amount(payment.getAmount())
                .currency(payment.getCurrency())
                .occurredAt(payment.getCreatedAt())
                .build();

        OutboxEvent outboxEvent = OutboxEvent.builder()
                .id(UUID.randomUUID().toString())
                .aggregateType("Payment")
                .aggregateId(payment.getId())
                .eventType("PaymentCreated")
                .payload(objectMapper.valueToTree(event))
                .createdAt(Instant.now())
                .processed(false)
                .build();

        outboxEventRepository.save(outboxEvent);

        log.info("Payment {} created with outbox event {}", payment.getId(), outboxEvent.getId());
        return payment;
    }

    @Transactional
    public Payment approvePayment(String paymentId) {
        Payment payment = paymentRepository.findById(paymentId)
                .orElseThrow(() -> new PaymentNotFoundException(paymentId));

        payment.setStatus(PaymentStatus.APPROVED);
        payment.setApprovedAt(Instant.now());
        paymentRepository.save(payment);

        OutboxEvent outboxEvent = OutboxEvent.builder()
                .id(UUID.randomUUID().toString())
                .aggregateType("Payment")
                .aggregateId(paymentId)
                .eventType("PaymentApproved")
                .payload(objectMapper.valueToTree(PaymentApprovedEvent.from(payment)))
                .createdAt(Instant.now())
                .processed(false)
                .build();

        outboxEventRepository.save(outboxEvent);
        return payment;
    }
}
```

## مُرحّل الاستطلاع مقابل CDC

نهجان يمرران أحداث outbox إلى Kafka:

```
Polling Relay:
  Scheduled job: SELECT * FROM outbox_events WHERE processed = FALSE ORDER BY created_at
  Publishes each row to Kafka, then marks processed = TRUE
  
  Pros: Simple, works with any database, no special DB privileges
  Cons: Latency (poll interval: 100ms–1s), extra DB load from SELECT queries,
        at-least-once (need idempotent consumer); several relay instances
        need SELECT ... FOR UPDATE SKIP LOCKED; and never page by
        "created_at > last seen" -- transactions commit out of order, so
        a row with an older timestamp can appear later and be skipped

CDC (Debezium):
  Reads PostgreSQL WAL (Write-Ahead Log) — not SELECT queries
  Triggers on each INSERT/UPDATE/DELETE to the outbox table
  
  Pros: Typically sub-second latency, no polling queries, every committed
        insert is captured in commit order
  Cons: Requires logical replication (wal_level=logical, privileges), a
        replication slot that retains WAL while the connector is down,
        connector operations; still at-least-once
```

**التوصية للأنظمة المالية الإنتاجية:** فضّل CDC حين تستطيع تشغيله (ومراقبة فتحة النسخ). فمُرحّل الاستطلاع يضيف زمنًا وحمل استعلامات تحت الإنتاجية العالية، بينما يقرأ CDC الـ WAL الذي يكتبه PostgreSQL على أي حال. ويبقى مُرحّل الاستطلاع المبني جيدًا خيارًا صالحًا تمامًا للأحجام المتوسطة أو حيث لا يتوفر النسخ المنطقي.

## إعداد موصّل Debezium لـ PostgreSQL

```json
{
  "name": "payment-outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "debezium",
    "database.password": "${file:/secrets/debezium-creds:password}",
    "database.dbname": "payments",
    "topic.prefix": "payments-db",

    "plugin.name": "pgoutput",
    "publication.name": "dbz_outbox_publication",
    "publication.autocreate.mode": "disabled",

    "table.include.list": "public.outbox_events",
    "tombstones.on.delete": "false",

    "transforms": "outbox",
    "transforms.outbox.type":
        "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.id": "id",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.table.field.event.type": "event_type",
    "transforms.outbox.route.by.field": "aggregate_type",
    "transforms.outbox.route.topic.replacement": "payments.${routedByValue}.events",
    "transforms.outbox.table.expand.json.payload": "true",

    "transforms.outbox.table.fields.additional.placement":
        "aggregate_type:header:aggregate_type,event_type:header:event_type",

    "key.converter": "org.apache.kafka.connect.storage.StringConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",

    "snapshot.mode": "no_data",
    "max.batch.size": "500",
    "max.queue.size": "8192",
    "poll.interval.ms": "100",

    "heartbeat.interval.ms": "30000",
    "slot.name": "debezium_outbox_slot"
  }
}
```

ملاحظات: حلّ `topic.prefix` محل `database.server.name` في Debezium 2.x. ويتخطى `snapshot.mode=no_data` (الاسم الأقدم `never`) اللقطة الأولية — لذا أنشئ فتحة النسخ (شغّل الموصّل) **قبل** أن يكتب التطبيق أول صفوف outbox، وإلا لن تُرسل أبدًا الصفوف غير المنشورة المكتوبة قبل ذلك. ويضع EventRouter معرّف صف outbox في ترويسة Kafka اسمها `id` — ويزيل المستهلكون التكرار بناءً عليها.

**متطلبات PostgreSQL المسبقة:**

```sql
-- Set wal_level for logical replication (requires restart)
-- In postgresql.conf:
-- wal_level = logical
-- max_replication_slots = 10
-- max_wal_senders = 10

-- Create a dedicated replication user
CREATE ROLE debezium REPLICATION LOGIN PASSWORD 'from-your-secret-store';
GRANT SELECT ON TABLE outbox_events TO debezium;

-- Create the publication as the table owner (Debezium would need owner or
-- superuser rights to create it itself -- hence autocreate.mode=disabled)
CREATE PUBLICATION dbz_outbox_publication FOR TABLE outbox_events;
```

## محوّل Outbox Event Router

يوجّه تحويل الرسالة الواحدة (SMT) ‏`EventRouter` في Debezium صفوف outbox إلى مواضيع Kafka بناءً على عمود `aggregate_type`:

```
outbox_events row:
  aggregate_type = "Payment"
  aggregate_id   = "pay-123"
  event_type     = "PaymentCreated"
  payload        = { "paymentId": "pay-123", ... }

EventRouter SMT transforms this to:
  Kafka topic: payments.Payment.events
  Kafka key:   "pay-123"            ← from aggregate_id
  Kafka value: { "paymentId": "pay-123", ... }  ← from payload
  Headers:     id=<outbox row id>, aggregate_type=Payment, event_type=PaymentCreated
```

## مرة واحدة على الأقل + مستهلك idempotent = مرة واحدة بالضبط فعليًا

يضمن Debezium **التسليم مرة واحدة على الأقل** — ففي سيناريوهات الفشل (إعادة تشغيل الموصّل، تحول الوسيط)، قد تُعاد الأحداث. ويمتص نمط المستهلك idempotent التكرارات:

```java
@Component
@Slf4j
public class PaymentEventConsumer {

    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private SettlementService settlementService;

    @KafkaListener(topics = "payments.Payment.events", groupId = "settlement-consumer")
    @Transactional
    public void handlePaymentEvent(
            ConsumerRecord<String, String> record,
            @Header("event_type") String eventType,
            @Header(KafkaHeaders.RECEIVED_KEY) String aggregateId) {   // RECEIVED_MESSAGE_KEY before Spring Kafka 3.0

        String eventId = extractEventId(record);

        // Idempotency: claim the event id first (primary key) -- in the same
        // DB transaction as the business logic. A separate "exists?" check
        // would race with a concurrent duplicate delivery.
        int claimed = jdbcTemplate.update("""
            INSERT INTO processed_events (event_id, aggregate_id, processed_at)
            VALUES (?, ?, now())
            ON CONFLICT (event_id) DO NOTHING
            """, eventId, aggregateId);
        if (claimed == 0) {
            log.debug("Duplicate event {} — skipping", eventId);
            return;
        }

        switch (eventType) {
            case "PaymentCreated" -> {
                PaymentCreatedEvent event = parsePaymentCreated(record.value());
                settlementService.scheduleSettlement(event);
            }
            case "PaymentApproved" -> {
                PaymentApprovedEvent event = parsePaymentApproved(record.value());
                settlementService.executeSettlement(event);
            }
            default -> log.warn("Unknown event type: {}", eventType);
        }
    }

    private String extractEventId(ConsumerRecord<String, String> record) {
        // The EventRouter puts the outbox row id into the "id" header.
        // No fallback such as key+offset: a re-published duplicate has a
        // DIFFERENT offset, so that fallback would not detect it.
        Header idHeader = record.headers().lastHeader("id");
        if (idHeader == null) {
            throw new IllegalStateException("Outbox event without id header");
        }
        return new String(idHeader.value(), StandardCharsets.UTF_8);
    }
}
```

## استراتيجية تنظيف Outbox

دون تنظيف، ينمو جدول outbox بلا حد. استراتيجيتان:

**الاستراتيجية 1: الحذف في المعاملة نفسها (CDC فقط)**

```sql
-- Debezium reads the INSERT from the WAL, so the row may be deleted right
-- away, in the same transaction: the table stays tiny, the event is still
-- published. (The EventRouter ignores the DELETE; tombstones.on.delete=false
-- prevents tombstone records.)
BEGIN;
INSERT INTO payments (...) VALUES (...);
INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
VALUES ('6f1c...', 'Payment', 'pay-123', 'PaymentCreated', '{...}');
DELETE FROM outbox_events WHERE id = '6f1c...';
COMMIT;
-- (For a polling relay: delete rows with processed = TRUE in a job instead)
```

**الاستراتيجية 2: التنظيف الزمني (أبسط، والأشيع)**

```java
@Scheduled(cron = "0 0 2 * * *", zone = "UTC")  // sec min hour ... -> 02:00 daily
@Transactional
public void cleanupOutbox() {
    Instant cutoff = Instant.now().minus(Duration.ofDays(7));
    int deleted = outboxEventRepository.deleteByCreatedAtBefore(cutoff);
    log.info("Outbox cleanup: deleted {} rows older than 7 days", deleted);
}
```

## مراقبة تأخر Outbox

لـ **مُرحّل الاستطلاع**، عمر أقدم صف غير معالج هو المقياس الأساسي. (أما مع **CDC** فلا يُضبط علم `processed` أبدًا، فسيظل هذا المقياس ينمو للأبد — راقب الموصّل بدلًا من ذلك: مقياس التدفق `MilliSecondsBehindSource` في Debezium وتأخر فتحة النسخ في `pg_replication_slots`، انظر المسار 08 الدرس 11.)

```java
@Component
public class OutboxLagMonitor {   // polling relay

    @Autowired private OutboxEventRepository outboxRepository;
    @Autowired private MeterRegistry meterRegistry;

    @PostConstruct
    public void registerMetrics() {
        // Gauge: age of oldest unprocessed outbox event.
        // Each scrape runs a query -- keep it cheap (the partial index on
        // processed = FALSE serves it)
        Gauge.builder("outbox.lag.seconds",
                outboxRepository,
                repo -> {
                    Instant oldest = repo.findOldestUnprocessedCreatedAt();
                    if (oldest == null) return 0.0;
                    return Duration.between(oldest, Instant.now()).getSeconds();
                })
                .description("Age in seconds of the oldest unprocessed outbox event")
                .register(meterRegistry);

        // Gauge: count of unprocessed outbox events
        Gauge.builder("outbox.unprocessed.count",
                outboxRepository,
                repo -> repo.countByProcessedFalse())
                .register(meterRegistry);
    }
}
```

**قواعد التنبيه:**

```yaml
groups:
  - name: outbox-lag
    rules:
      - alert: OutboxLagHigh
        expr: outbox_lag_seconds > 30
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Outbox lag {{ $value }}s — Debezium connector may be stalled"

      - alert: OutboxLagCritical
        expr: outbox_lag_seconds > 300
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Outbox lag {{ $value }}s — payment events are not being published"
```

## مزالق الإنتاج

### المزلق 1: نسيان `wal_level=logical` على قواعد البيانات المُدارة

**المشكلة:** تعمل خدمات PostgreSQL المُدارة مثل Amazon RDS وGoogle Cloud SQL بـ `wal_level=replica` افتراضيًا. ويحتاج Debezium ‏`wal_level=logical` لفتحات النسخ المنطقي؛ ودونه يفشل الموصّل عند البدء ولا تتدفق أي أحداث.

**الإصلاح:** تأكد من أن `SHOW wal_level;` يعيد `logical` قبل النشر. وعلى Amazon RDS / Aurora اضبط `rds.logical_replication=1` في مجموعة المعاملات (تتطلب إعادة تشغيل)؛ وعلى Cloud SQL اضبط علم `cloudsql.logical_decoding`. وتحقق عبر واجهة حالة Kafka Connect و`pg_replication_slots` من أن الفتحة نشطة.

### المزلق 2: تأخر فتحة النسخ يسبب استنفاد قرص WAL

**المشكلة:** يحتفظ PostgreSQL بملفات WAL حتى يؤكد مستهلك فتحة النسخ (Debezium) أنه قرأها. فإذا توقف موصّل Debezium لساعات أو أيام (مثل إعادة تشغيل عنقود Kafka Connect)، لا تتقدم فتحة النسخ. فيراكم PostgreSQL ملفات WAL بلا حد، وقد يملأ القرص ويُسقط قاعدة البيانات.

**الإصلاح:** اضبط `max_slot_wal_keep_size` ‏(PostgreSQL 13+) كحد أمان كي تُبطل الفتحة العالقة بدل ملء القرص. وراقب WAL المحتفظ به — `pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)` من `pg_replication_slots` — ونبّه إن لم يتقدم `confirmed_flush_lsn`. وحذف الفتحة (`SELECT pg_drop_replication_slot('debezium_outbox_slot');`) يحرر WAL لكنه يضيّع كل صف outbox كُتب أثناء توقف الموصّل — فيجب إعادة نشرها حينها (مثلًا بلقطة لمرة واحدة لـ `outbox_events`)، فاعتبره خطوة تعافٍ متعمدة.

### المزلق 3: كتابة حمولات كبيرة إلى جدول Outbox

**المشكلة:** تخزين كتل ثنائية كبيرة أو JSON متداخل بعمق في عمود `payload` يسبب انتفاخ WAL (كل INSERT يُكتب في WAL). ويجعل أيضًا أحجام رسائل CDC تتجاوز حد `max.message.bytes` في Kafka ‏(1MB افتراضيًا)، فتفشل الموصّلات.

**الإصلاح:** خزّن فقط بيانات الحدث الوصفية ومرجعًا (المعرّف، والنوع، والإصدار) في حمولة outbox. ويستعيد المستهلكون البيانات الكاملة عبر جانب الاستعلام. وإن لزمت الحمولة الكاملة، زِد `max.message.bytes` في Kafka والموصّل إلى قيمة متسقة وأضف مقياس Micrometer لمتوسط حجم الحمولة.

## قائمة تحقق الإنتاج

- [ ] تأكيد `wal_level=logical` على نسخة PostgreSQL
- [ ] لجدول outbox مفتاح أساسي UUID لإزالة تكرار الأحداث
- [ ] كيان العمل وحدث outbox يُكتبان في دالة `@Transactional` نفسها
- [ ] موصّل Debezium منشور عبر عنقود Kafka Connect (لا مضمنًا)
- [ ] محوّل Outbox Event Router مُعدّ للتوجيه حسب `aggregate_type`
- [ ] موضوع Kafka لأحداث outbox بـ `cleanup.policy=delete` واحتفاظ مناسب
- [ ] المستهلك يستخدم فحص idempotency على `event_id` قبل المعالجة
- [ ] تنبيهات مقياس تأخر outbox مُعدّة: تحذير عند 30 ثانية، وحرج عند 300 ثانية
- [ ] مراقبة تأخر فتحة النسخ — تنبيه إن تجاوز نمو WAL ‏10GB
- [ ] مهمة تنظيف outbox تعمل يوميًا لمنع نمو الجدول
- [ ] التحقق من حجم الحمولة — تنبيه إن تجاوزت حمولة أي صف outbox ‏512KB
- [ ] اختبار إعادة تشغيل موصّل Debezium لتأكيد عدم فقد الأحداث أو تكرارها

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا لا تضمن الكتابة إلى قاعدة البيانات وKafka معًا داخل دالة @Transactional نفسها الذرية؟",
      "options": [
        "يغلّف @Transactional في Spring عمليات JPA فقط، لا استدعاءات KafkaTemplate",
        "تستخدم Kafka وقاعدة البيانات منسّقي معاملات منفصلين — فتراجع قاعدة البيانات لا يتراجع عن إرسال Kafka، وفشل Kafka لا يتراجع عن قاعدة البيانات",
        "ينطبق تعليق @Transactional على عمليات القراءة فقط، لا الكتابة",
        "‏KafkaTemplate.send() غير متزامن دائمًا، فيكتمل بعد التزام المعاملة"
      ],
      "correct": 1,
      "explanation": "تُدار معاملات قاعدة البيانات وعمليات الإنتاج في Kafka بأنظمة مختلفة. وحتى مع مزامنة المعاملات في Spring (الالتزام بواحدة تلو الأخرى، بأفضل جهد)، توجد نافذة بين الالتزامين: فتعطل فيها يترك أحدهما ملتزمًا والآخر لا — حدث لدفعة غير موجودة، أو دفعة لا يُرسل حدثها أبدًا. ويزيل نمط outbox هذه النافذة بجعل النشر إلى Kafka نتيجة لالتزام قاعدة البيانات، لا عملية موازية."
    },
    {
      "text": "ما دور محوّل Outbox Event Router في Debezium ضمن نمط outbox؟",
      "options": [
        "يمنع نشر الرسائل المكررة إلى Kafka",
        "يحوّل صفوف جدول outbox إلى رسائل Kafka موجّهة — مستخرجًا المفتاح من aggregate_id، والموضوع من aggregate_type، والقيمة من عمود payload",
        "ينشئ مخطط جدول outbox تلقائيًا عند أول تشغيل للموصّل",
        "يضغط حمولة outbox قبل النشر إلى Kafka"
      ],
      "correct": 1,
      "explanation": "يقرأ محوّل EventRouter كل حدث CDC (صف من outbox_events) ويحوّله إلى رسالة Kafka بالبنية الصحيحة: يصبح aggregate_id مفتاح الرسالة (فيحافظ على ارتباط القسم)، ويحدد aggregate_type الموضوع الهدف، ويصبح عمود payload قيمة الرسالة. وهذا يتجنب نشر غلاف Debezium الكامل (بنية before/after) للمستهلكين."
    },
    {
      "text": "ما المفاضلة الأساسية بين CDC ‏(Debezium) والنشر من outbox القائم على الاستطلاع؟",
      "options": [
        "يتطلب CDC تغييرات في مخطط جدول outbox؛ ولا يتطلبها الاستطلاع",
        "يوفر CDC تسليمًا شبه فوري بحمل أدنى على قاعدة البيانات؛ ويضيف الاستطلاع حملًا قائمًا على الاستعلامات وزمنًا أعلى",
        "يضمن الاستطلاع التسليم مرة واحدة بالضبط؛ ويوفر CDC مرة واحدة على الأقل فقط",
        "يعمل CDC مع أي قاعدة بيانات مُدارة؛ ويتطلب الاستطلاع الوصول إلى WAL"
      ],
      "correct": 1,
      "explanation": "يقرأ Debezium CDC سجل WAL في PostgreSQL (عملية منخفضة الكلفة يكتبها PostgreSQL أصلًا) ويسلّم الأحداث بزمن دون 100ms عادة. ويصدر الاستطلاع استعلامات SELECT وفق جدول، فيضيف حمل استعلامات على قاعدة البيانات ويُدخل زمنًا من 100ms إلى ثانية بحسب فترة الاستطلاع. ويوفر كلاهما التسليم مرة واحدة على الأقل — فالمستهلكون idempotent مطلوبون في الحالتين."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ نمط Outbox المعاملاتي مع Debezium",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "أنشئ جدول outbox_events في PostgreSQL بالحقول (id UUID، وaggregate_type، وaggregate_id، وevent_type، وpayload JSONB، وcreated_at، وprocessed). واضبط PostgreSQL بـ wal_level=logical. وأنشئ مستخدم نسخ لـ Debezium بصلاحية REPLICATION LOGIN وSELECT على outbox_events."
    },
    {
      "id": "2",
      "description": "نفّذ PaymentService بدالتي createPayment() وapprovePayment() تكتبان كيان Payment وسجل OutboxEvent معًا في دالة @Transactional واحدة. ويجب أن يحمل OutboxEvent القيم aggregate_type=Payment، وaggregate_id=paymentId، وevent_type=PaymentCreated أو PaymentApproved، وحمولة JSON تحوي كل الحقول التي يحتاجها المستهلكون."
    },
    {
      "id": "3",
      "description": "اضبط JSON لموصّل Debezium لـ PostgreSQL مع محوّل EventRouter لمراقبة جدول outbox_events، وتوجيه الرسائل إلى الموضوع payments.${routedByValue}.events باستخدام حقل aggregate_type، واستخدام aggregate_id كمفتاح رسالة Kafka، وتمرير event_type وaggregate_type كترويسات Kafka."
    },
    {
      "id": "4",
      "description": "ابنِ مستهلكًا idempotent يعالج أحداث payments.Payment.events، ويقرأ معرّف الحدث من ترويسة 'id' التي يضبطها EventRouter، ويحجزه في جدول processed_events ‏(INSERT ... ON CONFLICT DO NOTHING) ويطبق منطق العمل داخل معاملة قاعدة البيانات نفسها. واختبر بإعادة تشغيل الحدث نفسه مرتين والتحقق من تشغيل منطق العمل مرة واحدة فقط."
    }
  ]
}
-->
