---
id: "track-02-lesson-08"
title: "Distributed Caching — Redis Cluster Architecture"
track: "track-02"
track-name: "Distributed Systems Engineering"
sequence: 8
slug: "distributed-caching"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"
prerequisites: []
tags: ["Redis", "distributed-cache", "cache-coherence", "cluster", "eviction"]
java-versions: [17, 21]
topics: ["Redis-cluster", "cache-aside", "cache-stampede", "eviction-policy", "cache-warming"]
components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true
references:
  - "Redis Ltd (2024). Redis Cluster Specification. redis.io/docs/reference/cluster-spec"
  - "Spring Framework (2024). Spring Data Redis — Lettuce Cluster. docs.spring.io"
  - "Nishtala, R. et al. (2013). Scaling Memcache at Facebook. NSDI 2013"
  - "Vaidya, N. (2022). Cache Stampede Prevention Patterns. engineering.grab.com"
---

Distributed caching is the single most effective technique for reducing database load in high-throughput financial systems. A payment service at 10,000 TPS hitting a PostgreSQL read replica directly is expensive; hitting a Redis cluster for 95% of those reads dramatically reduces database connection count, query execution time, and infrastructure cost. But caching in financial services carries unique risks: a stale cached balance can cause incorrect limit checks, a cache stampede during startup can overwhelm the database before any traffic has been served, and an eviction policy mismatch can cause critical data to be ejected at the worst possible moment. This lesson covers the architecture, patterns, and failure modes you need to operate Redis correctly in a fintech environment.

## Learning Objectives

- Explain Redis Cluster architecture including 16,384 hash slots and consistent sharding
- Distinguish Redis Sentinel (high availability) from Redis Cluster (sharding and HA combined)
- Configure `LettuceConnectionFactory` for a Redis Cluster in Spring Boot
- Implement the cache-aside pattern for account balance with correct invalidation on update
- Prevent cache stampedes using probabilistic early expiry and distributed locking
- Use `@Cacheable`, `@CacheEvict`, and `CacheManager` effectively in Spring
- Compare LRU, LFU, and TTL eviction policies and select the right one for financial data
- Implement a two-tier caching strategy (Redis L2 + local JVM L1) for hot key mitigation

## Business Context

Consider a composite example drawn from typical incidents. During a big seasonal promotion, a buy-now-pay-later provider restarts its Redis cluster for a configuration change, flushing all cached credit-limit data. A minute later, every application pod gets cache misses for the same tens of thousands of hot accounts — customers enrolled in the promotion — and all of them query the PostgreSQL read replica at once. The replica's 300-connection pool is saturated within seconds, the query queue grows into the thousands, and the replica starts timing out. Pods fall into retry loops against the database, and the degradation lasts more than 20 minutes until the cache slowly refills, with many checkouts declined. The post-incident review finds three missing safeguards: no cache warming before the restart, no protection against many keys expiring or missing at once, and no local in-process cache to absorb load for hot accounts.

## Redis Cluster Architecture

Redis Cluster partitions data across multiple nodes using **hash slots**. The key space is divided into 16,384 slots. Each key is assigned to a slot using `CRC16(key) % 16384`. Each node is responsible for a range of slots.

```
3-node cluster, each node owns ~5,461 slots:
Node A: slots 0–5460
Node B: slots 5461–10922
Node C: slots 10923–16383

Key "account:12345" → CRC16("account:12345") % 16384 = slot X → owner of X
(Use CLUSTER KEYSLOT account:12345 to see the real slot)

Keys "{acct:42}:balance" and "{acct:42}:limit" share the hash tag {acct:42},
so they land in the same slot and can be used together in MULTI or Lua.
```

Each node has at least one replica (secondary) for HA. If a primary node fails, its replica is promoted automatically.

```mermaid
graph TB
    C1[Client] --> P1[Primary A<br/>Slots 0-5460]
    C1 --> P2[Primary B<br/>Slots 5461-10922]
    C1 --> P3[Primary C<br/>Slots 10923-16383]

    P1 --- R1[Replica A]
    P2 --- R2[Replica B]
    P3 --- R3[Replica C]

    style P1 fill:#1e3a5f,color:#fff
    style P2 fill:#1e3a5f,color:#fff
    style P3 fill:#1e3a5f,color:#fff
    style R1 fill:#374151,color:#fff
    style R2 fill:#374151,color:#fff
    style R3 fill:#374151,color:#fff
```

### Redis Sentinel vs Cluster

| Feature | Redis Sentinel | Redis Cluster |
|---|---|---|
| Purpose | HA for single shard | HA + horizontal sharding |
| Sharding | No | Yes (16,384 hash slots) |
| Minimum nodes for HA | 3 Sentinels + 1 primary + 1 replica | 6 (3 primary + 3 replica) |
| Multi-key operations | Yes (single node) | Only within same hash slot |
| Use case | < 100GB dataset, simple setup | > 100GB or high write throughput |

## Spring Boot Redis Cluster Configuration

```java
@Configuration
public class RedisClusterConfig {

    @Value("${redis.cluster.nodes}")
    private List<String> clusterNodes; // ["redis1:6379","redis2:6379","redis3:6379"]

    @Bean
    public RedisConnectionFactory redisConnectionFactory() {
        RedisClusterConfiguration clusterConfig =
            new RedisClusterConfiguration(clusterNodes);
        clusterConfig.setMaxRedirects(3); // Allow 3 MOVED/ASK redirects

        LettuceClientConfiguration clientConfig = LettuceClientConfiguration.builder()
            // Read from primaries: a replica can still hold an entry that was just
            // deleted on its primary, re-serving a stale balance after invalidation.
            // REPLICA_PREFERRED is fine for data like FX rates or reference data.
            .readFrom(ReadFrom.UPSTREAM)
            .commandTimeout(Duration.ofMillis(500))
            .clientOptions(ClusterClientOptions.builder()
                .autoReconnect(true)
                .topologyRefreshOptions(
                    ClusterTopologyRefreshOptions.builder()
                        .enablePeriodicRefresh(Duration.ofSeconds(30))
                        .enableAllAdaptiveRefreshTriggers()
                        .build())
                .build())
            .build();

        return new LettuceConnectionFactory(clusterConfig, clientConfig);
    }

    @Bean
    public RedisTemplate<String, Object> redisTemplate(
            RedisConnectionFactory connectionFactory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setHashValueSerializer(new GenericJackson2JsonRedisSerializer());
        template.afterPropertiesSet();
        return template;
    }

    @Bean
    public CacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        RedisCacheConfiguration defaultConfig = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(5))
            .serializeKeysWith(
                RedisSerializationContext.SerializationPair.fromSerializer(
                    new StringRedisSerializer()))
            .serializeValuesWith(
                RedisSerializationContext.SerializationPair.fromSerializer(
                    new GenericJackson2JsonRedisSerializer()))
            .disableCachingNullValues();

        // Per-cache TTL overrides
        Map<String, RedisCacheConfiguration> cacheConfigs = Map.of(
            "account-balances", defaultConfig.entryTtl(Duration.ofSeconds(30)),
            "credit-limits",    defaultConfig.entryTtl(Duration.ofMinutes(10)),
            "fx-rates",         defaultConfig.entryTtl(Duration.ofMinutes(1))
        );

        return RedisCacheManager.builder(connectionFactory)
            .cacheDefaults(defaultConfig)
            .withInitialCacheConfigurations(cacheConfigs)
            .transactionAware()   // @CacheEvict inside a transaction runs after commit
            .build();
    }
}
```

## Cache-Aside Pattern for Account Balance

The cache-aside (lazy loading) pattern is the standard approach: the application checks the cache first; on a miss, it fetches from the database and populates the cache. On a write, it **deletes** the cache entry (never updates it) — after the transaction commits.

> [!IMPORTANT]
> A cached balance is for display only. Payment authorisation and limit checks must read the balance from the database (with a row lock), never from the cache.

```mermaid
sequenceDiagram
    participant App as Application
    participant Cache as Redis Cluster
    participant DB as PostgreSQL

    App->>Cache: GET account:balance:42
    alt Cache HIT
        Cache-->>App: "{ balance: 1500.00, version: 7 }"
        Note over App: Return cached value
    else Cache MISS
        Cache-->>App: null
        App->>DB: SELECT balance, version FROM accounts WHERE id = 42
        DB-->>App: { balance: 1500.00, version: 7 }
        App->>Cache: SET account:balance:42 { ... } EX 30
        App-->>App: Return value from DB
    end

    Note over App: On balance update:
    App->>DB: UPDATE accounts SET balance = 1400.00 WHERE id = 42
    App->>Cache: DEL account:balance:42
    Note over Cache: Next read will re-populate from DB
```

```java
@Service
public class AccountBalanceService {

    private final AccountRepository accountRepository;
    private final RedisTemplate<String, AccountBalance> redisTemplate;

    private static final String BALANCE_KEY_PREFIX = "account:balance:";
    private static final Duration BALANCE_TTL = Duration.ofSeconds(30);

    public AccountBalance getBalance(long accountId) {
        String key = BALANCE_KEY_PREFIX + accountId;

        // 1. Check cache
        AccountBalance cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return cached;
        }

        // 2. Cache miss — fetch from DB
        AccountBalance balance = accountRepository
            .findBalanceById(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));

        // 3. Populate cache — delete not update on next write
        redisTemplate.opsForValue().set(key, balance, BALANCE_TTL);
        return balance;
    }

    @Transactional
    public void updateBalance(long accountId, BigDecimal newBalance) {
        // Update DB first
        accountRepository.updateBalance(accountId, newBalance);

        // DELETE (not update) the cache entry — and only AFTER COMMIT.
        // Deleting inside the transaction would let a concurrent reader miss,
        // read the old (uncommitted-away) row, and re-cache the old balance.
        String key = BALANCE_KEY_PREFIX + accountId;
        TransactionSynchronizationManager.registerSynchronization(
            new TransactionSynchronization() {
                @Override public void afterCommit() { redisTemplate.delete(key); }
            });
        // A small race remains (a slow reader can write back an old value after
        // the delete); the short TTL bounds it. Some teams delete twice
        // ("delayed double delete") or version the cached value.
    }
}
```

> [!WARNING]
> Always delete (evict) cached entries after a write — never update them in-place. Updating a cached value before the database write commits creates a window where the cache holds a value that was never durably written. If the transaction rolls back, the cache is permanently wrong until TTL expiry.

## Cache Stampede Prevention

A cache stampede occurs when many concurrent requests all receive a cache miss at the same time (e.g., immediately after cache flush or TTL expiry of a popular key) and all simultaneously query the database.

### Strategy 1: Probabilistic Early Expiry

Recompute the cache entry slightly before it expires, staggered across requests using randomness (the "XFetch" algorithm). The closer the entry is to expiry, and the longer it takes to recompute, the more likely a request is to refresh it early — so usually exactly one request refreshes it before it expires.

```java
@Component
public class ProbabilisticCacheService {

    private final RedisTemplate<String, CacheEntry> redisTemplate;
    private final AccountRepository accountRepository;

    // Beta controls how aggressively to recompute early.
    // Higher beta = recompute earlier = safer but slightly more DB load.
    private static final double BETA = 1.0;

    public AccountBalance getBalanceWithEarlyExpiry(long accountId) {
        String key = "account:balance:" + accountId;
        CacheEntry entry = redisTemplate.opsForValue().get(key);

        if (entry == null || shouldRecomputeEarly(entry)) {
            long started = System.nanoTime();
            AccountBalance fresh = accountRepository.findBalanceById(accountId)
                .orElseThrow(() -> new AccountNotFoundException(accountId));
            long recomputeMillis = (System.nanoTime() - started) / 1_000_000;

            Duration ttl = Duration.ofSeconds(30);
            CacheEntry newEntry = new CacheEntry(
                fresh,
                Instant.now().plus(ttl),   // expiresAt
                recomputeMillis            // how long a refresh takes (delta)
            );
            redisTemplate.opsForValue().set(key, newEntry, ttl);
            return fresh;
        }

        return entry.value();
    }

    /**
     * XFetch (Vattani et al.): refresh early when
     *   now - delta * BETA * ln(random) >= expiresAt
     * ln(random) is negative, so the term adds a random head start that is
     * usually small but grows with delta (slow recomputes start earlier).
     */
    private boolean shouldRecomputeEarly(CacheEntry entry) {
        double rand = ThreadLocalRandom.current().nextDouble();   // (0, 1)
        long headStartMillis =
            (long) (-entry.recomputeMillis() * BETA * Math.log(rand));
        return Instant.now().plusMillis(headStartMillis)
                      .isAfter(entry.expiresAt());
    }
}
```

### Strategy 2: Lock-Based Stampede Prevention

Only one thread refills the cache; others wait or return a stale value.

```java
@Component
public class LockingCacheService {

    private final RedisTemplate<String, AccountBalance> redisTemplate;
    private final StringRedisTemplate lockRedis;
    private final AccountRepository accountRepository;
    private static final Duration LOCK_TTL = Duration.ofSeconds(5);

    // Delete the lock only if we still own it (compare token, then DEL — atomically)
    private static final RedisScript<Long> RELEASE = RedisScript.of(
        "if redis.call('get', KEYS[1]) == ARGV[1] then " +
        "  return redis.call('del', KEYS[1]) else return 0 end", Long.class);

    public AccountBalance getBalance(long accountId) {
        String key = "account:balance:" + accountId;
        String lockKey = "lock:account:balance:" + accountId;

        AccountBalance cached = redisTemplate.opsForValue().get(key);
        if (cached != null) return cached;

        // Try to acquire the refill lock: SET lockKey <token> NX EX 5
        String token = UUID.randomUUID().toString();
        Boolean acquired = lockRedis.opsForValue()
            .setIfAbsent(lockKey, token, LOCK_TTL);

        if (Boolean.TRUE.equals(acquired)) {
            try {
                // This pod won the lock — refill from DB
                AccountBalance fresh = accountRepository
                    .findBalanceById(accountId)
                    .orElseThrow(() -> new AccountNotFoundException(accountId));
                redisTemplate.opsForValue().set(key, fresh, Duration.ofSeconds(30));
                return fresh;
            } finally {
                // A plain DELETE could remove ANOTHER pod's lock if ours expired
                lockRedis.execute(RELEASE, List.of(lockKey), token);
            }
        }

        // Another pod is refilling — poll the cache for up to ~100ms
        for (int i = 0; i < 4; i++) {
            try { Thread.sleep(25); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            AccountBalance retried = redisTemplate.opsForValue().get(key);
            if (retried != null) return retried;
        }
        // Fall through to DB as last resort
        return accountRepository.findBalanceById(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));
    }
}
```

## Spring @Cacheable with CacheManager

```java
@Service
public class CreditLimitService {

    @Cacheable(
        value = "credit-limits",
        key = "#accountId",
        unless = "#result == null"
    )
    public CreditLimit getCreditLimit(long accountId) {
        // Only called on cache miss — Spring handles the cache interaction
        return creditLimitRepository.findByAccountId(accountId)
            .orElseThrow(() -> new AccountNotFoundException(accountId));
    }

    // Delete from cache when the credit limit is updated
    @CacheEvict(value = "credit-limits", key = "#cmd.accountId()")
    @Transactional
    public void updateCreditLimit(UpdateCreditLimitCommand cmd) {
        creditLimitRepository.updateLimit(cmd.accountId(), cmd.newLimit());
        // @CacheEvict runs only if the method returns normally (an exception
        // means no eviction). With transactionAware() on the RedisCacheManager
        // the eviction is deferred until after COMMIT; without it, it may run
        // before the commit and a concurrent reader can re-cache the old limit.
        // If the commit itself fails after an eviction, the only effect is a
        // cache miss on the next read — harmless.
    }

    // Evict all entries — use sparingly, only during admin operations
    @CacheEvict(value = "credit-limits", allEntries = true)
    public void invalidateAllCreditLimits() {
        // Triggered after schema migration or bulk limit reset
    }
}
```

## Eviction Policies Comparison

| Policy | Algorithm | Best for | Risk in fintech |
|---|---|---|---|
| `allkeys-lru` | Evicts least recently used key | General workloads with temporal locality | Evicts infrequently accessed but critical keys (e.g., dormant account limits) |
| `allkeys-lfu` | Evicts least frequently used key | Access pattern has clear hot/cold split | Keys that were once hot linger; newly hot keys can be evicted early |
| `volatile-lru` | LRU only among keys with TTL set | Mix of persistent and ephemeral data | Keys without TTL never evicted — OOM risk |
| `volatile-ttl` | Evicts keys with the shortest remaining TTL | Explicit TTL management per key type | Short-TTL data (often the freshest) is evicted first |
| `noeviction` | Reject new writes when full | Compliance — no data loss from eviction | Cache becomes write-unavailable at max memory |
| `allkeys-random` | Random eviction | Not recommended in production | Evicts critical data randomly |

> [!TIP]
> For financial caches, prefer `volatile-lru` and ensure all cached entries have an explicit TTL. Use `noeviction` only for compliance-mandated caches where losing data is worse than write failures. Set `maxmemory-policy` explicitly — the default is `noeviction` which will cause Redis to reject writes when memory is full.

## Hot Key Problem and Two-Tier Caching

A hot key is a Redis key that receives a disproportionate share of traffic — for example, the exchange rate for EUR/USD that is checked on every payment. A single Redis node handles all requests for a given hash slot, so a hot key creates a bottleneck on one shard.

```java
@Component
public class TwoTierFxRateCache {

    // L1: JVM-local Caffeine cache — no network hop, no Redis bottleneck
    private final Cache<String, BigDecimal> l1Cache = Caffeine.newBuilder()
        .expireAfterWrite(Duration.ofSeconds(5))  // Very short TTL — L1 is a buffer
        .maximumSize(500)
        .recordStats()
        .build();

    // L2: Redis cluster — shared across all pods
    private final RedisTemplate<String, BigDecimal> l2Cache;
    private final ExchangeRateRepository exchangeRateRepository;

    public BigDecimal getExchangeRate(String currencyPair) {
        // 1. Check L1 (JVM local — zero latency)
        BigDecimal l1Hit = l1Cache.getIfPresent(currencyPair);
        if (l1Hit != null) return l1Hit;

        // 2. Check L2 (Redis cluster — ~0.5ms)
        String redisKey = "fx:rate:" + currencyPair;
        BigDecimal l2Hit = l2Cache.opsForValue().get(redisKey);
        if (l2Hit != null) {
            l1Cache.put(currencyPair, l2Hit); // Promote to L1
            return l2Hit;
        }

        // 3. Fetch from DB (source of truth — ~5ms)
        BigDecimal rate = exchangeRateRepository.findCurrentRate(currencyPair);
        l2Cache.opsForValue().set(redisKey, rate, Duration.ofMinutes(1));
        l1Cache.put(currencyPair, rate);
        return rate;
    }
}
```

## Cache Warming Strategy

Startup without cache warming causes a thundering herd when the first requests arrive. For payment services, warm critical caches before accepting traffic. Spring Boot marks the application ready for traffic only after all `ApplicationRunner`s finish, so a warmer that runs there completes before the readiness probe passes.

```java
@Component
public class PaymentCacheWarmer implements ApplicationRunner {

    private final AccountRepository accountRepository;
    private final RedisTemplate<String, AccountBalance> redisTemplate;
    private static final int WARM_BATCH_SIZE = 500;

    @Override
    public void run(ApplicationArguments args) throws Exception {
        log.info("Starting cache warming for active accounts...");
        Instant start = Instant.now();

        // Warm the top N most-active accounts in batches
        List<Long> hotAccountIds = accountRepository.findTopActiveAccountIds(50_000);

        List<List<Long>> batches = partition(hotAccountIds, WARM_BATCH_SIZE);
        for (List<Long> batch : batches) {
            List<AccountBalance> balances = accountRepository.findBalancesByIds(batch);
            warmBatch(balances);
        }

        Duration elapsed = Duration.between(start, Instant.now());
        log.info("Cache warming complete: {} accounts in {}ms",
            hotAccountIds.size(), elapsed.toMillis());
    }

    private void warmBatch(List<AccountBalance> balances) {
        // Use Redis pipeline for bulk set — single network round trip per batch
        redisTemplate.executePipelined((RedisCallback<Object>) connection -> {
            for (AccountBalance balance : balances) {
                String key = "account:balance:" + balance.accountId();
                byte[] keyBytes = key.getBytes(StandardCharsets.UTF_8);
                byte[] valueBytes = serialize(balance);
                // SET with a 30-45 second TTL — the jitter stops all warmed
                // keys from expiring in the same second
                connection.setEx(keyBytes,
                    30 + ThreadLocalRandom.current().nextInt(16), valueBytes);
            }
            return null;
        });
    }
}
```

## Redis Persistence for Compliance

Redis persistence lets a restarted cache come back warm instead of empty, which avoids a stampede on the database. It never makes Redis a system of record: balances, payments, and audit data belong in the database. Redis offers two persistence mechanisms:

| Mechanism | Description | Recovery time | Fit |
|---|---|---|---|
| RDB (snapshot) | Point-in-time snapshot at configurable intervals | Fast start, loses changes since last snapshot | Fine for most caches |
| AOF (append-only file) | Log every write command, replay on start | Slower start, minimal data loss | Data that is expensive to rebuild (e.g. rate-limit state) |
| AOF + RDB hybrid | Use both: AOF for durability, RDB for fast restart | Best of both — restart from RDB, replay recent AOF | Good default when persistence is needed |

```
# redis.conf — AOF + RDB hybrid configuration
# (redis.conf comments must be on their own lines)

# RDB: snapshot if 1 key changed in 900 seconds, or 10 keys in 300 seconds
save 900 1
save 300 10

# Enable AOF; fsync once per second — balances durability vs performance
appendonly yes
appendfsync everysec

# Hybrid: RDB preamble in the AOF file for fast restart
aof-use-rdb-preamble yes
```

## Knowledge Check

**Q1: Your payment service uses `@CacheEvict` on the `updateCreditLimit` method. The database transaction rolls back due to a constraint violation, but `@CacheEvict` has already fired. What is the state of the cache after the rollback?**

A: (This can happen only if the commit fails after the method returned, because `@CacheEvict` does not run when the method throws.) The cache entry has been evicted even though the database did not change. The next read will be a cache miss and will re-populate the cache from the database with the original (pre-update) value. This is a minor inefficiency but not a correctness problem: the cache will serve the correct (unchanged) value on the next read. This is why delete is safer than update: an accidental eviction causes a cache miss but never causes stale data. The alternative — updating the cache with the new value before commit — would leave stale incorrect data in the cache if the transaction rolled back.

**Q2: Your Redis cluster has 3 primary nodes with `allkeys-lru` eviction. The EUR/USD exchange rate key is accessed 2 million times per minute. After a cache flush, all 3,000 application pods simultaneously receive a miss for `fx:rate:EUR/USD` and query the database. What pattern prevents this, and how does the two-tier cache help?**

A: This is a cache stampede for a hot key. Prevention strategies: (1) probabilistic early expiry — recompute before expiry, staggered across pods so they don't all miss simultaneously; (2) lock-based refill — only one pod refills the key, others wait or return a slightly stale L1 value; (3) two-tier caching — each pod holds the rate in a local Caffeine L1 cache with a 5-second TTL. Even after a Redis flush, L1 caches across pods expire at different times (because they were populated at different times), so only a fraction of pods hit Redis at once, and only Redis misses (a small fraction) hit the database.

## Practical Challenge

**Scenario:** You are building the payment service for a fintech platform. Account balances are stored in PostgreSQL. The service receives 12,000 TPS at peak. The top 10,000 accounts account for 60% of all balance reads. You are using a 6-node Redis Cluster (3 primaries, 3 replicas).

**Tasks:**

1. **Configure Redis Cluster with Lettuce:** Write the `RedisClusterConfig` Spring configuration class with correct `LettuceClientConfiguration` including read-from-replica, topology refresh, and per-cache TTL configuration for `account-balances` (30s), `credit-limits` (10m), and `fx-rates` (60s).

2. **Implement cache-aside with correct invalidation:** Write the `AccountBalanceCacheService` with `getBalance(long accountId)` and `updateBalance(long accountId, BigDecimal newBalance)`. Show explicitly why you delete the cache key rather than updating it. Add a comment explaining what happens if the database transaction rolls back after the cache update.

3. **Stampede prevention:** Implement `StampedeResistantCacheService` that uses a Redis distributed lock (SET NX EX) to ensure only one pod refills the cache for a given key. Other pods should wait up to 100ms, then fall back to a direct DB read. Write the full implementation including lock acquisition, refill, lock release, and timeout handling.

4. **Hot key mitigation:** The `fx:rate:EUR/USD` key receives 400,000 reads/second during peak, all landing on a single Redis shard. Write a `TwoTierFxRateCache` that uses a Caffeine L1 cache with 5-second TTL per pod, backed by Redis L2 with 60-second TTL. Calculate the maximum number of Redis reads per minute for this key given 20 pods, and explain how L1 TTL scatter prevents a synchronised stampede.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "Your @CacheEvict method returned normally and the entry was evicted, but the transaction commit then failed and rolled back. What is the state of the cache?",
      "options": [
        "The cache retains the old value — @CacheEvict is transactional",
        "The cache entry is evicted even though the DB did not change — next read is a miss that re-populates correctly",
        "The cache is corrupted and must be manually flushed",
        "Spring automatically re-populates the cache with the rolled-back value"
      ],
      "correct": 1,
      "explanation": "The eviction has already happened, but the DB still holds the original value. The next read is a cache miss that re-populates from the DB with the correct, unchanged value. This is a minor inefficiency, not a correctness problem — which is why delete is safer than in-place update. (If the method had thrown, @CacheEvict would not have run at all; and a transactionAware RedisCacheManager defers the eviction until after commit.)"
    },
    {
      "id": "q2",
      "text": "You observe that allkeys-lru eviction is removing your dormant account credit limit entries during peak traffic, causing unexpected DB reads for rare accounts. What eviction policy should you use?",
      "options": [
        "allkeys-lfu — evicts least frequently used, so dormant accounts are still evicted",
        "volatile-lru — LRU only among keys with TTL; set no TTL on critical dormant entries to prevent eviction",
        "noeviction — reject all writes when memory is full",
        "allkeys-random — random eviction is fairer"
      ],
      "correct": 1,
      "explanation": "volatile-lru applies LRU eviction only to keys that have a TTL set. If you do not set a TTL on critical dormant account entries, they will never be evicted by volatile-lru. This lets you control which keys are eviction-eligible. The trade-offs: keys without a TTL accumulate, so memory must be managed carefully, and they can only become fresh again through explicit invalidation on every update."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Redis Cluster Caching for a 12,000 TPS Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "Write the RedisClusterConfig with Lettuce: topology refresh, primary reads for balances, and per-cache TTLs for account-balances (30s), credit-limits (10m), and fx-rates (60s), with a transaction-aware cache manager."
    },
    {
      "id": "2",
      "description": "Implement AccountBalanceCacheService.getBalance() and updateBalance() with delete-not-update invalidation that runs after commit, and explain in comments what goes wrong if the cache is updated or deleted before the commit."
    },
    {
      "id": "3",
      "description": "Implement StampedeResistantCacheService with a Redis lock (SET NX EX with a random token, released by a compare-and-delete script) so only one pod refills a key; other pods poll the cache for up to 100ms, then fall back to a direct DB read."
    },
    {
      "id": "4",
      "description": "Implement TwoTierFxRateCache with a Caffeine L1 (5s TTL) backed by Redis L2 (60s TTL). Calculate the maximum Redis reads per minute for fx:rate:EUR/USD with 20 pods, and explain how L1 expiry times scattered across pods prevent a synchronised stampede."
    }
  ]
}
-->
