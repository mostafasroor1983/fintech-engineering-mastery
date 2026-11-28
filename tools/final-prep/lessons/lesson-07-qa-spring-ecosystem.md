---
id: "track-17-lesson-07"
title: "Q&A 251-300: Spring Security, Cloud, Batch, Messaging and AI"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 7
slug: "qa-spring-ecosystem"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["spring-security", "spring-batch", "kafka", "spring-ai", "interview"]
references:
  - "Spring Security 7 Reference (docs.spring.io)"
  - "Spring for Apache Kafka and Spring Batch Reference Documentation (docs.spring.io)"
  - "Apache Kafka Documentation 4.x: Design and Semantics (kafka.apache.org)"
---

## In one minute

Fifty interview questions on Spring Security and OAuth2, resilience with Spring Cloud and Resilience4j, Spring Batch restartability, Kafka and RabbitMQ with Spring, Spring Integration, Spring AI, and observability, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 251-300

@@QA qa/06-spring-ecosystem.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1707-01",
    "question": "A Spring Batch job restarts after failing mid-way. What must the writer be?",
    "options": [
      "Fast",
      "Transactional across all chunks",
      "Idempotent, because a partially processed chunk may run again",
      "Single-threaded"
    ],
    "correct": 2,
    "explanation": "Restart resumes after the last committed chunk."
  },
  {
    "id": "kc-1707-02",
    "question": "Kafka EOS with a consumer that writes to PostgreSQL. What else do you need?",
    "options": [
      "Nothing",
      "acks=0",
      "A single partition",
      "An idempotent consumer (processed-event table in the same DB transaction)"
    ],
    "correct": 3,
    "explanation": "EOS covers Kafka-to-Kafka only."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1707",
  "title": "Drill Q251-Q300",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1707-01",
      "description": "Answer Q251-Q300 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1707-02",
      "description": "Sketch a Spring Kafka consumer configuration with retries, a dead-letter topic and an idempotent write."
    },
    {
      "id": "pc-1707-03",
      "description": "Explain how you'd use Spring AI in a regulated product without letting the model move money."
    }
  ]
}
-->
