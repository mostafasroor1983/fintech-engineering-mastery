---
id: track-12-lesson-04
title: "سجلات ADR عمليًا — بناء ثقافة القرارات المعمارية"
slug: adr-practice
track: track-12
trackName: "القيادة الهندسية على مستوى Staff وPrincipal"
sequence: 4
difficulty: principal
estimatedMinutes: 75
status: published
tags: [ADR, architecture-decision, culture, documentation, MADR, RFC, governance]
prerequisites: [track-12-lesson-03]
---

# سجلات القرارات المعمارية عمليًا — بناء ثقافة لتوثيق القرارات المعمارية

> [!NOTE]
> سجلات القرارات المعمارية (ADRs) هي علم آثار قاعدة الكود لديك. فدونها، يكرر كل مهندس جديد — وكل مهندس عائد نسي — الاستكشافات المكلفة نفسها، ويصل إلى الاستنتاجات نفسها، وأحيانًا يرتكب الأخطاء الباهظة نفسها التي دفعت ثمنها مرة. وفي المستوى الرئيسي، قدرتك على إنشاء ثقافة توثيق القرارات والحفاظ عليها بأهمية الجودة التقنية لقراراتك.

## ‏RFC مقابل ADR: أدوات مختلفة لمهام مختلفة

‏RFC وADR متكاملان، لا متنافسان:

| | ‏RFC ‏(طلب التعليقات) | ‏ADR ‏(سجل القرار المعماري) |
|-|---------------------------|-------------------------------------|
| الغرض | اقتراح قرار ومناقشته | تسجيل قرار اتُّخذ بالفعل |
| التوقيت | قبل القرار | بعد القرار (أو عند اتخاذه) |
| الصيغة | وثيقة مقترح مع بدائل | سجل موجز للقرار ومبرره |
| الجمهور | المشاركون في القرار | القرّاء المستقبليون (أعضاء الفريق الجدد، وأنت في المستقبل) |
| الطول | بقدر الحاجة | صفحة إلى صفحتين كحد أقصى |
| العمر | يُغلق حين يُتخذ القرار | يعيش إلى الأبد في المستودع |
| عملية المراجعة | طلب سحب بتعليقات مفتوحة | يُدمج بعد تأكيد القرار |

**استخدم RFC** حين: تحتاج إلى استكشاف البدائل، أو بناء التوافق، أو توثيق المقايضات قبل الالتزام بنهج.

**اكتب ADR** حين: يُتخذ قرار معماري مهم — سواء عبر RFC، أو مراجعة تصميم، أو حتى بشكل غير رسمي — وتحتاج إلى تسجيله للرجوع إليه مستقبلًا.

يمكن أن ينتج RFC سجل ADR. ويمكن أن يوجد ADR دون RFC (للقرارات المتخذة قبل وجود عملية RFC، أو للقرارات الأصغر التي لم تستحق RFC كاملًا).

---

## مصفوفة وزن القرار

ليس كل قرار يستحق ADR. واستخدم هذه المصفوفة لتقرر متى تكتب واحدًا:

```
                    HIGH reversibility cost
                           │
                           │
 Small scope ──────────────┼────────────────── Large scope
 (one team)                │                   (many teams)
                           │
                    LOW reversibility cost
```

**اكتب ADR حين:**
- تكون كلفة التراجع عالية (تغييره لاحقًا مكلف أو محفوف بالمخاطر)
- يكون النطاق واسعًا (يؤثر على فرق أو خدمات أو التزامات تنظيمية متعددة)
- وُجدت بدائل معقولة متعددة ودُرست
- سيتساءل المهندسون المستقبليون "لماذا فعلوها بهذه الطريقة؟"
- يكون للقرار آثار على الامتثال أو الأمان أو اللوائح

**لا تكتب ADR لـ:**
- تفاصيل التنفيذ الواضحة من الكود
- اصطلاحات التسمية وقرارات الأسلوب (تغطيها معايير الفريق)
- القرارات المؤقتة ذات الانتهاء الواضح (< 90 يومًا)
- ترقيات المكتبات على مستوى الإصدار الفرعي (patch)

**قاعدة تقريبية**: إن كنت تريد شرح القرار في تعليق مراجعة كود سيعيش أطول من طلب السحب، فمكانه ADR.

---

## صيغة MADR

صيغة MADR ‏(سجلات القرارات المعمارية بـ Markdown) أكثر صيغ ADR عملية للفرق الهندسية. فهي:
- بسيطة بما يكفي ليكتبها المهندسون فعلًا
- منظمة بما يكفي ليجد القرّاء المستقبليون ما يحتاجونه بسرعة
- خاضعة لإدارة الإصدارات مع الكود (لا في ويكي ينحرف عن الواقع)

```markdown
# ADR-001: Use PostgreSQL as the Primary Database for the Payments Ledger

**Status**: Accepted
**Date**: 2026-10-15
**Deciders**: Principal Engineer (Payments), VP Engineering, Head of Data

## Context and Problem Statement

The payments ledger needs a primary database. We are building a new ledger
service from scratch as part of the payments platform migration. The database
must handle:
- Write throughput: 5,000 transactions/second at peak (end-of-month processing)
- Read queries: complex account balance calculations, transaction history, reconciliation
- ACID guarantees: double-entry accounting requires strong transaction semantics
- Audit requirements: immutable transaction history for regulatory reporting (7 years)

## Decision Drivers

- ACID transactions required for double-entry accounting (no eventual consistency)
- SQL expertise available in team (all engineers know SQL; nobody knows MongoDB query language)
- Compliance: data residency in EU (eliminating some cloud-only databases)
- Operational simplicity: team already operates PostgreSQL for other services
- Partitioning: account-level sharding will be needed within 18 months

## Considered Options

1. **PostgreSQL 17** (chosen)
2. **MongoDB 8**
3. **CockroachDB 25**
4. **Amazon Aurora Serverless v2**

## Decision Outcome

Chosen option: **PostgreSQL 17**, because:
- Strong ACID guarantees with mature transaction semantics
- Best SQL support of the options considered (window functions, CTEs for accounting queries)
- Team already has operational expertise with PostgreSQL
- Proven in financial services (used by multiple large payment processors)
- Open source: no vendor lock-in; can run on any cloud or on-premises

Negative consequences:
- Manual sharding required when we outgrow single-node capacity (estimated 18 months)
- Replication setup and failover more complex than Aurora's managed alternative
- No automatic horizontal write scaling (CockroachDB would handle this natively)

## Options Analysis

### PostgreSQL 17
- Pros: ACID, mature, SQL, operational expertise, no vendor lock-in
- Cons: Manual sharding; not horizontally scalable for writes
- Risk: Partitioning migration in ~18 months

### MongoDB 8
- Pros: Horizontal scale, flexible schema
- Cons: Multi-document ACID transactions exist (since 4.0) but have performance
  and size limits and are not the primary design model; team unfamiliar;
  flexible schema is a liability for accounting (strict schema required)
- **Verdict: Eliminated** — a strictly-schemed, relational double-entry model
  with heavy multi-row transactions fits a SQL database better

### CockroachDB 25
- Pros: ACID, horizontal scale, SQL-compatible
- Cons: Higher cost (no longer open source since the 2024 licence change);
  less operational maturity in team; Postgres wire protocol but not fully
  compatible (some features and query plans behave differently)
- **Verdict**: Keep as future option if sharding becomes operationally complex

### Amazon Aurora Serverless v2
- Pros: Fully managed, auto-scaling, familiar PostgreSQL interface
- Cons: AWS vendor lock-in; slightly higher latency than self-managed PostgreSQL;
  data residency control is more complex
- **Verdict**: Viable option; rejected because team prefers infrastructure
  portability for this core system

## Links

- RFC: [RFC-038 — Ledger database selection]
- Performance benchmarks: [link to benchmark results in Confluence]
- Related ADR: ADR-004 — Ledger partitioning strategy (future, not yet written)
- Follow-up: Review CockroachDB migration in Q3 2027 if shard count > 8
```

---

## دورة حياة ADR

```
PROPOSED → ACCEPTED → DEPRECATED → SUPERSEDED
     │                     │              │
     │                     │              └─ New ADR replaces this one
     │                     └─ Technology/approach is being retired
     └─ Alternative status: REJECTED
        (documented decisions we considered and did not take)
```

**مقترح (Proposed)**: صِيغ ADR لكن لم يُقرر بعد. ويُستخدم حين تريد بدء النقاش عبر ADR بدل RFC.

**مقبول (Accepted)**: اتُّخذ القرار وهو سارٍ حاليًا. وهذه الحالة الطبيعية.

**مُهمَل (Deprecated)**: القرار في طور الإحالة للتقاعد. والنمط أو التقنية يُلغى تدريجيًا. ولا يجب أن يستخدمه أي كود جديد. واكتب ملاحظة ترحيل من جملة واحدة.

**مُستبدَل (Superseded)**: حل محله ADR جديد. اربط بالـ ADR الجديد. واحتفظ بالقديم للسجل التاريخي — فلسلسلة التفكير قيمة تدقيقية ومؤسسية.

**مرفوض (Rejected)**: دُرس الخيار ولم يُؤخذ صراحة. وتوثيق الخيارات المرفوضة يمنع الفرق من اقتراحها مجددًا.

---

## أين تعيش سجلات القرارات

**في المستودع** (موصى به بشدة): مجلد `docs/adr/` أو `/adr/` في جذر المستودع. فتكون سجلات القرارات خاضعة لإدارة الإصدارات، وقابلة للبحث، وتتغير مع الكود الذي تصفه.

```
payments-service/
├── src/
├── docs/
│   └── adr/
│       ├── README.md          ← index of all ADRs (auto-generated by adr-tools)
│       ├── 0001-use-postgresql.md
│       ├── 0002-use-kafka-for-events.md
│       ├── 0003-use-resilience4j-for-circuit-breaking.md
│       └── 0004-postgresql-sharding-strategy.md
└── README.md
```

**ليس في Confluence** (تجنّب): يصبح Confluence قديمًا، ولا يخضع لإدارة الإصدارات مع الكود، والبحث فيه صعب عادة. فيتوقف المهندسون عن مراجعته. ويوصي مُدخل "Lightweight Architecture Decision Records" في رادار Thoughtworks للتقنيات كذلك بحفظ سجلات القرارات في نظام التحكم بالمصدر، بجوار الكود.

**للمؤسسات متعددة الخدمات**: استخدم Backstage لتجميع سجلات القرارات عبر كل المستودعات في فهرس قابل للبحث.

---

## الأدوات: سطر أوامر `adr-tools`

```bash
# Install adr-tools
brew install adr-tools  # macOS

# Initialise ADR directory in repo
adr init docs/adr
# Creates: docs/adr/0001-record-architecture-decisions.md (the meta-ADR)

# Create new ADR (auto-numbered)
adr new "Use Kafka for payment events"
# Creates: docs/adr/0004-use-kafka-for-payment-events.md
# (adr-tools uses Nygard's original template; for MADR, use a custom
#  template or a MADR-based tool such as log4brains)

# Supersede an existing ADR
adr new -s 3 "Use Resilience4j v2 for circuit breaking"
# Creates new ADR, adds "Superseded by ADR-0005" link to ADR-003

# Generate ADR index (for README.md)
adr generate toc > docs/adr/README.md
```

---

## إضافة ADR في Backstage ‏(مستودعات متعددة)

للمؤسسات ذات 10+ مستودعات، يجمع Backstage سجلات القرارات عبر كل المستودعات:

```yaml
# catalog-info.yaml in each repository
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  annotations:
    backstage.io/techdocs-ref: dir:.
    backstage.io/adr-location: docs/adr
spec:
  type: service
  owner: team-payments
```

يستطيع المهندسون البحث في كل سجلات القرارات عبر كل المستودعات من واجهة Backstage واحدة. وهذا قيّم بشكل خاص للمهندسين الرئيسيين الذين يحتاجون إلى فهم كيف تطورت القرارات عبر المؤسسة.

---

## الفرض في CI: فحص سجلات القرارات في GitHub Actions

```yaml
# .github/workflows/adr-lint.yml
name: ADR Lint

on:
  pull_request:
    paths:
      - 'docs/adr/**'
  schedule:
    - cron: '0 6 * * 1'   # weekly, so stale PROPOSED ADRs are caught without a PR

jobs:
  adr-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Every ADR has a Status field
        run: |
          fail=0
          for f in docs/adr/[0-9]*.md; do
            grep -qiE '^\*\*Status\*\*:' "$f" || { echo "ERROR: $f has no Status field"; fail=1; }
          done
          exit $fail

      - name: No ADR PROPOSED for more than 14 days
        run: |
          fail=0
          for f in $(grep -liE '^\*\*Status\*\*: *proposed' docs/adr/[0-9]*.md); do
            d=$(grep -oE '^\*\*Date\*\*: *[0-9]{4}-[0-9]{2}-[0-9]{2}' "$f" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
            if [ -z "$d" ]; then echo "ERROR: $f has no Date field"; fail=1; continue; fi
            age=$(( ( $(date +%s) - $(date -d "$d" +%s) ) / 86400 ))
            if [ "$age" -gt 14 ]; then
              echo "ERROR: $f has been PROPOSED for $age days — resolve the decision"
              fail=1
            fi
          done
          exit $fail
```

يمنع فحص CI هذا القرارات المتعثرة من التقادم بصمت في المستودع.

---

## ربط سجلات القرارات بالكود

تكون سجلات القرارات في أعلى قيمتها حين يصادفها المهندسون في سياقها — أثناء قراءة الكود، لا البحث في موقع توثيق:

```java
// Link to ADR in code where the decision manifests
@Service
public class PaymentLedgerService {

    /**
     * Uses PostgreSQL with explicit transaction management.
     * Decision rationale: see docs/adr/0001-use-postgresql.md
     *
     * Note: Double-entry accounting requires ACID guarantees.
     * MongoDB was considered and rejected; see ADR-001 for details.
     * CockroachDB is tracked as a future option — see ADR-001 §Consequences.
     * SERIALIZABLE transactions can fail with serialization errors under
     * contention — callers retry (see the retry policy in LedgerConfig).
     */
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public LedgerEntry recordPayment(Payment payment) {
        // Double-entry: debit source account, credit destination account
        // Both writes are atomic — either both succeed or neither does
        ledgerRepository.debit(payment.getSourceAccountId(), payment.getAmount());
        ledgerRepository.credit(payment.getDestinationAccountId(), payment.getAmount());
        return ledgerRepository.createEntry(payment);
    }
}
```

يخبر رابط ADR في التعليق القارئ: "هذا ليس مصادفة؛ بل قرار متعمد بسياق موثق". ويمنع المهندس التالي من السؤال "لماذا نستخدم PostgreSQL هنا بينما MongoDB أبسط؟"

---

## أمثلة ADR في التقنية المالية

### ‏ADR: فحص الاحتيال المتزامن مقابل غير المتزامن

```markdown
# ADR-007: Fraud Check Integration — Synchronous, In-Path

**Status**: Accepted
**Date**: 2026-11-01
**Deciders**: Principal Engineer (Payments), Head of Compliance

## Context

Payment flow must include a fraud check. Options:
1. Synchronous: check blocks payment processing (~50ms p95 latency impact)
2. Asynchronous: check runs after payment authorised; fraudulent payments reversed later

## Decision Outcome

Chosen: **Synchronous, in-path fraud check**

Reason: Faster Payments are irrevocable once sent. Getting money back means asking
the receiving bank to return it, which is slow and often fails — in our own data
only ~65% of fund-recovery requests succeed (illustrative figure). Since October 2024
UK payment firms must also reimburse most APP-fraud victims (PSR rules), so a
fraudulent payment that goes out is very likely a direct firm loss.
The 50ms latency impact is acceptable under our SLA (p99 < 300ms).

Negative consequences:
- Fraud service becomes a critical path dependency; its SLA now constrains our SLA
- Requires a circuit breaker with safe fallback (allow or deny) in case fraud service is unreachable
- See ADR-008 — Fraud service circuit breaker strategy

## Rejected Option: Asynchronous Post-Authorisation

Rejected because: a large share of detected fraud would still become an
irrecoverable loss, which is unacceptable.
Revisit if fraud service p95 latency exceeds 200ms (breach of our SLA).
```

### ‏ADR: تخزين مفاتيح عدم التكرار

```markdown
# ADR-012: Idempotency Key Storage — PostgreSQL over Redis

**Status**: Accepted

## Context

Payment API requires idempotency keys (see RFC-055). Keys must be stored and
checked on every payment request. The check must be atomic with the payment write.

## Decision Outcome

Chosen: **PostgreSQL idempotency key table** (same DB as payments)

Reason: Storing idempotency keys in the same PostgreSQL database as payments
allows the check and payment write to be in the same ACID transaction.
Redis would require a cross-system atomic check (compare-and-set), which
introduces a window for double-processing under failure.

Negative consequence: idempotency key table adds ~5% overhead to payment writes.
Partitioned by created_at week; old partitions dropped after 7 days.
```

---

## بناء ثقافة ADR: دور المهندس الرئيسي

تغيير الثقافة أصعب جزء. فالأدوات التقنية سهلة. ومهمة المهندس الرئيسي جعل كتابة سجلات القرارات أسهل الطرق:

**اجعل القالب بسيطًا لدرجة أنه يستغرق < 15 دقيقة**: قالب من ثلاث صفحات يقتل التبني. وصيغة MADR بخمسة أقسام (السياق، والدوافع، والخيارات، والقرار، والعواقب) تتسع في صفحتين.

**اكتب أول 10 سجلات بنفسك**: كن نموذجًا للسلوك الذي تريده. فإن كتب أكثر شخص تقني أقدمية في الغرفة سجلات قرارات، سيكتبها الآخرون أيضًا.

**راجع سجلات القرارات في مراجعة الكود**: "يفترض هذا التنفيذ X. كان ذلك قرارًا متعمدًا موثقًا في ADR-007. هذا هو الرابط". فهذا يُثبت للفريق أن سجلات القرارات تُقرأ، لا تُكتب فقط.

**اجعل "أين ADR لهذا؟" سؤالًا عاديًا**: حين يقترح أحد تغييرًا مهمًا في مراجعة تصميم ولا يوجد ADR — اطلب واحدًا. لا كحراسة للبوابة، بل كطلب صادق "ساعدنا على فهم المبرر".

**سؤال الاستعادة**: "هل اتخذنا أي قرارات في هذا السباق سنتساءل عنها في المستقبل؟" في نهاية كل سباق، افحص صراحة القرارات المعمارية غير الموثقة.

---

## مراجعة سجلات القرارات في طقوس الفريق

| الطقس | دمج ADR |
|---|---|
| استعادة السباق | "أي قرارات في هذا السباق تستحق التسجيل؟" |
| المحاضرات التقنية | "قبل العرض، دعوني أشارك ADR — فهو يشرح الأجزاء غير الواضحة" |
| ضم الموظفين الجدد | "اقرأ هذه السجلات العشرة قبل نهاية أسبوعك الأول" |
| مراجعة الكود | "هذا يخالف ADR-005. ويشرح السجل لماذا لا يمكننا فعلها بهذه الطريقة." |
| المراجعة المعمارية | "ما القرارات التي اتُّخذت؟ أين سجلاتها؟" |
| تحليل ما بعد الحادث | "هل وُثق هذا القرار؟ هل يجب تحديثه بناءً على ما تعلمناه؟" |

---

## الأنماط المضادة

**مقبرة سجلات القرارات**: مجلد فيه 200 سجل، معظمها قديم. والحل مراجعات فصلية لدورة الحياة — وسم القديمة كمُستبدَلة أو مُهمَلة.

**السجل غير المرتبط**: يوجد ADR لكن لا يرتبط به أي كود. فلا يُكتشف أبدًا. والحل: اشتراط روابط ADR في مراجعة الكود للقرارات التي تظهر في الكود.

**سجل التبرير اللاحق**: القرار متخذ بالفعل، ويُكتب ADR لتبريره دون توثيق صادق للبدائل. والحل: استخدم RFC للاستكشاف قبل القرار؛ وADR لتسجيل القرارات بصدق.

**السجل كوثيقة لوم**: "كتبنا ADR-005 الذي يقول لا تستخدموا X — وهذا الفريق خالفه". سجلات القرارات معرفة مؤسسية، لا أسلحة امتثال. وحين يُخالف سجل، اسأل: هل ما زال السجل صحيحًا؟

**السجل ذو الصفحات العشر**: أطول من أن يُقرأ، وأبطأ من أن يُكتب. أبقِ سجلات القرارات في صفحة إلى صفحتين. وإن لزم سياق أكثر، اربط بـ RFC أو وثيقة تصميم.

---

## الخلاصات الأساسية

- يقترح RFC ويناقش؛ ويسجّل ADR — وكلاهما مطلوب؛ واستخدم كلًا لغرضه.
- اكتب سجلات القرارات حين تكون كلفة التراجع عالية أو النطاق واسعًا. وتخطَّها لتفاصيل التنفيذ الواضحة من الكود.
- صيغة MADR في المستودع، لا في Confluence — خاضعة لإدارة الإصدارات بجوار الكود الذي تصفه.
- اربط سجلات القرارات من تعليقات الكود حيث يظهر القرار — فهنا تكون سجلات القرارات في أعلى قيمتها.
- بناء ثقافة ADR يتطلب أن يكون المهندس الرئيسي نموذجًا للسلوك: يكتب الأولى، ويطلبها في مراجعة الكود، ويضمّنها في الاستعادات.
- يُقاس المهندسون الرئيسيون بالذاكرة المؤسسية، لا بالعمق التقني فقط. وسجلات القرارات هي طريقة ترميز تلك الذاكرة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق الأساسي بين RFC وADR؟",
      "options": [
        "يكتب المهندسون الأوائل طلبات التعليقات؛ ويكتب كل المهندسين سجلات القرارات",
        "يقترح RFC القرارات ويناقشها قبل اتخاذها؛ ويسجّل ADR القرارات بعد اتخاذها",
        "تُخزن طلبات التعليقات في Confluence؛ وسجلات القرارات في المستودع",
        "تتطلب طلبات التعليقات تصويت الفريق؛ ويكتب صانع القرار سجلات القرارات وحده"
      ],
      "correct": 1,
      "explanation": "طلبات التعليقات وثائق ما قبل القرار مصممة لاقتراح البدائل وبناء التوافق. وسجلات القرارات سجلات ما بعد القرار تلتقط ما تقرر، ولماذا، وما البدائل المدروسة، وما العواقب. وكثيرًا ما ينتج RFC سجل ADR — لكن ADR يمكن أن يوجد أيضًا دون RFC سابق للقرارات الأصغر."
    },
    {
      "text": "لماذا يجب تخزين سجلات القرارات في المستودع بدل Confluence؟",
      "options": [
        "لدى Confluence حدود تخزين",
        "سجلات القرارات المخزنة في المستودع خاضعة لإدارة الإصدارات بجوار الكود الذي تصفه، وتبقى قابلة للاكتشاف بمرور الوقت، ويمكن ربطها من تعليقات الكود",
        "‏Confluence مكلف جدًا لتخزين سجلات القرارات",
        "المطورون فقط لديهم وصول إلى Confluence"
      ],
      "correct": 1,
      "explanation": "سجلات القرارات في المستودع خاضعة لإدارة الإصدارات، وقابلة للبحث بأدوات البحث في الكود القياسية، وقابلة للاكتشاف عند قراءة الكود، ومتزامنة مع الكود الذي تصفه. أما صفحات Confluence فتنحرف عن الواقع مع تطور الكود، وتتقادم دون فرض آلي، ويصعب ربطها من تعليقات الكود."
    },
    {
      "text": "يقرر فريق بين تخزين مفاتيح عدم التكرار في Redis مقابل PostgreSQL. ويدعو المهندس الرئيسي إلى PostgreSQL لأنه يتيح أن يكون فحص عدم التكرار وكتابة الدفع في معاملة ACID واحدة. كيف يجب تسجيل هذا القرار؟",
      "options": [
        "لا حاجة إلى ADR — هذا تفصيل تنفيذ",
        "سجل ADR يوثق الخيارين، ومبرر ذرية ACID لـ PostgreSQL، وخيار Redis المرفوض مع الشرح",
        "تعليق كود فقط في خدمة عدم التكرار",
        "صفحة Confluence مرتبطة من ويكي الفريق"
      ],
      "correct": 1,
      "explanation": "هذا القرار مرشح مثالي لـ ADR: المبرر (ذرية ACID عبر فحص عدم التكرار وكتابة الدفع) غير واضح من الكود، ووُجدت خيارات معقولة متعددة، وتغييره لاحقًا مكلف. وسيتساءل المهندسون المستقبليون 'لماذا PostgreSQL لا Redis؟' — ويجيب ADR عن ذلك السؤال بشكل دائم."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تطبيق ثقافة ADR لفريق منصة دفع",
  "difficulty": "principal",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "اكتب ADR كاملًا بصيغة MADR للقرار التالي: يجب أن تختار خدمة دفع بين فحص احتيال متزامن (يحجب الدفع، ويضيف ~50 مللي ثانية، ويمنع المدفوعات الاحتيالية) مقابل فحص احتيال غير متزامن (غير حاجب، وقد يسمح بمدفوعات احتيالية يجب عكسها لاحقًا). وضمّن: السياق بإطار تنظيمي محدد، ودوافع القرار، والخيارين مع مزايا/عيوب صريحة، والخيار المختار مع المبرر، والعواقب السلبية، وإحالة إلى ADR افتراضي لقاطع الدائرة."
    },
    {
      "id": "2",
      "description": "صمّم عملية حوكمة سجلات القرارات لمؤسسة هندسية في التقنية المالية من 50 مهندسًا و15 مستودعًا. وحدد: (أ) أين تعيش سجلات القرارات في كل مستودع، (ب) كيف تُدار سجلات القرارات العابرة للمستودعات (التي تؤثر على كل الفرق)، (ج) أي عملية مراجعة يمر بها ADR قبل الانتقال من مقترح إلى مقبول، (د) كيف تستخدم لجنة المراجعة المعمارية سجلات القرارات في عمليتها."
    },
    {
      "id": "3",
      "description": "اكتب سير عمل GitHub Actions الذي يفرض جودة سجلات القرارات على طلبات السحب التي تمس docs/adr/: ‏(أ) يتحقق من أن لكل ADR حقل Status، (ب) يُفشل البناء إن بقي أي ADR في حالة مقترح أكثر من 14 يومًا، (ج) يشترط موافقة CODEOWNERS من ‎@architecture-leads. واكتب مُدخل CODEOWNERS المرافق وفقرة تبرير واحدة لأهمية مراجعة قادة المعمار لسجلات القرارات تحديدًا في بيئة PCI-DSS."
    },
    {
      "id": "4",
      "description": "أجرِ تمرين علم آثار القرارات: خذ أي قاعدة كود تعرفها (أو اخترع واحدة) وحدد 5 أماكن يتخذ فيها الكود اختيارًا معماريًا غير واضح دون توثيق. ولكل منها، اكتب وصفًا من جملة واحدة لالتباس القارئ المستقبلي الذي كان ADR المفقود سيمنعه، ثم اكتب مسودة MADR مختصرة (السياق + نتيجة القرار فقط، دون تحليل كامل) للأهم منها."
    }
  ]
}
-->
