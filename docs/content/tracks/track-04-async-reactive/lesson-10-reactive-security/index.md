---
id: track-04-lesson-10
title: "Reactive Security — Authentication in WebFlux"
slug: reactive-security
track: track-04
trackName: Async & Reactive Systems
sequence: 10
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [reactive-security, WebFlux, JWT, OAuth2, SecurityContext]
prerequisites: []
---

# Reactive Security — Authentication in WebFlux

> [!NOTE]
> Spring Security's reactive stack replaces every `ThreadLocal`-based, blocking component with a reactive, non-blocking equivalent. `SecurityContextHolder` becomes `ReactiveSecurityContextHolder`. Filter chains become `WebFilter` chains. For financial APIs handling thousands of concurrent payment requests, this means authentication and authorization never block event-loop threads.

## Spring Security With WebFlux — Architecture

The reactive security stack is distinct from the MVC stack. Never mix them in the same application.

```
Incoming Request
       │
       ▼
┌────────────────────────────────────────┐
│  SecurityWebFilterChain                │
│                                        │
│  HttpsRedirectWebFilter               │
│  → CorsWebFilter                       │
│  → CsrfWebFilter                       │
│  → AuthenticationWebFilter            │  ← validates JWT / OAuth token
│  → AuthorizationWebFilter             │  ← checks permissions
│  → ExceptionTranslationWebFilter      │  ← maps security exceptions
│                                        │
└────────────────────────┬───────────────┘
                         │  (if all filters pass)
                         ▼
                   Your Handler/Controller
```

Each filter in the chain is a `WebFilter` — it returns `Mono<Void>` and participates in the Reactor operator chain. Authentication results are stored in Reactor Context, not `ThreadLocal`.

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.security</groupId>
    <artifactId>spring-security-oauth2-resource-server</artifactId>
</dependency>
```

---

## SecurityWebFilterChain Configuration

```java
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.web.server.SecurityWebFilterChain;

@Configuration
@EnableWebFluxSecurity
public class PaymentApiSecurityConfiguration {

    @Bean
    public SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http) {
        return http
            // Disable CSRF for stateless APIs (using JWT tokens)
            .csrf(ServerHttpSecurity.CsrfSpec::disable)

            // CORS configuration for bank clients
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))

            // Authorization rules
            .authorizeExchange(exchanges -> exchanges
                // Public endpoints — health, metrics, documentation
                .pathMatchers("/actuator/health", "/actuator/info").permitAll()
                .pathMatchers("/api/v1/auth/**").permitAll()

                // Payment submission — requires PAYMENT_INITIATOR role
                .pathMatchers(HttpMethod.POST, "/api/v1/payments").hasRole("PAYMENT_INITIATOR")

                // Payment approval — requires PAYMENT_APPROVER role
                .pathMatchers(HttpMethod.PUT, "/api/v1/payments/*/approve")
                    .hasRole("PAYMENT_APPROVER")

                // Admin operations — requires ADMIN role
                .pathMatchers("/api/v1/admin/**").hasRole("ADMIN")

                // All other endpoints require authentication
                .anyExchange().authenticated()
            )

            // JWT Bearer token authentication (OAuth2 resource server)
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter()))
            )

            // Custom entry point — return JSON error response, not HTML
            .exceptionHandling(ex -> ex
                .authenticationEntryPoint(new JsonAuthenticationEntryPoint())
                .accessDeniedHandler(new JsonAccessDeniedHandler())
            )

            .build();
    }

    @Bean
    public ReactiveJwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtGrantedAuthoritiesConverter authoritiesConverter =
            new JwtGrantedAuthoritiesConverter();
        authoritiesConverter.setAuthorityPrefix("ROLE_");
        authoritiesConverter.setAuthoritiesClaimName("roles"); // custom claim name

        ReactiveJwtAuthenticationConverter converter = new ReactiveJwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(
            jwt -> Flux.fromIterable(authoritiesConverter.convert(jwt)));

        return converter;
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("https://banking.example.com"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Correlation-ID"));
        config.setExposedHeaders(List.of("X-Correlation-ID", "Location"));
        config.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
```

---

## Custom JWT Filter Chain

For financial APIs that need custom JWT validation logic (multi-tenant token verification, custom claim extraction, token revocation checks), implement a custom `AuthenticationWebFilter`.

```java
import org.springframework.security.authentication.ReactiveAuthenticationManager;
import org.springframework.security.web.server.authentication.AuthenticationWebFilter;

@Component
public class PaymentJwtAuthenticationFilter {

    @Bean
    public AuthenticationWebFilter jwtAuthenticationFilter(
            PaymentJwtAuthenticationManager authManager) {

        AuthenticationWebFilter filter = new AuthenticationWebFilter(authManager);

        // Extract token from Authorization header
        filter.setServerAuthenticationConverter(exchange -> {
            String authHeader = exchange.getRequest().getHeaders()
                .getFirst(HttpHeaders.AUTHORIZATION);

            if (authHeader == null || !authHeader.startsWith("Bearer ")) {
                return Mono.empty(); // no token — let the chain decide
            }

            String token = authHeader.substring(7);
            return Mono.just(new BearerTokenAuthenticationToken(token));
        });

        // Store result in security context
        filter.setSecurityContextRepository(
            new WebSessionServerSecurityContextRepository());

        return filter;
    }
}

// Custom authentication manager with multi-tenant JWT validation
@Component
public class PaymentJwtAuthenticationManager
        implements ReactiveAuthenticationManager {

    private final JwtDecoder primaryDecoder;
    private final JwtDecoder secondaryDecoder; // for federated identity
    private final TokenRevocationService revocationService;

    @Override
    public Mono<Authentication> authenticate(Authentication authentication) {
        BearerTokenAuthenticationToken token =
            (BearerTokenAuthenticationToken) authentication;

        return decodeToken(token.getToken())
            .flatMap(jwt -> checkRevocation(jwt).thenReturn(jwt))
            .flatMap(jwt -> extractAuthorities(jwt).map(authorities ->
                new JwtAuthenticationToken(jwt, authorities, extractPrincipal(jwt))))
            .onErrorMap(JwtException.class,
                ex -> new InvalidBearerTokenException("Invalid JWT: " + ex.getMessage()));
    }

    private Mono<Jwt> decodeToken(String tokenValue) {
        return Mono.fromCallable(() -> primaryDecoder.decode(tokenValue))
            .onErrorResume(JwtException.class, ex ->
                // Try secondary decoder for federated tokens
                Mono.fromCallable(() -> secondaryDecoder.decode(tokenValue)))
            .subscribeOn(Schedulers.boundedElastic()); // JWT validation is CPU-bound
    }

    private Mono<Void> checkRevocation(Jwt jwt) {
        return revocationService.isRevoked(jwt.getId())
            .flatMap(revoked -> {
                if (revoked) {
                    return Mono.error(
                        new InvalidBearerTokenException("Token has been revoked"));
                }
                return Mono.empty();
            });
    }

    private Mono<Collection<GrantedAuthority>> extractAuthorities(Jwt jwt) {
        List<String> roles = jwt.getClaimAsStringList("roles");
        List<String> scopes = jwt.getClaimAsStringList("scope");

        return Mono.just(Stream.concat(
            roles  != null ? roles.stream().map(r -> new SimpleGrantedAuthority("ROLE_" + r)) : Stream.empty(),
            scopes != null ? scopes.stream().map(s -> new SimpleGrantedAuthority("SCOPE_" + s)) : Stream.empty()
        ).collect(Collectors.toList()));
    }

    private String extractPrincipal(Jwt jwt) {
        return jwt.getClaimAsString("sub"); // subject claim = user ID
    }
}
```

---

## ReactiveSecurityContextHolder

`ReactiveSecurityContextHolder` is the WebFlux equivalent of Spring MVC's `SecurityContextHolder`. It stores the `SecurityContext` in Reactor's `Context`, not `ThreadLocal`.

```java
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

@Service
public class PaymentAuthorizationService {

    // Basic principal extraction
    public Mono<String> getCurrentUserId() {
        return ReactiveSecurityContextHolder.getContext()
            .map(SecurityContext::getAuthentication)
            .map(Authentication::getName); // returns JWT 'sub' claim
    }

    // Extract custom JWT claims for financial authorization
    public Mono<PaymentAuthorization> buildAuthorization(Payment payment) {
        return ReactiveSecurityContextHolder.getContext()
            .map(SecurityContext::getAuthentication)
            .cast(JwtAuthenticationToken.class)
            .map(auth -> {
                Jwt jwt = auth.getToken();
                String userId = jwt.getSubject();
                String tenantId = jwt.getClaimAsString("tenant_id");
                String merchantId = jwt.getClaimAsString("merchant_id");
                List<String> roles = jwt.getClaimAsStringList("roles");
                BigDecimal dailyLimit = new BigDecimal(
                    jwt.getClaimAsString("daily_payment_limit"));

                return PaymentAuthorization.builder()
                    .userId(userId)
                    .tenantId(tenantId)
                    .merchantId(merchantId)
                    .roles(roles)
                    .dailyLimit(dailyLimit)
                    .payment(payment)
                    .build();
            });
    }

    // Authorization check: user can only access their own account
    public Mono<Account> getOwnAccount(String accountId) {
        return ReactiveSecurityContextHolder.getContext()
            .map(ctx -> ctx.getAuthentication().getName())
            .flatMap(userId ->
                accountService.findById(accountId)
                    .filter(account -> account.getOwnerId().equals(userId))
                    .switchIfEmpty(Mono.error(new AccessDeniedException(
                        "Account " + accountId + " does not belong to user " + userId)))
            );
    }

    // Amount limit check from JWT claim
    public Mono<Payment> enforceTransactionLimit(Payment payment) {
        return buildAuthorization(payment)
            .flatMap(auth -> {
                if (payment.getAmount().compareTo(auth.getDailyLimit()) > 0) {
                    return Mono.error(new PaymentLimitExceededException(
                        "Payment amount " + payment.getAmount() +
                        " exceeds daily limit " + auth.getDailyLimit()));
                }
                return Mono.just(payment);
            });
    }
}
```

---

## OAuth2 Resource Server for Financial APIs

```java
@Configuration
public class OAuth2ResourceServerConfiguration {

    // JWK Set URI from your authorization server (Keycloak, Auth0, etc.)
    @Bean
    public ReactiveJwtDecoder jwtDecoder() {
        return ReactiveJwtDecoders.fromOidcIssuerLocation(
            "https://auth.bank.internal/realms/payments");
    }

    // Custom JWT validator — verify token audience and expiry
    @Bean
    public ReactiveJwtDecoder validatingJwtDecoder() {
        NimbusReactiveJwtDecoder decoder = NimbusReactiveJwtDecoder
            .withJwkSetUri("https://auth.bank.internal/jwks")
            .build();

        // Validate audience claim (prevent token reuse across services)
        OAuth2TokenValidator<Jwt> audienceValidator = new JwtClaimValidator<>(
            JwtClaimNames.AUD,
            aud -> aud != null && aud.contains("payment-service"));

        // Validate issuer
        OAuth2TokenValidator<Jwt> issuerValidator =
            JwtValidators.createDefaultWithIssuer(
                "https://auth.bank.internal/realms/payments");

        // Combine validators
        OAuth2TokenValidator<Jwt> combined = new DelegatingOAuth2TokenValidator<>(
            issuerValidator, audienceValidator);

        decoder.setJwtValidator(combined);
        return decoder;
    }
}
```

---

## Method-Level Security with @PreAuthorize

Reactive method security requires `@EnableReactiveMethodSecurity` and returns `Mono<T>` / `Flux<T>`.

```java
@Configuration
@EnableReactiveMethodSecurity
public class MethodSecurityConfiguration extends ReactiveMethodSecurityConfiguration {
    // Default config is sufficient for most cases
}

@Service
public class PaymentManagementService {

    // Simple role check
    @PreAuthorize("hasRole('PAYMENT_INITIATOR')")
    public Mono<Payment> initiatePayment(PaymentRequest request) {
        return paymentService.create(request);
    }

    // Multiple roles — either APPROVER or ADMIN can approve
    @PreAuthorize("hasAnyRole('PAYMENT_APPROVER', 'ADMIN')")
    public Mono<Payment> approvePayment(String paymentId) {
        return paymentService.approve(paymentId);
    }

    // SpEL expression accessing method arguments
    @PreAuthorize("hasRole('ADMIN') or #payment.initiatorId == authentication.name")
    public Mono<Void> cancelPayment(Payment payment) {
        return paymentService.cancel(payment.getId());
    }

    // Post-authorization — filter result based on authenticated user
    @PostAuthorize("returnObject.map(p -> p.getOwnerId() == authentication.name).block()")
    public Mono<Account> getAccount(String accountId) {
        return accountService.findById(accountId);
    }

    // Scope-based authorization for OAuth2 clients
    @PreAuthorize("hasAuthority('SCOPE_payments:write')")
    public Mono<PaymentResult> submitPayment(Payment payment) {
        return paymentGateway.submit(payment);
    }

    // Complex authorization: check account ownership AND balance limit
    @PreAuthorize("@paymentAuthorizationService.canInitiatePayment(authentication, #request)")
    public Mono<Payment> initiateWithCustomAuth(PaymentRequest request) {
        return paymentService.create(request);
    }
}

// Custom authorization bean for complex rules
@Service("paymentAuthorizationService")
public class PaymentAuthorizationBean {

    public Mono<Boolean> canInitiatePayment(Authentication auth, PaymentRequest request) {
        String userId = auth.getName();
        return Mono.zip(
            accountService.isOwner(request.getSourceAccountId(), userId),
            limitsService.withinDailyLimit(userId, request.getAmount())
        ).map(tuple -> tuple.getT1() && tuple.getT2());
    }
}
```

---

## SecurityContext Propagation with Reactor Context

The security context must propagate through reactive pipelines. Spring Security handles this automatically in WebFlux filter chains, but when you create new reactive chains manually (e.g., in background processing), you must propagate it explicitly.

```java
@Service
public class ScheduledPaymentProcessor {

    // Propagating security context to a background processing chain
    public Mono<Void> processScheduledPayments(
            List<ScheduledPayment> payments,
            Authentication serviceAuth) {

        return Flux.fromIterable(payments)
            .flatMap(payment ->
                paymentService.process(payment)
                    .contextWrite(ReactiveSecurityContextHolder.withAuthentication(serviceAuth))
            )
            .then();
    }

    // For fully automated service-to-service calls, use a service account token
    public Mono<Void> processWithServiceAccount() {
        Authentication serviceAccount = new UsernamePasswordAuthenticationToken(
            "payment-processor-service",
            null,
            List.of(new SimpleGrantedAuthority("ROLE_SERVICE_ACCOUNT"))
        );

        return getScheduledPayments()
            .flatMap(payment -> paymentService.process(payment), 10)
            .contextWrite(ReactiveSecurityContextHolder.withAuthentication(serviceAccount))
            .then();
    }
}
```

---

## Custom Authentication Entry Points

```java
// Return JSON error responses instead of HTML redirects
@Component
public class JsonAuthenticationEntryPoint
        implements ServerAuthenticationEntryPoint {

    @Override
    public Mono<Void> commence(ServerWebExchange exchange,
            AuthenticationException ex) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        exchange.getResponse().getHeaders()
            .setContentType(MediaType.APPLICATION_JSON);

        ApiError error = ApiError.builder()
            .code("AUTHENTICATION_REQUIRED")
            .message("Valid authentication credentials are required")
            .timestamp(Instant.now())
            .build();

        byte[] bytes = objectMapper.writeValueAsBytes(error);
        DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(bytes);
        return exchange.getResponse().writeWith(Mono.just(buffer));
    }
}

@Component
public class JsonAccessDeniedHandler implements ServerAccessDeniedHandler {

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, AccessDeniedException ex) {
        exchange.getResponse().setStatusCode(HttpStatus.FORBIDDEN);
        exchange.getResponse().getHeaders()
            .setContentType(MediaType.APPLICATION_JSON);

        ApiError error = ApiError.builder()
            .code("ACCESS_DENIED")
            .message("You do not have permission to perform this action")
            .timestamp(Instant.now())
            .build();

        byte[] bytes = objectMapper.writeValueAsBytes(error);
        DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(bytes);
        return exchange.getResponse().writeWith(Mono.just(buffer));
    }
}
```

---

## Testing Reactive Security

```java
import org.springframework.security.test.web.reactive.server.SecurityMockServerConfigurers;
import org.springframework.test.web.reactive.server.WebTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestSecurityConfiguration.class)
public class PaymentControllerSecurityTest {

    @Autowired
    private WebTestClient webTestClient;

    @Test
    void submitPayment_requiresPaymentInitiatorRole() {
        webTestClient
            .mutateWith(SecurityMockServerConfigurers
                .mockJwt()
                .authorities(new SimpleGrantedAuthority("ROLE_READ_ONLY")))
            .post().uri("/api/v1/payments")
            .bodyValue(validPaymentRequest())
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    void submitPayment_succeedsWithPaymentInitiatorRole() {
        webTestClient
            .mutateWith(SecurityMockServerConfigurers
                .mockJwt()
                .authorities(new SimpleGrantedAuthority("ROLE_PAYMENT_INITIATOR"))
                .jwt(jwt -> jwt
                    .claim("sub", "user-001")
                    .claim("tenant_id", "tenant-abc")
                    .claim("daily_payment_limit", "50000")))
            .post().uri("/api/v1/payments")
            .bodyValue(validPaymentRequest())
            .exchange()
            .expectStatus().isAccepted()
            .expectHeader().exists("Location");
    }

    @Test
    void getPayment_unauthenticated_returns401() {
        webTestClient
            .get().uri("/api/v1/payments/PAY-001")
            .exchange()
            .expectStatus().isUnauthorized()
            .expectBody()
                .jsonPath("$.code").isEqualTo("AUTHENTICATION_REQUIRED");
    }

    @Test
    void approvePayment_withInitiatorRole_returns403() {
        webTestClient
            .mutateWith(SecurityMockServerConfigurers
                .mockJwt()
                .authorities(new SimpleGrantedAuthority("ROLE_PAYMENT_INITIATOR")))
            .put().uri("/api/v1/payments/PAY-001/approve")
            .exchange()
            .expectStatus().isForbidden();
    }

    // Test method-level security in service layer
    @Test
    void serviceLayer_methodSecurity_enforcesRoles() {
        // Create a Mono with a specific security context
        Mono<Payment> securedCall = paymentService
            .initiatePayment(validRequest())
            .contextWrite(ReactiveSecurityContextHolder.withAuthentication(
                mockAuthentication("ROLE_READ_ONLY")));

        StepVerifier.create(securedCall)
            .expectError(AccessDeniedException.class)
            .verify();
    }

    private Authentication mockAuthentication(String... roles) {
        return new UsernamePasswordAuthenticationToken(
            "test-user",
            null,
            Arrays.stream(roles)
                .map(SimpleGrantedAuthority::new)
                .collect(Collectors.toList())
        );
    }
}
```

---

## Production Tips and Pitfalls

**Pitfall 1: Mixing MVC and WebFlux security**

`@EnableWebSecurity` configures the MVC filter chain. `@EnableWebFluxSecurity` configures the reactive filter chain. Using both in the same application causes double-filtering and unpredictable security behavior. Use only one.

**Pitfall 2: SecurityContext not available in flatMap**

If `ReactiveSecurityContextHolder.getContext()` returns empty inside a `flatMap`, the security context was not propagated into the inner publisher's context. Ensure you use `contextWrite(ReactiveSecurityContextHolder.withAuthentication(...))` or rely on the framework's automatic propagation.

**Pitfall 3: Blocking JWT validation on event-loop**

JJWT and Nimbus JOSE JWT signature verification is CPU-bound. Without `subscribeOn(Schedulers.boundedElastic())`, it runs on the Netty event-loop thread. For high-throughput APIs, offload JWT validation to a bounded elastic scheduler.

**Pitfall 4: Not validating the audience claim**

Always validate `aud` (audience) in your JWT validator. Without it, tokens issued for one service can be replayed against another. In a microservices payment platform, each service must have a unique audience value.

**Pitfall 5: Leaking authentication details in error responses**

Custom entry points and access denied handlers must not include JWT claim values, role names, or specific reasons for rejection in responses to unauthenticated callers. This prevents reconnaissance attacks against the authorization model.

---

## Summary

Reactive security in WebFlux builds on the same Spring Security model but replaces every blocking component with its reactive equivalent:

- **`SecurityWebFilterChain`** configures the reactive filter chain — authentication, authorization, CORS, CSRF
- **`ReactiveAuthenticationManager`** validates credentials and returns `Mono<Authentication>` — never blocks
- **`ReactiveSecurityContextHolder`** stores `SecurityContext` in Reactor Context, not `ThreadLocal`
- **`@PreAuthorize`** with `@EnableReactiveMethodSecurity` returns `Mono<Boolean>` — evaluated reactively
- **JWT validation** should be offloaded to `boundedElastic` for CPU-bound signature verification
- **Always validate audience** to prevent token reuse across services in a microservices financial platform

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "How does the reactive Spring Security stack store the authenticated SecurityContext, and why is this important?",
      "options": ["In a database session keyed by session cookie", "In Reactor Context (not ThreadLocal), ensuring it is available across thread switches in reactive pipelines", "In a static field on ReactiveSecurityContextHolder", "In an HTTP-only cookie passed on every request"],
      "correct": 1,
      "explanation": "ReactiveSecurityContextHolder stores SecurityContext in Reactor Context. This is essential because reactive pipelines switch threads; ThreadLocal-based storage would lose the security context when operators execute on different threads. Reactor Context travels with the subscription chain regardless of thread."
    },
    {
      "text": "Why should JWT signature verification be offloaded to the boundedElastic scheduler in a WebFlux service?",
      "options": ["JWT verification requires blocking database lookups", "JWT signature verification is CPU-bound cryptographic work that blocks the event-loop thread if not offloaded, stalling other requests", "BoundedElastic has hardware acceleration for RSA operations", "Event-loop threads cannot perform Base64 decoding"],
      "correct": 1,
      "explanation": "RSA or ECDSA signature verification is CPU-intensive. If performed on a Netty event-loop thread it blocks that thread and prevents it from processing other I/O events. Offloading to boundedElastic (a thread pool for blocking/CPU work) keeps the event loop free."
    },
    {
      "text": "What security risk does JWT audience validation prevent in a microservices payment platform?",
      "options": ["It prevents JWT tokens from being used after expiration", "It prevents a token issued for one service (e.g., the notification service) from being used to call another service (e.g., the payment service)", "It prevents replay attacks by tracking used JTI claims", "It ensures the token was signed with the correct algorithm"],
      "correct": 1,
      "explanation": "Without audience (aud) validation, a JWT token issued for the notification service could be presented to the payment service. Each service must validate that the token's aud claim matches its own service identifier, preventing cross-service token reuse."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "JWT Authentication and Role-Based Authorization for a Reactive Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a ReactiveAuthenticationManager that validates JWTs using Spring Security's NimbusReactiveJwtDecoder. Configure RS256 key validation, audience claim check (aud must equal 'payment-service'), and expiration validation. Offload signature verification to boundedElastic using publishOn. Write tests for valid tokens, expired tokens, wrong audience, and invalid signatures."},
    {"id": "2", "description": "Build a SecurityWebFilterChain that protects the payment API: POST /payments requires the PAYMENT_WRITER role, GET /payments/{id} requires PAYMENT_READER, and DELETE /payments/{id} requires PAYMENT_ADMIN. Use @EnableReactiveMethodSecurity and @PreAuthorize on service methods as a second layer. Test all role combinations."},
    {"id": "3", "description": "Implement OAuth2 token introspection as a fallback for opaque tokens: configure a ReactiveOpaqueTokenIntrospector that calls the authorization server's /introspect endpoint using WebClient. Cache introspection results for 60 seconds in a Caffeine cache wrapped in Mono.cache(). Verify that the cache prevents repeated introspection calls for the same token."},
    {"id": "4", "description": "Write a security integration test suite using WebTestClient: test that unauthenticated requests return 401, requests with insufficient roles return 403, valid tokens return 200, and that security context is correctly available in service layer methods (verify via ReactiveSecurityContextHolder.getContext() inside the handler)."}
  ]
}
-->
- **Test security** explicitly with `mockJwt()` and `SecurityMockServerConfigurers` — do not rely on integration tests alone
