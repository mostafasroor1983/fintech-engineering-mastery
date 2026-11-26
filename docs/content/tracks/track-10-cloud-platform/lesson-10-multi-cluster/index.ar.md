---
id: track-10-lesson-10
title: "Kubernetes متعدد العناقيد — الاتحاد وتوزيع أحمال العمل"
slug: multi-cluster
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 10
difficulty: principal
estimatedMinutes: 85
status: published
tags: [multi-cluster, federation, fleet, workload-distribution, DR]
prerequisites: []
---

# ‏Kubernetes متعدد العناقيد — الاتحاد وتوزيع أحمال العمل

> [!NOTE]
> العنقود الواحد في Kubernetes نقطة فشل واحدة. ولمنصة دفع تعالج ملايين المعاملات يوميًا، فإن تعطل عنقود كامل — بسبب خلل في مستوى تحكم Kubernetes، أو مشغّل (operator) منفلت، أو انقطاع منطقة سحابية — غير مقبول. والبنية متعددة العناقيد ليست ترفًا؛ بل الحد الأدنى من البنية التحتية لمنصة مالية بمتطلبات توفر 99.99%.

## لماذا عناقيد متعددة؟

قبل تصميم بنية متعددة العناقيد، افهم المشكلة المحددة التي يحلها كل حد بين العناقيد:

| الدافع | البنية | السياق المالي |
|---|---|---|
| التعافي من الكوارث | عناقيد إقليمية نشط-خامل | النجاة من انقطاع AWS us-east-1 |
| توفر عالٍ نشط-نشط | نشط-نشط مع موازنة حمل عالمية | تحول عند الفشل دون توقف لواجهة الدفع |
| إقامة البيانات | عناقيد لكل منطقة بلا تدفق بيانات بين المناطق | ‏GDPR: بيانات عملاء الاتحاد الأوروبي تبقى في eu-west-1 |
| نطاق الضرر | عناقيد منفصلة للإنتاج/التجهيز/التطوير | نشر في التجهيز لا يؤثر على الإنتاج |
| عزل التوسع | عنقود منفصل لكل وحدة أعمال | فريق المدفوعات معزول عن منصة التداول |
| حد الامتثال | عنقود PCI-DSS منفصل عن غير PCI | عزل بيئة بيانات حاملي البطاقات (CDE) |

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

## ‏Cluster API: إدارة دورة حياة العناقيد

يتيح Cluster API ‏(CAPI) إدارة دورة حياة عناقيد Kubernetes تصريحيًا — الإنشاء، والترقيات، والحذف — باستخدام YAML بأسلوب Kubernetes.

### تثبيت Cluster API

```bash
# Install clusterctl CLI
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.6.0/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Initialize management cluster with the AWS provider (CAPA).
# Use short-lived credentials (SSO / assumed role), never long-lived keys;
# clusterawsadm encodes them for the provider
export AWS_REGION=us-east-1
clusterawsadm bootstrap iam create-cloudformation-stack   # IAM roles, once per account
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)
export EKS=true                                           # enable EKS support

clusterctl init --infrastructure aws
```

### تعريف العنقود (CAPI)

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
  version: v1.33   # keep within EKS standard support -- older versions
                   # move to (paid) extended support
  # EKS managed control plane
  eksClusterName: payment-prod-us-east-1
  # Enable private endpoint (security requirement for fintech)
  endpointAccess:
    private: true
    public: false  # no public access to Kubernetes API server
    publicCIDRs: []
  # Enable envelope encryption for secrets with KMS
  encryptionConfig:
    resources: ["secrets"]
    provider: "arn:aws:kms:us-east-1:123456789:key/eks-key"
  # Add-on versions must match the Kubernetes version (illustrative values)
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
  # EKS-optimized Amazon Linux 2023 (Amazon Linux 2 AMIs are not
  # provided for EKS 1.33+)
  amiType: AL2023_x86_64_STANDARD
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

## نشر ArgoCD متعدد العناقيد

يدير ArgoCD نشرات GitOps عبر عناقيد متعددة من مستوى تحكم واحد.

### تسجيل العناقيد في ArgoCD

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

### ‏ApplicationSet: النشر إلى كل العناقيد

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
    # (the labels are set on the cluster's Secret in the argocd namespace)
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

### ملفات قيم خاصة بكل منطقة

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

## موازنة الحمل العالمية

تتطلب النشرات متعددة العناقيد طبقة فوق Kubernetes لتوجيه الحركة بين العناقيد.

### ‏AWS Global Accelerator

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
  - Global Accelerator sends each client to the NEAREST healthy endpoint
    group (by network proximity), weighted by the traffic dial
  - us-east-1: dial 100% (primary active)
  - us-west-2: dial 0% (DR standby). A dial of 0 means NO traffic, even if
    us-east-1 fails -- failover is the explicit dial change in the script
    below. For automatic failover, keep the DR dial above 0 and accept
    that some nearby clients are served from us-west-2.
  - eu-west-1: served under its OWN hostname / accelerator (api-eu...).
    Proximity routing is not geo-fencing: if the EU group failed, a shared
    accelerator would send EU clients to the US -- a data-residency breach

Failover:
  - For NLB/ALB endpoints, GA uses the load balancer's target health;
    detection takes roughly interval x threshold (e.g. 10s x 3 = 30s)
  - Manual / scripted failover: set the us-west-2 dial to 100%
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

### موازنة حمل Cloudflare (بديل)

```hcl
# Cloudflare Load Balancer for payment API
# Managed via Terraform (Cloudflare provider v4 syntax; v5 changed the schema)
resource "cloudflare_load_balancer" "payment_api" {
  zone_id          = var.cloudflare_zone_id
  name             = "api.payments.fintech.com"
  default_pool_ids = [cloudflare_load_balancer_pool.us_east_1.id]
  fallback_pool_id = cloudflare_load_balancer_pool.us_west_2.id

  # Route European traffic to the EU cluster. Cloudflare regions are
  # geographic codes (WEU = Western Europe, EEU = Eastern Europe) -- not the
  # legal EEA; enforce residency by customer, not only by client location
  region_pools {
    region   = "WEU"
    pool_ids = [cloudflare_load_balancer_pool.eu_west_1.id]
  }
  region_pools {
    region   = "EEU"
    pool_ids = [cloudflare_load_balancer_pool.eu_west_1.id]
  }

  # Steering: geo-based routing
  steering_policy = "geo"

  # Health checks are defined in the monitor referenced by each pool
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

## اكتشاف الخدمات عبر العناقيد

لا تستطيع الخدمات في عناقيد مختلفة استخدام DNS القياسي في Kubernetes لإيجاد بعضها. فتحتاج آلية اكتشاف خدمات عبر العناقيد. وتوحّد **واجهة الخدمات متعددة العناقيد (MCS API)** في Kubernetes ذلك: تُصدَّر الخدمة بـ `ServiceExport` فتصبح متاحة من العناقيد الأخرى باسم `<service>.<namespace>.svc.clusterset.local`. وتنفذ Submariner (أدناه)، وCilium Cluster Mesh، وIstio متعدد العناقيد، والعروض السحابية هذا الاكتشاف عبر العناقيد. ويجب ألا تتداخل نطاقات Pod وService CIDR بين العناقيد المتصلة (وإلا لزمت طبقة ترجمة مثل Submariner Globalnet).

### ‏Submariner لاكتشاف الخدمات عبر العناقيد

```bash
# Install Submariner broker on management cluster
subctl deploy-broker --kubeconfig ~/.kube/management.yaml

# Join us-east-1 cluster
subctl join broker-info.subm --clusterid us-east-1 \
  --kubeconfig ~/.kube/payment-prod-us-east-1.yaml \
  --natt=false  # no NAT traversal needed between VPCs with private routing
                # (traffic still runs through encrypted IPsec/WireGuard tunnels)

# Join eu-west-1 cluster
subctl join broker-info.subm --clusterid eu-west-1 \
  --kubeconfig ~/.kube/payment-prod-eu-west-1.yaml

# Export a service from eu-west-1 to other clusters.
# After this, other clusters reach it as
#   payment-api.payments.svc.clusterset.local            (any exporting cluster)
#   eu-west-1.payment-api.payments.svc.clusterset.local  (this cluster only)
# Think twice before exporting EU services to non-EU clusters at all
kubectl apply -f - --kubeconfig ~/.kube/payment-prod-eu-west-1.yaml <<EOF
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-api
  namespace: payments
EOF
```

### ‏DNS عبر العناقيد بـ ExternalDNS

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

## موضعية البيانات عبر العناقيد: امتثال GDPR

التحدي الأعقد في التقنية المالية متعددة العناقيد ضمان ألا تغادر البيانات المصنفة كمقيمة في الاتحاد الأوروبي العنقود الأوروبي أبدًا.

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

## أتمتة التحول عند الفشل

يتطلب التحول التلقائي عند الفشل بين العناقيد فحوص صحة، وتحويل الحركة، ومزامنة الحالة.

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

# Step 3: Data tier -- traffic alone is not a failover. Promote the DR
# database (e.g. Aurora Global Database failover / replica promotion) and
# FENCE the old primary so it cannot accept writes (avoid split brain).
# Usually this step runs BEFORE the traffic shift; it is the slow, risky part.

# Step 4: Notify operations team -- via the DR region: when us-east-1 is
# down, an SNS topic in us-east-1 may be unreachable too
aws sns publish \
  --region "$DR_REGION" \
  --topic-arn arn:aws:sns:us-west-2:123456789:payment-incidents \
  --message "PAYMENT FAILOVER COMPLETE: Traffic now routing to $DR_REGION. Primary region $PRIMARY_REGION is offline." \
  --subject "CRITICAL: Payment Platform Failover Activated"

echo "Failover complete. Monitor: https://grafana.fintech.internal/d/payment-overview"
```

---

## ‏Flux لـ GitOps متعدد العناقيد

يقدم Flux بديلًا لـ ArgoCD بمتحكمات لكل عنقود ودعم أصلي لـ GitOps متعدد العناقيد.

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

## الخلاصات الأساسية للمهندسين الرئيسيين

1. **افصل الاهتمامات بعناقيد منفصلة** — التعافي من الكوارث، وإقامة البيانات، ونطاق PCI-DSS، وعزل نطاق الضرر مشكلات متمايزة قد يبرر كل منها حدًا بين العناقيد. ولا تُضف عناقيد دون سبب واضح؛ فكل منها يضيف عبئًا تشغيليًا.

2. **التعافي نشط-خامل أبسط من نشط-نشط** — يتطلب النشط-النشط مزامنة الحالة بين العناقيد لمخازن تساوي القوة ودفاتر الدفع. ويتجنب النشط-الخامل ذلك على حساب الحاجة إلى إجراء تحول عند الفشل. ولأغلب منصات الدفع، النشط-الخامل بزمن استعادة (RTO) أقل من 5 دقائق نقطة البداية الصحيحة.

3. **إقامة بيانات GDPR مسألة تطبيق، لا بنية تحتية فقط** — يوصل التوجيه الجغرافي حركة الاتحاد الأوروبي إلى العنقود الأوروبي، لكن يجب أن تفرض شيفرة التطبيق ألا تعبر بيانات عملاء الاتحاد الأوروبي الشبكة أبدًا إلى قاعدة بيانات خارجه. فابنِ فحوص إقامة البيانات في طبقة الخدمة مع تنبيه عند المخالفات.

4. **‏Global Accelerator يستحق تكلفته لواجهات الدفع** — يعني التوجيه anycast أن العملاء يتصلون بأقرب موقع حافة لدى AWS ثم ينتقلون عبر شبكة AWS الأساسية، فيقل زمن الذهاب والإياب؛ ولا يعتمد التحول عند الفشل على تحديث العملاء لذاكرة DNS المؤقتة. ويستغرق اكتشاف الفشل تقريبًا فترة فحص الصحة × العتبة (عشرات الثواني). وتذكّر أن التوجيه حسب القرب ليس فرضًا لإقامة البيانات.

5. **‏ApplicationSet هو أداة ArgoCD الصحيحة للعناقيد المتعددة** — يولّد تطبيقًا واحدًا لكل عنقود من قالب واحد. وحين تضيف عنقودًا جديدًا، ينشر ArgoCD كل التطبيقات تلقائيًا. فلا حاجة لإنشاء تطبيقات يدويًا.

6. **اختبر التحول عند الفشل ربع سنويًا** — إجراء تحول لم يُختبر أبدًا خطة، لا قدرة. فشغّل تمارين التعافي: حوّل 10% من الحركة إلى عنقود التعافي في فترات الحركة المنخفضة، وتحقق من معالجة المدفوعات، ثم أعدها. ووثّق زمن الاستعادة (RTO) الذي تحققه فعلًا.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يستخدم ApplicationSet في ArgoCD مولّد عناقيد (ClusterGenerator) لنشر تطبيق payment-api إلى 5 عناقيد. ويُضاف عنقود جديد إلى الأسطول ويُسجّل في ArgoCD. دون أي تدخل يدوي، ماذا يفعل ArgoCD؟",
      "options": ["لا شيء؛ يتطلب ArgoCD مزامنة يدوية بعد إضافة عنقود جديد إلى ApplicationSet", "يولّد ArgoCD تلقائيًا مورد Application جديدًا للعنقود الجديد بناءً على قالب ApplicationSet ويزامن payment-api إليه", "يتطلب ArgoCD حذف ApplicationSet وإعادة إنشائه لالتقاط العنقود الجديد", "يرسل ArgoCD إشعارًا لكنه ينتظر موافقة بشرية على النشر إلى العنقود الجديد"],
      "correct": 1,
      "explanation": "صُمم ApplicationSet لإدارة الأساطيل: فحين يطابق عنقود جديد محدد مولّد العناقيد (مثل تسمية env=production)، ينشئ ArgoCD تلقائيًا نسخة Application جديدة باستخدام معاملات القالب مملوءة بتفاصيل العنقود الجديد. وهذه القيمة الجوهرية — فإضافة عنقود إلى الأسطول ترث تلقائيًا كل نشرات التطبيقات دون إنشاء Application يدويًا."
    },
    {
      "text": "لمنصة دفع متطلبات GDPR بأن بيانات عملاء الاتحاد الأوروبي يجب ألا تُخزن أبدًا في مناطق خارجه. وتستخدم المنصة إعدادًا متعدد العناقيد بعنقود أوروبي وعنقود أمريكي. ويرسل التوجيه الجغرافي حركة الاتحاد الأوروبي إلى العنقود الأوروبي. هل يكفي التوجيه الجغرافي وحده لتحقيق متطلب إقامة البيانات في GDPR؟",
      "options": ["نعم، إذا وجّه AWS Global Accelerator عناوين IP الأوروبية بشكل صحيح إلى العنقود الأوروبي، فلا يمكن لأي بيانات أوروبية الوصول إلى العنقود الأمريكي", "لا، يضمن التوجيه الجغرافي أن الطلبات الأوروبية يخدمها العنقود الأوروبي لكنه لا يمنع التطبيق من إجراء استدعاءات قاعدة بيانات عبر العناقيد أو تخزين بيانات أوروبية مؤقتًا في خدمات بالمنطقة الأمريكية؛ فيلزم أيضًا فرض إقامة البيانات على مستوى التطبيق", "نعم، طالما يستخدم العنقود الأوروبي VPC منفصلًا لا يستطيع التواصل مع العنقود الأمريكي", "لا، يتطلب GDPR تخزين البيانات في بلد العميل، لا في منطقة الاتحاد الأوروبي فقط"],
      "correct": 1,
      "explanation": "التوجيه الجغرافي ضابط على مستوى الشبكة يوجّه طلبات HTTP الواردة إلى أقرب عنقود بناءً على الموقع الجغرافي لعنوان IP. ولا يمنع شيفرة التطبيق على العنقود الأوروبي من إجراء استدعاءات واجهات لخدمات في المنطقة الأمريكية، أو الكتابة في قاعدة بيانات أمريكية مشتركة، أو تخزين البيانات مؤقتًا في Redis بالمنطقة الأمريكية. ويتطلب الامتثال الحقيقي لإقامة البيانات فرضًا على مستوى التطبيق: يجب أن تتضمن الاستدعاءات بين الخدمات ترويسة المنطقة، ويجب أن تفحص كتابات قاعدة البيانات تسمية منطقة البيانات، ويجب أن تنبّه المراقبة على مخالفات تدفق البيانات بين المناطق."
    },
    {
      "text": "تستخدم منصة Kubernetes متعددة العناقيد Submariner لاكتشاف الخدمات عبر العناقيد. وتحتاج الخدمة A في cluster-eu استدعاء الخدمة B في cluster-us. ما اسم DNS الذي تستخدمه الخدمة A للوصول إلى الخدمة B عبر Submariner؟",
      "options": ["عنوان ClusterIP للخدمة B في cluster-us، المأخوذ من سجل خدمات مشترك", "‏service-b.namespace.svc.clusterset.local — اسم DNS في واجهة الخدمات متعددة العناقيد، المتاح بعد تصدير الخدمة B بـ ServiceExport (ويستهدف cluster-us.service-b.namespace.svc.clusterset.local ذلك العنقود تحديدًا)", "عنوان IP الخارجي لموازن الحمل الخاص بالخدمة B في cluster-us", "يجب إنشاء ServiceEntry في Istio يدويًا؛ فـ Submariner لا يدعم الاكتشاف عبر العناقيد القائم على DNS"],
      "correct": 1,
      "explanation": "ينفذ Submariner واجهة الخدمات متعددة العناقيد في Kubernetes. فبمجرد تصدير الخدمة B في cluster-us بـ ServiceExport، ينشئ مكوّن Lighthouse في Submariner مورد ServiceImport في العناقيد المتصلة ويجيب على استعلامات DNS لـ service-b.namespace.svc.clusterset.local (أو cluster-us.service-b.namespace.svc.clusterset.local لذلك العنقود وحده) بعنوان IP الخاص بالخدمة B في cluster-us. ثم تنقل بوابات Submariner الحركة عبر أنفاق مشفرة بين العناقيد — وهذا يتطلب نطاقات Pod/Service CIDR غير متداخلة، أو Globalnet. وتبقى دلالات DNS القياسية في Kubernetes؛ والجديد فقط النطاق clusterset.local."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تصميم وتنفيذ منصة دفع متعددة العناقيد مع إقامة بيانات GDPR",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "اكتب ملف ApplicationSet في ArgoCD ينشر تطبيق payment-api إلى كل العناقيد المسماة environment=production. ويجب أن يضبط القالب: حدود الموارد (معالج 500m/1000m، وذاكرة 512Mi/1024Mi)، ومنطقة AWS الخاصة بالعنقود كمتغير بيئة (من تسمية region في سر العنقود)، وHPA بحد أدنى 2 وأقصى 20 يستهدف 70% معالج. وأضف syncPolicy بـ prune وselfHeal تلقائيين. وتحقق من أن ApplicationSet يولّد تطبيقًا واحدًا لكل عنقود إنتاج."
    },
    {
      "id": "2",
      "description": "نفّذ معترضًا DataResidencyEnforcer في Spring يفحص كل استدعاء HTTP صادر تجريه خدمة الدفع. ولكل استدعاء، يقرأ ترويسة X-Customer-Region من سياق الطلب الحالي ويتحقق من أن منطقة الخدمة المستهدفة (من ServiceRegistry) تطابق منطقة العميل. وإذا اكتُشف استدعاء عبر المناطق، يسجّل تنبيهًا CRITICAL يتضمن: الخدمة المصدر، والخدمة الهدف، ومنطقة العميل، والمنطقة الهدف، ومعرّف الطلب. واكتب اختبار وحدة يتحقق من أن طلب عميل أوروبي يستدعي خدمة أمريكية يطلق التنبيه."
    },
    {
      "id": "3",
      "description": "صمّم ClusterClass في Cluster API ‏(CAPI) يوفّر عناقيد معالجة دفع جديدة بـ: 3 عقد مستوى تحكم (m5.xlarge)، ومجموعات عقد عاملة ذاتية التوسع (أدنى 3، وأقصى 50 من m5.2xlarge)، مضبوطة مسبقًا بخط الأساس الأمني للتقنية المالية (تسميات معيار CIS لـ Kubernetes المستوى 2)، وتسجيل تلقائي في ArgoCD عبر ClusterResourceSet بعد التوفير يثبّت وكيل ArgoCD. ووثّق خطوات توفير عنقود تعافٍ جديد في منطقة AWS جديدة باستخدام هذا ClusterClass."
    },
    {
      "id": "4",
      "description": "نفّذ سكربت أتمتة لتمرين تعافٍ ربع سنوي (أو Tekton Pipeline) يقوم بـ: (أ) تحويل 10% من حركة الدفع من العنقود الأساسي إلى عنقود التعافي باستخدام أوزان نقاط نهاية AWS Global Accelerator، (ب) تشغيل اختبار معاملات دفع اصطناعية لمدة 5 دقائق على نقطة نهاية عنقود التعافي، (ج) التحقق من أن معدل نجاح المدفوعات > 99.5% وزمن p99 < 200ms، (د) إعادة الحركة إلى العنقود الأساسي، (هـ) توليد DrillReport بزمن الاستعادة الفعلي المقاس من بدء تحويل الحركة حتى أول دفعة ناجحة. ويجب أن يكون التمرين غير مدمّر وأن يتراجع تلقائيًا عند أي فشل في الاختبار."
    }
  ]
}
-->
