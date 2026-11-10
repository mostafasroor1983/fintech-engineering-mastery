---
id: track-03-lesson-28
sequence: 28
title: "Principal Engineer's Concurrency Decision Framework"
slug: concurrency-decision-framework
track: track-03
difficulty: principal
estimatedMinutes: 60
status: published
tags: [decision-framework, architecture, trade-offs, staff-engineer, principal-engineer]
java-versions: [17, 21]
---

Concurrency is a design space with many correct answers. The difference between a senior and a principal engineer is not knowing more techniques — it is knowing which technique to reach for, when, and how to justify that choice to a team. This lesson synthesises Track 3 into a decision framework you can apply to real production problems and articulate to peers, architects, and engineering managers.

## Learning Objectives

By the end of this lesson you will be able to:

- Apply a structured decision process to any concurrency problem in financial systems
- Identify the dominant constraint (throughput, latency, consistency, simplicity) and let it drive tool selection
- Articulate trade-offs between locking strategies in architecture review language
- Recognise when "no concurrency" is the right answer
- Write concurrency design records that survive code reviews and postmortems

## The Concurrency Problem Space

Every concurrency problem in financial systems falls into one of four categories:

```
┌─────────────────────────────────────────────────────────┐
│              Concurrency Problem Space                  │
│                                                         │
│  ┌──────────────────┐    ┌──────────────────┐           │
│  │  SHARED STATE    │    │  COORDINATION    │           │
│  │  (Who owns it?)  │    │  (Who goes first?)│           │
│  │                  │    │                  │           │
│  │ • Balances       │    │ • Thread startup │           │
│  │ • Config         │    │ • Batch phases   │           │
│  │ • Caches         │    │ • Rate limiting  │           │
│  └──────────────────┘    └──────────────────┘           │
│                                                         │
│  ┌──────────────────┐    ┌──────────────────┐           │
│  │  ASYNC EXECUTION │    │  RESOURCE LIMITS │           │
│  │  (Who runs it?)  │    │  (How many?)     │           │
│  │                  │    │                  │           │
│  │ • Payment pipelines│  │ • Thread pools   │           │
│  │ • Parallel checks │  │ • DB connections │           │
│  │ • Background jobs │  │ • API rate limits│           │
│  └──────────────────┘    └──────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

## Decision Framework: Five Questions

For any concurrency problem, answer these five questions in order:

### Question 1: Can you eliminate shared mutable state?

If yes — do it. Immutability is the strongest correctness guarantee. No lock contention, no memory visibility issues, no race conditions.

```
Is the data read-many, write-rarely?
  ├── YES → Immutable record + volatile/atomic reference swap
  │          Cost: GC pressure on updates; fine for config, routes, fee tables
  └── NO → Proceed to Q2
```

**Payment system application:** Fee schedules, routing rules, fraud rule sets — load once, publish via `volatile` reference, hot-reload by swapping the reference. Zero lock contention. Zero GC pressure during reads.

### Question 2: Is contention actually a problem?

Measure before optimising. Many accounts are rarely contested:

```
Is the resource genuinely contested?
  ├── NO (< 2 concurrent writers) → synchronized or simple AtomicXxx
  │   "The simplest correct tool. Premature optimisation kills readability."
  └── YES (high contention) → Proceed to Q3
```

**Principal engineer mistake:** Reaching for `ConcurrentHashMap` with complex merge lambdas or lock-free CAS loops for data structures that only ever have one writer. Use `synchronized` and profile before optimising.

### Question 3: Is the operation CPU-bound or I/O-bound?

```
Is the concurrent work primarily:
  ├── I/O-BOUND (database, HTTP, file) → Virtual threads (Java 21)
  │   "Thread-per-request model at zero pool-exhaustion risk"
  │   
  └── CPU-BOUND (crypto, compression, complex validation)
        ├── Divisible? → ForkJoinPool / parallel streams
        └── Not divisible? → Bounded ThreadPoolExecutor (cores × 1.1)
```

**Common anti-pattern:** Using `CompletableFuture.supplyAsync()` with the common pool for I/O operations. The common pool has `#CPUs - 1` threads; one slow DB query blocks all futures. Use a dedicated I/O executor.

### Question 4: What is the consistency requirement?

```
Consistency requirement:
  ├── ATOMIC READ-MODIFY-WRITE (single value)
  │     → AtomicLong / AtomicReference with CAS
  │
  ├── ATOMIC MULTI-FIELD UPDATE (snapshot atomicity)
  │     → Immutable record + AtomicReference<Record> swap
  │       OR synchronized block
  │
  ├── ATOMIC DATABASE OPERATION (business transaction)
  │     Low contention → @Version optimistic locking + retry
  │     High contention → SELECT FOR UPDATE pessimistic locking
  │
  └── DISTRIBUTED CONSISTENCY (cross-service)
        → Saga + idempotency + compensating transactions
```

### Question 5: What is the failure mode you can tolerate?

```
If the concurrent operation fails (timeout, exception, contention):
  ├── FAIL FAST (payment authorisation) → Small queue + reject with 503
  ├── RETRY (idempotent balance update) → Optimistic lock + exponential backoff
  ├── DEGRADE GRACEFULLY (fraud check) → Return "allow" on timeout; async recheck
  └── DROP (notification, analytics) → DiscardPolicy or DiscardOldestPolicy
```

> [!IMPORTANT]
> Never choose `DiscardPolicy` for payment-critical operations. Silent data loss in a financial system is a regulatory and customer trust failure. Only `DiscardPolicy` for genuinely non-critical data: audit logs that have a secondary channel, analytics events, notifications.

## Tool Selection Matrix

| Requirement | First Choice | When to Upgrade |
|-------------|-------------|-----------------|
| Read-heavy shared config | `volatile` reference to immutable record | — |
| Single counter / rate limiter | `AtomicLong` / `LongAdder` | Never for counts |
| Multi-field atomic snapshot | `AtomicReference<Record>` | To DB if persistent |
| Low-contention balance | `@Version` optimistic lock | > 20% retry rate → pessimistic |
| High-contention balance | `SELECT FOR UPDATE` | Distributed → Saga |
| Parallel I/O pipeline | `CompletableFuture` + dedicated executor | Java 21 → virtual threads |
| Thread-per-request (I/O) | Virtual threads | — |
| CPU-bound parallelism | `ForkJoinPool` / parallel stream | Custom `ThreadPoolExecutor` |
| Resource rate limiting | `Semaphore` | Resilience4j RateLimiter |
| One-time startup gate | `CountDownLatch` | — |
| Reusable phase barrier | `CyclicBarrier` | `Phaser` for dynamic workers |
| Pool isolation | Separate `ThreadPoolExecutor` per concern | Virtual threads (I/O path) |

## Complexity Ladder

Reach for tools only as far up the ladder as the problem demands. Each rung adds correctness surface area:

```
Complexity Rung 1: Avoid shared state entirely
  ↓ if unavoidable
Complexity Rung 2: Make state immutable and publish safely
  ↓ if mutable state required
Complexity Rung 3: Confine mutable state to one thread (thread confinement)
  ↓ if shared access required
Complexity Rung 4: Use volatile / AtomicXxx for single-variable coordination
  ↓ if multi-variable atomicity required
Complexity Rung 5: Use synchronized for guarded compound operations
  ↓ if performance or advanced locking required
Complexity Rung 6: Use ReentrantLock / StampedLock / ReadWriteLock
  ↓ if lock-free performance required
Complexity Rung 7: Use CAS / VarHandle / lock-free structures
  ↓ if distributed coordination required
Complexity Rung 8: Saga + idempotency + distributed consensus
```

**Principal engineer principle:** Always start at Rung 1 and justify each step down with measurement, not intuition.

## Communicating Trade-offs: Architecture Review Language

When presenting a concurrency design to peers or in an architecture review, structure your argument as:

```
1. The constraint we're optimising for
2. The option we chose
3. The options we rejected and why
4. The failure mode and how we handle it
5. The observability we've added
```

**Example — payment balance locking:**

> *"We're optimising for correctness over throughput. We chose pessimistic locking (`SELECT FOR UPDATE`) for merchant accounts flagged as high-contention, because optimistic locking was retrying on 40% of requests under our measured peak load of 180 concurrent debits on a single account — generating 72 wasted DB round-trips per second. We rejected optimistic locking for this segment because retry amplification exceeds the cost of serialisation. We handle the failure mode via a 5-second transaction timeout that surfaces a typed `LockTimeoutException` → HTTP 503 to callers. We've added Micrometer metrics on lock wait time and timeout rate, alerting when timeout rate > 0.5%."*

## Common Principal-Level Mistakes

### Mistake 1: Solving the Wrong Problem

> "Our payment service is slow under load" → immediately adds more threads.

**Reality check:** More threads can make I/O-bound problems worse (more threads → more DB connections → more DB lock contention). Profile first. The bottleneck is often the database, not thread count.

### Mistake 2: Cargo-Culting Patterns

Using `ConcurrentHashMap.computeIfAbsent()` for everything because it's "concurrent" — without understanding that the compute function must not block I/O, modify the map, or take long. Breaking this rule causes deadlocks.

### Mistake 3: Insufficient Observability

Building a sophisticated lock-free structure with no metrics. When it misbehaves in production, there is no data. Always instrument: contention rate, retry count, rejection rate, lock hold time.

### Mistake 4: Trusting Tests on x86

A test that passes millions of iterations on a development MacBook Pro may fail in the first run on AWS Graviton (ARM). The JMM is the contract — test on weakly-ordered hardware or use jcstress.

### Mistake 5: Ignoring the Happy Path Cost

A `StampedLock` optimistic read has overhead even on the uncontested path. For a cache read that happens 10 million times per second, even a 10 ns overhead is 0.1 CPU-seconds per second. Profile the hot path before choosing a "smarter" lock.

## Decision Record Template

When making a significant concurrency design decision, write a short ADR:

```markdown
## Concurrency Design Record: [Component Name]

**Date:** YYYY-MM-DD
**Author:** [name]
**Status:** Accepted

### Context
[Describe the shared state, its access pattern, and the constraint]

### Decision
[The concurrency mechanism chosen]

### Consequences
- **Correctness guarantee:** [What invariant is maintained]
- **Performance characteristic:** [Throughput/latency at expected concurrency]
- **Failure mode:** [What happens under overload]
- **Observability:** [Metrics/alerts in place]

### Alternatives Rejected
- [Option A]: rejected because [reason]
- [Option B]: rejected because [reason]
```

## Track 3 Synthesis: What You Now Know

You have covered:

| Category | Lessons | Key Tool/Concept |
|----------|---------|-----------------|
| Memory model | 1, 22, 23, 26 | JMM happens-before, final fields, barriers |
| Thread safety design | 2, 7 | Immutability, race condition patterns |
| Synchronisation | 3, 8 | ReentrantLock, deadlock prevention |
| Atomic operations | 4, 5 | CAS, ABA problem |
| Concurrent collections | 6 | ConcurrentHashMap, BlockingQueue |
| Performance | 9, 17, 19 | False sharing, JMH, lock contention |
| Thread management | 10, 20 | ThreadPoolExecutor, bulkhead |
| Async pipelines | 11 | CompletableFuture |
| Java 21 | 12, 13, 14, 15 | Virtual threads, structured concurrency, scoped values |
| Testing & diagnosis | 16, 18 | jcstress, thread dumps |
| Domain patterns | 21, 24, 25, 27 | Balance management, synchronizers, context propagation |
| Framework | 28 | Decision framework (this lesson) |

## Knowledge Check

**Q1:** A team proposes replacing all `synchronized` blocks in their payment service with `ReentrantLock` for "better performance." How do you evaluate this proposal?

**A:** Ask for profiling evidence. `ReentrantLock` offers additional features (`tryLock`, `lockInterruptibly`, fair mode, multiple `Condition` variables) but does not automatically perform better than `synchronized` for uncontested locks — the JVM heavily optimises `synchronized` with biased locking and lock coarsening. For contested locks under high concurrency, `ReentrantLock` can outperform, but the question is whether the payment service is actually lock-contention-bound. Migrate only where profiling shows monitor contention (JFR `JavaMonitorEnter` events, async-profiler `-e lock`) contributes meaningfully to latency.

**Q2:** A new service architect proposes using `synchronized` on every balance update method, arguing it is "the safest option." A team member counters that it will kill throughput. Who is right, and what would you do?

**A:** Both are partially right. `synchronized` guarantees correctness and is correct for balance management. For typical retail customer accounts (low contention), the throughput impact is negligible — JVM biased locking means uncontested `synchronized` costs ~2–5 ns. For high-contention merchant accounts, `synchronized` on a single account object serialises all access, which is exactly correct behaviour but limits throughput to `1 / lock_hold_time`. The right answer: start with `synchronized`, measure contention in production (JFR), and upgrade only the hot segments to `SELECT FOR UPDATE` with database-level queuing or to lock-free patterns with profiling evidence. Never design for theoretical worst-case without data.

## Practical Challenge: Architecture Review Simulation

You are presented with the following design for a payment processing service:

```java
public class PaymentProcessor {
    private static final Map<String, Long> balances = new HashMap<>();  // Not concurrent
    private static final List<Transaction> ledger   = new ArrayList<>(); // Not concurrent
    
    public synchronized void process(Payment p) {
        Long bal = balances.get(p.accountId());
        if (bal == null || bal < p.amount()) throw new InsufficientFundsException();
        balances.put(p.accountId(), bal - p.amount());
        ledger.add(new Transaction(p));
    }
}
```

**Task:** Write a Principal Engineer's review of this design. Address:
1. What is correct about it
2. The scalability bottleneck and at what concurrency level it becomes a problem
3. Three concrete improvements with their trade-offs
4. What monitoring you would add before making any changes
5. Your recommended first migration step and why

Format your answer as the architecture review language template from this lesson.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A team proposes replacing all synchronized blocks with ReentrantLock for 'better performance'. How should a Principal Engineer evaluate this proposal?",
      "options": [
        "Accept immediately — ReentrantLock is always faster than synchronized",
        "Reject — synchronized is always faster than ReentrantLock",
        "Require profiling evidence showing monitor contention contributing meaningfully to latency; ReentrantLock offers additional features but does not automatically outperform synchronized on uncontested paths",
        "Accept for all payment-critical code, reject for batch code"
      ],
      "correct": 2,
      "explanation": "ReentrantLock offers additional features (tryLock, lockInterruptibly, fair mode, multiple Condition variables) but does not automatically outperform synchronized for uncontested locks — the JVM heavily optimises synchronized with biased locking and lock coarsening. For contested locks under high concurrency, ReentrantLock can outperform, but only profiling (JFR JavaMonitorEnter events, async-profiler -e lock) can confirm that monitor contention is actually the bottleneck."
    },
    {
      "text": "According to the Complexity Ladder in this lesson, when should you first reach for AtomicXxx operations?",
      "options": [
        "As the first choice for any shared mutable state",
        "Only after determining that shared state cannot be eliminated, cannot be made immutable, cannot be confined to one thread, and requires coordination across threads with single-variable atomicity",
        "Only when synchronized causes deadlock",
        "Only for counter variables, never for reference types"
      ],
      "correct": 1,
      "explanation": "The Complexity Ladder requires exhausting simpler options first: (1) avoid shared state entirely, (2) make state immutable and publish safely, (3) confine mutable state to one thread. Only when you need shared mutable access across threads with single-variable atomicity should you reach for volatile/AtomicXxx (Rung 4). Reaching for atomic operations prematurely adds unnecessary complexity and maintenance burden without benefit."
    },
    {
      "text": "A payment service processes 90% reads and 10% writes on account balance data. The constraint is read throughput. Which tool is the best first choice according to the decision framework?",
      "options": [
        "StampedLock with optimistic reads for maximum read throughput",
        "ConcurrentHashMap with compute operations for thread safety",
        "volatile reference to an immutable record — updated by swapping the reference on write, read without any synchronisation",
        "ReadWriteLock with many readers sharing one write lock"
      ],
      "correct": 2,
      "explanation": "For read-heavy (90%) data like balance snapshots, the first choice is an immutable record published via a volatile reference. Writers swap the entire reference atomically; readers read the volatile field with no lock whatsoever. This is Complexity Rung 2 (immutable + safe publication) — far simpler than StampedLock or ReadWriteLock, with no lock contention on the read path. Only upgrade to StampedLock if profiling shows the volatile read is a bottleneck, which is rare."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Principal Engineer Architecture Review",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Review the provided PaymentProcessor design that uses a single synchronized method on a class with static HashMap and ArrayList fields. Write a Principal Engineer's review using the architecture review language template: (1) what is correct about the design, (2) the scalability bottleneck and at what concurrency level it becomes a problem, (3) three concrete improvements with their trade-offs, (4) what monitoring you would add before making any changes, (5) your recommended first migration step and why."},
    {"id": "2", "description": "Apply the five-question decision framework to the following scenario: a payment ledger stores the running balance for 10 million accounts. 95% of requests are balance reads, 5% are debit/credit writes. Peak load is 50,000 reads/second and 2,500 writes/second. Work through each question (eliminate shared state? is contention a problem? I/O vs CPU-bound? consistency requirement? failure mode?) and document which tool you select at each step and why you stopped."},
    {"id": "3", "description": "Write a Concurrency Design Record (ADR) for a fraud rule cache that is read 85,000 times/second by 200 authorisation threads and refreshed every 30 seconds by one background thread. Use the ADR template from this lesson: context, decision, consequences (correctness guarantee, performance characteristic, failure mode, observability), and alternatives rejected with reasoning."},
    {"id": "4", "description": "Identify which Complexity Rung is appropriate for each of the following components, justify your choice, and name the specific Java class or pattern to use: (a) a request counter for metrics, (b) a fee schedule loaded at startup and never changed, (c) a session-scoped temporary balance for a multi-step checkout flow, (d) a configuration object refreshed hourly via an admin API, (e) a batch job state machine with five states shared between a producer and consumer thread."}
  ]
}
-->
