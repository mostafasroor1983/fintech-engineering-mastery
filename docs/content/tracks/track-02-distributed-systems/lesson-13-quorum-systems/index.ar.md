---
id: track-02-lesson-13
title: "الأنظمة القائمة على النصاب ونصاب القراءة والكتابة"
slug: quorum-systems
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 13
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [quorum, read-quorum, write-quorum, ROWA, replication]
prerequisites: []
---

# الأنظمة القائمة على النصاب ونصاب القراءة والكتابة

> [!NOTE]
> النصاب هو الضمان الرياضي الذي يقع بين "أي عقدة تستطيع الإجابة" و"يجب أن تتفق كل العقد". وفي الأنظمة المالية، اختيار إعداد النصاب الصحيح مفاضلة مباشرة بين ضمانات الاتساق والإتاحة أثناء الأعطال الجزئية. والخطأ فيه يعني إما أرصدة قديمة أو توقفًا غير ضروري.

## صيغة النصاب

يحقق نظام النصاب ذو N نسخة **الاتساق القوي** عندما:

```
R + W > N
```

حيث:
- **N** = العدد الكلي للنسخ
- **R** = عدد النسخ التي يجب أن ترد على القراءة (نصاب القراءة)
- **W** = عدد النسخ التي يجب أن تؤكد الكتابة (نصاب الكتابة)

الفكرة: إذا كان `R + W > N` فإن أي نصاب قراءة وأي نصاب كتابة يجب أن يشتركا في عقدة واحدة على الأقل. وتلك العقدة المشتركة رأت آخر كتابة. لذلك تجد القراءة التي تتصل بـ R نسخة دائمًا نسخة واحدة على الأقل فيها أحدث البيانات.

```
Example: N=3, W=2, R=2 (the classic "majority quorum")

Write: must reach 2 of 3 replicas
Read:  must reach 2 of 3 replicas
Overlap: at least 1 replica is in both sets
         → reads always see the latest write ✓

R + W = 4 > 3 = N ✓

Example: N=3, W=1, R=1 (AP — no consistency guarantee)

Write: reaches only 1 replica
Read:  reads only 1 replica
Overlap: might be 0 replicas in common
         → reads may return stale data ✗

R + W = 2 ≤ 3 = N ✗ (not a quorum system)
```

مع N=3 وW=2 وR=2 (نصاب الأغلبية الكلاسيكي) يتداخل النصابان دائمًا. أما مع W=1 وR=1 فقد لا يوجد تداخل، فتعيد القراءة بيانات قديمة.

---

## قراءة كتاباتك مع النصاب

اتساق **قراءة كتاباتك** ضمان على مستوى الجلسة بأن يرى العميل دائمًا أحدث كتاباته. وهذا أساسي في البنوك: إذا حوّل العميل أموالًا، يجب أن يعكس استعلام الرصيد التالي ذلك التحويل.

مع النصاب يُضمن قراءة كتاباتك عندما `R + W > N`. ومع إعدادات أضعف (مثل `W=1, R=1`) قد تصل القراءة إلى نسخة لم تتلقَّ الكتابة بعد.

```java
@Service
public class AccountBalanceService {

    // Note: most teams keep balances in a relational database (see lesson 01).
    // This shows how it CAN be done safely in Cassandra.

    private final CqlSession session;
    private final PreparedStatement readStmt;
    private final PreparedStatement casDebitStmt;

    public AccountBalanceService(CqlSession session) {
        this.session = session;   // prepare in the constructor, after session is set
        this.readStmt = session.prepare(
            "SELECT account_id, balance_cents, version, last_modified " +
            "FROM accounts.balances WHERE account_id = ?");
        // Cassandra cannot do SET balance = balance - ? on a normal column
        // (only counters support arithmetic, and counters cannot be used in
        // conditions). So: read, compute, then compare-and-set on version.
        this.casDebitStmt = session.prepare(
            "UPDATE accounts.balances " +
            "SET balance_cents = ?, version = ?, last_modified = ? " +
            "WHERE account_id = ? " +
            "IF version = ?");   // lightweight transaction (Paxos)
    }

    /**
     * Debit with an optimistic compare-and-set. The LWT is linearizable, so
     * two concurrent debits can never both apply against the same version.
     */
    public DebitResult debit(UUID accountId, long amountCents, String idempotencyKey) {
        for (int attempt = 0; attempt < 5; attempt++) {
            Row current = session.execute(readStmt.bind(accountId)
                .setConsistencyLevel(ConsistencyLevel.SERIAL)).one();   // linearizable read
            long balance = current.getLong("balance_cents");
            long version = current.getLong("version");

            if (balance < amountCents) {
                return DebitResult.insufficientFunds(balance, amountCents);
            }

            Row result = session.execute(casDebitStmt.bind(
                    balance - amountCents, version + 1, Instant.now(), accountId, version)
                .setConsistencyLevel(ConsistencyLevel.QUORUM)            // commit phase
                .setSerialConsistencyLevel(ConsistencyLevel.SERIAL))     // Paxos phase
                .one();

            if (result.getBoolean("[applied]")) {
                return DebitResult.success(balance - amountCents);
            }
            // Someone else changed the row first — re-read and try again
        }
        throw new ConcurrentModificationException("Too much contention on " + accountId);
    }

    /**
     * Read balance with QUORUM consistency.
     * Combined with QUORUM writes (R + W = 4 > N = 3),
     * this guarantees read-your-writes.
     */
    public AccountBalance readBalance(UUID accountId) {
        BoundStatement stmt = readStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.QUORUM);

        Row row = session.execute(stmt).one();
        if (row == null) {
            throw new AccountNotFoundException(accountId.toString());
        }

        return AccountBalance.builder()
            .accountId(accountId)
            .balanceCents(row.getLong("balance_cents"))
            .version(row.getLong("version"))
            .lastModified(row.getInstant("last_modified"))
            .build();
    }

    /**
     * For read-intensive inquiry paths where slight staleness is acceptable
     * (e.g., dashboard balance display — not for payment authorization).
     * Uses LOCAL_ONE for lower latency at the cost of potential staleness.
     */
    public AccountBalance readBalanceEventuallyConsistent(UUID accountId) {
        BoundStatement stmt = readStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.LOCAL_ONE);

        Row row = session.execute(stmt).one();
        return mapRow(row);
    }
}
```

ملاحظة: تحتفظ معظم الفرق بالأرصدة في قاعدة بيانات علائقية (انظر الدرس 01)، وهذا يوضح كيف يمكن فعل ذلك بأمان في Cassandra. فـ Cassandra لا تستطيع تنفيذ `SET balance = balance - ?` على عمود عادي (العدّادات وحدها تدعم الحساب، ولا يمكن استخدامها في الشروط). لذلك: اقرأ، واحسب، ثم نفّذ مقارنة-وتعيين على رقم الإصدار. والمعاملة الخفيفة (LWT) خطية، فلا يمكن أن ينجح خصمان متزامنان على الإصدار نفسه.

---

## نظرة معمّقة على مستويات الاتساق في Cassandra

مستويات الاتساق في Cassandra تعبير مباشر عن R وW في صيغة النصاب. ومع عامل نسخ 3 (N=3):

| مستوى الاتساق | النسخ المطلوبة | هل R+W > N؟ | حالة الاستخدام |
|---|---|---|---|
| ONE | 1 | لا (1+1=2 ≤ 3) | السجلات، والتحليلات، والقراءات غير الحرجة |
| TWO | 2 | نعم إذا استخدمت القراءة والكتابة TWO معًا (4 > 3) | نادر — QUORUM يعبّر عن النية ويتكيف مع عامل النسخ |
| QUORUM | 2 ‏(⌊3/2⌋+1 = 2) | نعم (2+2=4 > 3) | معظم العمليات المالية |
| ALL | 3 | نعم | أعلى اتساق، وأدنى إتاحة |
| LOCAL_QUORUM | 2 في المركز المحلي | نعم (داخل المركز) | عدة مراكز: اتساق داخل المركز |
| EACH_QUORUM | 2 في كل مركز | نعم (لكل مركز) | كتابات متزامنة عبر عدة مراكز |
| SERIAL | Paxos بين نصاب | خطي (للمعاملات الخفيفة) | المستوى التسلسلي للمعاملات الخفيفة؛ وقراءة بياناتها |

```java
@Configuration
public class CassandraConsistencyConfiguration {

    /**
     * Different operations in a payment system require different
     * consistency levels. Configure these explicitly rather than
     * using a single global default.
     */

    // Payment authorization — maximum consistency
    public static final ConsistencyLevel PAYMENT_WRITE_CL  = ConsistencyLevel.LOCAL_QUORUM;
    public static final ConsistencyLevel PAYMENT_READ_CL   = ConsistencyLevel.LOCAL_QUORUM;

    // Idempotency key claims — requires linearizability. SERIAL is used as the
    // SERIAL consistency level of an LWT (setSerialConsistencyLevel), not as
    // the normal consistency level of a write.
    public static final ConsistencyLevel IDEMPOTENCY_CL    = ConsistencyLevel.SERIAL;

    // Balance display on dashboard — eventual consistency acceptable
    public static final ConsistencyLevel BALANCE_DISPLAY_CL = ConsistencyLevel.LOCAL_ONE;

    // Transaction history query — slight staleness acceptable
    public static final ConsistencyLevel HISTORY_READ_CL   = ConsistencyLevel.LOCAL_ONE;

    // Audit log writes — durable on a majority in the local DC. (ALL would
    // block audit writes whenever any single replica is down.)
    public static final ConsistencyLevel AUDIT_WRITE_CL    = ConsistencyLevel.LOCAL_QUORUM;
}
```

يُستخدم SERIAL كمستوى الاتساق التسلسلي للمعاملة الخفيفة (`setSerialConsistencyLevel`)، لا كمستوى اتساق عادي للكتابة. وتُكتب سجلات التدقيق بـ LOCAL_QUORUM، لأن ALL ستحجب كتابات التدقيق كلما تعطلت أي نسخة واحدة.

### LOCAL_QUORUM مقابل QUORUM

في النشر عبر عدة مراكز بيانات، يعدّ `QUORUM` النسخ في كل المراكز، بينما يعدّ `LOCAL_QUORUM` النسخ في المركز المحلي فقط. ولنظام دفع بثلاث نسخ لكل مركز عبر مركزين (N=6 عالميًا، وN=3 لكل مركز):

```
QUORUM:        requires ⌊6/2⌋+1 = 4 replicas (must cross DC boundary — adds ~20ms latency)
LOCAL_QUORUM:  requires ⌊3/2⌋+1 = 2 replicas in local DC (stays within DC — ~1ms latency)
```

لمعالجة المدفوعات، `LOCAL_QUORUM` هو الخيار الصحيح في الغالب: اتساق قوي داخل مركز البيانات، مع نسخ غير متزامن إلى مركز التعافي من الكوارث. والثمن: إذا فُقد مركز بيانات كامل، فقد لا تكون أحدث كتاباته قد وصلت إلى مركز التعافي بعد.

---

## النصاب المرن (Sloppy Quorum) والتسليم المؤجل

**النصاب المرن** تخفيف تستخدمه الأنظمة على طريقة Dynamo (نظام Dynamo الأصلي من Amazon، وRiak) للحفاظ على إتاحة الكتابة حتى عندما تكون النسخ المحددة لقسم البيانات غير متاحة. و**Cassandra لا تستخدم النصاب المرن**: فهي تخزن تلميحات للنسخ المعطلة (التسليم المؤجل، hinted handoff)، لكن التلميحات لا تُحتسب أبدًا ضمن مستوى الاتساق — والاستثناء الوحيد المستوى الخاص `ANY`.

في النصاب المرن، إذا كانت إحدى النسخ المحددة الـ N معطلة، تقبل عقدة أخرى في العنقود الكتابة مؤقتًا نيابة عنها. وتخزن هذه العقدة **تلميحًا** — ملاحظة بأنها يجب أن تمرر هذه الكتابة إلى النسخة الأصلية عند تعافيها.

```
Normal quorum write (N=3, W=2):
  Data for token range [0, 1000] → Nodes A, B, C
  Write: A ✓, B ✓, C (unreachable)
  Result: Write succeeds (2/3 = quorum)

Sloppy quorum in a Dynamo-style store (W=3, A and B down):
  Data for token range [0, 1000] → Nodes A, B, C
  A and B unreachable → Node D accepts write with hint for A and B
  Write: C ✓, D ✓ (hint for A), E ✓ (hint for B)
  Result: Write succeeds! But D and E are "wrong" replicas.

  When A and B recover:
    D forwards hint to A
    E forwards hint to B
  → Hinted handoff restores consistency
```

```java
@Service
public class HintedHandoffMonitor {

    /**
     * Monitor hinted handoff. If hints accumulate faster than they are
     * delivered, a replica has been unavailable for a long time — and hints
     * are only kept for max_hint_window (3 hours by default), after which
     * only repair can bring the replica up to date.
     * (Since Cassandra 3.0 hints live in local files, not in system.hints.)
     */
    public HintedHandoffStatus checkHintedHandoff() {
        StorageProxyMBean proxy = getStorageProxy();   // via JMX
        long totalHints = proxy.getTotalHints();
        long hintsInProgress = proxy.getHintsInProgress();

        if (totalHints > 10000) {
            log.warn("High hint count: {} — indicates replica unavailability. " +
                "Payment data may be pending delivery to replicas.", totalHints);
        }

        return HintedHandoffStatus.builder()
            .totalHints(totalHints)
            .hintsInProgress(hintsInProgress)
            .build();
    }
}
```

تُحفظ التلميحات فقط خلال `max_hint_window` (3 ساعات افتراضيًا)، وبعدها لا يستطيع إلا الإصلاح (repair) تحديث النسخة. ومنذ Cassandra 3.0 تُخزن التلميحات في ملفات محلية لا في `system.hints`.

### متى يكون النصاب المرن خطرًا على البيانات المالية

يقدّم النصاب المرن الإتاحة على الاتساق الصارم. وفي مخزن يستخدمه، لم يعد `R + W > N` يضمن التداخل: فالقراءة بـ `R=2` بعد كتابة مرنة قد لا تتصل بالعقد الحاملة للتلميحات، فتعيد بيانات قديمة. أما في Cassandra فتتداخل قراءات QUORUM وكتاباتها العادية، لأن التلميحات لا تُحتسب. ولفحوص القراءة-قبل-الكتابة على بيانات تُكتب بمعاملات خفيفة، استخدم قراءة SERIAL (أو LOCAL_SERIAL):

```java
@Service
public class FinancialDataConsistencyPolicy {

    /**
     * A LOCAL_SERIAL read is linearizable: it runs a Paxos round on a quorum
     * of the key's replicas in the local DC and first completes any
     * lightweight transaction still in flight for this key.
     */
    public boolean isPaymentAmountValid(UUID paymentId, long expectedAmount) {
        BoundStatement stmt = readPaymentStmt.bind(paymentId)
            .setConsistencyLevel(ConsistencyLevel.LOCAL_SERIAL);

        Row row = session.execute(stmt).one();
        return row != null && row.getLong("amount_cents") == expectedAmount;
    }
}
```

---

## النصاب في DynamoDB

وصفت ورقة Dynamo من Amazon عام 2007 نسخًا بالنصاب دون قائد. أما DynamoDB، الخدمة المُدارة، فتعمل بشكل مختلف: لكل قسم ثلاث نسخ وقائد يُنتخب بـ Multi-Paxos؛ وتُؤكد الكتابة عندما تصبح دائمة على الأغلبية، وتخدم القائدُ القراءةَ القوية الاتساق. فمبدأ النصاب باقٍ داخل الخدمة، مخفيًا عن المستخدمين.

```java
@Service
public class DynamoDbPaymentRepository {

    private final DynamoDbClient dynamoClient;
    private static final String TABLE = "PaymentTransactions";

    /**
     * DynamoDB strongly consistent read is served by the partition leader.
     * For payment systems, always use strongly consistent reads for
     * authorization checks.
     */
    public Optional<PaymentItem> findPayment(String paymentId) {
        GetItemRequest request = GetItemRequest.builder()
            .tableName(TABLE)
            .key(Map.of("paymentId", AttributeValue.fromS(paymentId)))
            .consistentRead(true)   // Strongly consistent (leader) read
            .build();

        try {
            GetItemResponse response = dynamoClient.getItem(request);
            if (response.item().isEmpty()) {
                return Optional.empty();
            }
            return Optional.of(mapToPayment(response.item()));
        } catch (ProvisionedThroughputExceededException e) {
            throw new RateLimitException("DynamoDB throughput exceeded for payments table", e);
        }
    }

    /**
     * Eventually consistent read (default) is cheaper (half the cost)
     * and lower latency. Use only for non-critical reads like
     * transaction history display.
     */
    public List<PaymentItem> findPaymentHistoryEventual(String accountId,
                                                         Instant from,
                                                         Instant to) {
        QueryRequest request = QueryRequest.builder()
            .tableName(TABLE)
            .indexName("accountId-createdAt-index")
            .keyConditionExpression(
                "accountId = :aid AND createdAt BETWEEN :from AND :to")
            .expressionAttributeValues(Map.of(
                ":aid",  AttributeValue.fromS(accountId),
                ":from", AttributeValue.fromS(from.toString()),
                ":to",   AttributeValue.fromS(to.toString())
            ))
            .consistentRead(false)  // Eventually consistent — OK for history display
                                    // (a global secondary index supports only this)
            .build();

        return dynamoClient.queryPaginator(request)
            .items().stream()
            .map(this::mapToPayment)
            .collect(Collectors.toList());
    }

    /**
     * Conditional write (optimistic concurrency control using version attribute).
     * Ensures we don't overwrite a newer version — equivalent to CAS in Cassandra LWT.
     */
    public UpdateResult updatePaymentStatus(String paymentId,
                                             String newStatus,
                                             long expectedVersion) {
        UpdateItemRequest request = UpdateItemRequest.builder()
            .tableName(TABLE)
            .key(Map.of("paymentId", AttributeValue.fromS(paymentId)))
            .updateExpression(
                "SET #s = :newStatus, #v = :newVersion, updatedAt = :now")
            .conditionExpression("#v = :expectedVersion")
            .expressionAttributeNames(Map.of(
                "#s", "status",
                "#v", "version"
            ))
            .expressionAttributeValues(Map.of(
                ":newStatus",       AttributeValue.fromS(newStatus),
                ":newVersion",      AttributeValue.fromN(String.valueOf(expectedVersion + 1)),
                ":expectedVersion", AttributeValue.fromN(String.valueOf(expectedVersion)),
                ":now",             AttributeValue.fromS(Instant.now().toString())
            ))
            .build();

        try {
            dynamoClient.updateItem(request);
            return UpdateResult.success();
        } catch (ConditionalCheckFailedException e) {
            return UpdateResult.versionConflict(expectedVersion);
        }
    }
}
```

القراءة المتسقة نهائيًا (الافتراضية) أرخص (نصف الكلفة) وأقل زمنًا، فاستخدمها فقط للقراءات غير الحرجة مثل عرض تاريخ المعاملات. والكتابة الشرطية على رقم الإصدار تمنع الكتابة فوق إصدار أحدث — وهي تكافئ CAS في معاملات Cassandra الخفيفة.

---

## ROWA: اقرأ من واحدة واكتب في الكل

‏**ROWA** ‏(Read One, Write All) هي استراتيجية الاتساق القوي القصوى: يجب أن تؤكد **كل** النسخ كل كتابة، لكن القراءة يمكن أن تذهب إلى أي نسخة واحدة.

```
ROWA: R=1, W=N
R + W = 1 + N > N ✓ (strong consistency)
```

نادرًا ما تُستخدم ROWA عمليًا لأن نسخة واحدة غير متاحة تحجب **كل** الكتابات — إتاحة سيئة. لكن نسخة منها تُستخدم لمجموعات بيانات صغيرة وحرجة يمكن تحمّل حجب كتاباتها:

```java
@Service
public class RiskParameterStore {

    /**
     * Risk parameters (velocity limits, country blacklists, BIN block lists)
     * are written rarely but read on every transaction.
     * ROWA is appropriate here: writes are infrequent, reads must be fast
     * and always see the latest risk rules.
     */
    private final List<RiskParameterReplica> allReplicas;

    public void updateRiskParameter(RiskParameter param) {
        // Write to ALL replicas before confirming
        List<CompletableFuture<Void>> writes = allReplicas.stream()
            .map(r -> CompletableFuture.runAsync(() -> r.write(param)))
            .collect(Collectors.toList());

        // Wait for ALL — this is the ROWA invariant
        CompletableFuture.allOf(writes.toArray(new CompletableFuture[0]))
            .orTimeout(5, TimeUnit.SECONDS)
            .join();  // Throws if any replica fails
        // If one replica fails, the others ALREADY have the new value and
        // reads disagree until it is fixed: keep retrying the failed replica
        // (roll forward) and alert — do not report success until all have it.

        log.info("Risk parameter {} written to all {} replicas",
            param.key(), allReplicas.size());
    }

    /**
     * Read from local replica only — always consistent because we wrote to all.
     */
    public RiskParameter readRiskParameter(String key) {
        return localReplica.read(key);
    }
}
```

معايير المخاطر (حدود السرعة، وقوائم الدول المحظورة، وقوائم BIN المحظورة) تُكتب نادرًا وتُقرأ مع كل معاملة. وإذا فشلت الكتابة على نسخة واحدة، فإن النسخ الأخرى لديها القيمة الجديدة **بالفعل** فتختلف القراءات حتى الإصلاح: استمر في إعادة المحاولة على النسخة الفاشلة (التقدم للأمام) ونبّه — ولا تعلن النجاح حتى تحصل كلها على القيمة.

---

## الاتساق القوي عبر النصاب

الجمع بين قراءات النصاب وكتاباته يقدّم أقوى ضمان اتساق ممكن دون قفل عام. وفي الأنظمة المالية، هذا هو الحد الأدنى المقبول لأي عملية تؤثر في حالة الحساب.

### النصاب في عنقود دفع من 5 عقد

```java
@Service
public class FiveNodeQuorumPaymentLedger {

    // N=5, W=3, R=3 → R+W=6>5 ✓
    // This tolerates 2 node failures on both reads and writes
    private static final int N = 5;
    private static final int W = 3;
    private static final int R = 3;

    private final List<LedgerReplica> replicas;

    // Teaching sketch: a hand-rolled quorum. Real systems use Raft/Paxos or a
    // quorum database instead — the "rollback" below is not safe if a reader
    // already saw the partial write.
    public WriteReceipt writeLedgerEntry(LedgerEntry entry) {
        List<CompletableFuture<ReplicaAck>> writes = replicas.stream()
            .map(r -> CompletableFuture
                .supplyAsync(() -> r.write(entry))
                .orTimeout(500, TimeUnit.MILLISECONDS)
                .exceptionally(ex -> ReplicaAck.failed(r.nodeId(), ex.getMessage())))
            .collect(Collectors.toList());

        int acks = 0;
        List<String> succeeded = new ArrayList<>();
        List<String> failed = new ArrayList<>();

        for (CompletableFuture<ReplicaAck> f : writes) {
            ReplicaAck ack = f.join();
            if (ack.isSuccessful()) {
                succeeded.add(ack.nodeId());
                acks++;
            } else {
                failed.add(ack.nodeId());
                log.warn("Replica {} failed to acknowledge ledger write: {}",
                    ack.nodeId(), ack.error());
            }
        }

        if (acks < W) {
            // Roll back any partial writes
            rollbackPartialWrites(entry.id(), succeeded);
            throw new QuorumWriteFailedException(
                String.format("Ledger write quorum not met: %d/%d acks (need %d). Failed: %s",
                    acks, N, W, failed));
        }

        return WriteReceipt.builder()
            .entryId(entry.id())
            .ackedBy(succeeded)
            .ackedCount(acks)
            .requiredAcks(W)
            .build();
    }

    public LedgerEntry readLedgerEntry(String entryId) {
        List<CompletableFuture<ReplicaReadResult>> reads = replicas.stream()
            .map(r -> CompletableFuture
                .supplyAsync(() -> r.read(entryId))
                .orTimeout(300, TimeUnit.MILLISECONDS)
                .exceptionally(ex -> ReplicaReadResult.failed(r.nodeId())))
            .collect(Collectors.toList());

        List<LedgerEntry> results = new ArrayList<>();
        int successCount = 0;

        for (CompletableFuture<ReplicaReadResult> f : reads) {
            ReplicaReadResult result = f.join();
            if (result.isSuccessful()) {
                results.add(result.entry());
                successCount++;
            }
        }

        if (successCount < R) {
            throw new QuorumReadFailedException(
                String.format("Read quorum not met: %d/%d responses (need %d)",
                    successCount, N, R));
        }

        // Return the most recently written version (highest version wins)
        return results.stream()
            .max(Comparator.comparingLong(LedgerEntry::version))
            .orElseThrow();
    }

    private void rollbackPartialWrites(String entryId, List<String> succeeded) {
        succeeded.forEach(nodeId -> {
            try {
                LedgerReplica replica = findReplica(nodeId);
                replica.rollback(entryId);
            } catch (Exception e) {
                log.error("Failed to rollback partial write on {}: {}", nodeId, e.getMessage());
            }
        });
    }
}
```

هذا مخطط تعليمي لنصاب مصنوع يدويًا. أما الأنظمة الحقيقية فتستخدم Raft/Paxos أو قاعدة بيانات بالنصاب — فـ "التراجع" هنا غير آمن إذا رأى قارئ الكتابة الجزئية بالفعل. وعند القراءة يفوز الإصدار الأعلى.

---

## مفاضلات البيانات المالية

لأجزاء نظام الدفع المختلفة متطلبات اتساق مختلفة. واستخدام إعداد النصاب نفسه في كل مكان يؤدي إما إلى إفراط هندسي (زمن عالٍ للقراءات غير الحرجة) أو تفريط (بيانات قديمة للعمليات الحرجة).

```java
@Configuration
public class FinancialDataConsistencyMatrix {

    /**
     * Consistency requirement matrix for a payment processing system.
     * Design principle: each data type gets the MINIMUM consistency
     * level that meets its business requirements.
     */

    // Account balances during payment authorization — MUST be strongly consistent
    // Wrong: payment could overdraw account
    public ConsistencyLevel accountBalanceAuthorizationRead() {
        return ConsistencyLevel.QUORUM;  // R+W>N
    }

    // Account balances for display — eventual consistency acceptable
    // Wrong: stale balance shown on dashboard (annoying but not harmful)
    public ConsistencyLevel accountBalanceDashboardRead() {
        return ConsistencyLevel.ONE;  // Lower latency, slight staleness OK
    }

    // Payment idempotency key claims — MUST be linearizable
    // Wrong: same payment processed twice → double charge
    public ConsistencyLevel idempotencyKeyWrite() {
        return ConsistencyLevel.SERIAL;  // Paxos-based CAS
    }

    // Fraud rules — strongly consistent writes, single-replica reads OK
    // Wrong write: stale fraud rules allow fraudulent transaction
    // Wrong read: local replica always has latest (ROWA write pattern)
    public ConsistencyLevel fraudRuleWrite() {
        return ConsistencyLevel.ALL;  // Write to all replicas (ROWA)
    }

    public ConsistencyLevel fraudRuleRead() {
        return ConsistencyLevel.ONE;  // Can read from any replica (ROWA guarantee)
    }

    // Transaction history — eventual consistency acceptable
    // Wrong: stale history display (corrects within seconds)
    public ConsistencyLevel transactionHistoryRead() {
        return ConsistencyLevel.ONE;
    }

    // Audit log — must be durable on majority; never read with inconsistency
    public ConsistencyLevel auditLogWrite() {
        return ConsistencyLevel.QUORUM;
    }
}
```

المبدأ: كل نوع بيانات يحصل على **أدنى** مستوى اتساق يلبي متطلبات العمل. فأرصدة التفويض تحتاج QUORUM، وأرصدة العرض تكفيها ONE، ومفاتيح منع التكرار تحتاج SERIAL، وقواعد الاحتيال تُكتب بـ ALL وتُقرأ بـ ONE (نمط ROWA).

---

## المكافئ في SQL: النسخ المتزامن كنصاب

في PostgreSQL مع النسخ المتزامن، يمكن ضبط التزام النصاب — اشتراط تأكيد K من N نسخة احتياطية قبل تأكيد الكتابة:

```ini
# postgresql.conf
# Require acknowledgment from ANY 2 of 3 standbys (quorum commit)
synchronous_standby_names = 'ANY 2 (standby1, standby2, standby3)'

# This means: W = 1 (primary) + 2 (standbys) = 3
# With a quorum read (connecting to the primary after write):
# R = 1 (primary always has latest), W = 3
# R + W = 4 > N (1 primary + 3 standbys = 4), so R + W > N
```

```java
@Service
public class PostgresQuorumPaymentWriter {

    private final DataSource primaryDataSource;
    private final List<DataSource> standbyDataSources;

    /**
     * Writes to PostgreSQL primary with synchronous replication.
     * synchronous_commit = on makes COMMIT wait until the required
     * standbys have flushed the WAL.
     */
    public PaymentRecord writePayment(PaymentRequest request) {
        try (Connection conn = primaryDataSource.getConnection()) {
            conn.setAutoCommit(false);
            // SET LOCAL applies to this transaction only — a plain SET would
            // stay on the pooled connection for whoever uses it next
            try (PreparedStatement syncStmt = conn.prepareStatement(
                    "SET LOCAL synchronous_commit = 'on'")) {
                syncStmt.execute();
            }

            try (PreparedStatement ps = conn.prepareStatement(
                    "INSERT INTO payments " +
                    "(payment_id, amount_cents, currency, status, created_at) " +
                    "VALUES (?, ?, ?, 'PENDING', NOW()) " +
                    "RETURNING payment_id, created_at")) {
                ps.setObject(1, request.paymentId());
                ps.setLong(2, request.amountCents());
                ps.setString(3, request.currency());

                ResultSet rs = ps.executeQuery();
                rs.next();
                PaymentRecord record = PaymentRecord.builder()
                    .paymentId((UUID) rs.getObject("payment_id"))
                    .createdAt(rs.getTimestamp("created_at").toInstant())
                    .build();

                conn.commit();   // returns only after the standby quorum acknowledged
                return record;
            }
        } catch (SQLException e) {
            throw new PaymentWriteException("Failed to write payment", e);
        }
    }

    /**
     * Monitor replication lag to understand quorum health.
     * If lag exceeds threshold, the system is at risk of losing
     * quorum acknowledgments, potentially blocking writes.
     */
    public ReplicationLagReport checkReplicationLag() {
        String sql = """
            SELECT
                application_name,
                client_addr,
                state,
                EXTRACT(EPOCH FROM write_lag)  AS write_lag_s,
                EXTRACT(EPOCH FROM flush_lag)  AS flush_lag_s,
                EXTRACT(EPOCH FROM replay_lag) AS replay_lag_s,
                sync_state
            FROM pg_stat_replication
            ORDER BY replay_lag DESC NULLS LAST
            """;

        List<ReplicaLag> lags = new ArrayList<>();
        try (Connection conn = primaryDataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql);
             ResultSet rs = ps.executeQuery()) {

            while (rs.next()) {
                lags.add(ReplicaLag.builder()
                    .applicationName(rs.getString("application_name"))
                    .writeLagSeconds(rs.getDouble("write_lag_s"))
                    .flushLagSeconds(rs.getDouble("flush_lag_s"))
                    .replayLagSeconds(rs.getDouble("replay_lag_s"))
                    .syncState(rs.getString("sync_state"))
                    .build());
            }
        } catch (SQLException e) {
            log.error("Failed to check replication lag", e);
        }

        double maxLag = lags.stream()
            .mapToDouble(ReplicaLag::flushLagSeconds)
            .max()
            .orElse(0);

        if (maxLag > 1.0) {
            log.warn("Replication lag warning: max flush lag = {}s. " +
                "Payment write latency may increase.", maxLag);
        }

        return ReplicationLagReport.of(lags, maxLag);
    }
}
```

يُستخدم `SET LOCAL` لأنه يطبق على هذه المعاملة فقط — أما `SET` العادي فيبقى على الاتصال في المجموعة لمن يستخدمه بعدك. ولا يعود `COMMIT` إلا بعد أن يؤكد نصاب النسخ الاحتياطية.

---

## نصائح للإنتاج وأخطاء شائعة

### الخطأ 1: استخدام مستوى ONE لتفويض الدفع

أخطر خطأ في نظام دفع مبني على Cassandra هو استخدام `ConsistencyLevel.ONE` لقراءات تفويض الدفع. فمع نسخة تعطلت مؤخرًا ونسخ غير متزامن ما زال يلحق، قد تعيد `ONE` رصيدًا قديمًا يجعل السحب على المكشوف يبدو صالحًا:

```java
// WRONG — do not do this for payment authorization
public boolean hasSufficientFunds(UUID accountId, long amount) {
    // ONE only contacts 1 replica — may return stale balance
    Row row = session.execute(
        readBalanceStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.ONE)  // WRONG
    ).one();
    return row.getLong("balance_cents") >= amount;
}

// CORRECT
public boolean hasSufficientFunds(UUID accountId, long amount) {
    Row row = session.execute(
        readBalanceStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.LOCAL_QUORUM)  // CORRECT
    ).one();
    return row.getLong("balance_cents") >= amount;
}
```

### الخطأ 2: افتراض أن النصاب يمنع التعارضات

يضمن النصاب أن تقرأ آخر كتابة، لكنه **لا** يمنع تعارض الكتابات المتزامنة. فقد ينجح خصمان متزامنان على الحساب نفسه إذا لم يفحص أي منهما الرصيد تحت قفل:

```java
// WRONG — race condition: both writes pass the balance check
// if they execute concurrently
public void debit(UUID accountId, long amount) {
    long balance = readBalance(accountId);  // Both see $500
    if (balance >= amount) {               // Both pass: 500 >= 200
        writeNewBalance(accountId, balance - amount); // Both write $300
    }
    // Account is now at $300 but should be $100 — $200 double-spent
}

// CORRECT — compare-and-set with a Cassandra LWT on the version you read
// (... SET balance_cents = ?, version = ? WHERE account_id = ? IF version = ?),
// retrying on conflict — see AccountBalanceService.debit() above.
// In PostgreSQL: SELECT ... FOR UPDATE, or UPDATE ... WHERE balance >= :amount.
public DebitResult debitWithCas(UUID accountId, long amount) {
    return accountBalanceService.debit(accountId, amount, idempotencyKey);
}
```

### الخطأ 3: عدم التعامل مع WriteTimeoutException

يعني `WriteTimeoutException` أن الكتابة ربما طُبقت على بعض النسخ لكنها لم تُؤكد على العدد الكافي لمستوى الاتساق المطلوب. وللعمليات الآمنة من التكرار تكون إعادة المحاولة آمنة. أما لعمليات الدفع غير الآمنة من التكرار، فيجب التحقق من نجاح الكتابة فعلًا قبل إعادة المحاولة:

```java
public void writePaymentSafely(Payment payment) {
    try {
        session.execute(writePaymentStmt.bind(...));
    } catch (WriteTimeoutException e) {
        // The write MAY have partially succeeded
        // Check the idempotency key before deciding to retry
        log.warn("Write timeout for payment {} — checking idempotency before retry",
            payment.id());

        Optional<PaymentRecord> existing = findByIdempotencyKey(payment.idempotencyKey());
        if (existing.isPresent()) {
            log.info("Payment {} already exists despite timeout — idempotent", payment.id());
            return; // Already written — do not retry
        }

        // Not found — safe to retry
        retryWrite(payment);
    }
}
```

---

## الخلاصة

توفر أنظمة النصاب الأساس الرياضي لضمانات الاتساق في قواعد البيانات المالية الموزعة. والأفكار الأساسية:

| الصيغة | المعنى |
|---|---|
| `R + W > N` | اتساق قوي — القراءات ترى دائمًا آخر الكتابات |
| `W = ALL` | ROWA — أقصى اتساق، وإتاحة كتابة منخفضة |
| `W = ⌊N/2⌋+1, R = ⌊N/2⌋+1` | نصاب الأغلبية — توازن بين الاتساق والإتاحة |
| `W = 1, R = 1` | لا ضمان اتساق — نهائي فقط |

للأنظمة المالية على Cassandra:
- تفويض الدفع: `LOCAL_QUORUM` للقراءة والكتابة
- مفاتيح منع التكرار: اتساق `SERIAL` ‏(Paxos)
- قواعد المخاطر: كتابة `ALL` + قراءة `ONE` (نمط ROWA)
- العرض والاستعلام: `LOCAL_ONE` لزمن أقل

صيغة النصاب ليست بناءً نظريًا فقط — بل ترتبط مباشرة بنتائج العمل. فنظام الدفع الذي يستخدم `ONE` للتفويض سيخصم من عميل مرتين في النهاية. والنظام الذي يستخدم `ALL` ستكون إتاحته غير مقبولة أثناء عمليات النشر الروتينية. وإعداد النصاب الصحيح قرار هندسي له عواقب مالية وتنظيمية مباشرة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "في عنقود Cassandra فيه N=5 نسخ، إذا كان W=3 وR=3، فهل الاتساق القوي مضمون؟",
      "options": ["لا، لأن W+R=6 أكبر من N=5 فالتداخل غير مضمون", "نعم، لأن R+W=6 > N=5 يضمن تداخل نسخة واحدة على الأقل بين أي نصاب قراءة ونصاب كتابة", "فقط إذا ضُبط عامل النسخ على ALL", "لا، الاتساق القوي يتطلب W=N"],
      "correct": 1,
      "explanation": "صيغة النصاب R+W > N تضمن أن أي نصاب قراءة وأي نصاب كتابة يشتركان في عقدة واحدة على الأقل. ومع R=3 وW=3 وN=5: ‏3+3=6 > 5، فعقدة واحدة على الأقل في المجموعتين، فتجد القراءة دائمًا آخر كتابة."
    },
    {
      "text": "فيمَ يُستخدم نمط ROWA (اقرأ من واحدة، واكتب في الكل) في الأنظمة المالية؟",
      "options": ["تعظيم إنتاجية القراءة لأحمال التحليلات", "ضمان أن كل نسخة لديها أحدث البيانات قبل تأكيد الكتابة، فيمكن أن تذهب القراءات إلى أي نسخة واحدة بثقة كاملة", "تقليل زمن الكتابة بتجميع التحديثات إلى النسخ", "تمكين القراءات عبر مراكز البيانات دون تنسيق النصاب"],
      "correct": 1,
      "explanation": "يكتب ROWA في كل النسخ N ‏(W=N) قبل تأكيد النجاح. وهذا يضمن أن أي نسخة واحدة لديها أحدث البيانات، فيمكن للقراءات استخدام R=1 لأدنى زمن. ويُستخدم لبيانات مثل قواعد المخاطر حيث يهم زمن القراءة ويمكن التضحية بإتاحة الكتابة."
    },
    {
      "text": "لماذا يُستخدم مستوى SERIAL ‏(Paxos) في Cassandra لحجز مفاتيح منع التكرار بدل LOCAL_QUORUM؟",
      "options": ["SERIAL أسرع من LOCAL_QUORUM لعمليات مفتاح-قيمة الصغيرة", "قد يسمح LOCAL_QUORUM لطلبين متزامنين بقراءة 'المفتاح غير موجود' وإنشاء السجل نفسه معًا؛ أما SERIAL فيستخدم المعاملات الخفيفة للمقارنة والتعيين ذريًا", "يعمل SERIAL عبر مراكز البيانات بينما LOCAL_QUORUM محصور في المركز", "مفاتيح منع التكرار كبيرة جدًا للنسخ القائم على النصاب"],
      "correct": 1,
      "explanation": "قراءات LOCAL_QUORUM وكتاباته ليست ذرية كوحدة — فقد يقرأ طلبان متزامنان 'المفتاح غائب' ويكتبان معًا، فيُنشأ سجل مكرر. أما اتساق SERIAL في Cassandra فيستخدم جولة Paxos (معاملة خفيفة) لحجز المفتاح ذريًا فقط إذا لم يكن موجودًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "إعداد النصاب والتحقق من الاتساق لمساحة مفاتيح المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "أنشئ مساحة مفاتيح Cassandra للمدفوعات بعامل نسخ 3. وجرّب إعدادات النصاب الأربعة (W=1/R=3، وW=2/R=2، وW=3/R=1، وW=3/R=3) وتحقق من أيها يحقق R+W > N = 3. واكتب اختبارًا يُثبت أن القراءة القديمة ممكنة عندما R+W <= N."},
    {"id": "2", "description": "نفّذ تسجيل مفاتيح منع التكرار في Cassandra باستخدام معاملة خفيفة (IF NOT EXISTS). واكتب اختبارًا متزامنًا يطلق 50 طلبًا متوازيًا بمفتاح منع التكرار نفسه، ويتحقق من أن واحدًا بالضبط ينجح بـ APPLIED=true وأن البقية تتلقى السجل الموجود."},
    {"id": "3", "description": "حاكِ تعطل نسخة بإيقاف إحدى عقد Cassandra الثلاث. وتحقق من أن كتابات LOCAL_QUORUM ‏(W=2) ما زالت تنجح، ثم تحقق من أن كتابات ALL ‏(W=3) تفشل. وقِس الفرق في إتاحة الكتابة ووثّق المفاضلة لنظام دفع."},
    {"id": "4", "description": "ابنِ مراقب صحة للنصاب لخدمة Spring Boot: اعرض نقطة actuator مخصصة تستعلم كل نسخة Cassandra مباشرة وتبلغ عن عدد النسخ التي لديها أحدث إصدار من مفتاح مرجعي. وأطلق تنبيهًا عندما يكون عدد النسخ المتزامنة أقل من N/2+1."}
  ]
}
-->
