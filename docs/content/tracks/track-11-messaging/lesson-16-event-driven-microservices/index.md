---
id: track-11-lesson-16
title: "Event-Driven Microservices — Integration Patterns"
slug: event-driven-microservices
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 16
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [event-driven, microservices, event-mesh, choreography, decoupling]
prerequisites: [kafka-architecture, outbox-cdc-debezium, saga-pattern]
---

# Event-Driven Microservices — Integration Patterns

> [!NOTE]
> Event-driven integration is not just a technical pattern — it is an organisational pattern. Services that communicate via events can be deployed independently, owned by independent teams, and evolved without coordination. For a fintech processing hundreds of thousands of payments per day across dozens of microservices, this autonomy is the difference between a team that can deploy on Friday and one that cannot deploy without a production freeze.

## The Three Event-Driven Integration Patterns

Martin Fowler identifies three distinct patterns, each with different semantics:

### Pattern 1: Event Notification

The simplest pattern — a service publishes an event to notify other services that something happened. No data is included beyond the identifier.

```java
// Event Notification — minimal payload
public class PaymentCreatedNotification {
    private String paymentId;    // Just the ID — receivers must fetch data if needed
    private Instant occurredAt;
}

// Consumer must call back to get payment details
@KafkaListener(topics = "payments.notifications")
public void onPaymentCreated(PaymentCreatedNotification notification) {
    // Must make a synchronous call back to payment service
    Payment payment = paymentServiceClient.getPayment(notification.getPaymentId());
    processPayment(payment);
}
```

**Problem:** Creates a synchronous dependency. If the payment service is slow, all consumers are slow. This defeats the purpose of event-driven architecture.

### Pattern 2: Event-Carried State Transfer

Events carry all the data consumers need. No callback required.

```java
// Event-Carried State Transfer — full payload
public class PaymentCreatedEvent {
    private String paymentId;
    private String sourceAccountId;
    private String destinationAccountId;
    private BigDecimal amount;
    private String currency;
    private String status;
    private String merchantName;        // Included — eliminates merchant lookup
    private String merchantCategory;    // Included — eliminates category lookup
    private BigDecimal exchangeRate;    // Included — eliminates FX lookup
    private Instant occurredAt;
    private Map<String, String> metadata;
}

// Consumer is fully autonomous — no synchronous calls
@KafkaListener(topics = "payments.events")
public void onPaymentCreated(PaymentCreatedEvent event) {
    // Process with all data available
    settlementService.process(event);
    // No network calls to other services
}
```

**Trade-off:** Events are larger. When the data model changes, all consumers see the change immediately. Use this pattern for high-throughput paths where latency matters.

### Pattern 3: Event Sourcing

Events are the system of record. See Lesson 09 for detailed coverage.

---

## Service Autonomy Through Events

The key design goal is that each service owns its data and publishes events when that data changes. Other services maintain their own copy of the data they need.

```
BAD — Shared Database Anti-Pattern:
  Payment Service ──────────┐
  Settlement Service ────────┼── Shared Payments DB
  Notification Service ──────┘
  → All services coupled to same schema
  → Schema change requires all services to update
  → Single database is a bottleneck

GOOD — Event-Driven Data Ownership:
  Payment Service ──► payments.events ──┬──► Settlement Service (own DB)
                                        ├──► Notification Service (own DB)
                                        └──► Compliance Service (own DB)
  → Each service owns its read model
  → Schema changes in payment service don't break others
  → Each service scales independently
```

```java
// Payment Service — owns payment data, publishes events
@Service
public class PaymentService {

    @Autowired private PaymentRepository paymentRepository;    // Payment Service's own DB
    @Autowired private OutboxEventRepository outboxRepository; // Outbox for CDC

    @Transactional
    public Payment createPayment(CreatePaymentCommand command) {
        Payment payment = Payment.from(command);
        paymentRepository.save(payment);

        // The event is for anyone who cares — no coupling to specific consumers
        outboxRepository.save(OutboxEvent.builder()
                .aggregateId(payment.getId())
                .aggregateType("Payment")
                .eventType("PaymentCreated")
                .payload(objectMapper.writeValueAsString(PaymentCreatedEvent.from(payment)))
                .build());

        return payment;
    }
}

// Settlement Service — maintains its OWN copy of payment data via event consumption
@Service
public class SettlementPaymentProjection {

    @Autowired private SettlementPaymentRepository settlementPaymentRepo;

    @KafkaListener(topics = "payments.Payment.events", groupId = "settlement-service")
    @Transactional
    public void projectPaymentCreated(ConsumerRecord<String, String> record) {
        PaymentCreatedEvent event = parseEvent(record.value());

        // Create a local copy optimised for settlement queries
        SettlementPayment sp = SettlementPayment.builder()
                .paymentId(event.getPaymentId())
                .amount(event.getAmount())
                .currency(event.getCurrency())
                .settlementDate(calculateSettlementDate(event))
                .settlementStatus(SettlementStatus.PENDING)
                .build();

        settlementPaymentRepo.save(sp);
    }
}
```

---

## Event Contract Design

Events are public APIs. Breaking an event contract is as severe as breaking a REST API — it silently corrupts consumers.

```java
// Event contract principles:

// 1. Include event metadata for debugging and routing
public class EventEnvelope {
    private String eventId;          // UUID — for idempotency
    private String eventType;        // "PaymentCreated" — for routing
    private String aggregateId;      // Kafka partition key
    private String aggregateType;    // "Payment" — for routing
    private int schemaVersion;       // For manual version detection
    private Instant occurredAt;      // Business time (not publish time)
    private String correlationId;    // Trace ID for distributed tracing
    private String causationId;      // The command/event that caused this
    private Object payload;
}

// 2. Use rich domain types in the payload — not primitives
public class PaymentCreatedPayload {
    private String paymentId;
    private MoneyAmount amount;      // Not BigDecimal — includes currency
    private PaymentStatus status;    // Enum — not String
    private PaymentChannel channel;  // Enum — not String
    // ...
}

public class MoneyAmount {
    private BigDecimal value;
    private String currency;  // ISO 4217

    // Prevents "100 of what currency?" bugs
}
```

---

## Avoiding Event Coupling

The most common mistake is sharing domain objects between services as event payloads:

```java
// WRONG — coupling services via shared domain objects
// payment-service shares its internal domain model
public class PaymentCreatedEvent {
    private Payment payment;  // THIS IS THE INTERNAL DOMAIN MODEL OF PAYMENT SERVICE
}

// Now settlement-service imports payment-service's domain classes
// → Tight coupling: a change to Payment class breaks settlement-service

// CORRECT — events are their own type, independent of domain model
public class PaymentCreatedEvent {
    // These fields are chosen for the event consumers, not copied from the domain
    private String paymentId;
    private BigDecimal amount;
    private String currency;
    private String sourceAccountId;
    private String destinationAccountId;
    private PaymentStatus status;
    private Instant createdAt;
}
```

---

## Event Versioning Strategy

Events are published continuously. Old consumers must still work when a new version is deployed. See Lesson 07 for Schema Registry details. Here, the application-level strategy:

```java
// Strategy 1: Version in event type name
public class PaymentCreatedV2Event {
    // New version — old consumers still subscribe to PaymentCreated (v1)
    // Both versions published simultaneously during migration
}

// Strategy 2: Version field in envelope (more flexible)
public class PaymentCreatedEvent {
    private int version;  // 1, 2, 3...
    // Consumers handle multiple versions with a switch
}

// Consumer handling multiple versions:
@KafkaListener(topics = "payments.events")
public void handlePaymentCreated(ConsumerRecord<String, String> record) {
    JsonNode json = objectMapper.readTree(record.value());
    int version = json.get("version").asInt(1);  // Default to version 1

    PaymentCreatedEvent event = switch (version) {
        case 1 -> parseV1(json);
        case 2 -> parseV2(json);
        default -> {
            log.warn("Unknown event version {}— attempting V2 parsing", version);
            yield parseV2(json);
        }
    };

    processPaymentCreated(event);
}
```

---

## Debugging Event-Driven Systems — Distributed Tracing

When a payment event triggers 10 downstream service actions and one fails, finding the root cause requires distributed tracing.

```java
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapPropagator;

// Producer: inject trace context into Kafka headers
@Service
public class TracedEventPublisher {

    @Autowired private Tracer tracer;
    @Autowired private TextMapPropagator propagator;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    public void publishWithTrace(String topic, String key, String payload) {
        ProducerRecord<String, String> record = new ProducerRecord<>(topic, key, payload);

        // Inject current trace context into Kafka headers
        propagator.inject(Context.current(), record.headers(), (headers, name, value) ->
                headers.add(name, value.getBytes(StandardCharsets.UTF_8)));

        kafkaTemplate.send(record);
    }
}

// Consumer: extract trace context from Kafka headers
@KafkaListener(topics = "payments.events")
public void processPaymentEvent(ConsumerRecord<String, String> record) {
    // Extract trace context from headers
    Context extractedContext = propagator.extract(Context.current(), record.headers(),
            (headers, name) -> {
                Header header = headers.lastHeader(name);
                return header == null ? null : new String(header.value(), StandardCharsets.UTF_8);
            });

    // Start a child span in the extracted context
    Span span = tracer.spanBuilder("processPaymentEvent")
            .setParent(extractedContext)
            .startSpan();

    try (var scope = span.makeCurrent()) {
        span.setAttribute("payment.topic", record.topic());
        span.setAttribute("payment.partition", record.partition());
        span.setAttribute("payment.offset", record.offset());
        span.setAttribute("payment.key", record.key());

        // Process the event
        PaymentCreatedEvent event = parseEvent(record.value());
        settlementService.process(event);

    } catch (Exception e) {
        span.recordException(e);
        throw e;
    } finally {
        span.end();
    }
}
```

---

## Monitoring Event Flows

```java
import io.micrometer.core.instrument.*;

@Component
public class EventFlowMonitor {

    @Autowired private MeterRegistry meterRegistry;

    // Track events by type and service
    public void recordEventPublished(String eventType, String topic) {
        Counter.builder("kafka.events.published")
                .tag("event_type", eventType)
                .tag("topic", topic)
                .register(meterRegistry)
                .increment();
    }

    public void recordEventConsumed(String eventType, String topic,
            String consumerGroup, Duration processingTime) {
        Counter.builder("kafka.events.consumed")
                .tag("event_type", eventType)
                .tag("topic", topic)
                .tag("consumer_group", consumerGroup)
                .register(meterRegistry)
                .increment();

        Timer.builder("kafka.events.processing.duration")
                .tag("event_type", eventType)
                .tag("consumer_group", consumerGroup)
                .register(meterRegistry)
                .record(processingTime);
    }

    public void recordEventProcessingError(String eventType, String topic,
            String consumerGroup, String errorClass) {
        Counter.builder("kafka.events.errors")
                .tag("event_type", eventType)
                .tag("topic", topic)
                .tag("consumer_group", consumerGroup)
                .tag("error_class", errorClass)
                .register(meterRegistry)
                .increment();
    }
}
```

---

## Payment Service Event-Driven Architecture

A complete payment service event-driven architecture:

```
External Systems          Payment Service            Internal Events
                        ┌─────────────────┐
Client API ────cmd─────►│ Command Handler │──► payment.created
                        │                 │──► payment.approved
                        │  Outbox Pattern │──► payment.rejected
                        │  (Lesson 06)    │──► payment.settled
                        └────────┬────────┘
                                 │ WAL
                                 ▼
                           Debezium CDC
                                 │
                                 ▼
              ┌──────────────────────────────────────────────────────┐
              │                payments.events topic                 │
              └────┬───────────────┬──────────────┬─────────────────┘
                   │               │              │
                   ▼               ▼              ▼
           Settlement Service  Notification   Compliance Service
           (Lesson 10 CQRS)    Service        (append-only audit)
           PostgreSQL read      Redis cache    S3 archival
           model               push notif      (Lesson 08 Connect)

Cross-cutting concerns:
  - Schema Registry (Lesson 07)
  - Distributed tracing (OpenTelemetry)
  - Consumer lag monitoring (Lesson 17)
  - DLQ handling (Lesson 11)
  - Kafka security (Lesson 12)
```

---

## Key Takeaways

- Event notification (small events, consumers fetch data) creates synchronous dependencies — avoid for high-throughput paths.
- Event-carried state transfer (events contain all needed data) enables true service autonomy at the cost of larger event payloads.
- Never share internal domain model classes as event payloads — events are public contracts with their own type hierarchy.
- Each service owns its data — consumers maintain their own read models from events, never querying the publisher's database.
- Distributed tracing (OpenTelemetry) is essential for debugging event-driven systems — inject and propagate trace context in Kafka headers.
- Event versioning requires a strategy: type-name versioning or version-field versioning; consumers must handle multiple versions.
- An event-driven architecture's operational health requires event flow metrics: published counts, consumed counts, processing duration, and error rates per event type.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the main drawback of the Event Notification pattern compared to Event-Carried State Transfer?",
      "options": [
        "Event notification produces larger payloads that slow down Kafka",
        "Event notification requires consumers to call back to the publisher's API, creating synchronous dependencies",
        "Event notification cannot be used with Schema Registry",
        "Event notification does not support multiple consumers"
      ],
      "correct": 1,
      "explanation": "Event notification contains only a reference ('payment X was created') and consumers must call the publisher's API to fetch the data. This creates a synchronous dependency — if the publisher's API is down, consumers cannot process the event. Event-carried state transfer embeds all needed data in the event, enabling true service autonomy."
    },
    {
      "text": "Why should internal domain model classes never be used directly as Kafka event payloads?",
      "options": [
        "Domain model classes are too large to serialize efficiently",
        "Domain model classes change frequently, and sharing them couples consumers to the publisher's internal implementation",
        "Domain model classes cannot be serialized with Avro",
        "Domain model classes are protected under intellectual property rules"
      ],
      "correct": 1,
      "explanation": "Events are public contracts. If you share the Payment domain class as an event payload, every change to that class — adding internal fields, refactoring, renaming — breaks all consumers. Events should be separate types designed for their consumers, with fields chosen for consumer needs, not copied from internal domain models."
    },
    {
      "text": "What is the purpose of injecting OpenTelemetry trace context into Kafka message headers?",
      "options": [
        "To improve Kafka message routing performance",
        "To enable distributed tracing across service boundaries so that a single payment event can be traced through all downstream services",
        "To satisfy Schema Registry schema validation requirements",
        "To enable message deduplication via unique trace IDs"
      ],
      "correct": 1,
      "explanation": "Without trace context propagation, a payment event that triggers actions in 10 services produces 10 disconnected trace spans. By injecting the trace context into Kafka headers at the producer and extracting it at each consumer, all downstream spans are linked under the same root trace — enabling end-to-end visibility for debugging."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Fully Decoupled Event-Driven Payment Service",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Design a PaymentCreatedEvent as a standalone type (not sharing the Payment domain class) with fields selected for consumer needs. Implement event versioning using a 'version' integer field, and write a consumer that handles both v1 and v2 payloads using a switch statement."},
    {"id": "2", "description": "Implement a TracedEventPublisher that injects OpenTelemetry trace context into Kafka message headers using the W3C TraceContext propagator. Implement a matching consumer that extracts the trace context from headers and starts a child span, attributing topic, partition, offset, and payment key as span attributes."},
    {"id": "3", "description": "Build an EventFlowMonitor using Micrometer Counters and Timers that tracks kafka.events.published (by eventType, topic), kafka.events.consumed (by eventType, consumerGroup), kafka.events.processing.duration (histogram), and kafka.events.errors (by eventType, errorClass). Expose these as Prometheus metrics."},
    {"id": "4", "description": "Implement the full payment service event-driven architecture: Payment command handler uses the outbox pattern to publish events, Debezium CDC publishes to Kafka, and three independent consumer groups (settlement-projection, notification-service, compliance-archival) consume the same 'payments.events' topic with no shared state between them."}
  ]
}
-->
