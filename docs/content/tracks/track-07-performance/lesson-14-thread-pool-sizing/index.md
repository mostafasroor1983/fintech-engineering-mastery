---
id: track-07-lesson-14
title: "Thread Pool Sizing — Little's Law and Optimal Concurrency"
slug: thread-pool-sizing
track: track-07
trackName: "Performance Engineering"
sequence: 14
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [thread-pool, Little's-law, queuing-theory, executor, sizing]
prerequisites: []
---

# Thread Pool Sizing — Little's Law and Optimal Concurrency

> [!NOTE]
> Undersized thread pools cause request queuing and latency spikes under load. Oversized pools waste memory (each platform thread reserves a stack, ~1MB by default, plus kernel resources), increase context switching, and degrade throughput. Little's Law provides the mathematical foundation to size thread pools correctly for payment processors — but the formula requires measuring your actual service latency and arrival rate under production conditions.

## The Cost of Getting Thread Pool Sizing Wrong

*Composite example:* a payment processing service sees p99 latency spike from 85ms to over 4 seconds during peak hours. The root cause: a thread pool configured with 50 threads (a "looks reasonable" number) for a service that receives 800 requests/second with 120ms average latency. Little's Law immediately tells you why this fails: you need L = λW = 800 × 0.120 = **96 concurrent threads** at steady state, leaving no headroom for spikes.

Misconfigured thread pools are among the most common sources of latency regressions in financial services — and among the easiest to fix once you understand the underlying queueing theory.

---

## Little's Law — The Foundation

Little's Law states that in a stable queueing system:

```
L = λ × W

Where:
  L = average number of requests in the system (being served + waiting)
  λ = average arrival rate (requests per second)
  W = average time each request spends in the system (service latency in seconds)
```

This law applies regardless of arrival distribution, service time distribution, or number of servers. It is remarkably robust.

### Applying Little's Law to Payment Services

```
Payment authorization service:
  λ (arrival rate)    = 500 requests/second at peak
  W (avg latency)     = 150ms = 0.150s
  L (threads needed)  = 500 × 0.150 = 75 threads

Add headroom for a slowdown (if latency for ALL requests rose to
today's p99 of ≈ 400ms, e.g. a slow downstream):
  L (slow scenario)   = 500 × 0.400 = 200 threads
  (Little's Law uses averages -- this is a planning heuristic, not a law)

Sizing recommendation:
  corePoolSize   = 75   (steady state)
  maxPoolSize    = 200  (p99 spike headroom)
  queueCapacity  = 50   (small queue to fail fast vs accumulate backlog)
```

**How `ThreadPoolExecutor` actually grows** (a frequent surprise): with a bounded queue it creates threads up to `corePoolSize`, then puts new tasks in the **queue**, and only when the queue is **full** does it add threads up to `maxPoolSize`. So "max" threads are only reached after the queue has filled — another reason to keep the queue small (or make core large enough for normal peaks).

---

## CPU-Bound vs IO-Bound Workload Analysis

Thread pool sizing depends heavily on whether your workload is CPU-bound or IO-bound.

### CPU-Bound Workloads

```
Optimal threads ≈ number of CPU cores (N_cpu)
                = Runtime.getRuntime().availableProcessors()
                  (container-aware: reflects the CPU limit on modern JVMs)

For a fraud scoring service doing ML inference:
  N_cpu = 16 cores
  corePoolSize = 16
  maxPoolSize  = 16  (more threads = more context switching, not more throughput)

Adding threads beyond N_cpu for CPU-bound work increases context switching overhead
without increasing throughput — the CPU is already saturated.
```

### IO-Bound Workloads

```
Optimal threads = N_cpu × (1 + W/C)

Where:
  W = average IO wait time per request
  C = average CPU compute time per request

For a payment gateway calling external APIs:
  N_cpu = 16 cores
  W     = 95ms (network IO wait — JDBC, HTTP calls)
  C     = 5ms  (actual CPU work — parsing, validation)
  W/C   = 95/5 = 19

  Optimal threads = 16 × (1 + 19) = 320 threads

This represents the classic IO-bound multiplier: each core can handle
19 IO-waiting threads while 1 thread is doing CPU work.
```

### Measuring W and C in Production

```java
@Component
public class ThreadPoolSizingMetrics {

    private static final ThreadMXBean THREADS = ManagementFactory.getThreadMXBean();
    private final MeterRegistry meterRegistry;

    public ThreadPoolSizingMetrics(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    /**
     * Measure, for one request, wall time and the CPU time this thread used.
     * W (waiting) = wall - CPU;  C = CPU.
     * Run under realistic load to get real W and C values.
     */
    public <T> T measure(String operationName, Callable<T> work) throws Exception {
        long wallStart = System.nanoTime();
        long cpuStart  = THREADS.getCurrentThreadCpuTime();   // CPU time, not wall time
        try {
            return work.call();
        } finally {
            long cpu  = THREADS.getCurrentThreadCpuTime() - cpuStart;
            long wall = System.nanoTime() - wallStart;
            meterRegistry.timer(operationName + ".cpu.time")
                .record(cpu, TimeUnit.NANOSECONDS);
            meterRegistry.timer(operationName + ".wait.time")
                .record(Math.max(0, wall - cpu), TimeUnit.NANOSECONDS);
            // Compute W/C in your dashboard from the two timers' means.
            // (Do not call meterRegistry.gauge(name, double) per request: it
            //  registers once and never updates.)
        }
    }
}
```

---

## ThreadPoolExecutor Parameters Deep Dive

```java
public class PaymentThreadPoolFactory {

    /**
     * Purpose-built thread pool for payment authorization service.
     *
     * Parameters explained:
     *   corePoolSize   = minimum threads kept alive (even when idle)
     *   maxPoolSize    = maximum threads ever created
     *   keepAliveTime  = how long idle threads above core survive
     *   workQueue      = queue for tasks when all core threads are busy
     *   threadFactory  = names threads for debugging
     *   rejectedHandler= what to do when queue is full AND maxPool threads are busy
     */
    public static ThreadPoolExecutor buildPaymentAuthorizationPool(
            int corePoolSize,    // from Little's Law steady state
            int maxPoolSize,     // from Little's Law p99 scenario
            int queueCapacity) { // keep small to fail fast

        BlockingQueue<Runnable> workQueue = queueCapacity > 0
            ? new LinkedBlockingQueue<>(queueCapacity)  // bounded — rejects when full
            : new SynchronousQueue<>();                 // zero queue: reject immediately

        ThreadFactory namedFactory = new ThreadFactoryBuilder()
            .setNameFormat("payment-auth-%d")
            .setDaemon(false)   // non-daemon; still shut the pool down gracefully
            .build();

        ThreadPoolExecutor executor = new ThreadPoolExecutor(
            corePoolSize,
            maxPoolSize,
            60, TimeUnit.SECONDS,  // idle thread timeout
            workQueue,
            namedFactory,
            new PaymentRejectedExecutionHandler()  // custom rejection handler
        );

        // Allow core threads to time out when idle — saves memory in off-peak hours
        executor.allowCoreThreadTimeOut(true);

        return executor;
    }

    /**
     * Custom rejection handler for payment operations.
     * Callers MUST handle RejectedExecutionException and return HTTP 503.
     * Never silently drop payment requests.
     */
    static class PaymentRejectedExecutionHandler implements RejectedExecutionHandler {

        private final Counter rejectedCounter;

        PaymentRejectedExecutionHandler() {
            this.rejectedCounter = Counter.builder("payment.thread.pool.rejected")
                .description("Payment requests rejected due to thread pool saturation")
                .register(Metrics.globalRegistry);
        }

        @Override
        public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
            rejectedCounter.increment();
            // Log pool state for capacity planning
            log.warn("Payment thread pool saturated: active={}, queue={}, maxPool={}",
                executor.getActiveCount(),
                executor.getQueue().size(),
                executor.getMaximumPoolSize());
            // Throw so the caller gets a 503, not a silent drop
            throw new RejectedExecutionException(
                "Payment authorization pool saturated — apply backpressure");
        }
    }
}
```

---

## Queue Depth Impact on Latency

Queue depth is a critical but often misunderstood parameter. A large queue hides saturation and creates latency spikes.

```java
/**
 * Demonstration of queue depth impact on p99 latency.
 *
 * Scenario: Payment auth service, 150ms avg latency, 100 threads
 * Load test at 800 req/s (pool capacity ≈ 100/0.15 = 667 req/s)
 *
 * Arrivals exceed capacity by 800 - 667 = 133 req/s, so the queue grows
 * by ~133 requests EVERY SECOND for as long as the overload lasts.
 *
 * With queue=1000:
 *   - Service appears healthy (no errors) for ~7.5 s while the queue fills
 *   - A full queue means each new request waits 1000 / 667 ≈ 1.5 s extra
 *   - p99 latency ≈ 150ms + 1.5 s, and then rejections start anyway
 *   - With queue=10_000: ~75 s of silent build-up and ~15 s waits
 *
 * With queue=50:
 *   - Extra wait is at most 50 / 667 ≈ 75 ms
 *   - Service returns HTTP 503 when overloaded
 *   - Caller applies exponential backoff and retries
 *   - Successful requests keep near-normal latency
 *   - Clients see failures immediately, not delayed timeouts
 *
 * Recommendation: Keep queue short. Fail fast is better than slow degradation.
 */
public class QueueDepthExample {

    // BAD: large queue accumulates invisible backlog
    private final ThreadPoolExecutor badPool = new ThreadPoolExecutor(
        100, 100, 0, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(10_000),  // hides saturation for minutes
        Executors.defaultThreadFactory(),
        new AbortPolicy()
    );

    // GOOD: small queue exposes saturation immediately
    private final ThreadPoolExecutor goodPool = new ThreadPoolExecutor(
        100, 150, 60, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(50),      // fail fast when saturated
        new ThreadFactoryBuilder().setNameFormat("payment-fast-%d").build(),
        new AbortPolicy()  // throw RejectedExecutionException → 503
    );
}
```

---

## Thread Pool Monitoring with Micrometer

```java
@Component
public class ThreadPoolMetricsRegistrar {

    private final MeterRegistry meterRegistry;
    private final ThreadPoolExecutor pool;   // the pool the service REALLY uses

    public ThreadPoolMetricsRegistrar(MeterRegistry meterRegistry,
                                      @Qualifier("paymentAuthPool") ThreadPoolExecutor pool) {
        this.meterRegistry = meterRegistry;
        this.pool = pool;
    }

    /**
     * Register all thread pool metrics with Micrometer.
     * These feed dashboards showing pool utilisation, queue depth, and rejection rate.
     * Alert thresholds: pool utilisation > 80%, queue depth > 20.
     */
    @PostConstruct
    public void registerMetrics() {
        // (Creating a NEW pool here would monitor an executor nobody uses.)

        // Pool utilisation — alert > 80%
        Gauge.builder("thread.pool.active", pool, ThreadPoolExecutor::getActiveCount)
            .tag("pool", "payment-auth")
            .description("Active threads processing payment authorizations")
            .register(meterRegistry);

        Gauge.builder("thread.pool.size", pool, ThreadPoolExecutor::getPoolSize)
            .tag("pool", "payment-auth")
            .register(meterRegistry);

        Gauge.builder("thread.pool.queue.size", pool, e -> e.getQueue().size())
            .tag("pool", "payment-auth")
            .description("Queued payment requests waiting for a thread")
            .register(meterRegistry);

        Gauge.builder("thread.pool.utilisation", pool,
            e -> (double) e.getActiveCount() / e.getMaximumPoolSize())
            .tag("pool", "payment-auth")
            .description("Pool utilisation ratio (0.0 to 1.0)")
            .register(meterRegistry);

        // Completed task count (use rate() in Prometheus queries)
        FunctionCounter.builder("thread.pool.completed", pool,
            ThreadPoolExecutor::getCompletedTaskCount)
            .tag("pool", "payment-auth")
            .register(meterRegistry);
    }

    /**
     * Prometheus alerting rules (prometheus-rules.yml):
     *
     * - alert: PaymentPoolSaturated
     *   expr: thread_pool_utilisation{pool="payment-auth"} > 0.8
     *   for: 2m
     *   annotations:
     *     summary: "Payment auth thread pool at {{ $value | humanizePercentage }} utilisation"
     *
     * - alert: PaymentQueueBuilding
     *   expr: thread_pool_queue_size{pool="payment-auth"} > 20
     *   for: 1m
     *   annotations:
     *     summary: "{{ $value }} payment requests queued — pool may be undersized"
     */
}
```

---

## Sizing for Payment Processors — High IO Wait Scenario

A complete worked example for a payment processor with real production numbers:

```java
/**
 * Payment Processing Service — Thread Pool Sizing Analysis
 *
 * Illustrative service profile:
 *   - Receives 1,200 payment requests/second at peak
 *   - Each request makes 3 downstream calls:
 *       1. Fraud service: 45ms avg, 95ms p99
 *       2. Database read (account limits): 8ms avg, 25ms p99
 *       3. Payment gateway (Visa/MC): 85ms avg, 220ms p99
 *   - Total end-to-end latency: 140ms avg, 380ms p99
 *   - Server has 32 CPU cores
 *   - CPU utilisation per request: ~5ms (parsing, validation, serialization)
 *
 * Calculations:
 *   W/C ratio = 135ms IO / 5ms CPU = 27
 *   Theoretical optimal = 32 × (1 + 27) = 896 threads
 *
 *   But: validate with Little's Law:
 *   L (steady) = 1200 × 0.140 = 168 threads
 *   L (p99)    = 1200 × 0.380 = 456 threads
 *
 *   Take the lower of formula and Little's Law for initial sizing,
 *   then tune based on monitoring.
 *
 *   Recommendation:
 *     corePoolSize  = 168   (Little's Law steady state)
 *     maxPoolSize   = 456   (slow-downstream scenario; only reached after
 *                            the queue is full -- see "How ThreadPoolExecutor
 *                            actually grows")
 *     queueCapacity = 50    (fail fast — small buffer only for burst smoothing)
 *
 *   Also check what the threads WAIT on: 456 threads calling a database
 *   through a 30-connection pool just queue inside the connection pool.
 */
@Configuration
public class PaymentProcessorPoolConfig {

    @Value("${payment.pool.core-size:168}")
    private int coreSize;

    @Value("${payment.pool.max-size:456}")
    private int maxSize;

    @Value("${payment.pool.queue-capacity:50}")
    private int queueCapacity;

    @Bean("paymentAuthorizationExecutor")
    public ThreadPoolTaskExecutor paymentAuthorizationExecutor(
            MeterRegistry meterRegistry) {

        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(coreSize);
        executor.setMaxPoolSize(maxSize);
        executor.setQueueCapacity(queueCapacity);
        executor.setKeepAliveSeconds(60);
        executor.setThreadNamePrefix("payment-auth-");
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);

        // Abort policy: throw RejectedExecutionException for circuit breaker to catch
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.initialize();

        // Register metrics
        ExecutorServiceMetrics.monitor(
            meterRegistry,
            executor.getThreadPoolExecutor(),
            "payment-auth",
            "pool", "payment-auth"
        );

        return executor;
    }

    /**
     * Separate pool for bulk/batch payment processing.
     * Bulk jobs are lower priority — use separate pool to prevent
     * bulk operations from starving real-time authorization requests.
     */
    @Bean("bulkPaymentExecutor")
    public ThreadPoolTaskExecutor bulkPaymentExecutor(MeterRegistry meterRegistry) {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setMaxPoolSize(30);
        executor.setQueueCapacity(10_000);  // bulk can queue — latency less critical
        executor.setThreadNamePrefix("payment-bulk-");
        // (Thread priorities are mostly ignored by the OS scheduler on Linux;
        //  isolation comes from the SEPARATE pool, not from priority.)
        executor.initialize();

        ExecutorServiceMetrics.monitor(
            meterRegistry, executor.getThreadPoolExecutor(),
            "payment-bulk", "pool", "payment-bulk");

        return executor;
    }
}
```

---

## Virtual Threads Impact on Sizing

Java 21 virtual threads fundamentally change the IO-bound sizing model:

```java
@Configuration
@ConditionalOnProperty("payment.virtual-threads.enabled")
public class VirtualThreadPoolConfig {

    /**
     * With virtual threads, the optimal "pool size" question changes:
     *
     * Platform threads: limited resource, stack ~1MB each
     *   → size carefully to match L = λW
     *
     * Virtual threads: cheap, millions possible, ~few KB each
     *   → no pool needed for IO-bound work; use one virtual thread per request
     *
     * The platform thread pool underneath (carrier threads) should be:
     *   coreSize = N_cpu (default: matches availableProcessors())
     *
     * For payment processors: replace ThreadPoolExecutor with virtual threads
     * and let the JVM scheduler manage carrier thread allocation.
     */
    @Bean("paymentVirtualExecutor")
    public ExecutorService paymentVirtualExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }

    /**
     * Spring Boot 3.2+ — enable virtual threads globally:
     *
     * spring.threads.virtual.enabled=true
     *
     * This switches Tomcat's request handling, @Async, and @Scheduled
     * to virtual threads automatically. No explicit pool sizing needed
     * for IO-bound workloads.
     *
     * CAVEATS:
     * - Before JDK 24, blocking inside synchronized pins the carrier thread
     *   (covered in lesson 15); JDK 24 (JEP 491) removed most of this.
     * - Without a pool, nothing limits concurrency any more: 10,000 virtual
     *   threads can all try to use a 30-connection DB pool or a rate-limited
     *   gateway. Limit access to scarce resources explicitly (connection
     *   pools, Semaphore, bulkheads).
     */
}
```

---

## Adaptive Pool Sizing

For services where load varies dramatically between business hours and off-peak:

```java
@Component
@Slf4j
public class AdaptivePoolSizer {

    private final ThreadPoolTaskExecutor pool;
    private final MeterRegistry meterRegistry;
    private final AtomicInteger targetMax = new AtomicInteger();
    private long lastCount = -1;
    private double lastTotalSeconds;
    private long lastSampleNanos;

    public AdaptivePoolSizer(@Qualifier("paymentAuthorizationExecutor") ThreadPoolTaskExecutor pool,
                             MeterRegistry meterRegistry) {
        this.pool = pool;
        this.meterRegistry = meterRegistry;
        meterRegistry.gauge("thread.pool.target.size",
            Tags.of("pool", "payment-auth"), targetMax);      // registered ONCE
    }

    /**
     * Resize the pool from RECENT Little's Law inputs, every 30 seconds.
     * Caution: if latency rises because a downstream is struggling, adding
     * threads sends it MORE concurrent load. Keep firm upper bounds.
     */
    @Scheduled(fixedRate = 30_000)
    public void adjustPoolSize() {
        Timer timer = meterRegistry.find("http.server.requests")
            .tag("uri", "/v1/payments/authorize").timer();
        if (timer == null) return;

        long count = timer.count();
        double totalSeconds = timer.totalTime(TimeUnit.SECONDS);
        long now = System.nanoTime();
        if (lastCount < 0) {                       // first sample: just remember
            lastCount = count; lastTotalSeconds = totalSeconds; lastSampleNanos = now;
            return;
        }

        long requests = count - lastCount;
        double elapsed = (now - lastSampleNanos) / 1e9;
        double arrivalRate = requests / elapsed;                     // λ: req/s
        double avgLatency = requests > 0
            ? (totalSeconds - lastTotalSeconds) / requests : 0.150;  // W: seconds
        lastCount = count; lastTotalSeconds = totalSeconds; lastSampleNanos = now;

        // Little's Law: L = λW, plus 50% headroom, clamped to safe bounds
        int steadyState = (int) Math.ceil(arrivalRate * avgLatency);
        int newCore = Math.max(10, Math.min(steadyState, 500));
        int newMax  = Math.max(newCore, Math.min((int) (steadyState * 1.5), 600));

        if (newMax != pool.getMaxPoolSize() || newCore != pool.getCorePoolSize()) {
            log.info("Resizing payment pool: core={}->{} max={}->{} (λ={} req/s, W={} ms)",
                pool.getCorePoolSize(), newCore, pool.getMaxPoolSize(), newMax,
                Math.round(arrivalRate), Math.round(avgLatency * 1000));

            // Order matters: core may never exceed max (IllegalArgumentException)
            if (newMax >= pool.getMaxPoolSize()) {
                pool.setMaxPoolSize(newMax);
                pool.setCorePoolSize(newCore);
            } else {
                pool.setCorePoolSize(newCore);
                pool.setMaxPoolSize(newMax);
            }
            targetMax.set(newMax);
        }
    }
}
```

---

## Common Sizing Mistakes in Financial Services

| Mistake | Impact | Fix |
|---------|--------|-----|
| `corePoolSize = 10, maxPoolSize = 200, queue = 10000` | 10,000 requests queue up silently; p99 spikes to minutes | Set `queue = 50`, let callers see 503 and retry |
| `maxPoolSize = Integer.MAX_VALUE` | OOM under load — millions of threads created | Cap at Little's Law p99 estimate + buffer |
| Same pool for real-time and batch | Batch jobs fill pool, block authorizations | Separate pools for real-time vs batch workloads |
| Never monitoring pool metrics | Sizing issues invisible until outage | Alert on utilisation > 80% and queue depth > 20 |
| `corePoolSize = maxPoolSize = 500` | 500 threads kept alive at idle, reserving ~500MB of stack address space plus kernel resources | Use `allowCoreThreadTimeOut(true)` and low core |
| Hardcoded pool size in code | Cannot tune without redeploy | Externalize via `@Value` / Spring config |

---

## Sizing Decision Reference

```
┌─────────────────────────────────────────────────────────────────┐
│                   Thread Pool Sizing Checklist                  │
├─────────────────────────────────────────────────────────────────┤
│ 1. Measure λ (arrival rate) under peak load                     │
│ 2. Measure W (avg latency) including p99                        │
│ 3. Calculate L = λW for steady state                            │
│ 4. Calculate L_p99 = λ × W_p99 for spike headroom              │
│ 5. Set corePoolSize = L (steady state)                          │
│ 6. Set maxPoolSize = L_p99 (used only once the queue is full)   │
│ 7. Set queueCapacity = small (10-100) for real-time services    │
│ 8. Register pool metrics with Micrometer                        │
│ 9. Alert on utilisation > 80%, queue depth > 20                 │
│10. Separate pools for real-time vs batch workloads              │
│11. Consider virtual threads for IO-bound Java 21 services       │
└─────────────────────────────────────────────────────────────────┘
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment authorization service processes 500 requests/second with an average latency of 20ms. Using Little's Law, what thread pool size is needed for steady-state operation?",
      "options": [
        "5 threads",
        "10 threads",
        "25 threads",
        "500 threads"
      ],
      "correct": 1,
      "explanation": "Little's Law: L = λ × W. λ = 500 req/s, W = 0.020 s. L = 500 × 0.020 = 10 threads. This is the steady-state concurrency. The pool should be sized to L at steady state, with maxPoolSize at L_p99 to handle spikes."
    },
    {
      "text": "Why is setting corePoolSize=10, maxPoolSize=200, and queueCapacity=10000 dangerous for a payment authorization service?",
      "options": [
        "The queue is too small; requests will be rejected immediately at 11 concurrent requests",
        "With a 10,000-item queue, latency spikes are hidden — 10,000 requests can queue silently while average response time climbs to minutes, and callers receive no backpressure signal",
        "maxPoolSize=200 creates too many threads; the JVM cannot manage more than 100 threads",
        "corePoolSize and maxPoolSize must always be equal; different values cause race conditions"
      ],
      "correct": 1,
      "explanation": "A 10,000-item queue means the pool will not create additional threads beyond corePoolSize until the queue fills. During a database slowdown, 10,000 requests queue silently and each waits while the queue drains. P99 latency can reach minutes while the service appears to be handling load. Keep queueCapacity small (50-100) to surface backpressure to callers immediately."
    },
    {
      "text": "When should you use separate thread pools for different payment operations rather than one shared pool?",
      "options": [
        "Always — each payment operation type must have its own thread pool for correctness",
        "When a slow or bursty workload type (batch settlement) could starve time-sensitive workloads (real-time authorization) by occupying all pool threads",
        "Only when the service processes more than 10,000 TPS",
        "Thread pool isolation is only needed for reactive services; blocking services can share pools"
      ],
      "correct": 1,
      "explanation": "If batch settlement jobs and real-time authorization share a thread pool, settlement jobs can fill all pool threads during a batch run, leaving no threads for authorizations. Payment SLAs require sub-100ms authorization; a shared pool with settlement creates unbounded latency. Use separate pools with separate sizing, monitoring, and queue limits."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Thread Pool Sizing and Monitoring for a Payment Authorization Service",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Using Little's Law, calculate the corePoolSize, maxPoolSize, and queueCapacity for a payment authorization service handling 1000 req/s at P50=15ms, P99=80ms, with a target SLO of 150ms P99."},
    {"id": "2", "description": "Create a PaymentThreadPoolConfig class that defines separate ThreadPoolTaskExecutor beans for real-time authorization, batch settlement, and async notifications, each with appropriate sizing and an externalized configuration via @Value."},
    {"id": "3", "description": "Implement Micrometer metrics for each pool: active threads, queue depth, completed tasks, and rejection count. Configure alerts when utilization exceeds 80% or queue depth exceeds 20."},
    {"id": "4", "description": "Write a load test using ExecutorService that simulates 1500 req/s sustained for 30 seconds and 3000 req/s for a 5-second spike, then plots pool utilization over time to validate the sizing."}
  ]
}
-->

