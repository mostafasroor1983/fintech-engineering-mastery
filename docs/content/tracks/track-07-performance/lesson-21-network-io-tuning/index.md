---
id: track-07-lesson-21
title: "Network I/O Tuning — TCP, Keepalive, and Buffer Sizing"
slug: network-io-tuning
track: track-07
trackName: "Performance Engineering"
sequence: 21
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [TCP, keepalive, buffer-size, Nagle, socket-timeout]
prerequisites: [track-07-lesson-20]
---

# Network I/O Tuning — TCP, Keepalive, and Buffer Sizing

> [!NOTE]
> Payment systems make thousands of network calls per second — to databases, payment gateways, fraud services, and messaging systems. A misconfigured TCP socket can add tens of milliseconds to every payment call, or make the first request after an idle period fail — p99 problems that no amount of algorithmic optimization can fix.

## 1. TCP_NODELAY — Disabling the Nagle Algorithm

The Nagle algorithm was designed in 1984 for telnet sessions to reduce tiny packet floods on slow networks. It buffers small outgoing segments and coalesces them into one larger packet.

**Problem**: For payment APIs, every millisecond counts. Combined with the receiver's *delayed ACK*, Nagle can hold back a small write (e.g., the last part of a 200-byte authorization request) for up to ~40ms on Linux (longer on some systems) while it waits for an acknowledgement.

**Check before tuning:** most modern clients and servers already disable Nagle — Reactor Netty (WebFlux/WebClient), gRPC-Java, Lettuce and pgjdbc set `TCP_NODELAY` by default. Verify what your libraries do; plain `java.net.Socket` code is where Nagle usually remains on.

```java
// Netty (used by WebFlux, WebClient, gRPC) -- Reactor Netty already sets
// TCP_NODELAY; shown here explicitly
@Configuration
public class NettyServerConfig {

    @Bean
    public NettyServerCustomizer nettyServerCustomizer() {
        return server -> server
            .option(ChannelOption.SO_BACKLOG, 1024)
            .childOption(ChannelOption.TCP_NODELAY, true)   // disable Nagle
            .childOption(ChannelOption.SO_KEEPALIVE, true);
            // Do NOT fix SO_SNDBUF / SO_RCVBUF here: setting them explicitly
            // turns off Linux buffer auto-tuning (see section 3)
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
            50,              // keep idle connections below the server/LB idle timeout
            TimeUnit.SECONDS
        ))
        // DelegatingSocketFactory: a small helper (not part of OkHttp's API)
        // that wraps the default factory and calls configureSocket() on
        // every socket it creates
        .socketFactory(new DelegatingSocketFactory(SocketFactory.getDefault()) {
            @Override
            protected Socket configureSocket(Socket socket) throws IOException {
                socket.setTcpNoDelay(true);        // disable Nagle
                socket.setKeepAlive(true);         // enable TCP keepalive
                return socket;
            }
        })
        .build();
}
```

### Verification

```bash
# ss and /proc do NOT show whether TCP_NODELAY is set. Options:
# 1) Trace the setsockopt calls when the service starts:
strace -f -e trace=setsockopt -p <pid> 2>&1 | grep TCP_NODELAY
# 2) Capture traffic and check that small writes go out immediately
#    instead of waiting for an ACK:
tcpdump -i any -nn 'tcp port 443' -c 200
# 3) Check the library's documented defaults / configuration in code
```

## 2. TCP Keepalive — Detecting Dead Connections

Persistent connections to payment gateways and databases can go "stale" silently — the client thinks the connection is alive, but a firewall or NAT device dropped the state. Without keepalive, the first request on a stale connection gets a TCP RST or timeout.

### OS-Level Keepalive

```bash
# /etc/sysctl.conf — defaults for every socket that ENABLES SO_KEEPALIVE
# (keepalive is off unless the application turns it on)
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
    // (no connectionTestQuery: pgjdbc is JDBC4, HikariCP uses isValid())
    config.addDataSourceProperty("socketTimeout", "30");  // 30s socket timeout
    config.addDataSourceProperty("tcpKeepAlive", "true");
    return config;
}
```

## 3. Socket Buffer Sizing — SO_SNDBUF and SO_RCVBUF

Socket buffers hold data in transit between the application and the network card. Undersized buffers limit throughput on links with a large bandwidth-delay product. Linux **auto-tunes** TCP buffers per connection, so for most services the best setting is to leave the defaults alone.

### Optimal Buffer Size Calculation

```
Optimal buffer size = Bandwidth * RTT  (bandwidth-delay product)

Example: 10 Gbps link, 1ms RTT to database:
  Buffer = 10 * 10^9 bits/s * 0.001 s = 10,000,000 bits = 1.25 MB

For a 1 Gbps link with 1ms RTT:
  Buffer = 1 * 10^9 * 0.001 = 1,000,000 bits = 125 KB

Linux defaults: tcp_rmem = 4096 131072 6291456, tcp_wmem = 4096 16384 4194304
(min / initial / max) -- and the kernel grows each connection's buffer
automatically up to the max. Inside one data centre (RTT well under 1ms)
the defaults are usually plenty; long, fast links (cross-region
replication, bulk transfers) may need a higher max.
```

```bash
# OS-level socket buffer configuration -- only for high-BDP links,
# and only after measuring. /etc/sysctl.conf

# TCP socket buffers
net.core.rmem_default = 262144    # 256KB default receive buffer
net.core.rmem_max     = 16777216  # 16MB max receive buffer
net.core.wmem_default = 262144    # 256KB default send buffer
net.core.wmem_max     = 16777216  # 16MB max send buffer

# TCP auto-tuning (let kernel size buffers dynamically)
net.ipv4.tcp_rmem = 4096 262144 16777216   # min, default, max
net.ipv4.tcp_wmem = 4096 262144 16777216

# Receive-buffer auto-tuning (already on by default -- keep it on)
net.ipv4.tcp_moderate_rcvbuf = 1
```

```java
// Application-level buffer sizing via Netty -- usually NOT recommended:
// setting SO_RCVBUF / SO_SNDBUF explicitly disables the kernel's
// auto-tuning for those sockets (they stay at the fixed size).
// Only do this with measurements that show the fixed size is better.
@Bean
public NettyServerCustomizer bufferSizing() {
    return server -> server
        .childOption(ChannelOption.SO_RCVBUF, 262144)  // 256KB receive (fixed!)
        .childOption(ChannelOption.SO_SNDBUF, 262144); // 256KB send (fixed!)
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
            // Must be SHORTER than the idle timeout of the server and any load
            // balancer in between (often 60s) -- otherwise the pool hands out
            // connections the other side has already closed
            .maxIdleTime(Duration.ofSeconds(45))
            .maxLifeTime(Duration.ofSeconds(3600))   // recycle connections after 1 hr
            .pendingAcquireMaxCount(200)      // queue up to 200 requests
            .pendingAcquireTimeout(Duration.ofMillis(500)) // timeout in queue
            .evictInBackground(Duration.ofSeconds(30))     // background eviction
            .metrics(true)                                 // pool metrics in Micrometer
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
public OkHttpClient gatewayHttpClient() {
    // Gateway API calls typically take a few hundred ms
    // Keep 20 connections warm to avoid handshake overhead
    return new OkHttpClient.Builder()
        .connectionPool(new ConnectionPool(
            20,                // max idle connections
            50,                // keep idle below the gateway's idle timeout
            TimeUnit.SECONDS
        ))
        .connectTimeout(500, TimeUnit.MILLISECONDS)
        .readTimeout(10_000, TimeUnit.MILLISECONDS)
        .writeTimeout(5_000, TimeUnit.MILLISECONDS)
        // (retryOnConnectionFailure is already true by default: OkHttp
        //  silently retries some failures on a fresh connection)
        .addInterceptor(new SafeRetryInterceptor(1))
        .build();
}

// Interceptor: retry once on a connection reset -- but ONLY when a retry
// cannot create a second payment
public class SafeRetryInterceptor implements Interceptor {
    private final int maxRetries;

    public SafeRetryInterceptor(int maxRetries) {
        this.maxRetries = maxRetries;
    }

    @Override
    public Response intercept(Chain chain) throws IOException {
        Request request = chain.request();
        // A reset can happen AFTER the gateway received the request. Retrying
        // a POST without an idempotency key could charge the customer twice.
        boolean safeToRetry = "GET".equals(request.method())
            || request.header("Idempotency-Key") != null;

        for (int attempt = 0; ; attempt++) {
            try {
                return chain.proceed(request);
            } catch (IOException e) {
                if (!safeToRetry || attempt >= maxRetries || !isRetriable(e)) {
                    throw e;
                }
                log.warn("Retrying request to {} (attempt {}/{})",
                    request.url(), attempt + 1, maxRetries);
            }
        }
    }

    private boolean isRetriable(IOException e) {
        String msg = e.getMessage();                  // may be null
        return e instanceof SocketException && msg != null && msg.contains("Connection reset");
    }
}
```

## 5. TIME_WAIT Exhaustion

When a TCP connection closes, the side that closes first enters TIME_WAIT (60 seconds on Linux). During that time the same 4-tuple (source IP:port → destination IP:port) cannot be reused. A client that opens and closes many connections to ONE destination can therefore run out of source ports for that destination.

```bash
# Check current TIME_WAIT connections
ss -s | grep -i "time-wait\|time_wait"

# Count TIME_WAIT connections to the payment gateway
# (ss shows IP addresses, not host names -- filter on the gateway's IP)
ss -tn state time-wait dst 203.0.113.10 | wc -l

# If count > 10,000, you have an exhaustion risk
```

### Solutions

```bash
# Option 1: Widen the ephemeral port range (more ports = more TIME_WAIT capacity)
# /etc/sysctl.conf -- keep it above the ports your services LISTEN on,
# or reserve those with net.ipv4.ip_local_reserved_ports
net.ipv4.ip_local_port_range = 10000 65535   # default is 32768 60999

# Option 2: TIME_WAIT reuse for OUTGOING connections (needs TCP timestamps,
# on by default). Linux default is 2 = loopback only; 1 = all.
net.ipv4.tcp_tw_reuse = 1

# NOT an option: net.ipv4.tcp_fin_timeout -- despite the name it controls
# FIN_WAIT_2, not TIME_WAIT (which is fixed at 60s in Linux).
# And never look for tcp_tw_recycle: it broke clients behind NAT and was
# removed in Linux 4.12.
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
                "Connections are being closed too often -- check keep-alive and pool reuse.",
                timeWaitCount);
        }
    }
}
```

## 6. DNS Caching for External APIs

DNS lookups for external payment gateways (Stripe, Braintree, etc.) add 10–100ms latency if not cached. The JVM has configurable DNS caching.

```java
// JVM DNS cache configuration
// Default: successful lookups are cached for 30 seconds (when no security
// manager is installed; with one, they were cached forever), failures 10s.
// The setting is a SECURITY property (java.security), not a system property:
// System.setProperty("networkaddress.cache.ttl", ...) has NO effect.

public class PaymentApplication {
    public static void main(String[] args) {
        // Set before the first lookup -- i.e. first thing in main()
        java.security.Security.setProperty("networkaddress.cache.ttl", "60");
        java.security.Security.setProperty("networkaddress.cache.negative.ttl", "10");
        SpringApplication.run(PaymentApplication.class, args);
    }
}

// Or via JVM flags (the system-property equivalents):
// -Dsun.net.inetaddr.ttl=60
// -Dsun.net.inetaddr.negative.ttl=10
// Keep the TTL modest: gateways move IPs (CDNs, failover) and a JVM that
// caches too long keeps calling the old address.
```

```java
// Monitor DNS resolution time
// Note: InetAddress.getByName hits the JVM cache most of the time, so this
// mostly measures the cache; spikes show real lookups (cache expiry or a
// slow resolver).
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
            // Netty's default comes from net.core.somaxconn (128 on older
            // kernels, 4096 since Linux 5.4) -- the kernel also caps the value
            // at somaxconn, so raise both together.

            .option(ChannelOption.SO_REUSEADDR, true)
            // Allow binding to a port in TIME_WAIT state (useful during restarts)

            // Per-connection (child) options
            .childOption(ChannelOption.TCP_NODELAY, true)
            // Disable Nagle: critical for low-latency payment API responses

            .childOption(ChannelOption.SO_KEEPALIVE, true)
            // Enable TCP keepalive at OS level

            // (No SO_SNDBUF / SO_RCVBUF: leave kernel auto-tuning on)

            .childOption(ChannelOption.SO_LINGER, -1)
            // -1: standard graceful close (do not use 0 which resets connections)

            // (CONNECT_TIMEOUT_MILLIS belongs on CLIENT bootstraps such as
            //  WebClient's HttpClient -- accepted server connections never connect)

            .childOption(ChannelOption.WRITE_BUFFER_WATER_MARK,
                new WriteBufferWaterMark(32 * 1024, 64 * 1024))
            // Backpressure: the channel is marked "not writable" above 64KB of
            // pending output and writable again below 32KB. Reactor Netty
            // respects this; raw Netty code must check channel.isWritable().

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
     * 2. Response timeout (5s): time from sending the request to the response
     * 3. Read timeout (ReadTimeoutHandler): maximum gap between reads
     * 4. Circuit breaker (after repeated timeouts): open circuit for a while
     *
     * Your timeout must exceed the time the gateway itself may take,
     * or you will time out on requests that were going to succeed.
     *
     * A timeout does NOT mean the authorization failed: the gateway may have
     * approved it. Retry only with the SAME idempotency key, and if the
     * outcome stays unknown, mark the payment PENDING and query the gateway
     * by that key.
     */
    public Mono<AuthorizationResponse> authorize(AuthorizationRequest request) {
        return webClient.post()
            .uri("/v1/charges/authorize")
            // Same key on the retry -> the gateway returns the first result
            .header("Idempotency-Key", request.idempotencyKey())
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

    public NetworkHealthMonitor(MeterRegistry metrics) {
        this.metrics = metrics;
    }

    /**
     * Alert conditions for network degradation in a payment system:
     * - p99 connection acquisition time > 50ms: pool exhausted
     * - Connection error rate > 0.1%: network instability
     * - DNS resolution time > 10ms: DNS cache miss or DNS server overload
     * - TIME_WAIT count > 10,000: connection churn (connections not reused)
     * (Best expressed as Prometheus alert rules; this check is a fallback.)
     */
    @Scheduled(fixedRate = 15_000)
    public void checkNetworkHealth() {
        // Reactor Netty pool metrics (ConnectionProvider built with .metrics(true))
        Gauge pending = metrics.find("reactor.netty.connection.provider.pending.connections")
            .gauge();                                   // may be null
        double pendingConnections = pending != null ? pending.value() : 0.0;

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
| TCP_NODELAY | Off for plain sockets (most modern libraries turn it on) | On | Avoid Nagle/delayed-ACK stalls |
| SO_KEEPALIVE | Off | On | Detect stale connections |
| TCP keepalive_time | 7200s | 60s | Detect failures faster |
| SO_SNDBUF / SO_RCVBUF | Kernel auto-tuned | Leave auto-tuned; raise the max only for high-BDP links | Fixed values disable auto-tuning |
| Pool idle time | Varies | Below the server/LB idle timeout | No stale pooled connections |
| Connection pool size | Varies | Sized from load tests | Avoid handshake per request |
| DNS cache TTL | 30s (no security manager) | 30–60s | Follow gateway IP changes |
| ip_local_port_range | 32768–60999 | e.g. 10000–65535 (reserve listening ports) | Prevent port exhaustion |
| tcp_tw_reuse | 2 (loopback only) | 1 for busy clients | Reduce TIME_WAIT impact |

> [!WARNING]
> Change kernel TCP settings only with care: copy-pasted "tuning" (fixed buffer sizes, the removed `tcp_tw_recycle`, very low timeouts) causes intermittent connection failures that are extremely difficult to diagnose — especially behind NAT and load balancers. Measure first with `ss -s` and `nstat` / `netstat -s`, change one setting at a time, and fix connection reuse in the application before touching the kernel.

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
      "explanation": "Nagle's algorithm improves efficiency for chatty protocols by holding back small segments while earlier data is unacknowledged. Combined with the receiver's delayed ACK, a small request can wait up to ~40ms on Linux before it is sent. Payment SLAs of <100ms cannot afford this. Set TCP_NODELAY=true on payment service sockets — many modern libraries (Reactor Netty, gRPC, Lettuce, pgjdbc) already do."
    },
    {
      "text": "Why do TCP TIME_WAIT states cause port exhaustion in high-TPS payment services?",
      "options": [
        "TIME_WAIT states consume memory proportional to the payload size of the closed connection",
        "The side that closes a TCP connection first keeps it in TIME_WAIT (60 seconds on Linux); at high TPS with many short-lived connections to the same destination, TIME_WAIT sockets can exhaust the available ephemeral port range, preventing new connections",
        "TIME_WAIT states block the GC thread from reclaiming socket objects",
        "TIME_WAIT is only an issue for UDP; TCP connections use a different closing mechanism"
      ],
      "correct": 1,
      "explanation": "The default ephemeral port range is 32768-60999 (~28,000 ports). At 1000 new short-lived connections per second to the SAME destination, with 60s of TIME_WAIT, you would need about 60,000 ports at once — more than the range holds. Fixes: reuse connections (keep-alive and pooling, the real cure), widen the port range (keeping listening ports reserved), and enable tcp_tw_reuse for outgoing connections."
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

