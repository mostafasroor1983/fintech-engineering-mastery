---
id: track-02-lesson-22
title: "إطار المهندس الرئيسي لقرارات الأنظمة الموزعة"
slug: distributed-systems-decision-framework
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 22
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, distributed-systems, trade-offs, staff-engineer, CAP]
prerequisites: []
---

# إطار المهندس الرئيسي لقرارات الأنظمة الموزعة

> [!NOTE]
> علامة المهندس الرئيسي في الأنظمة الموزعة ليست معرفة كل خوارزمية — بل معرفة أي خوارزمية تُستخدم في أي موقف، والقدرة على شرح المفاضلات بوضوح كافٍ ليتخذ فريقك قرارات مستنيرة بنفسه. وهذا الدرس إطار قرار منظم، لا نظرية جديدة.

## المشكلة الأساسية: القرارات دائمة

معظم القرارات المعمارية في الأنظمة الموزعة **لاصقة**. فاختيار Cassandra بدل PostgreSQL، أو Event Sourcing بدل CRUD، أو التواصل غير المتزامن بدل المتزامن، ليس قرارًا يمكن عكسه في الربع التالي. فكلفة الترحيل تزيد أسيًا مع حجم البيانات، وحجم الفريق، وعدد العملاء.

وهذا يعني أن كلفة القرار الخاطئ في الأنظمة الموزعة ليست تقنية فقط — بل تنظيمية ومالية وزمنية. والإطار الذي يفرض شرح المفاضلات صراحة قبل الالتزام ليس بيروقراطية؛ بل إدارة مخاطر.

---

## الإطار: خمسة أسئلة قبل أي قرار في الأنظمة الموزعة

### السؤال 1: ما متطلب الاتساق؟

قبل اختيار أي تقنية موزعة، صنّف البيانات أو العملية:

```
Consistency Classification for Financial Data:

LINEARIZABLE (Strongest)
  - Balance reads during payment authorization
  - Idempotency key claims
  - Risk limit checks
  - Fraud rule enforcement
  → Technology: PostgreSQL with synchronous replication, etcd, Cassandra SERIAL,
                CockroachDB, Spanner

STRONG (Sequential Consistency)
  - Transaction recording
  - Ledger entries
  - Settlement records
  → Technology: PostgreSQL, Cassandra LOCAL_QUORUM, CockroachDB

CAUSAL
  - Payment status updates visible after the status is set
  - Notification delivery after payment completes
  → Technology: Cassandra LOCAL_QUORUM, Kafka (ordered by partition), DynamoDB

EVENTUAL
  - Balance display on dashboard
  - Transaction history queries
  - Reporting and analytics
  - Fraud model scoring (batch)
  → Technology: Cassandra LOCAL_ONE, DynamoDB eventually consistent,
                Elasticsearch, read replicas
```

- **خطي (الأقوى)**: قراءات الرصيد أثناء تفويض الدفع، وحجز مفاتيح منع التكرار، وفحوص حدود المخاطر، وفرض قواعد الاحتيال.
- **قوي (تسلسلي)**: تسجيل المعاملات، وقيود دفتر الأستاذ، وسجلات التسوية.
- **سببي**: تحديثات حالة الدفع، والإشعار بعد اكتمال الدفع.
- **نهائي**: عرض الرصيد في لوحة المعلومات، واستعلامات تاريخ المعاملات، والتقارير والتحليلات.

```java
@Component
public class ConsistencyRequirementClassifier {

    public ConsistencyLevel classifyOperation(FinancialOperation operation) {
        return switch (operation.type()) {
            // Must be linearizable — wrong answer is a financial error
            case PAYMENT_AUTHORIZATION_READ    -> ConsistencyLevel.LINEARIZABLE;
            case IDEMPOTENCY_KEY_CLAIM         -> ConsistencyLevel.LINEARIZABLE;
            case RISK_LIMIT_CHECK              -> ConsistencyLevel.LINEARIZABLE;
            case BALANCE_CHECK_FOR_DEBIT       -> ConsistencyLevel.LINEARIZABLE;

            // Strong consistency — ordering matters, stale data is unacceptable
            case LEDGER_ENTRY_WRITE            -> ConsistencyLevel.STRONG;
            case SETTLEMENT_RECORD             -> ConsistencyLevel.STRONG;
            case COMPLIANCE_EVENT              -> ConsistencyLevel.STRONG;

            // Causal — events must appear in order to observers
            case PAYMENT_STATUS_UPDATE         -> ConsistencyLevel.CAUSAL;
            case NOTIFICATION_DELIVERY         -> ConsistencyLevel.CAUSAL;

            // Eventual — slight staleness is acceptable
            case BALANCE_DASHBOARD_DISPLAY     -> ConsistencyLevel.EVENTUAL;
            case TRANSACTION_HISTORY_QUERY     -> ConsistencyLevel.EVENTUAL;
            case ANALYTICS_READ                -> ConsistencyLevel.EVENTUAL;
        };
    }
}
```

### السؤال 2: ما متطلب الإتاحة أثناء الانقسام؟

تفرض نظرية CAP الاختيار بين الاتساق والإتاحة عند وقوع انقسام في الشبكة. ويجب أن يكون هذا الاختيار صريحًا وموثقًا، لا أن يُتخذ مصادفة بإعداد افتراضي.

```
CAP Decision Matrix for Financial Operations:

OPERATION                    | PARTITION BEHAVIOR    | RATIONALE
-----------------------------|----------------------|---------------------------
Payment authorization        | Reject (CP)          | Cannot risk double charge
Balance debit                | Reject (CP)          | Cannot risk overdraft
Idempotency check            | Reject (CP)          | Cannot risk duplicate
Risk limit enforcement       | Reject (CP)          | Cannot exceed limits

Payment status query         | Serve stale (AP)     | Stale status < 503 to customer
Transaction history          | Serve stale (AP)     | Customer tolerates slight delay
Exchange rate display        | Serve stale (AP)     | Indicative rate OK; execution uses live
Fraud score lookup (non-block)| Serve default (AP)  | Allow with conservative fallback
```

تفويض الدفع، وخصم الرصيد، وفحص منع التكرار، وفرض حدود المخاطر تُرفض أثناء الانقسام (CP). أما استعلام حالة الدفع، وتاريخ المعاملات، وعرض سعر الصرف، فتُخدم ببيانات قديمة (AP)، ويُعاد لفحص الاحتيال غير الحاجب قيمة افتراضية متحفظة.

```java
@Service
public class PartitionBehaviorPolicy {

    private final FeatureFlagClient featureFlags;

    /**
     * Defines what each operation does during a network partition.
     * This must be an explicit, reviewed decision — not an accident.
     */
    public PartitionResponse handlePartition(FinancialOperation operation) {
        return switch (operation.type()) {
            case PAYMENT_AUTHORIZATION -> {
                // CP: reject with 503 Retry-After
                yield PartitionResponse.reject(
                    "Payment system temporarily unavailable due to network partition. " +
                    "Your account has NOT been charged. Please retry in 30 seconds.",
                    Duration.ofSeconds(30)
                );
            }
            case FRAUD_SCORE_LOOKUP -> {
                // AP with fallback: return a conservative default score.
                // The "allow all" flag must default to OFF and be switched on
                // only by a deliberate, logged risk decision
                FraudScore fallback = featureFlags.isEnabled("fraud-fallback-allow-all")
                    ? FraudScore.LOW_RISK_DEFAULT
                    : FraudScore.HIGH_RISK_DEFAULT;
                yield PartitionResponse.serveDefault(fallback);
            }
            case EXCHANGE_RATE_QUERY -> {
                // AP: serve last known rate with staleness header
                ExchangeRate cachedRate = localCache.getLastKnown(operation.currencyPair());
                yield PartitionResponse.serveStale(cachedRate, Duration.ofMinutes(5));
            }
            case TRANSACTION_HISTORY -> {
                // AP: serve from local replica even if possibly stale
                yield PartitionResponse.serveStale(null, Duration.ofMinutes(1));
            }
            // Anything not explicitly classified: fail safe (CP)
            default -> PartitionResponse.reject(
                "Temporarily unavailable. Please retry.", Duration.ofSeconds(30));
        };
    }
}
```

يجب أن يكون علم "السماح للجميع" معطلًا افتراضيًا، ولا يُفعّل إلا بقرار مخاطر متعمد ومسجّل. وأي عملية غير مصنفة صراحة تفشل بأمان (CP).

### السؤال 3: ما ميزانية الزمن؟

تضيف العمليات الموزعة زمنًا في كل خطوة. وميزانية الزمن لمعاملة مالية تقيّد التقنيات والأنماط الممكنة.

```
Latency Budget: Payment Authorization (target: p99 < 300ms)

Component                      | Budget  | Technology Choice Implications
-------------------------------|---------|--------------------------------
API gateway overhead           | 5ms     | -
Auth/JWT validation            | 5ms     | Local validation only (no remote call)
Idempotency check              | 15ms    | Redis or Cassandra SERIAL (< 20ms)
Fraud score lookup             | 50ms    | Pre-scored or cached, circuit breaker
Account balance check          | 30ms    | PostgreSQL primary, indexed lookup
Payment write (DB)             | 50ms    | Synchronous replication write
Outbox insert (same DB txn)    | 2ms     | Event published later by a relay
Response serialization         | 5ms     | -
Network (internal)             | 20ms    | Same-region only
Buffer / p99 headroom          | 118ms   | For GC pauses, lock contention
-------------------------------|---------|--------------------------------
Total                          | 300ms   | ✓ Fits budget
```

لاحظ أن الحدث يُكتب في جدول outbox ضمن معاملة قاعدة البيانات نفسها (2ms)، ثم ينشره مرحّل لاحقًا — لا "أرسل وانسَ" إلى Kafka.

```java
@Service
public class LatencyBudgetEnforcer {

    private final MeterRegistry meterRegistry;

    /**
     * Wraps a downstream call with a strict timeout derived from the latency budget.
     * If the call exceeds the budget, it fails fast rather than cascading the latency.
     * Note: orTimeout() stops WAITING but does not stop the call itself, so also
     * set the client's own timeout (HTTP read timeout, gRPC deadline). And only
     * use a fallback where a default is safe — never for a debit.
     */
    public <T> T callWithBudget(String operationName,
                                 Duration budget,
                                 Callable<T> operation,
                                 Supplier<T> fallback) {
        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            T result = CompletableFuture
                .supplyAsync(() -> {   // in production: a dedicated, bounded executor
                    try { return operation.call(); }
                    catch (Exception e) { throw new RuntimeException(e); }
                })
                .orTimeout(budget.toMillis(), TimeUnit.MILLISECONDS)
                .join();

            sample.stop(meterRegistry.timer(operationName + ".latency",
                "result", "success"));
            return result;

        } catch (CompletionException e) {
            sample.stop(meterRegistry.timer(operationName + ".latency",
                "result", "timeout"));
            log.warn("Operation {} exceeded budget of {}ms — using fallback",
                operationName, budget.toMillis());
            return fallback.get();
        }
    }
}
```

يوقف `orTimeout()` **الانتظار** لكنه لا يوقف الاستدعاء نفسه، فاضبط أيضًا مهلة العميل نفسه (مهلة قراءة HTTP، أو مهلة gRPC). ولا تستخدم البديل إلا حيث تكون القيمة الافتراضية آمنة — لا للخصم أبدًا.

### السؤال 4: متزامن أم غير متزامن؟

هذا من أخطر القرارات أثرًا في نظام دفع موزع. فالتواصل المتزامن يسهّل التفكير في الاتساق لكنه يزيد الاقتران والزمن. أما التواصل غير المتزامن فيحسّن المرونة والإنتاجية لكنه يتطلب تعاملًا صريحًا مع الاتساق النهائي وأنماط الفشل.

```
Decision: Synchronous vs Asynchronous

USE SYNCHRONOUS when:
  ✓ The caller needs the result to proceed (payment authorization response)
  ✓ The operation must succeed or fail atomically within the caller's transaction
  ✓ Latency is bounded and within SLA
  ✓ The callee is in the same availability zone (< 5ms network hop)
  ✗ Avoid if callee can be slow (adds latency to every caller)
  ✗ Avoid if callee can fail independently (couples availability)

USE ASYNCHRONOUS (Kafka/messaging) when:
  ✓ Caller does not need the result immediately
  ✓ The operation can be retried independently on failure
  ✓ The operation is idempotent (or can be made so)
  ✓ You want to decouple throughput between producer and consumer
  ✓ Multiple consumers need to react to the same event
  ✗ Avoid if the caller must know immediately whether the operation succeeded
  ✗ Avoid without an explicit plan for handling consumer failures
```

استخدم المتزامن عندما يحتاج المستدعي النتيجة ليكمل، أو يجب أن تنجح العملية أو تفشل ذريًا ضمن معاملته، والزمن محدود. واستخدم غير المتزامن عندما لا يحتاج المستدعي النتيجة فورًا، ويمكن إعادة محاولة العملية باستقلال، وهي آمنة من التكرار، أو يحتاج عدة مستهلكين للتفاعل مع الحدث نفسه.

```java
@Service
public class PaymentOrchestrationService {

    private final FraudDetectionClient fraudClient;        // Sync: needed to authorize
    private final AccountLedgerService ledgerService;      // Sync: needed for debit
    private final OutboxRepository     outbox;             // Async: post-authorization
    private final TransactionTemplate  tx;

    // Not @Transactional as a whole: the remote fraud call must not hold a
    // database connection (and possibly row locks) while it waits
    public AuthorizationResult authorize(PaymentRequest request) {
        // SYNCHRONOUS: fraud check is on the critical path
        // We cannot authorize without it
        FraudAssessment fraud = fraudClient.assess(request);
        if (fraud.isHighRisk()) {
            return AuthorizationResult.declined("Fraud risk too high");
        }

        return tx.execute(status -> {
            // SYNCHRONOUS: balance debit must be atomic with authorization
            // Doing this async would create a window for race conditions
            DebitResult debit = ledgerService.debit(
                request.accountId(), request.amount(), request.idempotencyKey());
            if (!debit.isSuccessful()) {
                return AuthorizationResult.declined(debit.reason());
            }

            // ASYNCHRONOUS: written to the outbox in the SAME transaction as the
            // debit; a relay publishes it to Kafka ("payment-authorized") after
            // commit. Consumers — including the notification service — handle
            // it independently, with retries. (Sending to Kafka or starting the
            // notification directly here could announce a payment whose
            // transaction then rolls back.)
            outbox.save(OutboxEvent.of("payment-authorized", request.paymentId(),
                PaymentAuthorizedEvent.from(request, debit)));

            return AuthorizationResult.approved(debit.transactionId());
        });
    }
}
```

لا تكون الطريقة كلها معاملة واحدة: فاستدعاء الاحتيال البعيد يجب ألا يحتجز اتصال قاعدة بيانات (وربما أقفال صفوف) أثناء انتظاره. ويُكتب الحدث في outbox ضمن معاملة الخصم نفسها، فإرساله مباشرة إلى Kafka أو بدء الإشعار هنا قد يعلن دفعة تتراجع معاملتها لاحقًا.

### السؤال 5: معاملات موزعة أم Sagas؟

النمطان للحفاظ على الاتساق عبر عدة خدمات:

```
DISTRIBUTED TRANSACTIONS (2PC/XA):
  ✓ Atomic: all services commit or all roll back
  ✓ Familiar: developers know ACID semantics
  ✗ Blocking: coordinator failure leaves resources locked
  ✗ Availability: all participants must be available simultaneously
  ✗ Scalability: does not work across polyglot stores or external APIs
  → Best for: single-database multi-table updates, same-service multi-step

SAGAS:
  ✓ Available: each step is a local transaction; partial failures are recoverable
  ✓ Scalable: each service manages its own data
  ✓ Works with external systems (bank APIs, card networks)
  ✗ Eventually consistent: intermediate states are visible
  ✗ Complex compensating transactions must be explicitly designed
  ✗ Harder to reason about failure modes
  → Best for: multi-service business workflows (payment, transfer, refund)
```

**المعاملات الموزعة (2PC/XA)** ذرية ومألوفة، لكنها حاجبة عند تعطل المنسّق، وتتطلب إتاحة كل المشاركين معًا، ولا تعمل عبر المخازن المختلفة أو الواجهات الخارجية — وأفضل استخدام لها تحديث عدة جداول في قاعدة واحدة. أما **Sagas** فمتاحة وقابلة للتوسع وتعمل مع الأنظمة الخارجية (واجهات البنوك، وشبكات البطاقات)، لكنها متسقة نهائيًا وتتطلب تصميم معاملات تعويضية صريحة — وأفضل استخدام لها سير العمل عبر عدة خدمات.

```java
// Saga implementation for a cross-border payment
@Service
public class CrossBorderPaymentSaga {

    // Each step: local transaction + compensation

    // Step 1: Debit source account
    public DebitResult debitSourceAccount(SagaContext ctx) {
        return accountService.debit(
            ctx.sourceAccount(), ctx.amountCents(), ctx.sagaId());
    }

    public void compensateDebit(SagaContext ctx) {
        // Compensation: reverse the debit
        accountService.credit(
            ctx.sourceAccount(), ctx.amountCents(), ctx.sagaId() + "-compensation");
    }

    // Step 2: Convert currency (calls external FX provider)
    public FxConversionResult convertCurrency(SagaContext ctx, DebitResult debit) {
        return fxProvider.convert(
            ctx.amountCents(), ctx.sourceCurrency(), ctx.targetCurrency());
    }

    public void compensateFxConversion(SagaContext ctx, FxConversionResult fx) {
        // Compensation: reverse FX (reverse rate, fees may apply)
        fxProvider.reverseConversion(fx.conversionId());
    }

    // Step 3: Credit destination account
    public void creditDestinationAccount(SagaContext ctx, FxConversionResult fx) {
        accountService.credit(
            ctx.destinationAccount(), fx.convertedAmountCents(), ctx.sagaId());
    }

    public void compensateCreditDestination(SagaContext ctx, FxConversionResult fx) {
        // Compensation: debit back destination account
        // NOTE: this may fail if the customer has already spent the funds
        // → requires human intervention or escrow mechanism
        try {
            accountService.debit(
                ctx.destinationAccount(), fx.convertedAmountCents(),
                ctx.sagaId() + "-reversal");
        } catch (InsufficientFundsException e) {
            log.error("SAGA COMPENSATION FAILED: cannot debit destination account {}. " +
                "Manual intervention required. Saga: {}",
                ctx.destinationAccount(), ctx.sagaId());
            complianceAlerter.flagForManualReview(ctx.sagaId());
        }
    }
}
```

قد يفشل تعويض الإضافة إلى حساب الوجهة إذا كان العميل قد أنفق المبلغ بالفعل — فيلزم تدخل بشري أو آلية ضمان (escrow).

---

## قائمة التحقق للقرار

يجب إكمال هذه القائمة لأي مكوّن جديد في نظام موزع أو أي تغيير معماري مهم:

```java
/**
 * Distributed Systems Architecture Decision Record (ADR) Template
 * Adapt this for your team's ADR process.
 */
public class DistributedSystemsAdr {

    // === CONSISTENCY ===
    // [ ] What consistency level is required for each operation?
    //     (Linearizable / Strong / Causal / Eventual)
    // [ ] Is eventual consistency acceptable for READ operations? (dashboard, history)
    // [ ] Does the data type have natural conflict resolution? (last-write-wins OK?)

    // === AVAILABILITY ===
    // [ ] What should happen during a network partition? (reject / serve stale / fallback)
    // [ ] What is the acceptable downtime per year? (99.9% = 8.7h, 99.99% = 52m)
    // [ ] Is the system CP or AP? Is this choice documented?

    // === LATENCY ===
    // [ ] What is the p99 latency budget for each operation?
    // [ ] Have timeouts been explicitly set at each service boundary?
    // [ ] Has the latency been measured under realistic load?

    // === SYNCHRONY ===
    // [ ] Is each service call synchronous or asynchronous? Why?
    // [ ] Are idempotency keys implemented for all async operations?
    // [ ] Is there a dead-letter queue for failed async messages?

    // === TRANSACTIONS ===
    // [ ] Does the operation span multiple services / databases?
    // [ ] If yes: distributed transaction or saga? Why?
    // [ ] Are compensating transactions designed for all saga steps?
    // [ ] Can a saga step fail without compensation possible? (escalation path?)

    // === REPLICATION ===
    // [ ] How many replicas? What is the replication factor?
    // [ ] Synchronous or asynchronous replication?
    // [ ] What is the RPO (Recovery Point Objective)?
    // [ ] What is the RTO (Recovery Time Objective)?

    // === FAILURE MODES ===
    // [ ] What happens if a downstream service is unavailable?
    //     (circuit breaker / retry / fallback / fail open / fail closed)
    // [ ] What happens during split-brain?
    // [ ] Has chaos testing validated the failure behavior?

    // === OBSERVABILITY ===
    // [ ] Are SLIs defined and instrumented?
    // [ ] Is distributed tracing configured across all hops?
    // [ ] Are alerts configured for SLO violations?
}
```

تغطي القائمة: الاتساق، والإتاحة (99.9% = 8.7 ساعات توقف سنويًا، و99.99% = 52 دقيقة)، والزمن، والتزامن، والمعاملات، والنسخ (RPO وRTO)، وأنماط الفشل، وقابلية المراقبة.

---

## CAP عمليًا: امتداد PACELC

توسّع **نظرية PACELC** نظرية CAP بملاحظة أنه حتى دون انقسام، توجد مفاضلة بين الزمن والاتساق:

```
PACELC: If Partition → (Availability vs Consistency)
        Else         → (Latency vs Consistency)

System Examples:
  DynamoDB:       PA / EL  — Available during partition, low latency normally (eventual)
  DynamoDB (SC):  PC / EC  — Consistent during partition, higher latency for consistency
  Cassandra (Q):  ~PC / EC — Quorum reads/writes: closer to consistent, adds latency
                             (Cassandra is PA/EL by design; LWT for linearizable)
  Cassandra (1):  PA / EL  — ONE read/write: available, low latency, eventual
  PostgreSQL sync: PC / EC  — Synchronous replication: consistent, adds ~1-5ms
  PostgreSQL async:PA / EL  — Async replication: available, lower latency, slight lag
  Spanner/CockroachDB: PC / EC — Always consistent, pays latency for it
```

```java
@Component
public class PacelcTechnologySelector {

    /**
     * Maps PACELC preferences to technology recommendations
     * for financial system components.
     */
    public TechnologyRecommendation recommend(DataAccessPattern pattern) {

        if (pattern.requiresLinearizability() && pattern.toleratesHigherLatency()) {
            return TechnologyRecommendation.builder()
                .primary("CockroachDB or Google Spanner")
                .alternative("PostgreSQL with synchronous replication")
                .pacelc("PC/EC")
                .note("Payment authorization, ledger writes — correctness over speed")
                .build();
        }

        if (pattern.requiresStrongConsistency() && pattern.isLatencySensitive()) {
            return TechnologyRecommendation.builder()
                .primary("PostgreSQL primary (reads on the primary or a remote_apply standby)")
                .alternative("Cassandra LOCAL_QUORUM reads and writes")
                .pacelc("PC/EC")
                .note("Async read replicas are NOT strongly consistent — keep these reads off them")
                .build();
        }

        if (pattern.toleratesEventualConsistency() && pattern.requiresHighThroughput()) {
            return TechnologyRecommendation.builder()
                .primary("Cassandra LOCAL_ONE")
                .alternative("DynamoDB eventually consistent")
                .pacelc("PA/EL")
                .note("Transaction history, balance display — high read throughput")
                .build();
        }

        if (pattern.requiresLinearizableCoordination() && pattern.isLowThroughput()) {
            return TechnologyRecommendation.builder()
                .primary("etcd or ZooKeeper")
                .alternative("PostgreSQL advisory locks + fencing tokens")
                .pacelc("PC/EC")
                .note("Distributed locks, leader election, configuration")
                .build();
        }

        throw new UnclassifiablePatternException(
            "Cannot recommend technology for pattern: " + pattern.describe() +
            ". Please classify consistency and latency requirements explicitly.");
    }
}
```

النسخ المتماثلة غير المتزامنة للقراءة **ليست** متسقة بقوة — فأبعد عنها القراءات التي تحتاج اتساقًا قويًا. وللتنسيق الخطي (الأقفال، وانتخاب القائد) استخدم etcd أو ZooKeeper، أو الأقفال الاستشارية في PostgreSQL مع رموز التسييج.

---

## أنماط خاطئة شائعة في الأنظمة المالية الموزعة

### النمط الخاطئ 1: النظام الموحّد الموزع

خدمات مصغّرة تستدعي بعضها بشكل متزامن في سلسلة من 7 خطوات أو أكثر لدفعة واحدة:

```
Payment API → Auth Service → Fraud Service → Account Service →
Ledger Service → Notification Service → Analytics Service
(all synchronous, all blocking)

Problems:
- Availability: 7 services at 99.9% each = 99.3% combined
- Latency: each hop adds 10-50ms
- Failure coupling: any service failure fails the entire payment
```

الإتاحة: 7 خدمات بإتاحة 99.9% لكل منها = 99.3% مجتمعة. والزمن: كل خطوة تضيف 10-50ms. واقتران الأعطال: تعطل أي خدمة يُفشل الدفعة كلها.

```java
// Refactored: parallelize independent calls, async for non-critical
@Service
public class PaymentApiService {

    public AuthorizationResult authorize(PaymentRequest request) {
        // Run independent checks in parallel to reduce latency — on a dedicated
        // executor, each with its own timeout
        CompletableFuture<FraudAssessment> fraudFuture =
            CompletableFuture.supplyAsync(() -> fraudService.assess(request), checksExecutor)
                .orTimeout(200, TimeUnit.MILLISECONDS);
        CompletableFuture<RiskAssessment> riskFuture =
            CompletableFuture.supplyAsync(() -> riskService.assess(request), checksExecutor)
                .orTimeout(200, TimeUnit.MILLISECONDS);

        // Wait for both (parallel)
        FraudAssessment fraud = fraudFuture.join();
        RiskAssessment risk = riskFuture.join();

        if (fraud.isHighRisk() || risk.isAboveLimit()) {
            return AuthorizationResult.declined("Risk threshold exceeded");
        }

        // Critical path: account debit (must be synchronous)
        DebitResult debit = accountService.debit(request);

        // Post-authorization: async — via the outbox in production, written
        // in the debit's transaction (see PaymentOrchestrationService above)
        outbox.save(OutboxEvent.of("payment-authorized", request.paymentId(),
            PaymentAuthorizedEvent.from(request, debit)));

        return AuthorizationResult.approved(debit.transactionId());
    }
}
```

تُشغّل الفحوص المستقلة بالتوازي على منفّذ مخصص بمهلة لكل منها، ويبقى الخصم متزامنًا، ويُرسل الحدث اللاحق عبر outbox.

### النمط الخاطئ 2: قاعدة البيانات المشتركة

خدمات مصغّرة متعددة تتشارك مخطط قاعدة البيانات نفسه تُفشل هدف استقلالية الخدمات:

```sql
-- Anti-pattern: fraud-service and account-service both write to this table
-- This creates implicit coupling and prevents independent deployment
CREATE TABLE accounts (
    account_id    UUID PRIMARY KEY,
    balance_cents BIGINT,
    fraud_score   DECIMAL,     -- fraud-service writes this
    risk_level    VARCHAR(20), -- risk-service writes this
    last_login    TIMESTAMP    -- auth-service writes this
);

-- Correct: each service owns its own tables
-- account-service:
CREATE TABLE account_balances (account_id UUID, balance_cents BIGINT);

-- fraud-service (its own database or schema):
CREATE TABLE fraud_assessments (account_id UUID, fraud_score DECIMAL);
```

### النمط الخاطئ 3: غياب منع التكرار في العمليات غير المتزامنة

تُسلّم رسائل Kafka مرة واحدة على الأقل. ودون منع التكرار، فإن أي مستهلك يتعطل في منتصف المعالجة سيعالج الرسالة مرة أخرى عند إعادة التشغيل، وقد ينفّذ الدفعة نفسها مرتين:

```java
// Anti-pattern: no idempotency check
@KafkaListener(topics = "payment-instructions")
public void processPayment(PaymentInstruction instruction) {
    ledgerService.createEntry(instruction); // May be called twice!
}

// Correct: claim the key and do the work in ONE database transaction.
// (Check -> process -> mark as separate steps still double-processes if the
// consumer crashes between processing and marking.)
@KafkaListener(topics = "payment-instructions")
@Transactional
public void processPayment(PaymentInstruction instruction) {
    // INSERT ... ON CONFLICT DO NOTHING — false if already processed
    if (!idempotencyStore.claim(instruction.idempotencyKey())) {
        log.info("Payment {} already processed — skipping duplicate message",
            instruction.idempotencyKey());
        return;
    }
    ledgerService.createEntry(instruction);   // same transaction as the claim
}
```

احجز المفتاح ونفّذ العمل في معاملة قاعدة بيانات **واحدة**. فالفحص ثم المعالجة ثم التعليم كخطوات منفصلة ما زال يعالج مرتين إذا تعطل المستهلك بين المعالجة والتعليم.

---

## بطاقة مرجعية لإطار القرار

```
DECISION                    QUESTIONS TO ASK                    WRONG DEFAULT
---------------------------------------------------------------------------
Consistency level?          Will stale data cause financial      Eventual
                            harm? → Yes: strong consistency

Sync vs async?              Does caller need result now?         Synchronous
                            → No: use async + idempotency        (too chatty)

Distributed txn vs saga?    Single DB or multi-service?         2PC everywhere
                            → Multi-service: saga + compensate   (not scalable)

Replication factor?         What is RPO? What is RTO?           1 replica
                            → RPO=0: sync replication            (no HA)

Quorum?                     Read-your-writes required?          R=1,W=1
                            → Yes: R + W > N                     (no consistency)

CP or AP?                   What fails during partition?        Neither (no plan)
                            → Document decision explicitly

Timeouts?                   What is the latency budget?         No timeout
                            → Every service call has a timeout   (cascading failure)

Circuit breaker?            Can callee fail independently?      No circuit breaker
                            → Yes: circuit breaker with fallback (cascade failure)

Idempotency?                Can this operation run twice?       Not idempotent
                            → Any async/retried op: idempotent   (double processing)
```

| القرار | السؤال | الافتراضي الخاطئ |
|---|---|---|
| مستوى الاتساق | هل تسبب البيانات القديمة ضررًا ماليًا؟ نعم ← اتساق قوي | نهائي |
| متزامن أم غير متزامن | هل يحتاج المستدعي النتيجة الآن؟ لا ← غير متزامن + منع التكرار | متزامن (ثرثرة زائدة) |
| معاملة موزعة أم Saga | قاعدة واحدة أم عدة خدمات؟ عدة خدمات ← Saga + تعويض | 2PC في كل مكان |
| عامل النسخ | ما RPO وRTO؟ RPO=0 ← نسخ متزامن | نسخة واحدة (بلا إتاحة عالية) |
| النصاب | هل يلزم قراءة كتاباتك؟ نعم ← R + W > N | R=1، W=1 |
| CP أم AP | ما الذي يفشل أثناء الانقسام؟ ← وثّق القرار صراحة | لا هذا ولا ذاك (بلا خطة) |
| المهل | ما ميزانية الزمن؟ ← مهلة لكل استدعاء | بلا مهلة |
| قاطع الدائرة | هل يمكن أن يفشل المستدعى باستقلال؟ نعم ← قاطع مع بديل | بلا قاطع |
| منع التكرار | هل يمكن أن تعمل العملية مرتين؟ ← كل عملية غير متزامنة أو معادة آمنة من التكرار | غير آمنة |

---

## الجمع بين كل شيء: قالب مراجعة البنية

```java
/**
 * Template for a distributed systems architecture review.
 * Use this in design reviews before any significant distributed
 * system is built or modified.
 */
public class DistributedArchitectureReview {

    public ReviewResult review(ArchitectureProposal proposal) {
        List<ReviewFinding> findings = new ArrayList<>();

        // 1. Consistency check
        proposal.operations().forEach(op -> {
            if (op.consistencyLevel() == ConsistencyLevel.EVENTUAL
                    && op.isFinancialWrite()) {
                findings.add(ReviewFinding.critical(
                    "Operation " + op.name() + " is a financial write with " +
                    "eventual consistency — this will cause lost updates and overdrafts"));
            }
        });

        // 2. Partition behavior check
        if (proposal.partitionBehavior() == null) {
            findings.add(ReviewFinding.critical(
                "No partition behavior defined — CP vs AP is undecided"));
        }

        // 3. Timeout check
        proposal.serviceCallsWithNoTimeout().forEach(call ->
            findings.add(ReviewFinding.major(
                "Service call to " + call.target() + " has no timeout — " +
                "will cascade failures")));

        // 4. Idempotency check
        proposal.asyncOperationsWithoutIdempotency().forEach(op ->
            findings.add(ReviewFinding.major(
                "Async operation " + op.name() + " is not idempotent — " +
                "will double-process on consumer restart")));

        // 5. Saga compensation check
        proposal.sagaStepsWithoutCompensation().forEach(step ->
            findings.add(ReviewFinding.major(
                "Saga step " + step.name() + " has no compensation — " +
                "partial failures will leave inconsistent state")));

        return ReviewResult.of(findings);
    }
}
```

---

## الخلاصة

دور المهندس الرئيسي في الأنظمة الموزعة ليس تنفيذ كل خوارزمية — بل ضمان اتخاذ كل قرار معماري صراحة، مع فهم المفاضلات وتوثيقها.

تشكّل الأسئلة الخمسة بروتوكول قرار:

1. **الاتساق**: ما المستوى المطلوب؟ صنّف كل عملية صراحة.
2. **سلوك الانقسام**: CP أم AP؟ وثّق سياسة سلوك الانقسام.
3. **ميزانية الزمن**: ما هدف p99؟ وهل يناسبه التصميم؟
4. **التزامن**: متزامن أم غير متزامن؟ لكل خطوة إجابة مبررة.
5. **نطاق المعاملة**: معاملة موزعة أم Saga؟ صمّم التعويضات.

نمط الفشل الشائع في الأنظمة المالية الموزعة ليس اختيار الخوارزمية الخطأ — بل اتخاذ هذه القرارات **ضمنيًا** عبر الإعدادات الافتراضية، أو الشيفرة المنسوخة، أو الطريق الأسهل. والإطار أعلاه يحوّل القرارات الضمنية إلى نتاجات صريحة قابلة للمراجعة والاختبار.

أصعب ما في الأنظمة الموزعة في مؤسسة مالية ليس الخوارزميات — بل الانضباط لتطبيق الإطار باستمرار، تحت الضغط، ومع قيود الأنظمة القديمة، مع الحفاظ على ثقة الجهات التنظيمية والمدققين والعملاء الذين يعتمدون على صحة النظام في كل مرة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "وفق الإطار، أي مستوى اتساق مطلوب لقراءات الرصيد أثناء تفويض الدفع؟",
      "options": ["الاتساق النهائي", "الاتساق القوي (التسلسلي)", "الخطية", "الاتساق السببي"],
      "correct": 2,
      "explanation": "تتطلب قراءات الرصيد في تفويض الدفع الخطية — أقوى نماذج الاتساق. فيجب أن تعكس أي قراءة آخر كتابة على مستوى النظام كله، دون قراءات قديمة. واستخدام الاتساق النهائي لفحوص الرصيد يخاطر بالسحب على المكشوف أو الإنفاق المزدوج."
    },
    {
      "text": "لماذا توصف معظم القرارات المعمارية في الأنظمة الموزعة بأنها 'لاصقة' في الإطار؟",
      "options": ["لأنها تتطلب جلسات لاصقة في موازن الحمل", "لأن عكسها صعب بعد نمو حجم البيانات والفريق وعدد العملاء — فكلفة الترحيل تزيد أسيًا", "لأنها يجب أن تعتمدها جهة تنظيمية قبل تغييرها", "لأن إعدادات الأنظمة الموزعة تُخزن في خرائط إعداد غير قابلة للتغيير"],
      "correct": 1,
      "explanation": "اختيار Cassandra بدل PostgreSQL، أو Event Sourcing بدل CRUD، أو التواصل غير المتزامن بدل المتزامن صعب العكس جدًا. فكلفة ترحيل البيانات، وتوافق الواجهات، وإعادة تدريب الفريق تنمو مع الحجم. ولهذا يكون اتخاذ القرار الصريح مسبقًا إدارة مخاطر، لا بيروقراطية."
    },
    {
      "text": "ما أول سؤال يطلب الإطار الإجابة عنه قبل اختيار أي تقنية موزعة؟",
      "options": ["ما مدى معرفة الفريق بالتقنية؟", "ما حجم البيانات المتوقع في الذروة؟", "ما متطلب الاتساق للبيانات أو العملية؟", "ما ميزانية البنية التحتية؟"],
      "correct": 2,
      "explanation": "السؤال الأول في الإطار هو تصنيف الاتساق: هل البيانات خطية، أم قوية، أم سببية، أم متسقة نهائيًا؟ والإجابة تقيّد مباشرة التقنيات الممكنة والضمانات التي يجب أن يوفرها النظام."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "سجل قرار معماري لنظام دفتر أستاذ مدفوعات متعدد المناطق",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "طبّق أسئلة الإطار الخمسة على دفتر أستاذ مدفوعات جديد متعدد المناطق: متطلب الاتساق، وتحمّل أنماط الفشل، وميزانية الزمن، ونموذج التزامن، ونطاق المعاملة. ووثّق إجاباتك واستخدمها لتضييق خيارات التقنية إلى 2-3 مرشحين."},
    {"id": "2", "description": "اكتب سجل قرار معماري (ADR) رسميًا يقارن CockroachDB مع Cassandra + Saga لدفتر أستاذ المدفوعات. وتناول ضمانات الاتساق، وأنماط الفشل، وأثر الزمن، والتعقيد التشغيلي، وإجمالي كلفة الملكية. وضمّن توصية بمفاضلات صريحة."},
    {"id": "3", "description": "ابنِ نموذجًا أوليًا للتحقق من متطلب الاتساق: اكتب اختبارًا على طريقة Jepsen للتقنية التي اخترتها يحقن انقسامات الشبكة أثناء كتابات الدفع ويتحقق من أن قراءات الرصيد لا تعيد بيانات قديمة، مؤكدًا صمود ضمان الخطية أثناء الانقسام."},
    {"id": "4", "description": "أنشئ قائمة تحقق لمراجعة القرارات لفريقك: حدّد 5 أسئلة ملموسة يجب أن يجيب عنها كل مقترح تصميم لنظام موزع قبل دخول المراجعة الهندسية. ولكل سؤال، اذكر نمط فشل كان سيُمنع لو طُرح السؤال أثناء حادث سابق."}
  ]
}
-->
