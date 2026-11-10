---
id: track-08-lesson-15
title: "Incident Management — On-Call Engineering in Finance"
slug: incident-management
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 15
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [incident-management, on-call, PagerDuty, runbook, escalation]
prerequisites: [track-08-lesson-01]
---

# Incident Management — On-Call Engineering in Finance

> [!NOTE]
> A P1 incident at a bank at 2 AM is not like a P1 incident at a tech startup. Payment processing failures have direct financial consequences for customers — funds held, payments declined, businesses unable to pay suppliers. Regulatory bodies in many jurisdictions require notification within hours for outages affecting a material number of customers. Incident management in fintech must be systematic, documented, and fast.

## Incident Severity Levels

| Level | Description | Financial Impact | Response Time | Examples |
|---|---|---|---|---|
| P1 | Complete service outage | > $10,000/min | 15 min | Payment processing down, all cards declined |
| P2 | Partial outage / major degradation | $1,000-$10,000/min | 30 min | 50% of payments failing, specific card network down |
| P3 | Degraded service | < $1,000/min | 2 hours | Elevated error rate, notifications delayed |
| P4 | Minor issue | Negligible | Next business day | Non-critical feature unavailable, cosmetic bug |

Financial impact thresholds must be agreed with business stakeholders. The thresholds above are illustrative — actual numbers depend on transaction volumes and institutional risk tolerance.

---

## 1. PagerDuty Configuration

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

---

## 2. Automated Alert Routing

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

---

## 3. Incident Response Playbook

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

---

## 4. Incident Commander vs Tech Lead Separation

For P1 incidents, two distinct roles prevent the person investigating the problem from also managing communication:

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

---

## 5. War Room Communication Structure

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

---

## 6. Regulatory Notification Requirements

In the UK, the Payment Services Regulator requires notification of major incidents within 1 business day. The European Banking Authority (EBA) requires notification of major ICT incidents within 4 hours of initial assessment. The US OCC expects prompt notification for incidents affecting national banks.

```java
@Service
public class RegulatoryIncidentNotificationService {

    private static final int EBA_NOTIFICATION_THRESHOLD_CUSTOMERS = 5_000;
    private static final Duration EBA_INITIAL_NOTIFICATION_DEADLINE =
            Duration.ofHours(4);

    private final ComplianceOfficerContactService complianceContacts;
    private final AlertService alertService;

    // Check if regulatory notification is required
    public RegulatoryNotificationDecision assess(Incident incident) {
        boolean exceedsCustomerThreshold =
                incident.getAffectedCustomers() >= EBA_NOTIFICATION_THRESHOLD_CUSTOMERS;
        boolean exceedsDurationThreshold =
                incident.getDurationMinutes() >= 60;
        boolean isPaymentSystemDown =
                incident.getAffectedService().equals("payment-core")
                && incident.getSeverity() == IncidentSeverity.P1;

        boolean notificationRequired = exceedsCustomerThreshold
                || (exceedsDurationThreshold && isPaymentSystemDown);

        if (notificationRequired) {
            Instant deadline = incident.getStartedAt()
                    .plus(EBA_INITIAL_NOTIFICATION_DEADLINE);
            return RegulatoryNotificationDecision.builder()
                    .required(true)
                    .deadline(deadline)
                    .jurisdiction("EU_EBA")
                    .contactRequired(complianceContacts.getOnDutyOfficer())
                    .build();
        }

        return RegulatoryNotificationDecision.notRequired();
    }

    // Alert compliance team when notification threshold approaching
    @Scheduled(fixedRate = 300_000)  // every 5 minutes
    public void checkActiveIncidents() {
        List<Incident> activeP1s = incidentRepo.findActiveByMinSeverity(
                IncidentSeverity.P1);

        for (Incident incident : activeP1s) {
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

---

## 7. Escalation Matrix

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
                    new EscalationStep(60, "CEO",                        "phone")   // per regulatory requirement
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

---

## 8. Incident Timeline Tracking

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

---

## 9. Post-Incident Handoff

When an incident spans multiple on-call shifts (> 12 hours for P1 incidents), a structured handoff prevents critical context loss.

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

---

## Summary

Incident management in fintech differs from general software engineering: financial impact thresholds drive severity classification, regulatory notifications may be required within hours, and the Incident Commander / Tech Lead separation is essential for managing P1s effectively. PagerDuty with structured escalation policies ensures the right people are reached within defined timeframes. Real-time timeline tracking during the incident forms the basis for the Post-Incident Review and regulatory reports. The on-call rotation must be sustainable: excessive P1 frequency causes burnout and leads to slower responses over time.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why should the Incident Commander (IC) NOT be the same person as the Tech Lead (TL) during a P1 incident?",
      "options": ["It violates regulatory separation of duties", "The IC managing communications would constantly interrupt the TL's technical investigation, slowing resolution", "One person cannot hold two roles in an on-call system", "The IC requires executive authority that engineers cannot have"],
      "correct": 1,
      "explanation": "The IC role (managing communication cadence, escalation, regulatory notifications, stakeholder updates) requires constant attention to external communication. If the same person is also debugging the technical problem, every stakeholder update interrupts the investigation. Separating the roles allows the TL to focus entirely on the technical problem while the IC ensures communication obligations are met."
    },
    {
      "text": "Under EBA ICT incident reporting guidelines, within what timeframe must an initial notification be sent to regulators for a major incident?",
      "options": ["1 hour", "4 hours", "24 hours", "36 hours"],
      "correct": 1,
      "explanation": "The EBA Guidelines on ICT Risk Management require an initial notification within 4 hours of a major ICT incident being identified. This requires automated incident duration monitoring and proactive compliance officer notification — waiting for a human to remember to check the clock is not sufficient."
    },
    {
      "text": "A P1 incident starts at 02:00 AM. What is the maximum time before the VP Engineering should be notified according to the escalation matrix in this lesson?",
      "options": ["5 minutes", "10 minutes", "20 minutes", "30 minutes"],
      "correct": 2,
      "explanation": "The escalation matrix shows: T+0 primary on-call, T+5 secondary on-call, T+10 Engineering Manager, T+20 VP Engineering. The VP is notified 20 minutes after the incident starts if unresolved, regardless of time of day."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Automated Incident Management System for Payment Infrastructure",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement an AlertRoutingService that classifies alert severity by financial impact per minute (P1 >= $10k/min, P2 >= $1k/min, P3 >= 1% error rate), creates PagerDuty incidents with routing keys by affected service, and posts structured messages to Slack war-room channels with runbook and dashboard links."},
    {"id": "2", "description": "Build a RegulatoryIncidentNotificationService that: tracks active P1 incidents, determines if EBA notification is required (> 5,000 customers OR > 60 minutes of payment-core downtime), and sends critical alerts to the compliance officer when the 4-hour notification deadline is within 60 minutes."},
    {"id": "3", "description": "Create an IncidentTimelineService that records every significant incident event (ALERT_FIRED, IC_ASSIGNED, ACTION_TAKEN, ROOT_CAUSE_IDENTIFIED, etc.) with timestamp and actor, and can produce an ordered timeline for PIR documentation."},
    {"id": "4", "description": "Implement an IncidentCommunicationService that creates a Slack war-room channel for P1 incidents, posts structured initial messages with IC/TL assignments and runbook links, formats regular status updates as 'T+N min: status, error rate, affected customers, current action, ETA', and mirrors P1 updates to a #leadership-incidents channel."}
  ]
}
-->

