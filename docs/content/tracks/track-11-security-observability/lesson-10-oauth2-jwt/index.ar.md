---
id: track-11-lesson-10
title: "OAuth2 وJWT — أنماط المصادقة بالرموز"
slug: oauth2-jwt
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 10
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [OAuth2, JWT, OIDC, token-validation, PKCE]
prerequisites: [track-11-lesson-09]
---

# ‏OAuth2 وJWT — أنماط المصادقة القائمة على الرموز

> [!NOTE]
> ‏OAuth2 وJWT منتشران في كل مكان في واجهات التقنية المالية، لكن معظم التنفيذات تخطئ في التفاصيل الحرجة أمنيًا: رموز طويلة العمر جدًا، وغياب التحقق من الجمهور (audience)، وإعداد خاطئ لذاكرة JWK المؤقتة. ولعمليات الدفع، الرمز المخترق أو المُعاد تشغيله خطر مالي مباشر.

## أنواع منح OAuth2 للخدمات المالية

تتطلب السيناريوهات المختلفة في التقنية المالية أنواع منح OAuth2 مختلفة. واستخدام النوع الخاطئ ثغرة أمنية.

### رمز التفويض + PKCE (التطبيقات المواجهة للمستخدم)

لتطبيقات الخدمات المصرفية على الهاتف وبوابات الدفع في المتصفح، استخدم تدفق رمز التفويض (Authorization Code) مع PKCE ‏(Proof Key for Code Exchange). ويمنع PKCE هجمات اعتراض رمز التفويض.

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

تمنع المعلمة `state` هجمات CSRF. ويمنع `code_verifier` اعتراض الرمز — فرمز التفويض المعترض عديم الفائدة دون المُتحقِّق الذي لا يعرفه إلا التطبيق الشرعي.

### بيانات اعتماد العميل (Client Credentials) (بين الخدمات)

للاستدعاءات بين الآلات — خدمة الدفع تستدعي خدمة الاحتيال، وخدمة التسوية تستدعي الدفتر — استخدم Client Credentials:

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
> يجب تخزين أسرار العملاء في Vault أو أسرار Kubernetes، لا في متغيرات بيئة في ملفات Dockerfile أو application.properties ملتزمة في git أبدًا. ودوّر أسرار العملاء ربع سنويًا. والأقوى من ذلك — والمطلوب في ملفات FAPI / الخدمات المصرفية المفتوحة — مصادقة العميل دون سر مشترك: `private_key_jwt` (يوقّع العميل تأكيدًا) أو شهادات عميل TLS المتبادلة.

---

## بنية JWT ومطالباته للخدمات المالية

‏JWT ثلاثة كائنات JSON مرمّزة بـ Base64URL تفصل بينها نقاط: `header.payload.signature`.

### الترويسة

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "2026-Q4-signing-key"
}
```

- ‏`alg`: خوارزمية التوقيع. استخدم `RS256` ‏(RSA + SHA-256) أو `ES256` ‏(ECDSA + SHA-256) للتوقيعات غير المتماثلة. ولا تستخدم `HS256` أبدًا (متماثل — يتطلب مشاركة السر مع كل متحقِّق). ولا `none` أبدًا.
- ‏`kid`: معرّف المفتاح. يتيح للمتحقِّق البحث عن المفتاح العام الصحيح حين تكون مفاتيح متعددة قيد التدوير.

### الحمولة (المطالبات)

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

**المطالبات الحرجة أمنيًا للخدمات المالية:**

| المطالبة | الغرض | قاعدة التحقق |
|-------|---------|-----------------|
| `iss` | مُصدر الرمز | يجب أن يطابق تمامًا عنوان المُصدر المتوقع |
| `aud` | الجمهور المقصود | يجب أن يحوي معرّف هذه الخدمة |
| `exp` | الانتهاء | يجب أن يكون في المستقبل |
| `iat` | وقت الإصدار | يجب أن يكون في الماضي؛ وارفض الرموز الصادرة في المستقبل |
| `nbf` | ليس قبل | يجب أن يكون في الماضي |
| `jti` | معرّف JWT (معرّف رمز فريد) | استخدمه لفحص إلغاء الرموز |
| `scope` | العمليات المصرّح بها | تحقق من احتواء النطاق على الصلاحية المطلوبة |
| `auth_level` | قوة المصادقة | لعمليات الدفع: اشترط `strong` ‏(MFA) |

### أعمار الرموز لعمليات الدفع

| نوع الرمز | العمر | المبرر |
|-----------|---------|-----------|
| رمز الوصول (إرسال الدفع) | 15 دقيقة | قصير — يحدّ نافذة سرقة الرمز؛ وإعادة المصادقة مطلوبة لكل جلسة دفع |
| رمز الوصول (قراءة الحساب) | ساعة | أطول قليلًا للعمليات الأقل حساسية |
| رمز التحديث | 8 ساعات | طول الجلسة؛ ويُدوَّر مع كل استخدام |
| رمز بيانات اعتماد العميل | 15 دقيقة | بين الخدمات؛ رمز جديد لكل دفعة استدعاءات |

---

## قائمة التحقق من JWT

التحقق غير المكتمل من JWT من أشيع ثغرات المصادقة. فتحقق من كل مطالبة، بالترتيب. والمتحقِّق المكتوب يدويًا أدناه يجعل كل خطوة مرئية؛ وفي الإنتاج فضّل تنفيذًا مصانًا (`NimbusJwtDecoder` في Spring Security مع المتحققات، كما يظهر لاحقًا، أو `DefaultJWTProcessor` في Nimbus) وأضف فحوص العمل فقط بنفسك.

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

## تدوير رموز التحديث

يجب تدوير رموز التحديث مع كل استخدام. فإذا استُخدم رمز تحديث قديم (بعد إصدار أحدث)، فهذا يدل على سرقة الرمز — فألغِ كل الجلسات فورًا.

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

## خادم موارد OAuth2 في Spring Security

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

## التخزين المؤقت لنقطة JWK

جلب نقطة JWKS مع كل تحقق من رمز مشكلة أداء وموثوقية. فيصبح خادم المصادقة اعتمادية في كل استدعاء واجهة.

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

**التعامل مع تدوير المفاتيح دون توقف:**

حين يدوّر خادم المصادقة مفتاح التوقيع، تصل رموز موقعة بالمفتاح الجديد بينما ما زالت الذاكرة المؤقتة تحوي القديم فقط. فيطلق `kid` المجهول في ترويسة JWT إعادة جلب (محدودة المعدل)، ويُلتقط المفتاح الجديد تلقائيًا. وتنشر خوادم المصادقة المفتاح الجديد في JWKS قبل البدء في التوقيع به، وتبقي القديم هناك حتى تنتهي الرموز القديمة. ولهذا `kid` إلزامي في ترويسة JWT لأنظمة الإنتاج.

---

## التحقق من النطاقات لعمليات الدفع

النطاقات (scopes) صلاحيات خشنة الحبيبات. وتحتاج واجهات الدفع تصميم نطاقات دقيقًا:

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

## أنماط أمنية مضادة يجب تجنبها

**1. قبول `alg: none`**
سمحت بعض مكتبات JWT المبكرة بالخوارزمية `none`، أي بلا توقيع. ولا تثق أبدًا بالخوارزمية المعلنة في الرمز — بل تحقق مقابل قائمة سماح صريحة.

**2. غياب التحقق من الجمهور**
يجب ألا تقبل `payment-service` رمز JWT صادرًا لـ `mobile-app`. ودون التحقق من الجمهور، يمكن إعادة تشغيل رمز مسروق من خدمة ضد أخرى.

**3. رموز وصول طويلة العمر**
رموز الوصول التي تدوم 24 ساعة تعني أن الرمز المسروق صالح 24 ساعة. ولعمليات الدفع، 15 دقيقة هي أقصى عمر مقبول.

**4. تخزين الرموز في localStorage**
تخزين المتصفح متاح لـ JavaScript (بما فيه السكربتات المحقونة). خزّن رموز الوصول في الذاكرة؛ واستخدم ملفات تعريف ارتباط HttpOnly لرموز التحديث.

**5. عدم فحص إلغاء الرموز**
يجب أن يُبطل تسجيل الخروج أو إلغاء رمز مخترق صلاحيته فورًا. استخدم قائمة حظر في Redis مفهرسة بـ `jti` لعمليات بحث سريعة عن الإلغاء.

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

## الخلاصات الأساسية

- استخدم رمز التفويض + PKCE للتطبيقات المواجهة للمستخدم، وClient Credentials بين الخدمات — ولا تستخدم المنح الضمنية (implicit) أو منح كلمة المرور أبدًا
- تحقق من كل مطالبة JWT بالترتيب: قائمة سماح الخوارزميات ← التوقيع ← الانتهاء ← المُصدر ← الجمهور ← النطاق ← auth_level ← الإلغاء
- رموز الوصول قصيرة العمر (15 دقيقة لعمليات الدفع) تحدّ نطاق ضرر سرقة الرمز؛ ويكشف تدوير رموز التحديث هجمات إعادة التشغيل
- لا تستخدم أبدًا `alg: none` أو `HS256` المتماثل في بيئات متعددة الخدمات — فالتوقيعات غير المتماثلة (RS256، وES256) تعني أن خادم المصادقة وحده يحتاج المفتاح الخاص
- خزّن JWKS مؤقتًا بصلاحية 5 دقائق — فالجلب مع كل طلب يجعل خادم المصادقة اعتمادية متزامنة في كل استدعاء واجهة
- التحقق من الجمهور إلزامي: يجب ألا تُقبل الرموز الصادرة لخدمة من خدمة أخرى

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "أي نوع منح OAuth2 يجب استخدامه لتطبيق دفع على الهاتف موجه للعملاء، ولماذا؟",
      "options": ["Client Credentials — أبسط في التنفيذ", "رمز التفويض مع PKCE — نوع المنح الوحيد الآمن للعملاء العامين لأن PKCE يمنع هجمات اعتراض رمز التفويض دون الحاجة إلى سر عميل", "الضمني (Implicit) — يتجنب رحلة ذهاب وإياب إلى الخادم للحصول على الرمز", "Resource Owner Password Credentials — يقدم المستخدمون بيانات اعتمادهم مباشرة"],
      "correct": 1,
      "explanation": "تطبيقات الهاتف عملاء عامون — لا تستطيع تخزين سر عميل بأمان. ويستبدل رمز التفويض + PKCE ‏(Proof Key for Code Exchange) سر العميل بزوج تحدٍّ/متحقِّق للرمز يُولّد لكل طلب، فيمنع هجمات اعتراض رمز التفويض. والمنح الضمني مُهمل؛ ومنح كلمة المرور يعطي التطبيق وصولًا مباشرًا إلى بيانات الاعتماد."
    },
    {
      "text": "بأي ترتيب يجب التحقق من مطالبات JWT لمنع الثغرات الأمنية؟",
      "options": ["الانتهاء ← التوقيع ← المُصدر ← الجمهور ← النطاق", "التوقيع ← الانتهاء ← المُصدر ← الجمهور ← النطاق (مع فحص قائمة سماح الخوارزميات قبل التحقق من التوقيع)", "المُصدر ← الجمهور ← النطاق ← الانتهاء ← التوقيع", "أي ترتيب مقبول لأن كل المطالبات يجب أن تنجح"],
      "correct": 1,
      "explanation": "يجب فحص قائمة سماح الخوارزميات أولًا لمنع هجمات استبدال الخوارزمية (مثل alg:none). ويجب التحقق من التوقيع قبل الثقة بأي قيم مطالبات. وبعدها فقط يُتحقق من الانتهاء، والمُصدر، والجمهور، والنطاق. ومعالجة مطالبات من رمز غير متحقق منه ثغرة أمنية."
    },
    {
      "text": "لماذا التخزين المؤقت لـ JWKS ‏(JSON Web Key Set) بصلاحية 5 دقائق مهم في خدمة دفع تتحقق من رموز JWT؟",
      "options": ["لتقليل حجم رمز JWT", "لمنع خادم المصادقة من أن يصبح اعتمادية متزامنة في كل استدعاء واجهة — فجلب JWKS مع كل تحقق من رمز يعني أن زمن خادم المصادقة يُضاف إلى كل طلب دفع", "للامتثال لمتطلبات تدوير المفاتيح في PCI DSS", "لمنع هجمات إعادة تشغيل JWT"],
      "correct": 1,
      "explanation": "إذا جُلب JWKS مع كل تحقق من رمز، فإن توفر خادم المصادقة وزمنه يؤثران مباشرة على كل استدعاء واجهة. والتخزين المؤقت لـ 5 دقائق يعني جلب JWKS مرة واحدة على الأكثر كل 5 دقائق بغض النظر عن حجم الطلبات. ويجب أن تتعامل الذاكرة المؤقتة مع تدوير المفاتيح بسلاسة باستخدام ترويسة kid (معرّف المفتاح) لجلب المفاتيح الجديدة عند غيابها من الذاكرة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تحقق آمن من JWT لواجهة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "نفّذ سلسلة تحقق كاملة من JWT في Spring Security: اضبط قائمة سماح خوارزميات بـ RS256 فقط، وتخزينًا مؤقتًا لـ JWKS بـ Caffeine (صلاحية 5 دقائق، وتحديث غير متزامن)، والتحقق من المطالبات exp، وiss، وaud، وauth_level برسائل خطأ صريحة لكل نمط فشل."},
    {"id": "2", "description": "نفّذ تفويضًا دقيقًا قائمًا على النطاقات على نقاط الدفع: payments:write مطلوب لـ POST /payments، وtransfers:international مطلوب للحوالات الدولية إضافة إلى payments:write، وadmin:read مطلوب لـ GET /payments/{id} حين لا يكون المستدعي مالك الدفعة."},
    {"id": "3", "description": "ابنِ خدمة إلغاء رموز مدعومة بـ Redis: نفّذ revokeToken(jti, expiry) التي تخزن الإلغاء بصلاحية تلقائية مطابقة لانتهاء الرمز، وisRevoked(jti) لبحث O(1)، وادمجها في مرشح التحقق من JWT كي تُرفض الرموز الملغاة فورًا."},
    {"id": "4", "description": "نفّذ تدفق تدوير رموز التحديث: مع كل استدعاء /token/refresh، أبطل رمز التحديث المستخدم وأصدر رمزًا جديدًا (تدوير بالاستخدام الواحد)؛ واكتشف هجمات إعادة التشغيل بالتنبيه حين يُقدَّم رمز تحديث دُوِّر بالفعل مرة أخرى."}
  ]
}
-->
