---
id: track-07-lesson-11
title: "Risk Scoring Engines — Customer and Transaction Risk"
slug: risk-scoring
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 11
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [risk-scoring, customer-risk, transaction-risk, risk-matrix, dynamic]
prerequisites: []
---

# Risk Scoring Engines — Customer and Transaction Risk

> [!NOTE]
> Risk-Based Approach (RBA) is the foundation of modern AML compliance. Regulators do not expect every customer to receive the same level of scrutiny — they expect institutions to allocate compliance resources proportionally to risk. The engineering challenge is building a risk scoring engine that is transparent, auditable, configurable, and fast enough to run synchronously during customer onboarding and asynchronously on the full customer book during periodic reviews.

## The Risk-Based Approach in Practice

The Financial Action Task Force (FATF) recommends, and FinCEN requires, that financial institutions implement a risk-based approach to AML. In practice, this means:

- **Low-risk customers** receive simplified due diligence (SDD)
- **Standard-risk customers** receive customer due diligence (CDD)
- **High-risk customers** receive enhanced due diligence (EDD)

The risk score must be calculated at onboarding, re-evaluated periodically (typically annually), and re-triggered by specific events (large transactions, change of address, sanctions list match, etc.).

**Risk categories that must feed the score:**
- Geographic risk (high-risk jurisdictions, PEP countries)
- Customer type risk (cash-intensive business, money service business, shell company)
- Product/channel risk (wire transfers, correspondent banking, private banking)
- Transaction behavior risk (unusual activity, structuring indicators)
- Adverse media and sanctions proximity

---

## Risk Score Data Model

```java
package com.fintech.risk.model;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record CustomerRiskProfile(
    String customerId,
    int compositeScore,                 // 0–100; higher = riskier
    RiskRating riskRating,              // LOW, MEDIUM, HIGH, PROHIBITED
    Map<RiskDimension, DimensionScore> dimensionScores,
    List<RiskFactor> activeRiskFactors, // Individual factors driving the score
    LocalDate lastCalculatedDate,
    LocalDate nextReviewDate,
    RiskReviewTrigger lastTrigger,
    String analystOverrideReason,       // If compliance manually overrode the score
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt
) {}

public record DimensionScore(
    RiskDimension dimension,
    int rawScore,         // 0–100 for this dimension
    double weight,        // Configured weight (0.0–1.0)
    double weightedScore, // rawScore * weight
    List<String> contributingFactors
) {}

public enum RiskDimension {
    GEOGRAPHIC,         // Country of origin, residence, business operations
    CUSTOMER_TYPE,      // Individual, business, PEP, cash-intensive business
    PRODUCT_CHANNEL,    // Wire, cash, private banking, correspondent
    TRANSACTION_BEHAVIOR, // Patterns, velocity, amounts
    ADVERSE_INFORMATION   // Sanctions proximity, negative news, prior filings
}

public enum RiskRating {
    LOW,         // Score 0–29   → SDD
    MEDIUM,      // Score 30–59  → CDD
    HIGH,        // Score 60–89  → EDD
    PROHIBITED   // Score 90–100 → Reject/Exit
}

public record RiskFactor(
    String factorCode,
    String description,
    int scoreContribution,  // How many points this factor adds
    RiskDimension dimension,
    boolean isOverrideable
) {}

public enum RiskReviewTrigger {
    INITIAL_ONBOARDING,
    PERIODIC_REVIEW,
    TRANSACTION_ALERT,
    SANCTIONS_HIT,
    SAR_FILED,
    CUSTOMER_DATA_CHANGE,
    ANALYST_REQUEST,
    SYSTEM_RECALIBRATION
}
```

---

## Risk Scoring Engine — Core Implementation

```java
package com.fintech.risk.engine;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.*;

@Service
public class CustomerRiskScoringEngine {

    private final RiskWeightConfiguration weightConfig;
    private final GeographicRiskEvaluator geoEvaluator;
    private final CustomerTypeEvaluator customerTypeEvaluator;
    private final ProductChannelEvaluator productChannelEvaluator;
    private final TransactionBehaviorEvaluator behaviorEvaluator;
    private final AdverseInformationEvaluator adverseEvaluator;
    private final RiskProfileRepository profileRepository;
    private final RiskAuditService riskAuditService;

    /**
     * Calculate a fresh composite risk score for a customer.
     * This is the main entry point called during onboarding and periodic review.
     *
     * The score is computed as a weighted sum of five dimension scores.
     * Weights are configurable — a retail bank serving primarily domestic customers
     * might weight geographic risk lower than a correspondent bank.
     */
    public CustomerRiskProfile calculateRiskScore(
            String customerId, RiskReviewTrigger trigger) {

        CustomerData customer = profileRepository.loadCustomerData(customerId);
        RiskWeights weights = weightConfig.getWeights(customer.customerSegment());

        // Evaluate each dimension independently
        DimensionScore geoScore = geoEvaluator.evaluate(customer, weights.geographic());
        DimensionScore typeScore = customerTypeEvaluator.evaluate(customer, weights.customerType());
        DimensionScore productScore = productChannelEvaluator.evaluate(customer, weights.productChannel());
        DimensionScore behaviorScore = behaviorEvaluator.evaluate(customer, weights.transactionBehavior());
        DimensionScore adverseScore = adverseEvaluator.evaluate(customer, weights.adverseInformation());

        Map<RiskDimension, DimensionScore> dimensionScores = Map.of(
            RiskDimension.GEOGRAPHIC,             geoScore,
            RiskDimension.CUSTOMER_TYPE,          typeScore,
            RiskDimension.PRODUCT_CHANNEL,        productScore,
            RiskDimension.TRANSACTION_BEHAVIOR,   behaviorScore,
            RiskDimension.ADVERSE_INFORMATION,    adverseScore
        );

        // Composite score = weighted sum of dimension scores
        double weightedSum = dimensionScores.values().stream()
            .mapToDouble(DimensionScore::weightedScore)
            .sum();

        int compositeScore = (int) Math.round(
            Math.min(100, Math.max(0, weightedSum)));

        RiskRating rating = deriveRating(compositeScore, customer);

        // Collect all risk factors across dimensions
        List<RiskFactor> allFactors = dimensionScores.values().stream()
            .flatMap(ds -> ds.contributingFactors().stream())
            .map(fc -> RiskFactor.fromCode(fc, dimensionOf(fc)))
            .toList();

        LocalDate nextReview = calculateNextReviewDate(rating);

        CustomerRiskProfile profile = new CustomerRiskProfile(
            customerId, compositeScore, rating, dimensionScores,
            allFactors, LocalDate.now(), nextReview, trigger,
            null,  // No analyst override
            OffsetDateTime.now(), OffsetDateTime.now()
        );

        // Persist and audit
        profileRepository.saveProfile(profile);
        riskAuditService.logRiskCalculation(profile, trigger);

        // Trigger actions based on new rating
        applyRatingActions(profile, customer);

        return profile;
    }

    /**
     * Override a system-calculated score with an analyst judgement.
     * Requires a mandatory reason and supervisor approval for downgrades.
     * All overrides are permanently logged — regulators examine override patterns.
     */
    public CustomerRiskProfile analystOverride(
            String customerId, RiskRating overrideRating,
            String reason, String analystId, String supervisorId) {

        CustomerRiskProfile current = profileRepository.loadProfile(customerId);

        // Downgrades (High → Low) require supervisor approval
        if (overrideRating.ordinal() < current.riskRating().ordinal()) {
            if (supervisorId == null || supervisorId.isBlank()) {
                throw new InsufficientAuthorizationException(
                    "Downgrading risk rating from " + current.riskRating() +
                    " to " + overrideRating + " requires supervisor approval");
            }
        }

        int overrideScore = midpointScoreForRating(overrideRating);

        CustomerRiskProfile overriddenProfile = new CustomerRiskProfile(
            customerId, overrideScore, overrideRating,
            current.dimensionScores(), current.activeRiskFactors(),
            LocalDate.now(), calculateNextReviewDate(overrideRating),
            RiskReviewTrigger.ANALYST_REQUEST,
            reason + " [Analyst: " + analystId +
            (supervisorId != null ? ", Supervisor: " + supervisorId : "") + "]",
            current.createdAt(), OffsetDateTime.now()
        );

        profileRepository.saveProfile(overriddenProfile);
        riskAuditService.logOverride(overriddenProfile, analystId, supervisorId, reason);

        return overriddenProfile;
    }

    private RiskRating deriveRating(int score, CustomerData customer) {
        // Certain customer types are automatically HIGH regardless of score
        if (customer.isCorrespondentBank()
                || customer.isMsb()
                || customer.isPep()) {
            return score >= 60 ? RiskRating.HIGH : RiskRating.MEDIUM;
        }
        // Sanctions list match is always PROHIBITED
        if (customer.hasSanctionsMatch()) {
            return RiskRating.PROHIBITED;
        }
        if (score >= 90) return RiskRating.PROHIBITED;
        if (score >= 60) return RiskRating.HIGH;
        if (score >= 30) return RiskRating.MEDIUM;
        return RiskRating.LOW;
    }

    private LocalDate calculateNextReviewDate(RiskRating rating) {
        return switch (rating) {
            case LOW        -> LocalDate.now().plusYears(3);
            case MEDIUM     -> LocalDate.now().plusYears(1);
            case HIGH       -> LocalDate.now().plusMonths(6);
            case PROHIBITED -> LocalDate.now();  // Immediate action required
        };
    }

    private int midpointScoreForRating(RiskRating rating) {
        return switch (rating) {
            case LOW        -> 15;
            case MEDIUM     -> 45;
            case HIGH       -> 75;
            case PROHIBITED -> 95;
        };
    }

    private void applyRatingActions(CustomerRiskProfile profile, CustomerData customer) {
        switch (profile.riskRating()) {
            case HIGH -> {
                // Trigger Enhanced Due Diligence workflow
                riskAuditService.triggerEdd(profile.customerId());
            }
            case PROHIBITED -> {
                // Freeze account pending compliance review
                riskAuditService.flagForExitReview(profile.customerId());
            }
            default -> {} // LOW/MEDIUM: standard monitoring
        }
    }

    private RiskDimension dimensionOf(String factorCode) {
        // Map factor codes to dimensions using prefix convention
        // e.g. GEO_HIGH_RISK_COUNTRY → GEOGRAPHIC
        if (factorCode.startsWith("GEO_"))     return RiskDimension.GEOGRAPHIC;
        if (factorCode.startsWith("TYPE_"))    return RiskDimension.CUSTOMER_TYPE;
        if (factorCode.startsWith("PROD_"))    return RiskDimension.PRODUCT_CHANNEL;
        if (factorCode.startsWith("TXN_"))     return RiskDimension.TRANSACTION_BEHAVIOR;
        if (factorCode.startsWith("ADV_"))     return RiskDimension.ADVERSE_INFORMATION;
        return RiskDimension.CUSTOMER_TYPE;
    }
}
```

---

## Geographic Risk Evaluator

```java
package com.fintech.risk.engine;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Set;

@Component
public class GeographicRiskEvaluator {

    // FATF High-Risk and Other Monitored Jurisdictions (updated quarterly)
    private static final Set<String> FATF_HIGH_RISK = Set.of(
        "KP",  // North Korea — most severe
        "IR",  // Iran — most severe
        "MM",  // Myanmar
        "RU",  // Russia (post-2022 enhanced monitoring)
        "BY"   // Belarus
    );

    // FATF Grey List (Jurisdictions Under Increased Monitoring)
    private static final Set<String> FATF_GREY_LIST = Set.of(
        "PK", "SY", "YE", "SD", "LY", "SO", "HT", "BF",
        "ML", "MZ", "TZ", "NG", "CM", "CD"
    );

    // Offshore financial centres with elevated risk
    private static final Set<String> OFFSHORE_CENTRES = Set.of(
        "KY", "VG", "BZ", "PA", "LR", "MH", "VU", "WS"
    );

    private final JurisdictionRiskRepository jurisdictionRepo;

    /**
     * Score the geographic risk dimension for a customer.
     *
     * Factors considered:
     * - Country of citizenship/registration
     * - Country of residence
     * - Countries where the business operates
     * - Countries of beneficial owners
     */
    public DimensionScore evaluate(CustomerData customer, double weight) {
        int score = 0;
        List<String> factors = new java.util.ArrayList<>();

        // Nationality / country of registration
        String homeCountry = customer.countryCode();
        if (FATF_HIGH_RISK.contains(homeCountry)) {
            score = Math.max(score, 90);
            factors.add("GEO_FATF_HIGH_RISK_COUNTRY");
        } else if (FATF_GREY_LIST.contains(homeCountry)) {
            score = Math.max(score, 65);
            factors.add("GEO_FATF_GREY_LIST");
        } else if (OFFSHORE_CENTRES.contains(homeCountry)) {
            score = Math.max(score, 55);
            factors.add("GEO_OFFSHORE_CENTRE");
        }

        // Country of residence (for individuals) or primary operations (for businesses)
        if (customer.residenceCountry() != null
                && !customer.residenceCountry().equals(homeCountry)) {
            String residenceCountry = customer.residenceCountry();
            if (FATF_HIGH_RISK.contains(residenceCountry)) {
                score = Math.max(score, 85);
                factors.add("GEO_RESIDENCE_FATF_HIGH_RISK");
            } else if (FATF_GREY_LIST.contains(residenceCountry)) {
                score = Math.max(score, 60);
                factors.add("GEO_RESIDENCE_GREY_LIST");
            }
        }

        // Beneficial owner countries (for legal entities)
        if (customer.beneficialOwnerCountries() != null) {
            for (String boCountry : customer.beneficialOwnerCountries()) {
                if (FATF_HIGH_RISK.contains(boCountry)) {
                    score = Math.max(score, 80);
                    factors.add("GEO_BENEFICIAL_OWNER_HIGH_RISK");
                    break;
                }
            }
        }

        // High-risk US states (marijuana-legal states for licensed cannabis businesses)
        if ("US".equals(homeCountry) && customer.stateCode() != null) {
            if (isHighRiskUsState(customer.stateCode())) {
                score = Math.max(score, 40);
                factors.add("GEO_HIGH_RISK_US_STATE");
            }
        }

        double weightedScore = score * weight;
        return new DimensionScore(
            RiskDimension.GEOGRAPHIC, score, weight, weightedScore, factors);
    }

    private boolean isHighRiskUsState(String stateCode) {
        // States with specific AML risk considerations (e.g., cannabis, gambling)
        return Set.of("CA", "CO", "OR", "WA", "NV").contains(stateCode);
    }
}
```

---

## Customer Type Evaluator

```java
package com.fintech.risk.engine;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

@Component
public class CustomerTypeEvaluator {

    public DimensionScore evaluate(CustomerData customer, double weight) {
        int score = 0;
        List<String> factors = new ArrayList<>();

        // Politically Exposed Persons — highest risk individual category
        if (customer.isPep()) {
            score = Math.max(score, 80);
            factors.add("TYPE_PEP");
        }

        // Relative or close associate of a PEP
        if (customer.isRcaPep()) {
            score = Math.max(score, 65);
            factors.add("TYPE_RCA_PEP");
        }

        // Money Service Businesses — inherently high risk
        if (customer.isMsb()) {
            score = Math.max(score, 75);
            factors.add("TYPE_MSB");
        }

        // Cash-intensive businesses — gas stations, car washes, restaurants, bars
        if (customer.isCashIntensiveBusiness()) {
            score = Math.max(score, 55);
            factors.add("TYPE_CASH_INTENSIVE_BUSINESS");
        }

        // Shell companies (no employees, no physical location, complex ownership)
        if (customer.isShellCompany()) {
            score = Math.max(score, 70);
            factors.add("TYPE_SHELL_COMPANY");
        }

        // Non-profit organizations — historically exploited for terrorist financing
        if (customer.isNonProfit()) {
            score = Math.max(score, 45);
            factors.add("TYPE_NONPROFIT");
        }

        // Real estate investment — commonly used for money laundering (layering)
        if (customer.isPrimaryBusinessRealEstate()) {
            score = Math.max(score, 50);
            factors.add("TYPE_REAL_ESTATE");
        }

        // Correspondent bank relationships — high risk due to nested accounts
        if (customer.isCorrespondentBank()) {
            score = Math.max(score, 85);
            factors.add("TYPE_CORRESPONDENT_BANK");
        }

        // Complex legal structure with no clear beneficial owner
        if (!customer.hasIdentifiableBeneficialOwner()) {
            score = Math.max(score, 60);
            factors.add("TYPE_NO_IDENTIFIABLE_UBO");
        }

        // Multiple layers of ownership in jurisdictions with weak disclosure laws
        if (customer.ownershipLayers() > 2) {
            score += 10 * (customer.ownershipLayers() - 2);
            factors.add("TYPE_COMPLEX_OWNERSHIP_STRUCTURE");
        }

        score = Math.min(score, 100);
        return new DimensionScore(
            RiskDimension.CUSTOMER_TYPE, score, weight, score * weight, factors);
    }
}
```

---

## Transaction Behavior Evaluator

```java
package com.fintech.risk.engine;

import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

@Component
public class TransactionBehaviorEvaluator {

    private static final BigDecimal HIGH_VOLUME_THRESHOLD   = new BigDecimal("1000000.00");
    private static final BigDecimal UNUSUAL_AMOUNT_MULTIPLE = new BigDecimal("5.0");
    private static final int HIGH_FREQUENCY_THRESHOLD       = 50;  // Transactions per month

    private final TransactionHistoryRepository txHistory;

    public DimensionScore evaluate(CustomerData customer, double weight) {
        int score = 0;
        List<String> factors = new ArrayList<>();

        LocalDate lookbackDate = LocalDate.now().minusMonths(3);

        TransactionSummary summary = txHistory.getSummary(
            customer.customerId(), lookbackDate, LocalDate.now());

        // High transaction volume relative to stated business type
        if (summary.totalVolume().compareTo(HIGH_VOLUME_THRESHOLD) > 0) {
            score = Math.max(score, 55);
            factors.add("TXN_HIGH_VOLUME");
        }

        // Cash transaction ratio — high cash % is unusual for most business types
        double cashRatio = summary.cashVolume().doubleValue()
            / summary.totalVolume().max(BigDecimal.ONE).doubleValue();
        if (cashRatio > 0.5) {
            score = Math.max(score, 50);
            factors.add("TXN_HIGH_CASH_RATIO");
        }

        // Near-threshold transactions (structuring indicators)
        if (summary.nearThresholdTransactionCount() > 0) {
            score += summary.nearThresholdTransactionCount() * 10;
            factors.add("TXN_NEAR_THRESHOLD_PATTERN");
        }

        // High velocity — many transactions in short period
        if (summary.transactionCount() > HIGH_FREQUENCY_THRESHOLD) {
            score = Math.max(score, 45);
            factors.add("TXN_HIGH_FREQUENCY");
        }

        // International wire transfers to high-risk jurisdictions
        if (summary.highRiskJurisdictionWireCount() > 0) {
            score += summary.highRiskJurisdictionWireCount() * 15;
            factors.add("TXN_HIGH_RISK_INTERNATIONAL_WIRES");
        }

        // Round-tripping: funds sent out and returned quickly (layering indicator)
        if (summary.roundTripTransactionCount() > 0) {
            score += 25;
            factors.add("TXN_ROUND_TRIPPING");
        }

        // Sudden behavior change from historical baseline
        if (isSignificantDeviationFromBaseline(customer.customerId(), summary)) {
            score += 20;
            factors.add("TXN_BEHAVIORAL_DEVIATION");
        }

        score = Math.min(score, 100);
        return new DimensionScore(
            RiskDimension.TRANSACTION_BEHAVIOR, score, weight, score * weight, factors);
    }

    private boolean isSignificantDeviationFromBaseline(
            String customerId, TransactionSummary current) {
        // Compare last 3 months to 12-month baseline
        TransactionSummary baseline = txHistory.getSummary(
            customerId,
            LocalDate.now().minusYears(1),
            LocalDate.now().minusMonths(3));

        if (baseline.transactionCount() < 5) return false;  // Insufficient history

        BigDecimal baselineAvgMonthly = baseline.totalVolume()
            .divide(new BigDecimal("9"), 2, java.math.RoundingMode.HALF_UP);

        BigDecimal currentAvgMonthly = current.totalVolume()
            .divide(new BigDecimal("3"), 2, java.math.RoundingMode.HALF_UP);

        // Flag if current activity is more than 5x the historical baseline
        return currentAvgMonthly.compareTo(
            baselineAvgMonthly.multiply(UNUSUAL_AMOUNT_MULTIPLE)) > 0;
    }
}
```

---

## Transaction-Level Risk Scoring

Customer-level risk scores are calculated at onboarding and during periodic reviews. Transaction-level risk scoring happens in real time, on every transaction:

```java
package com.fintech.risk.engine;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.OffsetDateTime;

@Service
public class TransactionRiskScoringEngine {

    private static final BigDecimal LARGE_TRANSACTION_THRESHOLD = new BigDecimal("50000.00");
    private static final BigDecimal VERY_LARGE_THRESHOLD        = new BigDecimal("500000.00");

    private final CustomerRiskProfileRepository profileRepo;
    private final SanctionsScreeningService sanctionsService;
    private final TransactionHistoryRepository txHistory;

    /**
     * Score an individual transaction for AML risk.
     * Called synchronously during transaction processing — must complete in <50ms.
     * Returns a score from 0–100 and a disposition (APPROVE, REVIEW, HOLD, BLOCK).
     */
    public TransactionRiskScore scoreTransaction(Transaction transaction) {
        int score = 0;
        List<String> riskIndicators = new java.util.ArrayList<>();

        // 1. Customer-level risk baseline
        CustomerRiskProfile customerProfile =
            profileRepo.loadProfile(transaction.customerId());
        int customerBaseScore = customerProfile != null
            ? customerProfile.compositeScore() / 2  // Customer risk is 50% of tx score
            : 25;  // Default medium risk if profile not yet calculated
        score += customerBaseScore;

        // 2. Counterparty risk (for outgoing wires)
        if (transaction.counterpartyId() != null) {
            CustomerRiskProfile counterpartyProfile =
                profileRepo.loadProfile(transaction.counterpartyId());
            if (counterpartyProfile != null
                    && counterpartyProfile.riskRating() == RiskRating.HIGH) {
                score += 20;
                riskIndicators.add("COUNTERPARTY_HIGH_RISK");
            }
        }

        // 3. Amount-based risk
        if (transaction.amount().compareTo(VERY_LARGE_THRESHOLD) >= 0) {
            score += 15;
            riskIndicators.add("VERY_LARGE_AMOUNT");
        } else if (transaction.amount().compareTo(LARGE_TRANSACTION_THRESHOLD) >= 0) {
            score += 8;
            riskIndicators.add("LARGE_AMOUNT");
        }

        // 4. Structuring indicators
        BigDecimal nearThresholdLow = new BigDecimal("9000.00");
        BigDecimal nearThresholdHigh = new BigDecimal("9999.99");
        if (transaction.amount().compareTo(nearThresholdLow) >= 0
                && transaction.amount().compareTo(nearThresholdHigh) <= 0) {
            score += 20;
            riskIndicators.add("NEAR_CTR_THRESHOLD");
        }

        // 5. Destination country risk (for wires)
        if (transaction.destinationCountry() != null) {
            int geoRisk = GeographicRiskEvaluator
                .getCountryRiskScore(transaction.destinationCountry());
            score += (int)(geoRisk * 0.15);  // 15% weight for destination country
            if (geoRisk > 70) riskIndicators.add("HIGH_RISK_DESTINATION_COUNTRY");
        }

        // 6. Velocity — is this transaction unusually large for this customer?
        BigDecimal avgTransactionSize = txHistory
            .getAverageTransactionSize(transaction.customerId(), 90);  // 90-day average
        if (avgTransactionSize.compareTo(BigDecimal.ZERO) > 0) {
            BigDecimal multiple = transaction.amount().divide(
                avgTransactionSize, 2, java.math.RoundingMode.HALF_UP);
            if (multiple.compareTo(new BigDecimal("10")) >= 0) {
                score += 15;
                riskIndicators.add("UNUSUAL_AMOUNT_FOR_CUSTOMER");
            }
        }

        // 7. Time-of-day anomaly (transaction at unusual hours)
        int hour = transaction.transactedAt().getHour();
        if (hour >= 23 || hour <= 5) {
            score += 5;
            riskIndicators.add("ODD_HOURS_TRANSACTION");
        }

        score = Math.min(score, 100);

        TransactionDisposition disposition = determineDisposition(score);

        return new TransactionRiskScore(
            transaction.transactionId(),
            score,
            disposition,
            riskIndicators,
            OffsetDateTime.now()
        );
    }

    private TransactionDisposition determineDisposition(int score) {
        if (score >= 85) return TransactionDisposition.BLOCK;
        if (score >= 65) return TransactionDisposition.HOLD_FOR_REVIEW;
        if (score >= 40) return TransactionDisposition.APPROVE_WITH_ALERT;
        return TransactionDisposition.APPROVE;
    }

    public enum TransactionDisposition {
        APPROVE,
        APPROVE_WITH_ALERT,  // Process normally but create monitoring alert
        HOLD_FOR_REVIEW,     // Hold funds pending analyst review (SLA: 24 hours)
        BLOCK                // Do not process; notify compliance
    }

    public record TransactionRiskScore(
        java.util.UUID transactionId,
        int score,
        TransactionDisposition disposition,
        List<String> riskIndicators,
        OffsetDateTime scoredAt
    ) {}
}
```

---

## Dynamic Risk Re-Assessment

Risk scores are not static. The following events must trigger an immediate re-assessment, not waiting for the next periodic review:

```java
package com.fintech.risk.engine;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class RiskReassessmentTrigger {

    private final CustomerRiskScoringEngine scoringEngine;
    private final CustomerRiskProfileRepository profileRepo;

    /**
     * Sanctions hit: immediate reassessment.
     * If the customer scores PROHIBITED, freeze the account.
     */
    @KafkaListener(topics = "sanctions-hits", groupId = "risk-reassessment")
    public void onSanctionsHit(ConsumerRecord<String, SanctionsHitEvent> record) {
        SanctionsHitEvent event = record.value();
        // A sanctions match always escalates to PROHIBITED regardless of other factors
        CustomerRiskProfile profile = scoringEngine.calculateRiskScore(
            event.customerId(), RiskReviewTrigger.SANCTIONS_HIT);
        if (profile.riskRating() == RiskRating.PROHIBITED) {
            profileRepo.flagForImmediateAction(event.customerId(), "SANCTIONS_MATCH");
        }
    }

    /**
     * SAR filed: re-score after a suspicious activity report is filed.
     * Prior SAR filings are themselves a risk factor.
     */
    @KafkaListener(topics = "sar-filed-events", groupId = "risk-reassessment")
    public void onSarFiled(ConsumerRecord<String, SarFiledEvent> record) {
        SarFiledEvent event = record.value();
        scoringEngine.calculateRiskScore(
            event.customerId(), RiskReviewTrigger.SAR_FILED);
    }

    /**
     * Customer data change: address update, change of beneficial ownership,
     * new signatory — any of these can change the risk profile.
     */
    @KafkaListener(topics = "customer-data-changes", groupId = "risk-reassessment")
    public void onCustomerDataChange(ConsumerRecord<String, CustomerDataChangeEvent> record) {
        CustomerDataChangeEvent event = record.value();

        // Not all data changes warrant re-scoring
        boolean requiresReassessment = switch (event.changeType()) {
            case COUNTRY_OF_RESIDENCE, BENEFICIAL_OWNERSHIP, BUSINESS_TYPE,
                 SANCTIONS_STATUS, PEP_STATUS -> true;
            case PHONE_NUMBER, EMAIL, PREFERENCES -> false;
            default -> false;
        };

        if (requiresReassessment) {
            scoringEngine.calculateRiskScore(
                event.customerId(), RiskReviewTrigger.CUSTOMER_DATA_CHANGE);
        }
    }

    /**
     * Large transaction alert: a single very large transaction triggers
     * a behavior-focused re-assessment.
     */
    @KafkaListener(topics = "large-transaction-alerts", groupId = "risk-reassessment")
    public void onLargeTransaction(ConsumerRecord<String, LargeTransactionAlert> record) {
        LargeTransactionAlert alert = record.value();
        scoringEngine.calculateRiskScore(
            alert.customerId(), RiskReviewTrigger.TRANSACTION_ALERT);
    }
}
```

---

## Periodic Review Scheduler

```java
package com.fintech.risk.scheduling;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Service
public class PeriodicRiskReviewScheduler {

    private static final int REVIEW_BATCH_SIZE    = 500;
    private static final int REVIEW_THREAD_COUNT  = 20;

    private final CustomerRiskProfileRepository profileRepo;
    private final CustomerRiskScoringEngine scoringEngine;
    private final ExecutorService reviewExecutor =
        Executors.newFixedThreadPool(REVIEW_THREAD_COUNT);

    /**
     * Daily job: find all customers whose periodic review date has passed
     * and re-score them. Runs at 2 AM to avoid peak processing hours.
     *
     * Review frequency:
     *   LOW    → every 3 years
     *   MEDIUM → every 1 year
     *   HIGH   → every 6 months
     */
    @Scheduled(cron = "0 0 2 * * *", zone = "America/New_York")
    public void runPeriodicReviews() {
        LocalDate today = LocalDate.now();
        List<String> dueForReview = profileRepo.findCustomersDueForReview(today);

        // Process in batches to avoid overwhelming downstream systems
        for (int i = 0; i < dueForReview.size(); i += REVIEW_BATCH_SIZE) {
            List<String> batch = dueForReview.subList(
                i, Math.min(i + REVIEW_BATCH_SIZE, dueForReview.size()));

            for (String customerId : batch) {
                reviewExecutor.submit(() -> {
                    try {
                        scoringEngine.calculateRiskScore(
                            customerId, RiskReviewTrigger.PERIODIC_REVIEW);
                    } catch (Exception e) {
                        // Log but don't stop the batch — one failure shouldn't block others
                        profileRepo.recordReviewFailure(customerId, e.getMessage());
                    }
                });
            }
        }
    }
}
```

---

## Risk Score Persistence and History

Risk scores must be retained for 7 years as part of CDD records. The score history is auditable — regulators can ask "what was this customer's risk score on a given date?"

```java
package com.fintech.risk.repository;

import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@Repository
public class RiskProfileRepository {

    private final NamedParameterJdbcTemplate jdbc;

    /**
     * Save a risk profile. The current_risk_profiles table is overwritten,
     * but risk_score_history is append-only (immutable audit trail).
     */
    public void saveProfile(CustomerRiskProfile profile) {
        // Upsert current profile
        jdbc.update("""
            INSERT INTO current_risk_profiles
                (customer_id, composite_score, risk_rating, dimension_scores_json,
                 risk_factors_json, calculated_date, next_review_date, trigger_type,
                 analyst_override_reason, updated_at)
            VALUES
                (:customerId, :compositeScore, :riskRating, :dimensionScoresJson,
                 :riskFactorsJson, :calculatedDate, :nextReviewDate, :triggerType,
                 :analystOverrideReason, NOW())
            ON CONFLICT (customer_id) DO UPDATE SET
                composite_score = EXCLUDED.composite_score,
                risk_rating = EXCLUDED.risk_rating,
                dimension_scores_json = EXCLUDED.dimension_scores_json,
                risk_factors_json = EXCLUDED.risk_factors_json,
                calculated_date = EXCLUDED.calculated_date,
                next_review_date = EXCLUDED.next_review_date,
                trigger_type = EXCLUDED.trigger_type,
                analyst_override_reason = EXCLUDED.analyst_override_reason,
                updated_at = EXCLUDED.updated_at
            """,
            toParams(profile));

        // Append to history (never updated, only inserted)
        jdbc.update("""
            INSERT INTO risk_score_history
                (customer_id, composite_score, risk_rating, dimension_scores_json,
                 risk_factors_json, effective_date, trigger_type, analyst_override_reason)
            VALUES
                (:customerId, :compositeScore, :riskRating, :dimensionScoresJson,
                 :riskFactorsJson, :calculatedDate, :triggerType, :analystOverrideReason)
            """,
            toParams(profile));
    }

    /**
     * Point-in-time query: what was this customer's risk score on a given date?
     * Used for regulatory examinations and audit queries.
     */
    public CustomerRiskProfile getProfileAsOf(String customerId, LocalDate asOfDate) {
        return jdbc.queryForObject("""
            SELECT * FROM risk_score_history
            WHERE customer_id = :customerId
              AND effective_date <= :asOfDate
            ORDER BY effective_date DESC
            LIMIT 1
            """,
            Map.of("customerId", customerId, "asOfDate", asOfDate),
            (rs, rowNum) -> mapToProfile(rs));
    }

    public List<String> findCustomersDueForReview(LocalDate asOf) {
        return jdbc.queryForList("""
            SELECT customer_id FROM current_risk_profiles
            WHERE next_review_date <= :asOf
            ORDER BY risk_rating DESC, next_review_date ASC
            """,
            Map.of("asOf", asOf),
            String.class);
    }

    private Map<String, Object> toParams(CustomerRiskProfile profile) {
        return Map.of(
            "customerId",             profile.customerId(),
            "compositeScore",         profile.compositeScore(),
            "riskRating",             profile.riskRating().name(),
            "dimensionScoresJson",    serializeDimensions(profile.dimensionScores()),
            "riskFactorsJson",        serializeFactors(profile.activeRiskFactors()),
            "calculatedDate",         profile.lastCalculatedDate(),
            "nextReviewDate",         profile.nextReviewDate(),
            "triggerType",            profile.lastTrigger().name(),
            "analystOverrideReason",  profile.analystOverrideReason()
        );
    }

    private String serializeDimensions(Map<RiskDimension, DimensionScore> scores) {
        // Use Jackson ObjectMapper in production
        return "{}"; // Placeholder
    }

    private String serializeFactors(List<RiskFactor> factors) {
        return "[]"; // Placeholder
    }

    private CustomerRiskProfile mapToProfile(java.sql.ResultSet rs) {
        // Map ResultSet to CustomerRiskProfile
        throw new UnsupportedOperationException("Implement full mapping");
    }
}
```

---

## Configurable Weights

Different customer segments require different risk weighting. A retail bank has different risk priorities than a correspondent bank:

```java
package com.fintech.risk.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
@ConfigurationProperties(prefix = "risk.weights")
public class RiskWeightConfiguration {

    private Map<String, WeightProfile> profiles;

    public RiskWeights getWeights(String customerSegment) {
        WeightProfile profile = profiles.getOrDefault(
            customerSegment, profiles.get("default"));
        return new RiskWeights(
            profile.geographic(),
            profile.customerType(),
            profile.productChannel(),
            profile.transactionBehavior(),
            profile.adverseInformation()
        );
    }

    record WeightProfile(
        double geographic,
        double customerType,
        double productChannel,
        double transactionBehavior,
        double adverseInformation
    ) {}
}
```

```yaml
# application.yml — risk weight configuration
risk:
  weights:
    profiles:
      default:
        geographic: 0.25
        customerType: 0.25
        productChannel: 0.15
        transactionBehavior: 0.25
        adverseInformation: 0.10
      correspondent-bank:
        geographic: 0.30
        customerType: 0.30
        productChannel: 0.20
        transactionBehavior: 0.15
        adverseInformation: 0.05
      retail-individual:
        geographic: 0.20
        customerType: 0.20
        productChannel: 0.10
        transactionBehavior: 0.35
        adverseInformation: 0.15
```

---

## EDD Workflow Trigger

When a customer's risk rating escalates to HIGH, the Enhanced Due Diligence process must be initiated. EDD has regulatory deadlines.

```java
package com.fintech.risk.edd;

import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;

@Service
public class EnhancedDueDiligenceService {

    private static final int EDD_COMPLETION_DAYS = 30;  // Complete EDD within 30 days

    private final EddCaseRepository caseRepo;
    private final WorkflowEngine workflowEngine;
    private final NotificationService notificationService;

    /**
     * Trigger EDD for a newly high-risk customer.
     * EDD requirements (per FinCEN guidance):
     *   1. Identify and verify source of wealth
     *   2. Identify and verify source of funds for specific transactions
     *   3. Senior management approval for the relationship
     *   4. Enhanced ongoing monitoring
     */
    public EddCase triggerEdd(String customerId, String triggerReason) {
        // Check if EDD is already in progress
        EddCase existing = caseRepo.findOpenCase(customerId);
        if (existing != null) {
            // Add the new trigger reason to the existing case
            caseRepo.addTrigger(existing.caseId(), triggerReason);
            return existing;
        }

        EddCase eddCase = EddCase.builder()
            .customerId(customerId)
            .triggerReason(triggerReason)
            .openedAt(OffsetDateTime.now())
            .deadline(OffsetDateTime.now().plusDays(EDD_COMPLETION_DAYS))
            .status(EddStatus.OPEN)
            .requiredDocuments(buildRequiredDocumentList(customerId))
            .build();

        caseRepo.save(eddCase);

        // Assign to a compliance analyst
        workflowEngine.assignToQueue("EDD_QUEUE", eddCase.caseId());

        // Notify the relationship manager
        notificationService.notifyRelationshipManager(customerId,
            "Customer requires Enhanced Due Diligence. " +
            "Trigger: " + triggerReason + ". " +
            "Deadline: " + eddCase.deadline());

        return eddCase;
    }

    private java.util.List<String> buildRequiredDocumentList(String customerId) {
        // Standard EDD document requirements
        return java.util.List.of(
            "SOURCE_OF_WEALTH_DOCUMENTATION",
            "SOURCE_OF_FUNDS_EXPLANATION",
            "BENEFICIAL_OWNERSHIP_CERTIFICATION",
            "BUSINESS_PURPOSE_LETTER",
            "SENIOR_MANAGEMENT_APPROVAL"
        );
    }
}
```

---

## Production Considerations

**Score stability vs. reactivity:** A score that changes dramatically with every transaction will generate excessive false-positive alerts. Apply damping — weight recent history more than a single transaction. Use exponential moving averages for the transaction behavior dimension rather than point-in-time snapshots.

**Model governance:** Risk scoring models are subject to SR 11-7 (Supervisory Guidance on Model Risk Management). Every model must have: documentation of methodology, independent validation, ongoing performance monitoring, and an inventory entry. The scoring engine and its weights constitute a model under SR 11-7.

**Threshold calibration:** If your HIGH-risk threshold is set too low, compliance analysts are overwhelmed with EDD cases they cannot complete within the 30-day window. If it is set too high, genuine high-risk customers are missed. Track the EDD completion rate — if it is below 90%, raise the threshold or add analyst capacity.

**Score explainability:** Regulators and customers can request an explanation of why a score was assigned. Every risk score must be accompanied by the specific factors that drove it, in plain language. The `activeRiskFactors` list serves this purpose.

**Back-testing:** Periodically test whether the risk scores predicted actual SAR filings. A well-calibrated model should show that HIGH-risk customers have a significantly higher SAR rate than LOW-risk customers. If the rates are similar, the model is not differentiating effectively.

---

## Summary

A production risk scoring engine is the backbone of the entire AML compliance program. The key design principles are:

1. **Weighted composite scoring** across five independent dimensions gives transparency and configurability.
2. **Dynamic re-assessment** on specific triggers (sanctions hit, SAR filing, data change) keeps scores current without full daily recalculation.
3. **Score history is immutable** — append-only persistence enables point-in-time regulatory queries.
4. **Analyst overrides are auditable** — every override is permanently logged with the reason and approver.
5. **Weights are configurable per segment** — do not hardcode weights; risk priorities differ by customer segment and change as the regulatory environment evolves.
6. **Model governance applies** — the scoring engine is an SR 11-7 model; treat it as such with documentation, validation, and ongoing monitoring.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the Risk-Based Approach (RBA) in AML compliance and how does it translate to engineering requirements?",
      "options": ["A method to reduce technology costs by prioritising high-value transactions", "An approach requiring institutions to allocate compliance resources proportionally to risk — Low-risk customers receive SDD, standard-risk CDD, high-risk EDD — which requires a scoring engine that is transparent, auditable, configurable, and fast", "A framework for determining which regulations apply to each customer", "A scoring model that assigns uniform risk levels to all customer types"],
      "correct": 1,
      "explanation": "FATF and FinCEN require a Risk-Based Approach meaning compliance intensity is proportional to risk. Engineering must implement a scoring engine that can run synchronously during onboarding and asynchronously on the full customer book during periodic reviews, with weighted composite scoring across geographic, customer type, product, and transaction dimensions."
    },
    {
      "text": "Why must risk score history be persisted in an append-only manner rather than updating the current record?",
      "options": ["Append-only storage is cheaper than update-based storage", "Regulators and legal processes may require knowing the exact risk score assigned to a customer on a specific historical date — mutable records cannot answer this question", "Append-only prevents race conditions during concurrent scoring", "Scoring models change frequently, requiring recomputation of historical scores"],
      "correct": 1,
      "explanation": "Risk scores are part of CDD records and must be retained for 7 years. Regulators can ask what a customer's risk score was on a given date and demand the factors that drove it. Append-only persistence with an audit history table enables exact point-in-time queries; mutable records cannot."
    },
    {
      "text": "Under which regulatory framework are risk scoring engines classified as 'models' requiring documentation, validation, and ongoing monitoring?",
      "options": ["GDPR Article 22 on automated decision-making", "SR 11-7 (Supervisory Guidance on Model Risk Management)", "PCI DSS Requirement 6 on secure development", "Basel III operational risk framework"],
      "correct": 1,
      "explanation": "SR 11-7 (Federal Reserve / OCC Supervisory Guidance on Model Risk Management) defines models broadly — any quantitative method used to make decisions. A weighted composite risk scoring engine meets this definition and requires documentation of methodology, independent validation, ongoing performance monitoring, and an inventory entry."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Weighted Composite Customer Risk Scoring Engine",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a CustomerRiskScoringEngine that calculates a composite risk score from five weighted dimensions: geographic risk, customer type, product/channel, transaction behavior, and adverse information. Each dimension returns a DimensionScore with a raw score (0-100), configured weight, and list of triggered risk factors. The composite score is the weighted sum of all dimension scores."},
    {"id": "2", "description": "Implement the GeographicRiskEvaluator that scores a customer's country of residence, incorporation country, and nationality against FATF grey/blacklist status and a jurisdiction corruption perception index. High-risk jurisdiction must score at least 70; FATF blacklisted jurisdictions must score 100."},
    {"id": "3", "description": "Implement the RiskReassessmentTrigger as a Kafka consumer that listens on sanctions-hits, sar-filed-events, and customer-data-changes topics. For sanctions hits, the customer must immediately be flagged as PROHIBITED regardless of other factors. For customer data changes, only re-score when COUNTRY_OF_RESIDENCE, BENEFICIAL_OWNERSHIP, BUSINESS_TYPE, or PEP_STATUS changes."},
    {"id": "4", "description": "Implement the RiskProfileRepository with append-only persistence: an UPSERT into current_risk_profiles and an INSERT into risk_score_history (no UPDATE or DELETE allowed). Write an integration test that scores a customer twice with different inputs and verifies both scores appear in history while current profile reflects only the latest score."}
  ]
}
-->
