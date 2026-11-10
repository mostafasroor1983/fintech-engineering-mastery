---
id: track-07-lesson-04
title: "Fraud Detection — Rule Engine Architecture"
slug: fraud-rule-engine
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 4
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [fraud-detection, rule-engine, Drools, decision-table, real-time]
prerequisites: [track-07-lesson-01]
---

# Fraud Detection — Rule Engine Architecture

> [!NOTE]
> A fraud rule engine is a real-time system with a hard SLA: in card payment networks, you have 100ms total to approve or decline a transaction from the point it enters your system. The rule engine must evaluate dozens of rules, check velocity counters, look up account history, and return a decision — all within that window. Architecture complexity is ruthlessly constrained by latency.

## Why Rule Engines for Fraud?

Machine learning models are powerful but opaque. When a fraud analyst asks "why was this transaction declined?", a model cannot give a human-readable explanation. When a customer is wrongly blocked, you need to explain which rule triggered and why.

Rule engines provide:
- **Explainability** — every decision can be traced to specific rules
- **Auditability** — compliance teams can inspect and approve rules
- **Speed** — rules execute in microseconds vs ML inference in milliseconds
- **Versioning** — rules can be changed without redeployment
- **A/B testing** — test new rules against a percentage of traffic

---

## Fraud Decision Data Model

```java
// Transaction presented to the rule engine
public record FraudEvaluationContext(
    // Transaction details
    UUID transactionId,
    String accountId,
    String merchantId,
    String merchantCategoryCode,
    BigDecimal amount,
    String currency,
    Instant transactionTime,
    TransactionChannel channel,     // CARD, ONLINE, MOBILE, ATM

    // Device and location
    String deviceId,
    String deviceIpAddress,
    String deviceCountry,
    String cardPresentCountry,
    boolean isCardPresent,
    Double latitude,
    Double longitude,

    // Customer context (pre-fetched)
    CustomerProfile customerProfile,
    AccountSummary accountSummary,
    VelocityCounters velocityCounters,
    DeviceHistory deviceHistory,
    MerchantHistory merchantHistory
) {}

// Rule engine output
public record FraudDecision(
    UUID transactionId,
    FraudAction action,                    // APPROVE, DECLINE, STEP_UP, REVIEW
    int fraudScore,                        // 0-1000
    List<String> triggeredRuleNames,       // audit trail
    Map<String, Object> ruleDetails,       // per-rule scores
    Instant decidedAt,
    long evaluationMillis
) {}

public enum FraudAction {
    APPROVE,        // Allow transaction
    DECLINE,        // Block transaction
    STEP_UP,        // Require additional authentication (3DS, OTP)
    REVIEW          // Allow through but flag for analyst review
}
```

---

## Velocity Counter Architecture with Redis

Velocity rules check how many transactions occurred within a time window. These counters must be fast (sub-millisecond) and work across all service instances.

```java
@Component
@Slf4j
public class VelocityCounterService {

    private final StringRedisTemplate redisTemplate;

    // Sliding window counter using Redis sorted sets
    // Key: velocity:{dimension}:{id}:{window_name}
    // Score: timestamp
    // Member: transactionId

    public VelocityCounters getCounters(String accountId, String deviceId, String merchantId) {
        Instant now = Instant.now();

        // Execute all counter fetches in a Redis pipeline
        List<Object> results = redisTemplate.executePipelined((RedisCallback<Object>) connection -> {
            addAndCountRequests(connection, accountId, "account", now);
            addAndCountRequests(connection, deviceId, "device", now);
            addAndCountRequests(connection, merchantId, "merchant", now);
            return null;
        });

        return VelocityCounters.builder()
            .accountTxLast1h(extractCount(results, 0))
            .accountTxLast24h(extractCount(results, 1))
            .accountAmountLast1h(extractAmount(results, 2))
            .deviceTxLast1h(extractCount(results, 3))
            .deviceTxLast24h(extractCount(results, 4))
            .newMerchant(!isMerchantKnown(accountId, merchantId))
            .build();
    }

    private void addAndCountRequests(RedisConnection conn, String id, String dimension, Instant now) {
        byte[] keyHour  = key(dimension, id, "1h");
        byte[] keyDay   = key(dimension, id, "24h");
        long nowMs = now.toEpochMilli();
        long oneHourAgoMs = now.minus(Duration.ofHours(1)).toEpochMilli();
        long oneDayAgoMs  = now.minus(Duration.ofHours(24)).toEpochMilli();

        // Remove expired members
        conn.zRemRangeByScore(keyHour, Double.NEGATIVE_INFINITY, oneHourAgoMs);
        conn.zRemRangeByScore(keyDay,  Double.NEGATIVE_INFINITY, oneDayAgoMs);

        // Count current members
        conn.zCard(keyHour);
        conn.zCard(keyDay);
    }

    // Record a completed transaction in velocity counters
    public void recordTransaction(FraudEvaluationContext ctx) {
        String txId = ctx.transactionId().toString();
        long score = ctx.transactionTime().toEpochMilli();

        redisTemplate.executePipelined((RedisCallback<Object>) connection -> {
            recordToKey(connection, "account", ctx.accountId(), txId, score);
            recordToKey(connection, "device", ctx.deviceId(), txId, score);
            recordToKey(connection, "merchant", ctx.merchantId(), txId, score);
            return null;
        });
    }

    private void recordToKey(RedisConnection conn, String dim, String id, String txId, long score) {
        if (id == null) return;
        byte[] keyHour = key(dim, id, "1h");
        byte[] keyDay  = key(dim, id, "24h");
        conn.zAdd(keyHour, score, txId.getBytes());
        conn.expire(keyHour, 3700);  // slightly over 1 hour for safety
        conn.zAdd(keyDay, score, txId.getBytes());
        conn.expire(keyDay, 86500);
    }

    private byte[] key(String dimension, String id, String window) {
        return ("velocity:" + dimension + ":" + id + ":" + window).getBytes();
    }
}
```

---

## Drools Rule Engine Integration

Drools is a mature, Java-native rule engine with a Domain Specific Language (DRL) for expressing fraud rules.

```java
// Drools KIE Session configuration
@Configuration
public class DroolsConfig {

    @Bean
    public KieContainer kieContainer() {
        KieServices kieServices = KieServices.Factory.get();
        KieFileSystem kieFileSystem = kieServices.newKieFileSystem();

        // Load rules from classpath — replace with DB-backed dynamic loading in production
        Resource rulesResource = kieServices.getResources()
            .newClassPathResource("rules/fraud-rules.drl");
        kieFileSystem.write(rulesResource);

        KieBuilder kieBuilder = kieServices.newKieBuilder(kieFileSystem);
        kieBuilder.buildAll();

        if (kieBuilder.getResults().hasMessages(Message.Level.ERROR)) {
            throw new RuntimeException("Rules build failed: " + kieBuilder.getResults().toString());
        }

        return kieServices.newKieContainer(kieServices.getRepository().getDefaultReleaseId());
    }

    @Bean
    @Scope("prototype") // new session per evaluation — stateless
    public KieSession kieSession(KieContainer kieContainer) {
        return kieContainer.newKieSession();
    }
}
```

```
// fraud-rules.drl — Drools Rule Language
package com.fintech.fraud.rules

import com.fintech.fraud.FraudEvaluationContext
import com.fintech.fraud.FraudDecision
import com.fintech.fraud.FraudAction
import java.math.BigDecimal

global com.fintech.fraud.FraudDecisionAccumulator result

// Rule: High-value transaction from new device
rule "High Value New Device"
    salience 100
    when
        $ctx : FraudEvaluationContext(
            amount > 1000,
            deviceHistory.isNewDevice() == true,
            accountSummary.accountAgeInDays() < 90
        )
    then
        result.addScore(300, "HIGH_VALUE_NEW_DEVICE");
        result.addTriggeredRule("High Value New Device");
end

// Rule: Velocity breach — too many transactions in 1 hour
rule "Account Velocity Breach 1h"
    salience 90
    when
        $ctx : FraudEvaluationContext(
            velocityCounters.accountTxLast1h() > 10
        )
    then
        result.addScore(250, "ACCOUNT_VELOCITY_BREACH_1H");
        result.addTriggeredRule("Account Velocity Breach 1h");
end

// Rule: Unusual merchant category for customer
rule "Unusual Merchant Category"
    salience 80
    when
        $ctx : FraudEvaluationContext(
            merchantHistory.isFirstTimeCategory() == true,
            amount > 500,
            channel == TransactionChannel.ONLINE
        )
    then
        result.addScore(150, "UNUSUAL_MERCHANT_CATEGORY");
        result.addTriggeredRule("Unusual Merchant Category");
end

// Rule: Geolocation anomaly — transaction in different country to account home
rule "Geographic Anomaly"
    salience 85
    when
        $ctx : FraudEvaluationContext(
            cardPresentCountry != null,
            customerProfile.homeCountry() != null,
            cardPresentCountry != customerProfile.homeCountry(),
            customerProfile.hasRecentTravelNotification() == false
        )
    then
        result.addScore(200, "GEOGRAPHIC_ANOMALY");
        result.addTriggeredRule("Geographic Anomaly");
end

// Rule: Amount > 3x customer average
rule "Amount Anomaly"
    salience 70
    when
        $ctx : FraudEvaluationContext(
            amount > accountSummary.averageTransactionAmount() * 3,
            amount > 200
        )
    then
        result.addScore(180, "AMOUNT_ANOMALY");
        result.addTriggeredRule("Amount Anomaly");
end

// Rule: Automatic decline for known fraud device
rule "Known Fraud Device"
    salience 1000
    when
        $ctx : FraudEvaluationContext(
            deviceHistory.isKnownFraudDevice() == true
        )
    then
        result.forceDecline("KNOWN_FRAUD_DEVICE");
        result.addTriggeredRule("Known Fraud Device");
        drools.halt();  // stop processing further rules
end

// Rule: Automatic decline if final score >= 700
rule "High Score Decline"
    salience -100  // evaluate last
    when
        result.getTotalScore() >= 700
    then
        result.setAction(FraudAction.DECLINE);
end

// Rule: Step-up authentication for score 400-699
rule "Medium Score Step Up"
    salience -100
    when
        result.getTotalScore() >= 400,
        result.getTotalScore() < 700,
        result.getAction() != FraudAction.DECLINE
    then
        result.setAction(FraudAction.STEP_UP);
end
```

---

## Rule Engine Service

```java
@Service
@Slf4j
public class FraudRuleEngineService {

    private final KieContainer kieContainer;
    private final VelocityCounterService velocityService;
    private final CustomerProfileService profileService;
    private final MeterRegistry meterRegistry;

    public FraudDecision evaluate(FraudEvaluationContext context) {
        long startMs = System.currentTimeMillis();

        KieSession session = kieContainer.newKieSession();
        FraudDecisionAccumulator accumulator = new FraudDecisionAccumulator();

        try {
            session.setGlobal("result", accumulator);
            session.insert(context);
            session.fireAllRules();
        } finally {
            session.dispose(); // important: prevents memory leak
        }

        FraudDecision decision = accumulator.build(context.transactionId(),
            System.currentTimeMillis() - startMs);

        log.info("Fraud evaluation tx={} score={} action={} rules={} latencyMs={}",
            context.transactionId(), decision.fraudScore(), decision.action(),
            decision.triggeredRuleNames(), decision.evaluationMillis());

        meterRegistry.timer("fraud.rule.evaluation.duration")
            .record(Duration.ofMillis(decision.evaluationMillis()));
        meterRegistry.counter("fraud.decision",
            "action", decision.action().name()
        ).increment();

        return decision;
    }
}

// Accumulates scores and triggered rules during Drools session
public class FraudDecisionAccumulator {

    private int totalScore = 0;
    private FraudAction action = FraudAction.APPROVE;
    private final List<String> triggeredRules = new ArrayList<>();
    private final Map<String, Integer> ruleScores = new LinkedHashMap<>();
    private boolean forceDeclined = false;

    public void addScore(int score, String reason) {
        this.totalScore += score;
        this.ruleScores.put(reason, score);
    }

    public void addTriggeredRule(String ruleName) {
        triggeredRules.add(ruleName);
    }

    public void forceDecline(String reason) {
        this.forceDeclined = true;
        this.action = FraudAction.DECLINE;
        this.ruleScores.put("FORCED_DECLINE:" + reason, 1000);
    }

    public void setAction(FraudAction action) {
        if (!forceDeclined) {
            this.action = action;
        }
    }

    public FraudDecision build(UUID transactionId, long evaluationMillis) {
        return new FraudDecision(
            transactionId, action, totalScore, List.copyOf(triggeredRules),
            Map.copyOf(ruleScores), Instant.now(), evaluationMillis
        );
    }
}
```

---

## Decision Tables for Business Users

Compliance and fraud teams need to manage rules without developer involvement. Decision tables in Excel format map to Drools rules.

```java
// Decision table: maps merchant category codes to risk scores
// Loaded from an Excel spreadsheet at startup
@Component
public class MerchantCategoryRiskTable {

    private final Map<String, MerchantCategoryRisk> riskTable = new HashMap<>();

    @PostConstruct
    public void loadDecisionTable() {
        try (Workbook workbook = WorkbookFactory.create(
                getClass().getResourceAsStream("/rules/merchant-category-risk.xlsx"))) {

            Sheet sheet = workbook.getSheet("MCC_RISK_SCORES");
            for (Row row : sheet) {
                if (row.getRowNum() == 0) continue; // header

                String mcc = getCellValue(row, 0);
                String categoryName = getCellValue(row, 1);
                int baseRiskScore = Integer.parseInt(getCellValue(row, 2));
                boolean requiresEdd = Boolean.parseBoolean(getCellValue(row, 3));

                riskTable.put(mcc, new MerchantCategoryRisk(
                    mcc, categoryName, baseRiskScore, requiresEdd
                ));
            }

            log.info("Loaded {} merchant category risk scores", riskTable.size());
        } catch (IOException ex) {
            throw new RuntimeException("Failed to load merchant category risk table", ex);
        }
    }

    public int getRiskScore(String merchantCategoryCode) {
        MerchantCategoryRisk risk = riskTable.get(merchantCategoryCode);
        return risk != null ? risk.baseRiskScore() : 50; // default moderate risk
    }

    // High-risk MCCs relevant to financial crime
    // 6051: Non-Financial Institutions (crypto exchanges, money services)
    // 7995: Betting/Casino
    // 5912: Drug Stores (potential for structured purchases)
    // 4829: Wire Transfer Money Orders
}
```

---

## Rule Versioning and A/B Testing

```java
@Service
@Slf4j
public class FraudRuleVersionManager {

    private final KieContainer activeContainer;
    private final Map<String, KieContainer> testContainers = new ConcurrentHashMap<>();
    private final ABTestRegistry abTestRegistry;

    // Deploy a new rule set alongside the current one for A/B testing
    public void deployTestRuleSet(String testName, String rulesContent, double trafficPercentage) {
        KieContainer testContainer = buildRuleContainer(rulesContent);
        testContainers.put(testName, testContainer);
        abTestRegistry.registerTest(testName, trafficPercentage);
        log.info("Deployed test rule set name={} trafficPct={}", testName, trafficPercentage);
    }

    public FraudDecision evaluate(FraudEvaluationContext context) {
        // Determine which rule set to use for this transaction
        String testName = abTestRegistry.assignTest(context.transactionId());

        KieContainer container = testName != null
            ? testContainers.getOrDefault(testName, activeContainer)
            : activeContainer;

        FraudDecision decision = executeRules(container, context);

        // Record which rule set was used for analysis
        if (testName != null) {
            abTestRegistry.recordDecision(testName, context.transactionId(), decision);
        }

        return decision;
    }

    // Promote test rule set to production after validation
    public void promoteToProduction(String testName) {
        KieContainer testContainer = testContainers.get(testName);
        if (testContainer == null) {
            throw new IllegalArgumentException("No test rule set: " + testName);
        }

        // Atomic swap — all new evaluations use the new container
        // Old container continues serving in-flight evaluations
        kieContainerRef.set(testContainer);
        testContainers.remove(testName);

        log.info("Promoted rule set {} to production", testName);
    }
}
```

---

## Context Pre-fetching Pipeline

The rule engine evaluation must complete in <100ms. Pre-fetching all required context in parallel is critical.

```java
@Service
public class FraudContextEnricher {

    private final CustomerProfileRepository profileRepo;
    private final AccountSummaryRepository accountRepo;
    private final VelocityCounterService velocityService;
    private final DeviceHistoryRepository deviceRepo;
    private final MerchantHistoryRepository merchantRepo;

    public FraudEvaluationContext enrich(Transaction transaction) {
        // Parallel context fetch — all I/O runs concurrently
        CompletableFuture<CustomerProfile> profileFuture =
            CompletableFuture.supplyAsync(() -> profileRepo.findById(transaction.customerId()));

        CompletableFuture<AccountSummary> accountFuture =
            CompletableFuture.supplyAsync(() -> accountRepo.getSummary(transaction.accountId()));

        CompletableFuture<VelocityCounters> velocityFuture =
            CompletableFuture.supplyAsync(() ->
                velocityService.getCounters(transaction.accountId(),
                    transaction.deviceId(), transaction.merchantId()));

        CompletableFuture<DeviceHistory> deviceFuture =
            CompletableFuture.supplyAsync(() -> deviceRepo.getHistory(transaction.deviceId()));

        CompletableFuture<MerchantHistory> merchantFuture =
            CompletableFuture.supplyAsync(() -> merchantRepo.getHistory(
                transaction.accountId(), transaction.merchantId()));

        try {
            // Wait for all futures with a combined timeout
            CompletableFuture.allOf(profileFuture, accountFuture, velocityFuture,
                deviceFuture, merchantFuture)
                .get(50, TimeUnit.MILLISECONDS); // 50ms budget for all context fetching

            return FraudEvaluationContext.builder()
                .transactionId(transaction.id())
                .accountId(transaction.accountId())
                .merchantId(transaction.merchantId())
                .amount(transaction.amount())
                .currency(transaction.currency())
                .transactionTime(transaction.requestedAt())
                .channel(transaction.channel())
                .deviceId(transaction.deviceId())
                .deviceCountry(transaction.deviceCountry())
                .customerProfile(profileFuture.join())
                .accountSummary(accountFuture.join())
                .velocityCounters(velocityFuture.join())
                .deviceHistory(deviceFuture.join())
                .merchantHistory(merchantFuture.join())
                .build();

        } catch (TimeoutException ex) {
            log.warn("Context enrichment timeout tx={} — using partial context", transaction.id());
            // Build with available data; partial context is better than no evaluation
            return buildWithAvailableContext(transaction, profileFuture, accountFuture,
                velocityFuture, deviceFuture, merchantFuture);
        }
    }
}
```

---

## Testing Rule Engine

```java
@SpringBootTest
class FraudRuleEngineTest {

    @Autowired
    private FraudRuleEngineService ruleEngine;

    @Test
    void shouldDeclineKnownFraudDevice() {
        FraudEvaluationContext ctx = contextBuilder()
            .deviceHistory(DeviceHistory.knownFraudDevice())
            .build();

        FraudDecision decision = ruleEngine.evaluate(ctx);

        assertThat(decision.action()).isEqualTo(FraudAction.DECLINE);
        assertThat(decision.triggeredRuleNames()).contains("Known Fraud Device");
    }

    @Test
    void shouldStepUpForHighScoreTransaction() {
        FraudEvaluationContext ctx = contextBuilder()
            .amount(new BigDecimal("1500.00"))
            .deviceHistory(DeviceHistory.newDevice())
            .velocityCounters(VelocityCounters.withHighAccountVelocity(15))
            .build();

        FraudDecision decision = ruleEngine.evaluate(ctx);

        assertThat(decision.fraudScore()).isGreaterThanOrEqualTo(400);
        assertThat(decision.action()).isIn(FraudAction.STEP_UP, FraudAction.DECLINE);
        assertThat(decision.triggeredRuleNames())
            .containsAnyOf("High Value New Device", "Account Velocity Breach 1h");
    }

    @Test
    void shouldApproveNormalTransaction() {
        FraudEvaluationContext ctx = contextBuilder()
            .amount(new BigDecimal("25.00"))
            .deviceHistory(DeviceHistory.knownDevice())
            .velocityCounters(VelocityCounters.normal())
            .merchantHistory(MerchantHistory.knownMerchant())
            .build();

        FraudDecision decision = ruleEngine.evaluate(ctx);

        assertThat(decision.action()).isEqualTo(FraudAction.APPROVE);
        assertThat(decision.fraudScore()).isLessThan(400);
    }

    @Test
    void evaluationCompletesWithinLatencySla() {
        FraudEvaluationContext ctx = contextBuilder().build();
        long start = System.currentTimeMillis();

        ruleEngine.evaluate(ctx);

        long latency = System.currentTimeMillis() - start;
        assertThat(latency).isLessThan(10); // rule evaluation itself: <10ms
    }
}
```

---

## Production Considerations

**Drools KIE session lifecycle**: Always dispose KIE sessions after evaluation with `session.dispose()`. Failing to do so causes memory leaks — each session holds the working memory of all inserted facts. Use try-finally to guarantee disposal.

**Rule engine warm-up**: The first few evaluations after startup are slow due to JIT compilation. Warm up the rule engine during application startup with synthetic transactions.

**Rule compilation validation**: DRL syntax errors are caught at build time, not runtime. Integrate rule compilation into your CI pipeline. A broken rule file that passes tests but fails in production is a severe fraud risk.

**Velocity counter accuracy**: Redis ZADD + ZREMRANGEBYSCORE sliding windows are eventually consistent during network partitions. During a Redis failover, velocity counters may temporarily miss counts. This is an acceptable trade-off — brief under-counting is better than blocking all transactions due to Redis unavailability.

**Rule performance profiling**: Enable Drools agenda event listener to measure per-rule execution time. A rule that runs in 50ms alone is acceptable; the same rule evaluated 1,000 times/second is not.

**Key metrics to monitor**:
- `fraud.decision{action=DECLINE}` rate — sudden spike may indicate list corruption or rule bug
- `fraud.decision{action=STEP_UP}` rate — high rate impacts customer experience
- `fraud.rule.evaluation.duration` histogram — p99 must be <10ms (excluding context fetch)
- `fraud.velocity.redis.errors` — Redis issues degrading counter accuracy
- `fraud.rule.engine.session.count` gauge — monitor for session leaks

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why do fraud rule engines use rule-based approaches rather than relying solely on ML models?",
      "options": ["ML models are too slow for real-time decisions", "Rule engines provide explainability, auditability, and human-readable decision traces that ML models cannot", "Rule engines are cheaper to operate than ML inference", "ML models cannot handle structured transaction data"],
      "correct": 1,
      "explanation": "Rule engines provide explainability — every decision can be traced to specific rules — which is essential when fraud analysts need to explain why a transaction was declined and when compliance teams must audit decisions."
    },
    {
      "text": "What is the total time budget for a fraud rule engine to approve or decline a card transaction?",
      "options": ["500ms", "250ms", "100ms", "1000ms"],
      "correct": 2,
      "explanation": "Card payment networks impose a hard SLA of 100ms total from the point a transaction enters the system. The rule engine must evaluate dozens of rules, check velocity counters, and return a decision within this window."
    },
    {
      "text": "What is the purpose of the context pre-fetching pipeline in the rule engine architecture?",
      "options": ["It caches rules to avoid reloading from the database", "It pre-fetches all required evaluation data in parallel to stay within the 100ms latency budget", "It deduplicates transactions before rule evaluation", "It compresses the rule set to reduce memory usage"],
      "correct": 1,
      "explanation": "The FraudContextEnricher fetches customer profile, account summary, velocity counters, device history, and merchant history in parallel using CompletableFuture with a 50ms combined timeout. Partial context is used when the timeout is exceeded to ensure evaluation always completes."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Fraud Rule Engine with A/B Testing",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a FraudEvaluationContext record with at least 8 fields including transaction details, device fingerprint, and velocity counters. Write a Drools DRL rule file with three rules: a known-fraud-device block rule, a high-velocity decline rule, and a cross-border high-value step-up rule."},
    {"id": "2", "description": "Implement the FraudContextEnricher service that fetches customer profile, account summary, and velocity counters in parallel using CompletableFuture.allOf() with a 50ms combined timeout. Return partial context gracefully on timeout rather than failing the evaluation."},
    {"id": "3", "description": "Implement the FraudRuleVersionManager with deployTestRuleSet(), evaluate(), and promoteToProduction() methods. The evaluate() method should consult an ABTestRegistry to route a configurable percentage of traffic to test rule sets."},
    {"id": "4", "description": "Write three JUnit tests: one that verifies a known-fraud-device is declined, one that verifies a normal low-value transaction is approved, and one that verifies A/B routing sends traffic to the test rule set at the configured percentage (use 1,000 iterations to verify within a 5% margin)."}
  ]
}
-->
