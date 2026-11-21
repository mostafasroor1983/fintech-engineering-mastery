---
id: track-01-lesson-02
title: "سجلات القرارات المعمارية — ممارسة ADR"
slug: adr-practice
track: track-01
trackName: "البنية المعمارية المتقدمة للبرمجيات"
sequence: 2
difficulty: advanced
estimatedMinutes: 70
status: published
tags:
  - ADR
  - MADR
  - architecture-decision
  - documentation
  - RFC
---

# سجلات القرارات المعمارية — ممارسة ADR

القرارات المعمارية هي أغلى ما تتخذه فرق البرمجيات وأقلها توثيقًا. يعلّمك هذا الدرس كيف تسجّل القرارات المعمارية وتحكمها وتطوّرها باستخدام صيغة MADR، وأداة adr-tools، والتكامل مع Backstage، والفرض عبر CI — وكل ذلك مبني على خبرة إنتاج حقيقية في التقنية المالية.

---

## 1. مشكلة "لماذا لم يستخدموا ببساطة…؟"

كل مهندس يرث قاعدة شيفرة يسأل في النهاية: *لماذا لم يستخدموا Kafka ببساطة بدل هذا الطابور المصنوع يدويًا؟* والإجابة غالبًا محبوسة في رأس شخص ما أو مدفونة في صفحة Confluence لا يجدها أحد. وتتراكم الكلفة:

- قد يقضي المهندسون الكبار الجدد أسابيع من فترة انضمامهم في إعادة استنتاج القرارات السابقة
- تكرر الفرق تجارب استكشافية (spikes) مكلفة أُجريت قبل ثلاث سنوات
- حوادث سببها قيود أُسيء فهمها (مثل "يجب ألا يُفرَّغ هذا الجدول أبدًا") تبقى غير مكتشفة حتى ينفجر الإنتاج
- عمليات التدقيق التنظيمي (PCI-DSS، وSOC 2) تطلب دليلًا على *سبب* وجود الضوابط — والقرارات غير الموثقة تتحول إلى ملاحظات تدقيق

```
                    COST OF UNDOCUMENTED DECISIONS
                    ================================

  Time since decision ─────────────────────────────────►

  Reconstruct │███████████████████████████████████████
  cost        │
              │          Documented │░░░░░░░░░░░░░░░░
              │          Undocumented │████████████████████████
              │
              │     6 mo    1 yr    2 yr    3 yr    5 yr
```

يوضح الرسم أن كلفة إعادة بناء فهم القرار تزداد مع الوقت، وتزداد أسرع بكثير عندما لا يكون موثقًا.

سجلات القرارات المعمارية (ADR) مستندات قصيرة ومنظمة تجيب عن: *ماذا* قُرّر، و*لماذا* اختير هذا الخيار على البدائل، و*بماذا* قبلنا أن نضحّي.

---

## 2. ‏RFC أم ADR — متى تستخدم كلًّا منهما

طلب التعليقات (RFC) وسجل ADR متكاملان، لا متنافسان.

| البُعد | RFC | ADR |
|---|---|---|
| التوقيت | قبل القرار | بعد اتخاذ القرار |
| الهدف | جمع الآراء وبناء التوافق | تسجيل النتيجة ومبرراتها |
| الجمهور | صانعو القرار وأصحاب المصلحة | المهندسون الذين سيصونون النظام مستقبلًا |
| الطول | من 2 إلى 10 صفحات | صفحة أو صفحتان |
| دورة الحياة | مقبول / مرفوض / مسحوب | مقترح / مقبول / متقادم / مستبدَل / مرفوض |
| المالك | الكاتب (مهندس قائد / رئيسي) | الفريق المالك للمكوّن |

سير العمل:

```
  New architectural need
         │
         ▼
  Write RFC (optional for small teams)
  Circulate for comment (async 48 h)
         │
         ├─── Approved ───► Write ADR (status: ACCEPTED)
         │
         ├─── Rejected ───► Optional ADR (status: REJECTED) so the
         │                  idea is not proposed again without new facts
         │
         └─── Withdrawn ──► No ADR; note the reason in the RFC
```

أي: عند الموافقة اكتب سجل ADR بحالة "مقبول". وعند الرفض يمكنك كتابة سجل بحالة "مرفوض" حتى لا تُقترح الفكرة مجددًا دون معطيات جديدة. وعند سحب الطلب لا حاجة إلى سجل؛ اكتب السبب في الـ RFC.

**قاعدة عملية في التقنية المالية:** أي قرار يؤثر في ديمومة البيانات، أو ضمانات الاتساق، أو نطاق PCI، أو اتفاقيات مستوى التوفر (SLA) يستحق سجل ADR حتى لو لم يُكتب RFC.

---

## 3. صيغة MADR بالتفصيل

‏MADR ‏(Markdown Any Decision Record) هو أكثر قوالب ADR انتشارًا. قابل للقراءة آليًا، وسهل المقارنة بين الإصدارات (diff)، ويُعرض بشكل نظيف في GitHub / GitLab.

### 3.1 القالب

```markdown
# [short title of solved problem and solution]

**Date:** YYYY-MM-DD
**Status:** [Proposed | Accepted | Deprecated | Superseded | Rejected]
**Supersedes:** [ADR-NNN] (if applicable)
**Superseded by:** [ADR-NNN] (if applicable)

## Context and Problem Statement

[Describe the context and problem clearly. What forces are at play?
What constraints are non-negotiable?]

## Decision Drivers

* [force 1]
* [force 2]
* [force 3]

## Considered Options

* [option 1]
* [option 2]
* [option 3]

## Decision Outcome

**Chosen option: [option X]**, because [justification — why this option
best satisfies the decision drivers].

### Positive Consequences

* [positive consequence 1]

### Negative Consequences

* [negative consequence 1]

## Pros and Cons of the Options

### [option 1]

[Description]

* Good, because [argument a]
* Bad, because [argument b]

### [option 2]
...
```

أقسام القالب: السياق وبيان المشكلة، ومحركات القرار (القوى المؤثرة)، والخيارات المدروسة، ونتيجة القرار مع مبرراتها، والعواقب الإيجابية والسلبية، ثم مزايا كل خيار وعيوبه. نُبقي القوالب والأمثلة بالإنجليزية لأنها مستندات تُنسخ إلى المستودع كما هي.

### 3.2 مثال تطبيقي — PostgreSQL أم MongoDB لدفتر أستاذ المدفوعات

```markdown
# ADR-0012: Use PostgreSQL for the Payments Ledger

**Date:** 2024-03-15
**Status:** Accepted
**Supersedes:** N/A

## Context and Problem Statement

The new ledger service must store immutable double-entry bookkeeping
records for 50 M+ transactions per year. Each entry must reference
accounts, currencies, exchange rates, and audit metadata.
We need ACID guarantees across multi-row inserts (debit + credit must
both succeed or both fail). The team is evaluating PostgreSQL 16 vs
MongoDB 7.

## Decision Drivers

* Strict ACID semantics for double-entry inserts
* Complex query patterns: balance-at-point-in-time, monthly roll-ups
* PCI-DSS requirement for field-level encryption (column encryption)
* Team has 4 engineers with 5+ years Postgres experience; 0 with Mongo
* 99.99 % uptime SLA — primary + 2 async replicas minimum

## Considered Options

* PostgreSQL 16 with logical replication
* MongoDB 7 with multi-document ACID transactions
* CockroachDB (distributed SQL)

## Decision Outcome

**Chosen option: PostgreSQL 16**, because it provides native multi-row
ACID transactions without the overhead of session-pinned distributed
transactions, the team's existing expertise reduces operational risk,
and pgcrypto satisfies the column-encryption requirement.
CockroachDB was ruled out due to 3× cost and no existing audit evidence in our PCI scope.

### Positive Consequences

* Balance queries can use window functions natively
* Existing runbooks for PITR, pgBouncer, and Patroni apply directly
* Column-level encryption via pgcrypto + AWS KMS already approved by security

### Negative Consequences

* Horizontal write-sharding requires application-level partitioning if
  write throughput exceeds ~50 k TPS (acceptable for 3-year horizon)
* Schema migrations require careful expand-contract discipline

## Pros and Cons of the Options

### PostgreSQL 16

Purpose-built relational engine with 30+ years of ACID guarantees.

* Good, because multi-row transactions are first-class
* Good, because rich query planner handles complex reporting queries
* Good, because team expertise reduces onboarding risk
* Bad, because vertical scaling ceiling (~50 k TPS writes per node)

### MongoDB 7

Document store with multi-document ACID since v4.

* Good, because schema flexibility for evolving event payloads
* Bad, because multi-document transactions added ~12 ms per write in our spike
* Bad, because field-level encryption is client-side (CSFLE), a path our security team had not yet approved
* Bad, because point-in-time balance and roll-up queries are harder to write and tune than in SQL

### CockroachDB

Distributed SQL with automatic sharding.

* Good, because unlimited horizontal write scaling
* Bad, because 3× infrastructure cost vs managed RDS
* Bad, because our auditors had no prior evidence for it in our PCI / SOC 2 scope
```

خلاصة المثال: اختير PostgreSQL لأن معاملاته متعددة الصفوف أصيلة وكاملة الخصائص (ACID)، ولخبرة الفريق، ولأن تشفير الأعمدة عبر pgcrypto وAWS KMS معتمد مسبقًا من فريق الأمان. ورُفض MongoDB لأن المعاملات متعددة المستندات أضافت نحو 12 ms لكل كتابة في التجربة، ولأن تشفير الحقول فيه يتم من جهة العميل (CSFLE) وهو مسار لم يعتمده فريق الأمان بعد. ورُفض CockroachDB بسبب الكلفة (3 أضعاف) وغياب أدلة تدقيق سابقة له ضمن نطاق PCI لدينا.

---

## 4. دورة حياة سجل ADR

```
  ┌──────────┐    review     ┌──────────┐
  │ PROPOSED │──────────────►│ ACCEPTED │
  └──────────┘               └────┬─────┘
       │                          │  time passes / context changes
       │ declined                 ▼
       ▼                    ┌────────────┐    new ADR written
  ┌──────────┐              │ DEPRECATED │──────────────────►┌────────────┐
  │ REJECTED │              └────────────┘                   │ SUPERSEDED │
  └──────────┘                                               └────────────┘
```

| الحالة | المعنى | الإجراء المطلوب |
|---|---|---|
| PROPOSED (مقترح) | قيد المراجعة، ولم يُتخذ القرار بعد | الـ RFC مفتوح أو بانتظار موافقة المهندس الرئيسي |
| ACCEPTED (مقبول) | القرار ساري | نفّذ وفق السجل |
| DEPRECATED (متقادم) | القرار لم يعد صالحًا لكن لا يوجد بديل بعد | لا تبنِ عملًا جديدًا على هذا السجل |
| SUPERSEDED (مستبدَل) | حلّ محله سجل أحدث | أضف الرابط `Superseded by: ADR-NNN` |
| REJECTED (مرفوض) | لم يُقبل المقترح | سجّل السبب؛ بلا تنفيذ |

---

## 5. مصفوفة وزن القرار

ليس كل اختيار يحتاج سجل ADR. استخدم هذه المصفوفة:

```
                 REVERSIBILITY
                 High (easy to change)   Low (costly to change)
IMPACT    Low  │ Skip                  │ Consider (1-pager)   │
          High │ Consider (1-pager)    │ REQUIRED             │
```

المحوران: الأثر (منخفض/مرتفع) وقابلية التراجع (سهل التغيير/مكلف التغيير). أثر منخفض وتراجع سهل: تخطَّ. أثر مرتفع وتراجع مكلف: سجل ADR إلزامي. وما بينهما: فكّر في صفحة واحدة.

**اكتب سجل ADR دائمًا عندما:**
- يصعب التراجع عن القرار (نموذج البيانات، أو بروتوكول المراسلة، أو معيار المصادقة)
- يؤثر في عدة فرق أو خدمات
- له آثار امتثالية أو أمنية أو تنظيمية
- أُجريت تجربة استكشافية أو إثبات مفهوم (PoC) لتقييم الخيارات

**يمكنك التخطي عندما:**
- يكون القرار محليًا في صنف أو وحدة واحدة
- يتبع نمطًا مستقرًا مسجلًا في سجل ADR أعلى مستوى
- يمكن التراجع عنه بسهولة بجهد يوم واحد

---

## 6. إعداد أداة adr-tools واستخدامها

توفر [adr-tools](https://github.com/npryce/adr-tools) واجهة سطر أوامر لإدارة سجلات ADR داخل المستودع.

```bash
# Install via Homebrew (macOS) or build from source
brew install adr-tools

# Initialise ADR directory in your repository
cd /path/to/your/service
adr init docs/decisions

# Creates:
# docs/decisions/0001-record-architecture-decisions.md

# Create a new ADR
adr new "Use PostgreSQL for the Payments Ledger"
# → docs/decisions/0012-use-postgresql-for-the-payments-ledger.md

# Create a new ADR that supersedes ADR 12 (updates the status of both files)
adr new -s 12 "Use CockroachDB for Payments Ledger"

# Generate a table of contents
adr list
adr generate toc

# Generate a visual graph of ADR relationships
adr generate graph | dot -Tpng > adr-graph.png
```

### تنظيم المجلدات في المستودعات الموحّدة متعددة الوحدات

```
repo-root/
  docs/
    decisions/              ← cross-cutting decisions
      0001-use-postgresql.md
      0012-fraud-async.md
  services/
    payment-service/
      docs/decisions/       ← service-specific decisions
        0001-use-stripe-sdk.md
    ledger-service/
      docs/decisions/
        0001-postgresql-ledger.md
```

القرارات العابرة للخدمات في `docs/decisions` على مستوى المستودع، والقرارات الخاصة بكل خدمة داخل مجلد الخدمة نفسها.

---

## 7. إضافة ADR في Backstage للمؤسسات متعددة المستودعات

للمؤسسات التي لديها 10 مستودعات أو أكثر، يوفر Backstage عرضًا مركزيًا لكل سجلات ADR عبر الإضافة `@backstage-community/plugin-adr`.

### وسم catalog-info.yaml

```yaml
# services/payment-service/catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  annotations:
    backstage.io/adr-location: docs/decisions
spec:
  type: service
  lifecycle: production
  owner: payments-team
```

### تثبيت الإضافة (تطبيق Backstage)

```typescript
// packages/app/src/App.tsx
import { AdrPage } from '@backstage-community/plugin-adr';

const routes = (
  <FlatRoutes>
    <Route path="/adrs" element={<AdrPage />} />
    {/* ... */}
  </FlatRoutes>
);
```

```typescript
// packages/app/src/components/catalog/EntityPage.tsx
import { EntityAdrContent, isAdrAvailable } from '@backstage-community/plugin-adr';

const serviceEntityPage = (
  <EntityLayout>
    <EntityLayout.Route
      path="/adrs"
      title="ADRs"
      if={isAdrAvailable}
    >
      <EntityAdrContent />
    </EntityLayout.Route>
  </EntityLayout>
);
```

يُظهر هذا كل سجلات ADR لكل مكوّن في كتالوج Backstage، فيصبح اكتشافها بين الفرق أمرًا سهلًا.

---

## 8. الفرض عبر CI — سير عمل فحص في GitHub Actions

افرض أن تكون سجلات ADR الجديدة سليمة البنية، وأن تكون السجلات المستبدَلة مرتبطة بالسجلات التي حلّت محلها.

```yaml
# .github/workflows/adr-lint.yml
name: ADR Lint

on:
  pull_request:
    paths:
      - 'docs/decisions/**'
      - 'services/**/docs/decisions/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # needed for the origin/main...HEAD diff

      - name: Validate MADR fields in changed ADRs
        run: |
          set -euo pipefail
          ERRORS=0
          CHANGED=$(git diff --name-only --diff-filter=AM origin/main...HEAD \
                    | grep -E '(^|/)decisions/[^/]+\.md$' || true)
          for f in $CHANGED; do
            echo "Checking $f"
            # Must contain Status line
            if ! grep -qE "^\*\*Status:\*\*" "$f"; then
              echo "ERROR: $f missing **Status:** field"
              ERRORS=$((ERRORS+1))
            fi
            # Must contain Date line
            if ! grep -qE "^\*\*Date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}" "$f"; then
              echo "ERROR: $f missing or malformed **Date:** field"
              ERRORS=$((ERRORS+1))
            fi
            # SUPERSEDED must reference a newer ADR
            if grep -qE "^\*\*Status:\*\* Superseded" "$f"; then
              if ! grep -qE "^\*\*Superseded by:\*\* ADR-[0-9]+" "$f"; then
                echo "ERROR: $f is Superseded but missing **Superseded by:** reference"
                ERRORS=$((ERRORS+1))
              fi
            fi
          done
          exit $ERRORS

      - name: Check ADR file names
        run: |
          # Ensure ADR filenames follow 0NNN-slug.md pattern
          find . -path "*/decisions/*.md" | \
            grep -vE "/decisions/[0-9]{4}-[a-z0-9-]+\.md$" | \
            grep -v "README" | \
            while read f; do
              echo "ERROR: $f does not follow 0NNN-slug.md naming convention"
              exit 1
            done
```

يفحص سير العمل السجلات التي تغيّرت في طلب الدمج فقط: وجود حقل الحالة، وحقل التاريخ بصيغة صحيحة، ووجود رابط "Superseded by" في كل سجل مستبدَل؛ ثم يتحقق من أن أسماء الملفات تتبع النمط `0NNN-slug.md`.

---

## 9. ربط سجلات ADR من تعليقات الشيفرة

لا تكون سجلات ADR مفيدة إلا إذا صادفها المهندسون أثناء عملهم. اربطها من الشيفرة التي تنفّذ القرار.

```java
/**
 * Ledger entry repository.
 *
 * <p>Uses PostgreSQL for all persistence — see ADR-0012 for the full
 * rationale (MongoDB and CockroachDB were evaluated and rejected).
 *
 * @see <a href="docs/decisions/0012-use-postgresql-for-the-payments-ledger.md">ADR-0012</a>
 */
@Repository
public class LedgerEntryRepository {

    // ADR-0012: double-entry inserts are wrapped in a single transaction.
    // Do NOT split debit and credit into separate transactions — this
    // was an explicit rejection criterion against MongoDB's approach.
    @Transactional
    public void record(DebitEntry debit, CreditEntry credit) {
        jdbcTemplate.update(INSERT_LEDGER_SQL, debit.toParams());
        jdbcTemplate.update(INSERT_LEDGER_SQL, credit.toParams());
    }
}
```

```java
// ADR-0017: Idempotency responses are cached in Redis for 24 hours;
// PostgreSQL holds the keys as the source of truth.
// See docs/decisions/0017-idempotency-key-storage.md
// WARNING: Do not change TTL without updating ADR-0017.
private static final Duration IDEMPOTENCY_TTL = Duration.ofHours(24);
```

---

## 10. ثلاثة أمثلة ADR خاصة بالتقنية المالية

### 10.1 ‏ADR-0012 — اختيار قاعدة البيانات لدفتر أستاذ المدفوعات

عُرض في القسم 3.2. الخلاصة: المعاملات متعددة الصفوف كاملة الخصائص (ACID) وتشفير الأعمدة هما ما حسم اختيار PostgreSQL.

### 10.2 ‏ADR-0015 — فحص الاحتيال: متزامن أم غير متزامن

```markdown
# ADR-0015: Run Fraud Checks Asynchronously for Low-Risk Transactions

**Date:** 2024-05-01
**Status:** Accepted

## Context and Problem Statement

The fraud detection ML model (FraudGuard v2) adds 180–220 ms p99 latency
when called synchronously in the payment authorisation path. Card network
rules require sub-300 ms responses. With existing gateway overhead (80 ms),
the synchronous call leaves 0–40 ms of margin — insufficient for peak load.

## Decision Drivers

* Card network sub-300 ms authorisation requirement
* Fraud detection must cover >99.5 % of transactions
* Acceptable fraud loss budget: <0.05 % of GMV

## Considered Options

* Fully synchronous (block until FraudGuard responds)
* Fully asynchronous (authorise first, cancel async if fraudulent)
* Risk-stratified: sync for high-risk, async for low-risk

## Decision Outcome

**Chosen option: Risk-stratified**, routing transactions through a rule
engine first. High-risk (>$5000, new device, foreign card) are blocked
synchronously. Low-risk bypass the synchronous call and trigger an async
review within 50 ms of authorisation.

### Negative Consequences

* ~0.3 % of low-risk transactions may need reversal if async fraud
  signal arrives within the settlement window (accepted by Risk team).
```

الفكرة: نموذج الاحتيال يضيف 180–220 ms، وميزانية التفويض 300 ms منها 80 ms للبوابة، فلا يبقى هامش كافٍ. لذلك تُفحص المعاملات عالية المخاطر بشكل متزامن، وتُفحص منخفضة المخاطر بعد التفويض، مع قبول عكس نحو 0.3% منها عند الحاجة.

### 10.3 ‏ADR-0017 — تخزين مفاتيح منع التكرار

```markdown
# ADR-0017: Store Idempotency Keys in PostgreSQL, Cache Replays in Redis

**Date:** 2024-06-10
**Status:** Accepted

## Context and Problem Statement

Payment API clients retry on network failure. Without idempotency enforcement,
a client timeout can result in duplicate charges. Replayed requests should be
answered in under 5 ms at 20 k RPS peak load.

## Decision Drivers

* Keys must survive a Redis node failure (no duplicate charges)
* Sub-5 ms p99 for replayed requests at 20 k RPS
* 24-hour retention (matches maximum client retry window per API contract)

## Considered Options

* Redis only
* Redis first, copied to PostgreSQL asynchronously (write-behind)
* PostgreSQL as source of truth, Redis as a cache of stored responses

## Decision Outcome

**Chosen option: PostgreSQL as source of truth, Redis as cache.**
The key is inserted with ON CONFLICT DO NOTHING in the same transaction as
the payment, so a key can never exist without its payment or be lost with
Redis. The stored response is then cached in Redis (24 h TTL) so replays
are fast; a cache miss falls back to PostgreSQL. A nightly job purges keys
older than 24 h. Write-behind was rejected: a Redis failure before the copy
would lose keys and allow duplicate charges.
```

الفكرة: المصدر الموثوق للمفاتيح هو PostgreSQL، ويُدخل المفتاح في معاملة الدفعة نفسها، فلا يضيع مع تعطل Redis. وRedis مجرد ذاكرة مؤقتة للردود المخزنة لتسريع الإعادات. ورُفض أسلوب "الكتابة المؤجلة" (write-behind) لأن تعطل Redis قبل النسخ يُضيّع مفاتيح ويسمح بخصم مزدوج.

---

## 11. بناء ثقافة حول سجلات ADR

### دور المهندس الرئيسي

المهندسون الرئيسيون هم أهم رافعة لتبنّي سجلات ADR. ومسؤولياتهم:

1. **القدوة** — كتابة أول 3 إلى 5 سجلات لكل مجال يعملون فيه
2. **بوابة المراجعة** — جعل وجود سجل ADR معيارًا في مراجعة طلبات الدمج للتغييرات المؤثرة
3. **الاستفادة من الحوادث** — عندما يعود سبب حادثة إنتاج إلى افتراض غير موثق، اكتب *سجل ADR بأثر رجعي* يوضح ما قُرّر ضمنيًا ولماذا كان خاطئًا
4. **مرساة الانضمام** — توجيه المهندسين الجدد إلى فهرس سجلات ADR كأول محطة في الانضمام

### أنماط خاطئة يجب تجنبها

```
ANTI-PATTERN 1: The Rubber-Stamp ADR
--------------------------------------
Symptoms: ADR written after implementation, options section is empty
         or contains obviously strawman alternatives.
Fix: ADR must be written before code is merged. The PR that
     implements the decision must link the ADR.

ANTI-PATTERN 2: The Novel
--------------------------------------
Symptoms: ADR is 15 pages with appendices, nobody reads it.
Fix: 1–2 pages maximum. Link to separate design docs for depth.

ANTI-PATTERN 3: The Oracle
--------------------------------------
Symptoms: Only the principal engineer writes ADRs; team feels
         they need "permission" to document decisions.
Fix: Any engineer can propose an ADR. The principal approves,
     not authors.

ANTI-PATTERN 4: The Graveyard
--------------------------------------
Symptoms: ADRs exist but are never updated or referenced.
Fix: CI lint + quarterly ADR review in architecture guild.
```

1. **ختم الموافقة الشكلي:** يُكتب السجل بعد التنفيذ، وقسم الخيارات فارغ أو فيه بدائل وهمية. الحل: يُكتب السجل قبل دمج الشيفرة، ويربط طلب الدمج الذي ينفذ القرار بالسجل.
2. **الرواية الطويلة:** سجل من 15 صفحة لا يقرؤه أحد. الحل: صفحة أو صفحتان كحد أقصى، مع روابط لمستندات تصميم منفصلة للتفاصيل.
3. **العرّاف:** المهندس الرئيسي وحده يكتب السجلات، فيشعر الفريق أنه يحتاج "إذنًا" للتوثيق. الحل: أي مهندس يستطيع اقتراح سجل؛ والمهندس الرئيسي يوافق ولا يكتب بالضرورة.
4. **المقبرة:** سجلات موجودة لكنها لا تُحدَّث ولا يُرجع إليها. الحل: فحص CI ومراجعة ربع سنوية في مجموعة البنية المعمارية.

### أداة Java: التحقق من مراجع ADR عند بدء التشغيل

```java
/**
 * On application startup, verifies that all ADR references in
 * @AdrReference annotations resolve to files that exist on the
 * classpath or the configured docs path.
 *
 * Fails fast if an ADR file is missing — prevents silent link rot.
 */
@Component
public class AdrReferenceValidator implements ApplicationRunner {

    private static final Logger log =
        LoggerFactory.getLogger(AdrReferenceValidator.class);

    @Value("${adr.docs-path:docs/decisions}")
    private String docsPath;

    @Override
    public void run(ApplicationArguments args) {
        List<String> missing = new ArrayList<>();
        ClassPathScanningCandidateComponentProvider scanner =
            new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(AdrReference.class));

        for (BeanDefinition bd : scanner.findCandidateComponents("com.example")) {
            try {
                Class<?> clazz = Class.forName(bd.getBeanClassName());
                AdrReference ref = clazz.getAnnotation(AdrReference.class);
                if (ref != null) {
                    Path adrFile = Path.of(docsPath, ref.value() + ".md");
                    if (!Files.exists(adrFile)) {
                        missing.add(clazz.getSimpleName() + " → " + adrFile);
                    }
                }
            } catch (ClassNotFoundException e) {
                log.warn("Could not inspect class {}", bd.getBeanClassName());
            }
        }

        if (!missing.isEmpty()) {
            throw new IllegalStateException(
                "ADR files referenced in code are missing:\n" +
                String.join("\n", missing));
        }
        log.info("ADR reference validation passed ({} annotations checked)",
            scanner.findCandidateComponents("com.example").size());
    }
}

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface AdrReference {
    /** ADR filename without .md extension, e.g. "0012-use-postgresql-for-the-payments-ledger" */
    String value();
}
```

يفحص هذا المكوّن عند بدء التطبيق كل الأصناف التي تحمل الوسم `@AdrReference`، ويفشل فورًا إذا كان ملف سجل ADR المشار إليه غير موجود — فيمنع تآكل الروابط بصمت.

---

## 12. أخطاء شائعة في الإنتاج

### الخطأ 1: قرارات مبعثرة بين Confluence وNotion وGitHub

تستخدم الفرق أدوات مختلفة لقرارات مختلفة. وبعد أشهر لا يجدها كلها أي بحث.

**الحل:** اجمع سجلات ADR في git (مصدر الحقيقة). وانسخها إلى Confluence عبر Backstage TechDocs عند الحاجة، لكن git هو المرجع.

### الخطأ 2: سجل ADR مكتوب بصيغة المبني للمجهول بلا صانع قرار مسمّى

عبارة "تقرّر أن…" لا تخبر المهندسين في المستقبل بمن يسألون عن السياق.

**الحل:** أضف `**Deciders:** @alice @bob` إلى رأس السجل. هذا يخلق مساءلة ونقطة اتصال للأسئلة.

### الخطأ 3: حذف السجلات المستبدَلة بدل تعليمها

السجل المحذوف يترك فجوة في تسلسل الأرقام ويكسر الروابط في تعليقات الشيفرة.

**الحل:** لا تحذف سجلات ADR أبدًا. اجعل حالتها SUPERSEDED وأضف `**Superseded by:** ADR-NNNN`. فالسجل التاريخي ذو قيمة.

### الخطأ 4: تعارض أرقام السجلات في مستودع موحّد مع عدة فرق

يكتب فريقان الملف `0023-*.md` في اليوم نفسه.

**الحل:** استخدم أرقامًا تسلسلية عامة يفرضها فحص في CI، أو ترقيمًا محصورًا بالمجلد (`services/payment-service/decisions/0001-*.md`) مع فهرس عابر للمستودعات.

### الخطأ 5: مدققو الامتثال لا يجدون سجل ADR لضابط معين

يطلب المتطلب 6.3.2 في PCI DSS v4.0 قائمة جرد بالبرمجيات المطورة داخليًا ومكوّنات الطرف الثالث التي تستخدمها، ويسأل المدققون عن سبب وجود كل ضابط.

**الحل:** صنّف سجلات ADR بوسوم امتثال في رأس الملف، وولّد بيانًا للامتثال:

```bash
# Generate PCI control mapping from ADR frontmatter
grep -r "pci-req:" docs/decisions/ | \
  awk -F: '{print $3, $1}' | sort > compliance/pci-adr-mapping.txt
```

---

## 13. قائمة التحقق

- [ ] تهيئة مجلد ADR في كل مستودع خدمة (`adr init docs/decisions`)
- [ ] حفظ قالب MADR باسم `docs/decisions/0000-template.md`
- [ ] سير عمل CI يفحص حقول ADR في كل طلب دمج يمس `docs/decisions/`
- [ ] وسم `catalog-info.yaml` في Backstage بالمفتاح `adr-location` لكل مكوّن
- [ ] كل طلبات الدمج الجديدة للقرارات المؤثرة تربط سجل ADR المعني في الوصف
- [ ] تعليقات الشيفرة تشير إلى أرقام السجلات في كل موضع ينفّذ قرارًا
- [ ] السجلات المستبدَلة مرتبطة ببدائلها، لا محذوفة
- [ ] جلسة ربع سنوية لمجموعة البنية المعمارية تراجع السجلات القديمة
- [ ] مستند انضمام المهندسين الجدد يجعل فهرس السجلات الخطوة الأولى
- [ ] المهندس الرئيسي راجع ووافق على أول سجل ADR على الأقل لكل مجال
- [ ] سجلات ADR الموسومة بالامتثال تغذّي بيان أدلة PCI/SOC 2

---

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "سجل ADR حالته SUPERSEDED. ما الإجراء المطلوب في مستند MADR؟",
      "options": [
        "حذف الملف وإعادة ترقيم السجلات التالية",
        "إضافة حقل **Superseded by: ADR-NNN** يربط بالسجل البديل",
        "تغيير حقل الحالة إلى DEPRECATED وترك الباقي كما هو",
        "نقل الملف إلى مجلد archive/"
      ],
      "correct": 1,
      "explanation": "يتطلب عرف MADR حقل **Superseded by:** يربط بالسجل الذي حلّ محله. ويجب ألا يُحذف الملف أبدًا، لأن السياق التاريخي والروابط الواردة من الشيفرة تعتمد عليه."
    },
    {
      "text": "يتناقش فريق حول كتابة سجل ADR لقرار إعادة تسمية صنف مساعد محلي. ماذا تقول مصفوفة وزن القرار؟",
      "options": [
        "إلزامي — أي تغيير في الشيفرة يمس اسم صنف يجب توثيقه",
        "تخطَّ — الأثر المنخفض وسهولة التراجع يعنيان أن السجل لا يضيف قيمة",
        "فكّر في صفحة واحدة — إعادة تسمية الأصناف قد تؤثر في المستهلكين",
        "إلزامي — كل القرارات في قاعدة شيفرة مالية تحتاج سجل ADR"
      ],
      "correct": 1,
      "explanation": "تتطلب مصفوفة وزن القرار سجل ADR فقط عندما يكون الأثر مرتفعًا أو قابلية التراجع منخفضة. وإعادة تسمية صنف مساعد محلي أثرها منخفض والتراجع عنها سهل جدًا، فيكون السجل عبئًا بلا فائدة."
    },
    {
      "text": "ما السبب الأساسي لرفض فريق دفتر أستاذ المدفوعات في ADR-0012 لقاعدة MongoDB 7؟",
      "options": [
        "لا يدعم MongoDB المعاملات متعددة المستندات كاملة الخصائص (ACID)",
        "أضافت المعاملات متعددة المستندات نحو 12 ms لكل كتابة في التجربة، وتشفير الحقول فيه يتم من جهة العميل، وهو مسار لم يعتمده فريق الأمان",
        "افتقر الفريق إلى خبرة تشغيل MongoDB",
        "لا يستطيع MongoDB التعامل مع 50 مليون معاملة سنويًا"
      ],
      "correct": 1,
      "explanation": "يذكر السجل سببين تقنيين: أضافت المعاملات متعددة المستندات نحو 12 ms لكل كتابة في تجربة الفريق، وتشفير الحقول في MongoDB يتم من جهة العميل (CSFLE)، وهو مسار لم يعتمده فريق الأمان. وكانت خبرة الفريق اعتبارًا ثانويًا لا السبب الأساسي للرفض. (يدعم MongoDB المعاملات متعددة المستندات كاملة الخصائص منذ الإصدار 4.0، لذا الخيار A خاطئ.)"
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "ممارسة ADR — تطبيق عملي",
  "difficulty": "advanced",
  "estimatedMinutes": 90,
  "tasks": [
    {
      "id": "task-01",
      "description": "هيّئ مجلد ADR في مستودع تجريبي باستخدام adr-tools. أنشئ ADR-0001 (تسجيل القرارات المعمارية) وADR-0002 لقرار مالي تختاره (مثل اختيار ناقل أحداث). استخدم قالب MADR كاملًا مع 3 خيارات مدروسة على الأقل، ومحركات القرار، والعواقب الإيجابية والسلبية."
    },
    {
      "id": "task-02",
      "description": "اكتب سير عمل GitHub Actions ‏(.github/workflows/adr-lint.yml) يتحقق عند pull_request من: (1) أن كل ملف .md جديد تحت docs/decisions/ يحتوي حقل **Status:**، و(2) أن سجلات SUPERSEDED فيها مرجع **Superseded by:**، و(3) أن أسماء الملفات تتبع النمط 0NNN-slug.md. يجب أن تفشل المهمة برمز خروج غير صفري عند وجود مخالفات."
    },
    {
      "id": "task-03",
      "description": "أنشئ وسم catalog-info.yaml في Backstage لمكوّن payment-service يشير إلى مجلد سجلاته. ثم أضف المكوّن EntityAdrContent إلى EntityPage تجريبية لتظهر السجلات كتبويب في واجهة Backstage. واكتب شرحًا موجزًا لما يفعله الحارس isAdrAvailable."
    },
    {
      "id": "task-04",
      "description": "أضف الوسم @AdrReference إلى ثلاثة أصناف Java في خدمة دفع تجريبية (مثل LedgerEntryRepository وIdempotencyFilter وFraudCheckRouter). نفّذ AdrReferenceValidator من القسم 11 كـ ApplicationRunner، واربطه بـ Spring Boot، واكتب اختبار وحدة يتحقق من أن المتحقق يرمي IllegalStateException عندما يكون ملف ADR مفقودًا من مسار المستندات المضبوط."
    }
  ]
} -->
