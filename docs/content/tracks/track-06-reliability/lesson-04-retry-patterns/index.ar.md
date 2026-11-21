---
id: track-06-lesson-04
title: "أنماط إعادة المحاولة — التراجع الأسي والعشوائية (Jitter)"
slug: retry-patterns
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 4
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [retry, exponential-backoff, jitter, idempotency, Resilience4j]
prerequisites: []
---

# أنماط إعادة المحاولة — التراجع الأسّي والتشويش العشوائي (Jitter)

> [!NOTE]
> إعادة محاولة دفعة غير idempotent مرتين قد تخصم من العميل مرتين. فيجب أن يستند كل قرار إعادة محاولة في التقنية المالية إلى استراتيجية idempotency، لا إلى مجرد غلاف للراحة.

## 1. متى تعيد المحاولة ومتى لا

إعادات المحاولة سيف ذو حدين في الأنظمة المالية. فإذا نُفذت بشكل صحيح، تخفي الإخفاقات العابرة في البنية التحتية عن المستخدمين. وإذا نُفذت بشكل خاطئ، تخلق معاملات مكررة، وتضخّم الحمل على أنظمة متدهورة أصلًا، وتحجب إشارات السبب الجذري في منظومة المراقبة لديك.

### الأخطاء القابلة لإعادة المحاولة

| الحالة | HTTP / الرمز | لماذا قابلة لإعادة المحاولة |
|---|---|---|
| انتهاء مهلة الشبكة | `SocketTimeoutException` | انقطاع عابر في الاتصال |
| الخدمة غير متاحة | `503` | الخدمة اللاحقة محمّلة مؤقتًا |
| بلوغ حد المعدل | `429` | إشارة صريحة لإعادة المحاولة لاحقًا |
| ‏5xx على عملية idempotent | `500` على GET | خطأ عابر في جانب الخادم |
| Kafka غير متاح | `TimeoutException` | الوسيط غير قابل للوصول مؤقتًا |

> [!WARNING]
> **انتهاء مهلة القراءة** (أو 502/504) على استدعاء غير idempotent مثل POST لدفعة هو *نتيجة مجهولة*: فربما مرت الدفعة. فلا تعِد محاولته إلا **بمفتاح الـ idempotency نفسه**، ليتعرف المعالج على التكرار — أو استعلم حالة الدفعة أولًا. أما انتهاء مهلة *الاتصال* فمختلف: فالطلب لم يخرج أصلًا، فإعادة المحاولة آمنة.

### الأخطاء غير القابلة لإعادة المحاولة

| الحالة | HTTP / الرمز | لماذا غير قابلة لإعادة المحاولة |
|---|---|---|
| طلب سيئ | `400` | خطأ في العميل — إعادة المحاولة تعيد الخطأ نفسه |
| غير مخوّل | `401` | بيانات الاعتماد غير صالحة — إعادة المحاولة لن تصلحها |
| معاملة مكررة | `409 Conflict` | عولجت بالفعل |
| رصيد غير كافٍ | `422` | رفض بمنطق العمل |
| حساب مجمّد | `403` | تجميد امتثال |

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

## 2. التراجع الأسّي — الصيغة

إعادات المحاولة بتأخير ثابت ساذجة ومؤذية في الأنظمة المالية. فعندما يتعطل معالج مدفوعات، يخلق كل عميل يعيد المحاولة بفواصل ثابتة مدتها ثانية واحدة حركة "قطيع هائج" متزامنة — فيصطدم كل العملاء بالخدمة المتعافية في اللحظة نفسها.

صيغة التراجع الأسّي:

```
delay(attempt) = min(base * multiplier^attempt, maxDelay)
```

القيم النموذجية للأنظمة المالية:
- `base` = ‏100–500 مللي ثانية
- `multiplier` = ‏2.0
- `maxDelay` = ‏30–60 ثانية
- `maxAttempts` = ‏3–5

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

## 3. التشويش العشوائي — كسر القطيع الهائج

دون تشويش عشوائي، يعيد العملاء ذوو إعداد التراجع نفسه المحاولة في آن واحد. ويضيف التشويش عشوائية لتوزيع حمل إعادات المحاولة عبر الزمن.

### التشويش الكامل (Full Jitter)

```
delay = random(0, min(base * multiplier^attempt, maxDelay))
```

يوزع إعادات المحاولة بشكل منتظم عبر النافذة كلها. وهو الأنسب لسيناريوهات التنازع العالي مثل قفزات الدفع في الجمعة السوداء.

### التشويش المتساوي (Equal Jitter)

```
half = min(base * multiplier^attempt, maxDelay) / 2
delay = half + random(0, half)
```

يضمن حدًا أدنى للانتظار مع إضافة التشويش. وهو جيد لبوابات الدفع حيث تريد قدرًا مضمونًا من التراجع.

### التشويش غير المترابط (Decorrelated Jitter)

```
delay = min(maxDelay, random(base, previous_delay * 3))
```

ينتج التوزيع الأكثر انتشارًا. وهو الأنسب للأساطيل الكبيرة (أكثر من 100 نسخة خدمة).

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

## 4. إعادة المحاولة في Resilience4j — الإعداد الإنتاجي

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

## 5. مفاتيح الـ Idempotency — إعادة محاولة آمنة لاستدعاءات الدفع

إعادة المحاولة آمنة فقط إذا كانت العملية اللاحقة idempotent. ولعمليات POST (إرسال الدفعات)، يجب أن تستخدم مفتاح idempotency ليستطيع معالج المدفوعات كشف إعادات المحاولة وإزالة تكرارها.

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

## 6. ‏@Retryable في Spring — إعادات محاولة تصريحية

للسيناريوهات الأبسط، تعليق `@Retryable` في Spring Retry نظيف ومقروء. استخدمه لاستدعاءات الخدمات الداخلية، لا لاستدعاءات بوابة الدفع حيث تحتاج تحكمًا كاملًا.

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

## 7. طابور الرسائل الميتة بعد الحد الأقصى لإعادات المحاولة

عندما تُستنفد إعادات المحاولة، لا تبتلع الفشل بصمت. بل أرسله إلى طابور رسائل ميتة (DLQ) للمراجعة اليدوية وإعادة المعالجة المحتملة.

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

## 8. التكامل مع قاطع الدائرة

إعادات المحاولة دون قواطع دائرة قد تسبب عواصف إعادة محاولة. فعندما تكون الخدمة اللاحقة معطلة كليًا، تتراكم إعادات المحاولة وتستنفد مجمعات الخيوط والاتصالات.

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

## 9. ميزانيات إعادة المحاولة — منع تضخيم إعادات المحاولة

في سلسلة خدمات مصغرة (A ← B ← C)، إذا أعادت كل خدمة المحاولة 3 مرات، قد يتضخم طلب واحد إلى 27 استدعاءً لـ C. فاستخدم ميزانيات إعادة المحاولة لتحديد ذلك.

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

## 10. المقاييس والمراقبة لإعادات المحاولة

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

## 11. إعداد application.yml

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

## 12. نصائح إنتاجية للأنظمة المالية

**اربط إعادات المحاولة بمعرّفات الطلبات.** يجب أن تحمل كل محاولة للدفعة المنطقية نفسها معرّف الارتباط نفسه. وهذا أساسي للتتبع الموزع وسجلات التدقيق.

**سجّل سياق إعادة المحاولة بغنى.** سجّل مفتاح الـ idempotency، ورقم المحاولة، والتأخير المطبّق، وصنف الاستثناء (لا الرسالة فقط) في كل إعادة محاولة.

**نبّه على قفزات معدل إعادة المحاولة.** القفزة المفاجئة في معدل إعادة المحاولة (مثلًا من 0.5% إلى 8%) مؤشر مبكر على تدهور خدمة لاحقة. فنبّه قبل أن تصبح انقطاعًا.

**اختبر سلوك إعادة المحاولة في بيئة التجهيز.** استخدم Chaos Monkey أو Toxiproxy لحقن الإخفاقات والتحقق من:
- أن إعادات المحاولة تنطلق في الأوقات الصحيحة
- أن مفاتيح الـ idempotency تمنع الخصم المكرر
- أن طابور الرسائل الميتة يتلقى المدخلات بعد الاستنفاد
- أن قاطع الدائرة يفتح عندما يتجاوز معدل الفشل العتبة

**احترم ترويسات Retry-After.** عندما تعيد معالجات الدفع `429 Too Many Requests` مع ترويسة `Retry-After: 5`، التزم بتلك القيمة بدل التراجع المحسوب لديك. فتجاهلها يسبب مزيدًا من تحديد المعدل.

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

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "أي رمز حالة HTTP يجب أن يطلق إعادة محاولة في خدمة دفع؟",
      "options": ["400 Bad Request", "401 Unauthorized", "503 Service Unavailable", "422 Unprocessable Entity"],
      "correct": 2,
      "explanation": "الرد 503 Service Unavailable يدل على حالة حمل زائد عابرة قد تُحل بإعادة المحاولة. أما 400 و401 و422 فأخطاء عميل أو عمل حتمية ستعيد النتيجة نفسها عند إعادة المحاولة."
    },
    {
      "text": "ما الغرض الأساسي من إضافة التشويش العشوائي إلى التراجع الأسّي؟",
      "options": ["تقليل العدد الإجمالي لمحاولات إعادة المحاولة", "منع عواصف إعادة المحاولة المتزامنة (القطيع الهائج) عبر عدة عملاء", "زيادة الحد الأقصى لتأخير إعادة المحاولة", "جعل مفاتيح الـ idempotency فريدة"],
      "correct": 1,
      "explanation": "يضيف التشويش العشوائي عشوائية إلى تأخير إعادة المحاولة فلا يعيد العملاء الذين فشلوا في الوقت نفسه المحاولة كلهم في آن واحد، ما كان سيخلق قطيعًا هائجًا يُغرق الخدمة المتعافية مجددًا."
    },
    {
      "text": "في سلسلة خدمات مصغرة A ← B ← C حيث تعيد كل خدمة المحاولة 3 مرات عند الفشل، ما الحد الأقصى لعدد الاستدعاءات التي قد تصل إلى الخدمة C من طلب واحد إلى A؟",
      "options": ["3", "9", "27", "81"],
      "correct": 2,
      "explanation": "كل إعادة محاولة في كل طبقة تتضاعف: تعيد A المحاولة 3 مرات، كل منها يطلق B التي تعيد المحاولة 3 مرات، كل منها يطلق C — فينتج 3 × 3 × 3 = 27 استدعاءً لـ C. وهذا تضخيم إعادة المحاولة، وتخففه ميزانيات إعادة المحاولة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "نظام إعادة محاولة دفع Idempotent مع طابور رسائل ميتة",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ PaymentRetryClassifier يحدد بشكل صحيح الاستثناءات القابلة لإعادة المحاولة وغير القابلة، ويتعامل مع 429 باحترام ترويسة Retry-After، ويضمن ألا تُعاد محاولة استدعاءات POST غير الـ idempotent إلا بمفتاح idempotency صالح."},
    {"id": "2", "description": "اضبط Resilience4j بتراجع أسّي مع تشويش كامل (أساس 500 مللي ثانية، ومضاعف 2، وسقف 30 ثانية، وحد أقصى 4 محاولات) وادمجه مع CircuitBreaker بترتيب Retry(CircuitBreaker(call))."},
    {"id": "3", "description": "ابنِ IdempotencyKeyStore مدعومًا بـ Redis يمنع الإرسال المكرر المتزامن باستخدام setIfAbsent بقيمة علامة صغيرة (لا يستطيع Redis تخزين null)، ويخزن الردود الناجحة 24 ساعة لإزالة التكرار، ويمسح علامات قيد التنفيذ عند الفشل — شارحًا لماذا يكون ذلك آمنًا فقط لأن المعالج يزيل التكرار بمفتاح الـ idempotency نفسه."},
    {"id": "4", "description": "نفّذ PaymentDeadLetterHandler ينشر المدفوعات المستنفدة إلى موضوع DLQ في Kafka، ويطلق تنبيهات PagerDuty للمعاملات التي تتجاوز 100,000 دولار، ويعرض مقياس gauge لميزانية إعادة المحاولة في Prometheus."}
  ]
}
-->
