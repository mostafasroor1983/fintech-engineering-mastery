---
id: "track-17-lesson-04"
title: "Q&A 101-150: Java Concurrency and Virtual Threads"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 4
slug: "qa-java-concurrency"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["concurrency", "virtual-threads", "jmm", "locks", "interview"]
references:
  - "Java Language Specification, chapter 17: Threads and Locks (Oracle)"
  - "JEP 444 Virtual Threads, JEP 491 Synchronize Virtual Threads without Pinning, JEP 505 Structured Concurrency (openjdk.org)"
  - "Brian Goetz et al., Java Concurrency in Practice (2006)"
---

## In one minute

Fifty interview questions on the Java Memory Model, locks and atomics, deadlocks, executors and pool sizing, CompletableFuture, virtual threads and pinning, structured concurrency, concurrent collections and production concurrency failures, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 101-150

@@QA qa/03-java-concurrency.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1704-01",
    "question": "You switch to virtual threads and requests start timing out on `getConnection`. Root cause?",
    "options": [
      "Downstream limit: the connection pool is now the bottleneck",
      "Pinning",
      "Virtual threads are slower",
      "GC pauses"
    ],
    "correct": 0,
    "explanation": "Concurrency rises; limits must be explicit."
  },
  {
    "id": "kc-1704-02",
    "question": "Which is atomic?",
    "options": [
      "`count++` on a volatile long",
      "`AtomicLong.incrementAndGet()`",
      "`map.get(k)` then `map.put(k, v+1)` on a ConcurrentHashMap",
      "Reading a long without synchronisation"
    ],
    "correct": 1,
    "explanation": "Volatile gives visibility only; use atomic operations or compute/merge."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1704",
  "title": "Drill Q101-Q150",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1704-01",
      "description": "Answer Q101-Q150 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1704-02",
      "description": "Run challenge C03's test and break it on purpose (lock in source-then-destination order) to see the deadlock in a thread dump."
    },
    {
      "id": "pc-1704-03",
      "description": "Explain in two minutes what changes when a Spring service moves to virtual threads."
    }
  ]
}
-->
