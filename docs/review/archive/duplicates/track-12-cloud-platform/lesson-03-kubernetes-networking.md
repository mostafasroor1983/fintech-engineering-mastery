---
id: track-12-lesson-03
title: "Kubernetes Networking — CNI, Services, and Ingress"
slug: kubernetes-networking
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 3
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [CNI, Service, Ingress, NetworkPolicy, Calico]
prerequisites: [track-12-lesson-02]
---

# Kubernetes Networking — CNI, Services, and Ingress

> [!NOTE]
> In a financial platform, the network is not just plumbing — it is a security boundary. Every hop between the payment service and the database is a potential lateral movement path for an attacker. Kubernetes NetworkPolicy is your first line of microsegmentation, and understanding how packets actually flow through the CNI lets you reason about latency, failure modes, and compliance requirements.

## Kubernetes Networking Model

Kubernetes enforces three networking rules:

1. Every pod gets its own IP address
2. Pods on any node can communicate with any other pod without NAT
3. The IP a pod sees for itself is the same IP other pods use to reach it

This flat network model simplifies service discovery but requires explicit NetworkPolicy to enforce isolation. Without NetworkPolicy, every pod in the cluster can reach every other pod — a critical gap for PCI-DSS and SOX compliance.

---

## 1. CNI Plugins: Calico and Cilium

The Container Network Interface (CNI) plugin implements the Kubernetes networking model. It allocates pod IPs, programs routing tables, and enforces NetworkPolicy. For financial services, the two most relevant choices are Calico and Cilium.

### Calico

Calico uses BGP for route distribution and iptables/eBPF for packet filtering. It is the most widely deployed CNI in regulated financial environments because:

- Mature NetworkPolicy enforcement (iptables is auditable)
- GlobalNetworkPolicy for cluster-wide rules (not in vanilla Kubernetes NetworkPolicy)
- Integration with existing BGP infrastructure (useful in on-premises deployments)
- FIPS-validated builds available for US federal and defence-adjacent financial institutions

#### Calico Installation (via operator)

```yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
    - blockSize: 26
      cidr: 10.48.0.0/16
      encapsulation: VXLANCrossSubnet   # VXLAN within subnet, native routing across
      natOutgoing: Enabled
      nodeSelector: all()
  # Enable eBPF dataplane for high-throughput payment workloads
  calicoNetwork:
    linuxDataplane: BPF
```

### Cilium

Cilium uses eBPF exclusively and provides L7-aware NetworkPolicy (you can write policies that allow HTTP GET /api/payments but block POST /api/admin). For payment platforms this enables:

- API-level microsegmentation without a service mesh
- Real-time network flow visibility via Hubble
- Transparent encryption with WireGuard

```yaml
# Cilium Helm values for financial platform
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  enable-hubble: "true"
  hubble-listen-address: ":4244"
  hubble-metrics-server: ":9091"
  enable-bandwidth-manager: "true"      # BBR congestion control for payment traffic
  enable-wireguard: "true"              # encrypt all pod-to-pod traffic
  kube-proxy-replacement: "strict"      # replace kube-proxy entirely with eBPF
  enable-l7-proxy: "true"              # L7 policy enforcement
```

---

## 2. Service Types

Services provide stable IP addresses and DNS names for pods. The underlying pod IPs change with every restart; the Service IP is permanent.

### ClusterIP — Internal Services

ClusterIP is the default. The Service is reachable only from within the cluster. Use this for all inter-service communication.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-processor
  namespace: payments
  labels:
    app: payment-processor
  annotations:
    # Prometheus scraping
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
    prometheus.io/path: "/actuator/prometheus"
spec:
  type: ClusterIP
  selector:
    app: payment-processor
  ports:
  - name: http
    port: 8080
    targetPort: 8080
    protocol: TCP
  - name: https
    port: 8443
    targetPort: 8443
    protocol: TCP
  # Session affinity keeps a client's requests on the same pod
  # Use for stateful payment sessions (not ideal; prefer stateless)
  sessionAffinity: None
```

### NodePort — Avoid in Production

NodePort exposes the Service on every node's IP at a static port (30000-32767). Avoid in production financial deployments — it bypasses load balancers and creates firewall management complexity. Use LoadBalancer or Ingress instead.

### LoadBalancer — External Access via Cloud LB

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-gateway-external
  namespace: payments
  annotations:
    # AWS-specific: create an NLB (not ALB — NLB preserves source IP for PCI logging)
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
    # TLS termination at NLB using ACM certificate
    service.beta.kubernetes.io/aws-load-balancer-ssl-cert: "arn:aws:acm:us-east-1:123456789:certificate/abc-123"
    service.beta.kubernetes.io/aws-load-balancer-ssl-ports: "443"
    # Access log to S3 for PCI-DSS audit trail
    service.beta.kubernetes.io/aws-load-balancer-access-log-enabled: "true"
    service.beta.kubernetes.io/aws-load-balancer-access-log-s3bucket-name: "fintech-nlb-access-logs"
spec:
  type: LoadBalancer
  selector:
    app: payment-gateway
  ports:
  - name: https
    port: 443
    targetPort: 8443
    protocol: TCP
  externalTrafficPolicy: Local   # preserve source IP; prevents double-hop
```

> [!NOTE]
> `externalTrafficPolicy: Local` is critical for PCI-DSS compliance — it ensures the payment service sees the actual client IP in logs, not the node's internal IP. Without this, your cardholder data environment logs show only cluster-internal IPs, failing audit requirement 10.3.

### Headless Service — StatefulSets and Direct Pod DNS

For StatefulSets (PostgreSQL, Kafka), a headless Service returns individual pod IPs rather than a single VIP. This lets clients connect directly to specific replicas.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
  namespace: databases
spec:
  clusterIP: None   # headless
  selector:
    app: postgres
  ports:
  - name: postgres
    port: 5432
    targetPort: 5432
```

DNS for a StatefulSet with this Service: `postgres-0.postgres-headless.databases.svc.cluster.local`

---

## 3. Ingress Controllers

Ingress provides HTTP/HTTPS routing to Services based on host and path rules. The two most common choices in financial Kubernetes deployments are nginx Ingress and AWS ALB Ingress Controller.

### nginx Ingress Controller

```yaml
# nginx Ingress for internal payment API — TLS termination at ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-api-ingress
  namespace: payments
  annotations:
    kubernetes.io/ingress.class: "nginx"
    # Rate limiting — critical for financial APIs to prevent abuse
    nginx.ingress.kubernetes.io/limit-rps: "1000"
    nginx.ingress.kubernetes.io/limit-connections: "100"
    # Security headers
    nginx.ingress.kubernetes.io/configuration-snippet: |
      add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
      add_header X-Frame-Options "DENY" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header Content-Security-Policy "default-src 'none'" always;
    # mTLS client certificate authentication for B2B partners
    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"
    nginx.ingress.kubernetes.io/auth-tls-secret: "payments/client-ca-secret"
    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"
    # Request ID for distributed tracing
    nginx.ingress.kubernetes.io/enable-opentracing: "true"
    # Body size limit (prevent large payload attacks on payment endpoints)
    nginx.ingress.kubernetes.io/proxy-body-size: "1m"
spec:
  tls:
  - hosts:
    - api.payments.internal
    secretName: payments-tls-cert
  rules:
  - host: api.payments.internal
    http:
      paths:
      - path: /api/v1/payments
        pathType: Prefix
        backend:
          service:
            name: payment-processor
            port:
              number: 8080
      - path: /api/v1/accounts
        pathType: Prefix
        backend:
          service:
            name: account-service
            port:
              number: 8080
```

### AWS ALB Ingress Controller

The AWS Load Balancer Controller creates ALBs directly from Ingress resources. Use this when you need WAF integration (AWS WAF), Cognito authentication, or OIDC-based access control.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-portal-alb
  namespace: payments
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip    # direct pod routing, no NodePort
    alb.ingress.kubernetes.io/certificate-arn: "arn:aws:acm:us-east-1:123456789:certificate/abc-123"
    alb.ingress.kubernetes.io/ssl-policy: "ELBSecurityPolicy-TLS13-1-2-2021-06"
    # AWS WAF for PCI-DSS requirement 6.6
    alb.ingress.kubernetes.io/wafv2-acl-arn: "arn:aws:wafv2:us-east-1:123456789:regional/webacl/payment-waf/abc"
    # Access logging to S3
    alb.ingress.kubernetes.io/load-balancer-attributes: "access_logs.s3.enabled=true,access_logs.s3.bucket=fintech-alb-logs"
    # Health check
    alb.ingress.kubernetes.io/healthcheck-path: /actuator/health/readiness
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: "15"
    alb.ingress.kubernetes.io/healthy-threshold-count: "2"
    alb.ingress.kubernetes.io/unhealthy-threshold-count: "3"
spec:
  rules:
  - host: payments.example-bank.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: payment-portal
            port:
              number: 8080
```

---

## 4. NetworkPolicy for Microsegmentation

NetworkPolicy is the Kubernetes mechanism for controlling which pods can communicate with which other pods and external endpoints. Without NetworkPolicy, any pod can reach any other pod — including your database.

### Default-Deny Baseline

Always start with a default-deny policy in every namespace. Allowlist from there.

```yaml
# Default deny all ingress and egress in the payments namespace
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

### Payment Service: Allow Only What It Needs

```yaml
# payment-processor: allow ingress from payment-gateway, egress to DB namespace only
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-processor-netpol
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-processor
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Accept traffic from payment gateway
  - from:
    - podSelector:
        matchLabels:
          app: payment-gateway
    ports:
    - protocol: TCP
      port: 8080
  # Accept traffic from internal load balancer (nginx ingress)
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080
  egress:
  # Allow connection to PostgreSQL in databases namespace
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: databases
      podSelector:
        matchLabels:
          app: postgres
    ports:
    - protocol: TCP
      port: 5432
  # Allow connection to Redis cache
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: cache
      podSelector:
        matchLabels:
          app: redis
    ports:
    - protocol: TCP
      port: 6379
  # Allow DNS resolution (CoreDNS)
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
  # Allow calling fraud detection service
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: fraud
      podSelector:
        matchLabels:
          app: fraud-detection-api
    ports:
    - protocol: TCP
      port: 8080
  # Allow egress to Vault for secret retrieval
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: vault
    ports:
    - protocol: TCP
      port: 8200
```

### Database Namespace: Restrict to Approved Clients Only

```yaml
# databases namespace: only payments and risk namespaces can connect
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-ingress-allow
  namespace: databases
spec:
  podSelector:
    matchLabels:
      app: postgres
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: payments
    ports:
    - protocol: TCP
      port: 5432
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: risk
    ports:
    - protocol: TCP
      port: 5432
  # Allow monitoring from prometheus namespace
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9187   # postgres_exporter metrics port
```

> [!WARNING]
> NetworkPolicy is enforced by the CNI plugin. If your CNI does not support NetworkPolicy (e.g., Flannel), policies are silently ignored — all traffic still flows. Always verify CNI NetworkPolicy support before relying on it for compliance.

---

## 5. DNS Resolution with CoreDNS

CoreDNS is the DNS server inside Kubernetes. Every Service gets a DNS name: `<service>.<namespace>.svc.cluster.local`.

### DNS Name Patterns

```
# ClusterIP service:
payment-processor.payments.svc.cluster.local

# StatefulSet pod:
postgres-0.postgres-headless.databases.svc.cluster.local

# From the same namespace, short form works:
payment-processor:8080
```

### CoreDNS Configuration for Financial Platform

```yaml
# CoreDNS ConfigMap — tune for high-throughput payment namespaces
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
        # Forward internal corporate DNS for on-prem services
        forward corp.internal 10.0.0.53 10.0.1.53 {
           prefer_udp
           policy round_robin
           health_check 5s
        }
        prometheus :9153
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        cache {
          success 9984
          denial 1000
          # Increase TTL for stable financial service endpoints
          ttl 30
        }
        loop
        reload
        loadbalance
        # Log DNS queries for audit trail (sample at 10% to reduce volume)
        # log . {class denial error}
    }
```

### Tuning DNS for Payment Services

High-volume payment services make thousands of DNS lookups per second. Configure `ndots` and `dnsConfig` to reduce unnecessary DNS traffic:

```yaml
# In pod spec — reduce DNS round-trips for payment service
spec:
  dnsConfig:
    options:
    # ndots:5 is Kubernetes default — causes 5 DNS lookups per FQDN
    # Reduce to 2 for services that use FQDNs
    - name: ndots
      value: "2"
    - name: timeout
      value: "2"
    - name: attempts
      value: "3"
  dnsPolicy: ClusterFirst
```

---

## 6. kube-proxy: iptables vs eBPF

kube-proxy implements Service load balancing by programming iptables or IPVS rules on each node. For high-throughput payment platforms, the iptables implementation has known scaling limits.

### iptables Mode (default)

```
# How it works:
# 1. kube-proxy watches Service and Endpoint objects
# 2. For each Service, it creates iptables DNAT rules
# 3. Incoming packet hits PREROUTING -> KUBE-SERVICES chain -> random DNAT to pod IP

# Problem at scale:
# - iptables rules are O(n) — 10,000 services = 10,000+ rules per node
# - Every new connection traverses all rules sequentially
# - Rule updates lock the entire iptables table (brief packet drops)
```

### IPVS Mode (better for large clusters)

```yaml
# kube-proxy ConfigMap — enable IPVS mode
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-proxy
  namespace: kube-system
data:
  config.conf: |
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: ipvs
    ipvs:
      scheduler: rr        # round-robin; use "lc" (least connections) for payments
      syncPeriod: 30s
      minSyncPeriod: 5s
    iptables:
      masqueradeAll: false
      syncPeriod: 30s
```

### eBPF (Cilium kube-proxy replacement)

Cilium can fully replace kube-proxy with eBPF programs that implement Service load balancing at the kernel level, without iptables:

```yaml
# Cilium Helm values to replace kube-proxy
kubeProxyReplacement: strict
k8sServiceHost: 10.0.0.1       # API server IP
k8sServicePort: "6443"
# This achieves:
# - O(1) Service lookup via hash tables (not O(n) iptables scan)
# - Native load balancing in kernel (bypasses iptables entirely)
# - 30-40% lower latency for high-TPS payment workloads vs iptables
```

---

## 7. Calico GlobalNetworkPolicy for Cluster-Wide Rules

Calico's GlobalNetworkPolicy (not a standard Kubernetes resource) applies across all namespaces. Use it for cluster-wide security controls:

```yaml
# Calico GlobalNetworkPolicy — deny all external egress by default
# (use standard NetworkPolicy for namespace-specific rules)
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: deny-external-egress-by-default
spec:
  selector: "all()"
  types:
  - Egress
  egress:
  # Allow DNS
  - action: Allow
    protocol: UDP
    destination:
      ports: [53]
  - action: Allow
    protocol: TCP
    destination:
      ports: [53]
  # Allow communication within cluster (pod CIDR)
  - action: Allow
    destination:
      nets:
      - 10.48.0.0/16   # pod CIDR
      - 10.96.0.0/12   # service CIDR
  # Allow communication with Vault (external secrets backend)
  - action: Allow
    destination:
      nets:
      - 10.0.100.0/28   # Vault cluster IP range
      ports: [8200]
  # Deny all other external traffic
  - action: Deny
    destination:
      nets:
      - 0.0.0.0/0

---
# Allow payment services to reach external payment networks (VISA, Mastercard)
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: allow-payment-network-egress
spec:
  selector: "app == 'payment-gateway'"
  types:
  - Egress
  egress:
  - action: Allow
    destination:
      nets:
      - 192.168.1.0/28   # VISA network CIDR (example)
      - 192.168.2.0/28   # Mastercard network CIDR (example)
      ports: [443, 8443]
```

---

## 8. Troubleshooting Network Issues

```bash
# Test pod-to-pod connectivity
kubectl run -it --rm debug \
  --image=nicolaka/netshoot \
  --namespace=payments \
  -- nslookup payment-processor.payments.svc.cluster.local

# Test NetworkPolicy is working (should fail if policy is correct)
kubectl run -it --rm test-from-wrong-ns \
  --image=nicolaka/netshoot \
  --namespace=reporting \
  -- curl -v --max-time 5 http://postgres.databases.svc.cluster.local:5432

# Check which NetworkPolicies apply to a pod
kubectl get networkpolicy -n payments -o yaml

# View Calico policy rules (requires calicoctl)
calicoctl get networkpolicy -n payments -o yaml

# Check iptables rules for a Service (on a node)
iptables-save | grep payment-processor

# Cilium: view network flows with Hubble
hubble observe --namespace payments --follow

# Check CoreDNS logs for DNS failures
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100
```

---

## Production Checklist

- [ ] Default-deny NetworkPolicy applied to all namespaces
- [ ] Payment services can only reach databases they own (not shared DB namespace)
- [ ] Ingress has rate limiting configured to prevent payment API abuse
- [ ] `externalTrafficPolicy: Local` on LoadBalancer Services for source IP preservation
- [ ] CoreDNS `ndots` tuned down for high-TPS namespaces
- [ ] CNI confirmed to enforce NetworkPolicy (test with negative connectivity tests)
- [ ] NLB (not ALB) used for payment APIs that require source IP logging
- [ ] WAF attached to public-facing payment portal Ingress
- [ ] mTLS client certificates required for B2B partner API access
- [ ] All network access logs shipped to SIEM for PCI-DSS requirement 10

---

## Summary

Kubernetes networking begins with a flat model — every pod can reach every pod — and you build isolation on top of it with NetworkPolicy. For financial services, NetworkPolicy is not optional: the PCI-DSS requirement for network segmentation demands explicit allowlisting. The CNI you choose (Calico for mature iptables enforcement, Cilium for eBPF performance) determines your enforcement mechanism and performance ceiling. Service types let you expose workloads internally (ClusterIP), to the cloud load balancer (LoadBalancer), or to HTTP clients with routing rules (Ingress). Putting all of these together — strict NetworkPolicy, TLS at Ingress, NLB for source IP, DNS tuning — gives you a network that is both operationally efficient and compliant with financial sector security requirements.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A namespace has a default-deny-all NetworkPolicy (empty podSelector, empty ingress/egress). A payment-api pod needs to call a fraud-service pod in the same namespace. What is the minimum additional NetworkPolicy needed?",
      "options": [
        "No additional policy needed — pods in the same namespace bypass NetworkPolicy",
        "An egress policy on payment-api allowing traffic to fraud-service on its port, AND an ingress policy on fraud-service allowing traffic from payment-api",
        "A single ingress policy on fraud-service — egress is implicitly allowed when a matching ingress exists",
        "Delete the default-deny policy and use firewall rules at the node level instead"
      ],
      "correct": 1,
      "explanation": "NetworkPolicy is stateless by default — an egress rule on the sender and an ingress rule on the receiver must both exist. The default-deny-all blocks both directions. You need: (1) an egress NetworkPolicy on payment-api with podSelector matching fraud-service on the target port, and (2) an ingress NetworkPolicy on fraud-service with podSelector matching payment-api. Without both, the traffic is dropped by whichever policy is missing. Some CNIs (like Calico with connection tracking) can infer return traffic, but the safest and most portable approach is explicit bidirectional rules."
    },
    {
      "text": "A LoadBalancer Service is created with externalTrafficPolicy: Cluster (the default). A client's source IP needs to be preserved for fraud detection. What is the problem and solution?",
      "options": [
        "externalTrafficPolicy: Cluster always preserves the source IP — no change needed",
        "With Cluster policy, kube-proxy SNATs traffic to the node IP before forwarding to pods, losing the client source IP. Set externalTrafficPolicy: Local to preserve the original client IP, accepting that only nodes with a matching pod receive traffic",
        "Source IP preservation requires Cilium — it cannot be achieved with standard kube-proxy",
        "Add X-Forwarded-For header support to the application — load balancers always set this header"
      ],
      "correct": 1,
      "explanation": "With externalTrafficPolicy: Cluster, kube-proxy forwards traffic from the receiving node to any healthy pod cluster-wide using SNAT, replacing the source IP with the node's IP. The pod sees the node IP, not the client. With externalTrafficPolicy: Local, the load balancer only routes to nodes that have a matching pod, and kube-proxy does not SNAT — the pod sees the real client IP. The trade-off is unequal traffic distribution if pods are not evenly spread across nodes. For fraud detection where the client IP is a signal, Local policy is correct."
    },
    {
      "text": "CoreDNS is configured with ndots:5 (the Kubernetes default). A pod makes a DNS query for 'api.payments.svc.cluster.local'. How many DNS lookups does the pod actually make?",
      "options": [
        "One lookup — the full FQDN has 5 dots, which meets the ndots:5 threshold and is treated as absolute",
        "Six lookups — the resolver first tries all search domain suffixes before treating it as absolute",
        "Two lookups — one for the short name and one for the FQDN",
        "Zero lookups — Kubernetes caches all internal DNS names in the pod's local hosts file"
      ],
      "correct": 0,
      "explanation": "ndots:5 means that if a name has 5 or more dots, it is treated as an absolute FQDN immediately without appending search domain suffixes. 'api.payments.svc.cluster.local' has exactly 5 dots, so it is resolved directly in one lookup. For names with fewer than 5 dots (like 'api'), the resolver appends each search domain suffix in order (payments.svc.cluster.local, svc.cluster.local, cluster.local, etc.), resulting in multiple lookups. This is why internal service calls should use FQDNs or at least include enough dots to meet the ndots threshold."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Zero-Trust Network Segmentation for a Payment Namespace",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "Apply a default-deny-all NetworkPolicy to the payments namespace (empty ingress and egress rules). Then create explicit allowlist policies: payment-api can receive traffic from the ingress-nginx namespace on port 8080; payment-api can reach postgres on port 5432; payment-api can reach kafka on port 9093. Verify connectivity using kubectl exec with curl and netcat, confirming that all unlisted traffic (e.g., payment-api to external internet) is blocked.",
    "Configure an NGINX Ingress resource for payment-api with: TLS termination using a cert-manager Certificate, rate limiting of 100 requests per minute per IP using nginx.ingress.kubernetes.io/limit-rpm annotation, and a Canary ingress routing 10% of traffic to payment-api-v2 by weight. Test the canary split by sending 100 requests and counting how many reach each version.",
    "Reproduce and diagnose a DNS resolution latency problem: set ndots:5 in a pod's dnsConfig and use tcpdump or Cilium Hubble to observe the number of DNS queries for a short service name (e.g., 'fraud-service') vs. the full FQDN. Then fix the issue by either using FQDNs in service calls or reducing ndots to 2, and measure the latency improvement.",
    "Deploy Cilium as the CNI and enable L7 HTTP NetworkPolicy. Write a CiliumNetworkPolicy that allows payment-api to call fraud-service only on the HTTP path /api/v1/fraud-check using the POST method, and blocks all other HTTP paths. Write an integration test that verifies POST /api/v1/fraud-check succeeds and GET /health (to fraud-service from payment-api) is blocked with a 403."
  ]
}
-->
