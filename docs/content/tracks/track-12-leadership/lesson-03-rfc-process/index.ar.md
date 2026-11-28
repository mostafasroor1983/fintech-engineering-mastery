---
id: track-12-lesson-03
title: "عملية RFC — قيادة القرارات التقنية على نطاق واسع"
slug: rfc-process
track: track-12
trackName: "القيادة الهندسية على مستوى Staff وPrincipal"
sequence: 3
difficulty: principal
estimatedMinutes: 80
status: published
tags: [RFC, technical-decision, proposal, review, consensus]
prerequisites: [track-12-lesson-02]
---

# عملية RFC — قيادة القرارات التقنية على نطاق واسع

> [!NOTE]
> طلب التعليقات (RFC) ليس عقبة بيروقراطية — بل الآلية التي يقود بها المهندس الرئيسي القرارات التقنية الكبرى على نطاق واسع دون الحاجة إلى حضور كل اجتماع. فطلب التعليقات المكتوب جيدًا يخلق المواءمة، ويُظهر المخاوف قبل التنفيذ، وينتج سجلًا دائمًا لسبب اتخاذ القرار.

## لماذا RFC في المستوى الرئيسي

كمساهم فردي دون تابعين مباشرين، يأتي تأثيرك على الاتجاه التقني أساسًا من قدرتك على الإقناع. وطلبات التعليقات أداتك الأساسية لهذا التأثير. فهي تتيح لك:

**قيادة القرارات بشكل غير متزامن**: يتيح طلب التعليقات المكتوب جيدًا لـ 20 مهندسًا عبر 4 مناطق زمنية التفاعل مع مقترح دون اجتماع لساعتين لا يستطيع نصفهم حضوره.

**إظهار المخاوف مبكرًا**: تغيير الكود مكلف. وتغيير البنية أكثر كلفة. وطلب التعليقات الذي يُظهر اعتراضًا حرجًا خلال فترة التعليق يوفر أسابيع من إعادة العمل.

**إنشاء ذاكرة مؤسسية**: بعد سنتين من الآن، حين يسأل أحد "لماذا بنينا خط تسوية قائمًا على Kafka بدل خط متزامن؟"، يجيب طلب التعليقات عن ذلك السؤال. ودونه، تعيش المعرفة المؤسسية في رأس مهندس واحد فقط.

**توسيع أثرك**: تستطيع شخصيًا مراجعة 2-3 تصاميم في الأسبوع. وتتيح لك عملية RFC وضع معايير تؤثر على 20 تصميمًا دون لمس كل منها.

---

## دورة حياة RFC

```
DRAFT                COMMENT PERIOD        DECISION           IMPLEMENTATION      CLOSED
  │                       │                    │                    │               │
  ├─ Author drafts RFC     ├─ Engineers review  ├─ Author            ├─ Code written  ├─ Outcome documented
  ├─ Share with 1-2        ├─ Questions asked   │  summarises        ├─ RFC kept as   │  (success, modified,
  │  trusted reviewers     ├─ Alternatives      │  discussion        │  reference     │  or abandoned)
  ├─ Post to RFC repo      │  discussed         ├─ Decision          ├─ Linked from   └─ Status: Closed
  │  (or Confluence)       ├─ Concerns raised   │  made by           │  ADR
  └─ Status: Draft         └─ 1-2 week window   │  designated        └─ Status:
                           Status: Review       │  decision maker      Implementing
                                                └─ Status: Accepted/Rejected/Deferred
```

**فترة التعليق**: أسبوع إلى أسبوعين لمعظم طلبات التعليقات. و2-4 أسابيع للتغييرات المعمارية الكبرى (مثل الترحيل من مونوليث إلى خدمات مصغّرة). والفترات الأقصر تؤدي إلى قرارات تُتخذ دون مدخلات كاملة؛ والفترات الأطول تجعل النقاشات تتعثر.

**صانع القرار**: حدده مسبقًا. ولا يجب أن يكون "يصوّت الفريق" (مأساة المشاعات) أو "يفوز صاحب الصوت الأعلى". وللقرارات التقنية، يكون عادة: المهندس الرئيسي مؤلف طلب التعليقات (لأسئلة النهج التقني)، أو المدير الهندسي (لأسئلة الموارد والأولويات)، أو نائب الرئيس للهندسة (للقرارات المعمارية متعددة الفرق).

---

## قالب RFC

```markdown
# RFC-042: Migrate Payment Settlement to Event-Driven Architecture

**Status**: Review
**Author**: @principal-engineer-name
**Created**: 2026-11-01
**Decision deadline**: 2026-11-15
**Decision maker**: Head of Payments Engineering

---

## Problem Statement

The current payment settlement process uses synchronous REST calls from the payment
service to the settlement service. This creates three problems:

1. **Reliability**: If the settlement service is unavailable, payments fail immediately,
   even though settlement can be delayed by hours without customer impact.
2. **Performance**: Settlement for high-value payments requires fraud review, which
   blocks the synchronous call chain for up to 30 seconds (p99).
3. **Scalability**: Settlement throughput is bounded by the settlement service's
   synchronous capacity. During end-of-day batch, we see 10% payment failure rate.

**Evidence**:
- Settlement service availability: 99.6% (last 90 days) → ~1,750 failed payments/day
- p99 settlement latency: 28s during peak
- End-of-day failure rate: data from Grafana dashboard [link]

---

## Goals

- Payment submission success rate > 99.95% (regardless of settlement service availability)
- Settlement processing throughput: 10,000 payments/minute (5x current peak)
- Settlement latency: p99 < 2 minutes (acceptable customer experience; currently 28 seconds worst case but synchronous)

## Non-Goals

- Migrating the fraud service (separate RFC)
- Real-time payment settlement (immediate settlement is a future initiative)
- Replacing the settlement service's internal implementation

---

## Proposed Solution

Introduce a Kafka-based settlement pipeline. Payment service records a
`PaymentSettlementRequested` event in an outbox table IN THE SAME database
transaction as the payment authorisation; a relay (Debezium CDC) publishes it to
Kafka. Settlement service consumes events asynchronously. (Publishing to Kafka
directly after the commit would be a dual write: a crash between the two steps
loses the event.)

**Architecture**:
~~~
Payment Service ──publish──► Kafka Topic (payment-settlements) ──consume──► Settlement Service
                                                                                      │
                                                                                      ▼
                                                                             Settlement Database
                                                                                      │
                                                                                      ▼
                                                                     publish PaymentSettled event
                                                                                      │
Payment Service ◄──consume────────────────────────────────────────────────────────────
~~~

**Failure handling**: If settlement fails (e.g., insufficient funds discovered during settlement), publish a `PaymentSettlementFailed` event. Payment service handles compensating transaction.

**Kafka configuration**: Settlement topic with 20 partitions (supports 20x parallelism), keyed by payment_id (keeps each payment's events in order), replication factor 3 with min.insync.replicas=2, retention 7 days (allows replaying recent events for recovery).

---

## Alternatives Considered

### Alternative 1: Orchestrated saga with a workflow engine (rejected)
A central orchestrator (e.g. Temporal) drives each settlement step.
Rejected because: the settlement pipeline is two services; running and
operating a workflow engine is not justified yet. Revisit if more steps are added.

### Alternative 2: Synchronous with queue-based retry (rejected)
Payment service retries settlement call with exponential backoff.
Rejected because: does not solve throughput problem; Tomcat thread blocks during retry wait.
Settlement service failures still cause payment submissions to slow down.

### Alternative 3: Publish directly to Kafka after the database commit (rejected)
Payment service commits the payment, then calls the Kafka producer.
Rejected because: it is a dual write — if the service crashes after the commit
but before the publish, the payment is never settled. The outbox in the proposed
solution makes "payment recorded" and "event recorded" one atomic step.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| At-least-once delivery causes duplicate settlement | Medium | Critical | Idempotency key in settlement event; settlement service deduplicates by payment_id |
| Kafka consumer lag grows during peak | Low | High | Monitor lag; auto-scale consumers; alert at lag > 10,000 |
| Event schema evolution breaks consumers | Medium | Medium | Use Avro with Confluent Schema Registry; backward-compatible schema evolution |
| Settlement failure not surfaced to customer promptly | Low | Medium | Settlement service publishes failure events within 30 seconds |

---

## Success Criteria

- Payment submission success rate > 99.95% (measured over 30 days post-migration)
- Settlement consumer lag < 1,000 messages at peak
- Settlement throughput: tested to 10,000 payments/minute in load test
- Zero duplicate settlements in first 30 days (measured via reconciliation report)

---

## Implementation Plan

Week 1-2: Schema design and Schema Registry setup
Week 3-4: Payment service Kafka producer implementation
Week 5-6: Settlement service Kafka consumer implementation
Week 7: Integration testing in staging
Week 8: Gradual rollout (10% → 50% → 100% using feature flag)
Week 9+: Monitor and validate success criteria

**Rollback plan**: Feature flag to revert to synchronous calls. Settlement event consumer can be paused; payment service falls back to synchronous call.

---

## Open Questions

1. Should we use a consumer group per region or a single global consumer group?
   (Affects ordering guarantees for multi-region deployment)

2. What is the acceptable consumer lag threshold before we alert on-call?

3. Do we need message signing (payment service signs events, settlement service verifies)?
   (Security implication — settlement events contain financial data)
```

---

## إدارة اجتماع مراجعة RFC

لطلبات التعليقات المعقدة، يسرّع اجتماع مراجعة محدد الوقت التقارب. فدونه، قد يستمر النقاش غير المتزامن أسابيع دون حسم.

**الهيكل (60 دقيقة):**

```
0-5 min:  Author presents the problem statement (not the solution)
          "This is the problem we have. These are the constraints."

5-20 min: Questions of clarification (not debate)
          "I need to understand X before I can evaluate the proposal."

20-40 min: Discussion of tradeoffs and alternatives
           "What if we used Y instead? Have we considered Z?"
           Author: acknowledge valid concerns, explain reasoning

40-55 min: Identify remaining open questions
           "These three questions need answers before we decide."
           Assign owners: who will answer each question by when?

55-60 min: Decision or next step
           If sufficient information: decision maker decides
           If open questions remain: schedule next review or close async
```

**قواعد التيسير:**
- يتحدث شخص واحد في كل مرة (المهندس الرئيسي ييسّر)
- الأسئلة قبل الاعتراضات ("هل تساعدني على فهم لماذا X؟" قبل "X خطأ")
- لصانع القرار الكلمة الأخيرة — ورأي الأغلبية استشاري، لا ملزم

---

## تحقيق الموافقة لا الإجماع

الإجماع ("الجميع متفقون") بعيد المنال في معظم القرارات المعمارية المهمة. فبعض المهندسين سيفضلون دائمًا نهجًا مختلفًا. وانتظار الإجماع يعني عدم القرار أبدًا.

أما **الموافقة** ("لا أحد لديه اعتراض غير قابل للحل") فقابلة للتحقيق. والفرق:
- الإجماع: "أظن أن هذا أفضل نهج"
- الموافقة: "لدي مخاوف بشأن X، وقد سُمعت ونالت الاعتراف، وأستطيع التعايش مع هذا القرار"

الرأي المخالف مشروع ويجب تسجيله في طلب التعليقات. فهو يُثبت أن القرار اتُّخذ بمعلومات كاملة، لا بتجاهل المخاوف.

```markdown
## Dissenting Opinion — @engineer-name

I support the decision but want to record my concern for the record:
The proposed Kafka consumer uses at-least-once delivery. The idempotency
implementation assumes payment_id is sufficient for deduplication.
If the same payment_id is ever reused (e.g., after a system migration),
we will have silent duplicate settlements — and a legitimate second
settlement attempt for the same payment would be wrongly dropped.

Recommendation: deduplicate on a dedicated settlement_request_id (UUID
generated once when the settlement is requested and carried unchanged
through every retry). Do NOT include a timestamp in the key: a retry
would get a new timestamp and slip past deduplication.

Decision maker acknowledged this concern. It has been captured as a
follow-up: PAY-5678 "Dedicated settlement_request_id for deduplication"
```

---

## أنماط RFC المضادة

**طلب التعليقات كبيروقراطية**: تُنشأ طلبات تعليقات لكل قرار صغير، بما فيها التافهة. فتشعر الفرق أنه لا يمكن فعل شيء دون طلب تعليقات مكتوب. وهذا يقتل السرعة دون فائدة.

**طلب التعليقات كأمر واقع**: قرر المؤلف بالفعل وبنى إثبات مفهوم. ويُكتب طلب التعليقات للحصول على موافقة شكلية. فيشعر المراجعون أن مدخلاتهم غير مقدّرة ويتوقفون عن التفاعل.

**التصميم باللجان**: لطلب التعليقات 15 مراجعًا، يجب أن يوافقوا جميعًا. فيُخفف المقترح لإرضاء الجميع وينتهي كتسوية متواضعة.

**لا صانع قرار**: لطلب التعليقات 50 تعليقًا، ولا نقطة قرار واضحة، فيتعثر إلى أجل غير مسمى لأن لا أحد مخوّل بالقرار.

**طويل جدًا**: طلب التعليقات الذي تستغرق قراءته 3 ساعات لن يُقرأ. فيجب أن يكون بيان المشكلة صفحة واحدة. والمقترح صفحتين. ويجب أن يكون طلب التعليقات كاملًا قابلًا للقراءة في 20 دقيقة.

---

## أمثلة RFC في التقنية المالية

**مواضيع RFC جيدة** (مهمة، وعابرة للفرق، ومعمارية):
- الترحيل من التسوية المتزامنة إلى المدفوعة بالأحداث (أعلاه)
- اختيار مورد لتقييم الاحتيال مقابل البناء داخليًا
- اعتماد مصادر الأحداث (event sourcing) لدفتر الأستاذ
- تعريف معيار المصادقة بين الخدمات (mTLS مقابل JWT)

**مواضيع RFC سيئة** (صغيرة جدًا، ويجب أن تكون ADR أو مجرد طلب سحب):
- أي مكتبة تسجيل Java تُستخدم في خدمة واحدة
- استخدام `Optional` أو null في دالة محددة
- تغييرات إعداد في خدمة واحدة
- إعادة تسمية عمود في قاعدة البيانات

---

## الخلاصات الأساسية

- القيمة الأساسية لطلب التعليقات هي إظهار الاعتراضات قبل التنفيذ، لا إنتاج التوثيق — فالنقاش هو المنتج، والوثيقة تسجّله
- حدد صانع القرار قبل فتح فترة التعليق: "سيقرر الفريق" ينتج نقاشات طويلة دون حسم
- حقق الموافقة (لا اعتراضات غير قابلة للحل)، لا الإجماع (الجميع متفقون) — وسجّل الآراء المخالفة رسميًا لإثبات أن القرار اتُّخذ بمعلومات كاملة
- الأنماط المضادة تقتل العملية: مراجعون مطلوبون كثيرون جدًا، وقرارات متخذة قبل كتابة طلب التعليقات، واشتراط طلب تعليقات للقرارات التافهة
- في التقنية المالية، طلبات التعليقات مهمة بشكل خاص للقرارات ذات الآثار على الامتثال — فالسجل المكتوب يُثبت أن متطلبات الأمان وحماية البيانات والمتطلبات التنظيمية أُخذت في الاعتبار

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق بين السعي إلى 'الموافقة' مقابل 'الإجماع' في عملية قرار RFC؟",
      "options": ["الموافقة تتطلب تصويت الأغلبية؛ والإجماع يتطلب الإجماع التام", "الموافقة تعني عدم وجود اعتراضات غير قابلة للحل — فيمكن المضي في القرار حتى لو لم يفضّله الجميع؛ والإجماع يتطلب اتفاق الجميع. والموافقة هي الهدف لأن الإجماع كثيرًا ما يكون غير قابل للتحقيق في القرارات التقنية المهمة", "الموافقة للقرارات الأمنية؛ والإجماع للقرارات المعمارية", "الموافقة غير رسمية؛ والإجماع رسمي"],
      "correct": 1,
      "explanation": "اشتراط الإجماع (اتفاق الجميع) يعطي كل مراجع حق النقض وينتج تصاميم مخففة ترضي الجميع بالحد الأدنى. أما الموافقة (لا اعتراضات غير قابلة للحل) فتتيح للمهندس الرئيسي المضي في أفضل قرار حتى لو فضّل بعض المراجعين بدائل، طالما سُمعت الاعتراضات وعولجت أو سُجلت رسميًا كرأي مخالف."
    },
    {
      "text": "لماذا يُعد 'طلب التعليقات كأمر واقع' نمطًا مضادًا يقتل عملية RFC؟",
      "options": ["يهدر الوقت في كتابة التوثيق لقرارات متخذة بالفعل", "حين يكون المؤلفون قد قرروا وبنوا إثبات مفهوم قبل كتابة طلب التعليقات، يدرك المراجعون أن مدخلاتهم غير مطلوبة فعلًا ويتوقفون عن التفاعل — فيصبح طلب التعليقات عملية موافقة شكلية دون رقابة تقنية حقيقية", "يخالف متطلب الجدول الزمني لطلب التعليقات", "يجعل طلب التعليقات أطول من أن يُقرأ"],
      "correct": 1,
      "explanation": "قيمة طلب التعليقات في إظهار الاعتراضات والبدائل قبل التنفيذ، حين تكون معالجتها رخيصة. فإن كان إثبات المفهوم مبنيًا بالفعل، فتغيير النهج يكلف أسابيع من إعادة العمل. والمراجعون الذين يعرفون أن ملاحظاتهم لن تغيّر النتيجة يتوقفون عن تقديم مراجعات حقيقية، فتُهدم وظيفة الرقابة في عملية RFC."
    },
    {
      "text": "ما الذي يجعل موضوعًا مناسبًا لعملية RFC مقابل كونه أصغر من أن يستحق طلب تعليقات؟",
      "options": ["طلبات التعليقات فقط للقرارات التي تتجاوز عتبة ميزانية معينة", "يجب أن تكون مواضيع RFC مهمة (تؤثر على فرق متعددة أو المنصة كاملة)، وعابرة (لا يملكها فريق واحد)، ومعمارية (قرارات هيكلية ذات عواقب طويلة الأمد) — أما القرارات التافهة مثل اختيار مكتبة التسجيل أو إعادة تسمية الأعمدة فمكانها ADR أو طلبات السحب", "يجب أن تستغرق مواضيع RFC أكثر من 3 أشهر للتنفيذ", "أي قرار تقني يتطلب RFC"],
      "correct": 1,
      "explanation": "عبء طلب التعليقات كبير — الكتابة، ودورات المراجعة، وعملية القرار. وهذا العبء يستحق للقرارات التي تؤثر على فرق متعددة، أو لها عواقب معمارية، أو آثار على الامتثال. وللقرارات التافهة، يتجاوز العبء الفائدة. واستخدام RFC للقرارات الصغيرة يقتل سرعة الفريق دون إضافة قيمة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "كتابة RFC وتيسيره لقرار في منصة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "اكتب RFC كاملًا لترحيل خدمة تسوية المدفوعات من REST المتزامن إلى Kafka المدفوع بالأحداث: ضمّن بيان المشكلة بسياق الأعمال، و3 نُهج بديلة مع مقايضات كل منها، والحل المقترح مع مخطط معماري، واعتبارات الأمان والامتثال، والأسئلة المفتوحة."},
    {"id": "2", "description": "صمّم عملية مراجعة RFC: عرّف قائمة المراجعين (من يجب أن يراجع، ومن ينبغي أن يراجع)، وحدد فترة تعليق من 10 أيام عمل، وأنشئ قالبًا لهيكلة التعليقات كـ 'قلق/اقتراح/سؤال'، وعرّف صانع القرار ومعايير الموافقة، وخطط جدول أعمال اجتماع القرار النهائي."},
    {"id": "3", "description": "تعامل مع تعليق مخالف: بالنظر إلى مراجع يعترض بأن 'Kafka يضيف تعقيدًا تشغيليًا لسنا مستعدين له' — اكتب ردًا يعترف بالقلق، ويقدم أدلة تعالجه (خطة تدريب الفريق، وعرض Kafka مُدار)، وإما يضمّنه في التصميم أو يسجّله رسميًا كرأي مخالف باسم المراجع."},
    {"id": "4", "description": "أنشئ مُدخلًا في سجل قرارات RFC: وثّق القرار النهائي، والمبرر، وكل البدائل المدروسة مع أسباب رفضها، والآراء المخالفة الرسمية، وتاريخ القرار وصانعه — مهيكلًا بحيث يفهم مهندس جديد ينضم بعد سنتين بالضبط لماذا اختير النهج المدفوع بالأحداث بدل REST المتزامن."}
  ]
}
-->
