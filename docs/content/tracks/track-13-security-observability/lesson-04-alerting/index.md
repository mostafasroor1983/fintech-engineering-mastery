# Lesson 04: Alerting

## Overview

Effective alerting is the difference between proactive incident prevention and reactive firefighting. In fintech, where system failures directly translate to revenue loss, compliance violations, and customer harm, alert quality is paramount. This lesson covers alerting strategy, Alertmanager configuration, PagerDuty integration, and the discipline of reducing alert fatigue.

## Principles of Good Alerting

### Alert on Symptoms, Not Causes

Alert on what users (and the business) experience, not on what you think might be causing it.

| Poor Alert (Cause) | Better Alert (Symptom) |
|---|---|
| CPU usage > 80% | Payment processing P99 latency > 2s |
| Disk usage > 70% | Log ingestion pipeline falling behind |
| Pod restart detected | Payment success rate < 99.5% |
| DB connection pool exhausted | Transaction error rate > 1% |

### The Four Golden Signals (SRE)

1. **Latency**: How long does a payment take to process?
2. **Traffic**: How many payment requests per second?
3. **Errors**: What fraction of payments are failing?
4. **Saturation**: How close is the system to its limit?

## Prometheus Alerting Rules

### Alert Rule Structure

```yaml
groups:
  - name: payment_service_alerts
    rules:
      # Critical: Payment success rate below SLO
      - alert: PaymentSuccessRateLow
        expr: |
          (
            rate(payment_transactions_total{status="success"}[5m])
            / rate(payment_transactions_total[5m])
          ) < 0.995
        for: 2m
        labels:
          severity: critical
          team: payments
          runbook: "https://runbooks.internal/payment-success-rate"
        annotations:
          summary: "Payment success rate below 99.5% SLO"
          description: "Payment success rate is {{ $value | humanizePercentage }} over the last 5 minutes. SLO requires 99.5%."
          dashboard: "https://grafana.internal/d/payments-overview"

      # Warning: Elevated latency
      - alert: PaymentLatencyHigh
        expr: |
          histogram_quantile(0.99,
            rate(payment_processing_duration_seconds_bucket[5m])
          ) > 1.0
        for: 5m
        labels:
          severity: warning
          team: payments
        annotations:
          summary: "Payment P99 latency exceeds 1 second"
          description: "Payment P99 latency is {{ $value }}s. Card networks require <500ms authorization."

      # Fraud system availability
      - alert: FraudServiceDown
        expr: up{job="fraud-detector"} == 0
        for: 1m
        labels:
          severity: critical
          team: security
          page: "true"
        annotations:
          summary: "Fraud detection service is unreachable"
          description: "Fraud service has been down for 1 minute. All transactions are bypassing fraud checks."
```

## Alertmanager Configuration

### Routing and Silencing

```yaml
global:
  smtp_smarthost: 'smtp.internal:587'
  pagerduty_url: 'https://events.pagerduty.com/v2/enqueue'

route:
  receiver: 'default-receiver'
  group_by: ['alertname', 'team']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
    # Critical payment alerts → PagerDuty (immediate wake-up)
    - match:
        severity: critical
        team: payments
      receiver: payments-pagerduty
      continue: false

    # Security alerts → Security on-call + Slack
    - match:
        team: security
      receiver: security-team
      continue: true

    # Warning-only → Slack channel
    - match:
        severity: warning
      receiver: slack-warnings

receivers:
  - name: payments-pagerduty
    pagerduty_configs:
      - routing_key: '${PAGERDUTY_PAYMENTS_KEY}'
        severity: '{{ if eq .Labels.severity "critical" }}critical{{ else }}warning{{ end }}'
        description: '{{ .Annotations.description }}'
        links:
          - href: '{{ .Annotations.dashboard }}'
            text: 'Dashboard'
          - href: '{{ .Annotations.runbook }}'
            text: 'Runbook'

  - name: slack-warnings
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        channel: '#alerts-payments'
        title: '{{ .CommonAnnotations.summary }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
        color: '{{ if eq .CommonLabels.severity "critical" }}danger{{ else }}warning{{ end }}'

inhibit_rules:
  # If the whole payment service is down, suppress individual endpoint alerts
  - source_match:
      alertname: PaymentServiceDown
      severity: critical
    target_match:
      team: payments
    equal: ['environment']
```

## Alert Fatigue and Noise Reduction

Alert fatigue is when on-call engineers receive so many alerts that they begin ignoring them. This is dangerous in fintech — a critical fraud spike could be missed.

### Strategies

1. **`for` duration**: Never alert on a single data point. Use `for: 5m` to require sustained violation.
2. **Inhibition rules**: Suppress child alerts when a parent alert is firing (service down suppresses all endpoint alerts).
3. **Alert deduplication**: Group alerts by `alertname` + `team` before routing.
4. **Actionable alerts only**: Every alert must have a runbook. If you can't write a runbook, don't create the alert.
5. **Review alert history weekly**: Track false positive rate. Any alert firing >20% of the time without action should be revised.

## Runbook Template

Every critical alert must link to a runbook:

```markdown
# Runbook: PaymentSuccessRateLow

## Impact
Customers are experiencing payment failures. Revenue impact: ~$50K/minute.

## Immediate Steps
1. Check Grafana dashboard: [Payment Overview](https://grafana.internal/d/payments)
2. Check recent deployments: `kubectl rollout history deployment/payment-service -n production`
3. Check error logs: `{app="payment-service"} | json | level="ERROR" | last 100`
4. Check downstream services: fraud-service, ledger-service, card-network connectivity

## Escalation
- If deployment-related: rollback with `kubectl rollout undo deployment/payment-service`
- If infrastructure: escalate to Platform team via PagerDuty
- If card network: check status.visa.com / status.mastercard.com
```

## Multi-Window Multi-Burn-Rate Alerting

For SLO-based alerting, use multiple burn rate windows to catch both fast burns and slow leaks:

```yaml
# Fast burn (1h window, 14x rate) — page immediately
- alert: PaymentSLOFastBurn
  expr: |
    (
      job:payment_error_rate:rate1h > (14 * 0.005)
      and
      job:payment_error_rate:rate5m > (14 * 0.005)
    )
  labels:
    severity: critical
    page: "true"

# Slow burn (6h window, 6x rate) — ticket during business hours
- alert: PaymentSLOSlowBurn
  expr: |
    job:payment_error_rate:rate6h > (6 * 0.005)
  labels:
    severity: warning
```

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the main problem with alerting on 'CPU usage > 80%' rather than 'payment success rate < 99.5%' in a payment processing system?",
      "options": ["CPU alerts fire too infrequently to be useful", "CPU alerts are causes not symptoms — CPU spikes may not impact users while user-visible failures might occur without high CPU", "CPU metrics are inaccurate in containerized environments", "CPU thresholds are impossible to set correctly"],
      "correct": 1,
      "explanation": "Alerting on causes rather than symptoms leads to both false positives (high CPU with no user impact) and false negatives (user-impacting failures that don't manifest as high CPU). The SRE principle is to alert on what users experience — symptom-based alerting — to maximize signal-to-noise ratio."
    },
    {
      "text": "What does the 'for: 5m' field in a Prometheus alert rule accomplish?",
      "options": ["It limits the alert to fire only 5 times", "It requires the alert condition to be continuously true for 5 minutes before firing, reducing false positives from transient spikes", "It sets the alert to repeat every 5 minutes", "It applies the rule only to metrics from the last 5 minutes"],
      "correct": 1,
      "explanation": "The 'for' duration is a pending period — the alert expression must evaluate to true for the entire duration before the alert transitions from 'pending' to 'firing'. This eliminates false positives from brief transient spikes that self-resolve, reducing alert fatigue significantly."
    },
    {
      "text": "In multi-window multi-burn-rate SLO alerting, why is it important to alert on both a short window (1h, 14x burn) AND a longer window (6h, 6x burn)?",
      "options": ["To create redundant alerts in case one fails to fire", "The short window catches fast-burning incidents that will exhaust the error budget quickly; the long window catches slow leaks that would be missed by fast-burn alerts alone", "Both windows must agree before paging to avoid false positives", "The long window provides more accurate data than the short window"],
      "correct": 1,
      "explanation": "A 14x burn rate on a 1-hour window catches severe incidents that will consume the monthly error budget in hours — these need immediate pages. A 6x burn rate on a 6-hour window catches subtle degradation that is too slow to trigger fast-burn alerts but will still exhaust the budget within days. Using both ensures full coverage of the incident severity spectrum."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Deploy a Production-Grade Payment Alerting System",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write Prometheus alert rules for the four golden signals applied to a payment service: error rate SLO (99.5%), P99 latency SLO (500ms), traffic anomaly (50% drop from baseline), and saturation (queue depth >80% capacity) — each with appropriate 'for' durations and severity labels."},
    {"id": "2", "description": "Configure Alertmanager with routing rules that send critical payment alerts to PagerDuty with runbook links, warning alerts to a Slack channel, and implement inhibition rules so that a 'PaymentServiceDown' alert suppresses all individual endpoint alerts for the same environment."},
    {"id": "3", "description": "Implement multi-window multi-burn-rate SLO alerts for the payment service with a 99.5% availability SLO: fast-burn (1h/14x) for critical pages and slow-burn (6h/6x) for warning tickets, using pre-computed recording rules as the basis."},
    {"id": "4", "description": "Write runbooks for two of your critical alerts, including: impact statement, immediate investigation steps (with specific commands/links), rollback procedure, and escalation path — then verify the runbook URL is embedded in the alert annotation."}
  ]
}
-->
