---
id: track-09-lesson-16
title: "Gatling Load Testing — Realistic Financial Scenarios"
slug: gatling-load-testing
track: track-09
trackName: "Performance Engineering"
sequence: 16
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Gatling, load-testing, simulation, percentiles, throughput]
prerequisites: []
---

# Gatling Load Testing — Realistic Financial Scenarios

> [!NOTE]
> Load testing payment systems is fundamentally different from testing web applications. Financial load tests must model realistic transaction patterns (ramp-up, steady state, end-of-month spikes), use real-world data distributions (small transactions are more common than large ones), test idempotency behaviour, and validate that p99 latency stays below SLA thresholds under sustained load — not just under artificial uniform traffic.

## Why Gatling for Financial Systems

Gatling offers three advantages over alternatives (JMeter, k6, Locust) for payment system load testing:

1. **Scala/Java DSL** — simulations are code, version-controlled alongside the service
2. **High efficiency** — Gatling's Akka/Netty engine handles 50,000+ concurrent virtual users on a single machine
3. **Statistical reports** — built-in percentile analysis (p50, p75, p95, p99) critical for SLA validation

---

## Project Setup

```xml
<!-- pom.xml -->
<plugin>
    <groupId>io.gatling</groupId>
    <artifactId>gatling-maven-plugin</artifactId>
    <version>4.9.0</version>
    <configuration>
        <simulationClass>com.fintech.simulations.PaymentApiSimulation</simulationClass>
    </configuration>
</plugin>

<dependency>
    <groupId>io.gatling.highcharts</groupId>
    <artifactId>gatling-charts-highcharts</artifactId>
    <version>3.11.0</version>
    <scope>test</scope>
</dependency>
```

---

## Feeder Configuration — Realistic Payment Data

Feeders supply test data to virtual users. Financial load tests require realistic data distributions:

```java
// src/test/java/com/fintech/simulations/PaymentDataFeeders.java
public class PaymentDataFeeders {

    /**
     * CSV feeder for pre-generated payment data.
     * src/test/resources/data/payments.csv:
     *
     * account_id,merchant_id,amount_minor_units,currency_code,category
     * ACC-10001,MERCH-5001,1250,USD,GROCERY
     * ACC-10002,MERCH-5042,89900,USD,ELECTRONICS
     */
    public static FeederBuilder.Batchable<String> csvPaymentFeeder() {
        return csv("data/payments.csv").circular();
    }

    /**
     * Programmatic feeder for dynamic payment generation.
     * Models realistic transaction size distribution:
     *   60% small (<$50):       grocery, coffee, transit
     *   25% medium ($50-$500):  dining, clothing
     *   12% large ($500-$5000): electronics, travel
     *    3% very large (>$5000): wire transfers, B2B
     */
    public static Iterator<Map<String, Object>> dynamicPaymentFeeder() {
        Random rng      = new Random();
        String[] accts  = generateIds("ACC-", 10_000, 10_000);
        String[] merch  = generateIds("MERCH-", 500, 5_000);
        String[] ccodes = {"USD", "USD", "USD", "EUR", "GBP", "CAD"};  // USD-weighted

        return Stream.generate(() -> Map.<String, Object>of(
            "idempotencyKey",   UUID.randomUUID().toString(),
            "fromAccount",      accts[rng.nextInt(accts.length)],
            "toAccount",        merch[rng.nextInt(merch.length)],
            "amountMinorUnits", sampleAmount(rng),
            "currencyCode",     ccodes[rng.nextInt(ccodes.length)],
            "reference",        "REF-" + System.nanoTime()
        )).iterator();
    }

    private static long sampleAmount(Random rng) {
        double p = rng.nextDouble();
        if (p < 0.60) return rng.nextInt(5000) + 50;        // $0.50–$50
        if (p < 0.85) return rng.nextInt(45000) + 5000;     // $50–$500
        if (p < 0.97) return rng.nextInt(450000) + 50000;   // $500–$5000
        return rng.nextInt(4_500_000) + 500_000;             // $5000–$50000
    }

    private static String[] generateIds(String prefix, int count, int offset) {
        String[] ids = new String[count];
        for (int i = 0; i < count; i++) ids[i] = prefix + (offset + i);
        return ids;
    }
}
```

---

## Core Simulation — Payment Authorization

```java
// src/test/java/com/fintech/simulations/PaymentApiSimulation.java
public class PaymentApiSimulation extends Simulation {

    // ── Protocol ──────────────────────────────────────────────────────────

    private final HttpProtocolBuilder httpProtocol = http
        .baseUrl(System.getProperty("target.url", "http://localhost:8080"))
        .acceptHeader("application/json")
        .contentTypeHeader("application/json")
        .header("Authorization", "Bearer " + System.getProperty("api.token", "test-token"))
        .header("X-Client-Id", "gatling-load-test")
        .enableHttp2()
        .shareConnections()
        .connectionHeader("keep-alive");

    // ── Feeders ───────────────────────────────────────────────────────────

    private final Iterator<Map<String, Object>> paymentFeeder =
        PaymentDataFeeders.dynamicPaymentFeeder();

    private final Iterator<Map<String, Object>> accountFeeder =
        Stream.generate(() -> Map.<String, Object>of(
            "accountId", "ACC-" + (10000 + new Random().nextInt(10000))
        )).iterator();

    // ── Scenarios ─────────────────────────────────────────────────────────

    /**
     * Scenario 1: Payment Authorization — 70% of traffic
     */
    private final ScenarioBuilder authorizePaymentScenario =
        scenario("Payment Authorization")
            .feed(paymentFeeder)
            .exec(
                http("Authorize Payment")
                    .post("/v1/payments/authorize")
                    .body(StringBody(
                        """
                        {
                          "idempotencyKey": "#{idempotencyKey}",
                          "fromAccount": "#{fromAccount}",
                          "toAccount": "#{toAccount}",
                          "amountMinorUnits": #{amountMinorUnits},
                          "currencyCode": "#{currencyCode}",
                          "reference": "#{reference}"
                        }
                        """))
                    .check(status().is(200))
                    .check(jsonPath("$.authorizationCode").exists())
                    .check(jsonPath("$.status").in("AUTHORIZED", "DECLINED"))
                    .check(responseTimeInMillis().lte(500))
            )
            .pause(Duration.ofMillis(50), Duration.ofMillis(200));

    /**
     * Scenario 2: Account Balance Check — 20% of traffic
     */
    private final ScenarioBuilder checkBalanceScenario =
        scenario("Balance Check")
            .feed(accountFeeder)
            .exec(
                http("Get Balance")
                    .get("/v1/accounts/#{accountId}/balance")
                    .check(status().is(200))
                    .check(jsonPath("$.availableBalance").exists())
            )
            .pause(Duration.ofMillis(100), Duration.ofMillis(500));

    /**
     * Scenario 3: Transaction History — 10% of traffic
     */
    private final ScenarioBuilder transactionHistoryScenario =
        scenario("Transaction History")
            .feed(accountFeeder)
            .exec(
                http("Get Transactions")
                    .get("/v1/accounts/#{accountId}/transactions")
                    .queryParam("limit", "20")
                    .check(status().is(200))
                    .check(jsonPath("$.transactions").exists())
            )
            .pause(Duration.ofSeconds(1), Duration.ofSeconds(3));

    // ── Assertions ────────────────────────────────────────────────────────

    {
        setUp(
            authorizePaymentScenario.injectOpen(
                rampUsersPerSec(1).to(210).during(Duration.ofMinutes(5)),
                constantUsersPerSec(210).during(Duration.ofMinutes(15)),
                rampUsersPerSec(210).to(1).during(Duration.ofMinutes(2))
            ),
            checkBalanceScenario.injectOpen(
                rampUsersPerSec(1).to(60).during(Duration.ofMinutes(5)),
                constantUsersPerSec(60).during(Duration.ofMinutes(15))
            ),
            transactionHistoryScenario.injectOpen(
                rampUsersPerSec(1).to(30).during(Duration.ofMinutes(5)),
                constantUsersPerSec(30).during(Duration.ofMinutes(15))
            )
        )
        .protocols(httpProtocol)
        .assertions(
            global().successfulRequests().percent().gte(99.9),
            global().responseTime().percentile(99).lte(500),
            global().responseTime().percentile(95).lte(300),
            global().responseTime().mean().lte(150),
            global().requestsPerSec().gte(300.0),
            details("Authorize Payment").responseTime().percentile(99).lte(400),
            details("Authorize Payment").successfulRequests().percent().gte(99.9)
        );
    }
}
```

---

## Realistic Load Profiles

```java
/**
 * Load profile patterns for financial services.
 * Financial traffic is never uniform — model real patterns.
 */
public class LoadProfiles {

    /**
     * PROFILE 1: Normal Business Hours
     * Gradual ramp, sustained steady state, graceful ramp-down.
     */
    public static OpenInjectionStep[] normalBusinessHours(int targetRps) {
        return new OpenInjectionStep[]{
            rampUsersPerSec(1).to(targetRps).during(Duration.ofMinutes(5)),
            constantUsersPerSec(targetRps).during(Duration.ofMinutes(20)),
            rampUsersPerSec(targetRps).to(1).during(Duration.ofMinutes(5))
        };
    }

    /**
     * PROFILE 2: End-of-Month Salary Spike
     * Volumes spike 5x as salary payments and bill pay concentrate.
     * Common on the 1st of each month in retail banking.
     */
    public static OpenInjectionStep[] endOfMonthSpike(int baseRps) {
        int peakRps = baseRps * 5;
        return new OpenInjectionStep[]{
            constantUsersPerSec(baseRps).during(Duration.ofMinutes(5)),
            rampUsersPerSec(baseRps).to(peakRps).during(Duration.ofMinutes(3)),
            constantUsersPerSec(peakRps).during(Duration.ofMinutes(10)),
            rampUsersPerSec(peakRps).to(baseRps).during(Duration.ofMinutes(5))
        };
    }

    /**
     * PROFILE 3: Black Friday / Cyber Monday
     * Sustained high load with brief extreme spikes.
     * E-commerce payment processors face this 1-2x per year.
     */
    public static OpenInjectionStep[] highLoadWithSpikes(int baseRps) {
        int spikeRps = baseRps * 3;
        return new OpenInjectionStep[]{
            rampUsersPerSec(1).to(baseRps).during(Duration.ofMinutes(3)),
            constantUsersPerSec(baseRps).during(Duration.ofMinutes(5)),
            // Spike 1
            rampUsersPerSec(baseRps).to(spikeRps).during(Duration.ofMinutes(1)),
            constantUsersPerSec(spikeRps).during(Duration.ofMinutes(3)),
            rampUsersPerSec(spikeRps).to(baseRps).during(Duration.ofMinutes(1)),
            // Recovery
            constantUsersPerSec(baseRps).during(Duration.ofMinutes(5)),
            // Spike 2
            rampUsersPerSec(baseRps).to(spikeRps).during(Duration.ofMinutes(1)),
            constantUsersPerSec(spikeRps).during(Duration.ofMinutes(3)),
            rampUsersPerSec(spikeRps).to(baseRps).during(Duration.ofMinutes(2))
        };
    }
}
```

---

## Idempotency Testing Under Load

```java
/**
 * Financial systems must handle duplicate requests correctly.
 * This simulation validates idempotency under concurrent load.
 */
public class IdempotencySimulation extends Simulation {

    private final HttpProtocolBuilder httpProtocol = http
        .baseUrl(System.getProperty("target.url", "http://localhost:8080"))
        .contentTypeHeader("application/json");

    /**
     * Idempotency scenario:
     * 1. Submit payment with idempotency key → store authorization code
     * 2. Wait 50ms (simulates timeout + retry)
     * 3. Resubmit identical payment
     * 4. Assert both responses have identical authorization code
     */
    private final ScenarioBuilder idempotencyScenario = scenario("Idempotency Check")
        .exec(session -> session
            .set("idempotencyKey", UUID.randomUUID().toString())
            .set("amount", 2500))
        .exec(
            http("First Submission")
                .post("/v1/payments/authorize")
                .body(StringBody(
                    """
                    {
                      "idempotencyKey": "#{idempotencyKey}",
                      "fromAccount": "ACC-10001",
                      "toAccount": "MERCH-5001",
                      "amountMinorUnits": #{amount},
                      "currencyCode": "USD",
                      "reference": "IDEM-TEST"
                    }
                    """))
                .check(status().in(200, 201))
                .check(jsonPath("$.authorizationCode").saveAs("firstAuthCode"))
                .check(jsonPath("$.status").saveAs("firstStatus"))
        )
        .pause(Duration.ofMillis(50))
        .exec(
            http("Duplicate Submission (Retry)")
                .post("/v1/payments/authorize")
                .body(StringBody(
                    """
                    {
                      "idempotencyKey": "#{idempotencyKey}",
                      "fromAccount": "ACC-10001",
                      "toAccount": "MERCH-5001",
                      "amountMinorUnits": #{amount},
                      "currencyCode": "USD",
                      "reference": "IDEM-TEST"
                    }
                    """))
                .check(status().in(200, 201))
                .check(jsonPath("$.authorizationCode").is("#{firstAuthCode}"))
                .check(jsonPath("$.status").is("#{firstStatus}"))
        );

    {
        setUp(
            idempotencyScenario.injectOpen(
                rampUsers(1000).during(Duration.ofMinutes(2)),
                constantUsersPerSec(50).during(Duration.ofMinutes(5))
            )
        )
        .protocols(httpProtocol)
        .assertions(
            details("Duplicate Submission (Retry)").successfulRequests().percent().is(100.0),
            global().responseTime().percentile(99).lte(300)
        );
    }
}
```

---

## Stress Test — Finding the Breaking Point

```java
public class PaymentStressTestSimulation extends Simulation {

    private final HttpProtocolBuilder httpProtocol = http
        .baseUrl(System.getProperty("target.url", "http://localhost:8080"))
        .contentTypeHeader("application/json");

    private final Iterator<Map<String, Object>> feeder =
        PaymentDataFeeders.dynamicPaymentFeeder();

    private final ScenarioBuilder stressScenario = scenario("Stress Authorization")
        .feed(feeder)
        .exec(
            http("Authorize")
                .post("/v1/payments/authorize")
                .body(StringBody(
                    """
                    {
                      "idempotencyKey": "#{idempotencyKey}",
                      "fromAccount": "#{fromAccount}",
                      "toAccount": "#{toAccount}",
                      "amountMinorUnits": #{amountMinorUnits},
                      "currencyCode": "#{currencyCode}",
                      "reference": "#{reference}"
                    }
                    """))
                .check(status().in(200, 503))  // accept 503 during stress
        );

    /**
     * Staircase stress: add 100 req/s every 2 minutes.
     * Breaking point typically shows as: p99 > 2s AND error rate > 5%.
     *
     * Typical results:
     *   100-300 req/s:  p99 < 100ms, errors 0%     (healthy)
     *   300-500 req/s:  p99 < 200ms, errors < 0.1% (nominal)
     *   500-700 req/s:  p99 < 500ms, errors < 1%   (stressed)
     *   700+ req/s:     p99 > 2000ms, errors > 5%  (breaking point)
     */
    {
        setUp(
            stressScenario.injectOpen(
                incrementUsersPerSec(100)
                    .times(10)
                    .eachLevelLasting(Duration.ofMinutes(2))
                    .separatedByRampsLasting(Duration.ofSeconds(30))
                    .startingFrom(100)
            )
        )
        .protocols(httpProtocol)
        .maxDuration(Duration.ofMinutes(35))
        .assertions(
            global().responseTime().percentile(99).lte(2000),
            global().successfulRequests().percent().gte(95.0)
        );
    }
}
```

---

## CI Integration

```yaml
# .github/workflows/performance.yml
name: Performance Regression Tests

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'   # nightly 2am

jobs:
  gatling-load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'

      - name: Start services
        run: docker compose -f docker/compose.yml up -d

      - name: Wait for health
        run: |
          timeout 60 bash -c \
            'until curl -sf http://localhost:8080/actuator/health; do sleep 2; done'

      - name: Run Gatling simulation
        run: |
          mvn gatling:test \
            -Dgatling.simulationClass=com.fintech.simulations.PaymentApiSimulation \
            -Dtarget.url=http://localhost:8080 \
            -Dapi.token=${{ secrets.LOAD_TEST_TOKEN }}

      - name: Upload Gatling report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: gatling-report-${{ github.sha }}
          path: target/gatling/

      - name: Detect performance regression
        run: |
          # Gatling exits with code 2 if assertions fail
          # Maven build already fails — this step adds human-readable output
          STATS=$(find target/gatling -name stats.json | head -1)
          P99=$(python3 -c "
          import json, sys
          data = json.load(open('$STATS'))
          print(int(data['stats']['global']['percentiles99']['total']))
          ")
          echo "Payment authorization p99: ${P99}ms"
          [ "$P99" -le 500 ] || (echo "REGRESSION: p99 ${P99}ms > 500ms"; exit 1)
```

---

## Gatling Report Analysis Guide

```
Sample Gatling Report — Payment Authorization Service
Target: http://payments.internal:8080
Duration: 22m 0s

GLOBAL STATISTICS
─────────────────────────────────────────────────────────────────
Request            OK%    p50   p75   p95   p99    mean   max
─────────────────────────────────────────────────────────────────
All Requests      99.95%  85ms 120ms 220ms 380ms   95ms 2140ms
Authorize Payment 99.93%  88ms 125ms 235ms 395ms   98ms 2140ms
Balance Check     99.98%  12ms  18ms  35ms  78ms   14ms  312ms
Transaction Hist  99.97%  45ms  67ms 120ms 189ms   52ms  891ms

ASSERTIONS RESULT
─────────────────────────────────────────────────────────────────
✓  Global success rate >= 99.9%        actual: 99.95%
✓  Global p99 <= 500ms                 actual: 380ms
✓  Global p95 <= 300ms                 actual: 220ms
✓  Global mean <= 150ms                actual: 95ms
✓  Authorize success >= 99.9%          actual: 99.93%
⚠  Authorize p99 <= 400ms              actual: 395ms  ← CLOSE TO LIMIT

Action: Investigate the 395ms p99 — only 5ms headroom before SLA breach.
  → Check if specific accounts (hotspots) cause delays
  → Correlate timestamp with GC logs (stop-the-world GC pause?)
  → Check downstream fraud service p99 during the same window
  → Review thread pool queue depth time series
```

---

## Performance Regression Detection

```java
@Service
public class PerformanceRegressionDetector {

    private final GatlingResultRepository repository;
    private final SlackNotifier           notifier;

    /**
     * Compare current run against stored baseline.
     * Regressions: p99 +20%, throughput -10%, error rate +0.1%
     */
    public RegressionReport compareWithBaseline(
            GatlingResult current, String commitSha) {

        GatlingResult baseline = repository.getBaseline("payment-auth");
        List<String> regressions = new ArrayList<>();

        double p99Delta = (double)(current.getP99Millis() - baseline.getP99Millis())
            / baseline.getP99Millis();
        if (p99Delta > 0.20) {
            regressions.add(String.format("p99 regression: %dms → %dms (+%.0f%%)",
                baseline.getP99Millis(), current.getP99Millis(), p99Delta * 100));
        }

        double throughputDelta = (current.getThroughputRps() - baseline.getThroughputRps())
            / baseline.getThroughputRps();
        if (throughputDelta < -0.10) {
            regressions.add(String.format("Throughput regression: %.1f → %.1f req/s (%.0f%%)",
                baseline.getThroughputRps(), current.getThroughputRps(), throughputDelta * 100));
        }

        double errorRateDelta = current.getErrorRate() - baseline.getErrorRate();
        if (errorRateDelta > 0.001) {
            regressions.add(String.format("Error rate regression: %.3f%% → %.3f%%",
                baseline.getErrorRate() * 100, current.getErrorRate() * 100));
        }

        if (!regressions.isEmpty()) {
            notifier.sendAlert("Payment Service Performance Regression",
                "Commit: " + commitSha + "\n" + String.join("\n", regressions));
        }

        return new RegressionReport(regressions, commitSha);
    }
}
```

---

## Key Takeaways for Financial Load Testing

1. **Model realistic traffic patterns** — payment volumes spike at end of month, paydays, and during promotions. Test these patterns explicitly with ramp-up and spike scenarios
2. **Use realistic data distributions** — 60% of transactions are small (<$50); uniform distribution misrepresents real fraud scoring and limit checking behaviour
3. **Validate idempotency under load** — retries are common in payment systems; verify that duplicate submissions return identical results even under concurrent load
4. **Assert on percentiles, not averages** — p99 is what your worst-off customers experience; mean latency can look fine while 1% of payments take 10 seconds
5. **Keep assertions strict** — `successfulRequests >= 99.9%` is not optional for payments; even 0.1% errors means 1,000 failed payments per million
6. **Run nightly in CI** — catch performance regressions before they reach production; a 20% p99 increase is much easier to debug in one commit than after weeks of changes
7. **Separate stress tests from SLA tests** — stress tests find breaking points; SLA simulations validate normal operation. Mixing them produces misleading reports

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why should Gatling load tests use realistic data distributions rather than uniform random data?",
      "options": [
        "Uniform data causes Gatling to produce incorrect throughput statistics",
        "Real payment volumes follow power-law distributions; uniform data bypasses caches and fraud thresholds differently, producing misleading performance metrics that don't reflect production behavior",
        "Database indexes perform identically for all data distributions so it doesn't matter",
        "Gatling scenarios can only generate data from pre-loaded CSV files, not random data"
      ],
      "correct": 1,
      "explanation": "Payment workloads have skewed distributions: ~60% of transactions are small amounts, most activity concentrates on a small fraction of accounts. Uniform random data would produce cache miss rates, fraud scoring distributions, and limit check patterns that don't match production. Realistic distributions expose hot-path optimizations and cache effectiveness accurately."
    },
    {
      "text": "What is the difference between a stress test and an SLA validation test in Gatling, and why should they not be mixed?",
      "options": [
        "Stress tests use different HTTP verbs; SLA tests only use GET requests",
        "Stress tests ramp load until the system breaks to find the capacity ceiling; SLA tests simulate expected production load to verify SLO compliance. Mixing them obscures whether normal load is handled correctly",
        "Stress tests use virtual users; SLA tests use real browser sessions",
        "They are identical; the distinction is only in the report naming"
      ],
      "correct": 1,
      "explanation": "A stress test that pushes to 300% of expected load can mask whether the service meets its 99.9% success rate SLO at 100% load. If a report mixes both phases, the aggregate P99 and error rate reflect the stress period, not the production-representative period. Run them as separate simulations with separate baseline comparisons."
    },
    {
      "text": "Why should Gatling payment scenarios assert on P99 latency rather than average latency?",
      "options": [
        "Gatling only supports P99 assertions; average assertions require a custom plugin",
        "Average latency can look healthy while 1% of customers experience 10-second timeouts; P99 reflects the worst-case experience for 1 in 100 customers, which directly corresponds to payment SLA breach rates",
        "P99 is easier to calculate than average in distributed systems",
        "Average latency is unreliable for financial systems because BigDecimal operations are excluded"
      ],
      "correct": 1,
      "explanation": "Mean latency is heavily influenced by the majority of fast requests. A service with average 50ms latency could have P99 of 10 seconds if 1% of requests are very slow. For a payment processor handling 1 million transactions/day, P99 = 10s means 10,000 customers per day experiencing timeouts. Asserting on P99 (and P99.9) in Gatling catches these tails before production."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Gatling Load Test Suite for Payment Authorization Service",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "Write a Gatling simulation in Scala or Java that models a realistic payment authorization scenario: 60% small amounts (<$50), 30% medium ($50-$500), 10% large (>$500), with ramp-up from 0 to 500 req/s over 2 minutes, hold for 5 minutes, then spike to 1500 req/s for 30 seconds."},
    {"id": "2", "description": "Add assertions that fail the simulation if: success rate drops below 99.9%, P99 latency exceeds 500ms, or any request takes longer than 5 seconds."},
    {"id": "3", "description": "Implement idempotency validation in the scenario by sending duplicate payment submissions and asserting that the response is identical to the original (same response body, same transaction ID)."},
    {"id": "4", "description": "Write a CI integration class that compares the latest Gatling results against a stored baseline, raising an alert if P99 latency increased by more than 20%, throughput decreased by more than 10%, or error rate increased by more than 0.1%."}
  ]
}
-->

