---
id: track-10-lesson-07
title: "Secret Management — Vault and External Secrets Operator"
slug: secret-management
track: track-10
trackName: "Cloud Platform & Kubernetes"
sequence: 7
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [secrets, HashiCorp-Vault, ESO, rotation, encryption-at-rest]
prerequisites: [track-10-lesson-06]
---

# Secret Management — Vault and External Secrets Operator

> [!NOTE]
> Leaked and hard-coded credentials are one of the most common starting points of data breaches. HashiCorp Vault with dynamic secrets means no one ever knows the production database password — not the DBA, not the application developer, not the platform engineer. The credential exists for the duration of its lease and is then destroyed. This is the strongest common pattern for managing application credentials in a PCI-DSS environment.

(Vault has been under the Business Source Licence since 2023; **OpenBao** is an open-source fork with a compatible API. The concepts in this lesson apply to both.)

## Why Kubernetes Secrets Alone Are Not Enough

By default, Kubernetes Secrets are:
- Base64-encoded (not encrypted) in etcd
- Readable by anyone with `kubectl get secret` permissions in the namespace
- Stored in Git if you accidentally `kubectl get secret -o yaml` and commit the output
- Not rotated automatically

For financial services handling cardholder data, these properties make it hard to meet PCI-DSS requirement 3 (protect stored account data and the keys that protect it) and requirement 8 (identify users and authenticate access, including rules for system and application account passwords).

The solution is a layered approach:
1. **Vault** as the secret backend (dynamic credentials, audit logging, encryption)
2. **External Secrets Operator** to sync from Vault into Kubernetes Secrets
3. **Kubernetes etcd encryption** as a defence-in-depth measure (managed services such as EKS now encrypt Secrets with KMS envelope encryption by default — verify yours)

---

## 1. HashiCorp Vault Architecture

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

### Vault Installation with HA Raft Storage

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

## 2. Dynamic Database Credentials

Dynamic secrets are Vault's killer feature for financial platforms. Instead of a static password that never changes, Vault creates a temporary database user with a TTL. When the lease expires, Vault drops the user. No rotation scripts, no downtime, no shared passwords.

### Configure Vault Database Secret Engine

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

### Vault Policy for Payment Processor

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

## 3. External Secrets Operator (ESO)

ESO is a Kubernetes controller that syncs secrets from external backends (Vault, AWS Secrets Manager, GCP Secret Manager) into Kubernetes Secrets. Applications consume standard Kubernetes Secrets — they do not need to know about Vault.

Least privilege: a `ClusterSecretStore` authenticates as ONE identity that can read every team's secrets. For regulated namespaces, prefer a namespaced `SecretStore` per namespace that authenticates with that namespace's service account and Vault role.

### ESO Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set replicaCount=2
```

### ClusterSecretStore (Vault Backend)

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

### ExternalSecret for Payment Service

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

## 4. Vault Agent Injector (Alternative to ESO)

The Vault Agent Injector is the alternative when secrets should not exist as Kubernetes Secret objects at all: a Vault Agent sidecar authenticates as the pod, writes the secrets into a shared in-memory volume, and keeps renewing leases and re-rendering the files. (The Vault CSI provider and the Vault Secrets Operator are further options.)

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

## 5. Kubernetes Secret Encryption at Rest

By default (self-managed clusters), Kubernetes Secrets are stored in etcd unencrypted — base64 is only an encoding. Enable KMS encryption so secrets are encrypted at rest using a key in AWS KMS (or another KMS). On managed services this is a cluster setting — EKS, for example, enables KMS envelope encryption of Secrets by default on current versions.

### KMS Encryption Configuration

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

## 6. Secret Rotation Without Downtime

For the payment processor, secret rotation must happen without restarting pods. The pattern is:

1. ESO syncs new credentials from Vault into the Kubernetes Secret
2. The Kubernetes Secret is mounted as a volume (env vars are set once at start-up and never change)
3. The application notices the new file content and switches its connection pool to the new credential — before the old one expires

For zero-downtime rotation, mount secrets as **volumes** (not env vars). The kubelet updates volume-mounted secrets automatically when the Secret changes (typically within a minute or two; **not** for `subPath` mounts); env vars require a pod restart.

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

## 7. PCI-DSS Requirements for Key Management

The table uses the requirement numbers of PCI DSS v3.2.1 (3.6.x). In PCI DSS v4.0 the same controls are in requirements 3.6 and 3.7 (key management processes, 3.7.1–3.7.8). Note that they cover the *cryptographic keys* that protect account data; database and API credentials fall under requirement 8 (e.g. 8.3 and 8.6 for application and system accounts).

| Requirement (v3.2.1) | Implementation |
|---|---|
| 3.6.1: Document cryptographic key procedures | Vault audit log + runbook in Git |
| 3.6.2: Distribute keys securely | Vault transit engine (wrap/unwrap) |
| 3.6.3: Store keys securely | Vault + AWS KMS envelope encryption |
| 3.6.4: Rotate keys periodically | Vault key rotation (database TTL + KV version) |
| 3.6.5: Retire old keys | Vault key revocation + ESO secret deletion |
| 3.6.7: Prevent unauthorized key substitution | RBAC + Kyverno: only ESO can create/update secrets |

### Vault Audit Logging Configuration

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

## Production Checklist

- [ ] Vault deployed in HA mode (3 replicas minimum) with auto-unseal via AWS KMS
- [ ] Database secret engine configured with dynamic credentials for all production databases
- [ ] Credential TTL set to 1 hour; max TTL set to 4 hours
- [ ] Vault policy per ServiceAccount — least-privilege access
- [ ] ESO syncing all secrets into Kubernetes; no manually created Secrets in production
- [ ] ESO refresh interval < Vault credential TTL, with enough margin for the kubelet sync and the application's pool switch-over
- [ ] Kubernetes etcd encrypted at rest via KMS provider
- [ ] Secrets mounted as volumes (not env vars) for zero-downtime rotation
- [ ] Vault audit log shipped to SIEM (every credential access is logged)
- [ ] Kyverno policy: only ESO ServiceAccount can update Secrets in production namespaces
- [ ] No plaintext secrets in ConfigMaps, Helm values files, or Git repositories
- [ ] Annual DR drill: test Vault restore from backup with key re-encryption

---

## Summary

Vault dynamic secrets eliminate the concept of a long-lived database password in a financial platform. The credential exists for one hour, is known only to the application pod that requested it, and is automatically revoked when the lease expires. External Secrets Operator bridges Vault to Kubernetes without changing application code — services still consume standard Kubernetes Secrets, but those secrets are sourced from Vault and refreshed automatically. KMS-backed etcd encryption ensures that even if someone extracts the etcd database, they cannot read the secrets without access to the KMS key. This layered approach covers the credential and key management controls PCI-DSS asks for, with an audit trail that shows exactly who accessed what credential and when.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Vault's database secret engine is configured with a TTL of 1 hour for payment-api credentials. The payment-api pod has been running for 55 minutes. What happens at the 60-minute mark if the application does not renew the lease?",
      "options": [
        "The credential is rotated by Vault and the pod automatically receives the new password via environment variable",
        "The lease expires and Vault revokes the credential — the database user is dropped. New connections with it fail, and the application must obtain a new credential from Vault and switch its connection pool over",
        "The credential continues to work indefinitely — TTL is only advisory for database credentials",
        "Vault extends the lease automatically for all credentials that are still in use"
      ],
      "correct": 1,
      "explanation": "Vault dynamic credentials have a lease. When it expires (and it is not renewed, or max_ttl is reached), Vault runs the role's revocation statements against the database, dropping or disabling the user; the PostgreSQL VALID UNTIL clause also blocks new logins after expiry. New connections with the old credential fail, and depending on the database and the revocation statements, existing sessions may be terminated too. The application must obtain a fresh credential (new username and password) before that point: by renewing the lease (Vault Agent does this), or by picking up the new credential that ESO fetched and switching the connection pool. Note that ESO does not renew leases — each refresh creates a NEW credential — and credentials injected as environment variables require a pod restart."
    },
    {
      "text": "A Kubernetes Secret containing a database password is stored in etcd without encryption at rest. An attacker gains read access to the etcd backup file. What is the attack surface and how does KMS-backed etcd encryption mitigate it?",
      "options": [
        "etcd data is base64 encoded, which provides sufficient protection against casual attackers",
        "Without encryption, the attacker can base64-decode the Secret value directly from the etcd backup and obtain the plaintext credential. KMS encryption wraps the data encryption key with a KMS master key — the attacker would also need access to the KMS key to decrypt, which is controlled by IAM policies",
        "Kubernetes Secrets are encrypted at rest by default in all versions after 1.20",
        "The attacker would need the etcd TLS certificate to read the backup, which provides equivalent protection to KMS encryption"
      ],
      "correct": 1,
      "explanation": "Kubernetes Secrets are base64 encoded, NOT encrypted, unless encryption at rest is configured (self-managed clusters have it off by default; some managed services now turn it on). An attacker with access to the etcd backup can base64-decode any Secret value and read it in plaintext. KMS-backed encryption at rest (EncryptionConfiguration with a kms provider) encrypts Secret data with a data encryption key (DEK), which is itself encrypted with a KMS key. The attacker now needs both the etcd backup AND IAM permission to decrypt with the KMS key — two independent access controls. This supports the PCI-DSS requirements on protecting cryptographic keys and stored secrets."
    },
    {
      "text": "An application mounts its database credentials as a Kubernetes Secret volume (a file), rather than as environment variables. Vault rotates the credential and External Secrets Operator updates the Kubernetes Secret. What is the advantage of volume mounts over environment variables for zero-downtime rotation?",
      "options": [
        "Environment variables are updated automatically when the Secret changes, so there is no difference",
        "Volume-mounted Secrets are updated in-place by the kubelet within the syncPeriod (default 60s) without restarting the pod. The application can detect the file change and re-read the credential. Environment variables are set at container startup and never change — a rotation requires a pod restart",
        "Volume mounts encrypt the Secret data at the mount point, providing extra protection compared to environment variables",
        "Volume mounts allow the application to cache the credential locally, reducing Vault API calls"
      ],
      "correct": 1,
      "explanation": "Environment variables are injected once at container startup from the Secret value. When the Secret is updated (due to rotation), running pods continue using the old value — a pod restart is required to pick up the new credential, causing brief downtime or connection errors during the restart. Volume-mounted Secrets are managed by the kubelet, which periodically syncs the file contents with the current Secret value (within the kubelet's syncPeriod). An application watching the file can re-read the credential and refresh its database connection pool without restarting. This is the recommended pattern for zero-downtime credential rotation."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Zero-Downtime Credential Rotation with HashiCorp Vault and External Secrets",
  "difficulty": "principal",
  "estimatedMinutes": 60,
  "tasks": [
    "Configure HashiCorp Vault's database secret engine for a PostgreSQL instance: define a role payment-api-role with a 1-hour TTL and CREATE/SELECT/INSERT/UPDATE privileges on the payments schema. Test credential issuance with vault read database/creds/payment-api-role and verify the generated user exists in PostgreSQL. Test manual revocation and confirm the user is dropped.",
    "Deploy External Secrets Operator and create a namespaced SecretStore / VaultDynamicSecret generator that authenticates to Vault with the payments namespace's service account. Create an ExternalSecret for the payment-api with refreshInterval=50m (before the 1h TTL expires) that materialises the dynamic credentials as a Kubernetes Secret with keys DB_USERNAME and DB_PASSWORD. Verify the Secret is created and the credentials work by connecting to PostgreSQL, and observe that each refresh creates a new database user.",
    "Mount the credentials Secret as a volume (not environment variables) in the payment-api Deployment. Implement a file-watcher in the application that detects changes to the mounted credential file and refreshes the HikariCP connection pool without restarting the pod. Simulate credential rotation by manually triggering ESO refresh, and verify the application continues processing requests without a gap in availability.",
    "Enable etcd encryption at rest using a KMS provider (or AES-CBC as a fallback for local testing). Write a verification script that reads the payment-api credentials Secret directly from etcd using etcdctl and confirms the value is encrypted (not base64-decodable plaintext). Document the EncryptionConfiguration YAML and the key rotation procedure."
  ]
}
-->
