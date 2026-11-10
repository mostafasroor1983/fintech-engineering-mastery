---
id: track-14-lesson-04
title: "ADRs in Practice — Building an Architecture Decision Culture"
slug: adr-practice
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 4
difficulty: principal
estimatedMinutes: 75
status: published
tags: [ADR, architecture-decision, culture, documentation, MADR, RFC, governance]
prerequisites: [track-14-lesson-03]
---

# ADRs in Practice — Building an Architecture Decision Culture

> [!NOTE]
> Architecture Decision Records are the archaeology of your codebase. Without them, every new engineer—and every returning engineer who has forgotten—makes the same costly explorations, reaches the same conclusions, and sometimes makes the same expensive mistakes that you already paid for once. At principal level, your ability to create and sustain a decision-recording culture is as important as the technical quality of your decisions.

## RFC vs ADR: Different Tools for Different Jobs

RFC and ADR are complementary, not competing:

| | RFC (Request for Comments) | ADR (Architecture Decision Record) |
|-|---------------------------|-------------------------------------|
| Purpose | Propose and discuss a decision | Record a decision already made |
| Timing | Before the decision | After (or at time of) the decision |
| Format | Proposal document with alternatives | Concise record of decision and rationale |
| Audience | Decision participants | Future readers (new team members, future self) |
| Length | As long as needed | 1–2 pages maximum |
| Lifespan | Closed when decision is made | Lives forever in the repository |
| Review process | Pull request with open comments | Merged after decision is confirmed |

**Use an RFC** when: you need to explore alternatives, build consensus, or document tradeoffs before committing to an approach.

**Write an ADR** when: a significant architectural decision has been made — whether through an RFC, a design review, or even informally — and you need to record it for future reference.

An RFC can produce an ADR. An ADR can exist without an RFC (for decisions made before you had an RFC process, or for smaller decisions that didn't warrant a full RFC).

---

## The Decision Weight Matrix

Not every decision warrants an ADR. Use this matrix to decide when to write one:

```
                    HIGH reversibility cost
                           │
                           │
 Small scope ──────────────┼────────────────── Large scope
 (one team)                │                   (many teams)
                           │
                    LOW reversibility cost
```

**Write an ADR when:**
- Reversibility cost is high (changing it later is expensive or risky)
- Scope is broad (affects multiple teams, services, or regulatory obligations)
- Multiple reasonable alternatives existed and were considered
- Future engineers would wonder "why did they do it this way?"
- The decision has compliance, security, or regulatory implications

**Do not write an ADR for:**
- Implementation details obvious from the code
- Naming conventions and style decisions (covered by team standards)
- Temporary decisions with a clear expiry (< 90 days)
- Patch version library upgrades

**Heuristic (Nygard's rule)**: If you would want to explain the decision in a code review comment that will outlast the PR, it belongs in an ADR.

---

## MADR Format

MADR (Markdown Architecture Decision Records) is the most practical ADR format for engineering teams. It is:
- Simple enough that engineers will actually write it
- Structured enough that future readers can quickly find what they need
- Version-controlled alongside code (not in a wiki that drifts from reality)

```markdown
# ADR-003: Use PostgreSQL as the Primary Database for the Payments Ledger

**Status**: Accepted
**Date**: 2026-10-15
**Deciders**: Principal Engineer (Payments), VP Engineering, Head of Data

## Context and Problem Statement

The payments ledger needs a primary database. We are building a new ledger
service from scratch as part of the payments platform migration. The database
must handle:
- Write throughput: 5,000 transactions/second at peak (end-of-month processing)
- Read queries: complex account balance calculations, transaction history, reconciliation
- ACID guarantees: double-entry accounting requires strong transaction semantics
- Audit requirements: immutable transaction history for regulatory reporting (7 years)

## Decision Drivers

- ACID transactions required for double-entry accounting (no eventual consistency)
- SQL expertise available in team (all engineers know SQL; nobody knows MongoDB query language)
- Compliance: data residency in EU (eliminating some cloud-only databases)
- Operational simplicity: team already operates PostgreSQL for other services
- Partitioning: account-level sharding will be needed within 18 months

## Considered Options

1. **PostgreSQL 15** (chosen)
2. **MongoDB 6**
3. **CockroachDB 23**
4. **Amazon Aurora Serverless v2**

## Decision Outcome

Chosen option: **PostgreSQL 15**, because:
- Strong ACID guarantees with mature transaction semantics
- Best SQL support of the options considered (window functions, CTEs for accounting queries)
- Team already has operational expertise with PostgreSQL
- Proven in financial services (used by multiple large payment processors)
- Open source: no vendor lock-in; can run on any cloud or on-premises

Negative consequences:
- Manual sharding required when we outgrow single-node capacity (estimated 18 months)
- Replication setup and failover more complex than Aurora's managed alternative
- No automatic horizontal write scaling (CockroachDB would handle this natively)

## Options Analysis

### PostgreSQL 15
- Pros: ACID, mature, SQL, operational expertise, no vendor lock-in
- Cons: Manual sharding; not horizontally scalable for writes
- Risk: Partitioning migration in ~18 months

### MongoDB 6
- Pros: Horizontal scale, flexible schema
- Cons: Limited ACID for multi-document operations; team unfamiliar;
  flexible schema is a liability for accounting (strict schema required)
- **Verdict: Eliminated** — ACID requirements are non-negotiable for a ledger

### CockroachDB 23
- Pros: ACID, horizontal scale, SQL-compatible
- Cons: Higher cost; less operational maturity in team; Postgres wire protocol
  but not fully compatible (some query plans behave differently)
- **Verdict**: Keep as future option if sharding becomes operationally complex

### Amazon Aurora Serverless v2
- Pros: Fully managed, auto-scaling, familiar PostgreSQL interface
- Cons: AWS vendor lock-in; slightly higher latency than self-managed PostgreSQL;
  data residency control is more complex
- **Verdict**: Viable option; rejected because team prefers infrastructure
  portability for this core system

## Links

- RFC: [RFC-038 — Ledger database selection]
- Performance benchmarks: [link to benchmark results in Confluence]
- Related ADR: ADR-004 — Ledger partitioning strategy (future, not yet written)
- Follow-up: Review CockroachDB migration in Q3 2027 if shard count > 8
```

---

## ADR Lifecycle

```
PROPOSED → ACCEPTED → DEPRECATED → SUPERSEDED
     │                     │              │
     │                     │              └─ New ADR replaces this one
     │                     └─ Technology/approach is being retired
     └─ Alternative status: REJECTED
        (documented decisions we considered and did not take)
```

**Proposed**: ADR is drafted but not yet decided. Used when you want to initiate discussion via an ADR rather than an RFC.

**Accepted**: Decision was made and is currently in force. This is the normal state.

**Deprecated**: The decision is being retired. The pattern or technology is being phased out. No new code should use it. Write a one-sentence migration note.

**Superseded**: A new ADR has replaced this one. Link to the new ADR. Keep the old one for historical record — the chain of reasoning has audit and institutional value.

**Rejected**: The option was considered and explicitly not taken. Documenting rejected options prevents teams from proposing them again.

---

## Where ADRs Live

**In the repository** (strongly recommended): `docs/adr/` or `/adr/` directory at the repository root. ADRs are version-controlled, searchable, and change alongside the code they describe.

```
payments-service/
├── src/
├── docs/
│   └── adr/
│       ├── README.md          ← index of all ADRs (auto-generated by adr-tools)
│       ├── 0001-use-postgresql.md
│       ├── 0002-use-kafka-for-events.md
│       ├── 0003-use-resilience4j-for-circuit-breaking.md
│       └── 0004-postgresql-sharding-strategy.md
└── README.md
```

**Not in Confluence** (avoid): Confluence becomes outdated, is not version-controlled with code, and is usually difficult to search. Engineers stop checking it. The 2024 Thoughtworks Technology Radar explicitly recommends against wiki-only ADR storage.

**For multi-service organisations**: Use Backstage to aggregate ADRs across all repositories into a searchable index.

---

## Tooling: `adr-tools` CLI

```bash
# Install adr-tools
brew install adr-tools  # macOS

# Initialise ADR directory in repo
adr init docs/adr
# Creates: docs/adr/0001-record-architecture-decisions.md (the meta-ADR)

# Create new ADR (auto-numbered)
adr new "Use Kafka for payment events"
# Creates: docs/adr/0004-use-kafka-for-payment-events.md
# with MADR template pre-filled

# Supersede an existing ADR
adr new -s 3 "Use Resilience4j v2 for circuit breaking"
# Creates new ADR, adds "Superseded by ADR-0005" link to ADR-003

# Generate ADR index (for README.md)
adr generate toc > docs/adr/README.md
```

---

## Backstage ADR Plugin (Multi-Repository)

For organisations with 10+ repositories, Backstage aggregates ADRs across all repositories:

```yaml
# catalog-info.yaml in each repository
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  annotations:
    backstage.io/techdocs-ref: dir:.
    backstage.io/adr-location: docs/adr
spec:
  type: service
  owner: team-payments
```

Engineers can search all ADRs across all repositories from a single Backstage interface. This is particularly valuable for principal engineers who need to understand how decisions evolved across the organisation.

---

## CI Enforcement: ADR Lint in GitHub Actions

```yaml
# .github/workflows/adr-lint.yml
name: ADR Lint

on:
  pull_request:
    paths:
      - 'docs/adr/**'

jobs:
  adr-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install log4brains
        run: npm install -g log4brains

      - name: Validate ADR format
        run: |
          log4brains adr list --format json | jq '.[] | select(.status == null) | .slug' |
          while read slug; do
            echo "ERROR: ADR $slug is missing a status field"
            exit 1
          done

      - name: Check no PROPOSED ADR older than 14 days
        run: |
          log4brains adr list --format json |
          jq -r '.[] | select(.status == "proposed") | .date + " " + .slug' |
          while read date slug; do
            age=$(( ($(date +%s) - $(date -d "$date" +%s)) / 86400 ))
            if [ "$age" -gt 14 ]; then
              echo "ERROR: ADR $slug has been PROPOSED for $age days — resolve the decision"
              exit 1
            fi
          done
```

This CI check prevents stalled decisions from silently ageing in the repository.

---

## Linking ADRs to Code

ADRs are most valuable when engineers encounter them in context — while reading code, not searching a documentation site:

```java
// Link to ADR in code where the decision manifests
@Service
public class PaymentLedgerService {

    /**
     * Uses PostgreSQL with explicit transaction management.
     * Decision rationale: see docs/adr/0001-use-postgresql.md
     *
     * Note: Double-entry accounting requires ACID guarantees.
     * MongoDB was considered and rejected; see ADR-001 for details.
     * CockroachDB is tracked as a future option — see ADR-001 §Consequences.
     */
    @Transactional(isolation = Isolation.SERIALIZABLE)
    public LedgerEntry recordPayment(Payment payment) {
        // Double-entry: debit source account, credit destination account
        // Both writes are atomic — either both succeed or neither does
        ledgerRepository.debit(payment.getSourceAccountId(), payment.getAmount());
        ledgerRepository.credit(payment.getDestinationAccountId(), payment.getAmount());
        return ledgerRepository.createEntry(payment);
    }
}
```

The ADR link in the comment tells the reader: "this is not an accident; it was a deliberate decision with documented context." It stops the next engineer from asking "why are we using PostgreSQL here when MongoDB would be simpler?"

---

## Fintech ADR Examples

### ADR: Synchronous vs Asynchronous Fraud Check

```markdown
# ADR-007: Fraud Check Integration — Synchronous, In-Path

**Status**: Accepted
**Date**: 2026-11-01
**Deciders**: Principal Engineer (Payments), Head of Compliance

## Context

Payment flow must include a fraud check. Options:
1. Synchronous: check blocks payment processing (~50ms p95 latency impact)
2. Asynchronous: check runs after payment authorised; fraudulent payments reversed later

## Decision Outcome

Chosen: **Synchronous, in-path fraud check**

Reason: Reversing a settled payment requires a recall message to correspondent banks.
Under UK Faster Payments rules, recall success rate is ~65%. Accepting a fraudulent payment
and reversing it means 35% of fraudulent payments result in firm loss.
The 50ms latency impact is acceptable under our SLA (p99 < 300ms).

Negative consequences:
- Fraud service becomes a critical path dependency; its SLA now constrains our SLA
- Requires a circuit breaker with safe fallback (allow or deny) in case fraud service is unreachable
- See ADR-008 — Fraud service circuit breaker strategy

## Rejected Option: Asynchronous Post-Authorisation

Rejected because: 35% irrecoverable loss rate on caught fraud is unacceptable.
Revisit if fraud service p95 latency exceeds 200ms (breach of our SLA).
```

### ADR: Idempotency Key Storage

```markdown
# ADR-012: Idempotency Key Storage — PostgreSQL over Redis

**Status**: Accepted

## Context

Payment API requires idempotency keys (see RFC-055). Keys must be stored and
checked on every payment request. The check must be atomic with the payment write.

## Decision Outcome

Chosen: **PostgreSQL idempotency key table** (same DB as payments)

Reason: Storing idempotency keys in the same PostgreSQL database as payments
allows the check and payment write to be in the same ACID transaction.
Redis would require a cross-system atomic check (compare-and-set), which
introduces a window for double-processing under failure.

Negative consequence: idempotency key table adds ~5% overhead to payment writes.
Partitioned by created_at week; old partitions dropped after 7 days.
```

---

## Building ADR Culture: The Principal Engineer's Role

Culture change is the hardest part. Technical tooling is easy. The principal engineer's job is to make writing ADRs the path of least resistance:

**Make the template so simple it takes < 15 minutes**: A three-page template kills adoption. The MADR format with five sections (context, drivers, options, decision, consequences) fits on two pages.

**Write the first 10 ADRs yourself**: Model the behaviour you want. If the most senior technical person in the room writes ADRs, others will too.

**Review ADRs in code review**: "This implementation assumes X. That was a deliberate decision documented in ADR-007. Here's the link." This demonstrates to the team that ADRs are read, not just written.

**Make "where's the ADR for this?" a normal question**: When someone proposes a significant change in a design review and there's no ADR — ask for one. Not as a gatekeeping move, but as a genuine "help us understand the rationale."

**Retrospective question**: "Did we make any decisions this sprint that future-us would wonder about?" At the end of every sprint, explicitly scan for undocumented architectural decisions.

---

## Review ADRs in Team Rituals

| Ritual | ADR integration |
|---|---|
| Sprint retrospective | "Any decisions this sprint worth recording?" |
| Tech talks | "Before the demo, let me share the ADR — it explains the non-obvious parts" |
| Onboarding | "Read these 10 ADRs before your first week is out" |
| Code review | "This violates ADR-005. The ADR explains why we can't do it this way." |
| Architecture review | "What decisions have been made? Where are the ADRs?" |
| Incident post-mortem | "Was this decision documented? Should it be updated based on what we learned?" |

---

## Anti-Patterns

**The ADR graveyard**: An ADRs directory with 200 ADRs, most of which are outdated. Fix by quarterly lifecycle reviews — mark stale ones Superseded or Deprecated.

**The un-linked ADR**: ADR exists but no code links to it. It is never discovered. Fix: require ADR links in code review for decisions that manifest in code.

**The post-hoc rationalisation ADR**: Decision already made, ADR written to justify it without genuinely documenting the alternatives. Fix: use RFCs for pre-decision exploration; ADRs for recording honest decisions.

**The ADR as blame document**: "We wrote ADR-005 that says don't use X — this team violated it." ADRs are institutional knowledge, not compliance weapons. When an ADR is violated, ask: is the ADR still correct?

**The 10-page ADR**: Too long to read, too slow to write. Keep ADRs to 1–2 pages. If more context is needed, link to an RFC or design doc.

---

## Key Takeaways

- RFCs propose and discuss; ADRs record — both are needed; use each for its purpose.
- Write ADRs when reversibility cost is high or scope is broad. Skip them for implementation details obvious from code.
- MADR format in the repository, not Confluence — version-controlled alongside the code they describe.
- Link ADRs from code comments where the decision manifests — this is when ADRs are most valuable.
- Building ADR culture requires the principal engineer to model the behaviour: write the first ones, ask for them in code review, include them in retrospectives.
- Principal engineers are measured by institutional memory, not just technical depth. ADRs are how that memory is encoded.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the key difference between an RFC and an ADR?",
      "options": [
        "RFCs are written by senior engineers; ADRs by all engineers",
        "RFCs propose and discuss decisions before they are made; ADRs record decisions after they are made",
        "RFCs are stored in Confluence; ADRs in the repository",
        "RFCs require team votes; ADRs are written by the decision maker alone"
      ],
      "correct": 1,
      "explanation": "RFCs are pre-decision documents designed to propose alternatives and build consensus. ADRs are post-decision records that capture what was decided, why, what alternatives were considered, and what the consequences are. An RFC often produces an ADR — but an ADR can also exist without a prior RFC for smaller decisions."
    },
    {
      "text": "Why should ADRs be stored in the repository rather than in Confluence?",
      "options": [
        "Confluence has storage limits",
        "Repository-stored ADRs are version-controlled alongside the code they describe, remain discoverable over time, and can be linked from code comments",
        "Confluence is too expensive for ADR storage",
        "Only developers have access to Confluence"
      ],
      "correct": 1,
      "explanation": "ADRs in the repository are version-controlled, searchable with standard code search tools, discoverable when reading code, and kept in sync with the code they describe. Confluence pages drift from reality as code evolves, become outdated without automated enforcement, and are harder to link from code comments."
    },
    {
      "text": "A team is deciding between storing idempotency keys in Redis vs PostgreSQL. The principal engineer advocates for PostgreSQL because it allows the idempotency check and payment write to be in the same ACID transaction. How should this decision be recorded?",
      "options": [
        "No ADR needed — this is an implementation detail",
        "An ADR documenting the two options, the ACID atomicity rationale for PostgreSQL, and the rejected Redis option with explanation",
        "Only a code comment in the idempotency service",
        "A Confluence page linked from the team wiki"
      ],
      "correct": 1,
      "explanation": "This decision is a prime ADR candidate: the rationale (ACID atomicity across the idempotency check and payment write) is not obvious from the code, multiple reasonable options existed, and changing it later is expensive. Future engineers will wonder 'why PostgreSQL and not Redis?' — the ADR answers that question permanently."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "ADR Culture Implementation for a Payment Platform Team",
  "difficulty": "principal",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "Write a complete MADR-format ADR for the following decision: a payment service must choose between synchronous fraud check (blocks payment, adds ~50ms, prevents fraudulent payments) vs asynchronous fraud check (non-blocking, may allow fraudulent payments that must be reversed later). Include: context with specific regulatory framing, decision drivers, both options with explicit pros/cons, chosen option with rationale, negative consequences, and a cross-reference to a hypothetical circuit breaker ADR."
    },
    {
      "id": "2",
      "description": "Design the ADR governance process for a 50-engineer fintech engineering organisation with 15 repositories. Specify: (a) where ADRs live per repository, (b) how cross-repository ADRs (affecting all teams) are managed, (c) what review process an ADR goes through before moving from PROPOSED to ACCEPTED, (d) how the architecture review committee uses ADRs in their process."
    },
    {
      "id": "3",
      "description": "Write the GitHub Actions workflow that enforces ADR quality on PRs touching docs/adr/: (a) validates that every ADR has a Status field, (b) fails the build if any ADR has been in PROPOSED state for more than 14 days, (c) requires CODEOWNERS approval from @architecture-leads. Write the companion CODEOWNERS entry and a one-paragraph justification for why architecture lead review on ADRs matters specifically in a PCI-DSS environment."
    },
    {
      "id": "4",
      "description": "Conduct a decision archaeology exercise: take any codebase you know (or invent one) and identify 5 places where the code makes a non-obvious architectural choice with no documentation. For each, write a one-sentence description of what future-reader confusion the missing ADR would prevent, then write a stub MADR (just context + decision outcome, no full analysis) for the most important one."
    }
  ]
}
-->
