---
id: track-04-lesson-11
title: "Testing Reactive Code — StepVerifier and TestPublisher"
slug: testing-reactive
- tags: [StepVerifier, TestPublisher, VirtualTime, reactive-testing]
track: track-04
trackName: Async & Reactive Systems
sequence: 11
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [StepVerifier, TestPublisher, VirtualTime, reactive-testing]
prerequisites: []
---

# Testing Reactive Code — StepVerifier and TestPublisher

> [!NOTE]
> Testing reactive code requires a different approach than testing synchronous code. `StepVerifier` from `reactor-test` lets you assert on the entire reactive stream — values, errors, completion signals, timing, and backpressure — without blocking or using `CountDownLatch`. Mastering these tools is essential for writing reliable tests for reactive payment pipelines.

## Why Testing Reactive Code is Different

Synchronous tests are simple: call a method, assert the return value. Reactive tests must handle:

- **Asynchronous completion** — the publisher may complete on a different thread
- **Multiple values** — a `Flux<Payment>` emits 0–N values over time
- **Error signals** — errors terminate the stream and must be asserted specifically
- **Time-based operators** — `timeout`, `delayElements`, `interval` require virtual time
- **Backpressure** — the subscriber's demand affects what the publisher emits
- **Context propagation** — correlation IDs, security context must be verified

`StepVerifier` addresses all of these by subscribing to the publisher and asserting on the signal sequence in a declarative way.

---

## StepVerifier Basics

```java
import reactor.test.StepVerifier;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;

public class StepVerifierBasics {

    // Verify a Mono emits the expected value
    @Test
    void testMonoEmitsExpectedPayment() {
        Mono<Payment> payment = paymentService.findById("PAY-001");

        StepVerifier.create(payment)
            .assertNext(p -> {
                assertThat(p.getId()).isEqualTo("PAY-001");
                assertThat(p.getAmount()).isEqualByComparingTo("1500.00");
                assertThat(p.getStatus()).isEqualTo(PaymentStatus.PENDING);
            })
            .verifyComplete(); // asserts onComplete is signalled after the one item
    }

    // Verify a Mono is empty
    @Test
    void testPaymentNotFound() {
        Mono<Payment> notFound = paymentService.findById("PAY-NONEXISTENT");

        StepVerifier.create(notFound)
            .verifyComplete(); // no items, then complete — this is Mono.empty()
    }

    // Verify a specific error
    @Test
    void testMonoErrorsForInvalidAmount() {
        Mono<Payment> invalid = paymentService.create(
            PaymentRequest.builder()
                .amount(new BigDecimal("-100"))
                .build());

        StepVerifier.create(invalid)
            .verifyError(InvalidPaymentAmountException.class);
    }

    // Verify error message
    @Test
    void testErrorMessage() {
        Mono<Payment> invalid = paymentService.create(badRequest());

        StepVerifier.create(invalid)
            .expectErrorSatisfies(ex -> {
                assertThat(ex).isInstanceOf(PaymentValidationException.class);
                assertThat(ex.getMessage()).contains("amount must be positive");
            })
            .verify();
    }

    // Verify a sequence of values in a Flux
    @Test
    void testFluxEmitsExpectedTransactions() {
        Flux<Transaction> transactions = ledgerService.getHistory("ACC-001");

        StepVerifier.create(transactions)
            .expectNextMatches(tx -> tx.getType() == DEBIT && tx.getAmount().equals(new BigDecimal("100")))
            .expectNextMatches(tx -> tx.getType() == CREDIT)
            .expectNextMatches(tx -> tx.getType() == DEBIT)
            .verifyComplete();
    }
}
```

---

## assertNext and expectNext

```java
public class AssertNextExamples {

    // expectNext — exact value equality (uses equals())
    @Test
    void testExactValues() {
        Flux<String> currencies = paymentService.supportedCurrencies();

        StepVerifier.create(currencies)
            .expectNext("USD")
            .expectNext("EUR")
            .expectNext("GBP")
            .verifyComplete();
    }

    // expectNextCount — verify n items emitted without inspecting them
    @Test
    void testBatchSize() {
        Flux<Payment> batch = paymentService.getNextBatch(500);

        StepVerifier.create(batch)
            .expectNextCount(500)
            .verifyComplete();
    }

    // assertNext — arbitrary assertions on each item
    @Test
    void testPaymentEnrichment() {
        Payment rawPayment = Payment.of("PAY-001", new BigDecimal("1000"), "USD");
        Mono<EnrichedPayment> enriched = enrichmentService.enrich(rawPayment);

        StepVerifier.create(enriched)
            .assertNext(ep -> {
                // All enrichment fields present
                assertThat(ep.getPaymentId()).isEqualTo("PAY-001");
                assertThat(ep.getFxRate()).isNotNull();
                assertThat(ep.getFxRate().getPair()).isEqualTo("USD/EUR");
                assertThat(ep.getSenderAccount()).isNotNull();
                assertThat(ep.getFraudScore()).isGreaterThanOrEqualTo(0.0);
                assertThat(ep.getFraudScore()).isLessThanOrEqualTo(1.0);
            })
            .verifyComplete();
    }

    // expectNextSequence — verify exact sequence from an iterable
    @Test
    void testLedgerSequence() {
        List<BigDecimal> expectedAmounts = List.of(
            new BigDecimal("100.00"),
            new BigDecimal("250.00"),
            new BigDecimal("75.50")
        );

        Flux<BigDecimal> amounts = ledgerService.getAmounts("ACC-001")
            .map(LedgerEntry::getAmount);

        StepVerifier.create(amounts)
            .expectNextSequence(expectedAmounts)
            .verifyComplete();
    }

    // thenConsumeWhile — consume items matching a predicate, then assert
    @Test
    void testAllPaymentsPending() {
        Flux<Payment> pending = paymentService.getPendingPayments();

        StepVerifier.create(pending)
            .thenConsumeWhile(p -> p.getStatus() == PaymentStatus.PENDING)
            .verifyComplete();
        // If any payment has a non-PENDING status, thenConsumeWhile stops early
        // and verifyComplete() will fail because there are still items
    }
}
```

---

## Verifying Errors

```java
public class ErrorVerificationExamples {

    @Test
    void testFraudBlockTerminatesStream() {
        Mono<PaymentResult> blockedPayment =
            paymentService.process(highRiskPayment());

        StepVerifier.create(blockedPayment)
            .expectError(FraudBlockedException.class)
            .verify(Duration.ofSeconds(5)); // timeout for the entire verification
    }

    @Test
    void testTimeoutError() {
        // Service that takes 5 seconds but we only allow 2
        Mono<FraudScore> slowFraud = fraudService.check(payment())
            .timeout(Duration.ofSeconds(2));

        StepVerifier.create(slowFraud)
            .expectError(TimeoutException.class)
            .verify();
    }

    @Test
    void testOnErrorResumeFallback() {
        // Primary service fails, fallback should be used
        Mono<FxRate> withFallback = fxService.getRate("USD/EUR")
            .onErrorResume(ex -> Mono.just(FxRate.defaultRate("USD/EUR")));

        StepVerifier.create(withFallback)
            .assertNext(rate -> {
                assertThat(rate.getPair()).isEqualTo("USD/EUR");
                assertThat(rate.isDefault()).isTrue();
            })
            .verifyComplete();
    }

    @Test
    void testErrorAfterSomeItems() {
        // Flux that emits some items then fails
        Flux<Transaction> partialFailure = Flux.concat(
            Flux.just(tx("T1"), tx("T2")),
            Flux.error(new DatabaseException("connection lost"))
        );

        StepVerifier.create(partialFailure)
            .expectNextCount(2)
            .expectError(DatabaseException.class)
            .verify();
    }
}
```

---

## VirtualTime for Time-Based Operators

Time-based operators like `timeout`, `delayElements`, `interval`, and `retryWhen(backoff)` make tests slow or non-deterministic when using real time. `StepVerifier.withVirtualTime()` controls the clock, letting you test hours of behavior in milliseconds.

```java
import reactor.test.StepVerifier;
import java.time.Duration;

public class VirtualTimeExamples {

    // Test an interval-based settlement window ticker
    // Without virtual time: would take 24 hours to complete
    // With virtual time: completes in milliseconds
    @Test
    void testSettlementWindowTicker() {
        StepVerifier.withVirtualTime(() ->
            Flux.interval(Duration.ofMinutes(5))
                .take(3) // 3 settlement windows
        )
        .expectSubscription()
        .thenAwait(Duration.ofMinutes(5))   // advance clock by 5 minutes
        .expectNext(0L)
        .thenAwait(Duration.ofMinutes(5))
        .expectNext(1L)
        .thenAwait(Duration.ofMinutes(5))
        .expectNext(2L)
        .verifyComplete();
    }

    // Test timeout fallback behavior
    @Test
    void testPaymentTimeoutFallback() {
        StepVerifier.withVirtualTime(() ->
            Mono.never() // simulates a service that never responds
                .timeout(
                    Duration.ofSeconds(3),
                    Mono.just(Payment.timedOut("PAY-001"))
                )
        )
        .expectSubscription()
        .thenAwait(Duration.ofSeconds(3))  // advance past the timeout
        .assertNext(p -> assertThat(p.isTimedOut()).isTrue())
        .verifyComplete();
    }

    // Test retry with exponential backoff — verify timing
    @Test
    void testRetryBackoffTiming() {
        AtomicInteger attempts = new AtomicInteger(0);

        StepVerifier.withVirtualTime(() ->
            Mono.defer(() -> {
                attempts.incrementAndGet();
                return Mono.error(new TransientException("service unavailable"));
            })
            .retryWhen(
                Retry.backoff(3, Duration.ofMillis(100))
                    .maxBackoff(Duration.ofSeconds(2))
            )
        )
        .expectSubscription()
        .thenAwait(Duration.ofMillis(100))   // first retry after 100ms
        .thenAwait(Duration.ofMillis(200))   // second retry after 200ms
        .thenAwait(Duration.ofMillis(400))   // third retry after 400ms
        .expectError(RetryExhaustedException.class)
        .verify();

        assertThat(attempts.get()).isEqualTo(4); // 1 original + 3 retries
    }

    // Test cache expiry
    @Test
    void testFxRateCacheExpiry() {
        AtomicInteger callCount = new AtomicInteger(0);

        Mono<FxRate> cachedRate = Mono.fromCallable(() -> {
            callCount.incrementAndGet();
            return FxRate.of("USD/EUR", "1.09");
        }).cache(Duration.ofSeconds(30));

        StepVerifier.withVirtualTime(() -> cachedRate)
            .expectSubscription()
            .assertNext(r -> assertThat(r.getRate()).isEqualTo("1.09"))
            .verifyComplete();

        // Subscribe again within cache window — should not re-call
        StepVerifier.withVirtualTime(() -> cachedRate)
            .thenAwait(Duration.ofSeconds(10)) // within 30s window
            .assertNext(r -> assertThat(r.getRate()).isEqualTo("1.09"))
            .verifyComplete();

        assertThat(callCount.get()).isEqualTo(1); // only one real call
    }
}
```

---

## TestPublisher

`TestPublisher` lets you control exactly when and what a publisher emits during a test. It is useful when testing operators or services that react to events, not just static data.

```java
import reactor.test.publisher.TestPublisher;

public class TestPublisherExamples {

    // Control a payment event stream manually
    @Test
    void testPaymentEventProcessor() {
        TestPublisher<PaymentEvent> eventPublisher = TestPublisher.create();

        // Create the system under test, wiring it to the test publisher
        List<ProcessedEvent> processed = new ArrayList<>();
        eventPublisher.flux()
            .flatMap(paymentEventProcessor::process)
            .subscribe(processed::add);

        // Emit events one by one, verifying processing order
        eventPublisher.next(PaymentEvent.submitted("PAY-001"));
        assertThat(processed).hasSize(1);
        assertThat(processed.get(0).getPaymentId()).isEqualTo("PAY-001");

        eventPublisher.next(PaymentEvent.approved("PAY-001"));
        assertThat(processed).hasSize(2);

        eventPublisher.complete();
    }

    // Test that error propagation works correctly
    @Test
    void testErrorHandlingInProcessor() {
        TestPublisher<Payment> testPublisher = TestPublisher.create();

        StepVerifier.create(
            testPublisher.flux()
                .flatMap(paymentService::process)
                .onErrorContinue((ex, item) -> log.warn("Skipped: {}", item))
        )
        .then(() -> {
            testPublisher.next(validPayment("PAY-001"));   // succeeds
            testPublisher.next(invalidPayment("PAY-002")); // fails, should be skipped
            testPublisher.next(validPayment("PAY-003"));   // succeeds
            testPublisher.complete();
        })
        .expectNextCount(2) // PAY-001 and PAY-003
        .verifyComplete();
    }

    // Test backpressure with TestPublisher
    @Test
    void testBackpressureRespected() {
        TestPublisher<Payment> publisher = TestPublisher.createCold();

        StepVerifier.create(publisher.flux(), 2) // request only 2 items
            .then(() -> publisher.assertMinRequested(2)) // publisher sees demand of 2
            .then(() -> publisher.next(payment(1), payment(2)))
            .expectNextCount(2)
            .thenRequest(1)
            .then(() -> publisher.assertMinRequested(1))
            .then(() -> publisher.next(payment(3)))
            .expectNext(payment(3))
            .thenCancel()
            .verify();
    }

    // Test that a service correctly cancels the subscription on shutdown
    @Test
    void testSubscriptionCancelledOnShutdown() {
        TestPublisher<FxRate> ratePublisher = TestPublisher.create();

        FxRateConsumer consumer = new FxRateConsumer(ratePublisher.flux());
        consumer.start();

        ratePublisher.next(FxRate.of("USD/EUR", "1.09"));
        ratePublisher.assertSubscribers(1); // one active subscriber

        consumer.stop(); // should cancel the subscription

        ratePublisher.assertNoSubscribers(); // subscription was cancelled
    }
}
```

---

## WebTestClient for WebFlux Endpoints

`WebTestClient` is the reactive equivalent of `MockMvc`. It tests WebFlux controllers end-to-end without a running server.

```java
import org.springframework.test.web.reactive.server.WebTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public class PaymentControllerIntegrationTest {

    @Autowired
    private WebTestClient webTestClient;

    @Test
    void submitPayment_returns202WithLocation() {
        PaymentRequest request = PaymentRequest.builder()
            .amount(new BigDecimal("5000.00"))
            .currency("USD")
            .senderId("ACC-001")
            .receiverId("ACC-002")
            .idempotencyKey("IDEM-123")
            .build();

        webTestClient.post()
            .uri("/api/v1/payments")
            .header("Authorization", "Bearer " + validJwtToken())
            .header("Idempotency-Key", "IDEM-123")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(request)
            .exchange()
            .expectStatus().isAccepted()
            .expectHeader().exists("Location")
            .expectBody(PaymentSubmissionResponse.class)
            .value(response -> {
                assertThat(response.getPaymentId()).isNotNull();
                assertThat(response.getStatus()).isEqualTo("PENDING");
            });
    }

    @Test
    void getPaymentHistory_returnsJsonArray() {
        webTestClient.get()
            .uri("/api/v1/accounts/ACC-001/transactions?limit=10")
            .header("Authorization", "Bearer " + validJwtToken())
            .exchange()
            .expectStatus().isOk()
            .expectHeader().contentType(MediaType.APPLICATION_JSON)
            .expectBodyList(TransactionSummary.class)
            .hasSize(10)
            .value(list ->
                assertThat(list).allSatisfy(tx ->
                    assertThat(tx.getAmount()).isPositive()));
    }

    @Test
    void streamTransactions_returnsServerSentEvents() {
        // Test SSE streaming endpoint
        webTestClient.get()
            .uri("/api/v1/payments/stream?currency=USD")
            .header("Authorization", "Bearer " + validJwtToken())
            .accept(MediaType.TEXT_EVENT_STREAM)
            .exchange()
            .expectStatus().isOk()
            .returnResult(String.class)
            .getResponseBody()
            .take(5)
            .as(StepVerifier::create)
            .expectNextCount(5)
            .thenCancel()
            .verify(Duration.ofSeconds(10));
    }

    @Test
    void submitPayment_withoutAuth_returns401() {
        webTestClient.post()
            .uri("/api/v1/payments")
            .bodyValue(validRequest())
            .exchange()
            .expectStatus().isUnauthorized()
            .expectBody()
                .jsonPath("$.code").isEqualTo("AUTHENTICATION_REQUIRED");
    }

    @Test
    void submitPayment_idempotencyReplay_returnsSameResult() {
        String idempotencyKey = UUID.randomUUID().toString();

        // First submission
        PaymentSubmissionResponse first = webTestClient.post()
            .uri("/api/v1/payments")
            .header("Authorization", "Bearer " + validJwtToken())
            .header("Idempotency-Key", idempotencyKey)
            .bodyValue(validRequest())
            .exchange()
            .expectStatus().isAccepted()
            .returnResult(PaymentSubmissionResponse.class)
            .getResponseBody()
            .blockFirst();

        // Replay — same result, same payment ID
        webTestClient.post()
            .uri("/api/v1/payments")
            .header("Authorization", "Bearer " + validJwtToken())
            .header("Idempotency-Key", idempotencyKey)
            .bodyValue(validRequest())
            .exchange()
            .expectStatus().isOk()
            .expectHeader().valueEquals("X-Idempotency-Replayed", "true")
            .expectBody(PaymentSubmissionResponse.class)
            .value(response ->
                assertThat(response.getPaymentId())
                    .isEqualTo(first.getPaymentId()));
    }
}

// Slice test — only the web layer, services mocked
@WebFluxTest(PaymentController.class)
public class PaymentControllerSliceTest {

    @Autowired
    private WebTestClient webTestClient;

    @MockBean
    private PaymentService paymentService;

    @Test
    void getPayment_delegatesToService() {
        Payment mockPayment = Payment.of("PAY-001", new BigDecimal("1000"), "USD");
        when(paymentService.findById("PAY-001")).thenReturn(Mono.just(mockPayment));

        webTestClient
            .mutateWith(SecurityMockServerConfigurers.mockJwt())
            .get().uri("/api/v1/payments/PAY-001")
            .exchange()
            .expectStatus().isOk()
            .expectBody()
                .jsonPath("$.id").isEqualTo("PAY-001")
                .jsonPath("$.amount").isEqualTo(1000);
    }

    @Test
    void getPayment_notFound_returns404() {
        when(paymentService.findById("PAY-MISSING")).thenReturn(Mono.empty());

        webTestClient
            .mutateWith(SecurityMockServerConfigurers.mockJwt())
            .get().uri("/api/v1/payments/PAY-MISSING")
            .exchange()
            .expectStatus().isNotFound();
    }
}
```

---

## Testing Error Scenarios

```java
public class ErrorScenarioTests {

    @Test
    void testPipelineRecoversFromTransientError() {
        AtomicInteger callCount = new AtomicInteger(0);

        Mono<PaymentResult> resilientPayment = Mono.defer(() -> {
            if (callCount.incrementAndGet() < 3) {
                return Mono.error(new TransientGatewayException("service busy"));
            }
            return Mono.just(PaymentResult.success("PAY-001"));
        })
        .retryWhen(Retry.fixedDelay(3, Duration.ofMillis(10)));

        StepVerifier.create(resilientPayment)
            .assertNext(r -> assertThat(r.isSuccess()).isTrue())
            .verifyComplete();

        assertThat(callCount.get()).isEqualTo(3);
    }

    @Test
    void testCircuitBreakerOpensAfterThreshold() {
        // All calls fail — circuit breaker should open
        Flux<PaymentResult> calls = Flux.range(1, 20)
            .flatMap(i ->
                paymentGateway.submit(payment(i))
                    .onErrorResume(CircuitBreakerOpenException.class,
                        ex -> Mono.just(PaymentResult.rejected(i, "CIRCUIT_OPEN"))),
                1 // sequential to trigger circuit breaker properly
            );

        StepVerifier.create(calls)
            .thenConsumeWhile(r -> r.getStatus() != "CIRCUIT_OPEN")
            .assertNext(r -> assertThat(r.getStatus()).isEqualTo("CIRCUIT_OPEN"))
            .thenCancel()
            .verify();
    }

    @Test
    void testOnErrorContinueDoesNotTerminateFlux() {
        List<String> errors = new ArrayList<>();

        Flux<ProcessedPayment> pipeline = Flux.just(
            payment("P1"), payment("P2"), invalidPayment("P3"), payment("P4")
        )
        .flatMap(p -> p.isValid()
            ? Mono.just(ProcessedPayment.from(p))
            : Mono.<ProcessedPayment>error(new ValidationException(p.getId())))
        .onErrorContinue(ValidationException.class, (ex, item) ->
            errors.add(((ValidationException) ex).getPaymentId()));

        StepVerifier.create(pipeline)
            .expectNextCount(3) // P1, P2, P4 processed
            .verifyComplete();

        assertThat(errors).containsExactly("P3");
    }
}
```

---

## Testing Backpressure

```java
public class BackpressureTests {

    @Test
    void testSlowConsumerWithBoundedBuffer() {
        TestPublisher<Payment> fastProducer = TestPublisher.create();
        List<Payment> received = new CopyOnWriteArrayList<>();

        Disposable subscription = fastProducer.flux()
            .onBackpressureBuffer(5)
            .publishOn(Schedulers.single())
            .doOnNext(p -> {
                try { Thread.sleep(10); } catch (InterruptedException e) {}
                received.add(p);
            })
            .subscribe();

        // Emit 10 payments rapidly (faster than consumer)
        for (int i = 0; i < 10; i++) {
            fastProducer.next(payment(i));
        }
        fastProducer.complete();

        // Wait for processing to finish
        await().atMost(Duration.ofSeconds(2))
            .until(() -> subscription.isDisposed());

        // Buffer of 5 — first 5 items processed, rest dropped or buffered
        assertThat(received.size()).isLessThanOrEqualTo(10);
        subscription.dispose();
    }

    @Test
    void testFlatMapConcurrencyLimit() {
        AtomicInteger maxConcurrent = new AtomicInteger(0);
        AtomicInteger current = new AtomicInteger(0);

        Flux<String> pipeline = Flux.range(1, 50)
            .flatMap(i -> Mono.fromCallable(() -> {
                int c = current.incrementAndGet();
                maxConcurrent.updateAndGet(max -> Math.max(max, c));
                Thread.sleep(5);
                current.decrementAndGet();
                return "result-" + i;
            }).subscribeOn(Schedulers.boundedElastic()),
            8 // max concurrency
        );

        StepVerifier.create(pipeline)
            .expectNextCount(50)
            .verifyComplete();

        assertThat(maxConcurrent.get()).isLessThanOrEqualTo(8);
    }
}
```

---

## Production Tips and Pitfalls

**Pitfall 1: Using `.block()` in tests**

`block()` works in tests but loses all the benefits of reactive testing. It doesn't verify backpressure, context propagation, or error signals. Use `StepVerifier` instead.

**Pitfall 2: Forgetting `verify()` / `verifyComplete()`**

`StepVerifier.create()` does not start the verification until you call `verify()`, `verifyComplete()`, or `verifyError()`. If you forget, the test passes vacuously regardless of what the publisher emits.

```java
// WRONG — test always passes, publisher never actually subscribed
@Test
void buggyTest() {
    StepVerifier.create(paymentService.process(payment))
        .expectNext(result); // never verified!
}

// CORRECT — always call a terminal verify method
@Test
void correctTest() {
    StepVerifier.create(paymentService.process(payment))
        .expectNext(result)
        .verifyComplete(); // actually runs the test
}
```

**Pitfall 3: `withVirtualTime` requires a supplier**

`StepVerifier.withVirtualTime()` takes a `Supplier<Publisher>`, not a `Publisher` directly. The publisher must be created inside the lambda to use the virtual clock. If you create it outside, the real clock is used for any time-based operators that run before `withVirtualTime` takes effect.

**Pitfall 4: `TestPublisher` violations**

By default, `TestPublisher` is lenient and allows spec violations (e.g., emitting after complete). Use `TestPublisher.createNoncompliant()` for intentional violation testing, or `TestPublisher.create()` for strict compliance.

**Pitfall 5: Not testing the error path**

Financial pipelines must handle failures correctly. Test every `onErrorResume`, `retryWhen`, and `onErrorContinue` path explicitly. Silent failure modes are especially dangerous in payment systems.

---

## Summary

Effective reactive testing in fintech requires the full `reactor-test` toolkit:

- **`StepVerifier`** verifies the signal sequence — values, errors, completion — declaratively
- **`assertNext`** / **`expectNext`** assert on individual items with arbitrary predicates
- **`verifyError`** / **`expectErrorSatisfies`** verify the error terminal signal and its type/message
- **`VirtualTime`** makes time-based operators testable in milliseconds
- **`TestPublisher`** gives precise control over when and what a publisher emits during tests
- **`WebTestClient`** tests WebFlux endpoints end-to-end or as slice tests
- **Always call a terminal `verify*()` method** — without it, the test does not run

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What happens if you write a StepVerifier chain but forget to call verify() or verifyComplete() at the end?",
      "options": ["The test fails immediately with a NullPointerException", "The test passes vacuously — no assertion is executed because the StepVerifier never subscribes to the publisher", "StepVerifier throws an IllegalStateException warning that verify() was not called", "The reactive pipeline executes but results are discarded"],
      "correct": 1,
      "explanation": "StepVerifier is lazy — it only subscribes to the publisher when a terminal verify*() method is called. Without it, the test method returns without executing any assertions. The test passes (no assertions = no failures) even if the publisher would have emitted errors, giving false confidence."
    },
    {
      "text": "Why is VirtualTime necessary when testing operators like delayElements(Duration.ofMinutes(5)) in a reactive pipeline?",
      "options": ["VirtualTime is needed to prevent thread safety issues in time-based operators", "Without VirtualTime, the test would actually wait 5 minutes for the delay to elapse; VirtualTime advances a virtual clock instantly so time-based operators complete without real wall-clock waiting", "VirtualTime is required when testing Flux.interval() on a background thread", "VirtualTime allows testing on slower CI machines by scaling time down proportionally"],
      "correct": 1,
      "explanation": "Time-based operators like delayElements, timeout, and interval use a Scheduler's clock. StepVerifier.withVirtualTime() substitutes a virtual clock that the test controls. Calling advanceTimeBy(Duration.ofMinutes(5)) makes the operator believe 5 minutes have passed without real waiting."
    },
    {
      "text": "What is the purpose of TestPublisher in reactive testing?",
      "options": ["A replacement for StepVerifier that provides simpler assertions", "A manually controlled publisher that lets you programmatically emit items, errors, and completions at precise moments during a test, independent of business logic", "A publisher that records all emitted items for later assertion", "A tool for benchmarking the throughput of reactive pipelines"],
      "correct": 1,
      "explanation": "TestPublisher gives full programmatic control over what a publisher emits and when. This lets you test subscriber behavior in isolation: emit exactly 3 items, then an error, and verify the subscriber handles each signal correctly without depending on real data sources."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Comprehensive Reactive Testing Suite for a Payment Processing Service",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Write StepVerifier tests for a payment processing Flux: verify the first 3 payments have status PENDING, the 4th emits a PaymentValidationException (not onError — it is mapped to a domain error in the stream), and the stream completes after 10 payments. Test both the happy path and an error scenario where the 5th payment triggers an upstream error."},
    {"id": "2", "description": "Test a payment timeout scenario using VirtualTime: build a Mono that calls an external service with a 30-second timeout using Mono.timeout(Duration.ofSeconds(30)). Write a StepVerifier.withVirtualTime() test that advances time by 31 seconds and verifies a TimeoutException is raised."},
    {"id": "3", "description": "Use TestPublisher to test a downstream payment subscriber in isolation: create a TestPublisher<Payment>, subscribe your payment processing service to it, then emit valid payments, an invalid payment that triggers retry logic, and finally complete. Assert that the service processed exactly the expected number of payments and routed the invalid one to the dead-letter handler."},
    {"id": "4", "description": "Write a WebTestClient integration test that sends 10 concurrent payment requests to a WebFlux endpoint, verifies all return 200 with the correct payment ID, and confirms that a request with a duplicate idempotency key returns the same response as the original (not a 409 or second processing). Use @SpringBootTest(webEnvironment = RANDOM_PORT) for the test."}
  ]
}
-->
- **Test error paths explicitly** — every `onErrorResume` and `retryWhen` in a payment pipeline deserves its own test case
