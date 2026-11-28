---
id: track-11-lesson-13
title: "OWASP Top 10 — مشهد التهديدات في الخدمات المالية"
slug: owasp-top-10-fintech
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 13
difficulty: advanced
estimatedMinutes: 70
status: published
tags:
  - OWASP
  - SQL-injection
  - broken-access-control
  - SSRF
  - cryptographic-failures
  - fintech
prerequisites:
  - track-11-lesson-12
---

# ‏OWASP Top 10 — مشهد التهديدات في الخدمات المالية

قائمة OWASP Top 10 ليست قائمة ثغرات نظرية — ففي التقنية المالية، سببت كل فئة فيها خسائر مالية حقيقية. فالتحكم المعطوب في الوصول يكشف سجلات مدفوعات العملاء. وحقن SQL يسرّب بيانات اعتماد الحسابات. وSSRF يتيح للمهاجمين التنقل إلى الأنظمة الداخلية من معالج webhook. ويربط هذا الدرس كل فئة من OWASP Top 10 بسيناريوهات هجوم ملموسة في التقنية المالية، ويعرض كود Java المعرّض للثغرة، ويقدم الإصلاح بجودة الإنتاج.

> [!NOTE]
> يتبع الدرس إصدار 2021 من OWASP Top 10، الذي ما زالت معظم الأدوات والتدقيقات تشير إليه. ويعيد إصدار 2025 تنظيم القائمة — فمثلًا تحصل إخفاقات سلسلة توريد البرمجيات على فئة خاصة بها ويُدمج SSRF في التحكم المعطوب في الوصول — لكن الهجمات والإصلاحات أدناه تبقى كما هي.

---

## ‏A01: التحكم المعطوب في الوصول

الثغرة الأكثر شيوعًا في OWASP والأخطر في سياق الدفع. ويحدث تصعيد الصلاحيات الأفقي حين يستطيع مستخدم الوصول إلى موارد مستخدم آخر بتخمين معرّفات الموارد أو تعدادها.

### كود معرّض للثغرة — تصعيد صلاحيات أفقي

يصادق مستخدم كـ `user-A` لكنه يغيّر معامل المسار `{id}` لعرض سجل مدفوعات `user-B`. ولا يتحقق المتحكم من الملكية.

```java
// VULNERABLE — no ownership check
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    @Autowired
    private PaymentRepository paymentRepository;

    @GetMapping("/{id}")
    public ResponseEntity<Payment> getPayment(@PathVariable String id) {
        // Fetches any payment by ID regardless of who is calling
        return paymentRepository.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
        // User A can call /api/v1/payments/txn-user-B-9999 and see user B's payment
    }

    @GetMapping
    public List<Payment> getAllPayments() {
        // Returns ALL payments — no filtering by authenticated user
        return paymentRepository.findAll();
    }
}
```

### الكود المُصلح — ‏@PreAuthorize في Spring Security

```java
// FIXED — ownership check using Spring Security SpEL + custom security bean
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    @Autowired
    private PaymentRepository paymentRepository;

    @GetMapping("/{id}")
    @PreAuthorize("@paymentSecurity.isOwner(#id, authentication)")
    public ResponseEntity<Payment> getPayment(
            @PathVariable String id,
            Authentication authentication) {
        return paymentRepository.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<Payment> getMyPayments(Authentication authentication) {
        // Only return payments belonging to the authenticated user.
        // getName() works for every authentication type -- with an OAuth2
        // resource server the principal is a Jwt, not a UserDetails
        String userId = authentication.getName();
        return paymentRepository.findByUserId(userId);
    }
}

@Component("paymentSecurity")
public class PaymentSecurityEvaluator {

    @Autowired
    private PaymentRepository paymentRepository;

    public boolean isOwner(String paymentId, Authentication authentication) {
        String currentUserId = authentication.getName();
        return paymentRepository.findById(paymentId)
            .map(payment -> payment.getUserId().equals(currentUserId))
            .orElse(false);  // return false if payment not found (don't expose existence)
    }
}
```

---

## ‏A02: إخفاقات التشفير

يجب ألا تظهر البيانات المالية الحساسة أبدًا كنص صريح في السجلات، أو رسائل الخطأ، أو قواعد البيانات. فرقم الحساب الأساسي (PAN) في سجلات التطبيق مخالفة لـ PCI-DSS وقد يكشف بيانات البطاقات لأي مستخدم لنظام تجميع السجلات.

### كود معرّض للثغرة — تسجيل PAN كنص صريح

```java
// VULNERABLE — PAN written to logs and stored unmasked
@Service
public class CardProcessingService {

    private static final Logger log = LoggerFactory.getLogger(CardProcessingService.class);

    public AuthorisationResult authorise(CardPaymentRequest request) {
        // PAN appears in logs — violates PCI-DSS Requirement 3
        log.info("Processing card payment for PAN: {}", request.getCardNumber());
        log.error("Payment failed for card: {} amount: {}", request.getCardNumber(), request.getAmount());

        // PAN stored in plaintext in audit table
        auditRepository.save(new AuditEntry(
            request.getCardNumber(),   // raw PAN — PCI violation
            request.getAmount(),
            "AUTHORISATION_ATTEMPT"
        ));

        return cardNetwork.authorise(request);
    }
}
```

### الكود المُصلح — الإخفاء والترميز (Tokenisation)

```java
// FIXED — PAN masked in logs, tokenised in storage
@Service
public class CardProcessingService {

    private static final Logger log = LoggerFactory.getLogger(CardProcessingService.class);
    private final TokenisationService tokenisationService;

    public AuthorisationResult authorise(CardPaymentRequest request) {
        String maskedPan = maskPan(request.getCardNumber());

        // Only the masked PAN appears in logs: "************1234"
        log.info("Processing card payment for PAN: {}", maskedPan);

        // Replace PAN with a vault token before persisting
        String panToken = tokenisationService.tokenise(request.getCardNumber());

        auditRepository.save(new AuditEntry(
            panToken,                 // token, not raw PAN
            request.getAmount(),
            "AUTHORISATION_ATTEMPT"
        ));

        try {
            return cardNetwork.authorise(request);
        } catch (CardNetworkException ex) {
            // Error logs also use masked PAN
            log.error("Payment failed for PAN: {} reason: {}", maskedPan, ex.getDeclineCode());
            throw ex;
        }
    }

    private String maskPan(String pan) {
        if (pan == null || pan.length() < 4) return "****";
        return "*".repeat(pan.length() - 4) + pan.substring(pan.length() - 4);
    }
}
```

---

## ‏A03: الحقن

يتيح حقن SQL في عمليات البحث عن الحسابات للمهاجم استخراج كل بيانات الحسابات أو تجاوز المصادقة كليًا. والسبب الجذري هو ربط النصوص داخل استعلامات SQL.

### كود معرّض للثغرة — حقن SQL عبر الربط

```java
// VULNERABLE — SQL injection via string concatenation
@Repository
public class AccountRepositoryRaw {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    public Account findByAccountNumber(String accountNumber) {
        // Attacker passes: "' OR '1'='1" to retrieve all accounts
        // Or: "'; DROP TABLE accounts; --"
        String sql = "SELECT * FROM accounts WHERE account_number = '" + accountNumber + "'";
        return jdbcTemplate.queryForObject(sql, new AccountRowMapper());
    }

    public List<Account> searchByName(String name) {
        // Attacker passes: "'; SELECT * FROM users; --"
        String sql = "SELECT * FROM accounts WHERE customer_name LIKE '%" + name + "%'";
        return jdbcTemplate.query(sql, new AccountRowMapper());
    }
}
```

### الكود المُصلح — الاستعلامات بالمعاملات

```java
// FIXED — parameterised queries prevent injection
@Repository
public class AccountRepository {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    public Optional<Account> findByAccountNumber(String accountNumber) {
        // Parameter binding: SQL structure is fixed, data is never interpreted as SQL
        String sql = "SELECT account_id, customer_id, account_number, balance, currency " +
                     "FROM accounts WHERE account_number = ?";
        try {
            Account account = jdbcTemplate.queryForObject(sql,
                new AccountRowMapper(),
                accountNumber);    // bound as a parameter, never concatenated
            return Optional.ofNullable(account);
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    public List<Account> searchByName(String name) {
        // Use PreparedStatement with LIKE — the % characters are in the parameter
        String sql = "SELECT * FROM accounts WHERE customer_name ILIKE ?";
        return jdbcTemplate.query(sql,
            new AccountRowMapper(),
            "%" + name.replace("%", "\\%").replace("_", "\\_") + "%"
        );
    }
}
```

---

## ‏A04: التصميم غير الآمن

يمكن استغلال عيوب منطق الأعمال في أنظمة الدفع لاستنزاف الحسابات أو تجاوز حدود المعاملات. وهذه ليست أخطاء برمجة — بل إخفاقات تصميم تتيح عمليات لا يجب أن يسمح بها النظام أبدًا.

### كود معرّض للثغرة — التحويل إلى النفس وغياب فحص الحدود

```java
// VULNERABLE — no business rule validation
@Service
public class TransferService {

    public TransferResult transfer(TransferRequest request) {
        // No check: can a user transfer to themselves?
        // This can be used to generate fake transaction volume or exploit
        // loyalty/cashback systems that reward transfers

        // No daily limit check — can transfer unlimited amount
        Account source = accountRepository.findById(request.getSourceAccountId());
        Account dest   = accountRepository.findById(request.getDestAccountId());

        source.setBalance(source.getBalance().subtract(request.getAmount()));
        dest.setBalance(dest.getBalance().add(request.getAmount()));

        accountRepository.save(source);
        accountRepository.save(dest);

        return TransferResult.success();
    }
}
```

### الكود المُصلح — التحقق من قواعد الأعمال

```java
// FIXED — comprehensive business rule enforcement
@Service
public class TransferService {

    private static final BigDecimal DAILY_LIMIT = new BigDecimal("10000.00");

    @Transactional
    public TransferResult transfer(TransferRequest request, String authenticatedUserId) {

        // Rule 0: amount must be positive -- check FIRST (a negative amount
        // would otherwise "pass" the balance and limit checks)
        if (request.getAmount().compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessRuleViolationException("INVALID_AMOUNT", "Transfer amount must be positive");
        }

        // Rule 1: prevent self-transfer
        if (request.getSourceAccountId().equals(request.getDestAccountId())) {
            throw new BusinessRuleViolationException(
                "SELF_TRANSFER_PROHIBITED",
                "Transfer source and destination accounts must be different"
            );
        }

        // SELECT ... FOR UPDATE: lock the source account row, so two parallel
        // transfers cannot both pass the balance and daily-limit checks
        // (check-then-act race)
        Account source = accountRepository.findByIdAndOwnerIdForUpdate(
            request.getSourceAccountId(), authenticatedUserId
        ).orElseThrow(() -> new AccessDeniedException("Account not found or not owned by caller"));

        // Rule 2: sufficient balance check
        if (source.getBalance().compareTo(request.getAmount()) < 0) {
            throw new InsufficientFundsException("Insufficient balance for transfer");
        }

        // Rule 3: daily transfer limit
        BigDecimal todaysTotal = transferRepository.sumTransfersByAccountAndDate(
            request.getSourceAccountId(), LocalDate.now()
        );
        if (todaysTotal.add(request.getAmount()).compareTo(DAILY_LIMIT) > 0) {
            throw new LimitExceededException(
                "Daily transfer limit of " + DAILY_LIMIT + " would be exceeded. " +
                "Today's usage: " + todaysTotal
            );
        }

        return executeTransfer(source, request);
    }
}
```

---

## ‏A05: سوء إعداد الأمان

تكشف نقاط Spring Boot Actuator بيانات تشغيلية حساسة (تفريغات الذاكرة، ومتغيرات البيئة، وتفريغات الخيوط) إن لم تُقيَّد بشكل صحيح. وActuator مكشوف في عنقود Kubernetes يمكن الوصول إليه من الإنترنت سوء إعداد متكرر.

### إعداد معرّض للثغرة

```yaml
# VULNERABLE — all actuator endpoints exposed publicly
management:
  endpoints:
    web:
      exposure:
        include: "*"    # exposes /actuator/env, /actuator/heapdump, /actuator/threaddump
  endpoint:
    health:
      show-details: always   # leaks internal component status
    env:
      enabled: true
      show-values: always    # leaks environment variables including secrets
```

### الإعداد المُصلح

```yaml
# FIXED — minimal actuator exposure with security controls
management:
  server:
    port: 8081          # separate port — blocked at network level (not port 8080)
  endpoints:
    web:
      exposure:
        include: health,info,prometheus   # only what monitoring needs
  endpoint:
    health:
      show-details: when-authorized    # only show component details to authenticated admins
    env:
      access: none      # never expose environment variables
                        # (older Boot versions: enabled: false)
  prometheus:
    metrics:
      export:
        enabled: true
```

```java
// Secure the actuator endpoints with authentication and roles (the
// management port itself should additionally be unreachable from outside
// the cluster -- NetworkPolicy / no public Service)
@Configuration
public class ActuatorSecurityConfig {

    @Bean
    @Order(1)
    public SecurityFilterChain actuatorSecurityFilterChain(HttpSecurity http) throws Exception {
        return http
            .securityMatcher(EndpointRequest.toAnyEndpoint())
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(EndpointRequest.to("health")).permitAll()
                .requestMatchers(EndpointRequest.to("prometheus")).hasRole("PROMETHEUS")
                .anyRequest().hasRole("ADMIN")
            )
            .httpBasic(withDefaults())
            .build();
    }
}
```

---

## ‏A06: المكونات المعرّضة للثغرات

أثبتت Log4Shell ‏(CVE-2021-44228) أن تبعية واحدة معرّضة للثغرة في معالج دفع قد تتيح تنفيذ كود عن بُعد بالكامل. وأصبحت إدارة التبعيات متطلب امتثال صريحًا — فيتطلب PCI DSS 6.3.2 جردًا لمكونات البرمجيات المخصصة وبرمجيات الأطراف الثالثة، وهو ما توفره قائمة مكونات البرمجيات (SBOM).

### اكتشاف التبعيات المعرّضة للثغرات

```xml
<!-- pom.xml — OWASP Dependency Check plugin -->
<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>10.0.3</version>
  <configuration>
    <failBuildOnCVSS>7</failBuildOnCVSS>   <!-- fail on High/Critical CVEs -->
    <suppressionFile>suppression.xml</suppressionFile>
    <nvdApiKey>${env.NVD_API_KEY}</nvdApiKey>
  </configuration>
  <executions>
    <execution>
      <goals><goal>check</goal></goals>
    </execution>
  </executions>
</plugin>
```

```yaml
# GitHub Actions — SBOM generation and vulnerability scan
- name: Generate SBOM
  uses: anchore/sbom-action@v0
  with:
    image: payment-service:${{ github.sha }}
    format: spdx-json
    output-file: sbom.spdx.json

- name: Scan SBOM for vulnerabilities
  uses: anchore/scan-action@v6   # pin to a commit SHA in production
  with:
    sbom: sbom.spdx.json
    fail-build: true
    severity-cutoff: high
```

```xml
<!-- pom.xml — override a vulnerable transitive version.
     With the Spring Boot parent, overriding the managed version property
     is enough: every Log4j2 artifact follows it (no explicit dependency
     needed). Spring Boot logs with Logback by default -- Log4j2 is only
     present if a dependency pulls it in. -->
<properties>
  <log4j2.version>2.24.3</log4j2.version>
</properties>
```

---

## ‏A07: إخفاقات المصادقة

يجب أن تتحقق رموز JWT من كل الادعاءات ذات الصلة بالأمان. وتخطي التحقق من `exp` أو `iss` أو `aud` يتيح إعادة استخدام الرموز، وإساءة استخدامها عبر الخدمات، وهجمات الإعادة.

### كود معرّض للثغرة — تحقق ناقص من JWT

```java
// VULNERABLE — only decodes JWT, does not validate claims
@Component
public class JwtTokenFilter extends OncePerRequestFilter {

    @Value("${jwt.secret}")
    private String jwtSecret;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String token = extractToken(request);
        if (token != null) {
            // Verifies the signature (and exp IF the token has one) — but
            // does NOT check iss or aud, accepts tokens WITHOUT exp, and uses a
            // shared HMAC secret that every verifying service must hold
            Claims claims = Jwts.parserBuilder()
                .setSigningKey(jwtSecret.getBytes())
                .build()
                .parseClaimsJws(token)
                .getBody();
            // Tokens from other issuers, tokens for other services, and
            // never-expiring tokens — all accepted!
            setAuthentication(claims);
        }
        filterChain.doFilter(request, response);
    }
}
```

### الكود المُصلح — تحقق كامل من الادعاءات

```java
// FIXED — validates all security-relevant claims
@Component
public class JwtTokenFilter extends OncePerRequestFilter {

    private static final String EXPECTED_ISSUER  = "https://auth.fintech.example.com";
    private static final String EXPECTED_AUDIENCE = "payment-service";

    @Value("${jwt.public-key-path}")
    private String publicKeyPath;

    private PublicKey publicKey;

    @PostConstruct
    public void loadPublicKey() throws Exception {
        // Use asymmetric keys (RS256/ES256) — symmetric secrets are shared and can be stolen.
        // The file is DER-encoded here; a PEM file must be base64-decoded
        // (without the BEGIN/END lines) first. In practice, fetch keys from
        // the issuer's JWKS endpoint instead of a file.
        byte[] keyBytes = Files.readAllBytes(Paths.get(publicKeyPath));
        KeyFactory kf = KeyFactory.getInstance("RSA");
        publicKey = kf.generatePublic(new X509EncodedKeySpec(keyBytes));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String token = extractToken(request);
        if (token != null) {
            try {
                // (jjwt 0.11 API shown; 0.12 renames it to Jwts.parser().verifyWith(...))
                Claims claims = Jwts.parserBuilder()
                    .setSigningKey(publicKey)              // asymmetric key verification
                    .requireIssuer(EXPECTED_ISSUER)        // reject tokens from other issuers
                    .requireAudience(EXPECTED_AUDIENCE)    // reject tokens meant for other services
                    .setAllowedClockSkewSeconds(30)        // allow 30s clock skew
                    .build()
                    .parseClaimsJws(token)
                    .getBody();

                // exp is validated when present -- also REQUIRE it, so a
                // token without expiry is never accepted
                if (claims.getExpiration() == null) {
                    response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Token has no expiry");
                    return;
                }

                setAuthentication(claims);
            } catch (ExpiredJwtException ex) {
                response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Token has expired");
                return;
            } catch (JwtException ex) {
                log.warn("JWT validation failed: {}", ex.getMessage());
                response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Invalid token");
                return;
            }
        }
        filterChain.doFilter(request, response);
    }
}
```

---

## ‏A08: إخفاقات سلامة البرمجيات والبيانات

صورة حاوية غير موقعة منشورة في الإنتاج قد تكون عُبث بها في السجل. ويوفر Sigstore Cosign توقيعًا تشفيريًا للصور والتحقق منها.

### نشر معرّض للثغرة — بلا تحقق من الصورة

```yaml
# VULNERABLE — unsigned image, any SHA can be deployed
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  template:
    spec:
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:latest   # mutable tag, no signature check
```

### النشر المُصلح — توقيع Cosign + ‏webhook قبول

```bash
# CI/CD pipeline — sign image after build
# 1. Build and push
docker build -t registry.example.com/payment-service:${GIT_SHA} .
docker push registry.example.com/payment-service:${GIT_SHA}

# 2. Sign the image DIGEST (a tag can be moved) with a key held in a KMS
#    (or use keyless signing: cosign sign --yes <image> with the CI OIDC identity)
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' registry.example.com/payment-service:${GIT_SHA})
cosign sign --key awskms:///alias/cosign-signing "$DIGEST"

# 3. Attest SBOM
cosign attest \
  --key awskms:///alias/cosign-signing \
  --predicate sbom.spdx.json \
  --type spdxjson \
  "$DIGEST"
```

```yaml
# Kyverno ClusterPolicy — reject unsigned images in financial namespaces
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-payment-service-image-signature
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-image-signature
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [payments, fraud-detection, reconciliation]
      verifyImages:
        - imageReferences:
            - "registry.example.com/payment-service:*"
            - "registry.example.com/fraud-detection-service:*"
          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
                      -----END PUBLIC KEY-----
```

---

## ‏A09: إخفاقات التسجيل والمراقبة الأمنية

تحويلات الأموال دون سجلات تدقيق إخفاق امتثال (PCI-DSS المتطلب 10، وISO 27001). والمهاجم الذي يستطيع كبت سجلات التدقيق يستطيع تحويل أموال دون ترك أثر.

### كود معرّض للثغرة — بلا سجل تدقيق

```java
// VULNERABLE — fund transfer with no audit trail
@Service
public class FundTransferService {

    @Transactional
    public TransferResult transfer(TransferRequest request) {
        Account source = accountRepository.findById(request.getSourceId());
        Account dest   = accountRepository.findById(request.getDestId());

        source.debit(request.getAmount());
        dest.credit(request.getAmount());

        accountRepository.save(source);
        accountRepository.save(dest);

        // No audit log — no way to prove who initiated this transfer or when
        return TransferResult.success();
    }
}
```

### الكود المُصلح — تسجيل تدقيق منظم

```java
// FIXED — comprehensive structured audit log
@Service
public class FundTransferService {

    private static final Logger auditLog = LoggerFactory.getLogger("AUDIT");

    private final AuditWriter auditWriter;          // see below
    private final AccountRepository accountRepository;
    private final ObjectMapper objectMapper;

    // ... constructor

    @Transactional
    public TransferResult transfer(TransferRequest request, Authentication auth,
                                   HttpServletRequest httpRequest) {
        AuditEvent preEvent = AuditEvent.builder()
            .eventType("FUND_TRANSFER_INITIATED")
            .actor(auth.getName())
            .ipAddress(httpRequest.getRemoteAddr())   // real client IP via trusted proxy config
            .sourceAccountId(request.getSourceId())
            .destinationAccountId(request.getDestId())
            .amount(request.getAmount())
            .currency(request.getCurrency())
            .traceId(MDC.get("traceId"))
            .timestamp(Instant.now())
            .build();
        auditWriter.write(preEvent);

        try {
            Account source = accountRepository.findById(request.getSourceId()).orElseThrow();
            Account dest   = accountRepository.findById(request.getDestId()).orElseThrow();

            source.debit(request.getAmount());
            dest.credit(request.getAmount());

            // Success record in the SAME transaction as the transfer: it
            // commits exactly when the money moves
            auditWriter.writeInTransaction(preEvent.toBuilder()
                .eventType("FUND_TRANSFER_COMPLETED")
                .result("SUCCESS")
                .build());
            return TransferResult.success();

        } catch (RuntimeException ex) {
            // The outer transaction is about to roll back -- a failure record
            // saved in it would be rolled back too. AuditWriter.write() uses
            // REQUIRES_NEW, so the failure is recorded regardless
            auditWriter.write(preEvent.toBuilder()
                .eventType("FUND_TRANSFER_FAILED")
                .result("FAILURE")
                .failureReason(ex.getClass().getSimpleName())
                .build());
            throw ex;
        }
    }
}

@Component
class AuditWriter {
    private static final Logger auditLog = LoggerFactory.getLogger("AUDIT");
    private final AuditRepository auditRepository;
    private final ObjectMapper objectMapper;

    AuditWriter(AuditRepository auditRepository, ObjectMapper objectMapper) {
        this.auditRepository = auditRepository;
        this.objectMapper = objectMapper;
    }

    // Own transaction: survives a rollback of the caller's transaction
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void write(AuditEvent event) { persist(event); }

    @Transactional(propagation = Propagation.MANDATORY)
    public void writeInTransaction(AuditEvent event) { persist(event); }

    private void persist(AuditEvent event) {
        auditRepository.save(event);
        try {
            // Structured JSON via a JSON library -- String.format would break
            // (or allow injection) as soon as a value contains a quote
            auditLog.info(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Audit event not serialisable", e);
        }
    }
}
```

---

## ‏A10: تزوير الطلبات من جانب الخادم (SSRF)

تجلب خدمة الدفع عنوان webhook الذي يقدمه التاجر بعد كل معاملة. ودون تحقق، يسجّل مهاجم عنوان webhook يشير إلى `http://169.254.169.254/latest/meta-data/` (خدمة البيانات الوصفية في AWS) أو خدمات داخلية، فتسرّب خدمة الدفع بيانات الاعتماد نيابة عن المهاجم.

### كود معرّض للثغرة — عنوان webhook غير متحقق منه

```java
// VULNERABLE — fetches any URL the merchant provides
@Service
public class WebhookDispatchService {

    private final RestTemplate restTemplate = new RestTemplate();

    public void dispatchPaymentWebhook(String webhookUrl, PaymentEvent event) {
        // Merchant can set webhookUrl = "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
        // or webhookUrl = "http://internal-vault.vault.svc.cluster.local:8200/v1/secret/data"
        try {
            restTemplate.postForEntity(webhookUrl, event, Void.class);
        } catch (Exception ex) {
            log.warn("Webhook delivery failed for URL: {}", webhookUrl, ex);
        }
    }
}
```

### الكود المُصلح — التحقق من العنوان بقائمة سماح

```java
// FIXED — strict allowlist prevents SSRF
@Service
public class WebhookDispatchService {

    private static final Set<String> ALLOWED_SCHEMES = Set.of("https");

    // Ranges webhooks must never reach (InetAddressRange: a small CIDR
    // helper class or library -- the JDK has none). Also normalise
    // IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) before checking
    private static final List<InetAddressRange> BLOCKED_RANGES = List.of(
        InetAddressRange.parse("0.0.0.0/8"),          // "this network"
        InetAddressRange.parse("10.0.0.0/8"),         // RFC1918 private
        InetAddressRange.parse("100.64.0.0/10"),      // carrier-grade NAT
        InetAddressRange.parse("172.16.0.0/12"),      // RFC1918 private
        InetAddressRange.parse("192.168.0.0/16"),     // RFC1918 private
        InetAddressRange.parse("169.254.0.0/16"),     // link-local (cloud metadata)
        InetAddressRange.parse("127.0.0.0/8"),        // loopback
        InetAddressRange.parse("::1/128"),            // IPv6 loopback
        InetAddressRange.parse("fc00::/7"),           // IPv6 unique local (incl. AWS IMDS fd00:ec2::254)
        InetAddressRange.parse("fe80::/10")           // IPv6 link-local
    );

    public void validateWebhookUrl(String webhookUrl) {
        URI uri;
        try {
            uri = new URI(webhookUrl);
        } catch (URISyntaxException ex) {
            throw new InvalidWebhookUrlException("Malformed webhook URL: " + webhookUrl);
        }

        // 1. Only HTTPS allowed — no http, file, ftp, gopher
        if (!ALLOWED_SCHEMES.contains(uri.getScheme())) {
            throw new InvalidWebhookUrlException("Webhook URL must use HTTPS scheme");
        }

        // 2. Resolve hostname to IP and check against blocked ranges.
        // On its own this does NOT stop DNS rebinding: the hostname may
        // resolve to a public IP now and to an internal IP when the HTTP
        // client resolves it again. See dispatch below.
        String host = uri.getHost();
        try {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            for (InetAddress addr : addresses) {
                for (InetAddressRange blocked : BLOCKED_RANGES) {
                    if (blocked.contains(addr)) {
                        throw new InvalidWebhookUrlException(
                            "Webhook URL resolves to a private/reserved IP address: " + addr.getHostAddress()
                        );
                    }
                }
            }
        } catch (UnknownHostException ex) {
            throw new InvalidWebhookUrlException("Webhook hostname cannot be resolved: " + host);
        }

        // 3. No userinfo (credentials) in URL
        if (uri.getUserInfo() != null) {
            throw new InvalidWebhookUrlException("Webhook URL must not contain credentials");
        }
    }

    public void dispatchPaymentWebhook(String webhookUrl, PaymentEvent event) {
        validateWebhookUrl(webhookUrl);
        // Against DNS rebinding and redirects, the HTTP client must:
        //  - connect to the IP that was VALIDATED (custom DNS resolver that
        //    applies the same range check at connect time), or send all
        //    webhooks through an egress proxy that enforces the rules
        //    (e.g. Smokescreen) -- the most robust option;
        //  - NOT follow redirects (a 302 to http://169.254.169.254/ bypasses
        //    every check above);
        //  - use short timeouts.
        // In the cloud, also require IMDSv2 (session tokens) on the nodes.

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        // Add HMAC signature so the merchant can verify the webhook is genuine
        String signature = hmacSha256(event, webhookSigningKey);
        headers.set("X-Fintech-Signature", "sha256=" + signature);

        webhookRestTemplate.postForEntity(webhookUrl,     // redirects disabled,
            new HttpEntity<>(event, headers), Void.class); // pinned resolver
    }
}
```

---

## جدول ملخص التهديدات

| معرّف OWASP | الفئة | الأثر في التقنية المالية | الإصلاح الأساسي |
|----------|----------|---------------|---------|
| A01 | التحكم المعطوب في الوصول | كشف بيانات العملاء، وتحويلات غير مصرح بها | فحص الملكية بـ @PreAuthorize |
| A02 | إخفاقات التشفير | ‏PAN في السجلات = مخالفة PCI، وتسريب بيانات بطاقات | الترميز + إخفاء السجلات |
| A03 | الحقن | تسريب بيانات الحسابات، وتدمير قاعدة البيانات | معاملات PreparedStatement |
| A04 | التصميم غير الآمن | تجاوز الحدود، واحتيال التحويل إلى النفس | طبقة التحقق من قواعد الأعمال |
| A05 | سوء إعداد الأمان | كشف الأسرار عبر نقاط actuator | تقييد actuator، ومنفذ منفصل |
| A06 | المكونات المعرّضة للثغرات | تنفيذ كود عن بُعد عبر Log4Shell في معالج الدفع | ‏SBOM + فحص تبعيات OWASP |
| A07 | إخفاقات المصادقة | إعادة الرموز، وإساءة استخدامها عبر الخدمات | تحقق كامل من ادعاءات JWT ‏(exp/iss/aud) |
| A08 | سلامة البرمجيات | نشر صورة معبوث بها في الإنتاج | توقيع Cosign + ‏webhook قبول |
| A09 | إخفاقات التسجيل | احتيال غير مكتشف، وإخفاق امتثال | سجل تدقيق منظم غير قابل للتغيير |
| A10 | SSRF | سرقة بيانات اعتماد البيانات الوصفية السحابية، ووصول داخلي | قائمة سماح لعناوين webhook + حظر نطاقات CIDR |

---

## مزالق الإنتاج

### المزلق 1: استخدام معرّفات الكائنات كتحكم في الوصول

خطأ شائع في التحكم في الوصول هو معاملة المعرّفات التسلسلية أو المتوقعة كشكل من التحكم في الوصول ("إن لم تستطع تخمين المعرّف، فلن تستطيع الوصول إليه"). وهذا أمان عبر الغموض، لا تحكم في الوصول.

```java
// PITFALL — sequential IDs are guessable via enumeration
@GetMapping("/statements/{statementId}")
public Statement getStatement(@PathVariable Long statementId) {
    // statementId is a sequential auto-increment integer
    // attacker iterates 1, 2, 3... to access all customer statements
    return statementRepository.findById(statementId).orElseThrow();
}

// FIX — use UUIDs AND ownership verification
@GetMapping("/statements/{statementId}")
@PreAuthorize("@statementSecurity.isOwner(#statementId, authentication)")
public Statement getStatement(
        @PathVariable UUID statementId,  // UUID prevents enumeration
        Authentication auth) {
    // But UUID alone is not access control — the ownership check is still required
    return statementRepository.findById(statementId).orElseThrow();
}
```

### المزلق 2: تسجيل أجسام الطلبات كاملة وهي تحتوي بيانات حساسة

كثيرًا ما تسجّل وكلاء مراقبة أداء التطبيقات (APM)، ومرشحات تسجيل الطلبات في Spring Boot، وبوابات الواجهات أجسام طلبات HTTP كاملة. وإن احتوى الجسم رقم بطاقة أو بيانات اعتماد حساب، فإنه يظهر في كل منصة تجميع سجلات يصل إليها المطورون.

```java
// PITFALL — request logging with payloads exposes payment data
@Bean
public CommonsRequestLoggingFilter requestLoggingFilter() {
    CommonsRequestLoggingFilter filter = new CommonsRequestLoggingFilter();
    filter.setIncludePayload(true);    // logs full request bodies — includes PANs
    filter.setMaxPayloadLength(10_000);
    return filter;
}
// (APM agents and API gateways often have the same "capture body" options)

// FIX — custom request logging filter that masks sensitive fields
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SensitiveDataMaskingFilter extends OncePerRequestFilter {

    private static final Pattern PAN_PATTERN =
        Pattern.compile("\"(?:card_number|pan|cardNumber)\"\\s*:\\s*\"(\\d{12,19})\"");

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        ContentCachingRequestWrapper wrappedReq = new ContentCachingRequestWrapper(req);
        chain.doFilter(wrappedReq, res);

        String body = new String(wrappedReq.getContentAsByteArray(), StandardCharsets.UTF_8);
        String maskedBody = PAN_PATTERN.matcher(body)
            .replaceAll(m -> "\"card_number\":\"" + maskPan(m.group(1)) + "\"");
        // Log maskedBody — never the original body
    }
}
```

### المزلق 3: الثقة بترويسة X-Forwarded-For للتحكم في الوصول بناءً على IP

تعتمد نقاط Actuator وواجهات الإدارة المقيدة بعنوان IP على `X-Forwarded-For` لاكتشاف IP العميل. وإن وثق التطبيق بترويسة `X-Forwarded-For` التي يقدمها العميل دون التحقق منها مقابل IP اتصال TCP الفعلي، يستطيع أي عميل انتحال IP داخلي.

```java
// PITFALL — trusting X-Forwarded-For from client
@GetMapping("/admin/accounts")
public List<Account> getAllAccounts(HttpServletRequest request) {
    String clientIp = request.getHeader("X-Forwarded-For");  // spoofable
    if (!clientIp.startsWith("10.")) {
        throw new AccessDeniedException("Admin only");
    }
    return accountRepository.findAll();
}

// FIX — let the server derive the client IP, trusting X-Forwarded-For
// ONLY when the connection comes from a known proxy. application.yml:
//   server:
//     forward-headers-strategy: native
//     tomcat:
//       remoteip:
//         internal-proxies: "10\\.0\\.1\\.\\d{1,3}"   # load balancer subnet
// Then request.getRemoteAddr() returns the real client IP.
// And never make an IP check the ONLY protection of an admin API —
// require authentication and an admin role as well.
@GetMapping("/admin/accounts")
@PreAuthorize("hasRole('ADMIN')")
public List<Account> getAllAccounts(HttpServletRequest request) {
    if (!adminNetworks.contains(request.getRemoteAddr())) {
        throw new AccessDeniedException("Admin network only");
    }
    return accountRepository.findAll();
}
```

---

## قائمة تحقق الإنتاج

- [ ] كل نقاط REST لها فحوص ملكية (@PreAuthorize) — لا مصادقة فقط
- [ ] أرقام PAN / الحسابات مخفاة في كل عبارات السجل
- [ ] خدمة ترميز مستخدمة لتخزين PAN — لا تُحفظ أرقام PAN الخام أبدًا
- [ ] كل استعلامات قاعدة البيانات تستخدم PreparedStatement أو معاملات JPA المسماة
- [ ] التحقق من قواعد الأعمال (التحويل إلى النفس، والحدود اليومية، والمبالغ الموجبة) مطبق في طبقة الخدمة
- [ ] نقاط Actuator مقيدة بمنفذ الإدارة مع قائمة سماح IP
- [ ] نقطة actuator ‏`env` معطلة (`management.endpoint.env.access=none`) في كل البيئات
- [ ] إضافة OWASP Dependency Check تعمل في CI؛ ويفشل البناء عند CVSS >= 7
- [ ] ‏SBOM يُولّد لكل بناء ويُخزن مع الإصدار
- [ ] التحقق من JWT يفحص ادعاءات exp وiss وaud وnbf — لا التوقيع فقط
- [ ] توقيع JWT غير متماثل (RS256/ES256) — لا أسرار HMAC مشتركة
- [ ] صور الحاويات موقعة بـ Cosign؛ وwebhook القبول في Kyverno يفرض التوقيعات
- [ ] سجل تدقيق يُكتب لكل تحويل أموال (قبل الإجراء وبعده)؛ وسجلات الإخفاق تنجو من التراجع عن المعاملة
- [ ] سجل التدقيق يُحوّل إلى SIEM غير قابل للتغيير (إلحاق فقط)
- [ ] عناوين webhook يُتحقق منها مقابل قائمة سماح SSRF قبل أول استخدام وقبل الإرسال
- [ ] حماية من إعادة ربط DNS والتحويلات: الاتصال فقط بالـ IP المتحقق منه (أو عبر وكيل خروج)، والتحويلات معطلة

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"يصادق مستخدم كـ user-A ويستدعي GET /api/v1/payments/txn-99999. والدفعة تخص user-B. ويتحقق المتحكم فقط من أن المستخدم موثق (ليس مجهولًا). ما فئة OWASP التي يمثلها هذا، وما الإصلاح الصحيح؟","options":["‏A03 الحقن — أصلحه بـ PreparedStatement لمنع البحث","‏A01 التحكم المعطوب في الوصول — أصلحه بـ @PreAuthorize(\"@paymentSecurity.isOwner(#id, authentication)\") للتحقق من الملكية","‏A07 إخفاقات المصادقة — أصلحه باشتراط MFA لعمليات البحث عن المدفوعات","‏A02 إخفاقات التشفير — أصلحه بتشفير معرّفات المدفوعات"],"correct":1,"explanation":"هذا A01 التحكم المعطوب في الوصول، وتحديدًا تصعيد الصلاحيات الأفقي — يصل مستخدم إلى مورد مستخدم آخر بمستوى الصلاحية نفسه. فالمصادقة تؤكد الهوية لكنها لا تثبت الملكية. والإصلاح فحص ملكية باستخدام @PreAuthorize في Spring Security مع bean مقيّم أمني مخصص يتحقق من أن المستخدم الموثق يملك الدفعة المطلوبة. ويصلح PreparedStatement الحقن، وتصلح MFA قوة المصادقة، وتشفير المعرّفات يوفر غموضًا فقط — لا تحكمًا في الوصول."},{"text":"تجلب خدمة دفع عناوين webhook للتجار بعد كل معاملة. ويسجّل تاجر العنوان http://169.254.169.254/latest/meta-data/iam/security-credentials/payment-role. ما هذا الهجوم، وما الدفاع الأساسي؟","options":["‏A03 حقن SQL — دافع بالاستعلامات بالمعاملات","‏A10 SSRF — دافع بقائمة سماح صارمة للعناوين تحظر نطاقات IP الخاصة والمحلية للرابط ولا تسمح إلا بـ HTTPS إلى عناوين الإنترنت العامة","‏A01 التحكم المعطوب في الوصول — دافع بالتحقق من رمز JWT على نقطة webhook","‏A04 التصميم غير الآمن — دافع بتحديد معدل تسليم webhook"],"correct":1,"explanation":"هذا A10 تزوير الطلبات من جانب الخادم (SSRF). فيجعل المهاجم خدمة الدفع ترسل طلبًا إلى خدمة البيانات الوصفية لمثيل AWS EC2 ‏(169.254.169.254)، التي تعيد بيانات اعتماد IAM مؤقتة. والدفاع الأساسي التحقق من عنوان webhook قبل جلبه: حل اسم المضيف إلى عنوان (عناوين) IP ورفض أي منها يقع ضمن النطاقات الخاصة RFC1918، و169.254.0.0/16 المحلي للرابط، ونطاقات الاسترجاع. ولا يُسمح إلا بـ HTTPS إلى عناوين الإنترنت العامة."},{"text":"يُصدر رمز JWT من خدمة المصادقة. وتتحقق payment-service من التوقيع لكنها لا تفحص ادعاءات exp أو iss أو aud. ويحصل مهاجم على رمز صدر قبل يومين (تجاوز exp). ماذا يستطيع المهاجم أن يفعل؟","options":["لا شيء — التحقق من توقيع JWT يمنع إعادة الرموز القديمة.","إعادة الرمز المنتهي إلى ما لا نهاية لاستدعاء أي نقطة دفع، لأن الخدمة تفحص التوقيع فقط والتوقيع ما زال صالحًا رياضيًا على رمز منتهٍ.","يجب على المهاجم تزوير رمز جديد — الرموز المنتهية لا يمكن إعادتها.","يستطيع المهاجم استخدام الرمز 30 ثانية فقط بعد الانتهاء بسبب سماحية انحراف الساعة."],"correct":1,"explanation":"يثبت التحقق من توقيع JWT فقط أن الرمز وُقّع بالمفتاح الخاص المتوقع. ولا يفرض الصلاحية الزمنية. فإن لم يُفحص ادعاء exp، يبقى توقيع الرمز المنتهي صالحًا رياضيًا إلى الأبد، ويستطيع المهاجم إعادة رمز عمره يومان إلى ما لا نهاية. والإصلاح إعداد للمحلل يتحقق من exp — ويرفض الرموز التي ليس لها exp أصلًا (فمعظم المكتبات تفحصه فقط إن وُجد). ويمنع فحص iss الرموز من مُصدرين آخرين، ويمنع فحص aud استخدام الرموز الصادرة لخدمات أخرى ضد payment-service."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"تقوية أمان خدمة الدفع وفق OWASP Top 10","difficulty":"advanced","estimatedMinutes":120,"tasks":[{"id":"1","description":"دقّق متحكم REST نموذجيًا للدفع في Spring Boot بحثًا عن A01 التحكم المعطوب في الوصول وA07 إخفاقات المصادقة. ويكشف المتحكم GET /payments/{id}، وGET /payments (كل المدفوعات)، وPOST /transfers. وأضف فحوص ملكية @PreAuthorize باستخدام bean مخصص PaymentSecurityEvaluator. وأضف تحققًا كاملًا من ادعاءات JWT ‏(exp، وiss، وaud، وnbf) باستخدام مفتاح RS256 غير متماثل. واكتب اختبارات تكامل بدعم اختبار Spring Security تتحقق من: (أ) أن user-A لا يستطيع الوصول إلى دفعة user-B، (ب) رفض رمز منتهٍ بـ 401، (ج) رفض رمز بجمهور خاطئ."},{"id":"2","description":"نفّذ حماية من SSRF لخدمة إرسال webhook. واكتب صنف WebhookUrlValidator: يحل اسم المضيف، ويفحص كل عناوين IP المحلولة مقابل نطاقات CIDR ‏RFC1918/المحلية للرابط/الاسترجاع، ويرفض المخططات غير HTTPS، ويرفض العناوين المحتوية على بيانات اعتماد. واكتب اختبارات وحدة تغطي: رفض مخطط HTTP، ورفض IP ‏10.x.x.x، ورفض 169.254.x.x، وقبول عنوان HTTPS عام صالح، ورفض IP خاص ناتج عن حل DNS. وادمج المتحقق في WebhookDispatchService تضيف أيضًا ترويسة توقيع HMAC-SHA256."},{"id":"3","description":"نفّذ تسجيل تدقيق منظمًا غير قابل للتغيير لتحويلات الأموال (A09). وأنشئ كيان AuditEvent بالحقول: eventType، وactor، وipAddress، وsourceAccountId، وdestinationAccountId، وamount، وcurrency، وtraceId، وtimestamp، وresult، وfailureReason. واكتب FundTransferAuditService تسجّل أحداث ما قبل الإجراء (FUND_TRANSFER_INITIATED) وما بعده (FUND_TRANSFER_COMPLETED أو FUND_TRANSFER_FAILED) كـ JSON منظم. واضبط سجل التدقيق ليكتب إلى تيار Loki مخصص للإلحاق فقط بالتسمية {stream=\"audit\"}. وأضف استعلام LogQL يُظهر كل التحويلات الفاشلة في آخر 24 ساعة."},{"id":"4","description":"اضبط OWASP Dependency Check في بناء Maven (الفشل عند CVSS >= 7). وأضف سير عمل GitHub Actions يبني صورة Docker لـ payment-service، ويولّد SBOM بصيغة SPDX باستخدام Syft، ويفحص SBOM بـ Grype، ويُفشل البناء عند ثغرات HIGH أو CRITICAL. وأعدّ ClusterPolicy في Kyverno في عنقود kind محلي ترفض صور الحاويات غير الموقعة في مساحة الأسماء payments. ووقّع الصورة بـ Cosign وأثبت أن webhook القبول يرفض صورة غير موقعة."}]} -->
