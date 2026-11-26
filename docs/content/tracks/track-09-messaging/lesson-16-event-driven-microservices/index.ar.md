---
id: track-09-lesson-16
title: "الخدمات المصغّرة القائمة على الأحداث — أنماط التكامل"
slug: event-driven-microservices
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 16
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [event-driven, microservices, event-mesh, choreography, decoupling]
prerequisites: [kafka-architecture, outbox-cdc-debezium, saga-pattern]
---

# الخدمات المصغّرة المدفوعة بالأحداث — أنماط التكامل

> [!NOTE]
> التكامل المدفوع بالأحداث ليس مجرد نمط تقني — بل نمط تنظيمي. فالخدمات التي تتواصل عبر الأحداث يمكن نشرها باستقلال، وتملكها فرق مستقلة، وتتطور دون تنسيق. ولشركة تقنية مالية تعالج مئات آلاف المدفوعات يوميًا عبر عشرات الخدمات المصغّرة، هذه الاستقلالية هي الفرق بين فريق يستطيع النشر يوم الجمعة وفريق لا يستطيع النشر دون تجميد للإنتاج.

## الأنماط الثلاثة للتكامل المدفوع بالأحداث

يحدد Martin Fowler ثلاثة أنماط متمايزة، لكل منها دلالات مختلفة:

### النمط 1: إشعار الحدث

أبسط نمط — تنشر خدمة حدثًا لتُعلم الخدمات الأخرى بأن شيئًا حدث. ولا تُضمّن بيانات عدا المعرّف.

```java
// Event Notification — minimal payload
public class PaymentCreatedNotification {
    private String paymentId;    // Just the ID — receivers must fetch data if needed
    private Instant occurredAt;
}

// Consumer must call back to get payment details
@KafkaListener(topics = "payments.notifications")
public void onPaymentCreated(PaymentCreatedNotification notification) {
    // Must make a synchronous call back to payment service
    Payment payment = paymentServiceClient.getPayment(notification.getPaymentId());
    processPayment(payment);
}
```

**المشكلة:** يخلق اعتمادية متزامنة. فإذا كانت خدمة الدفع بطيئة أو متوقفة، يصبح كل المستهلكين بطيئين أو عالقين — وتتحول دفقة من الأحداث إلى دفقة من الاستدعاءات الراجعة عليها. ويبقى النمط مناسبًا حين يندر أن يحتاج المستهلكون البيانات، أو حين يجب أن يقرؤوا أحدث حالة دائمًا على أي حال.

### النمط 2: نقل الحالة المحمولة في الحدث

تحمل الأحداث كل البيانات التي يحتاجها المستهلكون. فلا يلزم استدعاء راجع.

```java
// Event-Carried State Transfer — full payload
public class PaymentCreatedEvent {
    private String paymentId;
    private String sourceAccountId;
    private String destinationAccountId;
    private BigDecimal amount;
    private String currency;
    private String status;
    private String merchantName;        // Included — eliminates merchant lookup
    private String merchantCategory;    // Included — eliminates category lookup
    private BigDecimal exchangeRate;    // Included — eliminates FX lookup
    private Instant occurredAt;
    private Map<String, String> metadata;
}

// Consumer is fully autonomous — no synchronous calls
@KafkaListener(topics = "payments.events")
public void onPaymentCreated(PaymentCreatedEvent event) {
    // Process with all data available
    settlementService.process(event);
    // No network calls to other services
}
```

**المفاضلة:** الأحداث أكبر، والبيانات مكررة (يحتفظ كل مستهلك بنسخته الخاصة، القديمة قليلًا ربما)، ويحمل عقد الحدث حقولًا أكثر يجب تطويرها بتوافق. وفي المقابل يصبح المستهلكون مستقلين — فاستخدم هذا النمط للمسارات عالية الإنتاجية حيث يهم الزمن والتوفر.

### النمط 3: Event Sourcing

الأحداث هي نظام السجل. انظر الدرس 09 للتغطية المفصلة.

## استقلالية الخدمات عبر الأحداث

هدف التصميم الأساسي أن تملك كل خدمة بياناتها وتنشر أحداثًا حين تتغير. وتحتفظ الخدمات الأخرى بنسختها الخاصة من البيانات التي تحتاجها.

```
BAD — Shared Database Anti-Pattern:
  Payment Service ──────────┐
  Settlement Service ────────┼── Shared Payments DB
  Notification Service ──────┘
  → All services coupled to same schema
  → Schema change requires all services to update
  → Single database is a bottleneck

GOOD — Event-Driven Data Ownership:
  Payment Service ──► payments.events ──┬──► Settlement Service (own DB)
                                        ├──► Notification Service (own DB)
                                        └──► Compliance Service (own DB)
  → Each service owns its read model
  → Schema changes in payment service don't break others
  → Each service scales independently
```

```java
// Payment Service — owns payment data, publishes events
@Service
public class PaymentService {

    @Autowired private PaymentRepository paymentRepository;    // Payment Service's own DB
    @Autowired private OutboxEventRepository outboxRepository; // Outbox for CDC

    @Transactional
    public Payment createPayment(CreatePaymentCommand command) {
        Payment payment = Payment.from(command);
        paymentRepository.save(payment);

        // The event is for anyone who cares — no coupling to specific consumers
        outboxRepository.save(OutboxEvent.builder()
                .aggregateId(payment.getId())
                .aggregateType("Payment")
                .eventType("PaymentCreated")
                .payload(objectMapper.writeValueAsString(PaymentCreatedEvent.from(payment)))
                .build());

        return payment;
    }
}

// Settlement Service — maintains its OWN copy of payment data via event consumption
@Service
public class SettlementPaymentProjection {

    @Autowired private SettlementPaymentRepository settlementPaymentRepo;

    @KafkaListener(topics = "payments.Payment.events", groupId = "settlement-service")
    @Transactional
    public void projectPaymentCreated(ConsumerRecord<String, String> record) {
        PaymentCreatedEvent event = parseEvent(record.value());

        // Create a local copy optimised for settlement queries
        SettlementPayment sp = SettlementPayment.builder()
                .paymentId(event.getPaymentId())
                .amount(event.getAmount())
                .currency(event.getCurrency())
                .settlementDate(calculateSettlementDate(event))
                .settlementStatus(SettlementStatus.PENDING)
                .build();

        // Idempotent: a redelivered event must not create a second row --
        // payment_id is the primary key and the insert uses ON CONFLICT DO NOTHING
        settlementPaymentRepo.insertIfAbsent(sp);
    }
}
```

## تصميم عقود الأحداث

الأحداث واجهات عامة. وكسر عقد حدث بخطورة كسر واجهة REST — فهو يفسد المستهلكين بصمت.

```java
// Event contract principles:

// 1. Include event metadata for debugging and routing
public class EventEnvelope {
    private String eventId;          // UUID — for idempotency
    private String eventType;        // "PaymentCreated" — for routing
    private String aggregateId;      // Kafka partition key
    private String aggregateType;    // "Payment" — for routing
    private int schemaVersion;       // For manual version detection
    private Instant occurredAt;      // Business time (not publish time)
    private String correlationId;    // Trace ID for distributed tracing
    private String causationId;      // The command/event that caused this
    private Object payload;
}

// 2. Use rich domain types in the payload — not primitives
public class PaymentCreatedPayload {
    private String paymentId;
    private MoneyAmount amount;      // Not BigDecimal — includes currency
    private PaymentStatus status;    // Enum — not String
    private PaymentChannel channel;  // Enum — not String
    // ...
}

public class MoneyAmount {
    private BigDecimal value;  // serialised as a STRING ("125.50"), not a JSON float
    private String currency;   // ISO 4217

    // Prevents "100 of what currency?" bugs
}
```

## تجنب اقتران الأحداث

أشيع خطأ مشاركة كائنات المجال بين الخدمات كحمولات أحداث:

```java
// WRONG — coupling services via shared domain objects
// payment-service shares its internal domain model
public class PaymentCreatedEvent {
    private Payment payment;  // THIS IS THE INTERNAL DOMAIN MODEL OF PAYMENT SERVICE
}

// Now settlement-service imports payment-service's domain classes
// → Tight coupling: a change to Payment class breaks settlement-service

// CORRECT — events are their own type, independent of domain model
public class PaymentCreatedEvent {
    // These fields are chosen for the event consumers, not copied from the domain
    private String paymentId;
    private BigDecimal amount;
    private String currency;
    private String sourceAccountId;
    private String destinationAccountId;
    private PaymentStatus status;
    private Instant createdAt;
}
```

## استراتيجية ترقيم إصدارات الأحداث

تُنشر الأحداث باستمرار. ويجب أن يظل المستهلكون القدامى يعملون حين يُنشر إصدار جديد. انظر الدرس 07 لتفاصيل Schema Registry. وهنا، الاستراتيجية على مستوى التطبيق:

```java
// Strategy 1: Version in event type name
public class PaymentCreatedV2Event {
    // New version — old consumers still subscribe to PaymentCreated (v1)
    // Both versions published simultaneously during migration
}

// Strategy 2: Version field in envelope (more flexible)
public class PaymentCreatedEvent {
    private int version;  // 1, 2, 3...
    // Consumers handle multiple versions with a switch
}

// Consumer handling multiple versions:
@KafkaListener(topics = "payments.events")
public void handlePaymentCreated(ConsumerRecord<String, String> record) {
    JsonNode json = objectMapper.readTree(record.value());
    // path() instead of get(): no NullPointerException when the field is
    // missing -- old v1 events had no version field
    int version = json.path("version").asInt(1);

    PaymentCreatedEvent event = switch (version) {
        case 1 -> parseV1(json);
        case 2 -> parseV2(json);
        // Unknown (newer) version: do NOT guess -- for payments a wrong guess
        // silently corrupts data. Fail the record so it goes to the DLT and
        // the consumer is upgraded.
        default -> throw new UnsupportedEventVersionException(version);
    };

    processPaymentCreated(event);
}
```

## تصحيح الأنظمة المدفوعة بالأحداث — التتبع الموزع

حين يطلق حدث دفع 10 إجراءات في خدمات لاحقة ويفشل أحدها، يتطلب إيجاد السبب الجذري تتبعًا موزعًا. ومع Spring Boot 3 وMicrometer Tracing، تفعيل المراقبة على `KafkaTemplate` وحاويات المستمعين (`spring.kafka.template.observation-enabled=true`، و`spring.kafka.listener.observation-enabled=true`) ينشر سياق التتبع عبر ترويسات Kafka تلقائيًا. وتُظهر شيفرة OpenTelemetry اليدوية أدناه ما يحدث تحت الغطاء:

```java
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapPropagator;

// Producer: inject trace context into Kafka headers
@Service
public class TracedEventPublisher {

    @Autowired private Tracer tracer;
    @Autowired private TextMapPropagator propagator;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    public void publishWithTrace(String topic, String key, String payload) {
        ProducerRecord<String, String> record = new ProducerRecord<>(topic, key, payload);

        // Inject current trace context into Kafka headers
        propagator.inject(Context.current(), record.headers(), (headers, name, value) ->
                headers.add(name, value.getBytes(StandardCharsets.UTF_8)));

        kafkaTemplate.send(record);
    }
}

// Consumer: extract trace context from Kafka headers
@KafkaListener(topics = "payments.events")
public void processPaymentEvent(ConsumerRecord<String, String> record) {
    // Extract trace context from headers
    Context extractedContext = propagator.extract(Context.current(), record.headers(),
            (headers, name) -> {
                Header header = headers.lastHeader(name);
                return header == null ? null : new String(header.value(), StandardCharsets.UTF_8);
            });

    // Start a child span in the extracted context
    Span span = tracer.spanBuilder("processPaymentEvent")
            .setParent(extractedContext)
            .startSpan();

    try (var scope = span.makeCurrent()) {
        span.setAttribute("payment.topic", record.topic());
        span.setAttribute("payment.partition", record.partition());
        span.setAttribute("payment.offset", record.offset());
        span.setAttribute("payment.key", record.key());

        // Process the event
        PaymentCreatedEvent event = parseEvent(record.value());
        settlementService.process(event);

    } catch (Exception e) {
        span.recordException(e);
        throw e;
    } finally {
        span.end();
    }
}
```

## مراقبة تدفقات الأحداث

```java
import io.micrometer.core.instrument.*;

@Component
public class EventFlowMonitor {

    @Autowired private MeterRegistry meterRegistry;

    // Track events by type and service
    public void recordEventPublished(String eventType, String topic) {
        Counter.builder("kafka.events.published")
                .tag("event_type", eventType)
                .tag("topic", topic)
                .register(meterRegistry)
                .increment();
    }

    public void recordEventConsumed(String eventType, String topic,
            String consumerGroup, Duration processingTime) {
        Counter.builder("kafka.events.consumed")
                .tag("event_type", eventType)
                .tag("topic", topic)
                .tag("consumer_group", consumerGroup)
                .register(meterRegistry)
                .increment();

        Timer.builder("kafka.events.processing.duration")
                .tag("event_type", eventType)
                .tag("consumer_group", consumerGroup)
                .register(meterRegistry)
                .record(processingTime);
    }

    public void recordEventProcessingError(String eventType, String topic,
            String consumerGroup, String errorClass) {
        Counter.builder("kafka.events.errors")
                .tag("event_type", eventType)
                .tag("topic", topic)
                .tag("consumer_group", consumerGroup)
                .tag("error_class", errorClass)
                .register(meterRegistry)
                .increment();
    }
}
```

## بنية خدمة الدفع المدفوعة بالأحداث

بنية كاملة لخدمة دفع مدفوعة بالأحداث:

```
External Systems          Payment Service            Internal Events
                        ┌─────────────────┐
Client API ────cmd─────►│ Command Handler │──► payment.created
                        │                 │──► payment.approved
                        │  Outbox Pattern │──► payment.rejected
                        │  (Lesson 06)    │──► payment.settled
                        └────────┬────────┘
                                 │ WAL
                                 ▼
                           Debezium CDC
                                 │
                                 ▼
              ┌──────────────────────────────────────────────────────┐
              │                payments.events topic                 │
              └────┬───────────────┬──────────────┬─────────────────┘
                   │               │              │
                   ▼               ▼              ▼
           Settlement Service  Notification   Compliance Service
           (Lesson 10 CQRS)    Service        (append-only audit)
           PostgreSQL read      Redis cache    S3 archival
           model               push notif      (Lesson 08 Connect)

Cross-cutting concerns:
  - Schema Registry (Lesson 07)
  - Distributed tracing (OpenTelemetry)
  - Consumer lag monitoring (Lesson 17)
  - DLQ handling (Lesson 11)
  - Kafka security (Lesson 12)
```

## الخلاصات الأساسية

- يخلق إشعار الحدث (أحداث صغيرة، والمستهلكون يجلبون البيانات) اعتماديات متزامنة — تجنبه للمسارات عالية الإنتاجية.
- يتيح نقل الحالة المحمولة في الحدث (الأحداث تحوي كل البيانات اللازمة) استقلالية حقيقية للخدمات مقابل حمولات أحداث أكبر.
- لا تشارك أبدًا أصناف نموذج المجال الداخلي كحمولات أحداث — فالأحداث عقود عامة بتسلسل أنواعها الخاص.
- تملك كل خدمة بياناتها — ويحتفظ المستهلكون بنماذج قراءتهم الخاصة من الأحداث، ولا يستعلمون أبدًا قاعدة بيانات الناشر.
- التتبع الموزع (OpenTelemetry) أساسي لتصحيح الأنظمة المدفوعة بالأحداث — احقن سياق التتبع وانشره في ترويسات Kafka.
- يتطلب ترقيم إصدارات الأحداث استراتيجية: الترقيم في اسم النوع أو في حقل الإصدار؛ ويجب أن يتعامل المستهلكون مع إصدارات متعددة.
- تتطلب الصحة التشغيلية لبنية مدفوعة بالأحداث مقاييس تدفق الأحداث: أعداد المنشور، وأعداد المستهلك، ومدة المعالجة، ومعدلات الأخطاء لكل نوع حدث.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما العيب الأساسي لنمط إشعار الحدث مقارنة بنقل الحالة المحمولة في الحدث؟",
      "options": [
        "ينتج إشعار الحدث حمولات أكبر تبطئ Kafka",
        "يتطلب إشعار الحدث أن يستدعي المستهلكون واجهة الناشر، فيخلق اعتماديات متزامنة",
        "لا يمكن استخدام إشعار الحدث مع Schema Registry",
        "لا يدعم إشعار الحدث مستهلكين متعددين"
      ],
      "correct": 1,
      "explanation": "يحتوي إشعار الحدث مرجعًا فقط ('أُنشئت الدفعة X') ويجب أن يستدعي المستهلكون واجهة الناشر لجلب البيانات. وهذا يخلق اعتمادية متزامنة — فإذا كانت واجهة الناشر متوقفة، لا يستطيع المستهلكون معالجة الحدث. أما نقل الحالة المحمولة في الحدث فيضمّن كل البيانات اللازمة في الحدث، فيتيح استقلالية حقيقية للخدمات."
    },
    {
      "text": "لماذا يجب ألا تُستخدم أصناف نموذج المجال الداخلي مباشرة كحمولات أحداث Kafka أبدًا؟",
      "options": [
        "أصناف نموذج المجال أكبر من أن تُسلسل بكفاءة",
        "تتغير أصناف نموذج المجال كثيرًا، ومشاركتها تربط المستهلكين بالتنفيذ الداخلي للناشر",
        "لا يمكن تسلسل أصناف نموذج المجال بـ Avro",
        "أصناف نموذج المجال محمية بقواعد الملكية الفكرية"
      ],
      "correct": 1,
      "explanation": "الأحداث عقود عامة. فإذا شاركت صنف المجال Payment كحمولة حدث، فإن كل تغيير في ذلك الصنف — إضافة حقول داخلية، أو إعادة هيكلة، أو إعادة تسمية — يكسر كل المستهلكين. ويجب أن تكون الأحداث أنواعًا منفصلة مصممة لمستهلكيها، بحقول مختارة لاحتياجات المستهلكين، لا منسوخة من نماذج المجال الداخلية."
    },
    {
      "text": "ما الغرض من حقن سياق تتبع OpenTelemetry في ترويسات رسائل Kafka؟",
      "options": [
        "تحسين أداء توجيه رسائل Kafka",
        "تمكين التتبع الموزع عبر حدود الخدمات كي يمكن تتبع حدث دفع واحد عبر كل الخدمات اللاحقة",
        "تلبية متطلبات التحقق من المخططات في Schema Registry",
        "تمكين إزالة تكرار الرسائل عبر معرّفات تتبع فريدة"
      ],
      "correct": 1,
      "explanation": "دون نشر سياق التتبع، ينتج حدث دفع يطلق إجراءات في 10 خدمات 10 امتدادات تتبع غير مترابطة. وبحقن سياق التتبع في ترويسات Kafka عند المنتج واستخراجه عند كل مستهلك، ترتبط كل الامتدادات اللاحقة تحت التتبع الجذري نفسه — فيتيح رؤية من الطرف إلى الطرف للتصحيح."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء خدمة دفع مدفوعة بالأحداث منفصلة تمامًا",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "صمم PaymentCreatedEvent كنوع مستقل (لا يشارك صنف المجال Payment) بحقول مختارة لاحتياجات المستهلكين. ونفّذ ترقيم إصدارات الأحداث باستخدام حقل 'version' عددي صحيح، واكتب مستهلكًا يتعامل مع حمولات v1 وv2 باستخدام عبارة switch."},
    {"id": "2", "description": "نفّذ TracedEventPublisher يحقن سياق تتبع OpenTelemetry في ترويسات رسائل Kafka باستخدام ناشر W3C TraceContext. ونفّذ مستهلكًا مقابلًا يستخرج سياق التتبع من الترويسات ويبدأ امتدادًا فرعيًا، مع تسجيل الموضوع، والقسم، والإزاحة، ومفتاح الدفعة كسمات للامتداد."},
    {"id": "3", "description": "ابنِ EventFlowMonitor باستخدام عدادات Micrometer ومؤقتاته يتتبع kafka.events.published (حسب eventType، وtopic)، وkafka.events.consumed (حسب eventType، وconsumerGroup)، وkafka.events.processing.duration (مدرج تكراري)، وkafka.events.errors (حسب eventType، وerrorClass). واكشفها كمقاييس Prometheus."},
    {"id": "4", "description": "نفّذ البنية المدفوعة بالأحداث الكاملة لخدمة الدفع: يستخدم معالج أوامر الدفع نمط outbox لنشر الأحداث، وينشر Debezium CDC إلى Kafka، وتستهلك ثلاث مجموعات مستهلكين مستقلة (settlement-projection، وnotification-service، وcompliance-archival) موضوع 'payments.events' نفسه دون حالة مشتركة بينها."}
  ]
}
-->
