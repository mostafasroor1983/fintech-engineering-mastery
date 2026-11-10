---
id: track-07-lesson-16
title: "RegTech Integration — Third-Party Screening APIs"
slug: regtech-integration
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 16
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [RegTech, API-integration, LexisNexis, Refinitiv, resilience]
prerequisites: [track-07-lesson-03, track-07-lesson-06]
---

# RegTech Integration — Third-Party Screening APIs

> [!NOTE]
> RegTech providers — Refinitiv World-Check, ComplyAdvantage, LexisNexis, Dow Jones — give institutions access to curated watchlist and PEP data that would be prohibitively expensive to maintain in-house. The integration engineering challenge is treating these providers as unreliable external dependencies: they will have outages, rate limit you, change API schemas, and return inconsistent results. Your compliance controls must work reliably regardless.

## RegTech Provider Landscape

| Provider | Primary Data | Strengths | API Style |
|---|---|---|---|
| Refinitiv World-Check | PEP, sanctions, adverse media | Deepest PEP coverage | REST + SFTP batch |
| ComplyAdvantage | Sanctions, PEP, adverse media | Real-time news monitoring | REST |
| LexisNexis Bridger | Sanctions, PEP, identity | Strong US domestic | REST / SOAP |
| Dow Jones Risk & Compliance | PEP, state-owned enterprises | Financial sector focus | REST + SFTP |
| Acuris (LSEG) | PEP, sanctions | Good Asia-Pacific coverage | REST |

No single provider covers all scenarios. A layered approach using a primary provider for real-time screening and a secondary provider for batch verification reduces gaps.

---

## 1. Resilient RegTech Client Architecture

```java
@Configuration
public class RegTechClientConfig {

    // Primary: Refinitiv World-Check
    @Bean("worldCheckWebClient")
    public WebClient worldCheckWebClient(
            @Value("${regtech.worldcheck.base-url}") String baseUrl,
            @Value("${regtech.worldcheck.api-key}") String apiKey) {
        return WebClient.builder()
                .baseUrl(baseUrl)
                .defaultHeader("x-api-key", apiKey)
                .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .codecs(c -> c.defaultCodecs().maxInMemorySize(2 * 1024 * 1024))
                .build();
    }

    // Secondary: ComplyAdvantage
    @Bean("complyAdvantageWebClient")
    public WebClient complyAdvantageWebClient(
            @Value("${regtech.comply.base-url}") String baseUrl,
            @Value("${regtech.comply.api-key}") String apiKey) {
        return WebClient.builder()
                .baseUrl(baseUrl)
                .defaultHeader("Authorization", "Token " + apiKey)
                .build();
    }

    // Circuit breakers
    @Bean
    public CircuitBreakerRegistry circuitBreakerRegistry() {
        CircuitBreakerConfig config = CircuitBreakerConfig.custom()
                .failureRateThreshold(50)
                .waitDurationInOpenState(Duration.ofSeconds(60))
                .slidingWindowSize(20)
                .permittedNumberOfCallsInHalfOpenState(5)
                .recordExceptions(WebClientResponseException.class,
                                  TimeoutException.class,
                                  ConnectException.class)
                .ignoreExceptions(ScreeningMatchException.class)  // 200 with match != failure
                .build();

        return CircuitBreakerRegistry.of(config);
    }
}
```

---

## 2. World-Check Integration with Circuit Breaker

```java
@Service
public class WorldCheckScreeningService {

    private final WebClient worldCheckClient;
    private final CircuitBreakerRegistry circuitBreakerRegistry;
    private final ScreeningCacheService cacheService;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(WorldCheckScreeningService.class);

    private final CircuitBreaker circuitBreaker;

    @PostConstruct
    public void init() {
        this.circuitBreaker = circuitBreakerRegistry
                .circuitBreaker("world-check");
    }

    public ScreeningResult screen(ScreeningRequest request) {
        // 1. Check cache first
        Optional<ScreeningResult> cached = cacheService
                .get(request.getCacheKey());
        if (cached.isPresent()) {
            meterRegistry.counter("regtech.worldcheck.cache.hit").increment();
            return cached.get();
        }

        // 2. Call World-Check via circuit breaker
        try {
            ScreeningResult result = circuitBreaker.executeSupplier(
                    () -> callWorldCheck(request));
            cacheService.put(request.getCacheKey(), result,
                    Duration.ofHours(24));
            return result;

        } catch (CallNotPermittedException e) {
            // Circuit open: use fallback
            meterRegistry.counter("regtech.worldcheck.circuit.open").increment();
            log.warn("World-Check circuit breaker open, using fallback");
            return fallbackScreening(request);
        }
    }

    private ScreeningResult callWorldCheck(ScreeningRequest request) {
        long start = System.currentTimeMillis();
        try {
            WorldCheckSearchRequest wcRequest = buildWorldCheckRequest(request);

            WorldCheckSearchResponse response = worldCheckClient.post()
                    .uri("/v1/cases/screeningRequest")
                    .bodyValue(wcRequest)
                    .retrieve()
                    .onStatus(HttpStatusCode::is5xxServerError, resp ->
                            resp.bodyToMono(String.class).flatMap(body ->
                                    Mono.error(new RegTechProviderException(
                                            "World-Check 5xx: " + body))))
                    .onStatus(status -> status.value() == 429, resp ->
                            Mono.error(new RateLimitException("World-Check rate limit")))
                    .bodyToMono(WorldCheckSearchResponse.class)
                    .timeout(Duration.ofSeconds(10))
                    .block();

            long latencyMs = System.currentTimeMillis() - start;
            meterRegistry.timer("regtech.worldcheck.latency")
                    .record(latencyMs, TimeUnit.MILLISECONDS);

            return mapToScreeningResult(response, "WORLD_CHECK");

        } catch (RateLimitException e) {
            // Rate limit is a transient failure — back off
            throw e;
        }
    }

    private WorldCheckSearchRequest buildWorldCheckRequest(ScreeningRequest request) {
        WorldCheckSearchRequest wcReq = new WorldCheckSearchRequest();
        wcReq.setGroupId(config.getWorldCheckGroupId());
        wcReq.setCaseName(request.getEntityName());

        // Entity details
        WorldCheckCaseEntity entity = new WorldCheckCaseEntity();
        entity.setEntityType(mapEntityType(request.getEntityType()));

        if (request.getEntityType() == EntityType.INDIVIDUAL) {
            IndividualEntity individual = new IndividualEntity();
            individual.setFirstName(request.getFirstName());
            individual.setSurname(request.getSurname());
            individual.setDateOfBirth(request.getDateOfBirth() != null
                    ? request.getDateOfBirth().toString() : null);
            individual.setNationality(request.getNationality());
            entity.setIndividual(individual);
        } else {
            BusinessEntity business = new BusinessEntity();
            business.setName(request.getEntityName());
            business.setCountryOfIncorporation(request.getCountry());
            entity.setBusiness(business);
        }

        wcReq.setEntity(entity);
        return wcReq;
    }

    // Fallback: use internal rules-based screening when provider is unavailable
    private ScreeningResult fallbackScreening(ScreeningRequest request) {
        log.warn("Using internal fallback screening for: {}",
                request.getEntityName());

        // Check internal sanction lists (cached daily from OFAC/HMT/EU)
        boolean onInternalList = internalSanctionsList
                .contains(request.getEntityName());

        return ScreeningResult.builder()
                .entityName(request.getEntityName())
                .matchStatus(onInternalList
                        ? MatchStatus.MATCH : MatchStatus.NO_MATCH_FALLBACK)
                .dataSource("INTERNAL_FALLBACK")
                .fallback(true)
                .screenedAt(Instant.now())
                .build();
    }
}
```

---

## 3. TTL-Based Caching for Screening Results

```java
@Service
public class ScreeningCacheService {

    private final RedisTemplate<String, ScreeningResult> redisTemplate;
    private static final String CACHE_PREFIX = "screening:";

    // Cache TTLs by entity risk level
    // High-risk entities screened more frequently
    private static final Map<RiskLevel, Duration> CACHE_TTLS = Map.of(
            RiskLevel.HIGH,    Duration.ofHours(4),
            RiskLevel.MEDIUM,  Duration.ofHours(12),
            RiskLevel.LOW,     Duration.ofHours(24),
            RiskLevel.UNKNOWN, Duration.ofHours(6)
    );

    public Optional<ScreeningResult> get(String cacheKey) {
        ScreeningResult result = redisTemplate.opsForValue()
                .get(CACHE_PREFIX + cacheKey);
        return Optional.ofNullable(result);
    }

    public void put(String cacheKey, ScreeningResult result, Duration ttl) {
        redisTemplate.opsForValue().set(
                CACHE_PREFIX + cacheKey, result, ttl);
    }

    public void invalidate(String cacheKey) {
        redisTemplate.delete(CACHE_PREFIX + cacheKey);
    }

    // Build cache key from entity attributes — must be deterministic
    public String buildCacheKey(ScreeningRequest request) {
        String components = String.join("|",
                request.getEntityType().name(),
                request.getEntityName().toLowerCase().trim(),
                request.getDateOfBirth() != null
                        ? request.getDateOfBirth().toString() : "unknown",
                request.getNationality() != null
                        ? request.getNationality() : "unknown");
        // SHA-256 hash to keep key length bounded
        return DigestUtils.sha256Hex(components);
    }

    // Bulk invalidation when provider publishes new watchlist (daily)
    @Scheduled(cron = "0 6 * * *")  // 6 AM after nightly watchlist refresh
    public void invalidateSanctionsCache() {
        // Invalidate all screening cache entries — force re-screening
        // Pattern scan: safe for moderate Redis key counts
        Set<String> keys = redisTemplate.keys(CACHE_PREFIX + "*");
        if (keys != null && !keys.isEmpty()) {
            redisTemplate.delete(keys);
            log.info("Invalidated {} screening cache entries after watchlist refresh",
                    keys.size());
        }
    }
}
```

---

## 4. Batch vs Real-Time Screening Decisions

| Scenario | Approach | Justification |
|---|---|---|
| New customer onboarding | Real-time | Blocking: can't onboard without screening |
| Payment to new beneficiary | Real-time | Blocking: can't send without screening |
| Periodic re-screening | Batch (nightly) | Non-blocking: existing relationship |
| Watchlist refresh re-check | Batch | High volume: re-check all active customers |
| Event-triggered (PEP appointment) | Near-real-time | Priority but not blocking payment |

```java
@Service
public class ScreeningOrchestrationService {

    private final WorldCheckScreeningService worldCheckService;
    private final ComplyAdvantageService complyAdvantageService;
    private final ScreeningDecisionService decisionService;

    // Real-time: used during onboarding or payment authorisation
    public ScreeningDecision screenRealTime(ScreeningRequest request) {
        // Primary provider
        ScreeningResult primary;
        try {
            primary = worldCheckService.screen(request);
        } catch (Exception e) {
            log.error("Primary provider failed, using secondary", e);
            primary = complyAdvantageService.screen(request);
        }

        // If primary returned potential match, verify with secondary
        if (primary.getMatchStatus() == MatchStatus.POTENTIAL_MATCH) {
            ScreeningResult secondary = complyAdvantageService.screen(request);
            return decisionService.decide(primary, secondary);
        }

        return decisionService.decide(primary, null);
    }

    // Batch: used for periodic re-screening of existing customers
    @Async("batchScreeningExecutor")
    public CompletableFuture<ScreeningDecision> screenBatch(ScreeningRequest request) {
        return CompletableFuture.supplyAsync(() -> {
            ScreeningResult result = worldCheckService.screen(request);
            return decisionService.decide(result, null);
        });
    }

    // Process a batch of customers for periodic re-screening
    public BatchScreeningReport processBatch(List<String> customerIds) {
        int batchSize = 50;
        List<CompletableFuture<ScreeningDecision>> futures = new ArrayList<>();

        // Rate limit: max 10 concurrent API calls to avoid throttling
        Semaphore apiSemaphore = new Semaphore(10);

        for (String customerId : customerIds) {
            futures.add(CompletableFuture.supplyAsync(() -> {
                try {
                    apiSemaphore.acquire();
                    CustomerProfile profile = customerRepo.findById(customerId)
                            .orElseThrow();
                    ScreeningRequest request = buildRequest(profile);
                    return screenRealTime(request);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException(e);
                } finally {
                    apiSemaphore.release();
                }
            }));

            // Throttle: 50ms between requests to stay within rate limits
            if (futures.size() % batchSize == 0) {
                try { Thread.sleep(50); } catch (InterruptedException ignored) {}
            }
        }

        // Collect results
        List<ScreeningDecision> decisions = futures.stream()
                .map(f -> {
                    try { return f.get(30, TimeUnit.SECONDS); }
                    catch (Exception e) { return ScreeningDecision.error(); }
                })
                .toList();

        return BatchScreeningReport.builder()
                .totalProcessed(customerIds.size())
                .matchesFound((int) decisions.stream()
                        .filter(ScreeningDecision::isMatch).count())
                .errorsEncountered((int) decisions.stream()
                        .filter(ScreeningDecision::isError).count())
                .build();
    }
}
```

---

## 5. Vendor Comparison and Cost Optimisation

```java
@Service
public class VendorCostOptimisationService {

    // Track cost per API call by provider and entity type
    private static final Map<String, BigDecimal> COST_PER_CALL = Map.of(
            "WORLD_CHECK",      new BigDecimal("0.08"),
            "COMPLY_ADVANTAGE", new BigDecimal("0.05"),
            "DOW_JONES",        new BigDecimal("0.07"),
            "LEXISNEXIS",       new BigDecimal("0.06")
    );

    // Avoid re-calling API for same entity within cache TTL
    // Avoid calling secondary provider unless primary returns POTENTIAL_MATCH
    // Use batch SFTP for periodic re-screening of low-risk customers
    //   (batch pricing is 10-20x cheaper than per-call API pricing)

    public ProviderRecommendation recommend(ScreeningRequest request) {
        return switch (request.getScreeningTier()) {
            case REAL_TIME_CRITICAL ->
                // Best coverage regardless of cost
                ProviderRecommendation.of("WORLD_CHECK", "COMPLY_ADVANTAGE");
            case REAL_TIME_STANDARD ->
                // Cost-optimised with fallback
                ProviderRecommendation.of("COMPLY_ADVANTAGE", "WORLD_CHECK");
            case BATCH_PERIODIC ->
                // Batch SFTP upload is cheapest for high-volume periodic
                ProviderRecommendation.ofBatch("WORLD_CHECK_SFTP");
            default ->
                ProviderRecommendation.of("COMPLY_ADVANTAGE", null);
        };
    }
}
```

---

## 6. Handling Vendor Outages Gracefully

```java
@Component
public class RegTechVendorHealthMonitor {

    private final WorldCheckScreeningService worldCheckService;
    private final ComplyAdvantageService complyAdvantageService;
    private final CircuitBreakerRegistry circuitBreakerRegistry;
    private final AlertService alertService;
    private static final Logger log = LoggerFactory.getLogger(RegTechVendorHealthMonitor.class);

    @Scheduled(fixedRate = 60_000)  // every minute
    public void checkVendorHealth() {
        // Check circuit breaker states
        CircuitBreaker wcBreaker = circuitBreakerRegistry.circuitBreaker("world-check");
        CircuitBreaker caBreaker = circuitBreakerRegistry.circuitBreaker("comply-advantage");

        if (wcBreaker.getState() == CircuitBreaker.State.OPEN) {
            alertService.warning("REGTECH_VENDOR_DOWN",
                    "World-Check circuit breaker OPEN — using fallback screening");
        }

        boolean bothDown = wcBreaker.getState() == CircuitBreaker.State.OPEN
                && caBreaker.getState() == CircuitBreaker.State.OPEN;

        if (bothDown) {
            alertService.critical("REGTECH_ALL_VENDORS_DOWN",
                    "CRITICAL: All RegTech providers unavailable. " +
                    "Screening falling back to internal lists only. " +
                    "New onboarding may need to be paused.");
            // Some institutions' policy: pause new onboarding when all providers down
            onboardingGate.pause("REGTECH_PROVIDERS_UNAVAILABLE");
        }
    }
}
```

---

## 7. Provider Schema Change Management

RegTech providers change their API schemas. A versioned client isolates schema changes from business logic.

```java
@Component("worldCheckClientV2")
public class WorldCheckClientV2 implements ScreeningProvider {

    @Override
    public ScreeningResult screen(ScreeningRequest request) {
        // V2 API uses different field names than V1
        // This adapter translates our internal model to the V2 API schema
        WorldCheckV2Request v2Request = WorldCheckV2Request.builder()
                .searchTerms(List.of(
                        SearchTerm.builder()
                                .termType("FULL_NAME")
                                .value(request.getEntityName())
                                .build(),
                        request.getDateOfBirth() != null
                                ? SearchTerm.builder()
                                    .termType("DATE_OF_BIRTH")
                                    .value(request.getDateOfBirth().toString())
                                    .build()
                                : null
                ).stream().filter(Objects::nonNull).toList())
                .entityTypes(List.of(mapEntityType(request.getEntityType())))
                .secondaryFields(Map.of(
                        "nationality", request.getNationality() != null
                                ? request.getNationality() : ""
                ))
                .build();

        // Call and map response
        WorldCheckV2Response response = worldCheckV2WebClient.post()
                .uri("/v2/screen")
                .bodyValue(v2Request)
                .retrieve()
                .bodyToMono(WorldCheckV2Response.class)
                .timeout(Duration.ofSeconds(10))
                .block();

        return mapV2Response(response);
    }
}
```

---

## 8. Operational Runbook

| Scenario | Response |
|---|---|
| Primary provider rate-limited (429) | Exponential backoff; retry after 60s; use secondary |
| Primary provider 5xx | Circuit breaker opens after 50% failure rate; route to secondary |
| Both providers down | Internal OFAC/HMT/EU list fallback; alert Compliance; consider pausing onboarding |
| Watchlist data outdated | Auto-invalidate cache on daily watchlist refresh; alert if refresh fails |
| Schema change (4xx on valid request) | Circuit breaker trips; alert Engineering; deploy updated client |
| Rate limit exceeded | Reduce batch concurrency; negotiate higher limit with provider |

---

## Summary

RegTech integration requires treating external providers as unreliable third parties. Circuit breakers prevent cascade failure when a provider is down. TTL-based caching reduces costs and latency for repeat screenings. The fallback strategy — internal watchlists plus conservative decision logic — ensures compliance controls never completely fail even when all external providers are unavailable. Batch SFTP ingestion is 10-20x cheaper than per-call API pricing and should be used for periodic re-screening of large customer populations.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why should RegTech providers be treated as unreliable external dependencies rather than trusted internal services?",
      "options": ["RegTech providers have contractual SLAs so outages are their responsibility", "They will have outages, rate limit you, change API schemas, and return inconsistent results — your compliance controls must work reliably regardless, using circuit breakers, fallbacks, and internal list caching", "External providers are slower than internal services and must be monitored for latency", "RegTech APIs use legacy SOAP protocols that are inherently unreliable"],
      "correct": 1,
      "explanation": "No external provider has 100% uptime. If your compliance screening fails closed when a provider is unavailable, you block all onboarding. If it fails open, you have a compliance gap. The engineering requirement is that compliance controls continue operating at a reduced fidelity (internal OFAC/HMT lists, conservative decision logic) even when all external providers are simultaneously unavailable."
    },
    {
      "text": "What action should a financial institution consider when all RegTech providers are simultaneously unavailable?",
      "options": ["Continue onboarding normally using internal data only", "Pause new onboarding until external providers recover, as internal lists cannot replace full PEP and adverse media coverage", "Switch to manual screening for all new customers", "File a regulatory exemption notice with FinCEN"],
      "correct": 1,
      "explanation": "When all external providers are down, internal OFAC/HMT/EU consolidated lists provide partial coverage — but cannot replace PEP database depth or real-time adverse media monitoring. Many institutions' documented policy is to pause new onboarding when all providers are unavailable, to avoid creating compliance gaps that need remediation later."
    },
    {
      "text": "Why is batch SFTP ingestion preferred over per-call API requests for periodic re-screening of large customer populations?",
      "options": ["SFTP transfers are more secure than REST API calls", "Batch SFTP ingestion is 10-20x cheaper than per-call API pricing and avoids per-request rate limits when re-screening hundreds of thousands of customers", "SFTP results are more accurate than real-time API responses", "Real-time APIs cannot handle the volume required for periodic re-screening"],
      "correct": 1,
      "explanation": "Per-call API pricing at $0.01-0.05 per screening call means re-screening 500,000 customers costs $5,000-$25,000 per batch. Batch SFTP typically costs a flat monthly fee plus a much lower per-record rate. For periodic re-screening, the cost difference is 10-20x, making SFTP the economically rational choice for large customer populations."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Resilient RegTech Integration Layer",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Implement the WorldCheckScreeningService with a circuit breaker (open at 50% failure rate over 10 calls, half-open after 60 seconds) and a @Retry decorator (3 retries with exponential backoff: 100ms, 200ms, 400ms). The fallback when the circuit is open must route to the ComplyAdvantage secondary provider."},
    {"id": "2", "description": "Implement the ScreeningCacheService that caches screening results with two TTLs: 4 hours for a matched result (re-verify sooner if a potential hit is found) and 24 hours for a no-match result. The cache key must be a hash of the entity name + date of birth + nationality to handle name variations. Implement cache invalidation triggered by daily watchlist refresh events on a Kafka topic."},
    {"id": "3", "description": "Implement the RegTechVendorHealthMonitor @Scheduled component that checks circuit breaker states every minute. When the primary provider's circuit is OPEN, emit a WARNING alert. When ALL providers' circuits are OPEN simultaneously, emit a CRITICAL alert and invoke onboardingGate.pause() to halt new customer onboarding with a documented reason."},
    {"id": "4", "description": "Implement the ProviderSelectionStrategy that routes screening requests based on request type: ONBOARDING routes to real-time REST API (primary then secondary), BATCH_PERIODIC routes to SFTP batch, EVENT_TRIGGERED routes to real-time with stricter fallback policy. Write an integration test using WireMock to simulate the primary provider returning 503 errors and verify the fallback to the secondary provider activates correctly."}
  ]
}
-->
