---
id: track-06-lesson-14
title: "أنماط البدائل — الاستجابات الثابتة والمخزّنة والمخفّضة"
slug: fallback-patterns
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 14
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [fallback, cache, static-response, degraded-mode, Resilience4j]
prerequisites: [track-06-lesson-02, track-06-lesson-04]
---

# أنماط الرجوع (Fallback) — الردود الثابتة والمخزنة والمتدهورة

> [!NOTE]
> قاطع الدائرة الذي يفتح ويعيد خطأً إلى المستدعي لم يحل مشكلة موثوقية — بل جعل الفشل مرئيًا فقط. وأنماط الرجوع هي ما يحدث بعد فتح الدائرة: يواصل النظام العمل، بدقة أقل، مستخدمًا أفضل البيانات المتاحة. والفن هو معرفة أي رد متدهور مقبول لكل حالة استخدام.

## تصنيف أنماط الرجوع

| النوع | حالة الاستخدام | المفاضلة |
|---|---|---|
| رجوع ثابت | قيمة افتراضية معروفة الأمان | قد تكون خاطئة لبعض المستخدمين |
| رجوع مخزن | آخر قيمة سليمة معروفة | قد تكون قديمة |
| خدمة متدهورة | وظائف مخفضة | يرى العميل سلوكًا مختلفًا |
| الفشل المفتوح (Fail-open) | السماح بفحوص مخفضة | خطر رقابي (امتثال) |
| الفشل المغلق (Fail-closed) | الحجب / الرفض | احتكاك مع العميل |
| الصف لإعادة المحاولة | إعادة محاولة غير متزامنة بعد التعافي | زمن أطول |

يعتمد الاختيار على دلالات العملية. فلقرارات الدفع، الفشل المغلق (الرفض أو التعليق) أكثر أمانًا من الفشل المفتوح (الموافقة دون فحوص). ولعرض سعر الصرف، سعر مخزن قديم أفضل من خطأ.

## 1. ‏@CircuitBreaker في Resilience4j مع رجوع

```java
@Service
public class ExchangeRateService {

    private final ExchangeRateApiClient apiClient;
    private final ExchangeRateCacheService cacheService;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(ExchangeRateService.class);

    // Static fallback rates — used when cache is also unavailable.
    // Updated by the treasury team, embedded in the service.
    // DISPLAY / indicative use ONLY: a static rate must never price an
    // executable conversion (it can be far from the market).
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

## 2. سلسلة الرجوع

تجرب سلسلة الرجوع عدة استراتيجيات رجوع بالترتيب، من الأدق إلى الأكثر تحفظًا.

```java
@Service
public class RiskScoringService {

    private final MLRiskScoringClient mlScoringClient;
    private final RulesBasedRiskEngine rulesEngine;
    private final RiskScoreCacheService cacheService;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(RiskScoringService.class);

    // Fallback chain: ML Model -> Cache -> Rules -> Static.
    // The chain is written out EXPLICITLY in one fallback method. Annotating
    // the (private) fallback methods with more @CircuitBreaker annotations
    // would do nothing: Resilience4j calls a fallback by reflection, not
    // through the Spring proxy, so annotations on it are never applied.
    @CircuitBreaker(name = "ml-risk-scoring", fallbackMethod = "fallbackChain")
    public RiskScore score(Customer customer) {
        return mlScoringClient.score(customer);
    }

    private RiskScore fallbackChain(Customer customer, Exception cause) {
        meterRegistry.counter("risk.score.fallback.ml_unavailable").increment();
        log.warn("ML scoring unavailable for customerId={}: {}",
                customer.getCustomerId(), cause.getMessage());

        // Level 1: cached score
        Optional<RiskScore> cached = cacheService.get(customer.getCustomerId());
        if (cached.isPresent()) {
            return cached.get().withFallbackNote("ML_UNAVAILABLE_CACHE_USED");
        }

        // Level 2: rules-based scoring (guarded by its own circuit breaker,
        // applied programmatically because we are not going through a proxy)
        meterRegistry.counter("risk.score.fallback.cache_miss").increment();
        try {
            return rulesCircuitBreaker.executeSupplier(() -> rulesEngine.score(customer));
        } catch (Exception rulesFailure) {
            // Level 3: static conservative score
            return staticConservativeScore(customer);
        }
    }

    private RiskScore staticConservativeScore(Customer customer) {
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

## 3. أنماط الرجوع في واجهة الدفع

لواجهات الدفع أكثر قرارات الرجوع عواقب. فالرجوع الخاطئ قد يسبب خسارة مالية أو مخالفة رقابية.

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

        // A cached CLEAR result may be reused only if it was produced for the
        // SAME party data against the CURRENT sanctions-list version.
        // (Lists change at any time — a result from before the last update
        //  says nothing about names added since.)
        Optional<ComplianceResult> cached = complianceCache
                .getResult(payment.screeningFingerprint());   // hash of party data

        if (cached.isPresent()
                && cached.get().getListVersion().equals(sanctionsLists.currentVersion())) {
            return cached.get().withNote("SCREENING_API_UNAVAILABLE_CACHE_SAME_LIST_VERSION");
        }

        // Otherwise: FAIL CLOSED for every payment. Sanctions breaches are
        // close to strict liability — "we released it and reviewed it later"
        // is not a defence. Hold the payment (funds NOT released) until the
        // screening service is back, and process the backlog in order.
        return ComplianceResult.heldPendingScreening(
                "SCREENING_UNAVAILABLE",
                "Compliance screening unavailable — payment held until screened");
    }

    // Exchange rate fallback: stale data is acceptable for display or an
    // INDICATIVE quote (clearly marked). Executing the conversion needs a
    // fresh (or treasury-approved) rate — otherwise the firm carries the gap.
    @CircuitBreaker(name = "exchange-rate-api",
                    fallbackMethod = "exchangeRateFallback")
    public ExchangeRate getExchangeRate(String pair) {
        return exchangeRateService.getRate(pair);
    }

    private ExchangeRate exchangeRateFallback(String pair, Exception cause) {
        meterRegistry.counter("payment.exchange_rate.fallback").increment();

        // For cross-currency payments: a stale cached rate may be SHOWN as an
        // estimate, but the payment must be re-quoted at a live rate before
        // it is executed
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

## 4. عمليات النمط المتدهور

يسمح النمط المتدهور للنظام بمواصلة العمليات الأساسية بينما الوظائف غير الحرجة غير متاحة.

```java
@Service
public class PaymentApiDegradedModeManager {

    private final FeatureFlagService featureFlags;
    private final CircuitBreakerRegistry circuitBreakerRegistry;
    // Registered ONCE as a gauge; updated on every assessment
    private final AtomicInteger degradedLevel;
    private static final Logger log = LoggerFactory.getLogger(
            PaymentApiDegradedModeManager.class);

    public PaymentApiDegradedModeManager(FeatureFlagService featureFlags,
                                         CircuitBreakerRegistry circuitBreakerRegistry,
                                         MeterRegistry meterRegistry) {
        this.featureFlags = featureFlags;
        this.circuitBreakerRegistry = circuitBreakerRegistry;
        this.degradedLevel = meterRegistry.gauge("system.degraded_mode_level", new AtomicInteger());
    }

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
        degradedLevel.set(level.getNumericLevel());   // also resets to 0 when healthy
        if (level != DegradedModeLevel.NONE) {
            response.getHeaders().add("X-Degraded-Mode", level.name());
        }
    }
}
```

## 5. اختبار أنماط الرجوع في اختبارات التكامل

يجب اختبار أنماط الرجوع تمامًا كالمسارات السعيدة. فنمط الرجوع غير المختبر عبء.

```java
@SpringBootTest
@ExtendWith(SpringExtension.class)
class FallbackIntegrationTest {

    @Autowired
    private ExchangeRateService exchangeRateService;

    @Autowired
    private ExchangeRateCacheService cacheService;

    @MockitoBean   // Spring Boot 3.4+ (replaces the deprecated @MockBean)
    private ExchangeRateApiClient mockApiClient;

    @Autowired
    private CircuitBreakerRegistry circuitBreakerRegistry;

    // Circuit breakers are singletons in the context: an OPEN state set by one
    // test would leak into the next — reset after each test
    @AfterEach
    void resetCircuit() {
        circuitBreakerRegistry.circuitBreaker("exchange-rate-api").reset();
    }

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

## 6. مراقبة معدل تفعيل الرجوع

تفعيل الرجوع مؤشر مبكر على تدهور الخدمة. وارتفاع معدلات الرجوع قبل أن تفتح الدائرة كليًا يتيح تدخلًا استباقيًا.

```java
@Component
public class FallbackActivationMonitor {

    private final MeterRegistry meterRegistry;
    private final AlertService alertService;
    private static final Logger log = LoggerFactory.getLogger(FallbackActivationMonitor.class);

    // Counters are cumulative since startup: keep the last reading so each
    // check looks at the LAST MINUTE only. (In production these ratios are
    // usually computed in Prometheus with rate() instead.)
    private final Map<String, Double> lastSeen = new ConcurrentHashMap<>();

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
                    " — compliance controls degraded, payments being held");
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
        double fallbacks = delta(fallbackMetric);
        double total     = delta(totalMetric);
        return total > 0 ? fallbacks / total : 0;
    }

    private double delta(String metric) {
        double now = meterRegistry.counter(metric).count();
        Double before = lastSeen.put(metric, now);
        return before == null ? now : now - before;
    }
}
```

## 7. دليل قرار الرجوع

```
When deciding on a fallback strategy for a component, answer:

Q1: What is the consequence of providing incorrect data?
  - Financial loss (overpayment, underpayment) → fail-closed or cached with staleness check
  - Compliance failure (miss sanctions match)   → fail-closed always
  - Poor user experience (wrong currency display) → stale cache acceptable

Q2: How stale is "too stale" for the use case?
  - Exchange rate for an indicative payment quote → 60 minutes max
                                       (re-quote at a live rate before executing)
  - Exchange rate for display only        → 4 hours acceptable
  - Risk score                            → 24 hours for existing customers
  - Sanctions screening result            → only until the next list update,
                                       and only for the same party data

Q3: What is the customer impact of failing closed?
  - Payment blocked (high friction)   → use stale cache if available
  - Service unavailable message        → accept for compliance controls
  - Degraded but functional experience → preferred for non-critical paths

Q4: Can the operation be deferred?
  - Notifications, analytics → yes, queue for later
  - Payment authorisation    → no, must respond synchronously
  - Risk re-rating            → yes, can run after recovery
```

## الخلاصة

أنماط الرجوع هي ما يجعل قاطع الدائرة مفيدًا لا مجرد مؤشر فشل. وتسلسل الأنماط — رجوع ثابت، ورجوع مخزن، ونمط متدهور، وفشل مغلق — يقابل جودة بيانات متناقصة وأمانًا متزايدًا. ولضوابط الامتثال (فحص العقوبات، وفحوص الامتثال)، يكون الفشل المغلق — تعليق الدفعة حتى يمكن فحصها — هو الرجوع الوحيد الآمن رقابيًا عندما لا توجد نتيجة فحص صالحة. ولبيانات غير الامتثال (أسعار الصرف، ودرجات المخاطر)، تكون البيانات المخزنة القديمة مع توضيح صريح لقدمها مقبولة عادة. واختبر كل أنماط الرجوع صراحة — فنمط الرجوع غير المختبر ليس رجوعًا، بل نمط فشل خفي.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "عندما تكون واجهة فحص العقوبات غير متاحة ولا توجد نتيجة مخزنة حديثة، ما الرجوع الصحيح لدفعة عالية القيمة؟",
      "options": ["السماح بالدفعة مع علَم مراجعة غير متزامنة", "إعادة نتيجة مخزنة قديمة بغض النظر عن عمرها", "تعليق الدفعة (فشل مغلق) — لا يمكن تجاوز ضوابط الامتثال", "استخدام رجوع ثابت يوافق دائمًا"],
      "correct": 2,
      "explanation": "لضوابط الامتثال، الفشل المغلق هو السلوك الوحيد الآمن رقابيًا عندما لا توجد نتيجة فحص صالحة — لأي مبلغ، لا للدفعات عالية القيمة فقط. فتحرير دفعة تجاوزت فحص العقوبات يعرّض المؤسسة لمخالفات رقابية وغرامات وربما مسؤولية جنائية، والمراجعة بعد ذلك ليست دفاعًا. والخيار الصحيح تعليق الدفعة (دون تحرير الأموال) حتى يعود الفحص متاحًا."
    },
    {
      "text": "ما سلسلة الرجوع ولماذا هي مفيدة؟",
      "options": ["ربط عدة قواطع دائرة على التوالي", "تجربة استراتيجيات رجوع أقل دقة تدريجيًا بالترتيب (ML ← كاش ← قواعد ← ثابت) لتعظيم التوفر مع التدهور برشاقة", "نسخ منطق الرجوع عبر عدة خدمات", "استخدام عدة محاولات قبل الاستسلام"],
      "correct": 1,
      "explanation": "تجرب سلسلة الرجوع عدة استراتيجيات بالترتيب من الأدق إلى الأقل دقة. فإذا فشل تقييم ML، جرّب درجة مخزنة. وإذا أخفق الكاش، جرّب التقييم القائم على القواعد. وإذا فشل محرك القواعد، استخدم درجة ثابتة متحفظة. وفي Resilience4j يجب كتابة السلسلة صراحة داخل دالة الرجوع — فالتعليقات على دوال الرجوع لا تُطبق. وهذا يعظّم التوفر مع الشفافية بشأن تدهور جودة البيانات في كل مستوى."
    },
    {
      "text": "واجهة أسعار صرف غير متاحة منذ 90 دقيقة. والسعر المخزن عمره 90 دقيقة. هل يجب استخدامه لحساب دفعة بعملات مختلفة؟",
      "options": ["نعم، أي بيانات مخزنة أفضل من خطأ", "لا — سعر صرف عمره 90 دقيقة يتجاوز عتبة القدم البالغة 60 دقيقة حتى لعرض سعر استرشادي", "نعم، لكن فقط إذا كانت الدفعة تحت 1,000 دولار", "يعتمد على زوج العملات"],
      "correct": 1,
      "explanation": "قد تتحرك أسعار الصرف بشكل كبير في 90 دقيقة. ويحدد الدرس 60 دقيقة كحد أقصى للقدم حتى لعرض سعر استرشادي (مقابل 4 ساعات للعرض فقط) — وأي تحويل منفذ يجب أن يستخدم سعرًا حيًا على أي حال. واستخدام سعر عمره 90 دقيقة قد يجعل العميل يدفع أكثر أو أقل بكثير من سعر السوق. والرد الصحيح إيقاف عروض أسعار الدفعات بعملات مختلفة حتى تتعافى خدمة الأسعار."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "نظام رجوع متعدد المستويات لاعتماديات خدمة الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ سلسلة رجوع من ثلاثة مستويات في ExchangeRateService: ‏(1) استدعاء الواجهة الحية، (2) كاش Redis مع فحص القدم يعيد السعر القديم موسومًا بعمره بالدقائق، (3) خريطة أسعار ثابتة مضمّنة. وارمِ ExchangeRateUnavailableException فقط عندما لا يستطيع أي مستوى خدمة الطلب."},
    {"id": "2", "description": "ابنِ RiskScoringService بسلسلة رجوع من أربعة مستويات: نموذج ML ← درجة مخزنة ← محرك القواعد ← درجة ثابتة متحفظة بمخاطر HIGH. واكتب السلسلة صراحة داخل دالة الرجوع لقاطع الدائرة (التعليقات على دوال الرجوع لا تُطبق)، مع حماية محرك القواعد بقاطع دائرة برمجي. ويجب أن يزيد كل مستوى عداد Prometheus خاصًا به لجعل تفعيل الرجوع قابلًا للمراقبة مستقلًا."},
    {"id": "3", "description": "نفّذ رجوع امتثال يعيد استخدام نتيجة فحص مخزنة فقط إذا أُنتجت لبيانات الأطراف نفسها مقابل إصدار قائمة العقوبات الحالي، وإلا يعلّق الدفعة (دون تحرير الأموال) حتى يتوفر الفحص — لأي مبلغ. واكتب اختبارات تكامل تغطي مسار إصابة الكاش، ومسار تغير إصدار القائمة، ومسار التعليق."},
    {"id": "4", "description": "أنشئ FallbackActivationMonitor بـ @Scheduled(fixedRate=60000) يحسب معدلات الرجوع لكل خدمة، ويرسل تحذيرًا عندما يتجاوز رجوع أسعار الصرف 1%، وتنبيهًا حرجًا عندما يتجاوز رجوع الامتثال 0.1%. وأضف مؤشر DegradedModeLevel يعرض مستوى التدهور الحالي كمقياس gauge في Prometheus."}
  ]
}
-->
