---
id: track-08-lesson-17
title: "Reliability Testing — Load, Soak, and Spike Testing"
slug: reliability-testing
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 17
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [load-testing, soak-testing, spike-testing, Gatling, k6]
prerequisites: [track-08-lesson-01]
---

# Reliability Testing — Load, Soak, and Spike Testing

> [!NOTE]
> Performance testing for fintech systems is not optional. Payment processing has known peak patterns — month-end salary payments, holiday shopping, event-triggered spikes — that arrive at predictable times. The difference between a system that handles Black Friday and one that collapses is a soak test that found the memory leak three months earlier.

## Test Type Taxonomy

| Test Type | Duration | Purpose | What It Finds |
|---|---|---|---|
| Smoke test | 1-5 min | Basic sanity at low load | Obvious errors, misconfiguration |
| Load test | 30-60 min | Validate SLOs at expected load | Throughput limits, p99 latency |
| Stress test | 30-60 min | Find the breaking point | Maximum capacity |
| Soak test | 4-24 hours | Long-duration stability | Memory leaks, connection pool exhaustion, GC pressure |
| Spike test | 15-30 min | Response to sudden traffic increase | Auto-scaling speed, thundering herd, circuit breaker behaviour |
| Breakpoint test | Until failure | Find exact failure threshold | Capacity planning |

---

## 1. Load Pattern Design

Before writing any test, define realistic load patterns from production metrics:

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

---

## 2. Gatling Simulation for Payment APIs

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
          """{"payment_id":"${payment_id}",
             "amount":${amount},
             "currency":"${currency}",
             "merchant_id":"${merchant_id}",
             "card_id":"${card_id}"}"""
        ))
        .asJson
        // SLO assertions — test fails if violated
        .check(status.in(200, 201))
        .check(responseTimeInMillis.lte(500))  // p99 SLO: 500ms
        .check(jsonPath("$.status").in("APPROVED", "DECLINED", "PENDING"))
    )

  val getPaymentStatus = scenario("Get Payment Status")
    .feed(paymentFeeder)
    .exec(
      http("GET /v1/payments/:id")
        .get("/v1/payments/${payment_id}")
        .check(status.is(200))
        .check(responseTimeInMillis.lte(100))  // SLO: 100ms for reads
    )

  // Load profile: ramp to peak over 5 minutes, sustain 20 minutes
  setUp(
    authorisePayment.inject(
      rampUsersPerSec(1).to(100).during(5.minutes),
      constantUsersPerSec(100).during(20.minutes),
      rampUsersPerSec(100).to(1).during(5.minutes)
    ).throttle(
      reachRps(500).in(5.minutes),  // cap at 500 TPS
      holdFor(20.minutes)
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

---

## 3. Soak Test for Memory Leak Detection

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
          """{"payment_id":"${payment_id}",
             "amount":${amount},
             "currency":"${currency}",
             "merchant_id":"${merchant_id}",
             "card_id":"${card_id}"}"""
        ))
        .asJson
        .check(status.in(200, 201))
        .check(responseTimeInMillis.lte(1000))  // relaxed for soak
    )

  setUp(
    soakScenario.inject(
      rampUsersPerSec(1).to(50).during(5.minutes),
      constantUsersPerSec(50).during(8.hours),   // 50 TPS for 8 hours
      rampUsersPerSec(50).to(1).during(5.minutes)
    )
  ).protocols(httpProtocol)
   .assertions(
     // Response time should not degrade over the soak period
     // Compare first vs last 10 minutes
     global.responseTime.percentile(99).lte(1000),
     global.successfulRequests.percent.gte(99.5)
   )
}
```

### Soak Test Memory Monitoring

```java
@Component
public class SoakTestMemoryMonitor {

    private final MeterRegistry meterRegistry;
    private static final Logger log = LoggerFactory.getLogger(SoakTestMemoryMonitor.class);

    // During soak tests: monitor for memory growth
    @Scheduled(fixedRate = 60_000)
    public void recordMemoryMetrics() {
        Runtime runtime = Runtime.getRuntime();
        long usedMemory = runtime.totalMemory() - runtime.freeMemory();
        long maxMemory  = runtime.maxMemory();
        double utilisation = (double) usedMemory / maxMemory;

        meterRegistry.gauge("jvm.memory.used",    usedMemory);
        meterRegistry.gauge("jvm.memory.max",     maxMemory);
        meterRegistry.gauge("jvm.memory.utilisation", utilisation);

        // During soak test: alert if memory grows continuously
        // (indicates leak — GC should stabilise usage over time)
        if (utilisation > 0.85) {
            log.warn("High memory utilisation during soak test: {:.1f}%",
                    utilisation * 100);
        }
    }

    // Check for connection pool growth (should be constant in steady state)
    public void checkConnectionPoolLeak(DataSource ds) {
        if (ds instanceof HikariDataSource hikariDs) {
            int active = hikariDs.getHikariPoolMXBean().getActiveConnections();
            int idle   = hikariDs.getHikariPoolMXBean().getIdleConnections();
            int total  = active + idle;

            meterRegistry.gauge("hikari.connections.active", active);
            meterRegistry.gauge("hikari.connections.idle",   idle);
            meterRegistry.gauge("hikari.connections.total",  total);

            // If total connections grow continuously: connection leak
            if (total >= hikariDs.getMaximumPoolSize()) {
                log.error("Connection pool exhausted during soak test: active={} idle={}",
                        active, idle);
            }
        }
    }
}
```

---

## 4. Spike Test for Black Friday Scenarios

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
          """{"payment_id":"${payment_id}",
             "amount":${amount},
             "currency":"${currency}",
             "merchant_id":"${merchant_id}",
             "card_id":"${card_id}"}"""
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

---

## 5. k6 for Simpler Scenarios

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

  const startTime = Date.now();

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

  const latency = Date.now() - startTime;
  fraudScoreLatency.add(latency);

  const success = check(res, {
    'status is 200':          (r) => r.status === 200,
    'has fraud_score field':   (r) => JSON.parse(r.body).fraud_score !== undefined,
    'fraud_score in [0,1]':   (r) => {
      const score = JSON.parse(r.body).fraud_score;
      return score >= 0 && score <= 1;
    },
    'latency < 50ms':          () => latency < 50,
  });

  errorRate.add(!success);
  sleep(0.1);  // 10 TPS per VU
}
```

---

## 6. CI Pipeline Integration for Performance Regression

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
    reports:
      junit: results/gatling/*/simulation.log
    paths:
      - results/gatling/
    expire_in: 30 days
```

```python
# ci/assert_gatling_results.py
import json, sys, argparse

def assert_results(results_dir, p99_ms, success_rate, throughput):
    with open(f"{results_dir}/stats.json") as f:
        stats = json.load(f)

    global_stats = stats["stats"]["global"]

    actual_p99         = global_stats["percentiles4"]["value"]   # p99
    actual_success     = global_stats["successfulRequests"]["percent"]
    actual_throughput  = global_stats["meanNumberOfRequestsPerSecond"]["value"]

    failures = []
    if actual_p99 > p99_ms:
        failures.append(f"p99 {actual_p99}ms > threshold {p99_ms}ms")
    if actual_success < success_rate:
        failures.append(f"Success rate {actual_success}% < threshold {success_rate}%")
    if actual_throughput < throughput:
        failures.append(f"Throughput {actual_throughput} RPS < threshold {throughput} RPS")

    if failures:
        print("PERFORMANCE TEST FAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    else:
        print(f"Performance test PASSED: p99={actual_p99}ms, "
              f"success={actual_success}%, throughput={actual_throughput}RPS")
```

---

## 7. SLO Validation Strategy

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

---

## 8. Identifying Memory Leaks from Soak Tests

```java
// Analysis tool for soak test results
@Component
public class SoakTestResultAnalyser {

    // Detect linear memory growth (indicates leak) vs stable oscillation (normal GC)
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

---

## Summary

Reliability testing is not optional for fintech systems. Load tests validate SLOs at expected throughput. Soak tests expose memory leaks and connection pool exhaustion that only appear after hours of operation. Spike tests verify that the system handles sudden 10x traffic increases without catastrophic failure. Integrating performance tests into CI pipelines creates a regression safety net: a change that degrades p99 latency by 2x is caught before it reaches production. The test design must start from production traffic patterns — testing at unrealistic load profiles produces useless results.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which test type is best suited to discovering a memory leak in a payment service that only manifests after several hours of operation?",
      "options": ["Load test (30-60 minutes at expected load)", "Smoke test (5 minutes at low load)", "Soak test (8+ hours at sustained load)", "Spike test (10x traffic for 5 minutes)"],
      "correct": 2,
      "explanation": "Memory leaks accumulate slowly — they are invisible in short-duration tests. A soak test running at sustained load for 8+ hours reveals gradual heap growth that GC cannot reclaim. The pattern to look for is linear memory growth rather than the GC sawtooth pattern of normal healthy memory usage."
    },
    {
      "text": "A spike test for a payment API uses a check for status.in(200, 201, 429). Why is 429 included as an acceptable status?",
      "options": ["429 means the payment was queued for later processing", "Rate limiting (429) is acceptable behavior during a spike — it shows the service is protecting downstream systems rather than failing", "429 is returned when fraud checks are deferred", "Gatling cannot distinguish 429 from 200"],
      "correct": 1,
      "explanation": "During a 10x traffic spike, it is acceptable and desirable for the payment service to rate-limit some requests (429) rather than allowing the full spike to cascade to downstream systems. Returning 429 with Retry-After means clients can retry later, while the system protects the payment processor, database, and other dependencies."
    },
    {
      "text": "What is the correct approach for designing a performance test load profile?",
      "options": ["Use 100 virtual users as a standard baseline for all services", "Design the load profile from production traffic metrics — actual TPS, peak patterns, and burst ratios", "Use the maximum theoretically possible load to find the breaking point", "Start with 10 TPS and double every 10 minutes"],
      "correct": 1,
      "explanation": "Testing at unrealistic load profiles produces meaningless results. Load tests designed from production metrics — average TPS, p95 TPS, peak hours, known spike triggers like month-end payroll — produce actionable results that validate real-world SLOs. A test at 10x higher than peak just exercises the wrong failure modes."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Comprehensive Reliability Test Suite for Payment Authorisation API",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Write a Gatling load simulation for the payment authorisation API: ramp from 1 to 100 TPS over 5 minutes, sustain for 20 minutes, then ramp down. Assert that p99 <= 500ms, p95 <= 200ms, success rate >= 99.9%, and throughput >= 450 RPS. Fail the build if any assertion fails."},
    {"id": "2", "description": "Write a Gatling soak simulation: run at 50 TPS for 8 hours using circular feeder. Implement a SoakTestMemoryMonitor that detects linear heap growth by computing linear regression slope, flags growth > 1%/hour as a likely leak, and publishes JVM heap utilisation to Prometheus."},
    {"id": "3", "description": "Write a Gatling spike simulation: baseline 50 TPS for 2 minutes, spike to 500 TPS (10x) for 5 minutes, then recover. Assert that the global success rate is >= 95% (429s are acceptable), and that p99 during the spike does not exceed 5000ms. Document what circuit breaker behavior you expect to see."},
    {"id": "4", "description": "Create a CI pipeline step that: runs the smoke test on every merge to main, runs the full load test on release branches, parses Gatling stats.json to extract p99/success-rate/throughput, and exits with code 1 if any SLO threshold is violated. Include a Python assertion script."}
  ]
}
-->

