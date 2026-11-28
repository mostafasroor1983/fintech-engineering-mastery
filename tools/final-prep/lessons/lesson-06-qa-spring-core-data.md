---
id: "track-17-lesson-06"
title: "Q&A 201-250: Spring Core, Boot, Transactions and Data"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 6
slug: "qa-spring-core-data"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["spring", "spring-boot", "transactions", "jpa", "interview"]
references:
  - "Spring Framework Reference Documentation 7.0: Data Access, Web MVC (docs.spring.io)"
  - "Spring Boot 4.0 Reference Documentation and Release Notes (docs.spring.io)"
  - "Vlad Mihalcea, High-Performance Java Persistence (2016)"
---

## In one minute

Fifty interview questions on dependency injection and auto-configuration, proxies and AOP, transaction propagation and isolation, JPA performance and locking, REST API design in Spring, Actuator and operations, testing, and Spring Boot 4, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 201-250

@@QA qa/05-spring-core-data.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1706-01",
    "question": "`@Transactional` on a private method called from the same class. Effect?",
    "options": [
      "No transaction: proxies don't intercept private or self-invoked methods",
      "Works normally",
      "Compile error",
      "Starts a nested transaction"
    ],
    "correct": 0,
    "explanation": "Move the method to another bean or restructure."
  },
  {
    "id": "kc-1706-02",
    "question": "What replaced `@MockBean` in Spring Boot 4?",
    "options": [
      "`@Mock`",
      "`@MockitoBean` from Spring Framework's test module",
      "`@TestBean` only",
      "Nothing; mocks are discouraged"
    ],
    "correct": 1,
    "explanation": "Deprecated in 3.4, removed in 4.0."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1706",
  "title": "Drill Q201-Q250",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1706-01",
      "description": "Answer Q201-Q250 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1706-02",
      "description": "Write a Testcontainers test that proves a transaction rolls back when the second of two inserts fails."
    },
    {
      "id": "pc-1706-03",
      "description": "Explain the intent / remote call / result pattern for PSP calls without holding a transaction."
    }
  ]
}
-->
