---
id: track-10-lesson-01
title: "Kubernetes for Financial Services — Architecture and Workloads"
slug: kubernetes-financial
track: track-10
trackName: Cloud, Infrastructure & Platform Engineering
sequence: 1
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [Kubernetes, K8s, deployment, pod, namespace]
prerequisites: []
---

# Kubernetes for Financial Services — Architecture and Workloads

> [!NOTE]
> Kubernetes has become the standard deployment platform for financial services, but running regulated workloads on K8s requires different patterns than general application development. This lesson covers the K8s model and its application to financial production environments.

## Why Kubernetes for Financial Services

Financial technology organisations migrate to Kubernetes for three reasons:

1. **Declarative infrastructure** — the desired state is version-controlled; rollback is a git revert
2. **Operational consistency** — identical deployment mechanism for dev, staging, and production
3. **Resilience primitives** — health checks, pod restart, rolling updates, and horizontal scaling are built-in

The challenge is that financial services have additional requirements: data residency, network segmentation, secrets management, and audit trails for every configuration change.

---

## Kubernetes Architecture

```mermaid
graph TB
    subgraph ControlPlane ["Control Plane (managed by cloud provider)"]
        API[API Server\nkubectl / GitOps]
        ETCD[etcd\nCluster State]
        SCHED[Scheduler\nPod placement]
        CM[Controller Manager\nDesired state enforcement]
    end
    
    subgraph Node1 ["Worker Node 1"]
        kubelet1[kubelet]
        kubeproxy1[kube-proxy]
        P1[payment-api\nPod]
        P2[payment-api\nPod]
    end
    
    subgraph Node2 ["Worker Node 2"]
        kubelet2[kubelet]
        kubeproxy2[kube-proxy]
        P3[fraud-service\nPod]
        P4[settlement-worker\nPod]
    end
    
    API --> ETCD
    API --> SCHED
    API --> CM
    SCHED --> Node1
    SCHED --> Node2
    kubelet1 --> API
    kubelet2 --> API
```

### Key Control Plane Concepts

**etcd** stores all cluster state — deployments, services, secrets, configmaps. For financial K8s clusters, etcd encryption at rest is mandatory.

**API Server** is the single entry point for all cluster operations. All changes go through it, so with API server audit logging enabled (an audit policy must be configured; managed clusters expose it as a setting) you get a complete audit trail of who changed what.

**Scheduler** places pods on nodes based on resource requests, affinity rules, and taints.

---

## Pods — The Deployment Unit

A **pod** is the smallest deployable unit in Kubernetes. It encapsulates one or more containers that share network and storage. In practice you never create bare pods — a Deployment (next section) creates them from its template; the full spec below shows what each pod contains.

```yaml
# payment-api pod specification
apiVersion: v1
kind: Pod
metadata:
  name: payment-api-7b4f9d
  namespace: payments-prod
  labels:
    app: payment-api
    version: "2.4.1"
    tier: "frontend"
  annotations:
    # Compliance: record who deployed this and when
    deploy.bank.internal/deployed-by: "ci-pipeline"
    deploy.bank.internal/deployed-at: "2024-11-07T14:30:00Z"
    deploy.bank.internal/change-ref: "CHG-20241107-003"
spec:
  serviceAccountName: payment-api-sa  # least-privilege service account
  
  containers:
  - name: payment-api
    image: bank-registry.internal/payment-api:2.4.1
    
    ports:
    - containerPort: 8080
      name: http
    - containerPort: 8081
      name: actuator   # separate port for health/metrics — not exposed externally
      
    # Resource requests and limits — REQUIRED for financial workloads
    resources:
      requests:
        memory: "512Mi"
        cpu: "250m"
      limits:
        memory: "1Gi"
        cpu: "1000m"
        
    # Health checks
    # startupProbe covers JVM start-up (up to 30 x 5s = 150s); liveness and
    # readiness only start after it succeeds -- no guessed initialDelaySeconds
    startupProbe:
      httpGet:
        path: /actuator/health/liveness
        port: 8081
      periodSeconds: 5
      failureThreshold: 30

    livenessProbe:
      httpGet:
        path: /actuator/health/liveness
        port: 8081
      periodSeconds: 10
      failureThreshold: 3
      
    readinessProbe:
      httpGet:
        path: /actuator/health/readiness
        port: 8081
      periodSeconds: 5
      failureThreshold: 3
      
    # Secret synced from Vault by External Secrets Operator — never hardcoded.
    # (An env var is read once at start-up: a rotated password reaches the
    # pod only after a restart -- or mount the secret as a file and reload)
    env:
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef:
          name: payment-api-db-secret
          key: password
          
    # Security context — run as non-root
    securityContext:
      runAsNonRoot: true
      runAsUser: 1000
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
```

---

## Deployments — Managing Pod Lifecycle

A **Deployment** manages a set of identical pods, handling rolling updates and rollbacks.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments-prod
spec:
  replicas: 6         # 6 pods across nodes for HA
  
  selector:
    matchLabels:
      app: payment-api
      
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1    # at most 1 pod down during update
      maxSurge: 2          # at most 2 extra pods during update
      # With 6 replicas: update removes 1, adds 2 → never below 5 pods serving traffic
      
  template:
    metadata:
      labels:
        app: payment-api
        version: "2.4.1"
    spec:
      # Spread pods across availability zones and nodes.
      # (A REQUIRED hostname anti-affinity would need one node per pod:
      # with maxSurge=2 and an HPA max of 24, pods would stay Pending
      # whenever there are fewer nodes than pods. Spread constraints
      # spread evenly without that hard limit.)
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule      # zones must stay balanced
        labelSelector:
          matchLabels:
            app: payment-api
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway     # prefer different nodes
        labelSelector:
          matchLabels:
            app: payment-api

      # Graceful shutdown — give in-flight requests 30 seconds to complete
      terminationGracePeriodSeconds: 30
      
      containers:
      - name: payment-api
        image: bank-registry.internal/payment-api:2.4.1
        # resources, probes, env and securityContext as in the pod spec above
        lifecycle:
          preStop:
            # Give the load balancer time to stop routing traffic before the
            # pod terminates. Native sleep action (Kubernetes 1.30+) -- works
            # in distroless images that have no /bin/sh. On older clusters:
            # exec: {command: ["sleep", "5"]}
            sleep:
              seconds: 5
```

---

## Namespaces — Multi-Tenancy and Isolation

Namespaces provide logical isolation between teams and environments within a cluster.

```yaml
# Production namespace with resource quotas
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-prod-quota
  namespace: payments-prod
spec:
  hard:
    # Compute resources
    requests.cpu: "32"
    requests.memory: "64Gi"
    limits.cpu: "64"
    limits.memory: "128Gi"
    
    # Object counts
    pods: "50"
    services: "20"
    persistentvolumeclaims: "20"
    
    # Prevent runaway secret/configmap creation
    secrets: "50"
    configmaps: "50"
```

```yaml
# Network policy: payments namespace can only talk to database and kafka namespaces
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payments-egress-policy
  namespace: payments-prod
spec:
  podSelector: {}  # applies to all pods in namespace
  policyTypes:
  - Egress
  egress:
  # Allow traffic to database namespace only
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: database   # label set automatically on every namespace
    ports:
    - protocol: TCP
      port: 5432  # PostgreSQL
  # Allow traffic to Kafka namespace
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kafka
    ports:
    - protocol: TCP
      port: 9092
  # Allow DNS (cluster DNS only -- UDP and TCP)
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
```

NetworkPolicies are only enforced if the cluster's network plugin (CNI) supports them — e.g. Calico or Cilium; check before relying on them.

---

## Horizontal Pod Autoscaler — Scaling for Payment Peaks

Financial systems experience predictable peaks: salary payment days, bill payment windows, end of month. The HPA scales pods based on observed metrics — it reacts *after* load rises, and new JVM pods need time to warm up. For known peaks, also scale ahead of time (e.g. raise `minReplicas` on a schedule, or a KEDA cron trigger).

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-api-hpa
  namespace: payments-prod
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
    
  minReplicas: 6    # never below 6 — always HA
  maxReplicas: 24   # sized for 4x peak traffic
  
  metrics:
  # Scale on CPU — standard metric
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60   # scale up when average CPU > 60%
        
  # Scale on custom metric — payment queue depth (served through the custom
  # metrics API, e.g. by Prometheus Adapter. KEDA is an alternative that
  # creates and manages its own HPA -- don't combine both on one Deployment)
  - type: Pods
    pods:
      metric:
        name: payment_queue_depth
      target:
        type: AverageValue
        averageValue: "100"      # scale up when each pod has >100 queued payments
        
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0     # scale up immediately — don't wait
      policies:
      - type: Pods
        value: 4
        periodSeconds: 60              # add up to 4 pods per minute
    scaleDown:
      stabilizationWindowSeconds: 300   # wait 5 minutes before scaling down
      policies:
      - type: Pods
        value: 1
        periodSeconds: 60              # remove at most 1 pod per minute
```

---

## ConfigMaps and Secrets — Configuration Management

```yaml
# ConfigMap — non-sensitive configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: payment-api-config
  namespace: payments-prod
data:
  application.yml: |
    payment:
      timeout-ms: 5000
      max-retries: 3
      currency-conversion-service: https://fx.internal.bank:8443
    kafka:
      bootstrap-servers: kafka.kafka.svc.cluster.local:9092
      consumer-group: payment-api-prod
```

```yaml
# External Secrets Operator: sync secrets from HashiCorp Vault.
# Vault stays the source of truth (rotation, access policy, audit). ESO
# still writes a normal K8s Secret -- base64 is not encryption -- so also
# enable etcd encryption at rest (KMS) and restrict RBAC on Secrets.
# Never put secret values in ConfigMaps or in Git.
apiVersion: external-secrets.io/v1      # v1beta1 in older ESO releases
kind: ExternalSecret
metadata:
  name: payment-api-db-secret
  namespace: payments-prod
spec:
  refreshInterval: 1h    # re-sync from Vault every hour (picks up rotations)
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: payment-api-db-secret
    creationPolicy: Owner
  data:
  - secretKey: password
    remoteRef:
      key: secret/payments-prod/database
      property: password
```

---

## Principal Engineer's Kubernetes Checklist

Before deploying a financial service to production Kubernetes:

- [ ] **Resource requests and limits** set on all containers — no unbounded resource consumption
- [ ] **Topology spread** (or preferred anti-affinity) configured — replicas spread across zones and nodes
- [ ] **Non-root security context** — `runAsNonRoot: true`, `readOnlyRootFilesystem: true`
- [ ] **External secrets** via Vault ESO — no secret values in configmaps or Git; etcd encryption at rest and tight RBAC on Secrets
- [ ] **Network policy** restricts egress to known destinations only
- [ ] **Health probes** — startup, liveness and readiness. If actuator runs on a separate management port, remember the probes then don't exercise the main server port (Spring Boot can also expose them on the main port: `management.endpoint.health.probes.add-additional-paths=true` → `/livez`, `/readyz`)
- [ ] **Graceful shutdown** with `preStop` sleep + `terminationGracePeriodSeconds`
- [ ] **HPA configured** with both CPU and business metrics, plus pre-scaling for known peaks
- [ ] **Resource quotas** applied to namespace
- [ ] **K8s audit logging** enabled — all API server interactions recorded

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "A payment-api Deployment has 6 replicas and rollingUpdate.maxUnavailable=1, maxSurge=2. During a rolling update, what is the minimum number of pods serving traffic at any point?",
      "options": [
        "4 pods — Kubernetes removes all old pods before adding new ones",
        "5 pods — only 1 can be down at a time",
        "6 pods — surge ensures we never go below current replica count",
        "7 pods — surge adds 2 before removing any"
      ],
      "correct": 1,
      "explanation": "maxUnavailable=1 means at most 1 pod can be unavailable (down or not ready) at any time. With 6 replicas, the minimum serving at any point is 6-1=5 pods. maxSurge=2 means up to 8 total pods can exist during the update (6+2), but the availability floor is set by maxUnavailable."
    },
    {
      "id": "q2",
      "text": "Why should Kubernetes Secrets not be used to store database passwords directly for a regulated financial service?",
      "options": [
        "Kubernetes Secrets are limited to 1MB in size",
        "Kubernetes Secrets are base64-encoded, not encrypted — anyone with namespace read access or etcd access can read the value; a secrets management system like Vault provides encryption, access control, and audit logging",
        "Kubernetes Secrets cannot be mounted as environment variables",
        "Kubernetes Secrets expire after 90 days"
      ],
      "correct": 1,
      "explanation": "Base64 is encoding, not encryption. Without etcd encryption at rest AND strict RBAC, K8s Secrets are effectively plaintext to anyone with access to the namespace or to etcd. For financial services the source of truth should be a secrets manager such as Vault: encrypted at rest, access-controlled with least-privilege policies, every read audited, and rotation managed centrally. External Secrets Operator syncs the value into the cluster — the resulting K8s Secret still needs etcd encryption and tight RBAC, and the application must re-read it (restart, or a mounted file that is reloaded) to pick up a rotation."
    },
    {
      "id": "q3",
      "text": "During salary payment day, your payment-api pods are CPU-spiking to 90% and the HPA is scaling up. New pods are taking 90 seconds to become Ready (JVM warmup time). What happens to traffic during this 90-second window?",
      "options": [
        "Traffic is queued — Kubernetes waits for new pods before routing",
        "Traffic is handled by the existing pods at high CPU — the new pods receive traffic only after their readiness probe passes",
        "Traffic is dropped — Kubernetes rejects new connections during scaling",
        "Traffic is split proportionally to available pods"
      ],
      "correct": 1,
      "explanation": "Kubernetes only sends traffic to pods that pass their readiness probe. During the 90-second warmup, the new pods are not Ready and receive no traffic. Existing pods handle all traffic at high CPU. This is correct behaviour — better to serve slow than to route to unready pods. The fix is application-level warmup before the readiness probe passes."
    },
    {
      "id": "q4",
      "text": "A NetworkPolicy denies all ingress to the payments-prod namespace except from the api-gateway namespace. A new compliance service in the compliance-prod namespace needs to query the payment API. What must you do?",
      "options": [
        "Delete the NetworkPolicy — it's too restrictive",
        "Add an ingress rule to the payments-prod NetworkPolicy allowing traffic from the compliance-prod namespace (namespaceSelector on kubernetes.io/metadata.name: compliance-prod), ideally only from the compliance service's pods",
        "Move the compliance service into the payments-prod namespace",
        "Use an Ingress resource to bypass the NetworkPolicy"
      ],
      "correct": 1,
      "explanation": "NetworkPolicies are additive allow-lists — you add an allow rule rather than removing the deny-all. The correct fix is an ingress rule in payments-prod that permits traffic from the compliance-prod namespace (the kubernetes.io/metadata.name label is set automatically on every namespace), narrowed with a podSelector to the compliance service and to the API port. This keeps least privilege while enabling exactly the access needed."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Production-Ready Kubernetes Manifests for a Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 90,
  "tasks": [
    {
      "id": "1",
      "description": "Write the Deployment manifest for payment-api: 6 replicas, rolling update with maxUnavailable=1 and maxSurge=2, topology spread across zones and nodes, startup/liveness/readiness probes, resource requests and limits, a non-root read-only security context, and a preStop delay with a matching terminationGracePeriodSeconds."
    },
    {
      "id": "2",
      "description": "Write the HPA manifest: minReplicas 6, maxReplicas 24, scale on CPU (60%) and on a custom payment_queue_depth metric, fast scale-up and slow scale-down. Explain how you would pre-scale before a known salary-day peak."
    },
    {
      "id": "3",
      "description": "Write the NetworkPolicy set for payments-prod: default deny for ingress and egress, ingress only from the api-gateway namespace on port 8080, egress only to PostgreSQL (5432), Kafka (9092) and cluster DNS (UDP and TCP 53). Test it with a debug pod from an unrelated namespace."
    },
    {
      "id": "4",
      "description": "Write the ExternalSecret manifest that syncs the database password from Vault into payment-api-db-secret, and describe how a rotated password reaches the running pods (restart via a rollout, or a mounted file that the application reloads)."
    }
  ]
}
-->
