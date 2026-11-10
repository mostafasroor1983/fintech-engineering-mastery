---
id: track-14-lesson-09
title: "Technical Reviews — Code, Design, and Architecture Reviews"
slug: technical-reviews
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 9
difficulty: principal
estimatedMinutes: 70
status: published
tags: [code-review, design-review, architecture-review, feedback, standards]
prerequisites: [track-14-lesson-08]
---

# Technical Reviews — Code, Design, and Architecture Reviews

> [!NOTE]
> A principal engineer's review carries disproportionate weight. Engineers look to your comments to understand what good looks like. When you flag something, teams pay attention. When you approve something with reservations, teams remember that too. The quality of your reviews shapes your organisation's technical standards more than any document you can write.

## The Principal Engineer's Role in Reviews

There is a spectrum of review engagement. Know which mode is appropriate:

**Standard code review**: You are one of several reviewers; you catch bugs, style issues, and obvious improvements. Your view is advisory.

**Domain expert review**: You are the most knowledgeable person about this component or pattern. Your review is authoritative for that domain.

**Standards review**: You are reviewing for compliance with organisational standards (security, compliance, architectural patterns). This is a gate—the PR cannot merge without addressing your concerns.

**Systemic issues escalation**: You notice a pattern across multiple PRs that indicates a deeper problem. You escalate this separately from the individual PR.

---

## Code Review Guidelines

### What to Flag (Blocking)

**Correctness**: Logic errors, race conditions, missing null checks in financial calculations, off-by-one errors in amount calculations.

**Security**: SQL injection, missing authentication, sensitive data in logs, hardcoded secrets, insecure crypto. Flag these as blocking, every time, even if the author is a senior engineer. Security issues do not get pass-throughs based on seniority.

**Compliance**: Missing audit logs on payment operations, non-compliant data retention, PAN handling that violates PCI DSS.

**Reliability**: Missing error handling for external service failures, unbounded loops, unbounded caches, missing circuit breakers on payment-critical paths.

### What to Flag (Non-blocking)

**Performance**: Potential performance issues that are not currently causing problems. "Consider lazy loading here—if the transaction history grows this could become slow." Flag with "nit" or "consider" to indicate non-blocking.

**Readability**: Naming that could be clearer, missing documentation for non-obvious code. These are improvements, not correctness issues.

**Style**: Deviations from team conventions. If your team has a linter, these should be automated and not in your review at all.

### What to Let Go

**Personal style preferences**: If the code is correct, secure, and readable, your preference for one valid approach over another is not a reason to request changes. Reserve your review capital for things that matter.

**Rewriting from scratch**: Resist the urge to suggest a completely different implementation when the current one is correct. The author has context you may not. Suggest improvements to what exists.

```java
// GOOD code review comment:
// BLOCKING — Security: This query concatenates user input directly into SQL.
// Use a parameterised query to prevent SQL injection.
// See ADR-003 and our secure coding guidelines in docs/security/sql-injection.md.
//
// Before:
// String sql = "SELECT * FROM transactions WHERE status = '" + status + "'";
//
// After:
// String sql = "SELECT * FROM transactions WHERE status = ?";
// return jdbcTemplate.query(sql, new Object[]{status}, transactionRowMapper);

// GOOD code review comment (non-blocking):
// Consider: If this cache grows large (>10k entries) it could cause GC pressure.
// Caffeine with maximumSize(10_000) would bound it.
// Not urgent, but worth tracking in our tech debt register.
// Not blocking — your call.

// BAD code review comment (personal preference, not actionable):
// I would have implemented this differently using the Strategy pattern.
// (Not specific, not blocking-worthy, adds friction without clear benefit)
```

---

## Design Review Structure

Design reviews happen before significant implementation work begins. Their purpose is to surface problems while changes are still cheap—before code is written.

### Design Review Checklist

```
CORRECTNESS
  [ ] Does the design solve the stated problem?
  [ ] Are edge cases handled? (network failures, partial failures, timeouts)
  [ ] Is the data model consistent with business requirements?
  [ ] Are idempotency and retry semantics defined for payment operations?

SECURITY (required for financial services)
  [ ] Is authentication required for all endpoints? What type?
  [ ] Is authorisation at the right granularity? (can a customer access only their own data?)
  [ ] What sensitive data is handled? How is it encrypted at rest and in transit?
  [ ] What are the trust boundaries? What is validated at each boundary?
  [ ] Has the design been reviewed against OWASP Top 10 for financial APIs?

COMPLIANCE
  [ ] Does this design handle PAN or other cardholder data? PCI DSS scope?
  [ ] Does it process personal data? GDPR implications?
  [ ] Are audit logs generated for all payment-relevant operations?
  [ ] Does the design respect the mandated data retention periods?

OPERABILITY
  [ ] What observability does this design produce? Metrics, logs, traces?
  [ ] How is the system monitored? What are the alerting thresholds?
  [ ] What are the failure modes? Is there a runbook for each?
  [ ] How is the service deployed? What is the rollback procedure?
  [ ] How does it degrade gracefully under load?

SCALABILITY
  [ ] What is the peak throughput this must support? Has it been tested?
  [ ] Where are the bottlenecks? Database? External services? CPU?
  [ ] What happens at 2x expected load? 10x?

COMPLIANCE (financial services addition)
  [ ] Does this change require regulatory approval or notification?
  [ ] Does it introduce new data processing activities requiring a DPIA?
```

### Running a Design Review Meeting

```
Pre-work (required):
  Design document distributed 2 days before meeting
  Reviewers expected to have read it; first 10 minutes not for introductions

Meeting structure (60 minutes):
  0-5 min:  Author states the problem being solved (not the solution)
            "We're trying to solve X. Here are the constraints."

  5-15 min: Clarifying questions only
            "I want to understand Y before I form an opinion about the design."

  15-45 min: Review by checklist section
             Security first (most critical for fintech)
             Then: correctness, operability, scalability

  45-55 min: Open issues and owners
             "Three open issues identified. Owner and deadline for each."

  55-60 min: Decision
             Approved | Approved with conditions | Revise and resubmit
```

---

## Architecture Review Board

For decisions that affect multiple teams or the entire platform, an Architecture Review Board (ARB) provides organisational governance.

### ARB Composition

```
Voting members:
  Principal Engineers (usually 2-3)
  Security Lead
  Head of Infrastructure/Platform

Advisory (non-voting):
  Engineering Managers (business context)
  Compliance Officer (regulatory input)
  
Decisions require:
  Quorum: at least 3 voting members
  Consensus or decision by Principal Engineer + Security Lead
```

### What Goes to the ARB

**Always**: New data stores (new database or cache technology), new external service dependencies, significant changes to authentication/authorization model, any design that processes PAN or personal data in a new way.

**When in doubt**: If the decision affects more than one team's operational model or introduces a new technology to the platform.

### ARB Decision Record

```markdown
# ARB-012: Use of Redis for Rate Limiting

Date: 2026-10-15
Attendees: 3 Principal Engineers, Security Lead, Head of Platform

Decision: APPROVED

Conditions:
  1. Redis cluster must be in a dedicated namespace with NetworkPolicy isolation
  2. Redis access credentials via Vault dynamic secrets (not static config)
  3. PAN or sensitive customer data must NOT be stored in Redis
     (rate limiting counters only — no customer data)
  4. Redis health check required in payment-service readiness probe
  
Review required if:
  - Redis is used to store data beyond rate limiting counters
  - Redis cluster is shared with other non-payment services
```

---

## Giving Constructive Feedback on Others' Designs

The principal engineer's review of a design produced by another team is delicate. You are senior, your opinion carries weight, and you can inadvertently discourage future design sharing.

**Ask questions first, offer conclusions second**:

```
Instead of: "This design has a race condition in the concurrent update path."

Try: "Walk me through what happens when two requests update the same account balance
simultaneously. What is the expected outcome? What actually happens with this implementation?"

Letting the author discover the issue through your questions is more educational
and less demoralising than being told the conclusion.
```

**Acknowledge what works before identifying what needs improvement**:

```
"The fraud score caching approach is well-designed—the TTL and invalidation strategy
are both correct. The area I want to explore is the concurrent update handling.
Can we walk through the scenario where..."
```

**Separate "you must change this" from "you might want to consider this"**:

```
// In written review:
// MUST CHANGE: [blocking items — correctness, security, compliance]
// CONSIDER: [non-blocking improvements — performance, readability, future-proofing]
// QUESTION: [things you don't understand yet — not necessarily problems]
```

---

## Escalation Paths for Systemic Issues

A design review or code review is not the right venue for fixing systemic problems. If you notice the same pattern across three PRs from three different teams, you have a systemic issue:

```
Systemic issue detected: 3 PRs this month with SQL injection vulnerabilities

Do:
  - Approve (or request changes on) each PR on its own merits
  - Write a postmortem / "systemic issue" document: 3 cases, root cause, impact
  - Propose the fix: add Semgrep SQL injection rule to CI pipeline
  - Write an RFC if the fix requires cross-team coordination
  - Present at the next engineering all-hands: "here's a pattern we need to eliminate"

Don't:
  - Reject all three PRs without explanation, citing systemic concern
  - Have the same conversation three separate times with three separate teams
  - Assume the problem will fix itself
```

---

## Key Takeaways

- Know which review mode you are in: standard reviewer (advisory), domain expert (authoritative), or standards reviewer (gate)—each requires different engagement
- Always flag security and compliance issues as blocking, regardless of the author's seniority—these are organisational standards, not personal preferences
- Ask questions before stating conclusions in design reviews: letting authors discover issues through questions is more educational and less demoralising than delivering verdicts
- Use a structured design review checklist for fintech: correctness, security, compliance, operability, scalability—in that order
- Separate blocking feedback (correctness, security, compliance) from non-blocking suggestions (performance, readability) explicitly in written reviews
- Systemic issues spotted in reviews require a separate proposal (RFC, Semgrep rule, guideline update)—the individual PR review is not the right venue for fixing organisational patterns

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A principal engineer is reviewing a PR from a staff engineer and notices a SQL injection vulnerability. The engineer is very senior and well-regarded. How should the principal engineer handle this?",
      "options": ["Let it pass with a non-blocking comment to avoid damaging the relationship", "Raise it as a blocking issue — security issues are never pass-throughs regardless of the author's seniority, because these are organisational standards not personal preferences", "Mention it verbally in a 1:1 to avoid public embarrassment", "Flag it as non-blocking since the staff engineer likely already knows"],
      "correct": 1,
      "explanation": "Security and compliance issues are always blocking, regardless of the author's seniority. These are organisational standards — not personal preferences — and must be enforced consistently. Applying them inconsistently based on seniority undermines the standard and creates the perception that security is optional for senior engineers. The principal engineer's own credibility as a standards guardian depends on consistent enforcement."
    },
    {
      "text": "During a design review, a principal engineer suspects a race condition in the concurrent account balance update path. What is the preferred way to surface this in the meeting?",
      "options": ["State directly: 'This design has a race condition in the concurrent update path'", "Skip it and address it separately after the meeting to avoid derailing the review", "Ask a question: 'Walk me through what happens when two requests update the same account balance simultaneously — what is the expected outcome?' and let the author discover the issue", "Reject the design immediately and request a resubmission"],
      "correct": 2,
      "explanation": "Questions are more educational and less demoralising than conclusions. When the author discovers an issue through the reviewer's questions, they own the insight and are more likely to fix it correctly. Stating the conclusion directly — especially when the reviewer is senior — can be demoralising and discourages future design sharing. The goal is to improve the design and develop the engineer, not just find problems."
    },
    {
      "text": "A principal engineer notices the same SQL injection pattern across three PRs from three different teams this month. What is the correct response?",
      "options": ["Reject all three PRs citing systemic concern and wait until the problem is solved organisation-wide", "Review each PR individually on its merits, then write a separate systemic issue document proposing a Semgrep rule to catch this pattern in CI for all teams", "Approve all three PRs to avoid blocking delivery and address the pattern separately", "Have the same SQL injection conversation three times with three separate teams through individual PR comments"],
      "correct": 1,
      "explanation": "The individual PR review is not the venue for fixing systemic problems. Each PR should be reviewed on its own merits (SQL injection is blocking — request changes). But the systemic issue requires a separate response: documenting the pattern, identifying the root cause, and proposing a systemic fix (e.g., Semgrep rule in CI). Having the same conversation three separate times is inefficient and fails to prevent the pattern in the fourth team."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Technical Review Framework Implementation for a Payment Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Write a complete code review for a hypothetical payment service PR that contains: (1) a SQL injection vulnerability in a transaction search endpoint, (2) a missing null check in an amount calculation, (3) an unbounded cache for payment history, and (4) a minor naming inconsistency. For each finding, write a code review comment in the format shown in the lesson — marking each as BLOCKING or non-blocking with the rationale, and linking to relevant documentation (ADR, secure coding guidelines, tech debt register)."},
    {"id": "2", "description": "Conduct a design review using the fintech checklist for a proposed real-time fraud scoring service. The service: processes card transactions synchronously, stores transaction features in Redis, calls an ML model via REST, and returns a risk score within 50ms. Walk through each checklist section (correctness, security, compliance, operability, scalability) and document at least 2 findings per section. Assign each finding a priority (MUST CHANGE / CONSIDER / QUESTION) and an owner."},
    {"id": "3", "description": "Design an Architecture Review Board (ARB) process for a fintech platform team of 150 engineers across 12 teams. Specify: ARB composition and voting rules, the threshold for what requires ARB review vs team-level design review, an ARB submission template, the meeting cadence and timebox, and an escalation path for urgent decisions that cannot wait for the next ARB session. Include an example ARB decision record for adopting a new secrets management approach."},
    {"id": "4", "description": "Create a Semgrep rule set that detects three systemic code quality issues found in a hypothetical audit of a payment service codebase: (1) direct string concatenation into SQL queries, (2) logging of objects that may contain card numbers (types containing 'card', 'pan', or 'account'), and (3) HTTP calls without timeout configuration. For each rule, write the Semgrep YAML pattern and a CI pipeline configuration that fails the build on any match."}
  ]
}
-->
