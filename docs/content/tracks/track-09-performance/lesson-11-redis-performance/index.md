---
id: track-09-lesson-11
title: "Redis Performance — Pipelining, Scripting, and Data Structures"
slug: redis-performance
track: track-09
trackName: "Performance Engineering"
sequence: 11
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Redis, pipelining, Lua, data-structures, latency]
prerequisites: [track-09-lesson-10]
---

# Redis Performance — Pipelining, Scripting, and Data Structures

> [!NOTE]
> Redis is single-threaded for command execution, which means its performance profile is entirely dominated by network round-trip time, not compute. Every architectural decision — pipelining, scripting, data structure selection — is about minimizing round trips and maximizing the work done per command.

## 1. Redis Pipelining — Batching Commands to Reduce Round Trips

Without pipelining, each command requires a full network round trip:

```
Client -> COMMAND_1 -> Server -> RESPONSE_1 -> Client  (1 RTT)
Client -> COMMAND_2 -> Server -> RESPONSE_2 -> Client  (1 RTT)
Client -> COMMAND_3 -> Server -> RESPONSE_3 -> Client  (1 RTT)
```

With pipelining, multiple commands are sent in one network write:

```
Client -> [COMMAND_1, COMMAND_2, COMMAND_3] -> Server  (1 RTT)
Client <- [RESPONSE_1, RESPONSE_2, RESPONSE_3] <- Server
```

### Pipelining with Lettuce (Spring Boot default)

```java
@Service
public class RedisPipelineService {

    private final RedisTemplate<String, String> redisTemplate;
    private final StringRedisTemplate stringRedisTemplate;

    /**
     * Load multiple account metadata fields in one round trip.
     * Without pipelining: N round trips for N accounts.
     * With pipelining: 1 round trip for all N accounts.
     */
    public Map<String, AccountMetadata> loadAccountsBatch(List<String> accountIds) {
        List<Object> results = redisTemplate.executePipelined(
            (RedisCallback<Object>) connection -> {
                accountIds.forEach(id ->
                    connection.hGetAll(("account:" + id).getBytes())
                );
                return null; // return value is ignored; results collected separately
            }
        );

        Map<String, AccountMetadata> output = new HashMap<>();
        for (int i = 0; i < accountIds.size(); i++) {
            Map<byte[], byte[]> fields = (Map<byte[], byte[]>) results.get(i);
            if (fields != null && !fields.isEmpty()) {
                output.put(accountIds.get(i), deserializeAccountMetadata(fields));
            }
        }
        return output;
    }

    /**
     * Record multiple velocity counters in one round trip.
     * Used in fraud detection: increment daily/hourly transaction counts per account.
     */
    public void recordVelocityCounters(UUID accountId, BigDecimal amount) {
        String prefix = "velocity:" + accountId;
        Instant now = Instant.now();
        String hourKey  = prefix + ":hour:"  + now.truncatedTo(ChronoUnit.HOURS).getEpochSecond();
        String dayKey   = prefix + ":day:"   + LocalDate.now();
        String monthKey = prefix + ":month:" + YearMonth.now();

        redisTemplate.executePipelined((RedisCallback<Object>) conn -> {
            byte[] amountBytes = amount.toPlainString().getBytes();

            // Increment count
            conn.incr(hourKey.getBytes());
            conn.incr(dayKey.getBytes());
            conn.incr(monthKey.getBytes());

            // Add to sum (using INCRBYFLOAT on a separate key)
            conn.incrBy((hourKey  + ":sum").getBytes(), amount.longValue());
            conn.incrBy((dayKey   + ":sum").getBytes(), amount.longValue());
            conn.incrBy((monthKey + ":sum").getBytes(), amount.longValue());

            // Set TTL (expire at end of period)
            conn.expire(hourKey.getBytes(), 3600L);
            conn.expire(dayKey.getBytes(), 86400L);
            conn.expire(monthKey.getBytes(), 2678400L);  // 31 days

            conn.expire((hourKey  + ":sum").getBytes(), 3600L);
            conn.expire((dayKey   + ":sum").getBytes(), 86400L);
            conn.expire((monthKey + ":sum").getBytes(), 2678400L);

            return null;
        });
    }
}
```

### Pipeline Throughput Benchmarks

```
Single command (no pipeline):  RTT = 0.5ms  -> 2,000 ops/sec
Pipeline 10 commands:          RTT = 0.6ms  -> 16,667 ops/sec (8x)
Pipeline 100 commands:         RTT = 1.5ms  -> 66,667 ops/sec (33x)
Pipeline 1000 commands:        RTT = 10ms   -> 100,000 ops/sec (50x)
```

**Rule of thumb**: Batch size of 50–200 commands gives the best throughput-to-latency ratio. Larger batches increase latency for the first item in the batch.

## 2. Lua Scripting for Atomic Operations

Lua scripts execute atomically on the Redis server — no other command can interleave during script execution. This is essential for operations that must be atomic but require multiple commands.

### Rate Limiting Script

```java
@Component
public class RedisRateLimiter {

    private final RedisTemplate<String, String> redisTemplate;

    // Lua script: sliding window rate limiter
    // Returns: [allowed (1/0), current_count, ttl_ms]
    private static final String RATE_LIMIT_SCRIPT = """
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window_ms = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local window_start = now - window_ms

        -- Remove expired entries from sorted set
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current requests in window
        local count = redis.call('ZCARD', key)

        if count < limit then
            -- Add current request with timestamp as score
            redis.call('ZADD', key, now, now .. '-' .. math.random())
            -- Set TTL to window size
            redis.call('PEXPIRE', key, window_ms)
            return {1, count + 1, window_ms}
        else
            local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
            local retry_after = window_ms - (now - tonumber(oldest[2]))
            return {0, count, retry_after}
        end
        """;

    private final RedisScript<List<Long>> rateLimitScript;

    @PostConstruct
    public void initScript() {
        rateLimitScript = RedisScript.of(RATE_LIMIT_SCRIPT, List.class);
    }

    /**
     * Check rate limit for an account.
     * @param accountId the account to rate limit
     * @param limit max requests per window
     * @param windowMillis sliding window duration in ms
     * @return RateLimitResult with allowed flag and retry-after
     */
    public RateLimitResult checkRateLimit(String accountId, int limit, long windowMillis) {
        String key = "ratelimit:" + accountId;
        long now = System.currentTimeMillis();

        List<Long> result = redisTemplate.execute(
            rateLimitScript,
            Collections.singletonList(key),
            String.valueOf(limit),
            String.valueOf(windowMillis),
            String.valueOf(now)
        );

        boolean allowed = result.get(0) == 1L;
        long currentCount = result.get(1);
        long retryAfterMs = result.get(2);

        return new RateLimitResult(allowed, currentCount, limit,
            allowed ? 0 : retryAfterMs);
    }
}
```

### Idempotency Deduplication Script

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

### Account Balance Lock Script

```java
@Component
public class DistributedLockService {

    /**
     * Redlock-compatible SET NX EX for distributed locking.
     * Returns the lock token if acquired, null otherwise.
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

## 3. Redis Data Structure Selection

Choosing the right data structure is as important as any other Redis optimization.

### Sorted Sets — Velocity and Leaderboards

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
        double maxScore = Double.MAX_VALUE;

        return redisTemplate.opsForZSet().count(key, minScore, maxScore);
    }

    /**
     * Remove old entries to prevent unbounded growth.
     * Run periodically or on each write.
     */
    public void pruneOldEntries(UUID accountId, Duration retentionWindow) {
        String key = "velocity:txn:" + accountId;
        double cutoff = System.currentTimeMillis() - retentionWindow.toMillis();
        redisTemplate.opsForZSet().removeRangeByScore(key, Double.MIN_VALUE, cutoff);
    }
}
```

### Hashes — Account and Session Data

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
     * Partial update: only update changed fields without touching others.
     */
    public void updateAccountStatus(UUID accountId, String newStatus) {
        String key = "account:" + accountId;
        redisTemplate.opsForHash().put(key, "status", newStatus);
        // No need to reload/reserialize the entire account object
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

### Streams — Durable Event Log

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

## 4. LATENCY HISTORY and SLOWLOG Analysis

```java
@Component
@Slf4j
public class RedisLatencyMonitor {

    private final RedisConnectionFactory connectionFactory;
    private final MeterRegistry metrics;

    /**
     * Query Redis SLOWLOG for commands exceeding the threshold.
     * Default threshold: 10ms (slowlog-log-slower-than 10000 microseconds).
     */
    @Scheduled(fixedRate = 60_000)
    public void reportSlowLog() {
        try (RedisConnection conn = connectionFactory.getConnection()) {
            List<Object> slowlog = conn.serverCommands().slowlogGet(10);

            if (slowlog != null && !slowlog.isEmpty()) {
                log.warn("Redis slowlog has {} entries in last 60s", slowlog.size());
                // Parse and emit as metrics
                metrics.gauge("redis.slowlog.count",
                    Tags.of("instance", "primary"),
                    slowlog.size());
            }
        }
    }

    /**
     * Monitor Redis latency events via LATENCY HISTORY.
     * Redis tracks event latency for: command, fast-command, net
     */
    @Scheduled(fixedRate = 30_000)
    public void reportLatencyHistory() {
        try (RedisConnection conn = connectionFactory.getConnection()) {
            // Get latest latency sample
            Properties info = conn.serverCommands().info("latencystats");
            if (info != null) {
                info.forEach((key, value) -> {
                    if (key.toString().startsWith("latency_percentiles_usec_")) {
                        String cmd = key.toString()
                            .replace("latency_percentiles_usec_", "");
                        log.debug("Redis command {} latency: {}", cmd, value);
                    }
                });
            }
        }
    }
}
```

### Configuring Slowlog

```
# redis.conf
slowlog-log-slower-than 5000    # log commands > 5ms (5000 microseconds)
slowlog-max-len 256             # keep last 256 entries

# In application.yml via Spring
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

## 5. Memory Optimization — Encoding Thresholds

Redis uses compact encodings for small collections. When a collection grows beyond threshold, it switches to a full hash table, consuming significantly more memory.

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

    /**
     * Use compact keys to reduce memory overhead.
     * Redis stores key names in memory — verbose keys waste RAM.
     */
    private static final String ACCT_KEY_PREFIX    = "a:";  // not "account:"
    private static final String VELOCITY_KEY_PREFIX = "v:"; // not "velocity:"
    private static final String RATELIMIT_KEY_PREFIX = "r:"; // not "ratelimit:"

    /**
     * Check object encoding to verify compact encoding is used.
     */
    public void checkEncoding(String key) {
        String encoding = redisTemplate.execute(
            (RedisCallback<String>) conn ->
                new String(conn.keyCommands().dump(key.getBytes()))
        );
        // If encoding shows "hashtable" instead of "listpack" for small maps,
        // reduce hash-max-listpack-entries in redis.conf
    }

    /**
     * Monitor memory usage per key pattern using MEMORY USAGE command.
     */
    public long getKeyMemoryBytes(String key) {
        return redisTemplate.execute(
            (RedisCallback<Long>) conn ->
                conn.serverCommands().memoryUsage(key.getBytes())
        );
    }
}
```

## 6. Redisson vs Lettuce — Client Comparison

| Feature | Lettuce | Redisson |
|---|---|---|
| Async/Reactive | Native (Netty) | Via CompletableFuture |
| Cluster support | Yes | Yes |
| Distributed locks | Manual | RLock API |
| Rate limiter | Manual Lua | RRateLimiter API |
| Pub/Sub | Yes | Yes |
| Streams | Yes | Yes |
| Spring Boot integration | Default | Separate starter |
| Performance overhead | Lower | Higher (more abstraction) |

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
            .setRetryAttempts(3)
            .setRetryInterval(100);

        return Redisson.create(config);
    }

    // Distributed lock via Redisson
    @Bean
    public RLock accountLock(RedissonClient redisson) {
        return redisson.getFairLock("account-processing-lock");
    }
}
```

## 7. Redis Cluster Key Distribution

In Redis Cluster, keys are distributed across shards using CRC16 of the key. Keys that must be in the same shard for multi-key commands or Lua scripts must use hash tags.

```java
@Service
public class ClusterAwareService {

    /**
     * Without hash tags, these keys may land on different shards.
     * Multi-key commands (MGET, pipeline across keys, Lua) will fail
     * if keys span multiple shards.
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
    public void processWithCluster(UUID accountId) {
        String rateLimitKey = "ratelimit:{" + accountId + "}";
        String velocityKey  = "velocity:{" + accountId + "}";
        String sessionKey   = "session:{" + accountId + "}";

        // These are guaranteed to be on the same shard
        // so a Lua script can safely access all three
        redisTemplate.executePipelined((RedisCallback<Object>) conn -> {
            conn.get(rateLimitKey.getBytes());
            conn.get(velocityKey.getBytes());
            conn.hGetAll(sessionKey.getBytes());
            return null;
        });
    }
}
```

## 8. Connection Pool Sizing for Payment Services

```yaml
# application.yml
spring:
  data:
    redis:
      lettuce:
        pool:
          # Formula: max-active = (threads per service instance) * 0.5
          # Rationale: Redis commands are fast (sub-ms), so threads don't hold
          # connections for long. 50% of threads holding connections at peak
          # is a safe upper bound.
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
@Component
@Slf4j
public class RedisConnectionPoolMonitor {

    private final GenericObjectPoolConfig<?> poolConfig;
    private final MeterRegistry metrics;

    @Scheduled(fixedRate = 15_000)
    public void reportPoolStats() {
        // If using Lettuce with connection pooling, monitor via JMX or
        // Spring Actuator's redis health endpoint
        metrics.gauge("redis.pool.active_connections",
            Tags.of("instance", "primary"),
            getActiveConnections());

        metrics.gauge("redis.pool.idle_connections",
            Tags.of("instance", "primary"),
            getIdleConnections());
    }
}
```

## 9. Performance Benchmarks for Common Payment Operations

| Operation | Data Structure | Complexity | Typical Latency |
|---|---|---|---|
| Account cache lookup | Hash (HGETALL) | O(N fields) | 0.3–0.8 ms |
| Idempotency check | String (GET) | O(1) | 0.1–0.3 ms |
| Rate limit check | Sorted Set + Lua | O(log N) | 0.5–1.5 ms |
| Velocity count | Sorted Set (ZCOUNT) | O(log N) | 0.3–0.8 ms |
| Session load | Hash (HMGET 5 fields) | O(N fields) | 0.2–0.5 ms |
| Pipeline 50 commands | Any | O(N) total | 0.8–2.0 ms total |
| Distributed lock acquire | String (SET NX EX) | O(1) | 0.3–0.8 ms |

## 10. Redis Anti-Patterns in Financial Services

```java
// ANTI-PATTERN 1: KEYS command in production
// KEYS is O(N) and blocks Redis for the entire scan duration
// On a 1M key instance, KEYS * takes seconds and freezes all other commands
redisTemplate.keys("account:*");  // NEVER in production

// CORRECT: Use SCAN with cursor
ScanOptions options = ScanOptions.scanOptions().match("account:*").count(100).build();
Cursor<byte[]> cursor = redisTemplate.getConnectionFactory()
    .getConnection().keyCommands().scan(options);
while (cursor.hasNext()) {
    byte[] key = cursor.next();
    // process
}

// ANTI-PATTERN 2: Storing large objects in a single string
// Serializing a 100KB account object on every read/write wastes bandwidth
redisTemplate.opsForValue().set("account:" + id, serialize(bigAccountObject));

// CORRECT: Use Hash and only fetch needed fields
redisTemplate.opsForHash().multiGet("account:" + id,
    List.of("balance", "currency", "status"));

// ANTI-PATTERN 3: No TTL on keys
redisTemplate.opsForValue().set("temp-data:" + id, value);
// If the cleanup code fails, this key lives forever

// CORRECT: Always set TTL
redisTemplate.opsForValue().set("temp-data:" + id, value, Duration.ofMinutes(30));

// ANTI-PATTERN 4: Using Redis as a primary transaction store
// Redis is not durable by default (AOF must be enabled and fsync configured)
// Never use Redis as the primary store for financial transactions
// Use it as a cache/auxiliary store only
```

> [!WARNING]
> Redis's single-threaded command execution means one slow command (such as `KEYS *` or a long-running Lua script) blocks all other commands. In a payment system, a single Redis command that takes 100ms can delay thousands of concurrent payment operations. Always profile Lua scripts and avoid blocking commands.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why is Redis pipelining more efficient than sending individual commands, and when should you NOT pipeline?",
      "options": [
        "Pipelining uses compression; avoid it for small payloads to prevent CPU overhead",
        "Pipelining batches multiple commands in one network write and reads all responses together, eliminating per-command round-trip latency; avoid pipelining when commands depend on each other's results",
        "Pipelining enables parallel command execution across Redis threads",
        "Pipelining is only beneficial for GET operations; SET operations cannot be pipelined"
      ],
      "correct": 1,
      "explanation": "Each Redis command normally incurs a full TCP round-trip. Pipelining sends N commands in one write buffer and reads N responses together, reducing N round-trips to 1. The limitation is that you cannot use the result of command N as input to command N+1 within the same pipeline — for dependent commands, use Lua scripts instead."
    },
    {
      "text": "In Redis Cluster, why must keys for a multi-key Lua script use hash tags?",
      "options": [
        "Lua scripts require hash tags to enable server-side caching of the compiled script",
        "Redis Cluster distributes keys across shards by CRC16 of the key name; without hash tags, keys for the same account may land on different shards, and multi-key commands or Lua scripts that cross shards will fail",
        "Hash tags are required for TTL enforcement in Redis Cluster mode",
        "Without hash tags, Redis Cluster rebalances keys during Lua script execution causing timeouts"
      ],
      "correct": 1,
      "explanation": "Redis Cluster uses CRC16(key) % 16384 to assign each key to a slot, and slots are assigned to shards. If ratelimit:accountId and velocity:accountId land on different shards, a Lua script accessing both will fail with CROSSSLOT error. Hash tags ({accountId}) force both keys to use the same slot, guaranteeing co-location on the same shard."
    },
    {
      "text": "Why should KEYS * never be used in production Redis and what is the correct alternative?",
      "options": [
        "KEYS * is deprecated in Redis 7; use LRANGE * instead",
        "KEYS * is O(N) and blocks Redis's single-threaded event loop for the entire scan duration, potentially freezing all other commands for seconds on large keyspaces; use SCAN with cursor-based iteration instead",
        "KEYS * only works in standalone mode and always fails in Redis Cluster",
        "KEYS * returns results in random order making it unreliable for payment processing"
      ],
      "correct": 1,
      "explanation": "Redis executes commands on a single thread. KEYS * scans the entire keyspace atomically, blocking all other commands while it runs. On an instance with 1 million keys, this can take seconds. SCAN iterates the keyspace in small chunks with COUNT hint, allowing other commands to execute between iterations. The tradeoff is that SCAN may return duplicates and does not guarantee a complete snapshot."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Redis Rate Limiting and Idempotency for Payment Processing",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Implement a sliding window rate limiter using a Redis Sorted Set and Lua script that limits payment submissions to N per time window per account, using hash-tagged keys for Redis Cluster compatibility."},
    {"id": "2", "description": "Implement an idempotency key store using Redis SET NX EX that: stores payment result for 24 hours, returns the stored result on duplicate submission, and uses pipelining to check idempotency and store result atomically."},
    {"id": "3", "description": "Write a RedisConnectionPoolMonitor Spring component that reports pool active/idle connections and latency percentiles via Micrometer, and fires an alert when pool utilization exceeds 80%."},
    {"id": "4", "description": "Write integration tests using an embedded Redis (Testcontainers with redis:7-alpine) that verify: rate limit enforcement, idempotency key behavior on duplicate submissions, and Lua script atomicity under concurrent requests."}
  ]
}
-->

