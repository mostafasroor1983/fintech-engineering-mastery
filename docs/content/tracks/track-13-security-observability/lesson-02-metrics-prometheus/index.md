# Lesson 02: Metrics with Prometheus

## Overview

Prometheus is the de facto standard for metrics collection in cloud-native fintech systems. Its pull-based model, multi-dimensional data model, and powerful query language (PromQL) make it ideal for monitoring payment infrastructure, detecting anomalies, and feeding alerting pipelines.

## Prometheus Data Model

### Metric Types

**Counter**: Monotonically increasing value. Use for total counts.
```
payment_transactions_total{status="success", method="card"} 1048576
payment_transactions_total{status="failed", method="card"} 1234
```

**Gauge**: Value that can go up or down. Use for current state.
```
payment_queue_depth{region="us-east-1"} 342
active_payment_sessions 891
```

**Histogram**: Samples observations and counts them in configurable buckets.
```
payment_processing_duration_seconds_bucket{le="0.1"} 500000
payment_processing_duration_seconds_bucket{le="0.5"} 950000
payment_processing_duration_seconds_bucket{le="1.0"} 999000
payment_processing_duration_seconds_bucket{le="+Inf"} 1000000
payment_processing_duration_seconds_sum 48500.0
payment_processing_duration_seconds_count 1000000
```

**Summary**: Similar to histogram but calculates quantiles client-side. Avoid in distributed systems — quantiles cannot be aggregated across instances.

### Labels

Labels are key-value pairs that add dimensions. Design labels carefully:
- High cardinality labels (e.g., `user_id`, `transaction_id`) cause cardinality explosion — never use them.
- Good labels: `service`, `method`, `status`, `region`, `payment_method`.

## Instrumenting a Payment Service

### Java with Micrometer

```java
@Component
public class PaymentMetrics {
    private final Counter paymentCounter;
    private final Timer paymentTimer;
    private final Gauge queueDepthGauge;

    public PaymentMetrics(MeterRegistry registry, PaymentQueue queue) {
        this.paymentCounter = Counter.builder("payment.transactions")
            .description("Total payment transactions")
            .tag("service", "payment-processor")
            .register(registry);

        this.paymentTimer = Timer.builder("payment.processing.duration")
            .description("Payment processing latency")
            .publishPercentiles(0.5, 0.95, 0.99)
            .publishPercentileHistogram()
            .sla(Duration.ofMillis(100), Duration.ofMillis(500), Duration.ofSeconds(1))
            .register(registry);

        Gauge.builder("payment.queue.depth", queue, PaymentQueue::size)
            .description("Current payment queue depth")
            .register(registry);
    }

    public PaymentResult processWithMetrics(PaymentRequest req) {
        return paymentTimer.record(() -> {
            try {
                var result = doProcess(req);
                paymentCounter.increment(1, "status", "success",
                    "method", req.getMethod());
                return result;
            } catch (Exception e) {
                paymentCounter.increment(1, "status", "error",
                    "error_type", e.getClass().getSimpleName());
                throw e;
            }
        });
    }
}
```

## Critical Fintech Metrics to Track

### Business Metrics
```promql
# Payment success rate
rate(payment_transactions_total{status="success"}[5m]) /
rate(payment_transactions_total[5m])

# Revenue per minute
rate(payment_amount_usd_total[1m])

# Failed payment rate by method
rate(payment_transactions_total{status="failed"}[5m]) by (method)
```

### Infrastructure Metrics
```promql
# P99 payment latency
histogram_quantile(0.99, rate(payment_processing_duration_seconds_bucket[5m]))

# Error budget burn rate (for SLO alerting)
1 - (
  rate(payment_transactions_total{status="success"}[1h]) /
  rate(payment_transactions_total[1h])
)

# Queue saturation
payment_queue_depth / payment_queue_capacity
```

## Prometheus Configuration

### Scrape Configuration
```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'payment-service'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
    metric_relabel_configs:
      # Drop high-cardinality metrics
      - source_labels: [transaction_id]
        action: drop
        regex: .+
```

### Remote Write for Long-Term Storage
```yaml
remote_write:
  - url: https://cortex-or-thanos-endpoint/api/v1/push
    queue_config:
      max_samples_per_send: 10000
      max_shards: 30
      capacity: 100000
    write_relabel_configs:
      - source_labels: [__name__]
        regex: "payment_.*|fraud_.*|ledger_.*"
        action: keep
```

## Recording Rules for Performance

Pre-compute expensive queries as recording rules:
```yaml
groups:
  - name: payment_slo
    interval: 30s
    rules:
      - record: job:payment_success_rate:rate5m
        expr: |
          rate(payment_transactions_total{status="success"}[5m])
          / rate(payment_transactions_total[5m])

      - record: job:payment_p99_latency:rate5m
        expr: |
          histogram_quantile(0.99,
            rate(payment_processing_duration_seconds_bucket[5m]))
```

## Cardinality Management

High cardinality is the #1 operational problem with Prometheus in fintech. Strategies:

1. **Audit metrics regularly** using `prometheus_tsdb_head_series` and `topk(10, count by (__name__)({__name__=~".+"}))`
2. **Never label by user ID, session ID, or transaction ID**
3. **Use exemplars** for trace correlation instead of high-cardinality labels
4. **Drop unused metrics** at the collector level with `metric_relabel_configs`
5. **Set per-scrape limits** with `sample_limit` to prevent accidental explosions

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why should you avoid using 'transaction_id' as a Prometheus label for payment metrics?",
      "options": ["Transaction IDs are confidential PCI data", "It causes cardinality explosion, making Prometheus unscalable", "Prometheus does not support string labels", "Transaction IDs are not useful for aggregation"],
      "correct": 1,
      "explanation": "Each unique label value combination creates a separate time series. Transaction IDs are unique per transaction, so using them as labels would create millions of time series, overwhelming Prometheus memory and storage — this is called cardinality explosion."
    },
    {
      "text": "Which Prometheus metric type should you use to track the current number of pending payments in a queue?",
      "options": ["Counter", "Histogram", "Summary", "Gauge"],
      "correct": 3,
      "explanation": "A Gauge is designed for values that can go up or down — like queue depth, active sessions, or current memory usage. A Counter is monotonically increasing and cannot decrease, making it unsuitable for tracking current queue size."
    },
    {
      "text": "What is the main advantage of using recording rules for SLO calculations in Prometheus?",
      "options": ["They automatically alert when SLOs are breached", "They pre-compute expensive queries, improving dashboard and alert performance", "They store metrics for longer retention periods", "They enable cross-cluster metric federation"],
      "correct": 1,
      "explanation": "Recording rules evaluate PromQL expressions on a schedule and store the results as new time series. This means dashboards and alert rules can query the pre-computed result instead of re-running expensive range queries over raw data, significantly reducing query latency and load."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Payment Metrics Observability Stack with Prometheus",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Instrument a Spring Boot payment service with Micrometer, exposing counters (transactions by status and method), timers with P50/P95/P99 percentiles and SLA buckets, and a gauge for queue depth — all without introducing high-cardinality labels."},
    {"id": "2", "description": "Write PromQL recording rules for: 5-minute payment success rate, P99 processing latency, and error budget burn rate. Validate they produce correct results against a test dataset."},
    {"id": "3", "description": "Configure Prometheus scrape relabeling to automatically discover payment service pods via Kubernetes annotations and drop any metric series with cardinality above 10,000 unique label combinations."},
    {"id": "4", "description": "Build a Grafana dashboard with four panels: real-time success rate, P99 latency trend over 24h, payment volume by method (stacked), and an error budget remaining gauge — all sourced from recording rules."}
  ]
}
-->
