---
id: track-06-lesson-04
title: "Retry Patterns — Exponential Backoff and Jitter"
slug: retry-patterns
track: track-06
trackName: "Reliability & Production Engineering"
sequence: 4
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [retry, exponential-backoff, jitter, idempotency, Resilience4j]
prerequisites: []
---

# Retry Patterns — Exponential Backoff and Jitter

> [!NOTE]
> Retrying a non-idempotent payment twice can charge a customer twice. Every retry decision in fintech must be backed by an idempotency strategy, not just a convenience wrapper.

## 1. When to Retry and When Not To

Retries are a double-edged sword in financial systems. Done correctly, they mask transient infrastructure failures from end users. Done incorrectly, they create duplicate transactions, amplify load on already-degraded systems, and obscure root-cause signals in your observability stack.

### Retriable Errors

| Condition | HTTP / Code | Why Retriable |
|---|---|---|
| Network timeout | `SocketTimeoutException` | Transient connectivity blip |
| Service unavailable | `503` | Downstream temporarily overloaded |
| Rate limit hit | `429` | Explicit retry-after signal |
| Idempotent 5xx | `500` on GET | Server-side transient error |
| Kafka unavailable | `TimeoutException` | Broker temporarily unreachable |

> [!WARNING]
> A **read timeout** (or a 502/504) on a non-idempotent call such as a payment POST is an *unknown outcome*: the payment may have gone through. Retry it only with the **same idempotency key**, so the processor can recognise the duplicate — or query the payment's status first. A *connect* timeout is different: the request never left, so retrying is safe.

### Non-Retriable Errors

| Condition | HTTP / Code | Why NOT Retriable |
|---|---|---|
| Bad request | `400` | Client bug — retrying returns same error |
| Unauthorized | `401` | Credentials invalid — retry won't fix |
| Duplicate transaction | `409 Conflict` | Already processed |
| Insufficient funds | `422` | Business logic rejection |
| Account frozen | `403` | Compliance hold |

```java
// Classify errors before blindly retrying.
// Assumes every payment call carries an idempotency key — that is what makes
// retrying an unknown outcome (read timeout, 502/504) safe.
public class PaymentRetryClassifier {

    public boolean isRetriable(Throwable throwable) {
        if (throwable instanceof FeignException feignException) {
            int status = feignException.status();
            // Never retry client errors (4xx) except 429
            if (status >= 400 && status < 500 && status != 429) {
                return false;
            }
            // 500 Internal Server Error - only if we know it's idempotent
            if (status == 500) {
                return isIdempotentOperation(feignException);
            }
            // 502/503/504 and 429 - retriable (with the idempotency key)
            return status == 502 || status == 503 || status == 504 || status == 429;
        }
        if (throwable instanceof ConnectTimeoutException) {
            return true;    // request never sent
        }
        if (throwable instanceof SocketTimeoutException) {
            return true;    // unknown outcome: safe ONLY with the idempotency key
        }
        // Business exceptions and anything unknown are never retried
        return false;
    }

    private boolean isIdempotentOperation(FeignException e) {
        // Check if the original request method was idempotent
        // GET, HEAD, PUT, DELETE are idempotent; POST is not by default
        String method = e.request().httpMethod().name();
        return "GET".equals(method) || "PUT".equals(method) || "DELETE".equals(method);
    }
}
```

## 2. Exponential Backoff — The Formula

Naive fixed-delay retries are harmful in financial systems. When a payment processor goes down, every client retrying at fixed 1-second intervals creates synchronized thundering herd traffic — all clients slam the recovering service at the same instant.

Exponential backoff formula:

```
delay(attempt) = min(base * multiplier^attempt, maxDelay)
```

For financial systems, typical values:
- `base` = 100–500ms
- `multiplier` = 2.0
- `maxDelay` = 30s–60s
- `maxAttempts` = 3–5

```java
@Configuration
public class RetryConfiguration {

    @Bean
    public RetryConfig paymentRetryConfig() {
        return RetryConfig.custom()
            .maxAttempts(4)   // 1 call + 3 retries
            // Exponential backoff between attempts: 500ms, 1s, 2s
            // (do not ALSO set waitDuration — use one way of setting the interval)
            .intervalFunction(IntervalFunction.ofExponentialBackoff(
                Duration.ofMillis(500),  // initial interval
                2.0                       // multiplier
            ))
            .retryOnException(new PaymentRetryClassifier()::isRetriable)
            .retryOnResult(response -> {
                // Also retry on specific business response codes
                if (response instanceof PaymentResponse pr) {
                    return "PENDING_RETRY".equals(pr.getStatus());
                }
                return false;
            })
            .build();
    }

    @Bean
    public RetryRegistry retryRegistry(RetryConfig paymentRetryConfig) {
        // Registered as the DEFAULT config, so retryRegistry.retry("payment")
        // uses it. (RetryRegistry.of(Map.of("payment", cfg)) only registers a
        // named CONFIG; retry("payment") would still use the built-in default
        // unless you call retry("payment", "payment").)
        return RetryRegistry.of(paymentRetryConfig);
    }
}
```

## 3. Jitter — Breaking the Thundering Herd

Without jitter, clients with the same backoff configuration all retry simultaneously. Jitter adds randomness to spread retry load across time.

### Full Jitter

```
delay = random(0, min(base * multiplier^attempt, maxDelay))
```

Spreads retries uniformly across the full window. Best for high-contention scenarios like Black Friday payment spikes.

### Equal Jitter

```
half = min(base * multiplier^attempt, maxDelay) / 2
delay = half + random(0, half)
```

Guarantees minimum wait while adding jitter. Good for payment gateways where you want some guaranteed backoff.

### Decorrelated Jitter

```
delay = min(maxDelay, random(base, previous_delay * 3))
```

Produces the most spread-out distribution. Best for large fleets (100+ service instances).

```java
@Configuration
public class JitteredRetryConfig {

    /**
     * Full jitter implementation for payment gateway calls.
     * Prevents thundering herd when gateway recovers from downtime.
     */
    @Bean
    public RetryConfig fullJitterRetryConfig() {
        return RetryConfig.custom()
            .maxAttempts(4)
            .intervalFunction(attempt -> {
                long baseMs = 500;
                long maxMs = 30_000;
                long exponential = (long) (baseMs * Math.pow(2, attempt - 1));
                long cap = Math.min(exponential, maxMs);
                // Full jitter: uniform random in [0, cap]
                return ThreadLocalRandom.current().nextLong(0, cap);
            })
            .retryOnException(new PaymentRetryClassifier()::isRetriable)
            .build();
    }

    /**
     * Equal jitter for ACH batch processing where minimum delay matters.
     */
    @Bean
    public RetryConfig equalJitterRetryConfig() {
        return RetryConfig.custom()
            .maxAttempts(3)
            .intervalFunction(attempt -> {
                long baseMs = 1_000;
                long maxMs = 60_000;
                long exponential = (long) (baseMs * Math.pow(2, attempt - 1));
                long cap = Math.min(exponential, maxMs);
                long half = cap / 2;
                // Equal jitter: guaranteed half wait + random half
                return half + ThreadLocalRandom.current().nextLong(0, half);
            })
            .build();
    }

    /**
     * Decorrelated jitter for high-volume FX quote fetching
     * across a large number of service instances.
     */
    @Bean
    public RetryConfig decorrelatedJitterRetryConfig() {
        return RetryConfig.custom()
            .maxAttempts(5)
            .intervalFunction(new DecorrelatedJitterInterval(500, 30_000))
            .build();
    }
}

/**
 * Decorrelated jitter maintains state across retry attempts.
 * Each attempt uses the previous delay to compute the next.
 */
public class DecorrelatedJitterInterval implements IntervalFunction {
    private final long baseMs;
    private final long maxMs;
    private final ThreadLocal<Long> previousDelay;

    public DecorrelatedJitterInterval(long baseMs, long maxMs) {
        this.baseMs = baseMs;
        this.maxMs = maxMs;
        this.previousDelay = ThreadLocal.withInitial(() -> baseMs);
    }

    @Override
    public long apply(int attempt) {
        // Attempt 1 starts a NEW retry sequence — reset, or the delay carries
        // over from an unrelated earlier call on the same thread.
        // (Thread-local state also assumes all attempts run on one thread —
        //  not true for async retries; keep the state per operation there.)
        long prev = (attempt <= 1) ? baseMs : previousDelay.get();
        long next = Math.min(maxMs, ThreadLocalRandom.current().nextLong(baseMs, prev * 3));
        previousDelay.set(next);
        return next;
    }
}
```

## 4. Resilience4j Retry — Production Configuration

```java
@Service
@Slf4j
public class PaymentGatewayService {

    private final Retry retry;
    private final CircuitBreaker cb;
    private final PaymentGatewayClient gatewayClient;
    private final PaymentDeadLetterHandler deadLetterHandler;

    public PaymentGatewayService(RetryRegistry retryRegistry,
                                 CircuitBreakerRegistry circuitBreakerRegistry,
                                 PaymentGatewayClient gatewayClient,
                                 PaymentDeadLetterHandler deadLetterHandler,
                                 MeterRegistry meterRegistry) {
        this.retry = retryRegistry.retry("payment");
        this.cb = circuitBreakerRegistry.circuitBreaker("payment-gateway");
        this.gatewayClient = gatewayClient;
        this.deadLetterHandler = deadLetterHandler;

        // Register listeners ONCE. Registering them inside submitPayment()
        // would add a new listener on every call — a memory leak and
        // duplicated logs. Per-request context comes from the MDC.
        retry.getEventPublisher()
            .onRetry(event -> {
                log.warn("Payment retry attempt={} idempotencyKey={} cause={}",
                    event.getNumberOfRetryAttempts(),
                    MDC.get("idempotencyKey"),
                    event.getLastThrowable().getClass().getSimpleName());
                meterRegistry.counter("payment.retry",
                    "attempt", String.valueOf(event.getNumberOfRetryAttempts())
                ).increment();
            })
            .onError(event -> log.error("Payment exhausted all retries for key={}",
                MDC.get("idempotencyKey"), event.getLastThrowable()))
            .onSuccess(event -> log.info("Payment succeeded after {} retries key={}",
                event.getNumberOfRetryAttempts(), MDC.get("idempotencyKey")));
    }

    /**
     * Submit payment with retry + circuit breaker integration.
     * Retry wraps the circuit breaker, not the other way around.
     * This means: attempt → check CB → call → on failure → backoff → check CB again.
     */
    public PaymentResponse submitPayment(PaymentRequest request) {
        Supplier<PaymentResponse> decoratedCall = Retry.decorateSupplier(
            retry,
            CircuitBreaker.decorateSupplier(cb,
                () -> gatewayClient.submit(request)   // carries the idempotency key
            )
        );

        MDC.put("idempotencyKey", request.getIdempotencyKey());
        try {
            return decoratedCall.get();
        } catch (CallNotPermittedException e) {
            throw new PaymentGatewayUnavailableException(
                "Circuit breaker open for gateway: " + request.getGateway(), e);
        } catch (RuntimeException e) {
            // When retries on EXCEPTIONS are exhausted, Resilience4j rethrows
            // the last exception itself. (MaxRetriesExceededException is only
            // thrown when retries on a RESULT predicate run out.)
            deadLetterHandler.handleExhaustedRetries(request, e,
                retry.getRetryConfig().getMaxAttempts());
            throw new PaymentGatewayTemporarilyUnavailableException(
                "Retries exhausted for key: " + request.getIdempotencyKey(), e);
        } finally {
            MDC.remove("idempotencyKey");
        }
    }
}
```

## 5. Idempotency Keys — Safe Retrying of Payment Calls

A retry is only safe if the downstream operation is idempotent. For POST operations (payment submissions), you must use an idempotency key so the payment processor can detect and deduplicate retries.

```java
/**
 * Idempotency key strategy for payment retries.
 * Keys must be:
 * - Deterministic (same payment = same key)
 * - Unique per business transaction (not per HTTP call)
 * - Short-lived (typically 24–72 hours TTL at the processor)
 */
@Component
public class IdempotencyKeyStrategy {

    /**
     * Generate a stable idempotency key for a payment request.
     * This key is preserved across retries of the same logical payment.
     */
    public String generateKey(PaymentRequest request) {
        // Derived from the business transaction. (A random UUID is also fine
        // IF it is generated once when the payment is created and stored —
        // what must never happen is a NEW key per attempt.)
        String composite = String.join(":",
            request.getAccountId(),
            request.getBeneficiaryAccountId(),
            request.getAmountCents().toString(),
            request.getCurrency(),
            request.getBusinessTransactionId()  // internal reference
        );
        return "pay_" + Hashing.sha256()
            .hashString(composite, StandardCharsets.UTF_8)
            .toString()
            .substring(0, 32);
    }
}

@Service
@RequiredArgsConstructor
public class IdempotentPaymentService {

    private final IdempotencyKeyStrategy keyStrategy;
    private final IdempotencyKeyStore keyStore;  // Redis-backed
    private final PaymentGatewayService gatewayService;

    public PaymentResponse submitPaymentIdempotent(PaymentRequest request) {
        String idempotencyKey = keyStrategy.generateKey(request);
        request.setIdempotencyKey(idempotencyKey);

        // Check if we've already successfully processed this payment
        Optional<PaymentResponse> cached = keyStore.get(idempotencyKey);
        if (cached.isPresent()) {
            log.info("Returning cached response for idempotency key={}", idempotencyKey);
            return cached.get();
        }

        // Mark as in-flight to prevent concurrent duplicate submissions
        boolean acquired = keyStore.setInFlight(idempotencyKey, Duration.ofMinutes(5));
        if (!acquired) {
            throw new ConcurrentPaymentSubmissionException(
                "Payment with key " + idempotencyKey + " is already being processed");
        }

        try {
            PaymentResponse response = gatewayService.submitPayment(request);
            // Cache successful response for deduplication window (24h)
            keyStore.storeSuccess(idempotencyKey, response, Duration.ofHours(24));
            return response;
        } catch (RuntimeException e) {
            // Releasing the marker is safe because a later attempt sends the
            // SAME key: the processor — the real arbiter — recognises a payment
            // that did go through before the failure. Redis is only a fast path.
            keyStore.clearInFlight(idempotencyKey);
            throw e;
        }
    }
}

@Repository
@RequiredArgsConstructor
public class RedisIdempotencyKeyStore implements IdempotencyKeyStore {

    private final RedisTemplate<String, PaymentResponse> redisTemplate;
    private final StringRedisTemplate markerTemplate;   // for the in-flight marker
    private static final String PREFIX = "idempotency:";
    private static final String INFLIGHT_PREFIX = "idempotency:inflight:";

    @Override
    public Optional<PaymentResponse> get(String key) {
        PaymentResponse response = redisTemplate.opsForValue().get(PREFIX + key);
        return Optional.ofNullable(response);
    }

    @Override
    public boolean setInFlight(String key, Duration ttl) {
        // Redis cannot store a null value — use a small marker string
        Boolean result = markerTemplate.opsForValue()
            .setIfAbsent(INFLIGHT_PREFIX + key, "1", ttl);
        return Boolean.TRUE.equals(result);
    }

    @Override
    public void storeSuccess(String key, PaymentResponse response, Duration ttl) {
        redisTemplate.opsForValue().set(PREFIX + key, response, ttl);
        markerTemplate.delete(INFLIGHT_PREFIX + key);
    }

    @Override
    public void clearInFlight(String key) {
        markerTemplate.delete(INFLIGHT_PREFIX + key);
    }
}
```

## 6. Spring @Retryable — Declarative Retries

For simpler scenarios, Spring Retry's `@Retryable` annotation is clean and readable. Use it for internal service calls, not for payment gateway calls where you need full control.

```java
@Configuration
@EnableRetry
public class SpringRetryConfig {
    // Activates @Retryable processing
}

@Service
@Slf4j
public class FxRateService {

    /**
     * Retry FX rate fetches with exponential backoff.
     * FX rate queries are idempotent GET operations — safe to retry unconditionally.
     */
    @Retryable(
        // I/O errors and 5xx only. (RestClientException would also match
        // HttpClientErrorException — 4xx such as 401 — which must not be retried.)
        retryFor = {ResourceAccessException.class, HttpServerErrorException.class},
        noRetryFor = {HttpClientErrorException.class},
        maxAttempts = 4,
        backoff = @Backoff(
            delay = 200,
            multiplier = 2.0,
            maxDelay = 5000,
            random = true  // adds jitter
        )
    )
    public ExchangeRate fetchRate(String fromCurrency, String toCurrency) {
        log.debug("Fetching FX rate {}/{}", fromCurrency, toCurrency);
        return fxProviderClient.getRate(fromCurrency, toCurrency);
    }

    @Recover
    public ExchangeRate recoverFxRate(RestClientException ex,
                                       String fromCurrency,
                                       String toCurrency) {
        // A cached rate is acceptable for an INDICATIVE quote shown to a user;
        // an executable FX conversion must never silently use a stale rate.
        log.warn("FX rate fetch failed after retries, using cached rate {}/{}",
            fromCurrency, toCurrency);
        return cachedRateRepository.findLatest(fromCurrency, toCurrency)
            .orElseThrow(() -> new FxRateUnavailableException(
                "No rate available for " + fromCurrency + "/" + toCurrency));
    }
}
```

## 7. Dead Letter Queue After Max Retries

When retries are exhausted, don't silently swallow the failure. Send to a dead letter queue (DLQ) for manual review and potential reprocessing.

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class PaymentDeadLetterHandler {

    private final KafkaTemplate<String, DeadLetterPayment> kafkaTemplate;
    private final AlertingService alertingService;
    private static final String DLQ_TOPIC = "payment-dlq";

    public void handleExhaustedRetries(PaymentRequest request,
                                        Throwable lastException,
                                        int attemptsCount) {
        DeadLetterPayment dlqEntry = DeadLetterPayment.builder()
            .originalRequest(request)
            .failureReason(lastException.getMessage())
            .failureClass(lastException.getClass().getName())
            .attemptCount(attemptsCount)
            .firstAttemptAt(request.getCreatedAt())
            .lastAttemptAt(Instant.now())
            .idempotencyKey(request.getIdempotencyKey())
            .metadata(Map.of(
                "accountId", request.getAccountId(),
                "amountCents", request.getAmountCents().toString(),
                "currency", request.getCurrency()
            ))
            .build();

        kafkaTemplate.send(DLQ_TOPIC, request.getIdempotencyKey(), dlqEntry)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    log.error("CRITICAL: Failed to send payment to DLQ key={}",
                        request.getIdempotencyKey(), ex);
                    // If DLQ send fails, write to local fallback store
                    writeToDlqFallbackStore(dlqEntry);
                }
            });

        // Alert on-call team for high-value transactions (over 100,000.00)
        if (request.getAmountCents() > 10_000_000L) {
            alertingService.page(PagerDutyAlert.builder()
                .severity(Severity.P2)
                .summary("High-value payment failed after all retries")
                .details(Map.of(
                    "idempotencyKey", request.getIdempotencyKey(),
                    "amountCents", request.getAmountCents(),
                    "attempts", attemptsCount
                ))
                .build());
        }
    }

    /**
     * DLQ consumer for manual review and reprocessing.
     * Operations team triggers reprocessing after root cause is fixed.
     */
    @KafkaListener(topics = DLQ_TOPIC, groupId = "payment-dlq-processor")
    public void processDlqEntry(DeadLetterPayment dlqEntry,
                                 @Header(KafkaHeaders.RECEIVED_TIMESTAMP) long receivedAt) {
        log.warn("DLQ entry received key={} attempts={} age={}s",
            dlqEntry.getIdempotencyKey(),
            dlqEntry.getAttemptCount(),
            (System.currentTimeMillis() - receivedAt) / 1000);

        // Store in ops dashboard for manual triage. If the last failure was a
        // timeout, the payment's state is UNKNOWN: reprocessing must first ask
        // the processor for the payment (by idempotency key), never resend blindly.
        dlqRepository.save(dlqEntry);
    }
}
```

## 8. Circuit Breaker Integration

Retries without circuit breakers can cause retry storms. When a downstream is completely down, retries pile up and exhaust thread pools and connection pools.

```java
@Configuration
public class RetryWithCircuitBreakerConfig {

    /**
     * Order matters: Retry(CircuitBreaker(call))
     *
     * This means:
     * 1. Retry decides whether to attempt
     * 2. CircuitBreaker decides if downstream is healthy
     * 3. If CB is OPEN, retry sees CallNotPermittedException immediately
     *    (no actual network call, no waiting)
     * 4. Retry treats CNPE as non-retriable (fail fast)
     *
     * Do NOT reverse: CircuitBreaker(Retry(call)) hides individual failures
     * from the CB (it only sees the final outcome of a whole retry sequence),
     * and the retries keep hitting a dependency the CB should already have cut off.
     */
    @Bean
    public Retry paymentRetry(RetryRegistry retryRegistry) {
        return retryRegistry.retry("payment");
    }

    @Bean
    public CircuitBreaker paymentGatewayCb(CircuitBreakerRegistry cbRegistry) {
        CircuitBreakerConfig config = CircuitBreakerConfig.custom()
            .slidingWindowType(SlidingWindowType.COUNT_BASED)
            .slidingWindowSize(20)
            .failureRateThreshold(50)
            .slowCallRateThreshold(80)
            .slowCallDurationThreshold(Duration.ofSeconds(3))
            .waitDurationInOpenState(Duration.ofSeconds(30))
            .permittedNumberOfCallsInHalfOpenState(5)
            // Don't count CallNotPermittedException as a failure
            .recordExceptions(IOException.class, TimeoutException.class,
                FeignException.FeignServerException.class)
            .ignoreExceptions(CallNotPermittedException.class,
                InsufficientFundsException.class,
                DuplicateTransactionException.class)
            .build();
        return cbRegistry.circuitBreaker("payment-gateway", config);
    }
}
```

## 9. Retry Budgets — Preventing Retry Amplification

In a microservice chain (A → B → C), if each service retries 3 times, a single request can amplify into 27 calls to C. Use retry budgets to limit this.

```java
/**
 * Retry budget tracks the ratio of retries to total calls.
 * If retries exceed 10% of total calls, something is systemically wrong
 * and we should stop retrying to avoid amplification.
 */
@Component
@Slf4j
public class RetryBudget {

    private final AtomicLong totalCalls = new AtomicLong(0);
    private final AtomicLong retryCalls = new AtomicLong(0);
    private static final double MAX_RETRY_RATIO = 0.10; // 10%

    /** Call for EVERY attempt (first attempts and retries). */
    public void recordCall() {
        totalCalls.incrementAndGet();
    }

    /** Call before a RETRY; returns false when the budget is spent. */
    public boolean tryAcquireRetry() {
        long total = totalCalls.get();
        long retries = retryCalls.get();

        // Allow retries freely until we have a minimum sample size
        if (total >= 100 && (double) retries / total >= MAX_RETRY_RATIO) {
            log.warn("Retry budget exhausted: retryRatio={}% limit={}%",
                String.format("%.2f", 100.0 * retries / total), MAX_RETRY_RATIO * 100);
            return false;
        }
        retryCalls.incrementAndGet();
        return true;
    }

    @Scheduled(fixedRate = 60_000)   // a fresh window every minute
    public void reset() {
        totalCalls.set(0);
        retryCalls.set(0);
    }
}
```

## 10. Metrics and Observability for Retries

```java
@Component
@RequiredArgsConstructor
public class RetryMetricsPublisher {

    private final MeterRegistry meterRegistry;

    public void registerRetryMetrics(Retry retry, String service) {
        // Built-in Resilience4j metrics: with resilience4j-micrometer, the
        // Spring Boot starter binds TaggedRetryMetrics for the RetryRegistry
        // automatically. If you build the registry yourself, bind THAT registry
        // once: TaggedRetryMetrics.ofRetryRegistry(retryRegistry).bindTo(meterRegistry)
        // (binding a brand-new RetryRegistry would publish nothing).

        // Custom metrics for financial monitoring
        retry.getEventPublisher()
            .onRetry(event -> {
                meterRegistry.counter("payment.retry.attempts",
                    "service", service,
                    "attempt_number", String.valueOf(event.getNumberOfRetryAttempts()),
                    "exception_type", event.getLastThrowable().getClass().getSimpleName()
                ).increment();
            })
            .onSuccess(event -> {
                if (event.getNumberOfRetryAttempts() > 0) {
                    meterRegistry.counter("payment.retry.recovery",
                        "service", service,
                        "recovered_on_attempt", String.valueOf(event.getNumberOfRetryAttempts())
                    ).increment();
                }
            })
            .onError(event -> {
                meterRegistry.counter("payment.retry.exhausted",
                    "service", service,
                    "final_exception", event.getLastThrowable().getClass().getSimpleName()
                ).increment();
            });
    }
}
```

## 11. application.yml Configuration

```yaml
resilience4j:
  retry:
    configs:
      default:
        max-attempts: 3
        wait-duration: 500ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        exponential-max-wait-duration: 30s
        retry-exceptions:
          - java.io.IOException
          - java.net.SocketTimeoutException
          - feign.FeignException$ServiceUnavailable   # nested class: use $
        ignore-exceptions:
          - com.fintech.payments.exception.InsufficientFundsException
          - com.fintech.payments.exception.DuplicateTransactionException
      payment-gateway:
        max-attempts: 4
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2.5
        exponential-max-wait-duration: 60s
        # exponential backoff + randomisation = jitter
        enable-randomized-wait: true
        randomized-wait-factor: 0.5
      fx-rate:
        max-attempts: 5
        wait-duration: 100ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
    instances:
      paymentGateway:
        base-config: payment-gateway
      fxProvider:
        base-config: fx-rate
      achProcessor:
        base-config: default
```

## 12. Production Tips for Financial Systems

**Correlate retries with request IDs.** Every retry attempt for the same logical payment must carry the same correlation ID. This is essential for distributed tracing and audit trails.

**Log retry context richly.** Log the idempotency key, attempt number, delay applied, and exception class (not just message) on every retry.

**Alert on retry rate spikes.** A sudden jump in retry rate (e.g., from 0.5% to 8%) is a leading indicator of a downstream degradation. Alert before it becomes an outage.

**Test retry behavior in staging.** Use Chaos Monkey or Toxiproxy to inject failures and verify that:
- Retries fire at the right times
- Idempotency keys prevent duplicate charges
- DLQ receives entries after exhaustion
- Circuit breaker opens when failure rate exceeds threshold

**Respect Retry-After headers.** When payment processors return `429 Too Many Requests` with a `Retry-After: 5` header, honor that value instead of your computed backoff. Ignoring it causes further rate limiting.

```java
// Resilience4j passes the last result or exception to an IntervalBiFunction,
// so the Retry-After value can be read straight from the 429 response.
public class RetryAfterAwareInterval implements IntervalBiFunction<Object> {

    @Override
    public Long apply(Integer attempt, Either<Throwable, Object> outcome) {
        if (outcome.isLeft()
                && outcome.getLeft() instanceof FeignException fe
                && fe.status() == 429) {
            Optional<Long> retryAfterMs = fe.responseHeaders()
                .getOrDefault("Retry-After", List.of()).stream()
                .findFirst()
                .filter(v -> v.chars().allMatch(Character::isDigit)) // seconds form;
                .map(v -> Long.parseLong(v) * 1000);                 // an HTTP-date form also exists
            if (retryAfterMs.isPresent()) {
                return Math.min(retryAfterMs.get(), 60_000L);        // cap what we accept
            }
        }
        // Fall back to exponential backoff with full jitter
        long cap = Math.min(500L << (attempt - 1), 30_000L);
        return ThreadLocalRandom.current().nextLong(0, cap + 1);
    }
}

// RetryConfig.custom().intervalBiFunction(new RetryAfterAwareInterval()) ...
```

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which HTTP status code should trigger a retry in a payment service?",
      "options": ["400 Bad Request", "401 Unauthorized", "503 Service Unavailable", "422 Unprocessable Entity"],
      "correct": 2,
      "explanation": "503 Service Unavailable indicates a transient overload condition that may resolve on retry. 400, 401, and 422 are deterministic client or business errors that will return the same result on retry."
    },
    {
      "text": "What is the primary purpose of adding jitter to exponential backoff?",
      "options": ["To reduce the total number of retry attempts", "To prevent synchronized retry storms (thundering herd) across multiple clients", "To increase the maximum retry delay", "To make idempotency keys unique"],
      "correct": 1,
      "explanation": "Jitter adds randomness to the retry delay so that multiple clients that failed at the same time do not all retry simultaneously, which would create a thundering herd that re-overwhelms the recovering service."
    },
    {
      "text": "In a microservice chain A → B → C where each service retries 3 times on failure, what is the maximum number of calls that can reach service C from a single request to A?",
      "options": ["3", "9", "27", "81"],
      "correct": 2,
      "explanation": "Each retry at each layer multiplies: A retries 3 times, each triggering B which retries 3 times, each triggering C — resulting in 3 × 3 × 3 = 27 calls to C. This is retry amplification, mitigated by retry budgets."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Idempotent Payment Retry System with Dead Letter Queue",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Implement a PaymentRetryClassifier that correctly identifies retriable vs non-retriable exceptions, handling 429 with Retry-After header respect, and ensure non-idempotent POST calls are only retried with a valid idempotency key."
    },
    {
      "id": "2",
      "description": "Configure Resilience4j with full-jitter exponential backoff (base 500ms, multiplier 2, cap 30s, max 4 attempts) and integrate it with a CircuitBreaker using Retry(CircuitBreaker(call)) ordering."
    },
    {
      "id": "3",
      "description": "Build a Redis-backed IdempotencyKeyStore that prevents concurrent duplicate submissions using setIfAbsent with a small marker value (Redis cannot store null), stores successful responses for 24h deduplication, and clears in-flight markers on failure — explaining why that is safe only because the processor deduplicates by the same idempotency key."
    },
    {
      "id": "4",
      "description": "Implement a PaymentDeadLetterHandler that publishes exhausted payments to a Kafka DLQ topic, triggers PagerDuty alerts for transactions over $100,000, and exposes a retry budget gauge in Prometheus."
    }
  ]
}
-->

