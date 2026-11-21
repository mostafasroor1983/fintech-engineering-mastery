---
id: track-06-lesson-05
title: "هندسة المهلات الزمنية — منع الأعطال المتتالية"
slug: timeout-engineering
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 5
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [timeout, cascading-failure, deadline, read-timeout, connect-timeout]
prerequisites: []
---

# هندسة المهل — منع الإخفاقات المتتالية

> [!NOTE]
> المهلة المفقودة خطأ خفي. ففي الخدمات المالية، لا يمكن تمييز خيط محجوب إلى الأبد بانتظار رد معالج مدفوعات عن خيط سليم — حتى يُستنفد مجمع الخيوط لديك وتتوقف الخدمة كلها عن الاستجابة.

## 1. تسلسل المهل

تجري الخدمات المالية الحديثة استدعاءات عبر طبقات متعددة: عملاء HTTP، واتصالات قواعد البيانات، ووسطاء الرسائل، وأطر RPC. ولكل طبقة دلالات مهل متمايزة.

```
┌─────────────────────────────────────────┐
│  Call Timeout (overall deadline)         │  e.g., 10s
│  ┌───────────────────────────────────┐  │
│  │  Connect Timeout                  │  │  e.g., 2s
│  │  (TCP + TLS handshake)            │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  Request Write Timeout            │  │  e.g., 1s
│  │  (time to send request body)      │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  Read Timeout                     │  │  e.g., 8s
│  │  (max silence between bytes)      │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

| نوع المهلة | ما تقيسه | القيمة النموذجية (خدمة دفع) |
|---|---|---|
| مهلة الاتصال | مصافحة TCP + تفاوض TLS | 1–3 ثوانٍ |
| مهلة الكتابة | إرسال حمولة الطلب | 1–2 ثانية |
| مهلة القراءة (المقبس) | أقصى صمت أثناء انتظار البيانات — يُعاد ضبطها مع كل بايت يُستقبل | 3–10 ثوانٍ |
| مهلة الاستدعاء | الزمن الإجمالي من طرف إلى طرف | 10–30 ثانية |
| مهلة الرد | ‏WebFlux: الزمن بين أجزاء الرد | 5–15 ثانية |

## 2. مهلة الاتصال مقابل مهلة القراءة — التمييز الحرج

تفشل مهل الاتصال ومهل القراءة بطرق مختلفة تمامًا.

تنطلق **مهلة الاتصال** عندما تكون الشبكة غير قابلة للوصول أو الخادم لا يستمع. وهي تفشل بسرعة — عادة خلال ثوانٍ. وتخبرك أن المضيف معطل.

تنطلق **مهلة القراءة** عندما يقبل الخادم الاتصال لكنه يتوقف عن إرسال البيانات. وهذه الخطرة: فالخادم حي بما يكفي لقبول اتصالك لكنه محمّل، أو في جمود، أو يعالج أطول من المتوقع. ودون مهلة قراءة يُحجب خيطك إلى ما لا نهاية. ولاحظ أن معظم العملاء ينفذون مهلة القراءة كـ *خمول* بين البايتات: فالخادم الذي يرسل بايتًا واحدًا كل بضع ثوانٍ لا يطلقها أبدًا. ولهذا تحتاج أيضًا **مهلة استدعاء** إجمالية (موعد نهائي).

```java
// WRONG: No timeouts configured — silent thread leak risk
RestTemplate badClient = new RestTemplate();

// CORRECT: Explicit timeout configuration for payment gateway
// (Apache HttpClient 5 — the client used by Spring 6's HttpComponents factory)
@Bean
public RestTemplate paymentGatewayRestTemplate() {
    PoolingHttpClientConnectionManager connectionManager =
        PoolingHttpClientConnectionManagerBuilder.create()
            .setMaxConnTotal(200)
            .setMaxConnPerRoute(50)
            .setDefaultConnectionConfig(ConnectionConfig.custom()
                .setConnectTimeout(Timeout.ofSeconds(2))    // TCP connect
                .setSocketTimeout(Timeout.ofSeconds(10))    // read inactivity
                .build())
            .build();

    CloseableHttpClient httpClient = HttpClients.custom()
        .setConnectionManager(connectionManager)
        .setDefaultRequestConfig(RequestConfig.custom()
            .setConnectionRequestTimeout(Timeout.ofSeconds(1))  // wait for a pooled connection
            .build())
        .build();

    return new RestTemplate(new HttpComponentsClientHttpRequestFactory(httpClient));
}
```

## 3. مهل WebClient — المنظومة التفاعلية

```java
@Configuration
public class WebClientConfig {

    /**
     * Configure Netty HttpClient with layered timeouts.
     * - CONNECT_TIMEOUT_MILLIS: Netty channel option, fires before TCP established
     * - responseTimeout: max time between network-level reads while receiving
     *   a response (an inactivity limit, NOT a total deadline)
     * - ReadTimeoutHandler: idle read timeout (fires if no bytes received for N seconds)
     * - WriteTimeoutHandler: idle write timeout (fires if no bytes sent for N seconds)
     * - The overall deadline per call comes from Mono.timeout() (below)
     */
    @Bean
    public WebClient paymentGatewayWebClient() {
        HttpClient httpClient = HttpClient.create()
            .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 2_000)
            .responseTimeout(Duration.ofSeconds(10))
            .doOnConnected(conn ->
                conn.addHandlerLast(new ReadTimeoutHandler(8, TimeUnit.SECONDS))
                    .addHandlerLast(new WriteTimeoutHandler(2, TimeUnit.SECONDS))
            );

        return WebClient.builder()
            .clientConnector(new ReactorClientHttpConnector(httpClient))
            .baseUrl("https://payment-gateway.example.com")
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .filter(timeoutLoggingFilter())
            .build();
    }

    /**
     * Per-request timeout override for time-sensitive operations.
     * FX rate queries need faster timeout than standard payment submissions.
     * Use Mono.timeout() to override the default client timeout.
     */
    public Mono<ExchangeRate> fetchFxRateWithTimeout(String pair) {
        return webClient.get()
            .uri("/rates/{pair}", pair)
            .retrieve()
            .bodyToMono(ExchangeRate.class)
            .timeout(
                Duration.ofSeconds(2),  // Override to 2s for FX rates (SLO-driven)
                Mono.error(new FxRateTimeoutException("FX rate timeout for " + pair))
            );
    }

    private ExchangeFilterFunction timeoutLoggingFilter() {
        return ExchangeFilterFunction.ofResponseProcessor(clientResponse ->
            Mono.just(clientResponse)
                .doOnNext(resp -> {
                    if (resp.statusCode().is5xxServerError()) {
                        log.warn("5xx from payment gateway: {}", resp.statusCode());
                    }
                })
        );
    }
}
```

## 4. نشر الموعد النهائي عبر الخدمات

في سلسلة خدمات مصغرة يجب نشر المهل كمواعيد نهائية. فإذا كان للخدمة A موعد نهائي 10 ثوانٍ وأمضت 3 ثوانٍ في عمل محلي، فيجب أن تعطي الخدمة B ‏7 ثوانٍ فقط، لا 10 ثوانٍ جديدة.

دون نشر الموعد النهائي تصبح المهل بلا معنى. فكل خدمة تنتظر مهلتها كاملة حتى لو كان المستدعي قد استسلم بالفعل — فتهدر الموارد على عمل سيُتجاهل.

```java
/**
 * Deadline context — thread-local deadline for the current request scope.
 * Propagated via HTTP header X-Request-Timeout-Ms: the REMAINING budget in
 * milliseconds. (An absolute epoch timestamp would depend on every server's
 * clock agreeing — clock skew of a few hundred ms breaks it. gRPC also sends
 * a relative timeout for this reason.)
 */
public class DeadlineContext {

    private static final ThreadLocal<DeadlineContext> CURRENT = new ThreadLocal<>();

    private final long startEpochMs;
    private final long deadlineDurationMs;

    private DeadlineContext(long startEpochMs, long deadlineDurationMs) {
        this.startEpochMs = startEpochMs;
        this.deadlineDurationMs = deadlineDurationMs;
    }

    public static DeadlineContext withDeadline(Duration deadline) {
        DeadlineContext ctx = new DeadlineContext(
            System.currentTimeMillis(), deadline.toMillis());
        CURRENT.set(ctx);
        return ctx;
    }

    public static DeadlineContext fromRemainingMs(long remainingMs) {
        DeadlineContext ctx = new DeadlineContext(System.currentTimeMillis(), remainingMs);
        CURRENT.set(ctx);
        return ctx;
    }

    public static DeadlineContext current() {
        return CURRENT.get();
    }

    public long remainingMillis() {
        return (startEpochMs + deadlineDurationMs) - System.currentTimeMillis();
    }

    public long elapsedMillis() {
        return System.currentTimeMillis() - startEpochMs;
    }

    public long getAbsoluteDeadlineEpochMs() {
        return startEpochMs + deadlineDurationMs;
    }

    public boolean isExpired() {
        return remainingMillis() <= 0;
    }

    public void clear() {
        CURRENT.remove();
    }
}

/**
 * Outbound interceptor: attach remaining deadline to every downstream call.
 */
@Component
public class DeadlinePropagationInterceptor implements ClientHttpRequestInterceptor {

    private static final String DEADLINE_HEADER = "X-Request-Timeout-Ms";

    @Override
    public ClientHttpResponse intercept(HttpRequest request,
                                         byte[] body,
                                         ClientHttpRequestExecution execution)
            throws IOException {
        DeadlineContext deadline = DeadlineContext.current();
        if (deadline != null) {
            if (deadline.isExpired()) {
                throw new DeadlineExceededException(
                    "Deadline already exceeded before making call to "
                    + request.getURI().getHost());
            }
            // Send the REMAINING budget, not a clock time
            request.getHeaders().set(
                DEADLINE_HEADER,
                String.valueOf(deadline.remainingMillis()));
            // Note: this tells the callee its budget. To also stop OUR wait at
            // the deadline, the client's per-call timeout must be
            // min(configured timeout, remaining) — e.g. WebClient + Mono.timeout().
        }
        return execution.execute(request, body);
    }
}

/**
 * Inbound filter: extract propagated deadline and enforce locally.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class InboundDeadlineFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                     HttpServletResponse response,
                                     FilterChain filterChain)
            throws ServletException, IOException {
        String deadlineHeader = request.getHeader("X-Request-Timeout-Ms");
        DeadlineContext ctx = null;
        if (deadlineHeader != null) {
            long remainingMs;
            try {
                remainingMs = Long.parseLong(deadlineHeader);
            } catch (NumberFormatException e) {
                response.sendError(HttpServletResponse.SC_BAD_REQUEST, "Invalid X-Request-Timeout-Ms");
                return;
            }
            if (remainingMs <= 0) {
                log.warn("Request arrived after deadline expired path={}",
                    request.getRequestURI());
                response.setStatus(HttpServletResponse.SC_GATEWAY_TIMEOUT);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                response.getWriter().write(
                    "{\"error\":\"deadline_exceeded\",\"message\":\"Request deadline expired\"}");
                return;
            }
            ctx = DeadlineContext.fromRemainingMs(remainingMs);
        }
        try {
            filterChain.doFilter(request, response);
        } finally {
            if (ctx != null) ctx.clear();
        }
    }
}
```

## 5. ‏TimeLimiter في Resilience4j

```java
@Configuration
public class TimeLimiterConfiguration {

    @Bean
    public TimeLimiterRegistry timeLimiterRegistry() {
        Map<String, TimeLimiterConfig> configs = Map.of(
            // Payment gateway: 2.5s limit — just above the 2s HTTP read budget,
            // so the HTTP client's own timeout normally fires first
            "payment-gateway", TimeLimiterConfig.custom()
                .timeoutDuration(Duration.ofMillis(2_500))
                // cancel(true) on a CompletableFuture does NOT interrupt the
                // thread doing the I/O — the HTTP client's timeouts must still
                // bound the call. This only stops the caller waiting.
                .cancelRunningFuture(true)
                .build(),
            // Fraud check: 500ms limit (on critical path, must be fast)
            "fraud-check", TimeLimiterConfig.custom()
                .timeoutDuration(Duration.ofMillis(500))
                .cancelRunningFuture(true)
                .build(),
            // FX rate: 2s limit (pre-trade calculation, users are waiting)
            "fx-rate", TimeLimiterConfig.custom()
                .timeoutDuration(Duration.ofSeconds(2))
                .cancelRunningFuture(true)
                .build()
        );
        TimeLimiterRegistry registry = TimeLimiterRegistry.of(configs);
        // TimeLimiterRegistry.of(Map) registers named CONFIGS only. Create the
        // instances with the matching config — otherwise @TimeLimiter(name =
        // "payment-gateway") would silently get the default 1s config.
        configs.keySet().forEach(name -> registry.timeLimiter(name, name));
        return registry;
    }
}

@Service
@RequiredArgsConstructor
@Slf4j
public class TimeLimitedPaymentService {

    // ONE shared executor — not a new executor per call
    private static final ExecutorService GATEWAY_EXECUTOR =
        Executors.newVirtualThreadPerTaskExecutor();

    private final PaymentGatewayClient gatewayClient;

    @TimeLimiter(name = "payment-gateway", fallbackMethod = "gatewayTimeoutFallback")
    @CircuitBreaker(name = "payment-gateway")
    public CompletableFuture<PaymentResponse> submitPayment(PaymentRequest request) {
        return CompletableFuture.supplyAsync(
            () -> gatewayClient.submit(request),   // carries the idempotency key
            GATEWAY_EXECUTOR
        );
    }

    /**
     * Fallback invoked when TimeLimiter fires.
     * The gateway may STILL process the payment: the outcome is unknown.
     * Return PENDING; the status job queries the gateway by idempotency key.
     */
    public CompletableFuture<PaymentResponse> gatewayTimeoutFallback(
            PaymentRequest request,
            TimeoutException ex) {
        log.warn("Payment gateway timeout for key={}", request.getIdempotencyKey());
        // Return PENDING — the caller should poll for final status
        return CompletableFuture.completedFuture(
            PaymentResponse.builder()
                .status(PaymentStatus.PENDING)
                .idempotencyKey(request.getIdempotencyKey())
                .message("Gateway timeout — payment status will be updated asynchronously")
                .build()
        );
    }
}
```

## 6. مهل استعلامات JDBC

كثيرًا ما تُنسى مهل استعلامات قاعدة البيانات بينما تحظى مهل HTTP بالاهتمام. فالاستعلام البطيء يمسك اتصال قاعدة بيانات (مورد نادر) ويحجب الخيط المستدعي.

```java
@Configuration
public class DatabaseTimeoutConfig {

    /**
     * HikariCP configuration with explicit timeout settings.
     *
     * connectionTimeout: how long to wait for a connection from the POOL.
     *   - Not related to network; this is queue wait time.
     *   - Set to 3s: if you're waiting 3s for a free connection, something is wrong.
     *
     * connectionInitSql: runs when connection is first created.
     *   - Sets PostgreSQL statement_timeout for all queries on this connection.
     *   - 30s is generous; most queries should be < 1s.
     */
    @Bean
    @Primary
    public DataSource paymentDataSource(DataSourceProperties props) {
        HikariDataSource ds = props.initializeDataSourceBuilder()
            .type(HikariDataSource.class)
            .build();

        // Connection acquisition from pool
        ds.setConnectionTimeout(3_000);     // 3s max wait for free connection
        ds.setIdleTimeout(600_000);          // 10min idle before eviction
        ds.setMaxLifetime(1_800_000);        // 30min max connection age
        ds.setKeepaliveTime(60_000);         // 1min TCP keepalive ping

        // Server-side statement timeout: kills queries exceeding 30s
        // This is the safety net for queries missing application-level timeouts
        ds.setConnectionInitSql("SET statement_timeout = '30s'");

        return ds;
    }
}

@Repository
public interface PaymentRepository extends JpaRepository<Payment, UUID> {

    /**
     * Balance check query must complete in 5s.
     * Any slower indicates missing index or table lock contention.
     * jakarta.persistence.query.timeout is in milliseconds
     * (javax.* in Spring Boot 2 / Hibernate 5).
     */
    @QueryHints({
        @QueryHint(name = "jakarta.persistence.query.timeout", value = "5000"),
        @QueryHint(name = "org.hibernate.timeout", value = "5")
    })
    @Query("SELECT p FROM Payment p WHERE p.accountId = :accountId " +
           "AND p.status = 'PENDING' AND p.createdAt > :since")
    List<Payment> findPendingPayments(
        @Param("accountId") String accountId,
        @Param("since") Instant since);
}

@Repository
@RequiredArgsConstructor
public class PaymentJdbcRepository {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Direct JDBC timeout control for time-critical fraud check queries.
     * setQueryTimeout is in seconds (JDBC spec). The PostgreSQL driver
     * enforces it from the client (it sends a cancel request); the server's
     * statement_timeout still applies too — whichever is shorter wins.
     */
    public Optional<FraudRecord> findFraudRecordWithTimeout(String accountId) {
        return jdbcTemplate.execute((Connection conn) -> {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT * FROM fraud_records WHERE account_id = ? " +
                    "AND created_at > NOW() - INTERVAL '30 days' LIMIT 1")) {
                ps.setQueryTimeout(2);  // 2 seconds — fraud check is on critical path
                ps.setString(1, accountId);
                ResultSet rs = ps.executeQuery();
                return rs.next() ? Optional.of(mapFraudRecord(rs)) : Optional.empty();
            }
        });
    }
}
```

## 7. مهلة مجمع الاتصالات مقابل مهلة الاستعلام

كثيرًا ما يُخلط بين هاتين المهلتين. والخطأ فيهما يسبب إخفاقات دقيقة.

```
HikariCP connectionTimeout (default 30s; we set 3s):
  "How long to wait for a connection to become AVAILABLE FROM THE POOL"
  - If all 50 pool connections are in use, you wait up to this duration
  - Fires: SQLTransientConnectionException
    ("Connection is not available, request timed out after 3000ms")
  - Signals: pool size too small, queries too slow, or N+1 query problem

PostgreSQL statement_timeout (default 0 = no limit; we set 30s):
  "How long a single SQL statement may execute before the SERVER cancels it"
  - Enforced server-side — more reliable than client-side timeouts
  - Fires: PSQLException: ERROR: canceling statement due to statement timeout
  - Signals: missing index, table lock, or complex unoptimized query

Application query timeout (@QueryHint or setQueryTimeout):
  "Client-side cancellation request to the server"
  - Less reliable than server-side (network issue can prevent cancel signal)
  - Use in addition to, not instead of, statement_timeout
```

```java
@Configuration
@Slf4j
public class ConnectionPoolMonitoring {

    // Note: Spring Boot already publishes HikariCP metrics (hikaricp_connections_active,
    // hikaricp_connections_pending, ...). Only the utilisation ratio below is extra.

    private final DataSource dataSource;
    private final MeterRegistry registry;

    // Constructor injection: an @EventListener method only receives the event
    public ConnectionPoolMonitoring(DataSource dataSource, MeterRegistry registry) {
        this.dataSource = dataSource;
        this.registry = registry;
    }

    /**
     * Monitor connection pool saturation.
     * Alert when pending threads > 5 — a leading indicator of
     * a storm of pool timeouts about to happen.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void startPoolMonitoring() {
        if (dataSource instanceof HikariDataSource hikari) {
            HikariPoolMXBean pool = hikari.getHikariPoolMXBean();

            Gauge.builder("hikari.connections.utilization",
                pool, p -> (double) p.getActiveConnections() / hikari.getMaximumPoolSize())
                .description("Pool utilization ratio — alert if > 0.8")
                .register(registry);
        }
    }
}
```

## 8. ميزانيات المهل — تخطيط الموعد النهائي من طرف إلى طرف

صمم ميزانيات المهل من الأعلى إلى الأسفل انطلاقًا من الـ SLO، لا من الأسفل إلى الأعلى انطلاقًا من مهل الخدمات المنفردة.

```
Payment Submission SLO: p99 < 5s end-to-end

Budget allocation (sum must be under 5s):
  API Gateway processing:        100ms
  Auth service (JWT validate):   200ms
  Payment Service local logic:   300ms
  Fraud check (synchronous):     500ms
  Balance check (DB read):       200ms
  Payment Gateway HTTP call:   2,000ms   ← largest single budget item
  Response mapping/validation:   100ms
  Network/serialization:         200ms
  ─────────────────────────────────────
  Total allocated:             3,600ms   ✓ under 5s SLO
  Safety margin:               1,400ms   (28% headroom for variance)

Each service sets its timeouts based on its allocated budget,
NOT based on what it thinks the downstream can handle.
```

```java
/**
 * Timeout budget configuration — derived from SLO analysis above.
 * Document WHY each timeout is set to its value here.
 * Changes require SLO impact assessment.
 */
@ConfigurationProperties(prefix = "payment.timeouts")
@Data
@Validated
public class PaymentTimeoutProperties {

    /**
     * Total end-to-end budget for payment submission.
     * Set to 5s to meet our p99 < 5s SLO.
     */
    @NotNull
    private Duration totalBudget = Duration.ofSeconds(5);

    /**
     * Fraud check timeout: 500ms.
     * Rationale: Fraud model p99 is 180ms. 500ms gives 2.7x headroom.
     * Failure mode (a documented RISK decision): fail open only below a low
     * amount threshold; above it, fail closed (PENDING / manual review).
     * Alert: Page on-call if fraud timeout rate exceeds 0.1%.
     */
    @NotNull
    private Duration fraudCheck = Duration.ofMillis(500);

    /**
     * Payment gateway read timeout: 2s — our budget slice above.
     * Rationale: Gateway p99 is 800ms. A call that runs past 2s is marked
     * PENDING and resolved by a status query (by idempotency key) — the
     * customer is not kept waiting and the payment is not resent blindly.
     * Note: Connect timeout is separate at 2s.
     */
    @NotNull
    private Duration gatewayRead = Duration.ofSeconds(2);

    /**
     * Database query timeout: 3s.
     * Rationale: Balance queries hit accountId index — typically < 10ms.
     * Exceeding 3s = missing index or table lock = needs immediate alert.
     */
    @NotNull
    private Duration databaseQuery = Duration.ofSeconds(3);
}
```

## 9. إخفاقات المهل المتتالية — تشريح الفشل

التتالي الكلاسيكي:

```
Step 1: Payment Gateway becomes slow (p99 rises 1s → 15s)
Step 2: Payment Service read timeout is 30s (too long!)
Step 3: Requests pile up — each thread holds for up to 30s
Step 4: Thread pool exhausts (200 threads all waiting on gateway)
Step 5: New Payment Service requests → ThreadPoolExecutor.RejectedExecutionException
Step 6: API Gateway sees connection refused from Payment Service
Step 7: API Gateway buffers requests, heap pressure rises
Step 8: Health check on Payment Service starts failing
Step 9: Load balancer routes all traffic to remaining instances
Step 10: Remaining instances also exhaust → full service outage
```

يتطلب المنع مهلًا مضبوطة بشكل صحيح **في كل طبقة**:

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class CascadeProtectedPaymentService {

    /**
     * Four layers of cascade protection, applied in order:
     *
     * 1. @CircuitBreaker: open if error rate > 50% in last 20 calls
     *    → prevents calls to known-broken downstream
     *
     * 2. @TimeLimiter: stop waiting if the call takes > 2.5s
     *    → the caller is released quickly (the thread itself is freed by
     *      the HTTP client's read timeout)
     *
     * 3. @Bulkhead(THREADPOOL): max 20 concurrent gateway calls, on the
     *    bulkhead's OWN thread pool
     *    → isolates gateway calls from all other service operations
     *
     * 4. HTTP client connect + read timeouts
     *    → the only layer that actually frees a blocked thread
     */
    @CircuitBreaker(name = "payment-gateway", fallbackMethod = "circuitBreakerFallback")
    @TimeLimiter(name = "payment-gateway", fallbackMethod = "timeoutFallback")
    @Bulkhead(name = "payment-gateway", type = Bulkhead.Type.THREADPOOL)
    public CompletableFuture<PaymentResponse> submitPayment(PaymentRequest request) {
        // The body already runs on a bulkhead thread: call directly. Wrapping
        // it in supplyAsync(otherExecutor) would bypass the bulkhead.
        return CompletableFuture.completedFuture(gatewayClient.submit(request));
    }

    public CompletableFuture<PaymentResponse> timeoutFallback(
            PaymentRequest request, TimeoutException ex) {
        log.warn("Gateway timeout for key={}", request.getIdempotencyKey());
        return CompletableFuture.completedFuture(
            PaymentResponse.pending(request.getIdempotencyKey()));
    }

    public CompletableFuture<PaymentResponse> circuitBreakerFallback(
            PaymentRequest request, CallNotPermittedException ex) {
        log.warn("Circuit breaker open — rejecting payment key={}",
            request.getIdempotencyKey());
        throw new PaymentGatewayUnavailableException(
            "Payment gateway circuit breaker is open");
    }
}
```

## 10. ملفات المهل لاعتماديات منظومة الدفع

```java
/**
 * Timeout profiles for common payment ecosystem integrations.
 * Values based on SLA documentation and production p99 observations.
 */
@Configuration
public class GatewayTimeoutProfiles {

    /**
     * Card authorisation (via acquirer / card network connection):
     * - Connect: 3s (geo-distributed entry points, DNS-based routing)
     * - Read: set from the processor's documented response time and YOUR
     *   budget — not "as long as it might ever take". Past it, mark the
     *   authorisation PENDING and follow the processor's timeout rules
     *   (status query or automatic reversal of a late approval).
     */
    @Bean("cardNetworkWebClient")
    public WebClient cardNetworkWebClient() {
        return buildWebClient("https://card-network.example.com",
            Duration.ofSeconds(3), Duration.ofSeconds(10));
    }

    /**
     * ACH Processor (same-day ACH):
     * - Connect: 2s, Read: 60s (batch submission can be slow)
     * - Recommendation: Submit async, poll for status — don't hold HTTP connection
     */
    @Bean("achProcessorWebClient")
    public WebClient achProcessorWebClient() {
        return buildWebClient("https://ach-processor.example.com",
            Duration.ofSeconds(2), Duration.ofSeconds(60));
    }

    /**
     * SWIFT Gateway (international wires):
     * - Recommendation: NEVER synchronous. Use async + webhook/polling.
     * - SWIFT confirmations can take 1–4 hours.
     * - Only the initial submission needs a timeout (10s).
     */
    @Bean("swiftGatewayWebClient")
    public WebClient swiftGatewayWebClient() {
        return buildWebClient("https://swift-gateway.example.com",
            Duration.ofSeconds(5), Duration.ofSeconds(10));
    }

    /**
     * Internal Fraud Engine:
     * - Connect: 1s (same datacenter), Read: 500ms (on critical path)
     * - On timeout: fail open only for low amounts (documented risk decision),
     *   otherwise PENDING / review; alert ops either way
     */
    @Bean("fraudEngineWebClient")
    public WebClient fraudEngineWebClient() {
        return buildWebClient("https://fraud-engine.internal",
            Duration.ofSeconds(1), Duration.ofMillis(500));
    }

    private WebClient buildWebClient(String baseUrl,
                                      Duration connectTimeout,
                                      Duration readTimeout) {
        HttpClient httpClient = HttpClient.create()
            .option(ChannelOption.CONNECT_TIMEOUT_MILLIS,
                (int) connectTimeout.toMillis())
            .responseTimeout(readTimeout);
        return WebClient.builder()
            .baseUrl(baseUrl)
            .clientConnector(new ReactorClientHttpConnector(httpClient))
            .build();
    }
}
```

## 11. المراقبة والتنبيه للمهل

```yaml
# Prometheus alert rules for timeout engineering

groups:
  - name: payment-timeouts
    rules:
      - alert: GatewayTimeoutRateHigh
        # Spring's http.client.requests has no outcome="TIMEOUT": a timeout
        # shows up in the "exception" tag (outcome is UNKNOWN). Alert on the
        # timeout RATIO, not on a per-second rate.
        expr: |
          sum(rate(http_client_requests_seconds_count{
                exception=~".*Timeout.*", uri=~"/gateway/.*"}[5m]))
          /
          sum(rate(http_client_requests_seconds_count{uri=~"/gateway/.*"}[5m]))
          > 0.01
        for: 2m
        labels:
          severity: warning
          team: payments
        annotations:
          summary: "Payment gateway timeout rate exceeds 1%"
          description: "Current rate: {{ $value | humanizePercentage }}"
          runbook: "https://wiki.example.com/runbooks/gateway-timeout"

      - alert: DatabaseQueryTimeoutSpike
        expr: |
          increase(spring_data_repository_invocations_seconds_count{
            exception="QueryTimeoutException"
          }[10m]) > 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database query timeouts detected — check for missing indexes"

      - alert: ConnectionPoolExhausted
        expr: hikaricp_connections_pending > 10
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "HikariCP connection pool nearly exhausted"
          description: "{{ $value }} threads waiting for database connections"
```

## 12. قائمة الفحص الإنتاجية

قبل نشر أي خدمة تستدعي بنية دفع خارجية:

- [ ] مهلة الاتصال مضبوطة (لا لانهائية أبدًا، عادة 1–3 ثوانٍ)
- [ ] مهلة القراءة مضبوطة (لا لانهائية أبدًا، بناءً على ميزانية الاتفاقية)
- [ ] مهلة الاستدعاء/الإجمالية مضبوطة (دائمًا أقل من مهلة الطرف الأعلى لديك)
- [ ] مهلة مجمع الاتصالات مضبوطة (`connectionTimeout` في HikariCP)
- [ ] ‏`statement_timeout` لقاعدة البيانات مضبوط في `connectionInitSql`
- [ ] مهل لكل استعلام على استعلامات المسار الحرج عبر `@QueryHint`
- [ ] ترويسة نشر الموعد النهائي تُرسل في كل الاستدعاءات الصادرة
- [ ] الموعد النهائي يُستخرج من الطلبات الواردة ويُفرض
- [ ] استثناءات المهلة تزيد عدد إخفاقات قاطع الدائرة
- [ ] مقاييس المهل مصدّرة إلى Prometheus (المهل ظاهرة في الوسم `exception`)
- [ ] تنبيهات على معدل مهل > 1% لاستدعاءات بوابة الدفع
- [ ] تنبيهات على الخيوط المنتظرة في مجمع الاتصالات > 10
- [ ] دليل التشغيل يوثق ما يجب فعله عند انطلاق كل مهلة
- [ ] اختبار الحمل يتحقق من انطلاق المهل بشكل صحيح تحت بطء بوابة محاكى

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لخدمة موعد نهائي إجمالي قدره 10 ثوانٍ وتمضي 3 ثوانٍ في معالجة محلية قبل استدعاء خدمة لاحقة. ما المهلة التي يجب أن تضبطها للاستدعاء اللاحق؟",
      "options": ["10 ثوانٍ (الموعد النهائي كاملًا)", "7 ثوانٍ (الموعد النهائي المتبقي)", "3 ثوانٍ (ما أمضته بالفعل)", "5 ثوانٍ (نصف الموعد النهائي الأصلي)"],
      "correct": 1,
      "explanation": "يتطلب نشر الموعد النهائي تمرير الميزانية المتبقية، لا الموعد النهائي الأصلي. فمع انقضاء 3 ثوانٍ وموعد نهائي إجمالي 10 ثوانٍ، تبقى 7 ثوانٍ فقط للاستدعاءات اللاحقة. وإعطاء الخدمة اللاحقة 10 ثوانٍ جديدة يعني أنك قد تتجاوز الـ SLO الخاص بالمستدعي."
    },
    {
      "text": "ما الذي يتحكم فيه إعداد connectionTimeout في HikariCP؟",
      "options": ["كم يمكن أن يعمل استعلام SQL قبل إلغائه", "كم تنتظر اتصال TCP بـ PostgreSQL", "كم تنتظر اتصالًا حرًا من المجمع", "كم يعيش اتصال خامل قبل إخلائه"],
      "correct": 2,
      "explanation": "‏connectionTimeout في HikariCP هو أقصى وقت لانتظار توفر اتصال من مجمع الاتصالات. وليس مهلة شبكة — بل ينطلق عندما تكون كل اتصالات المجمع قيد الاستخدام. أما statement_timeout في قاعدة البيانات فيتحكم في زمن تنفيذ الاستعلام."
    },
    {
      "text": "أي نوع من المكونات هو الأخطر عند غياب مهلة القراءة في خدمة دفع؟",
      "options": ["نقطة فحص صحة", "خيط محجوب على رد بطيء من بوابة الدفع", "فحص حيوية في Kubernetes", "استدعاء GET لكاش Redis"],
      "correct": 1,
      "explanation": "الخيط المحجوب إلى ما لا نهاية بانتظار بوابة دفع بطيئة يمسك خانة في مجمع الخيوط. وإذا تراكمت استدعاءات كافية كهذه، يُستنفد مجمع الخيوط كله، فتتوقف الخدمة عن قبول طلبات جديدة — فشل متتالٍ كلاسيكي."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ ميزانية مهل من طرف إلى طرف لإرسال الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "صمم ميزانية مهل من SLO قدره p99 < 5 ثوانٍ من طرف إلى طرف، موزعًا شرائح زمنية على: بوابة الواجهات، وخدمة المصادقة، وفحص الاحتيال، وقراءة الرصيد من قاعدة البيانات، واستدعاء HTTP لبوابة الدفع. ووثّق مبرر كل تخصيص."},
    {"id": "2", "description": "نفّذ DeadlineContext باستخدام ThreadLocal مع النشر عبر ترويسة X-Request-Timeout-Ms تحمل الميزانية المتبقية (لا وقتًا مطلقًا على الساعة، فذلك ينكسر مع انحراف الساعات) — بما في ذلك مرشّح servlet وارد يرفض الطلبات منتهية الموعد بالرد 504 ومعترض RestTemplate صادر يرفق الموعد النهائي المتبقي."},
    {"id": "3", "description": "اضبط WebClient لبوابة الدفع بمهل طبقية (CONNECT_TIMEOUT_MILLIS، وresponseTimeout، وReadTimeoutHandler، وWriteTimeoutHandler) وأضف تجاوزًا لكل طلب لمسار فحص الاحتيال باستخدام Mono.timeout()."},
    {"id": "4", "description": "أضف قواعد تنبيه Prometheus تنطلق عندما يتجاوز معدل مهل البوابة 1%، وعندما تتجاوز الخيوط المنتظرة في HikariCP عشرة، وعندما تقفز مهل استعلامات قاعدة البيانات فوق 5 في نافذة 10 دقائق."}
  ]
}
-->
