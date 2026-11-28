---
id: track-12-lesson-05
title: "إدارة الدَّين التقني — تحديد الأولويات والسداد"
slug: technical-debt
track: track-12
trackName: "القيادة الهندسية على مستوى Staff وPrincipal"
sequence: 5
difficulty: principal
estimatedMinutes: 75
status: published
tags: [technical-debt, prioritisation, paydown, cruft, refactoring]
prerequisites: [track-12-lesson-04]
---

# إدارة الدين التقني — ترتيب الأولويات والسداد

> [!NOTE]
> للدين التقني في الخدمات المالية خاصية فريدة: بعضه غير قابل للتفاوض حرفيًا. فدين الامتثال (تشفير قديم، وسجلات تدقيق مفقودة، واحتفاظ بالبيانات غير ممتثل) ليس سؤال أولويات — بل التزام قانوني. وفهم أي دين اختياري وأيه إلزامي يغيّر طريقة نقاشك مع فريق المنتج.

## تصنيف الدين: مربع الدين التقني

صاغ Ward Cunningham استعارة "الدين التقني" عام 1992. ثم صنّف مربع الدين التقني لـ Martin Fowler ‏(2009) الدين على بُعدين مستقلين:

**متهور مقابل حكيم**: هل كنت تعرف أنك تأخذ دينًا؟
- متهور: "ليس لدينا وقت لفعل هذا بشكل صحيح" (مختار دون وعي بالعواقب)
- حكيم: "يجب أن نطلق الآن؛ ونعرف المخاطر؛ وسنصلحه في الربع الثالث"

**متعمد مقابل غير مقصود**: هل قررت أخذ الدين؟
- متعمد: مقايضة واعية لكسب السرعة
- غير مقصود: "لم نكن نعرف كيف يبدو الجيد حينها" (تعلمناه أثناء البناء)

| | متهور | حكيم |
|-|---------|---------|
| **متعمد** | "ليس لدينا وقت للتصميم" | "يجب أن نطلق الآن؛ ونعيد الهيكلة لاحقًا" |
| **غير مقصود** | "لم نكن نعرف أننا نخطئ" | "الآن نعرف كيف كان يجب أن نفعلها" |

**إطار المهندس الرئيسي**: المربع الحكيم هو حيث يجري معظم تفاوضك مع فريق المنتج. أما المربع المتهور فهو حيث تحتاج إلى تغيير طريقة عمل فريقك، لا مجرد ترتيب أولويات سداد الدين.

---

## جرد الدين التقني وتقييمه

لا تستطيع ترتيب أولويات ما لم تجرده. فابنِ سجلًا للدين.

### صيغة سجل الدين

```markdown
# Technical Debt Register — Payments Platform

| ID | Description | Category | Impact | Frequency | Risk | Score | Owner | Ticket |
|----|-------------|----------|--------|-----------|------|-------|-------|--------|
| TD-001 | Settlement service uses synchronous DB polling instead of events | Architecture | 4 (causes daily incidents) | 5 (every peak period) | 3 (latency, not data loss) | 60 | @engineer-a | PAY-100 |
| TD-002 | Payment history page runs one query per payment (N+1 problem) | Performance | 3 (p99 impact) | 4 (every history page load) | 2 | 24 | @engineer-b | PAY-101 |
| TD-003 | No idempotency keys on payment submission API | Reliability | 5 (double charges possible) | 2 (rare but catastrophic) | 5 (financial loss, reg breach) | 50 | @engineer-c | PAY-102 |
| TD-004 | Card API still accepts TLS 1.0/1.1 | Security | 5 (non-compliant) | N/A (compliance) | 5 (PCI DSS Req 4.2.1) | MANDATORY | @engineer-d | PAY-103 |
| TD-005 | Test coverage: fraud module 23% | Quality | 2 (slow to change safely) | 3 (every fraud service sprint) | 2 | 12 | @engineer-e | PAY-104 |
```

### معادلة التقييم

```
Score = Impact × Frequency × Risk

Impact (1-5): Effect on customers, engineers, or business when this bites us
  1 = Minor inconvenience
  3 = Meaningful customer impact or significant developer friction
  5 = Financial loss, regulatory breach, or service outage

Frequency (1-5): How often does this debt cause problems?
  1 = Rarely / only in specific edge cases
  3 = Multiple times per month
  5 = Daily / every peak period

Risk (1-5): What happens if we don't fix it?
  1 = Technical annoyance
  3 = Reliability degradation
  5 = Financial loss, security breach, or compliance violation

MANDATORY: Compliance debt that cannot be scored — it must be fixed regardless
```

هذا التقييم اتجاهي، لا دقيق. وقيمته في جعل نقاشات الأولويات ملموسة بدل الاعتماد على الحدس.

---

## التفاوض مع فريق المنتج على وقت للدين التقني

التحدي الأساسي: يحسّن مديرو المنتجات تسليم الميزات. وسداد الدين التقني ليس له فائدة فورية يراها العميل. فتحتاج إلى صياغة تقليل الدين بمصطلحات يستجيب لها فريق المنتج.

### الإطار 1: الاعتمادية بمصطلحات أثرها على العملاء

```
WRONG: "We need to fix the settlement polling architecture because it's technically suboptimal."

RIGHT: "Settlement service caused 847 failed payments last month during peak periods.
        Each failed payment requires customer support contact (avg 12 minutes × £0.50/min = £6/contact).
        Last month's cost: £5,082 in support costs, plus customer churn risk.
        Fixing TD-001 eliminates this failure mode entirely. 3-week engineering investment."
```

### الإطار 2: إبطاء السرعة بمصطلحات كلفة التسليم

```
WRONG: "Our test coverage is 23% — we need to invest in tests."

RIGHT: "Every change to the fraud module takes 2 days of manual testing because automated coverage
        is too low to trust. We made 12 fraud module changes last quarter = 24 days of manual testing.
        That's 24 engineering-days we cannot spend on features.
        Increasing coverage to 80%: 4-week investment; payback in 2 quarters."
```

### الإطار 3: دين الامتثال كأمر غير قابل للتفاوض

```
"TD-004 (TLS 1.0/1.1 still enabled) is not a prioritisation question — it is a PCI DSS requirement.
 If we do not remediate it before our next QSA assessment (March 2027), we will fail
 our PCI audit. Failure means we cannot process card payments legally.
 This must be in Q1 planning regardless of feature roadmap."
```

### نموذج تخصيص 20%

نهج عملي: تفاوض على تخصيص دائم (20% من السعة الهندسية، أو سباق من كل خمسة) للدين التقني. فهذا يتجنب معركة التفاوض الفصلية.

حجج لصالح هذا النهج:
- قابل للتنبؤ: يستطيع فريق المنتج تخطيط خارطة الميزات حول سعة تسليم 80%
- منع التراكم: يُسدد الدين باستمرار بدل تركه يتضاعف
- معنويات الفريق: يعرف المهندسون أن هناك وقتًا مخصصًا لعمل الجودة، فتقل دوامة "الدين التقني يسبب الاحتراق الوظيفي"

---

## أطر ترتيب الأولويات

### الإطار 1: الأولوية المعدّلة بالمخاطر

رتّب سجل الدين حسب الدرجة (تنازليًا). وعالج البنود الإلزامية أولًا بغض النظر عن الدرجة.

للبنود المقيّمة:
- الدرجة >= 50: عالجها في الربع الحالي
- الدرجة 25-49: عالجها في الربع التالي
- الدرجة < 25: قائمة الانتظار؛ وأعد تقييمها فصليًا
- أي بند بأثر = 5 أو مخاطرة = 5 يُراجع للربع الحالي بغض النظر عن الدرجة

### الإطار 2: قاعدة الكشافة

"اترك المخيم أنظف مما وجدته". كل طلب سحب يمس مكوّنًا يحسّنه قليلًا. ولا حاجة إلى سباق مخصص للدين — فالتحسين مستمر.

```
Implementation:
  - Define "cleaner": add one test, remove one TODO, add one doc comment, fix one deprecation warning
  - Track improvement: test coverage percentage, TODO count, cyclomatic complexity
  - Code review gate: PR that makes existing metrics worse requires explicit justification

This works for: low-scoring debt (score < 25) that would never get a dedicated sprint
This does not work for: architectural debt requiring dedicated refactoring effort
```

### الإطار 3: التفرع بالتجريد (Branch by Abstraction)

لإعادات الهيكلة الكبيرة (مثل الترحيل من التسوية المتزامنة إلى المدفوعة بالأحداث)، تكون إعادات الهيكلة "دفعة واحدة" محفوفة بالمخاطر وصعبة المراجعة. ويتيح التفرع بالتجريد ترحيلًا تدريجيًا:

```java
// Step 1: Extract an interface (the abstraction)
public interface SettlementService {
    CompletableFuture<SettlementResult> settle(Payment payment);
}

// Step 2: Old implementation — unchanged behaviour
@Service
public class SynchronousSettlementService implements SettlementService {
    @Override
    public CompletableFuture<SettlementResult> settle(Payment payment) {
        // Old synchronous implementation
    }
}

// Step 3: New implementation, built and deployed alongside the old one
@Service
public class EventDrivenSettlementService implements SettlementService {
    @Override
    public CompletableFuture<SettlementResult> settle(Payment payment) {
        // New event-driven implementation
    }
}

// Step 4: A router is what callers get injected. The feature flag is checked
// per payment at RUNTIME (stable per payment ID), which enables a percentage
// rollout and instant rollback. (@ConditionalOnProperty could not do this:
// it switches the whole application at start-up.)
@Primary
@Service
public class RoutingSettlementService implements SettlementService {

    private final SynchronousSettlementService legacy;
    private final EventDrivenSettlementService eventDriven;
    private final FeatureFlags flags;   // e.g. Unleash, LaunchDarkly, OpenFeature

    // ... constructor

    @Override
    public CompletableFuture<SettlementResult> settle(Payment payment) {
        return flags.isEnabled("event-driven-settlement", payment.getId())
            ? eventDriven.settle(payment)
            : legacy.settle(payment);
    }
}

// Step 5: Gradually increase the flag percentage (1% → 10% → 50% → 100%),
//         comparing error rates and latency of both paths
// Step 6: Delete the old implementation and the router once confident
// Step 7: Remove the interface too if it is no longer needed
```

---

## متابعة تقليل الدين

لا تستطيع تحسين ما لا تقيسه. وتابع هذه المقاييس فصليًا:

```
DORA Metrics (proxy for technical health):
  Deployment Frequency: how often can you deploy safely?
  Change Failure Rate: what % of deployments cause incidents?
  MTTR: how long to recover from incidents?

Codebase Health Metrics:
  Test coverage (% of lines/branches covered)
  Mean cyclomatic complexity per method
  Number of TODO/FIXME/HACK comments
  Number of open severity-high bugs
  Number of unresolved Semgrep/OWASP findings

Business Impact Metrics:
  Failed payment rate attributable to known technical issues
  Customer support tickets caused by known bugs
  Engineering hours spent on incidents vs features (incident-to-feature ratio)
```

---

## الدين التقني في التقنية المالية المنظمة

يستحق بُعد الامتثال في الدين التقني معاملة خاصة. فعلى خلاف الدين التقني الذي يبطئ التطوير، قد يؤدي دين الامتثال إلى:

- الإخفاق في تقييم PCI DSS ‏(العجز عن معالجة مدفوعات البطاقات)
- إطلاق إجراء إنفاذ من FCA ‏(غرامات، ومتطلبات معالجة)
- إنشاء مسؤولية شخصية على المديرين وكبار المسؤولين (نظام كبار المديرين في المملكة المتحدة SM&CR)
- التسبب في عقوبات تنظيمية لخرق البيانات (GDPR: حتى 4% من إجمالي الإيرادات السنوية العالمية)

### فئات دين الامتثال

```
NEVER DEFER:
  - Encryption below the minimum requirement (PCI DSS Req 3.5.1 for stored PAN, 4.2.1 in transit)
  - Missing audit logs for cardholder data operations
  - Unpatched critical CVEs in systems touching card data
  - Data retained beyond the mandated retention period

DEFER WITHIN DEFINED WINDOW:
  - New compliance requirements with implementation periods (e.g. DORA had a
    two-year implementation period before it applied from January 2025)
  - Regulatory guidance updates (usually 6-12 months to implement)
  - Penetration test findings, per your policy SLAs (e.g. Critical = 24h,
    High = 7 days — PCI DSS requires them to be fixed and retested)

TRACK AND REPORT:
  - Medium-severity compliance findings: document, assign owner, 30-day SLA
  - Maintain a compliance debt register separate from technical debt register
  - Report compliance debt register to CISO and CTO quarterly
```

---

## الخلاصات الأساسية

- استخدم مربع الدين التقني لـ Fowler لتصنيف الدين: الدين المتعمد المتهور يشير إلى مشكلة في ثقافة الفريق؛ والدين المتعمد الحكيم طبيعي وقابل للإدارة
- قيّم الدين بالأثر × التكرار × المخاطرة لإجراء نقاشات أولويات موضوعية مع فريق المنتج — فالحدس ليس مقنعًا في اجتماعات التخطيط
- صِغ تقليل الدين بمصطلحات المنتج: الأثر على العملاء، وكلفة الدعم، وإبطاء سرعة التسليم — لا النقاء التقني
- دين الامتثال ليس اختياريًا: معايير التشفير، وسجلات التدقيق، والتصحيحات التنظيمية لها جداول زمنية إلزامية لا يمكن معاملتها كبنود عادية في قائمة الانتظار
- التخصيص الدائم بنسبة 20% يلغي معركة التفاوض الفصلية ويمنع تراكم الدين
- التفرع بالتجريد هو الطريق الآمن لإعادات الهيكلة الكبيرة: أدخل تجريدًا، وابنِ التنفيذ الجديد خلف مفتاح ميزة، ورحّل تدريجيًا، واحذف الكود القديم

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يكتشف فريق خدمة دفع أن واجهة البطاقات لديه ما زالت تقبل TLS 1.0 و1.1، اللذين لا يعتبرهما PCI DSS تشفيرًا قويًا. ما نوع الدين التقني هذا؟",
      "options": [
        "دين متعمد حكيم — مقايضة معروفة من أجل السرعة",
        "دين غير مقصود متهور — لم يكن الفريق يعرف أنه يخطئ",
        "دين امتثال — يجب إصلاحه بغض النظر عن أولويات المنتج",
        "دين منخفض الدرجة — يمكن تأجيله إلى الربع التالي"
      ],
      "correct": 2,
      "explanation": "تشفير النقل دون الحد الأدنى لـ PCI DSS ‏(المتطلب 4.2.1) دين امتثال — له جدول معالجة إلزامي مرتبط بالتزامات قانونية وتعاقدية. ويُصنف كإلزامي في سجل الدين ولا يمكن معاملته كبند عادي في قائمة الانتظار خاضع لأولويات المنتج. والإخفاق في معالجته قد يسبب الإخفاق في تقييم PCI DSS وفقدان القدرة على معالجة مدفوعات البطاقات."
    },
    {
      "text": "يحسب فريق درجة الدين باستخدام الأثر × التكرار × المخاطرة. ويحصل البند TD-003 (لا مفاتيح عدم تكرار) على: الأثر=5 (خصم مزدوج)، والتكرار=2 (نادر)، والمخاطرة=5. ما الدرجة وما الأولوية التي يستحقها؟",
      "options": [
        "الدرجة=12، أولوية منخفضة (قائمة الانتظار)",
        "الدرجة=50، المعالجة في الربع التالي",
        "الدرجة=50، المعالجة في الربع الحالي",
        "الدرجة=25، المعالجة في الربع التالي"
      ],
      "correct": 2,
      "explanation": "الدرجة = 5 × 2 × 5 = 50. ويضع الإطار الدرجات 50 فأكثر في 'المعالجة في الربع الحالي' (و25–49 للربع التالي). وفوق ذلك، الأثر = 5 والمخاطرة = 5 (خصم مزدوج، وخسارة مالية، وخرق تنظيمي) سيطلقان مراجعة للربع الحالي حتى لو كانت الدرجة أقل."
    },
    {
      "text": "لماذا يُفضّل 'التفرع بالتجريد' على إعادة هيكلة 'دفعة واحدة' للترحيل من التسوية المتزامنة إلى المدفوعة بالأحداث؟",
      "options": [
        "تتطلب إعادات الهيكلة دفعة واحدة موافقات مراجعة كود أكثر",
        "يتيح التفرع بالتجريد ترحيلًا تدريجيًا خلف مفتاح ميزة، فيمكّن الإطلاق التدريجي، والتراجع السريع، والنشر المستمر في الإنتاج",
        "لا يمكن اختبار إعادات الهيكلة دفعة واحدة في بيئات التجهيز",
        "يولّد التفرع بالتجريد فروقات git أقل لكل طلب سحب"
      ],
      "correct": 1,
      "explanation": "إعادات الهيكلة دفعة واحدة محفوفة بالمخاطر (نشر كل شيء أو لا شيء)، وصعبة المراجعة (طلب سحب ضخم)، وصعب التراجع عنها. أما التفرع بالتجريد فيُدخل واجهة، ويبني التنفيذين، ويرحّل الحركة تدريجيًا عبر مفتاح ميزة. وكل خطوة قابلة للنشر والاختبار والتراجع بشكل مستقل. وهذا يقلل نطاق ضرر أخطاء الترحيل بشكل كبير."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "سجل الدين التقني واستراتيجية السداد لمنصة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "ابنِ سجل دين تقني لخدمة دفع بـ 8 بنود على الأقل تغطي فئات البنية، والأمان، والأداء، والاعتمادية، والامتثال. وقيّم كل بند باستخدام الأثر × التكرار × المخاطرة (1-5 لكل منها)، ووسم بنود الامتثال كإلزامية، ورتّب حسب الدرجة. ويجب أن يكون بندان على الأقل دين امتثال إلزاميًا."
    },
    {
      "id": "2",
      "description": "اكتب ثلاثة مبررات موجهة لفريق المنتج لأعلى 3 بنود دين درجةً. ويجب أن يتضمن كل مبرر: أثرًا محددًا على العملاء (لا وصفًا تقنيًا)، وكلفة محسوبة (ساعات الدعم × المعدل، أو المدفوعات الفاشلة × القيمة، أو الأيام الهندسية المفقودة)، وحساب العائد على الاستثمار لاستثمار المعالجة."
    },
    {
      "id": "3",
      "description": "نفّذ خطة ترحيل بالتفرع بالتجريد لاستبدال خدمة استطلاع حالة الدفع المتزامنة بخدمة مدفوعة بالأحداث: عرّف الواجهة، وأنشئ التنفيذين، وأضف موجّهًا يختار التنفيذ لكل طلب عبر مفتاح ميزة وقت التشغيل (إطلاق بالنسبة المئوية)، واكتب مقياس Prometheus يتابع نسبة الحركة التي تستخدم التنفيذ الجديد."
    },
    {
      "id": "4",
      "description": "صمّم لوحة متابعة للدين باستخدام ثلاثة من مقاييس DORA (تكرار النشر، ومعدل إخفاق التغيير، ومتوسط وقت الاستعادة) وثلاثة مقاييس لصحة قاعدة الكود (نسبة تغطية الاختبارات، وعدد TODO، والتعقيد الدوري). وحدد عتبات تنبيه لكل مقياس تشير إلى أن سجل الدين يحتاج إعادة ترتيب أولويات فورية."
    }
  ]
}
-->
