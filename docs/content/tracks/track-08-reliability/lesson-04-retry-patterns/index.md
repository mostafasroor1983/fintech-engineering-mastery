---
id: track-08-lesson-04
title: "Retry Patterns — Exponential Backoff and Jitter"
slug: retry-patterns
track: track-08
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

### Non-Retriable Errors

| Condition | HTTP / Code | Why NOT Retriable |
|---|---|---|
| Bad request | `400` | Client bug — retrying returns same error |
| Unauthorized | `401` | Credentials invalid — retry won't fix |
| Duplicate transaction | `409 Conflict` | Already processed |
| Insufficient funds | `422` | Business logic rejection |
| Account frozen | `403` | Compliance hold |

```java
// Classify errors before blindly retrying
public class PaymentRetryClassifier {

    public boolean isRetriable(Throwable throwable) {
        if (throwable instanceof FeignException feignException) {
            int status = feignException.status();
            // Never retry client errors (4xx) except 429
            if (status >= 400 && status < 500 && status != 429) {
                return false;
            }
            // 503 Service Unavailable - retriable
            // 500 Internal Server Error - only if we know it's idempotent
            if (status == 500) {
                return isIdempotentOperation(feignException);
            }
            return status == 503 || status == 502 || status == 429;
        }
        if (throwable instanceof SocketTimeoutException
            || throwable instanceof ConnectTimeoutException) {
            return true;
        }
        // Business exceptions are never retriable
        if (throwable instanceof InsufficientFundsException
            || throwable instanceof AccountFrozenException
            || throwable instanceof DuplicateTransactionException) {
            return false;
        }
        return false;
    }

    private boolean isIdempotentOperation(FeignException e) {
        // Check if the original request method was idempotent
        // GET, HEAD, PUT, DELETE are idempotent; POST is not by default
        String method = extractRequestMethod(e);
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
            .maxAttempts(4)
            // Exponential backoff: 500ms, 1s, 2s, 4s
            .waitDuration(Duration.ofMillis(500))
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
        return RetryRegistry.of(Map.of("payment", paymentRetryConfig));
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
        long prev = previousDelay.get();
        long next = Math.min(maxMs, ThreadLocalRandom.current().nextLong(baseMs, prev * 3));
        previousDelay.set(next);
        return next;
    }
}
```

## 4. Resilience4j Retry — Production Configuration

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentGatewayService {

    private final RetryRegistry retryRegistry;
    private final CircuitBreakerRegistry circuitBreakerRegistry;
    private final PaymentGatewayClient gatewayClient;
    private final MeterRegistry meterRegistry;

    /**
     * Submit payment with retry + circuit breaker integration.
     * Retry wraps the circuit breaker, not the other way around.
     * This means: attempt → check CB → call → on failure → backoff → check CB again.
     */
    public PaymentResponse submitPayment(PaymentRequest request) {
        Retry retry = retryRegistry.retry("payment");
        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker("payment-gateway");

        // Instrument retry events for observability
        retry.getEventPublisher()
            .onRetry(event -> {
                log.warn("Payment retry attempt={} for idempotencyKey={} cause={}",
                    event.getNumberOfRetryAttempts(),
                    request.getIdempotencyKey(),
                    event.getLastThrowable().getMessage());
                meterRegistry.counter("payment.retry",
                    "attempt", String.valueOf(event.getNumberOfRetryAttempts()),
                    "gateway", request.getGateway()
                ).increment();
            })
            .onError(event -> log.error("Payment exhausted all retries for key={}",
                request.getIdempotencyKey(), event.getLastThrowable()))
            .onSuccess(event -> {
                if (event.getNumberOfRetryAttempts() > 0) {
                    log.info("Payment succeeded after {} retries key={}",
                        event.getNumberOfRetryAttempts(), request.getIdempotencyKey());
                }
            });

        Supplier<PaymentResponse> decoratedCall = Retry.decorateSupplier(
            retry,
            CircuitBreaker.decorateSupplier(cb,
                () -> gatewayClient.submit(request)
            )
        );

        try {
            return decoratedCall.get();
        } catch (CallNotPermittedException e) {
            throw new PaymentGatewayUnavailableException(
                "Circuit breaker open for gateway: " + request.getGateway(), e);
        } catch (MaxRetriesExceededException e) {
            sendToDeadLetterQueue(request, e);
            throw new PaymentGatewayTemporarilyUnavailableException(
                "Max retries exceeded for key: " + request.getIdempotencyKey(), e);
        }
    }

    private void sendToDeadLetterQueue(PaymentRequest request, Exception cause) {
        log.error("Sending payment to DLQ after retry exhaustion key={}",
            request.getIdempotencyKey());
        // DLQ implementation in Section 7
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
        // Use a combination of business identifiers, NOT UUID (UUID changes on retry)
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
        } catch (Exception e) {
            keyStore.clearInFlight(idempotencyKey);
            throw e;
        }
    }
}

@Repository
@RequiredArgsConstructor
public class RedisIdempotencyKeyStore implements IdempotencyKeyStore {

    private final RedisTemplate<String, PaymentResponse> redisTemplate;
    private static final String PREFIX = "idempotency:";
    private static final String INFLIGHT_PREFIX = "idempotency:inflight:";

    @Override
    public Optional<PaymentResponse> get(String key) {
        PaymentResponse response = redisTemplate.opsForValue().get(PREFIX + key);
        return Optional.ofNullable(response);
    }

    @Override
    public boolean setInFlight(String key, Duration ttl) {
        Boolean result = redisTemplate.opsForValue()
            .setIfAbsent(INFLIGHT_PREFIX + key, null, ttl);
        return Boolean.TRUE.equals(result);
    }

    @Override
    public void storeSuccess(String key, PaymentResponse response, Duration ttl) {
        redisTemplate.opsForValue().set(PREFIX + key, response, ttl);
        redisTemplate.delete(INFLIGHT_PREFIX + key);
    }

    @Override
    public void clearInFlight(String key) {
        redisTemplate.delete(INFLIGHT_PREFIX + key);
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
        retryFor = {RestClientException.class, ResourceAccessException.class},
        noRetryFor = {UnauthorizedException.class},
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

        // Alert on-call team for high-value transactions
        if (request.getAmountCents().compareTo(BigDecimal.valueOf(100_000_00)) > 0) {
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

        // Store in ops dashboard for manual triage
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
     * Do NOT reverse: CircuitBreaker(Retry(call)) would retry
     * before the CB sees the failure, inflating CB failure counts.
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
public class RetryBudget {

    private final AtomicLong totalCalls = new AtomicLong(0);
    private final AtomicLong retryCalls = new AtomicLong(0);
    private static final double MAX_RETRY_RATIO = 0.10; // 10%

    public boolean tryAcquire() {
        totalCalls.incrementAndGet();
        long total = totalCalls.get();
        long retries = retryCalls.get();

        // Allow first retries freely (need minimum sample size)
        if (total < 100) return true;

        double currentRatio = (double) retries / total;
        if (currentRatio >= MAX_RETRY_RATIO) {
            log.warn("Retry budget exhausted: retryRatio={:.2f}% limit={}%",
                currentRatio * 100, MAX_RETRY_RATIO * 100);
            return false;
        }

        retryCalls.incrementAndGet();
        return true;
    }

    public void reset() {
        // Reset counters periodically (e.g., every minute)
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
        // Built-in Resilience4j metrics
        TaggedRetryMetrics.ofRetryRegistry(
            RetryRegistry.of(retry.getRetryConfig())
        ).bindTo(meterRegistry);

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
          - feign.FeignException.ServiceUnavailable
        ignore-exceptions:
          - com.fintech.payments.exception.InsufficientFundsException
          - com.fintech.payments.exception.DuplicateTransactionException
      payment-gateway:
        max-attempts: 4
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2.5
        exponential-max-wait-duration: 60s
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
@Component
public class RetryAfterRespectingIntervalFunction implements IntervalFunction {

    private final ThreadLocal<Long> retryAfterMs = new ThreadLocal<>();

    public void setRetryAfter(long milliseconds) {
        retryAfterMs.set(milliseconds);
    }

    @Override
    public long apply(int attempt) {
        Long explicit = retryAfterMs.get();
        if (explicit != null) {
            retryAfterMs.remove();
            return explicit;
        }
        // Fall back to exponential backoff
        return Math.min(500L * (long) Math.pow(2, attempt - 1), 30_000L);
    }
}
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
    {"id": "1", "description": "Implement a PaymentRetryClassifier that correctly identifies retriable vs non-retriable exceptions, handling 429 with Retry-After header respect, and ensure non-idempotent POST calls are only retried with a valid idempotency key."},
    {"id": "2", "description": "Configure Resilience4j with full-jitter exponential backoff (base 500ms, multiplier 2, cap 30s, max 4 attempts) and integrate it with a CircuitBreaker using Retry(CircuitBreaker(call)) ordering."},
    {"id": "3", "description": "Build a Redis-backed IdempotencyKeyStore that prevents concurrent duplicate submissions using setIfAbsent, stores successful responses for 24h deduplication, and clears in-flight markers on failure."},
    {"id": "4", "description": "Implement a PaymentDeadLetterHandler that publishes exhausted payments to a Kafka DLQ topic, triggers PagerDuty alerts for transactions over $100,000, and exposes a retry budget gauge in Prometheus."}
  ]
}
-->

