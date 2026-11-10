---
id: track-10-lesson-11
title: "WAL and CDC — Change Data Capture with Debezium"
slug: wal-cdc
track: track-10
trackName: "Database & Data Architecture"
sequence: 11
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [WAL, CDC, Debezium, logical-replication, streaming]
prerequisites: [track-10-lesson-01]
---

# WAL and CDC — Change Data Capture with Debezium

> [!NOTE]
> The dual-write problem — keeping a database and a message broker in sync atomically — has caused some of the most expensive outages in financial services. Change Data Capture via the WAL is the correct architectural solution: the database is the single source of truth, and all downstream systems derive their state from the WAL stream, not from application-level dual writes.

## 1. PostgreSQL WAL Internals

The Write-Ahead Log (WAL) is PostgreSQL's durability mechanism. Before any data modification is written to the actual table pages, the change is recorded in the WAL. This guarantees that committed transactions survive crashes.

```
Transaction COMMIT sequence:
1. Transaction executes: modify buffer pages (in shared_buffers)
2. WAL record written to WAL buffer
3. WAL buffer flushed to disk (fsync) on COMMIT
4. COMMIT returns to client (data is durable)
5. Checkpoint: dirty buffer pages eventually written to data files
```

**Key insight**: The WAL is an immutable ordered log of every change made to the database. This makes it perfect for CDC — we can "replay" the WAL to discover what changed.

### WAL Segments and LSN

```sql
-- Current WAL write position (Log Sequence Number)
SELECT pg_current_wal_lsn();
-- Returns: 2/8A123456 (in hex: segment/offset)

-- WAL files on disk
SELECT * FROM pg_ls_waldir() ORDER BY modification DESC LIMIT 5;

-- Size of outstanding WAL (not yet replicated or archived)
SELECT pg_size_pretty(
    pg_current_wal_lsn() - '0/0'::pg_lsn
) AS wal_generated_total;
```

## 2. Logical Replication Slots

Physical replication sends raw binary WAL data. Logical replication decodes the WAL into a human-readable stream of row-level changes (INSERT, UPDATE, DELETE with column values).

Debezium uses logical replication slots to consume this decoded stream.

```sql
-- PostgreSQL configuration required for logical replication
-- postgresql.conf:
-- wal_level = logical            (must be 'logical', not 'minimal' or 'replica')
-- max_replication_slots = 10     (increase for multiple CDC consumers)
-- max_wal_senders = 10

-- Create a replication slot manually (Debezium does this automatically)
SELECT pg_create_logical_replication_slot(
    'debezium_payment_service',  -- slot name
    'pgoutput'                   -- output plugin (pgoutput is built-in since PG10)
);

-- List replication slots
SELECT
    slot_name,
    plugin,
    database,
    confirmed_flush_lsn,
    pg_size_pretty(pg_wal_lsn_diff(
        pg_current_wal_lsn(),
        confirmed_flush_lsn
    )) AS lag_bytes,
    active
FROM pg_replication_slots;

-- WARNING: Unused replication slots prevent WAL cleanup (WAL accumulates)
-- Monitor: lag_bytes should be < 100MB in a healthy system
-- Alert: lag_bytes > 1GB -> risk of disk exhaustion
```

## 3. Debezium PostgreSQL Connector

Debezium is a Kafka Connect-based CDC platform that reads from the WAL and publishes change events to Kafka topics.

### Connector Configuration

```json
{
  "name": "payments-postgres-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres-primary.internal",
    "database.port": "5432",
    "database.user": "debezium_replication",
    "database.password": "${file:/secrets/db-password.properties:password}",
    "database.dbname": "payments",
    "database.server.name": "payments",

    "plugin.name": "pgoutput",
    "publication.name": "debezium_publication",
    "slot.name": "debezium_payment_service",

    "table.include.list": "public.transactions,public.accounts,public.ledger_entries",

    "snapshot.mode": "initial",
    "snapshot.isolation.mode": "read_committed",

    "heartbeat.interval.ms": "30000",
    "heartbeat.action.query": "INSERT INTO debezium_heartbeat (last_heartbeat) VALUES (NOW()) ON CONFLICT (id) DO UPDATE SET last_heartbeat = EXCLUDED.last_heartbeat",

    "decimal.handling.mode": "precise",
    "time.precision.mode": "adaptive_time_microseconds",

    "topic.prefix": "payments",
    "topic.creation.default.replication.factor": "3",
    "topic.creation.default.partitions": "12",

    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",

    "producer.override.acks": "all",
    "producer.override.enable.idempotence": "true"
  }
}
```

### PostgreSQL Setup for Debezium

```sql
-- Create a dedicated replication user (principle of least privilege)
CREATE USER debezium_replication WITH REPLICATION LOGIN PASSWORD 'strong_password';

-- Grant SELECT on tables for snapshot
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium_replication;
GRANT USAGE ON SCHEMA public TO debezium_replication;

-- Create publication (what Debezium subscribes to)
CREATE PUBLICATION debezium_publication
    FOR TABLE transactions, accounts, ledger_entries
    WITH (publish = 'insert, update, delete');

-- Enable replica identity for UPDATE/DELETE events to include old row values
-- Without this, UPDATE events won't include the old column values
ALTER TABLE transactions REPLICA IDENTITY FULL;
ALTER TABLE accounts REPLICA IDENTITY FULL;
ALTER TABLE ledger_entries REPLICA IDENTITY FULL;

-- Or use USING INDEX to only publish the primary key for old values:
ALTER TABLE transactions REPLICA IDENTITY USING INDEX transactions_pkey;
```

## 4. Debezium Event Structure

Each Debezium event contains the before and after state of the row.

```json
// INSERT event for a new transaction
{
  "schema": { "..." },
  "payload": {
    "before": null,
    "after": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "account_id": "acct-001",
      "amount": "100.5000",
      "currency": "USD",
      "status": "PENDING",
      "type": "DEBIT",
      "created_at": "2024-01-15T10:30:00.000000Z"
    },
    "source": {
      "version": "2.5.0.Final",
      "connector": "postgresql",
      "name": "payments",
      "ts_ms": 1705312200000,
      "snapshot": "false",
      "db": "payments",
      "schema": "public",
      "table": "transactions",
      "txId": 12345,
      "lsn": 1234567890,
      "xmin": null
    },
    "op": "c",
    "ts_ms": 1705312200123,
    "transaction": {
      "id": "ABC123",
      "total_order": 1,
      "data_collection_order": 1
    }
  }
}

// UPDATE event (status changed from PENDING to COMPLETED)
{
  "payload": {
    "before": {
      "id": "550e8400-...",
      "status": "PENDING",
      "settled_at": null
    },
    "after": {
      "id": "550e8400-...",
      "status": "COMPLETED",
      "settled_at": "2024-01-15T10:30:05.000000Z"
    },
    "op": "u",
    "ts_ms": 1705312205000
  }
}
```

**Operations**: `c` = create (INSERT), `u` = update (UPDATE), `d` = delete (DELETE), `r` = read (snapshot)

## 5. The Outbox Pattern with Debezium

The Outbox pattern solves dual-write atomically: instead of writing to both the database and Kafka, the application writes to a database outbox table, and Debezium publishes those events to Kafka.

```sql
-- Outbox table
CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  VARCHAR(50) NOT NULL,  -- 'Transaction', 'Account'
    aggregate_id    UUID NOT NULL,
    event_type      VARCHAR(100) NOT NULL, -- 'TransactionCompleted', 'AccountCreated'
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ            -- set by Debezium after publishing
);

-- Index for Debezium to scan pending events
CREATE INDEX idx_outbox_unprocessed
    ON outbox_events (created_at)
    WHERE processed_at IS NULL;
```

```java
@Service
@Transactional
public class TransactionService {

    private final TransactionRepository transactionRepo;
    private final OutboxRepository outboxRepo;

    /**
     * Atomic: both the transaction write and the event publication
     * happen in the same DB transaction. No dual-write problem.
     * Debezium reads the outbox_events row from WAL and publishes to Kafka.
     */
    public Transaction completeTransaction(UUID transactionId) {
        Transaction txn = transactionRepo.findById(transactionId)
            .orElseThrow(() -> new TransactionNotFoundException(transactionId));

        txn.complete(Instant.now());
        transactionRepo.save(txn);

        // Write event to outbox — same transaction, atomic with txn update
        OutboxEvent event = OutboxEvent.builder()
            .aggregateType("Transaction")
            .aggregateId(transactionId)
            .eventType("TransactionCompleted")
            .payload(Map.of(
                "transactionId", transactionId.toString(),
                "accountId",     txn.getAccountId().toString(),
                "amount",        txn.getAmount().toPlainString(),
                "currency",      txn.getCurrency(),
                "settledAt",     txn.getSettledAt().toString()
            ))
            .build();

        outboxRepo.save(event);

        return txn;
        // On commit: both transaction row and outbox_events row are written.
        // Debezium detects the outbox_events INSERT via WAL and publishes to Kafka.
        // Even if Kafka is down, the event is safely stored in outbox_events.
    }
}
```

### Debezium Outbox Event Router SMT

```json
// Kafka Connect connector with Outbox Event Router SMT
{
  "name": "payments-outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "table.include.list": "public.outbox_events",

    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.id": "id",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.table.field.event.type": "event_type",
    "transforms.outbox.table.field.event.payload": "payload",
    "transforms.outbox.route.by.field": "aggregate_type",
    "transforms.outbox.route.topic.replacement": "payments.${routedByValue}.events",

    "tombstones.on.delete": "true",
    "transforms.outbox.table.expand.json.payload": "true"
  }
}
// This routes TransactionCompleted events to: payments.Transaction.events
// And AccountCreated events to: payments.Account.events
```

## 6. Consuming Debezium Events in Java

```java
// Spring Kafka consumer for transaction events
@Component
@Slf4j
public class TransactionEventConsumer {

    private final NotificationService notificationService;
    private final LedgerSyncService ledgerSyncService;
    private final ObjectMapper objectMapper;

    @KafkaListener(
        topics = "payments.Transaction.events",
        groupId = "notification-service",
        containerFactory = "kafkaListenerContainerFactory"
    )
    public void consumeTransactionEvent(
            @Payload String eventJson,
            @Header(KafkaHeaders.RECEIVED_KEY) String aggregateId,
            Acknowledgment ack) {

        try {
            TransactionEvent event = objectMapper.readValue(eventJson, TransactionEvent.class);

            switch (event.getEventType()) {
                case "TransactionCompleted" -> handleCompleted(event);
                case "TransactionFailed"    -> handleFailed(event);
                case "TransactionReversed"  -> handleReversed(event);
                default -> log.warn("Unknown event type: {}", event.getEventType());
            }

            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process event for transaction {}: {}",
                aggregateId, e.getMessage(), e);
            // Do NOT acknowledge — message will be redelivered
            // After max retries, goes to DLQ
        }
    }

    private void handleCompleted(TransactionEvent event) {
        // Update read model
        ledgerSyncService.syncTransaction(event.getPayload());
        // Send push notification
        notificationService.notifyTransactionComplete(event.getPayload());
    }
}
```

## 7. Monitoring Replication Lag

Replication lag is the delay between a change being committed to PostgreSQL and Debezium publishing it to Kafka. For financial systems, lag > 5 seconds is a concern.

```sql
-- Monitor replication slot lag
SELECT
    slot_name,
    database,
    active,
    pg_size_pretty(pg_wal_lsn_diff(
        pg_current_wal_lsn(),
        confirmed_flush_lsn
    )) AS lag_size,
    EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))::INT
        AS lag_seconds_approx
FROM pg_replication_slots
WHERE slot_type = 'logical';

-- Alert when lag exceeds threshold
-- lag_size > 100MB = replication slot is falling behind
-- lag_size > 1GB = risk of WAL disk exhaustion -> DROP SLOT if connector is dead
```

```java
@Component
@Slf4j
public class ReplicationLagMonitor {

    private final JdbcTemplate jdbcTemplate;
    private final MeterRegistry metrics;

    @Scheduled(fixedRate = 10_000)
    public void reportReplicationLag() {
        jdbcTemplate.query(
            """
            SELECT slot_name,
                   pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
                       AS lag_bytes
            FROM pg_replication_slots
            WHERE slot_type = 'logical' AND database = 'payments'
            """,
            rs -> {
                while (rs.next()) {
                    String slotName = rs.getString("slot_name");
                    long lagBytes = rs.getLong("lag_bytes");

                    metrics.gauge("cdc.replication.lag_bytes",
                        Tags.of("slot", slotName), lagBytes);

                    if (lagBytes > 100 * 1024 * 1024) {  // 100MB
                        log.warn("Replication slot {} lag is {}MB — Debezium may be down",
                            slotName, lagBytes / (1024 * 1024));
                    }

                    if (lagBytes > 1024 * 1024 * 1024) {  // 1GB
                        log.error("CRITICAL: Replication slot {} lag is {}GB. " +
                            "If connector is dead, drop the slot to prevent disk exhaustion.",
                            slotName, lagBytes / (1024 * 1024 * 1024));
                    }
                }
            }
        );
    }
}
```

## 8. Handling Connector Failures and Restarts

Debezium uses the replication slot's `confirmed_flush_lsn` to track progress. On restart, it resumes from where it left off — no events are lost.

```bash
# Check connector status via Kafka Connect REST API
curl http://kafka-connect:8083/connectors/payments-postgres-connector/status

# Restart a failed connector task
curl -X POST \
  http://kafka-connect:8083/connectors/payments-postgres-connector/tasks/0/restart

# Restart the entire connector
curl -X POST \
  http://kafka-connect:8083/connectors/payments-postgres-connector/restart

# Monitor connector lag via Kafka Connect metrics (JMX or Prometheus)
# kafka.connect:type=connector-task-metrics,connector=payments-postgres-connector
#   source-record-active-count: records being processed
#   source-record-write-rate: records/second being published to Kafka
```

## 9. Snapshot Mode for Initial Data Load

When Debezium first connects to a database, it performs an initial snapshot to load existing data before switching to streaming.

```json
// Snapshot configuration options
{
  "snapshot.mode": "initial",
  // Options:
  // "initial": snapshot existing data, then stream changes (default)
  // "initial_only": snapshot only, no streaming (for one-time data migration)
  // "never": skip snapshot, only stream changes from now (risk: missing historical data)
  // "always": re-snapshot on every connector restart (expensive, rarely correct)
  // "when_needed": only if replication slot doesn't exist

  "snapshot.isolation.mode": "read_committed",
  // "serializable": strictest but can cause contention on large tables
  // "read_committed": less strict but no phantom reads in snapshot
  // "repeatable_read": balance of consistency and concurrency

  "snapshot.max.threads": "4",
  // Parallel snapshot threads for faster initial load on large tables

  "snapshot.fetch.size": "10240"
  // Rows fetched per batch during snapshot (tune based on row size)
}
```

## 10. Kafka Connect Integration and Deployment

```yaml
# Docker Compose for local development
version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: payments
      POSTGRES_USER: payments_app
      POSTGRES_PASSWORD: dev_password
    command: >
      postgres
      -c wal_level=logical
      -c max_replication_slots=5
      -c max_wal_senders=5

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    environment:
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true'

  kafka-connect:
    image: debezium/connect:2.5
    depends_on: [kafka, postgres]
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: payments-cdc-group
      CONFIG_STORAGE_TOPIC: debezium_configs
      OFFSET_STORAGE_TOPIC: debezium_offsets
      STATUS_STORAGE_TOPIC: debezium_status
      CONNECT_VALUE_CONVERTER: org.apache.kafka.connect.json.JsonConverter
      CONNECT_KEY_CONVERTER: org.apache.kafka.connect.json.JsonConverter
    ports:
      - "8083:8083"
```

```java
// Integration test: verify CDC events are published
@SpringBootTest
@EmbeddedKafka(partitions = 1, topics = {"payments.Transaction.events"})
@Testcontainers
class DebeziumIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withCommand("-c", "wal_level=logical", "-c", "max_replication_slots=2");

    @Autowired
    private TransactionService transactionService;

    @Test
    void completingTransactionShouldPublishEvent() throws Exception {
        // Arrange
        UUID txnId = createTestTransaction();

        // Act
        transactionService.completeTransaction(txnId);

        // Assert: event should appear in Kafka (via outbox pattern)
        ConsumerRecord<String, String> record = KafkaTestUtils.getSingleRecord(
            consumer, "payments.Transaction.events", 5000
        );

        assertThat(record.key()).isEqualTo(txnId.toString());
        assertThat(record.value()).contains("TransactionCompleted");
    }
}
```

> [!WARNING]
> Replication slots that are not consumed prevent PostgreSQL from cleaning up WAL segments. If a Debezium connector goes down and is not restarted, the WAL will grow indefinitely until the disk is full. Implement automated monitoring and alerting for replication slot lag, and document the procedure for safely dropping a stale slot: `SELECT pg_drop_replication_slot('slot_name');`. Dropping a slot means you will need to re-snapshot when the connector restarts.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A microservice writes a completed transaction to PostgreSQL and then calls a Kafka producer to publish a TransactionCompleted event. The Kafka call succeeds but then the database commit fails. What data consistency problem has occurred and what pattern solves it?",
      "options": [
        "Idempotency violation — solved by adding an idempotency key to the Kafka message",
        "Dual-write inconsistency — the event was published for a transaction that never committed; solved by the Outbox pattern where both the transaction write and event record are committed atomically in a single database transaction, with Debezium publishing from the WAL",
        "At-most-once delivery — solved by configuring Kafka producer acks=all",
        "Network partition — solved by implementing a saga with compensating transactions"
      ],
      "correct": 1,
      "explanation": "This is the classic dual-write problem. When you write to two systems (database + Kafka), there is no atomic guarantee: either the database can fail after Kafka succeeds (ghost event with no committed data) or Kafka can fail after the database commits (committed data with no event). The Outbox pattern solves this by writing both the business data and an outbox_events row in a single ACID database transaction, then having Debezium publish from the WAL. If the database transaction rolls back, neither the business data nor the outbox event is written."
    },
    {
      "text": "What PostgreSQL configuration is mandatory for Debezium to consume logical replication events, and what is the operational risk if this setting is not monitored?",
      "options": [
        "synchronous_commit = on is required; risk is data loss if disabled",
        "wal_level = logical is required; without monitoring replication slot lag, unconsumed WAL accumulates and can fill the disk if the Debezium connector goes down",
        "max_connections must be set high enough for Debezium connections; risk is connection exhaustion",
        "shared_buffers must be set to 25% of RAM; risk is poor query performance affecting CDC throughput"
      ],
      "correct": 1,
      "explanation": "wal_level = logical enables PostgreSQL to decode WAL into row-level change events that Debezium consumes. The critical operational risk is replication slot lag: a replication slot prevents PostgreSQL from cleaning up WAL segments that the slot has not yet consumed. If Debezium goes down without the slot being dropped, WAL accumulates indefinitely. A 24-hour outage on a 10,000 TPS system can generate hundreds of GB of WAL. Monitor slot lag (pg_replication_slots.confirmed_flush_lsn) and alert at 100MB lag, with automated procedures to drop the slot at 1GB to prevent disk exhaustion."
    },
    {
      "text": "A Debezium connector is configured with REPLICA IDENTITY DEFAULT on the accounts table. When a balance UPDATE is published, what does the 'before' field in the Debezium event contain?",
      "options": [
        "The complete previous state of all columns including the old balance",
        "Only the primary key column(s) of the updated row",
        "Nothing — REPLICA IDENTITY DEFAULT only captures new values, not old values",
        "The old balance field only, as it is the modified column"
      ],
      "correct": 1,
      "explanation": "REPLICA IDENTITY DEFAULT (the PostgreSQL default) includes only the primary key in the 'before' image of UPDATE and DELETE events. This means consumers cannot see what the old balance was — only the primary key identifying which row changed. To get full before-image (old balance, old status, etc.), you must set REPLICA IDENTITY FULL or REPLICA IDENTITY USING INDEX. FULL includes all columns in the before image. This is important for downstream systems that need to audit changes or compute deltas."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Outbox Pattern Implementation with Debezium",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement the full Outbox pattern for a payment settlement service. Create the outbox_events table with appropriate indexes. Write the TransactionService.settlePayment() method that atomically records the settlement and the OutboxEvent in a single @Transactional method. Include the Debezium connector configuration JSON for the Outbox Event Router SMT that routes events to the correct Kafka topic based on aggregate_type."},
    {"id": "2", "description": "Write a Testcontainers integration test using an embedded Kafka and a PostgreSQL container configured with wal_level=logical. The test should: (1) trigger a payment settlement, (2) verify the outbox_events row was written, (3) simulate Debezium by reading the WAL replication slot directly, and (4) verify the correct Kafka message was produced with the expected payload structure including aggregate_id as the message key."},
    {"id": "3", "description": "Build a replication slot monitoring service that queries pg_replication_slots every 60 seconds, records lag_bytes as a Micrometer gauge, logs a warning when lag exceeds 100MB, and triggers a PagerDuty alert when lag exceeds 500MB. Include a safety mechanism that logs a CRITICAL alert (but does NOT automatically drop the slot) when lag exceeds 1GB, requiring human confirmation before dropping."},
    {"id": "4", "description": "Design and document the incident response procedure for a Debezium connector that has been down for 6 hours with 2GB of WAL accumulated. The procedure must address: how to assess whether to restart with the existing slot (risk: re-processing 6 hours of events) versus dropping and re-snapshotting (risk: re-processing all historical data), how to handle duplicate events in downstream consumers during replay, and how to verify the downstream systems are consistent after recovery."}
  ]
}
-->
