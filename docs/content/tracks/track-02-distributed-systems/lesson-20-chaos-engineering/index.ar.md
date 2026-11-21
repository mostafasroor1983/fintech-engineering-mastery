---
id: track-02-lesson-20
title: "هندسة الفوضى للأنظمة المالية الموزعة"
slug: chaos-engineering
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 20
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [chaos-engineering, fault-injection, resilience-testing, GameDay, Chaos-Monkey]
prerequisites: []
---

# هندسة الفوضى للأنظمة المالية الموزعة

> [!NOTE]
> هندسة الفوضى هي ممارسة حقن الأعطال عمدًا في نظام إنتاجي أو ما قبل إنتاجي لاكتشاف نقاط الضعف قبل أن تظهر كانقطاعات غير مخططة. وفي نظام دفع يعالج ملايين المعاملات يوميًا، اكتشاف ثغرة في المرونة أثناء يوم تمرين (GameDay) مضبوط أرخص بمراتب من اكتشافها في ساعات الذروة.

## مبادئ هندسة الفوضى

أرست Netflix هذا التخصص، وسمّت أداة تُنهي نسخ EC2 عشوائيًا في الإنتاج "Chaos Monkey". وتأتي الفلسفة الأساسية من **مبادئ هندسة الفوضى** ‏(principlesofchaos.org):

1. **ابنِ فرضية حول سلوك الحالة المستقرة**: عرّف ما يبدو طبيعيًا (مثل "99.9% من المدفوعات تكتمل خلال 500ms")
2. **نوّع أحداث العالم الحقيقي**: احقن أحداثًا تقع فعلًا في الإنتاج (تعطل الخوادم، وتأخر الشبكة، وامتلاء القرص)
3. **شغّل التجارب في الإنتاج**: بيئات ما قبل الإنتاج لا تلتقط أنماط الحركة الحقيقية؛ وتجارب الإنتاج تجد نقاط الضعف الحقيقية
4. **أتمت التجارب لتعمل باستمرار**: التجارب المنفردة تعطي لقطة؛ والفوضى المستمرة تعطي طمأنة دائمة
5. **قلّل نطاق الأثر**: ابدأ صغيرًا ووسّع النطاق تدريجيًا

في المؤسسات المالية، يتطلب المبدأ 3 (التشغيل في الإنتاج) حوكمة دقيقة. فكثير من البنوك تشغّل تجارب الفوضى خارج ساعات الذروة، بضوابط صارمة لنطاق الأثر وقدرة تراجع فورية.

---

## الفوضى المدفوعة بالفرضيات

تبدأ كل تجربة فوضى بـ **فرضية** — توقع لسلوك النظام تحت حالة فشل محددة. ودون فرضية تصبح الفوضى مجرد تدمير عشوائي.

```
Hypothesis template:
"When [failure condition], we believe [system behavior] because [reasoning].
 We will verify by measuring [metric] against [threshold]."

Example:
"When the fraud-detection-service experiences 50% packet loss,
 we believe payment authorization latency increases by less than 200ms
 and success rate remains above 99.5%, because we have circuit breakers
 with a 1-second timeout and fallback to a local rules engine.
 We will verify by measuring p99 authorization latency and payment success rate
 over a 10-minute experiment window."
```

قالب الفرضية: "عندما [حالة الفشل]، نعتقد أن [سلوك النظام] لأن [المبرر]. وسنتحقق بقياس [المقياس] مقابل [العتبة]."

```java
@Component
public class ChaosHypothesisValidator {

    private final MetricsClient metricsClient;

    /**
     * Validates a chaos experiment hypothesis by comparing
     * steady-state metrics against hypothesis thresholds.
     */
    public HypothesisResult validate(ChaosHypothesis hypothesis,
                                      Instant experimentStart,
                                      Instant experimentEnd) {
        // Collect metrics during the experiment window
        // A RATIO (successes / all), not a raw rate in requests per second
        MetricSample paymentSuccessRate = metricsClient.queryRange(
            "sum(rate(payment_authorizations_total{result=\"success\"}[1m]))" +
            " / sum(rate(payment_authorizations_total[1m]))",
            experimentStart, experimentEnd
        );

        // histogram_quantile needs the per-second rate of the buckets,
        // summed by the le label
        MetricSample p99Latency = metricsClient.queryRange(
            "histogram_quantile(0.99, sum by (le) " +
            "(rate(payment_authorization_duration_seconds_bucket[1m])))",
            experimentStart, experimentEnd
        );

        // Evaluate against hypothesis thresholds
        boolean successRateHeld = paymentSuccessRate.min()
            >= hypothesis.minSuccessRate();
        boolean latencyHeld = p99Latency.max()
            <= hypothesis.maxP99LatencySeconds();

        HypothesisResult result = HypothesisResult.builder()
            .hypothesis(hypothesis)
            .successRateActual(paymentSuccessRate.min())
            .p99LatencyActual(p99Latency.max())
            .successRateHeld(successRateHeld)
            .latencyHeld(latencyHeld)
            .passed(successRateHeld && latencyHeld)
            .build();

        if (!result.passed()) {
            log.error("CHAOS EXPERIMENT FAILED hypothesis: {}\n" +
                "Success rate: {} (threshold: {})\n" +
                "P99 latency: {}s (threshold: {}s)",
                hypothesis.description(),
                paymentSuccessRate.min(), hypothesis.minSuccessRate(),
                p99Latency.max(), hypothesis.maxP99LatencySeconds());
        }

        return result;
    }
}
```

يجب أن يكون معدل النجاح **نسبة** (النجاحات / الكل)، لا معدلًا خامًا بالطلبات في الثانية. ويحتاج `histogram_quantile` إلى المعدل في الثانية لكل دلو، مجموعًا حسب الوسم `le`.

---

## Chaos Monkey

تُنهي أداة Chaos Monkey الأصلية من Netflix نسخ الأجهزة الافتراضية عشوائيًا في مجموعة توسع تلقائي. والغرض ضمان أن الخدمات تتحمل تعطل النسخ — لا فقط وقت مراجعة البنية، بل باستمرار في الإنتاج.

والمكافئ الحديث للأنظمة المالية إنهاء مضبوط لنسخة:
1. يختار نسخة غير حرجة (لا معالج الدفع الأساسي في ساعات الذروة)
2. يُنهي النسخة
3. يتحقق من تعافي النظام ضمن اتفاقية الخدمة
4. يسجّل النتيجة

```java
@Service
public class ChaosMonkeyService {

    private final Ec2Client ec2Client;
    private final AutoScalingClient asgClient;
    private final MetricsClient metricsClient;
    private final AlertingService alerting;
    private final ChaosConfig config;

    /**
     * Terminate one random non-critical instance in the payment processor ASG.
     * Only runs during allowed hours and when the cluster is healthy.
     */
    // Spring cron: second minute hour day month weekday.
    // "0 0 10-16/4" = 10:00 and 14:00. ("0 */4 10-16" would mean every 4 MINUTES.)
    @Scheduled(cron = "0 0 10-16/4 * * MON-FRI", zone = "Europe/London")
    public void maybeTerminateInstance() {
        if (!config.isChaosEnabled()) {
            return;
        }

        // Safety check: abort if payment success rate is below 99.9%
        double currentSuccessRate = metricsClient.currentPaymentSuccessRate();
        if (currentSuccessRate < 0.999) {
            log.warn("Chaos Monkey aborted: payment success rate {} below threshold",
                currentSuccessRate);
            return;
        }

        // Find eligible instances (exclude primary DB, Redis primary)
        List<String> eligibleInstances = getEligibleInstances();
        if (eligibleInstances.isEmpty()) {
            log.info("No eligible instances for Chaos Monkey this round");
            return;
        }

        String targetInstance = selectRandom(eligibleInstances);
        log.info("Chaos Monkey: terminating instance {}", targetInstance);

        recordExperimentStart(targetInstance);

        ec2Client.terminateInstances(
            TerminateInstancesRequest.builder()
                .instanceIds(targetInstance)
                .build()
        );

        // Monitor for recovery
        scheduleRecoveryVerification(targetInstance);
    }

    private List<String> getEligibleInstances() {
        DescribeAutoScalingGroupsResponse response = asgClient.describeAutoScalingGroups(
            DescribeAutoScalingGroupsRequest.builder()
                .autoScalingGroupNames(config.targetAsgName())
                .build()
        );

        return response.autoScalingGroups().get(0).instances().stream()
            .filter(i -> i.lifecycleState() == LifecycleState.IN_SERVICE)
            .filter(i -> !config.protectedInstances().contains(i.instanceId()))
            .map(Instance::instanceId)
            .collect(Collectors.toList());
    }

    private void scheduleRecoveryVerification(String terminatedInstance) {
        CompletableFuture.delayedExecutor(5, TimeUnit.MINUTES).execute(() -> {
            double successRate = metricsClient.currentPaymentSuccessRate();
            if (successRate < 0.999) {
                alerting.sendP1Alert(
                    "Chaos Monkey: Recovery failed",
                    String.format("Payment success rate %f after terminating %s",
                        successRate, terminatedInstance));
            } else {
                log.info("Chaos Monkey: recovery confirmed after terminating {}. " +
                    "Success rate: {}", terminatedInstance, successRate);
            }
        });
    }
}
```

صيغة cron في Spring هي: الثانية، والدقيقة، والساعة، واليوم، والشهر، ويوم الأسبوع. فالقيمة "0 0 10-16/4" تعني 10:00 و14:00، أما "0 */4 10-16" فكانت تعني كل 4 **دقائق**.

---

## Chaos Toolkit

‏[Chaos Toolkit](https://chaostoolkit.org/) إطار مفتوح المصدر وتصريحي لتعريف تجارب الفوضى وتشغيلها. وتُعرّف التجارب بصيغة JSON/YAML، فيمكن وضعها تحت التحكم بالإصدارات ومراجعتها.

```json
{
  "version": "1.0.0",
  "title": "Payment Processor Survives Fraud Service Degradation",
  "description": "Verify payment authorization degrades gracefully when fraud detection is slow and lossy",
  "tags": ["payments", "fraud-detection", "resilience"],
  "steady-state-hypothesis": {
    "title": "Payment system is operating normally",
    "probes": [
      {
        "type": "probe",
        "name": "payment-processor-healthy",
        "tolerance": 200,
        "provider": {
          "type": "http",
          "url": "http://payment-processor/actuator/health",
          "timeout": 5
        }
      },
      {
        "type": "probe",
        "name": "p99-latency-below-500ms",
        "tolerance": {
          "type": "range",
          "range": [0, 0.5]
        },
        "provider": {
          "type": "python",
          "module": "chaosmetrics",
          "func": "query_p99_latency",
          "arguments": {
            "metric": "payment_authorization_duration_seconds",
            "window": "1m"
          }
        }
      }
    ]
  },
  "method": [
    {
      "type": "action",
      "name": "inject-network-latency-on-fraud-service",
      "provider": {
        "type": "process",
        "path": "tc",
        "arguments": "qdisc add dev eth0 root netem delay 2000ms 500ms 25% loss 10%"
      }
    }
  ],
  "rollbacks": [
    {
      "type": "action",
      "name": "remove-network-latency",
      "provider": {
        "type": "process",
        "path": "tc",
        "arguments": "qdisc del dev eth0 root"
      }
    }
  ]
}
```

> [!NOTE]
> يعمل مزوّد `process` على الجهاز الذي يشغّل Chaos Toolkit. لذلك يجب أن تعمل أوامر `tc` أعلاه على مضيف خدمة الاحتيال (مثلًا عبر امتداد SSH أو Kubernetes)، و`tc` على `eth0` يبطئ **كل** حركة ذلك المضيف. ولاستهداف اتصال واحد فقط، استخدم Toxiproxy أو قاعدة حقن أعطال في شبكة الخدمات.

## Gremlin: هندسة الفوضى للمؤسسات

يوفر [Gremlin](https://www.gremlin.com/) منصة تجارية لهندسة الفوضى بهجمات جاهزة، وتحكم بالوصول حسب الأدوار، وسجلات تدقيق — وهي ميزات مهمة لحوكمة المؤسسات المالية.

```java
@Service
public class GremlinChaosOrchestrator {

    private final GremlinApiClient gremlinClient;
    private final ApprovalWorkflow approvalWorkflow;
    private final ChangeManagement changeManagement;

    /**
     * Submit a chaos experiment for approval before execution.
     * Financial institutions typically require change management approval
     * for any deliberate fault injection, even in staging.
     */
    public ExperimentTicket submitExperiment(ChaosExperimentSpec spec) {
        // Create change management ticket
        ChangeTicket ticket = changeManagement.create(
            ChangeTicket.builder()
                .title("Chaos Experiment: " + spec.title())
                .description(spec.description())
                .riskLevel(assessRiskLevel(spec))
                .scheduledStart(spec.scheduledStart())
                .rollbackPlan(spec.rollbackPlan())
                .build()
        );

        // Route for approval
        ApprovalRequest approval = approvalWorkflow.requestApproval(
            ticket,
            spec.approvers()
        );

        log.info("Chaos experiment '{}' submitted for approval. Ticket: {}",
            spec.title(), ticket.id());

        return ExperimentTicket.of(ticket.id(), approval.id());
    }

    /**
     * Execute an approved chaos experiment via Gremlin API.
     */
    public ExperimentExecution executeApprovedExperiment(
            String ticketId, GremlinAttackSpec attack) {

        // Verify approval
        ChangeTicket ticket = changeManagement.findById(ticketId);
        if (ticket.status() != ChangeStatus.APPROVED) {
            throw new UnauthorizedExperimentException(
                "Experiment ticket " + ticketId + " not approved");
        }

        log.info("Executing chaos experiment: {} (ticket: {})", attack.name(), ticketId);

        // Submit attack to Gremlin
        GremlinAttack gremlinAttack = gremlinClient.createAttack(
            GremlinCreateAttackRequest.builder()
                .targetType("Container")
                .targetTags(attack.targetTags())
                .command(attack.command())  // e.g., latency, cpu, memory, disk, network
                .build()
        );

        return ExperimentExecution.builder()
            .gremlinAttackId(gremlinAttack.guid())
            .ticketId(ticketId)
            .startedAt(Instant.now())
            .build();
    }
}
```

تشترط المؤسسات المالية عادة موافقة إدارة التغيير على أي حقن متعمد للأعطال، حتى في بيئة ما قبل الإنتاج. ولا تُنفّذ التجربة إلا بعد التحقق من اعتماد التذكرة.

---

## سيناريوهات حقن الأعطال للأنظمة المالية

### السيناريو 1: حقن تأخر الشبكة

يحاكي تدهور الشبكة بين معالج الدفع وخدمة كشف الاحتيال:

```java
@Component
public class NetworkLatencyInjector {

    /**
     * Injects artificial latency using Linux `tc` (traffic control).
     * This simulates cross-DC network degradation, which is a real
     * scenario in multi-region payment systems.
     */
    public void injectLatency(String networkInterface, int delayMs, int jitterMs,
                               double lossPercent) {
        // Needs root (CAP_NET_ADMIN). Validate the interface name before
        // building a shell command, or it becomes a command-injection hole.
        if (!networkInterface.matches("[a-zA-Z0-9_.-]{1,15}")) {
            throw new IllegalArgumentException("Bad interface name");
        }
        String command = String.format(
            "tc qdisc add dev %s root netem delay %dms %dms 25%% loss %.1f%%",
            networkInterface, delayMs, jitterMs, lossPercent
        );

        executeShellCommand(command);
        log.warn("CHAOS: Injected {}ms +/- {}ms latency and {}% loss on {}",
            delayMs, jitterMs, lossPercent, networkInterface);
    }

    public void removeLatency(String networkInterface) {
        executeShellCommand("tc qdisc del dev " + networkInterface + " root");
        log.info("CHAOS: Removed network latency on {}", networkInterface);
    }
}
```

يحتاج هذا إلى صلاحيات root، ويجب التحقق من اسم الواجهة قبل بناء أمر صدفة، وإلا صار ثغرة حقن أوامر.

في الاختبار الآلي، فضّل Toxiproxy (مع Testcontainers) بين خدمة الدفع وخدمة الاحتيال: فهو يؤخر ذلك الاتصال وحده، بينما `tc` على `eth0` يبطئ كل اتصالات المضيف، بما فيها قاعدة البيانات.

```java
@SpringBootTest
@Tag("chaos")
public class FraudServiceLatencyTest {

    @Autowired
    private PaymentAuthorizationService authService;

    @Autowired
    private NetworkLatencyInjector latencyInjector;

    @Autowired
    private MeterRegistry meterRegistry;

    @Test
    public void paymentAuthorizationSurvivesFraudServiceLatency() {
        // Establish baseline
        double baselineP99 = measureP99Latency(100);
        log.info("Baseline P99 latency: {}ms", baselineP99);

        // Inject 1500ms latency on fraud service calls
        latencyInjector.injectLatency("eth0", 1500, 200, 0);

        try {
            // Run payment authorizations under fault condition
            double degradedP99 = measureP99Latency(100);
            double degradedSuccessRate = measureSuccessRate(100);

            log.info("Under fault: P99={}ms, success rate={}", degradedP99, degradedSuccessRate);

            // Assert hypothesis: circuit breaker should open and fallback should kick in
            // Expected: p99 stays below 600ms (not 1500ms) due to circuit breaker timeout
            assertThat(degradedP99)
                .as("P99 latency should not exceed 600ms due to circuit breaker")
                .isLessThan(600.0);

            // Expected: success rate stays above 99% due to fallback rules engine
            assertThat(degradedSuccessRate)
                .as("Success rate should stay above 99% due to fraud check fallback")
                .isGreaterThan(0.99);

        } finally {
            latencyInjector.removeLatency("eth0");
        }
    }

    private double measureP99Latency(int sampleSize) {
        // Run sample payments and measure latency distribution
        List<Long> latencies = new ArrayList<>();
        for (int i = 0; i < sampleSize; i++) {
            long start = System.currentTimeMillis();
            try {
                authService.authorizePayment(generateTestPayment());
            } catch (Exception ignored) {}
            latencies.add(System.currentTimeMillis() - start);
        }
        latencies.sort(Long::compareTo);
        return latencies.get((int) (sampleSize * 0.99));
    }
}
```

الفرضية: ينفتح قاطع الدائرة وتعمل البدائل، فيبقى p99 أقل من 600ms (لا 1500ms) ويبقى معدل النجاح أعلى من 99% بفضل محرك القواعد المحلي.

### السيناريو 2: تحويل قاعدة البيانات أثناء حمل الذروة

```java
@SpringBootTest
@Tag("chaos")
public class DatabaseFailoverTest {

    @Autowired
    private PostgresFailoverSimulator failoverSimulator;

    @Autowired
    private PaymentProcessingLoad loadGenerator;

    @Test
    public void paymentSystemRecoverFromPrimaryDatabaseFailure()
            throws InterruptedException {
        // Start continuous load
        LoadTestSession session = loadGenerator.startContinuousLoad(
            LoadProfile.builder()
                .targetTps(100)        // 100 payments/second
                .durationMinutes(5)
                .build()
        );

        Thread.sleep(60_000); // Let load run for 1 minute at steady state

        // Record baseline metrics
        MetricSnapshot baseline = session.captureMetrics();
        log.info("Baseline: TPS={}, P99={}ms, success={}%",
            baseline.tps(), baseline.p99Latency(), baseline.successRate() * 100);

        // Inject fault: fail over primary database
        log.warn("CHAOS: Triggering database failover");
        Instant failoverStart = Instant.now();
        failoverSimulator.failOverPrimary();

        // Monitor during failover window (allow up to 30 seconds for recovery)
        Thread.sleep(30_000);
        Instant failoverEnd = Instant.now();

        // Verify recovery
        MetricSnapshot recovery = session.captureMetrics();
        Duration failoverDuration = failoverSimulator.getLastFailoverDuration();

        log.info("Post-failover: TPS={}, P99={}ms, success={}%, failover duration={}ms",
            recovery.tps(), recovery.p99Latency(),
            recovery.successRate() * 100,
            failoverDuration.toMillis());

        // Assert RTO (Recovery Time Objective) is met
        assertThat(failoverDuration.toSeconds())
            .as("Database failover RTO must be under 15 seconds")
            .isLessThan(15);

        // Assert success rate recovered to near baseline
        assertThat(recovery.successRate())
            .as("Payment success rate must recover to 99.5%+ after failover")
            .isGreaterThan(0.995);

        session.stop();
    }
}
```

يتحقق الاختبار من أن زمن تحويل قاعدة البيانات أقل من 15 ثانية، وأن معدل نجاح الدفع يعود إلى 99.5% أو أكثر بعد التحويل.

### السيناريو 3: إشباع إدخال/إخراج القرص

```java
@Component
public class DiskIoSaturator {

    /**
     * Saturates disk I/O using `stress-ng` to simulate
     * disk saturation events (common cause of database slowness
     * in production financial systems).
     */
    public ChaosHandle saturateDiskIo(String targetPath, int workers, int durationSeconds) {
        String command = String.format(
            "stress-ng --hdd %d --hdd-bytes 1G --hdd-write-size 4k " +
            "--temp-path %s --timeout %ds",
            workers, targetPath, durationSeconds
        );

        Process process = executeShellCommandAsync(command);
        log.warn("CHAOS: Saturating disk I/O at {} with {} workers for {}s",
            targetPath, workers, durationSeconds);

        return ChaosHandle.of(process, () -> {
            process.destroy();
            log.info("CHAOS: Disk I/O saturation terminated");
        });
    }
}
```

---

## تخطيط يوم التمرين (GameDay)

**يوم التمرين** تمرين منظم يكسر فيه فريق الهندسة والعمليات كله النظام عمدًا بطريقة مضبوطة، ثم يتدرب على الاستجابة والتعافي. وفي المؤسسات المالية تُعد أيام التمرين دليلًا جيدًا على المرونة التشغيلية: فلائحة DORA في الاتحاد الأوروبي تتطلب برنامج اختبار للمرونة التشغيلية الرقمية قائمًا على المخاطر (مع اختبار اختراق موجّه بالتهديدات لأكبر الشركات)، وأيام التمرين الموثقة جيدًا تساعد في تحقيق جزء منه.

### هيكل يوم التمرين

```
GameDay Agenda Template (4-hour session):

1. 09:00 - 09:30: Briefing
   - Review hypothesis and expected behavior
   - Confirm blast radius controls are in place
   - Confirm rollback procedures
   - Confirm incident response team is on standby

2. 09:30 - 09:45: Steady-State Measurement
   - Capture baseline metrics for all SLIs
   - Confirm health checks green
   - Confirm on-call escalation paths

3. 09:45 - 11:30: Fault Injection Phase
   Experiment 1 (09:45): Kill one payment processor instance
   Experiment 2 (10:15): Inject 1s latency on fraud service
   Experiment 3 (10:45): Fail primary database (failover test)
   Experiment 4 (11:00): Exhaust database connection pool
   Experiment 5 (11:15): Publish malformed payment event to Kafka

4. 11:30 - 12:00: Review and Retrospective
   - Which hypotheses held?
   - Which failed? What was the actual behavior?
   - What improvements are required?
   - Assign owners and deadlines for remediation
```

الجلسة أربع ساعات: إحاطة (مراجعة الفرضيات، وتأكيد ضوابط نطاق الأثر وإجراءات التراجع وجاهزية فريق الاستجابة)، ثم قياس الحالة المستقرة، ثم مرحلة حقن الأعطال (قتل نسخة، وتأخير خدمة الاحتيال، وتحويل قاعدة البيانات، واستنفاد مجموعة الاتصالات، ونشر حدث دفع مشوّه)، ثم مراجعة ختامية تحدد ما صمد من الفرضيات وما فشل، وتسند التحسينات إلى مالكين بمواعيد.

```java
@Service
public class GameDayOrchestrator {

    private final List<ChaosExperiment> experiments;
    private final HypothesisValidator validator;
    private final GameDayReporter reporter;
    private final EmergencyBreaker emergencyBreaker;

    public GameDayReport runGameDay(GameDayPlan plan) {
        List<ExperimentResult> results = new ArrayList<>();

        log.info("GameDay starting: {} experiments planned", plan.experiments().size());

        for (ChaosExperiment experiment : plan.experiments()) {
            log.info("Starting experiment: {}", experiment.name());

            // Safety check before each experiment
            if (!isSafeToExperiment()) {
                log.warn("GameDay paused — system health below threshold. " +
                    "Waiting for stabilization...");
                waitForStabilization();
            }

            ExperimentResult result = runExperiment(experiment);
            results.add(result);

            if (result.requiresImmediateRollback()) {
                log.error("Experiment {} caused unexpected production impact — " +
                    "activating emergency break", experiment.name());
                emergencyBreaker.activateBreak();
                break;
            }

            // Cool-down period between experiments
            sleepQuietly(Duration.ofMinutes(5));
        }

        GameDayReport report = reporter.generate(plan, results);
        log.info("GameDay complete. Passed: {}/{}", report.passedCount(), results.size());
        return report;
    }

    private ExperimentResult runExperiment(ChaosExperiment experiment) {
        Instant start = Instant.now();

        try {
            experiment.inject();
            Thread.sleep(experiment.duration().toMillis());
            HypothesisResult hypothesis = validator.validate(
                experiment.hypothesis(), start, Instant.now());
            return ExperimentResult.of(experiment, hypothesis, Instant.now());
        } catch (Exception e) {
            log.error("Experiment {} threw unexpected exception: {}",
                experiment.name(), e.getMessage());
            return ExperimentResult.error(experiment, e);
        } finally {
            experiment.rollback();
        }
    }

    private boolean isSafeToExperiment() {
        // Only run experiments if payment success rate is above 99.9%
        return metricsClient.currentPaymentSuccessRate() >= 0.999;
    }
}
```

---

## قياس نطاق الأثر

**نطاق الأثر (blast radius)** لتجربة الفوضى هو مدى تأثيرها — كم عميلًا، أو معاملة، أو خدمة تتأثر. وضبط نطاق الأثر هو ما يميز هندسة الفوضى المسؤولة عن التدمير المتهور.

```java
@Service
public class BlastRadiusCalculator {

    private final MetricsClient metricsClient;
    private final CustomerImpactTracker impactTracker;

    /**
     * Calculate the actual blast radius of a running experiment.
     * If blast radius exceeds thresholds, trigger automatic rollback.
     */
    public BlastRadiusReport measure(ChaosExperiment experiment, Instant since) {
        String window = Duration.between(since, Instant.now()).toSeconds() + "s";

        // Error RATIO now (failed / all over the last minute)
        double errorRatio = metricsClient.queryInstant(
            "sum(rate(payment_authorizations_total{result=\"error\"}[1m]))" +
            " / sum(rate(payment_authorizations_total[1m]))");

        // Failed payments since the experiment started (a count, not a rate)
        long failedPayments = (long) metricsClient.queryInstant(
            "sum(increase(payment_authorizations_total{result=\"error\"}[" + window + "]))");

        // Value of the failed payments (some will be retried successfully)
        BigDecimal avgPaymentValue = metricsClient.averagePaymentValue();
        BigDecimal failedValue = avgPaymentValue
            .multiply(BigDecimal.valueOf(failedPayments));

        BlastRadiusReport report = BlastRadiusReport.builder()
            .errorRatio(errorRatio)
            .failedPayments(failedPayments)
            .failedPaymentValue(failedValue)
            .experimentName(experiment.name())
            .measuredAt(Instant.now())
            .build();

        // Auto-rollback if blast radius is too large
        if (errorRatio > experiment.maxAcceptableErrorRatio()) {
            log.error("CHAOS AUTO-ROLLBACK: Error ratio {} exceeds threshold {}. " +
                "Rolling back experiment {}.",
                errorRatio, experiment.maxAcceptableErrorRatio(), experiment.name());
            experiment.rollback();
        }

        return report;
    }
}
```

تُحسب نسبة الأخطاء (الفاشلة / الكل)، وعدد المدفوعات الفاشلة منذ بدء التجربة (عدّ لا معدل)، وقيمة المدفوعات الفاشلة (وبعضها سيُعاد بنجاح). وإذا تجاوزت نسبة الأخطاء الحد المقبول، تُتراجع التجربة تلقائيًا.

---

## تشغيل الفوضى بأمان في الأنظمة المالية

تتطلب الأنظمة المالية ضوابط إضافية حول هندسة الفوضى:

### قائمة التحقق قبل التجربة

```java
@Component
public class ChaosPreflightChecker {

    public PreflightResult runPreflight(ChaosExperiment experiment) {
        List<String> blockers = new ArrayList<>();
        List<String> warnings = new ArrayList<>();

        // 1. Check business hours / blackout windows
        if (isInBlackoutWindow()) {
            blockers.add("Chaos experiment blocked: in blackout window " +
                "(end-of-month processing, regulatory reporting)");
        }

        // 2. Check current incident status
        if (hasOpenP1Incident()) {
            blockers.add("Chaos experiment blocked: active P1 incident in progress");
        }

        // 3. Check system health
        double successRate = metricsClient.currentPaymentSuccessRate();
        if (successRate < 0.999) {
            blockers.add(String.format(
                "Chaos experiment blocked: payment success rate %.3f below 99.9%%",
                successRate));
        }

        // 4. Check on-call coverage
        if (!onCallSchedule.isFullyStaffed()) {
            warnings.add("Warning: not all on-call roles are staffed");
        }

        // 5. Check rollback mechanism is tested
        if (!experiment.rollbackTested()) {
            warnings.add("Warning: rollback procedure has not been verified today");
        }

        // 6. Verify audit trail
        if (experiment.changeTicketId() == null) {
            blockers.add("Chaos experiment blocked: no change management ticket");
        }

        return PreflightResult.builder()
            .blockers(blockers)
            .warnings(warnings)
            .canProceed(blockers.isEmpty())
            .build();
    }

    private boolean isInBlackoutWindow() {
        // End-of-month, end-of-quarter, regulatory reporting windows
        LocalDate today = LocalDate.now();
        return today.getDayOfMonth() >= 28 ||  // End of month
               today.getDayOfMonth() == 1  ||  // Start of month (settlement)
               isQuarterEnd(today);
    }
}
```

تُحجب التجربة في نوافذ الحظر (نهاية الشهر، والتقارير التنظيمية)، أو عند وجود حادث P1 مفتوح، أو عندما يقل معدل نجاح الدفع عن 99.9%، أو عند غياب تذكرة إدارة التغيير. ويُصدر تحذير إذا لم تكن كل أدوار المناوبة مشغولة أو لم يُتحقق من إجراء التراجع اليوم.

---

## نصائح للإنتاج وأخطاء شائعة

### الخطأ 1: فوضى بلا قابلية مراقبة

تجارب الفوضى بلا فائدة دون المقاييس التي تتحقق من الفرضيات. وقبل تشغيل أي تجربة، تحقق من اكتمال منظومة المراقبة لديك:

```java
@Component
public class ChaosObservabilityValidator {

    public ObservabilityReadiness validateObservability() {
        return ObservabilityReadiness.builder()
            .hasPaymentSuccessRateMetric(
                metricsClient.metricExists("payment_authorizations_total"))
            .hasLatencyHistogram(
                metricsClient.metricExists("payment_authorization_duration_seconds_bucket"))
            .hasErrorRateAlerts(
                alertManager.hasAlertFor("payment_error_rate_high"))
            .hasDistributedTracing(
                tracingClient.isAvailable())
            .hasLogAggregation(
                loggingClient.isAvailable())
            .build();
    }
}
```

### الخطأ 2: تخطي اختبار التراجع

يجب اختبار آلية التراجع **قبل** تشغيل التجربة. فتجربة الفوضى التي لا يمكن التراجع عنها أثناء حادث في ساعات العمل هي انقطاع إنتاجي:

```java
@Test
public void rollbackMechanismMustBeTestedBeforeGameDay() {
    NetworkLatencyInjector injector = new NetworkLatencyInjector();

    // Test that injection works
    injector.injectLatency("eth0", 100, 10, 0);
    assertThat(measureNetworkLatency("eth0")).isGreaterThan(80L);

    // Test that rollback works
    injector.removeLatency("eth0");
    assertThat(measureNetworkLatency("eth0")).isLessThan(10L);
}
```

### الخطأ 3: تشغيل الفوضى أثناء نوافذ التسوية

تحدث التسوية في أوقات محددة — مواعيد قطع المخططات (مثل مواعيد تقديم ACH في اليوم نفسه، ومواعيد قطع Bacs وCHAPS)، والتشغيلات الدفعية الليلية، ونهاية الشهر. وتشغيل تجارب الفوضى خلال هذه النوافذ قد يسبب ضررًا ماليًا حقيقيًا. ضمّن نوافذ الحظر في منسّق الفوضى لديك، من الإعدادات لا من أوقات مكتوبة في الشيفرة:

```java
@Component
@RequiredArgsConstructor
public class SettlementWindowGuard {

    // From configuration: each payment scheme's cut-off times and time zone,
    // kept up to date by the payments operations team
    private final SettlementCalendar calendar;
    private static final Duration GUARD_BAND = Duration.ofMinutes(30);

    public boolean isInSettlementWindow() {
        Instant now = Instant.now();
        return calendar.cutOffsAround(now).stream()
            .anyMatch(cutOff -> Duration.between(now, cutOff).abs()
                                        .compareTo(GUARD_BAND) < 0);
    }
}
```

---

## الخلاصة

هندسة الفوضى للأنظمة المالية ليست كسر الأشياء للمتعة — بل ممارسة منضبطة لاكتشاف نقاط ضعف المرونة وإصلاحها قبل أن يكتشفها العملاء.

الممارسات الأساسية:
- **مدفوعة بالفرضيات**: كل تجربة تبدأ بتوقع قابل للقياس
- **ضبط نطاق الأثر**: ابدأ بنطاق صغير، ووسّع فقط عندما يكون ذلك آمنًا
- **المراقبة أولًا**: يجب أن توجد المقاييس قبل تشغيل التجارب
- **الحوكمة**: إدارة التغيير، ومسارات الموافقة، وسجلات التدقيق
- **تراجع مختبر**: لكل تجربة تراجع مُتحقق منه
- **نوافذ الحظر**: لا تشغّل الفوضى أبدًا أثناء التسوية، أو التشغيلات الدفعية، أو النوافذ التنظيمية
- **يوم التمرين**: تمارين منظمة تتضمن التدرب على الاستجابة للحوادث

الهدف النهائي لهندسة الفوضى في سياق التقنية المالية هو **الثقة**: الثقة بأنه عند وقوع عطل في الإنتاج، سيتدهور النظام بلطف، وستنطلق التنبيهات، وسيعرف المهندسون كيف يستجيبون، وسيعاني العملاء أقل أثر ممكن.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما فرضية هندسة الفوضى، ولماذا تُشترط قبل تشغيل أي تجربة؟",
      "options": ["الفرضية توثيق اختياري لأغراض التدقيق", "تحدد الفرضية سلوك النظام المتوقع تحت حالة فشل؛ ودونها تكون الفوضى تدميرًا عشوائيًا بلا نتيجة قابلة للقياس", "الفرضية ملف إعداد أداة Chaos Monkey", "تحدد الفرضية إجراء التراجع إذا فشلت التجربة"],
      "correct": 1,
      "explanation": "تتوقع فرضية الفوضى أنه 'عند وقوع الفشل X، يتصرف النظام بالسلوك Y بسبب Z، ونقيسه بالمقياس M'. ودون فرضية لا توجد طريقة لتحديد هل كشفت التجربة ضعفًا أم أكدت المرونة. فهي تحوّل الكسر العشوائي إلى تجربة علمية."
    },
    {
      "text": "لماذا تتجنب المؤسسات المالية عادة تشغيل تجارب الفوضى أثناء نوافذ التسوية أو التشغيلات الدفعية؟",
      "options": ["أنظمة التسوية بسيطة جدًا فلا تستفيد من اختبار الفوضى", "لا يمكن فرض ضوابط نطاق الأثر أثناء التشغيلات الدفعية", "هذه نوافذ عالية العواقب يسبب فيها أي فشل مستحث أثرًا ماليًا جوهريًا أو أخطاء في التقارير التنظيمية يصعب عكسها", "تتطلب أدوات الفوضى وصولًا حصريًا إلى بنية الإنتاج"],
      "correct": 2,
      "explanation": "تعالج نوافذ التسوية والتشغيل الدفعي أحجامًا كبيرة من المعاملات المالية الحساسة للوقت. والأعطال خلالها تسبب أثرًا ماليًا جوهريًا، واحتمال أخطاء في التقارير التنظيمية، وضررًا للعملاء. لذلك تُحصر تجارب الفوضى في النوافذ خارج الذروة لتقليل نطاق الأثر."
    },
    {
      "text": "ما الذي يميز نطاق الأثر في هندسة الفوضى، ولماذا يجب تقليله والتوسع فيه تدريجيًا؟",
      "options": ["يقيس نطاق الأثر أثر أدوات حقن الأعطال على المعالج", "نطاق الأثر هو مدى التأثير المحتمل — البدء صغيرًا (1% من الحركة، أو منطقة توفر واحدة) يحد الضرر إذا فشل النظام أسوأ من المتوقع، قبل توسيع النطاق", "يشير نطاق الأثر إلى عدد المهندسين الذين يُنبَّهون أثناء التجربة", "تقليل نطاق الأثر يعني تشغيل التجارب في بيئات ما قبل الإنتاج فقط"],
      "correct": 1,
      "explanation": "يحدد نطاق الأثر مقدار ما يتعرض من النظام للعطل المحقون. والبدء صغيرًا — نسخة واحدة، أو منطقة واحدة، أو 1% من الحركة — يعني أن النتيجة الأسوأ من المتوقع تؤثر في جزء صغير فقط من العملاء. والتوسع التدريجي يبني الثقة قبل تعريض النظام كله."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{"title": "تجربة فوضى مدفوعة بالفرضيات لمسار تفويض المدفوعات", "difficulty": "advanced", "estimatedMinutes": 45, "tasks": [{"id": "1", "description": "اكتب فرضية فوضى رسمية للسيناريو: تتباطأ استدعاءات خدمة كشف الاحتيال إلى 2,000ms (أعلى من مهلة العميل البالغة ثانية واحدة). وحدّد مقاييس الحالة المستقرة (زمن تفويض p99 أقل من 1.5 ثانية، ومعدل نجاح أعلى من 99.5%)، والسلوك المتوقع (ينفتح قاطع الدائرة ويتولى محرك القواعد المحلي)، ونافذة القياس (10 دقائق)."}, {"id": "2", "description": "باستخدام Toxiproxy (أو Chaos Toolkit مع امتداد Toxiproxy)، احقن تأخيرًا قدره 2,000ms على الاتصال بين خدمة تفويض الدفع وخدمة كشف الاحتيال فقط. وشغّل التجربة تحت حمل واقعي (500 معاملة في الثانية)، وقِس هل صمدت الفرضية، ووثّق أي انحرافات."}, {"id": "3", "description": "نفّذ قاطع الدائرة باستخدام Resilience4j على عميل كشف الاحتيال. واضبط الدائرة لتنفتح بعد 5 أعطال خلال 10 ثوانٍ مع مهلة ثانية واحدة. وتحقق عبر تجربة فوضى من أن الدائرة تنفتح بشكل صحيح وأن البديل (محرك القواعد المحلي) يعمل دون زمن إضافي."}, {"id": "4", "description": "ابنِ دليل تشغيل ليوم تمرين لسيناريو تعطل pod: حدّد قائمة التحقق قبل التجربة، ومعايير النجاح، وإجراء التراجع، وقالب التحليل بعد التجربة. وشغّل التجربة بحذف pod عشوائي لخدمة الدفع تحت الحمل، وتحقق من تعافي النظام ضمن اتفاقية الخدمة."}]}
-->
