---
id: track-13-lesson-12
title: "mTLS in Practice — Certificate Rotation and SPIFFE"
slug: mtls-certificate-rotation
track: track-13
trackName: "Security & Observability Engineering"
sequence: 12
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - mTLS
  - certificate
  - SPIFFE
  - SPIRE
  - cert-manager
  - rotation
  - PKI
prerequisites:
  - track-13-lesson-09
  - track-13-lesson-11
---

# mTLS in Practice — Certificate Rotation and SPIFFE

An expired certificate in a payment service is not a theoretical risk — it is a production outage. In 2021 a major payments processor suffered a 90-minute outage because a TLS certificate expired without automated renewal. This lesson covers the mechanics of mutual TLS, automated certificate rotation using SPIRE and cert-manager, Vault PKI integration, and monitoring for certificate expiry before it becomes an incident.

---

## 1. mTLS Mechanics

Standard TLS (one-way) verifies only the server identity. The client checks the server's certificate against a trusted CA, but the server accepts any client. Mutual TLS (mTLS) adds the reverse verification: the server also validates the client's certificate.

### mTLS Handshake

```
Client (payment-service)              Server (account-service)
─────────────────────────             ──────────────────────────
1. ClientHello                   ──►
                                  ◄── 2. ServerHello
                                  ◄── 3. Server Certificate (X.509)
                                  ◄── 4. CertificateRequest (mTLS only)
5. Client Certificate (X.509)    ──►
6. ClientKeyExchange             ──►
7. CertificateVerify             ──►
8. ChangeCipherSpec              ──►
9. Finished                      ──►
                                  ◄── 10. ChangeCipherSpec
                                  ◄── 11. Finished
            Encrypted Application Data
```

Both certificates are signed by a trusted CA. Each side verifies:
1. The certificate is signed by the trusted CA (or intermediate CA in the chain).
2. The certificate has not expired (`notAfter` in the future).
3. The certificate has not been revoked (CRL / OCSP check).
4. The Subject Alternative Name matches the expected workload identity.

---

## 2. SPIFFE SVID Format

SPIFFE SVIDs are X.509 certificates with a URI Subject Alternative Name that encodes the workload identity.

```
Certificate Details:
  Subject: (empty — SPIFFE does not use Subject CN for identity)
  Subject Alternative Name:
    URI: spiffe://fintech.example.com/ns/payments/sa/payment-service

  Validity:
    Not Before: 2026-11-09 10:00:00 UTC
    Not After:  2026-11-09 11:00:00 UTC   (TTL = 1 hour)

  Key Usage: Digital Signature, Key Encipherment
  Extended Key Usage: TLS Web Client Authentication, TLS Web Server Authentication
  
  Issuer: CN=SPIRE Intermediate CA, O=fintech.example.com
```

### Why SPIFFE Uses URI SAN Not CN

The Common Name (CN) field is deprecated for identity verification (RFC 2818). URI SANs are unambiguous, hierarchical, and machine-parseable. The SPIFFE trust bundle maps trust domains to their root CAs, enabling cross-domain federation between organisations.

---

## 3. SPIRE Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                       Kubernetes Cluster                       │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │                     SPIRE Server                        │   │
│  │  - Issues SVIDs signed by intermediate CA               │   │
│  │  - Stores registration entries (workload→SPIFFE ID map) │   │
│  │  - Validates node attestation (PSAT token)              │   │
│  │  - Rotates SVIDs every hour (configurable)              │   │
│  └───────────────────────┬────────────────────────────────┘   │
│                           │ gRPC (mTLS)                        │
│            ┌──────────────┴──────────────┐                     │
│            │                             │                     │
│  ┌─────────▼──────────┐   ┌─────────────▼──────────────────┐  │
│  │  SPIRE Agent       │   │  SPIRE Agent                   │  │
│  │  (node: worker-1)  │   │  (node: worker-2)              │  │
│  │  DaemonSet pod     │   │  DaemonSet pod                 │  │
│  └──────────┬─────────┘   └───────────────────────────────-┘  │
│             │ Unix socket /run/spire/agent.sock                 │
│    ┌────────┴───────────┐                                       │
│    │  payment-service   │  (fetches SVID via SPIFFE Workload   │
│    │  (pod on worker-1) │   API — Go/Java/Python SDKs)         │
│    └────────────────────┘                                       │
└───────────────────────────────────────────────────────────────┘
```

### Kubernetes PSAT Attestation

The SPIRE Agent proves the node's identity using a Kubernetes Projected Service Account Token (PSAT). This prevents a compromised pod from impersonating a different node.

```yaml
# SPIRE Agent DaemonSet — excerpt
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spire-agent
  namespace: spire
spec:
  template:
    spec:
      serviceAccountName: spire-agent
      containers:
        - name: spire-agent
          image: ghcr.io/spiffe/spire-agent:1.9.0
          args:
            - -config
            - /run/spire/config/agent.conf
          volumeMounts:
            - name: spire-socket
              mountPath: /run/spire/sockets
            - name: spire-token
              mountPath: /var/run/secrets/tokens
      volumes:
        - name: spire-token
          projected:
            sources:
              - serviceAccountToken:
                  audience: spire-server
                  expirationSeconds: 7200
                  path: spire-agent
        - name: spire-socket
          hostPath:
            path: /run/spire/sockets
            type: DirectoryOrCreate
```

---

## 4. SVID Rotation — Zero-Downtime Hot Reload

SPIRE rotates SVIDs before expiry to ensure zero-downtime. The rotation timeline for a 1-hour TTL:

```
t=0h    SVID issued (valid 0h → 1h)
t=0h30  SPIRE rotates at 50% TTL — new SVID issued (valid 0h30 → 1h30)
t=0h30  Both old and new SVIDs valid simultaneously
t=0h45  Application hot-reloads new SVID (graceful drain)
t=1h00  Old SVID expires — new SVID is the only valid credential
```

The overlap window ensures in-flight connections using the old SVID complete gracefully before it is retired.

### Java — Listening for SVID Updates

```java
import io.spiffe.workloadapi.WorkloadApiClient;
import io.spiffe.workloadapi.Watcher;
import io.spiffe.bundle.x509bundle.X509Bundle;
import io.spiffe.svid.x509svid.X509Svid;

@Component
public class SpiffeIdentityManager implements InitializingBean, DisposableBean {

    private volatile X509Svid currentSvid;
    private volatile X509Bundle trustBundle;
    private WorkloadApiClient workloadApiClient;

    @Override
    public void afterPropertiesSet() {
        // Connect to SPIRE Agent via Unix socket
        workloadApiClient = WorkloadApiClient.newClient(
            WorkloadApiClient.ClientOptions.builder()
                .spiffeSocketPath("unix:///run/spire/sockets/agent.sock")
                .build()
        );

        // Watch for SVID updates — callback fires on initial fetch and rotation
        workloadApiClient.watchX509Context(new Watcher<>() {
            @Override
            public void onUpdate(X509Context update) {
                currentSvid  = update.getDefaultSvid();
                trustBundle  = update.getX509BundleSet()
                                     .getBundleForTrustDomain(TrustDomain.parse("fintech.example.com"));

                log.info("SVID rotated. New SPIFFE ID: {}, expires: {}",
                    currentSvid.getSpiffeId(),
                    currentSvid.getLeafCertificate().getNotAfter());

                // Hot-reload the SSLContext used by the HTTP client
                reloadSslContext();
            }

            @Override
            public void onError(Throwable error) {
                log.error("SPIRE Workload API error — SVID rotation failed", error);
                // Alert Prometheus
                Metrics.counter("spire.svid.rotation.error").increment();
            }
        });
    }

    private void reloadSslContext() {
        // Replace the SSLContext in the HTTP client pool without dropping existing connections
        SSLContext newCtx = SSLContextBuilder.create()
            .loadKeyMaterial(currentSvid.getKeyPair(), currentSvid.getLeafCertificate())
            .loadTrustMaterial(trustBundle.getX509Authorities())
            .build();
        httpClientPool.reloadSslContext(newCtx);
    }

    @Override
    public void destroy() {
        workloadApiClient.close();
    }
}
```

---

## 5. cert-manager with Vault Backend

cert-manager automates certificate issuance and renewal in Kubernetes using `Certificate` and `ClusterIssuer` CRDs.

### ClusterIssuer Using Vault PKI

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-issuer
spec:
  vault:
    server: https://vault.vault.svc.cluster.local:8200
    path: pki/intermediate/sign/payment-service  # Vault PKI role path
    caBundle: <base64-encoded-vault-ca-cert>
    auth:
      kubernetes:
        mountPath: /v1/auth/kubernetes
        role: cert-manager
        secretRef:
          name: cert-manager-vault-token
          key: token
```

### Certificate CRD for Payment Service

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payment-service-tls
  namespace: payments
spec:
  secretName: payment-service-tls-secret   # Kubernetes Secret to store cert + key
  issuerRef:
    name: vault-issuer
    kind: ClusterIssuer
  commonName: payment-service.payments.svc.cluster.local
  dnsNames:
    - payment-service
    - payment-service.payments
    - payment-service.payments.svc
    - payment-service.payments.svc.cluster.local
  uris:
    - "spiffe://fintech.example.com/ns/payments/sa/payment-service"
  duration: 1h      # certificate TTL
  renewBefore: 20m  # renew 20 minutes before expiry (at 40 minutes)
  usages:
    - digital signature
    - key encipherment
    - client auth
    - server auth
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always  # generate new key on every renewal
```

### Vault PKI Secrets Engine Setup

```bash
# Enable PKI at a custom path
vault secrets enable -path=pki pki

# Configure root CA (or import an external root)
vault write pki/root/generate/internal \
  common_name="fintech.example.com Root CA" \
  ttl="87600h"   # 10 years

# Enable intermediate CA
vault secrets enable -path=pki/intermediate pki

# Generate intermediate CSR
vault write -format=json pki/intermediate/generate/internal \
  common_name="fintech.example.com Intermediate CA" \
  | jq -r '.data.csr' > intermediate.csr

# Sign intermediate with root
vault write -format=json pki/root/root/sign-intermediate \
  csr=@intermediate.csr format=pem_bundle ttl="43800h" \
  | jq -r '.data.certificate' > intermediate.pem

# Import signed intermediate
vault write pki/intermediate/intermediate/set-signed certificate=@intermediate.pem

# Create role for payment-service
vault write pki/intermediate/roles/payment-service \
  allowed_domains="payments.svc.cluster.local" \
  allow_subdomains=true \
  allowed_uri_sans="spiffe://fintech.example.com/ns/payments/*" \
  max_ttl="2h" \
  key_type="ec" \
  key_bits=256 \
  require_cn=false \
  server_flag=true \
  client_flag=true
```

---

## 6. Certificate Pinning vs CA-Based Trust

| Approach | How It Works | Use Case | Rotation Impact |
|----------|-------------|----------|-----------------|
| CA-based trust | Trust the CA; accept any cert the CA signs | Microservice mesh with SPIRE/cert-manager | Zero — new certs rotate automatically |
| Intermediate CA pinning | Pin to a specific intermediate CA cert | Mobile apps calling a specific API | Medium — redeploy mobile app when intermediate rotates |
| Leaf certificate pinning | Pin to the exact certificate (SHA-256 hash) | Extremely sensitive APIs, banking apps | High — must update all clients on every renewal |

**Recommendation for microservice mesh**: use CA-based trust with short TTL certificates (1 hour). Leaf certificate pinning is only appropriate when you control both endpoints and can coordinate rotation — for example, an HSM-backed payment terminal calling a known server.

---

## 7. Monitoring Certificate Expiry

### cert-manager Prometheus Metrics

```promql
# Certificates expiring within 7 days
certmanager_certificate_expiration_timestamp_seconds
  - time() < 7 * 24 * 3600

# Certificates that have already expired
certmanager_certificate_expiration_timestamp_seconds < time()

# Ready certificates (1 = ready, 0 = not ready)
certmanager_certificate_ready_status == 0
```

### PrometheusRule: Certificate Expiry Alert

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: certificate-expiry-alerts
  namespace: monitoring
spec:
  groups:
    - name: certificate.expiry
      rules:
        - alert: CertificateExpiryWarning
          expr: |
            (certmanager_certificate_expiration_timestamp_seconds - time())
            / (24 * 3600) < 7
          for: 1h
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}"
            description: >
              Certificate {{ $labels.namespace }}/{{ $labels.name }} will expire in
              {{ printf \"%.1f\" $value }} days. If cert-manager renewal is working
              correctly this should resolve automatically. Check CertificateRequest
              objects and Vault PKI connectivity if the alert persists.

        - alert: CertificateExpired
          expr: |
            certmanager_certificate_expiration_timestamp_seconds < time()
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} HAS EXPIRED"
            description: >
              IMMEDIATE ACTION REQUIRED. Certificate {{ $labels.namespace }}/{{ $labels.name }}
              has expired. Services using this certificate will reject connections immediately.
              Run: kubectl cert-manager renew {{ $labels.name }} -n {{ $labels.namespace }}
```

### Non-cert-manager Certificates (TLS Endpoints)

```yaml
# Blackbox exporter to probe TLS endpoints and check expiry
modules:
  https_2xx_check_cert:
    prober: http
    timeout: 10s
    http:
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: []
      tls_config:
        insecure_skip_verify: false
      fail_if_ssl: false
      fail_if_not_ssl: true
```

```promql
# Days until certificate expiry as probed by blackbox exporter
(probe_ssl_earliest_cert_expiry - time()) / (24 * 3600)
```

---

## 8. Expired Certificate Incident Response

When a certificate expires in production, the runbook must be executed in under 5 minutes:

```bash
#!/bin/bash
# RUNBOOK: Expired Certificate Emergency Renewal
# Usage: ./renew-cert.sh <namespace> <certificate-name>

NAMESPACE=$1
CERT_NAME=$2

echo "=== Step 1: Check current certificate status ==="
kubectl get certificate "${CERT_NAME}" -n "${NAMESPACE}" -o yaml | grep -E "notAfter|readyStatus|message"

echo "=== Step 2: Force cert-manager to renew immediately ==="
kubectl cert-manager renew "${CERT_NAME}" -n "${NAMESPACE}"

echo "=== Step 3: Watch renewal progress ==="
kubectl get certificaterequest -n "${NAMESPACE}" --watch &
WATCH_PID=$!

echo "=== Step 4: Wait for new certificate to appear in Secret ==="
kubectl wait certificate "${CERT_NAME}" -n "${NAMESPACE}" \
  --for=condition=Ready --timeout=120s

kill ${WATCH_PID}

echo "=== Step 5: Verify new certificate expiry ==="
kubectl get secret "${CERT_NAME}-tls-secret" -n "${NAMESPACE}" \
  -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -dates

echo "=== Step 6: Rolling restart to pick up new certificate ==="
kubectl rollout restart deployment "${CERT_NAME}" -n "${NAMESPACE}"
kubectl rollout status deployment "${CERT_NAME}" -n "${NAMESPACE}"

echo "=== Done. Verify service connectivity ==="
```

---

## Production Pitfalls

### Pitfall 1: Waiting for Certificate Expiry Before Rotating

A team relies on a monitoring alert at 3 days to trigger manual rotation. The Vault PKI role has `max_ttl=2h` but the cert-manager `Certificate` resource was misconfigured with `duration: 24h` — Vault rejects the request and cert-manager silently retries with exponential backoff. The alert fires 3 days before expiry, but the cert has already been failing to renew for 21 days.

**Fix**: alert at 7 days expiry (not 3 days) and add a second alert for `certmanager_certificate_ready_status == 0` that fires when any certificate transitions to NotReady. The `ready_status == 0` alert catches renewal failures before the 7-day threshold.

```yaml
- alert: CertificateNotReady
  expr: certmanager_certificate_ready_status{condition="Ready"} == 0
  for: 15m
  labels:
    severity: warning
  annotations:
    summary: "Certificate {{ $labels.name }} is not ready — renewal may be failing"
```

### Pitfall 2: Pinning to the Leaf Certificate Breaks Rotation

A mobile banking application uses SSL pinning against the leaf certificate SHA-256 fingerprint (`sha256/AAAAAA...`). The backend rotates to a new 90-day certificate. All mobile clients immediately get SSL handshake failures. The incident lasts until the old certificate is forcibly kept alive (certificate is re-deployed) and a mobile app update propagates.

**Fix**: always pin to the intermediate CA, not the leaf certificate. Configure your mobile SDK with two pins: the current intermediate CA and the next intermediate CA (rotation readiness).

```java
// Android OkHttp — pin to intermediate CA, not leaf
OkHttpClient client = new OkHttpClient.Builder()
    .certificatePinner(
        new CertificatePinner.Builder()
            // Pin intermediate CA (outlives any single leaf cert)
            .add("api.fintech.example.com",
                 "sha256/INTERMEDIATE_CA_HASH_CURRENT")
            // Add next CA before rotating intermediate
            .add("api.fintech.example.com",
                 "sha256/INTERMEDIATE_CA_HASH_NEXT")
            .build()
    )
    .build();
```

### Pitfall 3: Not Testing Certificate Rotation in Staging

The first certificate rotation test happens in production at 11 PM on a Tuesday. The SPIRE-based hot-reload works correctly but the legacy batch job uses a file-mounted certificate and reads it only at startup. The batch job had been running for 25 days (since the last restart) and continues using the expired certificate, causing all batch payment processing to halt.

**Fix**: write an automated rotation test in staging that runs weekly:

```bash
#!/bin/bash
# cert-rotation-test.sh — run in staging weekly
# 1. Force SVID rotation by reducing TTL to 5 minutes
kubectl patch configmap spire-server-config -n spire \
  --type=json -p '[{"op":"replace","path":"/data/default_svid_ttl","value":"5m"}]'

# 2. Wait 3 minutes
sleep 180

# 3. Verify all services are still responding
for svc in payment-service account-service fraud-detection; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    https://${svc}.payments.svc.cluster.local/health)
  if [ "${STATUS}" != "200" ]; then
    echo "FAIL: ${svc} returned ${STATUS} after certificate rotation"
    exit 1
  fi
done

# 4. Restore TTL
kubectl patch configmap spire-server-config -n spire \
  --type=json -p '[{"op":"replace","path":"/data/default_svid_ttl","value":"1h"}]'

echo "Certificate rotation test PASSED"
```

---

## 9. Certificate Trust Bundle Distribution

In a multi-cluster or multi-cloud fintech deployment, services in cluster A must trust the CA that issued SVIDs in cluster B. SPIRE federates trust by sharing trust bundles between SPIRE servers.

### SPIRE Federation Configuration

```yaml
# spire-server.conf — federate with DR cluster
federation {
  bundle_endpoint {
    address = "0.0.0.0"
    port    = 8443
  }

  federates_with "fintech-dr.example.com" {
    bundle_endpoint_url = "https://spire.dr.fintech.example.com:8443"
    bundle_endpoint_profile "https_spiffe" {
      endpoint_spiffe_id = "spiffe://fintech-dr.example.com/spire/server"
    }
  }
}
```

### Verifying Trust Bundle Synchronisation

```bash
# Check which trust domains the SPIRE server knows about
spire-server bundle show -id spiffe://fintech.example.com
spire-server bundle show -id spiffe://fintech-dr.example.com

# View federated bundle expiry
spire-server bundle show -format spiffe | \
  python3 -c "import sys,json; b=json.load(sys.stdin); \
  [print(x['use'], x.get('x5c','NO CERT')) for x in b.get('keys',[])]"
```

Trust bundle rotation must be coordinated: when the DR cluster rotates its root CA, the primary cluster must receive the new trust bundle before the old CA expires. SPIRE's automated bundle endpoint handles this transparently when federation is enabled.

---

## 10. mTLS Debugging

Certificate problems surface as opaque TLS handshake errors. Use these techniques to diagnose them quickly.

### OpenSSL to Inspect Certificate

```bash
# Check certificate served by payment-service
openssl s_client \
  -connect payment-service.payments.svc.cluster.local:8443 \
  -cert /path/to/client.crt \
  -key /path/to/client.key \
  -CAfile /path/to/ca-bundle.pem \
  -showcerts 2>&1 | openssl x509 -noout -text

# Output to look for:
# Subject Alternative Name: URI:spiffe://fintech.example.com/ns/payments/sa/payment-service
# Not After: Nov  9 11:00:00 2026 GMT  (must be in the future)
# Issuer: CN=SPIRE Intermediate CA

# Verify cert against CA bundle
openssl verify -CAfile ca-bundle.pem payment-service.crt
# Expected: payment-service.crt: OK
```

### Istio Sidecar Certificate Debug

```bash
# View current certificate held by the payment-service Envoy sidecar
istioctl proxy-config secret payment-service-pod-name \
  -n payments \
  -o json | jq '.dynamicActiveSecrets[0].secret.tlsCertificate.certificateChain'

# Check if mTLS is working between two pods
istioctl experimental authz check \
  pod/payment-service-abc123 \
  -n payments

# View all TLS policies for a pod
istioctl proxy-config listener payment-service-abc123 \
  -n payments --port 8443
```

### Common Error Messages and Causes

| Error | Cause | Fix |
|-------|-------|-----|
| `certificate has expired or is not yet valid` | SVID TTL expired; rotation failed | Check SPIRE Agent connectivity; force SVID re-fetch |
| `certificate verify failed: unable to get local issuer certificate` | Client does not have CA bundle | Update trust bundle from SPIRE; check federation sync |
| `no certificate to verify peer against` | Server not presenting client certificate request | Enable mTLS in PeerAuthentication; check Istio config |
| `tls: bad certificate` | Certificate signed by untrusted CA | Ensure both sides use the same SPIRE trust domain |
| `connection reset by peer` | PeerAuthentication STRICT rejecting plaintext | Inject Istio sidecar or configure workload for mTLS |

---

## Production Checklist

- [ ] SPIFFE SVID TTL is 1 hour or less for all financial namespace workloads
- [ ] SVID rotation occurs at 50% TTL — verified in SPIRE server logs
- [ ] Java/Go services implement SPIFFE Workload API Watcher for hot-reload
- [ ] cert-manager Certificate CRD `renewBefore` is set to at least 20 minutes
- [ ] cert-manager uses Vault PKI as the issuer (not self-signed ClusterIssuer)
- [ ] Vault PKI role `max_ttl` aligns with cert-manager `duration`
- [ ] Alert: certificate expiry < 7 days (warning)
- [ ] Alert: certificate expiry < 1 day (critical)
- [ ] Alert: `certmanager_certificate_ready_status == 0` (not-ready alert)
- [ ] Mobile apps pin to intermediate CA, not leaf certificate
- [ ] Certificate rotation test runs weekly in staging
- [ ] Expired certificate incident runbook is documented and tested
- [ ] SPIRE Agent DaemonSet has `priorityClassName: system-node-critical`
- [ ] Vault PKI CRL is enabled and accessible from all services

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"A SPIFFE X.509 SVID has a TTL of 1 hour. SPIRE is configured to rotate SVIDs at 50% of TTL. A new SVID is issued at t=0. At what time will the new SVID be ready, and when does the original SVID expire?","options":["New SVID ready at t=30min; original expires at t=1h. Both are valid simultaneously from t=30min to t=1h.","New SVID ready at t=1h; original expires at t=1h. No overlap window.","New SVID ready at t=45min; original expires at t=1h. 15-minute overlap.","New SVID ready at t=30min; original expires at t=30min. No overlap."],"correct":0,"explanation":"SPIRE rotates at 50% of TTL, meaning rotation occurs at t=30min for a 1-hour TTL. The new SVID is issued at t=30min with its own 1-hour TTL (valid t=30min to t=1h30min). The original SVID remains valid until t=1h. This creates a 30-minute overlap window from t=30min to t=1h where both SVIDs are simultaneously valid, allowing in-flight connections to drain gracefully without any downtime."},{"text":"A cert-manager Certificate resource is configured with duration: 1h and renewBefore: 20m. The certificate was last issued at 10:00 UTC. When will cert-manager attempt to renew it?","options":["At 11:00 UTC when the certificate expires.","At 10:40 UTC — 20 minutes before the 11:00 expiry.","At 10:30 UTC — halfway through the certificate lifetime.","At 10:20 UTC — 20 minutes after issuance."],"correct":1,"explanation":"cert-manager calculates the renewal time as: expiry_time - renewBefore = 11:00 - 20min = 10:40 UTC. The renewBefore field specifies how far before expiry to start renewal, not how long after issuance. This gives a 20-minute window for Vault PKI to issue the new certificate and for the Secret to be updated before the old certificate expires."},{"text":"A mobile banking app uses SSL pinning. The backend payment API is migrating from a 2-year leaf certificate to a new 1-hour SPIFFE SVID. The old leaf certificate SHA-256 hash was pinned in the mobile app. What will happen when the SVID rotates for the first time?","options":["The mobile app will transparently accept the new certificate because SPIFFE SVIDs use the same CA.","All mobile clients will experience SSL handshake failures because the pinned leaf certificate hash no longer matches.","The mobile app will cache the old certificate and continue working for 7 days.","The SPIRE agent will detect the pinned hash and pause rotation."],"correct":1,"explanation":"Leaf certificate pinning matches the exact SHA-256 fingerprint of a specific certificate. When the SVID rotates (which happens every hour with SPIFFE), the new certificate has a completely different fingerprint. All clients with the old hash pinned will reject the new certificate with an SSL handshake failure. The fix is to pin to the intermediate CA certificate, which remains stable across many leaf certificate rotations, and to include both the current and next intermediate CA hashes to support intermediate CA rotation."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"Implement Automated Certificate Rotation with SPIRE and cert-manager","difficulty":"advanced","estimatedMinutes":105,"tasks":[{"id":"1","description":"Deploy SPIRE in a kind cluster with a 5-minute SVID TTL for testing. Configure Kubernetes PSAT attestation. Register a payment-service workload entry with SPIFFE ID spiffe://fintech.example.com/ns/payments/sa/payment-service. Write a Java Spring Boot service that implements the SPIFFE Workload API Watcher, logs the SVID fingerprint on each rotation, and exposes a /identity endpoint returning the current SPIFFE ID and certificate expiry time."},{"id":"2","description":"Set up Vault PKI with a root CA and an intermediate CA for fintech.example.com. Create a PKI role for payment-service allowing URI SAN spiffe://fintech.example.com/ns/payments/* with max_ttl=2h. Deploy cert-manager with a ClusterIssuer pointing to Vault. Create a Certificate CRD for payment-service with duration=1h and renewBefore=20m. Verify that cert-manager automatically renews the certificate and that the Kubernetes Secret is updated with no service downtime."},{"id":"3","description":"Write a PrometheusRule with three alert rules: CertificateNotReady (certmanager_certificate_ready_status == 0, 15 minutes), CertificateExpiryWarning (< 7 days, warning), and CertificateExpired (already expired, critical). Create a Grafana dashboard panel showing all certificate expiry timestamps, sorted ascending. Write a runbook script that forces cert-manager to renew a named certificate and validates the new expiry date."},{"id":"4","description":"Write an automated certificate rotation test script that: (1) reduces SPIRE SVID TTL to 5 minutes, (2) waits for one rotation cycle, (3) verifies the payment-service is still healthy via HTTP health check, (4) verifies the SVID fingerprint has changed, (5) restores the original TTL. Additionally, write a test proving that leaf certificate pinning breaks rotation and intermediate CA pinning survives rotation, using OkHttp's CertificatePinner with both configurations against a local test server."}]} -->
