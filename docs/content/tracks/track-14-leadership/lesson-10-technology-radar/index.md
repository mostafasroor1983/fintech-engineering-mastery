---
id: track-14-lesson-10
title: "Technology Radar — Assess, Trial, Adopt, Hold"
slug: technology-radar
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 10
difficulty: principal
estimatedMinutes: 70
status: published
tags: [technology-radar, ThoughtWorks, assess, adopt, hold]
prerequisites: [track-14-lesson-09]
---

# Technology Radar — Assess, Trial, Adopt, Hold

> [!NOTE]
> Without a technology radar, technology decisions are made individually by each team, producing fragmentation: 12 teams using 8 different HTTP clients, 4 different testing frameworks, and 3 different approaches to secrets management. The radar is the principal engineer's instrument for creating coherence without uniformity.

## The ThoughtWorks Technology Radar Model

ThoughtWorks publishes a Technology Radar biannually. The model is worth adopting for your organisation:

**Four quadrants** (what type of technology):
- **Techniques**: Development practices, processes (e.g., Feature Flags, Event Sourcing, Chaos Engineering)
- **Tools**: Software tools and utilities (e.g., Semgrep, Grafana, OpenTelemetry)
- **Platforms**: Runtime infrastructure (e.g., Kubernetes, Kafka, AWS EKS)
- **Languages & Frameworks**: Programming languages and frameworks (e.g., Java 21, Spring Boot, Resilience4j)

**Four rings** (what your organisation should do with it):
- **Adopt**: Industry default; use it. The standard for your context.
- **Trial**: Worth using in projects where the team can handle the extra uncertainty.
- **Assess**: Worth investigating; track it; don't yet commit.
- **Hold**: Not recommended for new use; existing use should migrate away.

---

## Running a Team/Org Radar

The ThoughtWorks radar is their opinion. Your organisation's radar is your opinion, based on your specific context, compliance constraints, and engineering capabilities.

### Process: Semi-Annual Radar Cadence

```
MONTH 1 (Collection):
  Announcement: "We're updating the technology radar. Submit nominations."
  Open period (2 weeks):
    Engineers nominate items via form or Confluence page
    Each nomination includes:
      - Technology name and category
      - Proposed ring (Assess/Trial/Adopt/Hold)
      - Brief rationale (why this ring?)
      - Your team's experience with it (if any)

MONTH 2 (Review Session):
  Duration: 3 hours (block it properly)
  Participants: Principal engineers, senior architects, security lead
  Process:
    Group nominations by quadrant
    For each nomination: 5-10 minutes discussion
    Voting: simple majority for ring placement (PE/architects vote)
    Document rationale for each placement

MONTH 3 (Publication and Communication):
  Publish radar (interactive, not just a document)
  Present at engineering all-hands: highlights, changes from last radar
  Team leads: review radar with their teams; identify gaps vs current practices
```

### Facilitation Tips

**Start with the easy ones**: There is usually broad agreement on obvious items (Kubernetes: Adopt; ZooKeeper: Hold). Build momentum with these before the contentious ones.

**Distinguish "good technology" from "good for us"**: React Native might be excellent technology. If your mobile team is 2 engineers with no React Native experience, it's Assess, not Adopt.

**Apply compliance lens explicitly**: For financial services, a technology that does not support your audit log requirements or cannot run in your PCI environment may be Hold regardless of technical merit.

---

## Evaluation Criteria for Fintech

Fintech-specific evaluation criteria that modify the standard ThoughtWorks model:

### Compliance Fit

Can this technology be used in a PCI DSS environment? Does it support the data residency requirements of your regulatory jurisdiction (EU data must stay in EU)?

```
COMPLIANCE EVALUATION QUESTIONS:
  Does this technology handle, store, or transmit payment card data?
    YES → PCI DSS scope; must meet PCI DSS requirements
    NO  → Standard evaluation

  Does it process personal data of EU/UK residents?
    YES → GDPR/UK GDPR considerations; data residency requirements
    NO  → Standard evaluation

  Does it require internet access from production systems?
    YES → WAF/egress filtering requirements; security review required
    NO  → Standard evaluation
```

### Security Posture

What is the vulnerability history of this technology? Is it actively maintained? Does it have a responsible disclosure program?

```
LOG4SHELL (CVE-2021-44228) LESSON:
  Log4j was widely used and trusted. The vulnerability was catastrophic.
  
  Evaluation questions:
  - What is the CVSS history for this library over the last 2 years?
  - How quickly are critical CVEs patched? (Days? Weeks?)
  - Is there an active security advisory program?
  - Does the library parse or process external data? (Higher attack surface)
```

### Operational Maturity

Does your team have the capability to operate this technology? A technically superior tool that your team cannot operate reliably is worse than a good-enough tool they know well.

---

## Example Fintech Technology Radar Entries

```
TECHNIQUES
─────────────────────────────────────────────────────────────
ADOPT:
  SLO-Based Alerting (burn rate alerting)
    Why: Industry standard; aligns alerting with business impact;
         eliminates alert fatigue better than threshold-based alerting
    Ref: Google SRE Workbook; our implementation in track-13-lesson-07

  Feature Flags for Deployment Risk Reduction
    Why: Enables incremental rollout; decouples deploy from release;
         critical for payment systems where bad deploys are costly
    Ref: LaunchDarkly or homegrown; pattern is well-established

  Zero-Trust Service Identity (SPIFFE/SPIRE)
    Why: PCI DSS Requirement 8.6 (service accounts); prevents lateral movement;
         eliminates shared credentials between services

TRIAL:
  Event Sourcing for Ledger Services
    Why: Natural fit for accounting (immutable audit trail);
         emerging pattern in fintech; complexity is real
    Risk: Eventual consistency model requires careful design;
          CQRS adds complexity; team training required

  Virtual Threads (Java 21 Project Loom)
    Why: Significantly improves throughput for I/O-bound services without
         reactive programming model complexity; production-ready in Java 21
    Risk: Some libraries not virtual-thread-safe; emerging ecosystem support

ASSESS:
  eBPF-Based Observability (Cilium, Hubble)
    Why: Zero-instrumentation observability; Kubernetes-native network visibility
    Risk: Requires Kernel 5.4+; operational complexity; emerging tooling
    Wait for: More operational maturity; better documentation

  Rust for Payment-Critical Services
    Why: Memory safety without GC pauses; attractive for latency-sensitive payment processing
    Risk: Team expertise (we have 1 Rust engineer); ecosystem maturity vs Java

HOLD:
  Reactive Programming (WebFlux/Reactor) for new services
    Why: Complexity exceeds benefit for most payment services;
         Virtual Threads (Java 21) achieve similar throughput benefits
         with far simpler programming model
    Existing services: continue operating; don't migrate unless actively causing problems
    New services: use Virtual Threads + standard Spring MVC instead

  Apache ZooKeeper for new use cases
    Why: Kafka KRaft mode eliminates ZooKeeper dependency;
         etcd better for other coordination use cases;
         operational complexity without commensurate benefit
    Existing use: migrate to KRaft on next major Kafka upgrade

PLATFORMS
─────────────────────────────────────────────────────────────
ADOPT:
  Apache Kafka for Event Streaming
    PCI note: Topic-level ACLs required; audit logging enabled;
              no PAN in event payloads without field-level encryption
    Status: Our standard event backbone; use for all new event-driven services

  HashiCorp Vault for Secrets Management
    Status: Our standard; mandatory for all production services
    Required: Dynamic credentials for database access; transit encryption for PAN

  Kubernetes (EKS/GKE) for Container Orchestration
    Status: Our standard compute platform

HOLD:
  AWS Lambda for Payment Processing
    Why: Cold start latency incompatible with payment SLO (< 500ms p99);
         limited local testing story; cold starts affect reliability metrics
    Acceptable for: Non-payment workloads (batch reporting, notifications)
    Not for: Payment authorisation, real-time fraud scoring, settlement

LANGUAGES & FRAMEWORKS
─────────────────────────────────────────────────────────────
ADOPT:
  Java 21 LTS with Virtual Threads
    Why: LTS release; production-ready; Virtual Threads mature in this version
    Migration: Java 17 services should migrate by end of 2027

  Spring Boot 3.x
    Why: Team expertise; native image support; Spring Security 6
    Note: Spring Boot 2.x reaches EOL; migrate existing services

  Resilience4j 2.x for circuit breaking
    Why: Replaces Hystrix (EOL); native integration with Spring Boot 3; Micrometer metrics

HOLD:
  Hystrix (Netflix)
    Why: EOL since 2018; no security patches; migrate to Resilience4j
    Migration required by: End of Q1 2027

  Spring Boot 2.x
    Why: EOL November 2024; no security patches
    Migration required by: Immediate for all PCI-scoped services
```

---

## Publishing and Communicating the Radar

A radar published and never referenced is wasted effort.

**Interactive format**: ThoughtWorks publishes their radar as an interactive SVG. Use `radar.thoughtworks.com`'s build tool or `aoe/radar-generator` to create the same for your organisation.

**Linkable ring definitions**: Each entry in your radar should link to your internal documentation: why this ring, what alternatives were considered, compliance considerations.

**Onboarding integration**: New engineers read the radar as part of onboarding. The radar tells them "this is what we use and why"—invaluable context.

**Review in architecture reviews**: When a new service proposes a technology, the first question is: "Is this on the radar? What ring?" Technologies in HOLD or not on the radar require explicit justification.

---

## Hold Decisions and Legacy Tech Sunsetting

The Hold ring is actionable—it means "migrate away from this." But migration requires a plan.

```markdown
# Sunsetting Plan: Spring Boot 2.x → Spring Boot 3.x

BACKGROUND: Spring Boot 2.x reached EOL November 2024.
No security patches available. PCI DSS Requirement 6.3.3 mandates patching.

SCOPE:
  Services on Spring Boot 2.x: 14 services (audit: October 2026)
  PCI-scoped services: 6 services (MUST migrate; compliance risk)
  Non-PCI services: 8 services (SHOULD migrate; technical debt risk)

APPROACH:
  NOT a big-bang migration. Each team migrates their own services.
  Spring provides a migration guide. Breaking changes are documented.

TIMELINE:
  Q1 2027: All PCI-scoped services migrated (mandatory; compliance)
  Q2 2027: 50% of non-PCI services migrated
  Q3 2027: All services migrated; Spring Boot 2.x fully removed from inventory

SUPPORT:
  Platform team runs 2 workshops on common migration issues
  ADR published: common patterns for migrating from Spring Boot 2 to 3
  Principal engineer available for 30-minute consulting sessions

SUCCESS CRITERIA:
  Zero Spring Boot 2.x services in production by end of Q3 2027
  Measured by: monthly service inventory audit
```

---

## Key Takeaways

- The technology radar creates coherence without uniformity: teams know what to use by default (Adopt), what to explore carefully (Trial/Assess), and what to avoid (Hold)
- Run the radar semi-annually; collect nominations broadly but make placement decisions with a small group of principal engineers and architects
- Fintech adds compliance and security posture as explicit evaluation criteria: a technology that cannot satisfy PCI DSS requirements is Hold regardless of technical merit
- Hold decisions are actionable, not just advisory—each Hold item needs a migration plan with timeline, owner, and success criteria
- Publish the radar in an interactive format and reference it in architecture reviews, onboarding, and design discussions—a radar that nobody reads is expensive documentation
- Virtual Threads (Java 21) in Adopt and reactive programming in Hold is a defensible position for fintech: simpler programming model achieves comparable throughput for I/O-bound payment services

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A new NoSQL database with strong horizontal scaling properties and excellent developer reviews has been nominated for the technology radar. It does not support data residency restrictions — all data is distributed globally across cloud regions. Where does it belong on a fintech team's radar?",
      "options": ["Adopt — the scaling benefits outweigh the compliance concerns for most services", "Trial — test it on non-sensitive workloads first", "Hold — a technology that cannot satisfy data residency requirements for EU/UK regulated services is not suitable regardless of technical merit", "Assess — the compliance issue may be resolved in future versions"],
      "correct": 2,
      "explanation": "For fintech teams operating in regulated jurisdictions, data residency is a compliance constraint, not a preference. GDPR and PCI DSS require that personal data and cardholder data can be restricted to specific jurisdictions. A technology that cannot satisfy this requirement must be placed in Hold regardless of its technical merits. Compliance fit is an explicit evaluation criterion that can override technical evaluation."
    },
    {
      "text": "A team proposes using Spring WebFlux (reactive programming) for a new payment authorisation service. The organisation's technology radar places reactive programming in Hold for new services. What is the correct principal engineer response?",
      "options": ["Approve the choice — the team knows their service best", "Allow it as a trial — the Hold placement may be outdated", "Require explicit justification for deviating from the radar Hold placement; the team must demonstrate why standard alternatives (Virtual Threads + Spring MVC) are inadequate for their specific requirements", "Escalate to the ARB immediately without engaging the team"],
      "correct": 2,
      "explanation": "The technology radar creates coherence, not uniformity. Teams may deviate from radar placements but must provide explicit justification. For a Hold item, the team must show that the standard alternative is inadequate for their specific case. Requiring justification prevents radar drift (gradual erosion of standards without deliberate decisions) while still allowing legitimate exceptions. The ARB process may be appropriate for a full deviation review."
    },
    {
      "text": "What is the purpose of the Hold ring in a technology radar, and what must accompany a Hold placement?",
      "options": ["Hold means the technology is banned; teams must remove it immediately", "Hold means the technology is not recommended for new use; existing use should migrate away; each Hold item requires a migration plan with timeline, owner, and success criteria", "Hold is advisory only; teams are free to continue using Hold technologies indefinitely", "Hold applies to external dependencies but not to internal platforms"],
      "correct": 1,
      "explanation": "Hold is actionable, not just advisory. It means 'do not start new use; migrate away from existing use.' But migration requires a plan — without one, Hold items accumulate indefinitely without progress. Each Hold item in a mature radar has a sunsetting plan: which services are affected, the migration approach (not big-bang), a timeline with milestones, and success criteria (e.g., zero Spring Boot 2.x services by Q3 2027)."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Technology Radar Build and Communication for a Fintech Engineering Organisation",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Build a technology radar for a fintech payment platform with at least 16 entries across all four quadrants (Techniques, Tools, Platforms, Languages & Frameworks) and all four rings (Adopt, Trial, Assess, Hold). Every entry must include: the ring placement, a one-sentence rationale, and a fintech-specific note (compliance fit, security posture, or operational maturity consideration). Include at least 2 Hold entries with migration requirements."},
    {"id": "2", "description": "Design the semi-annual radar update process for a 200-engineer fintech engineering organisation. Specify: the nomination format (what information engineers must provide), the review session agenda and facilitation approach for reaching consensus on contentious items, the voting mechanism, and the communication plan (how the radar is published, presented, and integrated into team onboarding and architecture reviews)."},
    {"id": "3", "description": "Write a complete sunsetting plan for migrating 18 services from Java 17 to Java 21 LTS. The plan must include: scope breakdown (PCI-scoped vs non-PCI), migration approach, specific timeline with quarterly milestones, support mechanisms (workshops, office hours, documented breaking changes), compliance rationale (why Java 17 becomes a risk as it approaches EOL), and success criteria measured by monthly service inventory audit."},
    {"id": "4", "description": "Evaluate three hypothetical technology nominations using the fintech evaluation framework: (a) an eBPF-based observability tool requiring Linux kernel 5.4+ with no PCI DSS documentation, (b) a Rust-based payment processing library with active security advisory program and 2 maintainers, and (c) a SaaS secrets management vendor with SOC 2 Type 2 and EU data residency but requiring internet egress from production systems. For each, produce a radar placement recommendation with full compliance and security evaluation."}
  ]
}
-->
