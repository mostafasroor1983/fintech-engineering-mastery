---
id: track-11-lesson-09
title: "Zero-Trust Security — Identity-Based Access for Microservices"
slug: zero-trust-security
track: track-11
trackName: "Security & Observability Engineering"
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

# Zero-Trust Security — Identity-Based Access for Microservices

Traditional network security draws a perimeter around the data center and assumes everything inside is trusted. For modern fintech microservices distributed across cloud regions, that assumption is fatal. A single compromised service can laterally move across the entire internal network. Zero-trust replaces perimeter faith with continuous verification of identity, context, and intent — every request, every time.

---

## 1. Zero-Trust Principles

Three foundational principles define zero-trust:

**Never trust, always verify** — no network location grants implicit trust. Even a service on the same pod subnet must authenticate before accessing resources.

**Assume breach** — design systems as if an attacker already has a foothold in the internal network. Limit blast radius through segmentation, short-lived credentials, and comprehensive audit logging.

**Least privilege** — grant only the permissions a workload needs for its specific function at the time it needs them. A payment-service has no business reading fraud-model training data.

---

## 2. Traditional Perimeter vs Zero-Trust

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

## 3. SPIFFE and SPIRE

**SPIFFE** (Secure Production Identity Framework for Everyone) is an open standard for workload identity. It defines:

- **SVID** (SPIFFE Verifiable Identity Document) — the credential a workload presents.
- **X.509 SVID** — an X.509 certificate with a URI SAN in the format `spiffe://trust-domain/workload`.
- **JWT SVID** — a JWT token carrying the SPIFFE ID as the `sub` claim, used for HTTP API calls.

**SPIRE** (SPIFFE Runtime Environment) is the reference implementation that issues and rotates SVIDs.

### SPIFFE ID Format

```
spiffe://trust-domain/path
         ─────────────────  ──────────────
         your organisation  workload path

Examples:
spiffe://fintech.example.com/ns/payments/sa/payment-service
spiffe://fintech.example.com/ns/fraud/sa/fraud-detection-service
spiffe://fintech.example.com/ns/core/sa/account-service
```

### SPIRE Architecture

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

### SPIRE Server Configuration

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

### Registration Entry for Payment Service

In Kubernetes, the **SPIRE Controller Manager** usually creates these entries automatically from `ClusterSPIFFEID` resources (e.g. one template `spiffe://fintech.example.com/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}`). The manual equivalent for one workload:

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

## 4. mTLS Between Services with Istio

Istio automates mTLS using SPIFFE-compatible SVIDs issued by its own CA (Citadel/istiod). The sidecar proxies handle the TLS handshake transparently.

### Enforce STRICT mTLS Across the Payments Namespace

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

### Per-Port Exceptions (Legacy Integration)

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

## 5. Vault Dynamic Credentials

Vault's database secrets engine generates short-lived database credentials on demand. No service ever holds a long-lived password.

### Vault Configuration for Payment Service DB

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

### Spring Boot Vault Integration

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

## 6. Kubernetes NetworkPolicy — Default Deny All

NetworkPolicy operates at Layer 3/4 and enforces which pods can communicate using IP and port rules.

### Default Deny All Ingress and Egress

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

### Selective Allow: Payment Service to PostgreSQL

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

### Allow DNS Resolution (Required With Default Deny)

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

## 7. Istio AuthorizationPolicy

AuthorizationPolicy operates at Layer 7 and can enforce JWT claims alongside mTLS peer identity.

### Payment Service: Only Accept Requests From API Gateway

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

No separate "deny everything else" policy is needed: as soon as one ALLOW policy applies to a workload, every request that matches no ALLOW rule is denied. Do **not** add a DENY policy with an empty rule (`rules: [{}]`) — DENY policies are evaluated *before* ALLOW policies, so it would block every request, including the allowed ones.

---

## 8. OPA/Rego Policy: Service-to-Service Access Control

Open Policy Agent (OPA) provides fine-grained authorisation decisions beyond what Istio's AuthorizationPolicy can express.

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

## 9. PCI-DSS Mapping

| PCI-DSS Requirement | Zero-Trust Control |
|--------------------|--------------------|
| Req 1: Network security controls / segmentation | NetworkPolicy default-deny-all; Istio mesh policies |
| Req 2: Secure configurations (no default credentials) | No vendor-default or shared passwords; hardened defaults |
| Req 7: Restrict access to system components | AuthorizationPolicy; OPA service-to-service rules |
| Req 8: Identify and authenticate access (incl. 8.6 system/application accounts) | SPIFFE SVID; mTLS mutual authentication; Vault dynamic credentials |
| Req 4: Encryption in transit | mTLS between all services |
| Req 10: Audit logging | Istio access logs; OPA decision logs; Vault audit log |

---

## Production Pitfalls

### Pitfall 1: PERMISSIVE mTLS Mode Left in Production

Istio defaults to `PERMISSIVE` mode during migration, which accepts both plaintext and mTLS connections. Teams forget to switch to `STRICT` after migration, leaving plaintext lateral movement possible.

**Fix**: enforce `STRICT` PeerAuthentication at the namespace level and validate with:

```bash
# Check all namespaces for non-STRICT mTLS
kubectl get peerauthentication -A -o jsonpath='{range .items[*]}{.metadata.namespace}: {.spec.mtls.mode}{"\n"}{end}'

# Expected: payments: STRICT
# Alert if any namespace is PERMISSIVE or missing
```

Add a CI policy check that fails if any `PeerAuthentication` in a financial namespace is not `STRICT`.

### Pitfall 2: Long-Lived Static DB Credentials Alongside Dynamic Vault Credentials

A team rotates to Vault dynamic credentials in application code but forgets a cron job and a data pipeline that still use the old static password stored in a Kubernetes Secret. The static credential never expires and is not audited.

**Fix**: audit all database users, disable any not managed by Vault, and enforce a policy that all database credentials must have an expiry.

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

### Pitfall 3: NetworkPolicy Breaks DNS and Causes Silent Service Failures

Applying a default-deny-all NetworkPolicy without explicitly allowing DNS egress causes all service discovery to fail silently. Services can still start but all outbound connections fail with `UnknownHostException` rather than a connection refused error, making diagnosis difficult.

**Fix**: always apply the DNS egress NetworkPolicy before the default-deny-all, and validate with:

```bash
# Test DNS resolution from within the payment-service pod
kubectl exec -n payments deploy/payment-service -- \
  nslookup postgres.data.svc.cluster.local

# Test connectivity to postgres
kubectl exec -n payments deploy/payment-service -- \
  nc -zv postgres.data.svc.cluster.local 5432
```

Add a network connectivity smoke test to your readiness probe logic or post-deployment integration tests.

---

## Production Checklist

- [ ] SPIRE server deployed with Kubernetes PSAT attestation
- [ ] All financial-namespace workloads have SPIFFE registration entries
- [ ] SVID TTL is 1 hour or less; rotation at 50% TTL verified in SPIRE logs
- [ ] PeerAuthentication STRICT enforced on all financial namespaces
- [ ] `kubectl get peerauthentication -A` shows no PERMISSIVE namespaces
- [ ] Vault database secrets engine enabled with per-service roles
- [ ] DB credential TTL is 1 hour; Vault lease renewal tested
- [ ] No static Kubernetes Secrets contain database passwords
- [ ] NetworkPolicy default-deny-all applied to all financial namespaces
- [ ] DNS egress NetworkPolicy applied before default-deny
- [ ] Network connectivity smoke tests pass after every deployment
- [ ] Istio AuthorizationPolicy denies all unlisted service-to-service calls
- [ ] OPA policies committed to git; PCI-DSS control mapping documented
- [ ] Vault audit log enabled and forwarded to SIEM

<!-- KNOWLEDGE-CHECK {"questions": [{"text": "A SPIFFE X.509 SVID for the payment-service in the payments namespace of the fintech.example.com trust domain should have which URI SAN?", "options": ["https://fintech.example.com/payments/payment-service", "spiffe://fintech.example.com/ns/payments/sa/payment-service", "CN=payment-service,OU=payments,O=fintech.example.com", "spiffe://payments/payment-service@fintech.example.com"], "correct": 1, "explanation": "SPIFFE SVIDs use the URI format spiffe://trust-domain/workload-path. The trust domain is the organisation identifier (fintech.example.com) and the path conventionally encodes the Kubernetes namespace and service account: /ns/<namespace>/sa/<service-account>. The HTTPS scheme and X.500 DN formats are not valid SPIFFE ID formats."}, {"text": "Vault issues a database credential with default_ttl=1h to the payment-service. The service has been running for 55 minutes when it needs to execute a database query. What happens?", "options": ["The query fails with an authentication error because the credential has expired.", "Spring Cloud Vault automatically renews the lease before expiry and the query succeeds with the same credential.", "Vault generates a new credential and Spring Cloud Vault transparently rotates the DataSource connection pool.", "The service must be restarted to obtain a new credential."], "correct": 1, "explanation": "Spring Cloud Vault's lease renewal monitors TTLs and renews leases before expiry. For a 1-hour TTL credential the lease is renewed well before the hour is up, and the same username and password stay valid — so the query succeeds. Renewal can only extend the lease up to max_ttl (2 hours here). After that Vault revokes the credential, and the application must obtain a new one and switch its connection pool: Spring Cloud Vault can request the new secret and publish an event, but it does not reconfigure an existing HikariCP pool by itself — that needs code (or a restart/rollout)."}, {"text": "A Kubernetes NetworkPolicy default-deny-all is applied to the payments namespace. Immediately afterwards, the payment-service pods log UnknownHostException when trying to reach account-service. What is the most likely cause?", "options": ["The account-service NetworkPolicy is blocking ingress from payments namespace.", "DNS egress on UDP/TCP port 53 to kube-dns was not explicitly allowed, so service discovery fails.", "Istio's PeerAuthentication is in STRICT mode preventing the connection.", "The payment-service SPIFFE SVID has expired."], "correct": 1, "explanation": "A default-deny-all NetworkPolicy blocks all egress, including DNS queries to kube-dns on port 53. Without DNS, service names like account-service.core.svc.cluster.local cannot be resolved, causing UnknownHostException before any TCP connection is attempted. The fix is to apply an explicit egress NetworkPolicy allowing UDP and TCP port 53 to the kube-dns pods in kube-system before applying the default-deny-all."}]} -->

<!-- PRACTICAL-CHALLENGE {"title": "Implement Zero-Trust Service Mesh for Payment Microservices", "difficulty": "advanced", "estimatedMinutes": 120, "tasks": [{"id": "1", "description": "Deploy SPIRE in a local kind cluster. Create SPIFFE registration entries for payment-service (spiffe://fintech.example.com/ns/payments/sa/payment-service) and account-service (spiffe://fintech.example.com/ns/core/sa/account-service) using Kubernetes PSAT attestation. Verify that each service fetches an X.509 SVID with the correct URI SAN and that the SVID rotates within 1 hour. Use spire-server entry show to confirm the registration."}, {"id": "2", "description": "Configure Vault's database secrets engine to issue PostgreSQL credentials for the payment-service with a 1-hour TTL and 2-hour max TTL. Create a Vault policy that allows only the payment-service Kubernetes service account to request credentials using the payment-service-role. Integrate with Spring Boot using spring-cloud-vault-config-databases, and add code that switches the HikariCP pool to a new credential before max TTL. Write an integration test that verifies the DataSource keeps working across a forced credential rotation."}, {"id": "3", "description": "Apply a default-deny-all NetworkPolicy to the payments namespace. Add explicit allow rules for: DNS (UDP/TCP 53 to kube-dns), payment-service to postgres on port 5432, payment-service to account-service on port 8080, and Prometheus scraping on port 8080. Apply PeerAuthentication STRICT to the payments namespace. Write a shell script that validates all connectivity rules pass and all blocked paths are actually blocked using kubectl exec and nc."}, {"id": "4", "description": "Write an OPA/Rego policy that enforces: payment-service can call account-service GET endpoints only, fraud-detection-service can call account-service GET endpoints only, no service can call payment-service except the api-gateway, and all other service-to-service calls are denied. Write OPA unit tests using rego_test for all four rules. Deploy the policy as an Envoy external authorization filter in Istio and verify with curl that an unauthorised call returns 403."}]} -->
