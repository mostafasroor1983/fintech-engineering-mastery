---
id: track-13-lesson-11
title: "API Security — Rate Limiting, Input Validation, and WAF"
slug: api-security
track: track-13
trackName: "Security & Observability"
sequence: 11
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [API-security, WAF, input-validation, rate-limiting, OWASP]
prerequisites: [track-13-lesson-10]
---

# API Security — Rate Limiting, Input Validation, and WAF

> [!NOTE]
> Payment APIs are high-value targets. A single unvalidated input field can expose the entire transaction database. A missing rate limit can enable credential stuffing or card testing at scale. Defense-in-depth across WAF, API gateway, and application layers is not over-engineering—it is the minimum bar for a financial service API.

## API Security Layers

Security for financial APIs must be applied at multiple independent layers. Each layer catches different attack classes, and together they provide defense-in-depth.

```
Internet
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  WAF (AWS WAF / Cloudflare / ModSecurity)            │
│  → Block SQLi, XSS, path traversal, SSRF at edge    │
│  → Geographic restrictions, IP reputation           │
│  → Rate limiting at the edge (IP-level)             │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  API Gateway (Kong / AWS API Gateway / Nginx)        │
│  → TLS termination (TLS 1.3 only)                   │
│  → JWT validation at gateway level                  │
│  → Rate limiting per client/API key                 │
│  → Request/response logging                         │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Spring Security Filter Chain                        │
│  → OAuth2 token validation                          │
│  → Scope and role-based authorisation               │
│  → CORS policy enforcement                          │
└─────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Application Layer (Spring Boot)                     │
│  → Bean Validation (input validation)               │
│  → Business logic authorisation (can this user      │
│    access this specific account?)                   │
│  → JPA parameterised queries (SQL injection)        │
│  → Output sanitisation                              │
└─────────────────────────────────────────────────────┘
```

---

## Input Validation with Bean Validation

Input validation must be exhaustive for financial APIs. Every field that reaches your payment processing logic must have been validated. The assumption "the gateway validated this" is a security anti-pattern—validate at every boundary.

### Custom Validators for Financial Data

```java
// Custom IBAN validator
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = IbanValidator.class)
public @interface ValidIban {
    String message() default "Invalid IBAN format";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

public class IbanValidator implements ConstraintValidator<ValidIban, String> {
    // Whitelist: only characters allowed in an IBAN
    private static final Pattern IBAN_CHARACTERS = Pattern.compile("^[A-Z]{2}[0-9A-Z]+$");
    // Country-specific length map (partial)
    private static final Map<String, Integer> COUNTRY_LENGTHS = Map.of(
        "GB", 22, "DE", 22, "FR", 27, "NL", 18, "ES", 24, "IT", 27
    );

    @Override
    public boolean isValid(String iban, ConstraintValidatorContext context) {
        if (iban == null) return false;
        // Strip spaces (IBANs often presented with spaces)
        String normalized = iban.replaceAll("\\s+", "").toUpperCase();

        // Structural validation
        if (normalized.length() < 15 || normalized.length() > 34) return false;
        if (!IBAN_CHARACTERS.matcher(normalized).matches()) return false;

        // Country-specific length check
        String countryCode = normalized.substring(0, 2);
        Integer expectedLength = COUNTRY_LENGTHS.get(countryCode);
        if (expectedLength != null && normalized.length() != expectedLength) return false;

        // Mod-97 checksum validation (ISO 7064)
        return validateMod97(normalized);
    }

    private boolean validateMod97(String iban) {
        // Move first 4 chars to end, replace letters with numbers (A=10, B=11...)
        String rearranged = iban.substring(4) + iban.substring(0, 4);
        StringBuilder numericIban = new StringBuilder();
        for (char c : rearranged.toCharArray()) {
            if (Character.isLetter(c)) {
                numericIban.append(c - 'A' + 10);
            } else {
                numericIban.append(c);
            }
        }
        // Mod-97 check: result must be 1
        java.math.BigInteger numeric = new java.math.BigInteger(numericIban.toString());
        return numeric.remainder(java.math.BigInteger.valueOf(97)).intValue() == 1;
    }
}

// Custom amount validator
@Target({ElementType.FIELD})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = MonetaryAmountValidator.class)
public @interface ValidMonetaryAmount {
    String message() default "Invalid monetary amount";
    long minAmount() default 1;      // in minor units (pence/cents)
    long maxAmount() default 1_000_000_00; // £10,000 default limit
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
```

### Payment Request Validation

```java
@Data
public class PaymentSubmissionRequest {

    @NotNull(message = "Source account is required")
    @Pattern(
        regexp = "^ACC-[A-Z0-9]{8,20}$",
        message = "Invalid account ID format"
    )
    private String sourceAccountId;

    @NotNull(message = "Destination IBAN is required")
    @ValidIban
    private String destinationIban;

    @NotNull(message = "Amount is required")
    @ValidMonetaryAmount(minAmount = 1, maxAmount = 1_000_000_00)
    private Long amountMinorUnits;  // Always use minor units (pence/cents) — no floating point

    @NotNull(message = "Currency is required")
    @Pattern(
        regexp = "^[A-Z]{3}$",
        message = "Currency must be 3-letter ISO 4217 code"
    )
    private String currencyCode;

    @NotNull(message = "Reference is required")
    @Size(min = 1, max = 18, message = "Payment reference must be 1-18 characters")
    @Pattern(
        regexp = "^[a-zA-Z0-9 \\-./+:?(),']+$",
        message = "Reference contains invalid characters"
    )
    private String reference;

    // NEVER expose internal fields in the API
    // These should not be in the request body — use @JsonIgnore if they sneak in
    @JsonIgnore
    private String internalProcessingId;

    @JsonIgnore
    private String adminOverrideFlag;
}

@RestController
@RequestMapping("/api/v1/payments")
@Validated
public class PaymentController {

    @PostMapping
    public ResponseEntity<PaymentResponse> submitPayment(
            @Valid @RequestBody PaymentSubmissionRequest request,
            BindingResult bindingResult) {

        if (bindingResult.hasErrors()) {
            // Return structured validation errors — but sanitise them
            // Never echo user input back in error messages (reflected XSS risk)
            List<String> errors = bindingResult.getFieldErrors().stream()
                .map(e -> e.getField() + ": " + e.getDefaultMessage())
                .collect(Collectors.toList());
            return ResponseEntity.badRequest().body(
                new ErrorResponse("VALIDATION_FAILED", errors)
            );
        }

        return ResponseEntity.ok(paymentService.submit(request));
    }
}
```

---

## SQL Injection Prevention

SQL injection in payment systems is catastrophic: attackers can read all transaction data, exfiltrate customer PII, modify account balances. Prevention requires consistent use of parameterised queries.

```java
// NEVER do this — SQL injection via string concatenation
@Repository
public class TransactionRepository {

    // WRONG — CRITICAL VULNERABILITY
    public List<Transaction> search(String accountId, String status) {
        String sql = "SELECT * FROM transactions WHERE account_id = '" + accountId
            + "' AND status = '" + status + "'";
        // Attacker can pass: accountId = "' OR '1'='1"
        // Result: returns all transactions for all customers
        return jdbcTemplate.query(sql, ...);
    }

    // CORRECT — parameterised query (JPA/JPQL)
    // Spring Data JPA generates parameterised queries automatically
    List<Transaction> findByAccountIdAndStatus(String accountId, TransactionStatus status);

    // CORRECT — native query with named parameters
    @Query(
        value = "SELECT * FROM transactions WHERE account_id = :accountId AND status = :status",
        nativeQuery = true
    )
    List<Transaction> searchNative(
        @Param("accountId") String accountId,
        @Param("status") String status
    );

    // CORRECT — JdbcTemplate with parameterised query
    public List<Transaction> searchWithJdbc(String accountId, String status) {
        String sql = "SELECT * FROM transactions WHERE account_id = ? AND status = ?";
        return jdbcTemplate.query(sql,
            new Object[]{accountId, status},  // Parameters bound separately — never concatenated
            transactionRowMapper
        );
    }

    // CORRECT — Criteria API for dynamic queries
    public List<Transaction> searchDynamic(TransactionSearchCriteria criteria) {
        CriteriaBuilder cb = entityManager.getCriteriaBuilder();
        CriteriaQuery<Transaction> query = cb.createQuery(Transaction.class);
        Root<Transaction> root = query.from(Transaction.class);

        List<Predicate> predicates = new ArrayList<>();
        if (criteria.getAccountId() != null) {
            predicates.add(cb.equal(root.get("accountId"), criteria.getAccountId()));
        }
        if (criteria.getStatus() != null) {
            predicates.add(cb.equal(root.get("status"), criteria.getStatus()));
        }
        if (criteria.getFromDate() != null) {
            predicates.add(cb.greaterThanOrEqualTo(root.get("createdAt"), criteria.getFromDate()));
        }

        query.where(predicates.toArray(new Predicate[0]));
        return entityManager.createQuery(query).getResultList();
    }
}
```

---

## Mass Assignment Prevention

Mass assignment (also called auto-binding) allows attackers to set fields in your domain model that were not intended to be user-settable.

```java
// WRONG — entire entity bound from request body
// Attacker can POST {"balance": 1000000, "isAdmin": true, "accountStatus": "PREMIUM"}
@PostMapping("/accounts/{id}")
public Account updateAccount(@RequestBody Account account) {
    return accountRepository.save(account);  // DANGEROUS
}

// CORRECT — use a dedicated DTO that only exposes what users can change
@Data
public class UpdateAccountRequest {
    // Only the fields users are allowed to modify
    @Size(max = 50)
    private String displayName;

    @Email
    private String contactEmail;

    @Pattern(regexp = "^\\+[1-9][0-9]{7,14}$")
    private String phoneNumber;

    // These fields are NOT here — they cannot be submitted:
    // balance, accountNumber, sortCode, isAdmin, kycStatus, creditLimit
}

@PutMapping("/accounts/{id}")
@PreAuthorize("hasAuthority('SCOPE_accounts:write')")
public ResponseEntity<AccountResponse> updateAccount(
        @PathVariable String id,
        @Valid @RequestBody UpdateAccountRequest request,
        @AuthenticationPrincipal Jwt jwt) {

    String customerId = jwt.getClaimAsString("customer_id");

    // Authorisation: verify the account belongs to this customer
    Account account = accountRepository.findByIdAndCustomerId(id, customerId)
        .orElseThrow(() -> new ResourceNotFoundException("Account not found"));

    // Apply only the allowed updates — not the entire request object
    account.setDisplayName(request.getDisplayName());
    account.setContactEmail(request.getContactEmail());
    account.setPhoneNumber(request.getPhoneNumber());
    // balance, accountNumber, etc. cannot be changed via this endpoint

    return ResponseEntity.ok(toResponse(accountRepository.save(account)));
}
```

---

## API Rate Limiting with Redis

Rate limiting prevents: credential stuffing (brute-forcing passwords), card testing (trying stolen card numbers), account enumeration, and API scraping.

```java
// Token bucket rate limiter using Redis
@Component
public class PaymentApiRateLimiter {

    private final RedisTemplate<String, String> redis;

    // Rate limit definitions for payment API endpoints
    private static final Map<String, RateLimit> LIMITS = Map.of(
        "payment:submit",   new RateLimit(10, Duration.ofMinutes(1)),   // 10 submissions/min
        "payment:status",   new RateLimit(100, Duration.ofMinutes(1)),  // 100 status checks/min
        "account:login",    new RateLimit(5,  Duration.ofMinutes(1)),   // 5 login attempts/min
        "otp:send",         new RateLimit(3,  Duration.ofMinutes(10)),  // 3 OTP sends/10min
        "card:number:view", new RateLimit(2,  Duration.ofHours(1))      // 2 card views/hour
    );

    /**
     * @return true if the request is allowed; false if rate limit exceeded
     */
    public boolean isAllowed(String customerId, String operation) {
        RateLimit limit = LIMITS.get(operation);
        if (limit == null) return true;

        String key = "ratelimit:" + operation + ":" + customerId;

        // Atomic increment with expiry (using Lua script for atomicity)
        Long count = redis.execute(
            incrementWithExpiry,
            Collections.singletonList(key),
            String.valueOf(limit.getMaxRequests()),
            String.valueOf(limit.getWindow().getSeconds())
        );

        if (count == null || count > limit.getMaxRequests()) {
            log.warn("Rate limit exceeded: customerId={} operation={} count={}",
                customerId, operation, count);
            rateLimitExceededCounter.increment(Tags.of("operation", operation));
            return false;
        }

        return true;
    }
}

// Lua script for atomic increment + set expiry
// This ensures the counter and expiry are set atomically
private static final RedisScript<Long> incrementWithExpiry = RedisScript.of("""
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[2])
    end
    return current
    """, Long.class);

// Spring MVC filter applying rate limits
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class RateLimitFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws IOException, ServletException {

        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!(auth instanceof JwtAuthenticationToken)) {
            chain.doFilter(request, response);
            return;
        }

        String customerId = ((JwtAuthenticationToken) auth).getName();
        String operation = resolveOperation(request);

        if (operation != null && !rateLimiter.isAllowed(customerId, operation)) {
            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader("Retry-After", "60");
            response.setContentType("application/json");
            response.getWriter().write("""
                {"error": "RATE_LIMIT_EXCEEDED",
                 "message": "Too many requests. Please try again in 60 seconds."}
                """);
            return;
        }

        chain.doFilter(request, response);
    }
}
```

---

## WAF Configuration for Financial APIs

A Web Application Firewall sits at the edge, before requests reach your application. It provides the first line of defence against common attack patterns.

```yaml
# AWS WAF Web ACL for payment API
# (CDK/CloudFormation representation)
PaymentApiWebAcl:
  Type: AWS::WAFv2::WebACL
  Properties:
    Name: PaymentApiWAF
    Scope: REGIONAL
    DefaultAction:
      Allow: {}
    Rules:
      # Block SQL injection attempts
      - Name: SQLInjectionProtection
        Priority: 1
        Action:
          Block: {}
        Statement:
          SqliMatchStatement:
            FieldToMatch:
              AllQueryArguments: {}
            TextTransformations:
              - Priority: 0
                Type: URL_DECODE
              - Priority: 1
                Type: HTML_ENTITY_DECODE
        VisibilityConfig:
          MetricName: SQLInjectionBlocked

      # Block XSS attempts
      - Name: XSSProtection
        Priority: 2
        Action:
          Block: {}
        Statement:
          XssMatchStatement:
            FieldToMatch:
              Body:
                OversizeHandling: CONTINUE
            TextTransformations:
              - Priority: 0
                Type: URL_DECODE

      # AWS Managed Rules — covers OWASP Top 10
      - Name: AWSManagedRulesCommonRuleSet
        Priority: 3
        OverrideAction:
          None: {}
        Statement:
          ManagedRuleGroupStatement:
            VendorName: AWS
            Name: AWSManagedRulesCommonRuleSet
            ExcludedRules:
              # Exclude rules that cause false positives for JSON payloads
              - Name: SizeRestrictions_BODY

      # Rate limit by IP — catches automated attacks
      - Name: IPRateLimitRule
        Priority: 4
        Action:
          Block: {}
        Statement:
          RateBasedStatement:
            Limit: 2000           # 2000 requests per 5 minutes per IP
            AggregateKeyType: IP
        VisibilityConfig:
          MetricName: IPRateLimitBlocked

      # Block access from high-risk countries (adjust per your compliance requirements)
      - Name: GeoBlockHighRisk
        Priority: 5
        Action:
          Block: {}
        Statement:
          GeoMatchStatement:
            CountryCodes:
              - "KP"  # North Korea (OFAC sanctioned)
              - "IR"  # Iran (OFAC sanctioned)
              - "CU"  # Cuba (OFAC sanctioned)
              - "SY"  # Syria (OFAC sanctioned)
        VisibilityConfig:
          MetricName: GeoBlocked
```

---

## CORS Configuration for Banking SPAs

Cross-Origin Resource Sharing must be explicitly configured. The default "allow all origins" is unacceptable for financial APIs.

```java
@Configuration
public class CorsConfig {

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();

        // Explicit allowlist — never use setAllowedOriginPatterns("*") for financial APIs
        config.setAllowedOrigins(List.of(
            "https://app.payments.example.com",
            "https://business.payments.example.com"
            // No localhost in production — use feature flags or separate config for dev
        ));

        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));

        config.setAllowedHeaders(List.of(
            "Authorization",
            "Content-Type",
            "X-Request-Id",
            "X-Idempotency-Key"
        ));

        // Allow credentials (required for cookies)
        config.setAllowCredentials(true);

        // Cache preflight for 1 hour
        config.setMaxAge(3600L);

        // Do NOT expose internal headers to the browser
        config.setExposedHeaders(List.of("X-Request-Id", "X-Rate-Limit-Remaining"));

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
```

---

## TLS 1.3 Enforcement

```yaml
# application.yml — TLS configuration for Spring Boot
server:
  port: 8443
  ssl:
    enabled: true
    key-store: classpath:keystore.p12
    key-store-type: PKCS12
    key-store-password: ${SSL_KEYSTORE_PASSWORD}
    enabled-protocols: TLSv1.3    # Only TLS 1.3 — reject TLS 1.2 and below
    ciphers:
      # TLS 1.3 cipher suites (automatically negotiated by JVM 11+)
      - TLS_AES_256_GCM_SHA384
      - TLS_AES_128_GCM_SHA256
      - TLS_CHACHA20_POLY1305_SHA256
```

```java
// Programmatic TLS configuration for embedded Tomcat
@Bean
public TomcatServletWebServerFactory servletContainer() {
    TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory();
    factory.addConnectorCustomizers(connector -> {
        AbstractHttp11Protocol<?> protocol =
            (AbstractHttp11Protocol<?>) connector.getProtocolHandler();

        // Enforce TLS 1.3 only
        protocol.setSslEnabledProtocols("TLSv1.3");

        // Disable weak cipher suites explicitly
        protocol.setCiphers("TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256");

        // Enable HSTS (HTTP Strict Transport Security)
        // Browser will refuse HTTP connections for 1 year
        protocol.setUseServerCipherSuitesOrder(true);
    });
    return factory;
}
```

---

## Security Headers

```java
@Configuration
public class SecurityHeadersConfig {

    @Bean
    public SecurityFilterChain headerFilterChain(HttpSecurity http) throws Exception {
        http.headers(headers -> headers
            // Prevents clickjacking
            .frameOptions(frame -> frame.deny())
            // Forces HTTPS for 1 year, includes subdomains
            .httpStrictTransportSecurity(hsts -> hsts
                .maxAgeInSeconds(31536000)
                .includeSubdomains(true)
                .preload(true)
            )
            // Prevents MIME type sniffing
            .contentTypeOptions(Customizer.withDefaults())
            // Content Security Policy
            .contentSecurityPolicy(csp -> csp
                .policyDirectives(
                    "default-src 'self'; " +
                    "script-src 'self'; " +
                    "style-src 'self'; " +
                    "img-src 'self' data:; " +
                    "font-src 'self'; " +
                    "connect-src 'self' https://auth.payments.example.com; " +
                    "frame-ancestors 'none'; " +
                    "form-action 'self'; " +
                    "upgrade-insecure-requests"
                )
            )
            // Referrer policy
            .referrerPolicy(referrer -> referrer
                .policy(ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN)
            )
        );
        return http.build();
    }
}
```

---

## Key Takeaways

- API security requires defense-in-depth: WAF → API gateway → Spring Security → application validation; each layer catches different attack classes
- Input validation must be exhaustive and use whitelists (allow known-good patterns) not blacklists (block known-bad)—for financial data like IBANs, implement full checksum validation, not just format checks
- SQL injection prevention requires consistent use of parameterised queries via JPA, Criteria API, or named parameters—never string concatenation
- Rate limiting must use Redis for distributed counters (in-memory per-pod limits are useless with multiple replicas)
- CORS configuration must be an explicit allowlist of origins—never wildcard for financial APIs
- Enforce TLS 1.3 at the application layer even if the load balancer terminates TLS—defence in depth
- Mass assignment prevention requires dedicated DTOs for every API endpoint—the entity class should never be directly deserialized from request bodies

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why must rate limiting for a payment API use Redis (or another distributed store) rather than an in-memory counter per pod?",
      "options": ["Redis is faster than in-memory operations", "With multiple pod replicas, an in-memory counter per pod tracks only that pod's requests — a client sending 100 requests across 10 pods sees only 10 requests per pod counter, completely defeating the rate limit", "Redis provides built-in rate limiting algorithms", "In-memory rate limiting does not persist across restarts"],
      "correct": 1,
      "explanation": "If rate limiting uses per-pod in-memory counters, an attacker or a misbehaving client can distribute their requests across all pods to avoid any single pod's limit. Redis provides a single shared counter that accurately reflects the total request rate from a customer across the entire cluster."
    },
    {
      "text": "What is mass assignment, and why is it particularly dangerous in a payment API?",
      "options": ["Assigning variables in bulk for performance", "Automatically binding all JSON request fields to entity properties, potentially allowing callers to set internal fields like accountBalance, adminFlag, or paymentStatus that should never be client-controlled", "A type of SQL injection attack", "Sending multiple payments in a single request"],
      "correct": 1,
      "explanation": "Mass assignment occurs when entity classes are used directly as deserialization targets. A caller can include any field that exists on the entity, including internal fields like account balance, admin status, or payment processing status. Using dedicated DTOs with only the fields the API should accept prevents this."
    },
    {
      "text": "What is the purpose of OFAC-sanctioned country blocking in a payment API WAF configuration?",
      "options": ["To improve API performance by reducing traffic", "To comply with US OFAC sanctions regulations that prohibit financial transactions with sanctioned countries like North Korea, Iran, Cuba, and Syria", "To prevent SQL injection from foreign IP addresses", "To satisfy PCI DSS geographic data requirements"],
      "correct": 1,
      "explanation": "OFAC (Office of Foreign Assets Control) sanctions regulations prohibit US persons and financial institutions from processing transactions involving sanctioned countries. Blocking at the WAF layer provides a first line of compliance control, though application-level controls for party screening are also required for complete OFAC compliance."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Defense-in-Depth API Security for Payment Endpoints",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "Implement comprehensive input validation for a payment submission endpoint: IBAN checksum validation (Modulo-97), amount range validation (positive, max 2 decimal places, below configurable limit), payment reference whitelist regex, and a dedicated PaymentRequest DTO that cannot bind internal entity fields."},
    {"id": "2", "description": "Build a Redis-backed sliding window rate limiter as a Spring filter: 100 requests per minute per customer for GET endpoints, 10 payment submissions per minute per customer for POST /payments, with Retry-After headers on 429 responses and a Prometheus counter tracking rate limit events by customer tier."},
    {"id": "3", "description": "Configure Spring Security to enforce TLS 1.3 only, set HSTS with 1-year max-age including subdomains, configure Content-Security-Policy for a payment portal SPA, restrict CORS to explicit production domains only, and add X-Frame-Options: DENY."},
    {"id": "4", "description": "Write AWS WAF rules (as CDK or CloudFormation) that block SQLi and XSS on all query parameters and request body, rate-limit by IP to 2000 requests per 5 minutes, block OFAC-sanctioned countries, and apply the AWS Managed Rules Common Rule Set — then write a CloudWatch metric filter that alerts when WAF-blocked requests exceed 100 per minute."}
  ]
}
-->
