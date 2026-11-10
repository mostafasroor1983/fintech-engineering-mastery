---
id: track-13-lesson-12
title: "mTLS in Practice — Certificate Rotation and SPIFFE"
slug: mtls-spiffe
track: track-13
trackName: "Security & Observability"
sequence: 12
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [mTLS, SPIFFE, SVID, certificate-rotation, Istio]
prerequisites: [track-13-lesson-11]
---

# mTLS in Practice — Certificate Rotation and SPIFFE

> [!NOTE]
> mTLS is the standard for securing service-to-service communication in payment microservices. The hard part is not implementing it once—it is managing certificate lifecycle (rotation, revocation, monitoring expiry) without service restarts or outages. SPIFFE/SPIRE automates this lifecycle entirely.

## mTLS Handshake Deep Dive

Mutual TLS extends standard TLS by requiring both parties to present and verify certificates. Understanding the handshake is essential for debugging failures.

```
Client (payment-service)              Server (fraud-service)
        │                                       │
        │── ClientHello ─────────────────────► │
        │   (supported TLS versions,           │
        │    cipher suites, random nonce)       │
        │                                       │
        │◄─ ServerHello ──────────────────────  │
        │   (selected cipher suite,             │
        │    server's TLS certificate)          │
        │                                       │
        │   [Client verifies server cert:        │
        │    - Issuer is trusted CA?            │
        │    - Cert not expired?               │
        │    - SAN matches fraud-service hostname/SPIFFE ID?] │
        │                                       │
        │◄─ CertificateRequest ───────────────  │
        │   (server requests client cert)       │
        │                                       │
        │── Certificate ─────────────────────► │
        │   (client's TLS certificate)          │
        │                                       │
        │   [Server verifies client cert:        │
        │    - Issuer is trusted CA?            │
        │    - SPIFFE ID authorized to call this endpoint?] │
        │                                       │
        │── CertificateVerify ───────────────► │
        │   (signature proving ownership of    │
        │    private key)                       │
        │                                       │
        │── Finished ────────────────────────► │
        │◄─ Finished ──────────────────────── │
        │                                       │
        │   [Encrypted application data]        │
```

**What can go wrong:**
1. Server certificate CN/SAN does not match the hostname used to connect
2. Client certificate issuer is not in the server's truststore
3. Certificate expired
4. Certificate revoked (CRL or OCSP check failed)
5. Clock skew causes validity check failure

---

## SPIFFE SVID Types

SPIRE issues two types of SVIDs (SPIFFE Verifiable Identity Documents):

### X.509 SVID (Preferred for mTLS)

An X.509 certificate where the SPIFFE ID is encoded in the Subject Alternative Name (SAN) URI field.

```
Certificate:
    Subject: O=SPIFFE
    Subject Alternative Name:
        URI: spiffe://payments.example.com/ns/payments/sa/payment-service
    Validity:
        Not Before: 2026-11-08 02:00:00 UTC
        Not After:  2026-11-08 03:00:00 UTC   ← 1-hour TTL
    Key Usage:
        Digital Signature, Key Encipherment
    Extended Key Usage:
        TLS Web Client Authentication
        TLS Web Server Authentication
```

The 1-hour TTL means: even if the private key is compromised, the SVID is useless after 1 hour. SPIRE rotates it automatically before expiry.

### JWT SVID (For API-level identity claims)

A JWT token containing the SPIFFE ID as the `sub` claim, used when mTLS is not available (e.g., service calling an external API).

```json
{
  "iss": "spiffe://payments.example.com",
  "sub": "spiffe://payments.example.com/ns/payments/sa/payment-service",
  "aud": ["spiffe://payments.example.com/ns/payments/sa/fraud-service"],
  "exp": 1731027600,
  "iat": 1731024000
}
```

---

## Automatic Certificate Rotation Without Service Restart

This is the core value proposition of SPIRE. Certificates rotate automatically before expiry. The service does not restart.

### How SPIRE Rotation Works

```
T=0:00  SPIRE issues SVID with 1h TTL to payment-service
T=0:45  SPIRE proactively rotates SVID (at 75% of TTL)
        New SVID issued and pushed to workload via UNIX socket
        Old SVID still valid for 15 more minutes
T=0:50  payment-service picks up new SVID from SPIRE Workload API
T=1:00  Old SVID expires — no service disruption
```

The SPIRE client library in Java handles this transparently:

```java
// SPIRE Workload API client with automatic rotation
@Configuration
public class SpireConfig {

    @Bean
    public X509Source x509Source() throws Exception {
        // X509Source automatically receives rotation updates from SPIRE agent
        X509Source source = X509Source.newSource(
            X509SourceOptions.newBuilder()
                // SPIRE agent socket — the agent fetches SVIDs from SPIRE server
                .workloadApiAddress("unix:///run/spire/sockets/agent.sock")
                .build()
        );
        // source.getX509Svid() always returns the current valid SVID
        // No polling required — SPIRE pushes updates via gRPC streaming
        return source;
    }

    @Bean
    public SSLContext mTlsSslContext(X509Source x509Source) throws Exception {
        // SpiffeHelper creates an SSLContext that auto-updates when SVID rotates
        return SpiffeHelper.getSSLContext(
            x509Source,
            new SpiffeIdPeer("spiffe://payments.example.com/ns/payments/sa/fraud-service"),
            true  // requireClientCert = true (mTLS)
        );
    }
}

// HTTP client using auto-rotating SVID
@Bean
public RestTemplate mTlsRestTemplate(X509Source x509Source) {
    // This RestTemplate automatically uses the latest SVID for all connections
    // No restart required when SVID rotates
    return new SpiffeRestTemplateBuilder()
        .withX509Source(x509Source)
        .withSpiffeIdPeer("spiffe://payments.example.com/ns/payments/sa/fraud-service")
        .build();
}
```

---

## Istio mTLS Modes

Istio provides mTLS between all services in a mesh without modifying application code. It operates in two modes:

### PERMISSIVE Mode (Migration Phase)

```yaml
# Accepts both plaintext and mTLS traffic
# Use during migration — not for final state in production
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payments
spec:
  mtls:
    mode: PERMISSIVE
```

### STRICT Mode (Production State)

```yaml
# Rejects all plaintext traffic — only mTLS accepted
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payments
spec:
  mtls:
    mode: STRICT
```

### Migration from PERMISSIVE to STRICT

```bash
# Step 1: Enable PERMISSIVE mode
kubectl apply -f - <<EOF
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payments
spec:
  mtls:
    mode: PERMISSIVE
EOF

# Step 2: Monitor for plaintext connections (indicates services not yet enrolled)
kubectl exec -n istio-system deploy/prometheus -- \
  curl -s "http://localhost:9090/api/v1/query?query=istio_requests_total{connection_security_policy='none',destination_namespace='payments'}" \
  | jq '.data.result[].metric | {source: .source_workload, dest: .destination_workload}'

# Step 3: Enroll remaining services (add Istio sidecar annotations)
# Add to deployment spec:
# spec.template.metadata.annotations:
#   sidecar.istio.io/inject: "true"

# Step 4: Verify no plaintext connections remain
# If all results are mTLS:
kubectl apply -f - <<EOF
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payments
spec:
  mtls:
    mode: STRICT
EOF
```

### Istio AuthorizationPolicy for mTLS Identity

```yaml
# Allow payment-service to call fraud-service (using SPIFFE identity from mTLS cert)
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: fraud-service-access
  namespace: payments
spec:
  selector:
    matchLabels:
      app: fraud-service
  rules:
  - from:
    - source:
        # Only payment-service's SPIFFE identity can call fraud-service
        principals:
          - "cluster.local/ns/payments/sa/payment-service"
    to:
    - operation:
        methods: ["POST"]
        paths: ["/api/v1/fraud/score"]
  # Deny all other callers — including from within the same namespace
```

---

## cert-manager for Certificate Lifecycle

For services not using SPIRE/Istio, cert-manager provides automated certificate management within Kubernetes.

```yaml
# cert-manager Certificate resource for payment-service
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payment-service-tls
  namespace: payments
spec:
  secretName: payment-service-tls-secret
  duration: 24h          # Certificate valid for 24 hours
  renewBefore: 4h        # Renew 4 hours before expiry (automatic)
  subject:
    organizations:
      - "Example Payments Ltd"
  dnsNames:
    - payment-service
    - payment-service.payments.svc.cluster.local
  uris:
    # SPIFFE ID for identity-based routing
    - spiffe://payments.example.com/ns/payments/sa/payment-service
  issuerRef:
    name: internal-ca-issuer  # Reference to your internal CA
    kind: ClusterIssuer
    group: cert-manager.io
```

```yaml
# ClusterIssuer using Vault PKI as the CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  vault:
    path: pki_int/sign/payment-services
    server: https://vault.example.com
    auth:
      kubernetes:
        role: cert-manager
        secretRef:
          name: cert-manager-vault-token
          key: token
```

---

## Monitoring Certificate Expiry

An expired certificate causes an immediate service outage. Alert well in advance.

```yaml
# Prometheus alert rules for certificate expiry
groups:
  - name: certificate_expiry
    rules:
      # Alert at 30 days — gives time to investigate rotation failures
      - alert: TLSCertificateExpiringSoon
        expr: |
          (probe_ssl_earliest_cert_expiry - time()) / 86400 < 30
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "TLS certificate expiring in {{ $value | printf \"%.0f\" }} days"
          instance: "{{ $labels.instance }}"
          runbook_url: "https://wiki.example.com/runbooks/tls-cert-renewal"

      # Critical at 7 days
      - alert: TLSCertificateExpiringCritical
        expr: |
          (probe_ssl_earliest_cert_expiry - time()) / 86400 < 7
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "TLS certificate expiring in {{ $value | printf \"%.0f\" }} days — urgent rotation required"

      # Kubernetes secret-based certificate expiry (via cert-manager metrics)
      - alert: CertManagerCertificateExpiringSoon
        expr: |
          certmanager_certificate_expiration_timestamp_seconds - time() < 30 * 86400
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "cert-manager certificate {{ $labels.name }} in {{ $labels.namespace }} expiring in {{ $value | humanizeDuration }}"
```

```java
// Application-level certificate expiry monitoring
@Component
public class CertificateExpiryMonitor {

    private final Gauge certExpiryGauge;

    public CertificateExpiryMonitor(MeterRegistry registry,
                                     X509Source spireX509Source) {
        this.certExpiryGauge = Gauge.builder("tls.certificate.expiry.seconds",
            spireX509Source,
            source -> {
                try {
                    X509Svid svid = source.getX509Svid();
                    X509Certificate cert = svid.getX509Certificate();
                    long expiryEpochSeconds = cert.getNotAfter().getTime() / 1000;
                    return expiryEpochSeconds - Instant.now().getEpochSecond();
                } catch (Exception e) {
                    return -1;  // -1 indicates error reading cert
                }
            })
            .description("Seconds until current TLS certificate expires")
            .register(registry);
    }
}
```

---

## Debugging mTLS Issues

mTLS failures produce cryptic errors. Here is a systematic debugging approach.

### Step 1: Verify the certificate chain with openssl

```bash
# Test mTLS connection from payment-service pod to fraud-service
kubectl exec -n payments deploy/payment-service -- \
  openssl s_client \
    -connect fraud-service:8443 \
    -cert /run/spire/sockets/client.crt \
    -key /run/spire/sockets/client.key \
    -CAfile /run/spire/sockets/ca.crt \
    -verify_return_error \
    -brief

# Successful output:
# CONNECTION ESTABLISHED
# Protocol version: TLSv1.3
# Ciphersuite: TLS_AES_256_GCM_SHA384
# Peer certificate: CN = fraud-service
# Peer SAN: URI:spiffe://payments.example.com/ns/payments/sa/fraud-service
# Hash used: SHA256
# Signature type: RSA-PSS
# Verification: OK

# Common failures:
# error:14090086 — certificate verify failed (issuer not in truststore)
# error:1408F10B — no peer certificate (server not presenting cert)
# SSL alert number 42 — bad certificate (wrong key for cert)
# SSL alert number 48 — unknown CA (client cert issuer not trusted)
```

### Step 2: Inspect the certificate contents

```bash
# View the SVID from SPIRE
kubectl exec -n payments deploy/payment-service -- \
  openssl x509 -in /run/spire/sockets/svid.pem -text -noout \
  | grep -A5 "Subject Alternative Name"

# Should show:
# X509v3 Subject Alternative Name:
#   URI:spiffe://payments.example.com/ns/payments/sa/payment-service

# Check expiry
kubectl exec -n payments deploy/payment-service -- \
  openssl x509 -in /run/spire/sockets/svid.pem -noout -dates
```

### Step 3: Verify SPIRE agent is running and healthy

```bash
# Check agent status
kubectl get pods -n spire -l app=spire-agent

# Check agent logs for rotation events
kubectl logs -n spire ds/spire-agent --since=10m | grep -E "rotation|expired|error"

# Verify workload entries exist
kubectl exec -n spire deploy/spire-server -- \
  /opt/spire/bin/spire-server entry show \
  -spiffeID spiffe://payments.example.com/ns/payments/sa/payment-service
```

### Step 4: Check Istio mTLS status (if using Istio)

```bash
# Check if mTLS is active between payment-service and fraud-service
istioctl authn tls-check payment-service.payments.svc.cluster.local

# Output:
# HOST:PORT                                     STATUS     SERVER     CLIENT
# payment-service.payments:8443                 OK         STRICT     mTLS

# Check if a specific pod has the sidecar
kubectl get pod -n payments payment-service-abc123 -o jsonpath='{.spec.containers[*].name}'
# Should include: payment-service, istio-proxy
```

---

## PCI DSS mTLS Requirements

PCI DSS (Payment Card Industry Data Security Standard) mandates strong cryptography for transmitting cardholder data:

- **Requirement 4.2.1**: Use strong cryptography for all cardholder data in transit. TLS 1.2 minimum; TLS 1.3 strongly recommended. mTLS satisfies this requirement and provides additional authentication.
- **Requirement 6.3.3**: All system components are protected from known vulnerabilities by installing applicable security patches/updates. Certificate rotation addresses the operational requirement.
- **Requirement 8.6.1**: System/application accounts and service accounts are managed as follows: access is restricted to minimum necessary. SPIFFE SVIDs provide per-service identity satisfying this requirement.

```java
// PCI-compliant cipher suite enforcement
@Bean
public TomcatServletWebServerFactory pciCompliantTomcat() {
    TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory();
    factory.addConnectorCustomizers(connector -> {
        AbstractHttp11Protocol<?> protocol =
            (AbstractHttp11Protocol<?>) connector.getProtocolHandler();

        // PCI DSS requires disabling insecure TLS versions
        protocol.setSslEnabledProtocols("TLSv1.2,TLSv1.3");

        // PCI DSS Appendix A2 — disallow weak cipher suites
        protocol.setCiphers(
            // TLS 1.3 (automatically forward secret)
            "TLS_AES_256_GCM_SHA384:" +
            "TLS_AES_128_GCM_SHA256:" +
            "TLS_CHACHA20_POLY1305_SHA256:" +
            // TLS 1.2 (ECDHE for forward secrecy)
            "ECDHE-RSA-AES256-GCM-SHA384:" +
            "ECDHE-RSA-AES128-GCM-SHA256:" +
            // Explicitly disabled (by not listing them):
            // RC4, DES, 3DES, NULL ciphers, EXPORT ciphers, MD5-based MACs
            "!RC4:!DES:!3DES:!NULL:!EXPORT:!MD5"
        );
    });
    return factory;
}
```

---

## Key Takeaways

- mTLS provides mutual authentication (both parties verified) plus encryption—it is the minimum standard for service-to-service communication in payment microservices
- SPIFFE/SPIRE automates the entire certificate lifecycle: issuance, rotation, and revocation without service restarts
- Short-lived SVIDs (1 hour) limit the blast radius of private key compromise to 1 hour—automated rotation makes this operationally feasible
- Migrate from PERMISSIVE to STRICT Istio mTLS mode gradually: monitor for plaintext connections before switching, then switch namespace by namespace
- Alert on certificate expiry at 30 days and 7 days—an expired certificate causes immediate service outage
- PCI DSS Requirement 4.2.1 mandates strong cryptography for cardholder data in transit; mTLS satisfies this requirement and provides additional authentication beyond what standard TLS provides
- Use `openssl s_client` for debugging mTLS failures—the error codes are diagnostic: `SSL alert number 48` means the client certificate issuer is not trusted by the server

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What distinguishes mTLS (mutual TLS) from standard TLS in the context of service-to-service communication?",
      "options": ["mTLS uses a stronger cipher suite", "In mTLS, both the server and the client present and verify X.509 certificates, providing mutual authentication — standard TLS only authenticates the server", "mTLS encrypts data twice for additional security", "mTLS requires a hardware security module"],
      "correct": 1,
      "explanation": "Standard TLS authenticates only the server to the client. mTLS adds client authentication: the server also requires the client to present a valid X.509 certificate from a trusted CA. This means both sides have cryptographically verified identities, preventing any service without a valid certificate from making calls."
    },
    {
      "text": "Why should SPIFFE SVIDs have a validity period of 1 hour rather than the typical 1-year certificate lifetime?",
      "options": ["SPIRE cannot issue certificates with longer lifetimes", "Short-lived certificates limit the blast radius of private key compromise to the certificate's remaining lifetime; automated rotation makes this operationally feasible without manual intervention", "PCI DSS mandates 1-hour certificate lifetimes", "1-hour certificates are cheaper to issue"],
      "correct": 1,
      "explanation": "If a private key is compromised, the attacker can impersonate that service until the certificate expires. A 1-year lifetime means 1 year of exposure; a 1-hour lifetime means at most 1 hour. SPIRE's automated rotation means pods always have a fresh SVID without any manual certificate management."
    },
    {
      "text": "When migrating a Kubernetes cluster from no mTLS to strict mTLS using Istio, why should PERMISSIVE mode be used before STRICT mode?",
      "options": ["PERMISSIVE mode is required for PCI compliance", "PERMISSIVE mode accepts both plaintext and mTLS traffic, allowing you to identify and fix services that are not yet enrolled in mTLS before STRICT mode would break them", "PERMISSIVE mode is faster than STRICT mode", "STRICT mode requires a separate licence"],
      "correct": 1,
      "explanation": "Switching directly to STRICT mode in a large cluster will immediately break all services that have not yet been enrolled in mTLS. PERMISSIVE mode allows the cluster to continue operating while you progressively enroll services and validate that mTLS works between each pair before cutting over to STRICT mode."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "mTLS with SPIFFE/SPIRE for Payment Service Communication",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Deploy SPIRE on a Kubernetes cluster with a 1-hour SVID TTL; register workload entries for payment-service and fraud-service using Kubernetes pod selectors; verify that both pods receive SVIDs with the correct SPIFFE URI SANs using openssl x509."},
    {"id": "2", "description": "Configure Istio with STRICT PeerAuthentication policy in the payments namespace so all traffic between payment-service and fraud-service must use mTLS; verify with istioctl authn tls-check that the status shows OK STRICT."},
    {"id": "3", "description": "Implement PCI DSS-compliant TLS configuration in Tomcat/Spring Boot: enforce TLS 1.2 and 1.3 only, configure the approved cipher suite list (TLS_AES_256_GCM_SHA384, ECDHE-RSA-AES256-GCM-SHA384, etc.), and write an automated test that verifies TLS 1.1 connections are rejected."},
    {"id": "4", "description": "Create a Prometheus alert that fires when any SVID in the payments namespace has less than 7 days until expiry (using certificate expiry metrics from Istio or SPIRE), and write a runbook for the two most common mTLS failure scenarios: certificate verify failed and unknown CA."}
  ]
}
-->
