---
id: track-11-lesson-11
title: "أمان الواجهات البرمجية — تحديد المعدّل والتحقق من المدخلات وWAF"
slug: api-security
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 11
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [API-security, WAF, input-validation, rate-limiting, OWASP]
prerequisites: [track-11-lesson-10]
---

# أمان الواجهات — تحديد المعدل، والتحقق من المدخلات، وجدار حماية تطبيقات الويب

> [!NOTE]
> واجهات الدفع أهداف عالية القيمة. فحقل إدخال واحد غير متحقق منه قد يكشف قاعدة بيانات المعاملات كاملة. وغياب تحديد المعدل قد يتيح حشو بيانات الاعتماد أو اختبار البطاقات على نطاق واسع. والدفاع متعدد الطبقات عبر جدار الحماية (WAF)، وبوابة الواجهات، وطبقات التطبيق ليس إفراطًا في الهندسة — بل الحد الأدنى لواجهة خدمة مالية.

## طبقات أمان الواجهات

يجب تطبيق أمان الواجهات المالية على طبقات مستقلة متعددة. فكل طبقة تلتقط فئات هجوم مختلفة، ومعًا توفر دفاعًا متعدد الطبقات.

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
│  → TLS termination (TLS 1.2+, 1.3 preferred)        │
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

## التحقق من المدخلات بـ Bean Validation

يجب أن يكون التحقق من المدخلات شاملًا للواجهات المالية. فكل حقل يصل إلى منطق معالجة الدفع يجب أن يكون قد تحقق منه. وافتراض "البوابة تحققت من هذا" نمط أمني مضاد — تحقق عند كل حد.

### متحققات مخصصة للبيانات المالية

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

### التحقق من طلب الدفع

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

## منع حقن SQL

حقن SQL في أنظمة الدفع كارثي: يستطيع المهاجمون قراءة كل بيانات المعاملات، وتسريب البيانات الشخصية للعملاء، وتعديل أرصدة الحسابات. ويتطلب المنع استخدامًا متسقًا للاستعلامات بالمعاملات.

```java
// NEVER do this — SQL injection via string concatenation
// (Spring Data interface methods and JdbcTemplate code shown side by side
//  for comparison -- in a real project they live in separate classes)
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
        // Parameters bound separately — never concatenated
        return jdbcTemplate.query(sql, transactionRowMapper, accountId, status);
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
    // Column names, sort fields and sort directions CANNOT be bound as
    // parameters: map user input to an allowlist ("date" -> createdAt,
    // "amount" -> amountMinorUnits) instead of inserting it into SQL
}
```

---

## منع الإسناد الجماعي (Mass Assignment)

يتيح الإسناد الجماعي (ويسمى أيضًا الربط التلقائي) للمهاجمين ضبط حقول في نموذج مجالك لم يُقصد أن يضبطها المستخدم.

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

## تحديد معدل الواجهات بـ Redis

يمنع تحديد المعدل: حشو بيانات الاعتماد (تخمين كلمات المرور بالقوة)، واختبار البطاقات (تجربة أرقام بطاقات مسروقة)، وتعداد الحسابات، وكشط الواجهات.

```java
// Fixed-window rate limiter using Redis (simple; it allows up to 2x the
// limit across a window boundary -- use a sliding window or token bucket,
// e.g. Bucket4j with Redis, where that matters)
@Component
public class PaymentApiRateLimiter {

    // Lua script: increment and set the expiry atomically
    private static final RedisScript<Long> INCREMENT_WITH_EXPIRY = RedisScript.of("""
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then
            redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return current
        """, Long.class);

    private final StringRedisTemplate redis;
    private final MeterRegistry meterRegistry;

    // Rate limit definitions for payment API endpoints
    private static final Map<String, RateLimit> LIMITS = Map.of(
        "payment:submit",   new RateLimit(10, Duration.ofMinutes(1)),   // 10 submissions/min
        "payment:status",   new RateLimit(100, Duration.ofMinutes(1)),  // 100 status checks/min
        "account:login",    new RateLimit(5,  Duration.ofMinutes(1)),   // 5 login attempts/min
        "otp:send",         new RateLimit(3,  Duration.ofMinutes(10)),  // 3 OTP sends/10min
        "card:number:view", new RateLimit(2,  Duration.ofHours(1))      // 2 card views/hour
    );

    public PaymentApiRateLimiter(StringRedisTemplate redis, MeterRegistry meterRegistry) {
        this.redis = redis;
        this.meterRegistry = meterRegistry;
    }

    /**
     * @param subject the customer ID for authenticated calls; for login/OTP
     *                the username or the client IP (there is no customer yet)
     * @return true if the request is allowed; false if rate limit exceeded
     */
    public boolean isAllowed(String subject, String operation) {
        RateLimit limit = LIMITS.get(operation);
        if (limit == null) return true;

        String key = "ratelimit:" + operation + ":" + subject;
        Long count = redis.execute(INCREMENT_WITH_EXPIRY,
            List.of(key), String.valueOf(limit.getWindow().getSeconds()));

        // count == null (Redis unavailable): fail CLOSED for payment writes --
        // decide this deliberately per operation
        if (count == null || count > limit.getMaxRequests()) {
            log.warn("Rate limit exceeded: subject={} operation={} count={}",
                subject, operation, count);
            meterRegistry.counter("ratelimit.exceeded", "operation", operation).increment();
            return false;
        }
        return true;
    }
}

// Rate-limit filter. It must run AFTER Spring Security has authenticated the
// request -- a servlet filter ordered before the security chain would never
// see a JwtAuthenticationToken. Register it inside the security chain:
//   http.addFilterAfter(rateLimitFilter, BearerTokenAuthenticationFilter.class);
// (and do NOT also register it as a plain @Component servlet filter)
public class RateLimitFilter extends OncePerRequestFilter {

    private final PaymentApiRateLimiter rateLimiter;

    public RateLimitFilter(PaymentApiRateLimiter rateLimiter) {
        this.rateLimiter = rateLimiter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws IOException, ServletException {

        String operation = resolveOperation(request);
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();

        // Authenticated calls: limit per customer. Unauthenticated calls such
        // as login: limit per client IP (and per username in the login code)
        String subject = (auth instanceof JwtAuthenticationToken jwt)
            ? jwt.getName()
            : request.getRemoteAddr();   // behind a proxy: the trusted X-Forwarded-For value

        if (operation != null && !rateLimiter.isAllowed(subject, operation)) {
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

## إعداد جدار حماية تطبيقات الويب للواجهات المالية

يقع جدار حماية تطبيقات الويب (WAF) على الحافة، قبل وصول الطلبات إلى تطبيقك. ويوفر خط الدفاع الأول ضد أنماط الهجوم الشائعة.

```yaml
# AWS WAF Web ACL for payment API
# (CloudFormation, shortened: every rule also needs a full VisibilityConfig
#  with SampledRequestsEnabled, CloudWatchMetricsEnabled and MetricName)
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
            # Override single rules that cause false positives (the older
            # "ExcludedRules" setting is deprecated)
            RuleActionOverrides:
              - Name: SizeRestrictions_BODY   # bodies > 8 KB
                ActionToUse:
                  Count: {}

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

      # Block traffic from sanctioned jurisdictions (adjust to the sanctions
      # regimes that apply to you: OFAC, UK, EU, UN). Geo-IP blocking is only
      # a supplementary control -- VPNs bypass it; sanctions compliance rests
      # on screening customers, counterparties and transactions
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

## إعداد CORS لتطبيقات الصفحة الواحدة المصرفية

يجب ضبط مشاركة الموارد عبر المصادر (CORS) صراحة. فالافتراضي "السماح لكل المصادر" غير مقبول للواجهات المالية.

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

## إعداد TLS

فضّل TLS 1.3 واسمح بـ TLS 1.2 فقط مع مجموعات تشفير قوية (AEAD، وبسرية أمامية). وTLS 1.3 فقط مناسب للحركة الداخلية والعملاء الحديثين، لكن واجهات الدفع العامة كثيرًا ما يكون لديها شركاء وأجهزة ما زالت تحتاج TLS 1.2 — ويتطلب PCI DSS "تشفيرًا قويًا"، وهو ما يحققه TLS 1.2 مع مجموعات تشفير جيدة. ويجب تعطيل TLS 1.0/1.1.

```yaml
# application.yml — TLS configuration for Spring Boot
server:
  port: 8443
  ssl:
    enabled: true
    key-store: classpath:keystore.p12
    key-store-type: PKCS12
    key-store-password: ${SSL_KEYSTORE_PASSWORD}
    enabled-protocols: TLSv1.3,TLSv1.2   # nothing older
    ciphers:
      # TLS 1.3 suites
      - TLS_AES_256_GCM_SHA384
      - TLS_AES_128_GCM_SHA256
      - TLS_CHACHA20_POLY1305_SHA256
      # TLS 1.2: ECDHE (forward secrecy) + AES-GCM only
      - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
      - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
```

```java
// Programmatic TLS configuration for embedded Tomcat
@Bean
public TomcatServletWebServerFactory servletContainer() {
    TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory();
    factory.addConnectorCustomizers(connector -> {
        AbstractHttp11Protocol<?> protocol =
            (AbstractHttp11Protocol<?>) connector.getProtocolHandler();

        // Internal service: TLS 1.3 only
        protocol.setSslEnabledProtocols("TLSv1.3");

        // Restrict cipher suites explicitly
        protocol.setCiphers("TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256");

        // Prefer the server's cipher order over the client's
        // (HSTS is an HTTP response header -- see Security Headers below)
        protocol.setUseServerCipherSuitesOrder(true);
    });
    return factory;
}
```

---

## ترويسات الأمان

اضبط الترويسات في سلسلة `SecurityFilterChain` الرئيسية **الواحدة** للتطبيق (معروضة هنا منفصلة للوضوح). فسلسلة ثانية دون `securityMatcher` ستطابق كل طلب مثل الأولى، ويرفض Spring Security البدء مع سلسلتين تطابقان كل شيء. وتهم CSP أساسًا لـ HTML/JS بوابة الخدمات المصرفية؛ أما استجابات JSON للواجهات فتحتاج أساسًا `nosniff` وHSTS.

```java
@Configuration
public class SecurityHeadersConfig {

    // Part of the main security configuration
    @Bean
    public SecurityFilterChain apiFilterChain(HttpSecurity http) throws Exception {
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

## الخلاصات الأساسية

- يتطلب أمان الواجهات دفاعًا متعدد الطبقات: WAF ← بوابة الواجهات ← Spring Security ← التحقق في التطبيق؛ وكل طبقة تلتقط فئات هجوم مختلفة
- يجب أن يكون التحقق من المدخلات شاملًا ويستخدم قوائم سماح (السماح بأنماط معروفة الصحة) لا قوائم حظر (منع المعروف السوء) — وللبيانات المالية مثل IBAN، نفّذ التحقق الكامل من المجموع الاختباري، لا فحوص الصيغة فقط
- يتطلب منع حقن SQL استخدامًا متسقًا للاستعلامات بالمعاملات عبر JPA، أو Criteria API، أو المعاملات المسماة — ولا ربط نصوص أبدًا
- يجب أن يستخدم تحديد المعدل مخزنًا مشتركًا مثل Redis للعدادات الموزعة (فالحدود في الذاكرة لكل pod تُتجاوز بتوزيع الطلبات على النسخ)، ويجب أن يعمل بعد المصادقة — أو يعتمد على IP/اسم المستخدم للنقاط غير الموثقة مثل تسجيل الدخول
- يجب أن يكون إعداد CORS قائمة سماح صريحة بالمصادر — لا حرف بدل أبدًا للواجهات المالية
- شفّر من الطرف إلى الطرف بـ TLS 1.2+ ‏(1.3 مفضّل، ومجموعات تشفير قوية فقط)، وأيضًا خلف موازن الحمل — دفاعًا متعدد الطبقات
- يتطلب منع الإسناد الجماعي كائنات DTO مخصصة لكل نقطة واجهة — فلا يجب أبدًا فك تسلسل صنف الكيان مباشرة من أجسام الطلبات

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا يجب أن يستخدم تحديد المعدل لواجهة دفع Redis (أو مخزنًا موزعًا آخر) بدل عدّاد في الذاكرة لكل pod؟",
      "options": ["‏Redis أسرع من العمليات في الذاكرة", "مع نسخ pods متعددة، يتتبع العداد في الذاكرة لكل pod طلبات ذلك الـ pod فقط — فعميل يرسل 100 طلب عبر 10 pods يرى عداد كل pod ‏10 طلبات فقط، فيُبطل تحديد المعدل تمامًا", "يوفر Redis خوارزميات تحديد معدل مدمجة", "لا يستمر تحديد المعدل في الذاكرة عبر إعادة التشغيل"],
      "correct": 1,
      "explanation": "إذا استخدم تحديد المعدل عدادات في الذاكرة لكل pod، يستطيع مهاجم أو عميل سيئ السلوك توزيع طلباته على كل الـ pods لتجنب حد أي pod بمفرده. ويوفر Redis عدادًا مشتركًا واحدًا يعكس بدقة إجمالي معدل طلبات العميل عبر العنقود كاملًا."
    },
    {
      "text": "ما الإسناد الجماعي (mass assignment)، ولماذا هو خطير بشكل خاص في واجهة دفع؟",
      "options": ["إسناد المتغيرات بالجملة لتحسين الأداء", "ربط كل حقول طلب JSON تلقائيًا بخصائص الكيان، فيُحتمل أن يتيح للمستدعين ضبط حقول داخلية مثل accountBalance، أو adminFlag، أو paymentStatus لا يجب أن يتحكم فيها العميل أبدًا", "نوع من هجمات حقن SQL", "إرسال مدفوعات متعددة في طلب واحد"],
      "correct": 1,
      "explanation": "يحدث الإسناد الجماعي حين تُستخدم أصناف الكيانات مباشرة كأهداف لفك التسلسل. فيستطيع المستدعي تضمين أي حقل موجود في الكيان، بما فيها الحقول الداخلية مثل رصيد الحساب، أو حالة المسؤول، أو حالة معالجة الدفع. واستخدام كائنات DTO مخصصة بالحقول التي يجب أن تقبلها الواجهة فقط يمنع ذلك."
    },
    {
      "text": "ما الغرض من حظر الدول الخاضعة لعقوبات OFAC في إعداد جدار حماية تطبيقات الويب لواجهة دفع؟",
      "options": ["تحسين أداء الواجهة بتقليل الحركة", "دعم الامتثال للوائح العقوبات (مثل OFAC الأمريكي) التي تحظر التعامل مع النطاقات الخاضعة للعقوبات مثل كوريا الشمالية، وإيران، وكوبا، وسوريا — كضابط مكمّل إلى جانب فحص العملاء والمعاملات", "منع حقن SQL من عناوين IP أجنبية", "تلبية متطلبات PCI DSS للبيانات الجغرافية"],
      "correct": 1,
      "explanation": "تحظر عقوبات OFAC ‏(مكتب مراقبة الأصول الأجنبية) على الأشخاص والمؤسسات المالية الأمريكية التعامل مع الدول والأطراف الخاضعة للعقوبات؛ وتطبق أنظمة المملكة المتحدة والاتحاد الأوروبي والأمم المتحدة قواعد مشابهة. وحظر الحركة من المناطق الخاضعة للعقوبات في جدار الحماية يقلل التعرض، لكن تجاوزه سهل بالشبكات الافتراضية الخاصة (VPN) — فالامتثال الحقيقي يأتي من فحص العملاء والأطراف المقابلة والمدفوعات مقابل قوائم العقوبات في التطبيق."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "أمان واجهات متعدد الطبقات لنقاط الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "نفّذ تحققًا شاملًا من المدخلات لنقطة إرسال دفع: التحقق من المجموع الاختباري لـ IBAN ‏(Modulo-97)، والتحقق من نطاق المبلغ (موجب، وبحد أقصى خانتان عشريتان، وتحت حد قابل للضبط)، وتعبير نمطي بقائمة سماح لمرجع الدفع، وكائن DTO مخصص PaymentRequest لا يستطيع ربط حقول الكيان الداخلية."},
    {"id": "2", "description": "ابنِ محدد معدل بنافذة منزلقة مدعومًا بـ Redis كمرشح Spring: ‏100 طلب في الدقيقة لكل عميل لنقاط GET، و10 إرسالات دفع في الدقيقة لكل عميل لـ POST /payments، مع ترويسات Retry-After في استجابات 429 وعداد Prometheus يتتبع أحداث تحديد المعدل حسب فئة العميل."},
    {"id": "3", "description": "اضبط Spring Security بـ TLS 1.2+ ‏(TLS 1.3 مفضّل، ومجموعات تشفير قوية فقط)، وHSTS بعمر أقصى سنة يشمل النطاقات الفرعية، وContent-Security-Policy لتطبيق الصفحة الواحدة لبوابة الدفع، وCORS مقصور على نطاقات الإنتاج الصريحة فقط، وX-Frame-Options: DENY — كلها في SecurityFilterChain واحدة."},
    {"id": "4", "description": "اكتب قواعد AWS WAF (كـ CDK أو CloudFormation) تمنع SQLi وXSS على كل معاملات الاستعلام وجسم الطلب، وتحدّ المعدل حسب IP إلى 2000 طلب كل 5 دقائق، وتحظر الدول الخاضعة لعقوبات OFAC، وتطبق مجموعة القواعد المُدارة الشائعة من AWS — ثم اكتب مرشح مقاييس CloudWatch ينبّه حين تتجاوز الطلبات المحظورة من WAF ‏100 في الدقيقة."}
  ]
}
-->
