---
id: track-07-lesson-12
title: "Alert Management — Investigation Workflow Systems"
slug: alert-management
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 12
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [alert-management, case-management, investigation, triage, workflow]
prerequisites: []
---

# Alert Management — Investigation Workflow Systems

> [!NOTE]
> AML alert management is the operational core of a compliance program. Generating alerts is easy; managing them effectively is hard. At scale, a large bank can generate hundreds of thousands of alerts per month. Without a well-designed investigation workflow, analysts are overwhelmed, false positive rates are unacceptably high, and genuine suspicious activity goes uninvestigated. The engineering challenge is building a system that surfaces the right alerts to the right analysts at the right time, with full SLA tracking and audit capability.

## The Alert Lifecycle

Every AML alert travels through a defined lifecycle:

```
GENERATED → PENDING → ASSIGNED → INVESTIGATING → DISPOSITIONED
                                                       ↓
                                              [TRUE_POSITIVE]  → SAR filing
                                              [FALSE_POSITIVE] → Close
                                              [ESCALATED]      → Senior analyst / management
                                              [STRUCTURING]    → CTR referral
                                              [CLOSED_NO_SAR]  → Document & close
```

The two most important operational metrics are:
- **Alert-to-SAR conversion rate:** what percentage of true positives result in SAR filings?
- **False positive rate:** what percentage of alerts are closed as false positives?

Industry average false positive rates run 90–95%. Improving that ratio from 95% to 90% with the same analyst headcount doubles your effective capacity.

---

## Alert Data Model

```java
package com.fintech.alerts.model;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record AmlAlert(
    UUID alertId,
    String customerId,
    String accountId,
    AlertType alertType,
    AlertSource source,              // Rule engine, ML model, CTR aggregation, etc.
    AlertSeverity severity,
    int riskScore,                   // 0–100; feeds triage prioritization
    String triggeredByTransactionId, // The transaction that triggered this alert
    List<String> relatedTransactionIds,
    String alertNarrative,           // Auto-generated description of why alert fired
    AlertStatus status,
    String assignedAnalystId,
    OffsetDateTime createdAt,
    OffsetDateTime assignedAt,
    OffsetDateTime slaDeadline,      // When this must be dispositioned
    OffsetDateTime dispositionedAt,
    AlertDisposition disposition,
    String dispositionReason,
    UUID linkedCaseId,               // If escalated to a case
    UUID linkedSarId,                // If SAR was filed
    String scenarioCode,             // Which detection scenario fired
    BigDecimal alertAmount           // Dollar amount associated with the alert
) {}

public enum AlertType {
    STRUCTURING,                // Near-threshold transaction patterns
    UNUSUAL_TRANSACTION,        // Deviation from customer behavior baseline
    HIGH_RISK_COUNTERPARTY,     // Transaction with high-risk entity
    SANCTIONS_PROXIMITY,        // Indirect link to sanctioned entity
    PEP_ACTIVITY,               // Unusual activity by politically exposed person
    VELOCITY_BREACH,            // Exceeded transaction velocity limits
    GEOGRAPHIC_ANOMALY,         // Transaction to/from high-risk jurisdiction
    DORMANT_ACCOUNT_ACTIVITY,   // Activity on previously dormant account
    ROUND_DOLLAR_PATTERN,       // Consistent round-dollar transactions
    SPLIT_TRANSACTION           // Large transaction split across multiple smaller ones
}

public enum AlertSeverity {
    LOW,     // Can wait days
    MEDIUM,  // SLA: 5 business days
    HIGH,    // SLA: 2 business days
    CRITICAL // SLA: 24 hours; potential regulatory action
}

public enum AlertStatus {
    GENERATED,     // Just created, not yet in queue
    PENDING,       // In queue, unassigned
    ASSIGNED,      // Assigned to analyst, not yet started
    INVESTIGATING, // Analyst actively working
    PENDING_INFO,  // Waiting for additional information
    DISPOSITIONED, // Final disposition reached
    ESCALATED,     // Escalated to senior analyst
    CLOSED         // Fully closed (after SAR filed or false positive documented)
}

public enum AlertDisposition {
    TRUE_POSITIVE_SAR,       // Suspicious; SAR filed
    TRUE_POSITIVE_CTR,       // Suspicious; CTR referral
    TRUE_POSITIVE_NO_SAR,    // Suspicious but insufficient for SAR (documented)
    FALSE_POSITIVE,          // Not suspicious; alert system tuning needed
    FALSE_POSITIVE_KNOWN,    // Not suspicious; known legitimate business activity
    ESCALATED_TO_SENIOR,     // Requires senior analyst or management decision
    AWAITING_DOCUMENTATION,  // Legitimate but documentation incomplete
    CLOSED_OTHER             // Other reason (fully documented)
}

public record AlertCase(
    UUID caseId,
    String customerId,
    List<UUID> alertIds,         // Multiple alerts may be consolidated into one case
    CaseType caseType,
    String analystId,
    String seniorAnalystId,      // For escalations
    OffsetDateTime openedAt,
    OffsetDateTime slaDeadline,
    CaseStatus status,
    String investigationNarrative,
    CaseDisposition disposition,
    UUID sarId
) {}

public enum CaseType {
    STRUCTURING,
    MONEY_LAUNDERING,
    FRAUD,
    TERRORIST_FINANCING,
    SANCTIONS_VIOLATION,
    GENERAL_SUSPICIOUS_ACTIVITY
}

public enum CaseStatus {
    OPEN, INVESTIGATING, PENDING_APPROVAL, CLOSED
}

public enum CaseDisposition {
    SAR_FILED,
    NO_SUSPICIOUS_ACTIVITY,
    ESCALATED_TO_LAW_ENFORCEMENT,
    ACCOUNT_CLOSED,
    RELATIONSHIP_EXITED
}
```

---

## Alert Generation Service

```java
package com.fintech.alerts.service;

import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class AlertGenerationService {

    private static final int HIGH_RISK_SCORE_THRESHOLD    = 70;
    private static final int CRITICAL_RISK_SCORE_THRESHOLD = 85;

    private final AlertRepository alertRepo;
    private final AlertNarrativeGenerator narrativeGenerator;
    private final SlaCalculator slaCalculator;
    private final AlertDuplicationChecker duplicationChecker;
    private final AlertPublisher publisher;

    /**
     * Create an AML alert from a rule engine or ML model signal.
     * Performs de-duplication before creating to avoid alert fatigue.
     */
    public AmlAlert createAlert(AlertRequest request) {
        // De-duplication: don't create a duplicate alert for the same
        // customer + scenario within the dedup window (typically 24 hours)
        if (duplicationChecker.isDuplicate(
                request.customerId(),
                request.scenarioCode(),
                request.triggeredByTransactionId())) {
            return duplicationChecker.getExistingAlert(
                request.customerId(), request.scenarioCode());
        }

        AlertSeverity severity = deriveSeverity(request.riskScore());
        OffsetDateTime slaDeadline = slaCalculator.calculateDeadline(
            OffsetDateTime.now(), severity);

        String narrative = narrativeGenerator.generate(request);

        AmlAlert alert = new AmlAlert(
            UUID.randomUUID(),
            request.customerId(),
            request.accountId(),
            request.alertType(),
            request.source(),
            severity,
            request.riskScore(),
            request.triggeredByTransactionId(),
            request.relatedTransactionIds(),
            narrative,
            AlertStatus.GENERATED,
            null,                    // Not yet assigned
            OffsetDateTime.now(),
            null,                    // assignedAt
            slaDeadline,
            null,                    // dispositionedAt
            null,                    // disposition
            null,                    // dispositionReason
            null,                    // linkedCaseId
            null,                    // linkedSarId
            request.scenarioCode(),
            request.amount()
        );

        alertRepo.save(alert);

        // Auto-route to queue based on severity
        publisher.publishToQueue(alert, determineQueue(alert));

        return alert;
    }

    /**
     * Consolidate multiple related alerts into a single case.
     * When a customer has 5+ alerts in 30 days, they should be consolidated
     * rather than worked individually.
     */
    public AlertCase consolidateAlerts(
            String customerId, List<UUID> alertIds, CaseType caseType) {

        List<AmlAlert> alerts = alertRepo.findAllById(alertIds);

        // All alerts must belong to the same customer
        boolean allSameCustomer = alerts.stream()
            .allMatch(a -> a.customerId().equals(customerId));
        if (!allSameCustomer) {
            throw new IllegalArgumentException(
                "Cannot consolidate alerts from different customers");
        }

        // Calculate case SLA based on the most severe alert
        AlertSeverity worstSeverity = alerts.stream()
            .map(AmlAlert::severity)
            .max(java.util.Comparator.naturalOrder())
            .orElse(AlertSeverity.MEDIUM);

        OffsetDateTime caseSla = slaCalculator.calculateDeadline(
            OffsetDateTime.now(), worstSeverity);

        AlertCase caseRecord = new AlertCase(
            UUID.randomUUID(),
            customerId,
            alertIds,
            caseType,
            null,  // Not yet assigned
            null,  // No senior analyst yet
            OffsetDateTime.now(),
            caseSla,
            CaseStatus.OPEN,
            "",    // Investigation narrative starts empty
            null,
            null
        );

        alertRepo.saveCase(caseRecord);

        // Update all alerts to link to this case
        alerts.forEach(a -> alertRepo.linkAlertToCase(a.alertId(), caseRecord.caseId()));

        return caseRecord;
    }

    private AlertSeverity deriveSeverity(int riskScore) {
        if (riskScore >= CRITICAL_RISK_SCORE_THRESHOLD) return AlertSeverity.CRITICAL;
        if (riskScore >= HIGH_RISK_SCORE_THRESHOLD)     return AlertSeverity.HIGH;
        if (riskScore >= 40)                             return AlertSeverity.MEDIUM;
        return AlertSeverity.LOW;
    }

    private String determineQueue(AmlAlert alert) {
        return switch (alert.severity()) {
            case CRITICAL -> "CRITICAL_ALERTS_QUEUE";
            case HIGH     -> "HIGH_PRIORITY_QUEUE";
            case MEDIUM   -> "STANDARD_QUEUE";
            case LOW      -> "LOW_PRIORITY_QUEUE";
        };
    }

    public record AlertRequest(
        String customerId,
        String accountId,
        AlertType alertType,
        AlertSource source,
        int riskScore,
        String triggeredByTransactionId,
        List<String> relatedTransactionIds,
        String scenarioCode,
        java.math.BigDecimal amount
    ) {}
}
```

---

## Alert Narrative Generator

Auto-generated narratives reduce analyst ramp-up time. A good narrative states: what happened, when, how much, why it is suspicious, and what the analyst should check first.

```java
package com.fintech.alerts.service;

import org.springframework.stereotype.Component;

import java.text.NumberFormat;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

@Component
public class AlertNarrativeGenerator {

    private static final NumberFormat CURRENCY_FORMAT =
        NumberFormat.getCurrencyInstance(Locale.US);
    private static final DateTimeFormatter DATE_FMT =
        DateTimeFormatter.ofPattern("MMMM d, yyyy");

    public String generate(AlertGenerationService.AlertRequest request) {
        return switch (request.alertType()) {
            case STRUCTURING ->
                generateStructuringNarrative(request);
            case UNUSUAL_TRANSACTION ->
                generateUnusualTransactionNarrative(request);
            case HIGH_RISK_COUNTERPARTY ->
                generateHighRiskCounterpartyNarrative(request);
            case DORMANT_ACCOUNT_ACTIVITY ->
                generateDormantAccountNarrative(request);
            case VELOCITY_BREACH ->
                generateVelocityBreachNarrative(request);
            default ->
                generateGenericNarrative(request);
        };
    }

    private String generateStructuringNarrative(AlertGenerationService.AlertRequest request) {
        return String.format(
            "STRUCTURING ALERT: Customer %s conducted %d currency transactions " +
            "totaling %s over the past 5 business days. Individual transactions ranged " +
            "from $9,000 to $9,990, each below the $10,000 CTR threshold. " +
            "This pattern is consistent with structuring under 31 U.S.C. § 5324. " +
            "Analyst should: (1) review all transactions in the 30-day lookback window, " +
            "(2) verify customer's stated business type justifies cash volume, " +
            "(3) check for similar patterns in prior periods. " +
            "Risk score: %d/100. Scenario: %s.",
            request.customerId(),
            request.relatedTransactionIds().size(),
            CURRENCY_FORMAT.format(request.amount()),
            request.riskScore(),
            request.scenarioCode()
        );
    }

    private String generateUnusualTransactionNarrative(AlertGenerationService.AlertRequest request) {
        return String.format(
            "UNUSUAL TRANSACTION ALERT: Transaction ID %s for %s on customer %s " +
            "is significantly outside this customer's established behavioral baseline. " +
            "This transaction is approximately 10x the customer's 90-day average transaction size. " +
            "Analyst should: (1) contact customer to obtain explanation, " +
            "(2) verify source of funds, " +
            "(3) review customer risk profile for recent changes. " +
            "Risk score: %d/100.",
            request.triggeredByTransactionId(),
            CURRENCY_FORMAT.format(request.amount()),
            request.customerId(),
            request.riskScore()
        );
    }

    private String generateHighRiskCounterpartyNarrative(AlertGenerationService.AlertRequest request) {
        return String.format(
            "HIGH RISK COUNTERPARTY ALERT: Customer %s initiated a transaction of %s " +
            "to a counterparty flagged as high risk (risk score 70+). " +
            "Analyst should: (1) review the counterparty's risk profile, " +
            "(2) determine the business purpose of the transaction, " +
            "(3) verify this is consistent with the customer's stated business activity. " +
            "Risk score: %d/100.",
            request.customerId(),
            CURRENCY_FORMAT.format(request.amount()),
            request.riskScore()
        );
    }

    private String generateDormantAccountNarrative(AlertGenerationService.AlertRequest request) {
        return String.format(
            "DORMANT ACCOUNT ACTIVITY ALERT: Customer %s account has been dormant for 12+ months " +
            "and now shows activity of %s. Reactivation of dormant accounts can indicate " +
            "account takeover or placement phase money laundering. " +
            "Analyst should: (1) verify account holder identity, " +
            "(2) review reason for reactivation, " +
            "(3) check for change of contact information concurrent with reactivation. " +
            "Risk score: %d/100.",
            request.customerId(),
            CURRENCY_FORMAT.format(request.amount()),
            request.riskScore()
        );
    }

    private String generateVelocityBreachNarrative(AlertGenerationService.AlertRequest request) {
        return String.format(
            "VELOCITY BREACH ALERT: Customer %s has exceeded their configured " +
            "transaction velocity limit. %d transactions in the past 24 hours, " +
            "totaling %s. Analyst should: (1) review recent transaction history, " +
            "(2) determine whether velocity limit is appropriate for this customer's profile, " +
            "(3) check for other concurrent alerts. Risk score: %d/100.",
            request.customerId(),
            request.relatedTransactionIds().size(),
            CURRENCY_FORMAT.format(request.amount()),
            request.riskScore()
        );
    }

    private String generateGenericNarrative(AlertGenerationService.AlertRequest request) {
        return String.format(
            "AML ALERT [%s]: Customer %s triggered scenario %s with risk score %d. " +
            "Transaction amount: %s. Please review the full transaction history " +
            "and assess whether this activity warrants a SAR filing.",
            request.alertType().name(),
            request.customerId(),
            request.scenarioCode(),
            request.riskScore(),
            CURRENCY_FORMAT.format(request.amount())
        );
    }
}
```

---

## SLA Calculator

```java
package com.fintech.alerts.service;

import org.springframework.stereotype.Component;

import java.time.DayOfWeek;
import java.time.OffsetDateTime;
import java.time.ZoneId;

@Component
public class SlaCalculator {

    private static final ZoneId EASTERN = ZoneId.of("America/New_York");

    // SLA in business hours (not calendar hours)
    private static final int CRITICAL_HOURS = 8;    // 1 business day
    private static final int HIGH_HOURS     = 16;   // 2 business days
    private static final int MEDIUM_HOURS   = 40;   // 5 business days
    private static final int LOW_HOURS      = 120;  // 15 business days

    public OffsetDateTime calculateDeadline(OffsetDateTime start, AlertSeverity severity) {
        int businessHours = switch (severity) {
            case CRITICAL -> CRITICAL_HOURS;
            case HIGH     -> HIGH_HOURS;
            case MEDIUM   -> MEDIUM_HOURS;
            case LOW      -> LOW_HOURS;
        };
        return addBusinessHours(start, businessHours);
    }

    /**
     * Add business hours to a timestamp, skipping weekends and outside
     * business hours (9 AM – 5 PM Eastern). Does not account for holidays —
     * production systems should integrate with a business calendar.
     */
    private OffsetDateTime addBusinessHours(OffsetDateTime start, int hoursToAdd) {
        OffsetDateTime current = start.atZoneSameInstant(EASTERN).toOffsetDateTime();
        int hoursAdded = 0;

        while (hoursAdded < hoursToAdd) {
            current = current.plusHours(1);
            if (isBusinessHour(current)) {
                hoursAdded++;
            }
        }
        return current;
    }

    private boolean isBusinessHour(OffsetDateTime dt) {
        DayOfWeek day = dt.getDayOfWeek();
        if (day == DayOfWeek.SATURDAY || day == DayOfWeek.SUNDAY) return false;
        int hour = dt.getHour();
        return hour >= 9 && hour < 17;  // 9 AM to 5 PM
    }

    public boolean isSlaBreached(AmlAlert alert) {
        return alert.slaDeadline() != null
            && OffsetDateTime.now().isAfter(alert.slaDeadline())
            && alert.status() != AlertStatus.DISPOSITIONED
            && alert.status() != AlertStatus.CLOSED;
    }

    public long minutesUntilSla(AmlAlert alert) {
        if (alert.slaDeadline() == null) return Long.MAX_VALUE;
        return java.time.Duration.between(
            OffsetDateTime.now(), alert.slaDeadline()).toMinutes();
    }
}
```

---

## Analyst Investigation Workflow

```java
package com.fintech.alerts.workflow;

import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.UUID;

@Service
public class AlertInvestigationService {

    private final AlertRepository alertRepo;
    private final CaseManagementService caseService;
    private final SarFilingService sarService;
    private final RiskScoringEngine riskScoringEngine;
    private final AuditService auditService;

    /**
     * Analyst claims an alert for investigation.
     * Uses optimistic locking to prevent two analysts from claiming the same alert.
     */
    public AmlAlert claimAlert(UUID alertId, String analystId) {
        AmlAlert alert = alertRepo.findById(alertId)
            .orElseThrow(() -> new AlertNotFoundException(alertId));

        if (alert.status() != AlertStatus.PENDING
                && alert.status() != AlertStatus.GENERATED) {
            throw new AlertNotAvailableException(
                "Alert " + alertId + " is not available for assignment (status: " +
                alert.status() + ")");
        }

        AmlAlert assigned = alert.withStatus(AlertStatus.ASSIGNED)
            .withAssignedAnalystId(analystId)
            .withAssignedAt(OffsetDateTime.now());

        alertRepo.updateWithOptimisticLock(assigned);
        auditService.log("ALERT_CLAIMED",
            "Alert " + alertId + " claimed by analyst " + analystId, analystId);

        return assigned;
    }

    /**
     * Analyst begins investigation.
     */
    public AmlAlert beginInvestigation(UUID alertId, String analystId) {
        AmlAlert alert = loadAndValidateOwnership(alertId, analystId);

        AmlAlert investigating = alert.withStatus(AlertStatus.INVESTIGATING);
        alertRepo.update(investigating);
        return investigating;
    }

    /**
     * Analyst dispositions an alert with a final decision.
     * This is the most important workflow step — all dispositions are immutable
     * and permanently logged.
     */
    public AmlAlert dispositionAlert(
            UUID alertId,
            String analystId,
            AlertDisposition disposition,
            String dispositionReason,
            String investigationNotes) {

        AmlAlert alert = loadAndValidateOwnership(alertId, analystId);

        // Some dispositions require supervisor approval
        validateDispositionAuthority(alert, disposition, analystId);

        // Validate that the reason is sufficiently detailed
        if (dispositionReason == null || dispositionReason.length() < 50) {
            throw new InsufficientDocumentationException(
                "Disposition reason must be at least 50 characters. Actual: " +
                (dispositionReason == null ? 0 : dispositionReason.length()));
        }

        AmlAlert dispositioned = alert
            .withStatus(AlertStatus.DISPOSITIONED)
            .withDisposition(disposition)
            .withDispositionReason(dispositionReason)
            .withDispositionedAt(OffsetDateTime.now());

        alertRepo.update(dispositioned);

        auditService.logAlertDisposition(dispositioned, analystId, investigationNotes);

        // Handle post-disposition actions
        handlePostDisposition(dispositioned);

        return dispositioned;
    }

    /**
     * Escalate an alert to a senior analyst.
     * Required for: large amounts, complex typologies, PEP involvement,
     * potential SAR filings above a dollar threshold.
     */
    public AmlAlert escalate(
            UUID alertId, String analystId,
            String escalationReason, String targetSeniorAnalystId) {

        AmlAlert alert = loadAndValidateOwnership(alertId, analystId);

        AmlAlert escalated = alert
            .withStatus(AlertStatus.ESCALATED)
            .withAssignedAnalystId(targetSeniorAnalystId)
            .withDispositionReason("ESCALATED: " + escalationReason);

        alertRepo.update(escalated);
        auditService.log("ALERT_ESCALATED",
            "Alert " + alertId + " escalated by " + analystId +
            " to " + targetSeniorAnalystId + ". Reason: " + escalationReason,
            analystId);

        return escalated;
    }

    private void handlePostDisposition(AmlAlert alert) {
        switch (alert.disposition()) {
            case TRUE_POSITIVE_SAR -> {
                // Create SAR filing workflow
                sarService.initiateSarFiling(alert.customerId(), alert.alertId());
            }
            case ESCALATED_TO_SENIOR -> {
                // Create case if not already in one
                if (alert.linkedCaseId() == null) {
                    caseService.createCaseFromAlert(alert);
                }
            }
            case FALSE_POSITIVE -> {
                // Log for scenario tuning — systematic false positives indicate
                // the detection rule needs calibration
                alertRepo.logFalsePositive(alert.alertId(), alert.scenarioCode());
            }
        }
    }

    private AmlAlert loadAndValidateOwnership(UUID alertId, String analystId) {
        AmlAlert alert = alertRepo.findById(alertId)
            .orElseThrow(() -> new AlertNotFoundException(alertId));

        if (!analystId.equals(alert.assignedAnalystId())) {
            throw new AlertOwnershipException(
                "Analyst " + analystId + " does not own alert " + alertId +
                " (owned by: " + alert.assignedAnalystId() + ")");
        }
        return alert;
    }

    private void validateDispositionAuthority(
            AmlAlert alert, AlertDisposition disposition, String analystId) {
        // SAR filings above $1M require senior analyst authorization
        if (disposition == AlertDisposition.TRUE_POSITIVE_SAR
                && alert.alertAmount() != null
                && alert.alertAmount().compareTo(new java.math.BigDecimal("1000000")) >= 0) {
            if (!alertRepo.isAnalystSenior(analystId)) {
                throw new InsufficientAuthorizationException(
                    "SAR filings above $1,000,000 require senior analyst authorization");
            }
        }
    }
}
```

---

## Bulk Alert Management

Compliance teams frequently need to process large numbers of similar alerts efficiently — for example, closing all LOW-severity structuring alerts below a certain dollar amount where the customer has been verified as a known legitimate cash business.

```java
package com.fintech.alerts.service;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

@Service
public class BulkAlertManagementService {

    private static final int MAX_BULK_OPERATION_SIZE = 500;

    private final AlertRepository alertRepo;
    private final AlertInvestigationService investigationService;
    private final AuditService auditService;

    /**
     * Bulk disposition for systematic false positives.
     * Used when a scenario has been identified as producing excessive false positives
     * for a specific customer segment or business type.
     *
     * Requires: manager authorization, full audit trail, scenario code being updated.
     */
    public BulkDispositionResult bulkDispositionFalsePositives(
            BulkDispositionRequest request,
            String managerId) {

        if (!alertRepo.isManager(managerId)) {
            throw new InsufficientAuthorizationException(
                "Bulk disposition requires manager authorization");
        }

        List<AmlAlert> targetAlerts = alertRepo.findByScenarioAndStatusAndSeverity(
            request.scenarioCode(),
            AlertStatus.PENDING,
            request.maxSeverity()
        );

        if (targetAlerts.size() > MAX_BULK_OPERATION_SIZE) {
            throw new BulkOperationTooLargeException(
                "Bulk operation limited to " + MAX_BULK_OPERATION_SIZE +
                " alerts. Found: " + targetAlerts.size() +
                ". Narrow the criteria or process in multiple batches.");
        }

        int succeeded = 0;
        int failed = 0;
        List<UUID> failedAlertIds = new java.util.ArrayList<>();

        for (AmlAlert alert : targetAlerts) {
            try {
                alertRepo.updateStatusAndDisposition(
                    alert.alertId(),
                    AlertStatus.DISPOSITIONED,
                    AlertDisposition.FALSE_POSITIVE,
                    request.dispositionReason() + " [BULK: " + managerId + "]",
                    java.time.OffsetDateTime.now()
                );
                succeeded++;
            } catch (Exception e) {
                failed++;
                failedAlertIds.add(alert.alertId());
            }
        }

        auditService.logBulkOperation(
            "BULK_FALSE_POSITIVE_DISPOSITION",
            managerId, request.scenarioCode(),
            succeeded, failed, request.dispositionReason()
        );

        return new BulkDispositionResult(succeeded, failed, failedAlertIds);
    }

    /**
     * Re-assign all alerts from one analyst to another.
     * Used when an analyst is on leave or leaves the organization.
     */
    public int reassignAnalystAlerts(
            String fromAnalystId, String toAnalystId, String managerId) {
        List<AmlAlert> analystAlerts = alertRepo
            .findByAnalystAndStatus(fromAnalystId, List.of(
                AlertStatus.ASSIGNED, AlertStatus.INVESTIGATING, AlertStatus.PENDING_INFO));

        for (AmlAlert alert : analystAlerts) {
            alertRepo.update(alert.withAssignedAnalystId(toAnalystId));
        }

        auditService.log("BULK_REASSIGNMENT",
            "Reassigned " + analystAlerts.size() + " alerts from " +
            fromAnalystId + " to " + toAnalystId, managerId);

        return analystAlerts.size();
    }

    public record BulkDispositionRequest(
        String scenarioCode,
        AlertSeverity maxSeverity,
        BigDecimal maxAmount,
        String dispositionReason
    ) {}

    public record BulkDispositionResult(
        int succeeded, int failed, List<UUID> failedAlertIds
    ) {}
}
```

---

## SLA Monitoring and Breach Alerting

```java
package com.fintech.alerts.monitoring;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.List;

@Service
public class AlertSlaMonitor {

    private static final int WARNING_MINUTES = 60;  // Warn 1 hour before SLA breach

    private final AlertRepository alertRepo;
    private final SlaCalculator slaCalculator;
    private final ComplianceNotificationService notificationService;
    private final AuditService auditService;

    /**
     * Runs every 15 minutes to check SLA status of all open alerts.
     */
    @Scheduled(fixedDelayString = "PT15M")
    public void checkSlaStatus() {
        OffsetDateTime now = OffsetDateTime.now();
        OffsetDateTime warningThreshold = now.plusMinutes(WARNING_MINUTES);

        // Alerts approaching SLA deadline
        List<AmlAlert> approachingDeadline = alertRepo
            .findOpenAlertsWithSlaBeforeAndStatus(
                warningThreshold, List.of(AlertStatus.PENDING, AlertStatus.ASSIGNED,
                    AlertStatus.INVESTIGATING));

        for (AmlAlert alert : approachingDeadline) {
            long minutesLeft = slaCalculator.minutesUntilSla(alert);
            if (minutesLeft <= WARNING_MINUTES && minutesLeft > 0) {
                notificationService.sendSlaWarning(alert, minutesLeft);
            }
        }

        // SLA-breached alerts — these are regulatory issues
        List<AmlAlert> breached = alertRepo
            .findOpenAlertsWithSlaBeforeAndStatus(
                now, List.of(AlertStatus.PENDING, AlertStatus.ASSIGNED,
                    AlertStatus.INVESTIGATING, AlertStatus.PENDING_INFO));

        for (AmlAlert alert : breached) {
            if (!alertRepo.isSlaBreach(alert.alertId())) {
                // First detection of this breach — log and escalate
                alertRepo.markSlaBreach(alert.alertId(), now);
                auditService.logSlaBreachRegulatory(
                    alert.alertId(), alert.customerId(), alert.slaDeadline(), now);
                notificationService.escalateSlaBreachToManager(alert);
            }
        }

        // Generate daily SLA metrics
        generateSlaMetrics(now);
    }

    private void generateSlaMetrics(OffsetDateTime asOf) {
        SlaMetrics metrics = SlaMetrics.builder()
            .asOf(asOf)
            .totalOpenAlerts(alertRepo.countOpenAlerts())
            .breachedAlerts(alertRepo.countBreachedAlerts())
            .warningAlerts(alertRepo.countAlertsInWarning())
            .breachRate(alertRepo.calculateBreachRate(asOf.minusDays(30), asOf))
            .averageResolutionHours(alertRepo.averageResolutionHours(asOf.minusDays(30), asOf))
            .build();

        alertRepo.saveMetrics(metrics);
    }
}
```

---

## SAR Integration

When an alert is dispositioned as TRUE_POSITIVE_SAR, the case management system must seamlessly initiate the SAR filing workflow:

```java
package com.fintech.alerts.service;

import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.UUID;

@Service
public class AlertToSarBridgeService {

    private static final int SAR_FILING_DEADLINE_DAYS = 30;

    private final SarFilingRepository sarRepo;
    private final AlertRepository alertRepo;
    private final AuditService auditService;

    /**
     * Initiate a SAR filing workflow from an alert disposition.
     * The 30-day SAR filing clock starts when the institution
     * "knows, suspects, or has reason to suspect" suspicious activity.
     * That date is typically when the alert was created, NOT when it was dispositioned.
     */
    public SarDraft initiateFromAlert(UUID alertId, String analystId) {
        AmlAlert alert = alertRepo.findById(alertId)
            .orElseThrow(() -> new AlertNotFoundException(alertId));

        // The 30-day clock starts from the detection date (alert creation)
        // NOT the investigation completion date
        LocalDate detectionDate = alert.createdAt().toLocalDate();
        LocalDate filingDeadline = detectionDate.plusDays(SAR_FILING_DEADLINE_DAYS);

        // Check if deadline is already past
        if (LocalDate.now().isAfter(filingDeadline)) {
            auditService.logRegulatoryViolation(
                "SAR_DEADLINE_EXCEEDED",
                "SAR filing deadline of " + filingDeadline +
                " has passed for alert " + alertId,
                alert.customerId()
            );
        }

        SarDraft draft = SarDraft.builder()
            .sarId(UUID.randomUUID())
            .customerId(alert.customerId())
            .linkedAlertId(alertId)
            .detectionDate(detectionDate)
            .filingDeadline(filingDeadline)
            .suspiciousActivityType(mapAlertTypeToSarActivityType(alert.alertType()))
            .amount(alert.alertAmount())
            .initialNarrative(alert.alertNarrative())
            .status(SarStatus.DRAFT)
            .assignedAnalystId(analystId)
            .build();

        sarRepo.save(draft);

        // Link back to alert
        alertRepo.update(alert.withLinkedSarId(draft.sarId()));

        auditService.log("SAR_INITIATED",
            "SAR filing initiated from alert " + alertId +
            ". Deadline: " + filingDeadline, analystId);

        return draft;
    }

    private SarActivityType mapAlertTypeToSarActivityType(AlertType alertType) {
        return switch (alertType) {
            case STRUCTURING          -> SarActivityType.STRUCTURING;
            case UNUSUAL_TRANSACTION  -> SarActivityType.UNUSUAL_TRANSACTIONS;
            case HIGH_RISK_COUNTERPARTY -> SarActivityType.UNUSUAL_TRANSACTIONS;
            case VELOCITY_BREACH      -> SarActivityType.UNUSUAL_TRANSACTIONS;
            case GEOGRAPHIC_ANOMALY   -> SarActivityType.INTERNATIONAL_TRANSFERS;
            default                   -> SarActivityType.OTHER;
        };
    }
}
```

---

## False Positive Feedback Loop

A systematic approach to reducing false positives is essential at scale. Track which scenarios produce the most false positives and tune accordingly:

```java
package com.fintech.alerts.analytics;

import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
public class FalsePositiveAnalyticsService {

    private final AlertRepository alertRepo;

    /**
     * Calculate false positive rates by scenario over a date range.
     * Used by the AML model management team to identify scenarios
     * that need threshold calibration.
     *
     * Industry standard: a false positive rate above 97% for a scenario
     * indicates the scenario is miscalibrated and must be tuned.
     */
    public List<ScenarioFalsePositiveStats> analyzeByScenario(
            LocalDate startDate, LocalDate endDate) {

        List<AmlAlert> dispositioned = alertRepo.findDispositionedBetween(startDate, endDate);

        return dispositioned.stream()
            .collect(Collectors.groupingBy(AmlAlert::scenarioCode))
            .entrySet().stream()
            .map(e -> {
                List<AmlAlert> scenarioAlerts = e.getValue();
                long total = scenarioAlerts.size();
                long falsePositives = scenarioAlerts.stream()
                    .filter(a -> a.disposition() == AlertDisposition.FALSE_POSITIVE
                              || a.disposition() == AlertDisposition.FALSE_POSITIVE_KNOWN)
                    .count();
                long truePositives = scenarioAlerts.stream()
                    .filter(a -> a.disposition() == AlertDisposition.TRUE_POSITIVE_SAR
                              || a.disposition() == AlertDisposition.TRUE_POSITIVE_NO_SAR)
                    .count();

                double fpRate = total > 0 ? (double) falsePositives / total : 0;

                return new ScenarioFalsePositiveStats(
                    e.getKey(),
                    (int) total,
                    (int) falsePositives,
                    (int) truePositives,
                    fpRate,
                    fpRate > 0.97 ? TuningRecommendation.URGENT_CALIBRATION_NEEDED
                        : fpRate > 0.90 ? TuningRecommendation.REVIEW_THRESHOLD
                        : TuningRecommendation.ACCEPTABLE
                );
            })
            .sorted(java.util.Comparator.comparingDouble(
                ScenarioFalsePositiveStats::falsePositiveRate).reversed())
            .toList();
    }

    public record ScenarioFalsePositiveStats(
        String scenarioCode,
        int totalAlerts,
        int falsePositives,
        int truePositives,
        double falsePositiveRate,
        TuningRecommendation recommendation
    ) {}

    public enum TuningRecommendation {
        ACCEPTABLE,
        REVIEW_THRESHOLD,
        URGENT_CALIBRATION_NEEDED
    }
}
```

---

## Analyst Workload Dashboard Query

```java
package com.fintech.alerts.repository;

import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

@Repository
public class AlertDashboardRepository {

    private final NamedParameterJdbcTemplate jdbc;

    /**
     * Query for the analyst workload dashboard.
     * Shows pending alerts by severity and SLA status.
     */
    public List<AnalystWorkloadSummary> getWorkloadSummary() {
        return jdbc.query("""
            SELECT
                a.assigned_analyst_id,
                COUNT(*) FILTER (WHERE a.status IN ('ASSIGNED', 'INVESTIGATING'))
                    AS open_alerts,
                COUNT(*) FILTER (WHERE a.severity = 'CRITICAL'
                    AND a.status IN ('ASSIGNED', 'INVESTIGATING'))
                    AS critical_alerts,
                COUNT(*) FILTER (WHERE a.sla_deadline < NOW()
                    AND a.status IN ('PENDING', 'ASSIGNED', 'INVESTIGATING'))
                    AS breached_sla_count,
                COUNT(*) FILTER (WHERE a.sla_deadline BETWEEN NOW()
                    AND NOW() + INTERVAL '1 hour'
                    AND a.status IN ('ASSIGNED', 'INVESTIGATING'))
                    AS approaching_sla_count,
                AVG(EXTRACT(EPOCH FROM (NOW() - a.assigned_at)) / 3600)
                    AS avg_age_hours
            FROM aml_alerts a
            WHERE a.assigned_analyst_id IS NOT NULL
            GROUP BY a.assigned_analyst_id
            ORDER BY breached_sla_count DESC, critical_alerts DESC
            """,
            Map.of(),
            (rs, row) -> new AnalystWorkloadSummary(
                rs.getString("assigned_analyst_id"),
                rs.getInt("open_alerts"),
                rs.getInt("critical_alerts"),
                rs.getInt("breached_sla_count"),
                rs.getInt("approaching_sla_count"),
                rs.getDouble("avg_age_hours")
            ));
    }

    /**
     * Find alerts that have been in INVESTIGATING status for longer than expected.
     * These are "stuck" alerts that may need manager attention.
     */
    public List<AmlAlert> findStuckAlerts(int thresholdHours) {
        return jdbc.query("""
            SELECT * FROM aml_alerts
            WHERE status = 'INVESTIGATING'
              AND assigned_at < NOW() - MAKE_INTERVAL(hours => :thresholdHours)
              AND disposition IS NULL
            ORDER BY sla_deadline ASC
            """,
            Map.of("thresholdHours", thresholdHours),
            this::mapToAlert);
    }

    public record AnalystWorkloadSummary(
        String analystId,
        int openAlerts,
        int criticalAlerts,
        int breachedSlaCount,
        int approachingSlaCount,
        double avgAgeHours
    ) {}

    private AmlAlert mapToAlert(java.sql.ResultSet rs, int row) {
        // Full mapping implementation
        throw new UnsupportedOperationException("Implement full ResultSet mapping");
    }
}
```

---

## Production Operational Considerations

**Alert queue depth:** Monitor alert queue depth as a leading indicator of compliance capacity problems. If PENDING alert count grows week-over-week for more than 3 consecutive weeks, either alert volume has increased (possibly a miscalibrated scenario), or analyst capacity is insufficient. Neither is acceptable — both require escalation to the Chief Compliance Officer.

**Alert aging:** Alerts older than 50% of their SLA should be surfaced to managers. An alert sitting at 50% of its SLA with no investigative action taken is a process failure, not an analyst failure — it may indicate the queue routing is broken or the analyst is not receiving notifications.

**Case consolidation threshold:** Consolidating too aggressively loses investigative detail. Too little consolidation means analysts work the same customer multiple times. A good heuristic: consolidate when a customer has 3+ alerts in the same 30-day window with the same scenario code, but keep alerts separate across different scenario codes so each can receive a focused investigation.

**Disposition quality gates:** Implement a minimum review time before an analyst can disposition an alert. An alert dispositioned in under 2 minutes is suspicious — the analyst either has prior knowledge (legitimate) or is rubber-stamping without investigation (a compliance failure). Configure the UI to prevent disposition before a minimum time threshold per severity level.

**Regulatory examination readiness:** Regulators frequently ask "show me all HIGH-risk alerts from the past 24 months, with their disposition rationale, analyst notes, and time-to-resolution." Ensure the case management system can produce this report on demand, filtered by customer, date range, scenario, and disposition type.

---

## Summary

A well-designed alert management system is the operational engine of your AML program. The key design decisions are:

1. **SLA tracking must be automated** — manual tracking of compliance deadlines at scale is not viable; breach alerts and escalations must be system-driven.
2. **Narrative generation reduces analyst ramp-up time** — a good narrative front-loads the investigation with what the analyst needs to check first.
3. **False positive analytics drive scenario tuning** — build the feedback loop into the system from day one; without it, false positive rates drift upward over time.
4. **Bulk operations require manager authorization and full audit trail** — bulk dispositions are a regulatory risk; ensure they are constrained and logged.
5. **SLA is calculated in business hours** — calendar-hour SLAs penalize analysts for weekends; use business-hour SLAs tied to actual staffing calendars.
6. **Alert-to-SAR bridge must be seamless** — the investigation and filing systems should be tightly integrated; every hand-off is an opportunity for delay that erodes the 30-day SAR window.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the industry average false positive rate for AML alerts, and why does improving it from 95% to 90% double effective analyst capacity?",
      "options": ["50%; because half the alerts are false positives", "90-95%; because if 95% of alerts are false positives, only 5% are actionable — dropping to 10% actionable doubles the useful work in the same alert volume", "70%; because most rules are poorly calibrated", "30%; because modern ML systems are quite accurate"],
      "correct": 1,
      "explanation": "Industry average false positive rates run 90-95%. If 95% of alerts are false positives, only 5 out of 100 alerts are genuine — analysts spend 95% of their time on non-issues. Improving to 90% false positive rate doubles the number of actionable alerts (from 5 to 10 per 100), effectively doubling capacity without adding analysts."
    },
    {
      "text": "Why is the 30-day SAR filing clock calculated from the alert creation date rather than the investigation disposition date?",
      "options": ["FinCEN regulations specifically require the alert creation date", "The clock starts when the institution 'knows, suspects, or has reason to suspect' suspicious activity — that date is when the alert is generated, not when investigation concludes", "Investigation completion dates are not stored in the system", "30 days from disposition would leave insufficient time for SAR preparation"],
      "correct": 1,
      "explanation": "Under 31 U.S.C. § 5318(g), the SAR must be filed within 30 days of the date the institution first detects the suspicious activity. Detection occurs when the alert is generated. If investigation takes 25 days, only 5 days remain for SAR preparation and filing — making deadline tracking from alert creation date critical."
    },
    {
      "text": "What minimum review time should be enforced before an analyst can disposition an alert, and why?",
      "options": ["No minimum — analysts should work at their own pace", "A severity-proportionate minimum time, because an alert dispositioned in under 2 minutes is a signal of rubber-stamping rather than genuine investigation", "24 hours minimum for all alerts", "Only a minimum for HIGH and CRITICAL severity alerts"],
      "correct": 1,
      "explanation": "An alert dispositioned in under 2 minutes indicates the analyst either has prior knowledge (legitimate) or is rubber-stamping without investigation (a compliance failure). The UI should enforce a minimum review time proportional to alert severity. CRITICAL alerts may require a minimum of 30 minutes of documented investigation before disposition is allowed."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build an AML Alert Management System with SLA Tracking",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement the AlertInvestigationService with claimAlert(), beginInvestigation(), and dispositionAlert() methods. Use optimistic locking for the claim operation to prevent two analysts from claiming the same alert. Enforce that SAR filings above $1,000,000 require a senior analyst role. All state transitions must be persisted to an audit log."},
    {"id": "2", "description": "Implement the SlaCalculator that computes deadline timestamps in business hours (9 AM to 5 PM Eastern, Monday to Friday). CRITICAL alerts get 8 business hours, HIGH get 16, MEDIUM get 40, LOW get 120. Write unit tests for edge cases: an alert created on Friday at 4 PM, an alert created on a weekend."},
    {"id": "3", "description": "Implement the AlertSlaMonitor as a @Scheduled component that runs every 15 minutes. It must: (a) find alerts within 1 hour of their SLA deadline and send analyst notifications, (b) find alerts past their SLA deadline, mark them as breached on first detection, log a regulatory breach event, and escalate to manager. Ensure the breach is only logged once per alert."},
    {"id": "4", "description": "Implement the FalsePositiveAnalyticsService that calculates false positive rates per scenario over a date range, classifies each scenario as HEALTHY (<85% FP rate), REVIEW_THRESHOLD (85-97%), or URGENT_CALIBRATION_NEEDED (>97%). Write an integration test that creates 100 disposed alerts for a scenario (95 as FALSE_POSITIVE, 5 as TRUE_POSITIVE) and asserts the classification is URGENT_CALIBRATION_NEEDED."}
  ]
}
-->
