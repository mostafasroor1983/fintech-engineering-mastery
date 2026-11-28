---
id: track-12-lesson-10
title: "رادار التقنيات — التقييم والتجربة والاعتماد والتعليق"
slug: technology-radar
track: track-12
trackName: "القيادة الهندسية على مستوى Staff وPrincipal"
sequence: 10
difficulty: principal
estimatedMinutes: 70
status: published
tags: [technology-radar, ThoughtWorks, assess, adopt, hold]
prerequisites: [track-12-lesson-09]
---

# رادار التقنيات — قيّم، جرّب، اعتمد، أوقف

> [!NOTE]
> دون رادار للتقنيات، يتخذ كل فريق قرارات التقنية بمفرده، فينتج التشتت: 12 فريقًا يستخدمون 8 عملاء HTTP مختلفين، و4 أطر اختبار مختلفة، و3 نُهج مختلفة لإدارة الأسرار. والرادار أداة المهندس الرئيسي لخلق التماسك دون التماثل.

## نموذج رادار التقنيات من ThoughtWorks

تنشر ThoughtWorks رادار التقنيات مرتين سنويًا. والنموذج يستحق الاعتماد في مؤسستك:

**أربعة أرباع** (أي نوع من التقنية):
- **التقنيات (Techniques)**: ممارسات التطوير والعمليات (مثل مفاتيح الميزات، ومصادر الأحداث، وهندسة الفوضى)
- **الأدوات (Tools)**: أدوات البرمجيات والمرافق (مثل Semgrep، وGrafana، وOpenTelemetry)
- **المنصات (Platforms)**: بنية التشغيل التحتية (مثل Kubernetes، وKafka، وAWS EKS)
- **اللغات والأطر (Languages & Frameworks)**: لغات البرمجة والأطر (مثل Java 25، وSpring Boot، وResilience4j)

**أربع حلقات** (ما يجب أن تفعله مؤسستك بها):
- **اعتمد (Adopt)**: الافتراضي في الصناعة؛ استخدمها. المعيار لسياقك.
- **جرّب (Trial)**: تستحق الاستخدام في مشاريع يستطيع فيها الفريق تحمل عدم اليقين الإضافي.
- **قيّم (Assess)**: تستحق التحقيق؛ تابعها؛ ولا تلتزم بعد.
- **أوقف (Hold)**: غير موصى بها للاستخدام الجديد؛ ويجب أن يرحّل الاستخدام الحالي بعيدًا عنها.

---

## إدارة رادار للفريق/المؤسسة

رادار ThoughtWorks رأيهم. ورادار مؤسستك رأيك، المبني على سياقك المحدد، وقيود الامتثال، والقدرات الهندسية.

### العملية: إيقاع نصف سنوي للرادار

```
MONTH 1 (Collection):
  Announcement: "We're updating the technology radar. Submit nominations."
  Open period (2 weeks):
    Engineers nominate items via form or Confluence page
    Each nomination includes:
      - Technology name and category
      - Proposed ring (Assess/Trial/Adopt/Hold)
      - Brief rationale (why this ring?)
      - Your team's experience with it (if any)

MONTH 2 (Review Session):
  Duration: 3 hours (block it properly)
  Participants: Principal engineers, senior architects, security lead
  Process:
    Group nominations by quadrant
    For each nomination: 5-10 minutes discussion
    Voting: simple majority for ring placement (PE/architects vote)
    Document rationale for each placement

MONTH 3 (Publication and Communication):
  Publish radar (interactive, not just a document)
  Present at engineering all-hands: highlights, changes from last radar
  Team leads: review radar with their teams; identify gaps vs current practices
```

### نصائح للتيسير

**ابدأ بالسهلة**: هناك عادة اتفاق واسع على البنود الواضحة (Kubernetes: اعتمد؛ ZooKeeper: أوقف). وابنِ الزخم بهذه قبل الخلافية.

**ميّز "التقنية الجيدة" عن "الجيدة لنا"**: قد يكون React Native تقنية ممتازة. لكن إن كان فريق الهاتف لديك مهندسين اثنين بلا خبرة في React Native، فهو في "قيّم"، لا "اعتمد".

**طبّق عدسة الامتثال صراحة**: في الخدمات المالية، التقنية التي لا تدعم متطلبات سجلات التدقيق لديك أو لا تستطيع العمل في بيئة PCI لديك قد تكون في "أوقف" بغض النظر عن الجدارة التقنية.

---

## معايير التقييم للتقنية المالية

معايير تقييم خاصة بالتقنية المالية تعدّل نموذج ThoughtWorks القياسي:

### الملاءمة للامتثال

هل يمكن استخدام هذه التقنية في بيئة PCI DSS؟ هل تدعم متطلبات إقامة البيانات في نطاقك التنظيمي (يجب أن تبقى بيانات الاتحاد الأوروبي في الاتحاد الأوروبي)؟

```
COMPLIANCE EVALUATION QUESTIONS:
  Does this technology handle, store, or transmit payment card data?
    YES → PCI DSS scope; must meet PCI DSS requirements
    NO  → Standard evaluation

  Does it process personal data of EU/UK residents?
    YES → GDPR/UK GDPR considerations; data residency requirements
    NO  → Standard evaluation

  Does it require internet access from production systems?
    YES → WAF/egress filtering requirements; security review required
    NO  → Standard evaluation
```

### الوضع الأمني

ما تاريخ الثغرات لهذه التقنية؟ هل تُصان بنشاط؟ هل لديها برنامج إفصاح مسؤول؟

```
LOG4SHELL (CVE-2021-44228) LESSON:
  Log4j was widely used and trusted. The vulnerability was catastrophic.
  
  Evaluation questions:
  - What is the CVSS history for this library over the last 2 years?
  - How quickly are critical CVEs patched? (Days? Weeks?)
  - Is there an active security advisory program?
  - Does the library parse or process external data? (Higher attack surface)
```

### النضج التشغيلي

هل لدى فريقك القدرة على تشغيل هذه التقنية؟ فالأداة المتفوقة تقنيًا التي لا يستطيع فريقك تشغيلها بموثوقية أسوأ من أداة جيدة بما يكفي يعرفها جيدًا.

---

## أمثلة على مُدخلات رادار التقنيات في التقنية المالية

```
TECHNIQUES
─────────────────────────────────────────────────────────────
ADOPT:
  SLO-Based Alerting (burn rate alerting)
    Why: Industry standard; aligns alerting with business impact;
         eliminates alert fatigue better than threshold-based alerting
    Ref: Google SRE Workbook; our implementation in track-11-lesson-07

  Feature Flags for Deployment Risk Reduction
    Why: Enables incremental rollout; decouples deploy from release;
         critical for payment systems where bad deploys are costly
    Ref: LaunchDarkly or homegrown; pattern is well-established

  Zero-Trust Service Identity (SPIFFE/SPIRE)
    Why: PCI DSS Requirement 8.6 (service accounts); prevents lateral movement;
         eliminates shared credentials between services

  Virtual Threads (Java 21+)
    Why: Significantly improves throughput for I/O-bound services without
         reactive programming model complexity
    Note: Java 24+ removed the main pitfall (pinning inside synchronized
          blocks, JEP 491); on Java 21, watch for pinning in older libraries

TRIAL:
  Event Sourcing for Ledger Services
    Why: Natural fit for accounting (immutable audit trail);
         emerging pattern in fintech; complexity is real
    Risk: Eventual consistency model requires careful design;
          CQRS adds complexity; team training required

ASSESS:
  eBPF-Based Observability (Cilium, Hubble)
    Why: Zero-instrumentation observability; Kubernetes-native network visibility
    Risk: Requires a recent Linux kernel; operational complexity; evolving tooling
    Wait for: More operational maturity; better documentation

  Rust for Payment-Critical Services
    Why: Memory safety without GC pauses; attractive for latency-sensitive payment processing
    Risk: Team expertise (we have 1 Rust engineer); ecosystem maturity vs Java

HOLD:
  Reactive Programming (WebFlux/Reactor) for new services
    Why: Complexity exceeds benefit for most payment services;
         Virtual Threads (Java 21+) achieve similar throughput benefits
         with far simpler programming model
    Existing services: continue operating; don't migrate unless actively causing problems
    New services: use Virtual Threads + standard Spring MVC instead

  Apache ZooKeeper for new use cases
    Why: Kafka 4.0 removed ZooKeeper support entirely (KRaft only);
         etcd better for other coordination use cases;
         operational complexity without commensurate benefit
    Existing use: migrate Kafka clusters to KRaft (on 3.9) before upgrading to 4.x

PLATFORMS
─────────────────────────────────────────────────────────────
ADOPT:
  Apache Kafka for Event Streaming
    PCI note: Topic-level ACLs required; audit logging enabled;
              no PAN in event payloads without field-level encryption
    Status: Our standard event backbone; use for all new event-driven services

  HashiCorp Vault for Secrets Management
    Status: Our standard; mandatory for all production services
    Required: Dynamic credentials for database access; transit encryption for PAN

  Kubernetes (EKS/GKE) for Container Orchestration
    Status: Our standard compute platform

HOLD:
  AWS Lambda for Payment Processing
    Why: Cold start latency hard to reconcile with payment SLO (< 500ms p99)
         even with SnapStart; limited local testing story; cold starts affect
         reliability metrics
    Acceptable for: Non-payment workloads (batch reporting, notifications)
    Not for: Payment authorisation, real-time fraud scoring, settlement

LANGUAGES & FRAMEWORKS
─────────────────────────────────────────────────────────────
ADOPT:
  Java 25 LTS (Java 21 LTS still acceptable)
    Why: Current LTS release; Virtual Threads without synchronized pinning
    Migration: Java 17 services should migrate by end of 2027

  Spring Boot 4.x
    Why: Current generation (Spring Framework 7, Jakarta EE 11); JSpecify
         null-safety; open-source support for Spring Boot 3.5 ended mid-2026
    Note: Spring Boot 3.x services plan their upgrade; 2.x is on Hold

  Resilience4j 2.x for circuit breaking
    Why: Replaces Hystrix (EOL); integrates with Spring Boot; Micrometer metrics

HOLD:
  Hystrix (Netflix)
    Why: EOL since 2018; no security patches; migrate to Resilience4j
    Migration required by: End of Q1 2027

  Spring Boot 2.x
    Why: Open-source support ended November 2023; no free security patches
    Migration required by: Immediate for all PCI-scoped services
```

---

## نشر الرادار وإيصاله

الرادار المنشور الذي لا يُرجع إليه أبدًا جهد مهدر.

**الصيغة التفاعلية**: تنشر ThoughtWorks رادارها كعرض مرئي تفاعلي. واستخدم أداة "Build Your Own Radar" من Thoughtworks أو `zalando/tech-radar` مفتوح المصدر لإنشاء المثل لمؤسستك.

**تعريفات حلقات قابلة للربط**: يجب أن يرتبط كل مُدخل في رادارك بتوثيقك الداخلي: لماذا هذه الحلقة، وما البدائل المدروسة، واعتبارات الامتثال.

**التكامل مع ضم الموظفين الجدد**: يقرأ المهندسون الجدد الرادار كجزء من الضم. فيخبرهم الرادار "هذا ما نستخدمه ولماذا" — سياق لا يقدّر بثمن.

**المراجعة في المراجعات المعمارية**: حين تقترح خدمة جديدة تقنية، يكون السؤال الأول: "هل هي على الرادار؟ في أي حلقة؟" والتقنيات في "أوقف" أو غير الموجودة على الرادار تتطلب مبررًا صريحًا.

---

## قرارات الإيقاف وإنهاء التقنيات القديمة

حلقة "أوقف" قابلة للتنفيذ — فهي تعني "رحّل بعيدًا عن هذا". لكن الترحيل يتطلب خطة.

```markdown
# Sunsetting Plan: Spring Boot 2.x → Spring Boot 4.x

BACKGROUND: Spring Boot 2.x open-source support ended November 2023.
No free security patches available. PCI DSS Requirement 6.3.3 mandates patching.

SCOPE:
  Services on Spring Boot 2.x: 14 services (audit: October 2026)
  PCI-scoped services: 6 services (MUST migrate; compliance risk)
  Non-PCI services: 8 services (SHOULD migrate; technical debt risk)

APPROACH:
  NOT a big-bang migration. Each team migrates their own services.
  Spring provides migration guides. Services step through 3.5 (javax → jakarta,
  Spring Security 6) and then to 4.x. Breaking changes are documented.

TIMELINE:
  Q1 2027: All PCI-scoped services migrated (mandatory; compliance)
  Q2 2027: 50% of non-PCI services migrated
  Q3 2027: All services migrated; Spring Boot 2.x fully removed from inventory

SUPPORT:
  Platform team runs 2 workshops on common migration issues
  ADR published: common patterns for migrating from Spring Boot 2 to 3 to 4
  Principal engineer available for 30-minute consulting sessions

SUCCESS CRITERIA:
  Zero Spring Boot 2.x services in production by end of Q3 2027
  Measured by: monthly service inventory audit
```

---

## الخلاصات الأساسية

- يخلق رادار التقنيات التماسك دون التماثل: تعرف الفرق ما تستخدمه افتراضيًا (اعتمد)، وما تستكشفه بحذر (جرّب/قيّم)، وما تتجنبه (أوقف)
- أدر الرادار نصف سنويًا؛ واجمع الترشيحات على نطاق واسع لكن اتخذ قرارات التصنيف مع مجموعة صغيرة من المهندسين الرئيسيين والمعماريين
- تضيف التقنية المالية الامتثال والوضع الأمني كمعايير تقييم صريحة: التقنية التي لا تستطيع تلبية متطلبات PCI DSS في "أوقف" بغض النظر عن الجدارة التقنية
- قرارات الإيقاف قابلة للتنفيذ، لا استشارية فقط — ويحتاج كل بند في "أوقف" خطة ترحيل بجدول زمني، ومالك، ومعايير نجاح
- انشر الرادار بصيغة تفاعلية وارجع إليه في المراجعات المعمارية، وضم الموظفين، ونقاشات التصميم — فالرادار الذي لا يقرؤه أحد توثيق مكلف
- الخيوط الافتراضية (Java 21+) في "اعتمد" والبرمجة التفاعلية في "أوقف" موقف يمكن الدفاع عنه للتقنية المالية: نموذج برمجة أبسط يحقق إنتاجية مماثلة لخدمات الدفع المعتمدة على الإدخال/الإخراج

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "رُشحت قاعدة بيانات NoSQL جديدة بخصائص توسع أفقي قوية ومراجعات ممتازة من المطورين لرادار التقنيات. وهي لا تدعم قيود إقامة البيانات — فكل البيانات موزعة عالميًا عبر مناطق السحابة. أين مكانها في رادار فريق تقنية مالية؟",
      "options": ["اعتمد — فوائد التوسع تفوق مخاوف الامتثال لمعظم الخدمات", "جرّب — اختبرها على أحمال عمل غير حساسة أولًا", "أوقف — التقنية التي لا تستطيع تلبية متطلبات إقامة البيانات للخدمات المنظمة في الاتحاد الأوروبي/المملكة المتحدة غير مناسبة بغض النظر عن الجدارة التقنية", "قيّم — قد تُحل مشكلة الامتثال في إصدارات مستقبلية"],
      "correct": 2,
      "explanation": "لفرق التقنية المالية العاملة في نطاقات منظمة، إقامة البيانات قيد امتثال، لا تفضيل. ويتطلب GDPR وPCI DSS إمكانية حصر البيانات الشخصية وبيانات حاملي البطاقات في نطاقات محددة. والتقنية التي لا تستطيع تلبية هذا المتطلب يجب وضعها في 'أوقف' بغض النظر عن جدارتها التقنية. والملاءمة للامتثال معيار تقييم صريح يمكن أن يتغلب على التقييم التقني."
    },
    {
      "text": "يقترح فريق استخدام Spring WebFlux ‏(البرمجة التفاعلية) لخدمة تفويض دفع جديدة. ويضع رادار التقنيات في المؤسسة البرمجة التفاعلية في 'أوقف' للخدمات الجديدة. ما الاستجابة الصحيحة للمهندس الرئيسي؟",
      "options": ["الموافقة على الاختيار — فالفريق يعرف خدمته أفضل", "السماح به كتجربة — فقد يكون تصنيف 'أوقف' قديمًا", "اشتراط مبرر صريح للانحراف عن تصنيف 'أوقف' في الرادار؛ ويجب أن يُثبت الفريق لماذا البدائل القياسية (الخيوط الافتراضية + Spring MVC) غير كافية لمتطلباته المحددة", "التصعيد إلى مجلس المراجعة المعمارية فورًا دون التفاعل مع الفريق"],
      "correct": 2,
      "explanation": "يخلق رادار التقنيات التماسك، لا التماثل. وتستطيع الفرق الانحراف عن تصنيفات الرادار لكن يجب أن تقدم مبررًا صريحًا. ولبند في 'أوقف'، يجب أن يُثبت الفريق أن البديل القياسي غير كافٍ لحالته المحددة. واشتراط المبرر يمنع انجراف الرادار (التآكل التدريجي للمعايير دون قرارات متعمدة) مع السماح بالاستثناءات المشروعة. وقد تكون عملية مجلس المراجعة المعمارية مناسبة لمراجعة انحراف كامل."
    },
    {
      "text": "ما الغرض من حلقة 'أوقف' في رادار التقنيات، وما الذي يجب أن يرافق التصنيف في 'أوقف'؟",
      "options": ["'أوقف' تعني أن التقنية محظورة؛ ويجب على الفرق إزالتها فورًا", "'أوقف' تعني أن التقنية غير موصى بها للاستخدام الجديد؛ ويجب أن يرحّل الاستخدام الحالي بعيدًا عنها؛ ويتطلب كل بند في 'أوقف' خطة ترحيل بجدول زمني، ومالك، ومعايير نجاح", "'أوقف' استشارية فقط؛ والفرق حرة في الاستمرار باستخدام تقنيات 'أوقف' إلى أجل غير مسمى", "'أوقف' تنطبق على التبعيات الخارجية لا المنصات الداخلية"],
      "correct": 1,
      "explanation": "'أوقف' قابلة للتنفيذ، لا استشارية فقط. فهي تعني 'لا تبدأ استخدامًا جديدًا؛ ورحّل بعيدًا عن الاستخدام الحالي'. لكن الترحيل يتطلب خطة — فدونها، تتراكم بنود 'أوقف' إلى أجل غير مسمى دون تقدم. ولكل بند في 'أوقف' في رادار ناضج خطة إنهاء: أي الخدمات متأثرة، ونهج الترحيل (لا دفعة واحدة)، وجدول زمني بمحطات، ومعايير نجاح (مثل صفر خدمات Spring Boot 2.x بحلول الربع الثالث 2027)."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء رادار التقنيات وإيصاله لمؤسسة هندسية في التقنية المالية",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "ابنِ رادار تقنيات لمنصة دفع في التقنية المالية بـ 16 مُدخلًا على الأقل عبر الأرباع الأربعة (التقنيات، والأدوات، والمنصات، واللغات والأطر) والحلقات الأربع (اعتمد، وجرّب، وقيّم، وأوقف). ويجب أن يتضمن كل مُدخل: تصنيف الحلقة، ومبررًا من جملة واحدة، وملاحظة خاصة بالتقنية المالية (الملاءمة للامتثال، أو الوضع الأمني، أو اعتبار النضج التشغيلي). وضمّن مُدخلين على الأقل في 'أوقف' مع متطلبات الترحيل."},
    {"id": "2", "description": "صمّم عملية التحديث نصف السنوية للرادار لمؤسسة هندسية في التقنية المالية من 200 مهندس. وحدد: صيغة الترشيح (ما المعلومات التي يجب أن يقدمها المهندسون)، وجدول أعمال جلسة المراجعة ونهج التيسير للوصول إلى توافق على البنود الخلافية، وآلية التصويت، وخطة التواصل (كيف يُنشر الرادار، ويُعرض، ويُدمج في ضم الفرق والمراجعات المعمارية)."},
    {"id": "3", "description": "اكتب خطة إنهاء كاملة لترحيل 18 خدمة من Java 17 إلى Java 21 LTS. ويجب أن تتضمن الخطة: تقسيم النطاق (ضمن نطاق PCI مقابل خارجه)، ونهج الترحيل، وجدولًا زمنيًا محددًا بمحطات فصلية، وآليات الدعم (ورش عمل، وساعات استشارة، وتغييرات كاسرة موثقة)، ومبرر الامتثال (لماذا يصبح Java 17 خطرًا مع اقترابه من نهاية الدعم)، ومعايير نجاح تُقاس بتدقيق شهري لجرد الخدمات."},
    {"id": "4", "description": "قيّم ثلاثة ترشيحات تقنية افتراضية باستخدام إطار التقييم للتقنية المالية: ‏(أ) أداة مراقبة قائمة على eBPF تتطلب نواة Linux ‏5.4+ دون توثيق PCI DSS، (ب) مكتبة معالجة دفع مكتوبة بـ Rust ببرنامج تنبيهات أمنية نشط ومشرفين اثنين، (ج) مورد SaaS لإدارة الأسرار بشهادة SOC 2 Type 2 وإقامة بيانات في الاتحاد الأوروبي لكنه يتطلب خروجًا إلى الإنترنت من أنظمة الإنتاج. ولكل منها، أنتج توصية بتصنيف الرادار مع تقييم كامل للامتثال والأمان."}
  ]
}
-->
