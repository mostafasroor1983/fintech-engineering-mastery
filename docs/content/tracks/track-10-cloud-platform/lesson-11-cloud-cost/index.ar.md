---
id: track-10-lesson-11
title: "هندسة التكلفة السحابية — FinOps للمنصات المالية"
slug: cloud-cost
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 11
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [FinOps, cloud-cost, spot-instances, reserved-instances, right-sizing]
prerequisites: []
---

# هندسة التكلفة السحابية — FinOps للمنصات المالية

> [!NOTE]
> منصة تقنية مالية تعالج مدفوعات بـ 100 مليون دولار يوميًا وتعمل على بنية AWS بـ 500 ألف دولار شهريًا ليست مبررة بالضرورة — فمنصة جيدة التصميم يجب أن تشغّل الحمل نفسه بـ 150 ألف دولار شهريًا. وهندسة التكلفة السحابية ليست تقتيرًا؛ بل إزالة للهدر مع الحفاظ على الموثوقية والأداء اللذين تتطلبهما العمليات المالية.

## إطار FinOps

تعرّف مؤسسة FinOps (الإدارة المالية للسحابة) ثلاث مراحل في دورة الحياة:

```
Inform → Optimize → Operate

INFORM:
  - Allocate costs to teams, services, and products (tagging, Kubecost)
  - Establish unit economics (cost per 1,000 payments processed)
  - Identify anomalies (unexpected cost spikes)
  - Report to engineering and finance leadership

OPTIMIZE:
  - Right-size instances and containers (VPA + Kubecost recommendations)
  - Migrate eligible workloads to Spot/Savings Plans
  - Eliminate waste (idle resources, orphaned volumes, unused reservations)
  - Architecture optimization (reduce data transfer costs, choose cheaper services)

OPERATE:
  - Governance: budget alerts, spending policies
  - Automation: auto-terminate idle environments, enforce resource quotas
  - Continuous improvement: monthly cost review, quarterly architecture review
  - Track unit economics over time (cost per payment should decrease as scale grows)
```

---

## استراتيجية الوسوم للتكلفة

دون وسوم متسقة، يصبح توزيع التكلفة تخمينًا. فعرّف الوسوم قبل إنشاء الموارد.

### سياسة الوسوم الإلزامية

```rego
# OPA (Open Policy Agent) policy: enforce mandatory tags on all resources.
# Run it against Terraform plans in CI (e.g. with conftest); similar rules
# exist as AWS Config rules, AWS Organizations tag policies, or Sentinel
# (Terraform Cloud's own policy language). Rego v1 syntax (OPA 1.0+).
package aws_resource_tags

required_tags := {
    "Team",
    "Environment",
    "Product",
    "CostCenter",
    "DataClassification"
}

deny contains msg if {
    resource := input.resource
    missing := required_tags - {tag | resource.tags[tag]}
    count(missing) > 0
    msg := sprintf("Resource %v is missing required tags: %v", [resource.type, missing])
}
```

```hcl
# Terraform: enforce tags on all AWS resources via default_tags
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  # Applied to ALL resources created by this provider
  default_tags {
    tags = {
      Team              = "payments-platform"    # team responsible
      Environment       = "production"           # production|staging|dev
      Product           = "payment-processing"   # product line
      CostCenter        = "CC-TECH-PAYMENTS"     # finance cost center
      DataClassification = "pii-financial"       # data sensitivity
      ManagedBy         = "terraform"            # IaC tool
      Repository        = "fintech/payment-platform"
    }
  }
}
```

### تسميات Kubernetes لتوزيع التكلفة

```yaml
# Namespace labels for Kubecost cost allocation
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    # Kubecost reads these labels for cost allocation
    team: payments-platform
    product: payment-processing
    cost-center: CC-TECH-PAYMENTS
    environment: production

---
# Deployment labels — costs are attributed per workload
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
  labels:
    app: payment-api
    team: payments-platform
    product: payment-processing
    # Kubecost uses these for allocation reports
    app.kubernetes.io/name: payment-api
    app.kubernetes.io/component: api-server
    app.kubernetes.io/part-of: payment-processing
```

---

## ‏Kubecost: رؤية التكلفة لكل خدمة

يوفر Kubecost (المملوك لـ IBM منذ 2024) رؤية للتكلفة لكل مساحة أسماء، ولكل Deployment، ولكل تسمية داخل عناقيد Kubernetes. ويقدم **OpenCost**، مشروع CNCF الذي بُني عليه Kubecost، نموذج التوزيع الأساسي كمصدر مفتوح.

### تثبيت Kubecost

```bash
# Install Kubecost on each cluster (global.prometheus.enabled=false: reuse
# the existing Prometheus. Never put a comment after a trailing backslash --
# it ends the command)
helm repo add kubecost https://kubecost.github.io/cost-analyzer
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set kubecostToken="your-token-here" \
  --set global.prometheus.fqdn=http://prometheus.monitoring.svc.cluster.local:9090 \
  --set global.prometheus.enabled=false \
  --set costAnalyzer.defaultClusterID=payment-prod-us-east-1 \
  --set global.podAnnotations."cluster-autoscaler\.kubernetes\.io/safe-to-evict"=true
```

### قراءة تقارير Kubecost

```bash
# Get cost summary via Kubecost API
# Cost per namespace for the last 30 days
curl "http://kubecost-cost-analyzer.kubecost.svc.cluster.local:9090/model/allocation?window=30d&aggregate=namespace&accumulate=false" \
  | jq '.data[0] | to_entries | map({namespace: .key, monthlyCost: .value.totalCost}) | sort_by(-.monthlyCost)'

# Example output:
# [
#   {"namespace": "payments",    "monthlyCost": 45230.50},
#   {"namespace": "fraud",       "monthlyCost": 23100.00},
#   {"namespace": "compliance",  "monthlyCost": 12800.00},
#   {"namespace": "monitoring",  "monthlyCost": 8900.00}
# ]

# Cost per deployment within payments namespace
curl "http://kubecost-cost-analyzer.kubecost.svc.cluster.local:9090/model/allocation?window=30d&aggregate=deployment&namespace=payments"

# Right-sizing recommendations
curl "http://kubecost-cost-analyzer.kubecost.svc.cluster.local:9090/model/savings/requestSizingV2?targetCPUUtilization=0.7&targetRAMUtilization=0.7"
```

### لوحة اقتصاديات الوحدة

```
Payment processing unit economics:
  Monthly cloud cost:        $45,230
  Monthly payments processed: 150,000,000

  Cost per payment: $45,230 / 150,000,000 = $0.000302 (0.03 cents per payment)

  Target: cost per payment should DECREASE as volume increases (economies of scale)
  Alert: if cost per payment increases month-over-month, investigate efficiency regression

  Breakdown:
    Compute (payment-api pods):     $18,000  (40%)
    Database (PostgreSQL RDS/EBS):  $15,000  (33%)
    Kafka (EBS + compute):           $7,000  (16%)
    Networking (data transfer):      $3,500   (8%)
    Other (monitoring, tools):       $1,730   (4%)
```

---

## التحجيم المناسب بـ VPA وKubecost

أكبر رافعة للتكلفة هي التحجيم المناسب للحاويات. فالحاويات المفرطة في التوفير تهدر المعالج والذاكرة، فتفرض عقدًا أكبر (أغلى).

```bash
# Step 1: Get VPA recommendations
kubectl get vpa -n payments -o json | jq '
  .items[] | {
    name: .metadata.name,
    recommendations: .status.recommendation.containerRecommendations[] | {
      container: .containerName,
      currentRequest: .lowerBound,
      recommended: .target,
      potentialSavings: "calculate based on difference"
    }
  }
'

# Step 2: Get Kubecost right-sizing recommendations
# (-G + --data-urlencode builds the query string; a URL split over several
#  lines inside quotes would contain newlines and break)
curl -sG "http://kubecost-cost-analyzer.kubecost.svc.cluster.local:9090/model/savings/requestSizingV2" \
  --data-urlencode "filter=namespace:\"payments\"" \
  --data-urlencode "targetCPUUtilization=0.7" \
  --data-urlencode "targetRAMUtilization=0.8" \
  --data-urlencode "window=7d" | jq .
# The response lists, per container, the current and recommended requests
# and the estimated monthly savings
```

### تطبيق توصيات التحجيم المناسب

```yaml
# Before right-sizing (over-provisioned):
resources:
  requests:
    cpu: "2000m"    # actual usage: 400m at peak
    memory: "4Gi"   # actual usage: 800Mi at peak

# After right-sizing (20% headroom above VPA target):
resources:
  requests:
    cpu: "480m"     # 400m * 1.2
    memory: "960Mi" # 800Mi * 1.2
  limits:
    cpu: "1920m"    # 4x request (burst headroom)
    memory: "2Gi"   # 2x request

# Monthly savings calculation (requested CPU priced per vCPU-hour):
# Before: 10 replicas * 2 CPU * $0.0464/vCPU-hr * 730hr = $677/month
# After:  10 replicas * 0.48 CPU * $0.0464/vCPU-hr * 730hr = $162/month
# Saving: up to $515/month per deployment -- real money only once the
# autoscaler packs pods onto FEWER nodes (requests free capacity, the
# node bill drops when nodes are removed).
# For latency-critical payment pods consider memory request == limit
# (see the scheduling lesson); the 2x memory limit here suits batch-like
# services better.
```

---

## نسخ Spot لأحمال العمل غير الحرجة

نسخ Spot أرخص بنسبة 70-90% من On-Demand لكن يمكن مقاطعتها بإشعار قبل دقيقتين. والمفتاح تحديد أحمال الدفع التي تحتمل المقاطعة.

### أحمال مؤهلة لـ Spot مقابل On-Demand

```
On-Demand REQUIRED (interruption unacceptable):
  - payment-api (customer-facing, synchronous)
  - payment-postgres primary (stateful, cannot lose writes)
  - fraud-detection-api (synchronous authorization path)
  - Kafka brokers (stateful, interruption causes rebalancing)
  - Any service in the synchronous payment critical path

Spot ELIGIBLE (interruption acceptable):
  - Batch payment processing (can retry failed jobs)
  - Fraud ML model training (batch, can checkpoint)
  - Compliance report generation (batch, retryable)
  - Development environments (intentional)
  - Staging environments (acceptable downtime)
  - Log processing and archival
  - Data warehouse ETL jobs
  - Load testing runners
```

### مجموعة عقد Spot مع Karpenter

```yaml
# Karpenter NodePool for Spot batch workloads (Karpenter v1 API)
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: batch-spot-workers
spec:
  template:
    metadata:
      labels:
        workload-type: batch
        spot: "true"
    spec:
      requirements:
        # Multiple instance families = more Spot availability
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: [m6i, m6a, m7i, m5, r6i]
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: [xlarge, 2xlarge, 4xlarge]
        - key: karpenter.sh/capacity-type
          operator: In
          values: [spot]   # Spot only for batch
        - key: topology.kubernetes.io/zone
          operator: In
          values: [us-east-1a, us-east-1b, us-east-1c]
      # Karpenter does not taint Spot nodes by itself -- add a taint so
      # only pods that tolerate interruption land here
      taints:
        - key: karpenter.sh/capacity-type
          value: spot
          effect: NoSchedule
      # Spot interruption handling: Karpenter watches the interruption
      # notices (via an SQS queue) and drains the node before termination
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: batch-node-class

  # Only scale down batch nodes aggressively — they're cheap anyway
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m

---
# Batch job that runs on Spot, with retries for interruption
apiVersion: batch/v1
kind: Job
metadata:
  name: fraud-model-training
  namespace: ml
spec:
  # Retry on failure (Spot interruption causes pod failure)
  backoffLimit: 5
  template:
    spec:
      # Tolerate the Spot node taint
      tolerations:
        - key: "karpenter.sh/capacity-type"
          operator: "Equal"
          value: "spot"
          effect: "NoSchedule"

      nodeSelector:
        workload-type: batch
        spot: "true"

      # Handle Spot interruption: save a checkpoint within the 2-minute
      # notice. The drain starts a little after the notice arrives, so keep
      # the grace period below 120s
      terminationGracePeriodSeconds: 90

      containers:
        - name: fraud-trainer
          image: fintech/fraud-ml-trainer:v3.1.0
          command:
            - python
            - train.py
            - --checkpoint-dir=/mnt/checkpoints
            - --resume-from-checkpoint  # resume if interrupted
          volumeMounts:
            - name: checkpoints
              mountPath: /mnt/checkpoints
      restartPolicy: OnFailure
      volumes:
        - name: checkpoints
          persistentVolumeClaim:
            claimName: fraud-model-checkpoints  # EFS: survives node termination
```

---

## النسخ المحجوزة وSavings Plans

للحمل الأساسي المتوقع (الحد الأدنى من الـ pods العاملة دائمًا)، تقدم النسخ المحجوزة أو Savings Plans خصومات كبيرة مقارنة بـ On-Demand.

```
AWS Savings Plans for fintech:

  Compute Savings Plans (indicative discounts -- they vary by instance):
    - 1 year, no upfront:  ~20-30% discount
    - 1 year, all upfront: ~30-35% discount
    - 3 year, all upfront: ~45-55% discount (up to 66%)
    - Applies to any EC2 instance family, region, or OS (and Fargate, Lambda)
    - Best for Kubernetes: Compute Savings Plans (most flexible)

  EC2 Instance Savings Plans:
    - Locked to instance family and region
    - Up to 72% discount
    - Use only if instance family is locked for 1-3 years

  Strategy:
    Step 1: Run On-Demand for 30 days, observe base load
    Step 2: Purchase Savings Plans for 70-80% of base load
    Step 3: Use On-Demand for the remaining 20-30% buffer
    Step 4: Use Spot for all batch/non-critical workloads above base

  Example for payment platform:
    Base load:  20 c6i.4xlarge On-Demand nodes always running
    Variable:   0-30 additional nodes during peak
    Batch:      0-10 Spot nodes for batch processing

    Recommendation:
      Savings Plans are an HOURLY SPEND commitment, not instances:
      commit about the discounted hourly cost of 14 c6i.4xlarge
      (3yr no-upfront Compute Savings Plan)
      Keep ~6 nodes' worth On-Demand as buffer
      All batch on Spot

    Monthly savings vs all On-Demand (assuming ~45% discount):
      14 nodes * $0.68/hr * 730hr * 0.45 ≈ $3,130/month savings
```

### ‏AWS CLI: شراء Savings Plans

```bash
# Step 1: Get current On-Demand spend to calculate commitment
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days THIRTY_DAYS

# Step 2: Review the recommendation, find the offering, then purchase
# (commitment = $ per HOUR; offering = plan type + term + payment option)
OFFERING_ID=$(aws savingsplans describe-savings-plans-offerings \
  --plan-types Compute --durations 31536000 --payment-options "No Upfront" \
  --query 'searchResults[0].offeringId' --output text)

aws savingsplans create-savings-plan \
  --savings-plan-offering-id "$OFFERING_ID" \
  --commitment 500.00

# Step 3: Monitor Savings Plan utilization
aws ce get-savings-plans-utilization \
  --time-period Start=2026-11-01,End=2026-11-08
# Target: >90% utilization (unused commitment = wasted money)
```

---

## الإنهاء التلقائي للبيئات الخاملة

كثيرًا ما تعمل بيئات التطوير والتجهيز على مدار الساعة لكنها لا تُستخدم إلا في ساعات العمل. وأتمتة إيقافها توفر تكلفة كبيرة.

```yaml
# CronJob: scale down non-production namespaces at 20:00 UTC (15:00/16:00 US East)
# Note: if Argo CD / Flux with self-heal manages these namespaces, they will
# scale the workloads straight back up -- exclude replicas from sync or use
# a tool like kube-downscaler that GitOps tools know about
apiVersion: batch/v1
kind: CronJob
metadata:
  name: scale-down-dev
  namespace: platform-ops
spec:
  schedule: "0 20 * * 1-5"  # weekdays at 20:00 UTC
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: namespace-scaler
          containers:
            - name: scaler
              image: registry.internal/tools/kubectl:1.33   # internally mirrored image
              command:
                - /bin/sh
                - -c
                - |
                  # Remember each workload's replica count, then scale to 0
                  for ns in $(kubectl get namespaces -l environment=dev -o name | cut -d/ -f2); do
                    echo "Scaling down namespace: $ns"
                    for w in $(kubectl get deployment,statefulset -n "$ns" -o name); do
                      r=$(kubectl get "$w" -n "$ns" -o jsonpath='{.spec.replicas}')
                      if [ "$r" -gt 0 ]; then
                        kubectl annotate --overwrite "$w" -n "$ns" fintech.io/original-replicas="$r"
                        kubectl scale "$w" -n "$ns" --replicas=0
                      fi
                    done
                  done
                  echo "Scale-down complete: $(date)"
          restartPolicy: OnFailure
---
# CronJob: scale back up at 08:00 UTC
apiVersion: batch/v1
kind: CronJob
metadata:
  name: scale-up-dev
  namespace: platform-ops
spec:
  schedule: "0 8 * * 1-5"  # weekdays at 08:00 UTC
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: namespace-scaler
          containers:
            - name: scaler
              image: registry.internal/tools/kubectl:1.33
              command:
                - /bin/sh
                - -c
                - |
                  # Restore each workload to the replica count saved at scale-down
                  # (a rollout restart would NOT bring a 0-replica workload back)
                  for ns in $(kubectl get namespaces -l environment=dev -o name | cut -d/ -f2); do
                    for w in $(kubectl get deployment,statefulset -n "$ns" -o name); do
                      r=$(kubectl get "$w" -n "$ns" \
                          -o jsonpath='{.metadata.annotations.fintech\.io/original-replicas}')
                      if [ -n "$r" ]; then
                        kubectl scale "$w" -n "$ns" --replicas="$r"
                      fi
                    done
                  done
          restartPolicy: OnFailure
```

---

## نموذج تحميل التكلفة (Chargeback)

يوزّع نموذج تحميل التكلفة التكاليف السحابية على فرق المنتجات، فينشئ مساءلة عن استخدام الموارد.

```
Chargeback architecture for fintech:

  Total cluster cost (from AWS billing):
    Compute:    $80,000/month
    Storage:    $20,000/month
    Network:    $10,000/month
    Total:      $110,000/month

  Kubecost allocation (by namespace label team=):
    payments-platform:    $45,000  (41%)
    fraud-engineering:    $23,000  (21%)
    compliance-team:      $18,000  (16%)
    platform-team:        $12,000  (11%)
    unallocated:          $12,000  (11%)  ← investigate tagging gaps

  Monthly chargeback per team:
    Each team is charged their allocated cost
    Reviewed in monthly FinOps meeting
    Budget alerts at 80% of monthly allocation

  Unit economics per team:
    payments-platform: $45,000 / 150M transactions = $0.0003 per transaction
    fraud-engineering: $23,000 / 150M checks       = $0.00015 per fraud check
```

### تقرير تحميل التكلفة من Kubecost ‏(Shell)

```bash
# Generate monthly chargeback report
MONTH_START=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d)
MONTH_END=$(date -d "$(date +%Y-%m-01) +1 month" +%Y-%m-%d)

curl -sG "http://kubecost-cost-analyzer.kubecost.svc.cluster.local:9090/model/allocation" \
  --data-urlencode "window=${MONTH_START}T00:00:00Z,${MONTH_END}T00:00:00Z" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true" | jq '
  .data[0] | to_entries | map({
    team: .key,
    totalCostUSD: (.value.totalCost | round),
    cpuCostUSD: (.value.cpuCost | round),
    memoryCostUSD: (.value.ramCost | round),
    storageCostUSD: (.value.pvCost | round)
  }) | sort_by(-.totalCostUSD)
'
```

---

## حوكمة التكلفة السحابية للخدمات الخاضعة للتنظيم

للخدمات المالية متطلبات امتثال إضافية تؤثر على حوكمة التكلفة.

```
Governance requirements unique to fintech:

1. Data retention costs:
   PCI-DSS:    audit logs 12 months, the last 3 months immediately available
   GDPR:       Delete EU PII data when no longer needed (cost benefit)
   SOX / local banking law: often 7 years for financial records
   (check the actual obligations with your compliance team -- they vary
    by country and record type)
   
   Cost implication: S3 lifecycle policies must balance compliance vs cost
   Solution: S3 Intelligent-Tiering for data where access is unpredictable,
             Glacier Deep Archive for cold compliance archives ($0.00099/GB/month)

2. Audit logging:
   CloudTrail, VPC Flow Logs, Kubernetes audit logs must be retained
   Cost: the first CloudTrail management-event trail is free; data events,
   extra trails, Flow Logs and log storage can add up to a large line item
   Cannot be disabled — it is a compliance requirement; tune volume
   (sampling of flow logs, filters) instead

3. Multi-region backup:
   RTO/RPO requirements mandate cross-region backups
   Data transfer cost: $0.02/GB between AWS regions
   Compress backups before cross-region transfer

4. Encryption at rest and in transit:
   KMS costs: $1/month per CMK + $0.03 per 10,000 API calls
   Optimize: use fewer keys strategically, monitor KMS costs in Cost Explorer
```

### سياسة دورة حياة S3 لأرشيفات الامتثال

يجب أن تكون سجلات التدقيق أيضًا غير قابلة للتعديل: فعّل S3 Object Lock (وضع الامتثال) على الحاوية كي لا يستطيع حتى مسؤول حذفها قبل تاريخ الاحتفاظ.

```json
{
  "Rules": [
    {
      "ID": "payment-audit-log-lifecycle",
      "Status": "Enabled",
      "Filter": {"Prefix": "audit-logs/"},
      "Transitions": [
        {
          "Days": 30,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 90,
          "StorageClass": "GLACIER_IR"
        },
        {
          "Days": 365,
          "StorageClass": "DEEP_ARCHIVE"
        }
      ],
      "Expiration": {
        "Days": 2555
      }
    },
    {
      "ID": "payment-transactions-lifecycle",
      "Status": "Enabled",
      "Filter": {"Prefix": "transactions/"},
      "Transitions": [
        {
          "Days": 90,
          "StorageClass": "INTELLIGENT_TIERING"
        }
      ],
      "Expiration": {
        "Days": 2555
      }
    }
  ]
}
```

---

## تنبيهات الميزانية وكشف شذوذ التكلفة

```bash
# Create AWS Budget with alert for payments team.
# The tag key is case-sensitive ("Team", as set by Terraform default_tags),
# and must be ACTIVATED as a cost allocation tag in the Billing console
aws budgets create-budget \
  --account-id 123456789 \
  --budget '{
    "BudgetName": "payments-platform-monthly",
    "BudgetLimit": {"Amount": "55000", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": {
      "TagKeyValue": ["user:Team$payments-platform"]
    }
  }' \
  --notifications-with-subscribers '[
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 80,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        {"SubscriptionType": "EMAIL", "Address": "payments-platform@fintech.com"},
        {"SubscriptionType": "SNS", "Address": "arn:aws:sns:us-east-1:123456789:cost-alerts"}
      ]
    }
  ]'

# Enable Cost Anomaly Detection
aws ce create-anomaly-monitor \
  --anomaly-monitor '{
    "MonitorName": "PaymentsPlatformAnomalyMonitor",
    "MonitorType": "DIMENSIONAL",
    "MonitorDimension": "SERVICE"
  }'

aws ce create-anomaly-subscription \
  --anomaly-subscription '{
    "SubscriptionName": "payments-anomaly-alert",
    "MonitorArnList": ["arn:aws:ce::123456789:anomalymonitor/abc123"],
    "Subscribers": [
      {"Address": "arn:aws:sns:us-east-1:123456789:cost-alerts", "Type": "SNS"}
    ],
    "ThresholdExpression": {
      "Dimensions": {
        "Key": "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
        "Values": ["500"],
        "MatchOptions": ["GREATER_THAN_OR_EQUAL"]
      }
    },
    "Frequency": "DAILY"
  }'
```

---

## الخلاصات الأساسية للمهندسين الكبار

1. **ضع الوسوم على كل شيء قبل كتابة الشيفرة** — وضع الوسوم على موارد AWS بأثر رجعي مؤلم وغير مكتمل. فعرّف معيار الوسوم وافرضه قبل إنشاء أول مورد. واستخدم default_tags في Terraform لتطبيق الوسوم تلقائيًا.

2. **تستطيع نسخ Spot تشغيل 70-80% من أحمالك الدفعية** — تدريب نماذج الاحتيال، وتقارير الامتثال، ومعالجة التسوية الدفعية، ومهام ETL كلها مؤهلة لـ Spot. وإشعار المقاطعة قبل دقيقتين كافٍ للمهام التي تحفظ نقاط الاستئناف بشكل صحيح.

3. **‏Savings Plans للحمل الأساسي المتوقع، وSpot للذروات المتغيرة** — تعمل واجهة الدفع دائمًا بثلاث نسخ على الأقل. وهذه النسخ الثلاث يجب أن تكون تحت Savings Plan. أما النسخ الإضافية 0-47 التي تتوسع مع الحركة فيجب أن تكون On-Demand أو Spot.

4. **التحجيم المناسب أعلى أنشطة FinOps عائدًا** — كثيرًا ما تكون أحمال Kubernetes مفرطة التوفير بشدة، لأن الطلبات الأولية تخمينات. شغّل VPA بوضع Off أسبوعًا، وطبّق التوصيات بهامش 20%، ودع الموسّع التلقائي يزيل العقد المحررة. والوفورات الكبيرة في الحوسبة شائعة.

5. **اقتصاديات الوحدة أهم من التكلفة المطلقة** — منصة دفع تعالج 10 أضعاف المعاملات بضعف التكلفة مكسب. فتتبّع التكلفة لكل 1,000 دفعة معالجة. وإذا كان هذا المقياس ينخفض، فأنت تتوسع بكفاءة.

6. **متطلبات الاحتفاظ للامتثال تقود تكاليف التخزين** — لكل من PCI-DSS، وSOX، وGDPR متطلبات احتفاظ تجبرك على حفظ البيانات أطول مما قد تريد. واستخدم سياسات دورة حياة S3 لنقل البيانات تلقائيًا إلى Glacier وDeep Archive. وهذا قد يقلل تكاليف تخزين أرشيفات الامتثال الباردة بنسبة 90%.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "فحص سياسة في خط Terraform ‏(OPA مع conftest) يرفض أي مورد AWS دون وسم مركز تكلفة إلزامي. يحاول مطوّر إنشاء نسخة RDS دون الوسم فيفشل الخط. ويجادل المطوّر بأن متطلب الوسم يبطئ التطوير. ما رد المهندس الرئيسي؟",
      "options": ["استثنِ بيئات التطوير من متطلب الوسوم لتحرير المهندسين", "سياسة الوسوم غير قابلة للتفاوض لأنه دون وسوم متسقة يستحيل نسب التكلفة إلى الفرق والمنتجات؛ وفّر وحدة Terraform تتضمن الوسوم المطلوبة افتراضيًا كي لا يحتاج المهندسون تذكرها أبدًا", "أنشئ سياسة OPA منفصلة للإنتاج فقط؛ فموارد التطوير لا تحتاج تتبع التكلفة", "اسمح للمهندسين بتقديم طلب استثناء من الوسوم يُوافق عليه يدويًا خلال 24 ساعة"],
      "correct": 1,
      "explanation": "وضع الوسوم على الموارد السحابية بأثر رجعي صعب للغاية — فالموارد يُعاد تسميتها، والملكية تتغير، والمهندسون ينسون السياق. والرد الصحيح فرض الوسوم على الجميع وجعل الامتثال أسهل طريق بتوفير وحدات Terraform وقوالب Backstage تتضمن الوسوم المطلوبة تلقائيًا. واعتراض المطوّر على الاحتكاك، لا على السياسة نفسها؛ والحل إزالة الاحتكاك مع إبقاء السياسة."
    },
    {
      "text": "حمل عمل في Kubernetes استخدامه الفعلي للمعالج 200m لكن طلباته = 2000m (مفرط التوفير 10 أضعاف). ويوصي VPA بوضع Off بطلبات = 250m. ويطبّق الفريق توصية VPA. ما الأثر على التكلفة وما الخطر الذي يجب إدارته؟",
      "options": ["معالج مطلوب أقل بنسبة تصل إلى 87.5% لهذا الحمل — وتنخفض الفاتورة بمجرد أن يجمع الموسّع التلقائي الـ pods على عقد أقل؛ والخطر نقص التوفير أثناء ذروات الحركة إذا لم تتضمن التوصية هامشًا كافيًا", "لا خفض للتكلفة؛ فـ Kubernetes يحتسب الاستخدام الفعلي لا الطلبات", "خفض فوري للتكلفة لكن الـ pod سيُطرد ويُعاد جدولته فيسبب انقطاعًا قصيرًا للخدمة", "يسري خفض التكلفة فقط في دورة استبدال العقد التالية"],
      "correct": 0,
      "explanation": "تستخدم جدولة Kubernetes الطلبات (لا الاستخدام الفعلي) لتقرير عدد الـ pods التي تتسع لها العقدة. والطلبات المفرطة تجعل العقد تبدو ممتلئة بينما معالجاتها خاملة، فتُوفّر عقد أكثر من اللازم. وخفض الطلبات من 2000m إلى 250m (مع هامش 20% ≈ 300m) يتيح لـ pods أكثر مشاركة العقدة، فيستطيع موسّع العنقود التلقائي إزالة عقد كاملة — وحينها يظهر التوفير في الفاتورة. والخطر هامش غير كافٍ لذروات الحركة — فطبّق توصيات VPA بهامش 20-30% وأبقِ HPA للدفقات."
    },
    {
      "text": "تشغّل منصة دفع مهمة تدريب ليلية لنموذج احتيال تستغرق 4 ساعات. ويقيّم الفريق نسخ Spot لهذا الحمل. وتستخدم المهمة حاليًا 20 نسخة m5.4xlarge بنظام On-Demand بسعر 0.768$/ساعة لكل منها. وسعر Spot ‏0.23$/ساعة باحتمال مقاطعة 15%. أي بنية تجعل هذا الحمل آمنًا على Spot؟",
      "options": ["استخدم نسخ Spot دون تعديل؛ فاحتمال المقاطعة 15% يعني أن المهمة ستكتمل في 85% من الحالات", "نفّذ نقاط حفظ كي تحفظ المهمة تقدمها كل 30 دقيقة؛ وعند مقاطعة Spot (إشعار قبل دقيقتين)، احفظ نقطة الاستئناف وأعد التشغيل من آخر نقطة على نسخ جديدة — التكلفة الإجمالية: ‏0.23 × 20 × 4 = 18.40$ مقابل 0.768 × 20 × 4 = 61.44$ بنظام On-Demand", "استخدم النسخ المحجوزة بدل Spot للأحمال الدفعية المتوقعة", "قسّم المهمة على 100 نسخة أصغر لتقليل خطر المقاطعة لكل نسخة"],
      "correct": 1,
      "explanation": "إشعار مقاطعة Spot قبل دقيقتين كافٍ للمهام التي تحفظ نقاط الاستئناف بشكل صحيح. ومع نقاط حفظ كل 30 دقيقة، أسوأ حالة فقدان 30 دقيقة عمل، لا 4 ساعات. والوفورات كبيرة: ‏18.40$ مقابل 61.44$ (خفض 70%). وتتطلب البنية: (أ) أن يدعم إطار تعلم الآلة الحفظ/الاستئناف (معظمها يدعم: PyTorch، وTensorFlow، وXGBoost)، (ب) كتابة نقاط الحفظ إلى S3 أو EFS (لا التخزين المحلي للنسخة)، (ج) طابور مهام (SQS أو Kubernetes Job) لإعادة جدولة العمل المقاطَع تلقائيًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ نظام FinOps لنسب التكلفة والتحجيم المناسب",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "اكتب ConstraintTemplate في OPA Gatekeeper ‏(MandatoryTagPolicy) يفرض الوسوم التالية على كل Deployments في Kubernetes: ‏team (يجب أن يطابق قائمة فرق معروفة)، وproduct (يجب أن يكون رمز منتج صالحًا)، وcost-center (يجب أن يكون نصًا رقميًا من 4 خانات)، وenvironment (يجب أن يكون أحد: production، أو staging، أو development). ويجب أن يرفض القيد الـ Deployments التي ينقصها أي وسم مطلوب والـ Deployments ذات قيم الوسوم غير الصالحة. واكتب ثلاث حالات اختبار: نشر ممتثل، ونشر ينقصه وسم team، ونشر بقيمة environment غير صالحة."
    },
    {
      "id": "2",
      "description": "نفّذ CostAttributionService يستعلم واجهة Kubecost (أو يحاكيها ببيانات وهمية) وينتج CostReport أسبوعيًا يتضمن: (أ) التكلفة لكل مساحة أسماء، (ب) التكلفة لكل تسمية فريق، (ج) أغلى 5 Deployments، (د) فرصة التوفير من توصيات VPA (مجموع الفرق بين طلبات المعالج الحالية والموصى بها عبر كل الأحمال المفرطة التوفير)، (هـ) تكلفة الموارد الخاملة (تكلفة الطلبات التي تزيد على 3 أضعاف الاستخدام الفعلي). ويجب تنسيق التقرير كـ JSON وتخزينه في S3 بصيغة مفتاح: cost-reports/YYYY/WW/report.json."
    },
    {
      "id": "3",
      "description": "صمّم مواصفة Kubernetes Job آمنة على Spot لحمل تدريب نموذج الاحتيال الليلي: محدد عقد Spot وtoleration لـ taint ‏Spot في الـ NodePool، وخطاف preStop يستدعي نقطة /checkpoint للمدرّب (terminationGracePeriodSeconds 90)، وrestartPolicy=OnFailure مع backoffLimit=5، ونقاط حفظ على S3 أو EFS. واضبط معالجة المقاطعة — طابور المقاطعة المدمج في Karpenter، أو AWS Node Termination Handler مع Cluster Autoscaler — كي تُفرَّغ العقدة بمجرد وصول إشعار الدقيقتين. ووثّق التوفير المتوقع مقارنة بـ On-Demand."
    },
    {
      "id": "4",
      "description": "أنشئ CronJob في Kubernetes باسم ChargebackReport يعمل شهريًا و: (أ) يستعلم واجهة التوزيع في Kubecost للشهر السابق، (ب) يجمّع التكاليف حسب تسميات الفريق والمنتج، (ج) يولّد CSV بالأعمدة: team، وproduct، وcompute_cost_usd، وstorage_cost_usd، وnetwork_cost_usd، وtotal_cost_usd، وcost_per_1000_transactions (باستخدام عدد المعاملات من استعلام Prometheus)، (د) يرسل الـ CSV إلى حاوية S3 قابلة للضبط وينشر ملخصًا في Slack. واكتب اختبار تكامل باستخدام WireMock لمحاكاة واجهتي Kubecost وPrometheus."
    }
  ]
}
-->
