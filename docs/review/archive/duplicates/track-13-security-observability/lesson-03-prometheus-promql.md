---
id: track-13-lesson-03
title: "Prometheus and PromQL — Metrics for Financial Systems"
slug: prometheus-promql
track: track-13
trackName: "Security & Observability"
sequence: 3
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [Prometheus, PromQL, counter, histogram, alerting]
prerequisites: [track-13-lesson-01]
---

# Prometheus and PromQL — Metrics for Financial Systems

> [!NOTE]
> Prometheus is the de facto metrics standard for cloud-native financial systems. The difference between a team that fires alerts on symptoms vs root causes is almost entirely in how well they model their business metrics and write their PromQL queries. This lesson takes you from metric fundamentals through production-grade alerting expressions used by payment platforms at scale.

## 1. Metric Types

Prometheus exposes four metric types. Understanding when to use each determines whether your data makes sense mathematically.

### 1.1 Counter

A counter monotonically increases and resets only on process restart. It measures **cumulative totals**.

```java
// Micrometer counter — payments processed
Counter paymentsProcessed = Counter.builder("payments.processed.total")
    .description("Total number of payments processed")
    .tag("currency", "GBP")
    .tag("type", "DOMESTIC")
    .register(meterRegistry);

paymentsProcessed.increment();
```

**PromQL:** Use `rate()` or `increase()` to derive a per-second rate from a counter. Never alert on a raw counter value.

### 1.2 Gauge

A gauge can go up or down. It represents a **current snapshot** (queue depth, connection pool size, account balance).

```java
// Micrometer gauge — Kafka consumer lag
Gauge.builder("kafka.consumer.lag", lagProvider, LagProvider::getCurrentLag)
    .description("Current consumer group lag in messages")
    .tag("topic", "payment.requests")
    .tag("consumer_group", "payment-processor")
    .register(meterRegistry);
```

### 1.3 Histogram

A histogram samples observations and counts them in configurable buckets. It enables **quantile estimation** (P50, P95, P99 latency) in PromQL.

```java
// Micrometer timer — payment processing duration
Timer paymentTimer = Timer.builder("payment.processing.duration")
    .description("Payment end-to-end processing latency")
    .tag("type", "WIRE_TRANSFER")
    .serviceLevelObjectives(
        Duration.ofMillis(100),
        Duration.ofMillis(300),
        Duration.ofMillis(500),
        Duration.ofMillis(1000),
        Duration.ofSeconds(2)
    )
    .register(meterRegistry);

paymentTimer.record(() -> processPayment(request));
```

This generates three metric families:
- `payment_processing_duration_seconds_bucket{le="0.1"}` — count of payments ≤ 100 ms
- `payment_processing_duration_seconds_sum` — total time spent
- `payment_processing_duration_seconds_count` — total payment count

### 1.4 Summary

A summary computes **client-side quantiles** (precomputed, not aggregatable across instances). Avoid summaries in multi-instance deployments; use histograms instead.

---

## 2. Spring Boot Micrometer — Custom Business Metrics

```java
package com.bank.payments.metrics;

import io.micrometer.core.instrument.*;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

@Component
public class PaymentMetrics {

    private final Counter paymentsSubmitted;
    private final Counter paymentsCompleted;
    private final Counter paymentsFailed;
    private final Counter paymentsRejectedFraud;
    private final Timer paymentProcessingTime;
    private final Timer fraudCheckTime;
    private final AtomicInteger pendingPayments;
    private final DistributionSummary paymentAmountGBP;

    public PaymentMetrics(MeterRegistry registry) {
        this.paymentsSubmitted = Counter.builder("payments.submitted.total")
            .description("Payments submitted for processing")
            .register(registry);

        this.paymentsCompleted = Counter.builder("payments.completed.total")
            .description("Payments successfully completed")
            .register(registry);

        this.paymentsFailed = Counter.builder("payments.failed.total")
            .description("Payments that failed due to system error")
            .register(registry);

        this.paymentsRejectedFraud = Counter.builder("payments.rejected.fraud.total")
            .description("Payments rejected by fraud engine")
            .register(registry);

        this.paymentProcessingTime = Timer.builder("payment.processing.seconds")
            .description("End-to-end payment processing latency")
            .serviceLevelObjectives(
                Duration.ofMillis(200),
                Duration.ofMillis(500),
                Duration.ofSeconds(1),
                Duration.ofSeconds(2),
                Duration.ofSeconds(5)
            )
            .percentilePrecision(2)
            .publishPercentileHistogram()
            .register(registry);

        this.fraudCheckTime = Timer.builder("fraud.check.seconds")
            .description("Fraud check service call latency")
            .publishPercentileHistogram()
            .register(registry);

        this.pendingPayments = new AtomicInteger(0);
        Gauge.builder("payments.pending.count", pendingPayments, AtomicInteger::get)
            .description("Current number of payments in-flight")
            .register(registry);

        this.paymentAmountGBP = DistributionSummary.builder("payment.amount.gbp")
            .description("Payment amount distribution in GBP")
            .baseUnit("GBP")
            .scale(0.01)  // convert pence to pounds
            .serviceLevelObjectives(10, 100, 1000, 10000, 100000)
            .register(registry);
    }

    public void recordPaymentSubmitted() { paymentsSubmitted.increment(); }
    public void recordPaymentCompleted(Duration duration) {
        paymentsCompleted.increment();
        paymentProcessingTime.record(duration);
    }
    public void recordPaymentFailed() { paymentsFailed.increment(); }
    public void recordFraudRejection() { paymentsRejectedFraud.increment(); }
    public void recordFraudCheckDuration(Duration duration) {
        fraudCheckTime.record(duration);
    }
    public void recordPaymentAmount(long amountPence) {
        paymentAmountGBP.record(amountPence);
    }
    public void incrementPending() { pendingPayments.incrementAndGet(); }
    public void decrementPending() { pendingPayments.decrementAndGet(); }
}
```

### 2.1 JVM and HTTP Metrics (Auto-exposed)

Spring Boot Actuator + Micrometer exposes these automatically:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,metrics
  endpoint:
    prometheus:
      enabled: true
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 50ms, 100ms, 200ms, 500ms, 1s, 2s
```

Key auto-exposed metrics:
- `jvm_memory_used_bytes{area="heap"}` / `jvm_memory_max_bytes{area="heap"}`
- `jvm_gc_pause_seconds_bucket` — GC pause distribution
- `jvm_threads_live_threads` / `jvm_threads_daemon_threads`
- `http_server_requests_seconds_bucket` — HTTP latency histogram
- `hikaricp_connections_active` / `hikaricp_connections_pending` — connection pool

---

## 3. PromQL Operators for Financial System Queries

### 3.1 rate() vs irate()

```promql
# rate(): average rate over the range window (5 minutes)
# Smooths over spikes — use for alerting and dashboards
rate(payments_completed_total[5m])

# irate(): instantaneous rate based on last two data points
# Shows spikes immediately — use for debugging only
irate(payments_completed_total[5m])
```

**Rule:** Use `rate()` for alerting (it's stable). Use `irate()` only when you need to see a spike in real time during an incident.

### 3.2 increase()

```promql
# Total payments processed in the last hour
increase(payments_completed_total[1h])

# Payments failed in the last 15 minutes
increase(payments_failed_total[15m])
```

### 3.3 histogram_quantile()

```promql
# P99 payment processing latency over the last 5 minutes
histogram_quantile(0.99,
  rate(payment_processing_seconds_bucket[5m])
)

# P95 latency by payment type
histogram_quantile(0.95,
  sum by (le, type) (
    rate(payment_processing_seconds_bucket[5m])
  )
)

# P99 HTTP latency for payment endpoints only
histogram_quantile(0.99,
  sum by (le, uri) (
    rate(http_server_requests_seconds_bucket{
      uri=~"/api/v1/payments.*",
      status!~"5.."
    }[5m])
  )
)
```

### 3.4 Aggregation Operators

```promql
# Total payment throughput across all instances
sum(rate(payments_completed_total[5m]))

# Payment throughput per service instance
sum by (instance) (rate(payments_completed_total[5m]))

# Error rate percentage
100 * (
  sum(rate(payments_failed_total[5m]))
  /
  sum(rate(payments_submitted_total[5m]))
)

# Kafka consumer lag — maximum across all partitions
max by (topic) (kafka_consumer_lag)

# Alert: consumer lag > 10,000 messages
kafka_consumer_lag{topic="payment.requests"} > 10000
```

### 3.5 Multi-Dimensional SLO Tracking

```promql
# SLO: 99.9% of payments complete within 2 seconds
# Numerator: payments completing within 2s SLO
sum(rate(payment_processing_seconds_bucket{le="2.0"}[5m]))
/
sum(rate(payment_processing_seconds_count[5m]))

# Error budget: fraction of budget remaining
1 - (
  1 - (
    sum(rate(payment_processing_seconds_bucket{le="2.0"}[30d]))
    /
    sum(rate(payment_processing_seconds_count[30d]))
  )
) / (1 - 0.999)
```

---

## 4. Recording Rules for Expensive Queries

PromQL queries that aggregate across many time series are expensive at query time. Recording rules precompute these and store them as new metrics.

```yaml
# prometheus/rules/payment-recording-rules.yaml
groups:
  - name: payment_recording_rules
    interval: 30s
    rules:
      # Pre-compute payment success rate — reused in alerts and dashboards
      - record: payment:success_rate:rate5m
        expr: |
          sum(rate(payments_completed_total[5m]))
          /
          sum(rate(payments_submitted_total[5m]))

      # Pre-compute P99 payment latency per payment type
      - record: payment:latency_p99:rate5m
        expr: |
          histogram_quantile(0.99,
            sum by (le, type) (
              rate(payment_processing_seconds_bucket[5m])
            )
          )

      # Pre-compute P99 latency overall
      - record: payment:latency_p99_overall:rate5m
        expr: |
          histogram_quantile(0.99,
            sum by (le) (
              rate(payment_processing_seconds_bucket[5m])
            )
          )

      # Pre-compute fraud rejection rate
      - record: payment:fraud_rejection_rate:rate5m
        expr: |
          sum(rate(payments_rejected_fraud_total[5m]))
          /
          sum(rate(payments_submitted_total[5m]))

      # Kafka consumer lag — max lag across payment topics
      - record: kafka:payment_consumer_lag:max
        expr: |
          max by (consumer_group) (
            kafka_consumer_lag{topic=~"payment\\..*"}
          )
```

```yaml
# prometheus.yaml — reference the recording rules file
rule_files:
  - "rules/payment-recording-rules.yaml"
  - "rules/payment-alert-rules.yaml"
```

---

## 5. Multi-Dimensional Alerting

### 5.1 Payment Error Rate Alert

```yaml
# prometheus/rules/payment-alert-rules.yaml
groups:
  - name: payment_alerts
    rules:
      # Critical: payment error rate > 1% for 5 minutes
      - alert: PaymentErrorRateHigh
        expr: |
          (
            sum(rate(payments_failed_total[5m]))
            /
            sum(rate(payments_submitted_total[5m]))
          ) > 0.01
        for: 5m
        labels:
          severity: critical
          team: payments
          runbook: "https://wiki.bank.com/runbooks/payment-error-rate"
        annotations:
          summary: "Payment error rate is {{ $value | humanizePercentage }}"
          description: |
            Payment error rate has exceeded 1% for 5 minutes.
            Current rate: {{ $value | humanizePercentage }}
            This may indicate a downstream system failure (ledger, fraud check).

      # Warning: P99 latency > 1 second
      - alert: PaymentLatencyP99High
        expr: payment:latency_p99_overall:rate5m > 1.0
        for: 5m
        labels:
          severity: warning
          team: payments
          runbook: "https://wiki.bank.com/runbooks/payment-latency"
        annotations:
          summary: "Payment P99 latency is {{ $value | humanizeDuration }}"
          description: |
            Payment P99 latency has exceeded 1 second for 5 minutes.
            Check fraud-check-service response times and database query plans.

      # Critical: Kafka consumer lag > 50,000 messages
      - alert: PaymentKafkaConsumerLagCritical
        expr: kafka:payment_consumer_lag:max > 50000
        for: 2m
        labels:
          severity: critical
          team: payments
        annotations:
          summary: "Kafka consumer {{ $labels.consumer_group }} lag is {{ $value }}"
          description: |
            Consumer group {{ $labels.consumer_group }} is lagging significantly.
            Payments may be delayed. Check payment-processor pod count and health.

      # Warning: fraud rejection spike (possible fraud wave)
      - alert: FraudRejectionRateSpike
        expr: payment:fraud_rejection_rate:rate5m > 0.05
        for: 3m
        labels:
          severity: warning
          team: fraud
        annotations:
          summary: "Fraud rejection rate is {{ $value | humanizePercentage }}"
          description: |
            Fraud rejection rate has exceeded 5%. This may indicate:
            1. An active fraud wave (escalate to fraud team)
            2. Misconfigured fraud model (check recent deployments)

      # Warning: connection pool saturation
      - alert: HikariConnectionPoolSaturation
        expr: |
          hikaricp_connections_active
          /
          hikaricp_connections_max
          > 0.8
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "DB connection pool {{ $value | humanizePercentage }} utilised"
```

### 5.2 JVM Alerting

```yaml
      # Critical: GC pause time > 1s (stop-the-world impact)
      - alert: JvmGcPauseTimeCritical
        expr: |
          histogram_quantile(0.99,
            rate(jvm_gc_pause_seconds_bucket{cause=~".*Major.*|.*Full.*"}[5m])
          ) > 1.0
        for: 2m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "JVM GC pause P99 is {{ $value | humanizeDuration }}"
          description: |
            Major GC pause P99 exceeds 1 second. Service may be experiencing
            stop-the-world pauses affecting payment latency.

      # Warning: heap usage > 85%
      - alert: JvmHeapUsageHigh
        expr: |
          jvm_memory_used_bytes{area="heap"}
          /
          jvm_memory_max_bytes{area="heap"}
          > 0.85
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "JVM heap usage is {{ $value | humanizePercentage }}"
```

---

## 6. Prometheus Federation and Remote Write

### 6.1 Federation for Multi-Cluster Financial Systems

A bank typically has separate Prometheus instances per Kubernetes cluster (UK-West, UK-East, DR). A global Prometheus federates aggregate metrics for the global dashboard:

```yaml
# Global Prometheus — federation config
scrape_configs:
  - job_name: "federate-uk-west"
    scrape_interval: 60s
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        - '{__name__=~"payment:.*"}'    # Recording rules only
        - '{__name__=~"kafka:.*"}'
        - '{__name__=~"jvm_memory.*"}'
    static_configs:
      - targets: ["prometheus-uk-west.monitoring.svc:9090"]

  - job_name: "federate-uk-east"
    scrape_interval: 60s
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        - '{__name__=~"payment:.*"}'
        - '{__name__=~"kafka:.*"}'
    static_configs:
      - targets: ["prometheus-uk-east.monitoring.svc:9090"]
```

### 6.2 Remote Write to Thanos

For long-term retention (90+ days required by FCA/MAS for financial services), remote-write to Thanos or Cortex:

```yaml
# prometheus.yaml — remote write to Thanos Receiver
remote_write:
  - url: https://thanos-receiver.monitoring.bank.internal/api/v1/receive
    tls_config:
      cert_file: /etc/prometheus/certs/client.crt
      key_file: /etc/prometheus/certs/client.key
      ca_file: /etc/prometheus/certs/ca.crt
    queue_config:
      max_samples_per_send: 10000
      batch_send_deadline: 5s
      min_backoff: 30ms
      max_backoff: 100ms
    write_relabel_configs:
      # Drop high-cardinality debug metrics before remote write
      - source_labels: [__name__]
        regex: "go_.*|process_.*"
        action: drop
```

---

## 7. Prometheus Scraping Configuration

```yaml
# prometheus.yaml — scrape payment services
scrape_configs:
  - job_name: "payment-service"
    scrape_interval: 15s
    scrape_timeout: 10s
    metrics_path: /actuator/prometheus
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [payments]
    relabel_configs:
      # Only scrape pods with the prometheus scrape annotation
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      # Use the annotated port if specified
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: (.+)
        replacement: ${__meta_kubernetes_pod_ip}:${1}
      # Add service name label from pod label
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: service
      # Add namespace
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
```

```yaml
# Kubernetes pod annotations to enable scraping
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  template:
    metadata:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/actuator/prometheus"
```

---

## 8. Cardinality Management — A Financial Systems Trap

High cardinality destroys Prometheus performance. Never use unbounded label values:

```java
// WRONG — payment ID as a label explodes cardinality
Timer.builder("payment.processing")
    .tag("payment_id", payment.getId())   // millions of unique values!
    .register(registry);

// CORRECT — only low-cardinality labels
Timer.builder("payment.processing")
    .tag("type", payment.getType().name())     // DOMESTIC, INTERNATIONAL, WIRE
    .tag("currency", payment.getCurrency())    // GBP, EUR, USD
    .tag("channel", payment.getChannel().name()) // API, MOBILE, BRANCH
    .register(registry);
```

**Label cardinality budget:** Each combination of label values creates a new time series. A metric with 3 labels of cardinality 5, 10, 3 creates up to 150 time series. Multiply by all services and you can easily hit millions of series.

Target: fewer than 10,000 unique time series per service.

---

## 9. Payment Dashboard Metrics Summary

| Metric | Type | PromQL Use |
|--------|------|------------|
| `payments_submitted_total` | Counter | `rate()[5m]` = throughput |
| `payments_completed_total` | Counter | `rate()[5m]` = success rate |
| `payments_failed_total` | Counter | `rate()[5m]` / submitted = error % |
| `payment_processing_seconds_bucket` | Histogram | `histogram_quantile(0.99,...)` |
| `fraud_check_seconds_bucket` | Histogram | P99 fraud latency |
| `payments_pending_count` | Gauge | Direct — current backlog |
| `kafka_consumer_lag` | Gauge | `max by (topic)` |
| `hikaricp_connections_active` | Gauge | active / max = utilisation |
| `jvm_memory_used_bytes{area="heap"}` | Gauge | used / max = heap % |

---

## 10. Summary

Prometheus at the principal-engineer level is about three things:

1. **Metric modeling** — choose counters for totals, histograms for latency distributions, and gauges for current state. Never use unbounded label cardinality in a production financial system.

2. **PromQL fluency** — `rate()` over `irate()` for alerting, `histogram_quantile()` for latency percentiles, recording rules for expensive computations that power both alerts and dashboards.

3. **Operational scale** — federation for multi-region financial deployments, remote write to Thanos for the 90-day retention regulators require, and cardinality budgets that prevent Prometheus from becoming a bottleneck.

The business metrics layer — payments_completed, fraud_rejection_rate, consumer_lag — is what separates a generic observability deployment from one that actually helps you meet your SLAs and detect fraud-wave incidents.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the correct PromQL function for calculating the per-second rate of a payment counter metric suitable for use in alerting rules?",
      "options": ["irate(payments_submitted_total[5m])", "rate(payments_submitted_total[5m])", "delta(payments_submitted_total[5m])", "increase(payments_submitted_total[5m])"],
      "correct": 1,
      "explanation": "rate() calculates a smoothed per-second rate over the entire window, making it stable enough for alerting. irate() uses only the last two samples and is too spiky for alert rules. delta() and increase() return totals, not per-second rates."
    },
    {
      "text": "Why should payment_id never be used as a Prometheus label value?",
      "options": ["Prometheus does not support string labels", "Each unique label value combination creates a new time series, so using payment IDs would create millions of time series and cause Prometheus performance degradation", "Payment IDs contain PCI data that cannot be in metrics", "Prometheus counters do not support label values"],
      "correct": 1,
      "explanation": "High cardinality labels destroy Prometheus performance. Each unique combination of label values creates a separate time series stored in memory. Using payment_id (millions of unique values) could create hundreds of millions of time series, exhausting memory and making queries impossibly slow."
    },
    {
      "text": "What Prometheus configuration is required for a financial institution to retain metrics data for 90 days as required by FCA regulations?",
      "options": ["Increase Prometheus local storage retention to 90d", "Use remote_write to send data to Thanos or Cortex for long-term storage", "Configure Alertmanager to archive metrics", "Use Prometheus federation to copy data to a second Prometheus"],
      "correct": 1,
      "explanation": "Prometheus local storage is not designed for long-term retention — it becomes impractical beyond 15-30 days. Remote write to Thanos or Cortex provides object storage-backed long-term retention at scale, which is the standard approach for the 90-day regulatory retention requirement."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Production-Grade Prometheus Metrics for Payment Services",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Instrument a Spring Boot payment service with Micrometer: define counters for payments_submitted_total and payments_failed_total (with type and currency labels), a histogram for payment_processing_seconds (with appropriate buckets for a 500ms SLO), and a gauge for payments_pending_count."},
    {"id": "2", "description": "Write Prometheus recording rules to pre-compute: 5-minute payment error rate ratio, P99 payment latency per payment type, and Kafka consumer lag maximum across all consumer groups."},
    {"id": "3", "description": "Write three Alertmanager alert rules: a critical alert for payment error rate exceeding 5% for 2 minutes, a warning alert for P99 latency over 1 second for 5 minutes, and a critical alert for Kafka consumer lag exceeding 50,000 messages."},
    {"id": "4", "description": "Configure Prometheus remote_write to a local Thanos Receiver and verify metrics are queryable via Thanos Query; set up a write_relabel_config to drop high-cardinality debug metrics before remote write."}
  ]
}
-->
