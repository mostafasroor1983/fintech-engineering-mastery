---
id: track-07-lesson-21
title: "ضبط إدخال/إخراج الشبكة — TCP وKeepalive وأحجام المخازن"
slug: network-io-tuning
track: track-07
trackName: "هندسة الأداء ومكونات JVM الداخلية"
sequence: 21
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [TCP, keepalive, buffer-size, Nagle, socket-timeout]
prerequisites: [track-07-lesson-20]
---

# ضبط إدخال/إخراج الشبكة — TCP وKeepalive وتحجيم المخازن

> [!NOTE]
> تجري أنظمة الدفع آلاف الاستدعاءات الشبكية في الثانية — إلى قواعد البيانات، وبوابات الدفع، وخدمات الاحتيال، وأنظمة الرسائل. ومقبس TCP سيئ الإعداد قد يضيف عشرات المللي ثواني إلى كل استدعاء دفع، أو يجعل أول طلب بعد فترة خمول يفشل — مشكلات في p99 لا يصلحها أي قدر من التحسين الخوارزمي.

## 1. ‏TCP_NODELAY — تعطيل خوارزمية Nagle

صُممت خوارزمية Nagle عام 1984 لجلسات telnet لتقليل فيضان الحزم الصغيرة على الشبكات البطيئة. فهي تحتجز المقاطع الصادرة الصغيرة وتدمجها في حزمة واحدة أكبر.

**المشكلة**: لواجهات الدفع كل مللي ثانية مهم. ومع *التأكيد المؤجل (delayed ACK)* لدى المستقبل، قد تحتجز Nagle كتابة صغيرة (مثل الجزء الأخير من طلب تفويض بحجم 200 بايت) حتى نحو 40 مللي ثانية على Linux (وأطول على بعض الأنظمة) بانتظار تأكيد.

**تحقق قبل الضبط:** معظم العملاء والخوادم الحديثة تعطّل Nagle أصلًا — فـ Reactor Netty ‏(WebFlux/WebClient)، وgRPC-Java، وLettuce، وpgjdbc تضبط `TCP_NODELAY` افتراضيًا. فتحقق مما تفعله مكتباتك؛ فشيفرة `java.net.Socket` العادية هي حيث تبقى Nagle مفعّلة عادة.

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

### التحقق

```bash
# ss and /proc do NOT show whether TCP_NODELAY is set. Options:
# 1) Trace the setsockopt calls when the service starts:
strace -f -e trace=setsockopt -p <pid> 2>&1 | grep TCP_NODELAY
# 2) Capture traffic and check that small writes go out immediately
#    instead of waiting for an ACK:
tcpdump -i any -nn 'tcp port 443' -c 200
# 3) Check the library's documented defaults / configuration in code
```

## 2. ‏TCP Keepalive — كشف الاتصالات الميتة

قد "تتقادم" الاتصالات الدائمة إلى بوابات الدفع وقواعد البيانات بصمت — فيظن العميل أن الاتصال حي، بينما أسقط جدار ناري أو جهاز NAT حالته. ودون keepalive، يحصل أول طلب على اتصال متقادم على TCP RST أو مهلة.

### ‏Keepalive على مستوى نظام التشغيل

```bash
# /etc/sysctl.conf — defaults for every socket that ENABLES SO_KEEPALIVE
# (keepalive is off unless the application turns it on)
net.ipv4.tcp_keepalive_time    = 60   # start keepalive probes after 60s idle
net.ipv4.tcp_keepalive_intvl   = 10   # send probe every 10s
net.ipv4.tcp_keepalive_probes  = 3    # send 3 probes before giving up

# Apply immediately (without reboot)
sysctl -p
```

### ‏Keepalive على مستوى Java

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

## 3. تحجيم مخازن المقابس — SO_SNDBUF وSO_RCVBUF

تحمل مخازن المقابس البيانات العابرة بين التطبيق وبطاقة الشبكة. والمخازن الأصغر من اللازم تحد الإنتاجية على الروابط ذات حاصل عرض النطاق في التأخير الكبير. ويضبط Linux مخازن TCP **تلقائيًا** لكل اتصال، فلمعظم الخدمات يكون أفضل إعداد هو ترك الافتراضيات كما هي.

### حساب حجم المخزن الأمثل

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

## 4. ‏HTTP Keepalive — الاتصالات الدائمة

إنشاء اتصال TCP جديد لكل طلب HTTP يضيف 1–3 جولات من الزمن (مصافحة TCP + مصافحة TLS). ولاستدعاءات بوابات الدفع يكون هذا الحمل كبيرًا.

### ‏WebClient — الاتصالات الدائمة

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

### ‏OkHttp — تجميع الاتصالات لبوابات الدفع

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

## 5. استنفاد TIME_WAIT

حين يُغلق اتصال TCP، يدخل الطرف الذي يغلق أولًا حالة TIME_WAIT ‏(60 ثانية في Linux). وخلالها لا يمكن إعادة استخدام الرباعية نفسها (عنوان المصدر:المنفذ ← عنوان الوجهة:المنفذ). فالعميل الذي يفتح ويغلق اتصالات كثيرة إلى وجهة واحدة قد تنفد منافذ المصدر لديه لتلك الوجهة.

```bash
# Check current TIME_WAIT connections
ss -s | grep -i "time-wait\|time_wait"

# Count TIME_WAIT connections to the payment gateway
# (ss shows IP addresses, not host names -- filter on the gateway's IP)
ss -tn state time-wait dst 203.0.113.10 | wc -l

# If count > 10,000, you have an exhaustion risk
```

### الحلول

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

## 6. التخزين المؤقت لـ DNS للواجهات الخارجية

تضيف عمليات بحث DNS لبوابات الدفع الخارجية (Stripe، وBraintree، إلخ) 10–100 مللي ثانية من الزمن إن لم تكن مخزنة. ولـ JVM تخزين DNS قابل للضبط.

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

## 7. مرجع خيارات قنوات Netty

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

## 8. تسلسل المهل لاستدعاءات بوابة الدفع

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

## 9. مراقبة صحة إدخال/إخراج الشبكة

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

## 10. الخلاصة — قائمة فحص ضبط الشبكة

| الإعداد | الافتراضي | الموصى به | الأثر |
|---|---|---|---|
| ‏TCP_NODELAY | معطّل للمقابس العادية (معظم المكتبات الحديثة تفعّله) | مفعّل | تجنب توقفات Nagle/التأكيد المؤجل |
| ‏SO_KEEPALIVE | معطّل | مفعّل | كشف الاتصالات المتقادمة |
| ‏TCP keepalive_time | ‏7200 ثانية | ‏60 ثانية | كشف الأعطال أسرع |
| ‏SO_SNDBUF / SO_RCVBUF | مضبوط تلقائيًا بالنواة | اتركه تلقائيًا؛ وارفع الحد الأقصى فقط للروابط ذات BDP الكبير | القيم الثابتة تعطّل الضبط التلقائي |
| مدة خمول المجمع | متغيرة | أقل من مهلة خمول الخادم/موازن الحمل | لا اتصالات متقادمة في المجمع |
| حجم مجمع الاتصالات | متغير | يُحجّم من اختبارات الحمل | تجنب المصافحة لكل طلب |
| ‏TTL لذاكرة DNS | ‏30 ثانية (دون مدير أمان) | ‏30–60 ثانية | تتبع تغييرات عناوين البوابة |
| ‏ip_local_port_range | ‏32768–60999 | مثلًا 10000–65535 (مع حجز منافذ الاستماع) | منع استنفاد المنافذ |
| ‏tcp_tw_reuse | ‏2 (حلقة الرجوع فقط) | ‏1 للعملاء المشغولين | تقليل أثر TIME_WAIT |

> [!WARNING]
> غيّر إعدادات TCP في النواة بحذر فقط: "الضبط" المنسوخ (أحجام مخازن ثابتة، و`tcp_tw_recycle` المحذوف، ومهل منخفضة جدًا) يسبب أعطال اتصال متقطعة يصعب تشخيصها كثيرًا — خاصة خلف NAT وموازنات الحمل. فقِس أولًا بـ `ss -s` و`nstat` / `netstat -s`، وغيّر إعدادًا واحدًا في كل مرة، وأصلح إعادة استخدام الاتصالات في التطبيق قبل لمس النواة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما المشكلة التي يحلها TCP_NODELAY (تعطيل خوارزمية Nagle) لخدمات تفويض الدفع؟",
      "options": [
        "يمنع TCP_NODELAY تجزئة الحزم لحمولات الدفع الكبيرة",
        "تحتجز خوارزمية Nagle الحزم الصغيرة لدمجها في حزم أكبر، فتضيف حتى 40 مللي ثانية من التأخير لكل طلب؛ وتعطيلها عبر TCP_NODELAY يضمن إرسال طلبات تفويض الدفع الصغيرة فورًا دون احتجاز",
        "يزيد TCP_NODELAY حجم مخزن استقبال TCP للتعامل مع الحركة المتقطعة",
        "تسبب خوارزمية Nagle مشكلات في إعادة استخدام الاتصالات؛ وTCP_NODELAY يلغي متطلبات تجميع الاتصالات"
      ],
      "correct": 1,
      "explanation": "تحسّن خوارزمية Nagle الكفاءة للبروتوكولات كثيرة الرسائل باحتجاز المقاطع الصغيرة بينما البيانات السابقة غير مؤكدة. ومع التأكيد المؤجل لدى المستقبل، قد ينتظر طلب صغير حتى نحو 40 مللي ثانية على Linux قبل إرساله. ولا تحتمل SLAs الدفع الأقل من 100 مللي ثانية هذا. فاضبط TCP_NODELAY=true على مقابس خدمة الدفع — وكثير من المكتبات الحديثة (Reactor Netty، وgRPC، وLettuce، وpgjdbc) تفعل ذلك أصلًا."
    },
    {
      "text": "لماذا تسبب حالات TIME_WAIT في TCP استنفاد المنافذ في خدمات الدفع عالية المعاملات؟",
      "options": [
        "تستهلك حالات TIME_WAIT ذاكرة تتناسب مع حجم حمولة الاتصال المغلق",
        "الطرف الذي يغلق اتصال TCP أولًا يُبقيه في TIME_WAIT ‏(60 ثانية في Linux)؛ وعند معاملات كثيرة في الثانية مع اتصالات قصيرة العمر كثيرة إلى الوجهة نفسها، قد يستنفد عدد مقابس TIME_WAIT نطاق المنافذ المؤقتة المتاح، فيمنع اتصالات جديدة",
        "تحجب حالات TIME_WAIT خيط GC عن استعادة كائنات المقابس",
        "‏TIME_WAIT مشكلة في UDP فقط؛ واتصالات TCP تستخدم آلية إغلاق مختلفة"
      ],
      "correct": 1,
      "explanation": "نطاق المنافذ المؤقتة الافتراضي 32768–60999 (نحو 28,000 منفذ). وعند 1000 اتصال جديد قصير العمر في الثانية إلى الوجهة *نفسها*، مع 60 ثانية من TIME_WAIT، ستحتاج نحو 60,000 منفذ في آن — أكثر مما يحمله النطاق. والإصلاحات: أعد استخدام الاتصالات (keep-alive والتجميع، العلاج الحقيقي)، ووسّع نطاق المنافذ (مع حجز منافذ الاستماع)، وفعّل tcp_tw_reuse للاتصالات الصادرة."
    },
    {
      "text": "ما الغرض من SO_KEEPALIVE ولماذا هو مهم لاتصالات خدمة الدفع ببوابات الدفع الأعلى؟",
      "options": [
        "يحافظ SO_KEEPALIVE على جلسة HTTP دائمة، فيقلل حمل مصافحة TLS",
        "يرسل SO_KEEPALIVE مجسات TCP دورية على الاتصالات الخاملة؛ ودونه تُسقط أجهزة NAT وموازنات الحمل الاتصالات الخاملة بصمت بعد مهلتها، فلا يكتشف التطبيق الاتصال المقطوع إلا حين يفشل طلب الدفع التالي",
        "يمنع SO_KEEPALIVE نظام التشغيل من استعادة واصفات ملفات الاتصال أثناء توقفات GC",
        "‏SO_KEEPALIVE مطلوب لاتصالات UDP فقط؛ واتصالات TCP تتعافى ذاتيًا"
      ],
      "correct": 1,
      "explanation": "لأجهزة NAT وموازنات الحمل عادة مهل خمول للاتصالات بين 60 و300 ثانية. ودون مجسات TCP keepalive، يبدو اتصال البوابة الخامل صالحًا للتطبيق بينما أسقطته الشبكة بصمت. فيفشل أول طلب دفع على الاتصال المقطوع ويجب إعادة محاولته، فيضيف زمنًا. وSO_KEEPALIVE بفترة مجسات أقصر من مهلة NAT يمنع ذلك."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "ضبط إدخال/إخراج الشبكة لاتصالات بوابة الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "اضبط عميل HTTP مبنيًا على Netty لاستدعاءات بوابة الدفع مع: تفعيل TCP_NODELAY، وSO_KEEPALIVE بفترات مجسات مناسبة، ومجمع اتصالات محجّم لذروة المعاملات، ومهل قراءة/اتصال معايرة على SLO الدفع."},
    {"id": "2", "description": "اكتب مكوّن Spring باسم NetworkHealthMonitor يستخدم مخرجات ss -s (عبر ProcessBuilder) لمراقبة عدد مقابس TIME_WAIT، وينبّه حين يتجاوز 10,000، ويُبلغ عن نسبة استخدام نطاق المنافذ المؤقتة الحالية."},
    {"id": "3", "description": "نفّذ ConnectionLeakDetector يتتبع أوقات الحصول على الاتصالات ويسجّل تحذيرًا لأي اتصال محتجز أكثر من 5 ثوانٍ (ما يدل على تسرب اتصال محتمل أو استعلام بطيء)."},
    {"id": "4", "description": "اكتب اختبارًا قائمًا على Testcontainers يحاكي انقسام شبكة بين خدمة الدفع وقاعدة بياناتها، ويتحقق من أن الخدمة تعيد PaymentServiceUnavailableException ضمن المهلة المضبوطة، ويؤكد إعادة إنشاء الاتصالات بعد التئام الانقسام."}
  ]
}
-->
