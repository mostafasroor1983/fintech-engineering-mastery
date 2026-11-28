---
id: "track-17-lesson-10"
title: "Q&A 401-450: Databases and Data Architecture"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 10
slug: "qa-databases"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["postgresql", "indexing", "mvcc", "replication", "interview"]
references:
  - "PostgreSQL 18 Documentation: Concurrency Control, Indexes, Routine Vacuuming (postgresql.org)"
  - "Markus Winand, Use The Index, Luke (use-the-index-luke.com)"
  - "Martin Kleppmann, Designing Data-Intensive Applications, chapters 5-7"
---

## In one minute

Fifty interview questions on PostgreSQL MVCC, vacuum and locks, indexing and query plans, schema design for money, partitioning, replication and high availability, choosing data stores, and correctness under concurrency, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 401-450

@@QA qa/09-databases.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1710-01",
    "question": "Which index serves `WHERE account_id = ? ORDER BY created_at DESC LIMIT 20` best?",
    "options": [
      "(account_id, created_at DESC)",
      "(created_at)",
      "(created_at, account_id)",
      "A GIN index"
    ],
    "correct": 0,
    "explanation": "Equality column first, then the sort column."
  },
  {
    "id": "kc-1710-02",
    "question": "Why can a short `ALTER TABLE` stop all traffic?",
    "options": [
      "It rewrites the table",
      "It waits for an ACCESS EXCLUSIVE lock behind a long transaction while new queries queue behind it",
      "It disables indexes",
      "It runs VACUUM FULL"
    ],
    "correct": 1,
    "explanation": "Set lock_timeout and retry."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1710",
  "title": "Drill Q401-Q450",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1710-01",
      "description": "Answer Q401-Q450 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1710-02",
      "description": "Write the DDL for postings with a deferred balancing trigger and test it with an unbalanced entry."
    },
    {
      "id": "pc-1710-03",
      "description": "Explain write skew with a daily-limit example and two fixes."
    }
  ]
}
-->
