---
id: track-04-lesson-13
title: "Async Patterns — Scatter-Gather, Fan-Out, Pipeline"
slug: async-patterns
track: track-04
trackName: "Async & Reactive Systems"
sequence: 13
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [scatter-gather, fan-out, pipeline, async-patterns, parallel]
prerequisites: []
---

# Async Patterns — Scatter-Gather, Fan-Out, Pipeline

> [!NOTE]
> A payment authorization decision that takes 800ms is commercially unacceptable. If you run fraud check, balance check, and compliance check sequentially, you pay the latency of each. If you run them in parallel and combine results, you pay only the latency of the slowest. Reactive async patterns — scatter-gather, fan-out/fan-in, and pipeline — are what make sub-100ms payment authorization possible at scale.

## Why Async Composition Matters in Fintech

Consider a typical payment authorization flow:

```
Sequential (BAD):
  Fraud check:       180ms
  Balance check:      40ms
  Compliance check:   90ms
  Velocity check:     60ms
  Total:             370ms

Parallel with scatter-gather (GOOD):
  All four checks run concurrently
  Wait for slowest:  180ms
  Total:             180ms + aggregation overhead (~2ms)

Improvement: 2x faster, same correctness guarantees.
```

The improvement compounds under load: at high concurrency, sequential processing creates thread starvation. Reactive parallel patterns handle the same load with far fewer threads.

---

## Project Reactor Fundamentals for These Patterns

Before the patterns, the building blocks:

```java
// build.gradle
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-webflux'
    implementation 'io.projectreactor:reactor-core:3.6.0'
    implementation 'io.projectreactor.addons:reactor-extra:3.5.1'
}
```

```java
// Key operators used in this lesson:
//
// Mono.zip()        — combine N Monos, emit when ALL complete (scatter-gather)
// Flux.merge()      — merge N Flux/Mono streams, emit as each arrives (fan-out)
// Flux.zip()        — combine N Fluxes element-by-element
// Mono.timeout()    — fail if Mono does not complete within duration
// onErrorReturn()   — provide fallback value on error
// flatMap()         — async map (creates inner publisher per element)
// concatMap()       — sequential async map (preserves order)
// publishOn()       — shift execution to a different scheduler
// subscribeOn()     — shift subscription to a different scheduler
```

---

## Pattern 1: Scatter-Gather for Parallel Payment Validation

Scatter-gather broadcasts a request to multiple services and waits for all responses before aggregating.

### Payment Authorization Scatter-Gather

```java
package com.fintech.payment.authorization;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.util.function.Tuple4;

import java.time.Duration;

/**
 * Scatter-gather payment authorization.
 *
 * All four checks run simultaneously. The authorization decision
 * is made only when ALL checks have returned (or timed out).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentAuthorizationService {

    private final FraudCheckClient     fraudCheckClient;
    private final BalanceCheckClient   balanceCheckClient;
    private final ComplianceClient     complianceClient;
    private final VelocityCheckClient  velocityCheckClient;

    private static final Duration CHECK_TIMEOUT = Duration.ofMillis(500);

    /**
     * Authorize a payment by running all checks in parallel.
     * Total latency = max(individual check latencies) + aggregation overhead.
     */
    public Mono<AuthorizationResult> authorize(PaymentRequest request) {
        long startMs = System.currentTimeMillis();

        // SCATTER: dispatch all checks simultaneously
        Mono<FraudCheckResult>    fraudCheck = fraudCheckClient
            .check(request)
            .timeout(CHECK_TIMEOUT)
            .onErrorReturn(FraudCheckResult.defaultAllow()) // fail open for availability
            .doOnSubscribe(s -> log.debug("Starting fraud check: paymentId={}", request.getId()));

        Mono<BalanceCheckResult>  balanceCheck = balanceCheckClient
            .check(request)
            .timeout(CHECK_TIMEOUT)
            .onErrorMap(t -> new AuthorizationException("Balance check failed", t))
            // Balance check: fail closed — cannot allow if we can't verify funds
            .doOnSubscribe(s -> log.debug("Starting balance check: paymentId={}", request.getId()));

        Mono<ComplianceResult>    complianceCheck = complianceClient
            .screen(request)
            .timeout(CHECK_TIMEOUT)
            .onErrorReturn(ComplianceResult.pendingReview()) // escalate on timeout
            .doOnSubscribe(s -> log.debug("Starting compliance check: paymentId={}", request.getId()));

        Mono<VelocityCheckResult> velocityCheck = velocityCheckClient
            .check(request)
            .timeout(CHECK_TIMEOUT)
            .onErrorReturn(VelocityCheckResult.defaultAllow())
            .doOnSubscribe(s -> log.debug("Starting velocity check: paymentId={}", request.getId()));

        // GATHER: wait for all results, then aggregate
        return Mono.zip(fraudCheck, balanceCheck, complianceCheck, velocityCheck)
            .map(tuple -> aggregateResults(request, tuple, startMs))
            .doOnSuccess(result -> log.info(
                "Authorization complete: paymentId={} decision={} durationMs={}",
                request.getId(), result.getDecision(),
                System.currentTimeMillis() - startMs));
    }

    private AuthorizationResult aggregateResults(
            PaymentRequest request,
            Tuple4<FraudCheckResult, BalanceCheckResult, ComplianceResult, VelocityCheckResult> results,
            long startMs) {

        FraudCheckResult    fraud      = results.getT1();
        BalanceCheckResult  balance    = results.getT2();
        ComplianceResult    compliance = results.getT3();
        VelocityCheckResult velocity   = results.getT4();

        // All checks must pass for authorization
        if (fraud.isBlocked()) {
            return AuthorizationResult.declined("FRAUD_RISK", fraud.getRiskScore());
        }
        if (!balance.hasSufficientFunds()) {
            return AuthorizationResult.declined("INSUFFICIENT_FUNDS", null);
        }
        if (compliance.requiresReview()) {
            return AuthorizationResult.pendingReview("COMPLIANCE_REVIEW");
        }
        if (velocity.isLimitExceeded()) {
            return AuthorizationResult.declined("VELOCITY_LIMIT", null);
        }

        return AuthorizationResult.approved(request.getAmount(), System.currentTimeMillis() - startMs);
    }
}
```

### Scatter-Gather with Partial Failure Tolerance

Sometimes you want to proceed even if some checks fail — with degraded confidence rather than hard failure.

```java
package com.fintech.payment.authorization;

import reactor.core.publisher.Mono;
import java.time.Duration;
import java.util.List;

/**
 * Scatter-gather with partial failure tolerance.
 * Useful for enrichment steps where some sources failing is acceptable.
 */
@Service
@RequiredArgsConstructor
public class PaymentEnrichmentService {

    private final GeoLocationClient    geoClient;
    private final DeviceFingerprintClient deviceClient;
    private final MerchantProfileClient   merchantClient;
    private final CustomerProfileClient   customerClient;

    public Mono<EnrichedPayment> enrich(PaymentRequest request) {
        // All enrichment sources — partial failure is acceptable
        Mono<GeoLocation>       geo      = geoClient.locate(request.getIpAddress())
            .timeout(Duration.ofMillis(100))
            .onErrorReturn(GeoLocation.unknown());

        Mono<DeviceFingerprint>  device   = deviceClient.fingerprint(request.getDeviceId())
            .timeout(Duration.ofMillis(150))
            .onErrorReturn(DeviceFingerprint.unknown());

        Mono<MerchantProfile>   merchant = merchantClient.getProfile(request.getMerchantId())
            .timeout(Duration.ofMillis(200))
            .onErrorReturn(MerchantProfile.defaultProfile());

        Mono<CustomerProfile>   customer = customerClient.getProfile(request.getCustomerId())
            .timeout(Duration.ofMillis(200))
            .onErrorReturn(CustomerProfile.defaultProfile());

        return Mono.zip(geo, device, merchant, customer)
            .map(t -> EnrichedPayment.builder()
                .payment(request)
                .geoLocation(t.getT1())
                .deviceFingerprint(t.getT2())
                .merchantProfile(t.getT3())
                .customerProfile(t.getT4())
                .build());
    }
}
```

---

## Pattern 2: Fan-Out / Fan-In

Fan-out distributes work across multiple workers; fan-in collects and merges results as they arrive. Unlike scatter-gather (which waits for ALL), fan-in can start processing results immediately as each arrives.

### Fan-Out for Batch Payment Processing

```java
package com.fintech.payment.batch;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.List;

/**
 * Fan-out batch payment processing.
 *
 * A batch of payments is fanned out to multiple parallel processing
 * pipelines and the results are fanned back in as they complete.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BatchPaymentProcessor {

    private final PaymentProcessingService paymentService;
    private final PaymentResultRepository  resultRepository;

    // Control parallelism — too high overwhelms downstream services
    private static final int CONCURRENCY = 10;

    /**
     * Process a batch of payments with controlled fan-out.
     * Results are emitted in completion order (not input order).
     *
     * Financial context: end-of-day batch processing, bulk payroll, ACH file processing.
     */
    public Flux<PaymentResult> processBatch(List<PaymentRequest> payments) {
        log.info("Starting batch processing: count={}", payments.size());
        long startMs = System.currentTimeMillis();

        return Flux.fromIterable(payments)
            // FAN-OUT: flatMap with concurrency limit
            // Each payment is processed on a separate subscription
            .flatMap(
                payment -> processPaymentAsync(payment),
                CONCURRENCY  // at most 10 concurrent
            )
            // FAN-IN: results arrive as they complete (not in order)
            .doOnNext(result -> log.debug("Payment completed: id={} status={}",
                result.getPaymentId(), result.getStatus()))
            .doOnComplete(() -> log.info("Batch complete: count={} durationMs={}",
                payments.size(), System.currentTimeMillis() - startMs))
            .doOnError(e -> log.error("Batch processing error after {}ms",
                System.currentTimeMillis() - startMs, e));
    }

    private Mono<PaymentResult> processPaymentAsync(PaymentRequest payment) {
        return Mono.fromCallable(() -> paymentService.process(payment))
            // Run blocking database operations on the bounded elastic scheduler
            .subscribeOn(Schedulers.boundedElastic())
            .onErrorResume(e -> {
                log.error("Payment failed: id={} error={}", payment.getId(), e.getMessage());
                return Mono.just(PaymentResult.failed(payment.getId(), e.getMessage()));
            });
    }

    /**
     * Fan-out with result aggregation — collect all results before returning.
     */
    public Mono<BatchResult> processBatchAndSummarize(List<PaymentRequest> payments) {
        return processBatch(payments)
            .collectList()
            .map(results -> {
                long successful = results.stream()
                    .filter(r -> r.getStatus() == PaymentStatus.COMPLETED).count();
                long failed = results.size() - successful;

                return BatchResult.builder()
                    .totalProcessed(results.size())
                    .successful(successful)
                    .failed(failed)
                    .results(results)
                    .build();
            });
    }
}
```

### Fan-Out to Multiple Notification Channels

```java
package com.fintech.notification;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Fan-out payment notification to multiple channels simultaneously.
 * All channels are notified concurrently; failure of one does not block others.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentNotificationService {

    private final EmailNotificationClient  emailClient;
    private final SmsNotificationClient    smsClient;
    private final PushNotificationClient   pushClient;
    private final WebhookNotificationClient webhookClient;
    private final AuditNotificationClient  auditClient;

    /**
     * Fan-out payment event to all notification channels.
     * Uses Flux.merge() so each channel's response arrives as it completes.
     */
    public Mono<NotificationSummary> notifyAll(PaymentEvent event) {

        // Fan out — all fire simultaneously
        Mono<NotificationResult> emailResult = emailClient
            .send(event.toEmailNotification())
            .onErrorReturn(NotificationResult.failed("email"))
            .doOnSuccess(r -> log.debug("Email notification sent: paymentId={}", event.getPaymentId()));

        Mono<NotificationResult> smsResult = smsClient
            .send(event.toSmsNotification())
            .onErrorReturn(NotificationResult.failed("sms"));

        Mono<NotificationResult> pushResult = pushClient
            .send(event.toPushNotification())
            .onErrorReturn(NotificationResult.failed("push"));

        Mono<NotificationResult> webhookResult = webhookClient
            .send(event.toWebhookPayload())
            .onErrorReturn(NotificationResult.failed("webhook"));

        // Audit is mandatory — do NOT swallow errors here
        Mono<NotificationResult> auditResult = auditClient
            .record(event.toAuditRecord());

        // Merge all into a single Flux — results arrive as each completes
        return Flux.merge(emailResult, smsResult, pushResult, webhookResult, auditResult)
            .collectList()
            .map(results -> NotificationSummary.builder()
                .paymentId(event.getPaymentId())
                .results(results)
                .successCount((int) results.stream().filter(NotificationResult::isSuccess).count())
                .build());
    }
}
```

---

## Pattern 3: Pipeline — Stage-by-Stage Processing

The pipeline pattern chains processing stages where each stage transforms the data before passing it to the next. Each stage can run on a different thread pool, allowing CPU-bound and I/O-bound stages to coexist efficiently.

### Three-Stage Payment Processing Pipeline

```java
package com.fintech.payment.pipeline;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Payment processing pipeline:
 *   Stage 1: Validation    — validate fields, schema, amounts
 *   Stage 2: Enrichment    — add account details, merchant data, risk context
 *   Stage 3: Processing    — debit/credit accounts, persist, audit
 *
 * Each stage can be scaled independently and can fail independently.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentProcessingPipeline {

    private final PaymentValidationStage  validationStage;
    private final PaymentEnrichmentStage  enrichmentStage;
    private final PaymentExecutionStage   executionStage;

    /**
     * Process a single payment through the three-stage pipeline.
     */
    public Mono<PaymentResult> process(PaymentRequest request) {
        return Mono.just(request)
            // Stage 1: Validation (CPU-bound, fast — keep on event loop)
            .flatMap(validationStage::validate)
            .doOnNext(v -> log.debug("Stage 1 complete: validation passed paymentId={}", v.getPaymentId()))

            // Stage 2: Enrichment (I/O-bound — shift to boundedElastic)
            .publishOn(Schedulers.boundedElastic())
            .flatMap(enrichmentStage::enrich)
            .doOnNext(e -> log.debug("Stage 2 complete: enrichment done paymentId={}", e.getPaymentId()))

            // Stage 3: Execution (I/O-bound DB writes — stay on boundedElastic)
            .flatMap(executionStage::execute)
            .doOnSuccess(r -> log.info("Pipeline complete: paymentId={} status={}",
                r.getPaymentId(), r.getStatus()))

            // If any stage fails, the pipeline short-circuits here
            .doOnError(e -> log.error("Pipeline failed: paymentId={}", request.getId(), e));
    }

    /**
     * Process a stream of payments through the pipeline with backpressure.
     * Used for real-time payment stream processing (Kafka consumer).
     */
    public Flux<PaymentResult> processStream(Flux<PaymentRequest> paymentStream) {
        return paymentStream
            // Stage 1: Validate — fast, in-process, no I/O
            .flatMap(
                validationStage::validate,
                100  // up to 100 concurrent validations
            )
            // Stage 2: Enrich — I/O bound, controlled concurrency
            .publishOn(Schedulers.boundedElastic())
            .flatMap(
                enrichmentStage::enrich,
                20   // limit to 20 concurrent enrichment calls
            )
            // Stage 3: Execute — database writes, most limited
            .flatMap(
                executionStage::execute,
                10   // limit to 10 concurrent DB writes
            )
            // Track throughput
            .doOnNext(result -> PaymentMetrics.recordProcessed(result))
            .onErrorContinue((error, item) -> {
                log.error("Pipeline error for item={}: {}", item, error.getMessage());
                PaymentMetrics.recordFailed(item);
            });
    }
}
```

### Stage Implementations

```java
package com.fintech.payment.pipeline;

import reactor.core.publisher.Mono;

@Component
@RequiredArgsConstructor
public class PaymentValidationStage {

    private final PaymentValidator validator;

    public Mono<ValidatedPayment> validate(PaymentRequest request) {
        return Mono.fromCallable(() -> {
            // Validate required fields
            if (request.getAmount() == null || request.getAmount().signum() <= 0) {
                throw new ValidationException("Amount must be positive: " + request.getAmount());
            }
            if (request.getCurrency() == null || request.getCurrency().length() != 3) {
                throw new ValidationException("Invalid currency code: " + request.getCurrency());
            }
            if (request.getSourceAccountId() == null) {
                throw new ValidationException("Source account ID is required");
            }
            if (request.getDestinationAccountId() == null) {
                throw new ValidationException("Destination account ID is required");
            }
            if (request.getSourceAccountId().equals(request.getDestinationAccountId())) {
                throw new ValidationException("Source and destination accounts cannot be the same");
            }

            return ValidatedPayment.from(request);
        });
        // No subscribeOn — this is CPU-bound and fast, stays on current thread
    }
}

@Component
@RequiredArgsConstructor
public class PaymentEnrichmentStage {

    private final AccountService   accountService;
    private final ExchangeRateService fxService;
    private final RiskContextService  riskService;

    public Mono<EnrichedPayment> enrich(ValidatedPayment validated) {
        // Parallel enrichment within the enrichment stage
        Mono<Account> sourceAccount = accountService.getAccount(validated.getSourceAccountId())
            .timeout(Duration.ofMillis(200));

        Mono<Account> destAccount = accountService.getAccount(validated.getDestinationAccountId())
            .timeout(Duration.ofMillis(200));

        Mono<ExchangeRate> fxRate = fxService.getRate(validated.getCurrency(), "USD")
            .timeout(Duration.ofMillis(100))
            .onErrorReturn(ExchangeRate.par(validated.getCurrency()));

        Mono<RiskContext> riskContext = riskService.getContext(validated.getCustomerId())
            .timeout(Duration.ofMillis(150))
            .onErrorReturn(RiskContext.defaultContext());

        return Mono.zip(sourceAccount, destAccount, fxRate, riskContext)
            .map(t -> EnrichedPayment.builder()
                .validated(validated)
                .sourceAccount(t.getT1())
                .destinationAccount(t.getT2())
                .fxRate(t.getT3())
                .riskContext(t.getT4())
                .build());
    }
}

@Component
@RequiredArgsConstructor
public class PaymentExecutionStage {

    private final AccountLedgerService ledgerService;
    private final PaymentRepository    paymentRepository;
    private final AuditService         auditService;

    public Mono<PaymentResult> execute(EnrichedPayment enriched) {
        return Mono.fromCallable(() -> {
            // Execute within a database transaction
            return ledgerService.executeTransfer(
                enriched.getSourceAccount(),
                enriched.getDestinationAccount(),
                enriched.getValidated().getAmount(),
                enriched.getValidated().getCurrency()
            );
        })
        .subscribeOn(Schedulers.boundedElastic()) // DB operations on IO scheduler
        .flatMap(ledgerResult -> {
            Payment payment = paymentRepository.save(
                Payment.fromEnriched(enriched, ledgerResult));
            return auditService.recordAsync(payment)
                .thenReturn(PaymentResult.success(payment));
        });
    }
}
```

---

## Pattern 4: Timeout with Fallback

In financial systems, a slow check is often worse than a fast default. Use `Mono.timeout()` with `onErrorReturn()` or `onErrorResume()` to implement fail-fast with fallback.

```java
package com.fintech.payment.authorization;

import reactor.core.publisher.Mono;
import java.time.Duration;

@Slf4j
@Service
@RequiredArgsConstructor
public class FraudCheckServiceWithFallback {

    private final FraudMLModelClient  mlClient;
    private final FraudRuleClient     rulesClient;
    private final FraudCacheService   cacheService;

    /**
     * Multi-tier fraud check with timeout and fallback.
     *
     * Tier 1: Real-time ML model (expensive, 150ms timeout)
     * Tier 2: Rule-based check (fast, 50ms timeout)
     * Tier 3: Cached risk score (instant, stale but better than blocking)
     */
    public Mono<FraudCheckResult> check(PaymentRequest request) {
        return mlClient.score(request)
            .timeout(Duration.ofMillis(150))
            .onErrorResume(e -> {
                if (e instanceof java.util.concurrent.TimeoutException) {
                    log.warn("ML fraud check timed out for paymentId={} — falling back to rules",
                        request.getId());
                } else {
                    log.error("ML fraud check failed for paymentId={} — falling back to rules",
                        request.getId(), e);
                }
                return ruleBasedFallback(request);
            })
            .doOnSuccess(result -> log.debug("Fraud check: paymentId={} score={} decision={}",
                request.getId(), result.getScore(), result.getDecision()));
    }

    private Mono<FraudCheckResult> ruleBasedFallback(PaymentRequest request) {
        return rulesClient.evaluate(request)
            .timeout(Duration.ofMillis(50))
            .onErrorResume(e -> {
                log.warn("Rules check also failed for paymentId={} — using cached score", request.getId());
                return cachedScoreFallback(request);
            });
    }

    private Mono<FraudCheckResult> cachedScoreFallback(PaymentRequest request) {
        return cacheService.getCachedScore(request.getCustomerId())
            .defaultIfEmpty(FraudCheckResult.defaultAllow()) // Ultimate fallback
            .map(cached -> {
                log.warn("Using cached fraud score: paymentId={} customerId={} cachedScore={}",
                    request.getId(), request.getCustomerId(), cached.getScore());
                return cached;
            });
    }
}
```

---

## Pattern 5: Async Aggregation

Aggregation collects multiple async results and computes derived values — for example, aggregating balance across multiple accounts or summing exposure across positions.

```java
package com.fintech.portfolio;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.math.BigDecimal;
import java.util.List;

/**
 * Aggregate portfolio metrics from multiple position services.
 * Each position service owns a subset of instruments.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PortfolioAggregationService {

    private final List<PositionService> positionServices; // injected list of all shards
    private final FxService             fxService;

    /**
     * Calculate total portfolio value in USD by aggregating positions
     * from multiple shard services, converting all to USD using live FX rates.
     */
    public Mono<PortfolioValue> calculateTotalValue(String portfolioId) {
        // Fan out to all shard services simultaneously
        return Flux.fromIterable(positionServices)
            .flatMap(svc -> svc.getPositions(portfolioId)
                .onErrorReturn(List.of()) // empty list if shard is down
            )
            // Flatten the list-of-lists into individual positions
            .flatMap(Flux::fromIterable)
            // For each position, get the current price (parallel I/O)
            .flatMap(
                position -> fxService.convert(position.getValue(), position.getCurrency(), "USD")
                    .map(usdValue -> position.withUsdValue(usdValue))
                    .onErrorReturn(position.withUsdValue(BigDecimal.ZERO)),
                50 // up to 50 concurrent FX conversions
            )
            // Aggregate: sum all USD values
            .collectList()
            .map(positions -> {
                BigDecimal totalValue = positions.stream()
                    .map(Position::getUsdValue)
                    .reduce(BigDecimal.ZERO, BigDecimal::add);

                long positionCount = positions.size();
                long missingPrices = positions.stream()
                    .filter(p -> p.getUsdValue().compareTo(BigDecimal.ZERO) == 0)
                    .count();

                return PortfolioValue.builder()
                    .portfolioId(portfolioId)
                    .totalUsdValue(totalValue)
                    .positionCount(positionCount)
                    .missingPriceCount(missingPrices)
                    .calculatedAt(java.time.Instant.now())
                    .build();
            });
    }
}
```

---

## Error Handling in Fan-Out

Error handling in fan-out is more nuanced than in sequential code because errors from one branch can terminate the whole fan-out.

```java
package com.fintech.payment.authorization;

import reactor.core.publisher.Mono;
import java.time.Duration;

/**
 * Error handling strategies for payment fan-out.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class RobustPaymentAuthorization {

    // Strategy 1: Fail closed — if ANY check fails, decline the payment
    public Mono<AuthorizationResult> authorizeFailClosed(PaymentRequest request) {
        Mono<FraudCheckResult>   fraud   = fraudClient.check(request).timeout(Duration.ofMillis(300));
        Mono<BalanceCheckResult> balance = balanceClient.check(request).timeout(Duration.ofMillis(200));

        return Mono.zip(fraud, balance)
            // Mono.zip propagates the FIRST error from any source
            // If fraud or balance check fails, the whole Mono fails
            .map(t -> aggregate(t.getT1(), t.getT2()))
            .onErrorMap(e -> new AuthorizationException("Authorization system error", e));
    }

    // Strategy 2: Fail open — if non-critical check fails, use default and continue
    public Mono<AuthorizationResult> authorizeFailOpen(PaymentRequest request) {
        Mono<FraudCheckResult> fraud = fraudClient.check(request)
            .timeout(Duration.ofMillis(300))
            .onErrorReturn(FraudCheckResult.defaultAllow()); // fail OPEN

        Mono<BalanceCheckResult> balance = balanceClient.check(request)
            .timeout(Duration.ofMillis(200));
            // NO onErrorReturn — balance check MUST succeed (fail CLOSED)

        Mono<ComplianceResult> compliance = complianceClient.screen(request)
            .timeout(Duration.ofMillis(400))
            .onErrorReturn(ComplianceResult.pendingReview()); // escalate

        return Mono.zip(fraud, balance, compliance)
            .map(t -> aggregateWithCompliance(t.getT1(), t.getT2(), t.getT3()));
    }

    // Strategy 3: Collect errors — report all failures, not just the first
    public Mono<AuthorizationResult> authorizeCollectErrors(PaymentRequest request) {
        Mono<CheckResult<FraudCheckResult>> fraud = fraudClient.check(request)
            .map(CheckResult::success)
            .onErrorReturn(CheckResult.failure("fraud"));

        Mono<CheckResult<BalanceCheckResult>> balance = balanceClient.check(request)
            .map(CheckResult::success)
            .onErrorReturn(CheckResult.failure("balance"));

        return Mono.zip(fraud, balance)
            .map(t -> {
                var errors = new java.util.ArrayList<String>();
                if (t.getT1().isFailed()) errors.add("fraud-check-unavailable");
                if (t.getT2().isFailed()) errors.add("balance-check-unavailable");

                if (!errors.isEmpty()) {
                    return AuthorizationResult.serviceUnavailable(errors);
                }

                return aggregate(t.getT1().getValue(), t.getT2().getValue());
            });
    }

    private AuthorizationResult aggregate(FraudCheckResult fraud, BalanceCheckResult balance) {
        if (fraud.isBlocked()) return AuthorizationResult.declined("FRAUD_RISK", fraud.getRiskScore());
        if (!balance.hasSufficientFunds()) return AuthorizationResult.declined("INSUFFICIENT_FUNDS", null);
        return AuthorizationResult.approved(null, 0);
    }

    private AuthorizationResult aggregateWithCompliance(
            FraudCheckResult fraud, BalanceCheckResult balance, ComplianceResult compliance) {
        if (fraud.isBlocked()) return AuthorizationResult.declined("FRAUD_RISK", fraud.getRiskScore());
        if (!balance.hasSufficientFunds()) return AuthorizationResult.declined("INSUFFICIENT_FUNDS", null);
        if (compliance.requiresReview()) return AuthorizationResult.pendingReview("COMPLIANCE_REVIEW");
        return AuthorizationResult.approved(null, 0);
    }
}
```

---

## Real Fintech Example: Complete Payment Processor

Putting it all together — a complete payment authorization that uses scatter-gather, fan-out, pipeline, timeout-with-fallback, and async aggregation.

```java
package com.fintech.payment;

import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;

/**
 * Production payment processor combining all async patterns.
 *
 * Flow:
 *   1. Pipeline Stage 1: Validate (fast, synchronous-style)
 *   2. Pipeline Stage 2: Scatter-gather authorization (fraud + balance + compliance in parallel)
 *   3. Pipeline Stage 3: Enrich with account details and FX rates (parallel)
 *   4. Pipeline Stage 4: Execute (database writes, async)
 *   5. Fan-out: Notify all channels asynchronously (non-blocking)
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductionPaymentProcessor {

    private final PaymentValidationStage     validation;
    private final PaymentAuthorizationService authorization;
    private final PaymentEnrichmentService   enrichment;
    private final PaymentExecutionStage      execution;
    private final PaymentNotificationService notification;

    public Mono<PaymentResponse> process(PaymentRequest request) {
        long startMs = System.currentTimeMillis();

        return Mono.just(request)
            // Stage 1: Validation — fast, stay on event loop
            .flatMap(validation::validate)

            // Stage 2: Scatter-gather authorization
            // All checks run in parallel; total time = max(check latencies)
            .flatMap(validated -> authorization.authorize(validated.toPaymentRequest())
                .map(authResult -> {
                    if (authResult.isDeclined()) {
                        throw new PaymentDeclinedException(authResult.getDeclineReason());
                    }
                    return validated;
                })
            )

            // Stage 3: Parallel enrichment
            .flatMap(validated -> enrichment.enrich(validated.toPaymentRequest()))

            // Stage 4: Execute
            .flatMap(execution::execute)

            // Stage 5: Fan-out notifications (fire and forget — do not block response)
            .flatMap(result -> {
                // Notify asynchronously — do not wait for notification delivery
                notification.notifyAll(PaymentEvent.from(result))
                    .subscribe(
                        summary -> log.debug("Notifications sent: paymentId={} successCount={}",
                            result.getPaymentId(), summary.getSuccessCount()),
                        error -> log.error("Notification error for paymentId={}", result.getPaymentId(), error)
                    );

                // Return the payment result immediately without waiting for notifications
                return Mono.just(PaymentResponse.from(result));
            })

            // Timing
            .doOnSuccess(response -> log.info(
                "Payment processed: paymentId={} durationMs={}",
                response.getPaymentId(), System.currentTimeMillis() - startMs))

            // Global error handler
            .onErrorMap(PaymentDeclinedException.class, e ->
                new PaymentProcessingException("Payment declined: " + e.getReason(), e))
            .onErrorMap(e -> !(e instanceof PaymentProcessingException),
                e -> new PaymentProcessingException("Payment processing failed", e));
    }
}
```

---

## Choosing Between Patterns

```
Scatter-gather (Mono.zip):
  Use when: ALL results are needed before proceeding
  Example:  Authorization — need fraud AND balance AND compliance to proceed
  Failure:  First failure propagates unless each has onErrorReturn

Fan-out/fan-in (Flux.merge + flatMap):
  Use when: Results can be processed as they arrive, order does not matter
  Example:  Batch processing, notifications, parallel data loading
  Failure:  onErrorContinue allows processing remaining items

Pipeline (flatMap chain):
  Use when: Processing has distinct stages with different resource requirements
  Example:  Validate → Enrich → Execute
  Failure:  Short-circuits at the failing stage

Timeout + fallback (timeout().onErrorReturn()):
  Use when: Slow dependency should not block the critical path
  Example:  Fraud ML model with rule-based fallback
  Trade-off: Fallback may be less accurate but always fast

Key numbers for fintech:
  Authorization timeout budget:    500ms total
  Per-check timeout:               150-300ms
  Notification timeout:            fire and forget (do not block)
  Batch concurrency:               10-50 concurrent (tune per downstream capacity)
```

---

## Key Takeaways for Senior Engineers

1. **Scatter-gather is the most important pattern for authorization** — running fraud, balance, and compliance checks sequentially is a performance anti-pattern. Use `Mono.zip()` to run them in parallel.

2. **Timeout is not optional** — every external call in a fan-out must have a `timeout()`. A single slow dependency should not cause the entire authorization to time out at the payment gateway's hard cutoff.

3. **Fail closed vs fail open is a business decision** — balance checks must fail closed (decline if unavailable). Fraud enrichment can often fail open with a default allow and manual review flag. Get explicit sign-off from risk and compliance.

4. **Fan-out notifications asynchronously** — the payment response should be returned as soon as the payment is recorded. Notifications (email, SMS, webhook) should fire asynchronously via subscribe without blocking the response path.

5. **Control concurrency in flatMap** — the second argument to `flatMap(fn, concurrency)` is critical for production safety. Without a concurrency limit, a 10,000-item batch will attempt 10,000 simultaneous database connections.

6. **Pipeline stages align naturally with thread pools** — validation is CPU-bound (event loop), enrichment is I/O-bound (boundedElastic), execution is DB-bound (boundedElastic). `publishOn()` lets you shift between pools at stage boundaries.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment authorization must run fraud check, balance check, and compliance check before making a decision. All three checks are independent. Which Reactor pattern is most appropriate and why?",
      "options": [
        "flatMap chain — run each check sequentially using flatMap for simplicity",
        "Mono.zip() — run all three checks in parallel, total time equals max(check latencies) rather than sum",
        "Flux.merge() — merge all three check results as they complete",
        "Mono.when() — wait for all three to complete without needing their results"
      ],
      "correct": 1,
      "explanation": "Mono.zip() runs all three checks in parallel and combines their results only when all complete. Total time equals the slowest check, not the sum. This is the scatter-gather pattern. Mono.when() is for fire-and-forget coordination. Flux.merge() is for fan-out when results arrive as a stream. flatMap chain would run them sequentially, tripling the latency."
    },
    {
      "text": "A fraud ML model check takes up to 300ms. The authorization timeout budget is 500ms total. The fallback rule-based check takes 50ms. How should the timeout-with-fallback pattern be structured?",
      "options": [
        "mlClient.score(request).timeout(Duration.ofMillis(500)) — use the full budget for ML",
        "mlClient.score(request).timeout(Duration.ofMillis(150)).onErrorResume(e -> ruleBasedFallback(request)) — use 150ms for ML, leaving 350ms for the fallback and remaining pipeline stages",
        "mlClient.score(request).onErrorReturn(FraudCheckResult.defaultAllow()) — skip timeout entirely",
        "Mono.firstWithValue(mlClient.score(request), ruleBasedFallback(request)) — race both and use whichever completes first"
      ],
      "correct": 1,
      "explanation": "The timeout for the ML call must be a fraction of the total budget, not the whole budget. Using 150ms for ML leaves time for the rule fallback (50ms) and remaining pipeline stages, ensuring the total stays within 500ms. Using the full 500ms budget on the first check leaves no room for fallback and pipeline completion. The pattern is: expensive check with tight timeout, then chain fallbacks via onErrorResume."
    },
    {
      "text": "In a fan-out batch processor using flatMap(fn, concurrency), what happens if you omit the concurrency parameter when processing a list of 10,000 payment requests?",
      "options": [
        "Reactor automatically limits concurrency to 256 by default",
        "All 10,000 subscriptions are created simultaneously, potentially opening 10,000 concurrent database connections or HTTP connections and overwhelming downstream systems",
        "The pipeline serialises automatically due to backpressure from the downstream",
        "Reactor queues the excess subscriptions with no issue because flatMap is backpressure-aware"
      ],
      "correct": 1,
      "explanation": "Without a concurrency limit, flatMap subscribes to all 10,000 inner publishers simultaneously. This can open 10,000 concurrent database connections, 10,000 HTTP connections, or trigger 10,000 concurrent lock acquisitions — overwhelming downstream capacity. Always specify the concurrency parameter (e.g., flatMap(fn, 20)) to match the downstream's capacity. The default unbounded concurrency is a production safety risk."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Production Payment Authorization with All Async Patterns",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a PaymentAuthorizationService using the scatter-gather pattern with Mono.zip(). Run fraud check (300ms budget), balance check (200ms budget), and compliance screening (400ms budget) in parallel. The fraud check must fail open (onErrorReturn defaultAllow) while the balance check must fail closed (let the error propagate). The compliance check must fail with pending-review status on timeout. Return a combined AuthorizationResult only when all three complete."},
    {"id": "2", "description": "Implement a three-stage payment processing pipeline: Stage 1 (validation, CPU-bound, stay on event loop), Stage 2 (enrichment, I/O-bound, publishOn boundedElastic, flatMap with concurrency 20), Stage 3 (execution, DB-bound, flatMap with concurrency 10). Each stage must have an individual timeout. The pipeline must short-circuit at the failing stage and emit a typed exception identifying which stage failed."},
    {"id": "3", "description": "Implement fan-out notification for completed payments using Flux.merge(). Notify email, SMS, push, and webhook channels concurrently. Each channel must have onErrorReturn so a single channel failure does not block others. The audit channel must NOT use onErrorReturn (audit failure must propagate). Return a NotificationSummary with success/failure counts. The payment response must be returned immediately without waiting for notification delivery."},
    {"id": "4", "description": "Write a StepVerifier test for the complete payment processor that: (a) verifies scatter-gather authorization completes within 350ms even when the fraud ML model always takes 290ms, (b) verifies that when the balance check times out, the entire authorization fails with a typed BalanceCheckUnavailableException, (c) verifies that when the ML fraud model fails, the rule-based fallback is invoked and the authorization proceeds successfully, (d) verifies fan-out notifications fire asynchronously and the payment response arrives before all notifications complete."}
  ]
}
-->
