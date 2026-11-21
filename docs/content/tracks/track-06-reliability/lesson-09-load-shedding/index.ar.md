---
id: track-06-lesson-09
title: "التخلّص من الحمل — التراجع المنظَّم تحت الضغط"
slug: load-shedding
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 9
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [load-shedding, graceful-degradation, priority-queue, admission-control]
prerequisites: []
---

# تخفيف الحمل (Load Shedding) — التدهور الرشيق تحت الضغط

> [!NOTE]
> عندما لا يستطيع نظام خدمة كل الطلبات، تكون أسوأ نتيجة ممكنة ألا يخدم أيًا منها جيدًا. وتخفيف الحمل هو انضباط تحديد الطلبات التي تُسقط لتنجح الطلبات المتبقية.

## 1. تخفيف الحمل مقابل تحديد المعدل

كثيرًا ما يُخلط بين هذين النمطين لكنهما يخدمان أغراضًا مختلفة.

| البُعد | تحديد المعدل | تخفيف الحمل |
|---|---|---|
| المحفّز | فرض حصة لكل عميل | حماية السعة على مستوى النظام |
| أساس القرار | "استخدم العميل X عدد Y من الاستدعاءات" | "المعالج / عمق الطابور / الذاكرة في النظام عند Z%" |
| الرد | `429 Too Many Requests` | `503 Service Unavailable` |
| دلالة للعميل | "تجاوزت حدك — انتظر" | "النظام محمّل — أعد المحاولة لاحقًا" |
| مثال | بوابة واجهات تحدد لكل مفتاح API | خدمة دفع تُسقط طلبات التحليلات عندما تتشبع قاعدة البيانات |

**تحديد المعدل** أداة لحماية العملاء وضبط للإيرادات/العدالة.

**تخفيف الحمل** أداة لبقاء النظام. فعندما يتجاوز الحمل سعة النظام، يجب أن يتنازل شيء. ويقرر تخفيف الحمل ما الذي يتنازل بطريقة محكومة ومرتبة حسب الأولوية — بدل ترك النظام كله يتخبط ويفشل بشكل غير متوقع.

## 2. التحكم في القبول حسب الأولوية

ليست كل الطلبات متساوية في نظام الدفع. فأثناء الحمل الزائد، احفظ العمليات الأكثر حرجًا.

```java
/**
 * Request priority levels for payment service.
 * Higher priority requests are admitted first during overload.
 * Lower priority requests are shed first.
 */
public enum RequestPriority {

    /**
     * CRITICAL: Real-money payment transactions.
     * Never shed. If we can't process these, we're down.
     * Examples: payment submission, authorization
     */
    CRITICAL(1),

    /**
     * HIGH: User-facing time-sensitive operations.
     * Shed only in severe overload (>90% capacity).
     * Examples: balance inquiry, payment status, fraud check
     */
    HIGH(2),

    /**
     * NORMAL: Standard operational requests.
     * Shed at >75% capacity.
     * Examples: account history, notifications, settings updates
     */
    NORMAL(3),

    /**
     * LOW: Background and reporting operations.
     * Shed at >60% capacity. Can always be retried later.
     * Examples: analytics queries, batch reports, non-urgent exports
     */
    LOW(4),

    /**
     * BACKGROUND: Housekeeping and batch processing.
     * Shed at >50% capacity. These run during off-peak anyway.
     * Examples: statement generation, reconciliation reports
     */
    BACKGROUND(5);

    private final int level;

    RequestPriority(int level) { this.level = level; }

    public int getLevel() { return level; }
}

@Component
@RequiredArgsConstructor
@Slf4j
public class PriorityAdmissionController {

    private final SystemLoadMonitor loadMonitor;
    private final MeterRegistry meterRegistry;

    /**
     * Admission decision based on system load and request priority.
     * Returns true if the request should be admitted, false if it should be shed.
     */
    public boolean shouldAdmit(RequestPriority priority) {
        double currentLoad = loadMonitor.getCurrentLoadRatio();
        boolean admitted = wouldAdmit(priority, currentLoad);

        meterRegistry.counter("admission.control",
            "priority", priority.name(),
            "outcome", admitted ? "admitted" : "shed",
            "load_bucket", loadBucket(currentLoad)
        ).increment();

        if (!admitted) {
            // SLF4J has no {:.1f} placeholders — format first
            log.warn("Shedding {} priority request: currentLoad={}%",
                priority.name(), String.format("%.1f", currentLoad * 100));
        }

        return admitted;
    }

    /** Pure decision — no metrics, no logging (safe for status endpoints). */
    public boolean wouldAdmit(RequestPriority priority, double currentLoad) {
        return switch (priority) {
            // CRITICAL is never shed for the sake of lower priorities — but a
            // hard concurrency limit (bulkhead) still protects the service
            // from being overrun by critical traffic alone
            case CRITICAL -> true;
            case HIGH -> currentLoad < 0.90;
            case NORMAL -> currentLoad < 0.75;
            case LOW -> currentLoad < 0.60;
            case BACKGROUND -> currentLoad < 0.50;
        };
    }

    private String loadBucket(double load) {
        if (load < 0.5) return "low";
        if (load < 0.75) return "medium";
        if (load < 0.9) return "high";
        return "critical";
    }
}
```

## 3. مراقب حمل النظام

```java
/**
 * Composite system load metric.
 * Combines CPU, memory, DB connection pool saturation,
 * and request queue depth into a single 0.0–1.0 load ratio.
 */
@Component
public class SystemLoadMonitor {

    private final HikariDataSource dataSource;
    private final ThreadPoolTaskExecutor requestExecutor;   // where request work queues up

    private volatile double currentLoadRatio = 0.0;

    public SystemLoadMonitor(HikariDataSource dataSource,
                             ThreadPoolTaskExecutor requestExecutor,
                             MeterRegistry meterRegistry) {
        this.dataSource = dataSource;
        this.requestExecutor = requestExecutor;
        // Register the gauge ONCE; it reads the field on every scrape.
        // (Calling meterRegistry.gauge(name, aDouble) every second registers a
        //  boxed value that is garbage-collected — the gauge then reports NaN.)
        Gauge.builder("system.load.composite", this, m -> m.currentLoadRatio)
             .register(meterRegistry);
    }

    @Scheduled(fixedDelay = 1_000)  // Update every second
    public void updateLoadRatio() {
        double cpuLoad = getCpuLoad();
        double memoryLoad = getHeapMemoryLoad();
        double dbPoolLoad = getDbConnectionPoolLoad();
        double requestQueueLoad = getRequestQueueLoad();

        // Weighted composite: DB pool most critical for payment service
        currentLoadRatio = (cpuLoad * 0.20)
            + (memoryLoad * 0.15)
            + (dbPoolLoad * 0.40)     // DB pool is the most common bottleneck
            + (requestQueueLoad * 0.25);
    }

    public double getCurrentLoadRatio() {
        return currentLoadRatio;
    }

    private double getCpuLoad() {
        // com.sun.management.OperatingSystemMXBean (not java.lang.management)
        OperatingSystemMXBean os =
            (OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        double load = os.getProcessCpuLoad();
        return (Double.isNaN(load) || load < 0) ? 0.0 : load;
    }

    private double getHeapMemoryLoad() {
        // Heap use is a noisy signal (it saw-tooths with GC) — keep its weight low
        MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        long max = heap.getMax();
        return max <= 0 ? 0.0 : (double) heap.getUsed() / max;   // getMax() can be -1
    }

    private double getDbConnectionPoolLoad() {
        HikariPoolMXBean pool = dataSource.getHikariPoolMXBean();
        int active = pool.getActiveConnections();
        int max = dataSource.getMaximumPoolSize();
        int pending = pool.getThreadsAwaitingConnection();
        // Pending threads signals pool is exhausted
        return Math.min(1.0, (active + pending * 2.0) / max);
    }

    private double getRequestQueueLoad() {
        // Queue depth of the executor that runs request work
        ThreadPoolExecutor executor = requestExecutor.getThreadPoolExecutor();
        int depth = executor.getQueue().size();
        int capacity = depth + executor.getQueue().remainingCapacity();
        return capacity == 0 ? 0.0 : Math.min(1.0, (double) depth / capacity);
    }
}
```

## 4. مرشّح تخفيف الحمل

```java
/**
 * Servlet filter that enforces load shedding before requests hit business logic.
 * Runs early in the filter chain — before authentication, rate limiting, etc.
 */
@Component
@RequiredArgsConstructor
@Order(Ordered.HIGHEST_PRECEDENCE + 1)  // Near the top of filter chain
public class LoadSheddingFilter extends OncePerRequestFilter {

    private final PriorityAdmissionController admissionController;
    private final RequestPriorityClassifier priorityClassifier;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                     HttpServletResponse response,
                                     FilterChain filterChain)
            throws ServletException, IOException {

        RequestPriority priority = priorityClassifier.classify(request);

        if (!admissionController.shouldAdmit(priority)) {
            response.setStatus(HttpStatus.SERVICE_UNAVAILABLE.value());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.setHeader("Retry-After", "10");  // Hint: retry in 10s
            response.getWriter().write("""
                {
                  "error": "service_overloaded",
                  "message": "Service is currently under high load. Please retry.",
                  "retryAfterSeconds": 10,
                  "requestPriority": "%s"
                }
                """.formatted(priority.name()));
            return;
        }

        filterChain.doFilter(request, response);
    }
}

/**
 * Classify incoming requests by priority based on URI, method, and caller.
 */
@Component
public class RequestPriorityClassifier {

    // ORDERED, most specific first: Map.of() has no defined iteration order,
    // so "/api/v1/payments" could match "/api/v1/payments/{id}/status" first
    private static final List<Map.Entry<String, RequestPriority>> URI_PRIORITIES = List.of(
        Map.entry("/api/v1/payments/{id}/status", RequestPriority.HIGH),
        Map.entry("/api/v1/payments/authorize", RequestPriority.CRITICAL),
        Map.entry("/api/v1/payments", RequestPriority.CRITICAL),
        Map.entry("/api/v1/accounts/{id}/balance", RequestPriority.HIGH),
        Map.entry("/api/v1/accounts/{id}/transactions", RequestPriority.NORMAL),
        Map.entry("/api/v1/accounts/{id}/statements", RequestPriority.LOW),
        Map.entry("/api/v1/analytics", RequestPriority.BACKGROUND),
        Map.entry("/api/v1/reports", RequestPriority.BACKGROUND)
    );

    public RequestPriority classify(HttpServletRequest request) {
        // Internal system calls (service-to-service) get elevated priority —
        // but only when the caller's identity is PROVEN (mTLS / service mesh).
        // A plain header such as X-Internal-Service can be set by anyone.
        String verifiedService = (String) request.getAttribute("verified.client.service");
        if (verifiedService != null && isKnownInternalService(verifiedService)) {
            return RequestPriority.HIGH;
        }

        // Check URI pattern
        String uri = request.getRequestURI();
        return URI_PRIORITIES.stream()
            .filter(e -> uriMatches(uri, e.getKey()))
            .map(Map.Entry::getValue)
            .findFirst()
            .orElse(RequestPriority.NORMAL);
    }
}
```

## 5. قاطع الدائرة كمخفف للحمل

يعمل قاطع الدائرة في Resilience4j بطبيعته كمخفف للحمل — فعندما يكون مفتوحًا، يرفض الاستدعاءات فورًا دون استهلاك سعة الخدمة اللاحقة.

```java
@Configuration
public class CircuitBreakerAsLoadShedder {

    /**
     * Configure circuit breaker to shed load based on slow call rate.
     * When 80% of calls to fraud service take > 500ms, open the circuit.
     * This protects the payment service from fraud service overload propagating.
     */
    @Bean
    public CircuitBreakerConfig fraudServiceCbConfig() {
        return CircuitBreakerConfig.custom()
            .slidingWindowType(SlidingWindowType.TIME_BASED)
            .slidingWindowSize(60)                    // Last 60 seconds
            .failureRateThreshold(50)                  // Open if 50% fail
            .slowCallRateThreshold(80)                 // Open if 80% are slow
            .slowCallDurationThreshold(Duration.ofMillis(500))  // "Slow" = > 500ms
            .waitDurationInOpenState(Duration.ofSeconds(30))
            .permittedNumberOfCallsInHalfOpenState(5)
            .build();
    }
}

@Service
@RequiredArgsConstructor
public class LoadSheddingFraudService {

    @CircuitBreaker(name = "fraud-service", fallbackMethod = "fraudCheckFallback")
    public FraudDecision checkFraud(PaymentRequest request) {
        return fraudClient.evaluate(request);
    }

    /**
     * Fallback when fraud service is overloaded (circuit open).
     * Documented RISK decision (agreed with the fraud team): fail open only
     * below a low amount threshold, with async review; above it, hold the
     * payment for review instead of letting it through unchecked.
     */
    public FraudDecision fraudCheckFallback(PaymentRequest request,
                                             CallNotPermittedException ex) {
        if (request.getAmountMinor() > FAIL_OPEN_LIMIT_MINOR) {
            return FraudDecision.builder()
                .decision(FraudDecisionType.HOLD_FOR_REVIEW)
                .reason("Fraud service unavailable — held for review")
                .build();
        }
        log.warn("Fraud service circuit open — failing open for payment key={}",
            request.getIdempotencyKey());

        // Record for async fraud review (durably — e.g. an outbox row)
        asyncFraudReviewQueue.add(request);

        return FraudDecision.builder()
            .decision(FraudDecisionType.ALLOW_WITH_MONITORING)
            .riskScore(null)  // Unknown — pending async evaluation
            .reason("Fraud service temporarily unavailable — pending review")
            .build();
    }
}
```

## 6. أنماط التدهور الرشيق

```java
/**
 * Service degradation modes — defined from most to least functional.
 * Transition between modes based on system load.
 */
public enum ServiceMode {

    /**
     * FULL: All functionality available.
     * Load: < 60%
     */
    FULL,

    /**
     * DEGRADED_ANALYTICS: Analytics and reporting disabled.
     * Load: 60–75%
     * Impact: Dashboards show cached data; reports queued
     */
    DEGRADED_ANALYTICS,

    /**
     * DEGRADED_HISTORY: Transaction history served from cache only.
     * Load: 75–90%
     * Impact: History may be up to 5 minutes stale
     */
    DEGRADED_HISTORY,

    /**
     * PAYMENTS_ONLY: Only payment processing endpoints active.
     * All account management, history, settings disabled.
     * Load: > 90%
     * Impact: Significant — users can pay but can't manage accounts
     */
    PAYMENTS_ONLY
}

@Service
@RequiredArgsConstructor
@Slf4j
public class ServiceModeManager {

    private static final double HYSTERESIS = 0.05;   // step DOWN only 5 points below a threshold

    private final SystemLoadMonitor loadMonitor;
    private volatile ServiceMode currentMode = ServiceMode.FULL;
    private volatile ServiceMode manualOverride;      // set by ops via Actuator; null = automatic

    @Scheduled(fixedDelay = 5_000)  // Re-evaluate every 5s
    public void updateServiceMode() {
        double load = loadMonitor.getCurrentLoadRatio();
        ServiceMode newMode = manualOverride != null ? manualOverride : determineMode(load);

        if (newMode != currentMode) {
            log.warn("SERVICE MODE CHANGE: {} → {} (load={}%)",
                currentMode, newMode, String.format("%.1f", load * 100));
            currentMode = newMode;
            publishModeChangeEvent(newMode);
        }
    }

    private ServiceMode determineMode(double load) {
        ServiceMode byLoad;
        if (load < 0.60) byLoad = ServiceMode.FULL;
        else if (load < 0.75) byLoad = ServiceMode.DEGRADED_ANALYTICS;
        else if (load < 0.90) byLoad = ServiceMode.DEGRADED_HISTORY;
        else byLoad = ServiceMode.PAYMENTS_ONLY;

        // Hysteresis: moving to a MORE degraded mode happens at once; moving
        // back up only once load is clearly below that mode's threshold —
        // otherwise a load hovering at 75% flips the mode every 5 seconds
        if (byLoad.ordinal() < currentMode.ordinal()
                && load > thresholdOf(currentMode) - HYSTERESIS) {
            return currentMode;
        }
        return byLoad;
    }

    private double thresholdOf(ServiceMode mode) {
        return switch (mode) {
            case FULL -> 0.0;
            case DEGRADED_ANALYTICS -> 0.60;
            case DEGRADED_HISTORY -> 0.75;
            case PAYMENTS_ONLY -> 0.90;
        };
    }

    public void setManualOverride(ServiceMode mode) {   // null clears it
        this.manualOverride = mode;
    }

    public ServiceMode getCurrentMode() {
        return currentMode;
    }
}

@RestController
@RequiredArgsConstructor
public class AccountController {

    private final ServiceModeManager modeManager;
    private final AccountService accountService;
    private final TransactionCacheService transactionCacheService;

    @GetMapping("/api/v1/accounts/{id}/transactions")
    public ResponseEntity<List<Transaction>> getTransactions(
            @PathVariable("id") String accountId,   // must match {id} in the path
            @RequestParam(defaultValue = "0") int page) {

        ServiceMode mode = modeManager.getCurrentMode();

        // In payments-only mode: reject non-payment requests
        if (mode == ServiceMode.PAYMENTS_ONLY) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "60")
                .body(null);
        }

        // In degraded history mode: serve from cache only
        if (mode == ServiceMode.DEGRADED_HISTORY) {
            List<Transaction> cached = transactionCacheService
                .getCached(accountId, page);
            if (cached != null) {
                return ResponseEntity.ok()
                    .header("X-Cache-Status", "HIT")
                    .header("X-Data-Age-Seconds",
                        String.valueOf(transactionCacheService.getAgeSeconds(accountId)))
                    .body(cached);
            }
            // Cache miss in degraded mode — still serve 503
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "30")
                .body(null);
        }

        return ResponseEntity.ok(accountService.getTransactions(accountId, page));
    }
}
```

## 7. طوابير أولوية الدفع

```java
/**
 * Priority-ordered processing queue for payment events.
 * Under load, real-time payments are processed before batch payments.
 */
@Configuration
public class PaymentPriorityQueueConfig {

    @Bean
    public PriorityBlockingQueue<PrioritizedPayment> paymentProcessingQueue() {
        // Lower priority number = served first; FIFO within the same priority
        // (PriorityBlockingQueue gives no order among equal elements otherwise)
        return new PriorityBlockingQueue<>(1000,
            Comparator.comparingInt((PrioritizedPayment p) -> p.getPriority().getLevel())
                      .thenComparing(PrioritizedPayment::getEnqueuedAt));
        // CAUTION: 1000 is only the INITIAL capacity — this queue is unbounded.
        // Under overload it would grow until the heap runs out, which is the
        // opposite of load shedding. Enqueue through a guard that rejects
        // (503 / retry later) once size() passes a hard limit, and watch for
        // starvation of low priorities (age them if they wait too long).
    }
}

@Value
@Builder
public class PrioritizedPayment {

    PaymentRequest request;
    RequestPriority priority;
    Instant enqueuedAt;

    /**
     * Classify payment type into processing priority.
     */
    public static PrioritizedPayment of(PaymentRequest request) {
        RequestPriority priority = switch (request.getPaymentType()) {
            case REAL_TIME_PAYMENT -> RequestPriority.CRITICAL;
            case CARD_AUTHORIZATION -> RequestPriority.CRITICAL;
            case WIRE_TRANSFER -> RequestPriority.HIGH;
            case ACH_SAME_DAY -> RequestPriority.NORMAL;
            case ACH_STANDARD -> RequestPriority.LOW;
            case BATCH_SETTLEMENT -> RequestPriority.BACKGROUND;
        };
        return PrioritizedPayment.builder()
            .request(request)
            .priority(priority)
            .enqueuedAt(Instant.now())
            .build();
    }
}

@Service
@RequiredArgsConstructor
@Slf4j
public class PriorityPaymentProcessor {

    private final PriorityBlockingQueue<PrioritizedPayment> queue;
    private final PaymentProcessingService processingService;
    private final MeterRegistry meterRegistry;

    @Async("paymentProcessorPool")
    public void startProcessing() {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                PrioritizedPayment payment = queue.poll(1, TimeUnit.SECONDS);
                if (payment == null) continue;

                Duration queueWait = Duration.between(payment.getEnqueuedAt(),
                    Instant.now());

                meterRegistry.timer("payment.queue.wait",
                    "priority", payment.getPriority().name()
                ).record(queueWait);

                // Alert if critical payments are waiting too long
                // (the queue-depth monitor below pages; this logs the detail)
                if (payment.getPriority() == RequestPriority.CRITICAL &&
                        queueWait.toSeconds() > 5) {
                    log.error("CRITICAL payment waited {}s in queue — queue backlog?",
                        queueWait.toSeconds());
                }

                processingService.process(payment.getRequest());

            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }
}
```

## 8. مراقبة عمق الطابور

```java
@Component
public class QueueDepthMonitoring {

    private final PriorityBlockingQueue<PrioritizedPayment> queue;
    private final AlertingService alerting;
    // One holder per priority, registered ONCE as a gauge
    private final Map<RequestPriority, AtomicLong> depthByPriority = new EnumMap<>(RequestPriority.class);
    private final AtomicLong oldestWaitSeconds = new AtomicLong();

    public QueueDepthMonitoring(PriorityBlockingQueue<PrioritizedPayment> queue,
                                AlertingService alerting,
                                MeterRegistry meterRegistry) {
        this.queue = queue;
        this.alerting = alerting;
        for (RequestPriority priority : RequestPriority.values()) {
            AtomicLong holder = new AtomicLong();
            depthByPriority.put(priority, holder);
            meterRegistry.gauge("payment.queue.depth",
                Tags.of("priority", priority.name()), holder);
        }
        meterRegistry.gauge("payment.queue.oldest.wait.seconds", oldestWaitSeconds);
    }

    @Scheduled(fixedDelay = 5_000)
    public void monitorQueueDepth() {
        // Count by priority (iterates a snapshot of the queue)
        Map<RequestPriority, Long> counts = queue.stream()
            .collect(Collectors.groupingBy(PrioritizedPayment::getPriority,
                Collectors.counting()));
        depthByPriority.forEach((priority, holder) ->
            holder.set(counts.getOrDefault(priority, 0L)));

        // Alert on queue buildup
        long criticalBacklog = counts.getOrDefault(RequestPriority.CRITICAL, 0L);
        if (criticalBacklog > 100) {
            alerting.page(PagerDutyAlert.critical(
                "Critical payment queue depth: " + criticalBacklog +
                " — processing may be falling behind"));
        }

        // Oldest payment in queue
        oldestWaitSeconds.set(queue.stream()
            .map(PrioritizedPayment::getEnqueuedAt)
            .min(Comparator.naturalOrder())
            .map(t -> Duration.between(t, Instant.now()).toSeconds())
            .orElse(0L));
    }
}
```

## 9. تكامل Spring Boot Actuator لتخفيف الحمل

```java
/**
 * Custom Actuator endpoint exposing load shedding state.
 * Ops teams use this to understand current service mode.
 */
@Component
@Endpoint(id = "loadshedding")   // endpoint IDs: lowercase, no camelCase
@RequiredArgsConstructor
@Slf4j
public class LoadSheddingActuatorEndpoint {

    private final ServiceModeManager modeManager;
    private final SystemLoadMonitor loadMonitor;
    private final PriorityAdmissionController admissionController;

    @ReadOperation
    public Map<String, Object> getLoadSheddingStatus() {
        double currentLoad = loadMonitor.getCurrentLoadRatio();
        ServiceMode currentMode = modeManager.getCurrentMode();

        return Map.of(
            "currentMode", currentMode.name(),
            "systemLoad", String.format("%.1f%%", currentLoad * 100),
            // wouldAdmit(): a pure check — calling shouldAdmit() here would
            // record fake admission decisions in the metrics on every read
            "admissionPolicy", Map.of(
                "CRITICAL", "always admitted",
                "HIGH", admissionController.wouldAdmit(RequestPriority.HIGH, currentLoad)
                    ? "admitted" : "SHED",
                "NORMAL", admissionController.wouldAdmit(RequestPriority.NORMAL, currentLoad)
                    ? "admitted" : "SHED",
                "LOW", admissionController.wouldAdmit(RequestPriority.LOW, currentLoad)
                    ? "admitted" : "SHED",
                "BACKGROUND", admissionController.wouldAdmit(RequestPriority.BACKGROUND, currentLoad)
                    ? "admitted" : "SHED"
            ),
            "timestamp", Instant.now()
        );
    }

    @WriteOperation
    public void setManualMode(@Selector String mode) {
        // Allow ops to manually force a service mode (emergency override).
        // Expose only on a secured management port, and audit who called it.
        ServiceMode newMode = ServiceMode.valueOf(mode.toUpperCase());
        modeManager.setManualOverride(newMode);
        log.warn("SERVICE MODE MANUALLY OVERRIDDEN to {} by actuator call", newMode);
    }
}
```

## 10. تخفيف الحمل المتدرج مع الضغط العكسي

```java
/**
 * Graduated load shedding — probabilistic shedding that scales with load.
 * Each priority has a start threshold; above it the shed share rises
 * linearly to 100% at full load. For LOW (starts at 55%):
 *   70% load -> ~33% shed, 80% -> ~56% shed, 90% -> ~78% shed, 100% -> all.
 *
 * This creates a gradual pressure valve rather than a hard cutoff.
 */
@Component
public class GraduatedAdmissionController {

    public boolean shouldAdmit(RequestPriority priority, double currentLoad) {
        // Critical: always admit
        if (priority == RequestPriority.CRITICAL) return true;

        // Calculate shedding probability based on load and priority
        double sheddingProbability = calculateSheddingProbability(priority, currentLoad);

        if (sheddingProbability <= 0) return true;    // No shedding needed
        if (sheddingProbability >= 1) return false;   // Always shed

        // Probabilistic shedding
        return ThreadLocalRandom.current().nextDouble() >= sheddingProbability;
    }

    private double calculateSheddingProbability(RequestPriority priority,
                                                  double load) {
        // Priority-specific load thresholds
        double shedThreshold = switch (priority) {
            case HIGH -> 0.85;
            case NORMAL -> 0.70;
            case LOW -> 0.55;
            case BACKGROUND -> 0.45;
            default -> 0.90;
        };

        if (load <= shedThreshold) return 0.0;

        double loadOverThreshold = load - shedThreshold;
        double thresholdToFull = 1.0 - shedThreshold;

        // Linear ramp from 0% to 100% shedding as load goes from threshold to 100%
        return loadOverThreshold / thresholdToFull;
    }
}
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما رمز حالة HTTP الذي يجب أن تعيده خدمة دفع عندما تُسقط طلبًا بسبب حمل زائد على النظام؟",
      "options": ["429 Too Many Requests", "503 Service Unavailable", "504 Gateway Timeout", "400 Bad Request"],
      "correct": 1,
      "explanation": "يشير الرد 503 Service Unavailable إلى أن النظام غير قادر مؤقتًا على معالجة الطلب بسبب الحمل الزائد. أما 429 فيُستخدم لتحديد المعدل لكل عميل (فرض الحصص)، لا لتخفيف الحمل على مستوى النظام."
    },
    {
      "text": "أثناء حمل زائد شديد (أكثر من 90% من السعة)، أي نوع من الطلبات يجب ألا يُسقط أبدًا في خدمة دفع؟",
      "options": ["استعلامات سجل الحساب", "طلبات لوحة التحليلات", "إرسال المدفوعات الآنية", "توليد كشوف الحساب الشهرية"],
      "correct": 2,
      "explanation": "إرسال المدفوعات الآنية ذو أولوية CRITICAL ويجب ألا يُسقط أبدًا لصالح أولويات أدنى. فإذا لم تستطع الخدمة معالجة المدفوعات أصلًا، فهي معطلة فعليًا. أما التحليلات والسجل والتقارير الدفعية فأولوياتها أدنى ويمكن تأجيلها أو رفضها بأمان."
    },
    {
      "text": "ما ميزة تخفيف الحمل المتدرج (الاحتمالي) على التخفيف القائم على عتبة صارمة؟",
      "options": ["أسهل في التنفيذ", "ينشئ صمام ضغط تدريجيًا يوفر تخفيفًا مبكرًا قبل أن يبدأ التخفيف الكامل", "يضمن خدمة كل الطلبات في النهاية", "يلغي الحاجة إلى تصنيف الأولويات"],
      "correct": 1,
      "explanation": "يبدأ التخفيف المتدرج بإسقاط حصة متزايدة من الطلبات احتماليًا حين يتجاوز الحمل عتبة كل أولوية (مثلًا لطلبات LOW: نحو الثلث عند حمل 70%، وأكثر من النصف عند 80%، وكلها عند 100%). وهذا يعطي النظام تخفيفًا أبكر وأنعم من القطع الصارم، الذي يرفض فجأة كل طلبات تلك الأولوية عند مستوى حمل واحد بالضبط — ويجعل الحمل يتذبذب حوله."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "نظام تحكم في القبول حسب الأولوية لخدمة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ SystemLoadMonitor يحسب نسبة حمل مركبة من 0.0 إلى 1.0 من المعالج (20%)، وذاكرة الـ heap ‏(15%)، واتصالات HikariCP النشطة والمنتظرة (40%)، وعمق طابور الطلبات (25%)، تُحدّث كل ثانية وتُنشر كمقياس gauge في Prometheus."},
    {"id": "2", "description": "ابنِ LoadSheddingFilter (أعلى أسبقية) يصنف الطلبات الواردة حسب نمط URI إلى مستويات أولوية CRITICAL/HIGH/NORMAL/LOW/BACKGROUND، ويستدعي GraduatedAdmissionController، ويعيد 503 مع ترويسة Retry-After للطلبات المُسقطة."},
    {"id": "3", "description": "نفّذ ServiceModeManager بأنماط FULL/DEGRADED_ANALYTICS/DEGRADED_HISTORY/PAYMENTS_ONLY، يُعاد تقييمها كل 5 ثوانٍ، وينشر أحداث تغير النمط ويعرض تجاوزًا يدويًا عبر عملية كتابة في Actuator."},
    {"id": "4", "description": "أنشئ معالج دفع قائمًا على PriorityBlockingQueue يربط أنواع الدفع (REAL_TIME، وCARD_AUTH، وACH_SAME_DAY، وACH_STANDARD، وBATCH) بمستويات أولوية، ويسجل أزمنة الانتظار في الطابور لكل أولوية في Prometheus، ويستدعي المناوب عندما تنتظر مدفوعات CRITICAL أكثر من 5 ثوانٍ."}
  ]
}
-->
