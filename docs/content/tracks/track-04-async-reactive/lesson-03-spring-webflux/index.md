---
id: track-04-lesson-03
title: "Spring WebFlux — Non-Blocking Web Services"
slug: spring-webflux
track: track-04
trackName: Async & Reactive Systems
sequence: 3
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [WebFlux, Netty, RouterFunction, non-blocking, reactive-web]
prerequisites: []
---

# Spring WebFlux — Non-Blocking Web Services

> [!NOTE]
> Spring WebFlux is the reactive web framework in Spring 5+. Built on Project Reactor and running on Netty by default, it allows financial services to handle tens of thousands of concurrent payment requests with a fixed pool of event-loop threads. The key shift is from thread-per-request blocking I/O to event-driven non-blocking I/O.

## WebFlux vs Spring MVC — When to Use Which

Before adopting WebFlux, understand the trade-offs. WebFlux is not a universal upgrade — it is a different programming model with different strengths.

| Concern | Spring MVC | Spring WebFlux |
|---------|-----------|----------------|
| Execution model | Thread-per-request (blocking) | Event-loop (non-blocking) |
| Server default | Tomcat | Netty |
| Concurrency | 200–500 threads | 2× CPU core threads |
| I/O model | Blocking (JDBC, RestTemplate) | Non-blocking (R2DBC, WebClient) |
| Debugging | Stack traces are linear | Stack traces are fragmented |
| Learning curve | Low | High |
| Best for | CRUD services with blocking DB | High-concurrency, streaming, low-latency |

For a payment gateway receiving 10,000 concurrent enrichment callbacks, WebFlux is the right choice. For an internal admin tool that runs 5 requests per second against a PostgreSQL database with JDBC, Spring MVC is simpler and equally performant.

**Use WebFlux when:**
- You have high concurrency and I/O-bound workloads (payment processing, FX aggregation)
- You need streaming responses (SSE, WebSocket for live market data)
- All your downstream dependencies support non-blocking clients (R2DBC, WebClient, Reactor Kafka)
- You are building a reactive pipeline where back-pressure needs to propagate end-to-end

**Stay with MVC when:**
- You have blocking dependencies you cannot replace (legacy JDBC, synchronous SDKs)
- The team is not familiar with reactive patterns — debugging reactive code is harder
- Latency requirements are moderate and load is not extreme

---

## Netty Event Loop Architecture

Understanding Netty's threading model is essential for writing correct WebFlux code.

```
                   ┌─────────────────────────────────────┐
                   │            Netty Boss Group          │
                   │  (1 thread — accepts connections)    │
                   └──────────────────┬──────────────────┘
                                      │ accepted connections
                   ┌──────────────────▼──────────────────┐
                   │           Netty Worker Group         │
                   │  (N threads, default: 2×CPU cores)  │
                   │                                      │
                   │  Thread 1: handles connections 1,5,9 │
                   │  Thread 2: handles connections 2,6,10│
                   │  Thread N: handles connections N,... │
                   └──────────────────────────────────────┘
```

Each worker thread runs an **event loop** — an infinite loop that polls for I/O events and dispatches them to handlers. The critical rule: **never block an event-loop thread**. Blocking a worker thread starves all connections assigned to it.

```java
// This configuration exposes the threading model
@Configuration
public class NettyConfiguration {

    @Bean
    public ReactiveWebServerFactory reactiveWebServerFactory() {
        NettyReactiveWebServerFactory factory = new NettyReactiveWebServerFactory();
        factory.addServerCustomizers(httpServer ->
            httpServer
                .runOn(LoopResources.create(
                    "payment-loop",
                    2,                               // boss threads
                    Runtime.getRuntime().availableProcessors() * 2, // worker threads
                    true                             // daemon threads
                ))
                .option(ChannelOption.SO_BACKLOG, 1024)
                .childOption(ChannelOption.SO_KEEPALIVE, true)
                .childOption(ChannelOption.TCP_NODELAY, true)
                .metrics(true, Function.identity())
        );
        return factory;
    }
}
```

---

## @RestController in WebFlux

Spring WebFlux supports the annotation-based `@RestController` model familiar from Spring MVC. The difference is in the return types: handlers return `Mono<T>` or `Flux<T>` instead of plain objects.

```java
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import java.math.BigDecimal;
import java.time.Duration;

@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    private final PaymentService paymentService;
    private final LedgerService ledgerService;

    // GET — returns a single payment
    @GetMapping("/{paymentId}")
    public Mono<ResponseEntity<PaymentResponse>> getPayment(
            @PathVariable String paymentId) {
        return paymentService.findById(paymentId)
            .map(payment -> ResponseEntity.ok(PaymentResponse.from(payment)))
            .defaultIfEmpty(ResponseEntity.notFound().build());
    }

    // POST — submit a payment, returns 202 Accepted with location header
    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Mono<ResponseEntity<PaymentSubmissionResponse>> submitPayment(
            @RequestBody @Valid Mono<PaymentRequest> requestMono,
            ServerWebExchange exchange) {
        return requestMono
            .flatMap(request -> paymentService.submit(
                request,
                extractCorrelationId(exchange)))
            .map(result -> ResponseEntity
                .accepted()
                .location(URI.create("/api/v1/payments/" + result.getPaymentId()))
                .body(PaymentSubmissionResponse.from(result)));
    }

    // GET streaming — SSE stream of real-time transaction events
    // Content-Type: text/event-stream
    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<TransactionEvent>> streamTransactions(
            @RequestParam(defaultValue = "USD") String currency) {
        return transactionEventService.streamByCurrency(currency)
            .map(event -> ServerSentEvent.<TransactionEvent>builder()
                .id(event.getId())
                .event("transaction")
                .data(event)
                .build())
            .timeout(Duration.ofMinutes(30)); // close idle streams after 30 min
    }

    // GET — return a Flux as a JSON array (buffered in response body)
    @GetMapping("/account/{accountId}/history")
    public Flux<TransactionSummary> getTransactionHistory(
            @PathVariable String accountId,
            @RequestParam(defaultValue = "50") int limit) {
        return ledgerService.getHistory(accountId)
            .take(limit);
    }

    // DELETE — idempotent cancellation
    @DeleteMapping("/{paymentId}")
    public Mono<ResponseEntity<Void>> cancelPayment(
            @PathVariable String paymentId) {
        return paymentService.cancel(paymentId)
            .then(Mono.just(ResponseEntity.<Void>noContent().build()))
            .onErrorResume(PaymentNotFoundException.class,
                ex -> Mono.just(ResponseEntity.<Void>notFound().build()))
            .onErrorResume(PaymentNotCancellableException.class,
                ex -> Mono.just(ResponseEntity.<Void>unprocessableEntity().build()));
    }

    private String extractCorrelationId(ServerWebExchange exchange) {
        return exchange.getRequest().getHeaders()
            .getFirst("X-Correlation-ID");
    }
}
```

---

## RouterFunction / HandlerFunction — Functional Web Model

The functional model is an alternative to `@RestController` that makes routing explicit and composable. It is preferable for complex routing logic or when you want to avoid annotation scanning.

```java
import org.springframework.web.reactive.function.server.*;
import reactor.core.publisher.Mono;

// HandlerFunction — handles a single request type
@Component
public class PaymentHandler {

    private final PaymentService paymentService;
    private final PaymentRequestValidator validator;

    public Mono<ServerResponse> getPayment(ServerRequest request) {
        String paymentId = request.pathVariable("paymentId");
        return paymentService.findById(paymentId)
            .flatMap(payment ->
                ServerResponse.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue(PaymentResponse.from(payment)))
            .switchIfEmpty(
                ServerResponse.notFound().build());
    }

    public Mono<ServerResponse> submitPayment(ServerRequest request) {
        return request.bodyToMono(PaymentRequest.class)
            .flatMap(validator::validate)
            .flatMap(paymentService::submit)
            .flatMap(result ->
                ServerResponse.accepted()
                    .location(URI.create("/api/v1/payments/" + result.getPaymentId()))
                    .bodyValue(PaymentSubmissionResponse.from(result)))
            .onErrorResume(ValidationException.class, ex ->
                ServerResponse.badRequest()
                    .bodyValue(ErrorResponse.from(ex)));
    }

    public Mono<ServerResponse> streamAccountTransactions(ServerRequest request) {
        String accountId = request.pathVariable("accountId");
        return ServerResponse.ok()
            .contentType(MediaType.TEXT_EVENT_STREAM_VALUE_TYPE)
            .body(transactionService.streamForAccount(accountId), Transaction.class);
    }
}

// RouterFunction — wires URLs to handlers
@Configuration
public class PaymentRouterConfiguration {

    @Bean
    public RouterFunction<ServerResponse> paymentRoutes(PaymentHandler handler) {
        return RouterFunctions.route()
            .nest(RequestPredicates.path("/api/v1/payments"), builder -> builder
                .GET("/{paymentId}", handler::getPayment)
                .POST("", handler::submitPayment)
                .GET("/{accountId}/stream", handler::streamAccountTransactions)
                .filter(this::authorizationFilter)  // per-route filter
            )
            .build();
    }

    // Inline filter — applied only to routes in this nest
    private Mono<ServerResponse> authorizationFilter(
            ServerRequest request,
            HandlerFunction<ServerResponse> next) {
        return ReactiveSecurityContextHolder.getContext()
            .map(SecurityContext::getAuthentication)
            .filter(Authentication::isAuthenticated)
            .flatMap(auth -> next.handle(request))
            .switchIfEmpty(ServerResponse.status(HttpStatus.UNAUTHORIZED).build());
    }
}
```

---

## WebClient — Non-Blocking HTTP

`WebClient` replaces `RestTemplate` in reactive stacks. It is non-blocking, supports streaming, and integrates naturally with Reactor's error handling.

```java
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;

@Configuration
public class WebClientConfiguration {

    @Bean
    public WebClient fraudServiceClient(WebClient.Builder builder) {
        return builder
            .baseUrl("https://fraud-service.internal:8443")
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
            .codecs(config ->
                config.defaultCodecs().maxInMemorySize(2 * 1024 * 1024)) // 2MB
            .filter(loggingFilter())
            .filter(retryFilter())
            .filter(metricsFilter())
            .build();
    }

    private ExchangeFilterFunction loggingFilter() {
        return ExchangeFilterFunction.ofRequestProcessor(request -> {
            log.debug("WebClient request: {} {}", request.method(), request.url());
            return Mono.just(request);
        });
    }

    private ExchangeFilterFunction metricsFilter() {
        return (request, next) -> {
            long start = System.nanoTime();
            return next.exchange(request)
                .doOnNext(response ->
                    metrics.timer("http.client.request")
                        .tag("uri", request.url().getPath())
                        .tag("status", String.valueOf(response.statusCode().value()))
                        .record(System.nanoTime() - start, TimeUnit.NANOSECONDS));
        };
    }
}

@Service
public class FraudServiceClient {

    private final WebClient webClient;

    // Simple GET — returns Mono<FraudScore>
    public Mono<FraudScore> checkPayment(Payment payment) {
        return webClient.post()
            .uri("/v2/check")
            .bodyValue(FraudCheckRequest.from(payment))
            .retrieve()
            .onStatus(HttpStatus::is4xxClientError, response ->
                response.bodyToMono(FraudErrorResponse.class)
                    .flatMap(err -> Mono.error(
                        new FraudServiceClientException(err.getCode(), err.getMessage()))))
            .onStatus(HttpStatus::is5xxServerError, response ->
                Mono.error(new FraudServiceUnavailableException("Fraud service 5xx")))
            .bodyToMono(FraudScore.class)
            .timeout(Duration.ofSeconds(2))
            .retryWhen(
                Retry.backoff(2, Duration.ofMillis(100))
                    .filter(ex -> ex instanceof FraudServiceUnavailableException));
    }

    // Streaming GET — returns Flux<TransactionAlert>
    public Flux<TransactionAlert> streamAlerts(String merchantId) {
        return webClient.get()
            .uri(uriBuilder -> uriBuilder
                .path("/v2/alerts/stream")
                .queryParam("merchantId", merchantId)
                .build())
            .accept(MediaType.TEXT_EVENT_STREAM)
            .retrieve()
            .bodyToFlux(TransactionAlert.class)
            .retryWhen(
                Retry.fixedDelay(Long.MAX_VALUE, Duration.ofSeconds(5))
                    .doBeforeRetry(signal ->
                        log.warn("Alert stream disconnected, reconnecting...")));
    }

    // POST with exchange — access full response including headers
    public Mono<PaymentGatewayResponse> submitToGateway(Payment payment) {
        return webClient.post()
            .uri("/gateway/submit")
            .bodyValue(GatewayRequest.from(payment))
            .exchangeToMono(response -> {
                String idempotencyKey = response.headers().header("X-Idempotency-Key")
                    .stream().findFirst().orElse(null);

                if (response.statusCode().is2xxSuccessful()) {
                    return response.bodyToMono(GatewaySuccessResponse.class)
                        .map(body -> PaymentGatewayResponse.success(body, idempotencyKey));
                } else {
                    return response.bodyToMono(GatewayErrorResponse.class)
                        .flatMap(body -> Mono.error(
                            new GatewayException(body.getCode(), body.getMessage())));
                }
            });
    }
}
```

---

## Reactive Filter Chains

WebFlux filters are reactive — they participate in the `Mono<ServerResponse>` chain. They are the equivalent of servlet filters but non-blocking.

```java
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;

// Correlation ID propagation filter
@Component
@Order(1)
public class CorrelationIdFilter implements WebFilter {

    private static final String HEADER = "X-Correlation-ID";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String correlationId = Optional
            .ofNullable(exchange.getRequest().getHeaders().getFirst(HEADER))
            .orElse(UUID.randomUUID().toString());

        exchange.getResponse().getHeaders().add(HEADER, correlationId);

        return chain.filter(exchange)
            // Propagate correlationId into Reactor Context for downstream logging
            .contextWrite(ctx -> ctx.put("correlationId", correlationId));
    }
}

// Rate limiting filter
@Component
@Order(2)
public class RateLimitFilter implements WebFilter {

    private final ReactiveRateLimiter rateLimiter;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String clientId = extractClientId(exchange);

        return rateLimiter.tryAcquire(clientId)
            .flatMap(allowed -> {
                if (!allowed) {
                    exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
                    exchange.getResponse().getHeaders()
                        .add("Retry-After", "1");
                    return exchange.getResponse().setComplete();
                }
                return chain.filter(exchange);
            });
    }
}

// Request/Response logging filter with timing
@Component
@Order(3)
public class AccessLogFilter implements WebFilter {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        long startTime = System.currentTimeMillis();
        ServerHttpRequest request = exchange.getRequest();

        return chain.filter(exchange)
            .doFinally(signalType -> {
                long duration = System.currentTimeMillis() - startTime;
                int statusCode = Optional
                    .ofNullable(exchange.getResponse().getStatusCode())
                    .map(HttpStatus::value)
                    .orElse(0);

                log.info("ACCESS {} {} {} {}ms",
                    request.getMethod(),
                    request.getPath(),
                    statusCode,
                    duration);

                metrics.timer("http.server.request")
                    .tag("method", request.getMethod().name())
                    .tag("uri", request.getPath().value())
                    .tag("status", String.valueOf(statusCode))
                    .record(duration, TimeUnit.MILLISECONDS);
            });
    }
}
```

---

## Exception Handling with @ControllerAdvice

```java
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.reactive.result.method.annotation.ResponseEntityExceptionHandler;

@RestControllerAdvice
public class PaymentApiExceptionHandler extends ResponseEntityExceptionHandler {

    // Handle domain-specific validation errors
    @ExceptionHandler(PaymentValidationException.class)
    public Mono<ResponseEntity<ApiError>> handleValidationException(
            PaymentValidationException ex,
            ServerWebExchange exchange) {
        log.warn("Payment validation error: {}", ex.getMessage());
        metrics.increment("api.error", "type", "validation");

        ApiError error = ApiError.builder()
            .code("PAYMENT_VALIDATION_ERROR")
            .message(ex.getMessage())
            .correlationId(extractCorrelationId(exchange))
            .timestamp(Instant.now())
            .build();

        return Mono.just(ResponseEntity.badRequest().body(error));
    }

    // Handle insufficient funds
    @ExceptionHandler(InsufficientFundsException.class)
    public Mono<ResponseEntity<ApiError>> handleInsufficientFunds(
            InsufficientFundsException ex,
            ServerWebExchange exchange) {
        ApiError error = ApiError.builder()
            .code("INSUFFICIENT_FUNDS")
            .message("Account does not have sufficient funds for this transaction")
            .correlationId(extractCorrelationId(exchange))
            .build();

        return Mono.just(ResponseEntity.unprocessableEntity().body(error));
    }

    // Handle fraud blocks
    @ExceptionHandler(FraudBlockedException.class)
    public Mono<ResponseEntity<ApiError>> handleFraudBlock(
            FraudBlockedException ex,
            ServerWebExchange exchange) {
        log.warn("Payment {} blocked by fraud engine: {}",
            ex.getPaymentId(), ex.getReason());
        metrics.increment("payment.fraud.blocked");

        // Important: do not leak fraud detection logic in error response
        ApiError error = ApiError.builder()
            .code("PAYMENT_DECLINED")
            .message("Payment could not be processed")
            .correlationId(extractCorrelationId(exchange))
            .build();

        return Mono.just(ResponseEntity.unprocessableEntity().body(error));
    }

    // Handle WebExchangeBindException (validation annotations)
    @ExceptionHandler(WebExchangeBindException.class)
    public Mono<ResponseEntity<ApiError>> handleBindException(
            WebExchangeBindException ex,
            ServerWebExchange exchange) {
        List<FieldError> fieldErrors = ex.getBindingResult().getFieldErrors()
            .stream()
            .map(fe -> new FieldError(fe.getField(), fe.getDefaultMessage()))
            .collect(Collectors.toList());

        ApiError error = ApiError.builder()
            .code("INVALID_REQUEST")
            .message("Request validation failed")
            .fieldErrors(fieldErrors)
            .correlationId(extractCorrelationId(exchange))
            .build();

        return Mono.just(ResponseEntity.badRequest().body(error));
    }

    // Catch-all for unexpected errors
    @ExceptionHandler(Exception.class)
    public Mono<ResponseEntity<ApiError>> handleUnexpectedException(
            Exception ex,
            ServerWebExchange exchange) {
        log.error("Unexpected error processing request: {}",
            exchange.getRequest().getPath(), ex);
        metrics.increment("api.error", "type", "unexpected");

        ApiError error = ApiError.builder()
            .code("INTERNAL_ERROR")
            .message("An unexpected error occurred")
            .correlationId(extractCorrelationId(exchange))
            .build();

        return Mono.just(ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(error));
    }

    private String extractCorrelationId(ServerWebExchange exchange) {
        return exchange.getAttribute("correlationId");
    }
}
```

---

## Complete Payment API Example

Here is a production-representative WebFlux payment submission API:

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.*;

@Configuration
public class PaymentApiConfiguration {

    @Bean
    public RouterFunction<ServerResponse> paymentApiRouter(
            PaymentSubmissionHandler submissionHandler,
            PaymentQueryHandler queryHandler,
            PaymentStreamHandler streamHandler) {

        return RouterFunctions.route()
            .nest(RequestPredicates.path("/api/v2"), nest ->
                nest
                    .nest(RequestPredicates.path("/payments"), payments ->
                        payments
                            .POST("", submissionHandler::submit)
                            .GET("/{id}", queryHandler::findById)
                            .GET("/{id}/status", queryHandler::getStatus)
                            .DELETE("/{id}", submissionHandler::cancel)
                    )
                    .nest(RequestPredicates.path("/accounts/{accountId}"), account ->
                        account
                            .GET("/balance", queryHandler::getBalance)
                            .GET("/transactions", queryHandler::getTransactionHistory)
                            .GET("/transactions/stream",
                                streamHandler::streamTransactions)
                    )
            )
            .build();
    }
}

@Component
public class PaymentSubmissionHandler {

    private final PaymentOrchestrationService orchestrationService;
    private final IdempotencyService idempotencyService;

    public Mono<ServerResponse> submit(ServerRequest request) {
        String idempotencyKey = request.headers().firstHeader("Idempotency-Key");

        if (idempotencyKey == null) {
            return ServerResponse.badRequest()
                .bodyValue(ApiError.of("MISSING_IDEMPOTENCY_KEY",
                    "Idempotency-Key header is required"));
        }

        // Check if request was already processed (idempotent replay)
        return idempotencyService.findExistingResult(idempotencyKey)
            .flatMap(existing ->
                // Already processed — return cached response
                ServerResponse.ok()
                    .header("Idempotency-Key", idempotencyKey)
                    .header("X-Idempotency-Replayed", "true")
                    .bodyValue(existing))
            .switchIfEmpty(
                // First time — process and cache
                request.bodyToMono(PaymentRequest.class)
                    .flatMap(req -> orchestrationService.process(req, idempotencyKey))
                    .flatMap(result ->
                        idempotencyService.store(idempotencyKey, result)
                            .thenReturn(result))
                    .flatMap(result ->
                        ServerResponse.accepted()
                            .header("Idempotency-Key", idempotencyKey)
                            .location(URI.create("/api/v2/payments/" + result.getId()))
                            .bodyValue(PaymentSubmissionResponse.from(result)))
            );
    }

    public Mono<ServerResponse> cancel(ServerRequest request) {
        String paymentId = request.pathVariable("id");
        String reason = request.queryParam("reason").orElse("CUSTOMER_REQUEST");

        return orchestrationService.cancel(paymentId, reason)
            .flatMap(result ->
                ServerResponse.ok().bodyValue(CancellationResponse.from(result)))
            .onErrorResume(PaymentNotFoundException.class,
                e -> ServerResponse.notFound().build())
            .onErrorResume(PaymentNotCancellableException.class,
                e -> ServerResponse.status(HttpStatus.CONFLICT)
                    .bodyValue(ApiError.of("PAYMENT_NOT_CANCELLABLE", e.getMessage())));
    }
}
```

---

## WebFlux Application Configuration

```java
@SpringBootApplication
@EnableWebFlux
public class PaymentGatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaymentGatewayApplication.class, args);
    }
}
```

```yaml
# application.yml — WebFlux tuning for payment services
server:
  port: 8080
  netty:
    connection-timeout: 10s
    h2c-max-content-length: 0B   # unlimited for streaming
    initial-buffer-size: 128B
    max-keep-alive-requests: 1000

spring:
  webflux:
    base-path: /
    codec:
      max-in-memory-size: 2MB    # max request body buffered in memory

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  metrics:
    export:
      prometheus:
        enabled: true
```

---

## Production Tips and Pitfalls

**Pitfall 1: Using RestTemplate or JDBC in a WebFlux service**

Calling `RestTemplate` or any blocking library from a WebFlux handler blocks a Netty worker thread, starving all connections on that thread. Always use `WebClient` for HTTP and R2DBC for database access.

```java
// WRONG — blocks Netty worker thread
@GetMapping("/account/{id}/balance")
public Mono<Balance> bad(String id) {
    // RestTemplate is blocking!
    Balance balance = restTemplate.getForObject("/accounts/" + id, Balance.class);
    return Mono.just(balance);
}

// CORRECT — non-blocking WebClient
@GetMapping("/account/{id}/balance")
public Mono<Balance> correct(String id) {
    return accountServiceClient.getBalance(id); // returns Mono<Balance> from WebClient
}
```

**Pitfall 2: Returning null from a handler**

Returning `null` from a WebFlux handler causes a `NullPointerException` in the framework. Always return `Mono.empty()` or `Mono.error()`.

**Pitfall 3: Leaking internal errors to clients**

Financial APIs must not expose internal exception messages to clients. Use `@ControllerAdvice` to map all exceptions to safe, structured `ApiError` responses. Never let stack traces reach API consumers.

**Pitfall 4: Not setting response timeouts**

WebFlux does not set a default response timeout. Without a timeout, slow downstream services cause connections to hang indefinitely. Set timeouts at both the WebClient level and the route level:

```java
// At the WebClient level
webClient.get().uri("/check")
    .retrieve()
    .bodyToMono(Result.class)
    .timeout(Duration.ofSeconds(3));

// At the server level (Netty read timeout)
factory.addServerCustomizers(httpServer ->
    httpServer.idleTimeout(Duration.ofSeconds(60)));
```

**Pitfall 5: Large request body buffering**

By default, WebFlux buffers the entire request body before the handler processes it. For large payloads, increase `max-in-memory-size` or switch to streaming with `request.bodyToFlux(DataBuffer.class)`.

---

## Summary

Spring WebFlux provides a fully non-blocking web stack built on Project Reactor and Netty:

- **@RestController** returns `Mono<T>` / `Flux<T>` — the framework subscribes and writes the response
- **RouterFunction** / **HandlerFunction** provides composable, annotation-free routing
- **WebClient** replaces RestTemplate — always use it for outbound HTTP in reactive services
- **WebFilter** participates in the reactive chain — never block inside a filter
- **@ControllerAdvice** maps exceptions to structured error responses — keep internal details out of API responses
- **Netty worker threads must never block** — use R2DBC, WebClient, and reactive libraries throughout

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why does Spring WebFlux use a small number of event-loop threads (typically 2× CPU cores) instead of a large thread pool?",
      "options": ["Smaller thread pools are easier to monitor with Micrometer", "WebFlux uses non-blocking I/O — threads never block waiting for I/O, so a small pool handles thousands of concurrent requests by processing continuations when I/O completes", "Netty does not support thread pools larger than 2× CPU cores", "Smaller pools reduce memory usage for the HTTP connection queue"],
      "correct": 1,
      "explanation": "Non-blocking I/O means threads are never parked waiting for a database response or HTTP call. Each thread continuously processes work whenever I/O completes. This event-loop model allows 8 threads to handle 10,000 concurrent in-flight requests, unlike blocking models where each request holds a thread."
    },
    {
      "text": "What is the consequence of calling a blocking JDBC operation on a Netty event-loop thread in a WebFlux handler?",
      "options": ["The request completes slightly more slowly due to context switching", "The event-loop thread blocks, stalling all other requests assigned to that thread until the JDBC call completes", "An exception is thrown automatically by Reactor's BlockHound", "The request is automatically retried on a boundedElastic thread"],
      "correct": 1,
      "explanation": "Blocking an event-loop thread stalls the entire event loop for that thread. All other requests multiplexed onto that thread queue up and experience latency or timeouts. Under load, this cascades into full pipeline stalls. This is why blocking code must be offloaded to boundedElastic schedulers."
    },
    {
      "text": "When should you prefer the functional router/handler model (RouterFunction/HandlerFunction) over annotated controllers (@RestController) in WebFlux?",
      "options": ["Always — annotated controllers are deprecated in WebFlux", "When you need programmatic composition of routes, testing handlers in isolation without starting a server, or building a library that provides reusable handler building blocks", "Only when using Server-Sent Events (SSE)", "When the service has more than 50 endpoints"],
      "correct": 1,
      "explanation": "Functional routing is a first-class citizen in WebFlux. It enables pure function composition of routes and handlers without Spring annotations, making handlers unit-testable without an application context. Annotated controllers are still fully supported and are the simpler choice for standard CRUD endpoints."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Non-Blocking Payment API with Spring WebFlux and R2DBC",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Build a Spring WebFlux payment service with both annotated controller and functional router variants for the same /payments endpoint. The handler must retrieve payment details using R2DBC (not JDBC) and call an external fraud service using WebClient. Verify no blocking calls exist using BlockHound in tests."},
    {"id": "2", "description": "Add a streaming endpoint GET /payments/stream that uses Server-Sent Events to push real-time payment status updates to clients. Use a Flux.interval() source and filter by payment ID. Test with WebTestClient that the SSE stream emits events correctly."},
    {"id": "3", "description": "Implement a global WebExceptionHandler that maps domain exceptions to structured RFC 7807 ProblemDetail responses. Map PaymentNotFoundException to 404, InsufficientFundsException to 422, and all others to 500. Verify with WebTestClient that error responses include the correct status and body."},
    {"id": "4", "description": "Load test the WebFlux payment endpoint using Gatling with 1000 concurrent virtual users and measure p50/p99 latency and throughput. Then introduce a 50ms Thread.sleep() in a handler (simulating accidental blocking) and re-run the benchmark. Document the throughput degradation and explain why it is disproportionate to the 50ms delay."}
  ]
}
-->

The next lesson covers back-pressure — the mechanism by which a WebFlux service protects itself when downstream services are slower than the inbound payment rate.
