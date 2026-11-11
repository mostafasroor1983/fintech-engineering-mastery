---
id: track-13-lesson-04
title: "Grafana Dashboards — Visualising Financial System Health"
slug: grafana-dashboards
track: track-13
trackName: "Security & Observability Engineering"
sequence: 4
difficulty: advanced
estimatedMinutes: 65
status: published
tags:
  - Grafana
  - dashboard
  - SLO
  - RED-method
  - alerting
  - Loki
prerequisites:
  - track-13-lesson-03
---

# Grafana Dashboards — Visualising Financial System Health

Prometheus gives you the data. Grafana gives you the story. For a payment platform, that story must answer three questions at a glance: how fast is money moving, how much is failing, and how slow is it getting? This lesson builds production-grade Grafana dashboards using the RED method, implements SLO burn-rate alerting, correlates logs via Loki, and codifies dashboards as infrastructure.

---

## 1. The RED Method for Financial Services

The RED method (Rate, Errors, Duration) provides a minimal, complete view of any service from a user perspective. For payment systems, RED maps directly to business outcomes.

| Dimension | PromQL | Business Meaning |
|-----------|--------|-----------------|
| Rate | `sum(rate(payments_processed_total[5m]))` | Transactions per second — is money flowing? |
| Errors | `sum(rate(payments_processed_total{status="failure"}[5m])) / sum(rate(payments_processed_total[5m]))` | What fraction of payments are failing? |
| Duration (p99) | `histogram_quantile(0.99, sum by(le) (rate(payment_latency_seconds_bucket[5m])))` | Are customers waiting too long? |

A healthy payment service shows Rate stable, Errors near zero, and Duration below the SLA threshold. Any deviation from this baseline is an incident signal.

### RED Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  PAYMENT SERVICE HEALTH                       env: production    │
├─────────────────┬───────────────────┬───────────────────────────┤
│  TPS (Rate)     │  Error Rate (%)   │  p99 Latency             │
│  ┌───────────┐  │  ┌─────────────┐  │  ┌──────────────────────┐│
│  │  stat:    │  │  │  stat:      │  │  │  stat:               ││
│  │  142 TPS  │  │  │  0.3%       │  │  │  187ms               ││
│  └───────────┘  │  └─────────────┘  │  └──────────────────────┘│
├─────────────────┴───────────────────┴───────────────────────────┤
│  TPS over time (time-series panel, 24h)                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~                      │ │
│  └────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Error Rate over time          │  p99 Latency over time         │
│  ┌─────────────────────────┐   │  ┌──────────────────────────┐  │
│  │  threshold: 1%  ─ ─ ─   │   │  │  SLO: 500ms  ─ ─ ─ ─    │  │
│  │  actual: ~~~             │   │  │  actual: ~~~             │  │
│  └─────────────────────────┘   │  └──────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Outbox Lag (gauge)   │  Dead Payments (stat)  │  TPS by Method │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Dashboard Panels in Detail

### Panel 1: Transactions Per Second (TPS)

This stat panel shows the current TPS alongside a sparkline. It uses the pre-computed recording rule to minimise query cost.

```json
{
  "type": "stat",
  "title": "Payment TPS",
  "targets": [
    {
      "expr": "sum(job:payments_success_rate:rate5m)",
      "legendFormat": "TPS"
    }
  ],
  "options": {
    "reduceOptions": { "calcs": ["lastNotNull"] },
    "orientation": "horizontal",
    "colorMode": "background",
    "graphMode": "area",
    "justifyMode": "auto"
  },
  "fieldConfig": {
    "defaults": {
      "unit": "reqps",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "red",    "value": 0 },
          { "color": "yellow", "value": 10 },
          { "color": "green",  "value": 50 }
        ]
      }
    }
  }
}
```

### Panel 2: Error Rate with Alert Threshold

```json
{
  "type": "timeseries",
  "title": "Payment Error Rate",
  "targets": [
    {
      "expr": "100 * (sum(rate(payments_processed_total{status=\"failure\"}[5m])) / sum(rate(payments_processed_total[5m])))",
      "legendFormat": "Error Rate %"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "percent",
      "custom": {
        "thresholdsStyle": { "mode": "dashed" }
      },
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green",  "value": 0 },
          { "color": "yellow", "value": 0.5 },
          { "color": "red",    "value": 1.0 }
        ]
      }
    }
  }
}
```

### Panel 3: p99 Latency Histogram Quantile

```json
{
  "type": "timeseries",
  "title": "Payment Latency (p50 / p95 / p99)",
  "targets": [
    {
      "expr": "histogram_quantile(0.50, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
      "legendFormat": "p50"
    },
    {
      "expr": "histogram_quantile(0.95, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
      "legendFormat": "p95"
    },
    {
      "expr": "histogram_quantile(0.99, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
      "legendFormat": "p99"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "s",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green",  "value": 0 },
          { "color": "yellow", "value": 0.3 },
          { "color": "red",    "value": 0.5 }
        ]
      }
    }
  }
}
```

### Panel 4: Outbox Lag Gauge

```json
{
  "type": "gauge",
  "title": "Outbox Pending Events",
  "targets": [
    {
      "expr": "sum by(topic) (outbox_pending_events_total)",
      "legendFormat": "{{ topic }}"
    }
  ],
  "options": {
    "minValue": 0,
    "maxValue": 5000
  },
  "fieldConfig": {
    "defaults": {
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green",  "value": 0 },
          { "color": "yellow", "value": 100 },
          { "color": "red",    "value": 500 }
        ]
      }
    }
  }
}
```

---

## 3. SLO Dashboard and Error Budget

An SLO dashboard tracks your promise to customers — for example: 99.9% of payments succeed within 500ms. The error budget is the allowed failure headroom.

```
error_budget_remaining = 1 - (1 - availability_target)
                             ──────────────────────────
                             (1 - actual_availability)
```

### SLO PromQL Expressions

```promql
# 28-day availability (success rate)
(
  1 - (
    sum(increase(payments_processed_total{status="failure"}[28d]))
    /
    sum(increase(payments_processed_total[28d]))
  )
)

# Error budget remaining (as fraction of 0.001 for 99.9% SLO)
(
  0.001 -
  (
    sum(increase(payments_processed_total{status="failure"}[28d]))
    /
    sum(increase(payments_processed_total[28d]))
  )
) / 0.001
```

### Burn Rate Alert

A burn rate alert fires when you are consuming error budget faster than its natural refresh rate. A 1x burn rate means you will exactly exhaust the budget at the end of the window.

```promql
# 1-hour burn rate (should be < 14.4 for 99.9% SLO with 30-day window)
# 14.4 = 1 / (1 - 0.999) / 2 (using 2x threshold for fast burn)
(
  sum(rate(payments_processed_total{status="failure"}[1h]))
  /
  sum(rate(payments_processed_total[1h]))
) / (1 - 0.999)
```

A burn rate above 14.4 means you will exhaust your 30-day error budget in under 2 hours — this is a P1 alert.

```yaml
# PrometheusRule for SLO burn rate
- alert: PaymentSLOBurnRateCritical
  expr: |
    (
      sum(rate(payments_processed_total{status="failure"}[1h]))
      /
      sum(rate(payments_processed_total[1h]))
    ) / (1 - 0.999) > 14.4
  for: 5m
  labels:
    severity: critical
    slo: payment-availability
  annotations:
    summary: "Payment SLO burn rate is {{ $value | humanize }}x — budget exhaustion imminent"
    description: >
      At the current error rate, the 30-day error budget will be exhausted in
      {{ printf "%.1f" (div 1.0 $value) }} hours. Immediate action required.
```

---

## 4. Dashboard as Code

Storing dashboards as code prevents dashboard drift, enables peer review, and allows automated deployment.

### Terraform Grafana Provider

```hcl
terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 2.0"
    }
  }
}

provider "grafana" {
  url  = "https://grafana.example.com"
  auth = var.grafana_service_account_token
}

resource "grafana_folder" "payments" {
  title = "Payment Systems"
}

resource "grafana_dashboard" "payment_health" {
  folder      = grafana_folder.payments.id
  config_json = file("${path.module}/dashboards/payment-health.json")

  lifecycle {
    # Prevent manual changes from being overwritten silently
    # Terraform will fail if someone has manually edited the dashboard
    prevent_destroy = true
  }
}

resource "grafana_alert_rule" "payment_error_rate" {
  name             = "Payment Error Rate High"
  folder_uid       = grafana_folder.payments.uid
  group_name       = "payment-alerts"
  eval_interval    = "1m"
  no_data_state    = "NoData"
  exec_err_state   = "Alerting"

  rule_group = "payment-errors"

  condition = "C"

  data {
    ref_id = "A"
    query_type = ""
    relative_time_range {
      from = 300
      to   = 0
    }
    datasource_uid = "prometheus"
    model = jsonencode({
      expr = "sum(rate(payments_processed_total{status=\"failure\"}[5m])) / sum(rate(payments_processed_total[5m]))"
      legendFormat = "error_rate"
    })
  }

  data {
    ref_id = "C"
    query_type = ""
    relative_time_range { from = 0; to = 0 }
    datasource_uid = "__expr__"
    model = jsonencode({
      type       = "threshold"
      conditions = [{ evaluator = { type = "gt", params = [0.01] }, query = { params = ["A"] } }]
    })
  }
}
```

### Grafonnet (Jsonnet Library)

```jsonnet
// payment-dashboard.libsonnet
local grafana   = import 'grafonnet/grafana.libsonnet';
local dashboard = grafana.dashboard;
local row       = grafana.row;
local prometheus = grafana.prometheus;
local graphPanel = grafana.graphPanel;
local statPanel  = grafana.statPanel;

dashboard.new(
  'Payment Service Health',
  tags=['payments', 'RED', 'SLO'],
  time_from='now-6h',
  refresh='30s',
  schemaVersion=36,
)
.addPanel(
  statPanel.new(
    'TPS',
    datasource='Prometheus',
    unit='reqps',
  ).addTarget(
    prometheus.target(
      'sum(job:payments_success_rate:rate5m)',
      legendFormat='TPS',
    )
  ), gridPos={ h: 4, w: 6, x: 0, y: 0 }
)
.addPanel(
  statPanel.new(
    'Error Rate',
    datasource='Prometheus',
    unit='percentunit',
    thresholds=[
      { color: 'green',  value: null },
      { color: 'yellow', value: 0.005 },
      { color: 'red',    value: 0.01 },
    ],
  ).addTarget(
    prometheus.target(
      'sum(rate(payments_processed_total{status="failure"}[5m])) / sum(rate(payments_processed_total[5m]))',
    )
  ), gridPos={ h: 4, w: 6, x: 6, y: 0 }
)
```

---

## 5. Grafana Alerting Configuration

Grafana's unified alerting supports multi-datasource alerts and replaces legacy alert rules.

### Contact Points

```yaml
# grafana/provisioning/alerting/contact-points.yaml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: payments-pagerduty
    receivers:
      - uid: pagerduty-payments
        type: pagerduty
        settings:
          integrationKey: ${PAGERDUTY_PAYMENTS_KEY}
          severity: critical
          class: payment-failure
          group: payments
          component: payment-service

  - orgId: 1
    name: payments-slack
    receivers:
      - uid: slack-payments
        type: slack
        settings:
          url: ${SLACK_WEBHOOK_URL}
          channel: "#payments-alerts"
          title: "{{ template \"slack.payment.title\" . }}"
          text: "{{ template \"slack.payment.text\" . }}"
```

### Notification Policies

```yaml
# grafana/provisioning/alerting/notification-policies.yaml
apiVersion: 1
policies:
  - orgId: 1
    receiver: default-slack
    group_by: [alertname, cluster, namespace]
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    routes:
      - receiver: payments-pagerduty
        matchers:
          - severity = critical
          - team = payments
        group_wait: 10s
        repeat_interval: 1h

      - receiver: payments-slack
        matchers:
          - severity = warning
          - team = payments
        repeat_interval: 24h
```

---

## 6. Deployment Annotations

Annotating graphs with deployment events is essential for correlating "when did we deploy?" with latency spikes or error rate increases.

### Grafana Annotation API (CI/CD Integration)

```bash
# Post annotation at deploy time from your CI/CD pipeline
DEPLOY_VERSION="v2.4.1"
DEPLOY_TIME=$(date +%s%3N)   # milliseconds since epoch

curl -X POST \
  -H "Authorization: Bearer ${GRAFANA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"dashboardUID\": \"payment-health\",
    \"panelId\": null,
    \"time\": ${DEPLOY_TIME},
    \"tags\": [\"deployment\", \"payment-service\"],
    \"text\": \"payment-service ${DEPLOY_VERSION} deployed to production\"
  }" \
  https://grafana.example.com/api/annotations
```

### ArgoCD Annotations via Webhook

```yaml
# ArgoCD notification template
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
data:
  template.grafana-annotation: |
    webhook:
      grafana:
        method: POST
        path: /api/annotations
        body: |
          {
            "dashboardUID": "payment-health",
            "time": {{(now).UnixMilli}},
            "tags": ["deployment", "{{.app.metadata.name}}"],
            "text": "{{.app.metadata.name}} {{.app.status.sync.revision}} deployed"
          }
```

---

## 7. Loki Log Queries Alongside Metrics

Loki enables log correlation without leaving the Grafana UI.

### LogQL Queries for Payment Errors

```logql
# All ERROR logs from payment-service in last 1 hour
{app="payment-service", namespace="payments"} |= "ERROR"

# Count of error log lines per minute
count_over_time({app="payment-service"} |= "ERROR" [1m])

# Extract payment failure reason from structured JSON logs
{app="payment-service"} | json | level="ERROR" | line_format "{{.payment_id}}: {{.error_code}}"

# Correlate with specific transaction ID from an alert
{app="payment-service"} |= "txn-id-abc123" | json
```

### Grafana Mixed Datasource Panel

A single panel row can combine a Prometheus metric (p99 latency) with a Loki log stream, allowing engineers to correlate a latency spike with the first ERROR log that appeared.

```json
{
  "type": "logs",
  "title": "Payment Service Errors",
  "datasource": { "type": "loki", "uid": "loki" },
  "targets": [
    {
      "expr": "{app=\"payment-service\", namespace=\"payments\"} |= \"ERROR\" | json | level=\"ERROR\"",
      "legendFormat": "",
      "maxLines": 100
    }
  ],
  "options": {
    "showTime": true,
    "showLabels": true,
    "wrapLogMessage": true,
    "sortOrder": "Descending",
    "dedupStrategy": "none"
  }
}
```

---

## 8. Exemplars for Trace Correlation

Exemplars embed a trace ID into a histogram observation so you can jump from a slow p99 spike to the exact Jaeger trace that caused it.

### Java — Adding Exemplars via Micrometer

```java
import io.micrometer.core.instrument.Timer;
import io.opentelemetry.api.trace.Span;

@Service
public class PaymentService {

    private final Timer paymentTimer;

    public PaymentResult process(PaymentRequest request) {
        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            PaymentResult result = executePayment(request);
            sample.stop(paymentTimer);
            return result;
        } catch (Exception ex) {
            sample.stop(paymentTimer);
            throw ex;
        }
    }
}
```

```yaml
# application.yml — enable exemplar support
management:
  tracing:
    sampling:
      probability: 1.0
  metrics:
    distribution:
      percentiles-histogram:
        payment.latency: true
# Micrometer 1.11+ automatically attaches trace ID as exemplar
# when OpenTelemetry is on the classpath
```

### Prometheus Storage — Enabling Exemplars

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

storage:
  exemplars:
    max_exemplars: 100000    # store up to 100k exemplars in memory
```

In Grafana, right-click any p99 spike in a histogram panel and select "Query traces" to open Jaeger with the correlated trace ID.

---

## Production Pitfalls

### Pitfall 1: Dashboard Sprawl With No Ownership

Teams create dashboards during incidents and never delete them. After 6 months, the Grafana instance has 400 dashboards, most of them stale, with conflicting definitions of "error rate" across teams.

**Fix**: enforce dashboard-as-code with Terraform, assign a `team` tag to every dashboard, and schedule a quarterly audit. Add a `last_reviewed` annotation to each dashboard JSON.

```hcl
# Every dashboard must declare ownership
resource "grafana_dashboard" "payment_health" {
  config_json = jsonencode(merge(
    jsondecode(file("dashboards/payment-health.json")),
    {
      tags  = ["payments", "RED", "owner:payments-team"]
      meta  = { created = "2025-01", reviewed = "2026-01" }
    }
  ))
}
```

Stale dashboards (no commits in 90 days, no views in 30 days) are automatically moved to an `archived` folder and their owners are notified.

### Pitfall 2: Alerting on Individual Spikes, Not Sustained Burn Rate

Alerting `if error_rate > 0.01` on a 1-minute window generates false positives on every short traffic burst. A single large batch payment failing transiently creates a spike that resolves in under 60 seconds but still wakes up engineers.

**Fix**: use multi-window, multi-burn-rate alerts. Alert on fast burn (1h window > 14.4x) for critical pages, and slow burn (6h window > 6x) for warnings.

```promql
# Fast burn — pages immediately (budget gone in < 2h)
(
  sum(rate(payments_processed_total{status="failure"}[1h]))
  / sum(rate(payments_processed_total[1h]))
) / 0.001 > 14.4

# Slow burn — warning (budget gone in < 5 days)
(
  sum(rate(payments_processed_total{status="failure"}[6h]))
  / sum(rate(payments_processed_total[6h]))
) / 0.001 > 6
```

This eliminates the majority of false-positive pages for payment systems with natural burst patterns.

### Pitfall 3: Missing Deployment Annotations Making Incidents Hard to Correlate

An on-call engineer sees p99 latency climb from 180ms to 950ms at 14:37. Without deployment annotations, they must manually search deployment histories, Slack messages, and git logs to find that a new DB index was dropped at 14:35. This costs critical minutes during an incident.

**Fix**: inject annotations into all production dashboards automatically as part of the CD pipeline. Every merge to main that triggers a production deployment must post a Grafana annotation.

```yaml
# .github/workflows/deploy.yml
- name: Annotate Grafana dashboards
  if: success()
  run: |
    curl -s -X POST \
      -H "Authorization: Bearer ${{ secrets.GRAFANA_API_TOKEN }}" \
      -H "Content-Type: application/json" \
      -d "{
        \"tags\": [\"deployment\", \"${{ github.repository }}\"],
        \"text\": \"${{ github.repository }} ${{ github.sha }} deployed by ${{ github.actor }}\"
      }" \
      https://grafana.example.com/api/annotations
```

---

## Production Checklist

- [ ] RED method dashboard exists for every payment-critical service
- [ ] TPS, error rate, and p99 latency stat panels use recording rules (not raw counters)
- [ ] SLO dashboard shows 28-day availability and remaining error budget
- [ ] Burn rate alerts configured: fast burn (14.4x, critical) and slow burn (6x, warning)
- [ ] All dashboards stored as code in git (Terraform or Grafonnet)
- [ ] Dashboard ownership tags applied (`owner:team-name`)
- [ ] Contact points configured for PagerDuty (critical) and Slack (warning)
- [ ] Notification policies tested with `grafana-tools` or the Grafana API
- [ ] Deployment annotations injected automatically from CI/CD pipeline
- [ ] Loki datasource connected and log panels added to incident response dashboards
- [ ] Exemplar support enabled in Prometheus and Grafana for trace correlation
- [ ] Dashboard backup/restore tested (export JSON, re-import, verify panels load)

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"You need to calculate the 30-day error budget remaining for a payment service with a 99.9% availability SLO. The service has had 150 failures out of 500,000 total requests in 30 days. Which statement is correct?","options":["The error budget is 0.1%, allowing 500 failures total. With 150 failures the budget is 70% consumed and 30% remains.","The error budget is 1%, allowing 5,000 failures total. With 150 failures the budget is nearly intact.","The error budget cannot be calculated without knowing the p99 latency.","The error budget is 0.01%, allowing 50 failures total. The budget is already exhausted."],"correct":0,"explanation":"A 99.9% SLO means 0.1% error budget. For 500,000 requests that is 500 allowed failures. With 150 failures consumed, 350 failures remain — 70% of the budget is consumed and 30% remains. This is used to calculate burn rate: consuming 150/500 = 30% of budget in 30 days means burn rate is 1x, which is sustainable."},{"text":"A Grafana dashboard shows the payment error rate spiking to 2% at 14:37. No deployment annotation is visible on the graph. What is the BEST immediate action for the on-call engineer?","options":["Restart the payment-service pods immediately to clear the error spike.","Check git history, CI/CD logs, and Slack channels to correlate the 14:37 timestamp with any recent changes, while simultaneously checking Loki for ERROR logs at that time.","Acknowledge the alert and wait 30 minutes to see if the spike resolves itself.","Roll back the last deployment without investigating further."],"correct":1,"explanation":"Without a deployment annotation the engineer must correlate manually. The correct approach is to check Loki logs at 14:37 for the error cause while simultaneously searching deployment history. Restarting pods without investigation risks destroying evidence. Waiting 30 minutes during a live error spike violates SLO. Blind rollback may not fix the issue if the cause is a downstream dependency."},{"text":"Why should Grafana alerting use multi-window burn rate rules rather than simple threshold alerts like 'error_rate > 0.01 for 2m'?","options":["Because PromQL does not support simple threshold comparisons.","Because simple thresholds generate false positives during natural traffic bursts and cannot distinguish transient spikes from sustained SLO-threatening degradation.","Because Grafana can only evaluate alerts on 1-hour windows.","Because PagerDuty requires burn rate values to route alerts correctly."],"correct":1,"explanation":"Simple threshold alerts fire on any transient spike, including normal burst traffic patterns in payment systems. Multi-window burn rate alerts compare error consumption against the SLO budget, so they only page when the sustained rate of failure will exhaust the budget within a meaningful timeframe. This eliminates alert fatigue while ensuring real SLO breaches always trigger notifications."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"Build a Production Payment Health Dashboard","difficulty":"advanced","estimatedMinutes":90,"tasks":[{"id":"1","description":"Create a Grafana dashboard using the RED method for a payment service. Include: a stat panel for current TPS (from recording rule), a stat panel for error rate % (green/yellow/red thresholds at 0.5%/1%), a timeseries panel showing p50/p95/p99 latency with a 500ms SLO threshold line, and a gauge panel for outbox pending events. Store the dashboard JSON in version control."},{"id":"2","description":"Implement an SLO dashboard tracking 99.9% availability over 28 days. Add panels for: current 28-day availability percentage, error budget consumed (%), and a timeseries of daily error budget burn. Configure a burn rate alert in Grafana that pages PagerDuty when the 1-hour burn rate exceeds 14.4x and sends a Slack warning when the 6-hour burn rate exceeds 6x."},{"id":"3","description":"Codify the dashboard using the Terraform Grafana provider. The Terraform code must: create a Grafana folder named 'Payment Systems', deploy the payment health dashboard from a JSON file, configure the PagerDuty and Slack contact points using environment variables for secrets, and define the notification policy routing critical alerts to PagerDuty and warnings to Slack."},{"id":"4","description":"Integrate Loki log correlation into the dashboard. Add a logs panel showing ERROR-level logs from the payment-service namespace. Add a LogQL query that extracts error_code from JSON-structured logs and counts occurrences per minute. Configure the CI/CD pipeline to post a Grafana annotation on every production deployment including the git commit SHA and deploying engineer's name."}]} -->
