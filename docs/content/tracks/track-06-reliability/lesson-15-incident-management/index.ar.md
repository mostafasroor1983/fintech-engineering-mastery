---
id: track-06-lesson-15
title: "إدارة الحوادث — المناوبة الهندسية في القطاع المالي"
slug: incident-management
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 15
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [incident-management, on-call, PagerDuty, runbook, escalation]
prerequisites: [track-06-lesson-01]
---

# إدارة الحوادث — هندسة المناوبة في التمويل

> [!NOTE]
> حادث P1 في بنك الساعة الثانية فجرًا ليس كحادث P1 في شركة تقنية ناشئة. فإخفاقات معالجة الدفع لها عواقب مالية مباشرة على العملاء — أموال معلقة، ومدفوعات مرفوضة، وشركات عاجزة عن الدفع لمورديها. وتتطلب الجهات الرقابية في ولايات قضائية كثيرة الإبلاغ خلال ساعات عن الانقطاعات التي تمس عددًا جوهريًا من العملاء. فيجب أن تكون إدارة الحوادث في التقنية المالية منهجية وموثقة وسريعة.

## مستويات خطورة الحوادث

| المستوى | الوصف | الأثر المالي | زمن الاستجابة | أمثلة |
|---|---|---|---|---|
| P1 | انقطاع كامل للخدمة | > 10,000 دولار/دقيقة | 15 دقيقة | معالجة الدفع معطلة، رفض كل البطاقات |
| P2 | انقطاع جزئي / تدهور كبير | 1,000–10,000 دولار/دقيقة | 30 دقيقة | فشل 50% من المدفوعات، تعطل شبكة بطاقات محددة |
| P3 | خدمة متدهورة | < 1,000 دولار/دقيقة | ساعتان | معدل أخطاء مرتفع، تأخر الإشعارات |
| P4 | مشكلة بسيطة | ضئيل | يوم العمل التالي | ميزة غير حرجة غير متاحة، خطأ شكلي |

يجب الاتفاق على عتبات الأثر المالي مع أصحاب المصلحة في الأعمال. والعتبات أعلاه توضيحية — فالأرقام الفعلية تعتمد على أحجام المعاملات وتحمّل المؤسسة للمخاطر.

## 1. إعداد PagerDuty

```java
// Not code — but configuration documentation for the PagerDuty setup
// Included as a reference architecture
/*
 * PagerDuty Structure for Fintech Payment Systems:
 *
 * Services:
 *   - payment-core          → routes to payments-oncall
 *   - fraud-detection       → routes to ml-platform-oncall
 *   - compliance-screening  → routes to compliance-engineering-oncall
 *   - kafka-platform        → routes to platform-oncall
 *   - database-postgresql   → routes to dba-oncall
 *
 * Escalation Policy: payments-oncall
 *   Level 1: Primary on-call engineer (0-5 min)
 *   Level 2: Secondary on-call engineer (5-10 min)
 *   Level 3: Engineering Manager (10-15 min)
 *   Level 4: VP Engineering (15-20 min — P1 only)
 *
 * Notification Rules:
 *   P1: Immediate phone call + SMS + push
 *   P2: SMS + push (5 min timeout)
 *   P3: Push notification only
 *   P4: Email only
 *
 * On-call Rotation:
 *   - 7-day rotation, Monday 9 AM handoff
 *   - Minimum 48-hour recovery time between rotations
 *   - Maximum 2 consecutive weeks on primary
 */
```

## 2. التوجيه الآلي للتنبيهات

```java
@Component
public class AlertRoutingService {

    private final PagerDutyClient pagerDutyClient;
    private final SlackClient slackClient;
    private final MeterRegistry meterRegistry;

    // Route alerts based on severity and affected service
    public void raiseAlert(Alert alert) {
        IncidentSeverity severity = classifySeverity(alert);
        String pdServiceKey       = getServiceKey(alert.getAffectedService());
        String warRoom            = getWarRoomChannel(severity);

        // Create PagerDuty incident
        if (severity == IncidentSeverity.P1 || severity == IncidentSeverity.P2) {
            pagerDutyClient.createIncident(PagerDutyIncident.builder()
                    .routingKey(pdServiceKey)
                    .eventAction("trigger")
                    .dedupKey(alert.getAlertId())
                    .summary(buildSummary(alert, severity))
                    .severity(severity.getPagerDutySeverity())
                    .details(Map.of(
                            "affectedService", alert.getAffectedService(),
                            "errorRate",       alert.getErrorRate(),
                            "affectedUsers",   alert.getEstimatedAffectedUsers(),
                            "runbookUrl",      getRunbookUrl(alert.getAffectedService()),
                            "dashboardUrl",    getDashboardUrl(alert.getAffectedService())
                    ))
                    .build());
        }

        // Post to Slack war room
        slackClient.postMessage(warRoom, buildSlackMessage(alert, severity));

        meterRegistry.counter("incident.raised",
                Tags.of("severity", severity.name(),
                        "service",  alert.getAffectedService()))
                .increment();
    }

    private String buildSummary(Alert alert, IncidentSeverity severity) {
        return String.format("[%s] %s — %s: error_rate=%.1f%% affected_users=%d",
                severity.name(),
                alert.getAffectedService(),
                alert.getAlertName(),
                alert.getErrorRate() * 100,
                alert.getEstimatedAffectedUsers());
    }

    private IncidentSeverity classifySeverity(Alert alert) {
        // Financial impact-based classification
        if (alert.getEstimatedFinancialImpactPerMinute()
                .compareTo(new BigDecimal("10000")) >= 0) {
            return IncidentSeverity.P1;
        }
        if (alert.getEstimatedFinancialImpactPerMinute()
                .compareTo(new BigDecimal("1000")) >= 0) {
            return IncidentSeverity.P2;
        }
        if (alert.getErrorRate() >= 0.01) return IncidentSeverity.P3;
        return IncidentSeverity.P4;
    }
}
```

## 3. دليل الاستجابة للحوادث

```java
// Encoded as executable runbook steps
// In practice these are runbooks.md files linked from PagerDuty alerts
public class PaymentProcessingIncidentRunbook {

    /*
     * RUNBOOK: Payment Processing P1 Incident
     * =========================================
     *
     * IMMEDIATE ACTIONS (T+0 to T+15 min):
     *
     * 1. Acknowledge PagerDuty alert
     *    - Prevents escalation if you are actively working it
     *
     * 2. Join war room Slack channel #incident-payments-active
     *    - Post: "Investigating payment processing alert at {time}"
     *    - Set status: IC (Incident Commander) or TL (Tech Lead)
     *
     * 3. Check monitoring dashboard
     *    URL: https://grafana.internal/d/payments-overview
     *    Look for:
     *    - Payment success rate (SLO: > 99.9%)
     *    - API error rate (SLO: < 0.1%)
     *    - Database connection pool utilisation
     *    - Kafka consumer lag
     *    - Downstream dependency health (payment processor, compliance APIs)
     *
     * 4. Check recent deployments
     *    kubectl rollout history deployment/payment-service -n production
     *    - If deployment in last 2 hours: consider rollback
     *    - kubectl rollout undo deployment/payment-service -n production
     *
     * 5. Check Kafka consumer lag
     *    kubectl exec -n kafka kafka-0 -- kafka-consumer-groups.sh \
     *      --bootstrap-server localhost:9092 \
     *      --describe --group payment-processor
     *    - If lag > 10,000 on payment-events: consumer is behind
     *    - Scale consumer pods: kubectl scale deployment payment-processor --replicas=10
     *      (only helps up to the topic's partition count — extra consumers sit idle)
     *
     * 6. Check database
     *    patronictl list  -- check leader is healthy
     *    SELECT count(*), wait_event FROM pg_stat_activity GROUP BY wait_event;
     *    -- Look for lock waits or connection exhaustion
     *
     * AFTER STABILISATION (T+15 to T+60 min):
     *
     * 7. Communicate to stakeholders
     *    - Post update in #incident-payments-active every 15 minutes
     *    - Format: "Update [T+30]: Error rate stabilising at X%. Root cause: Y. ETA: Z."
     *    - If P1 lasting > 30 min: VP Engineering auto-notified by PagerDuty
     *
     * 8. Regulatory notification check
     *    - Incidents affecting > 5,000 customers OR > 60 minutes duration
     *      may require regulatory notification
     *    - Contact BSA/Compliance Officer on duty: {phone number}
     *    - DO NOT notify regulators without Compliance Officer approval
     *
     * RESOLUTION:
     * 9. Confirm resolution criteria met
     *    - Payment success rate back above SLO for > 10 minutes
     *    - No active Kafka consumer lag
     *    - Downstream dependencies healthy
     *    - No new error alerts firing
     *
     * 10. Post resolution message
     *     #incident-payments-active + customer communications channel
     */
}
```

## 4. الفصل بين قائد الحادث والقائد التقني

في حوادث P1، يمنع دوران متمايزان الشخص الذي يحقق في المشكلة من إدارة التواصل أيضًا:

```java
/*
 * INCIDENT COMMANDER (IC) responsibilities:
 * - Does NOT investigate the technical problem
 * - Manages communication cadence (every 15 min to stakeholders)
 * - Tracks time and severity
 * - Calls for escalation when needed
 * - Coordinates regulatory notification with Compliance
 * - Documents timeline in real-time
 * - Declares resolution when technical criteria are met
 *
 * TECH LEAD (TL) responsibilities:
 * - Owns the technical investigation
 * - Calls for additional engineering help as needed
 * - Communicates technical findings to IC (not directly to stakeholders)
 * - Implements fixes / rollbacks / mitigations
 * - Confirms resolution criteria to IC
 *
 * This separation is critical:
 * - IC keeps the channel clear for status updates
 * - TL can focus on the problem without communication interruptions
 * - IC can escalate without TL needing to context-switch
 */
```

## 5. هيكل التواصل في غرفة العمليات

```java
@Component
public class IncidentCommunicationService {

    private final SlackClient slackClient;
    private final EmailClient emailClient;
    private static final Logger log = LoggerFactory.getLogger(
            IncidentCommunicationService.class);

    // Auto-create war room channel for P1 incidents
    public void createWarRoom(Incident incident) {
        String channelName = "incident-" +
                incident.getIncidentId().toLowerCase().replace("-", "") +
                "-" + LocalDate.now();

        // Create Slack channel
        String channelId = slackClient.createChannel(channelName);

        // Post initial message
        slackClient.postMessage(channelId, buildInitialMessage(incident));

        // Add IC, TL, and stakeholders
        slackClient.inviteUsers(channelId, getInitialResponders(incident));

        // Bridge to management channels for P1
        if (incident.getSeverity() == IncidentSeverity.P1) {
            slackClient.postToChannel("#leadership-incidents",
                    buildLeadershipUpdate(incident));
        }

        incident.setWarRoomChannelId(channelId);
    }

    // Post regular update to war room
    public void postUpdate(String channelId, IncidentUpdate update) {
        String message = String.format(
                "*[T+%d min] Incident Update*\n" +
                "*Status:* %s\n" +
                "*Current error rate:* %.2f%%\n" +
                "*Affected customers:* ~%,d\n" +
                "*Current action:* %s\n" +
                "*ETA:* %s",
                update.getMinutesSinceStart(),
                update.getStatus().name(),
                update.getCurrentErrorRate() * 100,
                update.getAffectedCustomers(),
                update.getCurrentAction(),
                update.getEta() != null ? update.getEta() : "Under investigation"
        );
        slackClient.postMessage(channelId, message);
    }

    private String buildInitialMessage(Incident incident) {
        return String.format(
                ":fire: *P%d Incident Declared — %s*\n" +
                "*Service:* %s\n" +
                "*Impact:* %s\n" +
                "*Incident Commander:* <@%s>\n" +
                "*Tech Lead:* <@%s>\n" +
                "*Runbook:* %s\n" +
                "*Dashboard:* %s\n" +
                "*Started:* %s",
                incident.getSeverity().getLevel(),
                incident.getTitle(),
                incident.getAffectedService(),
                incident.getImpactDescription(),
                incident.getIncidentCommanderId(),
                incident.getTechLeadId(),
                incident.getRunbookUrl(),
                incident.getDashboardUrl(),
                incident.getStartedAt().toString()
        );
    }
}
```

## 6. متطلبات الإبلاغ الرقابي

تختلف قواعد الإبلاغ حسب الولاية القضائية — وفريق الامتثال هو من يملك الالتزامات الدقيقة:

- **الاتحاد الأوروبي — DORA** (منذ يناير 2025): يُصنّف الحادث أولًا وفق معايير DORA (العملاء المتأثرون، والمدة، والانتشار الجغرافي، وفقدان البيانات، والأثر الاقتصادي، والخدمات الحرجة). ولحادث **جسيم** يُستحق الإبلاغ الأولي خلال **4 ساعات من التصنيف** وفي موعد لا يتجاوز **24 ساعة من الكشف**، يليه تقرير مرحلي خلال 72 ساعة وتقرير نهائي خلال شهر.
- **المملكة المتحدة**: يجب على مزودي خدمات الدفع إبلاغ FCA بالحوادث التشغيلية أو الأمنية الجسيمة دون تأخير غير مبرر، ويجب على الشركات إبلاغ FCA/PRA فورًا بأي شيء يتوقعان بشكل معقول أن يُبلّغا به (المبدأ 11، وSUP 15).
- **الولايات المتحدة**: يجب على البنوك إبلاغ جهتها الرقابية الفيدرالية الأساسية خلال **36 ساعة** من تحديد وقوع "حادث يستوجب الإبلاغ" (قاعدة OCC/Fed/FDIC لعام 2021).

تبدأ الخدمة أدناه الساعة عند **التصنيف**، لا عند بداية الانقطاع، وهي تنبّه الأشخاص — أما قرار الإبلاغ والتقرير نفسه فيبقيان لدى فريق الامتثال.

```java
@Service
public class RegulatoryIncidentNotificationService {

    // INTERNAL trigger to start a formal DORA classification — NOT the legal
    // threshold (DORA's classification criteria are broader and more detailed)
    private static final int CLASSIFICATION_REVIEW_THRESHOLD_CUSTOMERS = 5_000;
    private static final Duration DORA_AFTER_CLASSIFICATION = Duration.ofHours(4);
    private static final Duration DORA_AFTER_DETECTION      = Duration.ofHours(24);

    private final ComplianceOfficerContactService complianceContacts;
    private final AlertService alertService;
    private final IncidentRepository incidentRepo;

    // Should Compliance classify this incident now?
    public boolean needsClassificationReview(Incident incident) {
        boolean exceedsCustomerThreshold =
                incident.getAffectedCustomers() >= CLASSIFICATION_REVIEW_THRESHOLD_CUSTOMERS;
        boolean exceedsDurationThreshold =
                incident.getDurationMinutes() >= 60;
        boolean isPaymentSystemDown =
                incident.getAffectedService().equals("payment-core")
                && incident.getSeverity() == IncidentSeverity.P1;
        return exceedsCustomerThreshold || (exceedsDurationThreshold && isPaymentSystemDown);
    }

    // Once Compliance has classified the incident as MAJOR: the deadline
    public RegulatoryNotificationDecision assess(Incident incident) {
        if (incident.getClassifiedMajorAt() == null) {
            return RegulatoryNotificationDecision.notRequired();
        }
        Instant byClassification = incident.getClassifiedMajorAt().plus(DORA_AFTER_CLASSIFICATION);
        Instant byDetection      = incident.getDetectedAt().plus(DORA_AFTER_DETECTION);
        Instant deadline = byClassification.isBefore(byDetection) ? byClassification : byDetection;
        return RegulatoryNotificationDecision.builder()
                .required(true)
                .deadline(deadline)
                .jurisdiction("EU_DORA")
                .contactRequired(complianceContacts.getOnDutyOfficer())
                .build();
    }

    // Alert compliance team: classification needed, or a deadline approaching
    @Scheduled(fixedRate = 300_000)  // every 5 minutes
    public void checkActiveIncidents() {
        List<Incident> activeP1s = incidentRepo.findActiveByMinSeverity(
                IncidentSeverity.P1);

        for (Incident incident : activeP1s) {
            if (incident.getClassifiedMajorAt() == null
                    && needsClassificationReview(incident)
                    && !incident.isClassificationRequested()) {
                alertService.critical("REGULATORY_CLASSIFICATION_NEEDED",
                        "Incident " + incident.getIncidentId()
                        + " needs DORA major-incident classification by Compliance now.");
                incident.setClassificationRequested(true);
                incidentRepo.save(incident);
            }

            RegulatoryNotificationDecision decision = assess(incident);
            if (decision.isRequired() && !incident.isRegulatoryNotified()) {
                long minutesToDeadline = Duration.between(
                        Instant.now(), decision.getDeadline()).toMinutes();

                if (minutesToDeadline <= 60) {
                    alertService.critical("REGULATORY_NOTIFICATION_DUE",
                            String.format("Regulatory notification required within %d min " +
                                    "for incident %s. Contact Compliance Officer.",
                                    minutesToDeadline, incident.getIncidentId()));
                }
            }
        }
    }
}
```

## 7. مصفوفة التصعيد

```java
public class EscalationMatrix {

    // Escalation paths for unresolved incidents
    static final Map<IncidentSeverity, List<EscalationStep>> MATRIX = Map.of(
            IncidentSeverity.P1, List.of(
                    new EscalationStep(0,  "Primary on-call engineer",    "phone + sms"),
                    new EscalationStep(5,  "Secondary on-call engineer",  "phone + sms"),
                    new EscalationStep(10, "Engineering Manager",         "phone + sms"),
                    new EscalationStep(20, "VP Engineering",              "phone + sms"),
                    new EscalationStep(30, "CTO",                        "phone"),
                    new EscalationStep(45, "Compliance Officer",          "phone"),  // regulatory risk
                    new EscalationStep(60, "CEO",                        "phone")   // per internal policy
            ),
            IncidentSeverity.P2, List.of(
                    new EscalationStep(0,  "Primary on-call engineer",    "phone + sms"),
                    new EscalationStep(15, "Secondary on-call engineer",  "sms"),
                    new EscalationStep(30, "Engineering Manager",         "sms")
            ),
            IncidentSeverity.P3, List.of(
                    new EscalationStep(0,  "Primary on-call engineer",    "push notification")
            )
    );
}
```

## 8. تتبع الجدول الزمني للحادث

```java
@Service
public class IncidentTimelineService {

    private final IncidentRepository incidentRepo;
    private final IncidentEventRepository eventRepo;

    // Track every significant action during an incident
    public void recordEvent(String incidentId, IncidentEventType type,
                             String actorId, String description) {
        IncidentEvent event = IncidentEvent.builder()
                .incidentId(incidentId)
                .eventType(type)
                .actorId(actorId)
                .description(description)
                .occurredAt(Instant.now())
                .build();
        eventRepo.save(event);
    }

    // Build timeline for PIR
    public List<IncidentEvent> buildTimeline(String incidentId) {
        return eventRepo.findByIncidentIdOrderByOccurredAt(incidentId);
    }
}

// Typical incident event types
public enum IncidentEventType {
    ALERT_FIRED,
    ONCALL_ALERTED,
    INCIDENT_DECLARED,
    IC_ASSIGNED,
    TL_ASSIGNED,
    WAR_ROOM_CREATED,
    INVESTIGATION_STARTED,
    HYPOTHESIS_FORMED,
    ACTION_TAKEN,            // e.g., rollback initiated
    MITIGATION_APPLIED,      // partial fix reduces impact
    STAKEHOLDER_UPDATE_SENT,
    REGULATORY_NOTIFICATION_SENT,
    ESCALATION_TRIGGERED,
    ROOT_CAUSE_IDENTIFIED,
    FIX_DEPLOYED,
    RESOLUTION_CRITERIA_MET,
    INCIDENT_RESOLVED,
    PIR_SCHEDULED
}
```

## 9. التسليم بعد الحادث

عندما يمتد حادث عبر عدة مناوبات (أكثر من 12 ساعة لحوادث P1)، يمنع التسليم المنظم فقدان السياق الحرج.

```java
// Handoff template — not code, but required process documentation
/*
 * ON-CALL HANDOFF TEMPLATE (P1 Incident)
 * ========================================
 *
 * Incident: [incidentId]
 * Duration so far: [X hours]
 * Current status: [ACTIVE / MONITORING / NEAR RESOLUTION]
 *
 * CURRENT STATE:
 * - What is broken: [describe]
 * - Current error rate: [X%]
 * - Affected customers: [estimate]
 *
 * WHAT WE KNOW:
 * - Root cause (if identified): [describe]
 * - Contributing factors: [list]
 * - What we have ruled out: [list]
 *
 * WHAT HAS BEEN DONE:
 * - [timestamp] [action taken] [result]
 * - [timestamp] [action taken] [result]
 *
 * WHAT IS IN PROGRESS:
 * - [action] expected completion [time]
 *
 * WHAT NEEDS TO HAPPEN NEXT:
 * - Immediate: [list]
 * - If this hypothesis is wrong: [fallback plan]
 *
 * KEY CONTACTS:
 * - Compliance Officer: [name, phone]
 * - Payment Processor DRI: [name, phone]
 * - Database DRI: [name, phone]
 *
 * OPEN QUESTIONS:
 * - [question 1]
 * - [question 2]
 */
```

## الخلاصة

تختلف إدارة الحوادث في التقنية المالية عن هندسة البرمجيات العامة: فعتبات الأثر المالي تقود تصنيف الخطورة، وقد يلزم الإبلاغ الرقابي خلال ساعات، والفصل بين قائد الحادث والقائد التقني أساسي لإدارة حوادث P1 بفعالية. ويضمن PagerDuty بسياسات تصعيد منظمة الوصول إلى الأشخاص المناسبين ضمن أطر زمنية محددة. ويشكّل تتبع الجدول الزمني لحظيًا أثناء الحادث أساس مراجعة ما بعد الحادث والتقارير الرقابية. ويجب أن تكون دورة المناوبة مستدامة: فكثرة حوادث P1 تسبب الإنهاك وتؤدي إلى استجابات أبطأ مع الوقت.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا يجب ألا يكون قائد الحادث (IC) هو نفسه القائد التقني (TL) أثناء حادث P1؟",
      "options": ["لأنه ينتهك الفصل الرقابي بين المهام", "لأن قائد الحادث الذي يدير التواصل سيقاطع باستمرار تحقيق القائد التقني، فيُبطئ الحل", "لأن شخصًا واحدًا لا يستطيع شغل دورين في نظام مناوبة", "لأن قائد الحادث يحتاج سلطة تنفيذية لا يملكها المهندسون"],
      "correct": 1,
      "explanation": "يتطلب دور قائد الحادث (إدارة وتيرة التواصل، والتصعيد، والإبلاغ الرقابي، وتحديثات أصحاب المصلحة) انتباهًا مستمرًا للتواصل الخارجي. فإذا كان الشخص نفسه يصحح المشكلة التقنية، يقاطع كل تحديث لأصحاب المصلحة التحقيق. والفصل بين الدورين يتيح للقائد التقني التركيز كليًا على المشكلة التقنية بينما يضمن قائد الحادث الوفاء بالتزامات التواصل."
    },
    {
      "text": "بموجب قواعد الإبلاغ عن الحوادث في DORA بالاتحاد الأوروبي، خلال أي إطار زمني يجب إرسال الإبلاغ الأولي إلى السلطة المختصة بعد تصنيف حادث كجسيم؟",
      "options": ["ساعة واحدة", "4 ساعات", "24 ساعة", "36 ساعة"],
      "correct": 1,
      "explanation": "بموجب DORA (المطبّق منذ يناير 2025)، يُستحق الإبلاغ الأولي خلال 4 ساعات من تصنيف الحادث كجسيم، وفي موعد لا يتجاوز 24 ساعة من كشف المؤسسة له؛ ويلي ذلك تقرير مرحلي خلال 72 ساعة وتقرير نهائي خلال شهر. ولأن الساعة تبدأ عند التصنيف، يجب أن تدفع أدوات الحوادث فريق الامتثال إلى التصنيف بسرعة — وأن تتتبع المواعيد تلقائيًا بدل الاعتماد على تذكّر أحدهم لمراجعة الساعة."
    },
    {
      "text": "يبدأ حادث P1 الساعة 02:00 فجرًا. ما أقصى وقت قبل إبلاغ نائب رئيس الهندسة وفق مصفوفة التصعيد في هذا الدرس؟",
      "options": ["5 دقائق", "10 دقائق", "20 دقيقة", "30 دقيقة"],
      "correct": 2,
      "explanation": "تُظهر مصفوفة التصعيد: T+0 المناوب الأساسي، وT+5 المناوب الثانوي، وT+10 مدير الهندسة، وT+20 نائب رئيس الهندسة. فيُبلّغ نائب الرئيس بعد 20 دقيقة من بدء الحادث إذا لم يُحل، بغض النظر عن وقت اليوم."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "نظام آلي لإدارة الحوادث لبنية الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ AlertRoutingService يصنف خطورة التنبيهات حسب الأثر المالي في الدقيقة (P1 >= 10 آلاف دولار/دقيقة، وP2 >= ألف دولار/دقيقة، وP3 >= 1% معدل أخطاء)، وينشئ حوادث PagerDuty بمفاتيح توجيه حسب الخدمة المتأثرة، وينشر رسائل منظمة في قنوات غرف العمليات في Slack مع روابط دليل التشغيل واللوحة."},
    {"id": "2", "description": "ابنِ RegulatoryIncidentNotificationService: يتتبع حوادث P1 النشطة، ويطلب من فريق الامتثال تصنيف الحادث كجسيم وفق DORA عند استيفاء المحفزات الداخلية (أكثر من 5,000 عميل أو أكثر من 60 دقيقة من توقف payment-core)، ويحسب موعد الإبلاغ من وقت التصنيف (4 ساعات، و24 ساعة كحد أقصى بعد الكشف)، ويرسل تنبيهات حرجة إلى مسؤول الامتثال عندما يكون الموعد خلال 60 دقيقة."},
    {"id": "3", "description": "أنشئ IncidentTimelineService يسجل كل حدث مهم في الحادث (ALERT_FIRED، وIC_ASSIGNED، وACTION_TAKEN، وROOT_CAUSE_IDENTIFIED، إلخ) مع الطابع الزمني والفاعل، ويستطيع إنتاج جدول زمني مرتب لتوثيق مراجعة ما بعد الحادث."},
    {"id": "4", "description": "نفّذ IncidentCommunicationService ينشئ قناة غرفة عمليات في Slack لحوادث P1، وينشر رسائل أولية منظمة بتعيينات قائد الحادث والقائد التقني وروابط دليل التشغيل، وينسق تحديثات الحالة المنتظمة بصيغة 'T+N دقيقة: الحالة، ومعدل الأخطاء، والعملاء المتأثرون، والإجراء الحالي، والوقت المتوقع'، ويعكس تحديثات P1 إلى قناة ‎#leadership-incidents."}
  ]
}
-->
