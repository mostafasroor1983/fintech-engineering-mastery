---
id: track-07-lesson-11
title: "أداء Redis — Pipelining والسكربتات وهياكل البيانات"
slug: redis-performance
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 11
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Redis, pipelining, Lua, data-structures, latency]
prerequisites: [track-07-lesson-10]
---

# أداء Redis — خطوط الأوامر والسكربتات وهياكل البيانات

> [!NOTE]
> ينفذ Redis الأوامر على خيط واحد (والإصدارات الأحدث تستخدم خيوطًا إضافية لإدخال/إخراج الشبكة فقط). ومعظم الأوامر تستغرق ميكروثوانيَ، لذا ففي الأحمال المعتادة يهيمن زمن جولة الشبكة على تجربة العميل، لا الحساب. وكل قرار معماري — خطوط الأوامر (pipelining)، والسكربتات، واختيار هياكل البيانات — يدور حول تقليل الجولات وتعظيم العمل المنجز لكل أمر.

## 1. خطوط أوامر Redis — تجميع الأوامر لتقليل الجولات

دون خطوط الأوامر، يتطلب كل أمر جولة شبكة كاملة:

```
Client -> COMMAND_1 -> Server -> RESPONSE_1 -> Client  (1 RTT)
Client -> COMMAND_2 -> Server -> RESPONSE_2 -> Client  (1 RTT)
Client -> COMMAND_3 -> Server -> RESPONSE_3 -> Client  (1 RTT)
```

ومع خطوط الأوامر، تُرسل أوامر متعددة في كتابة شبكة واحدة:

```
Client -> [COMMAND_1, COMMAND_2, COMMAND_3] -> Server  (1 RTT)
Client <- [RESPONSE_1, RESPONSE_2, RESPONSE_3] <- Server
```

### خطوط الأوامر مع Lettuce (الافتراضي في Spring Boot)

```java
@Service
public class RedisPipelineService {

    private final StringRedisTemplate redis;   // String keys and values

    public RedisPipelineService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /**
     * Load multiple account metadata hashes in one round trip.
     * Without pipelining: N round trips for N accounts.
     * With pipelining: 1 round trip for all N accounts.
     */
    @SuppressWarnings("unchecked")
    public Map<String, AccountMetadata> loadAccountsBatch(List<String> accountIds) {
        List<Object> results = redis.executePipelined(
            (RedisCallback<Object>) connection -> {
                accountIds.forEach(id ->
                    connection.hashCommands().hGetAll(
                        ("account:" + id).getBytes(StandardCharsets.UTF_8))
                );
                return null; // must return null; results come back as a list
            }
        );

        // executePipelined deserialises results with the template's
        // serializers, so each hash arrives as Map<String, String>
        Map<String, AccountMetadata> output = new HashMap<>();
        for (int i = 0; i < accountIds.size(); i++) {
            Map<String, String> fields = (Map<String, String>) results.get(i);
            if (fields != null && !fields.isEmpty()) {
                output.put(accountIds.get(i), deserializeAccountMetadata(fields));
            }
        }
        return output;
    }

    /**
     * Record multiple velocity counters in one round trip.
     * Used in fraud detection: increment hourly/daily/monthly counts per account.
     */
    public void recordVelocityCounters(UUID accountId, BigDecimal amount) {
        String prefix = "velocity:" + accountId;
        Instant now = Instant.now();
        LocalDate todayUtc = LocalDate.ofInstant(now, ZoneOffset.UTC);
        String hourKey  = prefix + ":hour:"  + now.truncatedTo(ChronoUnit.HOURS).getEpochSecond();
        String dayKey   = prefix + ":day:"   + todayUtc;
        String monthKey = prefix + ":month:" + YearMonth.from(todayUtc);

        // Sums are kept in MINOR units (cents) as integers: exact, and
        // INCRBY only accepts integers. (amount.longValue() would drop the cents.)
        long minorUnits = amount.movePointRight(2).longValueExact();

        redis.executePipelined((RedisCallback<Object>) conn -> {
            Map<String, Long> ttls = Map.of(
                hourKey, 3_600L, dayKey, 86_400L, monthKey, 2_678_400L);  // 31 days
            for (Map.Entry<String, Long> e : ttls.entrySet()) {
                String k = e.getKey();
                long ttl = e.getValue();
                byte[] count = k.getBytes(StandardCharsets.UTF_8);
                byte[] sum = (k + ":sum").getBytes(StandardCharsets.UTF_8);
                conn.stringCommands().incr(count);
                conn.stringCommands().incrBy(sum, minorUnits);
                // The key name already contains the period, so a TTL of one
                // period after the last write is enough to clean it up
                conn.keyCommands().expire(count, ttl);
                conn.keyCommands().expire(sum, ttl);
            }
            return null;
        });
    }
}
```

### مقاييس إنتاجية خطوط الأوامر

```
Illustrative, one connection, 0.5 ms network round trip:
Single command (no pipeline):  RTT = 0.5ms  -> 2,000 ops/sec
Pipeline 10 commands:          RTT = 0.6ms  -> 16,667 ops/sec (8x)
Pipeline 100 commands:         RTT = 1.5ms  -> 66,667 ops/sec (33x)
Pipeline 1000 commands:        RTT = 10ms   -> 100,000 ops/sec (50x)
```

**قاعدة تقريبية**: حجم دفعة من 50–200 أمر يعطي أفضل نسبة إنتاجية إلى زمن. والدفعات الأكبر تزيد زمن العنصر الأول في الدفعة.

## 2. سكربتات Lua للعمليات الذرية

تُنفَّذ سكربتات Lua ذريًا على خادم Redis — فلا يمكن لأي أمر آخر أن يتداخل أثناء تنفيذ السكربت. وهذا أساسي للعمليات التي يجب أن تكون ذرية لكنها تتطلب أوامر متعددة. (والذرية هنا تعني "بلا تداخل"، لا "الكل أو لا شيء": فإذا فشل سكربت في منتصفه، تبقى الكتابات التي أجراها.)

### سكربت تحديد المعدل

```java
@Component
public class RedisRateLimiter {

    private final StringRedisTemplate redis;

    // Lua script: sliding window rate limiter
    // Returns: [allowed (1/0), current_count, ttl_or_retry_ms]
    private static final String RATE_LIMIT_SCRIPT = """
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window_ms = tonumber(ARGV[2])
        local request_id = ARGV[3]

        -- Use the Redis server clock: app servers' clocks can disagree
        local t = redis.call('TIME')
        local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
        local window_start = now - window_ms

        -- Remove expired entries from sorted set
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current requests in window
        local count = redis.call('ZCARD', key)

        if count < limit then
            -- Unique member per request (a caller-supplied id, not math.random)
            redis.call('ZADD', key, now, request_id)
            redis.call('PEXPIRE', key, window_ms)
            return {1, count + 1, window_ms}
        else
            local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
            local retry_after = window_ms - (now - tonumber(oldest[2]))
            return {0, count, retry_after}
        end
        """;

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static final RedisScript<List<Long>> RATE_LIMIT =
        (RedisScript<List<Long>>) (RedisScript) RedisScript.of(RATE_LIMIT_SCRIPT, List.class);

    public RedisRateLimiter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /**
     * Check rate limit for an account.
     * @param accountId the account to rate limit
     * @param limit max requests per window
     * @param windowMillis sliding window duration in ms
     * @return RateLimitResult with allowed flag and retry-after
     */
    public RateLimitResult checkRateLimit(String accountId, int limit, long windowMillis) {
        String key = "ratelimit:{" + accountId + "}";   // hash tag: cluster-safe

        List<Long> result = redis.execute(
            RATE_LIMIT,
            List.of(key),
            String.valueOf(limit),
            String.valueOf(windowMillis),
            UUID.randomUUID().toString()
        );

        boolean allowed = result.get(0) == 1L;
        long currentCount = result.get(1);
        long retryAfterMs = result.get(2);

        return new RateLimitResult(allowed, currentCount, limit,
            allowed ? 0 : retryAfterMs);
    }
}
```

### سكربت إزالة التكرار بالـ idempotency

```java
@Component
public class IdempotencyService {

    private final RedisTemplate<String, String> redisTemplate;

    /**
     * SET key value EX ttl NX — atomic check-and-set.
     * Returns 1 if key was set (first occurrence), 0 if already exists.
     * This is atomic without Lua because Redis SET NX is a single command.
     */
    public boolean markProcessed(String idempotencyKey, String transactionId,
                                  Duration ttl) {
        Boolean result = redisTemplate.opsForValue().setIfAbsent(
            "idem:" + idempotencyKey,
            transactionId,
            ttl
        );
        return Boolean.TRUE.equals(result);  // true = first time, process
    }

    /**
     * Atomic get-or-set for idempotency with response storage.
     * If key exists, return existing response.
     * If key does not exist, reserve it (caller will process and store result).
     * (Redis 7+ can do the same in one command: SET key value NX GET EX ttl.)
     *
     * Redis is a fast FIRST check only. Redis is not durable by default and
     * failover can lose recent writes, so the payment's source of truth must
     * still be a UNIQUE constraint on the idempotency key in the database.
     */
    private static final String IDEM_GETORSET_SCRIPT = """
        local key = KEYS[1]
        local value = ARGV[1]
        local ttl = tonumber(ARGV[2])

        local existing = redis.call('GET', key)
        if existing then
            return {0, existing}  -- 0 = already exists, return existing value
        else
            redis.call('SET', key, value, 'EX', ttl)
            return {1, ''}        -- 1 = newly set, proceed with processing
        end
        """;

    public IdempotencyResult checkOrReserve(String idempotencyKey,
                                             String placeholder,
                                             Duration ttl) {
        RedisScript<List<?>> script = RedisScript.of(IDEM_GETORSET_SCRIPT, List.class);

        List<?> result = redisTemplate.execute(
            script,
            Collections.singletonList("idem:" + idempotencyKey),
            placeholder,
            String.valueOf(ttl.getSeconds())
        );

        boolean isNew = ((Long) result.get(0)) == 1L;
        String existingValue = (String) result.get(1);

        return new IdempotencyResult(isNew, existingValue);
    }
}
```

### سكربت القفل الموزع

```java
@Component
public class DistributedLockService {

    /**
     * Single-instance lock with SET NX EX (this is NOT Redlock, which uses
     * several independent Redis nodes). Returns the lock token if acquired.
     *
     * Use such locks only to avoid duplicate WORK (efficiency). They do not
     * guarantee mutual exclusion for CORRECTNESS: a GC pause or network delay
     * can let the TTL expire while the holder still runs. Money movements must
     * be protected by the database (row locks, version checks, fencing tokens).
     */
    public Optional<String> tryAcquireLock(String resource, Duration ttl) {
        String token = UUID.randomUUID().toString();
        String key = "lock:" + resource;

        Boolean acquired = redisTemplate.opsForValue().setIfAbsent(
            key, token, ttl
        );

        return Boolean.TRUE.equals(acquired) ? Optional.of(token) : Optional.empty();
    }

    /**
     * Release lock atomically — only release if the token matches.
     * Without atomicity: another holder could release our lock if we check
     * and release in two separate commands.
     */
    private static final String UNLOCK_SCRIPT = """
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        else
            return 0
        end
        """;

    public boolean releaseLock(String resource, String token) {
        RedisScript<Long> script = RedisScript.of(UNLOCK_SCRIPT, Long.class);
        Long result = redisTemplate.execute(
            script,
            Collections.singletonList("lock:" + resource),
            token
        );
        return Long.valueOf(1L).equals(result);
    }
}
```

## 3. اختيار هياكل بيانات Redis

اختيار هيكل البيانات المناسب مهم بقدر أي تحسين آخر في Redis.

### المجموعات المرتبة — السرعة ولوحات الصدارة

```java
@Service
public class TransactionVelocityService {

    private final RedisTemplate<String, String> redisTemplate;

    /**
     * Sorted set: member=transaction_id, score=timestamp_ms
     * Enables efficient sliding window queries.
     */
    public void recordTransaction(UUID accountId, UUID txId, BigDecimal amount) {
        String key = "velocity:txn:" + accountId;
        double score = System.currentTimeMillis();

        // Add with pipeline for efficiency
        redisTemplate.executePipelined((RedisCallback<Object>) conn -> {
            conn.zAdd(key.getBytes(),
                score,
                txId.toString().getBytes());
            conn.expire(key.getBytes(), 86400L);  // 24h TTL
            return null;
        });
    }

    /**
     * Count transactions in a sliding window.
     * ZCOUNT is O(log N) on sorted set.
     */
    public long countTransactionsInWindow(UUID accountId, Duration window) {
        String key = "velocity:txn:" + accountId;
        double minScore = System.currentTimeMillis() - window.toMillis();
        double maxScore = Double.POSITIVE_INFINITY;

        return redisTemplate.opsForZSet().count(key, minScore, maxScore);
    }

    /**
     * Remove old entries to prevent unbounded growth.
     * Run periodically or on each write.
     */
    public void pruneOldEntries(UUID accountId, Duration retentionWindow) {
        String key = "velocity:txn:" + accountId;
        double cutoff = System.currentTimeMillis() - retentionWindow.toMillis();
        // Double.MIN_VALUE is the smallest POSITIVE double -- use -infinity
        redisTemplate.opsForZSet().removeRangeByScore(key, Double.NEGATIVE_INFINITY, cutoff);
    }
}
```

### الجداول (Hashes) — بيانات الحسابات والجلسات

```java
@Service
public class AccountSessionCache {

    private final RedisTemplate<String, String> redisTemplate;

    /**
     * Hash: field=attribute_name, value=attribute_value
     * Better than string+JSON for partial updates — no need to
     * deserialize/reserialize the entire object.
     */
    public void cacheAccount(UUID accountId, AccountMetadata metadata) {
        String key = "account:" + accountId;
        Map<String, String> fields = Map.of(
            "account_number", metadata.getAccountNumber(),
            "currency",       metadata.getCurrency(),
            "status",         metadata.getStatus(),
            "type",           metadata.getAccountType(),
            "customer_id",    metadata.getCustomerId().toString(),
            "created_at",     metadata.getCreatedAt().toString()
        );

        redisTemplate.opsForHash().putAll(key, fields);
        redisTemplate.expire(key, Duration.ofSeconds(300));
    }

    /**
     * Partial update: change one field without touching the others.
     * Careful: if the key has already expired, HSET creates a NEW hash with
     * only "status" and NO TTL. For a cache, invalidating is usually safer:
     * the next read reloads the full, current row from the database.
     */
    public void onAccountStatusChanged(UUID accountId) {
        redisTemplate.delete("account:" + accountId);
    }

    /**
     * Get specific fields only (HMGET) — saves bandwidth vs HGETALL.
     */
    public Optional<BalanceCheckData> getBalanceCheckData(UUID accountId) {
        String key = "account:" + accountId;
        List<Object> values = redisTemplate.opsForHash()
            .multiGet(key, List.of("currency", "status"));

        if (values.get(0) == null) return Optional.empty();

        return Optional.of(new BalanceCheckData(
            (String) values.get(0),
            (String) values.get(1)
        ));
    }
}
```

### التدفقات (Streams) — سجل أحداث متين

```java
@Service
public class PaymentEventStream {

    private final RedisTemplate<String, String> redisTemplate;
    private static final String STREAM_KEY = "payment-events";
    private static final long MAX_STREAM_LENGTH = 100_000;

    /**
     * Redis Streams: append-only log with consumer groups.
     * Useful for lightweight event sourcing or inter-service messaging.
     * NOT a replacement for Kafka for high-volume, durable workloads.
     */
    public RecordId publishEvent(PaymentEvent event) {
        Map<String, String> body = Map.of(
            "type",          event.getType(),
            "account_id",    event.getAccountId().toString(),
            "amount",        event.getAmount().toPlainString(),
            "currency",      event.getCurrency(),
            "timestamp",     event.getTimestamp().toString(),
            "idempotency_key", event.getIdempotencyKey()
        );

        RecordId recordId = redisTemplate.opsForStream()
            .add(MapRecord.create(STREAM_KEY, body));

        // Trim stream to prevent unbounded growth
        redisTemplate.opsForStream()
            .trim(STREAM_KEY, MAX_STREAM_LENGTH, true);

        return recordId;
    }

    public void createConsumerGroup(String groupName) {
        try {
            redisTemplate.opsForStream()
                .createGroup(STREAM_KEY, ReadOffset.from("0"), groupName);
        } catch (Exception e) {
            // Group already exists — ignore
        }
    }

    public List<MapRecord<String, String, String>> readEvents(
            String groupName, String consumerName, int count) {
        return redisTemplate.opsForStream().read(
            Consumer.from(groupName, consumerName),
            StreamReadOptions.empty().count(count).block(Duration.ofSeconds(2)),
            StreamOffset.create(STREAM_KEY, ReadOffset.lastConsumed())
        );
    }
}
```

## 4. تحليل LATENCY HISTORY وSLOWLOG

```java
@Component
@Slf4j
public class RedisLatencyMonitor {

    private final StringRedisTemplate redis;
    private final AtomicLong newSlowEntries = new AtomicLong();
    private long lastSeenId = -1;

    public RedisLatencyMonitor(StringRedisTemplate redis, MeterRegistry metrics) {
        this.redis = redis;
        // Register ONCE; the scheduled job only updates the holder
        metrics.gauge("redis.slowlog.new_entries", Tags.of("instance", "primary"), newSlowEntries);
    }

    /**
     * Read Redis SLOWLOG for commands exceeding the threshold
     * (slowlog-log-slower-than; default 10000 microseconds = 10 ms).
     * The slowlog keeps old entries, so count only entries with a new id.
     */
    @Scheduled(fixedRate = 60_000)
    @SuppressWarnings("unchecked")
    public void reportSlowLog() {
        List<Object> entries = redis.execute((RedisCallback<List<Object>>) conn ->
            (List<Object>) conn.execute("SLOWLOG", "GET".getBytes(), "128".getBytes()));
        if (entries == null) return;

        long fresh = 0, maxId = lastSeenId;
        for (Object e : entries) {
            long id = (Long) ((List<Object>) e).get(0);   // entry = [id, time, micros, args...]
            if (id > lastSeenId) fresh++;
            maxId = Math.max(maxId, id);
        }
        lastSeenId = maxId;
        newSlowEntries.set(fresh);
        if (fresh > 0) {
            log.warn("Redis slowlog: {} new slow commands in the last minute", fresh);
        }
    }

    /**
     * Per-command latency percentiles from INFO latencystats (Redis 7+).
     */
    @Scheduled(fixedRate = 30_000)
    public void reportLatencyStats() {
        Properties info = redis.execute((RedisCallback<Properties>) conn ->
            conn.serverCommands().info("latencystats"));
        if (info != null) {
            info.forEach((key, value) -> {
                if (key.toString().startsWith("latency_percentiles_usec_")) {
                    String cmd = key.toString().replace("latency_percentiles_usec_", "");
                    log.debug("Redis command {} latency: {}", cmd, value);
                }
            });
        }
    }
}
```

### ضبط Slowlog

```
# redis.conf
slowlog-log-slower-than 5000    # log commands > 5ms (5000 microseconds)
slowlog-max-len 256             # keep last 256 entries

# In application.yml via Spring (pooling also needs commons-pool2 on the classpath)
spring:
  data:
    redis:
      lettuce:
        pool:
          max-active: 20
          max-idle: 10
          min-idle: 5
          max-wait: 2000ms
```

## 5. تحسين الذاكرة — عتبات الترميز

يستخدم Redis ترميزات مضغوطة للمجموعات الصغيرة. وحين تنمو مجموعة فوق العتبة، تتحول إلى جدول تجزئة كامل، فتستهلك ذاكرة أكثر بكثير.

```
# redis.conf encoding thresholds
hash-max-listpack-entries 128   # hash uses listpack (compact) up to 128 fields
hash-max-listpack-value 64      # max field value bytes for listpack
zset-max-listpack-entries 128   # sorted set uses listpack up to 128 members
zset-max-listpack-value 64
set-max-intset-entries 512      # integer set uses intset up to 512 members
list-max-listpack-size -2       # list uses listpack up to 8KB
```

```java
@Service
public class RedisMemoryOptimizer {

    private final StringRedisTemplate redis;

    public RedisMemoryOptimizer(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /**
     * Short key prefixes save a few bytes per key. That only matters with
     * hundreds of millions of keys -- otherwise readable names win.
     */
    private static final String ACCT_KEY_PREFIX     = "a:";  // vs "account:"
    private static final String VELOCITY_KEY_PREFIX = "v:";  // vs "velocity:"

    /**
     * Check the encoding (OBJECT ENCODING) to verify a compact encoding is used.
     */
    public RedisValueEncoding checkEncoding(String key) {
        RedisValueEncoding encoding = redis.execute((RedisCallback<RedisValueEncoding>) conn ->
            conn.keyCommands().encodingOf(key.getBytes(StandardCharsets.UTF_8)));
        // "hashtable" for a hash you expected to be small means it passed a
        // threshold: too many fields, or a value longer than
        // hash-max-listpack-value. Raise the threshold or shorten values.
        return encoding;
    }

    /**
     * Memory used by one key (MEMORY USAGE), including overhead.
     */
    public Long getKeyMemoryBytes(String key) {
        return redis.execute((RedisCallback<Long>) conn ->
            conn.serverCommands().memoryUsage(key.getBytes(StandardCharsets.UTF_8)));
    }
}
```

## 6. ‏Redisson مقابل Lettuce — مقارنة العملاء

| الميزة | Lettuce | Redisson |
|---|---|---|
| غير متزامن/تفاعلي | أصلي (Netty) | عبر CompletableFuture |
| دعم العنقود | نعم | نعم |
| الأقفال الموزعة | يدوي | واجهة RLock |
| محدد المعدل | ‏Lua يدوي | واجهة RRateLimiter |
| النشر/الاشتراك | نعم | نعم |
| التدفقات | نعم | نعم |
| التكامل مع Spring Boot | افتراضي | مُبدئ منفصل |
| حمل الأداء | أقل | أعلى (تجريد أكثر) |

```java
// Lettuce: low-level, high-performance
@Configuration
public class LettuceConfig {

    @Bean
    public LettuceConnectionFactory lettuceConnectionFactory() {
        LettuceClientConfiguration clientConfig = LettuceClientConfiguration.builder()
            .commandTimeout(Duration.ofMillis(500))
            .clientOptions(ClientOptions.builder()
                .socketOptions(SocketOptions.builder()
                    .connectTimeout(Duration.ofMillis(1000))
                    .keepAlive(SocketOptions.KeepAliveOptions.builder()
                        .enable()
                        .idle(Duration.ofSeconds(30))
                        .interval(Duration.ofSeconds(10))
                        .count(3)
                        .build())
                    .build())
                .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                .build())
            .build();

        RedisStandaloneConfiguration serverConfig =
            new RedisStandaloneConfiguration("redis-primary", 6379);

        return new LettuceConnectionFactory(serverConfig, clientConfig);
    }
}

// Redisson: higher-level distributed primitives
@Configuration
public class RedissonConfig {

    @Bean
    public RedissonClient redissonClient() {
        Config config = new Config();
        config.useSingleServer()
            .setAddress("redis://redis-primary:6379")
            .setConnectionMinimumIdleSize(5)
            .setConnectionPoolSize(20)
            .setConnectTimeout(1000)
            .setTimeout(500)
            // Retries resend commands after a timeout: a non-idempotent
            // command such as INCR may then run twice
            .setRetryAttempts(3)
            .setRetryInterval(100);

        return Redisson.create(config);
    }

    // Distributed lock via Redisson -- usually obtained per resource
    // (redisson.getLock("lock:account:" + id)), not as one global bean.
    // Same caveat as above: efficiency, not correctness, for money movement.
}
```

## 7. توزيع المفاتيح في Redis Cluster

في Redis Cluster، توزَّع المفاتيح عبر الأجزاء (shards) باستخدام CRC16 للمفتاح. والمفاتيح التي يجب أن تكون في الجزء نفسه للأوامر متعددة المفاتيح أو سكربتات Lua يجب أن تستخدم وسوم التجزئة (hash tags).

```java
@Service
public class ClusterAwareService {

    /**
     * Without hash tags, these keys may land on different slots/shards.
     * Multi-key commands (MGET, MSET) and Lua scripts touching them fail
     * with a CROSSSLOT error.
     */
    // WRONG: may be on different shards
    private String badKey(UUID accountId, String type) {
        return type + ":" + accountId;
    }

    /**
     * Hash tags: the portion inside {} is used for slot assignment.
     * All keys with the same {} content land on the same shard.
     */
    // CORRECT: all keys for the same account land on the same shard
    private String goodKey(UUID accountId, String type) {
        return type + ":{" + accountId + "}";
    }

    /**
     * Example: rate limit and velocity keys for the same account
     * must be on the same shard to allow Lua scripts to access both.
     */
    // Reads all three keys in one atomic server-side step
    private static final RedisScript<List> SESSION_SNAPSHOT_SCRIPT = RedisScript.of(
        "return {redis.call('GET', KEYS[1]), redis.call('GET', KEYS[2]), "
      + "redis.call('HGETALL', KEYS[3])}", List.class);

    public void processWithCluster(UUID accountId) {
        String rateLimitKey = "ratelimit:{" + accountId + "}";
        String velocityKey  = "velocity:{" + accountId + "}";
        String sessionKey   = "session:{" + accountId + "}";

        // Same hash tag -> same slot, so ONE Lua script may use all three keys
        // (Note: Spring Data Redis's executePipelined is not supported on a
        //  cluster connection; use a script or Lettuce's async API instead.)
        redisTemplate.execute(SESSION_SNAPSHOT_SCRIPT,
            List.of(rateLimitKey, velocityKey, sessionKey));
    }
}
```

## 8. تحجيم مجمع الاتصالات لخدمات الدفع

```yaml
# application.yml
spring:
  data:
    redis:
      lettuce:
        pool:
          # Lettuce connections are thread-safe: ONE shared connection
          # multiplexes all ordinary commands, and that is often the fastest
          # setup. A pool is needed only for blocking commands (BLPOP, XREAD
          # BLOCK) and MULTI/EXEC transactions. If you pool, size it from
          # load tests -- a small pool is usually enough.
          max-active: 20
          max-idle: 10
          min-idle: 5
          max-wait: 200ms  # fail fast — don't queue requests

      # Sentinel (for HA) or Cluster configuration
      sentinel:
        master: payment-redis-master
        nodes:
          - sentinel-1:26379
          - sentinel-2:26379
          - sentinel-3:26379
```

```java
@Configuration
public class RedisMetricsConfig {

    // Spring Boot already records Lettuce command latency
    // (lettuce.command.completion / lettuce.command.firstresponse timers).
    // For pool usage, register gauges ONCE with functions that read the pool:
    @Bean
    public MeterBinder redisPoolMetrics(PoolStatsSource pool) {   // your adapter
        return registry -> {
            Gauge.builder("redis.pool.active_connections", pool, PoolStatsSource::active)
                .tag("instance", "primary").register(registry);
            Gauge.builder("redis.pool.idle_connections", pool, PoolStatsSource::idle)
                .tag("instance", "primary").register(registry);
        };
    }
}
```

## 9. مقاييس أداء لعمليات الدفع الشائعة

أزمنة توضيحية داخل مركز بيانات واحد (تشمل جولة الشبكة):

| العملية | هيكل البيانات | التعقيد | الزمن المعتاد |
|---|---|---|---|
| البحث في ذاكرة الحساب | ‏Hash ‏(HGETALL) | ‏O(N حقل) | ‏0.3–0.8 مللي ثانية |
| فحص الـ idempotency | ‏String ‏(GET) | ‏O(1) | ‏0.1–0.3 مللي ثانية |
| فحص حد المعدل | مجموعة مرتبة + Lua | ‏O(log N) | ‏0.5–1.5 مللي ثانية |
| عدّ السرعة | مجموعة مرتبة (ZCOUNT) | ‏O(log N) | ‏0.3–0.8 مللي ثانية |
| تحميل الجلسة | ‏Hash ‏(HMGET لـ 5 حقول) | ‏O(N حقل) | ‏0.2–0.5 مللي ثانية |
| خط من 50 أمرًا | أي | ‏O(N) إجمالًا | ‏0.8–2.0 مللي ثانية إجمالًا |
| الحصول على قفل موزع | ‏String ‏(SET NX EX) | ‏O(1) | ‏0.3–0.8 مللي ثانية |

## 10. أنماط Redis المضادة في الخدمات المالية

```java
// ANTI-PATTERN 1: KEYS command in production
// KEYS is O(N) and blocks Redis for the entire scan duration
// On a 1M key instance, KEYS * takes seconds and freezes all other commands
redisTemplate.keys("account:*");  // NEVER in production

// CORRECT: Use SCAN with cursor -- and CLOSE the cursor, which also
// releases the connection it holds
ScanOptions options = ScanOptions.scanOptions().match("account:*").count(100).build();
try (Cursor<String> cursor = redisTemplate.scan(options)) {
    while (cursor.hasNext()) {
        String key = cursor.next();
        // process
    }
}

// ANTI-PATTERN 2: Storing large objects in a single string
// Serializing a 100KB account object on every read/write wastes bandwidth
redisTemplate.opsForValue().set("account:" + id, serialize(bigAccountObject));

// CORRECT: Use Hash and only fetch needed fields
redisTemplate.opsForHash().multiGet("account:" + id,
    List.of("currency", "status", "type"));   // (never cache balances -- lesson 10)

// ANTI-PATTERN 3: No TTL on keys
redisTemplate.opsForValue().set("temp-data:" + id, value);
// If the cleanup code fails, this key lives forever

// CORRECT: Always set TTL
redisTemplate.opsForValue().set("temp-data:" + id, value, Duration.ofMinutes(30));

// ANTI-PATTERN 4: Using Redis as a primary transaction store
// Redis is not durable by default (only periodic RDB snapshots; AOF is off).
// Even with AOF and fsync, replication is asynchronous, so a failover can
// lose acknowledged writes.
// Never use Redis as the primary store for financial transactions
// Use it as a cache/auxiliary store only
```

> [!WARNING]
> تنفيذ Redis للأوامر على خيط واحد يعني أن أمرًا بطيئًا واحدًا (مثل `KEYS *` أو سكربت Lua طويل) يحجب كل الأوامر الأخرى. وفي نظام دفع، قد يؤخر أمر Redis واحد يستغرق 100 مللي ثانية آلاف عمليات الدفع المتزامنة. فوصّف سكربتات Lua دائمًا وتجنب الأوامر الحاجبة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا تكون خطوط أوامر Redis أكفأ من إرسال الأوامر منفردة، ومتى يجب ألا تستخدمها؟",
      "options": [
        "تستخدم خطوط الأوامر الضغط؛ تجنبها للحمولات الصغيرة لمنع حمل المعالج",
        "تجمع خطوط الأوامر أوامر متعددة في كتابة شبكة واحدة وتقرأ كل الردود معًا، فتلغي زمن الجولة لكل أمر؛ وتجنبها حين تعتمد الأوامر على نتائج بعضها",
        "تتيح خطوط الأوامر تنفيذًا متوازيًا للأوامر عبر خيوط Redis",
        "خطوط الأوامر مفيدة لعمليات GET فقط؛ ولا يمكن وضع عمليات SET في خط"
      ],
      "correct": 1,
      "explanation": "كل أمر Redis يتكبد عادة جولة TCP كاملة. وخطوط الأوامر ترسل N أمر في مخزن كتابة واحد وتقرأ N رد معًا، فتقلل N جولة إلى واحدة. والقيد أنك لا تستطيع استخدام نتيجة الأمر N كمدخل للأمر N+1 في الخط نفسه — وللأوامر المعتمدة على بعضها، استخدم سكربتات Lua بدلًا من ذلك."
    },
    {
      "text": "في Redis Cluster، لماذا يجب أن تستخدم مفاتيح سكربت Lua متعدد المفاتيح وسوم التجزئة؟",
      "options": [
        "تتطلب سكربتات Lua وسوم التجزئة لتفعيل التخزين المؤقت على الخادم للسكربت المترجم",
        "يوزع Redis Cluster المفاتيح عبر الأجزاء بـ CRC16 لاسم المفتاح؛ ودون وسوم التجزئة قد تقع مفاتيح الحساب نفسه في أجزاء مختلفة، وستفشل الأوامر متعددة المفاتيح أو سكربتات Lua التي تعبر الأجزاء",
        "وسوم التجزئة مطلوبة لفرض TTL في وضع Redis Cluster",
        "دون وسوم التجزئة، يعيد Redis Cluster موازنة المفاتيح أثناء تنفيذ سكربت Lua فيسبب مهلًا"
      ],
      "correct": 1,
      "explanation": "يستخدم Redis Cluster ‏CRC16(key) % 16384 لتعيين كل مفتاح إلى فتحة (slot)، وتُعيَّن الفتحات إلى الأجزاء. فإذا وقع ratelimit:accountId وvelocity:accountId في أجزاء مختلفة، يفشل سكربت Lua يصل إلى كليهما بخطأ CROSSSLOT. ووسوم التجزئة ({accountId}) تجبر المفتاحين على استخدام الفتحة نفسها، فتضمن وجودهما معًا في الجزء نفسه."
    },
    {
      "text": "لماذا يجب ألا يُستخدم KEYS * أبدًا في Redis الإنتاجي وما البديل الصحيح؟",
      "options": [
        "KEYS * مُهمل في Redis 7؛ استخدم LRANGE * بدلًا منه",
        "KEYS * من رتبة O(N) ويحجب حلقة أحداث Redis أحادية الخيط طوال مدة المسح، فقد يجمّد كل الأوامر الأخرى لثوانٍ في فضاءات المفاتيح الكبيرة؛ واستخدم SCAN بالتكرار القائم على المؤشر بدلًا منه",
        "KEYS * يعمل في الوضع المستقل فقط ويفشل دائمًا في Redis Cluster",
        "KEYS * يعيد النتائج بترتيب عشوائي فيجعله غير موثوق لمعالجة الدفع"
      ],
      "correct": 1,
      "explanation": "ينفذ Redis الأوامر على خيط واحد. وKEYS * يمسح فضاء المفاتيح كله ذريًا، فيحجب كل الأوامر الأخرى أثناء عمله. وعلى نسخة بمليون مفتاح، قد يستغرق ذلك ثوانيَ. أما SCAN فيكرر على فضاء المفاتيح بأجزاء صغيرة مع تلميح COUNT، فيتيح تنفيذ أوامر أخرى بين التكرارات. والمقابل أن SCAN قد يعيد تكرارات ولا يضمن لقطة كاملة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تحديد المعدل والـ Idempotency بـ Redis لمعالجة الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "نفّذ محدد معدل بنافذة منزلقة باستخدام مجموعة Redis مرتبة وسكربت Lua يقيّد تقديمات الدفع إلى N لكل نافذة زمنية لكل حساب، باستخدام مفاتيح موسومة بالتجزئة للتوافق مع Redis Cluster."},
    {"id": "2", "description": "نفّذ مخزن مفاتيح idempotency باستخدام SET NX EX في Redis: يحجز المفتاح ذريًا عند أول تقديم، ويخزن نتيجة الدفع 24 ساعة، ويعيد النتيجة المخزنة عند التقديم المكرر. واشرح لماذا خط الأوامر ليس ذريًا (استخدم أمرًا واحدًا أو سكربت Lua) ولماذا يجب أن تفرض قاعدة البيانات مع ذلك مفتاح idempotency فريدًا."},
    {"id": "3", "description": "اكتب إعداد Spring يبلّغ عن الاتصالات النشطة/الخاملة في مجمع Redis وزمن الأوامر عبر Micrometer (مقاييس gauge مسجلة مرة واحدة)، وقاعدة تنبيه تنطلق حين يتجاوز استخدام المجمع 80%."},
    {"id": "4", "description": "اكتب اختبارات تكامل باستخدام Redis مضمّن (Testcontainers مع redis:7-alpine) تتحقق من: فرض حد المعدل، وسلوك مفتاح الـ idempotency عند التقديمات المكررة، وذرية سكربت Lua تحت الطلبات المتزامنة."}
  ]
}
-->
