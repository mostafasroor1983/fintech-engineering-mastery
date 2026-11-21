---
id: track-01-lesson-20
title: "إطار المهندس الرئيسي لاتخاذ القرارات المعمارية"
slug: architecture-decision-framework
track: track-01
trackName: "البنية المعمارية المتقدمة للبرمجيات"
sequence: 20
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, architecture, trade-offs, staff-engineer, principal-engineer]
prerequisites: []
---

# إطار المهندس الرئيسي لاتخاذ القرارات المعمارية

> [!NOTE]
> الفرق بين المهندس الكبير والمهندس الرئيسي ليس أن الرئيسي يعرف أنماطًا أكثر — بل أن لديه إطارًا للاختيار بين الأنماط تحت قيود العالم الحقيقي. والقرارات المعمارية الجيدة لا تتعلق بإيجاد الحل الأمثل نظريًا؛ بل باتخاذ أفضل مفاضلة لسياق محدد، وتوصيلها بوضوح، ومعرفة متى يجب مراجعتها.

## ما يفعله المهندسون الرئيسيون فعلًا

قبل مناقشة الأطر، من المفيد أن نكون صريحين بشأن ما يُوظَّف المهندسون الرئيسيون (principal وstaff) لفعله في المؤسسات المالية:

- **رفع المستوى التقني الأدنى** عبر عدة فرق، لا في فريقهم وحده
- **استيعاب الغموض المعماري** حتى تنفّذ فرق التسليم بوضوح
- **امتلاك القرارات التقنية العابرة** التي تمتد عبر حدود الخدمات أو المجالات
- **إدارة المخاطر التقنية**: تحديد مواطن هشاشة البنية قبل أن تنكسر في الإنتاج
- **توجيه عملية اتخاذ القرار التقني** لدى المهندسين الكبار

يركز هذا الدرس على الأخيرين: كيف تتخذ القرارات المعمارية وتوصلها بمستوى جودة يتجاوز مشاركتك المباشرة.

---

## عملية اتخاذ القرار

القرارات المعمارية الجيدة تتبع عملية يمكن تدقيقها ومراجعتها. وأسوأ النتائج تأتي من قرارات تُتخذ ضمنيًا، ولا تُوثَّق، ولا يملكها أحد.

```
Architecture Decision Process:

1. FRAME          Understand the actual problem, not just the stated solution
2. GATHER CONTEXT Identify constraints, non-negotiables, and stakeholders
3. ENUMERATE      List viable options (not just the first two that come to mind)
4. EVALUATE       Score each option against weighted criteria
5. DECIDE         Choose and document the rationale, not just the choice
6. REVIEW         Define when this decision should be revisited
```

المراحل: (1) التأطير — فهم المشكلة الفعلية لا الحل المطروح فقط، (2) جمع السياق — تحديد القيود وما لا يقبل التفاوض وأصحاب المصلحة، (3) التعداد — سرد الخيارات الممكنة (لا أول خيارين يخطران على البال فقط)، (4) التقييم — تقييم كل خيار مقابل معايير موزونة، (5) القرار — الاختيار وتوثيق المبررات لا الاختيار وحده، (6) المراجعة — تحديد متى يجب إعادة النظر في القرار.

### تأطير المشكلة الحقيقية

كثيرًا ما تأتي الفرق إلى المهندسين الرئيسيين بحل يبحث عن مشكلة. والمهمة الأولى إعادة التأطير:

| المشكلة المطروحة | المشكلة الفعلية التي يجب التحقيق فيها |
|---|---|
| "نحتاج خدمات مصغّرة" | ما عنق الزجاجة التشغيلي أو في التسليم الموجود اليوم؟ |
| "نحتاج Kafka" | ما متطلبات الإنتاجية والترتيب وإعادة التشغيل الفعلية؟ |
| "نحتاج قاعدة بيانات NoSQL" | ما مشكلة مرونة المخطط أو التوسع التي لا تحلها الفهارس؟ |
| "خدمتنا بطيئة" | هل السبب الاستعلام، أم الشبكة، أم التنافس على الأقفال، أم جمع النفايات (GC)؟ |
| "نحتاج إعادة كتابة هذا" | ما النتائج المحددة التي ستحققها إعادة الكتابة ولا تحققها إعادة الهيكلة؟ |

---

## مصفوفة المفاضلات

كل خيار معماري مهم ينطوي على مفاضلات. والمهندسون الرئيسيون يجعلونها صريحة. وهذه مصفوفة مفاضلات معيارية لأكثر القرارات المعمارية شيوعًا في التقنية المالية:

```
Trade-Off Axes in Financial Systems:

CONSISTENCY  ←────────────────────────────────→  AVAILABILITY
Strong (always current)                          Eventual (always up)
Suitable for: balances, ledgers                  Suitable for: reporting, analytics

COMPLEXITY  ←────────────────────────────────→  MAINTAINABILITY
Optimal (every last microsecond)                 Maintainable (team can own it in 3 years)
Suitable for: HFT matching engines               Suitable for: payments, accounts

AUTONOMY  ←────────────────────────────────────→  COORDINATION
Fully independent teams/services                 Shared capabilities
Suitable for: product verticals                  Suitable for: fraud, compliance, ledger

FLEXIBILITY  ←─────────────────────────────────→  PERFORMANCE
Schema-on-read (adapt easily)                    Schema-on-write (optimise access patterns)
Suitable for: analytics, ML pipelines            Suitable for: transaction processing
```

الاتساق مقابل التوفر (الأرصدة ودفاتر الأستاذ تحتاج اتساقًا قويًا، والتقارير تتحمل الاتساق النهائي)؛ والتحسين الأقصى مقابل قابلية الصيانة؛ واستقلالية الفرق مقابل القدرات المشتركة؛ والمرونة مقابل الأداء.

---

## القرار 1: الخدمات المصغّرة أم النظام الموحّد المعياري

ربما يكون هذا أكثر القرارات المعمارية التي يُخطأ فيها في التقنية المالية. فقد تأرجحت الإجابة الافتراضية من "النظام الموحّد دائمًا" إلى "الخدمات المصغّرة دائمًا" ثم عادت — وكلا الافتراضين خاطئ.

### معايير القرار

```java
// A fitness function for the microservices vs monolith decision
// Score each criterion 1-5; higher = more microservices appropriate
public record MicroservicesReadinessAssessment(
    // Team & organisational factors
    int independentDeploymentNeeded,    // Do teams need to deploy independently? (1-5)
    int teamCognitiveBoundaries,        // Are domain boundaries clear and stable? (1-5)
    int operationalMaturity,            // Does your team operate distributed systems? (1-5)

    // Technical factors
    int scalabilityDifferentiation,     // Do components need drastically different scale? (1-5)
    int technologyHeterogeneity,        // Are there justified reasons for different tech stacks? (1-5)
    int faultIsolationRequired,         // Must one component's failure not affect others? (1-5)

    // Cost factors
    int teamSize,                       // Team < 15 engineers = monolith-first
    int systemMaturity                  // Greenfield = monolith-first; established = microservices may help
) {
    public int totalScore() {
        return independentDeploymentNeeded + teamCognitiveBoundaries
            + operationalMaturity + scalabilityDifferentiation
            + technologyHeterogeneity + faultIsolationRequired
            + teamSize + systemMaturity;
    }

    public Recommendation recommend() {
        if (totalScore() < 20) return Recommendation.MODULAR_MONOLITH;
        if (totalScore() < 28) return Recommendation.MODULAR_MONOLITH_FIRST;
        return Recommendation.MICROSERVICES;
    }
}
```

### إرشادات خاصة بسياق الخدمات المالية

**استخدم نظامًا موحّدًا معياريًا عندما:**
- يكون حجم الفريق أقل من 15 مهندسًا
- يكون نموذج المجال ما زال قيد الاكتشاف (منتج مالي جديد من الصفر)
- لا تكون البنية التحتية التشغيلية (شبكة الخدمات، والتتبع الموزع، وتنسيق الحاويات) ناضجة بعد
- تتطلب متطلبات الزمن استدعاءات داخل العملية (أقل من مللي ثانية)
- يكون السطح التنظيمي والامتثالي مشتركًا بين كل الميزات

**استخدم الخدمات المصغّرة عندما:**
- تحتاج عدة فرق إيقاعات نشر مستقلة
- تكون للمكوّنات متطلبات SLA مختلفة كثيرًا (99.99% للمدفوعات مقابل 99.9% للتقارير)
- تتطلب الحدود التنظيمية فعلًا عزل البيانات (تقليص نطاق PCI-DSS دافع حقيقي)
- تختلف متطلبات التوسع بمرتبة عشرية كاملة بين المكوّنات
- يكون المجال ناضجًا والسياقات المحدودة مستقرة

**إشارات تحذير من خدمات مصغّرة سابقة لأوانها:**
- خدمتان تُنشران معًا دائمًا
- معاملات بين الخدمات منفّذة بالتزام موزع على مرحلتين
- خدمات تتشارك مخطط قاعدة بيانات
- خدمة "بوابة" تعرف كل منطق العمل (النمط الخاطئ: النظام الموحّد الموزع)

---

## القرار 2: التواصل المتزامن أم غير المتزامن

```
Decision Framework: Sync vs Async

                   SYNC (REST/gRPC)       ASYNC (Kafka/SQS)
Coupling           Temporal coupling      Decoupled in time
Failure model      Fail fast, easy retry  At-least-once, idempotency required
Latency            Predictable P50        Variable (depends on consumer lag)
Throughput         Limited by slowest hop High; consumer scales independently
Backpressure       Automatic (HTTP 429)   Queue depth / consumer lag
Ordering           Request-response       Requires partition key design
Tracing            Easy (request ID)      Requires correlation ID propagation
Operational cost   Low                    Higher (broker ops, schema registry)

USE SYNC FOR:                             USE ASYNC FOR:
- Customer-facing responses               - Fire-and-forget notifications
- Real-time balance queries               - Audit event publishing
- Fraud checks that block payment         - Cross-domain data replication
- Payment authorisation decisions         - Batch settlement processing
- Idempotency key checks                  - Workflow orchestration
```

استخدم الاستدعاء المتزامن للردود التي ينتظرها العميل، واستعلامات الرصيد اللحظية، وفحوص الاحتيال التي تحجب الدفع، وقرارات التفويض. واستخدم غير المتزامن للإشعارات، ونشر أحداث التدقيق، ونسخ البيانات بين المجالات، والتسوية الدفعية، وتنسيق سير العمل.

```java
// Example: payment submission uses sync for authorisation, async for downstream
@Service
public class PaymentOrchestrationService {

    private final FraudCheckService    fraudCheck;    // sync: blocks submission
    private final LedgerService        ledger;        // sync: in-process / critical path
    private final EventPublisher       events;        // async: downstream subscribers

    public PaymentResult submitPayment(PaymentRequest request) {
        // Synchronous — customer is waiting; decisions needed in real time
        FraudAssessment fraud = fraudCheck.assess(request);  // 50ms SLA
        if (fraud.isDeclined()) {
            return PaymentResult.declined(request.paymentId(), fraud.reason());
        }

        Payment payment = paymentRepository.save(
            Payment.from(request, PaymentStatus.PENDING)
        );

        LedgerPostingResult posting = ledger.postHold(payment);  // in-process

        // Asynchronous — customer does not wait for these. The event is written to
        // an outbox table in the same transaction as the payment and relayed to
        // Kafka after commit (see the ADR below) — never sent straight to the broker
        events.publish(new PaymentSubmittedEvent(payment));
        // -> notification-service picks this up: sends confirmation email
        // -> fraud-service picks this up: updates velocity counters
        // -> reporting-service picks this up: updates dashboard

        return PaymentResult.submitted(payment.id(), posting.referenceNumber());
    }
}
```

---

## القرار 3: SQL أم NoSQL

حجة "استخدم NoSQL لأنها تتوسع" سببت حوادث إنتاج في التقنية المالية أكثر مما منعت.

### متى تكون SQL الخيار الصحيح للبيانات المالية

```sql
-- Financial data has properties that relational databases handle naturally:

-- 1. ACID transactions across multiple entities
BEGIN;
    UPDATE accounts SET balance = balance - 500.00 WHERE account_id = 'ACC-001';
    UPDATE accounts SET balance = balance + 500.00 WHERE account_id = 'ACC-002';
    INSERT INTO ledger_entries (debit_account, credit_account, amount)
    VALUES ('ACC-001', 'ACC-002', 500.00);
COMMIT;
-- This is trivial in PostgreSQL; it requires careful design in NoSQL

-- 2. Complex queries for regulatory reporting (Basel III, IFRS 9)
SELECT
    r.risk_weight_category,
    SUM(e.exposure_amount)              AS total_exposure,
    SUM(e.exposure_amount * r.weight)   AS risk_weighted_exposure,
    COUNT(*)                            AS position_count
FROM credit_exposures e
JOIN risk_weight_mappings r
    ON e.asset_class = r.asset_class
    AND e.credit_rating = r.credit_rating
WHERE e.reporting_date = CURRENT_DATE
GROUP BY r.risk_weight_category
ORDER BY risk_weighted_exposure DESC;
-- Ad-hoc regulatory queries like this require SQL or a SQL-compatible layer

-- 3. Referential integrity for account-to-customer relationships
ALTER TABLE accounts
    ADD CONSTRAINT fk_accounts_customer
    FOREIGN KEY (customer_id) REFERENCES customers(id)
    ON DELETE RESTRICT;  -- cannot delete customer with open accounts
```

### متى تكون NoSQL مبررة في التقنية المالية

| حالة الاستخدام | المخزن الموصى به | السبب |
|---|---|---|
| حالة الجلسة / تفضيلات العملاء | Redis | وصول سريع، وانتهاء بالمدة، وبلا استعلامات علائقية |
| متجهات ميزات الاحتيال | Redis / DynamoDB | نمط وصول معروف (حسب معرّف العميل)، وحجم قراءة عالٍ |
| سجل أحداث التدقيق | Cassandra / OpenSearch | إلحاق فقط، ووصول زمني، ونطاق بيتابايت |
| بيانات كثيفة المستندات (مستندات KYC، والعقود) | MongoDB / S3 + بيانات وصفية في Postgres | مخطط متغير، ومحتوى ثنائي كبير |
| جداول توجيه المدفوعات | Redis (ذاكرة مؤقتة بقراءة نافذة) | قراءات متكررة جدًا، ووصول مفتاح-قيمة بسيط |

---

## القرار 4: الاتساق أم التوفر

للمهندسين الذين قرؤوا نظرية CAP لكنهم يحتاجون إلى تطبيقها عمليًا:

```java
// In a payment processing system, different data elements have different
// consistency requirements:

public enum ConsistencyRequirement {

    // MUST be strongly consistent: stale reads risk double-spending
    ACCOUNT_BALANCE(ConsistencyLevel.STRONG,
        "Must always reflect all committed transactions"),

    PAYMENT_STATUS(ConsistencyLevel.STRONG,
        "Customer and merchant must see same terminal status"),

    LEDGER_ENTRIES(ConsistencyLevel.STRONG,
        "Regulatory requirement: single source of truth"),

    // CAN tolerate eventual consistency: staleness has bounded business impact
    TRANSACTION_HISTORY(ConsistencyLevel.EVENTUAL,
        "Displays last 30 days; 1-2 second lag is acceptable"),

    MERCHANT_ANALYTICS(ConsistencyLevel.EVENTUAL,
        "Dashboard updated every 5 minutes; no financial decision depends on it"),

    NOTIFICATION_STATUS(ConsistencyLevel.EVENTUAL,
        "Email/SMS delivery confirmation; best effort is sufficient"),

    FRAUD_VELOCITY_COUNTERS(ConsistencyLevel.CAUSAL,
        "Must reflect your own recent transactions; global sync within 500ms");
}
```

### التطبيق العملي لحدود الاتساق

```java
// The account balance must be strongly consistent.
// Read it on the primary, inside the transaction that changes it.
@Repository
public class StronglyConsistentAccountRepository {

    private final JdbcTemplate primaryJdbc;   // Always read from primary

    // Must run inside the caller's @Transactional; READ COMMITTED + FOR UPDATE is
    // enough here. NOWAIT would fail at once on a busy account — prefer a short
    // lock_timeout (e.g. SET LOCAL lock_timeout = '2s').
    public Optional<Account> findAndLockForUpdate(String accountId) {
        return primaryJdbc.query(
            // SELECT FOR UPDATE prevents concurrent balance modifications
            "SELECT * FROM accounts WHERE account_id = ? FOR UPDATE",
            accountRowMapper, accountId
        ).stream().findFirst();
    }
}

// Transaction history can tolerate eventual consistency.
// Read from read replicas to reduce load on primary.
@Repository
public class EventuallyConsistentTransactionRepository {

    private final JdbcTemplate replicaJdbc;   // Safe to read from replica

    public List<Transaction> getHistory(String accountId, DateRange range) {
        return replicaJdbc.query(
            "SELECT * FROM transactions WHERE account_id = ? " +
            "AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 100",
            transactionRowMapper,
            accountId, range.from(), range.to()
        );
    }
}
```

يُقرأ الرصيد ويُقفل على النسخة الأساسية داخل المعاملة التي تغيّره؛ ويكفي هنا مستوى العزل READ COMMITTED مع FOR UPDATE. أما تاريخ المعاملات فيتحمل الاتساق النهائي، فيُقرأ من نسخة متماثلة لتخفيف الحمل عن الأساسية.

---

## دوال اللياقة

دوال اللياقة اختبارات آلية تتحقق من بقاء الخصائص المعمارية مع الوقت. وهي تمنع النمط الشائع "قررنا هذه البنية لكنها انحرفت".

```java
// ArchUnit tests as fitness functions for the payment service architecture
// Run these in CI on every commit — treat failures as build failures

@AnalyzeClasses(packages = "com.fintech.payment",
                importOptions = {ImportOption.DoNotIncludeTests.class})
class ArchitectureFitnessFunctions {

    @ArchTest
    static final ArchRule hexagonalArchitectureEnforced =
        layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("Domain")      .definedBy("..domain..")
            .layer("Application") .definedBy("..application..")
            .layer("Adapters")    .definedBy("..adapter..")
            .whereLayer("Domain")      .mayNotAccessAnyLayer()
            .whereLayer("Application") .mayOnlyAccessLayers("Domain")
            .whereLayer("Adapters")    .mayOnlyAccessLayers("Application", "Domain");

    @ArchTest
    static final ArchRule noDomainDependenciesOnFrameworks =
        noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat()
            .resideInAPackage("org.springframework..")
            .because("Domain model must be framework-independent");

    @ArchTest
    static final ArchRule repositoriesNotCalledFromDomainModel =
        noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat()
            .haveSimpleNameEndingWith("Repository")
            .because("Domain model must not depend on persistence layer");

    @ArchTest
    static final ArchRule noCircularDependencies =
        slices().matching("com.fintech.payment.(*)..").should().beFreeOfCycles();

    @ArchTest
    static final ArchRule entityClassesNotExposedInRestLayer =
        noClasses()
            .that().resideInAPackage("..adapter.rest..")
            .should().dependOnClassesThat()
            .areAnnotatedWith(Entity.class)
            .because("REST layer must use DTOs, not JPA entities directly");
}
```

---

## سجلات القرارات المعمارية (ADR)

القرار جيد بقدر توثيقه فقط. وسجلات ADR هي الصيغة المعيارية لتسجيل القرارات بشكل دائم وقابل للمراجعة.

```markdown
# ADR-0023: Use Outbox Pattern for Payment Event Publishing

## Status
Accepted — 2024-03-15

## Context
The payment service needs to publish `PaymentSubmittedEvent` to Kafka after a
payment is persisted. We explored two approaches:

1. Direct Kafka publish within the payment transaction
2. Transactional outbox pattern

## Decision Drivers
- We cannot afford to publish an event for a payment that was not committed
- We cannot afford to commit a payment without eventually publishing the event
- The payment database (PostgreSQL) is the system of record
- Event publishing must survive application restarts

## Considered Options

### Option 1: Direct publish within transaction
Publish to Kafka before committing the database transaction.
- Risk: Kafka publish succeeds but database rollback occurs — phantom events
- Risk: Database commits but Kafka is unavailable — lost events

### Option 2: Transactional Outbox
Write events to an `outbox` table in the same database transaction as the
payment. A separate relay process publishes from outbox to Kafka.
- Benefit: Atomicity guaranteed by database transaction
- Benefit: Kafka outage does not affect payment submission
- Cost: Additional relay component; at-least-once delivery requires consumers
  to handle duplicates (idempotency keys)

## Decision
We adopt the **Transactional Outbox Pattern** (Option 2) using Debezium as
the CDC relay. Consumers must handle duplicate events using the event's
`eventId` as an idempotency key.

## Consequences
- Payment event consumers MUST implement idempotency on `eventId`
- The outbox table must be monitored for lag; alert if lag > 30 seconds
- Debezium connector configuration is owned by the payments team

## Review Trigger
Revisit if: event publishing lag consistently exceeds 5 seconds in production,
or if Debezium operational overhead becomes significant.
```

خلاصة هذا السجل: اعتُمد نمط Transactional Outbox مع Debezium كمرحّل CDC، لأن النشر المباشر إلى Kafka داخل المعاملة قد يُنتج أحداثًا وهمية أو يُضيّع أحداثًا. والثمن أن يطبق المستهلكون منع التكرار على `eventId`، وأن يُراقب تأخر جدول outbox.

---

## أنماط خاطئة في اتخاذ القرار

**1. البنية الموجّهة بالسيرة الذاتية**
اختيار Kafka أو Kubernetes أو شبكة الخدمات أو أي تقنية أخرى لأنها تبدو مثيرة للإعجاب — لا لأن المشكلة تتطلبها. وهذا يضيف تعقيدًا تشغيليًا يجب على الفريق صيانته لسنوات.

**2. البنية بالتقليد الأعمى (Cargo-Cult)**
"Netflix وUber تستخدمان الخدمات المصغّرة، إذن يجب أن نفعل مثلهما." هذه الشركات بنت بناها استجابة لمشكلات توسع محددة في مراحل محددة من نموها. فبنيتها إجابة سؤالها، لا سؤالك.

**3. البنية بالإجماع**
اشتراط موافقة الجميع على كل قرار معماري يؤدي إما إلى شلل في اتخاذ القرار أو إلى تسويات متوسطة لا ترضي أحدًا ولا تلبي أي قيد. ومهمة المهندس الرئيسي أن يقرر، لا أن يبني الإجماع لذاته.

**4. التحسين للحالة الاستثنائية**
تصميم النظام كله لحدث حمل عند المئين 99.999 قد يقع مرة كل خمس سنوات. فالأنظمة المالية تحتاج إلى التعامل مع الحجم المتوقع بموثوقية؛ والكلفة الهندسية الهامشية للتعامل مع حجم غير متوقع أكبر بمئة مرة لا يبررها احتمال حدوثه عادة.

**5. تجاهل التعقيد التشغيلي**
كل قرار معماري يضيف إلى العبء التشغيلي. والنظام الذي يتطلب ثلاثة أنواع مختلفة من قواعد البيانات، وأربعة أنظمة مراسلة، وطبقتي ذاكرة مؤقتة ليس متطورًا — بل مكلف. عُدّ التقنيات المختلفة التي يحتاج مهندس المناوبة إلى فهمها في الثانية فجرًا.

---

## قائمة تحقق القرار للمهندسين الرئيسيين

قبل الموافقة على تغيير معماري مهم أو اقتراحه:

```
1. PROBLEM CLARITY
   [ ] Can you describe the problem in one sentence without naming a technology?
   [ ] Have you confirmed the problem exists with data, not anecdote?
   [ ] Do you understand why this problem exists now (and not 2 years ago)?

2. OPTION SPACE
   [ ] Have you considered at least 3 materially different options?
   [ ] Have you considered "do nothing" as a valid option?
   [ ] Have you considered a simpler version of your preferred option?

3. TRADE-OFF ANALYSIS
   [ ] Have you identified the top 3 risks of your preferred option?
   [ ] Have you identified what you are sacrificing to gain what you want?
   [ ] Have you stress-tested against: team turnover, 10x scale, regulatory change?

4. REVERSIBILITY
   [ ] Is this decision easily reversible? (If yes: proceed; don't over-analyse)
   [ ] If irreversible: have you given the decision proportional rigour?
   [ ] What is the rollback plan if this proves wrong in 12 months?

5. STAKEHOLDER ALIGNMENT
   [ ] Do the engineers who will implement this understand the rationale?
   [ ] Does the product/business owner understand the implications?
   [ ] Are there regulatory/compliance implications that need sign-off?

6. DOCUMENTATION
   [ ] Is there an ADR (Architecture Decision Record) capturing the decision?
   [ ] Are the review trigger conditions specified?
   [ ] Who owns this decision going forward?
```

تغطي القائمة: وضوح المشكلة (هل تستطيع وصفها بجملة دون ذكر تقنية؟ هل أكدتها بالبيانات؟)، ومساحة الخيارات (ثلاثة خيارات مختلفة جوهريًا على الأقل، بما فيها "لا تفعل شيئًا")، وتحليل المفاضلات، وقابلية التراجع (القرار القابل للتراجع لا يحتاج تحليلًا مفرطًا)، وتوافق أصحاب المصلحة، والتوثيق في سجل ADR مع شروط المراجعة ومالك القرار.

---

## أخطاء شائعة

**الخلط بين التعقيد والتطور**
يساوي المراجعون أحيانًا بين التصميم الأعقد والتصميم الأفضل. ومن مهمة المهندس الرئيسي أن يوضح لماذا يكون الحل الأبسط أفضل حين يكون كذلك. فعبارة "يمكننا إضافة شبكة خدمات، لكن إليكم لماذا لا تتطلبها المشكلة" مساهمة على مستوى المهندس الرئيسي.

**اتخاذ القرارات في فراغ**
للقرارات المعمارية في الخدمات المالية آثار امتثالية وأمنية وتشغيلية تتجاوز الجانب التقني. وإشراك معماري امتثال أو مهندس أمن مبكرًا يمنع الإضافة المؤلمة والمكلفة للضوابط بعد فوات الأوان.

**عدم تحديد معايير النجاح**
"سنرحّل إلى خدمة الدفع الجديدة" ليس معيار نجاح. أما "تعالج خدمة الدفع الجديدة 100% من المدفوعات المحلية بالجنيه بزمن p99 أقل من 200ms وبلا أي اختلاف في التشغيل المزدوج لمدة 30 يومًا متتالية" فمعيار نجاح. وبدون معايير قابلة للقياس لا تستطيع معرفة متى انتهيت.

---

## نصائح للإنتاج

**احتفظ برادار للبنية المعمارية**
احتفظ بمستند حي يصنّف التقنيات عبر منصتك إلى: اعتمد (Adopt)، وجرّب (Trial)، وقيّم (Assess)، وتوقّف (Hold). وحدّثه كل ربع سنة. فهذا يمنع الفرق من إدخال تقنيات جديدة عشوائيًا، ويعطي المهندسين الجدد رؤية واضحة للمشهد التقني.

**اكتب سجلات ADR للقرارات التي قررت عدم اتخاذها**
"درسنا إدخال GraphQL وقررنا رفضه لأن..." لا يقل قيمة عن قرار إيجابي. فسيعيد المهندسون في المستقبل تقييم الخيارات نفسها؛ والسجل السلبي يوفر عليهم التحقيق ويوصل المبررات.

**ميّز بين الأمثل المحلي والأمثل العام**
القرار الأمثل لخدمة فريق واحد قد يفرض كلفة على فرق أخرى عبر البنية التحتية المشتركة، أو عقود البيانات، أو العبء التشغيلي. والمهندسون الرئيسيون هم من يقفون في موقع يسمح لهم برؤية هذه الآثار بين الفرق وأخذها في الحسبان.

**استخدم دوال اللياقة لا مراجعات الشيفرة لفرض البنية**
مراجعات الشيفرة التي تفحص الالتزام المعماري غير متسقة ولا تتوسع. أما دوال اللياقة في ArchUnit التي تعمل في CI مع كل التزام فمتسقة وآلية. وثّق القواعد المعمارية، ثم أتمت فرضها.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يقترح فريق إدخال Kafka لأن 'Netflix تستخدمه'. أي نمط خاطئ في اتخاذ القرار يمثله هذا، وماذا يجب أن يسأل المهندس الرئيسي أولًا؟",
      "options": [
        "البنية الموجّهة بالسيرة الذاتية — يريد الفريق Kafka لتطوير مسيرته. ويجب أن يسأل المهندس الرئيسي عن خبرة الفريق في Kafka.",
        "البنية بالتقليد الأعمى — تبنّي تقنية لأن شركة كبيرة تستخدمها، لا لأن المشكلة المحددة تتطلبها. ويجب أن يسأل المهندس الرئيسي أولًا عن متطلبات الإنتاجية والترتيب وإعادة التشغيل الفعلية.",
        "البنية بالإجماع — الفريق غير متوافق على اختيار التقنية. ويجب أن يدعو المهندس الرئيسي إلى اجتماع للوصول إلى موافقة الجميع.",
        "التحسين للحالة الاستثنائية — الفريق يصمم لحركة بحجم Netflix. ويجب أن يقدم المهندس الرئيسي مقاييس الحركة الحالية."
      ],
      "correct": 1,
      "explanation": "هذه بنية بالتقليد الأعمى — تبنّي تقنية لأن شركة أخرى تستخدمها، لا لأن المشكلة تتطلبها. فقد بنت Netflix وUber بناهما استجابة لمشكلات توسع محددة في مراحل نمو محددة. والسؤال الأول الصحيح: ما متطلبات الإنتاجية والترتيب وإعادة التشغيل الفعلية؟ وكثيرًا ما تكشف الإجابة أن بدائل أبسط (طابور في قاعدة البيانات، أو SQS) كافية."
    },
    {
      "text": "وفق قائمة تحقق القرار للمهندس الرئيسي، ما الشرط الذي يجعل القرار قابلًا للتراجع، ومن ثم مناسبًا لتحليل أقل صرامة؟",
      "options": [
        "أن يؤثر القرار في خدمة واحدة فقط وبلا واجهات بين الفرق.",
        "أن يمكن التراجع عن القرار بسهولة دون ترحيل بيانات، أو جهد هندسي كبير، أو اعتماديات خارجية.",
        "أن يملك القرار مهندس واحد بدل أن يتطلب موافقة لجنة.",
        "أن يتضمن القرار تقنية استخدمها الفريق سابقًا في الإنتاج."
      ],
      "correct": 1,
      "explanation": "القرار القابل للتراجع هو الذي يمكن إلغاؤه دون كلفة كبيرة — بلا ترحيل بيانات، ولا تغيير عقود مع فرق أخرى، ولا جهد هندسي كبير. والقرارات القابلة للتراجع تستحق تحليلًا أقل صرامة لأن تصحيح أخطائها رخيص. أما القرارات غير القابلة للتراجع (اختيار محرك قاعدة البيانات، ومنصة المراسلة، وعقود الواجهات العامة) فتستحق صرامة متناسبة لأن إصلاح أخطائها مكلف."
    },
    {
      "text": "تتعامل خدمة دفع مع قراءات رصيد الحساب وقراءات تاريخ المعاملات عبر إعداد قاعدة البيانات نفسه. يقترح الفريق توجيه كل القراءات إلى نسخة PostgreSQL متماثلة للقراءة لتحسين الأداء. ما أهم سؤال يجب أن يطرحه المهندس الرئيسي قبل الموافقة على هذا التغيير؟",
      "options": [
        "ما مقدار تأخر النسخ في النسخة المتماثلة تحت حمل الذروة؟",
        "أي القراءات تتطلب اتساقًا قويًا (مثل قراءات الرصيد لتفويض الدفع) وأيها تتحمل الاتساق النهائي (مثل عرض تاريخ المعاملات)؟",
        "هل للنسخة المتماثلة الفهارس نفسها التي في الأساسية لضمان أداء استعلامات مكافئ؟",
        "هل النسخة المتماثلة في منطقة التوفر نفسها التي فيها الأساسية لتقليل تأخر النسخ؟"
      ],
      "correct": 1,
      "explanation": "أهم سؤال هو أي القراءات تتطلب اتساقًا قويًا. فقراءات رصيد الحساب لتفويض الدفع يجب أن تكون متسقة بقوة — وتوجيهها إلى نسخة متماثلة قد يسمح للعميل بإنفاق مال لا يملكه إذا تأخرت النسخة أثناء فترات الكتابة الكثيفة. أما قراءات تاريخ المعاملات فتتحمل الاتساق النهائي. وقرار شامل بـ 'توجيه كل القراءات إلى النسخة المتماثلة' دون هذا التحليل خطأ في نموذج الاتساق قد يسبب ضررًا ماليًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تطبيق إطار القرار المعماري على سيناريوهات واقعية",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "باستخدام إطار التقييم MicroservicesReadinessAssessment، قيّم منتجًا ماليًا جديدًا من الصفر لدى فريق من 8 مهندسين، بنموذج مجال غير مكتشف بعد، وبلا بنية تحتية قائمة للأنظمة الموزعة، وبسطح تنظيمي مشترك بين كل الميزات. قيّم كل معيار من 1 إلى 5 واستنتج التوصية. واكتب سجل ADR من صفحة واحدة يوثّق القرار، ومبررات التقييم، والشروط التي يجب أن يُعاد فيها النظر في القرار."},
    {"id": "2", "description": "يجب أن تستدعي خدمة دفع خدمة فحص الاحتيال قبل تفويض المدفوعات، وأن تنشر أحداث تدقيق إلى نظام تقارير الامتثال. طبّق إطار قرار المتزامن مقابل غير المتزامن على التكاملين. واكتب PaymentOrchestrationService تستخدم REST متزامنًا لفحوص الاحتيال (التي تحجب رد التفويض) وأحداث Kafka غير متزامنة عبر outbox لتقارير الامتثال (التي لا ينتظرها العميل). واكتب اختبارات وحدة لكل مسار تكامل."},
    {"id": "3", "description": "اكتب مجموعة كاملة من دوال اللياقة في ArchUnit لخدمة دفع تفرض: (أ) طبقات البنية السداسية، (ب) عدم اعتماد المجال على Spring أو JPA، (ج) عدم استدعاء المستودعات من أصناف نموذج المجال، (د) عدم وجود اعتماديات دائرية بين الشرائح، (هـ) عدم كشف أصناف JPA ‏@Entity مباشرة في متحكمات REST. واضبط الاختبارات لتعمل في CI مع ImportOption.DoNotIncludeTests، وعامل فشلها كفشل في البناء."},
    {"id": "4", "description": "حدّد ثلاثة قرارات معمارية في نظامك الحالي أو الأحدث لا توجد لها معايير نجاح موثقة. ولكل منها اكتب معيار نجاح في فقرة واحدة باتباع الصيغة: 'يعالج [المكوّن] [النطاق] بـ [اتفاقية الزمن] و[اتفاقية نسبة الأخطاء] لمدة [المدة] تحت [الظروف].' ثم اكتب سجل ADR لأهم القرارات الثلاثة معماريًا، متضمنًا الأنماط الخاطئة في اتخاذ القرار التي تم تجنبها ولماذا."}
  ]
}
-->
