---
id: track-12-lesson-09
title: "Auto-Scaling — HPA, VPA, and KEDA for Financial Loads"
slug: auto-scaling
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [HPA, VPA, KEDA, auto-scaling, event-driven-scaling]
prerequisites: []
---

# Auto-Scaling — HPA, VPA, and KEDA for Financial Loads

> [!NOTE]
> Payment volumes are inherently spiky. Black Friday brings 10x normal load. Payroll runs drive hourly spikes. Market open and close create millisecond bursts. Static resource allocation either over-provisions (wasting money) or under-provisions (causing latency spikes and payment failures). Kubernetes auto-scaling — HPA, VPA, and KEDA — lets your platform adapt to these patterns automatically.

## Auto-Scaling Landscape

```
Three complementary auto-scalers:

  HPA (Horizontal Pod Autoscaler):
    What: Scales pod COUNT based on metrics
    When: Load is variable and stateless scaling works
    Metrics: CPU, memory, custom (Prometheus), external (Kafka lag)

  VPA (Vertical Pod Autoscaler):
    What: Adjusts pod RESOURCE REQUESTS (CPU/memory) per pod
    When: You don't know the right resource requests (right-sizing)
    Modes: Off (recommendation only), Initial (set at startup), Auto (live resize)

  KEDA (Kubernetes Event-Driven Autoscaler):
    What: Scales pod count based on EXTERNAL event sources
    When: Processing Kafka topics, SQS queues, cron schedules
    Special: Can scale to ZERO when no work exists

  Cluster Autoscaler:
    What: Scales NODE count in the underlying cluster
    When: HPA/KEDA have scaled pods but no capacity exists
    Provider: AWS EKS → Cluster Autoscaler or Karpenter
```

---

## HPA: CPU and Memory Scaling

### Basic CPU-Based HPA

```yaml
# HPA for payment API service — scale on CPU utilization
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-api-hpa
  namespace: payments
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  minReplicas: 3     # always keep 3 replicas for HA (spread across AZs)
  maxReplicas: 50    # cap at 50 to prevent runaway scaling costs

  metrics:
    # Scale when average CPU > 60% (triggers before saturation)
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60

    # Also scale on memory (payment API has variable memory per connection)
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70

  behavior:
    # Scale UP fast — payment spikes are sudden
    scaleUp:
      stabilizationWindowSeconds: 30    # only 30s before scaling up
      policies:
        - type: Pods
          value: 10        # add up to 10 pods per minute
          periodSeconds: 60
        - type: Percent
          value: 100       # or double the current count, whichever is larger
          periodSeconds: 60
      selectPolicy: Max    # use the policy that scales up the most

    # Scale DOWN slowly — payment systems have session state and in-flight requests
    scaleDown:
      stabilizationWindowSeconds: 300   # wait 5 minutes of sustained low load
      policies:
        - type: Pods
          value: 2         # remove at most 2 pods per minute
          periodSeconds: 60
      selectPolicy: Min
```

### Deployment with Correct Resource Requests

```yaml
# Payment API Deployment — resource requests are what HPA uses for utilization %
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  replicas: 3  # initial count — HPA will override
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
      annotations:
        # VPA will adjust these based on actual usage
        fintech.io/right-sized: "true"
    spec:
      # Spread across AZs — payment API must survive AZ failure
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-api

      containers:
        - name: payment-api
          image: fintech/payment-api:v2.3.1
          ports:
            - containerPort: 8080

          resources:
            requests:
              cpu: "500m"      # HPA calculates: (actual CPU / 500m) * 100%
              memory: "512Mi"  # Set conservatively — VPA will right-size
            limits:
              cpu: "2000m"     # Allow burst to 4x request
              memory: "1Gi"

          # Graceful shutdown — drain in-flight payments before stopping
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 10"]

          # Readiness: pod must be ready to receive traffic before HPA counts it
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3

      # Allow graceful termination of in-flight payment requests
      terminationGracePeriodSeconds: 30
```

---

## HPA with Custom Metrics: Prometheus Adapter

CPU utilization is a poor proxy for payment API load. Request rate and queue depth are better signals.

### Installing Prometheus Adapter

```bash
# Install Prometheus Adapter to expose Prometheus metrics to HPA
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus.monitoring.svc.cluster.local \
  --set prometheus.port=9090
```

### Prometheus Adapter ConfigMap

```yaml
# prometheus-adapter-config.yaml
# Maps Prometheus metrics to Kubernetes custom metrics API
apiVersion: v1
kind: ConfigMap
metadata:
  name: adapter-config
  namespace: monitoring
data:
  config.yaml: |
    rules:
      # Payment request rate per pod
      - seriesQuery: 'http_requests_total{namespace="payments",service="payment-api"}'
        resources:
          overrides:
            namespace:
              resource: namespace
            pod:
              resource: pod
        name:
          matches: "http_requests_total"
          as: "payment_requests_per_second"
        metricsQuery: >
          sum(rate(http_requests_total{<<.LabelMatchers>>}[2m]))
          by (<<.GroupBy>>)

      # Payment processing queue depth
      - seriesQuery: 'payment_queue_depth{namespace="payments"}'
        resources:
          overrides:
            namespace:
              resource: namespace
        name:
          matches: "payment_queue_depth"
          as: "payment_queue_depth"
        metricsQuery: 'avg(payment_queue_depth{<<.LabelMatchers>>})'
```

### HPA Using Custom Metrics

```yaml
# HPA scaling on payment request rate (custom metric)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-api-hpa-custom
  namespace: payments
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  minReplicas: 3
  maxReplicas: 100

  metrics:
    # Scale to maintain <= 100 requests/second per pod
    - type: Pods
      pods:
        metric:
          name: payment_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"   # 100 req/s per pod

    # Ensure CPU doesn't spike even at low request rate
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 15  # 15s response time for payment spikes
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 600  # 10 minutes to confirm sustained low load
```

---

## VPA: Right-Sizing for Payment Workloads

VPA observes actual resource usage over time and recommends (or applies) better resource requests. This is critical for payment services where over-provisioning is expensive but under-provisioning causes latency.

### VPA in Recommendation Mode

```yaml
# VPA in Off mode — only provides recommendations, does not apply them
# Start with this to understand your actual usage
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-api-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  updatePolicy:
    updateMode: "Off"   # Recommend but do not apply

  resourcePolicy:
    containerPolicies:
      - containerName: payment-api
        # Set bounds to prevent extreme recommendations
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4000m
          memory: 4Gi
        # Control which resources VPA manages
        controlledResources: [cpu, memory]
        controlledValues: RequestsAndLimits
```

```bash
# Check VPA recommendations after running in Off mode for 24+ hours
kubectl get vpa payment-api-vpa -n payments -o jsonpath='{.status.recommendation}' | jq .

# Example output:
# {
#   "containerRecommendations": [{
#     "containerName": "payment-api",
#     "lowerBound": {"cpu": "340m", "memory": "380Mi"},
#     "target": {"cpu": "620m", "memory": "512Mi"},  ← use this
#     "upperBound": {"cpu": "1200m", "memory": "896Mi"},
#     "uncappedTarget": {"cpu": "620m", "memory": "512Mi"}
#   }]
# }
```

### VPA in Initial Mode

```yaml
# VPA in Initial mode — apply recommendation at pod creation only
# Safe for stateful apps that cannot tolerate in-place resource changes
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-postgres-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: payment-postgres
  updatePolicy:
    updateMode: "Initial"   # Only at pod creation, not live updates

  resourcePolicy:
    containerPolicies:
      - containerName: postgres
        minAllowed:
          cpu: 2000m
          memory: 8Gi
        maxAllowed:
          cpu: 16000m
          memory: 64Gi
        controlledResources: [cpu, memory]
```

### VPA Cannot Run with HPA on Same Resource

```
Important constraint:

  VPA and HPA cannot both manage the same resource on the same deployment.
  - If HPA manages CPU: VPA must use controlledResources: [memory]
  - If HPA manages memory: VPA must use controlledResources: [cpu]
  - If KEDA (HPA-equivalent) manages replicas: VPA can manage both CPU and memory

  Recommended pattern for payment services:
    HPA: manages pod count (scaling out)
    VPA: manages CPU/memory requests (right-sizing, Off mode → apply manually)

  Anti-pattern:
    HPA on CPU + VPA on CPU = fighting over the same signal
```

---

## KEDA: Event-Driven Scaling for Payment Processing

KEDA is the most powerful scaler for financial platforms because payment processing is fundamentally event-driven — driven by message queue depth, Kafka consumer lag, or cron schedules.

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set metricsServer.replicaCount=2  # HA for metrics server
```

### KEDA ScaledObject: Kafka Consumer Lag

```yaml
# Scale payment processors based on Kafka consumer lag
# When lag = 0: scale to 0 pods (save cost)
# When lag grows: scale up to handle the backlog
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: payment-processor-scaler
  namespace: payments
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-processor

  # Scaling boundaries
  minReplicaCount: 0    # scale to zero when no messages
  maxReplicaCount: 50   # cap at 50 processors

  # How aggressive to scale
  pollingInterval: 15   # check Kafka lag every 15 seconds
  cooldownPeriod: 300   # wait 5 minutes before scaling back to zero

  # Advanced: control scale-up/down speed
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0   # scale up immediately on lag
          policies:
            - type: Percent
              value: 100
              periodSeconds: 15
        scaleDown:
          stabilizationWindowSeconds: 300

  triggers:
    # Primary trigger: Kafka consumer lag
    - type: kafka
      metadata:
        bootstrapServers: kafka-0.kafka-headless:9092,kafka-1.kafka-headless:9092,kafka-2.kafka-headless:9092
        consumerGroup: payment-processor-group
        topic: payments.incoming
        # Target: 1 pod per 1000 messages of lag
        # 10,000 messages → 10 pods
        lagThreshold: "1000"
        offsetResetPolicy: latest
        # For SASL authentication
        sasl: plaintext
        username: payment-processor
        password: ref+k8s://payments/kafka-credentials#password
```

### KEDA ScaledObject: SQS Queue Depth

```yaml
# Scale dead-letter queue processor based on SQS queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: payment-dlq-processor
  namespace: payments
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-dlq-processor

  minReplicaCount: 0
  maxReplicaCount: 5    # DLQ processing is deliberate — don't rush it
  pollingInterval: 30
  cooldownPeriod: 600   # 10 minutes before scaling down DLQ processors

  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789/payment-dlq
        queueLength: "50"   # 1 pod per 50 DLQ messages
        awsRegion: us-east-1
      authenticationRef:
        name: keda-sqs-auth  # reference to TriggerAuthentication with IAM role

---
# TriggerAuthentication using IRSA (IAM Roles for Service Accounts)
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: keda-sqs-auth
  namespace: payments
spec:
  podIdentity:
    provider: aws  # Uses IRSA — no static credentials
```

### KEDA ScaledJob for Batch Settlement

```yaml
# ScaledJob: creates a Job for each settlement batch file
# When no files are in S3, no jobs run (true scale-to-zero)
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: settlement-batch-processor
  namespace: payments
spec:
  jobTargetRef:
    template:
      spec:
        containers:
          - name: settlement-processor
            image: fintech/settlement-processor:v1.2.0
            env:
              - name: AWS_REGION
                value: us-east-1
            resources:
              requests:
                cpu: "2"
                memory: "4Gi"
              limits:
                cpu: "4"
                memory: "8Gi"
        restartPolicy: OnFailure
        # Give settlement jobs time to complete
        activeDeadlineSeconds: 7200  # 2 hour max

  pollingInterval: 60
  successfulJobsHistoryLimit: 10
  failedJobsHistoryLimit: 5
  maxReplicaCount: 3  # never more than 3 concurrent settlement jobs

  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789/settlement-jobs
        queueLength: "1"   # 1 job per 1 SQS message
        awsRegion: us-east-1
      authenticationRef:
        name: keda-sqs-auth
```

---

## PodDisruptionBudget During Scale-Down

Scaling down must not cause payment service unavailability. PodDisruptionBudget (PDB) prevents Kubernetes from removing too many pods at once.

```yaml
# PDB: ensure at least 2 payment-api pods are always available
# This prevents HPA/KEDA from inadvertently taking the service down during scale-in
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: payments
spec:
  minAvailable: 2        # at least 2 pods always running
  # Alternative: use maxUnavailable instead
  # maxUnavailable: 1    # at most 1 pod can be unavailable at a time
  selector:
    matchLabels:
      app: payment-api
---
# PDB for PostgreSQL — stricter: never allow more than 1 replica to be unavailable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-postgres-pdb
  namespace: payments
spec:
  minAvailable: 2        # 3-node cluster: always keep 2 up (quorum)
  selector:
    matchLabels:
      app: payment-postgres
---
# PDB for Kafka
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: payments
spec:
  maxUnavailable: 1      # one broker at a time for rolling maintenance
  selector:
    matchLabels:
      app: kafka
```

---

## Cluster Autoscaler for Node Provisioning

When HPA/KEDA scale pods beyond existing node capacity, Cluster Autoscaler provisions new nodes.

```yaml
# Cluster Autoscaler deployment (Helm values)
# helm install cluster-autoscaler autoscaler/cluster-autoscaler \
#   --namespace kube-system --values values.yaml

autoDiscovery:
  clusterName: payment-cluster
  tags:
    - k8s.io/cluster-autoscaler/enabled: "true"
    - k8s.io/cluster-autoscaler/payment-cluster: "owned"

awsRegion: us-east-1

# Scale-down settings — conservative for financial workloads
extraArgs:
  # Wait 10 minutes of underutilization before scaling down a node
  scale-down-delay-after-add: 10m
  scale-down-unneeded-time: 10m
  # Don't remove nodes that have pods with no PDB or local storage
  skip-nodes-with-local-storage: true
  skip-nodes-with-system-pods: true
  # Balance nodes across AZs
  balance-similar-node-groups: true
  # Expander strategy: least-waste (minimize wasted resources)
  expander: least-waste

# Separate node groups for payment workloads
nodeGroupAutoDiscovery:
  tags:
    - key: k8s.io/cluster-autoscaler/node-template/resources/ephemeral-storage
      value: 100Gi
```

### Karpenter as Cluster Autoscaler Alternative

```yaml
# Karpenter: faster node provisioning, more flexible than Cluster Autoscaler
# NodePool for payment workloads
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: payment-workers
spec:
  template:
    metadata:
      labels:
        workload: payment
    spec:
      requirements:
        # Use compute-optimized instances for CPU-heavy payment processing
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: [c6i, c7i]
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: [xlarge, 2xlarge, 4xlarge]
        - key: topology.kubernetes.io/zone
          operator: In
          values: [us-east-1a, us-east-1b, us-east-1c]
        # Only On-Demand for payment processing (Spot too disruptive)
        - key: karpenter.sh/capacity-type
          operator: In
          values: [on-demand]
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: payment-node-class

  limits:
    cpu: 1000     # max 1000 vCPUs in this node pool
    memory: 2000Gi

  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 10m  # wait 10 minutes before consolidating
```

---

## Scaling for Payment Spike Events

Black Friday, Cyber Monday, and payroll runs require proactive scaling.

```yaml
# KEDA CronTrigger: pre-scale before Black Friday
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: payment-api-scheduled-scaler
  namespace: payments
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  minReplicaCount: 3
  maxReplicaCount: 100

  triggers:
    # Normal scaling based on CPU
    - type: cpu
      metricType: Utilization
      metadata:
        value: "60"

    # Pre-scale for Black Friday: 2024-11-29 00:00 UTC → 20 pods minimum
    - type: cron
      metadata:
        timezone: UTC
        start: "0 0 29 11 *"   # Nov 29 00:00 UTC
        end:   "0 0 30 11 *"   # Nov 30 00:00 UTC
        desiredReplicas: "20"

    # Pre-scale for payroll Friday (last Friday of month) morning rush
    # Note: KEDA cron doesn't support complex schedules — use multiple triggers
    - type: cron
      metadata:
        timezone: UTC
        start: "0 6 * * 5"    # Every Friday 06:00 UTC
        end:   "0 10 * * 5"   # Every Friday 10:00 UTC
        desiredReplicas: "10"
```

---

## Monitoring Auto-Scaling

```yaml
# Grafana dashboard queries for auto-scaling observability

# HPA desired vs current replicas
kube_horizontalpodautoscaler_status_desired_replicas{namespace="payments"}
kube_horizontalpodautoscaler_status_current_replicas{namespace="payments"}

# KEDA scaler metrics
keda_scaler_metrics_value{namespace="payments",scaledObject="payment-processor-scaler"}
keda_scaler_active{namespace="payments"}

# Node count over time (Cluster Autoscaler effectiveness)
count(kube_node_status_condition{condition="Ready",status="true"})

# Pod startup time (how fast are we scaling?)
histogram_quantile(0.99, rate(kubelet_pod_start_duration_seconds_bucket[5m]))

# Scaling events (alerts when scale-up takes too long)
increase(kube_horizontalpodautoscaler_status_condition{condition="ScalingActive",status="True"}[5m])
```

```yaml
# Alert: payment API not scaling fast enough during spike
groups:
  - name: payment.scaling
    rules:
      - alert: PaymentAPIScalingBehind
        expr: |
          kube_horizontalpodautoscaler_status_desired_replicas{
            namespace="payments",
            horizontalpodautoscaler="payment-api-hpa"
          }
          >
          kube_horizontalpodautoscaler_status_current_replicas{
            namespace="payments",
            horizontalpodautoscaler="payment-api-hpa"
          } * 1.5
        for: 3m
        labels:
          severity: warning
          team: payments-platform
        annotations:
          summary: "Payment API HPA desired replicas exceeds current by 50% for 3m — scaling behind demand"
```

---

## Key Takeaways for Senior Engineers

1. **HPA scale-up must be faster than scale-down** — payment spikes are sudden. Configure `stabilizationWindowSeconds: 15-30` for scale-up and `300-600` for scale-down. Conservative scale-down prevents thrashing during volatile traffic.

2. **KEDA is the right tool for Kafka consumers** — HPA on CPU does not correlate with Kafka consumer lag. A consumer that is waiting for messages has 0% CPU but needs pods ready to handle the surge. KEDA's lag-based scaling solves this correctly.

3. **Scale-to-zero is free money for batch workloads** — settlement processors, DLQ processors, and batch enrichment jobs have no work for most of the day. KEDA scale-to-zero eliminates cost during idle periods entirely.

4. **PodDisruptionBudget is not optional** — without PDB, cluster maintenance, node drains, and aggressive scale-in can remove all pods of a service simultaneously. Set `minAvailable: 2` for any customer-facing payment service.

5. **VPA in Off mode first** — never apply VPA Auto mode to production payment databases or stateful services without first running in Off mode for at least one week to understand the recommendation range. Live CPU/memory changes to PostgreSQL can cause restart.

6. **Pre-scale for known events** — KEDA CronTrigger lets you pre-scale before Black Friday, payroll runs, or market open. Reactive scaling during the spike itself adds 2-3 minutes of latency (pod startup + JVM warmup). Pre-scaling eliminates this.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "An HPA is configured with targetCPUUtilizationPercentage: 60 and the payment-api has CPU requests of 500m per pod. At 3 replicas, the observed CPU utilisation is 85%. How many replicas does the HPA calculate?",
      "options": [
        "3 replicas — HPA only scales up when utilisation exceeds 100%",
        "ceil(3 × 85/60) = ceil(4.25) = 5 replicas",
        "ceil(3 × 60/85) = ceil(2.12) = 3 replicas (no change)",
        "6 replicas — HPA doubles the replica count when utilisation exceeds 1.5x the target"
      ],
      "correct": 1,
      "explanation": "The HPA scaling formula is: desiredReplicas = ceil(currentReplicas × currentMetricValue / desiredMetricValue). With 3 replicas, currentMetric=85%, desiredMetric=60%: desiredReplicas = ceil(3 × 85/60) = ceil(4.25) = 5. The HPA scales up to 5 replicas to bring average utilisation down to approximately 51% (3×85/5), which is below the 60% target. The scale-up happens within the HPA's default stabilisation window (0 seconds for scale-up), subject to the maxReplicas ceiling."
    },
    {
      "text": "KEDA is configured with a Kafka trigger monitoring consumer lag for the payment-processor consumer group, with lagThreshold=1000. The current lag is 8,500 messages. The KEDA ScaledObject has minReplicaCount=1 and maxReplicaCount=10. How many replicas does KEDA target?",
      "options": [
        "1 replica — KEDA only scales when lag exceeds maxReplicaCount × lagThreshold",
        "ceil(8500 / 1000) = 9 replicas, capped at maxReplicaCount=10",
        "10 replicas — any lag above lagThreshold triggers scale-out to maximum",
        "ceil(8500 / 1000) = 9 replicas, but KEDA waits for the full stabilisation window before scaling"
      ],
      "correct": 1,
      "explanation": "KEDA calculates desired replicas as ceil(currentLag / lagThreshold): ceil(8500 / 1000) = ceil(8.5) = 9. This is within the maxReplicaCount=10 ceiling, so 9 replicas are targeted. KEDA passes this calculation to the underlying HPA, which applies its own stabilisation windows (scaleUp and scaleDown). The 9 replicas each process approximately 944 messages from the lag, bringing it toward zero. If lag were 10,500, the calculated result would be 11, capped at maxReplicaCount=10."
    },
    {
      "text": "A payment-api Deployment has a PodDisruptionBudget with minAvailable: 2 and currently runs 3 replicas. A node drain operation is initiated. What is the behaviour?",
      "options": [
        "The node drain evicts all pods immediately — PDB does not apply to node drain operations",
        "The node drain evicts one pod at a time, waiting for it to be rescheduled before evicting the next. With minAvailable=2, only 1 pod can be disrupted at a time, ensuring at least 2 replicas remain available throughout the drain",
        "The node drain fails immediately because PDB requires a minimum of 3 available pods",
        "PDB blocks the drain indefinitely until an operator manually approves each eviction"
      ],
      "correct": 1,
      "explanation": "PodDisruptionBudget with minAvailable: 2 means the drain (kubectl drain uses the Eviction API) can only evict pods when at least 2 replicas are running. With 3 replicas, 1 can be evicted (3 - 1 = 2 remaining, which meets minAvailable). The drain evicts the pod, waits for a replacement to be scheduled and become Ready, then evicts the next. If the replacement is not scheduled (e.g., resource constraints), the drain waits indefinitely. This is the correct behaviour — PDB protects against simultaneous pod removal during maintenance events."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Autoscaling Configuration for a Payment Processing Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    "Configure HPA v2 for payment-api with: scale-up behaviour (100% increase per 30s, stabilisationWindow=0), scale-down behaviour (10% decrease per 60s, stabilisationWindow=300s), minReplicas=3, maxReplicas=20, and two metrics: CPU targetUtilization=60% and a custom Prometheus metric http_requests_per_second with target averageValue=1000. Test by generating load with k6 and verifying scale-up triggers within 60 seconds of threshold breach.",
    "Deploy KEDA with a ScaledObject for a payment-processor consuming from a Kafka topic. Configure the Kafka trigger with lagThreshold=500, minReplicaCount=0 (scale-to-zero when no lag), maxReplicaCount=15, and pollingInterval=10s. Publish a burst of 10,000 messages to the topic and monitor the scaling behaviour: verify the processor scales from 0 to the calculated replica count within the pollingInterval, processes all messages, and scales back to 0.",
    "Create a PodDisruptionBudget for payment-api with minAvailable: 2. Simulate a node drain (kubectl drain --ignore-daemonsets) and observe the drain rate. Verify that at no point during the drain do fewer than 2 payment-api pods have Ready status. Add a readinessGate to the pod to introduce a 30-second readiness delay and repeat the drain — verify KEDA respects the PDB by waiting for readiness before evicting the next pod.",
    "Implement a KEDA CronTrigger pre-scaling schedule: scale payment-api to 15 replicas at 09:55 (5 minutes before London market open at 10:00) and return to normal scaling at 10:30. Combine this with a Kafka lag trigger using KEDA's multiple-trigger mode. Document the reasoning: at market open, reactive HPA scaling (2-3 min pod startup + JVM warmup) would cause SLA breaches — pre-scaling ensures capacity is ready before the spike arrives."
  ]
}
-->
