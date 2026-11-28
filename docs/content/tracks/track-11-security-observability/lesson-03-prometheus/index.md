---
id: track-11-lesson-03
title: "Prometheus and PromQL — Metrics for Financial Systems"
slug: prometheus-promql
track: track-11
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
  - track-11-lesson-02
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
# HELP outbox_pending_events Number of events waiting in the transactional outbox
# TYPE outbox_pending_events gauge
outbox_pending_events{topic="payment.completed"} 12
outbox_pending_events{topic="fraud.alert"} 0
```

Gauges are ideal for queue depths, connection pool sizes, and cache hit ratios. (The `_total` suffix is reserved for counters — a gauge never has it.)

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
  metrics:
    distribution:
      percentiles-histogram:
        payment.latency: true          # enables histogram buckets
      slo:                             # extra buckets at the SLO boundaries
        payment.latency: 50ms,100ms,250ms,500ms,1000ms
      # (avoid "percentiles:" here: client-side percentiles are computed per
      #  instance and cannot be aggregated across pods)
    tags:
      application: payment-service
      environment: production
      region: eu-west-1
```

### Payment Latency Histogram (Java)

```java
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Service;

import java.time.Duration;

@Service
public class PaymentMetrics {

    private final MeterRegistry registry;
    private final Timer paymentLatency;

    public PaymentMetrics(MeterRegistry registry, OutboxRepository outboxRepository) {
        this.registry = registry;

        // Histogram for end-to-end payment latency
        this.paymentLatency = Timer.builder("payment.latency")
            .description("End-to-end payment processing latency")
            .publishPercentileHistogram(true)
            .minimumExpectedValue(Duration.ofMillis(10))
            .maximumExpectedValue(Duration.ofSeconds(10))
            .register(registry);

        // Gauge for transactional outbox lag. Every replica reports the same
        // DB count -- aggregate it with max(), not sum(), in PromQL. The
        // query runs on every scrape: keep it cheap (or cache the value).
        Gauge.builder("outbox.pending.events",
                outboxRepository, OutboxRepository::countPending)
            .description("Number of events pending in the transactional outbox")
            .register(registry);
    }

    public PaymentResult processPayment(PaymentRequest request) {
        return paymentLatency.record(() -> {
            try {
                PaymentResult result = doProcessPayment(request);
                outcome("success", "none").increment();
                return result;
            } catch (PaymentException ex) {
                // failure reason as a tag (bounded set of error codes)
                outcome("failure", ex.getErrorCode()).increment();
                throw ex;
            }
        });
    }

    // The Prometheus registry requires every meter with the same name to
    // have the SAME set of tag keys -- so "reason" is always present
    // ("none" for successes). Mixing {status} and {status,reason} under one
    // name fails at registration. Micrometer caches the counter per tag set.
    private Counter outcome(String status, String reason) {
        return Counter.builder("payments.processed")
            .description("Payments processed, by outcome")
            .tags("status", status, "reason", reason)
            .register(registry);
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

# p99 latency per pod (find the outlier pod)
max by(pod) (
  histogram_quantile(0.99,
    sum by(le, pod) (rate(payment_latency_seconds_bucket[5m]))
  )
)

# Outbox backlog per topic: every replica reports the same DB count,
# so take max (sum would multiply it by the replica count)
max by(topic) (outbox_pending_events)
```

---

## 4. Scrape Configuration for Kubernetes Pods

Prometheus discovers targets using Kubernetes service discovery. Annotate pods to control scraping. (With the Prometheus Operator, the usual way is a `PodMonitor` or `ServiceMonitor` resource instead of annotations; the annotation convention below is for plain Prometheus.)

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
      # Use the annotated port: keep the pod IP from __address__ and swap
      # in the port (replacing __address__ with only the port would leave
      # Prometheus without a host to scrape)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
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
          annotations:
            # runbook links are annotations (labels identify the alert)
            runbook_url: "https://wiki.example.com/runbooks/payment-error-rate"
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
        # Alert when more than 1000 events wait in the outbox for 60s
        - alert: OutboxLagHigh
          expr: |
            max by(topic) (outbox_pending_events) > 1000
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
          # Both sides aggregated to the SAME labels (topic): "and" matches
          # series by labels, so a side keeping pod/instance labels would
          # never match and the alert could never fire
          expr: |
            (max by(topic) (outbox_pending_events) > 0)
            and
            (sum by(topic) (rate(outbox_events_published_total[5m])) == 0)
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
        # Pre-compute payment TPS per method and currency
        - record: payment_method_currency:payments_processed_success:rate5m
          expr: |
            sum by(payment_method, currency) (
              rate(payments_processed_total{status="success"}[5m])
            )

        # Pre-compute error ratio for SLO tracking (aggregated over everything)
        - record: cluster:payments_error_ratio:rate5m
          expr: |
            sum(rate(payments_processed_total{status="failure"}[5m]))
            /
            sum(rate(payments_processed_total[5m]))

        # Pre-compute the aggregated bucket rates once...
        - record: le:payment_latency_seconds_bucket:rate5m
          expr: |
            sum by(le) (rate(payment_latency_seconds_bucket[5m]))

        # ...and derive quantiles from them cheaply
        - record: cluster:payment_latency_seconds:p99_5m
          expr: |
            histogram_quantile(0.99, le:payment_latency_seconds_bucket:rate5m)

        - record: cluster:payment_latency_seconds:p50_5m
          expr: |
            histogram_quantile(0.50, le:payment_latency_seconds_bucket:rate5m)
```

Recording rule names follow the convention `level:metric:operations` — *level* names the labels that remain after aggregation (`cluster` when everything is summed, `payment_method_currency` when those two are kept) — to make their origin clear in dashboards.

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

The default Micrometer histogram buckets often do not align with your SLOs, and the quantile is interpolated *within* a bucket — so with a bucket from 300ms to 1s, a "p99 = 480ms" is an estimate that may hide a real p99 of 900ms. And if the quantile falls into the last (`+Inf`) bucket, `histogram_quantile` simply returns the upper bound of the highest finite bucket — latencies beyond your largest bucket become invisible.

**Fix**: always configure explicit SLO-aligned buckets.

```yaml
# application.yml
management:
  metrics:
    distribution:
      slo:
        payment.latency: 50ms,100ms,200ms,300ms,500ms,750ms,1000ms,2000ms,5000ms
      percentiles-histogram:
        payment.latency: true
```

Verify by querying raw buckets: `payment_latency_seconds_bucket`. Ensure observations are spread across buckets, not all in `+Inf`.

### Pitfall 2: Using Labels with Unbounded Cardinality

A label whose value comes from user input or is generated per-request (e.g., transaction ID, IP address, account number) produces one time series per unique value. With millions of transactions, this exhausts Prometheus memory and causes Out-Of-Memory restarts.

**Fix**: strip forbidden tags and cap the number of series per meter in Micrometer with `MeterFilter`s.

```java
@Bean
public MeterFilter stripUnboundedTags() {
    // Remove per-entity identifiers from every meter, wherever they come from
    return MeterFilter.ignoreTags("account_id", "transaction_id", "user_id");
}

@Bean
public MeterFilter capUriTagCardinality() {
    // At most 100 distinct "uri" values for HTTP metrics; beyond that new
    // values are denied instead of creating new time series
    return MeterFilter.maximumAllowableTags(
        "http.server.requests", "uri", 100, MeterFilter.deny());
}
```

As a second line of defence on the Prometheus side, set `sample_limit` and `label_limit` in the scrape config, so one misbehaving service cannot flood the server — the scrape fails visibly instead.

### Pitfall 3: Alert Flapping Due to Short Evaluation Windows

An alert with `for: 0` will fire on a single scrape anomaly (a network blip, a slow scrape). Payment systems have natural burst patterns; a 15-second spike in error rate should not wake up engineers at 3 AM.

**Fix**: always use a meaningful `for:` duration. For critical payment alerts, use `for: 2m`. For warnings, use `for: 5m`. Pair with an Alertmanager `repeat_interval` to prevent re-notification on sustained incidents.

```yaml
# Alertmanager config
route:
  receiver: payments-pagerduty
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h          # re-notify every 4h while the alert keeps firing
  routes:
    - matchers:                # "match:" is the deprecated older syntax
        - severity="critical"
      receiver: payments-pagerduty
      repeat_interval: 1h
    - matchers:
        - severity="warning"
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
- [ ] High-cardinality label protection implemented via MeterFilter (ignoreTags / maximumAllowableTags) and scrape `sample_limit`
- [ ] All meters sharing a name use the same tag keys
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
      "explanation": "With for: 0, an alert becomes firing on the first evaluation that satisfies the condition, with no stabilisation period. Alertmanager only waits the short group_wait (e.g. 30s) to batch alerts, then pages — so a momentary anomaly wakes the on-call engineer, and the alert flaps. Production alerts should always use a meaningful for: duration (2m for critical, 5m for warnings) to filter transient noise."
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
      "description": "Add recording rules that pre-compute the aggregated latency bucket rates, the p99 latency and the error ratio, named with the level:metric:operations convention (level = labels kept). Add MeterFilter beans that strip unbounded tags (account_id, transaction_id, user_id) and cap the uri tag cardinality. Write a unit test using SimpleMeterRegistry to verify the filters block cardinality bombs."
    }
  ]
} -->
