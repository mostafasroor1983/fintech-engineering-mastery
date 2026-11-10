---
id: track-09-lesson-13
title: "HTTP/2 and gRPC Performance — Connection Multiplexing"
slug: http2-grpc-performance
track: track-09
trackName: "Performance Engineering"
sequence: 13
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [HTTP2, gRPC, multiplexing, stream, header-compression]
prerequisites: []
---

# HTTP/2 and gRPC Performance — Connection Multiplexing

> [!NOTE]
> HTTP/2 multiplexing eliminates head-of-line blocking at the HTTP layer, allowing payment gateways to process hundreds of concurrent requests over a single TCP connection. Combined with gRPC's Protocol Buffers serialization, this yields 2–10x throughput improvements over REST/HTTP/1.1 for high-volume financial transaction streams.

## Why HTTP/2 Matters for Financial Systems

Payment processing platforms face a constant tension: low-latency individual transactions AND high-throughput batch operations. HTTP/1.1 forces a choice — either open many connections (expensive) or pipeline requests (fragile). HTTP/2 dissolves this tension through true multiplexing.

Consider a payment gateway calling three downstream services — fraud detection, limit checking, and ledger reservation — to authorize a single payment. Under HTTP/1.1, these calls either happen sequentially (slow) or require three separate TCP connections (resource-intensive). Under HTTP/2, all three requests share one connection with no head-of-line blocking.

### HTTP/1.1 vs HTTP/2: The Core Differences

| Feature | HTTP/1.1 | HTTP/2 |
|---------|----------|--------|
| Multiplexing | No (1 request per connection) | Yes (N streams per connection) |
| Header compression | None (plaintext, repeated) | HPACK (delta encoding) |
| Server push | No | Yes |
| Binary framing | No (text) | Yes |
| Stream priority | No | Yes |
| Head-of-line blocking | Yes (per connection) | No (per stream only) |

For a payment API that sends `Authorization: Bearer <256-char-token>` with every request, HPACK compression alone reduces header overhead by ~85% after the first request — the server and client maintain a shared header table, and subsequent requests send only changed headers.

---

## HTTP/2 Multiplexing Deep Dive

HTTP/2 breaks messages into **frames** (DATA, HEADERS, SETTINGS, WINDOW_UPDATE, etc.) and interleaves them across **streams**. Each stream has an odd integer ID (client-initiated) or even integer ID (server-initiated).

```
Connection (single TCP socket)
├── Stream 1: POST /payments/authorize  (frames interleaved)
├── Stream 3: POST /fraud/check         (frames interleaved)
├── Stream 5: GET  /accounts/balance    (frames interleaved)
└── Stream 7: POST /limits/validate     (frames interleaved)
```

The connection-level flow control window and per-stream flow control window allow backpressure without blocking other streams.

### Demonstrating HTTP/2 with Java HttpClient

Java 11+ includes a native HTTP/2 client. Here is how a payment authorization service uses it:

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;

@Service
public class PaymentAuthorizationService {

    private final HttpClient http2Client;
    private final ObjectMapper objectMapper;

    public PaymentAuthorizationService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        // HTTP/2 client — shared instance, one TCP connection per host
        this.http2Client = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_2)          // prefer HTTP/2
            .connectTimeout(Duration.ofMillis(500))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .executor(Executors.newVirtualThreadPerTaskExecutor()) // Java 21
            .build();
    }

    /**
     * Fan-out authorization checks using HTTP/2 multiplexing.
     * All three requests share ONE TCP connection to the gateway.
     * Total latency = max(fraud, limits, ledger), not sum.
     */
    public AuthorizationResult authorize(PaymentRequest payment) {
        String fraudUrl  = "https://fraud.internal/check";
        String limitsUrl = "https://limits.internal/validate";
        String ledgerUrl = "https://ledger.internal/reserve";

        String body;
        try {
            body = objectMapper.writeValueAsString(payment);
        } catch (JsonProcessingException e) {
            throw new PaymentException("Serialization failed", e);
        }

        HttpRequest fraudReq  = buildRequest(fraudUrl, body);
        HttpRequest limitsReq = buildRequest(limitsUrl, body);
        HttpRequest ledgerReq = buildRequest(ledgerUrl, body);

        // All three are sent over the same HTTP/2 connection — no blocking
        CompletableFuture<HttpResponse<String>> fraudFuture =
            http2Client.sendAsync(fraudReq, HttpResponse.BodyHandlers.ofString());
        CompletableFuture<HttpResponse<String>> limitsFuture =
            http2Client.sendAsync(limitsReq, HttpResponse.BodyHandlers.ofString());
        CompletableFuture<HttpResponse<String>> ledgerFuture =
            http2Client.sendAsync(ledgerReq, HttpResponse.BodyHandlers.ofString());

        return CompletableFuture.allOf(fraudFuture, limitsFuture, ledgerFuture)
            .thenApply(v -> {
                FraudResult  fraud  = parse(fraudFuture.join(),  FraudResult.class);
                LimitsResult limits = parse(limitsFuture.join(), LimitsResult.class);
                LedgerResult ledger = parse(ledgerFuture.join(), LedgerResult.class);
                return new AuthorizationResult(fraud, limits, ledger);
            })
            .join();
    }

    private HttpRequest buildRequest(String url, String body) {
        return HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofMillis(2000))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + getServiceToken())
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
    }

    private <T> T parse(HttpResponse<String> response, Class<T> type) {
        if (response.statusCode() != 200) {
            throw new DownstreamException("HTTP " + response.statusCode());
        }
        try {
            return objectMapper.readValue(response.body(), type);
        } catch (JsonProcessingException e) {
            throw new PaymentException("Deserialization failed", e);
        }
    }
}
```

---

## HPACK Header Compression

HPACK maintains a **dynamic table** of recently sent headers on both client and server. Subsequent requests reference entries by index rather than resending full header strings.

For payment APIs, the savings are dramatic:

```
First request headers (sent in full):
  :method: POST                    →  7 bytes
  :path: /v1/payments/authorize    → 25 bytes
  :scheme: https                   →  8 bytes
  :authority: api.payments.com     → 24 bytes
  content-type: application/json   → 32 bytes
  authorization: Bearer eyJhbG...  → 280 bytes
  x-correlation-id: abc-123        → 28 bytes
  Total: ~404 bytes

Second request headers (HPACK delta — only changed fields):
  :path: /v1/payments/authorize    → index ref: 2 bytes (cached)
  authorization: Bearer eyJhbG...  → index ref: 2 bytes (cached)
  x-correlation-id: def-456        → 28 bytes (new value)
  Total: ~32 bytes  (92% reduction)
```

---

## gRPC — Protocol Buffers over HTTP/2

gRPC builds on HTTP/2 and replaces JSON with Protocol Buffers — a binary, schema-defined serialization format. For financial data this means:

- **Smaller payloads**: A payment message with 20 fields serializes to ~80 bytes in protobuf vs ~400 bytes in JSON
- **Faster serialization**: Binary encoding/decoding is 5–10x faster than JSON parsing
- **Strong typing**: Schema enforced at compile time — no runtime type errors from missing fields
- **Streaming**: Native support for server streaming, client streaming, and bidirectional streaming

### Payment Service Proto Definition

```protobuf
// payment.proto
syntax = "proto3";

package com.fintech.payments.v1;

option java_package = "com.fintech.payments.grpc";
option java_multiple_files = true;

service PaymentService {
  // Unary RPC: single payment authorization
  rpc AuthorizePayment(AuthorizeRequest) returns (AuthorizeResponse);

  // Server streaming: real-time transaction feed
  rpc StreamTransactions(TransactionFeedRequest) returns (stream Transaction);

  // Client streaming: bulk payment submission
  rpc SubmitBulkPayments(stream PaymentRequest) returns (BulkSubmitResponse);

  // Bidirectional streaming: real-time processing pipeline
  rpc ProcessPaymentStream(stream PaymentRequest) returns (stream PaymentResult);
}

message AuthorizeRequest {
  string payment_id          = 1;
  string account_id          = 2;
  int64  amount_minor_units  = 3;   // e.g. 10050 = $100.50
  string currency_code       = 4;   // ISO 4217: "USD", "EUR"
  string merchant_id         = 5;
  PaymentMethod payment_method = 6;
  repeated string risk_flags = 7;
}

message AuthorizeResponse {
  string               authorization_code    = 1;
  AuthorizationStatus  status                = 2;
  int64                authorized_amount     = 3;
  string               decline_reason        = 4;
  int64                processing_time_nanos = 5;
}

message Transaction {
  string            transaction_id         = 1;
  string            account_id             = 2;
  TransactionType   type                   = 3;
  int64             amount_minor_units      = 4;
  string            currency_code          = 5;
  int64             timestamp_epoch_millis  = 6;
  TransactionStatus status                 = 7;
  string            merchant_name          = 8;
  string            merchant_category_code = 9;
}

message TransactionFeedRequest {
  string account_id      = 1;
  int64  from_timestamp  = 2;
  int32  max_transactions = 3;
  bool   include_pending = 4;
}

message PaymentRequest {
  string idempotency_key     = 1;  // critical for financial operations
  string from_account        = 2;
  string to_account          = 3;
  int64  amount_minor_units  = 4;
  string currency_code       = 5;
  string reference           = 6;
}

message BulkSubmitResponse {
  int32             submitted_count            = 1;
  int32             accepted_count             = 2;
  int32             rejected_count             = 3;
  repeated string   rejected_idempotency_keys  = 4;
}

enum AuthorizationStatus { AUTHORIZED = 0; DECLINED = 1; PENDING = 2; ERROR = 3; }
enum PaymentStatus       { PAYMENT_PENDING = 0; PAYMENT_PROCESSING = 1;
                           PAYMENT_COMPLETED = 2; PAYMENT_FAILED = 3; }
enum TransactionType     { DEBIT = 0; CREDIT = 1; REVERSAL = 2; FEE = 3; }
enum TransactionStatus   { POSTED = 0; PENDING_TX = 1; DECLINED_TX = 2; }
enum PaymentMethod       { CARD = 0; ACH = 1; WIRE = 2; RTP = 3; }
```

### Spring Boot gRPC Server Implementation

```java
// spring-grpc-spring-boot-starter + protobuf-java + grpc-stub

@GrpcService
@Slf4j
public class PaymentGrpcService extends PaymentServiceGrpc.PaymentServiceImplBase {

    private final PaymentAuthorizationEngine authEngine;
    private final TransactionRepository      transactionRepo;
    private final BulkPaymentProcessor       bulkProcessor;
    private final MeterRegistry              meterRegistry;

    // ── Unary RPC ─────────────────────────────────────────────────────────

    @Override
    public void authorizePayment(
            AuthorizeRequest request,
            StreamObserver<AuthorizeResponse> responseObserver) {

        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            validateAuthRequest(request);

            AuthorizationDecision decision = authEngine.authorize(
                request.getPaymentId(),
                request.getAccountId(),
                request.getAmountMinorUnits(),
                request.getCurrencyCode(),
                request.getMerchantId()
            );

            AuthorizeResponse response = AuthorizeResponse.newBuilder()
                .setAuthorizationCode(decision.getCode())
                .setStatus(mapStatus(decision.getStatus()))
                .setAuthorizedAmount(decision.getAuthorizedAmount())
                .setDeclineReason(
                    decision.getDeclineReason() != null ? decision.getDeclineReason() : "")
                .setProcessingTimeNanos(decision.getProcessingNanos())
                .build();

            responseObserver.onNext(response);
            responseObserver.onCompleted();
            sample.stop(meterRegistry.timer("grpc.authorize",
                "status", decision.getStatus().name()));

        } catch (ValidationException e) {
            responseObserver.onError(
                Status.INVALID_ARGUMENT.withDescription(e.getMessage()).asRuntimeException());
        } catch (Exception e) {
            log.error("Authorization failed for payment {}", request.getPaymentId(), e);
            responseObserver.onError(
                Status.INTERNAL.withDescription("Authorization processing failed")
                    .asRuntimeException());
        }
    }

    // ── Server Streaming: Real-Time Transaction Feed ───────────────────────

    @Override
    public void streamTransactions(
            TransactionFeedRequest request,
            StreamObserver<Transaction> responseObserver) {

        log.debug("Starting transaction stream for account: {}", request.getAccountId());
        ServerCallStreamObserver<Transaction> serverObserver =
            (ServerCallStreamObserver<Transaction>) responseObserver;

        try {
            long limit = request.getMaxTransactions() > 0
                ? request.getMaxTransactions() : Long.MAX_VALUE;

            // Stream from DB cursor — no bulk memory load
            transactionRepo.streamByAccount(
                    request.getAccountId(),
                    request.getFromTimestamp(),
                    request.getIncludePending())
                .limit(limit)
                .forEach(tx -> {
                    if (serverObserver.isCancelled()) return;  // client disconnected

                    responseObserver.onNext(Transaction.newBuilder()
                        .setTransactionId(tx.getId())
                        .setAccountId(tx.getAccountId())
                        .setType(mapTransactionType(tx.getType()))
                        .setAmountMinorUnits(tx.getAmountMinorUnits())
                        .setCurrencyCode(tx.getCurrencyCode())
                        .setTimestampEpochMillis(tx.getTimestamp().toEpochMilli())
                        .setStatus(mapTransactionStatus(tx.getStatus()))
                        .setMerchantName(tx.getMerchantName() != null ? tx.getMerchantName() : "")
                        .build());
                });

            responseObserver.onCompleted();

        } catch (AccountNotFoundException e) {
            responseObserver.onError(
                Status.NOT_FOUND
                    .withDescription("Account not found: " + request.getAccountId())
                    .asRuntimeException());
        }
    }

    // ── Client Streaming: Bulk Payment Submission ──────────────────────────

    @Override
    public StreamObserver<PaymentRequest> submitBulkPayments(
            StreamObserver<BulkSubmitResponse> responseObserver) {

        List<PaymentRequest> buffer  = new ArrayList<>();
        AtomicInteger        received = new AtomicInteger(0);
        BulkSubmitResult     aggregate = new BulkSubmitResult();

        return new StreamObserver<>() {
            @Override
            public void onNext(PaymentRequest req) {
                received.incrementAndGet();
                if (req.getIdempotencyKey().isEmpty()) {
                    responseObserver.onError(Status.INVALID_ARGUMENT
                        .withDescription("idempotency_key required").asRuntimeException());
                    return;
                }
                buffer.add(req);
                if (buffer.size() >= 1000) {   // process in chunks
                    aggregate.merge(bulkProcessor.processBatch(new ArrayList<>(buffer)));
                    buffer.clear();
                }
            }

            @Override
            public void onError(Throwable t) {
                log.error("Bulk stream error after {} payments", received.get(), t);
            }

            @Override
            public void onCompleted() {
                if (!buffer.isEmpty()) {
                    aggregate.merge(bulkProcessor.processBatch(buffer));
                }
                responseObserver.onNext(BulkSubmitResponse.newBuilder()
                    .setSubmittedCount(received.get())
                    .setAcceptedCount(aggregate.getAccepted())
                    .setRejectedCount(aggregate.getRejected())
                    .addAllRejectedIdempotencyKeys(aggregate.getRejectedKeys())
                    .build());
                responseObserver.onCompleted();
            }
        };
    }

    private void validateAuthRequest(AuthorizeRequest r) {
        if (r.getPaymentId().isEmpty())     throw new ValidationException("payment_id required");
        if (r.getAccountId().isEmpty())     throw new ValidationException("account_id required");
        if (r.getAmountMinorUnits() <= 0)   throw new ValidationException("amount must be positive");
        if (r.getCurrencyCode().length() != 3) throw new ValidationException("invalid currency_code");
    }
}
```

---

## gRPC Spring Boot Configuration

```yaml
# application.yml
spring:
  grpc:
    server:
      port: 9090
      max-inbound-message-size: 10MB
      keepalive:
        time: 30s
        timeout: 10s
        permit-keep-alive-without-calls: true
    client:
      payment-service:
        address: static://payments-grpc.internal:9090
        negotiation-type: TLS
        keep-alive-time: 30s
        keep-alive-timeout: 10s
```

```java
@Configuration
public class GrpcClientConfig {

    @Bean
    public PaymentServiceGrpc.PaymentServiceBlockingStub blockingStub(
            @GrpcClient("payment-service") Channel channel) {
        return PaymentServiceGrpc.newBlockingStub(channel)
            .withDeadlineAfter(2000, TimeUnit.MILLISECONDS)
            .withCompression("gzip");
    }

    @Bean
    public PaymentServiceGrpc.PaymentServiceStub asyncStub(
            @GrpcClient("payment-service") Channel channel) {
        return PaymentServiceGrpc.newStub(channel)
            .withDeadlineAfter(30_000, TimeUnit.MILLISECONDS);
    }
}
```

---

## gRPC vs REST Performance — JMH Benchmarks

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@State(Scope.Benchmark)
@Fork(value = 2, jvmArgs = {"-Xms2g", "-Xmx2g"})
@Warmup(iterations = 5, time = 10)
@Measurement(iterations = 10, time = 10)
public class GrpcVsRestBenchmark {

    private PaymentServiceGrpc.PaymentServiceBlockingStub grpcStub;
    private WebClient  restClient;
    private AuthorizeRequest grpcRequest;
    private PaymentAuthorizationDto restRequest;

    @Setup
    public void setup() {
        ManagedChannel channel = ManagedChannelBuilder
            .forAddress("localhost", 9090)
            .usePlaintext()
            .build();
        grpcStub = PaymentServiceGrpc.newBlockingStub(channel);

        restClient = WebClient.builder()
            .baseUrl("http://localhost:8080")
            .build();

        grpcRequest = AuthorizeRequest.newBuilder()
            .setPaymentId(UUID.randomUUID().toString())
            .setAccountId("ACC-001")
            .setAmountMinorUnits(10050L)
            .setCurrencyCode("USD")
            .setMerchantId("MERCH-001")
            .build();

        restRequest = new PaymentAuthorizationDto(
            UUID.randomUUID().toString(), "ACC-001", 10050L, "USD", "MERCH-001");
    }

    @Benchmark
    public AuthorizeResponse grpcAuthorize() {
        return grpcStub.authorizePayment(grpcRequest);
    }

    @Benchmark
    public AuthorizationResponseDto restAuthorize() {
        return restClient.post()
            .uri("/v1/payments/authorize")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(restRequest)
            .retrieve()
            .bodyToMono(AuthorizationResponseDto.class)
            .block();
    }
}
```

Typical benchmark results on an authorization workload (loopback, no network jitter):

```
Benchmark                           Mode  Cnt      Score     Error  Units
GrpcVsRestBenchmark.grpcAuthorize  thrpt   20  12847.3 ± 234.1  ops/s
GrpcVsRestBenchmark.restAuthorize  thrpt   20   4231.8 ± 189.3  ops/s

Improvement: gRPC delivers ~3x higher throughput
Drivers:
  1. Binary protobuf serialization vs JSON text parsing
  2. HTTP/2 single-connection multiplexing vs HTTP/1.1 keep-alive
  3. Header delta encoding (HPACK) vs full text headers
  4. Smaller wire payload (82 bytes vs 420 bytes for auth request)
```

---

## Connection Reuse for Payment Gateways

```java
@Configuration
public class PaymentGatewayChannelConfig {

    /**
     * Single ManagedChannel shared by all threads.
     * HTTP/2 multiplexing handles concurrency internally.
     * Never create a channel per request — startup cost is 100-200ms.
     */
    @Bean(destroyMethod = "shutdown")
    public ManagedChannel visaGatewayChannel(
            @Value("${visa.gateway.host}") String host,
            @Value("${visa.gateway.port}") int port) {

        // Service config with retry policy (gRPC server-side retry)
        Map<String, Object> retryPolicy = Map.of(
            "maxAttempts", 3.0,
            "initialBackoff", "0.1s",
            "maxBackoff", "1s",
            "backoffMultiplier", 2.0,
            "retryableStatusCodes", List.of("UNAVAILABLE", "RESOURCE_EXHAUSTED")
        );
        Map<String, Object> serviceConfig = Map.of(
            "methodConfig", List.of(Map.of(
                "name", List.of(Map.of("service", "com.visa.gateway.PaymentService")),
                "retryPolicy", retryPolicy,
                "timeout", "2.5s"
            ))
        );

        return NettyChannelBuilder.forAddress(host, port)
            .sslContext(buildMtlsContext())          // mutual TLS to gateway
            .keepAliveTime(60, TimeUnit.SECONDS)     // prevent NAT timeout
            .keepAliveTimeout(10, TimeUnit.SECONDS)
            .keepAliveWithoutCalls(true)             // maintain idle connections
            .maxInboundMessageSize(1 * 1024 * 1024)
            .defaultServiceConfig(serviceConfig)
            .enableRetry()
            .flowControlWindow(1024 * 1024)          // 1MB per-stream flow window
            .build();
    }

    private SslContext buildMtlsContext() {
        try {
            return GrpcSslContexts.forClient()
                .trustManager(new File("/certs/visa-ca.pem"))
                .keyManager(
                    new File("/certs/client-cert.pem"),
                    new File("/certs/client-key.pem"))
                .build();
        } catch (SSLException e) {
            throw new BeanCreationException("SSL context build failed", e);
        }
    }
}
```

---

## gRPC Interceptor for Audit Logging

Financial services require every RPC call to be logged for regulatory compliance:

```java
@Component
public class PaymentGrpcAuditInterceptor implements ServerInterceptor {

    private final MeterRegistry meterRegistry;
    private final AuditLogger   auditLogger;

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String method = call.getMethodDescriptor().getBareMethodName();
        String correlationId = Optional.ofNullable(
            headers.get(Metadata.Key.of("x-correlation-id",
                Metadata.ASCII_STRING_MARSHALLER)))
            .orElse(UUID.randomUUID().toString());

        MDC.put("correlationId", correlationId);
        MDC.put("grpcMethod", method);

        long startNanos = System.nanoTime();

        return next.startCall(
            new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                @Override
                public void close(Status status, Metadata trailers) {
                    long durationNanos = System.nanoTime() - startNanos;

                    meterRegistry.timer("grpc.server.duration",
                        "method", method,
                        "status", status.getCode().name())
                        .record(durationNanos, TimeUnit.NANOSECONDS);

                    auditLogger.logGrpcCall(
                        method, correlationId, status.getCode(), durationNanos);
                    MDC.clear();
                    super.close(status, trailers);
                }
            }, headers);
    }
}
```

---

## Performance Comparison Summary

For a payment processing API handling 10,000 concurrent requests:

| Metric | HTTP/1.1 + JSON | HTTP/2 + JSON | HTTP/2 + gRPC (Protobuf) |
|--------|----------------|---------------|--------------------------|
| TCP connections needed | 10,000 | ~100 | ~100 |
| Auth request payload | 420 bytes | 420 B (1st) / 36 B (2nd+) | 82 bytes |
| Serialization time | 1.2 µs | 1.2 µs | 0.18 µs |
| p50 latency | 45 ms | 22 ms | 8 ms |
| p99 latency | 380 ms | 95 ms | 31 ms |
| Max throughput (1 node) | 4,200 req/s | 9,800 req/s | 28,500 req/s |
| Memory (conn overhead) | 2.4 GB | 48 MB | 48 MB |

---

## Key Takeaways for Financial Engineers

1. **HTTP/2 multiplexing** eliminates connection-per-request bottleneck — critical for fan-out authorization patterns calling fraud, limits, and ledger services simultaneously
2. **HPACK compression** provides 85–95% header size reduction on repeat API calls with stable headers such as auth tokens and content-type
3. **gRPC + Protocol Buffers** delivers 3–7x throughput improvement over REST/JSON for high-frequency payment authorization
4. **Server streaming** is ideal for real-time transaction feeds — push 50,000 transactions over one gRPC connection vs 50,000 separate HTTP calls
5. **Client streaming** handles bulk payment file uploads efficiently — submit 100,000 payments in a single stream with backpressure via flow control
6. **Connection reuse** is mandatory — a single ManagedChannel with HTTP/2 handles thousands of concurrent RPCs; creating a channel per request adds 100–200ms of TLS handshake overhead
7. **Keepalive settings** prevent silent connection drops from load balancers and NAT devices that sit between your service and payment networks

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What problem does HTTP/2 multiplexing solve that HTTP/1.1 cannot, and why is it critical for payment authorization fan-out?",
      "options": [
        "HTTP/2 compresses request bodies; HTTP/1.1 sends them uncompressed",
        "HTTP/2 allows multiple concurrent request/response streams over a single TCP connection, eliminating the need for a separate connection per concurrent request and removing head-of-line blocking at the HTTP layer",
        "HTTP/2 supports binary framing which reduces CPU usage on the server",
        "HTTP/2 enables server-push to pre-send fraud scores before the client requests them"
      ],
      "correct": 1,
      "explanation": "HTTP/1.1 requires one TCP connection per concurrent request (or uses connection pooling with pipelining that suffers head-of-line blocking). A payment authorization fan-out calling fraud, limits, and ledger services simultaneously would need 3+ connections per request. HTTP/2 multiplexes all 3 concurrent requests over one TCP connection, reducing connection overhead from thousands to ~100 for 10,000 concurrent requests."
    },
    {
      "text": "Why should a gRPC ManagedChannel be a singleton shared across all threads rather than created per-request?",
      "options": [
        "ManagedChannel is not thread-safe and must be synchronized externally if shared",
        "Creating a channel per request incurs 100-200ms of TLS handshake overhead on each call; HTTP/2 multiplexing handles concurrency internally within a single channel",
        "gRPC limits the number of channels per JVM process to 10",
        "Per-request channels prevent proper Protobuf message serialization"
      ],
      "correct": 1,
      "explanation": "Each ManagedChannel creation involves a TCP connection and full TLS handshake, which typically takes 100-200ms. Creating a channel per payment authorization request would add this overhead to every transaction. A single shared ManagedChannel uses HTTP/2 stream multiplexing to handle thousands of concurrent RPCs over one connection."
    },
    {
      "text": "What payload size advantage does Protocol Buffers provide over JSON for a typical payment authorization request, and why does this matter at scale?",
      "options": [
        "Protobuf is about 10% smaller than JSON; the difference is negligible at any scale",
        "A typical auth request shrinks from ~420 bytes in JSON to ~82 bytes in Protobuf (5x reduction), reducing bandwidth costs and serialization CPU time, which matters significantly at 10,000+ TPS",
        "Protobuf only compresses repeated fields; single-value requests are the same size as JSON",
        "Protobuf requires base64 encoding for binary fields, making it larger than JSON in practice"
      ],
      "correct": 1,
      "explanation": "Protocol Buffers use binary encoding with field numbers instead of string field names, varint encoding for integers, and no quotes or delimiters. A payment authorization message with 15-20 fields typically shrinks 3-7x compared to JSON. At 100,000 TPS, this reduces network bandwidth by gigabits per second and reduces serialization CPU overhead."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "gRPC Payment Authorization Service with mTLS and Audit Logging",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Define a PaymentAuthorization.proto with request/response messages and a PaymentGateway service with Authorize (unary) and StreamTransactions (server streaming) RPCs."},
    {"id": "2", "description": "Implement the gRPC server with a ServerInterceptor that logs all RPC calls for regulatory compliance, recording method name, correlation ID, status code, and duration in a structured format."},
    {"id": "3", "description": "Configure a singleton ManagedChannel with mTLS, keepalive settings, retry policy for UNAVAILABLE status, and 2.5s timeout — shared across all threads in the payment service."},
    {"id": "4", "description": "Write a JMH benchmark comparing throughput and latency for the same payment authorization payload using HTTP/1.1 + JSON, HTTP/2 + JSON, and HTTP/2 + gRPC (Protobuf) with 100 concurrent threads."}
  ]
}
-->

