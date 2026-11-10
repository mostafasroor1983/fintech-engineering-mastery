---
id: track-12-lesson-10
title: "Multi-Cluster Kubernetes — Federation and Workload Distribution"
slug: multi-cluster
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 10
difficulty: principal
estimatedMinutes: 85
status: published
tags: [multi-cluster, federation, fleet, workload-distribution, DR]
prerequisites: []
---

# Multi-Cluster Kubernetes — Federation and Workload Distribution

> [!NOTE]
> A single Kubernetes cluster is a single point of failure. For a payment platform processing millions of transactions per day, an entire cluster becoming unavailable — due to a Kubernetes control plane bug, a runaway operator, or a cloud region outage — is unacceptable. Multi-cluster architecture is not gold-plating; it is the minimum viable infrastructure for a financial platform with 99.99% uptime requirements.

## Why Multiple Clusters?

Before designing a multi-cluster architecture, understand the specific problem each cluster boundary solves:

| Motivation | Architecture | Financial Context |
|---|---|---|
| Disaster Recovery | Active-passive regional clusters | Survive AWS us-east-1 outage |
| Active-Active HA | Active-active with global load balancing | Zero-downtime failover for payment API |
| Data Residency | Per-region clusters with no cross-region data flow | GDPR: EU customer data stays in eu-west-1 |
| Blast Radius | Separate prod/staging/dev clusters | Staging deployment cannot affect production |
| Scale isolation | Separate cluster per business unit | Payments team isolated from trading platform |
| Compliance boundary | PCI-DSS cluster separate from non-PCI | Cardholder data environment (CDE) isolation |

```
Typical fintech multi-cluster topology:

  production-us-east-1   ← primary region, all production traffic
  production-us-west-2   ← DR region, hot standby (passive or active)
  production-eu-west-1   ← EU data residency, EU customer traffic
  staging                ← pre-production, all regions share one cluster
  dev                    ← development, ephemeral namespaces

  Each cluster has its own:
  - Control plane (etcd, kube-apiserver)
  - Node groups
  - Network policies
  - Secrets
  - Service accounts
```

---

## Cluster API: Cluster Lifecycle Management

Cluster API (CAPI) allows you to declaratively manage Kubernetes cluster lifecycle — creation, upgrades, and deletion — using Kubernetes-style YAML.

### Installing Cluster API

```bash
# Install clusterctl CLI
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.6.0/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Initialize management cluster with AWS provider
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=<access-key>
export AWS_SECRET_ACCESS_KEY=<secret-key>
export AWS_SESSION_TOKEN=<session-token>  # if using STS

clusterctl init --infrastructure aws
```

### Cluster Definition (CAPI)

```yaml
# Production payment cluster definition
# Applied to the management cluster — CAPI creates the actual cluster
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: payment-prod-us-east-1
  namespace: payment-clusters
  labels:
    environment: production
    region: us-east-1
    purpose: payments
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.100.0.0/16"]    # unique CIDR per cluster for multi-cluster networking
    services:
      cidrBlocks: ["10.101.0.0/16"]
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: AWSManagedControlPlane
    name: payment-prod-us-east-1-control-plane
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSManagedCluster
    name: payment-prod-us-east-1
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: AWSManagedControlPlane
metadata:
  name: payment-prod-us-east-1-control-plane
  namespace: payment-clusters
spec:
  region: us-east-1
  version: v1.29.0
  # EKS managed control plane
  eksClusterName: payment-prod-us-east-1
  # Enable private endpoint (security requirement for fintech)
  endpointAccess:
    private: true
    public: false  # no public access to Kubernetes API server
    publicCIDRs: []
  # Enable envelope encryption for secrets with KMS
  encryptionConfig:
    - resources: ["secrets"]
      provider: "arn:aws:kms:us-east-1:123456789:key/eks-key"
  addons:
    - name: vpc-cni
      version: v1.16.0
    - name: coredns
      version: v1.11.1
    - name: kube-proxy
      version: v1.29.0
    - name: aws-ebs-csi-driver
      version: v1.26.0
---
# Node group for payment workloads
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachinePool
metadata:
  name: payment-workers
  namespace: payment-clusters
spec:
  clusterName: payment-prod-us-east-1
  replicas: 6
  template:
    spec:
      bootstrap:
        dataSecretName: ""
      clusterName: payment-prod-us-east-1
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSManagedMachinePool
        name: payment-workers
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSManagedMachinePool
metadata:
  name: payment-workers
  namespace: payment-clusters
spec:
  instanceType: c6i.4xlarge   # 16 vCPU, 32GB — payment processing is compute-heavy
  scaling:
    minSize: 3
    maxSize: 50
  # Spread across all 3 AZs
  availabilityZones: [us-east-1a, us-east-1b, us-east-1c]
  # Use latest EKS-optimized AMI
  amiType: AL2_x86_64
  # Disk
  diskSize: 100
  # Labels applied to all nodes
  labels:
    workload: payments
    environment: production
  taints:
    - key: workload
      value: payments
      effect: NoSchedule   # only payment pods scheduled here
```

---

## ArgoCD Multi-Cluster Deployment

ArgoCD manages GitOps deployments across multiple clusters from a single control plane.

### ArgoCD Cluster Registration

```bash
# Register production US cluster
argocd cluster add payment-prod-us-east-1 \
  --name payment-prod-us-east-1 \
  --system-namespace argocd \
  --kubeconfig ~/.kube/payment-prod-us-east-1.yaml

# Register DR cluster
argocd cluster add payment-prod-us-west-2 \
  --name payment-prod-us-west-2 \
  --kubeconfig ~/.kube/payment-prod-us-west-2.yaml

# Register EU cluster (data residency)
argocd cluster add payment-prod-eu-west-1 \
  --name payment-prod-eu-west-1 \
  --kubeconfig ~/.kube/payment-prod-eu-west-1.yaml

# List registered clusters
argocd cluster list
```

### ApplicationSet: Deploy to All Clusters

```yaml
# ApplicationSet: deploy payment API to all production clusters
# When a new cluster is added to ArgoCD, the application is automatically deployed
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payment-api-global
  namespace: argocd
spec:
  generators:
    # Cluster generator: create one Application per registered cluster
    - clusters:
        selector:
          matchLabels:
            environment: production
            purpose: payments

  template:
    metadata:
      name: "payment-api-{{name}}"  # e.g., payment-api-payment-prod-us-east-1
      labels:
        cluster: "{{name}}"
        app: payment-api
    spec:
      project: payment-platform
      source:
        repoURL: https://github.com/fintech/payment-platform
        targetRevision: HEAD
        path: k8s/payment-api
        helm:
          releaseName: payment-api
          valueFiles:
            - "values.yaml"
            - "values-{{metadata.labels.environment}}.yaml"
            - "values-{{metadata.labels.region}}.yaml"  # region-specific overrides

      destination:
        server: "{{server}}"  # the cluster's API server URL
        namespace: payments

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

### Region-Specific Values Files

```yaml
# k8s/payment-api/values-us-east-1.yaml
# Region-specific configuration — overrides common values
replicaCount: 10  # more replicas in primary region

config:
  region: us-east-1
  primaryRegion: true
  dataResidency: us
  kafkaBootstrapServers: kafka.payments.svc.cluster.local:9092

ingress:
  host: api.payments.fintech.com  # primary domain

database:
  host: payment-postgres.payments.svc.cluster.local
  readReplica: payment-postgres-replica.payments.svc.cluster.local
---
# k8s/payment-api/values-eu-west-1.yaml
replicaCount: 5

config:
  region: eu-west-1
  primaryRegion: false
  dataResidency: eu         # EU customer data only
  gdprCompliant: true
  kafkaBootstrapServers: kafka.payments.svc.cluster.local:9092

ingress:
  host: api-eu.payments.fintech.com

database:
  host: payment-postgres-eu.payments.svc.cluster.local
  # EU cluster has its own database — no cross-region data replication
  crossRegionReplication: false
```

---

## Global Load Balancing

Multi-cluster deployments require a layer above Kubernetes to route traffic between clusters.

### AWS Global Accelerator

```
AWS Global Accelerator for multi-cluster payment routing:

  Client (anywhere in the world)
       |
  AWS Global Accelerator (anycast IPs — 2 static IPs globally)
       |  Routes to nearest healthy endpoint
       |
  ┌────────────────────┬────────────────────┐
  │                    │                    │
  NLB (us-east-1)   NLB (us-west-2)    NLB (eu-west-1)
       |                    |                    |
  payment-api           payment-api         payment-api
  (primary)             (DR standby)        (EU only)

Traffic routing:
  - us-east-1: 100% weight (primary active)
  - us-west-2: 0% weight (DR standby — switched during failover)
  - eu-west-1: 100% weight (EU-only traffic via geo-routing)

Failover:
  - Global Accelerator health checks every 30 seconds
  - Automatic failover to us-west-2 if us-east-1 health checks fail
  - Manual failover: update us-west-2 weight to 100 via AWS Console/API
```

```bash
# Create Global Accelerator for payment API
aws globalaccelerator create-accelerator \
  --name payment-api-accelerator \
  --ip-address-type IPV4 \
  --enabled \
  --region us-west-2  # Global Accelerator is a global service, managed from us-west-2

# Create listener
aws globalaccelerator create-listener \
  --accelerator-arn arn:aws:globalaccelerator::123456789:accelerator/abc123 \
  --protocol TCP \
  --port-ranges "[{\"FromPort\": 443, \"ToPort\": 443}]"

# Create endpoint group for us-east-1 (primary)
aws globalaccelerator create-endpoint-group \
  --listener-arn arn:aws:globalaccelerator::123456789:accelerator/abc123/listener/xyz456 \
  --endpoint-group-region us-east-1 \
  --traffic-dial-percentage 100 \
  --health-check-protocol HTTPS \
  --health-check-path /actuator/health \
  --health-check-port 443 \
  --health-check-interval-seconds 30 \
  --threshold-count 3 \
  --endpoint-configurations "[{\"EndpointId\": \"arn:aws:elasticloadbalancing:us-east-1:123456789:loadbalancer/net/payment-nlb/abc\", \"Weight\": 100, \"ClientIPPreservationEnabled\": true}]"
```

### Cloudflare Load Balancing (Alternative)

```yaml
# Cloudflare Load Balancer for payment API
# Managed via Terraform
resource "cloudflare_load_balancer" "payment_api" {
  zone_id          = var.cloudflare_zone_id
  name             = "api.payments.fintech.com"
  default_pool_ids = [cloudflare_load_balancer_pool.us_east_1.id]
  fallback_pool_id = cloudflare_load_balancer_pool.us_west_2.id

  # Route EU traffic to EU cluster
  region_pools {
    region   = "EEA"
    pool_ids = [cloudflare_load_balancer_pool.eu_west_1.id]
  }

  # Steering: geo-based routing
  steering_policy = "geo"

  # Health checks every 30 seconds
  session_affinity = "none"
  proxied          = true  # Cloudflare proxies traffic (DDoS protection)
}

resource "cloudflare_load_balancer_pool" "us_east_1" {
  account_id = var.cloudflare_account_id
  name       = "payment-api-us-east-1"

  origins {
    name    = "us-east-1-nlb"
    address = "us-east-1-nlb.payment.example.com"
    enabled = true
    weight  = 1.0
  }

  health_check_id = cloudflare_load_balancer_monitor.payment_health.id
  minimum_origins = 1
}
```

---

## Service Discovery Across Clusters

Services in different clusters cannot use standard Kubernetes DNS to find each other. You need a cross-cluster service discovery mechanism.

### Submariner for Cross-Cluster Service Discovery

```bash
# Install Submariner broker on management cluster
subctl deploy-broker --kubeconfig ~/.kube/management.yaml

# Join us-east-1 cluster
subctl join broker-info.subm --clusterid us-east-1 \
  --kubeconfig ~/.kube/payment-prod-us-east-1.yaml \
  --natt=false  # VPN not needed within AWS

# Join eu-west-1 cluster
subctl join broker-info.subm --clusterid eu-west-1 \
  --kubeconfig ~/.kube/payment-prod-eu-west-1.yaml

# Export a service from eu-west-1 to other clusters
# After this, eu services can be accessed as:
# payment-api.payments.svc.eu-west-1.local from other clusters
kubectl apply -f - --kubeconfig ~/.kube/payment-prod-eu-west-1.yaml <<EOF
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-api
  namespace: payments
EOF
```

### Cross-Cluster DNS with ExternalDNS

```yaml
# ExternalDNS: automatically create DNS records for services
# When a service is created in any cluster, ExternalDNS creates a Route53 record
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: kube-system
spec:
  template:
    spec:
      containers:
        - name: external-dns
          image: registry.k8s.io/external-dns/external-dns:v0.14.0
          args:
            - --source=service
            - --source=ingress
            - --domain-filter=payments.fintech.internal  # only manage internal domains
            - --provider=aws
            - --aws-zone-type=private  # private hosted zone
            - --registry=txt
            - --txt-owner-id=payment-prod-us-east-1  # unique per cluster
            # Service annotation to control which services get DNS records:
            # external-dns.alpha.kubernetes.io/hostname: my-service.payments.fintech.internal
```

---

## Cross-Cluster Data Locality: GDPR Compliance

The most complex challenge in multi-cluster fintech is ensuring that data classified as EU-resident never leaves the EU cluster.

```
Data residency architecture for GDPR:

  EU Customer Request
       |
  Cloudflare (geo-routing: EEA → eu-west-1)
       |
  payment-api (eu-west-1 cluster)
       |
  payment-postgres (eu-west-1 cluster) ← EU customer data lives here
       |
  NO cross-region data replication for EU customer PII

Non-EU Customer Request:
  → us-east-1 cluster
  → payment-postgres-us (us-east-1)

EU anonymized analytics:
  Aggregate, anonymized metrics may flow to central analytics cluster.
  PII must never leave eu-west-1.
```

```java
// Application-level data residency enforcement
@Component
@RequiredArgsConstructor
public class DataResidencyRouter {

    private final EuPaymentRepository      euPaymentRepository;
    private final GlobalPaymentRepository  globalPaymentRepository;

    private static final String EU_REGION = "eu-west-1";

    @Value("${cloud.region}")
    private String currentRegion;

    /**
     * Route database operations to the correct regional repository.
     * EU customer data must only be accessed from the EU cluster.
     */
    public PaymentRepository routeForCustomer(Customer customer) {
        if (customer.getDataResidency() == DataResidency.EU) {
            if (!EU_REGION.equals(currentRegion)) {
                // This should never happen if Cloudflare geo-routing is correct
                // Alert and refuse rather than processing in wrong region
                throw new DataResidencyViolationException(
                    "EU customer data access attempted from non-EU region: " + currentRegion
                );
            }
            return euPaymentRepository;
        }
        return globalPaymentRepository;
    }
}
```

---

## Failover Automation

Automatic failover between clusters requires health checks, traffic shifting, and state synchronization.

```bash
#!/bin/bash
# payment-failover.sh
# Triggered when us-east-1 cluster becomes unhealthy
# This script is called by a monitoring system (PagerDuty webhook, Lambda, etc.)

set -euo pipefail

PRIMARY_REGION="us-east-1"
DR_REGION="us-west-2"
ACCELERATOR_ARN="arn:aws:globalaccelerator::123456789:accelerator/payment-api-accel"
ENDPOINT_GROUP_ARN_PRIMARY="arn:aws:globalaccelerator::123456789:accelerator/.../endpoint-group/primary"
ENDPOINT_GROUP_ARN_DR="arn:aws:globalaccelerator::123456789:accelerator/.../endpoint-group/dr"

echo "=== Payment Platform Failover ==="
echo "Initiating failover from $PRIMARY_REGION to $DR_REGION"
echo "Triggered at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Step 1: Verify DR cluster is healthy before shifting traffic
DR_HEALTH=$(aws elbv2 describe-target-health \
  --target-group-arn $(aws ssm get-parameter --name /fintech/dr/target-group-arn --query Parameter.Value --output text) \
  --region $DR_REGION \
  --query 'TargetHealthDescriptions[?TargetHealth.State==`healthy`] | length(@)' \
  --output text)

if [ "$DR_HEALTH" -lt 3 ]; then
  echo "ERROR: DR cluster has only $DR_HEALTH healthy pods — minimum 3 required for failover"
  exit 1
fi

echo "DR cluster health verified: $DR_HEALTH healthy pods"

# Step 2: Shift traffic — set DR to 100%, primary to 0%
aws globalaccelerator update-endpoint-group \
  --endpoint-group-arn "$ENDPOINT_GROUP_ARN_DR" \
  --traffic-dial-percentage 100 \
  --region us-west-2

aws globalaccelerator update-endpoint-group \
  --endpoint-group-arn "$ENDPOINT_GROUP_ARN_PRIMARY" \
  --traffic-dial-percentage 0 \
  --region us-west-2

echo "Traffic shifted: us-west-2 = 100%, us-east-1 = 0%"

# Step 3: Update DNS TTLs (Cloudflare or Route53)
# Global Accelerator handles this automatically via health checks

# Step 4: Notify operations team
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:123456789:payment-incidents \
  --message "PAYMENT FAILOVER COMPLETE: Traffic now routing to $DR_REGION. Primary region $PRIMARY_REGION is offline." \
  --subject "CRITICAL: Payment Platform Failover Activated"

echo "Failover complete. Monitor: https://grafana.fintech.internal/d/payment-overview"
```

---

## Flux for Multi-Cluster GitOps

Flux provides an alternative to ArgoCD with per-cluster controllers and GitOps-native multi-cluster support.

```yaml
# Flux Kustomization: apply base + region overlay to each cluster
# Applied to each cluster's Flux installation
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: payment-api
  namespace: flux-system
spec:
  interval: 5m
  path: ./k8s/payment-api/overlays/us-east-1  # region-specific overlay
  prune: true
  sourceRef:
    kind: GitRepository
    name: payment-platform
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: payment-api
      namespace: payments
  # Post-build substitution: inject cluster-specific values
  postBuild:
    substitute:
      REGION: us-east-1
      ENVIRONMENT: production
      CLUSTER_NAME: payment-prod-us-east-1
    substituteFrom:
      - kind: ConfigMap
        name: cluster-config
        optional: false
  # Timeout: fail fast so operations team is alerted
  timeout: 5m
  retryInterval: 2m
```

---

## Key Takeaways for Principal Engineers

1. **Separate concerns for separate clusters** — DR, data residency, PCI-DSS scope, and blast radius isolation are distinct problems that may each justify a cluster boundary. Do not add clusters without a clear reason; each adds operational overhead.

2. **Active-passive DR is simpler than active-active** — active-active requires cross-cluster state synchronization for idempotency stores and payment ledgers. Active-passive avoids this at the cost of needing a failover procedure. For most payment platforms, active-passive with <5-minute RTO is the right starting point.

3. **GDPR data residency is an application concern, not just infrastructure** — geo-routing gets EU traffic to the EU cluster, but application code must enforce that EU customer data never crosses the network to a non-EU database. Build data residency checks into your service layer with alerting on violations.

4. **Global Accelerator is worth the cost for payment APIs** — anycast routing means clients connect to the nearest AWS PoP (not your data center directly), reducing round-trip time. Health checks and automatic failover happen in <30 seconds. For a payment API, this is table stakes.

5. **ApplicationSet is the right ArgoCD primitive for multi-cluster** — it generates one Application per cluster using a single template. When you add a new cluster, ArgoCD automatically deploys all applications. No manual application creation required.

6. **Test your failover quarterly** — a failover procedure that has never been tested is a plan, not a capability. Run DR drills: shift 10% of traffic to the DR cluster during low-traffic periods, verify payment processing, then shift back. Document the RTO you actually achieve.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "An ArgoCD ApplicationSet uses a ClusterGenerator to deploy the payment-api application to 5 clusters. A new cluster is added to the fleet and registered in ArgoCD. Without any manual intervention, what does ArgoCD do?",
      "options": ["Nothing; ArgoCD requires a manual sync after adding a new cluster to an ApplicationSet", "ArgoCD automatically generates a new Application resource for the new cluster based on the ApplicationSet template and syncs the payment-api to it", "ArgoCD requires the ApplicationSet to be deleted and recreated to pick up the new cluster", "ArgoCD sends a notification but waits for a human to approve deployment to the new cluster"],
      "correct": 1,
      "explanation": "ApplicationSet is designed for fleet management: when a new cluster matches the ClusterGenerator's selector (e.g., a label like env=production), ArgoCD automatically creates a new Application instance using the template parameters populated with the new cluster's details. This is the core value proposition — adding a cluster to the fleet automatically inherits all application deployments without manual Application creation."
    },
    {
      "text": "A payment platform has GDPR requirements that EU customer data must never be stored in non-EU regions. The platform uses a multi-cluster setup with an EU cluster and a US cluster. Geo-routing sends EU traffic to the EU cluster. Is geo-routing alone sufficient to satisfy the GDPR data residency requirement?",
      "options": ["Yes, if AWS Global Accelerator correctly routes EU IP addresses to the EU cluster, no EU data can reach the US cluster", "No, geo-routing ensures EU requests are served by the EU cluster but does not prevent the application from making cross-cluster database calls or caching EU data in US-region services; application-layer data residency enforcement is also required", "Yes, as long as the EU cluster uses a separate VPC that cannot communicate with the US cluster", "No, GDPR requires data to be stored in the country of the customer, not just the EU region"],
      "correct": 1,
      "explanation": "Geo-routing is a network-layer control that routes incoming HTTP requests to the nearest cluster based on IP geolocation. It does not prevent the application code on the EU cluster from making API calls to US-region services, writing to a shared US database, or caching data in a US-region Redis. True data residency compliance requires application-layer enforcement: service-to-service calls must include a region header, database writes must check the data's region label, and monitoring must alert on cross-region data flow violations."
    },
    {
      "text": "A multi-cluster Kubernetes platform uses Submariner for cross-cluster service discovery. Service A in cluster-eu needs to call Service B in cluster-us. What DNS name does Service A use to reach Service B via Submariner?",
      "options": ["The ClusterIP of Service B in cluster-us, obtained from a shared service registry", "service-b.namespace.svc.cluster-us.local using Submariner's cross-cluster DNS suffix format", "The external LoadBalancer IP of Service B in cluster-us", "An Istio ServiceEntry must be created manually; Submariner does not support DNS-based cross-cluster discovery"],
      "correct": 1,
      "explanation": "Submariner extends Kubernetes DNS to support cross-cluster service discovery using the format service-name.namespace.svc.cluster-name.local. When Service A resolves this DNS name, the Submariner lighthouse DNS plugin intercepts the request and returns the ClusterIP of the exported ServiceImport in cluster-eu, which Submariner's route agent tunnels to the actual pod in cluster-us. This abstracts the cross-cluster networking complexity behind standard Kubernetes DNS semantics."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Implement a Multi-Cluster Payment Platform with GDPR Data Residency",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Write an ArgoCD ApplicationSet manifest that deploys the payment-api application to all clusters labelled environment=production. The template must set: resource limits (CPU 500m/1000m, memory 512Mi/1024Mi), the cluster-specific AWS region as an environment variable (from the cluster secret's region label), and an HPA with min=2 max=20 targeting 70% CPU. Add a syncPolicy with automated prune and selfHeal. Verify the ApplicationSet generates one Application per production cluster."
    },
    {
      "id": "2",
      "description": "Implement a DataResidencyEnforcer Spring interceptor that inspects every outbound HTTP call made by the payment service. For each call, it reads the X-Customer-Region header from the current request context and verifies that the target service's region (from a ServiceRegistry) matches the customer's region. If a cross-region call is detected, it logs a CRITICAL alert with: source service, target service, customer region, target region, and request ID. Write a unit test verifying that an EU customer's request calling a US service triggers the alert."
    },
    {
      "id": "3",
      "description": "Design a Cluster API (CAPI) ClusterClass that provisions new payment processing clusters with: 3 control plane nodes (m5.xlarge), autoscaling worker node groups (min 3, max 50 m5.2xlarge), pre-configured with the fintech security baseline (CIS Kubernetes Benchmark Level 2 labels), and automatic registration with ArgoCD using a post-provision ClusterResourceSet that installs the ArgoCD agent. Document the steps to provision a new DR cluster in a new AWS region using this ClusterClass."
    },
    {
      "id": "4",
      "description": "Implement a quarterly DR drill automation script (or Tekton Pipeline) that: (a) shifts 10% of payment traffic from the primary cluster to the DR cluster using AWS Global Accelerator endpoint weights, (b) runs a 5-minute synthetic payment transaction test against the DR cluster endpoint, (c) verifies payment success rate > 99.5% and p99 latency < 200ms, (d) shifts traffic back to the primary cluster, (e) generates a DrillReport with actual RTO measured from traffic shift initiation to first successful payment. The drill must be non-destructive and auto-revert on any test failure."
    }
  ]
}
-->
