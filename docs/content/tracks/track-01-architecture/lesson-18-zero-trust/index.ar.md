---
id: track-01-lesson-18
title: "بنية الأمان القائمة على انعدام الثقة (Zero Trust)"
slug: zero-trust-architecture
track: track-01
trackName: "البنية المعمارية المتقدمة للبرمجيات"
sequence: 18
difficulty: advanced
estimatedMinutes: 80
status: published
tags:
  - zero-trust
  - mTLS
  - SPIFFE
  - SPIRE
  - Vault
  - service-mesh
  - NetworkPolicy
---

# بنية الأمان القائمة على انعدام الثقة (Zero Trust)

يفترض أمن الشبكات التقليدي أن كل ما داخل محيط المؤسسة موثوق. أما في بيئة خدمات مصغّرة مالية سحابية أصيلة، فلا يوجد محيط. يعلّمك هذا الدرس تصميم بنية انعدام الثقة وتنفيذها باستخدام هوية أحمال العمل عبر SPIFFE/SPIRE، وmTLS، وبيانات الاعتماد الديناميكية من Vault، وNetworkPolicy في Kubernetes، وAuthorizationPolicy في Istio — مع ربط صريح بمتطلبات PCI-DSS.

---

## 1. المبدأ الأساسي: لا تثق أبدًا، تحقق دائمًا

انعدام الثقة نموذج أمني، لا منتج. ويقوم على ثلاث بديهيات:

1. **لا ثقة ضمنية** — الخدمة داخل العنقود لا تملك ثقة متأصلة أكثر من طلب قادم من الإنترنت العام
2. **أقل الصلاحيات** — كل حمل عمل يحصل فقط على الصلاحيات التي يحتاجها، وفقط للمدة التي يحتاجها
3. **التحقق المستمر** — تُعاد مراجعة الهوية والتفويض في كل طلب، لا عند تسجيل الدخول فقط

مطبّقًا على الخدمات المصغّرة المالية:

```
  TRADITIONAL PERIMETER MODEL            ZERO-TRUST MODEL
  ═══════════════════════════            ════════════════

  ┌──────────────────────────┐           Every hop is authenticated
  │   TRUSTED ZONE           │
  │  ┌────┐  ┌────┐  ┌────┐ │           payment-svc ──mTLS──► ledger-svc
  │  │ A  │  │ B  │  │ C  │ │                │                      │
  │  └────┘  └────┘  └────┘ │           SVID cert             SVID cert
  │   ↑ trusted by default   │           verified              verified
  └──────────────────────────┘
  │                          │           NetworkPolicy: deny all
  Firewall: deny outside     │           AuthzPolicy: allow only
            allow inside     │           payment-svc→ledger-svc on /v1/entries
```

يعامل نموذج انعدام الثقة كل استدعاء بين الخدمات كأنه عدائي محتمل، ويتطلب إثباتًا تشفيريًا للهوية قبل السماح بأي تواصل.

---

## 2. هوية أحمال العمل عبر SPIFFE/SPIRE

### 2.1 ما هو SPIFFE

‏SPIFFE ‏(Secure Production Identity Framework for Everyone) معيار من CNCF يعرّف:

- **معرّف SPIFFE** — رابط بالصيغة `spiffe://trust-domain/path` يحدد حمل العمل بشكل فريد
- **وثيقة SVID** ‏(SPIFFE Verifiable Identity Document) — شهادة X.509 أو JWT تحمل معرّف SPIFFE
- **حزمة SPIFFE** — حزمة الثقة (سلطة الشهادات الجذرية والوسيطة) المستخدمة للتحقق من وثائق SVID

```
  spiffe://fintech.internal/ns/payments/sa/payment-svc
  └───────────────────────────────────────────────────
  scheme  trust domain     path (namespace/serviceaccount/name)
```

### 2.2 بنية SPIRE

‏SPIRE ‏(SPIFFE Runtime Environment) هو التنفيذ المرجعي:

```
  ┌─────────────────────────────────────────────────────────┐
  │  Kubernetes Cluster                                       │
  │                                                           │
  │  ┌────────────────┐        ┌──────────────────────────┐  │
  │  │  SPIRE Server   │        │  Node (each node)         │  │
  │  │                │        │  ┌────────────────────┐   │  │
  │  │  - CA root     │◄──────►│  │  SPIRE Agent        │   │  │
  │  │  - Registration│        │  │  - node attestation │   │  │
  │  │    entries     │        │  │  - workload API     │   │  │
  │  │  - JWT SVID    │        │  │  - certificate mgmt │   │  │
  │  │    minting     │        │  └───────────┬─────────┘   │  │
  │  └────────────────┘        │              │Unix socket   │  │
  │                            │  ┌───────────▼──────────┐  │  │
  │                            │  │  Workload Pod         │  │  │
  │                            │  │  (payment-svc)        │  │  │
  │                            │  │  → fetches SVID via   │  │  │
  │                            │  │    workload API       │  │  │
  │                            │  └──────────────────────┘  │  │
  │                            └──────────────────────────┘  │  │
  └─────────────────────────────────────────────────────────┘
```

### 2.3 إصدار SVID والتدوير بناءً على مدة الصلاحية

وثائق SVID قصيرة العمر (مدة الصلاحية الافتراضية ساعة). وتدوّرها وكلاء SPIRE تلقائيًا قبل انتهائها، فيبقى نطاق أثر أي بيانات اعتماد مخترقة صغيرًا.

```java
/**
 * Fetches this workload's X.509 SVID from the SPIRE Agent's Workload API
 * (Unix domain socket) using the java-spiffe library.
 * With Istio, Envoy does this for you; use it directly for workloads
 * without a sidecar.
 */
@Component
public class SpiffeIdentityLoader implements DisposableBean {

    private static final String SPIRE_SOCKET = "unix:/run/spire/sockets/agent.sock";

    private final X509Source source;

    public SpiffeIdentityLoader() throws Exception {
        // DefaultX509Source watches the Workload API and swaps in each
        // rotated SVID automatically — no rotation loop of our own
        this.source = DefaultX509Source.newSource(
            X509SourceOptions.builder().spiffeSocketPath(SPIRE_SOCKET).build());
    }

    public X509Certificate currentCertificate() {
        return source.getX509Svid().getLeaf();
    }

    /** TLS context whose key and trust managers follow every rotation. */
    public SSLContext sslContextForLedgerCalls() throws Exception {
        return SpiffeSslContextFactory.getSslContext(SslContextOptions.builder()
            .x509Source(source)
            // Zero trust: accept only the peer we expect, not any SPIFFE ID
            .acceptedSpiffeIdsSupplier(() -> Set.of(
                SpiffeId.parse("spiffe://fintech.internal/ns/payments/sa/ledger-svc")))
            .build());
    }

    @Override
    public void destroy() {
        source.close();
    }
}
```

يراقب `DefaultX509Source` واجهة أحمال العمل ويستبدل كل SVID مدوّرة تلقائيًا، فلا حاجة لحلقة تدوير خاصة بك. ويقبل سياق TLS النظير المتوقع فقط، لا أي معرّف SPIFFE.

```yaml
# SPIRE Server registration entry for payment-svc
# Applied via spire-server CLI or k8s controller
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: payment-svc-identity
spec:
  spiffeIDTemplate: >-
    spiffe://fintech.internal/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}
  podSelector:
    matchLabels:
      app: payment-svc
  ttl: 1h
```

---

## 3. mTLS بين الخدمات

### 3.1 نظرة عامة على mTLS

يعني TLS المتبادل أن طرفي الاتصال يقدّمان شهادة X.509 ويتحققان منها. وهذا يوفر:

- **المصادقة** — يثبت كل طرف هويته تشفيريًا
- **التشفير** — كل الحركة مشفرة أثناء النقل
- **قابلية التدقيق** — كل اتصال يحمل هوية حمل عمل قابلة للتحقق ويمكن تسجيلها

```
  payment-svc (client)              ledger-svc (server)
       │                                    │
       │── ClientHello ──────────────────►  │
       │◄─ ServerHello + Certificate ──────  │
       │── Certificate (client SVID) ──────► │
       │── CertificateVerify ──────────────► │
       │◄─ Finished ────────────────────────  │
       │                                    │
       │   Both sides hold SPIFFE SVIDs     │
       │   issued by the same trust domain  │
```

### 3.2 إعدادات mTLS في Istio

```yaml
# Enable STRICT mTLS for the payments namespace
# This rejects any plain-text (non-mTLS) communication
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payments
spec:
  mtls:
    mode: STRICT
---
# PERMISSIVE mode for a single service during migration
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: fraud-svc-permissive
  namespace: payments
spec:
  selector:
    matchLabels:
      app: fraud-svc
  mtls:
    mode: PERMISSIVE   # Allow plain-text while migrating
```

### 3.3 دورة حياة الشهادة

```
  SPIRE Agent                Envoy Sidecar             Upstream Service
      │                           │                           │
      │── SVID (X.509, 1h TTL) ──►│                           │
      │                           │── mTLS handshake ────────►│
      │                           │◄─ peer SVID verified ─────│
      │                           │                           │
      │  At T=30m (half the TTL), │                           │
      │  SPIRE Agent rotates:     │                           │
      │── new SVID ──────────────►│  hot-reload, no downtime  │
```

يلتقط الوكيل الجانبي Envoy في Istio الشهادة الجديدة تلقائيًا (عبر SDS) دون انقطاع الاتصالات.

> [!NOTE]
> افتراضيًا، يُصدر Istio شهادات أحمال العمل من سلطة الشهادات الخاصة بـ istiod بنطاق الثقة `cluster.local`؛ ويمكن بدلًا من ذلك دمجه مع SPIRE. وأيًا كان ما تستخدمه، يجب أن تستخدم الهويات (principals) في `AuthorizationPolicy` نطاق الثقة نفسه الذي في الشهادات (`cluster.local/ns/...` أدناه، أو `fintech.internal/ns/...` مع نطاق ثقة SPIRE).

---

## 4. بيانات الاعتماد الديناميكية من HashiCorp Vault

### 4.1 لماذا تهم بيانات الاعتماد الديناميكية

كلمات مرور قواعد البيانات الثابتة المضمّنة في متغيرات البيئة أو أسرار Kubernetes صعبة التدوير، وغالبًا مشتركة، وملاحظة تدقيق متكررة (يتوقع المتطلب 8.6 في PCI DSS v4.0 إدارة بيانات اعتماد حسابات التطبيقات والأنظمة وتغييرها). ويُصدر محرك أسرار قواعد البيانات في Vault بيانات اعتماد قصيرة العمر وفريدة لكل حمل عمل.

```
  payment-svc Pod                  Vault Server              PostgreSQL
       │                               │                         │
       │── Vault login (K8s SA token) ►│                         │
       │◄─ Vault token (30-min TTL) ───│                         │
       │                               │                         │
       │── GET /db/creds/payment-role ►│                         │
       │                               │── CREATE USER payment_  │
       │                               │   _abc123 PASSWORD...──►│
       │◄─ username: payment_abc123 ───│                         │
       │   password: <64-char random>  │                         │
       │   TTL: 15m                    │                         │
       │                               │                         │
       │  connects with dynamic creds  │                         │
       │──────────────────────────────────────────────────────► │
```

### 4.2 إعدادات Vault

```hcl
# vault policy for payment-svc
path "database/creds/payment-db-role" {
  capabilities = ["read"]
}

path "auth/kubernetes/login" {
  capabilities = ["create"]
}
```

```bash
# Configure the database secrets engine
vault secrets enable database

vault write database/config/payments-postgres \
    plugin_name=postgresql-database-plugin \
    allowed_roles="payment-db-role" \
    connection_url="postgresql://{{username}}:{{password}}@postgres:5432/payments" \
    username="vault_root" \
    password="$ROOT_PASS"

vault write database/roles/payment-db-role \
    db_name=payments-postgres \
    creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' \
        VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE ON ALL TABLES \
        IN SCHEMA payments TO \"{{name}}\";" \
    default_ttl="15m" \
    max_ttl="1h"
```

### 4.3 التكامل مع Spring Boot عبر Vault Agent

```hcl
# vault-agent-config.hcl (runs as a sidecar so it can keep renewing the lease)
auto_auth {
  method "kubernetes" {
    mount_path = "auth/kubernetes"
    config = {
      role = "payment-svc"
    }
  }
}

template {
  destination = "/vault/secrets/database.properties"
  contents = <<EOT
spring.datasource.username={{ with secret "database/creds/payment-db-role" }}{{ .Data.username }}{{ end }}
spring.datasource.password={{ with secret "database/creds/payment-db-role" }}{{ .Data.password }}{{ end }}
EOT
  error_on_missing_key = true
}
```

```java
// Spring Boot picks up the rendered file via spring.config.import
// application.yml:
//   spring:
//     config:
//       import: "optional:file:/vault/secrets/database.properties"
//
// Caution: Spring reads this file ONCE, at startup. Vault renews the lease
// (same username/password) until max_ttl; after that Vault issues NEW
// credentials that this pool would never see. Either use Spring Cloud Vault
// (it renews leases and emits SecretLeaseCreatedEvent — push the new
// credentials into Hikari via HikariConfigMXBean), or roll the pods before
// max_ttl.
@Configuration
public class DatasourceConfig {

    @Bean
    public DataSource dataSource(
            @Value("${spring.datasource.url}") String url,
            @Value("${spring.datasource.username}") String user,
            @Value("${spring.datasource.password}") String pass) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(url);
        config.setUsername(user);
        config.setPassword(pass);
        // Recycle connections well before the credential lease ends
        config.setMaxLifetime(Duration.ofMinutes(14).toMillis()); // < 15m default_ttl
        return new HikariDataSource(config);
    }
}
```

انتبه: يقرأ Spring الملف المولّد مرة واحدة فقط عند البدء. ويجدد Vault عقد الإيجار (اسم المستخدم وكلمة المرور نفسيهما) حتى `max_ttl`؛ وبعدها يُصدر بيانات اعتماد جديدة لن يراها هذا المجمّع أبدًا. فإما أن تستخدم Spring Cloud Vault (يجدد العقود ويطلق `SecretLeaseCreatedEvent` فتمرر البيانات الجديدة إلى Hikari عبر `HikariConfigMXBean`)، أو تعيد تشغيل الـ pods تدريجيًا قبل `max_ttl`.

---

## 5. NetworkPolicy في Kubernetes: الرفض الافتراضي كأساس

### 5.1 رفض كل شيء افتراضيًا

تستطيع الـ pods في Kubernetes الوصول إلى أي pod آخر افتراضيًا. والخطوة الأولى في شبكات انعدام الثقة هي رفض كل الحركة الواردة والصادرة، ثم السماح انتقائيًا.

```yaml
# Apply this to every namespace before anything else
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: payments
spec:
  podSelector: {}      # Applies to ALL pods in namespace
  policyTypes:
    - Ingress
    - Egress
```

### 5.2 قواعد السماح الانتقائية

```yaml
# Allow payment-svc to reach ledger-svc on port 8080
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-svc-to-ledger
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: ledger-svc
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: payment-svc
      ports:
        - protocol: TCP
          port: 8080
---
# Allow payment-svc egress to: ledger-svc, vault, DNS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-svc-egress
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-svc
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: ledger-svc
      ports:
        - port: 8080
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: vault
      ports:
        - port: 8200
    - ports:                 # DNS (kube-dns)
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

### 5.3 عزل مساحات الأسماء

```yaml
# Prevent cross-namespace traffic between payments and fraud
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-cross-ns
  namespace: payments
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: payments
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: api-gateway
```

---

## 6. AuthorizationPolicy في Istio: فرض JWT وmTLS

### 6.1 سياسة الطبقة السابعة

تعمل NetworkPolicy في الطبقة الرابعة (عنوان IP والمنفذ). أما AuthorizationPolicy في Istio فتعمل في الطبقة السابعة (فعل HTTP، والمسار، والترويسات، ومطالبات JWT).

```yaml
# Only payment-svc may POST to /v1/entries on ledger-svc
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: ledger-svc-authz
  namespace: payments
spec:
  selector:
    matchLabels:
      app: ledger-svc
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/payments/sa/payment-svc"
      to:
        - operation:
            methods: ["POST"]
            paths: ["/v1/entries"]
---
# An ALLOW policy already denies every request it does not match. This DENY
# additionally rejects any request without an mTLS identity, even if a broader
# ALLOW policy is added later by mistake.
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: ledger-svc-deny-all
  namespace: payments
spec:
  selector:
    matchLabels:
      app: ledger-svc
  action: DENY
  rules:
    - from:
        - source:
            notPrincipals: ["*"]
```

سياسة ALLOW ترفض بالفعل كل طلب لا تطابقه. وسياسة DENY الإضافية ترفض أي طلب بلا هوية mTLS، حتى لو أُضيفت لاحقًا بالخطأ سياسة ALLOW أوسع.

### 6.2 التحقق من JWT

```yaml
# Require a valid JWT from the internal OIDC provider for external-facing APIs
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: payment-api-jwt
  namespace: payments
spec:
  selector:
    matchLabels:
      app: payment-svc
  jwtRules:
    - issuer: "https://auth.fintech.internal"
      jwksUri: "https://auth.fintech.internal/.well-known/jwks.json"
      audiences:
        - "payment-api"
      forwardOriginalToken: false
---
# Require the validated JWT to have scope=payment:write for mutations
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: payment-write-scope
  namespace: payments
spec:
  selector:
    matchLabels:
      app: payment-svc
  action: ALLOW
  rules:
    - when:
        - key: request.auth.claims[scope]
          values: ["payment:write"]
      to:
        - operation:
            methods: ["POST", "PUT", "PATCH", "DELETE"]
```

---

## 7. OPA/Rego للتفويض الدقيق

تتولى AuthorizationPolicy في Istio الوصول على مستوى عام. أما للتحكم في الوصول القائم على السمات (ABAC) — مثل "لا يستطيع الصرّاف الموافقة إلا على معاملات أقل من حده المعتمد" — فاستخدم OPA.

```rego
# policies/payment_authz.rego
package fintech.payment

import future.keywords.if
import future.keywords.in

default allow := false

# Teller can approve transactions up to their limit
allow if {
    input.action == "approve_transaction"
    input.user.role == "teller"
    input.transaction.amount_cents <= input.user.approval_limit_cents
}

# Operations team can approve any amount
allow if {
    input.action == "approve_transaction"
    input.user.role in {"operations", "risk_officer"}
}

# Fraud analyst can only read, not write
allow if {
    input.action in {"read_transaction", "flag_transaction"}
    input.user.role == "fraud_analyst"
}

# Deny transactions to sanctioned countries
deny if {
    input.action == "approve_transaction"
    input.transaction.destination_country in data.sanctioned_countries
}

# Final decision: allow unless explicitly denied
final_allow if {
    allow
    not deny
}
```

```java
@Component
public class OpaAuthorizationClient {

    private final WebClient opaClient;

    public OpaAuthorizationClient(@Value("${opa.url}") String opaUrl) {
        this.opaClient = WebClient.builder().baseUrl(opaUrl).build();
    }

    public boolean isAllowed(String action, User user, Transaction tx) {
        Map<String, Object> input = Map.of(
            "action", action,
            "user", Map.of(
                "role", user.getRole(),
                "approval_limit_cents", user.getApprovalLimitCents()
            ),
            "transaction", Map.of(
                "amount_cents", tx.getAmountCents(),
                "destination_country", tx.getDestinationCountry()
            )
        );

        OpaResponse response = opaClient.post()
            .uri("/v1/data/fintech/payment/final_allow")
            .bodyValue(Map.of("input", input))
            .retrieve()
            .bodyToMono(OpaResponse.class)
            .block(Duration.ofMillis(50)); // tight budget for auth check

        return Boolean.TRUE.equals(response != null ? response.getResult() : null);
    }
}
```

---

## 8. الربط بـ PCI-DSS

### 8.1 المتطلب 1 — عزل الشبكة

يفرض المتطلب 1 في PCI-DSS أن تكون أنظمة بيئة بيانات حامل البطاقة (CDE) معزولة عن الأنظمة خارجها.

| ضابط انعدام الثقة | الربط بالمتطلب 1 في PCI-DSS |
|---|---|
| ‏NetworkPolicy ‏`default-deny-all` في Kubernetes | المتطلب 1.3.1: تقييد الحركة الواردة على الضروري فقط |
| عزل مساحات الأسماء عبر `namespaceSelector` | المتطلب 1.3.2: تقييد الحركة الصادرة على الاتصالات الضرورية فقط |
| ‏mTLS بالوضع STRICT في مساحة أسماء CDE | يدعم العزل بمصادقة كل اتصال (المتطلب 4.2.1 نفسه يغطي الشبكات المفتوحة والعامة) |

### 8.2 المتطلبان 7 و8 — التحكم في الوصول والمصادقة

يفرض المتطلب 7 في PCI-DSS الوصول بأقل الصلاحيات؛ ويغطي المتطلب 8 التعريف والمصادقة، بما في ذلك حسابات التطبيقات والأنظمة.

| ضابط انعدام الثقة | الربط بـ PCI-DSS v4.0 |
|---|---|
| ‏SVID من SPIFFE لكل حمل عمل | المتطلب 8.6: تحديد حسابات التطبيقات والأنظمة وإدارتها — لكل حمل عمل هويته الخاصة |
| بيانات اعتماد Vault الديناميكية (صلاحية 15 دقيقة) | المتطلب 8.6.3: حماية كلمات مرور حسابات التطبيقات والأنظمة من سوء الاستخدام وتغييرها — هنا تنتهي تلقائيًا |
| ‏AuthorizationPolicy في Istio (بين الخدمات) | المتطلب 7.2.1 / 7.2.2: نموذج محدد للتحكم في الوصول، يمنح الوصول حيث يلزم فقط |
| سياسات ABAC في OPA | المتطلب 7.2.1: نموذج تحكم في الوصول يفرض أقل الصلاحيات للأشخاص (مثل حدود الموافقة) |

---

## 9. أخطاء شائعة في الإنتاج

### الخطأ 1: انتهاء شهادات mTLS أثناء ذروة الحركة

**السيناريو:** أصبح خادم SPIRE غير متاح خلال ذروة الجمعة السوداء. انقضت مدة صلاحية SVID (ساعة واحدة). فشلت كل الاستدعاءات بين الخدمات بأخطاء مصافحة TLS.

```java
// BAD: a single SPIRE Server and a 1-hour SVID TTL. Agents rotate at half the
// TTL, so a SPIRE Server outage of ~30 minutes starts expiring certificates.

// GOOD: give yourself headroom
//  - SPIRE Server HA: several replicas sharing an external datastore
//    (PostgreSQL or MySQL — not the default embedded SQLite)
//  - server.conf: default_x509_svid_ttl = "4h"  -> agents rotate at ~2h,
//    so an outage of up to ~2h is absorbed without a failed handshake
//  - alert on agent-to-server sync failures and on SVID age
```

**الحل:** شغّل خادم SPIRE بتوفر عالٍ (عدة نسخ تتشارك مخزن بيانات PostgreSQL أو MySQL). واضبط `default_x509_svid_ttl` في الخادم على 4 ساعات؛ فالوكلاء يدوّرون عند نصف المدة، فتتوفر نحو ساعتين لاستعادة الخادم. وراقب صحة الوكلاء ومزامنتهم مع الخادم.

### الخطأ 2: تقييم سياسات OPA يضيف زمنًا لكل طلب

**السيناريو:** يُستدعى OPA بشكل متزامن في كل طلب HTTP. وتحت الحمل يبلغ زمن p99 لاستجابة OPA ‏200ms، فتُنتهك اتفاقية 300ms لشبكة البطاقات.

```java
// BAD: Synchronous OPA call in request path
@GetMapping("/v1/payments/{id}")
public Payment getPayment(@PathVariable String id, Authentication auth) {
    if (!opaClient.isAllowed("read_payment", auth.getUser(), id)) {  // blocks 20-200ms
        throw new AccessDeniedException();
    }
    return paymentService.findById(id);
}

// GOOD: OPA bundle replication + local evaluation
// Run OPA as a sidecar with bundle.tar.gz replicated from OPA server.
// Local evaluation is <1 ms (in-process).
// Use OPA's bundle API to push policy updates without restarting pods.
```

**الحل:** انشر OPA كحاوية جانبية (`localhost:8181`) مع نسخ الحزم من خادم إدارة OPA مركزي. فتقييم Rego المحلي أقل من مللي ثانية. وتنتقل تحديثات السياسات عبر استطلاع الحزم (افتراضيًا كل 60 ثانية).

### الخطأ 3: NetworkPolicy تمنع تحليل DNS

**السيناريو:** طُبّق الرفض الافتراضي لكل شيء. ففشلت كل الـ pods فورًا في تحليل أسماء الخدمات. واستعلامات DNS إلى `kube-dns` على UDP/53 محجوبة.

```yaml
# BAD: Default-deny with no DNS egress exception
spec:
  podSelector: {}
  policyTypes:
    - Egress
  # No egress rules = deny ALL egress including DNS

# GOOD: Always include DNS egress in every pod-level policy
spec:
  podSelector:
    matchLabels:
      app: payment-svc
  policyTypes:
    - Egress
  egress:
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    - to:
        - podSelector:
            matchLabels:
              app: payment-svc-dependencies  # actual service targets
```

**الحل:** يجب أن تتضمن كل NetworkPolicy للحركة الصادرة قاعدة تسمح بـ UDP/53 وTCP/53 إلى `kube-dns` (مساحة الأسماء `kube-system`، والوسم `k8s-app: kube-dns`). وأتمت ذلك عبر webhook قبول (OPA/Gatekeeper) يرفض أي NetworkPolicy تفتقر إلى قاعدة DNS الصادرة.

---

## 10. قائمة التحقق للإنتاج

- [ ] خادم SPIRE منشور بتوفر عالٍ (عدة نسخ، ومخزن بيانات PostgreSQL/MySQL مشترك)، لا SQLite المدمجة
- [ ] كل مساحات الأسماء فيها NetworkPolicy ‏`default-deny-all` كأساس
- [ ] ‏`PeerAuthentication` في Istio مضبوطة على mTLS بالوضع STRICT في كل مساحات أسماء CDE
- [ ] الوضع PERMISSIVE لـ mTLS يُستخدم أثناء الترحيل فقط مع موعد إزالة متتبَّع
- [ ] محرك أسرار قواعد البيانات في Vault مضبوط لكل اتصالات قواعد البيانات
- [ ] ‏`maxLifetime` في HikariCP أقصر من عقد إيجار بيانات الاعتماد، والتطبيق يلتقط بيانات الاعتماد الجديدة قبل `max_ttl`
- [ ] ‏`AuthorizationPolicy` في Istio ترفض كل الحركة افتراضيًا؛ ولا يمنح الوصول إلا قواعد ALLOW صريحة
- [ ] ‏OPA منشور كحاوية جانبية مع نسخ الحزم؛ لا كاستدعاء متزامن بعيد أبدًا
- [ ] حركة DNS الصادرة (UDP/53، TCP/53) مسموحة صراحة في كل NetworkPolicy للحركة الصادرة
- [ ] الربط بالمتطلبات 1 و7 و8 في PCI-DSS موثّق في سجل ADR لفريق الأمان
- [ ] تدوير حزمة ثقة SPIFFE مختبر كل ربع سنة (محاكاة عدم توفر خادم SPIRE)
- [ ] ‏webhook قبول (OPA Gatekeeper أو Kyverno) يمنع الـ pods ذات الصلاحيات المرتفعة في مساحات أسماء CDE
- [ ] حسابات الخدمة مضبوطة على `automountServiceAccountToken: false` ما لم تكن مطلوبة

---

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "مدة صلاحية SVID من SPIFFE ساعة واحدة. أصبح خادم SPIRE غير متاح عند الدقيقة 50. ماذا يحدث للخدمات العاملة؟",
      "options": [
        "تفشل كل الاستدعاءات بين الخدمات فورًا لأن Envoy لا يستطيع التحقق من الشهادات",
        "تبقى وثيقة SVID التي يحملها الوكيل وEnvoy صالحة حتى انتهائها (10 دقائق أخرى)؛ ولا تفشل الاستدعاءات إلا بعد ذلك إذا ظل خادم SPIRE متعطلًا",
        "يرجع Istio تلقائيًا إلى HTTP غير مشفر عند انتهاء شهادات mTLS",
        "تستمر الخدمات بلا حد لأن اكتشاف خدمات Kubernetes يتجاوز mTLS"
      ],
      "correct": 1,
      "explanation": "وثيقة SVID صالحة حتى وقت NotAfter سواء كان خادم SPIRE متاحًا أم لا، فتستمر الخدمات في العمل للمدة المتبقية. والخطر أنه لا يمكن إصدار SVID جديدة أثناء تعطل الخادم. وعادة يدوّر الوكلاء عند نصف المدة، فمدة ساعة واحدة تترك نحو 30 دقيقة فقط من الهامش — ولهذا يُعد خادم SPIRE عالي التوفر ومدة أطول (مثل 4 ساعات، بتدوير عند نحو ساعتين) متطلبات للإنتاج."
    },
    {
      "text": "أي متطلب في PCI-DSS تلبيه بيانات اعتماد قاعدة البيانات الديناميكية من Vault بصلاحية 15 دقيقة بشكل أكثر مباشرة؟",
      "options": [
        "المتطلب 3 — حماية بيانات الحسابات المخزنة",
        "المتطلب 6 — تطوير الأنظمة والبرمجيات الآمنة وصيانتها",
        "المتطلب 8.6 — إدارة حسابات التطبيقات والأنظمة وبيانات اعتمادها (8.6.3: حمايتها وتغييرها)",
        "المتطلب 10 — تسجيل كل وصول إلى مكوّنات النظام وبيانات حامل البطاقة ومراقبته"
      ],
      "correct": 2,
      "explanation": "يغطي المتطلب 8.6 في PCI DSS v4.0 حسابات التطبيقات والأنظمة؛ ويشترط 8.6.3 حماية كلمات مرورها من سوء الاستخدام وتغييرها دوريًا. وبيانات الاعتماد الديناميكية بصلاحية 15 دقيقة تنتهي من تلقاء نفسها وفريدة لكل حمل عمل، فتصبح بيانات الاعتماد المسربة بلا فائدة خلال دقائق دون أي تدوير يدوي — ضابط أقوى بكثير من كلمة مرور ثابتة."
    },
    {
      "text": "طبّق فريق NetworkPolicy ‏default-deny-all على مساحة الأسماء payments. ففشلت كل الاستدعاءات بين الخدمات فورًا. ما السبب الأرجح؟",
      "options": [
        "لم يُضبط mTLS في Istio لمساحة الأسماء",
        "إضافة CNI في Kubernetes لا تدعم NetworkPolicy",
        "تحليل DNS (‏UDP/53 إلى kube-dns) محجوب بقاعدة رفض الحركة الصادرة",
        "وكيل SPIRE لا يستطيع الوصول إلى خادم SPIRE"
      ],
      "correct": 2,
      "explanation": "عندما تحجب NetworkPolicy ‏default-deny-all كل الحركة الصادرة، تُحجب أيضًا استعلامات DNS إلى kube-dns (المنفذ 53/UDP). وبدون DNS لا يمكن تحويل أسماء الخدمات إلى عناوين IP، فتفشل كل الاتصالات الصادرة حتى قبل أن تبدأ mTLS أو المصادقة. ويجب أن تسمح كل سياسة صادرة على مستوى الـ pod بحركة DNS صراحة."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "بنية انعدام الثقة — تطبيق عملي",
  "difficulty": "advanced",
  "estimatedMinutes": 120,
  "tasks": [
    {
      "id": "task-01",
      "description": "انشر خادم SPIRE ووكيله على عنقود Kubernetes محلي (kind أو minikube). أنشئ مدخل ClusterSPIFFEID لـ pod باسم payment-svc. واكتب اختبار تكامل بلغة Java باستخدام مكتبة java-spiffe يجلب وثيقة SVID لحمل العمل payment-svc، ويتأكد من أن معرّف SPIFFE يطابق spiffe://fintech.internal/ns/default/sa/payment-svc، ويتحقق من أن NotAfter للشهادة خلال ساعة من الإصدار."
    },
    {
      "id": "task-02",
      "description": "اضبط Vault مع محرك أسرار قواعد البيانات موجّهًا إلى حاوية PostgreSQL محلية. أنشئ دورًا بصلاحية 15 دقيقة ومنح بأقل الصلاحيات (SELECT وINSERT على مخطط payments فقط). واكتب تطبيق Spring Boot يقرأ بيانات الاعتماد التي يولّدها Vault من /vault/secrets/database.properties عبر spring.config.import ويضبط HikariCP بالقيمة maxLifetime=14m. واكتب اختبارًا يتحقق من أن التطبيق يعيد الاتصال بعد انتهاء عقد إيجار Vault."
    },
    {
      "id": "task-03",
      "description": "اكتب ثلاثة ملفات NetworkPolicy لمساحة الأسماء payments: (1) رفض كل الحركة الواردة والصادرة افتراضيًا، (2) السماح بالحركة الواردة إلى payment-svc من مساحة الأسماء api-gateway فقط على المنفذ 8080، (3) السماح بالحركة الصادرة من payment-svc إلى ledger-svc على 8080 وإلى DNS على 53/UDP. واكتب اختبارًا باستخدام kubectl exec مع curl يتحقق من أن (أ) payment-svc لا تستطيع الوصول إلى fraud-svc مباشرة، (ب) payment-svc تستطيع الوصول إلى ledger-svc."
    },
    {
      "id": "task-04",
      "description": "اكتب سياسة OPA بلغة Rego ‏(payment_authz.rego): (أ) تسمح للصرّافين بالموافقة على المعاملات حتى approval_limit_cents، (ب) تسمح لدور العمليات بالموافقة على أي مبلغ، (ج) ترفض كل الإجراءات التي تستهدف sanctioned_countries (المحمّلة من حزمة بيانات خارجية)، (د) ترفض وصول الصرّاف للقراءة إلى المعاملات الموسومة internal-fraud-review. واكتب اختبارات وحدة لـ OPA في rego_test.rego تغطي 6 حالات على الأقل منها الحالات الحدّية."
    }
  ]
} -->
