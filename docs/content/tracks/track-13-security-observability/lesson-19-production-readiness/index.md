---
id: track-13-lesson-19
title: "Production Readiness Checklist — Launching Financial Services"
slug: production-readiness
track: track-13
trackName: "Security & Observability"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [production-readiness, PRR, launch-checklist, runbook, DR-test]
prerequisites: [track-13-lesson-18]
---

# Production Readiness Checklist — Launching Financial Services

> [!NOTE]
> A Production Readiness Review (PRR) is not a bureaucratic gate—it is an engineering quality gate that asks: "Have we thought through every dimension of running this service in production?" In financial services, the cost of launching unready is catastrophic: data loss, regulatory breach, customer harm. The checklist is cheap insurance.

## Why Financial Services Need Formal PRR

Standard PRR practices from Google SRE and other engineering orgs cover observability and reliability. Financial services add three non-negotiable dimensions:

**Compliance**: The service must satisfy regulatory requirements (PCI DSS, GDPR, FCA, etc.) before it handles real customer data or money.

**Audit trail**: Every transaction, authentication event, and configuration change must be logged to a tamper-evident audit system.

**Incident notification obligations**: If the service has an outage, there may be regulatory notification requirements with hard deadlines.

---

## PRR Process

```
PRR Timeline for a New Payment Service
=======================================

T-8 weeks: PRR initiated
  Engineering team completes self-assessment checklist
  Identify gaps: missing observability, unresolved security findings
  Begin remediation sprint

T-4 weeks: Initial review
  Staff/Principal engineer reviews checklist
  Security team reviews security section
  Compliance officer reviews compliance section
  Risk team reviews operational section
  Identify remaining blockers

T-2 weeks: Pre-launch testing
  Load test at 2x expected peak traffic
  Disaster recovery test (failover to secondary region)
  Security pen test completed; findings remediated
  Runbooks tested by on-call team

T-0: Launch approval
  All checklist items GREEN
  Sign-off from: Engineering Lead, Security Lead, Compliance Officer
  On-call rotation populated
  Status page service created
  Rollback procedure tested and confirmed working

POST-LAUNCH: 2-week hypercare
  Enhanced monitoring with low alert thresholds
  Daily error rate review
  On-call team on standby
  Automatic rollback triggers configured
```

---

## Checklist Category 1: Observability

### Health Checks

```java
// Spring Boot — comprehensive health checks
@Configuration
public class HealthCheckConfig {

    @Bean
    public HealthIndicator paymentGatewayHealth(PaymentGatewayClient gateway) {
        return () -> {
            try {
                GatewayStatus status = gateway.getStatus();
                if (status.isOperational()) {
                    return Health.up()
                        .withDetail("gateway", status.getName())
                        .withDetail("latency_ms", status.getLatencyMs())
                        .build();
                }
                return Health.down()
                    .withDetail("gateway", status.getName())
                    .withDetail("message", status.getDegradationMessage())
                    .build();
            } catch (Exception e) {
                return Health.down().withException(e).build();
            }
        };
    }
}
```

```yaml
# application.yml — health check configuration
management:
  health:
    db:
      enabled: true
    kafka:
      enabled: true
    redis:
      enabled: true
  endpoint:
    health:
      show-details: when-authorized  # Not 'always' — avoids leaking topology
      probes:
        enabled: true  # Kubernetes liveness + readiness probes

# kubernetes/deployment.yaml — health probe configuration
livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

### Metrics Requirements

```
REQUIRED metrics for every payment service endpoint:
  [ ] Request rate (requests/second)
  [ ] Error rate (errors/total, broken down by error type)
  [ ] Latency (p50, p95, p99, p999 — histogram, not summary)
  [ ] Active connections / thread pool utilisation
  [ ] JVM heap usage, GC pause time, thread count

REQUIRED metrics for Kafka consumers (if applicable):
  [ ] Consumer lag (per partition, per consumer group)
  [ ] Messages processed per second
  [ ] Processing error rate

REQUIRED metrics for database connections:
  [ ] HikariCP pool: active, idle, pending, max
  [ ] Query latency histogram
  [ ] Transaction commit/rollback rate

REQUIRED business metrics:
  [ ] Payment submission rate (by currency, by payment type)
  [ ] Payment success rate
  [ ] Payment processing latency (time from submission to settlement)
  [ ] Fraud rejection rate
```

### Structured Logging Requirements

```java
// Every log line must include these fields for incident investigation
// Configured via MDC in a servlet filter

@Component
public class CorrelationFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws IOException, ServletException {
        String correlationId = Optional
            .ofNullable(request.getHeader("X-Correlation-ID"))
            .orElse(UUID.randomUUID().toString());

        MDC.put("correlationId", correlationId);
        MDC.put("httpMethod", request.getMethod());
        MDC.put("httpPath", request.getRequestURI());
        MDC.put("service", "payment-service");
        MDC.put("environment", environment.getActiveProfiles()[0]);

        response.addHeader("X-Correlation-ID", correlationId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.clear();
        }
    }
}
```

### Alerting Requirements

```
PRR GATE: All alerts must exist and be tested before launch

Required alerts (minimum):
  [ ] Service availability: error rate > 5% for 5 minutes
  [ ] Latency degradation: p99 > 1s for 5 minutes
  [ ] Database connection pool: > 90% utilised for 5 minutes
  [ ] Kafka consumer lag: > 10,000 messages for 5 minutes
  [ ] JVM heap: > 85% for 5 minutes
  [ ] Certificate expiry: < 30 days
  [ ] SLO burn rate: 14x for 2 minutes (page immediately)
  [ ] SLO burn rate: 6x for 15 minutes (high priority)

Each alert must have:
  [ ] Runbook URL in annotations
  [ ] Dashboard URL in annotations
  [ ] Appropriate severity label
  [ ] Routing to correct on-call team in Alertmanager
```

### Dashboard Requirements

```
Required Grafana dashboards:
  [ ] Service Overview: request rate, error rate, latency (all endpoints)
  [ ] JVM Health: heap, GC, threads, connections
  [ ] Kafka: consumer lag, throughput, errors (if applicable)
  [ ] Payment Business Metrics: submission rate, success rate by type
  [ ] SLO Dashboard: error budget remaining, burn rate
  [ ] Security Events: authentication failures, rate limit hits
```

---

## Checklist Category 2: Reliability

### Circuit Breakers and Retries

```java
// Resilience4j configuration — required for all external service calls
@Configuration
public class ResilienceConfig {

    // Circuit breaker for payment gateway
    @Bean
    public CircuitBreakerConfig paymentGatewayCircuitBreaker() {
        return CircuitBreakerConfig.custom()
            .slidingWindowSize(10)
            .failureRateThreshold(50)
            .waitDurationInOpenState(Duration.ofSeconds(30))
            .permittedNumberOfCallsInHalfOpenState(3)
            .build();
    }

    // Retry policy — only for idempotent operations
    @Bean
    public RetryConfig idempotentRetryConfig() {
        return RetryConfig.custom()
            .maxAttempts(3)
            .waitDuration(Duration.ofMillis(500))
            .retryOnException(e -> e instanceof TransientPaymentException)
            // NEVER retry on:
            // - Duplicate payment (idempotency violation)
            // - Insufficient funds
            // - Invalid account details
            .build();
    }
}
```

### Graceful Shutdown

```java
// Spring Boot — graceful shutdown allows in-flight requests to complete
// application.yml
server:
  shutdown: graceful  # Waits for active requests before stopping
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s  # Maximum wait time

// Also handle Kafka consumer shutdown gracefully
@Component
public class PaymentConsumer implements DisposableBean {

    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    @KafkaListener(topics = "payment-events")
    public void processPayment(PaymentEvent event) {
        if (shutdown.get()) {
            // Stop consuming during shutdown — let rebalance happen
            return;
        }
        paymentService.process(event);
    }

    @Override
    public void destroy() {
        shutdown.set(true);
        // Kafka consumer container pauses, commits offsets, and closes cleanly
    }
}
```

### Disaster Recovery Test

```
PRR GATE: DR test must be completed before launch

DR Test Procedure:
  1. Simulate primary region failure (stop all pods in primary region)
  2. Measure RTO: time from failure to service recovery in secondary region
  3. Measure RPO: last committed transaction before failover vs first committed after
  4. Test rollback: restore primary region, fail back
  5. Document results: actual RTO/RPO vs targets

Required targets for payment services:
  RTO (Recovery Time Objective): < 15 minutes
  RPO (Recovery Point Objective): < 1 minute (zero transaction loss)
  
Document failures (and fix them before launch):
  - Pods not starting in secondary region (image pull policy, resource quotas)
  - Database replication lag causing RPO > target
  - DNS failover taking too long
  - Persistent volumes not available in secondary region
```

---

## Checklist Category 3: Security

```
AUTHENTICATION & AUTHORISATION
  [ ] All API endpoints authenticated (no public endpoints without explicit justification)
  [ ] Authorisation tested: attempt cross-customer data access — confirm blocked
  [ ] Admin endpoints on separate service or separate auth
  [ ] Service accounts created per service (no default service accounts)
  [ ] NetworkPolicy applied: default-deny with explicit allow rules

SECRETS MANAGEMENT
  [ ] No hardcoded secrets in codebase (Semgrep scan passed)
  [ ] All secrets loaded from Vault or external secrets operator
  [ ] Database passwords are dynamic credentials from Vault (or rotated quarterly minimum)
  [ ] API keys and certificates in Kubernetes secrets (not ConfigMaps)

ENCRYPTION
  [ ] PAN and sensitive PII encrypted at application layer (not just disk encryption)
  [ ] TLS 1.3 enforced for all inbound connections
  [ ] mTLS configured for all service-to-service communication
  [ ] Encryption keys stored in KMS/Vault, not in application config

VULNERABILITY MANAGEMENT
  [ ] Semgrep SAST scan: zero HIGH/CRITICAL findings
  [ ] OWASP Dependency Check: zero CVE >= 7.0 unaddressed
  [ ] Container image scan: zero critical vulnerabilities in base image
  [ ] OWASP ZAP DAST scan against staging: zero HIGH findings
  [ ] Penetration test completed (for PCI-scoped services: required)

COMPLIANCE
  [ ] PCI DSS scope document reviewed and updated (if handling card data)
  [ ] GDPR Data Processing Impact Assessment (DPIA) completed (if processing PII)
  [ ] Data retention policy configured (auto-delete PII after retention period)
  [ ] Audit log enabled and writing to tamper-evident store
  [ ] Regulatory notification procedure documented and team trained
```

---

## Checklist Category 4: Operational

### Runbook Requirements

```
PRR GATE: Runbooks must exist and be tested before launch

Required runbooks:
  [ ] High error rate (>5% of requests failing)
  [ ] High latency (p99 > 2x normal)
  [ ] Database connection exhaustion
  [ ] Kafka consumer lag growing
  [ ] Service completely unavailable (OOMKilled, CrashLoopBackOff)
  [ ] Disk full on PVC
  [ ] Certificate about to expire

Each runbook must:
  [ ] Be tested by an on-call engineer who did NOT write it
  [ ] Have a "last tested" date within 90 days
  [ ] Include rollback instructions
  [ ] Reference relevant dashboards and log queries
  [ ] Include escalation contacts for each scenario
```

### On-Call Setup

```
  [ ] On-call rotation populated with trained engineers (minimum 4 engineers)
  [ ] PagerDuty escalation policy configured (acknowledgement → escalate to manager → escalate to CTO)
  [ ] On-call engineers have been briefed on the service and have read all runbooks
  [ ] On-call engineers have production access (kubectl, database read-only, AWS console)
  [ ] Incident channel created in Slack (#incident-<service-name>)
  [ ] Status page service created for customer-facing incidents
```

### Capacity Plan

```
  [ ] Baseline performance measured: requests/second per pod at p99 < 500ms
  [ ] Peak traffic estimated (1x, 2x, 10x — with justification)
  [ ] HPA configured with appropriate min/max replicas and scale trigger
  [ ] Load test at 2x expected peak: service held stable
  [ ] Load test at 5x expected peak: graceful degradation (not cascading failure)
  [ ] Database connection pool sized for maximum pod count
  [ ] Kafka partition count sufficient for maximum consumer count
```

---

## Compliance Sign-Off

```markdown
# Production Readiness Review Sign-Off

Service: payment-submission-service
Version: 2.3.0
Review Date: 2026-11-08

APPROVALS REQUIRED:

Engineering Lead
  Reviewer: [name]
  Status: APPROVED / BLOCKED
  Notes:

Security Lead
  Reviewer: [name]
  Status: APPROVED / BLOCKED / NOT APPLICABLE
  Security findings resolved: [link to ticket]
  Pen test completed: [link to report]

Compliance Officer
  Reviewer: [name]
  Status: APPROVED / BLOCKED / NOT APPLICABLE
  PCI DSS scope reviewed: [Yes / No / N/A]
  GDPR DPIA completed: [Yes / No / N/A]
  Regulatory notifications procedure confirmed: [Yes / No]

Risk Officer
  Reviewer: [name]
  Status: APPROVED / BLOCKED
  Known risks accepted: [list or "None"]
  Risk register updated: [Yes / No]

LAUNCH DECISION:
  [ ] All reviewers APPROVED → Cleared to launch
  [ ] One or more BLOCKED → Launch blocked; remediate and re-review
  [ ] Exceptions documented and accepted by Head of Engineering + CISO

HYPERCARE PLAN:
  Duration: 2 weeks
  Enhanced monitoring: Grafana on-call dashboard open during business hours
  Rollback trigger: > 2% error rate sustained 10 minutes
  Rollback procedure: kubectl rollout undo deployment/payment-submission-service
  Rollback tested: [Yes / No] — test date: [date]
```

---

## Key Takeaways

- A PRR is not a bureaucratic checkpoint—it is engineering accountability: does this service have everything it needs to run safely in production?
- Financial services PRRs require four non-negotiable sections: Observability (can you see problems?), Reliability (can the service recover?), Security (is customer data protected?), and Compliance (are regulatory obligations met?)
- Every alert must have a runbook URL—test runbooks with engineers who did not write them before launch, not during an incident at 2am
- Disaster recovery tests must demonstrate actual RTO and RPO—targets written in a document mean nothing if they have never been validated
- PCI DSS and GDPR add compliance checkpoints to the PRR that cannot be waived: scope document review, DPIA, pen test, audit log verification
- The most valuable investment in production readiness is load testing to 2x expected peak before launch—discovering thread pool exhaustion or database connection limits in production during a traffic spike is avoidable

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What are the four non-negotiable PRR sections for a financial services payment system, and what does each cover?",
      "options": ["Architecture, Performance, Documentation, Testing", "Observability (can you see problems?), Reliability (can the service recover?), Security (is customer data protected?), and Compliance (are regulatory obligations met?)", "Logging, Monitoring, Alerting, Incident Response", "Deployment, Scaling, Backups, DR"],
      "correct": 1,
      "explanation": "Financial services PRRs require all four sections because each addresses a different risk category. Observability ensures problems are detected quickly. Reliability ensures the service recovers from failures. Security ensures customer and financial data is protected. Compliance ensures regulatory obligations (PCI DSS, GDPR, FCA) are met before launch."
    },
    {
      "text": "Why must disaster recovery tests demonstrate actual RTO and RPO rather than simply documenting targets?",
      "options": ["Regulators require documented DR tests for audit purposes", "DR targets written in a document have never been validated against reality — teams discover that their actual recovery time is 4 hours when the target was 30 minutes only during a real disaster, when it is too late", "DR tests are needed to train new engineers", "DR tests satisfy the PCI DSS requirement for quarterly scans"],
      "correct": 1,
      "explanation": "DR targets are hypotheses until tested. Common discoveries during first DR tests: backup restoration takes 3x longer than expected, the runbook has gaps, secrets rotation breaks the restore, or the failover region has insufficient capacity. Discovering these in a planned drill costs hours; discovering them during a real disaster can mean days of recovery."
    },
    {
      "text": "What is the purpose of a hypercare period after launching a new payment service, and what should trigger a rollback?",
      "options": ["Hypercare is a marketing term with no operational meaning", "Hypercare is an enhanced monitoring and response period (typically 2 weeks) with pre-defined rollback triggers — a specific error rate threshold or latency degradation that, if breached, causes immediate rollback to the previous version", "Hypercare means the service runs in read-only mode for 2 weeks", "Hypercare requires all engineers to be on-call 24/7 for 2 weeks"],
      "correct": 1,
      "explanation": "Hypercare provides a safety net for the first weeks after launch when unexpected production traffic patterns may expose issues that testing missed. The key requirement is that rollback triggers are pre-defined before launch (e.g., >2% error rate for 10 minutes) and that rollback has been tested. Pre-defining the trigger removes decision-making pressure during an incident."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Production Readiness Review for a Payment Submission Service",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Complete the Observability section of a PRR for a new payment submission service: define what metrics will confirm the service is healthy (with specific alert thresholds), write the runbook for the two most likely failure scenarios, and verify that distributed traces connect to log lines via correlation IDs."},
    {"id": "2", "description": "Design and execute a chaos engineering experiment for the payment service: inject a 500ms latency on fraud-service calls and verify the circuit breaker opens after 5 failures, the payment API degrades gracefully (returns 503 with Retry-After), and the alert fires within 2 minutes; document the experiment results."},
    {"id": "3", "description": "Conduct a load test using Gatling or k6: ramp to 2x expected peak traffic (define peak as 1000 TPS), verify P99 latency stays under 500ms, verify no connection pool exhaustion, and verify that the HPA scales pods appropriately; produce a load test report suitable for the PRR sign-off document."},
    {"id": "4", "description": "Complete the Compliance section of the PRR: verify audit logs are generated for every payment submission, verify PAN is masked in all log outputs, verify the service scope is documented in the PCI DSS scope document, and confirm the incident notification procedure aligns with FCA breach reporting timelines."}
  ]
}
-->
