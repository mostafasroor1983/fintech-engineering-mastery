---
id: track-11-lesson-17
title: "إدارة المفاتيح — HSM وKMS والتشفير المغلّف"
slug: key-management
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 17
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [KMS, HSM, envelope-encryption, key-rotation, AWS-KMS]
prerequisites: [track-11-lesson-16]
---

# إدارة المفاتيح — HSM وKMS والتشفير المغلّف

> [!NOTE]
> لا يكون التشفير أكثر أمانًا من إدارة مفاتيحك. فتنفيذ AES-256-GCM مثالي لا يعني شيئًا إن خُزن المفتاح بجوار البيانات التي يحميها. وإدارة المفاتيح أصعب أجزاء التشفير: إيصال المفاتيح إلى الخدمات الصحيحة دون كشفها، وتدويرها دون انقطاعات، وحمايتها من التهديدات الداخلية.

## مشكلة إدارة المفاتيح

التحدي الأساسي: تحتاج خدمة الدفع مفتاح تشفير لمعالجة المعاملات. فكيف توصل ذلك المفتاح إلى الخدمة دون:
1. كتابته في الكود المصدري (متاح لكل مطور، ومحفوظ في git)
2. تخزينه في ملف إعداد (قابل للقراءة من أي شخص لديه وصول إلى نظام الملفات)
3. تمريره في متغير بيئة (مرئي في مواصفة الـ pod، و`/proc/<pid>/environ`، وتقارير الأعطال، وسجلات CI)
4. تخزينه في قاعدة البيانات (المفتاح والبيانات في نطاق الاختراق نفسه)

الإجابة نظام إدارة مفاتيح (KMS) أو وحدة أمان أجهزة (HSM):
- يخزن المفاتيح بأمان، منفصلة عن بيانات التطبيق
- يوفر وصولًا متحكمًا فيه بناءً على الهوية (أدوار IAM، وحسابات الخدمة)
- يسجّل كل عملية على المفاتيح لقابلية التدقيق
- ينفذ العمليات التشفيرية داخل الحدود الآمنة (لا يغادرها المفتاح الرئيسي أبدًا)

---

## نمط التشفير المغلّف

يتجنب التشفير المغلّف مشكلة إرسال كميات كبيرة من البيانات إلى KMS للتشفير. وبدلًا من ذلك:

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

**لماذا التشفير المغلّف؟**
- لدى KMS حدود معدل وزمن استجابة (~1-5 مللي ثانية لكل استدعاء). وتشفير كل سجل بمفرده سيكون بطيئًا جدًا.
- لا يمكن إرسال بيانات كبيرة إلى KMS ‏(حد AWS KMS: ‏4 كيلوبايت لكل استدعاء تشفير/فك تشفير).
- يعني التشفير المغلّف استدعاء KMS مرة لكل مفتاح بيانات (لتوليده، ومرة أخرى لفكه عند القراءة)، بينما يتولى مفتاح البيانات العمل الثقيل محليًا. وللأحجام الكبيرة، خزّن مفاتيح البيانات المفكوكة مؤقتًا لفترة قصيرة (مثل التخزين المؤقت لمفاتيح البيانات في AWS Encryption SDK) — مقابل قليل من التعرض للحصول على استدعاءات KMS أقل بكثير.

---

## التنفيذ مع AWS KMS

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

### سياق التشفير في KMS

سياق التشفير خريطة من أزواج مفتاح-قيمة مرتبطة تشفيريًا بالنص المشفر. ويوفر:
1. **التفويض**: يمكن ضبط KMS لاشتراط قيم سياق تشفير محددة
2. **قابلية التدقيق**: تتضمن سجلات CloudTrail سياق التشفير — فترى أي خدمة فكت تشفير أي بيانات
3. **الحماية من العبث**: إن لم يتطابق سياق التشفير، يفشل فك التشفير

سجل CloudTrail لاستدعاء `Decrypt` في KMS (مختصر):

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

## محرك HashiCorp Vault Transit

يوفر Vault Transit التشفير كخدمة: يرسل تطبيقك النص الصريح إلى Vault، ويعيد Vault النص المشفر. ولا يغادر المفتاح Vault أبدًا.

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

### تدوير مفاتيح Vault

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

## ‏HSM ‏(وحدة أمان الأجهزة)

وحدة HSM جهاز مادي مقاوم للعبث يولّد المفاتيح التشفيرية ويخزنها ويستخدمها. ولا يغادر المفتاح الخاص حدود HSM أبدًا — فالعمليات التشفيرية تحدث داخل الجهاز.

### أين تكون وحدات HSM مطلوبة

لا يفرض PCI DSS نفسه وحدة HSM لتشفير PAN: فيجب تخزين مفاتيح تشفير المفاتيح في جهاز تشفير آمن (HSM)، *أو* كمكوّنين كاملي الطول على الأقل، *أو* مشفرة تحت مفتاح بالقوة نفسها على الأقل (المتطلب 3.6.1.2). وتصبح وحدات HSM إلزامية في **معالجة PIN وإصدار البطاقات** (PCI PIN Security، وPCI P2PE، وقواعد شبكات البطاقات)، حيث يجب أن تكون الأجهزة معتمدة بموجب **PCI PTS HSM** أو مصادقًا عليها وفق **FIPS 140-2/140-3 المستوى 3** أو أعلى. وعمليًا، تضع معظم الشركات مفاتيحها الجذرية في HSM — أو في KMS سحابي، تحمي مفاتيحه وحدات HSM مصادق عليها وفق FIPS 140 — على أي حال.

توفر وحدات HSM من **المستوى 3 في FIPS 140**:
- حماية مادية تُظهر العبث *وتقاومه*
- الاستجابة للعبث: تصفير المفاتيح عند الهجوم المادي
- مصادقة قائمة على الهوية مطلوبة لكل العمليات
- لا يمكن تصدير المفاتيح كنص صريح

‏(حلّ FIPS 140-3 محل FIPS 140-2: فالمصادقات الجديدة تصدر وفق 140-3، وتنتقل شهادات 140-2 المتبقية إلى القائمة التاريخية في سبتمبر 2026.)

**موردو HSM الشائعون**: ‏Thales ‏(nShield)، وUtimaco، وAWS CloudHSM، وAzure Dedicated HSM

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

## إجراءات مراسم المفاتيح

مراسم المفاتيح هي الإجراء الرسمي لتوليد مفتاح رئيسي جديد. وتتطلب نصابًا من الأفراد الموثوقين (أمناء المفاتيح) فلا يستطيع شخص واحد اختراق المفتاح.

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

## التكامل مع Spring Cloud Vault

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

## الخلاصات الأساسية

- يحل التشفير المغلّف مشكلة أداء KMS وحجم البيانات: ولّد مفتاح بيانات واحدًا لكل سجل (أو لكل عميل)، وشفّر البيانات محليًا بمفتاح البيانات، وخزّن فقط مفتاح البيانات المشفر بـ KMS
- استخدم دائمًا سياق التشفير في استدعاءات AWS KMS: فهو يوفر سياق التفويض ويجعل سجلات CloudTrail ذات معنى ("أي خدمة، ولأي غرض، فكت تشفير هذا المفتاح")
- تنقل عملية rewrap في Vault Transit النص المشفر إلى أحدث إصدار للمفتاح دون أن يغادر النص الصريح Vault أبدًا — فما زلت تحدّث النص المشفر المخزن، لكن دون الحاجة إلى ترحيل نص صريح
- وحدات HSM ‏(PCI PTS HSM أو FIPS 140-2/140-3 المستوى 3) إلزامية لمعالجة PIN وإصدار البطاقات؛ ولتشفير PAN يسمح PCI DSS أيضًا بخيارات أخرى لحماية المفاتيح، لكن المفاتيح الجذرية في HSM أو KMS مدعوم بـ HSM ممارسة قياسية — فلا تغادر المفاتيح حدود الجهاز أبدًا
- مراسم المفاتيح ليست بيروقراطية — بل هي الضابط الإجرائي الذي يضمن ألا يستطيع شخص واحد اختراق جذر الثقة؛ وتتطلب نصابًا، وتوثيقًا، وشهودًا مستقلين
- امسح مادة المفاتيح الصريحة من الذاكرة بأسرع ما يمكن بـ `Arrays.fill(keyBytes, (byte) 0)` — بأفضل جهد، لأن المكتبات تحتفظ بنسخها الخاصة؛ فتفريغات الذاكرة وتفريغات النواة قد تكشف المفاتيح العالقة في الذاكرة، فعاملها كبيانات حساسة

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما التشفير المغلّف، ولماذا يحل مشكلة أداء KMS؟",
      "options": [
        "التشفير المغلّف يشفر البيانات مرتين لأمان إضافي",
        "مفتاح تشفير البيانات (DEK) يشفر البيانات محليًا؛ وDEK نفسه يشفره KMS ويُخزن بجوار البيانات — فقط تشفير/فك تشفير DEK يتطلب KMS، لا كل قراءة/كتابة للبيانات",
        "التشفير المغلّف يخزن المفاتيح داخل قاعدة البيانات بجوار البيانات",
        "التشفير المغلّف يتطلب وحدة أمان أجهزة لكل عملية"
      ],
      "correct": 1,
      "explanation": "استدعاء AWS KMS لكل بايت من البيانات سيكون بطيئًا (رحلة شبكية لكل عملية) ومستحيلًا للسجلات الكبيرة (يشفر KMS بحد أقصى 4 كيلوبايت). ويشفر التشفير المغلّف البيانات محليًا بـ DEK ‏(سريع) ويستدعي KMS فقط لتوليد DEK وفكه — مرة لكل سجل يُكتب أو يُقرأ، أو أقل حتى حين تُخزن مفاتيح DEK المفكوكة مؤقتًا لفترة قصيرة."
    },
    {
      "text": "أين تكون وحدات HSM المعتمدة وفق FIPS 140 المستوى 3 (أو PCI PTS HSM) إلزامية في المدفوعات، وماذا يضيف المستوى 3؟",
      "options": [
        "في معالجة PIN وإصدار البطاقات (PCI PIN Security، وP2PE، وقواعد شبكات البطاقات)؛ ويضيف المستوى 3 مقاومة العبث مع تصفير المفاتيح والمصادقة القائمة على الهوية",
        "لكل خدمة تخزن أي بيانات شخصية",
        "فقط لخوادم الويب المواجهة للإنترنت التي تنهي TLS",
        "لا مكان — FIPS 140 إرشادات للحكومة الأمريكية لا دور لها في المدفوعات"
      ],
      "correct": 0,
      "explanation": "تتطلب معالجة PIN وإصدار البطاقات وحدات HSM معتمدة بموجب PCI PTS HSM أو مصادقًا عليها وفق FIPS 140-2/140-3 المستوى 3 أو أعلى. ويضيف المستوى 3 مقاومة العبث (تُصفّر المفاتيح عند الهجوم المادي) ومصادقة المشغّل القائمة على الهوية. ولتشفير PAN، يسمح PCI DSS 3.6.1.2 أيضًا بتخزين مفاتيح تشفير المفاتيح كمكونات مقسمة أو مشفرة تحت مفتاح بالقوة نفسها — وإن كانت المفاتيح الجذرية في HSM أو KMS مدعوم بـ HSM ممارسة قياسية. وقد حلّ FIPS 140-3 محل 140-2 للمصادقات الجديدة."
    },
    {
      "text": "لماذا يجب مسح مادة المفاتيح الصريحة من مصفوفات البايتات في Java فور استخدامها بـ Arrays.fill()؟",
      "options": [
        "لتحسين أداء جمع المهملات",
        "لا يحرر جامع المهملات في Java الذاكرة فورًا؛ فقد تبقى مادة المفتاح في الكومة حتى يعمل GC. ويمكن لتفريغات الذاكرة، أو تفريغات النواة، أو أدوات تحليل الذاكرة كشف بايتات المفتاح العالقة في الذاكرة بعد الاستخدام",
        "للامتثال لأفضل ممارسات إدارة الذاكرة في Java",
        "لمنع تسجيل مادة المفتاح عرضيًا"
      ],
      "correct": 1,
      "explanation": "تبقى مصفوفات البايتات في كومة Java حتى يستعيدها جامع المهملات، وقد يكون ذلك بعد دقائق — وحتى حينها لا تُصفّر الذاكرة حتى يُعاد استخدامها. ويمكن لتفريغات الذاكرة (تشخيص JVM)، أو تفريغات النواة (عطل نظام التشغيل)، أو التحليل الجنائي للذاكرة استعادة بايتات المفتاح التي ما زالت في الذاكرة. ويصفّر Arrays.fill() نسختك فورًا، فيحدّ من نافذة التعرض؛ وهو بأفضل جهد، لأن مكتبات مثل SecretKeySpec تحتفظ بنسخ داخلية."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "إدارة المفاتيح مع AWS KMS وHashiCorp Vault",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "نفّذ التشفير المغلّف مع AWS KMS: استخدم GenerateDataKey للحصول على DEK صريح وDEK مشفر، وشفّر سجل دفع بـ DEK الصريح باستخدام AES-256-GCM، وخزّن DEK المشفر فقط بجوار النص المشفر، ونفّذ فك تشفير يستدعي KMS Decrypt لاستعادة DEK، مع ضمان مسح بايتات DEK الصريح من الذاكرة بعد الاستخدام."},
    {"id": "2", "description": "أضف سياق التشفير إلى كل استدعاءات AWS KMS لخدمة الدفع: ضمّن اسم الخدمة، والغرض، والبيئة في EncryptionContext؛ وتحقق من رفض استدعاءات KMS دون السياق المطابق؛ وتأكد من أن سجلات CloudTrail تُظهر سياق التشفير لقابلية التدقيق."},
    {"id": "3", "description": "اضبط محرك أسرار HashiCorp Vault Transit لتدوير المفاتيح: أنشئ مفتاح تشفير مسمى مع تفعيل التدوير، ونفّذ نمط encrypt/decrypt/rewrap، واكتب مهمة ترحيل تستخدم rewrap الدفعي لإعادة تشفير كل السجلات إلى أحدث إصدار للمفتاح دون كشف النص الصريح خارج Vault."},
    {"id": "4", "description": "نفّذ التكامل مع Spring Cloud Vault بمصادقة Kubernetes: اربط حساب خدمة Kubernetes لـ payment-service بسياسة Vault تمنح صلاحية القراءة لمسار أسرار payment-service؛ واضبط التجديد التلقائي لعقود الإيجار؛ واكتب اختبار تكامل يتحقق من أن الخدمة تستطيع تشفير البيانات وفكها باستخدام بيانات اعتماد KMS/Vault المحقونة وقت التشغيل."}
  ]
}
-->
