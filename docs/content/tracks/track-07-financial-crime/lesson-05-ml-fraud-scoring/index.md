---
id: track-07-lesson-05
title: "ML-Based Fraud Scoring — Feature Engineering for Payments"
slug: ml-fraud-scoring
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 5
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [ML, fraud-scoring, feature-engineering, model-serving, latency]
prerequisites: [track-07-lesson-04]
---

# ML-Based Fraud Scoring — Feature Engineering for Payments

> [!NOTE]
> Real-time fraud scoring lives or dies on feature engineering. A mediocre model with excellent, low-latency features outperforms a sophisticated model fed stale or incomplete signals. The goal is to deliver a fraud probability score within 50 ms — before the payment network times out the authorisation request.

## Why Rules Alone Are Not Enough

Traditional rule-based fraud engines encode expert knowledge: "decline if card-not-present and transaction amount > $5,000 and new payee." Rules are fast, auditable, and easy to explain to regulators. They are also brittle. Fraudsters probe them, find gaps, and exploit the gaps at scale within hours of deployment.

Machine learning models learn non-linear decision boundaries from millions of labelled examples. They detect subtle correlations — a combination of merchant category, time-of-day, device fingerprint, and velocity that no analyst would have written as a rule. The two approaches are complementary: rules enforce regulatory mandates (e.g., always screen against OFAC) while models handle the probabilistic grey zone.

This lesson covers the full ML fraud scoring pipeline: feature engineering, model training, model serving for sub-50 ms inference, A/B testing, drift detection, and graceful fallback.

---

## 1. Feature Engineering for Payment Fraud

Features fall into five families:

| Family | Examples | Freshness Required |
|---|---|---|
| Transaction velocity | Count of transactions in last 1h / 24h / 7d | Real-time |
| Merchant risk | MCC risk tier, first-time merchant, country risk | Near-real-time |
| Device and channel | Device fingerprint match, IP geolocation delta | Real-time |
| Behavioural | Avg transaction amount, typical spend hours | Daily batch |
| Account state | Age of account, prior disputes, credit utilisation | Near-real-time |

### 1.1 Transaction Velocity Features

Velocity features are the single most predictive family for card fraud. A card used 20 times in 60 minutes is almost certainly compromised, even if each individual transaction looks innocuous. Redis sorted sets are the right data structure: the transaction timestamp is the score, allowing range queries by time window.

```java
@Component
public class VelocityFeatureExtractor {

    private final RedisTemplate<String, String> redisTemplate;

    // Sliding window counters stored in Redis sorted sets
    // Key pattern: velocity:{cardId}:{windowSeconds}
    // Members: transactionId, Score: epochMillis

    public VelocityFeatures extract(String cardId, Instant now) {
        long nowMs = now.toEpochMilli();

        long count1h  = countInWindow(cardId, nowMs, Duration.ofHours(1));
        long count24h = countInWindow(cardId, nowMs, Duration.ofHours(24));
        long count7d  = countInWindow(cardId, nowMs, Duration.ofDays(7));

        BigDecimal amount1h  = sumAmountInWindow(cardId, nowMs, Duration.ofHours(1));
        BigDecimal amount24h = sumAmountInWindow(cardId, nowMs, Duration.ofHours(24));

        return VelocityFeatures.builder()
                .txnCount1h(count1h)
                .txnCount24h(count24h)
                .txnCount7d(count7d)
                .totalAmount1h(amount1h)
                .totalAmount24h(amount24h)
                .build();
    }

    private long countInWindow(String cardId, long nowMs, Duration window) {
        long windowStart = nowMs - window.toMillis();
        String key = "velocity:" + cardId + ":" + window.toSeconds();
        Long count = redisTemplate.opsForZSet()
                .count(key, windowStart, nowMs);
        return count != null ? count : 0L;
    }

    private BigDecimal sumAmountInWindow(String cardId, long nowMs, Duration window) {
        long windowStart = nowMs - window.toMillis();
        String amountKey = "vel_amt:" + cardId + ":" + window.toSeconds();
        Set<ZSetOperations.TypedTuple<String>> tuples = redisTemplate.opsForZSet()
                .rangeByScoreWithScores(amountKey, windowStart, nowMs);
        if (tuples == null) return BigDecimal.ZERO;
        return tuples.stream()
                .map(t -> new BigDecimal(t.getValue()))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    // Called after a transaction is authorised to update velocity counters
    public void recordTransaction(String cardId, String txnId,
                                   BigDecimal amount, Instant timestamp) {
        long scoreMs = timestamp.toEpochMilli();
        Duration[] windows = {
            Duration.ofHours(1), Duration.ofHours(24), Duration.ofDays(7)
        };
        for (Duration w : windows) {
            String countKey  = "velocity:" + cardId + ":" + w.toSeconds();
            String amountKey = "vel_amt:"  + cardId + ":" + w.toSeconds();
            redisTemplate.opsForZSet().add(countKey,  txnId, scoreMs);
            redisTemplate.opsForZSet().add(amountKey, amount.toPlainString(), scoreMs);
            // Trim expired entries — ZREMRANGEBYSCORE with score < windowStart
            long cutoff = scoreMs - w.toMillis();
            redisTemplate.opsForZSet().removeRangeByScore(countKey,  0, cutoff);
            redisTemplate.opsForZSet().removeRangeByScore(amountKey, 0, cutoff);
        }
    }
}
```

### 1.2 Device and Geolocation Features

A transaction from a device that has never been seen before, with an IP geolocation 3,000 km from the cardholder's registered address, is a strong fraud signal. Device fingerprinting combines browser/app attributes into a stable identifier that persists across sessions.

```java
@Component
public class DeviceFeatureExtractor {

    private final DeviceFingerprintRepository deviceRepo;
    private final GeoIpService geoIpService;

    private static final Set<String> HIGH_RISK_COUNTRIES = Set.of(
            "AF", "BY", "CF", "CD", "CU", "IR", "IQ", "LY",
            "ML", "MM", "NI", "KP", "RU", "SO", "SS", "SY", "YE", "ZW"
    );

    public DeviceFeatures extract(PaymentRequest request, String cardId) {
        String deviceFingerprint = request.getDeviceFingerprint();
        boolean isKnownDevice = deviceRepo.existsByCardIdAndFingerprint(
                cardId, deviceFingerprint);

        int deviceAgeInDays = isKnownDevice
                ? deviceRepo.findFirstSeenDays(cardId, deviceFingerprint)
                : 0;

        GeoLocation ipLocation  = geoIpService.locate(request.getIpAddress());
        GeoLocation cardAddress = geoIpService.locatePostalCode(
                request.getBillingPostalCode(), request.getBillingCountry());

        double distanceKm = haversineDistance(ipLocation, cardAddress);
        boolean isHighRiskCountry = HIGH_RISK_COUNTRIES
                .contains(ipLocation.getCountryCode());

        return DeviceFeatures.builder()
                .isKnownDevice(isKnownDevice)
                .deviceAgeInDays(deviceAgeInDays)
                .ipToAddressDistanceKm(distanceKm)
                .isHighRiskCountryIp(isHighRiskCountry)
                .ipCountryMatchesBilling(
                    ipLocation.getCountryCode()
                              .equals(request.getBillingCountry()))
                .build();
    }

    private double haversineDistance(GeoLocation a, GeoLocation b) {
        final double R = 6371.0;
        double dLat = Math.toRadians(b.getLatitude()  - a.getLatitude());
        double dLon = Math.toRadians(b.getLongitude() - a.getLongitude());
        double sinDLat = Math.sin(dLat / 2);
        double sinDLon = Math.sin(dLon / 2);
        double x = sinDLat * sinDLat
                + Math.cos(Math.toRadians(a.getLatitude()))
                * Math.cos(Math.toRadians(b.getLatitude()))
                * sinDLon * sinDLon;
        return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }
}
```

### 1.3 Merchant Category Features

```java
@Component
public class MerchantFeatureExtractor {

    private final MerchantRiskRepository merchantRiskRepo;

    // MCC risk tiers based on fraud rates and regulatory guidance
    // Tier 1 = lowest risk, Tier 5 = highest risk
    private static final Map<String, Integer> MCC_RISK_TIER = Map.of(
        "7995", 5,  // Gambling
        "5912", 4,  // Drug stores / pharmacies
        "6051", 5,  // Non-financial institutions (crypto exchanges)
        "7011", 2,  // Hotels
        "5411", 1,  // Grocery stores
        "5812", 2,  // Restaurants
        "4111", 1,  // Local commuter transport
        "5945", 3,  // Hobby, toy and game shops
        "5999", 3   // Misc retail
    );

    public MerchantFeatures extract(String merchantId, String mcc,
                                     String cardId, String merchantCountry) {
        int mccRiskTier = MCC_RISK_TIER.getOrDefault(mcc, 2);

        boolean isFirstTransactionAtMerchant =
                !merchantRiskRepo.existsTransactionAtMerchant(cardId, merchantId);

        MerchantStats stats = merchantRiskRepo.getMerchantStats(merchantId);
        double merchantFraudRate  = stats != null ? stats.getChargebackRate() : 0.02;
        boolean isMerchantAbroad  = !merchantCountry.equals("US");

        return MerchantFeatures.builder()
                .mccRiskTier(mccRiskTier)
                .isFirstTransactionAtMerchant(isFirstTransactionAtMerchant)
                .merchantChargebackRate(merchantFraudRate)
                .isMerchantAbroad(isMerchantAbroad)
                .merchantCountry(merchantCountry)
                .build();
    }
}
```

### 1.4 Behavioural Pattern Features

Behavioural features capture the cardholder's normal patterns. A $4,000 transaction from a cardholder whose 90-day average is $45 is anomalous regardless of other signals. These features are computed nightly from transaction history and stored in a profile store.

```java
@Component
public class BehaviouralFeatureExtractor {

    private final SpendProfileRepository spendProfileRepo;

    public BehaviouralFeatures extract(String cardId,
                                        BigDecimal transactionAmount,
                                        int transactionHour) {
        SpendProfile profile = spendProfileRepo.findByCardId(cardId)
                .orElse(SpendProfile.defaultProfile());

        double amountZScore = calculateZScore(
                transactionAmount.doubleValue(),
                profile.getMeanTransactionAmount(),
                profile.getStdDevTransactionAmount());

        double amountToAvgRatio = profile.getMeanTransactionAmount() > 0
                ? transactionAmount.doubleValue() / profile.getMeanTransactionAmount()
                : 1.0;

        boolean isUnusualHour = !profile.getTypicalHours()
                .contains(transactionHour);

        return BehaviouralFeatures.builder()
                .amountZScore(amountZScore)
                .amountToAvgRatio(amountToAvgRatio)
                .isUnusualHour(isUnusualHour)
                .daysSinceLastTransaction(profile.getDaysSinceLastTransaction())
                .uniqueMerchantsLast30d(profile.getUniqueMerchantsLast30d())
                .build();
    }

    private double calculateZScore(double value, double mean, double stdDev) {
        if (stdDev == 0) return 0;
        return (value - mean) / stdDev;
    }
}
```

---

## 2. Feature Store Design

A feature store decouples feature computation from model serving. Features computed offline (batch) are stored and served alongside real-time features computed online. The key design principle is that feature definitions must be consistent between training and serving — the "training-serving skew" problem is the most common source of model degradation in production.

```java
@Service
public class FeatureStoreService {

    private final VelocityFeatureExtractor velocityExtractor;
    private final DeviceFeatureExtractor deviceExtractor;
    private final MerchantFeatureExtractor merchantExtractor;
    private final BehaviouralFeatureExtractor behaviouralExtractor;
    private static final Logger log = LoggerFactory.getLogger(FeatureStoreService.class);

    // Assembled feature vector for model scoring
    // Parallel extraction with 30ms hard deadline
    public FraudFeatureVector assemble(PaymentRequest request) {
        String cardId = request.getCardId();
        Instant now   = Instant.now();

        CompletableFuture<VelocityFeatures> velocityFuture =
                CompletableFuture.supplyAsync(() ->
                        velocityExtractor.extract(cardId, now));

        CompletableFuture<DeviceFeatures> deviceFuture =
                CompletableFuture.supplyAsync(() ->
                        deviceExtractor.extract(request, cardId));

        CompletableFuture<MerchantFeatures> merchantFuture =
                CompletableFuture.supplyAsync(() ->
                        merchantExtractor.extract(
                                request.getMerchantId(), request.getMcc(),
                                cardId, request.getMerchantCountry()));

        CompletableFuture<BehaviouralFeatures> behaviouralFuture =
                CompletableFuture.supplyAsync(() ->
                        behaviouralExtractor.extract(
                                cardId, request.getAmount(),
                                now.atZone(ZoneOffset.UTC).getHour()));

        try {
            CompletableFuture.allOf(
                    velocityFuture, deviceFuture,
                    merchantFuture, behaviouralFuture)
                .get(30, TimeUnit.MILLISECONDS);

            return FraudFeatureVector.builder()
                    .velocity(velocityFuture.get())
                    .device(deviceFuture.get())
                    .merchant(merchantFuture.get())
                    .behavioural(behaviouralFuture.get())
                    .transactionAmount(request.getAmount().doubleValue())
                    .currency(request.getCurrency())
                    .isCardPresent(request.isCardPresent())
                    .build();

        } catch (TimeoutException e) {
            log.warn("Feature assembly timed out after 30ms, using partial vector");
            return buildPartialVector(request,
                    velocityFuture, deviceFuture, merchantFuture, behaviouralFuture);
        } catch (ExecutionException | InterruptedException e) {
            throw new FeatureExtractionException("Feature assembly failed", e);
        }
    }

    private FraudFeatureVector buildPartialVector(
            PaymentRequest request,
            CompletableFuture<VelocityFeatures> v,
            CompletableFuture<DeviceFeatures> d,
            CompletableFuture<MerchantFeatures> m,
            CompletableFuture<BehaviouralFeatures> b) {
        return FraudFeatureVector.builder()
                .velocity(v.isDone() ? v.getNow(VelocityFeatures.empty()) : VelocityFeatures.empty())
                .device(d.isDone() ? d.getNow(DeviceFeatures.empty()) : DeviceFeatures.empty())
                .merchant(m.isDone() ? m.getNow(MerchantFeatures.empty()) : MerchantFeatures.empty())
                .behavioural(b.isDone() ? b.getNow(BehaviouralFeatures.empty()) : BehaviouralFeatures.empty())
                .transactionAmount(request.getAmount().doubleValue())
                .currency(request.getCurrency())
                .isCardPresent(request.isCardPresent())
                .isPartial(true)
                .build();
    }
}
```

---

## 3. ONNX Model Serving for Low-Latency Inference

ONNX Runtime provides consistent, fast inference across models trained in different frameworks (XGBoost, LightGBM, TensorFlow). Running the runtime in-process eliminates the gRPC overhead of a sidecar like TensorFlow Serving, saving 5-10 ms per request.

```java
@Service
public class OnnxFraudScoringService {

    private static final Logger log = LoggerFactory.getLogger(OnnxFraudScoringService.class);

    private final OrtEnvironment onnxEnv;
    private volatile OrtSession  activeSession;
    private volatile String activeModelVersion;

    private final MeterRegistry meterRegistry;

    @Value("${fraud.model.path}")
    private String modelPath;

    @PostConstruct
    public void loadModel() throws OrtException {
        this.onnxEnv = OrtEnvironment.getEnvironment();
        reloadModel(modelPath);
    }

    public FraudScore score(FraudFeatureVector features) {
        long startNs = System.nanoTime();
        try {
            OnnxTensor inputTensor = buildInputTensor(features);
            OrtSession.Result result = activeSession.run(
                    Map.of("float_input", inputTensor));

            float[][] probabilities = (float[][]) result.get(0).getValue();
            float fraudProbability  = probabilities[0][1];  // class 1 = fraud

            long latencyMs = (System.nanoTime() - startNs) / 1_000_000;
            recordLatencyMetric(latencyMs);

            return FraudScore.builder()
                    .score(fraudProbability)
                    .modelVersion(activeModelVersion)
                    .latencyMs(latencyMs)
                    .isPartialFeatures(features.isPartial())
                    .build();

        } catch (OrtException e) {
            throw new ModelInferenceException("ONNX inference failed", e);
        }
    }

    private OnnxTensor buildInputTensor(FraudFeatureVector f) throws OrtException {
        // Feature ordering MUST match training-time column order exactly
        float[] featureArray = new float[]{
            (float) f.getVelocity().getTxnCount1h(),
            (float) f.getVelocity().getTxnCount24h(),
            (float) f.getVelocity().getTxnCount7d(),
            (float) f.getVelocity().getTotalAmount1h().doubleValue(),
            (float) f.getVelocity().getTotalAmount24h().doubleValue(),
            (float) f.getDevice().getIpToAddressDistanceKm(),
            f.getDevice().isKnownDevice() ? 1.0f : 0.0f,
            (float) f.getDevice().getDeviceAgeInDays(),
            f.getDevice().isHighRiskCountryIp() ? 1.0f : 0.0f,
            (float) f.getMerchant().getMccRiskTier(),
            (float) f.getMerchant().getMerchantChargebackRate(),
            f.getMerchant().isMerchantAbroad() ? 1.0f : 0.0f,
            f.getMerchant().isFirstTransactionAtMerchant() ? 1.0f : 0.0f,
            (float) f.getBehavioural().getAmountZScore(),
            (float) f.getBehavioural().getAmountToAvgRatio(),
            f.getBehavioural().isUnusualHour() ? 1.0f : 0.0f,
            (float) f.getBehavioural().getDaysSinceLastTransaction(),
            (float) f.getTransactionAmount(),
            f.isCardPresent() ? 1.0f : 0.0f
        };
        long[] shape = {1, featureArray.length};
        return OnnxTensor.createTensor(onnxEnv,
                FloatBuffer.wrap(featureArray), shape);
    }

    // Hot reload without restart — called by model deployment service
    public synchronized void reloadModel(String newModelPath) throws OrtException {
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setIntraOpNumThreads(2);  // cap CPU per request
        opts.addCPUEP(false);
        OrtSession newSession = onnxEnv.createSession(newModelPath, opts);
        OrtSession old = this.activeSession;
        this.activeSession = newSession;
        if (old != null) old.close();
        this.activeModelVersion = extractVersionFromPath(newModelPath);
        log.info("Loaded fraud model version: {}", activeModelVersion);
    }

    private void recordLatencyMetric(long latencyMs) {
        meterRegistry.timer("fraud.model.inference.duration")
               .record(latencyMs, TimeUnit.MILLISECONDS);
        if (latencyMs > 50) {
            log.warn("Model inference exceeded 50ms budget: {}ms", latencyMs);
        }
    }

    private String extractVersionFromPath(String path) {
        // Extract version from path like /models/fraud/v42/model.onnx
        String[] parts = path.split("/");
        for (String part : parts) {
            if (part.startsWith("v") && part.length() > 1) return part;
        }
        return "unknown";
    }
}
```

### 3.1 Full Fraud Scoring API

```java
@RestController
@RequestMapping("/v1/fraud")
public class FraudScoringController {

    private final FeatureStoreService featureStore;
    private final OnnxFraudScoringService scoringService;
    private final FraudRuleEngine ruleEngine;
    private final FraudDecisionAuditRepository auditRepo;
    private static final Logger log = LoggerFactory.getLogger(FraudScoringController.class);

    @PostMapping("/score")
    public ResponseEntity<FraudScoringResponse> score(
            @RequestBody @Valid PaymentRequest request) {

        long start = System.currentTimeMillis();

        // Step 1: Run hard-coded rules first (sanctions, duplicate detection)
        RuleDecision ruleDecision = ruleEngine.evaluate(request);
        if (ruleDecision.isHardDecline()) {
            auditRepo.save(buildAudit(request, 1.0f, "RULE_HARD_DECLINE",
                    "RULES", System.currentTimeMillis() - start));
            return buildDeclineResponse(ruleDecision,
                    System.currentTimeMillis() - start);
        }

        // Step 2: Assemble features
        FraudFeatureVector features;
        try {
            features = featureStore.assemble(request);
        } catch (FeatureExtractionException e) {
            log.error("Feature extraction failed, falling back to rules", e);
            return buildRulesOnlyResponse(ruleDecision,
                    System.currentTimeMillis() - start);
        }

        // Step 3: Score with ML model
        FraudScore mlScore;
        try {
            mlScore = scoringService.score(features);
        } catch (ModelInferenceException e) {
            log.error("ML scoring failed, falling back to rules", e);
            return buildRulesOnlyResponse(ruleDecision,
                    System.currentTimeMillis() - start);
        }

        // Step 4: Combine rule and model signals
        FraudDecision decision = combineSignals(ruleDecision, mlScore);

        // Step 5: Persist audit record
        auditRepo.save(buildAudit(request, mlScore.getScore(),
                decision.getOutcome().name(),
                mlScore.getModelVersion(),
                System.currentTimeMillis() - start));

        return ResponseEntity.ok(FraudScoringResponse.builder()
                .transactionId(request.getTransactionId())
                .fraudScore(mlScore.getScore())
                .decision(decision.getOutcome())
                .decisionReason(decision.getReason())
                .latencyMs(System.currentTimeMillis() - start)
                .build());
    }

    private FraudDecision combineSignals(RuleDecision rule, FraudScore ml) {
        if (rule.isHardDecline())    return FraudDecision.decline("RULE_HARD_DECLINE");
        if (ml.getScore() >= 0.90)  return FraudDecision.decline("ML_HIGH_CONFIDENCE");
        if (ml.getScore() >= 0.60)  return FraudDecision.review("ML_MEDIUM_CONFIDENCE");
        if (rule.getRiskPoints() >= 80) return FraudDecision.review("RULE_HIGH_RISK");
        return FraudDecision.approve("PASS");
    }

    private FraudDecisionAudit buildAudit(PaymentRequest req, float score,
                                           String decision, String modelVersion,
                                           long latencyMs) {
        return FraudDecisionAudit.builder()
                .transactionId(req.getTransactionId())
                .fraudScore(score)
                .decision(decision)
                .modelVersion(modelVersion)
                .latencyMs(latencyMs)
                .createdAt(Instant.now())
                .build();
    }
}
```

---

## 4. A/B Testing Fraud Models

Before promoting a new model to 100% traffic, run it in shadow mode (score only, no decision impact) and then gradually ramp traffic. The champion-challenger pattern is standard: the champion is the production model; the challenger is the candidate replacement.

```java
@Component
public class ModelABTestRouter {

    private final OnnxFraudScoringService championModel;
    private final OnnxFraudScoringService challengerModel;
    private final ABTestConfigRepository configRepo;
    private final ABTestResultRepository resultRepo;
    private static final Logger log = LoggerFactory.getLogger(ModelABTestRouter.class);

    public FraudScore route(FraudFeatureVector features, String transactionId) {
        ABTestConfig config = configRepo.getActiveConfig();

        if (!config.isActive()) {
            return championModel.score(features);
        }

        // Deterministic bucket assignment from transaction ID hash
        int bucket = Math.abs(transactionId.hashCode()) % 100;
        boolean useChallenger = bucket < config.getChallengerTrafficPercent();

        FraudScore championScore = championModel.score(features);

        if (useChallenger) {
            FraudScore challengerScore;
            try {
                challengerScore = challengerModel.score(features);
            } catch (Exception e) {
                log.error("Challenger model failed, reverting to champion", e);
                return championScore;
            }
            resultRepo.record(transactionId, championScore, challengerScore, true);
            return challengerScore;
        }

        // Shadow mode: score challenger async for telemetry only
        final FraudFeatureVector f = features;
        CompletableFuture.runAsync(() -> {
            try {
                FraudScore shadow = challengerModel.score(f);
                resultRepo.recordShadow(transactionId, championScore, shadow);
            } catch (Exception ignored) {}
        });

        return championScore;
    }
}
```

---

## 5. Model Drift Detection

Fraud patterns change. A model trained six months ago may miss new patterns introduced by an organised fraud ring. Drift detection uses two signals: distribution shift in model scores (early warning) and degradation in precision measured against chargeback labels (lagging but ground-truth).

```java
@Component
public class ModelDriftDetector {

    private final FraudDecisionAuditRepository auditRepo;
    private final AlertService alertService;
    private static final Logger log = LoggerFactory.getLogger(ModelDriftDetector.class);

    @Scheduled(fixedRate = 3_600_000)  // every hour
    public void detectDrift() {
        // Population Stability Index on score distribution
        double psi = calculatePSI();
        log.info("Model PSI: {}", psi);

        if (psi > 0.25) {
            alertService.critical("MODEL_DRIFT_CRITICAL",
                    "Score PSI exceeded threshold 0.25 (actual: " + psi +
                    "). Model retraining required immediately.");
        } else if (psi > 0.10) {
            alertService.warning("MODEL_DRIFT_WARNING",
                    "Score PSI elevated at " + psi + ". Monitor closely.");
        }

        // Precision degradation via chargeback lookback
        DriftMetrics metrics = calculatePrecisionDegradation();
        if (metrics.getFalseNegativeRate() > 0.15) {
            alertService.warning("MODEL_PRECISION_DEGRADED",
                    "False negative rate: " + metrics.getFalseNegativeRate() +
                    " (threshold: 0.15). Missed fraud increasing.");
        }

        // Per-feature Kolmogorov-Smirnov test
        Map<String, Double> ksStats = calculateFeatureKSStats();
        ksStats.entrySet().stream()
               .filter(e -> e.getValue() > 0.10)
               .forEach(e -> alertService.warning("FEATURE_DRIFT",
                       "Feature " + e.getKey() +
                       " KS stat = " + String.format("%.3f", e.getValue())));
    }

    private double calculatePSI() {
        List<Double> currentScores  = auditRepo.getScoresLastWeek();
        List<Double> baselineScores = auditRepo.getBaselineScores();
        double[] currentBins  = bin(currentScores,  10);
        double[] baselineBins = bin(baselineScores, 10);
        double psi = 0.0;
        for (int i = 0; i < 10; i++) {
            double cur  = Math.max(currentBins[i],  0.0001);
            double base = Math.max(baselineBins[i], 0.0001);
            psi += (cur - base) * Math.log(cur / base);
        }
        return psi;
    }

    private double[] bin(List<Double> scores, int buckets) {
        double[] bins = new double[buckets];
        for (double s : scores) {
            int idx = Math.min((int)(s * buckets), buckets - 1);
            bins[idx]++;
        }
        double total = scores.isEmpty() ? 1.0 : scores.size();
        for (int i = 0; i < buckets; i++) bins[i] /= total;
        return bins;
    }

    private DriftMetrics calculatePrecisionDegradation() {
        // Compare confirmed fraud outcomes to model predictions from 30 days ago
        return auditRepo.calculateDriftMetrics(
                Instant.now().minus(60, ChronoUnit.DAYS),
                Instant.now().minus(30, ChronoUnit.DAYS));
    }

    private Map<String, Double> calculateFeatureKSStats() {
        return auditRepo.calculateFeatureKSStats(
                Instant.now().minus(7, ChronoUnit.DAYS));
    }
}
```

---

## 6. Fallback to Rules When Model Unavailable

The fraud scoring service must always return a decision within the payment network timeout. When the ML model is unavailable, fall back to a rules-only conservative strategy that uses lower thresholds and routes more transactions to manual review.

```java
@Service
public class FraudDecisionService {

    private final FeatureStoreService featureStore;
    private final OnnxFraudScoringService mlScoringService;
    private final FraudRuleEngine ruleEngine;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(FraudDecisionService.class);

    // Resilience4j CircuitBreaker: open after 50% failure rate over 20 calls
    // Stays open for 30s, then half-open for 5 probe calls
    @CircuitBreaker(name = "fraud-ml-model", fallbackMethod = "ruleOnlyFallback")
    public FraudDecision decide(PaymentRequest request) {
        RuleDecision ruleDecision = ruleEngine.evaluate(request);
        if (ruleDecision.isHardDecline()) {
            return FraudDecision.decline(ruleDecision.getReason());
        }
        FraudFeatureVector features = featureStore.assemble(request);
        FraudScore score = mlScoringService.score(features);
        return combineSignals(ruleDecision, score);
    }

    // Activated when circuit breaker is open
    private FraudDecision ruleOnlyFallback(PaymentRequest request,
                                            Exception cause) {
        meterRegistry.counter("fraud.ml.fallback.activated").increment();
        log.error("ML model unavailable ({}), using conservative rules fallback",
                cause.getClass().getSimpleName());

        // Conservative: apply stricter rule thresholds and send to review
        RuleDecision ruleDecision = ruleEngine.evaluateConservative(request);
        return FraudDecision.builder()
                .outcome(ruleDecision.isHardDecline()
                        ? DecisionOutcome.DECLINE
                        : DecisionOutcome.REVIEW)
                .reason("RULES_ONLY_FALLBACK")
                .modelVersion("RULES_FALLBACK")
                .build();
    }

    private FraudDecision combineSignals(RuleDecision rule, FraudScore ml) {
        if (rule.isHardDecline())    return FraudDecision.decline("RULE_HARD_DECLINE");
        if (ml.getScore() >= 0.90)  return FraudDecision.decline("ML_HIGH_CONFIDENCE");
        if (ml.getScore() >= 0.60)  return FraudDecision.review("ML_MEDIUM_CONFIDENCE");
        if (rule.getRiskPoints() >= 80) return FraudDecision.review("RULE_HIGH_RISK");
        return FraudDecision.approve("PASS");
    }
}
```

---

## 7. Monitoring Model Performance in Production

```java
@Service
public class FraudModelMonitoringService {

    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(FraudModelMonitoringService.class);

    // Called when a chargeback dispute is confirmed (ground truth arrives ~30 days later)
    public void recordOutcome(String transactionId, float modelScore,
                               boolean confirmedFraud) {
        boolean modelPredictedFraud = modelScore >= 0.60;

        String outcome;
        if (confirmedFraud && modelPredictedFraud) {
            outcome = "true_positive";
        } else if (confirmedFraud) {
            outcome = "false_negative";
            log.warn("Missed fraud: txn={} model_score={}", transactionId, modelScore);
        } else if (modelPredictedFraud) {
            outcome = "false_positive";
        } else {
            outcome = "true_negative";
        }

        meterRegistry.counter("fraud.model.outcome",
                "result", outcome).increment();

        // Score histogram by label — useful for threshold calibration
        meterRegistry.summary("fraud.model.score.distribution",
                "label", confirmedFraud ? "fraud" : "legitimate")
                .record(modelScore);
    }

    // SLO target: p99 inference latency < 50ms
    public void recordInferenceLatency(long latencyMs) {
        meterRegistry.timer("fraud.model.inference.duration")
                .record(latencyMs, TimeUnit.MILLISECONDS);
    }
}
```

---

## 8. Key Design Decisions and Trade-offs

| Decision | Option A | Option B | Recommendation |
|---|---|---|---|
| Feature freshness | Real-time (Redis) | Batch (pre-computed) | Hybrid: real-time velocity, batch behaviour |
| Model serving | ONNX Runtime in-process | TF Serving gRPC sidecar | ONNX in-process for sub-5ms inference |
| Fallback strategy | Rules-only conservative | Static deny all | Rules-only — better false positive control |
| A/B testing | Shadow mode first | Traffic split direct | Shadow 2 weeks, then 5% traffic split |
| Drift detection | PSI on score distribution | Chargeback rate only | Both — PSI is leading, chargebacks lagging |
| Feature skew prevention | Shared feature library | Separate train/serve code | Shared library — single source of truth |

---

## 9. Operational Checklist

- Model inference p99 latency < 50 ms (Micrometer histogram)
- Feature extraction p99 latency < 30 ms (Redis calls < 5 ms each)
- ML fallback rate < 0.1% (circuit breaker open events)
- Model AUC-ROC >= 0.92 measured weekly on labelled holdout
- Score PSI < 0.10 (distribution stable)
- False negative rate < 10% on confirmed chargeback lookback
- Automated retraining trigger when PSI > 0.25 or precision drops > 20%
- Model version logged on every scoring decision for audit and replay
- Feature store version pinned to model version at training time
- Partial feature vector flag tracked to identify degraded scoring periods

---

## Summary

ML-based fraud scoring requires production-grade feature engineering, low-latency model serving, and robust fallback mechanisms. The 50 ms inference budget is dominated by feature extraction (Redis calls, DB lookups), not the model itself. Parallelise feature extraction with CompletableFuture, use ONNX Runtime for in-process inference to eliminate sidecar latency, and maintain a rules-based fallback that activates transparently when the model is unavailable. Drift detection closes the feedback loop — without it, model degradation goes unnoticed until chargeback rates spike.

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "Your fraud model must return a score within 50ms. Feature extraction takes 30ms and ONNX inference takes 5ms. What is the best architectural approach to meet this latency budget?",
      "options": [
        "Execute all feature extractors sequentially and optimize the slowest one",
        "Execute feature extractors in parallel using CompletableFuture with a 30ms deadline, return a partial vector if any extractor times out",
        "Pre-compute all features in a nightly batch job and serve from cache",
        "Skip device and behavioural features to reduce extraction time"
      ],
      "correct": 1,
      "explanation": "Parallel feature extraction with CompletableFuture and a hard deadline is the correct pattern. If any individual extractor misses the deadline, the system returns a partial feature vector rather than failing the entire scoring request. This approach caps total extraction latency at 30ms regardless of how many extractors are involved."
    },
    {
      "text": "Your fraud model's Population Stability Index (PSI) has risen from 0.05 to 0.28 over the past week. What action should this trigger?",
      "options": [
        "No action — PSI fluctuations below 0.30 are acceptable noise",
        "Alert and monitor — PSI above 0.10 indicates elevated drift",
        "Immediate model retraining — PSI above 0.25 indicates significant distribution shift",
        "Switch to rules-only mode until the drift resolves naturally"
      ],
      "correct": 2,
      "explanation": "PSI above 0.25 indicates significant distribution shift in model score outputs, meaning the input feature distribution has changed substantially from training time. This warrants immediate retraining. PSI 0.10-0.25 is a monitoring zone (warning), while PSI below 0.10 indicates stable distribution."
    },
    {
      "text": "During a champion-challenger A/B test, you route 10% of traffic to the challenger model. The challenger model service crashes. What should happen?",
      "options": [
        "Return an error for the 10% of transactions routed to the challenger",
        "Automatically fall back to the champion model score for those transactions",
        "Route all traffic to champion and disable challenger permanently",
        "Queue the transactions and retry once the challenger recovers"
      ],
      "correct": 1,
      "explanation": "The A/B test router should catch challenger failures and transparently fall back to the champion score. Payment authorization cannot wait for a failed challenger to recover. The champion model provides a valid score and the challenger failure is logged as a metric. The challenger is kept enabled for investigation, not permanently disabled."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "Build a Production ML Fraud Scoring Pipeline",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": 1,
      "description": "Implement a VelocityFeatureExtractor using Redis sorted sets. The extractor must compute transaction count and total amount for 1h, 24h, and 7d sliding windows. All window queries must execute in parallel. Include a recordTransaction method that updates all windows atomically and trims expired entries."
    },
    {
      "id": 2,
      "description": "Build a FeatureStoreService that assembles a FraudFeatureVector from all feature extractors (velocity, device, merchant, behavioural) in parallel with a 30ms timeout. If any extractor misses the deadline, the service must return a partial vector with an isPartial flag set to true rather than failing the request."
    },
    {
      "id": 3,
      "description": "Implement an ONNX model hot-reload mechanism using a volatile reference to the active OrtSession. The reloadModel method must load the new session, atomically swap the reference, and close the old session. Record model inference latency as a Micrometer histogram and emit a warning log when inference exceeds 50ms."
    },
    {
      "id": 4,
      "description": "Build a ModelDriftDetector with a scheduled hourly check that computes PSI on the current vs baseline score distributions using 10 equal-width bins. Alert at WARNING for PSI > 0.10 and CRITICAL for PSI > 0.25. Add a chargeback-based precision check: alert when the false negative rate on confirmed chargebacks from 30-60 days ago exceeds 15%."
    }
  ]
} -->
