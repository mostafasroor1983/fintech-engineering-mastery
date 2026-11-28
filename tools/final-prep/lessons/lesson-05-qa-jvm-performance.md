---
id: "track-17-lesson-05"
title: "Q&A 151-200: JVM, GC, Memory and Performance"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 5
slug: "qa-jvm-performance"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["jvm", "gc", "memory", "profiling", "interview"]
references:
  - "HotSpot Virtual Machine Garbage Collection Tuning Guide (Oracle, JDK 25)"
  - "JEP 439 Generational ZGC (openjdk.org)"
  - "Brendan Gregg, Systems Performance, 2nd edition (2020)"
---

## In one minute

Fifty interview questions on JVM memory areas, garbage collectors and GC logs, memory leaks and container memory, JIT and startup, profiling with JFR and async-profiler, and methodical performance engineering, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 151-200

@@QA qa/04-jvm-performance.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1705-01",
    "question": "Container OOM-killed, heap only at 70% of the limit. Most likely?",
    "options": [
      "Heap leak",
      "GC bug",
      "Non-heap memory (Metaspace, stacks, direct buffers) exceeded the limit",
      "CPU throttling"
    ],
    "correct": 2,
    "explanation": "Leave headroom with MaxRAMPercentage and check NMT."
  },
  {
    "id": "kc-1705-02",
    "question": "Which tool shows where threads wait (locks, I/O) when CPU is low?",
    "options": [
      "CPU-mode flame graph",
      "GC logs",
      "Heap dump",
      "Wall-clock profiling (async-profiler -e wall) or JFR thread events"
    ],
    "correct": 3,
    "explanation": "CPU profiles show burning time; wall-clock shows waiting."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1705",
  "title": "Drill Q151-Q200",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1705-01",
      "description": "Answer Q151-Q200 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1705-02",
      "description": "Enable GC logging and JFR on any Spring Boot app, load it for a minute, and identify the top allocation site."
    },
    {
      "id": "pc-1705-03",
      "description": "Explain how you'd size JVM memory for a 2 GiB container."
    }
  ]
}
-->
