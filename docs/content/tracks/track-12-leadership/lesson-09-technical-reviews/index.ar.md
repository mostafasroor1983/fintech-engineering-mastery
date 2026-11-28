---
id: track-12-lesson-09
title: "المراجعات التقنية — مراجعة الشيفرة والتصميم والبنية"
slug: technical-reviews
track: track-12
trackName: "القيادة الهندسية على مستوى Staff وPrincipal"
sequence: 9
difficulty: principal
estimatedMinutes: 70
status: published
tags: [code-review, design-review, architecture-review, feedback, standards]
prerequisites: [track-12-lesson-08]
---

# المراجعات التقنية — مراجعات الكود والتصميم والبنية

> [!NOTE]
> لمراجعة المهندس الرئيسي وزن غير متناسب. فالمهندسون ينظرون إلى تعليقاتك ليفهموا كيف يبدو الجيد. وحين تُعلّم شيئًا، تنتبه الفرق. وحين توافق على شيء بتحفظات، تتذكر الفرق ذلك أيضًا. وجودة مراجعاتك تشكّل المعايير التقنية لمؤسستك أكثر من أي وثيقة تستطيع كتابتها.

## دور المهندس الرئيسي في المراجعات

هناك طيف من أنماط المشاركة في المراجعة. فاعرف أي نمط مناسب:

**مراجعة الكود القياسية**: أنت أحد عدة مراجعين؛ تلتقط الأخطاء، ومشكلات الأسلوب، والتحسينات الواضحة. ورأيك استشاري.

**مراجعة خبير المجال**: أنت أكثر شخص معرفة بهذا المكوّن أو النمط. ومراجعتك موثوقة لذلك المجال.

**مراجعة المعايير**: تراجع للامتثال للمعايير المؤسسية (الأمان، والامتثال، والأنماط المعمارية). وهذه بوابة — فلا يمكن دمج طلب السحب دون معالجة مخاوفك.

**تصعيد المشكلات النظامية**: تلاحظ نمطًا عبر طلبات سحب متعددة يشير إلى مشكلة أعمق. فتصعّده بشكل منفصل عن طلب السحب الفردي.

---

## إرشادات مراجعة الكود

### ما يجب تعليمه (حاجب)

**الصحة**: أخطاء المنطق، وحالات السباق، وفحوص null المفقودة في الحسابات المالية، وأخطاء الفرق بواحد في حسابات المبالغ.

**الأمان**: حقن SQL، والمصادقة المفقودة، والبيانات الحساسة في السجلات، والأسرار المكتوبة في الكود، والتشفير غير الآمن. وعلّم هذه كحاجبة، في كل مرة، حتى لو كان المؤلف مهندسًا أول. فالمشكلات الأمنية لا تحصل على تمرير بناءً على الأقدمية.

**الامتثال**: سجلات التدقيق المفقودة في عمليات الدفع، والاحتفاظ بالبيانات غير الممتثل، والتعامل مع PAN بما يخالف PCI DSS.

**الاعتمادية**: معالجة الأخطاء المفقودة لإخفاقات الخدمات الخارجية، والحلقات غير المحدودة، والذاكرات المؤقتة غير المحدودة، وقواطع الدائرة المفقودة على المسارات الحرجة للدفع.

### ما يجب تعليمه (غير حاجب)

**الأداء**: مشكلات أداء محتملة لا تسبب مشكلات حاليًا. "فكّر في التحميل الكسول هنا — إن نما سجل المعاملات قد يصبح هذا بطيئًا". وعلّمه بـ "nit" أو "consider" للإشارة إلى أنه غير حاجب.

**قابلية القراءة**: تسمية يمكن أن تكون أوضح، وتوثيق مفقود لكود غير واضح. وهذه تحسينات، لا مشكلات صحة.

**الأسلوب**: الانحرافات عن اصطلاحات الفريق. وإن كان لدى فريقك أداة فحص (linter)، يجب أتمتة هذه وعدم ظهورها في مراجعتك إطلاقًا.

### ما يجب تركه

**تفضيلات الأسلوب الشخصية**: إن كان الكود صحيحًا، وآمنًا، وقابلًا للقراءة، فتفضيلك لنهج صالح على آخر ليس سببًا لطلب تغييرات. واحتفظ برصيد مراجعتك للأشياء المهمة.

**إعادة الكتابة من الصفر**: قاوم الرغبة في اقتراح تنفيذ مختلف كليًا حين يكون الحالي صحيحًا. فللمؤلف سياق قد لا تملكه. واقترح تحسينات على الموجود.

```java
// GOOD code review comment:
// BLOCKING — Security: This query concatenates user input directly into SQL.
// Use a parameterised query to prevent SQL injection.
// See ADR-003 and our secure coding guidelines in docs/security/sql-injection.md.
//
// Before:
// String sql = "SELECT * FROM transactions WHERE status = '" + status + "'";
//
// After:
// String sql = "SELECT * FROM transactions WHERE status = ?";
// return jdbcTemplate.query(sql, transactionRowMapper, status);

// GOOD code review comment (non-blocking):
// Consider: If this cache grows large (>10k entries) it could cause GC pressure.
// Caffeine with maximumSize(10_000) would bound it.
// Not urgent, but worth tracking in our tech debt register.
// Not blocking — your call.

// BAD code review comment (personal preference, not actionable):
// I would have implemented this differently using the Strategy pattern.
// (Not specific, not blocking-worthy, adds friction without clear benefit)
```

---

## هيكل مراجعة التصميم

تحدث مراجعات التصميم قبل بدء عمل التنفيذ المهم. وغرضها إظهار المشكلات حين تكون التغييرات ما زالت رخيصة — قبل كتابة الكود.

### قائمة تحقق مراجعة التصميم

```
CORRECTNESS
  [ ] Does the design solve the stated problem?
  [ ] Are edge cases handled? (network failures, partial failures, timeouts)
  [ ] Is the data model consistent with business requirements?
  [ ] Are idempotency and retry semantics defined for payment operations?

SECURITY (required for financial services)
  [ ] Is authentication required for all endpoints? What type?
  [ ] Is authorisation at the right granularity? (can a customer access only their own data?)
  [ ] What sensitive data is handled? How is it encrypted at rest and in transit?
  [ ] What are the trust boundaries? What is validated at each boundary?
  [ ] Has the design been reviewed against OWASP Top 10 for financial APIs?

COMPLIANCE
  [ ] Does this design handle PAN or other cardholder data? PCI DSS scope?
  [ ] Does it process personal data? GDPR implications?
  [ ] Are audit logs generated for all payment-relevant operations?
  [ ] Does the design respect the mandated data retention periods?

OPERABILITY
  [ ] What observability does this design produce? Metrics, logs, traces?
  [ ] How is the system monitored? What are the alerting thresholds?
  [ ] What are the failure modes? Is there a runbook for each?
  [ ] How is the service deployed? What is the rollback procedure?
  [ ] How does it degrade gracefully under load?

SCALABILITY
  [ ] What is the peak throughput this must support? Has it been tested?
  [ ] Where are the bottlenecks? Database? External services? CPU?
  [ ] What happens at 2x expected load? 10x?

REGULATORY CHANGE (financial services addition)
  [ ] Does this change require regulatory approval or notification?
  [ ] Does it introduce new data processing activities requiring a DPIA?
```

### إدارة اجتماع مراجعة التصميم

```
Pre-work (required):
  Design document distributed 2 days before meeting
  Reviewers expected to have read it; first 10 minutes not for introductions

Meeting structure (60 minutes):
  0-5 min:  Author states the problem being solved (not the solution)
            "We're trying to solve X. Here are the constraints."

  5-15 min: Clarifying questions only
            "I want to understand Y before I form an opinion about the design."

  15-45 min: Review by checklist section
             Security first (most critical for fintech)
             Then: correctness, operability, scalability

  45-55 min: Open issues and owners
             "Three open issues identified. Owner and deadline for each."

  55-60 min: Decision
             Approved | Approved with conditions | Revise and resubmit
```

---

## مجلس المراجعة المعمارية

للقرارات التي تؤثر على فرق متعددة أو المنصة كاملة، يوفر مجلس المراجعة المعمارية (ARB) حوكمة مؤسسية.

### تكوين المجلس

```
Voting members:
  Principal Engineers (usually 2-3)
  Security Lead
  Head of Infrastructure/Platform

Advisory (non-voting):
  Engineering Managers (business context)
  Compliance Officer (regulatory input)
  
Decisions require:
  Quorum: at least 3 voting members
  Consensus or decision by Principal Engineer + Security Lead
```

### ما الذي يذهب إلى المجلس

**دائمًا**: مخازن بيانات جديدة (تقنية قاعدة بيانات أو ذاكرة مؤقتة جديدة)، وتبعيات خدمات خارجية جديدة، وتغييرات مهمة في نموذج المصادقة/التفويض، وأي تصميم يعالج PAN أو بيانات شخصية بطريقة جديدة.

**عند الشك**: إن كان القرار يؤثر على النموذج التشغيلي لأكثر من فريق أو يُدخل تقنية جديدة إلى المنصة.

### سجل قرار المجلس

```markdown
# ARB-012: Use of Redis for Rate Limiting

Date: 2026-10-15
Attendees: 3 Principal Engineers, Security Lead, Head of Platform

Decision: APPROVED

Conditions:
  1. Redis cluster must be in a dedicated namespace with NetworkPolicy isolation
  2. Redis access credentials via Vault dynamic secrets (not static config)
  3. PAN or sensitive customer data must NOT be stored in Redis
     (rate limiting counters only — no customer data)
  4. Documented behaviour when Redis is unavailable (fail open or fail closed per
     endpoint); Redis health is monitored and alerted, but NOT part of the
     payment-service readiness probe (a Redis outage would otherwise take every
     payment pod out of service)
  
Review required if:
  - Redis is used to store data beyond rate limiting counters
  - Redis cluster is shared with other non-payment services
```

---

## تقديم ملاحظات بنّاءة على تصاميم الآخرين

مراجعة المهندس الرئيسي لتصميم أنتجه فريق آخر أمر حساس. فأنت أقدم، ولرأيك وزن، وقد تُثبط دون قصد مشاركة التصاميم مستقبلًا.

**اطرح الأسئلة أولًا، وقدّم الاستنتاجات ثانيًا**:

```
Instead of: "This design has a race condition in the concurrent update path."

Try: "Walk me through what happens when two requests update the same account balance
simultaneously. What is the expected outcome? What actually happens with this implementation?"

Letting the author discover the issue through your questions is more educational
and less demoralising than being told the conclusion.
```

**اعترف بما ينجح قبل تحديد ما يحتاج تحسينًا**:

```
"The fraud score caching approach is well-designed—the TTL and invalidation strategy
are both correct. The area I want to explore is the concurrent update handling.
Can we walk through the scenario where..."
```

**افصل "يجب أن تغيّر هذا" عن "قد ترغب في التفكير في هذا"**:

```
// In written review:
// MUST CHANGE: [blocking items — correctness, security, compliance]
// CONSIDER: [non-blocking improvements — performance, readability, future-proofing]
// QUESTION: [things you don't understand yet — not necessarily problems]
```

---

## مسارات التصعيد للمشكلات النظامية

مراجعة التصميم أو مراجعة الكود ليست المكان المناسب لإصلاح المشكلات النظامية. فإن لاحظت النمط نفسه عبر ثلاثة طلبات سحب من ثلاثة فرق مختلفة، فلديك مشكلة نظامية:

```
Systemic issue detected: 3 PRs this month with SQL injection vulnerabilities

Do:
  - Approve (or request changes on) each PR on its own merits
  - Write a postmortem / "systemic issue" document: 3 cases, root cause, impact
  - Propose the fix: add Semgrep SQL injection rule to CI pipeline
  - Write an RFC if the fix requires cross-team coordination
  - Present at the next engineering all-hands: "here's a pattern we need to eliminate"

Don't:
  - Reject all three PRs without explanation, citing systemic concern
  - Have the same conversation three separate times with three separate teams
  - Assume the problem will fix itself
```

---

## الخلاصات الأساسية

- اعرف في أي نمط مراجعة أنت: مراجع قياسي (استشاري)، أو خبير مجال (موثوق)، أو مراجع معايير (بوابة) — ويتطلب كل منها مشاركة مختلفة
- علّم دائمًا مشكلات الأمان والامتثال كحاجبة، بغض النظر عن أقدمية المؤلف — فهذه معايير مؤسسية، لا تفضيلات شخصية
- اطرح الأسئلة قبل ذكر الاستنتاجات في مراجعات التصميم: ترك المؤلفين يكتشفون المشكلات عبر الأسئلة أكثر تعليمًا وأقل إحباطًا من إصدار الأحكام
- استخدم قائمة تحقق منظمة لمراجعة التصميم في التقنية المالية: الصحة، والأمان، والامتثال، وقابلية التشغيل، وقابلية التوسع — بهذا الترتيب
- افصل الملاحظات الحاجبة (الصحة، والأمان، والامتثال) عن الاقتراحات غير الحاجبة (الأداء، وقابلية القراءة) صراحة في المراجعات المكتوبة
- المشكلات النظامية المرصودة في المراجعات تتطلب مقترحًا منفصلًا (RFC، أو قاعدة Semgrep، أو تحديث إرشادات) — فمراجعة طلب السحب الفردي ليست المكان المناسب لإصلاح الأنماط المؤسسية

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يراجع مهندس رئيسي طلب سحب من مهندس Staff ويلاحظ ثغرة حقن SQL. والمهندس كبير جدًا ويحظى بتقدير كبير. كيف يجب أن يتعامل المهندس الرئيسي مع هذا؟",
      "options": ["يمرره بتعليق غير حاجب لتجنب الإضرار بالعلاقة", "يثيره كمشكلة حاجبة — فالمشكلات الأمنية لا تُمرر أبدًا بغض النظر عن أقدمية المؤلف، لأنها معايير مؤسسية لا تفضيلات شخصية", "يذكره شفهيًا في لقاء فردي لتجنب الإحراج العلني", "يعلّمه كغير حاجب لأن مهندس Staff يعرفه على الأرجح"],
      "correct": 1,
      "explanation": "مشكلات الأمان والامتثال حاجبة دائمًا، بغض النظر عن أقدمية المؤلف. فهذه معايير مؤسسية — لا تفضيلات شخصية — ويجب فرضها باتساق. وتطبيقها بشكل غير متسق بناءً على الأقدمية يقوّض المعيار ويخلق انطباعًا بأن الأمان اختياري للمهندسين الكبار. ومصداقية المهندس الرئيسي كحارس للمعايير تعتمد على الفرض المتسق."
    },
    {
      "text": "أثناء مراجعة تصميم، يشتبه مهندس رئيسي في حالة سباق في مسار التحديث المتزامن لرصيد الحساب. ما الطريقة المفضلة لإظهار هذا في الاجتماع؟",
      "options": ["الذكر المباشر: 'في هذا التصميم حالة سباق في مسار التحديث المتزامن'", "تخطيه ومعالجته بشكل منفصل بعد الاجتماع لتجنب إخراج المراجعة عن مسارها", "طرح سؤال: 'امشِ بي عبر ما يحدث حين يحدّث طلبان رصيد الحساب نفسه في آن واحد — ما النتيجة المتوقعة؟' وترك المؤلف يكتشف المشكلة", "رفض التصميم فورًا وطلب إعادة تقديمه"],
      "correct": 2,
      "explanation": "الأسئلة أكثر تعليمًا وأقل إحباطًا من الاستنتاجات. فحين يكتشف المؤلف مشكلة عبر أسئلة المراجع، يملك هو الفكرة ويكون أكثر ميلًا لإصلاحها بشكل صحيح. وذكر الاستنتاج مباشرة — خاصة حين يكون المراجع أقدم — قد يكون محبطًا ويثبط مشاركة التصاميم مستقبلًا. والهدف تحسين التصميم وتطوير المهندس، لا مجرد إيجاد المشكلات."
    },
    {
      "text": "يلاحظ مهندس رئيسي نمط حقن SQL نفسه عبر ثلاثة طلبات سحب من ثلاثة فرق مختلفة هذا الشهر. ما الاستجابة الصحيحة؟",
      "options": ["رفض طلبات السحب الثلاثة بحجة القلق النظامي والانتظار حتى تُحل المشكلة على مستوى المؤسسة", "مراجعة كل طلب سحب منفردًا حسب جدارته، ثم كتابة وثيقة مشكلة نظامية منفصلة تقترح قاعدة Semgrep تلتقط هذا النمط في CI لكل الفرق", "الموافقة على طلبات السحب الثلاثة لتجنب حجب التسليم ومعالجة النمط بشكل منفصل", "إجراء نقاش حقن SQL نفسه ثلاث مرات مع ثلاثة فرق منفصلة عبر تعليقات فردية على طلبات السحب"],
      "correct": 1,
      "explanation": "مراجعة طلب السحب الفردي ليست المكان المناسب لإصلاح المشكلات النظامية. فيجب مراجعة كل طلب سحب حسب جدارته (حقن SQL حاجب — اطلب التغييرات). لكن المشكلة النظامية تتطلب استجابة منفصلة: توثيق النمط، وتحديد السبب الجذري، واقتراح إصلاح نظامي (مثل قاعدة Semgrep في CI). وإجراء النقاش نفسه ثلاث مرات منفصلة غير فعال ويفشل في منع النمط لدى الفريق الرابع."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تطبيق إطار المراجعة التقنية لمنصة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "اكتب مراجعة كود كاملة لطلب سحب افتراضي لخدمة دفع يحتوي: (1) ثغرة حقن SQL في نقطة بحث عن المعاملات، (2) فحص null مفقودًا في حساب مبلغ، (3) ذاكرة مؤقتة غير محدودة لسجل المدفوعات، (4) عدم اتساق طفيفًا في التسمية. ولكل نتيجة، اكتب تعليق مراجعة بالصيغة المعروضة في الدرس — مع وسم كل منها كحاجبة أو غير حاجبة مع المبرر، والربط بالتوثيق ذي الصلة (ADR، وإرشادات البرمجة الآمنة، وسجل الدين التقني)."},
    {"id": "2", "description": "أجرِ مراجعة تصميم باستخدام قائمة التحقق للتقنية المالية لخدمة تقييم احتيال فوري مقترحة. والخدمة: تعالج معاملات البطاقات بشكل متزامن، وتخزن خصائص المعاملات في Redis، وتستدعي نموذج تعلم آلي عبر REST، وتعيد درجة مخاطرة خلال 50 مللي ثانية. ومرّ على كل قسم في قائمة التحقق (الصحة، والأمان، والامتثال، وقابلية التشغيل، وقابلية التوسع) ووثّق نتيجتين على الأقل لكل قسم. وأسند لكل نتيجة أولوية (يجب التغيير / فكّر / سؤال) ومالكًا."},
    {"id": "3", "description": "صمّم عملية مجلس مراجعة معمارية لفريق منصة في التقنية المالية من 150 مهندسًا عبر 12 فريقًا. وحدد: تكوين المجلس وقواعد التصويت، والعتبة بين ما يتطلب مراجعة المجلس ومراجعة التصميم على مستوى الفريق، وقالب تقديم للمجلس، وإيقاع الاجتماعات وحدها الزمني، ومسار تصعيد للقرارات العاجلة التي لا تستطيع انتظار جلسة المجلس التالية. وضمّن مثالًا على سجل قرار للمجلس لاعتماد نهج جديد لإدارة الأسرار."},
    {"id": "4", "description": "أنشئ مجموعة قواعد Semgrep تكتشف ثلاث مشكلات نظامية في جودة الكود وُجدت في تدقيق افتراضي لقاعدة كود خدمة دفع: (1) الربط المباشر للنصوص في استعلامات SQL، (2) تسجيل كائنات قد تحتوي أرقام بطاقات (أنواع تحتوي 'card' أو 'pan' أو 'account')، (3) استدعاءات HTTP دون إعداد مهلة. ولكل قاعدة، اكتب نمط Semgrep بصيغة YAML وإعداد خط CI يُفشل البناء عند أي تطابق."}
  ]
}
-->
