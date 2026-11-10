---
id: track-11-lesson-08
title: "Kafka Connect — Source and Sink Connector Architecture"
slug: kafka-connect
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 8
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Kafka-Connect, source-connector, sink-connector, SMT, worker]
prerequisites: [kafka-architecture, outbox-cdc-debezium]
---

# Kafka Connect — Source and Sink Connector Architecture

> [!NOTE]
> Kafka Connect is the integration layer of the Kafka ecosystem. Rather than writing custom producer/consumer code for every data source and sink, Connect provides a framework with proven, production-tested connectors for databases, object stores, search engines, and more. For financial systems, it handles the operational complexity of database polling, WAL reading, offset management, and retry logic — so your engineers focus on business logic.

## What Kafka Connect Is

Kafka Connect is a framework for building and running connectors — components that copy data between Kafka and external systems. It handles:

- **Offset management** — tracking what has been consumed/produced
- **Worker distribution** — distributing connector tasks across worker nodes
- **REST API** — managing connector lifecycle
- **Error handling** — retries, dead letter topics, and error reporting
- **Transforms** — Single Message Transforms for lightweight message manipulation

```
External Systems             Kafka Connect              Kafka
                           ┌──────────────────┐
PostgreSQL ──(JDBC Source)─┤                  ├──► payments.db.events
                           │  Kafka Connect   │
Kafka ──────(S3 Sink)──────┤  Worker Cluster  ├──► S3 Bucket (archival)
                           │                  │
Kafka ──────(ES Sink)──────┤                  ├──► Elasticsearch (search)
                           └──────────────────┘
```

---

## Distributed Mode Architecture

In production, Kafka Connect runs in **distributed mode** — multiple worker instances that share the work of running connectors.

```
Worker 1                    Worker 2                    Worker 3
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│ Connector A     │         │ Connector A     │         │ Connector B     │
│   Task 0        │         │   Task 1        │         │   Task 0        │
│   Task 2        │         │                 │         │   Task 1        │
│                 │         │ Connector B     │         │                 │
│ Connector C     │         │   Task 2        │         │                 │
│   Task 0        │         │                 │         │                 │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                           │                            │
         └───────────── Kafka (config, offset, status topics) ───┘
```

Workers use three internal Kafka topics for coordination:
- `connect-configs` — connector and task configurations
- `connect-offsets` — source connector read offsets
- `connect-status` — connector and task status

```properties
# Worker configuration (connect-distributed.properties)
bootstrap.servers=kafka:9092
group.id=connect-cluster

config.storage.topic=connect-configs
offset.storage.topic=connect-offsets
status.storage.topic=connect-status

config.storage.replication.factor=3
offset.storage.replication.factor=3
status.storage.replication.factor=3

key.converter=org.apache.kafka.connect.json.JsonConverter
value.converter=org.apache.kafka.connect.json.JsonConverter
key.converter.schemas.enable=false
value.converter.schemas.enable=false

# For Avro with Schema Registry
# key.converter=io.confluent.connect.avro.AvroConverter
# value.converter=io.confluent.connect.avro.AvroConverter
# value.converter.schema.registry.url=http://schema-registry:8081
```

---

## JDBC Source Connector (Database Polling)

The JDBC Source Connector polls a database table or query on a schedule, publishing new/changed rows as Kafka messages.

```json
{
    "name": "payments-jdbc-source",
    "config": {
        "connector.class": "io.confluent.connect.jdbc.JdbcSourceConnector",
        "connection.url": "jdbc:postgresql://postgres:5432/payments_db",
        "connection.user": "kafka_connect_user",
        "connection.password": "secret",

        "mode": "timestamp+incrementing",
        "timestamp.column.name": "updated_at",
        "incrementing.column.name": "id",
        "table.whitelist": "payments",

        "topic.prefix": "jdbc.",
        "poll.interval.ms": "5000",
        "batch.max.rows": "1000",

        "transforms": "createKey,extractKey",
        "transforms.createKey.type": "org.apache.kafka.connect.transforms.ValueToKey",
        "transforms.createKey.fields": "id",
        "transforms.extractKey.type": "org.apache.kafka.connect.transforms.ExtractField$Key",
        "transforms.extractKey.field": "id"
    }
}
```

**Polling modes:**

| Mode | Description | Use Case |
|------|-------------|----------|
| `incrementing` | Uses auto-increment column | Append-only tables |
| `timestamp` | Uses last-modified timestamp | Tables with updates |
| `timestamp+incrementing` | Both — most robust | General purpose |
| `bulk` | Full table on every poll | Small reference tables |

**Limitation vs CDC:** JDBC polling misses deletes, has higher latency, and adds DB load. Use Debezium CDC (Lesson 06) when possible. Use JDBC when CDC is not available (e.g., managed databases without WAL access).

---

## S3 Sink Connector (Archival)

The S3 Sink Connector reads from Kafka topics and writes to Amazon S3, enabling long-term storage and data lake integration.

```json
{
    "name": "payments-s3-sink",
    "config": {
        "connector.class": "io.confluent.connect.s3.S3SinkConnector",
        "tasks.max": "4",
        "topics": "payments.events,payments.audit",

        "s3.region": "eu-west-1",
        "s3.bucket.name": "fintech-payments-archive",
        "s3.part.size": "67108864",

        "storage.class": "io.confluent.connect.s3.storage.S3Storage",
        "format.class": "io.confluent.connect.s3.format.parquet.ParquetFormat",

        "flush.size": "50000",
        "rotate.interval.ms": "3600000",
        "rotate.schedule.interval.ms": "3600000",

        "locale": "en_GB",
        "timezone": "UTC",
        "timestamp.extractor": "RecordField",
        "timestamp.field": "createdAt",

        "s3.ssea.name": "aws:kms",
        "s3.sse.kms.key.id": "arn:aws:kms:eu-west-1:123456789:key/abc-123",

        "partitioner.class": "io.confluent.connect.storage.partitioner.TimeBasedPartitioner",
        "path.format": "'year'=YYYY/'month'=MM/'day'=dd/'hour'=HH",

        "schema.compatibility": "FULL"
    }
}
```

This creates a partitioned Parquet data lake at:
```
s3://fintech-payments-archive/
  payments.events/
    year=2026/month=11/day=08/hour=14/
      payments.events+0+0000050000.parquet
      payments.events+1+0000050000.parquet
```

---

## Single Message Transforms (SMT)

SMTs are lightweight transformations applied to each message as it passes through a connector. They are chained and applied in order.

### Field Masking (PCI DSS Compliance)

Mask sensitive fields before they reach certain sinks:

```json
{
    "transforms": "maskCardNumber,maskCvv",
    "transforms.maskCardNumber.type":
        "org.apache.kafka.connect.transforms.MaskField$Value",
    "transforms.maskCardNumber.fields": "cardNumber",
    "transforms.maskCardNumber.replacement": "****-****-****-####",
    "transforms.maskCvv.type":
        "org.apache.kafka.connect.transforms.MaskField$Value",
    "transforms.maskCvv.fields": "cvv",
    "transforms.maskCvv.replacement": "***"
}
```

### Routing (Topic Selection)

Route messages to different topics based on field value:

```json
{
    "transforms": "routeByRegion",
    "transforms.routeByRegion.type":
        "org.apache.kafka.connect.transforms.RegexRouter",
    "transforms.routeByRegion.regex": "payments\\.(.+)",
    "transforms.routeByRegion.replacement": "payments-emea.$1"
}
```

### Filtering (Drop Unwanted Records)

```json
{
    "transforms": "filterSmallPayments",
    "transforms.filterSmallPayments.type":
        "io.confluent.connect.transforms.Filter$Value",
    "transforms.filterSmallPayments.filter.condition":
        "$[?(@.amount > 10000)]",
    "transforms.filterSmallPayments.filter.type": "include"
}
```

### Field Addition (Enrichment)

```json
{
    "transforms": "addTimestamp",
    "transforms.addTimestamp.type":
        "org.apache.kafka.connect.transforms.InsertField$Value",
    "transforms.addTimestamp.timestamp.field": "kafka_ingested_at"
}
```

### Custom SMT for Payment Processing

```java
import org.apache.kafka.common.config.ConfigDef;
import org.apache.kafka.connect.connector.ConnectRecord;
import org.apache.kafka.connect.transforms.Transformation;
import java.util.Map;

/**
 * Custom SMT that adds a data_classification field based on payment amount.
 * Used to route high-value payments to enhanced monitoring topics.
 */
public class PaymentClassificationSMT<R extends ConnectRecord<R>>
        implements Transformation<R> {

    private static final String AMOUNT_FIELD = "amount";
    private static final long HIGH_VALUE_THRESHOLD = 100_000_00L; // 100,000.00 in minor units

    @Override
    public R apply(R record) {
        if (record.value() == null) return record;

        Map<String, Object> value = (Map<String, Object>) record.value();
        Long amount = (Long) value.get(AMOUNT_FIELD);

        if (amount == null) return record;

        Map<String, Object> updatedValue = new HashMap<>(value);
        if (amount >= HIGH_VALUE_THRESHOLD) {
            updatedValue.put("data_classification", "HIGH_VALUE");
            updatedValue.put("enhanced_monitoring", true);
        } else {
            updatedValue.put("data_classification", "STANDARD");
            updatedValue.put("enhanced_monitoring", false);
        }

        return record.newRecord(
                record.topic(), record.kafkaPartition(),
                record.keySchema(), record.key(),
                record.valueSchema(), updatedValue,
                record.timestamp()
        );
    }

    @Override
    public ConfigDef config() {
        return new ConfigDef(); // No configuration needed
    }

    @Override
    public void configure(Map<String, ?> configs) {}

    @Override
    public void close() {}
}
```

---

## Connector Lifecycle (REST API)

Kafka Connect exposes a REST API for managing connectors. This is how operators and CI/CD pipelines interact with Connect.

```bash
# Create a connector
curl -X POST http://connect:8083/connectors \
  -H "Content-Type: application/json" \
  -d @payments-s3-sink.json

# List all connectors
curl http://connect:8083/connectors

# Get connector status
curl http://connect:8083/connectors/payments-s3-sink/status
# Response:
# {
#   "name": "payments-s3-sink",
#   "connector": {"state": "RUNNING", "worker_id": "worker-1:8083"},
#   "tasks": [
#     {"id": 0, "state": "RUNNING", "worker_id": "worker-1:8083"},
#     {"id": 1, "state": "FAILED", "worker_id": "worker-2:8083",
#      "trace": "org.apache.kafka.connect.errors.ConnectException: ..."}
#   ]
# }

# Pause a connector (stops consuming/producing, retains config)
curl -X PUT http://connect:8083/connectors/payments-s3-sink/pause

# Resume a paused connector
curl -X PUT http://connect:8083/connectors/payments-s3-sink/resume

# Restart a failed task
curl -X POST http://connect:8083/connectors/payments-s3-sink/tasks/1/restart

# Update connector configuration
curl -X PUT http://connect:8083/connectors/payments-s3-sink/config \
  -H "Content-Type: application/json" \
  -d '{"tasks.max": "8", ...}'

# Delete a connector
curl -X DELETE http://connect:8083/connectors/payments-s3-sink
```

### Connector Management via Spring

```java
import org.springframework.web.client.RestTemplate;
import org.springframework.stereotype.Service;
import java.util.Map;

@Service
public class KafkaConnectManager {

    private final RestTemplate restTemplate;
    private final String connectUrl = "http://connect:8083";

    public KafkaConnectManager(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public ConnectorStatus getStatus(String connectorName) {
        String url = connectUrl + "/connectors/" + connectorName + "/status";
        return restTemplate.getForObject(url, ConnectorStatus.class);
    }

    public void restartFailedTasks(String connectorName) {
        ConnectorStatus status = getStatus(connectorName);
        for (TaskStatus task : status.getTasks()) {
            if ("FAILED".equals(task.getState())) {
                String url = connectUrl + "/connectors/" + connectorName
                        + "/tasks/" + task.getId() + "/restart";
                restTemplate.postForObject(url, null, Void.class);
                log.info("Restarted failed task {} for connector {}",
                        task.getId(), connectorName);
            }
        }
    }
}
```

---

## Offset Management

For **source connectors**, Connect tracks the last-read position using the `connect-offsets` topic. The key is the source partition identifier; the value is the last-processed offset.

```
Key:   ["payments-jdbc-source", {"query": "", "table": "payments"}]
Value: {"incrementing": 1000247, "timestamp": 1699200000000}
```

This offset is committed after each batch of records is successfully sent to Kafka. If the connector crashes, it resumes from the last committed offset — at-least-once delivery.

For **sink connectors**, offsets are tracked via the standard Kafka consumer group mechanism (`connect-offsets` topic is not used).

---

## Error Handling and Dead Letter Topics

```json
{
    "errors.tolerance": "all",
    "errors.log.enable": true,
    "errors.log.include.messages": true,
    "errors.deadletterqueue.topic.name": "payments.connect.dlq",
    "errors.deadletterqueue.topic.replication.factor": 3,
    "errors.deadletterqueue.context.headers.enable": true
}
```

When `errors.tolerance=all`, failed records are routed to the DLQ instead of stopping the connector. The DLQ message headers contain error details:

```
Header: __connect.errors.topic = payments.events
Header: __connect.errors.partition = 2
Header: __connect.errors.offset = 44821
Header: __connect.errors.connector.name = payments-s3-sink
Header: __connect.errors.exception.class.name = org.apache.kafka.connect.errors.DataException
Header: __connect.errors.exception.message = Failed to convert value...
```

---

## Connector Monitoring

```java
// Spring Boot actuator endpoint for Connect health
@Component
public class KafkaConnectHealthIndicator implements HealthIndicator {

    @Autowired
    private KafkaConnectManager connectManager;

    private static final List<String> MONITORED_CONNECTORS = List.of(
            "payment-outbox-connector",
            "payments-s3-sink",
            "payments-jdbc-source"
    );

    @Override
    public Health health() {
        boolean allHealthy = true;
        Map<String, Object> details = new HashMap<>();

        for (String connector : MONITORED_CONNECTORS) {
            try {
                ConnectorStatus status = connectManager.getStatus(connector);
                boolean isRunning = "RUNNING".equals(status.getConnector().getState());
                long failedTasks = status.getTasks().stream()
                        .filter(t -> "FAILED".equals(t.getState()))
                        .count();

                details.put(connector, Map.of(
                        "state", status.getConnector().getState(),
                        "failedTasks", failedTasks
                ));

                if (!isRunning || failedTasks > 0) {
                    allHealthy = false;
                }
            } catch (Exception e) {
                details.put(connector, "UNREACHABLE");
                allHealthy = false;
            }
        }

        return allHealthy
                ? Health.up().withDetails(details).build()
                : Health.down().withDetails(details).build();
    }
}
```

---

## Key Takeaways

- Kafka Connect distributed mode runs connectors across multiple worker nodes, with Kafka topics used for coordination.
- **Source connectors** bring data into Kafka (JDBC polling, Debezium CDC); **sink connectors** write data from Kafka to external systems (S3, Elasticsearch, JDBC).
- JDBC Source Connector polls on a schedule — simpler than CDC but misses deletes and adds DB load.
- S3 Sink Connector creates partitioned Parquet data lakes for archival and analytics.
- **SMTs** are the right tool for field masking, routing, and lightweight transformation — complex logic belongs in Kafka Streams.
- The REST API manages the full connector lifecycle: create, pause, resume, restart failed tasks, delete.
- Error handling with `errors.tolerance=all` and dead letter topics prevents single bad records from stalling connectors.
- Monitor connector state and failed task counts — FAILED tasks stop processing silently until restarted.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the main limitation of the JDBC Source Connector compared to Debezium CDC?",
      "options": [
        "JDBC Source Connector does not support PostgreSQL",
        "JDBC Source Connector misses DELETE operations, adds DB query load, and has higher latency",
        "JDBC Source Connector cannot handle schema changes",
        "JDBC Source Connector only supports incrementing mode"
      ],
      "correct": 1,
      "explanation": "JDBC polling misses DELETE operations (they produce no UPDATE to detect), adds scheduled query load to the database, and has higher latency (poll interval) compared to Debezium which reads the WAL in near-real-time with minimal DB overhead."
    },
    {
      "text": "What are Single Message Transforms (SMTs) in Kafka Connect designed for?",
      "options": [
        "Complex stream processing logic like joins and aggregations",
        "Lightweight per-message transformations such as field masking, routing, and enrichment",
        "Schema validation and enforcement",
        "Consumer offset management"
      ],
      "correct": 1,
      "explanation": "SMTs are designed for lightweight, stateless per-message transformations — masking PII fields, routing to different topics, adding metadata fields. Complex stateful logic (joins, aggregations) belongs in Kafka Streams, not SMTs."
    },
    {
      "text": "How does Kafka Connect handle the offset state for source connectors across worker restarts?",
      "options": [
        "Offsets are stored in the connector's local filesystem",
        "Offsets are stored in a dedicated Kafka topic (connect-offsets) shared across all workers",
        "Offsets are stored in the external source system",
        "Offsets are re-computed from scratch on every restart"
      ],
      "correct": 1,
      "explanation": "In distributed mode, Kafka Connect stores source connector read offsets in the internal 'connect-offsets' Kafka topic. This allows any worker in the cluster to resume a connector from the correct position after a restart or rebalance."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Payment Data Pipeline with Kafka Connect",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Deploy a Kafka Connect cluster in distributed mode and configure the three internal coordination topics (connect-configs, connect-offsets, connect-status) with replication factor 3. Implement a KafkaConnectHealthIndicator Spring Boot health check that verifies all monitored connectors are RUNNING with zero failed tasks."},
    {"id": "2", "description": "Create an S3 Sink Connector configuration that archives 'payments.events' to an S3 bucket in Parquet format, partitioned by year/month/day/hour using the event's createdAt field, with KMS server-side encryption and 50,000 message flush size."},
    {"id": "3", "description": "Implement a custom SMT (PaymentClassificationSMT) that reads the amount field from each payment event and adds a 'data_classification' field ('HIGH_VALUE' for amounts >= 100,000 minor units, 'STANDARD' otherwise), plus an 'enhanced_monitoring' boolean flag."},
    {"id": "4", "description": "Configure the connector with errors.tolerance=all and a dead letter topic 'payments.connect.dlq' with context headers enabled. Implement automated task restart logic that detects FAILED tasks every 5 minutes and triggers restart via the Connect REST API."}
  ]
}
-->
