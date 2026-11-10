---
id: track-11-lesson-07
title: "Schema Registry — Avro, Protobuf, and Schema Evolution"
slug: schema-registry
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 7
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [schema-registry, Avro, Protobuf, schema-evolution, compatibility]
prerequisites: [kafka-architecture, kafka-producer, kafka-consumer]
---

# Schema Registry — Avro, Protobuf, and Schema Evolution

> [!NOTE]
> Schemas are contracts. In financial systems where multiple teams produce and consume payment events, a schema change that silently breaks a downstream consumer can halt settlement, trigger double-reconciliation, or corrupt compliance records. Schema Registry is the enforcement layer that makes schema evolution safe, versioned, and auditable.

## Why Schema Registry Exists

Without Schema Registry, Kafka messages are opaque bytes. Teams use ad-hoc serialisation (JSON strings, custom binary formats) and rely on coordination and documentation to manage changes. This fails in practice:

- A developer adds a required field to a payment event
- Existing consumers expect the old schema — they fail to deserialise
- The settlement service crashes silently, processing no payments
- By the time monitoring alerts, millions in settlements are delayed

Schema Registry solves this by:
1. **Registering** schemas with version numbers
2. **Enforcing compatibility** rules before schema changes are accepted
3. **Embedding** the schema ID in every message — consumers always know which schema to use
4. **Providing a central contract** that all producers and consumers reference

---

## Confluent Schema Registry Architecture

```
Producer                    Schema Registry           Consumer
   │                               │                     │
   │── register schema ──────────►│                     │
   │◄── schema_id=42 ─────────────│                     │
   │                               │                     │
   │── produce(msg with id=42) ──────────────────────►  │
   │                               │                     │
   │                               │◄── fetch schema 42 ─│
   │                               │── return schema ──► │
   │                               │                     │── deserialise ──►
```

Message format on the wire:
```
Byte 0:   Magic byte (0x00) — indicates Confluent format
Bytes 1-4: Schema ID (int32) — 4-byte big-endian integer
Bytes 5+:  Serialised payload (Avro/Protobuf/JSON Schema)
```

This magic byte + schema ID prefix is the key insight: every message carries a pointer to its schema. Consumers always deserialise correctly even as schemas evolve.

---

## Avro Schema Definition

Apache Avro is the most common format for Kafka in financial services. It provides compact binary serialisation, rich schema evolution support, and a human-readable JSON schema format.

### Defining a Payment Event Schema

```json
{
    "namespace": "com.fintech.payments.avro",
    "type": "record",
    "name": "PaymentCreated",
    "doc": "Event published when a new payment is created",
    "fields": [
        {
            "name": "paymentId",
            "type": "string",
            "doc": "Unique identifier for the payment (UUID format)"
        },
        {
            "name": "accountId",
            "type": "string",
            "doc": "Source account identifier"
        },
        {
            "name": "destinationAccountId",
            "type": "string",
            "doc": "Destination account identifier"
        },
        {
            "name": "amount",
            "type": {
                "type": "bytes",
                "logicalType": "decimal",
                "precision": 18,
                "scale": 2
            },
            "doc": "Payment amount with 2 decimal places"
        },
        {
            "name": "currency",
            "type": {
                "type": "enum",
                "name": "Currency",
                "symbols": ["GBP", "USD", "EUR", "JPY"]
            },
            "doc": "ISO 4217 currency code"
        },
        {
            "name": "status",
            "type": {
                "type": "enum",
                "name": "PaymentStatus",
                "symbols": ["PENDING", "APPROVED", "REJECTED", "SETTLED"]
            }
        },
        {
            "name": "createdAt",
            "type": {
                "type": "long",
                "logicalType": "timestamp-millis"
            },
            "doc": "Event creation time in milliseconds since epoch"
        },
        {
            "name": "metadata",
            "type": {
                "type": "map",
                "values": "string"
            },
            "default": {},
            "doc": "Optional key-value metadata (e.g., channel, region)"
        }
    ]
}
```

### Avro Java Code Generation

Using the Avro Maven plugin to generate Java classes from `.avsc` files:

```xml
<!-- pom.xml -->
<plugin>
    <groupId>org.apache.avro</groupId>
    <artifactId>avro-maven-plugin</artifactId>
    <version>1.11.3</version>
    <executions>
        <execution>
            <phase>generate-sources</phase>
            <goals><goal>schema</goal></goals>
            <configuration>
                <sourceDirectory>${project.basedir}/src/main/avro</sourceDirectory>
                <outputDirectory>${project.build.directory}/generated-sources/avro</outputDirectory>
            </configuration>
        </execution>
    </executions>
</plugin>
```

---

## Schema Compatibility Modes

The compatibility mode is configured per **subject** (a schema identity in the registry). Choose carefully — it determines what schema changes are allowed.

### BACKWARD Compatibility (Default — Recommended)

New schema can be used to read data written with the previous schema.

```
Old producers write:              New consumer reads:
  { paymentId, accountId, amount }  { paymentId, accountId, amount, [referenceId=null] }
```

**Rule:** New fields must have default values. Old fields cannot be removed.

```json
// V1 — Original schema
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amount", "type": "double"}
    ]
}

// V2 — BACKWARD compatible: added optional field with default
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amount", "type": "double"},
        {
            "name": "referenceId",
            "type": ["null", "string"],
            "default": null,
            "doc": "Optional payment reference (e.g., bank reference)"
        }
    ]
}
```

### FORWARD Compatibility

Old consumers can read data written with the new schema.

**Rule:** New fields may have no default (old consumers skip unknown fields). Old fields must keep their defaults.

```json
// V2 — FORWARD compatible: old consumer reads V2 data, ignores new field
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amount", "type": "double"},
        {"name": "region", "type": "string"}  // No default — old consumers skip it
    ]
}
```

### FULL Compatibility

Both BACKWARD and FORWARD. The safest option for financial systems. Only allows adding optional fields with defaults. Field removal and renaming are both prohibited.

### NONE

No compatibility checks. Use only during initial development or when you control all producers and consumers and deploy them simultaneously. Never use in production financial systems.

**Recommended strategy for financial services:**

```
Default: FULL_TRANSITIVE
  - All versions must be compatible with ALL previous versions
  - Not just the last version
  - Use BACKWARD if FULL is too restrictive for your use case
```

---

## Schema Evolution Examples

### Safe: Adding an Optional Field

```json
// V1
{"name": "paymentId", "type": "string"},
{"name": "amount", "type": "double"}

// V2 — BACKWARD and FORWARD compatible
{"name": "paymentId", "type": "string"},
{"name": "amount", "type": "double"},
{"name": "merchantId", "type": ["null", "string"], "default": null}
```

Old consumers reading V2 data: they know `merchantId` is optional, skip it.
New consumers reading V1 data: `merchantId` is null (default applied).

### Safe: Widening a Union Type

```json
// V1
{"name": "region", "type": "string"}

// V2 — BACKWARD compatible
{"name": "region", "type": ["string", "null"], "default": "UNKNOWN"}
```

### Breaking: Removing a Required Field

```json
// V1
{"name": "paymentId", "type": "string"},
{"name": "accountId", "type": "string"},
{"name": "amount", "type": "double"}

// V2 — BREAKING: removed "accountId"
{"name": "paymentId", "type": "string"},
{"name": "amount", "type": "double"}
// Old consumers expect accountId — they will fail or receive null
```

### Breaking: Renaming a Field

```json
// V1
{"name": "accountId", "type": "string"}

// V2 — BREAKING: renamed to "sourceAccountId"
// Old consumers look for "accountId" — it's gone, they get null/error
{"name": "sourceAccountId", "type": "string"}
```

**Rename strategy:** Add the new field (with default), deprecate the old field, migrate consumers, then remove the old field across two separate schema versions.

---

## Protobuf Schema Evolution Advantages

Protocol Buffers offer better evolution semantics than Avro because they use **field numbers** rather than field names. Renaming a field is safe as long as the number stays the same.

```protobuf
// payment_created.proto
syntax = "proto3";

package com.fintech.payments.proto;

message PaymentCreated {
    string payment_id = 1;        // Field number 1 — never change this
    string account_id = 2;         // Field number 2
    double amount = 3;             // Field number 3
    string currency = 4;
    int64 created_at_millis = 5;

    // Safe to rename account_id to source_account_id as long as field number 2 is preserved
    // Old consumers: wire format unchanged (still field 2), just the name changed
}

// V2 — added field — backward and forward safe
message PaymentCreated {
    string payment_id = 1;
    string account_id = 2;
    double amount = 3;
    string currency = 4;
    int64 created_at_millis = 5;
    string merchant_id = 6;         // New field — old consumers ignore field 6
    string reference_id = 7;        // Another new field
}
```

**Protobuf evolution rules:**
- Never reuse a field number (even for deleted fields — use `reserved`)
- Never change a field's type
- Renaming is safe — field numbers are what matters on the wire

```protobuf
message PaymentCreated {
    reserved 8, 9;                  // Reserved for deleted fields
    reserved "old_field_name";      // Reserved field names (optional)
    string payment_id = 1;
    // ...
}
```

---

## Subject Naming Strategies

A **subject** is the name under which a schema is registered in Schema Registry. The strategy determines how subjects are named.

### TopicNameStrategy (Default)

```
Topic: payments.events
Subject for key schema:   payments.events-key
Subject for value schema: payments.events-value
```

All producers to `payments.events` must use the same schema version. Good for homogeneous topics (one event type per topic).

### RecordNameStrategy

```
Schema class: com.fintech.payments.avro.PaymentCreated
Subject: com.fintech.payments.avro.PaymentCreated
```

The schema is registered under its fully-qualified class name. Multiple event types can be published to the same topic without conflict. Required for event-sourcing patterns where a single topic contains heterogeneous events.

```java
// Producer configuration for RecordNameStrategy
props.put("value.subject.name.strategy",
        "io.confluent.kafka.serializers.subject.RecordNameStrategy");
```

### TopicRecordNameStrategy

Combines topic name and record name:
```
Subject: payments.events-com.fintech.payments.avro.PaymentCreated
```

Allows different schema evolution per topic per record type.

---

## Spring Kafka Avro Serialiser/Deserialiser

```xml
<!-- pom.xml -->
<dependency>
    <groupId>io.confluent</groupId>
    <artifactId>kafka-avro-serializer</artifactId>
    <version>7.6.0</version>
</dependency>
```

### Producer Configuration

```java
import io.confluent.kafka.serializers.KafkaAvroSerializer;
import io.confluent.kafka.serializers.AbstractKafkaSchemaSerDeConfig;
import com.fintech.payments.avro.PaymentCreated;

@Configuration
public class AvroProducerConfig {

    @Bean
    public ProducerFactory<String, PaymentCreated> paymentProducerFactory() {
        Map<String, Object> config = new HashMap<>();
        config.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        config.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        config.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, KafkaAvroSerializer.class);
        config.put(AbstractKafkaSchemaSerDeConfig.SCHEMA_REGISTRY_URL_CONFIG,
                "http://schema-registry:8081");
        // Auto-register schemas in dev, disable in production
        config.put(AbstractKafkaSchemaSerDeConfig.AUTO_REGISTER_SCHEMAS, false);
        return new DefaultKafkaProducerFactory<>(config);
    }

    @Bean
    public KafkaTemplate<String, PaymentCreated> paymentKafkaTemplate() {
        return new KafkaTemplate<>(paymentProducerFactory());
    }
}

@Service
public class PaymentEventPublisher {

    @Autowired
    private KafkaTemplate<String, PaymentCreated> kafkaTemplate;

    public void publishPaymentCreated(Payment payment) {
        PaymentCreated event = PaymentCreated.newBuilder()
                .setPaymentId(payment.getId())
                .setAccountId(payment.getAccountId())
                .setDestinationAccountId(payment.getDestinationAccountId())
                .setAmount(payment.getAmount())
                .setCurrency(Currency.valueOf(payment.getCurrency()))
                .setStatus(PaymentStatus.PENDING)
                .setCreatedAt(System.currentTimeMillis())
                .build();

        kafkaTemplate.send("payments.events", payment.getId(), event);
        log.info("Published PaymentCreated event for payment {}", payment.getId());
    }
}
```

### Consumer Configuration

```java
import io.confluent.kafka.serializers.KafkaAvroDeserializer;
import io.confluent.kafka.serializers.KafkaAvroDeserializerConfig;

@Configuration
public class AvroConsumerConfig {

    @Bean
    public ConsumerFactory<String, PaymentCreated> paymentConsumerFactory() {
        Map<String, Object> config = new HashMap<>();
        config.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
        config.put(ConsumerConfig.GROUP_ID_CONFIG, "settlement-service");
        config.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        config.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, KafkaAvroDeserializer.class);
        config.put(AbstractKafkaSchemaSerDeConfig.SCHEMA_REGISTRY_URL_CONFIG,
                "http://schema-registry:8081");
        // Use specific Avro type (generated class) rather than GenericRecord
        config.put(KafkaAvroDeserializerConfig.SPECIFIC_AVRO_READER_CONFIG, true);
        return new DefaultKafkaConsumerFactory<>(config);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, PaymentCreated>
            paymentListenerFactory() {
        ConcurrentKafkaListenerContainerFactory<String, PaymentCreated> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(paymentConsumerFactory());
        return factory;
    }
}

@Service
public class PaymentSettlementConsumer {

    @KafkaListener(
        topics = "payments.events",
        groupId = "settlement-service",
        containerFactory = "paymentListenerFactory"
    )
    public void handlePaymentCreated(PaymentCreated event) {
        log.info("Received PaymentCreated: paymentId={}, amount={}, currency={}",
                event.getPaymentId(), event.getAmount(), event.getCurrency());

        settlementService.processSettlement(
                event.getPaymentId(),
                event.getAmount(),
                event.getCurrency().toString()
        );
    }
}
```

---

## Schema Registry REST API

Schema Registry exposes a REST API for schema management. Useful for CI/CD schema validation:

```bash
# Register a schema
curl -X POST http://schema-registry:8081/subjects/payments.events-value/versions \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "{\"type\":\"record\",\"name\":\"PaymentCreated\",...}"}'

# Check compatibility before registering
curl -X POST http://schema-registry:8081/compatibility/subjects/payments.events-value/versions/latest \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "..."}'

# List all versions
curl http://schema-registry:8081/subjects/payments.events-value/versions

# Get schema by version
curl http://schema-registry:8081/subjects/payments.events-value/versions/2

# Set compatibility mode per subject
curl -X PUT http://schema-registry:8081/config/payments.events-value \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"compatibility": "FULL"}'
```

### CI/CD Schema Compatibility Check

```yaml
# .github/workflows/schema-check.yml
- name: Check schema compatibility
  run: |
    mvn schema-registry:test-compatibility \
      -Dschema.registry.url=http://schema-registry:8081

# Maven plugin configuration (pom.xml)
<plugin>
    <groupId>io.confluent</groupId>
    <artifactId>kafka-schema-registry-maven-plugin</artifactId>
    <version>7.6.0</version>
    <configuration>
        <schemaRegistryUrls>
            <param>http://schema-registry:8081</param>
        </schemaRegistryUrls>
        <subjects>
            <payments.events-value>
                src/main/avro/payment_created.avsc
            </payments.events-value>
        </subjects>
    </configuration>
</plugin>
```

---

## Key Takeaways

- Schema Registry stores versioned schemas and enforces compatibility rules before publishing new versions.
- Every Kafka message contains a 4-byte schema ID, allowing consumers to always deserialise correctly.
- **BACKWARD** compatibility (the default) requires new fields to have default values — old consumers can read new data.
- **FORWARD** compatibility allows consumers to skip unknown fields — new consumers can read old data.
- **FULL** compatibility requires both — the safest choice for financial production systems.
- **Renaming fields is always a breaking change in Avro** — use the add-then-remove migration pattern.
- Protobuf handles field renaming safely because the wire format uses field numbers, not names.
- `RecordNameStrategy` is required for heterogeneous topics (multiple event types on one topic).
- Disable `AUTO_REGISTER_SCHEMAS` in production — schemas must be reviewed and registered via CI/CD.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What does BACKWARD compatibility mode require for Avro schema evolution?",
      "options": [
        "New fields can be added without defaults; old fields can be removed freely",
        "New fields must have default values; old fields cannot be removed",
        "The schema must be identical to the previous version",
        "Only field types can be changed; field names and counts must stay the same"
      ],
      "correct": 1,
      "explanation": "BACKWARD compatibility means new consumers can read data written with the old schema. This requires that any new field has a default value (so old data missing the field can be read) and that existing required fields are not removed."
    },
    {
      "text": "Why is renaming a field always a breaking change in Avro but safe in Protobuf?",
      "options": [
        "Avro uses field indexes while Protobuf uses field names on the wire",
        "Avro uses field names on the wire for matching; Protobuf uses field numbers",
        "Protobuf automatically creates aliases for renamed fields",
        "Avro does not support optional fields while Protobuf does"
      ],
      "correct": 1,
      "explanation": "Avro serializes and deserializes by matching field names. Renaming a field breaks all consumers looking for the old name. Protobuf uses field numbers on the wire — the field name is only used in generated code, so renaming is safe as long as the number stays the same."
    },
    {
      "text": "Which subject naming strategy is required when multiple event types are published to the same Kafka topic?",
      "options": [
        "TopicNameStrategy — it handles multiple types by default",
        "TopicRecordNameStrategy only",
        "RecordNameStrategy — registers schemas under the fully-qualified class name",
        "DefaultNamingStrategy — no configuration needed"
      ],
      "correct": 2,
      "explanation": "TopicNameStrategy registers a single schema per topic and enforces that all messages on a topic use the same schema. RecordNameStrategy registers schemas under the fully-qualified class name, allowing multiple different event types on the same topic without conflict."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Schema-Governed Payment Events with Avro",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Define an Avro schema (payment_created.avsc) for a PaymentCreated event with fields for paymentId, accountId, amount (decimal logical type), currency (enum), status (enum), and createdAt (timestamp-millis). Register the schema under the subject 'payments.events-value' with FULL compatibility mode."},
    {"id": "2", "description": "Configure a Spring Boot Kafka producer using KafkaAvroSerializer with AUTO_REGISTER_SCHEMAS=false and RecordNameStrategy. Implement a PaymentEventPublisher that generates Avro PaymentCreated records using the generated Java class and publishes them to 'payments.events'."},
    {"id": "3", "description": "Evolve the schema by adding an optional 'merchantId' field (union of null and string with null default) and verify FULL compatibility using the Schema Registry REST API before registering. Update the producer to populate the new field."},
    {"id": "4", "description": "Add a CI/CD schema compatibility check using the kafka-schema-registry-maven-plugin that blocks merges to main if the proposed schema change is not FULL compatible with the registered version."}
  ]
}
-->
