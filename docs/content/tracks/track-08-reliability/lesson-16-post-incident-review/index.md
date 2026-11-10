---
id: track-08-lesson-16
title: "Post-Incident Reviews — Blameless Culture and RCA"
slug: post-incident-review
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 16
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [post-incident, blameless, RCA, five-whys, action-items]
prerequisites: [track-08-lesson-15]
---

# Post-Incident Reviews — Blameless Culture and RCA

> [!NOTE]
> A post-incident review that finds a person to blame produces one outcome: engineers learn not to be associated with failures. A blameless PIR that asks "what allowed this to happen?" produces a different outcome: systems get safer. The goal is to extract maximum learning from every incident, not to assign fault.

## Why Blameless PIRs Matter in Finance

Financial institutions have a compliance instinct toward accountability and blame: someone must be responsible for every failure. This creates a tension with blameless post-mortems. The resolution is distinguishing between accountability (who owns fixing the system) and blame (who is punished for the failure).

Blameless PIRs work alongside accountability frameworks. The engineer who made the change that caused the outage is not blamed — but they may be accountable for ensuring the corrective action is implemented. This distinction must be explicit in your PIR process.

---

## 1. The PIR Timeline

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

**When to hold a PIR:**
- All P1 incidents
- All P2 incidents lasting > 2 hours
- P3 incidents with > 10,000 customers affected
- Near-misses: incidents that were caught before customer impact
- Any incident with regulatory notification

---

## 2. PIR Document Template

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
- **Regulatory notification:** Yes — EBA notified at 00:30 UTC (within 4h SLA)
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
4. Regulatory notification sent within 4-hour EBA deadline
5. Customer communication sent within 1 hour of resolution

---

## Action Items

| # | Action | Owner | Priority | Due Date |
|---|---|---|---|---|
| 1 | Add EXPLAIN ANALYZE check to CI/CD — fail build on full table scan | Platform Team | P1 | 2026-11-14 |
| 2 | Increase connection pool to 50 with slow query timeout of 3s | Payments Team | P1 | 2026-11-14 |
| 3 | Lower alert threshold to 99% success rate (not 95%) | Observability Team | P2 | 2026-11-21 |
| 4 | Add index on payments.merchant_category | Payments Team | P1 | 2026-11-10 |
| 5 | Add canary deployment with query performance gate | Platform Team | P2 | 2026-12-05 |
| 6 | Document rollback procedure for schema-coupled deployments | Payments Team | P3 | 2026-11-28 |
```

---

## 3. Five Whys Analysis — Facilitation Guide

The Five Whys technique must be facilitated carefully to avoid stopping prematurely at a "human error" answer.

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

---

## 4. SMART Action Items

Action items from PIRs are notoriously poorly-specified: "improve monitoring" is not actionable. SMART criteria ensure action items are implementable.

```java
// SMART action item validation
public class ActionItemValidator {

    public List<String> validate(ActionItem item) {
        List<String> issues = new ArrayList<>();

        // Specific: what exactly will be done?
        if (item.getDescription().split(" ").length < 5) {
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

---

## 5. Tracking Action Items to Completion

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
    @Column(name = "is_overdue")    private boolean isOverdue;

    @PreUpdate
    public void checkOverdue() {
        this.isOverdue = status != ActionItemStatus.COMPLETED
                && dueDate != null
                && LocalDate.now().isAfter(dueDate);
    }
}

@Component
public class ActionItemTracker {

    private final PIRActionItemRepository actionItemRepo;
    private final AlertService alertService;

    @Scheduled(cron = "0 9 * * MON")  // Monday mornings
    public void reportOverdueItems() {
        List<PIRActionItem> overdue = actionItemRepo
                .findByIsOverdueTrueAndStatusNot(ActionItemStatus.COMPLETED);

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

---

## 6. Sharing Learnings Across Teams

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

---

## 7. Psychological Safety in PIRs

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

---

## 8. Regulatory PIR Requirements

```java
/*
 * Financial institution PIR requirements by regulatory body:
 *
 * EBA Guidelines on ICT Risk Management (EBA/GL/2019/04):
 * - Major ICT-related incidents: post-incident analysis required
 * - Root cause and impact must be documented
 * - Lessons learned must feed back into risk assessment
 * - Report available to supervisor on request
 *
 * UK FCA: Operational Resilience (PS21/3):
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

---

## 9. Measuring PIR Effectiveness

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
        double completionRate = (double) completedPIRs.size()
                / qualifyingIncidents.size();

        // Action item completion rate
        List<PIRActionItem> actionItems = actionItemRepo.findByPeriod(period);
        long completed = actionItems.stream()
                .filter(i -> i.getStatus() == ActionItemStatus.COMPLETED)
                .count();
        double actionCompletionRate = (double) completed / actionItems.size();

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

---

## Summary

Blameless PIRs produce better outcomes than blame-based reviews because engineers share more information and systemic fixes are identified rather than individual punishments assigned. The Five Whys technique, properly facilitated, uncovers systemic contributing factors rather than stopping at human error. SMART action items with named owners, due dates, and acceptance criteria are the difference between PIRs that change systems and PIRs that produce documents. In financial institutions, PIR documentation is regulatory evidence — write it professionally and ensure identified actions are completed.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why is 'human error' an anti-pattern answer in the Five Whys technique?",
      "options": ["Humans never make errors in well-designed systems", "It stops the analysis prematurely and prevents identifying the systemic conditions that allowed the error to cause an incident", "Regulatory bodies do not accept human error as a root cause", "It violates blameless PIR principles by naming individuals"],
      "correct": 1,
      "explanation": "Stopping at 'human error' as a root cause means the system remains unchanged — humans will make the same type of error again. The correct response is to continue asking why the system allowed the human error to reach production or to cause customer impact. The goal is systemic changes (automated checks, better tooling, clearer processes) not behavioral changes in individuals."
    },
    {
      "text": "An action item from a PIR reads 'Improve monitoring.' What is wrong with this action item?",
      "options": ["It is too technical for a PIR document", "It lacks specificity, a named single owner, a measurable acceptance criterion, and a due date — it fails all SMART criteria", "It should be assigned to the team, not an individual", "Monitoring improvements should not come from PIRs"],
      "correct": 1,
      "explanation": "SMART action items require: Specific (what exactly), Measurable (acceptance criteria), Assignable (single named owner), Realistic, and Time-bound (specific due date). 'Improve monitoring' is vague about what to improve, has no way to know when done, has no owner, and has no date. A proper action item would be: 'Add Grafana alert for database query duration p99 > 5s — owner: Alice — due: 2026-11-21 — acceptance: fires in staging with synthetic slow query.'"
    },
    {
      "text": "Why are PIR documents particularly important from a regulatory compliance perspective in financial services?",
      "options": ["They are required to be published publicly under GDPR", "They are discoverable in regulatory examinations and examiners verify that identified corrective actions were actually completed", "They must be approved by the board before publication", "They replace the need for incident notification to regulators"],
      "correct": 1,
      "explanation": "Financial regulators (EBA, FCA, OCC) can request PIR documents during examinations and audits. They verify not just that PIRs were written, but that the action items identified were completed within the stated timelines. An incomplete PIR action item is itself a regulatory finding. This makes PIR action item tracking and completion a compliance obligation, not just an engineering best practice."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Blameless PIR System with Action Item Tracking",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design a PIR document structure for a database connection pool exhaustion incident: write a complete five-whys analysis (minimum 5 levels deep), identify at least 4 contributing factors beyond the root cause, and ensure no why-answer stops at 'human error'."},
    {"id": "2", "description": "Implement an ActionItemValidator that enforces SMART criteria: description must be at least 10 words specific, acceptance criteria is required, owner must be a single named person (not a team), due date is required and within 3 months, and returns a list of validation failures."},
    {"id": "3", "description": "Build a PIRActionItem JPA entity with isOverdue computed field and an ActionItemTracker @Scheduled(cron Monday mornings) that queries overdue items, generates a weekly report showing item description, owner, due date, and days overdue, and sends critical alerts for P1 items that are overdue."},
    {"id": "4", "description": "Create a PIREffectivenessMetrics service that generates a monthly report with: PIR completion rate (qualifying incidents with PIR / total qualifying), action item completion rate, and recurrent root cause detection (same category appearing in multiple PIRs). Publish these as Prometheus gauges for trending."}
  ]
}
-->

