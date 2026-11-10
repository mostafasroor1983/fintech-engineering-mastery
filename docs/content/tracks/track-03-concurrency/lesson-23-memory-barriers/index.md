---
id: track-03-lesson-23
sequence: 23
title: "Memory Barriers and Instruction Reordering"
slug: memory-barriers
track: track-03
difficulty: principal
estimatedMinutes: 70
status: published
tags: [memory-barriers, instruction-reordering, acquire-release, JMM-internals]
java-versions: [17, 21]
---

Memory barriers are the hardware mechanism underlying every high-level Java concurrency primitive. `volatile`, `synchronized`, and `VarHandle` all ultimately emit memory barrier instructions. Principal Engineers who understand barriers can reason about JMM guarantees without memorising rules — they can derive correct behaviour from first principles, design lock-free data structures, and interpret disassembly output from profilers.

## Learning Objectives

By the end of this lesson you will be able to:

- Explain what instruction reordering is and why CPUs and JITs do it
- Describe the four types of memory barriers (LoadLoad, LoadStore, StoreLoad, StoreStore)
- Map Java concurrency operations to the barriers they emit
- Interpret acquire-release semantics in terms of barriers
- Use `VarHandle` with explicit barrier modes for precise control
- Explain why `volatile` reads are cheaper than `volatile` writes on x86

## Business Context

A high-frequency trading platform processes market data updates at 2 million events per second. The team is considering replacing a `volatile`-based price feed with a custom lock-free ring buffer. Understanding memory barriers — specifically whether they need a full `StoreLoad` fence or just a `StoreStore` fence — determines whether the ring buffer design is correct on x86 versus ARM, and whether the optimisation is worth the complexity.

## Why Instructions Reorder

Modern CPUs and JIT compilers reorder instructions for performance. Three sources of reordering:

### 1. Compiler Reordering

The JIT reorders bytecodes when it can prove the reordering is unobservable within a single thread:

```
// Written as:
x = 1;
y = 2;

// May compile as:
y = 2;    // reordered — single-threaded behaviour identical
x = 1;
```

### 2. CPU Out-of-Order Execution

Modern CPUs execute instructions out of program order using a reorder buffer. Writes go into a store buffer; reads may bypass the store buffer and read from cache:

```
// Store buffer: writes are queued, not immediately visible to other cores
Core 1: write x=1 → store buffer (not yet flushed to L3 cache)
Core 2: read x    → reads from cache → sees 0  (not yet 1)
Core 1: flush store buffer
Core 2: read x    → reads from cache → sees 1
```

### 3. Memory System Reordering

Loads and stores can be observed in different orders by different cores due to cache coherence protocols (MESI, MOESI) and store-forwarding paths.

## The Four Memory Barrier Types

A memory barrier (fence) prevents specific categories of reordering across the barrier:

| Barrier | Prevents | Description |
|---------|----------|-------------|
| `LoadLoad` | Load→Load reorder | All loads before barrier complete before loads after |
| `LoadStore` | Load→Store reorder | All loads before barrier complete before stores after |
| `StoreStore` | Store→Store reorder | All stores before barrier are visible before stores after |
| `StoreLoad` | Store→Load reorder | All stores before barrier are visible before loads after (most expensive — full fence) |

### Why StoreLoad is the Most Expensive

`StoreLoad` requires draining the store buffer — flushing all queued writes to the cache hierarchy — before any subsequent load. On x86, this is a `mfence` instruction with ~100 cycle cost. The other three barriers are largely free on x86 (TSO architecture provides most ordering for free), but are significant on ARM (weakly ordered).

```
x86 barrier costs (approximate):
  LoadLoad:   free (x86 TSO provides this automatically)
  LoadStore:  free
  StoreStore: free (SFENCE: ~10 cycles if needed at all)
  StoreLoad:  ~100 cycles (MFENCE or LOCK XCHG)

ARM barrier costs:
  LoadLoad:   ISH DSB: ~20-40 cycles
  StoreStore: ISH DSB: ~20-40 cycles
  StoreLoad:  ISH DSB: ~20-40 cycles
  Full fence: ISH DSB + ISB: ~40-80 cycles
```

## Java Operations and Their Barriers

### volatile Read

A `volatile` read emits a `LoadLoad` + `LoadStore` barrier after the read:

```
  load  x  (volatile)
  ──────────────────── LoadLoad + LoadStore barrier
  load  y  (normal)   │ cannot be moved above the volatile read
  store z  (normal)   │ cannot be moved above the volatile read
```

On x86, a `volatile` read compiles to a plain memory load (no fence instruction) because TSO provides LoadLoad ordering automatically.

### volatile Write

A `volatile` write emits `StoreStore` before and `StoreLoad` after the write:

```
  store a  (normal)   ┐
  store b  (normal)   │ cannot be moved below the volatile write
  ──────────────────── StoreStore barrier
  store x  (volatile)
  ──────────────────── StoreLoad barrier
  load  y  (normal)   │ cannot be moved above the volatile write
```

On x86, a `volatile` write compiles to a `LOCK XCHG` or `MOV` + `MFENCE` to ensure the `StoreLoad` fence.

This is why **`volatile` writes are more expensive than `volatile` reads** — the `StoreLoad` barrier is the most expensive barrier type.

### synchronized (monitorenter / monitorexit)

```
monitorenter:
  ──────────────────── acquire barrier (LoadLoad + LoadStore)
  ... critical section ...
monitorexit:
  ──────────────────── release barrier (StoreStore + StoreLoad)
```

Acquiring a lock = acquire barrier: all reads and writes in the critical section are not moved before the lock acquisition.

Releasing a lock = release barrier: all reads and writes in the critical section are not moved after the lock release. This is the happens-before source for `synchronized`.

## Acquire-Release Semantics

Acquire-release is a weaker memory ordering than sequential consistency (`volatile`), but sufficient for many patterns:

**Acquire semantics (load):** No load or store after this load can be moved before it. This is what `synchronized(lock)` provides on entry — acquiring a lock has acquire semantics.

**Release semantics (store):** No load or store before this store can be moved after it. This is what `synchronized(lock)` provides on exit — releasing a lock has release semantics.

```
Thread 1 (producer)              Thread 2 (consumer)
────────────────────             ──────────────────
data.value = 42;                 if (ready.get()) {       // acquire read
ready.set(true);  // release         use(data.value);     // guaranteed to see 42
                                 }
```

If `ready` is `volatile`, the write to `ready` has release semantics and the read has acquire semantics. The happens-before edge ensures `data.value = 42` is visible to Thread 2.

## VarHandle: Explicit Barrier Control

`VarHandle` (Java 9+) exposes barrier modes explicitly, allowing finer-grained control than `volatile`:

```java
import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;

public class PriceFeed {

    private long bidPrice;   // Not volatile — controlled via VarHandle
    private long askPrice;

    private static final VarHandle BID;
    private static final VarHandle ASK;

    static {
        try {
            MethodHandles.Lookup lookup = MethodHandles.lookup();
            BID = lookup.findVarHandle(PriceFeed.class, "bidPrice", long.class);
            ASK = lookup.findVarHandle(PriceFeed.class, "askPrice", long.class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    // Producer: publish with release semantics (StoreStore + no subsequent reorder)
    public void updatePrices(long bid, long ask) {
        BID.setRelease(this, bid);  // StoreStore before this store
        ASK.setRelease(this, ask);  // StoreStore before this store
    }

    // Consumer: read with acquire semantics (LoadLoad + no prior reorder)
    public long getBid() {
        return (long) BID.getAcquire(this);  // LoadLoad after this load
    }

    public long getAsk() {
        return (long) ASK.getAcquire(this);  // LoadLoad after this load
    }

    // For CAS operations on price — full volatile semantics
    public boolean compareAndSetBid(long expected, long newBid) {
        return BID.compareAndSet(this, expected, newBid);
    }
}
```

### VarHandle Access Modes Reference

| Mode | Barrier | Java Equivalent | Cost |
|------|---------|----------------|------|
| `get()` | None | Plain read | Cheapest |
| `getOpaque()` | Atomicity only | - | Low |
| `getAcquire()` | Acquire (LoadLoad + LoadStore) | `volatile` read on acquire | Medium |
| `set()` | None | Plain write | Cheapest |
| `setOpaque()` | Atomicity only | - | Low |
| `setRelease()` | Release (StoreStore) | - | Medium |
| `getVolatile()` / `setVolatile()` | Full (all four) | `volatile` r/w | Most expensive |
| `compareAndSet()` | Full | `AtomicXxx.compareAndSet()` | Expensive |

## A Lock-Free Ring Buffer: Barrier Analysis

This is the kind of structure where barrier knowledge pays off. A single-producer single-consumer (SPSC) ring buffer can be implemented with only `setRelease` / `getAcquire` — no full `StoreLoad` fence needed:

```java
public class SpscRingBuffer<T> {

    private final Object[] buffer;
    private final int      mask;

    // These two are the only shared mutable state
    private long writeIndex = 0;
    private long readIndex  = 0;

    private static final VarHandle WRITE_INDEX;
    private static final VarHandle READ_INDEX;
    private static final VarHandle BUFFER_ELEMENT;

    static {
        try {
            MethodHandles.Lookup lookup = MethodHandles.lookup();
            WRITE_INDEX    = lookup.findVarHandle(SpscRingBuffer.class, "writeIndex", long.class);
            READ_INDEX     = lookup.findVarHandle(SpscRingBuffer.class, "readIndex",  long.class);
            BUFFER_ELEMENT = MethodHandles.arrayElementVarHandle(Object[].class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public SpscRingBuffer(int capacity) {
        int size = Integer.highestOneBit(capacity - 1) << 1;  // next power of 2
        buffer   = new Object[size];
        mask     = size - 1;
    }

    // Producer thread only
    public boolean offer(T item) {
        long wi = (long) WRITE_INDEX.get(this);              // plain read (producer only)
        long ri = (long) READ_INDEX.getAcquire(this);        // acquire: see consumer's progress
        if (wi - ri >= buffer.length) return false;          // full

        BUFFER_ELEMENT.setRelease(buffer, (int)(wi & mask), item);  // release: publish item
        WRITE_INDEX.setRelease(this, wi + 1);                       // release: advance index

        return true;
    }

    // Consumer thread only
    @SuppressWarnings("unchecked")
    public T poll() {
        long ri = (long) READ_INDEX.get(this);               // plain read (consumer only)
        long wi = (long) WRITE_INDEX.getAcquire(this);       // acquire: see producer's index
        if (ri == wi) return null;                            // empty

        T item = (T) BUFFER_ELEMENT.getAcquire(buffer, (int)(ri & mask));  // acquire: see item
        BUFFER_ELEMENT.set(buffer, (int)(ri & mask), null);  // plain: clear for GC
        READ_INDEX.setRelease(this, ri + 1);                  // release: advance index

        return item;
    }
}
```

**Barrier analysis:**
- Producer writes item with `setRelease` → StoreStore: item data is visible before index advance
- Producer advances `writeIndex` with `setRelease` → StoreStore: index advance is visible after item
- Consumer reads `writeIndex` with `getAcquire` → LoadLoad: index read is ordered before item read
- Consumer reads item with `getAcquire` → LoadLoad: item data fully loaded before proceeding

No `StoreLoad` fence needed — the acquire-release pairing between producer's `setRelease(writeIndex)` and consumer's `getAcquire(writeIndex)` creates the synchronisation edge. This is typically 2–5× faster than using `volatile` (which emits a full `StoreLoad` fence) for the write path on x86.

> [!WARNING]
> SPSC ring buffers are correct **only** with exactly one producer thread and one consumer thread. If you add a second producer or consumer, the barrier analysis breaks and you need a full CAS-based implementation (e.g., `Disruptor`'s multi-producer ring buffer).

## x86 vs ARM: Why Architecture Matters

```
x86 (Total Store Order):
  - Most reorderings are forbidden by hardware
  - Only StoreLoad reorder is allowed
  - volatile reads: free (no fence instruction needed)
  - volatile writes: expensive (LOCK XCHG or MFENCE)
  - Bugs from missing barriers rarely surface on x86

ARM (Weakly Ordered):
  - Most reorderings are permitted by hardware
  - All four barrier types needed to prevent reordering
  - volatile reads: cost ISH DSB fence
  - volatile writes: cost ISH DSB fence
  - Bugs from missing barriers surface reliably on ARM
```

This is why code that "works" without proper barriers on x86 development machines can fail on ARM production instances (AWS Graviton, Apple M-series). The JMM is designed to be conservative — if you follow JMM rules, your code is correct on all architectures. Never rely on x86's stronger ordering.

## Knowledge Check

**Q1:** You have two `volatile` fields updated together:
```java
volatile long timestamp;
volatile long price;

void update(long ts, long p) {
    timestamp = ts;
    price = p;
}
```
Can a reader thread observe the new `price` but the old `timestamp`?

**A:** Yes. Each `volatile` write creates its own happens-before edge, but the two writes are not atomic as a unit. A reader can observe `price = p` (new) and then read `timestamp` and find the old value if it reads between the two writes. To atomically update both, use `synchronized`, or store them in a single immutable record published via a single `volatile` reference swap.

**Q2:** `VarHandle.setRelease()` is cheaper than `setVolatile()`. When is it safe to use `setRelease()` instead of `setVolatile()`?

**A:** `setRelease()` is safe when you only need the following guarantee: everything written before this store will be visible to any thread that reads this location with `getAcquire()` or stronger. You do NOT need the subsequent `StoreLoad` fence (which is the expensive part of `setVolatile()`). It is safe for producer→consumer data handoff (SPSC ring buffer, publish an item then advance a cursor) but not safe if you need a reader to observe the store before it has performed its own subsequent loads.

## Practical Challenge

Design a high-performance price cache for a trading system that publishes bid/ask/last prices to 500 consuming threads. Requirements:

1. **Write path:** One market data thread updates prices ~100,000 times per second. Minimise write-side latency — use the minimum barrier strength required for correctness
2. **Read path:** 500 consuming threads read prices on every market tick — minimise read-side latency
3. **Consistency:** Readers must see either the old complete price triple (bid, ask, last) or the new complete price triple — never a mix of old and new values
4. **JMM correctness:** Code must be correct on ARM, not just x86

**Hint:** Consider using a `volatile` reference to an immutable price snapshot (record) rather than three separate `volatile` fields. Analyse the number of barriers emitted vs the three-field approach and explain which is fewer for the update path.

Provide the implementation with explicit commentary on what barrier each `VarHandle` access mode emits and why it is sufficient.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why are volatile writes more expensive than volatile reads on x86 hardware?",
      "options": [
        "Volatile reads require a full StoreLoad fence while volatile writes do not",
        "Volatile writes emit a StoreLoad fence (the most expensive barrier, requiring store buffer drain) while volatile reads only require a LoadLoad+LoadStore fence which is free on x86 TSO",
        "Volatile reads require a lock instruction while volatile writes do not",
        "They have the same cost on x86 because TSO provides all ordering automatically"
      ],
      "correct": 1,
      "explanation": "On x86 (TSO architecture), LoadLoad and LoadStore ordering is provided for free by the hardware. Volatile reads compile to a plain MOV instruction with no fence. Volatile writes, however, require a StoreLoad fence (LOCK XCHG or MFENCE) to drain the store buffer — this is the most expensive fence type at ~100 cycles. This asymmetry means reads are nearly free while writes are expensive."
    },
    {
      "text": "In a single-producer single-consumer ring buffer, the producer uses VarHandle.setRelease() to advance the write index, and the consumer uses VarHandle.getAcquire() to read it. Why is this pair sufficient for correctness without a full StoreLoad fence?",
      "options": [
        "It is not sufficient — a full volatile write is required for correctness",
        "The setRelease/getAcquire pair creates a happens-before edge: all writes before setRelease are visible to any thread that subsequently calls getAcquire on the same variable",
        "It is only sufficient on x86 but not on ARM",
        "getAcquire automatically reads from main memory, bypassing all caches"
      ],
      "correct": 1,
      "explanation": "The acquire-release pair establishes a happens-before edge: everything written by the producer before the setRelease is visible to the consumer after the getAcquire. The StoreLoad fence (which setVolatile would add) would only be needed if the producer needed to immediately see subsequent loads. For the SPSC handoff pattern, setRelease/getAcquire is both correct and significantly cheaper than setVolatile."
    },
    {
      "text": "Code using no synchronisation 'works' on x86 development machines for months but fails on AWS Graviton (ARM) in production. What is the root cause?",
      "options": [
        "ARM CPUs have slower clock speeds than x86, exposing timing-related bugs",
        "x86 TSO provides stronger memory ordering than the JMM requires, masking data races that ARM's weaker memory model exposes correctly",
        "AWS Graviton uses a different JVM version that has different behaviour",
        "ARM CPUs have smaller caches, causing more cache misses that expose race conditions"
      ],
      "correct": 1,
      "explanation": "x86 uses Total Store Order (TSO), which provides most memory ordering guarantees automatically, masking many JMM violations. ARM is weakly ordered and allows all four types of reordering unless explicit barrier instructions are used. Code with data races may appear to work on x86 (since the hardware enforces stronger ordering than the JMM requires) but correctly fails on ARM. The JMM is the contract — code must be correct to the JMM, not to x86 hardware."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Lock-Free Price Cache with VarHandle Barrier Analysis",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Design an immutable PriceSnapshot record (bid, ask, last as long fields in cents) and a PriceCache class that holds a single PriceSnapshot reference. Use VarHandle with setRelease() for the writer (one market data thread publishing ~100,000 updates/second) and getAcquire() for readers (500 consuming threads). Do NOT use volatile on the field. Document exactly which barriers are emitted by each access mode and why they are sufficient."},
    {"id": "2", "description": "Prove correctness of the design: explain why readers see either the complete old PriceSnapshot or the complete new PriceSnapshot, never a partially-updated price triple. Compare the number of barriers emitted by this approach (one setRelease for the reference swap) versus the alternative of three separate volatile fields (three setVolatile calls each with a StoreLoad fence)."},
    {"id": "3", "description": "Implement a SpscRingBuffer<T> (single-producer single-consumer) using VarHandle with setRelease/getAcquire for index management and setRelease/getAcquire for buffer element access. Write explicit comments on each VarHandle call explaining which reorderings are prevented. Include a correctness proof: why does the producer's setRelease(writeIndex) paired with the consumer's getAcquire(writeIndex) create the necessary happens-before edge for item visibility?"},
    {"id": "4", "description": "Write a JMH benchmark comparing three PriceCache implementations: (1) plain fields with no synchronisation (incorrect but fast baseline), (2) volatile fields on each price value, (3) VarHandle setRelease/getAcquire on a single reference to an immutable PriceSnapshot. Measure single-thread read throughput and 500-thread concurrent read throughput. Explain the benchmark results in terms of barriers emitted and store buffer drain cost."}
  ]
}
-->
