---
id: track-09-lesson-18
title: "ترتيب الرسائل — الضمانات الشاملة مقابل ضمانات القسم"
slug: message-ordering
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 18
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [message-ordering, partition-key, global-order, sequence-number]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
---

# ترتيب الرسائل — الضمانات الشاملة مقابل ضمانات مستوى القسم

> [!NOTE]
> تضمن Kafka ترتيبًا صارمًا داخل القسم، لكن ليس عبر الأقسام. ولأنظمة الدفع هذا التمييز حاسم: فمعالجة خصم قبل الإيداع المقابل له، أو معالجة إغلاق حساب قبل المعاملة الأخيرة، قد تفسد البيانات المالية. وفهم ضمانات الترتيب في Kafka والتصميم وفقها أمر غير قابل للتفاوض على مستوى المهندس الرئيسي.

## ضمان الترتيب في Kafka

```
Topic: payments.events (3 partitions)

Partition 0 (account: acc-123):    [E1: Deposit] → [E2: Withdraw] → [E3: Transfer]
Partition 1 (account: acc-456):    [E4: Create]  → [E5: Deposit]
Partition 2 (account: acc-789):    [E6: Freeze]  → [E7: Close]

Guarantee:
  Within partition 0: E1 is ALWAYS before E2, E2 is ALWAYS before E3
  Within partition 1: E4 is ALWAYS before E5
  Within partition 2: E6 is ALWAYS before E7

NOT guaranteed:
  Cross-partition ordering: E1 vs E4 vs E6 can arrive in any order
  E3 might be consumed before E4 depending on partition assignment
```

**الأثر على معالجة المدفوعات:** يجب أن تذهب أحداث الحساب نفسه دائمًا إلى القسم نفسه. فاستخدم **معرّف الحساب كمفتاح القسم**.

ويعتمد الضمان أيضًا على المنتج: فمع إعادة المحاولات وأكثر من طلب قيد التنفيذ، قد تصل دفعة فشلت ثم أُعيدت خلف دفعة لاحقة — إلا إذا كان المنتج **متساوي القوة (idempotent)** (الافتراضي منذ Kafka 3.0)، فيحافظ على الترتيب لكل قسم حتى 5 طلبات قيد التنفيذ. ويجب ألا يعالج المستهلك سجلات قسم واحد في خيوط متوازية.

## تصميم مفتاح القسم لأحداث الحسابات

```java
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.KafkaProducer;

@Service
public class AccountEventPublisher {

    @Autowired private KafkaProducer<String, String> producer;

    public void publish(AccountEvent event) {
        ProducerRecord<String, String> record = new ProducerRecord<>(
                "account-events",
                event.getAccountId(),   // KEY — determines partition
                event.toJson()          // VALUE
        );

        // All events for account "acc-123" go to the same partition
        // Built-in partitioner: partition = toPositive(murmur2(keyBytes)) % numPartitions
        producer.send(record);
    }
}
```

```java
// Verifying partition assignment for a given key (same formula as the
// built-in partitioner, with StringSerializer's UTF-8 key bytes)
public int calculatePartition(String key, int numPartitions) {
    int hash = Utils.murmur2(key.getBytes(StandardCharsets.UTF_8));
    // toPositive (hash & 0x7fffffff), NOT Math.abs(hash % n): for negative
    // hashes the two give different partitions
    return Utils.toPositive(hash) % numPartitions;
}

// For account acc-123 with 8 partitions:
// partition = toPositive(murmur2("acc-123")) % 8  (same result on every call)
// Every event for acc-123 always goes to that partition -- as long as the
// partition count stays 8
```

## مشكلة الترتيب الشامل والبدائل

الترتيب الشامل (كل الرسائل في ترتيب كلي واحد) مستحيل في نظام موزع دون عنق زجاجة:

```
Option A: Single Partition (Global Order — Bottleneck)
  Topic: payments.events (1 partition)
  → All events globally ordered
  → Throughput limited to what ONE partition (one leader broker) can take
  → One consumer thread processes everything
  → The leader broker carries all write load (replicas still give failover)

Option B: Partition-per-Account (Local Order — No Cross-Account Order)
  Topic: payments.events (N partitions, key = accountId)
  → Events for each account are locally ordered
  → Cross-account events have no ordering guarantee
  → Throughput scales roughly with partition count
  → This is the correct approach for most payment use cases

Option C: Sequence Numbers (Application-Level Ordering)
  Topic: payments.events (N partitions, key = accountId)
  → Each event carries a sequence number per account
  → Consumers detect and handle out-of-order delivery
  → Most flexible — works across replicas and regions
```

لأغلب حالات الاستخدام المالية، **الخيار B** صحيح وكافٍ. فالترتيب عبر الحسابات ليس متطلبًا للعمل — المهم أن يحدث خصم حساب معين قبل عكس الإيداع الخاص به.

## أرقام التسلسل لكشف الأحداث غير المرتبة

تتيح أرقام التسلسل على مستوى التطبيق للمستهلكين كشف انتهاكات الترتيب والتعامل معها:

```java
// Producer: attach sequence number per account
@Service
public class SequencedAccountEventPublisher {

    @Autowired private AccountSequenceRepository sequenceRepo;
    @Autowired private KafkaProducer<String, String> producer;

    // The sequence number and the event must be written TOGETHER: publish
    // through an outbox row in this transaction (Lesson 06). A direct
    // producer.send() here could fail after the counter was incremented --
    // leaving a GAP that ordered consumers would wait for forever.
    @Transactional
    public void publish(AccountEvent event) {
        // Atomically increment and get the next sequence number for this account:
        // UPDATE account_sequences SET current_sequence = current_sequence + 1
        //  WHERE account_id = ? RETURNING current_sequence
        // (row lock -> concurrent publishers get distinct, gapless numbers)
        long sequenceNumber = sequenceRepo.nextSequenceFor(event.getAccountId());

        SequencedAccountEvent sequencedEvent = SequencedAccountEvent.builder()
                .eventId(event.getEventId())
                .accountId(event.getAccountId())
                .eventType(event.getEventType())
                .payload(event.toJson())
                .sequenceNumber(sequenceNumber)
                .occurredAt(event.getOccurredAt())
                .build();

        ProducerRecord<String, String> record = new ProducerRecord<>(
                "account-events",
                event.getAccountId(),
                objectMapper.writeValueAsString(sequencedEvent)
        );

        outbox.save(record);   // relayed to Kafka by CDC / outbox relay
    }
}

@Entity
@Table(name = "account_sequences")
public class AccountSequence {
    @Id
    private String accountId;

    @Column(name = "current_sequence")
    private long currentSequence;

    public long nextSequence() {
        return ++currentSequence;
    }
}
```

### المستهلك: كشف الأحداث غير المرتبة

```java
@Component
public class OrderEnforcingAccountConsumer {

    // The last applied sequence per account lives in the PROJECTION DATABASE
    // (same transaction as the projection update) -- not in a HashMap: after
    // a restart or rebalance an in-memory map would be empty, every event
    // would look like "from the future", and processing would stall.
    @Autowired private AccountProjectionService projectionService;
    @Autowired private PendingEventBuffer pendingBuffer;   // durable table, see below

    @KafkaListener(topics = "account-events", groupId = "account-projection")
    @Transactional
    public void consume(ConsumerRecord<String, String> record) {
        SequencedAccountEvent event = parseEvent(record.value());
        String accountId = event.getAccountId();
        long expectedSequence = projectionService.lastAppliedSequence(accountId) + 1;

        if (event.getSequenceNumber() == expectedSequence) {
            // In order — process immediately (updates the stored sequence)
            projectionService.apply(event);

            // Check if buffered events can now be processed
            drainBuffer(accountId);

        } else if (event.getSequenceNumber() > expectedSequence) {
            // Future event arrived before earlier events (possible with
            // sub-partitioned keys or multi-region input). Buffer it in a
            // TABLE -- its offset will be committed, so an in-memory buffer
            // would lose it on a crash -- and alert if the gap stays open.
            log.warn("Out-of-order event for account={} expected={} got={}",
                    accountId, expectedSequence, event.getSequenceNumber());
            pendingBuffer.add(accountId, event);

        } else {
            // Duplicate — already processed this sequence
            log.info("Duplicate event for account={} seq={} — skipping (idempotent)",
                    accountId, event.getSequenceNumber());
        }
    }

    private void drainBuffer(String accountId) {
        while (true) {
            long nextExpected = projectionService.lastAppliedSequence(accountId) + 1;
            SequencedAccountEvent buffered = pendingBuffer.peek(accountId, nextExpected);

            if (buffered == null) break;

            pendingBuffer.remove(accountId, nextExpected);
            projectionService.apply(buffered);
        }
    }
}
```

## الترتيب في معالجة المدفوعات

متطلبات الترتيب الحرجة في معالجة المدفوعات:

```
REQUIREMENT 1: Account events ordered per account
  Debit must be processed before the debit reversal
  Account creation must be processed before any subsequent events
  → Solution: accountId as partition key

REQUIREMENT 2: Payment saga steps ordered per payment
  PaymentInitiated must precede FraudCheckPassed
  FraudCheckPassed must precede FundsTransferred
  → Solution: paymentId as partition key on saga topic

REQUIREMENT 3: Settlement batch ordering
  All transactions in a batch must be processed before the batch is closed
  → Solution: batchId as partition key; sequence numbers for intra-batch ordering

REQUIREMENT 4: Cross-account transfer
  Debit source account THEN credit destination account
  → NOT a Kafka ordering problem — use Saga pattern (Lesson 15)
  → Saga orchestrator ensures the sequence
```

## مشكلة القسم الساخن

يعمل استخدام `accountId` كمفتاح جيدًا حين تتشابه أحجام الحسابات. أما مع حسابات التجار عالية الحجم، فقد يولّد حساب واحد 70% من كل الأحداث، فيُثقل القسم 3 — ولأن المفتاح الواحد يُربط دائمًا بقسم واحد، فإضافة أقسام لا تساعد ذلك المفتاح:

```
Partition 0: acc-001 to acc-100 → moderate load
Partition 1: acc-101 to acc-200 → moderate load
Partition 2: acc-201 to acc-300 → moderate load
Partition 3: acc-MERCHANT-X     → 70% of all traffic (HOT PARTITION)
```

**الحلول:**

```java
// Option 1: Sub-partition high-volume accounts
public ProducerRecord<String, String> createRecord(AccountEvent event) {
    String accountId = event.getAccountId();
    String partitionKey;

    if (isHighVolumeAccount(accountId)) {
        // Distribute across multiple partitions using a suffix
        int subPartition = (int) (event.getSequenceNumber() % 4);
        partitionKey = accountId + "-" + subPartition;
        // Events may arrive out-of-order — use sequence numbers to reorder
    } else {
        partitionKey = accountId;
    }

    return new ProducerRecord<>("account-events", partitionKey, event.toJson());
}

// Option 2: Separate topic for high-volume accounts -- isolates the noisy
// neighbour so other accounts are not slowed down, but the hot account itself
// still lands on ONE partition of that topic (one key = one partition)
public ProducerRecord<String, String> createRecord(AccountEvent event) {
    String topic = isHighVolumeAccount(event.getAccountId())
            ? "account-events-high-volume"
            : "account-events";

    return new ProducerRecord<>(topic, event.getAccountId(), event.toJson());
}

// Option 3 (often the best): ask whether per-MERCHANT ordering is really
// needed. Usually only per-PAYMENT order matters -- then key by paymentId
// (or merchantId + terminalId) and the load spreads naturally
```

## اختبار ضمانات الترتيب

```java
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.junit.jupiter.api.Test;

class KafkaOrderingGuaranteeTest {

    @Test
    void accountEventsAreConsumedInProducedOrder() throws Exception {
        String accountId = "test-account-" + UUID.randomUUID();
        List<String> producedOrder = new ArrayList<>();
        List<String> consumedOrder = new ArrayList<>();

        // Produce 100 events rapidly
        try (KafkaProducer<String, String> producer = createProducer()) {
            for (int i = 1; i <= 100; i++) {
                String eventJson = buildEvent(accountId, i);
                producedOrder.add(eventJson);
                producer.send(new ProducerRecord<>("account-events", accountId, eventJson));
            }
            producer.flush();
        }

        // Consume all events
        try (KafkaConsumer<String, String> consumer = createConsumer()) {
            consumer.subscribe(List.of("account-events"));
            int received = 0;

            while (received < 100) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(5));
                for (ConsumerRecord<String, String> record : records) {
                    if (record.key().equals(accountId)) {
                        consumedOrder.add(record.value());
                        received++;
                    }
                }
            }
        }

        // Assert ordering
        assertEquals(producedOrder.size(), consumedOrder.size(),
                "All produced events should be consumed");
        assertEquals(producedOrder, consumedOrder,
                "Events should be consumed in the same order they were produced");
    }

    @Test
    void differentAccountsCanBeConsumedConcurrently() throws Exception {
        // Produce events for 4 accounts
        List<String> accountIds = List.of("acc-A", "acc-B", "acc-C", "acc-D");
        Map<String, List<Integer>> producedSequences = new HashMap<>();
        Map<String, List<Integer>> consumedSequences = new ConcurrentHashMap<>();

        try (KafkaProducer<String, String> producer = createProducer()) {
            for (String accountId : accountIds) {
                List<Integer> sequences = new ArrayList<>();
                for (int i = 1; i <= 50; i++) {
                    producer.send(new ProducerRecord<>("account-events",
                            accountId, buildSequencedEvent(accountId, i)));
                    sequences.add(i);
                }
                producedSequences.put(accountId, sequences);
            }
            producer.flush();
        }

        // Consume and verify per-account ordering
        // (cross-account ordering is not guaranteed — this test does not check it)
        try (KafkaConsumer<String, String> consumer = createConsumer()) {
            consumer.subscribe(List.of("account-events"));
            long deadline = System.currentTimeMillis() + 30_000;
            int received = 0;
            while (received < 200 && System.currentTimeMillis() < deadline) {
                for (ConsumerRecord<String, String> r : consumer.poll(Duration.ofSeconds(1))) {
                    if (accountIds.contains(r.key())) {
                        consumedSequences.computeIfAbsent(r.key(), k -> new ArrayList<>())
                            .add(parseSequence(r.value()));
                        received++;
                    }
                }
            }
        }

        for (String accountId : accountIds) {
            List<Integer> sequences = consumedSequences.get(accountId);
            assertEquals(producedSequences.get(accountId), sequences,
                    "All events for " + accountId + " must arrive, in order");
            for (int i = 1; i < sequences.size(); i++) {
                assertTrue(sequences.get(i) > sequences.get(i - 1),
                        "Events for " + accountId + " must be in order");
            }
        }
    }
}
```

## التعويض عن الأحداث غير المرتبة

داخل القسم الواحد لا تعيد Kafka ترتيب الأحداث، وإعادة التوازن تسبب *تكرارات* (إعادة تسليم من آخر التزام)، لا إعادة ترتيب. أما الوصول غير المرتب فيحدث مع المفاتيح المقسمة فرعيًا، أو مدخلات مدمجة من عدة مناطق أو مواضيع، أو منتج غير متساوي القوة يعيد المحاولة. فصمم منطق تعويض — لكن فقط حيث تسمح العملية بذلك:

```java
@Service
public class OutOfOrderEventCompensator {

    @Autowired private AccountProjectionRepository projectionRepo;

    public void handleOutOfOrderDeposit(FundsDeposited deposit, long expectedSequence) {
        log.warn("Received out-of-order deposit: account={} expected={} got={}",
                deposit.getAccountId(), expectedSequence, deposit.getSequenceNumber());

        // Buffer for a grace period — wait for gap to fill
        // If gap doesn't fill within 5 seconds, it may be a bug
        // In practice: compensate by applying the event and flagging for audit

        AccountProjection projection = projectionRepo.findById(deposit.getAccountId())
                .orElseThrow();

        // Apply deposit even out of order — balance will be correct
        // (addition is commutative — order doesn't matter for the SUM).
        // This is NOT true for order-sensitive events: a withdrawal checked
        // against the balance, an account freeze/close, a status change --
        // those must wait for the gap or go to manual review
        projection.applyDeposit(deposit.getAmount());
        projection.flagForAudit("OUT_OF_ORDER_EVENT_seq=" + deposit.getSequenceNumber());
        projectionRepo.save(projection);

        // Alert ops team for investigation
        alertService.sendAlert(AlertSeverity.MEDIUM,
                String.format("Out-of-order event detected for account %s — audited",
                        deposit.getAccountId()));
    }
}
```

## الخلاصات الأساسية

- تضمن Kafka الترتيب **داخل القسم** فقط — لا عبر الأقسام.
- استخدم **معرّف الحساب كمفتاح القسم** لضمان ذهاب كل أحداث الحساب إلى القسم نفسه بالترتيب نفسه.
- يتطلب الترتيب الشامل قسمًا واحدًا — وهو عنق زجاجة للإنتاجية. فصمم لتجنب هذا المتطلب.
- تتيح **أرقام التسلسل على مستوى التطبيق** كشف الأحداث غير المرتبة ومعالجتها حين يهم الترتيب عبر الأقسام.
- يمكن تخفيف الأقسام الساخنة الناتجة عن الحسابات عالية الحجم بالتقسيم الفرعي (لاحقة على المفتاح) أو بمواضيع مخصصة للحجم العالي.
- الترتيب عبر الحسابات (الخصم قبل الإيداع في تحويل) ليس مشكلة Kafka — استخدم نمط Saga لفرض التسلسل.
- اختبر دائمًا ضمانات الترتيب في اختبارات التكامل: أنتج الأحداث بسرعة، واستهلكها، وتحقق من FIFO لكل مفتاح.
- حين تقع أحداث غير مرتبة في الإنتاج، خزّنها مؤقتًا بشكل دائم لفترة قصيرة؛ ويمكن بعدها تطبيق التبادلية منها (إيداعات في مجموع) مع علامة تدقيق، أما الحساسة للترتيب (السحوبات، وتغييرات الحالة) فيجب أن تنتظر أو تذهب للمراجعة.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "موضوع له 8 أقسام. وكل أحداث الحساب acc-123 تستخدم مفتاح القسم 'acc-123'. يضيف فريق خدمة جديد قسمًا تاسعًا للتعامل مع الحمل المتزايد. ماذا يحدث للترتيب بالنسبة لـ acc-123؟",
      "options": [
        "لا شيء يتغير — تحافظ Kafka على تعيين الأقسام نفسه للمفاتيح الموجودة",
        "يتغير تعيين القسم لـ acc-123 لأن hash('acc-123') % 9 ينتج نتيجة مختلفة عن hash('acc-123') % 8، فقد تذهب الأحداث الجديدة إلى قسم مختلف عن الأحداث القديمة",
        "تنقل Kafka الأحداث القديمة تلقائيًا إلى القسم الجديد للحفاظ على الترتيب",
        "يعيد المقسّم القائم على المفاتيح تعيين المفاتيح الجديدة فقط؛ وتبقى المفاتيح الموجودة دائمًا على القسم نفسه"
      ],
      "correct": 1,
      "explanation": "يحسب المقسّم المدمج في Kafka القسم = toPositive(murmur2(keyBytes)) % numPartitions. وحين يتغير numPartitions يتغير باقي القسمة، فقد يُربط المفتاح نفسه بقسم مختلف. وتبقى الأحداث القديمة على القسم الأصلي بينما تذهب الجديدة إلى القسم الجديد. وقد يعالج المستهلك حينها أحداثًا جديدة لـ acc-123 قبل الأحداث القديمة المتبقية، لأنه لا ترتيب عبر الأقسام. وإضافة أقسام لموضوع حي تحتاج تنسيقًا — مثل تفريغ الموضوع أولًا، أو الانتقال إلى موضوع جديد، أو الاعتماد على أرقام تسلسل على مستوى التطبيق."
    },
    {
      "text": "حساب تاجر واحد يولّد 70% من كل أحداث الدفع، فيُثقل القسم 3 بشدة (قسم ساخن). ما الحل الموصى به الذي يحافظ على الترتيب لحساب التاجر؟",
      "options": [
        "التحول إلى التقسيم العشوائي لحساب التاجر لتوزيع الحمل بالتساوي",
        "تقسيم حساب التاجر فرعيًا باستخدام المفتاح = merchantId + '-' + (sequenceNumber % N)، واستخدام أرقام تسلسل على مستوى التطبيق لإعادة ترتيب الأحداث داخل المستهلك",
        "إنشاء مستهلك منفصل للقسم 3 بخيوط أكثر لتحمّل الحمل",
        "زيادة معامل النسخ للقسم 3 لتوزيع حمل القراءة"
      ],
      "correct": 1,
      "explanation": "ينشر التقسيم الفرعي أحداث التاجر عبر N قسمًا، فيزيل القسم الساخن. ولأن أحداث التاجر الواحد تذهب الآن إلى أقسام متعددة، لم يعد ضمان الترتيب على مستوى القسم في Kafka ساريًا عبرها. وتتيح أرقام التسلسل على مستوى التطبيق (التي يرفقها المنتج) للمستهلك كشف الأحداث غير المرتبة وتخزينها مؤقتًا، ثم معالجتها بالتسلسل الصحيح. ولا يؤثر معامل النسخ ولا عدد خيوط المستهلك على إنتاجية الكتابة في القسم."
    },
    {
      "text": "في تحويل بين حسابين (خصم من الحساب المصدر، ثم إيداع في الحساب الوجهة)، أي آلية تفرض معالجة الخصم دائمًا قبل الإيداع؟",
      "options": [
        "استخدام مفتاح القسم نفسه للحدثين كي يصلا إلى القسم نفسه",
        "نمط Saga — يضمن منسّق أو تصميم تشاركي (choreography) ألا يُنشر حدث الإيداع إلا بعد تأكيد معالجة حدث الخصم",
        "ضبط max.in.flight.requests.per.connection=1 لمنع التسليم غير المرتب",
        "استخدام وضع الترتيب الشامل في Kafka بتقليل الأقسام إلى 1"
      ],
      "correct": 1,
      "explanation": "لحدث الخصم (الحساب المصدر) وحدث الإيداع (الحساب الوجهة) معرّفا حساب مختلفان، فيذهبان إلى قسمين مختلفين بلا ضمان ترتيب بينهما. واستخدام مفتاح القسم نفسه سيجبرهما على قسم واحد لكنه لن يضمن ترتيب المعالجة عبر الخدمات. ويحل نمط Saga هذا على مستوى التطبيق: فلا تبدأ خطوة الإيداع إلا بعد أن تؤكد خدمة الخصم الاكتمال، إما عبر التنسيق المركزي (استجابة صريحة) أو التصميم التشاركي (الاستماع لحدث DebitConfirmed)."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "معالجة مرتبة لأحداث الحسابات مع تخفيف القسم الساخن",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "نفّذ SequencedAccountEventPublisher يزيد ذريًا رقم تسلسل لكل حساب في PostgreSQL ‏(UPDATE ... RETURNING، أو SELECT FOR UPDATE) ويكتب الحدث المرقّم في جدول outbox في المعاملة نفسها. واكتب اختبارًا ينشر 100 حدث متزامن للحساب نفسه ويتحقق من أن أرقام التسلسل فريدة وبلا فجوات.",
    "نفّذ OrderEnforcingConsumer يخزّن آخر رقم تسلسل مطبّق لكل حساب في قاعدة بيانات الإسقاط (في معاملة تحديث الإسقاط نفسها). للأحداث المرتبة، عالجها فورًا. وللأحداث المستقبلية (اكتُشفت فجوة)، خزّنها مؤقتًا في جدول دائم مفتاحه (الحساب، والتسلسل). وللأحداث الماضية (مكررة)، تجاوزها وسجّلها. واكتب اختبارات تغطي المسارات الثلاثة، بما فيها إعادة تشغيل في المنتصف.",
    "حدّد سيناريو 'حساب ساخن': أنتج 1,000 حدث لحساب تاجر واحد و100 حدث لكل من 10 حسابات عادية في موضوع من 4 أقسام. وقِس عدد الرسائل لكل قسم. ثم نفّذ التقسيم الفرعي لحساب التاجر (المفتاح = merchantId + '-' + (seq % 4)) وأعد التشغيل، متحققًا من انتشار أحداث التاجر عبر الأقسام الأربعة.",
    "اكتب اختبار تكامل باستخدام EmbeddedKafka يحاكي إعادة توازن الأقسام في منتصف المعالجة (بإغلاق المستهلك وإعادة فتحه) ويتحقق من أن OrderEnforcingConsumer يستأنف من آخر إزاحة ملتزمة دون تطبيق أي حدث مرتين (تُعرف الأحداث المعاد تسليمها بأرقام تسلسلها) ودون فقدان أي حدث."
  ]
}
-->
