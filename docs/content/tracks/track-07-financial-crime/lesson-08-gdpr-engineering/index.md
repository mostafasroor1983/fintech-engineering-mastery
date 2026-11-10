---
id: "track-07-lesson-08"
title: "GDPR Engineering — Data Privacy by Design"
track: "track-07"
track-name: "Financial Crime, Compliance & Risk Engineering"
sequence: 8
slug: "gdpr-engineering"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"

prerequisites:
  - "track-07-lesson-07"

tags:
  - "GDPR"
  - "data-privacy"
  - "right-to-erasure"
  - "consent"
  - "data-minimisation"

java-versions: [17, 21]

topics:
  - "GDPR Core Principles"
  - "Consent Management"
  - "Right to Erasure"
  - "Pseudonymisation"
  - "Data Subject Access Requests"
  - "Retention Conflicts with AML"
  - "Data Residency"

components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "GDPR — Regulation (EU) 2016/679"
  - "ICO Guide to GDPR — ico.org.uk"
  - "EDPB Guidelines on Right of Erasure"
  - "FCA GDPR and Financial Crime Guidance — PS18/16"
---

GDPR is not a documentation exercise. For engineers in fintech it is a set of hard architectural constraints: data you never collect cannot be breached; data you delete cannot be subpoenaed; data you pseudonymise limits blast radius when a breach occurs. The challenge is that financial services also carry a parallel obligation — AML, PEP screening, and CTR records must be retained for seven years. These two regimes collide on exactly the records that matter most.

This lesson treats GDPR as an engineering discipline: consent as a schema, erasure as a service, field-level tagging as an annotation, and the AML retention conflict as a solvable architecture problem.

## Learning Objectives

By the end of this lesson you will be able to:

- Explain the six GDPR lawful bases and select the correct one for fintech processing activities
- Design a consent management schema with version tracking and withdrawal support
- Implement right-to-erasure using pseudonymisation rather than deletion for AML-retained records
- Build a `GdprErasureService` that replaces PII with deterministic tokens while preserving referential integrity
- Automate Data Subject Access Requests (DSARs) end-to-end from intake to delivery
- Apply a custom `@PersonalData` annotation to identify PII fields at compile time
- Explain the AML / GDPR retention conflict and document the lawful basis for retaining data under Article 17(3)(b)
- Describe data residency requirements and when Standard Contractual Clauses (SCCs) are needed for cross-border transfers

## Business Context

In July 2023 the Irish Data Protection Commission fined Meta €1.2 billion — the largest GDPR fine in history — for transferring EU user data to the United States without adequate safeguards. That fine is an order of magnitude larger than most fintech annual revenues.

Closer to home, in 2021 a UK neobank received an ICO enforcement notice after a data subject's erasure request was fulfilled by deleting their transaction records — records the FCA subsequently required for an AML investigation. The firm faced simultaneous regulatory action from two bodies for contradictory reasons.

The lesson drawn by principal engineers at that firm: erasure under GDPR and retention under AMLD5 are not contradictory if you understand the architecture. GDPR Article 17(3) explicitly carves out retention obligations imposed by Union or Member State law. The correct implementation pseudonymises the PII while keeping the financial record. That is the pattern this lesson teaches.

## GDPR Core Principles for Engineers

GDPR Article 5 defines six principles. Each has a direct engineering implication:

| Principle | GDPR Article | Engineering Implication |
|---|---|---|
| **Lawfulness, fairness, transparency** | Art. 5(1)(a) | Log the lawful basis at collection time |
| **Purpose limitation** | Art. 5(1)(b) | Tag data with the purpose it was collected for; block re-use |
| **Data minimisation** | Art. 5(1)(c) | Collect only fields actually used in processing |
| **Accuracy** | Art. 5(1)(d) | Provide correction endpoints; validate at write time |
| **Storage limitation** | Art. 5(1)(e) | Set retention periods at schema design time, not post-hoc |
| **Integrity and confidentiality** | Art. 5(1)(f) | Encrypt at rest and in transit; audit access |

The six **lawful bases** (Art. 6) for processing personal data in fintech:

| Basis | Code | Typical Fintech Use |
|---|---|---|
| Consent | `6a` | Marketing emails, non-essential cookies |
| **Contract** | `6b` | Processing a payment, opening an account |
| Legal obligation | `6c` | AML checks, CTR filing, FATCA reporting |
| Vital interests | `6d` | Fraud prevention affecting physical safety (rare) |
| Public task | `6e` | Not applicable to private firms |
| **Legitimate interests** | `6f` | Fraud detection, security monitoring |

> [!IMPORTANT]
> Most payment processing is lawful under **Art. 6(1)(b) — contract performance**, not consent. Consent is the most fragile basis (can be withdrawn at any time). If you can rely on contract or legal obligation, do so.

## Consent Management Schema

Consent is not a boolean field on the customer table. It is a versioned, auditable, withdrawal-aware record:

```sql
-- Consent categories defined centrally
CREATE TABLE consent_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(50) UNIQUE NOT NULL,     -- e.g. 'MARKETING_EMAIL'
    description TEXT        NOT NULL,
    lawful_basis CHAR(2)    NOT NULL,            -- '6a' through '6f'
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per customer per consent category per version
CREATE TABLE consents (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id       UUID        NOT NULL REFERENCES customers(id),
    category_id       UUID        NOT NULL REFERENCES consent_categories(id),
    version           INTEGER     NOT NULL,          -- must match current_version at time of capture
    status            VARCHAR(20) NOT NULL            -- GRANTED, WITHDRAWN, EXPIRED
                      CHECK (status IN ('GRANTED','WITHDRAWN','EXPIRED')),
    captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    captured_channel  VARCHAR(50) NOT NULL,           -- WEB, MOBILE, BRANCH, API
    captured_ip       INET,
    withdrawn_at      TIMESTAMPTZ,
    withdrawal_reason TEXT,
    expiry_at         TIMESTAMPTZ,                    -- NULL = no expiry for this category
    metadata          JSONB
);

CREATE INDEX idx_consents_customer_category
    ON consents(customer_id, category_id, status)
    WHERE status = 'GRANTED';
```

The Java service layer enforces that only the latest version is checked:

```java
@Service
@RequiredArgsConstructor
public class ConsentService {

    private final ConsentRepository consentRepository;
    private final ConsentCategoryRepository categoryRepository;

    /**
     * Returns true only if an active, non-expired GRANTED consent exists
     * for the current version of the category.
     */
    public boolean hasConsent(UUID customerId, String categoryCode) {
        ConsentCategory category = categoryRepository.findByCode(categoryCode)
            .orElseThrow(() -> new IllegalArgumentException("Unknown consent category: " + categoryCode));

        return consentRepository.findActiveConsent(
                customerId, category.getId(), category.getCurrentVersion())
            .filter(c -> c.getExpiryAt() == null || c.getExpiryAt().isAfter(Instant.now()))
            .isPresent();
    }

    /**
     * Withdraws all active consents for a customer in a given category.
     * Withdrawal is a new record (append-only audit trail), not an UPDATE.
     */
    @Transactional
    public void withdrawConsent(UUID customerId, String categoryCode, String reason) {
        ConsentCategory category = categoryRepository.findByCode(categoryCode)
            .orElseThrow();

        consentRepository.findAllActiveByCustomerAndCategory(customerId, category.getId())
            .forEach(c -> {
                c.setStatus(ConsentStatus.WITHDRAWN);
                c.setWithdrawnAt(Instant.now());
                c.setWithdrawalReason(reason);
                consentRepository.save(c);
            });
    }
}
```

## Right-to-Erasure Implementation

GDPR Article 17 grants the **right to erasure** ("right to be forgotten"). For fintech, the operative exception is **Article 17(3)(b)**: erasure does not apply where processing is necessary for compliance with a legal obligation, including AML retention under AMLD5 (minimum 5 years, commonly 7).

The correct architecture is **pseudonymisation**, not deletion:

```java
/**
 * Marks fields as containing personal data, used by erasure tooling
 * and static analysis to locate PII.
 */
@Target({ElementType.FIELD, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface PersonalData {
    String category();          // e.g. "NAME", "ADDRESS", "PHONE", "DOCUMENT_NUMBER"
    boolean retainedForAml();   // true = AML retention overrides erasure
    String retentionYears() default "7";
}
```

```java
@Entity
@Table(name = "customers")
public class Customer {

    @Id UUID id;

    @PersonalData(category = "NAME", retainedForAml = true)
    String fullName;

    @PersonalData(category = "ADDRESS", retainedForAml = false)
    String addressLine1;

    @PersonalData(category = "EMAIL", retainedForAml = false)
    String email;

    @PersonalData(category = "PHONE", retainedForAml = false)
    String phoneNumber;

    @PersonalData(category = "DOCUMENT_NUMBER", retainedForAml = true)
    String nationalIdNumber;    // Required for AML identity verification record

    // Non-PII fields — not annotated
    String accountStatus;
    String riskRating;
    Instant createdAt;
}
```

The erasure service uses reflection to find all `@PersonalData` fields and applies pseudonymisation:

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class GdprErasureService {

    private final CustomerRepository customerRepository;
    private final ErasureAuditRepository auditRepository;
    private final PseudonymisationService pseudonymisationService;

    /**
     * Processes an erasure request for a customer.
     * Fields with retainedForAml=true are pseudonymised (token replaces value).
     * Fields with retainedForAml=false are nulled outright.
     */
    @Transactional
    public ErasureResult processErasureRequest(UUID customerId, String requestReference) {
        Customer customer = customerRepository.findById(customerId)
            .orElseThrow(() -> new ErasureException("Customer not found: " + customerId));

        List<FieldErasureRecord> records = new ArrayList<>();

        for (Field field : Customer.class.getDeclaredFields()) {
            PersonalData annotation = field.getAnnotation(PersonalData.class);
            if (annotation == null) continue;

            field.setAccessible(true);
            try {
                Object currentValue = field.get(customer);
                if (currentValue == null) continue;

                if (annotation.retainedForAml()) {
                    // Replace with deterministic pseudonym — referential integrity preserved
                    String token = pseudonymisationService.pseudonymise(
                        customerId, annotation.category(), currentValue.toString());
                    field.set(customer, token);
                    records.add(new FieldErasureRecord(field.getName(), "PSEUDONYMISED", annotation.category()));
                } else {
                    field.set(customer, null);
                    records.add(new FieldErasureRecord(field.getName(), "NULLED", annotation.category()));
                }
            } catch (IllegalAccessException e) {
                throw new ErasureException("Cannot access field: " + field.getName(), e);
            }
        }

        customerRepository.save(customer);

        ErasureAuditRecord audit = ErasureAuditRecord.builder()
            .customerId(customerId)
            .requestReference(requestReference)
            .erasedAt(Instant.now())
            .fieldRecords(records)
            .build();
        auditRepository.save(audit);

        log.info("GDPR erasure completed for customer={} ref={} fields={}",
            customerId, requestReference, records.size());

        return new ErasureResult(customerId, records, Instant.now());
    }
}
```

> [!NOTE]
> `PseudonymisationService` uses HMAC-SHA256 keyed with a customer-specific secret stored in Vault. The token is deterministic — the same input always produces the same token — so foreign key relationships in `transactions` and `aml_cases` tables remain valid after erasure.

## Data Subject Access Request (DSAR) Automation

A DSAR must be responded to within **30 calendar days** (Art. 12(3)). Manual processes fail at scale. The automation pipeline:

```mermaid
flowchart TD
    A([Customer submits DSAR\nvia portal or email]) --> B[DSAR intake service\ncreates request record\nstatus=RECEIVED]
    B --> C{Identity verification\npassed?}
    C -- No --> D[Request identity\ndocuments\nSLA paused]
    D --> C
    C -- Yes --> E[status=VERIFIED\nSLA clock starts\n30-day deadline set]
    E --> F[Data discovery job\nscans all systems\nper data_map registry]
    F --> G[Compile data export\nCSV + PDF]
    G --> H[Legal review\nredact third-party data]
    H --> I{Contains AML\nretained data?}
    I -- Yes --> J[Attach Art. 17(3)(b)\nexplanation letter]
    I -- No --> K[Skip legal notice]
    J --> L[Encrypted delivery\nto customer\nstatus=DELIVERED]
    K --> L
    L --> M([Record closed\nretain DSAR record\n6 years])

    style E fill:#1e3a5f,color:#fff
    style L fill:#14532d,color:#fff
```

The `DataRetentionService` purges records that have passed their retention window and have no AML hold:

```java
@Component
@Slf4j
public class DataRetentionService {

    private final RetentionPolicyRepository policyRepo;
    private final DataCategoryRepository categoryRepo;

    /**
     * Scheduled nightly at 02:00 UTC.
     * Identifies records past retention with no active legal hold,
     * and queues them for pseudonymisation or deletion.
     */
    @Scheduled(cron = "0 0 2 * * *", zone = "UTC")
    public void purgeExpiredRecords() {
        List<RetentionPolicy> policies = policyRepo.findAll();
        for (RetentionPolicy policy : policies) {
            Instant cutoff = Instant.now().minus(policy.getRetentionDays(), ChronoUnit.DAYS);
            int purged = categoryRepo.purgeExpiredRecords(
                policy.getDataCategory(), cutoff, policy.getPurgeAction());
            log.info("Retention purge category={} cutoff={} purged={}",
                policy.getDataCategory(), cutoff, purged);
        }
    }
}
```

## AML Retention Conflict Resolution

This is the highest-stakes decision in GDPR engineering for fintech:

| Scenario | Erasure Obligation | AML Retention Obligation | Resolution |
|---|---|---|---|
| Customer requests erasure of name and ID | Art. 17(1) GDPR | AMLD5 Art. 40 — 5 years minimum | **Pseudonymise** — Art. 17(3)(b) applies |
| Customer requests erasure of marketing data | Art. 17(1) GDPR | No AML basis | **Delete** immediately |
| Customer requests erasure of transaction history | Art. 17(1) GDPR | Art. 40 AMLD5 — transaction records retained | **Pseudonymise PII fields** in transactions; keep amounts, dates, accounts |
| Customer requests erasure of KYC documents | Art. 17(1) GDPR | Art. 40 AMLD5 — identity evidence retained | **Retain but restrict** — flag for internal AML use only |

> [!WARNING]
> Never delete AML-relevant records in response to a GDPR erasure request without a formal legal sign-off. The FCA can impose unlimited fines for AML failures; the ICO's maximum is €20M or 4% of global turnover. In most fintech firms, the AML exposure is larger.

## Data Residency and Cross-Border Transfer Rules

GDPR Chapter V restricts transfers of personal data outside the EEA. For fintech engineering teams:

```java
@Component
public class DataResidencyEnforcer {

    // Countries with adequacy decisions (as of 2026)
    private static final Set<String> ADEQUATE_COUNTRIES = Set.of(
        "UK", "CH", "CA", "JP", "NZ", "IL", "UY", "KR", "AD", "AR"
    );

    public TransferMechanism resolveTransferMechanism(String destinationCountry) {
        if (ADEQUATE_COUNTRIES.contains(destinationCountry)) {
            return TransferMechanism.ADEQUACY_DECISION;
        }
        // US: Privacy Framework adequacy decision — verify certified entity
        if ("US".equals(destinationCountry)) {
            return TransferMechanism.EU_US_DATA_PRIVACY_FRAMEWORK;
        }
        // All others require SCCs (Standard Contractual Clauses)
        return TransferMechanism.STANDARD_CONTRACTUAL_CLAUSES;
    }
}
```

**Standard Contractual Clauses (SCCs)** are the contractual mechanism for transfers to countries without adequacy. They must be signed before data flows, and a **Transfer Impact Assessment (TIA)** is recommended to assess local law risks (surveillance, law enforcement access).

## Knowledge Check

**Q1: A customer submits a GDPR erasure request. Their account was flagged for AML investigation 18 months ago and the case is still open. What is the legally correct response, and how should your system implement it?**

A: The correct response is to pseudonymise the customer's PII fields rather than delete them. GDPR Article 17(3)(b) explicitly states that the right to erasure does not apply where processing is necessary for compliance with a legal obligation under Union or Member State law — AMLD5 Article 40 mandates retention of AML records for a minimum of five years, extendable to ten. The system should: (1) acknowledge the request within 30 days with an explanation citing Article 17(3)(b); (2) apply the `GdprErasureService` to null non-AML PII (email, phone, marketing data); (3) pseudonymise AML-retained PII (name, national ID, document numbers) using a reversible token; (4) log the erasure audit record; (5) retain the pseudonymisation key in Vault under strict access control for the AML investigation team.

**Q2: Your team proposes adding a `has_consented_to_marketing` boolean column to the `customers` table. What are the architectural problems with this design?**

A: Three critical problems: (1) **No version tracking** — GDPR requires consent to be granular and demonstrable; a boolean cannot prove which version of the consent notice the customer agreed to, making it legally indefensible. (2) **No audit trail** — there is no record of when consent was given, over which channel, or what was said at the time; regulators require this proof. (3) **No withdrawal record** — when a customer withdraws consent, flipping the boolean destroys the history of when consent was active, which is needed to determine whether any marketing processing during that window was lawful. The correct design is the versioned `consents` table with append-only records per category, as shown in this lesson.

## Practical Challenge

**Scenario:** Your fintech processes payments for 2 million EU customers. You have received 340 DSAR requests this month and your legal team is manually fulfilling each one. The ICO has sent a preliminary notice citing delays beyond the 30-day limit.

**Task 1 — Consent schema migration:** Design and write a Flyway migration that adds the `consent_categories` and `consents` tables to your existing schema. Include indexes for the two most common query patterns: checking active consent by customer + category, and listing all consents for a customer for a DSAR export.

**Task 2 — DSAR automation pipeline:** Implement a `DsarService` that accepts a `DsarRequest` (customer ID, request reference, channel), creates the intake record, triggers identity verification, and upon verification starts the data discovery job across all registered data sources in a `data_source_registry` table.

**Task 3 — Field-level PII scanner:** Write a Spring component that at application startup scans all `@Entity` classes on the classpath, finds every field annotated with `@PersonalData`, and publishes a `PiiInventoryEvent` to Kafka. This feeds your compliance data catalogue. Handle superclass fields (inheritance) and embedded objects.

**Task 4 — Retention conflict test:** Write a JUnit 5 integration test that: (a) creates a customer; (b) creates a linked AML case with status `OPEN`; (c) calls `GdprErasureService.processErasureRequest()`; (d) asserts that AML-retained fields are pseudonymised (non-null, different from original); (e) asserts that non-AML fields are null; (f) asserts that the `ErasureAuditRecord` was written with correct field-level entries.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A customer under active AML investigation submits a GDPR erasure request. What is the correct engineering response?",
      "options": ["Delete all personal data immediately to comply with GDPR", "Reject the request entirely and take no action", "Pseudonymise AML-retained PII fields while deleting non-AML personal data, citing GDPR Article 17(3)(b)", "Freeze the account pending legal review"],
      "correct": 2,
      "explanation": "GDPR Article 17(3)(b) exempts processing necessary for compliance with legal obligations. AML records must be retained under AMLD5 Article 40 for 5+ years. The correct response is to pseudonymise AML-retained PII while deleting non-AML fields (email, marketing preferences, etc.), and document the decision in an erasure audit record."
    },
    {
      "text": "Why is storing consent as a single boolean column architecturally insufficient for GDPR compliance?",
      "options": ["A boolean cannot store multiple consent categories", "It lacks version tracking of consent notices, an audit trail, and a withdrawal history — making it legally indefensible", "Boolean fields are not indexed efficiently for GDPR queries", "Single columns cannot be encrypted at rest"],
      "correct": 1,
      "explanation": "GDPR requires consent to be demonstrable and granular. A boolean cannot prove which version of the consent notice was shown, when consent was given, or the history of withdrawals. The correct design is an append-only consents table with one row per consent event per category."
    },
    {
      "text": "What is the maximum response time for a Data Subject Access Request (DSAR) under GDPR?",
      "options": ["7 calendar days", "14 calendar days", "30 calendar days", "60 calendar days"],
      "correct": 2,
      "explanation": "Article 12(3) GDPR requires the controller to respond to a DSAR within one month (approximately 30 calendar days) of receipt. Extensions of two further months are possible for complex or numerous requests, but the data subject must be informed within the first month."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement GDPR Erasure and DSAR Automation",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Implement the GdprErasureService that accepts an erasure request, checks each personal data field against an AML retention policy, pseudonymises AML-retained fields using a reversible token stored in Vault, nulls non-AML fields, and writes a field-level ErasureAuditRecord documenting the action taken for each field."},
    {"id": "2", "description": "Design and write a Flyway migration adding consent_categories and consents tables. Include indexes for checking active consent by customer + category, and listing all consents for DSAR export. Add a unique partial index to enforce only one active consent record per customer per category."},
    {"id": "3", "description": "Implement a DsarAutomationService that accepts a DSAR intake, triggers identity verification, and upon verification launches a parallel data discovery job that queries all services registered in a data_source_registry table, aggregates results, and formats a DSAR response package within the 30-day deadline."},
    {"id": "4", "description": "Write a Spring component that at application startup scans all @Entity classes on the classpath for fields annotated with @PersonalData, publishes a PiiInventoryEvent to Kafka for each discovered field (including superclass and embedded fields), and write an integration test asserting the correct number of PII fields are discovered for a sample entity hierarchy."}
  ]
}
-->
