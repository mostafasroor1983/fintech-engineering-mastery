---
id: track-10-lesson-09
title: "التوسع التلقائي — HPA وVPA وKEDA للأحمال المالية"
slug: auto-scaling
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [HPA, VPA, KEDA, auto-scaling, event-driven-scaling]
prerequisites: []
---

# التوسع التلقائي — HPA، وVPA، وKEDA للأحمال المالية

> [!NOTE]
> أحجام المدفوعات متقلبة بطبيعتها. فالجمعة السوداء تجلب 10 أضعاف الحمل المعتاد. ودورات صرف الرواتب تسبب ذروات كل ساعة. وافتتاح السوق وإغلاقه ينشئان دفقات بالملي ثانية. والتخصيص الثابت للموارد إما يفرط في التوفير (فيهدر المال) أو يقصّر فيه (فيسبب ارتفاعات في الزمن وإخفاقات في المدفوعات). ويتيح التوسع التلقائي في Kubernetes — ‏HPA، وVPA، وKEDA — لمنصتك التكيف مع هذه الأنماط تلقائيًا.

## خريطة التوسع التلقائي

```
Three complementary auto-scalers:

  HPA (Horizontal Pod Autoscaler):
    What: Scales pod COUNT based on metrics
    When: Load is variable and stateless scaling works
    Metrics: CPU, memory, custom (Prometheus), external (Kafka lag)

  VPA (Vertical Pod Autoscaler):
    What: Adjusts pod RESOURCE REQUESTS (CPU/memory) per pod
    When: You don't know the right resource requests (right-sizing)
    Modes: Off (recommendation only), Initial (set at pod creation),
           Recreate/Auto (evicts pods to apply new values),
           InPlaceOrRecreate (newer: resizes running pods in place
           where the cluster supports it)

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

## ‏HPA: التوسع حسب المعالج والذاكرة

### ‏HPA أساسي قائم على المعالج

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

    # Memory as a scaling signal is risky for JVM services: the heap grows
    # and is rarely returned to the OS, so memory utilisation stays high
    # and the HPA scales up but never back down. Use it only for services
    # whose memory really follows load.
    # - type: Resource
    #   resource:
    #     name: memory
    #     target:
    #       type: Utilization
    #       averageUtilization: 70

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

### ‏Deployment بطلبات موارد صحيحة

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
              sleep:              # native sleep action (Kubernetes 1.30+)
                seconds: 10

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

## ‏HPA بمقاييس مخصصة: Prometheus Adapter

استخدام المعالج مؤشر ضعيف لحمل واجهة الدفع. ومعدل الطلبات وعمق الطابور إشارتان أفضل.

### تثبيت Prometheus Adapter

```bash
# Install Prometheus Adapter to expose Prometheus metrics to HPA
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus.monitoring.svc.cluster.local \
  --set prometheus.port=9090
```

### ‏ConfigMap لـ Prometheus Adapter

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

      # Payment processing queue depth (namespace-level metric: use it in the
      # HPA as an Object/External metric, not as a per-pod "Pods" metric)
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

### ‏HPA باستخدام مقاييس مخصصة

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

## ‏VPA: تحجيم مناسب لأحمال الدفع

يراقب VPA استخدام الموارد الفعلي عبر الزمن ويوصي بطلبات موارد أفضل (أو يطبقها). وهذا حاسم لخدمات الدفع حيث الإفراط في التوفير مكلف والتقصير فيه يسبب زمنًا مرتفعًا.

### ‏VPA بوضع التوصية

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

### ‏VPA بوضع Initial

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

### لا يمكن تشغيل VPA مع HPA على المورد نفسه

```
Important constraint:

  VPA and HPA cannot both manage the same resource on the same deployment.
  - If HPA manages CPU: VPA must use controlledResources: [memory]
  - If HPA manages memory: VPA must use controlledResources: [cpu]
  - KEDA creates an HPA too: if its triggers are event-based (Kafka lag,
    queue length) and not cpu/memory, VPA can manage both CPU and memory

  Recommended pattern for payment services:
    HPA: manages pod count (scaling out)
    VPA: manages CPU/memory requests (right-sizing, Off mode → apply manually)

  Anti-pattern:
    HPA on CPU + VPA on CPU = fighting over the same signal
```

---

## ‏KEDA: توسع مدفوع بالأحداث لمعالجة المدفوعات

‏KEDA أقوى أداة توسع للمنصات المالية لأن معالجة المدفوعات مدفوعة بالأحداث أساسًا — بعمق طوابير الرسائل، أو تأخر مستهلكي Kafka، أو جداول cron.

### تثبيت KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set metricsServer.replicaCount=2  # HA for metrics server
```

### ‏ScaledObject في KEDA: تأخر مستهلك Kafka

```yaml
# Scale payment processors based on Kafka consumer lag
# When lag = 0: scale to 0 pods (save cost -- but the first payment after an
#   idle period waits for a cold start; keep minReplicaCount >= 1 where
#   latency matters)
# When lag grows: scale up to handle the backlog
# Ceiling: one consumer per PARTITION. KEDA by default does not scale
# beyond the topic's partition count (extra consumers would sit idle), so
# maxReplicaCount 50 only helps with >= 50 partitions.
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
      # Credentials come from a TriggerAuthentication (Secret reference),
      # never inline in the ScaledObject
      authenticationRef:
        name: kafka-scaler-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-scaler-auth
  namespace: payments
spec:
  secretTargetRef:
    - parameter: sasl
      name: kafka-credentials
      key: sasl            # e.g. "scram_sha512"
    - parameter: username
      name: kafka-credentials
      key: username
    - parameter: password
      name: kafka-credentials
      key: password
    - parameter: tls
      name: kafka-credentials
      key: tls             # "enable"
```

### ‏ScaledObject في KEDA: عمق طابور SQS

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

### ‏ScaledJob في KEDA للتسوية الدفعية

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

## ‏PodDisruptionBudget أثناء التصغير

يجب ألا يسبب التصغير عدم توفر خدمة الدفع. ويحدّ PodDisruptionBudget ‏(PDB) عدد الـ pods التي يمكن لعمليات *الطرد (eviction)* إزالتها دفعة واحدة — تفريغ العقد ودمج العقد الذي يتبع التصغير. أما عدد النسخ التي يبقيها HPA فيتحكم فيه `minReplicas`، لا الـ PDB.

```yaml
# PDB: ensure at least 2 payment-api pods stay available during VOLUNTARY
# disruptions -- node drains, Cluster Autoscaler / Karpenter node removal,
# upgrades. (HPA/KEDA scale-in does NOT go through the Eviction API, so a
# PDB does not limit it -- minReplicas does.)
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

## ‏Cluster Autoscaler لتوفير العقد

حين يوسّع HPA/KEDA الـ pods فوق سعة العقد الموجودة، يوفّر Cluster Autoscaler عقدًا جديدة.

```yaml
# Cluster Autoscaler deployment (Helm values)
# helm install cluster-autoscaler autoscaler/cluster-autoscaler \
#   --namespace kube-system --values values.yaml

autoDiscovery:
  clusterName: payment-cluster
  # node groups (ASGs) carrying these tags are managed
  tags:
    - k8s.io/cluster-autoscaler/enabled
    - k8s.io/cluster-autoscaler/payment-cluster

awsRegion: us-east-1

# Scale-down settings — conservative for financial workloads
extraArgs:
  # Wait 10 minutes after a scale-up, and 10 minutes of underutilisation,
  # before removing a node
  scale-down-delay-after-add: 10m
  scale-down-unneeded-time: 10m
  # Don't remove nodes running pods with local storage (emptyDir/hostPath)
  # or kube-system pods
  skip-nodes-with-local-storage: true
  skip-nodes-with-system-pods: true
  # Balance nodes across AZs
  balance-similar-node-groups: true
  # Expander strategy: least-waste (minimize wasted resources)
  expander: least-waste
# Use separate node groups (ASGs) for payment workloads, each tagged for
# auto-discovery, with taints/labels matching the payment pods
```

### ‏Karpenter كبديل لـ Cluster Autoscaler

```yaml
# Karpenter: faster node provisioning, more flexible than Cluster Autoscaler
# NodePool for payment workloads (Karpenter v1 API; older guides show v1beta1)
apiVersion: karpenter.sh/v1
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
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: payment-node-class

  limits:
    cpu: 1000     # max 1000 vCPUs in this node pool
    memory: 2000Gi

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 10m  # wait 10 minutes before consolidating
    budgets:
      - nodes: "10%"       # never disrupt more than 10% of nodes at once
# Consolidation evicts pods (PDBs are respected); pods that must not be
# moved can carry the annotation karpenter.sh/do-not-disrupt: "true"
```

---

## التوسع لأحداث ذروة المدفوعات

تتطلب الجمعة السوداء، والاثنين الإلكتروني، ودورات الرواتب توسعًا استباقيًا.

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

    # Pre-scale for Black Friday 2026 (Nov 27) → 20 pods minimum.
    # A cron date repeats EVERY year on that day, while Black Friday moves:
    # update the date each year (e.g. from a GitOps change ticket)
    - type: cron
      metadata:
        timezone: UTC
        start: "0 0 27 11 *"   # Nov 27 00:00 UTC
        end:   "0 0 28 11 *"   # Nov 28 00:00 UTC
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

## مراقبة التوسع التلقائي

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

## الخلاصات الأساسية للمهندسين الكبار

1. **يجب أن يكون توسيع HPA أسرع من تصغيره** — فذروات المدفوعات مفاجئة. اضبط `stabilizationWindowSeconds: 15-30` للتوسيع و`300-600` للتصغير. والتصغير المتحفظ يمنع التذبذب أثناء الحركة المتقلبة.

2. **‏KEDA الأداة الصحيحة لمستهلكي Kafka** — لا يتتبع المعالج تأخر مستهلكي Kafka جيدًا: فمستهلك عالق في استدعاء بطيء لخدمة لاحقة يُظهر معالجًا منخفضًا بينما يكبر التراكم. ويتفاعل التوسع القائم على التأخر في KEDA مع التراكم نفسه — حتى مستهلك واحد لكل قسم.

3. **التصغير إلى الصفر مال مجاني للأحمال الدفعية** — فمعالجات التسوية، ومعالجات DLQ، ومهام الإثراء الدفعية لا عمل لها أغلب اليوم. والتصغير إلى الصفر في KEDA يلغي التكلفة كليًا أثناء فترات الخمول.

4. **‏PodDisruptionBudget ليس اختياريًا** — فدون PDB، قد تطرد صيانة العنقود، وتفريغ العقد، ودمج العقد كل pods خدمة في الوقت نفسه. اضبط `minAvailable: 2` (أو `maxUnavailable: 1`) لأي خدمة دفع مواجهة للعملاء. ويحدّ `minReplicas` تصغير HPA، لا الـ PDB.

5. **‏VPA بوضع Off أولًا** — لا تطبق أبدًا وضع Auto في VPA على قواعد بيانات الدفع الإنتاجية أو الخدمات ذات الحالة دون تشغيله أولًا بوضع Off أسبوعًا على الأقل لفهم نطاق التوصيات. فتغييرات المعالج/الذاكرة الحية لـ PostgreSQL قد تسبب إعادة تشغيل.

6. **وسّع مسبقًا للأحداث المعروفة** — يتيح لك مُطلِق cron في KEDA التوسيع قبل الجمعة السوداء، أو دورات الرواتب، أو افتتاح السوق. والتوسع التفاعلي أثناء الذروة نفسها يضيف 2-3 دقائق من الزمن (بدء الـ pod + إحماء JVM). والتوسيع المسبق يلغي ذلك.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "‏HPA مضبوط بـ targetCPUUtilizationPercentage: 60، ولـ payment-api طلبات معالج 500m لكل pod. وعند 3 نسخ، يكون استخدام المعالج المرصود 85%. كم نسخة يحسب HPA؟",
      "options": [
        "3 نسخ — يوسّع HPA فقط حين يتجاوز الاستخدام 100%",
        "ceil(3 × 85/60) = ceil(4.25) = 5 نسخ",
        "ceil(3 × 60/85) = ceil(2.12) = 3 نسخ (بلا تغيير)",
        "6 نسخ — يضاعف HPA عدد النسخ حين يتجاوز الاستخدام 1.5 ضعف الهدف"
      ],
      "correct": 1,
      "explanation": "صيغة توسع HPA: ‏desiredReplicas = ceil(currentReplicas × currentMetricValue / desiredMetricValue). ومع 3 نسخ، وcurrentMetric=85%، وdesiredMetric=60%: ‏desiredReplicas = ceil(3 × 85/60) = ceil(4.25) = 5. فيوسّع HPA إلى 5 نسخ ليُنزل متوسط الاستخدام إلى نحو 51% ‏(3×85/5)، أي تحت هدف 60%. ويحدث التوسيع ضمن نافذة الاستقرار الافتراضية لـ HPA (0 ثانية للتوسيع)، مع مراعاة سقف maxReplicas."
    },
    {
      "text": "‏KEDA مضبوط بمُطلِق Kafka يراقب تأخر المستهلك لمجموعة payment-processor، مع lagThreshold=1000. والتأخر الحالي 8,500 رسالة. وللـ ScaledObject في KEDA ‏minReplicaCount=1 وmaxReplicaCount=10. كم نسخة يستهدف KEDA؟",
      "options": [
        "نسخة واحدة — يوسّع KEDA فقط حين يتجاوز التأخر maxReplicaCount × lagThreshold",
        "ceil(8500 / 1000) = 9 نسخ، بسقف maxReplicaCount=10",
        "10 نسخ — أي تأخر فوق lagThreshold يطلق التوسع إلى الحد الأقصى",
        "ceil(8500 / 1000) = 9 نسخ، لكن KEDA ينتظر نافذة الاستقرار الكاملة قبل التوسع"
      ],
      "correct": 1,
      "explanation": "يستهدف موسّع Kafka في KEDA ‏ceil(totalLag / lagThreshold) نسخة: ‏ceil(8500 / 1000) = ceil(8.5) = 9. وهذا ضمن سقف maxReplicaCount=10 — كما يحدّ KEDA افتراضيًا النتيجة بعدد أقسام الموضوع، فيفترض هذا وجود 9 أقسام على الأقل. ويسلّم KEDA المقياس إلى HPA الذي يديره، فيطبق نوافذ الاستقرار وسياسات التوسع الخاصة به. ولو كان التأخر 10,500، لكانت النتيجة 11، بسقف maxReplicaCount=10."
    },
    {
      "text": "لـ Deployment ‏payment-api ‏PodDisruptionBudget بـ minAvailable: 2 ويعمل حاليًا بثلاث نسخ. وبدأت عملية تفريغ عقدة. ما السلوك؟",
      "options": [
        "يطرد التفريغ كل الـ pods فورًا — لا ينطبق PDB على عمليات تفريغ العقد",
        "يطرد التفريغ pod واحدًا في كل مرة، منتظرًا إعادة جدولته قبل طرد التالي. ومع minAvailable=2، يمكن تعطيل pod واحد فقط في كل مرة، فتبقى نسختان متاحتان على الأقل طوال التفريغ",
        "يفشل التفريغ فورًا لأن PDB يتطلب 3 pods متاحة على الأقل",
        "يمنع PDB التفريغ إلى أجل غير مسمى حتى يوافق مشغّل يدويًا على كل طرد"
      ],
      "correct": 1,
      "explanation": "‏PodDisruptionBudget بـ minAvailable: 2 يعني أن الطرد (يستخدم kubectl drain واجهة Eviction) مسموح فقط إذا بقيت نسختان متاحتان على الأقل بعده. ومع 3 نسخ جاهزة، يمكن طرد واحدة. ثم يعيد التفريغ محاولة الطرد التالي حتى يُجدول الـ pod البديل ويصبح جاهزًا، فتبقى نسختان متاحتان على الأقل طوال الوقت. وإذا تعذرت جدولة البديل (مثلًا لعدم وجود سعة)، يستمر التفريغ في الانتظار. ولاحظ أن الـ PDBs تحكم عمليات الطرد — التفريغ، وإزالة العقد بالموسّع التلقائي — لا تصغير HPA."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "إعداد التوسع التلقائي لمنصة معالجة مدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    "اضبط HPA v2 لـ payment-api بـ: سلوك توسيع (زيادة 100% كل 30 ثانية، وstabilisationWindow=0)، وسلوك تصغير (نقص 10% كل 60 ثانية، وstabilisationWindow=300s)، وminReplicas=3، وmaxReplicas=20، ومقياسين: المعالج targetUtilization=60% ومقياس Prometheus مخصص http_requests_per_second بهدف averageValue=1000. واختبر بتوليد حمل بـ k6 والتحقق من انطلاق التوسيع خلال 60 ثانية من تجاوز العتبة.",
    "انشر KEDA مع ScaledObject لـ payment-processor يستهلك من موضوع Kafka بـ 12 قسمًا. واضبط مُطلِق Kafka بـ lagThreshold=500، وminReplicaCount=0 (التصغير إلى الصفر عند عدم وجود تأخر)، وmaxReplicaCount=15، وpollingInterval=10s، وبيانات اعتماد عبر TriggerAuthentication. وانشر دفقة من 10,000 رسالة وراقب التوسع: تحقق من أن المعالج يتوسع من 0 حتى عدد الأقسام (12، لا 15)، ويعالج كل الرسائل، ويعود إلى 0.",
    "أنشئ PodDisruptionBudget لـ payment-api بـ minAvailable: 2. وحاكِ تفريغ عقدة (kubectl drain --ignore-daemonsets) ولاحظ معدل التفريغ. وتحقق من أنه في أي لحظة أثناء التفريغ لا يقل عدد pods ‏payment-api ذات الحالة Ready عن 2. وأعطِ الـ pods بدءًا بطيئًا (مثل تأخير 30 ثانية قبل الجاهزية) وكرر التفريغ — وتحقق من أن التفريغ ينتظر جاهزية كل بديل قبل طرد الـ pod التالي.",
    "نفّذ جدول توسيع مسبق بـ cron في KEDA بالمنطقة الزمنية Europe/London: وسّع payment-api إلى 15 نسخة عند 07:55 (قبل 5 دقائق من افتتاح بورصة لندن عند 08:00) وعُد إلى التوسع العادي عند 08:30. واجمع هذا مع مُطلِق تأخر Kafka باستخدام المُطلِقات المتعددة في KEDA. ووثّق المنطق: عند افتتاح السوق، سيسبب توسع HPA التفاعلي (2-3 دقائق لبدء الـ pod + إحماء JVM) انتهاكات لاتفاقية مستوى الخدمة — والتوسيع المسبق يضمن جاهزية السعة قبل وصول الذروة."
  ]
}
-->
