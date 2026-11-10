---
id: track-04-lesson-02
title: "Project Reactor — Mono and Flux Fundamentals"
slug: reactor-fundamentals
track: track-04
trackName: Async & Reactive Systems
sequence: 2
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [Reactor, Mono, Flux, reactive, publisher-subscriber]
prerequisites: []
---

# Project Reactor — Mono and Flux Fundamentals

> [!NOTE]
> Project Reactor is the reactive programming foundation for Spring's WebFlux stack. In financial systems, it enables non-blocking pipelines that process thousands of payment events per second without thread exhaustion. Understanding Mono and Flux at a deep level is a prerequisite for building production-grade reactive fintech services.

## Why Reactive in Financial Systems?

Traditional thread-per-request models break down at scale in financial platforms. Consider a payment processing service: each inbound payment triggers calls to a fraud engine, an FX rate service, an account validation service, and a ledger write. With synchronous blocking I/O on a 100-thread pool, throughput caps at roughly 100 concurrent in-flight payments — even if each external service responds in milliseconds.

Project Reactor's execution model is fundamentally different. A small number of event-loop threads (often equal to CPU cores) handle thousands of concurrent operations by never blocking. When a downstream call is in-flight, the thread is released back to serve other requests. When the response arrives, a thread picks up the continuation.

This architecture directly maps to core fintech requirements:

- High-volume payment ingestion (thousands of transactions per second)
- Low-latency enrichment pipelines (parallel fraud + FX + compliance checks)
- Efficient streaming of real-time settlement data to downstream consumers
- Back-pressure propagation from slow consumers (like batch ledger writers)

---

## The Publisher-Subscriber Contract

Reactor implements the [Reactive Streams](https://www.reactive-streams.org/) specification. The fundamental abstraction is a `Publisher` — a source that produces items — and a `Subscriber` — a consumer that processes them. Nothing happens until a subscriber subscribes. This is called **cold** behavior and is the default in Reactor.

```
Publisher ──subscribe()──> Subscriber
Subscriber ──request(n)──> Publisher
Publisher ──onNext(item)──> Subscriber  (n times)
Publisher ──onComplete()──> Subscriber  (or onError)
```

Reactor provides two core `Publisher` implementations:

| Type | Cardinality | Financial Use Case |
|------|-------------|-------------------|
| `Mono<T>` | 0 or 1 item | Single payment lookup, account balance fetch |
| `Flux<T>` | 0 to N items | Stream of transactions, batch settlement records |

---

## Mono — The Single-Value Publisher

`Mono<T>` represents an asynchronous computation that completes with zero or one value. It is the reactive equivalent of `CompletableFuture<Optional<T>>`.

### Creating a Mono

```java
import reactor.core.publisher.Mono;
import java.math.BigDecimal;
import java.time.Duration;

public class MonoCreationExamples {

    // Mono.just — wrap an already-available value
    public Mono<BigDecimal> getAccountBalance(String accountId) {
        BigDecimal balance = new BigDecimal("10000.00");
        return Mono.just(balance);
    }

    // Mono.fromCallable — defer a potentially throwing operation
    // Essential for wrapping blocking JDBC calls safely
    public Mono<Payment> findPaymentBlocking(String paymentId) {
        return Mono.fromCallable(() -> paymentRepository.findById(paymentId))
                   .subscribeOn(Schedulers.boundedElastic()); // offload blocking to dedicated pool
    }

    // Mono.fromSupplier — defer a non-throwing supplier
    public Mono<String> generateTransactionId() {
        return Mono.fromSupplier(() -> UUID.randomUUID().toString());
    }

    // Mono.defer — create a NEW publisher per subscription (critical for correctness)
    // Without defer, the same value is shared across all subscribers
    public Mono<Instant> currentTimestamp() {
        return Mono.defer(() -> Mono.just(Instant.now()));
    }

    // Mono.empty — signals completion with no value (payment cancelled before processing)
    public Mono<Void> cancelPayment(String paymentId) {
        return Mono.fromRunnable(() -> paymentRepository.cancel(paymentId))
                   .then(); // convert Mono<Object> to Mono<Void>
    }

    // Mono.error — immediately signal an error
    public Mono<Payment> validateAmount(BigDecimal amount) {
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            return Mono.error(
                new InvalidPaymentAmountException("Amount must be positive: " + amount));
        }
        return Mono.just(new Payment(amount));
    }
}
```

### Subscribing to a Mono

Subscription is what triggers execution. In production, subscription is handled by the framework (Spring WebFlux, Reactor Kafka), but understanding the mechanics is essential for debugging.

```java
public class MonoSubscribeExamples {

    public void basicSubscribePatterns(PaymentService paymentService) {

        // Minimal subscription — only care about success
        paymentService.findPayment("PAY-001")
            .subscribe(payment -> log.info("Found payment: {}", payment.getId()));

        // Full subscription with error handling
        paymentService.processPayment("PAY-002")
            .subscribe(
                result  -> log.info("Payment processed: {}", result),
                error   -> log.error("Payment failed: {}", error.getMessage()),
                ()      -> log.info("Payment stream complete")
            );

        // block — ONLY use in tests or main() startup, never in reactive pipeline code.
        // Blocking inside a reactive chain will deadlock Netty event-loop threads.
        Payment payment = paymentService.findPayment("PAY-003").block();

        // blockOptional — safe when upstream may be empty
        Optional<Payment> maybePayment = paymentService.findPayment("PAY-004")
            .blockOptional(Duration.ofSeconds(5));
    }
}
```

---

## Flux — The Multi-Value Publisher

`Flux<T>` is a reactive sequence of 0 to N items. It is the reactive equivalent of a `Stream<T>` or an `Iterable<T>`, but asynchronous, non-blocking, and with built-in back-pressure.

### Creating a Flux

```java
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;
import java.util.List;

public class FluxCreationExamples {

    // Flux.just — small finite sequences
    public Flux<String> supportedCurrencies() {
        return Flux.just("USD", "EUR", "GBP", "JPY", "CHF");
    }

    // Flux.fromIterable — wrap existing collections
    public Flux<Transaction> fromTransactionList(List<Transaction> transactions) {
        return Flux.fromIterable(transactions);
    }

    // Flux.range — numeric sequences (useful for pagination)
    public Flux<Integer> pageNumbers(int totalPages) {
        return Flux.range(1, totalPages);
    }

    // Flux.generate — stateful, synchronous, one-at-a-time generation
    // Perfect for generating sequential transaction IDs or ledger sequence numbers
    public Flux<LedgerEntry> generateLedgerSequence(long startSequence) {
        return Flux.generate(
            () -> startSequence,                       // initial state
            (sequence, sink) -> {                       // generator function
                sink.next(new LedgerEntry(sequence));  // emit one item
                if (sequence >= startSequence + 1000) {
                    sink.complete();                   // finite sequence
                }
                return sequence + 1;                   // next state
            }
        );
    }

    // Flux.create — asynchronous, multi-threaded emission (bridge from callback APIs)
    // Use to bridge event-driven payment gateway callbacks into a reactive stream
    public Flux<PaymentEvent> bridgeFromPaymentGateway(PaymentGatewayClient gateway) {
        return Flux.create(sink -> {
            gateway.registerListener(new PaymentEventListener() {
                @Override
                public void onPaymentReceived(PaymentEvent event) {
                    if (sink.isCancelled()) {
                        gateway.deregisterListener(this);
                        return;
                    }
                    sink.next(event);
                }

                @Override
                public void onGatewayDisconnect() {
                    sink.complete();
                }

                @Override
                public void onError(Throwable t) {
                    sink.error(t);
                }
            });
        }, FluxSink.OverflowStrategy.BUFFER); // buffer if downstream is slow
    }

    // Flux.interval — emit ticks on a schedule (rate monitoring, heartbeats)
    public Flux<Long> settlementWindowTicks() {
        return Flux.interval(Duration.ofMinutes(5))
                   .take(288); // 24 hours of 5-minute windows
    }
}
```

---

## Cold vs Hot Publishers

This is one of the most important distinctions in Reactor, and a frequent source of bugs in financial systems.

### Cold Publishers

A cold publisher **starts fresh for every subscriber**. Each subscriber gets the full sequence from the beginning, independently. This is the default in Reactor.

```java
// This Mono is COLD — each subscription triggers a new HTTP call
Mono<FraudScore> fraudCheck = Mono.fromCallable(() -> fraudClient.check(payment));

// Two subscribers = two separate HTTP calls
fraudCheck.subscribe(score -> log.info("Subscriber 1: {}", score));
fraudCheck.subscribe(score -> log.info("Subscriber 2: {}", score));
```

This is usually correct for I/O operations (each payment check should be independent), but becomes a problem when you need to share a single execution across multiple consumers.

### Hot Publishers

A hot publisher emits items regardless of whether anyone is subscribed. Late subscribers miss earlier items. Hot publishers represent live data sources: market data feeds, real-time payment event streams, WebSocket price updates.

```java
import reactor.core.publisher.Sinks;

public class HotPublisherExample {

    // Sinks.Many is the modern way to create hot publishers (since Reactor 3.4)
    private final Sinks.Many<PaymentEvent> paymentEventBus =
        Sinks.many().multicast().onBackpressureBuffer(1024);

    // Expose as Flux for consumers
    public Flux<PaymentEvent> paymentEvents() {
        return paymentEventBus.asFlux();
    }

    // Any component can push events into the sink
    public void publishPaymentEvent(PaymentEvent event) {
        Sinks.EmitResult result = paymentEventBus.tryEmitNext(event);
        if (result.isFailure()) {
            log.warn("Failed to emit payment event: {} reason: {}", event.getId(), result);
            // Handle overflow: could store in dead-letter queue
        }
    }

    // publish().autoConnect() — converts cold to hot, connects on first subscription
    public Flux<FxRate> hotFxRateStream(Flux<FxRate> coldFxSource) {
        return coldFxSource
            .publish()
            .autoConnect(1); // connect when at least 1 subscriber joins
    }

    // share() — shorthand for publish().refCount()
    // Disconnects upstream when all subscribers cancel (saves resources)
    public Flux<MarketPrice> sharedMarketFeed(Flux<MarketPrice> rawFeed) {
        return rawFeed.share();
    }
}
```

---

## Essential Operators

Reactor provides over 200 operators. These are the ones that appear in every real financial pipeline.

### Transformation: map and flatMap

```java
public class TransformationOperators {

    // map — synchronous, 1-to-1 transformation (never blocks)
    public Flux<EnrichedTransaction> enrichTransactionType(Flux<RawTransaction> raw) {
        return raw.map(tx -> new EnrichedTransaction(
            tx.getId(),
            tx.getAmount(),
            classifyTransactionType(tx)   // pure in-memory classification
        ));
    }

    // flatMap — asynchronous 1-to-1 or 1-to-many, runs inner publishers concurrently
    // This is the workhorse of reactive financial pipelines
    public Flux<ValidatedPayment> validatePaymentsAsync(Flux<Payment> payments) {
        return payments.flatMap(
            payment -> validatePayment(payment),    // returns Mono<ValidatedPayment>
            16,                                      // max concurrency: 16 parallel validations
            4                                        // prefetch: request 4 from upstream
        );
    }

    private Mono<ValidatedPayment> validatePayment(Payment payment) {
        return Mono.zip(
            fraudService.check(payment),     // parallel
            balanceService.check(payment),   // parallel
            complianceService.check(payment) // parallel
        ).map(tuple -> new ValidatedPayment(
            payment,
            tuple.getT1(), // FraudResult
            tuple.getT2(), // BalanceResult
            tuple.getT3()  // ComplianceResult
        ));
    }

    // concatMap — sequential flatMap (preserves order, waits for each inner publisher)
    // Use when downstream order matters (e.g., ordered ledger writes)
    public Flux<LedgerEntry> writeLedgerEntriesOrdered(Flux<Payment> payments) {
        return payments.concatMap(payment -> ledgerService.write(payment));
    }

    // switchMap — cancels previous inner publisher on new upstream item
    // Use for search-as-you-type or rate lookups where only the latest matters
    public Flux<FxRate> latestFxRate(Flux<CurrencyPair> pairRequests) {
        return pairRequests.switchMap(pair -> fxService.getRate(pair));
    }
}
```

### Filtering

```java
public class FilteringOperators {

    // filter — keep only items matching predicate
    public Flux<Transaction> largeTransactions(Flux<Transaction> all) {
        return all.filter(tx ->
            tx.getAmount().compareTo(new BigDecimal("10000")) > 0);
    }

    // take — limit items (useful for batch processing windows)
    public Flux<Transaction> nextBatch(Flux<Transaction> stream) {
        return stream.take(500); // process 500 at a time
    }

    // takeUntil — take until a condition is met
    public Flux<Transaction> transactionsUntilEOD(Flux<Transaction> stream) {
        return stream.takeUntil(tx -> tx.isEndOfDayMarker());
    }

    // skip — discard leading items
    public Flux<Transaction> skipHistorical(Flux<Transaction> all) {
        return all.skip(Duration.ofDays(30)); // skip transactions older than 30 days
    }

    // distinctUntilChanged — deduplicate consecutive identical items
    // Useful in market data feeds where the same price may be repeated
    public Flux<FxRate> dedupedFxRates(Flux<FxRate> rawRates) {
        return rawRates.distinctUntilChanged(FxRate::getRate);
    }
}
```

### Combining: zip, merge, combineLatest

```java
public class CombiningOperators {

    // zip — combine items from multiple publishers element-by-element (all must emit)
    public Mono<EnrichedPayment> enrichPayment(Payment payment) {
        return Mono.zip(
            accountService.getAccount(payment.getSenderId()),
            accountService.getAccount(payment.getReceiverId()),
            fxService.getRate(payment.getCurrencyPair()),
            fraudService.score(payment)
        ).map(tuple -> new EnrichedPayment(
            payment,
            tuple.getT1(),  // sender account
            tuple.getT2(),  // receiver account
            tuple.getT3(),  // FX rate
            tuple.getT4()   // fraud score
        ));
    }

    // merge — interleave items from multiple Flux as they arrive (non-deterministic order)
    // Use for fan-in of independent event streams
    public Flux<AlertEvent> allAlerts(
            Flux<AlertEvent> fraudAlerts,
            Flux<AlertEvent> complianceAlerts,
            Flux<AlertEvent> systemAlerts) {
        return Flux.merge(fraudAlerts, complianceAlerts, systemAlerts);
    }

    // mergeSequential — subscribe to all concurrently, but emit in subscription order
    public Flux<SettlementRecord> mergeSettlementBatches(
            List<Flux<SettlementRecord>> batches) {
        return Flux.mergeSequential(batches);
    }

    // combineLatest — emit when ANY publisher emits, using latest from all others
    // Use for dashboards: re-render whenever any metric updates
    public Flux<RiskSnapshot> riskDashboard(
            Flux<FraudMetric> fraudMetrics,
            Flux<VolumeMetric> volumeMetrics,
            Flux<ExposureMetric> exposureMetrics) {
        return Flux.combineLatest(
            fraudMetrics,
            volumeMetrics,
            exposureMetrics,
            (fraud, volume, exposure) ->
                new RiskSnapshot(fraud, volume, exposure)
        );
    }
}
```

---

## Error Handling

Errors in reactive streams are first-class citizens — they propagate downstream as a terminal signal. Financial systems need careful error handling to avoid silently swallowing failures.

```java
public class ErrorHandlingExamples {

    // onErrorReturn — substitute a fallback value on error
    // Use for non-critical enrichment where a default is acceptable
    public Mono<FraudScore> fraudScoreWithFallback(Payment payment) {
        return fraudService.score(payment)
            .onErrorReturn(FraudScore.defaultScore());
    }

    // onErrorResume — switch to an alternative publisher on error
    // Use for failover: primary service -> secondary service
    public Mono<FxRate> fxRateWithFailover(CurrencyPair pair) {
        return primaryFxService.getRate(pair)
            .onErrorResume(FxServiceException.class, ex -> {
                log.warn("Primary FX service failed, trying secondary: {}",
                    ex.getMessage());
                return secondaryFxService.getRate(pair);
            })
            .onErrorResume(ex -> {
                log.error("All FX services failed for pair: {}", pair, ex);
                return Mono.error(new FxRateUnavailableException(pair, ex));
            });
    }

    // onErrorMap — transform one error type into another (wrap external errors)
    public Mono<Account> findAccount(String id) {
        return accountRepository.findById(id)
            .onErrorMap(DataAccessException.class,
                ex -> new AccountServiceException(
                    "Failed to fetch account: " + id, ex));
    }

    // retry with exponential backoff — essential for transient network failures
    public Mono<PaymentResult> processWithRetry(Payment payment) {
        return paymentGateway.submit(payment)
            .retryWhen(
                Retry.backoff(3, Duration.ofMillis(100))
                    .maxBackoff(Duration.ofSeconds(2))
                    .filter(ex -> ex instanceof TransientGatewayException)
                    .doBeforeRetry(signal ->
                        log.warn("Retrying payment {} after attempt {}",
                            payment.getId(), signal.totalRetries()))
            )
            .onErrorMap(
                ex -> !(ex instanceof TransientGatewayException),
                ex -> new PermanentPaymentFailureException(payment.getId(), ex));
    }

    // timeout with fallback — compliance check that falls back to manual review
    public Mono<ComplianceResult> complianceCheckWithTimeout(Payment payment) {
        return complianceService.check(payment)
            .timeout(
                Duration.ofSeconds(3),
                Mono.just(ComplianceResult.pendingManualReview(payment.getId()))
            );
    }

    // doOnError — side effects on error WITHOUT changing the error (logging, metrics)
    public Mono<PaymentResult> processPaymentWithAudit(Payment payment) {
        return paymentService.process(payment)
            .doOnError(ex -> {
                auditLog.logFailure(payment.getId(), ex.getMessage());
                metrics.increment("payment.processing.error",
                    "type", ex.getClass().getSimpleName());
            });
    }
}
```

---

## Hooks: doOnNext, doOnError, doOnComplete

Hooks are side-effect operators — they let you observe what flows through the pipeline without changing it. They are essential for logging, metrics, and audit trails in financial systems.

```java
public class HookOperators {

    public Flux<Payment> paymentPipelineWithObservability(Flux<Payment> payments) {
        return payments
            .doOnSubscribe(sub ->
                log.info("Payment pipeline subscribed"))
            .doOnRequest(n ->
                log.debug("Downstream requested {} payments", n))
            .doOnNext(payment ->
                metrics.increment("payments.received",
                    "currency", payment.getCurrency()))
            .doOnNext(payment ->
                auditLog.record(AuditEvent.paymentReceived(payment.getId())))
            .map(this::validateAndEnrich)
            .doOnNext(payment ->
                metrics.increment("payments.validated"))
            .doOnError(ex ->
                log.error("Payment pipeline error: {}", ex.getMessage()))
            .doOnComplete(() ->
                log.info("Payment pipeline completed"))
            .doFinally(signalType ->
                log.info("Payment pipeline terminated with signal: {}", signalType));
    }

    // doOnEach — access all signal types (Next, Error, Complete) in one operator
    public Flux<Transaction> auditAllSignals(Flux<Transaction> transactions) {
        return transactions.doOnEach(signal -> {
            if (signal.isOnNext()) {
                auditLog.record(
                    AuditEvent.transactionProcessed(signal.get().getId()));
            } else if (signal.isOnError()) {
                auditLog.record(
                    AuditEvent.pipelineError(signal.getThrowable().getMessage()));
            }
            // Can also access Reactor Context here — useful for correlation IDs
            String correlationId = signal.getContextView()
                .getOrDefault("correlationId", "unknown");
            MDC.put("correlationId", correlationId);
        });
    }
}
```

---

## Marble Diagram Mental Model

Understanding marble diagrams is essential for reasoning about operator behavior. A horizontal line represents time, marbles represent items, `|` represents completion, and `X` represents an error.

```
Input:  --1--2--3--4--5--|
                                 map(x -> x * 2)
Output: --2--4--6--8--10--|

Input A: --1-----3-----5--|
Input B: ----2-----4-----|
                                 Flux.merge(A, B)
Output:  --1-2---3-4---5--|

Input A: --1--2--3--|
Input B: --a--b--c--|
                                 Mono.zip(A, B)
Output:  --(1,a)--(2,b)--(3,c)--|

Input:  --1--2--X
                                 onErrorReturn(0)
Output: --1--2--0--|
```

For a payment processing pipeline, the difference between `flatMap` (concurrent) and `concatMap` (sequential) is critical:

```
Payments: --P1--P2--P3--|
                 flatMap(validate, concurrency=2)
Validated: --V1----V3--V2--|  (order not guaranteed — V2 arrived after V3)

Payments: --P1--P2--P3--|
                 concatMap(validate)
Validated: --V1------V2------V3--|  (strict order preserved — each waits for previous)
```

---

## Practical Payment Stream Processing

Here is a complete, production-representative reactive payment processing pipeline:

```java
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import reactor.util.retry.Retry;
import java.time.Duration;
import java.math.BigDecimal;

@Service
public class ReactivePaymentProcessor {

    private final FraudDetectionService fraudService;
    private final FxRateService fxService;
    private final AccountService accountService;
    private final LedgerService ledgerService;
    private final MeterRegistry meterRegistry;
    private final AuditLogger auditLog;

    public Flux<PaymentResult> processPaymentStream(Flux<InboundPayment> inboundPayments) {
        return inboundPayments
            // Step 1: Validate basic fields — synchronous, cheap
            .filter(this::isWellFormed)
            .doOnNext(p -> log.debug("Processing payment: {}", p.getId()))

            // Step 2: Deduplicate — prevent double-processing of replayed events
            .distinct(InboundPayment::getIdempotencyKey)

            // Step 3: Enrich concurrently — 10 payments in parallel
            .flatMap(this::enrichPayment, 10)

            // Step 4: Fraud check — may need to slow down for suspicious transactions
            .flatMap(this::applyFraudDecision, 20)

            // Step 5: Write to ledger — ORDERED per account to maintain consistency
            .groupBy(EnrichedPayment::getSenderId)
            .flatMap(accountGroup ->
                accountGroup.concatMap(this::writeLedgerEntry), // sequential per account
                50 // up to 50 account groups in parallel
            )

            // Step 6: Emit result
            .map(ledgerEntry -> PaymentResult.success(ledgerEntry))

            // Step 7: Handle validation errors without terminating the stream
            .onErrorContinue(PaymentValidationException.class, (ex, item) -> {
                log.warn("Payment validation failed: {}", ex.getMessage());
                metrics.increment("payment.validation.rejected");
            })

            // Step 8: Observability
            .doOnNext(result ->
                metrics.increment("payment.processed",
                    "currency", result.getCurrency(),
                    "status", result.getStatus()))

            // Step 9: Publish on a bounded thread pool (not event-loop)
            .publishOn(Schedulers.boundedElastic());
    }

    private Mono<EnrichedPayment> enrichPayment(InboundPayment payment) {
        return Mono.zip(
            fxService.getRate(payment.getCurrencyPair())
                .timeout(Duration.ofSeconds(2))
                .onErrorReturn(FxRate.spot(payment.getCurrencyPair())),
            accountService.validate(payment.getSenderId())
                .timeout(Duration.ofSeconds(2))
        )
        .map(tuple -> EnrichedPayment.from(payment, tuple.getT1(), tuple.getT2()))
        .doOnError(ex -> log.error("Enrichment failed for payment {}: {}",
            payment.getId(), ex.getMessage()));
    }

    private Mono<EnrichedPayment> applyFraudDecision(EnrichedPayment payment) {
        return fraudService.evaluate(payment)
            .flatMap(decision -> {
                if (decision.isBlocked()) {
                    return Mono.error(
                        new FraudBlockedException(payment.getId(), decision));
                }
                return Mono.just(payment.withFraudDecision(decision));
            })
            .timeout(Duration.ofSeconds(1))
            .onErrorResume(FraudServiceUnavailableException.class,
                ex -> Mono.just(
                    payment.withFraudDecision(FraudDecision.pendingReview())));
    }

    private Mono<LedgerEntry> writeLedgerEntry(EnrichedPayment payment) {
        return ledgerService.write(payment)
            .retryWhen(
                Retry.backoff(2, Duration.ofMillis(50))
                    .filter(ex -> ex instanceof TransientLedgerException)
            );
    }

    private boolean isWellFormed(InboundPayment payment) {
        return payment.getId() != null
            && payment.getAmount() != null
            && payment.getAmount().compareTo(BigDecimal.ZERO) > 0
            && payment.getCurrency() != null
            && payment.getSenderId() != null
            && payment.getReceiverId() != null;
    }
}
```

---

## Cold vs Hot — Production Anti-Patterns

```java
public class PublisherAntiPatterns {

    // ANTI-PATTERN: Subscribing inside a flatMap
    // This creates a nested subscription that bypasses back-pressure
    public Flux<Result> bad(Flux<Payment> payments) {
        return payments.flatMap(payment -> {
            // BAD: manual subscribe inside reactive chain — loses errors, bypasses pressure
            auditService.log(payment).subscribe();
            return processService.process(payment);
        });
    }

    // CORRECT: Use side-effect operators or chain with then()
    public Flux<Result> good(Flux<Payment> payments) {
        return payments.flatMap(payment ->
            auditService.log(payment)
                .then(processService.process(payment)) // audit then process, in sequence
        );
    }

    // ANTI-PATTERN: Sharing a cold publisher without cache()
    public void badCaching() {
        // Cold Mono — each subscriber triggers a new API call
        Mono<ExchangeRate> rate = fxService.fetchRate("USD/EUR");
        rate.subscribe(r -> pipelineA(r)); // HTTP call #1
        rate.subscribe(r -> pipelineB(r)); // HTTP call #2
    }

    // CORRECT: cache() makes a cold publisher hot for repeat subscribers
    public void goodCaching() {
        Mono<ExchangeRate> cachedRate = fxService.fetchRate("USD/EUR")
            .cache(Duration.ofSeconds(30)); // cache result for 30 seconds
        cachedRate.subscribe(r -> pipelineA(r)); // HTTP call #1
        cachedRate.subscribe(r -> pipelineB(r)); // reuses cached result
    }
}
```

---

## Schedulers — Where Code Runs

```java
public class SchedulerPatterns {

    // publishOn  — changes the thread for downstream operators
    // subscribeOn — changes the thread for the subscription itself (affects source)
    public Flux<Report> reportPipeline(Flux<RawData> data) {
        return data
            .subscribeOn(Schedulers.boundedElastic())    // source runs on elastic thread
            .map(this::parseData)                         // runs on elastic thread
            .publishOn(Schedulers.parallel())             // switch to parallel thread
            .map(this::computeReport)                     // CPU-bound computation
            .publishOn(Schedulers.boundedElastic())       // switch back for I/O
            .flatMap(this::persistReport);                // I/O on elastic thread
    }

    /*
     * Key scheduler types:
     * Schedulers.parallel()        — CPU-bound, N threads (default: CPU cores)
     * Schedulers.boundedElastic()  — I/O-bound, up to 10x CPU threads, queued tasks
     * Schedulers.single()          — single reusable thread (sequential tasks)
     * Schedulers.immediate()       — caller's thread (testing)
     * Schedulers.fromExecutor(e)   — wrap your own ExecutorService
     */
}
```

---

## Production Tips and Pitfalls

**Pitfall 1: Blocking inside a reactive chain**

Never call `.block()`, `Thread.sleep()`, or any blocking I/O on an event-loop thread. Use `subscribeOn(Schedulers.boundedElastic())` to offload blocking operations.

```java
// WRONG — blocks the Netty event loop
public Mono<Payment> bad(String id) {
    return Mono.just(jdbcRepository.findById(id)); // blocking JDBC call on event loop
}

// CORRECT — offload to boundedElastic
public Mono<Payment> correct(String id) {
    return Mono.fromCallable(() -> jdbcRepository.findById(id))
               .subscribeOn(Schedulers.boundedElastic());
}
```

**Pitfall 2: Missing back-pressure on Flux.create**

`Flux.create` with `BUFFER` strategy can cause `OutOfMemoryError` if the producer is faster than the consumer. Always pair with an explicit back-pressure strategy appropriate to the use case. See Lesson 04 for a full treatment of back-pressure.

**Pitfall 3: Not disposing subscriptions**

In Spring beans, subscriptions created programmatically must be disposed on shutdown:

```java
@Service
public class PaymentEventListener implements DisposableBean {
    private Disposable subscription;

    @PostConstruct
    public void start() {
        subscription = paymentEvents.asFlux()
            .subscribe(this::handleEvent);
    }

    @Override
    public void destroy() {
        if (subscription != null && !subscription.isDisposed()) {
            subscription.dispose();
        }
    }
}
```

**Pitfall 4: Using Mono.fromCallable without subscribeOn**

`Mono.fromCallable` defers execution but still runs on the subscribing thread by default. Without `subscribeOn`, a blocking callable will block an event-loop thread.

**Pitfall 5: Operator fusion**

Reactor performs operator fusion — adjacent `map()` calls may be fused into a single pass. This is a performance optimization, but means you should not rely on separate `map()` calls for thread-safety isolation. Use `.hide()` to break fusion when benchmarking or debugging unexpected behavior.

---

## Summary

Project Reactor's `Mono` and `Flux` are the primitives from which all reactive financial systems are built. The key principles:

- **Nothing executes until subscribed** — cold publishers are lazy; keep pipelines cold until the framework subscribes
- **Back-pressure is built in** — the subscriber controls how fast the publisher emits via `request(n)`
- **Operators are composable** — each returns a new publisher, never mutates state
- **Errors are first-class** — they propagate as `onError` signals and must be handled explicitly
- **Schedulers control threading** — `publishOn` affects downstream, `subscribeOn` affects the source
- **Hooks are for observability** — use `doOnNext`, `doOnError`, `doFinally` for metrics and audit logging without polluting business logic

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the difference between cold and hot publishers in Project Reactor?",
      "options": ["Cold publishers use more memory than hot publishers", "Cold publishers start producing data only when subscribed to and produce data independently for each subscriber; hot publishers produce data regardless of subscribers and share the stream", "Hot publishers support backpressure; cold publishers do not", "Cold publishers require a Scheduler; hot publishers run on the main thread"],
      "correct": 1,
      "explanation": "Cold publishers (the default in Reactor) are lazy — they only start producing when a subscriber subscribes, and each subscriber gets its own independent sequence. Hot publishers are active regardless of subscribers; late subscribers only see items emitted after they subscribe."
    },
    {
      "text": "What is the effect of calling `publishOn(Schedulers.boundedElastic())` in a Reactor operator chain?",
      "options": ["It makes all operators in the chain execute on a single thread", "It switches the thread for all operators downstream of the publishOn call to the boundedElastic scheduler", "It switches the thread for all operators upstream of the publishOn call", "It creates a new subscription for each downstream subscriber"],
      "correct": 1,
      "explanation": "publishOn affects the downstream execution context. All operators after the publishOn call execute on threads provided by the specified Scheduler. This is the correct way to offload blocking work in a reactive pipeline — place publishOn before the blocking call."
    },
    {
      "text": "In a reactive payment pipeline, why is `flatMap` preferred over `map` when calling the fraud detection service?",
      "options": ["flatMap is faster than map for all operations", "flatMap accepts a function that returns a Publisher, enabling non-blocking concurrent calls; map transforms values synchronously and cannot handle asynchronous operations", "map blocks the event loop thread; flatMap does not", "flatMap automatically retries on errors; map does not"],
      "correct": 1,
      "explanation": "map transforms T to U synchronously. flatMap transforms T to Publisher<U>, which allows the inner publisher (e.g., a WebClient HTTP call) to execute asynchronously and concurrently. This is the fundamental operator for non-blocking I/O composition in reactive pipelines."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Reactive Payment Enrichment Pipeline with Mono and Flux",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Build a reactive payment processing pipeline using Flux.fromIterable() that enriches each payment with parallel calls to a fraud service and an FX rate service using Mono.zip(). Verify with StepVerifier that all enrichments complete and results are merged correctly."},
    {"id": "2", "description": "Add error handling to the pipeline: if the fraud service returns an error, fall back to a local rules engine using onErrorResume(). If the FX rate service returns an error, retry up to 3 times with 100ms exponential backoff using retryWhen(). Write tests for both error paths."},
    {"id": "3", "description": "Instrument the pipeline with doOnNext() for audit logging of each payment processed, doOnError() to increment a Micrometer error counter, and doFinally() to record processing duration in a histogram. Verify that metrics are recorded correctly even when errors occur."},
    {"id": "4", "description": "Demonstrate the difference between subscribeOn and publishOn: build a test that shows subscribeOn(boundedElastic()) moves the source subscription to a different thread, while publishOn(parallel()) moves only the downstream processing. Use Thread.currentThread().getName() inside operators to confirm thread switching."}
  ]
}
-->

Master these fundamentals before moving to Spring WebFlux, R2DBC, or Reactor Kafka — they are all built on the same Publisher-Subscriber contract.
