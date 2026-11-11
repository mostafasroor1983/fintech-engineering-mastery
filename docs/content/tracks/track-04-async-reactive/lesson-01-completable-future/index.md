---
id: track-04-lesson-01
title: "CompletableFuture — Asynchronous Pipelines in Java"
slug: completable-future
track: track-04
trackName: Asynchronous & Reactive Systems Engineering
sequence: 1
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [CompletableFuture, async, java, thread-pool, pipeline]
prerequisites: []
---

# CompletableFuture — Asynchronous Pipelines in Java

> [!NOTE]
> `CompletableFuture` is Java's native mechanism for composing non-blocking asynchronous operations. In financial systems, it enables parallel service calls, non-blocking enrichment pipelines, and timeout-bounded external integrations.

## The Problem CompletableFuture Solves

A synchronous payment enrichment pipeline calls three services sequentially. If each call takes 50ms, the total latency is 150ms:

```
Request → FX Rate Service (50ms) → Fraud Score (50ms) → Account Lookup (50ms) → Response
```

These three calls are **independent** — none depends on the result of another. With `CompletableFuture`, they can execute in parallel, bringing latency down to ~50ms (the slowest single call):

```
                   ┌→ FX Rate Service (50ms) ─┐
Request ──────────→├→ Fraud Score     (50ms) ─┤──→ Combine → Response
                   └→ Account Lookup  (50ms) ─┘
```

---

## Core API — Building Async Pipelines

### Creating CompletableFutures

```java
// Java 17 — explicit ExecutorService for financial workloads
// Never use the default ForkJoinPool.commonPool() in production financial code
// (shared pool starvation risk under load)
ExecutorService paymentPool = Executors.newFixedThreadPool(
    Runtime.getRuntime().availableProcessors() * 2,
    new ThreadFactory() {
        private final AtomicInteger counter = new AtomicInteger();
        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "payment-async-" + counter.incrementAndGet());
            t.setDaemon(true);
            return t;
        }
    }
);

// Supply a value asynchronously
CompletableFuture<FxRate> fxFuture = CompletableFuture.supplyAsync(
    () -> fxService.getRate("GBP", "USD"),
    paymentPool
);

// Run a task with no return value
CompletableFuture<Void> auditFuture = CompletableFuture.runAsync(
    () -> auditLog.record(paymentId, AuditEvent.INITIATED),
    paymentPool
);
```

```java
// Java 21 — virtual threads for I/O-bound work
// Virtual threads eliminate the need to size thread pools manually for blocking I/O
ExecutorService virtualPool = Executors.newVirtualThreadPerTaskExecutor();

CompletableFuture<FxRate> fxFuture = CompletableFuture.supplyAsync(
    () -> fxService.getRate("GBP", "USD"),  // blocks a virtual thread cheaply
    virtualPool
);
```

### Transforming Results — thenApply, thenCompose

```java
// thenApply: transform the result synchronously (stays on same thread)
CompletableFuture<BigDecimal> convertedAmount = fxFuture
    .thenApply(rate -> paymentAmount.multiply(rate.getValue()));

// thenCompose: chain another async operation (flatMap equivalent)
// Use this when the next step itself returns a CompletableFuture
CompletableFuture<RiskAssessment> riskFuture = accountFuture
    .thenComposeAsync(
        account -> riskService.assessAsync(account, paymentAmount),
        paymentPool
    );
```

### Parallel Composition — allOf, anyOf

```java
// allOf: wait for ALL futures to complete
// Use for parallel enrichment where all data is needed
public CompletableFuture<EnrichedPayment> enrichPayment(Payment payment) {
    CompletableFuture<FxRate> fxFuture = CompletableFuture.supplyAsync(
        () -> fxService.getRate(payment.getCurrency(), "GBP"), paymentPool);
    
    CompletableFuture<FraudScore> fraudFuture = CompletableFuture.supplyAsync(
        () -> fraudService.score(payment), paymentPool);
    
    CompletableFuture<Account> accountFuture = CompletableFuture.supplyAsync(
        () -> accountService.get(payment.getAccountId()), paymentPool);

    return CompletableFuture.allOf(fxFuture, fraudFuture, accountFuture)
        .thenApply(ignored -> EnrichedPayment.builder()
            .payment(payment)
            .fxRate(fxFuture.join())         // join() is safe here — future is done
            .fraudScore(fraudFuture.join())
            .account(accountFuture.join())
            .build());
}
```

```java
// anyOf: complete when ANY future completes
// Use for redundant requests (ask two providers, use whoever responds first)
CompletableFuture<FxRate> primary = CompletableFuture.supplyAsync(
    () -> primaryFxProvider.getRate("GBP", "USD"), paymentPool);

CompletableFuture<FxRate> secondary = CompletableFuture.supplyAsync(
    () -> secondaryFxProvider.getRate("GBP", "USD"), paymentPool);

// Use whichever provider responds first
CompletableFuture<Object> fastest = CompletableFuture.anyOf(primary, secondary);
```

---

## Timeout Patterns — Critical for Financial Systems

> [!WARNING]
> **Never call a blocking external service without a timeout.** An unbounded wait on an FX provider or fraud service will exhaust your thread pool under load.

```java
// Java 9+ — orTimeout cancels and throws TimeoutException after deadline
CompletableFuture<FraudScore> fraudFuture = CompletableFuture
    .supplyAsync(() -> fraudService.score(payment), paymentPool)
    .orTimeout(200, TimeUnit.MILLISECONDS);  // hard timeout — exception thrown

// completeOnTimeout — provide a fallback value if deadline exceeded
// Use this when partial degradation is acceptable
CompletableFuture<FraudScore> fraudWithFallback = CompletableFuture
    .supplyAsync(() -> fraudService.score(payment), paymentPool)
    .completeOnTimeout(
        FraudScore.defaultAllow(),   // fallback: allow with default score
        200, TimeUnit.MILLISECONDS
    );
```

### Timeout Strategy by Financial Operation

| Operation | Timeout | On Timeout |
|---|---|---|
| Account balance read | 100ms | Reject — cannot authorise without balance |
| Fraud score | 200ms | Use cached score or allow with monitoring |
| FX rate | 150ms | Use last known rate + 50bps buffer |
| Sanctions screening | 500ms | Reject — regulatory requirement |
| Audit log write | 100ms | Log locally, async retry |

---

## Error Handling — exceptionally, handle, whenComplete

```java
// exceptionally: recover from failure with a fallback
CompletableFuture<FraudScore> resilientFraud = CompletableFuture
    .supplyAsync(() -> fraudService.score(payment), paymentPool)
    .orTimeout(200, TimeUnit.MILLISECONDS)
    .exceptionally(throwable -> {
        if (throwable instanceof TimeoutException) {
            metrics.increment("fraud.service.timeout");
            return FraudScore.defaultAllow();  // graceful degradation
        }
        // Unexpected error — re-throw to fail the pipeline
        throw new CompletionException("Fraud service unavailable", throwable);
    });

// handle: transform both success and failure (always called)
CompletableFuture<Either<PaymentError, FxRate>> safeRate = CompletableFuture
    .supplyAsync(() -> fxService.getRate("GBP", "USD"), paymentPool)
    .handle((rate, throwable) -> {
        if (throwable != null) {
            return Either.left(PaymentError.FX_UNAVAILABLE);
        }
        return Either.right(rate);
    });

// whenComplete: side effects (logging, metrics) without transforming result
CompletableFuture<FxRate> withMetrics = fxFuture
    .whenComplete((rate, throwable) -> {
        if (throwable != null) {
            metrics.increment("fx.service.error");
        } else {
            metrics.recordLatency("fx.service", latencyMs);
        }
    });
```

---

## Real-World Pattern — Payment Processing Pipeline

```java
// Java 17 version
public CompletableFuture<PaymentResult> processPayment(PaymentRequest request) {
    
    // Phase 1: parallel validation and enrichment
    CompletableFuture<Account> accountFuture = CompletableFuture
        .supplyAsync(() -> accountService.getWithBalance(request.getAccountId()), paymentPool)
        .orTimeout(100, TimeUnit.MILLISECONDS);

    CompletableFuture<FraudScore> fraudFuture = CompletableFuture
        .supplyAsync(() -> fraudService.score(request), paymentPool)
        .completeOnTimeout(FraudScore.defaultAllow(), 200, TimeUnit.MILLISECONDS);

    CompletableFuture<FxRate> fxFuture = request.requiresCurrencyConversion()
        ? CompletableFuture.supplyAsync(() -> fxService.getRate(
              request.getCurrency(), "GBP"), paymentPool)
              .orTimeout(150, TimeUnit.MILLISECONDS)
        : CompletableFuture.completedFuture(FxRate.one());

    // Phase 2: combine results and make authorisation decision
    return CompletableFuture.allOf(accountFuture, fraudFuture, fxFuture)
        .thenComposeAsync(ignored -> {
            Account account = accountFuture.join();
            FraudScore fraud = fraudFuture.join();
            FxRate rate = fxFuture.join();

            BigDecimal gbpAmount = request.getAmount().multiply(rate.getValue());

            if (account.getBalance().compareTo(gbpAmount) < 0) {
                return CompletableFuture.completedFuture(
                    PaymentResult.declined(request.getId(), DeclineReason.INSUFFICIENT_FUNDS));
            }
            if (fraud.getScore() > FRAUD_THRESHOLD) {
                return CompletableFuture.completedFuture(
                    PaymentResult.declined(request.getId(), DeclineReason.FRAUD_RISK));
            }

            // Phase 3: execute the payment (async, transactional)
            return CompletableFuture.supplyAsync(
                () -> ledgerService.debit(account, gbpAmount, request.getId()),
                paymentPool
            ).thenApply(debitResult ->
                PaymentResult.authorised(request.getId(), debitResult.getTransactionId())
            );
        }, paymentPool)
        .exceptionally(throwable -> {
            log.error("Payment processing failed for {}", request.getId(), throwable);
            metrics.increment("payment.processing.error");
            return PaymentResult.error(request.getId(), "Internal processing error");
        });
}
```

```java
// Java 21 version — virtual threads for I/O-bound calls
// The structure is identical; the executor difference handles the blocking I/O cheaply
public CompletableFuture<PaymentResult> processPayment(PaymentRequest request) {
    // Using virtual thread executor — no need to size thread pools for blocking I/O
    var executor = Executors.newVirtualThreadPerTaskExecutor();
    
    // ... same pipeline structure as Java 17 above ...
    // Virtual threads make each blocking call cheap without callback complexity
}
```

---

## Common Anti-Patterns in Financial Systems

> [!WARNING]
> These patterns are frequently observed in financial codebases and cause production incidents.

**Anti-pattern 1 — Blocking inside supplyAsync**

```java
// WRONG: calling .get() inside a CompletableFuture blocks the thread
// This defeats the purpose of async and can deadlock if using the common pool
CompletableFuture<BigDecimal> balance = CompletableFuture.supplyAsync(() -> {
    // This blocks the thread until accountFuture completes
    Account account = accountFuture.get();  // DEADLOCK RISK
    return account.getBalance();
});

// CORRECT: use thenCompose to chain
CompletableFuture<BigDecimal> balance = accountFuture
    .thenApply(Account::getBalance);
```

**Anti-pattern 2 — Ignoring the return value**

```java
// WRONG: fire-and-forget without handling failures
CompletableFuture.runAsync(() -> riskService.recordTransaction(txn), paymentPool);
// If riskService throws, the exception is silently swallowed

// CORRECT: attach error handler
CompletableFuture.runAsync(() -> riskService.recordTransaction(txn), paymentPool)
    .exceptionally(ex -> {
        log.error("Risk recording failed for {}", txn.getId(), ex);
        alertingService.notify(Alert.RISK_RECORDING_FAILURE, txn.getId());
        return null;
    });
```

**Anti-pattern 3 — Using ForkJoinPool.commonPool()**

```java
// WRONG: default pool is shared across the JVM — starves other callers under load
CompletableFuture.supplyAsync(() -> expensiveCall());  // uses commonPool

// CORRECT: always specify your pool
CompletableFuture.supplyAsync(() -> expensiveCall(), dedicatedPaymentPool);
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "You have three independent service calls: FX rate (avg 40ms), fraud score (avg 80ms), and account lookup (avg 50ms). Using CompletableFuture.allOf(), what is the expected latency improvement over sequential calls?",
      "options": [
        "No improvement — allOf still executes them sequentially",
        "From 170ms sequential to ~80ms parallel (limited by the slowest call)",
        "From 170ms sequential to ~57ms parallel (average of all three)",
        "From 170ms sequential to ~40ms parallel (fastest call wins)"
      ],
      "correct": 1,
      "explanation": "allOf runs all three concurrently and waits for the last to complete. The total latency approaches the slowest single call (~80ms for fraud score), not the sum. This is a 2x improvement in this case."
    },
    {
      "id": "q2",
      "text": "What is the difference between thenApply and thenCompose?",
      "options": [
        "thenApply is synchronous, thenCompose is asynchronous",
        "thenApply transforms a value (like map), thenCompose chains a function that returns a CompletableFuture (like flatMap)",
        "thenCompose is faster because it avoids thread switching",
        "They are identical — thenCompose is an alias for thenApply"
      ],
      "correct": 1,
      "explanation": "thenApply is equivalent to map — it transforms T to U synchronously. thenCompose is equivalent to flatMap — it takes a function T → CompletableFuture<U> and flattens it, avoiding nested CompletableFuture<CompletableFuture<U>>. Use thenCompose when the next step is itself async."
    },
    {
      "id": "q3",
      "text": "orTimeout() and completeOnTimeout() both handle deadline exceeded scenarios. When should you use each?",
      "options": [
        "orTimeout when you have a fallback, completeOnTimeout when you don't",
        "orTimeout throws TimeoutException (failing the pipeline), completeOnTimeout supplies a fallback value (continuing the pipeline)",
        "completeOnTimeout is more efficient because it avoids exception handling",
        "Use orTimeout for external services, completeOnTimeout for internal services"
      ],
      "correct": 1,
      "explanation": "orTimeout cancels the future and completes it exceptionally with TimeoutException. completeOnTimeout supplies a fallback value and completes normally if the timeout is hit. Use orTimeout when no degraded response is acceptable (e.g., balance check). Use completeOnTimeout when a default/cached response is acceptable (e.g., fraud score)."
    },
    {
      "id": "q4",
      "text": "Why should financial services never use ForkJoinPool.commonPool() as the default executor for CompletableFuture?",
      "options": [
        "The common pool is too slow for financial workloads",
        "The common pool is shared across the entire JVM — long-running financial tasks can starve other components (Hibernate, Jackson, etc.)",
        "The common pool cannot handle more than 100 concurrent tasks",
        "The common pool does not support timeouts"
      ],
      "correct": 1,
      "explanation": "ForkJoinPool.commonPool() is a JVM-wide resource shared by CompletableFuture, parallel streams, and other frameworks. A slow external call in a payment pipeline can fill the pool's queue, starving completely unrelated components. Always use a dedicated, properly named, monitored thread pool for financial workloads."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "CompletableFuture \u2014 Asynchronous Pipelines in Java \u2014 Production Implementation",
  "difficulty": "advanced",
  "estimatedMinutes": 85,
  "tasks": [
    {
      "id": "1",
      "description": "Write the enrichPayment method"
    },
    {
      "id": "2",
      "description": "Handle the error cases:"
    },
    {
      "id": "3",
      "description": "Add a Micrometer timer"
    },
    {
      "id": "4",
      "description": "Write a unit test"
    }
  ]
}
-->
