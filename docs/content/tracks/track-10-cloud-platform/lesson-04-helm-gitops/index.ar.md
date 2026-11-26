---
id: track-10-lesson-04
title: "Helm وGitOps — البنية التحتية التصريحية مع ArgoCD"
slug: helm-gitops
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 4
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [Helm, GitOps, ArgoCD, Flux, declarative]
prerequisites: [track-10-lesson-03]
---

# ‏Helm وGitOps — بنية تحتية تصريحية مع ArgoCD

> [!NOTE]
> ‏GitOps نموذج نشر يدعم ضوابط إدارة التغيير في ISO 27001، وSOX، وPCI-DSS في الوقت نفسه. فكل تغيير على الإنتاج يمر عبر طلب سحب (pull request)، وكل نشر قابل للتتبع إلى commit في Git، والتراجع مجرد `git revert`. وللمؤسسات المالية الخاضعة للرقابة، هذا ليس مجرد راحة — بل جزء كبير من أدلة الامتثال (فما زال المدققون ينظرون في ضبط الوصول، وإجراءات الطوارئ (break-glass)، وخط CI نفسه).

## النموذج الذهني لـ GitOps في الخدمات المالية

النشر التقليدي: يدخل المهندس إلى الخادم بـ SSH، ويشغّل سكربتًا، ويأمل أن ينجح.
‏GitOps: مستودع Git هو مصدر الحقيقة الوحيد. ويوفّق العنقود نفسه باستمرار ليطابق حالة Git. والبشر يكتبون طلبات سحب، لا `kubectl apply`.

ولمنصة مالية يعني هذا:
- لكل تغيير إنتاجي مسار تدقيق (تاريخ Git)
- التراجع حتمي (إلغاء الـ commit)
- كشف الانحراف يلتقط التغييرات اليدوية (متطلب امتثال)
- موافقة العينين الأربع تُفرض بقواعد حماية الفروع

---

## 1. بنية مخطط Helm

يحزم Helm ملفات Kubernetes في مخططات (charts) ذات إصدارات وقابلة للتخصيص بالمعاملات. ولمنصة مالية، يجب أن يكون لكل خدمة مصغّرة مخططها الخاص.

### بنية المجلدات

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

### ‏Chart.yaml

```yaml
apiVersion: v2
name: payment-processor
description: "Real-time payment processing service for retail banking platform"
type: application
version: 2.4.1          # Chart version — bump on chart changes
appVersion: "2.4.1"     # Application version — matches Docker image tag
# Note: since 2025 Bitnami publishes most charts/images only under a paid
# offering (old versions moved to a "legacy" repository). Check the source
# and licence of every dependency; mirror approved charts in your own registry.
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

### ‏values.yaml (القيم الافتراضية)

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
  javaOpts: "-XX:MaxRAMPercentage=70 -XX:+UseG1GC"   # heap follows the memory limit
  springProfile: default
  logLevel: INFO
  metricsEnabled: true

# PCI-DSS compliance settings
compliance:
  pciDss: false
  nodeAffinity: false
  dedicatedNodes: false
```

### ‏values-production.yaml (تجاوزات الإنتاج)

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
  javaOpts: "-XX:MaxRAMPercentage=70 -XX:+UseG1GC -XX:MaxGCPauseMillis=100"
  springProfile: production
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

## 2. قوالب Helm

### قالب الـ Deployment

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "payment-processor.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "payment-processor.labels" . | nindent 4 }}
  # (no deployment.kubernetes.io/revision annotation -- the Deployment
  #  controller owns it)
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
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            {{- include "payment-processor.selectorLabels" . | nindent 12 }}
        minDomains: 3
      - maxSkew: 1                         # spread over nodes without
        topologyKey: kubernetes.io/hostname   # needing one node per pod
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            {{- include "payment-processor.selectorLabels" . | nindent 12 }}
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
        - name: JAVA_TOOL_OPTIONS          # read by every JVM, whatever the start script
          value: {{ .Values.config.javaOpts | quote }}
        - name: SPRING_PROFILES_ACTIVE
          value: {{ .Values.config.springProfile | quote }}
        - name: LOG_LEVEL
          value: {{ .Values.config.logLevel | quote }}
        resources:
          {{- toYaml .Values.resources | nindent 10 }}
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
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
          periodSeconds: 10
        lifecycle:
          preStop:
            sleep:            # native sleep action (Kubernetes 1.30+)
              seconds: 15
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

### ‏_helpers.tpl

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
Chart name and version, used by the helm.sh/chart label
*/}}
{{- define "payment-processor.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "payment-processor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "payment-processor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the service account to use
*/}}
{{- define "payment-processor.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "payment-processor.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
```

---

## 3. تطبيق ArgoCD وسياسة المزامنة

يراقب ArgoCD مستودع Git باستمرار ويزامن حالة العنقود لتطابقه.

### مورد Application في ArgoCD

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
    targetRevision: main      # production state = what is merged to main
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
  # (Secrets created by External Secrets Operator are not in Git, so Argo CD
  #  does not track them -- no ignore rule needed; Git holds the ExternalSecret)

  # Number of past sync revisions kept for history / rollback
  revisionHistoryLimit: 10
```

### ‏AppProject في ArgoCD للتحكم بالصلاحيات (RBAC)

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

## 4. سير عمل GitOps: من طلب السحب إلى الإنتاج

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
    |                        |                     |-- sync -----> |
    |                        |                     |   (apply      |
    |                        |                     |   manifests)  |
    |                        |                     |               |
    |                        |             rollout health checked  |
    |                        |             ArgoCD reports Synced   |
    |                        |             + Healthy               |
```

### استراتيجية ترقية البيئات

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

تدفق الترقية:
1. يبني CI الصورة `payment-processor:v2.4.2` ويدفعها إلى السجل
2. يفتح CI طلب سحب آليًا: يحدّث `image.tag` في `environments/dev/`
3. يزامن ArgoCD الخاص بالتطوير تلقائيًا
4. بعد نجاح الاختبارات الآلية، يفتح CI طلب سحب إلى `environments/staging/`
5. بعد اعتماد ضمان الجودة في التجهيز، طلب سحب يدوي إلى `environments/production/`
6. موافقتان مطلوبتان (قاعدة العينين الأربع تفرضها حماية الفروع في GitHub)
7. الدمج يطلق مزامنة الإنتاج

---

## 5. إدارة الأسرار مع Helm وVault

لا تخزن الأسرار أبدًا في قيم Helm أو Git. استخدم External Secrets Operator ‏(ESO) لمزامنة الأسرار من Vault إلى أسرار Kubernetes.

```yaml
# ExternalSecret resource — ArgoCD manages this manifest.
# If this file is a Helm TEMPLATE, Helm would try to render the {{ .host }}
# placeholders below itself -- escape them: {{ "{{" }} .host }}
apiVersion: external-secrets.io/v1      # v1beta1 in older ESO releases
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

## 6. نمط التطبيق الجامع للتطبيقات (App of Apps)

لمنصة مالية كبيرة بأكثر من 50 خدمة مصغّرة، يتيح نمط App of Apps إدارة كل التطبيقات من تطبيق ArgoCD جذري واحد.

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

ينشئ هذا التطبيق الجذري الواحد عند مزامنته كل موارد Application الفرعية في ArgoCD أو يحدّثها. ثم يدير كل تطبيق فرعي نشر خدمته المصغّرة. ولخدمات متشابهة كثيرة، يُعد **ApplicationSet** (مع مولّد مجلدات Git أو قائمة) الطريقة الأحدث لتوليد التطبيقات الفرعية من قالب واحد.

---

## 7. أتمتة تحديث الصور

للبيئات غير الإنتاجية، يرفع Argo CD Image Updater وسوم الصور تلقائيًا حين تُدفع صور جديدة. ويعرض المثال الإعداد القائم على التعليقات (annotations) في إصدارات 0.x؛ وقد نقل Image Updater 1.x هذا الإعداد إلى مورد مخصص `ImageUpdater` — فتحقق من الإصدار الذي تشغّله:

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

يجب ألا يستخدم الإنتاج تحديثات الصور التلقائية أبدًا. واشترط موافقة صريحة على طلب السحب.

---

## قائمة تحقق الإنتاج

- [ ] كل ملفات `values.yaml` للمخططات ملتزمة في Git — بلا أسرار
- [ ] حماية الفروع: اشتراط موافقتين ونجاح CI قبل الدمج في main
- [ ] ‏ArgoCD ‏`selfHeal: true` — تُلغى تغييرات kubectl اليدوية تلقائيًا (عادةً خلال ثوانٍ؛ ويُستطلع Git نفسه كل 3 دقائق ما لم يُضبط webhook)
- [ ] ‏ArgoCD ‏`prune: true` — الموارد المحذوفة من Git تُزال من العنقود
- [ ] ‏`ignoreDifferences` مضبوط للنسخ التي يديرها HPA (لتجنب حلقة الإلغاء)
- [ ] صلاحيات AppProject في ArgoCD: المطورون يزامنون، والقادة فقط يحذفون
- [ ] وسوم الصور مثبتة في Git (ويُفضّل بالـ digest) — لا وسوم `latest` في الإنتاج
- [ ] موارد ExternalSecret يديرها ArgoCD، لا قيم الأسرار
- [ ] ترقية البيئات تتطلب طلب سحب صريحًا (لا تلقائية)
- [ ] سجل تدقيق ArgoCD يُشحن إلى SIEM (فكل مزامنة حدث تغيير إنتاجي)

---

## الملخص

يمنحك Helm حزم تطبيقات Kubernetes قابلة للتخصيص وذات إصدارات. ويربط GitOps عبر ArgoCD ‏Git بالعنقود، فيحوّل مستودعك إلى سلطة النشر. وللخدمات المالية، يغطي هذا المزيج أغلب متطلبات تتبع النشر والتراجع في ISO 27001 وPCI-DSS — فتاريخ Git هو سجل التدقيق، وحماية الفروع تفرض موافقة العينين الأربع، والإصلاح الذاتي في ArgoCD يجعل الانحراف عن الحالة المعتمدة حدثًا مرئيًا قابلًا للتنبيه بدل انحراف إعدادات صامت.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تطبيق ArgoCD مضبوط بـ syncPolicy.automated.selfHeal=true. ويعدّل مشغّل يدويًا عدد نسخ Deployment في الإنتاج باستخدام kubectl. ماذا يحدث خلال فترة مزامنة ArgoCD التالية؟",
      "options": [
        "لا شيء — التغييرات اليدوية محمية من تجاوزات ArgoCD افتراضيًا",
        "يكتشف ArgoCD الانحراف بين الحالة الحية وحالة Git، ويعيد عدد النسخ إلى ما هو معرّف في Git",
        "يعلّم ArgoCD التطبيق كـ OutOfSync ويرسل تنبيهًا، لكنه لا يلغي التغيير",
        "يحذف ArgoCD الـ Deployment ويعيد إنشاءه لضمان الاتساق الكامل"
      ],
      "correct": 1,
      "explanation": "‏selfHeal=true يعني أن ArgoCD يقارن باستمرار حالة العنقود الحية بالحالة المرغوبة في Git ويزامن أي انحراف تلقائيًا. وتعديل kubectl اليدوي يخلق تباينًا — فعدد النسخ الحي يختلف عن Git. ولأن ArgoCD يراقب الموارد الحية، فعادةً يلاحظ التغيير خلال ثوانٍ ويعيد تطبيق حالة Git، فيلغي التغيير اليدوي (ويُستطلع Git نفسه كل 3 دقائق افتراضيًا، أو فورًا مع webhook). وهذا ضمان GitOps الجوهري: Git مصدر الحقيقة الوحيد، ويجب أن تمر التغييرات عبر Git لتبقى. (وإذا كانت النسخ مدرجة في ignoreDifferences لأن HPA يديرها، فلن يُلغى هذا التغيير بالذات.)"
    },
    {
      "text": "لمخطط Helm ملفات قيم خاصة بالبيئات: values.yaml (افتراضية)، وvalues-staging.yaml (تجاوزات التجهيز)، وvalues-production.yaml (تجاوزات الإنتاج). يضبط مطوّر replicaCount=1 في values.yaml لكن ملف قيم الإنتاج لا يحوي مفتاح replicaCount. كم نسخة يملك نشر الإنتاج؟",
      "options": [
        "0 — يجب أن يضبط ملف قيم الإنتاج كل قيمة مطلوبة صراحة",
        "1 — يرث ملف قيم الإنتاج القيمة الافتراضية من values.yaml لأي مفتاح لم يُتجاوز",
        "خطأ — يتطلب Helm ضبط كل القيم في الملف الخاص بالبيئة",
        "تُستخدم القيمة الافتراضية في Chart.yaml بدلًا من values.yaml"
      ],
      "correct": 1,
      "explanation": "يدمج Helm ملفات القيم بالترتيب: يوفر values.yaml الأساسي كل القيم الافتراضية، وتتجاوز الملفات الخاصة بالبيئات المفاتيح التي تعرّفها فقط. وأي مفتاح غير موجود في ملف التجاوز يرجع إلى قيمة values.yaml الأساسية. فإذا تجاوزت قيم الإنتاج image.tag وحدود الموارد فقط، يسري replicaCount=1 من values.yaml في الإنتاج. وهذا مقصود — تعرّف القيم الافتراضية مرة واحدة وتتجاوز فقط ما يختلف لكل بيئة. ويعني أيضًا أن غياب تجاوز في الإنتاج ليس بالضرورة خطأ."
    },
    {
      "text": "يقيّد AppProject في ArgoCD فريق المدفوعات بـ: sourceRepos=['https://github.com/company/payments-platform']، وdestinations=[{server: 'in-cluster', namespace: 'payments'}]، وclusterResourceWhitelist=[]. ما الذي لا يستطيع فريق المدفوعات فعله؟",
      "options": [
        "نشر تطبيقات من مستودع Git الخاص بالشركة إلى مساحة الأسماء payments",
        "نشر موارد على مستوى العنقود مثل ClusterRole، أو ClusterRoleBinding، أو StorageClass — فقائمة clusterResourceWhitelist الفارغة تمنع كل الموارد على مستوى العنقود",
        "استخدام مخططات Helm بملفات قيم مخزنة في المستودع نفسه",
        "ضبط ArgoCD للمزامنة التلقائية مع تفعيل selfHeal"
      ],
      "correct": 1,
      "explanation": "يتحكم clusterResourceWhitelist في أنواع الموارد على مستوى العنقود (غير المحصورة بمساحة أسماء) التي يسمح بها AppProject. والقائمة الفارغة تعني أن تطبيقات هذا المشروع لا تستطيع إنشاء أي موارد على مستوى العنقود. فلا يستطيع الفريق إنشاء ClusterRole، أو ClusterRoleBinding، أو StorageClass، أو PersistentVolume، أو أي مورد آخر على مستوى العنقود. وهذا مبدأ أقل صلاحية مطبقًا على GitOps: يدير فريق المدفوعات الموارد المحصورة بمساحة الأسماء payments فقط، فتُمنع التغييرات على مستوى العنقود العرضية أو الخبيثة."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "خط GitOps مع Helm وArgoCD لخدمة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    "أنشئ مخطط Helm لخدمة payment-api يحوي Chart.yaml ‏(apiVersion: v2، وversion: 1.0.0)، وvalues.yaml بقيم قابلة للضبط replicaCount/image/resources وعلم pciCompliance، وقالب Deployment يضيف حقول securityContext شرطيًا حين pciCompliance=true، وملفات قيم خاصة بالبيئات (values-staging.yaml بنسخة واحدة، وvalues-production.yaml بثلاث نسخ وحدود موارد). وتحقق من التوليد بـ helm template وhelm lint.",
    "اضبط تطبيق ArgoCD يشير إلى مخطط Helm في مستودع Git لبيئة الإنتاج. وفعّل المزامنة التلقائية مع prune=true وselfHeal=true. وطبّق التطبيق وتحقق من إنشاء نشر payment-api. ثم وسّع النشر يدويًا بـ kubectl scale إلى 5 نسخ وتأكد من أن ArgoCD يعيده إلى 3.",
    "أنشئ AppProject في ArgoCD لفريق المدفوعات يقيّد: sourceRepos بمنظمة GitHub الخاصة بالشركة فقط، والوجهات بمساحة الأسماء payments فقط، وclusterResourceWhitelist بقائمة فارغة. وأنشئ تطبيق ArgoCD ضمن هذا المشروع. وحاول نشر ClusterRole من المستودع نفسه وتحقق من رفضه بقيود AppProject.",
    "نفّذ External Secrets مع ClusterSecretStore متصل بـ HashiCorp Vault. وأنشئ ExternalSecret يجلب كلمة مرور قاعدة البيانات من مسار Vault ‏secret/payments/db ويجسّدها كسر Kubernetes، مع refreshInterval بساعة واحدة. واكتب اختبارًا يدوّر السر في Vault ويتحقق من تحديث سر Kubernetes خلال فترة التحديث، وبيّن كيف يلتقط التطبيق القيمة الجديدة (ملف سر محمّل يُعاد قراءته، أو نشر تلقائي عبر تعليق checksum أو أداة reloader)."
  ]
}
-->
