---
id: track-06-lesson-06
title: "هندسة الفوضى — أيام الاختبار (GameDay) وحقن الأعطال"
slug: chaos-engineering
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 6
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [chaos-engineering, GameDay, Chaos-Monkey, failure-injection, resilience-testing]
prerequisites: []
---

# هندسة الفوضى — أيام اللعب (GameDay) وحقن الإخفاقات

> [!NOTE]
> هندسة الفوضى ليست كسر الأشياء عشوائيًا. بل ممارسة منضبطة لإدخال إخفاقات محكومة للتحقق من أن آليات المرونة لديك تعمل فعلًا قبل أن يختبرها انقطاع حقيقي نيابة عنك.

## 1. المبدأ الأساسي

نشرت Netflix هذه الممارسة (Chaos Monkey، نحو 2011)، لكن المبدأ قديم: تحليل ما قبل الوفاة (pre-mortem) وقد أصبح قابلًا للتنفيذ. والسؤال الذي تجيب عنه هندسة الفوضى: "نعتقد أن نظامنا يتعامل مع هذا الفشل برشاقة — فهل يفعل ذلك فعلًا؟"

وفي الخدمات المالية يحمل هذا السؤال وزنًا رقابيًا. فقانون المرونة التشغيلية الرقمية في الاتحاد الأوروبي (DORA، المطبّق منذ يناير 2025) يتطلب من الكيانات المالية تشغيل برنامج لاختبار المرونة التشغيلية الرقمية، ويجب على الشركات البريطانية أن تثبت عبر اختبار السيناريوهات أنها تستطيع البقاء ضمن حدود تحمل الأثر لخدماتها التجارية المهمة. وتولّد هندسة الفوضى ذلك الدليل بشكل منهجي، لا على الورق فقط.

دورة هندسة الفوضى:

```
1. Define steady-state hypothesis
   "Payment processing rate stays above 95% of baseline with p99 < 2s"

2. Select failure scenario
   "Kill one of three payment service pods"

3. Control blast radius
   "Run in staging first; in production, limit to 5% of traffic"

4. Inject failure
   "kubectl delete pod payment-service-abc123"

5. Observe system behavior
   "Monitor Grafana for 15 minutes post-injection"

6. Verify hypothesis
   "Did processing rate stay above 95%? Did latency stay below 2s?"

7. Document and act
   "Hypothesis verified — OR — discovered that circuit breaker
    didn't open fast enough: lowered the slow-call threshold and
    the gateway timeout from 10s to 3s, then re-ran the experiment"
```

## 2. ‏Chaos Monkey لـ Spring Boot

تحقن مكتبة Chaos Monkey لـ Spring Boot الإخفاقات مباشرة في المكونات التي يديرها Spring عبر Spring AOP ونقاط Actuator.

```xml
<dependency>
    <groupId>de.codecentric</groupId>
    <artifactId>chaos-monkey-spring-boot</artifactId>
    <version>3.1.0</version>
</dependency>
```

```java
// No annotation is needed: Chaos Monkey for Spring Boot is activated by the
// "chaos-monkey" Spring profile plus chaos.monkey.enabled=true
// (e.g. SPRING_PROFILES_ACTIVE=chaos-monkey on a staging deployment)
@SpringBootApplication
public class PaymentServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(PaymentServiceApplication.class, args);
    }
}
```

```yaml
# application-chaos-monkey.yml — only loaded with the chaos-monkey profile
chaos:
  monkey:
    enabled: true
    watcher:
      # Apply chaos to these Spring component types
      component: true
      service: true
      rest-controller: true
      repository: false  # Don't inject chaos into DB calls in this experiment
    assaults:
      level: 3                     # Every 3rd call gets chaos (33%)
      latency-active: false        # Don't use latency assault in this experiment
      exceptions-active: true      # Inject exceptions
      kill-application-active: false
      exception:
        type: "java.lang.RuntimeException"
        arguments:
          - type: "java.lang.String"
            value: "Chaos Monkey - simulated transient failure"
      # Only attack these specific beans
      watched-custom-services:
        - "paymentGatewayService"
        - "fraudCheckService"

management:
  endpoint:
    chaosmonkey:
      enabled: true     # runtime control — expose ONLY on a secured management port
```

```java
/**
 * Runtime control via the Chaos Monkey Actuator endpoint
 * (/actuator/chaosmonkey/...) — enable/disable chaos without redeployment.
 * Used by automated GameDay scripts against the target service.
 */
@Component
@Slf4j
public class ChaosExperimentController {

    private final RestClient actuator;   // base URL = target service's management port
    private final ScheduledExecutorService scheduler =
        Executors.newSingleThreadScheduledExecutor();

    public ChaosExperimentController(RestClient chaosActuatorClient) {
        this.actuator = chaosActuatorClient;
    }

    /**
     * Activate a latency assault for a time-boxed experiment.
     */
    public void activateLatencyAssault(int latencyMs, Duration duration) {
        actuator.post().uri("/actuator/chaosmonkey/assaults")
            .contentType(MediaType.APPLICATION_JSON)
            .body(Map.of(
                "level", 5,                       // every 5th call
                "latencyActive", true,
                "latencyRangeStart", latencyMs,
                "latencyRangeEnd", latencyMs + 500))
            .retrieve().toBodilessEntity();
        actuator.post().uri("/actuator/chaosmonkey/enable")
            .retrieve().toBodilessEntity();
        log.info("Chaos Monkey latency assault activated: {}ms for {}",
            latencyMs, duration);

        // Auto-disable after duration — never leave an assault running
        scheduler.schedule(() -> {
            actuator.post().uri("/actuator/chaosmonkey/disable")
                .retrieve().toBodilessEntity();
            log.info("Chaos Monkey latency assault deactivated");
        }, duration.toMillis(), TimeUnit.MILLISECONDS);
    }
}
```

## 3. ‏Toxiproxy — حقن إخفاقات الشبكة

لإخفاقات مستوى الشبكة (الزمن، وفقدان الحزم، وإعادة ضبط الاتصال)، يُعد Toxiproxy معيار الصناعة. فهو يقف كوسيط بين خدمتك واعتمادياتها.

```java
/**
 * Toxiproxy client integration for automated chaos experiments.
 * Used in integration tests and GameDay automation.
 */
@Configuration
public class ToxiproxyConfig {

    @Bean
    @Profile("chaos")
    public ToxiproxyClient toxiproxyClient(
            @Value("${toxiproxy.host:localhost}") String host,
            @Value("${toxiproxy.port:8474}") int port) {
        return new ToxiproxyClient(host, port);
    }
}

@Component
@RequiredArgsConstructor
@Profile("chaos")
@Slf4j
public class NetworkChaosInjector {

    private final ToxiproxyClient toxiproxyClient;

    /**
     * Inject network latency between payment service and gateway.
     * Simulates transatlantic network degradation during peak hours.
     */
    public AutoCloseable injectLatency(String proxyName,
                                        int latencyMs,
                                        int jitterMs) throws IOException {
        Proxy proxy = toxiproxyClient.getProxy(proxyName);
        Toxic latencyToxic = proxy.toxics()
            .latency("payment-gateway-latency",
                ToxicDirection.UPSTREAM,
                latencyMs)
            .setJitter(jitterMs);

        log.info("Injected {}ms latency (±{}ms) on proxy={}",
            latencyMs, jitterMs, proxyName);

        return () -> {
            latencyToxic.remove();
            log.info("Removed latency toxic from proxy={}", proxyName);
        };
    }

    /**
     * Simulate bandwidth throttling — common during DDoS scenarios.
     */
    public AutoCloseable throttleBandwidth(String proxyName,
                                            int bytesPerSecond) throws IOException {
        Proxy proxy = toxiproxyClient.getProxy(proxyName);
        Toxic bandwidthToxic = proxy.toxics()
            .bandwidth("bandwidth-limit",
                ToxicDirection.DOWNSTREAM,
                bytesPerSecond);
        return () -> bandwidthToxic.remove();
    }

    /**
     * Simulate connection reset — models TCP RST packets from upstream.
     * Tests retry and reconnect behavior.
     */
    public AutoCloseable injectConnectionReset(String proxyName) throws IOException {
        Proxy proxy = toxiproxyClient.getProxy(proxyName);
        Toxic resetToxic = proxy.toxics()
            .resetPeer("connection-reset", ToxicDirection.UPSTREAM, 0);
        return () -> resetToxic.remove();
    }

    /**
     * Simulate a dependency that accepts the connection but never answers:
     * the proxy stops forwarding data. Note the TCP connect TO THE PROXY
     * succeeds — so this verifies your READ timeout. (To test a connect
     * timeout, point the client at a black-holed address instead.)
     */
    public AutoCloseable injectTimeout(String proxyName) throws IOException {
        Proxy proxy = toxiproxyClient.getProxy(proxyName);
        Toxic timeoutToxic = proxy.toxics()
            .timeout("connection-timeout", ToxicDirection.UPSTREAM, 0);
        return () -> timeoutToxic.remove();
    }
}
```

## 4. سيناريوهات حقن الإخفاقات للخدمات المالية

### كتالوج السيناريوهات

```java
/**
 * Chaos scenario catalog for payment infrastructure.
 * Each scenario has a hypothesis, injection method, and success criteria.
 */
public enum PaymentChaosScenario {

    /**
     * Hypothesis: Payment service handles pod failure via Kubernetes
     * replica replacement within 30s, with no payment data loss.
     * Injection: kubectl delete pod (random payment service instance)
     * Success: Processing rate recovers to >95% within 60s
     */
    POD_KILL,

    /**
     * Hypothesis: Circuit breaker opens within 10s of gateway degradation,
     * preventing thread pool exhaustion.
     * Injection: Toxiproxy latency 5000ms on payment gateway upstream
     * Success: CB opens; fallback returns PENDING status; no 5xx errors
     */
    GATEWAY_LATENCY_SPIKE,

    /**
     * Hypothesis: Payment service handles DB primary failover gracefully,
     * with transaction retry after Patroni promotes replica.
     * Injection: Kill PostgreSQL primary container
     * Success: Failover completes in < 30s; no duplicate payments
     */
    DATABASE_PRIMARY_FAILOVER,

    /**
     * Hypothesis: Kafka consumer handles broker restart without
     * message loss; redeliveries are absorbed by the idempotent consumer.
     * Injection: Kill one Kafka broker from 3-broker cluster
     * Success: Leader election completes; consumer resumes within 15s;
     *          no lost events and no duplicate side effects
     */
    KAFKA_BROKER_FAILURE,

    /**
     * Hypothesis: Fraud service failure follows the documented policy:
     * low-value payments proceed (fail open), higher-value ones go to
     * PENDING / review — and ops are alerted.
     * Injection: Chaos Monkey exception assault on fraud service (100%)
     * Success: Policy applied exactly; fraud_check_timeout metric
     *          increments; PagerDuty alert fires within 2m
     */
    FRAUD_SERVICE_TOTAL_FAILURE,

    /**
     * Hypothesis: Redis cache unavailability degrades but doesn't stop payments.
     * Injection: Kill Redis container
     * Success: Payments fall back to database; cache_miss metric spikes;
     *          latency increases but < 5s p99
     */
    CACHE_TOTAL_FAILURE
}
```

### محاكاة قفزة المعالج

```java
/**
 * CPU saturation test: simulates GC pause or compute-heavy fraud model.
 * Run in a dedicated thread pool to avoid blocking the main application.
 */
@Component
public class CpuChaosInjector {

    public AutoCloseable injectCpuSpike(int cpuPercentage, Duration duration) {
        int threads = Runtime.getRuntime().availableProcessors();
        int activeThreads = (int) Math.ceil(threads * cpuPercentage / 100.0);

        List<Future<?>> futures = new ArrayList<>();
        ExecutorService executor = Executors.newFixedThreadPool(activeThreads);

        for (int i = 0; i < activeThreads; i++) {
            futures.add(executor.submit(() -> {
                long endMs = System.currentTimeMillis() + duration.toMillis();
                while (System.currentTimeMillis() < endMs) {
                    // Busy-spin to consume CPU
                    Math.sqrt(ThreadLocalRandom.current().nextDouble());
                }
            }));
        }

        log.info("CPU spike injected: {}% ({} threads) for {}",
            cpuPercentage, activeThreads, duration);

        return () -> {
            futures.forEach(f -> f.cancel(true));
            executor.shutdownNow();
            log.info("CPU spike terminated");
        };
    }
}
```

## 5. تعريف فرضية الحالة المستقرة

```java
/**
 * Steady-state hypothesis is a measurable, quantified definition of normal.
 * Without it, you cannot determine if chaos revealed a problem.
 */
@Component
@RequiredArgsConstructor
public class SteadyStateVerifier {

    private final MeterRegistry meterRegistry;
    private final PrometheusQueryClient prometheus;

    /**
     * Verify steady-state hypothesis for payment service:
     * 1. Payment success rate >= 99.5%
     * 2. p99 latency <= 2000ms
     * 3. Error rate <= 0.1%
     * 4. No DLQ growth during the window
     */
    public SteadyStateResult verify(String experimentName,
                                     Duration measurementWindow) {
        Instant end = Instant.now();
        Instant start = end.minus(measurementWindow);

        double successRate = querySuccessRate(start, end);
        double p99Latency = queryP99Latency(start, end);
        double errorRate = queryErrorRate(start, end);
        long dlqGrowth = queryDlqGrowth(start, end);   // new DLQ entries in the window

        SteadyStateResult result = SteadyStateResult.builder()
            .experimentName(experimentName)
            .measurementWindow(measurementWindow)
            .successRate(successRate)
            .p99LatencyMs(p99Latency)
            .errorRate(errorRate)
            .dlqGrowth(dlqGrowth)
            // Hypothesis thresholds
            .successRateHypothesis(0.995)
            .p99LatencyHypothesisMs(2000)
            .errorRateHypothesis(0.001)
            .dlqGrowthHypothesis(0)  // DLQ should not grow
            .hypothesisMet(
                successRate >= 0.995 &&
                p99Latency <= 2000 &&
                errorRate <= 0.001 &&
                dlqGrowth == 0
            )
            .build();

        // SLF4J has no {:.2f} placeholders — format the number first
        log.info("Steady-state check for {}: {} | successRate={}% p99={}ms",
            experimentName,
            result.isHypothesisMet() ? "HYPOTHESIS MET" : "HYPOTHESIS VIOLATED",
            String.format("%.2f", successRate * 100), (long) p99Latency);

        return result;
    }
}
```

## 6. تخطيط يوم اللعب وتنفيذه

يوم اللعب (GameDay) تمرين منظم يُدخل فيه فريق الهندسة إخفاقات عمدًا ويتحقق من إجراءات الاستجابة.

### قالب يوم اللعب

```
GAMEDAY: Payment Service Resilience
Date: [Date]
Duration: 3 hours (10:00–13:00)
Environment: Production (5% canary) + Staging (full)

PARTICIPANTS:
- Incident Commander: [Senior Engineer]
- Chaos Engineer: [Running injections]
- Observability Lead: [Watching dashboards]
- Product Observer: [Verifying customer impact]
- Rollback Authority: [Can stop experiment at any time]

EXPERIMENTS (staged):
09:50 - Pre-GameDay: Verify steady-state baseline (10 min)
10:00 - Experiment 1: Kill one payment-service pod (staging)
10:20 - Experiment 2: Inject 2s latency on fraud-check (staging)
10:40 - Experiment 3: Inject 2s latency on fraud-check (production 5%)
11:00 - Break + discussion
11:15 - Experiment 4: Kill Kafka broker 2 of 3 (staging)
11:40 - Experiment 5: Kill PostgreSQL replica (staging)
12:10 - Wrap-up + post-analysis
12:30 - Findings documentation

STOP CONDITIONS (immediately halt all experiments):
- Payment success rate drops below 95% in production
- Any customer-visible error page appears
- DLQ backlog exceeds 100 messages
- On-call engineer requests stop
```

```java
/**
 * GameDay automation — runs experiments, records results, auto-stops on violations.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class GameDayOrchestrator {

    private final SteadyStateVerifier steadyStateVerifier;
    private final NetworkChaosInjector chaosInjector;
    private final AlertingService alerting;
    private final ScheduledExecutorService scheduler;

    /**
     * Run a time-boxed chaos experiment with auto-termination.
     */
    public ExperimentResult runExperiment(ChaosExperiment experiment) {
        log.info("Starting chaos experiment: {}", experiment.getName());

        // 1. Verify steady state before injection
        SteadyStateResult baseline = steadyStateVerifier.verify(
            experiment.getName() + "-baseline",
            Duration.ofMinutes(5));

        if (!baseline.isHypothesisMet()) {
            log.error("Steady state NOT met before experiment — aborting: {}",
                experiment.getName());
            return ExperimentResult.aborted("Pre-experiment steady state violated");
        }

        // 2. Inject failure
        AutoCloseable injectionHandle;
        try {
            injectionHandle = experiment.inject(chaosInjector);
        } catch (Exception e) {
            return ExperimentResult.failed("Injection failed: " + e.getMessage());
        }

        // 3. Observe during experiment (with auto-stop watchdog);
        //    the injection is removed exactly once, by whoever gets there first
        StoppableInjection injection = new StoppableInjection(injectionHandle);
        ExperimentObservation observation = observe(experiment, injection);

        // 4. Remove injection (no-op if the watchdog already did)
        injection.stop();

        // 5. Verify steady state after injection removed
        SteadyStateResult postInjection = steadyStateVerifier.verify(
            experiment.getName() + "-post",
            Duration.ofMinutes(5));

        // The hypothesis is about behaviour DURING the failure:
        // every snapshot must meet it, and the system must recover afterwards
        boolean metDuringFailure = observation.snapshots().stream()
            .allMatch(SteadyStateResult::isHypothesisMet);

        return ExperimentResult.builder()
            .experimentName(experiment.getName())
            .baseline(baseline)
            .observation(observation)
            .postInjection(postInjection)
            .autoStopped(injection.stoppedEarly())
            .hypothesisMet(metDuringFailure && postInjection.isHypothesisMet())
            .build();
    }

    private ExperimentObservation observe(ChaosExperiment experiment,
                                           StoppableInjection injection) {
        Instant start = Instant.now();
        // Written by the watchdog thread, read by this thread
        List<SteadyStateResult> snapshots = new CopyOnWriteArrayList<>();
        CountDownLatch autoStopped = new CountDownLatch(1);

        // Check every 30s during experiment
        ScheduledFuture<?> watchdog = scheduler.scheduleAtFixedRate(() -> {
            SteadyStateResult snapshot = steadyStateVerifier.verify(
                experiment.getName() + "-snapshot", Duration.ofSeconds(30));
            snapshots.add(snapshot);

            // Auto-stop if steady state is severely violated
            if (snapshot.getSuccessRate() < 0.90 && injection.stopEarly()) {
                log.error("GAMEDAY AUTO-STOP: success rate {}% below 90% threshold",
                    String.format("%.1f", snapshot.getSuccessRate() * 100));
                alerting.page(PagerDutyAlert.critical(
                    "GameDay auto-stopped: " + experiment.getName()));
                autoStopped.countDown();
            }
        }, 30, 30, TimeUnit.SECONDS);

        // Run for the experiment duration — or until the watchdog stops it
        try {
            autoStopped.await(experiment.getDuration().toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            watchdog.cancel(false);
        }

        return new ExperimentObservation(start, Instant.now(), List.copyOf(snapshots));
    }

    /** Closes the injection at most once, from any thread. */
    private static final class StoppableInjection {
        private final AutoCloseable handle;
        private final AtomicBoolean stopped = new AtomicBoolean();
        private volatile boolean early;

        StoppableInjection(AutoCloseable handle) { this.handle = handle; }

        boolean stopEarly() {                    // true if THIS call stopped it
            if (stopped.compareAndSet(false, true)) {
                early = true;
                close();
                return true;
            }
            return false;
        }

        void stop() {
            if (stopped.compareAndSet(false, true)) close();
        }

        boolean stoppedEarly() { return early; }

        private void close() {
            try {
                handle.close();
            } catch (Exception e) {
                log.error("Failed to remove chaos injection!", e);
            }
        }
    }
}
```

## 7. التحكم في نطاق الأثر

```java
/**
 * Blast radius controls limit the scope of chaos experiments in production.
 * Never run chaos experiments without defined blast radius limits.
 */
@Component
public class BlastRadiusController {

    /**
     * Traffic percentage targeting: only inject chaos for N% of requests.
     * Deterministic hashing on request ID gives a stable decision.
     */
    public boolean shouldInjectChaos(String requestId, double targetPercentage) {
        // floorMod, not Math.abs(): Math.abs(Integer.MIN_VALUE) is negative
        int bucket = Math.floorMod(requestId.hashCode(), 100);
        return bucket < (int) (targetPercentage * 100);
    }

    /**
     * User segment targeting: only inject chaos for internal/test accounts.
     * Never inject chaos for real customer accounts without explicit opt-in.
     */
    public boolean isSafeForChaos(String accountId) {
        // Only target accounts in chaos experiment whitelist
        return accountId.startsWith("chaos-test-") ||
               accountId.startsWith("internal-");
    }

    /**
     * Time window control: only run chaos during business hours
     * when the full team is available to respond.
     */
    public boolean isWithinSafeWindow() {
        LocalDateTime now = LocalDateTime.now(ZoneId.of("America/New_York"));
        DayOfWeek day = now.getDayOfWeek();
        int hour = now.getHour();

        // Only Mon-Fri, 10:00-16:00 ET (team is available)
        return day != DayOfWeek.SATURDAY &&
               day != DayOfWeek.SUNDAY &&
               hour >= 10 && hour < 16;
    }
}
```

## 8. هندسة الفوضى في الإنتاج مقابل بيئة التجهيز

| البُعد | بيئة التجهيز | الإنتاج |
|---|---|---|
| الحركة | حمل محاكى | معاملات عملاء حقيقية |
| نطاق الأثر | 100% من بيئة التجهيز | 1–5% عبر canary |
| خطر البيانات | لا شيء (بيانات اختبار) | أثر محتمل على العملاء |
| المتطلبات المسبقة | لا شيء | إبلاغ فريق PagerDuty، وأدلة التشغيل جاهزة |
| عتبة الإيقاف التلقائي | نسبة نجاح 80% | نسبة نجاح 95% |
| مدة التجربة | 30–60 دقيقة | 5–15 دقيقة |
| الوتيرة | أسبوعيًا | شهريًا |
| الموافقة المطلوبة | قائد الفريق | نائب رئيس الهندسة + مهندس SRE المناوب |

## 9. قياس تحسينات المرونة

```java
/**
 * Track resilience metrics before and after GameDay improvements.
 * This creates the evidence trail for compliance and leadership reporting.
 */
@Component
@RequiredArgsConstructor
public class ResilienceScorecard {

    private final GameDayResultRepository resultRepository;

    public ResilienceReport generateReport(String serviceId,
                                            YearMonth month) {
        List<ExperimentResult> results = resultRepository
            .findByServiceAndMonth(serviceId, month);

        long totalExperiments = results.size();
        long hypothesisMet = results.stream()
            .filter(ExperimentResult::isHypothesisMet).count();

        // No experiments this month = no evidence, not a perfect (or NaN) score
        double resilienceScore = totalExperiments == 0 ? 0
            : (double) hypothesisMet / totalExperiments;

        // Compare to previous month
        List<ExperimentResult> lastMonth = resultRepository
            .findByServiceAndMonth(serviceId, month.minusMonths(1));
        double previousScore = lastMonth.isEmpty() ? 0 :
            (double) lastMonth.stream().filter(ExperimentResult::isHypothesisMet).count()
            / lastMonth.size();

        return ResilienceReport.builder()
            .serviceId(serviceId)
            .month(month)
            .totalExperiments(totalExperiments)
            .hypothesisMetCount(hypothesisMet)
            .resilienceScore(resilienceScore)
            .previousMonthScore(previousScore)
            .scoreTrend(resilienceScore - previousScore)
            .experimentResults(results)
            .build();
    }
}
```

## 10. الفوضى في اختبارات التكامل

```java
/**
 * Chaos assertions in integration tests.
 * Fail CI if resilience mechanisms don't function correctly.
 */
@SpringBootTest
@ActiveProfiles({"chaos", "test"})
class PaymentServiceResilienceTest {

    @Autowired
    private NetworkChaosInjector chaosInjector;

    @Autowired
    private PaymentGatewayService paymentService;

    @Autowired
    private MeterRegistry meterRegistry;

    @Test
    @DisplayName("Circuit breaker opens when gateway latency exceeds threshold")
    void circuitBreakerOpensOnGatewayLatency() throws Exception {
        int rejectedFast = 0;

        // Arrange: inject 10s latency on gateway
        try (AutoCloseable latency = chaosInjector.injectLatency(
                "payment-gateway", 10_000, 0)) {

            // Act: submit payments until circuit breaker opens
            for (int i = 0; i < 25; i++) {
                try {
                    paymentService.submitPayment(buildTestPayment("test-" + i));
                } catch (PaymentGatewayUnavailableException e) {
                    rejectedFast++;   // thrown once the circuit is OPEN
                }
            }

            // Assert: the circuit opened within the 25 calls
            assertThat(rejectedFast).isGreaterThan(0);

            // Assert: metrics recorded correctly (rejections have their own metric)
            Counter notPermitted = meterRegistry
                .find("resilience4j.circuitbreaker.not.permitted.calls")
                .tag("name", "payment-gateway")
                .counter();
            assertThat(notPermitted).isNotNull();
            assertThat(notPermitted.count()).isGreaterThan(0);
        }

        // After injection removed: the circuit leaves OPEN after the wait
        // duration (on its own only if automaticTransitionFromOpenToHalfOpenEnabled
        // is true; otherwise on the next call)
        await().atMost(60, TimeUnit.SECONDS)
            .until(() -> paymentService.getCircuitBreakerState() != State.OPEN);
    }
}
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الذي يجب إرساؤه قبل حقن أي فشل أثناء تجربة فوضى؟",
      "options": ["سكربت تراجع", "فرضية حالة مستقرة بعتبات قابلة للقياس", "جدول مناوبة", "بيئة تجهيز"],
      "correct": 1,
      "explanation": "دون فرضية حالة مستقرة مقاسة (مثلًا نسبة نجاح الدفع >= 99.5%، وp99 < ثانيتين)، لا تستطيع تحديد هل كشفت الفوضى مشكلة. فالفرضية تعرّف شكل «الطبيعي» لتصبح الانحرافات قابلة للقياس بموضوعية."
    },
    {
      "text": "لماذا يجب أن تستهدف تجارب الفوضى في الإنتاج 1–5% فقط من الحركة عبر canary بدل 100%؟",
      "options": ["لتقليل مدة التجربة", "لتحديد نطاق الأثر وحماية معاملات العملاء الحقيقية", "لتجنب إطلاق قواطع الدائرة", "للامتثال لحدود موارد Kubernetes"],
      "correct": 1,
      "explanation": "يضمن التحكم في نطاق الأثر أنه إذا لم يتعامل النظام مع الفشل كما هو متوقع، فلن يتأثر إلا جزء صغير من حركة العملاء الحقيقية. وتستمر غالبية المعاملات بشكل طبيعي بينما تعمل التجربة على شريحة canary."
    },
    {
      "text": "أي أداة هي الأنسب لحقن إخفاقات مستوى الشبكة مثل الزمن وتقييد عرض النطاق وإعادة ضبط اتصالات TCP بين الخدمات؟",
      "options": ["Chaos Monkey لـ Spring Boot", "Toxiproxy", "امتدادات فوضى في JUnit", "حقن الأعطال في Resilience4j"],
      "correct": 1,
      "explanation": "‏Toxiproxy وسيط شبكة مصمم خصيصًا لحقن إخفاقات مستوى الشبكة. أما Chaos Monkey لـ Spring Boot فيحقن الإخفاقات على مستوى مكونات Spring (استثناءات، وزمن في استدعاءات الدوال)، لا على طبقة نقل الشبكة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "أتمتة يوم اللعب لمرونة خدمة الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "عرّف SteadyStateHypothesis لخدمة دفع بأربع عتبات قابلة للقياس: نسبة نجاح >= 99.5%، وزمن p99 <= 2000 مللي ثانية، ومعدل أخطاء <= 0.1%، ونمو طابور الرسائل الميتة = 0. ونفّذ SteadyStateVerifier يستعلم Prometheus عن كل مقياس."},
    {"id": "2", "description": "ابنِ NetworkChaosInjector قائمًا على Toxiproxy بأربعة أنواع حقن: زمن مع تشويش، وتقييد عرض النطاق، وإعادة ضبط الاتصال، واتصال لا يجيب أبدًا. ويجب أن تعيد كل دالة AutoCloseable يزيل السم (toxic) عند إغلاقه."},
    {"id": "3", "description": "نفّذ GameDayOrchestrator: يتحقق من الحالة المستقرة قبل الحقن، ويطبق الفشل، ويشغّل مراقبًا يأخذ عينة من الحالة المستقرة كل 30 ثانية ويوقف التجربة تلقائيًا (مزيلًا الحقن مرة واحدة بالضبط وبأمان بين الخيوط) إذا انخفضت نسبة النجاح تحت 90%، ويزيل الحقن، ويتحقق من التعافي. ولا تُعد الفرضية محققة إلا إذا حققتها كل عينة أثناء الفشل وتعافى النظام بعده."},
    {"id": "4", "description": "اكتب اختبار تكامل باستخدام Toxiproxy يحقن زمن 10 ثوانٍ على بوابة الدفع، ويرسل 25 دفعة، ويؤكد أن قاطع الدائرة فُتح ضمن تلك الاستدعاءات، ويتحقق من زيادة العداد resilience4j.circuitbreaker.not.permitted.calls."}
  ]
}
-->
