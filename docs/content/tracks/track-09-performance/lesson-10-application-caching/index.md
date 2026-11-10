---
id: track-09-lesson-10
title: "Application Caching — Strategies, Invalidation, and TTL"
slug: application-caching
track: track-09
trackName: "Performance Engineering"
sequence: 10
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [caching, Cache-Aside, Write-Through, TTL, invalidation]
prerequisites: [track-09-lesson-09]
---

# Application Caching — Strategies, Invalidation, and TTL

> [!NOTE]
> Caching in financial systems is not a performance trick — it is a correctness tradeoff. Serving stale data for an account balance can cause overdrafts. Serving stale exchange rates can mis-price trades. Every cache decision in fintech must be justified by a written analysis of the worst-case staleness impact.

## 1. Caching Patterns Overview

### Cache-Aside (Lazy Loading)

The application manages the cache explicitly. On a cache miss, the application loads from the database and populates the cache.

```
Request -> Cache? -> HIT  -> return cached value
                 -> MISS  -> load from DB -> write to cache -> return
```

**Pros**: Only caches data that is actually requested; cache does not hold stale data for rarely accessed items.
**Cons**: First request after expiry always pays the DB round-trip cost (cold start latency spike).

### Write-Through

Every write goes to both the cache and the database synchronously.

```
Write -> DB (synchronous) + Cache (synchronous) -> return success
Read  -> Cache -> always HIT (data was written there)
```

**Pros**: Cache always consistent with DB; no cold-start misses for recently written data.
**Cons**: Write latency increases (two writes per mutation); cache fills with data that may never be read.

### Write-Behind (Write-Back)

Writes go to the cache immediately and are asynchronously flushed to the database.

```
Write -> Cache (immediate) -> async flush to DB -> return success (fast)
```

**Pros**: Very low write latency.
**Cons**: Risk of data loss if cache node fails before flush; not suitable for financial transactions where durability is required.

**Use in fintech**: Write-behind is acceptable only for non-critical metrics (view counts, analytics events). Never use for monetary values.

### Read-Through

The cache layer handles DB loading transparently — the application only talks to the cache.

```
Request -> Cache -> HIT  -> return
                -> MISS  -> Cache loads from DB automatically -> return
```

**Pros**: Application code is simpler; cache library handles DB interactions.
**Cons**: Requires a cache library that supports read-through (Ehcache, Caffeine with a loader, Infinispan).

## 2. Spring Cache Abstraction

Spring's cache abstraction provides a unified API over any cache implementation.

### Dependency and Configuration

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
<dependency>
    <groupId>com.github.ben-manes.caffeine</groupId>
    <artifactId>caffeine</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

```java
@Configuration
@EnableCaching
public class CacheConfig {

    // L1: Caffeine (in-process, nanosecond access)
    @Bean
    public CaffeineSpec caffeineSpec() {
        return CaffeineSpec.parse(
            "maximumSize=10000,expireAfterWrite=60s,recordStats"
        );
    }

    // L2: Redis (distributed, millisecond access, survives restarts)
    @Bean
    public RedisCacheManager redisCacheManager(RedisConnectionFactory factory) {
        RedisCacheConfiguration defaultConfig = RedisCacheConfiguration.defaultCacheConfig()
            .serializeValuesWith(RedisSerializationContext.SerializationPair
                .fromSerializer(new GenericJackson2JsonRedisSerializer()))
            .disableCachingNullValues();

        Map<String, RedisCacheConfiguration> cacheConfigs = Map.of(
            "exchange-rates",    defaultConfig.entryTtl(Duration.ofSeconds(60)),
            "account-metadata",  defaultConfig.entryTtl(Duration.ofSeconds(300)),
            "fee-schedules",     defaultConfig.entryTtl(Duration.ofHours(1)),
            "country-data",      defaultConfig.entryTtl(Duration.ofDays(1))
        );

        return RedisCacheManager.builder(factory)
            .cacheDefaults(defaultConfig.entryTtl(Duration.ofSeconds(60)))
            .withInitialCacheConfigurations(cacheConfigs)
            .build();
    }
}
```

### @Cacheable — Cache-Aside Pattern

```java
@Service
@Slf4j
public class ExchangeRateService {

    private final ExchangeRateRepository rateRepository;

    /**
     * Exchange rates: cached 60 seconds.
     * Business justification: rates change at most once per minute from provider.
     * Worst-case staleness: 60 seconds.
     * Acceptable for FX display, NOT for trade execution.
     */
    @Cacheable(
        cacheNames = "exchange-rates",
        key = "#baseCurrency + ':' + #quoteCurrency",
        unless = "#result == null"
    )
    public ExchangeRate getRate(String baseCurrency, String quoteCurrency) {
        log.debug("Cache miss: loading rate {}/{} from DB", baseCurrency, quoteCurrency);
        return rateRepository.findLatest(baseCurrency, quoteCurrency)
            .orElseThrow(() -> new RateNotFoundException(baseCurrency, quoteCurrency));
    }

    /**
     * @CachePut: update both cache and DB atomically.
     * Used when rate provider pushes a new rate — cache is updated immediately.
     */
    @CachePut(
        cacheNames = "exchange-rates",
        key = "#rate.baseCurrency + ':' + #rate.quoteCurrency"
    )
    @Transactional
    public ExchangeRate updateRate(ExchangeRate rate) {
        ExchangeRate saved = rateRepository.save(rate);
        log.info("Exchange rate updated: {}/{} = {}",
            rate.getBaseCurrency(), rate.getQuoteCurrency(), rate.getMidRate());
        return saved;
    }

    /**
     * @CacheEvict: invalidate on currency pair deactivation.
     */
    @CacheEvict(
        cacheNames = "exchange-rates",
        key = "#baseCurrency + ':' + #quoteCurrency"
    )
    public void deactivatePair(String baseCurrency, String quoteCurrency) {
        rateRepository.deactivate(baseCurrency, quoteCurrency);
    }

    /**
     * Evict all exchange rates (e.g., after bulk rate update from provider).
     */
    @CacheEvict(cacheNames = "exchange-rates", allEntries = true)
    public void invalidateAllRates() {
        log.info("Invalidating all cached exchange rates");
    }
}
```

### @Cacheable with Condition and Unless

```java
@Service
public class AccountMetadataService {

    /**
     * Account metadata: cached 300 seconds.
     * Includes: account_number, customer_id, currency, account_type.
     * Does NOT include balance (live data — never cache).
     *
     * condition: only cache ACTIVE accounts (closed accounts won't be queried again)
     * unless: don't cache null results (account not found)
     */
    @Cacheable(
        cacheNames = "account-metadata",
        key = "#accountId",
        condition = "#accountId != null",
        unless = "#result == null || #result.status == 'CLOSED'"
    )
    public AccountMetadata getMetadata(UUID accountId) {
        return accountRepository.findMetadataById(accountId)
            .orElse(null);
    }

    /**
     * When an account's metadata changes (e.g., currency change, type upgrade),
     * evict immediately to prevent stale reads.
     */
    @CacheEvict(cacheNames = "account-metadata", key = "#accountId")
    @Transactional
    public void updateMetadata(UUID accountId, AccountMetadataUpdate update) {
        accountRepository.updateMetadata(accountId, update);
    }
}
```

## 3. TTL Design for Financial Data

TTL choices must be driven by the acceptable staleness window for each data type.

| Data Type | TTL | Rationale | Risk of Staleness |
|---|---|---|---|
| Exchange rates (display) | 60 s | Rates change at most per minute | FX display shows outdated rate |
| Exchange rates (execution) | 0 s | No caching — always live for trades | Incorrect trade pricing |
| Account metadata | 300 s | Changes are rare (account upgrades) | Wrong currency displayed |
| Fee schedules | 3600 s | Updated by admin, not automated | Wrong fee shown |
| Country/currency lists | 86400 s | Static reference data | Missing new currency |
| Account balance | 0 s | Never cache — always from DB | Overdraft, fraud |
| Transaction status | 0 s | Never cache — compliance requirement | Wrong status shown |
| Compliance flags | 0 s | Never cache — real-time requirement | Blocked transaction processed |

```java
// TTL constants — single source of truth
public final class CacheTtl {
    public static final Duration EXCHANGE_RATE_DISPLAY = Duration.ofSeconds(60);
    public static final Duration ACCOUNT_METADATA = Duration.ofSeconds(300);
    public static final Duration FEE_SCHEDULE = Duration.ofHours(1);
    public static final Duration REFERENCE_DATA = Duration.ofDays(1);

    // These should NEVER be cached — constants as documentation
    public static final Duration ACCOUNT_BALANCE = Duration.ZERO;    // no cache
    public static final Duration TRANSACTION_STATUS = Duration.ZERO; // no cache
    public static final Duration COMPLIANCE_FLAG = Duration.ZERO;    // no cache

    private CacheTtl() {}
}
```

## 4. Cache Stampede Prevention

A cache stampede (also called "thundering herd") occurs when a popular cache entry expires and many concurrent requests all miss the cache simultaneously, causing a sudden burst of DB queries.

### Problem Illustration

```
T=0:      Cache entry expires for exchange rate USD/EUR
T=0+1ms:  500 concurrent requests all get a cache miss
T=0+2ms:  500 DB queries execute simultaneously
T=0+100ms: DB overloads, payment processing slows
```

### Solution 1: Probabilistic Early Expiry (PER)

Randomly extend TTL for a small fraction of requests as expiry approaches, so the cache is refreshed proactively before it expires for all requests.

```java
@Service
public class ProbabilisticCacheService {

    private final RedisTemplate<String, String> redis;
    private final ObjectMapper objectMapper;
    private final Random random = new Random();

    /**
     * Probabilistic Early Expiry (PER) algorithm.
     * Recomputes cache entry before expiry with probability proportional
     * to how close the entry is to its TTL.
     *
     * beta: controls aggressiveness (beta=1 is standard)
     * delta: expected recomputation time in seconds
     */
    public <T> T getWithPER(String key, Duration ttl,
                             double beta, double deltaSeconds,
                             Supplier<T> loader,
                             Class<T> type) {
        String stored = redis.opsForValue().get(key);

        if (stored != null) {
            CacheEntry<T> entry = deserialize(stored, type);
            double expiryEpoch = entry.getExpiryEpochSeconds();
            double ttlRemaining = expiryEpoch - Instant.now().getEpochSecond();

            // Should we refresh early?
            double jitter = -beta * deltaSeconds * Math.log(random.nextDouble());
            if (ttlRemaining > jitter) {
                return entry.getValue(); // return cached value
            }
        }

        // Cache miss or probabilistic early refresh
        T value = loader.get();
        double newExpiry = Instant.now().getEpochSecond() + ttl.getSeconds();
        CacheEntry<T> entry = new CacheEntry<>(value, newExpiry);
        redis.opsForValue().set(key, serialize(entry), ttl);
        return value;
    }
}
```

### Solution 2: Single-Flight (Request Coalescing)

Ensure only one thread executes the DB query for a given cache key — all others wait for the first result.

```java
@Component
public class SingleFlightCache {

    private final ConcurrentHashMap<String, CompletableFuture<?>> inFlight =
        new ConcurrentHashMap<>();
    private final Cache l2Cache;

    @SuppressWarnings("unchecked")
    public <T> CompletableFuture<T> get(String key,
                                         Supplier<CompletableFuture<T>> loader) {
        // Check L2 cache first
        ValueWrapper cached = l2Cache.get(key);
        if (cached != null) {
            return CompletableFuture.completedFuture((T) cached.get());
        }

        // If a load is in progress for this key, return the same future
        return (CompletableFuture<T>) inFlight.computeIfAbsent(key, k -> {
            CompletableFuture<T> future = loader.get();
            future.whenComplete((value, ex) -> {
                inFlight.remove(key);
                if (value != null) {
                    l2Cache.put(key, value);
                }
            });
            return future;
        });
    }
}
```

### Solution 3: Background Refresh with Caffeine

Serve stale data while refreshing asynchronously. Caffeine supports this natively.

```java
@Bean
public LoadingCache<String, ExchangeRate> exchangeRateCache(
        ExchangeRateRepository repository,
        Executor refreshExecutor) {

    return Caffeine.newBuilder()
        .maximumSize(500)
        .expireAfterWrite(Duration.ofSeconds(60))
        .refreshAfterWrite(Duration.ofSeconds(50))  // async refresh at 50s
        .executor(refreshExecutor)                   // use dedicated thread pool
        .recordStats()
        .build(key -> {
            String[] parts = key.split(":");
            return repository.findLatest(parts[0], parts[1])
                .orElseThrow(() -> new RateNotFoundException(key));
        });
}
```

## 5. Multi-Level Caching (L1 Caffeine + L2 Redis)

L1 (in-process) provides nanosecond access. L2 (Redis) provides distributed consistency.

```java
@Configuration
@EnableCaching
public class MultiLevelCacheConfig {

    /**
     * Multi-level cache: L1 (Caffeine, 1-10 microseconds) + L2 (Redis, 0.5-2ms)
     * Hierarchy:
     *   1. Check L1 (Caffeine, in-process) — fastest
     *   2. Check L2 (Redis, distributed) — fast, shared across instances
     *   3. Load from DB — slowest, but source of truth
     */
    @Bean
    public CacheManager cacheManager(RedisConnectionFactory factory) {
        return new TwoLevelCacheManager(factory);
    }
}

public class TwoLevelCache implements Cache {

    private final String name;
    private final com.github.benmanes.caffeine.cache.Cache<Object, Object> l1;
    private final Cache l2;
    private static final Object NULL_MARKER = new Object();

    @Override
    public ValueWrapper get(Object key) {
        // Try L1 first
        Object l1Value = l1.getIfPresent(key);
        if (l1Value != null) {
            return () -> l1Value == NULL_MARKER ? null : l1Value;
        }

        // Try L2
        ValueWrapper l2Value = l2.get(key);
        if (l2Value != null) {
            // Promote to L1
            l1.put(key, l2Value.get() != null ? l2Value.get() : NULL_MARKER);
            return l2Value;
        }

        return null;
    }

    @Override
    public void put(Object key, Object value) {
        l1.put(key, value != null ? value : NULL_MARKER);
        l2.put(key, value);
    }

    @Override
    public void evict(Object key) {
        l1.invalidate(key);
        l2.evict(key);
    }

    @Override
    public String getName() { return name; }

    @Override
    public Object getNativeCache() { return l1; }

    @Override
    public <T> T get(Object key, Class<T> type) {
        ValueWrapper wrapper = get(key);
        return wrapper != null ? type.cast(wrapper.get()) : null;
    }

    @Override
    public <T> T get(Object key, Callable<T> valueLoader) {
        ValueWrapper wrapper = get(key);
        if (wrapper != null) return (T) wrapper.get();
        try {
            T value = valueLoader.call();
            put(key, value);
            return value;
        } catch (Exception e) {
            throw new Cache.ValueRetrievalException(key, valueLoader, e);
        }
    }

    @Override
    public void clear() {
        l1.invalidateAll();
        l2.clear();
    }
}
```

## 6. What NOT to Cache in Financial Systems

### Live Balances — Never Cache

```java
@Service
public class BalanceService {

    private final AccountRepository accountRepository;

    /**
     * Balance is NEVER cached.
     *
     * Reasons:
     * 1. Overdraft risk: stale balance may show funds that have been spent
     * 2. Concurrency: multiple transactions modifying balance simultaneously
     * 3. Regulatory: some jurisdictions require real-time balance accuracy
     * 4. Fraud: fraudsters exploit balance cache windows to double-spend
     *
     * If balance reads are a bottleneck, the solution is:
     * - Read replicas (track-10-lesson-08)
     * - Optimistic locking to reduce contention
     * - Balance ledger optimization (track-06)
     * NOT caching.
     */
    // No @Cacheable annotation — this is intentional
    @Transactional(readOnly = true)
    public Money getBalance(UUID accountId) {
        return accountRepository.findBalanceById(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));
    }
}
```

### Compliance and AML Flags — Never Cache

```java
@Service
public class ComplianceCheckService {

    private final AmlFlagRepository amlRepository;

    /**
     * AML/compliance flags MUST be real-time.
     *
     * A 5-second stale cache window could allow:
     * - A newly flagged entity to complete a transaction
     * - A newly added sanction list entry to be bypassed
     *
     * Regulatory consequence: potential SAR failure, OFAC violation,
     * significant fines, license revocation.
     */
    // No @Cacheable — always live
    public ComplianceStatus checkEntity(String entityId) {
        return amlRepository.getCurrentStatus(entityId);
    }
}
```

## 7. Cache Invalidation with Domain Events

```java
@Component
public class AccountCacheInvalidator {

    private final CacheManager cacheManager;

    /**
     * When account metadata changes, invalidate cache via domain event.
     * Uses AFTER_COMMIT phase: cache is evicted only if the DB transaction committed.
     * This prevents cache inconsistency if the DB transaction rolls back.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onAccountUpdated(AccountUpdatedEvent event) {
        Cache metadataCache = cacheManager.getCache("account-metadata");
        if (metadataCache != null) {
            metadataCache.evict(event.getAccountId());
        }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onFeeScheduleUpdated(FeeScheduleUpdatedEvent event) {
        Cache feeCache = cacheManager.getCache("fee-schedules");
        if (feeCache != null) {
            feeCache.evict(event.getFeeScheduleId());
        }
    }
}
```

## 8. Cache Warming on Startup

```java
@Component
@Slf4j
public class CacheWarmingService implements ApplicationRunner {

    private final ExchangeRateService exchangeRateService;
    private final FeeScheduleService feeScheduleService;

    @Override
    public void run(ApplicationArguments args) {
        log.info("Starting cache warm-up");
        warmExchangeRates();
        warmFeeSchedules();
        log.info("Cache warm-up complete");
    }

    private void warmExchangeRates() {
        List<CurrencyPair> commonPairs = List.of(
            new CurrencyPair("USD", "EUR"),
            new CurrencyPair("USD", "GBP"),
            new CurrencyPair("EUR", "GBP"),
            new CurrencyPair("USD", "JPY"),
            new CurrencyPair("USD", "CAD")
        );

        commonPairs.forEach(pair ->
            exchangeRateService.getRate(pair.base(), pair.quote()));

        log.info("Warmed {} exchange rate pairs", commonPairs.size());
    }

    private void warmFeeSchedules() {
        feeScheduleService.loadAllActive();
    }
}
```

## 9. Metrics and Observability

```java
@Component
@Slf4j
public class CacheMetricsCollector {

    private final CacheManager cacheManager;
    private final MeterRegistry metrics;

    @Scheduled(fixedRate = 30_000)
    public void collectCacheMetrics() {
        cacheManager.getCacheNames().forEach(cacheName -> {
            Cache cache = cacheManager.getCache(cacheName);
            if (cache instanceof CaffeineCache caffeineCache) {
                CacheStats stats = caffeineCache.getNativeCache().stats();

                metrics.gauge("cache.hit_rate",
                    Tags.of("cache", cacheName), stats.hitRate());
                metrics.gauge("cache.miss_rate",
                    Tags.of("cache", cacheName), stats.missRate());
                metrics.gauge("cache.load_average_ms",
                    Tags.of("cache", cacheName),
                    stats.averageLoadPenalty() / 1_000_000.0);
                metrics.gauge("cache.eviction_count",
                    Tags.of("cache", cacheName), stats.evictionCount());
            }
        });
    }

    @Scheduled(fixedRate = 60_000)
    public void checkHitRateAlerts() {
        Map<String, Double> thresholds = Map.of(
            "exchange-rates",   0.90,
            "account-metadata", 0.80,
            "fee-schedules",    0.95
        );

        thresholds.forEach((cacheName, threshold) -> {
            Cache cache = cacheManager.getCache(cacheName);
            if (cache instanceof CaffeineCache cc) {
                double hitRate = cc.getNativeCache().stats().hitRate();
                if (hitRate < threshold) {
                    log.warn("Cache hit rate alert: {} hit_rate={} threshold={}",
                        cacheName, String.format("%.2f", hitRate),
                        String.format("%.2f", threshold));
                }
            }
        });
    }
}
```

## 10. Testing Cache Behavior

```java
@SpringBootTest
@TestPropertySource(properties = {
    "spring.cache.type=caffeine",
    "spring.cache.caffeine.spec=maximumSize=100,expireAfterWrite=10s"
})
class ExchangeRateCacheTest {

    @Autowired
    private ExchangeRateService exchangeRateService;

    @MockBean
    private ExchangeRateRepository rateRepository;

    @Autowired
    private CacheManager cacheManager;

    @BeforeEach
    void clearCaches() {
        cacheManager.getCacheNames()
            .forEach(name -> cacheManager.getCache(name).clear());
    }

    @Test
    void shouldReturnCachedRate_onSecondCall() {
        ExchangeRate rate = ExchangeRate.of("USD", "EUR", new BigDecimal("0.92"));
        given(rateRepository.findLatest("USD", "EUR")).willReturn(Optional.of(rate));

        ExchangeRate first = exchangeRateService.getRate("USD", "EUR");
        ExchangeRate second = exchangeRateService.getRate("USD", "EUR");

        assertThat(first).isEqualTo(second);
        verify(rateRepository, times(1)).findLatest("USD", "EUR");
    }

    @Test
    void shouldEvictCacheOnRateUpdate() {
        ExchangeRate initialRate = ExchangeRate.of("USD", "EUR", new BigDecimal("0.92"));
        ExchangeRate updatedRate = ExchangeRate.of("USD", "EUR", new BigDecimal("0.93"));

        given(rateRepository.findLatest("USD", "EUR"))
            .willReturn(Optional.of(initialRate))
            .willReturn(Optional.of(updatedRate));
        given(rateRepository.save(any())).willReturn(updatedRate);

        // Warm the cache
        exchangeRateService.getRate("USD", "EUR");

        // Update (should evict cache)
        exchangeRateService.updateRate(updatedRate);

        // Next call should return updated value
        ExchangeRate result = exchangeRateService.getRate("USD", "EUR");
        assertThat(result.getMidRate()).isEqualByComparingTo("0.93");
    }

    @Test
    void balanceServiceShouldNeverCache() {
        UUID accountId = UUID.randomUUID();
        given(accountRepository.findBalanceById(accountId))
            .willReturn(Optional.of(Money.of(new BigDecimal("1000"), "USD")));

        balanceService.getBalance(accountId);
        balanceService.getBalance(accountId);
        balanceService.getBalance(accountId);

        // DB must be called every time — no caching
        verify(accountRepository, times(3)).findBalanceById(accountId);
    }
}
```

## 11. Summary — Fintech Caching Decision Matrix

Before caching any data in a financial system, answer these five questions:

1. **What is the worst-case consequence of serving stale data?**
   - Financial loss or overdraft risk: do not cache
   - Display inaccuracy only: cache with short TTL

2. **How often does this data change?**
   - Changes rarely (reference data): long TTL acceptable
   - Changes frequently (rates, balances): very short TTL or no cache

3. **Is there a regulatory requirement for real-time accuracy?**
   - AML flags, compliance status, sanctions: never cache
   - Transaction history (audit trail): never cache live status

4. **Does the cache introduce concurrency hazards?**
   - Shared state across service instances: requires Redis, not L1 only
   - Balance under concurrent transactions: never cache

5. **How will the cache be invalidated when data changes?**
   - If you cannot answer this clearly: reconsider the TTL choice

> [!WARNING]
> Cache-related incidents in financial systems are often invisible during testing and devastating in production. Document every caching decision with the reasoning for the TTL choice in code comments and architecture decision records.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why should account balances never be cached in a payment service, even with a very short TTL?",
      "options": [
        "Balances change too frequently for caching to be technically feasible",
        "Serving a stale balance can allow overdrafts or double-spending — the worst-case consequence is a direct financial loss, which makes any staleness risk unacceptable",
        "PostgreSQL balance queries are fast enough that caching provides no benefit",
        "Regulatory rules prohibit caching of financial data in all jurisdictions"
      ],
      "correct": 1,
      "explanation": "If a stale cached balance shows sufficient funds when the real balance is insufficient, a payment authorization could succeed incorrectly, causing an overdraft or fraud loss. Even a 1-second TTL is dangerous under concurrent transfers. Balance reads must always go to the primary database with SELECT FOR UPDATE to get a consistent, locked value."
    },
    {
      "text": "What is cache stampede (thundering herd) and how does probabilistic early expiration prevent it?",
      "options": [
        "Cache stampede occurs when too many cache entries expire simultaneously; probabilistic early expiration reorders cache fills alphabetically",
        "Cache stampede occurs when many concurrent requests all miss a just-expired cache entry and simultaneously hit the database; probabilistic early expiration triggers cache refresh slightly before expiry for a random subset of requests, warming the cache before the stampede",
        "Cache stampede is a Redis Cluster phenomenon where hash slots migrate simultaneously",
        "Probabilistic expiration randomly drops cached values to prevent memory overflow"
      ],
      "correct": 1,
      "explanation": "When a popular cache entry expires, all concurrent requests that arrive in the window before the first refresh completes will miss and query the database simultaneously. Probabilistic early expiration (XFetch algorithm) makes some requests refresh the cache slightly before the TTL expires with probability proportional to how close to expiry the entry is, spreading the refresh load."
    },
    {
      "text": "What is the correct caching strategy for exchange rates used in payment authorization?",
      "options": [
        "Never cache exchange rates; always fetch live rates for every transaction",
        "Cache with a short TTL (60-300 seconds) and implement a background refresh to prevent stampede, since stale rates cause display inaccuracy but not financial loss on authorization",
        "Cache exchange rates indefinitely with @CacheEvict triggered only on rate provider updates",
        "Cache exchange rates in the application heap only (never Redis) to avoid network latency"
      ],
      "correct": 1,
      "explanation": "Exchange rates change infrequently (seconds to minutes between updates) and slight staleness causes display inaccuracy rather than direct financial loss on authorization. A short TTL with background refresh is appropriate. Final settlement uses confirmed rates from the payment network, not the cached display rate, so this risk profile is acceptable."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Caffeine Cache Configuration for a Multi-Currency Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Implement a CacheConfiguration class with Caffeine specs for three cache types: exchange rates (short TTL, refreshAfterWrite), reference data like supported currencies (long TTL, large size), and fraud rule thresholds (medium TTL, invalidated on rule updates)."},
    {"id": "2", "description": "Write a CacheMetricsReporter Spring component that registers Caffeine cache statistics (hit rate, miss rate, eviction count, load time) with Micrometer and logs a warning when hit rate drops below 80%."},
    {"id": "3", "description": "Write test cases for the exchange rate cache that verify: (a) second call returns cached value with one DB call, (b) @CacheEvict on rate update causes next call to reload, (c) balance service always calls DB on every invocation."},
    {"id": "4", "description": "Document the caching decision for each of the following data types with TTL rationale: account balance, exchange rate, fraud rules, AML flags, merchant category codes, supported payment methods."}
  ]
}
-->

