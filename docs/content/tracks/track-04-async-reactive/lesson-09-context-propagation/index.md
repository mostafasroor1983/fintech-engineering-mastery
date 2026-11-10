---
id: track-04-lesson-09
title: "Context Propagation in Async Systems"
slug: context-propagation
track: track-04
trackName: Async & Reactive Systems
sequence: 9
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [context-propagation, MDC, tracing, ThreadLocal, Reactor-Context]
prerequisites: []
---

# Context Propagation in Async Systems

> [!NOTE]
> `ThreadLocal` is the backbone of observability in synchronous Java systems — it carries correlation IDs, user sessions, trace spans, and security contexts automatically between method calls. In reactive and async systems, threads are reused across unrelated requests, breaking `ThreadLocal` completely. This lesson covers how to propagate context correctly in reactive fintech pipelines using Reactor's `Context` API, MDC bridging, and OpenTelemetry.

## Why ThreadLocal Fails in Async Systems

In a traditional Spring MVC service, a request arrives on Thread-A. The entire request lifecycle — authentication, service calls, database queries, logging — runs on Thread-A. `ThreadLocal` values set during authentication are readable during logging without any explicit passing.

```java
// Works fine in Spring MVC (synchronous)
@GetMapping("/payment/{id}")
public Payment getPayment(@PathVariable String id) {
    // MDC.get("correlationId") works here — set by servlet filter on this thread
    log.info("Fetching payment: {}", id); // logs include correlationId
    return paymentService.findById(id);   // service also sees the MDC value
}
```

In WebFlux, the same request may touch 5 different threads:

```
Request arrives → Thread-1 (Netty I/O)
  → flatMap starts → Thread-2 (boundedElastic, fraud check)
  → fraud returns → Thread-3 (Netty I/O, another connection)
  → flatMap starts → Thread-4 (boundedElastic, account lookup)
  → response written → Thread-5 (Netty I/O)
```

`ThreadLocal` values set on Thread-1 are invisible on Threads 2-5. MDC is `ThreadLocal`-backed — so log statements on Threads 2-5 produce no correlation ID. Distributed traces lose context. Security principals vanish. The entire observability stack breaks silently.

---

## Reactor Context API

Reactor's `Context` is an immutable, key-value map that travels with the subscription, not the thread. Each operator in the pipeline can read from and write to the Context. It is the reactive equivalent of `ThreadLocal`, propagated by the framework rather than the JVM.

```java
import reactor.core.publisher.Mono;
import reactor.util.context.Context;

public class ReactorContextBasics {

    // contextWrite — add values to the Context (downstream operators can read them)
    // Context flows UPSTREAM — it is set by subscribers and read by publishers
    public Mono<PaymentResult> processWithContext(Payment payment) {
        return Mono.deferContextual(ctx -> {
            String correlationId = ctx.getOrDefault("correlationId", "unknown");
            String userId = ctx.getOrDefault("userId", "unknown");

            log.info("[{}] Processing payment {} for user {}",
                correlationId, payment.getId(), userId);

            return paymentService.process(payment);
        })
        .contextWrite(ctx -> ctx
            .put("correlationId", payment.getCorrelationId())
            .put("userId", payment.getUserId())
            .put("requestedAt", Instant.now())
        );
    }

    // deferContextual — create a publisher that depends on context values
    public Mono<AuditEntry> auditPayment(Payment payment) {
        return Mono.deferContextual(ctx -> {
            String correlationId = ctx.getOrDefault("correlationId", "N/A");
            String operatorId   = ctx.getOrDefault("operatorId", "system");

            return auditService.record(AuditEntry.builder()
                .paymentId(payment.getId())
                .correlationId(correlationId)
                .operatorId(operatorId)
                .timestamp(Instant.now())
                .build());
        });
    }

    // Context is immutable — contextWrite creates a new Context
    // Direction: context is set at subscription point and flows UPSTREAM
    public void contextDirectionDemo() {
        Mono.just("payment")
            .flatMap(p ->
                Mono.deferContextual(ctx ->
                    // ctx will contain "stage" = "flatMap" (set below)
                    Mono.just("processed: " + ctx.get("stage"))))
            .contextWrite(Context.of("stage", "flatMap")); // set at subscription point
    }
}
```

### Context Flows Upstream — The Most Important Concept

Context in Reactor flows in the **opposite direction** to data. Data flows downstream (from publisher to subscriber). Context flows upstream (from subscriber toward the publisher). This is counterintuitive and is the source of most context bugs.

```java
public void contextDirectionExample() {
    Flux.just(1, 2, 3)
        .flatMap(i ->
            Mono.deferContextual(ctx ->
                Mono.just(i + ": " + ctx.getOrDefault("key", "MISSING"))))
        // contextWrite must be AFTER (downstream of) the operators that read it
        .contextWrite(Context.of("key", "value"))
        .subscribe(System.out::println);
    // Output: "1: value", "2: value", "3: value"
}

public void contextDirectionBug() {
    Flux.just(1, 2, 3)
        // contextWrite is BEFORE (upstream of) the operators — context is not visible
        .contextWrite(Context.of("key", "value"))
        .flatMap(i ->
            Mono.deferContextual(ctx ->
                Mono.just(i + ": " + ctx.getOrDefault("key", "MISSING"))))
        .subscribe(System.out::println);
    // Output: "1: MISSING", "2: MISSING", "3: MISSING" — BUG
}
```

---

## MDC in Reactive Pipelines

Logging frameworks (Logback, Log4j2) use MDC (Mapped Diagnostic Context) to include contextual fields in every log statement. MDC is `ThreadLocal`-backed, which means it must be explicitly bridged to Reactor Context.

### Manual MDC Bridging

```java
import org.slf4j.MDC;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Signal;

public class MdcPropagation {

    // Helper: lift MDC from Reactor Context into ThreadLocal before each onNext call
    public static <T> Mono<T> withMdc(Mono<T> mono) {
        return mono.doOnEach(signal -> {
            if (signal.isOnNext() || signal.isOnError()) {
                Map<String, String> mdcContext = signal.getContextView()
                    .getOrDefault("mdc", Collections.emptyMap());
                mdcContext.forEach(MDC::put);
            }
        });
    }

    // Usage in a payment pipeline
    public Mono<PaymentResult> processPayment(Payment payment, String correlationId) {
        return withMdc(
            paymentService.process(payment)
                .doOnNext(result ->
                    log.info("Payment processed: {}", result.getId())) // MDC available here
                .doOnError(ex ->
                    log.error("Payment failed: {}", ex.getMessage()))   // MDC available here
        )
        .contextWrite(ctx -> ctx.put("mdc", Map.of(
            "correlationId", correlationId,
            "paymentId", payment.getId(),
            "currency", payment.getCurrency()
        )));
    }
}
```

### Micrometer Context Propagation Bridge (Preferred Approach)

Since Reactor 3.5 and Spring Boot 3.x, the [Micrometer Context Propagation](https://github.com/micrometer-metrics/context-propagation) library provides automatic bridging between Reactor Context and `ThreadLocal` values including MDC.

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>context-propagation</artifactId>
    <version>1.1.0</version>
</dependency>
```

```java
import io.micrometer.context.ContextRegistry;
import io.micrometer.context.ContextSnapshot;

@Configuration
public class ContextPropagationConfiguration {

    @PostConstruct
    public void configureContextPropagation() {
        // Register MDC as a context propagator
        // This bridges MDC ThreadLocal values into Reactor Context automatically
        ContextRegistry.getInstance()
            .registerThreadLocalAccessor(
                "mdc",
                MDC::getCopyOfContextMap,
                mdcMap -> {
                    if (mdcMap != null) {
                        MDC.setContextMap(mdcMap);
                    }
                },
                MDC::clear
            );

        // Enable automatic context propagation in Reactor
        Hooks.enableAutomaticContextPropagation();
    }
}

// With the bridge configured, MDC values propagate automatically
@Service
public class PaymentServiceWithAutoMdc {

    public Mono<PaymentResult> process(Payment payment) {
        // MDC values set before subscription are automatically available
        // in doOnNext, doOnError, and all operator callbacks
        return Mono.just(payment)
            .flatMap(this::validate)
            .flatMap(this::submit)
            .doOnNext(result ->
                log.info("Payment {} processed", result.getId()))
                // correlationId from MDC appears in this log automatically
            .doOnError(ex ->
                log.error("Payment failed", ex));
                // MDC context available here too
    }
}
```

---

## OpenTelemetry Context Propagation

Distributed tracing in a payment system requires span context to propagate across service boundaries and across async operator calls. OpenTelemetry integrates with Reactor through the context propagation bridge.

```xml
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-api</artifactId>
</dependency>
<dependency>
    <groupId>io.opentelemetry.instrumentation</groupId>
    <artifactId>opentelemetry-reactor-3.1</artifactId>
</dependency>
```

```java
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;

@Service
public class TracedPaymentService {

    private final Tracer tracer;
    private final PaymentRepository repository;

    // Manual span creation with Reactor
    public Mono<Payment> processWithSpan(PaymentRequest request) {
        return Mono.deferContextual(ctx -> {
            // Extract OTel context from Reactor context
            Context otelContext = ctx.getOrDefault(
                "otel.context", Context.current());

            Span span = tracer.spanBuilder("payment.process")
                .setParent(otelContext)
                .setAttribute("payment.id", request.getId())
                .setAttribute("payment.currency", request.getCurrency())
                .setAttribute("payment.amount", request.getAmount().toPlainString())
                .startSpan();

            return Mono.just(request)
                .flatMap(this::validate)
                .flatMap(this::submit)
                .doOnSuccess(p ->
                    span.setStatus(StatusCode.OK))
                .doOnError(ex -> {
                    span.recordException(ex);
                    span.setStatus(StatusCode.ERROR, ex.getMessage());
                })
                .doFinally(sig -> span.end())
                .contextWrite(Context.of("otel.context",
                    otelContext.with(span)));
        });
    }

    // With the OTel + Reactor instrumentation, spans propagate automatically
    // across flatMap and publishOn boundaries
    public Mono<PaymentResult> autoTracedPipeline(Payment payment) {
        return Mono.just(payment)
            .flatMap(p -> fraudService.check(p))    // span continues here
            .flatMap(p -> ledgerService.write(p))   // and here
            .doOnNext(r -> log.info("Done"));        // trace ID in logs
    }
}
```

### Propagating Trace Context Across HTTP Calls

```java
@Component
public class TracingWebClientFilter implements ExchangeFilterFunction {

    @Override
    public Mono<ClientResponse> filter(ClientRequest request, ExchangeFunction next) {
        return Mono.deferContextual(ctx -> {
            // Extract trace context from Reactor context
            io.opentelemetry.context.Context otelCtx =
                ctx.getOrDefault("otel.context",
                    io.opentelemetry.context.Context.current());

            // Inject trace headers into outbound HTTP request
            ClientRequest.Builder builder = ClientRequest.from(request);
            GlobalOpenTelemetry.getPropagators()
                .getTextMapPropagator()
                .inject(otelCtx, builder,
                    (b, key, value) -> b.header(key, value));

            return next.exchange(builder.build());
        });
    }
}
```

---

## SecurityContext in WebFlux

Spring Security's `SecurityContext` is typically `ThreadLocal`-backed in MVC. In WebFlux, it uses a `ReactiveSecurityContextHolder` backed by Reactor Context.

```java
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.security.core.context.SecurityContext;

@Service
public class PaymentAuthorizationService {

    // Access the security context reactively
    public Mono<Payment> authorizeAndProcess(Payment payment) {
        return ReactiveSecurityContextHolder.getContext()
            .map(SecurityContext::getAuthentication)
            .filter(auth -> auth != null && auth.isAuthenticated())
            .switchIfEmpty(Mono.error(new UnauthorizedException("Not authenticated")))
            .flatMap(auth -> {
                String userId = auth.getName();
                List<String> roles = auth.getAuthorities().stream()
                    .map(GrantedAuthority::getAuthority)
                    .collect(Collectors.toList());

                // Validate the authenticated user can process this payment
                if (!userId.equals(payment.getInitiatorId()) &&
                        !roles.contains("ROLE_PAYMENT_ADMIN")) {
                    return Mono.error(new ForbiddenException(
                        "User " + userId + " cannot process payment for " +
                            payment.getInitiatorId()));
                }

                return paymentService.process(payment.withAuthorizedBy(userId));
            });
    }

    // Propagate security context to a downstream service call
    public Mono<FraudCheckResult> fraudCheckWithUserContext(Payment payment) {
        return ReactiveSecurityContextHolder.getContext()
            .map(ctx -> ctx.getAuthentication().getName())
            .flatMap(userId ->
                fraudClient.check(payment, userId))
            .contextWrite(ReactiveSecurityContextHolder.withAuthentication(
                getCurrentAuthentication())); // explicitly set context if needed
    }
}
```

---

## Correlation ID Propagation — End-to-End Pattern

Here is the complete pattern for propagating a correlation ID from an HTTP request through a reactive pipeline to all log statements and outbound calls:

```java
// Step 1: Extract from inbound HTTP request and populate Reactor Context
@Component
@Order(1)
public class CorrelationIdContextFilter implements WebFilter {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String correlationId = Optional
            .ofNullable(exchange.getRequest().getHeaders().getFirst("X-Correlation-ID"))
            .orElse(UUID.randomUUID().toString());

        exchange.getResponse().getHeaders().set("X-Correlation-ID", correlationId);

        return chain.filter(exchange)
            .contextWrite(ctx -> ctx
                .put("correlationId", correlationId)
                .put("mdc", Map.of(
                    "correlationId", correlationId,
                    "requestPath", exchange.getRequest().getPath().value()
                )));
    }
}

// Step 2: Read correlation ID from context in service layer
@Service
public class PaymentOrchestrationService {

    public Mono<PaymentResult> orchestrate(PaymentRequest request) {
        return Mono.deferContextual(ctx -> {
            String correlationId = ctx.getOrDefault("correlationId", "N/A");

            // Passes correlationId to all outbound calls
            return validatePayment(request, correlationId)
                .flatMap(validated -> enrichPayment(validated, correlationId))
                .flatMap(enriched -> submitPayment(enriched, correlationId));
        });
    }

    private Mono<Payment> validatePayment(PaymentRequest req, String correlationId) {
        return validationService.validate(req)
            .doOnNext(p -> log.info("[{}] Validation passed for {}",
                correlationId, p.getId()));
    }
}

// Step 3: Include correlation ID in outbound HTTP requests
@Component
public class CorrelationIdOutboundFilter implements ExchangeFilterFunction {

    @Override
    public Mono<ClientResponse> filter(ClientRequest request, ExchangeFunction next) {
        return Mono.deferContextual(ctx -> {
            String correlationId = ctx.getOrDefault("correlationId", "N/A");

            ClientRequest withCorrelationId = ClientRequest.from(request)
                .header("X-Correlation-ID", correlationId)
                .build();

            return next.exchange(withCorrelationId);
        });
    }
}
```

---

## Testing Context Propagation

```java
import reactor.test.StepVerifier;
import reactor.util.context.Context;

public class ContextPropagationTests {

    @Test
    void testCorrelationIdPropagation() {
        String correlationId = "test-corr-123";
        List<String> capturedIds = new ArrayList<>();

        Mono<String> pipeline = Mono.deferContextual(ctx -> {
            capturedIds.add(ctx.getOrDefault("correlationId", "MISSING"));
            return Mono.just("result");
        })
        .flatMap(result ->
            Mono.deferContextual(ctx -> {
                capturedIds.add(ctx.getOrDefault("correlationId", "MISSING"));
                return Mono.just(result);
            }));

        StepVerifier.create(
            pipeline.contextWrite(Context.of("correlationId", correlationId))
        )
        .expectNext("result")
        .verifyComplete();

        assertThat(capturedIds).containsOnly(correlationId);
    }

    @Test
    void testMdcAvailableInDoOnNext() {
        List<String> loggedValues = new ArrayList<>();

        // With Hooks.enableAutomaticContextPropagation() configured,
        // MDC should be available in doOnNext
        Mono<String> pipeline = Mono.just("payment")
            .doOnNext(p -> loggedValues.add(MDC.get("correlationId")))
            .contextWrite(ctx -> {
                MDC.put("correlationId", "test-123");
                return ctx;
            });

        StepVerifier.create(pipeline)
            .expectNext("payment")
            .verifyComplete();

        // Verify MDC was accessible in the doOnNext hook
        assertThat(loggedValues).containsExactly("test-123");
    }

    @Test
    void testContextDoesNotLeakBetweenRequests() {
        // Critical test: ensure context from request 1 does not appear in request 2
        AtomicReference<String> req2CorrelationId = new AtomicReference<>();

        Mono<String> request1 = Mono.just("R1")
            .contextWrite(Context.of("correlationId", "corr-R1"));

        Mono<String> request2 = Mono.deferContextual(ctx -> {
            req2CorrelationId.set(ctx.getOrDefault("correlationId", "not-set"));
            return Mono.just("R2");
        }); // no context set for request 2

        // Subscribe to both
        request1.subscribe();
        request2.subscribe();

        assertThat(req2CorrelationId.get()).isEqualTo("not-set"); // no leak
    }
}
```

---

## Production Tips and Pitfalls

**Pitfall 1: MDC in async calls without bridging**

The most common production issue: logs produced by `flatMap`-ed operations have no correlationId, tenantId, or traceId because MDC is `ThreadLocal` and the operator runs on a different thread. Always use Micrometer's context propagation bridge with `Hooks.enableAutomaticContextPropagation()`.

**Pitfall 2: contextWrite direction**

`contextWrite` must be placed **after** (downstream of) the operators that read it. If you place it before, the context will not be visible. This is the most common Reactor context bug.

**Pitfall 3: Context is immutable**

Each call to `contextWrite` returns a new Context — it does not modify the existing one. Store the returned Mono/Flux.

**Pitfall 4: Leaking sensitive context**

In multi-tenant financial systems, verify that context (especially security principals, tenant IDs, account information) does not leak between subscriptions. Each request must have its own Context with `contextWrite`.

**Pitfall 5: SecurityContext in method-level security**

`@PreAuthorize` with `@EnableReactiveMethodSecurity` reads from `ReactiveSecurityContextHolder` (Reactor Context). If the security context is not propagated to the calling thread's Context, `@PreAuthorize` will silently deny all requests. Always verify security context is set before calling secured methods.

---

## Summary

Context propagation is fundamental infrastructure for observable, secure, multi-tenant reactive financial systems:

- **Reactor `Context`** is the reactive replacement for `ThreadLocal` — immutable, propagated by the framework
- **Context flows upstream** — place `contextWrite` downstream of the operators that read it
- **MDC bridging** requires Micrometer's context propagation library with `Hooks.enableAutomaticContextPropagation()`
- **OpenTelemetry** integrates via the same bridge — spans propagate across `flatMap` and `publishOn` automatically
- **SecurityContext** in WebFlux uses `ReactiveSecurityContextHolder` — always set it before calling secured services

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why does ThreadLocal-based MDC (Mapped Diagnostic Context) fail in reactive WebFlux pipelines?",
      "options": ["MDC is deprecated in Java 17 and removed in Java 21", "Reactive pipelines switch threads between operators using schedulers; MDC values set on Thread-1 are not visible on Thread-2 where later operators execute", "WebFlux uses a single thread, so ThreadLocal causes thread contention", "MDC requires a Servlet container and is not supported in Netty"],
      "correct": 1,
      "explanation": "ThreadLocal stores values per OS thread. In a reactive pipeline, a single request may execute across 3-5 different threads as operators are scheduled. MDC values set during authentication on Thread-1 are invisible on Thread-3 during database queries, breaking correlation IDs in logs."
    },
    {
      "text": "In Reactor's Context API, in which direction does context flow relative to the operator chain?",
      "options": ["Downstream — from source to subscriber", "Upstream — from subscriber to source; contextWrite placed downstream makes context available to operators upstream of it", "Bidirectionally — Reactor automatically propagates context in both directions", "Context does not flow; it must be explicitly passed to each operator"],
      "correct": 1,
      "explanation": "Reactor Context flows upstream (against the data flow direction). A contextWrite call downstream of operators makes that context visible to operators upstream. This is counterintuitive but correct: place contextWrite at the end of the chain (or in a WebFilter early in the chain) to make context available throughout."
    },
    {
      "text": "What library integration enables automatic propagation of MDC values across reactive operator boundaries without manually bridging each operator?",
      "options": ["Spring Cloud Sleuth alone", "Micrometer context-propagation with Hooks.enableAutomaticContextPropagation()", "OpenTelemetry Java agent (no additional configuration needed)", "Logback's AsyncAppender with includeCallerData=true"],
      "correct": 1,
      "explanation": "Micrometer's context-propagation library, combined with Hooks.enableAutomaticContextPropagation(), automatically bridges Reactor Context to ThreadLocal (including MDC) at every operator scheduling boundary. This allows existing MDC-based logging to work transparently in reactive pipelines."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Correlation ID and Trace Propagation Across a Reactive Payment Pipeline",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Build a WebFlux WebFilter that extracts the X-Correlation-ID header from each request and writes it to Reactor Context using contextWrite(ctx -> ctx.put(CORRELATION_ID_KEY, correlationId)). Verify with a test that the correlation ID is accessible in all downstream operators, including those running on boundedElastic threads."},
    {"id": "2", "description": "Add MDC bridging using Micrometer's context-propagation library with Hooks.enableAutomaticContextPropagation(). Verify that log statements in operators running on different threads all include the correlation ID in the MDC. Use a test with Schedulers.boundedElastic() to confirm cross-thread propagation."},
    {"id": "3", "description": "Integrate OpenTelemetry tracing into a reactive payment processing chain: configure the OTLP exporter, verify that trace spans are created for each operator boundary, and confirm that the trace ID is consistent across a Mono chain that switches threads via publishOn. Export traces to Jaeger and verify parent-child span relationships."},
    {"id": "4", "description": "Implement ReactiveSecurityContextHolder usage: build a reactive service method that reads the current user's authentication from ReactiveSecurityContextHolder.getContext() and uses the user ID to scope a database query. Write a security test that verifies the correct user context is used even when the method executes on a different thread."}
  ]
}
-->
- **Test context propagation explicitly** — context leaks and missing contexts are silent bugs that only appear in production logs
