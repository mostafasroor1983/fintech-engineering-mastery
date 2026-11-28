---
id: track-09-lesson-07
title: "Schema Registry — Avro, Protobuf, and Schema Evolution"
slug: schema-registry
track: track-09
trackName: "Kafka & Event-Driven Architecture"
sequence: 7
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [schema-registry, Avro, Protobuf, schema-evolution, compatibility]
prerequisites: ["track-09-lesson-01", "track-09-lesson-02", "track-09-lesson-03"]
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
            "doc": "Payment amount with 2 decimal places (exact decimal -- never float/double for money; currencies with 0 or 3 minor digits need their own scale, or use integer minor units)"
        },
        {
            "name": "currency",
            "type": {
                "type": "enum",
                "name": "Currency",
                "symbols": ["GBP", "USD", "EUR", "JPY"]
            },
            "doc": "ISO 4217 currency code. Careful: adding a symbol later breaks old readers unless the enum declares a default symbol (Avro 1.9+) -- a plain string is often the safer choice for currencies"
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
                <!-- generate BigDecimal (not ByteBuffer) for decimal logical types -->
                <enableDecimalLogicalType>true</enableDecimalLogicalType>
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
Old producers write:                   New consumer reads:
  { paymentId, accountId, amountMinor }  { paymentId, accountId, amountMinor, [referenceId=null] }
```

**Rule:** You may add fields **with** default values and delete fields (the new reader simply ignores them). Upgrade **consumers first**, then producers.

```jsonc
// V1 — Original schema
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amountMinor", "type": "long"}
    ]
}

// V2 — BACKWARD compatible: added optional field with default
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amountMinor", "type": "long"},
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

**Rule:** You may add fields (old readers skip unknown fields, so no default is needed) and delete only fields that **have** a default in the old schema (old readers fill them in). Upgrade **producers first**, then consumers.

```jsonc
// V2 — FORWARD compatible: old consumer reads V2 data, ignores new field
{
    "name": "PaymentCreated",
    "fields": [
        {"name": "paymentId", "type": "string"},
        {"name": "accountId", "type": "string"},
        {"name": "amountMinor", "type": "long"},
        {"name": "region", "type": "string"}  // No default — old consumers skip it
    ]
}
```

### FULL Compatibility

Both BACKWARD and FORWARD. The safest option for financial systems: you may only add or delete fields that have default values, and producers and consumers can be upgraded in any order.

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

```jsonc
// V1
{"name": "paymentId", "type": "string"},
{"name": "amountMinor", "type": "long"}

// V2 — BACKWARD and FORWARD compatible
{"name": "paymentId", "type": "string"},
{"name": "amountMinor", "type": "long"},
{"name": "merchantId", "type": ["null", "string"], "default": null}
```

Old consumers reading V2 data: they know `merchantId` is optional, skip it.
New consumers reading V1 data: `merchantId` is null (default applied).

### Safe: Widening a Union Type

```jsonc
// V1
{"name": "region", "type": "string"}

// V2 — BACKWARD compatible
{"name": "region", "type": ["string", "null"], "default": "UNKNOWN"}
```

### Breaking for Old Consumers: Removing a Field Without a Default

```jsonc
// V1
{"name": "paymentId", "type": "string"},
{"name": "accountId", "type": "string"},
{"name": "amountMinor", "type": "long"}

// V2 — BREAKING: removed "accountId"
{"name": "paymentId", "type": "string"},
{"name": "amountMinor", "type": "long"}
// Old consumers (still on V1) need accountId and have no default for it
// -> they fail. FORWARD/FULL reject this change; BACKWARD accepts it, which
// is only safe if ALL consumers were upgraded before the producers
```

### Breaking: Renaming a Field

```jsonc
// V1
{"name": "accountId", "type": "string"}

// V2 — BREAKING: renamed to "sourceAccountId"
// Old consumers look for "accountId" — it's gone, they get null/error
{"name": "sourceAccountId", "type": "string"}
```

Avro readers can declare `"aliases": ["accountId"]` on the new field, so a NEW reader can still read OLD data — but an old reader cannot find the new name in new data.

**Rename strategy:** Add the new field (with default), deprecate the old field, migrate consumers, then remove the old field across two separate schema versions.

---

## Protobuf Schema Evolution Advantages

Protocol Buffers offer better evolution semantics than Avro because they use **field numbers** rather than field names. Renaming a field is safe as long as the number stays the same.

```protobuf
// payment_created.proto  (V1 and V2 shown together for comparison --
// they are two versions of the same file, not one file)
syntax = "proto3";

package com.fintech.payments.proto;

message PaymentCreated {
    string payment_id = 1;        // Field number 1 — never change this
    string account_id = 2;         // Field number 2
    int64 amount_minor = 3;        // Field number 3 (minor units, never double)
    string currency = 4;
    int64 created_at_millis = 5;

    // Safe to rename account_id to source_account_id as long as field number 2 is preserved
    // Old consumers: wire format unchanged (still field 2), just the name changed
}

// V2 — added field — backward and forward safe
message PaymentCreated {
    string payment_id = 1;
    string account_id = 2;
    int64 amount_minor = 3;
    string currency = 4;
    int64 created_at_millis = 5;
    string merchant_id = 6;         // New field — old consumers ignore field 6
    string reference_id = 7;        // Another new field
}
```

**Protobuf evolution rules:**
- Never reuse a field number (even for deleted fields — use `reserved`)
- Never change a field's type
- Renaming is safe for the binary wire format — field numbers are what matters there (but not for the JSON mapping of Protobuf, which uses names)

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

The schema is registered under its fully-qualified class name. Multiple event types can be published to the same topic without conflict — useful for event-sourcing topics that carry several event types of one aggregate (`TopicRecordNameStrategy` below works too; another option is a union schema with schema references under the default strategy).

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
```

```xml
<!-- Maven plugin configuration (pom.xml) -->
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
- **BACKWARD** compatibility (the default): new consumers can read data written with the old schema — add fields only with defaults; upgrade consumers first.
- **FORWARD** compatibility: old consumers can read data written with the new schema — they skip unknown fields; upgrade producers first.
- **FULL** compatibility requires both — the safest choice for financial production systems.
- **Renaming a field breaks old Avro consumers** (aliases only help new readers) — use the add-then-remove migration pattern.
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
        "New fields must have default values; fields may be deleted (the new reader simply ignores them) — so consumers are upgraded first",
        "The schema must be identical to the previous version",
        "Only field types can be changed; field names and counts must stay the same"
      ],
      "correct": 1,
      "explanation": "BACKWARD compatibility means new consumers can read data written with the old schema. Any new field needs a default value (old data does not contain it), while deleting a field is allowed because the new reader just ignores it. Because old consumers are not protected, consumers are upgraded before producers."
    },
    {
      "text": "Why does renaming a field break old Avro consumers but not old Protobuf consumers?",
      "options": [
        "Avro uses field indexes while Protobuf uses field names on the wire",
        "Avro uses field names on the wire for matching; Protobuf uses field numbers",
        "Protobuf automatically creates aliases for renamed fields",
        "Avro does not support optional fields while Protobuf does"
      ],
      "correct": 1,
      "explanation": "Avro resolves fields by NAME when reading. After a rename, an old reader looks for the old name and does not find it (a new reader can declare an alias for the old name, but old readers have no such alias). Protobuf identifies fields by NUMBER on the wire — the name only appears in generated code — so renaming is safe for the binary format as long as the number stays the same."
    },
    {
      "text": "Which subject naming strategy lets multiple event types share one Kafka topic by registering each schema under its fully-qualified record name?",
      "options": [
        "TopicNameStrategy — it handles multiple types by default",
        "TopicRecordNameStrategy only",
        "RecordNameStrategy — registers schemas under the fully-qualified class name",
        "DefaultNamingStrategy — no configuration needed"
      ],
      "correct": 2,
      "explanation": "TopicNameStrategy registers one subject per topic (topic-value), so all messages on the topic must be compatible versions of one schema. RecordNameStrategy registers schemas under the fully-qualified record name, allowing several event types on one topic. (TopicRecordNameStrategy also allows it, scoping the subject per topic; unions with schema references are another option.)"
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
