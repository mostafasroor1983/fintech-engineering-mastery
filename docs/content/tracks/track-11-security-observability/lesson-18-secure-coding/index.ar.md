---
id: track-11-lesson-18
title: "ممارسات البرمجة الآمنة — أنماط Java الأمنية الخاطئة"
slug: secure-coding
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 18
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [secure-coding, SQL-injection, deserialization, XXE, Java]
prerequisites: [track-11-lesson-17]
---

# ممارسات البرمجة الآمنة — أنماط Java الأمنية المضادة

> [!NOTE]
> الثغرات الأمنية مشكلات في جودة الكود. فالصرامة نفسها المطبقة على الصحة والأداء يجب أن تُطبق على الأمان. ويربط هذا الدرس أخطر الأنماط المضادة في Java بأثرها المالي، مع أمثلة كود قبل/بعد لكل منها.

## النمط المضاد 1: بناء SQL بربط النصوص

**الخطر**: كشف قاعدة البيانات بالكامل. فيستطيع المهاجم قراءة أي جدول، أو تعديل الأرصدة، أو حذف الجداول.

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

## النمط المضاد 2: إلغاء تسلسل Java ‏(Deserialization)

**الخطر**: تنفيذ كود عن بُعد. فالمهاجم الذي يتحكم في البايتات المتسلسلة يستطيع تنفيذ كود اعتباطي على خادمك. وسلاسل الأدوات (gadget chains) لإلغاء التسلسل في Apache Commons Collections وSpring Framework ثغرات موثقة جيدًا.

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

## النمط المضاد 3: ‏XXE في تحليل XML

**الخطر**: تزوير الطلبات من جانب الخادم (SSRF) وقراءة الملفات المحلية. فيستطيع المهاجم قراءة `/etc/passwd`، أو ملفات خدمات Kubernetes الداخلية، أو التسبب في حجب الخدمة عبر قنابل توسيع الكيانات.

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

## النمط المضاد 4: ‏SSRF في طلبات HTTP الصادرة

**الخطر**: المهاجم الذي يتحكم في معامل URL يستطيع توجيه خدمة الدفع لاستدعاء خدمات Kubernetes الداخلية، أو نقطة البيانات الوصفية في AWS، أو Vault، فيُحتمل أن يسرّب الأسرار.

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

## النمط المضاد 5: الأسرار المكتوبة في الكود

**الخطر**: أي مطور أو نظام CI أو مهاجم لديه وصول إلى git يملك السر. والأسرار المحفوظة في git عامة فعليًا.

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

## النمط المضاد 6: هجمات التوقيت في المصادقة

**الخطر**: بقياس زمن الاستجابة، يستطيع المهاجم تحديد ما إذا كان اسم مستخدم/بريد موجودًا أو ما إذا كان جزء من كلمة المرور صحيحًا.

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

## النمط المضاد 7: توليد أرقام عشوائية غير آمن

**الخطر**: معرّفات المعاملات، أو رموز الجلسات، أو مفاتيح عدم التكرار المتوقعة تتيح للمهاجمين تخمين القيم أو تعدادها.

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

## قائمة تحقق البرمجة الآمنة

استخدم قائمة التحقق هذه أثناء مراجعة الكود لكل تغيير كود متعلق بالدفع:

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

## الخلاصات الأساسية

- يبقى حقن SQL عبر ربط النصوص شائعًا في قواعد كود الدفع لأن JPQL ‏(لا SQL فقط) قابل للحقن أيضًا — استخدم المعاملات المسماة باتساق في كل استعلام ORM
- إلغاء تسلسل Java تنفيذ كود عن بُعد ينتظر الحدوث — لا تلغِ تسلسل بايتات غير موثوقة بـ `ObjectInputStream` أبدًا؛ واستخدم JSON لكل الواجهات ورشّح بقائمة سماح أي تسلسل Java لا مفر منه
- يتطلب منع XXE تعطيل DTD والكيانات الخارجية صراحة — فالإعدادات الافتراضية في `DocumentBuilderFactory` و`SAXParserFactory` و`XMLInputFactory` في JDK كلها تسمح بها
- يتطلب منع SSRF فحص عنوان IP الذي سيستخدمه الاتصال فعليًا (حل DNS مثبّت أو وكيل خروج) ورفض التحويلات — فقائمة سماح النطاقات أو فحص DNS لمرة واحدة وحدهما يمكن تجاوزهما عبر إعادة ربط DNS
- المقارنة بزمن ثابت بـ `MessageDigest.isEqual()` إلزامية لكل أسرار المصادقة — فـ `String.equals()` مصدر لتسريب التوقيت
- أنشئ نسخة واحدة من `SecureRandom` وأعد استخدامها — فهي آمنة للخيوط، وإنشاء نسخة جديدة لكل استدعاء هدر

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا يُصنف إلغاء تسلسل بيانات غير موثوقة بـ ObjectInputStream في Java كثغرة حرجة في أنظمة الدفع؟",
      "options": [
        "إنه بطيء ويؤثر على إنتاجية الدفع",
        "قد يطلق إلغاء تسلسل Java تنفيذ كود اعتباطي عبر سلاسل أدوات في المكتبات الشائعة (Commons Collections، وSpring) — فيصوغ المهاجمون حمولات متسلسلة تنفذ أوامر نظام التشغيل عند إلغاء تسلسلها",
        "إنه يتيح هجمات حقن SQL",
        "إنه يكشف مخطط قاعدة البيانات للمهاجمين"
      ],
      "correct": 1,
      "explanation": "أتاحت ثغرات إلغاء تسلسل Java ‏(باستغلال سلاسل الأدوات في مكتبات مسار الأصناف) تنفيذ كود عن بُعد في اختراقات كثيرة. فحين تعالج ObjectInputStream.readObject() حمولة متسلسلة خبيثة، تستدعي دوال على أصناف موجودة في JVM، فتسلسلها إلى تنفيذ كود اعتباطي دون أي تدخل من منطق التطبيق."
    },
    {
      "text": "لماذا يُنشئ استخدام String.equals() لمقارنة مفاتيح الواجهات أو توقيعات HMAC ثغرة أمنية؟",
      "options": [
        "‏String.equals() بطيء جدًا للعمليات الأمنية",
        "يتوقف String.equals() عند أول حرف مختلف، فينشئ قناة جانبية زمنية — يستطيع المهاجم قياس أزمنة الاستجابة لتحديد عدد الأحرف الأولى الصحيحة من تخمينه، فيتيح التخمين بالقوة بايتًا ببايت",
        "‏String.equals() لا يتعامل مع Unicode بشكل صحيح",
        "‏String.equals() ليس آمنًا للخيوط"
      ],
      "correct": 1,
      "explanation": "يعيد String.equals() القيمة false بمجرد إيجاد حرف مختلف. فلمفتاح خاطئ كليًا يعود خلال نانوثوانٍ؛ ولمفتاح يطابق أول 30 حرفًا يستغرق وقتًا أطول. وهذا الفرق الزمني قابل للقياس عبر طلبات كثيرة، فيتيح للمهاجم تحديد الأحرف الصحيحة واحدًا تلو الآخر. أما MessageDigest.isEqual() فيقارن كل البايتات دائمًا."
    },
    {
      "text": "ما ثغرة SSRF ‏(تزوير الطلبات من جانب الخادم)، وما الذي يجعل التحقق بقائمة حظر IP بعد حل DNS ضروريًا؟",
      "options": [
        "يتيح SSRF للمهاجمين تزوير طلباتهم الخاصة؛ والتحقق من IP لتحديد المعدل",
        "يخدع SSRF الخادم لإرسال طلبات HTTP إلى خدمات داخلية؛ والتحقق من IP بعد حل DNS ضروري لأن قائمة سماح النطاقات وحدها يمكن تجاوزها عبر إعادة ربط DNS ‏(يُحل النطاق إلى مضيف مسموح أولًا ثم يُعاد ربطه بـ IP داخلي للطلب الفعلي)",
        "‏SSRF شكل من حقن SQL؛ والتحقق من IP يمنعه",
        "يتيح SSRF سرقة ملفات تعريف الارتباط؛ والتحقق من IP يحمي رموز الجلسة"
      ],
      "correct": 1,
      "explanation": "في هجوم SSRF، يقدم المهاجم عنوان URL يجلبه الخادم. ومع إعادة ربط DNS، يُحل نطاق المهاجم أولًا إلى IP عام غير ضار (فيجتاز الفحص) ثم، حين يحله عميل HTTP مجددًا للطلب الفعلي، إلى IP داخلي (169.254.x.x، و10.x.x.x). والدفاع المتين هو التحقق من IP الذي يستخدمه الاتصال فعليًا — محلّل مثبّت يطبق قائمة الحظر وقت الاتصال، أو وكيل خروج يفرض القواعد — ورفض التحويلات."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "إصلاح أنماط البرمجة الآمنة المضادة في قاعدة كود دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "حدد وأصلح ثلاث ثغرات حقن في قاعدة كود دفع نموذجية: استعلام JPQL مبني بربط النصوص لنقطة بحث عن المدفوعات، وعبارة ORDER BY تستخدم حقل ترتيب يقدمه المستخدم، وDocumentBuilder في XML يعالج XML غير موثوق دون تعطيل توسيع الكيانات الخارجية."
    },
    {
      "id": "2",
      "description": "نفّذ منع SSRF لخدمة دفع ترسل استدعاءات webhook صادرة: تحقق من عنوان الهدف مقابل قائمة سماح بالنطاقات المعتمدة، وحل النطاق إلى IP، واحظر نطاقات IP الخاصة/الاسترجاع/المحلية للرابط (10.0.0.0/8، و172.16.0.0/12، و192.168.0.0/16، و127.0.0.0/8، و169.254.0.0/16، إضافة إلى ما يقابلها في IPv6)، واجعل عميل HTTP يتصل فقط بالـ IP المتحقق منه (محلّل DNS مخصص) مع تعطيل التحويلات."
    },
    {
      "id": "3",
      "description": "استبدل كل استخدامات Random الحساسة أمنيًا في قاعدة كود نموذجية بـ SecureRandom: معرّفات المعاملات، ورموز OTP، وتوليد مفاتيح الواجهات، ومفاتيح عدم التكرار. واكتب قاعدة Semgrep تكتشف نسخ java.util.Random الجديدة واستدعاءات Math.random() في الحزم الحساسة أمنيًا وأضفها إلى خط CI."
    },
    {
      "id": "4",
      "description": "أنشئ أتمتة شاملة لقائمة مراجعة البرمجة الآمنة: اكتب مجموعة اختبارات JUnit تستخدم الانعكاس (reflection) لفحص كل أصناف @RestController والتحقق من أن لديها تعليقات @PreAuthorize، والتحقق من أن أي صنف @Entity ليس عليه تعليقات @JsonProperty (لمنع الإسناد الجماعي)، والتحقق من أن أي صنف خدمة لا ينشئ نسخ Random."
    }
  ]
}
-->
