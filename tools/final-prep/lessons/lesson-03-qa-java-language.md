---
id: "track-17-lesson-03"
title: "Q&A 51-100: Java Language, Records and Value Objects"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 3
slug: "qa-java-language"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["java", "records", "collections", "generics", "interview"]
references:
  - "Java Language Specification, Java SE 25 (Oracle)"
  - "JEP 395 Records, JEP 409 Sealed Classes, JEP 441 Pattern Matching for switch, JEP 506 Scoped Values (openjdk.org)"
  - "Joshua Bloch, Effective Java, 3rd edition (2018)"
---

## In one minute

Fifty interview questions on records and value objects, equality and hashing, collections and their complexity, generics, modern Java features (sealed types, pattern matching, scoped values), exceptions, streams and object design, each with a concise answer that covers the trade-off, the edge case or the production failure mode an interviewer is listening for. The answers are hidden: read the question, **answer aloud in about 30 seconds**, then open it and compare. Budget: **40 minutes** (about 45 seconds per question, plus marking).

## How to use this bank

1. Answer before you open. If you can't start an answer within 10 seconds, mark the question and move on.
2. When you open an answer, check the *mechanism* and the *failure mode*, not the wording.
3. Mark each question: ✓ (solid), ~ (partial), ✗ (missed). Revisit only ~ and ✗ in the final review block (lesson 18).
4. Say the answer in your own words once more after reading it; that is what moves it into memory.

## Questions 51-100

@@QA qa/02-java-language.txt@@

## Recap

- Mark your ~ and ✗ questions; they are your input to the final review block.
- Every strong answer names a mechanism, a cost, and what happens when it fails.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1703-01",
    "question": "Why can a record still be mutated from outside even though its fields are final?",
    "options": [
      "Records aren't final",
      "Reflection always allows it",
      "A component may be a mutable object (e.g. a List) unless copied defensively",
      "Accessors return copies by default"
    ],
    "correct": 2,
    "explanation": "Records are shallowly immutable; copy collections with List.copyOf in the compact constructor."
  },
  {
    "id": "kc-1703-02",
    "question": "`new BigDecimal(\"1.0\").equals(new BigDecimal(\"1.00\"))` returns?",
    "options": [
      "true",
      "It throws",
      "Depends on the JVM",
      "false, because equals compares scale too"
    ],
    "correct": 3,
    "explanation": "Use compareTo for numeric equality or normalise scale."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1703",
  "title": "Drill Q51-Q100",
  "description": "Turn reading into recall: answer aloud first, then check.",
  "tasks": [
    {
      "id": "pc-1703-01",
      "description": "Answer Q51-Q100 aloud with the answers hidden and mark the weak ones."
    },
    {
      "id": "pc-1703-02",
      "description": "Write a `Money` record with a validating compact constructor and a `plus` that rejects currency mismatches; compare with challenge C01."
    },
    {
      "id": "pc-1703-03",
      "description": "Explain PECS with one example from payment code."
    }
  ]
}
-->
