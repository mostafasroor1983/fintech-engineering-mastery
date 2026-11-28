---
id: track-11-lesson-09
title: "أمان انعدام الثقة — الوصول القائم على الهوية للخدمات المصغّرة"
slug: zero-trust-security
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags:
  - zero-trust
  - SPIFFE
  - SPIRE
  - mTLS
  - Vault
  - NetworkPolicy
  - identity
prerequisites:
  - track-11-lesson-08
---

# أمان الثقة الصفرية — وصول قائم على الهوية للخدمات المصغّرة

يرسم أمان الشبكات التقليدي محيطًا حول مركز البيانات ويفترض أن كل ما بداخله موثوق. ولخدمات التقنية المالية المصغّرة الموزعة عبر مناطق سحابية، هذا الافتراض قاتل. فخدمة مخترقة واحدة تستطيع التحرك جانبيًا عبر الشبكة الداخلية كاملة. وتستبدل الثقة الصفرية الإيمان بالمحيط بالتحقق المستمر من الهوية والسياق والنية — في كل طلب، وفي كل مرة.

---

## 1. مبادئ الثقة الصفرية

ثلاثة مبادئ أساسية تعرّف الثقة الصفرية:

**لا تثق أبدًا، تحقق دائمًا** — لا يمنح أي موقع شبكي ثقة ضمنية. فحتى خدمة على شبكة الـ pods الفرعية نفسها يجب أن تصادق قبل الوصول إلى الموارد.

**افترض الاختراق** — صمّم الأنظمة كأن المهاجم يملك بالفعل موطئ قدم في الشبكة الداخلية. وحدّ نطاق الضرر عبر التقسيم، وبيانات الاعتماد قصيرة العمر، وسجلات التدقيق الشاملة.

**أقل صلاحية** — امنح فقط الصلاحيات التي يحتاجها حمل العمل لوظيفته المحددة في الوقت الذي يحتاجها. فلا شأن لخدمة الدفع بقراءة بيانات تدريب نموذج الاحتيال.

---

## 2. المحيط التقليدي مقابل الثقة الصفرية

```
TRADITIONAL PERIMETER MODEL
─────────────────────────────
                    ┌─────────────────────────────┐
   Internet  ───►  │   Firewall (trusted inside)  │
                   │                               │
                   │  payment-svc ◄──► account-svc│
                   │        │                      │
                   │        ▼                      │
                   │   database (no auth needed)   │
                   │                               │
                   │  If attacker reaches inside   │
                   │  → lateral movement is free   │
                   └─────────────────────────────-─┘

ZERO-TRUST MODEL
─────────────────────────────
                    ┌────────────────────────────────────────────┐
   Internet  ───►  │  Every service call requires:              │
                   │  1. Cryptographic identity (mTLS SVID)      │
                   │  2. Authorisation policy check (OPA/Istio)  │
                   │  3. Dynamic credential (Vault, TTL 1h)      │
                   │                                             │
                   │  payment-svc ──[mTLS+authz]──► account-svc │
                   │       │                                     │
                   │       │ [dynamic DB cred, 1h TTL]           │
                   │       ▼                                     │
                   │  postgres (password rotates every hour)     │
                   │                                             │
                   │  Attacker foothold → cannot move laterally  │
                   │  without valid SVID for target service      │
                   └────────────────────────────────────────────┘
```

---

## 3. ‏SPIFFE وSPIRE

‏**SPIFFE** ‏(Secure Production Identity Framework for Everyone) معيار مفتوح لهوية أحمال العمل. ويعرّف:

- **‏SVID** ‏(SPIFFE Verifiable Identity Document) — بيانات الاعتماد التي يقدمها حمل العمل.
- **‏X.509 SVID** — شهادة X.509 مع URI SAN بالصيغة `spiffe://trust-domain/workload`.
- **‏JWT SVID** — رمز JWT يحمل معرّف SPIFFE في المطالبة `sub`، ويُستخدم لاستدعاءات واجهات HTTP.

‏**SPIRE** ‏(SPIFFE Runtime Environment) التنفيذ المرجعي الذي يصدر SVIDs ويدوّرها.

### صيغة معرّف SPIFFE

```
spiffe://trust-domain/path
         ─────────────────  ──────────────
         your organisation  workload path

Examples:
spiffe://fintech.example.com/ns/payments/sa/payment-service
spiffe://fintech.example.com/ns/fraud/sa/fraud-detection-service
spiffe://fintech.example.com/ns/core/sa/account-service
```

### بنية SPIRE

```
┌─────────────────────────────────────────────────────┐
│                 Kubernetes Cluster                   │
│                                                      │
│  ┌─────────────┐          ┌────────────────────────┐ │
│  │ SPIRE Server│◄─────────│    SPIRE Agent         │ │
│  │ (issuing CA)│  mTLS    │  (DaemonSet, 1/node)   │ │
│  └─────────────┘          └───────────┬────────────┘ │
│        │                              │ Unix socket   │
│        │  issues SVID                 │ /run/spire    │
│        │                   ┌──────────▼─────────────┐│
│        └──────────────────►│    payment-service     ││
│                             │  (fetches SVID via SDK)││
│                             └────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### إعداد خادم SPIRE

```hcl
# spire-server.conf (HCL)
server {
  bind_address = "0.0.0.0"
  bind_port    = "8081"
  trust_domain = "fintech.example.com"
  data_dir     = "/opt/spire/data/server"
  log_level    = "INFO"

  # SVID TTL: certificates expire after 1 hour
  # SPIRE rotates at 50% of TTL (every 30 minutes) for zero-downtime
  default_x509_svid_ttl = "1h"
  ca_ttl           = "24h"
}

plugins {
  DataStore "sql" {
    plugin_data {
      database_type = "postgres"
      connection_string = "dbname=spire user=spire host=spire-db sslmode=require"
    }
  }

  NodeAttestor "k8s_psat" {
    plugin_data {
      clusters = {
        "prod-eu-west-1" = {
          service_account_allow_list = ["spire:spire-agent"]
          audience                   = ["spire-server"]
        }
      }
    }
  }

  KeyManager "disk" {
    plugin_data {
      keys_path = "/opt/spire/data/server/keys.json"
    }
  }
}
```

### مُدخل تسجيل لخدمة الدفع

في Kubernetes، ينشئ **SPIRE Controller Manager** هذه المُدخلات عادةً تلقائيًا من موارد `ClusterSPIFFEID` (مثل قالب واحد `spiffe://fintech.example.com/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}`). والمكافئ اليدوي لحمل عمل واحد:

```bash
# Register payment-service workload identity
spire-server entry create \
  -spiffeID   spiffe://fintech.example.com/ns/payments/sa/payment-service \
  -parentID   spiffe://fintech.example.com/spire/agent/k8s_psat/prod-eu-west-1/node1 \
  -selector   k8s:ns:payments \
  -selector   k8s:sa:payment-service \
  -x509SVIDTTL 3600   # 1 hour SVID TTL
```

---

## 4. ‏mTLS بين الخدمات مع Istio

يؤتمت Istio ‏mTLS باستخدام SVIDs متوافقة مع SPIFFE تصدرها سلطة الشهادات الخاصة به (Citadel/istiod). وتتولى الوكلاء الجانبية مصافحة TLS بشفافية.

### فرض mTLS الصارم عبر مساحة الأسماء payments

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: payments-namespace-strict-mtls
  namespace: payments
spec:
  mtls:
    mode: STRICT      # reject any plaintext connections
```

### استثناءات لكل منفذ (تكامل قديم)

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: payment-service-mtls
  namespace: payments
spec:
  selector:
    matchLabels:
      app: payment-service
  mtls:
    mode: STRICT
  portLevelMtls:
    # Allow plaintext on health check port for GCP load balancer
    8086:
      mode: PERMISSIVE
```

---

## 5. بيانات الاعتماد الديناميكية في Vault

يولّد محرك أسرار قاعدة البيانات في Vault بيانات اعتماد قصيرة العمر لقاعدة البيانات عند الطلب. فلا تحمل أي خدمة كلمة مرور طويلة العمر.

### إعداد Vault لقاعدة بيانات خدمة الدفع

```hcl
# Terraform (Vault provider)
# Enable the database secrets engine
resource "vault_mount" "database" {
  path = "database"
  type = "database"
}

# Configure the PostgreSQL connection
resource "vault_database_secret_backend_connection" "payments_db" {
  backend       = vault_mount.database.path
  name          = "payments-postgres"
  allowed_roles = ["payment-service-role"]

  postgresql {
    connection_url = "postgresql://{{username}}:{{password}}@postgres.payments.svc:5432/payments?sslmode=require"
    username       = "vault-admin"
    password       = var.vault_db_admin_password
  }
}

# Role: credentials valid for 1 hour, max lease 2 hours
resource "vault_database_secret_backend_role" "payment_service" {
  backend               = "database"
  name                  = "payment-service-role"
  db_name               = vault_database_secret_backend_connection.payments_db.name
  creation_statements   = [
    "CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';",
    "GRANT SELECT, INSERT, UPDATE ON payments, payment_events TO \"{{name}}\";",
  ]
  revocation_statements = ["DROP ROLE IF EXISTS \"{{name}}\";"]
  default_ttl           = "1h"
  max_ttl               = "2h"
}
```

### تكامل Spring Boot مع Vault

```xml
<!-- pom.xml -->
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-vault-config</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-vault-config-databases</artifactId>
</dependency>
```

```yaml
# application.yml (bootstrap.yml is the legacy mechanism)
spring:
  config:
    import: vault://
  cloud:
    vault:
      host: vault.vault.svc.cluster.local
      port: 8200
      scheme: https
      authentication: KUBERNETES
      kubernetes:
        role: payment-service
        kubernetes-path: auth/kubernetes
      database:
        enabled: true
        role: payment-service-role
        backend: database
        # Spring Cloud Vault sets spring.datasource.username/password at
        # start-up and RENEWS the lease before each TTL expiry -- up to
        # max_ttl (2h here). It does not reconfigure an existing connection
        # pool: when max_ttl is reached, the application must obtain a new
        # credential and switch the pool (see the secret-management lesson)
```

```java
// Java — credentials are injected and auto-renewed by Spring Cloud Vault
@Configuration
public class DatabaseConfig {

    // Spring Cloud Vault populates these from Vault dynamic secrets
    @Value("${spring.datasource.username}")
    private String username;

    @Value("${spring.datasource.password}")
    private String password;

    @Bean
    public DataSource dataSource(
            @Value("${spring.datasource.url}") String url) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(url);
        config.setUsername(username);
        config.setPassword(password);
        // Values are read ONCE at start-up. Renewal keeps this user valid
        // until max_ttl; after that the pool needs new credentials -- e.g.
        // via HikariConfigMXBean.setUsername/setPassword + softEvictConnections
        config.setConnectionTimeout(30_000);
        config.setMaximumPoolSize(10);
        return new HikariDataSource(config);
    }
}
```

---

## 6. ‏NetworkPolicy في Kubernetes — المنع الشامل الافتراضي

تعمل NetworkPolicy على الطبقة 3/4 وتفرض أي الـ pods يمكنها التواصل باستخدام قواعد IP والمنافذ.

### المنع الشامل الافتراضي للدخول والخروج

```yaml
# Apply to every namespace that handles financial data
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: payments
spec:
  podSelector: {}       # applies to all pods in namespace
  policyTypes:
    - Ingress
    - Egress
```

### سماح انتقائي: خدمة الدفع إلى PostgreSQL

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-payment-service-to-postgres
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-service   # only payment-service pods
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: data
          podSelector:
            matchLabels:
              app: postgres
      ports:
        - protocol: TCP
          port: 5432
```

### السماح بحل أسماء DNS (مطلوب مع المنع الافتراضي)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: payments
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

---

## 7. ‏AuthorizationPolicy في Istio

تعمل AuthorizationPolicy على الطبقة 7 ويمكنها فرض مطالبات JWT إلى جانب هوية النظير عبر mTLS.

### خدمة الدفع: قبول الطلبات من بوابة الواجهات فقط

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: payment-service-allow-gateway
  namespace: payments
spec:
  selector:
    matchLabels:
      app: payment-service
  action: ALLOW
  rules:
    - from:
        # mTLS peer: only the API gateway service account
        - source:
            principals:
              - "cluster.local/ns/ingress/sa/api-gateway"
      to:
        - operation:
            methods: ["POST"]
            paths: ["/api/v1/payments", "/api/v1/payments/*"]
      when:
        # JWT claims are only available after a RequestAuthentication
        # (below) has validated the token
        - key: request.auth.claims[aud]
          values: ["payment-service"]
---
# Validates JWTs (signature via JWKS, expiry) for payment-service
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: payment-service-jwt
  namespace: payments
spec:
  selector:
    matchLabels:
      app: payment-service
  jwtRules:
    - issuer: "https://auth.fintech.example.com"
      jwksUri: "https://auth.fintech.example.com/.well-known/jwks.json"
```

لا حاجة لسياسة منفصلة "امنع كل ما عدا ذلك": فبمجرد أن تنطبق سياسة ALLOW واحدة على حمل عمل، يُرفض كل طلب لا يطابق أي قاعدة ALLOW. و**لا** تُضف سياسة DENY بقاعدة فارغة (`rules: [{}]`) — فسياسات DENY تُقيّم *قبل* سياسات ALLOW، فستمنع كل طلب، بما فيها المسموح.

---

## 8. سياسة OPA/Rego: ضبط الوصول بين الخدمات

يوفر Open Policy Agent ‏(OPA) قرارات تفويض دقيقة تتجاوز ما تستطيع AuthorizationPolicy في Istio التعبير عنه.

```rego
# policies/service-access.rego (Rego v1 syntax, OPA 1.0+)
package fintech.service_access

# Default: deny all -- anything not explicitly allowed below is refused
default allow := false

# Allow payment-service to call account-service read endpoints
allow if {
    input.source.spiffe_id == "spiffe://fintech.example.com/ns/payments/sa/payment-service"
    input.destination.service == "account-service"
    input.request.method in {"GET", "HEAD"}
    startswith(input.request.path, "/api/v1/accounts/")
}

# Allow fraud-detection to call account-service read-only
allow if {
    input.source.spiffe_id == "spiffe://fintech.example.com/ns/fraud/sa/fraud-detection-service"
    input.destination.service == "account-service"
    input.request.method == "GET"
    startswith(input.request.path, "/api/v1/accounts/")
}

# Nobody except reconciliation-service can access the ledger
allow if {
    input.source.spiffe_id == "spiffe://fintech.example.com/ns/reconciliation/sa/reconciliation-service"
    input.destination.service == "ledger-service"
}

# account-service -> payment-service (a reverse dependency) needs no rule:
# no "allow" matches it, so the default denies it. A separate "deny" rule
# would only take effect if the decision were written as "allow and not deny".
```

```yaml
# OPA deployed as Envoy external authorization: needs the OPA-Envoy plugin
# image (tag suffix "-envoy") and its gRPC ext_authz server. Istio also needs
# an extensionProvider in the mesh config plus an AuthorizationPolicy with
# action: CUSTOM that sends requests to it.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opa
  namespace: payments
spec:
  template:
    spec:
      containers:
        - name: opa
          image: openpolicyagent/opa:1.4.2-envoy
          args:
            - "run"
            - "--server"
            - "--addr=:8181"
            - "--set=plugins.envoy_ext_authz_grpc.addr=:9191"
            - "--set=plugins.envoy_ext_authz_grpc.path=fintech/service_access/allow"
            - "--bundle=/policies"
          volumeMounts:
            - name: policies
              mountPath: /policies
      volumes:
        - name: policies
          configMap:
            name: opa-policies
```

---

## 9. الربط بـ PCI-DSS

| متطلب PCI-DSS | ضابط الثقة الصفرية |
|--------------------|--------------------|
| المتطلب 1: ضوابط أمان الشبكة / التقسيم | ‏NetworkPolicy بمنع شامل افتراضي؛ وسياسات شبكة Istio |
| المتطلب 2: إعدادات آمنة (بلا بيانات اعتماد افتراضية) | لا كلمات مرور افتراضية من المورّد أو مشتركة؛ وافتراضيات مقوّاة |
| المتطلب 7: تقييد الوصول إلى مكونات النظام | ‏AuthorizationPolicy؛ وقواعد OPA بين الخدمات |
| المتطلب 8: تحديد الهوية والمصادقة على الوصول (بما فيه 8.6 لحسابات النظام/التطبيقات) | ‏SPIFFE SVID؛ ومصادقة متبادلة عبر mTLS؛ وبيانات اعتماد Vault الديناميكية |
| المتطلب 4: التشفير أثناء النقل | ‏mTLS بين كل الخدمات |
| المتطلب 10: سجلات التدقيق | سجلات وصول Istio؛ وسجلات قرارات OPA؛ وسجل تدقيق Vault |

---

## مزالق الإنتاج

### المزلق 1: ترك وضع mTLS ‏PERMISSIVE في الإنتاج

يجعل Istio الوضع `PERMISSIVE` افتراضيًا أثناء الترحيل، فيقبل الاتصالات النصية الصريحة وmTLS معًا. وتنسى الفرق التحويل إلى `STRICT` بعد الترحيل، فتبقى الحركة الجانبية بنص صريح ممكنة.

**الحل**: افرض PeerAuthentication ‏`STRICT` على مستوى مساحة الأسماء وتحقق بـ:

```bash
# Check all namespaces for non-STRICT mTLS
kubectl get peerauthentication -A -o jsonpath='{range .items[*]}{.metadata.namespace}: {.spec.mtls.mode}{"\n"}{end}'

# Expected: payments: STRICT
# Alert if any namespace is PERMISSIVE or missing
```

أضف فحص سياسة في CI يفشل إذا لم تكن أي `PeerAuthentication` في مساحة أسماء مالية `STRICT`.

### المزلق 2: بيانات اعتماد قاعدة بيانات ثابتة طويلة العمر بجانب بيانات Vault الديناميكية

ينتقل فريق إلى بيانات اعتماد Vault الديناميكية في شيفرة التطبيق لكنه ينسى مهمة cron وخط بيانات ما زالا يستخدمان كلمة المرور الثابتة القديمة المخزنة في سر Kubernetes. وبيانات الاعتماد الثابتة لا تنتهي ولا تُدقق.

**الحل**: دقّق كل مستخدمي قاعدة البيانات، وعطّل أي مستخدم لا يديره Vault، وافرض سياسة بأن تكون لكل بيانات اعتماد قاعدة البيانات مدة انتهاء.

```sql
-- Audit PostgreSQL users without expiry
SELECT usename, valuntil
FROM pg_user
WHERE valuntil IS NULL
   OR valuntil > NOW() + INTERVAL '2 hours';
-- Expected exceptions: superusers and the Vault admin user itself (whose
-- password Vault rotates). Any other result is a non-Vault credential —
-- investigate immediately
```

### المزلق 3: ‏NetworkPolicy تكسر DNS وتسبب إخفاقات خدمة صامتة

تطبيق NetworkPolicy بمنع شامل افتراضي دون السماح صراحة بخروج DNS يجعل كل اكتشاف الخدمات يفشل بصمت. فتستطيع الخدمات البدء لكن كل الاتصالات الصادرة تفشل بـ `UnknownHostException` بدل خطأ رفض اتصال، فيصعب التشخيص.

**الحل**: طبّق دائمًا NetworkPolicy خروج DNS قبل المنع الشامل الافتراضي، وتحقق بـ:

```bash
# Test DNS resolution from within the payment-service pod
kubectl exec -n payments deploy/payment-service -- \
  nslookup postgres.data.svc.cluster.local

# Test connectivity to postgres
kubectl exec -n payments deploy/payment-service -- \
  nc -zv postgres.data.svc.cluster.local 5432
```

أضف اختبار دخان لاتصال الشبكة إلى منطق فحص الجاهزية أو اختبارات التكامل بعد النشر.

---

## قائمة تحقق الإنتاج

- [ ] خادم SPIRE منشور مع إثبات PSAT في Kubernetes
- [ ] لكل أحمال عمل مساحات الأسماء المالية مُدخلات تسجيل SPIFFE
- [ ] مدة صلاحية SVID ساعة أو أقل؛ والتدوير عند 50% من المدة متحقق منه في سجلات SPIRE
- [ ] ‏PeerAuthentication ‏STRICT مفروضة على كل مساحات الأسماء المالية
- [ ] ‏`kubectl get peerauthentication -A` لا يُظهر مساحات أسماء PERMISSIVE
- [ ] محرك أسرار قاعدة البيانات في Vault مفعّل بأدوار لكل خدمة
- [ ] مدة صلاحية بيانات اعتماد قاعدة البيانات ساعة؛ وتجديد عقد الإيجار في Vault مختبر
- [ ] لا أسرار Kubernetes ثابتة تحوي كلمات مرور قواعد البيانات
- [ ] ‏NetworkPolicy بمنع شامل افتراضي مطبقة على كل مساحات الأسماء المالية
- [ ] ‏NetworkPolicy لخروج DNS مطبقة قبل المنع الافتراضي
- [ ] اختبارات دخان اتصال الشبكة تنجح بعد كل نشر
- [ ] ‏AuthorizationPolicy في Istio تمنع كل الاستدعاءات بين الخدمات غير المدرجة
- [ ] سياسات OPA ملتزمة في git؛ وربط ضوابط PCI-DSS موثق
- [ ] سجل تدقيق Vault مفعّل ومُعاد توجيهه إلى SIEM

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"أي URI SAN يجب أن يحمله X.509 SVID في SPIFFE لخدمة payment-service في مساحة الأسماء payments ضمن نطاق الثقة fintech.example.com؟","options":["https://fintech.example.com/payments/payment-service","spiffe://fintech.example.com/ns/payments/sa/payment-service","CN=payment-service,OU=payments,O=fintech.example.com","spiffe://payments/payment-service@fintech.example.com"],"correct":1,"explanation":"تستخدم SVIDs في SPIFFE صيغة URI ‏spiffe://trust-domain/workload-path. ونطاق الثقة هو معرّف المؤسسة (fintech.example.com) والمسار يرمّز اصطلاحًا مساحة أسماء Kubernetes وحساب الخدمة: ‏/ns/<namespace>/sa/<service-account>. وصيغتا HTTPS وX.500 DN ليستا صيغتي معرّف SPIFFE صالحتين."},{"text":"يصدر Vault بيانات اعتماد قاعدة بيانات بـ default_ttl=1h لخدمة payment-service. وتعمل الخدمة منذ 55 دقيقة حين تحتاج تنفيذ استعلام قاعدة بيانات. ماذا يحدث؟","options":["يفشل الاستعلام بخطأ مصادقة لأن بيانات الاعتماد انتهت.","يجدد Spring Cloud Vault عقد الإيجار تلقائيًا قبل الانتهاء وينجح الاستعلام ببيانات الاعتماد نفسها.","يولّد Vault بيانات اعتماد جديدة ويدوّر Spring Cloud Vault مجمّع اتصالات DataSource بشفافية.","يجب إعادة تشغيل الخدمة للحصول على بيانات اعتماد جديدة."],"correct":1,"explanation":"تراقب آلية تجديد عقود الإيجار في Spring Cloud Vault مدد الصلاحية وتجدد العقود قبل الانتهاء. ولبيانات اعتماد بصلاحية ساعة، يُجدد العقد قبل انقضاء الساعة بوقت كافٍ، ويبقى اسم المستخدم وكلمة المرور نفساهما صالحين — فينجح الاستعلام. ولا يستطيع التجديد تمديد العقد إلا حتى max_ttl (ساعتان هنا). وبعدها يلغي Vault بيانات الاعتماد، ويجب أن يحصل التطبيق على بيانات جديدة ويحوّل مجمّع اتصالاته: يستطيع Spring Cloud Vault طلب السر الجديد ونشر حدث، لكنه لا يعيد ضبط مجمّع HikariCP قائم بنفسه — فهذا يحتاج شيفرة (أو إعادة تشغيل/نشر)."},{"text":"تُطبق NetworkPolicy بمنع شامل افتراضي على مساحة الأسماء payments. وبعدها مباشرة، تسجّل pods ‏payment-service الخطأ UnknownHostException عند محاولة الوصول إلى account-service. ما السبب الأرجح؟","options":["تمنع NetworkPolicy الخاصة بـ account-service الدخول من مساحة الأسماء payments.","لم يُسمح صراحة بخروج DNS على المنفذ 53 ‏UDP/TCP إلى kube-dns، فيفشل اكتشاف الخدمات.","‏PeerAuthentication في Istio بالوضع STRICT يمنع الاتصال.","انتهت صلاحية SVID الخاص بخدمة payment-service."],"correct":1,"explanation":"تمنع NetworkPolicy ذات المنع الشامل الافتراضي كل الخروج، بما فيه استعلامات DNS إلى kube-dns على المنفذ 53. ودون DNS، لا يمكن حل أسماء الخدمات مثل account-service.core.svc.cluster.local، فيحدث UnknownHostException قبل محاولة أي اتصال TCP. والحل تطبيق NetworkPolicy خروج صريحة تسمح بالمنفذ 53 ‏UDP وTCP إلى pods ‏kube-dns في kube-system قبل تطبيق المنع الشامل الافتراضي."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"تنفيذ شبكة خدمات بثقة صفرية لخدمات الدفع المصغّرة","difficulty":"advanced","estimatedMinutes":120,"tasks":[{"id":"1","description":"انشر SPIRE في عنقود kind محلي. وأنشئ مُدخلات تسجيل SPIFFE لـ payment-service ‏(spiffe://fintech.example.com/ns/payments/sa/payment-service) وaccount-service ‏(spiffe://fintech.example.com/ns/core/sa/account-service) باستخدام إثبات PSAT في Kubernetes. وتحقق من أن كل خدمة تجلب X.509 SVID بـ URI SAN الصحيح وأن الـ SVID يُدوَّر خلال ساعة. واستخدم spire-server entry show لتأكيد التسجيل."},{"id":"2","description":"اضبط محرك أسرار قاعدة البيانات في Vault لإصدار بيانات اعتماد PostgreSQL لـ payment-service بصلاحية ساعة وحد أقصى ساعتين. وأنشئ سياسة Vault تسمح فقط لحساب خدمة Kubernetes الخاص بـ payment-service بطلب بيانات الاعتماد باستخدام payment-service-role. وادمج مع Spring Boot باستخدام spring-cloud-vault-config-databases، وأضف شيفرة تحوّل مجمّع HikariCP إلى بيانات اعتماد جديدة قبل الحد الأقصى للصلاحية. واكتب اختبار تكامل يتحقق من استمرار عمل DataSource عبر تدوير قسري لبيانات الاعتماد."},{"id":"3","description":"طبّق NetworkPolicy بمنع شامل افتراضي على مساحة الأسماء payments. وأضف قواعد سماح صريحة لـ: DNS ‏(UDP/TCP 53 إلى kube-dns)، وpayment-service إلى postgres على المنفذ 5432، وpayment-service إلى account-service على المنفذ 8080، وجمع Prometheus على المنفذ 8080. وطبّق PeerAuthentication ‏STRICT على مساحة الأسماء payments. واكتب سكربت shell يتحقق من نجاح كل قواعد الاتصال ومن أن كل المسارات الممنوعة ممنوعة فعلًا باستخدام kubectl exec وnc."},{"id":"4","description":"اكتب سياسة OPA/Rego تفرض: payment-service يستطيع استدعاء نقاط GET في account-service فقط، وfraud-detection-service يستطيع استدعاء نقاط GET في account-service فقط، ولا خدمة تستطيع استدعاء payment-service عدا api-gateway، وكل الاستدعاءات الأخرى بين الخدمات ممنوعة. واكتب اختبارات وحدة OPA باستخدام rego_test للقواعد الأربع. وانشر السياسة كمرشح تفويض خارجي لـ Envoy في Istio وتحقق بـ curl من أن استدعاءً غير مصرح يعيد 403."}]} -->
