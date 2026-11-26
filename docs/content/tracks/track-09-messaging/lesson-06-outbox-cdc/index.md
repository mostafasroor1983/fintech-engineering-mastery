---
id: track-09-lesson-06
title: "Transactional Outbox Pattern with Debezium CDC"
slug: outbox-cdc-debezium
track: track-09
trackName: "Messaging & Event Streaming"
sequence: 6
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [outbox, transactional-outbox, Debezium, CDC, WAL, Kafka-Connect]
prerequisites: [track-09-lesson-05]
---

# Transactional Outbox Pattern with Debezium CDC

> [!NOTE]
> Writing to a database and publishing to Kafka in the same operation is impossible to do atomically without special infrastructure. If the database write succeeds but the Kafka publish fails, downstream services never learn about the event. If Kafka succeeds but the database write fails, the event describes something that never happened. The Transactional Outbox Pattern solves this by making Kafka publication a consequence of the database write — not a parallel operation.

## The Dual-Write Problem

A naive implementation publishes to Kafka inside the same service method as the database write:

```java
// BROKEN: Dual-write — not atomic
@Transactional
public Payment createPayment(CreatePaymentCommand cmd) {
    Payment payment = new Payment(cmd);
    paymentRepository.save(payment);    // Step 1: DB write
    kafkaTemplate.send("payments.created", payment.toEvent()); // Step 2: Kafka publish
    return payment;
}
```

Failure modes:

```
Scenario A: DB write succeeds, Kafka publish fails
  → Payment exists in DB but no event published
  → Downstream services (settlement, notifications) never see it
  → System inconsistency — silent data loss

Scenario B: DB write fails (exception thrown after Kafka send is called)
  → Spring rolls back the DB transaction
  → But Kafka has already received the message (Kafka ignores DB rollback)
  → Event published for a payment that does not exist
  → Phantom transaction in downstream systems
```

---

## The Transactional Outbox Solution

Write to the outbox table **inside the same database transaction** as the business entity. The outbox record is the commitment that the event will be published — the publisher reads from the outbox and forwards to Kafka.

```
Application
  │── BEGIN TRANSACTION
  │   │── INSERT INTO payments (...)       ← business entity
  │   └── INSERT INTO outbox_events (...)  ← event to publish
  └── COMMIT

CDC (Debezium)
  │── Reads WAL (Write-Ahead Log) from PostgreSQL
  │── Sees new outbox_events row
  └── Publishes to Kafka automatically
```

The key insight: **the outbox row and the payment row are committed atomically by the database**. If the transaction fails, neither is committed. If it succeeds, both exist and Debezium will eventually publish the event.

---

## Outbox Table Schema

```sql
CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  VARCHAR(100) NOT NULL,   -- e.g., 'Payment'
    aggregate_id    VARCHAR(255) NOT NULL,   -- e.g., payment UUID
    event_type      VARCHAR(100) NOT NULL,   -- e.g., 'PaymentCreated'
    payload         JSONB NOT NULL,          -- event payload
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed       BOOLEAN NOT NULL DEFAULT FALSE  -- polling relay only (CDC never sets it)
);

-- Index for CDC monitoring and polling relay
CREATE INDEX idx_outbox_created_at ON outbox_events (created_at);
CREATE INDEX idx_outbox_processed   ON outbox_events (processed, created_at)
    WHERE processed = FALSE;
```

---

## Application Layer: Writing to the Outbox

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.UUID;

@Service
@Slf4j
public class PaymentService {

    @Autowired private PaymentRepository paymentRepository;
    @Autowired private OutboxEventRepository outboxEventRepository;
    @Autowired private ObjectMapper objectMapper;

    /**
     * Creates a payment AND an outbox event in a single atomic transaction.
     * Kafka publication happens asynchronously via Debezium CDC — not here.
     */
    @Transactional
    public Payment createPayment(CreatePaymentCommand cmd) {
        // Step 1: Validate and create the business entity
        Payment payment = Payment.builder()
                .id(UUID.randomUUID().toString())
                .sourceAccountId(cmd.getSourceAccountId())
                .destinationAccountId(cmd.getDestinationAccountId())
                .amount(cmd.getAmount())
                .currency(cmd.getCurrency())
                .status(PaymentStatus.PENDING)
                .createdAt(Instant.now())
                .build();

        paymentRepository.save(payment);

        // Step 2: Write the outbox event in the SAME transaction
        PaymentCreatedEvent event = PaymentCreatedEvent.builder()
                .paymentId(payment.getId())
                .sourceAccountId(payment.getSourceAccountId())
                .destinationAccountId(payment.getDestinationAccountId())
                .amount(payment.getAmount())
                .currency(payment.getCurrency())
                .occurredAt(payment.getCreatedAt())
                .build();

        OutboxEvent outboxEvent = OutboxEvent.builder()
                .id(UUID.randomUUID().toString())
                .aggregateType("Payment")
                .aggregateId(payment.getId())
                .eventType("PaymentCreated")
                .payload(objectMapper.valueToTree(event))
                .createdAt(Instant.now())
                .processed(false)
                .build();

        outboxEventRepository.save(outboxEvent);

        log.info("Payment {} created with outbox event {}", payment.getId(), outboxEvent.getId());
        return payment;
    }

    @Transactional
    public Payment approvePayment(String paymentId) {
        Payment payment = paymentRepository.findById(paymentId)
                .orElseThrow(() -> new PaymentNotFoundException(paymentId));

        payment.setStatus(PaymentStatus.APPROVED);
        payment.setApprovedAt(Instant.now());
        paymentRepository.save(payment);

        OutboxEvent outboxEvent = OutboxEvent.builder()
                .id(UUID.randomUUID().toString())
                .aggregateType("Payment")
                .aggregateId(paymentId)
                .eventType("PaymentApproved")
                .payload(objectMapper.valueToTree(PaymentApprovedEvent.from(payment)))
                .createdAt(Instant.now())
                .processed(false)
                .build();

        outboxEventRepository.save(outboxEvent);
        return payment;
    }
}
```

---

## Polling Relay vs CDC

Two approaches forward outbox events to Kafka:

```
Polling Relay:
  Scheduled job: SELECT * FROM outbox_events WHERE processed = FALSE ORDER BY created_at
  Publishes each row to Kafka, then marks processed = TRUE
  
  Pros: Simple, works with any database, no special DB privileges
  Cons: Latency (poll interval: 100ms–1s), extra DB load from SELECT queries,
        at-least-once (need idempotent consumer); several relay instances
        need SELECT ... FOR UPDATE SKIP LOCKED; and never page by
        "created_at > last seen" -- transactions commit out of order, so
        a row with an older timestamp can appear later and be skipped

CDC (Debezium):
  Reads PostgreSQL WAL (Write-Ahead Log) — not SELECT queries
  Triggers on each INSERT/UPDATE/DELETE to the outbox table
  
  Pros: Typically sub-second latency, no polling queries, every committed
        insert is captured in commit order
  Cons: Requires logical replication (wal_level=logical, privileges), a
        replication slot that retains WAL while the connector is down,
        connector operations; still at-least-once
```

**Recommendation for production financial systems:** prefer CDC when you can operate it (and monitor the replication slot). A polling relay adds latency and query load under high throughput, while CDC reads the WAL that PostgreSQL writes anyway. A well-built polling relay is still a perfectly valid choice for moderate volumes or where logical replication is not available.

---

## Debezium PostgreSQL Connector Configuration

```json
{
  "name": "payment-outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "debezium",
    "database.password": "${file:/secrets/debezium-creds:password}",
    "database.dbname": "payments",
    "topic.prefix": "payments-db",

    "plugin.name": "pgoutput",
    "publication.name": "dbz_outbox_publication",
    "publication.autocreate.mode": "disabled",

    "table.include.list": "public.outbox_events",
    "tombstones.on.delete": "false",

    "transforms": "outbox",
    "transforms.outbox.type":
        "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.id": "id",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.table.field.event.type": "event_type",
    "transforms.outbox.route.by.field": "aggregate_type",
    "transforms.outbox.route.topic.replacement": "payments.${routedByValue}.events",
    "transforms.outbox.table.expand.json.payload": "true",

    "transforms.outbox.table.fields.additional.placement":
        "aggregate_type:header:aggregate_type,event_type:header:event_type",

    "key.converter": "org.apache.kafka.connect.storage.StringConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false",

    "snapshot.mode": "no_data",
    "max.batch.size": "500",
    "max.queue.size": "8192",
    "poll.interval.ms": "100",

    "heartbeat.interval.ms": "30000",
    "slot.name": "debezium_outbox_slot"
  }
}
```

Notes: `topic.prefix` replaced `database.server.name` in Debezium 2.x. `snapshot.mode=no_data` (older name `never`) skips the initial snapshot — so create the replication slot (start the connector) **before** the application writes its first outbox rows, or unpublished rows written earlier are never sent. The EventRouter puts the outbox row id into a Kafka header named `id` — consumers de-duplicate on it.

**PostgreSQL prerequisites:**

```sql
-- Set wal_level for logical replication (requires restart)
-- In postgresql.conf:
-- wal_level = logical
-- max_replication_slots = 10
-- max_wal_senders = 10

-- Create a dedicated replication user
CREATE ROLE debezium REPLICATION LOGIN PASSWORD 'from-your-secret-store';
GRANT SELECT ON TABLE outbox_events TO debezium;

-- Create the publication as the table owner (Debezium would need owner or
-- superuser rights to create it itself -- hence autocreate.mode=disabled)
CREATE PUBLICATION dbz_outbox_publication FOR TABLE outbox_events;
```

---

## Outbox Event Router SMT

The Debezium `EventRouter` Single Message Transform (SMT) routes outbox rows to Kafka topics based on the `aggregate_type` column:

```
outbox_events row:
  aggregate_type = "Payment"
  aggregate_id   = "pay-123"
  event_type     = "PaymentCreated"
  payload        = { "paymentId": "pay-123", ... }

EventRouter SMT transforms this to:
  Kafka topic: payments.Payment.events
  Kafka key:   "pay-123"            ← from aggregate_id
  Kafka value: { "paymentId": "pay-123", ... }  ← from payload
  Headers:     id=<outbox row id>, aggregate_type=Payment, event_type=PaymentCreated
```

---

## At-Least-Once + Idempotent Consumer = Effective Exactly-Once

Debezium guarantees **at-least-once delivery** — in failure scenarios (connector restart, broker failover), events may be re-delivered. The idempotent consumer pattern absorbs duplicates:

```java
@Component
@Slf4j
public class PaymentEventConsumer {

    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private SettlementService settlementService;

    @KafkaListener(topics = "payments.Payment.events", groupId = "settlement-consumer")
    @Transactional
    public void handlePaymentEvent(
            ConsumerRecord<String, String> record,
            @Header("event_type") String eventType,
            @Header(KafkaHeaders.RECEIVED_KEY) String aggregateId) {   // RECEIVED_MESSAGE_KEY before Spring Kafka 3.0

        String eventId = extractEventId(record);

        // Idempotency: claim the event id first (primary key) -- in the same
        // DB transaction as the business logic. A separate "exists?" check
        // would race with a concurrent duplicate delivery.
        int claimed = jdbcTemplate.update("""
            INSERT INTO processed_events (event_id, aggregate_id, processed_at)
            VALUES (?, ?, now())
            ON CONFLICT (event_id) DO NOTHING
            """, eventId, aggregateId);
        if (claimed == 0) {
            log.debug("Duplicate event {} — skipping", eventId);
            return;
        }

        switch (eventType) {
            case "PaymentCreated" -> {
                PaymentCreatedEvent event = parsePaymentCreated(record.value());
                settlementService.scheduleSettlement(event);
            }
            case "PaymentApproved" -> {
                PaymentApprovedEvent event = parsePaymentApproved(record.value());
                settlementService.executeSettlement(event);
            }
            default -> log.warn("Unknown event type: {}", eventType);
        }
    }

    private String extractEventId(ConsumerRecord<String, String> record) {
        // The EventRouter puts the outbox row id into the "id" header.
        // No fallback such as key+offset: a re-published duplicate has a
        // DIFFERENT offset, so that fallback would not detect it.
        Header idHeader = record.headers().lastHeader("id");
        if (idHeader == null) {
            throw new IllegalStateException("Outbox event without id header");
        }
        return new String(idHeader.value(), StandardCharsets.UTF_8);
    }
}
```

---

## Outbox Cleanup Strategy

Without cleanup, the outbox table grows indefinitely. Two strategies:

**Strategy 1: Delete in the same transaction (CDC only)**
```sql
-- Debezium reads the INSERT from the WAL, so the row may be deleted right
-- away, in the same transaction: the table stays tiny, the event is still
-- published. (The EventRouter ignores the DELETE; tombstones.on.delete=false
-- prevents tombstone records.)
BEGIN;
INSERT INTO payments (...) VALUES (...);
INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
VALUES ('6f1c...', 'Payment', 'pay-123', 'PaymentCreated', '{...}');
DELETE FROM outbox_events WHERE id = '6f1c...';
COMMIT;
-- (For a polling relay: delete rows with processed = TRUE in a job instead)
```

**Strategy 2: Time-based cleanup (simpler, most common)**
```java
@Scheduled(cron = "0 0 2 * * *", zone = "UTC")  // sec min hour ... -> 02:00 daily
@Transactional
public void cleanupOutbox() {
    Instant cutoff = Instant.now().minus(Duration.ofDays(7));
    int deleted = outboxEventRepository.deleteByCreatedAtBefore(cutoff);
    log.info("Outbox cleanup: deleted {} rows older than 7 days", deleted);
}
```

---

## Monitoring Outbox Lag

For a **polling relay**, the age of the oldest unprocessed row is the key metric. (With **CDC** the `processed` flag is never set, so this gauge would grow forever — monitor the connector instead: Debezium's `MilliSecondsBehindSource` streaming metric and the replication slot's lag in `pg_replication_slots`, see Track 08 Lesson 11.)

```java
@Component
public class OutboxLagMonitor {   // polling relay

    @Autowired private OutboxEventRepository outboxRepository;
    @Autowired private MeterRegistry meterRegistry;

    @PostConstruct
    public void registerMetrics() {
        // Gauge: age of oldest unprocessed outbox event.
        // Each scrape runs a query -- keep it cheap (the partial index on
        // processed = FALSE serves it)
        Gauge.builder("outbox.lag.seconds",
                outboxRepository,
                repo -> {
                    Instant oldest = repo.findOldestUnprocessedCreatedAt();
                    if (oldest == null) return 0.0;
                    return Duration.between(oldest, Instant.now()).getSeconds();
                })
                .description("Age in seconds of the oldest unprocessed outbox event")
                .register(meterRegistry);

        // Gauge: count of unprocessed outbox events
        Gauge.builder("outbox.unprocessed.count",
                outboxRepository,
                repo -> repo.countByProcessedFalse())
                .register(meterRegistry);
    }
}
```

**Alert rules:**
```yaml
groups:
  - name: outbox-lag
    rules:
      - alert: OutboxLagHigh
        expr: outbox_lag_seconds > 30
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Outbox lag {{ $value }}s — Debezium connector may be stalled"

      - alert: OutboxLagCritical
        expr: outbox_lag_seconds > 300
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Outbox lag {{ $value }}s — payment events are not being published"
```

---

## Production Pitfalls

### Pitfall 1: Forgetting `wal_level=logical` on Managed Databases

**Problem:** Managed PostgreSQL services such as Amazon RDS and Google Cloud SQL run with `wal_level=replica` by default. Debezium needs `wal_level=logical` for logical replication slots; without it the connector fails at startup and no events flow.

**Fix:** Confirm `SHOW wal_level;` returns `logical` before deploying. On Amazon RDS / Aurora set `rds.logical_replication=1` in the parameter group (restart required); on Cloud SQL set the `cloudsql.logical_decoding` flag. Verify with the Kafka Connect status API and `pg_replication_slots` that the slot is active.

### Pitfall 2: Replication Slot Lag Causing WAL Disk Exhaustion

**Problem:** PostgreSQL retains WAL files until the replication slot consumer (Debezium) confirms it has read them. If the Debezium connector goes offline for hours or days (e.g., Kafka Connect cluster restart), the replication slot does not advance. PostgreSQL accumulates WAL indefinitely, potentially filling the disk and crashing the database.

**Fix:** Set `max_slot_wal_keep_size` (PostgreSQL 13+) as a safety cap so a stuck slot is invalidated instead of filling the disk. Monitor the retained WAL — `pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)` from `pg_replication_slots` — and alert if `confirmed_flush_lsn` does not advance. Dropping the slot (`SELECT pg_drop_replication_slot('debezium_outbox_slot');`) frees the WAL but loses every outbox row written while the connector was down — they must then be re-published (e.g. a one-off snapshot of `outbox_events`), so treat it as a deliberate recovery step.

### Pitfall 3: Writing Large Payloads to the Outbox Table

**Problem:** Storing large binary blobs or deeply nested JSON in the `payload` column causes WAL bloat (every INSERT is written to WAL). It also makes CDC message sizes exceed the Kafka `max.message.bytes` limit (default 1MB), causing connector failures.

**Fix:** Store only the event metadata and a reference (ID, type, version) in the outbox payload. Consumers retrieve full data via the query side. If full payload is required, increase Kafka and connector `max.message.bytes` to a consistent value and add a Micrometer metric for average payload size.

---

## Production Checklist

- [ ] `wal_level=logical` confirmed on the PostgreSQL instance
- [ ] Outbox table has a primary key UUID for event deduplication
- [ ] Business entity and outbox event written in the same `@Transactional` method
- [ ] Debezium connector deployed via Kafka Connect cluster (not embedded)
- [ ] Outbox Event Router SMT configured to route by `aggregate_type`
- [ ] Kafka topic for outbox events has `cleanup.policy=delete` and appropriate retention
- [ ] Consumer uses idempotency check on `event_id` before processing
- [ ] Outbox lag metric alerts configured: warning at 30s, critical at 300s
- [ ] Replication slot lag monitored — alert if WAL growth exceeds 10GB
- [ ] Outbox cleanup job runs daily to prevent table growth
- [ ] Payload size validated — alert if any outbox row payload exceeds 512KB
- [ ] Debezium connector restart tested to confirm no event loss or duplication

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why does writing to both a database and Kafka inside the same @Transactional method NOT guarantee atomicity?",
      "options": [
        "Spring @Transactional only wraps JPA operations, not KafkaTemplate calls",
        "Kafka and the database use separate transaction coordinators — a database rollback does not roll back a Kafka send, and a Kafka failure does not roll back the database",
        "The @Transactional annotation applies only to read operations, not writes",
        "KafkaTemplate.send() is always asynchronous, so it completes after the transaction commits"
      ],
      "correct": 1,
      "explanation": "Database transactions and Kafka produce operations are managed by different systems. Even with Spring's transaction synchronisation (committing one after the other, best-effort), there is a window between the two commits: a crash there leaves one committed and the other not — an event for a payment that does not exist, or a payment whose event is never sent. The outbox pattern removes this window by making Kafka publication a consequence of the database commit, not a parallel operation."
    },
    {
      "text": "What is the role of the Debezium Outbox Event Router SMT in the outbox pattern?",
      "options": [
        "It prevents duplicate messages from being published to Kafka",
        "It transforms outbox table rows into routed Kafka messages — extracting the key from aggregate_id, the topic from aggregate_type, and the value from the payload column",
        "It creates the outbox table schema automatically on first connector start",
        "It compresses the outbox payload before publishing to Kafka"
      ],
      "correct": 1,
      "explanation": "The EventRouter SMT reads each CDC event (a row from outbox_events) and transforms it into a properly structured Kafka message: the aggregate_id becomes the message key (preserving partition affinity), the aggregate_type determines the target topic, and the payload column becomes the message value. This avoids publishing the full Debezium envelope (before/after structure) to consumers."
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
      "explanation": "Debezium CDC reads the PostgreSQL WAL (a low-overhead operation already written by PostgreSQL) and delivers events with sub-100ms latency. Polling issues SELECT queries on a schedule, adding database query load and introducing 100ms-1s latency depending on poll interval. Both provide at-least-once delivery — idempotent consumers are required in both cases."
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
    {
      "id": "1",
      "description": "Create the outbox_events table in PostgreSQL with fields (id UUID, aggregate_type, aggregate_id, event_type, payload JSONB, created_at, processed). Configure PostgreSQL with wal_level=logical. Create a Debezium replication user with REPLICATION LOGIN privilege and SELECT on outbox_events."
    },
    {
      "id": "2",
      "description": "Implement a PaymentService with createPayment() and approvePayment() methods that write both the Payment domain entity and an OutboxEvent record in a single @Transactional method. The OutboxEvent must have aggregate_type=Payment, aggregate_id=paymentId, event_type=PaymentCreated or PaymentApproved, and a JSON payload containing all fields needed by consumers."
    },
    {
      "id": "3",
      "description": "Configure a Debezium PostgreSQL connector JSON with the EventRouter SMT to monitor the outbox_events table, route messages to topic payments.${routedByValue}.events using the aggregate_type field, use aggregate_id as the Kafka message key, and pass event_type and aggregate_type as Kafka headers."
    },
    {
      "id": "4",
      "description": "Build an idempotent consumer that processes events from payments.Payment.events, reads the event id from the 'id' header set by the EventRouter, claims it in a processed_events table (INSERT ... ON CONFLICT DO NOTHING) and applies the business logic within the same database transaction. Test by replaying the same event twice and verifying the business logic runs only once."
    }
  ]
}
-->
