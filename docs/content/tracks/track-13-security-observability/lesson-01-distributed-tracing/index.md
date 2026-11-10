# Lesson 01: Distributed Tracing

## Overview

Distributed tracing is the practice of tracking a single request as it flows through multiple services in a distributed system. In fintech, where a single payment transaction may touch dozens of microservices — authentication, fraud detection, ledger, compliance, notification — tracing is essential for understanding latency, diagnosing failures, and meeting audit requirements.

## Core Concepts

### Trace, Span, and Context

A **trace** represents the full end-to-end journey of a request. It is composed of **spans** — individual units of work performed by a single service or component. Each span records:

- Operation name
- Start timestamp and duration
- Tags (key-value metadata)
- Logs (timestamped events within the span)
- References to parent spans

**Trace context propagation** passes trace identifiers (trace ID, span ID, sampling flags) between services via HTTP headers (W3C TraceContext: `traceparent`, `tracestate`) or messaging metadata.

### Sampling Strategies

Capturing 100% of traces is expensive at scale. Common strategies:

- **Head-based sampling**: Decision made at the entry point before processing. Simple but misses rare errors.
- **Tail-based sampling**: Decision made after the request completes, allowing retention of traces with errors or high latency.
- **Adaptive/probabilistic sampling**: Rate adjusts based on traffic volume.

For fintech, **tail-based sampling** is preferred — you always want traces for failed or slow transactions regardless of their frequency.

## OpenTelemetry in Practice

OpenTelemetry (OTel) is the CNCF standard for instrumentation. It provides APIs, SDKs, and a Collector that is vendor-neutral.

### Instrumenting a Payment Service (Java)

```java
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;

public class PaymentService {
    private static final Tracer tracer =
        GlobalOpenTelemetry.getTracer("payment-service", "1.0.0");

    public PaymentResult processPayment(PaymentRequest request) {
        Span span = tracer.spanBuilder("processPayment")
            .setAttribute("payment.amount", request.getAmount())
            .setAttribute("payment.currency", request.getCurrency())
            .setAttribute("payment.method", request.getMethod())
            .startSpan();

        try (var scope = span.makeCurrent()) {
            // Downstream calls automatically inherit context
            validateRequest(request);
            var result = ledgerService.debit(request);
            span.setAttribute("payment.transaction_id", result.getTransactionId());
            return result;
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            throw e;
        } finally {
            span.end();
        }
    }
}
```

### OTel Collector Configuration

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: slow-transactions
        type: latency
        latency: {threshold_ms: 2000}
      - name: probabilistic
        type: probabilistic
        probabilistic: {sampling_percentage: 10}

exporters:
  jaeger:
    endpoint: jaeger-collector:14250
  otlp/tempo:
    endpoint: tempo:4317

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, tail_sampling]
      exporters: [jaeger, otlp/tempo]
```

## Correlating Traces with Logs and Metrics

The power of observability comes from connecting the three pillars:

1. **Inject trace/span IDs into log entries** so you can jump from a trace to its logs.
2. **Exemplars in Prometheus metrics** attach a trace ID to a metric data point, enabling drill-down from an alert to the offending trace.

```java
// Log with trace context (using MDC in logback/log4j2)
Span currentSpan = Span.current();
MDC.put("traceId", currentSpan.getSpanContext().getTraceId());
MDC.put("spanId", currentSpan.getSpanContext().getSpanId());
logger.info("Payment processed successfully");
```

## Fintech-Specific Considerations

### Audit Trail Requirements

Traces serve dual purposes in regulated environments: operational debugging AND compliance audit trails. Store traces for the minimum retention period required by regulation (e.g., 7 years for some payment records). Use immutable storage for audit-grade traces.

### PCI-DSS Compliance

Never include sensitive cardholder data (PAN, CVV, full card numbers) in span attributes or logs. Mask or tokenize before attaching to spans.

### Cross-Service Latency Budgets

Define latency SLOs per service and use span data to identify budget exhaustion. A payment authorization must complete in <500ms per card network requirements — trace every hop.

## Jaeger vs. Tempo vs. Zipkin

| Feature | Jaeger | Grafana Tempo | Zipkin |
|---|---|---|---|
| Storage backend | Cassandra/ES/BadgerDB | Object storage (S3) | MySQL/ES/Cassandra |
| Scale | Medium-large | Massive (cost-efficient) | Small-medium |
| Integration | OTel native | Grafana ecosystem | Spring Sleuth native |
| Cost | Medium | Low (S3 pricing) | Low |

For high-volume fintech workloads, **Grafana Tempo** with S3 backend provides the most cost-effective solution.

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which sampling strategy is most appropriate for a fintech payment service where you must capture all failed transactions regardless of traffic volume?",
      "options": ["Head-based sampling at 10%", "Tail-based sampling with error policy", "Probabilistic sampling at 50%", "No sampling — capture everything"],
      "correct": 1,
      "explanation": "Tail-based sampling makes the retention decision after the request completes, allowing you to always keep traces for errors or high-latency requests. Head-based sampling decides upfront and can miss rare but critical failure traces."
    },
    {
      "text": "What must you never include in OpenTelemetry span attributes in a PCI-DSS compliant payment system?",
      "options": ["Transaction IDs", "Payment method type", "Full Primary Account Numbers (PAN)", "Currency codes"],
      "correct": 2,
      "explanation": "PCI-DSS strictly prohibits storing or transmitting full card numbers (PAN) in unprotected form. Span attributes are observable data that may be stored in tracing backends, so PANs must be masked or tokenized before being attached to spans."
    },
    {
      "text": "Which W3C standard header is used for trace context propagation between HTTP services?",
      "options": ["X-B3-TraceId", "traceparent", "X-Request-ID", "X-Correlation-ID"],
      "correct": 1,
      "explanation": "The W3C TraceContext specification defines the 'traceparent' header as the standard way to propagate trace context (trace ID, span ID, and sampling flags) between services. B3 headers are a Zipkin legacy format, while X-Request-ID and X-Correlation-ID are non-standard conventions."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Instrument a Payment Processing Pipeline with Distributed Tracing",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Instrument a multi-service payment flow (API gateway → payment service → fraud check → ledger) using OpenTelemetry Java SDK, ensuring trace context propagates correctly across all HTTP and Kafka boundaries."},
    {"id": "2", "description": "Configure an OTel Collector with tail-based sampling that retains 100% of error traces, 100% of traces exceeding 2 seconds, and 5% of successful fast transactions."},
    {"id": "3", "description": "Implement log-trace correlation by injecting traceId and spanId into the MDC for all log statements within a traced operation, and verify the correlation in Grafana."},
    {"id": "4", "description": "Create a Grafana dashboard that shows P50/P95/P99 latency per service derived from span data, with exemplar links from slow metric data points to the corresponding full trace in Tempo."}
  ]
}
-->
