---
id: track-13-lesson-05
title: "Structured Logging — Correlation and Search at Scale"
slug: structured-logging
track: track-13
trackName: "Security & Observability"
sequence: 5
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [structured-logging, JSON, correlation-id, ELK, Loki]
prerequisites: [track-13-lesson-01]
---

# Structured Logging — Correlation and Search at Scale

> [!NOTE]
> In a financial system processing 50,000 transactions per second, unstructured logs are useless. The engineer investigating a failed wire transfer should be able to run one query and see every log line across all services that touched that transaction, in order, with full context. That capability requires structured logging, consistent correlation IDs, and a log platform that can search a billion log lines in under 5 seconds.

## 1. Structured Logging with Logback and JSON

### 1.1 Logstash Logback Encoder

```xml
<!-- pom.xml -->
<dependency>
  <groupId>net.logstash.logback</groupId>
  <artifactId>logstash-logback-encoder</artifactId>
  <version>7.4</version>
</dependency>
```

```xml
<!-- src/main/resources/logback-spring.xml -->
<configuration>

  <!-- JSON appender for production (stdout → log aggregator) -->
  <springProfile name="!local">
    <appender name="JSON_STDOUT" class="ch.qos.logback.core.ConsoleAppender">
      <encoder class="net.logstash.logback.encoder.LogstashEncoder">
        <!-- Service metadata included in every log line -->
        <customFields>{"service":"payment-service","team":"payments"}</customFields>

        <!-- Include MDC keys explicitly (don't expose all MDC in production) -->
        <includeMdcKeyName>correlation_id</includeMdcKeyName>
        <includeMdcKeyName>user_id</includeMdcKeyName>
        <includeMdcKeyName>account_id</includeMdcKeyName>
        <includeMdcKeyName>payment_id</includeMdcKeyName>
        <includeMdcKeyName>trace_id</includeMdcKeyName>
        <includeMdcKeyName>span_id</includeMdcKeyName>

        <!-- Mask sensitive fields before they hit the log -->
        <fieldNames>
          <timestamp>@timestamp</timestamp>
          <message>message</message>
          <logger>logger</logger>
          <thread>thread</thread>
          <level>level</level>
        </fieldNames>
      </encoder>
    </appender>

    <root level="INFO">
      <appender-ref ref="JSON_STDOUT"/>
    </root>
  </springProfile>

  <!-- Human-readable format for local development -->
  <springProfile name="local">
    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
      <encoder>
        <pattern>%d{HH:mm:ss.SSS} [%thread] %-5level [%X{correlation_id}] %logger{36} - %msg%n</pattern>
      </encoder>
    </appender>
    <root level="DEBUG">
      <appender-ref ref="CONSOLE"/>
    </root>
  </springProfile>

</configuration>
```

The resulting JSON log line looks like:

```json
{
  "@timestamp": "2025-11-08T14:23:01.482Z",
  "level": "INFO",
  "logger": "c.b.p.s.PaymentProcessingService",
  "message": "Payment processed successfully",
  "service": "payment-service",
  "team": "payments",
  "correlation_id": "pay-7f3a2b1c-4d5e-6f7a-8b9c-0d1e2f3a4b5c",
  "payment_id": "PAY-20251108-001234",
  "account_id": "ACC-7891011",
  "user_id": "usr-9876543",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "thread": "http-nio-8080-exec-3",
  "duration_ms": 142
}
```

---

## 2. MDC for Correlation IDs and Financial Context

The Mapped Diagnostic Context (MDC) is a thread-local map that Logback includes in every log line. Set it once at request entry and all downstream log statements in the same thread automatically include the values.

### 2.1 MDC Filter for HTTP Requests

```java
package com.bank.payments.logging;

import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;

@Component
public class MdcLoggingFilter extends OncePerRequestFilter {

    private static final String CORRELATION_ID_HEADER = "X-Correlation-ID";
    private static final String CORRELATION_ID_MDC_KEY = "correlation_id";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {

        String correlationId = request.getHeader(CORRELATION_ID_HEADER);
        if (correlationId == null || correlationId.isBlank()) {
            correlationId = "auto-" + UUID.randomUUID().toString().replace("-", "");
        }

        try {
            MDC.put(CORRELATION_ID_MDC_KEY, correlationId);
            // Also echo back to response header for client correlation
            response.addHeader(CORRELATION_ID_HEADER, correlationId);
            filterChain.doFilter(request, response);
        } finally {
            // Always clear MDC to prevent thread-local leakage in thread pool reuse
            MDC.clear();
        }
    }
}
```

### 2.2 MDC Context in Payment Service

```java
package com.bank.payments.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;

@Service
public class PaymentProcessingService {

    private static final Logger log = LoggerFactory.getLogger(PaymentProcessingService.class);

    public PaymentResult processPayment(PaymentRequest request) {
        // Enrich MDC with payment-specific context for all subsequent log lines
        MDC.put("payment_id", request.getPaymentId());
        MDC.put("payment_type", request.getType().name());
        MDC.put("payment_currency", request.getCurrency());
        // NEVER put amount in MDC if it appears in logs — PII risk in some jurisdictions
        // NEVER put account numbers, card numbers, or names

        try {
            log.info("Starting payment processing",
                // Logstash encoder also supports structured arguments via StructuredArguments
                net.logstash.logback.argument.StructuredArguments.keyValue("sender", request.getSenderRef()),
                net.logstash.logback.argument.StructuredArguments.keyValue("step", "start"));

            FraudResult fraud = fraudCheckClient.check(request);
            log.info("Fraud check completed",
                net.logstash.logback.argument.StructuredArguments.keyValue("fraud_score", fraud.getScore()),
                net.logstash.logback.argument.StructuredArguments.keyValue("fraud_decision", fraud.getDecision()));

            if (fraud.isBlocked()) {
                log.warn("Payment blocked by fraud engine",
                    net.logstash.logback.argument.StructuredArguments.keyValue("fraud_reason", fraud.getReason()));
                return PaymentResult.blocked(fraud.getReason());
            }

            LedgerEntry entry = ledgerRepository.save(LedgerEntry.from(request));
            log.info("Ledger entry created",
                net.logstash.logback.argument.StructuredArguments.keyValue("ledger_entry_id", entry.getId()));

            return PaymentResult.success(entry.getId());

        } catch (Exception e) {
            log.error("Payment processing failed", e,
                net.logstash.logback.argument.StructuredArguments.keyValue("error_type", e.getClass().getSimpleName()));
            throw e;
        } finally {
            // Remove payment-specific keys; correlation_id stays (set by filter)
            MDC.remove("payment_id");
            MDC.remove("payment_type");
            MDC.remove("payment_currency");
        }
    }
}
```

### 2.3 MDC Propagation Across Async Boundaries

MDC is thread-local. When you use `@Async`, `CompletableFuture`, or virtual threads, MDC is **not** automatically propagated:

```java
package com.bank.payments.async;

import org.slf4j.MDC;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

@Service
public class AsyncNotificationService {

    /**
     * Correctly propagates MDC to async thread.
     */
    public CompletableFuture<Void> sendNotificationAsync(PaymentEvent event) {
        // Capture MDC state before submitting to async executor
        Map<String, String> mdcContext = MDC.getCopyOfContextMap();

        return CompletableFuture.runAsync(() -> {
            // Restore MDC in the async thread
            if (mdcContext != null) {
                MDC.setContextMap(mdcContext);
            }
            try {
                sendNotification(event);
            } finally {
                MDC.clear();
            }
        });
    }
}
```

For Spring's `@Async` with thread pools, configure a custom `TaskDecorator`:

```java
package com.bank.payments.config;

import org.slf4j.MDC;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.TaskDecorator;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.Map;
import java.util.concurrent.Executor;

@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean(name = "paymentTaskExecutor")
    public Executor paymentTaskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setMaxPoolSize(50);
        executor.setQueueCapacity(500);
        executor.setThreadNamePrefix("payment-async-");
        executor.setTaskDecorator(new MdcTaskDecorator());
        executor.initialize();
        return executor;
    }

    private static class MdcTaskDecorator implements TaskDecorator {
        @Override
        public Runnable decorate(Runnable runnable) {
            Map<String, String> contextMap = MDC.getCopyOfContextMap();
            return () -> {
                if (contextMap != null) {
                    MDC.setContextMap(contextMap);
                }
                try {
                    runnable.run();
                } finally {
                    MDC.clear();
                }
            };
        }
    }
}
```

---

## 3. What Never Goes in Logs — PII and Financial Data

In financial services, logging sensitive data is a regulatory violation (GDPR Article 25, PCI DSS Requirement 3):

| Field | Log? | Alternative |
|-------|------|-------------|
| Card number (PAN) | NEVER | Log masked reference (last 4 digits only) |
| CVV | NEVER | Log nothing — no token |
| Account number | NEVER | Log internal UUID reference |
| Sort code + account | NEVER | Log internal account ID |
| Full name | NEVER | Log user ID / customer reference |
| Email address | NEVER | Log hashed email or user ID |
| IP address | Carefully | May be PII under GDPR — use sparingly |
| Payment amount | Carefully | Acceptable in audit logs, not debug logs |
| IBAN | NEVER | Log masked IBAN (first 4 + last 4) |

Implement a scrubbing utility to catch accidental leaks:

```java
package com.bank.payments.logging;

import java.util.regex.Pattern;

/**
 * Pre-checks log message parameters to detect and redact PII patterns.
 * Use as a last resort — primary prevention is developer discipline.
 */
public class LogScrubber {

    private static final Pattern VISA_CARD = Pattern.compile("4[0-9]{12}(?:[0-9]{3})?");
    private static final Pattern MASTERCARD = Pattern.compile("5[1-5][0-9]{14}");
    private static final Pattern IBAN = Pattern.compile("[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}");
    private static final Pattern UK_SORT_CODE = Pattern.compile("\\d{2}-\\d{2}-\\d{2}");

    public static String scrub(String message) {
        if (message == null) return null;
        message = VISA_CARD.matcher(message).replaceAll("[CARD-REDACTED]");
        message = MASTERCARD.matcher(message).replaceAll("[CARD-REDACTED]");
        message = IBAN.matcher(message).replaceAll("[IBAN-REDACTED]");
        message = UK_SORT_CODE.matcher(message).replaceAll("[SORTCODE-REDACTED]");
        return message;
    }
}
```

---

## 4. ELK Stack for Log Aggregation

### 4.1 Architecture

```
Payment Services (JSON stdout)
  └─→ Fluent Bit (DaemonSet, Kubernetes)
        └─→ Logstash (parsing, enrichment)
              └─→ Elasticsearch (storage, indexing)
                    └─→ Kibana (search, dashboards)
```

### 4.2 Fluent Bit Configuration

```yaml
# fluent-bit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info
        Parsers_File  parsers.conf

    [INPUT]
        Name              tail
        Path              /var/log/containers/payment-service*.log
        Parser            docker
        Tag               payment.*
        Refresh_Interval  5
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On

    [FILTER]
        Name   kubernetes
        Match  payment.*
        Merge_Log             On
        Keep_Log              Off
        K8S-Logging.Parser    On
        K8S-Logging.Exclude   Off

    [FILTER]
        Name  grep
        Match payment.*
        # Drop health check logs to reduce volume
        Exclude message /actuator/health

    [OUTPUT]
        Name            es
        Match           payment.*
        Host            elasticsearch.logging.svc.cluster.local
        Port            9200
        Index           payment-logs
        Type            _doc
        Logstash_Format On
        Logstash_Prefix payment-logs
        tls             On
        tls.verify      On
        tls.ca_file     /fluent-bit/certs/ca.crt

  parsers.conf: |
    [PARSER]
        Name        docker
        Format      json
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L
```

### 4.3 Kibana Query Examples

```
# Find all logs for a specific payment
payment_id: "PAY-20251108-001234"

# Find all errors in the last hour for payment-service
service: "payment-service" AND level: "ERROR"

# Find all fraud rejections with score > 0.8
fraud_decision: "BLOCKED" AND fraud_score: [0.8 TO *]

# Correlate by trace ID across all services
trace_id: "4bf92f3577b34da6a3ce929d0e0e4736"

# Find logs that took more than 1 second
duration_ms: [1000 TO *] AND service: "payment-service"
```

---

## 5. Grafana Loki as a Lightweight Alternative

Loki is a log aggregation system from Grafana Labs. Unlike Elasticsearch, it does not index the content of logs — only the labels (metadata). This makes it dramatically cheaper to operate.

### 5.1 Loki Architecture

```
Fluent Bit / Promtail (agent)
  └─→ Loki (storage: S3/GCS + local index)
        └─→ Grafana (unified view: metrics + logs + traces)
```

### 5.2 Promtail Configuration for Payment Services

```yaml
# promtail-config.yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push
    tls_config:
      ca_file: /certs/ca.crt

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: service
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
    pipeline_stages:
      - json:
          expressions:
            level: level
            correlation_id: correlation_id
            payment_id: payment_id
            trace_id: trace_id
      - labels:
          level:
          service:
      - drop:
          expression: ".*actuator/health.*"
          drop_counter_reason: health_check_filtered
```

### 5.3 LogQL Queries

```logql
# All errors for payment service in last 1h
{service="payment-service", level="ERROR"}

# Logs for a specific correlation ID
{service=~"payment.*"} | json | correlation_id="pay-7f3a2b1c"

# Payment failures with fraud context
{service="payment-service"}
  | json
  | fraud_decision="BLOCKED"
  | line_format "{{.payment_id}} fraud_score={{.fraud_score}}"

# Error rate over time (metrics from logs)
sum(rate({service="payment-service", level="ERROR"}[5m]))
/
sum(rate({service="payment-service"}[5m]))

# Slow operations from logs
{service="payment-service"}
  | json
  | duration_ms > 1000
  | line_format "slow: {{.payment_id}} took {{.duration_ms}}ms"
```

---

## 6. Log Retention Policies for Financial Compliance

UK FCA COBS 11.8 and PCI DSS Requirement 10 mandate specific log retention periods:

| Log category | Minimum retention | Recommended |
|-------------|------------------|-------------|
| Payment transaction logs | 5 years (FCA) | 7 years |
| Access control logs | 1 year (PCI DSS) | 2 years |
| Security incident logs | 1 year (PCI DSS) | 2 years |
| Application debug logs | No mandate | 30 days |
| Audit trail logs | 5 years | 7 years |

### 6.1 Index Lifecycle Management (Elasticsearch)

```json
// PUT _ilm/policy/payment-logs-policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_primary_shard_size": "50gb",
            "max_age": "1d"
          },
          "set_priority": {"priority": 100}
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink": {"number_of_shards": 1},
          "forcemerge": {"max_num_segments": 1},
          "set_priority": {"priority": 50}
        }
      },
      "cold": {
        "min_age": "90d",
        "actions": {
          "set_priority": {"priority": 0},
          "freeze": {}
        }
      },
      "delete": {
        "min_age": "2555d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

---

## 7. Log-Based Alerting

Loki supports alerting rules (via the ruler component) based on LogQL metrics queries:

```yaml
# loki/rules/payment-alerts.yaml
groups:
  - name: payment_log_alerts
    rules:
      - alert: PaymentErrorLogSpike
        expr: |
          sum(rate({service="payment-service", level="ERROR"}[5m])) > 10
        for: 2m
        labels:
          severity: warning
          team: payments
        annotations:
          summary: "Payment service error log rate is high"
          description: "More than 10 error logs/s for 2 minutes"

      - alert: FraudBlockLogSpike
        expr: |
          sum(rate({service="payment-service"}
            | json
            | fraud_decision="BLOCKED" [5m])) > 5
        for: 3m
        labels:
          severity: warning
          team: fraud
        annotations:
          summary: "Fraud block rate elevated in logs"
```

---

## 8. Summary

Structured logging in a financial system has three non-negotiable requirements:

1. **Every log line must be a machine-parseable JSON object.** Free-text log messages that require regex parsing are a maintenance burden and slow to query at scale.

2. **Every log line must carry a correlation ID** that spans all services involved in a single transaction. Without it, you cannot reconstruct the journey of a failed payment across five services.

3. **No PII or financial account data in logs.** This is a regulatory requirement (GDPR, PCI DSS) and a security requirement. Use opaque internal identifiers (payment ID, user ID) in logs, never card numbers, account numbers, or personal data.

The ELK stack is a proven, flexible choice with higher operational overhead. Grafana Loki is cheaper to run and integrates natively with Grafana dashboards, making it an excellent choice for teams already on Prometheus + Grafana for metrics.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the minimum set of fields that every log line in a payment microservice must include to enable cross-service transaction correlation?",
      "options": ["timestamp, service, level", "timestamp, service, level, correlation_id, payment_id, trace_id", "timestamp, message, exception", "service, level, user_id"],
      "correct": 1,
      "explanation": "Cross-service correlation requires a correlation_id (request-scoped identifier passed across all services), payment_id (business domain identifier), and trace_id (links to distributed traces). Without these, you cannot reconstruct the journey of a specific payment across multiple services."
    },
    {
      "text": "Under UK FCA COBS 11.8, what is the minimum retention period for payment transaction logs?",
      "options": ["1 year", "2 years", "5 years", "7 years"],
      "correct": 2,
      "explanation": "FCA COBS 11.8 mandates a minimum 5-year retention for payment transaction logs. The recommended practice is 7 years to align with common audit and legal discovery windows. Elasticsearch Index Lifecycle Management (ILM) can be configured to automatically manage retention through hot/warm/cold/delete phases."
    },
    {
      "text": "Why should card numbers (PAN) and other PII never appear in application logs even in a masked form?",
      "options": ["Log files are too large to store such data", "Logging systems (Elasticsearch, Loki) are not PCI-scoped systems, so any PAN in logs brings the entire logging infrastructure into PCI DSS scope and creates GDPR compliance obligations", "Masking makes the data unusable for debugging anyway", "Log aggregation systems cannot handle encrypted fields"],
      "correct": 1,
      "explanation": "PCI DSS scope follows the data. Any system that stores, processes, or transmits cardholder data must meet full PCI DSS requirements. Including masked PAN in logs that flow to Elasticsearch or Loki brings those systems into PCI scope, dramatically increasing compliance burden and audit costs."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Structured Logging Pipeline for Payment Services",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Configure Logback in a Spring Boot payment service to output structured JSON logs including: timestamp, level, service, correlation_id, payment_id, trace_id, span_id, duration_ms, and a PAN-masking converter that redacts card numbers matching the Luhn pattern before they reach any log appender."},
    {"id": "2", "description": "Write a Spring MVC HandlerInterceptor that extracts or generates a correlation_id from incoming request headers and places it in the MDC, ensuring it propagates to all downstream RestTemplate and WebClient calls."},
    {"id": "3", "description": "Configure a Fluent Bit DaemonSet to collect JSON logs from Kubernetes pods, parse the JSON, add Kubernetes metadata labels (namespace, pod, app), filter out /actuator/health spam, and ship to a local Elasticsearch index with the payment-logs-YYYY.MM.DD naming pattern."},
    {"id": "4", "description": "Write three Kibana/Elasticsearch queries: one that retrieves all log lines for a specific correlation_id across all services ordered by timestamp, one that finds all ERROR logs for payment-service in the last hour with their payment_id fields, and one that detects any log line containing a potential unmasked card number using a regex pattern."}
  ]
}
-->
