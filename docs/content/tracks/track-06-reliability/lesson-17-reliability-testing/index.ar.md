---
id: track-06-lesson-17
title: "اختبار الموثوقية — اختبارات الحمل والتحمّل والذروة"
slug: reliability-testing
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 17
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [load-testing, soak-testing, spike-testing, Gatling, k6]
prerequisites: [track-06-lesson-01]
---

# اختبار الموثوقية — اختبارات الحمل والتحمل الطويل والقفزات

> [!NOTE]
> اختبار الأداء لأنظمة التقنية المالية ليس اختياريًا. فلمعالجة الدفع أنماط ذروة معروفة — مدفوعات الرواتب نهاية الشهر، وتسوق العطلات، والقفزات التي تطلقها أحداث — تصل في أوقات متوقعة. والفرق بين نظام يتعامل مع الجمعة السوداء ونظام ينهار هو اختبار تحمل طويل (soak) وجد تسرب الذاكرة قبل ثلاثة أشهر.

## تصنيف أنواع الاختبارات

| نوع الاختبار | المدة | الغرض | ما يكشفه |
|---|---|---|---|
| اختبار الدخان (Smoke) | 1–5 دقائق | سلامة أساسية بحمل منخفض | أخطاء واضحة، وإعداد خاطئ |
| اختبار الحمل (Load) | 30–60 دقيقة | التحقق من أهداف SLO عند الحمل المتوقع | حدود الإنتاجية، وزمن p99 |
| اختبار الإجهاد (Stress) | 30–60 دقيقة | إيجاد نقطة الانكسار | السعة القصوى |
| اختبار التحمل الطويل (Soak) | 4–24 ساعة | الاستقرار طويل المدة | تسرب الذاكرة، واستنفاد مجمع الاتصالات، وضغط GC |
| اختبار القفزة (Spike) | 15–30 دقيقة | الاستجابة لزيادة حركة مفاجئة | سرعة التوسع الآلي، والقطيع الهائج، وسلوك قاطع الدائرة |
| اختبار نقطة الانكسار (Breakpoint) | حتى الفشل | إيجاد عتبة الفشل الدقيقة | تخطيط السعة |

## 1. تصميم نمط الحمل

قبل كتابة أي اختبار، عرّف أنماط حمل واقعية من مقاييس الإنتاج:

```java
@Component
public class ProductionLoadProfiler {

    private final MetricsClient metricsClient;

    // Extract load profile from production metrics for test design
    public LoadProfile extractProfile(Duration window) {
        List<DataPoint> tpsHistory = metricsClient.query(
                "rate(payment_requests_total[1m])",
                Instant.now().minus(window),
                Instant.now());

        DoubleSummaryStatistics stats = tpsHistory.stream()
                .mapToDouble(DataPoint::getValue)
                .summaryStatistics();

        // Identify peak patterns
        double avgTps  = stats.getAverage();
        double peakTps = stats.getMax();
        double p95Tps  = percentile(tpsHistory, 0.95);

        // Peak hours from production
        Map<Integer, Double> hourlyProfile = tpsHistory.stream()
                .collect(Collectors.groupingBy(
                        dp -> dp.getTimestamp().atZone(ZoneOffset.UTC).getHour(),
                        Collectors.averagingDouble(DataPoint::getValue)));

        return LoadProfile.builder()
                .avgTps(avgTps)
                .peakTps(peakTps)
                .p95Tps(p95Tps)
                .hourlyProfile(hourlyProfile)
                .peakHour(hourlyProfile.entrySet().stream()
                        .max(Map.Entry.comparingByValue())
                        .map(Map.Entry::getKey).orElse(0))
                .build();
    }
}
```

## 2. محاكاة Gatling لواجهات الدفع

```scala
// Gatling simulation — Scala DSL
// Tests the payment authorisation endpoint under realistic load

import io.gatling.core.Predef._
import io.gatling.http.Predef._
import scala.concurrent.duration._

class PaymentAuthorisationSimulation extends Simulation {

  val httpProtocol = http
    .baseUrl("https://api.payments.internal")
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    .header("X-API-Key", System.getenv("PERF_TEST_API_KEY"))

  // Realistic payment request feeder from CSV
  // payment_id,amount,currency,merchant_id,card_id
  val paymentFeeder = csv("payments.csv").random

  val authorisePayment = scenario("Authorise Payment")
    .feed(paymentFeeder)
    .exec(
      http("POST /v1/payments/authorise")
        .post("/v1/payments/authorise")
        .body(StringBody(
          // A FRESH payment ID per request (Gatling EL: #{...}; the old ${...}
          // syntax is deprecated). Re-using CSV IDs would turn requests into
          // idempotency-key replays and measure the cache, not the payment path.
          """{"payment_id":"#{randomUuid()}",
             "amount":#{amount},
             "currency":"#{currency}",
             "merchant_id":"#{merchant_id}",
             "card_id":"#{card_id}"}"""
        ))
        .asJson
        .check(status.in(200, 201))
        .check(jsonPath("$.status").in("APPROVED", "DECLINED", "PENDING"))
        // No per-request responseTimeInMillis check: it would mark every
        // request slower than 500ms as FAILED, turning the p99 SLO into a
        // p99.9 one. Latency SLOs are asserted on percentiles below.
    )

  val getPaymentStatus = scenario("Get Payment Status")
    .feed(paymentFeeder)
    .exec(
      http("GET /v1/payments/:id")
        .get("/v1/payments/#{payment_id}")    // existing payments from the CSV
        .check(status.is(200))
    )

  // Load profile (open model: each new "user" sends ONE request, so users/sec
  // = requests/sec): ramp to 500 TPS over 5 minutes, sustain 20 minutes.
  // (Arrival rate and the throughput assertion must agree — 100 users/sec
  //  could never reach 450 RPS.)
  setUp(
    authorisePayment.inject(
      rampUsersPerSec(1).to(500).during(5.minutes),
      constantUsersPerSec(500).during(20.minutes),
      rampUsersPerSec(500).to(1).during(5.minutes)
    ),
    getPaymentStatus.inject(
      constantUsersPerSec(50).during(30.minutes)
    )
  ).protocols(httpProtocol)
   .assertions(
     // Global SLO assertions — test suite fails if violated
     global.responseTime.percentile(99).lte(500),
     global.responseTime.percentile(95).lte(200),
     global.successfulRequests.percent.gte(99.9),
     // Throughput assertion
     global.requestsPerSec.gte(450)
   )
}
```

## 3. اختبار التحمل الطويل لكشف تسرب الذاكرة

```scala
class PaymentSoakSimulation extends Simulation {

  val httpProtocol = http
    .baseUrl("https://api.payments.internal")
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    .header("X-API-Key", System.getenv("PERF_TEST_API_KEY"))

  val paymentFeeder = csv("payments.csv").circular  // circular for long-running

  // Soak test: 8 hours at 60% of peak load
  // Detects: memory leaks, connection pool exhaustion, GC pressure,
  //          database connection leaks, Kafka consumer lag buildup
  val soakScenario = scenario("Payment Soak Test")
    .feed(paymentFeeder)
    .exec(
      http("Authorise Payment")
        .post("/v1/payments/authorise")
        .body(StringBody(
          """{"payment_id":"#{payment_id}",
             "amount":#{amount},
             "currency":"#{currency}",
             "merchant_id":"#{merchant_id}",
             "card_id":"#{card_id}"}"""
        ))
        .asJson
        .check(status.in(200, 201))
    )

  setUp(
    soakScenario.inject(
      rampUsersPerSec(1).to(50).during(5.minutes),
      constantUsersPerSec(50).during(8.hours),   // 50 TPS for 8 hours
      rampUsersPerSec(50).to(1).during(5.minutes)
    )
  ).protocols(httpProtocol)
   .assertions(
     // Response time should not degrade over the soak period: compare the
     // first and last hour in the metrics afterwards (section 8) — Gatling's
     // global assertions only see the whole run
     global.responseTime.percentile(99).lte(1000),
     global.successfulRequests.percent.gte(99.5)
   )
}
```

### مراقبة الذاكرة في اختبار التحمل الطويل

```java
@Component
public class SoakTestMemoryMonitor {

    private static final Logger log = LoggerFactory.getLogger(SoakTestMemoryMonitor.class);
    private final MeterRegistry meterRegistry;

    public SoakTestMemoryMonitor(MeterRegistry meterRegistry) {
        this.meterRegistry = meterRegistry;
    }

    // Micrometer already publishes what a soak test needs — do not register
    // your own "jvm.memory.used" (it clashes with the built-in meter):
    //   jvm_memory_used_bytes{area="heap"}   heap in use (saw-tooth with GC)
    //   jvm_gc_live_data_size_bytes          heap LEFT after a full GC ← the leak signal
    //   hikaricp_connections_active / _idle / _pending
    // "Used heap" right now includes garbage that is about to be collected,
    // so it is noisy; the live-data size after GC rising hour after hour is
    // what reveals a leak.

    @Scheduled(fixedRate = 60_000)
    public void logLiveData() {
        Gauge liveData = meterRegistry.find("jvm.gc.live.data.size").gauge();
        Gauge maxData  = meterRegistry.find("jvm.gc.max.data.size").gauge();
        if (liveData != null && maxData != null && maxData.value() > 0) {
            double utilisation = liveData.value() / maxData.value();
            if (utilisation > 0.85) {
                log.warn("Live heap after GC at {}% of the old generation during soak test",
                        String.format("%.1f", utilisation * 100));
            }
        }
    }

    // Connection pool: in steady state "active" should hover, not climb
    public void checkConnectionPoolLeak(HikariDataSource hikariDs) {
        int active = hikariDs.getHikariPoolMXBean().getActiveConnections();
        int idle   = hikariDs.getHikariPoolMXBean().getIdleConnections();
        if (active >= hikariDs.getMaximumPoolSize()) {
            log.error("Connection pool exhausted during soak test: active={} idle={}",
                    active, idle);
        }
    }
}
```

## 4. اختبار القفزة لسيناريوهات الجمعة السوداء

```scala
class PaymentSpikeSimulation extends Simulation {

  val httpProtocol = http
    .baseUrl("https://api.payments.internal")
    .acceptHeader("application/json")
    .contentTypeHeader("application/json")
    .header("X-API-Key", System.getenv("PERF_TEST_API_KEY"))

  val paymentFeeder = csv("payments.csv").random

  val paymentScenario = scenario("Spike Payment Load")
    .feed(paymentFeeder)
    .exec(
      http("Authorise Payment")
        .post("/v1/payments/authorise")
        .body(StringBody(
          """{"payment_id":"#{payment_id}",
             "amount":#{amount},
             "currency":"#{currency}",
             "merchant_id":"#{merchant_id}",
             "card_id":"#{card_id}"}"""
        ))
        .asJson
        .check(status.in(200, 201, 429))  // 429 (rate limited) is acceptable
        .check(responseTimeInMillis.lte(2000))
    )

  // Spike: 10x normal load, sudden onset
  // Simulates: Black Friday, viral marketing, bot attack
  setUp(
    paymentScenario.inject(
      constantUsersPerSec(50).during(2.minutes),    // baseline
      rampUsersPerSec(50).to(500).during(1.minute),  // spike onset (10x)
      constantUsersPerSec(500).during(5.minutes),    // sustained spike
      rampUsersPerSec(500).to(50).during(2.minutes), // recovery
      constantUsersPerSec(50).during(5.minutes)      // post-spike
    )
  ).protocols(httpProtocol)
   .assertions(
     // Success rate can drop during spike but must recover
     global.successfulRequests.percent.gte(95),
     // p99 is allowed to spike but should recover
     global.responseTime.percentile(99).lte(5000)
   )
}
```

## 5. ‏k6 للسيناريوهات الأبسط

```javascript
// k6 script for fraud scoring API load test
// Simpler syntax, good for quick API tests

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('error_rate');
const fraudScoreLatency = new Trend('fraud_score_latency_ms');

export const options = {
  stages: [
    { duration: '2m',  target: 50  },  // ramp up
    { duration: '10m', target: 50  },  // sustain
    { duration: '2m',  target: 100 },  // ramp to peak
    { duration: '5m',  target: 100 },  // sustain peak
    { duration: '2m',  target: 0   },  // ramp down
  ],
  thresholds: {
    // SLO: p99 fraud scoring latency < 50ms
    'fraud_score_latency_ms': ['p(99)<50'],
    // Error rate < 0.1%
    'error_rate': ['rate<0.001'],
    // HTTP errors < 0.1%
    'http_req_failed': ['rate<0.001'],
  },
};

export default function () {
  const payload = JSON.stringify({
    transaction_id: `txn-${Math.random().toString(36).substring(7)}`,
    card_id: `card-${Math.floor(Math.random() * 1000000)}`,
    amount: Math.floor(Math.random() * 10000) / 100,
    merchant_id: `merchant-${Math.floor(Math.random() * 1000)}`,
    mcc: '5411',
    is_card_present: Math.random() > 0.3,
    ip_address: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
  });

  const res = http.post(
    'https://api.payments.internal/v1/fraud/score',
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': __ENV.API_KEY,
      },
      timeout: '5s',
    }
  );

  // k6's own measurement of the request (excludes script overhead)
  const latency = res.timings.duration;
  fraudScoreLatency.add(latency);

  // Parse once, and never on an error body (JSON.parse would throw)
  let body = null;
  if (res.status === 200) {
    try { body = res.json(); } catch (e) { body = null; }
  }

  const success = check(res, {
    'status is 200':          (r) => r.status === 200,
    'has fraud_score field':  () => body !== null && body.fraud_score !== undefined,
    'fraud_score in [0,1]':   () => body !== null && body.fraud_score >= 0 && body.fraud_score <= 1,
  });
  // (latency is judged by the p(99) threshold, not per request)

  errorRate.add(!success);
  sleep(0.1);  // 10 TPS per VU
}
```

## 6. التكامل مع خط CI لكشف تراجع الأداء

```yaml
# .gitlab-ci.yml / GitHub Actions equivalent
performance-test:
  stage: performance
  only:
    - main
    - release/*
  script:
    # Run smoke test on every merge
    - gatling.sh -sf src/gatling -s PaymentSmoke -rd "CI smoke test"

    # Run full load test on release branches
    - |
      if [[ "$CI_COMMIT_REF_NAME" == release/* ]]; then
        gatling.sh -sf src/gatling -s PaymentAuthorisationSimulation -rd "Release load test"
      fi

    # Assert on Gatling results
    - python3 ci/assert_gatling_results.py
        --results-dir results/gatling
        --p99-threshold 500
        --success-rate-threshold 99.9
        --throughput-threshold 450
  artifacts:
    # simulation.log is Gatling's own format, NOT a JUnit report — keep the
    # HTML report and stats as plain artifacts
    paths:
      - results/gatling/
    expire_in: 30 days
```

```python
# ci/assert_gatling_results.py
import argparse, glob, json, os, sys

def latest_stats(results_dir):
    # Gatling writes one timestamped folder per run: <dir>/<run>/js/stats.json
    runs = sorted(glob.glob(os.path.join(results_dir, "*", "js", "stats.json")),
                  key=os.path.getmtime)
    if not runs:
        sys.exit(f"No Gatling stats.json found under {results_dir}")
    return runs[-1]

def assert_results(results_dir, p99_ms, success_rate, throughput):
    with open(latest_stats(results_dir)) as f:
        stats = json.load(f)["stats"]

    # percentiles4 is p99 with Gatling's default percentile settings
    actual_p99        = stats["percentiles4"]["total"]
    requests          = stats["numberOfRequests"]
    actual_success    = 100.0 * requests["ok"] / requests["total"]
    actual_throughput = stats["meanNumberOfRequestsPerSecond"]["total"]

    failures = []
    if actual_p99 > p99_ms:
        failures.append(f"p99 {actual_p99}ms > threshold {p99_ms}ms")
    if actual_success < success_rate:
        failures.append(f"Success rate {actual_success:.2f}% < threshold {success_rate}%")
    if actual_throughput < throughput:
        failures.append(f"Throughput {actual_throughput:.1f} RPS < threshold {throughput} RPS")

    if failures:
        print("PERFORMANCE TEST FAILED:")
        for failure in failures:
            print(f"  - {failure}")
        sys.exit(1)
    print(f"Performance test PASSED: p99={actual_p99}ms, "
          f"success={actual_success:.2f}%, throughput={actual_throughput:.1f}RPS")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--results-dir", required=True)
    ap.add_argument("--p99-threshold", type=float, required=True)
    ap.add_argument("--success-rate-threshold", type=float, required=True)
    ap.add_argument("--throughput-threshold", type=float, required=True)
    a = ap.parse_args()
    assert_results(a.results_dir, a.p99_threshold,
                   a.success_rate_threshold, a.throughput_threshold)
```

## 7. استراتيجية التحقق من أهداف SLO

```java
@Component
public class PerformanceTestSLOValidator {

    // SLOs to validate in performance tests (should match production SLOs)
    private static final Map<String, PerformanceSLO> ENDPOINT_SLOS = Map.of(
            "POST /v1/payments/authorise", new PerformanceSLO(
                    200,   // p50 ms
                    500,   // p99 ms
                    99.9   // success rate %
            ),
            "POST /v1/fraud/score", new PerformanceSLO(
                    20,    // p50 ms
                    50,    // p99 ms
                    99.95  // success rate %
            ),
            "GET /v1/accounts/{id}", new PerformanceSLO(
                    50,    // p50 ms
                    100,   // p99 ms
                    99.99  // success rate %
            ),
            "POST /v1/kyc/screen", new PerformanceSLO(
                    1000,  // p50 ms
                    3000,  // p99 ms
                    99.0   // success rate %
            )
    );

    public ValidationResult validate(GatlingSimulationResults results) {
        List<String> violations = new ArrayList<>();

        for (Map.Entry<String, PerformanceSLO> entry : ENDPOINT_SLOS.entrySet()) {
            String endpoint = entry.getKey();
            PerformanceSLO slo = entry.getValue();

            EndpointStats stats = results.getStatsForEndpoint(endpoint);
            if (stats == null) continue;

            if (stats.getP99Latency() > slo.getP99Ms()) {
                violations.add(String.format("%s: p99 %dms > SLO %dms",
                        endpoint, stats.getP99Latency(), slo.getP99Ms()));
            }
            if (stats.getSuccessRate() < slo.getSuccessRatePercent()) {
                violations.add(String.format("%s: success %.2f%% < SLO %.2f%%",
                        endpoint, stats.getSuccessRate(), slo.getSuccessRatePercent()));
            }
        }

        return ValidationResult.builder()
                .passed(violations.isEmpty())
                .violations(violations)
                .build();
    }
}
```

## 8. تحديد تسرب الذاكرة من اختبارات التحمل الطويل

```java
// Analysis tool for soak test results
@Component
public class SoakTestResultAnalyser {

    // Detect linear memory growth (indicates leak) vs stable oscillation (normal GC).
    // Feed it the heap remaining AFTER GC (jvm_gc_live_data_size_bytes), not
    // instantaneous used heap — the latter mixes in garbage and saw-tooths.
    public MemoryAnalysisResult analyseMemoryProfile(
            List<TimestampedMetric> memoryMetrics) {

        if (memoryMetrics.size() < 10) {
            return MemoryAnalysisResult.insufficient();
        }

        // Split into first half and second half of soak test
        int midpoint = memoryMetrics.size() / 2;
        double firstHalfAvg = memoryMetrics.subList(0, midpoint).stream()
                .mapToDouble(TimestampedMetric::getValue).average().orElse(0);
        double secondHalfAvg = memoryMetrics.subList(midpoint, memoryMetrics.size()).stream()
                .mapToDouble(TimestampedMetric::getValue).average().orElse(0);

        // Calculate linear regression slope
        double slope = calculateLinearRegressionSlope(memoryMetrics);

        // Memory growing by > 1% per hour = likely leak
        double hourlyGrowthRate = slope * 3600;  // slope is per-second
        double hourlyGrowthPercent = hourlyGrowthRate / firstHalfAvg * 100;

        boolean likelyLeak = hourlyGrowthPercent > 1.0;

        return MemoryAnalysisResult.builder()
                .firstHalfAvgMB(firstHalfAvg / (1024 * 1024))
                .secondHalfAvgMB(secondHalfAvg / (1024 * 1024))
                .hourlyGrowthPercent(hourlyGrowthPercent)
                .likelyLeak(likelyLeak)
                .recommendation(likelyLeak
                        ? "Memory growth of %.1f%%/hour detected. Take heap dump and analyse.".formatted(hourlyGrowthPercent)
                        : "Memory profile stable. No leak detected.")
                .build();
    }
}
```

## الخلاصة

اختبار الموثوقية ليس اختياريًا لأنظمة التقنية المالية. فاختبارات الحمل تتحقق من أهداف SLO عند الإنتاجية المتوقعة. واختبارات التحمل الطويل تكشف تسرب الذاكرة واستنفاد مجمع الاتصالات اللذين لا يظهران إلا بعد ساعات من التشغيل. واختبارات القفزة تتحقق من أن النظام يتعامل مع زيادات حركة مفاجئة بعشرة أضعاف دون فشل كارثي. ودمج اختبارات الأداء في خطوط CI يخلق شبكة أمان من التراجع: فالتغيير الذي يضاعف زمن p99 يُلتقط قبل وصوله إلى الإنتاج. ويجب أن يبدأ تصميم الاختبار من أنماط حركة الإنتاج — فالاختبار بملفات حمل غير واقعية ينتج نتائج عديمة الفائدة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "أي نوع اختبار هو الأنسب لاكتشاف تسرب ذاكرة في خدمة دفع لا يظهر إلا بعد عدة ساعات من التشغيل؟",
      "options": ["اختبار الحمل (30–60 دقيقة عند الحمل المتوقع)", "اختبار الدخان (5 دقائق بحمل منخفض)", "اختبار التحمل الطويل (8+ ساعات بحمل مستمر)", "اختبار القفزة (10 أضعاف الحركة لمدة 5 دقائق)"],
      "correct": 2,
      "explanation": "تتراكم تسربات الذاكرة ببطء — فهي غير مرئية في الاختبارات قصيرة المدة. واختبار التحمل الطويل بحمل مستمر لمدة 8+ ساعات يكشف نموًا تدريجيًا في الـ heap لا يستطيع GC استعادته. والنمط الذي يُبحث عنه هو نمو خطي في الذاكرة المتبقية بعد GC بدل نمط المنشار الطبيعي للاستخدام السليم."
    },
    {
      "text": "يستخدم اختبار قفزة لواجهة دفع فحص status.in(200, 201, 429). لماذا يُضمّن 429 كحالة مقبولة؟",
      "options": ["429 يعني أن الدفعة صُفّت للمعالجة لاحقًا", "تحديد المعدل (429) سلوك مقبول أثناء القفزة — فهو يُظهر أن الخدمة تحمي الأنظمة اللاحقة بدل أن تفشل", "يُعاد 429 عندما تؤجَّل فحوص الاحتيال", "لا يستطيع Gatling التمييز بين 429 و200"],
      "correct": 1,
      "explanation": "أثناء قفزة حركة بعشرة أضعاف، من المقبول والمرغوب أن تحدد خدمة الدفع معدل بعض الطلبات (429) بدل ترك القفزة كاملة تتتالى إلى الأنظمة اللاحقة. وإعادة 429 مع Retry-After تعني أن العملاء يستطيعون إعادة المحاولة لاحقًا، بينما يحمي النظام معالج الدفع وقاعدة البيانات والاعتماديات الأخرى."
    },
    {
      "text": "ما النهج الصحيح لتصميم ملف حمل لاختبار الأداء؟",
      "options": ["استخدم 100 مستخدم افتراضي كخط أساس قياسي لكل الخدمات", "صمم ملف الحمل من مقاييس حركة الإنتاج — المعاملات الفعلية في الثانية، وأنماط الذروة، ونسب الاندفاع", "استخدم أقصى حمل ممكن نظريًا لإيجاد نقطة الانكسار", "ابدأ بـ 10 معاملات في الثانية وضاعفها كل 10 دقائق"],
      "correct": 1,
      "explanation": "الاختبار بملفات حمل غير واقعية ينتج نتائج بلا معنى. أما اختبارات الحمل المصممة من مقاييس الإنتاج — متوسط المعاملات في الثانية، وp95 لها، وساعات الذروة، ومحفزات القفزات المعروفة مثل رواتب نهاية الشهر — فتنتج نتائج قابلة للتنفيذ تتحقق من أهداف SLO الواقعية. واختبار بعشرة أضعاف الذروة يمرّن أنماط الفشل الخاطئة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "حزمة اختبار موثوقية شاملة لواجهة تفويض الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "اكتب محاكاة حمل في Gatling لواجهة تفويض الدفع بنموذج حقن مفتوح (طلب واحد لكل مستخدم افتراضي): ارفع من 1 إلى 500 مستخدم/ثانية خلال 5 دقائق، واستمر 20 دقيقة، ثم اخفض، مع معرّف دفعة جديد لكل طلب. وأكد أن p99 <= 500 مللي ثانية، وp95 <= 200 مللي ثانية، ونسبة النجاح >= 99.9%، والإنتاجية >= 450 طلبًا/ثانية. وأفشل البناء إذا فشل أي تأكيد."},
    {"id": "2", "description": "اكتب محاكاة تحمل طويل في Gatling: شغّلها بـ 50 معاملة/ثانية لمدة 8 ساعات باستخدام مغذٍّ دائري. ونفّذ تحليلًا للتحمل الطويل يستخدم jvm_gc_live_data_size_bytes من Micrometer (الـ heap بعد GC)، ويحسب ميل انحدار خطي، ويعلّم النمو الذي يتجاوز 1%/ساعة كتسرب محتمل."},
    {"id": "3", "description": "اكتب محاكاة قفزة في Gatling: خط أساس 50 معاملة/ثانية لمدة دقيقتين، وقفزة إلى 500 معاملة/ثانية (10 أضعاف) لمدة 5 دقائق، ثم التعافي. وأكد أن نسبة النجاح العامة >= 95% (ردود 429 مقبولة)، وأن p99 أثناء القفزة لا يتجاوز 5000 مللي ثانية. ووثّق سلوك قاطع الدائرة الذي تتوقع رؤيته."},
    {"id": "4", "description": "أنشئ خطوة في خط CI: تشغّل اختبار الدخان عند كل دمج إلى main، وتشغّل اختبار الحمل الكامل على فروع الإصدار، وتحلل stats.json من Gatling لاستخراج p99 ونسبة النجاح والإنتاجية، وتخرج برمز 1 إذا انتُهكت أي عتبة SLO. وضمّن سكربت تأكيد بـ Python."}
  ]
}
-->
