---
id: track-07-lesson-13
title: "SAR Filing — Suspicious Activity Report Automation"
slug: sar-filing
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 13
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [SAR, filing, automation, narrative-generation, FinCEN]
prerequisites: []
---

# SAR Filing — Suspicious Activity Report Automation

> [!NOTE]
> Suspicious Activity Reports (SARs) are the primary intelligence tool used by law enforcement to investigate financial crime. FinCEN receives roughly 3.5 million SAR filings per year. For financial institutions, the SAR filing process must be automated, auditable, and correct — a missed or deficient SAR can result in civil money penalties, and voluntary disclosures to law enforcement depend on the quality of the narrative. The engineering challenge is building a system that meets the 30-day deadline, generates compelling narratives, and maintains strict confidentiality.

## Regulatory Background

Under 31 U.S.C. § 5318(g) and FinCEN's implementing regulations (31 C.F.R. § 1020.320 for banks), financial institutions must file a SAR when they know, suspect, or have reason to suspect that a transaction involves funds from illegal activity, is designed to evade BSA reporting requirements, or lacks a lawful purpose.

**Key SAR requirements:**

- **30-day deadline:** File within 30 calendar days of the date the institution first detects the suspicious activity. If no suspect can be identified, the institution has an additional 30 days (60 total) to file.
- **$5,000 threshold:** File if the suspicious amount is $5,000 or more and the institution can identify the suspect. File regardless of amount if no suspect is identified.
- **Confidentiality:** 31 U.S.C. § 5318(g)(2) prohibits notifying the subject of the SAR that it was filed. This is an absolute prohibition — not even the customer's attorney can be told a SAR was filed.
- **Safe harbor:** 31 U.S.C. § 5318(g)(3) provides a safe harbor from civil liability for SAR filers.
- **Recordkeeping:** Retain supporting documentation for 5 years from the date of filing.

---

## SAR Data Model

```java
package com.fintech.sar.model;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record SarRecord(
    UUID sarId,
    String bsaIdentifier,            // FinCEN-assigned BSA ID after acceptance
    String customerId,               // Primary subject
    List<String> additionalSubjectIds, // Other involved parties
    SarStatus status,
    SarActivityType primaryActivityType,
    List<SarActivityType> additionalActivityTypes,
    LocalDate activityFromDate,       // Start of suspicious activity window
    LocalDate activityToDate,         // End of suspicious activity window
    LocalDate detectionDate,          // When institution first detected the activity
    LocalDate filingDeadline,         // 30 days from detection (or 60 if no suspect)
    LocalDate filedDate,
    BigDecimal totalAmount,           // Total dollar amount of suspicious activity
    String narrative,                 // The SAR narrative (most important field)
    FilingMethod filingMethod,        // E-Filing or paper
    boolean isJointFiling,            // Multiple institutions filing together
    String filingInstitutionId,
    String preparerId,                // Analyst who prepared the SAR
    String reviewerId,                // Senior analyst/BSA Officer who reviewed
    String approverId,                // BSA Officer who approved
    OffsetDateTime preparedAt,
    OffsetDateTime reviewedAt,
    OffsetDateTime approvedAt,
    OffsetDateTime submittedAt,
    boolean isAmendment,
    String originalSarBsaId,         // If amending a prior SAR
    List<UUID> linkedAlertIds,       // Alert(s) that triggered this SAR
    List<String> linkedTransactionIds,
    String confidentialityNote       // Always "SAR CONFIDENTIAL — DO NOT DISCLOSE"
) {}

public enum SarStatus {
    DRAFT,              // Being prepared by analyst
    PENDING_REVIEW,     // Ready for senior analyst review
    UNDER_REVIEW,       // Senior analyst reviewing
    PENDING_APPROVAL,   // Awaiting BSA Officer approval
    APPROVED,           // BSA Officer approved; ready to file
    SUBMITTED,          // Submitted to FinCEN E-Filing
    ACCEPTED,           // FinCEN accepted (BSA ID assigned)
    REJECTED,           // FinCEN rejected (must correct and refile)
    WITHDRAWN,          // Institution withdrew before submission
    SUPERSEDED          // Replaced by an amendment
}

public enum SarActivityType {
    STRUCTURING,
    MONEY_LAUNDERING,
    CHECK_FRAUD,
    WIRE_FRAUD,
    IDENTITY_THEFT,
    TERRORIST_FINANCING,
    BRIBERY_GRATUITY,
    EMBEZZLEMENT,
    FORGERY,
    UNUSUAL_NEGOTIABLE_INSTRUMENTS,
    UNUSUAL_WIRE_TRANSFER,
    SUSPECTED_DRUG_MONEY,
    GAMBLING_WINNINGS,
    TRANSACTION_NO_APPARENT_LAWFUL_PURPOSE,
    OTHER
}

public enum FilingMethod {
    BSA_E_FILING,
    PAPER_FORM_111  // Deprecated; only for institutions without internet access
}

public record SarSubject(
    String customerId,
    SubjectType subjectType,
    String lastName,
    String firstName,
    String dateOfBirth,     // YYYYMMDD format
    String ssn,             // Encrypted at rest
    String taxId,           // For businesses
    String address,
    String city,
    String state,
    String zip,
    String countryCode,
    String idType,
    String idNumber,
    String occupation,
    String employer,
    List<String> accountNumbers
) {}

public enum SubjectType {
    INDIVIDUAL, LEGAL_ENTITY
}
```

---

## SAR Filing Service

```java
package com.fintech.sar.service;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class SarFilingService {

    private static final int SAR_DEADLINE_DAYS           = 30;
    private static final int SAR_DEADLINE_NO_SUSPECT     = 60;
    private static final int SAR_RETENTION_YEARS         = 5;
    private static final BigDecimal SAR_MINIMUM_AMOUNT   = new BigDecimal("5000.00");

    private final SarRepository sarRepo;
    private final SarNarrativeGenerator narrativeGenerator;
    private final SarXmlGenerator xmlGenerator;
    private final BsaEFilingClient bsaClient;
    private final SarApprovalWorkflow approvalWorkflow;
    private final AuditService auditService;
    private final ConfidentialityGuard confidentialityGuard;

    /**
     * Create a new SAR draft from an alert disposition.
     * This is called when an analyst dispositions an alert as TRUE_POSITIVE_SAR.
     */
    public SarRecord createDraft(SarCreationRequest request) {
        // Validate minimum amount requirement
        if (request.amount().compareTo(SAR_MINIMUM_AMOUNT) < 0
                && request.subjectIdentified()) {
            throw new SarThresholdException(
                "SAR filing requires minimum $5,000 suspicious amount when " +
                "subject is identified. Amount: $" + request.amount());
        }

        LocalDate detectionDate = request.detectionDate();
        boolean suspectIdentified = request.subjectIdentified();

        // Calculate the 30-day (or 60-day) filing deadline
        int deadlineDays = suspectIdentified
            ? SAR_DEADLINE_DAYS : SAR_DEADLINE_NO_SUSPECT;
        LocalDate filingDeadline = detectionDate.plusDays(deadlineDays);

        // Warn if deadline is already close
        long daysRemaining = java.time.temporal.ChronoUnit.DAYS.between(
            LocalDate.now(), filingDeadline);
        if (daysRemaining < 5) {
            auditService.log("SAR_DEADLINE_WARNING",
                "SAR for customer " + request.customerId() +
                " has only " + daysRemaining + " days remaining before deadline",
                request.preparerId());
        }

        // Generate initial narrative
        String initialNarrative = narrativeGenerator.generateInitial(request);

        SarRecord draft = new SarRecord(
            UUID.randomUUID(),
            null,                    // BSA ID assigned by FinCEN after acceptance
            request.customerId(),
            request.additionalSubjectIds(),
            SarStatus.DRAFT,
            request.primaryActivityType(),
            request.additionalActivityTypes(),
            request.activityFromDate(),
            request.activityToDate(),
            detectionDate,
            filingDeadline,
            null,                    // Not yet filed
            request.amount(),
            initialNarrative,
            FilingMethod.BSA_E_FILING,
            false,
            loadFilingInstitutionId(),
            request.preparerId(),
            null,                    // Not yet reviewed
            null,                    // Not yet approved
            OffsetDateTime.now(),
            null, null, null,
            false,
            null,                    // Not an amendment
            request.linkedAlertIds(),
            request.linkedTransactionIds(),
            "SAR CONFIDENTIAL — DO NOT DISCLOSE"
        );

        sarRepo.save(draft);

        auditService.log("SAR_DRAFT_CREATED",
            "SAR draft created for customer " + request.customerId() +
            " detection date " + detectionDate +
            " filing deadline " + filingDeadline,
            request.preparerId());

        return draft;
    }

    /**
     * Submit SAR for review. Transitions from DRAFT to PENDING_REVIEW.
     */
    public SarRecord submitForReview(UUID sarId, String preparerId) {
        SarRecord sar = loadSar(sarId);
        validateOwnership(sar, preparerId);

        // Validate narrative completeness before allowing submission
        NarrativeValidationResult narrativeCheck =
            narrativeGenerator.validateNarrative(sar.narrative());
        if (!narrativeCheck.isValid()) {
            throw new IncompleteSarNarrativeException(
                "SAR narrative is incomplete. Missing elements: " +
                String.join(", ", narrativeCheck.missingElements()));
        }

        SarRecord updated = sar.withStatus(SarStatus.PENDING_REVIEW)
            .withPreparedAt(OffsetDateTime.now());

        sarRepo.update(updated);
        approvalWorkflow.assignToReviewer(sarId);
        auditService.log("SAR_SUBMITTED_FOR_REVIEW", sarId.toString(), preparerId);

        return updated;
    }

    /**
     * BSA Officer approves the SAR for filing.
     * BSA Officers are personally liable for SAR filing decisions —
     * this approval is the most audited action in the system.
     */
    public SarRecord approve(UUID sarId, String bsaOfficerId, String approvalNotes) {
        SarRecord sar = loadSar(sarId);

        if (sar.status() != SarStatus.UNDER_REVIEW
                && sar.status() != SarStatus.PENDING_APPROVAL) {
            throw new InvalidSarStatusException(
                "SAR must be in UNDER_REVIEW or PENDING_APPROVAL status to approve. " +
                "Current: " + sar.status());
        }

        SarRecord approved = sar.withStatus(SarStatus.APPROVED)
            .withApproverId(bsaOfficerId)
            .withApprovedAt(OffsetDateTime.now());

        sarRepo.update(approved);

        auditService.logBsaOfficerApproval(
            sarId, bsaOfficerId, approvalNotes,
            sar.filingDeadline(), LocalDate.now());

        return approved;
    }

    /**
     * File the approved SAR with FinCEN via BSA E-Filing.
     * This is the final, legally binding step.
     */
    public SarRecord fileWithFinCen(UUID sarId, String submitterId) {
        SarRecord sar = loadSar(sarId);

        if (sar.status() != SarStatus.APPROVED) {
            throw new InvalidSarStatusException(
                "SAR must be APPROVED before filing. Current: " + sar.status());
        }

        // Last-chance deadline check
        if (LocalDate.now().isAfter(sar.filingDeadline())) {
            auditService.logRegulatoryViolation(
                "SAR_FILED_AFTER_DEADLINE",
                "SAR " + sarId + " filed after deadline " + sar.filingDeadline(),
                sar.customerId());
        }

        // Generate FinCEN XML
        String xmlContent = xmlGenerator.generate(sar);
        xmlGenerator.validate(xmlContent);

        // Submit to BSA E-Filing
        BsaFilingResponse response = bsaClient.submitSar(xmlContent);

        SarRecord filed = sar
            .withStatus(SarStatus.ACCEPTED)
            .withBsaIdentifier(response.bsaId())
            .withFiledDate(LocalDate.now())
            .withSubmittedAt(OffsetDateTime.now());

        sarRepo.update(filed);

        auditService.log("SAR_FILED",
            "SAR " + sarId + " filed with FinCEN. BSA ID: " + response.bsaId() +
            " Filed date: " + LocalDate.now(),
            submitterId);

        return filed;
    }

    /**
     * File an amendment to a previously accepted SAR.
     * Amendments are required when material information was incorrect or omitted.
     */
    public SarRecord fileAmendment(
            UUID originalSarId, SarAmendmentRequest request, String preparerId) {
        SarRecord originalSar = loadSar(originalSarId);

        if (originalSar.status() != SarStatus.ACCEPTED) {
            throw new InvalidSarStatusException(
                "Can only amend ACCEPTED SARs. Current: " + originalSar.status());
        }

        SarRecord amendment = originalSar
            .withSarId(UUID.randomUUID())
            .withBsaIdentifier(null)
            .withStatus(SarStatus.DRAFT)
            .withNarrative(request.updatedNarrative())
            .withTotalAmount(request.updatedAmount())
            .withIsAmendment(true)
            .withOriginalSarBsaId(originalSar.bsaIdentifier())
            .withPreparerId(preparerId)
            .withPreparedAt(null)
            .withReviewedAt(null)
            .withApprovedAt(null)
            .withSubmittedAt(null)
            .withFiledDate(null)
            .withFilingDeadline(LocalDate.now().plusDays(SAR_DEADLINE_DAYS));

        sarRepo.save(amendment);

        // Mark the original as superseded
        sarRepo.update(originalSar.withStatus(SarStatus.SUPERSEDED));

        auditService.log("SAR_AMENDMENT_CREATED",
            "Amendment to SAR " + originalSarId +
            " (BSA ID: " + originalSar.bsaIdentifier() + ") created",
            preparerId);

        return amendment;
    }

    private SarRecord loadSar(UUID sarId) {
        return sarRepo.findById(sarId)
            .orElseThrow(() -> new SarNotFoundException(sarId));
    }

    private void validateOwnership(SarRecord sar, String analystId) {
        if (!analystId.equals(sar.preparerId())) {
            throw new SarOwnershipException(
                "Analyst " + analystId + " does not own SAR " + sar.sarId());
        }
    }

    private String loadFilingInstitutionId() {
        return "INST-001"; // Load from configuration in production
    }
}
```

---

## SAR Narrative Generator

The SAR narrative is the most important element of the filing. Law enforcement agents read the narrative to decide whether to investigate. A poor narrative — vague, incomplete, or poorly organized — may result in the SAR being ignored. A well-written narrative tells a complete story: who, what, when, where, how much, and why it is suspicious.

```java
package com.fintech.sar.service;

import org.springframework.stereotype.Component;

import java.text.NumberFormat;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;

@Component
public class SarNarrativeGenerator {

    private static final NumberFormat CURRENCY = NumberFormat.getCurrencyInstance(Locale.US);
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("MMMM d, yyyy");

    /**
     * FinCEN's 2012 SAR narrative guidance specifies that a good narrative
     * addresses six questions in this order:
     *
     * 1. WHO is involved?
     * 2. WHAT instruments or mechanisms are used?
     * 3. WHEN did the suspicious activity occur?
     * 4. WHERE did the suspicious activity take place?
     * 5. HOW did the suspicious activity occur?
     * 6. WHY does the institution think this activity is suspicious?
     */
    public String generateInitial(SarCreationRequest request) {
        StringBuilder narrative = new StringBuilder();

        narrative.append(generateWhoSection(request));
        narrative.append("\n\n");
        narrative.append(generateWhatSection(request));
        narrative.append("\n\n");
        narrative.append(generateWhenSection(request));
        narrative.append("\n\n");
        narrative.append(generateWhereSection(request));
        narrative.append("\n\n");
        narrative.append(generateHowSection(request));
        narrative.append("\n\n");
        narrative.append(generateWhySuspiciousSection(request));

        if (request.priorSarCount() > 0) {
            narrative.append("\n\n");
            narrative.append(generatePriorSarSection(request));
        }

        narrative.append("\n\n");
        narrative.append(generateInstitutionActionSection(request));

        return narrative.toString();
    }

    private String generateWhoSection(SarCreationRequest request) {
        CustomerData customer = request.customerData();

        StringBuilder who = new StringBuilder();
        who.append("SUBJECT INFORMATION:\n");

        if (customer.isIndividual()) {
            who.append(String.format(
                "%s %s (DOB: %s, SSN on file) is an individual customer who " +
                "has maintained accounts with the institution since %s. " +
                "The subject's stated occupation is %s.",
                customer.firstName(), customer.lastName(),
                customer.dateOfBirth(),
                customer.accountOpenDate(),
                customer.occupation()
            ));
        } else {
            who.append(String.format(
                "%s (EIN: %s) is a %s registered in %s. " +
                "The beneficial owner(s) are %s. " +
                "The business has maintained accounts with the institution since %s.",
                customer.businessName(),
                customer.taxId(),
                customer.businessType(),
                customer.stateOfIncorporation(),
                String.join(", ", customer.beneficialOwnerNames()),
                customer.accountOpenDate()
            ));
        }

        return who.toString();
    }

    private String generateWhatSection(SarCreationRequest request) {
        return String.format(
            "SUSPICIOUS ACTIVITY TYPE:\n" +
            "The institution is reporting %s. " +
            "The total amount of suspicious activity is %s, " +
            "occurring across %d transaction(s) over the period from %s to %s. " +
            "The transactions involved %s.",
            formatActivityType(request.primaryActivityType()),
            CURRENCY.format(request.amount()),
            request.linkedTransactionIds().size(),
            request.activityFromDate().format(DATE),
            request.activityToDate().format(DATE),
            formatTransactionTypes(request.transactionTypes())
        );
    }

    private String generateWhenSection(SarCreationRequest request) {
        return String.format(
            "TIMELINE:\n" +
            "The suspicious activity first occurred on %s and continued through %s. " +
            "The institution detected this activity on %s through %s.",
            request.activityFromDate().format(DATE),
            request.activityToDate().format(DATE),
            request.detectionDate().format(DATE),
            request.detectionMethod()  // e.g., "automated transaction monitoring system"
        );
    }

    private String generateWhereSection(SarCreationRequest request) {
        return String.format(
            "LOCATION:\n" +
            "The suspicious activity occurred at %s, located at %s. " +
            "%s",
            request.branchName(),
            request.branchAddress(),
            request.involvedJurisdictions().isEmpty()
                ? ""
                : "Related transactions involved the following jurisdictions: " +
                  String.join(", ", request.involvedJurisdictions()) + "."
        );
    }

    private String generateHowSection(SarCreationRequest request) {
        return switch (request.primaryActivityType()) {
            case STRUCTURING -> generateStructuringHowSection(request);
            case MONEY_LAUNDERING -> generateMoneyLaunderingHowSection(request);
            case UNUSUAL_WIRE_TRANSFER -> generateWireTransferHowSection(request);
            default -> generateGenericHowSection(request);
        };
    }

    private String generateStructuringHowSection(SarCreationRequest request) {
        List<TransactionDetail> txDetails = request.transactionDetails();

        StringBuilder how = new StringBuilder("METHOD OF OPERATION:\n");
        how.append(String.format(
            "The subject conducted %d separate cash %s transactions, " +
            "each individually below the $10,000 Currency Transaction Report (CTR) threshold. ",
            txDetails.size(),
            txDetails.stream().anyMatch(t -> t.type().contains("DEPOSIT"))
                ? "deposit" : "withdrawal"
        ));

        how.append("Transaction details:\n");
        txDetails.stream()
            .sorted(java.util.Comparator.comparing(TransactionDetail::date))
            .forEach(tx -> how.append(String.format(
                "  - %s: %s at %s (Transaction ID: %s)\n",
                tx.date().format(DATE),
                CURRENCY.format(tx.amount()),
                tx.branchId(),
                tx.transactionId()
            )));

        how.append(String.format(
            "The aggregate amount of these transactions is %s, " +
            "which exceeds the $10,000 CTR threshold. " +
            "The pattern of multiple transactions just below $10,000 is consistent " +
            "with structuring under 31 U.S.C. § 5324.",
            CURRENCY.format(request.amount())
        ));

        return how.toString();
    }

    private String generateMoneyLaunderingHowSection(SarCreationRequest request) {
        return String.format(
            "METHOD OF OPERATION:\n" +
            "The subject received funds totaling %s from %s and subsequently " +
            "transferred these funds to %s within %d days. " +
            "This rapid movement of funds through accounts with no apparent business " +
            "purpose is consistent with the layering phase of money laundering.",
            CURRENCY.format(request.amount()),
            request.fundsSource(),
            request.fundsDestination(),
            request.daysToTransfer()
        );
    }

    private String generateWireTransferHowSection(SarCreationRequest request) {
        return String.format(
            "METHOD OF OPERATION:\n" +
            "The subject initiated %d international wire transfers totaling %s " +
            "to beneficiaries in %s. The stated purpose of the transfers was '%s', " +
            "however this stated purpose is inconsistent with the subject's known " +
            "business activities and financial profile.",
            request.linkedTransactionIds().size(),
            CURRENCY.format(request.amount()),
            String.join(", ", request.destinationCountries()),
            request.statedTransactionPurpose()
        );
    }

    private String generateGenericHowSection(SarCreationRequest request) {
        return "METHOD OF OPERATION:\n" +
            "The specific method of the suspicious activity is described in the " +
            "transaction details attached to this report.";
    }

    private String generateWhySuspiciousSection(SarCreationRequest request) {
        StringBuilder why = new StringBuilder("WHY THIS ACTIVITY IS SUSPICIOUS:\n");

        why.append("This activity is reported as suspicious for the following reasons:\n");

        List<String> reasons = request.suspiciousIndicators();
        for (int i = 0; i < reasons.size(); i++) {
            why.append(String.format("%d. %s\n", i + 1, reasons.get(i)));
        }

        why.append(String.format(
            "\nThe institution has been unable to identify a lawful explanation " +
            "for this activity that is consistent with the subject's customer profile, " +
            "stated business purpose, and known financial activities."
        ));

        return why.toString();
    }

    private String generatePriorSarSection(SarCreationRequest request) {
        return String.format(
            "PRIOR SAR HISTORY:\n" +
            "The institution has previously filed %d SAR(s) on this subject. " +
            "The most recent prior SAR BSA identifier is %s, filed on %s.",
            request.priorSarCount(),
            request.mostRecentPriorSarBsaId(),
            request.mostRecentPriorSarDate().format(DATE)
        );
    }

    private String generateInstitutionActionSection(SarCreationRequest request) {
        return switch (request.institutionAction()) {
            case ACCOUNT_CLOSED -> String.format(
                "INSTITUTION ACTION:\n" +
                "The institution has closed the subject's account(s) on %s " +
                "as a result of this suspicious activity.",
                request.accountClosedDate().format(DATE));
            case RELATIONSHIP_EXITED -> String.format(
                "INSTITUTION ACTION:\n" +
                "The institution has exited the customer relationship on %s.",
                request.relationshipExitDate().format(DATE));
            case MONITORING_ENHANCED ->
                "INSTITUTION ACTION:\n" +
                "The institution has placed the subject under enhanced monitoring " +
                "pending the outcome of this report.";
            case NO_ACTION ->
                "INSTITUTION ACTION:\n" +
                "The institution has taken no specific action against the account(s) " +
                "at this time.";
        };
    }

    /**
     * Validate that the narrative contains the required elements.
     * FinCEN examiners check for these elements during examination.
     */
    public NarrativeValidationResult validateNarrative(String narrative) {
        List<String> missingElements = new java.util.ArrayList<>();

        if (!narrative.contains("SUBJECT INFORMATION"))
            missingElements.add("Who section (SUBJECT INFORMATION)");
        if (!narrative.contains("SUSPICIOUS ACTIVITY TYPE"))
            missingElements.add("What section (SUSPICIOUS ACTIVITY TYPE)");
        if (!narrative.contains("TIMELINE"))
            missingElements.add("When section (TIMELINE)");
        if (!narrative.contains("METHOD OF OPERATION"))
            missingElements.add("How section (METHOD OF OPERATION)");
        if (!narrative.contains("WHY THIS ACTIVITY IS SUSPICIOUS"))
            missingElements.add("Why section");
        if (!narrative.contains("INSTITUTION ACTION"))
            missingElements.add("Institution action section");
        if (narrative.length() < 500)
            missingElements.add("Narrative too short (minimum 500 characters)");

        return new NarrativeValidationResult(missingElements.isEmpty(), missingElements);
    }

    private String formatActivityType(SarActivityType type) {
        return switch (type) {
            case STRUCTURING          -> "structuring/smurfing under 31 U.S.C. § 5324";
            case MONEY_LAUNDERING     -> "suspected money laundering activity";
            case UNUSUAL_WIRE_TRANSFER -> "unusual international wire transfer activity";
            case TERRORIST_FINANCING  -> "potential terrorist financing";
            default                   -> type.name().toLowerCase().replace('_', ' ');
        };
    }

    private String formatTransactionTypes(List<String> types) {
        if (types.isEmpty()) return "various transaction types";
        return String.join(", ",
            types.stream().map(t -> t.toLowerCase().replace('_', ' ')).toList());
    }

    public record NarrativeValidationResult(
        boolean isValid, List<String> missingElements
    ) {}
}
```

---

## SAR XML Generator (FinCEN Form 111)

```java
package com.fintech.sar.filing;

import org.springframework.stereotype.Component;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.Transformer;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import java.io.StringWriter;
import java.time.format.DateTimeFormatter;

@Component
public class SarXmlGenerator {

    private static final String FINCEN_NAMESPACE = "https://www.fincen.gov/base";
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");

    public String generate(SarRecord sar) {
        try {
            var factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            Document doc = factory.newDocumentBuilder().newDocument();

            Element root = doc.createElementNS(FINCEN_NAMESPACE, "EFilingBatchXML");
            root.setAttribute("SeqNum", "1");
            doc.appendChild(root);

            Element activity = doc.createElement("Activity");
            activity.setAttribute("SeqNum", "1");
            root.appendChild(activity);

            appendActivityAssociation(doc, activity, sar);
            appendFilingInstitution(doc, activity, sar.filingInstitutionId());
            appendSuspiciousActivity(doc, activity, sar);
            appendSubjectParty(doc, activity, sar);
            appendNarrative(doc, activity, sar.narrative());

            return serialize(doc);

        } catch (Exception e) {
            throw new SarXmlGenerationException("SAR XML generation failed", e);
        }
    }

    private void appendActivityAssociation(Document doc, Element parent, SarRecord sar) {
        Element assoc = doc.createElement("ActivityAssociation");
        appendText(doc, assoc, "CorrectsAmendsPriorReportIndicator",
            sar.isAmendment() ? "Y" : "N");
        if (sar.isAmendment() && sar.originalSarBsaId() != null) {
            appendText(doc, assoc, "PriorReportBSAIdentifier", sar.originalSarBsaId());
        }
        parent.appendChild(assoc);
    }

    private void appendSuspiciousActivity(Document doc, Element parent, SarRecord sar) {
        Element sa = doc.createElement("SuspiciousActivity");
        appendText(doc, sa, "ActivityFromDateText",
            sar.activityFromDate().format(DATE_FMT));
        appendText(doc, sa, "ActivityToDateText",
            sar.activityToDate().format(DATE_FMT));
        appendText(doc, sa, "SuspiciousActivityFromDateText",
            sar.activityFromDate().format(DATE_FMT));

        // Total amount
        appendText(doc, sa, "TotalAmountText",
            sar.totalAmount().setScale(2, java.math.RoundingMode.HALF_UP).toPlainString());

        // Activity type codes — these map to FinCEN's SAR type code list
        Element actTypes = doc.createElement("SuspiciousActivityClassification");
        appendText(doc, actTypes, "SuspiciousActivityClassificationTypeCode",
            mapActivityTypeCode(sar.primaryActivityType()));
        sa.appendChild(actTypes);

        parent.appendChild(sa);
    }

    private void appendSubjectParty(Document doc, Element parent, SarRecord sar) {
        // In production, load full subject details from customer service
        Element party = doc.createElement("Party");
        party.setAttribute("SeqNum", "2");
        appendText(doc, party, "PartyTypeCode", "35");  // 35 = Subject
        parent.appendChild(party);
    }

    private void appendNarrative(Document doc, Element parent, String narrative) {
        Element narr = doc.createElement("SARNarrative");
        appendText(doc, narr, "NarrativeText",
            truncateToMaxLength(narrative, 20000));  // FinCEN max = 20,000 characters
        parent.appendChild(narr);
    }

    private void appendFilingInstitution(Document doc, Element parent, String institutionId) {
        Element party = doc.createElement("Party");
        party.setAttribute("SeqNum", "1");
        appendText(doc, party, "PartyTypeCode", "37");  // 37 = Filing Institution
        parent.appendChild(party);
    }

    private String mapActivityTypeCode(SarActivityType type) {
        return switch (type) {
            case STRUCTURING           -> "G";
            case MONEY_LAUNDERING      -> "P";
            case UNUSUAL_WIRE_TRANSFER -> "X";
            case TERRORIST_FINANCING   -> "T";
            case CHECK_FRAUD           -> "B";
            case WIRE_FRAUD            -> "W";
            case IDENTITY_THEFT        -> "I";
            default                    -> "Z";  // Other
        };
    }

    private String truncateToMaxLength(String text, int maxLength) {
        if (text.length() <= maxLength) return text;
        return text.substring(0, maxLength - 3) + "...";
    }

    private void appendText(Document doc, Element parent, String tag, String value) {
        if (value == null) return;
        Element el = doc.createElement(tag);
        el.setTextContent(value);
        parent.appendChild(el);
    }

    private String serialize(Document doc) throws Exception {
        Transformer t = TransformerFactory.newInstance().newTransformer();
        t.setOutputProperty(OutputKeys.INDENT, "yes");
        t.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
        StringWriter sw = new StringWriter();
        t.transform(new DOMSource(doc), new StreamResult(sw));
        return sw.toString();
    }

    public void validate(String xml) {
        // Validate against FinCEN SAR XML Schema before submission
        // Schema available from FinCEN's BSA E-Filing technical documentation
    }
}
```

---

## SAR Approval Workflow with Deadline Enforcement

```java
package com.fintech.sar.workflow;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.List;

@Service
public class SarDeadlineService {

    private static final int WARNING_DAYS_BEFORE_DEADLINE = 7;
    private static final int ESCALATION_DAYS_BEFORE_DEADLINE = 3;

    private final SarRepository sarRepo;
    private final ComplianceNotificationService notificationService;
    private final AuditService auditService;

    /**
     * Runs daily to check SAR filing deadlines.
     * A missed SAR deadline is a regulatory violation that must be reported
     * to the institution's federal regulator in many cases.
     */
    @Scheduled(cron = "0 0 7 * * *", zone = "America/New_York")
    public void checkDeadlines() {
        LocalDate today = LocalDate.now();
        LocalDate warningCutoff    = today.plusDays(WARNING_DAYS_BEFORE_DEADLINE);
        LocalDate escalationCutoff = today.plusDays(ESCALATION_DAYS_BEFORE_DEADLINE);

        // SARs approaching deadline (within 7 days)
        List<SarRecord> approaching = sarRepo.findUnfiledWithDeadlineBefore(warningCutoff);
        approaching.forEach(sar ->
            notificationService.sendSarDeadlineWarning(sar, today));

        // SARs critically close to deadline (within 3 days)
        List<SarRecord> critical = sarRepo.findUnfiledWithDeadlineBefore(escalationCutoff);
        critical.forEach(sar ->
            notificationService.escalateSarDeadlineToBsaOfficer(sar, today));

        // SARs past deadline — regulatory violation
        List<SarRecord> overdue = sarRepo.findUnfiledWithDeadlineBefore(today);
        overdue.forEach(sar -> {
            auditService.logRegulatoryViolation(
                "SAR_DEADLINE_EXCEEDED",
                "SAR " + sar.sarId() + " for customer " + sar.customerId() +
                " exceeded filing deadline " + sar.filingDeadline() +
                " by " + java.time.temporal.ChronoUnit.DAYS.between(
                    sar.filingDeadline(), today) + " days",
                sar.customerId()
            );
            notificationService.notifyBsaOfficerAndLegal(sar, today);
        });
    }
}
```

---

## SAR Confidentiality Guard

The prohibition on tipping off the subject is one of the most serious compliance obligations. The system must enforce it architecturally:

```java
package com.fintech.sar.service;

import org.springframework.stereotype.Component;

/**
 * Enforces SAR confidentiality requirements under 31 U.S.C. § 5318(g)(2).
 *
 * The existence of a SAR, its contents, or even the fact that a SAR was considered
 * must NOT be disclosed to:
 *   - The subject of the SAR
 *   - The subject's attorney
 *   - Any person not authorized to know (FinCEN, law enforcement with proper process)
 *
 * This component provides a central enforcement point that all SAR-related
 * API responses and UI components must call before returning SAR data.
 */
@Component
public class ConfidentialityGuard {

    private final UserRoleRepository roleRepo;
    private final AuditService auditService;

    /**
     * Verify that the requesting user has authorization to access SAR data.
     * Throws an exception if unauthorized — never returns null or false.
     */
    public void verifyAccessAuthorized(String userId, String customerId) {
        UserRole role = roleRepo.getUserRole(userId);

        boolean authorized = switch (role) {
            case BSA_OFFICER     -> true;
            case SENIOR_ANALYST  -> true;
            case AML_ANALYST     -> true;
            case INTERNAL_AUDIT  -> true;
            case REGULATOR_READ  -> true;    // Examiners with proper credentials
            // These roles must NEVER see SAR data
            case RELATIONSHIP_MANAGER, CUSTOMER_SERVICE,
                 OPERATIONS, BRANCH_STAFF  -> false;
            default -> false;
        };

        if (!authorized) {
            auditService.logUnauthorizedSarAccess(userId, customerId);
            throw new SarConfidentialityViolationException(
                "User " + userId + " with role " + role +
                " is not authorized to access SAR data. " +
                "SAR data is strictly confidential under 31 U.S.C. § 5318(g)(2).");
        }

        auditService.logSarAccess(userId, customerId);
    }

    /**
     * When a customer calls to ask about a transaction hold or account restriction
     * that was triggered by a SAR, the representative may NOT tell the customer
     * that a SAR was filed. This method provides the approved response text.
     */
    public String getApprovedCustomerResponseForSarHold() {
        return "We are unable to provide specific information about this matter " +
            "at this time. If you have questions about your account, please contact " +
            "our compliance team at the number on your account statement.";
    }

    public enum UserRole {
        BSA_OFFICER, SENIOR_ANALYST, AML_ANALYST, INTERNAL_AUDIT,
        REGULATOR_READ, RELATIONSHIP_MANAGER, CUSTOMER_SERVICE,
        OPERATIONS, BRANCH_STAFF, SYSTEM_ADMIN
    }
}
```

---

## Batch SAR Filing Report

```java
package com.fintech.sar.reporting;

import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
public class SarReportingService {

    private final SarRepository sarRepo;

    /**
     * Monthly SAR metrics report for the BSA Officer and Board.
     * Regulators expect institutions to track and trend their SAR filing activity.
     */
    public SarMonthlyReport generateMonthlyReport(int year, int month) {
        LocalDate startDate = LocalDate.of(year, month, 1);
        LocalDate endDate   = startDate.withDayOfMonth(startDate.lengthOfMonth());

        List<SarRecord> filedSars = sarRepo.findFiledBetween(startDate, endDate);

        long totalFiled     = filedSars.size();
        long structuring    = countByType(filedSars, SarActivityType.STRUCTURING);
        long moneyLaundering = countByType(filedSars, SarActivityType.MONEY_LAUNDERING);
        long wireTransfer   = countByType(filedSars, SarActivityType.UNUSUAL_WIRE_TRANSFER);
        long totalAmount    = filedSars.stream()
            .mapToLong(s -> s.totalAmount().longValue())
            .sum();

        // On-time filing rate — target is 100%
        long onTime = filedSars.stream()
            .filter(s -> s.filedDate() != null
                && !s.filedDate().isAfter(s.filingDeadline()))
            .count();
        double onTimeRate = totalFiled > 0 ? (double) onTime / totalFiled : 1.0;

        List<SarRecord> overdueFilings = sarRepo.findFiledAfterDeadline(startDate, endDate);

        return new SarMonthlyReport(
            year, month,
            (int) totalFiled,
            (int) structuring,
            (int) moneyLaundering,
            (int) wireTransfer,
            totalAmount,
            onTimeRate,
            overdueFilings.size()
        );
    }

    private long countByType(List<SarRecord> sars, SarActivityType type) {
        return sars.stream()
            .filter(s -> s.primaryActivityType() == type)
            .count();
    }

    public record SarMonthlyReport(
        int year, int month,
        int totalFiled,
        int structuringCount,
        int moneyLaunderingCount,
        int wireTransferCount,
        long totalAmountDollars,
        double onTimeFilingRate,
        int overdueCount
    ) {}
}
```

---

## Production Operational Considerations

**Narrative quality gates:** Implement automated checks before allowing SAR submission: minimum narrative length (500 characters), presence of all six narrative sections, spell-check for key regulatory terms, verification that all transaction IDs in the narrative are valid references in the system.

**Joint filing coordination:** When two or more institutions are involved in the same suspicious activity (for example, the originating bank and the receiving bank for a wire transfer), they may file jointly using the same BSA ID. The coordinating institution leads the filing; the other institution must be listed as a participant. This requires out-of-band communication protocols between institutions.

**Law enforcement contact:** FinCEN maintains the Financial Crimes Enforcement Network, and law enforcement can query SAR data through the SAR Activity Review database. Some institutions receive voluntary information requests from law enforcement referencing a specific SAR BSA ID. The response protocol must maintain confidentiality — confirm that a report was filed (if the law enforcement officer has a court order) but never share the SAR content without proper legal process.

**SAR database access controls:** The SAR database table must have column-level access controls. Specifically: the `narrative` column, the `bsa_identifier` column, and all personally identifiable information fields must be accessible only to BSA Officer role and above. The database schema should enforce this using row-level security (PostgreSQL RLS) in addition to application-layer controls.

**Continuing SARs:** When suspicious activity is ongoing, file an initial SAR and then file "continuing" SARs every 90 days while the activity continues. The continuing SAR references the original SAR's BSA ID. Build a scheduler that identifies open SAR cases with ongoing activity and prompts for a continuing filing 85 days after the last filing.

---

## Summary

SAR filing automation serves both efficiency and quality goals. The engineering principles:

1. **The 30-day clock starts at detection, not disposition** — build the detection date into every SAR record from day one and calculate the deadline at creation time.
2. **Narrative quality is the most important output** — FinCEN's six-element structure (Who/What/When/Where/How/Why) makes SARs actionable for law enforcement.
3. **Confidentiality is an absolute architectural constraint** — it must be enforced at the database, API, and UI layers, not just by training.
4. **Amendment workflows are mandatory** — a SAR with material errors must be corrected; build the amendment workflow before you need it.
5. **Deadline tracking must escalate automatically** — no institution should miss a SAR deadline because a human forgot; the system must escalate to the BSA Officer before the deadline expires.
6. **5-year record retention is non-negotiable** — all supporting documentation (transaction records, investigation notes, alert history) must be retained with the SAR for 5 years from the filing date.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Under 31 U.S.C. § 5318(g)(2), what is the absolute prohibition that financial institutions must enforce architecturally when filing a SAR?",
      "options": ["Filing a SAR for transactions under $5,000", "Notifying the subject of the SAR that it was filed — not even the customer's attorney can be told", "Filing a SAR without first notifying FinCEN by phone", "Using automated systems to generate SAR narratives"],
      "correct": 1,
      "explanation": "The SAR confidentiality provision in 31 U.S.C. § 5318(g)(2) prohibits the institution from notifying the subject that a SAR was filed. This is an absolute prohibition. The system must enforce this at the database level (column-level access controls), API level, and UI level — not just through training."
    },
    {
      "text": "FinCEN's SAR narrative guidance specifies six elements that a good narrative must address. What are they?",
      "options": ["Account details, transaction history, risk score, detection method, analyst notes, and filing date", "Who is involved, what instruments were used, when the activity occurred, where it took place, how it occurred, and why it is suspicious", "Subject identity, account numbers, transaction amounts, counterparties, jurisdiction, and disposition", "Detection date, alert type, scenario code, risk rating, investigation notes, and institution action"],
      "correct": 1,
      "explanation": "FinCEN's 2012 SAR narrative guidance specifies that a quality narrative must address: WHO is involved (subject information), WHAT instruments or mechanisms were used, WHEN the activity occurred, WHERE it took place, HOW the activity occurred, and WHY the institution considers it suspicious. Missing elements result in a SAR that law enforcement may deprioritise."
    },
    {
      "text": "When must a 'continuing SAR' be filed for ongoing suspicious activity?",
      "options": ["Every 30 days while activity continues", "Every 60 days after the initial SAR", "Every 90 days while the suspicious activity continues, referencing the original SAR's BSA ID", "Only when new suspects are identified"],
      "correct": 2,
      "explanation": "When suspicious activity is ongoing, an initial SAR is filed and then continuing SARs are filed every 90 days while the activity persists. Each continuing SAR references the original BSA ID. A scheduler should identify open SAR cases with ongoing activity and trigger a continuing filing prompt at day 85 to allow preparation time."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement a SAR Filing Pipeline with Narrative Generation",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "Implement the SarNarrativeGenerator that produces FinCEN-compliant narratives for three SAR activity types: STRUCTURING (citing 31 U.S.C. § 5324 with individual transaction details), MONEY_LAUNDERING (describing fund flow and layering), and UNUSUAL_WIRE_TRANSFER (describing international transfers inconsistent with customer profile). Include a validateNarrative() method that checks for all six required sections and minimum 500-character length."},
    {"id": "2", "description": "Implement the SarConfidentialityGuard with a verifyAccessAuthorized() method that permits access only to BSA_OFFICER, SENIOR_ANALYST, AML_ANALYST, INTERNAL_AUDIT, and REGULATOR_READ roles — and explicitly denies RELATIONSHIP_MANAGER, CUSTOMER_SERVICE, OPERATIONS, and BRANCH_STAFF. Log all access attempts (authorised and denied) to the audit trail. Provide a getApprovedCustomerResponseForSarHold() method that returns the approved script."},
    {"id": "3", "description": "Implement the SarDeadlineService @Scheduled component that runs daily at 7 AM and: (a) sends warnings for SARs due within 7 days, (b) escalates to BSA Officer for SARs due within 3 days, (c) logs a regulatory violation event for any SAR past its deadline and notifies BSA Officer and Legal. The 30-day deadline must be calculated from the detection date (alert creation), not the disposition date."},
    {"id": "4", "description": "Write an integration test suite: (a) create a SAR and verify its filing deadline is 30 days from the alert detection date; (b) attempt to access SAR data with CUSTOMER_SERVICE role and verify a SarConfidentialityViolationException is thrown and an unauthorized access audit event is logged; (c) generate a structuring narrative and assert it contains all six required sections and the $ transaction amounts; (d) validate that the same SAR initiated twice for the same alert does not create duplicate SAR records."}
  ]
}
-->
