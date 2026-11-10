---
id: track-12-lesson-02
title: "Pod Scheduling — Affinity, Taints, and Resource Requests"
slug: pod-scheduling
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 2
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [pod-scheduling, affinity, taint, toleration, resource-quota]
prerequisites: [track-12-lesson-01]
---

# Pod Scheduling — Affinity, Taints, and Resource Requests

> [!NOTE]
> Misconfigured resource requests are the number one cause of noisy-neighbour incidents in multi-tenant financial Kubernetes clusters. Getting scheduling right keeps payment processing latency predictable under peak load and prevents a runaway batch job from starving the settlement service.

## Why Scheduling Matters in Fintech

In a traditional financial platform, infrastructure teams carved up physical servers with strict boundaries. In Kubernetes the scheduler does this dynamically — but only if you give it the right hints. Without them, the scheduler spreads pods randomly and you can end up with:

- Real-time payment pods sharing a node with a memory-hungry reconciliation batch job
- All replicas of a critical service on the same availability zone, violating your 99.99% SLA
- Nodes perpetually at 90% CPU with no headroom for bursts during end-of-day settlement

This lesson covers every lever the Kubernetes scheduler exposes, with concrete examples drawn from payment processing, risk calculation, and batch reconciliation workloads.

---

## 1. Resource Requests and Limits

### The Difference That Matters

A **request** is the amount of CPU/memory the scheduler uses to find a node. A **limit** is the maximum the container is allowed to use at runtime. They serve different purposes and should be set independently.

| Setting | Effect |
|---|---|
| `requests.cpu` | Scheduler uses this for bin-packing; CFS quota proportional share |
| `limits.cpu` | Container is CPU-throttled if it exceeds this |
| `requests.memory` | Scheduler reservation; OOM killer considers this |
| `limits.memory` | Container is OOM-killed if it exceeds this |

For financial services, the golden rule is:

```
requests = p50 steady-state usage
limits.cpu = p99 burst (or omit to allow burstable)
limits.memory = p99.9 usage + 20% headroom (OOM kill is fatal for in-flight transactions)
```

### Quality of Service Classes

Kubernetes assigns each pod a QoS class based on resource settings:

```
Guaranteed:  requests == limits for all containers
Burstable:   requests < limits (or partial spec)
BestEffort:  no requests/limits specified
```

For payment services, always target **Guaranteed** QoS. This protects them from the OOM killer and gives them the highest scheduling priority during node pressure.

### Production Resource Spec for a Payment Service

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
            cpu: "500m"        # p50: 480m measured over 30 days
            memory: "512Mi"    # p50: 490Mi
          limits:
            cpu: "2000m"       # allow 4x burst for settlement spikes
            memory: "1Gi"      # hard cap: OOM kill better than OOM node
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
```

### Resource Sizing for a Risk Calculation Batch Job

Batch jobs have a different profile — high CPU for a short window:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: end-of-day-risk-calc
  namespace: risk
spec:
  parallelism: 10
  completions: 100
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
          value: "-Xms3g -Xmx5g -XX:+UseG1GC"
```

> [!WARNING]
> Never set `requests.memory` lower than your JVM `-Xms`. The JVM will allocate heap at startup, and if the container exceeds its memory request on a pressure node, it may be evicted mid-calculation — causing a data inconsistency in your risk ledger.

---

## 2. Node Affinity

### RequiredDuringScheduling vs. PreferredDuringScheduling

Node affinity lets you constrain pods to specific node pools based on node labels.

- **requiredDuringSchedulingIgnoredDuringExecution**: Hard constraint. Pod will not schedule if no matching node exists. Use for compliance requirements (data residency, dedicated hardware).
- **preferredDuringSchedulingIgnoredDuringExecution**: Soft constraint. Scheduler tries to satisfy it but will fall back to other nodes. Use for cost optimisation (prefer spot nodes).

### Dedicated PCI-DSS Nodes

A common requirement in card payments: cardholder data workloads must run on hardened nodes that have passed a CIS benchmark audit.

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

## 3. Pod Anti-Affinity for High Availability

### Spreading Payment Services Across Zones

For a 99.99% uptime SLA (52 minutes downtime per year), no single availability zone failure should take down the payment service. Pod anti-affinity enforces this:

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
> Using `requiredDuringScheduling` for hostname anti-affinity and `preferredDuringScheduling` for zone is deliberate. The hard node-level spread guarantees no single node is a SPOF. The soft zone spread is preferred but won't block scheduling if a zone is depleted — which matters during rolling updates.

### Co-locating Services for Latency

The reverse is also useful. The fraud detection service must respond within 50ms to the payment gateway:

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

## 4. Taints and Tolerations

### Dedicated Nodes for Critical Workloads

Taints repel pods unless the pod explicitly tolerates the taint. This reserves node pools exclusively for specific workload classes.

#### Node Setup (applied by Terraform/Cluster API)

```bash
# Taint the dedicated payment nodes
kubectl taint nodes -l node-tier=dedicated-payments \
  dedicated=payments:NoSchedule

# Taint GPU nodes for ML risk models
kubectl taint nodes -l hardware=gpu \
  nvidia.com/gpu=present:NoSchedule
```

#### Toleration in Payment Service

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
      # Tolerate temporary node NotReady (give 5 minutes before rescheduling)
      - key: "node.kubernetes.io/not-ready"
        operator: "Exists"
        effect: "NoExecute"
        tolerationSeconds: 300
      # Tolerate node unreachable (network partition tolerance)
      - key: "node.kubernetes.io/unreachable"
        operator: "Exists"
        effect: "NoExecute"
        tolerationSeconds: 300
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

### Taint Effects Reference

| Effect | Behaviour |
|---|---|
| `NoSchedule` | New pods won't schedule (existing pods unaffected) |
| `PreferNoSchedule` | Scheduler avoids the node but will use it if necessary |
| `NoExecute` | Existing pods are evicted; new pods won't schedule |

For dedicated payment nodes, use `NoSchedule`. Use `NoExecute` only when the node has a problem (e.g., disk pressure, memory pressure) — Kubernetes applies these taints automatically.

---

## 5. PriorityClass for Critical Payment Workloads

### Preemption: Ensuring Critical Pods Always Get Resources

When the cluster is full, a pod with higher priority can evict lower-priority pods to make room.

```yaml
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: payment-critical
value: 1000000
globalDefault: false
description: "Real-time payment processing — must never be preempted"
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
globalDefault: true
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
```

### Applying PriorityClass to Deployments

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
> Preemption causes brief service interruptions for the evicted pod. For risk calculation batch jobs with long-running checkpoints, combine PriorityClass with graceful shutdown handling so a preempted job saves state before exiting.

---

## 6. Topology Spread Constraints

Topology spread constraints are the modern, more expressive replacement for pod anti-affinity zone spreading. They let you specify exactly how evenly pods should be distributed.

### Even Zone Distribution with MaxSkew

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

### WhenUnsatisfiable Options

| Value | Behaviour |
|---|---|
| `DoNotSchedule` | Pod stays Pending until spread can be satisfied |
| `ScheduleAnyway` | Pod schedules anyway; scheduler minimises skew |

For payment services with strict HA requirements, use `DoNotSchedule` for zone spreading.

---

## 7. Vertical Pod Autoscaler (VPA) Recommendations

VPA can automatically right-size resource requests. In financial platforms, run VPA in **Off** or **Initial** mode — never `Auto` on payment-critical pods — to avoid disruptive pod restarts during live transaction processing.

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

#### Reading VPA Recommendations

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

Apply VPA recommendations during planned maintenance windows, not automatically.

---

## 8. ResourceQuota per Namespace

Resource quotas prevent a single team from monopolising cluster resources.

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

## 9. Complete Production Example: Payment Processing Namespace

```yaml
---
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
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: payment-processor
            topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-processor
        minDomains: 3
      terminationGracePeriodSeconds: 60
      containers:
      - name: payment-processor
        image: payments-registry.internal/payment-processor:v2.4.1
        ports:
        - containerPort: 8080
          name: http
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2000m"
            memory: "1Gi"
        env:
        - name: JAVA_OPTS
          value: "-Xms400m -Xmx800m -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 15"]
```

---

## 10. Validating Your Scheduling Configuration

```bash
# Verify pods are spread across zones
kubectl get pods -n payments -o wide \
  --selector=app=payment-processor

# Check which nodes are in which zones
kubectl get nodes --label-columns=topology.kubernetes.io/zone

# Verify no two replicas share a node
kubectl get pods -n payments -o wide | awk '{print $7}' | sort | uniq -d

# If a pod is stuck Pending, describe shows scheduling failure reason
kubectl describe pod payment-processor-xxx -n payments | grep -A 20 "Events:"

# Verify ResourceQuota consumption
kubectl describe resourcequota payments-quota -n payments
```

---

## Production Checklist

- [ ] All payment-critical pods have explicit `requests` and `limits` (Guaranteed QoS)
- [ ] JVM `-Xms` is lower than `requests.memory` with 20% headroom
- [ ] Pod anti-affinity prevents same-node co-location of all replicas
- [ ] Topology spread constraints enforce cross-zone distribution
- [ ] Critical workloads have `PriorityClass: payment-critical`
- [ ] Dedicated PCI-DSS nodes are tainted; payment pods have matching tolerations
- [ ] VPA is running in `Off` mode — reviewing recommendations quarterly
- [ ] ResourceQuota set per namespace; alert at 80% utilisation
- [ ] LimitRange provides safe defaults for pods without explicit resource specs
- [ ] `terminationGracePeriodSeconds` is long enough for in-flight transactions to drain
- [ ] `maxUnavailable: 0` in rolling update strategy for zero-downtime deploys

---

## Summary

Kubernetes scheduling is a contract between your application and the cluster. For financial services, that contract must be explicit: resource requests that reflect real usage give the scheduler accurate data; affinity and anti-affinity rules enforce your HA topology; taints and tolerations reserve dedicated hardware for regulated workloads; and PriorityClass ensures payment traffic survives cluster pressure events. VPA and ResourceQuota close the feedback loop — giving you visibility into actual consumption and hard guardrails against runaway workloads.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A pod has resources.requests.memory=256Mi and resources.limits.memory=1Gi. The node runs low on memory. What QoS class is this pod and what is the eviction risk compared to a Guaranteed pod?",
      "options": [
        "Guaranteed QoS — requests equal limits, so it has the same protection as any other pod",
        "Burstable QoS — requests and limits differ; it will be evicted before Guaranteed pods but after BestEffort pods",
        "BestEffort QoS — no limits set means it will be evicted first",
        "Critical QoS — the memory limit being higher than the request gives it priority"
      ],
      "correct": 1,
      "explanation": "A pod is Guaranteed only when requests == limits for every resource. When requests < limits (or only limits are set), the pod is Burstable. Under memory pressure, the kubelet evicts BestEffort pods first, then Burstable pods ordered by how far over their request they are consuming, and only evicts Guaranteed pods as a last resort. For payment-critical services, set requests == limits to achieve Guaranteed QoS and avoid eviction."
    },
    {
      "text": "A payment API deployment uses podAntiAffinity with requiredDuringSchedulingIgnoredDuringExecution to spread replicas across availability zones. A new replica is added but all AZs already have one replica each. What happens?",
      "options": [
        "The new replica is scheduled in the AZ with the least CPU usage, overriding the anti-affinity rule",
        "The pod remains Pending — a required anti-affinity rule that cannot be satisfied causes scheduling to fail",
        "Kubernetes automatically adds a new node in a new AZ to satisfy the constraint",
        "The rule is relaxed to preferred when no matching nodes are available"
      ],
      "correct": 1,
      "explanation": "requiredDuringSchedulingIgnoredDuringExecution is a hard constraint. If no node satisfies the anti-affinity rule, the pod stays in Pending state indefinitely rather than violating the constraint. The IgnoredDuringExecution part means that if a node later gains the conflicting label after a pod is already running there, the pod is NOT evicted. For flexible HA, consider preferredDuringSchedulingIgnoredDuringExecution with a high weight, or combine required zone spreading with preferred host-level spreading."
    },
    {
      "text": "A node has the taint pci-dss=true:NoSchedule. A payment processor pod needs to run on this node alongside a monitoring agent that must run on ALL nodes. How should the monitoring agent tolerate the taint?",
      "options": [
        "The monitoring agent does not need a toleration — NoSchedule only applies to new pods",
        "Add a toleration with key=pci-dss, value=true, effect=NoSchedule to the monitoring agent's pod spec so it can be scheduled onto PCI-DSS nodes",
        "Use a DaemonSet for the monitoring agent — DaemonSets automatically bypass all taints",
        "Remove the taint and use NetworkPolicy instead to isolate PCI-DSS workloads"
      ],
      "correct": 1,
      "explanation": "NoSchedule taints prevent pods without a matching toleration from being scheduled on the node. The monitoring agent needs an explicit toleration matching the taint key, value, and effect to be eligible for scheduling on the PCI-DSS node. DaemonSets do NOT automatically bypass taints — they also require tolerations unless tolerationSeconds is set. The correct answer is to add the specific toleration. Note: for DaemonSets that must run on every node, adding operator=Exists tolerations can bypass all taints, but that is a broad permission."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Production Pod Scheduling Configuration for a Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    "Create a Deployment for a payment-api with: Guaranteed QoS (requests == limits: 500m CPU, 512Mi memory), requiredDuringSchedulingIgnoredDuringExecution pod anti-affinity across availability zones using topology key topology.kubernetes.io/zone, and a node affinity rule preferring nodes with label workload-type=payment. Deploy 3 replicas across a 3-AZ cluster and verify each replica lands in a different AZ using kubectl get pods -o wide.",
    "Define a PriorityClass named payment-critical with value 1000000 and globalDefault=false. Create a second PriorityClass named background-jobs with value 100. Apply payment-critical to the payment-api Deployment and background-jobs to a batch job. Simulate node memory pressure by deploying a memory-hungry pod and verify that the batch job pod is evicted before the payment-api pod.",
    "Configure a ResourceQuota for the payments namespace limiting: 10 CPU total requests, 20Gi memory total requests, 20 CPU total limits, 40Gi memory total limits, and a maximum of 20 pods. Write a test that attempts to deploy a 21st pod and verifies it is rejected with a ResourceQuota exceeded error message.",
    "Use kubectl top pods and VPA in Off mode to collect CPU and memory recommendations for the payment-api over 24 hours of simulated load. Compare VPA's recommended requests against the initial configured values, adjust the Deployment, and verify the pods achieve Guaranteed QoS with the new settings using kubectl describe pod."
  ]
}
-->
