---
id: track-08-lesson-09
title: "Load Shedding — Graceful Degradation Under Pressure"
slug: load-shedding
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 9
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [load-shedding, graceful-degradation, priority-queue, admission-control]
prerequisites: []
---

# Load Shedding — Graceful Degradation Under Pressure

> [!NOTE]
> When a system cannot serve all requests, the worst possible outcome is serving none of them well. Load shedding is the discipline of deciding which requests to drop so that the remaining requests succeed.

## 1. Load Shedding vs Rate Limiting

These two patterns are frequently confused but serve different purposes.

| Dimension | Rate Limiting | Load Shedding |
|---|---|---|
| Trigger | Per-client quota enforcement | System-wide capacity protection |
| Decision basis | "Client X has used Y calls" | "System CPU / queue depth / memory at Z%" |
| Response | `429 Too Many Requests` | `503 Service Unavailable` |
| Client implications | "You're over your limit — wait" | "System is overloaded — retry later" |
| Example | API gateway limits per API key | Payment service sheds analytics requests when DB is saturated |

**Rate limiting** is a client-protection tool and a revenue/fairness control.

**Load shedding** is a system-survival tool. When load exceeds system capacity, something must give. Load shedding decides what gives in a controlled, prioritized way — rather than letting the entire system thrash and fail unpredictably.

## 2. Priority-Based Admission Control

Not all requests are equal in a payment system. During overload, preserve the most critical operations.

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
}

@Component
@RequiredArgsConstructor
public class PriorityAdmissionController {

    private final SystemLoadMonitor loadMonitor;
    private final MeterRegistry meterRegistry;

    /**
     * Admission decision based on system load and request priority.
     * Returns true if the request should be admitted, false if it should be shed.
     */
    public boolean shouldAdmit(RequestPriority priority) {
        double currentLoad = loadMonitor.getCurrentLoadRatio();

        boolean admitted = switch (priority) {
            case CRITICAL -> true;  // Never shed critical requests
            case HIGH -> currentLoad < 0.90;
            case NORMAL -> currentLoad < 0.75;
            case LOW -> currentLoad < 0.60;
            case BACKGROUND -> currentLoad < 0.50;
        };

        meterRegistry.counter("admission.control",
            "priority", priority.name(),
            "outcome", admitted ? "admitted" : "shed",
            "load_bucket", loadBucket(currentLoad)
        ).increment();

        if (!admitted) {
            log.warn("Shedding {} priority request: currentLoad={:.1f}%",
                priority.name(), currentLoad * 100);
        }

        return admitted;
    }

    private String loadBucket(double load) {
        if (load < 0.5) return "low";
        if (load < 0.75) return "medium";
        if (load < 0.9) return "high";
        return "critical";
    }
}
```

## 3. System Load Monitor

```java
/**
 * Composite system load metric.
 * Combines CPU, memory, DB connection pool saturation,
 * and request queue depth into a single 0.0–1.0 load ratio.
 */
@Component
@RequiredArgsConstructor
public class SystemLoadMonitor {

    private final HikariDataSource dataSource;
    private final MeterRegistry meterRegistry;

    private volatile double currentLoadRatio = 0.0;

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

        meterRegistry.gauge("system.load.composite", currentLoadRatio);
    }

    public double getCurrentLoadRatio() {
        return currentLoadRatio;
    }

    private double getCpuLoad() {
        OperatingSystemMXBean os =
            (OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        double load = os.getProcessCpuLoad();
        return Double.isNaN(load) ? 0.0 : load;
    }

    private double getHeapMemoryLoad() {
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
        MemoryUsage heap = memory.getHeapMemoryUsage();
        return (double) heap.getUsed() / heap.getMax();
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
        // Monitor thread pool queue depth
        // Obtain from ThreadPoolExecutor metrics
        return requestQueueDepthGauge.value() / maxQueueDepth;
    }
}
```

## 4. Load Shedding Filter

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
 * Classify incoming requests by priority based on URI, method, and headers.
 */
@Component
public class RequestPriorityClassifier {

    private static final Map<String, RequestPriority> URI_PRIORITIES = Map.of(
        "/api/v1/payments", RequestPriority.CRITICAL,
        "/api/v1/payments/authorize", RequestPriority.CRITICAL,
        "/api/v1/accounts/{id}/balance", RequestPriority.HIGH,
        "/api/v1/payments/{id}/status", RequestPriority.HIGH,
        "/api/v1/accounts/{id}/transactions", RequestPriority.NORMAL,
        "/api/v1/accounts/{id}/statements", RequestPriority.LOW,
        "/api/v1/analytics", RequestPriority.BACKGROUND,
        "/api/v1/reports", RequestPriority.BACKGROUND
    );

    public RequestPriority classify(HttpServletRequest request) {
        // Internal system calls (service-to-service) get elevated priority
        String internalHeader = request.getHeader("X-Internal-Service");
        if (internalHeader != null && isKnownInternalService(internalHeader)) {
            return RequestPriority.HIGH;
        }

        // Check URI pattern
        String uri = request.getRequestURI();
        return URI_PRIORITIES.entrySet().stream()
            .filter(e -> uriMatches(uri, e.getKey()))
            .map(Map.Entry::getValue)
            .findFirst()
            .orElse(RequestPriority.NORMAL);
    }
}
```

## 5. Circuit Breaker as Load Shedder

Resilience4j's circuit breaker inherently acts as a load shedder — when open, it immediately rejects calls without consuming downstream capacity.

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
     * FAIL OPEN: allow payment through with elevated monitoring.
     * Fail-safe behavior: a delayed fraud decision is better than
     * blocking a customer's legitimate payment.
     */
    public FraudDecision fraudCheckFallback(PaymentRequest request,
                                             CallNotPermittedException ex) {
        log.warn("Fraud service circuit open — failing open for payment key={}",
            request.getIdempotencyKey());

        // Record for async fraud review
        asyncFraudReviewQueue.add(request);

        return FraudDecision.builder()
            .decision(FraudDecisionType.ALLOW_WITH_MONITORING)
            .riskScore(null)  // Unknown — pending async evaluation
            .reason("Fraud service temporarily unavailable — pending review")
            .build();
    }
}
```

## 6. Graceful Degradation Modes

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
     * READ_ONLY_HISTORY: Transaction history served from cache only.
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

    private final SystemLoadMonitor loadMonitor;
    private volatile ServiceMode currentMode = ServiceMode.FULL;

    @Scheduled(fixedDelay = 5_000)  // Re-evaluate every 5s
    public void updateServiceMode() {
        double load = loadMonitor.getCurrentLoadRatio();
        ServiceMode newMode = determineMode(load);

        if (newMode != currentMode) {
            log.warn("SERVICE MODE CHANGE: {} → {} (load={:.1f}%)",
                currentMode, newMode, load * 100);
            currentMode = newMode;
            publishModeChangeEvent(newMode);
        }
    }

    private ServiceMode determineMode(double load) {
        if (load < 0.60) return ServiceMode.FULL;
        if (load < 0.75) return ServiceMode.DEGRADED_ANALYTICS;
        if (load < 0.90) return ServiceMode.DEGRADED_HISTORY;
        return ServiceMode.PAYMENTS_ONLY;
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
            @PathVariable String accountId,
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

## 7. Payment Priority Queues

```java
/**
 * Priority-ordered processing queue for payment events.
 * Under load, real-time payments are processed before batch payments.
 */
@Configuration
public class PaymentPriorityQueueConfig {

    @Bean
    public PriorityBlockingQueue<PrioritizedPayment> paymentProcessingQueue() {
        // Comparator: lower priority number = higher queue priority
        return new PriorityBlockingQueue<>(1000,
            Comparator.comparingInt(p -> p.getPriority().getLevel()));
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

## 8. Queue Depth Monitoring

```java
@Component
@RequiredArgsConstructor
public class QueueDepthMonitoring {

    private final PriorityBlockingQueue<PrioritizedPayment> queue;
    private final MeterRegistry meterRegistry;
    private final AlertingService alerting;

    @Scheduled(fixedDelay = 5_000)
    public void monitorQueueDepth() {
        int totalDepth = queue.size();

        // Count by priority
        Map<RequestPriority, Long> depthByPriority = queue.stream()
            .collect(Collectors.groupingBy(PrioritizedPayment::getPriority,
                Collectors.counting()));

        depthByPriority.forEach((priority, count) ->
            meterRegistry.gauge("payment.queue.depth",
                Tags.of("priority", priority.name()), count));

        // Alert on queue buildup
        long criticalBacklog = depthByPriority.getOrDefault(
            RequestPriority.CRITICAL, 0L);
        if (criticalBacklog > 100) {
            alerting.page(PagerDutyAlert.critical(
                "Critical payment queue depth: " + criticalBacklog +
                " — processing may be falling behind"));
        }

        // Find oldest payment in queue
        queue.stream()
            .min(Comparator.comparing(PrioritizedPayment::getEnqueuedAt))
            .ifPresent(oldest -> {
                long waitSeconds = Duration.between(oldest.getEnqueuedAt(),
                    Instant.now()).toSeconds();
                meterRegistry.gauge("payment.queue.oldest.wait.seconds",
                    Tags.of("priority", oldest.getPriority().name()), waitSeconds);
            });
    }
}
```

## 9. Spring Boot Actuator Integration for Load Shedding

```java
/**
 * Custom Actuator endpoint exposing load shedding state.
 * Ops teams use this to understand current service mode.
 */
@Component
@Endpoint(id = "loadShedding")
@RequiredArgsConstructor
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
            "admissionPolicy", Map.of(
                "CRITICAL", "always admitted",
                "HIGH", admissionController.shouldAdmit(RequestPriority.HIGH)
                    ? "admitted" : "SHED",
                "NORMAL", admissionController.shouldAdmit(RequestPriority.NORMAL)
                    ? "admitted" : "SHED",
                "LOW", admissionController.shouldAdmit(RequestPriority.LOW)
                    ? "admitted" : "SHED",
                "BACKGROUND", admissionController.shouldAdmit(RequestPriority.BACKGROUND)
                    ? "admitted" : "SHED"
            ),
            "timestamp", Instant.now()
        );
    }

    @WriteOperation
    public void setManualMode(@Selector String mode) {
        // Allow ops to manually force a service mode (emergency override)
        ServiceMode newMode = ServiceMode.valueOf(mode.toUpperCase());
        modeManager.setManualOverride(newMode);
        log.warn("SERVICE MODE MANUALLY OVERRIDDEN to {} by actuator call", newMode);
    }
}
```

## 10. Graduated Load Shedding with Backpressure

```java
/**
 * Graduated load shedding — probabilistic shedding that scales with load.
 * At 70% load, shed 10% of LOW priority requests.
 * At 80% load, shed 50% of LOW priority requests.
 * At 90% load, shed 100% of LOW priority requests.
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

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What HTTP status code should a payment service return when it sheds a request due to system overload?",
      "options": ["429 Too Many Requests", "503 Service Unavailable", "504 Gateway Timeout", "400 Bad Request"],
      "correct": 1,
      "explanation": "503 Service Unavailable signals that the system is temporarily unable to handle the request due to overload. 429 is used for per-client rate limiting (quota enforcement), not system-wide load shedding."
    },
    {
      "text": "During severe overload (>90% capacity), which request type should NEVER be shed in a payment service?",
      "options": ["Account history queries", "Analytics dashboard requests", "Real-time payment submissions", "Monthly statement generation"],
      "correct": 2,
      "explanation": "Real-time payment submissions are CRITICAL priority and should never be shed. If the service cannot process payments at all, it is effectively down. Analytics, history, and batch reports are lower priority and can be safely deferred or rejected."
    },
    {
      "text": "What is the advantage of graduated (probabilistic) load shedding over hard threshold-based shedding?",
      "options": ["It is easier to implement", "It creates a gradual pressure valve that provides early relief before full shedding kicks in", "It guarantees all requests eventually get served", "It eliminates the need for priority classification"],
      "correct": 1,
      "explanation": "Graduated shedding starts probabilistically dropping requests as load approaches the threshold (e.g., 10% shed at 70% load, 50% at 80%, 100% at 90%). This provides earlier relief to the system than a hard cutoff which suddenly rejects everything at the threshold."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Priority-Based Admission Control System for Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a SystemLoadMonitor that computes a composite 0.0–1.0 load ratio from CPU (20%), heap memory (15%), HikariCP active+pending connections (40%), and request queue depth (25%), updated every second and published as a Prometheus gauge."},
    {"id": "2", "description": "Build a LoadSheddingFilter (highest precedence) that classifies incoming requests by URI pattern into CRITICAL/HIGH/NORMAL/LOW/BACKGROUND priority levels, calls a GraduatedAdmissionController, and returns 503 with Retry-After header for shed requests."},
    {"id": "3", "description": "Implement a ServiceModeManager with FULL/DEGRADED_ANALYTICS/DEGRADED_HISTORY/PAYMENTS_ONLY modes, re-evaluated every 5 seconds, that publishes mode change events and exposes a manual override via Actuator write operation."},
    {"id": "4", "description": "Create a PriorityBlockingQueue-based payment processor that maps payment types (REAL_TIME, CARD_AUTH, ACH_SAME_DAY, ACH_STANDARD, BATCH) to priority levels, records per-priority queue wait times in Prometheus, and pages on-call when CRITICAL payments wait longer than 5 seconds."}
  ]
}
-->

