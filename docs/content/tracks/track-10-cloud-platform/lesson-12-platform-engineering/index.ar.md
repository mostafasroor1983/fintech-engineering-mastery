---
id: track-10-lesson-12
title: "هندسة المنصات — تصميم منصة داخلية للمطورين"
slug: platform-engineering
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 12
difficulty: principal
estimatedMinutes: 85
status: published
tags: [platform-engineering, IDP, developer-experience, golden-path, paved-road]
prerequisites: []
---

# هندسة المنصات — تصميم منصة المطوّرين الداخلية

> [!NOTE]
> يجب أن يستطيع مهندس المدفوعات الانتقال من الفكرة إلى النشر في الإنتاج في يوم واحد دون فهم YAML في Kubernetes، أو سياسات IAM، أو وحدات Terraform، أو ضوابط امتثال PCI-DSS. وتجرّد هندسة المنصات هذا التعقيد خلف قوالب المسار الذهبي، والتوفير بالخدمة الذاتية، وبوابة المطوّرين — فيركز مهندسو المدفوعات على منطق الدفع بدل البنية التحتية. وفريق المنصة فريق منتج؛ ومهندسو المدفوعات عملاؤه.

## ما منصة المطوّرين الداخلية؟

منصة المطوّرين الداخلية (IDP) مجموعة الأدوات والعمليات وقدرات الخدمة الذاتية التي تتيح لمهندسي المنتجات نشر الخدمات ومراقبتها وتشغيلها دون حاجة إلى خبرة عميقة في البنية التحتية.

```
Without IDP:
  Payment Engineer: "I need to deploy a new payment webhook service"
  Platform Team:    "Open a Jira ticket. We'll provision K8s namespace, IAM roles,
                    database, secrets, CI/CD pipeline, monitoring dashboards, and
                    PagerDuty integration in 2 weeks."
  Engineering velocity: severely limited

With IDP:
  Payment Engineer: "I need to deploy a new payment webhook service"
  IDP:              "Run: idp scaffold --template spring-boot-service --name payment-webhooks
                    Your service is scaffolded with:
                    - Git repository with CI/CD pipeline
                    - Kubernetes namespace with RBAC
                    - Helm chart with sensible defaults
                    - Database provisioned via self-service portal
                    - Datadog dashboards and PagerDuty integration
                    - Security scanning enabled
                    - Compliance labels applied"
  Time to first deployment: 4 hours

IDP components:
  1. Backstage developer portal (catalog, TechDocs, scaffolder)
  2. Golden-path templates (service scaffold, CI/CD pipelines, Helm charts)
  3. Self-service infrastructure provisioning (databases, queues, secrets)
  4. Compliance guardrails built in (not bolted on)
  5. Developer experience metrics (DORA, deploy frequency, lead time)
```

---

## ‏Backstage: بوابة المطوّرين

‏Backstage بوابة المطوّرين مفتوحة المصدر من Spotify، وهي الآن مشروع في CNCF. وتوفر فهرس الخدمات، والتوثيق، وقدرات توليد الهياكل (scaffolding).

### بنية Backstage للتقنية المالية

```yaml
# backstage/app-config.yaml
app:
  title: FinTech Engineering Portal
  baseUrl: https://portal.engineering.fintech.com

backend:
  baseUrl: https://portal.engineering.fintech.com
  listen:
    port: 7007

# Service catalog — where all services are registered
catalog:
  # Auto-discover services by scanning all GitHub repos (GitHub entity
  # provider of the new backend system; replaces "github-discovery" locations)
  providers:
    github:
      fintechOrg:
        organization: fintech
        catalogPath: /catalog-info.yaml
        schedule:
          frequency: { minutes: 30 }
          timeout: { minutes: 3 }
  locations:
    # Explicitly register platform components
    - type: url
      target: https://github.com/fintech/platform/blob/main/catalog-info.yaml

# GitHub integration for scaffolding and repo creation
integrations:
  github:
    - host: github.com
      # Prefer a GitHub App (short-lived, scoped tokens) over a personal token
      apps:
        - $include: github-app-credentials.yaml

# TechDocs: render Markdown documentation in the portal
techdocs:
  builder: external
  generator:
    runIn: docker
  publisher:
    type: awsS3
    awsS3:
      bucketName: fintech-techdocs
      region: us-east-1
      accountId: "123456789"

# Auth: use GitHub SSO (or Okta for fintech)
auth:
  environment: production
  providers:
    github:
      production:
        clientId: ${AUTH_GITHUB_CLIENT_ID}
        clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}
```

### مُدخل فهرس الخدمات (catalog-info.yaml)

```yaml
# Every service in the fintech platform registers itself in Backstage
# This file lives in the service's Git repository root
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-api
  title: Payment API
  description: >
    Core payment processing API. Handles payment authorization, capture,
    and settlement for all payment methods including cards, ACH, and wire.
  annotations:
    # Links to external systems
    github.com/project-slug: fintech/payment-api
    argocd/app-name: payment-api-payment-prod-us-east-1
    prometheus.io/dashboard: https://grafana.fintech.internal/d/payment-api
    pagerduty.com/service-id: P123ABC
    sonarqube.org/project-key: fintech_payment-api
    # Compliance annotations
    fintech.io/data-classification: pii-financial
    fintech.io/pci-scope: "true"
    fintech.io/soc2-controls: "CC6.1,CC6.6,CC7.2"
    # Runbook
    backstage.io/techdocs-ref: dir:.

  tags:
    - java
    - spring-boot
    - payments
    - pci-dss

  links:
    - url: https://api-docs.fintech.internal/payment-api
      title: API Documentation
      icon: web
    - url: https://grafana.fintech.internal/d/payment-api-overview
      title: Grafana Dashboard
      icon: dashboard

spec:
  type: service
  lifecycle: production
  owner: group:payments-platform
  system: payment-processing

  # Declares dependencies — Backstage renders a dependency graph
  dependsOn:
    - component:fraud-detection-api
    - component:compliance-service
    - resource:payment-postgres
    - resource:payment-kafka

  # APIs this service provides
  providesApis:
    - payment-api-v2
```

---

## قوالب المسار الذهبي: مولّد Backstage ‏(Scaffolder)

يولّد الـ Scaffolder خدمات جديدة من قوالب، فيضمن أن تبدأ كل الخدمات بالبنية والأمان وضوابط الامتثال الصحيحة.

### قالب خدمة دفع بـ Spring Boot

```yaml
# templates/spring-boot-payment-service/template.yaml
# This template lives in the platform team's repository
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: spring-boot-payment-service
  title: Spring Boot Payment Service
  description: >
    Creates a production-ready Spring Boot microservice for the payment platform.
    Includes CI/CD pipeline, Kubernetes manifests, monitoring, and compliance controls.
  tags:
    - java
    - spring-boot
    - payments
    - recommended  # marks this as the golden path

spec:
  owner: group:platform-team
  type: service

  # Form shown to the engineer in Backstage UI
  parameters:
    - title: Service Details
      required: [name, description, owner]
      properties:
        name:
          title: Service Name
          type: string
          pattern: '^[a-z][a-z0-9-]*$'
          description: "Lowercase, hyphen-separated (e.g., payment-webhooks)"
        description:
          title: Description
          type: string
          description: "What does this service do?"
        owner:
          title: Owner Team
          type: string
          ui:field: OwnerPicker
          ui:options:
            allowedKinds: [Group]

    - title: Infrastructure
      required: [database, kafkaTopics]
      properties:
        database:
          title: Needs a Database?
          type: string
          enum: [none, postgresql, redis]
          default: postgresql
        kafkaTopics:
          title: Kafka Topics (comma-separated)
          type: string
          description: "Topics to subscribe to (e.g., payments.incoming,payments.completed)"
        estimatedRPS:
          title: Estimated Requests Per Second (peak)
          type: integer
          default: 100
        pciScope:
          title: Handles cardholder data (PCI scope)?
          type: boolean
          default: false

  steps:
    # Step 1: Create GitHub repository
    - id: create-repo
      name: Create GitHub Repository
      action: github:repo:create
      input:
        repoUrl: github.com/fintech/${{ parameters.name }}
        defaultBranch: main
        repoVisibility: private
        topics: [java, spring-boot, payments, fintech]

    # Step 2: Scaffold from template files
    - id: scaffold
      name: Scaffold Service
      action: fetch:template
      input:
        url: ./skeleton  # template files directory
        values:
          name: ${{ parameters.name }}
          description: ${{ parameters.description }}
          owner: ${{ parameters.owner }}
          database: ${{ parameters.database }}
          kafkaTopics: ${{ parameters.kafkaTopics }}
          estimatedRPS: ${{ parameters.estimatedRPS }}

    # Step 3: Push scaffolded code to repo
    - id: publish
      name: Publish to GitHub
      action: github:repo:push
      input:
        repoUrl: github.com/fintech/${{ parameters.name }}
        defaultBranch: main
        commitMessage: "feat: initial scaffold from platform template"

    # Step 4: Register in Backstage catalog
    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: https://github.com/fintech/${{ parameters.name }}/blob/main
        catalogInfoPath: /catalog-info.yaml

    # Step 5: Provision Kubernetes namespace via GitOps -- as a PULL REQUEST
    # to the platform-config repo, so the change is reviewed (four eyes)
    # before Argo CD applies it
    - id: namespace-files
      name: Render Namespace Manifest
      action: fetch:template
      input:
        url: ./namespace-template      # contains ${{ values.name }}.yaml
        targetPath: ./platform-config
        values:
          name: ${{ parameters.name }}
          # an owner like "group:default/payments" is not a valid label value
          team: ${{ parameters.owner | parseEntityRef | pick('name') }}
          pciScope: ${{ parameters.pciScope }}   # asked in the form; PCI-scope
                                                 # namespaces get extra controls

    - id: provision-namespace
      name: Open Pull Request for Namespace
      action: publish:github:pull-request
      input:
        repoUrl: github.com?owner=fintech&repo=platform-config
        branchName: namespace-${{ parameters.name }}
        title: "feat: provision namespace for ${{ parameters.name }}"
        description: "Requested via Backstage golden-path template"
        sourcePath: ./platform-config
        targetPath: clusters/production/namespaces

  output:
    links:
      - title: GitHub Repository
        url: https://github.com/fintech/${{ parameters.name }}
      - title: CI/CD Pipeline
        url: https://github.com/fintech/${{ parameters.name }}/actions
      - title: Service in Catalog
        entityRef: ${{ steps['register'].output.entityRef }}
```

---

## مخطط Helm القياسي: الطريق الممهّد

يصون فريق المنصة مخطط Helm قياسيًا يرمّز كل أفضل ممارسات التقنية المالية. ويوفر مهندسو المنتجات القيم الخاصة بخدمتهم فقط.

```yaml
# platform-service/Chart.yaml — the golden-path Helm chart
apiVersion: v2
name: platform-service
description: Standard Helm chart for all fintech microservices
version: 3.2.1
appVersion: "1.0"

# platform-service/values.yaml — defaults encoding best practices
# Engineers override only what they need
replicaCount: 2  # minimum for HA

image:
  repository: ""  # required
  tag: ""         # required — no "latest" in production
  pullPolicy: IfNotPresent

# Resources: sensible defaults, engineers adjust
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 1Gi

# Health checks — standardized across all services (a startupProbe covers
# JVM start-up, so liveness needs no guessed initial delay)
healthCheck:
  livenessPath: /actuator/health/liveness
  readinessPath: /actuator/health/readiness
  startupFailureThreshold: 30     # x 5s = up to 150s to start
  periodSeconds: 10

# Security context — enforced for all services
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]

# Mandatory labels — applied to all resources
labels:
  team: ""         # required
  environment: ""  # injected by CI/CD
  version: ""      # injected by CI/CD

# Mandatory annotations for compliance
annotations:
  fintech.io/pci-scope: "false"
  fintech.io/data-classification: "internal"

# PodDisruptionBudget: always enabled
podDisruptionBudget:
  enabled: true
  minAvailable: 1

# Network policy: default deny-all with explicit allowlist
networkPolicy:
  enabled: true
  ingressRules: []  # engineer specifies allowed ingress

# Autoscaling: disabled by default, engineers opt in
autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

# Monitoring: always enabled
monitoring:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 30s
    path: /actuator/prometheus

# Service: ClusterIP by default (no accidental public exposure)
service:
  type: ClusterIP
  port: 8080
```

```yaml
# platform-service/templates/deployment.yaml
# Template enforces all mandatory configurations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "platform-service.fullname" . }}
  labels:
    {{- include "platform-service.labels" . | nindent 4 }}
    # Mandatory compliance labels (keys contain dots and slashes, so they
    # must be read with "index" -- .Values.annotations.pciScope would not
    # exist and silently fall back to the default)
    fintech.io/pci-scope: {{ index .Values.annotations "fintech.io/pci-scope" | default "false" | quote }}
    fintech.io/data-classification: {{ index .Values.annotations "fintech.io/data-classification" | default "internal" | quote }}
  annotations:
    # No "now" timestamp here: it would change on every render and keep
    # Argo CD permanently OutOfSync. The Git commit and the Argo CD sync
    # history are the deployment audit trail.
    fintech.io/deployed-by: {{ .Values.deployedBy | default "ci" | quote }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "platform-service.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "platform-service.selectorLabels" . | nindent 8 }}
        version: {{ .Values.image.tag | quote }}
    spec:
      # Anti-affinity: spread across nodes and AZs
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    {{- include "platform-service.selectorLabels" . | nindent 20 }}
                topologyKey: kubernetes.io/hostname
            - weight: 50
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    {{- include "platform-service.selectorLabels" . | nindent 20 }}
                topologyKey: topology.kubernetes.io/zone

      securityContext:
        {{- toYaml .Values.securityContext | nindent 8 }}

      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - containerPort: {{ .Values.service.port }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          startupProbe:
            httpGet:
              path: {{ .Values.healthCheck.livenessPath }}
              port: {{ .Values.service.port }}
            periodSeconds: 5
            failureThreshold: {{ .Values.healthCheck.startupFailureThreshold }}
          livenessProbe:
            httpGet:
              path: {{ .Values.healthCheck.livenessPath }}
              port: {{ .Values.service.port }}
            periodSeconds: {{ .Values.healthCheck.periodSeconds }}
          readinessProbe:
            httpGet:
              path: {{ .Values.healthCheck.readinessPath }}
              port: {{ .Values.service.port }}
            periodSeconds: 5

          # Graceful shutdown: drain in-flight requests
          lifecycle:
            preStop:
              sleep:              # native sleep action (Kubernetes 1.30+)
                seconds: 5
      terminationGracePeriodSeconds: 30
```

---

## توفير البنية التحتية بالخدمة الذاتية

يجب أن يستطيع المهندسون طلب قواعد البيانات، والطوابير، والأسرار دون فتح تذاكر لفريق المنصة.

### ‏Crossplane: توفير قواعد البيانات بالخدمة الذاتية

يستخدم المثال مزوّد AWS من Upbound وComposition بوضع *pipeline* (مع دالة patch-and-transform) — وهو الشكل الذي تتوقعه إصدارات Crossplane الحالية. ويجعل Crossplane v2 أيضًا الموارد المركبة محصورة بمساحة أسماء ويُسقط الـ claims؛ وتبقى الفكرة نفسها.

```yaml
# Crossplane Composite Resource Definition (XRD)
# Defines a "PaymentDatabase" resource that engineers can request
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpaymentdatabases.fintech.io
spec:
  group: fintech.io
  names:
    kind: XPaymentDatabase
    plural: xpaymentdatabases
  claimNames:
    kind: PaymentDatabase     # engineers use this simplified claim
    plural: paymentdatabases
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                size:
                  type: string
                  enum: [small, medium, large, xlarge]
                  description: "small=db.t3.medium, medium=db.r6g.large, large=db.r6g.xlarge, xlarge=db.r6g.2xlarge"
                team:
                  type: string
                  description: "Team name for cost allocation"
                serviceNamespace:
                  type: string
                  description: "Kubernetes namespace where the connection secret will be created"
              required: [size, team, serviceNamespace]
---
# Composition: maps PaymentDatabase claim to actual AWS RDS resources
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: payment-database-aws-rds
spec:
  compositeTypeRef:
    apiVersion: fintech.io/v1alpha1
    kind: XPaymentDatabase
  mode: Pipeline
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: rds-instance
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: Instance
              spec:
                forProvider:
                  region: us-east-1
                  engine: postgres
                  engineVersion: "16"
                  multiAz: true             # always HA for financial data
                  storageEncrypted: true    # fixed here -- not exposed in
                  kmsKeyIdSelector:         # the XRD, so users can't change it
                    matchLabels:
                      purpose: rds
                  iamDatabaseAuthenticationEnabled: true
                  backupRetentionPeriod: 7
                  deletionProtection: true  # prevent accidental deletion
                  publiclyAccessible: false
                  autoGeneratePassword: true
                  username: dbadmin
                  passwordSecretRef:
                    namespace: crossplane-system
                    name: rds-master-password   # generated, never typed
                    key: password
                  tags:
                    ManagedBy: crossplane
                    DataClassification: pii-financial
                writeConnectionSecretToRef:
                  namespace: crossplane-system
            connectionDetails:
              - name: endpoint
                fromConnectionSecretKey: endpoint
              - name: port
                fromConnectionSecretKey: port
            patches:
              - fromFieldPath: spec.size
                toFieldPath: spec.forProvider.instanceClass
                transforms:
                  - type: map
                    map:
                      small: db.t3.medium
                      medium: db.r6g.large
                      large: db.r6g.xlarge
                      xlarge: db.r6g.2xlarge
              # Team tag as its own key -- patching a list index such as
              # tags[0] would overwrite whichever tag happens to be first
              - fromFieldPath: spec.team
                toFieldPath: spec.forProvider.tags.Team
              - fromFieldPath: metadata.uid
                toFieldPath: spec.writeConnectionSecretToRef.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-rds"
---
# How an engineer provisions a database (no Terraform, no ticket):
# kubectl apply -f payment-webhooks-db.yaml
apiVersion: fintech.io/v1alpha1
kind: PaymentDatabase
metadata:
  name: payment-webhooks-db
  namespace: payment-webhooks
spec:
  size: small
  team: payments-platform
  serviceNamespace: payment-webhooks
  # where the connection details (endpoint, port) are written
  writeConnectionSecretToRef:
    name: payment-webhooks-db-connection
# After ~10 minutes:
# kubectl get secret payment-webhooks-db-connection -n payment-webhooks
```

---

## ضوابط الامتثال المدمجة في المنصة

يجب أن تكون ضوابط الأمان والامتثال افتراضيات في المنصة، لا قوائم تحقق يتبعها المهندسون يدويًا.

### ‏OPA Gatekeeper: فرض السياسات الإلزامية

```yaml
# OPA Gatekeeper constraint: all pods must have resource limits
# (constraint kinds come from installed ConstraintTemplates -- these three
#  are from the Gatekeeper policy library. Matching Pods catches pods from
#  every controller: Deployments, StatefulSets, Jobs...)
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredResources
metadata:
  name: require-resource-limits
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: [Pod]
    namespaces: [payments, fraud, compliance, risk]
  parameters:
    limits: ["cpu", "memory"]
---
# Constraint: all pods must run as non-root
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPAllowedUsers
metadata:
  name: pod-must-run-as-non-root
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: [Pod]
    excludedNamespaces: [kube-system]
  parameters:
    runAsUser:
      rule: MustRunAsNonRoot
---
# Constraint: container images must come from approved registry
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: approved-image-registries
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: [Pod]
    excludedNamespaces: [kube-system]
  parameters:
    repos:
      - 123456789.dkr.ecr.us-east-1.amazonaws.com/fintech/
      - registry.k8s.io/
      - quay.io/prometheus/
```

---

## قياس تجربة المطوّرين: مقاييس DORA

يجب أن يقيس فريق المنصة تجربة المطوّرين التي يقدمها باستخدام مقاييس DORA.

```
DORA Four Key Metrics (thresholds from the DORA research; the
categories and cut-offs shift between yearly reports -- e.g. "elite"
lead time was < 1 hour in 2021 and < 1 day in 2023; MTTR is now called
"failed deployment recovery time"):

  1. Deployment Frequency
     What: How often does a team deploy to production?
     Elite: Multiple times per day
     Good:  Once per week to once per month
     Measure: count(production deployments) / time period

  2. Lead Time for Changes
     What: Time from code commit to production deployment
     Elite: Less than 1 hour
     Good:  1 day to 1 week
     Measure: time(production deploy) - time(first commit)

  3. Mean Time to Restore (MTTR)
     What: Time to restore service after a production incident
     Elite: Less than 1 hour
     Good:  1 day
     Measure: time(incident resolved) - time(incident started)

  4. Change Failure Rate
     What: Percentage of deployments causing production incidents
     Elite: 0-5%
     Good:  11-15%
     Measure: count(failed deployments) / count(total deployments)

Fintech target:
  Deployment Frequency: once per day per service (not once per sprint)
  Lead Time:            less than 4 hours from merge to production
  MTTR:                 less than 30 minutes (payment downtime = revenue loss)
  Change Failure Rate:  less than 5% (financial systems cannot afford regressions)
```

```bash
# Calculating DORA metrics from GitHub Actions and PagerDuty (via CLI)
# Deployment frequency for the last 30 days
gh run list \
  --repo fintech/payment-api \
  --workflow deploy-production.yml \
  --status success \
  --created ">=2026-10-09" \
  --json createdAt \
  | jq 'length'

# Lead time: needs BOTH timestamps -- first commit (or merge) of a change
# and the production deployment that shipped it. Collect the merge times
# here and join them with deployment times (e.g. from Argo CD history)
gh pr list \
  --repo fintech/payment-api \
  --state merged \
  --limit 50 \
  --json number,mergedAt,mergeCommit \
  | jq '.[] | {number, mergedAt, sha: .mergeCommit.oid}'
```

---

## فريق المنصة كفريق منتج

يجب أن يعامل فريق المنصة مهندسي المدفوعات كعملاء، لا مجرد مستخدمين.

```
Platform team operating model:

  OKR example (not vanity metrics):
    Key Result 1: 80% of new services deployed via golden-path template (not custom YAML)
    Key Result 2: Time from service creation to first production deployment < 4 hours
    Key Result 3: Median lead time for all payment services < 2 hours (DORA)
    Key Result 4: 100% of production deployments pass automated security scan

  Monthly platform review:
    - Developer satisfaction survey (Net Promoter Score for the platform)
    - DORA metrics dashboard: deployment frequency trend, lead time trend
    - Support ticket analysis: recurring pain points = missing platform features
    - Adoption metrics: how many teams using golden-path vs custom

  Anti-pattern: platform team as ticket-taking ops team
    - Engineers open tickets for every change
    - Platform team is a bottleneck (not an enabler)
    - Engineers bypass the platform (custom Terraform, hand-written YAML)
    - Security controls are audited manually, not enforced automatically

  Correct model: platform team as infrastructure product team
    - Self-service capabilities for 90% of needs
    - Platform engineers talk to payment engineers as customers
    - Platform roadmap driven by developer pain points
    - Compliance guardrails are code, not checklists
```

---

## الخلاصات الأساسية للمهندسين الرئيسيين

1. **يجب أن يكون المسار الذهبي أسرع من البديل** — إذا كان كتابة Terraform الخاص بك تستغرق ساعتين وقالب المسار الذهبي يستغرق يومًا، فسيكتب المهندسون الخاص بهم. ويجب أن يكون المسار الذهبي أسرع وأكثر أمانًا موضوعيًا. وهذا يتطلب استثمارًا.

2. **ضوابط الامتثال مكانها المنصة، لا قائمة التدقيق** — إذا تطلب PCI-DSS تخزينًا مشفرًا، فيجب أن توفر المنصة تخزينًا مشفرًا افتراضيًا وتجعل التخزين غير المشفر مستحيلًا عبر قيود OPA. ويجب أن يستطيع المدققون الإشارة إلى إعدادات المنصة، لا فحص الخدمات فردًا فردًا.

3. **فهرس خدمات Backstage مضاعف للقوة** — حين يستطيع كل مهندس رؤية كل خدمة، ومالكها، واعتمادياتها، وأهداف مستوى خدمتها، ودليل تشغيلها في مكان واحد، ينخفض زمن الاستجابة للحوادث بشكل كبير. ويختفي اتصال الثانية فجرًا "أي خدمة تملك قاعدة البيانات هذه؟".

4. **قِس تجربة المطوّرين بمقاييس DORA** — زمن التسليم وتكرار النشر مقياسا نجم الشمال لفعالية المنصة. فإذا دمج المهندسون الشيفرة يوم الاثنين ووصلت إلى الإنتاج يوم الجمعة، فالمنصة تخذلهم مهما كانت أدواتها متطورة.

5. **‏Crossplane للبنية التحتية بالخدمة الذاتية يتفوق على التذاكر** — حين يستطيع مهندس المدفوعات توفير قاعدة بيانات PostgreSQL بـ YAML من 5 أسطر تمتثل لكل متطلبات الأمان تلقائيًا، يسلّم أسرع وتكون البنية التحتية متسقة. وتوفير قواعد البيانات بالتذاكر نمط من عام 2010.

6. **لفريق المنصة عميلان: المهندسون والامتثال** — يجب أن تجعل المنصة المهندسين سريعين وأن تلبي متطلبات SOC 2، وPCI-DSS، وGDPR في آن واحد. وهذان الهدفان ليسا متعارضين حين يكون الامتثال مدمجًا في الافتراضيات بدل فرضه عبر المراجعة اليدوية.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ينشئ قالب Scaffolder في Backstage خدمة دفع مصغّرة جديدة. بعد أن يملأ المطوّر نموذج القالب، ما المخرجات التي يجب أن ينشئها القالب تلقائيًا دون أي تدخل بشري إضافي؟",
      "options": ["مستودع GitHub فقط مع README وإعداد التقنيات المستخدمة في الخدمة", "مستودع GitHub مع هيكل التطبيق، ومساحة أسماء Kubernetes مع RBAC، ومُدخل catalog-info.yaml في Backstage، ولوحة Datadog، وخدمة PagerDuty — كي تكون الخدمة الجديدة جاهزة للإنتاج من اليوم الأول", "تذكرة Jira تطلب من فريق المنصة توفير البنية التحتية المطلوبة", "مستودع GitHub ومساحة عمل Terraform يجب على المطوّر تطبيقها يدويًا"],
      "correct": 1,
      "explanation": "قيمة قالب المسار الذهبي إلغاء عملية التوفير التي تستغرق أيامًا بأتمتة كل ما تحتاجه خدمة جديدة: إدارة الشيفرة (مستودع GitHub)، والبنية التحتية (مساحة أسماء Kubernetes، وRBAC، وسياسات الشبكة)، والرصد (لوحة Datadog، وخدمة PagerDuty، ولوحة Grafana)، وCI/CD ‏(سير عمل GitHub Actions)، وتسجيل الخدمة (مُدخل فهرس Backstage). وإذا كان على المطوّر توفير أي من هذه يدويًا، فالقالب لم يفِ بوعد المسار الذهبي كاملًا."
    },
    {
      "text": "ينشئ Composition في Crossplane نسخة RDS PostgreSQL حين يطبّق مطوّر مورد PostgreSQLInstance مخصصًا. ويفرض الـ Composition: التشفير أثناء التخزين، والنسخ الاحتياطي الآلي، ومجموعة شبكات فرعية محددة في VPC. ويطبّق مطوّر المورد المخصص دون تحديد إعدادات التشفير. ماذا يحدث؟",
      "options": ["تُنشأ نسخة PostgreSQLInstance دون تشفير لأن المطوّر لم يحدده", "تطبّق القيم الافتراضية والتعديلات (patches) في Composition معيار التشفير للمنصة تلقائيًا، بغض النظر عما حدده المطوّر — فالمنصة تفرض المعيار، لا المستخدم", "يرفض Crossplane المورد ويعيد خطأ تحقق يطلب من المطوّر تحديد إعدادات التشفير", "تُنشأ نسخة PostgreSQLInstance لكن Crossplane ينشر تحذيرًا بأن التشفير موصى به"],
      "correct": 1,
      "explanation": "‏Compositions في Crossplane آلية فريق المنصة لترميز معايير البنية التحتية. فالإعدادات الحرجة أمنيًا مثل تشفير التخزين مضبوطة في المورد الأساسي للـ Composition وليست جزءًا أصلًا من مخطط XRD الذي يملؤه المطوّر — فلا يوجد حقل لإغفاله أو تجاوزه. وتُطبّق فقط المعاملات المكشوفة (الحجم، والفريق، ...). ولا يستطيع المطوّرون إنشاء بنية تحتية غير ممتثلة عرضيًا لأن Composition تفرض الامتثال على طبقة واجهة البنية التحتية، لا عبر التوثيق أو مراجعة قوائم التحقق."
    },
    {
      "text": "يقيس فريق منصة فعاليته باستخدام مقاييس DORA. ويجد: تكرار النشر = مرتين شهريًا، وزمن التسليم للتغييرات = 8 أيام. ما فئة أداء DORA وما استثمار المنصة الذي يحسّن زمن التسليم مباشرة؟",
      "options": ["أداء عالٍ؛ لا حاجة لتحسين", "أداء متوسط؛ والتحسين الأكثر مباشرة تقليل بوابات الموافقة اليدوية في خط النشر بأتمتة التحقق من الجودة (الاختبار الآلي، وتحليل الكناري) كي تُطلب الموافقة البشرية فقط لترقية الإنتاج، لا لكل ترقية بيئة", "أداء منخفض؛ تحسين زمن التسليم يتطلب توظيف مهندسين أكثر بدل تغييرات المنصة", "أداء نخبوي؛ زمن تسليم 8 أيام مقبول للخدمات المالية"],
      "correct": 1,
      "explanation": "في تقارير DORA الحديثة، النشر بين مرة أسبوعيًا ومرة شهريًا بزمن تسليم بين أسبوع وشهر هو فئة الأداء المتوسط؛ وأصحاب الأداء العالي ينشرون بين يوميًا وأسبوعيًا بأزمنة تسليم من يوم إلى أسبوع، والنخبويون ينشرون عند الطلب بأزمنة تسليم أقل من يوم. فنشران شهريًا بزمن تسليم 8 أيام أداء متوسط. والمحرك الأساسي لأزمنة التسليم الطويلة في الخدمات المالية عادةً بوابات الموافقة اليدوية في كل بيئة (تطوير←تجهيز←قبول المستخدم←إنتاج). وأتمتة التحقق من الجودة (الاختبارات الآلية، وفحوص الأمان، وتحليل الكناري ببوابات Prometheus) تتيح ترقية مستمرة مع موافقة بشرية فقط في خطوة الإنتاج الأخيرة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء قالب Backstage للمسار الذهبي وبنية تحتية بالخدمة الذاتية عبر Crossplane",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "أنشئ قالب Scaffolder في Backstage لخدمة دفع مصغّرة جديدة يوفّر: (أ) مستودع GitHub من هيكل يحوي Spring Boot + Actuator، وDockerfile، وسير عمل GitHub Actions، (ب) مساحة أسماء Kubernetes مع ResourceQuota ‏(4 أنوية معالج، و8Gi ذاكرة) وNetworkPolicy تسمح فقط بالدخول من مساحة أسماء بوابة الواجهات، (ج) مُدخل Component في catalog-info.yaml لـ Backstage بحقول owner، وsystem، وdependsOn مملوءة من معاملات القالب، (د) تطبيق ArgoCD يشير إلى المستودع الجديد. ويجب أن يكتمل القالب في أقل من 5 دقائق."
    },
    {
      "id": "2",
      "description": "صمّم Composition في Crossplane لـ XRD ‏PostgreSQLInstance يوفّر نسخة RDS PostgreSQL. ويجب أن يفرض الـ Composition بغض النظر عن مدخلات المستخدم: تشفير التخزين، واحتفاظًا بالنسخ الاحتياطية ≥ 7 أيام، وحماية من الحذف، ومنع الوصول العام، ومجموعة الأمان المعتمدة مسبقًا من المنصة. واكشف للمطوّرين فقط: فئة النسخة، والتخزين المخصص، واسم قاعدة البيانات. واستخدم crossplane render ‏(وcrossplane beta validate) في CI للتحقق من أن الموارد المولّدة تبقي التشفير مفعّلًا مهما احتوى الطلب."
    },
    {
      "id": "3",
      "description": "نفّذ ConstraintTemplate في OPA Gatekeeper ‏(FinancialServiceSecurityBaseline) يفرض على كل الـ Pods في مساحات الأسماء المسماة tier=payment: (أ) أن تملك كل الحاويات readOnlyRootFilesystem: true، (ب) runAsNonRoot: true، (ج) ألا تطلب أي حاوية privileged: true، (د) أن تملك كل الحاويات حدود معالج وذاكرة. واكتب حالات اختبار تغطي كل مخالفة. ووثّق كيف تدعم هذه السياسة متطلب PCI-DSS رقم 2.2 (مكونات النظام مضبوطة ومُدارة بأمان)."
    },
    {
      "id": "4",
      "description": "نفّذ مُجمّع مقاييس DORA يتتبع لخدمة payment-api: (أ) تكرار النشر: عدّ أحداث مزامنة ArgoCD أسبوعيًا من واجهة ArgoCD، (ب) زمن التسليم للتغييرات: الزمن من أول commit في طلب سحب حتى اكتمال مزامنة ArgoCD في الإنتاج (باستخدام واجهتي GitHub وArgoCD)، (ج) معدل فشل التغييرات: نسبة النشرات التي يتبعها تراجع أو إصلاح عاجل خلال 24 ساعة، (د) MTTR: متوسط الزمن من فتح حادث PagerDuty إلى إغلاقه لحوادث P1/P2. وخزّن المقاييس في Prometheus وأنشئ لوحة Grafana. ونبّه إذا تجاوز زمن التسليم يومين."
    }
  ]
}
-->
