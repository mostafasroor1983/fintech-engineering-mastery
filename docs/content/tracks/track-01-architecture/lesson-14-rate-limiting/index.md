---
id: track-01-lesson-14
title: "Rate Limiting, Throttling, and Back Pressure"
slug: rate-limiting
track: track-01
trackName: "Financial Services Architecture"
sequence: 14
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [rate-limiting, token-bucket, sliding-window, back-pressure, throttling]
prerequisites: []
---

# Rate Limiting, Throttling, and Back Pressure

> [!NOTE]
> A payment API that processes 500 requests per second normally will be overwhelmed by a rogue client sending 50,000 requests per second — whether by accident or by attack. Rate limiting is not just an infrastructure concern; it is a first-class financial service control that protects system stability, ensures fair resource allocation, and prevents fraud through velocity checks.

## The Case for Rate Limiting in Financial Services

Payment APIs face unique rate limiting challenges that generic web services do not:

- **Velocity fraud detection**: A card being used for 200 transactions in 60 seconds is almost certainly being tested by fraudsters
- **Regulatory compliance**: Some regulatory frameworks require demonstrable controls on automated transaction submission
- **SLA fairness**: A single high-volume client must not degrade service for other clients
- **Cost control**: Downstream services (card networks, banking rails) charge per-transaction fees

Rate limiting strategies fall into several algorithmic families. Understanding their trade-offs is essential for choosing the right approach at each layer of a payment platform.

```
Payment API Rate Limiting Layers:

  Internet --> API Gateway --> Payment Service --> Card Network
               [global]        [per-customer]       [external limit]
               [IP-based]      [per-API-key]
               [DDoS]          [burst+sustained]
```

---

## Algorithm 1: Token Bucket

The **token bucket** algorithm allows burst traffic up to a maximum capacity while enforcing a sustained average rate. Tokens accumulate at a fixed rate; each request consumes one token; requests are rejected when the bucket is empty.

This models real-world payment traffic well: a customer might submit 20 payments in a few seconds (burst) but cannot sustain 20 payments per second indefinitely.

```
Token Bucket visualisation:

  refill rate: 10 tokens/sec
  capacity: 50 tokens (burst allowance)

  t=0:  bucket=[50 tokens]
  t=0:  20 requests arrive -> bucket=[30 tokens]  OK all allowed
  t=0:  40 more requests   -> bucket=[30->0]       30 allowed, 10 rejected
  t=5:  50 tokens refilled -> bucket=[50 tokens]
```

### Redis-Based Token Bucket

```java
// src/main/java/com/fintech/ratelimit/TokenBucketRateLimiter.java
package com.fintech.ratelimit;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class TokenBucketRateLimiter {

    /**
     * Atomic Lua script: refill tokens based on elapsed time, then try to consume.
     * Running inside Redis guarantees atomicity with no race conditions.
     */
    private static final String TOKEN_BUCKET_SCRIPT = """
        local key          = KEYS[1]
        local capacity     = tonumber(ARGV[1])
        local refill_rate  = tonumber(ARGV[2])   -- tokens per second
        local now          = tonumber(ARGV[3])    -- current time in ms
        local requested    = tonumber(ARGV[4])    -- tokens to consume

        local bucket       = redis.call('HMGET', key, 'tokens', 'last_refill')
        local tokens       = tonumber(bucket[1])
        local last_refill  = tonumber(bucket[2])

        if tokens == nil then
            tokens      = capacity
            last_refill = now
        else
            local elapsed  = (now - last_refill) / 1000.0
            tokens         = math.min(capacity, tokens + elapsed * refill_rate)
            last_refill    = now
        end

        local allowed = 0
        if tokens >= requested then
            tokens  = tokens - requested
            allowed = 1
        end

        local ttl = math.ceil(capacity / refill_rate) * 2
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
        redis.call('EXPIRE', key, ttl)

        return {allowed, math.floor(tokens), ttl}
        """;

    private final StringRedisTemplate redisTemplate;
    private final RedisScript<List<Long>> bucketScript;

    public TokenBucketRateLimiter(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
        this.bucketScript  = RedisScript.of(TOKEN_BUCKET_SCRIPT, List.class);
    }

    public RateLimitResult checkLimit(String clientId, RateLimitPolicy policy) {
        String key = "rate_limit:token_bucket:" + clientId;
        long   now = Instant.now().toEpochMilli();

        List<Long> result = redisTemplate.execute(
            bucketScript,
            List.of(key),
            String.valueOf(policy.burstCapacity()),
            String.valueOf(policy.refillRate()),
            String.valueOf(now),
            "1"
        );

        boolean allowed         = result.get(0) == 1L;
        long    remainingTokens = result.get(1);

        return RateLimitResult.builder()
            .allowed(allowed)
            .remainingTokens(remainingTokens)
            .burstCapacity(policy.burstCapacity())
            .refillRate(policy.refillRate())
            .retryAfterSeconds(allowed ? 0L : (long) Math.ceil(1.0 / policy.refillRate()))
            .build();
    }
}
```

```java
public record RateLimitPolicy(
    long   burstCapacity,
    double refillRate,
    String tier
) {
    public static final RateLimitPolicy STANDARD   = new RateLimitPolicy(50,   10.0,  "STANDARD");
    public static final RateLimitPolicy PREMIUM    = new RateLimitPolicy(200,  50.0,  "PREMIUM");
    public static final RateLimitPolicy ENTERPRISE = new RateLimitPolicy(1000, 200.0, "ENTERPRISE");
}
```

---

## Algorithm 2: Sliding Window Log

The sliding window log tracks the exact timestamp of each request within the last N seconds. This is precise but memory-intensive — suitable for low-volume, high-precision needs like per-customer payment velocity.

```java
@Component
public class SlidingWindowLogRateLimiter {

    private static final String SLIDING_WINDOW_SCRIPT = """
        local key          = KEYS[1]
        local window_ms    = tonumber(ARGV[1])
        local limit        = tonumber(ARGV[2])
        local now          = tonumber(ARGV[3])
        local window_start = now - window_ms

        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        local count   = redis.call('ZCARD', key)
        local allowed = 0

        if count < limit then
            redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
            redis.call('PEXPIRE', key, window_ms)
            allowed = 1
            count   = count + 1
        end

        return {allowed, count, limit - count}
        """;

    private final StringRedisTemplate redisTemplate;
    private final RedisScript<List<Long>> windowScript;

    public SlidingWindowLogRateLimiter(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
        this.windowScript  = RedisScript.of(SLIDING_WINDOW_SCRIPT, List.class);
    }

    /**
     * Velocity check: max N payments per customer per hour.
     * Used for fraud detection, not just throughput control.
     */
    public RateLimitResult checkPaymentVelocity(String customerId,
                                                 int maxPerHour) {
        String key    = "velocity:payments:" + customerId;
        long   nowMs  = Instant.now().toEpochMilli();
        long   window = Duration.ofHours(1).toMillis();

        List<Long> result = redisTemplate.execute(
            windowScript,
            List.of(key),
            String.valueOf(window),
            String.valueOf(maxPerHour),
            String.valueOf(nowMs)
        );

        return RateLimitResult.builder()
            .allowed(result.get(0) == 1L)
            .remainingTokens(result.get(2))
            .build();
    }
}
```

---

## Algorithm 3: Sliding Window Counter

A memory-efficient approximation of the sliding window. Maintains two adjacent fixed-window counters and weights the previous one by its overlap into the current window.

```java
@Component
public class SlidingWindowCounterRateLimiter {

    private static final String COUNTER_SCRIPT = """
        local current_key  = KEYS[1]
        local previous_key = KEYS[2]
        local limit        = tonumber(ARGV[1])
        local window_ms    = tonumber(ARGV[2])
        local now          = tonumber(ARGV[3])

        local current_window_start = now - (now % window_ms)
        local overlap_ratio        = (now - current_window_start) / window_ms

        local prev_count      = tonumber(redis.call('GET', previous_key) or 0)
        local curr_count      = tonumber(redis.call('GET', current_key)  or 0)
        local estimated_count = (prev_count * (1 - overlap_ratio)) + curr_count

        local allowed = 0
        if estimated_count < limit then
            redis.call('INCR', current_key)
            redis.call('PEXPIRE', current_key, window_ms * 2)
            allowed         = 1
            estimated_count = estimated_count + 1
        end

        return {allowed, math.floor(estimated_count), math.floor(limit - estimated_count)}
        """;

    private final StringRedisTemplate redisTemplate;
    private final RedisScript<List<Long>> counterScript;

    public RateLimitResult checkApiKeyLimit(String apiKey, int requestsPerMinute) {
        long nowMs             = Instant.now().toEpochMilli();
        long windowMs          = Duration.ofMinutes(1).toMillis();
        long currentWindowStart = nowMs - (nowMs % windowMs);
        long previousWindowStart = currentWindowStart - windowMs;

        String currentKey  = "rl:counter:" + apiKey + ":" + currentWindowStart;
        String previousKey = "rl:counter:" + apiKey + ":" + previousWindowStart;

        List<Long> result = redisTemplate.execute(
            counterScript,
            List.of(currentKey, previousKey),
            String.valueOf(requestsPerMinute),
            String.valueOf(windowMs),
            String.valueOf(nowMs)
        );

        return RateLimitResult.builder()
            .allowed(result.get(0) == 1L)
            .remainingTokens(result.get(2))
            .build();
    }
}
```

---

## Spring Boot Rate Limiting Filter

```java
// src/main/java/com/fintech/payment/filter/RateLimitFilter.java
package com.fintech.payment.filter;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Instant;

@Component
@Order(1)
public class RateLimitFilter extends OncePerRequestFilter {

    private static final String HDR_LIMIT       = "X-RateLimit-Limit";
    private static final String HDR_REMAINING   = "X-RateLimit-Remaining";
    private static final String HDR_RESET       = "X-RateLimit-Reset";
    private static final String HDR_RETRY_AFTER = "Retry-After";

    private final TokenBucketRateLimiter rateLimiter;
    private final ApiKeyPolicyRepository policyRepository;

    public RateLimitFilter(TokenBucketRateLimiter rateLimiter,
                            ApiKeyPolicyRepository policyRepository) {
        this.rateLimiter    = rateLimiter;
        this.policyRepository = policyRepository;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                     HttpServletResponse response,
                                     FilterChain chain)
            throws ServletException, IOException {

        String apiKey = extractApiKey(request);

        RateLimitPolicy policy = (apiKey != null)
            ? policyRepository.findByApiKey(apiKey)
                               .map(ApiKeyConfig::toPolicy)
                               .orElse(RateLimitPolicy.STANDARD)
            : new RateLimitPolicy(10, 2.0, "ANONYMOUS");

        String limitKey = (apiKey != null)
            ? apiKey
            : "anon:" + getClientIp(request);

        RateLimitResult result = rateLimiter.checkLimit(limitKey, policy);

        addRateLimitHeaders(response, result);

        if (!result.allowed()) {
            response.setStatus(429);
            response.setContentType("application/json");
            response.setHeader(HDR_RETRY_AFTER,
                               String.valueOf(result.retryAfterSeconds()));
            response.getWriter().write("""
                {"errorCode":"RATE_LIMIT_EXCEEDED",
                 "message":"Too many requests. Retry after %d seconds.",
                 "retryAfterSeconds":%d}
                """.formatted(result.retryAfterSeconds(),
                              result.retryAfterSeconds()));
            return;
        }

        chain.doFilter(request, response);
    }

    private void addRateLimitHeaders(HttpServletResponse response,
                                      RateLimitResult result) {
        response.setHeader(HDR_LIMIT,     String.valueOf(result.burstCapacity()));
        response.setHeader(HDR_REMAINING, String.valueOf(result.remainingTokens()));

        long deficit      = result.burstCapacity() - result.remainingTokens();
        long resetEpoch   = Instant.now()
            .plusSeconds((long) Math.ceil(deficit / result.refillRate()))
            .getEpochSecond();
        response.setHeader(HDR_RESET, String.valueOf(resetEpoch));
    }

    private String extractApiKey(HttpServletRequest request) {
        String auth = request.getHeader("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            return auth.substring(7);
        }
        return request.getHeader("X-API-Key");
    }

    private String getClientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        return (xff != null && !xff.isBlank())
            ? xff.split(",")[0].trim()
            : request.getRemoteAddr();
    }
}
```

---

## Per-Endpoint Limits with AOP

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RateLimit {
    int    requestsPerMinute() default 60;
    int    burstCapacity()     default 100;
    String keySuffix()         default "";
}
```

```java
@Aspect
@Component
public class RateLimitAspect {

    private final TokenBucketRateLimiter rateLimiter;

    @Around("@annotation(rateLimit)")
    public Object enforce(ProceedingJoinPoint pjp, RateLimit rateLimit)
            throws Throwable {

        String apiKey  = SecurityContextHolder.getContext()
                            .getAuthentication().getName();
        String limitKey = apiKey + rateLimit.keySuffix();

        RateLimitPolicy policy = new RateLimitPolicy(
            rateLimit.burstCapacity(),
            rateLimit.requestsPerMinute() / 60.0,
            "ENDPOINT"
        );

        RateLimitResult result = rateLimiter.checkLimit(limitKey, policy);
        if (!result.allowed()) {
            throw new RateLimitExceededException(
                "Rate limit exceeded", result.retryAfterSeconds());
        }

        return pjp.proceed();
    }
}
```

```java
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    @PostMapping
    @RateLimit(requestsPerMinute = 60, burstCapacity = 100)
    public ResponseEntity<PaymentResponse> submitPayment(
            @RequestBody PaymentRequest request) {
        return ResponseEntity.ok(paymentService.submit(request));
    }

    @PostMapping("/bulk")
    @RateLimit(requestsPerMinute = 5, burstCapacity = 10, keySuffix = ":bulk")
    public ResponseEntity<BulkPaymentResponse> submitBulk(
            @RequestBody BulkPaymentRequest request) {
        return ResponseEntity.accepted().body(paymentService.submitBulk(request));
    }

    @GetMapping("/{paymentId}/status")
    @RateLimit(requestsPerMinute = 300, burstCapacity = 500)
    public ResponseEntity<PaymentStatus> getStatus(
            @PathVariable String paymentId) {
        return ResponseEntity.ok(paymentService.getStatus(paymentId));
    }
}
```

---

## Back Pressure in Reactive Systems

When a downstream service is slow, rate limiting at the entry point is insufficient. The payment service must apply back pressure to avoid cascading failures.

### Project Reactor Back Pressure

```java
@Component
public class ReactivePaymentProcessor {

    private final CardNetworkClient cardNetworkClient;
    private final MeterRegistry     meterRegistry;

    /**
     * Process payment stream with back pressure and rate limiting.
     * Card network can handle 100 rps; we enforce this via concatMap+delay.
     */
    public Flux<PaymentResult> processPayments(Flux<PaymentRequest> payments) {
        return payments
            // Serialise + rate-limit: one every 10 ms = 100/s
            .concatMap(payment ->
                Mono.delay(Duration.ofMillis(10))
                    .then(processOne(payment))
            )
            // Bounded retry for transient card network failures
            .retryWhen(
                Retry.backoff(3, Duration.ofMillis(100))
                     .maxBackoff(Duration.ofSeconds(2))
                     .filter(ex -> ex instanceof TransientNetworkException)
            )
            .timeout(Duration.ofSeconds(30))
            // Bounded elastic pool — rejects new work instead of unbounded growth
            .subscribeOn(Schedulers.newBoundedElastic(
                50,    // max threads
                1000,  // max queued tasks
                "payment-processor"
            ))
            .doOnNext(r -> meterRegistry
                .counter("payments.processed", "status", r.status().name())
                .increment()
            )
            .doOnError(ex -> meterRegistry
                .counter("payments.errors", "type", ex.getClass().getSimpleName())
                .increment()
            );
    }

    private Mono<PaymentResult> processOne(PaymentRequest payment) {
        return cardNetworkClient.authorise(payment)
            .map(auth -> PaymentResult.from(payment, auth));
    }
}
```

### Resilience4j Rate Limiter (Declarative)

```yaml
# src/main/resources/application.yml
resilience4j:
  ratelimiter:
    instances:
      card-network:
        limit-for-period: 100
        limit-refresh-period: 1s
        timeout-duration: 500ms
      fraud-service:
        limit-for-period: 200
        limit-refresh-period: 1s
        timeout-duration: 100ms
```

```java
@Service
public class CardNetworkGateway {

    @RateLimiter(name = "card-network", fallbackMethod = "queueForRetry")
    public Mono<AuthorisationResponse> authorise(AuthorisationRequest request) {
        return cardNetworkWebClient.post()
            .uri("/authorise")
            .bodyValue(request)
            .retrieve()
            .bodyToMono(AuthorisationResponse.class);
    }

    private Mono<AuthorisationResponse> queueForRetry(
            AuthorisationRequest request,
            RequestNotPermitted ex) {
        meterRegistry.counter("card_network.rate_limited").increment();
        return retryQueue.enqueue(request)
            .thenReturn(AuthorisationResponse.pending(request.paymentId()));
    }
}
```

---

## Redis Cluster Configuration and Fail-Open Strategy

```java
@Configuration
public class RedisRateLimitConfig {

    @Bean
    public LettuceConnectionFactory redisConnectionFactory() {
        RedisClusterConfiguration cluster = new RedisClusterConfiguration(
            List.of("redis-1:6379", "redis-2:6379", "redis-3:6379")
        );
        LettuceClientConfiguration client = LettuceClientConfiguration.builder()
            .commandTimeout(Duration.ofMillis(50))  // fail fast — never hold payments
            .build();
        return new LettuceConnectionFactory(cluster, client);
    }
}
```

```java
/**
 * Wraps the Redis-backed rate limiter with a circuit breaker.
 * If Redis is unavailable, fail open (allow requests) rather than
 * blocking all payments across the platform.
 */
@Component
public class ResilientRateLimiter {

    private final TokenBucketRateLimiter primary;
    private final GuavaLocalRateLimiter  fallback;
    private final CircuitBreaker         breaker;
    private final MeterRegistry          metrics;

    public RateLimitResult checkLimit(String clientId, RateLimitPolicy policy) {
        try {
            return breaker.executeCallable(
                () -> primary.checkLimit(clientId, policy)
            );
        } catch (Exception ex) {
            metrics.counter("rate_limiter.redis.failure").increment();
            log.warn("Redis rate limiter unavailable; failing open for {}", clientId);
            // Fallback is per-instance, so effective limit is limit/N nodes
            return fallback.checkLimit(clientId, policy);
        }
    }
}
```

---

## Velocity Checks for Fraud Detection

```java
@Service
public class PaymentVelocityService {

    private final SlidingWindowLogRateLimiter velocityLimiter;
    private final FraudAlertPublisher         alertPublisher;

    /**
     * Multi-window velocity check on payment submission.
     * Checks multiple time horizons to detect both burst and sustained fraud.
     */
    public VelocityCheckResult checkVelocity(String customerId,
                                               PaymentRequest payment) {
        List<VelocityViolation> violations = new ArrayList<>();

        // 10 payments per customer per minute
        if (!velocityLimiter.checkPaymentVelocity(
                customerId + ":1m", 10, Duration.ofMinutes(1)).allowed()) {
            violations.add(new VelocityViolation("PAYMENTS_PER_MINUTE", 10));
        }

        // 50 payments per customer per hour
        if (!velocityLimiter.checkPaymentVelocity(
                customerId + ":1h", 50, Duration.ofHours(1)).allowed()) {
            violations.add(new VelocityViolation("PAYMENTS_PER_HOUR", 50));
        }

        // Card testing pattern: same card, 5+ distinct merchants in 10 minutes
        if (!velocityLimiter.checkUniqueCount(
                "card:" + payment.cardToken() + ":merch:10m",
                payment.merchantId(), 5, Duration.ofMinutes(10)).allowed()) {
            violations.add(new VelocityViolation("UNIQUE_MERCHANTS_PER_CARD", 5));
        }

        if (!violations.isEmpty()) {
            alertPublisher.publishVelocityAlert(customerId, payment, violations);
        }

        return new VelocityCheckResult(violations.isEmpty(), violations);
    }
}
```

---

## SQL: Rate Limit Configuration Schema

```sql
CREATE TABLE rate_limit_policies (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_name     VARCHAR(100)  NOT NULL UNIQUE,
    tier            VARCHAR(50)   NOT NULL,
    burst_capacity  INTEGER       NOT NULL,
    refill_rate     DECIMAL(10,4) NOT NULL,  -- tokens per second
    window_seconds  INTEGER       NOT NULL DEFAULT 60,
    description     TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE api_key_rate_limits (
    api_key         VARCHAR(255)  PRIMARY KEY,
    customer_id     UUID          NOT NULL,
    policy_name     VARCHAR(100)  NOT NULL REFERENCES rate_limit_policies(policy_name),
    custom_burst    INTEGER,          -- optional per-key override
    custom_refill   DECIMAL(10,4),
    enabled         BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO rate_limit_policies
    (policy_name, tier, burst_capacity, refill_rate, description)
VALUES
    ('STANDARD',   'STANDARD',    50,    10.0,  '10 rps sustained, burst 50'),
    ('PREMIUM',    'PREMIUM',     200,   50.0,  '50 rps sustained, burst 200'),
    ('ENTERPRISE', 'ENTERPRISE',  1000,  200.0, '200 rps sustained, burst 1000'),
    ('INTERNAL',   'INTERNAL',    10000, 1000.0,'Internal service-to-service');

-- Violation log for security analysis
CREATE TABLE rate_limit_violations (
    id              BIGSERIAL    PRIMARY KEY,
    client_id       VARCHAR(255) NOT NULL,
    endpoint        VARCHAR(500),
    violated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    limit_applied   INTEGER,
    request_count   INTEGER
);

CREATE INDEX idx_violations_client_time
    ON rate_limit_violations (client_id, violated_at DESC);
```

---

## Kong API Gateway Rate Limiting

For production deployments, enforce a first line of rate limiting at the gateway before requests reach application services:

```yaml
# Kong declarative config (deck format)
_format_version: "3.0"
services:
  - name: payment-service
    url: http://payment-service:8080
    routes:
      - name: payment-submissions
        paths: ["/api/v1/payments"]
        methods: ["POST"]
    plugins:
      - name: rate-limiting-advanced
        config:
          limit: [60]
          window_size: [60]
          identifier: consumer
          strategy: sliding
          sync_rate: 2
          namespace: payments_post
          hide_client_headers: false
          error_code: 429
          error_message: "Rate limit exceeded"
```

---

## Common Pitfalls

**1. Using Wall-Clock Time Inside Lua Scripts**
Different application nodes may submit different `now` timestamps to Redis. For the highest precision, use the Redis `TIME` command inside the Lua script to get a consistent server-side timestamp rather than relying on the client's clock.

**2. Rate Limiting Idempotent Retries**
A client that receives a 5xx response and retries the same payment using its idempotency key should not be double-counted. Check whether the idempotency key was already processed before consuming a rate limit token.

**3. The Stampede at Window Reset**
Fixed-window counters reset at a wall-clock boundary (e.g., top of the minute). Every client that was queued at the limit then fires simultaneously, creating a thundering herd. Use sliding window algorithms and add jitter to client retry backoffs to avoid this.

**4. Per-Instance Rate Limiters in Load-Balanced Deployments**
Guava `RateLimiter` and in-process algorithms are per-JVM. With 10 instances, the effective total rate limit is 10 times the per-instance value. Always use a distributed store for authoritative limits in multi-instance deployments.

**5. Applying Production Limits to Internal Traffic**
Internal service-to-service calls (e.g., payment-service calling account-service within the cluster) should use separate high-capacity policies. Applying customer-tier limits to internal traffic will cause cascading failures under load.

---

## Production Tips

**Expose All Three Rate Limit Headers on Every Response**
Clients that do not receive `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` are forced to implement blind exponential backoff. All three headers on every response (not just 429s) enable proactive client-side throttling.

**Warn Before the Hard Limit**
Add a `Warning: 299 - "Rate limit at 80% capacity"` response header when remaining tokens drop below 20% of burst capacity. Good client libraries can throttle themselves before hitting the wall.

**Use Separate Redis Keyspace Prefixes per Environment**
Prefix all keys with `prod:`, `staging:`, or `dev:` to prevent load tests in a shared Redis cluster from consuming production quota.

**Alert on 429 Rate as a Service Health Signal**
A spike in 429 responses indicates either a misbehaving client or a downstream service causing retry storms. Alert when the 429 rate exceeds 5% of requests in any 60-second window, and correlate with downstream latency metrics.

**Store Violation Events for Fraud Review**
Every 429 response from a payment API endpoint should be logged to the `rate_limit_violations` table with enough context (customer ID, endpoint, volume) for the fraud operations team to review. Rate limit breaches are a leading indicator of automated abuse.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment API uses a fixed-window rate limiter reset at the top of every minute. A client reaches the limit at 00:59 and waits for the reset at 01:00. At exactly 01:00, the client and many other clients that were also waiting send their requests simultaneously. What problem does this cause and which algorithm avoids it?",
      "options": [
        "The requests will be rejected because the counter has not fully reset yet. A token bucket avoids this by resetting counters asynchronously.",
        "All queued clients fire simultaneously at the window boundary, creating a thundering herd. The sliding window counter avoids this by smoothing the transition between windows.",
        "The fixed-window algorithm double-counts requests that span the boundary, causing clients to be rate-limited even when they should be allowed. The leaky bucket avoids this.",
        "The fixed-window counter becomes negative at the boundary due to concurrent decrements. Redis transactions prevent this in a distributed setup."
      ],
      "correct": 1,
      "explanation": "Fixed-window counters reset at wall-clock boundaries, so every queued client fires simultaneously at the top of the minute — a thundering herd. The sliding window counter maintains a weighted count across the boundary, smoothing the transition and preventing burst traffic at reset moments. Adding jitter to client retry backoffs further reduces the stampede effect."
    },
    {
      "text": "A payment platform deploys 10 instances of the API service. Each instance uses an in-process Guava RateLimiter with a limit of 100 requests per second. What is the actual effective rate limit across the fleet?",
      "options": [
        "100 requests per second, because Guava RateLimiter uses a distributed algorithm that coordinates across JVM instances.",
        "10 requests per second, because the fleet divides the global limit by the number of instances.",
        "1000 requests per second, because each of the 10 instances enforces its own 100 rps limit independently.",
        "100 requests per second total, enforced at the load balancer before requests reach individual instances."
      ],
      "correct": 2,
      "explanation": "In-process rate limiters like Guava RateLimiter are per-JVM. With 10 instances each allowing 100 rps, the effective total limit is 1000 rps — 10 times the intended limit. This is a critical failure mode for distributed deployments. For authoritative limits across a fleet, a distributed store (Redis) must be used, not in-process algorithms."
    },
    {
      "text": "The Redis cluster backing the payment API rate limiter becomes unavailable. The ResilientRateLimiter detects this via circuit breaker. What is the correct strategy and why is it preferred for a payment API?",
      "options": [
        "Fail closed (block all requests) until Redis recovers, to prevent fraudulent requests from bypassing rate limits.",
        "Fail open (allow requests using a per-instance fallback limiter) to avoid blocking all payment processing due to a rate limiter infrastructure failure.",
        "Return HTTP 503 to all requests with a Retry-After header indicating when Redis is expected to recover.",
        "Queue all incoming requests and replay them in order when Redis recovers, maintaining FIFO ordering."
      ],
      "correct": 1,
      "explanation": "Payment APIs should fail open when the rate limiter is unavailable. Failing closed (blocking all payments) due to a Redis outage means 100% of payment traffic is rejected — a revenue-destroying, customer-harming failure caused by an infrastructure dependency, not fraud. The per-instance fallback limiter provides a degraded but functional rate limit. Failing open is the correct trade-off when the alternative is complete payment downtime."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Multi-Layer Rate Limiting for a Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a Redis-backed token bucket rate limiter using an atomic Lua script. The script must: (a) refill tokens based on elapsed time since last refill, (b) atomically check and consume one token, (c) set a TTL on the Redis key equal to twice the refill period, and (d) return the allowed flag, remaining tokens, and TTL. Write unit tests using an embedded Redis (Testcontainers or Jedis mock) that verify the burst behaviour, the refill behaviour, and the rejection behaviour when tokens are exhausted."},
    {"id": "2", "description": "Implement a @RateLimit annotation and RateLimitAspect using Spring AOP. The annotation must support requestsPerMinute and burstCapacity parameters and a keySuffix for per-endpoint differentiation. Apply the annotation to three payment controller endpoints with different limits: 60/min for payment submission, 5/min for bulk payment, and 300/min for status queries. Write tests verifying that each endpoint enforces its own limit independently."},
    {"id": "3", "description": "Implement a PaymentVelocityService that performs multi-window velocity checks for fraud detection. Check: (a) 10 payments per customer per minute, (b) 50 payments per customer per hour, and (c) 5 unique merchants per card token per 10 minutes. Use the sliding window log algorithm for all three checks. Write tests that simulate a card testing fraud pattern (many unique merchants in a short window) and verify the alert is triggered at the correct threshold."},
    {"id": "4", "description": "Build a ResilientRateLimiter that wraps the Redis-backed token bucket with a Resilience4j circuit breaker. When Redis is unavailable, fall back to a per-instance Guava RateLimiter with a note in the logs that the effective limit is multiplied by the number of instances. Configure the circuit breaker to open after 3 failures in 5 seconds and half-open after 10 seconds. Write an integration test that simulates Redis unavailability and verifies the fallback activates and returns allowed results rather than blocking requests."}
  ]
}
-->
