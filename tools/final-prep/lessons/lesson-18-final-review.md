---
id: "track-17-lesson-18"
title: "Final Review: Your Misses, Pitches, Stories and the Day-Before Checklist"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 18
slug: "final-review"
difficulty: "senior"
estimatedMinutes: 65
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-17"]
tags: ["final-review", "interview", "checklist", "triage", "senior", "staff"]
references:
  - "Henry L. Roediger and Jeffrey D. Karpicke, Test-Enhanced Learning (Psychological Science, 2006)"
  - "Track 15 lessons: STAR stories, the 45-minute design round, mock interviews"
---

## In one minute

The last 65 minutes of the 12-hour plan, built from your own results: re-test what you missed, say your design pitches and stories aloud, re-read your one-page tip sheet, and run the day-before checklist. Nothing new is learned here: this block turns "I've read it" into "I can say it".

## The 65-minute block

| Minutes | Activity | Input |
|---|---|---|
| 0-20 | Re-answer every ✗ and ~ Q&A aloud, answers hidden; re-mark them | Your marks from lessons 2-11 |
| 20-30 | Re-take only the MCQs you missed or guessed | Your misses from lessons 14-15 |
| 30-45 | Say five 60-second design pitches aloud (below) | Track 14 and challenge notes |
| 45-55 | Say three STAR stories aloud: incident, disagreement, mistake | Track 15 lesson 1 |
| 55-60 | Re-read your one-page tip sheet | Lessons 16-17 |
| 60-65 | Day-before checklist (below) | |

If you still have more than 15 ✗ after the first 20 minutes, cut the stories to one and spend 10 more minutes on the bank with the most misses.

## Five pitches to say aloud (60 seconds each)

1. **Payment API with exactly-once effects:** idempotency key claimed with the payment intent under a unique constraint; PSP call outside the transaction; timeouts become UNKNOWN and are resolved by status query; outbox for events; reconciliation as proof.
2. **Double-entry ledger at scale:** balanced entries per currency enforced by a deferred trigger; append-only with reversals; ordered row locks; sub-accounts for hot accounts; sharding by account with sagas through clearing accounts.
3. **Distributed rate limiter:** token bucket per tenant in Redis via a Lua script using Redis time, checked after authentication; 429 with Retry-After; fail open for fairness, closed for value caps.
4. **Event-driven settlement and reconciliation:** idempotent file ingestion (hash plus sequence), streaming parse with validation, matching passes with no ambiguous auto-match, typed breaks with a maker-checker workflow.
5. **Moving a Spring service to virtual threads:** concurrency goes up, so the limits move downstream: pool sizes, semaphores, timeouts; check pinning (JDK version), `ThreadLocal`-heavy libraries; load test before and after.

## The day-before checklist

- [ ] I can state my 60–90 second "tell me about yourself".
- [ ] I have six STAR stories with one technical detail per action step and a lasting change at the end.
- [ ] I can draw my last system's architecture in two minutes and name its biggest risk.
- [ ] I can say the five pitches above without notes.
- [ ] I know the interview format and who I'm meeting (recruiter notes).
- [ ] My video, audio, screen sharing and a coding environment (JDK, IDE) are tested.
- [ ] I have two or three questions ready for each interviewer.
- [ ] I'll sleep at least seven hours; no new topics tonight.

## The last hour before the interview

- 10 minutes: say one design pitch and one story aloud.
- 5 minutes: read your one-page tip sheet.
- 5 minutes: breathe, water, set up the room.
- Then stop studying. A calm, rested brain recalls better than one more cram session.

## Recap

- Your misses are the most valuable study material you have; this block is built from them.
- Saying answers aloud is the rehearsal that interviews reward.
- Stop studying the night before; arrive rested.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1718-01",
    "question": "After the first 20 minutes of the final review you still have 20 questions marked ✗. What should you do?",
    "options": [
      "Ignore them and do the full block as planned",
      "Start the 12-hour plan again",
      "Read all 300 tips again",
      "Cut the stories to one and spend the time on the bank with the most misses"
    ],
    "correct": 3,
    "explanation": "Spend scarce time where your misses concentrate."
  },
  {
    "id": "kc-1718-02",
    "question": "What is the best use of the evening before the interview?",
    "options": [
      "A short rehearsal of pitches and stories, then rest",
      "Learn a new technology the company uses",
      "Re-read every Q&A bank",
      "A full mock interview loop until late"
    ],
    "correct": 0,
    "explanation": "Rehearse what you know and sleep; new material the night before mostly adds anxiety."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1718",
  "title": "Run the final block",
  "description": "Do the 65-minute block exactly as timed and record the result.",
  "tasks": [
    {
      "id": "pc-1718-01",
      "description": "Re-answer all ✗ and ~ Q&As aloud and record how many moved to ✓."
    },
    {
      "id": "pc-1718-02",
      "description": "Record yourself giving the five pitches and three stories; listen back once and fix one thing in each."
    },
    {
      "id": "pc-1718-03",
      "description": "Tick every item on the day-before checklist, or write what you'll do to tick it."
    }
  ]
}
-->
