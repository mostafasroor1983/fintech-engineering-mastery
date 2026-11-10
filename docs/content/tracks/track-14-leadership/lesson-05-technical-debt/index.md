---
id: track-14-lesson-05
title: "Managing Technical Debt — Prioritisation and Paydown"
slug: technical-debt
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 5
difficulty: principal
estimatedMinutes: 75
status: published
tags: [technical-debt, prioritisation, paydown, cruft, refactoring]
prerequisites: [track-14-lesson-04]
---

# Managing Technical Debt — Prioritisation and Paydown

> [!NOTE]
> Technical debt in financial services has a unique property: some of it is literally non-negotiable. Compliance debt (outdated encryption, missing audit logs, non-compliant data retention) is not a prioritisation question—it is a legal obligation. Understanding which debt is optional and which is mandatory changes how you have the conversation with product.

## Debt Taxonomy: Cunningham's Quadrant

Ward Cunningham, who coined the term "technical debt," described two independent dimensions:

**Reckless vs Prudent**: Did you know you were taking on debt?
- Reckless: "We don't have time to do this properly" (chosen without awareness of consequences)
- Prudent: "We must ship now; we know the risks; we'll fix it in Q3"

**Deliberate vs Inadvertent**: Did you decide to take on the debt?
- Deliberate: A conscious tradeoff to gain speed
- Inadvertent: "We didn't know what good looked like then" (learned while building)

| | Reckless | Prudent |
|-|---------|---------|
| **Deliberate** | "We don't have time for design" | "We must ship now; refactor later" |
| **Inadvertent** | "We didn't know we were doing it wrong" | "Now we know how we should have done it" |

**Principal engineer's framing**: The prudent quadrant is where most of your negotiation with product happens. The reckless quadrant is where you need to change how your team works, not just prioritise debt paydown.

---

## Technical Debt Inventory and Scoring

You cannot prioritise what you have not inventoried. Build a debt register.

### Debt Register Format

```markdown
# Technical Debt Register — Payments Platform

| ID | Description | Category | Impact | Frequency | Risk | Score | Owner | Ticket |
|----|-------------|----------|--------|-----------|------|-------|-------|--------|
| TD-001 | Settlement service uses synchronous DB polling instead of events | Architecture | 4 (causes daily incidents) | 5 (every peak period) | 3 (latency, not data loss) | 60 | @engineer-a | PAY-100 |
| TD-002 | Payment history queries use SELECT * (N+1 problem) | Performance | 3 (p99 impact) | 4 (every history page load) | 2 | 24 | @engineer-b | PAY-101 |
| TD-003 | No idempotency keys on payment submission API | Reliability | 5 (double charges possible) | 2 (rare but catastrophic) | 5 (financial loss, reg breach) | 50 | @engineer-c | PAY-102 |
| TD-004 | Encryption uses AES/CBC instead of AES/GCM | Security | 5 (non-compliant) | N/A (compliance) | 5 (PCI DSS Req 4.2) | MANDATORY | @engineer-d | PAY-103 |
| TD-005 | Test coverage: fraud module 23% | Quality | 2 (slow to change safely) | 3 (every fraud service sprint) | 2 | 12 | @engineer-e | PAY-104 |
```

### Scoring Formula

```
Score = Impact × Frequency × Risk

Impact (1-5): Effect on customers, engineers, or business when this bites us
  1 = Minor inconvenience
  3 = Meaningful customer impact or significant developer friction
  5 = Financial loss, regulatory breach, or service outage

Frequency (1-5): How often does this debt cause problems?
  1 = Rarely / only in specific edge cases
  3 = Multiple times per month
  5 = Daily / every peak period

Risk (1-5): What happens if we don't fix it?
  1 = Technical annoyance
  3 = Reliability degradation
  5 = Financial loss, security breach, or compliance violation

MANDATORY: Compliance debt that cannot be scored — it must be fixed regardless
```

This scoring is directional, not precise. Its value is making prioritisation conversations concrete rather than relying on intuition.

---

## Negotiating with Product for Tech Debt Time

The fundamental challenge: product managers optimise for feature delivery. Technical debt paydown has no immediate customer-visible benefit. You need to frame debt reduction in terms product can respond to.

### Frame 1: Reliability in terms of customer impact

```
WRONG: "We need to fix the settlement polling architecture because it's technically suboptimal."

RIGHT: "Settlement service caused 847 failed payments last month during peak periods.
        Each failed payment requires customer support contact (avg 12 minutes × £0.50/min = £6/contact).
        Last month's cost: £5,082 in support costs, plus customer churn risk.
        Fixing TD-001 eliminates this failure mode entirely. 3-week engineering investment."
```

### Frame 2: Velocity drag in terms of delivery cost

```
WRONG: "Our test coverage is 23% — we need to invest in tests."

RIGHT: "Every change to the fraud module takes 2 days of manual testing because automated coverage
        is too low to trust. We made 12 fraud module changes last quarter = 24 days of manual testing.
        That's 24 engineering-days we cannot spend on features.
        Increasing coverage to 80%: 4-week investment; payback in 2 quarters."
```

### Frame 3: Compliance debt as non-negotiable

```
"TD-004 (CBC encryption) is not a prioritisation question — it is a PCI DSS requirement.
 If we do not remediate it before our next QSA assessment (March 2027), we will fail
 our PCI audit. Failure means we cannot process card payments legally.
 This must be in Q1 planning regardless of feature roadmap."
```

### The 20% Allocation Model

One pragmatic approach: negotiate a standing allocation (20% of engineering capacity, or one sprint in five) for technical debt. This avoids the quarterly negotiation battle.

Arguments for this approach:
- Predictable: product can plan the feature roadmap around 80% delivery capacity
- Accumulation prevention: debt is paid continuously rather than allowing it to compound
- Team morale: engineers know there is allocated time for quality work, reducing the "technical debt causes burnout" spiral

---

## Prioritisation Frameworks

### Framework 1: Risk-Adjusted Priority

Sort your debt register by Score (descending). Handle MANDATORY items first regardless of score.

For scored items:
- Score > 50: address in current quarter
- Score 25-50: address in next quarter
- Score < 25: backlog; re-score quarterly

### Framework 2: Boy Scout Rule

"Leave the campsite cleaner than you found it." Every PR that touches a component improves it slightly. No dedicated debt sprint required—improvement is continuous.

```
Implementation:
  - Define "cleaner": add one test, remove one TODO, add one doc comment, fix one deprecation warning
  - Track improvement: test coverage percentage, TODO count, cyclomatic complexity
  - Code review gate: PR that makes existing metrics worse requires explicit justification

This works for: low-scoring debt (score < 25) that would never get a dedicated sprint
This does not work for: architectural debt requiring dedicated refactoring effort
```

### Framework 3: Branch by Abstraction

For large refactors (e.g., migrating from synchronous settlement to event-driven), "big bang" refactors are risky and hard to review. Branch by Abstraction enables incremental migration:

```java
// Step 1: Extract an interface (the abstraction)
public interface SettlementService {
    CompletableFuture<SettlementResult> settle(Payment payment);
}

// Step 2: Old implementation — still used by default
@Primary
@Service
public class SynchronousSettlementService implements SettlementService {
    @Override
    public CompletableFuture<SettlementResult> settle(Payment payment) {
        // Old synchronous implementation
    }
}

// Step 3: New implementation — activated via feature flag
@Service
@ConditionalOnProperty(name = "feature.event-driven-settlement", havingValue = "true")
public class EventDrivenSettlementService implements SettlementService {
    @Override
    public CompletableFuture<SettlementResult> settle(Payment payment) {
        // New event-driven implementation
    }
}

// Step 4: Deploy with feature flag OFF for most traffic
// Step 5: Gradually increase percentage via feature flag (1% → 10% → 50% → 100%)
// Step 6: Delete old implementation once confident in new one
// Step 7: Remove the abstraction if no longer needed
```

---

## Tracking Debt Reduction

You cannot improve what you do not measure. Track these metrics quarterly:

```
DORA Metrics (proxy for technical health):
  Deployment Frequency: how often can you deploy safely?
  Change Failure Rate: what % of deployments cause incidents?
  MTTR: how long to recover from incidents?

Codebase Health Metrics:
  Test coverage (% of lines/branches covered)
  Mean cyclomatic complexity per method
  Number of TODO/FIXME/HACK comments
  Number of open severity-high bugs
  Number of unresolved Semgrep/OWASP findings

Business Impact Metrics:
  Failed payment rate attributable to known technical issues
  Customer support tickets caused by known bugs
  Engineering hours spent on incidents vs features (incident-to-feature ratio)
```

---

## Technical Debt in Regulated Fintech

The compliance dimension of technical debt deserves special treatment. Unlike technical debt that slows development, compliance debt can:

- Result in PCI DSS audit failure (inability to process card payments)
- Trigger FCA enforcement action (fines, remediation requirements)
- Create personal liability for directors and senior managers (UK Senior Managers Regime)
- Cause data breach regulatory penalties (GDPR: up to 4% of global annual turnover)

### Compliance Debt Categories

```
NEVER DEFER:
  - Encryption standards below minimum requirement (PCI DSS Req 3.4, 4.2)
  - Missing audit logs for cardholder data operations
  - Unpatched critical CVEs in systems touching card data
  - Data retained beyond the mandated retention period

DEFER WITHIN DEFINED WINDOW:
  - New compliance requirements with implementation periods (DORA: 12-24 month transition)
  - Regulatory guidance updates (usually 6-12 months to implement)
  - Annual penetration test findings: Critical = 24h, High = 7 days

TRACK AND REPORT:
  - Medium-severity compliance findings: document, assign owner, 30-day SLA
  - Maintain a compliance debt register separate from technical debt register
  - Report compliance debt register to CISO and CTO quarterly
```

---

## Key Takeaways

- Use Cunningham's Quadrant to classify debt: reckless deliberate debt indicates a team culture problem; prudent deliberate debt is normal and manageable
- Score debt by Impact × Frequency × Risk to have objective prioritisation conversations with product—intuition is not persuasive at planning meetings
- Frame debt reduction in product terms: customer impact, support cost, delivery velocity drag—not technical purity
- Compliance debt is not optional: encryption standards, audit logs, and regulatory patches have mandated timelines that cannot be treated as normal backlog items
- The 20% standing allocation eliminates the quarterly negotiation fight and prevents debt accumulation
- Branch by Abstraction is the safe path for large refactors: introduce an abstraction, build the new implementation behind a feature flag, migrate gradually, delete the old code

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment service team deploys an encryption change because PCI DSS requires AES/GCM instead of AES/CBC. What type of technical debt is this?",
      "options": ["Prudent deliberate debt — a known trade-off made for speed", "Reckless inadvertent debt — the team didn't know they were doing it wrong", "Compliance debt — it must be fixed regardless of product prioritisation", "Low-scoring debt — it can be deferred to the next quarter"],
      "correct": 2,
      "explanation": "Encryption below the PCI DSS minimum standard is compliance debt — it has a mandated remediation timeline tied to legal obligations. It is categorized as MANDATORY in the debt register and cannot be treated as a normal backlog item subject to product prioritisation. Failure to remediate can cause PCI DSS audit failure and loss of ability to process card payments."
    },
    {
      "text": "A team calculates a debt score using Impact × Frequency × Risk. Item TD-003 (no idempotency keys) scores: Impact=5 (double charges), Frequency=2 (rare), Risk=5. What is the score and what priority does it warrant?",
      "options": ["Score=12, low priority (backlog)", "Score=50, address in next quarter", "Score=50, address in current quarter", "Score=25, address in next quarter"],
      "correct": 2,
      "explanation": "Score = 5 × 2 × 5 = 50. The scoring framework classifies scores > 50 as 'address in current quarter' and 25-50 as 'address in next quarter.' A score of exactly 50 falls in the 'next quarter' range, but the Risk=5 (financial loss, regulatory breach) means this warrants urgent attention regardless of the numeric score."
    },
    {
      "text": "Why is 'Branch by Abstraction' preferred over a 'big bang' refactor for migrating from synchronous to event-driven settlement?",
      "options": ["Big bang refactors require more code review approvals", "Branch by Abstraction allows incremental migration behind a feature flag, enabling gradual rollout, quick rollback, and continuous production deployment", "Big bang refactors cannot be tested in staging environments", "Branch by Abstraction generates less git diff per PR"],
      "correct": 1,
      "explanation": "Big bang refactors are risky (all-or-nothing deployment), hard to review (massive PR), and difficult to roll back. Branch by Abstraction introduces an interface, builds both implementations, and migrates traffic gradually via feature flag. Each step is independently deployable, testable, and reversible. This reduces the blast radius of migration errors significantly."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Technical Debt Register and Paydown Strategy for a Payment Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Build a Technical Debt Register for a payment service with at least 8 items covering architecture, security, performance, reliability, and compliance categories. Score each item using Impact × Frequency × Risk (1-5 each), mark compliance items as MANDATORY, and sort by score. At least 2 items must be MANDATORY compliance debt."},
    {"id": "2", "description": "Write three product-facing justifications for the top 3 scored debt items. Each justification must include: specific customer impact (not technical description), quantified cost (support hours × rate, failed payments × value, or engineering-days lost), and ROI calculation for the remediation investment."},
    {"id": "3", "description": "Implement a Branch by Abstraction migration plan for replacing a synchronous payment status polling service with an event-driven one: define the interface, create both implementations, add @ConditionalOnProperty switching, and write a Prometheus metric that tracks what percentage of traffic is using the new implementation."},
    {"id": "4", "description": "Design a debt tracking dashboard using three DORA metrics (deployment frequency, change failure rate, MTTR) and three codebase health metrics (test coverage %, TODO count, cyclomatic complexity). Specify alert thresholds for each metric that would indicate the debt register needs immediate re-prioritization."}
  ]
}
-->

