---
id: track-07-lesson-16
title: "اختبار الحمل بـ Gatling — سيناريوهات مالية واقعية"
slug: gatling-load-testing
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 16
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Gatling, load-testing, simulation, percentiles, throughput]
prerequisites: []
---

# اختبار الحمل بـ Gatling — سيناريوهات مالية واقعية

> [!NOTE]
> اختبار حمل أنظمة الدفع مختلف جوهريًا عن اختبار تطبيقات الويب. فيجب أن تحاكي اختبارات الحمل المالية أنماط معاملات واقعية (الصعود التدريجي، والحالة المستقرة، وقفزات نهاية الشهر)، وتستخدم توزيعات بيانات من العالم الحقيقي (المعاملات الصغيرة أكثر شيوعًا من الكبيرة)، وتختبر سلوك الـ idempotency، وتتحقق من بقاء زمن p99 تحت عتبات الـ SLA تحت حمل مستمر — لا تحت حركة اصطناعية منتظمة فقط.

## لماذا Gatling للأنظمة المالية

يقدم Gatling ثلاث مزايا على البدائل (JMeter، وk6، وLocust) لاختبار حمل أنظمة الدفع:

1. **لغة شيفرة مخصصة (Java، وKotlin، وScala؛ وJavaScript/TypeScript في الإصدارات الحديثة)** — المحاكاة شيفرة، تُدار نسخها بجانب الخدمة
2. **كفاءة عالية** — محرك Gatling غير الحاجب المبني على Netty يستطيع تشغيل عشرات الآلاف من المستخدمين الافتراضيين المتزامنين من جهاز واحد
3. **تقارير إحصائية** — تحليل مئينات مدمج (p50، وp75، وp95، وp99) حاسم للتحقق من الـ SLA

## إعداد المشروع

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

## إعداد المغذيات (Feeders) — بيانات دفع واقعية

تزود المغذيات المستخدمين الافتراضيين ببيانات الاختبار. وتتطلب اختبارات الحمل المالية توزيعات بيانات واقعية:

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

## المحاكاة الأساسية — تفويض الدفع

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
        .shareConnections()
        // .enableHttp2() works only over TLS (https://, negotiated with ALPN) --
        // Gatling has no cleartext HTTP/2 (h2c). And never send a
        // "Connection: keep-alive" header over HTTP/2: connection-specific
        // headers are forbidden there and servers may reject the request.
        ;

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
                    // A DECLINED response has no authorization code -- so only
                    // check the status here, or declines would count as errors
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
            // Mean over the WHOLE run, ramps included: 300 req/s only at
            // steady state, so the run average is about 249 req/s
            global().requestsPerSec().gte(240.0),
            details("Authorize Payment").responseTime().percentile(99).lte(400),
            details("Authorize Payment").successfulRequests().percent().gte(99.9)
        );
    }
}
```

## ملفات حمل واقعية

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
     * Volumes spike (here 5x) as salary payments and bill pay concentrate.
     * Common around month-end and the 1st in retail banking -- use your
     * own production peak ratio, not this example's.
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

## اختبار الـ Idempotency تحت الحمل

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
     *
     * Use a test account with a very large balance: thousands of users all
     * debit ACC-10001, and declines (no auth code) would break the checks.
     * Also test the HARDER case separately: both submissions in flight at
     * the same time (no pause), where only a database UNIQUE constraint or
     * lock prevents a double payment.
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
                // Java DSL: is("...") compares with the LITERAL text;
                // isEL("#{...}") resolves Gatling Expression Language
                .check(jsonPath("$.authorizationCode").isEL("#{firstAuthCode}"))
                .check(jsonPath("$.status").isEL("#{firstStatus}"))
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

## اختبار الإجهاد — إيجاد نقطة الانكسار

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
                .check(status().in(200, 503))  // accept 503 during stress (note: 503s then
                                               // count as "successful" in the report)
        );

    /**
     * Staircase stress: add 100 req/s every 2 minutes.
     * Breaking point typically shows as: p99 > 2s AND error rate > 5%.
     *
     * Illustrative results:
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
        // These assertions fail the run only if the service breaks BELOW the
        // capacity you expect -- finding the ceiling is the goal, not passing
        .assertions(
            global().responseTime().percentile(99).lte(2000),
            global().successfulRequests().percent().gte(95.0)
        );
    }
}
```

## التكامل مع CI

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
          # (Shared GitHub runners are noisy: treat absolute numbers with care,
          #  or run the load test on dedicated hardware)
          STATS=$(find target/gatling -path '*/js/stats.json' | head -1)
          # stats.json has percentiles1..4 = p50, p75, p95, p99 by default
          P99=$(python3 -c "
          import json, sys
          data = json.load(open('$STATS'))
          print(int(data['stats']['percentiles4']['total']))
          ")
          echo "Global p99: ${P99}ms"
          [ "$P99" -le 500 ] || (echo "REGRESSION: p99 ${P99}ms > 500ms"; exit 1)
```

## دليل تحليل تقرير Gatling

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

## كشف تراجع الأداء

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

## الخلاصات الأساسية لاختبار الحمل المالي

1. **حاكِ أنماط حركة واقعية** — تقفز أحجام المدفوعات في نهاية الشهر، وأيام الرواتب، وأثناء العروض الترويجية. فاختبر هذه الأنماط صراحة بسيناريوهات صعود وقفزات
2. **استخدم توزيعات بيانات واقعية** — 60% من المعاملات صغيرة (< 50 دولارًا)؛ والتوزيع المنتظم يشوّه سلوك تقييم الاحتيال وفحص الحدود الحقيقي
3. **تحقق من الـ idempotency تحت الحمل** — إعادات المحاولة شائعة في أنظمة الدفع؛ فتحقق من أن التقديمات المكررة تعيد نتائج متطابقة حتى تحت حمل متزامن
4. **أكّد على المئينات، لا المتوسطات** — p99 وp99.9 يصفان الذيل البطيء الذي يصيبه كثير من العملاء فعلًا؛ وقد يبدو الزمن المتوسط جيدًا بينما تستغرق 1% من المدفوعات 10 ثوانٍ
5. **أبقِ التأكيدات صارمة** — ‏`successfulRequests >= 99.9%` ليس اختياريًا للمدفوعات؛ فحتى 0.1% أخطاء تعني 1,000 دفعة فاشلة لكل مليون
6. **شغّلها ليليًا في CI** — التقط تراجعات الأداء قبل وصولها إلى الإنتاج؛ فزيادة 20% في p99 أسهل كثيرًا في التصحيح في التزام واحد منها بعد أسابيع من التغييرات
7. **افصل اختبارات الإجهاد عن اختبارات الـ SLA** — اختبارات الإجهاد تجد نقاط الانكسار؛ ومحاكاة الـ SLA تتحقق من التشغيل الطبيعي. وخلطهما ينتج تقارير مضللة

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا يجب أن تستخدم اختبارات حمل Gatling توزيعات بيانات واقعية بدل بيانات عشوائية منتظمة؟",
      "options": [
        "البيانات المنتظمة تجعل Gatling ينتج إحصاءات إنتاجية خاطئة",
        "أحجام المدفوعات الحقيقية تتبع توزيعات قانون القوة؛ والبيانات المنتظمة تتعامل مع الذاكرات المخبئية وعتبات الاحتيال بشكل مختلف، فتنتج مقاييس أداء مضللة لا تعكس سلوك الإنتاج",
        "فهارس قاعدة البيانات تؤدي بشكل متطابق مع كل توزيعات البيانات فلا يهم الأمر",
        "سيناريوهات Gatling لا تستطيع توليد البيانات إلا من ملفات CSV محمّلة مسبقًا، لا بيانات عشوائية"
      ],
      "correct": 1,
      "explanation": "لأحمال الدفع توزيعات منحرفة: نحو 60% من المعاملات مبالغ صغيرة، ويتركز معظم النشاط في جزء صغير من الحسابات. والبيانات العشوائية المنتظمة ستنتج نسب إخفاق في الذاكرة المخبئية، وتوزيعات تقييم احتيال، وأنماط فحص حدود لا تطابق الإنتاج. والتوزيعات الواقعية تكشف تحسينات المسار الساخن وفعالية الذاكرة المخبئية بدقة."
    },
    {
      "text": "ما الفرق بين اختبار الإجهاد واختبار التحقق من الـ SLA في Gatling، ولماذا يجب ألا يُخلطا؟",
      "options": [
        "اختبارات الإجهاد تستخدم أفعال HTTP مختلفة؛ واختبارات الـ SLA تستخدم طلبات GET فقط",
        "اختبارات الإجهاد ترفع الحمل حتى ينكسر النظام لإيجاد سقف السعة؛ واختبارات الـ SLA تحاكي حمل الإنتاج المتوقع للتحقق من الامتثال للـ SLO. وخلطهما يحجب ما إذا كان الحمل الطبيعي يُعالج بشكل صحيح",
        "اختبارات الإجهاد تستخدم مستخدمين افتراضيين؛ واختبارات الـ SLA تستخدم جلسات متصفح حقيقية",
        "هما متطابقان؛ والتمييز في تسمية التقرير فقط"
      ],
      "correct": 1,
      "explanation": "اختبار إجهاد يدفع إلى 300% من الحمل المتوقع قد يحجب ما إذا كانت الخدمة تحقق SLO نسبة النجاح 99.9% عند 100% من الحمل. فإذا خلط تقرير بين المرحلتين، فإن P99 الإجمالي ونسبة الأخطاء يعكسان فترة الإجهاد، لا الفترة الممثلة للإنتاج. فشغّلهما كمحاكاتين منفصلتين بمقارنات خطوط أساس منفصلة."
    },
    {
      "text": "لماذا يجب أن تؤكد سيناريوهات الدفع في Gatling على زمن P99 بدل الزمن المتوسط؟",
      "options": [
        "يدعم Gatling تأكيدات P99 فقط؛ وتأكيدات المتوسط تتطلب إضافة مخصصة",
        "قد يبدو الزمن المتوسط سليمًا بينما يعاني 1% من العملاء مهلًا مدتها 10 ثوانٍ؛ وP99 يعكس أسوأ تجربة لعميل من كل 100، وهو ما يقابل مباشرة معدلات خرق SLA الدفع",
        "P99 أسهل في الحساب من المتوسط في الأنظمة الموزعة",
        "الزمن المتوسط غير موثوق للأنظمة المالية لأن عمليات BigDecimal مستبعدة"
      ],
      "correct": 1,
      "explanation": "يتأثر الزمن المتوسط كثيرًا بأغلبية الطلبات السريعة. فخدمة بزمن متوسط 50 مللي ثانية قد يكون P99 لها 10 ثوانٍ إذا كانت 1% من الطلبات بطيئة جدًا. ولمعالج دفع يتعامل مع مليون معاملة يوميًا، فإن P99 = 10 ثوانٍ يعني 10,000 عميل يوميًا يواجهون مهلًا. والتأكيد على P99 ‏(وP99.9) في Gatling يلتقط هذه الذيول قبل الإنتاج."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "حزمة اختبار حمل Gatling لخدمة تفويض الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "اكتب محاكاة Gatling بـ Scala أو Java تحاكي سيناريو تفويض دفع واقعيًا: 60% مبالغ صغيرة (< 50 دولارًا)، و30% متوسطة (50–500 دولار)، و10% كبيرة (> 500 دولار)، مع صعود من 0 إلى 500 طلب/ثانية خلال دقيقتين، والثبات 5 دقائق، ثم قفزة إلى 1500 طلب/ثانية لمدة 30 ثانية."},
    {"id": "2", "description": "أضف تأكيدات تُفشل المحاكاة إذا: انخفضت نسبة النجاح تحت 99.9%، أو تجاوز زمن P99 ‏500 مللي ثانية، أو استغرق أي طلب أكثر من 5 ثوانٍ."},
    {"id": "3", "description": "نفّذ تحققًا من الـ idempotency في السيناريو بإرسال تقديمات دفع مكررة والتأكيد على أن الرد مطابق للأصل (جسم الرد نفسه، ومعرّف المعاملة نفسه)."},
    {"id": "4", "description": "اكتب صنف تكامل CI يقارن أحدث نتائج Gatling بخط أساس مخزن، ويطلق تنبيهًا إذا زاد زمن P99 بأكثر من 20%، أو انخفضت الإنتاجية بأكثر من 10%، أو زادت نسبة الأخطاء بأكثر من 0.1%."}
  ]
}
-->
