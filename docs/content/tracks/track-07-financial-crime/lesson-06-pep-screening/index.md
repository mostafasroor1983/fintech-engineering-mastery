---
id: track-07-lesson-06
title: "PEP Screening — Politically Exposed Persons Detection"
slug: pep-screening
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 6
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [PEP, screening, watchlist, enhanced-due-diligence, risk-rating]
prerequisites: [track-07-lesson-03]
---

# PEP Screening — Politically Exposed Persons Detection

> [!NOTE]
> PEP screening is a legal obligation under FATF Recommendation 12 and implemented in the EU's 4th, 5th, and 6th Anti-Money Laundering Directives, the US Bank Secrecy Act, and equivalent legislation worldwide. A financial institution that onboards a foreign head of state without applying Enhanced Due Diligence faces regulatory censure, fines, and reputational damage. The technical challenge is performing fuzzy name matching at scale — accurately, quickly, and with low false-positive rates.

## What Is a PEP?

A Politically Exposed Person is an individual who holds, or has held within the last 12-24 months, a prominent public function. The definition is intentionally broad:

**Domestic PEPs** (home country officials):
- Heads of state and government, senior politicians
- Senior judicial officials (Supreme Court justices)
- Senior military officers (general/admiral rank)
- Senior executives of state-owned enterprises
- Members of governing bodies of central banks

**Foreign PEPs** (another country's officials):
- All of the above but for a foreign jurisdiction
- Subject to higher risk weighting because verification is harder

**International Organisation PEPs**:
- Senior officials of the UN, World Bank, IMF, regional development banks
- NATO, EU, WTO executive officials

**PEP Relatives and Close Associates (RCA)**:
- Spouses, parents, children, siblings
- Close business associates (beneficial owners of same entity)
- Known associates of PEPs

The RCA category is critical and often missed. A PEP's spouse opening a joint account, or the PEP's business partner incorporating a shell company, extends the risk to the institution.

---

## 1. PEP Data Sources

Institutions rely on commercial PEP databases because maintaining a comprehensive list in-house is impractical. Key providers:

| Provider | Coverage | Update Frequency | API |
|---|---|---|---|
| Refinitiv World-Check | 3M+ profiles, 240+ countries | Daily | REST / SFTP batch |
| Dow Jones Risk & Compliance | 2.4M+ profiles | Daily | REST / SFTP |
| ComplyAdvantage | 1M+ profiles, real-time news | Near real-time | REST |
| LexisNexis Bridger | US-focused, good domestic | Daily | REST / SOAP |
| Accuity (now Fiserv) | Strong sanctions + PEP | Daily | REST |

Always use at least two sources and reconcile. No single provider has 100% coverage.

---

## 2. PEP Screening Service Architecture

```java
@Service
public class PepScreeningService {

    private final PepDatabaseRepository pepDatabase;
    private final FuzzyMatchService fuzzyMatchService;
    private final PepRiskRater riskRater;
    private final EnhancedDueDiligenceService eddService;
    private final PepScreeningAuditRepository auditRepo;
    private static final Logger log = LoggerFactory.getLogger(PepScreeningService.class);

    public PepScreeningResult screen(CustomerProfile customer) {
        long startMs = System.currentTimeMillis();

        // 1. Generate name variants to handle transliteration and aliases
        List<String> nameVariants = generateNameVariants(customer.getFullName());

        // 2. Candidate retrieval from PEP database
        List<PepCandidate> candidates = new ArrayList<>();
        for (String nameVariant : nameVariants) {
            candidates.addAll(pepDatabase.findCandidates(
                    nameVariant,
                    customer.getDateOfBirth(),
                    customer.getNationality()));
        }

        // 3. De-duplicate candidates
        List<PepCandidate> uniqueCandidates = deduplicateCandidates(candidates);

        // 4. Fuzzy matching and scoring
        List<PepMatch> matches = new ArrayList<>();
        for (PepCandidate candidate : uniqueCandidates) {
            PepMatchScore score = fuzzyMatchService.score(customer, candidate);
            if (score.getOverallScore() >= 0.70) {
                matches.add(PepMatch.builder()
                        .candidate(candidate)
                        .score(score)
                        .build());
            }
        }

        // Sort by match score descending
        matches.sort(Comparator.comparingDouble(
                m -> -m.getScore().getOverallScore()));

        // 5. Risk rating
        PepRiskLevel riskLevel = matches.isEmpty()
                ? PepRiskLevel.NONE
                : riskRater.rate(matches.get(0), customer);

        // 6. EDD trigger for PEP matches
        if (riskLevel == PepRiskLevel.HIGH || riskLevel == PepRiskLevel.VERY_HIGH) {
            eddService.initiateEDD(customer.getCustomerId(),
                    matches.get(0), riskLevel);
        }

        PepScreeningResult result = PepScreeningResult.builder()
                .customerId(customer.getCustomerId())
                .matches(matches)
                .riskLevel(riskLevel)
                .screeningTimestamp(Instant.now())
                .latencyMs(System.currentTimeMillis() - startMs)
                .build();

        auditRepo.save(buildAuditRecord(customer, result));
        return result;
    }

    private List<String> generateNameVariants(String fullName) {
        List<String> variants = new ArrayList<>();
        variants.add(fullName);
        variants.add(normalise(fullName));  // remove accents, lowercase
        variants.add(reverseNameOrder(fullName));  // family name first
        // Add phonetic variants using Soundex / Metaphone
        variants.addAll(phoneticVariants(fullName));
        return variants;
    }

    private String normalise(String name) {
        // Remove diacritical marks, normalise Unicode
        String normalised = Normalizer.normalize(name, Normalizer.Form.NFD);
        return normalised.replaceAll("[\\p{InCombiningDiacriticalMarks}]", "")
                         .toLowerCase().trim();
    }

    private String reverseNameOrder(String name) {
        String[] parts = name.trim().split("\\s+");
        if (parts.length < 2) return name;
        // Move last token to front: "John Smith" -> "Smith John"
        String[] reversed = new String[parts.length];
        reversed[0] = parts[parts.length - 1];
        System.arraycopy(parts, 0, reversed, 1, parts.length - 1);
        return String.join(" ", reversed);
    }
}
```

---

## 3. Fuzzy Name Matching

Name matching for PEPs must handle transliteration (Arabic/Chinese names romanised differently), nicknames, and common variations. A single string similarity metric is not sufficient — a composite score using multiple algorithms is more robust.

```java
@Component
public class FuzzyMatchService {

    // Jaro-Winkler: good for short strings, rewards matching prefix
    // Levenshtein: edit distance, good for typos
    // Double Metaphone: phonetic matching, language-independent
    // Token set ratio: handles word order variations

    public PepMatchScore score(CustomerProfile customer,
                                PepCandidate candidate) {
        String custName  = normalise(customer.getFullName());
        String candName  = normalise(candidate.getFullName());

        double jaroWinkler = calculateJaroWinkler(custName, candName);
        double tokenSetRatio = calculateTokenSetRatio(custName, candName);
        double phoneticScore = calculatePhoneticScore(custName, candName);

        // Date of birth match — exact or fuzzy (year +/- 1 for entry errors)
        double dobScore = scoreDateOfBirth(
                customer.getDateOfBirth(), candidate.getDateOfBirth());

        // Nationality / country match
        double nationalityScore = scoreNationality(
                customer.getNationality(), candidate.getNationalities());

        // Composite score with weights calibrated on labelled match data
        double overallScore =
                0.35 * jaroWinkler    +
                0.25 * tokenSetRatio  +
                0.15 * phoneticScore  +
                0.15 * dobScore       +
                0.10 * nationalityScore;

        return PepMatchScore.builder()
                .jaroWinkler(jaroWinkler)
                .tokenSetRatio(tokenSetRatio)
                .phoneticScore(phoneticScore)
                .dobScore(dobScore)
                .nationalityScore(nationalityScore)
                .overallScore(overallScore)
                .build();
    }

    private double calculateJaroWinkler(String a, String b) {
        // Apache Commons Text JaroWinklerSimilarity
        return new JaroWinklerSimilarity().apply(a, b);
    }

    private double calculateTokenSetRatio(String a, String b) {
        // Split both strings into tokens, sort, compare
        // Handles "Smith John" vs "John Smith"
        String sortedA = Arrays.stream(a.split("\\s+"))
                .sorted().collect(Collectors.joining(" "));
        String sortedB = Arrays.stream(b.split("\\s+"))
                .sorted().collect(Collectors.joining(" "));
        return new JaroWinklerSimilarity().apply(sortedA, sortedB);
    }

    private double calculatePhoneticScore(String a, String b) {
        DoubleMetaphone dm = new DoubleMetaphone();
        String codeA = dm.doubleMetaphone(a);
        String codeB = dm.doubleMetaphone(b);
        if (codeA == null || codeB == null) return 0.0;
        return codeA.equals(codeB) ? 1.0
                : new JaroWinklerSimilarity().apply(codeA, codeB);
    }

    private double scoreDateOfBirth(LocalDate customerDob,
                                     LocalDate candidateDob) {
        if (customerDob == null || candidateDob == null) return 0.5; // unknown
        if (customerDob.equals(candidateDob)) return 1.0;
        // Allow year +/- 1 for data entry errors
        long daysDiff = Math.abs(ChronoUnit.DAYS.between(customerDob, candidateDob));
        if (daysDiff <= 366) return 0.7;
        if (daysDiff <= 730) return 0.3;
        return 0.0;
    }

    private double scoreNationality(String customerNationality,
                                     List<String> candidateNationalities) {
        if (customerNationality == null || candidateNationalities == null) return 0.5;
        return candidateNationalities.contains(customerNationality) ? 1.0 : 0.0;
    }

    private String normalise(String name) {
        if (name == null) return "";
        String n = Normalizer.normalize(name, Normalizer.Form.NFD);
        return n.replaceAll("[\\p{InCombiningDiacriticalMarks}]", "")
                .toLowerCase().trim();
    }
}
```

---

## 4. PEP Risk Rating

Not all PEPs carry the same risk. A local town councillor is a PEP but poses far less risk than a foreign head of state from a high-corruption jurisdiction. Risk rating must consider position level, jurisdiction, and whether the PEP relationship is current or historical.

```java
@Component
public class PepRiskRater {

    // Transparency International CPI (Corruption Perceptions Index)
    // Countries with CPI < 40 are considered high-corruption jurisdictions
    private static final Set<String> HIGH_CORRUPTION_COUNTRIES = Set.of(
            "AF", "SS", "SY", "SO", "YE", "VE", "CG", "LY",
            "ER", "GN", "GW", "HT", "MM", "KP", "TJ", "TD"
    );

    public PepRiskLevel rate(PepMatch topMatch, CustomerProfile customer) {
        PepCandidate candidate = topMatch.getCandidate();

        // Factor 1: PEP category
        int categoryScore = switch (candidate.getPepCategory()) {
            case FOREIGN_HEAD_OF_STATE  -> 100;
            case FOREIGN_GOVERNMENT_MINISTER -> 90;
            case DOMESTIC_HEAD_OF_STATE -> 80;
            case DOMESTIC_MINISTER      -> 70;
            case SENIOR_JUDICIAL        -> 60;
            case MILITARY_SENIOR        -> 60;
            case SOE_EXECUTIVE          -> 50;
            case INTERNATIONAL_ORG      -> 50;
            case REGIONAL_POLITICIAN    -> 40;
            case RCA_CLOSE_ASSOCIATE    -> 60;
            case RCA_FAMILY_MEMBER      -> 50;
            default                     -> 30;
        };

        // Factor 2: Jurisdiction corruption level
        boolean isHighCorruption = HIGH_CORRUPTION_COUNTRIES
                .contains(candidate.getPrimaryJurisdiction());
        int jurisdictionBonus = isHighCorruption ? 20 : 0;

        // Factor 3: Is this a current or former PEP?
        boolean isCurrent = candidate.isCurrentlyInRole();
        int recencyBonus = isCurrent ? 10 : 0;

        // Factor 4: Match confidence
        double matchScore = topMatch.getScore().getOverallScore();
        double matchMultiplier = matchScore >= 0.95 ? 1.0
                : matchScore >= 0.85 ? 0.9
                : 0.75;  // lower confidence = somewhat reduced risk weighting

        int rawScore = (int)((categoryScore + jurisdictionBonus + recencyBonus)
                * matchMultiplier);

        if (rawScore >= 90) return PepRiskLevel.VERY_HIGH;
        if (rawScore >= 70) return PepRiskLevel.HIGH;
        if (rawScore >= 50) return PepRiskLevel.MEDIUM;
        if (rawScore >= 30) return PepRiskLevel.LOW;
        return PepRiskLevel.NONE;
    }
}
```

---

## 5. Enhanced Due Diligence for PEP Customers

When a customer is identified as a PEP or RCA, standard KYC is insufficient. EDD requires additional verification, senior management approval for onboarding, and ongoing monitoring.

```java
@Service
public class EnhancedDueDiligenceService {

    private final EDDCaseRepository eddCaseRepo;
    private final ApprovalWorkflowService approvalService;
    private final AdverseMediaService adverseMediaService;
    private static final Logger log = LoggerFactory.getLogger(EnhancedDueDiligenceService.class);

    public void initiateEDD(String customerId,
                             PepMatch match,
                             PepRiskLevel riskLevel) {
        EDDCase eddCase = EDDCase.builder()
                .customerId(customerId)
                .pepMatchId(match.getCandidate().getPepId())
                .riskLevel(riskLevel)
                .status(EDDStatus.PENDING)
                .requiredChecks(determineRequiredChecks(riskLevel))
                .createdAt(Instant.now())
                .deadlineAt(calculateDeadline(riskLevel))
                .build();

        eddCaseRepo.save(eddCase);

        // For VERY_HIGH risk: require C-suite approval before onboarding
        if (riskLevel == PepRiskLevel.VERY_HIGH) {
            approvalService.requestSeniorApproval(eddCase,
                    "PEP_VERY_HIGH_RISK",
                    "Senior Management approval required before account activation");
        }

        // Run adverse media screening
        adverseMediaService.screenAsync(customerId,
                match.getCandidate().getFullName());

        log.info("EDD initiated: customerId={} pepId={} riskLevel={}",
                customerId, match.getCandidate().getPepId(), riskLevel);
    }

    private List<EDDCheck> determineRequiredChecks(PepRiskLevel level) {
        List<EDDCheck> checks = new ArrayList<>();
        checks.add(EDDCheck.SOURCE_OF_WEALTH_DECLARATION);
        checks.add(EDDCheck.SOURCE_OF_FUNDS_DOCUMENTATION);
        checks.add(EDDCheck.ADVERSE_MEDIA_SEARCH);
        checks.add(EDDCheck.PUBLIC_RECORDS_VERIFICATION);

        if (level == PepRiskLevel.HIGH || level == PepRiskLevel.VERY_HIGH) {
            checks.add(EDDCheck.INDEPENDENT_VERIFICATION);
            checks.add(EDDCheck.BUSINESS_PURPOSE_DOCUMENTATION);
            checks.add(EDDCheck.SENIOR_MANAGEMENT_SIGN_OFF);
        }

        if (level == PepRiskLevel.VERY_HIGH) {
            checks.add(EDDCheck.IN_PERSON_INTERVIEW);
            checks.add(EDDCheck.LEGAL_OPINION);
        }

        return checks;
    }

    private Instant calculateDeadline(PepRiskLevel level) {
        // EDD must be completed within defined SLAs
        int daysToComplete = switch (level) {
            case VERY_HIGH -> 2;   // 48 hours
            case HIGH      -> 5;
            case MEDIUM    -> 10;
            default        -> 15;
        };
        return Instant.now().plus(daysToComplete, ChronoUnit.DAYS);
    }
}
```

---

## 6. Periodic Review Triggers

PEP status is not static. Politicians leave office, relatives move on. Equally, existing customers can become PEPs (e.g., a business owner is appointed to a government role). Periodic review ensures PEP status is current.

```java
@Service
public class PepPeriodicReviewService {

    private final CustomerRepository customerRepo;
    private final PepScreeningService pepScreeningService;
    private final ReviewScheduleRepository scheduleRepo;

    // Nightly batch: identify customers due for PEP re-screening
    @Scheduled(cron = "0 2 * * *")  // 2 AM daily
    public void schedulePeriodicReviews() {
        // High-risk PEPs reviewed every 6 months
        // Medium-risk PEPs reviewed annually
        // Former PEPs (exited role > 12 months) reviewed every 2 years
        // All other customers: annual name screening refresh

        List<String> dueTodayIds = scheduleRepo.findCustomersDueForReview(
                LocalDate.now());

        log.info("Scheduling PEP re-screening for {} customers", dueTodayIds.size());

        // Process in batches of 100 to avoid overloading PEP API
        Lists.partition(dueTodayIds, 100).forEach(batch -> {
            batch.forEach(customerId -> {
                try {
                    CustomerProfile profile = customerRepo.findById(customerId)
                            .orElseThrow();
                    PepScreeningResult result = pepScreeningService.screen(profile);
                    handleReviewResult(customerId, result);
                } catch (Exception e) {
                    log.error("PEP re-screening failed: customerId={}", customerId, e);
                }
            });
        });
    }

    private void handleReviewResult(String customerId,
                                     PepScreeningResult result) {
        PepRiskLevel previousLevel = scheduleRepo
                .getPreviousRiskLevel(customerId);

        if (result.getRiskLevel() != previousLevel) {
            log.info("PEP risk level changed: customerId={} {} -> {}",
                    customerId, previousLevel, result.getRiskLevel());

            // Escalate if risk has increased
            if (result.getRiskLevel().ordinal() > previousLevel.ordinal()) {
                eddService.initiateEDD(customerId,
                        result.getMatches().get(0), result.getRiskLevel());
            }
        }

        // Update next review date
        scheduleRepo.updateNextReviewDate(customerId,
                calculateNextReviewDate(result.getRiskLevel()));
    }

    private LocalDate calculateNextReviewDate(PepRiskLevel level) {
        return switch (level) {
            case VERY_HIGH -> LocalDate.now().plusMonths(3);
            case HIGH      -> LocalDate.now().plusMonths(6);
            case MEDIUM    -> LocalDate.now().plusMonths(12);
            case LOW       -> LocalDate.now().plusMonths(18);
            default        -> LocalDate.now().plusMonths(24);
        };
    }
}
```

---

## 7. PEP Screening Audit Trail

Every screening event must be retained for regulatory examination. Regulators will ask: "When did you screen this customer? What was the result? What action did you take?"

```java
@Entity
@Table(name = "pep_screening_audit",
       indexes = {
           @Index(name = "idx_psa_customer_id", columnList = "customer_id"),
           @Index(name = "idx_psa_screened_at", columnList = "screened_at"),
           @Index(name = "idx_psa_risk_level",  columnList = "risk_level")
       })
public class PepScreeningAuditRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private String auditId;

    @Column(name = "customer_id", nullable = false)
    private String customerId;

    @Column(name = "screened_at", nullable = false)
    private Instant screenedAt;

    @Column(name = "trigger_type", nullable = false)
    @Enumerated(EnumType.STRING)
    private ScreeningTrigger triggerType;  // ONBOARDING, PERIODIC, EVENT_TRIGGERED

    @Column(name = "risk_level", nullable = false)
    @Enumerated(EnumType.STRING)
    private PepRiskLevel riskLevel;

    @Column(name = "matches_found")
    private int matchesFound;

    @Column(name = "top_match_score")
    private Double topMatchScore;

    @Column(name = "top_match_pep_id")
    private String topMatchPepId;

    @Column(name = "action_taken")
    @Enumerated(EnumType.STRING)
    private PepAction actionTaken;  // NONE, EDD_INITIATED, ESCALATED, REJECTED

    @Column(name = "data_source_versions", columnDefinition = "jsonb")
    @Type(JsonType.class)
    private Map<String, String> dataSourceVersions;  // provider -> version/date

    @Column(name = "latency_ms")
    private long latencyMs;

    @Column(name = "screened_by")
    private String screenedBy;  // system identifier or analyst ID
}
```

---

## 8. Handling False Positives

False positives — legitimate customers incorrectly flagged as PEPs — cause friction and regulatory complaint if not managed well. A systematic false positive process is required.

```java
@Service
public class PepFalsePositiveService {

    private final PepFalsePositiveRepository fpRepo;
    private final PepScreeningAuditRepository auditRepo;

    // Analyst dismisses a false positive with documented justification
    public void recordFalsePositive(String customerId,
                                     String matchId,
                                     String analystId,
                                     String justification) {
        // Record the false positive for model calibration
        PepFalsePositive fp = PepFalsePositive.builder()
                .customerId(customerId)
                .matchId(matchId)
                .dismissedBy(analystId)
                .justification(justification)
                .dismissedAt(Instant.now())
                .build();
        fpRepo.save(fp);

        // Update the screening audit to reflect analyst review outcome
        auditRepo.updateActionTaken(customerId, matchId, PepAction.FALSE_POSITIVE_CLEARED);

        log.info("PEP false positive cleared: customerId={} matchId={} analyst={}",
                customerId, matchId, analystId);
    }

    // Suppress future matches between this customer and this PEP candidate
    // Valid only where the analyst has documented clear differentiation
    public void suppressMatch(String customerId, String pepCandidateId,
                               String analystId, String rationale) {
        // Suppression must expire — reconsider after 12 months or if
        // new information emerges (e.g., customer changes address to PEP country)
        PepMatchSuppression suppression = PepMatchSuppression.builder()
                .customerId(customerId)
                .pepCandidateId(pepCandidateId)
                .createdBy(analystId)
                .rationale(rationale)
                .expiresAt(Instant.now().plus(365, ChronoUnit.DAYS))
                .build();
        suppressionRepo.save(suppression);
    }
}
```

---

## 9. Configuration and Thresholds

```yaml
# application.yml
pep:
  screening:
    match-threshold: 0.70          # minimum composite score for a match
    auto-edd-threshold: 0.85       # auto-initiate EDD at this score
    name-variants: true             # generate transliteration variants
    phonetic-matching: true
  periodic-review:
    very-high-risk-months: 3
    high-risk-months: 6
    medium-risk-months: 12
  data-sources:
    primary: world-check
    secondary: dow-jones
    tertiary: comply-advantage
  cache:
    pep-database-ttl-hours: 24     # cache PEP data refreshed daily
    result-ttl-hours: 4            # cache screening results for re-checks
```

---

## 10. Compliance Considerations

**Regulatory obligations by jurisdiction:**

| Jurisdiction | Regulation | PEP Obligation |
|---|---|---|
| EU | 4AMLD / 5AMLD | EDD for all PEPs; RCA in scope |
| US | Bank Secrecy Act / FinCEN guidance | Foreign PEPs mandatory; domestic PEPs advisory |
| UK | Money Laundering Regulations 2017 | EDD for all PEPs |
| Singapore | MAS Notice 626 | EDD for foreign PEPs |
| Australia | AML/CTF Act 2006 | EDD for PEPs |

**Common audit findings:**
- Insufficient coverage of RCAs (especially business associates)
- No re-screening when customers change roles or circumstances
- Match suppression not time-limited or properly documented
- EDD cases open beyond required deadlines
- Senior management approval for VERY_HIGH risk customers not documented

---

## Summary

PEP screening is a mandatory AML control that requires accurate fuzzy name matching, risk-proportionate due diligence, and a complete audit trail. The technical complexity is in the matching algorithm — composite scoring across multiple similarity metrics outperforms any single metric. Risk rating must reflect position level and jurisdiction corruption, not just match confidence. Periodic review and event-triggered re-screening close the lifecycle loop, ensuring PEP status is maintained accurately throughout the customer relationship.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which category of PEP-related persons is most commonly missed in screening programs?",
      "options": ["Foreign heads of state", "Senior military officers", "Relatives and Close Associates (RCA) of PEPs", "International organisation officials"],
      "correct": 2,
      "explanation": "The RCA category — spouses, parents, children, siblings, and close business associates of PEPs — is critical and often missed. A PEP's spouse opening a joint account or the PEP's business partner incorporating a shell company extends the risk to the institution."
    },
    {
      "text": "Why does PEP screening use composite scoring across multiple similarity metrics rather than a single metric?",
      "options": ["Single metrics are legally insufficient", "No single metric handles transliteration, phonetic variation, and partial matches simultaneously; composite scoring outperforms any single approach", "Composite scoring is faster at scale", "Regulators mandate a minimum number of matching algorithms"],
      "correct": 1,
      "explanation": "PEP names appear in many transliterated forms across different languages and scripts. A composite of Jaro-Winkler similarity, phonetic encoding (Metaphone), and token overlap handles the full range of name variations that a single metric would miss."
    },
    {
      "text": "What action must be taken when an existing customer's circumstances change and they become a PEP after onboarding?",
      "options": ["Close the account immediately", "File a SAR for the account history", "Trigger event-based re-screening and initiate EDD if a match is confirmed", "No action required until the annual periodic review"],
      "correct": 2,
      "explanation": "PEP status is not static. A business owner appointed to a government role becomes a PEP after onboarding. Event-triggered re-screening — fired by role change events, adverse media monitoring, or watchlist updates — ensures PEP status remains current and EDD is applied promptly."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement a PEP Screening Service with Fuzzy Name Matching",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Implement a composite name matching algorithm that combines Jaro-Winkler string similarity, Metaphone phonetic encoding, and token overlap scoring with configurable weights. The composite score should range from 0.0 to 1.0 and return a match when the score exceeds a configurable threshold (default 0.70)."},
    {"id": "2", "description": "Implement the PepScreeningService that accepts a CustomerProfile, generates name variants (transliterations, initials, common aliases), screens against a PEP database using the composite matcher, and returns a PepScreeningResult with risk level and top matches."},
    {"id": "3", "description": "Implement PepPeriodicReviewService with a @Scheduled job that queries customers due for re-screening based on their risk level (VERY_HIGH: 3 months, HIGH: 6 months, MEDIUM: 12 months) and processes them in batches of 100 to avoid overloading the PEP API."},
    {"id": "4", "description": "Persist every screening event to a PepScreeningAuditRecord entity. Write an integration test that: (a) creates a customer with a name similar to a known PEP, (b) calls the screening service, (c) asserts a match is found with score above threshold, (d) asserts an audit record is written with the correct risk level and action taken."}
  ]
}
-->
