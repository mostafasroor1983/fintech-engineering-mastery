---
id: track-13-lesson-03
title: "Prometheus and PromQL — Metrics for Financial Systems"
slug: prometheus-promql
track: track-13
trackName: "Security & Observability Engineering"
sequence: 3
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - Prometheus
  - PromQL
  - metrics
  - counter
  - gauge
  - histogram
  - alerting
prerequisites:
  - track-13-lesson-02
---

# Prometheus and PromQL — Metrics for Financial Systems

Prometheus is the de-facto standard for metrics in cloud-native financial systems. Its pull-based scraping model, multi-dimensional data model, and powerful query language (PromQL) make it indispensable for observing payment pipelines, detecting SLA breaches, and driving automated alerting. This lesson covers everything from metric type selection to production-grade alerting rules for real financial workloads.

## Why Prometheus for Fintech?

Financial systems demand sub-second detection of error rate spikes and latency degradation. Prometheus delivers:

- **Multi-dimensional labels** — partition metrics by `payment_method`, `currency`, `merchant_id`, or `region` without schema migrations.
- **Pull-based scraping** — services expose a `/actuator/prometheus` endpoint; Prometheus controls the scrape cadence.
- **Alertmanager integration** — route alerts to PagerDuty for P1 payment failures and Slack for informational notices.
- **Recording rules** — pre-compute expensive PromQL expressions so dashboards load instantly even with millions of time series.

---

## 1. Prometheus Metric Types

### Counter

A counter only increases (or resets to zero on restart). Use it to count discrete events.

```
# HELP payments_processed_total Total number of payment transactions processed
# TYPE payments_processed_total counter
payments_processed_total{status="success",payment_method="card",currency="GBP"} 48291
payments_processed_total{status="failure",payment_method="card",currency="GBP"} 134
payments_processed_total{status="success",payment_method="bank_transfer",currency="EUR"} 7823
```

**Golden rule**: never use a counter for values that can decrease. Use `rate()` or `increase()` to derive a per-second rate.

### Gauge

A gauge represents a snapshot value that can go up or down.

```
# HELP outbox_pending_events_total Number of events waiting in the transactional outbox
# TYPE outbox_pending_events_total gauge
outbox_pending_events_total{topic="payment.completed"} 12
outbox_pending_events_total{topic="fraud.alert"} 0
```

Gauges are ideal for queue depths, connection pool sizes, and cache hit ratios.

### Histogram

A histogram samples observations and counts them in configurable buckets. It automatically exposes `_bucket`, `_sum`, and `_count` series.

```
# HELP payment_latency_seconds End-to-end payment processing latency
# TYPE payment_latency_seconds histogram
payment_latency_seconds_bucket{le="0.05"} 1200
payment_latency_seconds_bucket{le="0.1"}  3800
payment_latency_seconds_bucket{le="0.25"} 7100
payment_latency_seconds_bucket{le="0.5"}  9800
payment_latency_seconds_bucket{le="1.0"}  10100
payment_latency_seconds_bucket{le="+Inf"} 10234
payment_latency_seconds_sum 1823.4
payment_latency_seconds_count 10234
```

Use `histogram_quantile(0.99, ...)` to calculate p99 latency across a fleet of instances.

### Summary

A summary computes quantiles client-side. Unlike histograms, summaries **cannot be aggregated across instances**, making them unsuitable for horizontally-scaled payment services.

**Decision rule**: always prefer histograms over summaries in distributed fintech systems.

---

## 2. Micrometer Integration with Spring Boot

Micrometer is the instrumentation facade that sits between your application code and Prometheus.

### Maven Dependency

```xml
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
  </dependency>
  <dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
  </dependency>
</dependencies>
```

### application.yml

```yaml
management:
  endpoints:
    web:
      exposure:
        include: prometheus,health,info
  endpoint:
    prometheus:
      enabled: true
  metrics:
    distribution:
      percentiles-histogram:
        payment.latency: true          # enables histogram buckets
      sla:
        payment.latency: 50ms,100ms,250ms,500ms,1000ms
      percentiles:
        payment.latency: 0.5,0.95,0.99
    tags:
      application: payment-service
      environment: production
      region: eu-west-1
```

### Payment Latency Histogram (Java)

```java
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.Counter;
import org.springframework.stereotype.Service;

@Service
public class PaymentMetrics {

    private final Timer paymentLatency;
    private final Counter paymentSuccessCounter;
    private final Counter paymentFailureCounter;
    private final io.micrometer.core.instrument.Gauge outboxPendingGauge;

    public PaymentMetrics(MeterRegistry registry, OutboxRepository outboxRepository) {

        // Histogram for end-to-end payment latency
        this.paymentLatency = Timer.builder("payment.latency")
            .description("End-to-end payment processing latency")
            .tags("service", "payment-service")
            .publishPercentileHistogram(true)
            .minimumExpectedValue(Duration.ofMillis(10))
            .maximumExpectedValue(Duration.ofSeconds(10))
            .register(registry);

        // Counters partitioned by outcome and payment method
        this.paymentSuccessCounter = Counter.builder("payments.processed")
            .description("Total payments processed successfully")
            .tags("status", "success")
            .register(registry);

        this.paymentFailureCounter = Counter.builder("payments.processed")
            .description("Total payments that failed")
            .tags("status", "failure")
            .register(registry);

        // Gauge for transactional outbox lag
        io.micrometer.core.instrument.Gauge.builder("outbox.pending.events",
                outboxRepository, OutboxRepository::countPending)
            .description("Number of events pending in the transactional outbox")
            .register(registry);
    }

    public PaymentResult processPayment(PaymentRequest request) {
        return paymentLatency.recordCallable(() -> {
            try {
                PaymentResult result = doProcessPayment(request);
                paymentSuccessCounter.increment();
                return result;
            } catch (PaymentException ex) {
                // Add failure reason as a tag for root cause analysis
                Counter.builder("payments.processed")
                    .tags("status", "failure", "reason", ex.getErrorCode())
                    .register(registry)
                    .increment();
                throw ex;
            }
        });
    }
}
```

### High-Cardinality Warning

Never use dynamic values (user IDs, transaction IDs, account numbers) as label values. Each unique label combination creates a new time series. A single misconfigured label can generate millions of series and crash Prometheus.

```java
// WRONG — creates millions of time series
Counter.builder("payment.processed")
    .tags("account_id", request.getAccountId())   // cardinality bomb
    .register(registry)
    .increment();

// CORRECT — bounded cardinality
Counter.builder("payment.processed")
    .tags("payment_method", request.getPaymentMethod(),   // card, bank_transfer
          "currency", request.getCurrency(),               // GBP, EUR, USD
          "merchant_category", request.getMcc())           // ~200 MCC codes
    .register(registry)
    .increment();
```

---

## 3. PromQL Operators

### rate() — Safe Counter Rate

`rate()` calculates the per-second average rate of increase over a time range, handling counter resets gracefully (pod restarts, deployments).

```promql
# Payment success rate per second over last 5 minutes
rate(payments_processed_total{status="success"}[5m])

# Grouped by payment method
sum by(payment_method) (rate(payments_processed_total{status="success"}[5m]))
```

### irate() — Instantaneous Rate

`irate()` uses only the last two data points. It is more responsive but noisier. Use for dashboards, not alerts.

```promql
# Instantaneous TPS for real-time dashboard panel
irate(payments_processed_total{status="success"}[2m])
```

### histogram_quantile()

Calculates quantile from histogram buckets. The rate window must be wide enough to have sufficient samples.

```promql
# p99 payment latency across all instances over 5 minutes
histogram_quantile(0.99,
  sum by(le) (
    rate(payment_latency_seconds_bucket[5m])
  )
)

# p99 per payment method
histogram_quantile(0.99,
  sum by(le, payment_method) (
    rate(payment_latency_seconds_bucket[5m])
  )
)
```

### Error Rate Calculation

```promql
# Payment error rate as a fraction (0.0 to 1.0)
sum(rate(payments_processed_total{status="failure"}[5m]))
  /
sum(rate(payments_processed_total[5m]))

# As a percentage
100 * (
  sum(rate(payments_processed_total{status="failure"}[5m]))
  /
  sum(rate(payments_processed_total[5m]))
)
```

### Aggregation Operators

```promql
# Total TPS across all regions
sum(rate(payments_processed_total[5m]))

# Max p99 latency across all pods
max by(pod) (
  histogram_quantile(0.99,
    sum by(le, pod) (rate(payment_latency_seconds_bucket[5m]))
  )
)

# Outbox lag summed across all partitions
sum by(topic) (outbox_pending_events_total)
```

---

## 4. Scrape Configuration for Kubernetes Pods

Prometheus discovers targets using Kubernetes service discovery. Annotate pods to control scraping.

### Pod Annotations

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
spec:
  template:
    metadata:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/actuator/prometheus"
      labels:
        app: payment-service
        version: v2.4.1
```

### prometheus.yml Kubernetes SD Configuration

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: prod-eu-west-1
    environment: production

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [payments, fraud-detection, reconciliation]
    relabel_configs:
      # Only scrape pods with the annotation
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      # Use the annotated port
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: (.+)
        replacement: ${1}
      # Use the annotated path
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      # Carry pod labels into Prometheus labels
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
```

---

## 5. PrometheusRule CRD for Alerting

The Prometheus Operator extends Kubernetes with a `PrometheusRule` CRD. Alerts defined here are automatically loaded without restarting Prometheus.

### Payment System Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-service-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus       # must match Prometheus CR selector
    role: alert-rules
spec:
  groups:
    - name: payment.errors
      interval: 30s
      rules:
        # Alert when payment error rate exceeds 1% over 5 minutes
        - alert: PaymentErrorRateHigh
          expr: |
            (
              sum(rate(payments_processed_total{status="failure"}[5m]))
              /
              sum(rate(payments_processed_total[5m]))
            ) > 0.01
          for: 2m
          labels:
            severity: critical
            team: payments
            runbook: "https://wiki.example.com/runbooks/payment-error-rate"
          annotations:
            summary: "Payment error rate is {{ $value | humanizePercentage }}"
            description: >
              Payment error rate has exceeded 1% for more than 2 minutes.
              Current rate: {{ $value | humanizePercentage }}.
              Investigate the payment-service logs immediately.

    - name: payment.latency
      rules:
        # Alert when p99 latency exceeds 500ms
        - alert: PaymentLatencyP99High
          expr: |
            histogram_quantile(0.99,
              sum by(le) (
                rate(payment_latency_seconds_bucket[5m])
              )
            ) > 0.5
          for: 3m
          labels:
            severity: warning
            team: payments
          annotations:
            summary: "Payment p99 latency is {{ $value | humanizeDuration }}"
            description: >
              p99 payment latency has exceeded 500ms for 3 minutes.
              This may indicate downstream database or fraud-check timeouts.

        # Alert when p99 latency exceeds 2 seconds — escalate
        - alert: PaymentLatencyP99Critical
          expr: |
            histogram_quantile(0.99,
              sum by(le) (
                rate(payment_latency_seconds_bucket[5m])
              )
            ) > 2.0
          for: 1m
          labels:
            severity: critical
            team: payments
          annotations:
            summary: "Payment p99 latency CRITICAL: {{ $value | humanizeDuration }}"

    - name: outbox.lag
      rules:
        # Alert when outbox has been lagging more than 60 seconds worth of events
        - alert: OutboxLagHigh
          expr: |
            sum by(topic) (outbox_pending_events_total) > 1000
          for: 60s
          labels:
            severity: warning
            team: messaging
          annotations:
            summary: "Outbox topic {{ $labels.topic }} has {{ $value }} pending events"
            description: >
              The transactional outbox for topic {{ $labels.topic }} has accumulated
              more than 1000 pending events, suggesting the relay processor is falling
              behind or has stopped. Check Kafka connectivity and relay pod health.

        # Dead outbox — no events processed in 5 minutes when queue is non-empty
        - alert: OutboxRelayStalled
          expr: |
            (sum by(topic) (outbox_pending_events_total) > 0)
            and
            (rate(outbox_events_published_total[5m]) == 0)
          for: 5m
          labels:
            severity: critical
            team: messaging
          annotations:
            summary: "Outbox relay has stalled for topic {{ $labels.topic }}"
```

---

## 6. Recording Rules for Pre-computed Queries

Recording rules materialise expensive queries into new time series, enabling fast dashboard loads.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: payment.rates
      interval: 30s
      rules:
        # Pre-compute payment TPS per method
        - record: job:payments_success_rate:rate5m
          expr: |
            sum by(payment_method, currency) (
              rate(payments_processed_total{status="success"}[5m])
            )

        # Pre-compute error ratio for SLO tracking
        - record: job:payments_error_ratio:rate5m
          expr: |
            sum(rate(payments_processed_total{status="failure"}[5m]))
            /
            sum(rate(payments_processed_total[5m]))

        # Pre-compute p99 latency
        - record: job:payment_latency_p99:rate5m
          expr: |
            histogram_quantile(0.99,
              sum by(le) (
                rate(payment_latency_seconds_bucket[5m])
              )
            )

        # Pre-compute p50 latency
        - record: job:payment_latency_p50:rate5m
          expr: |
            histogram_quantile(0.50,
              sum by(le) (
                rate(payment_latency_seconds_bucket[5m])
              )
            )
```

Recording rule names follow the convention `level:metric:operations` to make their origin clear in dashboards.

---

## 7. Prometheus Architecture for Production

```
                    ┌─────────────────────────────────────────┐
                    │          Kubernetes Cluster             │
                    │                                         │
  ┌──────────────┐  │  ┌────────────┐  ┌───────────────────┐ │
  │   Grafana    │  │  │  Payment   │  │  Fraud Detection  │ │
  │  Dashboards  │  │  │  Service   │  │      Service      │ │
  └──────┬───────┘  │  │ :8080/     │  │ :8080/            │ │
         │          │  │ actuator/  │  │ actuator/         │ │
         │ query    │  │ prometheus │  │ prometheus        │ │
         ▼          │  └─────┬──────┘  └────────┬──────────┘ │
  ┌──────────────┐  │        │ scrape            │ scrape     │
  │  Prometheus  │◄─┤────────┴───────────────────┘           │
  │  (operator)  │  │                                         │
  └──────┬───────┘  │  ┌────────────────────────────────────┐│
         │          │  │  PrometheusRule CRDs                ││
         │ alerts   │  │  - payment-service-alerts           ││
         ▼          │  │  - recording-rules                  ││
  ┌──────────────┐  │  └────────────────────────────────────┘│
  │ Alertmanager │  └─────────────────────────────────────────┘
  └──────┬───────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
 PagerDuty  Slack
```

---

## Production Pitfalls

### Pitfall 1: Histogram Bucket Misconfiguration Hides True Latency

The default Micrometer histogram buckets often do not align with your SLOs. If your SLO is p99 < 500ms but all your latencies fall in the last bucket (`+Inf`), `histogram_quantile` returns `+Inf` and your alert never fires.

**Fix**: always configure explicit SLO-aligned buckets.

```yaml
# application.yml
management:
  metrics:
    distribution:
      sla:
        payment.latency: 50ms,100ms,200ms,300ms,500ms,750ms,1000ms,2000ms,5000ms
      percentiles-histogram:
        payment.latency: true
```

Verify by querying raw buckets: `payment_latency_seconds_bucket`. Ensure observations are spread across buckets, not all in `+Inf`.

### Pitfall 2: Using Labels with Unbounded Cardinality

A label whose value comes from user input or is generated per-request (e.g., transaction ID, IP address, account number) produces one time series per unique value. With millions of transactions, this exhausts Prometheus memory and causes Out-Of-Memory restarts.

**Fix**: enforce a cardinality allowlist in Micrometer using `MeterFilter`.

```java
@Bean
public MeterFilter cardinalityEnforcementFilter() {
    return MeterFilter.denyUnless(id -> {
        // Only allow known, bounded label value sets
        String paymentMethod = id.getTag("payment_method");
        if (paymentMethod != null) {
            return Set.of("card", "bank_transfer", "wallet", "crypto")
                      .contains(paymentMethod);
        }
        return true;
    });
}
```

Also configure `prometheus.tsdb.max-block-chunk-size` and use recording rules to pre-aggregate before storing.

### Pitfall 3: Alert Flapping Due to Short Evaluation Windows

An alert with `for: 0` will fire on a single scrape anomaly (a network blip, a slow scrape). Payment systems have natural burst patterns; a 15-second spike in error rate should not wake up engineers at 3 AM.

**Fix**: always use a meaningful `for:` duration. For critical payment alerts, use `for: 2m`. For warnings, use `for: 5m`. Pair with an Alertmanager `repeat_interval` to prevent re-notification on sustained incidents.

```yaml
# Alertmanager config
route:
  receiver: payments-pagerduty
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h          # do not re-page until incident has lasted 4h
  routes:
    - match:
        severity: critical
      receiver: payments-pagerduty
      repeat_interval: 1h
    - match:
        severity: warning
      receiver: payments-slack
      repeat_interval: 24h
```

---

## Production Checklist

- [ ] All payment counters use bounded label cardinality (payment_method, currency, status)
- [ ] Latency histogram buckets are aligned to SLO thresholds
- [ ] `histogram_quantile` uses `sum by(le)` before calling the function
- [ ] `rate()` window is at least 4x the scrape interval
- [ ] PrometheusRule CRDs deployed and loaded (verify with `kubectl get prometheusrule`)
- [ ] Alertmanager routes tested with `amtool check-config`
- [ ] Recording rules cover all dashboard panels used in SLO tracking
- [ ] High-cardinality label protection implemented via MeterFilter
- [ ] Scrape target annotations verified — check `Status > Targets` in Prometheus UI
- [ ] Alert `for:` durations reviewed and documented in runbooks
- [ ] Outbox lag alert firing and routed to correct receiver
- [ ] `external_labels` set to cluster and environment for federation/thanos

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "A payment service runs 50 pods. You want to calculate the p99 payment latency across the entire fleet. Which PromQL expression is correct?",
      "options": [
        "histogram_quantile(0.99, rate(payment_latency_seconds_bucket[5m]))",
        "histogram_quantile(0.99, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
        "avg(histogram_quantile(0.99, rate(payment_latency_seconds_bucket[5m])))",
        "quantile(0.99, payment_latency_seconds_bucket[5m])"
      ],
      "correct": 1,
      "explanation": "You must sum the histogram buckets across all instances using sum by(le) before passing them to histogram_quantile. Option A calculates per-instance quantiles and returns a vector. Option C averages per-instance quantiles which is statistically incorrect. Option D is not valid PromQL for histograms."
    },
    {
      "text": "A new developer adds account_id as a Micrometer label on a payment counter. What is the most likely production impact?",
      "options": [
        "Prometheus scrape latency increases by 10ms",
        "Prometheus runs out of memory due to cardinality explosion and restarts",
        "The metric disappears from Grafana dashboards",
        "Alertmanager stops sending notifications"
      ],
      "correct": 1,
      "explanation": "Each unique label value combination creates a new time series. With millions of unique account IDs, Prometheus creates millions of time series causing an Out-Of-Memory (OOM) crash. This is known as a cardinality bomb and is one of the most common Prometheus production incidents in fintech."
    },
    {
      "text": "An alert for payment error rate uses for: 0. At 2:00 AM, a single slow Prometheus scrape causes a momentary spike. What happens?",
      "options": [
        "Nothing — Prometheus ignores single-sample anomalies",
        "Alertmanager waits for group_wait before sending",
        "The alert fires immediately and pages the on-call engineer",
        "The alert is silenced until business hours"
      ],
      "correct": 2,
      "explanation": "With for: 0, an alert fires on the first evaluation that satisfies the condition, with no stabilisation period. A single-scrape anomaly immediately triggers the alert, causing alert flapping. Production alerts should always use a meaningful for: duration (2m for critical, 5m for warnings) to filter transient noise."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "Prometheus Instrumentation for Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 90,
  "tasks": [
    {
      "id": "task-1",
      "description": "Instrument a Spring Boot payment service with Micrometer: add a Timer for payment latency with SLO-aligned histogram buckets (50ms, 100ms, 250ms, 500ms, 1s, 2s), a Counter partitioned by status and payment_method, and a Gauge for outbox pending event count. Verify metrics appear on /actuator/prometheus."
    },
    {
      "id": "task-2",
      "description": "Write three PromQL queries: (1) payment success TPS grouped by currency, (2) p99 and p50 latency for the fleet, (3) error rate as a percentage. Validate against a local Prometheus instance using docker-compose with the payment service as a scrape target."
    },
    {
      "id": "task-3",
      "description": "Create a PrometheusRule CRD with three alert rules: PaymentErrorRateHigh (> 1% for 2m, severity: critical), PaymentLatencyP99High (> 500ms for 3m, severity: warning), OutboxLagHigh (> 500 pending events for 60s, severity: warning). Include runbook annotations. Deploy to a local kind cluster with prometheus-operator."
    },
    {
      "id": "task-4",
      "description": "Add two recording rules to pre-compute p99 latency and error ratio with the naming convention job:metric:operation. Add a MeterFilter bean that rejects any metric with an unbounded label (specifically reject account_id, transaction_id, and user_id tags). Write a unit test using SimpleMeterRegistry to verify the filter blocks cardinality bombs."
    }
  ]
} -->
