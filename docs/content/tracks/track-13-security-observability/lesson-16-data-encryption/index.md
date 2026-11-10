---
id: track-13-lesson-16
title: "Data Encryption — At-Rest and In-Transit for Finance"
slug: data-encryption
track: track-13
trackName: "Security & Observability"
sequence: 16
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [encryption, AES, TLS, at-rest, in-transit]
prerequisites: [track-13-lesson-15]
---

# Data Encryption — At-Rest and In-Transit for Finance

> [!NOTE]
> Encryption in fintech is both a security control and a compliance requirement. PCI DSS mandates encryption of all stored PAN data and all cardholder data in transit. GDPR requires protection of personal data. FIPS 140-2 defines the cryptographic standards acceptable for US financial regulators. Getting the algorithm, key size, and mode wrong means you have encryption theatre, not real protection.

## Encryption Requirements in Financial Services

| Data Type | At-Rest Requirement | In-Transit Requirement | Regulatory Source |
|-----------|--------------------|-----------------------|-------------------|
| PAN (card numbers) | AES-256 or tokenization | TLS 1.2+ | PCI DSS Req 3.4, 4.2 |
| CVV/CVC | Must not be stored after auth | TLS 1.2+ | PCI DSS Req 3.2.1 |
| PIN | Encrypt under HSM | TLS + PIN encryption | PCI DSS Req 3.3 |
| Customer PII (name, DOB, address) | Encryption or pseudonymization | TLS 1.2+ | GDPR Art. 32 |
| Account numbers, sort codes | Encrypted at application layer | TLS | PSD2 / open banking |
| Authentication credentials | Hashed (bcrypt/Argon2) | TLS | OWASP ASVS |

---

## AES-256-GCM for Field-Level Encryption

AES-256-GCM (Advanced Encryption Standard, 256-bit key, Galois/Counter Mode) is the standard for symmetric encryption in financial services. GCM mode provides both encryption and authentication (authenticated encryption with associated data — AEAD).

### Why AES-256-GCM?

- **GCM over CBC/ECB**: GCM provides authentication (MAC). CBC requires a separate HMAC step; ECB is deterministic and reveals patterns. GCM is FIPS 140-2 approved and natively supported in Java.
- **256-bit key over 128-bit**: AES-256 provides security margin against quantum computing advances (Grover's algorithm reduces effective key length to 128 bits—AES-256 gives AES-128 equivalent quantum security).
- **Random IV**: Each encryption must use a fresh random 12-byte IV (nonce). Reusing the IV with the same key is catastrophic in GCM mode—it destroys both confidentiality and authenticity.

### Java Implementation

```java
@Component
public class AesGcmEncryptionService {

    private static final String ALGORITHM = "AES/GCM/NoPadding";
    private static final int IV_LENGTH_BYTES = 12;   // 96-bit IV for GCM
    private static final int TAG_LENGTH_BITS = 128;  // 128-bit authentication tag

    private final SecretKey encryptionKey;

    public AesGcmEncryptionService(KeyManagementService kms) {
        // Fetch key from KMS/Vault — never hardcode
        byte[] keyBytes = kms.getDataEncryptionKey("field-encryption-key-v1");
        this.encryptionKey = new SecretKeySpec(keyBytes, "AES");
    }

    /**
     * Encrypts plaintext using AES-256-GCM.
     * Output format: BASE64(iv || ciphertext || auth_tag)
     * The IV is prepended to the ciphertext for storage — required for decryption.
     *
     * @param plaintext  The data to encrypt
     * @param aad        Additional Authenticated Data — authenticated but not encrypted
     *                   Use for data that must be tamper-evident (e.g., customer ID)
     */
    public String encrypt(String plaintext, byte[] aad) throws Exception {
        // Generate fresh random IV for every encryption — NEVER reuse
        byte[] iv = new byte[IV_LENGTH_BYTES];
        SecureRandom.getInstanceStrong().nextBytes(iv);

        Cipher cipher = Cipher.getInstance(ALGORITHM);
        GCMParameterSpec spec = new GCMParameterSpec(TAG_LENGTH_BITS, iv);
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey, spec);

        if (aad != null) {
            cipher.updateAAD(aad);  // Bind AAD to this ciphertext
        }

        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

        // Combine IV + ciphertext into single byte array for storage
        byte[] combined = new byte[IV_LENGTH_BYTES + ciphertext.length];
        System.arraycopy(iv, 0, combined, 0, IV_LENGTH_BYTES);
        System.arraycopy(ciphertext, 0, combined, IV_LENGTH_BYTES, ciphertext.length);

        return Base64.getEncoder().encodeToString(combined);
    }

    public String decrypt(String encryptedBase64, byte[] aad) throws Exception {
        byte[] combined = Base64.getDecoder().decode(encryptedBase64);

        // Extract IV from the first 12 bytes
        byte[] iv = Arrays.copyOfRange(combined, 0, IV_LENGTH_BYTES);
        byte[] ciphertext = Arrays.copyOfRange(combined, IV_LENGTH_BYTES, combined.length);

        Cipher cipher = Cipher.getInstance(ALGORITHM);
        GCMParameterSpec spec = new GCMParameterSpec(TAG_LENGTH_BITS, iv);
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey, spec);

        if (aad != null) {
            cipher.updateAAD(aad);  // Must provide same AAD used during encryption
        }

        // GCM automatically verifies authentication tag during decryption
        // Throws AEADBadTagException if ciphertext has been tampered with
        byte[] plaintext = cipher.doFinal(ciphertext);
        return new String(plaintext, StandardCharsets.UTF_8);
    }
}
```

### JPA Column Encryption

```java
// AttributeConverter for transparent JPA column encryption
@Converter
@Component
public class EncryptedStringConverter implements AttributeConverter<String, String> {

    @Autowired
    private AesGcmEncryptionService encryptionService;

    @Override
    public String convertToDatabaseColumn(String plaintext) {
        if (plaintext == null) return null;
        try {
            return encryptionService.encrypt(plaintext, null);
        } catch (Exception e) {
            throw new RuntimeException("Failed to encrypt sensitive field", e);
        }
    }

    @Override
    public String convertToEntityAttribute(String dbValue) {
        if (dbValue == null) return null;
        try {
            return encryptionService.decrypt(dbValue, null);
        } catch (Exception e) {
            throw new RuntimeException("Failed to decrypt sensitive field", e);
        }
    }
}

// Usage in entity
@Entity
@Table(name = "payment_methods")
public class PaymentMethod {

    @Id
    private String id;

    private String customerId;

    @Convert(converter = EncryptedStringConverter.class)
    @Column(name = "pan_encrypted")
    private String pan;  // Stored encrypted in database, transparent to application code

    @Convert(converter = EncryptedStringConverter.class)
    @Column(name = "account_name_encrypted")
    private String accountHolderName;

    // Sort code stored in plaintext — not PAN data, lower sensitivity
    private String sortCode;

    // Last 4 digits stored in plaintext for display — not sensitive
    private String lastFourDigits;
}
```

---

## Encryption Key Hierarchy

A flat encryption model (one key encrypts everything) is brittle: compromise of one key exposes all data. Use a key hierarchy.

```
┌─────────────────────────────────────────────────────────────┐
│  Root Master Key (RMK)                                       │
│  Stored in HSM (Hardware Security Module)                    │
│  Never leaves the HSM — operations performed inside HSM     │
│  Rotated annually; handled by key ceremony                  │
└─────────────────────────────────────────────────────────────┘
                           │ encrypts
┌─────────────────────────────────────────────────────────────┐
│  Key Encryption Key (KEK)                                    │
│  Stored in AWS KMS or HashiCorp Vault                       │
│  Rotated quarterly                                          │
│  Used only to encrypt/decrypt Data Encryption Keys         │
└─────────────────────────────────────────────────────────────┘
                           │ encrypts
┌─────────────────────────────────────────────────────────────┐
│  Data Encryption Key (DEK)                                   │
│  Generated per record (or per customer, per day)            │
│  Stored encrypted alongside the data it protects           │
│  DEK is small (32 bytes) — cheap to re-encrypt on rotation │
└─────────────────────────────────────────────────────────────┘
                           │ encrypts
┌─────────────────────────────────────────────────────────────┐
│  Customer Data (PAN, PII, account numbers)                   │
└─────────────────────────────────────────────────────────────┘
```

### Benefits of the Key Hierarchy

- **Blast radius limitation**: If a DEK is compromised, only the data encrypted by that DEK is at risk—not all customer data
- **Efficient rotation**: Rotating the KEK requires re-encrypting the DEKs (small), not all customer data (huge)
- **Separation of duties**: HSM operations (root key) require quorum of operators; DEK operations are automated

---

## TLS 1.3 Configuration in Spring Boot

```yaml
# application.yml — complete TLS configuration
server:
  port: 8443
  ssl:
    enabled: true
    # Key store containing the service's TLS certificate
    key-store: file:/etc/ssl/payment-service/keystore.p12
    key-store-type: PKCS12
    key-store-password: ${SSL_KEYSTORE_PASSWORD}
    key-alias: payment-service

    # Trust store: certificates/CAs we trust for client authentication (mTLS)
    trust-store: file:/etc/ssl/payment-service/truststore.jks
    trust-store-password: ${SSL_TRUSTSTORE_PASSWORD}
    client-auth: need  # NEED = require client certificate (mTLS); WANT = optional

    # TLS protocol version (Java 11+ supports TLS 1.3 natively)
    enabled-protocols: TLSv1.3
    # TLS 1.3 cipher suites are fixed — negotiated by JVM automatically
    # No need to specify ciphers for TLS 1.3

# Redirect HTTP to HTTPS (belt and suspenders)
  http:
    port: 8080
    # Note: HTTP port should be blocked at infrastructure level too

# HSTS header
spring:
  security:
    headers:
      hsts:
        max-age-seconds: 31536000
        include-subdomains: true
```

---

## PostgreSQL Transparent Data Encryption

PostgreSQL itself does not natively support TDE (Transparent Data Encryption), but several approaches provide storage-level encryption:

### Approach 1: pgcrypto for Column-Level Encryption

```sql
-- pgcrypto extension for column-level encryption in PostgreSQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Store encrypted PAN using pgcrypto
INSERT INTO payment_methods (id, customer_id, pan_encrypted)
VALUES (
    gen_random_uuid(),
    'CUST-123',
    -- Encrypt using pgp_sym_encrypt with AES-256
    pgp_sym_encrypt(
        '4532015112830366',          -- plaintext PAN
        current_setting('app.encryption_key'),  -- key from PostgreSQL config
        'cipher-algo=aes256'
    )
);

-- Decrypt for authorised operations
SELECT
    id,
    customer_id,
    pgp_sym_decrypt(
        pan_encrypted,
        current_setting('app.encryption_key')
    ) AS pan_plaintext
FROM payment_methods
WHERE customer_id = 'CUST-123';
```

**Production recommendation**: Application-layer encryption (using `EncryptedStringConverter` above) is preferred over pgcrypto because:
- Key management is in Vault (not PostgreSQL config)
- Encryption/decryption is auditable in application logs
- Rotation is easier (key rotation without DB schema changes)

### Approach 2: AWS RDS Encryption (Storage Level)

```hcl
# terraform — RDS with encryption at rest
resource "aws_db_instance" "payments_db" {
  identifier     = "payments-db-prod"
  engine         = "postgres"
  engine_version = "15.3"
  instance_class = "db.r6g.xlarge"

  # Encryption at rest using AWS KMS
  storage_encrypted = true
  kms_key_id        = aws_kms_key.payments_db_key.arn

  # In transit
  parameter_group_name = aws_db_parameter_group.payments_tls.name
  # parameter: rds.force_ssl = 1 (reject plaintext connections)
}

resource "aws_kms_key" "payments_db_key" {
  description             = "KMS key for payments database encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true  # Annual automatic rotation
  multi_region            = true  # For cross-region replication

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.account_id}:role/payment-service-role" }
        Action = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:service" = "payment-service"
          }
        }
      }
    ]
  })
}
```

---

## Format-Preserving Encryption for Card Numbers

Standard encryption converts a 16-digit card number to a base64 string—unusable in systems that expect numeric card numbers. Format-Preserving Encryption (FPE) with the FF1 algorithm encrypts a PAN to another valid-looking PAN.

```java
// FF1 format-preserving encryption for card numbers
// Using Bouncycastle's FPE implementation
@Component
public class FpeCardNumberEncryption {

    private final byte[] key;    // 256-bit AES key
    private final byte[] tweak;  // Public per-customer value (not secret)

    public FpeCardNumberEncryption(KeyManagementService kms) {
        this.key = kms.getDataEncryptionKey("fpe-card-key-v1");
        this.tweak = new byte[7];  // Can be customer-specific — adds context binding
    }

    /**
     * Encrypts a 16-digit PAN to another 16-digit number using FF1.
     * Result looks like a valid card number format-wise.
     * This is a PCI DSS-approved technique for protecting PAN.
     */
    public String encryptPan(String pan) {
        // Validate input is numeric
        if (!pan.matches("\\d{13,19}")) {
            throw new IllegalArgumentException("Invalid PAN format");
        }

        FpeFf1 ff1 = new FpeFf1(key, tweak, 10, pan.length());  // radix=10 for decimal
        int[] panDigits = pan.chars()
            .map(c -> c - '0')
            .toArray();

        int[] encryptedDigits = ff1.encrypt(panDigits);

        StringBuilder result = new StringBuilder();
        for (int digit : encryptedDigits) {
            result.append(digit);
        }
        return result.toString();
    }

    public String decryptPan(String encryptedPan) {
        FpeFf1 ff1 = new FpeFf1(key, tweak, 10, encryptedPan.length());
        int[] encryptedDigits = encryptedPan.chars()
            .map(c -> c - '0')
            .toArray();

        int[] decryptedDigits = ff1.decrypt(encryptedDigits);

        StringBuilder result = new StringBuilder();
        for (int digit : decryptedDigits) {
            result.append(digit);
        }
        return result.toString();
    }
}
```

---

## Key Rotation Procedures

Key rotation is not optional—it is a PCI DSS requirement (Requirement 3.6.1 for encryption keys used for PAN).

### Rotation Without Downtime

```java
// Versioned key management — enables graceful rotation
@Service
public class VersionedEncryptionService {

    // Map from key version → decryption key
    // Multiple keys loaded simultaneously — old for decryption, new for encryption
    private final Map<String, SecretKey> decryptionKeys = new HashMap<>();
    private volatile String currentEncryptionKeyVersion;

    @PostConstruct
    public void loadKeys() {
        // Load all active key versions from KMS/Vault
        kms.listKeyVersions("field-encryption-key").forEach(version -> {
            byte[] keyBytes = kms.getKeyVersion("field-encryption-key", version);
            decryptionKeys.put(version, new SecretKeySpec(keyBytes, "AES"));
        });
        // Current version is the latest
        currentEncryptionKeyVersion = kms.getCurrentVersion("field-encryption-key");
        log.info("Loaded {} key versions, current={}",
            decryptionKeys.size(), currentEncryptionKeyVersion);
    }

    // Stored format: VERSION:BASE64(iv||ciphertext)
    public String encrypt(String plaintext) throws Exception {
        SecretKey key = decryptionKeys.get(currentEncryptionKeyVersion);
        String ciphertext = encryptWithKey(plaintext, key);
        return currentEncryptionKeyVersion + ":" + ciphertext;
    }

    public String decrypt(String stored) throws Exception {
        String[] parts = stored.split(":", 2);
        String version = parts[0];
        String ciphertext = parts[1];

        SecretKey key = decryptionKeys.get(version);
        if (key == null) {
            throw new KeyNotFoundException("No key for version: " + version);
        }
        return decryptWithKey(ciphertext, key);
    }
}

// Key rotation background job
@Scheduled(cron = "0 0 2 * * SUN")  // Every Sunday at 2am
public void rotateExpiredEncryptionKeys() {
    // Find records still encrypted with old key versions
    List<PaymentMethod> oldKeyRecords = paymentMethodRepository
        .findByKeyVersionNot(currentEncryptionKeyVersion);

    log.info("Rotating {} records to new key version", oldKeyRecords.size());

    // Re-encrypt in batches to avoid OOM and lock contention
    Lists.partition(oldKeyRecords, 1000).forEach(batch -> {
        batch.forEach(pm -> {
            String plaintext = encryptionService.decrypt(pm.getPanEncrypted());
            pm.setPanEncrypted(encryptionService.encrypt(plaintext));
        });
        paymentMethodRepository.saveAll(batch);
    });
}
```

---

## Encrypted Backups

```bash
# PostgreSQL backup encrypted with GPG
pg_dump -Fc payments_db \
  | gpg --recipient payments-backup-key@example.com \
        --compress-algo none \
        --cipher-algo AES256 \
        --batch \
        --output /backups/payments-$(date +%Y%m%d).dump.gpg

# Verify backup is encrypted (should show opaque encrypted data)
file /backups/payments-20261108.dump.gpg
# Output: /backups/payments-20261108.dump.gpg: PGP RSA encrypted session key

# Test restore (critical: test this monthly, not just on disaster recovery day)
gpg --decrypt /backups/payments-20261108.dump.gpg \
  | pg_restore -d payments_db_test --clean
```

---

## Key Takeaways

- Use AES-256-GCM for symmetric encryption: authenticated encryption prevents tampering, 256-bit key provides quantum-resistant security margin, random 12-byte IV is mandatory for every encryption
- Never reuse an IV with the same key in GCM mode—this catastrophically breaks both confidentiality and authenticity
- Implement a key hierarchy (Root → KEK → DEK): rotation requires re-encrypting only the small DEKs, not all customer data
- Application-layer encryption (JPA converters) is preferred over database-layer encryption: it provides key management via Vault, auditability, and rotation capability
- PCI DSS Requirement 3.4 mandates rendering PAN unreadable at rest; AES-256 and format-preserving encryption (FF1) are the two approved approaches
- Key rotation is mandatory under PCI DSS—implement versioned encryption from day one so rotation is a background job, not an outage-causing migration
- Always encrypt backups—a database backup is a copy of all your sensitive data; unencrypted backups stored off-site are a data breach waiting to happen

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why must the IV (Initialization Vector) in AES-256-GCM encryption be unique for every encryption operation, and what is the recommended size?",
      "options": ["A fixed IV makes decryption faster; 16 bytes recommended", "Reusing an IV with the same key catastrophically breaks both confidentiality and authenticity in GCM mode; 12 bytes (96 bits) is the NIST-recommended size, generated randomly per operation", "IV uniqueness is optional for PAN data; 8 bytes is sufficient", "IV reuse is acceptable as long as the key is rotated annually"],
      "correct": 1,
      "explanation": "In GCM mode, reusing an IV with the same key allows an attacker to recover the authentication key, forging authentication tags and decrypting ciphertext. NIST SP 800-38D specifies 96-bit (12-byte) random IVs for GCM. The IV is not secret and is stored alongside the ciphertext."
    },
    {
      "text": "What is the advantage of a key hierarchy (Root Key → Key Encryption Key → Data Encryption Key) over encrypting all data with a single master key?",
      "options": ["A key hierarchy is faster to process", "When rotating keys, only the small DEKs need to be re-encrypted (by wrapping them with the new KEK) — not all the data; this makes rotation a metadata operation rather than a full data re-encryption", "A key hierarchy provides stronger encryption", "A key hierarchy is required by all cloud providers"],
      "correct": 1,
      "explanation": "If you encrypt all customer data with a single key, rotating that key requires re-encrypting every record. With a hierarchy, each record has its own DEK (Data Encryption Key), which is wrapped by a KEK (Key Encryption Key). To rotate, you only re-wrap the DEKs (small operations), not the actual data. This makes rotation of millions of records practical."
    },
    {
      "text": "Under PCI DSS Requirement 3.4, what does rendering PAN 'unreadable' require for data at rest?",
      "options": ["Storing PAN in a separate database table with restricted access", "Using strong one-way cryptographic hashes, truncation, index tokens, or strong cryptography such as AES-256 — Base64 encoding or reversible obfuscation does not satisfy this requirement", "Storing PAN in encrypted columns using the database's built-in encryption", "Encrypting the database tablespace"],
      "correct": 1,
      "explanation": "PCI DSS Requirement 3.4 requires that PAN be rendered unreadable using one of four approved methods: strong one-way cryptographic hash, truncation, index tokens with securely stored pads, or strong cryptography (AES-256). Database tablespace encryption alone is insufficient because it does not protect against an attacker with database access."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Data Encryption for PCI DSS Compliance",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "Implement an AES-256-GCM encryption service in Java with: random 12-byte IV per operation, a 256-bit key loaded from environment variable (never hardcoded), authenticated additional data (AAD) containing the record ID to prevent ciphertext transplant attacks, and stored format VERSION:BASE64(iv||ciphertext||tag)."},
    {"id": "2", "description": "Create a JPA AttributeConverter that transparently encrypts and decrypts annotated entity fields (PAN, account numbers, national IDs) using the encryption service; write an integration test verifying that the field is stored encrypted in the database and decrypted correctly when read back."},
    {"id": "3", "description": "Implement versioned key management: support multiple active key versions simultaneously, encrypt all new records with the current version, decrypt records using the version stored in the ciphertext prefix, and write a background job that re-encrypts records using old key versions to the current version in batches of 1000 records."},
    {"id": "4", "description": "Write an automated compliance verification script: query the payment_methods table and verify that no row contains a value matching the Luhn card number pattern in plaintext; check that backup files are encrypted (verify file magic bytes); and generate a report suitable for a PCI QSA audit."}
  ]
}
-->
