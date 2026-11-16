---
id: track-13-lesson-04
title: "Grafana Dashboards — Visualising Financial System Health"
slug: grafana-dashboards
track: track-13
trackName: "Security & Observability"
sequence: 4
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Grafana, dashboard, panels, variables, alerting]
prerequisites: [track-13-lesson-03]
---

# Grafana Dashboards — Visualising Financial System Health

> [!NOTE]
> A Grafana dashboard is a communication tool, not a vanity wall. The best payment system dashboards answer a single question in under 5 seconds: is this service healthy right now? This lesson covers dashboard design from panel selection through dashboard-as-code, Grafana alerting, and the RED/USE methods applied to financial APIs.

## 1. Dashboard Design Principles

### 1.1 The Three-Level Dashboard Hierarchy

For financial systems, structure dashboards in a hierarchy:

| Level | Audience | Content | Update frequency |
|-------|----------|---------|-----------------|
| L1 — Overview | On-call, NOC | Is payment processing healthy? RED method. | 10s refresh |
| L2 — Service | Engineers | Detailed service metrics, JVM, DB | 15s refresh |
| L3 — Debug | Senior engineers | Traces, slow queries, GC analysis | On-demand |

### 1.2 Panel Selection Guide

| Visualisation | Use When |
|---------------|----------|
| **Time series** | Rate over time (throughput, latency trend) |
| **Stat** | Current single value (error rate NOW, queue depth NOW) |
| **Gauge** | Current value with thresholds (heap %, connection pool %) |
| **Table** | Multi-row data (top 10 slowest endpoints) |
| **Heatmap** | Latency distribution over time (histogram data) |
| **Bar chart** | Comparison across categories (error rate by payment type) |

---

## 2. The RED Method Dashboard for Payment APIs

RED: **R**ate, **E**rrors, **D**uration. This is the right starting point for any financial service.

### 2.1 Rate Panel

```json
{
  "title": "Payment Throughput (RPS)",
  "type": "timeseries",
  "targets": [
    {
      "expr": "sum(rate(payments_completed_total[5m]))",
      "legendFormat": "Successful payments/s"
    },
    {
      "expr": "sum(rate(payments_failed_total[5m]))",
      "legendFormat": "Failed payments/s"
    },
    {
      "expr": "sum(rate(payments_submitted_total[5m]))",
      "legendFormat": "Submitted payments/s"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "reqps",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          {"color": "green", "value": null},
          {"color": "yellow", "value": 0.5},
          {"color": "red", "value": 1}
        ]
      }
    }
  }
}
```

### 2.2 Errors Panel (Stat with Colour Thresholds)

```json
{
  "title": "Payment Error Rate",
  "type": "stat",
  "targets": [
    {
      "expr": "100 * sum(rate(payments_failed_total[5m])) / sum(rate(payments_submitted_total[5m]))",
      "legendFormat": "Error %"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "percent",
      "mappings": [],
      "thresholds": {
        "mode": "absolute",
        "steps": [
          {"color": "green", "value": null},
          {"color": "yellow", "value": 0.1},
          {"color": "red", "value": 1.0}
        ]
      }
    }
  },
  "options": {
    "reduceOptions": {"calcs": ["lastNotNull"]},
    "colorMode": "background"
  }
}
```

### 2.3 Duration Panel — Latency Heatmap

Heatmaps are the most effective way to visualise latency distributions over time. They reveal bimodal distributions (fast vs slow cohorts) that percentile lines hide.

```json
{
  "title": "Payment Latency Distribution (Heatmap)",
  "type": "heatmap",
  "targets": [
    {
      "expr": "sum by (le) (rate(payment_processing_seconds_bucket[5m]))",
      "legendFormat": "{{le}}",
      "format": "heatmap"
    }
  ],
  "options": {
    "calculate": false,
    "yAxis": {
      "unit": "s",
      "decimals": 3
    },
    "color": {
      "scheme": "Spectral",
      "steps": 128
    }
  }
}
```

---

## 3. Template Variables for Environment and Service

Variables make a single dashboard work across environments (dev, staging, prod) and services.

### 3.1 Defining Variables in Grafana JSON

```json
{
  "templating": {
    "list": [
      {
        "name": "environment",
        "type": "query",
        "datasource": "Prometheus",
        "query": "label_values(payments_completed_total, namespace)",
        "refresh": 2,
        "sort": 1,
        "current": {
          "value": "production",
          "text": "production"
        }
      },
      {
        "name": "service",
        "type": "query",
        "datasource": "Prometheus",
        "query": "label_values(payments_completed_total{namespace=\"$environment\"}, service)",
        "refresh": 2,
        "multi": false
      },
      {
        "name": "interval",
        "type": "interval",
        "values": ["1m", "5m", "10m", "30m", "1h"],
        "current": {"value": "5m", "text": "5m"}
      }
    ]
  }
}
```

### 3.2 Using Variables in Panel Queries

```promql
# Panel query using $environment and $service variables
sum(rate(payments_completed_total{
  namespace="$environment",
  service="$service"
}[$interval]))
```

---

## 4. Annotations for Deployments

Deployment annotations overlay deployment events on time-series charts, making it immediately visible when a metric change correlates with a deployment.

```yaml
# Kubernetes deployment hook — push annotation to Grafana
# In your CI/CD pipeline after a successful deploy:
annotations:
  - name: Deploy payment-service $VERSION
    time: $(date +%s)000
    tags: ["deploy", "payment-service"]
    text: "Deployed payment-service:$VERSION to $ENVIRONMENT"
```

```java
// Programmatic annotation via Grafana HTTP API
package com.bank.devops;

import org.springframework.web.client.RestTemplate;
import java.time.Instant;
import java.util.List;
import java.util.Map;

public class GrafanaAnnotationClient {

    private final RestTemplate restTemplate;
    private final String grafanaUrl;
    private final String apiKey;

    public GrafanaAnnotationClient(RestTemplate restTemplate,
                                   String grafanaUrl,
                                   String apiKey) {
        this.restTemplate = restTemplate;
        this.grafanaUrl = grafanaUrl;
        this.apiKey = apiKey;
    }

    public void annotateDeployment(String serviceName, String version,
                                   String environment) {
        var body = Map.of(
            "time", Instant.now().toEpochMilli(),
            "tags", List.of("deploy", serviceName, environment),
            "text", String.format("Deployed %s:%s to %s", serviceName, version, environment)
        );

        var headers = new org.springframework.http.HttpHeaders();
        headers.setBearerAuth(apiKey);
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);

        var entity = new org.springframework.http.HttpEntity<>(body, headers);
        restTemplate.postForObject(grafanaUrl + "/api/annotations", entity, Map.class);
    }
}
```

---

## 5. Dashboard-as-Code with Grafonnet/Jsonnet

Dashboard JSON can be version-controlled and templated using Grafonnet (a Jsonnet library for Grafana):

```jsonnet
// dashboards/payment-overview.jsonnet
local grafana = import 'grafonnet/grafana.libsonnet';
local dashboard = grafana.dashboard;
local row = grafana.row;
local prometheus = grafana.prometheus;
local graphPanel = grafana.graphPanel;
local statPanel = grafana.statPanel;
local template = grafana.template;

local paymentThroughput = graphPanel.new(
  title='Payment Throughput',
  datasource='Prometheus',
  format='reqps',
  legend_show=true,
).addTarget(
  prometheus.target(
    'sum(rate(payments_completed_total{namespace="$environment"}[5m]))',
    legendFormat='Completed/s',
  )
).addTarget(
  prometheus.target(
    'sum(rate(payments_failed_total{namespace="$environment"}[5m]))',
    legendFormat='Failed/s',
  )
);

local errorRateStat = statPanel.new(
  title='Error Rate',
  datasource='Prometheus',
  unit='percent',
  colorMode='background',
  thresholds=[
    {color: 'green', value: null},
    {color: 'yellow', value: 0.1},
    {color: 'red', value: 1.0},
  ],
).addTarget(
  prometheus.target(
    '100 * sum(rate(payments_failed_total[5m])) / sum(rate(payments_submitted_total[5m]))',
    instant=true,
  )
);

dashboard.new(
  title='Payment Service — Overview',
  uid='payment-overview',
  refresh='10s',
  time_from='now-1h',
  tags=['payments', 'RED', 'production'],
).addTemplate(
  template.datasource('datasource', 'prometheus', 'Prometheus')
).addTemplate(
  template.new(
    name='environment',
    datasource='$datasource',
    query='label_values(payments_completed_total, namespace)',
    current='production',
  )
).addRow(
  row.new(title='Payment Health').addPanel(paymentThroughput).addPanel(errorRateStat)
)
```

```bash
# Generate JSON from Jsonnet and apply to Grafana via API
jsonnet -J vendor dashboards/payment-overview.jsonnet \
  | curl -sS -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $GRAFANA_API_KEY" \
    -d @- \
    "https://grafana.bank.internal/api/dashboards/db"
```

---

## 6. The USE Method for Infrastructure Panels

USE: **U**tilisation, **S**aturation, **E**rrors. Applies to every resource: CPU, memory, network, disk, database connections.

### 6.1 Database Connection Pool Panel Set

```promql
# Utilisation: fraction of connections in use
hikaricp_connections_active / hikaricp_connections_max

# Saturation: threads waiting for a connection
hikaricp_connections_pending

# Errors: connection acquisition timeouts
rate(hikaricp_connections_timeout_total[5m])
```

### 6.2 JVM Memory Panel

```promql
# Utilisation: heap used fraction
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"}

# Saturation: GC pause rate (how often GC runs)
rate(jvm_gc_pause_seconds_count[5m])

# Errors: OOM proxy — heap near max (> 90%)
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"} > 0.9
```

---

## 7. Grafana Alerting — Alert Rules, Contact Points, and Notification Policies

Grafana Unified Alerting (available since Grafana 9) allows alert rules to be defined within dashboards and managed as code.

### 7.1 Alert Rule Definition

```yaml
# grafana/alerts/payment-alerts.yaml (Grafana provisioning format)
apiVersion: 1
groups:
  - orgId: 1
    name: payment-service-alerts
    folder: Payments
    interval: 1m
    rules:
      - uid: payment-error-rate-high
        title: Payment Error Rate High
        condition: C
        data:
          - refId: A
            queryType: ""
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: prometheus-prod
            model:
              expr: |
                100 * sum(rate(payments_failed_total[5m]))
                    / sum(rate(payments_submitted_total[5m]))
              intervalMs: 1000
              maxDataPoints: 43200
          - refId: C
            queryType: ""
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: "-100"   # __expr__ datasource
            model:
              conditions:
                - evaluator:
                    params: [1.0]
                    type: gt
                  operator:
                    type: and
                  query:
                    params: [A]
                  reducer:
                    params: []
                    type: last
              type: classic_conditions
        noDataState: NoData
        execErrState: Alerting
        for: 5m
        labels:
          severity: critical
          team: payments
        annotations:
          summary: "Payment error rate {{ $values.A.Value | printf \"%.2f\" }}%"
          runbook_url: "https://wiki.bank.com/runbooks/payment-error-rate"
```

### 7.2 Contact Points

```yaml
# grafana/provisioning/alerting/contact-points.yaml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: payments-pagerduty
    receivers:
      - uid: payments-pd-receiver
        type: pagerduty
        settings:
          integrationKey: ${PAGERDUTY_PAYMENTS_KEY}
          severity: critical
          class: payment-processing
          component: payment-service

  - orgId: 1
    name: payments-slack
    receivers:
      - uid: payments-slack-receiver
        type: slack
        settings:
          url: ${SLACK_PAYMENTS_WEBHOOK_URL}
          channel: "#payments-alerts"
          title: "[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}"
          text: |
            *Environment:* {{ .CommonLabels.namespace }}
            *Severity:* {{ .CommonLabels.severity }}
            {{ range .Alerts }}
            *Summary:* {{ .Annotations.summary }}
            *Runbook:* {{ .Annotations.runbook_url }}
            {{ end }}
```

### 7.3 Notification Policies

```yaml
# grafana/provisioning/alerting/notification-policies.yaml
apiVersion: 1
policies:
  - orgId: 1
    receiver: payments-slack      # default
    group_by: [alertname, namespace]
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    routes:
      # Critical alerts → PagerDuty (wake someone up)
      - receiver: payments-pagerduty
        matchers:
          - severity = critical
        group_wait: 0s
        repeat_interval: 1h
        continue: true            # Also send to Slack

      # Fraud alerts → fraud team channel
      - receiver: fraud-team-slack
        matchers:
          - team = fraud
        group_wait: 30s
```

---

## 8. Payment SLA Dashboard — Full Example

A production payment SLA dashboard for a UK retail bank:

**Row 1 — Current Health (5 Stat panels)**
- Payment throughput (RPS) — green if > 0, red if 0
- Error rate (%) — green < 0.1%, yellow 0.1-1%, red > 1%
- P99 latency — green < 500 ms, yellow 500 ms-1 s, red > 1 s
- Kafka consumer lag — green < 1,000, yellow 1,000-10,000, red > 10,000
- Fraud rejection rate — green < 2%, yellow 2-5%, red > 5%

**Row 2 — Throughput Trend (Time series)**
- Payments/s by type (DOMESTIC, INTERNATIONAL, WIRE)
- Error rate over time

**Row 3 — Latency Distribution (Heatmap + P50/P95/P99 time series)**
- Latency heatmap (histogram data, 24h view)
- P50, P95, P99 lines per payment type

**Row 4 — Infrastructure (USE method)**
- DB connection pool: utilisation gauge, saturation time series
- JVM heap: gauge, GC pause rate
- Thread pool: active/total

**Row 5 — Kafka (Consumer lag time series)**
- Lag per consumer group
- Consumer group rebalance events (annotation)

---

## 9. Production Tips

**Tip 1:** Set dashboard `refresh` to `10s` for L1 overview dashboards. Use `30s` or `1m` for deeper dashboards to avoid Prometheus load.

**Tip 2:** Use `max_over_time()` for Stat panels showing "worst in last 5 min" so a brief spike is not hidden:

```promql
max_over_time(
  (
    100 * sum(rate(payments_failed_total[5m]))
        / sum(rate(payments_submitted_total[5m]))
  )[5m:]
)
```

**Tip 3:** Store all dashboards in Git under `monitoring/dashboards/`. Use Grafana's provisioning directory to auto-load them on startup. Never allow manual edits in production Grafana — treat it like infrastructure-as-code.

**Tip 4:** For compliance audits, Grafana Enterprise provides dashboard snapshots with tamper-evident exports. For standard Grafana, export JSON snapshots to S3 on a schedule.

---

## 10. Summary

Dashboard excellence in financial systems comes from two discipline areas:

1. **Information hierarchy** — L1 (is it healthy?), L2 (which component?), L3 (why?). Each dashboard answers one question for one audience. The RED method (Rate, Errors, Duration) for services and USE method (Utilisation, Saturation, Errors) for infrastructure are the proven frameworks.

2. **Operational rigour** — dashboards as code in Git, automated provisioning, alert rules as YAML. Manual dashboard changes in production Grafana are technical debt. A dashboard that cannot be reproduced from source control is a liability in a regulated environment.

The best test of a dashboard: hand it to a junior engineer at 3 AM during an incident and ask if they can answer "is payment processing broken?" in 10 seconds. If they cannot, the dashboard needs redesign.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What does the RED method stand for in the context of Grafana dashboard design for microservices?",
      "options": ["Reliability, Efficiency, Downtime", "Rate, Errors, Duration", "Requests, Events, Delays", "Response, Errors, Demand"],
      "correct": 1,
      "explanation": "RED stands for Rate (requests per second), Errors (error rate or count), and Duration (latency distribution). It is the standard framework for service-level dashboards. The companion USE method (Utilisation, Saturation, Errors) applies to infrastructure resources like CPU and database connections."
    },
    {
      "text": "Why should Grafana dashboard changes in a production financial environment never be made manually through the UI?",
      "options": ["Manual changes are too slow", "Manual UI changes cannot be version-controlled, cannot be reviewed, and cannot be reproduced — violating infrastructure-as-code principles required in regulated environments", "Grafana does not allow manual changes in production mode", "Manual changes require a Grafana Enterprise licence"],
      "correct": 1,
      "explanation": "Dashboard-as-code (storing JSON definitions in Git with Grafana provisioning) ensures dashboards are version-controlled, reviewable via pull request, and reproducible. In a regulated environment, audit trails for infrastructure changes are mandatory. Manual UI changes leave no audit trail and can be accidentally overwritten."
    },
    {
      "text": "When building a payment SLA dashboard stat panel showing current error rate, why should max_over_time() be preferred over a plain instant query?",
      "options": ["max_over_time() is faster to compute", "An instant query shows only the most recent scrape value and can miss brief spikes; max_over_time() over a 5-minute window ensures that a spike is not hidden by the display refresh interval", "max_over_time() is required by PCI DSS", "Instant queries do not work with counter metrics"],
      "correct": 1,
      "explanation": "Dashboard panels refresh every 10-30 seconds. A spike lasting 20 seconds could fall between two refreshes and appear invisible in an instant query. max_over_time() over the last 5 minutes ensures the worst value in that window is displayed, making brief spikes visible."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Payment SLA Dashboard as Code",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Create a Grafana dashboard JSON definition (to be provisioned via Grafana's provisioning directory) with a template variable for environment (prod/staging) that filters all panels via a label selector."},
    {"id": "2", "description": "Build the first dashboard row: five Stat panels using the RED method showing payment throughput, error rate percentage, P99 latency, Kafka consumer lag, and fraud rejection rate — each with green/yellow/red threshold coloring appropriate to payment SLAs."},
    {"id": "3", "description": "Add a heatmap panel for payment processing latency distribution (using histogram_quantile data) alongside a time-series panel showing P50, P95, and P99 latency lines per payment type for the past 3 hours."},
    {"id": "4", "description": "Configure a Grafana Unified Alerting rule that fires when payment error rate exceeds 1% for 5 minutes, routes critical alerts to PagerDuty and all alerts to a Slack channel, and includes a runbook URL annotation."}
  ]
}
-->
