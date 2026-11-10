---
id: track-12-lesson-03
title: "Kubernetes Networking — CNI, Services, and Ingress"
slug: k8s-networking
track: track-12
trackName: "Cloud Platform Engineering"
sequence: 3
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - Kubernetes
  - CNI
  - Service
  - Ingress
  - NetworkPolicy
  - Calico
  - DNS
prerequisites:
  - track-12-lesson-02
---

# Kubernetes Networking — CNI, Services, and Ingress

Kubernetes networking solves one of the hardest problems in distributed systems: giving every container a stable, routable identity without requiring manual IP management. For fintech applications processing thousands of transactions per second, understanding how packets travel between pods — and how to enforce strict network segmentation for PCI-DSS compliance — is non-negotiable.

---

## 1. The Kubernetes Network Model

Kubernetes enforces a flat, non-NAT network model with three fundamental rules:

1. Every pod gets a unique cluster-wide IP address
2. Pods can communicate with any other pod without NAT
3. Agents on a node (kubelet, kube-proxy) can communicate with all pods on that node

This model makes service-to-service communication predictable but requires the Container Network Interface (CNI) plugin to implement the actual packet routing.

```
┌─────────────────────────────────────────────────────────────┐
│                    Node A (10.0.1.10)                       │
│  ┌──────────────────┐    ┌──────────────────┐              │
│  │  payment-pod     │    │  fraud-pod        │              │
│  │  10.244.1.5      │    │  10.244.1.6       │              │
│  │  port: 8080      │    │  port: 8081       │              │
│  └────────┬─────────┘    └────────┬──────────┘              │
│           │                       │                          │
│      ┌────▼───────────────────────▼────┐                    │
│      │         veth pair / bridge      │                    │
│      │           cni0 / calico         │                    │
│      └─────────────────────────────────┘                    │
└───────────────────────┬─────────────────────────────────────┘
                        │
                 ┌──────▼──────┐
                 │  Node Subnet │
                 │  10.244.1.0  │
                 └──────┬───────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│                    Node B (10.0.1.11)                       │
│  ┌──────────────────┐                                       │
│  │  ledger-pod      │                                       │
│  │  10.244.2.3      │                                       │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

### Pod IP Allocation

The CNI plugin (not Kubernetes itself) assigns pod IPs. The cluster CIDR is configured in `kube-controller-manager`:

```yaml
# kube-controller-manager configuration
--cluster-cidr=10.244.0.0/16    # pod CIDR pool
--service-cluster-ip-range=10.96.0.0/12  # service VIP pool
--node-cidr-mask-size=24        # each node gets a /24 (254 pods max)
```

Each node is assigned a `/24` subnet from the cluster CIDR. This limits pods-per-node to 254 — a critical capacity constraint for high-density fintech workloads.

---

## 2. CNI Plugins

### 2.1 Calico — NetworkPolicy and BGP Routing

Calico is the dominant CNI for financial services because it implements Kubernetes NetworkPolicy with high performance using iptables or eBPF, and supports BGP for scalable routing without an overlay network.

```yaml
# Calico installation via Operator
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - blockSize: 26          # /26 blocks allocated per node
        cidr: 10.244.0.0/16
        encapsulation: VXLANCrossSubnet  # overlay only cross-subnet
        natOutgoing: Enabled
        nodeSelector: all()
  variant: Calico
  registry: quay.io
```

Calico enforces NetworkPolicy at the kernel level using iptables chains. Each policy rule becomes an iptables rule, evaluated in order. For a cluster with 1,000 pods, this can generate tens of thousands of iptables rules — a scalability concern.

### 2.2 Cilium — eBPF-Based Networking

Cilium replaces iptables with eBPF programs loaded directly into the Linux kernel, providing:
- **Lower latency**: No iptables traversal, direct kernel path
- **Better observability**: L7-aware network flow logs
- **Identity-based policy**: Pod identity from certificates, not just IPs

```yaml
# Cilium Helm values for fintech cluster
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Enable eBPF-based kube-proxy replacement
  kube-proxy-replacement: "strict"
  # Enable Hubble observability
  enable-hubble: "true"
  hubble-listen-address: ":4244"
  # L7 policy enforcement
  enable-l7-proxy: "true"
  # Encryption for in-cluster traffic (Wireguard)
  enable-wireguard: "true"
```

### 2.3 Choosing a CNI for Fintech

| Feature | Calico | Cilium | Flannel |
|---------|--------|--------|---------|
| NetworkPolicy | Full | Full + L7 | None |
| Performance | Good | Excellent | Good |
| BGP routing | Yes | Limited | No |
| PCI-DSS suitability | High | High | Low |
| Operational complexity | Medium | High | Low |

**Recommendation**: Use Calico for established teams with iptables expertise; use Cilium for new clusters where eBPF observability justifies the learning curve.

---

## 3. Kubernetes Services

Services provide a stable virtual IP (ClusterIP) that load-balances traffic across matching pods. The Service IP is handled by kube-proxy, which programs iptables or IPVS rules on every node.

### 3.1 ClusterIP — Internal Service Discovery

```yaml
# payment-service: internal ClusterIP
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: payments
  labels:
    app: payment-service
    tier: backend
    pci-scope: "true"           # mark as PCI in-scope for NetworkPolicy
spec:
  type: ClusterIP
  selector:
    app: payment-processor
    version: stable
  ports:
    - name: http
      protocol: TCP
      port: 80                  # service port (what clients connect to)
      targetPort: 8080          # container port
    - name: grpc
      protocol: TCP
      port: 9090
      targetPort: 9090
  sessionAffinity: ClientIP     # sticky sessions for stateful operations
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800     # 3-hour session for long-running transactions
```

The ClusterIP `10.96.x.x` is a virtual IP — it exists only in iptables rules. No process listens on it; kube-proxy rewrites packets destined for the ClusterIP to a real pod IP.

### 3.2 NodePort — External Access for Testing

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-nodeport
  namespace: payments
spec:
  type: NodePort
  selector:
    app: payment-processor
  ports:
    - port: 80
      targetPort: 8080
      nodePort: 30080           # must be in range 30000-32767
                                # WARNING: exposes on ALL nodes; not for prod
```

NodePort opens a port on every node. For production financial services, NodePort should only be used for internal access; external traffic must go through a LoadBalancer or Ingress.

### 3.3 LoadBalancer — Cloud Provider Integration

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-api-lb
  namespace: payments
  annotations:
    # AWS-specific: use NLB for lower latency (required for sub-10ms p99)
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
    # Preserve client source IP for audit logging
    service.beta.kubernetes.io/aws-load-balancer-proxy-protocol: "*"
spec:
  type: LoadBalancer
  selector:
    app: payment-processor
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
  externalTrafficPolicy: Local  # preserve source IP; skip extra hop
  loadBalancerSourceRanges:
    - 10.0.0.0/8                # restrict to internal CIDR only
```

`externalTrafficPolicy: Local` is critical for financial audit trails — it preserves the original client IP. With the default `Cluster` policy, the source IP is replaced by the node IP.

### 3.4 ExternalName — External Service Integration

```yaml
# Route to external payment gateway without changing application code
apiVersion: v1
kind: Service
metadata:
  name: visa-gateway
  namespace: payments
spec:
  type: ExternalName
  externalName: api.visa.com    # resolves to external DNS name
  ports:
    - port: 443
```

Applications can call `visa-gateway.payments.svc.cluster.local` and DNS resolves it to `api.visa.com`. This enables seamless migration from external to in-cluster services.

### 3.5 kube-proxy vs eBPF Packet Forwarding

```
kube-proxy (iptables mode):
  packet → NIC → iptables PREROUTING → DNAT (ClusterIP → PodIP) → route → pod

kube-proxy (IPVS mode):
  packet → NIC → IPVS → PodIP → route → pod
  (IPVS uses hash tables, O(1) lookup vs O(n) iptables)

Cilium eBPF (kube-proxy replacement):
  packet → NIC → eBPF XDP hook → PodIP → route → pod
  (kernel bypass, lowest latency, ~20% better throughput)
```

For clusters with >500 services, switch to IPVS mode. For latency-critical payment processing, evaluate Cilium's kube-proxy replacement.

---

## 4. CoreDNS Service Discovery

CoreDNS is the cluster DNS server. It runs as a Deployment in `kube-system` and resolves `<service>.<namespace>.svc.cluster.local` to the service ClusterIP.

```yaml
# CoreDNS ConfigMap — custom configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        # Cache DNS responses to reduce latency
        cache 30 {
           success 9984 30
           denial 9984 5
        }
        # Custom upstream for external payment providers
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        # Rewrite for legacy service names
        rewrite name payment-svc.payments.svc.cluster.local \
                      payment-service.payments.svc.cluster.local
        loop
        reload
        loadbalance
    }
```

### DNS Resolution Chain

```
pod → CoreDNS (10.96.0.10:53) → response (ClusterIP)

Full FQDN:  payment-service.payments.svc.cluster.local
Short form: payment-service.payments      (from same namespace: payment-service)
```

A pod's `/etc/resolv.conf` is injected by kubelet:

```
nameserver 10.96.0.10
search payments.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

The `ndots:5` setting means any name with fewer than 5 dots triggers a search through the search domains before attempting an absolute lookup — causing up to 4 DNS queries for external names. For latency-sensitive payment gateway calls, explicitly use FQDNs (ending with `.`) to skip search domain iteration.

---

## 5. DNS-Based Service Discovery in Java

```java
// PaymentServiceClient.java — DNS-based discovery with HttpClient
package com.fintech.payments.client;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * HTTP client that uses Kubernetes DNS for service discovery.
 * The service name resolves via CoreDNS to the ClusterIP,
 * which kube-proxy forwards to a healthy pod.
 */
public class PaymentServiceClient {

    // Use FQDN to avoid ndots:5 search domain iteration
    private static final String PAYMENT_SERVICE_URL =
        "http://payment-service.payments.svc.cluster.local:80";

    private final HttpClient httpClient;

    public PaymentServiceClient() {
        this.httpClient = HttpClient.newBuilder()
            // Keep connections alive for reuse (avoid TCP handshake overhead)
            .connectTimeout(Duration.ofSeconds(2))
            // Connection pool managed by HttpClient
            .build();
    }

    public CompletableFuture<PaymentResponse> processPayment(PaymentRequest request) {
        HttpRequest httpRequest = HttpRequest.newBuilder()
            .uri(URI.create(PAYMENT_SERVICE_URL + "/api/v1/payments"))
            .header("Content-Type", "application/json")
            .header("X-Request-ID", request.getRequestId())
            .header("X-Idempotency-Key", request.getIdempotencyKey())
            .POST(HttpRequest.BodyPublishers.ofString(request.toJson()))
            .timeout(Duration.ofSeconds(5))  // per-request timeout
            .build();

        return httpClient
            .sendAsync(httpRequest, HttpResponse.BodyHandlers.ofString())
            .thenApply(response -> {
                if (response.statusCode() >= 500) {
                    throw new PaymentServiceException(
                        "Payment service error: " + response.statusCode());
                }
                return PaymentResponse.fromJson(response.body());
            });
    }
}
```

```java
// DNS resolution test — verify CoreDNS resolves service names
package com.fintech.payments.client;

import org.junit.jupiter.api.Test;
import java.net.InetAddress;
import static org.assertj.core.api.Assertions.assertThat;

class ServiceDiscoveryTest {

    @Test
    void resolvesPaymentServiceViaCoreDNS() throws Exception {
        // In-cluster: resolves to ClusterIP
        // In test: requires DNS mock or Testcontainers with custom network
        InetAddress address = InetAddress.getByName(
            "payment-service.payments.svc.cluster.local");
        assertThat(address.getHostAddress())
            .matches("^10\\.96\\..*");  // ClusterIP range
    }
}
```

---

## 6. Ingress Controllers

Ingress provides HTTP/HTTPS routing from outside the cluster to internal services. The Ingress resource is a declaration; an Ingress controller (NGINX, Traefik, etc.) watches these resources and configures itself.

### 6.1 NGINX Ingress Controller

```yaml
# ingress-nginx: production configuration for fintech
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Security hardening
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256"
  # Hide nginx version for security
  server-tokens: "false"
  # Logging for PCI audit
  log-format-upstream: >
    {"time":"$time_iso8601","remote_addr":"$remote_addr",
     "request_id":"$req_id","status":$status,
     "bytes_sent":$bytes_sent,"latency":$request_time,
     "upstream":"$upstream_addr"}
  # Tune for payment API traffic
  worker-processes: "auto"
  max-worker-connections: "65536"
  upstream-keepalive-connections: "100"
  # Rate limiting store
  limit-req-status-code: "429"
```

### 6.2 Ingress Rules for Fintech API Routing

```yaml
# payment-api-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-api
  namespace: payments
  annotations:
    kubernetes.io/ingress.class: "nginx"
    # TLS termination with cert-manager certificate
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    # Rate limiting: 100 req/min per IP for payment endpoints
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
    # Enable CORS for fintech dashboard
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://dashboard.fintech.com"
    # Rewrite /api/v1 prefix
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    # Proxy timeouts for long-running payment operations
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
    # Security headers
    nginx.ingress.kubernetes.io/configuration-snippet: |
      add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header X-Frame-Options "DENY" always;
spec:
  tls:
    - hosts:
        - api.fintech.com
      secretName: fintech-api-tls
  rules:
    - host: api.fintech.com
      http:
        paths:
          # Payment processing — high priority, strict rate limit
          - path: /api/v1(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: payment-service
                port:
                  number: 80
          # Fraud scoring — separate service for isolation
          - path: /api/v1/fraud(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: fraud-scoring-service
                port:
                  number: 80
          # Account management — lower rate limit sufficient
          - path: /api/v1/accounts(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: account-service
                port:
                  number: 80
```

### 6.3 Traefik for Dynamic Routing

Traefik integrates natively with Kubernetes and supports IngressRoute CRDs for more expressive routing:

```yaml
# traefik IngressRoute for payment gateway
apiVersion: traefik.containo.us/v1alpha1
kind: IngressRoute
metadata:
  name: payment-gateway-route
  namespace: payments
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`api.fintech.com`) && PathPrefix(`/api/v1/payments`)
      kind: Rule
      priority: 100
      services:
        - name: payment-service
          port: 80
          weight: 90          # 90% to stable, 10% to canary
        - name: payment-service-canary
          port: 80
          weight: 10
      middlewares:
        - name: payment-ratelimit
        - name: payment-headers
  tls:
    certResolver: le          # Let's Encrypt
---
apiVersion: traefik.containo.us/v1alpha1
kind: Middleware
metadata:
  name: payment-ratelimit
  namespace: payments
spec:
  rateLimit:
    average: 100
    burst: 200
    period: 1m
    sourceCriterion:
      requestHeaderName: X-API-Key   # rate limit per API key
```

---

## 7. NetworkPolicy — Default Deny and Selective Allow

NetworkPolicy implements microsegmentation at the pod level. Without NetworkPolicy, any pod can reach any other pod — a critical PCI-DSS violation for cardholder data environments.

### 7.1 Default Deny All

```yaml
# Apply to every namespace in PCI scope
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: payments
spec:
  podSelector: {}             # selects ALL pods in namespace
  policyTypes:
    - Ingress
    - Egress
  # No ingress or egress rules = deny everything
```

### 7.2 Selective Allow — Payment Service

```yaml
# Allow payment processor to receive traffic from API gateway only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-payment-processor
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-processor
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow from API gateway pods only
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
    # Allow Prometheus scraping
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 9090           # metrics port
  egress:
    # Allow to database tier
    - to:
        - podSelector:
            matchLabels:
              app: payments-db
              tier: database
      ports:
        - protocol: TCP
          port: 5432
    # Allow to Kafka
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kafka
      ports:
        - protocol: TCP
          port: 9092
    # Allow DNS resolution (always required)
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
---
# Allow fraud service to call external scoring API
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-fraud-egress-external
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: fraud-scoring-service
  policyTypes:
    - Egress
  egress:
    # Allow HTTPS to external fraud scoring providers
    - ports:
        - protocol: TCP
          port: 443
      to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8      # block access to internal CIDR
              - 172.16.0.0/12
              - 192.168.0.0/16
```

### 7.3 Network Segmentation Architecture

```
┌───────────────────────────────────────────────────────────┐
│                    Namespace: ingress-nginx                │
│  ┌────────────────┐                                       │
│  │  nginx-ingress │                                       │
│  └───────┬────────┘                                       │
└──────────┼────────────────────────────────────────────────┘
           │  NetworkPolicy: allow port 8080 from ingress-nginx NS
┌──────────▼────────────────────────────────────────────────┐
│                    Namespace: payments                     │
│  ┌─────────────────┐    ┌─────────────────────┐          │
│  │ payment-processor│───▶│  fraud-scoring      │          │
│  │  (PCI in-scope) │    │  (PCI in-scope)      │          │
│  └────────┬────────┘    └─────────────────────┘          │
│           │                                               │
│           │  NetworkPolicy: allow port 5432               │
│  ┌────────▼────────────────────────┐                     │
│  │       payments-db (PostgreSQL)  │                     │
│  │       (PCI in-scope)            │                     │
│  └─────────────────────────────────┘                     │
└───────────────────────────────────────────────────────────┘
```

---

## 8. Production Pitfalls

### Pitfall 1 — Missing DNS Egress in NetworkPolicy

NetworkPolicy blocks UDP/53 traffic by default when default-deny-all is applied. This silently breaks service discovery.

**Broken (no DNS egress):**
```yaml
# default-deny-all applied; payment-processor cannot resolve ANY name
# kubectl logs payment-processor: java.net.UnknownHostException: fraud-service
```

**Fixed:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: payments
spec:
  podSelector: {}              # apply to all pods in namespace
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53             # TCP fallback for large DNS responses
```

Always create a dedicated `allow-dns-egress` NetworkPolicy as the first policy in every namespace.

### Pitfall 2 — Session Draining on Pod Termination

When a pod is terminated, kube-proxy removes it from the iptables rule, but in-flight requests may already be routed to the terminating pod. Setting `terminationGracePeriodSeconds` without a `preStop` sleep causes connection errors.

**Broken:**
```yaml
spec:
  containers:
    - name: payment-processor
      lifecycle: {}            # no preStop hook
  terminationGracePeriodSeconds: 30
  # Connections dropped during rolling update!
```

**Fixed:**
```yaml
spec:
  containers:
    - name: payment-processor
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "sleep 5"]
            # Give kube-proxy 5s to remove pod from iptables
            # before the container stops accepting connections
  terminationGracePeriodSeconds: 60
```

### Pitfall 3 — Ingress Path Matching Ambiguity

NGINX Ingress evaluates `Prefix` paths in longest-match order, but `Exact` paths take precedence. A misconfigured path can route fraud API traffic to the payment service.

**Broken:**
```yaml
# /api/v1/fraud is a prefix of /api/v1 — which rule wins?
paths:
  - path: /api/v1
    pathType: Prefix           # catches /api/v1/fraud FIRST if listed first
    backend:
      service:
        name: payment-service
        port:
          number: 80
  - path: /api/v1/fraud
    pathType: Prefix
    backend:
      service:
        name: fraud-service
        port:
          number: 80
```

**Fixed:**
```yaml
# More specific paths must come BEFORE less specific in the rules list
paths:
  - path: /api/v1/fraud        # specific first
    pathType: Prefix
    backend:
      service:
        name: fraud-service
        port:
          number: 80
  - path: /api/v1              # general second
    pathType: Prefix
    backend:
      service:
        name: payment-service
        port:
          number: 80
```

---

## 9. Operational Checklist

- [ ] Default-deny-all NetworkPolicy applied to every namespace in PCI scope
- [ ] DNS egress (UDP+TCP/53) explicitly allowed in every namespace
- [ ] `externalTrafficPolicy: Local` set on all LoadBalancer services that require source IP logging
- [ ] Ingress rate limiting configured per endpoint (not one global limit)
- [ ] CoreDNS `cache` plugin configured with appropriate TTLs
- [ ] `preStop` lifecycle hook with 5-second sleep on all payment pods
- [ ] TLS 1.2+ enforced at Ingress controller level; TLS 1.0/1.1 disabled
- [ ] Security headers (HSTS, X-Frame-Options, CSP) configured in Ingress annotations
- [ ] NodePort services removed from production namespaces
- [ ] Calico/Cilium NetworkPolicy audit log enabled for PCI-DSS evidence
- [ ] IPVS mode (or Cilium eBPF) used in clusters with >500 services
- [ ] FQDNs used in Java HttpClient to avoid ndots:5 search domain overhead
- [ ] Ingress paths ordered most-specific-first to prevent routing mismatches

---

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "A payment pod with default-deny-all NetworkPolicy cannot resolve 'fraud-service' by name. What is the most likely cause?",
      "options": [
        "The fraud service has no ClusterIP assigned",
        "UDP/53 egress to kube-dns is blocked by the NetworkPolicy",
        "CoreDNS is not installed in the cluster",
        "The fraud service is in a different cloud region"
      ],
      "correct": 1,
      "explanation": "Default-deny-all blocks all egress including DNS traffic on UDP/53. Without an explicit egress rule allowing traffic to kube-dns on port 53, all DNS resolution fails and pods cannot discover any service by name."
    },
    {
      "text": "Which Service type preserves the original client source IP without additional configuration, making it suitable for PCI-DSS audit log requirements?",
      "options": [
        "ClusterIP with sessionAffinity: ClientIP",
        "NodePort with externalTrafficPolicy: Cluster",
        "LoadBalancer with externalTrafficPolicy: Local",
        "ExternalName with PROXY protocol disabled"
      ],
      "correct": 2,
      "explanation": "LoadBalancer with externalTrafficPolicy: Local routes traffic only to pods on the same node as the entry point, preserving the original client IP. The Cluster policy performs SNAT, replacing the source IP with the node IP, which breaks audit logging."
    },
    {
      "text": "A Java service making HTTPS calls to an external payment gateway observes 4 DNS queries per request despite having a valid hosts file entry. What configuration causes this?",
      "options": [
        "CoreDNS cache TTL is set to zero",
        "The ndots:5 setting causes search domain iteration for names with fewer than 5 dots",
        "The ExternalName service is misconfigured",
        "IPVS mode is not enabled in kube-proxy"
      ],
      "correct": 1,
      "explanation": "The default ndots:5 in pod /etc/resolv.conf means names with fewer than 5 dots are tried against each search domain (.payments.svc.cluster.local, .svc.cluster.local, .cluster.local) before the absolute lookup. Using a trailing dot (api.visa.com.) forces an absolute lookup, eliminating unnecessary queries."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "Implement Fintech Network Segmentation",
  "difficulty": "advanced",
  "estimatedMinutes": 90,
  "tasks": [
    {
      "id": "task-1",
      "description": "Deploy a 3-tier payment application (ingress → payment-processor → payments-db) in a 'payments' namespace. Apply default-deny-all NetworkPolicy and verify that the payment-processor pod cannot ping the internet or reach other namespaces."
    },
    {
      "id": "task-2",
      "description": "Create NetworkPolicy resources that allow: (a) NGINX Ingress to reach payment-processor on port 8080, (b) payment-processor to reach payments-db on port 5432, (c) DNS egress from all pods to kube-dns on UDP/53. Verify each rule with curl and kubectl exec."
    },
    {
      "id": "task-3",
      "description": "Configure an NGINX Ingress with TLS termination (use cert-manager self-signed issuer for local testing) for 'api.local'. Add rate limiting of 10 req/sec per IP on the /api/v1/payments path. Verify rate limiting triggers HTTP 429 with a load test."
    },
    {
      "id": "task-4",
      "description": "Instrument a Spring Boot service to use FQDN-based DNS (ending in .svc.cluster.local) for all inter-service calls. Use Wireshark or Hubble CLI to capture DNS traffic and confirm single-query resolution instead of search-domain iteration. Document the DNS query reduction in a Markdown report."
    }
  ]
} -->
