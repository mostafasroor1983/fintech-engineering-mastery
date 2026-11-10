---
id: track-09-lesson-20
title: "Reactive vs Blocking — Performance Profile Comparison"
slug: reactive-vs-blocking-perf
track: track-09
trackName: "Performance Engineering"
sequence: 20
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [reactive, blocking, throughput, latency, JMH]
prerequisites: [track-09-lesson-04]
---

# Reactive vs Blocking — Performance Profile Comparison

> [!NOTE]
> The question is not "which is faster?" — it is "which model performs better under your specific concurrency and latency constraints?" Reactive programming is not universally superior. For CPU-bound payment calculations or low-concurrency batch processing, traditional blocking code with virtual threads often delivers better performance with dramatically less complexity.

## 1. The Core Tradeoff

### Blocking (Thread-Per-Request) Model

Each incoming request occupies one OS thread for its entire duration. If the thread is waiting for a database response, it blocks — doing nothing but consuming a stack (~1MB per thread on the JVM).

```
Thread-1 [REQUEST_1]: ----DB_WAIT(50ms)----PROCESS(5ms)----RESPOND
Thread-2 [REQUEST_2]: ----DB_WAIT(50ms)----PROCESS(5ms)----RESPOND
Thread-3 [REQUEST_3]: ----DB_WAIT(50ms)----PROCESS(5ms)----RESPOND
```

Maximum throughput ≈ `threadPoolSize / (averageLatency_seconds)`.
With 200 threads and 50ms average latency: 200 / 0.055 ≈ 3,636 requests/sec.

### Reactive (Event-Loop) Model

A small number of event-loop threads handle many concurrent requests. When a request is waiting for I/O, the thread is released to serve other requests.

```
EventLoop-1: [req1_start]--[req1_io_start]--[req2_start]--[req1_io_end]--[req1_process]
                                            [req2_io_start]              [req2_io_end]
```

The same 4 event-loop threads can handle thousands of concurrent requests because they never block.

## 2. JMH Benchmarks — WebFlux vs Spring MVC

### Benchmark Setup

```java
@SpringBootApplication
public class BenchmarkApplication {
    public static void main(String[] args) {
        SpringApplication.run(BenchmarkApplication.class, args);
    }
}

// Blocking endpoint (Spring MVC)
@RestController
@RequestMapping("/blocking")
public class BlockingPaymentController {

    private final BlockingPaymentService service;

    @GetMapping("/balance/{accountId}")
    public ResponseEntity<BalanceResponse> getBalance(@PathVariable UUID accountId) {
        // Simulates DB query: 50ms latency
        BalanceResponse balance = service.getBalance(accountId);
        return ResponseEntity.ok(balance);
    }
}

// Reactive endpoint (WebFlux)
@RestController
@RequestMapping("/reactive")
public class ReactivePaymentController {

    private final ReactivePaymentService service;

    @GetMapping("/balance/{accountId}")
    public Mono<ResponseEntity<BalanceResponse>> getBalance(@PathVariable UUID accountId) {
        return service.getBalance(accountId)
            .map(ResponseEntity::ok);
    }
}
```

### JMH Benchmark Class

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@State(Scope.Thread)
@Fork(2)
@Warmup(iterations = 3, time = 10)
@Measurement(iterations = 5, time = 30)
public class ReactiveVsBlockingBenchmark {

    private WebTestClient blockingClient;
    private WebTestClient reactiveClient;

    @Setup
    public void setup() {
        blockingClient = WebTestClient
            .bindToServer()
            .baseUrl("http://localhost:8080/blocking")
            .build();

        reactiveClient = WebTestClient
            .bindToServer()
            .baseUrl("http://localhost:8080/reactive")
            .build();
    }

    @Benchmark
    public String blockingBalance() {
        return blockingClient.get()
            .uri("/balance/{id}", UUID.randomUUID())
            .exchange()
            .returnResult(String.class)
            .getResponseBody()
            .blockFirst();
    }

    @Benchmark
    public String reactiveBalance() {
        return reactiveClient.get()
            .uri("/balance/{id}", UUID.randomUUID())
            .exchange()
            .returnResult(String.class)
            .getResponseBody()
            .blockFirst();
    }
}
```

### Gatling Load Test for Concurrency Comparison

```scala
// Gatling simulation comparing both endpoints
class ReactiveVsBlockingSimulation extends Simulation {

  val httpProtocol = http.baseUrl("http://localhost:8080")

  // Scenario: balance check
  val balanceCheck = scenario("Balance Check")
    .exec(http("balance").get("/blocking/balance/" + UUID.randomUUID()))

  val reactiveBalanceCheck = scenario("Reactive Balance Check")
    .exec(http("reactive_balance").get("/reactive/balance/" + UUID.randomUUID()))

  setUp(
    // 100 concurrent users
    balanceCheck.inject(constantConcurrentUsers(100).during(60.seconds))
      .protocols(httpProtocol),

    // 1000 concurrent users
    reactiveBalanceCheck.inject(constantConcurrentUsers(1000).during(60.seconds))
      .protocols(httpProtocol)
  )
}
```

## 3. Throughput Curves — Where Reactive Wins

### Benchmark Results (Simulated, 50ms DB latency, 4-core machine)

| Concurrent Users | Spring MVC (TPS) | WebFlux (TPS) | Winner |
|---|---|---|---|
| 10 | 182 | 174 | MVC (less overhead) |
| 50 | 820 | 870 | WebFlux (slight) |
| 100 | 1,636 | 1,890 | WebFlux |
| 500 | 1,980 | 8,920 | WebFlux (clear) |
| 1,000 | 2,100 | 17,650 | WebFlux (dominant) |
| 5,000 | Thread exhaustion | 18,200 | WebFlux (MVC fails) |
| 10,000 | Thread exhaustion | 17,800 | WebFlux only viable |

**Key observation**: Spring MVC hits its thread pool ceiling around 200–400 concurrent users (default `server.tomcat.threads.max=200`). WebFlux continues to scale because it uses non-blocking I/O.

```java
// Spring MVC: configure thread pool for maximum blocking capacity
@Configuration
public class TomcatConfig {
    @Bean
    public TomcatServletWebServerFactory tomcat() {
        TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory();
        factory.addConnectorCustomizers(connector -> {
            ProtocolHandler handler = connector.getProtocolHandler();
            if (handler instanceof AbstractHttp11Protocol<?> http11) {
                http11.setMaxThreads(400);       // max concurrent requests
                http11.setMinSpareThreads(50);   // keep warm threads
                http11.setAcceptCount(200);       // queue before rejection
            }
        });
        return factory;
    }
}
```

## 4. Latency at p50/p95/p99 — Where Blocking Wins

At low concurrency, blocking code often has better latency because:
- No reactive operator overhead (map, flatMap, subscribeOn)
- No context switching between event loop and worker threads
- Simpler code path, fewer allocations

### p50/p95/p99 Comparison (50 concurrent users, 50ms DB latency)

| Percentile | Spring MVC | WebFlux | Difference |
|---|---|---|---|
| p50 | 51 ms | 53 ms | +4% (WebFlux worse) |
| p95 | 68 ms | 74 ms | +9% (WebFlux worse) |
| p99 | 95 ms | 112 ms | +18% (WebFlux worse) |
| p99.9 | 180 ms | 155 ms | -14% (WebFlux better) |

At low concurrency, blocking code is often faster at the low percentiles because the reactive pipeline adds overhead. At the high percentiles (p99.9+), reactive wins because it doesn't have thread scheduling jitter from a saturated thread pool.

```java
// Measuring latency with Micrometer
@Component
public class LatencyTracker {

    private final MeterRegistry registry;

    public <T> T trackLatency(String operation, Supplier<T> action) {
        return Timer.builder("payment.operation.latency")
            .tag("operation", operation)
            .publishPercentiles(0.5, 0.95, 0.99, 0.999)
            .publishPercentileHistogram()
            .sla(Duration.ofMillis(100), Duration.ofMillis(500))
            .register(registry)
            .record(action);
    }

    public <T> Mono<T> trackReactiveLatency(String operation, Mono<T> mono) {
        return Mono.defer(() -> {
            long start = System.nanoTime();
            return mono.doOnTerminate(() -> {
                long elapsed = System.nanoTime() - start;
                registry.timer("payment.operation.latency",
                    "operation", operation,
                    "model", "reactive")
                    .record(elapsed, TimeUnit.NANOSECONDS);
            });
        });
    }
}
```

## 5. GC Pressure — Reactive Generates More Objects

Reactive pipelines create many short-lived objects (Mono wrappers, operator instances, subscription chains). This increases GC pressure compared to blocking code.

```java
// Measure GC allocation rate with JMH
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
public class AllocationBenchmark {

    // Blocking: direct object creation
    @Benchmark
    public BalanceResponse blockingBalance(BlockingService service) {
        return service.getBalance(UUID.randomUUID());
    }

    // Reactive: Mono wrapper + operators + subscription
    @Benchmark
    public BalanceResponse reactiveBalance(ReactiveService service) {
        return service.getBalance(UUID.randomUUID()).block();
    }
}

// JMH output with -prof gc:
// Blocking:
//   gc.alloc.rate:  128.3 MB/s
//   gc.count:       12.1 per second

// Reactive:
//   gc.alloc.rate:  347.8 MB/s  (+170%)
//   gc.count:       31.4 per second (+160%)
```

### Mitigating Reactive GC Pressure

```java
// 1. Reuse operators where possible — avoid creating new Mono on every request
private static final Function<BigDecimal, BalanceResponse> BALANCE_MAPPER =
    amount -> new BalanceResponse(amount, "USD");

// WRONG: creates new lambda instance on every invocation
public Mono<BalanceResponse> getBalance(UUID id) {
    return repository.findById(id)
        .map(a -> new BalanceResponse(a.getBalance(), a.getCurrency())); // new lambda
}

// BETTER: reuse static mapper (fewer allocations)
public Mono<BalanceResponse> getBalance(UUID id) {
    return repository.findById(id).map(BALANCE_MAPPER);
}

// 2. Use cache() for shared Monos to avoid repeated subscriptions
private final Mono<ExchangeRateTable> exchangeRatesMono =
    rateRepository.loadAll()
        .cache(Duration.ofSeconds(60));  // cache the result, not just the Mono

// 3. Use Flux.fromIterable() instead of multiple Mono.just() wrappings
public Flux<Transaction> getBatch(List<UUID> ids) {
    return Flux.fromIterable(ids)
        .flatMap(repository::findById, 10);  // concurrency = 10
}
```

## 6. Thread Count and CPU Utilization

```java
// Spring MVC: 200 threads * 1MB stack = 200MB just for thread stacks
// Under load, OS spends time scheduling/context-switching between threads

// WebFlux: 2*CPUs event loop threads + small worker pool
// At 10K concurrency, WebFlux uses ~10 threads vs MVC's 200+

@Configuration
public class WebFluxConfig implements WebFluxConfigurer {

    @Bean
    public ReactorResourceFactory reactorResourceFactory() {
        ReactorResourceFactory factory = new ReactorResourceFactory();
        factory.setUseGlobalResources(false);
        factory.setLoopResources(
            LoopResources.create("payment-event-loop",
                2,       // selector threads
                Runtime.getRuntime().availableProcessors() * 2, // worker threads
                true)
        );
        return factory;
    }
}
```

### Thread Dump Comparison Under Load

At 1,000 concurrent users:

```
# Spring MVC: thread dump shows 200+ threads in WAITING state
"http-nio-8080-exec-1" #25 prio=5 os_prio=0 cpu=0.12ms elapsed=45.23s tid=...
   java.lang.Thread.State: WAITING (parking)
   at ... LockSupport.park(...)
   at ... AbstractQueuedSynchronizer.parkAndCheckInterrupt(...)
-- (200 more similar lines)

# WebFlux: 8 threads handling all 1000 requests
"payment-event-loop-1" #17 prio=5 os_prio=0 cpu=12,345.67ms elapsed=45.23s
"payment-event-loop-2" #18 prio=5 os_prio=0 cpu=11,987.34ms elapsed=45.23s
-- (6 more event loop threads, all RUNNABLE)
```

## 7. When Blocking Outperforms Reactive — CPU-Bound Work

For CPU-intensive operations, reactive provides no advantage and adds overhead.

```java
// CPU-bound: fraud scoring (ML model evaluation)
// Runs for 10ms of pure computation — no I/O waiting
@Service
public class FraudScoringService {

    // Blocking: straightforward, no overhead
    public FraudScore scoreBlocking(Transaction txn) {
        // 10ms of CPU computation (feature extraction, model inference)
        return fraudModel.evaluate(extractFeatures(txn));
    }

    // Reactive: adds operator overhead without benefit
    // The Mono.fromCallable() subscribes on a scheduler anyway (blocking!),
    // so there's zero benefit over just calling scoreBlocking()
    public Mono<FraudScore> scoreReactive(Transaction txn) {
        return Mono.fromCallable(() -> fraudModel.evaluate(extractFeatures(txn)))
            .subscribeOn(Schedulers.boundedElastic()); // blocks a thread anyway!
    }
}

// Rule: reactive is only beneficial when the work is I/O-bound.
// CPU-bound work ALWAYS occupies a thread.
// Using reactive for CPU-bound work adds complexity with no throughput gain.
```

### Payment Processing Pipeline — CPU vs I/O Mix

```java
@Service
public class PaymentProcessor {

    // This pipeline has mixed CPU + I/O work:
    // - Validation (CPU, ~0.1ms)
    // - Fraud check (I/O to ML service, ~20ms)
    // - Balance check (I/O to DB, ~5ms)
    // - Risk scoring (CPU, ~5ms)
    // - Write to DB (I/O, ~10ms)
    // Total: ~40ms, 35ms is I/O -> reactive is beneficial

    public Mono<PaymentResult> processPayment(PaymentRequest request) {
        return Mono.just(request)
            .map(this::validate)                    // CPU: synchronous OK
            .flatMap(fraudService::checkAsync)      // I/O: non-blocking
            .flatMap(balanceService::checkAsync)    // I/O: non-blocking
            .map(this::applyRiskScore)              // CPU: synchronous OK
            .flatMap(transactionRepo::saveAsync);   // I/O: non-blocking
    }

    // WARNING: never call blocking code inside a reactive pipeline without publishOn
    public Mono<PaymentResult> WRONG_processPayment(PaymentRequest request) {
        return Mono.just(request)
            .map(r -> {
                FraudScore score = fraudService.checkSync(r); // BLOCKS event loop!
                return r;
            });
    }
}
```

## 8. Memory Per Concurrent Request

```
# Blocking model (Spring MVC)
Per request memory:
  Thread stack:    1 MB (default -Xss1m)
  Request object:  ~8 KB
  Response buffer: ~8 KB
  Total per request: ~1 MB

At 1000 concurrent users:
  Thread stacks alone: 1000 * 1MB = 1 GB

# Reactive model (WebFlux)
Per request memory:
  Subscription chain: ~4 KB
  Buffer:             ~8 KB
  Total per request:  ~12 KB

At 1000 concurrent users:
  Total: 1000 * 12KB = 12 MB
  Savings: ~98% less memory per concurrent request
```

## 9. Virtual Threads — The Blocking-Reactive Bridge

Java 21 Virtual Threads (Project Loom) allow blocking code to achieve reactive-like thread efficiency.

```java
// Virtual threads: blocking code, non-blocking OS threads
@Configuration
@ConditionalOnJava("21")
public class VirtualThreadConfig {

    @Bean
    public TomcatProtocolHandlerCustomizer<?> virtualThreadsCustomizer() {
        return protocolHandler ->
            protocolHandler.setExecutor(
                Executors.newVirtualThreadPerTaskExecutor()
            );
    }
}

// Now Spring MVC endpoint runs on a virtual thread:
@GetMapping("/balance/{accountId}")
public BalanceResponse getBalance(@PathVariable UUID accountId) {
    // This blocks the virtual thread (not an OS thread)
    // Virtual thread is parked cheaply while waiting for DB
    return service.getBalance(accountId);  // blocks virtually, not OS-thread
}
```

### Virtual Threads vs WebFlux Benchmark

| Concurrent Users | WebFlux (TPS) | Virtual Threads (TPS) | Winner |
|---|---|---|---|
| 100 | 1,890 | 1,820 | WebFlux (slight) |
| 1,000 | 17,650 | 16,890 | WebFlux (marginal) |
| 5,000 | 18,200 | 17,500 | WebFlux (marginal) |
| 10,000 | 17,800 | 16,900 | WebFlux (marginal) |

**At Java 21+, virtual threads largely close the gap between blocking and reactive** for I/O-bound workloads. The choice often becomes a code complexity question rather than a pure performance question.

## 10. Decision Framework

```java
/**
 * When to choose each model:
 *
 * SPRING MVC (Blocking) + Virtual Threads:
 *   - Team is unfamiliar with reactive programming
 *   - Primarily JDBC (blocking) database access
 *   - Business logic is complex (reactive complexity hurts maintainability)
 *   - CPU-bound workloads dominate
 *   - < 500 concurrent users sustained (thread model sufficient)
 *
 * SPRING WEBFLUX (Reactive):
 *   - High concurrency (> 1,000 sustained)
 *   - Many external service calls (HTTP, messaging)
 *   - Team is experienced with reactive patterns
 *   - Using R2DBC (non-blocking database driver)
 *   - Streaming responses (SSE, large datasets)
 *   - Memory is constrained (embedded, edge deployments)
 *
 * NEVER use reactive when:
 *   - You have blocking DB calls without wrapping them properly
 *   - Team doesn't understand Scheduler/publishOn/subscribeOn
 *   - Business logic requires complex state management
 *   - CPU-bound computations dominate the response time
 */
```

## 11. Detecting Blocking Calls in Reactive Pipelines

```java
// BlockHound: catches blocking calls in reactive pipelines in development
@SpringBootTest
class ReactiveServiceTest {

    @BeforeAll
    static void setupBlockHound() {
        BlockHound.install();  // throws when blocking call detected on event loop
    }

    @Test
    void paymentProcessorShouldNotBlock() {
        // If processPayment() makes a blocking call, BlockHound throws:
        // BlockingOperationError: Blocking call! java.lang.Thread.sleep
        StepVerifier.create(paymentProcessor.processPayment(testRequest))
            .expectNextMatches(result -> result.isSuccess())
            .verifyComplete();
    }
}

// In production, use Reactor's debug mode for diagnosing issues
Hooks.onOperatorDebug();  // enables assembly time debugging (expensive)
// Better: use ReactorDebugAgent in development, not production
ReactorDebugAgent.init();
```

> [!WARNING]
> The most dangerous anti-pattern in reactive systems is making a blocking database call inside a reactive operator without `publishOn(Schedulers.boundedElastic())`. This blocks the event loop thread, starving all other requests processed by that thread. A single misconfigured service call can reduce throughput by 10x. Use BlockHound in CI to catch this class of bug before it reaches production.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the primary throughput advantage of reactive (WebFlux + R2DBC) over blocking (MVC + JDBC) for I/O-bound payment services?",
      "options": [
        "Reactive uses less heap memory per request, allowing more concurrent requests",
        "Reactive uses a small event loop thread pool for all requests; threads never block on I/O, so a few threads can handle thousands of concurrent requests where blocking requires one thread per concurrent I/O operation",
        "Reactive automatically partitions work across CPU cores more efficiently than thread pools",
        "Reactive eliminates garbage collection overhead by reusing response objects"
      ],
      "correct": 1,
      "explanation": "Blocking I/O requires a dedicated thread to wait while the DB responds. At 1000 concurrent DB queries, you need 1000 threads. Reactive I/O registers a callback and releases the thread immediately; a small event loop (typically 2x CPU cores) handles all concurrent requests via event-driven callbacks. The throughput advantage is greatest when requests are I/O-heavy with low CPU work."
    },
    {
      "text": "What does BlockHound detect and why is it important to run it in CI for a reactive payment service?",
      "options": [
        "BlockHound detects memory leaks caused by blocking data structures in reactive pipelines",
        "BlockHound detects when a blocking call (Thread.sleep, JDBC query, synchronized block) is made on a reactive event loop thread, throwing an error immediately rather than allowing the event loop to silently starve",
        "BlockHound monitors connection pool exhaustion in R2DBC drivers",
        "BlockHound enforces compile-time checks that all reactive operators are non-blocking"
      ],
      "correct": 1,
      "explanation": "A blocking call on an event loop thread (e.g., a JDBC call inside a Mono.map()) blocks the entire event loop, starving all requests multiplexed on that thread. The symptom (high latency, low throughput) is not obviously connected to the root cause. BlockHound installs a JVM agent that immediately throws BlockingOperationError when a blocking call is detected on a non-blocking thread, making these bugs obvious in development and CI."
    },
    {
      "text": "When is a blocking Spring MVC + JDBC architecture preferable to reactive WebFlux + R2DBC for a payment service?",
      "options": [
        "Blocking is always preferable because it is simpler and reactive provides no measurable benefit",
        "When the team lacks reactive programming expertise, the service has CPU-intensive work (ML fraud scoring), or the latency requirements are modest (> 100ms SLO) — the complexity cost of reactive exceeds its benefit in these cases",
        "When the service needs to handle more than 10,000 TPS; reactive cannot scale beyond this",
        "Blocking is preferable only for batch services; all real-time services should use reactive"
      ],
      "correct": 1,
      "explanation": "Reactive programming has real costs: harder to debug, different error handling mental model, incompatible with many synchronous libraries. If the team is not proficient with reactive, bugs multiply. For CPU-bound work (ML inference), reactive provides no advantage because threads are busy computing, not waiting. Virtual threads (Java 21) now provide near-reactive throughput with blocking code, reducing the cases where reactive is necessary."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Reactive vs Blocking Performance Comparison for Payment Authorization",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "Write a JMH benchmark comparing throughput at varying concurrency levels (10, 100, 500, 1000 virtual users) for a payment authorization simulation using: (a) Spring MVC + JDBC with platform thread pool, (b) Spring MVC + JDBC with virtual threads, and (c) Spring WebFlux + R2DBC."},
    {"id": "2", "description": "Implement the same payment authorization logic in both blocking (JdbcTemplate) and reactive (R2DBC + WebFlux) styles, ensuring identical business logic and error handling semantics."},
    {"id": "3", "description": "Configure BlockHound in the test suite and write a test that verifies no blocking calls occur on the WebFlux event loop during a payment authorization request."},
    {"id": "4", "description": "Document in code comments the decision criteria for choosing reactive vs blocking vs virtual threads for each of these payment service types: authorization API, settlement batch, fraud scoring, event consumer."}
  ]
}
-->

