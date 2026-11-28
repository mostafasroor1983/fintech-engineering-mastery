---
id: track-08-lesson-11
title: "WAL وCDC — التقاط تغييرات البيانات باستخدام Debezium"
slug: wal-cdc
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 11
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [WAL, CDC, Debezium, logical-replication, streaming]
prerequisites: [track-08-lesson-01]
---

# ‏WAL وCDC — التقاط تغييرات البيانات باستخدام Debezium

> [!NOTE]
> مشكلة الكتابة المزدوجة — إبقاء قاعدة البيانات ووسيط الرسائل متزامنين ذريًا — مصدر كلاسيكي لأحداث ضائعة، وأحداث شبحية، وانكسارات في المطابقة في الأنظمة المالية. والتقاط تغييرات البيانات (CDC) عبر WAL إجابة معمارية متينة: قاعدة البيانات هي مصدر الحقيقة الوحيد، والأنظمة اللاحقة تستمد حالتها من تدفق التغييرات الملتزمة، لا من الكتابات المزدوجة على مستوى التطبيق.

## 1. داخلية WAL في PostgreSQL

سجل الكتابة المسبقة (WAL) هو آلية الديمومة في PostgreSQL. فقبل كتابة أي تعديل بيانات إلى صفحات الجدول الفعلية، يُسجل التغيير في WAL. وهذا يضمن نجاة المعاملات الملتزمة من الأعطال.

```
Transaction COMMIT sequence:
1. Transaction executes: modify buffer pages (in shared_buffers)
2. WAL record written to WAL buffer
3. WAL buffer flushed to disk (fsync) on COMMIT
4. COMMIT returns to client (data is durable)
5. Checkpoint: dirty buffer pages eventually written to data files
```

**فكرة أساسية**: ‏WAL سجل مرتب يُلحق به فقط لكل تغيير يحدث في قاعدة البيانات. وهذا يجعله مصدرًا ممتازًا لـ CDC — إذ يمكننا فك ترميز WAL لاكتشاف ما تغير، بترتيب الالتزام.

### مقاطع WAL وLSN

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

## 2. فتحات النسخ المنطقي

يرسل النسخ الفيزيائي بيانات WAL الثنائية الخام. أما النسخ المنطقي فيفك ترميز WAL إلى تدفق مقروء من التغييرات على مستوى الصف (INSERT وUPDATE وDELETE مع قيم الأعمدة).

ويستخدم Debezium فتحات النسخ المنطقي لاستهلاك هذا التدفق المفكوك.

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

## 3. موصّل Debezium لـ PostgreSQL

‏Debezium منصة CDC مبنية على Kafka Connect تقرأ من WAL وتنشر أحداث التغيير إلى مواضيع Kafka.

### إعداد الموصّل

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

ملاحظات على الإعدادات:
- ‏`decimal.handling.mode = string` يبقي مبالغ NUMERIC دقيقة ومقروءة (`"100.5000"`). و`precise` دقيق أيضًا لكنه يظهر كبايتات مرمّزة بـ base64 في JSON؛ ولا تستخدم `double` للمال أبدًا.
- يكتب استعلام النبض إلى جدول صغير في قاعدة البيانات الملتقطة، كي تواصل الفتحة التقدم حتى حين تكون الجداول الملتقطة هادئة.
- ‏`producer.override.*` يعمل فقط إذا سمح به عامل Connect ‏(`connector.client.config.override.policy=All`).
- حلّ `topic.prefix` محل `database.server.name` القديم في Debezium 2.x.

### إعداد PostgreSQL لـ Debezium

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

## 4. بنية حدث Debezium

يحتوي كل حدث Debezium على حالة الصف قبل التغيير وبعده. وتُظهر الأمثلة أدناه غلاف حدث التغيير الكامل، أي *دون* تحويل `ExtractNewRecordState` ‏("unwrap")؛ ومع تحويل unwrap من الإعداد أعلاه، يستقبل المستهلكون حالة `after` المسطّحة فقط (مع حقل `__deleted` للحذف).

```jsonc
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

**العمليات**: ‏`c` = إنشاء (INSERT)، و`u` = تحديث (UPDATE)، و`d` = حذف (DELETE)، و`r` = قراءة (لقطة)

## 5. نمط Outbox مع Debezium

يحل نمط Outbox الكتابة المزدوجة ذريًا: فبدل الكتابة إلى قاعدة البيانات وKafka معًا، يكتب التطبيق إلى جدول outbox في قاعدة البيانات، وينشر Debezium تلك الأحداث إلى Kafka.

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

### محوّل Outbox Event Router في Debezium

```jsonc
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

## 6. استهلاك أحداث Debezium في Java

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

## 7. مراقبة تأخر النسخ

تأخر النسخ هو التأخير بين التزام تغيير في PostgreSQL ونشر Debezium له إلى Kafka. وفي الأنظمة المالية، التأخر > 5 ثوانٍ مصدر قلق. وتُظهر قاعدة البيانات التأخر **بالبايتات** (أدناه)؛ أما التأخر **بالزمن** فيأتي من مقياس Debezium الخاص `MilliSecondsBehindSource` (مقاييس التدفق، JMX/Prometheus).

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

## 8. التعامل مع أعطال الموصّل وإعادة تشغيله

يخزن Debezium موضعه في موضوع الإزاحات في Kafka Connect ويؤكده للفتحة (`confirmed_flush_lsn`)، فيستطيع PostgreSQL تحرير WAL الأقدم. وعند إعادة التشغيل، يستأنف من آخر إزاحة ملتزمة — فلا تضيع أحداث، لكن الأحداث بعد تلك الإزاحة قد **تُسلّم مرة أخرى**. فالتسليم "مرة واحدة على الأقل"، لذا يجب أن يكون المستهلكون idempotent.

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

## 9. وضع اللقطة للتحميل الأولي للبيانات

حين يتصل Debezium بقاعدة بيانات أول مرة، ينفذ لقطة أولية لتحميل البيانات القائمة قبل التحول إلى التدفق.

```jsonc
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

## 10. التكامل مع Kafka Connect والنشر

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
> فتحات النسخ غير المستهلكة تمنع PostgreSQL من تنظيف مقاطع WAL. فإذا تعطل موصّل Debezium ولم يُعد تشغيله، سينمو WAL بلا حد حتى يمتلئ القرص. فنفّذ مراقبة وتنبيهًا آليين لتأخر فتحات النسخ، واضبط `max_slot_wal_keep_size` ‏(PG13+) كحد أخير، ووثّق إجراء الحذف الآمن لفتحة قديمة: `SELECT pg_drop_replication_slot('slot_name');`. وحذف الفتحة يعني أنك ستحتاج إلى لقطة جديدة حين يُعاد تشغيل الموصّل.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تكتب خدمة مصغّرة معاملة مكتملة إلى PostgreSQL ثم تستدعي منتج Kafka لنشر حدث TransactionCompleted. ينجح استدعاء Kafka لكن التزام قاعدة البيانات يفشل بعدها. ما مشكلة اتساق البيانات التي حدثت وما النمط الذي يحلها؟",
      "options": [
        "انتهاك idempotency — يُحل بإضافة مفتاح idempotency إلى رسالة Kafka",
        "عدم اتساق الكتابة المزدوجة — نُشر الحدث لمعاملة لم تلتزم أبدًا؛ ويحله نمط Outbox حيث تُلتزم كتابة المعاملة وسجل الحدث ذريًا في معاملة قاعدة بيانات واحدة، وينشر Debezium من WAL",
        "التسليم مرة واحدة على الأكثر — يُحل بضبط منتج Kafka على acks=all",
        "انقسام الشبكة — يُحل بتنفيذ Saga بمعاملات تعويضية"
      ],
      "correct": 1,
      "explanation": "هذه مشكلة الكتابة المزدوجة الكلاسيكية. فحين تكتب إلى نظامين (قاعدة البيانات + Kafka)، لا يوجد ضمان ذري: فإما أن تفشل قاعدة البيانات بعد نجاح Kafka (حدث شبحي بلا بيانات ملتزمة) أو يفشل Kafka بعد التزام قاعدة البيانات (بيانات ملتزمة بلا حدث). ويحل نمط Outbox ذلك بكتابة بيانات العمل وصف في outbox_events في معاملة قاعدة بيانات ACID واحدة، ثم يجعل Debezium ينشر من WAL. فإذا تراجعت معاملة قاعدة البيانات، لا تُكتب بيانات العمل ولا حدث outbox."
    },
    {
      "text": "ما إعداد PostgreSQL الإلزامي كي يستهلك Debezium أحداث النسخ المنطقي، وما الخطر التشغيلي إذا لم يُراقب هذا الإعداد؟",
      "options": [
        "يلزم synchronous_commit = on؛ والخطر فقد البيانات إن عُطّل",
        "يلزم wal_level = logical؛ ودون مراقبة تأخر فتحة النسخ، يتراكم WAL غير المستهلك وقد يملأ القرص إذا تعطل موصّل Debezium",
        "يجب ضبط max_connections عاليًا بما يكفي لاتصالات Debezium؛ والخطر استنفاد الاتصالات",
        "يجب ضبط shared_buffers على 25% من الذاكرة؛ والخطر أداء استعلام ضعيف يؤثر على إنتاجية CDC"
      ],
      "correct": 1,
      "explanation": "يتيح wal_level = logical لـ PostgreSQL فك ترميز WAL إلى أحداث تغيير على مستوى الصف يستهلكها Debezium. والخطر التشغيلي الحاسم تأخر الفتحة: ففتحة النسخ تحتفظ بكل مقطع WAL لم يؤكده مستهلكها بعد. فإذا تعطل Debezium وبقيت الفتحة، يتراكم WAL بلا حد — وانقطاع طويل على نظام مزدحم قد يحتفظ بمئات الغيغابايتات. فراقب تأخر الفتحة (pg_replication_slots: confirmed_flush_lsn / restart_lsn)، ونبّه مبكرًا (مثلًا 100MB)، واضبط max_slot_wal_keep_size كحد أمان، واعتبر حذف الفتحة قرارًا متعمدًا، لأنه يفرض لقطة جديدة."
    },
    {
      "text": "موصّل Debezium مُعدّ مع REPLICA IDENTITY DEFAULT على جدول accounts. حين يُنشر UPDATE للرصيد، ماذا يحتوي حقل 'before' في حدث Debezium؟",
      "options": [
        "الحالة السابقة الكاملة لكل الأعمدة بما فيها الرصيد القديم",
        "عمود (أو أعمدة) المفتاح الأساسي للصف المحدَّث فقط",
        "لا شيء — REPLICA IDENTITY DEFAULT يلتقط القيم الجديدة فقط، لا القديمة",
        "حقل الرصيد القديم فقط، لأنه العمود المعدَّل"
      ],
      "correct": 1,
      "explanation": "يضع REPLICA IDENTITY DEFAULT ‏(الافتراضي في PostgreSQL) المفتاح الأساسي فقط في صورة 'before' لأحداث UPDATE وDELETE. فلا يستطيع المستهلكون رؤية الرصيد القديم — بل أي صف تغير فقط. وللحصول على صورة before كاملة (الرصيد القديم، والحالة القديمة، إلخ)، اضبط REPLICA IDENTITY FULL ‏(كل الأعمدة، مقابل WAL إضافي). ويعطي REPLICA IDENTITY USING INDEX أعمدة الفهرس الفريد المختار فقط. وصورة before الكاملة مهمة للأنظمة اللاحقة التي تدقق التغييرات أو تحسب الفروق."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ نمط Outbox مع Debezium",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "نفّذ نمط Outbox الكامل لخدمة تسوية مدفوعات. أنشئ جدول outbox_events بالفهارس المناسبة. واكتب دالة TransactionService.settlePayment() التي تسجل التسوية وOutboxEvent ذريًا في دالة @Transactional واحدة. وضمّن إعداد JSON لموصّل Debezium مع محوّل Outbox Event Router الذي يوجّه الأحداث إلى موضوع Kafka الصحيح حسب aggregate_type."},
    {"id": "2", "description": "اكتب اختبار تكامل بـ Testcontainers باستخدام Kafka مضمّن وحاوية PostgreSQL مُعدّة بـ wal_level=logical. ويجب أن يقوم الاختبار بما يلي: (1) تشغيل تسوية دفعة، (2) التحقق من كتابة صف outbox_events، (3) محاكاة Debezium بقراءة فتحة نسخ WAL مباشرة، (4) التحقق من إنتاج رسالة Kafka الصحيحة ببنية الحمولة المتوقعة مع aggregate_id كمفتاح الرسالة."},
    {"id": "3", "description": "ابنِ خدمة مراقبة لفتحات النسخ تستعلم pg_replication_slots كل 60 ثانية، وتسجل lag_bytes كمقياس Micrometer من نوع Gauge، وتسجل تحذيرًا حين يتجاوز التأخر 100MB، وتطلق تنبيه PagerDuty حين يتجاوز 500MB. وضمّن آلية أمان تسجل تنبيهًا حرجًا (لكنها لا تحذف الفتحة تلقائيًا) حين يتجاوز التأخر 1GB، وتتطلب تأكيدًا بشريًا قبل الحذف."},
    {"id": "4", "description": "صمم ووثّق إجراء الاستجابة لحادث موصّل Debezium معطّل منذ 6 ساعات مع تراكم 2GB من WAL. ويجب أن يعالج الإجراء: كيف تقيّم إعادة التشغيل بالفتحة القائمة (الخطر: إعادة معالجة 6 ساعات من الأحداث) مقابل الحذف وأخذ لقطة جديدة (الخطر: إعادة معالجة كل البيانات التاريخية)، وكيف تتعامل مع الأحداث المكررة في المستهلكين اللاحقين أثناء إعادة التشغيل، وكيف تتحقق من اتساق الأنظمة اللاحقة بعد التعافي."}
  ]
}
-->
