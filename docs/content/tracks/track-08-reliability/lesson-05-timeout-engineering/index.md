---
id: track-08-lesson-05
title: "Timeout Engineering — Cascading Failure Prevention"
slug: timeout-engineering
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 5
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [timeout, cascading-failure, deadline, read-timeout, connect-timeout]
prerequisites: []
---

# Timeout Engineering — Cascading Failure Prevention

> [!NOTE]
> A missing timeout is a hidden bug. In financial services, a thread blocked forever waiting for a payment processor response is indistinguishable from a healthy thread — until your thread pool exhausts and the entire service stops responding.

## 1. The Timeout Hierarchy

Modern financial services make calls across multiple layers: HTTP clients, database connections, message brokers, and RPC frameworks. Each layer has distinct timeout semantics.

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
│  │  (time to receive first byte)     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

| Timeout Type | What It Measures | Typical Value (Payment Service) |
|---|---|---|
| Connect Timeout | TCP handshake + TLS negotiation | 1–3s |
| Write Timeout | Sending the request payload | 1–2s |
| Read Timeout | Waiting for first byte of response | 3–10s |
| Call Timeout | Total end-to-end time | 10–30s |
| Response Timeout | WebFlux: time between response chunks | 5–15s |

## 2. Connect vs Read Timeout — The Critical Distinction

Connect timeouts and read timeouts fail in entirely different ways.

A **connect timeout** fires when the network is unreachable or the server is not listening. It fails fast — typically within seconds. It tells you the host is down.

A **read timeout** fires when the server accepted the connection but stopped sending data. This is the dangerous one: the server is alive enough to accept your connection but is overloaded, deadlocked, or processing for longer than expected. Without a read timeout, your thread blocks indefinitely.

```java
// WRONG: No timeouts configured — silent thread leak risk
RestTemplate badClient = new RestTemplate();

// CORRECT: Explicit timeout configuration for payment gateway
@Bean
public RestTemplate paymentGatewayRestTemplate() {
    HttpComponentsClientHttpRequestFactory factory =
        new HttpComponentsClientHttpRequestFactory();

    factory.setConnectTimeout(2_000);            // 2s to establish TCP+TLS
    factory.setReadTimeout(10_000);              // 10s to read response
    factory.setConnectionRequestTimeout(1_000);  // 1s to get conn from pool

    CloseableHttpClient httpClient = HttpClients.custom()
        .setMaxConnTotal(200)
        .setMaxConnPerRoute(50)
        .setDefaultSocketConfig(
            SocketConfig.custom()
                .setSoTimeout(10_000)  // Socket-level read timeout (belt+suspenders)
                .build()
        )
        .build();

    factory.setHttpClient(httpClient);
    return new RestTemplate(factory);
}
```

## 3. WebClient Timeouts — Reactive Stack

```java
@Configuration
public class WebClientConfig {

    /**
     * Configure Netty HttpClient with layered timeouts.
     * - CONNECT_TIMEOUT_MILLIS: Netty channel option, fires before TCP established
     * - responseTimeout: overall time from request sent to response complete
     * - ReadTimeoutHandler: idle read timeout (fires if no bytes received for N seconds)
     * - WriteTimeoutHandler: idle write timeout (fires if no bytes sent for N seconds)
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

## 4. Deadline Propagation Across Services

In a microservice chain, timeouts must be propagated as deadlines. If service A has a 10s deadline and spends 3s doing local work, it should give service B only 7s, not a fresh 10s.

Without deadline propagation, timeouts become meaningless. Each service waits its full timeout even if the caller has already given up — wasting resources on work that will be discarded.

```java
/**
 * Deadline context — thread-local deadline for the current request scope.
 * Propagated via HTTP header X-Request-Deadline (absolute epoch ms).
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

    public static DeadlineContext fromAbsoluteEpochMs(long absoluteDeadlineMs) {
        long nowMs = System.currentTimeMillis();
        long remainingMs = absoluteDeadlineMs - nowMs;
        DeadlineContext ctx = new DeadlineContext(nowMs, remainingMs);
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

    private static final String DEADLINE_HEADER = "X-Request-Deadline";

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
            request.getHeaders().set(
                DEADLINE_HEADER,
                String.valueOf(deadline.getAbsoluteDeadlineEpochMs()));
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
        String deadlineHeader = request.getHeader("X-Request-Deadline");
        DeadlineContext ctx = null;
        if (deadlineHeader != null) {
            long absoluteDeadlineMs = Long.parseLong(deadlineHeader);
            long remainingMs = absoluteDeadlineMs - System.currentTimeMillis();
            if (remainingMs <= 0) {
                log.warn("Request arrived after deadline expired path={}",
                    request.getRequestURI());
                response.setStatus(HttpServletResponse.SC_GATEWAY_TIMEOUT);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                response.getWriter().write(
                    "{\"error\":\"deadline_exceeded\",\"message\":\"Request deadline expired\"}");
                return;
            }
            ctx = DeadlineContext.fromAbsoluteEpochMs(absoluteDeadlineMs);
        }
        try {
            filterChain.doFilter(request, response);
        } finally {
            if (ctx != null) ctx.clear();
        }
    }
}
```

## 5. Resilience4j TimeLimiter

```java
@Configuration
public class TimeLimiterConfiguration {

    @Bean
    public TimeLimiterRegistry timeLimiterRegistry() {
        Map<String, TimeLimiterConfig> configs = Map.of(
            // Payment gateway: 8s limit (gateway SLA is p99 < 3s, 8s gives buffer)
            "payment-gateway", TimeLimiterConfig.custom()
                .timeoutDuration(Duration.ofSeconds(8))
                .cancelRunningFuture(true)  // Cancel thread on timeout, don't just abandon
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
        return TimeLimiterRegistry.of(configs);
    }
}

@Service
@RequiredArgsConstructor
@Slf4j
public class TimeLimitedPaymentService {

    private final TimeLimiterRegistry timeLimiterRegistry;
    private final ScheduledExecutorService scheduler;
    private final PaymentGatewayClient gatewayClient;

    @TimeLimiter(name = "payment-gateway", fallbackMethod = "gatewayTimeoutFallback")
    @CircuitBreaker(name = "payment-gateway")
    public CompletableFuture<PaymentResponse> submitPayment(PaymentRequest request) {
        return CompletableFuture.supplyAsync(
            () -> gatewayClient.submit(request),
            Executors.newVirtualThreadPerTaskExecutor()
        );
    }

    /**
     * Fallback invoked when TimeLimiter fires.
     * Log, alert if high-value, return a pending response for async resolution.
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

## 6. JDBC Query Timeouts

Database query timeouts are often forgotten while HTTP timeouts get attention. A slow query holds a database connection (scarce resource) and blocks the calling thread.

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
     * javax.persistence.query.timeout is in milliseconds.
     */
    @QueryHints({
        @QueryHint(name = "javax.persistence.query.timeout", value = "5000"),
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
     * setQueryTimeout is in seconds (JDBC spec); overrides statement_timeout.
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

## 7. Connection Pool Timeout vs Query Timeout

These two timeouts are frequently confused. Getting them wrong causes subtle failures.

```
HikariCP connectionTimeout (3s default):
  "How long to wait for a connection to become AVAILABLE FROM THE POOL"
  - If all 50 pool connections are in use, you wait up to this duration
  - Fires: HikariPool.PoolTimeoutException
  - Signals: pool size too small, queries too slow, or N+1 query problem

PostgreSQL statement_timeout (30s default):
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

    /**
     * Monitor connection pool saturation.
     * Alert when pending threads > 5 — a leading indicator of
     * PoolTimeoutException storm about to happen.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void startPoolMonitoring(@Autowired DataSource dataSource,
                                     @Autowired MeterRegistry registry) {
        if (dataSource instanceof HikariDataSource hikari) {
            HikariPoolMXBean pool = hikari.getHikariPoolMXBean();

            Gauge.builder("hikari.connections.active",
                pool, HikariPoolMXBean::getActiveConnections)
                .description("Active (in-use) connections")
                .register(registry);

            Gauge.builder("hikari.connections.pending",
                pool, HikariPoolMXBean::getThreadsAwaitingConnection)
                .description("Threads waiting for a free connection — alert if > 5")
                .register(registry);

            Gauge.builder("hikari.connections.utilization",
                pool, p -> (double) p.getActiveConnections() / hikari.getMaximumPoolSize())
                .description("Pool utilization ratio — alert if > 0.8")
                .register(registry);
        }
    }
}
```

## 8. Timeout Budgets — End-to-End Deadline Planning

Design timeout budgets top-down from your SLO, not bottom-up from individual service timeouts.

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
     * Failure mode: FAIL OPEN (default to ALLOW on timeout).
     * Alert: Page on-call if fraud timeout rate exceeds 0.1%.
     */
    @NotNull
    private Duration fraudCheck = Duration.ofMillis(500);

    /**
     * Payment gateway read timeout: 8s.
     * Rationale: Gateway SLA is p99 < 3s. 8s handles settlement windows.
     * Note: Connect timeout is separate at 2s.
     */
    @NotNull
    private Duration gatewayRead = Duration.ofSeconds(8);

    /**
     * Database query timeout: 3s.
     * Rationale: Balance queries hit accountId index — typically < 10ms.
     * Exceeding 3s = missing index or table lock = needs immediate alert.
     */
    @NotNull
    private Duration databaseQuery = Duration.ofSeconds(3);
}
```

## 9. Cascading Timeout Failures — The Failure Anatomy

The classic cascade:

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

Prevention requires correctly-tuned timeouts **at every layer**:

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
     * 2. @TimeLimiter: abort if call takes > 8s
     *    → prevents thread exhaustion from slow gateway
     *
     * 3. @Bulkhead(THREADPOOL): max 20 concurrent gateway calls
     *    → prevents gateway slowness from consuming all threads
     *
     * 4. Dedicated ThreadPoolTaskExecutor
     *    → isolates gateway calls from other service operations
     */
    @CircuitBreaker(name = "payment-gateway", fallbackMethod = "circuitBreakerFallback")
    @TimeLimiter(name = "payment-gateway", fallbackMethod = "timeoutFallback")
    @Bulkhead(name = "payment-gateway", type = Bulkhead.Type.THREADPOOL)
    public CompletableFuture<PaymentResponse> submitPayment(PaymentRequest request) {
        return CompletableFuture.supplyAsync(
            () -> gatewayClient.submit(request),
            paymentGatewayExecutor
        );
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

## 10. Timeout Profiles for Payment Ecosystem Dependencies

```java
/**
 * Timeout profiles for common payment ecosystem integrations.
 * Values based on SLA documentation and production p99 observations.
 */
@Configuration
public class GatewayTimeoutProfiles {

    /**
     * Card Networks (Visa/Mastercard):
     * - Connect: 3s (geo-distributed entry points, DNS-based routing)
     * - Read: 30s (authorization can take up to 25s in edge cases)
     * - Recommendation: Set overall deadline at 35s, alert at 5s
     */
    @Bean("cardNetworkWebClient")
    public WebClient cardNetworkWebClient() {
        return buildWebClient("https://card-network.example.com",
            Duration.ofSeconds(3), Duration.ofSeconds(30));
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
     * - FAIL OPEN: return ALLOW on timeout, alert ops
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

## 11. Monitoring and Alerting for Timeouts

```yaml
# Prometheus alert rules for timeout engineering

groups:
  - name: payment-timeouts
    rules:
      - alert: GatewayTimeoutRateHigh
        expr: |
          rate(http_client_requests_seconds_count{
            outcome="TIMEOUT",
            uri=~"/gateway/.*"
          }[5m]) > 0.01
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

## 12. Production Checklist

Before deploying any service that calls external payment infrastructure:

- [ ] Connect timeout set (never infinite, typically 1–3s)
- [ ] Read timeout set (never infinite, based on SLA budget)
- [ ] Call/overall timeout set (always less than your upstream's timeout)
- [ ] Connection pool timeout set (HikariCP `connectionTimeout`)
- [ ] Database `statement_timeout` set in `connectionInitSql`
- [ ] Per-query timeouts on critical path queries via `@QueryHint`
- [ ] Deadline propagation header sent on all outbound calls
- [ ] Deadline extracted from inbound requests and enforced
- [ ] Timeout exceptions increment circuit breaker failure count
- [ ] Timeout metrics exported to Prometheus (`outcome="TIMEOUT"`)
- [ ] Alerts on timeout rate > 1% for payment gateway calls
- [ ] Alerts on connection pool pending threads > 10
- [ ] Runbook documents what to do when each timeout fires
- [ ] Load test verifies timeouts fire correctly under simulated gateway slowness

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A service has a 10s overall deadline and spends 3s on local processing before calling a downstream service. What timeout should it set for the downstream call?",
      "options": ["10s (the full deadline)", "7s (the remaining deadline)", "3s (what it already spent)", "5s (half the original deadline)"],
      "correct": 1,
      "explanation": "Deadline propagation requires passing the remaining budget, not the original deadline. With 3s elapsed and a 10s total deadline, only 7s remains for downstream calls. Giving the downstream a fresh 10s means you could exceed the caller's SLO."
    },
    {
      "text": "What does HikariCP's connectionTimeout setting control?",
      "options": ["How long a SQL query can run before being cancelled", "How long to wait for a TCP connection to PostgreSQL", "How long to wait for a free connection from the pool", "How long an idle connection lives before eviction"],
      "correct": 2,
      "explanation": "HikariCP connectionTimeout is the maximum time to wait for a connection to become available from the connection pool. It is not a network timeout — it fires when all pool connections are in use. The database statement_timeout controls query execution time."
    },
    {
      "text": "Which component type is most dangerous when missing a read timeout in a payment service?",
      "options": ["A health check endpoint", "A thread blocking on a slow payment gateway response", "A Kubernetes liveness probe", "A Redis cache GET call"],
      "correct": 1,
      "explanation": "A thread blocking indefinitely waiting for a slow payment gateway holds a thread-pool slot. If enough such calls accumulate, the entire thread pool exhausts, causing the service to stop accepting new requests — a classic cascading failure."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "End-to-End Timeout Budget Implementation for Payment Submission",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design a timeout budget from an SLO of p99 < 5s end-to-end, allocating time slices to: API gateway, auth service, fraud check, database balance read, and payment gateway HTTP call. Document the rationale for each allocation."},
    {"id": "2", "description": "Implement DeadlineContext using ThreadLocal with propagation via X-Request-Deadline header — including an inbound servlet filter that rejects already-expired requests with 504 and an outbound RestTemplate interceptor that attaches the remaining deadline."},
    {"id": "3", "description": "Configure WebClient for the payment gateway with layered timeouts (CONNECT_TIMEOUT_MILLIS, responseTimeout, ReadTimeoutHandler, WriteTimeoutHandler) and add a per-request override for the fraud check path using Mono.timeout()."},
    {"id": "4", "description": "Add Prometheus alert rules that fire when gateway timeout rate exceeds 1%, when HikariCP pending threads exceed 10, and when database query timeouts spike above 5 in a 10-minute window."}
  ]
}
-->

