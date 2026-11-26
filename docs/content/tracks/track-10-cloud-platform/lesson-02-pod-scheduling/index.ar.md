---
id: track-10-lesson-02
title: "جدولة الـ Pods — التقارب والتلطيخ (Taints) وطلبات الموارد"
slug: pod-scheduling
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 2
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [pod-scheduling, affinity, taint, toleration, resource-quota]
prerequisites: [track-10-lesson-01]
---

# جدولة الـ Pods — التقارب، والـ Taints، وطلبات الموارد

> [!NOTE]
> طلبات الموارد المضبوطة خطأً هي السبب الأول لحوادث "الجار المزعج" في عناقيد Kubernetes المالية متعددة المستأجرين. وضبط الجدولة بشكل صحيح يبقي زمن معالجة المدفوعات متوقعًا تحت حمل الذروة ويمنع مهمة دفعية منفلتة من تجويع خدمة التسوية.

## لماذا تهم الجدولة في التقنية المالية

في منصة مالية تقليدية، كانت فرق البنية التحتية تقسّم الخوادم الفعلية بحدود صارمة. وفي Kubernetes يفعل المُجدول ذلك ديناميكيًا — لكن فقط إذا أعطيته التلميحات الصحيحة. ودونها، ينشر المُجدول الـ pods عشوائيًا وقد ينتهي بك الأمر إلى:

- ‏pods مدفوعات فورية تتشارك عقدة مع مهمة تسوية دفعية نهمة للذاكرة
- كل نسخ خدمة حرجة في منطقة توفر واحدة، فتخالف اتفاقية مستوى الخدمة 99.99%
- عقد عند 90% من المعالج دائمًا بلا هامش للدفقات أثناء تسوية نهاية اليوم

يغطي هذا الدرس كل رافعة يكشفها مُجدول Kubernetes، بأمثلة ملموسة من أحمال معالجة المدفوعات، وحساب المخاطر، والتسوية الدفعية.

---

## 1. طلبات الموارد وحدودها

### الفرق المهم

**الطلب (request)** مقدار المعالج/الذاكرة الذي يستخدمه المُجدول لإيجاد عقدة. و**الحد (limit)** أقصى ما يُسمح للحاوية باستخدامه وقت التشغيل. ويخدمان أغراضًا مختلفة ويجب ضبطهما باستقلال.

| الإعداد | الأثر |
|---|---|
| `requests.cpu` | يستخدمه المُجدول للتعبئة؛ وعند التنافس، يُقسم وقت المعالج بنسبة الطلبات (وزن CPU في cgroup) |
| `limits.cpu` | حصة CFS: تُخنق الحاوية بمجرد استخدامها هذا القدر في الفترة |
| `requests.memory` | حجز المُجدول؛ والـ pods التي تستخدم أكثر من طلبها أول المرشحين للطرد عند ضغط ذاكرة العقدة |
| `limits.memory` | تُقتل الحاوية بـ OOM إذا تجاوزته |

للخدمات المالية، قاعدة بداية سليمة:

```
requests.cpu    = p90–p95 of observed usage (p50 under-reserves: at peak the
                  pod competes for CPU it never reserved)
limits.cpu      = equal to the request (Guaranteed QoS, predictable), or
                  omitted to allow bursting -- a low CPU limit throttles the
                  JVM (GC, JIT threads) and shows up as latency spikes
requests.memory = limits.memory
limits.memory   = p99.9 usage + ~20% headroom (an OOM kill is fatal for
                  in-flight transactions)
```

### فئات جودة الخدمة (QoS)

يعيّن Kubernetes لكل pod فئة QoS بناءً على إعدادات الموارد:

```
Guaranteed:  requests == limits for all containers
Burstable:   requests < limits (or partial spec)
BestEffort:  no requests/limits specified
```

لخدمات الدفع، فضّل QoS **‏Guaranteed** — أو على الأقل اجعل طلب الذاكرة == حدها. فالـ pods المضمونة آخر ما يُطرد عند ضغط ذاكرة العقدة وتحصل على أدنى درجة قتل OOM. ولا تغيّر QoS ترتيب الجدولة أو الاستباق — فذلك دور PriorityClass (القسم 5). وتُبقي بعض الفرق pods الدفع Burstable عمدًا في المعالج (بلا حد للمعالج) لتجنب الخنق؛ ويبقى طلب الذاكرة == حدها في الحالتين.

### مواصفة موارد إنتاجية لخدمة دفع

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
  labels:
    app: payment-processor
    tier: critical
    compliance: pci-dss
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
        tier: critical
    spec:
      containers:
      - name: payment-processor
        image: payments-registry.internal/payment-processor:v2.4.1
        resources:
          requests:
            cpu: "500m"        # ~p95 of 30 days of measurements
            memory: "1Gi"      # == limit: no memory overcommit
          limits:
            cpu: "2000m"       # allow burst for settlement spikes (-> Burstable QoS;
                               #  set cpu limit = request for Guaranteed)
            memory: "1Gi"      # hard cap: OOM kill of the pod rather than an OOM node
        startupProbe:              # covers JVM start-up, then hands over
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          periodSeconds: 5
          failureThreshold: 30
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          periodSeconds: 10
```

### تحجيم الموارد لمهمة حساب مخاطر دفعية

للمهام الدفعية نمط مختلف — معالج مرتفع لنافذة قصيرة:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: end-of-day-risk-calc
  namespace: risk
spec:
  parallelism: 10
  completions: 100
  backoffLimit: 6
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: risk-engine
        image: risk-registry.internal/risk-engine:v1.9.3
        resources:
          requests:
            cpu: "2000m"       # needs high CPU — give scheduler accurate hint
            memory: "4Gi"      # large in-memory position set
          limits:
            cpu: "4000m"
            memory: "6Gi"
        env:
        - name: JAVA_OPTS
          # heap max ~70% of the limit: the JVM also needs metaspace,
          # thread stacks, code cache and direct buffers outside the heap
          value: "-XX:MaxRAMPercentage=70 -XX:InitialRAMPercentage=50 -XX:+UseG1GC"
```

> [!WARNING]
> لا تضبط `requests.memory` أبدًا أقل مما تستخدمه JVM فعلًا — الكومة (على الأقل `-Xms`) زائد الذاكرة خارج الكومة. فالحاوية التي تستخدم أكثر من طلبها من أوائل المطرودين حين تنقص ذاكرة العقدة، فقد تموت المهمة في منتصف الحساب. وأبقِ `-Xmx` + الذاكرة خارج الكومة تحت `limits.memory`، وإلا قتلت النواة الحاوية بـ OOM. واجعل المهام الدفعية قابلة للاستئناف من نقاط حفظ كي لا يترك pod مقتول نتيجة نصف مكتوبة في دفتر المخاطر.

---

## 2. تقارب العقد (Node Affinity)

### ‏RequiredDuringScheduling مقابل PreferredDuringScheduling

يتيح تقارب العقد حصر الـ pods في مجموعات عقد محددة بناءً على تسميات العقد.

- **‏requiredDuringSchedulingIgnoredDuringExecution**: قيد صارم. لن يُجدول الـ pod إذا لم توجد عقدة مطابقة. استخدمه لمتطلبات الامتثال (إقامة البيانات، والعتاد المخصص).
- **‏preferredDuringSchedulingIgnoredDuringExecution**: قيد مرن. يحاول المُجدول تحقيقه لكنه يرجع إلى عقد أخرى. استخدمه لتحسين التكلفة (تفضيل عقد spot).

### عقد مخصصة لـ PCI-DSS

متطلب شائع في مدفوعات البطاقات: يجب أن تعمل أحمال بيانات حاملي البطاقات على عقد مقوّاة اجتازت تدقيق معيار CIS.

```yaml
# Node labels applied by your node provisioning pipeline (Terraform/Cluster API)
# kubectl label node ip-10-0-1-100.ec2.internal compliance=pci-dss node-tier=dedicated-payments

apiVersion: apps/v1
kind: Deployment
metadata:
  name: card-tokenization-service
  namespace: payments
spec:
  replicas: 4
  selector:
    matchLabels:
      app: card-tokenization-service
  template:
    metadata:
      labels:
        app: card-tokenization-service
    spec:
      affinity:
        nodeAffinity:
          # HARD: must run on PCI-compliant nodes
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: compliance
                operator: In
                values:
                - pci-dss
              - key: node-tier
                operator: In
                values:
                - dedicated-payments
          # SOFT: prefer nodes with NVMe storage for low-latency token lookup
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 50
            preference:
              matchExpressions:
              - key: storage-type
                operator: In
                values:
                - nvme
      containers:
      - name: card-tokenization-service
        image: payments-registry.internal/card-tokenization:v3.1.0
        resources:
          requests:
            cpu: "1000m"
            memory: "2Gi"
          limits:
            cpu: "2000m"
            memory: "2Gi"
```

---

## 3. ‏Pod Anti-Affinity للتوفر العالي

### توزيع خدمات الدفع عبر المناطق

لاتفاقية توفر 99.99% (نحو 52 دقيقة توقف سنويًا)، يجب ألا يُسقط فشل منطقة توفر واحدة خدمة الدفع. ويمكن لـ pod anti-affinity التعبير عن ذلك:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-gateway
  namespace: payments
spec:
  replicas: 6   # 2 pods per zone in a 3-zone cluster
  selector:
    matchLabels:
      app: payment-gateway
  template:
    metadata:
      labels:
        app: payment-gateway
    spec:
      affinity:
        podAntiAffinity:
          # HARD: never put 2 replicas on the same node
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - payment-gateway
            topologyKey: kubernetes.io/hostname
          # SOFT: spread across availability zones
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - payment-gateway
              topologyKey: topology.kubernetes.io/zone
      containers:
      - name: payment-gateway
        image: payments-registry.internal/payment-gateway:v5.2.3
        resources:
          requests:
            cpu: "500m"
            memory: "1Gi"
          limits:
            cpu: "2000m"
            memory: "1Gi"
```

> [!NOTE]
> استخدام `requiredDuringScheduling` لـ anti-affinity على مستوى اسم المضيف و`preferredDuringScheduling` للمنطقة مقصود: فالقاعدة الصارمة على مستوى العقدة تضمن ألا تحمل عقدة نسختين، والقاعدة المرنة للمنطقة لن تمنع الجدولة إذا استُنزفت منطقة. وثمن القاعدة الصارمة: تحتاج عقدًا مؤهلة بعدد الـ pods على الأقل — بما فيها pods الزيادة أثناء التحديث المتدرج وتوسع HPA — وإلا بقيت الـ pods الجديدة Pending. وقيود توزيع الطوبولوجيا (القسم 6) عادةً الأداة الأفضل للمستويين.

### تجميع الخدمات معًا لتقليل الزمن

العكس مفيد أيضًا. يجب أن تستجيب خدمة كشف الاحتيال خلال 50ms لبوابة الدفع:

```yaml
# Fraud detection service — prefer same node as payment gateway for low latency
affinity:
  podAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 80
      podAffinityTerm:
        labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - payment-gateway
        topologyKey: kubernetes.io/hostname
```

---

## 4. الـ Taints والـ Tolerations

### عقد مخصصة لأحمال العمل الحرجة

تنفّر الـ taints الـ pods ما لم يتسامح الـ pod صراحة مع الـ taint. وهذا يحجز مجموعات العقد حصريًا لفئات أحمال عمل محددة.

#### إعداد العقد (يطبقه Terraform/Cluster API)

```bash
# Taint the dedicated payment nodes
kubectl taint nodes -l node-tier=dedicated-payments \
  dedicated=payments:NoSchedule

# Taint GPU nodes for ML risk models
kubectl taint nodes -l hardware=gpu \
  nvidia.com/gpu=present:NoSchedule
```

#### التسامح في خدمة الدفع

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
    spec:
      tolerations:
      # Tolerate the dedicated payments taint
      - key: "dedicated"
        operator: "Equal"
        value: "payments"
        effect: "NoSchedule"
      # NotReady / unreachable tolerations: Kubernetes adds these with
      # 300s automatically. Setting them explicitly lets you SHORTEN the
      # wait -- e.g. 30-60s, so pods on a dead node move faster
      - key: "node.kubernetes.io/not-ready"
        operator: "Exists"
        effect: "NoExecute"
        tolerationSeconds: 60
      # Node unreachable (e.g. network partition)
      - key: "node.kubernetes.io/unreachable"
        operator: "Exists"
        effect: "NoExecute"
        tolerationSeconds: 60
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-tier
                operator: In
                values:
                - dedicated-payments
      containers:
      - name: payment-processor
        image: payments-registry.internal/payment-processor:v2.4.1
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2000m"
            memory: "1Gi"
```

### مرجع آثار الـ Taint

| الأثر | السلوك |
|---|---|
| `NoSchedule` | لن تُجدول pods جديدة (الموجودة لا تتأثر) |
| `PreferNoSchedule` | يتجنب المُجدول العقدة لكنه يستخدمها عند الضرورة |
| `NoExecute` | تُطرد الـ pods الموجودة؛ ولن تُجدول pods جديدة |

لعقد الدفع المخصصة، استخدم `NoSchedule`. أما `NoExecute` فتطرد الـ pods العاملة، فاستخدمها بحذر — إذ يطبقها Kubernetes نفسه تلقائيًا لمشكلات العقد مثل `not-ready` و`unreachable` (أما حالات الضغط مثل ضغط الذاكرة أو القرص فتحصل على taints من نوع `NoSchedule`).

ولاحظ أن الـ taint يُبعد الـ pods *الأخرى* فقط عن العقد المخصصة؛ ولا يجذب pods الدفع إليها. ولهذا يجمع المثال بين التسامح وتقارب العقد.

---

## 5. ‏PriorityClass لأحمال الدفع الحرجة

### الاستباق: ضمان حصول الـ Pods الحرجة على الموارد دائمًا

حين يمتلئ العنقود، يمكن لـ pod ذي أولوية أعلى طرد pods ذات أولوية أدنى لإفساح المجال.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: payment-critical
value: 1000000
globalDefault: false
description: "Real-time payment processing — highest user priority, preempts lower classes"
preemptionPolicy: PreemptLowerPriority
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: settlement-high
value: 900000
globalDefault: false
description: "Settlement and reconciliation — high priority, may preempt batch"
preemptionPolicy: PreemptLowerPriority
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-normal
value: 500000
globalDefault: true      # pods without priorityClassName get this one
description: "Batch jobs — default priority, preemptable"
preemptionPolicy: PreemptLowerPriority
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: dev-low
value: 100000
globalDefault: false
description: "Development/staging workloads — lowest priority"
preemptionPolicy: Never
# Values above 1,000,000,000 are reserved for system classes such as
# system-cluster-critical -- keep application classes below that
```

### تطبيق PriorityClass على الـ Deployments

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
    spec:
      priorityClassName: payment-critical
      containers:
      - name: payment-processor
        image: payments-registry.internal/payment-processor:v2.4.1
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2000m"
            memory: "1Gi"
```

> [!WARNING]
> يسبب الاستباق انقطاعات خدمة قصيرة للـ pod المطرود. ولمهام حساب المخاطر الدفعية ذات نقاط الحفظ طويلة الأمد، اجمع PriorityClass مع معالجة إيقاف لطيف كي تحفظ المهمة المُستبقة حالتها قبل الخروج. ويُحترم PodDisruptionBudget على الضحايا بأفضل جهد فقط أثناء الاستباق.

---

## 6. قيود توزيع الطوبولوجيا

قيود توزيع الطوبولوجيا البديل الحديث الأكثر تعبيرًا عن توزيع المناطق بـ pod anti-affinity. فتتيح لك تحديد مدى تساوي توزيع الـ pods بالضبط.

### توزيع متساوٍ على المناطق بـ MaxSkew

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fraud-detection-api
  namespace: fraud
spec:
  replicas: 9   # 3 zones x 3 pods
  selector:
    matchLabels:
      app: fraud-detection-api
  template:
    metadata:
      labels:
        app: fraud-detection-api
    spec:
      topologySpreadConstraints:
      # Spread evenly across zones — max 1 pod difference between zones
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: fraud-detection-api
        minDomains: 3
      # Also spread across nodes within a zone
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: fraud-detection-api
      containers:
      - name: fraud-detection-api
        image: fraud-registry.internal/fraud-api:v4.1.2
        resources:
          requests:
            cpu: "1000m"
            memory: "2Gi"
          limits:
            cpu: "2000m"
            memory: "2Gi"
```

### خيارات WhenUnsatisfiable

| القيمة | السلوك |
|---|---|
| `DoNotSchedule` | يبقى الـ pod في Pending حتى يمكن تحقيق التوزيع |
| `ScheduleAnyway` | يُجدول الـ pod على أي حال؛ ويقلل المُجدول الانحراف |

لخدمات الدفع ذات متطلبات التوفر العالي الصارمة، استخدم `DoNotSchedule` لتوزيع المناطق.

---

## 7. توصيات Vertical Pod Autoscaler ‏(VPA)

يمكن لـ VPA تحجيم طلبات الموارد تلقائيًا. وفي المنصات المالية، شغّل VPA بوضع **Off** أو **Initial** — لا `Auto` أبدًا على pods الدفع الحرجة — لتجنب إعادة تشغيل الـ pods المُخلّة أثناء معالجة المعاملات الحية. ولا تدع VPA يتصرف في معالج/ذاكرة Deployment يوسّعه HPA على المقاييس نفسها: فالمتحكمان يتصارعان.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-processor-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-processor
  updatePolicy:
    updateMode: "Off"   # generate recommendations only; do not auto-apply
  resourcePolicy:
    containerPolicies:
    - containerName: payment-processor
      minAllowed:
        cpu: 200m
        memory: 256Mi
      maxAllowed:
        cpu: 4000m
        memory: 4Gi
      controlledResources: ["cpu", "memory"]
      controlledValues: RequestsAndLimits
```

#### قراءة توصيات VPA

```bash
kubectl describe vpa payment-processor-vpa -n payments
# Output:
#   Recommendation:
#     Container Recommendations:
#       Container Name:  payment-processor
#         Lower Bound:   cpu: 300m  memory: 420Mi
#         Target:        cpu: 480m  memory: 510Mi
#         Upper Bound:   cpu: 1200m memory: 870Mi
```

طبّق توصيات VPA خلال نوافذ الصيانة المخططة، لا تلقائيًا.

---

## 8. ‏ResourceQuota لكل مساحة أسماء

تمنع حصص الموارد فريقًا واحدًا من احتكار موارد العنقود.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-namespace-quota
  namespace: payments
spec:
  hard:
    requests.cpu: "50"
    limits.cpu: "100"
    requests.memory: 100Gi
    limits.memory: 200Gi
    pods: "200"
    services: "50"
    persistentvolumeclaims: "30"
    requests.storage: 2Ti
```

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: payments-default-limits
  namespace: payments
spec:
  limits:
  - type: Container
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "8"
      memory: "16Gi"
    min:
      cpu: "50m"
      memory: "64Mi"
  - type: Pod
    max:
      cpu: "16"
      memory: "32Gi"
  - type: PersistentVolumeClaim
    max:
      storage: 500Gi
    min:
      storage: 1Gi
```

---

## 9. مثال إنتاجي كامل: مساحة أسماء معالجة المدفوعات

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    environment: production
    compliance: pci-dss
    team: payments-platform
    cost-center: "CC-PAYMENTS-001"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
spec:
  replicas: 9
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0       # zero-downtime for financial services
      maxSurge: 3
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
        tier: critical
        compliance: pci-dss
    spec:
      priorityClassName: payment-critical
      tolerations:
      - key: "dedicated"
        operator: "Equal"
        value: "payments"
        effect: "NoSchedule"
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: compliance
                operator: In
                values: [pci-dss]
      # Spread: zones strictly balanced, nodes as evenly as possible.
      # (A required hostname anti-affinity would need 12 PCI nodes during
      # a rollout: 9 replicas + 3 surge pods)
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-processor
        minDomains: 3
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: payment-processor
      terminationGracePeriodSeconds: 60
      containers:
      - name: payment-processor
        image: payments-registry.internal/payment-processor:v2.4.1
        ports:
        - containerPort: 8080
          name: http
        resources:
          requests:
            cpu: "1000m"
            memory: "1Gi"
          limits:
            cpu: "1000m"      # requests == limits -> Guaranteed QoS
            memory: "1Gi"
        env:
        - name: JAVA_OPTS
          # heap ~70% of the 1Gi limit; the rest for metaspace, threads,
          # code cache and buffers (a fixed -Xmx800m in 1Gi risks OOM kills)
          value: "-XX:MaxRAMPercentage=70 -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
        startupProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          periodSeconds: 5
          failureThreshold: 30
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          periodSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          periodSeconds: 10
          failureThreshold: 3
        lifecycle:
          preStop:
            sleep:              # native sleep action, Kubernetes 1.30+
              seconds: 15
```

---

## 10. التحقق من إعداد الجدولة

```bash
# Verify pods are spread across zones
kubectl get pods -n payments -o wide \
  --selector=app=payment-processor

# Check which nodes are in which zones
kubectl get nodes --label-columns=topology.kubernetes.io/zone

# Find nodes running more than one replica (prints nothing if all differ)
kubectl get pods -n payments -l app=payment-processor \
  -o custom-columns=NODE:.spec.nodeName --no-headers | sort | uniq -d

# If a pod is stuck Pending, describe shows scheduling failure reason
kubectl describe pod payment-processor-xxx -n payments | grep -A 20 "Events:"

# Verify ResourceQuota consumption
kubectl describe resourcequota payments-namespace-quota -n payments
```

---

## قائمة تحقق الإنتاج

- [ ] لكل pods الدفع الحرجة `requests` و`limits` صريحة، وطلب الذاكرة == حدها (QoS ‏Guaranteed حيث يكون خنق المعالج مقبولًا)
- [ ] كومة JVM محجّمة كنسبة من الحد (`MaxRAMPercentage`)، مع ترك مجال للذاكرة خارج الكومة
- [ ] النسخ موزعة عبر العقد (توزيع الطوبولوجيا أو anti-affinity) — مع عقد كافية للزيادة والتوسع
- [ ] قيود توزيع الطوبولوجيا تفرض التوزيع عبر المناطق
- [ ] للأحمال الحرجة `PriorityClass: payment-critical`
- [ ] عقد PCI-DSS المخصصة عليها taints؛ ولـ pods الدفع tolerations مطابقة
- [ ] ‏VPA يعمل بوضع `Off` — مع مراجعة التوصيات ربع سنويًا
- [ ] ‏ResourceQuota مضبوطة لكل مساحة أسماء؛ وتنبيه عند 80% من الاستخدام
- [ ] ‏LimitRange يوفر قيمًا افتراضية آمنة للـ pods بلا مواصفات موارد صريحة
- [ ] ‏`terminationGracePeriodSeconds` طويل بما يكفي لتصريف المعاملات الجارية
- [ ] ‏`maxUnavailable: 0` في استراتيجية التحديث المتدرج لنشر بلا توقف

---

## الملخص

جدولة Kubernetes عقد بين تطبيقك والعنقود. وللخدمات المالية يجب أن يكون هذا العقد صريحًا: طلبات موارد تعكس الاستخدام الحقيقي تعطي المُجدول بيانات دقيقة؛ وقواعد التقارب وanti-affinity تفرض طوبولوجيا التوفر العالي؛ والـ taints والـ tolerations تحجز عتادًا مخصصًا للأحمال الخاضعة للتنظيم؛ وPriorityClass تضمن بقاء حركة الدفع خلال أحداث ضغط العنقود. ويغلق VPA وResourceQuota حلقة التغذية الراجعة — فيمنحانك رؤية للاستهلاك الفعلي وحواجز صلبة ضد الأحمال المنفلتة.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لدى pod ‏resources.requests.memory=256Mi وresources.limits.memory=1Gi. وتنخفض ذاكرة العقدة. ما فئة QoS لهذا الـ pod وما خطر طرده مقارنة بـ pod مضمون (Guaranteed)؟",
      "options": [
        "‏QoS ‏Guaranteed — الطلبات تساوي الحدود، فله الحماية نفسها كأي pod آخر",
        "‏QoS ‏Burstable — الطلبات والحدود مختلفة؛ سيُطرد قبل الـ pods المضمونة لكن بعد pods ‏BestEffort",
        "‏QoS ‏BestEffort — عدم ضبط حدود يعني أنه سيُطرد أولًا",
        "‏QoS ‏Critical — كون حد الذاكرة أعلى من الطلب يمنحه أولوية"
      ],
      "correct": 1,
      "explanation": "يكون الـ pod مضمونًا (Guaranteed) فقط حين الطلبات == الحدود لكل مورد في كل حاوية. وحين تكون الطلبات < الحدود (أو يُضبط بعضها فقط)، يكون الـ pod ‏Burstable. وعند ضغط ذاكرة العقدة، يطرد kubelet أولًا الـ pods التي يتجاوز استخدامها طلباتها — pods ‏BestEffort (طلبها 0) وpods ‏Burstable فوق طلبها — مرتبة بالأولوية وبمقدار تجاوزها الطلب. ولا تُطرد الـ pods المضمونة، ولا pods ‏Burstable ضمن طلباتها، إلا كملاذ أخير. ولخدمات الدفع الحرجة، اجعل طلب الذاكرة == حدها (والمعالج أيضًا لـ QoS مضمون كامل) لتقليل خطر الطرد."
    },
    {
      "text": "يستخدم Deployment لواجهة دفع podAntiAffinity بـ requiredDuringSchedulingIgnoredDuringExecution لتوزيع النسخ عبر مناطق التوفر. وتُضاف نسخة جديدة لكن كل المناطق فيها نسخة واحدة بالفعل. ماذا يحدث؟",
      "options": [
        "تُجدول النسخة الجديدة في المنطقة الأقل استخدامًا للمعالج، متجاوزة قاعدة anti-affinity",
        "يبقى الـ pod في Pending — فقاعدة anti-affinity إلزامية لا يمكن تحقيقها تفشل الجدولة",
        "يضيف Kubernetes تلقائيًا عقدة جديدة في منطقة جديدة لتحقيق القيد",
        "تُخفف القاعدة إلى مفضّلة حين لا تتوفر عقد مطابقة"
      ],
      "correct": 1,
      "explanation": "‏requiredDuringSchedulingIgnoredDuringExecution قيد صارم. فإذا لم تحقق أي عقدة قاعدة anti-affinity، يبقى الـ pod في حالة Pending إلى أجل غير مسمى بدل انتهاك القيد. ويعني جزء IgnoredDuringExecution أنه إذا اكتسبت عقدة لاحقًا التسمية المتعارضة بعد أن يكون pod يعمل عليها بالفعل، فلا يُطرد الـ pod. وللتوفر العالي المرن، فكّر في preferredDuringSchedulingIgnoredDuringExecution بوزن عالٍ، أو اجمع توزيع مناطق إلزاميًا مع توزيع مفضّل على مستوى المضيف."
    },
    {
      "text": "على عقدة الـ taint ‏pci-dss=true:NoSchedule. ويحتاج pod معالج دفع العمل على هذه العقدة بجانب عامل مراقبة يجب أن يعمل على كل العقد. كيف يجب أن يتسامح عامل المراقبة مع الـ taint؟",
      "options": [
        "لا يحتاج عامل المراقبة tolerations — فـ NoSchedule ينطبق على الـ pods الجديدة فقط",
        "أضف toleration بـ key=pci-dss، وvalue=true، وeffect=NoSchedule إلى مواصفة pod عامل المراقبة كي يمكن جدولته على عقد PCI-DSS",
        "استخدم DaemonSet لعامل المراقبة — فالـ DaemonSets تتسامح تلقائيًا مع كل الـ taints",
        "أزل الـ taint واستخدم NetworkPolicy بدلًا منه لعزل أحمال PCI-DSS"
      ],
      "correct": 1,
      "explanation": "تمنع taints ‏NoSchedule الـ pods التي ليس لها toleration مطابق من الجدولة على العقدة. ويحتاج عامل المراقبة toleration صريحًا يطابق مفتاح الـ taint وقيمته وأثره ليصبح مؤهلًا لعقدة PCI-DSS. ولا تتسامح الـ DaemonSets تلقائيًا مع الـ taints المخصصة: فمتحكم DaemonSet يضيف tolerations فقط لحالات العقد المدمجة (not-ready، وunreachable، وضغط القرص/الذاكرة/PID، وunschedulable). وللعوامل التي يجب أن تعمل على كل عقدة، يتسامح toleration بـ operator=Exists (بلا مفتاح) مع كل الـ taints — لكنها صلاحية واسعة، ففضّل سرد الـ taints المحددة."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "إعداد جدولة الـ Pods الإنتاجي لواجهة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    "أنشئ Deployment لـ payment-api بـ: QoS ‏Guaranteed (الطلبات == الحدود: 500m معالج، و512Mi ذاكرة)، وpod anti-affinity إلزامية عبر مناطق التوفر باستخدام مفتاح الطوبولوجيا topology.kubernetes.io/zone، وقاعدة تقارب عقد تفضّل العقد ذات التسمية workload-type=payment. وانشر 3 نسخ عبر عنقود من 3 مناطق وتحقق من أن كل نسخة تقع في منطقة مختلفة باستخدام kubectl get pods -o wide.",
    "عرّف PriorityClass باسم payment-critical بقيمة 1000000 وglobalDefault=false. وأنشئ PriorityClass ثانية باسم background-jobs بقيمة 100. وطبّق payment-critical على Deployment ‏payment-api وbackground-jobs على مهمة دفعية. واملأ العنقود بالمهمة الدفعية حتى لا يمكن جدولة نسخة payment-api جديدة، ثم وسّع payment-api وتحقق من أن المُجدول يستبق pod دفعيًا لإفساح المجال.",
    "اضبط ResourceQuota لمساحة الأسماء payments تحدّ: 10 معالجات إجمالي الطلبات، و20Gi ذاكرة إجمالي الطلبات، و20 معالجًا إجمالي الحدود، و40Gi ذاكرة إجمالي الحدود، و20 pod كحد أقصى. واكتب اختبارًا يحاول نشر pod رقم 21 ويتحقق من رفضه برسالة خطأ تجاوز ResourceQuota.",
    "استخدم kubectl top pods وVPA بوضع Off لجمع توصيات المعالج والذاكرة لـ payment-api على مدى 24 ساعة من الحمل المحاكى. وقارن الطلبات الموصى بها من VPA بالقيم المضبوطة أوليًا، وعدّل الـ Deployment، وتحقق من أن الـ pods تحقق QoS ‏Guaranteed بالإعدادات الجديدة باستخدام kubectl describe pod."
  ]
}
-->
