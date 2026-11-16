---
id: track-11-lesson-06
title: "Transactional Outbox Pattern with Debezium CDC"
slug: outbox-cdc-debezium
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 6
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [outbox, CDC, Debezium, dual-write, WAL]
prerequisites: [kafka-architecture, kafka-producer, kafka-exactly-once]
---

# Transactional Outbox Pattern with Debezium CDC

> [!NOTE]
> The dual-write problem is one of the most dangerous failure modes in distributed financial systems. Every time you write to a database AND publish to Kafka in the same business operation, you have a window where one succeeds and the other fails — leaving your system in an inconsistent state. The transactional outbox pattern, powered by Debezium Change Data Capture, eliminates this window entirely.

## The Dual-Write Problem

Consider a payment service that:
1. Writes a `Payment` record to PostgreSQL
2. Publishes a `PaymentCreated` event to Kafka

These are two separate network calls. Any failure between them produces inconsistency:

```
Scenario A — DB succeeds, Kafka fails:
  - Payment record exists in DB
  - PaymentCreated event never published
  - Downstream services (settlement, notifications) never notified
  - Money is in limbo

Scenario B — Kafka succeeds, DB fails:
  - PaymentCreated event published
  - Payment record never written to DB
  - Settlement proceeds on a payment that doesn't exist
  - Potential financial loss
```

Using a Kafka transaction does not solve this. Kafka transactions are Kafka-internal; they cannot coordinate with a PostgreSQL transaction.

```java
// BROKEN — dual-write with no atomicity guarantee
@Service
public class PaymentServiceBroken {

    @Autowired private PaymentRepository paymentRepository;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    // THIS IS WRONG — do not do this
    @Transactional // This only wraps the DB transaction
    public void createPayment(CreatePaymentCommand command) {
        Payment payment = Payment.from(command);
        paymentRepository.save(payment);        // DB write
        kafkaTemplate.send("payments.events",   // Kafka write — NOT in the DB transaction
                payment.getId(),
                PaymentCreatedEvent.from(payment).toJson());
        // If Kafka publish fails here, DB is committed but event is lost
    }
}
```

---

## The Transactional Outbox Solution

The outbox pattern solves dual-write by writing the event to the **same database transaction** as the domain entity. A separate process (Debezium CDC) then reliably reads and publishes the event to Kafka.

```
Payment Service
  ┌─────────────────────────────────────────────────────┐
  │  BEGIN TRANSACTION                                   │
  │    INSERT INTO payments (id, amount, status, ...)    │
  │    INSERT INTO outbox_events (aggregate_id, type, …) │
  │  COMMIT                                              │
  └──────────────────────┬──────────────────────────────┘
                         │  (atomic — both succeed or both fail)
                         │
PostgreSQL WAL (Write-Ahead Log)
                         │
                         ▼
                    Debezium CDC
                         │  (reads WAL, publishes to Kafka)
                         ▼
                   Kafka Topic
```

**Key insight:** The event is part of the database transaction. It is impossible for the payment record to be committed without the outbox event also being committed — they are in the same atomic transaction.

---

## Outbox Table Schema Design

```sql
CREATE TABLE outbox_events (
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    aggregate_id    VARCHAR(36) NOT NULL,   -- The domain entity ID (e.g., payment_id)
    aggregate_type  VARCHAR(100) NOT NULL,  -- The aggregate type (e.g., "Payment")
    event_type      VARCHAR(100) NOT NULL,  -- Fully qualified event type (e.g., "PaymentCreated")
    payload         JSONB       NOT NULL,   -- The event payload
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed       BOOLEAN     NOT NULL DEFAULT FALSE,  -- For polling-based cleanup
    PRIMARY KEY (id)
);

-- Index for Debezium (reads by id ordering) and cleanup jobs
CREATE INDEX idx_outbox_created_at ON outbox_events (created_at);
CREATE INDEX idx_outbox_aggregate   ON outbox_events (aggregate_id, event_type);

-- Partitioning by created_at for large-volume tables (archival)
-- Debezium reads the WAL, not this table directly — this index is for cleanup only
```

**Field design rationale:**

| Field | Purpose | Example |
|-------|---------|---------|
| `aggregate_id` | Kafka partition key | `payment-uuid-1234` |
| `aggregate_type` | Debezium router topic selection | `Payment` |
| `event_type` | Schema Registry subject selection | `PaymentCreated` |
| `payload` | The event data | `{"amount": 1000, "currency": "GBP"}` |

---

## Writing to the Outbox in the Same Transaction

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.beans.factory.annotation.Autowired;
import java.util.UUID;

@Service
public class PaymentService {

    @Autowired private PaymentRepository paymentRepository;
    @Autowired private OutboxEventRepository outboxEventRepository;

    @Transactional  // Single DB transaction wraps BOTH operations
    public Payment createPayment(CreatePaymentCommand command) {
        // Step 1: Create and persist the domain entity
        Payment payment = Payment.builder()
                .id(UUID.randomUUID().toString())
                .accountId(command.getAccountId())
                .amount(command.getAmount())
                .currency(command.getCurrency())
                .status(PaymentStatus.PENDING)
                .createdAt(Instant.now())
                .build();

        payment = paymentRepository.save(payment);

        // Step 2: Create the outbox event in the SAME transaction
        OutboxEvent outboxEvent = OutboxEvent.builder()
                .id(UUID.randomUUID())
                .aggregateId(payment.getId())
                .aggregateType("Payment")
                .eventType("PaymentCreated")
                .payload(buildPayload(payment))
                .createdAt(Instant.now())
                .processed(false)
                .build();

        outboxEventRepository.save(outboxEvent);

        // Both writes are in the same DB transaction
        // If either fails, neither is committed — atomicity guaranteed
        return payment;
    }

    @Transactional
    public Payment approvePayment(String paymentId) {
        Payment payment = paymentRepository.findById(paymentId)
                .orElseThrow(() -> new PaymentNotFoundException(paymentId));

        payment.setStatus(PaymentStatus.APPROVED);
        payment = paymentRepository.save(payment);

        OutboxEvent outboxEvent = OutboxEvent.builder()
                .id(UUID.randomUUID())
                .aggregateId(payment.getId())
                .aggregateType("Payment")
                .eventType("PaymentApproved")
                .payload(buildPayload(payment))
                .createdAt(Instant.now())
                .processed(false)
                .build();

        outboxEventRepository.save(outboxEvent);

        return payment;
    }

    private String buildPayload(Payment payment) {
        // Using Jackson ObjectMapper in practice
        return String.format(
            "{\"paymentId\":\"%s\",\"accountId\":\"%s\",\"amount\":%s," +
            "\"currency\":\"%s\",\"status\":\"%s\",\"createdAt\":\"%s\"}",
            payment.getId(), payment.getAccountId(),
            payment.getAmount(), payment.getCurrency(),
            payment.getStatus(), payment.getCreatedAt()
        );
    }
}
```

```java
import javax.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "outbox_events")
public class OutboxEvent {

    @Id
    private UUID id;

    @Column(name = "aggregate_id", nullable = false)
    private String aggregateId;

    @Column(name = "aggregate_type", nullable = false)
    private String aggregateType;

    @Column(name = "event_type", nullable = false)
    private String eventType;

    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private boolean processed;

    // Getters, setters, builder...
}
```

---

## Debezium Reading the PostgreSQL WAL

Debezium captures changes from PostgreSQL's **Write-Ahead Log (WAL)**. The WAL is PostgreSQL's durability mechanism — every INSERT, UPDATE, DELETE is written to the WAL before being applied. Debezium tails this log using the **logical decoding** plugin (pgoutput, included in PostgreSQL 10+).

### PostgreSQL Configuration for Debezium

```sql
-- postgresql.conf
wal_level = logical          -- Enable logical replication
max_replication_slots = 4    -- One per Debezium connector
max_wal_senders = 4          -- One per replication slot

-- Create replication slot (Debezium does this automatically, but good to know)
SELECT pg_create_logical_replication_slot('debezium_slot', 'pgoutput');

-- Grant Debezium user replication permissions
CREATE USER debezium_user WITH REPLICATION LOGIN PASSWORD 'secret';
GRANT SELECT ON outbox_events TO debezium_user;
GRANT SELECT ON payments TO debezium_user;
```

### Debezium PostgreSQL Connector Configuration

```json
{
    "name": "payment-outbox-connector",
    "config": {
        "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
        "database.hostname": "postgres",
        "database.port": "5432",
        "database.user": "debezium_user",
        "database.password": "secret",
        "database.dbname": "payments_db",
        "database.server.name": "payments",
        "table.include.list": "public.outbox_events",
        "plugin.name": "pgoutput",
        "slot.name": "debezium_outbox_slot",

        "transforms": "outbox",
        "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
        "transforms.outbox.table.field.event.id": "id",
        "transforms.outbox.table.field.event.key": "aggregate_id",
        "transforms.outbox.table.field.event.type": "event_type",
        "transforms.outbox.table.field.event.payload": "payload",
        "transforms.outbox.table.field.event.timestamp": "created_at",
        "transforms.outbox.route.by.field": "aggregate_type",
        "transforms.outbox.route.topic.replacement": "payments.${routedByValue}.events",

        "key.converter": "org.apache.kafka.connect.storage.StringConverter",
        "value.converter": "org.apache.kafka.connect.storage.StringConverter"
    }
}
```

**What the Outbox Event Router SMT does:**
1. Reads INSERT events on `outbox_events` from the WAL
2. Extracts the `aggregate_id` as the Kafka message key
3. Routes to topic based on `aggregate_type` (e.g., `Payment` → `payments.Payment.events`)
4. Extracts `payload` as the Kafka message value
5. Optionally marks the event as processed (for cleanup)

---

## Event Envelope Structure

Debezium publishes events with a consistent envelope structure. Understanding this structure is important for consumer design:

```json
{
    "schema": {
        "type": "struct",
        "fields": [
            {"field": "id", "type": "string"},
            {"field": "eventType", "type": "string"},
            {"field": "aggregateId", "type": "string"},
            {"field": "aggregateType", "type": "string"},
            {"field": "payload", "type": "string"},
            {"field": "timestamp", "type": "int64"}
        ]
    },
    "payload": {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "eventType": "PaymentCreated",
        "aggregateId": "payment-abc-123",
        "aggregateType": "Payment",
        "payload": "{\"paymentId\":\"payment-abc-123\",\"amount\":1000,\"currency\":\"GBP\"}",
        "timestamp": 1699200000000
    }
}
```

After the Outbox Event Router SMT transforms the message, consumers receive only the inner `payload` field as the message value, with `aggregate_id` as the key — a clean domain event.

---

## Idempotent Consumer Design

Since Debezium provides **at-least-once** delivery (it may re-deliver events on restart), consumers must be idempotent. Use the event `id` as an idempotency key:

```java
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PaymentCreatedEventConsumer {

    @Autowired private SettlementService settlementService;
    @Autowired private ProcessedEventRepository processedEventRepository;

    @KafkaListener(
        topics = "payments.Payment.events",
        groupId = "settlement-service",
        containerFactory = "readCommittedListenerFactory"
    )
    @Transactional
    public void handlePaymentCreated(ConsumerRecord<String, String> record) {
        PaymentCreatedEvent event = PaymentCreatedEvent.fromJson(record.value());

        // Idempotency check — have we already processed this event?
        if (processedEventRepository.existsByEventId(event.getId())) {
            log.info("Event {} already processed — skipping (idempotent)", event.getId());
            return;
        }

        try {
            settlementService.initiateSettlement(event);

            // Mark as processed — in the SAME transaction as the business logic
            processedEventRepository.save(new ProcessedEvent(
                    event.getId(),
                    "PaymentCreated",
                    Instant.now()
            ));

        } catch (Exception e) {
            log.error("Failed to process PaymentCreated event {}", event.getId(), e);
            throw e; // Re-throw to trigger retry/DLQ
        }
    }
}
```

```java
@Entity
@Table(name = "processed_events",
       indexes = @Index(columnList = "event_id", unique = true))
public class ProcessedEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", unique = true, nullable = false)
    private String eventId;

    @Column(name = "event_type", nullable = false)
    private String eventType;

    @Column(name = "processed_at", nullable = false)
    private Instant processedAt;

    public ProcessedEvent(String eventId, String eventType, Instant processedAt) {
        this.eventId = eventId;
        this.eventType = eventType;
        this.processedAt = processedAt;
    }
}
```

---

## Outbox Table Cleanup

The outbox table grows indefinitely without cleanup. Options:

### Option 1: Debezium Tombstone (Mark and Delete)

```json
{
    "transforms.outbox.table.field.event.timestamp": "created_at",
    "transforms.outbox.delete.handling.mode": "rewrite",
    "transforms.outbox.route.tombstone.on.empty.payload": "false"
}
```

After Debezium publishes an outbox event to Kafka, it can optionally delete the row (via a separate cleanup thread or by marking `processed=true`).

### Option 2: Scheduled Cleanup Job

```java
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

@Component
public class OutboxCleanupJob {

    @Autowired private OutboxEventRepository outboxEventRepository;

    // Run every 5 minutes — delete processed events older than 24 hours
    @Scheduled(fixedDelay = 300_000)
    @Transactional
    public void cleanupProcessedEvents() {
        Instant cutoff = Instant.now().minus(24, ChronoUnit.HOURS);
        int deleted = outboxEventRepository.deleteByProcessedTrueAndCreatedAtBefore(cutoff);
        if (deleted > 0) {
            log.info("Outbox cleanup: deleted {} processed events older than {}", deleted, cutoff);
        }
    }
}
```

```java
public interface OutboxEventRepository extends JpaRepository<OutboxEvent, UUID> {

    @Modifying
    @Query("DELETE FROM OutboxEvent o WHERE o.processed = true AND o.createdAt < :cutoff")
    int deleteByProcessedTrueAndCreatedAtBefore(@Param("cutoff") Instant cutoff);
}
```

---

## Polling-Based Alternative (No Debezium)

If running Debezium is not feasible (e.g., managed PostgreSQL without WAL access), use a polling-based outbox reader as a fallback:

```java
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.kafka.core.KafkaTemplate;
import java.util.List;

@Component
public class OutboxPollingPublisher {

    @Autowired private OutboxEventRepository outboxEventRepository;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    // Poll every 100ms — higher latency than CDC, but no Debezium dependency
    @Scheduled(fixedDelay = 100)
    @Transactional
    public void publishPendingEvents() {
        // Lock rows with SELECT FOR UPDATE SKIP LOCKED for multi-instance safety
        List<OutboxEvent> pending = outboxEventRepository
                .findTop100ByProcessedFalseOrderByCreatedAtAsc();

        for (OutboxEvent event : pending) {
            try {
                String topic = resolveTopicName(event);
                kafkaTemplate.send(topic, event.getAggregateId(), event.getPayload());

                event.setProcessed(true);
                outboxEventRepository.save(event);

            } catch (Exception e) {
                log.error("Failed to publish outbox event {}", event.getId(), e);
                // Event remains unprocessed — will be retried next poll
            }
        }
    }

    private String resolveTopicName(OutboxEvent event) {
        return "payments." + event.getAggregateType().toLowerCase() + ".events";
    }
}
```

```java
public interface OutboxEventRepository extends JpaRepository<OutboxEvent, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "javax.persistence.lock.timeout", value = "0"))
    @Query("SELECT o FROM OutboxEvent o WHERE o.processed = false " +
           "ORDER BY o.createdAt ASC LIMIT 100")
    List<OutboxEvent> findTop100ByProcessedFalseOrderByCreatedAtAsc();
}
```

**Polling vs CDC trade-offs:**

| Concern | CDC (Debezium) | Polling |
|---------|---------------|---------|
| Latency | Near-real-time (<100ms) | 100ms-1s |
| DB load | Minimal (reads WAL) | Query-based load |
| Infrastructure | Requires Debezium/Kafka Connect | Spring Scheduler only |
| Ordering | Guaranteed (WAL order) | Approximate (created_at) |
| Multi-instance | Automatic (Debezium handles) | Requires locking |

---

## End-to-End Architecture

```
Payment Service (Spring Boot)
  │
  ├── payments table (domain state)
  └── outbox_events table (event log)
           │
           │ WAL stream (logical replication)
           ▼
     Debezium Connector
     (Kafka Connect worker)
           │
           │ Outbox Event Router SMT
           ▼
     Kafka Topic: payments.Payment.events
           │
     ┌─────┴──────────────────────────────┐
     ▼                                    ▼
Settlement Service                 Notification Service
(idempotent consumer)              (idempotent consumer)
```

This architecture provides:
- **Atomicity** — payment + event written in one DB transaction
- **Reliability** — Debezium retries on failure, never loses events
- **Decoupling** — services consume independently
- **Auditability** — WAL is an append-only record of all changes

---

## Key Takeaways

- The dual-write problem makes it impossible to atomically write to a database and publish to Kafka without a coordination mechanism.
- The outbox pattern solves this by writing the event to the same database transaction as the domain entity.
- Debezium reads the PostgreSQL WAL and publishes outbox events to Kafka with near-real-time latency.
- The Outbox Event Router SMT transforms raw CDC events into clean domain events with routing by aggregate type.
- Consumers must be idempotent — Debezium provides at-least-once delivery.
- Polling-based outbox is a viable fallback when CDC is not available, with higher latency and additional DB load.
- Outbox table cleanup is essential for production — either mark-and-sweep or scheduled deletion.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the dual-write problem in distributed financial systems?",
      "options": [
        "Writing the same data to two database replicas simultaneously",
        "The impossibility of atomically writing to a database and publishing to Kafka in the same operation",
        "Using two Kafka producers to publish the same message for redundancy",
        "Writing both a command and an event in the same transaction"
      ],
      "correct": 1,
      "explanation": "The dual-write problem arises because a database write and a Kafka publish are two separate network calls with no shared transaction boundary. Either can succeed while the other fails, leaving the system in an inconsistent state."
    },
    {
      "text": "Why does the transactional outbox pattern guarantee atomicity between the domain entity and the event?",
      "options": [
        "Debezium uses two-phase commit across PostgreSQL and Kafka",
        "Both the domain entity and the outbox event are written in the same database transaction",
        "Kafka transactions coordinate with the database transaction via XA protocol",
        "The outbox event is derived from the domain entity after the database commits"
      ],
      "correct": 1,
      "explanation": "The outbox pattern writes both the domain entity (e.g., Payment) and the outbox event record in the same database transaction. It is impossible for one to be committed without the other — atomicity is guaranteed by the database, not by distributed coordination."
    },
    {
      "text": "What is the main trade-off between CDC (Debezium) and polling-based outbox publishing?",
      "options": [
        "CDC requires schema changes to the outbox table; polling does not",
        "CDC provides near-real-time delivery with minimal DB load; polling adds query-based load and higher latency",
        "Polling guarantees exactly-once delivery; CDC only provides at-least-once",
        "CDC works with any managed database; polling requires WAL access"
      ],
      "correct": 1,
      "explanation": "Debezium CDC reads the PostgreSQL WAL (a low-overhead operation) and delivers events with sub-100ms latency. Polling issues SELECT queries on a schedule, adding database load and introducing 100ms-1s latency. CDC requires WAL access (wal_level=logical) which may not be available on all managed databases."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement the Transactional Outbox Pattern with Debezium",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Create the outbox_events table in PostgreSQL with the required fields (id, aggregate_id, aggregate_type, event_type, payload, created_at, processed) and configure PostgreSQL with wal_level=logical for CDC access."},
    {"id": "2", "description": "Implement a PaymentService that writes both the Payment domain entity and an OutboxEvent record in a single @Transactional method, ensuring atomicity between the domain write and event publication."},
    {"id": "3", "description": "Configure a Debezium PostgreSQL connector with the EventRouter SMT to monitor the outbox_events table, route messages to topic 'payments.Payment.events' using the aggregate_type field, and use aggregate_id as the Kafka message key."},
    {"id": "4", "description": "Build an idempotent consumer that processes PaymentCreated events from the Kafka topic, checks a processed_events table before applying business logic, and marks events as processed within the same database transaction as the business operation."}
  ]
}
-->
