---
id: "track-17-lesson-13"
title: "Coding Challenges C06-C10: Reconciliation, Velocity, Retry, Consistent Hashing, Circuit Breaker"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 13
slug: "coding-challenges-2"
difficulty: "senior"
estimatedMinutes: 60
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-12"]
tags: ["coding", "java", "distributed-systems", "resilience", "reconciliation", "interview"]
references:
  - "Marc Brooker, Exponential Backoff and Jitter (AWS Architecture Blog, 2015)"
  - "David Karger et al., Consistent Hashing and Random Trees (STOC 1997)"
  - "Resilience4j CircuitBreaker documentation (resilience4j.readme.io)"
---

## In one minute

Five more problems, now at the boundary between code and distributed systems: matching bank lines to the ledger, a fraud velocity rule, retries with backoff and jitter, consistent hashing, and a circuit breaker. As in lesson 12, every solution is tested in `examples/track-17-coding`. **Budget: 60 minutes.** Solve one from scratch in 25 minutes (C08 or C10 are classic interview picks), then read the other four.

---

## C06: Reconciliation matcher

**Problem.** Match bank statement lines to ledger items and classify everything left over. Pass 1 matches by exact reference (same amount and currency). Pass 2 matches by amount, currency and value date within a tolerance, **only when there is exactly one candidate**. Leftovers are breaks: missing in ledger, missing at bank, or ambiguous.

**Edge cases.** Two ledger items with the same amount and date (ambiguous: never auto-match); a reference that appears on two ledger items (don't trust it); a reference match with a different amount; currency mismatch; dates just outside the tolerance; each line and item used at most once.

@@JAVA Reconciler.java@@

**Complexity and notes.** Pass 2 is O(lines × items) here; in production, index candidates by (currency, amount) in a map so each lookup is O(k) for k candidates. Record the rule that matched for audit. *Follow-ups:* many-to-one matches (one bank line paying several invoices); tolerance for fees netted by the bank.

---

## C07: Card velocity check (sliding window)

**Problem.** Decline an authorisation if, for that card, the number of authorisations or their total amount within the last `window` would exceed the limits. Approved authorisations are recorded; declined ones aren't.

**Edge cases.** An event exactly at the window boundary; many cards (memory per card stays bounded); concurrent checks on one card (the count must hold); out-of-order timestamps (assume ordered per card, or note it as a follow-up).

@@JAVA VelocityChecker.java@@

**Complexity and notes.** Amortised O(1) per check (each event is added and evicted once); memory is O(events in the window) per card. Locking is per card. Idle cards keep their deque forever here; production needs eviction (Caffeine with expiry) or a Redis sorted set per card. *Follow-ups:* distributed version, out-of-order events, and limits in multiple currencies.

---

## C08: Retry with capped exponential backoff and full jitter

**Problem.** Retry a call only for retryable errors, up to `maxAttempts`, waiting a random delay in `[0, min(cap, base × 2^attempt)]` (full jitter), and give up early if the next delay would exceed an overall deadline. Preserve interruption.

**Edge cases.** Non-retryable error on the first attempt (no retry); the last attempt fails (rethrow the real error); the deadline reached before max attempts; interruption during sleep; shift overflow for large attempt counts.

@@JAVA Retrier.java@@

**Complexity and notes.** No shared state, so it's thread-safe. Inject the sleeper, clock and random source so tests are instant and deterministic. Full jitter de-synchronises clients and prevents retry waves. *Follow-ups:* retry budgets across a fleet; honouring `Retry-After`; why you must never retry a non-idempotent POST without an idempotency key.

---

## C09: Consistent hashing with virtual nodes

**Problem.** Map keys (account ids) to nodes so that adding or removing a node moves only about 1/N of the keys, with even load.

**Edge cases.** An empty ring; wrap-around past the largest hash; removing a node returns its keys to neighbours only; hash collisions between nodes; stable hashing across JVMs (don't use `String.hashCode` distribution assumptions).

@@JAVA ConsistentHashRing.java@@

**Complexity and notes.** Lookup O(log V) for V virtual points (`TreeMap.tailMap`); adding a node O(v log V). The test checks that adding a 5th node moves 12–28% of 20,000 keys (ideal 20%) and that moved keys only go to the new node. *Follow-ups:* weighted nodes (more virtual nodes for bigger machines); replication to the next R distinct nodes; how Kafka (fixed partitions) differs.

---

## C10: Circuit breaker

**Problem.** CLOSED counts consecutive failures; at the threshold it OPENs and fails fast. After the open duration, HALF_OPEN lets exactly one trial call through: success closes it, failure re-opens it. Calls run outside the lock.

**Edge cases.** Concurrent calls in HALF_OPEN (only one probe); a slow call that started while CLOSED and succeeds after the breaker opened (must **not** close it); a late failure from before opening (must not refresh the open timer); the clock injected.

@@JAVA CircuitBreaker.java@@

**Complexity and notes.** O(1); the lock is held only for state transitions, never during the call. Production breakers use sliding windows (failure rate over the last N calls or seconds) and slow-call thresholds; Resilience4j is the usual choice. *Follow-ups:* what the fallback is for a payment call (an "unknown, check later" status, not "failed"); combining with retries and bulkheads.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1713-01",
    "question": "Why does C06 refuse to match a bank line when two ledger items have the same amount and date?",
    "options": [
      "For performance",
      "A wrong guess hides two real breaks; ambiguity must go to a person",
      "Because references are always present",
      "It's a limitation of Java streams"
    ],
    "correct": 1,
    "explanation": "Reconciliation must never invent a match it can't justify."
  },
  {
    "id": "kc-1713-02",
    "question": "Why does C10's half-open state allow only one trial call?",
    "options": [
      "To save threads",
      "Because Java can't run two calls at once",
      "To probe the dependency without flooding it while it may still be failing",
      "To keep the breaker open longer"
    ],
    "correct": 2,
    "explanation": "One probe tests recovery; letting all traffic through could knock a recovering service over again."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1713",
  "title": "Explain and extend",
  "description": "Interviewers often ask for an extension after the first solution works.",
  "tasks": [
    {
      "id": "pc-1713-01",
      "description": "Solve C08 or C10 from scratch in 25 minutes with one test that uses an injected clock."
    },
    {
      "id": "pc-1713-02",
      "description": "Extend C07 so idle cards are evicted (for example with a periodic sweep or Caffeine) and explain the trade-off."
    },
    {
      "id": "pc-1713-03",
      "description": "Explain aloud how C09 changes if each node must also hold replicas on the next two distinct nodes."
    }
  ]
}
-->
