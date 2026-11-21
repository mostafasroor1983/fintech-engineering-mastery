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
- **Auditability** — every connection carries a verifiable workload identity that can be logged

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
      │  At T=30m (half the TTL), │                           │
      │  SPIRE Agent rotates:     │                           │
      │── new SVID ──────────────►│  hot-reload, no downtime  │
```

Istio's Envoy sidecar automatically picks up the new certificate (via SDS) without connection interruption.

> [!NOTE]
> Out of the box, Istio issues workload certificates from istiod's own CA with the trust domain `cluster.local`; it can instead be integrated with SPIRE. Whichever you use, the principals in `AuthorizationPolicy` must use the same trust domain as the certificates (`cluster.local/ns/...` below, or `fintech.internal/ns/...` with a SPIRE trust domain).

---

## 4. HashiCorp Vault Dynamic Credentials

### 4.1 Why Dynamic Credentials Matter

Static database passwords embedded in environment variables or Kubernetes secrets are hard to rotate, often shared, and a frequent audit finding (PCI DSS v4.0 Requirement 8.6 expects application and system account credentials to be managed and changed). Vault's Database Secrets Engine issues short-lived, unique credentials per workload.

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
              kubernetes.io/metadata.name: vault
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
| Istio mTLS STRICT in CDE namespace | Supports segmentation by authenticating every connection (Req 4.2.1 itself covers open, public networks) |

### 8.2 Requirements 7 and 8 — Access Control and Authentication

PCI-DSS Requirement 7 mandates least-privilege access; Requirement 8 covers identification and authentication, including application and system accounts.

| Zero-Trust Control | PCI-DSS v4.0 Mapping |
|---|---|
| SPIFFE SVID per workload | Req 8.6: application and system accounts are identified and managed — each workload has its own identity |
| Vault dynamic credentials (15-min TTL) | Req 8.6.3: application and system account passwords are protected against misuse and changed — here they expire automatically |
| Istio AuthorizationPolicy (service-to-service) | Req 7.2.1 / 7.2.2: a defined access control model, with access granted only where needed |
| OPA ABAC policies | Req 7.2.1: access control model enforcing least privilege for people (e.g. approval limits) |

---

## 9. Production Pitfalls

### Pitfall 1: mTLS certificate expiry during peak traffic

**Scenario:** SPIRE Server becomes unavailable during Black Friday peak. SVID TTL (1 h) elapses. All inter-service calls fail with TLS handshake errors.

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

**Fix:** Run SPIRE Server with HA (several replicas sharing a PostgreSQL or MySQL datastore). Set the server's `default_x509_svid_ttl` to 4h; agents rotate at half the TTL, giving about 2 hours to recover the server. Monitor the agents' health and their sync with the server.

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

- [ ] SPIRE Server deployed with HA (several replicas, shared PostgreSQL/MySQL datastore), not embedded SQLite
- [ ] All namespaces have `default-deny-all` NetworkPolicy as baseline
- [ ] Istio `PeerAuthentication` set to STRICT mTLS in all CDE namespaces
- [ ] PERMISSIVE mTLS used only during migration with a tracked deadline for removal
- [ ] Vault Database Secrets Engine configured for all database connections
- [ ] HikariCP `maxLifetime` is shorter than the credential lease, and the app picks up new credentials before the lease's `max_ttl`
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
        "The SVID already held by the agent and Envoy stays valid until its expiry (10 more minutes); calls fail only after that if SPIRE Server is still down",
        "Istio automatically falls back to plaintext HTTP when mTLS certificates expire",
        "Services continue indefinitely because Kubernetes Service discovery bypasses mTLS"
      ],
      "correct": 1,
      "explanation": "An SVID is valid until its NotAfter time whether or not SPIRE Server is reachable, so services keep working for the remaining TTL. The risk is that no fresh SVID can be issued while the server is down. Normally agents rotate at half the TTL, so a 1-hour TTL leaves only about 30 minutes of headroom — which is why HA SPIRE Server and a longer TTL (e.g. 4h, rotating at ~2h) are production requirements."
    },
    {
      "text": "Which PCI-DSS requirement is most directly satisfied by Vault dynamic database credentials with 15-minute TTL?",
      "options": [
        "Requirement 3 — Protect stored account data",
        "Requirement 6 — Develop and maintain secure systems and software",
        "Requirement 8.6 — Manage application and system accounts and their credentials (8.6.3: protect and change them)",
        "Requirement 10 — Log and monitor all access to system components and cardholder data"
      ],
      "correct": 2,
      "explanation": "PCI DSS v4.0 Requirement 8.6 covers application and system accounts; 8.6.3 requires their passwords to be protected against misuse and changed periodically. Dynamic credentials with a 15-minute TTL expire on their own and are unique per workload, so a leaked credential is useless within minutes without any manual rotation — a much stronger control than a static password."
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
