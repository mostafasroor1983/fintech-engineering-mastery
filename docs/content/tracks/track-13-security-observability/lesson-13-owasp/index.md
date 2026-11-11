---
id: track-13-lesson-13
title: "OWASP Top 10 — Financial Services Threat Landscape"
slug: owasp-top-10-fintech
track: track-13
trackName: "Security & Observability Engineering"
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
  - track-13-lesson-12
---

# OWASP Top 10 — Financial Services Threat Landscape

The OWASP Top 10 is not a list of theoretical vulnerabilities — in fintech, every category has caused real financial losses. Broken access control exposes customer payment histories. SQL injection exfiltrates account credentials. SSRF allows attackers to pivot into internal systems from a webhook handler. This lesson maps every OWASP Top 10 category to concrete fintech attack scenarios, shows the vulnerable Java code, and provides the production-grade fix.

---

## A01: Broken Access Control

The most common OWASP vulnerability and the most dangerous in a payment context. Horizontal privilege escalation occurs when a user can access another user's resources by guessing or enumerating resource IDs.

### Vulnerable Code — Horizontal Privilege Escalation

A user authenticates as `user-A` but changes the `{id}` path parameter to view `user-B`'s payment history. The controller does not verify ownership.

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

### Fixed Code — Spring Security @PreAuthorize

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
        // Only return payments belonging to the authenticated user
        String userId = ((UserDetails) authentication.getPrincipal()).getUsername();
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

## A02: Cryptographic Failures

Sensitive financial data must never appear in logs, error messages, or databases in plaintext. A Primary Account Number (PAN) in application logs is a PCI-DSS violation and can expose card data to any log aggregation system user.

### Vulnerable Code — PAN Logged in Plaintext

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

### Fixed Code — Masking and Tokenisation

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

## A03: Injection

SQL injection in account lookups allows an attacker to extract all account data or bypass authentication entirely. String concatenation into SQL queries is the root cause.

### Vulnerable Code — SQL Injection via Concatenation

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

### Fixed Code — Parameterised Queries

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

## A04: Insecure Design

Business logic flaws in payment systems can be exploited to drain accounts or bypass transaction limits. These are not coding errors — they are design failures that allow operations the system should never permit.

### Vulnerable Code — Transfer-to-Self and Missing Limit Checks

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

### Fixed Code — Business Rule Validation

```java
// FIXED — comprehensive business rule enforcement
@Service
public class TransferService {

    private static final BigDecimal DAILY_LIMIT = new BigDecimal("10000.00");

    public TransferResult transfer(TransferRequest request, String authenticatedUserId) {

        // Rule 1: prevent self-transfer
        if (request.getSourceAccountId().equals(request.getDestAccountId())) {
            throw new BusinessRuleViolationException(
                "SELF_TRANSFER_PROHIBITED",
                "Transfer source and destination accounts must be different"
            );
        }

        Account source = accountRepository.findByIdAndOwnerId(
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

        // Rule 4: amount must be positive
        if (request.getAmount().compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessRuleViolationException("INVALID_AMOUNT", "Transfer amount must be positive");
        }

        return executeTransfer(source, request);
    }
}
```

---

## A05: Security Misconfiguration

Spring Boot Actuator endpoints expose sensitive operational data (heap dumps, environment variables, thread dumps) if not properly restricted. Exposed actuator in a Kubernetes cluster reachable from the internet is a frequent misconfiguration.

### Vulnerable Configuration

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

### Fixed Configuration

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
      enabled: false    # never expose environment variables
  metrics:
    export:
      prometheus:
        enabled: true
```

```java
// Secure the management port with IP allowlist in SecurityFilterChain
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

## A06: Vulnerable Components

Log4Shell (CVE-2021-44228) demonstrated that a single vulnerable dependency in a payment processor could allow full remote code execution. Dependency management and Software Bill of Materials (SBOM) are now a compliance requirement.

### Detecting Vulnerable Dependencies

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
  uses: anchore/scan-action@v3
  with:
    sbom: sbom.spdx.json
    fail-build: true
    severity-cutoff: high
```

```java
// application.yml — override Log4j2 version to patched version
// pom.xml
<properties>
  <!-- Override transitive Log4j2 version — fix Log4Shell -->
  <log4j2.version>2.23.1</log4j2.version>
</properties>

<dependency>
  <groupId>org.apache.logging.log4j</groupId>
  <artifactId>log4j-core</artifactId>
  <version>${log4j2.version}</version>
</dependency>
```

---

## A07: Authentication Failures

JWT tokens must validate all security-relevant claims. Skipping `exp`, `iss`, or `aud` validation allows token reuse, cross-service token abuse, and replay attacks.

### Vulnerable Code — Incomplete JWT Validation

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
            // Only verifies signature — does NOT check exp, iss, aud
            Claims claims = Jwts.parserBuilder()
                .setSigningKey(jwtSecret.getBytes())
                .build()
                .parseClaimsJws(token)
                .getBody();
            // Expired tokens, tokens from other issuers, tokens for other services — all accepted!
            setAuthentication(claims);
        }
        filterChain.doFilter(request, response);
    }
}
```

### Fixed Code — Full Claim Validation

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
        // Use asymmetric keys (RS256/ES256) — symmetric secrets are shared and can be stolen
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
                Claims claims = Jwts.parserBuilder()
                    .setSigningKey(publicKey)              // asymmetric key verification
                    .requireIssuer(EXPECTED_ISSUER)        // reject tokens from other issuers
                    .requireAudience(EXPECTED_AUDIENCE)    // reject tokens meant for other services
                    .setAllowedClockSkewSeconds(30)        // allow 30s clock skew
                    .build()
                    .parseClaimsJws(token)
                    .getBody();

                // exp is validated automatically by Jwts when parsing
                // Additional check: token must not be from before the service started (replay)
                if (claims.getIssuedAt().before(serviceStartTime)) {
                    response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Token predates service startup");
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

## A08: Software and Data Integrity Failures

An unsigned container image deployed to production could have been tampered with in the registry. Sigstore Cosign provides cryptographic image signing and verification.

### Vulnerable Deployment — No Image Verification

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

### Fixed Deployment — Cosign Signing + Admission Webhook

```bash
# CI/CD pipeline — sign image after build
# 1. Build and push
docker build -t registry.example.com/payment-service:${GIT_SHA} .
docker push registry.example.com/payment-service:${GIT_SHA}

# 2. Sign with Cosign using keyless signing (Sigstore OIDC)
cosign sign \
  --key cosign.key \
  registry.example.com/payment-service:${GIT_SHA}

# 3. Attest SBOM
cosign attest \
  --key cosign.key \
  --predicate sbom.spdx.json \
  --type spdxjson \
  registry.example.com/payment-service:${GIT_SHA}
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

## A09: Security Logging and Monitoring Failures

Fund transfers without audit logs are a compliance failure (PCI-DSS Req 10, ISO 27001 A.12.4). An attacker who can suppress audit logs can transfer funds without leaving a trace.

### Vulnerable Code — No Audit Log

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

### Fixed Code — Structured Audit Logging

```java
// FIXED — comprehensive structured audit log
@Service
public class FundTransferService {

    private static final Logger auditLog = LoggerFactory.getLogger("AUDIT");

    @Autowired
    private AuditRepository auditRepository;

    @Transactional
    public TransferResult transfer(TransferRequest request, Authentication auth) {
        String traceId = MDC.get("traceId");
        String actor   = auth.getName();

        // Structured audit log entry BEFORE the operation (pre-action audit)
        AuditEvent preEvent = AuditEvent.builder()
            .eventType("FUND_TRANSFER_INITIATED")
            .actor(actor)
            .ipAddress(RequestContextHolder.currentRequestAttributes()
                .getAttribute("remoteAddr", RequestAttributes.SCOPE_REQUEST).toString())
            .sourceAccountId(request.getSourceId())
            .destinationAccountId(request.getDestId())
            .amount(request.getAmount())
            .currency(request.getCurrency())
            .traceId(traceId)
            .timestamp(Instant.now())
            .build();

        auditRepository.save(preEvent);
        auditLog.info(auditJson(preEvent));

        try {
            Account source = accountRepository.findById(request.getSourceId());
            Account dest   = accountRepository.findById(request.getDestId());

            source.debit(request.getAmount());
            dest.credit(request.getAmount());

            accountRepository.save(source);
            accountRepository.save(dest);

            // Post-action audit with result (immutable — cannot be deleted)
            AuditEvent successEvent = preEvent.toBuilder()
                .eventType("FUND_TRANSFER_COMPLETED")
                .result("SUCCESS")
                .transactionId(source.getLastTransactionId())
                .build();
            auditRepository.save(successEvent);
            auditLog.info(auditJson(successEvent));

            return TransferResult.success(source.getLastTransactionId());

        } catch (Exception ex) {
            AuditEvent failureEvent = preEvent.toBuilder()
                .eventType("FUND_TRANSFER_FAILED")
                .result("FAILURE")
                .failureReason(ex.getMessage())
                .build();
            auditRepository.save(failureEvent);
            auditLog.error(auditJson(failureEvent));
            throw ex;
        }
    }

    private String auditJson(AuditEvent event) {
        // Structured JSON — parseable by SIEM without regex
        return String.format(
            "{\"event\":\"%s\",\"actor\":\"%s\",\"source\":\"%s\",\"dest\":\"%s\"," +
            "\"amount\":%s,\"currency\":\"%s\",\"trace\":\"%s\",\"ts\":\"%s\"}",
            event.getEventType(), event.getActor(),
            event.getSourceAccountId(), event.getDestinationAccountId(),
            event.getAmount(), event.getCurrency(),
            event.getTraceId(), event.getTimestamp()
        );
    }
}
```

---

## A10: Server-Side Request Forgery (SSRF)

A payment webhook URL provided by a merchant is fetched by the payment service after each transaction. Without validation, an attacker registers a webhook URL pointing to `http://169.254.169.254/latest/meta-data/` (AWS metadata service) or internal services, causing the payment service to exfiltrate credentials on the attacker's behalf.

### Vulnerable Code — Unvalidated Webhook URL

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

### Fixed Code — Allowlist-Based URL Validation

```java
// FIXED — strict allowlist prevents SSRF
@Service
public class WebhookDispatchService {

    private static final Set<String> ALLOWED_SCHEMES = Set.of("https");

    // Allowlisted CIDR ranges that webhooks are allowed to reach (external internet only)
    private static final List<InetAddressRange> BLOCKED_RANGES = List.of(
        InetAddressRange.parse("10.0.0.0/8"),        // RFC1918 private
        InetAddressRange.parse("172.16.0.0/12"),      // RFC1918 private
        InetAddressRange.parse("192.168.0.0/16"),     // RFC1918 private
        InetAddressRange.parse("169.254.0.0/16"),     // link-local (AWS metadata)
        InetAddressRange.parse("127.0.0.0/8"),        // loopback
        InetAddressRange.parse("::1/128"),             // IPv6 loopback
        InetAddressRange.parse("fc00::/7")             // IPv6 unique local
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

        // 2. Resolve hostname to IP and check against blocked ranges
        // (prevents DNS rebinding: hostname resolves to public IP during validation
        //  but to internal IP when the request is made)
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

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        // Add HMAC signature so the merchant can verify the webhook is genuine
        String signature = hmacSha256(event, webhookSigningKey);
        headers.set("X-Fintech-Signature", "sha256=" + signature);

        restTemplate.postForEntity(webhookUrl,
            new HttpEntity<>(event, headers), Void.class);
    }
}
```

---

## Threat Summary Table

| OWASP ID | Category | Fintech Impact | Key Fix |
|----------|----------|---------------|---------|
| A01 | Broken Access Control | Customer data exposure, unauthorized transfers | @PreAuthorize ownership check |
| A02 | Cryptographic Failures | PAN in logs = PCI violation, card data breach | Tokenisation + log masking |
| A03 | Injection | Account data exfiltration, DB destruction | PreparedStatement parameters |
| A04 | Insecure Design | Limit bypass, self-transfer fraud | Business rule validation layer |
| A05 | Security Misconfiguration | Secret exposure via actuator endpoints | Restrict actuator, separate port |
| A06 | Vulnerable Components | RCE via Log4Shell in payment processor | SBOM + OWASP dependency check |
| A07 | Auth Failures | Token replay, cross-service token abuse | Full JWT claim validation (exp/iss/aud) |
| A08 | Software Integrity | Tampered image deployed to production | Cosign signing + admission webhook |
| A09 | Logging Failures | Undetected fraud, compliance failure | Structured immutable audit log |
| A10 | SSRF | Cloud metadata credential theft, internal access | Webhook URL allowlist + CIDR block |

---

## Production Pitfalls

### Pitfall 1: Using Object IDs as Access Control

A common access control mistake is treating sequential or predictable IDs as a form of access control ("if you can't guess the ID, you can't access it"). This is security through obscurity, not access control.

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

### Pitfall 2: Logging Full Request Bodies Containing Sensitive Data

Application Performance Monitoring (APM) agents, Spring Boot request logging filters, and API gateways frequently log full HTTP request bodies. If the body contains a card number or account credentials, it appears in every log aggregation platform accessible to developers.

```java
// PITFALL — Spring Boot HTTP trace logging exposes payment data
management:
  trace:
    http:
      enabled: true   # logs full request/response bodies — includes PANs

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

### Pitfall 3: Trusting the X-Forwarded-For Header for IP-Based Access Control

Actuator endpoints and admin APIs restricted by IP address rely on `X-Forwarded-For` for client IP detection. If the application trusts the client-supplied `X-Forwarded-For` header without validating it against the actual TCP connection IP, any client can spoof an internal IP.

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

// FIX — configure trusted proxy list; only extract IP from known proxies
// In Spring Security:
http.requestMatcher(request -> {
    // Only trust X-Forwarded-For if it comes from a known load balancer IP
    String remoteAddr = request.getRemoteAddr();
    if (TRUSTED_PROXY_IPS.contains(remoteAddr)) {
        return getForwardedFor(request);
    }
    return remoteAddr;
});
```

---

## Production Checklist

- [ ] All REST endpoints have ownership checks (@PreAuthorize) — not just authentication
- [ ] PAN / account numbers are masked in all log statements
- [ ] Tokenisation service used for PAN storage — raw PANs never persisted
- [ ] All database queries use PreparedStatement or JPA named parameters
- [ ] Business rule validation (self-transfer, daily limits, positive amounts) enforced in service layer
- [ ] Actuator endpoints restricted to management port with IP allowlist
- [ ] `management.endpoint.env.enabled=false` in all environments
- [ ] OWASP Dependency Check plugin runs in CI; build fails on CVSS >= 7
- [ ] SBOM generated for every build and stored with the release
- [ ] JWT validation checks exp, iss, aud, and nbf claims — not just signature
- [ ] Asymmetric JWT signing (RS256/ES256) — no shared HMAC secrets
- [ ] Container images signed with Cosign; Kyverno admission webhook enforces signatures
- [ ] Audit log written for every fund transfer (pre and post-action)
- [ ] Audit log forwarded to immutable SIEM (append-only)
- [ ] Webhook URLs validated against SSRF allowlist before first use and before dispatch
- [ ] DNS rebinding protection: webhook URL re-resolved at dispatch time

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"A user authenticates as user-A and calls GET /api/v1/payments/txn-99999. The payment belongs to user-B. The controller only checks that the user is authenticated (not anonymous). What OWASP category does this represent, and what is the correct fix?","options":["A03 Injection — fix with PreparedStatement to prevent the lookup","A01 Broken Access Control — fix with @PreAuthorize(\"@paymentSecurity.isOwner(#id, authentication)\") to verify ownership","A07 Authentication Failures — fix by requiring MFA for payment lookups","A02 Cryptographic Failures — fix by encrypting payment IDs"],"correct":1,"explanation":"This is A01 Broken Access Control, specifically horizontal privilege escalation — a user accesses another user's resource at the same privilege level. Authentication confirms identity but does not establish ownership. The fix is an ownership check using Spring Security's @PreAuthorize annotation with a custom security evaluator bean that verifies the authenticated user owns the requested payment. PreparedStatement fixes injection, MFA fixes authentication strength, and encrypting IDs only provides obscurity — not access control."},{"text":"A payment service fetches merchant webhook URLs after each transaction. A merchant registers the URL http://169.254.169.254/latest/meta-data/iam/security-credentials/payment-role. What attack is this, and what is the primary defence?","options":["A03 SQL Injection — defend with parameterised queries","A10 SSRF — defend with a strict URL allowlist that blocks private/link-local IP ranges and only permits HTTPS to public internet addresses","A01 Broken Access Control — defend with JWT token validation on the webhook endpoint","A04 Insecure Design — defend with rate limiting on webhook delivery"],"correct":1,"explanation":"This is A10 Server-Side Request Forgery (SSRF). The attacker causes the payment service to make a request to the AWS EC2 instance metadata service (169.254.169.254), which returns temporary IAM credentials. The primary defence is validating the webhook URL before fetching it: resolve the hostname to its IP address(es) and reject any that fall within RFC1918 private ranges, 169.254.0.0/16 link-local, and loopback ranges. Only HTTPS to public internet addresses should be permitted."},{"text":"A JWT token is issued by the authentication service. The payment-service validates the signature but does not check the exp, iss, or aud claims. An attacker obtains a token issued 2 days ago (exp has passed). What can the attacker do?","options":["Nothing — the JWT signature verification prevents replay of old tokens.","Replay the expired token indefinitely to call any payment endpoint, because the service only checks the signature and the signature is still mathematically valid on an expired token.","The attacker must forge a new token — expired tokens cannot be replayed.","The attacker can only use the token for 30 seconds after expiry due to clock skew tolerance."],"correct":1,"explanation":"JWT signature verification only proves the token was signed by the expected private key. It does not enforce temporal validity. If the exp claim is not checked, an expired token's signature remains mathematically valid forever. The attacker can replay a 2-day-old token indefinitely. The fix is to call requireExpiration() (or equivalent) during JWT parsing, which rejects tokens where exp is in the past. The iss claim check prevents tokens from other issuers, and the aud claim check prevents tokens issued for other services from being used against the payment-service."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"OWASP Top 10 Security Hardening for Payment Service","difficulty":"advanced","estimatedMinutes":120,"tasks":[{"id":"1","description":"Audit a sample Spring Boot payment REST controller for A01 Broken Access Control and A07 Authentication Failures. The controller exposes GET /payments/{id}, GET /payments (all payments), and POST /transfers. Add @PreAuthorize ownership checks using a custom PaymentSecurityEvaluator bean. Add full JWT claim validation (exp, iss, aud, nbf) using an asymmetric RS256 key. Write integration tests using Spring Security test support that verify: (a) user-A cannot access user-B's payment, (b) an expired token is rejected with 401, (c) a token with the wrong audience is rejected."},{"id":"2","description":"Implement SSRF protection for a webhook dispatch service. Write a WebhookUrlValidator class that: resolves the hostname, checks all resolved IPs against RFC1918/link-local/loopback CIDR blocks, rejects non-HTTPS schemes, and rejects URLs containing credentials. Write unit tests covering: HTTP scheme rejection, 10.x.x.x IP rejection, 169.254.x.x rejection, valid HTTPS public URL acceptance, and DNS-resolved private IP rejection. Integrate the validator into a WebhookDispatchService that also adds an HMAC-SHA256 signature header."},{"id":"3","description":"Implement structured immutable audit logging for fund transfers (A09). Create an AuditEvent entity with fields: eventType, actor, ipAddress, sourceAccountId, destinationAccountId, amount, currency, traceId, timestamp, result, failureReason. Write a FundTransferAuditService that logs both pre-action (FUND_TRANSFER_INITIATED) and post-action (FUND_TRANSFER_COMPLETED or FUND_TRANSFER_FAILED) events as structured JSON. Configure the audit log to write to a dedicated append-only Loki stream with label {stream=\"audit\"}. Add a LogQL query that surfaces all failed transfers in the last 24 hours."},{"id":"4","description":"Configure OWASP Dependency Check in the Maven build (fail on CVSS >= 7). Add a GitHub Actions workflow that builds the payment-service Docker image, generates an SPDX SBOM using Syft, scans the SBOM with Grype, and fails the build on HIGH or CRITICAL CVEs. Set up a Kyverno ClusterPolicy in a local kind cluster that rejects unsigned container images in the payments namespace. Sign the image with Cosign and demonstrate that an unsigned image is rejected by the admission webhook."}]} -->
