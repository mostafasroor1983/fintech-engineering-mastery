---
id: track-01-lesson-18
title: "Zero-Trust Security Architecture"
slug: zero-trust-architecture
track: track-01
trackName: "Advanced Software Architecture"
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

# Zero-Trust Security Architecture

Traditional network security assumes that anything inside the corporate perimeter is trustworthy. In a cloud-native fintech microservices environment, there is no perimeter. This lesson teaches you to design and implement a zero-trust architecture using SPIFFE/SPIRE workload identity, mTLS, Vault dynamic credentials, Kubernetes NetworkPolicy, and Istio AuthorizationPolicy — with explicit mapping to PCI-DSS requirements.

---

## 1. The Core Principle: Never Trust, Always Verify

Zero-trust is a security model, not a product. It rests on three axioms:

1. **No implicit trust** — a service inside the cluster has no more inherent trust than a request from the public internet
2. **Least-privilege access** — every workload gets only the permissions it needs, for only as long as it needs them
3. **Continuous verification** — identity and authorisation are re-evaluated on every request, not just at login

Applied to fintech microservices:

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

The zero-trust model treats every inter-service call as potentially hostile and requires cryptographic proof of identity before any communication is permitted.

---

## 2. SPIFFE/SPIRE Workload Identity

### 2.1 What SPIFFE Is

SPIFFE (Secure Production Identity Framework for Everyone) is a CNCF standard that defines:

- **SPIFFE ID** — a URI of the form `spiffe://trust-domain/path` uniquely identifying a workload
- **SVID** (SPIFFE Verifiable Identity Document) — an X.509 certificate or JWT carrying the SPIFFE ID
- **SPIFFE Bundle** — the trust bundle (root CA + intermediate CAs) used to verify SVIDs

```
  spiffe://fintech.internal/ns/payments/sa/payment-svc
  └───────────────────────────────────────────────────
  scheme  trust domain     path (namespace/serviceaccount/name)
```

### 2.2 SPIRE Architecture

SPIRE (SPIFFE Runtime Environment) is the reference implementation:

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

### 2.3 SVID Issuance and TTL-Based Rotation

SVIDs are short-lived (default 1-hour TTL). SPIRE Agents automatically rotate them before expiry, ensuring compromised credentials have minimal blast radius.

```java
/**
 * Demonstrates fetching an X.509 SVID from SPIRE via the
 * Workload API (gRPC on Unix domain socket /run/spire/sockets/agent.sock).
 *
 * In production use the official SPIFFE Helper sidecar or the
 * java-spiffe library instead of raw gRPC.
 */
@Component
public class SpiffeIdentityLoader {

    private static final String SPIRE_SOCKET =
        "unix:///run/spire/sockets/agent.sock";

    private volatile X509Certificate currentSvid;
    private volatile PrivateKey       currentKey;

    @PostConstruct
    public void startRotationLoop() {
        // java-spiffe library handles rotation automatically
        X509Source source = X509Source.newSource(
            X509Source.newOptions()
                .spiffeSocketPath(SPIRE_SOCKET)
                .build()
        );
        source.addListener(update -> {
            this.currentSvid = update.defaultSvid().certificates().get(0);
            this.currentKey  = update.defaultSvid().privateKey();
            log.info("SVID rotated, expires: {}",
                currentSvid.getNotAfter());
        });
    }

    public X509Certificate currentCertificate() {
        return currentSvid;
    }
}
```

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

## 3. mTLS Between Services

### 3.1 mTLS Overview

Mutual TLS means both sides of a connection present and verify an X.509 certificate. This provides:

- **Authentication** — each party proves cryptographic identity
- **Encryption** — all traffic is encrypted in transit
- **Non-repudiation** — certificates are auditable

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

### 3.2 Istio mTLS Configuration

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

### 3.3 Certificate Lifecycle

```
  SPIRE Agent                Envoy Sidecar             Upstream Service
      │                           │                           │
      │── SVID (X.509, 1h TTL) ──►│                           │
      │                           │── mTLS handshake ────────►│
      │                           │◄─ peer SVID verified ─────│
      │                           │                           │
      │  At T=55m (5m before      │                           │
      │  expiry), SPIRE Agent     │                           │
      │── new SVID ──────────────►│  hot-reload, no downtime  │
```

Istio's Envoy sidecar automatically picks up the new certificate without connection interruption.

---

## 4. HashiCorp Vault Dynamic Credentials

### 4.1 Why Dynamic Credentials Matter

Static database passwords embedded in environment variables or Kubernetes secrets are a PCI-DSS finding and an operational risk. Vault's Database Secrets Engine issues short-lived, unique credentials per workload.

```
  payment-svc Pod                  Vault Server              PostgreSQL
       │                               │                         │
       │── Vault login (SVID JWT) ────►│                         │
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

### 4.2 Vault Configuration

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

### 4.3 Spring Boot Integration via Vault Agent

```yaml
# vault-agent-config.hcl (runs as init container)
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
// The HikariCP connection pool will get new credentials on lease renewal
// if Vault Agent re-renders the template before TTL expiry.
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
        // Allow pool reconnect on credential rotation
        config.setConnectionTestQuery("SELECT 1");
        config.setMaxLifetime(Duration.ofMinutes(14).toMillis()); // < 15m Vault TTL
        return new HikariDataSource(config);
    }
}
```

---

## 5. Kubernetes NetworkPolicy: Default-Deny Baseline

### 5.1 Default-Deny-All

Kubernetes pods can reach any other pod by default. The first step in zero-trust networking is to deny all ingress and egress, then selectively re-allow.

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

### 5.2 Selective Allow Rules

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
              name: vault
      ports:
        - port: 8200
    - ports:                 # DNS (kube-dns)
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

### 5.3 Namespace Isolation

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

## 6. Istio AuthorizationPolicy: JWT + mTLS Enforcement

### 6.1 Layer-7 Policy

NetworkPolicy operates at Layer 4 (IP/port). Istio AuthorizationPolicy operates at Layer 7 (HTTP method, path, headers, JWT claims).

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
# Deny everything else (implicit deny)
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

### 6.2 JWT Validation

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

## 7. OPA/Rego for Fine-Grained Authorisation

Istio AuthorizationPolicy handles coarse-grained access. For attribute-based access control (ABAC) — e.g., "a teller can only approve transactions below their authorised limit" — use OPA.

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

## 8. PCI-DSS Mapping

### 8.1 Requirement 1 — Network Segmentation

PCI-DSS Requirement 1 mandates that cardholder data environment (CDE) systems are isolated from non-CDE systems.

| Zero-Trust Control | PCI-DSS Req 1 Mapping |
|---|---|
| Kubernetes NetworkPolicy `default-deny-all` | Req 1.3.1: Restrict inbound traffic to only what is necessary |
| Namespace isolation with `namespaceSelector` | Req 1.3.2: Restrict outbound traffic to only necessary connections |
| Istio mTLS STRICT in CDE namespace | Req 1.2.1: Configuration standards for all security components |

### 8.2 Requirement 7 — Access Control

PCI-DSS Requirement 7 mandates least-privilege access for all systems.

| Zero-Trust Control | PCI-DSS Req 7 Mapping |
|---|---|
| SPIFFE SVID per workload | Req 7.1: Limit access to system components only to those individuals whose job requires such access |
| Vault dynamic credentials (15-min TTL) | Req 7.2.3: Revoke access immediately when no longer needed |
| Istio AuthorizationPolicy (service-to-service) | Req 7.3.2: All access control systems are in use |
| OPA ABAC policies | Req 7.3.1: Implement an access control model based on least privilege |

---

## 9. Production Pitfalls

### Pitfall 1: mTLS certificate expiry during peak traffic

**Scenario:** SPIRE Server becomes unavailable during Black Friday peak. SVID TTL (1 h) elapses. All inter-service calls fail with TLS handshake errors.

```java
// BAD: No retry or fallback for SVID fetch
X509Source source = X509Source.newSource(options);  // throws if SPIRE unavailable

// GOOD: Use SPIRE Agent caching + exponential backoff
// The SPIRE Agent caches SVIDs on disk. Configure the agent with:
// trust_bundle_path = "/run/spire/bundle/bundle.crt"
// sds.enabled = true          ← Istio/Envoy uses SDS, not direct API

// Also configure Envoy's min_ttl for certificate reload:
// envoyFilter sets secret_manager_config.tls_session_ticket_key_rotation_interval
// to 10 min less than SVID TTL, ensuring proactive rotation.

// Operational fix: SPIRE Server HA with 3 replicas + etcd backend
```

**Fix:** Run SPIRE Server with HA (3 replicas, etcd backend). Configure SPIRE Agent `x509_svid_ttl` to 4h with rotation at 50% TTL (2h headroom). Set Kubernetes readiness probe on the SPIRE Agent pod to block pod scheduling if agent is unhealthy.

### Pitfall 2: OPA policy evaluation adds latency to every request

**Scenario:** OPA is called synchronously on every HTTP request. Under load, p99 OPA response time reaches 200 ms, violating the 300 ms card network SLA.

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

**Fix:** Deploy OPA as a sidecar container (`localhost:8181`) with bundle replication from a central OPA management server. Local Rego evaluation is sub-millisecond. Policy updates propagate via bundle polling (default 60s).

### Pitfall 3: NetworkPolicy blocks DNS resolution

**Scenario:** Default-deny-all is applied. All pods immediately fail to resolve service names. DNS queries to `kube-dns` on UDP/53 are blocked.

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

**Fix:** Every egress NetworkPolicy must include a rule permitting UDP/53 and TCP/53 to `kube-dns` (namespace `kube-system`, label `k8s-app: kube-dns`). Automate this via an OPA/Gatekeeper admission webhook that rejects NetworkPolicies lacking the DNS egress rule.

---

## 10. Production Checklist

- [ ] SPIRE Server deployed with HA (3 replicas, etcd backend), not embedded SQLite
- [ ] All namespaces have `default-deny-all` NetworkPolicy as baseline
- [ ] Istio `PeerAuthentication` set to STRICT mTLS in all CDE namespaces
- [ ] PERMISSIVE mTLS used only during migration with a tracked deadline for removal
- [ ] Vault Database Secrets Engine configured for all database connections
- [ ] Vault lease TTL is less than HikariCP `maxLifetime` to prevent stale connection errors
- [ ] Istio `AuthorizationPolicy` denies all traffic by default; only explicit ALLOW rules grant access
- [ ] OPA deployed as sidecar with bundle replication; never as a remote synchronous call
- [ ] DNS egress (UDP/53, TCP/53) explicitly permitted in all Egress NetworkPolicies
- [ ] PCI-DSS Requirement 1 and 7 mapping documented in an ADR for the security team
- [ ] SPIFFE trust bundle rotation tested quarterly (simulate SPIRE Server unavailability)
- [ ] Admission webhook (OPA Gatekeeper or Kyverno) prevents privileged pods in CDE namespaces
- [ ] Service accounts have `automountServiceAccountToken: false` unless required

---

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "A SPIFFE SVID has a 1-hour TTL. SPIRE Server becomes unavailable at T=50min. What happens to running services?",
      "options": [
        "All inter-service calls immediately fail because Envoy cannot validate certificates",
        "The SPIRE Agent's cached SVID remains valid for the remaining 10 minutes; calls fail only after full expiry if SPIRE is still down",
        "Istio automatically falls back to plaintext HTTP when mTLS certificates expire",
        "Services continue indefinitely because Kubernetes Service discovery bypasses mTLS"
      ],
      "correct": 1,
      "explanation": "SPIRE Agents cache SVIDs locally. The cached certificate is cryptographically valid until its NotAfter field. Services continue operating for the remaining TTL. The risk is if SPIRE Server is still unavailable when rotation would normally occur, leaving no path to get a fresh SVID. This is why HA SPIRE Server and longer TTLs with early rotation (e.g., rotate at 50% TTL) are production requirements."
    },
    {
      "text": "Which PCI-DSS requirement is most directly satisfied by Vault dynamic database credentials with 15-minute TTL?",
      "options": [
        "Requirement 3 — Protect stored cardholder data",
        "Requirement 6 — Develop and maintain secure systems",
        "Requirement 7.2.3 — Revoke access immediately when no longer needed",
        "Requirement 10 — Log and monitor all access"
      ],
      "correct": 2,
      "explanation": "PCI-DSS Requirement 7.2.3 requires that access is revoked immediately when it is no longer needed. Dynamic credentials with a 15-minute TTL automatically expire, meaning a compromised credential is useless in under 15 minutes without any manual revocation action. This is a stronger control than static passwords which must be manually rotated."
    },
    {
      "text": "A team applies default-deny-all NetworkPolicy to the payments namespace. All service-to-service calls immediately fail. What is the most likely cause?",
      "options": [
        "Istio mTLS is not configured for the namespace",
        "The Kubernetes CNI plugin does not support NetworkPolicy",
        "DNS resolution (UDP/53 to kube-dns) is blocked by the egress deny rule",
        "The SPIRE Agent cannot reach the SPIRE Server"
      ],
      "correct": 2,
      "explanation": "When a default-deny-all NetworkPolicy blocks all egress, DNS queries to kube-dns (port 53/UDP) are also blocked. Without DNS, service names cannot resolve to IP addresses, causing all outbound connections to fail even before mTLS or authentication is involved. Every pod-level egress policy must explicitly permit DNS traffic."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "Zero-Trust Architecture — Hands-On Implementation",
  "difficulty": "advanced",
  "estimatedMinutes": 120,
  "tasks": [
    {
      "id": "task-01",
      "description": "Deploy SPIRE Server and Agent on a local Kubernetes cluster (kind or minikube). Create a ClusterSPIFFEID entry for a payment-svc pod. Write a Java integration test using the java-spiffe library that fetches the SVID for the payment-svc workload, asserts the SPIFFE ID matches spiffe://fintech.internal/ns/default/sa/payment-svc, and verifies the certificate's NotAfter is within 1 hour of issuance."
    },
    {
      "id": "task-02",
      "description": "Configure Vault with the Database Secrets Engine pointed at a local PostgreSQL container. Create a role with 15-minute TTL and least-privilege grants (SELECT, INSERT on the payments schema only). Write a Spring Boot application that reads Vault-rendered credentials from /vault/secrets/database.properties via spring.config.import and configures HikariCP with maxLifetime=14m. Write a test that verifies the application reconnects after a Vault lease expires."
    },
    {
      "id": "task-03",
      "description": "Write three Kubernetes NetworkPolicy manifests for the payments namespace: (1) default-deny-all ingress and egress, (2) allow payment-svc ingress from api-gateway namespace only on port 8080, (3) allow payment-svc egress to ledger-svc on 8080 and DNS on 53/UDP. Write a test using kubectl exec + curl that verifies (a) payment-svc cannot reach fraud-svc directly and (b) payment-svc can reach ledger-svc."
    },
    {
      "id": "task-04",
      "description": "Write an OPA Rego policy (payment_authz.rego) that: (a) allows tellers to approve transactions up to their approval_limit_cents, (b) allows operations role to approve any amount, (c) denies all actions targeting sanctioned_countries (loaded from an external data bundle), and (d) denies teller read access to transactions flagged as internal-fraud-review. Write OPA unit tests using rego_test.rego covering at least 6 cases including boundary conditions."
    }
  ]
} -->
