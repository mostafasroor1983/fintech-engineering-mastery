---
id: track-13-lesson-02
title: "Distributed Tracing — Causality, Sampling, and Analysis"
slug: distributed-tracing
track: track-13
trackName: "Security & Observability"
sequence: 2
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [distributed-tracing, Jaeger, Zipkin, sampling, correlation-id]
prerequisites: [track-13-lesson-01]
---

# Distributed Tracing — Causality, Sampling, and Analysis

> [!NOTE]
> Distributed tracing is the difference between guessing where latency lives and knowing exactly which service, database call, or external dependency added 400 ms to your P99 payment response time. At principal-engineer level you must own not just the instrumentation but the sampling strategy, storage cost, and the analysis workflow your team uses during incidents.

## 1. The OpenTelemetry Tracing Model

A **trace** represents the full journey of a request through your distributed system. It is a directed acyclic graph of **spans**, each representing one unit of work (an HTTP handler call, a database query, a Kafka publish). Every span records:

- `traceId` — 128-bit identifier shared by every span in the trace
- `spanId` — 64-bit identifier unique to this span
- `parentSpanId` — the calling span's id (absent on the root span)
- `startTime` / `endTime` — nanosecond precision wall-clock times
- `status` — OK, ERROR, or UNSET
- `attributes` — key/value pairs (HTTP method, DB statement, etc.)
- `events` — timestamped log-like records within the span lifetime
- `links` — cross-trace references (e.g. a Kafka consumer linking to the producer trace)

### 1.1 Span Kinds

| Kind | Use |
|------|-----|
| `SERVER` | Incoming HTTP/gRPC handler |
| `CLIENT` | Outbound HTTP/gRPC/DB call |
| `PRODUCER` | Kafka/JMS publish |
| `CONSUMER` | Kafka/JMS receive |
| `INTERNAL` | Business logic within a service |

### 1.2 Adding OpenTelemetry to Spring Boot

```xml
<!-- pom.xml -->
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>io.opentelemetry.instrumentation</groupId>
      <artifactId>opentelemetry-instrumentation-bom</artifactId>
      <version>2.5.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-api</artifactId>
  </dependency>
  <dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-sdk</artifactId>
  </dependency>
  <dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
  </dependency>
  <dependency>
    <groupId>io.opentelemetry.instrumentation</groupId>
    <artifactId>opentelemetry-spring-boot-starter</artifactId>
  </dependency>
</dependencies>
```

```yaml
# application.yaml — OTel SDK configuration
management:
  tracing:
    sampling:
      probability: 1.0   # 100% in dev; use 0.01-0.1 in production

otel:
  exporter:
    otlp:
      endpoint: http://otel-collector:4317
      protocol: grpc
  resource:
    attributes:
      service.name: payment-service
      service.version: ${APP_VERSION:local}
      deployment.environment: ${ENVIRONMENT:dev}
  traces:
    exporter: otlp
  metrics:
    exporter: otlp
  logs:
    exporter: otlp
```

### 1.3 Manual Span Creation for Payment Business Logic

Auto-instrumentation covers HTTP and JDBC automatically. For business-critical payment steps you need explicit spans:

```java
package com.bank.payments.service;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import org.springframework.stereotype.Service;

@Service
public class PaymentProcessingService {

    private static final Tracer tracer =
        GlobalOpenTelemetry.getTracer("payment-service", "1.0.0");

    private final FraudCheckClient fraudCheckClient;
    private final LedgerRepository ledgerRepository;
    private final NotificationService notificationService;

    public PaymentProcessingService(FraudCheckClient fraudCheckClient,
                                    LedgerRepository ledgerRepository,
                                    NotificationService notificationService) {
        this.fraudCheckClient = fraudCheckClient;
        this.ledgerRepository = ledgerRepository;
        this.notificationService = notificationService;
    }

    public PaymentResult processPayment(PaymentRequest request) {
        Span span = tracer.spanBuilder("processPayment")
            .setSpanKind(SpanKind.INTERNAL)
            .startSpan();

        try (Scope scope = span.makeCurrent()) {
            span.setAttribute("payment.amount", request.getAmount().toPlainString());
            span.setAttribute("payment.currency", request.getCurrency());
            span.setAttribute("payment.type", request.getType().name());
            span.setAttribute("payment.sender_account_id", request.getSenderAccountId());

            FraudResult fraud = runFraudCheck(request);
            if (fraud.isBlocked()) {
                span.setAttribute("payment.fraud_blocked", true);
                span.setStatus(StatusCode.ERROR, "Fraud check blocked payment");
                return PaymentResult.blocked(fraud.getReason());
            }

            LedgerEntry entry = postToLedger(request);
            notifyParties(request, entry);

            span.setAttribute("payment.ledger_entry_id", entry.getId());
            span.setStatus(StatusCode.OK);
            return PaymentResult.success(entry.getId());

        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            throw e;
        } finally {
            span.end();
        }
    }

    private FraudResult runFraudCheck(PaymentRequest request) {
        Span fraudSpan = tracer.spanBuilder("fraudCheck")
            .setSpanKind(SpanKind.CLIENT)
            .startSpan();
        try (Scope scope = fraudSpan.makeCurrent()) {
            fraudSpan.setAttribute("fraud.model_version", "v3.2");
            FraudResult result = fraudCheckClient.check(request);
            fraudSpan.setAttribute("fraud.score", result.getScore());
            fraudSpan.setAttribute("fraud.decision", result.getDecision().name());
            return result;
        } catch (Exception e) {
            fraudSpan.recordException(e);
            fraudSpan.setStatus(StatusCode.ERROR, e.getMessage());
            throw e;
        } finally {
            fraudSpan.end();
        }
    }

    private LedgerEntry postToLedger(PaymentRequest request) {
        Span ledgerSpan = tracer.spanBuilder("postLedgerEntry")
            .setSpanKind(SpanKind.INTERNAL)
            .startSpan();
        try (Scope scope = ledgerSpan.makeCurrent()) {
            LedgerEntry entry = ledgerRepository.save(LedgerEntry.from(request));
            ledgerSpan.setAttribute("db.operation", "INSERT");
            ledgerSpan.setAttribute("db.table", "ledger_entries");
            ledgerSpan.setAttribute("ledger.entry_id", entry.getId());
            return entry;
        } finally {
            ledgerSpan.end();
        }
    }

    private void notifyParties(PaymentRequest request, LedgerEntry entry) {
        Span notifySpan = tracer.spanBuilder("notifyParties")
            .setSpanKind(SpanKind.PRODUCER)
            .startSpan();
        try (Scope scope = notifySpan.makeCurrent()) {
            notificationService.sendPaymentConfirmation(request, entry);
        } finally {
            notifySpan.end();
        }
    }
}
```

---

## 2. Trace Context Propagation — W3C TraceContext

The W3C TraceContext specification defines two HTTP headers that carry trace state across service boundaries:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              ^^ version  ^^ trace-id (128-bit hex)  ^^ span-id  ^^ flags
tracestate:  rojo=00f067aa0ba902b7,congo=t61rcWkgMzE
```

The `flags` byte's low bit is the **sampled** flag. When it is `1`, all downstream services must record the span. This is the basis for head-based sampling.

### 2.1 Propagating TraceContext Through Kafka

Auto-instrumentation handles HTTP propagation. For Kafka you need explicit handling:

```java
package com.bank.payments.messaging;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.Headers;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;

@Component
public class PaymentEventMessaging {

    private static final TextMapGetter<Headers> KAFKA_GETTER = new TextMapGetter<>() {
        @Override
        public Iterable<String> keys(Headers carrier) {
            return () -> java.util.Arrays.stream(carrier.toArray())
                .map(h -> h.key()).iterator();
        }

        @Override
        public String get(Headers carrier, String key) {
            var header = carrier.lastHeader(key);
            return header == null ? null
                : new String(header.value(), StandardCharsets.UTF_8);
        }
    };

    private static final TextMapSetter<ProducerRecord<?, ?>> KAFKA_SETTER =
        (carrier, key, value) ->
            carrier.headers().add(key, value.getBytes(StandardCharsets.UTF_8));

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    public PaymentEventMessaging(KafkaTemplate<String, PaymentEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publishPaymentConfirmed(PaymentEvent event) {
        ProducerRecord<String, PaymentEvent> record =
            new ProducerRecord<>("payment.confirmed", event.getPaymentId(), event);

        GlobalOpenTelemetry.getPropagators()
            .getTextMapPropagator()
            .inject(Context.current(), record, KAFKA_SETTER);

        kafkaTemplate.send(record);
    }

    @KafkaListener(topics = "payment.confirmed", groupId = "notification-service")
    public void onPaymentConfirmed(ConsumerRecord<String, PaymentEvent> record) {
        Context extractedContext = GlobalOpenTelemetry.getPropagators()
            .getTextMapPropagator()
            .extract(Context.current(), record.headers(), KAFKA_GETTER);

        Span span = GlobalOpenTelemetry.getTracer("notification-service")
            .spanBuilder("processPaymentConfirmed")
            .setParent(extractedContext)
            .setSpanKind(SpanKind.CONSUMER)
            .startSpan();

        try (var scope = span.makeCurrent()) {
            span.setAttribute("messaging.system", "kafka");
            span.setAttribute("messaging.destination", record.topic());
            span.setAttribute("messaging.kafka.partition", record.partition());
            span.setAttribute("payment.id", record.value().getPaymentId());
            // process notification...
        } finally {
            span.end();
        }
    }
}
```

---

## 3. Sampling Strategies

Sampling is the most critical architectural decision in distributed tracing. Financial systems process thousands of payments per second; storing every trace is prohibitively expensive. The goal: capture all anomalous traces (errors, slow outliers) while discarding routine successful traces.

### 3.1 Head-Based Sampling

The sampling decision is made at the **root span** before any downstream work. All child spans inherit the decision via the `sampled` flag in `traceparent`.

**Pros:** Zero overhead for unsampled requests downstream. Simple to reason about.
**Cons:** Cannot retroactively sample traces that turned out to be interesting because the decision was made upfront before the outcome was known.

```yaml
# OTel Collector — head-based probabilistic sampling
processors:
  probabilistic_sampler:
    sampling_percentage: 5   # keep 5% of all traces

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [probabilistic_sampler, batch]
      exporters: [jaeger]
```

### 3.2 Tail-Based Sampling

The sampling decision is deferred until **all spans in a trace have arrived** at a collector. This allows sampling based on the complete trace outcome: keep 100% of error traces and slow traces regardless of overall rate.

```yaml
# OTel Collector — tail-based sampling
processors:
  tail_sampling:
    decision_wait: 10s          # wait up to 10s for all spans to arrive
    num_traces: 100000          # in-memory trace buffer
    expected_new_traces_per_sec: 10000
    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}

      - name: slow-payment-traces
        type: latency
        latency: {threshold_ms: 1000}

      - name: fraud-service-errors
        type: and
        and:
          and_sub_policy:
            - name: service-name-filter
              type: string_attribute
              string_attribute:
                key: service.name
                values: [fraud-check-service]
            - name: error-filter
              type: status_code
              status_code: {status_codes: [ERROR]}

      - name: default-policy
        type: probabilistic
        probabilistic: {sampling_percentage: 1}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, batch]
      exporters: [jaeger]
```

### 3.3 Sampling Decision Matrix for Financial Services

| Trace outcome | Volume | Recommended sampling rate |
|---------------|--------|--------------------------|
| Any error (4xx/5xx) | Low | 100% — always keep |
| Duration > P95 threshold | Low | 100% — always keep |
| High-value payment (wire, international) | Medium | 100% — always keep |
| Fraud-flagged transaction | Low | 100% — always keep |
| Normal retail payment success | High | 1-5% |
| Health-check / internal ping | Very high | 0% — drop entirely |

---

## 4. Jaeger Deployment and Query

### 4.1 Production Jaeger Architecture

```yaml
# docker-compose for local development
version: "3.9"
services:
  jaeger:
    image: jaegertracing/all-in-one:1.57
    ports:
      - "16686:16686"   # Jaeger UI
      - "4317:4317"     # OTLP gRPC
      - "4318:4318"     # OTLP HTTP
    environment:
      SPAN_STORAGE_TYPE: elasticsearch
      ES_SERVER_URLS: http://elasticsearch:9200
      ES_INDEX_PREFIX: jaeger
      COLLECTOR_OTLP_ENABLED: "true"

  elasticsearch:
    image: elasticsearch:8.13.0
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"
      ES_JAVA_OPTS: "-Xms2g -Xmx2g"
    volumes:
      - es-data:/usr/share/elasticsearch/data

volumes:
  es-data:
```

For production, deploy Jaeger Collector and Jaeger Query as separate services behind a load balancer, with Elasticsearch as the distributed backend. Use index lifecycle management (ILM) to roll traces after 30 days.

### 4.2 Querying Traces via Jaeger HTTP API

```java
package com.bank.payments.ops;

import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

/**
 * Programmatic access to Jaeger for incident investigation tooling.
 */
public class JaegerQueryClient {

    private final RestTemplate restTemplate;
    private final String jaegerQueryUrl;

    public JaegerQueryClient(RestTemplate restTemplate, String jaegerQueryUrl) {
        this.restTemplate = restTemplate;
        this.jaegerQueryUrl = jaegerQueryUrl;
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> findPaymentErrorTraces() {
        Instant now = Instant.now();
        Instant oneHourAgo = now.minus(1, ChronoUnit.HOURS);

        String url = UriComponentsBuilder
            .fromHttpUrl(jaegerQueryUrl + "/api/traces")
            .queryParam("service", "payment-service")
            .queryParam("tags", "{\"error\":\"true\"}")
            .queryParam("start", oneHourAgo.toEpochMilli() * 1000)
            .queryParam("end", now.toEpochMilli() * 1000)
            .queryParam("limit", 100)
            .toUriString();

        Map<String, Object> response = restTemplate.getForObject(url, Map.class);
        return (List<Map<String, Object>>) response.get("data");
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> findSlowPaymentTraces(long minDurationMs) {
        Instant now = Instant.now();
        Instant oneHourAgo = now.minus(1, ChronoUnit.HOURS);

        String url = UriComponentsBuilder
            .fromHttpUrl(jaegerQueryUrl + "/api/traces")
            .queryParam("service", "payment-service")
            .queryParam("operation", "processPayment")
            .queryParam("minDuration", minDurationMs + "ms")
            .queryParam("start", oneHourAgo.toEpochMilli() * 1000)
            .queryParam("end", now.toEpochMilli() * 1000)
            .queryParam("limit", 50)
            .toUriString();

        Map<String, Object> response = restTemplate.getForObject(url, Map.class);
        return (List<Map<String, Object>>) response.get("data");
    }
}
```

---

## 5. Zipkin vs Jaeger — Operational Comparison

| Dimension | Jaeger | Zipkin |
|-----------|--------|--------|
| Wire format | OTLP (native), Thrift (legacy) | B3 headers, JSON |
| Backend storage | Cassandra, Elasticsearch, Badger | Cassandra, Elasticsearch, MySQL |
| UI | Richer, trace comparison, DAG view | Simpler, proven in production |
| Deployment complexity | Medium (separate collector/query) | Low (single jar) |
| OTel native | Yes | Via OTLP bridge |
| Recommendation | **New deployments** | Legacy or Zipkin-only teams |

If you have existing Zipkin infrastructure, the OTel Collector can receive OTLP and export in Zipkin format, letting you migrate instrumentation without changing the backend immediately.

---

## 6. Trace Analysis for Payment Latency Investigation

### 6.1 Identifying the Slow Span in a Waterfall

A payment service with P99 = 1.8 s suddenly increases to 4.2 s. Using Jaeger trace comparison:

1. Pull a "normal" trace (1.4 s) and the slow trace (4.2 s) side by side.
2. In the waterfall, expand each span's duration. The slow trace shows `fraudCheck` taking 2.9 s instead of the expected 180 ms.
3. The `fraudCheck` span has attribute `fraud.model_version: v3.3` while the normal trace shows `v3.2`. A model deployment deployed a heavier ML model without a timeout change.

**Production tip:** Always set span attributes for version numbers, feature flags, and configuration that could affect performance. This turns a 30-minute investigation into a 3-minute one.

### 6.2 Finding N+1 Query Problems via Traces

```java
/**
 * N+1 anti-pattern — this generates one SELECT per account in the list.
 * Visible in traces as 50-200 sequential database spans.
 */
public List<AccountSummary> getAccountSummariesBad(List<String> accountIds) {
    return accountIds.stream()
        .map(id -> accountRepository.findById(id))  // N separate SQL queries
        .filter(Optional::isPresent)
        .map(opt -> AccountSummary.from(opt.get()))
        .collect(Collectors.toList());
}

/**
 * Fixed: single IN query. In traces, one database span replaces N spans.
 */
public List<AccountSummary> getAccountSummaries(List<String> accountIds) {
    return accountRepository.findAllById(accountIds).stream()  // 1 query
        .map(AccountSummary::from)
        .collect(Collectors.toList());
}
```

In Jaeger, the N+1 pattern is unmistakable: the trace waterfall shows 50-200 tiny `db.query` spans in sequence. The fixed version shows a single `db.query` span.

### 6.3 Service Dependency Graphs

Jaeger's "System Architecture" tab renders a live dependency graph derived from actual trace data. For payment systems, the graph reveals:

- Which services are synchronously coupled (critical path)
- Which downstream services a payment touches (blast radius for outages)
- Unexpected calls (a payment service calling an internal admin API it should not access)

---

## 7. Spring Boot Auto-Instrumentation

The OpenTelemetry Java agent (`opentelemetry-javaagent.jar`) instruments at bytecode level without code changes:

```bash
# Dockerfile — attach OTel Java agent
FROM eclipse-temurin:21-jre

COPY opentelemetry-javaagent-2.5.0.jar /app/otel-agent.jar
COPY payment-service.jar /app/app.jar

ENV OTEL_SERVICE_NAME=payment-service
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
ENV OTEL_EXPORTER_OTLP_PROTOCOL=grpc
ENV OTEL_RESOURCE_ATTRIBUTES=service.namespace=banking,deployment.environment=production

ENTRYPOINT ["java", \
  "-javaagent:/app/otel-agent.jar", \
  "-jar", "/app/app.jar"]
```

The agent auto-instruments: Spring MVC/WebFlux, Spring Data JPA/JDBC, Spring Kafka, OkHttp/Apache HttpClient/WebClient, gRPC stubs, Redis (Lettuce, Jedis).

**What still needs manual instrumentation:** business domain spans (fraud score, risk classification, ledger posting) and any custom Kafka routing logic.

---

## 8. Correlation ID Bridging

Bridging traces to logs requires including `traceId` and `spanId` in every log line:

```xml
<!-- logback-spring.xml -->
<configuration>
  <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <provider class="net.logstash.logback.composite.loggingevent.LoggingEventPatternJsonProvider">
        <pattern>
          {
            "trace_id": "%X{trace_id}",
            "span_id": "%X{span_id}",
            "trace_flags": "%X{trace_flags}"
          }
        </pattern>
      </provider>
    </encoder>
  </appender>
  <root level="INFO">
    <appender-ref ref="JSON"/>
  </root>
</configuration>
```

The OTel Spring Boot starter automatically populates MDC keys `trace_id`, `span_id`, and `trace_flags` on every log statement within an active span. This enables a Loki query to jump directly to the matching Jaeger trace:

```
# Loki query: find logs for a specific trace
{service="payment-service"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"
```

---

## 9. PCI DSS Span Attribute Scrubbing

Do **not** include the following as span attributes:

- Card numbers (PAN) — even masked
- CVV values
- Full account numbers
- PIN or passwords
- Full names combined with account identifiers

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which OpenTelemetry sampling strategy is most appropriate for a payment service processing 50,000 TPS where every error trace must be captured?",
      "options": ["Head-based sampling at 1% rate", "Tail-based sampling with error-always rule", "No sampling — capture all traces", "Random sampling at 10% rate"],
      "correct": 1,
      "explanation": "Tail-based sampling makes the sampling decision after the trace is complete, allowing you to enforce rules like 'always sample traces containing errors' regardless of volume. Head-based sampling at a fixed rate would miss many error traces."
    },
    {
      "text": "What is the primary purpose of the W3C TraceContext propagation header format in distributed tracing?",
      "options": ["Encrypt trace data between services", "Carry trace and span IDs across service boundaries to link spans into a single trace", "Define sampling rates across services", "Store span attributes in HTTP headers"],
      "correct": 1,
      "explanation": "W3C TraceContext (the `traceparent` header) carries the trace ID and parent span ID across service boundaries, enabling all spans from different services that served one request to be linked into a single distributed trace."
    },
    {
      "text": "Why should card numbers (PAN) never be included as OpenTelemetry span attributes even in masked form?",
      "options": ["Span attributes increase trace storage costs significantly", "Tracing backends are not PCI DSS certified and span data may be exported to non-compliant storage", "Span attributes cannot hold string values", "Jaeger does not support PCI data types"],
      "correct": 1,
      "explanation": "PCI DSS requires strict control over where cardholder data is stored and transmitted. Tracing backends (Jaeger, Zipkin, Tempo) are not PCI-scoped systems. Including PAN data in spans brings the entire tracing infrastructure into PCI scope, dramatically increasing compliance burden."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Distributed Tracing for Payment Latency Investigation",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Instrument a Spring Boot payment service with OpenTelemetry, adding custom business spans for fraud-check, ledger-posting, and notification steps, with attributes for payment type, currency, and amount band (not the actual amount)."},
    {"id": "2", "description": "Configure tail-based sampling in an OTel Collector that always captures error traces, always captures traces over 2 seconds, and samples 1% of successful fast traces."},
    {"id": "3", "description": "Deploy a local Jaeger instance and verify traces appear with the correct parent-child span hierarchy; use the Jaeger HTTP API to programmatically fetch the slowest 10 traces from the past hour."},
    {"id": "4", "description": "Configure Logback to inject trace_id and span_id into every log line, then write a LogQL query in Grafana that pivots from a Jaeger trace ID to all correlated log lines across payment-service and fraud-service."}
  ]
}
-->

Use opaque identifiers (UUID payment IDs, masked account references) in traces. Add a scrubbing processor in the OTel Collector as a last-resort safety net:

```yaml
processors:
  redaction:
    allow_all_keys: true
    blocked_values:
      - "4[0-9]{12}(?:[0-9]{3})?"    # Visa card pattern
      - "[0-9]{3}-[0-9]{2}-[0-9]{4}" # SSN pattern
    summary: debug
```

---

## 10. Collector Sizing for Financial Workloads

For a system processing 10,000 payments/second with 5% sampling (500 traces/s, ~20 spans/trace = 10,000 spans/s):

- OTel Collector: 2 CPU / 4 GB RAM per instance, 3 instances minimum
- Elasticsearch: 32 GB RAM, 1 TB SSD per node, 3-node cluster
- Retention: 7 days hot (SSD), 30 days warm (HDD), delete after 90 days

Configure the BatchSpanProcessor so that collector unavailability does not block your application:

```yaml
otel:
  bsp:
    schedule_delay: 5000ms
    max_queue_size: 2048
    max_export_batch_size: 512
    export_timeout: 30000ms
```

---

## 11. Summary

Distributed tracing at the principal-engineer level requires three distinct competencies:

1. **Instrumentation design** — which spans add diagnostic value vs noise. Instrument all synchronous cross-service calls automatically, all Kafka flows explicitly, and all business-critical decision points manually.

2. **Sampling strategy** — tail-based sampling is the right default for financial systems because it guarantees you keep error traces and latency outliers. The cost is a 10-15 s decision window and stateful collector infrastructure.

3. **Analysis workflow** — the ROI of tracing comes from analysis. Build a runbook that tells on-call engineers: "P99 latency spike → open Jaeger → filter `payment-service` by duration > 1s → compare slow span with P50 baseline trace."

The difference between teams that get value from tracing and those that do not is almost always the third point: without an analysis workflow embedded in runbooks, traces accumulate without anyone systematically using them.
