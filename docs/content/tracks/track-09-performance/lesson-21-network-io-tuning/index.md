---
id: track-09-lesson-21
title: "Network I/O Tuning — TCP, Keepalive, and Buffer Sizing"
slug: network-io-tuning
track: track-09
trackName: "Performance Engineering"
sequence: 21
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [TCP, keepalive, buffer-size, Nagle, socket-timeout]
prerequisites: [track-09-lesson-20]
---

# Network I/O Tuning — TCP, Keepalive, and Buffer Sizing

> [!NOTE]
> Payment systems make thousands of network calls per second — to databases, payment gateways, fraud services, and messaging systems. A misconfigured TCP socket can add 40ms to every payment that hits a card network. At 1,000 TPS that is 40,000ms of unnecessary latency per second, manifesting as p99 degradation that no amount of algorithmic optimization can fix.

## 1. TCP_NODELAY — Disabling the Nagle Algorithm

The Nagle algorithm was designed in 1984 for telnet sessions to reduce tiny packet floods on slow networks. It buffers small outgoing segments and coalesces them into one larger packet.

**Problem**: For payment APIs, every millisecond counts. The Nagle algorithm can delay a small HTTP request (e.g., a 200-byte payment authorization) by up to 40ms while waiting to coalesce it with a second packet.

```java
// Netty (used by WebFlux, WebClient, gRPC)
@Configuration
public class NettyServerConfig {

    @Bean
    public NettyServerCustomizer nettyServerCustomizer() {
        return server -> server
            .option(ChannelOption.SO_BACKLOG, 1024)
            .childOption(ChannelOption.TCP_NODELAY, true)   // disable Nagle
            .childOption(ChannelOption.SO_KEEPALIVE, true)
            .childOption(ChannelOption.SO_SNDBUF, 65536)    // 64KB send buffer
            .childOption(ChannelOption.SO_RCVBUF, 65536);   // 64KB receive buffer
    }
}

// OkHttp (used for outbound payment gateway calls)
@Bean
public OkHttpClient paymentGatewayHttpClient() {
    return new OkHttpClient.Builder()
        .connectTimeout(Duration.ofMillis(500))
        .readTimeout(Duration.ofMillis(5_000))
        .writeTimeout(Duration.ofMillis(2_000))
        .connectionPool(new ConnectionPool(
            50,              // max idle connections
            300,             // keep alive duration
            TimeUnit.SECONDS
        ))
        .socketFactory(new SocketFactory() {
            @Override
            public Socket createSocket() throws IOException {
                Socket socket = new Socket();
                socket.setTcpNoDelay(true);        // disable Nagle
                socket.setKeepAlive(true);          // enable keepalive
                socket.setSendBufferSize(65536);    // 64KB
                socket.setReceiveBufferSize(65536); // 64KB
                return socket;
            }
            // ... other required overrides
        })
        .build();
}
```

### Verification

```bash
# Verify TCP_NODELAY is set on live connections
ss -tni | grep -A1 "ESTAB" | grep -i "nodelay\|nonagle"

# Or check via /proc for a specific socket
cat /proc/net/tcp  # complex parsing, prefer ss
```

## 2. TCP Keepalive — Detecting Dead Connections

Persistent connections to payment gateways and databases can go "stale" silently — the client thinks the connection is alive, but a firewall or NAT device dropped the state. Without keepalive, the first request on a stale connection gets a TCP RST or timeout.

### OS-Level Keepalive

```bash
# /etc/sysctl.conf — apply to all sockets on the machine
net.ipv4.tcp_keepalive_time    = 60   # start keepalive probes after 60s idle
net.ipv4.tcp_keepalive_intvl   = 10   # send probe every 10s
net.ipv4.tcp_keepalive_probes  = 3    # send 3 probes before giving up

# Apply immediately (without reboot)
sysctl -p
```

### Java-Level Keepalive

```java
// Lettuce (Redis client) — TCP keepalive for Redis connections
@Bean
public LettuceConnectionFactory redisConnectionFactory() {
    SocketOptions socketOptions = SocketOptions.builder()
        .connectTimeout(Duration.ofMillis(1000))
        .keepAlive(SocketOptions.KeepAliveOptions.builder()
            .enable(true)
            .idle(Duration.ofSeconds(30))    // keepalive after 30s idle
            .interval(Duration.ofSeconds(10)) // probe interval
            .count(3)                         // probes before marking dead
            .build())
        .tcpNoDelay(true)
        .build();

    ClientOptions clientOptions = ClientOptions.builder()
        .socketOptions(socketOptions)
        .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
        .build();

    LettuceClientConfiguration clientConfig = LettuceClientConfiguration.builder()
        .clientOptions(clientOptions)
        .commandTimeout(Duration.ofMillis(500))
        .build();

    return new LettuceConnectionFactory(
        new RedisStandaloneConfiguration("redis", 6379),
        clientConfig
    );
}

// HikariCP (PostgreSQL) — connection liveness check
@Bean
public HikariConfig hikariConfig() {
    HikariConfig config = new HikariConfig();
    config.setJdbcUrl("jdbc:postgresql://db:5432/payments");
    config.setMaximumPoolSize(20);
    config.setMinimumIdle(5);
    config.setConnectionTimeout(2_000);       // 2s to get connection from pool
    config.setIdleTimeout(600_000);           // remove idle after 10 min
    config.setKeepaliveTime(60_000);          // send keepalive every 60s
    config.setMaxLifetime(1_800_000);         // recycle connections every 30 min
    config.setConnectionTestQuery("SELECT 1");
    config.addDataSourceProperty("socketTimeout", "30");  // 30s socket timeout
    config.addDataSourceProperty("tcpKeepAlive", "true");
    return config;
}
```

## 3. Socket Buffer Sizing — SO_SNDBUF and SO_RCVBUF

Socket buffers hold data in transit between the application and the network card. Undersized buffers cause backpressure and stall the TCP window.

### Optimal Buffer Size Calculation

```
Optimal buffer size = Bandwidth * RTT  (bandwidth-delay product)

Example: 10 Gbps link, 1ms RTT to database:
  Buffer = 10 * 10^9 bits/s * 0.001 s = 10,000,000 bits = 1.25 MB

For a 1 Gbps link with 1ms RTT:
  Buffer = 1 * 10^9 * 0.001 = 1,000,000 bits = 125 KB

Default Linux socket buffer: 8 KB (way too small for modern networks)
```

```bash
# OS-level socket buffer configuration
# /etc/sysctl.conf

# TCP socket buffers
net.core.rmem_default = 262144    # 256KB default receive buffer
net.core.rmem_max     = 16777216  # 16MB max receive buffer
net.core.wmem_default = 262144    # 256KB default send buffer
net.core.wmem_max     = 16777216  # 16MB max send buffer

# TCP auto-tuning (let kernel size buffers dynamically)
net.ipv4.tcp_rmem = 4096 262144 16777216   # min, default, max
net.ipv4.tcp_wmem = 4096 262144 16777216

# Enable TCP auto-tuning
net.ipv4.tcp_moderate_rcvbuf = 1
```

```java
// Application-level buffer sizing via Netty
@Bean
public NettyServerCustomizer bufferSizing() {
    return server -> server
        .childOption(ChannelOption.SO_RCVBUF, 262144)  // 256KB receive
        .childOption(ChannelOption.SO_SNDBUF, 262144)  // 256KB send
        .childOption(ChannelOption.RCVBUF_ALLOCATOR,
            new FixedRecvByteBufAllocator(65536));      // 64KB initial allocation
}
```

## 4. HTTP Connection Keepalive — Persistent Connections

Establishing a new TCP connection for each HTTP request adds 1–3 RTTs of latency (TCP handshake + TLS handshake). For payment gateway calls, this overhead is significant.

### WebClient — Persistent Connections

```java
@Configuration
public class WebClientConfig {

    @Bean
    public WebClient paymentGatewayWebClient() {
        // Netty connection pool settings
        ConnectionProvider connectionProvider = ConnectionProvider.builder("payment-gateway")
            .maxConnections(100)              // max connections in pool
            .maxIdleTime(Duration.ofSeconds(300))    // keep idle connections for 5 min
            .maxLifeTime(Duration.ofSeconds(3600))   // recycle connections after 1 hr
            .pendingAcquireMaxCount(200)      // queue up to 200 requests
            .pendingAcquireTimeout(Duration.ofMillis(500)) // timeout in queue
            .evictInBackground(Duration.ofSeconds(30))     // background eviction
            .build();

        HttpClient httpClient = HttpClient.create(connectionProvider)
            .option(ChannelOption.TCP_NODELAY, true)
            .option(ChannelOption.SO_KEEPALIVE, true)
            .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 1000)
            .responseTimeout(Duration.ofMillis(5_000))
            .doOnConnected(conn -> conn
                .addHandlerLast(new ReadTimeoutHandler(5000, TimeUnit.MILLISECONDS))
                .addHandlerLast(new WriteTimeoutHandler(2000, TimeUnit.MILLISECONDS)));

        return WebClient.builder()
            .clientConnector(new ReactorClientHttpConnector(httpClient))
            .baseUrl("https://api.payment-gateway.com")
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .build();
    }
}
```

### OkHttp — Connection Pooling for Payment Gateways

```java
@Bean
public OkHttpClient stripeHttpClient() {
    // Stripe API calls are typically 200–600ms
    // Keep 20 connections warm to avoid handshake overhead
    return new OkHttpClient.Builder()
        .connectionPool(new ConnectionPool(
            20,                // max idle connections per host
            300,               // keep alive 5 minutes
            TimeUnit.SECONDS
        ))
        .connectTimeout(500, TimeUnit.MILLISECONDS)
        .readTimeout(10_000, TimeUnit.MILLISECONDS)   // Stripe can be slow
        .writeTimeout(5_000, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)                // retry on stale connection
        .addInterceptor(new RetryInterceptor(3))
        .build();
}

// Interceptor: retry once on connection reset (stale connection from pool)
public class RetryInterceptor implements Interceptor {
    private final int maxRetries;

    @Override
    public Response intercept(Chain chain) throws IOException {
        Request request = chain.request();
        IOException lastException = null;

        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return chain.proceed(request);
            } catch (IOException e) {
                lastException = e;
                if (attempt < maxRetries && isRetriable(e)) {
                    log.warn("Retrying request to {} (attempt {}/{})",
                        request.url(), attempt + 1, maxRetries);
                } else {
                    throw e;
                }
            }
        }
        throw lastException;
    }

    private boolean isRetriable(IOException e) {
        return e instanceof SocketException &&
               e.getMessage().contains("Connection reset");
    }
}
```

## 5. TIME_WAIT Exhaustion

When a TCP connection closes, the initiating side enters TIME_WAIT for 2*MSL (typically 60–120 seconds). This prevents port reuse. Under high throughput, source ports can be exhausted.

```bash
# Check current TIME_WAIT connections
ss -s | grep -i "time-wait\|time_wait"

# Count TIME_WAIT connections to payment gateway
ss -tn state time-wait | grep "api.payment-gateway.com" | wc -l

# If count > 10,000, you have an exhaustion risk
```

### Solutions

```bash
# Option 1: Increase ephemeral port range (more ports = more TIME_WAIT capacity)
# /etc/sysctl.conf
net.ipv4.ip_local_port_range = 1024 65535   # default is 32768 60999

# Option 2: Enable TCP TIME_WAIT reuse (safe for client connections)
net.ipv4.tcp_tw_reuse = 1   # allow reuse of TIME_WAIT sockets for new connections

# Option 3: Reduce TIME_WAIT duration (controversial — reduces safety margin)
# net.ipv4.tcp_fin_timeout = 30   # reduce from 60s to 30s
```

```java
// Application-level solution: use persistent connections (reduces close events)
// The best fix for TIME_WAIT exhaustion is not closing connections at all.
// Connection pools (Lettuce, HikariCP, OkHttp) are the right solution.

// Verify: monitor connection close rate
@Component
public class NetworkMonitor {

    @Scheduled(fixedRate = 10_000)
    public void reportConnections() {
        // Alert if TIME_WAIT connections exceed threshold
        int timeWaitCount = countTimeWaitConnections();
        if (timeWaitCount > 5_000) {
            log.warn("TIME_WAIT connection count is high: {}. " +
                "Consider increasing connection pool size to reduce connection churn.",
                timeWaitCount);
        }
    }
}
```

## 6. DNS Caching for External APIs

DNS lookups for external payment gateways (Stripe, Braintree, etc.) add 10–100ms latency if not cached. The JVM has configurable DNS caching.

```java
// JVM DNS cache configuration
// By default, JVM caches DNS forever (security.properties)
// This is dangerous: if a payment gateway rotates IP addresses, your connections fail

// Set in application startup
static {
    java.security.Security.setProperty(
        "networkaddress.cache.ttl", "60"           // cache for 60 seconds
    );
    java.security.Security.setProperty(
        "networkaddress.cache.negative.ttl", "10"  // cache failures for 10s
    );
}

// Or via JVM flags:
// -Dsun.net.inetaddr.ttl=60
// -Dsun.net.inetaddr.negative.ttl=10

// Spring Boot: configure in application startup
@SpringBootApplication
public class PaymentApplication {
    public static void main(String[] args) {
        // Set DNS cache TTL before Spring context loads
        System.setProperty("networkaddress.cache.ttl", "60");
        SpringApplication.run(PaymentApplication.class, args);
    }
}
```

```java
// Monitor DNS resolution time
@Component
public class DnsMonitor {

    private final MeterRegistry metrics;

    @Scheduled(fixedRate = 30_000)
    public void measureDnsLatency() {
        List<String> hosts = List.of(
            "api.stripe.com",
            "api.braintreegateway.com",
            "db.internal.company.com"
        );

        hosts.forEach(host -> {
            long start = System.nanoTime();
            try {
                InetAddress.getByName(host);
                long elapsed = System.nanoTime() - start;
                metrics.timer("dns.resolution.latency",
                    "host", host)
                    .record(elapsed, TimeUnit.NANOSECONDS);
            } catch (Exception e) {
                log.error("DNS resolution failed for {}: {}", host, e.getMessage());
            }
        });
    }
}
```

## 7. Netty Channel Option Reference

```java
@Configuration
public class ComprehensiveNettyConfig {

    @Bean
    public NettyServerCustomizer productionNettyCustomizer() {
        return server -> server
            // Server socket options
            .option(ChannelOption.SO_BACKLOG, 1024)
            // Backlog: max pending connections before the OS starts rejecting.
            // Default 128 is too low for payment services receiving bursts.

            .option(ChannelOption.SO_REUSEADDR, true)
            // Allow binding to a port in TIME_WAIT state (useful during restarts)

            // Per-connection (child) options
            .childOption(ChannelOption.TCP_NODELAY, true)
            // Disable Nagle: critical for low-latency payment API responses

            .childOption(ChannelOption.SO_KEEPALIVE, true)
            // Enable TCP keepalive at OS level

            .childOption(ChannelOption.SO_SNDBUF, 262144)
            // 256KB send buffer — appropriate for intra-datacenter

            .childOption(ChannelOption.SO_RCVBUF, 262144)
            // 256KB receive buffer

            .childOption(ChannelOption.SO_LINGER, -1)
            // -1: standard graceful close (do not use 0 which resets connections)

            .childOption(ChannelOption.CONNECT_TIMEOUT_MILLIS, 1000)
            // Outbound connection timeout: fail fast if service unreachable

            .childOption(ChannelOption.WRITE_BUFFER_WATER_MARK,
                new WriteBufferWaterMark(32 * 1024, 64 * 1024))
            // Backpressure: pause writes when buffer reaches 64KB,
            // resume at 32KB. Prevents OOM under slow consumers.

            .childOption(ChannelOption.AUTO_READ, true)
            // Start reading immediately when connection is established

            .childOption(ChannelOption.RCVBUF_ALLOCATOR,
                new AdaptiveRecvByteBufAllocator(
                    512,     // minimum allocation
                    8192,    // initial allocation
                    65536    // maximum allocation
                ));
            // Adaptive allocator adjusts buffer size based on actual traffic patterns
    }
}
```

## 8. Timeout Hierarchy for Payment Gateway Calls

```java
@Service
public class PaymentGatewayClient {

    private final WebClient webClient;

    /**
     * Timeout hierarchy for payment gateway calls:
     *
     * 1. Connect timeout (500ms): fail fast if gateway is unreachable
     * 2. Request timeout (5s): total time for the request including processing
     * 3. Read timeout (4s): time to receive first byte of response
     * 4. Circuit breaker (after 5 consecutive timeouts): open circuit for 30s
     *
     * The outer timeout in your SLA must exceed the gateway's own timeout.
     * Example: Stripe authorize SLA = 2s. Your timeout must be > 2s.
     */
    public Mono<AuthorizationResponse> authorize(AuthorizationRequest request) {
        return webClient.post()
            .uri("/v1/charges/authorize")
            .bodyValue(request)
            .retrieve()
            .onStatus(HttpStatusCode::is5xxServerError,
                resp -> resp.bodyToMono(String.class)
                    .flatMap(body -> Mono.error(
                        new GatewayException("Gateway 5xx: " + body))))
            .bodyToMono(AuthorizationResponse.class)
            .timeout(Duration.ofMillis(5_000),
                Mono.error(new GatewayTimeoutException("Authorization timed out")))
            .retryWhen(Retry.fixedDelay(1, Duration.ofMillis(100))
                .filter(ex -> ex instanceof GatewayTimeoutException))
            .doOnError(e -> log.error("Authorization failed: {}", e.getMessage()));
    }
}
```

## 9. Monitoring Network I/O Health

```java
@Component
@Slf4j
public class NetworkHealthMonitor {

    private final MeterRegistry metrics;

    /**
     * Monitor key network metrics via Micrometer.
     * These metrics should feed into your payment SLA dashboard.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void registerNetworkMetrics() {
        // JVM-level: bytes sent/received (requires JVM NIO metrics)
        Metrics.addRegistry(metrics);

        // Connection pool metrics via Actuator
        // Available at: /actuator/metrics/http.client.requests
    }

    /**
     * Alert conditions for network degradation in a payment system:
     * - p99 connection acquisition time > 50ms: pool exhausted
     * - Connection error rate > 0.1%: network instability
     * - DNS resolution time > 10ms: DNS cache miss or DNS server overload
     * - TIME_WAIT count > 10,000: connection churn (need larger pool)
     */
    @Scheduled(fixedRate = 15_000)
    public void checkNetworkHealth() {
        // Connection pool metrics from WebClient (via Actuator metrics)
        Double pendingConnections = metrics.find("reactor.netty.connection.provider.pending.connections")
            .gauge()
            .map(Gauge::value)
            .orElse(0.0);

        if (pendingConnections > 50) {
            log.warn("High pending WebClient connections: {}. " +
                "Payment gateway calls may be queuing.", pendingConnections);
        }
    }
}
```

## 10. Summary — Network Tuning Checklist

| Setting | Default | Recommended | Impact |
|---|---|---|---|
| TCP_NODELAY | Off (Nagle on) | On | Eliminate 40ms Nagle delay |
| SO_KEEPALIVE | Off | On | Detect stale connections |
| TCP keepalive_time | 7200s | 60s | Detect failures faster |
| SO_SNDBUF / SO_RCVBUF | 8 KB | 256 KB | Prevent buffer stall |
| Connection pool size | Varies | 20–100 | Avoid handshake per request |
| DNS cache TTL | Indefinite | 60s | Support gateway IP rotation |
| ip_local_port_range | 32768–60999 | 1024–65535 | Prevent port exhaustion |
| tcp_tw_reuse | Off | On | Reduce TIME_WAIT impact |

> [!WARNING]
> Never tune `net.ipv4.tcp_fin_timeout` below 15 seconds and never disable `tcp_tw_reuse` without understanding the NAT/load-balancer behavior in your network. Aggressive TCP settings can cause intermittent connection failures that are extremely difficult to diagnose. Measure first with `ss -s` and `netstat -s` before modifying kernel parameters.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What problem does TCP_NODELAY (Nagle's algorithm disabled) solve for payment authorization services?",
      "options": [
        "TCP_NODELAY prevents packet fragmentation for large payment payloads",
        "Nagle's algorithm buffers small packets to coalesce them into larger ones, adding up to 40ms delay per request; disabling it via TCP_NODELAY ensures small payment authorization requests are sent immediately without buffering",
        "TCP_NODELAY increases the TCP receive buffer size to handle burst traffic",
        "Nagle's algorithm causes connection reuse issues; TCP_NODELAY disables connection pooling requirements"
      ],
      "correct": 1,
      "explanation": "Nagle's algorithm is designed to improve throughput for chatty protocols by coalescing small packets. However, for a payment authorization request that fits in a single TCP packet, Nagle can delay the packet up to 40ms (the delayed ACK timeout) waiting for more data to coalesce. Payment SLAs of <100ms cannot afford this delay. Set TCP_NODELAY=true on all payment service sockets."
    },
    {
      "text": "Why do TCP TIME_WAIT states cause port exhaustion in high-TPS payment services?",
      "options": [
        "TIME_WAIT states consume memory proportional to the payload size of the closed connection",
        "Each closed TCP connection enters TIME_WAIT for 2×MSL (typically 60-120 seconds); at high TPS with many short-lived connections, the number of TIME_WAIT sockets can exhaust the available ephemeral port range, preventing new connections",
        "TIME_WAIT states block the GC thread from reclaiming socket objects",
        "TIME_WAIT is only an issue for UDP; TCP connections use a different closing mechanism"
      ],
      "correct": 1,
      "explanation": "The default ephemeral port range is 32768-60999 (~28,000 ports). At 1000 short-lived connections/second, with 60s TIME_WAIT, you need 60,000 ports simultaneously — exceeding the default range. Fix: extend the port range (1024-65535), enable tcp_tw_reuse (allows reuse of TIME_WAIT sockets for new connections to the same destination), and use connection pooling to minimize connection creation rate."
    },
    {
      "text": "What is the purpose of SO_KEEPALIVE and why is it important for payment service connections to upstream gateways?",
      "options": [
        "SO_KEEPALIVE maintains a persistent HTTP session, reducing TLS handshake overhead",
        "SO_KEEPALIVE sends periodic TCP probes on idle connections; without it, NAT devices and load balancers silently drop idle connections after their timeout, causing the application to discover the broken connection only when the next payment request fails",
        "SO_KEEPALIVE prevents the OS from reclaiming connection file descriptors during GC pauses",
        "SO_KEEPALIVE is only needed for UDP connections; TCP connections self-recover"
      ],
      "correct": 1,
      "explanation": "NAT devices and load balancers typically have idle connection timeouts of 60-300 seconds. Without TCP keepalive probes, an idle payment gateway connection appears valid to the application but has been silently dropped by the network. The first payment request on the broken connection fails and must be retried, adding latency. SO_KEEPALIVE with a probe interval shorter than the NAT timeout prevents this."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Network I/O Tuning for Payment Gateway Connections",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Configure a Netty-based HTTP client for payment gateway calls with: TCP_NODELAY enabled, SO_KEEPALIVE with appropriate probe intervals, connection pool sized for peak TPS, and read/connect timeouts calibrated to the payment SLO."},
    {"id": "2", "description": "Write a NetworkHealthMonitor Spring component that uses ss -s output (via ProcessBuilder) to monitor TIME_WAIT socket count, alert when it exceeds 10,000, and report the current ephemeral port range utilization percentage."},
    {"id": "3", "description": "Implement a ConnectionLeakDetector that tracks connection acquisition timestamps and logs a warning for any connection held longer than 5 seconds (indicating a potential connection leak or slow query)."},
    {"id": "4", "description": "Write a Testcontainers-based test that simulates a network partition between the payment service and its database, verifies the service returns a PaymentServiceUnavailableException within the configured timeout, and confirms connections are re-established after the partition heals."}
  ]
}
-->

