---
id: track-01-lesson-14
title: "تحديد المعدّل والخنق والضغط العكسي (Back Pressure)"
slug: rate-limiting
track: track-01
trackName: "البنية المعمارية المتقدمة للبرمجيات"
sequence: 14
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [rate-limiting, token-bucket, sliding-window, back-pressure, throttling]
prerequisites: []
---

# تحديد المعدّل والخنق والضغط العكسي

> [!NOTE]
> واجهة دفع تعالج عادة 500 طلب في الثانية ستُغرق بعميل منفلت يرسل 50,000 طلب في الثانية — سواء عن خطأ أو هجوم. وتحديد المعدّل (Rate Limiting) ليس شأنًا من شؤون البنية التحتية فحسب؛ بل ضابط أساسي في الخدمات المالية يحمي استقرار النظام، ويضمن توزيعًا عادلًا للموارد، ويمنع الاحتيال عبر فحوص السرعة.

## لماذا تحتاج الخدمات المالية إلى تحديد المعدّل

تواجه واجهات الدفع تحديات في تحديد المعدّل لا تواجهها خدمات الويب العامة:

- **كشف احتيال السرعة**: بطاقة تُستخدم في 200 معاملة خلال 60 ثانية يكاد يكون مؤكدًا أن محتالين يختبرونها
- **الامتثال التنظيمي**: بعض الأطر التنظيمية تتطلب ضوابط قابلة للإثبات على الإرسال الآلي للمعاملات
- **عدالة اتفاقيات مستوى الخدمة**: يجب ألا يُضعف عميل واحد كثيف الحجم الخدمة للعملاء الآخرين
- **ضبط الكلفة**: الخدمات اللاحقة (شبكات البطاقات، والشبكات المصرفية) تفرض رسومًا على كل معاملة

تنقسم استراتيجيات تحديد المعدّل إلى عدة عائلات من الخوارزميات. وفهم مفاضلاتها ضروري لاختيار الأسلوب الصحيح في كل طبقة من طبقات منصة الدفع.

```
Payment API Rate Limiting Layers:

  Internet --> API Gateway --> Payment Service --> Card Network
               [global]        [per-customer]       [external limit]
               [IP-based]      [per-API-key]
               [DDoS]          [burst+sustained]
```

---

## الخوارزمية 1: دلو الرموز (Token Bucket)

تسمح خوارزمية **دلو الرموز** بحركة اندفاعية حتى سعة قصوى، مع فرض معدل متوسط مستدام. تتراكم الرموز بمعدل ثابت؛ ويستهلك كل طلب رمزًا واحدًا؛ وتُرفض الطلبات عندما يفرغ الدلو.

وهذا يحاكي حركة الدفع الحقيقية جيدًا: قد يرسل العميل 20 دفعة في بضع ثوانٍ (اندفاع) لكنه لا يستطيع الاستمرار بـ 20 دفعة في الثانية إلى ما لا نهاية.

```
Token Bucket visualisation:

  refill rate: 10 tokens/sec
  capacity: 50 tokens (burst allowance)

  t=0:  bucket=[50 tokens]
  t=0:  20 requests arrive -> bucket=[30 tokens]  OK all allowed
  t=0:  40 more requests   -> bucket=[30->0]       30 allowed, 10 rejected
  t=5:  50 tokens refilled -> bucket=[50 tokens]
```

### دلو رموز قائم على Redis

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

## الخوارزمية 2: سجل النافذة المنزلقة (Sliding Window Log)

يتتبع سجل النافذة المنزلقة الطابع الزمني الدقيق لكل طلب خلال آخر N ثانية. وهو دقيق لكنه كثيف الاستهلاك للذاكرة — مناسب للاحتياجات منخفضة الحجم عالية الدقة مثل سرعة مدفوعات كل عميل.

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

## الخوارزمية 3: عدّاد النافذة المنزلقة (Sliding Window Counter)

تقريب موفّر للذاكرة للنافذة المنزلقة. يحتفظ بعدّادين لنافذتين ثابتتين متجاورتين، ويزن عدّاد النافذة السابقة بمقدار تداخلها مع النافذة الحالية.

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

        // {apiKey} is a hash tag: both keys land in the same Redis Cluster slot,
        // which a multi-key Lua script requires
        String currentKey  = "rl:counter:{" + apiKey + "}:" + currentWindowStart;
        String previousKey = "rl:counter:{" + apiKey + "}:" + previousWindowStart;

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

الجزء `{apiKey}` في اسم المفتاح وسم hash يضمن وقوع المفتاحين في الشق (slot) نفسه في Redis Cluster، وهذا شرط لسكربت Lua يستخدم أكثر من مفتاح.

---

## مرشح تحديد المعدّل في Spring Boot

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

        // Never use a raw secret as a Redis key: hash it
        String limitKey = (apiKey != null)
            ? "key:" + sha256Hex(apiKey)
            : "anon:" + request.getRemoteAddr();

        RateLimitResult result = rateLimiter.checkLimit(limitKey, policy);

        addRateLimitHeaders(response, result);

        if (!result.allowed()) {
            response.setStatus(429);
            response.setContentType("application/problem+json");   // RFC 9457
            response.setHeader(HDR_RETRY_AFTER,
                               String.valueOf(result.retryAfterSeconds()));
            response.getWriter().write("""
                {"type":"https://api.bank.com/problems/rate-limit-exceeded",
                 "title":"Too Many Requests","status":429,
                 "detail":"Too many requests. Retry after %d seconds."}
                """.formatted(result.retryAfterSeconds()));
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
        // OAuth2 clients: rate-limit on the verified client id AFTER authentication
        // (e.g. in a filter placed after Spring Security), never on the raw token —
        // tokens rotate, so each new token would get a fresh bucket.
        return request.getHeader("X-API-Key");
    }

    // getRemoteAddr(): with server.forward-headers-strategy=native, Spring derives it
    // from X-Forwarded-For set by YOUR load balancer. Never read the first
    // X-Forwarded-For value yourself — clients can put anything there.
}
```

لاحظ: لا يُستخدم سر خام (مفتاح API) كمفتاح في Redis أبدًا، بل قيمة تجزئته. ولعملاء OAuth2، يُحدد المعدّل على معرّف العميل المُتحقَّق منه بعد المصادقة، لا على الرمز الخام — فالرموز تتجدد، وكل رمز جديد سيحصل على دلو جديد. وعنوان IP يأتي من `getRemoteAddr()` مع الإعداد `server.forward-headers-strategy=native`، فيشتقه Spring من الترويسة `X-Forwarded-For` التي يضبطها موازن الحمل لديك؛ ولا تقرأ القيمة الأولى من `X-Forwarded-For` بنفسك أبدًا — فالعملاء يستطيعون وضع أي شيء فيها.

---

## حدود لكل نقطة نهاية باستخدام AOP

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

## الضغط العكسي في الأنظمة التفاعلية

عندما تكون خدمة لاحقة بطيئة، لا يكفي تحديد المعدّل عند نقطة الدخول. فيجب أن تطبق خدمة الدفع ضغطًا عكسيًا (back pressure) لتجنب الأعطال المتتالية.

### الضغط العكسي في Project Reactor

```java
@Component
public class ReactivePaymentProcessor {

    private final CardNetworkClient cardNetworkClient;
    private final RateLimiter       cardNetworkLimiter;   // Resilience4j: 100 calls/s
    private final MeterRegistry     meterRegistry;

    /**
     * Process a payment stream with back pressure and a rate limit.
     * flatMap(..., 20) keeps at most 20 authorisations in flight and only requests
     * more from upstream when one completes — that is the back pressure.
     */
    public Flux<PaymentResult> processPayments(Flux<PaymentRequest> payments) {
        return payments
            .flatMap(this::processOne, 20)
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
        return cardNetworkClient.authorise(payment)   // carries payment.id() as idempotency key
            .transformDeferred(RateLimiterOperator.of(cardNetworkLimiter))
            .timeout(Duration.ofSeconds(5))
            // Retry ONLY this payment and only transient failures. A retry on the whole
            // Flux would re-subscribe the stream and resubmit every payment.
            .retryWhen(Retry.backoff(3, Duration.ofMillis(100))
                .maxBackoff(Duration.ofSeconds(2))
                .filter(ex -> ex instanceof TransientNetworkException))
            .map(auth -> PaymentResult.from(payment, auth));
    }
}
```

يُبقي `flatMap(..., 20)` عشرين تفويضًا على الأكثر قيد التنفيذ، ولا يطلب المزيد من المصدر إلا عندما يكتمل أحدها — وهذا هو الضغط العكسي. ويُطبَّق حد المعدّل (100 استدعاء في الثانية) وإعادة المحاولة على كل دفعة منفردة: فإعادة المحاولة على التدفق كله ستعيد الاشتراك فيه وتعيد إرسال كل الدفعات.

### محدد المعدّل في Resilience4j (بأسلوب تصريحي)

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

    // Queuing suits asynchronous flows (payouts, batch collections). A card
    // authorisation with a customer at the till cannot be queued — decline it instead.
    private Mono<AuthorisationResponse> queueForRetry(
            AuthorisationRequest request,
            RequestNotPermitted ex) {
        meterRegistry.counter("card_network.rate_limited").increment();
        return retryQueue.enqueue(request)
            .thenReturn(AuthorisationResponse.pending(request.paymentId()));
    }
}
```

يناسب وضع الطلب في طابور إعادة المحاولة التدفقات غير المتزامنة (الدفعات الصادرة، والتحصيلات الدفعية). أما تفويض بطاقة والعميل واقف عند نقطة البيع فلا يمكن وضعه في طابور — بل يُرفض.

---

## إعداد عنقود Redis واستراتيجية "السماح عند التعطل"

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

## فحوص السرعة لكشف الاحتيال

```java
@Service
public class PaymentVelocityService {

    private final SlidingWindowLogRateLimiter velocityLimiter;
    private final FraudAlertPublisher         alertPublisher;

    /**
     * Multi-window velocity check on payment submission.
     * Checks multiple time horizons to detect both burst and sustained fraud.
     * Uses the sliding-window-log limiter from Algorithm 2, generalised to take a
     * window; checkUniqueCount applies the same idea to a sorted set of merchant ids.
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

## SQL: مخطط إعدادات تحديد المعدّل

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

## تحديد المعدّل في بوابة Kong

في عمليات النشر في الإنتاج، افرض خط الدفاع الأول لتحديد المعدّل عند البوابة قبل وصول الطلبات إلى خدمات التطبيق. (الإضافة `rate-limiting-advanced` من Kong Enterprise؛ أما الإضافة مفتوحة المصدر `rate-limiting` فتقدم نوافذ ثابتة بإعدادات أبسط.)

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

## أخطاء شائعة

**1. استخدام وقت الساعة داخل سكربتات Lua**
قد ترسل عقد التطبيق المختلفة طوابع زمنية `now` مختلفة إلى Redis. ولأعلى دقة، استخدم الأمر `TIME` في Redis داخل سكربت Lua للحصول على طابع زمني متسق من جهة الخادم بدل الاعتماد على ساعة العميل.

**2. احتساب إعادات المحاولة الآمنة من التكرار**
العميل الذي يتلقى ردًا 5xx ويعيد محاولة الدفعة نفسها بمفتاح منع التكرار نفسه يجب ألا يُحتسب مرتين. تحقق مما إذا كان مفتاح منع التكرار قد عولج بالفعل قبل استهلاك رمز من حد المعدّل.

**3. التدافع عند تصفير النافذة**
تُصفَّر عدّادات النافذة الثابتة عند حد زمني (مثل بداية الدقيقة). فيطلق كل عميل كان ينتظر عند الحد طلباته في اللحظة نفسها، فيحدث قطيع هائج. استخدم خوارزميات النافذة المنزلقة وأضف عشوائية (jitter) إلى تراجع إعادة المحاولة لدى العملاء لتجنب ذلك.

**4. محددات معدّل لكل نسخة في عمليات النشر الموزعة الحمل**
‏`RateLimiter` في Guava والخوارزميات داخل العملية تعمل لكل JVM. فمع 10 نسخ، يصبح حد المعدّل الإجمالي الفعلي 10 أضعاف القيمة لكل نسخة. استخدم دائمًا مخزنًا موزعًا للحدود الحاسمة في عمليات النشر متعددة النسخ.

**5. تطبيق حدود الإنتاج على الحركة الداخلية**
الاستدعاءات الداخلية بين الخدمات (مثل استدعاء payment-service للخدمة account-service داخل العنقود) يجب أن تستخدم سياسات منفصلة عالية السعة. فتطبيق حدود فئات العملاء على الحركة الداخلية سيسبب أعطالًا متتالية تحت الحمل.

---

## نصائح للإنتاج

**اعرض ترويسات حد المعدّل الثلاث في كل رد**
العملاء الذين لا يتلقون `X-RateLimit-Limit` و`X-RateLimit-Remaining` و`X-RateLimit-Reset` يضطرون إلى تنفيذ تراجع أسي أعمى. ووجود الترويسات الثلاث في كل رد (لا في ردود 429 فقط) يتيح خنقًا استباقيًا من جهة العميل.

**حذّر قبل الحد الصارم**
اعرض الحصة المتبقية في كل رد حتى تستطيع مكتبات العملاء الجيدة الإبطاء قبل الاصطدام بالحد. وفكّر في حقلي الترويسة `RateLimit` و`RateLimit-Policy` من IETF (ما زالا مسودة) كصيغة معيارية؛ ولا تستخدم الترويسة القديمة `Warning` التي ألغاها RFC 9111.

**استخدم بادئات مفاتيح Redis منفصلة لكل بيئة**
ابدأ كل المفاتيح بـ `prod:` أو `staging:` أو `dev:` لمنع اختبارات الحمل في عنقود Redis مشترك من استهلاك حصة الإنتاج.

**نبّه على نسبة ردود 429 كإشارة لصحة الخدمة**
قفزة في ردود 429 تدل إما على عميل يسيء التصرف أو على خدمة لاحقة تسبب عواصف إعادة محاولة. نبّه عندما تتجاوز نسبة ردود 429 خمسة بالمئة من الطلبات في أي نافذة مدتها 60 ثانية، واربطها بمقاييس زمن الخدمات اللاحقة.

**خزّن أحداث المخالفات لمراجعة الاحتيال**
يجب تسجيل كل رد 429 من نقطة نهاية في واجهة الدفع في الجدول `rate_limit_violations` بسياق كافٍ (معرّف العميل، ونقطة النهاية، والحجم) ليراجعه فريق عمليات الاحتيال. فتجاوزات حد المعدّل مؤشر مبكر على الإساءة الآلية.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تستخدم واجهة دفع محدد معدّل بنافذة ثابتة يُصفَّر في بداية كل دقيقة. بلغ عميل الحد عند 00:59 وانتظر التصفير عند 01:00. وفي 01:00 بالضبط، أرسل هذا العميل وعملاء كثيرون آخرون كانوا ينتظرون طلباتهم في الوقت نفسه. ما المشكلة التي يسببها ذلك، وأي خوارزمية تتجنبها؟",
      "options": [
        "ستُرفض الطلبات لأن العداد لم يُصفَّر بالكامل بعد. ويتجنب دلو الرموز ذلك بتصفير العدادات بشكل غير متزامن.",
        "يطلق كل العملاء المنتظرين طلباتهم معًا عند حد النافذة، فيحدث قطيع هائج. ويتجنب عدّاد النافذة المنزلقة ذلك بتنعيم الانتقال بين النوافذ.",
        "تحتسب خوارزمية النافذة الثابتة الطلبات التي تعبر الحد مرتين، فيُحدّ معدّل العملاء حتى عندما يجب السماح لهم. ويتجنب الدلو المتسرب ذلك.",
        "يصبح عداد النافذة الثابتة سالبًا عند الحد بسبب الإنقاصات المتزامنة. وتمنع معاملات Redis ذلك في الإعداد الموزع."
      ],
      "correct": 1,
      "explanation": "تُصفَّر عدّادات النافذة الثابتة عند حدود زمنية، فيطلق كل عميل منتظر طلباته معًا في بداية الدقيقة — قطيع هائج. أما عدّاد النافذة المنزلقة فيحتفظ بعدّ موزون عبر الحد، فينعّم الانتقال ويمنع الحركة الاندفاعية لحظة التصفير. وإضافة العشوائية إلى تراجع إعادة المحاولة لدى العملاء تقلل أثر التدافع أكثر."
    },
    {
      "text": "تنشر منصة دفع 10 نسخ من خدمة الواجهة. تستخدم كل نسخة RateLimiter من Guava داخل العملية بحد 100 طلب في الثانية. ما حد المعدّل الفعلي عبر الأسطول؟",
      "options": [
        "100 طلب في الثانية، لأن RateLimiter في Guava يستخدم خوارزمية موزعة تنسّق بين نسخ JVM.",
        "10 طلبات في الثانية، لأن الأسطول يقسم الحد العام على عدد النسخ.",
        "1000 طلب في الثانية، لأن كل نسخة من النسخ العشر تفرض حدها البالغ 100 طلب في الثانية باستقلال.",
        "100 طلب في الثانية إجمالًا، يُفرض عند موازن الحمل قبل وصول الطلبات إلى النسخ."
      ],
      "correct": 2,
      "explanation": "محددات المعدّل داخل العملية مثل RateLimiter في Guava تعمل لكل JVM. فمع 10 نسخ تسمح كل منها بـ 100 طلب في الثانية، يصبح الحد الإجمالي الفعلي 1000 طلب في الثانية — 10 أضعاف الحد المقصود. وهذا نمط فشل حرج في عمليات النشر الموزعة. وللحدود الحاسمة عبر الأسطول يجب استخدام مخزن موزع (Redis)، لا خوارزميات داخل العملية."
    },
    {
      "text": "أصبح عنقود Redis الذي يدعم محدد المعدّل في واجهة الدفع غير متاح. يكتشف ResilientRateLimiter ذلك عبر قاطع الدائرة. ما الاستراتيجية الصحيحة ولماذا تُفضَّل لواجهة دفع؟",
      "options": [
        "الرفض عند التعطل (حجب كل الطلبات) حتى يتعافى Redis، لمنع الطلبات الاحتيالية من تجاوز حدود المعدّل.",
        "السماح عند التعطل (قبول الطلبات باستخدام محدد احتياطي لكل نسخة) لتجنب حجب كل معالجة المدفوعات بسبب عطل في البنية التحتية لمحدد المعدّل.",
        "إعادة HTTP 503 لكل الطلبات مع الترويسة Retry-After تشير إلى موعد تعافي Redis المتوقع.",
        "وضع كل الطلبات الواردة في طابور وإعادة تشغيلها بالترتيب عند تعافي Redis، مع الحفاظ على ترتيب FIFO."
      ],
      "correct": 1,
      "explanation": "يجب أن تسمح واجهات الدفع بالمرور عندما يكون محدد المعدّل غير متاح. فالرفض عند التعطل (حجب كل المدفوعات) بسبب انقطاع Redis يعني رفض 100% من حركة الدفع — فشل يدمّر الإيرادات ويضر العملاء سببه اعتمادية في البنية التحتية، لا احتيال. ويوفر المحدد الاحتياطي لكل نسخة حدًا متدهورًا لكنه يعمل. والسماح عند التعطل هو المفاضلة الصحيحة لحدود الإنتاجية والعدالة؛ أما حدود السرعة التي تعمل كضوابط احتيال فيجب أن ترجع إلى قاعدة متحفظة (مثل السماح بمبالغ أقل أثناء تعطل Redis)."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ تحديد معدّل متعدد الطبقات لواجهة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "نفّذ محدد معدّل بدلو رموز قائم على Redis باستخدام سكربت Lua ذري. يجب على السكربت: (أ) إعادة ملء الرموز بناءً على الوقت المنقضي منذ آخر ملء، (ب) فحص رمز واحد واستهلاكه ذريًا، (ج) ضبط مدة صلاحية لمفتاح Redis تساوي ضعف فترة إعادة الملء، (د) إعادة علامة السماح، والرموز المتبقية، ومدة الصلاحية. واكتب اختبارات وحدة باستخدام Redis مدمج (Testcontainers أو محاكاة Jedis) تتحقق من سلوك الاندفاع، وسلوك إعادة الملء، وسلوك الرفض عند نفاد الرموز."},
    {"id": "2", "description": "نفّذ الوسم @RateLimit والصنف RateLimitAspect باستخدام Spring AOP. يجب أن يدعم الوسم المعاملين requestsPerMinute وburstCapacity، ومعامل keySuffix للتمييز بين نقاط النهاية. طبّق الوسم على ثلاث نقاط نهاية في متحكم الدفع بحدود مختلفة: 60 في الدقيقة لإرسال الدفعة، و5 في الدقيقة للدفعات الجماعية، و300 في الدقيقة لاستعلامات الحالة. واكتب اختبارات تتحقق من أن كل نقطة نهاية تفرض حدها باستقلال."},
    {"id": "3", "description": "نفّذ PaymentVelocityService يجري فحوص سرعة متعددة النوافذ لكشف الاحتيال. افحص: (أ) 10 دفعات لكل عميل في الدقيقة، (ب) 50 دفعة لكل عميل في الساعة، (ج) 5 تجار مختلفين لكل رمز بطاقة خلال 10 دقائق. استخدم خوارزمية سجل النافذة المنزلقة للفحوص الثلاثة. واكتب اختبارات تحاكي نمط احتيال اختبار البطاقات (تجار مختلفون كثيرون في نافذة قصيرة) وتتحقق من إطلاق التنبيه عند الحد الصحيح."},
    {"id": "4", "description": "ابنِ ResilientRateLimiter يغلّف دلو الرموز القائم على Redis بقاطع دائرة من Resilience4j. وعندما يكون Redis غير متاح، ارجع إلى RateLimiter من Guava لكل نسخة، مع ملاحظة في السجلات بأن الحد الفعلي يُضرب في عدد النسخ. اضبط قاطع الدائرة ليفتح بعد 3 إخفاقات في 5 ثوانٍ وينتقل إلى نصف مفتوح بعد 10 ثوانٍ. واكتب اختبار تكامل يحاكي عدم توفر Redis ويتحقق من تفعيل البديل وإعادته نتائج مسموحة بدل حجب الطلبات."}
  ]
}
-->
