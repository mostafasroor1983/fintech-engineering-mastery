---
id: "track-17-lesson-09"
title: "Q&A 351-400: Distributed Patterns in Practice"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 9
slug: "qa-distributed-patterns"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["idempotency", "outbox", "saga", "resilience", "interview"]
references:
  - "Chris Richardson, Microservices Patterns (2018): Saga and Transactional Outbox"
  - "Debezium Documentation: Outbox Event Router (debezium.io)"
  - "AWS Builders Library: Timeouts, retries and backoff with jitter (Marc Brooker)"
---

## In one minute

Fifty interview questions on idempotency implementation, outbox and CDC operations, saga implementation, delivery semantics and ordering, backpressure and load shedding, resilience tuning, rate limiting, caching and integration patterns, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 351-400

@@QA qa/08-distributed-patterns.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1709-01",
    "question": "Two retries with the same key arrive together. Which implementation is safe?",
    "options": [
      "Check if the key exists, then insert",
      "A synchronized block",
      "Insert the key first under a unique constraint, in the payment transaction",
      "A cache lookup"
    ],
    "correct": 2,
    "explanation": "Only the database arbitrates across instances."
  },
  {
    "id": "kc-1709-02",
    "question": "What is the main risk of retrying at every layer?",
    "options": [
      "Lower latency",
      "Lost messages",
      "Deadlocks",
      "Load amplification (retry storms)"
    ],
    "correct": 3,
    "explanation": "3 layers x 3 retries = up to 27 calls."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1709",
  "title": "Drill Q351-Q400",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1709-01",
      "description": "Answer Q351-Q400 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1709-02",
      "description": "Run challenges C02 and C08 and explain each line of the idempotency store."
    },
    {
      "id": "pc-1709-03",
      "description": "Design an outbox relay that runs on three instances without double-publishing."
    }
  ]
}
-->
