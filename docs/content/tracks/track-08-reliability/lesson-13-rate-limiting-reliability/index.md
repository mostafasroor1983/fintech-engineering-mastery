---
id: track-08-lesson-13
title: "Rate Limiting for Reliability — Protecting Downstream Services"
slug: rate-limiting-reliability
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 13
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [rate-limiting, token-bucket, sliding-window, downstream-protection]
prerequisites: [track-08-lesson-02, track-08-lesson-03]
---

# Rate Limiting for Reliability — Protecting Downstream Services

> [!NOTE]
> Rate limiting is primarily a reliability pattern, not just an API security measure. A burst of legitimate payment requests — end-of-month bill payments, a marketing campaign, a downstream service recovering from an outage — can overload a payment processor, database connection pool, or third-party API. Rate limiting protects these downstream dependencies from traffic they cannot absorb, preventing cascading failures.

## Rate Limiting as a Reliability Pattern

The reliability use case is different from the API access control use case:

**Security rate limiting**: Prevent abuse of an API endpoint by external callers. Per-client, per-IP limits.

**Reliability rate limiting**: Protect downstream dependencies from burst traffic. Per-service, per-resource limits. This applies to calls your service makes to other services, not just calls made to yours.

Examples:
- Payment processor accepts 500 TPS; your service generates 2,000 TPS bursts
- Sanctions screening API has a rate limit of 100 req/s; batch job fires 1,000 req/s
- Database connection pool has 20 connections; 500 concurrent requests arrive

---

## 1. Token Bucket Algorithm

The token bucket is the most common rate limiting algorithm. A bucket holds tokens; each request consumes a token; tokens refill at a fixed rate. It permits short bursts up to the bucket capacity while enforcing a long-term average rate.

```java
@Component
public class TokenBucketRateLimiter {

    private final RedisTemplate<String, String> redisTemplate;

    // Lua script for atomic token bucket in Redis
    // Arguments: key, maxTokens, refillRatePerSecond, requestedTokens
    // Returns: [allowed(0/1), remainingTokens, retryAfterMs]
    private static final String TOKEN_BUCKET_SCRIPT = """
        local key = KEYS[1]
        local maxTokens = tonumber(ARGV[1])
        local refillRate = tonumber(ARGV[2])
        local requested = tonumber(ARGV[3])
        local now = tonumber(ARGV[4])

        local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
        local tokens = tonumber(bucket[1]) or maxTokens
        local lastRefill = tonumber(bucket[2]) or now

        -- Refill tokens based on elapsed time
        local elapsed = math.max(0, now - lastRefill)
        local newTokens = math.min(maxTokens, tokens + elapsed * refillRate / 1000)

        if newTokens >= requested then
            newTokens = newTokens - requested
            redis.call('HMSET', key, 'tokens', newTokens, 'lastRefill', now)
            redis.call('EXPIRE', key, 3600)
            return {1, math.floor(newTokens), 0}
        else
            local waitMs = math.ceil((requested - newTokens) / refillRate * 1000)
            redis.call('HMSET', key, 'tokens', newTokens, 'lastRefill', now)
            redis.call('EXPIRE', key, 3600)
            return {0, math.floor(newTokens), waitMs}
        end
        """;

    private final RedisScript<List<Long>> tokenBucketScript;

    @PostConstruct
    public void init() {
        this.tokenBucketScript = RedisScript.of(TOKEN_BUCKET_SCRIPT, List.class);
    }

    public RateLimitResult tryAcquire(String key, int maxTokens,
                                       double refillRatePerSecond, int tokens) {
        long nowMs = System.currentTimeMillis();
        List<Long> result = redisTemplate.execute(
                tokenBucketScript,
                List.of(key),
                String.valueOf(maxTokens),
                String.valueOf(refillRatePerSecond),
                String.valueOf(tokens),
                String.valueOf(nowMs));

        boolean allowed  = result.get(0) == 1L;
        long remaining   = result.get(1);
        long retryAfterMs = result.get(2);

        return RateLimitResult.builder()
                .allowed(allowed)
                .remaining(remaining)
                .retryAfterMs(retryAfterMs)
                .build();
    }
}
```

---

## 2. Sliding Window Counter with Redis

The sliding window is more accurate than fixed-window counting because it doesn't have the boundary problem (a client can make 2x the limit by straddling a window boundary).

```java
@Component
public class SlidingWindowRateLimiter {

    private final RedisTemplate<String, String> redisTemplate;

    // Sliding window using Redis ZSET
    // Members: request UUID, Score: timestamp (ms)
    // Window: remove entries older than windowMs, count remaining, compare to limit
    public RateLimitResult check(String key, int limit, long windowMs) {
        long now    = System.currentTimeMillis();
        long cutoff = now - windowMs;

        // Pipeline: atomic remove-old, add-new, count, expire
        List<Object> results = redisTemplate.executePipelined(
                (RedisCallback<Object>) connection -> {
                    byte[] keyBytes = key.getBytes();
                    // Remove expired entries
                    connection.zRemRangeByScore(keyBytes, 0, cutoff);
                    // Add current request
                    connection.zAdd(keyBytes, now, UUID.randomUUID()
                            .toString().getBytes());
                    // Count total in window
                    connection.zCard(keyBytes);
                    // Set TTL
                    connection.expire(keyBytes, (windowMs / 1000) + 1);
                    return null;
                });

        long currentCount = (Long) results.get(2);
        boolean allowed   = currentCount <= limit;

        return RateLimitResult.builder()
                .allowed(allowed)
                .remaining(Math.max(0, limit - currentCount))
                .currentCount(currentCount)
                .build();
    }
}
```

---

## 3. Resilience4j RateLimiter for Downstream Protection

Resilience4j's RateLimiter protects calls your service makes to downstream dependencies — the reliability use case.

```java
@Configuration
public class RateLimiterConfig {

    @Bean
    public RateLimiterRegistry rateLimiterRegistry() {
        // Payment processor: 500 TPS limit
        io.github.resilience4j.ratelimiter.RateLimiterConfig paymentProcessorConfig =
                io.github.resilience4j.ratelimiter.RateLimiterConfig.custom()
                        .limitRefreshPeriod(Duration.ofSeconds(1))
                        .limitForPeriod(500)
                        .timeoutDuration(Duration.ofMillis(100))
                        .build();

        // Sanctions screening API: 100 req/s
        io.github.resilience4j.ratelimiter.RateLimiterConfig sanctionsApiConfig =
                io.github.resilience4j.ratelimiter.RateLimiterConfig.custom()
                        .limitRefreshPeriod(Duration.ofSeconds(1))
                        .limitForPeriod(100)
                        .timeoutDuration(Duration.ofMillis(500))
                        .build();

        // Database connection pool: 20 connections
        io.github.resilience4j.ratelimiter.RateLimiterConfig dbPoolConfig =
                io.github.resilience4j.ratelimiter.RateLimiterConfig.custom()
                        .limitRefreshPeriod(Duration.ofSeconds(1))
                        .limitForPeriod(20)
                        .timeoutDuration(Duration.ofMillis(200))
                        .build();

        return RateLimiterRegistry.of(Map.of(
                "payment-processor", paymentProcessorConfig,
                "sanctions-api",     sanctionsApiConfig,
                "db-pool",           dbPoolConfig));
    }
}
```

```java
@Service
public class PaymentProcessorClient {

    private final WebClient paymentProcessorWebClient;
    private final RateLimiter rateLimiter;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(PaymentProcessorClient.class);

    public PaymentProcessorClient(WebClient paymentProcessorWebClient,
                                   RateLimiterRegistry registry,
                                   MeterRegistry meterRegistry) {
        this.paymentProcessorWebClient = paymentProcessorWebClient;
        this.rateLimiter = registry.rateLimiter("payment-processor");
        this.meterRegistry = meterRegistry;
    }

    @RateLimiter(name = "payment-processor", fallbackMethod = "queuePayment")
    public PaymentAuthResponse authorise(PaymentAuthorisationRequest request) {
        return paymentProcessorWebClient.post()
                .uri("/v1/authorise")
                .bodyValue(request)
                .retrieve()
                .bodyToMono(PaymentAuthResponse.class)
                .timeout(Duration.ofSeconds(5))
                .block();
    }

    // Fallback: queue the payment for retry rather than dropping it
    private PaymentAuthResponse queuePayment(PaymentAuthorisationRequest request,
                                              RequestNotPermitted e) {
        meterRegistry.counter("payment.rate.limit.triggered",
                "processor", "payment-processor").increment();
        log.warn("Rate limit hit for payment processor, queuing: paymentId={}",
                request.getPaymentId());

        // Queue for retry with backoff
        paymentRetryQueue.enqueue(request, Duration.ofSeconds(2));

        // Return PENDING response — caller handles async
        return PaymentAuthResponse.builder()
                .paymentId(request.getPaymentId())
                .status(PaymentStatus.PENDING)
                .queuedForRetry(true)
                .build();
    }
}
```

---

## 4. Per-Client Rate Limiting

For payment APIs exposed to partner banks and merchants, per-client limits enforce fair resource sharing and prevent one misbehaving client from starving others.

```java
@Component
public class PerClientRateLimiter {

    private final SlidingWindowRateLimiter slidingWindowLimiter;
    private final ClientRateLimitConfigRepository configRepo;
    private final MeterRegistry meterRegistry;

    // Client tiers with different limits
    private static final Map<ClientTier, RateLimitPolicy> TIER_POLICIES = Map.of(
            ClientTier.ENTERPRISE, new RateLimitPolicy(1000, Duration.ofSeconds(1)),
            ClientTier.STANDARD,   new RateLimitPolicy(100,  Duration.ofSeconds(1)),
            ClientTier.SANDBOX,    new RateLimitPolicy(10,   Duration.ofSeconds(1))
    );

    public RateLimitResult checkClient(String clientId, String endpoint) {
        ClientConfig config = configRepo.findByClientId(clientId)
                .orElse(ClientConfig.defaultConfig());

        RateLimitPolicy policy = config.hasCustomPolicy()
                ? config.getCustomPolicy()
                : TIER_POLICIES.get(config.getTier());

        // Key per client + endpoint for per-endpoint limits
        String key = "rate:" + clientId + ":" + endpoint;

        RateLimitResult result = slidingWindowLimiter.check(
                key, policy.getLimit(), policy.getWindowMs());

        meterRegistry.counter("rate.limit.requests",
                Tags.of("client", clientId,
                        "endpoint", endpoint,
                        "allowed", String.valueOf(result.isAllowed())))
                .increment();

        return result;
    }
}
```

### Rate Limit Response Headers

```java
@Component
public class RateLimitResponseFilter implements WebFilter {

    private final PerClientRateLimiter rateLimiter;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String clientId  = extractClientId(exchange);
        String endpoint  = exchange.getRequest().getPath().value();

        RateLimitResult result = rateLimiter.checkClient(clientId, endpoint);

        // Set rate limit headers per IETF draft-ietf-httpapi-ratelimit-headers
        ServerHttpResponse response = exchange.getResponse();
        response.getHeaders().add("X-RateLimit-Limit",
                String.valueOf(result.getLimit()));
        response.getHeaders().add("X-RateLimit-Remaining",
                String.valueOf(result.getRemaining()));
        response.getHeaders().add("X-RateLimit-Reset",
                String.valueOf(result.getResetEpochSeconds()));

        if (!result.isAllowed()) {
            response.setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
            response.getHeaders().add("Retry-After",
                    String.valueOf(result.getRetryAfterMs() / 1000));
            return response.setComplete();
        }

        return chain.filter(exchange);
    }

    private String extractClientId(ServerWebExchange exchange) {
        // Extract from JWT sub claim or API key
        String auth = exchange.getRequest().getHeaders()
                .getFirst(HttpHeaders.AUTHORIZATION);
        // ... parse JWT or API key
        return "unknown";
    }
}
```

---

## 5. Graduated Rate Limiting

Rather than a hard block at the limit, graduated rate limiting progressively degrades service, giving clients the opportunity to self-throttle.

```java
@Service
public class GraduatedRateLimiter {

    private final TokenBucketRateLimiter tokenBucket;

    public GraduatedDecision evaluate(String clientId, String resource) {
        // Multiple tiers with different actions
        RateLimitResult tier1 = tokenBucket.tryAcquire(
                "rl:t1:" + clientId, 1000, 100.0, 1); // 1000 burst, 100/s refill

        if (tier1.isAllowed()) {
            return GraduatedDecision.allow(tier1.getRemaining());
        }

        RateLimitResult tier2 = tokenBucket.tryAcquire(
                "rl:t2:" + clientId, 500, 50.0, 1); // secondary bucket

        if (tier2.isAllowed()) {
            // Allow but with degraded service (lower priority, potential latency)
            return GraduatedDecision.allowDegraded(tier2.getRemaining(),
                    "Rate limit approaching — service degraded");
        }

        // Hard limit: reject
        return GraduatedDecision.reject(tier1.getRetryAfterMs());
    }
}
```

---

## 6. Rate Limit Bypass Detection

```java
@Component
public class RateLimitBypassDetector {

    private final RedisTemplate<String, String> redisTemplate;
    private final AlertService alertService;

    // Detect clients distributing requests across multiple IPs/keys
    // to avoid per-client rate limits
    @Scheduled(fixedRate = 60_000)
    public void detectBypass() {
        // Clients with many different client IDs from same IP subnet
        // — may indicate key rotation to bypass limits
        Map<String, Long> ipToClientCount = getIPToClientCountLastHour();
        ipToClientCount.entrySet().stream()
                .filter(e -> e.getValue() > 10)  // >10 different clients from one IP
                .forEach(e -> alertService.warning("RATE_LIMIT_BYPASS_SUSPECTED",
                        "IP " + e.getKey() + " using " + e.getValue() +
                        " different client IDs — possible limit bypass"));
    }

    // Detect suspiciously even request distribution (round-robin across keys)
    public boolean isSuspiciouslyEvenDistribution(String ipSubnet) {
        // A client legitimately distributing load will have some variance.
        // Perfect distribution (coefficient of variation near zero) suggests automation.
        List<Long> requestCounts = getRequestCountsByClientInSubnet(ipSubnet);
        if (requestCounts.size() < 3) return false;
        double mean = requestCounts.stream().mapToLong(x -> x).average().orElse(0);
        double variance = requestCounts.stream()
                .mapToDouble(x -> Math.pow(x - mean, 2))
                .average().orElse(0);
        double cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
        return cv < 0.05;  // <5% coefficient of variation is suspiciously uniform
    }
}
```

---

## 7. Protecting the Payment Processor from Burst

```java
@Service
public class PaymentQueueManager {

    private final RateLimiterRegistry rateLimiterRegistry;
    private final BlockingQueue<PaymentAuthorisationRequest> paymentQueue;
    private final PaymentProcessorClient processorClient;
    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(PaymentQueueManager.class);

    // Consumer thread: drains queue at exactly the rate the processor accepts
    @PostConstruct
    public void startQueueConsumer() {
        RateLimiter limiter = rateLimiterRegistry.rateLimiter("payment-processor");

        Thread consumer = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    PaymentAuthorisationRequest request =
                            paymentQueue.poll(1, TimeUnit.SECONDS);
                    if (request == null) continue;

                    // Acquire rate limit token before calling processor
                    // This blocks if we're at the limit
                    RateLimiter.waitForPermission(limiter);

                    try {
                        processorClient.authorise(request);
                        meterRegistry.counter("payment.queue.processed").increment();
                    } catch (Exception e) {
                        log.error("Payment authorisation failed: id={}",
                                request.getPaymentId(), e);
                        // Re-queue with backoff if retryable
                    }

                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }, "payment-queue-consumer");
        consumer.setDaemon(true);
        consumer.start();
    }

    public void enqueue(PaymentAuthorisationRequest request) {
        if (!paymentQueue.offer(request)) {
            // Queue full — this is a backpressure signal
            meterRegistry.counter("payment.queue.rejected").increment();
            throw new PaymentQueueFullException(
                    "Payment queue is full — circuit breaker should activate");
        }
        meterRegistry.gauge("payment.queue.depth", paymentQueue.size());
    }
}
```

---

## 8. Operational Monitoring

```java
@Component
public class RateLimitMetricsCollector {

    private final MeterRegistry meterRegistry;
    private final RateLimiterRegistry r4jRegistry;

    @PostConstruct
    public void bindMetrics() {
        // Bind Resilience4j metrics to Micrometer
        TaggedRateLimiterMetrics.ofRateLimiterRegistry(r4jRegistry)
                .bindTo(meterRegistry);
    }

    // Key metrics to alert on:
    // resilience4j.ratelimiter.waiting_threads > 50 → queue building up
    // resilience4j.ratelimiter.available_permissions < 10 → near limit
    // rate.limit.requests{allowed=false} > 1% → clients being throttled
}
```

| Metric | Alert Threshold | Meaning |
|---|---|---|
| `rate.limit.requests{allowed=false}` rate > 1% | Warning | Clients being throttled |
| `payment.queue.depth` > 1,000 | Warning | Queue building up |
| `payment.queue.rejected` > 0 | Critical | Queue overflow; backpressure failing |
| `r4j.ratelimiter.waiting_threads` > 50 | Warning | Many threads waiting for permits |

---

## Summary

Rate limiting is a reliability pattern that protects downstream dependencies from burst traffic. Use Resilience4j RateLimiter for outbound calls to payment processors, screening APIs, and other rate-limited services. Use Redis-based sliding window or token bucket for per-client inbound rate limiting. Graduated rate limiting provides a better client experience than hard blocks. The key operational metric is queue depth — a growing queue indicates that rate limits are being hit and traffic is backing up. When queue depth exceeds capacity, the system needs backpressure upstream, not just more queue capacity.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the key difference between security rate limiting and reliability rate limiting?",
      "options": ["Security rate limiting uses Redis; reliability rate limiting uses in-memory counters", "Security rate limiting enforces per-client quotas; reliability rate limiting protects downstream systems from burst traffic regardless of client", "Security rate limiting returns 503; reliability rate limiting returns 429", "Security rate limiting is applied inbound; reliability rate limiting cannot be applied outbound"],
      "correct": 1,
      "explanation": "Security rate limiting controls per-client/per-IP access to your API. Reliability rate limiting protects the downstream dependencies your service calls — payment processors, screening APIs, database connection pools. The latter applies to outbound calls your service makes, not just inbound calls it receives."
    },
    {
      "text": "Why is a sliding window counter more accurate than a fixed-window counter for rate limiting?",
      "options": ["Sliding windows use less Redis memory", "Fixed windows have a boundary problem where clients can make 2x the limit by straddling two windows", "Sliding windows are faster to compute", "Fixed windows cannot be implemented in Redis"],
      "correct": 1,
      "explanation": "With a fixed window (e.g., 100 req/min), a client can make 100 requests in the last second of one window and 100 in the first second of the next — 200 requests in a 2-second span. Sliding windows use a time-ordered structure (ZSET) to count only requests within the last N seconds, eliminating the boundary artifact."
    },
    {
      "text": "When a PaymentQueueManager's queue becomes full, what is the correct response?",
      "options": ["Increase the queue capacity to absorb the burst", "Throw a backpressure exception — this is a signal that upstream flow control is needed", "Drop the payment silently", "Retry the payment with exponential backoff"],
      "correct": 1,
      "explanation": "A full queue is a backpressure signal indicating the system cannot absorb more traffic. The correct response is to propagate this pressure upstream — reject the request with a 503, so the caller can apply its own flow control. Adding queue capacity just delays the failure and obscures the underlying capacity problem."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Redis-Based Rate Limiting System for Payment Infrastructure",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a Redis Lua token bucket rate limiter that atomically: computes elapsed time since last refill, adds tokens (capped at maxTokens), consumes requested tokens if available, and returns {allowed, remainingTokens, retryAfterMs}. Test with concurrent requests to verify no race conditions."},
    {"id": "2", "description": "Build a Resilience4j-based PaymentProcessorClient that limits outbound calls to 500 TPS, queues rate-limited payments for async retry, and returns a PENDING response when queued. Publish a Prometheus counter distinguishing between direct-processed and queued payments."},
    {"id": "3", "description": "Implement per-client rate limiting using ENTERPRISE (1000/s), STANDARD (100/s), and SANDBOX (10/s) tiers with a sliding window ZSET. Add X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset response headers, and return 429 with Retry-After when exceeded."},
    {"id": "4", "description": "Create a PaymentQueueManager with a bounded BlockingQueue that: consumes tokens from a Resilience4j RateLimiter before each processor call, throws PaymentQueueFullException when the queue is at capacity, and publishes queue depth and rejection count metrics to Prometheus."}
  ]
}
-->

