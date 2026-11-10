---
id: track-13-lesson-08
title: "Incident Response — On-Call Playbooks and Runbooks"
slug: incident-response
track: track-13
trackName: "Security & Observability"
sequence: 8
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [incident-response, runbook, playbook, P1, escalation]
prerequisites: [track-13-lesson-07]
---

# Incident Response — On-Call Playbooks and Runbooks

> [!NOTE]
> A payment system incident at 2am is not the time to improvise. The difference between a 15-minute resolution and a 3-hour outage is almost always preparation: runbooks written in advance, escalation paths documented, communication templates ready, and regulatory obligations understood before the pressure is on.

## The Incident Response Lifecycle

Every payment system incident follows the same lifecycle, regardless of cause or severity:

```
DETECT → DECLARE → TRIAGE → MITIGATE → RESOLVE → POSTMORTEM
```

| Phase | Goal | Key Actions | Time Target |
|-------|------|-------------|-------------|
| Detect | Know there is a problem | Alert fires, monitoring shows degradation | < 5 min from impact start |
| Declare | Assign ownership and severity | Acknowledge page, assess P1/P2/P3, assign incident commander | < 2 min from alert |
| Triage | Understand what is broken | Check dashboards, logs, recent deploys, identify blast radius | < 10 min |
| Mitigate | Stop the bleeding | Rollback, circuit break, scale up, disable feature flag | < 15 min |
| Resolve | Full restoration | Root cause confirmed, service fully operational | Varies by severity |
| Postmortem | Prevent recurrence | Blameless analysis, action items, timeline published | Within 5 days |

---

## Severity Classification for Payment Systems

Severity classification determines who you wake up and how fast you need to act.

| Severity | Definition | Example | Response SLA |
|----------|-----------|---------|--------------|
| P1 — Critical | Complete payment processing failure or data integrity risk | Payment API returning 500 for all transactions | Immediate — 24/7 on-call |
| P2 — High | Significant degradation affecting >10% of transactions | p99 latency > 10s, partial payment failures | 30 min (business hours), 1h (nights/weekends) |
| P3 — Medium | Partial degradation, workaround available | Specific payment method failing, settlement delayed | 4 hours business hours only |
| P4 — Low | Minor issues, no customer impact | Monitoring alert flapping, non-critical service degraded | Next business day |

For regulated financial services, P1 incidents affecting customers may trigger regulatory notification obligations (see Regulatory Obligations section).

---

## On-Call Runbook Structure

A runbook is a step-by-step diagnostic and remediation guide for a specific alert. It answers: "The alert fired at 2am, now what?"

### Runbook Template

```markdown
# Runbook: [Alert Name]

## Overview
- **Service**: payment-service
- **Alert**: PaymentApiHighErrorRate
- **Severity**: P1
- **Team**: Payments Engineering
- **Last tested**: 2026-10-15

## Triggers
This runbook is triggered when:
- Payment API error rate exceeds 14x burn rate for > 2 minutes (SLO burn rate alert)
- More than 5% of payment transactions returning 5xx in the last 5 minutes

## Impact
- Customers cannot submit payments
- Standing orders and direct debits may fail to process
- Potential regulatory notification required if duration > 15 minutes

## Diagnosis Steps

### Step 1: Confirm the incident (2 minutes)
1. Open Grafana dashboard: https://grafana.example.com/d/payment-overview
2. Confirm: error rate elevated on `payment-service` pods?
3. Check: which endpoints are failing? (all endpoints vs specific paths)
4. Check: when did it start? (look for correlated deploy, config change, infrastructure event)

### Step 2: Check database connectivity (3 minutes)
```bash
# From payment-service pod
kubectl exec -n payments deployment/payment-service -- \
  curl -s http://localhost:8080/actuator/health | jq '.components.db'

# Expected healthy output:
# {"status": "UP", "details": {"database": "PostgreSQL", "result": 1}}

# If database is DOWN:
# → Check PostgreSQL pod: kubectl get pods -n data -l app=postgresql
# → Check connection pool: GET /actuator/metrics/hikaricp.connections.active
```

### Step 3: Check downstream dependencies (3 minutes)
```bash
# Fraud service health
curl -s http://fraud-service/actuator/health | jq '.status'

# Notification service
curl -s http://notification-service/actuator/health | jq '.status'

# External payment gateway (check status page: https://status.paymentgateway.com)
curl -s http://payment-service/actuator/health | jq '.components.paymentGateway'
```

### Step 4: Check Kafka consumer lag (2 minutes)
```bash
# If payment events are backed up, lag will be growing
kubectl exec -n kafka kafka-0 -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group payment-processor \
  --describe | awk 'NR>1 {print $1, $5, $6}'
# Column 5 = LAG, Column 6 = LAG-MAX
# LAG > 10,000 and growing = Kafka consumer is overwhelmed
```

### Step 5: Check recent deployments
```bash
# Recent rollouts in the last 2 hours
kubectl rollout history deployment/payment-service -n payments
# If recent deploy correlates with incident start time → rollback (Step 6a)
```

## Mitigation Options

### 6a: Rollback deployment (if deploy caused the issue)
```bash
# Rollback to previous version
kubectl rollout undo deployment/payment-service -n payments

# Monitor rollout
kubectl rollout status deployment/payment-service -n payments --timeout=5m

# Verify error rate drops within 2 minutes
# Dashboard: https://grafana.example.com/d/payment-overview
```

### 6b: Restart pods (if memory/thread issue)
```bash
# Rolling restart — does not cause downtime with 3+ replicas
kubectl rollout restart deployment/payment-service -n payments
```

### 6c: Scale up (if traffic spike)
```bash
# Increase replica count
kubectl scale deployment payment-service --replicas=10 -n payments

# Check HPA is not fighting you
kubectl get hpa -n payments
```

### 6d: Enable circuit breaker to downstream (if downstream is degraded)
```bash
# Force circuit breaker open to fraud service (payments proceed without fraud check)
kubectl set env deployment/payment-service \
  FRAUD_CHECK_ENABLED=false \
  -n payments

# IMPORTANT: notify compliance team immediately if fraud checks are disabled
# Regulatory risk: document with timestamp in incident channel
```

### 6e: Enable maintenance mode (last resort)
```bash
# Returns 503 with retry-after header to all payment endpoints
# Prevents partial failures and confusing error states
kubectl set env deployment/payment-service \
  MAINTENANCE_MODE=true \
  -n payments
# Update status page: https://status.example.com/admin
```

## Escalation

| Condition | Escalate To | Via |
|-----------|-------------|-----|
| Database corruption suspected | DBA on-call | PagerDuty: dba-oncall |
| > 15 min outage | Engineering Manager | PagerDuty: eng-mgr-oncall |
| Regulatory notification threshold | Head of Operations | Phone: listed in ESCALATION.md |
| Security breach suspected | CISO / Security team | PagerDuty: security-oncall (do NOT use Slack) |

## Post-Incident Actions
- [ ] Confirm error rate returned to normal baseline
- [ ] Check for failed payments requiring retry or compensation
- [ ] Assess whether regulatory notification is required
- [ ] Schedule postmortem within 5 business days
- [ ] File Jira ticket for root cause fix
```

---

## PagerDuty Integration with Prometheus

```yaml
# alertmanager.yml — PagerDuty integration
receivers:
  - name: 'pagerduty-payments-p1'
    pagerduty_configs:
      - routing_key: '${PAGERDUTY_PAYMENTS_KEY}'
        severity: critical
        description: '{{ .CommonAnnotations.summary }}'
        details:
          alert: '{{ .CommonLabels.alertname }}'
          environment: '{{ .CommonLabels.environment }}'
          service: '{{ .CommonLabels.job }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'
          dashboard: '{{ .CommonAnnotations.dashboard_url }}'
          value: '{{ .CommonAnnotations.description }}'
        # Link to Grafana for one-click context
        links:
          - href: '{{ .CommonAnnotations.dashboard_url }}'
            text: 'Grafana Dashboard'
          - href: '{{ .CommonAnnotations.runbook_url }}'
            text: 'Runbook'
        # Auto-resolve when alert clears
        send_resolved: true
```

```java
// Spring Boot — structured logs for incident correlation
// Logs indexed in ELK/Loki, searchable during incidents
@Slf4j
@Service
public class PaymentService {

    public PaymentResult processPayment(PaymentRequest request) {
        String txId = generateTransactionId();
        MDC.put("transactionId", txId);
        MDC.put("customerId", request.getCustomerId());
        MDC.put("amount", request.getAmount().toString());
        MDC.put("currency", request.getCurrency());

        try {
            log.info("Payment processing started");
            PaymentResult result = executePayment(request);
            log.info("Payment processing completed status={}", result.getStatus());
            return result;
        } catch (Exception e) {
            log.error("Payment processing failed", e);
            throw e;
        } finally {
            MDC.clear();
        }
    }
}
```

---

## Communication Templates

During a P1 incident, communication discipline is as important as technical diagnosis. Use templates to ensure consistency and prevent panic.

### Internal Slack Communication (War Room Channel)

```
# INCIDENT DECLARED — #incident-payments-2026-11-08-001

**Severity**: P1
**Incident Commander**: @engineer-name
**Tech Lead**: @tech-lead-name
**Status**: TRIAGING
**Start Time**: 2026-11-08 02:17 UTC

**What we know**:
- Payment API error rate at 15% (14x SLO burn rate)
- Started ~02:15 UTC
- No recent deployment in the last 2 hours

**What we're checking**:
- Database connectivity (assigned: @engineer-a)
- Kafka consumer lag (assigned: @engineer-b)

**Next update**: in 10 minutes or on new information

---
# DO NOT speculate about cause in this channel until confirmed
# DO NOT DM individual engineers — post all updates here
```

### Status Page Update (Customer-Facing)

```
# Template for status.example.com

INVESTIGATING: Payment processing degradation
Posted: 2026-11-08 02:20 UTC

We are aware of issues affecting payment processing. 
Our engineers are actively investigating.

Affected services: Payment submission, standing orders
Unaffected: Account viewing, card management, transaction history

We will post an update within 15 minutes.
```

### Stakeholder Email (if duration > 30 minutes)

```
Subject: [P1 Incident] Payment Processing Degradation — Active Investigation

To: Head of Payments, Head of Operations, CTO
From: On-Call Engineer

SUMMARY: Payment processing is experiencing degraded performance.
We have an active incident response in progress.

IMPACT:
- Start time: 02:15 UTC
- Affected: Approximately 15% of payment submissions failing
- Unaffected: Account access, card controls, transaction history

CURRENT STATUS: Triaging. Root cause under investigation.

MITIGATION: If this continues beyond 15 minutes, we will apply
circuit breaking to prevent cascading failures.

NEXT UPDATE: 02:45 UTC or sooner if status changes.

Incident channel: #incident-payments-2026-11-08-001
```

---

## Regulatory Notification Requirements

Regulated financial services have mandatory notification timelines for significant incidents. Failing to notify regulators in time is a separate regulatory breach.

| Regulator | Jurisdiction | Notification Trigger | Timeline |
|-----------|-------------|---------------------|----------|
| FCA (Financial Conduct Authority) | UK | Operational incident causing significant impact to customers or market integrity | ASAP; written report within reasonable time |
| PRA (Prudential Regulation Authority) | UK | Operational disruption affecting critical functions | Immediate notification; details within 24h |
| OCC (Office of the Comptroller of the Currency) | US | Computer security incident | 36 hours |
| FDIC | US | Computer security incident | 36 hours |
| RBI (Reserve Bank of India) | India | Cyber security incident or IT failure affecting services | 2-6 hours depending on severity |
| ECB / EBA | EU | Major operational incident under DORA | 4 hours (initial), 24 hours (intermediate) |

> [!WARNING]
> These timelines start from when you become aware of the incident, not when the incident started. Document the timestamp when you declared awareness. Consult your Chief Risk Officer or Head of Compliance before making regulatory notifications—do not self-notify without guidance.

```java
// Incident tracking with regulatory notification flag
@Entity
@Table(name = "incidents")
public class Incident {
    @Id
    private String incidentId;
    private Instant startTime;
    private Instant detectedTime;      // When on-call was alerted
    private Instant declaredTime;      // When incident was formally declared
    private Severity severity;
    private boolean customerImpact;
    private boolean regulatoryNotificationRequired;
    private Instant regulatoryNotificationDeadline;  // Auto-computed from detectedTime
    private Instant regulatoryNotificationSentTime;
    private String status;             // OPEN, MITIGATED, RESOLVED
}
```

---

## Blameless Culture in Financial Services

Postmortems in financial services sometimes have legal and regulatory dimensions, which can discourage honest reporting. Build blameless culture explicitly.

### Principles for Blameless Postmortems

**People are not the problem.** Engineers made decisions with the information and tools available to them at the time. The root cause is always a system issue—process, tooling, monitoring, or design—not individual failure.

**Timeline over blame.** The postmortem constructs a timeline of what happened and when. It does not assign personal blame. It identifies contributing factors.

**Five whys, not one who.** Instead of "Who deployed the bad code?", ask "Why did a code change with that defect reach production? Why did testing not catch it? Why was the rollback not faster?"

**Action items, not reprimands.** Every postmortem concludes with specific, assigned, time-bound action items to prevent recurrence. These are engineering improvements, not disciplinary actions.

### Postmortem Template

```markdown
# Postmortem: Payment Processing Degradation 2026-11-08

**Date**: 2026-11-08
**Duration**: 02:15 UTC — 02:47 UTC (32 minutes)
**Severity**: P1
**Author**: @incident-commander
**Status**: Draft (review by 2026-11-13)

## Impact
- 15% of payment submissions failed for 32 minutes
- ~4,800 failed payment attempts (estimated)
- 0 payments lost (failed requests retried successfully by clients)
- Regulatory notification assessed: not required (< 15 min of complete outage)

## Timeline (UTC)
| Time | Event |
|------|-------|
| 02:12 | HikariCP leak detection alert fires (ignored — no runbook) |
| 02:15 | Payment error rate crosses 14x burn rate threshold |
| 02:16 | PagerDuty fires PaymentApiSLOBudgetBurnRateCritical |
| 02:17 | On-call acknowledges, declares P1, opens war room |
| 02:19 | Database confirmed UP, Kafka lag normal |
| 02:24 | HikariCP active connections at maximum (20/20) |
| 02:26 | Root cause identified: slow query from upstream marketing service |
| 02:31 | Circuit breaker enabled to marketing data lookup (feature flag) |
| 02:33 | Error rate returns to baseline |
| 02:47 | Incident resolved, monitoring confirmed normal |

## Root Cause
A marketing service deployed at 01:48 UTC began calling payment-service's
internal `/customer-segment` endpoint on every payment event, triggering
a full table scan on the transactions table. This held JDBC connections
for 15-30 seconds each, exhausting HikariCP's 20-connection pool.

## Contributing Factors
1. The `/customer-segment` endpoint had no query timeout configured
2. HikariCP leak detection alert had no runbook — ignored at 02:12
3. Marketing service deployment did not go through payments team review
4. No rate limiting on internal `/customer-segment` endpoint

## Action Items
| Item | Owner | Due | Ticket |
|------|-------|-----|--------|
| Add 2s query timeout to all JPA queries via @QueryHints | @engineer-a | 2026-11-15 | PAY-1234 |
| Write runbook for HikariCP connection exhaustion alert | @engineer-b | 2026-11-12 | PAY-1235 |
| Add rate limiting to all internal service endpoints | @engineer-c | 2026-11-22 | PAY-1236 |
| Require payments team review for services that call payment-service | @eng-manager | 2026-11-30 | PAY-1237 |
| Add HikariCP pool exhaustion as explicit SLO indicator | @engineer-a | 2026-11-15 | PAY-1238 |

## What Went Well
- SLO burn rate alerting fired quickly (5 minutes from impact start)
- War room communication was orderly — no duplicate work
- Circuit breaker mitigation was fast once root cause identified
- No data loss or regulatory breach

## What Could Be Improved
- HikariCP leak detection alert should have been investigated immediately at 02:12
- Runbook for database connection exhaustion was missing
- 9 minutes from alert to root cause identification — target is < 5 minutes
```

---

## Key Takeaways

- Structure every runbook with the same sections: triggers, diagnosis steps, mitigation options, escalation paths—engineers must be able to execute at 2am without reading documentation
- Severity classification drives escalation: P1 must have immediate response, P2/P3 can wait for business hours
- Regulatory notification timelines start from awareness, not incident start—document when you declared the incident
- Communication templates prevent panic and ensure consistent messaging to customers and stakeholders
- Blameless postmortems with specific action items are the primary mechanism for reliability improvement in payment systems
- The most valuable investment in incident response is writing runbooks before incidents happen, not after

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Under PCI DSS and typical UK FCA breach notification requirements, from which point does the regulatory notification clock typically start running?",
      "options": ["When the incident is fully resolved", "When the security team completes their investigation", "From the point of awareness — when the organisation first knew or should have known about the incident", "When the incident is publicly disclosed"],
      "correct": 2,
      "explanation": "Regulatory notification timelines (e.g., GDPR 72 hours, FCA requirements) run from the point of awareness, not from incident resolution. This is why incident commanders must immediately document when the incident was declared — to ensure notification deadlines are not missed during the chaos of response."
    },
    {
      "text": "What is the primary purpose of a blameless postmortem in a financial services engineering team?",
      "options": ["To identify and punish the engineer who caused the incident", "To create a written record for regulatory purposes", "To identify systemic factors and actionable improvements without creating a culture of fear that discourages future transparency", "To satisfy the SRE team's documentation requirements"],
      "correct": 2,
      "explanation": "Blameless postmortems focus on systemic causes — processes, tooling, monitoring gaps — rather than individual blame. When engineers fear being blamed, they withhold information during incidents (making resolution slower) and avoid reporting near-misses (missing learning opportunities). Blameless culture is a reliability prerequisite."
    },
    {
      "text": "In the incident from the lesson, what was the root cause of the HikariCP connection pool exhaustion that took 9 minutes to identify?",
      "options": ["A database server failure", "A marketing service deployment that called a payment-service endpoint on every payment event, triggering a full table scan that held connections for 15-30 seconds", "A Kafka consumer lag spike", "An expired TLS certificate"],
      "correct": 1,
      "explanation": "The marketing service deployed at 01:48 UTC began calling the payment-service /customer-segment endpoint on every payment event. This triggered a full table scan on the transactions table, holding JDBC connections for 15-30 seconds each and exhausting HikariCP's 20-connection pool. The HikariCP leak detection alert had no runbook and was ignored at 02:12."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Incident Response Runbook and Postmortem",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Write a complete runbook for HikariCP connection pool exhaustion in a Spring Boot payment service: trigger conditions, step-by-step diagnosis commands (kubectl, SQL queries, metric checks), three mitigation options in order of risk, escalation path, and regulatory notification decision tree."},
    {"id": "2", "description": "Design an incident severity classification matrix for a payment platform with P1-P4 levels, defining: customer impact threshold, response time SLA, escalation path, communication cadence, and regulatory notification trigger for each level."},
    {"id": "3", "description": "Write a Slack bot or webhook handler that automatically creates a war room channel when a PagerDuty P1 alert fires, posts the runbook link, assigns an incident commander from an on-call rotation, and sends the first customer communication template."},
    {"id": "4", "description": "Conduct a tabletop exercise: given the incident timeline from this lesson (marketing service causing connection pool exhaustion), write a complete blameless postmortem with timeline, root cause, contributing factors, 5 specific action items (each with owner and due date), and what went well."}
  ]
}
-->
