---
id: track-12-lesson-05
title: "Service Mesh — Istio Traffic Management and Observability"
slug: service-mesh-istio
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 5
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [Istio, service-mesh, mTLS, traffic-management, Envoy]
prerequisites: [track-12-lesson-04]
---

# Service Mesh — Istio Traffic Management and Observability

> [!NOTE]
> Istio gives every service in your payment platform mutual TLS, circuit breaking, and distributed tracing without changing a single line of application code. For financial services, this means you can satisfy PCI-DSS requirement 4 (encrypt cardholder data in transit) across all inter-service communication by configuring a single Istio PeerAuthentication policy — not by modifying 30 individual services.

## Istio Architecture

Istio consists of two planes:

**Control plane (Istiod):**
- Pilot: distributes traffic management rules to Envoy proxies
- Citadel (now integrated): manages certificates and mTLS identity
- Galley: validates and distributes configuration

**Data plane:**
- Envoy sidecar proxies injected into every pod
- All inbound and outbound traffic flows through the sidecar
- Application code is unaware of the proxy

```
Payment Gateway Pod                    Payment Processor Pod
+---------------------------+          +---------------------------+
|  payment-gateway          |          |  payment-processor        |
|  container                |          |  container                |
|          |                |          |          |                |
|          v                |          |          v                |
|  istio-proxy (Envoy)      |          |  istio-proxy (Envoy)      |
|  - mTLS termination       | <------> |  - mTLS termination       |
|  - metrics collection     |   mTLS   |  - metrics collection     |
|  - tracing headers        |          |  - tracing headers        |
+---------------------------+          +---------------------------+
            ^                                      ^
            |                                      |
            +-------------- Istiod ----------------+
                    (distributes config and certs)
```

---

## 1. Installing Istio

```bash
# Install Istio using istioctl (production profile)
istioctl install --set profile=production -y \
  --set components.egressGateways[0].enabled=true \
  --set components.egressGateways[0].name=istio-egressgateway

# Enable sidecar injection for the payments namespace
kubectl label namespace payments istio-injection=enabled

# Verify injection is working
kubectl get pods -n payments -o jsonpath='{.items[*].spec.containers[*].name}'
# Should show both application container and istio-proxy
```

### Istio Configuration for Financial Platform

```yaml
# IstioOperator spec for production financial platform
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: financial-platform-istio
  namespace: istio-system
spec:
  profile: production
  meshConfig:
    # Enable distributed tracing
    enableTracing: true
    defaultConfig:
      tracing:
        zipkin:
          address: jaeger-collector.monitoring:9411
        sampling: 10.0   # 10% sampling rate (increase during incidents)
    # Access log format for PCI-DSS audit trail
    accessLogFile: /dev/stdout
    accessLogFormat: |
      [%START_TIME%] "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%"
      %RESPONSE_CODE% %RESPONSE_FLAGS% %BYTES_RECEIVED% %BYTES_SENT%
      %DURATION% %RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%
      "%REQ(X-FORWARDED-FOR)%" "%REQ(USER-AGENT)%"
      "%REQ(X-REQUEST-ID)%" "%REQ(:AUTHORITY)%" "%UPSTREAM_HOST%"
    # mTLS mode
    enableAutoMtls: true
  components:
    pilot:
      k8s:
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 1000m
            memory: 4Gi
        hpaSpec:
          minReplicas: 2
          maxReplicas: 5
    ingressGateways:
    - name: istio-ingressgateway
      enabled: true
      k8s:
        resources:
          requests:
            cpu: 1000m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 2Gi
        hpaSpec:
          minReplicas: 3
          maxReplicas: 10
  values:
    global:
      proxy:
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
        # Concurrency = number of worker threads per Envoy proxy
        # Set to number of vCPUs on payment processing nodes
        concurrency: 4
```

---

## 2. mTLS Between Services

### Enabling Strict mTLS

For PCI-DSS compliance, all cardholder data in transit must be encrypted. Istio's PeerAuthentication enforces mTLS between all services.

```yaml
# Enforce strict mTLS in the payments namespace
# No unencrypted connections allowed
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: payments-strict-mtls
  namespace: payments
spec:
  mtls:
    mode: STRICT

---
# Mesh-wide policy: STRICT mTLS everywhere (except legacy namespaces)
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system
spec:
  mtls:
    mode: STRICT
```

### Certificate Rotation

Istio automatically rotates service certificates every 24 hours by default. For high-security financial environments, reduce this to 1 hour:

```yaml
# Istiod configuration for short-lived certificates
apiVersion: v1
kind: ConfigMap
metadata:
  name: istio
  namespace: istio-system
data:
  mesh: |
    # Certificate lifetime: 1 hour
    defaultCertTTL: 3600s
    # Start rotation when 50% of lifetime elapsed (30 minutes)
    defaultWorkloadCertTTL: 3600s
```

### Verifying mTLS

```bash
# Check if mTLS is active between payment-gateway and payment-processor
istioctl x describe pod payment-processor-xxx -n payments

# Check mutual TLS status in Kiali
kubectl port-forward -n istio-system svc/kiali 20001:20001

# View Envoy TLS config for a pod
istioctl proxy-config cluster payment-processor-xxx.payments \
  | grep payment-processor

# Verify certificate details
istioctl proxy-config secret payment-processor-xxx.payments \
  -o json | jq '.dynamicActiveSecrets[].name'
```

---

## 3. Traffic Management

### VirtualService — Routing Rules

VirtualService defines how requests are routed to services. It is the primary traffic management resource in Istio.

```yaml
# VirtualService for payment processor with timeout, retry, and fault injection
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-processor-vs
  namespace: payments
spec:
  hosts:
  - payment-processor                            # short name within namespace
  - payment-processor.payments.svc.cluster.local # FQDN
  http:
  - name: "payment-api-route"
    match:
    - uri:
        prefix: /api/v1/payments
    # Timeout for payment processing (fail fast to avoid blocking)
    timeout: 10s
    # Retry policy — retry on connection failures and 5xx (not 4xx)
    retries:
      attempts: 3
      perTryTimeout: 3s
      retryOn: "connect-failure,refused-stream,unavailable,cancelled,retriable-4xx,5xx"
      retryRemoteLocalities: true  # don't retry on the same upstream if possible
    route:
    - destination:
        host: payment-processor
        port:
          number: 8080
      weight: 100
  - name: "health-check-route"
    match:
    - uri:
        prefix: /actuator/health
    timeout: 2s
    route:
    - destination:
        host: payment-processor
        port:
          number: 8080
```

### DestinationRule — Load Balancing and Circuit Breaking

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-processor-dr
  namespace: payments
spec:
  host: payment-processor
  # Traffic policy applies to all versions
  trafficPolicy:
    # Load balancing algorithm
    loadBalancer:
      simple: LEAST_CONN     # better than ROUND_ROBIN for variable-latency services
    # Connection pool — limit connections to prevent cascade failures
    connectionPool:
      tcp:
        maxConnections: 1000
        connectTimeout: 500ms
        tcpKeepalive:
          time: 7200s
          interval: 75s
      http:
        h2UpgradePolicy: UPGRADE        # use HTTP/2 for multiplexing
        http1MaxPendingRequests: 1000   # queue depth
        http2MaxRequests: 10000
        maxRequestsPerConnection: 1000  # prevent connection starvation
        maxRetries: 10                  # cluster-wide retry budget
    # Circuit breaker — outlier detection
    outlierDetection:
      consecutiveGatewayErrors: 5       # open circuit after 5 consecutive 502/503/504
      consecutive5xxErrors: 10          # or 10 consecutive 5xx
      interval: 30s                     # check interval
      baseEjectionTime: 30s             # minimum time to eject
      maxEjectionPercent: 50            # never eject more than 50% of endpoints
      minHealthPercent: 50              # stop ejecting if fewer than 50% are healthy
  # TLS settings for mTLS (Istio handles this automatically with auto mTLS)
  tls:
    mode: ISTIO_MUTUAL
  # Version-specific subsets for canary deployments
  subsets:
  - name: stable
    labels:
      version: stable
  - name: canary
    labels:
      version: canary
    trafficPolicy:
      connectionPool:
        http:
          http1MaxPendingRequests: 100   # limit canary traffic queue
```

---

## 4. Canary Deployments with Traffic Splitting

```yaml
# Split 5% of traffic to canary version of payment processor
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-processor-canary
  namespace: payments
spec:
  hosts:
  - payment-processor
  http:
  - name: payment-api-canary
    match:
    - uri:
        prefix: /api/v1/payments
    timeout: 10s
    retries:
      attempts: 3
      perTryTimeout: 3s
      retryOn: "5xx,connect-failure"
    route:
    - destination:
        host: payment-processor
        subset: stable
      weight: 95
    - destination:
        host: payment-processor
        subset: canary
      weight: 5

---
# Header-based canary — internal testers get 100% canary
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-processor-header-canary
  namespace: payments
spec:
  hosts:
  - payment-processor
  http:
  - name: canary-header-route
    match:
    - headers:
        x-canary:
          exact: "true"
    route:
    - destination:
        host: payment-processor
        subset: canary
      weight: 100
  - name: stable-route
    route:
    - destination:
        host: payment-processor
        subset: stable
      weight: 100
```

---

## 5. Observability — Metrics, Logs, and Traces from Envoy

Istio's Envoy proxies automatically emit:
- **Metrics**: RED metrics (Rate, Errors, Duration) for every service-to-service call
- **Access logs**: structured logs of every HTTP/gRPC request
- **Traces**: distributed traces with Zipkin/Jaeger-compatible span propagation

### Prometheus Metrics from Istio

Istio auto-generates metrics with standard labels. These are the key metrics for financial service SLOs:

```yaml
# Key Istio metrics for payment platform dashboards
# (these are pre-built — no application code needed)

# Request rate: istio_requests_total
# Error rate:   istio_requests_total{response_code=~"5.."}
# Latency p99:  istio_request_duration_milliseconds_bucket

# Prometheus recording rules for payment platform SLO
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-slo-rules
  namespace: monitoring
spec:
  groups:
  - name: payment-slo
    interval: 30s
    rules:
    - record: job:payment_success_rate:ratio5m
      expr: |
        sum(rate(istio_requests_total{
          destination_service_name="payment-processor",
          response_code!~"5.."
        }[5m]))
        /
        sum(rate(istio_requests_total{
          destination_service_name="payment-processor"
        }[5m]))

    - record: job:payment_p99_latency:ms5m
      expr: |
        histogram_quantile(0.99,
          sum(rate(istio_request_duration_milliseconds_bucket{
            destination_service_name="payment-processor"
          }[5m])) by (le)
        )

    - alert: PaymentSuccessRateLow
      expr: job:payment_success_rate:ratio5m < 0.999
      for: 2m
      labels:
        severity: critical
        team: payments-platform
      annotations:
        summary: "Payment processor success rate below 99.9%"
        description: "Current rate: {{ $value | humanizePercentage }}"

    - alert: PaymentP99LatencyHigh
      expr: job:payment_p99_latency:ms5m > 500
      for: 5m
      labels:
        severity: warning
        team: payments-platform
      annotations:
        summary: "Payment processor p99 latency above 500ms"
```

### Distributed Tracing

```java
// Spring Boot application — Istio automatically propagates B3 trace headers
// Application code only needs to forward the headers it receives
// Spring Cloud Sleuth handles this automatically:

// pom.xml dependency:
// <dependency>
//   <groupId>org.springframework.cloud</groupId>
//   <artifactId>spring-cloud-starter-sleuth</artifactId>
// </dependency>

// application.yml:
// spring:
//   sleuth:
//     propagation:
//       type: B3           # compatible with Istio's B3 propagation
//     sampler:
//       probability: 0.1   # 10% sampling rate matches Istio config

@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    private final PaymentService paymentService;
    private static final Logger log = LoggerFactory.getLogger(PaymentController.class);

    @PostMapping
    public ResponseEntity<PaymentResponse> processPayment(
            @RequestBody PaymentRequest request,
            @RequestHeader("x-request-id") String requestId,
            // Istio injects these headers; Sleuth propagates them automatically
            @RequestHeader(value = "x-b3-traceid", required = false) String traceId) {

        // MDC is automatically populated by Sleuth — trace ID appears in all log lines
        log.info("Processing payment request: {}", requestId);

        PaymentResponse response = paymentService.process(request);
        return ResponseEntity.ok(response);
    }
}
```

### Kiali Dashboard Configuration

```yaml
# Kiali configuration for financial platform
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: istio-system
spec:
  auth:
    strategy: openid
    openid:
      client_id: "kiali"
      issuer_uri: "https://auth.example-bank.com/realms/platform"
  deployment:
    accessible_namespaces:
    - payments
    - fraud
    - risk
    - databases
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
  external_services:
    prometheus:
      url: http://prometheus-operated.monitoring:9090
    tracing:
      enabled: true
      in_cluster_url: http://jaeger-query.monitoring:16686
    grafana:
      enabled: true
      in_cluster_url: http://grafana.monitoring:3000
```

---

## 6. Egress Traffic Control

For financial services, egress must be strictly controlled. External calls to VISA, Mastercard, or SWIFT must go through known, auditable paths.

```yaml
# ServiceEntry — register external payment network as a known service
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: visa-payment-network
  namespace: payments
spec:
  hosts:
  - api.visa.com
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  resolution: DNS
  location: MESH_EXTERNAL

---
# VirtualService — apply timeout and retry to calls to VISA
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: visa-payment-network-vs
  namespace: payments
spec:
  hosts:
  - api.visa.com
  http:
  - timeout: 30s
    retries:
      attempts: 2
      perTryTimeout: 10s
      retryOn: "connect-failure,5xx"
    route:
    - destination:
        host: api.visa.com
        port:
          number: 443

---
# Egress Gateway — all external traffic routes through the egress gateway
# (required for auditable egress in PCI-DSS environments)
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: payments-egress-gateway
  namespace: istio-system
spec:
  selector:
    istio: egressgateway
  servers:
  - port:
      number: 443
      name: tls
      protocol: TLS
    hosts:
    - api.visa.com
    - api.mastercard.com
    tls:
      mode: PASSTHROUGH
```

---

## 7. AuthorizationPolicy for Fine-Grained Access Control

```yaml
# Only payment-gateway can call payment-processor (layer 7 RBAC)
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: payment-processor-authz
  namespace: payments
spec:
  selector:
    matchLabels:
      app: payment-processor
  rules:
  # Allow payment-gateway to call POST /api/v1/payments
  - from:
    - source:
        principals:
        - cluster.local/ns/payments/sa/payment-gateway
    to:
    - operation:
        methods: ["POST"]
        paths: ["/api/v1/payments", "/api/v1/payments/*"]
  # Allow monitoring to scrape metrics
  - from:
    - source:
        principals:
        - cluster.local/ns/monitoring/sa/prometheus
    to:
    - operation:
        methods: ["GET"]
        paths: ["/actuator/prometheus"]
  # Allow health checks from anywhere (required for K8s probes via kube-proxy)
  - from:
    - source:
        principals: ["*"]
    to:
    - operation:
        methods: ["GET"]
        paths: ["/actuator/health", "/actuator/health/*"]
```

---

## Production Checklist

- [ ] Strict mTLS enforced in all production namespaces (PeerAuthentication STRICT)
- [ ] Envoy sidecar resource requests set to prevent proxy starvation
- [ ] Circuit breaker (outlier detection) configured on all DestinationRules
- [ ] Timeout set on all VirtualServices — no unbounded waits on payment calls
- [ ] Retry policy configured with idempotency check (do not retry POST payments blindly)
- [ ] Egress gateway routing all external calls (VISA, Mastercard) for audit trail
- [ ] Istio access logs shipped to SIEM (PCI-DSS requirement 10)
- [ ] Tracing sampling rate set to 10% steady-state, 100% during incidents
- [ ] Certificate TTL set to 1 hour for high-security environments
- [ ] AuthorizationPolicy denies all by default; explicit allow rules only
- [ ] Kiali access restricted via OIDC (no anonymous access to service topology map)

---

## Summary

Istio moves cross-cutting concerns — mTLS, timeouts, retries, circuit breaking, tracing — out of application code and into the infrastructure. For a financial platform with 30+ microservices, this means you can enforce PCI-DSS encryption requirements cluster-wide with two YAML files rather than changes to every service. The distributed tracing and Envoy metrics give you the observability floor every payment platform needs: p99 latency, error rate, and dependency topology are available from day one, without instrumenting a single application. The investment is sidecar CPU overhead (~100m per pod) and operational complexity; the return is a consistent, auditable security and observability layer across your entire payments infrastructure.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Istio strict mTLS mode is enabled cluster-wide via PeerAuthentication. A legacy service without an Envoy sidecar tries to connect to a payment-api pod. What happens?",
      "options": [
        "The connection succeeds — strict mTLS only applies to sidecar-to-sidecar communication",
        "The connection is rejected — strict mode requires all traffic to use mTLS, and a service without a sidecar cannot present a certificate",
        "The connection is downgraded to plaintext automatically to maintain backward compatibility",
        "The connection is quarantined pending manual approval from the mesh administrator"
      ],
      "correct": 1,
      "explanation": "Strict mTLS mode means the payment-api's Envoy proxy only accepts connections that present a valid mTLS certificate. A service without an Envoy sidecar cannot initiate an mTLS handshake (no SPIFFE certificate), so its connection is rejected. This is the intended behaviour — strict mode is used to enforce zero-trust network security in the mesh. Services that cannot be migrated to the mesh immediately can be excluded via namespace-level PeerAuthentication with PERMISSIVE mode during a migration window."
    },
    {
      "text": "A DestinationRule configures outlierDetection with consecutiveGatewayErrors=3 and interval=30s. After 3 consecutive 503 errors from one pod, what happens to that pod?",
      "options": [
        "The pod is deleted and rescheduled by the Kubernetes scheduler",
        "The pod is ejected from the load balancing pool for the ejectionSweepInterval duration — traffic routes only to healthy pods until the ejection period expires",
        "Istio sends a SIGTERM to the pod to trigger a graceful restart",
        "All future requests to the service return 503 until an operator manually re-enables the pod"
      ],
      "correct": 1,
      "explanation": "Outlier detection (circuit breaking) works by tracking error rates per endpoint. When an endpoint (pod) exceeds the threshold (3 consecutive gateway errors), Envoy ejects it from the load balancing pool for a configurable ejection period. Other pods continue serving traffic. The ejected pod is periodically re-tested; if it recovers, it is re-admitted to the pool. This is entirely in the data plane (Envoy) — Kubernetes is not involved. The pod continues running; it just receives no new traffic during the ejection window."
    },
    {
      "text": "A VirtualService for payment-api is configured to route 90% of traffic to the stable subset and 10% to the canary subset. How does Istio implement this split at the data plane level?",
      "options": [
        "Istio modifies the Deployment replica count — 9 stable replicas and 1 canary replica",
        "Each Envoy proxy uses weighted routing in its load balancing configuration, probabilistically forwarding approximately 10% of requests to canary endpoints regardless of replica count",
        "Istio uses DNS round-robin with 9 stable A records and 1 canary A record",
        "A dedicated load balancer instance handles the traffic split between the two Kubernetes Services"
      ],
      "correct": 1,
      "explanation": "Istio traffic splitting is implemented in the Envoy proxy's routing configuration via xDS (specifically the Route Discovery Service). Each incoming request is forwarded based on weighted probabilistic selection across defined subsets. This is independent of replica count — a 90/10 split with 1 stable pod and 1 canary pod still routes 90% to stable. DestinationRule subsets select pods by label (e.g., version: stable vs version: canary), and Envoy distributes traffic across matching endpoints according to the VirtualService weights."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Service Mesh Security and Observability for Payment Services",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    "Enable Istio strict mTLS cluster-wide with a PeerAuthentication resource. Add an AuthorizationPolicy to the payment-api that allows ONLY the checkout-service ServiceAccount to call it on port 8080, and blocks all other sources. Test the policy by exec-ing into a pod with a different ServiceAccount and attempting a curl call — verify it returns RBAC access denied.",
    "Configure a VirtualService for payment-api with a 3-second timeout and retry policy (3 attempts, 500ms per-try timeout, retryOn: 5xx,gateway-error,connect-failure,retriable-4xx). Simulate a downstream service returning 503 by injecting a fault using an Istio FaultInjection abort (httpStatus: 503, percentage: 100) on the fraud-service VirtualService. Verify that the payment-api retries 3 times before returning the final error, using Envoy access logs to count retry attempts.",
    "Implement a canary deployment using Istio traffic splitting: deploy payment-api v2 (canary) alongside v1 (stable). Create a DestinationRule with two subsets (version: v1 and version: v2) and a VirtualService splitting 95% to v1 and 5% to v2. Add a header-based override so that requests with header X-Canary: true always route to v2. Validate the split by sending 200 requests and verifying approximately 10 reach v2 (5% ± statistical variance).",
    "Set up Istio distributed tracing with Jaeger: configure the mesh to sample 100% of payment-api traces, propagate B3 trace context headers through the checkout → payment-api → fraud-service call chain, and query Jaeger to find traces where the total span duration exceeds 2 seconds. Write a test that injects a 1.5-second delay on fraud-service using Istio FaultInjection and verifies the full trace appears in Jaeger with the delay visible in the fraud-service span."
  ]
}
-->
