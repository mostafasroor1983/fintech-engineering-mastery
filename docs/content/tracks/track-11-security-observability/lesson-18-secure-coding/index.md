---
id: track-11-lesson-18
title: "Secure Coding Practices — Java Security Anti-Patterns"
slug: secure-coding
track: track-11
trackName: "Security & Observability"
sequence: 18
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [secure-coding, SQL-injection, deserialization, XXE, Java]
prerequisites: [track-11-lesson-17]
---

# Secure Coding Practices — Java Security Anti-Patterns

> [!NOTE]
> Security vulnerabilities are code quality issues. The same rigour applied to correctness and performance must be applied to security. This lesson maps the most dangerous Java anti-patterns to their financial impact, with before/after code examples for each.

## Anti-Pattern 1: String Concatenation SQL

**Risk**: Complete database exposure. An attacker can read any table, modify balances, or drop tables.

```java
// VULNERABLE — direct string concatenation into SQL
@Repository
public class TransactionRepository {

    // Attacker input: status = "' OR '1'='1' --"
    // Resulting SQL: SELECT * FROM transactions WHERE status = '' OR '1'='1' --'
    // This returns ALL transactions for ALL customers
    public List<Transaction> findByStatus(String status) {
        String sql = "SELECT * FROM transactions WHERE status = '" + status + "'";
        return jdbcTemplate.query(sql, transactionRowMapper);
    }

    // Worse: attacker input in JPQL
    // status = "' OR '1'='1' -- "
    public List<Transaction> jpqlInjection(String status) {
        return entityManager
            .createQuery("SELECT t FROM Transaction t WHERE t.status = '" + status + "'",
                Transaction.class)
            .getResultList();
    }
}
```

```java
// SECURE — multiple safe approaches

// Options 1 and 2: Spring Data JPA repository (an interface)
public interface TransactionRepository extends JpaRepository<Transaction, Long> {

    // Option 1: derived query — parameterised automatically
    List<Transaction> findByStatus(TransactionStatus status);  // Uses enum, not String

    // Option 2: JPQL with named parameter
    @Query("SELECT t FROM Transaction t WHERE t.status = :status")
    List<Transaction> findByStatusJpql(@Param("status") TransactionStatus status);
}

// Options 3 and 4: plain JDBC
@Repository
public class TransactionJdbcDao {

    // Option 3: JdbcTemplate with positional parameter
    public List<Transaction> findByStatusJdbc(TransactionStatus status) {
        return jdbcTemplate.query(
            "SELECT * FROM transactions WHERE status = ?",
            transactionRowMapper,
            status.name()             // Bound separately, never concatenated
        );
    }

    // Option 4: Named JdbcTemplate parameter
    public List<Transaction> findByStatusNamed(TransactionStatus status) {
        MapSqlParameterSource params = new MapSqlParameterSource()
            .addValue("status", status.name());
        return namedJdbcTemplate.query(
            "SELECT * FROM transactions WHERE status = :status",
            params,
            transactionRowMapper
        );
    }
}
// Parameters cannot be used for identifiers (ORDER BY column, table name):
// map user input to a fixed allowlist of column names instead
```

---

## Anti-Pattern 2: Java Deserialization

**Risk**: Remote code execution. An attacker who controls serialized bytes can execute arbitrary code on your server. The Apache Commons Collections and Spring Framework deserialization gadget chains are well-documented exploits.

```java
// VULNERABLE — deserializing untrusted data with native Java serialization
@PostMapping("/api/v1/payments/batch")
public ResponseEntity<?> processBatch(@RequestBody byte[] requestBody) {
    try {
        ObjectInputStream ois = new ObjectInputStream(
            new ByteArrayInputStream(requestBody)
        );
        // If requestBody contains a crafted serialized payload,
        // this executes arbitrary code during readObject()
        BatchPaymentRequest request = (BatchPaymentRequest) ois.readObject();
        return ResponseEntity.ok(paymentService.processBatch(request));
    } catch (Exception e) {
        return ResponseEntity.badRequest().build();
    }
}

// ALSO VULNERABLE — Jackson class-name polymorphism on a broad declared type
public class PaymentMessage {
    @JsonTypeInfo(use = JsonTypeInfo.Id.CLASS)  // class name is taken from the JSON
    private Object payload;                      // ...and ANY class on the classpath fits
}
// Attacker submits {"payload": {"@class": "<gadget class>", ...}} naming a class
// whose constructor or setters do something dangerous (load remote config,
// open a JNDI connection). Same risk: objectMapper.activateDefaultTyping(...)
// without a strict PolymorphicTypeValidator.
```

```java
// SECURE — safe deserialization patterns

// Option 1: Use JSON (Jackson) instead of Java serialization for all APIs
// Jackson is safe as long as class-name-based typing (@JsonTypeInfo(use = CLASS)
// or default typing) is not used
@PostMapping("/api/v1/payments/batch")
public ResponseEntity<?> processBatch(
        @Valid @RequestBody BatchPaymentRequest request) {
    // Spring Boot auto-configures Jackson — no ObjectInputStream involved
    return ResponseEntity.ok(paymentService.processBatch(request));
}

// Option 2: If Java serialization is unavoidable, use an ObjectInputFilter
// with an ALLOWLIST and size limits. "!*" at the end rejects every class
// not listed — including gadget-chain classes.
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter(
    "com.example.payments.BatchPaymentRequest;" +
    "com.example.payments.PaymentInstruction;" +
    "java.math.BigDecimal;java.math.BigInteger;java.lang.Number;java.util.ArrayList;" +
    "maxdepth=10;maxrefs=10000;maxbytes=1048576;!*");
ObjectInputStream ois = new ObjectInputStream(inputStream);
ois.setObjectInputFilter(filter);
// (Or set a JVM-wide filter: -Djdk.serialFilter=...)

// Option 3: Jackson — use name-based polymorphism (not class-based)
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = ImmediatePayment.class, name = "IMMEDIATE"),
    @JsonSubTypes.Type(value = ScheduledPayment.class, name = "SCHEDULED")
})
// Attacker cannot inject arbitrary class names — only "IMMEDIATE" or "SCHEDULED" are valid
public abstract class Payment { ... }
```

---

## Anti-Pattern 3: XXE in XML Parsing

**Risk**: Server-side request forgery (SSRF) and local file read. An attacker can read `/etc/passwd`, internal Kubernetes service files, or cause denial of service via entity expansion bombs.

```java
// VULNERABLE — default XML parser configuration allows external entities
@PostMapping("/api/v1/payments/sepa")
public ResponseEntity<?> processSepaCreditTransfer(@RequestBody String xmlPayload) {
    try {
        DocumentBuilder builder = DocumentBuilderFactory.newInstance().newDocumentBuilder();
        // Attacker submits:
        // <?xml version="1.0"?>
        // <!DOCTYPE foo [
        //   <!ENTITY xxe SYSTEM "file:///etc/passwd">
        // ]>
        // <payment><reference>&xxe;</reference></payment>
        // Result: /etc/passwd contents returned in response
        Document doc = builder.parse(new InputSource(new StringReader(xmlPayload)));
        return ResponseEntity.ok(parsePayment(doc));
    } catch (Exception e) {
        return ResponseEntity.badRequest().build();
    }
}
```

```java
// SECURE — disable all external entity processing
@PostMapping("/api/v1/payments/sepa")
public ResponseEntity<?> processSepaCreditTransfer(@RequestBody String xmlPayload) {
    try {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();

        // Disable ALL forms of external entity resolution
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);

        DocumentBuilder builder = factory.newDocumentBuilder();
        // Now safe — DOCTYPE declarations will throw an exception
        Document doc = builder.parse(new InputSource(new StringReader(xmlPayload)));
        return ResponseEntity.ok(parsePayment(doc));

    } catch (Exception e) {
        return ResponseEntity.badRequest()
            .body(new ErrorResponse("INVALID_XML", "XML payload could not be parsed"));
    }
}

// Alternative: StAX (streaming) — its defaults are NOT safe either,
// so DTDs and external entities must be switched off explicitly
@Service
public class SepaXmlParser {
    public SepaPayment parse(String xml) throws XMLStreamException {
        XMLInputFactory factory = XMLInputFactory.newInstance();
        // Disable external entity resolution
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);

        XMLStreamReader reader = factory.createXMLStreamReader(new StringReader(xml));
        // Parse using cursor-based API — faster and safer than DOM for large SEPA files
        return parseSepaDocument(reader);
    }
}
```

---

## Anti-Pattern 4: SSRF in Outbound HTTP

**Risk**: An attacker who controls a URL parameter can direct your payment service to call internal Kubernetes services, AWS metadata endpoint, or Vault, potentially exfiltrating secrets.

```java
// VULNERABLE — blindly following URLs from user input
@PostMapping("/api/v1/payments/webhook-verify")
public ResponseEntity<?> verifyWebhook(@RequestBody WebhookConfig config) {
    // Attacker submits: callbackUrl = "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
    // Result: AWS IAM credentials returned to attacker
    // Or: callbackUrl = "http://vault.internal:8200/v1/secret/data/api-keys"
    ResponseEntity<String> response = restTemplate.getForEntity(
        config.getCallbackUrl(),  // User-controlled URL — SSRF
        String.class
    );
    return ResponseEntity.ok(response.getBody());
}
```

```java
// SECURE — allowlist-based URL validation
@Component
public class UrlValidator {

    // Only these domains are permitted for outbound webhook callbacks
    private static final Set<String> ALLOWED_DOMAINS = Set.of(
        "api.example.com",
        "webhooks.partner-payments.com",
        "notify.payment-processor.co.uk"
    );

    // Blocked IP ranges (RFC 6890 special-purpose addresses).
    // InetAddressRange is a small CIDR helper (the JDK has none)
    private static final List<InetAddressRange> BLOCKED_RANGES = List.of(
        InetAddressRange.of("127.0.0.0/8"),    // Loopback
        InetAddressRange.of("10.0.0.0/8"),     // Private
        InetAddressRange.of("172.16.0.0/12"),  // Private
        InetAddressRange.of("192.168.0.0/16"), // Private
        InetAddressRange.of("169.254.0.0/16"), // Link-local (AWS metadata)
        InetAddressRange.of("100.64.0.0/10"),  // Carrier-grade NAT
        InetAddressRange.of("::1/128"),         // IPv6 loopback
        InetAddressRange.of("fc00::/7")         // IPv6 unique local
    );

    public void validateWebhookUrl(String urlString) {
        URI url;
        try {
            url = new URI(urlString);    // new URL(String) is deprecated since Java 20
        } catch (URISyntaxException e) {
            throw new InvalidUrlException("Malformed URL: " + urlString);
        }

        // 1. Protocol check — only HTTPS, no credentials in the URL
        if (!"https".equalsIgnoreCase(url.getScheme()) || url.getUserInfo() != null) {
            throw new InvalidUrlException("Only HTTPS webhooks without credentials are permitted");
        }

        // 2. Domain allowlist check
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (!ALLOWED_DOMAINS.contains(host)) {
            throw new InvalidUrlException("Webhook domain not in allowlist: " + host);
        }

        // 3. IP address resolution check. On its own this does not stop DNS
        // rebinding (the HTTP client resolves again later): connect to the
        // validated IP (pinned resolver) or via an egress proxy, and disable
        // redirect following.
        try {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            for (InetAddress addr : addresses) {
                if (isBlockedAddress(addr)) {
                    throw new InvalidUrlException(
                        "Webhook URL resolves to blocked IP range: " + addr.getHostAddress());
                }
            }
        } catch (UnknownHostException e) {
            throw new InvalidUrlException("Cannot resolve webhook host: " + host);
        }
    }
}
```

---

## Anti-Pattern 5: Hardcoded Secrets

**Risk**: Any developer, CI system, or attacker with git access has the secret. Secrets committed to git are effectively public.

```java
// VULNERABLE — hardcoded credentials
@Configuration
public class PaymentGatewayConfig {
    // These values are in every git clone, every Docker image layer,
    // every CI artifact, every developer's laptop
    private static final String API_KEY = "sk_live_abc123def456";
    private static final String DATABASE_URL = "jdbc:postgresql://prod-db:5432/payments";
    private static final String DATABASE_PASSWORD = "prod_super_secret_password";
    private static final String STRIPE_WEBHOOK_SECRET = "whsec_abc123";
}
```

```java
// SECURE — secrets from environment (injected by Kubernetes Secrets/Vault)
@Configuration
public class PaymentGatewayConfig {

    // Option 1: Spring @Value — injected from environment or Vault
    @Value("${payment.gateway.api-key}")
    private String apiKey;

    // Option 2: Spring Cloud Vault — secrets loaded from Vault automatically
    // application.yml: spring.config.import=vault:// and
    //                  spring.cloud.vault.authentication=KUBERNETES
    // Vault path: secret/payment-service/gateway → payment.gateway.api-key
}
```

```yaml
# OPTION A (dev/test only): a plain Kubernetes Secret.
# Never commit real values to git; kubectl does not substitute ${...}.
apiVersion: v1
kind: Secret
metadata:
  name: payment-gateway-credentials
  namespace: payments
type: Opaque
# Values are base64-encoded — NOT encryption, just encoding
# Use sealed-secrets or External Secrets Operator for real security
stringData:
  api-key: "${PAYMENT_GATEWAY_API_KEY}"  # placeholder, rendered by the pipeline

---
# OPTION B (production): External Secrets Operator syncs the Secret from
# Vault (use one option or the other -- both manage the same Secret name)
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: payment-gateway-credentials
  namespace: payments
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: payment-gateway-credentials
  data:
  - secretKey: api-key
    remoteRef:
      key: payment-service/gateway   # path inside the store's KV mount ("secret")
      property: api_key
```

---

## Anti-Pattern 6: Timing Attacks in Authentication

**Risk**: By measuring response time, an attacker can determine if a username/email exists or if a partial password is correct.

```java
// VULNERABLE — returns faster when user is not found (timing leak)
public boolean verifyApiKey(String providedKey, String userId) {
    String storedKey = apiKeyRepository.findByUserId(userId);
    if (storedKey == null) {
        return false;  // Returns immediately — faster than when user exists
    }
    return storedKey.equals(providedKey);  // Also non-constant-time for Strings
}

// ALSO VULNERABLE — String.equals() short-circuits on first mismatch
// Attacker can measure timing to determine correct characters one by one
```

```java
// SECURE — store only a hash of each API key, compare in constant time
private static final byte[] DUMMY_HASH = sha256("dummy-key-for-unknown-users");

public boolean verifyApiKey(String providedKey, String userId) {
    // API keys are high-entropy random values, so a fast SHA-256 is enough
    // (low-entropy PASSWORDS need bcrypt/scrypt/Argon2 instead)
    byte[] storedHash = apiKeyRepository.findHashByUserId(userId);  // null if unknown
    byte[] providedHash = sha256(providedKey == null ? "" : providedKey);

    // Same work whether or not the user exists: compare against a dummy hash.
    // Hashing also makes both arrays the same length (32 bytes) — isEqual
    // returns early on a LENGTH mismatch
    byte[] expected = storedHash != null ? storedHash : DUMMY_HASH;
    boolean keysMatch = MessageDigest.isEqual(providedHash, expected);  // constant-time

    return storedHash != null && keysMatch;
    // (The database lookup itself can still differ in timing — rate limiting
    // and uniform error responses close the remaining gap)
}

// For HMAC-based verification (e.g., Stripe webhook signatures)
public boolean verifyHmacSignature(String payload, String signature, String secret) {
    try {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] expectedSignatureBytes = mac.doFinal(
            payload.getBytes(StandardCharsets.UTF_8)
        );
        byte[] providedSignatureBytes = HexFormat.of().parseHex(signature);

        // Constant-time comparison
        return MessageDigest.isEqual(expectedSignatureBytes, providedSignatureBytes);
    } catch (Exception e) {
        return false;
    }
}
```

---

## Anti-Pattern 7: Insecure Random Number Generation

**Risk**: Predictable transaction IDs, session tokens, or idempotency keys allow attackers to guess or enumerate values.

```java
// VULNERABLE — predictable random values
public class InsecureRandomExamples {

    // java.util.Random — not cryptographically secure: a 48-bit linear
    // congruential generator whose internal state can be recovered from
    // a couple of observed outputs — then every future value is known
    private final Random random = new Random();

    public String generateTransactionId() {
        // Predictable — attacker can reconstruct the sequence from earlier IDs
        return "TX-" + random.nextLong();
    }

    // Math.random() — same issue, non-secure
    public String generateOtpCode() {
        return String.format("%06d", (int)(Math.random() * 1_000_000));
    }

    // Sequential ID — trivially enumerable
    public String generateApiKey() {
        return "KEY-" + System.currentTimeMillis();  // Enumerable by timestamp
    }
}
```

```java
// SECURE — cryptographically secure random values
public class SecureRandomExamples {

    // SecureRandom uses OS entropy sources (/dev/urandom on Linux)
    // Thread-safe; reuse the same instance
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    public String generateTransactionId() {
        // 128 bits of entropy — 2^128 possible values, not enumerable
        byte[] bytes = new byte[16];
        SECURE_RANDOM.nextBytes(bytes);
        return "TX-" + HexFormat.of().formatHex(bytes);
    }

    public String generateOtpCode() {
        // 6-digit OTP — 10^6 possibilities; short-lived, so acceptable
        // Use SECURE_RANDOM to prevent statistical biases
        return String.format("%06d", SECURE_RANDOM.nextInt(1_000_000));
    }

    public String generateApiKey() {
        // 256 bits of entropy — suitable for long-lived API keys
        byte[] bytes = new byte[32];
        SECURE_RANDOM.nextBytes(bytes);
        return "sk_live_" + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    // Best practice for most cases: UUID.randomUUID() uses SecureRandom internally
    public String generateIdempotencyKey() {
        return UUID.randomUUID().toString();  // 122 bits of secure random
    }
}
```

---

## Secure Coding Checklist

Use this checklist during code review for every payment-related code change:

```
INPUT VALIDATION
  [ ] All user-supplied input validated against allowlist patterns
  [ ] Financial data (IBAN, PAN, amount) validated with checksum algorithms
  [ ] No user input directly concatenated into SQL, JPQL, or dynamic queries
  [ ] XML parsing with external entities disabled
  [ ] URL inputs validated against an allowlist before outbound HTTP calls; redirects not followed

AUTHENTICATION & AUTHORISATION
  [ ] Every endpoint has @PreAuthorize or equivalent
  [ ] Database queries filtered by authenticated customer ID (IDOR prevention)
  [ ] Admin endpoints require both ADMIN role AND admin scope
  [ ] Token validation includes: alg, exp, iat, iss, aud, scope

CRYPTOGRAPHY
  [ ] No java.util.Random or Math.random() for security-sensitive operations
  [ ] No MD5 or SHA-1 for new code
  [ ] No DES, 3DES, or AES/ECB
  [ ] Constant-time comparison for sensitive string equality
  [ ] IV is unique per encryption operation

SECRETS MANAGEMENT
  [ ] No hardcoded credentials, API keys, passwords, or certificates
  [ ] Secrets loaded from Vault or Kubernetes secrets via environment injection
  [ ] Encryption keys wiped from memory after use

DATA PROTECTION
  [ ] PAN and PII masked before logging
  [ ] Stack traces not returned to API clients
  [ ] Sensitive fields annotated with @Convert(converter = EncryptedStringConverter.class)

DESERIALIZATION
  [ ] No ObjectInputStream on untrusted data
  [ ] Jackson @JsonTypeInfo(use = CLASS) not used
  [ ] If Java serialization required, ObjectInputFilter allowlist in place
```

---

## Key Takeaways

- SQL injection via string concatenation remains common in payment codebases because JPQL (not just SQL) is also injectable—use named parameters consistently in every ORM query
- Java deserialization is remote code execution waiting to happen—never deserialize untrusted bytes with `ObjectInputStream`; use JSON for all APIs and allowlist-filter any unavoidable Java serialization
- XXE prevention requires explicitly disabling DTDs and external entities—the JDK's default `DocumentBuilderFactory`, `SAXParserFactory` and `XMLInputFactory` all allow them
- SSRF prevention requires checking the IP address the connection will actually use (pinned resolution or an egress proxy) and refusing redirects—a domain allowlist or a one-off DNS check alone can be bypassed via DNS rebinding
- Constant-time comparison with `MessageDigest.isEqual()` is mandatory for all authentication secrets—`String.equals()` is a timing oracle
- Create one `SecureRandom` instance and reuse it—it is thread-safe, and creating a new instance per call is wasteful

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why is Java ObjectInputStream deserialization of untrusted data classified as a critical vulnerability in payment systems?",
      "options": [
        "It is slow and impacts payment throughput",
        "Java deserialization can trigger arbitrary code execution via gadget chains in common libraries (Commons Collections, Spring) — attackers craft serialized payloads that execute OS commands when deserialized",
        "It allows SQL injection attacks",
        "It exposes the database schema to attackers"
      ],
      "correct": 1,
      "explanation": "Java deserialization vulnerabilities (exploiting gadget chains in classpath libraries) have enabled remote code execution in numerous payment platform breaches. When ObjectInputStream.readObject() processes a malicious serialized payload, it invokes methods on existing classes in the JVM, chaining them into arbitrary code execution without any application logic being involved."
    },
    {
      "text": "Why does using String.equals() for comparing API keys or HMAC signatures create a security vulnerability?",
      "options": [
        "String.equals() is too slow for security operations",
        "String.equals() short-circuits on the first differing character, creating a timing side channel — an attacker can measure response times to determine how many leading characters of their guess are correct, enabling byte-by-byte brute force",
        "String.equals() does not handle Unicode correctly",
        "String.equals() is not thread-safe"
      ],
      "correct": 1,
      "explanation": "String.equals() returns false as soon as it finds a differing character. For a completely wrong key, it returns in nanoseconds; for a key that matches the first 30 characters, it takes longer. This timing difference is measurable over many requests, allowing an attacker to determine correct characters one by one. MessageDigest.isEqual() always compares all bytes."
    },
    {
      "text": "What is an SSRF (Server-Side Request Forgery) vulnerability, and what makes IP-block-list validation after DNS resolution necessary?",
      "options": [
        "SSRF allows attackers to forge their own requests; IP validation is for rate limiting",
        "SSRF tricks the server into making HTTP requests to internal services; IP validation after DNS resolution is necessary because domain allowlisting alone can be bypassed via DNS rebinding (the domain resolves to an allowed host initially but rebinds to an internal IP for the actual request)",
        "SSRF is a form of SQL injection; IP validation prevents it",
        "SSRF allows cookie theft; IP validation protects session tokens"
      ],
      "correct": 1,
      "explanation": "In an SSRF attack, an attacker provides a URL that the server fetches. With DNS rebinding, the attacker's domain first resolves to a harmless public IP (passing the check) and then, when the HTTP client resolves it again for the actual request, to an internal IP (169.254.x.x, 10.x.x.x). The robust defence is to validate the IP the connection actually uses — a pinned resolver that applies the block list at connect time, or an egress proxy enforcing the rules — and to refuse redirects."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Fixing Secure Coding Anti-Patterns in a Payment Codebase",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "Identify and fix three injection vulnerabilities in a sample payment codebase: a JPQL query built with string concatenation for a payment search endpoint, an ORDER BY clause using a user-provided sort field, and an XML DocumentBuilder that processes untrusted XML without disabling external entity expansion."
    },
    {
      "id": "2",
      "description": "Implement SSRF prevention for a payment service that makes outbound webhook calls: validate the target URL against an allowlist of approved domains, resolve the domain to an IP, block private/loopback/link-local IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, plus IPv6 equivalents), and make the HTTP client connect only to the validated IP (custom DNS resolver) with redirects disabled."
    },
    {
      "id": "3",
      "description": "Replace all security-sensitive Random usage in a sample codebase with SecureRandom: transaction IDs, OTP codes, API key generation, and idempotency keys. Write a Semgrep rule that detects new java.util.Random instances and Math.random() calls in security-sensitive packages and add it to the CI pipeline."
    },
    {
      "id": "4",
      "description": "Create a comprehensive secure coding review checklist automation: write a JUnit test suite that uses reflection to scan all @RestController classes and verify they have @PreAuthorize annotations, verify no @Entity class has @JsonProperty annotations (preventing mass assignment), and verify no service class creates Random instances."
    }
  ]
}
-->
