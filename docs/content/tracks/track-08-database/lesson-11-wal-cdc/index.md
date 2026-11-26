---
id: track-08-lesson-11
title: "WAL and CDC — Change Data Capture with Debezium"
slug: wal-cdc
track: track-08
trackName: "Database & Data Architecture"
sequence: 11
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [WAL, CDC, Debezium, logical-replication, streaming]
prerequisites: [track-08-lesson-01]
---

# WAL and CDC — Change Data Capture with Debezium

> [!NOTE]
> The dual-write problem — keeping a database and a message broker in sync atomically — is a classic source of lost events, ghost events and reconciliation breaks in financial systems. Change Data Capture via the WAL is a robust architectural answer: the database is the single source of truth, and downstream systems derive their state from the committed change stream, not from application-level dual writes.

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

**Key insight**: The WAL is an append-only, ordered log of every change made to the database. This makes it an excellent source for CDC — we can decode the WAL to discover what changed, in commit order.

### WAL Segments and LSN

```sql
-- Current WAL write position (Log Sequence Number)
SELECT pg_current_wal_lsn();
-- Returns e.g. 2/8A123456: a 64-bit byte position in the WAL stream,
-- printed as two hex halves (high 32 bits / low 32 bits)

-- WAL files on disk (needs superuser or the pg_monitor role)
SELECT * FROM pg_ls_waldir() ORDER BY modification DESC LIMIT 5;

-- Total WAL generated since the cluster was initialised
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
    active,
    confirmed_flush_lsn,
    pg_size_pretty(pg_wal_lsn_diff(
        pg_current_wal_lsn(), confirmed_flush_lsn)) AS consumer_lag,
    pg_size_pretty(pg_wal_lsn_diff(
        pg_current_wal_lsn(), restart_lsn))         AS retained_wal
FROM pg_replication_slots;

-- WARNING: a slot keeps WAL from restart_lsn onwards (and holds back
-- catalog_xmin, so catalog vacuum stalls) until its consumer confirms
-- Monitor: consumer_lag should be < 100MB in a healthy system
-- Alert:   retained_wal > 1GB -> risk of disk exhaustion
-- Safety cap (PG13+): max_slot_wal_keep_size = '50GB' -- beyond it the
-- slot is invalidated (consumer must re-snapshot) instead of filling the disk
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

    "plugin.name": "pgoutput",
    "publication.name": "debezium_publication",
    "publication.autocreate.mode": "disabled",
    "slot.name": "debezium_payment_service",

    "table.include.list": "public.transactions,public.accounts,public.ledger_entries",

    "snapshot.mode": "initial",

    "heartbeat.interval.ms": "30000",
    "heartbeat.action.query": "INSERT INTO debezium_heartbeat (id, last_heartbeat) VALUES (1, NOW()) ON CONFLICT (id) DO UPDATE SET last_heartbeat = EXCLUDED.last_heartbeat",

    "decimal.handling.mode": "string",
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

Notes on the settings:
- `decimal.handling.mode = string` keeps NUMERIC amounts exact and readable (`"100.5000"`). `precise` is also exact but appears as base64-encoded bytes in JSON; never use `double` for money.
- The heartbeat query writes to a small table in the captured database, so the slot keeps advancing even when the captured tables are quiet.
- `producer.override.*` only works if the Connect worker allows it (`connector.client.config.override.policy=All`).
- `topic.prefix` replaced the old `database.server.name` in Debezium 2.x.

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

-- Replica identity decides what the "before" image of UPDATE/DELETE holds.
-- DEFAULT (the default): only the primary key columns.
-- FULL: all old column values -- needed if consumers compute deltas or
-- audit old values; costs extra WAL on every update/delete.
ALTER TABLE accounts REPLICA IDENTITY FULL;
ALTER TABLE ledger_entries REPLICA IDENTITY FULL;
-- transactions keeps DEFAULT: consumers only need the new state
```

## 4. Debezium Event Structure

Each Debezium event contains the before and after state of the row. The examples below show the full change-event envelope, i.e. *without* the `ExtractNewRecordState` ("unwrap") transform; with the unwrap transform from the configuration above, consumers receive only the flattened `after` state (plus a `__deleted` field for deletes).

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
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Debezium reads the INSERTs from the WAL -- it never queries or updates
-- this table. So rows can be deleted soon after they are written: either
-- in the same transaction right after the INSERT (the WAL still carries
-- the insert), or by a cleanup job, e.g. every hour:
DELETE FROM outbox_events WHERE created_at < NOW() - INTERVAL '1 day';
-- (Debezium then also sees the DELETE; the EventRouter ignores deletes
--  of outbox rows, and tombstones.on.delete=false suppresses tombstones)
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
    // database.*, plugin.name, topic.prefix as in the connector above --
    // but its OWN slot: two connectors cannot share a replication slot
    "slot.name": "debezium_outbox",
    "table.include.list": "public.outbox_events",

    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.id": "id",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.table.field.event.type": "event_type",
    "transforms.outbox.table.field.event.payload": "payload",
    "transforms.outbox.route.by.field": "aggregate_type",
    "transforms.outbox.route.topic.replacement": "payments.${routedByValue}.events",
    "transforms.outbox.table.fields.additional.placement": "event_type:header:eventType",

    "tombstones.on.delete": "false",
    "transforms.outbox.table.expand.json.payload": "true"
  }
}
// Message key = aggregate_id (per-aggregate ordering), value = the payload,
// headers: "id" (the outbox row id -- use it to de-duplicate) and "eventType"
// This routes TransactionCompleted events to: payments.Transaction.events
// And AccountCreated events to: payments.Account.events
```

## 6. Consuming Debezium Events in Java

```java
// Spring Kafka consumer for transaction events.
// CDC delivers AT LEAST once (a connector restart can replay events), so
// the handler must be idempotent: record processed event ids.
@Component
@Slf4j
public class TransactionEventConsumer {

    private final NotificationService notificationService;
    private final LedgerSyncService ledgerSyncService;
    private final ProcessedEventRepository processedEvents;
    private final ObjectMapper objectMapper;

    @KafkaListener(
        topics = "payments.Transaction.events",
        groupId = "notification-service",
        containerFactory = "kafkaListenerContainerFactory"
    )
    @Transactional
    public void consumeTransactionEvent(
            @Payload String payloadJson,
            @Header(KafkaHeaders.RECEIVED_KEY) String aggregateId,
            @Header("id") String eventId,
            @Header("eventType") String eventType) throws Exception {

        // Duplicate? (INSERT ... ON CONFLICT DO NOTHING returns 0 rows)
        if (!processedEvents.markProcessed(eventId)) {
            log.debug("Skipping duplicate event {}", eventId);
            return;
        }

        TransactionPayload payload =
            objectMapper.readValue(payloadJson, TransactionPayload.class);

        switch (eventType) {
            case "TransactionCompleted" -> handleCompleted(payload);
            case "TransactionFailed"    -> handleFailed(payload);
            case "TransactionReversed"  -> handleReversed(payload);
            default -> log.warn("Unknown event type {} for {}", eventType, aggregateId);
        }
        // No try/catch: an exception propagates to the container's
        // DefaultErrorHandler, which retries with back-off and then sends
        // the record to a dead-letter topic (DeadLetterPublishingRecoverer).
        // Swallowing it and skipping ack would NOT cause redelivery -- the
        // next acknowledged record commits past it.
    }

    private void handleCompleted(TransactionPayload payload) {
        // Update read model (same DB transaction as the processed-event row)
        ledgerSyncService.syncTransaction(payload);
        // Push notification: at worst sent twice if we crash right after it
        notificationService.notifyTransactionComplete(payload);
    }
}
```

## 7. Monitoring Replication Lag

Replication lag is the delay between a change being committed to PostgreSQL and Debezium publishing it to Kafka. For financial systems, lag > 5 seconds is a concern. The database shows lag in **bytes** (below); lag in **time** comes from Debezium's own metric `MilliSecondsBehindSource` (streaming metrics, JMX/Prometheus).

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
    wal_status        -- 'reserved' / 'extended' OK; 'unreserved' / 'lost' = danger (PG13+)
FROM pg_replication_slots
WHERE slot_type = 'logical';

-- Alert when lag exceeds threshold
-- lag_size > 100MB = replication slot is falling behind
-- lag_size > 1GB  = risk of WAL disk exhaustion -> restart the connector;
--   dropping the slot is a deliberate human decision (it forces a re-snapshot)
```

```java
@Component
@Slf4j
public class ReplicationLagMonitor {

    private final JdbcTemplate jdbcTemplate;
    private final MeterRegistry metrics;
    // One holder per slot; each gauge is registered once, the first time
    // the slot is seen, and only the holder is updated afterwards
    private final Map<String, AtomicLong> lagBySlot = new ConcurrentHashMap<>();

    public ReplicationLagMonitor(JdbcTemplate jdbcTemplate, MeterRegistry metrics) {
        this.jdbcTemplate = jdbcTemplate;
        this.metrics = metrics;
    }

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
            (RowCallbackHandler) rs -> {
                String slotName = rs.getString("slot_name");
                long lagBytes = rs.getLong("lag_bytes");

                lagBySlot.computeIfAbsent(slotName, name -> {
                    AtomicLong holder = new AtomicLong();
                    Gauge.builder("cdc.replication.lag_bytes", holder, AtomicLong::get)
                        .tag("slot", name)
                        .baseUnit("bytes")
                        .register(metrics);
                    return holder;
                }).set(lagBytes);

                if (lagBytes > 1024L * 1024 * 1024) {           // 1GB
                    log.error("CRITICAL: Replication slot {} lag is {}MB. " +
                        "Restart the connector; drop the slot only by a deliberate decision.",
                        slotName, lagBytes / (1024 * 1024));
                } else if (lagBytes > 100L * 1024 * 1024) {     // 100MB
                    log.warn("Replication slot {} lag is {}MB — Debezium may be down",
                        slotName, lagBytes / (1024 * 1024));
                }
            });
    }
}
```

## 8. Handling Connector Failures and Restarts

Debezium stores its position in Kafka Connect's offset topic and confirms it to the slot (`confirmed_flush_lsn`), so PostgreSQL can free older WAL. On restart, it resumes from the last committed offset — no events are lost, but events after that offset may be **delivered again**. Delivery is at-least-once, so consumers must be idempotent.

```bash
# Check connector status via Kafka Connect REST API
curl http://kafka-connect:8083/connectors/payments-postgres-connector/status

# Restart a failed connector task
curl -X POST \
  http://kafka-connect:8083/connectors/payments-postgres-connector/tasks/0/restart

# Restart the entire connector
curl -X POST \
  http://kafka-connect:8083/connectors/payments-postgres-connector/restart

# Monitor connector lag via JMX (or Prometheus via the JMX exporter)
# kafka.connect:type=source-task-metrics,connector=payments-postgres-connector,task=0
#   source-record-active-count: records polled but not yet written to Kafka
#   source-record-write-rate:   records/second being published to Kafka
# debezium.postgres:type=connector-metrics,context=streaming,server=payments
#   MilliSecondsBehindSource:   time lag behind the database
```

## 9. Snapshot Mode for Initial Data Load

When Debezium first connects to a database, it performs an initial snapshot to load existing data before switching to streaming.

```json
// Snapshot configuration options
{
  "snapshot.mode": "initial",
  // Options (Debezium 2.x):
  // "initial": snapshot existing data, then stream changes (default)
  // "initial_only": snapshot only, no streaming (for one-time data migration)
  // "no_data" (older name "never"): skip the data snapshot, only stream
  //     changes from now (risk: consumers miss existing rows)
  // "always": re-snapshot on every connector start (expensive, rarely right)
  // "when_needed": snapshot only if no usable offset exists
  //     (e.g. the slot was dropped or invalidated)

  // The snapshot reads all tables in one REPEATABLE READ transaction that
  // uses the snapshot exported when the slot is created, so it lines up
  // exactly with the point where streaming starts -- no gap, no overlap.

  "snapshot.max.threads": "4",
  // Parallel snapshot threads for faster initial load of many tables

  "snapshot.fetch.size": "10240"
  // Rows fetched per batch during snapshot (tune based on row size)
}
```

## 10. Kafka Connect Integration and Deployment

```yaml
# Docker Compose for local development
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
    image: apache/kafka:3.7.0          # single-node KRaft (no ZooKeeper)
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1

  kafka-connect:
    image: quay.io/debezium/connect:2.5
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
# Locally there is one broker: use replication factor 1 in the connector's
# topic.creation.default.replication.factor
```

```java
// End-to-end test: PostgreSQL + Kafka + a real Debezium connector
// (io.debezium:debezium-testing-testcontainers). An embedded Kafka alone
// would not work: something must actually read the WAL and publish.
@SpringBootTest
@Testcontainers
class OutboxCdcIntegrationTest {

    static Network network = Network.newNetwork();

    @Container
    static KafkaContainer kafka = new KafkaContainer(
            DockerImageName.parse("confluentinc/cp-kafka:7.6.1"))
        .withNetwork(network).withNetworkAliases("kafka");

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withNetwork(network).withNetworkAliases("postgres")
        .withCommand("postgres", "-c", "wal_level=logical");

    @Container
    static DebeziumContainer connect = new DebeziumContainer("quay.io/debezium/connect:2.5")
        .withNetwork(network)
        .withKafka(kafka)
        .dependsOn(kafka, postgres);

    @Autowired
    private TransactionService transactionService;

    @Test
    void completingTransactionShouldPublishEvent() {
        // Register the connector here, after Flyway (at context start) has
        // created outbox_events
        connect.registerConnector("outbox", ConnectorConfiguration
            .forJdbcContainer(postgres)
            .with("topic.prefix", "payments")
            .with("plugin.name", "pgoutput")
            .with("table.include.list", "public.outbox_events")
            .with("transforms", "outbox")
            .with("transforms.outbox.type", "io.debezium.transforms.outbox.EventRouter")
            .with("transforms.outbox.table.field.event.key", "aggregate_id")
            .with("transforms.outbox.table.field.event.payload", "payload")
            .with("transforms.outbox.route.by.field", "aggregate_type")
            .with("transforms.outbox.route.topic.replacement", "payments.${routedByValue}.events")
            .with("transforms.outbox.table.fields.additional.placement", "event_type:header:eventType"));

        UUID txnId = createTestTransaction();
        transactionService.completeTransaction(txnId);

        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(Map.of(
                ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, kafka.getBootstrapServers(),
                ConsumerConfig.GROUP_ID_CONFIG, "test",
                ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest"),
                new StringDeserializer(), new StringDeserializer())) {

            consumer.subscribe(List.of("payments.Transaction.events"));

            await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
                List<ConsumerRecord<String, String>> records = new ArrayList<>();
                consumer.poll(Duration.ofMillis(500)).forEach(records::add);
                assertThat(records).anySatisfy(r -> {
                    // key is the aggregate_id (a JSON string with the default converter)
                    assertThat(r.key()).contains(txnId.toString());
                    assertThat(new String(r.headers().lastHeader("eventType").value()))
                        .contains("TransactionCompleted");
                });
            });
        }
    }
}
```

> [!WARNING]
> Replication slots that are not consumed prevent PostgreSQL from cleaning up WAL segments. If a Debezium connector goes down and is not restarted, the WAL will grow indefinitely until the disk is full. Implement automated monitoring and alerting for replication slot lag, set `max_slot_wal_keep_size` (PG13+) as a last-resort cap, and document the procedure for safely dropping a stale slot: `SELECT pg_drop_replication_slot('slot_name');`. Dropping a slot means you will need to re-snapshot when the connector restarts.

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
      "explanation": "wal_level = logical lets PostgreSQL decode WAL into row-level change events that Debezium consumes. The critical operational risk is slot lag: a replication slot keeps every WAL segment its consumer has not yet confirmed. If Debezium is down and the slot stays, WAL accumulates without limit — a long outage on a busy system can retain hundreds of GB. Monitor slot lag (pg_replication_slots: confirmed_flush_lsn / restart_lsn), alert early (e.g. 100MB), set max_slot_wal_keep_size as a safety cap, and treat dropping the slot as a deliberate decision, because it forces a re-snapshot."
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
      "explanation": "REPLICA IDENTITY DEFAULT (the PostgreSQL default) puts only the primary key into the 'before' image of UPDATE and DELETE events. Consumers cannot see the old balance — only which row changed. To get the full before image (old balance, old status, etc.), set REPLICA IDENTITY FULL (all columns, at the cost of extra WAL). REPLICA IDENTITY USING INDEX gives only the columns of the chosen unique index. The full before image matters for downstream systems that audit changes or compute deltas."
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
