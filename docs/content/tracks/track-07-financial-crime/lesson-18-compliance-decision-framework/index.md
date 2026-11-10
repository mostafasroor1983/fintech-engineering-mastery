---
id: track-07-lesson-18
title: "Principal Engineer's Compliance Architecture Decision Framework"
slug: compliance-decision-framework
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 18
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, compliance, architecture, trade-offs, staff-engineer]
prerequisites: [track-07-lesson-15, track-07-lesson-16, track-07-lesson-17]
---

# Principal Engineer's Compliance Architecture Decision Framework

> [!NOTE]
> Compliance architecture decisions are different from pure engineering decisions: a wrong choice doesn't just create technical debt — it creates regulatory liability. Principal engineers at financial institutions must translate regulatory obligations into system requirements, evaluate build vs buy trade-offs with regulatory risk in mind, and make latency/thoroughness trade-offs that the institution's risk appetite actually accepts.

## The Principal Engineer's Role in Compliance Architecture

As a principal or staff engineer in a financial institution, you will be asked to:

1. **Translate regulatory text into system requirements** — regulators write obligations, not specifications
2. **Review compliance architecture proposals** for technical soundness and regulatory coverage
3. **Make build vs buy decisions** for AML/KYC systems that have both technical and regulatory dimensions
4. **Define latency vs thoroughness trade-offs** that balance customer experience against compliance effectiveness
5. **Identify compliance anti-patterns** before they become examination findings

This lesson is a decision framework, not a tutorial. It assumes you have read the preceding lessons.

---

## 1. Regulatory Obligation to System Requirement Mapping

Regulators do not write system requirements. They write obligations in legal language. Translating them is the first engineering responsibility.

| Regulatory Obligation | System Requirement | Common Mistake |
|---|---|---|
| "Screen customers against sanctions lists" | Real-time screening at onboarding and payment initiation; re-screen on watchlist updates | Screening only at onboarding; not re-screening after OFAC updates |
| "Apply EDD to PEPs" | PEP flag blocks account activation until EDD is complete; EDD case SLA enforced | EDD case created but no enforcement on account; customer can transact during open EDD |
| "File SARs within 30 days" | Automated deadline tracking with escalation; no SAR can close without filing | Manual spreadsheet tracking; deadlines missed under investigation load |
| "Maintain records for 5 years" | Append-only storage; delete disabled; retention schedule enforced; legal hold system | Records deletable by DBAs; no mechanism to prevent premature deletion |
| "Monitor for suspicious activity" | Transaction monitoring with tuned rule sets and ML scoring; alert disposition workflow | Rules deployed but never tuned; alert queue backed up 6+ months |
| "Know your customer" | KYC document capture, verification, risk rating; periodic refresh | One-time KYC at onboarding; no refresh for existing customers |

### 1.1 Obligation Gap Analysis

```java
// Compliance Architecture Review Checklist (code as documentation)
public class ComplianceArchitectureReview {

    /*
     * Run this checklist for any new financial product or jurisdiction expansion
     *
     * 1. CUSTOMER DUE DILIGENCE (CDD)
     *    [ ] Identity verification at onboarding (documentary + biometric)
     *    [ ] PEP screening at onboarding
     *    [ ] Sanctions screening at onboarding
     *    [ ] Risk rating assigned at onboarding
     *    [ ] Periodic KYC refresh (risk-based frequency)
     *    [ ] Event-triggered re-KYC (address change, PEP appointment, etc.)
     *
     * 2. TRANSACTION MONITORING
     *    [ ] Rule-based alerts (velocity, amount, MCC risk)
     *    [ ] ML-based fraud scoring
     *    [ ] Alert queue with SLA enforcement
     *    [ ] Alert disposition workflow with audit trail
     *    [ ] SAR/STR filing pipeline with deadline management
     *    [ ] Structuring detection
     *
     * 3. SANCTIONS SCREENING
     *    [ ] Real-time screening at payment initiation
     *    [ ] All major lists (OFAC SDN, HMT, EU Consolidated, UN)
     *    [ ] Re-screening on watchlist update
     *    [ ] Blocking mechanism with override workflow
     *    [ ] Match resolution audit trail
     *
     * 4. REGULATORY REPORTING
     *    [ ] CTR (US): all cash >= $10k within 15 days
     *    [ ] SAR (US): all suspicious activity within 30/60 days
     *    [ ] STR (FATF): jurisdiction-specific deadlines
     *    [ ] Submission acknowledgement and rejection handling
     *    [ ] Amendment process
     *    [ ] Late filing tracking and justification
     *
     * 5. RECORDS AND RETENTION
     *    [ ] 5-7 year retention (jurisdiction-dependent)
     *    [ ] Append-only audit trail with hash chain
     *    [ ] Legal hold system
     *    [ ] Hot/warm/cold tiering for cost management
     *    [ ] Regulatory examination query API
     */
}
```

---

## 2. Build vs Buy Decision Framework

| Factor | Buy (Vendor) | Build (In-House) |
|---|---|---|
| Data freshness | Daily updates from provider | Requires maintaining own watchlist curation |
| Coverage | Multi-jurisdiction out of the box | Jurisdiction-specific only unless invested heavily |
| Upfront cost | License fee (often $500k-$5M/year) | Engineering months (often 12-24 months for initial build) |
| Ongoing cost | License + integration maintenance | Engineering team maintenance + data operations |
| Control | Limited — vendor controls data model | Full — but full responsibility |
| Regulatory risk | Vendor takes some risk for data quality | Full institution responsibility for coverage |
| Auditability | "We used World-Check" is a defensible answer | Must document own methodology |

**Recommendation for most institutions**: Buy screening data (sanctions, PEP) from established providers; build the orchestration layer, case management, and decision workflows in-house. The data is the defensible regulatory evidence; the workflow is your institutional competitive differentiator.

**When to build your own screening data**:
- You are a Tier 1 bank with volume that makes per-call pricing prohibitive (> $50M/year)
- You need a jurisdiction not covered by commercial providers
- You have intelligence assets that commercial providers lack (e.g., government-linked institution)

---

## 3. Real-Time vs Batch Screening Decisions

The core tension: real-time screening catches risk at the transaction boundary; batch screening can be more thorough. The wrong choice creates either latency problems or compliance gaps.

```
Decision tree:

Is the action irreversible within the time window?
├── YES (payment settlement, account opening)
│   └── Real-time screening required (< 2 seconds)
│       ├── Accept: false positive rate will be higher
│       └── Design: fast path with async enrichment for borderline cases
│
└── NO (periodic review, risk re-rating)
    └── Batch screening acceptable
        ├── Benefit: can use more thorough providers, more data
        └── Risk: gap between event and detection (acceptable for periodic)

Is the screening result blocking or advisory?
├── BLOCKING (account activation, payment authorisation)
│   └── Must be synchronous; fallback required when vendor unavailable
│
└── ADVISORY (risk score input, alert generation)
    └── Can be asynchronous; batch acceptable
```

### 3.1 Latency Budget for Real-Time Compliance

```
Payment authorisation latency budget (Visa/MC: 2 seconds total):

Sanctions screening:        250 ms  (cached: < 10 ms)
PEP quick check:             50 ms  (cached: < 5 ms)
Fraud ML scoring:            50 ms  (ONNX in-process)
Transaction rules engine:    30 ms
Database writes (audit):     50 ms
Network/serialisation:       70 ms
Remaining buffer:           500 ms
─────────────────────────────────────
Total:                     1,000 ms  (500ms buffer for variability)
```

The implication: **always cache screening results**. A cold-call to World-Check takes 300-800 ms. A cache hit is 5-10 ms. Without caching, you cannot hit the 2-second payment network timeout.

---

## 4. Latency vs Thoroughness Trade-offs

| Control | Latency | Thoroughness | Recommendation |
|---|---|---|---|
| Sanctions screening (cached) | 5-10 ms | High (24-hour cache TTL) | Cache mandatory for real-time |
| Sanctions screening (live) | 300-800 ms | Maximum | Only for onboarding/EDD |
| PEP screening (fuzzy match) | 50-200 ms | High | Full fuzzy match at onboarding; quick lookup at payment |
| Fraud ML scoring | 20-50 ms | High | ONNX in-process |
| Fraud ML scoring (sidecar) | 70-150 ms | High | Only if model too large for in-process |
| AML rules engine | 10-30 ms | Medium | Rules on critical features only for real-time |
| Graph analysis (Neo4j) | 50-500 ms | Very High | Async for payments; sync only for onboarding |
| Adverse media screening | 500 ms - 5 s | High | Only for onboarding/EDD; not real-time |

---

## 5. Risk Appetite and Technology Choices

Your institution's risk appetite document defines acceptable false positive rates, acceptable screening gaps, and tolerable latency. These feed directly into technology choices.

```
Risk Appetite Statement Examples:
"The institution will not onboard any customer who is on OFAC SDN list."
→ Sanctions screening must be synchronous and blocking at onboarding.
   Cache TTL must be < 24 hours.
   Fallback cannot approve potential matches.

"The fraud false positive rate must not exceed 0.5% of transactions."
→ ML model threshold calibration: set to achieve 0.5% FPR.
   Fallback rules cannot be more aggressive than model.
   Review queue must be staffed to handle disputed declines.

"Periodic KYC refresh must complete within 90 days for high-risk customers."
→ Batch screening job must process all high-risk customers monthly.
   SLA monitoring with escalation at 60 days.
   No high-risk customer account active beyond 90 days without refresh.
```

---

## 6. Common Compliance Anti-Patterns

**Anti-pattern 1: Fire-and-Forget Compliance**
Screening is called but its result doesn't block the action. The compliance team believes screening is in place; in reality, it's advisory.
```
// BAD: compliance check is non-blocking
screeningService.screenAsync(customer);  // async, result ignored
onboardCustomer(customer);               // proceeds regardless
```

**Anti-pattern 2: Stale Watchlist**
Screening database refreshed weekly from SFTP. OFAC publishes emergency updates outside the weekly cycle (happened after the Russia sanctions in 2022).
```
// BAD: manual SFTP pull, weekly
// GOOD: automated daily pull + on-demand refresh API + alert on refresh failure
```

**Anti-pattern 3: Alert Queue Backlog**
Transaction monitoring generates 10,000 alerts/day; team can review 500/day. Queue grows until it's unusable. The compliance control exists on paper but is non-functional.
```
// Address with: alert scoring (auto-dismiss low-risk), ML triage,
// and rule tuning to reduce false positives — not by ignoring the queue
```

**Anti-pattern 4: Soft Delete in Compliance Data**
Compliance records have a `deleted_at` column. A developer deletes "test data" that was actually a real customer's SAR history.
```sql
-- BAD:
ALTER TABLE compliance_events ADD COLUMN deleted_at TIMESTAMPTZ;
-- GOOD: immutable table; REVOKE DELETE; database trigger blocks mutation
```

**Anti-pattern 5: Compliance as a Post-Processing Step**
Compliance checks run after the transaction settles. By the time a sanctions match is detected, the payment has already left the institution.
```
// Compliance checks MUST be pre-authorisation, not post-settlement.
// Exception: batch re-screening can be post-settlement for advisory purposes.
```

**Anti-pattern 6: Single-Provider Dependency**
Institution depends on one RegTech vendor with no fallback. Vendor has an outage on a Monday morning. All onboarding and payment screening is blocked.
```
// Always have a fallback: secondary provider or internal watchlist cache
// Accept that fallback is less thorough — document the risk acceptance
```

**Anti-pattern 7: Compliance Bypass for VIP Customers**
A code path that skips PEP screening for "relationship banking" customers. The relationship manager overrides compliance controls for a large depositor.
```
// Every customer — no exceptions — goes through the same compliance pipeline.
// EDD is the appropriate mechanism for high-value customers, not bypassing screening.
```

---

## 7. Compliance Architecture Review Checklist for Principal Engineers

Use this checklist when reviewing any compliance-related architecture proposal:

**Data Integrity**
- [ ] Are compliance records truly immutable? (append-only, trigger to prevent mutations)
- [ ] Is there a hash chain or equivalent tamper-evidence mechanism?
- [ ] Are retention periods enforced programmatically, not manually?
- [ ] Is there a legal hold mechanism that overrides retention deletion?

**Screening Completeness**
- [ ] Does real-time screening have a fallback when providers are unavailable?
- [ ] Is cache TTL short enough to catch intraday watchlist updates?
- [ ] Are PEP RCAs (relatives and close associates) in scope?
- [ ] Is re-screening triggered on watchlist updates?

**Reporting Pipeline**
- [ ] Are filing deadlines tracked and alerted with escalation?
- [ ] Is the submission idempotent? (no duplicate filings on retry)
- [ ] Is XML validation run before submission?
- [ ] Is there a process for rejected filings (FinCEN rejections)?

**Latency and Fallback**
- [ ] Does real-time screening fit within the payment network timeout (2s)?
- [ ] Is caching used to meet latency requirements?
- [ ] Is the fallback for all blocking controls documented and tested?

**Audit Trail**
- [ ] Are all blocking decisions (decline, hold, escalate) in the audit trail?
- [ ] Can a regulator retrieve the complete history of any customer in < 60 seconds?
- [ ] Are audit events streamed to SIEM in real-time?

---

## 8. The Principal Engineer's Accountability

At a financial institution, the principal engineer's architecture decisions for compliance systems have a different weight than in other domains:

- An architecture that creates a sanctions gap can result in regulatory fines of $10M-$1B
- A principal engineer who knows about a compliance gap and fails to escalate it may bear personal regulatory responsibility
- Architecture decisions must be documented with rationale so that future engineers (and examiners) understand the trade-offs accepted

The right posture: **design for the regulator's examination**. Ask "how would I explain this architecture to an examiner who is looking for weaknesses?" If the answer is uncomfortable, fix the architecture before the examination finds it.

---

## Summary

Compliance architecture is engineering with regulatory liability. The principal engineer's responsibilities are: mapping regulatory obligations to system requirements (without losing meaning in translation), making build vs buy decisions that account for regulatory defensibility, calibrating real-time vs batch trade-offs against the institution's documented risk appetite, and identifying anti-patterns before they become examination findings. The most dangerous anti-patterns are non-blocking compliance checks, stale watchlists, unbounded alert queues, and mutable compliance records. The architectural test is simple: if a regulator asked you to prove that your compliance controls worked as designed on a specific date three years ago, could you answer within 24 hours?

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A regulator requires 'monitoring for suspicious activity.' What is the most critical anti-pattern that institutions make when implementing this obligation?",
      "options": ["Using too many rules in the detection engine", "Deploying rules but never tuning them, resulting in an alert queue backed up 6+ months — alerts never investigated cannot prevent financial crime", "Screening customers too frequently, creating unnecessary friction", "Using batch processing instead of real-time monitoring"],
      "correct": 1,
      "explanation": "The compliance anti-pattern table identifies: 'Rules deployed but never tuned; alert queue backed up 6+ months.' A monitoring system that generates alerts faster than analysts can investigate them does not meet the regulatory obligation — it creates the appearance of monitoring while genuine suspicious activity goes uninvestigated."
    },
    {
      "text": "What is the principal engineer's regulatory risk in a financial institution when designing compliance systems?",
      "options": ["Regulatory fines are borne entirely by the institution, not individual engineers", "An architecture that creates a sanctions gap can result in fines of $10M-$1B; a principal engineer who knows about a compliance gap and fails to escalate may bear personal regulatory responsibility", "Principal engineers are protected by employment contracts from personal liability", "Only the Chief Compliance Officer bears personal regulatory responsibility"],
      "correct": 1,
      "explanation": "Financial regulators (OCC, FRB, FinCEN) can hold individuals personally responsible for compliance failures. A principal engineer who designs a system with a known sanctions screening gap and fails to escalate it to leadership may bear personal regulatory and legal responsibility. Architecture decisions must be documented with rationale."
    },
    {
      "text": "When evaluating build vs buy for an AML system, what is the decisive regulatory dimension that pure engineering cost analysis misses?",
      "options": ["Total cost of ownership over 5 years", "Regulatory defensibility — a vendor with regulatory acceptance and examination track record provides coverage that an in-house build must earn independently, often over multiple examination cycles", "API throughput and latency benchmarks", "Number of configurable rule parameters"],
      "correct": 1,
      "explanation": "A vendor AML system with a track record of regulatory examination across multiple institutions provides immediate credibility. An in-house build must demonstrate regulatory acceptance through its first examination, which may take 1-3 years. The regulatory defensibility dimension — independent of pure technology merit — is the key factor that engineering cost analysis typically omits."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Conduct a Compliance Architecture Review",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Using the Obligation Gap Analysis checklist from this lesson, evaluate a hypothetical payment platform architecture that has: (a) sanctions screening at onboarding only (not at payment initiation), (b) PEP screening that creates EDD cases but does not block transactions during open EDD, (c) alert disposition tracked in a spreadsheet. Document the specific regulatory gap for each finding and cite the violated obligation."},
    {"id": "2", "description": "Design the real-time vs batch decision matrix for a fintech processing 100,000 transactions/day with 500,000 total customers. For each of the following checks, justify whether it should be real-time (synchronous, blocking), near-real-time (async, within 5 minutes), or batch (nightly): (a) OFAC sanctions screening, (b) PEP re-screening, (c) transaction risk scoring, (d) AML typology detection, (e) CTR aggregation."},
    {"id": "3", "description": "Identify the five most dangerous compliance anti-patterns in this architecture description and explain how to remediate each: 'We screen customers at onboarding, run monthly batch OFAC checks, have 15,000 open alerts with 3 analysts, store all compliance events in a mutable PostgreSQL table where the DBA can run DELETE queries, and our SAR filing deadline is tracked in a Jira ticket.' Each remediation must cite a specific pattern from the lesson."},
    {"id": "4", "description": "Write the ComplianceArchitectureReviewChecklist as a Java record with boolean fields for each of the 20+ checklist items in the lesson (Screening Completeness, Reporting Pipeline, Latency and Fallback, Audit Trail sections). Implement a reviewResult() method that returns PASS, ADVISORY (1-3 false items), FAIL (4+ false items), or CRITICAL (any item in the Audit Trail section is false). Write unit tests for all four outcomes."}
  ]
}
-->
