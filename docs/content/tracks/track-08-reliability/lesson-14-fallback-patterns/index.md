---
id: track-08-lesson-14
title: "Fallback Patterns — Static, Cached, and Degraded Responses"
slug: fallback-patterns
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 14
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [fallback, cache, static-response, degraded-mode, Resilience4j]
prerequisites: [track-08-lesson-02, track-08-lesson-04]
---

# Fallback Patterns — Static, Cached, and Degraded Responses

> [!NOTE]
> A circuit breaker that opens and returns an error to the caller has not solved a reliability problem — it has merely made the failure visible. Fallback patterns are what happen after the circuit opens: the system continues operating, with reduced fidelity, using the best available data. The art is knowing which degraded response is acceptable for each use case.

## Fallback Taxonomy

| Type | Use Case | Trade-off |
|---|---|---|
| Static fallback | Known-safe default value | May be wrong for some users |
| Cached fallback | Last known good value | May be stale |
| Degraded service | Reduced functionality | Customer sees different behaviour |
| Fail-open | Allow with reduced checks | Regulatory risk (compliance) |
| Fail-closed | Block / reject | Customer friction |
| Queue for retry | Async retry after recovery | Increased latency |

The choice depends on the semantics of the operation. For payment decisions, fail-closed (decline) is safer than fail-open (approve without checks). For exchange rate display, a stale cached rate is better than an error.

---

## 1. Resilience4j @CircuitBreaker with Fallback

```java
@Service
public class ExchangeRateService {

    private final ExchangeRateApiClient apiClient;
    private final ExchangeRateCacheService cacheService;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(ExchangeRateService.class);

    // Static fallback rates — used when cache is also unavailable
    // Updated quarterly by treasury team, embedded in service
    private static final Map<String, BigDecimal> STATIC_FALLBACK_RATES = Map.of(
            "USD/EUR", new BigDecimal("0.92"),
            "USD/GBP", new BigDecimal("0.79"),
            "USD/JPY", new BigDecimal("150.0"),
            "USD/CAD", new BigDecimal("1.36"),
            "USD/AUD", new BigDecimal("1.53")
    );

    @CircuitBreaker(name = "exchange-rate-api", fallbackMethod = "getFromCacheOrStatic")
    public ExchangeRate getRate(String currencyPair) {
        ExchangeRate rate = apiClient.fetchRate(currencyPair);
        // Update cache with fresh rate
        cacheService.put(currencyPair, rate, Duration.ofMinutes(5));
        return rate;
    }

    // Fallback: try cache first, then static
    private ExchangeRate getFromCacheOrStatic(String currencyPair, Exception cause) {
        log.warn("Exchange rate API unavailable for {}: {}",
                currencyPair, cause.getMessage());
        meterRegistry.counter("exchange.rate.fallback.triggered",
                "pair", currencyPair).increment();

        // Try cache (may have stale data from before circuit opened)
        Optional<ExchangeRate> cached = cacheService.get(currencyPair);
        if (cached.isPresent()) {
            ExchangeRate staleRate = cached.get();
            long staleness = Duration.between(staleRate.getFetchedAt(),
                    Instant.now()).toMinutes();
            log.info("Using cached exchange rate: pair={} staleness={}min",
                    currencyPair, staleness);
            meterRegistry.counter("exchange.rate.cache.fallback",
                    "pair", currencyPair).increment();
            return staleRate.withNote("CACHED_RATE_" + staleness + "MIN_OLD");
        }

        // Static fallback: last resort
        BigDecimal staticRate = STATIC_FALLBACK_RATES.get(currencyPair);
        if (staticRate != null) {
            log.warn("Using static fallback rate for {}: {}",
                    currencyPair, staticRate);
            meterRegistry.counter("exchange.rate.static.fallback",
                    "pair", currencyPair).increment();
            return ExchangeRate.builder()
                    .pair(currencyPair)
                    .rate(staticRate)
                    .source("STATIC_FALLBACK")
                    .fetchedAt(Instant.now())
                    .isStale(true)
                    .note("STATIC_FALLBACK_RATE")
                    .build();
        }

        // No fallback available — this is a hard failure
        throw new ExchangeRateUnavailableException(
                "Exchange rate unavailable and no fallback for: " + currencyPair);
    }
}
```

---

## 2. Fallback Chaining

Fallback chaining tries multiple fallback strategies in order, from most accurate to most conservative.

```java
@Service
public class RiskScoringService {

    private final MLRiskScoringClient mlScoringClient;
    private final RulesBasedRiskEngine rulesEngine;
    private final RiskScoreCacheService cacheService;
    private final MeterRegistry meterRegistry;

    // Fallback chain: ML Model -> Cache -> Rules -> Static
    @CircuitBreaker(name = "ml-risk-scoring", fallbackMethod = "fallbackToCache")
    public RiskScore score(Customer customer) {
        return mlScoringClient.score(customer);
    }

    // Level 1 fallback: use cached score
    @CircuitBreaker(name = "risk-score-cache", fallbackMethod = "fallbackToRules")
    private RiskScore fallbackToCache(Customer customer, Exception cause) {
        meterRegistry.counter("risk.score.fallback.ml_unavailable").increment();
        log.warn("ML scoring unavailable, trying cache for customerId={}",
                customer.getCustomerId());

        Optional<RiskScore> cached = cacheService.get(customer.getCustomerId());
        if (cached.isPresent()) {
            return cached.get().withFallbackNote("ML_UNAVAILABLE_CACHE_USED");
        }
        // Cache miss — escalate to next fallback
        throw new CacheMissException("No cached risk score for: "
                + customer.getCustomerId());
    }

    // Level 2 fallback: rules-based scoring
    @CircuitBreaker(name = "rules-engine", fallbackMethod = "fallbackToStatic")
    private RiskScore fallbackToRules(Customer customer, Exception cause) {
        meterRegistry.counter("risk.score.fallback.cache_miss").increment();
        log.warn("Cache miss for risk score, using rules for customerId={}",
                customer.getCustomerId());
        return rulesEngine.score(customer);
    }

    // Level 3 fallback: static conservative score
    private RiskScore fallbackToStatic(Customer customer, Exception cause) {
        meterRegistry.counter("risk.score.fallback.static").increment();
        log.error("All risk scoring methods unavailable for customerId={}. " +
                  "Using conservative static score.", customer.getCustomerId());

        // Conservative: assign HIGH risk when scoring is unavailable
        // This may cause more false positives but prevents unscored customers
        // from proceeding without review
        return RiskScore.builder()
                .customerId(customer.getCustomerId())
                .score(0.75)  // HIGH risk
                .tier(RiskTier.HIGH)
                .reason("ALL_SCORING_UNAVAILABLE")
                .requiresManualReview(true)
                .build();
    }
}
```

---

## 3. Payment API Fallbacks

Payment APIs have the most consequential fallback decisions. Incorrect fallbacks can cause financial loss or regulatory violation.

```java
@Service
public class PaymentFallbackService {

    private final ComplianceCheckService complianceService;
    private final FraudScoringService fraudService;
    private final ExchangeRateService exchangeRateService;
    private final MeterRegistry meterRegistry;

    // Compliance fallback: when screening API is unavailable
    // For payment systems: fail-closed (block) is the regulatory-safe choice
    @CircuitBreaker(name = "sanctions-screening",
                    fallbackMethod = "complianceFallback")
    public ComplianceResult checkCompliance(Payment payment) {
        return complianceService.check(payment);
    }

    private ComplianceResult complianceFallback(Payment payment, Exception cause) {
        meterRegistry.counter("payment.compliance.fallback").increment();
        log.error("Compliance screening unavailable: paymentId={}",
                payment.getPaymentId(), cause);

        // Check if we have a recent screening result for this beneficiary
        Optional<ComplianceResult> cached = complianceCache
                .getResult(payment.getBeneficiaryId());

        if (cached.isPresent() && cached.get().getScreenedAt()
                .isAfter(Instant.now().minus(1, ChronoUnit.HOURS))) {
            // Recent result available — use it with a note
            return cached.get().withNote("SCREENING_API_UNAVAILABLE_RECENT_CACHE_USED");
        }

        // No recent result: for high-value or first-time payments, block
        if (payment.getAmount().compareTo(new BigDecimal("10000")) > 0
                || isFirstTimePayment(payment)) {
            return ComplianceResult.blocked(
                    "SCREENING_UNAVAILABLE_HIGH_RISK",
                    "Compliance screening unavailable — blocking high-risk payment");
        }

        // For low-value known beneficiaries: allow with manual review flag
        return ComplianceResult.allowWithReview(
                "SCREENING_UNAVAILABLE_LOW_RISK",
                "Compliance screening unavailable — flagged for manual review");
    }

    // Exchange rate fallback: stale data is acceptable for display
    // but must be clearly marked as estimated for payment calculation
    @CircuitBreaker(name = "exchange-rate-api",
                    fallbackMethod = "exchangeRateFallback")
    public ExchangeRate getExchangeRate(String pair) {
        return exchangeRateService.getRate(pair);
    }

    private ExchangeRate exchangeRateFallback(String pair, Exception cause) {
        meterRegistry.counter("payment.exchange_rate.fallback").increment();

        // For cross-currency payments: stale cached rate may be used
        // but payment must be re-quoted when API recovers
        Optional<ExchangeRate> stale = exchangeRateCache.get(pair);
        if (stale.isPresent()) {
            ExchangeRate rate = stale.get();
            long staleMinutes = Duration.between(rate.getFetchedAt(),
                    Instant.now()).toMinutes();

            if (staleMinutes <= 60) {
                // Within 1 hour: acceptable for display, mark as estimated
                return rate.withNote("ESTIMATED_RATE_" + staleMinutes + "MIN_OLD");
            }
        }

        // No acceptable cached rate: cannot process cross-currency payment
        throw new ExchangeRateUnavailableException(
                "Exchange rate unavailable and no recent cache for: " + pair);
    }
}
```

---

## 4. Degraded Mode Operations

Degraded mode allows the system to continue core operations while non-critical functionality is unavailable.

```java
@Service
public class PaymentApiDegradedModeManager {

    private final FeatureFlagService featureFlags;
    private final CircuitBreakerRegistry circuitBreakerRegistry;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(
            PaymentApiDegradedModeManager.class);

    // Assess current system health and determine degraded mode level
    public DegradedModeLevel assess() {
        boolean fraudScoringAvailable    = isHealthy("fraud-ml-model");
        boolean sanctionsApiAvailable    = isHealthy("sanctions-screening");
        boolean exchangeRateAvailable    = isHealthy("exchange-rate-api");
        boolean notificationAvailable    = isHealthy("notification-service");
        boolean analyticsAvailable       = isHealthy("analytics-service");

        if (!sanctionsApiAvailable) {
            // Compliance control degraded — severe
            log.error("DEGRADED MODE: Sanctions API unavailable");
            return DegradedModeLevel.SEVERE;
        }

        if (!fraudScoringAvailable) {
            // Fraud scoring degraded — rules-only fallback active
            log.warn("DEGRADED MODE: Fraud ML scoring unavailable, rules-only");
            return DegradedModeLevel.MODERATE;
        }

        if (!exchangeRateAvailable) {
            // Exchange rates degraded — cached rates in use
            log.warn("DEGRADED MODE: Exchange rate API unavailable, cached rates");
            return DegradedModeLevel.MINOR;
        }

        if (!notificationAvailable || !analyticsAvailable) {
            // Non-critical services degraded — core payment unaffected
            return DegradedModeLevel.NEGLIGIBLE;
        }

        return DegradedModeLevel.NONE;
    }

    private boolean isHealthy(String circuitBreakerName) {
        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker(
                circuitBreakerName);
        return cb.getState() == CircuitBreaker.State.CLOSED
                || cb.getState() == CircuitBreaker.State.HALF_OPEN;
    }

    // Add degraded mode header to all responses during degradation
    public void addDegradedModeHeader(ServerHttpResponse response) {
        DegradedModeLevel level = assess();
        if (level != DegradedModeLevel.NONE) {
            response.getHeaders().add("X-Degraded-Mode", level.name());
            meterRegistry.gauge("system.degraded_mode_level",
                    level.getNumericLevel());
        }
    }
}
```

---

## 5. Testing Fallbacks in Integration Tests

Fallbacks must be tested just like happy paths. An untested fallback is a liability.

```java
@SpringBootTest
@ExtendWith(SpringExtension.class)
class FallbackIntegrationTest {

    @Autowired
    private ExchangeRateService exchangeRateService;

    @Autowired
    private ExchangeRateCacheService cacheService;

    @MockBean
    private ExchangeRateApiClient mockApiClient;

    @Autowired
    private CircuitBreakerRegistry circuitBreakerRegistry;

    @Test
    void whenApiFailsAndCacheAvailable_returnsCachedRate() {
        // Arrange: prime cache with known data
        ExchangeRate cachedRate = ExchangeRate.builder()
                .pair("USD/EUR")
                .rate(new BigDecimal("0.91"))
                .fetchedAt(Instant.now().minus(10, ChronoUnit.MINUTES))
                .build();
        cacheService.put("USD/EUR", cachedRate, Duration.ofHours(1));

        // Arrange: API throws
        when(mockApiClient.fetchRate("USD/EUR"))
                .thenThrow(new WebClientResponseException(503,
                        "Service Unavailable", null, null, null));

        // Open the circuit breaker to trigger fallback immediately
        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker("exchange-rate-api");
        cb.transitionToOpenState();

        // Act
        ExchangeRate result = exchangeRateService.getRate("USD/EUR");

        // Assert: got cached rate
        assertThat(result.getRate()).isEqualByComparingTo("0.91");
        assertThat(result.isStale()).isTrue();
        assertThat(result.getNote()).contains("CACHED_RATE");
    }

    @Test
    void whenApiAndCacheFail_returnsStaticFallback() {
        // Arrange: no cache
        cacheService.evict("USD/GBP");

        when(mockApiClient.fetchRate("USD/GBP"))
                .thenThrow(new WebClientResponseException(503, "Unavailable",
                        null, null, null));

        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker("exchange-rate-api");
        cb.transitionToOpenState();

        // Act
        ExchangeRate result = exchangeRateService.getRate("USD/GBP");

        // Assert: static fallback
        assertThat(result.getSource()).isEqualTo("STATIC_FALLBACK");
        assertThat(result.getRate()).isEqualByComparingTo("0.79");
    }

    @Test
    void whenAllFallbacksExhausted_throwsException() {
        // Arrange: no cache, no static for exotic pair
        when(mockApiClient.fetchRate("USD/XYZ"))
                .thenThrow(new RuntimeException("API down"));

        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker("exchange-rate-api");
        cb.transitionToOpenState();

        // Act & Assert
        assertThatThrownBy(() -> exchangeRateService.getRate("USD/XYZ"))
                .isInstanceOf(ExchangeRateUnavailableException.class);
    }
}
```

---

## 6. Monitoring Fallback Activation Rate

Fallback activation is a leading indicator of service degradation. Rising fallback rates before the circuit opens fully allow proactive intervention.

```java
@Component
public class FallbackActivationMonitor {

    private final MeterRegistry meterRegistry;
    private final AlertService alertService;
    private static final Logger log = LoggerFactory.getLogger(FallbackActivationMonitor.class);

    // Alert when fallback activation rate exceeds thresholds
    @Scheduled(fixedRate = 60_000)
    public void checkFallbackRates() {
        // Exchange rate fallback rate
        double exchangeRateFallbackRate = calculateFallbackRate(
                "exchange.rate.fallback.triggered",
                "exchange.rate.requests.total");

        if (exchangeRateFallbackRate > 0.01) {  // > 1%
            alertService.warning("EXCHANGE_RATE_FALLBACK_ELEVATED",
                    String.format("Exchange rate fallback rate: %.1f%%",
                            exchangeRateFallbackRate * 100));
        }

        // Compliance fallback
        double complianceFallbackRate = calculateFallbackRate(
                "payment.compliance.fallback",
                "payment.compliance.total");

        if (complianceFallbackRate > 0.001) {  // > 0.1%
            alertService.critical("COMPLIANCE_FALLBACK_ELEVATED",
                    String.format("Compliance screening fallback rate: %.2f%%",
                            complianceFallbackRate * 100) +
                    " — compliance controls degraded");
        }

        // Fraud scoring fallback
        double fraudFallbackRate = calculateFallbackRate(
                "fraud.ml.fallback.activated",
                "fraud.score.requests.total");

        if (fraudFallbackRate > 0.001) {
            alertService.warning("FRAUD_FALLBACK_ELEVATED",
                    String.format("Fraud ML fallback rate: %.2f%%",
                            fraudFallbackRate * 100));
        }
    }

    private double calculateFallbackRate(String fallbackMetric, String totalMetric) {
        double fallbacks = meterRegistry.counter(fallbackMetric).count();
        double total     = meterRegistry.counter(totalMetric).count();
        return total > 0 ? fallbacks / total : 0;
    }
}
```

---

## 7. Fallback Decision Guide

```
When deciding on a fallback strategy for a component, answer:

Q1: What is the consequence of providing incorrect data?
  - Financial loss (overpayment, underpayment) → fail-closed or cached with staleness check
  - Compliance failure (miss sanctions match)   → fail-closed always
  - Poor user experience (wrong currency display) → stale cache acceptable

Q2: How stale is "too stale" for the use case?
  - Exchange rate for payment calculation → 60 minutes max
  - Exchange rate for display only        → 4 hours acceptable
  - Risk score                            → 24 hours for existing customers
  - Sanctions screening result            → 24 hours (between watchlist updates)

Q3: What is the customer impact of failing closed?
  - Payment blocked (high friction)   → use stale cache if available
  - Service unavailable message        → accept for compliance controls
  - Degraded but functional experience → preferred for non-critical paths

Q4: Can the operation be deferred?
  - Notifications, analytics → yes, queue for later
  - Payment authorisation    → no, must respond synchronously
  - Risk re-rating            → yes, can run after recovery
```

---

## Summary

Fallback patterns are what make a circuit breaker useful rather than just a failure indicator. The pattern hierarchy — static fallback, cached fallback, degraded mode, fail-closed — maps to decreasing data quality and increasing safety. For compliance controls (sanctions screening, compliance checks), fail-closed is the only regulatory-safe fallback when a cache miss occurs. For non-compliance data (exchange rates, risk scores), stale cached data with a clear staleness annotation is usually acceptable. Test all fallbacks explicitly — an untested fallback is not a fallback, it is a hidden failure mode.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "When a sanctions screening API is unavailable and no recent cached result exists, what is the correct fallback for a high-value payment?",
      "options": ["Allow the payment with an async review flag", "Return a stale cached result regardless of age", "Block the payment (fail-closed) — compliance controls cannot be bypassed", "Use a static fallback that always approves"],
      "correct": 2,
      "explanation": "For compliance controls, fail-closed is the only regulatory-safe behavior when no recent screening result exists. Allowing a payment that bypasses sanctions screening exposes the institution to regulatory violations, fines, and potentially criminal liability. The correct choice is to block and require manual review."
    },
    {
      "text": "What is fallback chaining and why is it useful?",
      "options": ["Connecting multiple circuit breakers in series", "Trying progressively less accurate fallback strategies in order (ML → cache → rules → static) to maximize availability while degrading gracefully", "Replicating fallback logic across multiple services", "Using multiple retry attempts before giving up"],
      "correct": 1,
      "explanation": "Fallback chaining tries multiple strategies in order from most to least accurate. If ML scoring fails, try cached score. If cache misses, try rules-based scoring. If rules engine fails, use a conservative static score. This maximizes service availability while being transparent about data quality degradation at each level."
    },
    {
      "text": "An exchange rate API has been unavailable for 90 minutes. The cached rate is 90 minutes old. Should it be used for a cross-currency payment calculation?",
      "options": ["Yes, any cached data is better than an error", "No — a 90-minute-old exchange rate exceeds the 60-minute staleness threshold for payment calculations", "Yes, but only if the payment is under $1,000", "It depends on the currency pair"],
      "correct": 1,
      "explanation": "Exchange rates can move significantly in 90 minutes. The lesson establishes 60 minutes as the maximum acceptable staleness for payment calculations (versus 4 hours for display only). Using a 90-minute-old rate could cause the customer to pay significantly more or less than the displayed amount. The correct response is to block cross-currency payments until the API recovers."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Multi-Level Fallback System for Payment Service Dependencies",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a three-level ExchangeRateService fallback chain: (1) live API call, (2) Redis cache with staleness check returning stale rate annotated with age in minutes, (3) static embedded rates map. Throw ExchangeRateUnavailableException only when no level can serve the request."},
    {"id": "2", "description": "Build a RiskScoringService with four-level fallback chaining using nested @CircuitBreaker annotations: ML model → cached score → rules engine → conservative static HIGH risk score. Each level must increment its own Prometheus counter to make fallback activation independently observable."},
    {"id": "3", "description": "Implement a compliance fallback that: uses a cached screening result if it is less than 1 hour old, blocks high-value payments (>$10,000) or first-time payments when no recent cache exists, and allows low-value known-beneficiary payments with a manual-review flag. Write three integration tests covering each path."},
    {"id": "4", "description": "Create a FallbackActivationMonitor @Scheduled(fixedRate=60000) that computes per-service fallback rates, sends warning when exchange rate fallback exceeds 1%, and sends critical alert when compliance fallback exceeds 0.1%. Add a DegradedModeLevel indicator that exposes current degradation level as a Prometheus gauge."}
  ]
}
-->

