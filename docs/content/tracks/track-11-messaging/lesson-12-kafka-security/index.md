---
id: track-11-lesson-12
title: "Kafka Security — TLS, SASL, and ACLs"
slug: kafka-security
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 12
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Kafka, TLS, SASL, ACL, mTLS]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
---

# Kafka Security — TLS, SASL, and ACLs

> [!NOTE]
> Kafka processes payment data, account events, and transaction streams — all categories requiring strict access control under PCI DSS, GDPR, and FCA regulations. A misconfigured Kafka cluster can expose financial data to any service on the network or allow a compromised service to publish fraudulent payment events. Security is not a post-launch concern — it must be designed into the architecture from day one.

## Kafka Security Layers

Kafka has three independent security layers that work together:

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

All three must be configured for a production financial Kafka cluster.

---

## TLS Configuration

TLS encrypts traffic between clients and brokers, and between brokers in a cluster.

### Generate Certificates (Production)

In production, use your organisation's PKI or a managed CA (AWS ACM, Vault PKI). For reference, the manual process:

```bash
# 1. Create a CA (do this once per environment)
keytool -genkeypair -keyalg RSA -keysize 2048 \
    -alias ca -keystore ca.jks \
    -dname "CN=Kafka-CA, OU=Fintech, O=Payments Ltd, C=GB" \
    -validity 3650

# 2. Create broker keystore
keytool -genkeypair -keyalg RSA -keysize 2048 \
    -alias broker1 -keystore broker1.jks \
    -dname "CN=broker1.kafka.internal, OU=Kafka, O=Payments Ltd, C=GB"

# 3. Sign broker cert with CA
keytool -certreq -alias broker1 -keystore broker1.jks -file broker1.csr
keytool -gencert -alias ca -keystore ca.jks \
    -infile broker1.csr -outfile broker1.crt -validity 365

# 4. Import CA cert and signed cert into broker keystore
keytool -importcert -alias ca -keystore broker1.jks -file ca.crt
keytool -importcert -alias broker1 -keystore broker1.jks -file broker1.crt

# 5. Create client truststore with CA cert
keytool -importcert -alias ca -keystore client.truststore.jks -file ca.crt
```

### Broker TLS Configuration

```properties
# server.properties
listeners=PLAINTEXT://localhost:9092,SSL://localhost:9093
advertised.listeners=PLAINTEXT://broker1:9092,SSL://broker1:9093

ssl.keystore.location=/etc/kafka/ssl/broker1.jks
ssl.keystore.password=keystore-secret
ssl.key.password=key-secret
ssl.truststore.location=/etc/kafka/ssl/ca.truststore.jks
ssl.truststore.password=truststore-secret

# Require TLS 1.2 minimum
ssl.enabled.protocols=TLSv1.2,TLSv1.3
ssl.protocol=TLSv1.3

# Cipher suites — restrict to strong ciphers
ssl.cipher.suites=TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256
```

### Client TLS Configuration (Java)

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
        // Verifies that broker hostname matches cert CN/SAN — prevents MITM attacks

        return props;
    }
}
```

---

## mTLS for Service-to-Service Authentication

Mutual TLS (mTLS) means both the broker and the client present certificates. The broker verifies the client's certificate against the truststore — authentication without passwords.

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

**mTLS identity:** The broker extracts the client identity from the certificate CN. For example, a certificate with `CN=payment-service` authenticates as `User:CN=payment-service,OU=Services,O=Payments Ltd,C=GB`. This identity is used in ACL rules.

---

## SASL Authentication Mechanisms

SASL (Simple Authentication and Security Layer) provides username/password and token-based authentication. Use different mechanisms for different client types.

### SASL/PLAIN (Internal Services — Simple)

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

### SASL/SCRAM-SHA-512 (Microservices — Recommended)

SCRAM provides a challenge-response protocol — credentials are never sent in plaintext, even with TLS.

```bash
# Create SCRAM credentials in ZooKeeper / KRaft
kafka-configs.sh --bootstrap-server broker1:9092 \
    --alter --add-config "SCRAM-SHA-512=[password=payment-secret]" \
    --entity-type users --entity-name payment-service

kafka-configs.sh --bootstrap-server broker1:9092 \
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

### SASL/OAUTHBEARER (Kubernetes — Modern)

OAuth Bearer tokens integrate with Kubernetes service accounts and identity providers (Keycloak, AWS IAM, Azure AD):

```java
// Spring Boot OAUTHBEARER configuration
props.put("security.protocol", "SASL_SSL");
props.put("sasl.mechanism", "OAUTHBEARER");
props.put("sasl.login.callback.handler.class",
    "org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginCallbackHandler");
props.put("sasl.jaas.config",
    "org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required " +
    "oauth.token.endpoint.uri=\"https://keycloak:8080/realms/fintech/protocol/openid-connect/token\" " +
    "oauth.client.id=\"kafka-payment-service\" " +
    "oauth.client.secret=\"${OAUTH_CLIENT_SECRET}\";");
```

---

## ACL Configuration

Access Control Lists (ACLs) grant/deny specific operations to specific identities on specific resources.

### ACL Operations

| Operation | Applies To | Description |
|-----------|-----------|-------------|
| `READ` | Topic | Consume from topic |
| `WRITE` | Topic | Produce to topic |
| `CREATE` | Topic/Cluster | Create topics |
| `DELETE` | Topic | Delete topics |
| `DESCRIBE` | Topic | Fetch metadata |
| `DESCRIBE_CONFIGS` | Topic | Read configuration |
| `ALTER` | Topic/Cluster | Modify configuration |
| `ALL` | Any | All operations |

### Setting ACLs for Payment Services

```bash
# payment-service: can WRITE to payments.events (producer)
kafka-acls.sh --bootstrap-server broker1:9092 \
    --add --allow-principal User:payment-service \
    --operation WRITE --operation DESCRIBE \
    --topic payments.events

# settlement-service: can READ from payments.events (consumer)
kafka-acls.sh --bootstrap-server broker1:9092 \
    --add --allow-principal User:settlement-service \
    --operation READ --operation DESCRIBE \
    --topic payments.events \
    --group settlement-service-group

# notification-service: can READ from payments.events
kafka-acls.sh --bootstrap-server broker1:9092 \
    --add --allow-principal User:notification-service \
    --operation READ --operation DESCRIBE \
    --topic payments.events \
    --group notification-service-group

# schema-registry: needs WRITE on _schemas topic
kafka-acls.sh --bootstrap-server broker1:9092 \
    --add --allow-principal User:schema-registry \
    --operation ALL --topic _schemas

# admin user: can describe all topics (monitoring)
kafka-acls.sh --bootstrap-server broker1:9092 \
    --add --allow-principal User:monitoring-service \
    --operation DESCRIBE --topic '*'
```

### ACL Management via Java AdminClient

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

---

## Certificate Rotation Without Downtime

Kafka supports rolling certificate rotation with no downtime:

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

---

## PCI DSS Kafka Security Requirements

For payment card industry compliance:

```
PCI DSS Requirement 2 (Default Credentials):
  ✓ No default Kafka admin credentials in production
  ✓ SCRAM-SHA-512 or mTLS — no SASL/PLAIN in production

PCI DSS Requirement 4 (Data in Transit):
  ✓ TLS 1.2+ for all Kafka traffic
  ✓ No PLAINTEXT listener exposed
  ✓ Strong cipher suites only (AES-256)

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

### Enable Audit Logging

```properties
# Broker: log all authorisation decisions
authorizer.class.name=kafka.security.authorizer.AclAuthorizer
# or for KRaft:
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer

# Log to separate audit log file
log4j.logger.kafka.authorizer.logger=INFO, authorizerAppender
log4j.additivity.kafka.authorizer.logger=false
log4j.appender.authorizerAppender=org.apache.log4j.DailyRollingFileAppender
log4j.appender.authorizerAppender.file=/var/log/kafka/kafka-authorizer.log
```

---

## Spring Kafka Security Configuration

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

---

## Key Takeaways

- Kafka security requires three independent layers: **TLS** (encryption in transit), **SASL/mTLS** (authentication), **ACLs** (authorisation).
- Use **mTLS** for service-to-service authentication where possible — eliminates password management.
- **SASL/SCRAM-SHA-512** is the recommended mechanism for microservices — credentials stored in Kafka, never in plaintext.
- **SASL/OAUTHBEARER** integrates with Kubernetes service accounts and identity providers — the modern standard.
- ACLs should follow least privilege — each service gets only the operations it needs on the specific topics it owns.
- Certificate rotation with rolling updates requires all truststores to trust both old and new CAs simultaneously.
- PCI DSS requires TLS 1.2+, no default credentials, ACL-based access control, and audit logging of authorisation decisions.
- Never commit Kafka credentials to source control — use environment variables, Kubernetes Secrets, or Vault.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What are the three independent security layers that must all be configured for a production financial Kafka cluster?",
      "options": [
        "Encryption, Compression, and Replication",
        "TLS (encryption), SASL/mTLS (authentication), and ACLs (authorisation)",
        "Firewalls, VPNs, and API gateways",
        "RBAC, ABAC, and PBAC"
      ],
      "correct": 1,
      "explanation": "Kafka security requires three independent layers: TLS for encrypting data in transit, SASL or mTLS for authenticating who is connecting, and ACLs for authorising what the authenticated identity is allowed to do. All three must be configured — any one missing leaves a security gap."
    },
    {
      "text": "What is the advantage of SASL/SCRAM-SHA-512 over SASL/PLAIN for microservice authentication?",
      "options": [
        "SCRAM is faster than PLAIN due to fewer round trips",
        "SCRAM provides a challenge-response protocol where credentials are never sent in plaintext, even with TLS",
        "SCRAM does not require TLS while PLAIN does",
        "SCRAM allows password rotation without broker restart"
      ],
      "correct": 1,
      "explanation": "SASL/PLAIN sends credentials in plaintext (relying on TLS for protection). SASL/SCRAM uses a challenge-response mechanism where the actual password is never transmitted — only a salted hash proof. This provides defense-in-depth even if TLS is somehow compromised."
    },
    {
      "text": "What is the correct procedure for rolling certificate rotation on a Kafka cluster without downtime?",
      "options": [
        "Replace all certificates simultaneously during a maintenance window",
        "Add new CA to truststores first, then roll broker keystores, then roll client keystores, then remove old CA",
        "Generate new certificates and restart all brokers and clients simultaneously",
        "Use SASL during the rotation period to bypass certificate authentication"
      ],
      "correct": 1,
      "explanation": "Zero-downtime rotation requires that truststores trust both old and new CAs simultaneously during the transition. First add the new CA to all truststores, then roll broker keystores (new CA signed), then roll client keystores, and finally remove the old CA from truststores once all certificates are updated."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Secure a Production Kafka Cluster for PCI DSS Compliance",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Configure Kafka brokers with SASL_SSL listener (port 9094) using SASL/SCRAM-SHA-512. Create SCRAM credentials for payment-service, settlement-service, and notification-service using kafka-configs.sh. Configure Spring Boot services with SASL_SSL security protocol and SCRAM-SHA-512 mechanism reading passwords from environment variables."},
    {"id": "2", "description": "Set up ACLs implementing least privilege: payment-service gets WRITE+DESCRIBE on 'payments.events', settlement-service gets READ+DESCRIBE on 'payments.events' and READ on its consumer group, notification-service gets READ+DESCRIBE on 'payments.events'. Verify no service has wildcard WRITE access."},
    {"id": "3", "description": "Enable Kafka authorisation logging by configuring AclAuthorizer and routing authorisation decisions to a dedicated kafka-authorizer.log file. Implement a certificate expiry monitor that checks keystores daily and sends HIGH severity alerts when any certificate expires within 30 days."},
    {"id": "4", "description": "Document and implement the four-phase rolling certificate rotation procedure: (1) add new CA to all truststores, (2) rolling broker keystore replacement, (3) rolling client keystore replacement, (4) remove old CA. Test the procedure in a staging environment and verify zero consumer group disconnections during rotation."}
  ]
}
-->
