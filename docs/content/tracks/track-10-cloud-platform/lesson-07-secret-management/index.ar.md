---
id: track-10-lesson-07
title: "إدارة الأسرار — Vault وExternal Secrets Operator"
slug: secret-management
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 7
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [secrets, HashiCorp-Vault, ESO, rotation, encryption-at-rest]
prerequisites: [track-10-lesson-06]
---

# إدارة الأسرار — Vault وExternal Secrets Operator

> [!NOTE]
> بيانات الاعتماد المسربة والمكتوبة في الشيفرة من أشيع نقاط بداية اختراقات البيانات. ومع الأسرار الديناميكية في HashiCorp Vault، لا يعرف أحد كلمة مرور قاعدة بيانات الإنتاج أبدًا — لا مدير قاعدة البيانات، ولا مطوّر التطبيق، ولا مهندس المنصة. فبيانات الاعتماد توجد طوال مدة عقد إيجارها (lease) ثم تُدمّر. وهذا أقوى نمط شائع لإدارة بيانات اعتماد التطبيقات في بيئة PCI-DSS.

(يخضع Vault لرخصة Business Source منذ 2023؛ و**OpenBao** نسخة مفتوحة المصدر متفرعة منه بواجهة متوافقة. وتنطبق مفاهيم هذا الدرس على كليهما.)

## لماذا لا تكفي أسرار Kubernetes وحدها

افتراضيًا، أسرار Kubernetes:
- مرمّزة بـ Base64 (لا مشفرة) في etcd
- قابلة للقراءة من أي شخص له صلاحية `kubectl get secret` في مساحة الأسماء
- تُخزن في Git إذا نفّذت `kubectl get secret -o yaml` بالخطأ والتزمت بالمخرجات
- لا تُدوَّر تلقائيًا

وللخدمات المالية التي تتعامل مع بيانات حاملي البطاقات، تجعل هذه الخصائص تحقيق متطلب PCI-DSS رقم 3 (حماية بيانات الحسابات المخزنة والمفاتيح التي تحميها) والمتطلب 8 (تعريف المستخدمين والتحقق من الوصول، بما فيها قواعد كلمات مرور حسابات النظام والتطبيقات) صعبًا.

والحل نهج متعدد الطبقات:
1. **‏Vault** كواجهة خلفية للأسرار (بيانات اعتماد ديناميكية، وسجل تدقيق، وتشفير)
2. **‏External Secrets Operator** للمزامنة من Vault إلى أسرار Kubernetes
3. **تشفير etcd في Kubernetes** كإجراء دفاع متعدد الطبقات (تشفّر الخدمات المُدارة مثل EKS الأسرار الآن بتشفير مغلّف عبر KMS افتراضيًا — فتحقق من خدمتك)

---

## 1. بنية HashiCorp Vault

```
+------------------------+     +---------------------------+
|  External Secrets      |     |  Vault Agent Injector     |
|  Operator              |     |  (sidecar annotation)     |
|  (K8s controller)      |     |                           |
+----------+-------------+     +-------------+-------------+
           |                                 |
           v                                 v
+----------+---------------------------------+--------------+
|                    HashiCorp Vault                       |
|                                                          |
|  Auth Methods:          Secret Engines:                  |
|  - Kubernetes auth      - KV v2 (static secrets)         |
|  - AWS IAM auth         - Database (dynamic credentials) |
|  - OIDC auth            - PKI (certificate authority)    |
|                         - Transit (encryption-as-service)|
|                         - AWS (dynamic IAM creds)        |
|                                                          |
|  Audit:                 Policy Engine:                   |
|  - File                 - HCL policies                   |
|  - Syslog               - Fine-grained ACL               |
+----------------------------------------------------------+
           |
           v
+----------+---------------------+
|  Storage Backend               |
|  - Integrated Raft (HA)        |
|  - AWS DynamoDB                |
|  - Consul                      |
+--------------------------------+
```

### تثبيت Vault بتخزين Raft عالي التوفر

```yaml
# vault-values.yaml for Helm install
server:
  ha:
    enabled: true
    replicas: 3
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = true
        listener "tcp" {
          tls_disable = 0
          address = "[::]:8200"
          cluster_address = "[::]:8201"
          tls_cert_file = "/vault/userconfig/vault-ha-tls/vault.crt"
          tls_key_file  = "/vault/userconfig/vault-ha-tls/vault.key"
          tls_client_ca_file = "/vault/userconfig/vault-ha-tls/vault.ca"
        }
        storage "raft" {
          path = "/vault/data"
          retry_join {
            leader_api_addr = "https://vault-0.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-ha-tls/vault.ca"
          }
          retry_join {
            leader_api_addr = "https://vault-1.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-ha-tls/vault.ca"
          }
          retry_join {
            leader_api_addr = "https://vault-2.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-ha-tls/vault.ca"
          }
        }
        seal "awskms" {
          region     = "us-east-1"
          kms_key_id = "arn:aws:kms:us-east-1:123456789:key/abc-def-123"
        }
        service_registration "kubernetes" {}

  resources:
    requests:
      memory: 256Mi
      cpu: 250m
    limits:
      memory: 1Gi
      cpu: 2000m

  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: vault
            component: server
        topologyKey: kubernetes.io/hostname

  auditStorage:
    enabled: true
    size: 10Gi
    storageClass: gp3

injector:
  enabled: true
  resources:
    requests:
      memory: 64Mi
      cpu: 50m
    limits:
      memory: 256Mi
      cpu: 250m
```

---

## 2. بيانات اعتماد ديناميكية لقاعدة البيانات

الأسرار الديناميكية الميزة القاتلة في Vault للمنصات المالية. فبدل كلمة مرور ثابتة لا تتغير أبدًا، ينشئ Vault مستخدم قاعدة بيانات مؤقتًا بمدة صلاحية (TTL). وحين ينتهي عقد الإيجار، يحذف Vault المستخدم. فلا سكربتات تدوير، ولا توقف، ولا كلمات مرور مشتركة.

### إعداد محرك أسرار قاعدة البيانات في Vault

```bash
# Enable the database secret engine
vault secrets enable -path=database database

# Configure PostgreSQL connection
vault write database/config/payments-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="payment-processor,risk-engine,reconciliation-job" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.databases.svc.cluster.local:5432/payments_db" \
  username="vault_admin" \
  password="$(vault kv get -field=password secret/database/vault-admin)" \
  password_authentication="scram-sha-256"

# Rotate the vault_admin password immediately: afterwards only Vault knows it
vault write -f database/rotate-root/payments-postgres

# Create a role for the payment processor.
# Privileges come from membership in a group role (payments_app) that the
# DBA manages -- "GRANT ... ON ALL TABLES" would only cover tables that
# exist at the moment the user is created.
# TTL=1h: credential expires after 1 hour
# Max TTL=4h: lease can be renewed up to 4 hours total
vault write database/roles/payment-processor \
  db_name=payments-postgres \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'
      IN ROLE payments_app;
  " \
  revocation_statements="
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA payments FROM \"{{name}}\";
    DROP ROLE IF EXISTS \"{{name}}\";
  " \
  default_ttl="1h" \
  max_ttl="4h"

# Test: generate a credential manually
vault read database/creds/payment-processor
# Output:
# Key                Value
# lease_id           database/creds/payment-processor/abc123
# lease_duration     1h
# username           v-k8s-payment-processor-abc123
# password           A1B2C3D4...
```

### سياسة Vault لمعالج الدفع

```hcl
# payment-processor-policy.hcl
# Allow reading dynamic database credentials
path "database/creds/payment-processor" {
  capabilities = ["read"]
}

# Allow renewing the lease (keeps connection alive within max_ttl)
path "sys/leases/renew" {
  capabilities = ["update"]
}

# Allow reading static KV secrets (encryption keys, API keys)
path "secret/data/payments/payment-processor" {
  capabilities = ["read"]
}

# Allow reading PKI certificates for mTLS
path "pki/issue/payment-processor" {
  capabilities = ["update"]
}

# Everything not listed is denied by default. An explicit deny like this
# only matters if a broader rule elsewhere (e.g. secret/data/*) would allow it
path "secret/data/fraud/*" {
  capabilities = ["deny"]
}
```

```bash
# Apply the policy
vault policy write payment-processor payment-processor-policy.hcl

# Configure Kubernetes auth method
vault auth enable kubernetes

# Vault running INSIDE the cluster: give only the host. Vault then uses its
# own (automatically refreshed) service-account token and CA to call the
# TokenReview API. Do NOT pass a copied token_reviewer_jwt: projected tokens
# are short-lived, and auth would start failing when it expires.
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443"

# Bind the policy to the payment-processor ServiceAccount
vault write auth/kubernetes/role/payment-processor \
  bound_service_account_names=payment-processor \
  bound_service_account_namespaces=payments \
  policies=payment-processor \
  audience=vault \
  ttl=1h \
  max_ttl=4h
```

---

## 3. ‏External Secrets Operator ‏(ESO)

‏ESO متحكم Kubernetes يزامن الأسرار من واجهات خلفية خارجية (Vault، وAWS Secrets Manager، وGCP Secret Manager) إلى أسرار Kubernetes. وتستهلك التطبيقات أسرار Kubernetes القياسية — فلا تحتاج معرفة Vault.

أقل صلاحية: يصادق `ClusterSecretStore` كهوية واحدة تستطيع قراءة أسرار كل الفرق. ولمساحات الأسماء الخاضعة للتنظيم، فضّل `SecretStore` محصورًا في كل مساحة أسماء يصادق بحساب خدمة تلك المساحة ودور Vault الخاص بها.

### تثبيت ESO

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set replicaCount=2
```

### ‏ClusterSecretStore (واجهة Vault الخلفية)

```yaml
# ClusterSecretStore — cluster-wide Vault connection
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.vault.svc.cluster.local:8200"
      path: "secret"
      version: "v2"
      caBundle: |
        -----BEGIN CERTIFICATE-----
        MIIByjCCAXCgAwIBAgIUYAOm...
        -----END CERTIFICATE-----
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets-operator"
          serviceAccountRef:
            name: "external-secrets"
            namespace: "external-secrets"
```

### ‏ExternalSecret لخدمة الدفع

```yaml
# Dynamic database credentials: use a VaultDynamicSecret GENERATOR.
# (Reading database/creds/... like a KV key does not work through a KV
#  store -- and every read creates a NEW database user and lease.)
apiVersion: generators.external-secrets.io/v1alpha1
kind: VaultDynamicSecret
metadata:
  name: payment-processor-db
  namespace: payments
spec:
  path: "database/creds/payment-processor"
  method: GET
  provider:
    server: "https://vault.vault.svc.cluster.local:8200"
    caProvider:
      type: ConfigMap
      name: vault-ca
      key: ca.crt
    auth:
      kubernetes:
        mountPath: "kubernetes"
        role: "payment-processor"
        serviceAccountRef:
          name: "payment-processor"
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: payment-processor-db-creds
  namespace: payments
spec:
  # A new credential every 50 minutes; the previous one (TTL 1h) stays
  # valid ~10 more minutes -- the application must switch over in that time
  refreshInterval: 50m
  target:
    name: payment-processor-db-creds
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        # Keep the URL on ONE line: a folded YAML string would insert a space
        SPRING_DATASOURCE_URL: "jdbc:postgresql://postgres.databases.svc.cluster.local:5432/payments_db?sslmode=verify-full&sslrootcert=/certs/ca.crt"
        SPRING_DATASOURCE_USERNAME: "{{ .username }}"
        SPRING_DATASOURCE_PASSWORD: "{{ .password }}"
  dataFrom:
  - sourceRef:
      generatorRef:
        apiVersion: generators.external-secrets.io/v1alpha1
        kind: VaultDynamicSecret
        name: payment-processor-db

---
# ExternalSecret: sync static API keys from Vault KV
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: payment-processor-api-keys
  namespace: payments
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: payment-processor-api-keys
    creationPolicy: Owner
  data:
  - secretKey: VISA_API_KEY
    remoteRef:
      key: payments/payment-processor      # relative to the store's "secret" mount
      property: visa_api_key
  - secretKey: MASTERCARD_API_KEY
    remoteRef:
      key: payments/payment-processor
      property: mastercard_api_key
  - secretKey: ENCRYPTION_KEY
    remoteRef:
      key: payments/payment-processor
      property: field_encryption_key
```

---

## 4. ‏Vault Agent Injector (بديل لـ ESO)

‏Vault Agent Injector هو البديل حين يجب ألا توجد الأسرار ككائنات Secret في Kubernetes إطلاقًا: إذ يصادق وكيل Vault جانبي باسم الـ pod، ويكتب الأسرار في مجلد مشترك في الذاكرة، ويستمر في تجديد عقود الإيجار وإعادة توليد الملفات. (ومزوّد Vault لـ CSI وVault Secrets Operator خيارات أخرى.)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-payment-service
  namespace: payments
spec:
  template:
    metadata:
      annotations:
        # Vault Agent Injector annotations
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "payment-processor"
        vault.hashicorp.com/agent-inject-secret-database.env: "database/creds/payment-processor"
        vault.hashicorp.com/agent-inject-template-database.env: |
          {{- with secret "database/creds/payment-processor" -}}
          export DB_USERNAME="{{ .Data.username }}"
          export DB_PASSWORD="{{ .Data.password }}"
          {{- end }}
        vault.hashicorp.com/secret-volume-path: "/vault/secrets"
        # Keep the agent running as a sidecar: it renews leases and
        # re-renders the file before the credential expires
        vault.hashicorp.com/agent-pre-populate-only: "false"
        # TLS verification against VAULT's CA (mounted from a K8s Secret) --
        # not the Kubernetes API CA
        vault.hashicorp.com/tls-secret: "vault-ca"
        vault.hashicorp.com/ca-cert: "/vault/tls/ca.crt"
    spec:
      serviceAccountName: payment-processor
      containers:
      - name: legacy-payment-service
        image: payments-registry.internal/legacy-payment:v1.5.0
        # Reads the file ONCE at start-up: when the agent renders new
        # credentials, this legacy app needs a restart (or must re-read
        # the file itself) before the old credential expires
        command: ["/bin/sh", "-c", ". /vault/secrets/database.env && exec java -jar /app.jar"]
```

---

## 5. تشفير أسرار Kubernetes أثناء التخزين

افتراضيًا (في العناقيد المُدارة ذاتيًا)، تُخزن أسرار Kubernetes في etcd دون تشفير — فـ base64 مجرد ترميز. فعّل تشفير KMS كي تُشفر الأسرار أثناء التخزين بمفتاح في AWS KMS (أو أي KMS آخر). وفي الخدمات المُدارة هذا إعداد للعنقود — فـ EKS مثلًا يفعّل التشفير المغلّف للأسرار عبر KMS افتراضيًا في الإصدارات الحالية.

### إعداد تشفير KMS

```yaml
# /etc/kubernetes/encryption-config.yaml (on API server nodes)
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  # FIRST provider = used to ENCRYPT all new writes. KMS v2 (GA in
  # Kubernetes 1.29; KMS v1 is deprecated): envelope encryption, the DEK
  # is wrapped by the KMS key
  - kms:
      apiVersion: v2
      name: aws-kms-provider
      endpoint: unix:///var/run/kmsplugin/socket.sock
      timeout: 3s
  # Further providers are NOT fallbacks for encryption -- they are only used
  # to DECRYPT data that was written with them. Keep identity only during
  # the migration (to read old unencrypted Secrets); remove it afterwards
  - identity: {}
```

```bash
# After applying the encryption config, re-encrypt all existing secrets:
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -
# This forces a write of all secrets through the new encryption provider
```

---

## 6. تدوير الأسرار دون توقف

لمعالج الدفع، يجب أن يحدث تدوير الأسرار دون إعادة تشغيل الـ pods. والنمط:

1. يزامن ESO بيانات الاعتماد الجديدة من Vault إلى سر Kubernetes
2. يُحمّل سر Kubernetes كمجلد (volume) (فمتغيرات البيئة تُضبط مرة واحدة عند البدء ولا تتغير أبدًا)
3. يلاحظ التطبيق محتوى الملف الجديد ويحوّل مجمّع اتصالاته إلى بيانات الاعتماد الجديدة — قبل انتهاء القديمة

للتدوير دون توقف، حمّل الأسرار كـ **مجلدات** (لا متغيرات بيئة). فيحدّث kubelet الأسرار المحمّلة كمجلدات تلقائيًا حين يتغير السر (عادةً خلال دقيقة أو اثنتين؛ و**ليس** لعمليات التحميل بـ `subPath`)؛ أما متغيرات البيئة فتتطلب إعادة تشغيل الـ pod.

```yaml
# Mount secret as a volume — updates propagate within ~1 minute
spec:
  containers:
  - name: payment-processor
    volumeMounts:
    - name: db-credentials
      mountPath: /app/secrets/database
      readOnly: true
  volumes:
  - name: db-credentials
    secret:
      secretName: payment-processor-db-creds
      items:
      - key: SPRING_DATASOURCE_USERNAME
        path: db_username
      - key: SPRING_DATASOURCE_PASSWORD
        path: db_password
```

```java
// Re-reads the mounted credential files and hands new values to HikariCP.
// New connections use the new credential; existing connections are retired
// gracefully (softEvict) -- no restart, no failed requests
@Component
public class DatabaseCredentialReloader {

    private static final Path DIR = Path.of("/app/secrets/database");

    private final HikariDataSource dataSource;
    private volatile String currentUser = "";

    public DatabaseCredentialReloader(HikariDataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Scheduled(fixedDelay = 30_000)
    public void reloadIfChanged() {
        try {
            String user = Files.readString(DIR.resolve("db_username")).strip();
            String password = Files.readString(DIR.resolve("db_password")).strip();
            if (user.equals(currentUser)) {
                return;                       // dynamic creds: new user each time
            }
            HikariConfigMXBean config = dataSource.getHikariConfigMXBean();
            config.setUsername(user);
            config.setPassword(password);
            dataSource.getHikariPoolMXBean().softEvictConnections();
            currentUser = user;
            log.info("Database credentials rotated (user {})", user);
        } catch (IOException e) {
            // keep the current credential and alert -- don't crash the service
            log.error("Failed to read rotated database credentials", e);
        }
    }
}
// Also set HikariCP maxLifetime well below the credential TTL, so no pooled
// connection outlives its credential.
```

---

## 7. متطلبات PCI-DSS لإدارة المفاتيح

يستخدم الجدول أرقام المتطلبات في PCI DSS v3.2.1 ‏(3.6.x). وفي PCI DSS v4.0 توجد الضوابط نفسها في المتطلبين 3.6 و3.7 (عمليات إدارة المفاتيح، 3.7.1–3.7.8). ولاحظ أنها تغطي *المفاتيح التشفيرية* التي تحمي بيانات الحسابات؛ أما بيانات اعتماد قواعد البيانات والواجهات فتندرج تحت المتطلب 8 (مثل 8.3 و8.6 لحسابات التطبيقات والنظام).

| المتطلب (v3.2.1) | التنفيذ |
|---|---|
| 3.6.1: توثيق إجراءات المفاتيح التشفيرية | سجل تدقيق Vault + دليل تشغيل في Git |
| 3.6.2: توزيع المفاتيح بأمان | محرك transit في Vault ‏(wrap/unwrap) |
| 3.6.3: تخزين المفاتيح بأمان | ‏Vault + تشفير مغلّف عبر AWS KMS |
| 3.6.4: تدوير المفاتيح دوريًا | تدوير المفاتيح في Vault (TTL قاعدة البيانات + إصدارات KV) |
| 3.6.5: إحالة المفاتيح القديمة للتقاعد | إلغاء المفاتيح في Vault + حذف الأسرار عبر ESO |
| 3.6.7: منع استبدال المفاتيح غير المصرح به | ‏RBAC + Kyverno: فقط ESO يستطيع إنشاء الأسرار/تحديثها |

### إعداد سجل تدقيق Vault

```bash
# Enable audit log to file (shipped to SIEM)
vault audit enable file file_path=/vault/audit/vault-audit.log log_format=json

# Enable a second audit device: Vault refuses to serve requests when it
# cannot write to ANY audit device, so two devices avoid an outage
vault audit enable syslog tag="vault" facility="AUTH"

# Verify audit is working
vault audit list
```

```bash
# Sample audit log entry for a secret access:
# {
#   "time": "2026-11-08T09:23:45.123Z",
#   "type": "request",
#   "auth": {
#     "client_token": "hmac-sha256:abc...",
#     "accessor": "hmac-sha256:def...",
#     "entity_id": "payment-processor-pod-xyz",
#     "token_type": "service"
#   },
#   "request": {
#     "operation": "read",
#     "path": "database/creds/payment-processor",
#     "namespace": {"id": "root"},
#     "remote_address": "10.48.0.42"
#   },
#   "response": {
#     "data": {"lease_id": "hmac-sha256:...", "lease_duration": 3600}
#   }
# }
```

---

## قائمة تحقق الإنتاج

- [ ] ‏Vault منشور بوضع التوفر العالي (3 نسخ كحد أدنى) مع فك الختم التلقائي عبر AWS KMS
- [ ] محرك أسرار قاعدة البيانات مضبوط ببيانات اعتماد ديناميكية لكل قواعد بيانات الإنتاج
- [ ] ‏TTL لبيانات الاعتماد ساعة واحدة؛ والحد الأقصى 4 ساعات
- [ ] سياسة Vault لكل ServiceAccount — وصول بأقل صلاحية
- [ ] ‏ESO يزامن كل الأسرار إلى Kubernetes؛ ولا أسرار منشأة يدويًا في الإنتاج
- [ ] فترة تحديث ESO أقل من TTL بيانات اعتماد Vault، بهامش كافٍ لمزامنة kubelet وتحويل مجمّع اتصالات التطبيق
- [ ] ‏etcd في Kubernetes مشفر أثناء التخزين عبر مزوّد KMS
- [ ] الأسرار محمّلة كمجلدات (لا متغيرات بيئة) للتدوير دون توقف
- [ ] سجل تدقيق Vault يُشحن إلى SIEM (فكل وصول لبيانات الاعتماد مسجل)
- [ ] سياسة Kyverno: فقط ServiceAccount الخاص بـ ESO يستطيع تحديث الأسرار في مساحات أسماء الإنتاج
- [ ] لا أسرار نصية صريحة في ConfigMaps، أو ملفات قيم Helm، أو مستودعات Git
- [ ] تمرين تعافٍ سنوي: اختبار استعادة Vault من نسخة احتياطية مع إعادة تشفير المفاتيح

---

## الملخص

تلغي الأسرار الديناميكية في Vault مفهوم كلمة مرور قاعدة البيانات طويلة العمر في منصة مالية. فبيانات الاعتماد توجد ساعة واحدة، ولا يعرفها إلا pod التطبيق الذي طلبها، وتُلغى تلقائيًا حين ينتهي عقد الإيجار. ويربط External Secrets Operator ‏Vault بـ Kubernetes دون تغيير شيفرة التطبيق — فما زالت الخدمات تستهلك أسرار Kubernetes القياسية، لكن مصدر هذه الأسرار Vault وتُحدّث تلقائيًا. ويضمن تشفير etcd المدعوم بـ KMS أنه حتى لو استخرج أحد قاعدة بيانات etcd، فلن يستطيع قراءة الأسرار دون الوصول إلى مفتاح KMS. ويغطي هذا النهج متعدد الطبقات ضوابط إدارة بيانات الاعتماد والمفاتيح التي يطلبها PCI-DSS، مع مسار تدقيق يُظهر بالضبط من وصل إلى أي بيانات اعتماد ومتى.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "محرك أسرار قاعدة البيانات في Vault مضبوط بـ TTL ساعة واحدة لبيانات اعتماد payment-api. ويعمل pod ‏payment-api منذ 55 دقيقة. ماذا يحدث عند الدقيقة 60 إذا لم يجدد التطبيق عقد الإيجار؟",
      "options": [
        "يدوّر Vault بيانات الاعتماد ويتلقى الـ pod كلمة المرور الجديدة تلقائيًا عبر متغير بيئة",
        "ينتهي عقد الإيجار ويلغي Vault بيانات الاعتماد — فيُحذف مستخدم قاعدة البيانات. وتفشل الاتصالات الجديدة بها، ويجب على التطبيق الحصول على بيانات اعتماد جديدة من Vault وتحويل مجمّع اتصالاته إليها",
        "تستمر بيانات الاعتماد في العمل إلى الأبد — فـ TTL مجرد توصية لبيانات اعتماد قواعد البيانات",
        "يمدد Vault عقد الإيجار تلقائيًا لكل بيانات الاعتماد التي ما زالت مستخدمة"
      ],
      "correct": 1,
      "explanation": "لبيانات الاعتماد الديناميكية في Vault عقد إيجار. وحين ينتهي (ولم يُجدد، أو بلغ max_ttl)، ينفذ Vault عبارات الإلغاء الخاصة بالدور على قاعدة البيانات، فيحذف المستخدم أو يعطله؛ كما يمنع شرط VALID UNTIL في PostgreSQL تسجيلات الدخول الجديدة بعد الانتهاء. فتفشل الاتصالات الجديدة ببيانات الاعتماد القديمة، وبحسب قاعدة البيانات وعبارات الإلغاء، قد تُنهى الجلسات القائمة أيضًا. ويجب على التطبيق الحصول على بيانات اعتماد جديدة (اسم مستخدم وكلمة مرور جديدين) قبل تلك اللحظة: بتجديد عقد الإيجار (يفعل Vault Agent ذلك)، أو بالتقاط بيانات الاعتماد الجديدة التي جلبها ESO وتحويل مجمّع الاتصالات. ولاحظ أن ESO لا يجدد عقود الإيجار — فكل تحديث ينشئ بيانات اعتماد جديدة — وبيانات الاعتماد المحقونة كمتغيرات بيئة تتطلب إعادة تشغيل الـ pod."
    },
    {
      "text": "سر Kubernetes يحتوي كلمة مرور قاعدة بيانات مخزن في etcd دون تشفير أثناء التخزين. ويحصل مهاجم على صلاحية قراءة ملف نسخة احتياطية من etcd. ما سطح الهجوم وكيف يخففه تشفير etcd المدعوم بـ KMS؟",
      "options": [
        "بيانات etcd مرمّزة بـ base64، وهذا يوفر حماية كافية من المهاجمين العابرين",
        "دون تشفير، يستطيع المهاجم فك ترميز base64 لقيمة السر مباشرة من النسخة الاحتياطية والحصول على بيانات الاعتماد نصًا صريحًا. ويغلّف تشفير KMS مفتاح تشفير البيانات بمفتاح KMS رئيسي — فيحتاج المهاجم أيضًا الوصول إلى مفتاح KMS لفك التشفير، وهو محكوم بسياسات IAM",
        "أسرار Kubernetes مشفرة أثناء التخزين افتراضيًا في كل الإصدارات بعد 1.20",
        "سيحتاج المهاجم شهادة TLS الخاصة بـ etcd لقراءة النسخة الاحتياطية، وهذا يوفر حماية معادلة لتشفير KMS"
      ],
      "correct": 1,
      "explanation": "أسرار Kubernetes مرمّزة بـ base64، لا مشفرة، ما لم يُضبط التشفير أثناء التخزين (هو معطّل افتراضيًا في العناقيد المُدارة ذاتيًا؛ وبعض الخدمات المُدارة تفعّله الآن). فيستطيع مهاجم لديه نسخة etcd الاحتياطية فك ترميز أي قيمة سر وقراءتها نصًا صريحًا. ويشفّر التشفير أثناء التخزين المدعوم بـ KMS ‏(EncryptionConfiguration بمزوّد kms) بيانات السر بمفتاح تشفير بيانات (DEK)، مشفّر هو نفسه بمفتاح KMS. فيحتاج المهاجم الآن نسخة etcd الاحتياطية وصلاحية IAM لفك التشفير بمفتاح KMS معًا — ضابطا وصول مستقلان. وهذا يدعم متطلبات PCI-DSS لحماية المفاتيح التشفيرية والأسرار المخزنة."
    },
    {
      "text": "يحمّل تطبيق بيانات اعتماد قاعدة بياناته كمجلد سر Kubernetes (ملف)، بدل متغيرات البيئة. ويدوّر Vault بيانات الاعتماد ويحدّث External Secrets Operator سر Kubernetes. ما ميزة التحميل كمجلد على متغيرات البيئة للتدوير دون توقف؟",
      "options": [
        "تُحدّث متغيرات البيئة تلقائيًا حين يتغير السر، فلا فرق",
        "يحدّث kubelet الأسرار المحمّلة كمجلدات في مكانها خلال فترة المزامنة (60 ثانية افتراضيًا) دون إعادة تشغيل الـ pod. ويستطيع التطبيق اكتشاف تغيير الملف وإعادة قراءة بيانات الاعتماد. أما متغيرات البيئة فتُضبط عند بدء الحاوية ولا تتغير أبدًا — فيتطلب التدوير إعادة تشغيل الـ pod",
        "تشفّر عمليات التحميل كمجلد بيانات السر عند نقطة التحميل، فتوفر حماية إضافية مقارنة بمتغيرات البيئة",
        "تتيح عمليات التحميل كمجلد للتطبيق تخزين بيانات الاعتماد محليًا، فتقل استدعاءات واجهة Vault"
      ],
      "correct": 1,
      "explanation": "تُحقن متغيرات البيئة مرة واحدة عند بدء الحاوية من قيمة السر. وحين يُحدّث السر (بسبب التدوير)، تستمر الـ pods العاملة في استخدام القيمة القديمة — فتلزم إعادة تشغيل الـ pod لالتقاط بيانات الاعتماد الجديدة، مما يسبب توقفًا قصيرًا أو أخطاء اتصال أثناء إعادة التشغيل. أما الأسرار المحمّلة كمجلدات فيديرها kubelet، الذي يزامن محتوى الملف دوريًا مع قيمة السر الحالية (ضمن فترة مزامنة kubelet). ويستطيع تطبيق يراقب الملف إعادة قراءة بيانات الاعتماد وتحديث مجمّع اتصالات قاعدة البيانات دون إعادة تشغيل. وهذا النمط الموصى به لتدوير بيانات الاعتماد دون توقف."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "تدوير بيانات الاعتماد دون توقف مع HashiCorp Vault وExternal Secrets",
  "difficulty": "principal",
  "estimatedMinutes": 60,
  "tasks": [
    "اضبط محرك أسرار قاعدة البيانات في HashiCorp Vault لنسخة PostgreSQL: عرّف دورًا payment-api-role بـ TTL ساعة واحدة وصلاحيات CREATE/SELECT/INSERT/UPDATE على مخطط payments. واختبر إصدار بيانات الاعتماد بـ vault read database/creds/payment-api-role وتحقق من وجود المستخدم المولّد في PostgreSQL. واختبر الإلغاء اليدوي وتأكد من حذف المستخدم.",
    "انشر External Secrets Operator وأنشئ SecretStore محصورًا بمساحة الأسماء / مولّد VaultDynamicSecret يصادق على Vault بحساب خدمة مساحة الأسماء payments. وأنشئ ExternalSecret لـ payment-api بـ refreshInterval=50m (قبل انتهاء TTL الساعة) يجسّد بيانات الاعتماد الديناميكية كسر Kubernetes بالمفتاحين DB_USERNAME وDB_PASSWORD. وتحقق من إنشاء السر ومن عمل بيانات الاعتماد بالاتصال بـ PostgreSQL، ولاحظ أن كل تحديث ينشئ مستخدم قاعدة بيانات جديدًا.",
    "حمّل سر بيانات الاعتماد كمجلد (لا متغيرات بيئة) في Deployment ‏payment-api. ونفّذ مراقب ملفات في التطبيق يكتشف تغييرات ملف بيانات الاعتماد المحمّل ويحدّث مجمّع اتصالات HikariCP دون إعادة تشغيل الـ pod. وحاكِ تدوير بيانات الاعتماد بإطلاق تحديث ESO يدويًا، وتحقق من استمرار التطبيق في معالجة الطلبات دون فجوة في التوفر.",
    "فعّل تشفير etcd أثناء التخزين باستخدام مزوّد KMS (أو AES-CBC كبديل للاختبار المحلي). واكتب سكربت تحقق يقرأ سر بيانات اعتماد payment-api مباشرة من etcd باستخدام etcdctl ويؤكد أن القيمة مشفرة (لا نص صريح قابل لفك ترميز base64). ووثّق ملف EncryptionConfiguration YAML وإجراء تدوير المفاتيح."
  ]
}
-->
