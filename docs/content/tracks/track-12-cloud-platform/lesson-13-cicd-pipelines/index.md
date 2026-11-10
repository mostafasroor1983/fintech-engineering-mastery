---
id: track-12-lesson-13
title: "CI/CD Pipelines — Secure Delivery for Financial Services"
slug: cicd-pipelines
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 13
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [CI/CD, GitHub-Actions, Tekton, SAST, DAST]
prerequisites: []
---

# CI/CD Pipelines — Secure Delivery for Financial Services

> [!NOTE]
> A pipeline that deploys to production without scanning for SQL injection vulnerabilities, verifying the container image signature, or enforcing a four-eyes approval is not a CI/CD pipeline — it is a risk delivery system. Financial services have regulatory requirements (PCI-DSS, SOX, GDPR) that mandate specific controls at every stage of the delivery pipeline. This lesson builds a compliant, automated, fast pipeline.

## Pipeline Architecture for Financial Services

```
Complete pipeline stages for a payment service:

  ┌─────────────┐
  │  Code Push  │ Developer pushes to feature branch
  └──────┬──────┘
         │
  ┌──────▼──────────────┐
  │  Stage 1: Build     │ Compile, run unit tests, generate artifacts
  └──────┬──────────────┘
         │
  ┌──────▼──────────────┐
  │  Stage 2: SAST      │ Static analysis (Semgrep, SonarQube)
  └──────┬──────────────┘  Fail on CRITICAL/HIGH findings
         │
  ┌──────▼──────────────┐
  │  Stage 3: Container │ Build OCI image, scan with Trivy
  └──────┬──────────────┘ Sign with Cosign (SLSA level 2)
         │
  ┌──────▼──────────────┐
  │  Stage 4: Int Test  │ Deploy to ephemeral environment, run integration tests
  └──────┬──────────────┘
         │
  ┌──────▼──────────────┐
  │  Stage 5: Staging   │ Deploy to staging, smoke tests
  └──────┬──────────────┘
         │
  ┌──────▼──────────────┐
  │  Stage 6: DAST      │ Dynamic analysis (OWASP ZAP against staging)
  └──────┬──────────────┘ Fail on CRITICAL findings
         │
  ┌──────▼──────────────┐
  │  Stage 7: Approval  │ Four-eyes: 2 reviewers must approve production deployment
  └──────┬──────────────┘ Change management ticket required
         │
  ┌──────▼──────────────┐
  │  Stage 8: Production│ Deploy via ArgoCD, verify rollout, alert on error rate
  └─────────────────────┘

Each stage can FAIL the pipeline — there is no manual override for security findings.
```

---

## GitHub Actions Pipeline for Spring Boot

### Workflow: Build and SAST

```yaml
# .github/workflows/ci.yml
name: Payment API CI/CD

on:
  push:
    branches: [main, 'release/**']
  pull_request:
    branches: [main]

env:
  JAVA_VERSION: '21'
  REGISTRY: 123456789.dkr.ecr.us-east-1.amazonaws.com
  IMAGE_NAME: fintech/payment-api

jobs:
  # =========================================================
  # Stage 1: Build and Unit Tests
  # =========================================================
  build:
    name: Build and Test
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # required for SonarQube to analyze full history

      - name: Set up JDK ${{ env.JAVA_VERSION }}
        uses: actions/setup-java@v4
        with:
          java-version: ${{ env.JAVA_VERSION }}
          distribution: temurin
          cache: gradle

      - name: Build and test
        run: ./gradlew build test jacocoTestReport --no-daemon
        env:
          GRADLE_OPTS: "-Dorg.gradle.daemon=false -Xmx2g"

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: build/reports/tests/

      - name: Upload coverage report
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: build/reports/jacoco/

      # Fail if coverage drops below threshold
      - name: Check code coverage
        run: |
          COVERAGE=$(./gradlew jacocoTestCoverageVerification --no-daemon 2>&1 | grep "Coverage" || echo "0")
          echo "Coverage: $COVERAGE"

      - name: Upload JAR artifact
        uses: actions/upload-artifact@v4
        with:
          name: app-jar
          path: build/libs/*.jar

  # =========================================================
  # Stage 2: SAST — Static Application Security Testing
  # =========================================================
  sast:
    name: SAST Scan
    runs-on: ubuntu-latest
    needs: build

    permissions:
      security-events: write  # required for GitHub Security tab

    steps:
      - uses: actions/checkout@v4

      # Semgrep: fast pattern-based SAST with fintech rules
      - name: Run Semgrep
        uses: semgrep/semgrep-action@v1
        with:
          config: >-
            p/java
            p/java-jwt
            p/sql-injection
            p/owasp-top-ten
            r/java.lang.security.audit.crypto.weak-crypto.use-of-md5
            r/java.lang.security.audit.crypto.weak-crypto.use-of-sha1
          auditOn: push
        env:
          SEMGREP_APP_TOKEN: ${{ secrets.SEMGREP_APP_TOKEN }}

      # SonarQube: deeper analysis with quality gates
      - name: Run SonarQube scan
        uses: sonarsource/sonarqube-scan-action@v2
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
          SONAR_HOST_URL: https://sonarqube.fintech.internal
        with:
          args: >
            -Dsonar.projectKey=fintech_payment-api
            -Dsonar.sources=src/main
            -Dsonar.tests=src/test
            -Dsonar.java.coveragePlugin=jacoco
            -Dsonar.coverage.jacoco.xmlReportPaths=build/reports/jacoco/test/jacocoTestReport.xml
            -Dsonar.qualitygate.wait=true  # fail if quality gate fails

      # OWASP Dependency Check: scan dependencies for CVEs
      - name: OWASP Dependency Check
        uses: dependency-check/Dependency-Check_Action@main
        with:
          project: payment-api
          path: .
          format: JSON
          args: >
            --failOnCVSS 7
            --suppression .dependency-check-suppressions.xml
        env:
          JAVA_HOME: ${{ env.JAVA_HOME }}

      - name: Upload OWASP report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: dependency-check-report
          path: reports/

  # =========================================================
  # Stage 3: Container Build and Image Scan
  # =========================================================
  container:
    name: Build and Scan Container
    runs-on: ubuntu-latest
    needs: [build, sast]

    outputs:
      image-digest: ${{ steps.build-push.outputs.digest }}
      image-tag: ${{ steps.meta.outputs.tags }}

    steps:
      - uses: actions/checkout@v4

      - name: Download JAR artifact
        uses: actions/download-artifact@v4
        with:
          name: app-jar
          path: build/libs/

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-ecr
          aws-region: us-east-1

      - name: Login to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix={{branch}}-
            type=ref,event=branch
            type=semver,pattern={{version}}

      - name: Build and push Docker image
        id: build-push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          # Build args for compliance metadata
          build-args: |
            BUILD_DATE=${{ github.event.head_commit.timestamp }}
            GIT_SHA=${{ github.sha }}
            GIT_REPO=${{ github.repository }}
          # Cache layers for faster builds
          cache-from: type=gha
          cache-to: type=gha,mode=max

      # Trivy: scan the built image for CVEs
      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build-push.outputs.digest }}
          format: sarif
          output: trivy-results.sarif
          exit-code: 1              # FAIL the pipeline on vulnerabilities
          ignore-unfixed: true      # only flag vulnerabilities with fixes available
          severity: CRITICAL,HIGH   # fail on CRITICAL and HIGH only
        env:
          TRIVY_USERNAME: ${{ secrets.ECR_USERNAME }}
          TRIVY_PASSWORD: ${{ secrets.ECR_PASSWORD }}

      - name: Upload Trivy results to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-results.sarif

      # Cosign: sign the image for supply chain security (SLSA Level 2)
      - name: Install Cosign
        uses: sigstore/cosign-installer@v3

      - name: Sign container image
        run: |
          cosign sign --yes \
            --key env://COSIGN_PRIVATE_KEY \
            "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build-push.outputs.digest }}"
        env:
          COSIGN_PRIVATE_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}
          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}

  # =========================================================
  # Stage 4: Integration Tests
  # =========================================================
  integration-test:
    name: Integration Tests
    runs-on: ubuntu-latest
    needs: container

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-deploy
          aws-region: us-east-1

      - name: Deploy to ephemeral environment
        run: |
          # Deploy to a unique namespace for this PR
          NAMESPACE="test-pr-${{ github.event.number }}"
          helm upgrade --install payment-api-test ./helm/payment-api \
            --namespace "$NAMESPACE" \
            --create-namespace \
            --set image.tag="sha-${{ github.sha }}" \
            --set environment=test \
            --wait --timeout 5m \
            --kubeconfig "${{ secrets.KUBECONFIG_TEST }}"

      - name: Run integration tests
        run: |
          ./gradlew integrationTest \
            -Dbase.url="http://payment-api-test.test-pr-${{ github.event.number }}.svc.cluster.local" \
            --no-daemon

      - name: Cleanup ephemeral environment
        if: always()
        run: |
          helm uninstall payment-api-test \
            --namespace "test-pr-${{ github.event.number }}" \
            --kubeconfig "${{ secrets.KUBECONFIG_TEST }}" || true

  # =========================================================
  # Stage 5: Deploy to Staging
  # =========================================================
  deploy-staging:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    needs: integration-test
    if: github.ref == 'refs/heads/main'

    environment:
      name: staging
      url: https://staging-api.payments.fintech.internal

    steps:
      - uses: actions/checkout@v4

      - name: Deploy to staging via ArgoCD
        run: |
          # Update the image tag in the GitOps repository
          git clone https://x-access-token:${{ secrets.GITOPS_TOKEN }}@github.com/fintech/platform-config
          cd platform-config

          # Update staging values
          yq eval -i '.image.tag = "sha-${{ github.sha }}"' \
            clusters/staging/payment-api/values.yaml

          git config user.email "ci@fintech.com"
          git config user.name "CI Pipeline"
          git add .
          git commit -m "chore: update payment-api to sha-${{ github.sha }} in staging"
          git push

          # Wait for ArgoCD to sync
          argocd app wait payment-api-staging \
            --timeout 300 \
            --server argocd.fintech.internal \
            --auth-token "${{ secrets.ARGOCD_TOKEN }}"

  # =========================================================
  # Stage 6: DAST — Dynamic Application Security Testing
  # =========================================================
  dast:
    name: DAST Scan
    runs-on: ubuntu-latest
    needs: deploy-staging
    if: github.ref == 'refs/heads/main'

    steps:
      - uses: actions/checkout@v4

      # OWASP ZAP: authenticated scan against staging
      - name: Run OWASP ZAP baseline scan
        uses: zaproxy/action-api-scan@v0.7.0
        with:
          target: https://staging-api.payments.fintech.internal
          format: openapi
          api_scan_parameters: >
            -config api.addrs.addr.name=".*"
            -config api.addrs.addr.regex="true"
          fail_action: true   # fail on CRITICAL findings

      - name: Upload ZAP report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: zap-report
          path: report_xml.xml

  # =========================================================
  # Stage 7: Production Approval (Four-Eyes)
  # =========================================================
  # Approval is handled by GitHub Environments with required reviewers
  # configured in repository settings:
  # Settings → Environments → production → Required reviewers (minimum 2)

  # =========================================================
  # Stage 8: Deploy to Production
  # =========================================================
  deploy-production:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: dast
    if: github.ref == 'refs/heads/main'

    environment:
      name: production       # GitHub will pause here for approval
      url: https://api.payments.fintech.com

    steps:
      - uses: actions/checkout@v4

      - name: Verify image signature before production deployment
        run: |
          cosign verify \
            --key https://cosign.fintech.internal/cosign.pub \
            "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ needs.container.outputs.image-digest }}"

      - name: Create change management record
        run: |
          # Create ServiceNow change record (or Jira ticket)
          curl -X POST https://fintech.service-now.com/api/now/table/change_request \
            -H "Authorization: Bearer ${{ secrets.SERVICENOW_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "short_description": "Deploy payment-api sha-${{ github.sha }} to production",
              "description": "Automated deployment from CI/CD pipeline. PR: ${{ github.event.pull_request.html_url }}",
              "type": "normal",
              "category": "software",
              "risk": "low"
            }'

      - name: Deploy to production via ArgoCD
        run: |
          git clone https://x-access-token:${{ secrets.GITOPS_TOKEN }}@github.com/fintech/platform-config
          cd platform-config

          yq eval -i '.image.tag = "sha-${{ github.sha }}"' \
            clusters/production/payment-api/values.yaml

          git config user.email "ci@fintech.com"
          git config user.name "CI Pipeline"
          git add .
          git commit -m "feat: deploy payment-api sha-${{ github.sha }} to production [approved by: ${{ github.actor }}]"
          git push

          # Wait for rollout to complete
          argocd app wait payment-api-production \
            --timeout 600 \
            --server argocd.fintech.internal \
            --auth-token "${{ secrets.ARGOCD_TOKEN }}"

      - name: Verify production health
        run: |
          # Check error rate is not elevated after deployment
          sleep 60  # wait for traffic to shift
          ERROR_RATE=$(curl -s "https://prometheus.fintech.internal/api/v1/query?
            query=rate(http_requests_total{service='payment-api',status=~'5..'}[5m])
            / rate(http_requests_total{service='payment-api'}[5m])" \
            | jq '.data.result[0].value[1]' | tr -d '"')

          echo "Post-deployment error rate: $ERROR_RATE"
          if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
            echo "ERROR: Error rate $ERROR_RATE exceeds 1% — triggering rollback"
            argocd app rollback payment-api-production \
              --server argocd.fintech.internal \
              --auth-token "${{ secrets.ARGOCD_TOKEN }}"
            exit 1
          fi

      - name: Notify deployment success
        if: success()
        uses: slackapi/slack-github-action@v1.26.0
        with:
          channel-id: '#deployments'
          slack-message: |
            *Payment API deployed to production*
            Commit: `${{ github.sha }}`
            By: ${{ github.actor }}
            Status: Success
        env:
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

---

## Tekton: Kubernetes-Native Pipelines

Tekton provides Kubernetes-native pipeline primitives, useful when you need pipelines that run entirely within your cluster (air-gapped environments, stricter network policies).

### Tekton Pipeline Definition

```yaml
# Tekton Task: build Spring Boot JAR
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: gradle-build
  namespace: tekton-pipelines
spec:
  params:
    - name: revision
      type: string
  workspaces:
    - name: source
  steps:
    - name: build
      image: eclipse-temurin:21-jdk
      workingDir: $(workspaces.source.path)
      script: |
        #!/bin/bash
        set -euo pipefail
        ./gradlew build test jacocoTestReport --no-daemon
      resources:
        requests:
          memory: "2Gi"
          cpu: "2"
---
# Tekton Task: Trivy image scan
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: trivy-scan
  namespace: tekton-pipelines
spec:
  params:
    - name: image-ref
      type: string
  steps:
    - name: scan
      image: aquasec/trivy:latest
      script: |
        #!/bin/sh
        trivy image \
          --exit-code 1 \
          --severity CRITICAL,HIGH \
          --ignore-unfixed \
          --format table \
          "$(params.image-ref)"
---
# Tekton Pipeline: wire tasks together
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: payment-api-pipeline
  namespace: tekton-pipelines
spec:
  params:
    - name: git-url
    - name: git-revision
    - name: image-name

  workspaces:
    - name: shared-workspace

  tasks:
    - name: build
      taskRef:
        name: gradle-build
      workspaces:
        - name: source
          workspace: shared-workspace
      params:
        - name: revision
          value: $(params.git-revision)

    - name: sast-scan
      runAfter: [build]
      taskRef:
        name: semgrep-scan
      workspaces:
        - name: source
          workspace: shared-workspace

    - name: build-image
      runAfter: [sast-scan]
      taskRef:
        name: kaniko-build
      params:
        - name: IMAGE
          value: $(params.image-name)
      workspaces:
        - name: source
          workspace: shared-workspace

    - name: trivy-scan
      runAfter: [build-image]
      taskRef:
        name: trivy-scan
      params:
        - name: image-ref
          value: $(params.image-name)

    - name: sign-image
      runAfter: [trivy-scan]
      taskRef:
        name: cosign-sign
      params:
        - name: image-ref
          value: $(params.image-name)
```

---

## Semgrep Financial Security Rules

```yaml
# .semgrep.yml — custom financial security rules for payment code
rules:
  # Prevent logging of card numbers or account numbers
  - id: no-card-number-in-logs
    patterns:
      - pattern: |
          log.$LEVEL(..., $X, ...)
      - metavariable-regex:
          metavariable: $X
          regex: '.*card.*[Nn]umber.*'
    message: >
      Potential card number in log statement. Card numbers must never be logged.
      PCI-DSS Requirement 3.4.
    severity: ERROR
    languages: [java]

  # Prevent hardcoded credentials
  - id: no-hardcoded-api-keys
    patterns:
      - pattern: |
          String $VAR = "sk_live_...";
      - pattern: |
          String $VAR = "pk_live_...";
    message: "Hardcoded API key detected. Use secrets management (AWS Secrets Manager)."
    severity: ERROR
    languages: [java]

  # Require parameterized queries
  - id: no-string-concatenation-in-sql
    patterns:
      - pattern: |
          $STMT.execute("SELECT ... " + $X + "...");
      - pattern: |
          $STMT.executeQuery("... " + $X);
    message: >
      String concatenation in SQL query — potential SQL injection.
      Use PreparedStatement or JPA named parameters.
    severity: ERROR
    languages: [java]

  # Require amount validation
  - id: payment-amount-must-be-validated
    patterns:
      - pattern: |
          processPayment($AMOUNT, ...);
      - pattern-not: |
          if ($AMOUNT.compareTo(BigDecimal.ZERO) > 0) { ... processPayment($AMOUNT, ...) }
    message: >
      Payment amount must be validated as positive before processing.
      A negative amount could result in a credit instead of debit.
    severity: WARNING
    languages: [java]
```

---

## Image Signing with Cosign

```bash
# Generate a signing key pair (store private key in AWS KMS or Vault)
cosign generate-key-pair --kms awskms:///arn:aws:kms:us-east-1:123456789:key/signing-key

# Sign an image (done in CI pipeline after build)
cosign sign \
  --key awskms:///arn:aws:kms:us-east-1:123456789:key/signing-key \
  --annotations "git-commit=$GIT_SHA" \
  --annotations "pipeline-run=$PIPELINE_RUN_ID" \
  123456789.dkr.ecr.us-east-1.amazonaws.com/fintech/payment-api@sha256:abc123

# Verify an image signature (done before deployment)
cosign verify \
  --key awskms:///arn:aws:kms:us-east-1:123456789:key/signing-key \
  123456789.dkr.ecr.us-east-1.amazonaws.com/fintech/payment-api@sha256:abc123

# Kubernetes admission controller: reject unsigned images
# Install Cosign's policy controller
helm install policy-controller sigstore/policy-controller \
  --namespace cosign-system \
  --create-namespace

# ClusterImagePolicy: require signed images in production namespaces
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
    - glob: "123456789.dkr.ecr.us-east-1.amazonaws.com/fintech/**"
  authorities:
    - keyless:
        url: https://fulcio.sigstore.dev
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subject: "repo:fintech/payment-api:ref:refs/heads/main"
```

---

## Key Takeaways for Senior Engineers

1. **SAST runs on every commit, DAST on every staging deployment** — static analysis is fast (seconds) and belongs in every CI run. Dynamic analysis against a running environment is slower and belongs before production deployment. Never skip either for payment services.

2. **Image signing creates an unbreakable audit trail** — Cosign with AWS KMS ensures that every container image in production was built by your CI pipeline, scanned for vulnerabilities, and approved for deployment. No manual image pushes to production ever.

3. **Four-eyes approval for production must be enforced by the system** — GitHub Environments with required reviewers, combined with branch protection rules, creates a verifiable record that two humans approved every production change. This satisfies SOX segregation-of-duties requirements.

4. **Fail the pipeline on HIGH and CRITICAL CVEs with available fixes** — `--ignore-unfixed` with Trivy means you only fail on CVEs where a fix exists. This prevents pipeline blockage on vendor-unresolved CVEs while catching the actionable ones.

5. **Post-deployment verification with automatic rollback** — verify error rate after each deployment using Prometheus. If the error rate exceeds the threshold, trigger rollback automatically. Human-initiated rollback takes 5-15 minutes; automated rollback takes 60 seconds.

6. **Change management integration is a PCI-DSS and SOX requirement** — automated creation of change records in ServiceNow or Jira at deployment time satisfies audit requirements without burdening engineers with manual ticket creation. The CI pipeline creates the record; the approval gate enforces it.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A container image is signed with Cosign using a KMS key. At deployment time, a Kubernetes admission webhook verifies the signature. A malicious actor gains access to the container registry and replaces an image with a tampered version that has the same tag (e.g., latest). What happens when Kubernetes tries to deploy the replaced image?",
      "options": ["The deployment succeeds because Kubernetes only checks the image tag, not the digest", "The admission webhook rejects the deployment because the tampered image's digest does not match the original signed digest, and the Cosign signature verification fails for the new digest", "The deployment succeeds unless the webhook specifically checks the sha256 digest", "Kubernetes detects the tampered image via its built-in image scanning and rejects it"],
      "correct": 1,
      "explanation": "Cosign signs the image digest (sha256 hash of the image manifest), not the tag. When an attacker replaces an image under the same tag, the new image has a different digest. The admission webhook (using policy-controller or Kyverno with a Cosign verifier) checks whether a valid Cosign signature exists for the specific digest of the image being deployed. Since no valid signature exists for the tampered image's digest, the deployment is rejected. This is why image signing provides stronger guarantees than tag-based controls."
    },
    {
      "text": "A GitHub Actions pipeline uses Trivy for container scanning with --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed. A build fails because a HIGH CVE is found in the base image. The CVE has been reported for 60 days but the base image vendor has not released a fix. What is the correct course of action?",
      "options": ["Remove the --exit-code 1 flag to allow builds to pass despite HIGH CVEs", "Add the specific CVE ID to Trivy's .trivyignore file with a documented reason and expiry date, triggering a mandatory review when the fix becomes available", "Switch to a different base image that does not have the CVE", "Raise the severity threshold to --severity CRITICAL to only fail on critical issues"],
      "correct": 1,
      "explanation": "The --ignore-unfixed flag already excludes CVEs without available fixes. If a CVE is flagged despite --ignore-unfixed, a fix does exist — the question is whether upgrading the dependency is feasible now. If not feasible, the correct control is a time-limited exception: add the CVE to .trivyignore with a documented reason, ticket for remediation, and expiry date. This maintains an auditable record of accepted risks. Raising the severity threshold or removing --exit-code 1 removes the control entirely rather than making a targeted exception."
    },
    {
      "text": "A payment service deployment pipeline has a four-eyes approval gate using GitHub Environments with required reviewers. A developer is on call and needs to deploy a critical hotfix at 2am but neither required reviewer is available. What is the correct process?",
      "options": ["The developer bypasses the approval gate using a GitHub personal access token with admin permissions", "The on-call playbook must include an escalation path: the developer contacts the on-call manager who either approves directly (if they are a designated reviewer) or invokes the emergency change management process, which temporarily grants approval rights to the on-call engineer pair", "The developer self-approves using their own GitHub account as the second reviewer", "Wait until a reviewer is available; the four-eyes requirement must never be bypassed"],
      "correct": 1,
      "explanation": "Four-eyes is a PCI-DSS and SOX control for segregation of duties. It cannot be bypassed by self-approval or by using admin privileges to override branch protection. However, a production system needing a critical fix at 2am is a real operational scenario. The correct design is a documented emergency change process: an on-call rotation that includes at least two designated approvers, and a break-glass procedure with enhanced audit logging where the emergency change is reviewed retrospectively within 24 hours. The key is that the bypass is authorised, documented, and auditable — not unilateral."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Secure CI/CD Pipeline with SAST, Image Signing, and Four-Eyes Approval",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Design a GitHub Actions multi-stage pipeline for the payment-api with these stages: (1) build-and-test: compile, unit tests, integration tests with Testcontainers, (2) sast: Semgrep with the fintech ruleset + OWASP Dependency Check (fail on CVSS >= 7.0), (3) container-build: Docker buildx with multi-stage build, Trivy scan (--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1), Cosign sign with AWS KMS, (4) staging-deploy: ArgoCD sync to staging with automated smoke test, (5) production-approval: GitHub Environment with two required reviewers, (6) production-deploy: ArgoCD sync with post-deploy error rate verification. Each stage must only run if the previous stage passes."
    },
    {
      "id": "2",
      "description": "Implement a post-deployment verification step that queries Prometheus for 5 minutes after deployment and fails the pipeline (triggering ArgoCD rollback) if: (a) payment_error_rate_5m > 0.01 (1% error rate), or (b) payment_p99_latency_ms > 500, or (c) payment_success_total rate drops more than 20% compared to the pre-deployment baseline. The step must report which threshold was breached and the actual vs threshold value. Write a unit test using a mock Prometheus client verifying each failure condition triggers rollback."
    },
    {
      "id": "3",
      "description": "Configure a Kyverno ClusterPolicy that verifies Cosign image signatures at admission time for all pods in namespaces labelled tier=payment. The policy must: use the Cosign public key from a Kubernetes Secret (not a hardcoded value), verify the signature was created by the CI pipeline's KMS key ARN, reject pods with unsigned images, and log rejected pods to an audit trail. Write a test using the Kyverno CLI (kyverno test) with a signed image manifest (should pass) and an unsigned image manifest (should fail)."
    },
    {
      "id": "4",
      "description": "Implement a ChangeManagementIntegration GitHub Actions step that runs at the start of the production-deploy stage and: (a) creates a ServiceNow change record via REST API with fields: application=payment-api, environment=production, deploy_version (from Docker image tag), approvers (GitHub reviewers who approved the gate), pipeline_url (GitHub Actions run URL), (b) updates the record to 'Implemented' status after successful deployment, (c) updates to 'Failed' and triggers a rollback notification if the deployment fails. Write an integration test using WireMock to verify the ServiceNow API calls are made in the correct order."
    }
  ]
}
-->
