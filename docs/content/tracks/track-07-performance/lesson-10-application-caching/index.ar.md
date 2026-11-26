---
id: track-07-lesson-10
title: "التخزين المؤقت في التطبيق — الاستراتيجيات والإبطال وTTL"
slug: application-caching
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 10
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [caching, Cache-Aside, Write-Through, TTL, invalidation]
prerequisites: [track-07-lesson-09]
---

# التخزين المؤقت في التطبيق — الاستراتيجيات والإبطال وTTL

> [!NOTE]
> التخزين المؤقت في الأنظمة المالية ليس حيلة أداء — بل مفاضلة في الصحة. فتقديم بيانات قديمة لرصيد حساب قد يسبب سحبًا على المكشوف. وتقديم أسعار صرف قديمة قد يسيء تسعير الصفقات. ويجب تبرير كل قرار تخزين مؤقت في التقنية المالية بتحليل مكتوب لأسوأ أثر للتقادم.

## 1. نظرة عامة على أنماط التخزين المؤقت

### ‏Cache-Aside (التحميل الكسول)

يدير التطبيق الذاكرة المؤقتة صراحة. فعند الإخفاق، يحمّل التطبيق من قاعدة البيانات ويملأ الذاكرة المؤقتة.

```
Request -> Cache? -> HIT  -> return cached value
                 -> MISS  -> load from DB -> write to cache -> return
```

**المزايا**: لا يخزّن إلا البيانات المطلوبة فعلًا؛ ولا تحتفظ الذاكرة المؤقتة ببيانات قديمة للعناصر نادرة الوصول.
**العيوب**: أول طلب بعد انتهاء الصلاحية يدفع دائمًا كلفة جولة قاعدة البيانات (قفزة زمن البدء البارد).

### ‏Write-Through (الكتابة المارّة)

كل كتابة تذهب إلى الذاكرة المؤقتة وقاعدة البيانات معًا بشكل متزامن.

```
Write -> DB (synchronous) + Cache (synchronous) -> return success
Read  -> Cache -> usually HIT (unless the entry was evicted or expired)
```

**المزايا**: الذاكرة المؤقتة متوافقة غالبًا مع قاعدة البيانات؛ ولا إخفاقات بدء بارد للبيانات المكتوبة حديثًا. (لكنهما كتابتان منفصلتان: إذا فشلت إحداهما، أو تسابق كاتبان، فقد تختلف الذاكرة المؤقتة وقاعدة البيانات — فأبقِ TTL كشبكة أمان.)
**العيوب**: يزيد زمن الكتابة (كتابتان لكل تعديل)؛ وتمتلئ الذاكرة المؤقتة ببيانات قد لا تُقرأ أبدًا.

### ‏Write-Behind (الكتابة المؤجلة)

تذهب الكتابات إلى الذاكرة المؤقتة فورًا وتُفرَّغ إلى قاعدة البيانات بشكل غير متزامن.

```
Write -> Cache (immediate) -> async flush to DB -> return success (fast)
```

**المزايا**: زمن كتابة منخفض جدًا.
**العيوب**: خطر فقد البيانات إذا فشلت عقدة الذاكرة المؤقتة قبل التفريغ؛ وغير مناسب للمعاملات المالية التي تتطلب الديمومة.

**الاستخدام في التقنية المالية**: الكتابة المؤجلة مقبولة فقط للمقاييس غير الحرجة (أعداد المشاهدات، وأحداث التحليلات). ولا تستخدمها أبدًا للقيم النقدية.

### ‏Read-Through (القراءة المارّة)

تتولى طبقة الذاكرة المؤقتة تحميل قاعدة البيانات بشفافية — فالتطبيق يتحدث إلى الذاكرة المؤقتة فقط.

```
Request -> Cache -> HIT  -> return
                -> MISS  -> Cache loads from DB automatically -> return
```

**المزايا**: شيفرة التطبيق أبسط؛ ومكتبة الذاكرة المؤقتة تتولى التفاعل مع قاعدة البيانات.
**العيوب**: يتطلب مكتبة ذاكرة مؤقتة تدعم القراءة المارّة (Ehcache، أو Caffeine مع مُحمِّل، أو Infinispan).

## 2. تجريد Spring Cache

يوفر تجريد التخزين المؤقت في Spring واجهة موحدة فوق أي تنفيذ للذاكرة المؤقتة.

### الاعتمادية والإعداد

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

    // L1: Caffeine (in-process, sub-microsecond access).
    // With TWO cache managers, mark one @Primary and name the other in
    // @Cacheable(cacheManager = "redisCacheManager", ...)
    @Bean
    @Primary
    public CaffeineCacheManager caffeineCacheManager() {
        CaffeineCacheManager manager = new CaffeineCacheManager();
        manager.setCaffeine(Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofSeconds(60))
            .recordStats());
        return manager;
    }

    // L2: Redis (distributed, ~millisecond access, survives restarts)
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
            .transactionAware()   // puts/evicts inside a transaction run AFTER commit
            .build();
    }
}
```

### ‏@Cacheable — نمط Cache-Aside

```java
@Service
@Slf4j
public class ExchangeRateService {

    private final ExchangeRateRepository rateRepository;

    /**
     * Exchange rates: cached 60 seconds.
     * Business justification: our provider publishes at most once per minute.
     * Worst-case staleness: 60 seconds.
     * Acceptable for FX display, NOT for trade execution.
     */
    @Cacheable(
        cacheNames = "exchange-rates",
        cacheManager = "redisCacheManager",
        key = "#baseCurrency + ':' + #quoteCurrency",
        unless = "#result == null"
    )
    public ExchangeRate getRate(String baseCurrency, String quoteCurrency) {
        log.debug("Cache miss: loading rate {}/{} from DB", baseCurrency, quoteCurrency);
        return rateRepository.findLatest(baseCurrency, quoteCurrency)
            .orElseThrow(() -> new RateNotFoundException(baseCurrency, quoteCurrency));
    }

    /**
     * @CachePut: write the new value to the cache as well as the DB.
     * This is NOT atomic. Without a transaction-aware cache, the put can happen
     * before the DB commit -- if the commit then fails, the cache holds a rate
     * that was never stored. The transactionAware() Redis manager above defers
     * the put until after commit.
     */
    @CachePut(
        cacheNames = "exchange-rates",
        cacheManager = "redisCacheManager",
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
        cacheManager = "redisCacheManager",
        key = "#baseCurrency + ':' + #quoteCurrency"
    )
    public void deactivatePair(String baseCurrency, String quoteCurrency) {
        rateRepository.deactivate(baseCurrency, quoteCurrency);
    }

    /**
     * Evict all exchange rates (e.g., after bulk rate update from provider).
     */
    @CacheEvict(cacheNames = "exchange-rates", cacheManager = "redisCacheManager", allEntries = true)
    public void invalidateAllRates() {
        log.info("Invalidating all cached exchange rates");
    }
}
```

### ‏@Cacheable مع condition وunless

```java
@Service
public class AccountMetadataService {

    /**
     * Account metadata: cached 300 seconds.
     * Includes: account_number, customer_id, currency, account_type.
     * Does NOT include balance (live data — never cache).
     *
     * condition: skip the cache entirely for a null id
     * unless: don't cache null results (account not found) or CLOSED accounts
     *         (status is an enum, so compare its name)
     */
    @Cacheable(
        cacheNames = "account-metadata",
        key = "#accountId",
        condition = "#accountId != null",
        unless = "#result == null || #result.status.name() == 'CLOSED'"
    )
    public AccountMetadata getMetadata(UUID accountId) {
        return accountRepository.findMetadataById(accountId)
            .orElse(null);
    }

    /**
     * When an account's metadata changes (e.g., currency change, type upgrade),
     * evict to prevent stale reads. Careful: without a transaction-aware cache
     * the evict can run BEFORE the commit, and a concurrent read can reload
     * the OLD row and cache it for 300 s. Prefer evicting after commit
     * (transactionAware() or the event listener in section 7).
     */
    @CacheEvict(cacheNames = "account-metadata", key = "#accountId")
    @Transactional
    public void updateMetadata(UUID accountId, AccountMetadataUpdate update) {
        accountRepository.updateMetadata(accountId, update);
    }
}
```

## 3. تصميم TTL للبيانات المالية

يجب أن تقود خياراتِ TTL نافذةُ التقادم المقبولة لكل نوع بيانات.

| نوع البيانات | TTL | المبرر | خطر التقادم |
|---|---|---|---|
| أسعار الصرف (العرض) | ‏60 ثانية | المزود ينشر مرة في الدقيقة على الأكثر | عرض الصرف يُظهر سعرًا قديمًا |
| أسعار الصرف (التنفيذ) | ‏0 ثانية | لا تخزين — دائمًا حي للصفقات | تسعير صفقة خاطئ |
| بيانات وصف الحساب | ‏300 ثانية | التغييرات نادرة (ترقيات الحساب) | عرض عملة خاطئة |
| جداول الرسوم | ‏3600 ثانية | يحدّثها مسؤول، لا آليًا | عرض رسوم خاطئة |
| قوائم الدول/العملات | ‏86400 ثانية | بيانات مرجعية ثابتة | عملة جديدة مفقودة |
| رصيد الحساب | ‏0 ثانية | لا تخزين أبدًا — دائمًا من قاعدة البيانات | سحب على المكشوف، احتيال |
| حالة المعاملة | ‏0 ثانية | لا تخزين أبدًا — العملاء والعمليات يتصرفون بناءً عليها | عرض حالة خاطئة، إعادات محاولة مكررة |
| علامات الامتثال | ‏0 ثانية | لا تخزين أبدًا — متطلب فوري | معالجة معاملة محجوبة |

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

## 4. منع تدافع الذاكرة المؤقتة (Cache Stampede)

يحدث تدافع الذاكرة المؤقتة (ويسمى أيضًا "القطيع الهائج") حين ينتهي مدخل شائع وتخفق طلبات متزامنة كثيرة معًا، فتسبب اندفاعًا مفاجئًا من استعلامات قاعدة البيانات.

### توضيح المشكلة

```
T=0:      Cache entry expires for exchange rate USD/EUR
T=0+1ms:  500 concurrent requests all get a cache miss
T=0+2ms:  500 DB queries execute simultaneously
T=0+100ms: DB overloads, payment processing slows
```

### الحل 1: الانتهاء المبكر الاحتمالي (PER)

مع اقتراب الانتهاء، تحدّث نسبة صغيرة عشوائية من الطلبات المدخل مبكرًا، فيُعاد تحميل الذاكرة المؤقتة بواسطة مستدعٍ واحد قبل أن تنتهي للجميع. (هذه خوارزمية "XFetch".)

```java
@Service
public class ProbabilisticCacheService {

    private final RedisTemplate<String, String> redis;
    private final ObjectMapper objectMapper;

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
            double jitter = -beta * deltaSeconds * Math.log(ThreadLocalRandom.current().nextDouble());
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

### الحل 2: الطيران الواحد (دمج الطلبات)

تأكد من أن خيطًا واحدًا فقط ينفذ استعلام قاعدة البيانات لمفتاح معين — وينتظر الآخرون نتيجته.

```java
@Component
public class SingleFlightCache {

    private final ConcurrentHashMap<String, CompletableFuture<Object>> inFlight =
        new ConcurrentHashMap<>();
    private final Cache l2Cache;

    public SingleFlightCache(Cache l2Cache) {
        this.l2Cache = l2Cache;
    }

    @SuppressWarnings("unchecked")
    public <T> CompletableFuture<T> get(String key,
                                         Supplier<CompletableFuture<T>> loader) {
        // Check L2 cache first
        ValueWrapper cached = l2Cache.get(key);
        if (cached != null) {
            return CompletableFuture.completedFuture((T) cached.get());
        }

        // Only ONE caller installs a placeholder future for this key
        CompletableFuture<Object> mine = new CompletableFuture<>();
        CompletableFuture<Object> existing = inFlight.putIfAbsent(key, mine);
        if (existing != null) {
            return (CompletableFuture<T>) existing;      // join the load in progress
        }

        // We are the loader. Start it OUTSIDE the map operation: a loader that
        // completes immediately would otherwise modify the map from inside
        // computeIfAbsent, which ConcurrentHashMap forbids.
        loader.get().whenComplete((value, ex) -> {
            if (ex == null && value != null) {
                l2Cache.put(key, value);
            }
            inFlight.remove(key, mine);                  // only remove OUR entry
            if (ex != null) mine.completeExceptionally(ex); else mine.complete(value);
        });
        return (CompletableFuture<T>) mine;
    }
}
// Note: this coalesces loads within ONE JVM. Across many instances, each
// instance may still load once -- usually acceptable; otherwise use a
// short-lived distributed lock or early refresh.
```

### الحل 3: التحديث في الخلفية مع Caffeine

قدّم البيانات القديمة أثناء التحديث غير المتزامن. ويدعم Caffeine هذا أصلًا.

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

## 5. التخزين المؤقت متعدد المستويات (L1 ‏Caffeine + L2 ‏Redis)

يوفر L1 (داخل العملية) وصولًا في أقل من ميكروثانية. ويتشارك L2 ‏(Redis) بين كل النسخ.

**المشكلة**: لكل نسخة L1 خاص بها. فحين تُخلي نسخة مفتاحًا أو تحدّثه، تبقى نسخ L1 في النسخ الأخرى قديمة حتى ينتهي TTL الخاص بـ L1 لديها. فأبقِ TTL للمستوى L1 قصيرًا، و/أو أذِع رسائل الإبطال (مثلًا عبر Redis pub/sub) كي تُسقط كل نسخة مدخل L1 لديها.

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
        return new TwoLevelCacheManager(factory);   // creates TwoLevelCache per name (not shown)
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
        l1.invalidate(key);      // only THIS instance's L1 --
        l2.evict(key);           // publish an invalidation message for the others
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

## 6. ما لا يجب تخزينه مؤقتًا في الأنظمة المالية

### الأرصدة الحية — لا تخزين أبدًا

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
     * - Make the authorisation check an atomic conditional update on the
     *   primary (UPDATE ... SET balance = balance - ? WHERE balance >= ?)
     * - Optimistic locking to reduce contention
     * - Balance ledger optimisation (track 05)
     * - Read replicas ONLY for display/history: replica lag is staleness too,
     *   so never authorise against a replica
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

### علامات الامتثال ومكافحة غسل الأموال — لا تخزين أبدًا

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

## 7. إبطال الذاكرة المؤقتة بأحداث النطاق

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

## 8. تسخين الذاكرة المؤقتة عند البدء

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

## 9. المقاييس والقابلية للمراقبة

```java
@Component
@Slf4j
public class CacheMetricsCollector {

    private final CacheManager cacheManager;

    // Metrics: Spring Boot Actuator already binds Caffeine statistics
    // (cache.gets{result=hit|miss}, cache.evictions, cache.load.duration ...)
    // for caches that exist at startup and were built with recordStats().
    // Compute hit rates in Prometheus/Grafana from those counters.
    // (Do NOT call metrics.gauge(name, tags, doubleValue) on a schedule: it
    // registers a boxed number once and never updates it.)

    public CacheMetricsCollector(CacheManager cacheManager) {
        this.cacheManager = cacheManager;
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
                // Note: stats() is cumulative since start -- a recent drop
                // shows up slowly. Prefer a rate-based alert in Prometheus.
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

## 10. اختبار سلوك الذاكرة المؤقتة

```java
@SpringBootTest
@TestPropertySource(properties = {
    "spring.cache.type=caffeine",
    "spring.cache.caffeine.spec=maximumSize=100,expireAfterWrite=10s"
})
class ExchangeRateCacheTest {

    @Autowired
    private ExchangeRateService exchangeRateService;

    @MockBean   // @MockitoBean on Spring Boot 3.4+
    private ExchangeRateRepository rateRepository;

    @MockBean
    private AccountRepository accountRepository;

    @Autowired
    private BalanceService balanceService;

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

        // Update (@CachePut replaces the cached value)
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

## 11. الخلاصة — مصفوفة قرار التخزين المؤقت في التقنية المالية

قبل تخزين أي بيانات مؤقتًا في نظام مالي، أجب عن هذه الأسئلة الخمسة:

1. **ما أسوأ عاقبة لتقديم بيانات قديمة؟**
   - خسارة مالية أو خطر سحب على المكشوف: لا تخزّن
   - عدم دقة في العرض فقط: خزّن بـ TTL قصير

2. **كم مرة تتغير هذه البيانات؟**
   - نادرًا (بيانات مرجعية): TTL طويل مقبول
   - كثيرًا (الأسعار، والأرصدة): TTL قصير جدًا أو بلا تخزين

3. **هل يوجد متطلب رقابي للدقة الفورية؟**
   - علامات AML، وحالة الامتثال، والعقوبات: لا تخزين أبدًا
   - سجل المعاملات (مسار التدقيق): لا تخزّن الحالة الحية أبدًا

4. **هل تُدخل الذاكرة المؤقتة مخاطر تزامن؟**
   - حالة مشتركة عبر نسخ الخدمة: تتطلب Redis، لا L1 وحده
   - رصيد تحت معاملات متزامنة: لا تخزين أبدًا

5. **كيف ستُبطَل الذاكرة المؤقتة حين تتغير البيانات؟**
   - إن لم تستطع الإجابة بوضوح: أعد النظر في اختيار TTL

> [!WARNING]
> حوادث الذاكرة المؤقتة في الأنظمة المالية كثيرًا ما تكون غير مرئية أثناء الاختبار ومدمرة في الإنتاج. ووثّق كل قرار تخزين مؤقت مع مبرر اختيار TTL في تعليقات الشيفرة وسجلات القرارات المعمارية.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا يجب ألا تُخزّن أرصدة الحسابات مؤقتًا أبدًا في خدمة دفع، حتى بـ TTL قصير جدًا؟",
      "options": [
        "الأرصدة تتغير كثيرًا جدًا بحيث يستحيل تقنيًا تخزينها مؤقتًا",
        "تقديم رصيد قديم قد يسمح بالسحب على المكشوف أو الإنفاق المزدوج — وأسوأ عاقبة خسارة مالية مباشرة، ما يجعل أي خطر تقادم غير مقبول",
        "استعلامات الرصيد في PostgreSQL سريعة بما يكفي فلا فائدة من التخزين المؤقت",
        "القواعد الرقابية تحظر تخزين البيانات المالية مؤقتًا في كل الولايات القضائية"
      ],
      "correct": 1,
      "explanation": "إذا أظهر رصيد مخزن قديم أموالًا كافية بينما الرصيد الحقيقي غير كافٍ، فقد ينجح تفويض دفع خطأً، فيسبب سحبًا على المكشوف أو خسارة احتيال. وحتى TTL مدته ثانية واحدة خطير تحت التحويلات المتزامنة. ويجب أن تقرأ قرارات التفويض قاعدة البيانات الأساسية تحت قفل (SELECT ... FOR UPDATE) أو تستخدم تحديثًا شرطيًا ذريًا (UPDATE ... WHERE balance >= amount) — لا ذاكرة مؤقتة أبدًا ولا نسخة قراءة متأخرة."
    },
    {
      "text": "ما تدافع الذاكرة المؤقتة (القطيع الهائج) وكيف يمنعه الانتهاء المبكر الاحتمالي؟",
      "options": [
        "يحدث التدافع حين تنتهي مدخلات كثيرة جدًا معًا؛ والانتهاء المبكر الاحتمالي يعيد ترتيب ملء الذاكرة أبجديًا",
        "يحدث التدافع حين تخفق طلبات متزامنة كثيرة في مدخل انتهى للتو وتضرب قاعدة البيانات معًا؛ والانتهاء المبكر الاحتمالي يطلق تحديث الذاكرة المؤقتة قبل الانتهاء بقليل لمجموعة فرعية عشوائية من الطلبات، فيسخّنها قبل التدافع",
        "التدافع ظاهرة في Redis Cluster حيث تهاجر فتحات التجزئة معًا",
        "الانتهاء الاحتمالي يُسقط القيم المخزنة عشوائيًا لمنع فيضان الذاكرة"
      ],
      "correct": 1,
      "explanation": "حين ينتهي مدخل شائع، فكل الطلبات المتزامنة التي تصل في النافذة قبل اكتمال أول تحديث ستخفق وتستعلم قاعدة البيانات معًا. والانتهاء المبكر الاحتمالي (خوارزمية XFetch) يجعل بعض الطلبات تحدّث الذاكرة المؤقتة قبل انتهاء TTL بقليل باحتمال يتناسب مع قرب المدخل من الانتهاء، فيوزع حمل التحديث."
    },
    {
      "text": "ما استراتيجية التخزين المؤقت الصحيحة لأسعار الصرف الإرشادية المعروضة في تطبيق العميل (لا السعر المطبق فعلًا على الدفعة)؟",
      "options": [
        "لا تخزّن أسعار الصرف أبدًا؛ واجلب دائمًا أسعارًا حية لكل معاملة",
        "خزّن بـ TTL قصير (60–300 ثانية) مع تحديث في الخلفية لمنع التدافع — فالأسعار الإرشادية القديمة تجعل العرض قديمًا قليلًا فقط، بينما يأتي السعر المطبق فعلًا من عرض سعر حي مثبّت",
        "خزّن أسعار الصرف إلى أجل غير مسمى مع @CacheEvict عند تحديثات مزود الأسعار فقط",
        "خزّن أسعار الصرف في heap التطبيق فقط (لا Redis أبدًا) لتجنب زمن الشبكة"
      ],
      "correct": 1,
      "explanation": "الأسعار الإرشادية المعروضة على الشاشة تتحمل ثوانيَ إلى دقائق من التقادم: والأثر عرض قديم قليلًا. فـ TTL قصير مع تحديث في الخلفية مناسب. أما السعر المستخدم لتحويل الدفعة وتحصيلها فمختلف: يجب أن يأتي من خدمة تسعير حية كعرض سعر بمدة صلاحية يقبله العميل — لا من ذاكرة العرض هذه أبدًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "إعداد ذاكرة Caffeine المؤقتة لخدمة دفع متعددة العملات",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "نفّذ صنف CacheConfiguration بمواصفات Caffeine لثلاثة أنواع ذاكرة مؤقتة: أسعار الصرف (TTL قصير، refreshAfterWrite)، والبيانات المرجعية مثل العملات المدعومة (TTL طويل، حجم كبير)، وعتبات قواعد الاحتيال (TTL متوسط، تُبطل عند تحديث القواعد)."},
    {"id": "2", "description": "اكتب مكوّن Spring باسم CacheMetricsReporter يسجّل إحصاءات ذاكرة Caffeine (نسبة الإصابة، ونسبة الإخفاق، وعدد الإخلاءات، وزمن التحميل) في Micrometer ويسجّل تحذيرًا حين تنخفض نسبة الإصابة تحت 80%."},
    {"id": "3", "description": "اكتب حالات اختبار لذاكرة أسعار الصرف تتحقق من: (أ) أن الاستدعاء الثاني يعيد القيمة المخزنة باستدعاء واحد لقاعدة البيانات، (ب) أن @CacheEvict عند تحديث السعر يجعل الاستدعاء التالي يعيد التحميل، (ج) أن خدمة الرصيد تستدعي قاعدة البيانات في كل استدعاء."},
    {"id": "4", "description": "وثّق قرار التخزين المؤقت لكل من أنواع البيانات التالية مع مبرر TTL: رصيد الحساب، وسعر الصرف، وقواعد الاحتيال، وعلامات AML، ورموز فئات التجار، وطرق الدفع المدعومة."}
  ]
}
-->
