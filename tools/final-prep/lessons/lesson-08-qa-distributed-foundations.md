---
id: "track-17-lesson-08"
title: "Q&A 301-350: Distributed Systems Foundations"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 8
slug: "qa-distributed-foundations"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["distributed-systems", "consistency", "consensus", "partitioning", "interview"]
references:
  - "Martin Kleppmann, Designing Data-Intensive Applications (2017)"
  - "Diego Ongaro and John Ousterhout, In Search of an Understandable Consensus Algorithm (Raft), USENIX ATC 2014"
  - "Martin Kleppmann, How to do distributed locking (2016)"
---

## In one minute

Fifty interview questions on consistency models and CAP, consensus and leader election, replication and conflict resolution, partitioning, time and ordering, failure models, distributed transactions and sagas, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 301-350

@@QA qa/07-distributed-foundations.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1708-01",
    "question": "A 3-node Raft cluster loses 2 nodes. What happens?",
    "options": [
      "It can't commit: no majority",
      "It keeps committing",
      "It elects two leaders",
      "It switches to async replication"
    ],
    "correct": 0,
    "explanation": "A majority of 3 is 2."
  },
  {
    "id": "kc-1708-02",
    "question": "Why do you need fencing tokens with leases?",
    "options": [
      "For performance",
      "A paused holder may act after its lease expired; the resource must reject stale tokens",
      "To encrypt the lock",
      "To order Kafka messages"
    ],
    "correct": 1,
    "explanation": "Leases alone don't guarantee mutual exclusion."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1708",
  "title": "Drill Q301-Q350",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1708-01",
      "description": "Answer Q301-Q350 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1708-02",
      "description": "Draw a cross-shard transfer saga with clearing accounts and its compensation path."
    },
    {
      "id": "pc-1708-03",
      "description": "Explain linearizability vs serializability with one example each."
    }
  ]
}
-->
