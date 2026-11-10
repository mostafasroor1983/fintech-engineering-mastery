---
id: track-07-lesson-02
title: "KYC Engine — Know Your Customer Data Architecture"
slug: kyc-engine
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 2
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [KYC, identity-verification, document-checks, CDD, EDD]
prerequisites: [track-07-lesson-01]
---

# KYC Engine — Know Your Customer Data Architecture

> [!NOTE]
> KYC is not a one-time checkbox at onboarding. It is a continuous data management discipline. Customer risk profiles change, documents expire, and regulatory requirements evolve. A KYC engine that cannot trigger re-verification or adapt to new regulations will fail your compliance audit — and potentially expose the institution to significant fines.

## KYC Regulatory Context

KYC requirements derive from the Financial Action Task Force (FATF) recommendations and are implemented through national legislation:
- **UK**: Money Laundering Regulations 2017 (MLR 2017), transposing the EU 4th and 5th AML Directives
- **EU**: AMLD5 (Directive 2018/843), AMLD6 (Directive 2018/1673)
- **US**: Bank Secrecy Act (BSA), FinCEN Customer Due Diligence Rule (2016)

Core obligations:
1. **Customer Identification Program (CIP)** — Verify who the customer is
2. **Customer Due Diligence (CDD)** — Understand the customer's risk profile
3. **Enhanced Due Diligence (EDD)** — Deeper scrutiny for higher-risk customers (PEPs, high-value, complex structures)
4. **Ongoing Monitoring** — Keep information current; re-verify on trigger events

---

## KYC Data Model

```java
// Core customer entity with KYC state
@Entity
@Table(name = "customers")
public class Customer {

    @Id
    private UUID id;

    // Personal identity
    private String firstName;
    private String lastName;
    private LocalDate dateOfBirth;
    private String nationality;
    private String countryOfResidence;

    // Contact
    @Encrypted  // custom annotation — field-level encryption
    private String email;
    @Encrypted
    private String phoneNumber;

    // Address — encrypted at rest
    @Embedded
    @AttributeOverrides({
        @AttributeOverride(name = "line1", column = @Column(name = "address_line1")),
        @AttributeOverride(name = "postcode", column = @Column(name = "address_postcode"))
    })
    private EncryptedAddress address;

    // KYC state
    @Enumerated(EnumType.STRING)
    private KycStatus kycStatus;

    @Enumerated(EnumType.STRING)
    private CustomerRiskRating riskRating;

    @Enumerated(EnumType.STRING)
    private DueDiligenceLevel dueDiligenceLevel;

    private Instant kycApprovedAt;
    private Instant kycNextReviewDate;
    private Instant kycLastVerifiedAt;
    private String kycApprovedByUserId;

    // Relationship
    private boolean isPep;
    private boolean isSanctioned;
    private boolean isAdverseMedia;

    @Version
    private long version;
    private Instant createdAt;
    private Instant updatedAt;
}

public enum KycStatus {
    PENDING_VERIFICATION,       // Initial state — no documents submitted
    DOCUMENTS_SUBMITTED,        // Customer submitted documents
    UNDER_REVIEW,               // Manual or automated review in progress
    APPROVED,                   // KYC passed
    REJECTED,                   // KYC failed — cannot onboard
    SUSPENDED,                  // Approved but suspended pending investigation
    EXPIRED,                    // Approval expired — re-verification required
    EDD_REQUIRED                // Escalated to Enhanced Due Diligence
}

public enum CustomerRiskRating {
    LOW,        // Standard CDD; review every 3-5 years
    MEDIUM,     // Enhanced monitoring; review every 1-2 years
    HIGH,       // EDD required; review every 6-12 months
    VERY_HIGH   // EDD + senior management approval; review every 3-6 months
}

public enum DueDiligenceLevel {
    SIMPLIFIED,     // SDD — eligible low-risk customers only
    STANDARD,       // CDD — most customers
    ENHANCED        // EDD — PEPs, high-risk countries, complex structures
}
```

---

## Document Verification Data Model

```java
@Entity
@Table(name = "kyc_documents")
public class KycDocument {

    @Id
    private UUID id;

    private UUID customerId;

    @Enumerated(EnumType.STRING)
    private DocumentType documentType;

    @Enumerated(EnumType.STRING)
    private DocumentStatus status;

    // Document data — stored encrypted in object storage, not DB
    private String storageReference;        // S3/GCS object key
    private String storageChecksumSha256;   // tamper detection

    // Document metadata
    private String issuingCountry;
    private String documentNumber;         // encrypted
    private LocalDate dateOfIssue;
    private LocalDate expiryDate;

    // Verification results
    private boolean liveness;              // liveness check passed
    private boolean documentAuthenticity; // not tampered/forged
    private boolean faceMatch;            // selfie matches document photo
    private BigDecimal verificationScore; // 0.0–1.0 confidence score

    // Provider details
    private String providerId;             // e.g., "onfido", "jumio"
    private String providerCheckId;        // external reference
    private String providerReportJson;     // full report stored as JSON blob

    private Instant submittedAt;
    private Instant verifiedAt;
    private String verifiedByUserId;
}

public enum DocumentType {
    PASSPORT,
    NATIONAL_ID_CARD,
    DRIVING_LICENCE,
    RESIDENCE_PERMIT,
    PROOF_OF_ADDRESS_UTILITY_BILL,
    PROOF_OF_ADDRESS_BANK_STATEMENT,
    COMPANY_REGISTRATION,
    DIRECTORS_LIST,
    BENEFICIAL_OWNERSHIP_DECLARATION
}

public enum DocumentStatus {
    UPLOADED,
    VERIFICATION_IN_PROGRESS,
    VERIFIED,
    REJECTED,           // Failed automated check
    MANUAL_REVIEW,      // Automated check uncertain — needs human
    EXPIRED             // Document expiry date passed
}
```

---

## KYC State Machine

The KYC process follows a defined state machine. Transitions are logged for audit.

```java
@Service
@Slf4j
public class KycStateMachine {

    private final CustomerRepository customerRepository;
    private final KycAuditLogRepository auditLogRepository;
    private final KycEventPublisher eventPublisher;

    public Customer transition(UUID customerId, KycEvent event, String actorId, String reason) {
        Customer customer = customerRepository.findByIdForUpdate(customerId)
            .orElseThrow(() -> new CustomerNotFoundException(customerId));

        KycStatus newStatus = resolveTransition(customer.getKycStatus(), event);

        log.info("KYC transition customerId={} from={} event={} to={} actor={}",
            customerId, customer.getKycStatus(), event, newStatus, actorId);

        customer.setKycStatus(newStatus);
        customer.setUpdatedAt(Instant.now());
        applyStatusEffects(customer, newStatus, actorId);

        customerRepository.save(customer);
        auditLogRepository.save(new KycAuditLog(
            UUID.randomUUID(), customerId, customer.getKycStatus(),
            newStatus, event, actorId, reason, Instant.now()
        ));
        eventPublisher.publish(new KycStatusChangedEvent(customerId, newStatus, event));

        return customer;
    }

    private KycStatus resolveTransition(KycStatus current, KycEvent event) {
        return switch (current) {
            case PENDING_VERIFICATION -> switch (event) {
                case DOCUMENTS_RECEIVED -> KycStatus.DOCUMENTS_SUBMITTED;
                default                 -> throw new InvalidKycTransitionException(current, event);
            };
            case DOCUMENTS_SUBMITTED -> switch (event) {
                case REVIEW_STARTED     -> KycStatus.UNDER_REVIEW;
                default                 -> throw new InvalidKycTransitionException(current, event);
            };
            case UNDER_REVIEW -> switch (event) {
                case APPROVED           -> KycStatus.APPROVED;
                case REJECTED           -> KycStatus.REJECTED;
                case EDD_REQUIRED       -> KycStatus.EDD_REQUIRED;
                default                 -> throw new InvalidKycTransitionException(current, event);
            };
            case APPROVED -> switch (event) {
                case SUSPENDED          -> KycStatus.SUSPENDED;
                case REVIEW_DUE         -> KycStatus.PENDING_VERIFICATION;
                case EDD_REQUIRED       -> KycStatus.EDD_REQUIRED;
                default                 -> throw new InvalidKycTransitionException(current, event);
            };
            case EDD_REQUIRED -> switch (event) {
                case APPROVED           -> KycStatus.APPROVED;
                case REJECTED           -> KycStatus.REJECTED;
                default                 -> throw new InvalidKycTransitionException(current, event);
            };
            case EXPIRED -> switch (event) {
                case DOCUMENTS_RECEIVED -> KycStatus.DOCUMENTS_SUBMITTED;
                default                 -> throw new InvalidKycTransitionException(current, event);
            };
            default -> throw new InvalidKycTransitionException(current, event);
        };
    }

    private void applyStatusEffects(Customer customer, KycStatus newStatus, String actorId) {
        switch (newStatus) {
            case APPROVED -> {
                customer.setKycApprovedAt(Instant.now());
                customer.setKycApprovedByUserId(actorId);
                customer.setKycNextReviewDate(calculateNextReviewDate(customer.getRiskRating()));
            }
            case REJECTED -> {
                customer.setKycApprovedAt(null);
                customer.setKycNextReviewDate(null);
            }
            case EXPIRED -> {
                customer.setKycApprovedAt(null);
            }
        }
    }

    private Instant calculateNextReviewDate(CustomerRiskRating rating) {
        Duration reviewPeriod = switch (rating) {
            case LOW       -> Duration.ofDays(365 * 5);  // 5 years
            case MEDIUM    -> Duration.ofDays(365 * 2);  // 2 years
            case HIGH      -> Duration.ofDays(365);      // 1 year
            case VERY_HIGH -> Duration.ofDays(180);      // 6 months
        };
        return Instant.now().plus(reviewPeriod);
    }
}

public enum KycEvent {
    DOCUMENTS_RECEIVED,
    REVIEW_STARTED,
    APPROVED,
    REJECTED,
    EDD_REQUIRED,
    SUSPENDED,
    REINSTATED,
    REVIEW_DUE,
    DOCUMENT_EXPIRED
}
```

---

## Third-Party Identity Provider Integration

Production KYC engines integrate with specialist identity verification providers. The integration pattern is webhook-driven: submit check, receive callback when complete.

```java
@Service
@Slf4j
public class OnfidoKycProvider implements KycProvider {

    private final OnfidoClient onfidoClient;
    private final KycDocumentRepository documentRepository;
    private final KycStateMachine stateMachine;

    @Override
    public KycCheckReference initiateCheck(UUID customerId, UUID documentId) {
        KycDocument document = documentRepository.findById(documentId)
            .orElseThrow();

        // Create Onfido applicant
        Applicant applicant = onfidoClient.createApplicant(ApplicantRequest.builder()
            .firstName(document.getFirstName())
            .lastName(document.getLastName())
            .dob(document.getDateOfBirth())
            .build());

        // Upload document to Onfido
        Document onfidoDoc = onfidoClient.uploadDocument(applicant.getId(),
            DocumentUploadRequest.builder()
                .type(mapDocumentType(document.getDocumentType()))
                .file(storageService.download(document.getStorageReference()))
                .build());

        // Create check
        Check check = onfidoClient.createCheck(CheckRequest.builder()
            .applicantId(applicant.getId())
            .reportNames(List.of("document", "facial_similarity_photo"))
            .build());

        documentRepository.updateProviderDetails(documentId, "onfido", check.getId());

        return new KycCheckReference(check.getId(), applicant.getId());
    }

    // Called by webhook when Onfido completes verification
    @Override
    public void handleWebhookResult(String providerCheckId, String webhookPayload) {
        validateWebhookSignature(webhookPayload);  // HMAC-SHA256 verification

        OnfidoWebhookEvent event = parseWebhook(webhookPayload);
        KycDocument document = documentRepository.findByProviderCheckId(providerCheckId)
            .orElseThrow();

        Check check = onfidoClient.getCheck(providerCheckId);
        VerificationResult result = mapCheckResult(check);

        documentRepository.updateVerificationResult(document.getId(), result);

        KycEvent kycEvent = result.passed()
            ? (requiresEdd(check) ? KycEvent.EDD_REQUIRED : KycEvent.APPROVED)
            : KycEvent.REJECTED;

        stateMachine.transition(document.getCustomerId(), kycEvent, "onfido-webhook", result.reason());
    }

    private boolean requiresEdd(Check check) {
        return check.getReports().stream()
            .anyMatch(r -> r.getName().equals("pep_sanction")
                && r.getResult().equals("consider"));
    }
}
```

---

## CDD vs EDD: Risk-Based Approach

```java
@Service
public class DueDiligenceAssessor {

    private final PepScreeningService pepService;
    private final SanctionsScreeningService sanctionsService;
    private final AdverseMediaService adverseMediaService;
    private final CountryRiskService countryRiskService;

    public DueDiligenceAssessment assess(Customer customer, List<KycDocument> documents) {
        List<RiskFactor> riskFactors = new ArrayList<>();

        // Check PEP status
        PepResult pepResult = pepService.checkCustomer(customer);
        if (pepResult.isPep()) {
            riskFactors.add(new RiskFactor(
                RiskFactorType.PEP, RiskLevel.HIGH,
                "Customer is a Politically Exposed Person: " + pepResult.pepCategory()
            ));
        }

        // Check sanctions
        SanctionsResult sanctionsResult = sanctionsService.check(customer);
        if (sanctionsResult.isMatch()) {
            riskFactors.add(new RiskFactor(
                RiskFactorType.SANCTIONS, RiskLevel.VERY_HIGH,
                "Sanctions match: " + sanctionsResult.listName() + " score=" + sanctionsResult.score()
            ));
        }

        // Country risk
        CountryRisk countryRisk = countryRiskService.assess(
            customer.getNationality(), customer.getCountryOfResidence()
        );
        if (countryRisk.isHighRisk()) {
            riskFactors.add(new RiskFactor(
                RiskFactorType.HIGH_RISK_COUNTRY, RiskLevel.HIGH,
                "High-risk country: " + countryRisk.country() + " reason=" + countryRisk.reason()
            ));
        }

        // Adverse media
        AdverseMediaResult adverseMedia = adverseMediaService.search(
            customer.getFullName(), customer.getDateOfBirth()
        );
        if (adverseMedia.hasAdverseMedia()) {
            riskFactors.add(new RiskFactor(
                RiskFactorType.ADVERSE_MEDIA, RiskLevel.MEDIUM,
                "Adverse media found: " + adverseMedia.summary()
            ));
        }

        // Determine due diligence level
        DueDiligenceLevel ddLevel = calculateDueDiligenceLevel(riskFactors);
        CustomerRiskRating riskRating = calculateRiskRating(riskFactors);

        return new DueDiligenceAssessment(ddLevel, riskRating, riskFactors, Instant.now());
    }

    private DueDiligenceLevel calculateDueDiligenceLevel(List<RiskFactor> factors) {
        boolean hasVeryHighRisk = factors.stream().anyMatch(f -> f.level() == RiskLevel.VERY_HIGH);
        boolean hasHighRisk = factors.stream().anyMatch(f -> f.level() == RiskLevel.HIGH);

        // MLRO must approve EDD
        if (hasVeryHighRisk || hasHighRisk) return DueDiligenceLevel.ENHANCED;
        if (factors.isEmpty()) return DueDiligenceLevel.SIMPLIFIED; // only for certain customer types
        return DueDiligenceLevel.STANDARD;
    }
}
```

---

## KYC Re-Verification Triggers

```java
@Service
@Slf4j
public class KycReVerificationScheduler {

    private final CustomerRepository customerRepository;
    private final KycStateMachine stateMachine;
    private final KycNotificationService notificationService;

    // Daily job to flag customers due for review
    @Scheduled(cron = "0 2 * * *") // 02:00 UTC daily
    public void flagExpiredAndDueForReview() {
        Instant now = Instant.now();

        // Customers past their next review date
        customerRepository.findByKycNextReviewDateBefore(now)
            .forEach(customer -> {
                log.info("KYC review due customerId={} dueDate={}",
                    customer.getId(), customer.getKycNextReviewDate());
                stateMachine.transition(customer.getId(), KycEvent.REVIEW_DUE,
                    "system-scheduler", "Periodic review due");
                notificationService.sendReVerificationRequest(customer);
            });

        // Documents expiring in next 30 days
        customerRepository.findWithDocumentsExpiringBefore(now.plus(Duration.ofDays(30)))
            .forEach(customer -> {
                log.info("KYC document expiring customerId={}", customer.getId());
                notificationService.sendDocumentExpiryWarning(customer);
            });
    }

    // Event-driven trigger: account behaviour changes
    public void triggerReVerification(UUID customerId, ReVerificationTrigger trigger) {
        log.info("Re-verification triggered customerId={} trigger={}", customerId, trigger);
        switch (trigger) {
            case PEP_STATUS_CHANGED,
                 SANCTIONS_HIT,
                 HIGH_VALUE_TRANSACTION_DETECTED,
                 ADVERSE_MEDIA_DETECTED ->
                stateMachine.transition(customerId, KycEvent.EDD_REQUIRED,
                    "risk-engine", trigger.name());
            case COUNTRY_OF_RESIDENCE_CHANGED,
                 SIGNIFICANT_TRANSACTION_PATTERN_CHANGE ->
                stateMachine.transition(customerId, KycEvent.REVIEW_DUE,
                    "risk-engine", trigger.name());
        }
    }
}

public enum ReVerificationTrigger {
    PEP_STATUS_CHANGED,
    SANCTIONS_HIT,
    HIGH_VALUE_TRANSACTION_DETECTED,
    ADVERSE_MEDIA_DETECTED,
    COUNTRY_OF_RESIDENCE_CHANGED,
    SIGNIFICANT_TRANSACTION_PATTERN_CHANGE,
    CUSTOMER_REQUESTED_PRODUCT_UPGRADE,
    ANNUAL_REVIEW_DUE
}
```

---

## KYC Data Retention and Encryption

```java
// Field-level encryption for PII
@Component
public class KycEncryptionService {

    private final KeyManagementService kms;

    // Encrypts a field using the customer's data encryption key
    public String encryptField(UUID customerId, String plaintext) {
        DataKey dataKey = kms.getOrCreateDataKey(customerId);
        return AesGcmCipher.encrypt(plaintext, dataKey.plaintextKey());
    }

    public String decryptField(UUID customerId, String ciphertext) {
        DataKey dataKey = kms.getDataKey(customerId);
        return AesGcmCipher.decrypt(ciphertext, dataKey.plaintextKey());
    }

    // Right-to-erasure: destroy the customer's data key
    // This effectively renders all encrypted PII unreadable
    public void cryptographicErasure(UUID customerId) {
        kms.deleteDataKey(customerId);
        log.info("Cryptographic erasure performed for customerId={}", customerId);
    }
}

// Data retention policy enforcement
@Service
@Slf4j
public class KycRetentionService {

    // Regulatory minimum: 5 years after end of business relationship (MLR 2017)
    private static final Duration RETENTION_PERIOD = Duration.ofDays(365 * 5);

    @Scheduled(cron = "0 3 * * 0") // weekly at 03:00 UTC Sunday
    public void enforceRetentionPolicy() {
        Instant cutoff = Instant.now().minus(RETENTION_PERIOD);

        // Find customers whose relationship ended >5 years ago
        customerRepository.findByRelationshipEndedBefore(cutoff)
            .forEach(customer -> {
                log.info("Applying retention policy customerId={} relationshipEnded={}",
                    customer.getId(), customer.getRelationshipEndedAt());

                // Anonymise personal data but retain transaction records
                anonymisePersonalData(customer);

                // Destroy encryption key — renders encrypted fields unreadable
                encryptionService.cryptographicErasure(customer.getId());

                // Mark as anonymised in audit log
                auditLogRepository.recordAnonymisation(customer.getId(), Instant.now());
            });
    }

    private void anonymisePersonalData(Customer customer) {
        customer.setFirstName("ANONYMISED");
        customer.setLastName("ANONYMISED");
        customer.setEmail(null);
        customer.setPhoneNumber(null);
        customer.setDateOfBirth(null);
        customer.setAddress(null);
        customerRepository.save(customer);
    }
}
```

---

## KYC REST API

```java
@RestController
@RequestMapping("/kyc")
@Slf4j
public class KycController {

    private final KycOrchestrationService kycService;
    private final KycQueryService kycQueryService;

    @PostMapping("/customers/{customerId}/documents")
    @PreAuthorize("hasRole('KYC_SUBMITTER')")
    public ResponseEntity<DocumentSubmissionResponse> submitDocument(
        @PathVariable UUID customerId,
        @RequestParam DocumentType documentType,
        @RequestParam MultipartFile file
    ) {
        log.info("Document submission customerId={} type={} size={}",
            customerId, documentType, file.getSize());

        DocumentSubmissionResponse response = kycService.submitDocument(
            customerId, documentType, file
        );

        return ResponseEntity.accepted().body(response);
    }

    @GetMapping("/customers/{customerId}/status")
    @PreAuthorize("hasAnyRole('KYC_VIEWER', 'COMPLIANCE_OFFICER')")
    public ResponseEntity<KycStatusResponse> getKycStatus(@PathVariable UUID customerId) {
        return ResponseEntity.ok(kycQueryService.getStatus(customerId));
    }

    @PostMapping("/customers/{customerId}/approve")
    @PreAuthorize("hasRole('KYC_APPROVER')")
    public ResponseEntity<KycApprovalResponse> approveKyc(
        @PathVariable UUID customerId,
        @RequestBody KycApprovalRequest request,
        @AuthenticationPrincipal UserDetails approver
    ) {
        log.info("KYC approval customerId={} approver={}", customerId, approver.getUsername());
        KycApprovalResponse response = kycService.approve(customerId, request, approver.getUsername());
        return ResponseEntity.ok(response);
    }

    @PostMapping("/customers/{customerId}/reject")
    @PreAuthorize("hasRole('KYC_APPROVER')")
    public ResponseEntity<Void> rejectKyc(
        @PathVariable UUID customerId,
        @RequestBody KycRejectionRequest request,
        @AuthenticationPrincipal UserDetails approver
    ) {
        kycService.reject(customerId, request, approver.getUsername());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/customers/{customerId}/escalate-edd")
    @PreAuthorize("hasRole('COMPLIANCE_OFFICER')")
    public ResponseEntity<Void> escalateToEdd(
        @PathVariable UUID customerId,
        @RequestBody EddEscalationRequest request,
        @AuthenticationPrincipal UserDetails officer
    ) {
        kycService.escalateToEdd(customerId, request, officer.getUsername());
        return ResponseEntity.noContent().build();
    }
}
```

---

## Production Considerations

**Four-eyes principle on approvals**: KYC approval for high-risk customers (EDD) must require a second approver. Implement dual-control using the `approvedByUserId` and `secondApproverUserId` fields with application-level enforcement, not just UI controls.

**Document storage segregation**: Store KYC documents in a separate S3 bucket with:
- Server-side encryption (SSE-KMS)
- Bucket-level access logs
- Versioning enabled
- Block public access
- Cross-region replication for disaster recovery
- Lifecycle rules aligning with retention policy

**False positive management for third-party checks**: Onfido and Jumio have false positive rates of 1-3% for legitimate customers. Build a manual review queue and track override rates. An override rate >10% suggests your automated checks are misconfigured.

**Audit log immutability**: The KYC audit log must be append-only and tamper-proof. Use PostgreSQL's `INSERT-only` pattern — no UPDATE or DELETE on the audit table, enforced by row-level security policy.

**Regulatory exam readiness**: Regulators will request to see the full KYC file for specific customers during an examination. Build a customer KYC package export endpoint that produces a PDF containing all documents, verification results, risk assessments, and state transitions for a given customer.

**Key metrics to monitor**:
- `kyc.status` by `status` — number of customers in each KYC state
- `kyc.documents.verification.duration` histogram — provider SLA tracking
- `kyc.reviews.pending` gauge — manual review queue depth
- `kyc.approved_rate` — percentage of submitted applications approved
- `kyc.edd_escalation_rate` — percentage escalated to EDD

---

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "A customer's KYC status is APPROVED. Their account is flagged by the risk engine as high-risk due to a suspicious transaction pattern. What state transition should occur?",
      "options": [
        "APPROVED → REJECTED, requiring a new application",
        "APPROVED → PENDING_VERIFICATION with EDD required",
        "APPROVED → EXPIRED to trigger automatic re-verification",
        "APPROVED → SUSPENDED until manual review is complete"
      ],
      "correct": 1,
      "explanation": "When a customer's risk level increases, the correct transition is to PENDING_VERIFICATION with Enhanced Due Diligence (EDD) required. This preserves the audit trail of the existing approval while requiring additional verification commensurate with the elevated risk level."
    },
    {
      "text": "Your KYC provider (Onfido) sends a webhook confirming document verification. The same webhook is delivered twice due to a network retry. What is the safest way to handle this?",
      "options": [
        "Process both webhooks — the second will be a no-op since status is already APPROVED",
        "Use a unique constraint on the external provider reference ID and deduplicate on insert",
        "Ignore all duplicate webhooks using a Redis bloom filter",
        "Accept the first webhook and reject the second with 409 Conflict"
      ],
      "correct": 1,
      "explanation": "Using a unique database constraint on the external provider reference ID ensures idempotency at the storage layer. The first insert succeeds; the second raises a constraint violation that can be caught and treated as a no-op. This is safer than application-level deduplication which can have race conditions."
    },
    {
      "text": "A customer submits a GDPR right-to-erasure request. AML regulations require retaining KYC data for 5 years. How should the KYC engine handle this conflict?",
      "options": [
        "Reject the erasure request citing AML obligations",
        "Erase all data immediately — GDPR supersedes AML regulations",
        "Retain AML-required fields under the legal obligation lawful basis and erase optional personal data",
        "Pseudonymise all personal data and treat it as erased"
      ],
      "correct": 2,
      "explanation": "GDPR Article 17(3)(b) allows retention when processing is necessary for compliance with a legal obligation. AML regulations impose a legal obligation to retain KYC records. The correct approach retains only AML-mandated data under the legal obligation basis and erases all other personal data, documenting the conflict resolution in the audit trail."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "Build a KYC Re-verification Trigger System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": 1,
      "description": "Implement a KYC state machine that handles the transitions PENDING_VERIFICATION → APPROVED → EXPIRED and APPROVED → PENDING_VERIFICATION (risk escalation path). Include guard conditions ensuring EDD is required when the customer risk tier is HIGH or VERY_HIGH before transitioning to APPROVED."
    },
    {
      "id": 2,
      "description": "Build a KafkaConsumer that listens on a 'risk-level-changed' topic. When a customer's risk level changes from STANDARD to HIGH or above, publish a re-verification event that sets the KYC state back to PENDING_VERIFICATION and records the trigger reason in the audit trail."
    },
    {
      "id": 3,
      "description": "Implement an idempotent Onfido webhook handler that processes document verification results. The handler must deduplicate using the Onfido check ID as a unique constraint, transition state correctly, and emit an audit event for every state change with the external reference ID."
    },
    {
      "id": 4,
      "description": "Design a DataRetentionService that handles right-to-erasure requests for KYC data. The service must retain all fields tagged with retainedForAml=true for 5 years under the legal obligation basis, cryptographically erase all other personal data fields, and log the erasure scope to the compliance audit trail."
    }
  ]
} -->
