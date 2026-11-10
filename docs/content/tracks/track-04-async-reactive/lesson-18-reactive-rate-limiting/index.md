---
id: track-04-lesson-18
title: "Reactive Rate Limiting — Adaptive Throttling"
slug: reactive-rate-limiting
track: track-04
trackName: "Async & Reactive Systems"
sequence: 18
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [rate-limiting, reactive, token-bucket, throttle, adaptive]
prerequisites: [track-04-lesson-03]
---

# Reactive Rate Limiting — Adaptive Throttling

> [!NOTE]
> Rate limiting in a reactive stack is not simply wrapping a blocking limiter in a `subscribeOn`. It must be non-blocking, work per-customer across service instances, and degrade gracefully when the rate limit store (Redis) is unavailable. Getting any of these wrong turns your rate limiter into a latency spike generator.

## Why Rate Limiting Matters in Financial APIs

Financial APIs face adversarial traffic patterns:
- Credential-stuffing attacks generate thousands of auth attempts per second
- Misconfigured client batch jobs retry in tight loops on error
- Partner integrations misread documentation and send payment requests at 10x expected volume
- Fraud bots probe card validation endpoints at high frequency

Rate limiting protects:
1. **Service stability** — prevents runaway clients from saturating thread pools
2. **Fair resource distribution** — prevents one customer from starving others
3. **Compliance** — some payment schemes (e.g., Mastercard) mandate per-partner rate limits
4. **Cost control** — third-party API calls (sanctions screening, identity verification) are billed per request

---

## Token Bucket Algorithm

The token bucket is the standard algorithm for financial API rate limiting because it allows controlled bursting.

```
Bucket capacity: N tokens (burst allowance)
Refill rate:     R tokens/second (sustained rate)
On request:      consume 1 token; if bucket empty, reject
```

A customer with a 100 req/s limit and 200-token bucket can burst to 200 requests then must sustain at 100 req/s. This handles legitimate payment batch windows without blocking.

```java
// In-memory token bucket for single-instance use or testing
public class TokenBucket {

    private final long capacity;         // max tokens (burst size)
    private final double refillRate;     // tokens per millisecond
    private long currentTokens;
    private long lastRefillTime;         // epoch millis

    public TokenBucket(long capacity, long refillRatePerSecond) {
        this.capacity = capacity;
        this.refillRate = refillRatePerSecond / 1000.0;
        this.currentTokens = capacity;
        this.lastRefillTime = System.currentTimeMillis();
    }

    public synchronized boolean tryAcquire() {
        refill();
        if (currentTokens >= 1) {
            currentTokens--;
            return true;
        }
        return false;
    }

    private void refill() {
        long now = System.currentTimeMillis();
        long elapsed = now - lastRefillTime;
        long newTokens = (long) (elapsed * refillRate);
        if (newTokens > 0) {
            currentTokens = Math.min(capacity, currentTokens + newTokens);
            lastRefillTime = now;
        }
    }

    // Returns milliseconds until next token is available
    public synchronized long waitTimeMillis() {
        refill();
        if (currentTokens >= 1) return 0;
        return (long) ((1 - currentTokens) / refillRate);
    }
}
```

---

## Redis-Based Reactive Rate Limiter

For distributed rate limiting across service instances, Redis is the standard store. The key insight is using Lua scripts for atomic token consumption — no race conditions.

```java
@Component
@Slf4j
public class RedisRateLimiter {

    private final ReactiveRedisTemplate<String, Long> redisTemplate;
    private final RedisScript<List<Long>> tokenBucketScript;

    public RedisRateLimiter(ReactiveRedisTemplate<String, Long> redisTemplate) {
        this.redisTemplate = redisTemplate;
        this.tokenBucketScript = RedisScript.of(TOKEN_BUCKET_LUA, List.class);
    }

    // Lua script: atomic token bucket check-and-consume
    private static final String TOKEN_BUCKET_LUA = """
        local key = KEYS[1]
        local capacity = tonumber(ARGV[1])
        local refill_rate = tonumber(ARGV[2])   -- tokens per second
        local requested = tonumber(ARGV[3])
        local now = tonumber(ARGV[4])           -- current time in milliseconds
        local ttl = tonumber(ARGV[5])           -- key TTL in seconds

        local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
        local tokens = tonumber(bucket[1]) or capacity
        local last_refill = tonumber(bucket[2]) or now

        -- Calculate token refill
        local elapsed = (now - last_refill) / 1000.0
        local new_tokens = math.min(capacity, tokens + elapsed * refill_rate)

        local allowed = 0
        local remaining = new_tokens
        if new_tokens >= requested then
            remaining = new_tokens - requested
            allowed = 1
        end

        redis.call('HMSET', key, 'tokens', remaining, 'last_refill', now)
        redis.call('EXPIRE', key, ttl)
        return {allowed, math.floor(remaining), math.floor(capacity)}
        """;

    public Mono<RateLimitResult> checkAndConsume(
        String customerId, String operation, RateLimitConfig config
    ) {
        String key = "rate-limit:%s:%s".formatted(customerId, operation);
        long now = System.currentTimeMillis();
        int ttlSeconds = (int) (config.window().getSeconds() * 2);

        return redisTemplate.execute(
                tokenBucketScript,
                List.of(key),
                List.of(
                    String.valueOf(config.capacity()),
                    String.valueOf(config.refillRatePerSecond()),
                    "1",
                    String.valueOf(now),
                    String.valueOf(ttlSeconds)
                )
            )
            .map(results -> {
                boolean allowed = ((Number) results.get(0)).intValue() == 1;
                long remaining = ((Number) results.get(1)).longValue();
                long capacity = ((Number) results.get(2)).longValue();
                return new RateLimitResult(allowed, remaining, capacity, config.refillRatePerSecond());
            })
            .single()
            .onErrorResume(ex -> {
                log.warn("Rate limiter Redis error for customerId={} — allowing request: {}",
                    customerId, ex.getMessage());
                // Fail open: Redis unavailability should not block legitimate traffic
                return Mono.just(RateLimitResult.allowed(config.capacity(), config.refillRatePerSecond()));
            });
    }
}

public record RateLimitResult(
    boolean allowed,
    long remainingTokens,
    long capacity,
    long refillRatePerSecond
) {
    public static RateLimitResult allowed(long capacity, long refillRate) {
        return new RateLimitResult(true, capacity, capacity, refillRate);
    }

    // Seconds until 1 token is available
    public double retryAfterSeconds() {
        if (allowed) return 0;
        return 1.0 / refillRatePerSecond;
    }
}

public record RateLimitConfig(
    long capacity,         // burst size
    long refillRatePerSecond,
    Duration window        // for key TTL calculation
) {}
```

---

## WebFlux Rate Limiting Filter

Apply rate limiting as a WebFlux filter so it intercepts all requests before reaching controllers.

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
@Slf4j
public class RateLimitingWebFilter implements WebFilter {

    private final RedisRateLimiter rateLimiter;
    private final RateLimitConfigRepository configRepository;
    private final MeterRegistry meterRegistry;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        return extractCustomerId(exchange)
            .flatMap(customerId ->
                configRepository.findConfigFor(customerId, operationFor(exchange))
                    .flatMap(config -> rateLimiter.checkAndConsume(customerId, operationFor(exchange), config))
                    .flatMap(result -> {
                        // Always add rate limit headers
                        addRateLimitHeaders(exchange.getResponse(), result);

                        if (result.allowed()) {
                            meterRegistry.counter("rate.limit", "outcome", "allowed",
                                "operation", operationFor(exchange)).increment();
                            return chain.filter(exchange);
                        }

                        meterRegistry.counter("rate.limit", "outcome", "throttled",
                            "operation", operationFor(exchange)).increment();
                        log.info("Rate limit exceeded customerId={} operation={}",
                            customerId, operationFor(exchange));
                        return rateLimitExceededResponse(exchange, result);
                    })
            )
            .onErrorResume(CustomerNotFoundException.class, ex -> chain.filter(exchange)); // unauthenticated allowed through
    }

    private void addRateLimitHeaders(ServerHttpResponse response, RateLimitResult result) {
        response.getHeaders().set("X-RateLimit-Remaining", String.valueOf(result.remainingTokens()));
        response.getHeaders().set("X-RateLimit-Limit", String.valueOf(result.capacity()));
        if (!result.allowed()) {
            response.getHeaders().set("Retry-After",
                String.valueOf((long) Math.ceil(result.retryAfterSeconds())));
        }
    }

    private Mono<Void> rateLimitExceededResponse(ServerWebExchange exchange, RateLimitResult result) {
        exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);

        String body = """
            {"error":"rate_limit_exceeded","retryAfter":%d,"message":"Too many requests"}
            """.formatted((long) Math.ceil(result.retryAfterSeconds()));

        DataBuffer buffer = exchange.getResponse().bufferFactory()
            .wrap(body.getBytes(StandardCharsets.UTF_8));
        return exchange.getResponse().writeWith(Mono.just(buffer));
    }

    private Mono<String> extractCustomerId(ServerWebExchange exchange) {
        return exchange.getPrincipal()
            .map(Principal::getName)
            .switchIfEmpty(Mono.error(new CustomerNotFoundException("No principal")));
    }

    private String operationFor(ServerWebExchange exchange) {
        String path = exchange.getRequest().getPath().value();
        String method = exchange.getRequest().getMethod().name();
        return method + ":" + path.replaceAll("/[0-9a-f-]{36}", "/{id}");
    }
}
```

---

## Resilience4j Rate Limiter with Reactor

For programmatic rate limiting inside service methods, Resilience4j integrates cleanly with Reactor.

```java
@Service
@Slf4j
public class SanctionsScreeningService {

    private final SanctionsApiClient apiClient;
    private final RateLimiter rateLimiter;

    public SanctionsScreeningService(
        SanctionsApiClient apiClient,
        RateLimiterRegistry registry
    ) {
        this.apiClient = apiClient;
        // 10 calls/second to external sanctions API (contractual limit)
        this.rateLimiter = registry.rateLimiter("sanctions-api",
            RateLimiterConfig.custom()
                .limitForPeriod(10)
                .limitRefreshPeriod(Duration.ofSeconds(1))
                .timeoutDuration(Duration.ofMillis(500))
                .build()
        );
    }

    public Mono<ScreeningResult> screen(String name, String dateOfBirth, String nationality) {
        return Mono.defer(() ->
            apiClient.checkSanctionsList(name, dateOfBirth, nationality)
        )
        .transformDeferred(RateLimiterOperator.of(rateLimiter))
        .onErrorMap(RequestNotPermitted.class, ex ->
            new SanctionsApiRateLimitException("Sanctions API rate limit reached: " + ex.getMessage())
        )
        .doOnSuccess(r -> log.debug("Sanctions check completed name={} result={}", name, r.status()))
        .doOnError(ex -> log.error("Sanctions check failed name={}", name, ex));
    }

    // Bulk screening — rate-limits the stream to 10 items/second
    public Flux<ScreeningResult> screenBatch(Flux<ScreeningRequest> requests) {
        return requests
            .flatMap(request ->
                screen(request.name(), request.dateOfBirth(), request.nationality())
                    .map(result -> result.withRequest(request)),
                1 // concurrency=1 to let the rate limiter control throughput
            );
    }
}
```

---

## Per-Customer Rate Limit Configuration

Different customer tiers have different rate limits. Load configuration reactively and cache it.

```java
@Service
public class RateLimitConfigRepository {

    private final CustomerRepository customerRepository;
    private final RateLimitTierRepository tierRepository;
    private final ReactiveRedisTemplate<String, RateLimitConfig> configCache;
    private static final Duration CONFIG_CACHE_TTL = Duration.ofMinutes(5);

    public Mono<RateLimitConfig> findConfigFor(String customerId, String operation) {
        String cacheKey = "rate-config:%s:%s".formatted(customerId, operation);

        return configCache.opsForValue().get(cacheKey)
            .switchIfEmpty(Mono.defer(() ->
                customerRepository.findById(customerId)
                    .flatMap(customer ->
                        tierRepository.findByTierName(customer.rateLimitTier())
                    )
                    .map(tier -> configForOperation(tier, operation))
                    .flatMap(config ->
                        configCache.opsForValue()
                            .set(cacheKey, config, CONFIG_CACHE_TTL)
                            .thenReturn(config)
                    )
                    .defaultIfEmpty(defaultConfig())
            ));
    }

    private RateLimitConfig configForOperation(RateLimitTier tier, String operation) {
        return switch (operation) {
            case "POST:/payments"    -> new RateLimitConfig(tier.paymentBurst(), tier.paymentRate(), Duration.ofSeconds(1));
            case "POST:/transfers"   -> new RateLimitConfig(tier.transferBurst(), tier.transferRate(), Duration.ofSeconds(1));
            case "GET:/balance"      -> new RateLimitConfig(tier.inquiryBurst(), tier.inquiryRate(), Duration.ofSeconds(1));
            default                  -> defaultConfig();
        };
    }

    private RateLimitConfig defaultConfig() {
        return new RateLimitConfig(50, 10, Duration.ofSeconds(1)); // conservative default
    }
}
```

---

## Adaptive Throttling

Adaptive throttling adjusts rate limits dynamically based on downstream error rates. When downstream services start returning errors, reduce the rate proactively before circuit breakers open.

```java
@Component
@Slf4j
public class AdaptiveRateLimiter {

    private final RedisRateLimiter baseRateLimiter;
    private final MeterRegistry meterRegistry;

    // Track error rates per downstream service
    private final Map<String, AtomicDouble> serviceErrorRates = new ConcurrentHashMap<>();

    public Mono<RateLimitResult> checkAndConsume(
        String customerId, String operation, String downstreamService, RateLimitConfig baseConfig
    ) {
        double errorRate = serviceErrorRates
            .getOrDefault(downstreamService, new AtomicDouble(0))
            .get();

        // Reduce capacity proportionally to error rate
        // 0% errors -> full capacity; 50% errors -> 50% capacity; 80% errors -> 20% capacity
        long adjustedCapacity = (long) (baseConfig.capacity() * Math.max(0.1, 1.0 - errorRate));
        long adjustedRate = (long) (baseConfig.refillRatePerSecond() * Math.max(0.1, 1.0 - errorRate));

        RateLimitConfig adaptedConfig = new RateLimitConfig(
            adjustedCapacity, adjustedRate, baseConfig.window()
        );

        if (adjustedCapacity < baseConfig.capacity()) {
            log.debug("Adaptive throttle applied service={} errorRate={:.2f} reducedCapacity={}",
                downstreamService, errorRate, adjustedCapacity);
        }

        return baseRateLimiter.checkAndConsume(customerId, operation, adaptedConfig);
    }

    // Called by circuit breaker / health checks to update error rates
    @Scheduled(fixedRate = 10_000)
    public void updateErrorRates() {
        // Fetch error rates from Micrometer or Prometheus
        meterRegistry.getMeters().stream()
            .filter(m -> m.getId().getName().equals("downstream.error.rate"))
            .forEach(meter -> {
                String service = meter.getId().getTag("service");
                double rate = ((Gauge) meter).value();
                serviceErrorRates.computeIfAbsent(service, k -> new AtomicDouble()).set(rate);
            });
    }
}
```

---

## Testing Rate Limiting in Reactive Pipelines

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RateLimitingTest {

    @Autowired
    private WebTestClient webTestClient;

    @Autowired
    private RedisRateLimiter rateLimiter;

    @Test
    void shouldThrottle429WhenLimitExceeded() {
        // Send 11 requests when limit is 10/second
        List<WebTestClient.ResponseSpec> responses = IntStream.range(0, 11)
            .mapToObj(i -> webTestClient.post()
                .uri("/payments")
                .header("Authorization", "Bearer test-token")
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .bodyValue(stubPaymentRequest())
                .exchange()
            )
            .collect(toList());

        long successCount = responses.stream()
            .filter(r -> r.returnResult(String.class).getStatus().is2xxSuccessful())
            .count();
        long throttledCount = responses.stream()
            .filter(r -> r.returnResult(String.class).getStatus() == HttpStatus.TOO_MANY_REQUESTS)
            .count();

        assertThat(successCount).isEqualTo(10);
        assertThat(throttledCount).isEqualTo(1);
    }

    @Test
    void shouldIncludeRateLimitHeaders() {
        webTestClient.post()
            .uri("/payments")
            .header("Authorization", "Bearer test-token")
            .header("Idempotency-Key", UUID.randomUUID().toString())
            .bodyValue(stubPaymentRequest())
            .exchange()
            .expectHeader().exists("X-RateLimit-Remaining")
            .expectHeader().exists("X-RateLimit-Limit");
    }

    @Test
    void shouldReturnRetryAfterWhenThrottled() {
        // Exhaust the bucket
        exhaustRateLimitBucket("test-customer", "POST:/payments");

        webTestClient.post()
            .uri("/payments")
            .header("Authorization", "Bearer test-token")
            .header("Idempotency-Key", UUID.randomUUID().toString())
            .bodyValue(stubPaymentRequest())
            .exchange()
            .expectStatus().isEqualTo(HttpStatus.TOO_MANY_REQUESTS)
            .expectHeader().exists("Retry-After")
            .expectBody()
                .jsonPath("$.error").isEqualTo("rate_limit_exceeded")
                .jsonPath("$.retryAfter").isNumber();
    }

    @Test
    void shouldTokenBucketAllowBurstThenThrottle() {
        // With capacity=5, rate=1/s: burst 5 should succeed, 6th should throttle
        RateLimitConfig config = new RateLimitConfig(5, 1, Duration.ofSeconds(1));

        List<Mono<RateLimitResult>> requests = IntStream.range(0, 6)
            .mapToObj(i -> rateLimiter.checkAndConsume("cust-burst-test", "burst-op", config))
            .collect(toList());

        List<RateLimitResult> results = Flux.concat(requests)
            .collectList()
            .block();

        long allowed = results.stream().filter(RateLimitResult::allowed).count();
        long denied = results.stream().filter(r -> !r.allowed()).count();

        assertThat(allowed).isEqualTo(5);
        assertThat(denied).isEqualTo(1);
    }
}
```

---

## Production Considerations

**Fail open vs fail closed**: When Redis is unavailable, failing closed (denying all requests) protects downstream services but kills your business. Failing open (allowing all requests) risks overload. The right answer is fail open with an alert and fallback to in-memory limiting with conservative defaults.

**Rate limit key granularity**: `customerId:operation` is the minimum. For regulated APIs, also limit by `customerId:operation:ip` to catch credential-sharing abuse while not penalizing legitimate high-volume customers.

**Burst configuration per tier**:
- Free tier: capacity=20, rate=5/s — small batch, no burst abuse
- Standard tier: capacity=200, rate=50/s — normal business usage
- Enterprise tier: capacity=2000, rate=500/s — high-volume integrations

**Rate limit quota resets**: For monthly quota limits (common in Open Banking), use sliding window counters in Redis with a `ZADD + ZREMRANGEBYSCORE` pattern rather than token buckets.

**Key metrics to monitor**:
- `rate.limit{outcome=throttled}` by `operation` — reveals abusive or misconfigured clients
- `rate.limit.redis.latency` histogram — rate limiter must not add significant latency
- `rate.limit.redis.errors` — degradation to in-memory mode
- `rate.limit.bucket.utilization` by `customerId` — identifies customers approaching their limits

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What advantage does the token bucket algorithm have over a fixed window counter for financial API rate limiting?",
      "options": ["Token bucket is simpler to implement in Redis than a counter", "Token bucket allows controlled bursting: a customer can use accumulated tokens for a short burst above the sustained rate, accommodating legitimate payment batch windows without hard cutoffs", "Token bucket guarantees exactly N requests per second with no variance", "Fixed window counters do not work in distributed systems; token buckets do"],
      "correct": 1,
      "explanation": "Fixed window counters reset sharply at the window boundary — a customer using 0 requests in the first window and all in the second gets double the rate. Token buckets refill continuously, allowing burst up to bucket capacity then settling at the refill rate. This matches real payment patterns better."
    },
    {
      "text": "Why must a reactive rate limiter's Redis operations be non-blocking, and what goes wrong if they block?",
      "options": ["Redis does not support blocking operations", "If the rate limiter's Redis call blocks a Netty event-loop thread, it stalls all other requests on that event loop — turning a rate-limiting check into a service-wide latency spike that defeats its protective purpose", "Blocking Redis calls prevent TTL from being set on rate limit keys", "Redis Lua scripts require non-blocking clients to execute correctly"],
      "correct": 1,
      "explanation": "The rate limiter sits on the payment critical path — every request passes through it. Blocking an event-loop thread while waiting for Redis stalls all other concurrent requests on that thread. The fix is to use Lettuce (reactive Redis client) which returns Mono<Long>, keeping the entire check non-blocking."
    },
    {
      "text": "What should a reactive rate limiter do when Redis becomes unavailable — reject all requests or allow them through?",
      "options": ["Always reject requests when Redis is unavailable to prevent abuse", "Degrade gracefully to an in-memory rate limiter per instance, emitting a Redis-unavailable metric and accepting that rate limiting precision is reduced", "Terminate the application and restart when Redis reconnects", "Queue all requests in memory until Redis recovers"],
      "correct": 1,
      "explanation": "Rejecting all requests when the rate limit store is unavailable turns a rate limiter into an availability risk. The correct approach is degradation: fall back to per-instance in-memory limiting (which provides weaker but non-zero protection), alert on Redis unavailability, and resume precise distributed limiting when Redis recovers."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Distributed Reactive Rate Limiter for a Financial API Gateway",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a Redis-backed token bucket rate limiter using a Lua script for atomic check-and-decrement. The script should take bucket capacity, refill rate, and customer ID as arguments and return 1 (allowed) or 0 (throttled) with remaining tokens. Use Lettuce reactive client to call the script and return Mono<RateLimitDecision>."},
    {"id": "2", "description": "Integrate the rate limiter as a Spring WebFilter in a WebFlux payment API: extract the customer ID from the JWT claims, call the rate limiter, and return HTTP 429 with Retry-After header on throttle. For allowed requests, add X-RateLimit-Remaining and X-RateLimit-Reset headers. Test with WebTestClient that burst of 201 requests at a 200/s limit results in exactly 1 throttled response."},
    {"id": "3", "description": "Implement Redis degradation: wrap the Redis call in onErrorResume that falls back to an in-memory ConcurrentHashMap<customerId, TokenBucket> when Redis is unavailable. Emit a rate.limit.redis.errors counter on each fallback. Simulate Redis unavailability in a test using a Mock and verify the service continues accepting requests."},
    {"id": "4", "description": "Build an adaptive rate limiter that tightens limits automatically when downstream error rate increases: monitor a payment.errors counter and reduce allowed rate by 50% when error rate exceeds 5% for 60 seconds, then restore gradually when error rate returns below 1%. Implement this as a reactive pipeline using Flux.interval() to periodically adjust bucket configurations in Redis."}
  ]
}
-->

---
