---
id: track-09-lesson-19
title: "RabbitMQ أم Kafka — اختيار الوسيط المناسب"
slug: rabbitmq-vs-kafka
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [RabbitMQ, Kafka, comparison, queue, log]
prerequisites: [kafka-architecture]
---

# ‏RabbitMQ مقابل Kafka — اختيار الوسيط الصحيح

> [!NOTE]
> ‏Kafka وRabbitMQ كلاهما وسيط رسائل ممتاز، لكنهما يحلان مشكلات مختلفة. والاختيار الخاطئ يسبب احتكاكًا معماريًا لسنوات. واستخدام Kafka لطوابير المهام وRabbitMQ لتدفق الأحداث خطآن شائعان ومؤلمان. ويبني هذا الدرس النموذج الذهني للاختيار الصحيح ولتصميم بنى هجينة حين يلزم الاثنان فعلًا.

## الفرق المعماري الجوهري

الفرق الأساسي ليس في الأداء أو الميزات — بل في **نموذج البيانات**:

```
RabbitMQ — Queue/Push Model:
  Message ──► Queue ──► Consumer
  - Message deleted after consumption (acknowledged and gone)
  - Broker pushes messages to consumers (consumers are passive)
  - Multiple consumers on one queue compete for messages (round-robin)
  - No replay — message is gone after processing

Kafka — Log/Pull Model:
  Record ──► Partition (append-only log)
  Consumer reads from log at its own position
  - Record retained for a configurable period (default: 7 days)
  - Consumers pull from the log (consumers are active)
  - Multiple consumer groups each read ALL messages independently
  - Full replay from offset 0 to the present
```

هذا الفرق في الاحتفاظ هو العامل الحاسم في أغلب القرارات المعمارية:

| السؤال | الإجابة ← استخدم |
|---------|-------------|
| هل أحتاج قدرة إعادة التشغيل؟ | نعم ← Kafka |
| هل تحتاج خدمات متعددة الرسائل نفسها؟ | نعم ← Kafka |
| هل هذا طابور مهام (توزيع عمل)؟ | نعم ← RabbitMQ |
| هل أحتاج توجيهًا معقدًا (direct، وfanout، وtopic، وheaders)؟ | نعم ← RabbitMQ |
| هل أحتاج تأكيد تسليم على مستوى كل مهمة؟ | نعم ← RabbitMQ |
| هل أحتاج إنتاجية عالية جدًا على تدفق واحد (مئات آلاف الرسائل في الثانية فأكثر)؟ | نعم ← Kafka |
| هل أحتاج مدة صلاحية (TTL) لكل رسالة؟ | نعم ← RabbitMQ |
| هل أحتاج أولويات للرسائل أو نمط طلب-رد؟ | نعم ← RabbitMQ |

للمدفوعات، عرّف طوابير RabbitMQ كـ **طوابير نصاب (quorum queues)** ‏(`x-queue-type: quorum`، منسوخة بـ Raft). فالطوابير المرآوية الكلاسيكية أُهملت ثم أُزيلت في RabbitMQ 4.0، والطابور الكلاسيكي دون نسخ يفقد رسائله حين تُفقد عقدته.

## مبادلات RabbitMQ والتوجيه

نموذج التوجيه في RabbitMQ أكثر مرونة بكثير من Kafka على مستوى الرسالة:

```
Producer ──► Exchange ──► Binding ──► Queue ──► Consumer

Exchange Types:
  Direct:  Route by exact routing key match
  Topic:   Route by pattern matching (payments.*, *.settled)
  Fanout:  Route to ALL bound queues (broadcast)
  Headers: Route by message header attributes
```

```java
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.core.*;
import org.springframework.stereotype.Service;

@Configuration
public class RabbitMQConfig {

    // Direct exchange — route by exact routing key
    @Bean
    public DirectExchange paymentsExchange() {
        return new DirectExchange("payments.exchange", true, false);
    }

    // Queue per consumer service
    @Bean
    public Queue settlementQueue() {
        return QueueBuilder.durable("payments.settlement")
                .quorum()                                       // replicated (Raft)
                .withArgument("x-delivery-limit", 5)            // poison message -> DLX after 5 redeliveries
                .withArgument("x-message-ttl", 3600000)         // 1 hour TTL -> then DLX
                .withArgument("x-dead-letter-exchange", "payments.dlx")
                .withArgument("x-dead-letter-routing-key", "settlement.dlq")
                .build();
    }

    @Bean
    public Queue notificationQueue() {
        return QueueBuilder.durable("payments.notification")
                .quorum()
                .withArgument("x-message-ttl", 1800000)  // 30 min TTL -- no DLX: an
                .build();                                 // expired notification is dropped (acceptable here)
    }

    // Bindings: exchange routes by routing key
    @Bean
    public Binding settlementBinding(Queue settlementQueue, DirectExchange paymentsExchange) {
        return BindingBuilder.bind(settlementQueue)
                .to(paymentsExchange)
                .with("payment.created"); // routing key
    }

    @Bean
    public Binding notificationBinding(Queue notificationQueue,
            DirectExchange paymentsExchange) {
        return BindingBuilder.bind(notificationQueue)
                .to(paymentsExchange)
                .with("payment.created");
    }
}

@Service
public class PaymentEventPublisher {

    // RabbitTemplate configured with publisher confirms
    // (spring.rabbitmq.publisher-confirm-type=correlated) and returns
    // (mandatory=true): without them a message lost on the way or routed to
    // no queue disappears silently
    @Autowired private RabbitTemplate rabbitTemplate;

    public void publishPaymentCreated(Payment payment) {
        rabbitTemplate.convertAndSend(
                "payments.exchange",
                "payment.created",    // routing key
                PaymentCreatedEvent.from(payment),
                message -> {
                    message.getMessageProperties().setMessageId(payment.getId());
                    message.getMessageProperties().setContentType("application/json");
                    return message;
                }
        );
    }
}
```

## مستهلك RabbitMQ (المستهلكون المتنافسون)

```java
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

@Component
public class PaymentSettlementConsumer {

    @Autowired private SettlementService settlementService;

    // Multiple instances of this service compete for messages from the queue
    // RabbitMQ distributes messages in round-robin: each message processed ONCE
    @RabbitListener(queues = "payments.settlement",
                    concurrency = "2-5",   // 2 to 5 concurrent threads
                    ackMode = "MANUAL")
    public void processSettlement(Message message, Channel channel) throws Exception {
        long deliveryTag = message.getMessageProperties().getDeliveryTag();

        try {
            PaymentCreatedEvent event = parseEvent(message.getBody());
            settlementService.process(event);

            // ACK: remove from queue — message is gone
            channel.basicAck(deliveryTag, false);

        } catch (BusinessException e) {
            // NACK with requeue=false → goes to dead letter exchange
            channel.basicNack(deliveryTag, false, false);
        } catch (TransientException e) {
            // NACK with requeue=true → back to the queue for retry. Careful:
            // redelivery is immediate (a tight retry loop) -- the quorum
            // queue's x-delivery-limit stops it after 5 attempts and
            // dead-letters the message; for delayed retries use a retry
            // queue with TTL that dead-letters back to the main queue.
            channel.basicNack(deliveryTag, false, true);
        } catch (Exception e) {
            // Anything unexpected: never leave a message un-acked
            channel.basicNack(deliveryTag, false, false);
        }
    }
}
```

## مبادلات الرسائل الميتة في RabbitMQ

تؤدي مبادلة الرسائل الميتة (DLX) في RabbitMQ دور DLQ/DLT في Kafka — لكنها مدمجة في الوسيط: فالرسائل المرفوضة، ومنتهية الصلاحية، والمتجاوزة لحد التسليم تُوجَّه إليها تلقائيًا، بينما في Kafka ينشر تطبيق المستهلك بنفسه إلى DLT:

```java
@Configuration
public class RabbitMQDlxConfig {

    @Bean
    public DirectExchange deadLetterExchange() {
        return new DirectExchange("payments.dlx");
    }

    @Bean
    public Queue settlementDlq() {
        return QueueBuilder.durable("payments.settlement.dlq").build();
    }

    @Bean
    public Binding dlqBinding(Queue settlementDlq, DirectExchange deadLetterExchange) {
        return BindingBuilder.bind(settlementDlq)
                .to(deadLetterExchange)
                .with("settlement.dlq");
    }
}
```

## ‏RabbitMQ Streams لإعادة التشغيل

تحذف طوابير RabbitMQ الكلاسيكية الرسائل بعد استهلاكها. وتضيف **RabbitMQ Streams** (منذ 3.9) تخزينًا قائمًا على السجل مع إعادة التشغيل؛ وتقسّم *super streams* ‏(3.11+) التدفق كموضوع Kafka:

```java
import com.rabbitmq.stream.*;

@Configuration
public class RabbitMQStreamConfig {

    @Bean
    public Environment rabbitStreamEnvironment() {
        return Environment.builder()
                .host("rabbitmq")
                .username(streamUser)          // from configuration / secret store,
                .password(streamPassword)      // never hard-coded
                .build();
    }
}

@Service
public class PaymentStreamPublisher {

    @Autowired private Environment streamEnv;
    private Producer producer;

    @PostConstruct
    public void setup() {
        streamEnv.streamCreator()
                .stream("payments-stream")
                .maxLengthBytes(ByteCapacity.GB(50))  // Keep 50GB of history
                .maxAge(Duration.ofDays(30))            // Or 30 days
                .create();
        // ONE long-lived producer -- not a new one (and a leaked connection)
        // per message
        producer = streamEnv.producerBuilder()
                .stream("payments-stream")
                .build();
    }

    @PreDestroy
    public void close() { producer.close(); }

    public void publish(PaymentCreatedEvent event) {
        producer.send(
                producer.messageBuilder()
                        .addData(event.toJson().getBytes())
                        .properties().messageId(event.getPaymentId()).messageBuilder()
                        .build(),
                confirmationStatus -> {
                    if (!confirmationStatus.isConfirmed()) {
                        // logging alone loses the event -- retry or keep it
                        // in an outbox until confirmed
                        log.error("Stream publish failed for payment {}", event.getPaymentId());
                    }
                }
        );
    }
}
```

تسد RabbitMQ Streams الفجوة مع Kafka في حالات إعادة التشغيل، لكن Kafka يبقى أنضج للتدفق عالي الإنتاجية على نطاق واسع.

## مقارنة الإنتاجية

قيم تقريبية لمراتب الحجم فقط — فالأرقام الحقيقية تعتمد بشدة على حجم الرسالة، والحفظ الدائم، والنسخ، والعتاد، فاختبر عبء عملك أنت:

| المقياس | RabbitMQ | Kafka |
|--------|---------|-------|
| الإنتاجية لكل طابور / قسم | عشرات آلاف الرسائل/ثانية لكل طابور (نصاب)؛ والتدفقات أعلى بكثير | عالية لكل قسم؛ ويتوسع العنقود إلى ملايين الرسائل/ثانية |
| الزمن | أجزاء قليلة من الملي ثانية عند حمل معتدل | ملي ثانية قليلة مع `linger.ms` صغير؛ والتجميع يبادل الزمن بالإنتاجية |
| التوسع | طوابير أكثر موزعة على عقد العنقود؛ وsuper streams | أفقي (أقسام) |
| حجم الرسالة | الأفضل للرسائل الصغيرة (كيلوبايتات) | الأفضل للرسائل الصغيرة؛ والحد الافتراضي 1MB قابل للضبط |
| نوع المستهلك | دفع (يبادر الوسيط، ويحدّه prefetch) | سحب (يبادر المستهلك) |

يعالج طابور RabbitMQ الواحد عملية Erlang واحدة — فوسّع بتوزيع العمل على طوابير كثيرة. وتكبر ميزة Kafka مع الحجم العالي جدًا والمستمر ومع كثرة المستهلكين المستقلين للبيانات نفسها.

## مقارنة ضمانات الترتيب

| السيناريو | RabbitMQ | Kafka |
|----------|---------|-------|
| طابور / قسم واحد، مستهلك واحد | FIFO (لكن الرسالة المعادة للطابور تُسلَّم خارج الترتيب) | FIFO صارم |
| طابور واحد، مستهلكون متنافسون | لا ترتيب بين المستهلكين | لا ينطبق — مستهلك واحد لكل قسم في المجموعة |
| الترتيب لكل حساب | مبادلة التجزئة المتسقة + مستهلك نشط واحد لكل طابور، أو super streams | تلقائي (تقسيم بالمفتاح) |
| الترتيب الشامل | طابور واحد (عنق زجاجة) | قسم واحد (عنق زجاجة) |
| داخل مجموعة المستهلكين | FIFO لكل طابور | FIFO لكل قسم |

للترتيب لكل كيان (لكل حساب، لكل دفعة)، آلية مفتاح القسم في Kafka مدمجة وأبسط من مقابلاتها في RabbitMQ.

## البنية الهجينة في التقنية المالية

كثيرًا ما تحتاج الأنظمة المالية الحقيقية الاثنين:

```
Payment Platform Architecture — Hybrid

[Kafka] — Event Streaming Layer:
  payments.events ──► Settlement Service
  payments.events ──► Compliance Service (Lesson 08: S3 archival)
  payments.events ──► Analytics Service
  account.events  ──► Read model projections
  → Replay, long retention, multiple consumers, event sourcing

[RabbitMQ] — Task Queue Layer:
  fraud.checks.queue  ──► Fraud Check Worker (pool)
  email.queue         ──► Email Service (competing consumers)
  sms.queue           ──► SMS Service (competing consumers)
  pdf.generation.queue ──► Statement Generator (pool)
  → Point-to-point task distribution, complex routing, per-message TTL
```

```java
// Payment flow using both brokers -- WITHOUT dual writes.
// Sending to Kafka and RabbitMQ inside a DB transaction is the dual-write
// bug: if the transaction rolls back, the messages are already out; if a
// send fails after commit, they are lost. Write outbox rows instead.
@Service
public class PaymentCoordinator {

    @Autowired private PaymentRepository paymentRepo;
    @Autowired private OutboxRepository outbox;

    @Transactional
    public void processPayment(Payment payment) {
        paymentRepo.save(payment);

        // 1. Domain event -> relayed to Kafka (payments.events, key = paymentId)
        //    for event-driven consumers (CDC / outbox relay, Lesson 06)
        outbox.save(OutboxRecord.kafka("payments.events", payment.getId(),
                PaymentCreatedEvent.from(payment).toJson()));

        // 2. Fraud check task -> relayed to RabbitMQ (fraud.exchange / fraud.check)
        //    for the competing-consumer worker pool
        outbox.save(OutboxRecord.rabbit("fraud.exchange", "fraud.check",
                FraudCheckTask.from(payment).toJson()));
    }
}
// The relay sends each row (with publisher confirms for RabbitMQ), marks it
// sent, and retries otherwise -- consumers must be idempotent (at-least-once).
// Alternative: publish only to Kafka and let a small bridge consumer create
// the RabbitMQ task.
```

## إطار القرار

```
When to use Kafka:
  ✓ Multiple services need the same events
  ✓ Replay capability required (audit, debugging, new service bootstrap)
  ✓ Event sourcing architecture
  ✓ Stream processing (Kafka Streams, Flink)
  ✓ Long event retention required
  ✓ High throughput (>50k msg/s)
  ✓ Consumer groups with independent offsets
  ✓ Exactly-once read-process-write between Kafka topics (transactions)

When to use RabbitMQ:
  ✓ Task queue semantics (one consumer handles each task)
  ✓ Complex routing (direct, topic, fanout, headers)
  ✓ Per-message TTL required
  ✓ Request-reply pattern (RPC)
  ✓ Moderate volume where task semantics matter more than replay
  ✓ Teams familiar with AMQP but not Kafka
  ✓ Message priorities needed
  ✓ Mature dead letter exchange patterns needed

When to use both:
  ✓ Payment processing platform:
      Kafka for event streaming + RabbitMQ for task queues
  ✓ Large enterprise platform where some teams are on RabbitMQ
      and migrating to Kafka incrementally
  ✓ Microservices that need event replay (Kafka) AND
      point-to-point task distribution (RabbitMQ)
```

ملاحظة: يضيف Kafka 4.x **مجموعات المشاركة (share groups)** ‏("طوابير لـ Kafka"، KIP-932 — وصول مبكر في 4.0، ومعاينة في 4.1): يتشارك المستهلكون القسم ويؤكدون السجلات واحدًا واحدًا، فتقترب من دلالات الطوابير. تحقق من حالتها في إصدار Kafka لديك قبل الاعتماد عليها؛ وحاليًا يبقى RabbitMQ الخيار الناضج لطوابير المهام.

## الخلاصات الأساسية

- ‏RabbitMQ **طابور** (تُحذف الرسالة بعد ACK)؛ وKafka **سجل** (تُحفظ الرسالة بغض النظر عن الاستهلاك).
- نموذج التوجيه بالمبادلات والروابط في RabbitMQ أكثر مرونة للتوجيه لكل رسالة من نهج مفتاح القسم في Kafka.
- يتوسع Kafka أفقيًا إلى ملايين الرسائل في الثانية لكل عنقود؛ أما طابور RabbitMQ الواحد فمحدود بعملية عقدة واحدة، فيتوسع RabbitMQ باستخدام طوابير (أو تدفقات) كثيرة.
- استخدم **طوابير النصاب** لطوابير مدفوعات RabbitMQ، مع تأكيدات الناشر وحد للتسليم.
- تضيف RabbitMQ Streams قدرة إعادة التشغيل إلى RabbitMQ، لكن Kafka يبقى أنضج للتدفق عالي الإنتاجية.
- للترتيب لكل كيان (لكل حساب)، مفتاح القسم في Kafka أكثر طبيعية من طابور لكل كيان في RabbitMQ.
- البنى الهجينة شائعة في التقنية المالية: Kafka لتدفق الأحداث + RabbitMQ لطوابير المهام.
- السؤال الحاسم ليس الإنتاجية بل **الدلالات**: هل تمثل الرسالة حدثًا (استخدم Kafka) أم مهمة (فكّر في RabbitMQ)؟

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يحتاج فريق الامتثال لضم خدمة تدقيق جديدة بعد 6 أشهر من إطلاق نظام الدفع. وتحتاج خدمة التدقيق إعادة تشغيل كل أحداث الدفع التاريخية من البداية. أي بنية وسيط تدعم هذا المتطلب؟",
      "options": [
        "طوابير RabbitMQ الكلاسيكية — يمكن للمستهلك الجديد إعادة الرسائل إلى الطابور",
        "‏Kafka — يحتفظ السجل بكل الرسائل لفترة الاحتفاظ المضبوطة (أو بلا حد مع ضغط السجل)، فيتيح إعادة التشغيل من الإزاحة 0",
        "‏RabbitMQ بطابور منفصل لكل مستهلك — ستوجّه المبادلة نسخًا من كل الرسائل المستقبلية إلى الطابور الجديد",
        "أي من الوسيطين — كلاهما يدعم إزاحات مستقلة للمستهلكين"
      ],
      "correct": 1,
      "explanation": "تحذف طوابير RabbitMQ الكلاسيكية الرسائل بعد التأكيد — فبمجرد استهلاك الرسالة تختفي. والمستهلك الجديد الذي ينضم لاحقًا لا يتلقى إلا الرسائل المستقبلية، لا الماضية. أما Kafka فيحتفظ بكل السجلات في سجل القسم بغض النظر عن الاستهلاك (حتى تزيلها سياسة الاحتفاظ). ويمكن للمستهلك الجديد ضبط إزاحته على 0 (الأقدم) وإعادة تشغيل كل الأحداث التاريخية. وهذا هو الفرق المعماري الجوهري: Kafka سجل، وRabbitMQ طابور."
    },
    {
      "text": "يحتاج نظام كشف الاحتيال أن تُعالج كل دفعة بعامل فحص احتيال واحد فقط من مجموعة من 10 عمال. أي وسيط ونمط هو الأنسب؟",
      "options": [
        "‏Kafka بـ 10 مستهلكين في مجموعة مستهلكين واحدة — يُعيَّن كل قسم لمستهلك واحد",
        "‏RabbitMQ بطابور واحد و10 مستهلكين متنافسين — يوزع RabbitMQ الرسائل بالتناوب فتُعالج كل رسالة بعامل واحد بالضبط",
        "‏Kafka بـ 10 مجموعات مستهلكين منفصلة — تحصل كل مجموعة على نسخة من كل رسالة",
        "مبادلة fanout في RabbitMQ — تبث إلى العمال العشرة في وقت واحد"
      ],
      "correct": 1,
      "explanation": "هذا نمط طابور مهام: مهمة واحدة (فحص احتيال) لكل رسالة، يتولاها عامل واحد. ونموذج المستهلكين المتنافسين في RabbitMQ مناسب بطبيعته — فعدة مستهلكين على الطابور نفسه يتنافسون، ويسلّم الوسيط كل رسالة لمستهلك واحد في كل مرة (وإذا مات عامل قبل ACK، تُعاد الرسالة لآخر، فيجب أن يكون الفحص متساوي القوة). وتوزع مجموعات مستهلكي Kafka العمل أيضًا، لكن لكل قسم فقط، فيُحدّ التوازي بعدد الأقسام وتحجب مهمة بطيئة قسمها؛ وKafka أنسب حين تحتاج خدمات مستقلة متعددة الأحداث نفسها. أما مبادلة fanout فسترسل فحص الاحتيال إلى كل العمال، فتسبب معالجة مكررة."
    },
    {
      "text": "في بنية هجينة (Kafka لتدفق الأحداث + RabbitMQ لطوابير المهام)، يُنشر PaymentCreatedEvent إلى الوسيطين. ما نية التصميم الصحيحة؟",
      "options": [
        "يذهب الحدث نفسه إلى الوسيطين لتوفير التكرار في حال فشل أحدهما",
        "يتلقى Kafka حدث المجال لإعادة التشغيل والتدقيق والمستهلكين المستقلين المتعددين (التسوية، والامتثال، والتحليلات)؛ ويتلقى RabbitMQ رسالة مهمة لتوزيع العمل من نقطة إلى نقطة (مجموعة عمال فحص الاحتيال، وإشعار البريد الإلكتروني)",
        "‏Kafka وRabbitMQ مرآتان لبعضهما — فالرسائل في أحدهما تُنسخ تلقائيًا إلى الآخر",
        "‏RabbitMQ هو الوسيط الأساسي؛ ويُستخدم Kafka احتياطيًا فقط حين يمتلئ طابور RabbitMQ"
      ],
      "correct": 1,
      "explanation": "في بنية هجينة جيدة التصميم، يؤدي الوسيطان أدوارًا دلالية مختلفة. يخزن Kafka سجل أحداث المجال — فتقرأ مجموعات مستهلكين مستقلة متعددة (التسوية، والامتثال، والتحليلات) كل الأحداث باستقلال مع قدرة إعادة التشغيل. ويتولى RabbitMQ توزيع المهام — فتُرسل مهمة فحص الاحتيال لعامل واحد من المجموعة (مستهلكون متنافسون)، وتذهب مهمة إشعار البريد إلى خدمة البريد. والوسيطان ليسا مرآتين ولا احتياطًا لبعضهما؛ بل يحلان مشكلات مختلفة في الوقت نفسه."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "بنية معالجة مدفوعات هجينة بـ Kafka وRabbitMQ",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    "نفّذ PaymentCoordinator يحفظ، داخل دالة @Transactional واحدة، الدفعة ويكتب صفّي outbox: حدث PaymentCreatedEvent لـ Kafka (موضوع payments.events، والمفتاح=paymentId) ومهمة FraudCheckTask لـ RabbitMQ (مفتاح التوجيه fraud.check). ونفّذ المُرحِّل الذي يرسلهما (مع تأكيدات الناشر لـ RabbitMQ) ويعلّمهما كمرسلين — دون استدعاءات مباشرة للوسطاء داخل المعاملة.",
    "اضبط مبادلة direct في RabbitMQ ‏(payments.exchange) بطابوري نصاب مربوطين: payments.settlement (مفتاح الربط: payment.created) وpayments.notification (مفتاح الربط: payment.created). ونفّذ مستهلكين متنافسين على payments.settlement بـ concurrency=3 وتأكيد يدوي. وتحقق من أن كل رسالة تُعالج بنسخة مستهلك واحدة بالضبط باستخدام عدّاد مشترك بين خيوط المستهلكين.",
    "أعدّ مبادلة رسائل ميتة في RabbitMQ ‏(payments.dlx) لطابور التسوية. واضبط x-message-ttl=3600000 وx-dead-letter-exchange على الطابور. ونفّذ مستهلكًا يرسل NACK مع requeue=false عند BusinessException. واكتب اختبارًا يطلق تدفق DLX ويتحقق من ظهور الرسالة في DLQ خلال 100 ملي ثانية.",
    "اكتب اختبار أداء مقارنًا: انشر 10,000 حدث إلى Kafka ‏(payments.events) و10,000 مهمة إلى RabbitMQ ‏(payments.settlement). وقِس الزمن من الطرف إلى الطرف (p50، وp95، وp99) لكل وسيط. ووثّق أي وسيط يحقق p99 أقل واشرح السبب بناءً على فرق نموذج الدفع مقابل السحب من الدرس."
  ]
}
-->
