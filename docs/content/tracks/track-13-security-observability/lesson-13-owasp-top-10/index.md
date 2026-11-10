---
id: track-13-lesson-13
title: "OWASP Top 10 — Financial Services Threat Landscape"
slug: owasp-top-10
track: track-13
trackName: "Security & Observability"
sequence: 13
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [OWASP, injection, XSS, SSRF, broken-auth]
prerequisites: [track-13-lesson-12]
---

# OWASP Top 10 — Financial Services Threat Landscape

> [!NOTE]
> The OWASP Top 10 is not an abstract security list—each entry has a direct financial impact equivalent. A01 Broken Access Control in a payment API means customers can access each other's accounts. A03 Injection in a transaction search means an attacker can read the entire payments database. This lesson maps each OWASP category to concrete financial API vulnerabilities with Java/Spring mitigation code.

## A01: Broken Access Control

The number one vulnerability in 2021. For payment APIs, broken access control manifests as IDOR (Insecure Direct Object Reference): an attacker uses a valid token but substitutes a different customer's account ID in the URL.

### Vulnerability Example

```java
// VULNERABLE — trusts account ID from URL without ownership verification
@GetMapping("/api/v1/accounts/{accountId}/transactions")
@PreAuthorize("isAuthenticated()")
public List<Transaction> getTransactions(@PathVariable String accountId) {
    // Attacker authenticated as customer-A, requests customer-B's transactions
    // accountId = "ACC-B-123456" (another customer's account)
    return transactionRepository.findByAccountId(accountId);  // Returns attacker sees B's data
}
```

### Secure Implementation

```java
// SECURE — always filter by both accountId AND authenticated customer's ID
@GetMapping("/api/v1/accounts/{accountId}/transactions")
@PreAuthorize("hasAuthority('SCOPE_accounts:read')")
public ResponseEntity<List<TransactionResponse>> getTransactions(
        @PathVariable String accountId,
        @AuthenticationPrincipal Jwt jwt) {

    String customerId = jwt.getClaimAsString("customer_id");

    // Verify ownership before any data access
    Account account = accountRepository.findByIdAndCustomerId(accountId, customerId)
        .orElseThrow(() -> {
            // Log the access attempt — this is a potential attack
            log.warn("SECURITY: Account access denied: customerId={} requestedAccountId={}",
                customerId, accountId);
            // Return 404, not 403 — do not confirm that accountId exists
            return new ResourceNotFoundException("Account not found");
        });

    return ResponseEntity.ok(
        transactionRepository.findByAccount(account).stream()
            .map(this::toResponse)
            .collect(Collectors.toList())
    );
}
```

**Why return 404 instead of 403?** Returning 403 Forbidden confirms the account exists. An attacker can enumerate valid account IDs by looking for 403 responses. Returning 404 for both "doesn't exist" and "doesn't belong to you" prevents enumeration.

### Horizontal vs Vertical Privilege Escalation

```java
// HORIZONTAL escalation — customer A accessing customer B's data (IDOR)
// Prevention: always bind queries to authenticated user's identity

// VERTICAL escalation — regular customer accessing admin endpoints
// Prevention: role-based access control

@GetMapping("/admin/api/customers/{customerId}/full-profile")
@PreAuthorize("hasRole('ADMIN') and hasAuthority('SCOPE_admin:read')")
// Requires BOTH admin role AND explicit admin scope — not just authentication
public AdminCustomerProfile getAdminProfile(@PathVariable String customerId) {
    return adminService.getFullProfile(customerId);
}
```

---

## A02: Cryptographic Failures

Sensitive data exposure through weak cryptography or accidental plaintext logging. In payment systems, this means logging PAN (Primary Account Number), CVV, or customer PII.

### Vulnerability Examples

```java
// VULNERABLE — logging full card number
log.info("Processing payment for card: {}", paymentRequest.getCardNumber());
// Log: "Processing payment for card: 4532015112830366"
// If log file is accessed, PAN is exposed → PCI DSS violation

// VULNERABLE — storing unhashed PIN
customerRepository.save(customer.withPin(enteredPin));
// PIN stored in plaintext — if database breached, all PINs exposed

// VULNERABLE — weak encryption
Cipher cipher = Cipher.getInstance("DES");  // DES is broken
// 56-bit key — can be brute-forced in hours
```

### Secure Implementations

```java
// SECURE — log masked PAN
public String maskPan(String pan) {
    if (pan == null || pan.length() < 13) return "INVALID";
    // Show first 6 (BIN) and last 4 — mask middle digits
    return pan.substring(0, 6) + "######" + pan.substring(pan.length() - 4);
}
log.info("Processing payment for card: {}", maskPan(paymentRequest.getCardNumber()));
// Log: "Processing payment for card: 453201######0366"

// SECURE — PIN storage using BCrypt
@Service
public class PinService {
    private final PasswordEncoder encoder = new BCryptPasswordEncoder(12);
    // Cost factor 12 = ~300ms per hash on modern hardware
    // Enough to slow brute force; acceptable for PIN entry

    public void setPin(String customerId, String pin) {
        // Validate PIN format before hashing
        if (!pin.matches("\\d{4,6}")) throw new InvalidPinException("PIN must be 4-6 digits");
        String hashedPin = encoder.encode(pin);
        customerRepository.updatePin(customerId, hashedPin);
    }

    public boolean verifyPin(String customerId, String enteredPin) {
        String storedHash = customerRepository.getPinHash(customerId);
        // Constant-time comparison — prevents timing attacks
        return encoder.matches(enteredPin, storedHash);
    }
}

// SECURE — AES-256-GCM for field-level encryption
@Component
public class FieldEncryptionService {
    // Key from Vault — never hardcoded
    @Value("${vault.field-encryption-key}")
    private String base64Key;

    public String encrypt(String plaintext) throws Exception {
        byte[] key = Base64.getDecoder().decode(base64Key);
        SecretKeySpec secretKey = new SecretKeySpec(key, "AES");

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        GCMParameterSpec spec = new GCMParameterSpec(128, iv);
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, spec);

        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        // Prepend IV to ciphertext — needed for decryption
        byte[] result = new byte[iv.length + ciphertext.length];
        System.arraycopy(iv, 0, result, 0, iv.length);
        System.arraycopy(ciphertext, 0, result, iv.length, ciphertext.length);
        return Base64.getEncoder().encodeToString(result);
    }
}
```

---

## A03: Injection

SQL injection in payment systems is catastrophic. Beyond data exfiltration, attackers can modify account balances, delete transactions, or extract all customer PII.

### SQL Injection Vulnerability

```java
// VULNERABLE — string concatenation in JPQL (yes, JPQL is also injectable)
@Repository
public class TransactionSearchRepository {

    // VULNERABLE — JPQL injection via string concatenation
    public List<Transaction> search(String status, String orderBy) {
        String jpql = "SELECT t FROM Transaction t WHERE t.status = '" + status
            + "' ORDER BY t." + orderBy;
        // Attacker passes: status = "' OR '1'='1" → returns all transactions
        // Attacker passes: orderBy = "id); DROP TABLE transactions; --"
        return entityManager.createQuery(jpql, Transaction.class).getResultList();
    }
}
```

### Secure Implementations

```java
// SECURE — parameterised JPQL
public List<Transaction> search(String status, SortField orderBy) {
    // SortField is an enum — only valid fields can be used for ordering
    String jpql = "SELECT t FROM Transaction t WHERE t.status = :status ORDER BY t."
        + orderBy.getFieldName();  // Enum value — not raw user input
    return entityManager.createQuery(jpql, Transaction.class)
        .setParameter("status", status)
        .getResultList();
}

// SortField enum — prevents injection in ORDER BY clauses
public enum SortField {
    CREATED_AT("createdAt"),
    AMOUNT("amountMinorUnits"),
    STATUS("status");

    private final String fieldName;
    // Getter...
    // Attacker cannot inject arbitrary ORDER BY values — only enum values accepted
}

// SECURE — full text search using Spring Data Specifications
public List<Transaction> searchTransactions(TransactionSearchSpec spec) {
    Specification<Transaction> specification = Specification
        .where(TransactionSpecs.hasStatus(spec.getStatus()))
        .and(TransactionSpecs.hasAmountBetween(spec.getMinAmount(), spec.getMaxAmount()))
        .and(TransactionSpecs.afterDate(spec.getFromDate()));

    return transactionRepository.findAll(specification);
}

// Each Specification uses Criteria API — parameterised internally
public static Specification<Transaction> hasStatus(TransactionStatus status) {
    return (root, query, cb) ->
        status == null ? cb.conjunction() : cb.equal(root.get("status"), status);
}
```

### NoSQL Injection (MongoDB)

```java
// VULNERABLE — NoSQL injection via MongoDB query construction
// Attacker passes: {"$gt": ""} as the accountId parameter
Document filter = new Document("accountId", userInput);
collection.find(filter);  // If userInput is a Document, MongoDB interprets operators

// SECURE — strict type validation before constructing query
public List<Document> findTransactions(String accountId) {
    // Validate accountId is a string matching expected pattern
    if (accountId == null || !accountId.matches("^ACC-[A-Z0-9]{8,20}$")) {
        throw new InvalidInputException("Invalid account ID format");
    }
    // Now safe to use as a string value in query
    Document filter = new Document("accountId", accountId);
    return collection.find(filter).into(new ArrayList<>());
}
```

---

## A07: Identification and Authentication Failures

Broken authentication in payment APIs allows attackers to take over accounts, impersonate customers, and authorize fraudulent transactions.

### Common Failures

```java
// VULNERABLE — insufficient brute force protection
@PostMapping("/auth/login")
public ResponseEntity<?> login(@RequestBody LoginRequest request) {
    // No rate limiting → attacker can try millions of passwords
    Optional<Customer> customer = customerRepository.findByEmail(request.getEmail());
    if (customer.isPresent() && customer.get().getPassword().equals(request.getPassword())) {
        return ResponseEntity.ok(generateToken(customer.get()));
    }
    return ResponseEntity.status(401).build();
    // Also: comparing passwords with .equals() not constant-time → timing attack
}

// VULNERABLE — predictable session tokens
String sessionToken = "SESSION-" + System.currentTimeMillis();
// Attackers can enumerate sessions based on timestamp

// VULNERABLE — password stored in plaintext in JWT
// (yes, this happens)
Map<String, Object> claims = Map.of(
    "sub", customer.getId(),
    "password", customer.getPassword()  // NEVER include password in JWT
);
```

### Secure Authentication

```java
@PostMapping("/auth/login")
@RateLimit(operation = "account:login")  // 5 attempts per minute per IP
public ResponseEntity<TokenResponse> login(
        @Valid @RequestBody LoginRequest request,
        HttpServletRequest httpRequest) {

    String email = request.getEmail().toLowerCase().trim();
    String ipAddress = getClientIp(httpRequest);

    // Check if IP or account is locked out
    if (loginAttemptService.isBlocked(email, ipAddress)) {
        log.warn("SECURITY: Blocked login attempt email={} ip={}", email, ipAddress);
        // Return 429 — attacker knows they are blocked but cannot enumerate accounts
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
            .header("Retry-After", "300")
            .build();
    }

    // Look up customer
    Optional<Customer> customerOpt = customerRepository.findByEmail(email);

    // ALWAYS run the password verification even if customer not found
    // This prevents timing attacks that reveal whether email exists
    String passwordToCheck = customerOpt.map(Customer::getPasswordHash)
        .orElse("$2a$12$placeholder_hash_to_prevent_timing_attacks");

    boolean passwordValid = passwordEncoder.matches(request.getPassword(), passwordToCheck);

    if (customerOpt.isEmpty() || !passwordValid) {
        loginAttemptService.recordFailure(email, ipAddress);
        // Same response for "email not found" and "wrong password"
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
            .body(new ErrorResponse("INVALID_CREDENTIALS", "Email or password incorrect"));
    }

    Customer customer = customerOpt.get();
    loginAttemptService.recordSuccess(email, ipAddress);

    // Require MFA for payment-capable accounts
    if (customer.hasMfaEnabled()) {
        String mfaToken = mfaService.initiateChallenge(customer.getId());
        return ResponseEntity.ok(new MfaRequiredResponse(mfaToken));
    }

    return ResponseEntity.ok(tokenService.issueTokens(customer));
}
```

---

## A09: Security Logging Failures

Not logging security events means you cannot detect attacks in progress and cannot reconstruct what happened during a breach.

### What Must Be Logged in Payment Systems

```java
@Aspect
@Component
public class SecurityAuditAspect {

    // Every payment operation must be logged to the audit trail
    @AfterReturning(
        pointcut = "@annotation(com.example.payment.audit.AuditPayment)",
        returning = "result"
    )
    public void auditPaymentOperation(JoinPoint joinPoint, Object result) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String customerId = extractCustomerId(auth);
        String method = joinPoint.getSignature().getName();

        securityAuditService.log(SecurityAuditEvent.builder()
            .eventType("PAYMENT_OPERATION")
            .action(method)
            .customerId(customerId)
            .result("SUCCESS")
            .ipAddress(getCurrentIpAddress())
            .sessionId(getCurrentSessionId())
            .timestamp(Instant.now())
            .build());
    }

    @AfterThrowing(
        pointcut = "@annotation(com.example.payment.audit.AuditPayment)",
        throwing = "ex"
    )
    public void auditPaymentFailure(JoinPoint joinPoint, Exception ex) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        String customerId = extractCustomerId(auth);

        securityAuditService.log(SecurityAuditEvent.builder()
            .eventType("PAYMENT_OPERATION")
            .action(joinPoint.getSignature().getName())
            .customerId(customerId)
            .result("FAILURE")
            .errorType(ex.getClass().getSimpleName())
            .ipAddress(getCurrentIpAddress())
            .timestamp(Instant.now())
            .build());
    }
}

// Minimum audit events for a payment system
// (Must be logged to tamper-evident audit log — separate from application logs)
public enum SecurityAuditEventType {
    // Authentication events
    LOGIN_SUCCESS,
    LOGIN_FAILURE,
    LOGOUT,
    MFA_SUCCESS,
    MFA_FAILURE,
    PASSWORD_CHANGED,
    PASSWORD_RESET_REQUESTED,

    // Session events
    SESSION_CREATED,
    SESSION_EXPIRED,
    TOKEN_REFRESHED,
    TOKEN_REVOKED,

    // Payment events
    PAYMENT_SUBMITTED,
    PAYMENT_APPROVED,
    PAYMENT_REJECTED,
    PAYMENT_CANCELLED,

    // Account access events
    ACCOUNT_VIEWED,
    ACCOUNT_DATA_EXPORTED,
    ACCOUNT_SETTINGS_CHANGED,

    // Administrative events
    ADMIN_LOGIN,
    ADMIN_DATA_ACCESS,
    PRIVILEGE_ESCALATION_ATTEMPT,

    // Security events
    RATE_LIMIT_EXCEEDED,
    INVALID_TOKEN_PRESENTED,
    SUSPICIOUS_ACTIVITY_DETECTED
}
```

### Structured Security Logs

```java
// Security logs must be structured, immutable, and separately stored from application logs
@Service
public class SecurityAuditService {

    // Write to append-only security audit table — never updated, never deleted
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    // REQUIRES_NEW: audit log entry is committed even if main transaction rolls back
    public void log(SecurityAuditEvent event) {
        // Sanitise before logging — never log raw user input
        String sanitizedCustomerId = sanitize(event.getCustomerId());

        SecurityAuditLog entry = SecurityAuditLog.builder()
            .eventType(event.getEventType().name())
            .customerId(sanitizedCustomerId)
            .action(event.getAction())
            .result(event.getResult())
            // Hash IP address for GDPR compliance — still useful for correlation
            .ipAddressHash(hashIp(event.getIpAddress()))
            .sessionId(event.getSessionId())
            .timestamp(event.getTimestamp())
            .eventId(UUID.randomUUID().toString())  // Unique ID for correlation
            .build();

        auditLogRepository.save(entry);  // Append-only table

        // Also send to SIEM for real-time correlation
        siemEventPublisher.publish(entry);
    }
}
```

---

## A05: Security Misconfiguration

Default configurations in Spring Boot expose endpoints, stack traces, and version information that aid attackers.

```yaml
# application.yml — secure configuration for production
server:
  error:
    # Never return stack traces to clients — reveals internal architecture
    include-stacktrace: never
    include-message: never  # May reveal sensitive info
    include-binding-errors: never

management:
  endpoints:
    web:
      exposure:
        # Explicitly whitelist — do NOT use "*"
        include: health, metrics, prometheus, info
        # NOT exposed: env, beans, configprops, mappings, threaddump, heapdump
        # (these expose application internals and should require separate auth)
  endpoint:
    health:
      show-details: when-authorized  # Not 'always' — stack info in health details
      show-components: when-authorized
  server:
    # Expose actuator on a different port — only accessible internally
    port: 8081
    # This port should NOT be exposed through the load balancer

spring:
  jpa:
    # Never expose schema generation in production
    hibernate:
      ddl-auto: validate  # Validates schema matches entities — never 'update' or 'create'
  security:
    oauth2:
      resourceserver:
        jwt:
          # Explicit issuer — do not trust any issuer
          issuer-uri: "https://auth.payments.example.com"
```

---

## Security Testing Matrix

| OWASP Category | Test Technique | Tool |
|---------------|----------------|------|
| A01 Broken Access Control | Try accessing other users' resources with valid token | Burp Suite, manual testing |
| A02 Cryptographic Failures | Scan logs for unmasked PAN/PII | Custom grep rules, Semgrep |
| A03 Injection | Automated SQLi scanning; manual testing of search endpoints | OWASP ZAP, sqlmap |
| A05 Security Misconfiguration | Enumerate exposed actuator endpoints, check headers | OWASP ZAP, Nmap |
| A07 Broken Auth | Brute force rate limit testing; token manipulation | Burp Suite Intruder |
| A09 Security Logging | Verify audit events are generated for all payment operations | Manual test + log search |

---

## Key Takeaways

- A01 Broken Access Control is the most common fintech vulnerability: always filter database queries by both resource ID AND authenticated customer ID—never trust the ID in the URL alone
- A02 Cryptographic Failures: mask PAN and PII before logging (first 6 + last 4 of card number), use AES-256-GCM for field encryption, never store passwords or PINs in plaintext
- A03 Injection: use JPA named parameters, Spring Data Specifications, or Criteria API—never concatenate user input into SQL or JPQL strings; enum-based sort fields prevent ORDER BY injection
- A07 Authentication Failures: implement account lockout, rate limiting on login, and constant-time password comparison—returning the same error for "user not found" and "wrong password" prevents email enumeration
- A09 Security Logging: every payment operation, authentication event, and access control failure must be logged to a tamper-evident audit trail—regulatory bodies (FCA, PCI DSS) require this
- Never return stack traces to API clients in production—they reveal internal architecture to attackers

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What makes A01 Broken Access Control specifically dangerous in a payment API, and what is the standard mitigation?",
      "options": ["It allows attackers to crash the server; mitigated by rate limiting", "It allows customers to access other customers' accounts by manipulating IDs in requests; mitigated by always filtering database queries by BOTH the resource ID AND the authenticated customer ID from the JWT", "It exposes API documentation; mitigated by disabling Swagger in production", "It allows SQL injection; mitigated by parameterised queries"],
      "correct": 1,
      "explanation": "IDOR (Insecure Direct Object Reference) is the most common form of A01 in fintech. An attacker changes the payment ID in the URL to another customer's ID. Without filtering by the authenticated customer ID in the query, the system returns that customer's data. The fix: every query must include AND customer_id = :authenticatedCustomerId."
    },
    {
      "text": "Why does GDPR and PCI DSS compliance require masking PAN data before logging, even in internal logs?",
      "options": ["Logging systems have insufficient storage for full PAN data", "Internal logs are not PCI-scoped systems; storing full PAN in logs brings the logging infrastructure into PCI DSS scope and creates GDPR data minimisation violations", "Log files are automatically deleted after 24 hours", "Masked PAN is easier to search"],
      "correct": 1,
      "explanation": "PCI DSS scope follows cardholder data. Logging full PAN to Elasticsearch or Splunk brings those systems into PCI scope, requiring full PCI compliance for logging infrastructure. GDPR's data minimisation principle also requires that only the minimum necessary data be processed — full PAN in debug logs violates this principle."
    },
    {
      "text": "What Spring Boot configuration change prevents A05 Security Misconfiguration by hiding stack traces and internal error details from API clients?",
      "options": ["Setting spring.jpa.hibernate.ddl-auto=validate", "Configuring server.error.include-stacktrace=never, server.error.include-message=never, and limiting exposed actuator endpoints to health, metrics, and prometheus", "Enabling Spring Security CSRF protection", "Disabling Spring Boot auto-configuration"],
      "correct": 1,
      "explanation": "Stack traces reveal class names, library versions, and internal architecture to attackers — directly aiding reconnaissance. Setting include-stacktrace=never ensures only a generic error response reaches clients. Limiting actuator exposure prevents /actuator/env, /actuator/beans, and /actuator/heapdump from leaking configuration and memory contents."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "OWASP Top 10 Mitigations for a Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Find and fix three IDOR vulnerabilities in a sample payment API: a GET /payments/{id} endpoint that does not check customer ownership, a GET /accounts/{id}/balance endpoint that returns any account's balance, and a DELETE /payment-methods/{id} endpoint that deletes any customer's payment method."},
    {"id": "2", "description": "Write a Semgrep custom rule that detects Spring JPA queries using string concatenation (potential JPQL injection), another rule that detects logging statements that may log PAN data (fields named pan, cardNumber, or accountNumber), and integrate both into a CI pipeline that fails the build on match."},
    {"id": "3", "description": "Implement a constant-time account lockout mechanism: after 5 failed authentication attempts within 15 minutes for a specific account, lock the account and send an alert; ensure the response time for locked accounts is identical to unlocked accounts to prevent timing-based enumeration."},
    {"id": "4", "description": "Create a comprehensive Spring Boot security configuration checklist test: write an integration test that verifies (a) stack traces are not in error responses, (b) no sensitive actuator endpoints are exposed publicly, (c) all payment endpoints return 401 without a valid JWT, and (d) CORS rejects requests from non-whitelisted origins."}
  ]
}
-->
