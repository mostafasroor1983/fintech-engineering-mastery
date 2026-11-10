---
id: track-13-lesson-17
title: "Key Management — HSM, KMS, and Envelope Encryption"
slug: key-management
track: track-13
trackName: "Security & Observability"
sequence: 17
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [KMS, HSM, envelope-encryption, key-rotation, AWS-KMS]
prerequisites: [track-13-lesson-16]
---

# Key Management — HSM, KMS, and Envelope Encryption

> [!NOTE]
> Encryption is only as secure as your key management. A perfect AES-256-GCM implementation means nothing if the key is stored next to the data it protects. Key management is the hardest part of cryptography: getting keys to the right services without exposing them, rotating them without outages, and protecting them from insider threats.

## The Key Management Problem

The fundamental challenge: your payment service needs an encryption key to process transactions. How do you get that key to the service without:
1. Hardcoding it in source code (accessible to every developer, committed to git)
2. Storing it in a config file (readable by anyone with filesystem access)
3. Transmitting it in an environment variable (visible in `kubectl describe pod`, CI logs)
4. Storing it in the database (key and data in same breach blast radius)

The answer is a Key Management System (KMS) or Hardware Security Module (HSM) that:
- Stores keys securely, separate from application data
- Provides controlled access based on identity (IAM roles, service accounts)
- Logs every key operation for auditability
- Performs cryptographic operations inside the secure boundary (data never leaves)

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
- Envelope encryption means KMS is called once per key generation, then the data key does the heavy lifting locally.

---

## AWS KMS Implementation

```java
@Service
public class AwsKmsEnvelopeEncryption {

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
            SecureRandom.getInstanceStrong().nextBytes(iv);

            SecretKey secretKey = new SecretKeySpec(plaintextDataKey, "AES");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

            return EncryptedBundle.builder()
                .encryptedDataKey(Base64.getEncoder().encodeToString(encryptedDataKey))
                .iv(Base64.getEncoder().encodeToString(iv))
                .ciphertext(Base64.getEncoder().encodeToString(ciphertext))
                .keyVersion("v1")  // Track key version for rotation
                .build();

        } finally {
            // 3. CRITICAL: wipe plaintext data key from memory immediately
            // Prevents key exposure via heap dumps
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
    String keyVersion;        // Key version for rotation tracking
}
```

### KMS Encryption Context

Encryption context is a map of key-value pairs that is cryptographically bound to the ciphertext. It provides:
1. **Authorisation**: KMS can be configured to require specific encryption context values
2. **Auditability**: CloudTrail logs include the encryption context—you can see what service decrypted what data
3. **Tamper protection**: If the encryption context does not match, decryption fails

```json
// CloudTrail log for KMS decrypt call
{
  "eventName": "Decrypt",
  "userIdentity": {
    "type": "AssumedRole",
    "arn": "arn:aws:iam::123456789:assumed-role/payment-service-role/i-abc123"
  },
  "requestParameters": {
    "encryptionContext": {
      "service": "payment-service",
      "environment": "production",
      "purpose": "pan-encryption"
    },
    "keyId": "arn:aws:kms:eu-west-1:123456789:key/abcd-1234"
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
    private final String transitKeyPath = "transit/payment-fields";

    /**
     * Vault Transit — application sends data to Vault for encryption.
     * Key stays in Vault; application only handles ciphertext.
     */
    public String encrypt(String plaintext) {
        String base64Plaintext = Base64.getEncoder()
            .encodeToString(plaintext.getBytes(StandardCharsets.UTF_8));

        VaultResponse response = vaultTemplate.write(
            transitKeyPath + "/encrypt/payment-service",
            Map.of("plaintext", base64Plaintext)
        );

        return (String) response.getData().get("ciphertext");
        // Returns: "vault:v1:ABCDEF..." — Vault version prefix enables automatic re-wrapping
    }

    public String decrypt(String ciphertext) {
        VaultResponse response = vaultTemplate.write(
            transitKeyPath + "/decrypt/payment-service",
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
            transitKeyPath + "/rewrap/payment-service",
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
# min_decryption_version  1   <- oldest decrytable version
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

### HSM Hierarchy in PCI DSS

**FIPS 140-2 Level 3** is the minimum HSM security level for PCI DSS PAN encryption requirements:
- Tamper-evident physical protection
- Tamper response: key zeroization on physical attack
- Identity-based authentication required for all operations
- Private keys cannot be exported in plaintext

**Common HSM vendors**: Thales (nShield), Utimaco, AWS CloudHSM, Azure Dedicated HSM

```java
// PKCS#11 interface to HSM from Java
@Configuration
public class HsmConfig {

    @Bean
    public Provider hsmProvider() throws Exception {
        // Load the PKCS#11 provider for your HSM
        // HSM vendor provides the library (e.g., /usr/lib/pkcs11/libcknfast.so)
        Provider hsmProvider = Security.getProvider("SunPKCS11");
        return hsmProvider.configure("""
            name = PaymentsHSM
            library = /usr/lib/pkcs11/libcknfast.so
            slot = 0
            """);
    }

    @Bean
    public KeyStore hsmKeyStore(Provider hsmProvider) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS11", hsmProvider);
        // HSM PIN is an operator credential — stored in Vault, not application config
        ks.load(null, vaultClient.getHsmPin().toCharArray());
        return ks;
    }

    // Signing key for payment authorisation — private key lives in HSM
    @Bean
    public PrivateKey paymentSigningKey(KeyStore hsmKeyStore) throws Exception {
        return (PrivateKey) hsmKeyStore.getKey("payment-signing-key-v1", null);
    }
}

// Sign payment authorisation using HSM
@Service
public class PaymentAuthorisationSigner {

    private final PrivateKey signingKey;  // Lives in HSM

    public byte[] signPayment(PaymentAuthorisationRequest request) throws Exception {
        byte[] payload = serialiseToBytes(request);

        // This signature computation runs INSIDE the HSM
        // The private key never leaves the HSM boundary
        Signature signer = Signature.getInstance("SHA256withRSA");
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

PARTICIPANTS (required, minimum quorum of 3 of 5):
  - Chief Security Officer (CSO)
  - Head of Operations
  - Compliance Officer
  - Independent auditor
  - Senior Engineer (key administrator)

LOCATION:
  - Secure facility (HSM room)
  - Faraday cage (prevents radio interception)
  - No electronic devices, no cameras

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
  - Video recording of ceremony (audio disabled near key generation)
  - Signed by all participants
  - Stored in fireproof safe and off-site copy
```

---

## Spring Cloud Vault Integration

```yaml
# bootstrap.yml — Vault integration for Spring Boot
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
          enabled: true          # Automatic secret renewal
          min-renewal: 10s       # Start renewal 10s before expiry
          expiry-threshold: 1m   # Renew when less than 1 minute remaining

  config:
    import: "vault://"
    # Vault secret paths to load as properties
    # vault/secret/payment-service/database → spring.datasource.*
    # vault/secret/payment-service/kms → encryption.*
```

```java
// Automatic secret renewal — Vault lease management
@Service
public class VaultSecretManager {

    @Value("${database.username}")  // Injected from Vault dynamic secret
    private String dbUsername;

    @Value("${database.password}")  // Injected from Vault dynamic secret
    private String dbPassword;

    // Spring Cloud Vault automatically renews leases before expiry
    // When renewal fails (Vault unavailable), Spring context refreshes
    // causing HikariCP to reconnect with new credentials

    @EventListener
    public void onSecretLeaseExpired(SecretLeaseExpiredEvent event) {
        log.warn("Vault secret lease expired: {}", event.getSource());
        // Trigger connection pool refresh to pick up new credentials
        dataSource.close();
        dataSource = dataSourceFactory.createDataSource(dbUsername, dbPassword);
    }
}
```

---

## Key Takeaways

- Envelope encryption solves the KMS performance problem: generate one data key per record (or per customer), encrypt data locally with the data key, store only the KMS-encrypted data key
- Always use encryption context in AWS KMS calls: it provides authorisation context and makes CloudTrail logs meaningful ("which service, for what purpose, decrypted this key")
- Vault Transit's rewrap operation rotates encryption keys without the plaintext ever leaving Vault — this is how you achieve key rotation at scale without a data migration
- HSMs are required for PAN encryption under PCI DSS (FIPS 140-2 Level 3): the private key never leaves the hardware boundary regardless of physical or logical attack
- Key ceremonies are not bureaucracy — they are the procedural control that ensures no single person can compromise the root of trust; they require a quorum, documentation, and independent witnesses
- Wipe plaintext key material from memory immediately after use with `Arrays.fill(keyBytes, (byte) 0)`: heap dumps and core dumps can expose keys that linger in memory

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is envelope encryption, and why does it solve the KMS performance problem?",
      "options": ["Envelope encryption encrypts data twice for extra security", "A DEK (Data Encryption Key) encrypts the data locally; the DEK itself is encrypted by KMS and stored alongside the data — only the DEK encryption/decryption requires KMS, not every data read/write", "Envelope encryption stores keys inside the database alongside the data", "Envelope encryption requires a hardware security module for every operation"],
      "correct": 1,
      "explanation": "Calling AWS KMS for every database read/write would be impossibly slow (network round-trip per operation). Envelope encryption generates a local DEK, encrypts the data with the DEK in memory (fast), and only calls KMS to wrap/unwrap the DEK — which happens once at startup or on cache expiry, not on every data access."
    },
    {
      "text": "What is the FIPS 140-2 Level 3 requirement for HSMs, and when is it mandatory in financial services?",
      "options": ["FIPS 140-2 Level 3 requires physical tamper-evidence; mandatory for PAN encryption under PCI DSS HSM requirements", "FIPS 140-2 Level 3 requires AES-256 encryption; mandatory for all financial services", "FIPS 140-2 Level 3 requires network isolation; mandatory for internet-facing services", "FIPS 140-2 Level 3 is optional guidance; never strictly mandatory"],
      "correct": 0,
      "explanation": "FIPS 140-2 Level 3 requires physical tamper-evidence, tamper-resistance, and identity-based authentication. PCI DSS requires HSMs meeting FIPS 140-2 Level 3 (or higher) for PAN encryption operations. The key benefit: private keys never leave the hardware boundary, so even physical access to the HSM device cannot extract the keys."
    },
    {
      "text": "Why should plaintext key material be wiped from Java byte arrays immediately after use with Arrays.fill()?",
      "options": ["To improve garbage collection performance", "Java's garbage collector does not immediately free memory; key material can persist in heap until GC runs. Heap dumps, core dumps, or memory analysis tools can expose key bytes that linger in memory after use", "To comply with Java memory management best practices", "To prevent key material from being logged accidentally"],
      "correct": 1,
      "explanation": "Unlike stack variables in some languages, Java byte arrays on the heap persist until GC collects them, which may be minutes later. Heap dumps (JVM diagnostic tool), core dumps (OS crash), or memory forensics can recover key bytes still in memory. Arrays.fill() zeroes the bytes immediately, limiting the window of exposure."
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
