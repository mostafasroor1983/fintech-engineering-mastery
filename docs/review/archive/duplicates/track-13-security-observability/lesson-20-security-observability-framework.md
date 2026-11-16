---
id: track-13-lesson-20
title: "Principal Engineer's Security & Observability Decision Framework"
slug: security-observability-framework
track: track-13
trackName: "Security & Observability"
sequence: 20
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, security, observability, trade-offs, staff-engineer]
prerequisites: [track-13-lesson-19]
---

# Principal Engineer's Security & Observability Decision Framework

> [!NOTE]
> Principal engineers make tooling decisions that hundreds of engineers will live with for years. The right observability stack at £50k/year beats the wrong one at £500k/year. The right security tooling enables developer velocity; the wrong one becomes the obstacle that gets circumvented. This lesson provides the decision frameworks, not the conclusions—your context determines the right answer.

## The Principal Engineer's Role in Tooling Decisions

Staff and principal engineers are responsible for tooling decisions that affect entire engineering organisations. These decisions have characteristics that distinguish them from day-to-day engineering choices:

**Long time horizon**: An observability platform decision locks your organisation in for 3-5 years. Migration costs are substantial.

**Broad impact**: The choice affects not just your team but every engineer who operates a service in production.

**Compliance constraints**: In financial services, tooling must satisfy compliance requirements that may override technical preference. A better SIEM is irrelevant if it cannot satisfy PCI DSS Requirement 10.

**Cost at scale**: A tool that costs £5/month per developer may cost £500k/year at an organisation of 1,000 engineers.

---

## Observability Stack Selection

### Prometheus + Grafana vs Datadog vs New Relic

The core tradeoff is between **control and cost** (open-source self-hosted) and **capability and total cost** (SaaS).

**Prometheus + Grafana Stack**

Strengths:
- Zero licensing cost for the core platform
- Full control over data retention and cardinality
- Large ecosystem; Grafana supports 50+ data sources
- PCI DSS: data stays in your infrastructure (no PCI data leaving your boundary)
- Customisable alerting with Prometheus Alertmanager

Weaknesses:
- Operational overhead: you run the platform
- High cardinality metrics require careful management (Thanos/Cortex/Mimir for scale)
- No built-in anomaly detection; APM is a manual configuration effort
- Alert routing (Alertmanager) is powerful but complex

**When to choose Prometheus + Grafana**: Engineering team > 50 engineers; strong infrastructure/SRE capability; compliance requirements that make external data transmission difficult; predictable, high-volume metrics needs.

**Datadog**

Strengths:
- Unified platform: metrics, logs, traces, APM in one product
- Out-of-the-box dashboards for 500+ integrations
- Machine learning anomaly detection and forecasting
- Minimal operational overhead

Weaknesses:
- Expensive at scale: custom metrics pricing, host-based pricing adds up
- High cardinality costs can spiral unexpectedly
- PCI DSS consideration: cardholder environment data must not be sent to Datadog; requires careful filtering
- Vendor lock-in: Datadog query language and dashboards are proprietary

**When to choose Datadog**: Organisation moving fast, limited SRE capacity, willing to pay for time-to-value, non-PCI cardholder environment data.

**Cost comparison (approximate, 2026 pricing)**:

| Scenario | Prometheus + Grafana | Datadog |
|----------|---------------------|---------|
| 50 engineers, 20 services | £15k/year (infra only) | £60k/year |
| 200 engineers, 100 services | £80k/year | £350k/year |
| 500 engineers, 300 services | £200k/year | £1.2M/year |

The crossover point where Datadog's operational efficiency savings justify its cost premium is organisation-specific, but typically around 100-150 engineers for a team with moderate SRE investment.

### Observability Maturity Model

Use this model to assess your current state and plan the next investment:

```
Level 1 — Reactive (most teams start here)
  What you have: Application logs, basic server metrics (CPU/memory)
  What you're missing: Correlation between services, latency percentiles
  Pain: "We only know there's a problem when customers call"
  Next investment: Structured logging + distributed tracing (OpenTelemetry)

Level 2 — Aware
  What you have: Structured logs, metrics, basic alerting, dashboards
  What you're missing: SLOs, error budgets, latency histograms
  Pain: "Alert fatigue — pages at 2am that resolve themselves"
  Next investment: SLO-based alerting, histograms replacing averages

Level 3 — Proactive
  What you have: SLOs, burn rate alerting, tracing, structured logs
  What you're missing: Continuous profiling, anomaly detection
  Pain: "We know there's a problem 15 minutes before customers do"
  Next investment: JFR always-on profiling, predictive capacity

Level 4 — Anticipating
  What you have: Everything from Level 3 + continuous profiling + ML anomaly detection
  What you're missing: Nothing fundamental — this is the ceiling
  Pain: "Cost management — we have too much data we don't use"
  Next investment: Sampling strategy, cardinality governance
```

---

## Security Tooling Decisions

### WAF Selection: AWS WAF vs Cloudflare vs ModSecurity

| Factor | AWS WAF | Cloudflare | ModSecurity (open-source) |
|--------|---------|------------|--------------------------|
| Integration | Native with ALB/CloudFront | CDN-integrated | Nginx/Apache plugin |
| Managed rules | AWS Managed Rules, Marketplace | Cloudflare Managed Rulesets | OWASP CRS |
| DDoS protection | AWS Shield (additional cost) | Included in Business/Enterprise | None |
| Cost | Per request + rules | Per zone (flat rate plans) | Infrastructure only |
| Customisation | Limited to rule groups | Flexible with Workers | Full rule customisation |
| PCI DSS | Satisfies Requirement 6.3 | Satisfies Requirement 6.3 | Satisfies Requirement 6.3 |
| Latency | +1-5ms (same AWS region) | Edge nodes globally | Negligible (local) |

**Decision framework**:
- Already on AWS: AWS WAF is the low-friction choice
- Global traffic with DDoS concerns: Cloudflare Enterprise
- Specific custom rule requirements / on-premises: ModSecurity with OWASP CRS
- Hybrid: Cloudflare for edge + AWS WAF for application-tier

### SIEM Selection: Splunk vs Elastic SIEM

| Factor | Splunk Enterprise | Elastic SIEM |
|--------|------------------|-------------|
| Search language | SPL (powerful but proprietary) | KQL/EQL (open, familiar) |
| Cost | Expensive; data volume pricing | Storage-based; predictable |
| Out-of-box detections | Extensive (Splunk Security Content) | Growing; MITRE ATT&CK coverage |
| Compliance reports | Pre-built PCI DSS, SOX reports | Build your own |
| Operations | Commercial support; complex | Managed (Elastic Cloud) or self-host |
| PCI Requirement 10 | Well-tested; auditor-familiar | Accepted but less precedent |

**Principal engineer's view**: Splunk's cost premium is justified at organisations where the SOC team's time is expensive and compliance reporting is frequent. Elastic SIEM is the technically superior value proposition at lower scale, but requires more engineering investment in detection rule development.

### Secrets Management Selection

| Option | Use Case | Strengths | Weaknesses |
|--------|----------|-----------|------------|
| HashiCorp Vault | Full-featured secrets management | Dynamic credentials, transit encryption, audit log | Operational complexity; cluster management |
| AWS Secrets Manager | AWS-native simple secrets | Native IAM integration; automatic rotation | AWS-only; per-secret pricing |
| AWS KMS + SSM Parameter Store | Simple config and key management | Low cost; AWS-native | No dynamic credentials; limited TTL |
| Kubernetes Secrets | Simple config in K8s | Zero additional infra | Stored in etcd (requires encryption); no rotation |

**Recommendation for financial services**: HashiCorp Vault is the reference standard for fintech secrets management. Dynamic credentials (database, AWS, certificates), transit encryption-as-a-service, and comprehensive audit logs satisfy PCI DSS requirements out of the box. The operational overhead is real but justified by the security capabilities.

---

## Compliance-Driven Security Requirements

In financial services, some security decisions are made by regulators, not engineers. Understanding what is mandated versus recommended prevents wasted effort arguing about tooling that is non-negotiable.

### PCI DSS Mandatory Controls

The following are not engineering choices—they are requirements:
- Encrypted PAN at rest (AES-256 or tokenization) — **Requirement 3.4**
- TLS for cardholder data in transit — **Requirement 4.2**
- Penetration test annually — **Requirement 11.3**
- Log review daily (SIEM automation required) — **Requirement 10.4**
- Vulnerability scans quarterly — **Requirement 11.3.2**
- Change management process for all production changes — **Requirement 6.5**

### FCA Operational Resilience (UK)

- Important Business Services identified and documented
- Impact tolerances set (maximum downtime before significant harm)
- Self-assessment and testing to prove tolerances can be met
- Scenario testing including "severe but plausible" scenarios

---

## Observability Cost Management

At scale, observability cost becomes a material engineering budget item. Principal engineers own the cardinality governance strategy.

### Cardinality: The Principal Cost Driver

```
High cardinality metric (bad): http_requests_total{customer_id="12345"}
  → 1 million customers × 10 endpoints = 10 million time series
  → Prometheus heap explodes; cost scales linearly with customer count

Low cardinality metric (correct): http_requests_total{endpoint="/api/v1/payments"}
  → 10 endpoints = 10 time series
  → Scales independently of customer count
```

**Cardinality governance rules for payment teams:**

```
ALLOWED high-cardinality labels (bounded, low count):
  environment, region, service, endpoint, http_method, http_status, payment_type

NEVER use as metric labels (unbounded cardinality):
  customer_id, transaction_id, session_id, ip_address, user_agent

For per-customer analytics:
  Use structured logs → query in Loki/Elasticsearch for ad-hoc analysis
  Use ClickHouse or BigQuery for aggregated business analytics
  Never metrics — metrics are for operational signals, not analytics
```

### Sampling Strategy for Tracing

```yaml
# opentelemetry-collector configuration — sampling to control cost
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      # Always sample errors — critical for debugging
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}

      # Always sample slow requests — important for SLO analysis
      - name: slow-requests-policy
        type: latency
        latency: {threshold_ms: 1000}

      # Always sample payment operations — business-critical
      - name: payment-operations-policy
        type: string_attribute
        string_attribute:
          key: http.route
          values: ["/api/v1/payments", "/api/v1/transfers"]

      # Sample 1% of everything else — cost control
      - name: default-policy
        type: probabilistic
        probabilistic: {sampling_percentage: 1}
```

---

## Security vs Developer Experience Balance

The tension between security and developer velocity is real. Principal engineers must find the balance, not choose one at the expense of the other.

### Security Controls That Kill Velocity (Avoid)

- Manual approval for every production deployment (gate every deploy, lose deployment frequency)
- Security review required for every PR (bottleneck; engineers learn to avoid security reviewer)
- Overly strict WAF rules blocking legitimate requests (engineers bypass WAF by IP-whitelisting)
- Secrets rotation that requires downtime (teams keep credentials forever to avoid pain)

### Security Controls That Enable Velocity

- Automated SAST in CI/CD that finds vulnerabilities in minutes (faster feedback than a pen test)
- Developer security training (engineers find their own bugs before they ship)
- Security champions in each team (distributed security review, no central bottleneck)
- Self-service secrets management (Vault with clear documentation; teams don't need to ask ops for secrets)
- Pre-approved security patterns as reusable libraries (input validation, JWT validation, audit logging)

**Principal engineer's principle**: Security controls should be frictionless by default and require explicit opt-out with documentation. If the secure path is harder than the insecure path, engineers will take the insecure path under deadline pressure.

---

## Decision Documentation

Every significant tooling decision in security and observability must be documented as an ADR (Architecture Decision Record). Three years from now, the engineer inheriting your codebase needs to understand:
- What alternatives were considered
- What the decision was and why
- What the known trade-offs are
- Under what conditions the decision should be revisited

```markdown
# ADR-042: Observability Platform — Prometheus + Grafana + Loki

Status: Accepted
Date: 2026-11-08
Deciders: Principal Engineer, VP Engineering, Head of SRE

## Context
We need to select an observability platform for our 150-engineer engineering organisation.
Current state: ad-hoc logging, no metrics, no tracing.

## Decision
Adopt the LGTM stack: Loki (logs), Grafana (dashboards), Tempo (traces), Mimir (metrics at scale).
Self-hosted on Kubernetes. Managed by Platform Engineering team.

## Alternatives Considered
1. Datadog — rejected: £450k/year at current scale; PCI cardholder data boundary concerns
2. New Relic — rejected: similar cost; less flexibility for custom SLO tooling
3. AWS CloudWatch — rejected: poor multi-region support; limited query language

## Trade-offs Accepted
- 2 FTE Platform Engineering investment to operate the stack
- 3-month implementation timeline vs Datadog's 2-week setup
- Less out-of-box ML anomaly detection vs Datadog

## Revisit Conditions
- If engineering organisation doubles to 300+ engineers and operational overhead
  of self-hosted stack becomes 4+ FTE, re-evaluate Datadog TCO
- If new compliance requirement makes self-hosted data mandatory (would reinforce decision)
```

---

## Key Takeaways

- Prometheus + Grafana is the right choice when you have SRE capacity and compliance constraints; Datadog is right when you need faster time-to-value and can absorb the cost
- Security tooling decisions must respect compliance mandates as hard constraints—WAF, SIEM, and pen testing are non-negotiable for PCI-scoped services; spend your decision energy on how to implement them well, not whether to implement them
- Cardinality governance is the principal engineer's most important observability cost management lever: never use unbounded labels (customer_id, transaction_id) as metric dimensions
- The security/developer-experience balance is solved by making secure paths frictionless—reusable security libraries, self-service Vault access, and automated SAST eliminate the choice between fast and secure
- Every significant tooling decision requires an ADR: future engineers need to understand the context, alternatives considered, and conditions under which the decision should be revisited
- The observability maturity model provides the roadmap: invest in the next level, not in polishing the current level or skipping ahead to Level 4 without the foundations

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "When should a principal engineer choose Datadog over a self-hosted Prometheus + Grafana + Loki stack for a payment platform?",
      "options": ["Always — Datadog is always better", "When the team needs faster time-to-value and can absorb the cost (~£450k/year at scale), and when PCI cardholder data boundary concerns can be resolved via Datadog's compliance certifications", "When the platform has more than 50 microservices", "When the engineering team has fewer than 10 people"],
      "correct": 1,
      "explanation": "The self-hosted LGTM stack requires 2 FTE Platform Engineering investment to operate but provides cost control and full data sovereignty (important when PCI cardholder data must not leave your infrastructure). Datadog provides faster setup and better out-of-box ML anomaly detection but costs ~£450k/year at scale. The right choice depends on team capacity and compliance constraints."
    },
    {
      "text": "What is cardinality governance, and why is it the principal engineer's most important observability cost management lever?",
      "options": ["Cardinality governance manages the number of dashboards; it reduces Grafana licence costs", "Cardinality governance controls the number of unique label value combinations in metrics; each combination creates a separate time series in Prometheus — using unbounded labels like customer_id or transaction_id creates millions of time series, consuming memory and degrading query performance", "Cardinality governance is about log retention policies", "Cardinality governance manages the number of alert rules"],
      "correct": 1,
      "explanation": "Each unique combination of label values in Prometheus creates a separate time series stored in memory. A metric with a customer_id label (millions of customers) multiplied by other labels creates billions of time series, exhausting Prometheus memory and making queries unusably slow. The principal engineer must enforce label cardinality budgets across all teams."
    },
    {
      "text": "What is the security/developer-experience balance problem in fintech security tooling, and how is it resolved?",
      "options": ["Security tools are expensive; the balance is managed by reducing security tool count", "Security controls create friction that developers work around, undermining security; the resolution is making secure paths frictionless through reusable security libraries, self-service Vault access, and automated SAST that catches issues before production", "Security requirements conflict with performance SLAs; the balance is managed by disabling security on hot paths", "Security reviews slow deployment; the balance is managed by reducing code review requirements"],
      "correct": 1,
      "explanation": "When security controls are burdensome (manual certificate requests, complex vault integration, slow SAST), developers find workarounds that eliminate the security benefit. The principal engineer's role is to invest in making the secure path the easy path: shared security libraries that handle JWT validation correctly, self-service Vault integration, automated SAST in CI that catches issues before merge."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Security and Observability Platform Decision Framework",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Conduct a total cost of ownership (TCO) comparison for your observability platform: calculate the annual cost of self-hosted LGTM stack (infrastructure + 2 FTE platform engineering) versus Datadog at your current scale (use metric volume, log volume, and host count); document the break-even point and the compliance considerations that affect the decision."},
    {"id": "2", "description": "Write an ADR for your observability platform choice following the MADR format: document the problem statement, three alternatives considered with pros/cons for each, the decision, known trade-offs, and specific conditions under which the decision should be revisited (e.g., team size doubling, new compliance requirement)."},
    {"id": "3", "description": "Design a cardinality governance policy for your engineering organisation: define the maximum time series per service (e.g., 10,000), write a Prometheus query that identifies the top 10 highest-cardinality metrics per service, and design a CI check that rejects new metrics with label cardinality exceeding a configurable threshold."},
    {"id": "4", "description": "Create a security tooling friction audit: map the current journey for a developer to: (1) add mTLS to a new service, (2) access a database secret, (3) add input validation to a new endpoint. For each journey, identify friction points and design a self-service automation that reduces the journey to under 5 minutes."}
  ]
}
-->
