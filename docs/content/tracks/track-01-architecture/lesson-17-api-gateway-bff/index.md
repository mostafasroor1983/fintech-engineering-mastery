---
id: "track-01-lesson-17"
title: "API Gateway and Backend-for-Frontend Patterns"
track: "track-01"
track-name: "Advanced Software Architecture"
sequence: 17
slug: "api-gateway-bff"
difficulty: "advanced"
estimated-minutes: 75
status: "published"
last-updated: "2026-11-08"
prerequisites: []
tags: ["API-gateway", "BFF", "aggregation", "authentication", "Kong", "Spring-Cloud-Gateway"]
java-versions: [17, 21]
topics: ["api-gateway", "backend-for-frontend", "request-aggregation", "circuit-breaker", "correlation-id", "versioning"]
components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true
references:
  - "Sam Newman, 'Building Microservices', 2nd ed., O'Reilly, 2021"
  - "Spring Cloud Gateway Documentation, 2024"
  - "Phil Calçado, 'Pattern: Backends For Frontends', soundcloud.com/backstage, 2015"
---

Consider a mobile banking app team at a European neobank (a composite example) that was making 11 separate HTTP calls on the home screen load — accounts, recent transactions, credit limits, rewards balance, exchange rates, notifications, spending insights, card status, pending payments, upcoming direct debits, and product offers. On a 4G connection, the sequential calls took 3.2 seconds. With a Backend-for-Frontend that composed all 11 responses into a single call, load time dropped to 380 milliseconds. The BFF also reduced the mobile team's deployment coupling: instead of coordinating releases with 11 backend teams, they owned their BFF and could iterate independently. This lesson covers how to build both the API gateway and BFF layers correctly.

## Learning Objectives

- Enumerate the responsibilities of an API gateway — authentication, rate limiting, routing, SSL termination, logging — and understand which belong at the gateway versus in services
- Configure Spring Cloud Gateway routes with predicates, filters, and circuit breakers
- Design a Backend-for-Frontend (BFF) per client type — mobile, web, partner API — and explain why a single BFF for all clients defeats the purpose
- Implement `PaymentAggregationBff` composing account, payment, and limit data in a single response using reactive composition
- Apply a circuit breaker at the gateway level to protect backend services from cascade failure
- Inject and propagate correlation IDs for distributed tracing through the full request chain
- Manage API versioning at the gateway layer without polluting individual services
- Understand where GraphQL is a superior alternative to BFF and where it is not

## Business Context

Consider a UK challenger bank (a composite example) whose partner API gateway has no circuit breaker between the gateway and its KYC verification service. When the KYC provider's latency rises from 200ms to 8 seconds, the gateway accumulates thousands of in-flight requests waiting for KYC responses, and its shared connection pool and memory are exhausted within 90 seconds. Because the gateway was shared across all APIs — not just KYC — this brought down the entire API surface for 14 minutes, including payment APIs that had no dependency on KYC at all. The fix required adding circuit breakers per downstream service at the gateway layer, ensuring failures in one upstream cannot exhaust shared gateway resources.

## API Gateway Responsibilities

An API gateway is not just a reverse proxy. Its responsibilities cluster into five categories, each of which must be clearly owned:

| Responsibility | Implementation | Location |
|---|---|---|
| **Authentication** | JWT validation, OAuth2 token introspection | Gateway — before routing |
| **Rate limiting** | Per-client, per-endpoint token bucket | Gateway — after auth |
| **Routing** | Path-based, header-based, weighted | Gateway |
| **SSL termination** | TLS offload, cert rotation | Gateway / load balancer |
| **Observability** | Correlation ID injection, access logging, metrics | Gateway |
| **Circuit breaking** | Per-upstream breaker | Gateway |
| **Request/response transformation** | Header rewriting, body mapping | Gateway sparingly; prefer service |

> [!WARNING]
> Business logic does not belong in the gateway. If you find yourself adding payment validation rules or account eligibility checks to gateway filters, that logic belongs in a service. Gateways that accumulate business logic become an unmaintainable monolith-at-the-edge.

## Spring Cloud Gateway Configuration

```java
@Configuration
public class GatewayRouteConfig {

    private static final Pattern UUID_PATTERN =
        Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    @Bean
    public RouteLocator paymentGatewayRoutes(RouteLocatorBuilder builder,
                                              CircuitBreakerFactory cbFactory) {
        return builder.routes()

            // Payment service routes — authenticated, rate-limited, circuit-broken
            .route("payment-service", r -> r
                .path("/api/v1/payments/**")
                .filters(f -> f
                    .rewritePath("/api/v1/(?<segment>.*)", "/${segment}")
                    .addRequestHeader("X-Gateway-Version", "1.0")
                    .requestRateLimiter(config -> config
                        .setRateLimiter(redisRateLimiter())
                        .setKeyResolver(clientIdKeyResolver()))
                    .circuitBreaker(config -> config
                        .setName("payment-service-cb")
                        .setFallbackUri("forward:/fallback/payment")))
                .uri("lb://payment-service"))

            // Account service — read-heavy, higher rate limit
            .route("account-service", r -> r
                .path("/api/v1/accounts/**")
                .filters(f -> f
                    .rewritePath("/api/v1/(?<segment>.*)", "/${segment}")
                    .circuitBreaker(config -> config
                        .setName("account-service-cb")
                        .setFallbackUri("forward:/fallback/account")))
                .uri("lb://account-service"))

            // Mobile BFF — the gateway validates the token; the BFF reads the user
            // from that token (never from a client-supplied header)
            .route("mobile-bff", r -> r
                .path("/mobile/v1/**")
                .and()
                .header("X-Client-Type", "mobile")
                .filters(f -> f
                    .rewritePath("/mobile/v1/(?<segment>.*)", "/${segment}"))
                .uri("lb://mobile-bff"))

            .build();
    }

    // Correlation ID injection filter — applies to ALL routes
    @Bean
    public GlobalFilter correlationIdFilter() {
        return (exchange, chain) -> {
            String correlationId = exchange.getRequest().getHeaders()
                .getFirst("X-Correlation-ID");
            // Accept a client value only if it is a UUID (prevents log injection)
            if (correlationId == null || !UUID_PATTERN.matcher(correlationId).matches()) {
                correlationId = UUID.randomUUID().toString();
            }
            final String id = correlationId;
            exchange.getResponse().getHeaders().set("X-Correlation-ID", id);
            ServerWebExchange mutatedExchange = exchange.mutate()
                .request(r -> r.headers(h -> h.set("X-Correlation-ID", id)))
                .build();
            return chain.filter(mutatedExchange);
        };
    }
}
```

## BFF Architecture — One BFF per Client Type

The BFF pattern (popularised in 2015 by Phil Calçado from his work at SoundCloud, and by Sam Newman) recommends a separate BFF per client type. A single "BFF" serving mobile, web, and partner clients is an aggregation service, not a BFF — it cannot be optimised for any client's needs without compromising others.

```mermaid
graph TD
    MOB[Mobile App\niOS / Android]
    WEB[Web App\nReact SPA]
    PART[Partner API\nB2B Integration]

    MOBBFF[Mobile BFF\nminimal payload\nbattery-aware]
    WEBBFF[Web BFF\nrich data\nSSE support]
    PARTBFF[Partner BFF\nfull API\nwebhook management]

    GW[API Gateway\nauth, rate limit, TLS]

    ACCSVC[Account\nService]
    PAYSVC[Payment\nService]
    LIMSVC[Limits\nService]
    NTFSVC[Notification\nService]

    MOB --> GW
    WEB --> GW
    PART --> GW
    GW --> MOBBFF
    GW --> WEBBFF
    GW --> PARTBFF
    MOBBFF --> ACCSVC
    MOBBFF --> PAYSVC
    MOBBFF --> LIMSVC
    WEBBFF --> ACCSVC
    WEBBFF --> PAYSVC
    WEBBFF --> LIMSVC
    WEBBFF --> NTFSVC
    PARTBFF --> PAYSVC
    PARTBFF --> ACCSVC
```

## PaymentAggregationBff — Reactive Composition

The BFF composes multiple downstream calls. Using reactive streams (`Mono.zip`) achieves parallel fan-out, reducing total latency to the slowest individual call rather than the sum of all calls.

```java
@RestController
@RequestMapping("/v1/home")
public class MobileHomeScreenBff {

    private final AccountServiceClient accountClient;
    private final PaymentServiceClient paymentClient;
    private final LimitsServiceClient limitsClient;
    private final NotificationServiceClient notificationClient;

    @GetMapping
    public Mono<MobileHomeResponse> homeScreen(
            @AuthenticationPrincipal Jwt jwt,   // validated token — not a client header
            @RequestHeader("X-Correlation-ID") String correlationId) {

        String userId = jwt.getSubject();

        // Fan out all calls in parallel — total latency = max(individual latencies).
        // For finer degradation, give each call its own timeout and fallback so one
        // slow service does not blank the whole screen.
        return Mono.zip(
            accountClient.getSummary(userId, correlationId),
            paymentClient.getRecentTransactions(userId, 5, correlationId),
            limitsClient.getCurrentLimits(userId, correlationId),
            notificationClient.getUnreadCount(userId, correlationId)
        ).map(tuple -> MobileHomeResponse.builder()
            .accountSummary(toMobileAccountSummary(tuple.getT1()))
            .recentTransactions(toMobileTransactions(tuple.getT2()))
            .spendingLimit(tuple.getT3().dailyLimit())
            .remainingLimit(tuple.getT3().remainingToday())
            .unreadNotifications(tuple.getT4())
            .build()
        ).timeout(Duration.ofSeconds(3))  // Mobile clients cannot wait longer
         .onErrorResume(TimeoutException.class, ex ->
             Mono.just(MobileHomeResponse.degraded(
                 "Some data temporarily unavailable")));
    }

    // Response tailored for mobile: minimal fields, mobile-friendly formats
    private MobileAccountSummary toMobileAccountSummary(AccountSummary full) {
        return MobileAccountSummary.builder()
            .maskedAccountNumber(full.accountNumber().replaceAll("\\d(?=\\d{4})", "*"))
            .displayBalance(formatCurrencyForLocale(full.availableBalance()))
            .build();
    }
}
```

## Circuit Breaker at the Gateway Level

Each upstream service needs its own circuit breaker. A shared breaker means one slow service can trip the breaker for all services on the gateway.

```java
@Configuration
public class GatewayCircuitBreakerConfig {

    // Spring Cloud Gateway is reactive, so it uses the REACTIVE factory
    @Bean
    public Customizer<ReactiveResilience4JCircuitBreakerFactory> paymentServiceCb() {
        return factory -> factory.configure(builder -> builder
            .circuitBreakerConfig(CircuitBreakerConfig.custom()
                .failureRateThreshold(50)           // Open after 50% failures
                .waitDurationInOpenState(Duration.ofSeconds(30))
                .slidingWindowType(COUNT_BASED)
                .slidingWindowSize(20)
                .permittedNumberOfCallsInHalfOpenState(5)
                .build())
            .timeLimiterConfig(TimeLimiterConfig.custom()
                .timeoutDuration(Duration.ofSeconds(2))
                .build()),
        "payment-service-cb");
    }

    // Fallback controller — returns a safe degraded response when circuit is open
    @RestController
    @RequestMapping("/fallback")
    public static class GatewayFallbackController {

        // @RequestMapping, not @GetMapping: a forwarded POST keeps its method
        @RequestMapping("/payment")
        public ResponseEntity<Map<String, String>> paymentFallback(
                @RequestHeader("X-Correlation-ID") String correlationId) {
            return ResponseEntity.status(503)
                .header("X-Correlation-ID", correlationId)
                .header("Retry-After", "30")
                .body(Map.of(
                    "error", "PAYMENT_SERVICE_UNAVAILABLE",
                    "message", "Payment service is temporarily unavailable",
                    "correlationId", correlationId
                ));
        }
    }
}
```

> [!IMPORTANT]
> A 503 from the breaker — or a gateway timeout — does **not** mean the payment failed: the request may have reached the payment service before the gateway gave up. Clients must retry with the same `Idempotency-Key` (or check the payment status) instead of submitting a new payment.

## API Versioning at the Gateway Layer

Versioning at the gateway allows you to evolve individual services without breaking their public API contracts. The gateway absorbs the version routing and can apply transformation filters to adapt legacy service responses to current API contracts.

```java
@Bean
public RouteLocator versionedRoutes(RouteLocatorBuilder builder) {
    return builder.routes()

        // v1 routes to current service
        .route("payment-v1", r -> r
            .path("/api/v1/payments/**")
            .uri("lb://payment-service"))

        // v2 routes to same service — service handles v2 internally
        .route("payment-v2", r -> r
            .path("/api/v2/payments/**")
            .filters(f -> f
                .rewritePath("/api/v2/(?<segment>.*)", "/${segment}")
                .addRequestHeader("X-API-Version", "2"))
            .uri("lb://payment-service"))

        // Legacy v0 — sunset header notifies clients to migrate
        .route("payment-v0-sunset", r -> r
            .path("/api/v0/payments/**")
            .filters(f -> f
                .addResponseHeader("Sunset", "Mon, 01 Mar 2027 00:00:00 GMT")   // RFC 8594
                .addResponseHeader("Deprecation", "@1767225600")                // RFC 9745: since 2026-01-01
                .rewritePath("/api/v0/(?<segment>.*)", "/${segment}"))
            .uri("lb://payment-service-v0"))

        .build();
}
```

## GraphQL as an Alternative to BFF

GraphQL addresses the same problem as BFF — over-fetching and multiple round trips — but with a different trade-off profile:

| Concern | BFF | GraphQL |
|---|---|---|
| **Who controls the query?** | Server (BFF team) | Client (frontend team) |
| **N+1 query risk** | Low — BFF knows its own queries | High — requires DataLoader |
| **Type safety** | Java types, manual contract | Schema-first, generated types |
| **Mobile optimisation** | Very high — BFF tailored per client | Good — fields selected per query |
| **Partner API suitability** | Requires separate BFF per partner | Excellent — partners query what they need |
| **Operational complexity** | Medium — one BFF per client type | High — schema governance, persisted queries |

For internal BFFs where the client team and BFF team are the same, BFF is typically simpler. For partner APIs and self-service integrations, GraphQL's flexibility provides more value.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "Your team proposes building a single 'BFF' that serves both the mobile app and the web app to reduce duplication. What is the primary architectural problem with this approach?",
      "options": [
        "It violates the DRY principle because BFFs should share code",
        "A single BFF serving multiple client types accumulates conflicting requirements, making it impossible to optimise payload size for mobile without breaking web, and creating deployment coupling between client teams",
        "It is not a problem — a shared BFF is more cost-effective and the extra payload size is acceptable",
        "It increases latency because the BFF must handle more request types"
      ],
      "correct": 1,
      "explanation": "The BFF pattern exists specifically to allow each client type to have an independently deployable, purpose-optimised aggregation layer. Mobile needs small payloads and battery-efficient polling patterns. Web needs richer data and may need SSE for real-time updates. A shared BFF cannot be optimised for either without compromising the other, and it creates the same deployment coupling problem the BFF pattern was designed to solve."
    },
    {
      "id": "q2",
      "text": "During a production incident, the KYC service becomes slow (8-second response times). The gateway has no circuit breaker. What failure mode do you expect?",
      "options": [
        "Only KYC-dependent endpoints slow down — other endpoints are unaffected",
        "The gateway accumulates in-flight requests waiting for KYC responses, exhausting shared gateway resources (connection pool, memory, worker threads) so that all routes start failing",
        "The gateway automatically times out slow requests after 30 seconds and returns errors only to KYC callers",
        "Kubernetes restarts the KYC pods, resolving the issue within 60 seconds"
      ],
      "correct": 1,
      "explanation": "Without a circuit breaker, requests to the slow KYC service pile up. Because the gateway's connection pool, memory and worker capacity are shared across all routes, the KYC backlog crowds out payment, account and every other API. This is a cascade failure via resource exhaustion — a circuit breaker (with a time limit) per upstream service prevents it by failing fast once KYC is degraded, keeping resources free for unrelated routes."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "API Gateway and Backend-for-Frontend Patterns — Production Implementation",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "Design the full Spring Cloud Gateway route configuration for all three client types (mobile, web, partner). Include JWT validation, per-client rate limiting, a circuit breaker per downstream service, correlation-ID propagation, and the rule that user identity is taken from the validated token, never from a client header."
    },
    {
      "id": "2",
      "description": "Implement the `MobileHomeScreenBff` with reactive fan-out to at least four downstream services. Include timeout handling with a degraded response (per call, so one slow service does not blank the screen), mobile-specific payload transformation (mask sensitive data such as account numbers), and tests for the degraded path."
    },
    {
      "id": "3",
      "description": "Your payment service has an SLA of 200ms p99. Design the circuit breaker configuration — failure-rate threshold, sliding window size and open-state duration — and justify each value. What does the client see when the breaker is open, and how must it retry a payment safely?"
    },
    {
      "id": "4",
      "description": "You need to sunset the v0 payment API in 90 days. Design and implement the full lifecycle: Deprecation and Sunset headers, a migration-guide endpoint that returns the v1 equivalent of a v0 request, monitoring of the remaining v0 traffic per client, and the final switch-off."
    }
  ]
}
-->
