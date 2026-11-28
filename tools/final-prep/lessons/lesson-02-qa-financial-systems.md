---
id: "track-17-lesson-02"
title: "Q&A 1-50: Financial Systems and Payments"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 2
slug: "qa-financial-systems"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["payments", "ledger", "reconciliation", "compliance", "interview"]
references:
  - "ISO 20022 message definitions (iso20022.org)"
  - "PCI DSS v4.0.1 (PCI Security Standards Council, 2024)"
  - "Martin Fowler, Analysis Patterns: Accountability and Account patterns (1996)"
---

## In one minute

Fifty interview questions on money representation, ledgers and double entry, the card and instant-payment lifecycle, settlement and reconciliation, wallets and FX, fraud and compliance, and the operational reality of 24/7 finance, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 1-50

@@QA qa/01-financial-systems.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1702-01",
    "question": "A PSP call times out after you sent a capture. What do you tell the client and store?",
    "options": [
      "UNKNOWN/pending, return 202, resolve by status query and reconciliation",
      "FAILED; the client should retry",
      "SUCCEEDED, since most timeouts succeed",
      "Nothing until the PSP calls back"
    ],
    "correct": 0,
    "explanation": "A timeout is an unknown outcome; failing it invites a double charge."
  },
  {
    "id": "kc-1702-02",
    "question": "What keeps a journal entry with postings GBP +1000 / EUR -1000 out of the ledger?",
    "options": [
      "Nothing; amounts net to zero",
      "A per-currency balance check (each currency must sum to zero)",
      "A foreign key",
      "Optimistic locking"
    ],
    "correct": 1,
    "explanation": "Different currencies never net; each must balance separately, with FX through position accounts."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1702",
  "title": "Drill Q1-Q50",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1702-01",
      "description": "Answer Q1-Q50 aloud with the answers hidden; mark every question you couldn't answer in about 30 seconds."
    },
    {
      "id": "pc-1702-02",
      "description": "For your three weakest questions, write a 3-sentence answer from memory, then compare with the lesson."
    },
    {
      "id": "pc-1702-03",
      "description": "Explain authorisation, capture, settlement and chargeback to an imaginary new team member in two minutes."
    }
  ]
}
-->
