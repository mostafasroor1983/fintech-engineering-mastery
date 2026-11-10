---
id: track-14-lesson-08
title: "Cross-Team Influence — Driving Change Without Authority"
slug: cross-team-influence
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 8
difficulty: principal
estimatedMinutes: 75
status: published
tags: [influence, cross-team, stakeholder, alignment, narrative]
prerequisites: [track-14-lesson-07]
---

# Cross-Team Influence — Driving Change Without Authority

> [!NOTE]
> The principal engineer job description could be summarised as: "Have the credibility to identify what needs to change and the influence to make it happen, without direct authority over anyone." Influence without authority is the core skill. It is learnable, but it requires a fundamentally different mental model from individual technical contribution.

## The Influence Paradox at Principal Level

As a principal engineer you are, in most organisations, one of the most senior technical voices. You are expected to drive significant changes: platform migrations, architectural standards, security frameworks, testing practices. But you have no one reporting to you. You cannot direct engineers to do anything. Every outcome depends on people choosing to follow your direction.

This is not a limitation—it is a feature. Changes driven by influence rather than authority are more durable. Engineers who chose to adopt a new pattern own it in a way that engineers who were directed to adopt it do not.

The mental shift: stop thinking about what you can make people do. Start thinking about what you can make it easy for people to want to do.

---

## Stakeholder Mapping

Before trying to drive any significant change, map who you need to influence and how.

### Interest vs Influence Matrix

```
HIGH INFLUENCE
     │
     │  MANAGE CLOSELY          COLLABORATE
     │  (High influence,        (High influence,
     │   Low interest)           High interest)
     │
     ├──────────────────────────────────────────
     │
     │  MONITOR                 KEEP INFORMED
     │  (Low influence,         (Low influence,
     │   Low interest)           High interest)
     │
LOW INFLUENCE ──────────────────────────────► HIGH INTEREST
```

**Example: Driving adoption of a standard API security framework**

| Stakeholder | Interest | Influence | Quadrant | Strategy |
|-------------|----------|-----------|----------|---------|
| VP Engineering | Low (day-to-day technical) | High (can mandate it) | Manage Closely | Show business risk; ask for top-down support |
| Payment Team Lead | High (owns most affected service) | High (team will follow their lead) | Collaborate | Co-create the standard; make them a co-author |
| Fraud Team Lead | Medium | Medium | Keep Informed | Regular updates; address concerns |
| Individual Engineers | High (must implement) | Low individually | Keep Informed | Good documentation; office hours |
| Security Team | High | High (can block launches) | Collaborate | Align early; incorporate their requirements |
| Compliance Officer | Low (technical details) | High (can mandate compliance) | Manage Closely | Frame as compliance risk reduction |

---

## Coalition Building

A single principal engineer advocating for a change is easy to discount. A coalition of three teams' tech leads, the security team, and one VP is not.

**Building a coalition in practice:**

**Find the early adopters**: Which team has the most to gain from your proposal? Start there. Implement the change with them first. Use their positive experience as evidence for the next team.

**Make allies out of objectors**: The most credible supporter of a change is someone who was initially sceptical and changed their mind. Find the engineer who is most likely to object and engage them directly before the broader proposal: "I know you have concerns about X. Help me understand them, and let's see if we can address them."

**Build social proof**: "Three teams have adopted this pattern successfully" is more persuasive than "I think this is the right approach." Move early adopters to explicit public endorsement.

---

## Crafting Technical Narratives for Different Audiences

The same technical decision requires different narratives for different audiences. This is not spin—it is translation.

### For Engineers: Code and Data

Engineers respond to: concrete technical problems, evidence from production, specific code examples, data from load tests.

```
"The current payment authorisation service uses a synchronous call to the fraud service.
In the last 90 days, fraud service latency spikes caused 847 payment authorisations
to exceed our 500ms SLA. Here's the flame graph from last Tuesday's incident.
The fix is straightforward: introduce a timeout + circuit breaker. Here's the PR I prototyped.
I'd like this team's input before I propose it as a standard pattern."
```

### For Product Managers: User Impact

Product managers respond to: customer experience, conversion rates, revenue, feature delivery speed.

```
"Our current fraud service coupling means that every time fraud is slow,
customers see spinning payment buttons. Last month, 847 customers waited more
than 30 seconds for payment confirmation—some abandoned and went to competitors.
If we implement the circuit breaker pattern, those customers see instant payment
confirmation (processed in background) instead of waiting. It's a one-sprint investment."
```

### For Executives: Risk and Cost

Executives respond to: financial risk, regulatory risk, competitive risk, strategic positioning.

```
"Our payment infrastructure has a single-point-of-failure pattern that caused
23 customer complaints last month and two regulatory reporting incidents.
The architectural pattern we're proposing (circuit breaker + async processing)
is industry standard in Tier-1 payment processors. It eliminates the failure mode
entirely. Investment: one sprint per affected service. Risk of not doing it:
continued regulatory events and customer churn from payment failures."
```

---

## Persuasion Techniques That Work

**Data over opinion**: "In my experience..." is weak. "In our last 90 days of production data..." is strong. Build the habit of backing technical opinions with production metrics.

**Demos over documents**: A working prototype is 10x more persuasive than a proposal document. It is concrete, lowers the perceived risk ("it already works"), and forces you to have worked out the details.

**Pilots over mandates**: "Let's try this in one service, measure the results, and decide" is almost always accepted. "We should adopt this as a company standard immediately" almost always meets resistance. Start with pilots; standards emerge from successful pilots.

**Acknowledge trade-offs**: The engineer who says "this approach is perfect with no downside" destroys their credibility. The engineer who says "this approach has these trade-offs, and I believe the benefits outweigh them for these reasons" builds it. Lead with the trade-offs; it shows you've thought carefully.

**Reference precedent**: "Amazon migrated to this pattern in 2008. Netflix published their approach. We're applying the same pattern to our context." External evidence reduces the perceived risk of innovation.

---

## Handling Resistance and Objections

Resistance to change is normal and healthy. The question is how you respond to it.

**Listen before rebutting**: Understand the objection fully before responding. Often the objection reveals a constraint or requirement you hadn't considered. "Can you help me understand what's driving that concern?"

**Categorise objections**:
- **Valid objections**: The objector has identified a real problem. Acknowledge it; modify your proposal.
- **Solvable objections**: The objector has a concern that can be addressed. Address it.
- **Preference objections**: The objector simply prefers a different approach. Acknowledge the preference; explain why you're proposing the alternative.
- **Political objections**: The objector has a reason unrelated to the technical merits. These are the hardest and require a separate conversation.

**When you cannot convince**: Not every disagreement can be resolved through better arguments. Sometimes the right move is to agree to disagree and document both perspectives (as in an RFC with a dissenting opinion). Sometimes it is to escalate to the decision maker. Know which situation you are in.

---

## Navigating Politics in Large Financial Institutions

Large financial institutions—banks, insurance companies, payment processors—are inherently political. Teams have territory. Executives have agendas. Budgets create conflicts. If you operate as if technical merit is all that matters, you will be confused and frustrated.

**Accept that politics exist**: Pretending they don't makes you ineffective. Understanding them makes you effective.

**Find the real decision makers**: The person with the title is not always the person who decides. In many financial institutions, a senior risk officer or compliance officer has an effective veto over architectural decisions. Find them early.

**Understand incentives**: People act in their interests. Before proposing a change, ask: "Who benefits from the current state? What do they lose if I succeed? How can I frame this so they benefit from the change, not just me?"

**Build relationships before you need them**: The worst time to start building a relationship with the security team lead is when you need their approval for your security design. Build it at a tech talk six months earlier.

**Don't make enemies**: In a large organisation, the person who blocks you today is the person you need a favour from next year. Find ways to give them partial wins, acknowledge their concerns, and avoid public humiliation even when you disagree.

---

## Documenting Decisions to Avoid Relitigating

One of the most expensive forms of waste in engineering organisations is relitigating decisions that were already made. The same debate recurs quarterly, consuming time from people who have more important things to do.

The solution is durable, findable documentation:

```markdown
# Decision: Standard for Inter-Service Authentication (mTLS vs JWT)

Date: 2026-10-01
Decision maker: Head of Architecture
Participants: Security Team, Platform Team, 4 Service Team Leads, Principal Engineer

DECISION: Use mTLS for service-to-service authentication via SPIFFE/SPIRE.
JWT is used for user-to-service authentication.

RATIONALE: [4 paragraphs; linked to RFC-039]

THIS DECISION IS CLOSED.
If you believe this decision should be revisited, bring evidence that:
1. The constraints that drove this decision have changed, OR
2. This decision is causing specific, measurable harm

Comments on this document will not reopen the decision. Raise a new RFC.
```

The last section is deliberate. Without it, every new engineer who encounters this decision starts the debate again.

---

## Key Takeaways

- Influence without authority requires a different mental model: make it easy for people to want what you think is right, rather than trying to make them do it
- Stakeholder mapping (interest × influence) identifies who to collaborate with, who to manage closely, and who to keep informed—not everyone needs the same level of engagement
- Craft different narratives for different audiences: engineers want technical evidence, product managers want customer impact, executives want risk and cost framing—same decision, different translation
- Pilots beat mandates every time: "try this in one service" is almost always accepted; "adopt this company-wide immediately" almost always meets resistance
- Acknowledge trade-offs before audiences raise them: the engineer who leads with the downside of their proposal builds credibility; the one who claims there are no downsides loses it
- Document decisions durably and explicitly mark them as closed to prevent relitigating—include the conditions under which you would reopen the decision

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A principal engineer wants to adopt a new API security framework across all teams. They propose it at an all-hands meeting and ask teams to adopt it immediately. The proposal is met with significant resistance. What is the most likely reason for the resistance and the better approach?",
      "options": ["The technical proposal is flawed and needs more work", "Mandating adoption without pilots creates resistance; a better approach is to implement it with one willing team first, demonstrate success, then propose it as a standard based on evidence", "Teams are inherently opposed to security improvements", "The all-hands meeting was the wrong forum; the proposal should have been an email"],
      "correct": 1,
      "explanation": "Mandates ('adopt this company-wide immediately') almost always meet resistance. Pilots ('let's try this in one service, measure results') are almost always accepted. The pilot approach also generates evidence — 'three teams have adopted this successfully' is more persuasive than 'I think this is the right approach.' Once pilots succeed, standards emerge from them naturally with built-in credibility."
    },
    {
      "text": "When communicating the same architectural decision (implementing circuit breakers on payment-critical paths) to an engineering manager vs a VP of Finance, what should change?",
      "options": ["Nothing — technical accuracy is paramount regardless of audience", "The level of detail: show code to engineers, show diagrams to executives", "The framing: engineers receive technical evidence and production data; executives receive risk quantification and cost framing (regulatory events, customer churn, remediation cost)", "The recommendation: recommend different solutions to different audiences based on their preferences"],
      "correct": 2,
      "explanation": "The same decision requires different narratives for different audiences — this is translation, not spin. Engineers respond to production metrics and concrete technical problems. Executives respond to financial risk, regulatory risk, and competitive positioning. Product managers respond to customer experience and conversion rates. Using the wrong frame for the audience fails to influence, regardless of technical merit."
    },
    {
      "text": "A principal engineer has proposed mTLS for inter-service authentication. A team lead raises a concern about operational complexity. How should the principal engineer respond?",
      "options": ["Dismiss the concern — the security benefit outweighs the operational complexity", "Listen to understand the concern fully before responding, categorise it (valid, solvable, or preference), and either modify the proposal or address the concern specifically", "Escalate to the VP Engineering to mandate the decision", "Agree to defer the decision to avoid conflict"],
      "correct": 1,
      "explanation": "Objections must be categorised before being addressed. A valid objection reveals a real problem and should modify the proposal. A solvable objection can be addressed directly (e.g., provide tooling to reduce operational complexity). A preference objection is acknowledged but may not change the decision. The worst response is to dismiss objections without engagement — it destroys credibility and hardens resistance."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Cross-Team Influence Campaign for a Payment Platform Security Standard",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design a stakeholder map for adopting zero-trust service identity (SPIFFE/SPIRE) across a 12-team payment platform. Identify at least 6 stakeholders, place each in the Interest × Influence matrix, and define a specific engagement strategy for each quadrant. For the 'Collaborate' quadrant stakeholders, describe how you would make them co-authors of the standard rather than recipients of it."},
    {"id": "2", "description": "Write three versions of the same proposal (implementing circuit breakers on fraud service calls): one for the payments engineering team (technical evidence focus), one for the product manager (customer impact focus), and one for the VP Engineering (risk and cost focus). Each version must be under 150 words and use real-world metrics such as error rates, support costs, or failed payment counts."},
    {"id": "3", "description": "Design a pilot-to-standard adoption plan for a new API authentication pattern: identify the ideal first-adopter team (and why), define success criteria for the pilot, specify the evidence you will collect to build social proof, and describe the transition from successful pilot to organisation-wide standard. Include a timeline with named milestones."},
    {"id": "4", "description": "Write a decision document that closes a contentious architectural debate (synchronous vs asynchronous fraud checks). The document must include: the decision, the rationale with trade-offs explicitly acknowledged, a summary of the rejected alternative and why, the conditions under which the decision would be reopened, and an explicit statement that this decision is closed to prevent relitigating."}
  ]
}
-->
