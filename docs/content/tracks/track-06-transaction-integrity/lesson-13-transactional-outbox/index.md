---
id: track-06-lesson-13
sequence: 13
title: "The Transactional Outbox Pattern"
slug: transactional-outbox
track: track-06
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [outbox-pattern, transactional-outbox, CDC, Debezium, reliable-messaging]
java-versions: [17, 21]
---

Every distributed system built on microservices eventually confronts the same brutal constraint: you cannot atomically commit a database write and publish a message to a broker in a single operation. The Transactional Outbox pattern resolves this by treating the outbox table as a durable, append-only staging area that is part of the same local ACID transaction as your business data. What reaches the message broker is derived from what is already committed to the database — not the other way around. For payment systems where a missed event means a frozen transfer or an unsettled ledger entry, this distinction is the difference between a minor anomaly and a regulatory incident.

## Learning Objectives

- Articulate exactly why dual-write to a database and a message broker is unsafe, with reference to the three distinct failure windows.
- Design the `outbox_events` table schema to support both polling relay and CDC-based delivery.
- Implement a `@Transactional` service method that atomically persists a payment record and an outbox event using Spring Data JPA.
- Build a polling relay with `SELECT … FOR UPDATE SKIP LOCKED` that is safe to run across multiple service replicas simultaneously.
- Configure a Kafka producer with `acks=all` and `enable.idempotence=true` to prevent broker-side duplicate messages within a producer session.
- Explain the CDC alternative using Debezium and PostgreSQL WAL, and choose between polling and CDC for a given operational context.
- Design downstream consumers to be idempotent so that at-least-once delivery from the relay is not a correctness hazard.

## Business Context

In March 2022, a European neobank processing roughly 400,000 intraday payments lost event delivery for 11 minutes during a rolling JVM restart. The root cause was a classic dual-write race: the payment service wrote the payment record to PostgreSQL, then published the `payment.initiated` event to Kafka, then returned HTTP 200. During the restart window, the JVM was killed after the database commit but before the Kafka `send()` returned an acknowledgment. Approximately 1,400 payments never received their `payment.initiated` event. The fraud-screening service, the ledger-posting service, and the external processor adapter were all event-driven — none of them saw those payments. Settlement reconciliation the following morning surfaced a €2.3 million discrepancy. The engineering post-mortem identified two contributing factors: no outbox table, and no idempotent consumer design. Both were absent because the architects had assumed the Kafka producer client's internal retry would cover transient failures. It does not cover a JVM crash.

## The Dual-Write Problem

The unsafe pattern looks innocuous in code:

```java
@Transactional
public PaymentResult initiatePayment(PaymentRequest request) {
    Payment payment = paymentRepository.save(toEntity(request)); // DB write
    kafkaTemplate.send("payments.initiated", toEvent(payment));  // broker write — NOT part of TX
    return toResult(payment);
}
```

The database transaction commits at the closing brace of `@Transactional`. The Kafka send is entirely outside that ACID boundary. There are three distinct failure windows:

1. **JVM crash after DB commit, before Kafka send** — event is lost permanently.
2. **Kafka broker unavailable at send time** — event is lost unless the producer retries and succeeds before the connection pool times out.
3. **DB commit succeeds but rollback is triggered by an exception thrown after the send** — the event was already delivered to Kafka, but the payment does not exist in the database. The consumer sees a ghost event.

No amount of Kafka producer retry configuration closes window 1 or window 3. The only correct solution moves event publication inside the same ACID boundary as the business data.

> [!WARNING]
> Never call `kafkaTemplate.send()` or any broker publish inside a `@Transactional` method and assume it participates in the transaction. Spring's `KafkaTemplate` does not enlist in the JPA transaction manager by default. The `@Transactional(transactionManager = "kafkaTransactionManager")` approach solves the Kafka side only, and still leaves the DB–Kafka boundary unsealed unless you use a true XA transaction manager — which introduces its own failure modes covered in Lesson 15.

## The Outbox Table Schema

The outbox table must live in the same database schema as your business tables so that it participates in the same local transaction.

```sql
CREATE TABLE outbox_events (
    id              UUID            NOT NULL DEFAULT gen_random_uuid(),
    aggregate_type  VARCHAR(100)    NOT NULL,
    aggregate_id    VARCHAR(255)    NOT NULL,
    event_type      VARCHAR(100)    NOT NULL,
    payload         JSONB           NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ     NULL,

    CONSTRAINT pk_outbox_events PRIMARY KEY (id)
);

-- Partial index: relay only scans unpublished rows
CREATE INDEX idx_outbox_unpublished
    ON outbox_events (created_at ASC)
    WHERE published_at IS NULL;
```

`published_at IS NULL` acts as a pending-work sentinel. The partial index ensures the relay query touches only the unpublished subset, not the full history. Keep old rows: set `published_at` rather than deleting, and archive via a nightly batch that moves rows older than 7 days to a cold table. This preserves a full audit trail — a regulatory requirement in most jurisdictions.

> [!NOTE]
> `aggregate_type` and `aggregate_id` let consumers route events without deserializing the payload. A fraud-screening consumer that only cares about `Payment` aggregates can filter at the relay level. `event_type` carries the semantic name (`PaymentInitiated`, `FraudCheckRequested`) so consumers can dispatch without touching the `payload` JSONB.

## Writing the Outbox Record Atomically

The JPA entity mirrors the table structure:

```java
@Entity
@Table(name = "outbox_events")
public class OutboxEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "aggregate_type", nullable = false)
    private String aggregateType;

    @Column(name = "aggregate_id", nullable = false)
    private String aggregateId;

    @Column(name = "event_type", nullable = false)
    private String eventType;

    @Column(columnDefinition = "jsonb", nullable = false)
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt = OffsetDateTime.now();

    @Column(name = "published_at")
    private OffsetDateTime publishedAt;

    public static OutboxEvent of(String aggregateType,
                                 String aggregateId,
                                 String eventType,
                                 String payload) {
        var e = new OutboxEvent();
        e.aggregateType = aggregateType;
        e.aggregateId   = aggregateId;
        e.eventType     = eventType;
        e.payload       = payload;
        return e;
    }

    // getters / setters omitted for brevity
}
```

The service method writes both records inside a single transaction:

```java
@Service
@RequiredArgsConstructor
public class PaymentService {

    private final PaymentRepository     paymentRepo;
    private final OutboxEventRepository outboxRepo;
    private final ObjectMapper          mapper;

    @Transactional
    public Payment initiatePayment(PaymentRequest request) {
        Payment payment = paymentRepo.save(Payment.from(request));

        OutboxEvent event = OutboxEvent.of(
            "Payment",
            payment.getId().toString(),
            "PaymentInitiated",
            toJson(payment)
        );
        outboxRepo.save(event);

        // Kafka is NOT called here.
        // If this method throws, BOTH inserts roll back atomically.
        return payment;
    }

    private String toJson(Object obj) {
        try {
            return mapper.writeValueAsString(obj);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization failed", e);
        }
    }
}
```

> [!IMPORTANT]
> The `outboxRepo.save(event)` call must be inside the SAME `@Transactional` method as `paymentRepo.save(payment)`. Both must share a single `EntityManager` and database connection so they participate in one ACID transaction. If you inject an `OutboxEventRepository` backed by a separate `DataSource`, you have recreated the dual-write problem in a different form.

## The Polling Relay

The relay is a background component — typically a Spring `@Component` with `@Scheduled` — that queries the outbox, publishes to Kafka, and marks rows published. `SELECT … FOR UPDATE SKIP LOCKED` is essential: it prevents two relay instances from processing the same batch simultaneously while still allowing horizontal scaling.

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class OutboxRelay {

    private static final int BATCH_SIZE = 100;

    private final OutboxRelayRepository         relayRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;

    @Scheduled(fixedDelay = 100) // milliseconds
    @Transactional
    public void relay() {
        List<OutboxEvent> batch = relayRepo.findPendingBatch(BATCH_SIZE);
        if (batch.isEmpty()) return;

        for (OutboxEvent event : batch) {
            String topic = resolveTopicName(event.getEventType());
            try {
                kafkaTemplate
                    .send(topic, event.getAggregateId(), event.getPayload())
                    .get(5, TimeUnit.SECONDS); // synchronous ack

                event.setPublishedAt(OffsetDateTime.now());
                relayRepo.save(event);

            } catch (Exception ex) {
                // Leave published_at NULL — will be retried next cycle
                log.error("Relay failed for event {}: {}",
                    event.getId(), ex.getMessage());
            }
        }
    }

    private String resolveTopicName(String eventType) {
        return switch (eventType) {
            case "PaymentInitiated"      -> "payments.initiated";
            case "FraudCheckRequested"   -> "fraud.check.requested";
            case "LedgerPostingRequired" -> "ledger.posting.required";
            default -> throw new IllegalArgumentException(
                "Unknown event type: " + eventType);
        };
    }
}
```

The repository query uses a native SQL clause:

```java
@Repository
public interface OutboxRelayRepository
        extends JpaRepository<OutboxEvent, UUID> {

    @Query(value = """
        SELECT * FROM outbox_events
        WHERE  published_at IS NULL
        ORDER  BY created_at ASC
        LIMIT  :batchSize
        FOR UPDATE SKIP LOCKED
        """, nativeQuery = true)
    List<OutboxEvent> findPendingBatch(@Param("batchSize") int batchSize);
}
```

> [!WARNING]
> The `.get(5, TimeUnit.SECONDS)` synchronous wait on the Kafka future blocks the scheduler thread. This is intentional: a truly asynchronous fire-and-forget would allow the `save(event)` call to run before the broker has acknowledged, reintroducing a window where the JVM can crash after marking a row published but before the broker has persisted the message. If Kafka latency is a concern, switch to an async callback that only marks `published_at` on success — but then you must ensure the callback's DB write completes before application shutdown.

## CDC Alternative: Debezium and the PostgreSQL WAL

Change Data Capture (CDC) eliminates the polling relay entirely. Instead of a background thread querying the outbox table, a Debezium connector tails the PostgreSQL Write-Ahead Log (WAL) and publishes every `INSERT` into `outbox_events` directly to Kafka.

```mermaid
sequenceDiagram
    actor S as PaymentService
    participant DB as PostgreSQL
    participant W as WAL (pg_wal)
    participant D as Debezium Connector
    participant K as Kafka

    S->>DB: BEGIN; INSERT payment; INSERT outbox_event; COMMIT
    DB->>W: WAL record written (LSN 0/3A1F200)
    W-->>D: Stream LSN delta via replication slot
    D->>D: Deserialize RowChangeEvent from WAL
    D->>K: produce("payments.initiated", payload)
    K-->>D: broker ack (offset committed)
    D->>D: Advance replication slot confirmed_flush_lsn
```

Configure Debezium via Kafka Connect REST API:

```json
{
  "name": "outbox-connector",
  "config": {
    "connector.class":
        "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname":  "postgres",
    "database.port":      "5432",
    "database.user":      "debezium",
    "database.password":  "${file:/secrets/debezium.properties:password}",
    "database.dbname":    "payments",
    "table.include.list": "public.outbox_events",
    "plugin.name":        "pgoutput",
    "transforms":         "outbox",
    "transforms.outbox.type":
        "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.type": "event_type",
    "transforms.outbox.table.field.event.key":  "aggregate_id",
    "transforms.outbox.route.topic.replacement":
        "payments.${routedByValue}"
  }
}
```

**Polling relay vs. CDC — decision matrix:**

| Criterion | Polling Relay | CDC / Debezium |
|---|---|---|
| Latency requirement | ~100 ms acceptable | Sub-10 ms required |
| Operational complexity | Low (single JVM component) | High (Kafka Connect cluster, replication slot management) |
| DB load per poll cycle | Partial index scan | Near-zero (WAL stream) |
| Multi-service deployment | Each service runs its own relay | One connector per DB schema |
| WAL disk pressure | None | Replication slot lag can grow if Kafka falls behind |

> [!NOTE]
> Debezium's `EventRouter` SMT maps outbox table rows directly to Kafka topics using the `aggregate_type` and `event_type` columns. The outbox table schema therefore becomes a contract between the service team and the Kafka Connect deployment. Treat schema changes with the same discipline as a public API version increment.

## Failure Modes and Idempotent Consumers

The relay publishes at-least-once. The critical failure scenario: the relay publishes to Kafka successfully, but the JVM crashes before `setPublishedAt` and `relayRepo.save` complete. On restart, the relay sees that row as still unpublished and publishes again. The consumer receives two copies.

Configure the Kafka producer to prevent broker-side duplicates within a single producer session:

```java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, String> producerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG,
            "${kafka.bootstrap-servers}");
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
            StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
            StringSerializer.class);
        return new DefaultKafkaProducerFactory<>(props);
    }
}
```

`enable.idempotence=true` with `acks=all` ensures the broker deduplicates retries within the same producer session using sequence numbers. It does NOT protect against the relay publishing after a JVM restart with a new producer session. That is the consumer's responsibility.

Consumers must be idempotent using the outbox event UUID as a natural idempotency key:

```java
@KafkaListener(topics = "payments.initiated",
               groupId = "ledger-posting-service")
@Transactional
public void handlePaymentInitiated(
        ConsumerRecord<String, String> record,
        @Header("outbox_event_id") String outboxEventId) {

    UUID eventId = UUID.fromString(outboxEventId);

    if (processedEventRepo.existsById(eventId)) {
        log.info("Skipping duplicate event {}", eventId);
        return;
    }

    PaymentInitiatedEvent event =
        mapper.readValue(record.value(), PaymentInitiatedEvent.class);

    ledgerService.postEntry(event);

    // Both writes in the same @Transactional — atomically safe
    processedEventRepo.save(new ProcessedEvent(eventId, Instant.now()));
}
```

Store the `processedEventRepo` write in the same transaction as `ledgerService.postEntry`. If the ledger post fails, the event is not marked processed and will be retried on the next delivery.

## Knowledge Check

**Q1: Why is `SELECT … FOR UPDATE SKIP LOCKED` necessary in the relay query, and what happens if you omit it?**

Without `FOR UPDATE SKIP LOCKED`, two relay instances running concurrently will read the same unpublished rows from the outbox table. Both will attempt to publish the same events to Kafka and then mark them as published. The result is guaranteed duplicate delivery to downstream consumers on every polling cycle where more than one relay instance is active. `FOR UPDATE SKIP LOCKED` acquires a row-level lock atomically with the read: each relay instance gets an exclusive, non-overlapping batch. Any row already locked by another session is silently skipped rather than causing a blocking wait or a deadlock.

**Q2: Debezium's replication slot can cause PostgreSQL disk usage to grow unexpectedly. Under what condition does this happen, and how do you prevent it?**

PostgreSQL retains WAL segments until every replication slot has confirmed it has consumed them by advancing its `confirmed_flush_lsn`. If the Debezium connector falls behind — because Kafka is slow, the connector is paused, or the Kafka Connect worker is down — the slot stops advancing. PostgreSQL cannot delete WAL segments the slot has not yet read, so WAL accumulates on disk. In production clusters with high write throughput this can exhaust disk space in hours. Mitigations: monitor replication slot lag with `pg_replication_slots`, alert on `pg_wal_lsn_diff`, and set `max_slot_wal_keep_size` to allow PostgreSQL to drop the slot under extreme pressure. This triggers a connector restart but prevents a full database outage.

## Practical Challenge

Your team is migrating a monolith to microservices. The monolith currently writes payment records to `payments.payment` and immediately calls a downstream settlement service over HTTP. You need to replace that synchronous HTTP call with an event-driven flow through Kafka, while guaranteeing no events are lost even if the new payment service crashes immediately after committing a payment.

Design and implement the following:

1. Add the `outbox_events` table to the existing PostgreSQL schema using a Flyway migration script (`V13__add_outbox_events.sql`).
2. Modify `PaymentService.initiatePayment` to write an `OutboxEvent` within the same `@Transactional` boundary as the payment insert.
3. Implement an `OutboxRelay` with `@Scheduled(fixedDelay = 500)`, `SELECT … FOR UPDATE SKIP LOCKED LIMIT 50`, and synchronous Kafka ack.
4. Write a `SettlementConsumer` that is idempotent using `outbox_events.id` as the deduplication key, persisting processed IDs to a `processed_outbox_events` table in the settlement service's own database.
5. Write a unit test that verifies: when `KafkaTemplate.send()` throws on the first attempt and succeeds on the second, the event is published exactly once and `published_at` is set.

As an extension, evaluate whether Debezium CDC would be preferable to the polling relay for this workload, given that the payment service processes 2,000 transactions per second during peak hours and the settlement service SLA requires event delivery within 50 milliseconds of payment commit.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why is SELECT ... FOR UPDATE SKIP LOCKED essential in the outbox relay query, and what happens without it when two relay instances run concurrently?",
      "options": [
        "SKIP LOCKED prevents the relay from reading rows that were already published, reducing unnecessary database scans",
        "Without it, two relay instances will read the same unpublished rows, both publish the same events to Kafka, and both mark them published — guaranteeing duplicates on every polling cycle with more than one relay instance",
        "SKIP LOCKED is only needed when the relay uses CDC; polling relays are safe without it",
        "Without it, the relay will block waiting for rows locked by other relays, causing latency but not duplicates"
      ],
      "correct": 1,
      "explanation": "Without FOR UPDATE SKIP LOCKED, two concurrent relay instances perform the same SELECT, read the same unpublished rows, and both publish and mark them. SKIP LOCKED acquires a row-level exclusive lock atomically with the read: each instance gets a non-overlapping batch. Already-locked rows are silently skipped. This makes the relay horizontally scalable without duplicates."
    },
    {
      "text": "Identify the three distinct failure windows in the dual-write pattern where kafkaTemplate.send() is called after paymentRepository.save() inside the same @Transactional method.",
      "options": [
        "Kafka timeout, network partition, and consumer group rebalance",
        "JVM crash after DB commit before Kafka send (event lost); Kafka broker unavailable at send time (event lost unless retried); DB commit success but exception thrown after send causes rollback (ghost event in Kafka)",
        "DB transaction timeout, Kafka producer buffer overflow, and consumer offset reset",
        "Duplicate events on retry, stale consumer offsets, and Kafka partition rebalance"
      ],
      "correct": 1,
      "explanation": "The three windows are: (1) JVM crash after the @Transactional commits the DB write but before kafkaTemplate.send() executes — event is permanently lost; (2) Kafka broker unavailable when send is called — event is lost unless the producer retries and succeeds within timeout; (3) DB commits but an exception thrown after the send triggers rollback — the event was already delivered to Kafka but the payment does not exist in the database (ghost event). No producer retry configuration closes windows 1 or 3."
    },
    {
      "text": "A Debezium PostgreSQL replication slot stops advancing because the Kafka Connect worker is paused for maintenance. What is the operational risk and how do you prevent it from causing a database outage?",
      "options": [
        "The replication slot will expire and all historical events will be lost — prevented by setting a large slot TTL",
        "PostgreSQL retains WAL segments until the slot advances its confirmed_flush_lsn; if the slot lags, WAL accumulates indefinitely and can exhaust disk space — mitigated by monitoring slot lag and setting max_slot_wal_keep_size",
        "Debezium will process all backlogged events instantly on restart, causing a Kafka producer overload",
        "The slot will block all PostgreSQL writes until it is manually dropped"
      ],
      "correct": 1,
      "explanation": "PostgreSQL cannot delete WAL segments until every replication slot has confirmed it has consumed them. A paused Debezium connector stops advancing its confirmed_flush_lsn, causing WAL to accumulate. On a high-write database this can exhaust disk in hours. Set max_slot_wal_keep_size to allow PostgreSQL to forcibly drop the slot under pressure (triggering a connector restart) rather than a full DB outage. Monitor with pg_replication_slots and alert on pg_wal_lsn_diff."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Migrate Synchronous HTTP Settlement to Event-Driven Outbox Architecture",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Write a Flyway migration V13__add_outbox_events.sql that creates the outbox_events table with the partial index on published_at IS NULL. Include a comment explaining why old rows are archived rather than deleted, referencing the regulatory retention requirement. Add a second migration V13b__add_outbox_relay_index.sql that optimises the relay query by adding a covering index on (created_at ASC) INCLUDE (aggregate_type, aggregate_id, event_type) for the WHERE published_at IS NULL filter."},
    {"id": "2", "description": "Modify PaymentService.initiatePayment to write an OutboxEvent within the same @Transactional boundary as the payment insert. The event payload must include the full payment JSON. Write a unit test that mocks the outbox repository and asserts: when paymentRepo.save() throws, outboxRepo.save() is never called; when outboxRepo.save() throws, the payment is rolled back; when both succeed, both are visible in the same transaction."},
    {"id": "3", "description": "Implement OutboxRelay with @Scheduled(fixedDelay = 500), SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50, and synchronous Kafka ack using kafkaTemplate.send(...).get(5, TimeUnit.SECONDS). Handle the case where Kafka.send() throws by leaving published_at NULL and incrementing a Micrometer counter relay.publish.failures tagged with event_type. Write a unit test verifying that when send() throws on attempt 1 and succeeds on attempt 2, the event is published exactly once and published_at is set only after the successful ack."},
    {"id": "4", "description": "Implement SettlementConsumer that is idempotent using outbox_events.id as the deduplication key, persisting processed IDs to processed_outbox_events table in the settlement service's own database. The consumer must commit the processed_outbox_events insert and the settlement action in the same @Transactional boundary. Evaluate whether Debezium CDC is preferable to the polling relay for 2,000 TPS with a 50 ms delivery SLA, documenting your analysis against the polling-vs-CDC decision matrix."}
  ]
}
-->
