---
id: track-11-lesson-17
title: "Key Management — HSM, KMS, and Envelope Encryption"
slug: key-management
track: track-11
trackName: "Security & Observability"
sequence: 17
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [KMS, HSM, envelope-encryption, key-rotation, AWS-KMS]
prerequisites: [track-11-lesson-16]
---

# Key Management — HSM, KMS, and Envelope Encryption

> [!NOTE]
> Encryption is only as secure as your key management. A perfect AES-256-GCM implementation means nothing if the key is stored next to the data it protects. Key management is the hardest part of cryptography: getting keys to the right services without exposing them, rotating them without outages, and protecting them from insider threats.

## The Key Management Problem

The fundamental challenge: your payment service needs an encryption key to process transactions. How do you get that key to the service without:
1. Hardcoding it in source code (accessible to every developer, committed to git)
2. Storing it in a config file (readable by anyone with filesystem access)
3. Passing it in an environment variable (visible in the pod spec, `/proc/<pid>/environ`, crash reports and CI logs)
4. Storing it in the database (key and data in same breach blast radius)

The answer is a Key Management System (KMS) or Hardware Security Module (HSM) that:
- Stores keys securely, separate from application data
- Provides controlled access based on identity (IAM roles, service accounts)
- Logs every key operation for auditability
- Performs cryptographic operations inside the secure boundary (the master key never leaves)

---

## Envelope Encryption Pattern

Envelope encryption avoids the problem of sending large amounts of data to the KMS for encryption. Instead:

```
1. Application calls KMS.GenerateDataKey()
   KMS returns:
     - plaintext_data_key (use immediately, do not store)
     - encrypted_data_key (store alongside your data)

2. Application encrypts data using plaintext_data_key (AES-256-GCM)
   Then discards the plaintext_data_key from memory

3. Application stores: encrypted_data || encrypted_data_key

To decrypt:
1. Send encrypted_data_key to KMS.Decrypt()
   KMS returns: plaintext_data_key
   (KMS uses the master key — which never leaves KMS)

2. Use plaintext_data_key to decrypt encrypted_data
```

**Why envelope encryption?**
- KMS has rate limits and latency (~1-5ms per call). Encrypting each record individually would be too slow.
- Large data cannot be sent to KMS (AWS KMS limit: 4KB per encrypt/decrypt call).
- Envelope encryption means KMS is called once per data key (to generate it, and again to unwrap it on read), while the data key does the heavy lifting locally. For high volumes, cache unwrapped data keys briefly (e.g. the AWS Encryption SDK's data key caching) — trading a little exposure for far fewer KMS calls.

---

## AWS KMS Implementation

```java
@Service
public class AwsKmsEnvelopeEncryption {

    private static final SecureRandom RANDOM = new SecureRandom();  // getInstanceStrong() can block

    private final KmsClient kmsClient;
    private final String masterKeyArn;

    public AwsKmsEnvelopeEncryption(
            KmsClient kmsClient,
            @Value("${aws.kms.payment-master-key-arn}") String masterKeyArn) {
        this.kmsClient = kmsClient;
        this.masterKeyArn = masterKeyArn;
    }

    /**
     * Encrypts data using envelope encryption.
     * Returns an EncryptedBundle containing the ciphertext and the encrypted data key.
     * Store both; you need both for decryption.
     */
    public EncryptedBundle encrypt(String plaintext) {
        // 1. Generate a unique data key for this operation
        GenerateDataKeyRequest keyRequest = GenerateDataKeyRequest.builder()
            .keyId(masterKeyArn)
            .keySpec(DataKeySpec.AES_256)
            // Encryption context: additional authenticated data
            // Must be provided on decrypt — provides authorisation context
            .encryptionContext(Map.of(
                "service", "payment-service",
                "environment", "production",
                "purpose", "pan-encryption"
            ))
            .build();

        GenerateDataKeyResponse keyResponse = kmsClient.generateDataKey(keyRequest);

        byte[] plaintextDataKey  = keyResponse.plaintext().asByteArray();
        byte[] encryptedDataKey  = keyResponse.ciphertextBlob().asByteArray();

        try {
            // 2. Encrypt data with the plaintext data key (AES-256-GCM, locally)
            byte[] iv = new byte[12];
            RANDOM.nextBytes(iv);

            SecretKey secretKey = new SecretKeySpec(plaintextDataKey, "AES");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

            return EncryptedBundle.builder()
                .encryptedDataKey(Base64.getEncoder().encodeToString(encryptedDataKey))
                .iv(Base64.getEncoder().encodeToString(iv))
                .ciphertext(Base64.getEncoder().encodeToString(ciphertext))
                .build();
            // No key version needed: the encrypted data key blob identifies the
            // KMS key, and KMS automatic rotation keeps old backing keys for
            // decryption. (Also pass a record ID to cipher.updateAAD(...): the
            // encryption context binds only the DATA KEY, not this ciphertext.)

        } finally {
            // 3. Wipe our copy of the plaintext data key as soon as possible.
            // Best effort only: SdkBytes and SecretKeySpec hold their own copies
            // that we cannot wipe -- treat heap dumps as sensitive regardless
            Arrays.fill(plaintextDataKey, (byte) 0);
        }
    }

    public String decrypt(EncryptedBundle bundle) {
        byte[] encryptedDataKey = Base64.getDecoder().decode(bundle.getEncryptedDataKey());

        // 1. Decrypt the data key using KMS master key
        DecryptRequest decryptRequest = DecryptRequest.builder()
            .keyId(masterKeyArn)
            .ciphertextBlob(SdkBytes.fromByteArray(encryptedDataKey))
            // Must provide same encryption context used during encrypt
            .encryptionContext(Map.of(
                "service", "payment-service",
                "environment", "production",
                "purpose", "pan-encryption"
            ))
            .build();

        DecryptResponse decryptResponse = kmsClient.decrypt(decryptRequest);
        byte[] plaintextDataKey = decryptResponse.plaintext().asByteArray();

        try {
            // 2. Decrypt data with the data key
            byte[] iv = Base64.getDecoder().decode(bundle.getIv());
            byte[] ciphertext = Base64.getDecoder().decode(bundle.getCiphertext());

            SecretKey secretKey = new SecretKeySpec(plaintextDataKey, "AES");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
            byte[] plaintext = cipher.doFinal(ciphertext);
            return new String(plaintext, StandardCharsets.UTF_8);

        } finally {
            Arrays.fill(plaintextDataKey, (byte) 0);
        }
    }
}

@Value
@Builder
public class EncryptedBundle {
    String encryptedDataKey;  // Base64-encoded encrypted data key (from KMS)
    String iv;                // Base64-encoded initialization vector
    String ciphertext;        // Base64-encoded encrypted data
}
```

### KMS Encryption Context

Encryption context is a map of key-value pairs that is cryptographically bound to the ciphertext. It provides:
1. **Authorisation**: KMS can be configured to require specific encryption context values
2. **Auditability**: CloudTrail logs include the encryption context—you can see what service decrypted what data
3. **Tamper protection**: If the encryption context does not match, decryption fails

A CloudTrail record of a KMS `Decrypt` call (abridged):

```json
{
  "eventName": "Decrypt",
  "userIdentity": {
    "type": "AssumedRole",
    "arn": "arn:aws:iam::123456789012:assumed-role/payment-service-role/i-abc123"
  },
  "requestParameters": {
    "encryptionContext": {
      "service": "payment-service",
      "environment": "production",
      "purpose": "pan-encryption"
    },
    "keyId": "arn:aws:kms:eu-west-1:123456789012:key/abcd-1234"
  },
  "responseElements": null
}
```

---

## HashiCorp Vault Transit Engine

Vault Transit provides encryption-as-a-service: your application sends plaintext to Vault, Vault returns ciphertext. The key never leaves Vault.

```java
@Service
public class VaultTransitEncryptionService {

    private final VaultTemplate vaultTemplate;
    // Transit mounted at "transit/", key named "payment-service":
    // endpoints are transit/encrypt/<key>, transit/decrypt/<key>, transit/rewrap/<key>
    private static final String KEY = "payment-service";

    /**
     * Vault Transit — application sends data to Vault for encryption.
     * Key stays in Vault; application only handles ciphertext.
     */
    public String encrypt(String plaintext) {
        String base64Plaintext = Base64.getEncoder()
            .encodeToString(plaintext.getBytes(StandardCharsets.UTF_8));

        VaultResponse response = vaultTemplate.write(
            "transit/encrypt/" + KEY,
            Map.of("plaintext", base64Plaintext)
        );

        return (String) response.getData().get("ciphertext");
        // Returns: "vault:v1:ABCDEF..." — the version prefix tells you (and Vault)
        // which key version encrypted it; re-wrapping is still your job (see rewrap)
    }

    public String decrypt(String ciphertext) {
        VaultResponse response = vaultTemplate.write(
            "transit/decrypt/" + KEY,
            Map.of("ciphertext", ciphertext)
        );

        String base64Plaintext = (String) response.getData().get("plaintext");
        return new String(Base64.getDecoder().decode(base64Plaintext), StandardCharsets.UTF_8);
    }

    /**
     * Vault's rewrap operation rotates the encryption key without decrypting.
     * Old ciphertext ("vault:v1:...") is re-encrypted with new key ("vault:v2:...")
     * WITHOUT the plaintext ever leaving Vault.
     */
    public String rewrap(String oldCiphertext) {
        VaultResponse response = vaultTemplate.write(
            "transit/rewrap/" + KEY,
            Map.of("ciphertext", oldCiphertext)
        );
        return (String) response.getData().get("ciphertext");
    }
}
```

### Vault Key Rotation

```bash
# Rotate the Transit key — new encryptions use new key version automatically
# Old ciphertext (vault:v1:...) can still be decrypted by Vault
vault write -f transit/keys/payment-service/rotate

# Check key versions
vault read transit/keys/payment-service
# Key               Value
# min_decryption_version  1   <- oldest decryptable version
# min_encryption_version  0   <- 0 = latest
# latest_version         3   <- currently on version 3

# Update min_decryption_version to enforce re-wrap (retire old keys)
# After re-wrapping all vault:v1:... ciphertext to vault:v3:...
vault write transit/keys/payment-service/config min_decryption_version=3

# Now vault:v1:... ciphertexts cannot be decrypted — force re-wrap completed
```

---

## HSM (Hardware Security Module)

An HSM is a tamper-resistant physical device that generates, stores, and uses cryptographic keys. The private key never leaves the HSM boundary—cryptographic operations happen inside the hardware.

### Where HSMs Are Required

PCI DSS itself does not demand an HSM for PAN encryption: key-encrypting keys must be stored in a secure cryptographic device (an HSM), *or* as at least two full-length key components, *or* encrypted under a key at least as strong (Requirement 3.6.1.2). HSMs become mandatory in **PIN processing and card issuing** (PCI PIN Security, PCI P2PE, card-scheme rules), where devices must be approved under **PCI PTS HSM** or validated to **FIPS 140-2/140-3 Level 3** or higher. In practice, most firms put their root keys in an HSM — or a cloud KMS, whose keys are protected by FIPS 140-validated HSMs — anyway.

**FIPS 140 Level 3** HSMs provide:
- Tamper-evident *and* tamper-resistant physical protection
- Tamper response: key zeroisation on physical attack
- Identity-based authentication required for all operations
- Keys cannot be exported in plaintext

(FIPS 140-3 has replaced FIPS 140-2: new validations are issued against 140-3, and remaining 140-2 certificates move to the historical list in September 2026.)

**Common HSM vendors**: Thales (nShield), Utimaco, AWS CloudHSM, Azure Dedicated HSM

```java
// PKCS#11 interface to HSM from Java
@Configuration
public class HsmConfig {

    private final VaultClient vaultClient;   // your wrapper for reading secrets from Vault

    public HsmConfig(VaultClient vaultClient) {
        this.vaultClient = vaultClient;
    }

    @Bean
    public Provider hsmProvider() throws Exception {
        // Load the PKCS#11 provider for your HSM
        // HSM vendor provides the library (e.g., /usr/lib/pkcs11/libcknfast.so).
        // configure() takes a file name, or inline config prefixed with "--"
        Provider hsmProvider = Security.getProvider("SunPKCS11");
        Provider configured = hsmProvider.configure("""
            --name = PaymentsHSM
            library = /usr/lib/pkcs11/libcknfast.so
            slotListIndex = 0
            """);
        Security.addProvider(configured);
        return configured;
    }

    @Bean
    public KeyStore hsmKeyStore(Provider hsmProvider) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS11", hsmProvider);
        // HSM PIN is an operator credential — stored in Vault, not application config
        ks.load(null, vaultClient.getHsmPin().toCharArray());
        return ks;
    }

    // Signing key for payment authorisation — private key lives in HSM
    // (the returned object is only a HANDLE to the key inside the HSM)
    @Bean
    public PrivateKey paymentSigningKey(KeyStore hsmKeyStore) throws Exception {
        return (PrivateKey) hsmKeyStore.getKey("payment-signing-key-v1", null);
    }
}

// Sign payment authorisation using HSM
@Service
public class PaymentAuthorisationSigner {

    private final PrivateKey signingKey;  // Lives in HSM
    private final Provider hsmProvider;   // the SunPKCS11 provider bean

    public byte[] signPayment(PaymentAuthorisationRequest request) throws Exception {
        byte[] payload = serialiseToBytes(request);

        // This signature computation runs INSIDE the HSM
        // The private key never leaves the HSM boundary
        Signature signer = Signature.getInstance("SHA256withRSA", hsmProvider);
        signer.initSign(signingKey);
        signer.update(payload);
        return signer.sign();
    }
}
```

---

## Key Ceremony Procedures

A key ceremony is the formal procedure for generating a new master key. It requires a quorum of trusted individuals (key custodians) so no single person can compromise the key.

```
Key Ceremony for Master Key Generation
=======================================

PARTICIPANTS:
  - 5 key custodians from different teams (quorum: 3 of 5 needed
    to use or restore the key) — e.g. security, operations, engineering
  - Ceremony administrator (runs the pre-approved script)
  - Independent witness / auditor (NOT a custodian)

LOCATION:
  - Secure facility (HSM room)
  - Faraday cage (prevents radio interception)
  - No personal electronic devices; only the facility's own CCTV,
    positioned so that no PIN entry or key component is visible

PROCEDURE:
1. Identity verification
   Each custodian presents two forms of ID; documented on record

2. HSM initialisation
   - HSM factory reset (documented, witnessed)
   - Firmware verification (compare hash to vendor's signed manifest)

3. Master key generation
   - HSM generates key internally using its true hardware RNG
   - Key shares generated using Shamir's Secret Sharing (3-of-5)
   - Each custodian receives one encrypted key share

4. Key custody documentation
   - Each custodian signs receipt for their key share
   - Share is stored in custodian's personal safe deposit box
   - No digital copies; no photographs

5. Verification
   - Test encryption/decryption operation witnessed by all custodians
   - Document serial numbers, software versions, signatures

6. HSM activation
   - HSM sealed with tamper-evident sticker (number recorded)
   - HSM installed in secure rack

DOCUMENTATION:
  - Full written record of proceedings
  - CCTV footage retained as evidence of who was present
  - Signed by all participants
  - Stored in fireproof safe and off-site copy
```

---

## Spring Cloud Vault Integration

```yaml
# application.yml — Vault integration for Spring Boot
# (bootstrap.yml is the legacy mechanism; spring.config.import replaces it)
spring:
  cloud:
    vault:
      uri: https://vault.payments.example.com:8200
      authentication: KUBERNETES
      kubernetes:
        role: payment-service
        # Vault role bound to Kubernetes ServiceAccount
        # payment-service SA → Vault policy payment-service-policy
      config:
        lifecycle:
          enabled: true          # Automatic lease renewal
          min-renewal: 10s       # Minimum lease duration requested on renewal
          expiry-threshold: 1m   # Renew a lease 1 minute before it expires
      database:
        enabled: true            # Dynamic DB credentials from database/creds/<role>
        role: payment-service    # → spring.datasource.username / password

  config:
    import: "vault://"
    # Static secrets from the KV engine, e.g. secret/payment-service → properties
```

```java
// Spring Cloud Vault renews the DB credential lease automatically -- but when
// the lease reaches its max TTL it EXPIRES, and Spring Cloud Vault does NOT
// reconfigure HikariCP. Lease events come from SecretLeaseContainer (they are
// not Spring ApplicationEvents, so @EventListener would never fire).
@Component
public class VaultDbCredentialRotation {

    private static final String PATH = "database/creds/payment-service";

    private final SecretLeaseContainer leaseContainer;
    private final HikariDataSource dataSource;

    // ... constructor

    @PostConstruct
    void registerListener() {
        leaseContainer.addLeaseListener(event -> {
            if (!PATH.equals(event.getSource().getPath())) return;

            if (event instanceof SecretLeaseExpiredEvent) {
                // Max TTL reached: ask Vault for a brand-new credential
                leaseContainer.requestRotatingSecret(PATH);
            } else if (event instanceof SecretLeaseCreatedEvent created) {
                Map<String, Object> secrets = created.getSecrets();
                HikariConfigMXBean config = dataSource.getHikariConfigMXBean();
                config.setUsername((String) secrets.get("username"));
                config.setPassword((String) secrets.get("password"));
                // New connections use the new credential; replace the old
                // ones gradually (in-use connections are closed when returned)
                dataSource.getHikariPoolMXBean().softEvictConnections();
            }
        });
    }
}
```

---

## Key Takeaways

- Envelope encryption solves the KMS performance and size problem: generate one data key per record (or per customer), encrypt data locally with the data key, store only the KMS-encrypted data key
- Always use encryption context in AWS KMS calls: it provides authorisation context and makes CloudTrail logs meaningful ("which service, for what purpose, decrypted this key")
- Vault Transit's rewrap operation moves ciphertext to the latest key version without the plaintext ever leaving Vault — you still update the stored ciphertext, but no plaintext migration is needed
- HSMs (PCI PTS HSM or FIPS 140-2/140-3 Level 3) are mandatory for PIN processing and card issuing; for PAN encryption PCI DSS also allows other key-protection options, but root keys in an HSM or HSM-backed KMS are standard practice — keys never leave the hardware boundary
- Key ceremonies are not bureaucracy — they are the procedural control that ensures no single person can compromise the root of trust; they require a quorum, documentation, and independent witnesses
- Wipe plaintext key material from memory as soon as possible with `Arrays.fill(keyBytes, (byte) 0)` — best effort, since libraries keep their own copies; heap dumps and core dumps can expose keys that linger in memory, so treat them as sensitive data

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is envelope encryption, and why does it solve the KMS performance problem?",
      "options": [
        "Envelope encryption encrypts data twice for extra security",
        "A DEK (Data Encryption Key) encrypts the data locally; the DEK itself is encrypted by KMS and stored alongside the data — only the DEK encryption/decryption requires KMS, not every data read/write",
        "Envelope encryption stores keys inside the database alongside the data",
        "Envelope encryption requires a hardware security module for every operation"
      ],
      "correct": 1,
      "explanation": "Calling AWS KMS for every byte of data would be slow (a network round-trip per operation) and impossible for large records (KMS encrypts at most 4 KB). Envelope encryption encrypts the data locally with a DEK (fast) and calls KMS only to generate and to unwrap the DEK — once per record written or read, or even less often when unwrapped DEKs are cached briefly."
    },
    {
      "text": "Where are FIPS 140 Level 3 (or PCI PTS HSM) approved HSMs mandatory in payments, and what does Level 3 add?",
      "options": [
        "In PIN processing and card issuing (PCI PIN Security, P2PE, card-scheme rules); Level 3 adds tamper-resistance with key zeroisation and identity-based authentication",
        "For every service that stores any personal data",
        "Only for internet-facing web servers that terminate TLS",
        "Nowhere — FIPS 140 is US-government guidance with no role in payments"
      ],
      "correct": 0,
      "explanation": "PIN processing and card issuing require HSMs approved under PCI PTS HSM or validated to FIPS 140-2/140-3 Level 3 or higher. Level 3 adds tamper-resistance (keys are zeroised on physical attack) and identity-based operator authentication. For PAN encryption, PCI DSS 3.6.1.2 also allows key-encrypting keys to be stored as split components or encrypted under an equally strong key — though root keys in an HSM or HSM-backed KMS are standard practice. FIPS 140-3 has replaced 140-2 for new validations."
    },
    {
      "text": "Why should plaintext key material be wiped from Java byte arrays immediately after use with Arrays.fill()?",
      "options": [
        "To improve garbage collection performance",
        "Java's garbage collector does not immediately free memory; key material can persist in heap until GC runs. Heap dumps, core dumps, or memory analysis tools can expose key bytes that linger in memory after use",
        "To comply with Java memory management best practices",
        "To prevent key material from being logged accidentally"
      ],
      "correct": 1,
      "explanation": "Java byte arrays on the heap persist until the garbage collector reclaims them, which may be minutes later — and even then the memory is not zeroed until reused. Heap dumps (JVM diagnostics), core dumps (OS crash), or memory forensics can recover key bytes still in memory. Arrays.fill() zeroes your copy immediately, limiting the window of exposure; it is best effort, because libraries such as SecretKeySpec keep internal copies."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Key Management with AWS KMS and HashiCorp Vault",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Implement envelope encryption with AWS KMS: use GenerateDataKey to get a plaintext DEK and encrypted DEK, encrypt a payment record with the plaintext DEK using AES-256-GCM, store only the encrypted DEK alongside the ciphertext, and implement decryption that calls KMS Decrypt to recover the DEK, ensuring plaintext DEK bytes are wiped from memory after use."},
    {"id": "2", "description": "Add encryption context to all AWS KMS calls for the payment service: include service name, purpose, and environment in the EncryptionContext; verify that KMS calls without the matching context are rejected; check that CloudTrail logs show the encryption context for auditability."},
    {"id": "3", "description": "Configure HashiCorp Vault Transit secret engine for key rotation: create a named encryption key with rotation enabled, implement the encrypt/decrypt/rewrap pattern, write a migration job that uses batch-rewrap to re-encrypt all records to the latest key version without exposing plaintext outside Vault."},
    {"id": "4", "description": "Implement Spring Cloud Vault integration with Kubernetes authentication: bind the payment-service Kubernetes ServiceAccount to a Vault policy granting read access to the payment-service secrets path; configure automatic lease renewal; write an integration test that verifies the service can encrypt and decrypt data using KMS/Vault credentials injected at runtime."}
  ]
}
-->
