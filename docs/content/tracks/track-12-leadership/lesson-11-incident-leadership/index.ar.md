---
id: track-12-lesson-11
title: "قيادة الحوادث — القيادة والتواصل"
slug: incident-leadership
track: track-12
trackName: "القيادة الهندسية على مستوى Staff وPrincipal"
sequence: 11
difficulty: principal
estimatedMinutes: 75
status: published
tags: [incident-leadership, incident-commander, communication, postmortem, blameless]
prerequisites: [track-12-lesson-10]
---

# قيادة الحوادث — القيادة والتواصل

> [!NOTE]
> الفرق بين حل في 15 دقيقة وانقطاع لثلاث ساعات في نظام دفع عادة ليس القدرة التقنية — فالمهندسون في الغرفة لديهم المهارات. بل القيادة: أدوار واضحة، وتواصل منظم، واتخاذ قرار هادئ تحت الضغط. وهذه مهارات قابلة للتعلم يجب أن يطورها المهندسون الرئيسيون.

## دور قائد الحادث

قائد الحادث (IC) ليس الشخص الذي يصلح المشكلة. بل الشخص الذي ينسق بين من يصلحون المشكلة.

**مسؤوليات قائد الحادث:**
- الحفاظ على الوعي بالموقف: ماذا نعرف؟ في ماذا نحقق؟ ماذا جربنا؟
- منع تكرار مسارات التحقيق
- اتخاذ القرارات حين يتعثر الفريق أو يختلف
- إبلاغ الحالة لأصحاب المصلحة خارج الغرفة
- مراقبة الوقت: إن لم ينجح نهج خلال 15 دقيقة، غيّر النهج
- التصعيد حين تلزم خبرة غير موجودة في الغرفة

**ما لا يفعله قائد الحادث:**
- كتابة الكود أو تشغيل الأوامر أثناء الحادث (هذه مهمة القائد التقني)
- التعمق في مشكلة محددة واحدة مع فقدان رؤية الموقف الأوسع
- ترك الأقدمية تُسكت الآخرين: إن كانت لدى مهندس مبتدئ نظرية، فهي تستحق أن تُسمع

**فصل قائد الحادث عن القائد التقني أمر حاسم.** ففي كل حادث يكون فيه الشخص نفسه يشغّل الأوامر وينسق الاستجابة، يتداخل الدوران. فيصبح من يصحح غافلًا عن المسارات المتوازية؛ ويُتجاهل التواصل مع أصحاب المصلحة.

---

## انضباط التواصل في غرفة العمليات

استجابة لحادث بعشرة مهندسين في قناة Slack أو مكالمة فيديو، يتحدثون جميعًا في آن واحد، أبطأ وأكثر ضجيجًا من 3 مهندسين بانضباط تواصل واضح.

### قواعد غرفة العمليات

**يتحدث شخص واحد في كل مرة.** يفرض قائد الحادث ذلك. فإن تحدث شخصان، يقول قائد الحادث: "لنسمع من [الشخص] أولًا".

**صيغة الحالة، والإجراء، والتحديث.** يتبع كل تواصل هذا الهيكل:

```
STATE:   What you know to be true right now
ACTION:  What you are currently doing about it
UPDATE:  When you will report back (or what would change your assessment)
```

مثال:
```
"Database: connections normal at 14/20 (STATE).
 I'm checking the slow query log now (ACTION).
 Will update in 2 minutes (UPDATE)."
```

**اكتب كل شيء في قناة الحادث.** القرارات المتخذة شفهيًا في مكالمة دون كتابتها تتبخر. ويسجّل قائد الحادث أو كاتب معيّن كل النتائج والقرارات الأساسية في قناة Slack للحادث في الوقت الفعلي.

**تجنب التخمين.** "على الأرجح إنها قاعدة البيانات" المقولة بثقة دون دليل ترسل المهندسين خلف خيط خاطئ. واستخدم: "قاعدة البيانات فرضية — نحتاج إلى التأكيد".

---

## تفويض مسارات التحقيق

استجابة غير مُدارة لحادث تجعل الجميع يحققون في الشيء نفسه. والاستجابة المُدارة فيها مسارات تحقيق متوازية بمالكين واضحين.

**هيكل تفويض المسارات:**

```
IC (Incident Commander): @alice
  Current assessment: Payment API error rate at 15% since 02:17 UTC
  Known: DB connections normal. Kafka lag normal.
  Unknown: Root cause.

  THREAD 1: Database layer
    Owner: @bob
    Investigating: Slow query log, explain plans for recent queries
    Checkpoint: 10 minutes

  THREAD 2: Recent deployments
    Owner: @charlie
    Investigating: Any deployments in last 4 hours; diff between current and previous
    Checkpoint: 5 minutes

  THREAD 3: External dependencies
    Owner: @diana
    Investigating: Payment gateway status page; fraud service health; notification service health
    Checkpoint: 5 minutes

  ESCALATION READY: @frank (database admin, paged but not yet on call)
```

**انضباط نقاط التفتيش للمسارات:** يطلب قائد الحادث تحديثات المسارات في الفترات المحددة. وإن لم يجد مسار شيئًا خلال 15 دقيقة، أعد تقييم ما إذا كان يستحق الاستمرار.

---

## الحفاظ على الهدوء تحت الضغط

تخلق الحوادث في أنظمة الدفع ضغطًا حقيقيًا: العملاء لا يستطيعون الدفع، والأموال معرضة للخطر، وقد يكون المنظمون معنيين. والحالة العاطفية لقائد الحادث معدية. فإن كان قائد الحادث مذعورًا، تذعر الغرفة.

### تقنيات للحفاظ على رباطة الجأش

**أبطئ لتسرع**: الرغبة في التصرف فورًا قوية. فقاومها. فخمس دقائق من التقييم الواضح تنتج دائمًا تقريبًا حلًا أسرع من 20 دقيقة من التصرف غير المنسق.

**سمِّ حالة الغرفة**: "نحقق منذ 20 دقيقة دون إيجاد السبب الجذري. هذا غير مريح، لكنه طبيعي. لنعِد الضبط ونتأكد من صحة افتراضاتنا".

**طبّع عدم المعرفة**: "لا نعرف السبب الجذري بعد" حالة كاملة ودقيقة. والتظاهر بالمعرفة حين لا تعرف يخلق خيوطًا خاطئة.

**اعترف بالضغط دون أن يشلّك**: "أعرف أن العملاء ينتظرون. نتحرك بأسرع ما نستطيع بأمان. والذعر لن يساعدهم أسرع".

---

## إيقاع التواصل مع أصحاب المصلحة

يحتاج أصحاب المصلحة خارج غرفة الحادث — التنفيذيون، ودعم العملاء، وفرق الامتثال — تحديثات منتظمة حتى حين لا تكون لديك معلومات جديدة. فالصمت أسوأ من "ما زلنا نحقق".

### جدول التواصل

```
T+0 min  (alert fires):     Internal war room opened, IC assigned

T+5 min  (awareness):       Slack message to #incidents-leadership:
                             "P1 declared. Payment API elevated error rate.
                              IC: @alice. Investigating."

T+15 min (first update):    "Payment API: 15% error rate since 02:17.
                              Root cause under investigation.
                              DB and Kafka confirmed normal.
                              Next update: T+30 min or on significant finding."

T+30 min (if unresolved):   "Payment API: still investigating. No root cause yet.
                              We've ruled out: database, Kafka, recent payment-service deployments.
                              Now investigating: upstream fraud service performance.
                              Have rolled back deployment as precaution (error rate unchanged).
                              Next update: T+45 min.
                              @compliance-officer: customer impact has exceeded 15 minutes —
                              regulatory classification assessment in progress."

T+45 min (if resolved):     "Payment API: resolved at 03:02 UTC. 45 minutes total duration.
                              Root cause: slow SQL query introduced in fraud service 02:12 deploy.
                              Fix: rolled back fraud service deployment.
                              Impact: ~6,750 failed payment attempts (reconciliation running).
                              Postmortem scheduled: [date]. Timeline and PIR to follow."
```

---

## ما يُقال (وما لا يُقال) أثناء الانقطاعات

### ما يُقال

```
ACCURATE:
"We are experiencing elevated error rates in our payment processing API.
 Our team is actively investigating. We will provide an update in 15 minutes."

ACTIONABLE:
"If you submitted a payment in the last 30 minutes and it appears to have failed,
 please do not retry. We will process or confirm all recent transactions within 2 hours."

HONEST ABOUT TIMELINE:
"We do not have an estimated resolution time yet. We will update every 15 minutes."
```

### ما لا يُقال

```
DON'T SPECULATE:
"The database appears to have crashed." (Until confirmed)
Incorrect speculation that gets publicly shared damages trust more than "we're investigating."

DON'T PROMISE TIMELINES YOU CAN'T KEEP:
"We'll have this resolved in 10 minutes." (Unless you are very sure)
Missed promises compound the damage.

DON'T MINIMIZE:
"This is only affecting a small number of customers."
If 847 customers cannot pay, they don't feel like a small number.
State facts: "This is affecting approximately X% of payments."

DON'T GO SILENT:
Never go more than 30 minutes without an update during an active P1 incident,
even if the update is "still investigating, no new information."
```

---

## الإبلاغ التنظيمي عن الحوادث المالية

لحوادث أنظمة الدفع، قد يكون الإبلاغ التنظيمي مطلوبًا قانونًا. وهذا ليس اختياريًا.

**مبدأ أساسي**: تبدأ الساعات التنظيمية من العلم والتصنيف — لا من نهاية تحليل السبب الجذري. فبموجب DORA مثلًا، يُستحق التقرير الأولي خلال 4 ساعات من تصنيف الحادث كحادث كبير، وفي موعد لا يتجاوز 24 ساعة من العلم به. لذا يجب أن تُبلغ الهندسة الامتثال بمجرد أن يُحتمل أن يستوفي الحادث المعايير.

```
Decision tree for regulatory notification:

Is this a P1 incident affecting payment processing?
  NO  → Standard incident process (no regulatory obligation)
  YES → Continue

Is customer data potentially at risk (breach scenario)?
  YES → CISO paged immediately; breach notification process activated

Has the incident lasted more than 15 minutes of meaningful customer impact?
  YES → Notify Head of Operations and Compliance Officer immediately

Could this be a "major" incident (e.g. complete payment processing unavailability)?
  YES → UK: FCA/PRA notification under their incident-reporting rules
        US: bank regulators (OCC/Fed/FDIC) — as soon as possible and within
            36 hours of determining a notification incident occurred
        EU (DORA): initial report to the competent authority within 4 hours of
            classifying it as major (max 24 hours after awareness); intermediate
            report within 72 hours; final report within 1 month
        India: RBI / CERT-In — within hours (CERT-In: 6 hours for cyber incidents)
  
RULE: When in doubt, notify. Failure to notify is a separate regulatory breach.
      Your Compliance Officer makes the notification decision, not engineering.
```

---

## إدارة تحليل ما بعد الحادث

تحليل ما بعد الحادث (ويسمى أيضًا مراجعة ما بعد الحادث أو PIR) هو حيث تُستخرج قيمة الحادث للمؤسسة.

### تيسير اجتماع تحليل ما بعد الحادث (60-90 دقيقة)

```
Pre-work (facilitator and IC, before meeting):
  Build the timeline from logs, Slack history, PagerDuty
  Identify contributing factors (not root causes — there are always multiple factors)
  Draft 3-5 discussion questions

Meeting opening:
  "This is a blameless review. We are here to understand the system failure,
   not to assign individual blame. Everything said in this room is for learning,
   not for performance reviews or disciplinary action."

Timeline review (20 min):
  Walk through the prepared timeline
  Engineers correct inaccuracies
  Identify: what did we know and when?

Contributing factor analysis (30 min):
  For each contributing factor: "Why was this condition present?"
  Five whys: get to systemic causes, not individual errors
  
  NOT: "Bob deployed bad code"
  YES: "The CI pipeline did not catch a performance regression that only manifests under production load"

Action item generation (20 min):
  For each contributing factor: what would prevent recurrence?
  Rate each item: High/Medium/Low impact on preventing recurrence
  Assign owner + deadline to each High-impact item

What went well (10 min):
  Genuinely acknowledge what worked: fast detection, quick escalation, good communication
  This is not PR; it identifies practices worth reinforcing
```

---

## بناء ثقافة التعلم

كثيرًا ما تُعلن ثقافة عدم اللوم ونادرًا ما تُمارس. والفجوة بين الإعلان والممارسة تدمر الثقة أسرع من عدم ادعائها أبدًا.

**علامات ثقافة عدم لوم حقيقية:**
- يقدم المهندسون المعلومات بحرية في تحليلات ما بعد الحوادث دون حماية للذات
- بنود العمل نظامية (خط CI، والمراقبة، والعمليات) لا فردية (أعد تدريب فلان)
- تُنشر تحليلات ما بعد الحوادث علنًا للمؤسسة الهندسية كاملة
- يشارك المهندسون الكبار أخطاءهم علنًا في تحليلات ما بعد الحوادث

**علامات ثقافة عدم لوم زائفة:**
- يحذر المهندسون مما يقولونه في تحليلات ما بعد الحوادث
- تتضمن بنود العمل "يجب أن يكون المهندس X أكثر حذرًا"
- تُوزع تحليلات ما بعد الحوادث على الفريق المعني فقط
- لا يظهر أي شخص كبير أبدًا في تحليل ما بعد الحادث كمن ارتكب خطأ

كمهندس رئيسي، أقوى إشارة تستطيع إرسالها هي مشاركة أخطائك علنًا في تحليلات ما بعد الحوادث. فإن وصف أكثر شخص تقني أقدمية في الغرفة كيف ارتكب خطأ، وساهم في حادث، وما تعلمه — تتحول الثقافة.

---

## الخلاصات الأساسية

- ينسق قائد الحادث بين الأشخاص، لا الأنظمة — فلا يجب أن يكتب قائد الحادث الكود أثناء الحادث؛ فذلك الدور للقائد التقني
- انضباط التواصل في غرفة العمليات (الحالة، والإجراء، والتحديث؛ شخص واحد في كل مرة؛ اكتب كل شيء) مكتسب، لا طبيعي — ويجب تعليمه وفرضه
- يجب أن يحدث التواصل مع أصحاب المصلحة بإيقاع منتظم سواء كانت لديك معلومات جديدة أم لا: الصمت أسوأ من "ما زلنا نحقق، التحديث التالي خلال 15 دقيقة"
- لالتزامات الإبلاغ التنظيمي عن الحوادث المالية مواعيد صارمة تبدأ من العلم والتصنيف — ومسؤولو الامتثال يتخذون قرارات الإبلاغ، لا الفرق الهندسية
- تحليل ما بعد الحادث هو آلية استخراج القيمة: الحادث تجربة مكلفة؛ وتحليل ما بعد الحادث هو حيث تحصل على الدروس
- تتطلب ثقافة عدم اللوم أن يجسدها المهندسون الكبار صراحة: شارك أخطاءك في تحليلات ما بعد الحوادث، وتأكد من أن بنود العمل نظامية لا فردية، وانشر تحليلات ما بعد الحوادث على نطاق واسع

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "أثناء انقطاع دفع P1، يبدأ قائد الحادث بتشغيل استعلامات قاعدة البيانات وكتابة سكربتات التراجع بينما يحاول أيضًا تنسيق ثلاثة مسارات تحقيق. ما الخطأ في هذا وماذا يجب أن يفعل قائد الحادث بدلًا من ذلك؟",
      "options": [
        "لا خطأ — يجب أن يتولى الشخص الأقدم العمل التقني الأكثر أهمية",
        "يؤدي قائد الحادث دور القائد التقني في آن واحد؛ وهذا يجعله يفقد الوعي بمسارات التحقيق المتوازية والتواصل مع أصحاب المصلحة؛ ويجب أن يفوّض التنفيذ التقني إلى قائد تقني ويركز على التنسيق، والتواصل، واتخاذ القرار",
        "يجب أن يفوّض قائد الحادث التواصل إلى مهندس آخر ويركز كليًا على التحقيق التقني",
        "يجب أن يتوقف قائد الحادث عن تنسيق المسارات ويترك المهندسين ينظمون أنفسهم"
      ],
      "correct": 1,
      "explanation": "يجب فصل دور قائد الحادث عن دور القائد التقني. فحين يصحح الشخص نفسه وينسق، يسقط حتمًا مسؤوليات التنسيق — فتبقى المسارات المتوازية دون مراقبة، ويتوقف التواصل مع أصحاب المصلحة، وينهار انضباط نقطة التفتيش كل 15 دقيقة. ومهمة قائد الحادث الحفاظ على الوعي بالموقف، وتنسيق مسارات التحقيق المتوازية، والتواصل مع أصحاب المصلحة، واتخاذ القرارات حين يتعثر الفريق — لا تشغيل الأوامر أو كتابة الكود."
    },
    {
      "text": "يواجه معالج دفع منظم في الاتحاد الأوروبي انقطاعًا كاملًا في معالجة المدفوعات لمدة 20 دقيقة. متى يصبح الإبلاغ التنظيمي اعتبارًا، ومن يتخذ قرار الإبلاغ؟",
      "options": [
        "بعد اكتمال تحليل السبب الجذري الكامل؛ ويتخذ المهندس الرئيسي القرار",
        "بعد 4 ساعات من الانقطاع، تلقائيًا؛ ويبلغ قائد الحادث المنظمين",
        "خلال 4 ساعات من تصنيفه كحادث كبير متعلق بتقنية المعلومات والاتصالات (وفي موعد لا يتجاوز 24 ساعة من العلم به) بموجب DORA؛ ويتخذ مسؤول الامتثال قرار الإبلاغ، لا الهندسة",
        "فقط إن خُرقت بيانات العملاء؛ ويتخذ مدير أمن المعلومات القرار"
      ],
      "correct": 2,
      "explanation": "بموجب DORA، الذي حل منذ يناير 2025 محل إرشادات EBA/PSD2 السابقة للإبلاغ عن الحوادث للكيانات المالية في الاتحاد الأوروبي، يُستحق التقرير الأولي لحادث كبير متعلق بتقنية المعلومات والاتصالات خلال 4 ساعات من تصنيفه كحادث كبير وفي موعد لا يتجاوز 24 ساعة من العلم به، يليه تقرير مرحلي (72 ساعة) وتقرير نهائي (شهر واحد). والساعات لا تنتظر تحليل السبب الجذري. والأهم أن مسؤول الامتثال يتخذ قرار الإبلاغ، لا الهندسة — ودور الهندسة إبلاغ الامتثال فورًا ليتمكن من تصنيف الحادث."
    },
    {
      "text": "في تحليل ما بعد حادث، تتضمن قائمة بنود العمل: 'يجب أن يراجع المهندس المناوب قوائم تحقق النشر مرتين قبل الإطلاق إلى الإنتاج.' ما الخطأ في بند العمل هذا؟",
      "options": [
        "مبهم جدًا — يحتاج موعدًا نهائيًا ومالكًا محددين",
        "بند عمل لتغيير سلوك فردي، وهذه علامة على ثقافة لوم؛ وبنود العمل الفعالة في تحليل ما بعد الحادث نظامية (تحسين خط CI، وإضافة فحوص آلية، وتحديث أدلة التشغيل) لا فردية (أعد تدريب المهندس X)",
        "واسع جدًا — يجب أن يحدد أي قوائم التحقق",
        "لا خطأ — اليقظة البشرية تخفيف صالح لمخاطر النشر"
      ],
      "correct": 1,
      "explanation": "بنود العمل التي تستهدف السلوك الفردي ('يجب أن يكون المهندس X أكثر حذرًا') تشير إلى ثقافة لوم وهي غير فعالة — فالبشر معرضون للخطأ وسيرتكبون الخطأ نفسه تحت الضغط. وتعالج بنود العمل النظامية الظروف التي سمحت بالخطأ: 'أضف بوابة نشر آلية تتحقق من بنود قائمة التحقق في CI/CD' نظامي، وقابل للاختبار، ولا يعتمد على اليقظة الفردية. وتنتج تحليلات ما بعد الحوادث بلا لوم تحسينات نظامية، لا أهداف أداء فردية."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "نظام قيادة الحوادث والتواصل لمنصة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "صمّم دليل استجابة كاملًا لانقطاع P1 في معالجة المدفوعات لدى معالج دفع منظم في الاتحاد الأوروبي. ويجب أن يغطي الدليل: تعريفات دوري قائد الحادث/القائد التقني وإجراء التسليم، وقالب تفويض مسارات التحقيق (بمالك المسار، ونطاقه، ووقت نقطة التفتيش)، وإيقاع التواصل مع أصحاب المصلحة (من T+0 إلى T+45 بقوالب رسائل محددة)، وشجرة قرار الإبلاغ التنظيمي (DORA: التقرير الأولي خلال 4 ساعات من التصنيف كحادث كبير وبحد أقصى 24 ساعة من العلم به؛ وبروتوكول الخرق لدى مدير أمن المعلومات)، ومصفوفة تصعيد بأدوار مسماة وشروط إطلاق."
    },
    {
      "id": "2",
      "description": "اكتب سيناريو محاكاة كاملًا للاستجابة للحوادث لتمرين GameDay: خدمة تفويض دفع تواجه معدل أخطاء 15% يبدأ عند 02:17 UTC. ويجب أن يتضمن السيناريو: شرط التنبيه الأولي، وثلاثة مسارات تحقيق متوازية (قاعدة البيانات، والنشرات الأخيرة، والتبعيات الخارجية)، ومؤشرين مضللين يقودان المسارات إلى الضلال قبل السبب الجذري (استعلام بطيء في خدمة الاحتيال نُشر عند 02:12)، وجدولًا زمنيًا للأحداث للميسّر. وضمّن رسائل تواصل محددة لقائد الحادث عند T+5، وT+15، وT+30، وT+45."
    },
    {
      "id": "3",
      "description": "أنشئ قالب تحليل ما بعد حادث بلا لوم ومثالًا مكتملًا للسيناريو في المهمة 2 (انقطاع دفع لـ 45 دقيقة بسبب استعلام بطيء في خدمة الاحتيال). ويجب أن يتضمن القالب: قسم الجدول الزمني، وتحليل العوامل المساهمة باستخدام الأسئلة الخمسة 'لماذا' (التوقف عند العوامل النظامية لا الأخطاء الفردية)، وقسم 'ما الذي سار جيدًا'، وجدول بنود عمل بمعايير SMART. ويجب أن يتضمن المثال المكتمل 4 عوامل مساهمة على الأقل و3 بنود عمل عالية الأولوية نظامية لا فردية."
    },
    {
      "id": "4",
      "description": "صمّم سياسة تصعيد في PagerDuty وجدول مناوبة لفريق منصة دفع من 12 مهندسًا يغطي استجابة P1 على مدار الساعة. وحدد: هيكل المناوب الأساسي/الثانوي، واتفاقية مستوى الخدمة للإقرار بـ P1 (الهدف: 5 دقائق)، وخطوات التصعيد إن لم يقر الأساسي، ومسار التصعيد خارج ساعات العمل إلى نائب الرئيس للهندسة، وقائمة تحقق 'جاهزية الإبلاغ التنظيمي' التي تنطلق تلقائيًا للحوادث التي تتجاوز 15 دقيقة من الأثر على العملاء."
    }
  ]
}
-->
