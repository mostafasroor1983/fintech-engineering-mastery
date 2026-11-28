---
id: track-07-lesson-22
title: "إطار المهندس الرئيسي لقرارات الأداء"
slug: performance-decision-framework
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 22
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, performance, trade-offs, staff-engineer, bottleneck]
prerequisites: [track-07-lesson-08, track-07-lesson-09, track-07-lesson-10, track-07-lesson-11]
---

# إطار قرارات الأداء لكبير المهندسين

> [!NOTE]
> تحسين الأداء دون قياس تخمين يجعل الشيفرة معقدة وهشة. ودور كبير المهندسين ليس تنفيذ كل تحسين — بل بناء ثقافة قياس، وتحديد الاختناقات الأعلى أثرًا، ومنع التراجع. ومعظم عمل الأداء يُهدر على المشكلة الخطأ.

## 1. المبدأ الأساسي: قِس أولًا، دائمًا

القاعدة الأهم في هندسة الأداء:

**لا تحسّن ما لم تقِسه. ولا تقِس دون فرضية. ولا تُبلغ عن نتائج دون دلالة إحصائية.**

```java
// BAD: "I think HashMap is faster than LinkedHashMap here"
Map<String, BigDecimal> balances = new LinkedHashMap<>();
// ... change to HashMap because "obviously faster"
// (and silently lose the iteration order some code may rely on)

// GOOD: Measure the real access pattern first
@Benchmark
public BigDecimal linkedHashMapAggregation(BenchmarkState state) {
    Map<String, BigDecimal> m = new LinkedHashMap<>();
    for (Posting p : state.postings) {
        m.merge(p.accountId(), p.amount(), BigDecimal::add);
    }
    return m.get(state.lookupAccount);       // return a result: no dead code
}

@Benchmark
public BigDecimal hashMapAggregation(BenchmarkState state) {
    Map<String, BigDecimal> m = new HashMap<>();
    for (Posting p : state.postings) {
        m.merge(p.accountId(), p.amount(), BigDecimal::add);
    }
    return m.get(state.lookupAccount);
}
// Illustrative result: ~2% difference — not worth changing behaviour for
// (Returning a pre-built map from the state would measure nothing at all.)
```

### تسلسل القياس الهرمي

1. **مقاييس الإنتاج** (الأثمن): مستخدمون حقيقيون، وأحمال حقيقية، وعتاد حقيقي
2. **اختبارات الحمل** (البيئة التجريبية): بيئة متحكم بها، وأحجام بيانات واقعية
3. **المقاييس الدقيقة** (JMH): مسار شيفرة معزول، يزيل الضجيج المنهجي
4. **مخرجات الموصّف**: مخططات لهب المعالج، وتوصيفات التخصيص — بعد تحديد موقع الاختناق

## 2. طريقة USE — تحليل منهجي للموارد

توفر طريقة USE ‏(Brendan Gregg) نهجًا منظمًا لتحديد اختناقات الموارد.

لكل مورد في نظام الدفع لديك، افحص:
- **الاستخدام (Utilization)**: ما نسبة الوقت الذي يكون فيه المورد مشغولًا؟
- **التشبع (Saturation)**: كم من العمل مصطف بانتظار المورد؟
- **الأخطاء (Errors)**: هل توجد أحداث أخطاء للمورد؟

### قائمة فحص موارد خدمة الدفع

```
Resource: CPU
  Utilization: top/htop/Prometheus (node_cpu_seconds_total)
  Saturation: run queue longer than the CPU count (vmstat "r"; on Linux
              the load average also counts threads blocked on disk I/O)
  Errors: CPU errors (rare — ECC memory errors, thermal throttling)

Resource: Memory
  Utilization: 1 - MemAvailable / MemTotal
               (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
  Saturation: swap usage, page faults (sar -B)
  Errors: OOM killer events (/var/log/kern.log)

Resource: Disk I/O
  Utilization: iostat (util%), /proc/diskstats
  Saturation: await time > service time (disk queue backing up)
  Errors: I/O errors (dmesg)

Resource: Network
  Utilization: bytes_in + bytes_out vs NIC capacity
  Saturation: tcp retransmits, receive queue drops
  Errors: ip_errors, tcp_errors

Resource: Database Connection Pool
  Utilization: active_connections / max_connections
  Saturation: pending_acquisition_count > 0
  Errors: connection_timeout_count > 0

Resource: Thread Pool
  Utilization: active_threads / max_threads
  Saturation: queue_depth > 0
  Errors: rejected_task_count > 0
```

```java
@Component
public class UseMethodDashboard {

    // Gauges are registered ONCE with functions that read the live objects.
    // (Calling metrics.gauge(name, someDouble) every 10s would register a
    //  boxed number once and never update it.)
    public UseMethodDashboard(MeterRegistry metrics,
                              HikariDataSource dataSource,
                              @Qualifier("paymentExecutor") ThreadPoolExecutor executor) {

        // DB Connection Pool — USE
        HikariPoolMXBean pool = dataSource.getHikariPoolMXBean();
        Gauge.builder("pool.utilization", pool,
                p -> (double) p.getActiveConnections() / dataSource.getMaximumPoolSize())
            .register(metrics);
        Gauge.builder("pool.saturation", pool,           // threads waiting per pool slot
                p -> (double) p.getThreadsAwaitingConnection() / dataSource.getMaximumPoolSize())
            .register(metrics);

        // JVM Thread Pool — USE
        Gauge.builder("executor.utilization", executor,
                e -> (double) e.getActiveCount() / e.getMaximumPoolSize())
            .register(metrics);
        Gauge.builder("executor.saturation", executor,   // how full the queue is (0..1)
                e -> {
                    int used = e.getQueue().size();
                    int capacity = used + e.getQueue().remainingCapacity();
                    return capacity == 0 ? 0.0 : (double) used / capacity;
                })
            .register(metrics);
    }
}
```

## 3. إطار تحديد الاختناقات

حين تكون خدمة دفع بطيئة، اتبع شجرة القرار هذه:

```
Step 1: Is CPU utilization > 80%?
  YES -> CPU-bound bottleneck
    - Check flamegraph: what code is burning CPU?
    - Candidates: inefficient algorithms, excessive serialization,
                  GC overhead, regex compilation on hot path
    - Fix: algorithmic improvement, caching compiled patterns,
           GC tuning, reducing allocations

  NO -> Continue to Step 2

Step 2: Is DB connection pool saturation > 0 (threads waiting for connections)?
  YES -> DB bottleneck
    - Check pg_stat_activity: are queries slow or just many?
    - If queries are slow: query optimization, indexes (Track 07, Lessons 8-9)
    - If connections are exhausted: pool sizing, read replicas, caching
    - Fix: optimize queries first; grow the pool only if the database has
      headroom (lesson 7); add a read replica for read-heavy paths

  NO -> Continue to Step 3

Step 3: Is network I/O the bottleneck?
  YES -> Network bottleneck
    - Check latency to external services (Stripe, Redis, DB)
    - Check connection pool hit rate (are you creating new connections?)
    - Check TCP retransmit rate
    - Fix: connection pooling, TCP tuning, co-locate services

  NO -> Continue to Step 4

Step 4: Is there lock contention?
  YES -> Concurrency bottleneck
    - Check pg_locks for database locks
    - Check thread dumps for Java monitor contention
    - Check Redis SLOWLOG for blocking commands
    - Fix: optimistic locking, reduce lock scope, partition by entity

  NO -> Continue to Step 5

Step 5: Measure end-to-end distributed trace
  - Check which service is adding the most latency
  - Check for N+1 query patterns (many small DB calls)
  - Check for sequential calls that could be parallelized
  - Fix: depends on findings
```

```java
// Practical bottleneck detection: add spans to your payment flow
@Service
@Slf4j
public class PaymentProcessorWithTracing {

    private final Tracer tracer;

    public PaymentResult process(PaymentRequest request) {
        Span rootSpan = tracer.nextSpan().name("payment.process").start();

        try (Tracer.SpanInScope scope = tracer.withSpan(rootSpan)) {
            PaymentResult result = doProcess(request);
            rootSpan.tag("payment.amount", request.getAmount().toString());
            rootSpan.tag("payment.currency", request.getCurrency());
            return result;
        } finally {
            rootSpan.end();
        }
    }

    private PaymentResult doProcess(PaymentRequest request) {
        // Each step is traced separately
        // Jaeger/Zipkin will show which step dominates latency
        ValidatedRequest validated = spanStep("validation",
            () -> validator.validate(request));

        FraudCheckResult fraud = spanStep("fraud_check",
            () -> fraudService.check(validated));

        BalanceReserved balance = spanStep("balance_reservation",
            () -> balanceService.reserve(validated));

        TransactionRecord txn = spanStep("transaction_write",
            () -> transactionRepo.save(validated, fraud, balance));

        return spanStep("notification",
            () -> notificationService.notify(txn));
    }

    private <T> T spanStep(String name, Supplier<T> operation) {
        Span span = tracer.nextSpan().name("payment." + name).start();
        try (Tracer.SpanInScope scope = tracer.withSpan(span)) {
            return operation.get();
        } catch (Exception e) {
            span.error(e);
            throw e;
        } finally {
            span.end();
        }
    }
}
```

## 4. وضع أهداف SLO حسب فئة الدفع

تستحق أنواع الدفع المختلفة أهداف SLO مختلفة. وضع الأهداف بناءً على أثر المستخدم، لا القدرة التقنية.

```yaml
# SLO definitions for payment service tiers
slo:
  payment_authorization:    # Card authorization (customer waiting)
    p50_ms: 150
    p95_ms: 500
    p99_ms: 1000
    availability: 99.95%  # 22 minutes/month downtime budget

  balance_lookup:           # Account balance read (high frequency)
    p50_ms: 20
    p95_ms: 100
    p99_ms: 300
    availability: 99.99%  # 4.3 minutes/month downtime budget

  fund_transfer:            # Inter-account transfer (async OK)
    p50_ms: 500
    p95_ms: 2000
    p99_ms: 5000
    availability: 99.9%   # 43 minutes/month downtime budget

  settlement_batch:         # End-of-day reconciliation (batch)
    duration_minutes: 30    # must complete within 30 minutes
    availability: 99.5%
```

```java
// Enforce SLOs in CI via load tests
// (PaymentAuthSimulation / SimulationReport are thin in-house wrappers around
//  a Gatling run -- in practice Gatling's own assertions, lesson 16, do this)
class SloValidationTest {

    @Test
    @Tag("slo-validation")
    void paymentAuthorizationMeetsSlo() {
        PaymentAuthSimulation simulation = new PaymentAuthSimulation(
            500,                        // target users per second
            Duration.ofMinutes(5)       // duration
        );

        SimulationReport report = simulation.run();

        assertThat(report.getPercentile(50)).isLessThan(150);  // p50 < 150ms
        assertThat(report.getPercentile(95)).isLessThan(500);  // p95 < 500ms
        assertThat(report.getPercentile(99)).isLessThan(1000); // p99 < 1000ms
        assertThat(report.getSuccessRate()).isGreaterThan(0.9995); // 99.95% success
    }
}
```

## 5. تحليل العائد على الاستثمار في التحسين

قبل بدء أي مشروع أداء، احسب العائد المتوقع.

```
ROI Framework (illustrative numbers):

1. Measure current state
   - p99 latency: 800ms
   - Throughput: 500 TPS
   - Infrastructure cost: $12,000/month

2. Estimate improvement
   - Proposed: add composite index to transactions table
   - Expected p99 improvement: 800ms -> 120ms (based on EXPLAIN ANALYZE)
   - Expected throughput improvement: 500 -> 2,000 TPS
   - Implementation effort: 4 hours (1 engineer)

3. Calculate impact
   - Customer experience: p99 improvement reduces abandoned payments
   - Infrastructure: 2000 TPS at current scale -> can delay server provisioning
   - Cost savings: 3-month delay on $4,000/month server = $12,000 saved
   - Engineer cost: 4 hours * $200/hr = $800
   - ROI: ($12,000 - $800) / $800 = 14x

4. Compare alternatives
   - Alternative: add read replica ($2,000/month hardware)
   - Alternative ROI: 2000 TPS capacity, but costs $24,000/year ongoing
   - Index approach wins: one-time cost, sustainable improvement
```

```sql
-- Document performance work with before/after measurements (illustrative)
/**
 * Performance optimization: Composite index on transactions(account_id, created_at)
 *
 * Problem: Balance history API (GET /accounts/{id}/transactions) averaging 1,234ms p99
 * Root cause: EXPLAIN ANALYZE showed sequential scan on 50M row table
 *
 * Before (2024-01-10):
 *   p50: 234ms, p95: 876ms, p99: 1,234ms
 *   DB query: 1,180ms (sequential scan, 50M rows)
 *
 * After (2024-01-11, index deployed):
 *   p50: 12ms, p95: 45ms, p99: 89ms
 *   DB query: 2ms (index scan, 50 rows)
 *
 * Impact:
 *   - p99 improvement: 93%
 *   - Customer support tickets for "slow balance": expected -60%
 *   - Infrastructure: deferred $4,000/month read replica for 6 months
 */
CREATE INDEX CONCURRENTLY idx_transactions_account_history   -- no write lock (lesson 9)
    ON transactions (account_id, created_at DESC)
    INCLUDE (amount, currency, status);
```

## 6. منع تراجع الأداء في CI

```java
// JMH benchmark as a CI gate
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@State(Scope.Thread)
public class BalanceLookupBenchmark {

    @Benchmark
    public BalanceResponse balanceLookup(BenchmarkState state) {
        return state.balanceService.getBalance(state.accountId);
    }

    @State(Scope.Benchmark)
    public static class BenchmarkState {
        @Setup
        public void setup() {
            // Setup test data with 1M accounts
        }
    }
}

// In CI, compare against baseline
class BenchmarkRegressionCheck {

    @Test
    @Tag("performance-regression")
    void balanceLookupShouldNotRegress() {
        BenchmarkResult result = runJmhBenchmark(BalanceLookupBenchmark.class);
        double currentMicros = result.getScore();

        // Load baseline from previous CI run (stored in artifact)
        double baselineMicros = loadBaseline("balance_lookup");

        // Fail if performance regressed by > 20%
        double regressionThreshold = baselineMicros * 1.20;
        assertThat(currentMicros)
            .as("Balance lookup performance regression detected: " +
                "current=%.2fµs baseline=%.2fµs threshold=%.2fµs",
                currentMicros, baselineMicros, regressionThreshold)
            .isLessThanOrEqualTo(regressionThreshold);
    }
}
```

```yaml
# GitHub Actions: performance regression gate
# Run on a DEDICATED, quiet runner: shared CI machines vary by more than 20%
- name: Run performance benchmarks
  run: |
    mvn -q package -DskipTests
    java -jar target/benchmarks.jar -rf json -rff target/jmh-result.json

- name: Check for regressions
  run: |
    python scripts/check_perf_regression.py \
      --results target/jmh-result.json \
      --baseline .performance-baselines/main.json \
      --threshold 0.20   # 20% regression triggers failure

- name: Update baseline (on main branch only)
  if: github.ref == 'refs/heads/main'
  run: |
    cp target/jmh-result.json .performance-baselines/main.json
    git commit -am "Update performance baseline [skip ci]"
    git push   # needs a token with write permission
```

(تخزن فرق كثيرة خط الأساس كمخرج بناء أو في مخزن مقاييس بدل إيداعه، وتقارن بوسيط عدة تشغيلات حديثة لامتصاص الضجيج.)

## 7. مفاضلات الأداء مقابل قابلية الصيانة

يجب أن يحكّم كبير المهندسين بين مكاسب الأداء وصحة الشيفرة على المدى الطويل.

```java
// SCENARIO: Payment validator optimization

// Option A: Readable, maintainable (500ns per call)
public ValidationResult validate(PaymentRequest request) {
    return ValidationChain.of(
        new AmountValidator(),
        new CurrencyValidator(),
        new AccountStatusValidator(),
        new DailyLimitValidator()
    ).validate(request);
}

// Option B: Optimized (200ns per call, -60%)
public ValidationResult validate(PaymentRequest request) {
    // Hand-inlined validation to avoid object allocation and virtual dispatch
    if (request.getAmount().signum() <= 0) return ValidationResult.invalid("INVALID_AMOUNT");
    if (request.getAmount().scale() > 4) return ValidationResult.invalid("TOO_MANY_DECIMALS");
    if (!VALID_CURRENCIES.contains(request.getCurrency())) return ValidationResult.invalid("INVALID_CURRENCY");
    // ... 200 more lines of inline validation
    return ValidationResult.valid();
}

// DECISION FRAMEWORK:
// Q: What is the actual impact of 300ns savings?
// A: At 10,000 TPS: 300ns * 10,000 = 3ms of CPU per second
//    On a 32-core machine at 5% CPU utilization: negligible
//
// Q: What is the maintenance cost?
// A: Every new validation rule requires editing a 300-line method
//    Risk of merge conflicts, bugs from inline coupling
//
// DECISION: Option A — maintainability wins when performance delta is <1% of budget
```

### متى تقبل الدين التقني من أجل الأداء

```java
/**
 * Performance optimization decision: idempotency key lookup
 *
 * We add a Redis check IN FRONT OF the database lookup, because HGET on
 * a Redis hash is ~0.1ms vs ~2ms for the DB index scan (illustrative).
 *
 * At 5,000 TPS, this saves ~9.5 seconds of cumulative latency per second
 * (the idempotency check drops from ~2% to ~0.1% of request time).
 *
 * Trade-off accepted:
 *   - Performance gain: ~95% reduction in idempotency check latency
 *   - Complexity added: Redis dependency on the hot path
 *   - Correctness unchanged: the UNIQUE constraint on the idempotency key
 *     in the database stays the source of truth (Redis is not durable and
 *     can lose recent writes on failover -- lesson 11)
 *   - Reviewed by: Principal Engineer on 2024-01-15
 *   - Review date: 2025-01-15 (annual review)
 *
 * If Redis is slow or unavailable, we skip it and use the DB check only.
 */
@Service
public class IdempotencyService {
    // ... Redis-based implementation
}
```

## 8. قائمة فحص تحسين الأداء

استخدم قائمة الفحص هذه قبل بدء أي عمل أداء:

```
Pre-work:
[ ] Measure current state (p50/p95/p99, throughput, error rate)
[ ] Define the target SLO (what success looks like)
[ ] Identify the bottleneck using USE method and distributed traces
[ ] Form a hypothesis: "X is slow because Y, fixing Y will improve X by Z"
[ ] Estimate ROI (effort vs expected improvement)
[ ] Get stakeholder alignment (is this the right problem to solve now?)

During work:
[ ] Change one variable at a time (isolate the fix)
[ ] Measure after each change
[ ] Keep a log of what was tried and results (even failed experiments)
[ ] Add a regression test before shipping

Post-work:
[ ] Measure improvement in production (not just staging)
[ ] Update performance baseline in CI
[ ] Document the change with before/after numbers
[ ] Share learnings with the team
[ ] Schedule a follow-up review to verify improvement persists
```

## 9. أنماط الأداء المضادة الشائعة في التقنية المالية

### النمط المضاد 1: التحسين السابق لأوانه

```java
// WRONG: Optimizing account number formatting before measuring
// "String concatenation is slow" — applied everywhere preemptively
public String formatAccountNumber(String raw) {
    StringBuilder sb = new StringBuilder(20); // "optimized" string building
    sb.append(raw, 0, 4).append('-')
      .append(raw, 4, 8).append('-')
      .append(raw, 8, 12);
    return sb.toString();
}

// This method is called once per API response — the "optimization" saves
// nanoseconds but makes simple code harder to read. Simple "+"
// concatenation is fine here (the compiler optimizes it anyway).
```

### النمط المضاد 2: تجاهل الاختناق الحقيقي

```java
// Spending 2 weeks optimizing Java code when the bottleneck is a missing DB index
// Symptom: developers profile Java, see "JDBC query execution" taking 95% of time
// Action taken: "optimize the Java layer" — adds caching, async processing, etc.
// Reality: the query needs an index. All the Java work was wasted.
// Lesson: check EXPLAIN ANALYZE BEFORE optimizing application code
```

### النمط المضاد 3: ذاكرة مؤقتة بلا إبطال

```java
// WRONG: caching exchange rates with no eviction strategy
@Cacheable("exchange-rates")
public BigDecimal getRate(String base, String quote) {
    return rateRepository.findLatest(base, quote);
}
// If the cache has no TTL configured (the default for a plain cache
// manager), it serves stale rates until restart or eviction.
// In a forex trading context: catastrophic.
```

### النمط المضاد 4: استعلامات N+1 من ORM

```java
// WRONG: Hibernate N+1 — 1 query to load accounts, N queries to load transactions
List<Account> accounts = accountRepo.findAllActive();
for (Account account : accounts) {
    List<Transaction> txns = account.getTransactions(); // N additional queries!
    // processes...
}

// RIGHT: JOIN FETCH or explicit batch load
List<Account> accounts = accountRepo.findAllActiveWithRecentTransactions();
// Single query: SELECT a.*, t.* FROM accounts a LEFT JOIN transactions t ON...
```

## 10. الخلاصة — تفويض الأداء لكبير المهندسين

مسؤوليات كبير المهندسين في الأداء:

1. **ضع ثقافة القياس**: لا تحسين دون بيانات. وقِس كل شيء.
2. **امتلك أهداف SLO**: اكتب أهداف الأداء، واجعلها مرئية، وافرضها في CI.
3. **ابنِ دليل تحديد الاختناقات**: وثّق قائمة فحص طريقة USE لمكدسك التقني.
4. **راجع طلبات التحسين للعائد**: اعترض على التحسينات التي تضيف تعقيدًا لمكاسب هامشية.
5. **امنع التراجع**: خط أساس للأداء في CI، وتنبيهات آلية للتدهور.
6. **درّب الفريق**: شارك تحليل مخططات اللهب، وتفسير EXPLAIN ANALYZE، ونتائج JMH.
7. **اجعل مفاضلات الأداء صريحة**: وثّق متى ولماذا اتُّخذ اختصار في الأداء.

> [!NOTE]
> أفضل تحسين أداء في نظام مالي هو منع حادث إنتاج. فانقطاع واحد لمعالجة الدفع مدته 30 دقيقة في ساعات الذروة قد يكلف أكثر من عام من الإنفاق على البنية التحتية. والموثوقية مقياس أداء.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يقترح فريق التحول من LinkedHashMap إلى HashMap في دالة تجميع أرصدة حسابات، مدعيًا أن ذلك سيحسن الأداء. ولا توجد مقاييس. ما الرد الصحيح من كبير المهندسين، وما الذي يجب أن يحدث قبل دمج هذا التغيير؟",
      "options": [
        "وافق على التغيير — HashMap أسرع دائمًا من LinkedHashMap فهو تحسين آمن",
        "اطلب مقياس JMH دقيقًا يقيس نمط الوصول الفعلي قبل الدمج. فإذا كانت الدالة تعمل مرة واحدة لكل رد واجهة، فإن فرق سرعة 2% يوفر نحو 50 نانوثانية — أقل بكثير من أرضية ضجيج القياس ولا يستحق تقليل قابلية التصحيح للخرائط غير المرتبة",
        "ارفض التغيير نهائيًا — يجب ألا يُسمح أبدًا بالتحسين السابق لأوانه في الأنظمة المالية",
        "اطلب اختبار حمل عند 10,000 معاملة في الثانية لترى إن كان التغيير قابلًا للقياس على نطاق واسع"
      ],
      "correct": 1,
      "explanation": "المبدأ الأساسي: قِس أولًا، دائمًا. فدون مقياس، لا يستطيع الفريق معرفة ما إذا كان فرق الأداء ذا معنى. وبتكرار الاستدعاء الموصوف، يوفر تحسين 2% عند 10,000 معاملة في الثانية نحو 50 نانوثانية × 10,000 = 500 ميكروثانية من المعالج في الثانية — ضئيل. والتغيير ليس مجانيًا أيضًا: فـ LinkedHashMap يحفظ ترتيب الإدراج وقد تعتمد عليه الشيفرة (أو الاختبارات، أو مخرجات التقارير). ومقياس JMH لنمط الوصول الحقيقي سيُظهر المكسب الضئيل فورًا. ودور كبير المهندسين الاعتراض على التحسينات التي تضيف مخاطرة أو تعقيدًا لمكاسب هامشية."
    },
    {
      "text": "زمن p99 لخدمة دفع 800 مللي ثانية. واستخدام المعالج 15%. ويُظهر تشبع مجمع اتصالات قاعدة البيانات خيوطًا تنتظر الاتصالات. ما الخطوة التالية الصحيحة في إطار تحديد الاختناقات؟",
      "options": [
        "أضف خوادم تطبيق أكثر لتوزيع الحمل — المعالج قليل الاستخدام فالاختناق يجب أن يكون في طبقة التطبيق",
        "بما أن المعالج ليس الاختناق وتشبع مجمع الاتصالات غير صفري، افحص pg_stat_activity لتحديد ما إذا كانت الاستعلامات بطيئة (تحتاج تحسينًا أو فهارس) أو كثيرة فحسب (تحتاج تحجيم مجمع الاتصالات، أو نسخ قراءة، أو تخزينًا مؤقتًا)",
        "زِد maximumPoolSize في HikariCP إلى 500 لإزالة تشبع المجمع",
        "فعّل الذاكرة المؤقتة من المستوى الثاني في Hibernate لتقليل استعلامات قاعدة البيانات"
      ],
      "correct": 1,
      "explanation": "يعمل إطار تحديد الاختناقات خطوة بخطوة. المعالج < 80% ← ليس مقيدًا بالمعالج. وتشبع المجمع > 0 ← اختناق في قاعدة البيانات. والسؤال التالي لماذا استُنفدت الاتصالات: استعلامات بطيئة (تحتاج فهارس، وتحسين استعلامات) أم استعلامات كثيرة جدًا (تحتاج تحجيم المجمع، أو نسخًا، أو تخزينًا مؤقتًا). ويُظهر pg_stat_activity مدد الاستعلامات النشطة. ويكشف EXPLAIN ANALYZE خطط الاستعلام. وزيادة حجم المجمع عشوائيًا دون تشخيص أداء الاستعلامات هي النمط المضاد 'تجاهل الاختناق الحقيقي' — فهي تؤخر الاستنفاد لكنها لا تصلح السبب الجذري."
    },
    {
      "text": "يضيف فريق فحص HGET في Redis ‏(0.1 مللي ثانية) أمام بحث الـ idempotency في قاعدة البيانات (2 مللي ثانية) على المسار الساخن للدفع. ما التوثيق المطلوب، ومتى يجب مراجعة هذا القرار؟",
      "options": [
        "لا حاجة للتوثيق — Redis مفهوم على نطاق واسع ومكسب الأداء واضح",
        "وثّق مكسب الأداء (انخفاض زمن الفحص بنحو 95%)، والتعقيد المضاف (اعتمادية Redis على المسار الساخن)، وأن قيد UNIQUE في قاعدة البيانات يبقى مصدر الحقيقة، ومن راجعه ومتى، وتاريخ المراجعة السنوية، والرجوع حين يكون Redis بطيئًا أو غير متاح",
        "أنشئ تذكرة Jira تصف التغيير وأغلقها حين يكتمل النشر",
        "وثّق في README أن Redis مستخدم للـ idempotency — دون أي تبرير إضافي"
      ],
      "correct": 1,
      "explanation": "عند قبول دين تقني من أجل الأداء، يجب أن يكون القرار صريحًا ومحددًا زمنيًا. والتوثيق المطلوب: أرقام قبل/بعد المقيسة التي تبرر المفاضلة، والتعقيد المحدد المضاف، ولماذا لا تعتمد الصحة على المكوّن الجديد (هنا: قيد UNIQUE في قاعدة البيانات ما زال يمنع المدفوعات المكررة، لأن Redis قد يفقد كتابات)، ومن راجعه ومتى، وتاريخ مراجعة للتحقق من أن المفاضلة ما زالت قائمة، وسلوك الرجوع حين تتدهور الاعتمادية. وهذا يخلق مسار تدقيق للمهندسين المستقبليين الذين يحتاجون فهم سبب وجود الاعتمادية وما يحدث إن فشلت."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء ثقافة قياس الأداء لخدمة معالجة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ UseMethodDashboard كمكوّن Spring يسجّل مقاييس USE من نوع gauge مرة واحدة (بدوال تقرأ القيم الحية) لمجمع اتصالات HikariCP ‏(الاستخدام = النشط/أقصى حجم للمجمع، والتشبع = الخيوط المنتظرة/أقصى حجم للمجمع)، ومجمع خيوط منفذ الدفع (الاستخدام = النشط/الأقصى، والتشبع = حجم الطابور/سعة الطابور)، وGC في JVM ‏(الاستخدام = نسبة وقت GC خلال نافذة 10 ثوانٍ). وعرّف عتبات تنبيه: تشبع المجمع > 0.1 ← P2، وتشبع المجمع > 0.5 ← P1."},
    {"id": "2", "description": "اكتب صنف قياس JMH باسم PaymentValidationBenchmark يقيس تنفيذين للتحقق من الدفع: (أ) نمط ValidationChain الحالي بأربعة كائنات تحقق، (ب) نسخة مضمّنة يدويًا. واستخدم @BenchmarkMode(Mode.AverageTime) و@OutputTimeUnit(TimeUnit.NANOSECONDS). وشغّل بـ 5 تكرارات إحماء و10 تكرارات قياس. ووثّق حساب العائد: عند 10,000 معاملة في الثانية، إذا وفّرت النسخة المضمّنة 300 نانوثانية لكل استدعاء، فاحسب إجمالي توفير المعالج في الثانية وحدد ما إذا كانت كلفة قابلية الصيانة مبررة."},
    {"id": "3", "description": "نفّذ بوابة تراجع أداء في CI باستخدام سير عمل GitHub Actions يشغّل مقاييس JMH على كل طلب دمج، ويقارن النتائج بخط أساس مخزن في .performance-baselines/main.json، ويُفشل البناء إذا تراجع أي مقياس بأكثر من 20%. ويجب أن يحدّث سير العمل ملف خط الأساس حين يُدمج طلب إلى main. واكتب سكربت Python باسم check_perf_regression.py يقرأ مخرجات JMH بصيغة JSON، ويجد درجة خط الأساس المطابقة، ويخرج برمز 1 ورسالة وصفية إذا تُجووزت عتبة التراجع."},
    {"id": "4", "description": "أكمل سجل قرار مفاضلة أداء لإضافة ذاكرة Redis مؤقتة لبحث سعر الصرف في خدمة دفع متعددة العملات. وضمّن: p99 الحالي المقيس (320 مللي ثانية مع استعلام قاعدة البيانات)، وp99 المستهدف بعد التخزين المؤقت، واستراتيجية الإبطال (TTL + إبطال مدفوع بالأحداث عند تحديث السعر)، والرجوع حين يكون Redis غير متاح (الرجوع إلى قاعدة البيانات، وقاطع دائرة بحالة فتح مدتها 5 ثوانٍ)، والاعتمادية التشغيلية المضافة، وتاريخ المراجعة السنوية. ووثّق ذلك كتعليق شيفرة باستخدام القالب من القسم 7 في هذا الدرس."}
  ]
}
-->
