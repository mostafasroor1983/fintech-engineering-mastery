---
id: track-06-lesson-18
title: "إطار المهندس الرئيسي لقرارات الموثوقية"
slug: reliability-decision-framework
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 18
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, reliability, trade-offs, staff-engineer, SLO]
prerequisites: [track-06-lesson-01, track-06-lesson-02, track-06-lesson-04]
---

# إطار قرارات الموثوقية لكبير المهندسين

> [!NOTE]
> لقرارات الموثوقية في التقنية المالية عواقب تتجاوز الدَّين التقني. فنظام دفع بـ SLO بنسبة 99.9% يعني أن 44 دقيقة توقف شهريًا مقبولة بالتصميم. فإذا وقع ذلك التوقف في آخر يوم عمل من الشهر حين تُصرف الرواتب، تمس تلك الدقائق الـ 44 آلاف الموظفين الذين يتأخر أجرهم. ويجب أن يترجم كبار المهندسين سياق العمل إلى أهداف موثوقية، وأهداف الموثوقية إلى قرارات معمارية.

## دور كبير المهندسين في الموثوقية

على مستوى كبير المهندسين / المهندس الأول، تتضمن قرارات الموثوقية:

1. **وضع أهداف SLO** تعكس الأثر التجاري للتوقف
2. **اختيار الأنماط** (قاطع الدائرة مقابل إعادة المحاولة مقابل المهلة) بناءً على دلالات الفشل
3. **تقييم مفاضلات تعدد المناطق** (الزمن، والكلفة، والاتساق)
4. **تحجيم استثمارات التعافي من الكوارث** مقابل المخاطر التجارية الفعلية للانقطاعات
5. **الموازنة بين الموثوقية وسرعة الميزات** دون قبول مخاطر خفية
6. **فهم التبعات الامتثالية** للتوقف في التقنية المالية

هذا الدرس إطار قرار. ويفترض أنك نفّذت الأنماط في الدروس السابقة.

## 1. وضع أهداف SLO حسب مستوى الخدمة

لا تحتاج كل الخدمات SLO نفسه. فضبط كل خدمة على 99.99% مكلف وغير ضروري عادة. وضبط المستوى الخاطئ يخلق إما هندسة مفرطة أو أثرًا غير مقبول على العملاء.

| مستوى الخدمة | الوصف | هدف SLO | ميزانية الأخطاء/شهر | مستوى الاستثمار |
|---|---|---|---|---|
| المستوى 0 (حرج) | إيرادات مباشرة؛ التزام رقابي | 99.99% | 4.4 دقائق | أقصى |
| المستوى 1 (أساسي) | وظائف أساسية مواجهة للعملاء | 99.9% | 44 دقيقة | عالٍ |
| المستوى 2 (قياسي) | ميزات داعمة | 99.5% | 3.6 ساعات | متوسط |
| المستوى 3 (داخلي) | أدوات داخلية، وتحليلات | 99.0% | 7.3 ساعات | قياسي |
| المستوى 4 (بأفضل جهد) | ميزات غير حرجة، وأدوات تطوير | 95%+ | 1.5 يوم | أدنى |

**أمثلة المستوى 0** (أنظمة الدفع):
- تفويض الدفع
- تقييم الاحتيال (المسار الحاجب)
- فحص العقوبات (المسار الحاجب)
- تحديثات الأرصدة في النظام المصرفي الأساسي

**أمثلة المستوى 1**:
- فتح الحسابات وKYC
- مصادقة العملاء
- استرجاع سجل المعاملات

**أمثلة المستوى 2**:
- الإشعارات (SMS/البريد الإلكتروني)
- التحليلات والتقارير
- عرض أسعار الصرف

```java
// SLO definitions as code — single source of truth for the team
public class ServiceSLORegistry {

    public static final Map<String, ServiceSLO> SLOS = Map.of(
        "payment-authorisation", ServiceSLO.builder()
                .tier(ServiceTier.TIER_0)
                .availabilityTarget(0.9999)
                .latencyP99TargetMs(500)
                .latencyP95TargetMs(200)
                .throughputTargetTps(1000)
                .build(),

        "fraud-scoring", ServiceSLO.builder()
                .tier(ServiceTier.TIER_0)
                .availabilityTarget(0.9999)
                .latencyP99TargetMs(50)
                .latencyP95TargetMs(20)
                .throughputTargetTps(1000)
                .build(),

        "account-enquiry", ServiceSLO.builder()
                .tier(ServiceTier.TIER_1)
                .availabilityTarget(0.999)
                .latencyP99TargetMs(200)
                .latencyP95TargetMs(100)
                .throughputTargetTps(500)
                .build(),

        "notification-service", ServiceSLO.builder()
                .tier(ServiceTier.TIER_2)
                .availabilityTarget(0.995)
                .latencyP99TargetMs(5000)
                .latencyP95TargetMs(2000)
                .throughputTargetTps(100)
                .build()
    );
}
```

## 2. شجرة قرار اختيار الأنماط

```
TIMEOUT CONFIGURATION
─────────────────────
Q: What is the maximum acceptable wait for a response?
  → Set to: 2x the p99 latency of the dependency
  → For payment processor (p99=200ms): timeout=400ms
  → For external KYC API (p99=3s): timeout=6s
  → Never set timeout to "indefinitely" — always set one

RETRY CONFIGURATION
───────────────────
Q: Is the operation idempotent?
  YES → Retry is safe (GET, idempotent PUT, payment with idempotency key)
  NO  → Do not retry blindly (payment authorisation without idempotency key)

Q: What type of failure causes the error?
  Transient (network blip, 503): → Retry with exponential backoff
  Permanent (401, 404, 400):     → Do not retry; fail fast
  Rate limit (429):              → Retry after Retry-After header value

Backoff: initial=100ms, multiplier=2, max=5s, jitter=30%

CIRCUIT BREAKER
───────────────
Q: Does calling a failing dependency fast-fail?
  YES → Circuit breaker appropriate (reduces cascade failure)
  NO  → Circuit breaker still reduces load on struggling dependency

Q: What is the fallback?
  Have one? → Implement circuit breaker with meaningful fallback
  No fallback available? → Circuit breaker still useful (fast error > slow error)

Configuration:
  failureRateThreshold: 50%     (open after 50% of last 20 calls fail)
  waitDurationInOpenState: 30s  (try again after 30s)
  halfOpenPermittedCalls: 5     (probe with 5 calls before fully closing)

BULKHEAD
────────
Q: Can this dependency's failure bring down the whole service?
  YES → Bulkhead isolates the dependency to a fixed thread pool
  Example: third-party PEP screening API in its own 10-thread pool
           payment processor in its own 20-thread pool
           These can fail independently without exhausting the shared pool
```

## 3. تحليل الكلفة/الفائدة لتعدد المناطق

النشط-النشط متعدد المناطق مكلف. ويتطلب القرار قياس كلفة الانقطاعات مقابل كلفة البنية التحتية.

```java
/*
 * Multi-Region Decision Framework
 *
 * COSTS:
 * - Infrastructure: 2-3x single-region cost
 * - Engineering: 6-18 months to implement correctly
 * - Operational: more complex deployments, more failure modes to manage
 * - Data synchronisation: latency overhead, consistency trade-offs
 *
 * BENEFITS:
 * - Regional outage tolerance (large cloud regions have had notable regional
 *   incidents roughly once or twice a year — use your provider's own history)
 * - Latency improvement for geographically distributed customers
 * - Regulatory: some jurisdictions require data residency in-country
 *
 * CALCULATION:
 * Expected annual cost of single-region outages:
 *   = Probability(regional outage/year) × Duration(hours) × Revenue/hour
 *   = 2 events/year × 2 hours × $500,000/hour
 *   = $2,000,000/year
 *
 * Additional cost of multi-region:
 *   = Infrastructure delta + Engineering amortised
 *   = $600,000/year + $1,500,000 engineering / 3 years
 *   = $600,000 + $500,000 = $1,100,000/year
 *
 * Decision: multi-region is justified when outage cost > multi-region cost
 * In this example: $2M > $1.1M → multi-region is justified
 *
 * BUT: multi-region introduces new failure modes:
 * - Split-brain on region partition
 * - Replication lag during failover
 * - Consistency vs availability trade-off (CAP theorem applies)
 *
 * Before investing in multi-region, exhaust single-region HA improvements:
 * - Add a synchronous replica (Patroni)
 * - Multi-AZ Kafka (3 AZs, rack-awareness)
 * - Multi-AZ Kubernetes (spread policies)
 * - These often achieve 99.95% availability at <10% of multi-region cost
 */
```

## 4. قرارات الاستثمار في التعافي من الكوارث

```java
/*
 * DR Investment Framework
 *
 * RTO (Recovery Time Objective) and RPO (Recovery Point Objective)
 * set the investment level for DR:
 *
 * TIER          RTO      RPO          Investment  Technology
 * Active-Active < 1min   ~0           Very High   Multi-region, global load balancer
 * Hot Standby   < 15min  ~0 / seconds High        Full-capacity standby; sync replication
 *                                                 in-region, near-sync to the DR region
 * Warm Standby  < 1h     seconds-min  Medium      Scaled-down secondary kept current by
 *                                                 async replication; scale up on failover
 * Cold Backup   < 24h    < 24h        Low         Restore from backup + WAL archive,
 *                                                 manual runbook
 *
 * Cost calculator:
 * DR Investment ≈ Annual Outage Cost × Fraction eliminated by DR
 *
 * Example: Payment system
 * - Single-region annual outage cost: $4M
 * - Warm standby eliminates 80% of outages: $3.2M saved
 * - Warm standby cost: $400K/year
 * - ROI: $3.2M / $400K = 8x — clearly justified
 *
 * Example: Internal analytics service
 * - Single-region annual outage cost: $50K
 * - Any DR investment > $50K/year is not justified
 * - Acceptable DR: daily backups + runbook for manual restore
 *
 * Key insight: RTO/RPO targets must come from the business,
 * not be guessed by engineering.
 * Ask: "What is the financial impact of 1 hour of downtime for this service?"
 * "What is the financial impact of 24 hours?"
 * "At what point does downtime trigger regulatory notification?"
 */
```

## 5. الموثوقية مقابل سرعة الميزات

```java
/*
 * The Reliability vs Velocity Tension
 *
 * Teams under feature pressure cut corners on reliability:
 * - Skip performance tests ("we'll add them later")
 * - Deploy without canary ("it worked in staging")
 * - Skip circuit breaker ("that's a later iteration")
 * - Take on reliability tech debt without tracking it
 *
 * The correct framing for principal engineers:
 *
 * Error budgets make this explicit and quantifiable.
 * SLO: 99.9% availability = 44 min/month error budget
 * Actual: last 30 days had 2 incidents totalling 60 min
 * Remaining error budget: -16 min (over budget)
 *
 * Decision: when over error budget:
 * → Freeze new feature deployments until reliability work restores budget
 * → Invest in reliability improvements rather than features
 *
 * Decision: when under budget (budget unspent):
 * → Some capacity for experimentation / higher deployment frequency
 * → Avoid building up large unexpended budget (lose the signal)
 *
 * This framework converts abstract reliability discussions into
 * concrete, non-negotiable project scheduling.
 *
 * PRINCIPAL ENGINEER RESPONSIBILITY:
 * - Define and document SLOs for owned services
 * - Maintain error budget tracking dashboard
 * - Escalate to engineering management when budget is at risk
 * - Defend error budget policy when feature pressure mounts
 */
```

## 6. التبعات الامتثالية للتوقف

```java
/*
 * Compliance Implications of Downtime — Key Facts for Principal Engineers
 *
 * 1. REGULATORY NOTIFICATION
 *    EU — DORA: an incident is classified as "major" using criteria set in
 *    regulatory technical standards: clients and counterparts affected,
 *    duration and service downtime, geographical spread, data losses,
 *    criticality of the services affected, economic impact, reputational
 *    impact. Compliance maps them to concrete thresholds; a major incident
 *    must be notified within 4 hours of classification (max 24h after detection).
 *    → System design must MEASURE the inputs in real time: affected customers,
 *      transaction count and value, duration
 *    → Notification tooling must work even during the outage (separate stack)
 *
 * 2. SLA vs SLO
 *    SLO (internal): 99.9% availability target
 *    SLA (contractual): may be 99.5% with financial penalty below
 *    Principal engineer must know both.
 *    Setting SLO <= SLA leaves no buffer for investigation before breach.
 *    Set SLO > SLA: with SLO=99.9% (~44 min/month) and SLA=99.5%
 *    (~3.65 h/month) the team has about 2.9 hours of buffer.
 *
 * 3. SETTLEMENT CYCLES
 *    Payment systems have hard settlement deadlines. Examples (always check
 *    the current scheme rules AND your bank's earlier internal cut-offs):
 *    - Fed same-day ACH: final submission window in the afternoon ET
 *    - TARGET (T2) euro customer payments: 17:00 CET cut-off
 *    - CHAPS: customer payments until late afternoon UK time
 *    (SWIFT itself is a messaging network: cut-offs belong to the currency's
 *     settlement system and the correspondent bank.)
 *    Downtime during these windows has amplified impact.
 *    SLO targets should be tighter during settlement windows.
 *    Change freeze: typically no deployments 2 hours before cut-offs.
 *
 * 4. GDPR / DATA BREACH
 *    If the outage involves data exposure: 72-hour notification to DPA
 *    Principal engineer should know:
 *    - What data could be exposed in a system failure scenario
 *    - Contact process for Data Protection Officer
 *    - Logging and audit trail to establish breach scope
 */
```

## 7. قائمة فحص مراجعة بنية الموثوقية

استخدمها عند مراجعة أي خدمة جديدة أو تغيير معماري كبير:

**تحليل أنماط الفشل**
- [ ] ما نمط فشل كل اعتمادية خارجية؟
- [ ] هل كل استدعاء خارجي مغلف بمهلة + قاطع دائرة؟
- [ ] هل يوجد رجوع مختبر لكل قاطع دائرة؟
- [ ] هل تستطيع الخدمة مواصلة العمليات الأساسية عندما تفشل الاعتماديات غير الحرجة؟

**القابلية للمراقبة**
- [ ] هل للخدمة SLO معرّف مع تتبع ميزانية الأخطاء؟
- [ ] هل كل المقاييس المتعلقة بالـ SLO مقيسة؟
- [ ] هل تنطلق التنبيهات قبل خرق الـ SLO (تنبيهات معدل الاستهلاك)؟
- [ ] هل توجد لوحة تُظهر صحة الخدمة في أقل من 60 ثانية؟

**ديمومة البيانات**
- [ ] هل قاعدة البيانات مضبوطة بنسخ متزامن؟
- [ ] هل Kafka مضبوط بـ acks=all وmin.insync.replicas=2؟
- [ ] هل عمليات الكتابة idempotent للتعامل مع إعادة المحاولة بأمان؟
- [ ] هل يوجد إجراء لاستعادة البيانات مختبر في تمارين التعافي؟

**قابلية التوسع**
- [ ] هل اختُبرت الخدمة تحت حمل ضعف الذروة المتوقعة؟
- [ ] هل التوسع الآلي مضبوط بحد أدنى/أقصى/فترة تهدئة مناسبة؟
- [ ] هل توجد محددات معدل تحمي الخدمات اللاحقة من الاندفاعات؟
- [ ] هل شُغّل اختبار تحمل طويل لتحديد تسربات الذاكرة؟

**الجاهزية التشغيلية**
- [ ] هل يوجد دليل تشغيل للمناوبة لأنماط الفشل الأكثر احتمالًا؟
- [ ] هل عملية النشر مختبرة للتراجع؟
- [ ] هل أُجريت تجارب هندسة الفوضى على هذه الخدمة؟
- [ ] هل الخدمة مضمّنة في تمارين التعافي من الكوارث؟

## 8. مساءلة كبير المهندسين

كبير المهندسين الذي يراجع ويوافق على بنية دون قواطع دائرة على استدعاءات معالج الدفع يملك حصة من الحادث الناتج. وقائمة الفحص أعلاه ليست بيروقراطية — بل المعيار المهني لبنية تتعامل مع المعاملات المالية.

```java
/*
 * When to escalate reliability concerns to engineering leadership:
 *
 * MUST ESCALATE:
 * - SLO target is not set for a customer-facing service
 * - Synchronous replication is disabled on payment database
 * - No fallback exists for a blocking compliance check
 * - Error budget has been over-spent for 2+ consecutive months
 * - DR recovery time has never been tested
 * - Reliability work is being consistently de-prioritised in favour of features
 *
 * HOW TO ESCALATE EFFECTIVELY:
 * 1. Quantify the risk: "This service has no circuit breaker. If the payment
 *    processor has a 30-second slowdown, our thread pool exhausts in ~10 seconds
 *    and all payment processing stops."
 *
 * 2. Provide the cost estimate: "Based on $500K/hour revenue rate, a 30-minute
 *    outage costs $250K. The circuit breaker implementation takes ~2 days."
 *
 * 3. Make the ask specific: "I need 2 engineering days to implement circuit
 *    breakers on payment processor calls, with a rollout by end of sprint."
 *
 * 4. Document the decision: If escalation is declined, document the risk
 *    acceptance in writing. This protects you and creates accountability.
 */
```

## 9. أنماط موثوقية مضادة شائعة في التقنية المالية

| النمط المضاد | الخطر | النهج الصحيح |
|---|---|---|
| لا مهلة على استدعاءات الواجهات الخارجية | تجويع الخيوط، وانقطاع كامل | اضبط المهلة = ضعف زمن p99 |
| إعادة المحاولة دون idempotency | مدفوعات مكررة، وخصم مزدوج | مفتاح idempotency على كل تعديلات الدفع |
| قاطع دائرة دون رجوع | خطأ مرئي بدل خدمة متدهورة | عرّف دائمًا رجوعًا |
| SLO مساوٍ للـ SLA (أو أقل منه) | لا هامش قبل خرق العقد | يجب أن يكون الـ SLO أعلى من الـ SLA بوضوح |
| اختبار الحمل بأنماط حركة غير واقعية | يفوّت أنماط الفشل الحقيقية | أسّس الاختبارات على ملفات حركة الإنتاج |
| التعافي من الكوارث لم يُختبر قط | RTO/RPO الفعليان مجهولان | تمرين تعافٍ سنوي بتحول حقيقي |
| الموثوقية يملكها فريق واحد | منعزلة؛ غير مدمجة في فرق الميزات | كل فريق يملك موثوقية خدمته |
| عتبة التنبيه = عتبة الـ SLO | لا وقت للاستجابة قبل الخرق | نبّه على معدل استهلاك ميزانية الأخطاء (متعدد النوافذ)، قبل خرق الـ SLO |

## الخلاصة

يبدأ إطار قرارات الموثوقية لكبير المهندسين بأهداف SLO مستنيرة بالأعمال، ويترجمها إلى متطلبات معمارية، ويطبق الأنماط (قواطع الدائرة، وإعادات المحاولة، والحواجز، ومحددات المعدل) مع استراتيجيات رجوع صريحة. وتُبرَّر استثمارات تعدد المناطق والتعافي من الكوارث بقياس كلفة الانقطاعات مقابل كلفة المرونة. وتفرض ميزانيات الأخطاء مفاضلة الموثوقية مقابل السرعة بطريقة قابلة للدفاع عنها وقائمة على البيانات. والتبعات الامتثالية للتوقف — عتبات الإبلاغ الرقابي، ومواعيد التسوية، وعواقب الـ SLA — متطلبات تقنية، لا مشكلات لفريق الامتثال وحده. وكبير المهندسين الذي يصمم النظام مسؤول عن ضمان الوفاء بهذه المتطلبات.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لخدمة تفويض دفع SLA توفر بنسبة 99.5%. على أي قيمة يجب ضبط الـ SLO الداخلي؟",
      "options": ["99.5% بالضبط — مطابقة الـ SLA تعطي أقصى سرعة للميزات", "أقل من 99.5% لتعظيم ميزانية الأخطاء لعمل الميزات", "أعلى من 99.5% بوضوح، مثل 99.9%، لتوفير هامش قبل خرق الـ SLA", "100% — يجب ألا يكون لأنظمة الدفع أي توقف"],
      "correct": 2,
      "explanation": "يجب ضبط الـ SLO أعلى من الـ SLA بقدر ذي معنى لتوفير هامش تحذير داخلي. فمع SLO بنسبة 99.9% (نحو 44 دقيقة توقف شهريًا) وSLA بنسبة 99.5% (نحو 3.65 ساعات شهريًا)، يملك الفريق نحو 2.9 ساعة هامشًا قبل خرق الـ SLA التعاقدي. وضبط الـ SLO مساويًا للـ SLA يعني أن أي خرق للـ SLO هو خرق للـ SLA في الوقت نفسه، دون وقت للتحقيق والحل."
    },
    {
      "text": "يتجادل فريق حول الاستثمار في نشط-نشط متعدد المناطق لخدمة الدفع. كيف يجب أن يؤطّر كبير المهندسين هذا القرار؟",
      "options": ["تعدد المناطق ضروري دائمًا للخدمات المالية", "قِس الكلفة السنوية لانقطاعات المنطقة الواحدة مقابل الكلفة السنوية لتعدد المناطق، ثم برّر إذا تجاوزت كلفة الانقطاع كلفة البنية", "تعدد المناطق أعقد من أن تتحمله معظم الفرق — تجنبه", "يجب أن تقود متطلبات الزمن القرار، لا الكلفة"],
      "correct": 1,
      "explanation": "تعدد المناطق استثمار كبير (2–3 أضعاف كلفة البنية، و6–18 شهرًا من الهندسة). والنهج الصحيح القياس: الاحتمال السنوي لانقطاع منطقة × المدة × الإيرادات في الساعة = الكلفة السنوية المتوقعة للانقطاع. فإذا تجاوزت الكلفة السنوية لتعدد المناطق، فهو مبرر. ويُظهر الدرس هذا الحساب صراحة بمثال كلفة انقطاع مليوني دولار مقابل 1.1 مليون لتعدد المناطق."
    },
    {
      "text": "أنفق فريق هندسي ميزانية أخطائه كاملة للشهر لكن ما زالت لديه ثلاثة أسابيع من الميزات المخططة. بماذا يجب أن يوصي كبير المهندسين؟",
      "options": ["الاستمرار في عمل الميزات — ميزانيات الأخطاء إرشادات لا قواعد", "تجميد نشر الميزات الجديدة واستثمار وقت الهندسة في تحسينات الموثوقية لاستعادة ميزانية الأخطاء", "خفض هدف الـ SLO لإعطاء هامش أكبر لميزانية الأخطاء", "نشر الميزات خارج ساعات الذروة لتقليل المخاطر"],
      "correct": 1,
      "explanation": "ميزانيات الأخطاء هي الآلية التي تجعل مفاضلة الموثوقية مقابل السرعة صريحة وغير قابلة للتفاوض. فعندما تُستنفد ميزانية الأخطاء، يكون الرد الصحيح تجميد نشر الميزات الجديدة والاستثمار في الموثوقية. وهذا ليس إرشادًا — بل هو غرض ميزانيات الأخطاء. وخفض هدف الـ SLO للحصول على ميزانية أكبر تلاعب بالنظام؛ فيجب أن يعكس الـ SLO متطلبات العمل الفعلية."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مراجعة بنية الموثوقية وإطار SLO",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "عرّف ServiceSLORegistry كشيفرة لنظام دفع بأربع خدمات: payment-authorisation ‏(المستوى 0، 99.99%، p99 ‏500 مللي ثانية)، وfraud-scoring ‏(المستوى 0، 99.99%، p99 ‏50 مللي ثانية)، وaccount-enquiry ‏(المستوى 1، 99.9%، p99 ‏200 مللي ثانية)، وnotification-service ‏(المستوى 2، 99.5%، p99 ‏5000 مللي ثانية). وضمّن حساب ميزانية الأخطاء بالدقائق شهريًا لكل منها."},
    {"id": "2", "description": "ابنِ تحليل كلفة-فائدة للاستثمار في تعدد المناطق: لخدمة دفع تعالج مليون دولار/ساعة مع انقطاعين إقليميين سنويًا متوسط كل منهما ساعتان، احسب الكلفة السنوية المتوقعة للانقطاع. وبما أن كلفة تعدد المناطق 700 ألف دولار/سنة للبنية + 500 ألف دولار/سنة هندسة مستهلكة، حدد هل الاستثمار مبرر وما نسبة التوفر التي يجب أن تحققها تحسينات التوفر العالي في منطقة واحدة لتكون البديل المفضل."},
    {"id": "3", "description": "أكمل قائمة فحص مراجعة بنية الموثوقية لخدمة تكامل بوابة دفع جديدة افتراضية: وثّق كل اعتمادية خارجية ونمط فشلها، وحدد المهلة/قاطع الدائرة/الرجوع لكل منها، وعرّف الـ SLO، وحدد أي مواعيد امتثال (مواعيد قطع التسوية) تتطلب إجراءات موثوقية إضافية، واذكر ثلاثة بنود تتطلب التصعيد إلى قيادة الهندسة."},
    {"id": "4", "description": "نفّذ آلية فرض ميزانية الأخطاء: خدمة تستعلم مدة خرق الـ SLO الشهرية من Prometheus، وتقارنها بميزانية الأخطاء، وتعيد قرار DeploymentGating. وعندما تكون ميزانية الأخطاء عند 0 أو أقل، يحجب القرار عمليات النشر الجديدة. وادمج ذلك كخطاف ما قبل النشر في خط GitHub Actions أو GitLab CI."}
  ]
}
-->
