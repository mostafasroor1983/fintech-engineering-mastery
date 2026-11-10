---
id: track-12-lesson-12
title: "Platform Engineering — Internal Developer Platform Design"
slug: platform-engineering
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 12
difficulty: principal
estimatedMinutes: 85
status: published
tags: [platform-engineering, IDP, developer-experience, golden-path, paved-road]
prerequisites: []
---

# Platform Engineering — Internal Developer Platform Design

> [!NOTE]
> A payment engineer should be able to go from idea to production deployment in one day without understanding Kubernetes YAML, IAM policies, Terraform modules, or PCI-DSS compliance controls. Platform engineering abstracts this complexity behind golden-path templates, self-service provisioning, and a developer portal — letting payment engineers focus on payment logic instead of infrastructure. The platform team is a product team; payment engineers are their customers.

## What is an Internal Developer Platform?

An Internal Developer Platform (IDP) is the collection of tooling, processes, and self-service capabilities that allows product engineers to deploy, monitor, and operate services without requiring deep infrastructure expertise.

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

## Backstage: The Developer Portal

Backstage is the open-source developer portal from Spotify, now a CNCF project. It provides service catalog, documentation, and scaffolding capabilities.

### Backstage Architecture for Fintech

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
  locations:
    # Auto-discover services by scanning all GitHub repos
    - type: github-discovery
      target: https://github.com/fintech/*/blob/main/catalog-info.yaml
    # Explicitly register platform components
    - type: url
      target: https://github.com/fintech/platform/blob/main/catalog-info.yaml

# GitHub integration for scaffolding and repo creation
integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}

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

### Service Catalog Entry (catalog-info.yaml)

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

## Golden-Path Templates: Backstage Scaffolder

The scaffolder generates new services from templates, ensuring all services start with the correct structure, security, and compliance controls.

### Spring Boot Payment Service Template

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
          year: ${{ '' | now | date('YYYY') }}

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

    # Step 5: Provision Kubernetes namespace via GitOps
    - id: provision-namespace
      name: Provision Kubernetes Namespace
      action: github:file:create
      input:
        repoUrl: github.com/fintech/platform-config
        path: clusters/production/namespaces/${{ parameters.name }}.yaml
        message: "feat: provision namespace for ${{ parameters.name }}"
        content: |
          apiVersion: v1
          kind: Namespace
          metadata:
            name: ${{ parameters.name }}
            labels:
              team: ${{ parameters.owner }}
              app.kubernetes.io/managed-by: backstage
              fintech.io/service: ${{ parameters.name }}
              fintech.io/pci-scope: "false"  # engineer updates if needed

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

## Standard Helm Chart: The Paved Road

The platform team maintains a standard Helm chart that encodes all fintech best practices. Product engineers provide only service-specific values.

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

# Health checks — standardized across all services
healthCheck:
  livenessPath: /actuator/health/liveness
  readinessPath: /actuator/health/readiness
  initialDelaySeconds: 30
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
    # Mandatory compliance labels
    fintech.io/pci-scope: {{ .Values.annotations.pciScope | default "false" | quote }}
    fintech.io/data-classification: {{ .Values.annotations.dataClassification | default "internal" | quote }}
  annotations:
    # Last deployed annotation for audit trail
    fintech.io/last-deployed: {{ now | date "2006-01-02T15:04:05Z" | quote }}
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
          livenessProbe:
            httpGet:
              path: {{ .Values.healthCheck.livenessPath }}
              port: {{ .Values.service.port }}
            initialDelaySeconds: {{ .Values.healthCheck.initialDelaySeconds }}
            periodSeconds: {{ .Values.healthCheck.periodSeconds }}
          readinessProbe:
            httpGet:
              path: {{ .Values.healthCheck.readinessPath }}
              port: {{ .Values.service.port }}
            initialDelaySeconds: 5
            periodSeconds: 5

          # Graceful shutdown: drain in-flight requests
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
      terminationGracePeriodSeconds: 30
```

---

## Self-Service Infrastructure Provisioning

Engineers should be able to request databases, queues, and secrets without opening tickets to the platform team.

### Crossplane: Self-Service Database Provisioning

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
  resources:
    - name: rds-instance
      base:
        apiVersion: rds.aws.crossplane.io/v1alpha1
        kind: DBInstance
        spec:
          forProvider:
            region: us-east-1
            engine: postgres
            engineVersion: "15.4"
            multiAZ: true          # always HA for financial data
            storageEncrypted: true
            kmsKeyID: arn:aws:kms:us-east-1:123456789:key/rds-key
            enableIAMDatabaseAuthentication: true
            backupRetentionPeriod: 7
            deletionProtection: true  # prevent accidental deletion
            tags:
              - key: ManagedBy
                value: crossplane
              - key: DataClassification
                value: pii-financial
      patches:
        - fromFieldPath: spec.size
          toFieldPath: spec.forProvider.dbInstanceClass
          transforms:
            - type: map
              map:
                small: db.t3.medium
                medium: db.r6g.large
                large: db.r6g.xlarge
                xlarge: db.r6g.2xlarge
        - fromFieldPath: spec.team
          toFieldPath: spec.forProvider.tags[0].value
          transforms:
            - type: string
              string:
                type: Format
                fmt: "team-%s"
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
# After ~10 minutes:
# kubectl get secret payment-webhooks-db-connection -n payment-webhooks
```

---

## Compliance Guardrails Built Into the Platform

Security and compliance controls should be defaults in the platform, not checklists for engineers to follow manually.

### OPA Gatekeeper: Mandatory Policy Enforcement

```yaml
# OPA Gatekeeper constraint: all deployments must have resource limits
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredResourceLimits
metadata:
  name: require-resource-limits
spec:
  match:
    kinds:
      - apiGroups: [apps]
        kinds: [Deployment, StatefulSet]
    namespaces: [payments, fraud, compliance, risk]
  parameters:
    cpu: "true"
    memory: "true"
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

## Measuring Developer Experience: DORA Metrics

The platform team should measure the developer experience they provide using DORA metrics.

```
DORA Four Key Metrics:

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

# Lead time: average time from PR merge to production deployment
gh pr list \
  --repo fintech/payment-api \
  --state merged \
  --limit 50 \
  --json mergedAt,headRefName \
  | jq '.[] | .mergedAt'
```

---

## Platform Team as a Product Team

The platform team must treat payment engineers as customers, not just users.

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

## Key Takeaways for Principal Engineers

1. **The golden path must be faster than the alternative** — if rolling your own Terraform takes 2 hours and the golden-path template takes 1 day, engineers will roll their own. The golden path must be objectively faster AND safer. This requires investment.

2. **Compliance guardrails go in the platform, not the audit checklist** — if PCI-DSS requires encrypted storage, the platform should provision encrypted storage by default and make unencrypted storage impossible through OPA constraints. Auditors should be able to point at the platform configuration, not check individual services.

3. **Backstage service catalog is a force multiplier** — when every engineer can see every service, its owner, its dependencies, its SLOs, and its runbook in one place, incident response time drops dramatically. The 2am "which service owns this database?" call is eliminated.

4. **Measure developer experience with DORA metrics** — lead time and deployment frequency are the North Star metrics for platform effectiveness. If engineers merge code on Monday and it reaches production on Friday, the platform is failing them regardless of how sophisticated the tooling is.

5. **Crossplane for self-service infrastructure beats tickets** — when a payment engineer can provision a PostgreSQL database with a 5-line YAML that complies with all security requirements automatically, they ship faster and infrastructure is consistent. Ticket-based database provisioning is a 2010 pattern.

6. **The platform team has two customers: engineers and compliance** — the platform must make engineers fast AND satisfy SOC 2, PCI-DSS, and GDPR requirements simultaneously. These goals are not in tension when compliance is built into defaults rather than enforced through manual review.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A Backstage Scaffolder template creates a new payment microservice. After a developer fills in the template form, what artifacts should the template automatically create without any further human intervention?",
      "options": ["Only the GitHub repository with a README and the service's tech stack configured", "The GitHub repository with application scaffolding, a Kubernetes namespace with RBAC, a Backstage catalog-info.yaml entry, a Datadog dashboard, and a PagerDuty service — so the new service is production-ready from day one", "A Jira ticket requesting the platform team to provision the required infrastructure", "The GitHub repository and a Terraform workspace that the developer must manually apply"],
      "correct": 1,
      "explanation": "The golden path template's value is eliminating the multi-day provisioning process by automating everything a new service needs: source control (GitHub repo), infrastructure (Kubernetes namespace, RBAC, network policies), observability (Datadog dashboard, PagerDuty service, Grafana dashboard), CI/CD (GitHub Actions workflow), and service registration (Backstage catalog entry). If the developer must still manually provision any of these, the template has not fully delivered on the golden path promise."
    },
    {
      "text": "A Crossplane Composition creates an RDS PostgreSQL instance when a developer applies a PostgreSQLInstance custom resource. The composition enforces: encryption at rest, automated backups, and a specific VPC subnet group. A developer applies the custom resource without specifying encryption settings. What happens?",
      "options": ["The PostgreSQLInstance is created without encryption because the developer did not specify it", "The Crossplane Composition's default values and patches apply the platform's encryption standard automatically, regardless of what the developer specified — the platform enforces the standard, not the user", "Crossplane rejects the resource and returns a validation error asking the developer to specify encryption settings", "The PostgreSQLInstance is created but Crossplane posts a warning that encryption is recommended"],
      "correct": 1,
      "explanation": "Crossplane Compositions are the platform team's mechanism for encoding infrastructure standards. The Composition defines patches that override or default security-critical settings — if the platform requires encryption at rest, the Composition patches storage.encrypted = true regardless of the input. Developers cannot accidentally create non-compliant infrastructure because the Composition enforces compliance at the infrastructure API layer, not through documentation or checklist review."
    },
    {
      "text": "A platform team measures their effectiveness using DORA metrics. They find: Deployment Frequency = 2 per month, Lead Time for Changes = 8 days. What is the DORA performance category and what platform investment most directly improves lead time?",
      "options": ["High performer; no improvement needed", "Low performer; the most direct improvement is reducing manual approval gates in the deployment pipeline by automating quality verification (automated testing, canary analysis) so human approval is only required for production promotion, not for each environment promotion", "Medium performer; improving lead time requires hiring more engineers rather than platform changes", "Elite performer; a lead time of 8 days is acceptable for financial services"],
      "correct": 1,
      "explanation": "DORA defines Elite performers as deploying multiple times per day with lead time under 1 hour; High performers deploy 1x/day-1x/week with lead time under 1 day; Medium performers deploy 1x/week-1x/month. 2 deployments per month with 8-day lead time is Low performer. The primary driver of long lead time in financial services is typically manual approval gates at each environment (dev→staging→UAT→production). Automating quality verification (automated tests, security scans, canary analysis with Prometheus gates) allows continuous promotion with human approval only at the final production step."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Golden-Path Backstage Template and Crossplane Self-Service Infrastructure",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Create a Backstage Scaffolder template for a new payment microservice that provisions: (a) a GitHub repository from a skeleton with Spring Boot + Actuator, Dockerfile, and GitHub Actions workflow, (b) a Kubernetes namespace with ResourceQuota (CPU 4 cores, memory 8Gi) and NetworkPolicy allowing only ingress from the API gateway namespace, (c) a Backstage catalog-info.yaml Component entry with owner, system, and dependsOn fields populated from template parameters, (d) an ArgoCD Application pointing to the new repo. The template must complete in under 5 minutes."
    },
    {
      "id": "2",
      "description": "Design a Crossplane Composition for a PostgreSQLInstance XRD that provisions an RDS PostgreSQL 15 instance. The Composition must enforce regardless of user input: storage_encrypted = true, backup_retention_period >= 7, deletion_protection = true, publicly_accessible = false, and vpc_security_group_ids from the platform's pre-approved security group. Expose to developers only: instance_class, allocated_storage, and db_name. Write a test using crossplane-tools that verifies a user cannot override the encryption setting."
    },
    {
      "id": "3",
      "description": "Implement an OPA Gatekeeper ConstraintTemplate (FinancialServiceSecurityBaseline) that enforces on all Deployments in namespaces labelled tier=payment: (a) all containers must have readOnlyRootFilesystem: true, (b) runAsNonRoot: true, (c) no container may request privileged: true, (d) all containers must have CPU and memory limits set. Write test cases covering each constraint violation. Document how this policy maps to PCI-DSS Requirement 6.4 (protect public-facing web applications)."
    },
    {
      "id": "4",
      "description": "Implement a DORA metrics collector that tracks for the payment-api service: (a) Deployment Frequency: count ArgoCD sync events per week from the ArgoCD API, (b) Lead Time for Changes: time from first commit in a PR to production ArgoCD sync completion (using GitHub API + ArgoCD API), (c) Change Failure Rate: percentage of deployments followed by a rollback or hotfix within 24 hours, (d) MTTR: mean time from PagerDuty incident open to close for P1/P2 incidents. Store metrics in Prometheus and create a Grafana dashboard. Alert if Lead Time exceeds 2 days."
    }
  ]
}
-->
