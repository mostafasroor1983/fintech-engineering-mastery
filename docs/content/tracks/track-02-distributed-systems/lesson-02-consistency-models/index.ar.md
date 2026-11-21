---
id: track-02-lesson-02
title: "نماذج الاتساق — القوي والنهائي والسببي"
slug: consistency-models
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 2
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [consistency, linearisability, eventual-consistency, causal-consistency, monotonic-reads]
prerequisites: []
---

# نماذج الاتساق — القوي والنهائي والسببي

> [!NOTE]
> عندما تُعالج دفعة عميل، يتوقع أن يرى الرصيد المحدّث فورًا. وعندما تُحظر بطاقة محتال، يجب أن تعكس أجهزة الدفع ذلك القرار بسرعة كبيرة. وهذان ليسا متطلب الاتساق نفسه. ففهم الطيف من الاتساق القوي إلى النهائي — ومعرفة أي نموذج ينطبق على أي بيانات في النظام المالي — أساس هندسة الأنظمة الموزعة في التقنية المالية.

## لماذا تهم نماذج الاتساق

"نموذج الاتساق" يحدد الضمانات التي يقدمها نظام تخزين موزع حول ترتيب العمليات وظهورها. والنموذج الخاطئ للبيانات الخاطئة يُنتج:

- **نموذجًا أقوى من اللازم**: زمن استجابة غير ضروري وإتاحة أقل (التضحية بالحرف "A" في CAP دون حاجة)
- **نموذجًا أضعف من اللازم**: قراءات قديمة تسبب قرارات عمل خاطئة — يرى العميل رصيدًا قديمًا فيسحب أكثر مما لديه؛ أو تعتمد قاعدة احتيال على بيانات عمرها 500ms

والتحدي أن الأنظمة المالية الحقيقية فيها عشرات كيانات البيانات، ولكل منها متطلب اتساق مختلف. والمهارة هي ربط النموذج الصحيح بكل كيان.

```
Consistency Spectrum (strongest -> weakest):

Linearisability (strong)
       |   Every operation appears instantaneous at some point
       |   between its start and end. All observers agree on order.
       |
Sequential Consistency
       |   Operations occur in some sequential order consistent
       |   with per-process program order.
       |
Causal Consistency
       |   Causally related operations are seen in causal order.
       |   Concurrent (causally unrelated) operations may be seen
       |   in any order.
       |
Session Consistency (Read-Your-Writes, Monotonic Reads)
       |   Within a session, a client sees its own writes and
       |   never reads older values than previously read.
       |
Eventual Consistency (weakest practical model)
           If no new updates occur, all replicas eventually
           converge to the same value. No timing guarantees.
```

من الأقوى إلى الأضعف: الخطية (كل عملية تبدو لحظية، والجميع متفق على الترتيب)، ثم الاتساق التسلسلي، ثم الاتساق السببي، ثم اتساق الجلسة (قراءة كتاباتك والقراءات الرتيبة)، ثم الاتساق النهائي (تتقارب النسخ في النهاية بلا ضمان زمني).

---

## الخطية (الاتساق القوي)

**الخطية** (linearisability، وتُسمى أيضًا الاتساق الذري) هي المعيار الذهبي: كل عملية تبدو كأنها نُفذت لحظيًا في نقطة زمنية واحدة بين استدعائها وردها. وكل العملاء، أيًا كانت النسخة التي يتصلون بها، يرون تاريخًا متسقًا.

### ما تضمنه الخطية

```
Scenario: Two clients read and write account balance

Timeline (time flows right):
Client A: [ write balance=£500 ────────────────────▶ ]
Client B:                     [ read balance ──▶ ]

Linearisable guarantee: Client B MUST see £500.
The write completed before B's read started.
If B sees £400, the system is NOT linearisable.
```

إذا اكتملت كتابة العميل A قبل أن تبدأ قراءة العميل B، فيجب أن يرى B القيمة 500 جنيه. وإن رأى 400 جنيه فالنظام ليس خطيًا.

```java
// Strong consistency for a balance debit in PostgreSQL.
// All reads and writes go to the single primary, and the row lock makes the
// read-check-write sequence atomic. READ COMMITTED + FOR UPDATE is enough;
// SERIALIZABLE would also work but then the caller must retry on SQLSTATE 40001.

@Service
public class BalanceService {

    private final JdbcTemplate jdbc;   // joins the Spring-managed transaction

    @Transactional   // primary only; READ COMMITTED (PostgreSQL default)
    public DebitResult debit(String accountId, BigDecimal amount) {
        // Lock the row: concurrent debits of the same account queue here
        Account account = jdbc.query(
                "SELECT balance, currency FROM accounts " +
                "WHERE account_id = ? FOR UPDATE",
                (rs, n) -> new Account(rs.getBigDecimal("balance"), rs.getString("currency")),
                accountId)
            .stream().findFirst()
            .orElseThrow(() -> new AccountNotFoundException(accountId));

        if (account.balance().compareTo(amount) < 0) {
            return DebitResult.insufficientFunds(account.balance(), amount);
        }

        BigDecimal newBalance = account.balance().subtract(amount);
        jdbc.update(
            "UPDATE accounts SET balance = ?, version = version + 1, updated_at = NOW() " +
            "WHERE account_id = ?",
            newBalance, accountId);

        return DebitResult.success(newBalance, account.currency());
    }
}
```

كل القراءات والكتابات تذهب إلى النسخة الأساسية الوحيدة، وقفل الصف يجعل تسلسل القراءة-الفحص-الكتابة ذريًا. ويكفي هنا READ COMMITTED مع FOR UPDATE؛ وSERIALIZABLE يعمل أيضًا لكن يجب حينها أن يعيد المستدعي المحاولة عند SQLSTATE 40001.

### أين تُطلب الخطية في التقنية المالية

- **أرصدة الحسابات**: يجب أن يعكس الرصيد كل المعاملات الملتزمة
- **انتقالات حالة الدفع**: لا يمكن أن تكون الدفعة في حالتين في الوقت نفسه
- **سجل مفاتيح منع التكرار**: "هل رأينا مرجع الدفع هذا من قبل؟"
- **فرض قواعد الاحتيال**: يجب أن ترى كل الأنظمة البطاقة المحظورة محظورة فورًا
- **الأقفال الموزعة**: أخذ القفل يعني أن لا عملية أخرى تملكه

**كلفة الخطية**: تتطلب تنسيقًا بين النسخ (بروتوكول إجماع أو قراءات من نسخة أساسية واحدة). وهذا يضيف زمنًا يتناسب مع عدد الرحلات ذهابًا وإيابًا. ففي عنقود قاعدة بيانات يمتد بين مركزي بيانات بينهما 50ms، قد تضيف القراءات الخطية 50-100ms لكل عملية.

---

## الاتساق التسلسلي

الاتساق التسلسلي أضعف من الخطية: يجب أن تظهر العمليات في ترتيب تسلسلي ما يتوافق مع ترتيب إرسال كل عملية (process) لعملياتها، لكن تداخل عمليات العمليات المختلفة قد يكون عشوائيًا.

```
Sequential Consistency vs Linearisability:

Linearisable:
  Real-time order is preserved. If write W completes before read R starts,
  R must observe W.

Sequentially consistent:
  Each process's operations appear in order, but the global ordering
  need not respect real time.

Client A: write(x=1)   ...   write(x=2)
Client B:          read(x)=1  ...  read(x)=2  <- Sequential: OK (B sees A's writes in order)
Client C:          read(x)=2  ...  read(x)=1  <- Sequential: VIOLATION (C sees newer value first)
```

في الخطية يُحفظ الترتيب الزمني الحقيقي. أما في الاتساق التسلسلي فتظهر عمليات كل عملية بالترتيب، لكن الترتيب العام لا يلزم أن يحترم الزمن الحقيقي. فالعميل B الذي يرى 1 ثم 2 مقبول؛ أما العميل C الذي يرى 2 ثم 1 فانتهاك.

نادرًا ما يُستخدم الاتساق التسلسلي نموذجًا صريحًا في قواعد البيانات؛ وهو يظهر أكثر في نماذج ذاكرة المعالجات والعتاد. وفي الأنظمة المالية يكون الاختيار العملي عادة بين الخطية (للبيانات الحرجة) والسببي/النهائي (للبيانات الأقل أهمية).

---

## الاتساق السببي

**الاتساق السببي** يعبّر عن الحدس التالي: "إذا كنت تعرف X، فيجب أن ترى كل ما يعتمد سببيًا على X". فالعمليات بينها علاقة سببية تُرى بترتيبها السببي. أما العمليات المتزامنة (بلا رابط سببي) فقد تراها العمليات المختلفة بترتيبات مختلفة.

وهو أضعف من الخطية وأقوى من الاتساق النهائي، ويمكن تحقيقه بزمن أقل لأنه لا يتطلب تنسيقًا عامًا.

### العلاقات السببية في المدفوعات

```
Causal dependency chain in a payment flow:

1. Customer submits payment P1          -> event E1
2. Fraud service approves P1            -> event E2 (causally depends on E1)
3. Balance is debited for P1            -> event E3 (causally depends on E2)
4. Confirmation notification sent       -> event E4 (causally depends on E3)

Causal consistency guarantee:
Any observer that sees E4 (the notification) MUST also see E3 (the debit),
E2 (fraud approval), and E1 (the original submission).

It would be a violation to send a "Payment confirmed" notification to a 
customer whose balance was not yet debited in the system-of-record.
```

أي مراقب يرى E4 (الإشعار) يجب أن يرى أيضًا E3 (الخصم) وE2 (موافقة الاحتيال) وE1 (الإرسال الأصلي). فمن الانتهاك إرسال إشعار "تم تأكيد الدفع" لعميل لم يُخصم رصيده بعد في نظام السجل.

### تنفيذ الاتساق السببي بالساعات المتجهة

```java
// Causal consistency tracking using vector clocks
// Each event carries the causal dependencies it observed

public record CausalEvent(
    String eventId,
    String eventType,
    Map<String, Long> vectorClock,  // {serviceId -> logicalTimestamp}
    Object payload,
    Instant wallClock
) {
    /**
     * this happens-before other when every entry of this clock is <= the
     * matching entry of other (a missing entry counts as 0) and the clocks differ.
     */
    public boolean happensBefore(CausalEvent other) {
        Set<String> keys = new HashSet<>(this.vectorClock.keySet());
        keys.addAll(other.vectorClock().keySet());
        boolean allLessOrEqual = keys.stream().allMatch(k ->
            this.vectorClock.getOrDefault(k, 0L)
                <= other.vectorClock().getOrDefault(k, 0L));
        return allLessOrEqual && !this.vectorClock.equals(other.vectorClock());
    }

    public boolean isConcurrentWith(CausalEvent other) {
        return !this.happensBefore(other) && !other.happensBefore(this);
    }
}

@Service
public class CausalEventProcessor {

    private final Map<String, Long> localClock = new ConcurrentHashMap<>();
    private final String serviceId;

    /**
     * Process an incoming event, ensuring causal dependencies are satisfied
     * before the event is applied to local state.
     */
    public void processEvent(CausalEvent event) {
        // Wait until all causally-prior events have been processed
        // In production, this would use a proper causal barrier implementation
        waitForCausalDependencies(event);

        // Merge vector clock, then count the receive as a local event
        event.vectorClock().forEach((svcId, ts) ->
            localClock.merge(svcId, ts, Math::max)
        );
        localClock.merge(serviceId, 1L, Long::sum);

        applyToLocalState(event);
    }

    public CausalEvent createEvent(String eventType, Object payload) {
        // Increment our local clock
        long newTimestamp = localClock.merge(serviceId, 1L, Long::sum);

        return new CausalEvent(
            UUID.randomUUID().toString(),
            eventType,
            new HashMap<>(localClock),
            payload,
            Instant.now()
        );
    }
}
```

يسبق الحدث حدثًا آخر سببيًا عندما يكون كل مدخل في ساعته أصغر من المدخل المقابل في الأخرى أو يساويه (المدخل المفقود يُحسب صفرًا) وتختلف الساعتان. ويجب فحص مفاتيح الساعتين معًا، لا مفاتيح إحداهما فقط.

### الاتساق السببي عمليًا في تدفقات الأحداث المالية

يعطي تقسيم Kafka ترتيبًا لكل مفتاح، وهذا يغطي أهم السلاسل السببية: أحداث الحساب نفسه (مفتاح التقسيم نفسه) تُعالج بالترتيب. أما أحداث الحسابات المختلفة فلا ترتيب بينها — فإذا امتد تدفق عبر حسابين، احمل رقمًا تسلسليًا أو ساعة متجهة داخل الحدث.

```java
@Component
public class PaymentEventConsumer {

    /**
     * Kafka ensures causal ordering within a partition (per-accountId).
     * All events for account ACC-001 are processed sequentially.
     * Events for different accounts are processed concurrently.
     */
    @KafkaListener(topics = "payment-events",
                   containerFactory = "paymentEventContainerFactory")
    public void consumePaymentEvent(
            @Payload PaymentEvent event,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            Acknowledgment ack) {

        // The partition key (accountId) guarantees causal ordering per account
        try {
            processEvent(event);
            ack.acknowledge();
        } catch (OutOfOrderEventException ex) {
            // This event arrived before its causal predecessor was processed
            // Requeue with delay or use a causal buffer
            log.warn("Out-of-order event {}: expected sequence {} but got {}",
                      event.eventId(), ex.expectedSequence(), event.sequence());
            ack.nack(Duration.ofMillis(100));
        }
    }
}
```

---

## الاتساق النهائي

**الاتساق النهائي** يقدم ضمانًا واحدًا فقط: إذا لم تحدث تحديثات جديدة على قيمة، فستتقارب كل النسخ في النهاية إلى القيمة نفسها. ولا يقدم أي حد لموعد هذا التقارب.

وهو أضعف نموذج عملي، والنموذج الذي يتيح أعلى إتاحة. وكثير من أنواع البيانات المالية تتحمل الاتساق النهائي جيدًا.

### متى يكون الاتساق النهائي مناسبًا في التقنية المالية

- **تاريخ المعاملات (نماذج القراءة)**: عرض معاملات آخر 90 يومًا؛ تأخر ثانيتين لا يلاحظه المستخدمون
- **لوحات التحليلات**: تقارير إيرادات التجار، وتقييم المحافظ، وتقارير المخاطر
- **حالة تسليم الإشعارات**: فتح البريد من عدمه ليس أمرًا ماليًا جوهريًا
- **البيانات المرجعية**: أسعار الصرف، وجداول البحث في BIC/IBAN (تُحدّث دوريًا)
- **فهارس البحث**: البحث النصي في سجلات العملاء؛ تأخر 500ms مقبول

```java
// Read model for transaction history — eventually consistent
// Populated asynchronously from the event stream; reads from replica

@Repository
public class TransactionHistoryReadModel {

    private final JdbcTemplate replicaJdbc;

    /**
     * This read model is populated asynchronously by the transaction
     * history projection. It may be 1-2 seconds behind the write model.
     * This is acceptable for display purposes.
     */
    public Page<TransactionSummary> getHistory(String accountId,
                                                Pageable pageable) {
        return replicaJdbc.query(
            "SELECT t.transaction_id, t.amount, t.currency, " +
            "       t.transaction_type, t.counterparty_name, " +
            "       t.description, t.transaction_date, t.balance_after " +
            "FROM transaction_history_view t " +
            "WHERE t.account_id = ? " +
            "ORDER BY t.transaction_date DESC " +
            "LIMIT ? OFFSET ?",
            transactionSummaryMapper,
            accountId, pageable.getPageSize(), pageable.getOffset()
        );
    }
}
```

---

## اتساق الجلسة: القراءات الرتيبة وقراءة كتاباتك

خصائص اتساق الجلسة هي أهم الضمانات عمليًا للتطبيقات المالية التي يستخدمها العملاء مباشرة.

### قراءة كتاباتك (Read-Your-Writes)

يجب أن يرى العميل دائمًا آثار كتاباته. فبعد أن يرسل العميل دفعة، يجب أن يراها في تاريخ معاملاته — حتى لو لم تلحق النسخة المتماثلة للقراءة بعد.

```java
@Service
public class SessionConsistentAccountService {

    private final AccountRepository       primaryRepo;    // writes + RYW reads
    private final AccountRepository       replicaRepo;    // other reads
    private final SessionReadVersionStore sessionStore;

    public PaymentResult submitPayment(String customerId,
                                        PaymentRequest request) {
        PaymentResult result = paymentService.process(request);

        // Record the write position so reads-after-write are routed to primary
        long writePosition = primaryRepo.getCurrentSequence();
        sessionStore.recordWrite(customerId, writePosition);

        return result;
    }

    public List<Transaction> getRecentTransactions(String customerId) {
        Long requiredPosition = sessionStore.getLastWritePosition(customerId);

        if (requiredPosition == null) {
            // No recent write — read from replica is safe
            return replicaRepo.getRecentTransactions(customerId);
        }

        // Check if replica has caught up to the required position
        long replicaPosition = replicaRepo.getCurrentSequence();
        if (replicaPosition >= requiredPosition) {
            sessionStore.clearWrite(customerId);  // Replica is current
            return replicaRepo.getRecentTransactions(customerId);
        }

        // Replica hasn't caught up yet — read from primary to satisfy RYW
        log.debug("Routing RYW read to primary for customer {}: " +
                   "required={}, replica={}", customerId,
                   requiredPosition, replicaPosition);
        return primaryRepo.getRecentTransactions(customerId);
    }
}
```

بعد الكتابة نسجّل موقع الكتابة (رقم تسلسلي أو LSN). وتذهب القراءات التالية لهذه الجلسة إلى النسخة الأساسية حتى تبلغ النسخة المتماثلة ذلك الموقع، ثم تعود إلى النسخة المتماثلة. ويجب أن يكون مخزن الجلسة مشتركًا بين كل نسخ الخدمة.

### القراءات الرتيبة (Monotonic Reads)

بعد أن يقرأ العميل قيمة في الزمن T، يجب ألا يقرأ بعدها أبدًا قيمة من قبل T. وهذا يمنع تجربة مربكة يبدو فيها رصيد العميل كأنه يعود إلى الوراء.

```java
@Component
public class MonotonicReadTracker {

    private final Map<String, Long> sessionReadTimestamps =
        new ConcurrentHashMap<>();

    /**
     * Ensure reads for a session never go backwards in time.
     * If the client's last read saw state at T, we must only return
     * state at T or later.
     */
    public BigDecimal getBalance(String accountId, String sessionId) {
        Long lastReadTimestamp = sessionReadTimestamps.get(sessionId);

        AccountSnapshot snapshot = lastReadTimestamp != null
            ? accountRepo.findSnapshotAfter(accountId, lastReadTimestamp)
            : accountRepo.findCurrentSnapshot(accountId);

        // Update the session's high-water mark
        sessionReadTimestamps.put(sessionId,
            Math.max(
                lastReadTimestamp != null ? lastReadTimestamp : 0L,
                snapshot.timestamp()
            )
        );

        return snapshot.balance();
    }
}
```

---

## الاتساق عمليًا: خريطة نظام مالي

```
Financial System Consistency Requirements:

Entity                     Required Model        Rationale
─────────────────────────────────────────────────────────────────────
Account balance            Linearisable          Prevents double-spending
Payment status             Linearisable          Cannot be in two states
Idempotency key registry   Linearisable          Must prevent duplicate processing
Fraud block list           Linearisable + sync   Blocked card must be seen globally
Distributed lock           Linearisable          By definition of a lock

Customer preferences       Causal                Changes propagate causally
Session state              Read-your-writes      Customer sees own changes
Notification preferences   Eventual              Delay is acceptable

Transaction history        Monotonic + eventual  Never goes backwards; lag OK
Analytics dashboards       Eventual              30-min lag acceptable
Search indexes             Eventual              500ms lag acceptable
Reference data (BIC/IBAN)  Eventual              Updated hourly
```

تحتاج أرصدة الحسابات، وحالة الدفع، وسجل منع التكرار، وقائمة حظر الاحتيال، والأقفال الموزعة إلى الخطية. وتحتاج تفضيلات العملاء إلى الاتساق السببي، وحالة الجلسة إلى قراءة كتاباتك. ويكفي الاتساق النهائي لتفضيلات الإشعارات، ولوحات التحليلات، وفهارس البحث، والبيانات المرجعية. أما تاريخ المعاملات فيحتاج قراءات رتيبة مع اتساق نهائي: لا يعود إلى الوراء أبدًا، والتأخر مقبول.

---

## SQL: التحكم في الاتساق في PostgreSQL

```sql
-- Transaction isolation levels and their consistency guarantees

-- READ COMMITTED (default): protects against dirty reads
-- Does NOT protect against non-repeatable reads or phantom reads
-- Suitable for: read-only queries where stale reads are acceptable
BEGIN ISOLATION LEVEL READ COMMITTED;
    SELECT balance FROM accounts WHERE account_id = 'ACC-001';
COMMIT;

-- REPEATABLE READ: protects against dirty and non-repeatable reads
-- A snapshot is taken at the first statement; all reads see that snapshot
-- Suitable for: balance reports that must be internally consistent
BEGIN ISOLATION LEVEL REPEATABLE READ;
    SELECT SUM(balance) FROM accounts WHERE customer_id = 'CUST-001';
    -- Even if another transaction updates a balance here, we see the original
COMMIT;

-- SERIALIZABLE: strongest isolation — the result equals SOME one-at-a-time order
-- of the transactions (serializability is about transactions; linearisability is
-- about single objects in real time — they are different guarantees).
-- Conflicting transactions fail with SQLSTATE 40001 and must be retried.
-- A read-modify-write of one row is also safe under READ COMMITTED with FOR UPDATE.
BEGIN ISOLATION LEVEL SERIALIZABLE;
    SELECT balance FROM accounts WHERE account_id = 'ACC-001' FOR UPDATE;
    UPDATE accounts SET balance = balance - 500 WHERE account_id = 'ACC-001';
    INSERT INTO ledger_entries (account_id, amount, type) VALUES ('ACC-001', -500, 'DEBIT');
COMMIT;

-- Advisory locks for distributed coordination (complement to row locks)
-- Useful for: ensuring only one process performs a migration step at a time
SELECT pg_try_advisory_lock(hashtext('payment-settlement-job-20240115'));
-- Returns true if lock was acquired, false if another process holds it
```

- **READ COMMITTED** (الافتراضي): يحمي من القراءات القذرة فقط. مناسب للاستعلامات التي تقبل قراءات قديمة، ولقراءة-تعديل-كتابة صف واحد مع FOR UPDATE.
- **REPEATABLE READ**: تُؤخذ لقطة عند أول جملة، وكل القراءات ترى تلك اللقطة. مناسب للتقارير التي يجب أن تكون متسقة داخليًا.
- **SERIALIZABLE**: النتيجة تساوي ترتيبًا ما يُنفذ فيه كل معاملة على حدة. وهذه قابلية التسلسل (serializability)، وهي ضمان على المعاملات؛ أما الخطية فضمان على كائنات منفردة بالزمن الحقيقي — وهما ضمانان مختلفان. وتفشل المعاملات المتعارضة بالرمز 40001 ويجب إعادة محاولتها.

---

## أخطاء شائعة

**1. استخدام الاتساق النهائي لبيانات مالية حرجة**
تطبيق الاتساق النهائي على أرصدة الحسابات لأنه "يتوسع أفضل" خطأ فادح. فقراءة رصيد قديم في نظام متسق نهائيًا قد تسمح للعميل بإنفاق المال نفسه مرتين قبل أن يتقارب النظام. ويجب أن تكون بيانات الرصيد متسقة بقوة.

**2. افتراض أن النسخ المتماثلة للقراءة مقبولة لكل القراءات**
للنسخ المتماثلة في PostgreSQL تأخر نسخ (عادة مللي ثوانٍ، لكنه قد يكبر تحت الحمل). وتوجيه كل القراءات إليها للأداء، دون فهم أي القراءات تحتاج ضمان قراءة كتاباتك، يُنتج أخطاء دقيقة ومتقطعة يصعب إعادة إنتاجها.

**3. الخلط بين ACID ونموذج الاتساق**
تضمن معاملات ACID الاتساق داخل عقدة واحدة. أما توزيع البيانات على عدة عقد (التجزئة، والنسخ، وتعدد المناطق) فيُنشئ طبقة مستقلة من مسائل الاتساق لا تعالجها ACID وحدها.

**4. تجاهل سيناريو انقسام الشبكة**
كثيرًا ما يقدّم المتحمسون للاتساق النهائي على أنه "مثل الاتساق القوي لكن أسرع". وأثناء انقسام الشبكة بين مراكز البيانات، سيخدم النظام المتسق نهائيًا قراءات قديمة. وفي نظام مالي، قد تسبب قراءات الرصيد القديمة أثناء الانقسام ضررًا ماليًا حقيقيًا.

**5. عدم توثيق نموذج الاتساق لكل كيان بيانات**
الفرق التي لا توثّق نموذج الاتساق لكل كيان ستتخذ خيارات غير متسقة مع الوقت. وسيضيف المهندسون الجدد قراءات من النسخ المتماثلة لبيانات يجب أن تكون متسقة بقوة.

---

## نصائح للإنتاج

**استخدم وسوم مستوى الاتساق في نموذج بياناتك**
علّم واجهات المستودعات أو أصناف الكيانات بنموذج الاتساق المطلوب:

```java
@ConsistencyLevel(ConsistencyModel.LINEARISABLE)
@Repository
public interface AccountBalanceRepository extends JpaRepository<Account, UUID> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<Account> findByAccountIdForUpdate(String accountId);
}

@ConsistencyLevel(ConsistencyModel.EVENTUAL)
@Repository
public interface TransactionHistoryReadModelRepository {
    Page<TransactionSummary> findByAccountId(String accountId, Pageable pageable);
}
```

**اختبر حدود الاتساق تحت ظروف الفشل**
اختبارات هندسة الفوضى التي تُدخل انقسامات الشبكة، وتأخر النسخ، وانتخابات القائد هي الطريقة الموثوقة الوحيدة للتحقق من أن نموذج الاتساق منفّذ بشكل صحيح. واختبر أن خصومات الرصيد تعمل بشكل صحيح أثناء انتخاب قاعدة البيانات الأساسية.

**راقب تأخر النسخ كمقياس مخاطر مالية**
تتبّع تأخر `pg_stat_replication` للنسخ المتماثلة. وعندما يتجاوز التأخر الحد لكيان بيانات يعتمد على الاتساق النهائي بضمان زمني (مثل "خلال 5 ثوانٍ")، أطلق تنبيهًا ووجّه القراءات اختياريًا إلى النسخة الأساسية.

```sql
-- Monitor replication lag
SELECT
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    write_lag,
    flush_lag,
    replay_lag,
    EXTRACT(EPOCH FROM replay_lag) AS replay_lag_seconds
FROM pg_stat_replication
ORDER BY replay_lag DESC;
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يوجّه نظام دفع كل قراءات قاعدة البيانات إلى نسخة PostgreSQL متماثلة للقراءة لتحسين الأداء، بما فيها قراءات رصيد الحساب أثناء تفويض الدفع. ما العطل الإنتاجي المحدد الذي قد يسببه هذا؟",
      "options": [
        "تعيد النسخة المتماثلة NULL لحقول الرصيد حتى يكتمل النسخ.",
        "قد ينفق العميل مالًا لا يملكه إذا تأخرت النسخة أثناء فترات الكتابة الكثيفة — فتُظهر قراءة الرصيد القديم أموالًا كافية بينما الرصيد الفعلي غير كافٍ.",
        "لا تستطيع النسخ المتماثلة في PostgreSQL التعامل مع استعلامات SELECT FOR UPDATE، فيفشل تفويض الدفع كليًا.",
        "تعيد النسخة المتماثلة الرصيد بعملة مختلفة عن الأساسية بسبب خطأ في إعداد النسخ."
      ],
      "correct": 1,
      "explanation": "قراءات رصيد الحساب أثناء تفويض الدفع تتطلب اتساقًا قويًا. فإذا تأخرت النسخة المتماثلة — ولو بمللي ثوانٍ — قد ينجح فحص الرصيد على النسخة بينما الرصيد في الأساسية أقل بسبب خصم متزامن. والقراءة القديمة تسمح بالإنفاق المزدوج. ويجب أن تأتي قراءات الرصيد لقرارات الدفع دائمًا من الأساسية (أو من مسار قراءة متسق بقوة)."
    },
    {
      "text": "يرسل عميل دفعة ثم يحدّث فورًا تاريخ معاملاته. لا يظهر التاريخ الدفعة بعد لأن نموذج القراءة متسق نهائيًا. أي خاصية من خصائص اتساق الجلسة انتُهكت وكيف تُعالج؟",
      "options": [
        "انتُهكت القراءات الرتيبة — يرى العميل بيانات أقدم مما قرأه سابقًا. والعلاج توجيه قراءات التاريخ إلى الأساسية.",
        "انتُهكت قراءة كتاباتك — لا يرى العميل الدفعة التي أرسلها بنفسه. والعلاج توجيه القراءات بعد الكتابة إلى الأساسية حتى تلحق النسخة المتماثلة بموقع الكتابة.",
        "انتُهك الاتساق السببي — إرسال الدفعة وقراءة التاريخ مرتبطان سببيًا. والعلاج استخدام ساعات متجهة عبر إسقاط نموذج القراءة.",
        "انتُهكت الخطية — حدثت قراءة التاريخ بعد اكتمال كتابة الدفعة. والعلاج استخدام عزل SERIALIZABLE لاستعلامات التاريخ."
      ],
      "correct": 1,
      "explanation": "هذا انتهاك لقراءة كتاباتك: يجب أن يرى العميل دائمًا آثار كتاباته. والعلاج تسجيل موقع الكتابة (رقم تسلسلي في قاعدة البيانات أو LSN) بعد الكتابة، ثم توجيه القراءات التالية لتلك الجلسة إلى الأساسية حتى تلحق النسخة المتماثلة بذلك الموقع. وعندما تصبح النسخة محدّثة يمكن توجيه القراءات إليها مجددًا."
    },
    {
      "text": "أي كيان بيانات في نظام دفع يتطلب الاتساق الخطي بحق، ولماذا؟",
      "options": [
        "لوحات تحليلات التجار — يجب أن تعكس تقارير الإيرادات كل المعاملات لتجنب أخطاء التقارير التنظيمية.",
        "أرصدة الحسابات — تمنع الإنفاق المزدوج بضمان أن كل العمليات المتزامنة ترى رصيدًا حاليًا متسقًا.",
        "عرض تاريخ المعاملات — يتوقع العملاء رؤية معاملاتهم الأخيرة دون أي تأخير.",
        "حالة تأكيد تسليم البريد — يجب تتبع رسائل تأكيد الدفع لحظيًا للامتثال."
      ],
      "correct": 1,
      "explanation": "تتطلب أرصدة الحسابات الخطية لأن السماح لعمليتين متزامنتين بقراءة الرصيد قبل الخصم قبل أن تكتمل أي كتابة يتيح الإنفاق المزدوج — أي أن ينفق العميل المال نفسه مرتين. أما تحليلات التجار، وتاريخ المعاملات، وحالة الإشعارات فتتحمل الاتساق النهائي لأن قِدمها له أثر محدود وغير مالي."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ حدود الاتساق في نظام دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "نفّذ BalanceService يجري خصومات حسابات متسقة بقوة على النسخة الأساسية باستخدام SELECT ... FOR UPDATE داخل معاملة. واكتب اختبارًا متزامنًا بخيطين يحاولان في الوقت نفسه الخصم من الحساب نفسه حيث يمكن لخصم واحد فقط أن ينجح (الرصيد لا يكفي للاثنين). وتحقق من أن خصمًا واحدًا بالضبط ينجح وأن الآخر يحصل على نتيجة رصيد غير كافٍ، دون ترك حالة جزئية في قاعدة البيانات."},
    {"id": "2", "description": "نفّذ SessionConsistentAccountService يقدم ضمان قراءة كتاباتك. بعد إرسال دفعة، يجب أن تسجّل الخدمة موقع الكتابة في قاعدة البيانات الأساسية داخل SessionReadVersionStore. ويجب أن تذهب قراءات تاريخ المعاملات التالية إلى الأساسية إذا لم تلحق النسخة المتماثلة بعد، وإلى النسخة المتماثلة عندما يبلغ رقمها التسلسلي الموقع المسجّل أو يتجاوزه. واكتب اختبارات تحاكي تأخر النسخة وتتحقق من ظهور الدفعة في قراءة التاريخ فور إرسالها."},
    {"id": "3", "description": "أنشئ تعليقًا توضيحيًا @ConsistencyLevel وعلّم به واجهات المستودعات التالية بالنموذج المناسب من خريطة اتساق النظام المالي: AccountBalanceRepository ‏(LINEARISABLE)، وPaymentStatusRepository ‏(LINEARISABLE)، وTransactionHistoryReadModelRepository ‏(EVENTUAL)، وMerchantAnalyticsRepository ‏(EVENTUAL). واكتب اختبار ArchUnit يتحقق من أن كل واجهات المستودعات في الحزمة persistence.primary معلّمة بـ @ConsistencyLevel(LINEARISABLE) وكل ما في persistence.replica معلّم بـ @ConsistencyLevel(EVENTUAL)."},
    {"id": "4", "description": "اكتب استعلام مراقبة في PostgreSQL يفحص تأخر النسخ لكل النسخ المتصلة. واضبط مهمة Spring Boot @Scheduled تعمل كل 30 ثانية، وتقرأ تأخر النسخ من pg_stat_replication، وتنشر مقياس gauge في Micrometer لكل نسخة. واكتب قاعدة تنبيه في Prometheus تنطلق عندما يتجاوز replay_lag_seconds لأي نسخة 5 ثوانٍ، ووثّق أي عمليات القراءة في خدمتك يجب إعادة توجيهها إلى الأساسية عندما يكون هذا التنبيه نشطًا."}
  ]
}
-->
