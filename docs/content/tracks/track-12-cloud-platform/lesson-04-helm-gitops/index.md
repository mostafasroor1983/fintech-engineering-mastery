---
id: track-12-lesson-04
title: "Helm and GitOps — Declarative Infrastructure with ArgoCD"
slug: helm-gitops
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 4
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Helm, GitOps, ArgoCD, Flux, declarative]
prerequisites: [track-12-lesson-03]
---

# Helm and GitOps — Declarative Infrastructure with ArgoCD

> [!NOTE]
> GitOps is the deployment model that satisfies the change management requirements in ISO 27001, SOX, and PCI-DSS simultaneously. Every change to production passes through a pull request, every deployment is traceable to a Git commit, and rollback is `git revert`. For financial institutions under regulatory scrutiny, this is not a convenience — it is a compliance mechanism.

## The GitOps Mental Model for Financial Services

Traditional deployment: Engineer SSHes to server, runs script, hopes it works.
GitOps: Git repository is the single source of truth. The cluster continuously reconciles itself to match the Git state. Humans write PRs, not `kubectl apply`.

For a financial platform this means:
- Every production change has an audit trail (Git history)
- Rollback is deterministic (revert the commit)
- Drift detection catches manual changes (compliance requirement)
- Four-eyes approval is enforced by branch protection rules

---

## 1. Helm Chart Structure

Helm packages Kubernetes manifests into versioned, parameterisable charts. For a financial platform, every microservice should have its own chart.

### Directory Structure

```
payment-processor/
  Chart.yaml              # Chart metadata
  values.yaml             # Default values (safe for all environments)
  values-staging.yaml     # Staging overrides
  values-production.yaml  # Production overrides
  templates/
    deployment.yaml
    service.yaml
    ingress.yaml
    hpa.yaml
    networkpolicy.yaml
    serviceaccount.yaml
    configmap.yaml
    _helpers.tpl            # Template helper functions
  charts/                   # Chart dependencies (subcharts)
  .helmignore
```

### Chart.yaml

```yaml
apiVersion: v2
name: payment-processor
description: "Real-time payment processing service for retail banking platform"
type: application
version: 2.4.1          # Chart version — bump on chart changes
appVersion: "2.4.1"     # Application version — matches Docker image tag
dependencies:
- name: postgresql
  version: "12.5.6"
  repository: "https://charts.bitnami.com/bitnami"
  condition: postgresql.enabled    # allow disabling in prod (we use RDS)
- name: redis
  version: "17.11.6"
  repository: "https://charts.bitnami.com/bitnami"
  condition: redis.enabled
maintainers:
- name: payments-platform-team
  email: payments-platform@example-bank.com
keywords:
- payments
- fintech
- pci-dss
annotations:
  compliance: pci-dss
  team: payments-platform
```

### values.yaml (Defaults)

```yaml
# values.yaml — safe defaults suitable for all environments
replicaCount: 2

image:
  repository: payments-registry.internal/payment-processor
  pullPolicy: IfNotPresent
  tag: ""  # overridden by CI/CD with the specific image tag

imagePullSecrets:
  - name: registry-credentials

serviceAccount:
  create: true
  annotations: {}
  name: ""

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"
  prometheus.io/path: "/actuator/prometheus"

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 2000

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]

service:
  type: ClusterIP
  port: 8080

ingress:
  enabled: false
  className: nginx
  annotations: {}
  hosts: []
  tls: []

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

nodeSelector: {}
tolerations: []
affinity: {}

postgresql:
  enabled: false   # disabled by default; use external RDS in production

redis:
  enabled: false

config:
  javaOpts: "-Xms100m -Xmx400m -XX:+UseG1GC"
  logLevel: INFO
  metricsEnabled: true

# PCI-DSS compliance settings
compliance:
  pciDss: false
  nodeAffinity: false
  dedicatedNodes: false
```

### values-production.yaml (Production Overrides)

```yaml
# values-production.yaml — production-specific overrides
replicaCount: 9

resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2000m"
    memory: "1Gi"

autoscaling:
  enabled: true
  minReplicas: 9
  maxReplicas: 30
  targetCPUUtilizationPercentage: 60

ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "1000"
    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"
    nginx.ingress.kubernetes.io/auth-tls-secret: "payments/client-ca-secret"
  hosts:
  - host: api.payments.internal
    paths:
    - path: /api/v1/payments
      pathType: Prefix
  tls:
  - secretName: payments-tls-cert
    hosts:
    - api.payments.internal

config:
  javaOpts: "-Xms400m -Xmx800m -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
  logLevel: WARN    # reduce log volume in production

compliance:
  pciDss: true
  nodeAffinity: true
  dedicatedNodes: true

tolerations:
- key: "dedicated"
  operator: "Equal"
  value: "payments"
  effect: "NoSchedule"
```

---

## 2. Helm Templating

### Deployment Template

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "payment-processor.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "payment-processor.labels" . | nindent 4 }}
  annotations:
    deployment.kubernetes.io/revision: "1"
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: {{ div .Values.replicaCount 3 | default 1 }}
  selector:
    matchLabels:
      {{- include "payment-processor.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "payment-processor.selectorLabels" . | nindent 8 }}
      annotations:
        # Force pod restart when configmap changes
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "payment-processor.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      {{- if .Values.compliance.pciDss }}
      priorityClassName: payment-critical
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- if .Values.compliance.nodeAffinity }}
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
                {{- include "payment-processor.selectorLabels" . | nindent 16 }}
            topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            {{- include "payment-processor.selectorLabels" . | nindent 12 }}
        minDomains: 3
      {{- end }}
      terminationGracePeriodSeconds: 60
      containers:
      - name: {{ .Chart.Name }}
        securityContext:
          {{- toYaml .Values.securityContext | nindent 10 }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.image.pullPolicy }}
        ports:
        - containerPort: 8080
          name: http
          protocol: TCP
        env:
        - name: JAVA_OPTS
          value: {{ .Values.config.javaOpts | quote }}
        - name: SPRING_PROFILES_ACTIVE
          value: {{ .Release.Name | quote }}
        - name: LOG_LEVEL
          value: {{ .Values.config.logLevel | quote }}
        resources:
          {{- toYaml .Values.resources | nindent 10 }}
        readinessProbe:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 15"]
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: config
          mountPath: /app/config
          readOnly: true
      volumes:
      - name: tmp
        emptyDir: {}
      - name: config
        configMap:
          name: {{ include "payment-processor.fullname" . }}-config
```

### _helpers.tpl

```yaml
# templates/_helpers.tpl
{{/*
Expand the name of the chart.
*/}}
{{- define "payment-processor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "payment-processor.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "payment-processor.labels" -}}
helm.sh/chart: {{ include "payment-processor.chart" . }}
{{ include "payment-processor.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
compliance: {{ .Values.compliance.pciDss | ternary "pci-dss" "standard" | quote }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "payment-processor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "payment-processor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

---

## 3. ArgoCD Application and Sync Policy

ArgoCD continuously watches a Git repository and synchronises the cluster state to match it.

### ArgoCD Application Resource

```yaml
# argocd-app-payment-processor.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-processor-production
  namespace: argocd
  labels:
    team: payments-platform
    environment: production
  finalizers:
  - resources-finalizer.argocd.argoproj.io   # delete app resources when Application is deleted
spec:
  project: payments-production                # ArgoCD AppProject for RBAC

  source:
    repoURL: https://github.com/example-bank/k8s-platform.git
    targetRevision: main
    path: apps/payment-processor/production
    helm:
      valueFiles:
      - values.yaml
      - values-production.yaml
      # Pass image tag from CD pipeline
      parameters:
      - name: image.tag
        value: "2.4.1"

  destination:
    server: https://kubernetes.default.svc   # in-cluster
    namespace: payments

  syncPolicy:
    automated:
      prune: true        # delete resources removed from Git
      selfHeal: true     # revert manual kubectl changes
      allowEmpty: false  # never sync to an empty state
    syncOptions:
    - Validate=true                 # validate manifests before applying
    - CreateNamespace=false         # namespace must already exist
    - PrunePropagationPolicy=foreground
    - PruneLast=true                # delete old resources after new ones are healthy
    - ApplyOutOfSyncOnly=true       # only sync changed resources (faster)
    - RespectIgnoreDifferences=true
    retry:
      limit: 3
      backoff:
        duration: 30s
        factor: 2
        maxDuration: 10m

  # What ArgoCD should ignore when checking sync status
  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/replicas    # HPA manages replicas; ignore ArgoCD diff
  - group: ""
    kind: Secret
    jsonPointers:
    - /data             # External Secrets Operator manages secret data

  # Health assessment customisation
  revisionHistoryLimit: 10
```

### ArgoCD AppProject for RBAC

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments-production
  namespace: argocd
spec:
  description: "Payment platform production applications"

  # Source repositories allowed for this project
  sourceRepos:
  - https://github.com/example-bank/k8s-platform.git
  - https://charts.bitnami.com/bitnami

  # Destination clusters and namespaces
  destinations:
  - server: https://kubernetes.default.svc
    namespace: payments
  - server: https://kubernetes.default.svc
    namespace: fraud

  # Kubernetes resource types allowed
  clusterResourceWhitelist:
  - group: ""
    kind: Namespace

  namespaceResourceBlacklist:
  - group: ""
    kind: ResourceQuota     # prevent apps overriding quota (platform team only)

  # RBAC roles
  roles:
  - name: payment-developer
    description: "Payment developers can sync apps but not delete"
    policies:
    - p, proj:payments-production:payment-developer, applications, get, payments-production/*, allow
    - p, proj:payments-production:payment-developer, applications, sync, payments-production/*, allow
    - p, proj:payments-production:payment-developer, applications, action/apps/Deployment/restart, payments-production/*, allow
    groups:
    - payments-platform-engineers

  - name: payment-lead
    description: "Payment leads can create and delete apps"
    policies:
    - p, proj:payments-production:payment-lead, applications, *, payments-production/*, allow
    groups:
    - payments-platform-leads

  # Orphan resources (resources in namespace not managed by ArgoCD)
  orphanedResources:
    warn: true             # alert on resources not tracked by ArgoCD
```

---

## 4. GitOps Workflow: PR to Production

```
Developer                Git Repo              ArgoCD          Cluster
    |                        |                     |               |
    |-- git push feature --> |                     |               |
    |                        |                     |               |
    |-- open PR -----------> |                     |               |
    |                   CI runs:                   |               |
    |                   - unit tests               |               |
    |                   - helm lint                |               |
    |                   - image scan               |               |
    |                        |                     |               |
    |-- PR approved -------> |                     |               |
    |-- merge to main -----> |                     |               |
    |                        |-- webhook --------> |               |
    |                        |             ArgoCD detects diff     |
    |                        |             health checks pass      |
    |                        |                     |-- sync -----> |
    |                        |                     |   kubectl     |
    |                        |                     |   apply       |
    |                        |                     |               |
    |                        |             ArgoCD reports Synced   |
```

### Environment Promotion Strategy

```
environments/
  dev/
    payment-processor/
      kustomization.yaml   (or values-dev.yaml)
  staging/
    payment-processor/
      kustomization.yaml
  production/
    payment-processor/
      kustomization.yaml
```

Promotion flow:
1. CI builds image `payment-processor:v2.4.2`, pushes to registry
2. CI opens automated PR: updates `image.tag` in `environments/dev/`
3. Dev ArgoCD syncs automatically
4. After automated tests pass, CI opens PR to `environments/staging/`
5. After staging QA sign-off, manual PR to `environments/production/`
6. Two approvals required (four-eyes rule enforced by GitHub branch protection)
7. Merge triggers production sync

---

## 5. Secrets Management with Helm and Vault

Never store secrets in Helm values or Git. Use External Secrets Operator (ESO) to sync secrets from Vault into Kubernetes Secrets.

```yaml
# ExternalSecret resource — ArgoCD manages this manifest
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payment-processor-db-credentials
  namespace: payments
spec:
  refreshInterval: 1h                    # resync from Vault every hour
  secretStoreRef:
    name: vault-secret-store
    kind: SecretStore
  target:
    name: payment-processor-db-credentials
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        SPRING_DATASOURCE_URL: "jdbc:postgresql://{{ .host }}:{{ .port }}/{{ .database }}"
        SPRING_DATASOURCE_USERNAME: "{{ .username }}"
        SPRING_DATASOURCE_PASSWORD: "{{ .password }}"
  data:
  - secretKey: host
    remoteRef:
      key: secret/payments/database
      property: host
  - secretKey: port
    remoteRef:
      key: secret/payments/database
      property: port
  - secretKey: database
    remoteRef:
      key: secret/payments/database
      property: database
  - secretKey: username
    remoteRef:
      key: secret/payments/database/credentials
      property: username
  - secretKey: password
    remoteRef:
      key: secret/payments/database/credentials
      property: password
```

---

## 6. App of Apps Pattern

For a large financial platform with 50+ microservices, the App of Apps pattern lets you manage all applications from a single root ArgoCD Application.

```
gitops-repo/
  apps/
    _root-app/
      payments-platform.yaml    # root Application
    payment-processor/
      production/
        application.yaml        # ArgoCD Application for payment-processor
    fraud-detection/
      production/
        application.yaml
    account-service/
      production/
        application.yaml
    settlement-service/
      production/
        application.yaml
```

```yaml
# apps/_root-app/payments-platform.yaml — the root Application
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-platform-root
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io
spec:
  project: platform-admin
  source:
    repoURL: https://github.com/example-bank/k8s-platform.git
    targetRevision: main
    path: apps           # points to the apps/ directory
    directory:
      recurse: true      # find all Application manifests recursively
      include: "*/production/application.yaml"
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd    # ArgoCD Application resources live in argocd namespace
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

This single root Application, when synced, creates or updates all child Application resources in ArgoCD. Each child Application then manages its own microservice deployment.

---

## 7. Image Update Automation

For non-production environments, Argo CD Image Updater automatically bumps image tags when new images are pushed:

```yaml
# Annotation on ArgoCD Application — staging auto-updates on new image push
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-processor-staging
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: |
      payment-processor=payments-registry.internal/payment-processor:~2.4
    argocd-image-updater.argoproj.io/payment-processor.update-strategy: semver
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  # ... rest of Application spec
```

Production should never use automatic image updates. Require explicit PR approval.

---

## Production Checklist

- [ ] All chart `values.yaml` files committed to Git — no secrets
- [ ] Branch protection: require 2 approvals and passing CI before merge to main
- [ ] ArgoCD `selfHeal: true` — manual kubectl changes are reverted within 3 minutes
- [ ] ArgoCD `prune: true` — resources deleted from Git are removed from cluster
- [ ] `ignoreDifferences` configured for HPA-managed replicas (avoid revert loop)
- [ ] ArgoCD AppProject RBAC: developers can sync, only leads can delete
- [ ] Image tags pinned in Git — no `latest` tags in production
- [ ] ExternalSecret resources managed by ArgoCD, not secret values
- [ ] Environment promotion requires explicit PR (not automatic)
- [ ] ArgoCD audit log shipped to SIEM (every sync is a production change event)

---

## Summary

Helm gives you parameterisable, versioned Kubernetes application packages. GitOps via ArgoCD connects Git to the cluster, turning your repository into the deployment authority. For financial services, this combination solves the deployment traceability and rollback requirements of ISO 27001 and PCI-DSS with no additional tooling — the Git history is the audit log, branch protection enforces four-eyes approval, and ArgoCD's self-heal makes drift from approved state an observable, alertable event rather than a silent configuration deviation.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "An ArgoCD Application is configured with syncPolicy.automated.selfHeal=true. An operator manually patches a deployment's replica count in production using kubectl. What happens within the next ArgoCD sync interval?",
      "options": [
        "Nothing — manual changes are protected from ArgoCD overrides by default",
        "ArgoCD detects the drift between live state and Git state, and reverts the replica count to what is defined in Git",
        "ArgoCD marks the application as OutOfSync and sends an alert, but does not revert the change",
        "ArgoCD deletes and recreates the deployment to ensure full consistency"
      ],
      "correct": 1,
      "explanation": "selfHeal=true means ArgoCD continuously compares the live cluster state against the Git-desired state and automatically syncs any drift. A manual kubectl patch creates a divergence — the live replica count differs from Git. Within the next sync interval (typically 3 minutes), ArgoCD detects the drift and applies the Git state, reverting the manual change. This is the core GitOps guarantee: Git is the single source of truth, and all changes must go through Git to persist."
    },
    {
      "text": "A Helm chart has environment-specific values files: values.yaml (defaults), values-staging.yaml (staging overrides), values-production.yaml (production overrides). A developer sets replicaCount=1 in values.yaml but the production values file has no replicaCount key. How many replicas does the production deployment have?",
      "options": [
        "0 — production values file must explicitly set every required value",
        "1 — production values file inherits the default from values.yaml for any key not overridden",
        "Error — Helm requires all values to be set in the environment-specific file",
        "The chart's Chart.yaml default is used instead of values.yaml"
      ],
      "correct": 1,
      "explanation": "Helm merges values files in order: the base values.yaml provides all defaults, and environment-specific files override only the keys they define. Any key not present in the override file falls back to the base values.yaml value. So if production values only overrides image.tag and resource limits, replicaCount=1 from values.yaml applies in production. This is intentional — you define defaults once and only override what differs per environment. It also means a missing production override is not necessarily a bug."
    },
    {
      "text": "An ArgoCD AppProject restricts the payments team to: sourceRepos=['https://github.com/company/payments-platform'], destinations=[{server: 'in-cluster', namespace: 'payments'}], and clusterResourceWhitelist=[]. What can the payments team NOT do?",
      "options": [
        "Deploy applications from the company's Git repository to the payments namespace",
        "Deploy cluster-scoped resources like ClusterRole, ClusterRoleBinding, or StorageClass — the empty clusterResourceWhitelist blocks all cluster-level resources",
        "Use Helm charts with values files stored in the same repository",
        "Configure ArgoCD to sync automatically with selfHeal enabled"
      ],
      "correct": 1,
      "explanation": "clusterResourceWhitelist controls which cluster-scoped (non-namespaced) resource types the AppProject allows. An empty whitelist means no cluster-scoped resources can be created by Applications in this project. The team cannot create ClusterRole, ClusterRoleBinding, StorageClass, PersistentVolume, or any other cluster-level resource. This is the least-privilege principle applied to GitOps: the payments team can only manage namespaced resources within the payments namespace, preventing accidental or malicious cluster-wide changes."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "GitOps Pipeline with Helm and ArgoCD for a Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    "Create a Helm chart for a payment-api service with Chart.yaml (apiVersion: v2, version: 1.0.0), values.yaml with configurable replicaCount/image/resources/pciCompliance flag, a Deployment template that conditionally adds securityContext fields when pciCompliance=true, and environment-specific values files (values-staging.yaml with 1 replica, values-production.yaml with 3 replicas and resource limits). Verify rendering with helm template and helm lint.",
    "Configure an ArgoCD Application pointing to the Helm chart in a Git repository for the production environment. Enable automated sync with prune=true and selfHeal=true. Apply the Application and verify the payment-api deployment is created. Then manually kubectl scale the deployment to 5 replicas and confirm ArgoCD reverts it to 3 within the sync interval.",
    "Create an ArgoCD AppProject for the payments team restricting: sourceRepos to the company GitHub org only, destinations to the payments namespace only, and clusterResourceWhitelist to an empty list. Create an ArgoCD Application within this project. Attempt to deploy a ClusterRole from the same repository and verify it is rejected by the AppProject restrictions.",
    "Implement External Secrets with a ClusterSecretStore connecting to HashiCorp Vault. Create an ExternalSecret that pulls the database password from Vault path secret/payments/db and materialises it as a Kubernetes Secret. Add a refreshInterval of 1 hour. Write a test that rotates the secret in Vault and verifies the Kubernetes Secret is updated within the refresh interval without restarting the application pod."
  ]
}
-->
