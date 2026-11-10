---
id: track-13-lesson-09
title: "Zero-Trust Security — Identity-Based Access for Microservices"
slug: zero-trust-security
track: track-13
trackName: "Security & Observability"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [zero-trust, mTLS, SPIFFE, identity, least-privilege]
prerequisites: [track-13-lesson-08]
---

# Zero-Trust Security — Identity-Based Access for Microservices

> [!NOTE]
> The perimeter security model—trust everything inside the network—fails catastrophically when an attacker compromises one internal service. Zero-trust replaces network location with cryptographic identity: every service proves who it is on every request, and receives only the permissions it needs for that specific operation.

## Zero-Trust Principles

Zero-trust is not a product—it is an architectural approach built on four principles that must all be implemented together:

**1. Never trust, always verify.** No request is trusted by virtue of network location. A service inside the Kubernetes cluster must authenticate just as rigorously as one outside it. This eliminates the "trusted internal network" assumption that attackers exploit after lateral movement.

**2. Least privilege.** Each service receives only the permissions required for its function, scoped as tightly as possible. The payment service can read and write transactions. It cannot read user passwords or write to the audit log directly. If a service is compromised, the blast radius is bounded by its permissions.

**3. Assume breach.** Design as if an attacker already has a foothold somewhere in your infrastructure. Use encryption between all services (mTLS) so that even if an attacker taps internal network traffic, they read nothing. Use short-lived credentials so that compromised tokens expire quickly.

**4. Verify explicitly.** Authentication and authorisation decisions use all available signals: identity, device health, network location, time, behaviour. A service that suddenly starts calling payment APIs it has never called before should trigger an alert even if its certificate is valid.

---

## SPIFFE/SPIRE for Workload Identity

The fundamental challenge in zero-trust for microservices is: how does Service A prove to Service B that it is Service A, and not a compromised container that obtained Service A's credentials?

**SPIFFE** (Secure Production Identity Framework for Everyone) is an open standard for workload identity. It defines:
- **SVID** (SPIFFE Verifiable Identity Document): a certificate (X.509) or JWT that proves a workload's identity
- **SPIFFE ID**: a URI that uniquely identifies a workload: `spiffe://example.com/ns/payments/sa/payment-service`
- **Trust domain**: the boundary within which SVIDs are trusted (`example.com`)

**SPIRE** (SPIFFE Runtime Environment) is the reference implementation: a server and node agents that issue SVIDs to workloads.

### SPIRE Architecture

```
┌─────────────────────────────────────────────────────────┐
│ SPIRE Server (Kubernetes deployment)                     │
│  - Root of trust for the trust domain                   │
│  - Stores workload registration entries                  │
│  - Signs SVIDs using the CA private key                  │
│  - Rotates SVIDs automatically before expiry             │
└─────────────────────────────────────────────────────────┘
              ↕ Attests node identity
┌─────────────────────────────────────────────────────────┐
│ SPIRE Node Agent (DaemonSet, one per Kubernetes node)    │
│  - Attests the node using Kubernetes node attestor       │
│  - Receives a node SVID from the SPIRE server            │
│  - Fetches workload SVIDs on behalf of pods on this node │
└─────────────────────────────────────────────────────────┘
              ↕ Workload API (UNIX socket)
┌─────────────────────────────────────────────────────────┐
│ Payment Service Pod                                      │
│  - SPIRE Workload API client fetches X.509 SVID         │
│  - SVID used for mTLS in all outbound connections        │
│  - SVID rotated automatically every 1 hour               │
└─────────────────────────────────────────────────────────┘
```

### SPIRE Server Configuration

```yaml
# spire-server.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-server
  namespace: spire
data:
  server.conf: |
    server {
      bind_address = "0.0.0.0"
      bind_port = "8081"
      trust_domain = "payments.example.com"
      data_dir = "/run/spire/data"
      log_level = "INFO"

      ca_subject {
        country = ["GB"]
        organization = ["Example Payments Ltd"]
        common_name = "payments.example.com"
      }

      # Short-lived SVIDs — reduced blast radius if compromised
      default_svid_ttl = "1h"
      ca_ttl = "24h"
    }

    plugins {
      DataStore "sql" {
        plugin_data {
          database_type = "postgres"
          connection_string = "postgresql://spire:${SPIRE_DB_PASSWORD}@postgres:5432/spire"
        }
      }

      NodeAttestor "k8s_psat" {
        plugin_data {
          clusters = {
            "payments-cluster" = {
              service_account_allow_list = ["spire:spire-agent"]
            }
          }
        }
      }

      KeyManager "disk" {
        plugin_data {
          keys_path = "/run/spire/data/keys.json"
        }
      }
    }
```

### Registering Workload Entries

```bash
# Register the payment-service workload
# SPIFFE ID: spiffe://payments.example.com/ns/payments/sa/payment-service
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://payments.example.com/ns/payments/sa/payment-service \
  -parentID spiffe://payments.example.com/spire/agent/k8s_psat/payments-cluster/node1 \
  -selector k8s:ns:payments \
  -selector k8s:sa:payment-service \
  -ttl 3600

# Register the fraud-service
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://payments.example.com/ns/payments/sa/fraud-service \
  -parentID spiffe://payments.example.com/spire/agent/k8s_psat/payments-cluster/node1 \
  -selector k8s:ns:payments \
  -selector k8s:sa:fraud-service \
  -ttl 3600
```

---

## mTLS Between All Services

Mutual TLS (mTLS) means both client and server present certificates. The server verifies the client's identity; the client verifies the server's identity. This provides:
- **Encryption**: all traffic is TLS-encrypted
- **Authentication**: both parties are verified
- **Integrity**: traffic cannot be tampered with

### mTLS with SPIFFE SVIDs in Java

```java
// Spring Boot — configure mTLS using SPIFFE SVID
// The SPIRE Workload API provides the certificate material

@Configuration
public class MtlsConfig {

    @Value("${spiffe.socket.path:/run/spire/sockets/agent.sock}")
    private String spiffeSocketPath;

    @Bean
    public SSLContext paymentServiceSslContext() throws Exception {
        // Fetch X.509 SVID from SPIRE via Workload API
        WorkloadApiClient client = WorkloadApiClient.newClient(
            new DefaultWorkloadApiClientOptions()
                .setSocketPath(spiffeSocketPath)
        );

        X509SvidResponse response = client.fetchX509Svid();
        X509Svid svid = response.getSvids(0);

        // Load our certificate (identity) and trust bundle (CA certs we trust)
        KeyStore keyStore  = loadKeyStore(svid.getX509Svid());
        KeyStore trustStore = loadTrustStore(response.getFederatedBundles());

        KeyManagerFactory kmf = KeyManagerFactory.getInstance("SunX509");
        kmf.init(keyStore, null);

        TrustManagerFactory tmf = TrustManagerFactory.getInstance("SunX509");
        tmf.init(trustStore);

        SSLContext sslContext = SSLContext.getInstance("TLSv1.3");
        sslContext.init(kmf.getKeyManagers(), tmf.getTrustManagers(), null);
        return sslContext;
    }

    @Bean
    public RestTemplate mtlsRestTemplate(SSLContext paymentServiceSslContext) {
        SSLConnectionSocketFactory socketFactory =
            new SSLConnectionSocketFactory(paymentServiceSslContext);

        CloseableHttpClient httpClient = HttpClients.custom()
            .setSSLSocketFactory(socketFactory)
            .build();

        return new RestTemplate(new HttpComponentsClientHttpRequestFactory(httpClient));
    }
}
```

### Authorising Based on SPIFFE ID

After mTLS authentication, the server knows the client's SPIFFE ID. Use it for authorisation:

```java
@Component
public class SpiffeAuthorisationFilter extends OncePerRequestFilter {

    // Only fraud-service and gateway are allowed to call the payment submission endpoint
    private static final Map<String, Set<String>> ENDPOINT_PERMISSIONS = Map.of(
        "/api/v1/payments", Set.of(
            "spiffe://payments.example.com/ns/payments/sa/api-gateway"
        ),
        "/internal/fraud-score", Set.of(
            "spiffe://payments.example.com/ns/payments/sa/fraud-service"
        )
    );

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        X509Certificate[] certs = (X509Certificate[])
            request.getAttribute("javax.servlet.request.X509Certificate");

        if (certs == null || certs.length == 0) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED,
                "mTLS certificate required");
            return;
        }

        // Extract SPIFFE ID from Subject Alternative Name
        String spiffeId = extractSpiffeId(certs[0]);
        String path = request.getRequestURI();

        Set<String> allowedIdentities = ENDPOINT_PERMISSIONS.get(path);
        if (allowedIdentities != null && !allowedIdentities.contains(spiffeId)) {
            log.warn("Unauthorised access attempt: spiffeId={} path={}", spiffeId, path);
            response.sendError(HttpServletResponse.SC_FORBIDDEN,
                "Service not authorised for this endpoint");
            return;
        }

        // Set SPIFFE ID as security principal for downstream use
        MDC.put("callerSpiffeId", spiffeId);
        chain.doFilter(request, response);
    }

    private String extractSpiffeId(X509Certificate cert) {
        // SPIFFE ID is in the URI SAN field
        try {
            Collection<List<?>> sans = cert.getSubjectAlternativeNames();
            if (sans != null) {
                for (List<?> san : sans) {
                    if ((Integer) san.get(0) == 6) {  // 6 = URI
                        String uri = (String) san.get(1);
                        if (uri.startsWith("spiffe://")) {
                            return uri;
                        }
                    }
                }
            }
        } catch (CertificateParsingException e) {
            log.error("Failed to parse SPIFFE ID from certificate", e);
        }
        return null;
    }
}
```

---

## Just-in-Time Access with HashiCorp Vault

Static, long-lived credentials (database passwords, API keys) are a primary attack vector. Just-in-time access generates short-lived credentials on demand.

### Vault Dynamic Database Credentials

```hcl
# vault-policy-payment-service.hcl
# payment-service can only generate read/write credentials for the payments database
# It cannot access other databases, Vault's own metadata, or other services' policies

path "database/creds/payment-service-role" {
  capabilities = ["read"]
}

# payment-service cannot read its own policy or other policies
path "sys/policies/*" {
  capabilities = ["deny"]
}

# payment-service cannot access secrets for other services
path "secret/data/fraud-service/*" {
  capabilities = ["deny"]
}
```

```java
// Spring Cloud Vault — dynamic database credentials
@Configuration
public class VaultDatabaseConfig {

    @Bean
    public DataSource vaultManagedDataSource(VaultTemplate vaultTemplate) {
        // Fetch dynamic credentials from Vault — unique per pod, 1 hour TTL
        VaultResponse response = vaultTemplate.read("database/creds/payment-service-role");
        String username = (String) response.getData().get("username");
        String password = (String) response.getData().get("password");
        long leaseDurationSeconds = response.getLeaseDuration();

        log.info("Obtained Vault dynamic DB credentials, lease expires in {}s",
            leaseDurationSeconds);

        // Schedule credential renewal before expiry
        scheduleRenewal(response.getLeaseId(), leaseDurationSeconds);

        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:postgresql://postgres:5432/payments");
        ds.setUsername(username);
        ds.setPassword(password);
        return ds;
    }
}
```

---

## Kubernetes NetworkPolicy for Micro-Segmentation

Network policies are the Kubernetes mechanism for enforcing which pods can communicate with each other. They implement zero-trust at the network layer.

```yaml
# Default-deny all ingress and egress for the payments namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: payments
spec:
  podSelector: {}  # Applies to all pods
  policyTypes:
  - Ingress
  - Egress

---
# payment-service: allow ingress only from api-gateway
# and egress only to database, kafka, and fraud-service
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-service-policy
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-service
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: api-gateway
    ports:
    - protocol: TCP
      port: 8080
  egress:
  # Postgres
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: data
      podSelector:
        matchLabels:
          app: postgresql
    ports:
    - protocol: TCP
      port: 5432
  # Kafka
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kafka
    ports:
    - protocol: TCP
      port: 9093
  # Fraud service (mTLS)
  - to:
    - podSelector:
        matchLabels:
          app: fraud-service
    ports:
    - protocol: TCP
      port: 8443
  # DNS resolution (required for all pods)
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
  # SPIRE agent (for SVID fetching)
  - to:
    - podSelector:
        matchLabels:
          app: spire-agent
    ports:
    - protocol: TCP
      port: 8081

---
# fraud-service: allow ingress only from payment-service
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: fraud-service-policy
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: fraud-service
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: payment-service
    ports:
    - protocol: TCP
      port: 8443
```

---

## Service Account Per Service

Each service must run with its own Kubernetes ServiceAccount—never the default service account, never a shared account.

```yaml
# service-accounts.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: payments
  annotations:
    # For AWS EKS: bind to an IAM role (least privilege)
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789:role/payment-service-role"
automountServiceAccountToken: true

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fraud-service
  namespace: payments
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789:role/fraud-service-role"
automountServiceAccountToken: true

---
# RBAC: payment-service can only read/write its own ConfigMaps
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payment-service-role
  namespace: payments
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["payment-service-config"]
  verbs: ["get", "watch"]
# payment-service cannot list all configmaps, cannot access secrets directly
# It gets secrets via Vault dynamic credentials

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payment-service-binding
  namespace: payments
subjects:
- kind: ServiceAccount
  name: payment-service
  namespace: payments
roleRef:
  kind: Role
  name: payment-service-role
  apiGroup: rbac.authorization.k8s.io
```

---

## Monitoring Zero-Trust Violations

Zero-trust generates security signals that must be monitored. An authentication failure between two internal services indicates either misconfiguration or an attack.

```java
// Security event logging for zero-trust violations
@Component
public class ZeroTrustAuditLogger {

    private final Counter mTlsFailures;
    private final Counter unauthorisedSpiffeAccess;

    public ZeroTrustAuditLogger(MeterRegistry registry) {
        this.mTlsFailures = Counter.builder("zero_trust.mtls.failures")
            .description("mTLS authentication failures")
            .register(registry);
        this.unauthorisedSpiffeAccess = Counter.builder("zero_trust.authz.failures")
            .description("Authorisation failures based on SPIFFE ID")
            .register(registry);
    }

    public void logMtlsFailure(String sourceIp, String targetEndpoint, String reason) {
        mTlsFailures.increment();
        log.warn("SECURITY: mTLS authentication failure source={} endpoint={} reason={}",
            sourceIp, targetEndpoint, reason);
        // Forward to SIEM for correlation
        securityEventPublisher.publish(SecurityEvent.builder()
            .type(SecurityEventType.MTLS_FAILURE)
            .sourceIp(sourceIp)
            .targetEndpoint(targetEndpoint)
            .reason(reason)
            .timestamp(Instant.now())
            .build());
    }
}
```

```yaml
# Prometheus alert for unusual zero-trust violations
groups:
  - name: zero_trust_violations
    rules:
      - alert: MtlsAuthenticationFailuresSpike
        expr: rate(zero_trust_mtls_failures_total[5m]) > 10
        for: 2m
        labels:
          severity: high
        annotations:
          summary: "mTLS authentication failure rate unusually high — possible attack or misconfiguration"

      - alert: UnauthorisedServiceAccess
        expr: rate(zero_trust_authz_failures_total[5m]) > 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Service attempting to access unauthorised endpoint — investigate immediately"
```

---

## Zero-Trust Migration Path

Migrating an existing payment platform to zero-trust is a phased effort, not a big bang:

```
Phase 1 — Inventory and Service Accounts (Month 1)
  Deploy SPIRE Server and Node Agents
  Create individual ServiceAccount per service (replace default)
  Audit existing credential sharing — document and schedule elimination
  Apply NetworkPolicy default-deny in staging environment

Phase 2 — mTLS Permissive Mode (Month 2-3)
  Deploy Istio with PERMISSIVE mTLS mode (encrypts but does not reject plaintext)
  Validate all service-to-service communication works with mTLS
  Add SPIFFE ID logging to all services — build baseline of normal traffic patterns

Phase 3 — mTLS STRICT Mode (Month 4)
  Switch to STRICT mode — plaintext traffic is rejected
  Any failing calls = service not yet enrolled → fix them
  Enable Vault dynamic credentials for database access

Phase 4 — Fine-Grained Authorisation (Month 5-6)
  Implement SPIFFE-ID-based authorisation filters (see above)
  Apply least-privilege NetworkPolicy per service
  Enable continuous monitoring and alerting on violations
```

---

## Key Takeaways

- Zero-trust replaces network location with cryptographic identity—every service call requires proof of identity regardless of which network segment it originates from
- SPIFFE/SPIRE provides automatic short-lived X.509 SVIDs to workloads, enabling mTLS without manual certificate management
- NetworkPolicy default-deny-all with explicit allow rules is the Kubernetes zero-trust network control—implement it in every namespace
- Each service must have its own ServiceAccount with minimal RBAC permissions—the default service account has too many permissions
- Vault dynamic credentials eliminate long-lived secrets: each pod gets unique, short-lived database credentials that expire automatically
- Monitor zero-trust violations (mTLS failures, unauthorised SPIFFE access) as security events—unexpected internal authentication failures indicate either misconfiguration or lateral movement

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the fundamental security principle that differentiates zero-trust architecture from perimeter-based security?",
      "options": ["Zero-trust uses stronger encryption", "Zero-trust places a firewall in front of every service", "Zero-trust grants access based on cryptographic identity verified on every request, not based on network location", "Zero-trust requires all traffic to pass through a central proxy"],
      "correct": 2,
      "explanation": "The perimeter model trusts all traffic inside the network boundary. Zero-trust eliminates the concept of a trusted network zone — every service must prove its identity cryptographically on every request and receives only the minimum permissions required, regardless of whether it is inside or outside the datacenter."
    },
    {
      "text": "What does a SPIFFE SVID (SVID = SPIFFE Verifiable Identity Document) contain, and how long should it be valid?",
      "options": ["A username and password, valid for 1 year", "An X.509 certificate with a SPIFFE URI SAN identifying the workload, recommended to be valid for 1 hour with automatic rotation", "A JWT token valid for 24 hours", "An API key stored in a Kubernetes secret"],
      "correct": 1,
      "explanation": "A SPIFFE SVID is an X.509 certificate where the Subject Alternative Name (SAN) contains a SPIFFE URI identifying the workload (e.g., spiffe://payments.example.com/ns/payments/sa/payment-service). The recommended validity is 1 hour with automated rotation by the SPIRE agent, limiting blast radius from key compromise."
    },
    {
      "text": "Why is Kubernetes NetworkPolicy default-deny-all with explicit allow rules required as part of a zero-trust implementation?",
      "options": ["It improves Kubernetes pod scheduling performance", "It ensures that even if an attacker compromises one pod, they cannot make arbitrary network calls to other services — east-west traffic is restricted to only the communication paths that are explicitly authorised", "It is required for Kubernetes certification", "It reduces network bandwidth consumption"],
      "correct": 1,
      "explanation": "Without NetworkPolicy, any compromised pod can make TCP connections to any other pod in the cluster. Default-deny-all with explicit allow rules implements network-level zero-trust: a compromised payment-service pod cannot call admin APIs, internal tooling, or other services it has no legitimate need to contact."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Zero-Trust Security for Payment Microservices",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Deploy SPIRE Server and Agent on a local Kubernetes cluster; create workload registration entries for payment-service and fraud-service; verify that each pod receives a valid SVID with the correct SPIFFE URI in the SAN and an expiry of 1 hour."},
    {"id": "2", "description": "Write Kubernetes NetworkPolicy manifests implementing default-deny-all ingress and egress for the payments namespace, with explicit allow rules: payment-service can call fraud-service on port 8443, payment-service can reach Kafka on port 9092, and all pods can reach kube-dns for DNS resolution."},
    {"id": "3", "description": "Implement a Spring Boot filter that extracts the client's SPIFFE ID from the mTLS client certificate, compares it against an allowlist of authorised callers for each endpoint, and publishes a security audit event when an unauthorised SPIFFE ID attempts access."},
    {"id": "4", "description": "Configure Vault with Kubernetes authentication, create a database role for payment-service that generates dynamic PostgreSQL credentials with a 1-hour TTL, and integrate Spring Cloud Vault to automatically refresh credentials before expiry without service restart."}
  ]
}
-->
