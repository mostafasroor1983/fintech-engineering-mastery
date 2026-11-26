---
id: track-06-lesson-16
title: "مراجعات ما بعد الحوادث — ثقافة عدم اللوم وتحليل السبب الجذري"
slug: post-incident-review
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 16
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [post-incident, blameless, RCA, five-whys, action-items]
prerequisites: [track-06-lesson-15]
---

# مراجعات ما بعد الحوادث — ثقافة عدم اللوم وتحليل السبب الجذري

> [!NOTE]
> مراجعة ما بعد الحادث التي تبحث عن شخص تلومه تنتج نتيجة واحدة: يتعلم المهندسون ألا يرتبطوا بالإخفاقات. أما مراجعة ما بعد الحادث بلا لوم (PIR) التي تسأل "ما الذي سمح بحدوث هذا؟" فتنتج نتيجة مختلفة: تصبح الأنظمة أكثر أمانًا. والهدف استخلاص أقصى تعلم من كل حادث، لا إسناد الخطأ.

## لماذا تهم مراجعات عدم اللوم في التمويل

للمؤسسات المالية غريزة امتثال نحو المساءلة واللوم: يجب أن يكون أحد ما مسؤولًا عن كل فشل. وهذا يخلق توترًا مع تحليلات ما بعد الحوادث بلا لوم. والحل التمييز بين المساءلة (من يملك إصلاح النظام) واللوم (من يُعاقب على الفشل).

تعمل مراجعات عدم اللوم جنبًا إلى جنب مع أطر المساءلة. فالمهندس الذي أجرى التغيير الذي سبب الانقطاع لا يُلام — لكنه قد يكون مسؤولًا عن ضمان تنفيذ الإجراء التصحيحي. ويجب أن يكون هذا التمييز صريحًا في عملية المراجعة لديك.

## 1. الجدول الزمني للمراجعة

```
Incident occurs → Incident resolved → PIR scheduled within 48h
     ↓
PIR conducted within 5 business days
     ↓
PIR document published to engineering org within 24h of PIR
     ↓
Action items tracked to completion
     ↓
30-day follow-up: are action items done?
     ↓
Learnings shared in monthly reliability review
```

**متى تُعقد مراجعة:**
- كل حوادث P1
- كل حوادث P2 التي تدوم أكثر من ساعتين
- حوادث P3 التي تمس أكثر من 10,000 عميل
- الحوادث الوشيكة: حوادث اكتُشفت قبل أي أثر على العملاء
- أي حادث صاحبه إبلاغ رقابي

## 2. قالب وثيقة المراجعة

```markdown
# Post-Incident Review — [Incident ID]

**Date of Incident:** 2026-11-05
**PIR Date:** 2026-11-07
**Severity:** P1
**Duration:** 47 minutes (22:14 - 23:01 UTC)
**Incident Commander:** [Name]
**Tech Lead:** [Name]
**PIR Facilitator:** [Name — different from IC/TL]
**Attendees:** [List]

---

## Impact

- **Customer impact:** ~8,500 customers unable to process payments
- **Failed transactions:** 23,400
- **Estimated financial impact:** $340,000 in failed transaction value
- **Regulatory notification:** Yes — classified as major at 22:50; competent authority notified under DORA at 00:30 UTC (within 4 hours of classification)
- **SLO breach:** Payment success rate dropped to 61% (SLO: 99.9%)

---

## Timeline

| Time (UTC) | Event |
|---|---|
| 22:10 | Deployment of payment-service v4.2.1 to production |
| 22:14 | PagerDuty alert: payment.success_rate < 95% |
| 22:19 | On-call engineer acknowledged; investigation started |
| 22:24 | Hypothesis: connection pool exhaustion on payment DB |
| 22:31 | Deployment identified as change — rollback initiated |
| 22:38 | Rollback completed |
| 22:45 | Payment success rate recovering |
| 23:01 | Payment success rate back above 99.9% — incident resolved |

---

## Root Cause Analysis (5 Whys)

**Why** did payment success rate drop to 61%?
→ The payment service was returning 503 errors on 39% of requests.

**Why** was the payment service returning 503 errors?
→ The database connection pool was exhausted; requests were timing out waiting
  for a connection.

**Why** was the connection pool exhausted?
→ The new query introduced in v4.2.1 performed a full table scan instead of
  an index scan, taking 8-15 seconds per query instead of < 100ms.

**Why** did the new query perform a full table scan?
→ The query added a WHERE clause on `merchant_category` which is not indexed.
  The query plan was not reviewed before deployment.

**Why** was the query plan not reviewed before deployment?
→ There is no automated check for missing index usage in the CI/CD pipeline.
  Code review focused on correctness, not query plan.

**Root cause:** New query without indexed filter, combined with no automated
query plan validation in the deployment pipeline.

---

## Contributing Factors

(Contributing factors are systemic — they are not the root cause but made
the incident worse or harder to resolve)

1. **No query plan validation in CI/CD**: The pipeline runs query tests but does
   not check EXPLAIN ANALYZE output for full table scans.

2. **Connection pool too small for degraded queries**: Pool size of 20 was
   calibrated for fast queries. A slow query that holds a connection for 8-15s
   exhausts the pool under normal load.

3. **Alert threshold too low**: Alert fires at 95% success rate; by the time
   the alert fired, success rate had already dropped to 61%.

4. **Rollback took 7 minutes**: kubectl rollout undo is fast, but the deployment
   hook runs database migrations which cannot be automatically reversed.

---

## What Went Well

1. On-call engineer acknowledged within 5 minutes (SLA: 15 min)
2. Root cause identified within 17 minutes of alert
3. Rollback decision made quickly without committee approval
4. Regulatory notification sent within the DORA 4-hour deadline
5. Customer communication sent within 1 hour of resolution

---

## Action Items

| # | Action | Owner | Priority | Due Date |
|---|---|---|---|---|
| 1 | Add an EXPLAIN check (against a production-sized dataset) to CI/CD — fail the build on a sequential scan of a large table | [Name], Platform | P1 | 2026-11-14 |
| 2 | Set statement_timeout = 3s for payment-service queries (a bigger pool would only let more slow queries pile onto the database) | [Name], Payments | P1 | 2026-11-14 |
| 3 | Lower alert threshold to 99% success rate (not 95%) | [Name], Observability | P2 | 2026-11-21 |
| 4 | Add index on payments.merchant_category | [Name], Payments | P1 | 2026-11-10 |
| 5 | Add canary deployment with query performance gate | [Name], Platform | P2 | 2026-12-05 |
| 6 | Document rollback procedure for schema-coupled deployments | [Name], Payments | P3 | 2026-11-28 |

(Every action item has ONE named owner — the team is shown for context only.)
```

## 3. تحليل الأسئلة الخمسة "لماذا" — دليل التيسير

يجب تيسير تقنية الأسئلة الخمسة "لماذا" بعناية لتجنب التوقف مبكرًا عند إجابة "خطأ بشري".

```java
/*
 * FIVE WHYS FACILITATION NOTES
 *
 * Common anti-patterns to avoid:
 *
 * ANTI-PATTERN 1: Stopping at "human error"
 * Bad: "Why did the payment fail? Because the engineer deployed bad code."
 * → This stops at blame, not root cause.
 * Good: Continue asking WHY the system allowed bad code to reach production.
 *
 * ANTI-PATTERN 2: Single causal chain
 * Complex incidents have multiple contributing causes. Use a "5 Whys" tree,
 * not a linear chain. Each "Why?" may have multiple answers.
 *
 * ANTI-PATTERN 3: Solving the symptom
 * "Why did the alert not fire fast enough? → Lower alert threshold."
 * This is correct but incomplete. Also ask why the error was detectable only
 * via success rate — why was there no query plan monitoring?
 *
 * FACILITATOR TECHNIQUES:
 * - Ask "What allowed this to happen?" not "Who caused this?"
 * - For each "Why?" answer: "Is this the last answer? Can we go deeper?"
 * - Stop when further whys lead outside the team's control (e.g., cloud provider
 *   regional failure) or lead to unchangeable facts (e.g., customer behaviour)
 * - Keep whys grounded in evidence from the timeline, not speculation
 */
```

## 4. بنود إجراءات SMART

بنود الإجراءات من المراجعات معروفة بضعف تحديدها: "حسّن المراقبة" ليس قابلًا للتنفيذ. ومعايير SMART (محدد، وقابل للقياس، وقابل للإسناد، وواقعي، ومحدد زمنيًا) تضمن أن تكون البنود قابلة للتنفيذ.

```java
// SMART action item validation
public class ActionItemValidator {

    public List<String> validate(ActionItem item) {
        List<String> issues = new ArrayList<>();

        // Specific: what exactly will be done? (a rough proxy: at least 10 words)
        if (item.getDescription().trim().split("\\s+").length < 10) {
            issues.add("Description too vague — specify exactly what will be done");
        }

        // Measurable: how will we know it's done?
        if (item.getAcceptanceCriteria() == null || item.getAcceptanceCriteria().isBlank()) {
            issues.add("Missing acceptance criteria — how will we verify completion?");
        }

        // Assignable: single owner (not a team)
        if (item.getOwner() == null || item.getOwner().contains(",")) {
            issues.add("Action item must have a single named owner, not a team");
        }

        // Realistic: does the team have capacity?
        // (manual check — flag for review)

        // Time-bound: specific due date, not "ASAP"
        if (item.getDueDate() == null) {
            issues.add("Missing due date — 'ASAP' is not acceptable");
        }
        if (item.getDueDate() != null
                && item.getDueDate().isAfter(LocalDate.now().plusMonths(3))) {
            issues.add("Due date > 3 months away may indicate low priority — reconsider");
        }

        return issues;
    }
}

// Example: bad vs good action items
/*
 * BAD: "Improve monitoring" — owner: team, due: ASAP
 * GOOD: "Add Grafana alert for database query duration p99 > 5s, targeting
 *        all payment-service query endpoints" — owner: Alice, due: 2026-11-21
 *        Acceptance: Alert fires in staging test with synthetic slow query.
 *
 * BAD: "Fix deployment process" — owner: DevOps, due: Q1
 * GOOD: "Add EXPLAIN ANALYZE gate in CI/CD pipeline that fails the build if
 *        any new query has estimated cost > 100,000" — owner: Bob, due: 2026-11-14
 *        Acceptance: PR with intentional full table scan fails build in test.
 */
```

## 5. تتبع بنود الإجراءات حتى الاكتمال

```java
@Entity
@Table(name = "pir_action_items")
public class PIRActionItem {

    @Id private String actionId;
    @Column(name = "incident_id")   private String incidentId;
    @Column(name = "description")   private String description;
    @Column(name = "owner_id")      private String ownerId;
    @Column(name = "priority")      @Enumerated(EnumType.STRING) private Priority priority;
    @Column(name = "due_date")      private LocalDate dueDate;
    @Column(name = "status")        @Enumerated(EnumType.STRING) private ActionItemStatus status;
    @Column(name = "acceptance_criteria") private String acceptanceCriteria;
    @Column(name = "completed_at")  private LocalDate completedAt;
    @Column(name = "jira_ticket")   private String jiraTicket;
    // No stored "is_overdue" flag: a flag computed in @PreUpdate is only
    // refreshed when the row is updated — an item nobody touches would never
    // become overdue. Overdue is a QUERY: status != COMPLETED AND due_date < today.
    public boolean isOverdue(LocalDate today) {
        return status != ActionItemStatus.COMPLETED && dueDate != null && today.isAfter(dueDate);
    }
}

@Component
public class ActionItemTracker {

    private final PIRActionItemRepository actionItemRepo;
    private final AlertService alertService;

    // Spring cron has SIX fields (seconds first): 09:00 every Monday
    @Scheduled(cron = "0 0 9 * * MON", zone = "Europe/London")
    public void reportOverdueItems() {
        List<PIRActionItem> overdue = actionItemRepo
                .findByStatusNotAndDueDateBefore(ActionItemStatus.COMPLETED, LocalDate.now());

        if (overdue.isEmpty()) return;

        // Weekly report to engineering leadership
        String report = overdue.stream()
                .map(item -> String.format("- [%s] %s (owner: %s, due: %s, overdue: %d days)",
                        item.getPriority(),
                        item.getDescription(),
                        item.getOwnerId(),
                        item.getDueDate(),
                        ChronoUnit.DAYS.between(item.getDueDate(), LocalDate.now())))
                .collect(Collectors.joining("\n"));

        alertService.warning("PIR_ACTION_ITEMS_OVERDUE",
                overdue.size() + " PIR action items are overdue:\n" + report);

        // P1 action items overdue is especially serious
        long overdueP1 = overdue.stream()
                .filter(i -> i.getPriority() == Priority.P1)
                .count();
        if (overdueP1 > 0) {
            alertService.critical("PIR_P1_ACTION_ITEMS_OVERDUE",
                    overdueP1 + " P1 PIR action items are overdue. " +
                    "These address root causes of production incidents.");
        }
    }
}
```

## 6. مشاركة الدروس عبر الفرق

```java
/*
 * Monthly Reliability Review agenda:
 *
 * 1. Incident Statistics (10 min)
 *    - P1/P2 count vs last month
 *    - MTTR trend
 *    - SLO breach rate
 *
 * 2. PIR Highlights (20 min)
 *    - 2-3 key learnings from the month's PIRs
 *    - Focus on systemic patterns, not individual incidents
 *    - "Three incidents this month involved missing database indexes..."
 *
 * 3. Action Item Review (15 min)
 *    - Completed items celebrated
 *    - Overdue items discussed — root cause of overdue, not blame
 *
 * 4. Reliability Improvement Initiatives (15 min)
 *    - Progress on systemic improvements
 *    - New initiatives proposed from PIR patterns
 *
 * Publish: written summary to all engineers within 24h
 * Mandatory audience: all senior/staff/principal engineers
 * Optional: open to all engineers
 */
```

## 7. الأمان النفسي في المراجعات

```java
/*
 * PIR Facilitation Guidelines for Psychological Safety:
 *
 * BEFORE THE PIR:
 * - Circulate the timeline draft 24h in advance
 * - Invite attendees to add timeline events they observed
 * - Set expectations: "This PIR will not result in performance action"
 *
 * DURING THE PIR:
 * - Use specific behaviour/event language, not character judgements
 *   Bad: "The engineer was careless"
 *   Good: "The deployment proceeded without query plan review"
 *
 * - Acknowledge cognitive limits (humans make errors under pressure)
 *   "With the monitoring available at the time, the initial hypothesis
 *   was reasonable."
 *
 * - Redirect blame if it emerges
 *   "Let's focus on what the system could do differently. What would have
 *   caught this before it reached production?"
 *
 * - Invite quiet attendees
 *   "Sarah, you were on-call when this started — what was your mental
 *   model at the time?"
 *
 * SIGNALS THAT PSYCHOLOGICAL SAFETY IS LACKING:
 * - Attendees are quiet; no one volunteers information
 * - Root cause analysis stops at "human error"
 * - Action items all involve process around the person who made the change
 * - Engineers decline to present their own incidents in team forums
 */
```

## 8. المتطلبات الرقابية للمراجعات

```java
/*
 * Financial institution PIR requirements by regulatory body:
 *
 * EU — DORA (applies since January 2025; Article 13 "learning and evolving"):
 * - Post-incident reviews after significant ICT-related disruptions
 * - Root causes identified, and lessons fed back into the ICT risk framework
 * - Results available to the competent authority on request
 * (The earlier EBA Guidelines on ICT risk, EBA/GL/2019/04, had similar
 *  requirements; for firms in DORA's scope, DORA now applies.)
 *
 * UK FCA/PRA: Operational Resilience (FCA PS21/3, PRA SS1/21):
 * - Lessons learned from incidents affecting important business services
 * - Must feed into annual operational resilience assessment
 *
 * US OCC: Bank Technology Risk Management:
 * - Board reporting for significant technology incidents
 * - Root cause analysis required for safety-and-soundness examination
 *
 * PRACTICAL IMPLICATION:
 * - PIR documents are discoverable in regulatory examinations
 * - Write them professionally — not as internal venting documents
 * - The identified corrective actions should be completed; examiners check
 * - Blameless language is important from a legal liability perspective
 */
```

## 9. قياس فعالية المراجعات

```java
@Service
public class PIREffectivenessMetrics {

    private final PIRRepository pirRepo;
    private final PIRActionItemRepository actionItemRepo;
    private final IncidentRepository incidentRepo;

    public PIREffectivenessReport generate(YearMonth period) {
        // PIR completion rate: % of qualifying incidents with PIR completed
        List<Incident> qualifyingIncidents = incidentRepo
                .findQualifyingForPIR(period);
        List<PIR> completedPIRs = pirRepo.findByPeriod(period);
        double completionRate = qualifyingIncidents.isEmpty() ? 1.0
                : (double) completedPIRs.size() / qualifyingIncidents.size();

        // Action item completion rate
        List<PIRActionItem> actionItems = actionItemRepo.findByPeriod(period);
        long completed = actionItems.stream()
                .filter(i -> i.getStatus() == ActionItemStatus.COMPLETED)
                .count();
        double actionCompletionRate = actionItems.isEmpty() ? 1.0
                : (double) completed / actionItems.size();

        // Recurrence rate: same root cause in multiple incidents
        Map<String, Long> rootCauseCounts = completedPIRs.stream()
                .flatMap(pir -> pir.getRootCauses().stream())
                .collect(Collectors.groupingBy(rc -> rc, Collectors.counting()));
        long recurrentRootCauses = rootCauseCounts.values().stream()
                .filter(count -> count > 1).count();

        return PIREffectivenessReport.builder()
                .period(period)
                .pirCompletionRate(completionRate)
                .actionItemCompletionRate(actionCompletionRate)
                .recurrentRootCauses(recurrentRootCauses)
                .totalIncidents(qualifyingIncidents.size())
                .build();
    }
}
```

## الخلاصة

تنتج مراجعات عدم اللوم نتائج أفضل من مراجعات اللوم لأن المهندسين يشاركون معلومات أكثر وتُحدد إصلاحات منهجية بدل إسناد عقوبات فردية. وتقنية الأسئلة الخمسة "لماذا"، إذا يُسّرت بشكل صحيح، تكشف العوامل المنهجية المساهمة بدل التوقف عند الخطأ البشري. وبنود إجراءات SMART بمالكين مسمّين ومواعيد ومعايير قبول هي الفرق بين مراجعات تغيّر الأنظمة ومراجعات تنتج وثائق فقط. وفي المؤسسات المالية، وثائق المراجعة دليل رقابي — فاكتبها باحترافية وتأكد من إكمال الإجراءات المحددة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا تُعد إجابة 'خطأ بشري' نمطًا مضادًا في تقنية الأسئلة الخمسة 'لماذا'؟",
      "options": ["لا يخطئ البشر أبدًا في الأنظمة جيدة التصميم", "لأنها توقف التحليل مبكرًا وتمنع تحديد الظروف المنهجية التي سمحت للخطأ بالتسبب في حادث", "لأن الجهات الرقابية لا تقبل الخطأ البشري كسبب جذري", "لأنها تنتهك مبادئ مراجعة عدم اللوم بتسمية أفراد"],
      "correct": 1,
      "explanation": "التوقف عند 'الخطأ البشري' كسبب جذري يعني أن النظام يبقى دون تغيير — وسيرتكب البشر النوع نفسه من الخطأ مجددًا. والرد الصحيح مواصلة السؤال عن سبب سماح النظام للخطأ البشري بالوصول إلى الإنتاج أو التسبب في أثر على العملاء. فالهدف تغييرات منهجية (فحوص آلية، وأدوات أفضل، وعمليات أوضح) لا تغييرات سلوكية في الأفراد."
    },
    {
      "text": "يقول بند إجراء من مراجعة 'حسّن المراقبة'. ما الخطأ في هذا البند؟",
      "options": ["إنه تقني جدًا لوثيقة مراجعة", "يفتقر إلى التحديد، ومالك واحد مسمّى، ومعيار قبول قابل للقياس، وموعد — فيفشل في كل معايير SMART", "يجب إسناده إلى الفريق لا إلى فرد", "تحسينات المراقبة يجب ألا تأتي من المراجعات"],
      "correct": 1,
      "explanation": "تتطلب بنود إجراءات SMART: محددة (ما بالضبط)، وقابلة للقياس (معايير القبول)، وقابلة للإسناد (مالك واحد مسمّى)، وواقعية، ومحددة زمنيًا (موعد محدد). و'حسّن المراقبة' غامض بشأن ما يُحسّن، ولا طريقة لمعرفة متى ينتهي، ولا مالك، ولا موعد. والبند الصحيح سيكون: 'أضف تنبيه Grafana لمدة استعلام قاعدة البيانات p99 > 5 ثوانٍ — المالك: Alice — الموعد: 2026-11-21 — القبول: ينطلق في بيئة التجهيز مع استعلام بطيء اصطناعي'."
    },
    {
      "text": "لماذا تُعد وثائق المراجعة مهمة بشكل خاص من منظور الامتثال الرقابي في الخدمات المالية؟",
      "options": ["لأنها يجب أن تُنشر علنًا بموجب GDPR", "لأنها قابلة للطلب في الفحوص الرقابية ويتحقق الفاحصون من إكمال الإجراءات التصحيحية المحددة فعلًا", "لأنها يجب أن يوافق عليها المجلس قبل النشر", "لأنها تغني عن الإبلاغ الرقابي عن الحوادث"],
      "correct": 1,
      "explanation": "يستطيع المشرفون الماليون (السلطات المختصة في الاتحاد الأوروبي بموجب DORA، وFCA/PRA، وOCC) طلب وثائق المراجعة أثناء الفحوص والتدقيقات. ولا يتحققون فقط من كتابة المراجعات، بل من إكمال بنود الإجراءات المحددة ضمن المواعيد المعلنة. وقد يصبح بند إجراء غير مكتمل في حد ذاته ملاحظة إشرافية. وهذا يجعل تتبع بنود الإجراءات وإكمالها التزام امتثال، لا مجرد ممارسة هندسية جيدة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "نظام مراجعات بلا لوم مع تتبع بنود الإجراءات",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "صمم هيكل وثيقة مراجعة لحادث استنفاد مجمع اتصالات قاعدة البيانات: اكتب تحليلًا كاملًا للأسئلة الخمسة 'لماذا' (5 مستويات على الأقل)، وحدد 4 عوامل مساهمة على الأقل غير السبب الجذري، وتأكد ألا تتوقف أي إجابة عند 'خطأ بشري'."},
    {"id": "2", "description": "نفّذ ActionItemValidator يفرض معايير SMART: يجب أن يكون الوصف محددًا بـ 10 كلمات على الأقل، ومعايير القبول مطلوبة، والمالك يجب أن يكون شخصًا واحدًا مسمّى (لا فريقًا)، والموعد مطلوب وضمن 3 أشهر، ويعيد قائمة بإخفاقات التحقق."},
    {"id": "3", "description": "ابنِ كيان JPA باسم PIRActionItem وActionItemTracker بـ @Scheduled(cron = \"0 0 9 * * MON\") يستعلم البنود المتأخرة (الحالة ليست COMPLETED والموعد قبل اليوم — يحسبها الاستعلام لا علَم مخزن)، ويولّد تقريرًا أسبوعيًا يُظهر وصف البند والمالك والموعد وأيام التأخر، ويرسل تنبيهات حرجة لبنود P1 المتأخرة."},
    {"id": "4", "description": "أنشئ خدمة PIREffectivenessMetrics تولّد تقريرًا شهريًا يتضمن: نسبة إكمال المراجعات (الحوادث المؤهلة ذات المراجعة / إجمالي المؤهلة)، ونسبة إكمال بنود الإجراءات، وكشف الأسباب الجذرية المتكررة (الفئة نفسها في عدة مراجعات). وانشرها كمقاييس gauge في Prometheus للتتبع عبر الزمن."}
  ]
}
-->
