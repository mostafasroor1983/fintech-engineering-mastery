---
id: track-13-lesson-07
title: "SLO-Based Alerting — Burn Rate and Alert Fatigue"
slug: slo-alerting
track: track-13
trackName: "Security & Observability"
sequence: 7
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [SLO, alerting, burn-rate, multi-window, alert-fatigue]
prerequisites: [track-13-lesson-06]
---

# SLO-Based Alerting — Burn Rate and Alert Fatigue

> [!NOTE]
> Threshold-based alerts ("error rate > 1%") fire independently of your SLO, causing alert fatigue when the threshold is irrelevant and silence when it matters. Burn rate alerting fires precisely when your error budget is being consumed faster than sustainable—giving you advance warning proportional to business impact.

## The Problem with Threshold-Based Alerting

Traditional alerting asks: "Is this metric above a threshold right now?" This approach has two failure modes that are endemic in payment systems:

**Too noisy**: An alert fires for every blip above 1% error rate, even if the blip lasts 30 seconds and consumes 0.001% of the monthly error budget. On-call engineers learn to ignore these alerts—classic alert fatigue.

**Too silent**: A sustained 0.9% error rate runs for weeks below the threshold, consuming 90% of the error budget before anyone notices.

SLO-based alerting asks: "Is the error budget being consumed faster than sustainable?" It aligns alerting directly with user impact and business commitments.

---

## Error Budget and Burn Rate Foundations

### Defining Error Budget

For a payment API with a 99.9% availability SLO over 30 days:

```
Total minutes in 30 days = 43,200
Error budget = (1 - 0.999) × 43,200 = 43.2 minutes of downtime allowed
```

Equivalently, in terms of requests: if the API receives 1,000 requests/minute:

```
Total requests in 30 days = 43,200,000
Allowed failures = 0.001 × 43,200,000 = 43,200 failed requests
```

### Burn Rate

Burn rate is the ratio of current error rate to the error rate that would exactly exhaust the budget in 30 days.

```
1× burn rate = consuming the entire budget in exactly 30 days
                = 0.1% error rate for a 99.9% SLO

2× burn rate = consuming the budget in 15 days
                = 0.2% error rate for a 99.9% SLO

14× burn rate = consuming the budget in ~2 days
                = 1.4% error rate for a 99.9% SLO
```

### Burn Rate Formula

```
burn_rate = (error_rate_observed / error_rate_at_slo_boundary)

For 99.9% SLO:
  error_rate_at_slo_boundary = 1 - 0.999 = 0.001 (0.1%)

  If current error_rate = 0.014 (1.4%):
  burn_rate = 0.014 / 0.001 = 14×
```

---

## Multi-Window Multi-Burn-Rate Alerting

The Google SRE Workbook defines the gold standard: alert on two windows simultaneously to reduce both false positives (short spikes) and false negatives (slow leaks).

### The Four Alert Combinations

| Alert | Short Window | Long Window | Burn Rate | Budget Consumed | Action |
|-------|-------------|-------------|-----------|-----------------|--------|
| P1 Critical | 1 hour | 5 minutes | 14× | 2% in 1h | Page immediately |
| P2 High | 6 hours | 30 minutes | 6× | 5% in 6h | Page (business hours) |
| P3 Medium | 1 day | 2 hours | 3× | 10% in 1d | Ticket |
| P4 Low | 3 days | 6 hours | 1× | 10% in 3d | Weekly review |

**Why two windows per alert?**

The short window catches fast-burning incidents quickly. The long window prevents false positives from short spikes. Both must be true simultaneously to fire.

For a P1 alert (14× burn rate):
- Short window (1h) detects the problem within 5 minutes of it starting
- Long window (5 min) confirms it's not a 10-second blip

---

## Prometheus Recording Rules for SLO Efficiency

Computing error ratios over long windows on every alert evaluation is expensive. Use recording rules to pre-compute them.

### Recording Rule Setup

```yaml
# prometheus/recording-rules.yml
groups:
  - name: slo_payment_api
    interval: 60s
    rules:

      # 5-minute error ratio
      - record: job:payment_api_errors:rate5m
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[5m]))
          /
          sum(rate(http_requests_total{job="payment-api"}[5m]))

      # 30-minute error ratio
      - record: job:payment_api_errors:rate30m
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[30m]))
          /
          sum(rate(http_requests_total{job="payment-api"}[30m]))

      # 1-hour error ratio
      - record: job:payment_api_errors:rate1h
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[1h]))
          /
          sum(rate(http_requests_total{job="payment-api"}[1h]))

      # 2-hour error ratio
      - record: job:payment_api_errors:rate2h
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[2h]))
          /
          sum(rate(http_requests_total{job="payment-api"}[2h]))

      # 6-hour error ratio
      - record: job:payment_api_errors:rate6h
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[6h]))
          /
          sum(rate(http_requests_total{job="payment-api"}[6h]))

      # 1-day error ratio
      - record: job:payment_api_errors:rate1d
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[1d]))
          /
          sum(rate(http_requests_total{job="payment-api"}[1d]))

      # 3-day error ratio
      - record: job:payment_api_errors:rate3d
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[3d]))
          /
          sum(rate(http_requests_total{job="payment-api"}[3d]))

      # Error budget remaining (percentage)
      - record: job:payment_api_error_budget_remaining:ratio
        expr: |
          1 - (
            sum(increase(http_requests_total{job="payment-api", status=~"5.."}[30d]))
            /
            (sum(increase(http_requests_total{job="payment-api"}[30d])) * 0.001)
          )
```

### Alert Rules

```yaml
# prometheus/alert-rules.yml
groups:
  - name: slo_payment_api_burn_rate
    rules:

      # P1 — CRITICAL: 14x burn rate (fast burn)
      # Fires when: 1h window AND 5m window both show >= 14x burn
      # Meaning: at this rate, all 30-day error budget exhausted in ~2 days
      - alert: PaymentApiSLOBudgetBurnRateCritical
        expr: |
          (
            job:payment_api_errors:rate1h > (14 * 0.001)
            and
            job:payment_api_errors:rate5m > (14 * 0.001)
          )
        for: 2m
        labels:
          severity: critical
          slo: payment_api_availability
          team: payments
        annotations:
          summary: "Payment API SLO: critical burn rate {{ $value | humanizePercentage }} (14x)"
          description: |
            Error rate {{ $value | humanizePercentage }} is 14x the SLO budget rate.
            At this rate, the monthly error budget will be exhausted in ~2 days.
            Current error budget remaining: {{ query "job:payment_api_error_budget_remaining:ratio" | first | value | humanizePercentage }}
          runbook_url: "https://wiki.example.com/runbooks/payment-api-slo-burn"
          dashboard_url: "https://grafana.example.com/d/payment-slo/payment-api-slo"

      # P2 — HIGH: 6x burn rate (medium burn)
      # Fires when: 6h window AND 30m window both show >= 6x burn
      # Meaning: at this rate, all 30-day budget exhausted in ~5 days
      - alert: PaymentApiSLOBudgetBurnRateHigh
        expr: |
          (
            job:payment_api_errors:rate6h > (6 * 0.001)
            and
            job:payment_api_errors:rate30m > (6 * 0.001)
          )
        for: 15m
        labels:
          severity: high
          slo: payment_api_availability
          team: payments
        annotations:
          summary: "Payment API SLO: elevated burn rate {{ $value | humanizePercentage }} (6x)"
          description: |
            Error rate {{ $value | humanizePercentage }} is 6x the SLO budget rate.
            At this rate, the monthly error budget will be exhausted in ~5 days.
          runbook_url: "https://wiki.example.com/runbooks/payment-api-slo-burn"

      # P3 — MEDIUM: 3x burn rate (slow burn)
      - alert: PaymentApiSLOBudgetBurnRateMedium
        expr: |
          (
            job:payment_api_errors:rate1d > (3 * 0.001)
            and
            job:payment_api_errors:rate2h > (3 * 0.001)
          )
        for: 1h
        labels:
          severity: medium
          slo: payment_api_availability
          team: payments
        annotations:
          summary: "Payment API SLO: elevated burn rate (3x) — investigate during business hours"

      # Budget exhaustion alert
      - alert: PaymentApiSLOErrorBudgetLow
        expr: job:payment_api_error_budget_remaining:ratio < 0.10
        for: 5m
        labels:
          severity: high
          slo: payment_api_availability
        annotations:
          summary: "Payment API error budget below 10% — only {{ $value | humanizePercentage }} remaining this month"
```

---

## Latency SLO Alerting

For payment APIs, latency SLOs are as important as availability. p99 < 500ms for payment submissions.

```yaml
# Recording rules for latency
groups:
  - name: slo_payment_latency
    rules:

      # Fraction of requests meeting the latency SLO (< 500ms)
      - record: job:payment_api_latency_slo:rate5m
        expr: |
          sum(rate(http_request_duration_seconds_bucket{
            job="payment-api",
            le="0.5"
          }[5m]))
          /
          sum(rate(http_request_duration_seconds_count{job="payment-api"}[5m]))

      - record: job:payment_api_latency_slo:rate1h
        expr: |
          sum(rate(http_request_duration_seconds_bucket{
            job="payment-api",
            le="0.5"
          }[1h]))
          /
          sum(rate(http_request_duration_seconds_count{job="payment-api"}[1h]))

      # Latency error ratio (1 - compliance)
      - record: job:payment_api_latency_errors:rate1h
        expr: 1 - job:payment_api_latency_slo:rate1h

      - record: job:payment_api_latency_errors:rate5m
        expr: 1 - job:payment_api_latency_slo:rate5m

# Alert on latency budget burn
  - name: slo_payment_latency_alerts
    rules:
      - alert: PaymentApiLatencySLOBurnRateCritical
        expr: |
          (
            job:payment_api_latency_errors:rate1h > (14 * 0.001)
            and
            job:payment_api_latency_errors:rate5m > (14 * 0.001)
          )
        for: 2m
        labels:
          severity: critical
          slo: payment_api_latency
        annotations:
          summary: "Payment API p99 latency SLO: critical burn rate"
          description: "More than 14x the allowed latency violations. p99 likely above 500ms."
```

---

## Alertmanager Routing and Inhibition

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m
  slack_api_url: 'https://hooks.slack.com/services/...'

route:
  receiver: 'default'
  group_by: ['slo', 'team', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
    # Critical SLO burns → PagerDuty immediately (24/7)
    - match:
        severity: critical
        slo: payment_api_availability
      receiver: 'pagerduty-payments-critical'
      continue: false

    # High SLO burns → PagerDuty with business hours schedule
    - match:
        severity: high
        slo: payment_api_availability
      receiver: 'pagerduty-payments-high'
      continue: false

    # Medium burns → Slack channel during business hours
    - match:
        severity: medium
      receiver: 'slack-payments-team'
      active_time_intervals:
        - business_hours
      continue: false

receivers:
  - name: 'pagerduty-payments-critical'
    pagerduty_configs:
      - routing_key: '<PAGERDUTY_KEY>'
        severity: critical
        description: '{{ template "pagerduty.description" . }}'
        details:
          slo: '{{ .CommonLabels.slo }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'
          dashboard: '{{ .CommonAnnotations.dashboard_url }}'

  - name: 'slack-payments-team'
    slack_configs:
      - channel: '#payments-alerts'
        title: 'SLO Alert: {{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'
        actions:
          - type: button
            text: 'Runbook'
            url: '{{ .CommonAnnotations.runbook_url }}'

inhibit_rules:
  # If P1 fires, suppress P2 and P3 for the same SLO (avoid alert storm)
  - source_match:
      severity: critical
    target_match_re:
      severity: ^(high|medium)$
    equal: ['slo', 'team']

  # Suppress component alerts when parent service is down
  - source_match:
      alertname: PaymentServiceDown
    target_match:
      team: payments
    equal: ['environment']

time_intervals:
  - name: business_hours
    time_intervals:
      - times:
          - start_time: '08:00'
            end_time: '18:00'
        weekdays: ['monday:friday']
        location: 'Europe/London'
```

---

## Reducing Alert Fatigue

Alert fatigue is the biggest reliability problem in most engineering organizations. Engineers stop responding to pages because too many are noise.

### Fatigue Diagnosis

Measure these metrics on your alerting system monthly:

| Metric | Healthy | Needs attention |
|--------|---------|-----------------|
| Alert-to-incident ratio | < 3:1 | > 10:1 |
| Mean time to acknowledge | < 5 min | > 15 min |
| Auto-resolved (fired but no action needed) | < 20% | > 50% |
| Silenced/muted alerts | < 10% | > 30% |

### Alert Quality Principles

**Every alert must require human action.** If an alert can safely auto-resolve without investigation, it should not page someone. Demote it to a metric on a dashboard.

**Alerts should be urgent.** If the problem can wait until business hours, route to Slack. Paging engineers at 2am for non-urgent issues destroys team morale and leads to alert blindness.

**Alerts must be actionable.** The runbook URL in every alert is not optional—it is the difference between a 5-minute resolution and a 30-minute investigation. If you cannot write a runbook for an alert, the alert is not ready for production.

**Avoid alert duplication.** Use Alertmanager inhibition rules to suppress lower-severity alerts when a higher-severity alert already covers the same failure. If the payment service is down, suppress all the downstream component alerts.

### Alert Deduplication Configuration

```java
// Spring Boot — ensure metrics have consistent labels for effective grouping
@Component
public class PaymentMetrics {
    private final Counter requestsTotal;
    private final Counter errorsTotal;

    public PaymentMetrics(MeterRegistry registry) {
        // Consistent label schema — all payment API metrics use same job/endpoint labels
        this.requestsTotal = Counter.builder("http.requests.total")
            .tag("job", "payment-api")
            .tag("service", "payment-service")
            .register(registry);

        this.errorsTotal = Counter.builder("http.requests.errors.total")
            .tag("job", "payment-api")
            .tag("service", "payment-service")
            .register(registry);
    }

    public void recordRequest(String endpoint, int statusCode) {
        requestsTotal.increment();
        if (statusCode >= 500) {
            errorsTotal.increment();
        }
    }
}
```

---

## Payment API SLO Example: Full Configuration

**SLO definitions for a payment processing API:**

| SLO | Target | Window | Error Budget |
|-----|--------|--------|--------------|
| Availability | 99.9% | 30 days | 43.2 minutes |
| Latency p99 | < 500ms | 30 days | Same budget |
| Latency p50 | < 100ms | 30 days | Same budget |

```yaml
# slo-definitions.yml — source of truth, referenced by alerts
slos:
  payment_api_availability:
    description: "Payment submission API availability"
    target: 0.999
    window: 30d
    sli:
      type: availability
      metric: http_requests_total
      good_filter: 'job="payment-api",status!~"5.."'
      total_filter: 'job="payment-api"'
    alert_burn_rates:
      - burn_rate: 14
        windows: [1h, 5m]
        severity: critical
      - burn_rate: 6
        windows: [6h, 30m]
        severity: high
      - burn_rate: 3
        windows: [1d, 2h]
        severity: medium

  payment_api_latency_p99:
    description: "Payment submission API p99 latency < 500ms"
    target: 0.999
    window: 30d
    sli:
      type: latency
      metric: http_request_duration_seconds_bucket
      threshold_seconds: 0.5
      filter: 'job="payment-api"'
```

---

## SLO Dashboards in Grafana

```json
{
  "panels": [
    {
      "title": "Error Budget Remaining (30d)",
      "type": "gauge",
      "targets": [{
        "expr": "job:payment_api_error_budget_remaining:ratio * 100",
        "legendFormat": "Budget %"
      }],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "steps": [
              {"color": "red", "value": 0},
              {"color": "yellow", "value": 25},
              {"color": "green", "value": 50}
            ]
          },
          "unit": "percent",
          "min": 0,
          "max": 100
        }
      }
    },
    {
      "title": "Burn Rate (1h window)",
      "type": "timeseries",
      "targets": [{
        "expr": "job:payment_api_errors:rate1h / 0.001",
        "legendFormat": "Burn Rate (1h)"
      }],
      "thresholds": [
        {"value": 14, "color": "red", "op": "gt"},
        {"value": 6, "color": "orange", "op": "gt"},
        {"value": 1, "color": "green", "op": "gt"}
      ]
    }
  ]
}
```

---

## Key Takeaways

- Burn rate alerting aligns pages with business impact: 14× burn rate fires immediately because the error budget will be exhausted in 2 days
- Multi-window alerting (1h + 5min both required) eliminates false positives from short spikes without sacrificing detection speed
- Use Prometheus recording rules to pre-compute error ratios over long windows—querying `rate()[6h]` on every evaluation is expensive
- Alertmanager inhibition rules are essential: suppress P2 and P3 when P1 is firing for the same SLO
- Measure alert fatigue quantitatively: alert-to-incident ratio > 10:1 means your alerting is broken
- Every alert must have a runbook URL in its annotations—this is non-negotiable for production systems
- Payment APIs need both availability and latency SLOs with separate burn rate alerts for each

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment API has a 99.9% availability SLO over 30 days. If the current burn rate is 14x, how long until the error budget is exhausted at this rate?",
      "options": ["30 days", "7 days", "2 days", "12 hours"],
      "correct": 2,
      "explanation": "At a burn rate of 14x, the error budget is consumed 14 times faster than the SLO window. 30 days / 14 = approximately 2.1 days. This is why a 14x burn rate fires a critical alert — you have roughly 2 days of budget remaining, not 30."
    },
    {
      "text": "Why does multi-window burn rate alerting require BOTH a short window (e.g., 5 minutes) AND a long window (e.g., 1 hour) to trigger an alert?",
      "options": ["To reduce Prometheus storage costs", "The short window confirms the problem is happening right now; the long window confirms it is sustained enough to consume significant budget — requiring both eliminates false positives from brief spikes", "Because Alertmanager requires two conditions", "PCI DSS requires dual-window alerting"],
      "correct": 1,
      "explanation": "A 5-minute window alone fires on transient spikes that resolve themselves. A 1-hour window alone is too slow to respond to fast-burning incidents. Requiring both simultaneously means: the problem is happening right now (5-min window) AND has been sustained enough to burn meaningful budget (1-hour window)."
    },
    {
      "text": "What metric should you track monthly to diagnose alert fatigue in a payment operations team?",
      "options": ["Number of deploys per month", "Alert-to-incident ratio — the number of alerts fired divided by the number of incidents that required human action", "Mean time to recovery (MTTR)", "Number of SLO breaches"],
      "correct": 1,
      "explanation": "Alert-to-incident ratio measures how much noise your alerting produces relative to actionable alerts. A healthy ratio is below 3:1. Above 10:1 indicates alert fatigue — most pages are noise, engineers stop responding promptly, and real incidents get missed."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "SLO-Based Alerting for a Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Define two SLOs for a payment submission API: 99.9% availability and 99% of requests completing under 500ms, both over a 30-day window. Calculate the error budget in minutes/seconds for each."},
    {"id": "2", "description": "Write Prometheus recording rules to pre-compute the per-job error ratio over 5-minute, 1-hour, 6-hour, and 1-day windows; then write multi-window burn rate alert rules at 14x (critical), 6x (high), and 3x (medium) burn rates."},
    {"id": "3", "description": "Configure Alertmanager inhibition rules so that when a critical 14x burn rate alert fires for the payment API, all lower-severity SLO alerts for the same job are suppressed to prevent alert storm."},
    {"id": "4", "description": "Build a Grafana dashboard panel showing error budget remaining as a percentage gauge (green > 50%, yellow 25-50%, red < 25%) and a burn rate time-series panel with threshold lines at 14x, 6x, and 1x; add a Loki annotation showing deployment events on the burn rate chart."}
  ]
}
-->
