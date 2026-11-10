# Lesson 05: Application Performance Monitoring (APM)

## Overview

Application Performance Monitoring (APM) provides deep visibility into application internals — from method-level traces to database query analysis and dependency mapping. In fintech, APM is critical for meeting card network latency requirements, identifying performance regressions before they impact SLOs, and diagnosing complex multi-service transaction failures.

## APM vs. Basic Metrics

| Capability | Basic Metrics (Prometheus) | APM |
|---|---|---|
| Service-level latency | Yes | Yes |
| Method/function-level timing | No | Yes |
| Database query analysis | No | Yes |
| Automatic dependency map | No | Yes |
| Code hotspot profiling | No | Yes |
| Error tracking with stack traces | No | Yes |
| Real User Monitoring (RUM) | No | Some |

## OpenTelemetry-Based APM

Modern APM uses OpenTelemetry as the instrumentation layer with an APM backend (Elastic APM, Datadog, Dynatrace, New Relic) for analysis.

### Auto-Instrumentation (Java Agent)

```bash
# Launch payment service with OTel Java agent
java \
  -javaagent:/opt/opentelemetry-javaagent.jar \
  -Dotel.service.name=payment-processor \
  -Dotel.service.version=2.3.1 \
  -Dotel.resource.attributes=deployment.environment=production,team=payments \
  -Dotel.exporter.otlp.endpoint=http://otel-collector:4317 \
  -Dotel.metrics.exporter=otlp \
  -Dotel.logs.exporter=otlp \
  -jar payment-service.jar
```

The Java agent automatically instruments:
- HTTP clients (RestTemplate, WebClient, OkHttp, Apache HttpClient)
- JDBC/JPA database calls
- Kafka/RabbitMQ messaging
- Redis/Memcached operations
- Spring MVC/Spring WebFlux endpoints

### Custom Spans for Business Logic

```java
@Service
public class FraudAssessmentService {
    private final Tracer tracer = GlobalOpenTelemetry.getTracer("fraud-service");

    public FraudScore assessTransaction(Transaction tx) {
        Span fraudSpan = tracer.spanBuilder("fraud.assess")
            .setAttribute("fraud.model_version", modelVersion)
            .setAttribute("transaction.amount_usd", tx.getAmountUsd())
            .setAttribute("transaction.country", tx.getCountry())
            .startSpan();

        try (var scope = fraudSpan.makeCurrent()) {
            // Rule engine check
            var ruleSpan = tracer.spanBuilder("fraud.rules_engine").startSpan();
            var ruleResult = runRules(tx);
            ruleSpan.setAttribute("rules.triggered", ruleResult.getTriggeredCount());
            ruleSpan.end();

            // ML model inference
            var mlSpan = tracer.spanBuilder("fraud.ml_inference").startSpan();
            var score = mlModel.score(tx);
            mlSpan.setAttribute("ml.score", score.getValue());
            mlSpan.setAttribute("ml.model", "xgboost-v4");
            mlSpan.end();

            fraudSpan.setAttribute("fraud.final_score", score.getValue());
            fraudSpan.setAttribute("fraud.decision", score.getDecision());
            return score;
        } finally {
            fraudSpan.end();
        }
    }
}
```

## Database Query Analysis

Slow database queries are the most common root cause of payment latency degradation. APM tools capture:
- SQL query text (normalized — no parameter values to avoid PII leakage)
- Execution time per query
- Number of rows scanned vs. rows returned
- Lock wait time
- Connection acquisition time from pool

### Identifying N+1 Query Problems

APM flame graphs reveal N+1 problems — a common ORM issue where fetching N parent records triggers N additional queries for child records:

```
processPaymentBatch (230ms)
  ├── findPaymentsByStatus (5ms) → returns 100 records
  ├── getUserById (2ms) ← called 100 times!
  ├── getUserById (2ms)
  ├── getUserById (2ms)
  ... × 100
```

**Fix**: Use JOIN or `@BatchSize` in JPA to fetch in bulk.

## Elastic APM Configuration

```yaml
# elastic-apm-agent.properties
service_name=payment-processor
service_version=2.3.1
server_url=https://apm-server.internal:8200
secret_token=${APM_SECRET_TOKEN}
environment=production

# Sampling: capture all errors + 10% of success
transaction_sample_rate=0.1
capture_body=errors  # Never capture request body in success cases (PII risk)

# Sanitize sensitive fields before sending to APM
sanitize_field_names=password,pan,card_number,cvv,secret,token,api_key
```

## Continuous Profiling

Continuous profiling captures CPU and memory flame graphs from production without significant overhead (typically 1-2% CPU overhead). Tools: Parca, Pyroscope, Datadog Continuous Profiler.

### Reading a Flame Graph

```
Main Thread
└─ handlePaymentRequest (45% CPU)
   ├─ validateRequest (3%)
   ├─ callFraudService (8%)
   └─ persistToDatabase (34%)  ← Hotspot!
      ├─ buildInsertStatement (12%)
      └─ executeUpdate (22%)
```

The flame graph reveals that 34% of CPU is spent in database persistence, with 12% in building SQL statements — a potential optimization target (use prepared statements, batch inserts).

## Service Dependency Maps

APM tools auto-generate dependency maps showing which services call which, with health status and latency per edge:

```
[API Gateway] → [Payment Service] → [Fraud Detector]
                      ↓                    ↓
               [Ledger Service]      [Rules DB]
                      ↓
               [Notification Service]
                      ↓
               [Email Provider] (external)
```

This map is invaluable during incidents to identify which dependency is causing failures.

## APM in Fintech Compliance Context

APM data may contain transaction details that fall under data residency requirements. Ensure:
- APM backend is deployed in the same regulatory jurisdiction as the services
- Sanitize fields before transmission (see `sanitize_field_names`)
- APM access is audited and role-based — not all engineers should see production transaction data
- Retention period for APM data aligns with least-privilege data minimization principles

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What problem does the 'sanitize_field_names' configuration in APM agents solve in a fintech environment?",
      "options": ["It improves APM query performance", "It prevents sensitive fields like card numbers and passwords from being captured and transmitted to the APM backend", "It normalizes field names to a standard format", "It reduces the amount of data sent to APM to lower costs"],
      "correct": 1,
      "explanation": "APM agents capture request/response bodies and transaction attributes to aid debugging. Without sanitization, sensitive data like PANs, CVVs, and passwords could be transmitted to and stored in the APM system, violating PCI-DSS and privacy regulations. The sanitize_field_names list ensures these fields are masked before leaving the application."
    },
    {
      "text": "What does an N+1 query problem look like in an APM flame graph, and what is the typical cause?",
      "options": ["A single very slow query appearing at the top of the flame graph — caused by missing index", "Many identical fast queries repeating in a loop — caused by ORM lazy loading fetching child entities one-by-one", "N database connections all waiting for the same lock — caused by a long transaction", "A query that runs N times faster than expected — caused by query plan caching"],
      "correct": 1,
      "explanation": "N+1 problems manifest as a large number of identical short queries in the APM trace, one for each parent record loaded. The root cause is typically ORM lazy loading — when you fetch N parent entities and then access a lazy-loaded relationship, the ORM fires one additional query per parent. The fix is eager loading with JOIN or batch fetching."
    },
    {
      "text": "Why is auto-instrumentation via a Java agent preferred over manual instrumentation for APM in a large payment platform?",
      "options": ["Agent instrumentation is more accurate than manual SDK calls", "Auto-instrumentation captures all frameworks (JDBC, HTTP clients, messaging) with no code changes, reducing instrumentation maintenance burden and ensuring consistent coverage", "Java agents have lower performance overhead than SDK instrumentation", "Manual instrumentation requires more expensive APM licenses"],
      "correct": 1,
      "explanation": "Auto-instrumentation via the Java agent uses bytecode manipulation to inject tracing into popular frameworks at startup, requiring zero code changes. This ensures comprehensive coverage of all HTTP calls, database queries, and messaging operations across the entire codebase, while manual SDK instrumentation would need to be added to every class and would likely miss third-party library calls."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Deploy APM for a Payment Processing Service and Identify Performance Bottlenecks",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Configure the OpenTelemetry Java agent on a Spring Boot payment service with auto-instrumentation, ensuring service name, version, and environment attributes are set, sensitive fields (PAN, CVV, password) are sanitized, and traces are exported to an APM backend of your choice."},
    {"id": "2", "description": "Add custom spans for the two most business-critical operations: fraud assessment (with model version, score, and decision attributes) and ledger debit (with account type and amount attributes) — without exposing any PII in span attributes."},
    {"id": "3", "description": "Use APM database query analysis to identify and fix an N+1 query problem in the payment history retrieval endpoint. Document the before/after query counts and latency improvement measured in the APM tool."},
    {"id": "4", "description": "Generate and interpret a continuous profiling flame graph from a load test of the payment service. Identify the top CPU hotspot, propose and implement an optimization, and measure the CPU reduction using the flame graph comparison view."}
  ]
}
-->
