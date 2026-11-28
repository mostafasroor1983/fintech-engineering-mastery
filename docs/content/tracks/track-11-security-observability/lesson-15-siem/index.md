---
id: track-11-lesson-15
title: "SIEM and Security Events — Correlating Financial Logs"
slug: siem
track: track-11
trackName: "Security & Observability"
sequence: 15
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [SIEM, security-events, correlation, Splunk, detection]
prerequisites: [track-11-lesson-14]
---

# SIEM and Security Events — Correlating Financial Logs

> [!NOTE]
> Individual security events are noise. A single failed login attempt is unremarkable. Five failed logins for 200 different accounts from one IP in 60 seconds is a credential stuffing attack. SIEM systems exist to find these patterns across millions of events that no human could review manually.

## SIEM Architecture for Financial Services

```
Log Sources                  Collection           SIEM Platform
──────────                   ──────────           ─────────────
Payment Service ──────────► Fluentd/Logstash ───► Splunk / Elastic SIEM
Auth Service   ──────────►  (parse, enrich,       │
Fraud Service  ──────────►   normalise)           │── Correlation Engine
Database       ──────────►                        │   (rules evaluate
WAF/API GW     ──────────►  Kafka Topic           │    continuously)
HSM/Vault      ──────────►  (security-events)     │
Kubernetes     ──────────►                        │── Alert Engine
Infrastructure ──────────►                        │   (fires when rule
Network Flow   ──────────►                        │    matches)
                                                  │
                                                  └── Case Management
                                                      (incident tracking)
```

A SIEM is effective only if the events flowing into it are structured, consistent, and contain the right fields. Unstructured log files produce noisy, low-fidelity detections.

---

## Security Event Types for Financial Services

### Authentication Events

```java
@Component
public class AuthenticationEventPublisher implements
        ApplicationListener<AbstractAuthenticationEvent> {

    @Override
    public void onApplicationEvent(AbstractAuthenticationEvent event) {
        if (event instanceof AuthenticationSuccessEvent success) {
            publishSecurityEvent(SecurityEventBuilder.builder()
                .eventType("AUTHENTICATION_SUCCESS")
                .outcome("SUCCESS")
                .customerId(success.getAuthentication().getName())
                .ipAddress(getCurrentIpAddress())
                .userAgent(getCurrentUserAgent())
                .timestamp(Instant.now())
                .build());
        } else if (event instanceof AbstractAuthenticationFailureEvent failure) {
            publishSecurityEvent(SecurityEventBuilder.builder()
                .eventType("AUTHENTICATION_FAILURE")
                .outcome("FAILURE")
                .reason(failure.getException().getClass().getSimpleName())
                .attemptedUsername(failure.getAuthentication().getName())
                .ipAddress(getCurrentIpAddress())
                .userAgent(getCurrentUserAgent())
                .timestamp(Instant.now())
                .build());
        }
    }
}
```

### Structured Security Event Schema

All security events must follow a consistent schema so the SIEM can correlate them across sources. Rather than inventing field names, consider aligning with a standard schema such as the Elastic Common Schema (ECS) or OCSF — SIEM content and detection rules then work out of the box.

```json
{
  "event": {
    "id": "evt-a3f7d2c1-1234-5678-abcd",
    "type": "AUTHENTICATION_FAILURE",
    "category": "authentication",
    "outcome": "failure",
    "severity": "medium",
    "timestamp": "2026-11-08T02:17:33.456Z",
    "source": "payment-service",
    "environment": "production",
    "version": "1.0"
  },
  "actor": {
    "type": "customer",
    "id": "CUST-123456",
    "email_hash": "sha256:a3f7...",
    "ip_address": "203.0.113.45",
    "ip_country": "GB",
    "user_agent": "Mozilla/5.0 ...",
    "session_id": "sess-abc123"
  },
  "target": {
    "type": "authentication_endpoint",
    "url": "/auth/login",
    "service": "auth-service"
  },
  "detail": {
    "failure_reason": "INVALID_PASSWORD",
    "attempt_count": 3,
    "mfa_required": true,
    "mfa_completed": false
  }
}
```

---

## Correlation Rules for Financial Services

Correlation rules evaluate streams of events in real time. They define the patterns that indicate attacks or anomalies.

### Rule 1: Credential Stuffing Detection

```
RULE: credential_stuffing_detection
DESCRIPTION: Multiple accounts targeted from single IP in short window

TRIGGER:
  Count of AUTHENTICATION_FAILURE events
  WHERE actor.ip_address = X
  AND event.type = "AUTHENTICATION_FAILURE"
  AND detail.failure_reason = "INVALID_PASSWORD"
  GROUPED BY actor.ip_address
  WITHIN 60 seconds
  THRESHOLD > 10 distinct actor.id values

ALERT SEVERITY: HIGH
ACTION:
  1. Temporarily block IP address at WAF (auto-remediation via API)
  2. Create SIEM case for investigation
  3. Page security on-call team
  4. Notify fraud team

RATIONALE:
  Legitimate users don't fail authentication for 10 different accounts in 60 seconds.
  This pattern indicates automated credential stuffing from a botnet or proxy.
  Note: modern stuffing tools rotate through thousands of residential proxy IPs
  (a few attempts per IP), so pair this rule with one on the GLOBAL failure
  rate and failure ratio across all IPs.
```

### Rule 2: Account Takeover Attempt

```
RULE: account_takeover_sequence
DESCRIPTION: Login from unusual location followed by payment submission

TRIGGER:
  Sequence within 10 minutes:
    Event 1: AUTHENTICATION_SUCCESS
      WHERE actor.ip_country != customer.usual_countries
      OR actor.device_id NOT IN customer.known_devices

    Event 2: PAYMENT_SUBMITTED
      WHERE actor.id = Event1.actor.id
      AND payment.amount > customer.average_payment_amount * 10

ALERT SEVERITY: CRITICAL
ACTION:
  1. Block the specific payment in real time (via fraud service API)
  2. Trigger step-up authentication for the customer
  3. Notify customer via SMS/email
  4. Create case for fraud investigation
```

### Rule 3: After-Hours Administrative Access

```
RULE: after_hours_admin_access
DESCRIPTION: Admin account access outside business hours

TRIGGER:
  ADMIN_LOGIN event
  WHERE actor.role = "ADMIN"
  AND event.timestamp NOT IN 08:00-18:00 Monday-Friday UTC
  AND event.environment = "PRODUCTION"

ALERT SEVERITY: HIGH
ACTION:
  1. Send alert to security team (immediate Slack + PagerDuty)
  2. Log full session for review
  3. Require manager sign-off (auto-generate approval request)
```

### Rule 4: Anomalous Transaction Volume

```
RULE: unusual_transaction_volume
DESCRIPTION: Sudden spike in transaction volume from single account

TRIGGER:
  Count of PAYMENT_SUBMITTED events
  WHERE actor.id = X
  WITHIN 1 hour
  > 3x the customer's 30-day rolling average for that hour
  AND total amount > £10,000

ALERT SEVERITY: MEDIUM
ACTION:
  1. Flag account for fraud review
  2. Apply enhanced fraud scoring to subsequent transactions
  3. Notify customer if threshold exceeded
```

---

## Splunk/Elastic SIEM Integration

### Structured Log Forwarding from Spring Boot

```xml
<!-- logback-spring.xml — structured JSON logs for SIEM ingestion -->
<configuration>
  <appender name="JSON_STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <includeCallerData>false</includeCallerData>
      <!-- Include MDC fields as top-level JSON keys for SIEM parsing -->
      <includeMdcKeyName>transactionId</includeMdcKeyName>
      <includeMdcKeyName>customerId</includeMdcKeyName>
      <includeMdcKeyName>sessionId</includeMdcKeyName>
      <includeMdcKeyName>ipAddress</includeMdcKeyName>
      <includeMdcKeyName>correlationId</includeMdcKeyName>
      <!-- Add service context to every log entry -->
      <customFields>{"service": "payment-service", "environment": "production"}</customFields>
    </encoder>
  </appender>

  <!-- Security events go to dedicated appender — higher reliability -->
  <appender name="SECURITY_EVENTS" class="ch.qos.logback.core.rolling.RollingFileAppender">
    <file>/var/log/payment-service/security-events.log</file>
    <encoder class="net.logstash.logback.encoder.LogstashEncoder"/>
    <rollingPolicy class="ch.qos.logback.core.rolling.TimeBasedRollingPolicy">
      <fileNamePattern>/var/log/payment-service/security-events.%d{yyyy-MM-dd}.log</fileNamePattern>
      <!-- Local buffer only: a shipper (Fluent Bit, Filebeat) forwards the file
           to the SIEM, which keeps the retention PCI DSS 10.5.1 requires
           (12 months, the last 3 immediately available) -->
      <maxHistory>7</maxHistory>
    </rollingPolicy>
  </appender>

  <!-- Security events use dedicated logger — separate from application logs -->
  <logger name="SECURITY_AUDIT" level="INFO" additivity="false">
    <appender-ref ref="SECURITY_EVENTS"/>
  </logger>

  <root level="INFO">
    <appender-ref ref="JSON_STDOUT"/>
  </root>
</configuration>
```

### Splunk Search Queries for Financial Security

Field names that contain dots must be wrapped in single quotes inside `eval` and `where` expressions.

**Credential stuffing detection:**

```spl
index=payment_logs sourcetype=auth_events event.type="AUTHENTICATION_FAILURE"
| bucket span=1m _time
| stats dc(actor.id) as unique_accounts, count as attempts by _time, actor.ip_address
| where unique_accounts > 10
| sort -unique_accounts
| table _time, actor.ip_address, unique_accounts, attempts
```

**Payment fraud pattern — login from an unusual country followed by a high-value payment** (the customer's usual country comes from a lookup table, because it is not in the events):

```spl
index=payment_logs event.type IN ("AUTHENTICATION_SUCCESS", "PAYMENT_SUBMITTED")
| transaction actor.id maxspan=10m
    startswith=eval('event.type'="AUTHENTICATION_SUCCESS")
    endswith=eval('event.type'="PAYMENT_SUBMITTED")
| lookup customer_profile customer_id AS actor.id OUTPUT usual_country
| where mvindex('actor.ip_country', 0) != usual_country AND 'payment.amount' > 1000
| table _time, actor.id, actor.ip_country, usual_country, payment.amount, payment.destination_iban
```

**After-hours admin access** (outside 08:00–18:00 on weekdays, or any time at the weekend; set the time zone the business hours refer to):

```spl
index=payment_logs event.type="ADMIN_LOGIN"
| eval hour = tonumber(strftime(_time, "%H")), weekday = tonumber(strftime(_time, "%u"))
| where hour < 8 OR hour >= 18 OR weekday >= 6
| table _time, actor.id, actor.ip_address, actor.ip_country, event.environment
```

**Rejected-payment volume spike** (compared with the rolling average of the previous 168 hours = 7 days):

```spl
index=payment_logs event.type="PAYMENT_REJECTED"
| timechart span=1h count as rejected_count
| streamstats current=f window=168 avg(rejected_count) as rolling_avg
| where rejected_count > rolling_avg * 3
| table _time, rejected_count, rolling_avg
```

### Elastic SIEM Detection Rules (EQL)

```
# Elastic Event Query Language (EQL) rules for payment security

# Rule: brute force on payment API — 5 failures from one IP within 1 minute
sequence by actor.ip_address with maxspan=1m
  [authentication where event.outcome == "failure"] with runs=5

# Rule: repeated failures followed by a success — the password was guessed
sequence by actor.id with maxspan=5m
  [authentication where event.outcome == "failure"] with runs=5
  [authentication where event.outcome == "success"]

# Rule: admin login followed by a data export or bulk payment
sequence by actor.id with maxspan=5m
  [authentication where actor.role == "ADMIN" and event.outcome == "success"]
  [any where event.type in ("DATA_EXPORT", "BULK_PAYMENT")]
```

EQL sequences match on shared join keys (`by actor.id`); they cannot compare field values *between* events (e.g. the distance between two login locations) or remember history. For **impossible travel** use an ES|QL rule or a machine-learning job, and for **first-time behaviour** (an admin exporting data for the first time) use a *new terms* rule.

---

## Alert Triage Workflow

```
1. ALERT FIRES
   SIEM creates case automatically, assigns to on-call security analyst

2. INITIAL TRIAGE (within 15 minutes)
   Open case in SIEM
   Review triggering events in raw log view
   Determine: True positive or false positive?
   
   False positive indicators:
   - Known pentest IP address
   - Load test running
   - Known admin doing scheduled maintenance
   - Rule misconfigured (adjust rule, suppress)

   True positive indicators:
   - Unknown IP/country
   - Pattern matches known attack technique
   - Customer not aware of activity

3. TRUE POSITIVE RESPONSE
   Severity P3 (Low): Document, schedule investigation
   Severity P2 (Medium): Investigate within 2 hours, consider customer notification
   Severity P1 (High/Critical): Immediate response, escalate to incident response process

4. FALSE POSITIVE MANAGEMENT
   Document false positive in SIEM case
   Tune rule to reduce recurrence (tighten threshold, add exclusion)
   Monthly false positive review — rules with > 50% FP rate need rewriting
```

---

## False Positive Reduction

```
Common false positives in financial SIEM and how to reduce them:

1. After-hours admin access
   False positive: Automated jobs running as admin service account
   Fix: Exclude known automation accounts from rule; create separate rule for human admin accounts

2. Unusual transaction volume
   False positive: End-of-month bulk payment processing
   Fix: Add time-of-month context; allowlist known bulk payment schedules

3. Multiple failed logins
   False positive: Mobile app aggressively retrying on network error
   Fix: Filter by user_agent to exclude known mobile app retry patterns

4. Geographic anomaly
   False positive: Customer using VPN
   Fix: Adjust threshold to require both geo anomaly AND other risk factor
```

---

## Compliance Reporting from SIEM

PCI DSS (Requirement 10) and supervisors (for example under DORA's ICT risk-management rules) expect evidence that security events are logged and reviewed.

**All admin access in the last 90 days** (supports PCI DSS 10.2.1.2 — all actions by accounts with administrative access are logged):

```spl
index=payment_logs event.type="ADMIN_LOGIN" earliest=-90d
| stats count as login_count, 
        dc(actor.ip_address) as unique_ips,
        earliest(_time) as first_seen,
        latest(_time) as last_seen
  by actor.id, actor.ip_country
| outputlookup pci_admin_access_90d.csv
```

**Failed logins in the last 30 days** (supports PCI DSS 10.2.1.4 — invalid logical access attempts are logged):

```spl
index=payment_logs event.type="AUTHENTICATION_FAILURE" earliest=-30d
| stats count by actor.ip_address, detail.failure_reason
| sort -count
| head 100
```

---

## Key Takeaways

- SIEM is only as good as the events feeding it: invest in structured JSON logging with consistent field names before investing in SIEM rules
- Correlation rules must model attacker behaviour, not just individual events: credential stuffing is invisible looking at single events, obvious looking at patterns across events
- Financial services SIEM must cover: authentication events, payment operations, admin access, after-hours activity, and anomalous transaction patterns
- Alert triage requires discipline: measure false positive rates monthly and tune rules when FP rate exceeds 50%—alert fatigue in the SOC is as dangerous as alert fatigue in engineering
- PCI DSS Requirement 10 mandates audit logs for all system components, daily review of security events and critical-system logs (10.4.1), and — since 31 March 2025 — automated mechanisms for that review (10.4.1.1); SIEM automation is how this is met in practice
- Elastic EQL and Splunk SPL are powerful tools for ad-hoc investigation—analysts should be comfortable writing queries to follow up on SIEM alerts

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the fundamental difference between a SIEM system and a standard log aggregation platform like Elasticsearch?",
      "options": [
        "SIEM systems store more log data",
        "SIEM systems correlate events across multiple sources over time to detect patterns indicating attacks, while log aggregation simply stores and indexes individual log entries for search",
        "SIEM systems are faster to query",
        "SIEM systems can only process security logs"
      ],
      "correct": 1,
      "explanation": "Log aggregation makes individual events searchable. SIEM adds correlation — detecting that 5 failed logins for 200 different accounts from one IP in 60 seconds is a credential stuffing attack, something invisible when looking at individual log entries. SIEM applies rules, machine learning, and temporal correlation across millions of events."
    },
    {
      "text": "What PCI DSS requirement mandates daily log review, and how does SIEM automation satisfy this requirement?",
      "options": [
        "PCI DSS Requirement 6.3 — SIEM satisfies it by scanning logs for code vulnerabilities",
        "PCI DSS Requirement 10 — SIEM automation satisfies the daily review requirement by continuously applying detection rules and generating alerts for suspicious activity, creating an automated audit trail of review activity",
        "PCI DSS Requirement 8.2 — SIEM satisfies it by enforcing password policies",
        "PCI DSS Requirement 12.1 — SIEM satisfies it by maintaining security policies"
      ],
      "correct": 1,
      "explanation": "PCI DSS 10.4.1 requires security events and the logs of critical system components to be reviewed at least daily, and 10.4.1.1 (mandatory since 31 March 2025) requires automated mechanisms to perform those reviews. With millions of daily log entries, human review is impossible. SIEM automation applies detection rules continuously, generates alerts for anomalies, and produces daily summary reports — satisfying the requirement, with analysts investigating what the automation surfaces."
    },
    {
      "text": "What is the recommended action when a SIEM correlation rule has a false positive rate exceeding 50%?",
      "options": [
        "Accept the false positives — it is better to have too many alerts than too few",
        "Disable the rule entirely and replace it with manual review",
        "Tune the rule by adding additional conditions, increasing thresholds, or adding exclusions for known legitimate patterns — alert fatigue in the SOC is as dangerous as missing real attacks",
        "Increase analyst headcount to handle the volume"
      ],
      "correct": 2,
      "explanation": "A SIEM rule generating more false positives than true positives causes alert fatigue — analysts stop investigating alerts because they expect noise. This means real attacks go uninvestigated. Rules must be continuously tuned using feedback from analyst investigations to maintain a manageable true positive rate."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "SIEM Detection Rules for Financial Security Events",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "Design a structured security event taxonomy for a payment platform: define JSON schemas for authentication events (LOGIN_SUCCESS, LOGIN_FAILURE, MFA_FAILURE), payment events (PAYMENT_SUBMITTED, PAYMENT_APPROVED, PAYMENT_REJECTED), and security events (RATE_LIMIT_EXCEEDED, INVALID_TOKEN_PRESENTED, SUSPICIOUS_ACTIVITY_DETECTED) with all required fields."
    },
    {
      "id": "2",
      "description": "Write Elastic EQL (Event Query Language) detection rules for three attack patterns: credential stuffing from one IP (>50 failed logins in 10 minutes), repeated failures followed by a success for the same account, and velocity fraud (>10 payment submissions from one customer in 5 minutes). Then explain which rule type (ES|QL, machine learning, or new terms) you would use for impossible travel and why EQL cannot express it."
    },
    {
      "id": "3",
      "description": "Implement a Spring Boot SecurityAuditService that writes security events to both an append-only database table (using REQUIRES_NEW transaction propagation) and publishes them to a Kafka topic for SIEM ingestion, with IP addresses pseudonymised using a keyed hash (HMAC) — note that pseudonymised data is still personal data under GDPR, so retention and access rules still apply."
    },
    {
      "id": "4",
      "description": "Create a SIEM alert triage dashboard in Grafana or Kibana showing: alert volume by rule name over 24 hours, false positive rate per rule (alerts where analyst marked 'no action needed'), mean time to close by severity, and a table of open alerts sorted by severity and age."
    }
  ]
}
-->
