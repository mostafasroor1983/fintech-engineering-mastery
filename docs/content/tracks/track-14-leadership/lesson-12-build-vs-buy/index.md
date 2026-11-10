---
id: track-14-lesson-12
title: "Build vs Buy vs Open Source — The Principal Decision"
slug: build-vs-buy
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 12
difficulty: principal
estimatedMinutes: 70
status: published
tags: [build-vs-buy, open-source, make-or-buy, vendor, total-cost]
prerequisites: [track-14-lesson-11]
---

# Build vs Buy vs Open Source — The Principal Decision

> [!NOTE]
> The build vs buy decision is one of the most consequential a principal engineer makes. Build the wrong thing and you spend years maintaining it instead of shipping features. Buy the wrong thing and you have vendor lock-in, compliance problems, or a capability gap that the vendor will never fill. The framework in this lesson does not give you the answer—it gives you the questions to ask.

## The Three-Way Decision

Most framing of this decision is binary (build or buy). In practice, there are three options, each with a distinct trade-off profile:

**Build**: Engineering team designs, develops, and maintains the solution.
- Maximum control and customisation
- Full transparency (you own the code, the data)
- Highest initial investment; ongoing maintenance burden
- Competitive advantage if it's genuinely differentiated

**Buy (commercial)**: Purchase a commercial software product or SaaS.
- Fastest time to value
- Vendor dependency (pricing, roadmap, continuity)
- Compliance and data residency considerations
- Support contract provides escalation path

**Open source**: Adopt an open-source solution and self-host.
- No licensing cost; full access to source
- No commercial support (community only, unless enterprise edition purchased)
- Security patching responsibility rests with you
- May require significant engineering investment to operate at scale

---

## Total Cost of Ownership Analysis

The most common mistake in build vs buy decisions is comparing vendor licensing cost to engineering cost alone. TCO analysis includes:

### TCO Components

```
BUILD TCO:
  Initial development cost
    × senior engineer cost × months to build × overhead factor (1.3-1.5x for recruiting, management, benefits)
  
  Ongoing maintenance
    × engineers required to maintain × months per year
    (rule of thumb: 20-30% of initial development cost per year)
  
  Opportunity cost
    What else could those engineers be building?
    Revenue impact of not building that instead?
  
  Infrastructure cost
    Compute, storage, networking, monitoring for self-hosted solution

BUY TCO:
  Licensing cost
    Annual fee (SaaS) or one-time license + annual maintenance
  
  Integration cost
    Engineering time to integrate with your systems (typically 2-6 weeks)
  
  Customisation cost
    Professional services, custom development to meet your requirements
  
  Operations cost
    Internal staff required to manage the vendor relationship
  
  Migration/exit cost
    Effort to migrate away if vendor fails, raises prices, or changes direction
    (Typically 3-12 months of engineering effort for a deeply integrated vendor)
  
  Compliance cost
    Vendor security review, annual penetration test of vendor, contract negotiation

OPEN SOURCE TCO:
  Integration cost (similar to Buy)
  
  Engineering cost to operate
    Platform team effort to run, monitor, upgrade (Kafka, for example, needs an operator)
  
  Engineering cost to customise
    If the open-source solution needs modification for your requirements
  
  Security patching responsibility
    You own patching; CVE response time depends on your process
  
  No commercial support
    P1 incident at 2am: open-source community forum vs vendor support line
```

---

## The Core vs Context Distinction

Geoffrey Moore's "core vs context" distinction is the most useful mental model for build vs buy:

**Core**: Activities that differentiate your business from competitors. What your company does that competitors cannot easily replicate.

**Context**: Everything else—necessary activities that do not differentiate you.

**The principle**: Build your core. Buy (or use open source for) context.

### Applying Core vs Context to Fintech

| Capability | Core or Context? | Decision |
|-----------|-----------------|---------|
| Fraud scoring rules | Core — your fraud model is a competitive advantage | Build |
| Payment gateway (card acquiring) | Context — commodity; Stripe/Adyen solve this | Buy |
| KYC/AML identity verification | Context — but heavily regulated; customisation needed | Buy + customise |
| Double-entry ledger | Core — your ledger logic reflects your product's rules | Build |
| Email/SMS notifications | Context — commodity | Buy (Twilio, AWS SES) |
| Observability platform | Context — monitoring is not your business | Buy (Datadog) or Open Source (Prometheus) |
| Encryption key management | Context — but security-critical | Open Source + HSM (Vault + Thales) |
| Credit risk scoring model | Core — differentiates your lending product | Build |
| Credit bureau data integration | Context | Buy (Experian, Equifax integration) |

---

## Vendor Evaluation Criteria for Financial Services

When buying, evaluate vendors against these criteria in addition to functional fit:

### Security and Compliance

```
SECURITY EVALUATION CHECKLIST:
  [ ] SOC 2 Type 2 report available and current (< 12 months)
  [ ] ISO 27001 certification or equivalent
  [ ] Annual penetration test results available under NDA
  [ ] Responsible disclosure/bug bounty program
  [ ] CVE response time for critical vulnerabilities (target: < 48 hours)
  [ ] Data encryption: AES-256 at rest, TLS 1.3 in transit
  [ ] Data residency: Can data be restricted to your required jurisdiction (EU, UK)?

PCI DSS SPECIFIC:
  [ ] Is vendor in-scope for your PCI DSS environment?
  [ ] If yes: QSA-reviewed SAQ or ROC available?
  [ ] If processing card data: PCI DSS Level 1 service provider?

GDPR/UK GDPR:
  [ ] Data Processing Agreement (DPA) available
  [ ] Sub-processors disclosed
  [ ] Data subject request handling procedure
  [ ] Standard Contractual Clauses for data transfers outside EEA
```

### SLA and Support

```
QUESTIONS FOR VENDOR:
  What is the uptime SLA? (Target: 99.9% for critical payment systems)
  What is the support model for P1 incidents? (24/7 phone? Email only?)
  What is the contractual SLA for P1 response time?
  What compensation if SLA is breached? (Service credits? Actual damages?)
  What is the vendor's incident notification obligation to customers?
```

### Exit Strategy

```
BEFORE SIGNING:
  Can you export your data in a standard format? In what timeframe?
  What happens to your data if the vendor is acquired or goes bankrupt?
  What are the contractual lock-in terms? (Minimum commitment, auto-renewal)
  What is the realistic migration effort if you need to leave?
  Have you built data portability requirements into the contract?
```

---

## Open Source Risk Assessment

Open source is not free—it is a different cost structure.

### High-risk open source indicators

**Single maintainer**: If one person maintains the project and they disappear, the project stalls. Check: how many contributors? How many recent releases? How many open PRs?

**Slow CVE response**: Check the CVE history (NVD database). How quickly were critical vulnerabilities patched? Log4Shell was patched within days by the Log4j team—exemplary. Some projects take weeks.

**Aggressive license**: Check the license carefully. AGPL, SSPL, and Business Source License have restrictions that may prevent commercial use or require open-sourcing your modifications. Apache 2.0 and MIT are permissive.

**No enterprise edition**: For infrastructure components (databases, queues), enterprise editions provide commercial support contracts. Without these, your P1 support path is a public GitHub issue.

### Open Source Security Process

```java
// Every open-source dependency must be tracked and scanned
// pom.xml — OWASP Dependency Check integration
<plugin>
    <groupId>org.owasp</groupId>
    <artifactId>dependency-check-maven</artifactId>
    <configuration>
        <failBuildOnCVSS>7</failBuildOnCVSS>  <!-- Block builds with High/Critical CVEs -->
    </configuration>
</plugin>
```

```
OPEN SOURCE LIFECYCLE PROCESS:
  Adoption: Principal engineer approval required for new open-source dependencies
  Tracking: All dependencies in SBOM (Software Bill of Materials)
  Monitoring: Daily CVE scan via Snyk or OWASP Dependency Check
  Patching: Critical CVE < 48 hours, High CVE < 7 days (PCI DSS requirement)
  Retirement: Deprecated or abandoned dependencies replaced within 90 days
```

---

## Common Fintech Build vs Buy Decisions

**Payment Gateway: Buy**
Building a card payment gateway requires PCI DSS Level 1 certification (3-18 months), direct acquiring relationships with Visa/Mastercard, and significant fraud management infrastructure. This is almost never worth building. Stripe, Adyen, Braintree, and Checkout.com are the standard options.

**Fraud Rules Engine: Build the core, buy the data**
Your fraud rules are your competitive advantage—they reflect your customer base, risk appetite, and product. Build the rules engine. But the data signals (device fingerprinting, velocity checks across networks, identity verification) can be augmented with vendor data (Featurespace, ThreatMetrix, LexisNexis).

**KYC/AML: Buy with customisation**
Building a KYC pipeline from scratch—document verification, liveness detection, PEP/sanctions screening, adverse media—is expensive and requires deep expertise in a heavily regulated domain. Buy a platform (Jumio, Onfido, Trulioo) but customise the customer journey and risk decisioning layer.

**Double-Entry Ledger: Build**
Your ledger is the financial heart of your product. Its data model reflects your specific product constructs (wallets, accounts, sub-accounts, holds). Generic ledger software rarely fits well. Build with PostgreSQL and your own application layer. The technical complexity is manageable; the business fit is non-negotiable.

**Observability: Open Source (Prometheus/Grafana) or Buy (Datadog)**
Both are legitimate choices depending on your team's SRE capacity and compliance requirements (see Lesson 20).

---

## Decision Record: Build vs Buy

Every significant build vs buy decision should be documented as an ADR:

```markdown
# ADR-025: KYC Platform — Buy (Onfido) with Custom Decisioning Layer

Status: Accepted
Date: 2026-09-15
Deciders: Principal Engineer, Head of Product (Identity), Head of Compliance

## Decision
Buy Onfido for document verification and liveness detection.
Build custom risk decisioning layer on top of Onfido's API.

## Rationale
Building document verification and liveness detection internally would require:
  - 6-12 months of ML engineering to match Onfido's accuracy
  - Ongoing maintenance of the ML model as fraud patterns evolve
  - Regulatory expertise to stay current with global KYC requirements
  
This is not core differentiation — Onfido solves it better than we would.

What is core differentiation: our risk decisioning logic (how we combine Onfido's
score with our own signals — transaction history, device, etc.). We build that.

## Total Cost Analysis
Build from scratch: £1.8M (12 months × 3 senior ML engineers × £150k)
Onfido: £180k/year + £60k integration + £40k/year internal operations
         = £280k year 1, £220k year 2+
5-year TCO Build: £1.8M initial + £360k maintenance = £2.16M
5-year TCO Buy:   £280k + £220k × 4 = £1.16M

Buy is cheaper AND higher quality AND faster. Clear decision.
```

---

## Key Takeaways

- Build your core (what differentiates your business), buy or use open source for context (everything else)—in fintech: build fraud rules and ledger logic; buy payment gateway and KYC document verification
- TCO analysis must include: licensing, integration, operations, opportunity cost, and exit cost—licensing cost alone is misleading
- Vendor evaluation for financial services requires: SOC 2 Type 2, PCI DSS certification (where relevant), data residency guarantees, 24/7 P1 support, and an explicit exit strategy in the contract
- Open source is not free: CVE patching responsibility, operational expertise, and no commercial support are real costs
- Document every significant build vs buy decision as an ADR: it prevents relitigating the decision and provides context for future engineers who inherit the choice
- KYC/AML: buy the document verification; build the risk decisioning. Payment gateway: always buy. Ledger: build. Observability: depends on SRE capacity and compliance requirements

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A startup fintech is evaluating whether to build their own card payment gateway or use Stripe. Building would require PCI DSS Level 1 certification and direct card network relationships. What does the core vs context framework say about this decision?",
      "options": ["Build — control over payment processing is core competitive differentiation", "Build — the cost of Stripe's fees over time exceeds the build cost", "Buy — card payment gateway processing is context (commodity), not core; Stripe/Adyen solve it better than a startup could build in 12-18 months; build effort should go to the actual core differentiation (fraud rules, product experience)", "Buy — but only until the company reaches £10M in annual payment volume"],
      "correct": 2,
      "explanation": "Card payment gateway processing is context, not core. Building a Level 1 PCI DSS certified gateway requires 3-18 months, direct acquiring relationships with Visa/Mastercard, and significant fraud management infrastructure — none of which differentiates the startup's product. The startup's core differentiation is its fraud model, risk decisioning, or product experience. The build vs buy rule is: build your core, buy context. Building context instead of core wastes engineering capacity on commodity problems."
    },
    {
      "text": "A team compares building an internal fraud rules engine (£400k build cost, £80k/year maintenance) versus buying a SaaS fraud platform (£120k/year license). After 3 years, the buy option costs £360k versus £640k to build. The team chooses to buy. Is this the right decision based on the build vs buy framework?",
      "options": ["Yes — the lower TCO over 3 years clearly favours buying", "Not necessarily — fraud scoring rules are core competitive advantage (they reflect your customer base and risk appetite); if the SaaS platform cannot be customised to your specific rules, buying a commodity fraud solution concedes competitive advantage even if it is cheaper", "Yes — the opportunity cost of building (engineers not working on features) always favours buying", "No — open source fraud tools should always be evaluated before commercial SaaS"],
      "correct": 1,
      "explanation": "TCO is one dimension; core vs context is another. Fraud rules reflect your specific customer base, product risk appetite, and fraud patterns — this is core competitive differentiation. A generic SaaS fraud platform applies the same rules to all customers. If the SaaS cannot be sufficiently customised, buying it cedes competitive advantage. The recommended model is: buy the data signals (device fingerprinting, velocity checks across networks) but build the decisioning engine that reflects your specific risk model."
    },
    {
      "text": "A team is evaluating an open-source message queue library. It was last released 18 months ago, has one primary maintainer, and had two critical CVEs in the past year (both patched within 3 weeks). What risk category does this represent?",
      "options": ["Low risk — the CVEs were patched quickly, demonstrating good security responsiveness", "Medium-to-high risk — single maintainer is a bus factor risk (project stalls if maintainer disappears); but the CVE patch speed is a positive signal worth noting in the evaluation", "Low risk — 18 months without a release indicates stability", "High risk — any CVEs in the past year disqualify the library for financial services use"],
      "correct": 1,
      "explanation": "Open source risk assessment considers multiple dimensions simultaneously. Single maintainer is a significant bus factor risk — if the maintainer disappears, the project stalls and security vulnerabilities go unpatched. This alone moves the risk rating toward Hold for infrastructure components. However, quick CVE patching (within weeks, not months) is a positive signal about security culture. The correct assessment is medium-to-high risk: document the single-maintainer concern explicitly in the ADR and consider whether an enterprise edition with commercial support exists."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build vs Buy Decision Framework for a Fintech Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Conduct a complete TCO analysis for a build vs buy decision on an internal KYC/AML platform. Build scenario: 4 senior engineers × 9 months × £150k annual fully-loaded cost + 25% ongoing maintenance. Buy scenario: Onfido at £200k/year license + £80k integration cost + £50k/year internal operations. Include opportunity cost (the build engineers could build a core fraud feature estimated at £500k revenue impact). Calculate 3-year and 5-year TCO for both options, identify all TCO components, and produce a recommendation with rationale."},
    {"id": "2", "description": "Apply the core vs context framework to a fintech platform considering 8 capabilities: (1) credit risk scoring model, (2) SMS/email notification delivery, (3) double-entry accounting ledger, (4) card payment acquiring, (5) identity document verification, (6) payment fraud rules engine, (7) observability and monitoring, (8) encryption key management. For each, classify as core or context, recommend build/buy/open-source, and provide a one-sentence fintech-specific rationale."},
    {"id": "3", "description": "Complete a vendor security evaluation for a hypothetical SaaS payment orchestration platform. Using the fintech vendor checklist from the lesson, design a security questionnaire (at least 15 questions) covering: SOC 2 and PCI DSS certification, CVE response SLA, data residency for EU customers, P1 incident support model, GDPR Data Processing Agreement, and exit data portability. For each question, specify what a passing vs failing answer looks like and what the consequence of a failure is (block vendor, require mitigation, or note risk)."},
    {"id": "4", "description": "Write a complete ADR for a build vs buy decision on a double-entry accounting ledger. The ADR must evaluate three options: (1) build on PostgreSQL with custom application layer, (2) buy a commercial ledger platform (Tigerbeetle, Ledger.io), (3) use an open-source ledger library. Include: the decision drivers specific to your payment product's ledger requirements, TCO analysis for each option, compliance assessment (PCI DSS scope, audit trail requirements), the final decision with explicit rationale and negative consequences acknowledged."}
  ]
}
-->
