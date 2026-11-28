---
id: track-11-lesson-10
title: "OAuth2 and JWT — Token-Based Authentication Patterns"
slug: oauth2-jwt
track: track-11
trackName: "Security & Observability"
sequence: 10
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [OAuth2, JWT, OIDC, token-validation, PKCE]
prerequisites: [track-11-lesson-09]
---

# OAuth2 and JWT — Token-Based Authentication Patterns

> [!NOTE]
> OAuth2 and JWT are ubiquitous in fintech APIs, but most implementations get the security-critical details wrong: tokens too long-lived, audience validation missing, JWK cache misconfigured. For payment operations, a compromised or replayed token is a direct financial risk.

## OAuth2 Grant Types for Financial Services

Different scenarios in fintech require different OAuth2 grant types. Using the wrong one is a security vulnerability.

### Authorization Code + PKCE (User-Facing Applications)

For mobile banking apps and browser-based payment portals, use Authorization Code flow with PKCE (Proof Key for Code Exchange). PKCE prevents authorization code interception attacks.

```
1. Mobile app generates a random code_verifier (43-128 chars)
2. App computes code_challenge = BASE64URL(SHA256(code_verifier))
3. App redirects user to authorization server:
   GET /authorize?
     response_type=code
     &client_id=mobile-banking-app
     &redirect_uri=https://app.example.com/callback
     &scope=payments:read payments:write accounts:read
     &state=<random-nonce>
     &code_challenge=<computed-challenge>
     &code_challenge_method=S256

4. User authenticates and consents
5. Authorization server redirects to redirect_uri with code
6. App exchanges code + code_verifier for tokens:
   POST /token
     grant_type=authorization_code
     &code=<received-code>
     &redirect_uri=https://app.example.com/callback
     &client_id=mobile-banking-app
     &code_verifier=<original-verifier>
     (No client_secret — public client)

7. Authorization server verifies: SHA256(code_verifier) == code_challenge
   Issues: access_token (15 min) + refresh_token (8 hours)
```

The `state` parameter prevents CSRF attacks. The `code_verifier` prevents code interception—an intercepted authorization code is useless without the verifier that only the legitimate app knows.

### Client Credentials (Service-to-Service)

For machine-to-machine calls—payment-service calling fraud-service, settlement-service calling the ledger—use Client Credentials:

```
POST /token HTTP/1.1
Host: auth.example.com
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&scope=fraud:score:read

Response:
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "fraud:score:read"
}
```

> [!WARNING]
> Client secrets must be stored in Vault or Kubernetes secrets, never in environment variables in Dockerfiles or application.properties committed to git. Rotate client secrets quarterly. Stronger still — and required by FAPI / Open Banking profiles — is client authentication without a shared secret: `private_key_jwt` (the client signs an assertion) or mutual-TLS client certificates.

---

## JWT Structure and Claims for Financial Services

A JWT is three Base64URL-encoded JSON objects separated by dots: `header.payload.signature`.

### Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "2026-Q4-signing-key"
}
```

- `alg`: Signing algorithm. Use `RS256` (RSA + SHA-256) or `ES256` (ECDSA + SHA-256) for asymmetric signatures. Never `HS256` (symmetric—requires sharing the secret with every verifier). Never `none`.
- `kid`: Key ID. Allows the verifier to look up the correct public key when multiple keys are in rotation.

### Payload (Claims)

```json
{
  "iss": "https://auth.payments.example.com",
  "sub": "user-id-7a8b9c",
  "aud": ["payment-service", "account-service"],
  "exp": 1731024900,
  "iat": 1731024000,
  "nbf": 1731024000,
  "jti": "a3f7d2c1-1234-5678-abcd-ef1234567890",
  "scope": "payments:write accounts:read",
  "customer_id": "CUST-123456",
  "account_ids": ["ACC-001", "ACC-002"],
  "auth_level": "strong",
  "auth_time": 1731023900,
  "device_id": "DEVICE-abc123"
}
```

**Security-critical claims for financial services:**

| Claim | Purpose | Validation Rule |
|-------|---------|-----------------|
| `iss` | Token issuer | Must exactly match expected issuer URL |
| `aud` | Intended audience | Must contain this service's identifier |
| `exp` | Expiry | Must be in the future |
| `iat` | Issued at | Must be in the past; reject tokens issued in the future |
| `nbf` | Not before | Must be in the past |
| `jti` | JWT ID (unique token ID) | Use for token revocation checking |
| `scope` | Authorized operations | Verify scope contains the required permission |
| `auth_level` | Authentication strength | For payment operations: require `strong` (MFA) |

### Token Lifetimes for Payment Operations

| Token Type | Lifetime | Rationale |
|-----------|---------|-----------|
| Access token (payment submission) | 15 minutes | Short—limits window of token theft; re-auth required for each payment session |
| Access token (account read) | 1 hour | Slightly longer for less sensitive operations |
| Refresh token | 8 hours | Session length; rotated on each use |
| Client credentials token | 15 minutes | Service-to-service; fresh token per batch of calls |

---

## JWT Validation Checklist

Incomplete JWT validation is one of the most common authentication vulnerabilities. Validate every claim, in order. The hand-written validator below makes every step visible; in production prefer a maintained implementation (Spring Security's `NimbusJwtDecoder` with validators, as shown later, or Nimbus' `DefaultJWTProcessor`) and add only the business checks yourself.

```java
@Component
public class PaymentJwtValidator {

    private final JWKSClient jwksClient;
    private final String expectedIssuer = "https://auth.payments.example.com";
    private final String serviceAudience = "payment-service";

    public JwtClaims validatePaymentToken(String rawToken) {
        // 1. Parse without verification first (to get kid and alg from header)
        SignedJWT signedJWT;
        try {
            signedJWT = SignedJWT.parse(rawToken);
        } catch (ParseException e) {
            throw new TokenValidationException("Token is not a valid JWT");
        }

        JWSHeader header = signedJWT.getHeader();

        // 2. Algorithm whitelist check — CRITICAL
        // If attacker sends alg=none or alg=HS256, reject immediately
        JWSAlgorithm algorithm = header.getAlgorithm();
        if (!Set.of(JWSAlgorithm.RS256, JWSAlgorithm.ES256).contains(algorithm)) {
            throw new TokenValidationException(
                "Unsupported algorithm: " + algorithm + " — only RS256 and ES256 accepted");
        }

        // 3. Fetch public key by kid (with caching — see JWK caching section)
        String kid = header.getKeyID();
        JWK publicKey = jwksClient.getKey(kid);
        if (publicKey == null) {
            throw new TokenValidationException("Unknown key ID: " + kid);
        }
        // The key must be meant for this algorithm (an RSA key for RS256,
        // an EC key for ES256) -- never let the token header pick the key type
        if (publicKey.getAlgorithm() != null && !publicKey.getAlgorithm().equals(algorithm)) {
            throw new TokenValidationException("Key " + kid + " is not for " + algorithm);
        }

        // 4. Verify signature (RSA or EC verifier, matching the key)
        try {
            JWSVerifier verifier = switch (publicKey) {
                case RSAKey rsa when algorithm.equals(JWSAlgorithm.RS256) ->
                    new RSASSAVerifier(rsa.toRSAPublicKey());
                case ECKey ec when algorithm.equals(JWSAlgorithm.ES256) ->
                    new ECDSAVerifier(ec.toECPublicKey());
                default -> throw new TokenValidationException(
                    "Key type does not match algorithm " + algorithm);
            };
            if (!signedJWT.verify(verifier)) {
                throw new TokenValidationException("Token signature is invalid");
            }
        } catch (JOSEException e) {
            throw new TokenValidationException("Token signature verification failed");
        }

        // 5. Extract claims
        JWTClaimsSet claims;
        try {
            claims = signedJWT.getJWTClaimsSet();
        } catch (ParseException e) {
            throw new TokenValidationException("Token claims are malformed");
        }

        Instant now = Instant.now();

        // 6. Validate expiry
        Date expiry = claims.getExpirationTime();
        if (expiry == null || expiry.toInstant().isBefore(now)) {
            throw new TokenValidationException("Token has expired");
        }

        // 7. Validate issued-at (clock skew tolerance: 30 seconds)
        Date issuedAt = claims.getIssueTime();
        if (issuedAt == null || issuedAt.toInstant().isAfter(now.plusSeconds(30))) {
            throw new TokenValidationException("Token issued in the future");
        }

        // 8. Validate not-before
        Date notBefore = claims.getNotBeforeTime();
        if (notBefore != null && notBefore.toInstant().isAfter(now.plusSeconds(5))) {
            throw new TokenValidationException("Token not yet valid");
        }

        // 9. Validate issuer — exact string match, not contains()
        String issuer = claims.getIssuer();
        if (!expectedIssuer.equals(issuer)) {
            throw new TokenValidationException("Token issuer mismatch: " + issuer);
        }

        // 10. Validate audience — this service must be in the audience list
        List<String> audiences = claims.getAudience();
        if (audiences == null || !audiences.contains(serviceAudience)) {
            throw new TokenValidationException(
                "Token audience does not include " + serviceAudience + ": " + audiences);
        }

        // 11. Scope: the required permission must be present (space-delimited
        //     "scope" claim, per RFC 8693 / OAuth2 conventions)
        String scope = (String) claims.getClaim("scope");
        if (scope == null || !Set.of(scope.split(" ")).contains("payments:write")) {
            throw new InsufficientScopeException("payments:write scope required");
        }

        // 12. For payment operations: validate auth_level = strong
        String authLevel = (String) claims.getClaim("auth_level");
        if (!"strong".equals(authLevel)) {
            throw new InsufficientAuthenticationException(
                "Payment operations require strong authentication (MFA)");
        }

        // 13. Check token revocation via jti (for logout/revoke scenarios)
        String jti = claims.getJWTID();
        if (tokenRevocationService.isRevoked(jti)) {
            throw new TokenValidationException("Token has been revoked");
        }

        return new JwtClaims(claims);
    }
}
```

---

## Refresh Token Rotation

Refresh tokens must be rotated on every use. If an old refresh token is used (after a newer one has been issued), it indicates the token was stolen—invalidate all sessions immediately.

```java
@Service
@Transactional
public class RefreshTokenService {

    public TokenPair refreshAccessToken(String refreshToken) {
        // Look up the refresh token
        RefreshTokenEntity stored = refreshTokenRepository.findByTokenHash(
            hashToken(refreshToken)
        ).orElseThrow(() -> new InvalidTokenException("Refresh token not found"));

        // Check if already used — this indicates token replay (possible theft)
        if (stored.isUsed()) {
            // SECURITY: Old refresh token was replayed
            // Invalidate all sessions for this user immediately
            log.warn("SECURITY: Refresh token replay detected for userId={}",
                stored.getUserId());
            invalidateAllSessionsForUser(stored.getUserId());
            securityEventPublisher.publish(
                SecurityEvent.REFRESH_TOKEN_REPLAY, stored.getUserId());
            throw new SecurityException("Token replay detected — all sessions terminated");
        }

        // Check expiry
        if (stored.getExpiresAt().isBefore(Instant.now())) {
            throw new InvalidTokenException("Refresh token has expired");
        }

        // Mark old token as used (rotation) -- ATOMICALLY: two parallel
        // refresh calls with the same token must not both succeed.
        //   UPDATE refresh_tokens SET used = true
        //    WHERE token_hash = ? AND used = false      -> must update 1 row
        // (or an optimistic-lock @Version on the entity)
        int updated = refreshTokenRepository.markUsedIfUnused(stored.getTokenHash());
        if (updated == 0) {
            invalidateAllSessionsForUser(stored.getUserId());
            throw new SecurityException("Concurrent refresh token reuse detected");
        }

        // Issue new access token + new refresh token
        String newAccessToken = jwtIssuer.issueAccessToken(stored.getUserId(), stored.getScopes());
        String newRefreshToken = generateSecureToken();
        refreshTokenRepository.save(new RefreshTokenEntity(
            hashToken(newRefreshToken),
            stored.getUserId(),
            stored.getScopes(),
            Instant.now().plus(8, ChronoUnit.HOURS)
        ));

        return new TokenPair(newAccessToken, newRefreshToken);
    }

    private String hashToken(String token) {
        // Store only the hash — raw token never persisted
        return Hashing.sha256().hashString(token, StandardCharsets.UTF_8).toString();
    }
}
```

---

## Spring Security OAuth2 Resource Server

```java
// Spring Boot — configure as OAuth2 resource server
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())  // Stateless API — no CSRF needed
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                // Health check — no auth required. (Metrics belong on a
                // separate internal management port, not the public API)
                .requestMatchers("/actuator/health").permitAll()
                // Payment submission — requires payments:write scope + strong auth
                .requestMatchers(HttpMethod.POST, "/api/v1/payments")
                    .hasAuthority("SCOPE_payments:write")
                // Account reads — requires accounts:read scope
                .requestMatchers(HttpMethod.GET, "/api/v1/accounts/**")
                    .hasAuthority("SCOPE_accounts:read")
                // All other endpoints require authentication
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .decoder(paymentJwtDecoder())
                    .jwtAuthenticationConverter(paymentJwtAuthConverter())
                )
                .authenticationEntryPoint(this::handleAuthError)
                .accessDeniedHandler(this::handleAccessDenied)
            );

        // Add custom filter for auth_level validation on payment endpoints
        http.addFilterAfter(
            new StrongAuthRequiredFilter(),
            BearerTokenAuthenticationFilter.class
        );

        return http.build();
    }

    @Bean
    public JwtDecoder paymentJwtDecoder() {
        // The Nimbus JWK source caches the key set (default 5 minutes) and
        // refetches on an unknown kid -- no extra cache code needed
        NimbusJwtDecoder decoder = NimbusJwtDecoder
            .withJwkSetUri("https://auth.payments.example.com/.well-known/jwks.json")
            .jwsAlgorithm(SignatureAlgorithm.RS256)
            .jwsAlgorithm(SignatureAlgorithm.ES256)
            .build();

        // By default only exp/nbf are checked: issuer and AUDIENCE must be
        // added explicitly -- without them a token issued for another
        // service (or another issuer) would be accepted
        OAuth2TokenValidator<Jwt> audience = new JwtClaimValidator<List<String>>(
            JwtClaimNames.AUD, aud -> aud != null && aud.contains("payment-service"));
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
            JwtValidators.createDefaultWithIssuer("https://auth.payments.example.com"),
            audience));
        return decoder;
    }

    @Bean
    public JwtAuthenticationConverter paymentJwtAuthConverter() {
        JwtGrantedAuthoritiesConverter scopeConverter = new JwtGrantedAuthoritiesConverter();
        scopeConverter.setAuthorityPrefix("SCOPE_");
        scopeConverter.setAuthoritiesClaimName("scope");

        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(scopeConverter);
        // Use customer_id as principal name (not sub which is internal user ID)
        converter.setPrincipalClaimName("customer_id");
        return converter;
    }

    private void handleAuthError(HttpServletRequest req, HttpServletResponse res,
                                  AuthenticationException ex) throws IOException {
        log.warn("Authentication failed: {} path={}", ex.getMessage(), req.getRequestURI());
        res.setContentType("application/json");
        res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        res.getWriter().write("""
            {"error": "unauthorized", "message": "Valid authentication token required"}
            """);
    }
}
```

---

## JWK Endpoint Caching

Fetching the JWKS endpoint on every token validation is a performance and reliability issue. The auth server becomes a dependency on every API call.

```java
@Component
public class CachingJWKSClient {

    private final String jwksUri;
    private final Cache<String, JWK> keyCache = Caffeine.newBuilder()
        .maximumSize(10)                          // typically 2-3 keys in rotation
        .expireAfterWrite(5, TimeUnit.MINUTES)    // refresh keys every 5 minutes
        .build();
    // (refreshAfterWrite would need a LoadingCache -- with a plain Cache,
    //  Caffeine rejects it at build time)

    private volatile Instant lastFetch = Instant.EPOCH;

    public CachingJWKSClient(@Value("${auth.jwks-uri}") String jwksUri) {
        this.jwksUri = jwksUri;
    }

    public JWK getKey(String kid) {
        JWK key = keyCache.getIfPresent(kid);
        if (key != null) {
            return key;
        }
        // Unknown kid: refetch the key set -- but at most once every 30s.
        // Otherwise tokens with random kids would trigger a JWKS request each
        // (a cheap denial-of-service against the auth server)
        if (Duration.between(lastFetch, Instant.now()).toSeconds() >= 30) {
            reloadKeySet();
        }
        return keyCache.getIfPresent(kid);   // null -> caller rejects the token
    }

    private synchronized void reloadKeySet() {
        try {
            JWKSet jwkSet = JWKSet.load(URI.create(jwksUri).toURL());
            jwkSet.getKeys().forEach(k -> keyCache.put(k.getKeyID(), k));
            lastFetch = Instant.now();
        } catch (IOException | ParseException e) {
            log.error("Failed to fetch JWKS from {}", jwksUri, e);
            // keep serving the cached keys
        }
    }
}
```

**Handling key rotation without downtime:**

When the auth server rotates its signing key, tokens signed with the NEW key arrive while the cache still holds only the old one. The unknown `kid` in the JWT header triggers a (rate-limited) refetch, and the new key is picked up automatically. Auth servers publish the new key in the JWKS before they start signing with it, and keep the old one there until old tokens have expired. This is why `kid` is mandatory in the JWT header for production systems.

---

## Scope Validation for Payment Operations

Scopes are coarse-grained permissions. Payment APIs need fine-grained scope design:

```
payments:read       — read own payment history
payments:write      — submit new payments
payments:cancel     — cancel pending payments
accounts:read       — read own account balances and details
accounts:write      — manage account settings
transfers:domestic  — initiate domestic bank transfers
transfers:international — initiate international transfers (higher risk)
admin:read          — read all customer data (back-office only)
```

```java
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    // Explicitly document and enforce scope requirements
    @PostMapping
    @PreAuthorize("hasAuthority('SCOPE_payments:write')")
    public ResponseEntity<PaymentResponse> submitPayment(
            @Valid @RequestBody PaymentRequest request,
            @AuthenticationPrincipal Jwt jwt) {

        // Additional runtime checks beyond Spring Security's @PreAuthorize
        String customerId = jwt.getClaimAsString("customer_id");

        // Verify the customer owns the source account -- an exact lookup,
        // never a string prefix test (with a prefix check, customer 12
        // would "own" the accounts of customers 123, 1234, ...)
        if (!accountService.isOwnedBy(request.getSourceAccountId(), customerId)) {
            throw new AccessDeniedException(
                "Cannot submit payments from accounts you do not own");
        }

        // For international transfers, require additional scope. "scope" is
        // ONE space-delimited string -- split it (or use the SCOPE_
        // authorities Spring Security already derived from it)
        Set<String> scopes = Set.of(jwt.getClaimAsString("scope").split(" "));
        if (request.isInternational() && !scopes.contains("transfers:international")) {
            throw new AccessDeniedException(
                "International transfers require transfers:international scope");
        }

        return ResponseEntity.ok(paymentService.submit(request, customerId));
    }
}
```

---

## Security Anti-Patterns to Avoid

**1. Accepting `alg: none`**
Some early JWT libraries allowed the algorithm `none`, meaning no signature. Never trust the token's declared algorithm—validate against an explicit allowlist.

**2. Missing audience validation**
A JWT issued for `mobile-app` should not be accepted by `payment-service`. Without audience validation, a token stolen from one service can be replayed against another.

**3. Long-lived access tokens**
Access tokens lasting 24 hours mean a stolen token is valid for 24 hours. For payment operations, 15 minutes is the maximum acceptable lifetime.

**4. Storing tokens in localStorage**
Browser storage is accessible to JavaScript (including injected scripts). Store access tokens in memory; use HttpOnly cookies for refresh tokens.

**5. Not checking token revocation**
Signing out or revoking a compromised token must immediately invalidate it. Use a Redis blocklist indexed by `jti` for fast revocation lookups.

```java
// Fast token revocation check using Redis
@Service
public class TokenRevocationService {
    private final RedisTemplate<String, String> redis;
    private static final String REVOCATION_KEY_PREFIX = "revoked:jti:";

    public void revokeToken(String jti, Instant expiry) {
        String key = REVOCATION_KEY_PREFIX + jti;
        Duration ttl = Duration.between(Instant.now(), expiry);
        if (ttl.isNegative() || ttl.isZero()) {
            return;   // already expired -- nothing to revoke
        }
        // Store revocation until token would have expired anyway (auto-cleanup)
        redis.opsForValue().set(key, "1", ttl);
        log.info("Token revoked jti={}", jti);
    }

    public boolean isRevoked(String jti) {
        // O(1) Redis lookup on every token validation. Decide explicitly what
        // happens if Redis is down: fail closed (reject) for payment writes,
        // possibly fail open for low-risk reads
        return Boolean.TRUE.equals(redis.hasKey(REVOCATION_KEY_PREFIX + jti));
    }
}
```

---

## Key Takeaways

- Use Authorization Code + PKCE for user-facing applications, Client Credentials for service-to-service—never implicit or password grant
- Validate every JWT claim in order: algorithm allowlist → signature → expiry → issuer → audience → scope → auth_level → revocation
- Short-lived access tokens (15 minutes for payment operations) limit the blast radius of token theft; refresh token rotation detects replay attacks
- Never use `alg: none` or symmetric `HS256` in multi-service environments—asymmetric signatures (RS256, ES256) mean only the auth server needs the private key
- Cache JWKS with a TTL of 5 minutes—fetching on every request makes the auth server a synchronous dependency on every API call
- Audience validation is mandatory: tokens issued for one service must not be accepted by another

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which OAuth2 grant type should be used for a customer-facing mobile payment application, and why?",
      "options": ["Client Credentials — simpler to implement", "Authorization Code with PKCE — it is the only grant type safe for public clients because PKCE prevents authorization code interception attacks without requiring a client secret", "Implicit — it avoids a server round-trip for the token", "Resource Owner Password Credentials — users directly provide their credentials"],
      "correct": 1,
      "explanation": "Mobile apps are public clients — they cannot securely store a client secret. Authorization Code + PKCE (Proof Key for Code Exchange) replaces the client secret with a code challenge/verifier pair generated per-request, preventing authorization code interception attacks. Implicit grant is deprecated; password grant gives the app direct access to credentials."
    },
    {
      "text": "In what order should JWT claims be validated to prevent security vulnerabilities?",
      "options": ["Expiry → signature → issuer → audience → scope", "Signature → expiry → issuer → audience → scope (algorithm allowlist check before signature verification)", "Issuer → audience → scope → expiry → signature", "Any order is acceptable since all claims must pass"],
      "correct": 1,
      "explanation": "The algorithm allowlist must be checked first to prevent algorithm substitution attacks (e.g., alg:none). The signature must be verified before trusting any claim values. Only then should expiry, issuer, audience, and scope be validated. Processing claims from an unverified token is a security vulnerability."
    },
    {
      "text": "Why is caching the JWKS (JSON Web Key Set) with a 5-minute TTL important in a payment service that validates JWTs?",
      "options": ["To reduce JWT token size", "To prevent the auth server from becoming a synchronous dependency on every API call — a JWKS fetch on every token validation means the auth server's latency adds to every payment request", "To comply with PCI DSS key rotation requirements", "To prevent JWT replay attacks"],
      "correct": 1,
      "explanation": "If JWKS is fetched on every token validation, the auth server's availability and latency directly impact every API call. A 5-minute cache means at most one JWKS fetch per 5 minutes regardless of request volume. The cache must handle key rotation gracefully by using the kid (key ID) header to fetch new keys on a cache miss."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Secure JWT Validation for a Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a complete JWT validation chain in Spring Security: configure RS256-only algorithm allowlist, JWKS caching with Caffeine (5-minute TTL, async refresh), and claim validation for exp, iss, aud, and auth_level claims with explicit error messages for each failure mode."},
    {"id": "2", "description": "Implement fine-grained scope-based authorisation on payment endpoints: payments:write required for POST /payments, transfers:international required for international transfers in addition to payments:write, and admin:read required for GET /payments/{id} when the caller is not the payment owner."},
    {"id": "3", "description": "Build a Redis-backed token revocation service: implement revokeToken(jti, expiry) that stores revocation with auto-TTL matching token expiry, isRevoked(jti) for O(1) lookup, and integrate it into the JWT validation filter so revoked tokens are rejected immediately."},
    {"id": "4", "description": "Implement a refresh token rotation flow: on each /token/refresh call, invalidate the used refresh token and issue a new one (single-use rotation); detect replay attacks by alerting when a refresh token that was already rotated is presented again."}
  ]
}
-->
