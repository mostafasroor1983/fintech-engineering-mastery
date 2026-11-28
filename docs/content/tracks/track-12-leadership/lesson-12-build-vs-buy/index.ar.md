---
id: track-12-lesson-12
title: "البناء أم الشراء أم المصدر المفتوح — قرار المهندس الرئيسي"
slug: build-vs-buy
track: track-12
trackName: "القيادة الهندسية على مستوى Staff وPrincipal"
sequence: 12
difficulty: principal
estimatedMinutes: 70
status: published
tags: [build-vs-buy, open-source, make-or-buy, vendor, total-cost]
prerequisites: [track-12-lesson-11]
---

# البناء مقابل الشراء مقابل المصدر المفتوح — قرار المهندس الرئيسي

> [!NOTE]
> قرار البناء مقابل الشراء من أكثر القرارات التي يتخذها المهندس الرئيسي أثرًا. فابنِ الشيء الخطأ وستقضي سنوات في صيانته بدل إطلاق الميزات. واشترِ الشيء الخطأ وستعلق في الارتهان لمورد، أو مشكلات امتثال، أو فجوة قدرات لن يسدها المورد أبدًا. والإطار في هذا الدرس لا يعطيك الإجابة — بل يعطيك الأسئلة التي تطرحها.

## القرار الثلاثي

معظم صياغات هذا القرار ثنائية (ابنِ أو اشترِ). وعمليًا، هناك ثلاثة خيارات، لكل منها ملف مقايضات مميز:

**البناء**: يصمم الفريق الهندسي الحل ويطوره ويصونه.
- أقصى تحكم وتخصيص
- شفافية كاملة (تملك الكود، والبيانات)
- أعلى استثمار أولي؛ وعبء صيانة مستمر
- ميزة تنافسية إن كان مميِّزًا حقًا

**الشراء (تجاري)**: شراء منتج برمجي تجاري أو SaaS.
- أسرع وقت للقيمة
- تبعية للمورد (التسعير، وخارطة الطريق، والاستمرارية)
- اعتبارات الامتثال وإقامة البيانات
- عقد الدعم يوفر مسار تصعيد

**المصدر المفتوح**: اعتماد حل مفتوح المصدر واستضافته ذاتيًا.
- لا كلفة ترخيص؛ ووصول كامل إلى المصدر
- لا دعم تجاري (المجتمع فقط، إلا إن اشتُريت نسخة مؤسسية)
- مسؤولية التصحيحات الأمنية تقع عليك
- قد يتطلب استثمارًا هندسيًا كبيرًا للتشغيل على نطاق واسع

---

## تحليل الكلفة الإجمالية للملكية

أكثر الأخطاء شيوعًا في قرارات البناء مقابل الشراء هو مقارنة كلفة ترخيص المورد بالكلفة الهندسية وحدها. ويتضمن تحليل الكلفة الإجمالية للملكية (TCO):

### مكونات الكلفة الإجمالية للملكية

```
BUILD TCO:
  Initial development cost
    × senior engineer cost × months to build × overhead factor (1.3-1.5x for recruiting, management, benefits)
  
  Ongoing maintenance
    × engineers required to maintain × months per year
    (rule of thumb: 20-30% of initial development cost per year)
  
  Opportunity cost
    What else could those engineers be building?
    Revenue impact of not building that instead?
  
  Infrastructure cost
    Compute, storage, networking, monitoring for self-hosted solution

BUY TCO:
  Licensing cost
    Annual fee (SaaS) or one-time license + annual maintenance
  
  Integration cost
    Engineering time to integrate with your systems (typically 2-6 weeks)
  
  Customisation cost
    Professional services, custom development to meet your requirements
  
  Operations cost
    Internal staff required to manage the vendor relationship
  
  Migration/exit cost
    Effort to migrate away if vendor fails, raises prices, or changes direction
    (Typically 3-12 months of engineering effort for a deeply integrated vendor)
  
  Compliance cost
    Vendor security review, annual penetration test of vendor, contract negotiation

OPEN SOURCE TCO:
  Integration cost (similar to Buy)
  
  Engineering cost to operate
    Platform team effort to run, monitor, upgrade (Kafka, for example, needs an operator)
  
  Engineering cost to customise
    If the open-source solution needs modification for your requirements
  
  Security patching responsibility
    You own patching; CVE response time depends on your process
  
  No commercial support
    P1 incident at 2am: open-source community forum vs vendor support line
```

---

## التمييز بين الجوهر والسياق

تمييز Geoffrey Moore بين "الجوهر والسياق" (core vs context) أكثر النماذج الذهنية فائدة للبناء مقابل الشراء:

**الجوهر**: الأنشطة التي تميز أعمالك عن المنافسين. ما تفعله شركتك ولا يستطيع المنافسون تكراره بسهولة.

**السياق**: كل ما عدا ذلك — أنشطة ضرورية لا تميزك.

**المبدأ**: ابنِ جوهرك. واشترِ السياق (أو استخدم المصدر المفتوح له).

### تطبيق الجوهر مقابل السياق على التقنية المالية

| القدرة | جوهر أم سياق؟ | القرار |
|-----------|-----------------|---------|
| قواعد تقييم الاحتيال | جوهر — نموذج الاحتيال لديك ميزة تنافسية | ابنِ |
| بوابة الدفع (استحواذ البطاقات) | سياق — سلعة؛ يحلها Stripe/Adyen | اشترِ |
| التحقق من الهوية لـ KYC/AML | سياق — لكنه منظم بشدة؛ ويلزم التخصيص | اشترِ + خصّص |
| دفتر أستاذ القيد المزدوج | جوهر — منطق دفتر الأستاذ يعكس قواعد منتجك | ابنِ |
| إشعارات البريد/الرسائل النصية | سياق — سلعة | اشترِ (Twilio، وAWS SES) |
| منصة قابلية المراقبة | سياق — المراقبة ليست عملك | اشترِ (Datadog) أو مصدر مفتوح (Prometheus) |
| إدارة مفاتيح التشفير | سياق — لكنها حرجة أمنيًا | مصدر مفتوح + HSM ‏(Vault + Thales) |
| نموذج تقييم مخاطر الائتمان | جوهر — يميز منتج الإقراض لديك | ابنِ |
| التكامل مع بيانات مكاتب الائتمان | سياق | اشترِ (التكامل مع Experian، وEquifax) |

---

## معايير تقييم الموردين للخدمات المالية

عند الشراء، قيّم الموردين مقابل هذه المعايير إضافة إلى الملاءمة الوظيفية:

### الأمان والامتثال

```
SECURITY EVALUATION CHECKLIST:
  [ ] SOC 2 Type 2 report available and current (< 12 months)
  [ ] ISO 27001 certification or equivalent
  [ ] Annual penetration test results available under NDA
  [ ] Responsible disclosure/bug bounty program
  [ ] CVE response time for critical vulnerabilities (target: < 48 hours)
  [ ] Data encryption: AES-256 at rest, TLS 1.2+ in transit (1.3 preferred)
  [ ] Data residency: Can data be restricted to your required jurisdiction (EU, UK)?

PCI DSS SPECIFIC:
  [ ] Is vendor in-scope for your PCI DSS environment?
  [ ] If yes: QSA-reviewed SAQ or ROC available?
  [ ] If processing card data: PCI DSS Level 1 service provider?

GDPR/UK GDPR:
  [ ] Data Processing Agreement (DPA) available
  [ ] Sub-processors disclosed
  [ ] Data subject request handling procedure
  [ ] Standard Contractual Clauses for data transfers outside EEA
```

### اتفاقية مستوى الخدمة والدعم

```
QUESTIONS FOR VENDOR:
  What is the uptime SLA? (Target: 99.9% for critical payment systems)
  What is the support model for P1 incidents? (24/7 phone? Email only?)
  What is the contractual SLA for P1 response time?
  What compensation if SLA is breached? (Service credits? Actual damages?)
  What is the vendor's incident notification obligation to customers?
```

### استراتيجية الخروج

```
BEFORE SIGNING:
  Can you export your data in a standard format? In what timeframe?
  What happens to your data if the vendor is acquired or goes bankrupt?
  What are the contractual lock-in terms? (Minimum commitment, auto-renewal)
  What is the realistic migration effort if you need to leave?
  Have you built data portability requirements into the contract?
```

---

## تقييم مخاطر المصدر المفتوح

المصدر المفتوح ليس مجانيًا — بل هيكل تكاليف مختلف.

### مؤشرات المصدر المفتوح عالي المخاطر

**مشرف واحد**: إن كان شخص واحد يصون المشروع واختفى، يتعثر المشروع. وافحص: كم عدد المساهمين؟ كم عدد الإصدارات الأخيرة؟ كم عدد طلبات السحب المفتوحة؟

**استجابة بطيئة للثغرات**: افحص تاريخ الثغرات (قاعدة بيانات NVD). كم بسرعة صُححت الثغرات الحرجة؟ صُححت Log4Shell خلال أيام من فريق Log4j — نموذجي. وبعض المشاريع تستغرق أسابيع.

**الترخيص المقيّد**: افحص الترخيص بعناية. يتطلب AGPL نشر مصدر تعديلاتك إن تفاعل المستخدمون مع البرنامج عبر الشبكة؛ ويقيّد SSPL وBusiness Source License تقديم البرنامج كخدمة أو استخدامه في الإنتاج دون ترخيص تجاري. وApache 2.0 وMIT متساهلان. ويمكن أن تتغير التراخيص أيضًا بين الإصدارات (انتقلت Elasticsearch، وRedis، وTerraform، وCockroachDB كلها بعيدًا عن التراخيص المتساهلة).

**لا نسخة مؤسسية**: لمكونات البنية التحتية (قواعد البيانات، والطوابير)، توفر النسخ المؤسسية عقود دعم تجاري. ودونها، يكون مسار دعم P1 لديك مشكلة عامة في GitHub.

### عملية أمان المصدر المفتوح

```xml
<!-- Every open-source dependency must be tracked and scanned -->
<!-- pom.xml — OWASP Dependency Check integration -->
<plugin>
    <groupId>org.owasp</groupId>
    <artifactId>dependency-check-maven</artifactId>
    <configuration>
        <failBuildOnCVSS>7</failBuildOnCVSS>  <!-- Block builds with High/Critical CVEs -->
    </configuration>
</plugin>
```

```
OPEN SOURCE LIFECYCLE PROCESS:
  Adoption: Principal engineer approval required for new open-source dependencies
  Tracking: All dependencies in SBOM (Software Bill of Materials)
  Monitoring: Daily CVE scan via Snyk or OWASP Dependency Check
  Patching: Critical CVE < 48 hours, High CVE < 7 days (firm policy — PCI DSS 6.3.3
            sets the floor: critical/high patches within one month of release)
  Retirement: Deprecated or abandoned dependencies replaced within 90 days
```

---

## قرارات بناء مقابل شراء شائعة في التقنية المالية

**بوابة الدفع: اشترِ**
يتطلب بناء بوابة دفع بالبطاقات شهادة PCI DSS من المستوى 1 ‏(3-18 شهرًا)، وعلاقات استحواذ مباشرة مع Visa/Mastercard، وبنية تحتية كبيرة لإدارة الاحتيال. وهذا لا يستحق البناء تقريبًا أبدًا. والخيارات القياسية: Stripe، وAdyen، وBraintree، وCheckout.com.

**محرك قواعد الاحتيال: ابنِ الجوهر، واشترِ البيانات**
قواعد الاحتيال لديك ميزتك التنافسية — فهي تعكس قاعدة عملائك، وشهيتك للمخاطر، ومنتجك. فابنِ محرك القواعد. لكن إشارات البيانات (بصمة الأجهزة، وفحوص السرعة عبر الشبكات، والتحقق من الهوية) يمكن تعزيزها ببيانات الموردين (Featurespace، وThreatMetrix، وLexisNexis).

**‏KYC/AML: اشترِ مع التخصيص**
بناء خط KYC من الصفر — التحقق من الوثائق، واكتشاف الحيوية، وفحص الأشخاص السياسيين والعقوبات، والإعلام السلبي — مكلف ويتطلب خبرة عميقة في مجال منظم بشدة. فاشترِ منصة (Jumio، وOnfido، وTrulioo) لكن خصّص رحلة العميل وطبقة قرار المخاطر.

**دفتر أستاذ القيد المزدوج: ابنِ**
دفتر الأستاذ هو القلب المالي لمنتجك. ونموذج بياناته يعكس تراكيب منتجك المحددة (المحافظ، والحسابات، والحسابات الفرعية، والحجوزات). ونادرًا ما تناسب برامج دفاتر الأستاذ العامة جيدًا. فابنِ على PostgreSQL مع طبقة تطبيق خاصة بك. فالتعقيد التقني قابل للإدارة؛ والملاءمة للأعمال غير قابلة للتفاوض.

**قابلية المراقبة: مصدر مفتوح (Prometheus/Grafana) أو شراء (Datadog)**
كلاهما خيار مشروع حسب سعة SRE لدى فريقك ومتطلبات الامتثال (انظر دروس أطر القرار في المسارين 10 و11).

---

## سجل القرار: البناء مقابل الشراء

يجب توثيق كل قرار بناء مقابل شراء مهم كـ ADR:

```markdown
# ADR-025: KYC Platform — Buy (Onfido) with Custom Decisioning Layer

Status: Accepted
Date: 2026-09-15
Deciders: Principal Engineer, Head of Product (Identity), Head of Compliance

## Decision
Buy Onfido for document verification and liveness detection.
Build custom risk decisioning layer on top of Onfido's API.

## Rationale
Building document verification and liveness detection internally would require:
  - 6-12 months of ML engineering to match Onfido's accuracy
  - Ongoing maintenance of the ML model as fraud patterns evolve
  - Regulatory expertise to stay current with global KYC requirements
  
This is not core differentiation — Onfido solves it better than we would.

What is core differentiation: our risk decisioning logic (how we combine Onfido's
score with our own signals — transaction history, device, etc.). We build that.

## Total Cost Analysis (illustrative figures)
Build from scratch:
  6 engineers (4 ML + 2 backend) × 12 months × £150k fully-loaded = £900k
  + training data, labelling and ML infrastructure                  = £200k
  = £1.1M initial; then 2 engineers to maintain = £300k/year
Onfido: £180k/year + £60k integration + £40k/year internal operations
         = £280k year 1, £220k year 2+
5-year TCO Build: £1.1M initial + £300k × 4 maintenance = £2.3M
5-year TCO Buy:   £280k + £220k × 4 = £1.16M

Buy is cheaper AND higher quality AND faster. Clear decision.
```

---

## الخلاصات الأساسية

- ابنِ جوهرك (ما يميز أعمالك)، واشترِ أو استخدم المصدر المفتوح للسياق (كل ما عدا ذلك) — في التقنية المالية: ابنِ قواعد الاحتيال ومنطق دفتر الأستاذ؛ واشترِ بوابة الدفع والتحقق من وثائق KYC
- يجب أن يتضمن تحليل الكلفة الإجمالية للملكية: الترخيص، والتكامل، والتشغيل، وكلفة الفرصة، وكلفة الخروج — فكلفة الترخيص وحدها مضللة
- يتطلب تقييم الموردين للخدمات المالية: SOC 2 Type 2، وشهادة PCI DSS ‏(حيث ينطبق)، وضمانات إقامة البيانات، ودعم P1 على مدار الساعة، واستراتيجية خروج صريحة في العقد
- المصدر المفتوح ليس مجانيًا: مسؤولية تصحيح الثغرات، والخبرة التشغيلية، وغياب الدعم التجاري تكاليف حقيقية
- وثّق كل قرار بناء مقابل شراء مهم كـ ADR: فهذا يمنع إعادة فتح القرار ويوفر السياق للمهندسين المستقبليين الذين يرثون الاختيار
- ‏KYC/AML: اشترِ التحقق من الوثائق؛ وابنِ قرار المخاطر. بوابة الدفع: اشترِ دائمًا. دفتر الأستاذ: ابنِ. قابلية المراقبة: يعتمد على سعة SRE ومتطلبات الامتثال

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "شركة تقنية مالية ناشئة تقيّم ما إذا كانت ستبني بوابة دفع البطاقات الخاصة بها أو تستخدم Stripe. ويتطلب البناء شهادة PCI DSS من المستوى 1 وعلاقات مباشرة مع شبكات البطاقات. ماذا يقول إطار الجوهر مقابل السياق عن هذا القرار؟",
      "options": ["ابنِ — التحكم في معالجة المدفوعات تمايز تنافسي جوهري", "ابنِ — كلفة رسوم Stripe بمرور الوقت تتجاوز كلفة البناء", "اشترِ — معالجة بوابة دفع البطاقات سياق (سلعة)، لا جوهر؛ ويحلها Stripe/Adyen أفضل مما تستطيع شركة ناشئة بناءه في 12-18 شهرًا؛ ويجب أن يذهب جهد البناء إلى التمايز الجوهري الفعلي (قواعد الاحتيال، وتجربة المنتج)", "اشترِ — لكن فقط حتى تصل الشركة إلى 10 ملايين جنيه من حجم المدفوعات السنوي"],
      "correct": 2,
      "explanation": "معالجة بوابة دفع البطاقات سياق، لا جوهر. فبناء بوابة معتمدة من المستوى 1 في PCI DSS يتطلب 3-18 شهرًا، وعلاقات استحواذ مباشرة مع Visa/Mastercard، وبنية تحتية كبيرة لإدارة الاحتيال — ولا شيء من ذلك يميز منتج الشركة الناشئة. وتمايزها الجوهري هو نموذج الاحتيال، أو قرار المخاطر، أو تجربة المنتج. وقاعدة البناء مقابل الشراء: ابنِ جوهرك، واشترِ السياق. وبناء السياق بدل الجوهر يهدر السعة الهندسية على مشكلات سلعية."
    },
    {
      "text": "يقارن فريق بين بناء محرك قواعد احتيال داخلي (كلفة بناء 400 ألف جنيه، وصيانة 80 ألف سنويًا) مقابل شراء منصة احتيال SaaS ‏(ترخيص 120 ألف سنويًا). وبعد 3 سنوات، يكلف خيار الشراء 360 ألفًا مقابل 640 ألفًا للبناء. ويختار الفريق الشراء. هل هذا القرار الصحيح بناءً على إطار البناء مقابل الشراء؟",
      "options": ["نعم — الكلفة الإجمالية الأقل على 3 سنوات تفضّل الشراء بوضوح", "ليس بالضرورة — قواعد تقييم الاحتيال ميزة تنافسية جوهرية (تعكس قاعدة عملائك وشهيتك للمخاطر)؛ فإن لم تكن منصة SaaS قابلة للتخصيص لقواعدك المحددة، فشراء حل احتيال سلعي يتنازل عن الميزة التنافسية حتى لو كان أرخص", "نعم — كلفة الفرصة للبناء (مهندسون لا يعملون على الميزات) تفضّل الشراء دائمًا", "لا — يجب دائمًا تقييم أدوات الاحتيال مفتوحة المصدر قبل SaaS التجاري"],
      "correct": 1,
      "explanation": "الكلفة الإجمالية بُعد واحد؛ والجوهر مقابل السياق بُعد آخر. فقواعد الاحتيال تعكس قاعدة عملائك المحددة، وشهية منتجك للمخاطر، وأنماط الاحتيال — وهذا تمايز تنافسي جوهري. ومنصة احتيال SaaS العامة تطبق القواعد نفسها على كل العملاء. فإن لم يكن تخصيص SaaS كافيًا، فشراؤها يتنازل عن الميزة التنافسية. والنموذج الموصى به: اشترِ إشارات البيانات (بصمة الأجهزة، وفحوص السرعة عبر الشبكات) لكن ابنِ محرك القرار الذي يعكس نموذج مخاطرك المحدد."
    },
    {
      "text": "يقيّم فريق مكتبة طوابير رسائل مفتوحة المصدر. صدر آخر إصدار لها قبل 18 شهرًا، ولها مشرف رئيسي واحد، وكان فيها ثغرتان حرجتان في العام الماضي (صُححتا كلتاهما خلال 3 أسابيع). ما فئة المخاطر التي يمثلها هذا؟",
      "options": ["مخاطر منخفضة — صُححت الثغرات بسرعة، ما يُظهر استجابة أمنية جيدة", "مخاطر متوسطة إلى عالية — المشرف الواحد خطر 'عامل الحافلة' (يتعثر المشروع إن اختفى المشرف)؛ لكن سرعة تصحيح الثغرات إشارة إيجابية تستحق الذكر في التقييم", "مخاطر منخفضة — 18 شهرًا دون إصدار تشير إلى الاستقرار", "مخاطر عالية — أي ثغرات في العام الماضي تستبعد المكتبة من الاستخدام في الخدمات المالية"],
      "correct": 1,
      "explanation": "يأخذ تقييم مخاطر المصدر المفتوح أبعادًا متعددة في الاعتبار في آن واحد. فالمشرف الواحد خطر 'عامل الحافلة' كبير — إن اختفى المشرف، يتعثر المشروع وتبقى الثغرات الأمنية دون تصحيح. وهذا وحده يدفع تقييم المخاطر نحو 'أوقف' لمكونات البنية التحتية. لكن التصحيح السريع للثغرات (خلال أسابيع، لا أشهر) إشارة إيجابية عن الثقافة الأمنية. والتقييم الصحيح مخاطر متوسطة إلى عالية: وثّق قلق المشرف الواحد صراحة في ADR وفكّر في وجود نسخة مؤسسية بدعم تجاري."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "إطار قرار البناء مقابل الشراء لمنصة تقنية مالية",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "أجرِ تحليلًا كاملًا للكلفة الإجمالية للملكية لقرار بناء مقابل شراء لمنصة KYC/AML داخلية. سيناريو البناء: 4 مهندسين أوائل × 9 أشهر × 150 ألف جنيه كلفة سنوية كاملة + 25% صيانة مستمرة. سيناريو الشراء: Onfido بترخيص 200 ألف جنيه سنويًا + 80 ألفًا كلفة تكامل + 50 ألفًا سنويًا للتشغيل الداخلي. وضمّن كلفة الفرصة (يستطيع مهندسو البناء بناء ميزة احتيال جوهرية بأثر إيرادات مقدّر بـ 500 ألف جنيه). واحسب الكلفة الإجمالية لـ 3 و5 سنوات للخيارين، وحدد كل مكونات الكلفة، وأنتج توصية مع المبرر."
    },
    {
      "id": "2",
      "description": "طبّق إطار الجوهر مقابل السياق على منصة تقنية مالية تدرس 8 قدرات: (1) نموذج تقييم مخاطر الائتمان، (2) تسليم الإشعارات بالرسائل النصية/البريد، (3) دفتر أستاذ محاسبي بالقيد المزدوج، (4) استحواذ مدفوعات البطاقات، (5) التحقق من وثائق الهوية، (6) محرك قواعد احتيال المدفوعات، (7) قابلية المراقبة والرصد، (8) إدارة مفاتيح التشفير. ولكل منها، صنّف كجوهر أو سياق، وأوصِ بالبناء/الشراء/المصدر المفتوح، وقدّم مبررًا من جملة واحدة خاصًا بالتقنية المالية."
    },
    {
      "id": "3",
      "description": "أكمل تقييمًا أمنيًا لمورد منصة SaaS افتراضية لتنسيق المدفوعات. وباستخدام قائمة تحقق الموردين للتقنية المالية من الدرس، صمّم استبيانًا أمنيًا (15 سؤالًا على الأقل) يغطي: شهادتي SOC 2 وPCI DSS، واتفاقية مستوى الخدمة للاستجابة للثغرات، وإقامة البيانات لعملاء الاتحاد الأوروبي، ونموذج دعم حوادث P1، واتفاقية معالجة البيانات بموجب GDPR، وقابلية نقل البيانات عند الخروج. ولكل سؤال، حدد كيف تبدو الإجابة الناجحة مقابل الفاشلة وما عاقبة الإخفاق (حظر المورد، أو اشتراط تخفيف، أو تدوين المخاطرة)."
    },
    {
      "id": "4",
      "description": "اكتب ADR كاملًا لقرار بناء مقابل شراء لدفتر أستاذ محاسبي بالقيد المزدوج. ويجب أن يقيّم ADR ثلاثة خيارات: (1) البناء على PostgreSQL بطبقة تطبيق مخصصة، (2) شراء منصة دفتر أستاذ تجارية (مثل Modern Treasury Ledgers أو Formance Cloud)، (3) اعتماد قاعدة بيانات دفتر أستاذ مفتوحة المصدر (مثل TigerBeetle أو دفتر Formance مفتوح المصدر). وضمّن: دوافع القرار الخاصة بمتطلبات دفتر الأستاذ لمنتج الدفع لديك، وتحليل الكلفة الإجمالية لكل خيار، وتقييم الامتثال (نطاق PCI DSS، ومتطلبات سجل التدقيق)، والقرار النهائي مع مبرر صريح والاعتراف بالعواقب السلبية."
    }
  ]
}
-->
