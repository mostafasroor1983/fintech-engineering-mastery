---
id: track-04-lesson-05
title: "Reactive Streams Specification and TCK"
slug: reactive-streams-spec
track: track-04
trackName: Async & Reactive Systems
sequence: 5
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [reactive-streams, TCK, Publisher, Subscriber, Subscription]
prerequisites: []
---

# Reactive Streams Specification and TCK

> [!NOTE]
> The Reactive Streams specification is the formal contract that makes Project Reactor, RxJava, Akka Streams, and Java's `Flow` API interoperable. Understanding the specification's rules and invariants is essential for financial engineers who write custom Publishers, integrate third-party reactive libraries, or debug subtle ordering and concurrency bugs in reactive pipelines.

## Why the Specification Exists

Before Reactive Streams (2015), every reactive library had its own API. Combining RxJava with Akka Streams required adapter code. Libraries could not share publishers and subscribers.

The Reactive Streams specification defines four minimal interfaces with precise behavioral rules. Any library that implements these interfaces correctly can interoperate with any other. This is what allows you to pipe a Kafka Reactor source into a WebFlux handler into an R2DBC sink — they all speak the same protocol.

---

## The Four Interfaces

```java
package org.reactivestreams;

// 1. Publisher: a source of data
public interface Publisher<T> {
    void subscribe(Subscriber<? super T> subscriber);
}

// 2. Subscriber: a consumer of data
public interface Subscriber<T> {
    void onSubscribe(Subscription subscription); // called first, once
    void onNext(T item);                          // called 0 to n times
    void onError(Throwable t);                    // terminal — no further calls
    void onComplete();                            // terminal — no further calls
}

// 3. Subscription: the link between Publisher and Subscriber
public interface Subscription {
    void request(long n);  // signal demand: may be called multiple times
    void cancel();         // signal disinterest: publisher should eventually stop
}

// 4. Processor: both Publisher and Subscriber (a transform stage)
public interface Processor<T, R> extends Subscriber<T>, Publisher<R> {}
```

These four interfaces are the entire API surface. The power is in the **rules** that govern their behavior.

---

## Key Specification Rules and Invariants

The specification defines 37 rules across the four interfaces. These are the most critical for fintech engineers:

### Publisher Rules

**Rule 1.1** — A Publisher must not emit more items than the total demand signaled via `request(n)`.

This is the foundation of backpressure. If a subscriber calls `request(5)`, the publisher may not emit item 6 until `request(n)` is called again.

**Rule 1.3** — `onSubscribe`, `onNext`, `onError`, and `onComplete` must be called serially. The publisher must not call these concurrently from multiple threads without external synchronization.

This rule is subtle but critical: a publisher that emits from multiple threads without synchronization violates the spec. Reactor's `Sinks` API enforces this with `tryEmitNext()` failure codes.

**Rule 1.7** — Once a terminal state (`onError` or `onComplete`) has been signaled, the publisher must not signal any further events.

**Rule 1.9** — `subscribe()` must not throw. Any error must be delivered via `onError`.

### Subscriber Rules

**Rule 2.1** — A subscriber must signal demand via `request(n)` before the publisher may emit items.

**Rule 2.2** — A subscriber must not call any method on the Subscription after `cancel()` has been called.

**Rule 2.6** — A subscriber must call `Subscription.cancel()` if it no longer wants to receive items (e.g., downstream cancelled the pipeline). This prevents resource leaks.

**Rule 2.7** — A subscriber must be prepared to receive `onComplete` or `onError` even after calling `cancel()` (the publisher may already be in-flight with these signals).

**Rule 2.13** — `onSubscribe`, `onNext`, `onError`, `onComplete` must not throw exceptions. Any exception thrown is a programming error.

```java
// WRONG — throwing in onNext violates Rule 2.13
public void onNext(Payment payment) {
    if (payment.getAmount() == null) {
        throw new IllegalArgumentException("null amount"); // spec violation
    }
    process(payment);
}

// CORRECT — signal error through the subscription
public void onNext(Payment payment) {
    try {
        process(payment);
    } catch (Exception ex) {
        subscription.cancel();
        onError(ex); // or propagate through your error handling
    }
}
```

### Subscription Rules

**Rule 3.6** — After `cancel()` is called, the publisher must eventually stop signaling items.

**Rule 3.9** — `request(Long.MAX_VALUE)` signals unbounded demand. The publisher may treat this as permission to emit as fast as possible.

---

## Implementing a Custom Publisher

You rarely need to implement `Publisher` directly — Reactor provides `Flux.create`, `Flux.generate`, and `Sinks`. But understanding how to do it correctly is valuable for debugging and for integrating non-standard sources (legacy messaging systems, custom network protocols).

```java
import org.reactivestreams.Publisher;
import org.reactivestreams.Subscriber;
import org.reactivestreams.Subscription;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A spec-compliant Publisher that emits a finite range of transaction IDs.
 * This example shows the minimum required logic for a correct Publisher.
 */
public class TransactionIdPublisher implements Publisher<String> {

    private final long startId;
    private final long count;

    public TransactionIdPublisher(long startId, long count) {
        this.startId = startId;
        this.count = count;
    }

    @Override
    public void subscribe(Subscriber<? super String> subscriber) {
        // Rule 1.9 — subscribe must not throw; wrap any errors
        if (subscriber == null) {
            throw new NullPointerException("Subscriber must not be null"); // NPE is allowed per spec
        }
        subscriber.onSubscribe(new TransactionIdSubscription(subscriber));
    }

    private class TransactionIdSubscription implements Subscription {

        private final Subscriber<? super String> subscriber;
        private final AtomicLong demand = new AtomicLong(0);
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private long emitted = 0;

        TransactionIdSubscription(Subscriber<? super String> subscriber) {
            this.subscriber = subscriber;
        }

        @Override
        public void request(long n) {
            // Rule 3.9 — negative or zero request is a protocol error
            if (n <= 0) {
                subscriber.onError(new IllegalArgumentException(
                    "request must be positive; got: " + n));
                return;
            }

            // Atomic accumulation of demand (handle Long.MAX_VALUE overflow)
            long prev = demand.getAndUpdate(current ->
                current == Long.MAX_VALUE ? Long.MAX_VALUE :
                Math.min(Long.MAX_VALUE, current + n));

            if (prev > 0) {
                return; // already emitting, new demand will be picked up
            }

            emit(); // start emitting
        }

        @Override
        public void cancel() {
            // Rule 3.6 — record cancellation, stop emitting
            cancelled.set(true);
        }

        private void emit() {
            // This simple implementation emits synchronously.
            // A real async publisher would schedule emissions on a separate thread.
            while (!cancelled.get() && emitted < count) {
                long remaining = demand.decrementAndGet();
                if (remaining < 0) {
                    demand.incrementAndGet(); // restore: no demand left
                    break;
                }

                String txId = String.format("TXN-%010d", startId + emitted);
                subscriber.onNext(txId);
                emitted++;

                if (emitted == count) {
                    if (!cancelled.get()) {
                        subscriber.onComplete(); // Rule 1.7 — terminal signal
                    }
                    return;
                }
            }
        }
    }
}
```

---

## The Technology Compatibility Kit (TCK)

The [Reactive Streams TCK](https://github.com/reactive-streams/reactive-streams-jvm/tree/master/tck) is a test suite that verifies a `Publisher`, `Subscriber`, or `Processor` implementation complies with all 37 specification rules. If you write a custom reactive source for a financial system (e.g., a custom Kafka or FIX protocol adapter), running the TCK is mandatory.

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.reactivestreams</groupId>
    <artifactId>reactive-streams-tck</artifactId>
    <version>1.0.4</version>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testng</groupId>
    <artifactId>testng</artifactId>
    <version>7.7.1</version>
    <scope>test</scope>
</dependency>
```

```java
import org.reactivestreams.Publisher;
import org.reactivestreams.tck.PublisherVerification;
import org.reactivestreams.tck.TestEnvironment;

// Extend PublisherVerification — the TCK provides ~30 test methods automatically
public class TransactionIdPublisherTCKTest
        extends PublisherVerification<String> {

    public TransactionIdPublisherTCKTest() {
        super(new TestEnvironment(300L)); // 300ms timeout for async operations
    }

    @Override
    public Publisher<String> createPublisher(long elements) {
        // TCK calls this with various element counts, including Long.MAX_VALUE
        // for "unbounded" tests
        long actualCount = Math.min(elements, 100_000); // cap for test performance
        return new TransactionIdPublisher(1, actualCount);
    }

    @Override
    public Publisher<String> createFailedPublisher() {
        // Return a Publisher that immediately signals onError
        return subscriber ->
            subscriber.onSubscribe(new Subscription() {
                @Override public void request(long n) {
                    subscriber.onError(
                        new RuntimeException("Simulated publisher failure"));
                }
                @Override public void cancel() {}
            });
    }

    // Optional: skip tests that require infinite publishers
    @Override
    public long maxElementsFromPublisher() {
        return 100_000;
    }
}
```

```java
// TCK for a custom Subscriber implementation
import org.reactivestreams.tck.SubscriberWhiteboxVerification;

public class LedgerWriterSubscriberTCKTest
        extends SubscriberWhiteboxVerification<LedgerEntry> {

    public LedgerWriterSubscriberTCKTest() {
        super(new TestEnvironment());
    }

    @Override
    public Subscriber<LedgerEntry> createSubscriber(
            WhiteboxSubscriberProbe<LedgerEntry> probe) {
        // The probe is a test double that records method calls
        // Wrap your real subscriber to call probe methods
        return new Subscriber<LedgerEntry>() {
            private final LedgerWriterSubscriber delegate =
                new LedgerWriterSubscriber(ledgerService);

            @Override
            public void onSubscribe(Subscription subscription) {
                probe.registerOnSubscribe(new SubscriberPuppet() {
                    @Override public void triggerRequest(long elements) {
                        subscription.request(elements);
                    }
                    @Override public void signalCancel() {
                        subscription.cancel();
                    }
                });
                delegate.onSubscribe(subscription);
            }

            @Override
            public void onNext(LedgerEntry item) {
                probe.registerOnNext(item);
                delegate.onNext(item);
            }

            @Override
            public void onError(Throwable t) {
                probe.registerOnError(t);
                delegate.onError(t);
            }

            @Override
            public void onComplete() {
                probe.registerOnComplete();
                delegate.onComplete();
            }
        };
    }

    @Override
    public LedgerEntry createElement(int element) {
        return LedgerEntry.debit("ACC-001", new BigDecimal(element));
    }
}
```

---

## Java 9+ Flow API

Java 9 introduced `java.util.concurrent.Flow` — a set of four interfaces that mirror the Reactive Streams spec exactly (same method signatures, same rules), but are part of the JDK without an external dependency.

```java
import java.util.concurrent.Flow;
import java.util.concurrent.SubmissionPublisher;

// SubmissionPublisher is the JDK's built-in hot publisher
// It manages internal subscriber buffers and handles backpressure
public class JdkFlowExample {

    public void demonstrateSubmissionPublisher() throws Exception {
        // SubmissionPublisher is a hot publisher with internal buffering
        SubmissionPublisher<PaymentEvent> publisher =
            new SubmissionPublisher<>();

        // Flow.Subscriber is compatible with Reactive Streams Subscriber
        publisher.subscribe(new Flow.Subscriber<PaymentEvent>() {
            private Flow.Subscription subscription;

            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                this.subscription = subscription;
                subscription.request(10);
            }

            @Override
            public void onNext(PaymentEvent item) {
                processEvent(item);
                subscription.request(1); // request one more after processing each
            }

            @Override
            public void onError(Throwable throwable) {
                log.error("Flow error: {}", throwable.getMessage());
            }

            @Override
            public void onComplete() {
                log.info("Payment event flow completed");
            }
        });

        // Emit events (submit blocks if any subscriber's buffer is full)
        for (int i = 0; i < 100; i++) {
            publisher.submit(new PaymentEvent("EVT-" + i));
        }

        publisher.close();
    }
}
```

### Interoperability: Reactor ↔ Flow ↔ RxJava

```java
import reactor.adapter.JdkFlowAdapter;
import io.reactivex.rxjava3.core.Flowable;

public class InteropExamples {

    // Convert JDK Flow.Publisher to Reactor Flux
    public Flux<PaymentEvent> fromJdkFlow(Flow.Publisher<PaymentEvent> flowPublisher) {
        return JdkFlowAdapter.flowPublisherToFlux(flowPublisher);
    }

    // Convert Reactor Flux to JDK Flow.Publisher
    public Flow.Publisher<PaymentEvent> toJdkFlow(Flux<PaymentEvent> flux) {
        return JdkFlowAdapter.publisherToFlowPublisher(flux);
    }

    // Convert RxJava 3 Flowable to Reactor Flux
    // (Both implement org.reactivestreams.Publisher — direct use is safe)
    public Flux<Transaction> fromRxJava(Flowable<Transaction> flowable) {
        return Flux.from(flowable); // Flowable IS a Publisher — no adapter needed
    }

    // Convert Reactor Flux to RxJava 3 Flowable
    public Flowable<Transaction> toRxJava(Flux<Transaction> flux) {
        return Flowable.fromPublisher(flux); // Flux IS a Publisher
    }

    // Real-world example: legacy RxJava service feeding a Reactor pipeline
    public Flux<SettlementResult> hybridPipeline(
            Flowable<SettlementBatch> rxJavaSource) {
        return Flux.from(rxJavaSource)                   // bridge RxJava to Reactor
            .flatMap(this::validateBatch, 10)             // Reactor operators
            .flatMap(this::submitToLedger, 5)             // Reactor operators
            .doOnNext(result -> metrics.increment("settlement.processed"));
    }
}
```

---

## Common Specification Violations in Financial Code

```java
public class SpecViolationExamples {

    // VIOLATION: Calling onNext after onComplete (Rule 1.7)
    public class BrokenPublisher implements Publisher<Payment> {
        @Override
        public void subscribe(Subscriber<? super Payment> subscriber) {
            subscriber.onSubscribe(new NoopSubscription());
            subscriber.onNext(new Payment("P1"));
            subscriber.onComplete();
            subscriber.onNext(new Payment("P2")); // ILLEGAL — after onComplete
        }
    }

    // VIOLATION: Calling onSubscribe twice (Rule 2.5 — subscriber must cancel
    // the first subscription if a second onSubscribe is received)
    public class BrokenSubscriber implements Subscriber<Payment> {
        private Subscription sub;

        @Override
        public void onSubscribe(Subscription s) {
            if (sub != null) {
                s.cancel(); // correct behavior
            }
            this.sub = s;
            s.request(Long.MAX_VALUE);
        }
        // ... rest of implementation
    }

    // VIOLATION: Requesting from onError or onComplete (Rule 2.4)
    public class AnotherBrokenSubscriber implements Subscriber<Payment> {
        private Subscription subscription;

        @Override
        public void onSubscribe(Subscription s) { this.subscription = s; s.request(1); }

        @Override
        public void onNext(Payment p) { subscription.request(1); }

        @Override
        public void onError(Throwable t) {
            subscription.request(1); // ILLEGAL — subscription is terminated
        }

        @Override
        public void onComplete() {
            subscription.request(1); // ILLEGAL — subscription is terminated
        }
    }

    // VIOLATION: Throwing from onNext (Rule 2.13)
    public class ThrowingSubscriber implements Subscriber<Payment> {
        @Override
        public void onNext(Payment p) {
            if (p.getAmount().compareTo(BigDecimal.ZERO) <= 0) {
                throw new IllegalArgumentException("Invalid amount"); // SPEC VIOLATION
            }
        }
        // ...
    }
}
```

---

## Specification and Thread Safety

A critical rule often missed: the spec guarantees that `onSubscribe`, `onNext`, `onError`, and `onComplete` are called serially — but it does **not** guarantee they are called from the same thread. A publisher may call `onNext` from thread A and `onComplete` from thread B, as long as they are not concurrent.

This matters for financial subscriber implementations that maintain state:

```java
public class ThreadSafeSubscriber implements Subscriber<Transaction> {

    // State shared across onNext calls — must handle cross-thread visibility
    private Subscription subscription;
    private final List<Transaction> buffer = new ArrayList<>();
    private final AtomicLong totalAmount = new AtomicLong(0);

    @Override
    public void onSubscribe(Subscription s) {
        this.subscription = s;
        s.request(100);
    }

    @Override
    public void onNext(Transaction tx) {
        // onNext is called serially (never concurrent) per the spec
        // So we don't need synchronization within a single subscriber chain
        buffer.add(tx);
        totalAmount.addAndGet(tx.getAmountCents()); // AtomicLong for cross-thread visibility

        if (buffer.size() >= 100) {
            flushBatch();
            subscription.request(100);
        }
    }

    private void flushBatch() {
        List<Transaction> batch = new ArrayList<>(buffer);
        buffer.clear();
        ledgerService.writeBatch(batch); // synchronous within serial onNext calls
    }

    @Override
    public void onError(Throwable t) {
        log.error("Transaction stream error after {} transactions processed", buffer.size());
        alerting.critical("Transaction subscriber failed: " + t.getMessage());
    }

    @Override
    public void onComplete() {
        if (!buffer.isEmpty()) {
            flushBatch(); // flush remaining items
        }
        log.info("Transaction stream complete. Total amount: {}",
            totalAmount.get());
    }
}
```

---

## Production Tips and Pitfalls

**Pitfall 1: Implementing Publisher from scratch without running the TCK**

The 37 rules are easy to get subtly wrong. Even experienced engineers miss edge cases like re-entrance, cancellation-after-completion, and demand overflow. Always validate with the TCK.

**Pitfall 2: Using `SubmissionPublisher` for high-throughput financial data**

`SubmissionPublisher.submit()` blocks when any subscriber's buffer is full. For high-throughput payment events, prefer Reactor's `Sinks.many().multicast().onBackpressureBuffer()` which uses non-blocking emission with explicit failure handling.

**Pitfall 3: Bridging Reactor and RxJava 2 (not 3)**

RxJava 2's `Flowable` implements `org.reactivestreams.Publisher` and can be used directly with Reactor. RxJava 1's `Observable` does not and requires explicit adaptation. RxJava 3's `Flowable` also implements `org.reactivestreams.Publisher`.

**Pitfall 4: Processor interface is deprecated in practice**

The `Processor` interface is rarely the right tool. It is difficult to implement correctly (must maintain both publisher and subscriber spec compliance simultaneously). Use Reactor's `Sinks` or `ConnectableFlux` instead.

---

## Summary

The Reactive Streams specification is the foundation of the entire reactive ecosystem:

- **Four interfaces** (`Publisher`, `Subscriber`, `Subscription`, `Processor`) with precise behavioral rules
- **37 rules** govern the protocol — especially the serial call guarantee and demand-driven emission
- **TCK** verifies compliance — always run it for custom Publishers or Subscribers in financial systems
- **Java 9 Flow API** mirrors the spec exactly — interoperable with zero adapters
- **Reactor, RxJava, Akka** are all spec-compliant — interoperate via `Flux.from()` and `Flowable.fromPublisher()`
- **Violations manifest as subtle bugs** — items emitted after cancellation, duplicate onSubscribe, concurrent signal calls — often only visible under load

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the invariant that must hold regarding onSubscribe in the Reactive Streams specification?",
      "options": ["onSubscribe must be called at least once per subscription", "onSubscribe must be called exactly once before any other signal; calling it twice is a spec violation", "onSubscribe may be called after onNext if the publisher needs to reset", "onSubscribe is optional if the publisher immediately calls onComplete"],
      "correct": 1,
      "explanation": "Rule 1.9 of the Reactive Streams specification requires onSubscribe to be called exactly once, before any other signals. A publisher that calls onSubscribe twice violates the spec and can cause duplicate subscriptions, resource leaks, or incorrect state in the subscriber."
    },
    {
      "text": "Why does the specification prohibit publishers from calling onNext more times than the subscriber has requested via request(n)?",
      "options": ["To reduce network bandwidth usage", "To enforce the demand-driven backpressure contract — excess emissions would overflow the subscriber's processing capacity and could cause OutOfMemoryError", "To ensure thread safety in multi-threaded publishers", "To comply with HTTP/2 flow control requirements"],
      "correct": 1,
      "explanation": "The request(n) protocol exists specifically to let consumers control the rate of data flow. If a publisher emits more than n items before the next request(n), the consumer's internal queue can grow unboundedly, causing memory exhaustion. The spec violation breaks the entire backpressure guarantee."
    },
    {
      "text": "What is the purpose of the Reactive Streams Technology Compatibility Kit (TCK)?",
      "options": ["A code generation tool for creating Publisher implementations", "A test suite that verifies a Publisher, Subscriber, or Processor implementation satisfies all Reactive Streams specification rules, enabling safe interoperability", "A monitoring tool for measuring reactive pipeline throughput", "A benchmarking framework for comparing reactive library performance"],
      "correct": 1,
      "explanation": "The TCK is the official compliance test suite for the Reactive Streams specification. Any library or custom implementation that passes the TCK is guaranteed to interoperate correctly with other spec-compliant libraries like Reactor, RxJava, and Akka Streams."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Custom Reactive Streams Publisher with TCK Compliance",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a custom Publisher<Payment> that reads from an in-memory queue of payments. The publisher must respect the request(n) protocol: emit exactly n items per request call, handle cancellation gracefully, and call onComplete when the queue is exhausted. Do not emit after cancellation."},
    {"id": "2", "description": "Run the Reactive Streams TCK PublisherVerification against your custom publisher. Fix any failing test cases. Document which TCK rules were initially violated and what code changes fixed each violation."},
    {"id": "3", "description": "Implement a custom Processor<Payment, EnrichedPayment> that adds fraud score to each payment using a synchronous lookup. The processor must propagate cancellation upstream and downstream, forward error signals, and pass both PublisherVerification and SubscriberWhiteboxVerification from the TCK."},
    {"id": "4", "description": "Demonstrate interoperability between your custom Publisher and Project Reactor: wrap your Publisher with Flux.from(publisher) and verify via StepVerifier that all items are emitted in order, backpressure is respected (using StepVerifier.withInitialRequest(5)), and onComplete fires correctly."}
  ]
}
-->

Understanding the specification transforms reactive debugging from magic to systematic analysis. When a payment is lost or a stream terminates unexpectedly, the first question is: which spec rule was violated?
