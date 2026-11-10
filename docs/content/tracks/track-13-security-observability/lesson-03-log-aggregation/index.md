# Lesson 03: Log Aggregation

## Overview

In a distributed fintech system, logs are scattered across dozens of services, pods, and regions. Log aggregation centralizes these logs, making it possible to correlate events, investigate incidents, and satisfy compliance and audit requirements. The ELK stack (Elasticsearch, Logstash, Kibana) and the Grafana Loki stack are the two dominant approaches in production fintech environments.

## Structured Logging

The foundation of effective log aggregation is **structured logging** — emitting logs as machine-parseable JSON rather than free-form text strings.

### Bad (Unstructured)
```
2024-01-15 10:23:45 ERROR Payment failed for user 12345: insufficient funds
```

### Good (Structured JSON)
```json
{
  "timestamp": "2024-01-15T10:23:45.123Z",
  "level": "ERROR",
  "service": "payment-processor",
  "version": "2.3.1",
  "environment": "production",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "event": "payment_failed",
  "payment": {
    "method": "card",
    "currency": "USD",
    "errorCode": "INSUFFICIENT_FUNDS"
  },
  "userId": "usr_hashed_abc123",
  "message": "Payment declined due to insufficient funds"
}
```

### Java Structured Logging with Logback + Logstash Encoder

```xml
<!-- logback-spring.xml -->
<configuration>
  <appender name="JSON_STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <includeMdcKeyName>traceId</includeMdcKeyName>
      <includeMdcKeyName>spanId</includeMdcKeyName>
      <includeMdcKeyName>userId</includeMdcKeyName>
      <fieldNames>
        <timestamp>timestamp</timestamp>
        <version>[ignore]</version>
      </fieldNames>
    </encoder>
  </appender>

  <root level="INFO">
    <appender-ref ref="JSON_STDOUT"/>
  </root>
</configuration>
```

## Log Levels in Production

| Level | Use Case | Fintech Example |
|---|---|---|
| ERROR | Actionable failures requiring immediate attention | Payment processing failure, fraud system down |
| WARN | Unexpected conditions that don't stop processing | Retry attempt, slow response from downstream |
| INFO | Business events that should be auditable | Payment authorized, user logged in, limit updated |
| DEBUG | Detailed diagnostic info (disable in production) | Request/response payloads, DB query details |

**Rule**: In production fintech, INFO logs must be sufficient to reconstruct what happened. DEBUG should be off by default and toggleable at runtime (e.g., via Spring Boot Actuator).

## ELK Stack Architecture

```
Services → Filebeat/Fluentd → Logstash → Elasticsearch → Kibana
                                  ↓
                             (Filtering, parsing,
                              enrichment, PII masking)
```

### Logstash Pipeline for Payment Logs

```ruby
input {
  beats {
    port => 5044
  }
}

filter {
  json {
    source => "message"
  }

  # Mask sensitive fields before storage
  mutate {
    gsub => [
      "payment[pan]", "\\d{12}(\\d{4})", "************\\1",
      "payment[cvv]", ".*", "***"
    ]
  }

  # Parse and index timestamp
  date {
    match => ["timestamp", "ISO8601"]
    target => "@timestamp"
  }

  # Drop debug logs in production
  if [level] == "DEBUG" {
    drop {}
  }

  # Tag high-value business events
  if [event] =~ /^payment_/ {
    mutate {
      add_tag => ["business_event", "audit_required"]
    }
  }
}

output {
  elasticsearch {
    hosts => ["elasticsearch:9200"]
    index => "fintech-logs-%{+YYYY.MM.dd}"
    ilm_enabled => true
    ilm_policy => "fintech-log-retention"
  }
}
```

## Grafana Loki: Log Aggregation for Cost-Conscious Teams

Loki stores only log metadata/labels in an index and compressed log chunks in object storage. This makes it dramatically cheaper than Elasticsearch for high-volume log storage.

### Loki Label Strategy

```yaml
# promtail config
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
    # Only index low-cardinality labels
    # Do NOT label by pod name, transaction ID, or user ID
```

### LogQL Queries for Fintech

```logql
# All payment errors in the last hour
{app="payment-service", namespace="production"} |= "ERROR" | json | event="payment_failed"

# P99 latency from logs (when metrics aren't available)
quantile_over_time(0.99,
  {app="payment-service"} | json | unwrap duration_ms [5m]
) by (method)

# Fraud events in the last 24 hours
{app="fraud-detector"} | json | event="fraud_detected" | action="block"
```

## Compliance and Retention

### PCI-DSS Log Requirements
- Retain logs for at least **1 year** (3 months immediately accessible)
- Log all access to cardholder data environments
- Protect logs from modification (write-once storage or digital signatures)
- Include: user ID, event type, date/time, success/failure, origination of event, identity of affected resource

### Index Lifecycle Management (Elasticsearch ILM)

```json
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": {"max_size": "50gb", "max_age": "1d"}
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink": {"number_of_shards": 1},
          "forcemerge": {"max_num_segments": 1}
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "freeze": {}
        }
      },
      "delete": {
        "min_age": "365d",
        "actions": {"delete": {}}
      }
    }
  }
}
```

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the primary advantage of structured JSON logging over free-form text logging in a fintech microservices environment?",
      "options": ["JSON logs are smaller in size", "JSON logs are machine-parseable, enabling reliable filtering, indexing, and correlation across services", "JSON logs are encrypted by default", "JSON logs are human-readable unlike text logs"],
      "correct": 1,
      "explanation": "Structured JSON logging allows log aggregation systems to reliably parse and index specific fields (like traceId, userId, event type) without brittle regex parsing. This enables powerful querying, correlation with traces, and automated compliance reporting that is impossible with free-form text logs."
    },
    {
      "text": "According to PCI-DSS requirements, what is the minimum retention period for security logs in a cardholder data environment?",
      "options": ["30 days", "90 days", "1 year with 3 months immediately accessible", "7 years"],
      "correct": 2,
      "explanation": "PCI-DSS Requirement 10.7 mandates that audit logs be retained for at least one year, with a minimum of three months available for immediate analysis. This ensures that forensic investigation after a breach can cover a sufficient historical window."
    },
    {
      "text": "Why does Grafana Loki have significantly lower storage costs than Elasticsearch for log data?",
      "options": ["Loki compresses logs using a proprietary algorithm", "Loki only indexes log labels/metadata and stores compressed log chunks in cheap object storage like S3", "Loki deletes old logs automatically", "Loki does not support full-text search"],
      "correct": 1,
      "explanation": "Elasticsearch inverts and indexes every word in every log message, which is powerful but expensive. Loki takes a different approach: it only indexes the log stream labels (like app name, namespace) and stores the actual log content as compressed chunks in object storage (S3/GCS), making storage costs orders of magnitude lower at the expense of requiring log parsing at query time."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Compliant Log Aggregation Pipeline for a Payment Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Configure structured JSON logging in a Spring Boot payment service using the Logstash Logback Encoder, ensuring traceId, spanId, event type, payment method, and masked card data are included — with PAN and CVV redacted before emission."},
    {"id": "2", "description": "Build a Logstash pipeline that ingests payment service logs, applies PII masking for any card numbers matching the Luhn pattern, tags business events (payment_authorized, payment_failed, fraud_detected) for audit, and routes to separate Elasticsearch indices by severity."},
    {"id": "3", "description": "Configure an Elasticsearch ILM policy that keeps hot logs for 1 day, moves to warm tier at 7 days, cold tier at 30 days, and deletes after 400 days — ensuring PCI-DSS 1-year minimum retention is satisfied with a buffer."},
    {"id": "4", "description": "Write three Kibana/LogQL queries: (a) all payment failures in the last 24h grouped by error code, (b) all log entries for a specific traceId to reconstruct a transaction's full journey, (c) all audit events (INFO level with audit_required tag) in the past week for compliance reporting."}
  ]
}
-->
