---
id: track-07-lesson-20
title: "Reactive vs Blocking — Performance Profile Comparison"
slug: reactive-vs-blocking
track: track-07
trackName: "Performance Engineering"
sequence: 20
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - reactive
  - blocking
  - Project-Reactor
  - WebFlux
  - thread-model
  - throughput
  - R2DBC
prerequisites:
  - track-07-lesson-19
---

# Reactive vs Blocking — Performance Profile Comparison

Choosing between a blocking and a reactive programming model is one of the most consequential architectural decisions in a high-throughput fintech system. This lesson provides a detailed, benchmark-driven comparison of both models so you can make the right choice for each service in your platform — not just follow a trend.

---

## 1. The Thread-Per-Request Model

Spring MVC (Servlet-based) assigns one thread to each incoming HTTP request for the entire duration of the request lifecycle. The thread blocks while waiting for I/O: database queries, HTTP calls to downstream services, or file reads.

```
Incoming request → Thread A acquired from pool
  Thread A: validate input    (CPU, 0.1ms)
  Thread A: query DB          (BLOCKING I/O, 80ms) ← thread sleeps here
  Thread A: call fraud API    (BLOCKING I/O, 15ms) ← thread sleeps here
  Thread A: write audit log   (BLOCKING I/O, 5ms)  ← thread sleeps here
  Thread A: serialize response (CPU, 0.2ms)
Thread A released to pool     (total: ~100ms, thread held 100ms)
```

The critical observation: a thread holding for 100ms, 80ms of which was spent sleeping waiting for the database, is wasting a valuable OS resource.

### 1.1 Thread Pool Sizing and the Concurrency Ceiling

```yaml
# Typical Spring MVC thread pool configuration
server:
  tomcat:
    threads:
      max: 200          # Max concurrent requests
      min-spare: 10

# With 200 threads and 100ms average response time:
# Max theoretical throughput = 200 / 0.1s = 2,000 requests/second
# At 2,001 req/s, the 201st request waits for a thread

# Reality check: a payment service under Black Friday load
# 10,000 requests in flight at once (e.g. 100,000 req/s × 100ms)
# = 10,000 platform threads required
# Each reserves a stack (~1MB by default, committed lazily) plus kernel
# resources -- and the OS must schedule them all
```

The 200-thread default is just a sensible starting value — many services run with more. The real limits are memory, scheduling overhead and, above all, the downstream resources those threads wait on. Java 21 **virtual threads** (lesson 15) remove the thread limit while keeping this simple blocking style — compare them with reactive before choosing.

---

## 2. The Event Loop Model

Reactive/event-loop systems use a small, fixed number of threads (Reactor Netty defaults to one event-loop thread per CPU core) and handle thousands of concurrent operations through non-blocking I/O and callbacks.

```
Event Loop Thread 1:
  t=0ms: Accept request A, start DB query (non-blocking, registers callback)
  t=0ms: Accept request B, start DB query (non-blocking, registers callback)
  t=0ms: Accept request C, start fraud API call (non-blocking, registers callback)
  t=80ms: DB result for A arrives → continue processing A, send response A
  t=81ms: DB result for B arrives → continue processing B, send response B
  t=95ms: Fraud API result for C arrives → continue processing C, send response C

One thread serviced 3 requests that together took 255ms of I/O wait
using zero blocking and minimal CPU overhead
```

### 2.1 Benchmark: 10,000 Concurrent Connections

Illustrative scenario: 10,000 concurrent clients, each request waiting 100ms on a downstream HTTP call that can itself handle that concurrency.

```
Blocking (Spring MVC, Tomcat, 200 threads):
  Max throughput:     200 / 0.1s = 2,000 req/s (thread pool saturated)
  Queueing:           10,000 waiting / 2,000 per second -> ~5 s
  P99 latency:        ~5,000ms (queuing behind the thread pool)
  (10,000 platform threads instead would need 10,000 stacks and a
   lot of scheduling work -- or use virtual threads)

Reactive (Spring WebFlux, Netty, one event loop per core):
  Threads used:       8 on an 8-core machine
  Max throughput:     ~10,000 in flight / 0.1s = ~100,000 req/s of I/O
                      -- in practice limited by CPU and the downstream
  P99 latency:        ~100ms + processing (no thread-pool queueing)

Caveat: if the 100ms is a DATABASE query, the limit is the connection
pool, not the thread model: 20 connections × 10 queries/s each = 200 req/s
for blocking AND reactive alike.
```

---

## 3. Project Reactor: Mono and Flux

Project Reactor is the reactive library underlying Spring WebFlux. It models asynchronous sequences as two types:

- `Mono<T>`: 0 or 1 element (like a `CompletableFuture<T>`)
- `Flux<T>`: 0 to N elements (like an async `Stream<T>`)

```java
// Mono: single payment lookup
Mono<Payment> payment = paymentRepository.findById(paymentId);

// Flux: stream of incoming payments
Flux<Payment> payments = paymentRepository.findByAccountId(accountId);

// Composing operations
Mono<PaymentResponse> response = paymentRepository
    .findById(paymentId)
    .switchIfEmpty(Mono.error(new PaymentNotFoundException(paymentId)))
    .flatMap(payment -> fraudCheckService.evaluate(payment))
    .flatMap(checkedPayment -> paymentProcessor.submit(checkedPayment))
    .map(result -> new PaymentResponse(result.getId(), result.getStatus()));
```

The key difference from `CompletableFuture`: Reactor pipelines are **lazy** — nothing executes until a subscriber subscribes. This enables composition without side effects.

---

## 4. Spring WebFlux vs Spring MVC

```java
// Spring MVC — blocking controller
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentControllerMvc {

    private final PaymentService paymentService; // Uses JDBC, blocking

    @PostMapping
    public ResponseEntity<PaymentResponse> submit(
            @RequestBody @Valid PaymentRequest request) {
        // Thread blocks here for the entire duration
        PaymentResult result = paymentService.process(request);
        return ResponseEntity.ok(new PaymentResponse(result));
    }
}

// Spring WebFlux — non-blocking controller
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentControllerWebFlux {

    private final ReactivePaymentService paymentService; // Uses R2DBC

    @PostMapping
    public Mono<ResponseEntity<PaymentResponse>> submit(
            @RequestBody @Valid PaymentRequest request) {
        return paymentService.process(request)
            .map(result -> ResponseEntity.ok(new PaymentResponse(result)))
            .onErrorResume(ValidationException.class,
                e -> Mono.just(ResponseEntity.badRequest()
                    .body(new PaymentResponse(e.getMessage()))))
            .onErrorResume(InsufficientFundsException.class,
                e -> Mono.just(ResponseEntity.unprocessableEntity()
                    .body(new PaymentResponse(e.getMessage()))));
    }

    // Server-Sent Events: stream of real-time payment updates
    @GetMapping(value = "/stream/{accountId}",
                produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<PaymentStatusUpdate> streamUpdates(@PathVariable String accountId) {
        return paymentService.getUpdateStream(accountId)
            .limitRate(100); // Backpressure: request 100 items at a time
    }
}
```

---

## 5. R2DBC: Reactive PostgreSQL

JDBC is fundamentally blocking — it cannot work in an event-loop model. R2DBC (Reactive Relational Database Connectivity) provides a non-blocking API for relational databases.

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-r2dbc</artifactId>
</dependency>
<dependency>
    <groupId>org.postgresql</groupId>
    <artifactId>r2dbc-postgresql</artifactId>
</dependency>
```

```yaml
# application.yml
spring:
  r2dbc:
    url: r2dbc:postgresql://localhost:5432/payments
    username: payments_app
    password: ${DB_PASSWORD}
    pool:
      initial-size: 5
      max-size: 20
      # A PostgreSQL connection still runs ONE query at a time, reactive or
      # not: 20 connections with 50ms queries = at most ~400 queries/s.
      # Reactive saves THREADS, not database connections -- size the pool
      # for the concurrent queries the database can handle well.
```

```java
// ReactivePaymentRepository.java
public interface ReactivePaymentRepository extends R2dbcRepository<Payment, UUID> {

    // Spring Data R2DBC generates reactive implementation
    Flux<Payment> findByAccountIdAndStatusOrderByCreatedAtDesc(
        String accountId, PaymentStatus status);

    @Query("SELECT * FROM payments WHERE account_id = :accountId " +
           "AND created_at > :since LIMIT :limit")
    Flux<Payment> findRecentByAccount(
        @Param("accountId") String accountId,
        @Param("since") Instant since,
        @Param("limit") int limit);

    @Modifying
    @Query("UPDATE payments SET status = :status, updated_at = NOW() " +
           "WHERE id = :id")
    Mono<Integer> updateStatus(@Param("id") UUID id,
                               @Param("status") String status);
}

// ReactivePaymentService.java
@Service
@Slf4j
public class ReactivePaymentService {

    private static final long FAIL_OPEN_LIMIT_MINOR = 5_000;   // e.g. 50.00, documented

    private final ReactivePaymentRepository paymentRepository;
    private final ReactiveFraudCheckClient fraudCheckClient;
    private final ReactiveAuditService auditService;

    public Mono<PaymentResult> process(PaymentRequest request) {
        return Mono.just(request)
            .flatMap(this::validate)
            .flatMap(validated -> fraudCheckClient.check(validated)
                .timeout(Duration.ofSeconds(2))
                // Fail OPEN only below a documented amount threshold;
                // above it, hold the payment for review (fail closed)
                .onErrorResume(TimeoutException.class,
                    e -> Mono.just(validated.amountMinor() <= FAIL_OPEN_LIMIT_MINOR
                        ? FraudCheckResult.allowedWithoutCheck(validated)
                        : FraudCheckResult.holdForReview(validated))))
            .flatMap(this::persistPayment)
            .flatMap(payment -> auditService.log(payment)
                // Best-effort audit: swallow its errors EXPLICITLY, or the
                // payment fails too. (If the audit record is mandatory, write
                // it in the same DB transaction as the payment instead.)
                .onErrorResume(e -> {
                    log.warn("Audit log failed for payment {}", payment.getId(), e);
                    return Mono.empty();
                })
                .thenReturn(payment))
            .map(PaymentResult::fromPayment)
            .doOnSuccess(r -> log.info("Payment {} processed: {}",
                r.getPaymentId(), r.getStatus()))
            .doOnError(e -> log.error("Payment processing failed", e));
    }
}
```

---

## 6. Backpressure with Flux.limitRate

Backpressure is the mechanism by which a subscriber signals to a publisher how many items it can consume. Without backpressure, a fast producer can overwhelm a slow consumer and cause OOM.

```java
// Processing a large batch of payments reactively
public Flux<PaymentResult> processBatch(Flux<PaymentRequest> payments) {
    return payments
        // Request 50 items at a time — backpressure to upstream
        .limitRate(50)
        // Prepare up to 10 payments concurrently (returns Mono<Payment>)
        .flatMap(request -> preparePayment(request), 10)
        // Group into batches of up to 100 (or every 50ms) for bulk inserts
        .bufferTimeout(100, Duration.ofMillis(50))
        // One batch at a time, in order
        .concatMap(batch -> paymentRepository.saveAll(batch))
        .map(PaymentResult::fromPayment);
}

// Flux.limitRate controls the demand signal sent upstream:
// Without limitRate: the next operator decides (flatMap requests its
//   concurrency, a plain subscribe() requests Long.MAX_VALUE)
// With limitRate(50): requests 50, then tops up ~38 more each time
//   ~75% of the requested items have been delivered
// (bounded demand — producer paces itself)

// Measuring backpressure effectiveness
payments
    .limitRate(50)
    .doOnRequest(n -> log.debug("Downstream requested {} items", n))
    .flatMap(this::preparePayment, 10)
    .doOnNext(p -> log.debug("Prepared payment {}", p.getId()))
    .subscribe();
```

---

## 7. Reactive Payment Pipeline

```mermaid
flowchart LR
    A[Payment Source\nFlux of payments] -->|limitRate 50| B[Fraud Check\nflatMap concurrency=10]
    B -->|score < 0.8| C[Atomic Debit\nflatMap concurrency=10]
    C -->|debited| D[Persist Payment\nsame transaction]
    D --> E[Publish Event\nvia outbox]
    E --> F[Audit Log]

    B -->|score >= 0.8| G[Reject + Audit]
    C -->|insufficient funds| H[Reject + Notify]

    style A fill:#e8f5e9
    style F fill:#e3f2fd
    style G fill:#ffebee
    style H fill:#ffebee
```

```java
// Full reactive payment pipeline
@Service
@RequiredArgsConstructor
@Slf4j
public class ReactivePaymentPipeline {

    private static final long FAIL_OPEN_LIMIT_MINOR = 5_000;   // documented threshold

    private final FraudService fraudService;
    private final AccountService accountService;
    private final PaymentRepository paymentRepository;
    private final EventBus eventBus;

    public Flux<PaymentResult> run(Flux<PaymentRequest> source) {
        return source
            .flatMap(request -> processOne(request)
                    // Per-payment error handling: one failure must not end the
                    // whole stream, and EVERY request gets a result.
                    // (Avoid onErrorContinue: it changes the behaviour of
                    //  upstream operators in surprising ways.)
                    .onErrorResume(e -> {
                        log.error("Payment {} failed", request.getPaymentId(), e);
                        return Mono.just(PaymentResult.failed(request, "PROCESSING_ERROR"));
                    }),
                10);                                         // max 10 in flight
    }

    private Mono<PaymentResult> processOne(PaymentRequest request) {
        return fraudService.check(request)
            .timeout(Duration.ofSeconds(2))
            // Fail open only for small amounts; hold larger payments for review
            .onErrorResume(TimeoutException.class, e -> Mono.just(
                request.getAmountMinor() <= FAIL_OPEN_LIMIT_MINOR
                    ? FraudCheckResult.allowedWithoutCheck(request)
                    : FraudCheckResult.holdForReview(request)))
            .flatMap(fraud -> {
                if (fraud.isHold()) {
                    return Mono.just(PaymentResult.heldForReview(request));
                }
                if (fraud.getRiskScore() >= 0.8) {
                    // A rejection is a RESULT, not something to filter away
                    return Mono.just(PaymentResult.rejected(request, "HIGH_FRAUD_RISK"));
                }
                // Atomic debit -- never "check balance, then debit" (race):
                // UPDATE accounts SET balance = balance - :amt
                //  WHERE id = :acct AND balance >= :amt
                // Debit + payment row run in ONE transaction (TransactionalOperator),
                // and the event goes out via an outbox table (track 05).
                return accountService.debitAndRecord(request)
                    .map(debited -> debited
                        ? PaymentResult.success(request)
                        : PaymentResult.rejected(request, "INSUFFICIENT_FUNDS"));
            });
    }
}
```

---

## 8. Error Handling in Reactive Pipelines

```java
// onErrorResume: recover by switching to an alternative Mono/Flux
public Mono<ExchangeRate> getExchangeRate(String pair) {
    return primaryRateProvider.getRate(pair)
        .onErrorResume(ServiceUnavailableException.class,
            e -> fallbackRateProvider.getRate(pair))
        .onErrorResume(Exception.class,
            e -> cachedRateService.getLastKnownRate(pair)
                .switchIfEmpty(Mono.error(
                    new NoRateAvailableException("No rate for " + pair))));
}

// retryWhen: retry with exponential backoff
public Mono<PaymentStatus> pollPaymentStatus(String paymentId) {
    return paymentGateway.getStatus(paymentId)
        .filter(status -> status != PaymentStatus.PENDING)
        .repeatWhenEmpty(flux -> flux
            .zipWith(Flux.range(1, 5), (emission, attempt) -> attempt)
            .flatMap(attempt -> Mono.delay(
                Duration.ofMillis(100L * (long) Math.pow(2, attempt)))))
        .retryWhen(Retry.backoff(3, Duration.ofMillis(200))
            .filter(e -> e instanceof TransientException)
            .doBeforeRetry(signal ->
                log.warn("Retrying payment status check, attempt {}",
                    signal.totalRetries() + 1)));
}
```

---

## 9. MDC Context Propagation in Reactive

ThreadLocal (which MDC uses internally) does not work in reactive pipelines because a single request hops between threads. Use Reactor's `Context` instead.

```java
// WRONG — MDC is ThreadLocal and will be empty on reactor threads
public Mono<PaymentResult> processWithLogging(PaymentRequest request) {
    MDC.put("paymentId", request.getPaymentId()); // Set on calling thread
    return paymentRepository.findById(request.getId())
        .map(payment -> {
            // This runs on a different thread — MDC is EMPTY here
            log.info("Processing payment"); // No paymentId in log!
            return process(payment);
        });
}

// CORRECT — use Reactor Context + contextWrite
public Mono<PaymentResult> processWithLogging(PaymentRequest request) {
    return paymentRepository.findById(request.getId())
        .map(payment -> {
            // Read from Reactor Context, set MDC for this callback
            return process(payment);
        })
        .doOnEach(signal -> {
            // signal.getContextView() is available on every signal
            String paymentId = signal.getContextView()
                .getOrDefault("paymentId", "unknown");
            if (signal.isOnNext()) {
                MDC.put("paymentId", paymentId);
                log.info("Processing payment");
                MDC.remove("paymentId");
            }
        })
        // Inject context values at the subscription point
        .contextWrite(Context.of("paymentId", request.getPaymentId(),
                                 "correlationId", request.getCorrelationId()));
}

// Better approach (Reactor 3.5+, Spring Boot 3.2+): automatic context
// propagation with the Micrometer context-propagation library. It restores
// ThreadLocals such as MDC from the Reactor Context on every thread hop.
//   application.properties: spring.reactor.context-propagation=auto
//   (or call Hooks.enableAutomaticContextPropagation() at startup)
// Micrometer Tracing then puts traceId/spanId into the MDC for you.
```

---

## 10. When Reactive Wins vs When Blocking Wins

```mermaid
graph TD
    A{What is the\nbottleneck?} -->|I/O bound: DB queries,\nHTTP calls, file I/O| B[Reactive wins\nWebFlux + R2DBC\n10k concurrent with 8 threads]
    A -->|CPU bound: encryption,\nimage processing,\ncomplex calculations| C[Blocking wins\nSpring MVC\nThread per core, no context overhead]
    A -->|Heavy JDBC\necosystem dependency| D[Blocking wins\nJPA, Hibernate,\nlegacy drivers not reactive]
    A -->|Team < 1 year\nreactive experience| E[Blocking wins\nDebuggability, stack traces,\nfamiliar mental model]
    A -->|Streaming large\ndata sets| B
    A -->|Simple CRUD\nlow traffic| F[Either works\nChoose for simplicity]

    style B fill:#e8f5e9
    style C fill:#fff3e0
    style D fill:#fff3e0
    style E fill:#fff3e0
```

| Scenario | Recommendation | Reason |
|----------|----------------|--------|
| 10k concurrent I/O-bound requests | Reactive (or virtual threads) | A few threads vs 10k platform threads |
| Payment calculation engine | Blocking | CPU-bound, no I/O wait |
| Existing JPA/Hibernate codebase | Blocking | No R2DBC equivalents for all features |
| Real-time event streaming | Reactive | Flux + SSE is natural fit |
| Batch processing (overnight) | Blocking | Spring Batch, throughput not concurrency |
| Team new to reactive | Blocking | Bugs in reactive code are hard to debug |

---

## 11. Production Pitfalls

### Pitfall 1: Blocking Call Inside a Reactive Pipeline

This is the single most common and dangerous mistake. Calling a blocking API (JDBC, synchronous HTTP client) on an event-loop thread starves all other requests on that thread.

```java
// WRONG — JdbcTemplate.query() blocks the event-loop thread
@GetMapping("/payments/{id}")
public Mono<Payment> getPayment(@PathVariable String id) {
    return Mono.fromCallable(() ->
        // jdbcTemplate is blocking — this parks the event-loop thread
        // for the duration of the DB query
        jdbcTemplate.queryForObject(
            "SELECT * FROM payments WHERE id = ?",
            paymentRowMapper, id)
    );
    // Mono.fromCallable with no scheduler change still runs on the event-loop!
}

// CORRECT — wrap blocking work in a bounded elastic scheduler
@GetMapping("/payments/{id}")
public Mono<Payment> getPayment(@PathVariable String id) {
    return Mono.fromCallable(() ->
        jdbcTemplate.queryForObject(
            "SELECT * FROM payments WHERE id = ?",
            paymentRowMapper, id)
    )
    // subscribeOn moves the execution to a separate thread pool
    // The event-loop thread is immediately freed
    .subscribeOn(Schedulers.boundedElastic());
}

// BEST — migrate to R2DBC entirely for true non-blocking DB access
@GetMapping("/payments/{id}")
public Mono<Payment> getPayment(@PathVariable String id) {
    return reactivePaymentRepository.findById(UUID.fromString(id));
}
```

Detecting this problem: use BlockHound in tests:

```java
// BlockHound instruments JDK classes: on recent JDKs run tests with
// -XX:+AllowRedefinitionToAddDeleteMethods (see the BlockHound docs)
@SpringBootTest
class ReactiveBlockingDetectionTest {

    @BeforeAll
    static void installBlockHound() {
        BlockHound.install();
    }

    @Test
    void paymentServiceMustNotBlock() {
        // BlockHound throws BlockingOperationError if any blocking call
        // is made on a reactor thread during this test
        StepVerifier.create(paymentService.process(aPaymentRequest()))
            .expectNextCount(1)
            .verifyComplete();
    }
}
```

### Pitfall 2: Missing Backpressure on High-Volume Streams

Publishing events without backpressure to a slow consumer causes unbounded buffering.

```java
// RISKY — default concurrency: flatMap runs up to 256 calls at once
Flux<Payment> allPayments = paymentRepository.findAll();
allPayments
    .flatMap(payment -> expensiveProcessor.process(payment)) // may be slow
    .subscribe(result -> results.add(result));
// Reactor's flatMap does apply backpressure (it requests 256 upstream),
// but 256 concurrent calls can overwhelm expensiveProcessor or the service
// behind it. Unbounded buffering happens when a source IGNORES demand
// (e.g. Flux.create with BUFFER, below).

// CORRECT — bounded concurrency and limitRate
paymentRepository.findAll()
    .limitRate(200)       // request 200 items at a time from DB
    .flatMap(payment -> expensiveProcessor.process(payment),
             20)          // max 20 concurrent processing tasks
    .subscribe(
        result -> results.add(result),
        error -> log.error("Pipeline error", error),
        () -> log.info("Processing complete")
    );

// For streaming from Kafka or external sources, use Flux.create with
// a FluxSink.OverflowStrategy:
Flux<Payment> kafkaFlux = Flux.create(sink -> {
    kafkaConsumer.subscribe(records -> {
        records.forEach(record -> sink.next(toPayment(record)));
    });
}, FluxSink.OverflowStrategy.ERROR); // Throw if buffer overflows
// vs OverflowStrategy.DROP (drop new items)
// vs OverflowStrategy.LATEST (keep only latest)
// vs OverflowStrategy.BUFFER (unbounded — risky!)
```

### Pitfall 3: MDC Context Not Propagated — Silent Log Correlation Failure

Logs lose their correlation IDs in reactive pipelines, making production incident investigation nearly impossible.

```java
// WRONG — MDC.put on calling thread, lost on reactor threads
@PostMapping("/payments")
public Mono<PaymentResponse> submit(@RequestBody PaymentRequest request,
                                    @RequestHeader("X-Correlation-Id") String correlationId) {
    MDC.put("correlationId", correlationId);  // Set on HTTP thread

    return paymentService.process(request)
        .map(result -> {
            // Runs on reactor-http-nio-3 — MDC is EMPTY
            log.info("Payment processed"); // No correlationId in log output!
            return new PaymentResponse(result);
        });
    // MDC.remove() is never called — MDC leaks if thread is reused!
}

// CORRECT — contextWrite + doOnEach for MDC propagation
@PostMapping("/payments")
public Mono<PaymentResponse> submit(@RequestBody PaymentRequest request,
                                    @RequestHeader("X-Correlation-Id") String correlationId) {
    return paymentService.process(request)
        .map(result -> new PaymentResponse(result))
        .doOnEach(signal -> {
            if (!signal.isOnComplete() && !signal.isOnSubscribe()) {
                try (MDC.MDCCloseable ignored =
                        MDC.putCloseable("correlationId",
                            signal.getContextView().getOrDefault(
                                "correlationId", "unknown"))) {
                    // Log statements inside here have correlationId set
                }
            }
        })
        .contextWrite(Context.of("correlationId", correlationId));
}
```

---

## 12. Checklist

- [ ] No blocking calls (JDBC, synchronous RestTemplate, Thread.sleep) on reactor threads
- [ ] BlockHound installed in test suite to detect accidental blocking
- [ ] All blocking I/O wrapped with `.subscribeOn(Schedulers.boundedElastic())`
- [ ] `limitRate()` applied to any Flux that sources from a database or message queue
- [ ] `flatMap` concurrency parameter set explicitly (do not rely on default of 256)
- [ ] `bufferTimeout` or `window` used for batch DB inserts, not `flatMap` per item
- [ ] Per-element `onErrorResume` inside `flatMap` — naked errors terminate the whole Flux (avoid `onErrorContinue`)
- [ ] `retryWhen` with exponential backoff for transient failures, not bare `retry(3)`
- [ ] Reactor Context used for correlation ID and MDC propagation, not ThreadLocal
- [ ] Automatic context propagation enabled (`spring.reactor.context-propagation=auto`) for MDC
- [ ] R2DBC connection pool sized for the concurrent queries the database handles well — reactive saves threads, not connections
- [ ] Fraud-check fallbacks fail open only below a documented amount threshold
- [ ] `StepVerifier` used in all unit tests — do not block with `.block()` in tests

---

<!-- KNOWLEDGE-CHECK
{"questions": [{"text": "A Spring WebFlux service makes a JDBC call inside a Mono.fromCallable() without a subscribeOn(). What is the consequence?", "options": ["a) The Mono will fail with a BlockingNotPermittedException immediately", "b) The JDBC call executes on the event-loop thread, blocking it and starving all other concurrent requests on that thread", "c) Spring automatically detects the blocking call and offloads it to a thread pool", "d) The Mono will complete normally with slightly higher latency"], "correct": 1, "explanation": "Without subscribeOn(), Mono.fromCallable() executes its supplier on whatever thread subscribes to it — in WebFlux, this is the event-loop (Netty NIO) thread. JDBC is synchronous and blocks the thread until the query completes. During this time, the event-loop thread cannot process any other events, degrading throughput for ALL concurrent requests on that thread. subscribeOn(Schedulers.boundedElastic()) moves execution to a thread pool designed for blocking work."}, {"text": "Why does ThreadLocal-based MDC fail in a reactive pipeline, and what is the correct alternative?", "options": ["a) MDC is not thread-safe and should never be used in production", "b) Reactive operators can execute callbacks on different threads than the one that set the MDC context, so the ThreadLocal value is absent; use Reactor Context with contextWrite and doOnEach instead", "c) MDC requires a servlet container and is incompatible with Netty", "d) MDC works correctly but requires explicit MDC.clear() after each operator"], "correct": 1, "explanation": "MDC uses ThreadLocal to store key-value pairs. In a reactive pipeline, a single request is processed by callbacks that may execute on different threads (e.g., the HTTP thread, a scheduler thread, the DB callback thread). When execution moves to a new thread, the ThreadLocal is empty on that thread. Reactor's Context is a per-subscription immutable map that flows downstream through the operator chain regardless of thread switching. contextWrite() injects values, getContextView() reads them, and doOnEach() can bridge Context values to MDC for log statements."}, {"text": "In the benchmark scenario of 10,000 concurrent connections with 100ms I/O delay, what is the primary resource that blocking threading exhausts before reactive threading does?", "options": ["a) CPU cycles — blocking threads consume more CPU due to constant polling", "b) Network sockets — blocking I/O opens more sockets per request", "c) OS threads and their associated memory — each platform thread reserves a stack (~1MB by default) and must be scheduled by the OS", "d) Heap memory — reactive objects are more memory-efficient than thread stacks"], "correct": 2, "explanation": "Each platform thread reserves a stack (512KB to 1MB by default, committed as it is used) and kernel resources, and the OS must schedule every one of them. 10,000 blocking threads therefore cost a lot of memory and context switching — or, with a 200-thread pool, requests simply queue. A reactive service handling the same 10,000 concurrent connections uses a handful of event-loop threads (one per core) and relies on the OS's non-blocking I/O notifications. (Java 21 virtual threads are the other way out of this limit.)"}]}
-->

<!-- PRACTICAL-CHALLENGE
{"title":"Reactive Payment Pipeline with Backpressure and Context Propagation","difficulty":"advanced","estimatedMinutes":90,"tasks":[{"id":"1","description":"Build a Spring WebFlux payment API with two endpoints: POST /payments (returns Mono<PaymentResponse>) and GET /payments/stream/{accountId} (returns Flux<PaymentStatusUpdate> as text/event-stream). Use R2DBC with an in-memory H2 database. Confirm that the POST endpoint handles both ValidationException (400) and InsufficientFundsException (422) via onErrorResume without exposing stack traces. Write a WebTestClient integration test for each error case."},{"id":"2","description":"Implement a ReactivePaymentPipeline that accepts a Flux<PaymentRequest> and applies: (1) limitRate(50), (2) flatMap to a mock fraud check with max concurrency 10 and a 2-second timeout that defaults to allow on timeout, (3) filter for risk score < 0.7, (4) bufferTimeout(100, 50ms) for batch persistence. Install BlockHound and write a StepVerifier test proving no blocking call is made on the reactor thread during pipeline execution."},{"id":"3","description":"Demonstrate and fix the MDC propagation pitfall. First write a test showing that MDC.get('correlationId') returns null inside a map() operator when set on the calling thread. Then fix it using contextWrite(Context.of('correlationId', id)) and doOnEach with signal.getContextView(). Optionally enable automatic context propagation (spring.reactor.context-propagation=auto) and verify that the correlation ID appears in log output during the reactive pipeline execution."},{"id":"4","description":"Write a benchmark using JMH (or a simple timed loop) comparing throughput of: (a) a Spring MVC controller using JDBC with Thread.sleep(50) to simulate I/O, with a Tomcat thread pool of 50 threads; versus (b) a Spring WebFlux controller using Mono.delay(Duration.ofMillis(50)) with 8 event-loop threads. Run 500 concurrent virtual threads (or connections) for 30 seconds and record the requests/second and P99 latency for each. Document your findings in a comment explaining when each model is preferable."}]}
-->
