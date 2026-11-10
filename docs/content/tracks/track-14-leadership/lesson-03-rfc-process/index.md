---
id: track-14-lesson-03
title: "The RFC Process — Driving Technical Decisions at Scale"
slug: rfc-process
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 3
difficulty: principal
estimatedMinutes: 80
status: published
tags: [RFC, technical-decision, proposal, review, consensus]
prerequisites: [track-14-lesson-02]
---

# The RFC Process — Driving Technical Decisions at Scale

> [!NOTE]
> An RFC (Request for Comments) is not a bureaucratic hurdle—it is the mechanism by which a principal engineer drives major technical decisions at scale without needing to be in every meeting. A well-written RFC creates alignment, surfaces concerns before implementation, and produces a durable record of why a decision was made.

## Why RFCs at the Principal Level

As an individual contributor without direct reports, your influence over technical direction comes primarily through your ability to persuade. RFCs are your primary instrument for this influence. They allow you to:

**Drive decisions asynchronously**: A well-written RFC lets 20 engineers across 4 time zones engage with a proposal without a 2-hour meeting that half of them cannot attend.

**Surface concerns early**: Code is expensive to change. Architecture is more expensive. An RFC that surfaces a critical objection during the comment period saves weeks of rework.

**Create organisational memory**: Two years from now, when someone asks "why did we build a Kafka-based settlement pipeline instead of a synchronous one?", the RFC answer that question. Without it, the institutional knowledge lives only in one engineer's head.

**Scale your impact**: You can personally review 2-3 designs in a week. An RFC process lets you create standards that affect 20 designs without touching each one.

---

## RFC Lifecycle

```
DRAFT                COMMENT PERIOD        DECISION           IMPLEMENTATION      CLOSED
  │                       │                    │                    │               │
  ├─ Author drafts RFC     ├─ Engineers review  ├─ Author            ├─ Code written  ├─ Outcome documented
  ├─ Share with 1-2        ├─ Questions asked   │  summarises        ├─ RFC kept as   │  (success, modified,
  │  trusted reviewers     ├─ Alternatives      │  discussion        │  reference     │  or abandoned)
  ├─ Post to RFC repo      │  discussed         ├─ Decision          ├─ Linked from   └─ Status: Closed
  │  (or Confluence)       ├─ Concerns raised   │  made by           │  ADR
  └─ Status: Draft         └─ 1-2 week window   │  designated        └─ Status:
                           Status: Review       │  decision maker      Implementing
                                                └─ Status: Accepted/Rejected/Deferred
```

**Comment period**: 1-2 weeks for most RFCs. 2-4 weeks for major architectural changes (e.g., migrating from monolith to microservices). Shorter periods lead to decisions made without full input; longer periods let discussions stall.

**Decision maker**: Identify this upfront. It should not be "the team votes" (tragedy of the commons) or "whoever comments loudest wins." For technical decisions, it is typically: the principal engineer authoring the RFC (for technical approach questions), the engineering manager (for resource and prioritisation questions), or the VP Engineering (for multi-team architectural decisions).

---

## RFC Template

```markdown
# RFC-042: Migrate Payment Settlement to Event-Driven Architecture

**Status**: Review
**Author**: @principal-engineer-name
**Created**: 2026-11-01
**Decision deadline**: 2026-11-15
**Decision maker**: Head of Payments Engineering

---

## Problem Statement

The current payment settlement process uses synchronous REST calls from the payment
service to the settlement service. This creates three problems:

1. **Reliability**: If the settlement service is unavailable, payments fail immediately,
   even though settlement can be delayed by hours without customer impact.
2. **Performance**: Settlement for high-value payments requires fraud review, which
   blocks the synchronous call chain for up to 30 seconds (p99).
3. **Scalability**: Settlement throughput is bounded by the settlement service's
   synchronous capacity. During end-of-day batch, we see 10% payment failure rate.

**Evidence**:
- Settlement service availability: 99.6% (last 90 days) → ~1,750 failed payments/day
- p99 settlement latency: 28s during peak
- End-of-day failure rate: data from Grafana dashboard [link]

---

## Goals

- Payment submission success rate > 99.95% (regardless of settlement service availability)
- Settlement processing throughput: 10,000 payments/minute (5x current peak)
- Settlement latency: p99 < 2 minutes (acceptable customer experience; currently 28 seconds worst case but synchronous)

## Non-Goals

- Migrating the fraud service (separate RFC)
- Real-time payment settlement (immediate settlement is a future initiative)
- Replacing the settlement service's internal implementation

---

## Proposed Solution

Introduce a Kafka-based settlement pipeline. Payment service publishes a
`PaymentSettlementRequested` event after payment authorisation. Settlement service
consumes events asynchronously.

**Architecture**:
```
Payment Service ──publish──► Kafka Topic (payment-settlements) ──consume──► Settlement Service
                                                                                      │
                                                                                      ▼
                                                                             Settlement Database
                                                                                      │
                                                                                      ▼
                                                                     publish PaymentSettled event
                                                                                      │
Payment Service ◄──consume────────────────────────────────────────────────────────────
```

**Failure handling**: If settlement fails (e.g., insufficient funds discovered during settlement), publish a `PaymentSettlementFailed` event. Payment service handles compensating transaction.

**Kafka configuration**: Settlement topic with 20 partitions (supports 20x parallelism), replication factor 3, retention 7 days (allows replaying recent events for recovery).

---

## Alternatives Considered

### Alternative 1: Saga pattern with choreography (rejected)
Multiple services emit events that trigger each other.
Rejected because: debugging distributed failures becomes extremely difficult.
The settlement pipeline is two services; additional complexity of saga is not justified.

### Alternative 2: Synchronous with queue-based retry (rejected)
Payment service retries settlement call with exponential backoff.
Rejected because: does not solve throughput problem; Tomcat thread blocks during retry wait.
Settlement service failures still cause payment submissions to slow down.

### Alternative 3: Database-based outbox pattern (viable alternative)
Payment service writes to outbox table in its database; a separate process polls and publishes to Kafka.
Trade-off: Simpler (no Kafka dependency for Payment service), but adds polling latency (seconds).
Could be chosen if Kafka operational overhead is a concern.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| At-least-once delivery causes duplicate settlement | Medium | Critical | Idempotency key in settlement event; settlement service deduplicates by payment_id |
| Kafka consumer lag grows during peak | Low | High | Monitor lag; auto-scale consumers; alert at lag > 10,000 |
| Event schema evolution breaks consumers | Medium | Medium | Use Avro with Confluent Schema Registry; backward-compatible schema evolution |
| Settlement failure not surfaced to customer promptly | Low | Medium | Settlement service publishes failure events within 30 seconds |

---

## Success Criteria

- Payment submission success rate > 99.95% (measured over 30 days post-migration)
- Settlement consumer lag < 1,000 messages at peak
- Settlement throughput: tested to 10,000 payments/minute in load test
- Zero duplicate settlements in first 30 days (measured via reconciliation report)

---

## Implementation Plan

Week 1-2: Schema design and Schema Registry setup
Week 3-4: Payment service Kafka producer implementation
Week 5-6: Settlement service Kafka consumer implementation
Week 7: Integration testing in staging
Week 8: Gradual rollout (10% → 50% → 100% using feature flag)
Week 9+: Monitor and validate success criteria

**Rollback plan**: Feature flag to revert to synchronous calls. Settlement event consumer can be paused; payment service falls back to synchronous call.

---

## Open Questions

1. Should we use a consumer group per region or a single global consumer group?
   (Affects ordering guarantees for multi-region deployment)

2. What is the acceptable consumer lag threshold before we alert on-call?

3. Do we need message signing (payment service signs events, settlement service verifies)?
   (Security implication — settlement events contain financial data)
```

---

## Running the RFC Review Meeting

For complex RFCs, a time-boxed review meeting accelerates convergence. Without it, async discussion can run for weeks without resolution.

**Structure (60 minutes):**

```
0-5 min:  Author presents the problem statement (not the solution)
          "This is the problem we have. These are the constraints."

5-20 min: Questions of clarification (not debate)
          "I need to understand X before I can evaluate the proposal."

20-40 min: Discussion of tradeoffs and alternatives
           "What if we used Y instead? Have we considered Z?"
           Author: acknowledge valid concerns, explain reasoning

40-55 min: Identify remaining open questions
           "These three questions need answers before we decide."
           Assign owners: who will answer each question by when?

55-60 min: Decision or next step
           If sufficient information: decision maker decides
           If open questions remain: schedule next review or close async
```

**Facilitation rules:**
- One person talks at a time (the principal engineer facilitates)
- Questions before objections ("Can you help me understand why X?" before "X is wrong")
- Decision maker has final say—majority opinion is advisory, not binding

---

## Achieving Consent, Not Consensus

Consensus ("everyone agrees") is unreachable on most significant architectural decisions. Some engineers will always prefer a different approach. Waiting for consensus means never deciding.

**Consent** ("no one has an irresolvable objection") is achievable. The difference:
- Consensus: "I think this is the best approach"
- Consent: "I have concerns about X, they've been heard and acknowledged, I can live with this decision"

A dissenting opinion is legitimate and should be recorded in the RFC. It demonstrates that the decision was made with full information, not by ignoring concerns.

```markdown
## Dissenting Opinion — @engineer-name

I support the decision but want to record my concern for the record:
The proposed Kafka consumer uses at-least-once delivery. The idempotency
implementation assumes payment_id is sufficient for deduplication.
If the same payment_id is ever reused (e.g., after a system migration),
we will have silent duplicate settlements.

Recommendation: add a composite idempotency key that includes both
payment_id and event_timestamp.

Decision maker acknowledged this concern. It has been captured as a
follow-up: PAY-5678 "Composite idempotency key for settlement events"
```

---

## RFC Anti-Patterns

**RFC as bureaucracy**: RFCs are created for every small decision, including trivial ones. Teams feel that nothing can be done without a written RFC. This kills velocity for no benefit.

**RFC as fait accompli**: The author has already decided and built a proof-of-concept. The RFC is written to get rubber-stamp approval. Reviewers feel their input is not valued and stop engaging.

**Design by committee**: The RFC has 15 reviewers, all of whom must approve. The proposal is watered down to satisfy everyone and ends up as a mediocre compromise.

**No decision maker**: The RFC has 50 comments, no clear decision point, and stalls indefinitely because nobody is empowered to decide.

**Too long**: An RFC that takes 3 hours to read will not be read. The problem statement should be one page. The proposal should be two pages. The whole RFC should be readable in 20 minutes.

---

## Fintech RFC Examples

**Good RFC topics** (significant, cross-team, architectural):
- Migrating from synchronous settlement to event-driven (above)
- Selecting a fraud scoring vendor vs building in-house
- Adopting event sourcing for the ledger
- Defining the standard for service-to-service authentication (mTLS vs JWT)

**Bad RFC topics** (too small, should be an ADR or just a PR):
- Which Java logging library to use in one service
- Whether to use `Optional` or null in a specific method
- Configuration changes in one service
- Renaming a database column

---

## Key Takeaways

- An RFC's primary value is surfacing objections before implementation, not generating documentation—the discussion is the product, the document records it
- Identify the decision maker before the comment period opens: "the team will decide" produces long discussions with no resolution
- Achieve consent (no irresolvable objections), not consensus (everyone agrees)—record dissenting opinions formally to demonstrate the decision was made with full information
- RFC anti-patterns kill the process: too many required reviewers, decisions already made before the RFC is written, and RFC required for trivial decisions
- For fintech, RFCs are especially important for decisions with compliance implications—the written record demonstrates that security, data protection, and regulatory requirements were considered

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the distinction between seeking 'consent' versus 'consensus' in an RFC decision process?",
      "options": ["Consent requires a majority vote; consensus requires unanimity", "Consent means no irresolvable objections — the decision can proceed even if not everyone prefers it; consensus requires everyone to agree. Consent is the goal because consensus is often unachievable on significant technical decisions", "Consent is for security decisions; consensus is for architecture decisions", "Consent is informal; consensus is formal"],
      "correct": 1,
      "explanation": "Requiring consensus (everyone agrees) gives every reviewer veto power and produces watered-down designs that satisfy everyone minimally. Consent (no irresolvable objections) allows the principal engineer to proceed with the best decision even if some reviewers prefer alternatives, as long as objections have been heard and addressed or formally recorded as dissent."
    },
    {
      "text": "Why is 'RFC as fait accompli' an anti-pattern that kills the RFC process?",
      "options": ["It wastes time writing documentation for decisions already made", "When authors have already decided and built a proof-of-concept before writing the RFC, reviewers recognize their input is not genuinely sought and stop engaging — the RFC becomes a rubber-stamp process with no real technical oversight", "It violates the RFC timeline requirement", "It makes the RFC too long to read"],
      "correct": 1,
      "explanation": "The value of an RFC is surfacing objections and alternatives before implementation, when they are cheap to address. If the PoC is already built, changing the approach costs weeks of rework. Reviewers who know their feedback will not change the outcome stop providing genuine reviews, destroying the oversight function of the RFC process."
    },
    {
      "text": "What makes an RFC topic appropriate for the RFC process versus too small to warrant an RFC?",
      "options": ["RFCs are only for decisions over a certain budget threshold", "RFC topics should be significant (affects multiple teams or the whole platform), cross-cutting (not owned by a single team), and architectural (structural decisions with long-lasting consequences) — trivial decisions like logging library choice or column renames belong in ADRs or PRs", "RFC topics should take more than 3 months to implement", "Any technical decision requires an RFC"],
      "correct": 1,
      "explanation": "RFC overhead is significant — writing, review cycles, decision process. This overhead is worth it for decisions that affect multiple teams, have architectural consequences, or have compliance implications. For trivial decisions, the overhead exceeds the benefit. Using RFC for small decisions kills team velocity without adding value."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Writing and Facilitating an RFC for a Payment Platform Decision",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write a complete RFC for migrating a payment settlement service from synchronous REST to event-driven Kafka: include problem statement with business context, 3 alternative approaches with trade-offs for each, proposed solution with architecture diagram, security and compliance considerations, and open questions."},
    {"id": "2", "description": "Design the RFC review process: define the reviewer list (who must review, who should review), set a 10-business-day comment period, create a template for structuring comments as 'concern/suggestion/question', define the decision-maker and consent criteria, and plan the final decision meeting agenda."},
    {"id": "3", "description": "Handle a dissenting comment: given a reviewer who objects that 'Kafka adds operational complexity we are not ready for' — write a response that acknowledges the concern, provides evidence addressing it (team training plan, managed Kafka offering), and either incorporates it into the design or formally records it as a dissenting opinion with the reviewer's name."},
    {"id": "4", "description": "Create an RFC decision log entry: document the final decision, rationale, all alternatives considered with reasons for rejection, formal dissenting opinions, and the decision date and maker — structured so a new engineer joining 2 years later understands exactly why event-driven was chosen over synchronous REST."}
  ]
}
-->
