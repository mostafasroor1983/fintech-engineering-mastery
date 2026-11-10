---
id: track-12-lesson-14
title: "Canary and Blue-Green Deployments — Zero-Downtime Releases"
slug: canary-deployments
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 14
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [canary, blue-green, rolling-update, traffic-split, Argo-Rollouts]
prerequisites: []
---

# Canary and Blue-Green Deployments — Zero-Downtime Releases

> [!NOTE]
> A payment API that serves 10 million requests per day cannot have a release window where transactions fail. Rolling deployments are not sufficient for high-risk payment services — a bug in the new version may process payments incorrectly for the 5% of users receiving the new code before anyone notices. Canary deployments catch regressions at small blast radius; blue-green deployments allow atomic traffic switch with instant rollback. Both are essential patterns for financial services.

## Why Standard Rolling Deployments Are Insufficient

```
Standard Kubernetes rolling update (Deployment):

  v1: 10 pods serving 100% traffic
  Deploy v2:
    - 2 v2 pods started → 8 v1 + 2 v2 (20% v2)
    - 4 v2 pods started → 6 v1 + 4 v2 (40% v2)
    - 6 v2 pods started → 4 v1 + 6 v2 (60% v2)
    - 8 v2 pods started → 2 v1 + 8 v2 (80% v2)
    - 10 v2 pods started → 0 v1 + 10 v2 (100% v2)

Problems:
  1. No traffic control — rollout is proportional to pod count, not configured %
  2. No automatic quality gate — rollout proceeds regardless of error rate
  3. Rollback is slow — requires another rolling update to revert
  4. No ability to send specific users to new version for testing
  5. Mixed version traffic during rollout (v1 and v2 simultaneously)

For payment services:
  Bug in v2 payment processing logic → 20-100% of payments affected
  By the time an alert fires (5-15 minutes), significant damage done
```

---

## Argo Rollouts: Controlled Canary Deployments

Argo Rollouts replaces Kubernetes Deployments with a richer primitive that supports canary and blue-green strategies with traffic control and quality analysis.

### Installing Argo Rollouts

```bash
# Install Argo Rollouts controller
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Install kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
sudo mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts
```

### Payment API Canary Rollout

```yaml
# Rollout: payment-api canary deployment
# 5% → 20% → 50% → 100% with analysis at each step
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-api
  namespace: payments
spec:
  replicas: 10
  revisionHistoryLimit: 3

  selector:
    matchLabels:
      app: payment-api

  template:
    metadata:
      labels:
        app: payment-api
    spec:
      containers:
        - name: payment-api
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/fintech/payment-api:v2.3.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5

  strategy:
    canary:
      # Traffic routing via Istio (or Nginx Ingress, or AWS ALB)
      trafficRouting:
        istio:
          virtualService:
            name: payment-api-vsvc
            routes:
              - primary  # the main route name in the VirtualService

      # Canary steps: each step must pass before proceeding
      steps:
        # Step 1: 5% canary, run analysis for 10 minutes
        - setWeight: 5
        - pause: {duration: 2m}  # brief pause before analysis starts
        - analysis:
            templates:
              - templateName: payment-api-success-rate
            args:
              - name: service-name
                value: payment-api
        - pause: {duration: 8m}

        # Step 2: 20% canary, longer analysis
        - setWeight: 20
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: payment-api-success-rate
              - templateName: payment-api-latency
            args:
              - name: service-name
                value: payment-api

        # Step 3: 50% canary
        - setWeight: 50
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: payment-api-success-rate
              - templateName: payment-api-latency

        # Step 4: 100% (auto-promoted if all analysis passes)
        - setWeight: 100

      # Abort automatically if canary encounters too many errors
      canaryMetadata:
        labels:
          role: canary
      stableMetadata:
        labels:
          role: stable
```

### Analysis Template: Success Rate

```yaml
# AnalysisTemplate: measures payment API success rate
# If success rate drops below 99%, automatically abort the canary
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: payment-api-success-rate
  namespace: payments
spec:
  args:
    - name: service-name

  metrics:
    - name: payment-success-rate
      interval: 1m          # check every minute
      count: 5              # check 5 times before making a decision
      successCondition: result[0] >= 0.99   # 99% success rate required
      failureCondition: result[0] < 0.98    # < 98% = immediate failure
      failureLimit: 1        # abort after 1 failure measurement (don't average over failures)

      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(
              http_requests_total{
                namespace="payments",
                service="payment-api",
                role="canary",
                status!~"5.."
              }[5m]
            ))
            /
            sum(rate(
              http_requests_total{
                namespace="payments",
                service="payment-api",
                role="canary"
              }[5m]
            ))
---
# AnalysisTemplate: measures payment API latency
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: payment-api-latency
  namespace: payments
spec:
  args:
    - name: service-name

  metrics:
    - name: payment-p99-latency
      interval: 1m
      count: 5
      # p99 latency must be below 500ms
      successCondition: result[0] <= 0.500
      failureCondition: result[0] > 0.750   # 750ms = definite regression
      failureLimit: 2

      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99,
              sum(rate(
                http_request_duration_seconds_bucket{
                  namespace="payments",
                  service="payment-api",
                  role="canary"
                }[5m]
              )) by (le)
            )
---
# AnalysisTemplate: payment-specific — no duplicate transactions in canary
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: payment-duplicate-check
  namespace: payments
spec:
  metrics:
    - name: duplicate-payment-rate
      interval: 5m
      count: 3
      successCondition: result[0] == 0  # zero duplicate payments allowed
      failureCondition: result[0] > 0
      failureLimit: 0  # any duplicate = immediate abort

      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(
              payment_duplicate_detected_total{
                namespace="payments",
                role="canary"
              }[10m]
            ))
```

---

## Istio VirtualService for Traffic Splitting

Argo Rollouts updates the VirtualService weights automatically as the canary progresses.

```yaml
# VirtualService: Istio traffic splitting for payment-api canary
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-api-vsvc
  namespace: payments
spec:
  hosts:
    - payment-api
  http:
    - name: primary   # Argo Rollouts updates the weights here
      route:
        - destination:
            host: payment-api
            subset: stable
          weight: 95   # Argo Rollouts sets this (100% at start, decreases)
        - destination:
            host: payment-api
            subset: canary
          weight: 5    # Argo Rollouts sets this (0% at start, increases)
---
# DestinationRule: stable and canary subsets
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-api-dr
  namespace: payments
spec:
  host: payment-api
  subsets:
    - name: stable
      labels:
        role: stable
    - name: canary
      labels:
        role: canary
```

---

## Monitoring and Operating a Canary

```bash
# Watch the rollout progress
kubectl argo rollouts get rollout payment-api -n payments --watch

# Example output:
# Name:            payment-api
# Namespace:       payments
# Status:          ॥ Paused
# Message:         CanaryPauseStep
# Strategy:        Canary
#   Step:          2/8
#   SetWeight:     5
#   ActualWeight:  5
# Images:
#   payment-api:v2.3.0 (canary)
#   payment-api:v2.2.1 (stable)
# Replicas:
#   Desired:       10
#   Current:       11  (1 canary + 10 stable)
#   Updated:       1
#   Ready:         11
#   Available:     11

# Manually promote the canary (skip remaining pause steps — use with caution)
kubectl argo rollouts promote payment-api -n payments

# Abort the canary — immediately roll back to stable
kubectl argo rollouts abort payment-api -n payments

# Manual retry after fixing the issue
kubectl argo rollouts retry rollout payment-api -n payments
```

---

## Blue-Green Deployments

Blue-green deployments maintain two complete environments (blue = current, green = new). Traffic switches atomically from blue to green.

```yaml
# Blue-Green Rollout for payment settlement service
# Settlement is high-risk: atomic switch is safer than gradual canary
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: settlement-service
  namespace: payments
spec:
  replicas: 5
  selector:
    matchLabels:
      app: settlement-service

  template:
    metadata:
      labels:
        app: settlement-service
    spec:
      containers:
        - name: settlement-service
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/fintech/settlement-service:v3.1.0
          ports:
            - containerPort: 8080

  strategy:
    blueGreen:
      # activeService: points to current production traffic
      activeService: settlement-service-active
      # previewService: points to new (green) version
      previewService: settlement-service-preview

      # Require manual promotion (no automatic switch)
      autoPromotionEnabled: false

      # Keep old version alive for 30 minutes after promotion
      # (for instant rollback if post-deployment monitoring catches issues)
      scaleDownDelaySeconds: 1800

      # Run analysis on the preview (green) before promoting
      prePromotionAnalysis:
        templates:
          - templateName: settlement-service-smoke-test
        args:
          - name: service-url
            value: http://settlement-service-preview:8080

      # Run analysis after promotion to verify production is healthy
      postPromotionAnalysis:
        templates:
          - templateName: settlement-service-success-rate

---
# Services for blue-green
apiVersion: v1
kind: Service
metadata:
  name: settlement-service-active   # production traffic
  namespace: payments
spec:
  selector:
    app: settlement-service
  ports:
    - port: 8080

---
apiVersion: v1
kind: Service
metadata:
  name: settlement-service-preview   # green environment
  namespace: payments
spec:
  selector:
    app: settlement-service
  ports:
    - port: 8080
```

### Blue-Green Promotion Workflow

```bash
# Step 1: Deploy new version — it goes to the "green" (preview) environment
kubectl argo rollouts set image settlement-service \
  settlement-service=fintech/settlement-service:v3.1.0 \
  -n payments

# Step 2: Monitor the preview environment (green receives no production traffic)
kubectl argo rollouts get rollout settlement-service -n payments
# Status: Paused — waiting for manual promotion

# Step 3: Run smoke tests against the preview service directly
curl http://settlement-service-preview.payments.svc.cluster.local:8080/actuator/health

# Step 4: Run settlement smoke test against preview
./scripts/smoke-test-settlement.sh --url http://settlement-service-preview.payments.svc.cluster.local:8080

# Step 5: Promote — switches all traffic from blue to green atomically
kubectl argo rollouts promote settlement-service -n payments
# Traffic switches: 0% → 100% instantly
# Old (blue) pods kept alive for scaleDownDelaySeconds=1800

# Step 6: If post-promotion analysis shows issues, rollback instantly
kubectl argo rollouts undo settlement-service -n payments
# Traffic switches back: 0% → 100% instantly (blue is still alive)
```

---

## Header-Based Canary for Internal Testing

Before releasing a new version to any real users, internal teams can test it by sending specific HTTP headers.

```yaml
# VirtualService: header-based routing for internal canary testing
# Requests with header X-Canary: true go to canary pods
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-api-vsvc
  namespace: payments
spec:
  hosts:
    - payment-api
  http:
    # Header-based routing for internal testing (processed first)
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: payment-api
            subset: canary
          weight: 100

    # Normal traffic routing (uses Argo Rollouts weights)
    - name: primary
      route:
        - destination:
            host: payment-api
            subset: stable
          weight: 100
        - destination:
            host: payment-api
            subset: canary
          weight: 0  # Argo Rollouts updates this during canary progression
```

```bash
# Test new payment API version with specific header
curl -H "X-Canary: true" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST https://api.payments.fintech.com/v2/payments \
  -d '{"amount": 100, "currency": "USD", "source": "test-account"}'

# This request goes to the canary pods — no production traffic affected
```

---

## Database Migration Compatibility with Canary

The most dangerous aspect of canary deployments for financial services is database schema changes. When both old and new code run simultaneously, the schema must be compatible with both.

```
Database migration strategy for canary deployments:

Phase 1 — EXPAND (safe with both old and new code):
  Add new column (nullable or with default):
    ALTER TABLE payments ADD COLUMN risk_score DECIMAL(5,2) DEFAULT NULL;
  Add new index:
    CREATE INDEX CONCURRENTLY idx_payments_risk_score ON payments(risk_score);
  Add new table:
    CREATE TABLE payment_risk_assessments (...);

  Deploy this migration BEFORE any code change.
  Both old and new code work: old ignores new column, new uses it.

Phase 2 — CANARY DEPLOYMENT (both versions running):
  New code: writes risk_score, reads risk_score
  Old code: does not write risk_score, does not read risk_score
  Schema is backward compatible: old code ignores unknown columns (JPA ignores)

Phase 3 — FULL PROMOTION (all traffic on new version):
  All pods now write and read risk_score.
  Old code is gone.

Phase 4 — CONTRACT (after old version is fully gone):
  Add NOT NULL constraint (now safe — all rows have the value):
    ALTER TABLE payments ALTER COLUMN risk_score SET NOT NULL;
  Remove old columns (if any were renamed):
    ALTER TABLE payments DROP COLUMN old_column;

NEVER do this during canary:
  Renaming a column in a single migration — breaks old code immediately
  Dropping a column old code reads — breaks old code immediately
  Making a nullable column NOT NULL before all pods are updated
```

```java
// Flyway migration: expand-contract pattern
// V2024_11_08__add_payment_risk_score.sql
-- Phase 1 EXPAND: Add nullable column (safe with both old and new code)
ALTER TABLE payments ADD COLUMN risk_score DECIMAL(5,2) DEFAULT NULL;
ALTER TABLE payments ADD COLUMN risk_provider VARCHAR(50) DEFAULT NULL;
CREATE INDEX CONCURRENTLY idx_payments_risk_score ON payments(risk_score);

-- Comments documenting canary compatibility
-- This migration is safe to run before canary deployment:
-- - Old code (v2.2.x): ignores risk_score column (JPA ignores unknown columns)
-- - New code (v2.3.x): writes risk_score on every payment authorization
-- Phase 2 contract migration (V2024_12_01) will add NOT NULL after full rollout
```

---

## Feature Flags vs Canary Deployment

Feature flags and canary deployments solve similar but different problems.

```
Canary deployment:
  What: route a percentage of TRAFFIC to a new version of the service
  Granularity: by request (random %)
  Rollback: abort rollout (seconds)
  Best for: performance changes, infrastructure changes, API changes

Feature flags:
  What: enable/disable features within a single version of the service
  Granularity: by user, by account, by country, by payment method
  Rollback: flip the flag (milliseconds)
  Best for: business logic changes, A/B testing, gradual feature rollouts

Combination (most powerful):
  Canary: 5% of traffic goes to new service version
  Feature flag: within those 5%, only enable new fee calculation for premium users

Example: launching a new payment fee structure
  Week 1: Deploy v2 with feature flag OFF for all users (canary tests infrastructure)
  Week 2: Enable flag for 1% of users in new version
  Week 3: Enable flag for all users in new version, complete canary at 100%
  Week 4: Old version retired, flag becomes permanent behavior
```

### LaunchDarkly Integration for Payment Flags

```java
package com.fintech.payment;

import com.launchdarkly.sdk.LDContext;
import com.launchdarkly.sdk.server.LDClient;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class PaymentFeatureFlags {

    private final LDClient ldClient;

    /**
     * Check if the new fee calculation engine should be used for this customer.
     *
     * Financial context: new fee structure must be rolled out gradually
     * to avoid customer impact and allow operations team to monitor
     * fee revenue impact before full rollout.
     */
    public boolean useNewFeeCalculation(String customerId, String accountTier) {
        LDContext context = LDContext.builder(customerId)
            .set("accountTier", accountTier)
            .set("country", getCustomerCountry(customerId))
            .build();

        // LaunchDarkly evaluates targeting rules:
        // - premium accounts: enabled from day 1
        // - standard accounts: enabled after 2 weeks
        // - restricted accounts: manual override only
        return ldClient.boolVariation("new-fee-calculation-engine", context, false);
    }

    public boolean enableInstantPaymentProcessing(String merchantId) {
        LDContext context = LDContext.builder(merchantId)
            .kind("merchant")
            .set("tier", getMerchantTier(merchantId))
            .build();

        return ldClient.boolVariation("instant-payment-processing", context, false);
    }

    private String getCustomerCountry(String customerId) {
        // Lookup from cache
        return "US"; // simplified
    }

    private String getMerchantTier(String merchantId) {
        return "standard"; // simplified
    }
}
```

---

## Canary for Payment API Releases: Complete Checklist

```
Pre-deployment checklist:
  [ ] Database migration is backward compatible (expand phase done)
  [ ] New API endpoints are additive (no breaking changes to existing endpoints)
  [ ] Integration tests pass in staging
  [ ] Load test run against staging with new version
  [ ] AnalysisTemplate thresholds reviewed with SRE team
  [ ] Rollback procedure documented and tested (kubectl argo rollouts abort)
  [ ] On-call engineer briefed on deployment

Canary monitoring checklist (at each weight step):
  [ ] Payment success rate >= 99%
  [ ] p99 latency <= 500ms
  [ ] Zero duplicate payment detections
  [ ] Zero errors in application logs (payment-specific error classes)
  [ ] Database connection pool not exhausted
  [ ] Downstream service (fraud, compliance) not receiving errors

Abort immediately if:
  - Payment success rate < 98%
  - Duplicate payment detected
  - Any CRITICAL error in application logs
  - Database deadlock rate increases
  - Fraud service reporting unusual patterns
```

---

## Key Takeaways for Senior Engineers

1. **Argo Rollouts + AnalysisTemplate = automated quality gates** — the combination of Argo Rollouts traffic splitting and Prometheus-backed analysis templates means your canary succeeds or fails based on objective metrics, not human judgment at 2am.

2. **Canary analysis templates need payment-specific metrics** — generic success rate and latency are necessary but not sufficient. For payment services, track duplicate payment rate, payment reversal rate, and idempotency key collision rate explicitly.

3. **Blue-green is safer for settlement and batch services** — services that run scheduled jobs (settlement, reconciliation) cannot be in a "mixed version" state. Blue-green ensures the new version is fully deployed and tested before it receives any production traffic.

4. **Database migrations must be expand-contract, not big-bang** — running two versions simultaneously means your database schema must be simultaneously compatible with both. Additive-only changes in Phase 1 (expand), then enforcement in Phase 2 (contract) after old version is retired.

5. **scaleDownDelaySeconds is your rollback buffer** — after promoting a blue-green rollout, keep the old version alive for 30 minutes. This allows instant rollback if post-deployment monitoring catches a regression that pre-promotion analysis missed.

6. **Header-based canary for internal testing eliminates customer blast radius** — before releasing to any percentage of real users, test the new version by routing internal teams using `X-Canary: true`. Fix issues with zero customer impact.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "An Argo Rollouts AnalysisTemplate queries Prometheus for the canary's payment success rate. After 10 minutes at 10% traffic, the success rate is 99.2% against a threshold of 99.0%. The analysis result is Successful. What does Argo Rollouts do next?",
      "options": ["Declares the rollout complete and shifts 100% of traffic to the canary immediately", "Advances to the next step in the rollout spec (e.g., increases traffic weight to 25% and starts a new analysis interval)", "Waits for a human to approve the next traffic increment", "Rolls back because 99.2% is too close to the 99.0% threshold to be confident"],
      "correct": 1,
      "explanation": "Argo Rollouts follows the steps defined in the Rollout spec sequentially. After a successful analysis at 10% weight, it proceeds to the next step — typically increasing the canary weight to the next configured percentage (e.g., 25%) and starting another analysis run. This continues until either an analysis fails (triggering rollback) or all steps complete (triggering promotion). Full automatic promotion requires autoPromotionEnabled: true; otherwise it pauses for manual promotion after all steps succeed."
    },
    {
      "text": "A payment service is migrating from a schema with nullable processor_response TEXT to a non-nullable processor_response JSONB column. The migration must support two application versions running simultaneously during canary deployment. What is the correct expand-contract sequence?",
      "options": ["Phase 1: ALTER TABLE payments ALTER COLUMN processor_response TYPE JSONB USING processor_response::jsonb; Phase 2: deploy new application version", "Phase 1 (Expand): ADD COLUMN processor_response_new JSONB, write both columns in new code, old code writes only processor_response TEXT; Phase 2 (Backfill): migrate existing data to processor_response_new; Phase 3 (Contract): drop old column, rename new column — only after old application version is fully retired", "Run a single migration that converts the column type and deploy the new application version in the same release", "Use a database view to present the TEXT column as JSONB to the new application version during transition"],
      "correct": 1,
      "explanation": "Expand-contract is the only safe zero-downtime migration pattern for column type changes during canary deployments. The expand phase adds the new column while keeping the old one — both old and new application versions can run simultaneously because each uses the column it understands. The contract phase removes the old column only after the last pod running old code has been terminated. Running both versions simultaneously against a single-column type change would cause the old version to fail when it encounters JSONB data it cannot parse."
    },
    {
      "text": "A blue-green deployment has completed: the green (new) version is live and the blue (old) version is still running with scaleDownDelaySeconds = 1800. An engineer notices a data corruption bug in the green version 45 minutes after promotion. What is the rollback procedure?",
      "options": ["Deploy the blue version as a new rollout — the original blue pods have already been terminated after 30 minutes", "Since scaleDownDelaySeconds = 1800 (30 minutes) and only 45 minutes have passed — just past the delay — the blue pods have been scaled down; the fastest recovery is to redeploy from the last known-good image tag rather than waiting for Argo Rollouts to recreate blue", "Update the Istio VirtualService to route 100% of traffic back to the blue service — blue pods are still running since 45 min > 30 min scaleDownDelaySeconds has just expired", "Trigger an Argo Rollouts abort which instantly restores blue"],
      "correct": 1,
      "explanation": "scaleDownDelaySeconds = 1800 means blue pods are kept for 30 minutes after promotion. At 45 minutes, the blue pods have been scaled down (the 30-minute window has passed). The rollback cannot restore live blue pods — they no longer exist. The fastest recovery is to trigger a new rollout using the previous image tag (the blue version's image) which Argo Rollouts will deploy as a new stable version. This is why post-deployment monitoring windows should be shorter than scaleDownDelaySeconds, or the delay should be longer (e.g., 3600s) for high-risk services."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Canary Deployments with Payment-Specific Quality Gates",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Write an Argo Rollouts Rollout manifest for the payment-api with these canary steps: (1) setWeight: 5, pause: 2m, (2) analysis: payment-quality-gate, (3) setWeight: 20, pause: 5m, (4) analysis: payment-quality-gate, (5) setWeight: 50, pause: 10m, (6) analysis: payment-quality-gate. Configure scaleDownDelaySeconds: 3600. Add an Istio VirtualService reference for traffic splitting. The rollout must abort automatically if any analysis fails."
    },
    {
      "id": "2",
      "description": "Create an AnalysisTemplate payment-quality-gate that evaluates four metrics using Prometheus: (a) payment_success_rate = rate(payment_success_total[5m]) / rate(payment_requests_total[5m]) must be > 0.990, (b) payment_p99_latency = histogram_quantile(0.99, payment_duration_seconds_bucket) must be < 0.5, (c) duplicate_payment_rate = rate(duplicate_payment_detected_total[5m]) / rate(payment_requests_total[5m]) must be < 0.0001, (d) idempotency_key_collision_rate must be < 0.001. Configure failureLimit: 1 and consecutiveErrorLimit: 3."
    },
    {
      "id": "3",
      "description": "Implement the expand-contract database migration for adding a risk_score DECIMAL(5,2) column to the payments table. Phase 1 migration (Flyway V45): add nullable column. Update PaymentRepository to write risk_score when present (new code path) and handle null when absent (backward compat). Phase 2 migration (Flyway V46, deploy after 100% canary promotion): set NOT NULL DEFAULT 0. Write integration tests verifying that a PaymentService compiled against V44 schema can still read rows written by V45 code."
    },
    {
      "id": "4",
      "description": "Configure header-based canary routing using an Istio VirtualService that routes requests with header X-Canary: true to the canary subset and all other requests to the stable subset regardless of Argo Rollouts traffic weight. Add an Istio DestinationRule with two subsets (stable, canary) based on the rollouts-pod-template-hash label. Write a test that sends 100 requests with X-Canary: true and verifies (via pod name in response header) that all 100 hit canary pods, then sends 100 requests without the header and verifies they all hit stable pods."
    }
  ]
}
-->
