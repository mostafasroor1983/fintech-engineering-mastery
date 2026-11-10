---
id: track-04-lesson-12
title: "Virtual Threads vs Reactive — Choosing the Right Model"
slug: virtual-threads-vs-reactive
track: track-04
trackName: Async & Reactive Systems
sequence: 12
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [virtual-threads, reactive, java-21, thread-per-request, structured-concurrency]
prerequisites: []
---

# Virtual Threads vs Reactive — Choosing the Right Model

> [!NOTE]
> Java 21 made virtual threads (Project Loom) generally available, reigniting the debate about whether reactive programming is still worth its complexity. For fintech engineers, this is a pragmatic architectural decision: virtual threads make blocking code concurrent at scale, while reactive programming offers back-pressure, streaming, and a composable functional model that virtual threads do not replace.

## The Core Comparison

Both virtual threads and reactive programming solve the same fundamental problem: how to handle thousands of concurrent I/O-bound operations without an equal number of OS threads. They solve it in fundamentally different ways.

**Virtual Threads (Project Loom):**
- JVM manages millions of lightweight threads, each mapped to a carrier OS thread
- Blocking operations (`JDBC`, `Socket.read()`, `Thread.sleep()`) park the virtual thread without blocking the carrier OS thread
- Write familiar synchronous, imperative code — the JVM makes it scale

**Reactive Programming (Project Reactor):**
- A small number of OS threads handle all I/O via non-blocking system calls
- Code is written as asynchronous pipelines of operators
- Back-pressure propagation is built into the programming model

```
Virtual Threads Model:
┌─────────────────────────────────────────────────────┐
│  OS Thread 1  ─────────────────────────────────────  │
│    Virtual Thread 1 ──► JDBC call (parked)           │
│    Virtual Thread 2 ──► HTTP call (parked)           │
│    Virtual Thread 3 ──► executing                    │
│    Virtual Thread N ──► Redis call (parked)          │
│  OS Thread 2  ─────────────────────────────────────  │
│    Virtual Thread 5 ──► executing (was parked)       │
│    ...                                               │
└─────────────────────────────────────────────────────┘

Reactive Model:
┌─────────────────────────────────────────────────────┐
│  Netty Thread 1  ─────────────────────────────────── │
│    Request A ──► operator pipeline (non-blocking)   │
│    Request B ──► operator pipeline (non-blocking)   │
│    I/O callback ──► resume pipeline                 │
│  Netty Thread 2  ─────────────────────────────────── │
│    Request C ──► operator pipeline                  │
│    ...                                               │
└─────────────────────────────────────────────────────┘
```

---

## Virtual Threads in Practice

Virtual threads require Java 21+. They are enabled in Spring Boot 3.2+ via a single property.

```yaml
# application.yml — enable virtual threads for Spring MVC
spring:
  threads:
    virtual:
      enabled: true
```

```java
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

public class VirtualThreadExamples {

    // Create a virtual thread executor
    public static ExecutorService virtualThreadExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }

    // Traditional blocking code that scales with virtual threads
    @RestController
    @RequestMapping("/api/v1/payments")
    public class PaymentController {

        // With virtual threads enabled, this blocking code handles
        // 50,000+ concurrent requests on 8 OS threads
        @GetMapping("/{id}")
        public Payment getPayment(@PathVariable String id) {
            // These blocking calls park the virtual thread, not the OS thread
            Account sender = accountRepository.findById(id); // blocking JDBC
            FraudScore score = fraudClient.check(id);         // blocking HTTP
            FxRate rate = fxRateService.getRate("USD/EUR");   // blocking HTTP

            return Payment.enriched(sender, score, rate);
        }
    }

    // Explicit virtual thread creation
    public CompletableFuture<PaymentResult> processAsync(Payment payment) {
        return CompletableFuture.supplyAsync(
            () -> processPaymentBlocking(payment),
            Executors.newVirtualThreadPerTaskExecutor()
        );
    }

    // Thread.ofVirtual for named threads
    public void startPaymentProcessor() {
        Thread.ofVirtual()
            .name("payment-processor-", 0)
            .start(() -> {
                while (!Thread.currentThread().isInterrupted()) {
                    Payment payment = paymentQueue.take(); // blocking — OK on virtual thread
                    processPaymentBlocking(payment);
                }
            });
    }
}
```

---

## Throughput Comparison

The throughput difference between virtual threads and reactive depends heavily on workload characteristics.

```java
// Benchmark setup: 10,000 concurrent requests, each doing 3 blocking calls
// Each call: 10ms latency, 2ms CPU

// MVC + Platform Threads (200 threads):
// - 200 concurrent requests
// - Queue builds up under load
// - Throughput ceiling: ~200 TPS at 10ms latency = 200/0.010 = 20,000 TPS (theoretical)
// - In practice: 2,000-5,000 TPS due to context switching overhead

// MVC + Virtual Threads:
// - 10,000+ concurrent requests (one virtual thread per request)
// - No queue buildup until JVM resources exhausted
// - Throughput: closer to 10,000-20,000 TPS at 10ms I/O
// - CPU threads: still 8 OS threads (no context switching overhead)

// WebFlux + Reactor:
// - 10,000+ concurrent requests on 8 event-loop threads
// - Throughput: comparable to virtual threads for I/O-bound workloads
// - CPU overhead: slightly lower (fewer thread objects, no virtual thread scheduler)
// - Code complexity: significantly higher

public class ThroughputComparison {

    // Virtual thread version — simple, readable
    @Service
    public class PaymentServiceVT {
        public PaymentResult processBlocking(Payment payment) {
            FraudScore fraud = fraudClient.check(payment);     // blocks 50ms
            FxRate rate = fxClient.getRate(payment.getCcy());  // blocks 30ms
            Account acct = accountRepo.findById(payment.getSourceId()); // blocks 10ms
            // Sequential: 90ms total
            return PaymentResult.from(fraud, rate, acct);
        }
    }

    // Reactive version — concurrent but complex
    @Service
    public class PaymentServiceReactive {
        public Mono<PaymentResult> processReactive(Payment payment) {
            return Mono.zip(
                fraudClient.checkAsync(payment),              // 50ms, non-blocking
                fxClient.getRateAsync(payment.getCcy()),      // 30ms, non-blocking
                accountRepo.findByIdAsync(payment.getSourceId()) // 10ms, non-blocking
            ).map(t -> PaymentResult.from(t.getT1(), t.getT2(), t.getT3()));
            // Concurrent: 50ms total (longest call wins)
        }
    }

    // Virtual threads + parallel execution — best of both worlds
    @Service
    public class PaymentServiceVTParallel {
        public PaymentResult processParallel(Payment payment)
                throws ExecutionException, InterruptedException {
            try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
                Future<FraudScore> fraud = executor.submit(() ->
                    fraudClient.check(payment));        // virtual thread 1
                Future<FxRate> rate = executor.submit(() ->
                    fxClient.getRate(payment.getCcy())); // virtual thread 2
                Future<Account> acct = executor.submit(() ->
                    accountRepo.findById(payment.getSourceId())); // virtual thread 3

                return PaymentResult.from(
                    fraud.get(), rate.get(), acct.get()); // wait for all
            }
            // Concurrent on virtual threads: ~50ms total
        }
    }
}
```

---

## Structured Concurrency (Java 21)

Structured Concurrency (`java.util.concurrent.StructuredTaskScope`) is a companion to virtual threads that makes concurrent operations safe and readable.

```java
import java.util.concurrent.StructuredTaskScope;

public class StructuredConcurrencyExamples {

    // ShutdownOnFailure — cancel all tasks if any fails
    public EnrichedPayment enrichPayment(Payment payment)
            throws InterruptedException, ExecutionException {

        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            StructuredTaskScope.Subtask<FraudScore> fraudTask =
                scope.fork(() -> fraudService.check(payment));
            StructuredTaskScope.Subtask<FxRate> fxTask =
                scope.fork(() -> fxService.getRate(payment.getCurrency()));
            StructuredTaskScope.Subtask<Account> accountTask =
                scope.fork(() -> accountService.findById(payment.getSenderId()));

            scope.join()           // wait for all tasks
                 .throwIfFailed(); // rethrow any exception from subtasks

            return EnrichedPayment.from(
                payment,
                fraudTask.get(),
                fxTask.get(),
                accountTask.get()
            );
        }
    }

    // ShutdownOnSuccess — return as soon as the fastest task succeeds
    // Use for redundant service calls: fastest primary/secondary wins
    public FxRate fxRateFromFastestSource(CurrencyPair pair)
            throws InterruptedException {

        try (var scope = new StructuredTaskScope.ShutdownOnSuccess<FxRate>()) {
            scope.fork(() -> primaryFxService.getRate(pair));   // source 1
            scope.fork(() -> secondaryFxService.getRate(pair)); // source 2 (backup)

            scope.join();
            return scope.result(); // whichever returned first
        }
    }

    // Custom scope — timeout all tasks together
    public PaymentValidationResult validateWithTimeout(Payment payment)
            throws InterruptedException, TimeoutException {

        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            var fraudTask = scope.fork(() -> fraudService.check(payment));
            var limitsTask = scope.fork(() -> limitsService.check(payment));
            var complianceTask = scope.fork(() -> complianceService.check(payment));

            scope.joinUntil(Instant.now().plusSeconds(5)); // 5-second timeout
            scope.throwIfFailed();

            return PaymentValidationResult.from(
                fraudTask.get(), limitsTask.get(), complianceTask.get());
        }
    }
}
```

---

## Latency Characteristics

```
Scenario: Payment enrichment with 3 parallel service calls
         Fraud: 50ms, FX: 30ms, Account: 10ms

Synchronous (MVC, platform threads):
  Total: 50 + 30 + 10 = 90ms p50

Virtual threads (sequential):
  Total: 50 + 30 + 10 = 90ms p50 (no benefit from VT for sequential code)

Virtual threads (StructuredTaskScope parallel):
  Total: max(50, 30, 10) = 50ms p50 ✓ (parallel execution)
  p99:   ~65ms (variance in service latency)

Reactive (Mono.zip parallel):
  Total: max(50, 30, 10) = 50ms p50 ✓ (same parallel execution)
  p99:   ~60ms (slightly lower due to fewer scheduling hops)
  
Conclusion: Latency is comparable for parallel I/O.
            Reactive has slightly lower p99 due to fewer thread scheduling events.
            Virtual threads with structured concurrency match reactive for latency.
```

---

## Debugging Complexity

This is where virtual threads win clearly. Reactive stack traces are notoriously difficult to read in production.

```java
// Stack trace in a reactive pipeline — difficult to follow
// Exception: Payment validation failed
//   at PaymentService.lambda$validate$3(PaymentService.java:87)
//   at reactor.core.publisher.MonoFlatMap$FlatMapMain.onNext(MonoFlatMap.java:125)
//   at reactor.core.publisher.FluxMapFuseable$MapFuseableSubscriber.onNext(...)
//   at reactor.core.publisher.MonoZip$ZipCoordinator.signal(MonoZip.java:...)
//   at reactor.core.publisher.MonoZip$ZipInner.onNext(MonoZip.java:...)
//   at reactor.core.publisher.FluxOnErrorResume$ResumeSubscriber.onNext(...)
//   ... 23 more Reactor internal frames
//   at io.netty.channel.NioEventLoop.run(NioEventLoop.java:...)

// Stack trace in a virtual thread pipeline — straightforward
// Exception: Payment validation failed
//   at PaymentService.validate(PaymentService.java:87)
//   at PaymentService.enrich(PaymentService.java:65)
//   at PaymentController.submitPayment(PaymentController.java:42)
//   at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke(...)
//   at VirtualThread[#17]/runnable@ForkJoinPool-1-worker-1
```

Reactor 3.5+ added `Hooks.onOperatorDebug()` and the `reactor-tools` agent for better stack traces, but they add overhead and are not as readable as virtual thread traces.

---

## Library Compatibility

```java
public class LibraryCompatibility {

    // Virtual threads work with virtually any Java library — no changes needed
    // These all work correctly on virtual threads:
    public void virtualThreadCompatible() {
        // JDBC — blocking, works perfectly on virtual threads
        jdbcTemplate.queryForObject("SELECT balance FROM accounts WHERE id = ?",
            BigDecimal.class, accountId);

        // Jedis (Redis) — blocking, works on virtual threads
        jedisPool.getResource().get("fx:USD/EUR");

        // Apache HTTP Client — blocking, works on virtual threads
        httpClient.execute(new HttpGet("https://fraud-service/check"));

        // Any blocking SDK — works without modification
        awsS3Client.getObject(request);
    }

    // Reactive stack requires reactive libraries throughout
    // Using blocking code on a reactive stack is a serious bug
    public Mono<Payment> reactiveRequiresNonBlocking(String id) {
        // WRONG — JDBC is blocking, will block Netty event-loop thread
        // return Mono.just(jdbcTemplate.queryForObject(...));

        // CORRECT — R2DBC for reactive database access
        return r2dbcPaymentRepository.findById(id); // returns Mono<Payment>
    }

    // Not all libraries have reactive equivalents:
    // - JDBC → R2DBC (many databases supported, but API is different)
    // - Jedis → Lettuce (Reactive Redis client)
    // - Apache HTTP → WebClient (Spring) or Vert.x WebClient
    // - AWS SDK v1 → AWS SDK v2 (async client available)
    // - Many legacy banking SDKs → NO reactive alternative (use subscribeOn(boundedElastic))
}
```

---

## When to Use Each in Fintech

```java
/*
 * Decision Framework for Fintech Services:
 *
 * USE VIRTUAL THREADS (MVC + Spring Boot 3.2+) when:
 * - You have blocking dependencies that cannot be replaced (legacy JDBC, vendor SDKs)
 * - The team is not experienced with reactive patterns
 * - Moderate concurrency needs (< 5,000 concurrent requests)
 * - Straightforward request-response patterns (no streaming, no back-pressure)
 * - You value simple debugging and linear stack traces
 * - Green-field services on Java 21+
 *
 * USE REACTIVE (WebFlux + Reactor) when:
 * - Streaming is core to the service (SSE, WebSocket, Kafka consumers)
 * - Back-pressure must propagate from consumer to producer
 * - All dependencies have reactive clients (R2DBC, WebClient, Reactor Kafka)
 * - Ultra-high concurrency (10,000+ concurrent in-flight operations)
 * - The team already knows reactive — the learning curve has been paid
 * - You need fine-grained control over threading and scheduling
 *
 * HYBRID APPROACH:
 * - Virtual threads at the HTTP layer (Spring MVC)
 * - Reactive at the messaging layer (Reactor Kafka)
 * - Explicitly offload blocking I/O on reactive stacks with subscribeOn(boundedElastic)
 */
```

---

## Migration Path: Reactive to Virtual Threads

If you have an existing reactive service and want to migrate to virtual threads:

```java
// Step 1: Identify all reactive types in your API
// Before: reactive service interfaces
public interface PaymentRepository {
    Mono<Payment> findById(String id);
    Flux<Payment> findByAccountId(String accountId);
    Mono<Payment> save(Payment payment);
}

// Step 2: Create blocking counterparts (enabled by virtual threads)
// After: standard blocking interfaces
public interface PaymentRepository {
    Optional<Payment> findById(String id);
    List<Payment> findByAccountId(String accountId);
    Payment save(Payment payment);
}

// Step 3: Replace R2DBC with JDBC (or Spring Data JPA)
// Before: R2DBC
@Repository
public class R2dbcPaymentRepository implements PaymentRepository {
    private final DatabaseClient databaseClient;

    public Mono<Payment> findById(String id) {
        return databaseClient.sql("SELECT * FROM payments WHERE id = :id")
            .bind("id", id)
            .fetch()
            .one()
            .map(this::mapToPayment);
    }
}

// After: Spring Data JPA + virtual threads
@Repository
public interface JpaPaymentRepository extends JpaRepository<PaymentEntity, String> {
    // Spring Data generates implementation — works perfectly with virtual threads
}

// Step 4: Replace WebClient with RestClient (Spring 6.1+)
// Before: WebClient
Mono<FraudScore> fraudCheck = webClient.post()
    .uri("/check")
    .bodyValue(request)
    .retrieve()
    .bodyToMono(FraudScore.class);

// After: RestClient (blocking, fine on virtual threads)
FraudScore fraudScore = restClient.post()
    .uri("/check")
    .body(request)
    .retrieve()
    .body(FraudScore.class);

// Step 5: Keep reactive where it makes sense
// Kafka consumers are still better served by Reactor Kafka
// SSE endpoints still need WebFlux
// Keep reactive at the edges, use virtual threads in the core
```

---

## Hybrid Architecture for Financial Systems

```java
// A realistic hybrid: virtual threads for synchronous services,
// reactive for event-driven pipelines

@SpringBootApplication
public class PaymentPlatform {

    // HTTP API layer: Virtual threads (simple, debuggable)
    @Bean
    public TomcatProtocolHandlerCustomizer<?> virtualThreadsForTomcat() {
        return protocolHandler ->
            protocolHandler.setExecutor(
                Executors.newVirtualThreadPerTaskExecutor());
    }

    // Event processing layer: Reactive (backpressure, streaming)
    @Bean
    public ReactorKafkaConsumer paymentEventConsumer(
            ReceiverOptions<String, PaymentEvent> options) {
        return KafkaReceiver.create(options)
            .receive()
            .flatMap(record ->
                processPaymentEvent(record.value())
                    .doOnSuccess(r -> record.receiverOffset().acknowledge()),
                10 // 10 concurrent event processors
            )
            .subscribe();
    }

    // Bridge: virtual thread service calling reactive Kafka publisher
    @Service
    public class PaymentService {

        private final Sinks.Many<Payment> paymentSink =
            Sinks.many().multicast().onBackpressureBuffer(1000);

        // Called from virtual thread HTTP handler
        public PaymentResult processPayment(PaymentRequest request) {
            Payment payment = validate(request); // blocking, fine on VT
            Account account = accountRepo.findById(request.getAccountId()); // blocking JDBC

            // Bridge to reactive Kafka publisher
            paymentSink.tryEmitNext(payment);

            return PaymentResult.accepted(payment.getId());
        }

        // Reactive Kafka publisher reads from the sink
        public Flux<Payment> paymentsToPublish() {
            return paymentSink.asFlux();
        }
    }
}
```

---

## Production Tips and Pitfalls

**Pitfall 1: Synchronized blocks with virtual threads (pinning)**

Virtual threads park when they hit a blocking operation. However, `synchronized` blocks and `synchronized` methods **pin** the virtual thread to its carrier OS thread — the carrier thread blocks too. This eliminates the benefit of virtual threads.

```java
// WRONG — synchronized pins the virtual thread to its carrier
public synchronized Payment processPayment(Payment payment) {
    return expensiveBlockingOperation(payment); // carrier thread is blocked!
}

// CORRECT — use ReentrantLock instead
private final ReentrantLock lock = new ReentrantLock();

public Payment processPayment(Payment payment) {
    lock.lock();
    try {
        return expensiveBlockingOperation(payment); // virtual thread parks, carrier is free
    } finally {
        lock.unlock();
    }
}
```

**Pitfall 2: Thread-local caches with virtual threads**

Since virtual threads are cheap and may be created per-request, caches stored in `ThreadLocal` are created per virtual thread and never shared. Use a proper cache (Caffeine, Redis) instead.

**Pitfall 3: `Executors.newVirtualThreadPerTaskExecutor()` and connection pools**

A virtual thread executor creates one virtual thread per task. If you submit 10,000 database queries simultaneously, you create 10,000 virtual threads all trying to acquire connections from a 20-connection pool. The virtual threads park waiting for connections — this is correct behavior — but monitor pool wait times.

**Pitfall 4: Reactive back-pressure has no virtual thread equivalent**

Virtual threads cannot propagate back-pressure. If your Kafka consumer uses virtual threads and the downstream database is slow, the consumer will keep creating virtual threads until memory is exhausted. Reactive's `request(n)` protocol propagates back-pressure from the database consumer to the Kafka consumer automatically.

---

## Summary

The virtual threads vs reactive decision in fintech:

| Dimension | Virtual Threads | Reactive (Reactor) |
|-----------|----------------|--------------------|
| Concurrency model | Thread-per-request (lightweight) | Event-loop (non-blocking) |
| Code style | Synchronous, imperative | Asynchronous, functional |
| Debugging | Simple linear stack traces | Complex, operator-chain traces |
| Back-pressure | Not built in | First-class |
| Streaming | Via iterators | First-class (Flux) |
| Library compatibility | Any blocking library | Requires reactive libraries |
| Java version | 21+ | Java 8+ |
| Learning curve | Low (write normal code) | High (new programming model) |

**The practical guidance:**
- Use virtual threads for new CRUD/REST services on Java 21+ — they are simpler and equally performant
- Keep reactive for event-driven pipelines, streaming endpoints, and Kafka consumers
- Migrate reactive REST services to virtual threads when Java 21 is available, keeping reactive at the messaging layer

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "How do virtual threads (Project Loom) handle blocking I/O differently from platform (OS) threads?",
      "options": ["Virtual threads use non-blocking system calls internally, like reactive NIO", "When a virtual thread calls a blocking operation, the JVM parks the virtual thread and unmounts it from the carrier OS thread, freeing the carrier to run other virtual threads", "Virtual threads queue blocking calls and process them in batches to reduce system call overhead", "Virtual threads use busy-waiting instead of OS-level blocking to avoid context switching"],
      "correct": 1,
      "explanation": "When a virtual thread hits a blocking operation (JDBC, Socket.read), the JVM transparently parks it — unmounting it from the carrier OS thread. The carrier thread is then free to execute other virtual threads. When the I/O completes, the virtual thread is rescheduled on a carrier. This makes blocking code scale without the thread-per-request limitation."
    },
    {
      "text": "What specific scenario causes virtual thread 'pinning' and negates the scalability benefit?",
      "options": ["Using JDBC drivers that are not virtual-thread-aware", "Executing blocking code inside a synchronized block or native method — the virtual thread cannot be unmounted from the carrier thread while holding a monitor lock", "Calling Thread.sleep() inside a virtual thread", "Using more than 1000 concurrent virtual threads"],
      "correct": 1,
      "explanation": "Virtual threads cannot be unmounted from the carrier OS thread when inside a synchronized block or native method call. If blocking I/O occurs while holding a monitor, the carrier thread is pinned and cannot serve other virtual threads. The fix is to replace synchronized with ReentrantLock."
    },
    {
      "text": "For which type of financial service is reactive programming still preferred over virtual threads even after Java 21?",
      "options": ["CRUD REST APIs with simple request/response patterns", "Event-driven streaming pipelines that require backpressure propagation, operator composition, and push-based processing of Kafka streams", "Microservices with moderate load under 500 concurrent requests", "Services that use JDBC for all database operations"],
      "correct": 1,
      "explanation": "Backpressure — the ability for consumers to signal demand to producers — is a first-class feature of reactive programming that virtual threads do not provide. For Kafka consumers, streaming financial data, or pipelines where a slow consumer must slow the producer, reactive remains the better model."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Virtual Threads Migration and Comparative Benchmark for a Payment REST Service",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Take an existing Spring MVC payment service using JDBC and enable virtual threads with spring.threads.virtual.enabled=true (Spring Boot 3.2+). Run a Gatling benchmark at 1000 concurrent users before and after the change. Measure throughput, p99 latency, and thread count. Document the difference."},
    {"id": "2", "description": "Identify a synchronized block in a dependency used by the payment service (e.g., a connection pool or legacy library). Reproduce virtual thread pinning by running JFR with the VirtualThreadPinned event. Replace the synchronized block with ReentrantLock and verify pinning is eliminated."},
    {"id": "3", "description": "Build a side-by-side benchmark comparing the same payment enrichment logic (3 parallel HTTP calls) implemented in: (a) Spring MVC with virtual threads, (b) Spring WebFlux with Reactor. Measure at 100, 500, 1000, and 2000 concurrent requests. Plot the results and identify the crossover point where each approach wins."},
    {"id": "4", "description": "Design a hybrid architecture for a payment platform: use virtual threads for the REST API layer (Spring MVC) and reactive programming for the Kafka event processing layer (Reactor Kafka). Implement the boundary between them using a reactive-to-blocking bridge (Mono.block() on virtual thread) and document why this is safe with virtual threads but would be dangerous on a platform thread or Netty event loop."}
  ]
}
-->
- Never mix blocking code into the reactive event-loop without `subscribeOn(Schedulers.boundedElastic())`
