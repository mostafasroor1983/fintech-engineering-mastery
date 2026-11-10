---
id: track-11-lesson-19
title: "RabbitMQ vs Kafka — Choosing the Right Broker"
slug: rabbitmq-vs-kafka
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [RabbitMQ, Kafka, comparison, queue, log]
prerequisites: [kafka-architecture]
---

# RabbitMQ vs Kafka — Choosing the Right Broker

> [!NOTE]
> Kafka and RabbitMQ are both excellent message brokers, but they solve different problems. The wrong choice causes architectural friction for years. Using Kafka for task queues and RabbitMQ for event streaming are both common and painful mistakes. This lesson builds the mental model to choose correctly and design hybrid architectures when both are genuinely needed.

## Fundamental Architectural Difference

The core difference is not about performance or features — it is about the **data model**:

```
RabbitMQ — Queue/Push Model:
  Message ──► Queue ──► Consumer
  - Message deleted after consumption (acknowledged and gone)
  - Broker pushes messages to consumers (consumers are passive)
  - Multiple consumers on one queue compete for messages (round-robin)
  - No replay — message is gone after processing

Kafka — Log/Pull Model:
  Record ──► Partition (append-only log)
  Consumer reads from log at its own position
  - Record retained for a configurable period (default: 7 days)
  - Consumers pull from the log (consumers are active)
  - Multiple consumer groups each read ALL messages independently
  - Full replay from offset 0 to the present
```

This difference in retention is the decisive factor for most architecture decisions:

| Question | Answer → Use |
|---------|-------------|
| Do I need replay capability? | Yes → Kafka |
| Do multiple services need the same messages? | Yes → Kafka |
| Is this a task queue (work distribution)? | Yes → RabbitMQ |
| Do I need complex routing (direct, fanout, topic, headers)? | Yes → RabbitMQ |
| Do I need delivery acknowledgement at the per-task level? | Yes → RabbitMQ |
| Do I need >100k messages/second throughput? | Yes → Kafka |
| Do I need message TTL per message? | Yes → RabbitMQ |

---

## RabbitMQ Exchanges and Routing

RabbitMQ's routing model is significantly more flexible than Kafka's at the message level:

```
Producer ──► Exchange ──► Binding ──► Queue ──► Consumer

Exchange Types:
  Direct:  Route by exact routing key match
  Topic:   Route by pattern matching (payments.*, *.settled)
  Fanout:  Route to ALL bound queues (broadcast)
  Headers: Route by message header attributes
```

```java
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.core.*;
import org.springframework.stereotype.Service;

@Configuration
public class RabbitMQConfig {

    // Direct exchange — route by exact routing key
    @Bean
    public DirectExchange paymentsExchange() {
        return new DirectExchange("payments.exchange", true, false);
    }

    // Queue per consumer service
    @Bean
    public Queue settlementQueue() {
        return QueueBuilder.durable("payments.settlement")
                .withArgument("x-message-ttl", 3600000)       // 1 hour TTL
                .withArgument("x-dead-letter-exchange", "payments.dlx")
                .withArgument("x-dead-letter-routing-key", "settlement.dlq")
                .build();
    }

    @Bean
    public Queue notificationQueue() {
        return QueueBuilder.durable("payments.notification")
                .withArgument("x-message-ttl", 1800000)  // 30 min TTL
                .build();
    }

    // Bindings: exchange routes by routing key
    @Bean
    public Binding settlementBinding(Queue settlementQueue, DirectExchange paymentsExchange) {
        return BindingBuilder.bind(settlementQueue)
                .to(paymentsExchange)
                .with("payment.created"); // routing key
    }

    @Bean
    public Binding notificationBinding(Queue notificationQueue,
            DirectExchange paymentsExchange) {
        return BindingBuilder.bind(notificationQueue)
                .to(paymentsExchange)
                .with("payment.created");
    }
}

@Service
public class PaymentEventPublisher {

    @Autowired private RabbitTemplate rabbitTemplate;

    public void publishPaymentCreated(Payment payment) {
        rabbitTemplate.convertAndSend(
                "payments.exchange",
                "payment.created",    // routing key
                PaymentCreatedEvent.from(payment),
                message -> {
                    message.getMessageProperties().setMessageId(payment.getId());
                    message.getMessageProperties().setContentType("application/json");
                    return message;
                }
        );
    }
}
```

---

## RabbitMQ Consumer (Competing Consumers)

```java
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

@Component
public class PaymentSettlementConsumer {

    @Autowired private SettlementService settlementService;

    // Multiple instances of this service compete for messages from the queue
    // RabbitMQ distributes messages in round-robin: each message processed ONCE
    @RabbitListener(queues = "payments.settlement",
                    concurrency = "2-5",   // 2 to 5 concurrent threads
                    ackMode = "MANUAL")
    public void processSettlement(Message message, Channel channel) throws Exception {
        long deliveryTag = message.getMessageProperties().getDeliveryTag();

        try {
            PaymentCreatedEvent event = parseEvent(message.getBody());
            settlementService.process(event);

            // ACK: remove from queue — message is gone
            channel.basicAck(deliveryTag, false);

        } catch (BusinessException e) {
            // NACK with requeue=false → goes to dead letter exchange
            channel.basicNack(deliveryTag, false, false);
        } catch (TransientException e) {
            // NACK with requeue=true → back to queue for retry
            channel.basicNack(deliveryTag, false, true);
        }
    }
}
```

---

## Dead Letter Exchanges in RabbitMQ

RabbitMQ's Dead Letter Exchange (DLX) is equivalent to Kafka's DLQ:

```java
@Configuration
public class RabbitMQDlxConfig {

    @Bean
    public DirectExchange deadLetterExchange() {
        return new DirectExchange("payments.dlx");
    }

    @Bean
    public Queue settlementDlq() {
        return QueueBuilder.durable("payments.settlement.dlq").build();
    }

    @Bean
    public Binding dlqBinding(Queue settlementDlq, DirectExchange deadLetterExchange) {
        return BindingBuilder.bind(settlementDlq)
                .to(deadLetterExchange)
                .with("settlement.dlq");
    }
}
```

---

## RabbitMQ Streams for Replay

Classic RabbitMQ queues delete messages after consumption. **RabbitMQ Streams** (introduced in 3.9) add log-based storage with replay:

```java
import com.rabbitmq.stream.*;

@Configuration
public class RabbitMQStreamConfig {

    @Bean
    public Environment rabbitStreamEnvironment() {
        return Environment.builder()
                .host("rabbitmq")
                .username("admin")
                .password("secret")
                .build();
    }
}

@Service
public class PaymentStreamPublisher {

    @Autowired private Environment streamEnv;

    @PostConstruct
    public void setupStream() {
        streamEnv.streamCreator()
                .stream("payments-stream")
                .maxLengthBytes(ByteCapacity.GB(50))  // Keep 50GB of history
                .maxAge(Duration.ofDays(30))            // Or 30 days
                .create();
    }

    public void publish(PaymentCreatedEvent event) {
        Producer producer = streamEnv.producerBuilder()
                .stream("payments-stream")
                .build();

        producer.send(
                producer.messageBuilder()
                        .addData(event.toJson().getBytes())
                        .properties().messageId(event.getPaymentId()).messageBuilder()
                        .build(),
                confirmationStatus -> {
                    if (!confirmationStatus.isConfirmed()) {
                        log.error("Stream publish failed for payment {}", event.getPaymentId());
                    }
                }
        );
    }
}
```

RabbitMQ Streams close the gap with Kafka for replay use cases, but Kafka remains more mature for high-throughput streaming at scale.

---

## Throughput Comparison

| Metric | RabbitMQ | Kafka |
|--------|---------|-------|
| Peak throughput | ~50-100k msg/s | ~1M+ msg/s |
| Latency (p99) | 1-10ms | 5-50ms |
| Scaling | Vertical + federation | Horizontal (partitions) |
| Message size | Optimal for <1MB | Optimal for <1MB, supports larger |
| Consumer type | Push (broker-initiated) | Pull (consumer-initiated) |

**Note:** These numbers are for well-tuned configurations. RabbitMQ can achieve higher throughput with shallow queues and minimal routing overhead; Kafka's advantage grows at very high message counts.

---

## Ordering Guarantees Comparison

| Scenario | RabbitMQ | Kafka |
|----------|---------|-------|
| Single queue, single consumer | Strict FIFO | N/A (use Kafka) |
| Single queue, multiple consumers | No ordering | N/A |
| Per-account ordering | Manual (1 queue per account) | Automatic (key-based partitioning) |
| Global ordering | Single queue (bottleneck) | Single partition (bottleneck) |
| Within consumer group | Per-queue FIFO | Per-partition FIFO |

For per-entity ordering (per-account, per-payment), Kafka's partition-key mechanism is more natural and scalable than RabbitMQ's one-queue-per-entity approach.

---

## Hybrid Architecture in Fintech

Real financial systems often need both:

```
Payment Platform Architecture — Hybrid

[Kafka] — Event Streaming Layer:
  payments.events ──► Settlement Service
  payments.events ──► Compliance Service (Lesson 08: S3 archival)
  payments.events ──► Analytics Service
  account.events  ──► Read model projections
  → Replay, long retention, multiple consumers, event sourcing

[RabbitMQ] — Task Queue Layer:
  fraud.checks.queue  ──► Fraud Check Worker (pool)
  email.queue         ──► Email Service (competing consumers)
  sms.queue           ──► SMS Service (competing consumers)
  pdf.generation.queue ──► Statement Generator (pool)
  → Point-to-point task distribution, complex routing, per-message TTL
```

```java
// Payment flow using both brokers
@Service
public class PaymentCoordinator {

    @Autowired private KafkaTemplate<String, String> kafkaTemplate;    // For event streaming
    @Autowired private RabbitTemplate rabbitTemplate;                   // For task distribution

    @Transactional
    public void processPayment(Payment payment) {
        // 1. Publish domain event to Kafka for event-driven architecture
        kafkaTemplate.send("payments.events",
                payment.getId(),
                PaymentCreatedEvent.from(payment).toJson());

        // 2. Queue fraud check as a task to RabbitMQ worker pool
        //    (competing consumers, one fraud check per payment, task semantics)
        rabbitTemplate.convertAndSend(
                "fraud.exchange",
                "fraud.check",
                FraudCheckTask.from(payment)
        );
    }
}
```

---

## Decision Framework

```
When to use Kafka:
  ✓ Multiple services need the same events
  ✓ Replay capability required (audit, debugging, new service bootstrap)
  ✓ Event sourcing architecture
  ✓ Stream processing (Kafka Streams, Flink)
  ✓ Long event retention required
  ✓ High throughput (>50k msg/s)
  ✓ Consumer groups with independent offsets
  ✓ Exactly-once semantics needed

When to use RabbitMQ:
  ✓ Task queue semantics (one consumer handles each task)
  ✓ Complex routing (direct, topic, fanout, headers)
  ✓ Per-message TTL required
  ✓ Request-reply pattern (RPC)
  ✓ Small-scale system (<50k msg/s, <10 services)
  ✓ Teams familiar with AMQP but not Kafka
  ✓ Message priorities needed
  ✓ Mature dead letter exchange patterns needed

When to use both:
  ✓ Payment processing platform:
      Kafka for event streaming + RabbitMQ for task queues
  ✓ Large enterprise platform where some teams are on RabbitMQ
      and migrating to Kafka incrementally
  ✓ Microservices that need event replay (Kafka) AND
      point-to-point task distribution (RabbitMQ)
```

---

## Key Takeaways

- RabbitMQ is a **queue** (message deleted after ACK); Kafka is a **log** (message retained regardless of consumption).
- RabbitMQ's exchange/binding routing model is more flexible for per-message routing than Kafka's partition key approach.
- Kafka scales to 1M+ messages/second horizontally; RabbitMQ peaks around 50-100k/s per cluster.
- RabbitMQ Streams add replay capability to RabbitMQ, but Kafka remains more mature for high-throughput streaming.
- For per-entity ordering (per-account), Kafka's partition key is more natural than RabbitMQ's queue-per-entity.
- Hybrid architectures are common in fintech: Kafka for event streaming + RabbitMQ for task queues.
- The decisive question is not throughput but **semantics**: does the message represent an event (use Kafka) or a task (consider RabbitMQ)?

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A compliance team needs to onboard a new audit service 6 months after the payment system went live. The audit service needs to replay all historical payment events from the beginning. Which broker architecture supports this requirement?",
      "options": [
        "RabbitMQ classic queues — messages can be re-queued by the new consumer",
        "Kafka — the log retains all messages for the configured retention period (or indefinitely with log compaction), allowing replay from offset 0",
        "RabbitMQ with a separate queue per consumer — the exchange will route copies of all future messages to the new queue",
        "Either broker — both support independent consumer offsets"
      ],
      "correct": 1,
      "explanation": "RabbitMQ classic queues delete messages after acknowledgement — once a message is consumed, it is gone. A new consumer joining later can only receive future messages, not past ones. Kafka retains all records in the partition log regardless of consumption (until retention policy removes them). A new consumer can set its offset to 0 (earliest) and replay all historical events. This is the fundamental architectural difference: Kafka is a log, RabbitMQ is a queue."
    },
    {
      "text": "A fraud detection system needs each payment to be processed by exactly ONE fraud check worker from a pool of 10 workers. Which broker and pattern is most appropriate?",
      "options": [
        "Kafka with 10 consumers in one consumer group — each partition is assigned to one consumer",
        "RabbitMQ with a single queue and 10 competing consumers — RabbitMQ distributes messages in round-robin so each message is processed by exactly one worker",
        "Kafka with 10 separate consumer groups — each group gets a copy of every message",
        "RabbitMQ fanout exchange — broadcasts to all 10 workers simultaneously"
      ],
      "correct": 1,
      "explanation": "This is a task queue pattern: one task (fraud check) per message, processed by exactly one worker. RabbitMQ's competing consumer model is a natural fit — multiple consumers on the same queue compete, and the broker ensures each message is delivered to exactly one consumer. Kafka consumer groups also distribute partitions, but Kafka is better suited when multiple independent services need to consume the same events (not competing for them). A fanout exchange would send the fraud check to ALL workers, causing duplicate processing."
    },
    {
      "text": "In a hybrid architecture (Kafka for event streaming + RabbitMQ for task queues), a PaymentCreatedEvent is published to both brokers. What is the correct design intent?",
      "options": [
        "The same event goes to both brokers to provide redundancy in case one broker fails",
        "Kafka receives the domain event for replay, audit, and multiple independent consumers (settlement, compliance, analytics); RabbitMQ receives a task message for point-to-point work distribution (fraud check worker pool, email notification)",
        "Kafka and RabbitMQ are mirrors of each other — messages in one are automatically replicated to the other",
        "RabbitMQ is the primary broker; Kafka is used only as a backup when the RabbitMQ queue is full"
      ],
      "correct": 1,
      "explanation": "In a well-designed hybrid architecture, the two brokers serve different semantic roles. Kafka stores the domain event log — multiple independent consumer groups (settlement, compliance, analytics) each read ALL events independently with replay capability. RabbitMQ handles task distribution — a fraud check task is sent to one worker from the pool (competing consumers), and an email notification task goes to the email service. The brokers are not mirrors or failover for each other; they solve different problems simultaneously."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Hybrid Kafka and RabbitMQ Payment Processing Architecture",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    "Implement a PaymentCoordinator that, within a single @Transactional method, publishes a PaymentCreatedEvent to Kafka (payments.events topic, key=paymentId) for downstream event-driven consumers AND sends a FraudCheckTask to RabbitMQ (fraud.check queue) for point-to-point task delivery. Use the outbox pattern to avoid dual-write inconsistency between the two brokers.",
    "Configure a RabbitMQ direct exchange (payments.exchange) with two bound queues: payments.settlement (binding key: payment.created) and payments.notification (binding key: payment.created). Implement competing consumers on payments.settlement with concurrency=3 and manual ACK. Verify that each message is processed by exactly one consumer instance using a counter shared across consumer threads.",
    "Set up a RabbitMQ Dead Letter Exchange (payments.dlx) for the settlement queue. Configure x-message-ttl=3600000 and x-dead-letter-exchange on the queue. Implement a consumer that NACKs with requeue=false on BusinessException. Write a test that triggers the DLX flow and verifies the message appears in the DLQ within 100 ms.",
    "Write a comparison benchmark: publish 10,000 events to Kafka (payments.events) and 10,000 tasks to RabbitMQ (payments.settlement). Measure end-to-end latency (p50, p95, p99) for each broker. Document which broker achieves lower p99 latency and explain why based on the push vs pull model difference from the lesson."
  ]
}
-->
