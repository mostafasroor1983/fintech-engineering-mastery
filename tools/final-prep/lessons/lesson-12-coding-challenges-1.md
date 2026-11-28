---
id: "track-17-lesson-12"
title: "Coding Challenges C01-C05: Money, Idempotency, Transfers, Rate Limiting, Ledger"
track: "track-17"
trackName: "Final Interview Prep"
sequence: 12
slug: "coding-challenges-1"
difficulty: "senior"
estimatedMinutes: 60
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["coding", "java", "concurrency", "idempotency", "money", "interview"]
references:
  - "Java SE 25 API: java.util.concurrent, java.math.BigDecimal, java.util.Currency (Oracle)"
  - "Martin Fowler, Patterns of Enterprise Application Architecture (2002): Money pattern and allocation"
---

## In one minute

Five coding problems that come up in fintech interviews, each with a problem statement, edge cases, a clean reference solution in plain Java 21, and notes on complexity and concurrency. Every solution here is copied from `examples/track-17-coding` and tested by `ChallengesTest`, including concurrency tests that race 20 to 50 threads. **Budget: 60 minutes.** Pick one challenge and solve it from scratch in 25 minutes with a test, then read the other four (about 7 minutes each).

Run the tests yourself: `cd examples && mvn test -pl track-17-coding`.

## How to practise

1. Read the problem and write down the edge cases *before* looking at the list.
2. Code the simplest correct solution, talking through it as you would in an interview.
3. Write the nastiest test you can think of (concurrency, overflow, duplicate input).
4. Compare with the reference solution, especially the edge cases you missed.

---

## C01: Money value object with fair allocation

**Problem.** Implement an immutable `Money` type holding an amount and an ISO 4217 currency. Support `plus` and `minus` (same currency only), parsing from a decimal string, and `allocate(int... ratios)`, which splits an amount by ratios without creating or losing a single minor unit.

**Edge cases.** Currency mismatch; more decimals than the currency allows (`1.005 GBP`); currencies with 0 or 3 decimal places (JPY, KWD); overflow; negative amounts; ratios that sum to zero or include negatives; 100 split three ways (34/33/33).

**Approach.** Store minor units in a `long` (exact, fast, simple equality). Allocation: floor each share, then hand the leftover units to the largest remainders, one each.

@@JAVA Money.java@@

**Complexity and notes.** `allocate` is O(n²) in the number of ratios because of the leftover loop (n is tiny; use a sort for large n). It's immutable, so it's thread-safe by construction. *Follow-ups:* "Why not `double`?" (binary fractions); "Why `longValueExact`?" (reject silent rounding); "Who gets the extra penny?" (document the tie-break: earliest wins).

---

## C02: Idempotency store with in-flight de-duplication

**Problem.** `execute(key, requestHash, operation)` must run the operation at most once per key even when retries arrive concurrently; concurrent callers with the same key get the same result; a reused key with a different request is rejected; failures are not remembered (so a retry can succeed).

**Edge cases.** 50 concurrent identical requests; same key with a different body; the operation throws (waiters must not hang and the key must be released); the operation throws an `Error`; null keys.

**Approach.** An atomic claim with `putIfAbsent` of a `CompletableFuture`: the winner runs the operation and completes the future, and the others `join()` it.

@@JAVA IdempotencyStore.java@@

**Complexity and notes.** O(1) per call. Waiters block on `join()`, so with virtual threads that's cheap. In production the map is a table with a unique key claimed in the same transaction as the side effect, plus a retention period. *Follow-ups:* "What if the process crashes mid-operation?" (an IN_PROGRESS row needs a recovery job); "Why not `synchronized`?" (it would serialise unrelated keys).

---

## C03: Deadlock-free concurrent transfers

**Problem.** Implement `transfer(from, to, amount)` between in-memory accounts so that concurrent transfers never deadlock, never lose money, and never take a balance below zero.

**Edge cases.** Opposite-direction transfers running concurrently (A→B and B→A); self-transfer; unknown accounts; zero or negative amounts; many threads draining one account.

**Approach.** Lock both accounts in a global order (by id) so a cycle is impossible; check the balance and move the money while holding both locks.

@@JAVA TransferService.java@@

**Complexity and notes.** O(1) per transfer; transfers on disjoint account pairs run in parallel. The test runs 10,000 opposite-direction transfers and asserts that money is conserved. *Follow-ups:* "How would you do this in a database?" (one transaction with `SELECT … FOR UPDATE` ordered by id, or conditional updates); "What about `tryLock` with a timeout?" (avoids deadlock but needs retry and backoff).

---

## C04: Token bucket rate limiter

**Problem.** A thread-safe limiter that allows bursts up to `capacity` and refills at `refillPerSecond`; `tryAcquire(n)` never blocks; it also reports how long until `n` permits are available (for `Retry-After`).

**Edge cases.** Long idle periods (tokens capped at capacity); fractional refill rates; requests for more permits than the capacity; contention from many threads; clock behaviour (use a monotonic, injectable clock).

**Approach.** Lazy refill on each call: tokens += elapsed × rate, capped; synchronised state.

@@JAVA TokenBucket.java@@

**Complexity and notes.** O(1). `synchronized` is fine for one bucket; for millions of keys use a `ConcurrentHashMap` of buckets, or Redis with a Lua script when the limit must hold across instances. *Follow-ups:* "Distributed version?" (Redis script using server time); "Fail open or closed?" (fairness vs safety).

---

## C05: Double-entry ledger

**Problem.** Post journal entries made of signed postings; reject entries with fewer than two postings or that don't balance **per currency**; posting the same entry twice is a no-op; reusing an id for a different entry is an error; balances are derived from postings.

**Edge cases.** Multi-currency FX entries (each currency balances separately); unbalanced entries; zero-amount postings; replays; id reuse; overflow in balances.

@@JAVA Ledger.java@@

**Complexity and notes.** O(p) per entry for p postings. A single lock keeps the example simple; a real ledger uses database transactions, a deferred constraint trigger for the balance rule and a unique key on the entry id. *Follow-ups:* "How do you correct a wrong entry?" (a reversal plus a new entry); "How do you scale hot accounts?" (sub-accounts, buffered credits).

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1712-01",
    "question": "In C03, why does locking accounts in id order prevent deadlock?",
    "options": [
      "It makes locks reentrant",
      "It uses fewer locks",
      "The JVM detects and breaks the cycle",
      "Every thread acquires locks in the same global order, so no cycle of waiting threads can form"
    ],
    "correct": 3,
    "explanation": "Deadlock needs a circular wait; a total order on lock acquisition rules it out."
  },
  {
    "id": "kc-1712-02",
    "question": "In C02, why is a failed operation removed from the map?",
    "options": [
      "So that a retry can run the operation again instead of replaying the failure forever",
      "To save memory",
      "Because CompletableFuture can't hold exceptions",
      "To make the store faster"
    ],
    "correct": 0,
    "explanation": "Failures (e.g. a PSP outage) are often transient; idempotency should remember successes, not lock in errors."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1712",
  "title": "Solve one challenge under interview conditions",
  "description": "25 minutes, no IDE autocomplete, talk aloud, then compare.",
  "tasks": [
    {
      "id": "pc-1712-01",
      "description": "Pick C02 or C03, write the solution from scratch in 25 minutes, and write one concurrency test with a start latch."
    },
    {
      "id": "pc-1712-02",
      "description": "Run `mvn test -pl track-17-coding` and read the tests for the challenge you solved; list the edge cases you missed."
    },
    {
      "id": "pc-1712-03",
      "description": "For C01, explain aloud in one minute why the allocation can't lose a cent."
    }
  ]
}
-->
