---
id: track-03-lesson-20
sequence: 20
title: "Thread Pool Exhaustion in Payment Systems"
slug: thread-pool-exhaustion
track: track-03
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [thread-pool-exhaustion, bulkhead, executor-isolation, back-pressure]
java-versions: [17, 21]
---

Thread pool exhaustion is one of the most common causes of payment system outages. It is deceptively simple: a shared executor fills up, callers queue indefinitely, latency spikes, and the entire service stops responding — all without a single exception being thrown. Understanding how pools exhaust, detecting it early, and designing bulkhead boundaries separating critical paths from non-critical work is a core Principal Engineer competency.

## Learning Objectives

By the end of this lesson you will be able to:

- Explain the exact sequence of events that leads from slow dependencies to full pool exhaustion
- Identify thread pool starvation in production metrics and thread dumps
- Apply the bulkhead pattern to isolate payment-critical executor pools
- Configure rejection policies that preserve system responsiveness rather than silently losing work
- Instrument executors to surface pool health before exhaustion

## Business Context

A European payment processor ran a single shared executor with 200 threads across all operations: payment authorisations, fraud checks, settlement batches, and report generation. One evening, settlement batch jobs ran long due to a database query regression. Within minutes all 200 threads were occupied on batch work. Payment authorisations began queuing in the executor's unbounded `LinkedBlockingQueue`. Latency spiked from 50 ms to 45 seconds. By the time on-call was paged, thousands of transactions had timed out at the client. Revenue impact: €2.3 million. Root cause: no pool isolation, no queue depth monitoring, unbounded queue masking the problem.

## How Thread Pool Exhaustion Happens

### The Cascade

```
                   Single Shared Executor (200 threads)
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
  Payment Auth          Fraud Checks        Batch Settlement
  (fast: 50ms)         (fast: 100ms)       (slow: 60s+)
         │                    │                    │
                                           Threads fill here ───►
                                           Queue grows ──────────►
                                           Auth tasks wait ───────►
                                           Latency → timeout ─────►
```

### The Unbounded Queue Trap

`LinkedBlockingQueue` with no capacity limit is the most dangerous executor default:

```java
// Dangerous — this is what Executors.newFixedThreadPool() uses internally
new ThreadPoolExecutor(
    200, 200,
    0L, TimeUnit.MILLISECONDS,
    new LinkedBlockingQueue<>()   // unbounded! exhaustion hides here
);
```

Behaviour under load:
1. Pool reaches `corePoolSize` (200) — all threads busy
2. Tasks queue in `LinkedBlockingQueue` — no threads added, no rejection
3. Queue grows to tens of thousands of tasks
4. Memory pressure increases
5. Queued tasks eventually execute — but they already timed out at the caller
6. `RejectedExecutionException` never fires; nothing alerts

### The ArrayBlockingQueue Difference

```java
// Bounded queue — rejection fires when both pool and queue are full
new ThreadPoolExecutor(
    200, 200,
    0L, TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(500),     // bounded: triggers rejection at 500
    new CallerRunsPolicy()             // or custom rejection handler
);
```

## Bulkhead Pattern: Pool Isolation

The bulkhead pattern (from naval architecture — watertight compartments) isolates thread pools so a failure in one domain cannot exhaust resources in another.

### Three-Pool Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Payment Service                           │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────┐  │
│  │  payment-exec    │  │   fraud-exec     │  │batch-exec│  │
│  │  core:50 max:50  │  │  core:30 max:30  │  │core:5    │  │
│  │  queue:100       │  │  queue:200       │  │max:5     │  │
│  │                  │  │                  │  │queue:10  │  │
│  │  PAYMENT AUTH    │  │  FRAUD CHECKS    │  │BATCH JOBS│  │
│  │  SETTLEMENT      │  │  SANCTIONS       │  │REPORTS   │  │
│  └──────────────────┘  └──────────────────┘  └──────────┘  │
│                                                             │
│  batch-exec exhaustion → NO IMPACT on payment-exec         │
└─────────────────────────────────────────────────────────────┘
```

### Spring Boot Bulkhead Configuration

```java
@Configuration
public class ExecutorBulkheadConfig {

    // Critical path: payment authorisation and settlement
    @Bean(name = "paymentExecutor")
    public ThreadPoolTaskExecutor paymentExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(50);
        exec.setMaxPoolSize(50);
        exec.setQueueCapacity(100);           // small queue — fast rejection
        exec.setThreadNamePrefix("payment-");
        exec.setRejectedExecutionHandler(new PaymentRejectionHandler());
        exec.setWaitForTasksToCompleteOnShutdown(true);
        exec.setAwaitTerminationSeconds(30);
        exec.initialize();
        return exec;
    }

    // Fraud/sanctions checks — higher tolerance for queuing
    @Bean(name = "fraudExecutor")
    public ThreadPoolTaskExecutor fraudExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(30);
        exec.setMaxPoolSize(50);
        exec.setQueueCapacity(500);
        exec.setThreadNamePrefix("fraud-");
        exec.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        exec.initialize();
        return exec;
    }

    // Non-critical: batch, reports, notifications
    @Bean(name = "batchExecutor")
    public ThreadPoolTaskExecutor batchExecutor() {
        ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
        exec.setCorePoolSize(5);
        exec.setMaxPoolSize(10);
        exec.setQueueCapacity(50);
        exec.setThreadNamePrefix("batch-");
        exec.setRejectedExecutionHandler(new ThreadPoolExecutor.DiscardOldestPolicy());
        exec.initialize();
        return exec;
    }
}
```

### Critical Path Rejection Handler

For payment operations, `DiscardPolicy` or `AbortPolicy` are both wrong — silent data loss vs uncaught exception. Use a handler that logs, increments metrics, and surfaces a meaningful exception:

```java
public class PaymentRejectionHandler implements RejectedExecutionHandler {

    private static final Logger log = LoggerFactory.getLogger(PaymentRejectionHandler.class);
    private final Counter rejectedCounter;

    public PaymentRejectionHandler() {
        this.rejectedCounter = Metrics.counter("payment.executor.rejected");
    }

    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        rejectedCounter.increment();

        log.error(
            "Payment executor rejected task. Pool size={}/{}, queue={}/{}",
            executor.getPoolSize(),
            executor.getMaximumPoolSize(),
            executor.getQueue().size(),
            executor.getQueue().size() + executor.getQueue().remainingCapacity()
        );

        // Throw typed exception — callers can catch and return HTTP 503
        throw new PaymentExecutorExhaustedException(
            "Payment processing pool exhausted: " +
            executor.getPoolSize() + " threads busy, " +
            executor.getQueue().size() + " queued"
        );
    }
}
```

## Detecting Exhaustion Before It Happens

### Executor Health Indicator

```java
@Component
public class ExecutorHealthIndicator implements HealthIndicator {

    @Qualifier("paymentExecutor")
    @Autowired
    private ThreadPoolTaskExecutor paymentExecutor;

    @Override
    public Health health() {
        ThreadPoolExecutor tpe = paymentExecutor.getThreadPoolExecutor();

        int active      = tpe.getActiveCount();
        int poolSize    = tpe.getPoolSize();
        int maxPool     = tpe.getMaximumPoolSize();
        int queueSize   = tpe.getQueue().size();
        int queueCap    = tpe.getQueue().size() + tpe.getQueue().remainingCapacity();
        double utilPct  = poolSize == 0 ? 0 : (double) active / maxPool * 100;
        double queuePct = queueCap == 0 ? 0 : (double) queueSize / queueCap * 100;

        Health.Builder builder = utilPct > 90 || queuePct > 80
            ? Health.down()
            : utilPct > 70 || queuePct > 50
                ? Health.unknown()   // "degraded" via DOWN or custom status
                : Health.up();

        return builder
            .withDetail("activeThreads",  active)
            .withDetail("poolSize",       poolSize)
            .withDetail("maxPoolSize",    maxPool)
            .withDetail("utilisation",    String.format("%.1f%%", utilPct))
            .withDetail("queueSize",      queueSize)
            .withDetail("queueCapacity",  queueCap)
            .withDetail("queueFill",      String.format("%.1f%%", queuePct))
            .build();
    }
}
```

### Micrometer Executor Metrics

Spring Boot auto-registers executor metrics if you name the bean. Expose them to Prometheus/Grafana:

```java
@Bean(name = "paymentExecutor")
public ThreadPoolTaskExecutor paymentExecutor(MeterRegistry registry) {
    ThreadPoolTaskExecutor exec = new ThreadPoolTaskExecutor();
    exec.setCorePoolSize(50);
    exec.setMaxPoolSize(50);
    exec.setQueueCapacity(100);
    exec.setThreadNamePrefix("payment-");
    exec.initialize();

    // Register Micrometer bindings manually if needed
    ExecutorServiceMetrics.monitor(
        registry,
        exec.getThreadPoolExecutor(),
        "payment-executor",
        List.of(Tag.of("pool", "payment"))
    );

    return exec;
}
```

Key metrics to alert on:
| Metric | Alert Threshold |
|--------|----------------|
| `executor.pool.size` / `executor.pool.max` | > 90% |
| `executor.queued` / `executor.queue.remaining` | > 70% |
| `executor.rejected.total` rate | Any non-zero |
| `executor.completed.total` rate drop | > 50% drop vs baseline |

## Back-Pressure Propagation

Exhaustion must propagate back to callers — not silently absorb overload.

### HTTP Layer Back-Pressure

```java
@RestController
@RequestMapping("/api/payments")
public class PaymentController {

    @Autowired
    @Qualifier("paymentExecutor")
    private ThreadPoolTaskExecutor paymentExecutor;

    @PostMapping("/authorise")
    public CompletableFuture<AuthorisationResponse> authorise(
            @RequestBody AuthorisationRequest request) {

        // Check pool pressure before submitting
        ThreadPoolExecutor tpe = paymentExecutor.getThreadPoolExecutor();
        int queueSize = tpe.getQueue().size();
        int remaining = tpe.getQueue().remainingCapacity();

        if (remaining == 0 || (double) queueSize / (queueSize + remaining) > 0.9) {
            // Proactive 503 before hitting rejection handler
            throw new ResponseStatusException(
                HttpStatus.SERVICE_UNAVAILABLE,
                "Payment service temporarily overloaded. Retry after 2 seconds."
            );
        }

        return CompletableFuture.supplyAsync(
            () -> paymentService.authorise(request),
            paymentExecutor
        );
    }

    @ExceptionHandler(PaymentExecutorExhaustedException.class)
    @ResponseStatus(HttpStatus.SERVICE_UNAVAILABLE)
    public ErrorResponse handleExhaustion(PaymentExecutorExhaustedException ex) {
        return ErrorResponse.of("EXECUTOR_EXHAUSTED", ex.getMessage());
    }
}
```

### Virtual Threads as the Exhaustion Cure (Java 21)

For I/O-bound payment workloads, virtual threads eliminate pool exhaustion entirely — blocking I/O unmounts the carrier thread rather than occupying it:

```java
// Java 21: no pool exhaustion for I/O-bound work
@Bean(name = "paymentExecutor")
public Executor paymentExecutor() {
    // Thread-per-task with virtual threads — scales to millions
    return Executors.newVirtualThreadPerTaskExecutor();
}
```

> [!IMPORTANT]
> Virtual threads solve I/O-bound exhaustion but not CPU-bound exhaustion. If your payment processing is CPU-intensive (cryptographic operations, complex validation), you still need bounded platform thread pools. Use virtual threads for the I/O path; keep a separate CPU-bound pool for computation.

## Sizing Revisited: Queue Depth Strategy

| Queue Type | Queue Depth Strategy | Use Case |
|-----------|---------------------|----------|
| Payment auth | Small (< 2× pool) | Fast rejection, preserve SLA |
| Fraud check | Medium (5–10× pool) | Tolerate burst; fraud latency less critical |
| Batch/reports | Large or unbounded | Background work, no latency SLA |
| CPU-bound | Zero (SynchronousQueue) | No queuing — reject immediately |

For payment auth with a 50 ms SLA and 50 threads:
- Target throughput: 50 threads / 0.05 s = 1,000 req/s
- Acceptable queue drain time: 200 ms (4× SLA)
- Maximum queue: 1,000 × 0.2 = 200 tasks — set `queueCapacity=200`

## Knowledge Check

**Q1:** You have a `ThreadPoolExecutor` with `corePoolSize=10`, `maximumPoolSize=50`, and an unbounded `LinkedBlockingQueue`. Under sustained load, what is the maximum number of threads that will ever be created?

**A:** 10 — the core pool size. With an unbounded queue, additional threads beyond `corePoolSize` are only created when the queue is full. `LinkedBlockingQueue` is never full, so `maximumPoolSize` is never reached. This is a common misconfiguration: you get none of the burst capacity you expected.

**Q2:** A `CallerRunsPolicy` is configured on the payment executor. What is the risk in a payment service?

**A:** The calling thread (usually an HTTP handler thread from Tomcat's container pool) executes the rejected task. This blocks the HTTP thread for the payment processing duration, which exhausts the Tomcat thread pool — the problem simply migrates from the payment executor to the web container. Use typed rejection exceptions instead, returning HTTP 503 immediately.

## Practical Challenge

Your payment service uses a shared `ThreadPoolExecutor` with 100 threads and an unbounded queue. During peak hours, settlement batch jobs consume all 100 threads, causing payment authorisations to queue for up to 90 seconds before timing out.

**Task:** Implement a bulkhead architecture with the following requirements:

1. **Payment executor:** 60 threads, queue capacity 150, custom rejection that increments a Micrometer counter and throws `PaymentExecutorExhaustedException`
2. **Batch executor:** 15 threads, queue capacity 30, `DiscardOldestPolicy`
3. **Health endpoint** at `/actuator/health` that reports `DOWN` when payment executor thread utilisation > 85% or queue fill > 75%
4. **Controller** that returns HTTP 503 with `Retry-After: 2` header when the rejection handler fires

Verify by writing a stress test that submits 500 concurrent payment tasks and 200 concurrent batch tasks, then asserts that at least 400 payment tasks complete successfully (the remainder reject with 503, not silently drop).

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A ThreadPoolExecutor is configured with corePoolSize=10, maximumPoolSize=100, and an unbounded LinkedBlockingQueue. Under sustained high load, how many threads will actually be created?",
      "options": [
        "Up to 100 threads, as defined by maximumPoolSize",
        "Exactly 10 threads, because LinkedBlockingQueue is never full so maximumPoolSize is never reached",
        "Exactly 100 threads immediately at startup",
        "Between 10 and 100 depending on queue depth"
      ],
      "correct": 1,
      "explanation": "With an unbounded LinkedBlockingQueue, additional threads beyond corePoolSize are only created when the queue is full. Since LinkedBlockingQueue has no capacity limit, it is never full, so maximumPoolSize is never reached. You end up with exactly corePoolSize threads regardless of load."
    },
    {
      "text": "A payment service uses CallerRunsPolicy on its payment executor. What is the primary risk of this policy on the payment-critical path?",
      "options": [
        "It silently discards payment tasks when the pool is exhausted",
        "It causes the HTTP handler thread to execute the rejected task, which can exhaust the web container's thread pool",
        "It throws RejectedExecutionException which crashes the service",
        "It creates new threads beyond maximumPoolSize causing out-of-memory errors"
      ],
      "correct": 1,
      "explanation": "CallerRunsPolicy causes the submitting thread (the HTTP handler thread) to execute the rejected task directly. This blocks the HTTP thread for the payment processing duration, which can exhaust the web container's (e.g., Tomcat's) thread pool — migrating the problem rather than solving it. For payment-critical paths, return HTTP 503 instead."
    },
    {
      "text": "Which metric combination should trigger an alert indicating imminent thread pool exhaustion in a payment executor?",
      "options": [
        "executor.completed.total rate increasing steadily",
        "executor.pool.size / executor.pool.max > 90% AND executor.queued / executor.queue.remaining > 70%",
        "executor.rejected.total equals zero",
        "executor.active.count equals executor.core.size"
      ],
      "correct": 1,
      "explanation": "Alerting on both thread utilisation above 90% AND queue fill above 70% provides early warning before actual rejection occurs. Waiting for rejected.total > 0 means tasks are already being dropped. The combination of high thread AND queue utilisation signals that the pool is approaching its limits and can serve as a pre-emptive 503 signal."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Payment Service Bulkhead Architecture",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a three-pool bulkhead configuration using ThreadPoolTaskExecutor beans: a payment executor (60 threads, queue 150, custom PaymentRejectionHandler that increments a Micrometer counter and throws PaymentExecutorExhaustedException), a fraud executor (30 threads, queue 500, CallerRunsPolicy), and a batch executor (10 threads, queue 50, DiscardOldestPolicy)."},
    {"id": "2", "description": "Implement the custom PaymentRejectionHandler that logs pool state (active/max threads, queue size/capacity), increments a 'payment.executor.rejected' Micrometer counter, and throws a typed PaymentExecutorExhaustedException with a descriptive message including current pool metrics."},
    {"id": "3", "description": "Implement an ExecutorHealthIndicator (implementing HealthIndicator) that reports DOWN when payment executor thread utilisation exceeds 85% or queue fill exceeds 75%, and reports UP otherwise. Expose the health check at /actuator/health with detailed metrics including activeThreads, utilisation percentage, queueSize, and queueFill percentage."},
    {"id": "4", "description": "Implement a PaymentController with a /api/payments/authorise endpoint that proactively checks queue fill before submitting (returning HTTP 503 with Retry-After: 2 header when queue fill > 90%), and an exception handler that maps PaymentExecutorExhaustedException to HTTP 503. Write a concurrent stress test using 500 payment tasks and 200 batch tasks simultaneously, asserting that at least 400 payment tasks complete successfully and none are silently dropped."}
  ]
}
-->
