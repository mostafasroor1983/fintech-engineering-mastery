---
id: track-09-lesson-12
title: "أمان Kafka — TLS وSASL وقوائم التحكم بالوصول"
slug: kafka-security
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 12
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Kafka, TLS, SASL, ACL, mTLS]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
---

# أمن Kafka — ‏TLS وSASL وACL

> [!NOTE]
> تعالج Kafka بيانات الدفع، وأحداث الحسابات، وتدفقات المعاملات — وكلها فئات تتطلب تحكمًا صارمًا في الوصول بموجب PCI DSS، وGDPR، وأنظمة FCA. وعنقود Kafka سيئ الإعداد قد يكشف البيانات المالية لأي خدمة على الشبكة أو يسمح لخدمة مخترقة بنشر أحداث دفع احتيالية. والأمن ليس اهتمامًا ما بعد الإطلاق — بل يجب تصميمه في البنية من اليوم الأول.

## طبقات أمن Kafka

لـ Kafka ثلاث طبقات أمن مستقلة تعمل معًا:

```
Layer 1: Encryption (TLS)
  Who can see the data in transit?
  → TLS encrypts all Kafka traffic on the wire

Layer 2: Authentication (SASL / mTLS)
  Who is connecting?
  → SASL or mutual TLS identifies the client

Layer 3: Authorisation (ACLs)
  What can the authenticated identity do?
  → ACLs grant/deny operations per topic per identity
```

يجب إعداد الثلاث لعنقود Kafka مالي إنتاجي.

## إعداد TLS

يشفّر TLS الحركة بين العملاء والوسطاء، وبين الوسطاء داخل العنقود.

### توليد الشهادات (الإنتاج)

في الإنتاج، استخدم البنية التحتية للمفاتيح العامة (PKI) في مؤسستك أو جهة إصدار مُدارة (AWS Private CA، أو Vault PKI). وللمرجعية، العملية اليدوية:

```bash
# 1. Create a CA (do this once per environment) -- bc:c marks it as a CA
keytool -genkeypair -keyalg RSA -keysize 3072 \
    -alias ca -keystore ca.jks \
    -dname "CN=Kafka-CA, OU=Fintech, O=Payments Ltd, C=GB" \
    -ext bc:c -validity 3650

# Export the CA certificate (used by every truststore)
keytool -exportcert -alias ca -keystore ca.jks -rfc -file ca.crt

# 2. Create broker keystore
keytool -genkeypair -keyalg RSA -keysize 2048 \
    -alias broker1 -keystore broker1.jks \
    -dname "CN=broker1.kafka.internal, OU=Kafka, O=Payments Ltd, C=GB"

# 3. Sign broker cert with CA -- include the hostnames clients use as SAN
#    (hostname verification checks the SAN, not only the CN)
keytool -certreq -alias broker1 -keystore broker1.jks -file broker1.csr
keytool -gencert -alias ca -keystore ca.jks \
    -infile broker1.csr -outfile broker1.crt -validity 365 \
    -ext SAN=dns:broker1.kafka.internal,dns:broker1

# 4. Import CA cert and signed cert into broker keystore
keytool -importcert -alias ca -keystore broker1.jks -file ca.crt
keytool -importcert -alias broker1 -keystore broker1.jks -file broker1.crt

# 5. Create client truststore with CA cert
keytool -importcert -alias ca -keystore client.truststore.jks -file ca.crt
```

### إعداد TLS للوسيط

```properties
# server.properties -- TLS only: no PLAINTEXT listener in production
listeners=SSL://0.0.0.0:9093
advertised.listeners=SSL://broker1.kafka.internal:9093
inter.broker.listener.name=SSL

ssl.keystore.location=/etc/kafka/ssl/broker1.jks
# Passwords: inject via a config provider or a secret mount, not plain text
ssl.keystore.password=${file:/etc/kafka/secrets/ssl.properties:keystore.password}
ssl.key.password=${file:/etc/kafka/secrets/ssl.properties:key.password}
ssl.truststore.location=/etc/kafka/ssl/ca.truststore.jks
ssl.truststore.password=${file:/etc/kafka/secrets/ssl.properties:truststore.password}
config.providers=file
config.providers.file.class=org.apache.kafka.common.config.provider.FileConfigProvider

# Require TLS 1.2 minimum
ssl.enabled.protocols=TLSv1.2,TLSv1.3
ssl.protocol=TLSv1.3

# Cipher suites — strong AEAD suites only. If TLS 1.2 stays enabled, the
# list must also contain TLS 1.2 suites, or TLS 1.2 clients cannot connect
ssl.cipher.suites=TLS_AES_256_GCM_SHA384,TLS_AES_128_GCM_SHA256,TLS_CHACHA20_POLY1305_SHA256,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
```

### إعداد TLS للعميل (Java)

```java
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.config.SslConfigs;
import java.util.Properties;

public class SecureProducerConfig {

    public static Properties buildTlsConfig() {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "broker1:9093,broker2:9093");

        props.put("security.protocol", "SSL");
        props.put(SslConfigs.SSL_TRUSTSTORE_LOCATION_CONFIG,
                "/etc/kafka/ssl/client.truststore.jks");
        props.put(SslConfigs.SSL_TRUSTSTORE_PASSWORD_CONFIG, "truststore-secret");

        // For mTLS: client also presents a certificate
        props.put(SslConfigs.SSL_KEYSTORE_LOCATION_CONFIG,
                "/etc/kafka/ssl/payment-service.jks");
        props.put(SslConfigs.SSL_KEYSTORE_PASSWORD_CONFIG, "keystore-secret");
        props.put(SslConfigs.SSL_KEY_PASSWORD_CONFIG, "key-secret");

        props.put(SslConfigs.SSL_ENDPOINT_IDENTIFICATION_ALGORITHM_CONFIG, "https");
        // Verifies that the broker hostname matches the cert SAN — prevents
        // MITM attacks. "https" is the default since Kafka 2.0: never set it
        // to "" (empty) to work around certificate problems

        return props;
    }
}
```

## ‏mTLS للمصادقة بين الخدمات

يعني TLS المتبادل (mTLS) أن الوسيط والعميل كليهما يقدّمان شهادات. ويتحقق الوسيط من شهادة العميل مقابل مخزن الثقة — مصادقة بلا كلمات مرور.

```properties
# Broker: require client certificates
ssl.client.auth=required   # required | requested | none
```

```java
// Spring Boot application.properties for mTLS
spring.kafka.bootstrap-servers=broker1:9093
spring.kafka.security.protocol=SSL
spring.kafka.ssl.trust-store-location=classpath:ssl/ca.truststore.jks
spring.kafka.ssl.trust-store-password=${KAFKA_TRUSTSTORE_PASSWORD}
spring.kafka.ssl.key-store-location=classpath:ssl/payment-service.jks
spring.kafka.ssl.key-store-password=${KAFKA_KEYSTORE_PASSWORD}
spring.kafka.ssl.key-password=${KAFKA_KEY_PASSWORD}
```

**هوية mTLS:** يستخدم الوسيط افتراضيًا الاسم المميز الكامل للشهادة كهوية: فشهادة بـ `CN=payment-service` تُصادق باسم `User:CN=payment-service,OU=Services,O=Payments Ltd,C=GB`. ولاستخدام أسماء قصيرة مثل `User:payment-service` في قواعد ACL (كما أدناه)، اربطها على الوسيط:

```properties
ssl.principal.mapping.rules=RULE:^CN=([a-zA-Z0-9.-]+),.*$/$1/,DEFAULT
```

## آليات مصادقة SASL

يوفر SASL ‏(Simple Authentication and Security Layer) مصادقة باسم مستخدم/كلمة مرور ومصادقة قائمة على الرموز. واستخدم آليات مختلفة لأنواع العملاء المختلفة.

### ‏SASL/PLAIN (للتطوير فقط)

تُدرج كلمات المرور بنص واضح في إعداد الوسيط وتُرسل (داخل TLS) مع كل اتصال؛ وتغيير إحداها يحتاج إعادة تشغيل الوسيط. مناسب للتطوير المحلي — وتجنبه في الإنتاج.

```properties
# Broker: SASL_SSL listener (SASL + TLS)
listeners=SASL_SSL://broker1:9094
sasl.enabled.mechanisms=PLAIN
sasl.mechanism.inter.broker.protocol=PLAIN

# JAAS configuration
listener.name.sasl_ssl.plain.sasl.jaas.config=\
    org.apache.kafka.common.security.plain.PlainLoginModule required \
    username="admin" \
    password="admin-secret" \
    user_admin="admin-secret" \
    user_payment-service="payment-secret" \
    user_settlement-service="settlement-secret";
```

```java
// Client SASL/PLAIN configuration
props.put("security.protocol", "SASL_SSL");
props.put("sasl.mechanism", "PLAIN");
props.put("sasl.jaas.config",
    "org.apache.kafka.common.security.plain.PlainLoginModule required " +
    "username=\"payment-service\" " +
    "password=\"payment-secret\";");
```

### ‏SASL/SCRAM-SHA-512 (للخدمات المصغّرة — موصى به)

يوفر SCRAM بروتوكول تحدٍّ واستجابة — فلا تُرسل كلمة المرور نفسها أبدًا، بل برهان مملّح فقط؛ ويخزن الوسيط تجزئات مملّحة، ويمكن إضافة بيانات الاعتماد أو تدويرها أثناء التشغيل بـ `kafka-configs.sh` (دون إعادة تشغيل). وما زلت تستخدمه فوق TLS ‏(`SASL_SSL`).

```bash
# Create SCRAM credentials (stored in the KRaft metadata log).
# admin.properties holds the admin client's SASL_SSL settings.
# (The very first admin credential is created when formatting the
#  storage: kafka-storage.sh format ... --add-scram)
kafka-configs.sh --bootstrap-server broker1:9094 --command-config admin.properties \
    --alter --add-config "SCRAM-SHA-512=[password=payment-secret]" \
    --entity-type users --entity-name payment-service

kafka-configs.sh --bootstrap-server broker1:9094 --command-config admin.properties \
    --alter --add-config "SCRAM-SHA-512=[password=settlement-secret]" \
    --entity-type users --entity-name settlement-service
```

```java
// Client SASL/SCRAM configuration
props.put("security.protocol", "SASL_SSL");
props.put("sasl.mechanism", "SCRAM-SHA-512");
props.put("sasl.jaas.config",
    "org.apache.kafka.common.security.scram.ScramLoginModule required " +
    "username=\"payment-service\" " +
    "password=\"payment-secret\";");
```

### ‏SASL/OAUTHBEARER ‏(Kubernetes — الحديث)

تأتي رموز OAuth من مزود هوية (Keycloak، وEntra ID، وOkta، ...) — وفي Kubernetes عادة ببيانات اعتماد عميل لكل حمل عمل. وتوفر Kafka 3.1+ تنفيذ OIDC لتدفق بيانات اعتماد العميل (KIP-768):

```java
// OAUTHBEARER with Kafka's built-in OIDC support (client credentials flow)
props.put("security.protocol", "SASL_SSL");
props.put("sasl.mechanism", "OAUTHBEARER");
props.put("sasl.oauthbearer.token.endpoint.url",
    "https://keycloak.internal/realms/fintech/protocol/openid-connect/token");
props.put("sasl.login.callback.handler.class",
    "org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginCallbackHandler");
props.put("sasl.jaas.config",
    "org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required " +
    "clientId=\"kafka-payment-service\" " +
    // a "${...}" inside a Java string is NOT substituted -- read the secret
    "clientSecret=\"" + System.getenv("OAUTH_CLIENT_SECRET") + "\";");
// Brokers validate the JWTs against the IdP's JWKS endpoint
// (sasl.oauthbearer.jwks.endpoint.url on the broker listener)
```

## إعداد ACL

تمنح قوائم التحكم في الوصول (ACL) عمليات محددة لهويات محددة على موارد محددة أو تمنعها.

### عمليات ACL

| العملية | تنطبق على | الوصف |
|-----------|-----------|-------------|
| ‏`READ` | موضوع | الاستهلاك من الموضوع |
| ‏`WRITE` | موضوع | الإنتاج إلى الموضوع |
| ‏`CREATE` | موضوع/عنقود | إنشاء المواضيع |
| ‏`DELETE` | موضوع | حذف المواضيع |
| ‏`DESCRIBE` | موضوع | جلب البيانات الوصفية |
| ‏`DESCRIBE_CONFIGS` | موضوع | قراءة الإعدادات |
| ‏`ALTER` | موضوع/عنقود | تعديل الإعدادات |
| ‏`ALL` | أي | كل العمليات |

### ضبط ACL لخدمات الدفع

```bash
# payment-service: can WRITE to payments.events (producer)
kafka-acls.sh --bootstrap-server broker1:9094 --command-config admin.properties \
    --add --allow-principal User:payment-service \
    --operation WRITE --operation DESCRIBE \
    --topic payments.events

# settlement-service: can READ from payments.events (consumer)
kafka-acls.sh --bootstrap-server broker1:9094 --command-config admin.properties \
    --add --allow-principal User:settlement-service \
    --operation READ --operation DESCRIBE \
    --topic payments.events \
    --group settlement-service-group

# notification-service: can READ from payments.events
kafka-acls.sh --bootstrap-server broker1:9094 --command-config admin.properties \
    --add --allow-principal User:notification-service \
    --operation READ --operation DESCRIBE \
    --topic payments.events \
    --group notification-service-group

# schema-registry: needs WRITE on _schemas topic
kafka-acls.sh --bootstrap-server broker1:9094 --command-config admin.properties \
    --add --allow-principal User:schema-registry \
    --operation ALL --topic _schemas

# admin user: can describe all topics (monitoring)
kafka-acls.sh --bootstrap-server broker1:9094 --command-config admin.properties \
    --add --allow-principal User:monitoring-service \
    --operation DESCRIBE --topic '*'
```

### إدارة ACL عبر AdminClient في Java

```java
import org.apache.kafka.clients.admin.*;
import org.apache.kafka.common.acl.*;
import org.apache.kafka.common.resource.*;
import java.util.List;

@Service
public class KafkaAclManager {

    @Autowired
    private AdminClient adminClient;

    public void grantProducerAccess(String principal, String topic) throws Exception {
        List<AclBinding> acls = List.of(
                new AclBinding(
                        new ResourcePattern(ResourceType.TOPIC, topic,
                                PatternType.LITERAL),
                        new AccessControlEntry("User:" + principal, "*",
                                AclOperation.WRITE, AclPermissionType.ALLOW)
                ),
                new AclBinding(
                        new ResourcePattern(ResourceType.TOPIC, topic,
                                PatternType.LITERAL),
                        new AccessControlEntry("User:" + principal, "*",
                                AclOperation.DESCRIBE, AclPermissionType.ALLOW)
                )
        );

        adminClient.createAcls(acls).all().get();
        log.info("Granted producer access for {} on topic {}", principal, topic);
    }

    public void grantConsumerAccess(String principal, String topic,
            String consumerGroup) throws Exception {
        List<AclBinding> acls = List.of(
                new AclBinding(
                        new ResourcePattern(ResourceType.TOPIC, topic,
                                PatternType.LITERAL),
                        new AccessControlEntry("User:" + principal, "*",
                                AclOperation.READ, AclPermissionType.ALLOW)
                ),
                new AclBinding(
                        new ResourcePattern(ResourceType.TOPIC, topic,
                                PatternType.LITERAL),
                        new AccessControlEntry("User:" + principal, "*",
                                AclOperation.DESCRIBE, AclPermissionType.ALLOW)
                ),
                new AclBinding(
                        new ResourcePattern(ResourceType.GROUP, consumerGroup,
                                PatternType.LITERAL),
                        new AccessControlEntry("User:" + principal, "*",
                                AclOperation.READ, AclPermissionType.ALLOW)
                )
        );

        adminClient.createAcls(acls).all().get();
        log.info("Granted consumer access for {} on topic {} group {}",
                principal, topic, consumerGroup);
    }

    public List<AclBinding> listAcls(String topic) throws Exception {
        AclBindingFilter filter = new AclBindingFilter(
                new ResourcePatternFilter(ResourceType.TOPIC, topic,
                        PatternType.LITERAL),
                AccessControlEntryFilter.ANY
        );
        return new ArrayList<>(adminClient.describeAcls(filter).values().get());
    }
}
```

## تدوير الشهادات دون توقف

تدعم Kafka تدوير الشهادات المتدحرج دون توقف:

```bash
# Step 1: Add new CA cert to all truststores (while old cert still valid)
# Brokers and clients trust BOTH old and new CAs simultaneously

# Step 2: Deploy new broker keystores (signed by new CA) — rolling restart
# Clients using old CA cert still work (broker truststore has both CAs)

# Step 3: Deploy new client keystores (signed by new CA)
# Brokers trust new client certs (truststore has new CA)

# Step 4: Remove old CA cert from truststores
# Only new certs trusted — rotation complete

# Check cert expiry (alert when < 30 days)
keytool -list -keystore broker1.jks -v | grep "Valid from"
```

```java
// Certificate expiry monitoring
@Scheduled(cron = "0 0 6 * * *")  // Daily at 6 AM
public void checkCertificateExpiry() {
    try {
        KeyStore ks = KeyStore.getInstance("JKS");
        ks.load(new FileInputStream("/etc/kafka/ssl/broker1.jks"), password);

        Enumeration<String> aliases = ks.aliases();
        while (aliases.hasMoreElements()) {
            String alias = aliases.nextElement();
            Certificate cert = ks.getCertificate(alias);
            if (cert instanceof X509Certificate x509) {
                long daysUntilExpiry = ChronoUnit.DAYS.between(
                        Instant.now(), x509.getNotAfter().toInstant());
                if (daysUntilExpiry < 30) {
                    alertService.sendAlert(AlertSeverity.HIGH,
                            "Kafka cert '" + alias + "' expires in " + daysUntilExpiry + " days");
                }
            }
        }
    } catch (Exception e) {
        log.error("Failed to check certificate expiry", e);
    }
}
```

## متطلبات أمن Kafka في PCI DSS

للامتثال لمعيار صناعة بطاقات الدفع:

```
PCI DSS Requirement 2 (Secure Configuration / Default Credentials):
  ✓ No default Kafka admin credentials in production
  ✓ SCRAM-SHA-512, OAUTHBEARER or mTLS — avoid SASL/PLAIN with static
    passwords in production (an internal policy choice that supports Req. 8)

PCI DSS Requirement 4 (Data in Transit):
  ✓ TLS 1.2+ for all Kafka traffic
  ✓ No PLAINTEXT listener exposed
  ✓ Strong cipher suites only (AES-GCM / ChaCha20-Poly1305)

PCI DSS Requirement 7 (Access Control):
  ✓ ACLs per service — least privilege
  ✓ No wildcard WRITE access to payment topics
  ✓ Consumer groups restricted per service identity

PCI DSS Requirement 10 (Audit Logging):
  ✓ Kafka authorisation logging enabled
  ✓ Failed authentication attempts logged and alerted
  ✓ ACL changes logged in audit trail

PCI DSS Requirement 12 (Security Policies):
  ✓ Certificate rotation procedure documented and tested
  ✓ Kafka access reviewed quarterly
```

### تفعيل سجل التدقيق

```properties
# Broker authorizer -- KRaft (the only mode since Kafka 4.0):
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
# (older ZooKeeper-based clusters used kafka.security.authorizer.AclAuthorizer)

# Log to separate audit log file. The authorizer logger writes DENIED
# requests at INFO and ALLOWED ones at DEBUG (very verbose).
# Kafka 4.0 uses Log4j 2 -- express the same settings in log4j2.yaml;
# shown here in the older log4j 1 properties style
log4j.logger.kafka.authorizer.logger=INFO, authorizerAppender
log4j.additivity.kafka.authorizer.logger=false
log4j.appender.authorizerAppender=org.apache.log4j.DailyRollingFileAppender
log4j.appender.authorizerAppender.file=/var/log/kafka/kafka-authorizer.log
```

## إعداد أمن Spring Kafka

```java
@Configuration
public class KafkaSecurityConfig {

    @Value("${kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Value("${kafka.ssl.keystore-location}")
    private String keystoreLocation;

    @Value("${kafka.ssl.keystore-password}")
    private String keystorePassword;

    @Value("${kafka.ssl.truststore-location}")
    private String truststoreLocation;

    @Value("${kafka.ssl.truststore-password}")
    private String truststorePassword;

    @Bean
    public Map<String, Object> commonKafkaProperties() {
        Map<String, Object> props = new HashMap<>();
        props.put(CommonClientConfigs.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(CommonClientConfigs.SECURITY_PROTOCOL_CONFIG, "SASL_SSL");
        props.put(SaslConfigs.SASL_MECHANISM, "SCRAM-SHA-512");
        props.put(SaslConfigs.SASL_JAAS_CONFIG,
                "org.apache.kafka.common.security.scram.ScramLoginModule required " +
                "username=\"payment-service\" " +
                "password=\"" + System.getenv("KAFKA_PASSWORD") + "\";");
        props.put(SslConfigs.SSL_TRUSTSTORE_LOCATION_CONFIG, truststoreLocation);
        props.put(SslConfigs.SSL_TRUSTSTORE_PASSWORD_CONFIG, truststorePassword);
        props.put(SslConfigs.SSL_KEYSTORE_LOCATION_CONFIG, keystoreLocation);
        props.put(SslConfigs.SSL_KEYSTORE_PASSWORD_CONFIG, keystorePassword);
        props.put(SslConfigs.SSL_ENDPOINT_IDENTIFICATION_ALGORITHM_CONFIG, "https");
        return props;
    }

    @Bean
    public ProducerFactory<String, String> producerFactory() {
        Map<String, Object> config = new HashMap<>(commonKafkaProperties());
        config.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        config.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        return new DefaultKafkaProducerFactory<>(config);
    }

    @Bean
    public ConsumerFactory<String, String> consumerFactory() {
        Map<String, Object> config = new HashMap<>(commonKafkaProperties());
        config.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-service");
        config.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        config.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        return new DefaultKafkaConsumerFactory<>(config);
    }
}
```

## الخلاصات الأساسية

- يتطلب أمن Kafka ثلاث طبقات مستقلة: **TLS** (التشفير أثناء النقل)، و**SASL/mTLS** (المصادقة)، و**ACL** (التفويض).
- استخدم **mTLS** للمصادقة بين الخدمات حيث يمكن — فهو يلغي إدارة كلمات المرور.
- **‏SASL/SCRAM-SHA-512** الآلية الموصى بها للخدمات المصغّرة — بيانات الاعتماد مخزنة في Kafka كتجزئات مملّحة، لا بنص واضح.
- **‏SASL/OAUTHBEARER** يتكامل مع مزودي الهوية — المعيار الحديث.
- يجب أن تتبع ACL مبدأ أقل الصلاحيات — كل خدمة تحصل فقط على العمليات التي تحتاجها على المواضيع المحددة التي تملكها.
- يتطلب تدوير الشهادات بالتحديثات المتدحرجة أن تثق كل مخازن الثقة بجهتي الإصدار القديمة والجديدة في آن واحد.
- يتطلب PCI DSS ‏TLS 1.2+، ولا بيانات اعتماد افتراضية، وتحكمًا في الوصول قائمًا على ACL، وسجل تدقيق لقرارات التفويض.
- لا تلتزم أبدًا ببيانات اعتماد Kafka في التحكم بالمصدر — استخدم متغيرات البيئة، أو أسرار Kubernetes، أو Vault.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما طبقات الأمن الثلاث المستقلة التي يجب إعدادها كلها لعنقود Kafka مالي إنتاجي؟",
      "options": [
        "التشفير، والضغط، والنسخ",
        "‏TLS (التشفير)، وSASL/mTLS (المصادقة)، وACL (التفويض)",
        "الجدران النارية، والشبكات الافتراضية الخاصة، وبوابات API",
        "‏RBAC، وABAC، وPBAC"
      ],
      "correct": 1,
      "explanation": "يتطلب أمن Kafka ثلاث طبقات مستقلة: TLS لتشفير البيانات أثناء النقل، وSASL أو mTLS لمصادقة من يتصل، وACL لتفويض ما يُسمح للهوية المصادق عليها بفعله. ويجب إعداد الثلاث — فغياب أي منها يترك ثغرة أمنية."
    },
    {
      "text": "ما ميزة SASL/SCRAM-SHA-512 على SASL/PLAIN لمصادقة الخدمات المصغّرة؟",
      "options": [
        "‏SCRAM أسرع من PLAIN بسبب جولات أقل",
        "يوفر SCRAM بروتوكول تحدٍّ واستجابة لا تُرسل فيه بيانات الاعتماد بنص واضح أبدًا، حتى مع TLS",
        "لا يتطلب SCRAM ‏TLS بينما يتطلبه PLAIN",
        "يلغي SCRAM الحاجة إلى ACL لأن كل مستخدم مصادق عليه أصلًا"
      ],
      "correct": 1,
      "explanation": "يرسل SASL/PLAIN كلمة المرور نفسها (معتمدًا على TLS للحماية). أما SASL/SCRAM فيستخدم آلية تحدٍّ واستجابة لا تُرسل فيها كلمة المرور أبدًا — بل برهان مملّح فقط — ويخزن الوسيط تجزئات مملّحة فقط. وهذا يعطي دفاعًا متعدد الطبقات حتى لو اختُرق TLS. (ويمكن أيضًا تدوير بيانات اعتماد SCRAM أثناء التشغيل. ولا تحل المصادقة أبدًا محل ACL: فهي تحدد ما يُسمح للمستخدم المصادق عليه بفعله.)"
    },
    {
      "text": "ما الإجراء الصحيح لتدوير الشهادات المتدحرج على عنقود Kafka دون توقف؟",
      "options": [
        "استبدل كل الشهادات في آن واحد خلال نافذة صيانة",
        "أضف جهة الإصدار الجديدة إلى مخازن الثقة أولًا، ثم دوّر مخازن مفاتيح الوسطاء، ثم مخازن مفاتيح العملاء، ثم أزل جهة الإصدار القديمة",
        "ولّد شهادات جديدة وأعد تشغيل كل الوسطاء والعملاء في آن واحد",
        "استخدم SASL أثناء فترة التدوير لتجاوز المصادقة بالشهادات"
      ],
      "correct": 1,
      "explanation": "يتطلب التدوير دون توقف أن تثق مخازن الثقة بجهتي الإصدار القديمة والجديدة في آن واحد أثناء الانتقال. فأضف أولًا جهة الإصدار الجديدة إلى كل مخازن الثقة، ثم دوّر مخازن مفاتيح الوسطاء (موقّعة من الجهة الجديدة)، ثم دوّر مخازن مفاتيح العملاء، وأخيرًا أزل جهة الإصدار القديمة من مخازن الثقة بعد تحديث كل الشهادات."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تأمين عنقود Kafka إنتاجي للامتثال لـ PCI DSS",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "اضبط وسطاء Kafka بمستمع SASL_SSL (المنفذ 9094) باستخدام SASL/SCRAM-SHA-512. وأنشئ بيانات اعتماد SCRAM لـ payment-service، وsettlement-service، وnotification-service باستخدام kafka-configs.sh. واضبط خدمات Spring Boot ببروتوكول الأمن SASL_SSL وآلية SCRAM-SHA-512 مع قراءة كلمات المرور من متغيرات البيئة."},
    {"id": "2", "description": "اضبط ACL تطبق مبدأ أقل الصلاحيات: تحصل payment-service على WRITE+DESCRIBE على 'payments.events'، وتحصل settlement-service على READ+DESCRIBE على 'payments.events' وREAD على مجموعة مستهلكيها، وتحصل notification-service على READ+DESCRIBE على 'payments.events'. وتحقق من عدم امتلاك أي خدمة وصول WRITE بحرف بدل."},
    {"id": "3", "description": "فعّل سجل تفويض Kafka باستخدام StandardAuthorizer في KRaft ووجّه قرارات التفويض إلى ملف kafka-authorizer.log مخصص. ونفّذ مراقب انتهاء صلاحية الشهادات يفحص مخازن المفاتيح يوميًا ويرسل تنبيهات بخطورة HIGH حين تنتهي صلاحية أي شهادة خلال 30 يومًا."},
    {"id": "4", "description": "وثّق ونفّذ إجراء تدوير الشهادات المتدحرج من أربع مراحل: (1) إضافة جهة الإصدار الجديدة إلى كل مخازن الثقة، (2) استبدال متدحرج لمخازن مفاتيح الوسطاء، (3) استبدال متدحرج لمخازن مفاتيح العملاء، (4) إزالة جهة الإصدار القديمة. واختبر الإجراء في بيئة staging وتحقق من عدم انقطاع أي مجموعة مستهلكين أثناء التدوير."}
  ]
}
-->
