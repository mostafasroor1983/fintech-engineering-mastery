---
id: track-04-lesson-20
title: "Principal Engineer's Async Architecture Decision Framework"
slug: async-decision-framework
track: track-04
trackName: "Async & Reactive Systems"
sequence: 20
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, async, reactive, trade-offs, staff-engineer]
prerequisites: [track-04-lesson-12, track-04-lesson-19]
---

# Principal Engineer's Async Architecture Decision Framework

> [!NOTE]
> The question is never "is reactive better?" The question is "what does my workload look like at p99, and what is the cost of the operational complexity I am introducing?" The principal engineer's job is to match the tool to the problem, not to demonstrate mastery of the most sophisticated tool.

## The Decision Landscape

The async technology landscape for JVM-based financial services in 2024:

| Technology | Model | Best For | Avoid When |
|---|---|---|---|
| Spring MVC + threads | Blocking, synchronous | Low-to-medium concurrency, CRUD APIs | >500 concurrent requests, memory-sensitive |
| Spring WebFlux + Reactor | Non-blocking, reactive | High I/O concurrency, streaming | CPU-bound work, small teams new to reactive |
| CompletableFuture | Async, callback-based | Simple async composition, library code | Complex fan-out, error handling chains |
| Virtual Threads (Java 21+) | Blocking code, non-blocking runtime | Mixed workloads, brownfield migration | Libraries with `synchronized` on hot paths |
| Kotlin Coroutines | Suspended, sequential-looking | Kotlin codebases, team prefers imperative style | Java-only teams |

---

## Decision Framework: 5 Questions

Before choosing an async model, answer these five questions.

### Question 1: What is your concurrency profile?

Measure your production traffic — do not guess.

```java
// Diagnostic: measure concurrent requests in flight using Micrometer
@Component
public class ConcurrencyDiagnostics implements WebFilter {

    private final AtomicLong inFlightRequests = new AtomicLong();
    private final MeterRegistry meterRegistry;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        inFlightRequests.incrementAndGet();
        meterRegistry.gauge("http.requests.in_flight", inFlightRequests);

        return chain.filter(exchange)
            .doFinally(signal -> inFlightRequests.decrementAndGet());
    }
}

// If p95 of in_flight_requests < 100: Spring MVC is probably fine
// If p95 of in_flight_requests > 200: reactive starts to show advantages
// If p95 of in_flight_requests > 500: reactive is significantly better
```

**Rule of thumb**:
- Under 100 concurrent: Spring MVC is simpler and sufficiently performant
- 100–500 concurrent: Both work; prefer the one your team knows
- Over 500 concurrent: WebFlux is the defensible choice

### Question 2: What is your I/O-to-CPU ratio?

```java
// Profile a sample of requests to measure I/O vs CPU time
@Aspect
@Component
public class IoVsCpuProfiler {

    @Around("@annotation(ProfileIoCpu)")
    public Object profile(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.nanoTime();
        Object result = pjp.proceed();
        long totalNanos = System.nanoTime() - start;

        // Thread CPU time via ThreadMXBean
        ThreadMXBean threadMXBean = ManagementFactory.getThreadMXBean();
        long cpuNanos = threadMXBean.getCurrentThreadCpuTime();

        double ioRatio = 1.0 - ((double) cpuNanos / totalNanos);
        meterRegistry.gauge("request.io_ratio", ioRatio);

        // If ioRatio > 0.7: reactive is worth it
        // If ioRatio < 0.3: CPU-bound; reactive adds overhead
        return result;
    }
}
```

**Decision rule**:
- I/O ratio > 70%: Reactive excels — threads are mostly waiting
- I/O ratio 30–70%: Mixed; virtual threads are often the best fit
- I/O ratio < 30%: CPU-bound; use plain threads; reactive adds overhead without benefit

### Question 3: What are your latency SLAs?

```java
// Reactive is worth its complexity when tail latencies matter
// At high concurrency, MVC tail latency grows due to thread queue depth
// WebFlux tail latency stays flat because there is no blocking queue

public class SlaBasedDecision {

    public AsyncChoice recommend(LatencyRequirement requirement, int targetConcurrency) {
        boolean strictP99 = requirement.p99Millis() < 100;
        boolean strictP999 = requirement.p999Millis() < 500;
        boolean highConcurrency = targetConcurrency > 200;

        if (strictP99 && highConcurrency) {
            return AsyncChoice.WEBFLUX;         // only reactive can hit this at scale
        }
        if (strictP99 && !highConcurrency) {
            return AsyncChoice.EITHER;           // both can; choose by team familiarity
        }
        if (!strictP99 && highConcurrency) {
            return AsyncChoice.VIRTUAL_THREADS;  // simpler code, good enough latency
        }
        return AsyncChoice.SPRING_MVC;           // simplest, sufficient
    }
}
```

### Question 4: What is your team's reactive experience?

Reactive code has a steep learning curve. A team new to Reactor will introduce bugs:
- Missing `subscribeOn` for blocking calls → event loop starvation
- Missing `onErrorResume` → silent stream termination
- Incorrect `flatMap` concurrency → unbounded parallelism
- Missing backpressure → `OutOfMemoryError` on large datasets

```java
// Complexity indicator: measure how many operators a typical pipeline uses
// If your team writes code like this, they know what they are doing:
public Mono<PaymentResponse> processPayment(PaymentRequest request) {
    return validateRequest(request)
        .flatMap(validated -> Mono.zip(
            fraudService.check(validated).timeout(Duration.ofMillis(80)),
            riskService.score(validated).timeout(Duration.ofMillis(50))
        ))
        .flatMap(tuple -> {
            FraudResult fraud = tuple.getT1();
            RiskScore risk = tuple.getT2();
            if (fraud.blocked() || risk.isHigh()) {
                return declinePayment(request, fraud, risk);
            }
            return executePayment(request);
        })
        .retryWhen(Retry.backoff(2, Duration.ofMillis(100))
            .filter(ex -> ex instanceof TransientException))
        .onErrorMap(TimeoutException.class, ex ->
            new FraudServiceUnavailableException("Fraud check timed out"))
        .contextWrite(ctx -> ctx.put(TraceContext.class, currentTrace()));
}

// If your team struggles to read this code during code review,
// the operational cost of reactive may outweigh its performance benefit.
```

### Question 5: What does your database layer look like?

```java
// If your data layer is JDBC (most legacy systems), you have three options:

// Option A: Wrap in boundedElastic — works, but wastes the reactive advantage
public Mono<Account> findAccount(String accountId) {
    return Mono.fromCallable(() -> jdbcTemplate.queryForObject(...))
        .subscribeOn(Schedulers.boundedElastic()); // thread blocking preserved
}

// Option B: Migrate to R2DBC — full reactive stack, significant migration effort
public Mono<Account> findAccount(String accountId) {
    return r2dbcTemplate.selectOne(
        Query.query(Criteria.where("id").is(accountId)), Account.class
    ); // truly non-blocking
}

// Option C: Use Virtual Threads — JDBC code unchanged, platform threads freed
// Spring Boot 3.2+ with Java 21: set spring.threads.virtual.enabled=true
// JDBC code remains blocking but VTs are cheap enough that it rarely matters
// This is often the best brownfield migration path
```

---

## CompletableFuture vs Reactor vs Virtual Threads: Decision Matrix

```java
// Use CompletableFuture when:
// - You need to call 2-3 async operations and combine results
// - You are writing a library used by both blocking and reactive callers
// - Your team is familiar with futures but not Reactor
public CompletableFuture<PaymentDecision> evaluateAsync(Payment payment) {
    CompletableFuture<FraudResult> fraudFuture =
        CompletableFuture.supplyAsync(() -> fraudService.check(payment), executor);
    CompletableFuture<RiskScore> riskFuture =
        CompletableFuture.supplyAsync(() -> riskService.score(payment), executor);

    return fraudFuture.thenCombine(riskFuture,
        (fraud, risk) -> PaymentDecision.evaluate(fraud, risk)
    );
}

// Use Reactor (WebFlux) when:
// - You need backpressure (streaming large datasets to clients)
// - Concurrency > 200 with strict latency SLAs
// - You need non-blocking Kafka consumption (reactor-kafka)
// - Full reactive stack available (R2DBC, WebClient)
public Mono<PaymentDecision> evaluateReactive(Payment payment) {
    return Mono.zip(
        fraudService.checkReactive(payment),
        riskService.scoreReactive(payment)
    ).map(tuple -> PaymentDecision.evaluate(tuple.getT1(), tuple.getT2()));
}

// Use Virtual Threads (Java 21+) when:
// - Brownfield codebase: cannot migrate to R2DBC yet
// - Mixed I/O and CPU workloads
// - Team is productive with blocking code
// - You want MVC-style code with reactive-equivalent throughput
@Bean
public TomcatProtocolHandlerCustomizer<?> protocolHandlerVirtualThreadExecutorCustomizer() {
    return protocolHandler ->
        protocolHandler.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
}
```

---

## Backpressure Strategy Selection

```java
// When does your system need backpressure?
// - Producing data faster than the consumer can process
// - Streaming large result sets from database to client
// - Processing Kafka partitions with variable lag

public class BackpressureStrategyGuide {

    // Strategy 1: Buffer (default) — risky for large datasets
    public Flux<PaymentRecord> streamPaymentsBuffered(String customerId) {
        return paymentRepository.findAllByCustomerId(customerId)
            .onBackpressureBuffer(1000, // limit buffer size
                overflow -> log.warn("Backpressure buffer overflow for customer={}", customerId),
                BufferOverflowStrategy.DROP_OLDEST
            );
    }

    // Strategy 2: Drop — for real-time metrics, non-critical events
    public Flux<PriceUpdate> streamPriceUpdates() {
        return pricePublisher.asFlux()
            .onBackpressureDrop(dropped ->
                log.debug("Price update dropped due to slow consumer: {}", dropped)
            );
    }

    // Strategy 3: Error — fail fast when consumer is too slow
    public Flux<AuditEvent> streamAuditEvents() {
        return auditEventSource.asFlux()
            .onBackpressureError(); // throws OverflowException if downstream is slow
                                    // correct for audit events: none can be dropped
    }

    // Strategy 4: Proper subscriber-driven pull — the correct reactive model
    public Flux<Transaction> streamTransactions(String accountId, int pageSize) {
        return Flux.create(sink -> {
            Subscription subscription = new Subscription() {
                private long offset = 0;
                @Override public void request(long n) {
                    transactionRepository.findPage(accountId, offset, n)
                        .doOnNext(tx -> { sink.next(tx); offset++; })
                        .doOnComplete(() -> { if (/* no more */ false) sink.complete(); })
                        .subscribe();
                }
                @Override public void cancel() { sink.complete(); }
            };
            sink.onRequest(n -> subscription.request(n));
        }, FluxSink.OverflowStrategy.ERROR);
    }
}
```

---

## Testing Complexity Trade-offs

One of the most underestimated costs of reactive is testing complexity.

```java
// Blocking test — simple, familiar, debuggable
@Test
void blockingTest() {
    PaymentResponse response = paymentService.processPayment(request);
    assertThat(response.status()).isEqualTo(COMPLETED);
    // Single-threaded, sequential, stack trace is clear
}

// Reactive test — requires StepVerifier, timing awareness, context propagation
@Test
void reactiveTest() {
    StepVerifier.create(paymentService.processPaymentReactive(request))
        .assertNext(response -> assertThat(response.status()).isEqualTo(COMPLETED))
        .verifyComplete();
    // Error messages are obscure without ReactorDebugAgent
    // Test failures may be non-deterministic without scheduler control
}

// Reactive test with virtual time — for timeout/retry tests
@Test
void retryTest() {
    StepVerifier.withVirtualTime(() ->
            paymentService.processPaymentWithRetry(failingRequest)
        )
        .expectSubscription()
        .thenAwait(Duration.ofSeconds(1)) // first retry after 1s
        .thenAwait(Duration.ofSeconds(2)) // second retry after 2s
        .assertNext(response -> assertThat(response.status()).isEqualTo(FAILED_AFTER_RETRY))
        .verifyComplete();
    // Virtual time control works because Schedulers.boundedElastic is replaced
    // by VirtualTimeScheduler — but only if you used Schedulers correctly
}

// Cost assessment: reactive tests take 2-3x longer to write
// and debugging test failures is significantly harder
// Factor this into your team capacity planning
```

---

## Migration Decision: When to Migrate Blocking to Reactive

```java
// Migration readiness checklist
public class MigrationReadinessAssessment {

    public MigrationRecommendation assess(ServiceProfile profile) {
        int score = 0;
        List<String> blockers = new ArrayList<>();
        List<String> enablers = new ArrayList<>();

        // Check 1: Concurrency
        if (profile.p95ConcurrentRequests() > 200) {
            score += 3;
            enablers.add("High concurrency (%d req) will benefit from reactive".formatted(
                profile.p95ConcurrentRequests()));
        } else {
            blockers.add("Low concurrency — reactive overhead not justified");
        }

        // Check 2: Database layer
        if (profile.usesR2dbcOrMongo()) {
            score += 2;
            enablers.add("Non-blocking database layer available");
        } else {
            blockers.add("JDBC-only — must migrate to R2DBC or use Virtual Threads instead");
        }

        // Check 3: Team experience
        if (profile.teamHasReactorExperience()) {
            score += 2;
            enablers.add("Team has Reactor experience");
        } else {
            blockers.add("Team reactive experience: 2-4 months training required");
            score -= 1;
        }

        // Check 4: Latency SLA
        if (profile.p99SlaMillis() < 50) {
            score += 2;
            enablers.add("Strict p99 SLA (%dms) requires reactive to avoid thread queue depth"
                .formatted(profile.p99SlaMillis()));
        }

        // Check 5: I/O ratio
        if (profile.averageIoRatio() > 0.7) {
            score += 2;
            enablers.add("High I/O ratio (%.0f%%) — threads mostly idle".formatted(
                profile.averageIoRatio() * 100));
        }

        return new MigrationRecommendation(
            score >= 6 ? Recommendation.MIGRATE_REACTIVE :
            score >= 4 ? Recommendation.CONSIDER_VIRTUAL_THREADS :
                         Recommendation.STAY_BLOCKING,
            enablers,
            blockers
        );
    }
}
```

---

## The Principal Engineer Checklist

Before committing your team to a reactive architecture decision, verify:

**Performance**
- [ ] Benchmarked under production-equivalent load, not just localhost
- [ ] Measured p99 and p999 latency, not just throughput
- [ ] Profiled thread count and heap usage under sustained load
- [ ] Identified all blocking I/O calls and confirmed they are wrapped in `boundedElastic`

**Correctness**
- [ ] All `flatMap` calls have concurrency limits where needed
- [ ] All `Flux` streams have backpressure strategy defined
- [ ] All saga/idempotency logic handles cancellation signals
- [ ] `Context` propagation tested for trace ID and security context

**Operability**
- [ ] ReactorDebugAgent enabled in development, disabled in production
- [ ] All reactive pipelines have `.name().metrics()` for Micrometer
- [ ] On-call team can read and debug reactive stack traces
- [ ] Runbook includes guidance on identifying stuck pipelines

**Team**
- [ ] Team has completed Reactor training (minimum Lessons 01–11 of this track)
- [ ] Code review checklist includes reactive-specific anti-patterns
- [ ] At least one team member can explain backpressure in an incident call

---

## Final Recommendation by Use Case

```
PAYMENT PROCESSING API (high concurrency, strict latency)
→ WebFlux + R2DBC + reactor-kafka
→ Concurrency: event loop, no thread pool tuning needed
→ Complexity justified by business requirement

INTERNAL ADMIN TOOL (low concurrency, CRUD)
→ Spring MVC + JDBC
→ No reactive needed; simple, maintainable
→ Migrate never unless traffic grows significantly

BATCH PROCESSING JOB (large data, low latency pressure)
→ Spring Batch + Virtual Threads (Java 21)
→ Blocking code, VTs handle concurrency at I/O
→ Readable, testable, good enough

REAL-TIME NOTIFICATION SERVICE (streaming, fan-out)
→ WebFlux + SSE or WebSocket + reactor-kafka
→ Flux with backpressure handles subscriber variability
→ Reactive is the natural fit for streaming

LEGACY MONOLITH MIGRATION (brownfield, 10-year codebase)
→ Virtual Threads first, reactive second
→ Enable VTs with one config flag; no code changes
→ Measure improvement; then evaluate full reactive migration
```

---

## Production Considerations

**The reactive tax**: Reactive code has a maintenance tax — it is harder to read, harder to debug, and harder to hire for. This tax is worth paying when the performance benefit is quantifiable and significant. It is not worth paying for a service that handles 20 req/s.

**Don't mix models in one service**: A service that is 50% WebFlux and 50% blocking Spring MVC is worse than either alone. It confuses developers, splits tracing context, and delivers neither the simplicity of MVC nor the efficiency of WebFlux. Decide once per service boundary.

**Greenfield vs brownfield**: For greenfield services targeting high concurrency, start with WebFlux. For brownfield, prefer Virtual Threads (Java 21) as a first step — zero code change, meaningful throughput improvement, and no learning curve.

**Organisational readiness**: The hardest part of reactive adoption is not the technology — it is the incident response. At 3 AM, the on-call engineer must understand operator fusion, scheduler switching, and context propagation errors. Train before you go to production.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "According to the async decision framework, what is the first diagnostic question before choosing an async model?",
      "options": ["What programming language does the team prefer?", "What is your concurrency profile — how many concurrent requests are in-flight at p99?", "Does the team have reactive programming experience?", "What database does the service use?"],
      "correct": 1,
      "explanation": "The concurrency profile is the first and most important diagnostic because the choice between blocking, virtual threads, and reactive depends entirely on how many requests are simultaneously waiting for I/O. Low concurrency services do not benefit from reactive complexity; high concurrency services need it."
    },
    {
      "text": "What is the recommended approach for a brownfield Java service migration to improve concurrency scaling, according to the framework?",
      "options": ["Rewrite the service in Spring WebFlux immediately", "Enable virtual threads first (spring.threads.virtual.enabled=true in Spring Boot 3.2+) — zero code change, meaningful throughput improvement, and no learning curve", "Migrate to Kotlin Coroutines for a gradual transition", "Replace JDBC with R2DBC before changing the threading model"],
      "correct": 1,
      "explanation": "For brownfield services, virtual threads are the lowest-risk first step: enable them with a configuration flag, run a benchmark, and validate the improvement. Rewriting in WebFlux or Kotlin Coroutines requires significant code changes, testing, and team training. Start with the simplest option that meets the requirement."
    },
    {
      "text": "Why is CompletableFuture described as inappropriate for complex fan-out payment pipelines?",
      "options": ["CompletableFuture does not support timeouts", "CompletableFuture error handling chains and complex fan-out (multiple parallel calls with join logic) become deeply nested and difficult to reason about; Reactor's operator model expresses these patterns more clearly and composably", "CompletableFuture is deprecated in Java 21", "CompletableFuture does not propagate backpressure"],
      "correct": 1,
      "explanation": "CompletableFuture works well for simple async composition (2-3 chained calls), but complex fan-out (5 parallel enrichment calls, error handling, timeout, fallback, retry) results in deeply nested callback chains. Reactor's flatMap, zip, onErrorResume, and retry operators express these same patterns declaratively and readably."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Async Architecture Decision for a High-Concurrency Payment Enrichment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Instrument a production-like payment service with the ConcurrencyDiagnostics WebFilter from the lesson. Run a Gatling load test and capture the p50, p95, and p99 concurrent request counts. Use these measurements to classify the workload against the framework's concurrency thresholds and determine the recommended async model."},
    {"id": "2", "description": "Build the same payment enrichment logic (account lookup + fraud check + FX rate) using three different async models: (a) CompletableFuture.allOf(), (b) Mono.zip() with WebFlux, (c) structured concurrency with Java 21 StructuredTaskScope. Measure lines of code, cyclomatic complexity, and p99 latency for each. Document readability and debugging differences."},
    {"id": "3", "description": "Write an Architecture Decision Record (ADR) for a new payments enrichment microservice: apply all five framework questions, evaluate the top 2 candidate technologies, state the decision, and document the decision reversibility risk. Include a concrete migration path if the initial choice proves wrong in 12 months."},
    {"id": "4", "description": "Build a team readiness assessment: create 5 reactive debugging exercises (blocked event loop, missing contextWrite, forgotten verify(), missing acknowledge(), pinned virtual thread) and have team members diagnose each from stack traces and logs only. Record time-to-diagnosis for each exercise. Use results to identify training gaps before going to production."}
  ]
}
-->

---
