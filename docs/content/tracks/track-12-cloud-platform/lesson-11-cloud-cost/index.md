---
id: track-12-lesson-11
title: "Cloud Cost Engineering — FinOps for Financial Platforms"
slug: cloud-cost
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 11
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [FinOps, cloud-cost, spot-instances, reserved-instances, right-sizing]
prerequisites: []
---

# Cloud Cost Engineering — FinOps for Financial Platforms

> [!NOTE]
> A fintech platform processing $100M/day in payments running on $500K/month of AWS infrastructure is not inherently justified — a well-architected platform should run the same workload for $150K/month. Cloud cost engineering is not about cutting corners; it is about eliminating waste while maintaining the reliability and performance that financial operations require.

## The FinOps Framework

The Cloud Financial Management (FinOps) Foundation defines three lifecycle phases:

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

## Cost Tagging Strategy

Without consistent tagging, cost allocation is guesswork. Define tags before resources are created.

### Mandatory Tag Policy

```yaml
# OPA (Open Policy Agent) policy: enforce mandatory tags on all resources
# Applied via AWS Config, Terraform Sentinel, or OPA Gatekeeper
package aws_resource_tags

required_tags := {
    "Team",
    "Environment",
    "Product",
    "CostCenter",
    "DataClassification"
}

deny[msg] {
    resource := input.resource
    missing := required_tags - {tag | resource.tags[tag]}
    count(missing) > 0
    msg := sprintf("Resource %v is missing required tags: %v", [resource.type, missing])
}
```

```bash
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

### Kubernetes Labels for Cost Allocation

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

## Kubecost: Cost Visibility Per Service

Kubecost provides per-namespace, per-deployment, and per-label cost visibility within Kubernetes clusters.

### Installing Kubecost

```bash
# Install Kubecost on each cluster
helm repo add kubecost https://kubecost.github.io/cost-analyzer
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set kubecostToken="your-token-here" \
  --set global.prometheus.fqdn=http://prometheus.monitoring.svc.cluster.local:9090 \
  --set global.prometheus.enabled=false  # use existing Prometheus \
  --set costAnalyzer.defaultClusterID=payment-prod-us-east-1 \
  --set global.podAnnotations."cluster-autoscaler\.kubernetes\.io/safe-to-evict"=true
```

### Reading Kubecost Reports

```bash
# Get cost summary via Kubecost API
# Cost per namespace for the last 30 days
curl "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation?window=30d&aggregate=namespace&accumulate=false" \
  | jq '.data[0] | to_entries | map({namespace: .key, monthlyCost: .value.totalCost}) | sort_by(-.monthlyCost)'

# Example output:
# [
#   {"namespace": "payments",    "monthlyCost": 45230.50},
#   {"namespace": "fraud",       "monthlyCost": 23100.00},
#   {"namespace": "compliance",  "monthlyCost": 12800.00},
#   {"namespace": "monitoring",  "monthlyCost": 8900.00}
# ]

# Cost per deployment within payments namespace
curl "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation?window=30d&aggregate=deployment&namespace=payments"

# Right-sizing recommendations
curl "http://kubecost.kubecost.svc.cluster.local:9090/savings/requestSizing?targetCPUUtilization=0.7&targetMemUtilization=0.7"
```

### Unit Economics Dashboard

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

## Right-Sizing with VPA and Kubecost

The largest cost lever is container right-sizing. Over-provisioned containers waste CPU and memory, forcing larger (more expensive) nodes.

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
curl "http://kubecost.kubecost.svc.cluster.local:9090/savings/requestSizing?
  namespace=payments&
  targetCPUUtilization=0.7&
  targetMemUtilization=0.8&
  window=7d" | jq '.recommendations[] | {
    deployment: .deployment,
    currentCPURequest: .currentCPURequest,
    recommendedCPURequest: .recommendedCPURequest,
    cpuSavingsPercent: .cpuSavingsPercent,
    monthlySavings: .monthlySavings
  }'
```

### Applying Right-Sizing Recommendations

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

# Monthly savings calculation:
# Before: 10 replicas * 2 CPU * $0.0464/vCPU-hr * 730hr = $677/month
# After:  10 replicas * 0.48 CPU * $0.0464/vCPU-hr * 730hr = $162/month
# Saving: $515/month per deployment, just from right-sizing
```

---

## Spot Instances for Non-Critical Workloads

Spot instances are 70-90% cheaper than On-Demand but can be interrupted with 2 minutes notice. The key is identifying which payment workloads can tolerate interruption.

### Spot-Eligible vs On-Demand Workloads

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

### Spot Node Group with Karpenter

```yaml
# Karpenter NodePool for Spot batch workloads
apiVersion: karpenter.sh/v1beta1
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

      # Spot interruption handling: drain before termination
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: batch-node-class

  # Only scale down batch nodes aggressively — they're cheap anyway
  disruption:
    consolidationPolicy: WhenUnderutilized
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

      # Handle Spot interruption: save checkpoint before 2min window
      terminationGracePeriodSeconds: 120  # 2 minutes = Spot interruption notice

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

## Reserved Instances and Savings Plans

For predictable base load (the minimum number of pods always running), Reserved Instances or Savings Plans offer significant discounts over On-Demand.

```
AWS Savings Plans for fintech:

  Compute Savings Plans:
    - 1 year, no upfront:  ~20% discount
    - 1 year, all upfront: ~30% discount
    - 3 year, all upfront: ~40-50% discount
    - Applies to any EC2 instance family, region, or OS
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
      Purchase 14x c6i.4xlarge Savings Plan (3yr no-upfront)
      Keep 6x On-Demand as buffer
      All batch on Spot

    Monthly savings vs all On-Demand:
      14 nodes * $0.68/hr * 730hr * (1 - 0.60 Savings Plan discount) = $2,850/month savings
```

### AWS CLI: Purchase Savings Plans

```bash
# Step 1: Get current On-Demand spend to calculate commitment
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days THIRTY_DAYS

# Step 2: Review recommendation, then purchase
aws savingsplans create-savings-plan \
  --savings-plan-type ComputeSavingsPlans \
  --commitment 500.00 \          # $500/hour commitment
  --term-duration-in-seconds 31536000 \  # 1 year
  --payment-option NO_UPFRONT

# Step 3: Monitor Savings Plan utilization
aws ce get-savings-plans-utilization \
  --time-period Start=2026-11-01,End=2026-11-08
# Target: >90% utilization (unused commitment = wasted money)
```

---

## Auto-Terminating Idle Environments

Development and staging environments often run 24/7 but are only used during business hours. Automating shutdown saves significant cost.

```yaml
# CronJob: scale down non-production namespaces at 20:00 UTC (3pm US East)
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
              image: bitnami/kubectl:1.28
              command:
                - /bin/sh
                - -c
                - |
                  # Scale down all deployments in dev namespaces
                  for ns in $(kubectl get namespaces -l environment=dev -o name | cut -d/ -f2); do
                    echo "Scaling down namespace: $ns"
                    kubectl scale deployment --all --replicas=0 -n $ns
                    kubectl scale statefulset --all --replicas=0 -n $ns
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
              image: bitnami/kubectl:1.28
              command:
                - /bin/sh
                - -c
                - |
                  # Restore deployments from their desired replica count
                  # (stored in annotations set before scale-down)
                  for ns in $(kubectl get namespaces -l environment=dev -o name | cut -d/ -f2); do
                    kubectl annotate --overwrite ns $ns \
                      fintech.io/last-scaleup="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
                    kubectl rollout restart deployment --all -n $ns 2>/dev/null || true
                  done
          restartPolicy: OnFailure
```

---

## Chargeback Model

A chargeback model allocates cloud costs back to product teams, creating accountability for resource usage.

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

### Kubecost Chargeback Report (Shell)

```bash
# Generate monthly chargeback report
MONTH_START=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d)
MONTH_END=$(date -d "$(date +%Y-%m-01) +1 month" +%Y-%m-%d)

curl -s "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation?
  window=${MONTH_START}T00:00:00Z,${MONTH_END}T00:00:00Z&
  aggregate=label:team&
  accumulate=true" | jq '
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

## Cloud Cost Governance for Regulated Services

Financial services have additional compliance requirements that affect cost governance.

```
Governance requirements unique to fintech:

1. Data retention costs:
   PCI-DSS:    1-year active + 2-year archive minimum
   GDPR:       Delete EU PII data when no longer needed (cost benefit)
   SOX:        7-year financial record retention
   
   Cost implication: S3 lifecycle policies must balance compliance vs cost
   Solution: S3 Intelligent-Tiering for data where access is unpredictable,
             Glacier Deep Archive for cold compliance archives ($0.00099/GB/month)

2. Audit logging:
   CloudTrail, VPC Flow Logs, Kubernetes audit logs must be retained
   Cost: ~$5-15/month per account for CloudTrail alone
   Cannot be disabled — it is a compliance requirement

3. Multi-region backup:
   RTO/RPO requirements mandate cross-region backups
   Data transfer cost: $0.02/GB between AWS regions
   Compress backups before cross-region transfer

4. Encryption at rest and in transit:
   KMS costs: $1/month per CMK + $0.03 per 10,000 API calls
   Optimize: use fewer keys strategically, monitor KMS costs in Cost Explorer
```

### S3 Lifecycle Policy for Compliance Archives

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

## Budget Alerts and Cost Anomaly Detection

```bash
# Create AWS Budget with alert for payments team
aws budgets create-budget \
  --account-id 123456789 \
  --budget '{
    "BudgetName": "payments-platform-monthly",
    "BudgetLimit": {"Amount": "55000", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": {
      "TagKeyValue": ["user:team$payments-platform"]
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
    "Threshold": 500,
    "Frequency": "DAILY"
  }'
```

---

## Key Takeaways for Senior Engineers

1. **Tag everything before writing code** — retroactively tagging AWS resources is painful and incomplete. Define and enforce a tagging standard before the first resource is created. Use Terraform default_tags to apply tags automatically.

2. **Spot instances can run 70-80% of your batch workloads** — fraud model training, compliance reports, settlement batch processing, and ETL jobs are all Spot-eligible. The 2-minute interruption notice is sufficient for jobs that checkpoint correctly.

3. **Savings Plans for predictable base load, Spot for variable peaks** — the payment API always runs at least 3 replicas. Those 3 replicas should be under a Savings Plan. The 0-47 additional replicas that scale with traffic should be On-Demand or Spot.

4. **Right-sizing is the highest-ROI FinOps activity** — most Kubernetes workloads are over-provisioned by 3-5x based on initial estimates. Run VPA in Off mode for a week, apply the recommendations with 20% headroom. This alone typically reduces compute costs by 40-60%.

5. **Unit economics matter more than absolute cost** — a payment platform processing 10x more transactions at 2x the cost is a win. Track cost per 1,000 payments processed. If this metric is declining, you are scaling efficiently.

6. **Compliance retention requirements drive storage costs** — PCI-DSS, SOX, and GDPR each have retention requirements that force you to keep data longer than you might want. Use S3 lifecycle policies to tier data to Glacier and Deep Archive automatically. This can reduce storage costs by 90% for cold compliance archives.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "An OPA Gatekeeper policy denies creation of any AWS resource without a mandatory cost-center tag. A developer tries to create an RDS instance without the tag and the Terraform apply fails. The developer argues the tag requirement slows down development. What is the principal engineer's response?",
      "options": ["Exempt development environments from the tagging requirement to unblock engineers", "The tagging policy is non-negotiable because without consistent tagging, cost attribution to teams and products is impossible; provide a Terraform module that includes the required tags by default so engineers never need to remember them", "Create a separate OPA policy for production only; development resources do not need cost tracking", "Allow engineers to submit a tag exemption request that is manually approved within 24 hours"],
      "correct": 1,
      "explanation": "Retroactively tagging cloud resources is extremely difficult — resources get renamed, ownership changes, and engineers forget context. The correct response is to enforce tagging universally AND make compliance the path of least resistance by providing Terraform modules and Backstage templates that include required tags automatically. The developer's objection is about friction, not the policy itself; the solution is to remove the friction while keeping the policy."
    },
    {
      "text": "A Kubernetes workload has actual CPU usage of 200m but requests = 2000m (10x over-provisioned). VPA in Off mode recommends requests = 250m. The team applies the VPA recommendation. What is the immediate cost impact and what risk must be managed?",
      "options": ["Immediate 87.5% reduction in compute cost for this workload; risk is under-provisioning during traffic spikes if the VPA recommendation does not include adequate headroom", "No cost reduction; Kubernetes charges for actual usage not requests", "Immediate cost reduction but the pod will be evicted and rescheduled which causes a brief service interruption", "Cost reduction only takes effect at the next node replacement cycle"],
      "correct": 0,
      "explanation": "Kubernetes node scheduling uses requests (not actual usage) to determine how many pods fit on a node. Over-provisioned requests cause nodes to appear full while still having unused capacity, forcing more nodes to be provisioned than necessary. Reducing requests from 2000m to 250m (with 20% headroom = 300m) allows more pods per node, potentially eliminating entire nodes from the cluster. The risk is insufficient headroom for traffic spikes — VPA recommendations should be applied with 20-30% buffer and monitored with HPA for burst traffic handling."
    },
    {
      "text": "A payment platform runs a nightly fraud model training job that takes 4 hours. The team is evaluating Spot instances for this workload. The job currently uses 20x m5.4xlarge On-Demand instances at $0.768/hour each. Spot price is $0.23/hour with 15% interruption probability. What architecture makes this workload Spot-safe?",
      "options": ["Use Spot instances without modification; a 15% interruption probability means the job will complete 85% of the time", "Implement checkpointing so the job saves progress every 30 minutes; on Spot interruption (2-minute notice), save checkpoint and restart from last checkpoint on new instances — total cost: $0.23 * 20 * 4 = $18.40 vs $0.768 * 20 * 4 = $61.44 On-Demand", "Use Reserved Instances instead of Spot for predictable batch workloads", "Split the job across 100 smaller instances to reduce per-instance interruption risk"],
      "correct": 1,
      "explanation": "The 2-minute Spot interruption notice is sufficient for jobs that checkpoint correctly. With 30-minute checkpoints the worst case is losing 30 minutes of work, not 4 hours. The savings are substantial: $18.40 vs $61.44 (70% reduction). The architecture requires: (a) the ML framework to support checkpoint/resume (most do: PyTorch, TensorFlow, XGBoost), (b) checkpoints written to S3 or EFS (not instance-local storage), and (c) a job queue (SQS or Kubernetes Job) to automatically requeue interrupted work."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement a FinOps Cost Attribution and Right-Sizing System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Write an OPA Gatekeeper ConstraintTemplate (MandatoryTagPolicy) that enforces the following tags on all Kubernetes Deployments: team (must match a known team list), product (must be a valid product code), cost-center (must be a 4-digit numeric string), environment (must be one of: production, staging, development). The constraint must reject Deployments missing any required tag AND Deployments with invalid tag values. Write three test cases: one compliant deployment, one missing the team tag, and one with an invalid environment value."
    },
    {
      "id": "2",
      "description": "Implement a CostAttributionService that queries the Kubecost API (or simulates it with mock data) and produces a weekly CostReport with: (a) cost per namespace, (b) cost per team label, (c) top 5 most expensive deployments, (d) VPA recommendation savings opportunity (sum of recommended_cpu_requests - actual_cpu_requests across all over-provisioned workloads), (e) idle resource cost (cost of requests that are more than 3x actual usage). The report must be formatted as JSON and stored in S3 with key format: cost-reports/YYYY/WW/report.json."
    },
    {
      "id": "3",
      "description": "Design a Spot-safe Kubernetes Job spec for the nightly fraud model training workload: use spot-instance node selector, configure tolerations for spot interruption taint, set a preStop hook that calls the model's /checkpoint endpoint (allowing 90 seconds grace), configure restartPolicy=OnFailure with backoffLimit=5. Add a Spot interruption handler DaemonSet using the AWS Node Termination Handler that detects the 2-minute termination notice and triggers the preStop hook early. Document the expected cost saving versus On-Demand."
    },
    {
      "id": "4",
      "description": "Create a ChargebackReport Kubernetes CronJob that runs monthly and: (a) queries Kubecost allocation API for the previous month, (b) aggregates costs by team and product labels, (c) generates a CSV with columns: team, product, compute_cost_usd, storage_cost_usd, network_cost_usd, total_cost_usd, cost_per_1000_transactions (using transaction count from a Prometheus query), (d) sends the CSV to a configurable S3 bucket and posts a summary to Slack. Write an integration test using WireMock to simulate the Kubecost and Prometheus APIs."
    }
  ]
}
-->
