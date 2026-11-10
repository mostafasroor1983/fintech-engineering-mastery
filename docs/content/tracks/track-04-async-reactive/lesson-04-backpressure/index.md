---
id: track-04-lesson-04
title: "Backpressure — Controlling Data Flow Under Load"
slug: backpressure
track: track-04
trackName: Async & Reactive Systems
sequence: 4
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [backpressure, overflow, request-n, drop, buffer]
prerequisites: []
---

# Backpressure — Controlling Data Flow Under Load

> [!NOTE]
> Backpressure is the mechanism by which a slow consumer signals to a fast producer that it needs to slow down. In financial systems — where a payment gateway may receive 50,000 transactions per second but the fraud engine can only evaluate 10,000 per second — backpressure is the difference between a stable system and an `OutOfMemoryError` at peak load.

## The Problem: Producer-Consumer Speed Mismatch

Consider a real-time payment processing pipeline:

```
Payment Gateway     Fraud Engine      Ledger Writer
  50,000 TPS   -->   10,000 TPS  -->   5,000 TPS
     fast           medium slow         slow
```

Without backpressure, the fast payment gateway floods the fraud engine's input queue. Within seconds, the queue grows without bound. Memory is exhausted. The JVM crashes. All in-flight payments are lost.

Backpressure solves this by turning the data flow around: instead of the producer pushing as fast as it can, the consumer **pulls** at the rate it can handle. This is the foundation of the Reactive Streams specification's `request(n)` protocol.

```
Producer ────────────────────────────────────► Consumer
         ◄──── request(10) ─────────────────────
         ─────── onNext * 10 ─────────────────►
         ◄──── request(5) ──────────────────────
         ─────── onNext * 5 ─────────────────►
```

---

## The request(n) Protocol

Every `Subscription` in Reactive Streams has a single method: `request(long n)`. A subscriber calls `request(n)` to tell the publisher "I am ready to receive up to `n` items." The publisher must not emit more than `n` items before the next `request(n)` call.

```java
import org.reactivestreams.Subscriber;
import org.reactivestreams.Subscription;

// A manually implemented subscriber that requests items in controlled batches
// This pattern is rare in application code but illustrates the protocol
public class BatchingPaymentSubscriber implements Subscriber<Payment> {

    private static final int BATCH_SIZE = 100;
    private Subscription subscription;
    private int processed = 0;

    @Override
    public void onSubscribe(Subscription subscription) {
        this.subscription = subscription;
        subscription.request(BATCH_SIZE); // request first batch
    }

    @Override
    public void onNext(Payment payment) {
        processPayment(payment);
        processed++;

        if (processed % BATCH_SIZE == 0) {
            subscription.request(BATCH_SIZE); // request next batch after consuming current
        }
    }

    @Override
    public void onError(Throwable t) {
        log.error("Payment stream error: {}", t.getMessage());
        alertingService.notify("Payment stream failed: " + t.getMessage());
    }

    @Override
    public void onComplete() {
        log.info("Payment stream completed. Total processed: {}", processed);
        metrics.gauge("payment.batch.total", processed);
    }
}
```

In practice, Reactor's operators handle `request(n)` automatically. When you use `flatMap(concurrency=16)`, Reactor requests 16 items from upstream, processes them, and requests the next 16 when done. This is **operator-level backpressure**.

---

## BufferOverflowStrategy

When a publisher emits faster than the subscriber can consume — especially across asynchronous boundaries — Reactor must decide what to do with excess items. The `OverflowStrategy` controls this behavior.

```java
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;

public class OverflowStrategyExamples {

    // BUFFER — queue excess items in memory (can cause OOM under sustained overload)
    // Use only when bursts are short-lived and predictable
    public Flux<Payment> bufferedStrategy(PaymentGateway gateway) {
        return Flux.create(
            sink -> gateway.registerListener(sink::next),
            FluxSink.OverflowStrategy.BUFFER // unlimited buffer — dangerous in production
        );
    }

    // DROP — silently discard excess items when downstream can't keep up
    // Use for real-time market data where stale prices are worthless
    public Flux<FxRate> dropStrategy(FxRateFeed feed) {
        return Flux.create(
            sink -> feed.registerListener(sink::next),
            FluxSink.OverflowStrategy.DROP
        );
    }

    // LATEST — keep only the most recent item, discard older buffered items
    // Use for metrics snapshots, dashboard updates, position summaries
    public Flux<PortfolioSnapshot> latestStrategy(PortfolioFeed feed) {
        return Flux.create(
            sink -> feed.registerListener(sink::next),
            FluxSink.OverflowStrategy.LATEST
        );
    }

    // ERROR — throw OverflowException when downstream can't keep up
    // Use when dropping or buffering is unacceptable (e.g., guaranteed delivery)
    public Flux<AuditEvent> errorStrategy(AuditEventSource source) {
        return Flux.create(
            sink -> source.registerListener(sink::next),
            FluxSink.OverflowStrategy.ERROR
        );
    }
}
```

---

## onBackpressureBuffer, onBackpressureDrop, onBackpressureLatest

These operators are applied to an existing `Flux` to add an explicit backpressure strategy after the source, often at an asynchronous boundary.

```java
public class BackpressureOperators {

    // onBackpressureBuffer — bounded buffer with configurable overflow handler
    public Flux<Payment> bufferedPayments(Flux<Payment> source) {
        return source
            .onBackpressureBuffer(
                1000,                    // max buffer size
                droppedPayment -> {       // called when buffer is full
                    log.warn("Payment dropped due to buffer overflow: {}",
                        droppedPayment.getId());
                    metrics.increment("payment.backpressure.dropped");
                    deadLetterQueue.publish(droppedPayment); // ensure no payment is lost
                },
                BufferOverflowStrategy.DROP_OLDEST // drop oldest buffered item when full
            )
            .publishOn(Schedulers.boundedElastic()); // async boundary
    }

    // onBackpressureDrop — silently drop items when downstream is slow
    // With a callback to record what was dropped
    public Flux<FxRate> droppedRates(Flux<FxRate> rawFeed) {
        return rawFeed
            .onBackpressureDrop(rate -> {
                log.debug("FX rate dropped: {} = {}", rate.getPair(), rate.getBid());
                metrics.increment("fxrate.dropped", "pair", rate.getPair());
            })
            .publishOn(Schedulers.parallel());
    }

    // onBackpressureLatest — only keep the latest unprocessed item
    // Useful for account balance updates — only the latest balance matters
    public Flux<AccountBalance> latestBalances(Flux<AccountBalance> balanceUpdates) {
        return balanceUpdates
            .onBackpressureLatest()
            .publishOn(Schedulers.boundedElastic());
    }

    // onBackpressureError — immediately fail if downstream is too slow
    // Use in guaranteed-delivery pipelines where you'd rather fail fast than lose data
    public Flux<SettlementRecord> strictBackpressure(Flux<SettlementRecord> records) {
        return records
            .onBackpressureError()
            .onErrorResume(OverflowException.class, ex -> {
                alerting.critical("Settlement pipeline overwhelmed — circuit breaking");
                return Flux.error(new SettlementPipelineOverloadedException(ex));
            });
    }
}
```

---

## Schedulers and Backpressure Interaction

Backpressure becomes critical when crossing thread boundaries with `publishOn` or `subscribeOn`. Each `publishOn` introduces an internal queue. If that queue overflows, items are lost or the stream fails.

```java
public class SchedulerBackpressureInteraction {

    // The queue between publishOn and downstream has a default size of 256
    // If downstream processes slower than 256 items can queue, overflow occurs
    public Flux<Transaction> dangerousDefaults(Flux<Transaction> transactions) {
        return transactions
            .publishOn(Schedulers.boundedElastic()); // default queue: 256 items
        // If upstream is faster than 256 TPS bursts, we lose items!
    }

    // Explicit queue size — tune for your throughput profile
    public Flux<Transaction> tunedQueue(Flux<Transaction> transactions) {
        return transactions
            .publishOn(
                Schedulers.boundedElastic(),
                4096 // explicitly sized queue — size to your burst profile
            );
    }

    // Bounded elastic scheduler configuration for payment processing
    @Bean
    public Scheduler paymentProcessorScheduler() {
        return Schedulers.newBoundedElastic(
            50,                           // max thread count
            10000,                        // max queued tasks (bounded elastic queue)
            "payment-processor",          // thread name prefix
            60                            // keep-alive seconds for idle threads
        );
    }

    // Full pipeline with explicit backpressure at each async boundary
    public Flux<ProcessedPayment> fullPipelineWithBackpressure(
            Flux<InboundPayment> inbound) {
        return inbound
            // Stage 1: validation on I/O thread, with bounded buffer
            .onBackpressureBuffer(500, p ->
                metrics.increment("payment.validation.overflow"))
            .publishOn(validationScheduler, 128)
            .map(this::validate)

            // Stage 2: enrichment — concurrent, with controlled parallelism
            .flatMap(this::enrich, 32) // 32 concurrent enrichments = natural backpressure

            // Stage 3: fraud check — slower, reduce concurrency
            .flatMap(this::fraudCheck, 10) // 10 concurrent fraud checks

            // Stage 4: ledger write — bounded, ordered per account
            .groupBy(EnrichedPayment::getSenderId)
            .flatMap(group ->
                group
                    .onBackpressureBuffer(50)
                    .concatMap(this::writeLedger), // sequential writes per account
                100 // max 100 account groups in parallel
            );
    }
}
```

---

## Backpressure in Payment Processing Pipelines

Here is a production-grade payment ingestion pipeline with proper backpressure at every stage:

```java
@Service
public class HighVolumePaymentIngestionService {

    // Kafka consumer publishes at market rate (could be 50k TPS)
    // We must protect each downstream stage
    public Flux<PaymentResult> ingestFromKafka(
            KafkaReceiver<String, PaymentMessage> kafkaReceiver) {

        return kafkaReceiver.receive()
            // Bridge Kafka's poll-based delivery into Reactor
            // Kafka provides natural backpressure: we only poll when ready
            .map(record -> record.value())

            // Stage 1: Deserialization is cheap — allow generous buffer
            .onBackpressureBuffer(10_000)
            .map(this::deserialize)

            // Stage 2: Deduplication — bounded window to catch replays
            .filterWhen(payment ->
                idempotencyStore.isNew(payment.getIdempotencyKey())
                    .timeout(Duration.ofMillis(50))
                    .onErrorReturn(true)) // assume new on timeout, deduplicate later

            // Stage 3: Parallel validation — 50 concurrent, bounded by our DB pool
            .flatMap(payment ->
                validateAsync(payment)
                    .timeout(Duration.ofSeconds(2))
                    .onErrorResume(ex -> Mono.just(Payment.failed(payment, ex))),
                50
            )

            // Stage 4: Route valid vs failed
            .groupBy(payment -> payment.isValid() ? "valid" : "failed")
            .flatMap(group -> {
                if ("valid".equals(group.key())) {
                    return group.flatMap(this::processValid, 20);
                } else {
                    return group.flatMap(this::handleFailed, 100);
                }
            }, 2) // only 2 groups: valid and failed

            // Stage 5: Emit with rate observability
            .doOnNext(result ->
                throughputCounter.increment())

            // Error recovery — do not terminate the entire pipeline on one payment failure
            .onErrorContinue((ex, item) ->
                log.error("Unrecoverable error for item {}: {}",
                    item, ex.getMessage()));
    }

    private Mono<Payment> validateAsync(Payment payment) {
        return Mono.zip(
            fraudService.preScreen(payment)
                .subscribeOn(Schedulers.boundedElastic()),
            accountService.checkExists(payment.getSenderId())
                .subscribeOn(Schedulers.boundedElastic()),
            limitsService.checkLimits(payment)
                .subscribeOn(Schedulers.boundedElastic())
        ).map(tuple -> payment.withValidationResults(
            tuple.getT1(), tuple.getT2(), tuple.getT3()));
    }
}
```

---

## Monitoring Overflow

Invisible item loss is dangerous in financial systems. Every backpressure drop must be instrumented.

```java
public class BackpressureMonitoring {

    private final MeterRegistry meterRegistry;

    public Flux<Payment> monitoredBackpressure(Flux<Payment> source) {
        AtomicLong droppedCount = new AtomicLong(0);

        // Gauge for real-time drop rate monitoring
        Gauge.builder("payment.backpressure.dropped", droppedCount, AtomicLong::get)
            .description("Number of payments dropped due to backpressure overflow")
            .register(meterRegistry);

        return source
            .onBackpressureBuffer(
                2000,
                dropped -> {
                    droppedCount.incrementAndGet();
                    metrics.increment("payment.backpressure.overflow",
                        "strategy", "drop",
                        "stage", "ingestion");

                    // Persist dropped payments to recovery queue
                    recoveryQueue.offer(dropped);
                    log.warn("Payment {} dropped from pipeline. Total dropped: {}",
                        dropped.getId(), droppedCount.get());
                },
                BufferOverflowStrategy.DROP_LATEST
            );
    }

    // Track buffer depth to predict overflow before it happens
    public Flux<Payment> instrumentedBuffer(Flux<Payment> source, String stageName) {
        AtomicInteger bufferDepth = new AtomicInteger(0);

        Gauge.builder("payment.buffer.depth", bufferDepth, AtomicInteger::get)
            .tag("stage", stageName)
            .register(meterRegistry);

        return source
            .doOnNext(p -> bufferDepth.incrementAndGet())
            .onBackpressureBuffer(1000, dropped ->
                metrics.increment("payment.buffer.overflow", "stage", stageName))
            .doOnNext(p -> bufferDepth.decrementAndGet());
    }
}
```

---

## Testing Backpressure Behavior

```java
import reactor.test.StepVerifier;
import reactor.test.publisher.TestPublisher;

public class BackpressureTests {

    @Test
    void testBackpressureBufferOnOverflow() {
        // Given a source that emits 20 items immediately
        Flux<Integer> fastSource = Flux.range(1, 20);

        // With a buffer of 5 and DROP_OLDEST strategy
        Flux<Integer> withBackpressure = fastSource
            .onBackpressureBuffer(5, BufferOverflowStrategy.DROP_OLDEST);

        // The subscriber requests items one at a time (simulating a slow consumer)
        StepVerifier.create(withBackpressure, 1) // request 1 at a time
            .expectNextCount(1)
            .thenRequest(1)
            .expectNextCount(1)
            .thenCancel()
            .verify();
    }

    @Test
    void testBackpressureDropNotifiesWhenDropped() {
        List<Integer> dropped = new ArrayList<>();

        Flux<Integer> source = Flux.range(1, 100)
            .onBackpressureDrop(dropped::add);

        // Request only 5 items
        StepVerifier.create(source, 5)
            .expectNextCount(5)
            .thenCancel()
            .verify();

        // The source emitted 100 but we only consumed 5
        // Remaining 95 were dropped
        assertThat(dropped).hasSize(95);
    }

    @Test
    void testSlowConsumerWithBoundedBuffer() {
        // TestPublisher allows manual control of emissions
        TestPublisher<Payment> publisher = TestPublisher.create();

        Flux<Payment> withBuffer = publisher.flux()
            .onBackpressureBuffer(3, BufferOverflowStrategy.ERROR);

        StepVerifier.create(withBuffer, 0) // start with no demand
            .then(() -> publisher.next(payment(1))) // emit without demand
            .then(() -> publisher.next(payment(2))) // buffered
            .then(() -> publisher.next(payment(3))) // buffered (buffer full at 3)
            .then(() -> publisher.next(payment(4))) // should trigger ERROR
            .expectError(OverflowException.class)
            .verify();
    }

    @Test
    void testFlatMapConcurrencyLimitsBackpressure() {
        AtomicInteger maxConcurrent = new AtomicInteger(0);
        AtomicInteger current = new AtomicInteger(0);

        Flux<String> result = Flux.range(1, 20)
            .flatMap(i -> Mono.fromCallable(() -> {
                int c = current.incrementAndGet();
                maxConcurrent.updateAndGet(max -> Math.max(max, c));
                Thread.sleep(10); // simulate I/O
                current.decrementAndGet();
                return "result-" + i;
            }).subscribeOn(Schedulers.boundedElastic()),
            5 // max concurrency = 5
        );

        StepVerifier.create(result)
            .expectNextCount(20)
            .verifyComplete();

        assertThat(maxConcurrent.get()).isLessThanOrEqualTo(5);
    }
}
```

---

## Backpressure Strategies by Financial Use Case

| Use Case | Recommended Strategy | Rationale |
|----------|---------------------|-----------|
| Payment ingestion | `onBackpressureBuffer` with dead-letter | No payment can be silently lost |
| FX rate feed | `onBackpressureDrop` or `LATEST` | Stale prices are worthless |
| Fraud pre-screening | `flatMap(concurrency=N)` | Natural pull-based pressure |
| Settlement batch | `concatMap` | Strictly ordered writes |
| Real-time risk dashboard | `onBackpressureLatest` | Only latest snapshot matters |
| Audit log stream | `onBackpressureError` + circuit breaker | Audit loss is a compliance failure |
| Market data analytics | `onBackpressureBuffer(bounded)` | Acceptable to miss some ticks |

---

## Reactive Streams Specification and Backpressure Rules

The backpressure contract is encoded in the Reactive Streams specification. Key rules:

1. A `Publisher` must not emit more items than the total requested via `request(n)`.
2. `request(Long.MAX_VALUE)` signals unbounded demand — the publisher may emit as fast as possible. Only use this when the consumer can genuinely handle unlimited throughput (e.g., in-memory transformations).
3. `Subscription.cancel()` does not guarantee immediate stopping; the publisher may emit a few more items after cancel is called.
4. `onError` and `onComplete` are terminal signals — no items may follow them.

```java
// Long.MAX_VALUE = "I can handle everything" — only use for in-memory pipelines
Flux.range(1, 1_000_000)
    .map(i -> i * 2) // pure in-memory — genuinely unbounded throughput
    .subscribe(System.out::println); // subscribe() internally requests Long.MAX_VALUE
```

---

## Production Tips and Pitfalls

**Pitfall 1: `Flux.create` with unbounded BUFFER**

The default `OverflowStrategy.BUFFER` for `Flux.create` has an unbounded internal queue. Under sustained overload, this causes `OutOfMemoryError`. Always specify a bounded buffer or use `DROP`/`LATEST` for event bridges.

**Pitfall 2: `publishOn` queue size**

Every `publishOn` creates an internal queue with a default size of 256. If upstream produces faster than 256 items between downstream polls, items are dropped silently. Tune the queue size or add explicit `onBackpressureBuffer` before `publishOn`.

**Pitfall 3: `flatMap` without concurrency limit**

`flatMap` without a concurrency argument subscribes to ALL inner publishers simultaneously. For a `Flux` of 10,000 payments, this creates 10,000 concurrent database connections. Always specify max concurrency: `flatMap(this::process, 20)`.

**Pitfall 4: Ignoring drop callbacks**

Dropped items in `onBackpressureDrop` without a callback cause silent data loss. In financial systems, dropped items must be routed to a dead-letter queue or alert, not silently discarded.

```java
// WRONG — silent loss
.onBackpressureDrop()

// CORRECT — always handle drops
.onBackpressureDrop(payment -> {
    log.error("CRITICAL: Payment {} dropped from pipeline", payment.getId());
    deadLetterQueue.publish(payment);
    metrics.increment("payment.lost.backpressure");
    alerting.critical("Payment pipeline losing items — investigate immediately");
})
```

**Pitfall 5: Requesting Long.MAX_VALUE across I/O boundaries**

When a subscriber calls `request(Long.MAX_VALUE)` and the publisher is backed by an I/O source (Kafka, database), the publisher may try to fetch all data at once. Use bounded prefetch and let back-pressure propagate naturally.

---

## Summary

Backpressure is what makes reactive systems reliable under load:

- The `request(n)` protocol is the core mechanism — consumers pull at their own pace
- `onBackpressureBuffer` / `Drop` / `Latest` / `Error` handle mismatches at async boundaries
- `flatMap(concurrency=N)` provides natural operator-level backpressure
- Every dropped item in a financial pipeline is a potential compliance issue — always log and route to recovery
- Monitor buffer depths and drop rates as first-class production metrics
- Tune `publishOn` queue sizes to match your burst profile

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the purpose of the request(n) protocol in Reactive Streams?",
      "options": ["To configure HTTP request timeouts in WebFlux", "To allow a subscriber to signal to the publisher exactly how many items it is ready to receive, preventing the producer from overwhelming the consumer", "To define the number of retry attempts on error", "To set the buffer size for the publishOn operator queue"],
      "correct": 1,
      "explanation": "request(n) is the demand signaling mechanism in Reactive Streams. A subscriber calls request(n) to tell the publisher it can handle n more items. The publisher must not emit more than n items before the next request(n) call. This pull-based model is how backpressure propagates from consumer to producer."
    },
    {
      "text": "In a payment pipeline with a 50,000 TPS gateway and a 10,000 TPS fraud engine, what is the correct backpressure strategy if dropped payments are unacceptable?",
      "options": ["Use onBackpressureDrop() to silently discard excess payments", "Apply onBackpressureBuffer() with a large buffer and route overflow to a persistent queue (Kafka) for later processing", "Use onBackpressureLatest() to keep only the most recent payment", "Increase the fraud engine thread pool to match gateway throughput"],
      "correct": 1,
      "explanation": "Dropping payments is unacceptable in a financial system. The correct approach is to buffer what fits in memory and overflow to a durable queue (Kafka) so no payment is lost. onBackpressureDrop and onBackpressureLatest discard items — never acceptable for financial transactions."
    },
    {
      "text": "What does the concurrency parameter in flatMap control in terms of backpressure?",
      "options": ["The number of threads assigned to the flatMap operator", "The maximum number of inner publishers (e.g., concurrent HTTP calls) that flatMap will subscribe to simultaneously, limiting in-flight requests", "The buffer size for collecting flatMap results", "The retry count for failed inner publishers"],
      "correct": 1,
      "explanation": "flatMap's concurrency parameter limits how many inner subscriptions are active at once. With flatMap(fn, 10), only 10 concurrent HTTP calls are in-flight at any time. New items are buffered until an inner publisher completes. This provides natural backpressure at the operator level."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Backpressure-Aware Payment Processing Pipeline",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a custom Subscriber that calls request(10) in onSubscribe, processes each item, and calls request(1) after each item completes. Connect it to a Flux that emits 100 payment events. Use Thread.sleep() to simulate a slow consumer at 100ms per item and verify the producer does not emit faster than the consumer requests."},
    {"id": "2", "description": "Build a payment ingestion pipeline with a hot publisher (Sinks.many().multicast()) emitting at 1000 events/second and a subscriber processing at 200 events/second. Apply onBackpressureBuffer(500, payment -> deadLetterQueue.add(payment), BufferOverflowStrategy.DROP_OLDEST). Monitor buffer depth with a gauge and verify overflow behavior."},
    {"id": "3", "description": "Demonstrate flatMap concurrency backpressure: create a Flux of 1000 payments, each requiring a 50ms external HTTP call. Compare throughput and memory usage with flatMap(fn, 1), flatMap(fn, 10), flatMap(fn, 100), and flatMap(fn). Explain the optimal concurrency for a service with 50 available connections."},
    {"id": "4", "description": "Instrument the backpressure pipeline with Micrometer: add gauges for buffer.depth and buffer.capacity, counters for items.dropped and items.processed, and a histogram for processing latency. Set up an alert that fires when buffer.depth exceeds 80% of buffer.capacity for more than 30 seconds."}
  ]
}
-->

In the next lesson, we examine the Reactive Streams specification and TCK — the formal contract that underpins all of Reactor's backpressure guarantees.
