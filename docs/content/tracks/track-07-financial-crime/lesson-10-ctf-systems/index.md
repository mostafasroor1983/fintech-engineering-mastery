---
id: track-07-lesson-10
title: "Currency Transaction Reporting — CTF Systems at Scale"
slug: ctf-systems
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 10
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [CTF, currency-transaction, threshold-monitoring, structuring-detection]
prerequisites: []
---

# Currency Transaction Reporting — CTF Systems at Scale

> [!NOTE]
> Currency Transaction Reports (CTRs) are mandatory filings with FinCEN for cash transactions exceeding $10,000 in a single business day. The engineering challenge is aggregating transactions across multiple accounts, locations, and time windows in real time while detecting structuring attempts designed to evade the threshold. At scale, this means processing millions of daily transactions with sub-second aggregation latency and 100% filing accuracy — a regulatory obligation with zero tolerance for failure.

## Regulatory Foundation

The Bank Secrecy Act (BSA) requires financial institutions to file a Currency Transaction Report (FinCEN Form 112) within 15 calendar days for every cash transaction or series of related transactions exceeding $10,000 in a single business day. The key phrase is "series of related transactions" — this is what makes the engineering problem non-trivial.

**What counts as currency for CTR purposes:**
- Physical currency (notes and coins) deposits or withdrawals
- Currency exchanges (foreign to domestic and vice versa)
- Cash purchases of negotiable instruments: money orders, cashier's checks, traveler's checks
- Currency payments on loans

**What does NOT trigger CTR requirements:**
- Wire transfers
- ACH transactions
- Check deposits (unless the check was purchased with cash)
- Debit or credit card transactions
- Cryptocurrency (although FinCEN guidance is evolving on this)

**Aggregation rules:** Transactions by or on behalf of the same person at the same institution in the same business day must be aggregated. This includes transactions across multiple branches and multiple accounts if the institution has knowledge they are related. This is the key rule that makes real-time aggregation architecturally necessary.

---

## System Architecture Overview

A production CTR system has three distinct processing tiers with different latency requirements:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Transaction Ingestion Layer                    │
│   (Kafka topics per transaction type, partitioned by customer)   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                   Real-Time Aggregation Layer                     │
│        (Redis counters, sliding window, threshold alerts)         │
│                      Latency target: <100ms                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                    CTR Generation Layer                           │
│         (Batch job, FinCEN XML generation, filing queue)          │
│                     Window: end-of-business-day                   │
└─────────────────────────────────────────────────────────────────┘
```

The real-time layer handles structuring detection and threshold alerts. The batch layer handles CTR generation and regulatory filing. These are architecturally separate because they have different latency and correctness requirements — real-time must be fast, filing must be perfect.

---

## Core Data Model

```java
package com.fintech.ctf.model;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.Currency;
import java.util.UUID;

public record CurrencyTransaction(
    UUID transactionId,
    String customerId,
    String accountId,
    String branchId,
    TransactionType type,
    BigDecimal amountUsd,          // Always store in USD after conversion
    BigDecimal originalAmount,
    Currency originalCurrency,
    BigDecimal exchangeRate,
    OffsetDateTime transactedAt,
    LocalDate businessDate,         // May differ from calendar date (branch closing)
    String teller,
    String conductorName,           // Person who physically conducted the transaction
    String conductorIdType,         // e.g., "PASSPORT", "DRIVERS_LICENSE"
    String conductorIdNumber,
    String beneficiaryName,         // Person on whose behalf (if different from conductor)
    boolean isOnBehalf
) {}

public enum TransactionType {
    CASH_DEPOSIT,
    CASH_WITHDRAWAL,
    CURRENCY_EXCHANGE_IN,
    CURRENCY_EXCHANGE_OUT,
    NEGOTIABLE_INSTRUMENT_PURCHASE,  // Money order, cashier's check purchased with cash
    LOAN_PAYMENT_CASH
}

public record DailyAggregation(
    String customerId,
    LocalDate businessDate,
    BigDecimal totalDeposits,
    BigDecimal totalWithdrawals,
    BigDecimal totalExchanges,
    BigDecimal totalNegotiableInstruments,
    int transactionCount,
    boolean ctrRequired,
    boolean ctrFiled,
    String ctrFilingId
) {}

public record CtrFiling(
    UUID filingId,
    String customerId,
    LocalDate businessDate,
    String confirmationNumber,
    OffsetDateTime filedAt,
    FilingStatus status,
    String xmlContent,
    boolean isAmendment,
    String originalFilingId
) {}

public enum FilingStatus {
    PENDING, SUBMITTED, ACCEPTED, REJECTED, AMENDED
}
```

---

## Redis-Based Real-Time Aggregation

The core of the CTR system is real-time aggregation using Redis. Each customer gets a set of counters keyed by business date. The critical implementation detail is using integer arithmetic in cents to avoid floating-point precision issues in a regulatory context.

```java
package com.fintech.ctf.aggregation;

import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;

@Service
public class CurrencyTransactionAggregator {

    // Key format: ctr:agg:{customerId}:{YYYY-MM-DD}:{metric}
    private static final String KEY_PATTERN = "ctr:agg:%s:%s:%s";
    private static final int TTL_DAYS = 3;  // Keep 3 days for late-arriving transactions
    private static final long CTR_THRESHOLD_CENTS = 1_000_000L;    // $10,000.00
    private static final long STRUCTURING_ALERT_CENTS = 900_000L;  // $9,000.00

    private final RedisCommands<String, String> redis;
    private final StructuringDetector structuringDetector;
    private final AlertPublisher alertPublisher;
    private final IdempotencyChecker idempotencyChecker;

    public CurrencyTransactionAggregator(
            RedisClient redisClient,
            StructuringDetector structuringDetector,
            AlertPublisher alertPublisher,
            IdempotencyChecker idempotencyChecker) {
        StatefulRedisConnection<String, String> connection = redisClient.connect();
        this.redis = connection.sync();
        this.structuringDetector = structuringDetector;
        this.alertPublisher = alertPublisher;
        this.idempotencyChecker = idempotencyChecker;
    }

    /**
     * Process a single currency transaction and update aggregation counters.
     * Returns the new daily total and whether CTR threshold was crossed.
     *
     * Thread safety: Redis INCRBY is atomic. Each customerId is processed on a
     * single Kafka partition, so no cross-thread contention on the same key.
     */
    public AggregationResult processTransaction(CurrencyTransaction tx) {
        // Idempotency check: Kafka at-least-once delivery can cause duplicates
        if (idempotencyChecker.alreadyProcessed(tx.transactionId())) {
            return AggregationResult.duplicate(tx.transactionId());
        }

        String dateStr = tx.businessDate().format(DateTimeFormatter.ISO_LOCAL_DATE);
        String depositKey   = buildKey(tx.customerId(), dateStr, "DEPOSITS");
        String withdrawalKey = buildKey(tx.customerId(), dateStr, "WITHDRAWALS");
        String txCountKey   = buildKey(tx.customerId(), dateStr, "COUNT");

        // Convert amount to cents for integer arithmetic — regulatory data must be exact
        long amountCents = tx.amountUsd()
            .multiply(new BigDecimal("100"))
            .longValueExact();

        long newRunningTotalCents = 0L;
        boolean crossedThreshold = false;

        switch (tx.type()) {
            case CASH_DEPOSIT, NEGOTIABLE_INSTRUMENT_PURCHASE -> {
                long prevDeposits    = getOrZero(depositKey);
                long prevWithdrawals = getOrZero(withdrawalKey);
                long prevTotal       = prevDeposits + prevWithdrawals;

                long newDeposits = redis.incrby(depositKey, amountCents);
                redis.incrby(txCountKey, 1);
                ensureTtl(depositKey, txCountKey);

                newRunningTotalCents = newDeposits + prevWithdrawals;
                crossedThreshold = checkThreshold(
                    tx.customerId(), dateStr, newRunningTotalCents, prevTotal);

                checkStructuring(tx, newDeposits, prevDeposits, txCountKey);
            }
            case CASH_WITHDRAWAL -> {
                long prevDeposits     = getOrZero(depositKey);
                long prevWithdrawals  = getOrZero(withdrawalKey);
                long prevTotal        = prevDeposits + prevWithdrawals;

                long newWithdrawals = redis.incrby(withdrawalKey, amountCents);
                redis.incrby(txCountKey, 1);
                ensureTtl(withdrawalKey, txCountKey);

                newRunningTotalCents = prevDeposits + newWithdrawals;
                crossedThreshold = checkThreshold(
                    tx.customerId(), dateStr, newRunningTotalCents, prevTotal);

                checkStructuring(tx, newWithdrawals, prevWithdrawals, txCountKey);
            }
            case CURRENCY_EXCHANGE_IN, CURRENCY_EXCHANGE_OUT -> {
                // Track currency exchanges separately — they aggregate independently
                String exchangeKey = buildKey(tx.customerId(), dateStr, "EXCHANGES");
                long newExchangeTotal = redis.incrby(exchangeKey, amountCents);
                redis.incrby(txCountKey, 1);
                ensureTtl(exchangeKey);
                newRunningTotalCents = newExchangeTotal;
            }
            case LOAN_PAYMENT_CASH -> {
                // Loan payments aggregate with other cash-in transactions
                long prevDeposits    = getOrZero(depositKey);
                long prevWithdrawals = getOrZero(withdrawalKey);
                long newDeposits     = redis.incrby(depositKey, amountCents);
                redis.incrby(txCountKey, 1);
                ensureTtl(depositKey);
                newRunningTotalCents = newDeposits + prevWithdrawals;
                crossedThreshold = checkThreshold(
                    tx.customerId(), dateStr, newRunningTotalCents, prevDeposits + prevWithdrawals);
            }
        }

        // Mark as processed for idempotency
        idempotencyChecker.markProcessed(tx.transactionId());

        return new AggregationResult(
            tx.customerId(),
            tx.businessDate(),
            new BigDecimal(newRunningTotalCents).divide(new BigDecimal("100")),
            crossedThreshold,
            false
        );
    }

    private boolean checkThreshold(
            String customerId, String dateStr,
            long newTotalCents, long previousTotalCents) {

        boolean wasBelow = previousTotalCents < CTR_THRESHOLD_CENTS;
        boolean isNowAbove = newTotalCents >= CTR_THRESHOLD_CENTS;

        if (wasBelow && isNowAbove) {
            String ctrFlagKey = buildKey(customerId, dateStr, "CTR_REQUIRED");
            redis.set(ctrFlagKey, "1");
            redis.expire(ctrFlagKey, (long) TTL_DAYS * 24 * 3600);

            alertPublisher.publishCtrThresholdCrossed(customerId, dateStr, newTotalCents);
            return true;
        }
        return false;
    }

    private void checkStructuring(
            CurrencyTransaction tx,
            long newDirectionalTotal, long prevDirectionalTotal,
            String txCountKey) {

        // Pattern 1: Running total lands in the $9,000–$9,999 zone
        if (newDirectionalTotal >= STRUCTURING_ALERT_CENTS
                && newDirectionalTotal < CTR_THRESHOLD_CENTS) {
            structuringDetector.recordNearThresholdActivity(
                tx.customerId(), tx.transactionId(), newDirectionalTotal);
        }

        // Pattern 2: Individual transaction amount is in the $9,000–$9,999 zone
        // AND it is not the first transaction (implies deliberate splitting)
        long txCount = getOrZero(txCountKey);
        long amountCents = tx.amountUsd()
            .multiply(new BigDecimal("100"))
            .longValueExact();

        if (amountCents >= STRUCTURING_ALERT_CENTS
                && amountCents < CTR_THRESHOLD_CENTS
                && txCount >= 2) {
            structuringDetector.recordPotentialStructuring(
                tx.customerId(), tx.transactionId(), tx.amountUsd(), txCount);
        }
    }

    private long getOrZero(String key) {
        String value = redis.get(key);
        return value == null ? 0L : Long.parseLong(value);
    }

    private void ensureTtl(String... keys) {
        long ttlSeconds = (long) TTL_DAYS * 24 * 3600;
        for (String key : keys) {
            long currentTtl = redis.ttl(key);
            if (currentTtl == -1) {  // Key exists but no TTL set (freshly created)
                redis.expire(key, ttlSeconds);
            }
        }
    }

    private String buildKey(String customerId, String dateStr, String metric) {
        return String.format(KEY_PATTERN, customerId, dateStr, metric);
    }

    public record AggregationResult(
        String customerId,
        LocalDate businessDate,
        BigDecimal newRunningTotal,
        boolean ctrThresholdCrossed,
        boolean duplicate
    ) {
        static AggregationResult duplicate(java.util.UUID txId) {
            return new AggregationResult(null, null, BigDecimal.ZERO, false, true);
        }
    }
}
```

---

## Structuring Detection Engine

Structuring (also called "smurfing") is the act of deliberately breaking up transactions to avoid the $10,000 reporting threshold. It is itself a federal crime under 31 U.S.C. § 5324, independent of any underlying crime. Detection is a mandatory compliance function.

```java
package com.fintech.ctf.structuring;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

@Service
public class StructuringDetector {

    private static final BigDecimal NEAR_THRESHOLD_LOW  = new BigDecimal("9000.00");
    private static final BigDecimal CTR_THRESHOLD       = new BigDecimal("10000.00");
    private static final int MULTI_DAY_WINDOW_DAYS      = 5;
    private static final int NEAR_THRESHOLD_DAY_MIN     = 3;   // 3+ near-threshold days = alert
    private static final int MULTI_PARTY_MIN_CONDUCTORS = 3;   // 3+ people = smurfing alert

    private final StructuringAlertRepository alertRepository;
    private final TransactionHistoryRepository txHistory;
    private final AlertPublisher alertPublisher;

    /**
     * Multi-day structuring detection: looks for a pattern of transactions
     * spread across multiple days that each stay just below $10,000.
     *
     * Classic example: $9,500 on Monday, $9,800 on Tuesday, $9,200 on Wednesday
     */
    public StructuringAlert detectMultiDayStructuring(
            String customerId, LocalDate endDate) {

        List<DailyTotal> recentTotals = txHistory.getDailyTotals(
            customerId,
            endDate.minusDays(MULTI_DAY_WINDOW_DAYS),
            endDate
        );

        List<DailyTotal> nearThresholdDays = recentTotals.stream()
            .filter(dt -> dt.totalCents() >= 900_000L)   // >= $9,000
            .filter(dt -> dt.totalCents() <  1_000_000L) // <  $10,000
            .toList();

        if (nearThresholdDays.size() >= NEAR_THRESHOLD_DAY_MIN) {
            BigDecimal totalExposure = nearThresholdDays.stream()
                .map(dt -> new BigDecimal(dt.totalCents()).divide(new BigDecimal("100")))
                .reduce(BigDecimal.ZERO, BigDecimal::add);

            int riskScore = calculateMultiDayRiskScore(nearThresholdDays);

            StructuringAlert alert = StructuringAlert.builder()
                .customerId(customerId)
                .alertType(StructuringAlertType.MULTI_DAY_STRUCTURING)
                .windowStart(endDate.minusDays(MULTI_DAY_WINDOW_DAYS))
                .windowEnd(endDate)
                .nearThresholdDayCount(nearThresholdDays.size())
                .totalExposure(totalExposure)
                .riskScore(riskScore)
                .build();

            if (riskScore >= 70) {
                alertPublisher.publishStructuringAlert(alert);
            }
            alertRepository.save(alert);
            return alert;
        }
        return null;
    }

    /**
     * Smurfing detection: multiple different conductors depositing into the same account.
     *
     * Example: Three strangers each deposit $9,900 into the same account on the same day.
     * This is textbook smurfing — multiple "smurfs" working on behalf of a single beneficiary.
     */
    public StructuringAlert detectSmurfing(
            String beneficiaryAccountId, LocalDate businessDate) {

        List<ConductorTransaction> conductorTxs = txHistory
            .getTransactionsByConductorForAccount(beneficiaryAccountId, businessDate);

        long distinctConductors = conductorTxs.stream()
            .map(ConductorTransaction::conductorIdNumber)
            .distinct()
            .count();

        if (distinctConductors >= MULTI_PARTY_MIN_CONDUCTORS) {
            BigDecimal totalDeposited = conductorTxs.stream()
                .map(ConductorTransaction::amount)
                .reduce(BigDecimal.ZERO, BigDecimal::add);

            StructuringAlert alert = StructuringAlert.builder()
                .customerId(beneficiaryAccountId)
                .alertType(StructuringAlertType.SMURFING)
                .businessDate(businessDate)
                .distinctConductorCount((int) distinctConductors)
                .totalExposure(totalDeposited)
                .riskScore(90)  // Smurfing is high-confidence — 90 out of 100
                .build();

            alertPublisher.publishStructuringAlert(alert);
            alertRepository.save(alert);
            return alert;
        }
        return null;
    }

    /**
     * Round-number avoidance: transactions of exactly $9,000, $9,500, $9,800, etc.
     * This is a behavioral indicator that the person knows the $10,000 threshold.
     * Legitimate customers rarely transact in round numbers near a specific threshold.
     */
    public boolean isRoundNumberAvoidance(BigDecimal amount) {
        if (amount.compareTo(NEAR_THRESHOLD_LOW) < 0)  return false;
        if (amount.compareTo(CTR_THRESHOLD)     >= 0)  return false;

        // Round number: divisible by $100 with no cents
        BigDecimal remainder = amount.remainder(new BigDecimal("100"));
        return remainder.compareTo(BigDecimal.ZERO) == 0;
    }

    private int calculateMultiDayRiskScore(List<DailyTotal> nearThresholdDays) {
        int baseScore = 40;

        // More near-threshold days → higher risk
        baseScore += Math.min(nearThresholdDays.size() * 10, 30);

        // High consistency in amount (all near $9,500) → higher risk
        // Low variance means the person is deliberately targeting the same amount
        double avgCents = nearThresholdDays.stream()
            .mapToLong(DailyTotal::totalCents)
            .average()
            .orElse(0);
        double variance = nearThresholdDays.stream()
            .mapToDouble(dt -> Math.pow(dt.totalCents() - avgCents, 2))
            .average()
            .orElse(Double.MAX_VALUE);

        if (variance < 100_000.0) {  // Very consistent amounts (< $10 std dev)
            baseScore += 20;
        }

        return Math.min(baseScore, 100);
    }

    public void recordNearThresholdActivity(
            String customerId, UUID transactionId, long runningTotalCents) {
        alertRepository.recordNearThreshold(customerId, transactionId, runningTotalCents);
    }

    public void recordPotentialStructuring(
            String customerId, UUID transactionId,
            BigDecimal amount, long txCount) {
        boolean roundNumber = isRoundNumberAvoidance(amount);
        alertRepository.recordPotentialStructuring(
            customerId, transactionId, amount, txCount, roundNumber);
    }
}
```

---

## Multi-Currency Handling

Financial institutions that handle foreign currency must convert to USD before applying the $10,000 threshold. The conversion must use the exchange rate at the time of the transaction, not the current rate. This creates a data retention requirement for historical exchange rates.

```java
package com.fintech.ctf.currency;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.OffsetDateTime;
import java.util.Currency;

@Service
public class CurrencyConversionService {

    private static final Currency USD = Currency.getInstance("USD");
    private final ExchangeRateProvider exchangeRateProvider;

    /**
     * Convert a foreign currency amount to USD at the transaction-time rate.
     * Per FinCEN guidance, the exchange rate used for CTR purposes must be the
     * rate at the time of the transaction, not the filing date.
     */
    public ConversionResult convertToUsd(
            BigDecimal amount,
            Currency fromCurrency,
            OffsetDateTime transactionTime) {

        if (fromCurrency.equals(USD)) {
            return new ConversionResult(amount, BigDecimal.ONE, USD, USD);
        }

        ExchangeRate rate = exchangeRateProvider.getRateAtTime(
            fromCurrency, USD, transactionTime);

        if (rate == null) {
            // Fall back to end-of-day rate if intraday rate is unavailable
            rate = exchangeRateProvider.getDailyRate(
                fromCurrency, USD, transactionTime.toLocalDate());
        }

        if (rate == null) {
            throw new ExchangeRateNotFoundException(
                "No exchange rate available for " + fromCurrency +
                " at " + transactionTime);
        }

        BigDecimal usdAmount = amount
            .multiply(rate.rate())
            .setScale(2, RoundingMode.HALF_UP);

        return new ConversionResult(usdAmount, rate.rate(), fromCurrency, USD);
    }

    /**
     * Analyze a currency exchange transaction. Both legs must be tracked:
     * the foreign currency sold AND the USD bought (or vice versa).
     * The CTR reports the higher of the two amounts.
     *
     * Example: Customer exchanges EUR 8,500 → USD 9,200.
     * The $9,200 USD leg is the reportable amount.
     */
    public CurrencyExchangeReport analyzeExchange(
            BigDecimal soldAmount, Currency soldCurrency,
            BigDecimal boughtAmount, Currency boughtCurrency,
            OffsetDateTime transactionTime) {

        BigDecimal soldUsd   = convertToUsd(soldAmount, soldCurrency, transactionTime).usdAmount();
        BigDecimal boughtUsd = convertToUsd(boughtAmount, boughtCurrency, transactionTime).usdAmount();

        // FinCEN requires reporting the higher of the two legs
        BigDecimal reportableAmount = soldUsd.max(boughtUsd);

        return new CurrencyExchangeReport(
            soldAmount, soldCurrency, soldUsd,
            boughtAmount, boughtCurrency, boughtUsd,
            reportableAmount
        );
    }

    public record ConversionResult(
        BigDecimal usdAmount,
        BigDecimal exchangeRate,
        Currency fromCurrency,
        Currency toCurrency
    ) {}

    public record CurrencyExchangeReport(
        BigDecimal soldAmount, Currency soldCurrency, BigDecimal soldUsd,
        BigDecimal boughtAmount, Currency boughtCurrency, BigDecimal boughtUsd,
        BigDecimal reportableAmount
    ) {}
}
```

---

## CTR Generation — Batch Job

CTRs are generated as a batch process after the business day closes. The 15-calendar-day filing deadline requires reliable batch scheduling, retry logic, and deadline tracking.

```java
package com.fintech.ctf.filing;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class CtrGenerationService {

    private static final int FILING_DEADLINE_DAYS   = 15;
    private static final int DEADLINE_WARNING_DAYS  = 3;

    private final CtrAggregationRepository aggregationRepo;
    private final CtrXmlGenerator xmlGenerator;
    private final BsaEFilingClient bsaClient;
    private final CtrFilingRepository filingRepo;
    private final DeadlineTrackerService deadlineTracker;
    private final AuditService auditService;

    /**
     * Main entry point. Called by scheduler after each business day closes.
     * Generates and files CTRs for all customers who crossed the $10,000 threshold.
     */
    public CtrGenerationResult generateAndFileCTRs(LocalDate businessDate) {
        List<String> customersRequiringCtr =
            aggregationRepo.findCustomersExceedingThreshold(businessDate);

        List<String> failedCustomers = new ArrayList<>();
        int filed = 0;

        for (String customerId : customersRequiringCtr) {
            try {
                CtrData ctrData = buildCtrData(customerId, businessDate);
                String xmlContent = xmlGenerator.generate(ctrData);

                // Validate XML against FinCEN schema before submission
                xmlGenerator.validate(xmlContent);

                BsaFilingResponse response = bsaClient.submitCtr(xmlContent);

                filingRepo.save(CtrFiling.builder()
                    .customerId(customerId)
                    .businessDate(businessDate)
                    .confirmationNumber(response.confirmationNumber())
                    .filedAt(OffsetDateTime.now())
                    .status(FilingStatus.ACCEPTED)
                    .xmlContent(xmlContent)
                    .isAmendment(false)
                    .build());

                aggregationRepo.markCtrFiled(
                    customerId, businessDate, response.confirmationNumber());

                auditService.log("CTR_FILED",
                    "CTR filed for customer " + customerId +
                    " business date " + businessDate +
                    " confirmation " + response.confirmationNumber());
                filed++;

            } catch (BsaValidationException e) {
                // XML validation failure — data quality issue
                filingRepo.recordFailure(customerId, businessDate,
                    "VALIDATION_FAILED: " + e.getMessage());
                failedCustomers.add(customerId);
            } catch (BsaSystemException e) {
                // FinCEN system is down — schedule retry
                filingRepo.recordFailure(customerId, businessDate,
                    "BSA_SYSTEM_ERROR: " + e.getMessage());
                scheduleRetry(customerId, businessDate);
                failedCustomers.add(customerId);
            }
        }

        checkDeadlineCompliance(businessDate);

        return new CtrGenerationResult(
            filed, failedCustomers.size(), failedCustomers, businessDate);
    }

    private CtrData buildCtrData(String customerId, LocalDate businessDate) {
        List<CurrencyTransaction> transactions =
            aggregationRepo.getTransactionsForCtr(customerId, businessDate);
        DailyAggregation aggregation =
            aggregationRepo.getDailyAggregation(customerId, businessDate);
        CustomerDetails customer =
            aggregationRepo.getCustomerDetails(customerId);

        return CtrData.builder()
            .filingInstitution(loadFilingInstitution())
            .businessDate(businessDate)
            .customer(customer)
            .transactions(transactions)
            .totalDeposits(aggregation.totalDeposits())
            .totalWithdrawals(aggregation.totalWithdrawals())
            .branchSummaries(summarizeByBranch(transactions))
            .conductors(extractUniqueConductors(transactions))
            .build();
    }

    private List<BranchSummary> summarizeByBranch(List<CurrencyTransaction> txs) {
        return txs.stream()
            .collect(Collectors.groupingBy(CurrencyTransaction::branchId))
            .entrySet().stream()
            .map(e -> new BranchSummary(
                e.getKey(),
                e.getValue().stream()
                    .map(CurrencyTransaction::amountUsd)
                    .reduce(BigDecimal.ZERO, BigDecimal::add),
                e.getValue().size()))
            .toList();
    }

    private List<ConductorInfo> extractUniqueConductors(List<CurrencyTransaction> txs) {
        return txs.stream()
            .filter(t -> t.conductorName() != null)
            .map(t -> new ConductorInfo(
                t.conductorName(), t.conductorIdType(),
                t.conductorIdNumber(), t.isOnBehalf()))
            .distinct()
            .toList();
    }

    private void checkDeadlineCompliance(LocalDate today) {
        LocalDate warningCutoff   = today.minusDays(FILING_DEADLINE_DAYS - DEADLINE_WARNING_DAYS);
        LocalDate violationCutoff = today.minusDays(FILING_DEADLINE_DAYS);

        List<UnfiledCtr> approaching = filingRepo.findUnfiledBeforeDate(warningCutoff);
        if (!approaching.isEmpty()) {
            deadlineTracker.alertApproachingDeadlines(approaching, today);
        }

        List<UnfiledCtr> overdue = filingRepo.findUnfiledBeforeDate(violationCutoff);
        if (!overdue.isEmpty()) {
            overdue.forEach(ctr -> auditService.logRegulatoryViolation(
                "CTR_OVERDUE",
                "CTR for customer " + ctr.customerId() +
                " business date " + ctr.businessDate() +
                " exceeds 15-day filing window",
                ctr.customerId()));
            deadlineTracker.escalateToBsaOfficer(overdue, today);
        }
    }

    private void scheduleRetry(String customerId, LocalDate businessDate) {
        // Persist retry request — will be picked up by retry job
        filingRepo.scheduleRetry(customerId, businessDate,
            OffsetDateTime.now().plusHours(2));
    }

    public record CtrGenerationResult(
        int filed, int failed,
        List<String> failedCustomerIds, LocalDate businessDate
    ) {}
}
```

---

## FinCEN XML Generation (FinCEN Form 112)

FinCEN's BSA E-Filing system accepts XML conforming to the FinCEN CTR schema. The schema version must match exactly — schema mismatches cause silent rejections. Always validate before submission.

```java
package com.fintech.ctf.filing;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.xml.sax.SAXException;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.Transformer;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.SchemaFactory;
import java.io.StringWriter;
import java.time.format.DateTimeFormatter;

@org.springframework.stereotype.Component
public class CtrXmlGenerator {

    private static final String FINCEN_NAMESPACE = "https://www.fincen.gov/base";
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final String CTR_SCHEMA_PATH = "classpath:fincen/FinCEN_CTR_v1.1.xsd";

    private final javax.xml.validation.Schema ctrSchema;

    public CtrXmlGenerator() throws SAXException {
        SchemaFactory sf = SchemaFactory.newInstance(
            javax.xml.XMLConstants.W3C_XML_SCHEMA_NS_URI);
        this.ctrSchema = sf.newSchema(
            new StreamSource(getClass().getResourceAsStream(
                "/fincen/FinCEN_CTR_v1.1.xsd")));
    }

    public String generate(CtrData ctrData) {
        try {
            var factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            Document doc = factory.newDocumentBuilder().newDocument();

            Element root = doc.createElementNS(FINCEN_NAMESPACE, "EFilingBatchXML");
            root.setAttribute("SeqNum", "1");
            root.setAttribute("TotalAmount",
                ctrData.totalDeposits().add(ctrData.totalWithdrawals()).toPlainString());
            doc.appendChild(root);

            Element activity = doc.createElement("Activity");
            activity.setAttribute("SeqNum", "1");
            root.appendChild(activity);

            appendFilingInstitution(doc, activity, ctrData.filingInstitution());
            appendActivityAssociation(doc, activity, ctrData);

            if (ctrData.totalDeposits().signum() > 0) {
                appendCashInTransaction(doc, activity, ctrData.totalDeposits(),
                    ctrData.businessDate());
            }
            if (ctrData.totalWithdrawals().signum() > 0) {
                appendCashOutTransaction(doc, activity, ctrData.totalWithdrawals(),
                    ctrData.businessDate());
            }

            appendSubjectParty(doc, activity, ctrData.customer());

            int seqNum = 10;
            for (ConductorInfo conductor : ctrData.conductors()) {
                appendConductorParty(doc, activity, conductor, seqNum++);
            }

            return serialize(doc);

        } catch (Exception e) {
            throw new CtrXmlGenerationException("CTR XML generation failed", e);
        }
    }

    public void validate(String xmlContent) {
        try {
            javax.xml.validation.Validator validator = ctrSchema.newValidator();
            validator.validate(new StreamSource(
                new java.io.StringReader(xmlContent)));
        } catch (Exception e) {
            throw new BsaValidationException("CTR XML validation failed: " + e.getMessage(), e);
        }
    }

    private void appendFilingInstitution(Document doc, Element parent, FilingInstitution inst) {
        Element party = doc.createElement("Party");
        party.setAttribute("SeqNum", "1");

        Element name = doc.createElement("PartyName");
        appendText(doc, name, "RawEntityIndividualLastName", inst.institutionName());
        party.appendChild(name);

        Element addr = doc.createElement("Address");
        appendText(doc, addr, "RawStreetAddress1", inst.streetAddress());
        appendText(doc, addr, "RawCityText", inst.city());
        appendText(doc, addr, "StateCodeText", inst.state());
        appendText(doc, addr, "ZIPCode", inst.zipCode());
        party.appendChild(addr);

        appendText(doc, party, "PartyTypeCode", "37");  // 37 = Filing Institution
        appendText(doc, party, "TINTypeCode",   "2");   // 2  = EIN
        appendText(doc, party, "TIN",           inst.ein());
        parent.appendChild(party);
    }

    private void appendActivityAssociation(Document doc, Element parent, CtrData data) {
        Element assoc = doc.createElement("ActivityAssociation");
        appendText(doc, assoc, "CorrectsAmendsPriorReportIndicator",
            data.isAmendment() ? "Y" : "N");
        if (data.isAmendment() && data.originalBsaId() != null) {
            appendText(doc, assoc, "PriorReportBSAIdentifier", data.originalBsaId());
        }
        parent.appendChild(assoc);
    }

    private void appendCashInTransaction(
            Document doc, Element parent,
            java.math.BigDecimal amount, java.time.LocalDate date) {
        Element tx = doc.createElement("CurrencyTransactionActivity");
        tx.setAttribute("SeqNum", "1");
        appendText(doc, tx, "TransactionDateText", date.format(DATE_FMT));
        appendText(doc, tx, "CurrencyTransactionActivityDetailTypeCode", "2"); // 2 = Deposit
        appendText(doc, tx, "DetailTransactionAmountText",
            amount.setScale(0, java.math.RoundingMode.HALF_UP).toPlainString());
        appendText(doc, tx, "CurrencyLocalCountryCode", "US");
        parent.appendChild(tx);
    }

    private void appendCashOutTransaction(
            Document doc, Element parent,
            java.math.BigDecimal amount, java.time.LocalDate date) {
        Element tx = doc.createElement("CurrencyTransactionActivity");
        tx.setAttribute("SeqNum", "2");
        appendText(doc, tx, "TransactionDateText", date.format(DATE_FMT));
        appendText(doc, tx, "CurrencyTransactionActivityDetailTypeCode", "3"); // 3 = Withdrawal
        appendText(doc, tx, "DetailTransactionAmountText",
            amount.setScale(0, java.math.RoundingMode.HALF_UP).toPlainString());
        appendText(doc, tx, "CurrencyLocalCountryCode", "US");
        parent.appendChild(tx);
    }

    private void appendSubjectParty(Document doc, Element parent, CustomerDetails customer) {
        Element party = doc.createElement("Party");
        party.setAttribute("SeqNum", "5");

        Element pName = doc.createElement("PartyName");
        if (customer.isIndividual()) {
            appendText(doc, pName, "RawIndividualLastName",  customer.lastName());
            appendText(doc, pName, "RawIndividualFirstName", customer.firstName());
            if (customer.middleName() != null) {
                appendText(doc, pName, "RawIndividualMiddleName", customer.middleName());
            }
        } else {
            appendText(doc, pName, "RawEntityIndividualLastName", customer.businessName());
        }
        party.appendChild(pName);

        if (customer.dateOfBirth() != null) {
            appendText(doc, party, "BirthDateText",
                customer.dateOfBirth().format(DATE_FMT));
        }

        Element addr = doc.createElement("Address");
        appendText(doc, addr, "RawStreetAddress1", customer.streetAddress());
        appendText(doc, addr, "RawCityText",        customer.city());
        appendText(doc, addr, "StateCodeText",      customer.state());
        appendText(doc, addr, "ZIPCode",            customer.zipCode());
        party.appendChild(addr);

        appendText(doc, party, "PartyTypeCode", "35");  // 35 = Subject
        parent.appendChild(party);
    }

    private void appendConductorParty(
            Document doc, Element parent, ConductorInfo conductor, int seqNum) {
        Element party = doc.createElement("Party");
        party.setAttribute("SeqNum", String.valueOf(seqNum));

        Element pName = doc.createElement("PartyName");
        String[] parts = conductor.name().split(" ", 2);
        appendText(doc, pName, "RawIndividualFirstName",
            parts.length > 0 ? parts[0] : conductor.name());
        if (parts.length > 1) {
            appendText(doc, pName, "RawIndividualLastName", parts[1]);
        }
        party.appendChild(pName);

        appendText(doc, party, "PartyTypeCode",
            conductor.isOnBehalf() ? "58" : "35");  // 58 = On behalf of

        party.appendChild(buildPartyIdentification(doc, conductor));
        parent.appendChild(party);
    }

    private Element buildPartyIdentification(Document doc, ConductorInfo conductor) {
        Element id = doc.createElement("PartyIdentification");
        appendText(doc, id, "PartyIdentificationTypeCode",
            mapIdType(conductor.idType()));
        appendText(doc, id, "TIN", conductor.idNumber());
        return id;
    }

    private String mapIdType(String idType) {
        return switch (idType) {
            case "PASSPORT"        -> "2";
            case "DRIVERS_LICENSE" -> "5";
            case "SSN"             -> "1";
            case "EIN"             -> "3";
            default                -> "9";  // Other
        };
    }

    private void appendText(Document doc, Element parent, String tag, String value) {
        if (value == null || value.isBlank()) return;
        Element el = doc.createElement(tag);
        el.setTextContent(value);
        parent.appendChild(el);
    }

    private String serialize(Document doc) throws Exception {
        Transformer t = TransformerFactory.newInstance().newTransformer();
        t.setOutputProperty(OutputKeys.INDENT,   "yes");
        t.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
        StringWriter sw = new StringWriter();
        t.transform(new DOMSource(doc), new StreamResult(sw));
        return sw.toString();
    }
}
```

---

## Exempt Person Management

The BSA allows banks to exempt certain customers from CTR filing. Managing exemptions is itself a regulated activity — improperly claiming an exemption is a BSA violation.

```java
package com.fintech.ctf.exemption;

import org.springframework.stereotype.Service;

import java.time.LocalDate;

@Service
public class ExemptPersonService {

    private final ExemptPersonRepository repository;
    private final AuditService auditService;

    public enum ExemptionPhase {
        PHASE_I,   // Banks, government entities, NYSE/AMEX listed companies — no annual renewal
        PHASE_II   // Non-listed businesses, payroll customers — annual renewal required
    }

    public enum ExemptionStatus {
        EXEMPT, NOT_EXEMPT, EXPIRED, RENEWAL_REQUIRED
    }

    /**
     * Check if a customer is exempt from CTR filing for a given business date.
     * Phase II exemptions expire annually; institutions must file a new Designation
     * of Exempt Person (FinCEN Form 110) each year.
     */
    public ExemptionStatus checkExemption(String customerId, LocalDate businessDate) {
        ExemptPerson exempt = repository.findByCustomerId(customerId);
        if (exempt == null) return ExemptionStatus.NOT_EXEMPT;

        if (exempt.expirationDate() != null
                && businessDate.isAfter(exempt.expirationDate())) {
            auditService.log("EXEMPTION_EXPIRED",
                "CTR exemption expired for " + customerId +
                " on " + exempt.expirationDate(), customerId);
            return ExemptionStatus.EXPIRED;
        }

        if (exempt.exemptionPhase() == ExemptionPhase.PHASE_II) {
            LocalDate renewalDue = exempt.lastRenewalDate().plusYears(1);
            if (businessDate.isAfter(renewalDue)) {
                return ExemptionStatus.RENEWAL_REQUIRED;
            }
        }

        return ExemptionStatus.EXEMPT;
    }

    /**
     * When a CTR-threshold transaction occurs for an exempt customer,
     * log it with full audit trail — the exemption itself is auditable.
     */
    public void logExemptTransaction(
            String customerId, LocalDate businessDate, java.math.BigDecimal amount) {
        auditService.log("CTR_EXEMPT_TRANSACTION",
            "Customer " + customerId + " transaction $" + amount +
            " on " + businessDate + " — exempt from CTR (Phase " +
            repository.findByCustomerId(customerId).exemptionPhase() + ")",
            customerId);
    }
}
```

---

## Kafka Consumer Integration

```java
package com.fintech.ctf.consumer;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

@Component
public class CurrencyTransactionConsumer {

    private final CurrencyTransactionAggregator aggregator;
    private final ExemptPersonService exemptionService;
    private final StructuringDetector structuringDetector;

    /**
     * Consume currency transaction events from Kafka.
     * Topic is partitioned by customerId, ensuring ordering within a customer
     * (critical for accurate daily aggregation).
     *
     * concurrency = number of Kafka partitions — do NOT set higher than partition count,
     * as extra consumers sit idle and waste resources.
     */
    @KafkaListener(
        topics = "currency-transactions",
        groupId = "ctf-aggregation",
        concurrency = "12"
    )
    public void processTransaction(
            ConsumerRecord<String, CurrencyTransaction> record,
            Acknowledgment ack) {

        CurrencyTransaction tx = record.value();

        try {
            ExemptPersonService.ExemptionStatus exemptStatus =
                exemptionService.checkExemption(tx.customerId(), tx.businessDate());

            if (exemptStatus == ExemptPersonService.ExemptionStatus.EXEMPT) {
                exemptionService.logExemptTransaction(
                    tx.customerId(), tx.businessDate(), tx.amountUsd());
                ack.acknowledge();
                return;
            }

            CurrencyTransactionAggregator.AggregationResult result =
                aggregator.processTransaction(tx);

            if (!result.duplicate()) {
                // Run multi-day structuring check on each new transaction
                structuringDetector.detectMultiDayStructuring(
                    tx.customerId(), tx.businessDate());

                // Run smurfing check if the transaction was conducted by someone
                // other than the account holder
                if (tx.isOnBehalf()) {
                    structuringDetector.detectSmurfing(
                        tx.accountId(), tx.businessDate());
                }
            }

            ack.acknowledge();

        } catch (Exception e) {
            // Do NOT acknowledge — allow Kafka retry
            // Throw to trigger Spring Kafka's retry/DLQ policy
            throw new CurrencyTransactionProcessingException(
                "Failed to process transaction " + tx.transactionId(), e);
        }
    }
}
```

---

## Production Operations

**Redis cluster sizing:** At a mid-size bank processing 500,000 cash transactions per day with 100,000 active cash customers, each customer has approximately 8 Redis keys (deposits, withdrawals, exchanges, negotiable instruments, counts, CTR flag, structuring flag, idempotency set). At roughly 150 bytes per key, the total footprint is under 150 MB — a single Redis node handles this easily. The bottleneck is throughput, not memory.

**Late transactions:** Tellers post transactions after close of business. Configure a 2-hour post-close window where transactions still apply to the previous business date. After that window, any late-arriving transaction requires supervisor override and a full audit trail entry. Never silently re-assign a late transaction's business date.

**Idempotency:** Transaction messages may be delivered more than once from Kafka. Store processed `transactionId` values in a Redis SET with a 48-hour TTL per customer per business date. Before aggregating, check the SET. After aggregating, add to the SET.

**Reconciliation:** Every night, run a reconciliation job comparing Redis aggregation totals against the core banking system ledger. Any discrepancy exceeding $1.00 must block CTR filing until resolved. File a reconciliation failure incident with the BSA Officer.

**CTR amendment process:** If you discover an error in a filed CTR, file a corrected CTR as soon as the error is discovered. Mark the amendment with the original confirmation number in the `PriorReportBSAIdentifier` XML field.

---

## Testing Strategy

```java
package com.fintech.ctf.test;

import org.junit.jupiter.api.Test;
import java.math.BigDecimal;
import static org.assertj.core.api.Assertions.assertThat;

class CurrencyTransactionAggregatorTest {

    @Test
    void singleTransactionOverThresholdTriggersCtr() {
        var tx = buildTx("CUST-001", new BigDecimal("10500.00"), TransactionType.CASH_DEPOSIT);
        var result = aggregator.processTransaction(tx);
        assertThat(result.ctrThresholdCrossed()).isTrue();
    }

    @Test
    void threeSmallTransactionsAggregateAboveThreshold() {
        processDeposit("CUST-002", "4000.00");
        processDeposit("CUST-002", "3500.00");
        var result = processDeposit("CUST-002", "3000.00");

        assertThat(result.ctrThresholdCrossed()).isTrue();
        assertThat(result.newRunningTotal())
            .isEqualByComparingTo(new BigDecimal("10500.00"));
    }

    @Test
    void justBelowThresholdDoesNotTriggerCtr() {
        var result = processDeposit("CUST-003", "9999.99");
        assertThat(result.ctrThresholdCrossed()).isFalse();
    }

    @Test
    void duplicateTransactionIsIgnored() {
        var tx = buildTx("CUST-004", new BigDecimal("5000.00"), TransactionType.CASH_DEPOSIT);
        aggregator.processTransaction(tx);
        var secondResult = aggregator.processTransaction(tx);  // Same transactionId
        assertThat(secondResult.duplicate()).isTrue();
        // Running total should not be doubled
        assertThat(secondResult.newRunningTotal()).isEqualByComparingTo(BigDecimal.ZERO);
    }

    @Test
    void roundNumberNearThresholdFlagsAsStructuring() {
        var detector = new StructuringDetector(...);
        assertThat(detector.isRoundNumberAvoidance(new BigDecimal("9500.00"))).isTrue();
        assertThat(detector.isRoundNumberAvoidance(new BigDecimal("9487.32"))).isFalse();
        assertThat(detector.isRoundNumberAvoidance(new BigDecimal("10000.00"))).isFalse();
        assertThat(detector.isRoundNumberAvoidance(new BigDecimal("8999.00"))).isFalse();
    }
}
```

---

## Summary

Building a production CTR system requires balancing real-time aggregation accuracy with batch filing reliability. The critical engineering decisions are:

1. **Use Redis integer arithmetic in cents** — floating-point errors in regulatory dollar amounts are unacceptable.
2. **Separate structuring detection from CTR generation** — different urgency, different SLAs, different error semantics.
3. **Multi-currency must convert at transaction time** — not at filing time; retain historical exchange rates for at least 7 years.
4. **15-day deadline requires automated escalation** — with an audit trail for overdue filings regardless of reason.
5. **Idempotency is non-negotiable** — FinCEN does not accept duplicate CTR filings; deduplication must be durable.
6. **Exempt person management is auditable** — every exemption and every transaction covered by an exemption must be logged.
7. **Validate XML before submission** — the FinCEN schema version changes; run schema validation in CI against every release.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why must CTR aggregation use integer arithmetic in cents rather than floating-point arithmetic?",
      "options": ["Integer arithmetic is faster on modern hardware", "Floating-point arithmetic can introduce rounding errors that make regulatory dollar amounts inaccurate — unacceptable for mandatory filings", "FinCEN's XML schema only accepts integer values", "Redis does not support floating-point storage"],
      "correct": 1,
      "explanation": "Floating-point representations of decimal amounts can produce rounding errors (e.g., $9,999.99 represented as $9,999.989999...). For regulatory dollar amounts reported to FinCEN, any rounding error is unacceptable. Storing amounts as long integer cents eliminates this problem entirely."
    },
    {
      "text": "What is the structuring pattern known as 'smurfing' and how does the system detect it?",
      "options": ["A single customer depositing just below $10,000 on consecutive days", "Multiple different conductors depositing into the same beneficiary account to aggregate above the $10,000 threshold", "A customer using multiple accounts at the same institution", "Round-number transactions just below $9,500"],
      "correct": 1,
      "explanation": "Smurfing involves multiple individuals (smurfs) each depositing below the CTR threshold into a single beneficiary account. Detection tracks distinct conductor IDs for deposits into the same account on the same business day — if 3+ distinct conductors are found, a smurfing alert is raised."
    },
    {
      "text": "Why is multi-currency exchange rate conversion for CTR purposes performed at transaction time rather than filing time?",
      "options": ["Exchange rates are unavailable at filing time", "FinCEN requires the rate at the time of the transaction, not the current rate — creating a 7-year historical exchange rate retention requirement", "Transaction-time rates are more favourable for the institution", "Real-time rates are more accurate than end-of-day rates"],
      "correct": 1,
      "explanation": "FinCEN guidance requires using the exchange rate at the time of the transaction for CTR purposes. This means historical exchange rates must be retained for at least 7 years — the same retention period as the transaction records themselves."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Real-Time CTR Aggregation System with Structuring Detection",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Implement the CurrencyTransactionAggregator using Redis integer arithmetic (store amounts in cents as a Long). Use a Lua script for atomic increment-and-check operations. The aggregator must be idempotent — store processed transactionIds in a Redis SET with a 48-hour TTL and return a duplicate=true result for repeated messages."},
    {"id": "2", "description": "Implement the StructuringDetector with three detection methods: (a) detectMultiDayStructuring() that looks back 7 days for 3+ near-threshold days, (b) detectSmurfing() that counts distinct conductors depositing into the same account in a single business day, (c) isRoundNumberAvoidance() that identifies transactions divisible by $100 between $9,000 and $10,000."},
    {"id": "3", "description": "Implement the CtrGenerationService.generateAndFileCTRs() batch method that queries all customers exceeding the threshold for a given business date, generates FinCEN CTR XML, validates the XML against the FinCEN CTR schema, submits to BSA e-Filing, and handles the three outcomes: ACCEPTED (store confirmation number), VALIDATION_FAILED (data quality alert), BSA_SYSTEM_ERROR (schedule retry with deadline tracking)."},
    {"id": "4", "description": "Write four unit tests for the aggregator: single transaction above threshold triggers CTR, three aggregated deposits above threshold triggers CTR, single transaction just below threshold does not trigger CTR, and duplicate transactionId is detected and ignored without affecting the running total."}
  ]
}
-->
