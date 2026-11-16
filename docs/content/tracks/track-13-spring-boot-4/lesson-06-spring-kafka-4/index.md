---
id: "track-13-lesson-06"
title: "Spring Kafka 4 — Configuration and Exactly-Once Semantics"
track: "track-13"
trackName: "Spring Boot 4 for Senior Fintech Engineers"
sequence: 6
slug: "spring-kafka-4"
difficulty: "advanced"
estimatedMinutes: 70
status: "published"
lastUpdated: "2026-11-12"

prerequisites:
  - "track-13-lesson-01"

tags:
  - "spring-kafka-4"
  - "kafka-4"
  - "eos"
  - "transactions"
  - "exactly-once"
  - "kraft"
  - "consumer-group"
  - "dead-letter"

topics:
  - "KRaft mode — ZooKeeper removed"
  - "KafkaTemplate with CompletableFuture"
  - "Exactly-once producer configuration"
  - "KafkaTransactionManager and DB+Kafka transactions"
  - "@KafkaListener changes in SK4"
  - "Dead-letter topic publishing"
  - "Consumer lag metrics and observability"
  - "EmbeddedKafka with KRaft in tests"

components:
  mermaid: true
  prism: true
  katex: false
  knowledge-check: true
  practical-challenge: true

references:
  - "Apache Kafka 4.0 Release Notes — KRaft GA"
  - "Spring Kafka 4.0 Release Notes"
  - "Kafka Improvement Proposal KIP-833 — Remove ZooKeeper"
  - "Spring Boot 4.0 Messaging Auto-Configuration"
---

# Spring Kafka 4 — Configuration and Exactly-Once Semantics

Apache Kafka 4.0 completes the KRaft (Kafka Raft Metadata) transition — ZooKeeper is not just deprecated, it is gone. Spring Kafka 4 (SK4) aligns with this and ships several API cleanups that matter for fintech services processing millions of payment events daily. This lesson focuses on what broke, what improved, and how to implement exactly-once semantics across a PostgreSQL write and a Kafka publish.

---

## 1. KRaft — ZooKeeper Is Gone

### What Disappeared from Configuration

Apache Kafka 4.0 removes all ZooKeeper-dependent code paths. For Spring Boot applications, this affects both producer/consumer `bootstrap-servers` behaviour and several properties that previously delegated to ZooKeeper-based admin operations.

**Properties removed in Spring Kafka 4 / Kafka 4.0:**

| Removed property | Notes |
|---|---|
| `spring.kafka.admin.properties.zookeeper.connect` | ZK admin gone; use KRaft |
| `spring.kafka.properties.zookeeper.session.timeout.ms` | ZK-only; remove from configs |
| `spring.kafka.properties.zookeeper.connection.timeout.ms` | ZK-only; remove from configs |
| All `zookeeper.*` entries in `spring.kafka.properties` | Invalid in Kafka 4.0 brokers |

**Before (SB3 / Kafka 3.x deployment):**

```yaml
spring:
  kafka:
    bootstrap-servers: kafka-0:9092,kafka-1:9092,kafka-2:9092
    properties:
      zookeeper.connect: zk-0:2181,zk-1:2181,zk-2:2181
      zookeeper.session.timeout.ms: 15000
```

**After (SB4 / Kafka 4.0 KRaft):**

```yaml
spring:
  kafka:
    bootstrap-servers: kafka-0:9092,kafka-1:9092,kafka-2:9092
    # No zookeeper.* properties — they will cause startup warnings in SK4
    # and are ignored by Kafka 4.0 brokers
    properties:
      security.protocol: SASL_SSL
      sasl.mechanism: SCRAM-SHA-512
```

The broker addresses are identical — KRaft does not change the client-facing protocol. The elimination is purely in the broker metadata layer, but SK4 will log warnings if it detects ZooKeeper properties in the client config, since they indicate a misconfigured environment.

### KRaft Impact on Kafka Admin Operations

`KafkaAdmin` (used for `NewTopic` bean auto-creation) no longer accepts ZooKeeper-based operations. All admin operations now go via the Kafka Admin protocol directly to brokers. The practical implication: `@Bean NewTopic` declarations work identically in SB4 — the underlying admin client just connects to brokers rather than ZooKeeper.

```java
@Bean
NewTopic paymentEventsTopic() {
    return TopicBuilder.name("payment-events")
        .partitions(12)
        .replicas(3)
        .config(TopicConfig.RETENTION_MS_CONFIG, String.valueOf(Duration.ofDays(7).toMillis()))
        .config(TopicConfig.COMPRESSION_TYPE_CONFIG, "lz4")
        .build();
}

@Bean
NewTopic paymentEventsDlt() {
    return TopicBuilder.name("payment-events.DLT")
        .partitions(12)
        .replicas(3)
        .build();
}
```

---

## 2. `KafkaTemplate` in SK4 — `CompletableFuture` Everywhere

`ListenableFuture` was a Spring utility type used in SK3 for async send results. It is **removed** in SK4. All `KafkaTemplate.send()` overloads now return `CompletableFuture<SendResult<K, V>>`.

**Spring Kafka 3.x (removed):**

```java
// DOES NOT COMPILE in Spring Kafka 4
ListenableFuture<SendResult<String, PaymentEvent>> future =
    kafkaTemplate.send("payment-events", event.paymentId(), event);
future.addCallback(
    success -> log.info("Sent {}", success.getProducerRecord().key()),
    failure -> log.error("Failed to send", failure)
);
```

**Spring Kafka 4:**

```java
@Service
@RequiredArgsConstructor
public class PaymentEventPublisher {

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    public CompletableFuture<String> publishPaymentCreated(PaymentEvent event) {
        return kafkaTemplate
            .send("payment-events", event.paymentId(), event)
            .thenApply(result -> {
                log.info("Published payment {} to partition {} offset {}",
                    event.paymentId(),
                    result.getRecordMetadata().partition(),
                    result.getRecordMetadata().offset());
                return event.paymentId();
            })
            .exceptionally(ex -> {
                log.error("Failed to publish payment {}: {}", event.paymentId(), ex.getMessage());
                throw new PaymentEventPublishException(event.paymentId(), ex);
            });
    }
}
```

Type safety also improved: `KafkaTemplate<String, PaymentEvent>` now enforces the value type at the generics level, and Spring Boot 4 auto-configuration will create typed templates when you declare a `ProducerFactory<String, PaymentEvent>` bean.

---

## 3. Exactly-Once Semantics — DB + Kafka in One Transaction

This is the most critical pattern for fintech: writing a payment to PostgreSQL and publishing a `PaymentCreated` event to Kafka must be atomic. Either both succeed or neither does.

### Producer Configuration for EOS

```yaml
spring:
  kafka:
    producer:
      transaction-id-prefix: payment-svc-txn-
      acks: all
      retries: 2147483647         # MAX_INT — let the producer retry indefinitely
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
        delivery.timeout.ms: 120000
    consumer:
      isolation-level: read_committed   # Only read committed Kafka messages
      auto-offset-reset: earliest
      group-id: payment-processor
```

`transaction-id-prefix` triggers `KafkaTransactionManager` auto-configuration in SB4. Combined with `enable.idempotence=true` and `acks=all`, this gives you exactly-once producer semantics (EOS).

### Spanning a DB Transaction and a Kafka Transaction

The classic `ChainedTransactionManager` was removed in Spring Framework 6.1. In SK4 with Spring Framework 7, the recommended pattern is `@Transactional` with the Kafka transaction manager as the primary, with the JPA transaction synchronized via Spring's `TransactionSynchronizationManager`.

```java
@Service
@RequiredArgsConstructor
@Transactional(transactionManager = "kafkaTransactionManager")
public class PaymentCommandHandler {

    private final PaymentRepository paymentRepository;
    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    /**
     * Kafka transaction wraps both the DB write (via JPA synchronization)
     * and the Kafka produce. If Kafka commit fails, DB is rolled back.
     * If DB fails, Kafka transaction is aborted before commit.
     */
    public PaymentResult handleCreatePayment(CreatePaymentCommand cmd) {
        // 1. Persist payment in PostgreSQL within the synchronized JPA transaction
        Payment payment = paymentRepository.save(Payment.from(cmd));

        // 2. Publish event inside the same Kafka transaction
        PaymentEvent event = PaymentEvent.created(payment);
        kafkaTemplate.send("payment-events", payment.getId(), event);

        return PaymentResult.of(payment);
    }
}
```

**Transaction manager configuration:**

```java
@Configuration
public class TransactionConfig {

    @Bean
    KafkaTransactionManager<String, PaymentEvent> kafkaTransactionManager(
            ProducerFactory<String, PaymentEvent> producerFactory) {
        return new KafkaTransactionManager<>(producerFactory);
    }

    // JPA transaction manager participates as a secondary via synchronization
    @Bean
    @Primary
    PlatformTransactionManager transactionManager(EntityManagerFactory emf) {
        return new JpaTransactionManager(emf);
    }
}
```

**The correct mental model**: declare `@Transactional(transactionManager = "kafkaTransactionManager")` on the method. Spring's transaction infrastructure begins a Kafka transaction; the `KafkaResourceHolder` is registered with the transaction synchronization mechanism. When the Kafka transaction begins, any `JpaTransactionManager` operations within the same thread participate through `TransactionSynchronizationManager`. On commit: JPA flushes first (synchronization `beforeCommit`), then Kafka sends `commitTransaction`. On failure: JPA rolls back via synchronization `afterRollback`, Kafka aborts the transaction.

This is not full XA — if the Kafka broker crashes after the JPA commit but before the Kafka commit, you have a window. For true atomic guarantees in production fintech, use the **transactional outbox pattern** (insert an event row in the same DB transaction, then a separate relay publishes it to Kafka and deletes the row).

---

## 4. `@KafkaListener` Changes in SK4

### Error Handler API Replacement

`ErrorHandler` and `BatchErrorHandler` interfaces were deprecated in SK3 and are **removed** in SK4. The replacement is `CommonErrorHandler`, which handles both record-by-record and batch consumption through a single interface.

**SK3 (removed):**

```java
// DOES NOT COMPILE in Spring Kafka 4
@Bean
ConcurrentKafkaListenerContainerFactory<String, PaymentEvent> factory(
        ConsumerFactory<String, PaymentEvent> cf) {
    var factory = new ConcurrentKafkaListenerContainerFactory<String, PaymentEvent>();
    factory.setErrorHandler(new SeekToCurrentErrorHandler());  // removed
    return factory;
}
```

**SK4:**

```java
@Bean
ConcurrentKafkaListenerContainerFactory<String, PaymentEvent> paymentListenerFactory(
        ConsumerFactory<String, PaymentEvent> cf,
        KafkaTemplate<String, PaymentEvent> kafkaTemplate) {

    var factory = new ConcurrentKafkaListenerContainerFactory<String, PaymentEvent>();
    factory.setConsumerFactory(cf);
    factory.setConcurrency(3);                    // 3 threads per consumer
    factory.setAutoStartup(true);

    // DefaultErrorHandler replaces SeekToCurrentErrorHandler
    var dlt = new DeadLetterPublishingRecoverer(kafkaTemplate,
        (record, ex) -> new TopicPartition(record.topic() + ".DLT", record.partition()));

    var errorHandler = new DefaultErrorHandler(dlt,
        new FixedBackOff(1_000L, 3L));            // 3 retries, 1s apart
    errorHandler.addNotRetryableExceptions(
        InvalidPaymentException.class,            // don't retry business validation errors
        SerializationException.class
    );

    factory.setCommonErrorHandler(errorHandler);  // SK4 method name
    return factory;
}
```

### Payment Event Consumer with Dead-Letter Publishing

```java
@Component
@RequiredArgsConstructor
public class PaymentEventConsumer {

    private final FraudService fraudService;
    private final AccountService accountService;

    @KafkaListener(
        topics = "payment-events",
        groupId = "payment-processor",
        containerFactory = "paymentListenerFactory",
        concurrency = "3",
        autoStartup = "true"
    )
    public void onPaymentEvent(
            @Payload PaymentEvent event,
            @Header(KafkaHeaders.RECEIVED_TOPIC) String topic,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            Acknowledgment ack) {

        log.info("Processing payment {} from {}-{} @ {}",
            event.paymentId(), topic, partition, offset);

        try {
            fraudService.screen(event);
            accountService.debit(event.accountId(), event.amount());
            ack.acknowledge();
        } catch (FraudDetectedException e) {
            // Rethrow as non-retryable so DefaultErrorHandler routes to DLT
            throw new InvalidPaymentException("Fraud detected: " + event.paymentId(), e);
        }
    }

    @KafkaListener(topics = "payment-events.DLT", groupId = "payment-dlt-processor")
    public void onDeadLetter(
            @Payload PaymentEvent event,
            @Header Map<String, Object> headers) {
        log.error("DLT received payment {}, original exception: {}",
            event.paymentId(),
            headers.get("kafka_dlt-exception-message"));
        // Alert, manual review queue, etc.
    }
}
```

---

## 5. Exactly-Once Flow Diagram

```mermaid
flowchart TD
    subgraph Producer["Payment Service (EOS Producer)"]
        A[POST /api/v1/payments] --> B[Begin Kafka Transaction]
        B --> C[INSERT payment\nPostgreSQL]
        C --> D{DB write\nsuccessful?}
        D -- No --> E[Rollback DB\nAbort Kafka Txn]
        D -- Yes --> F[kafkaTemplate.send\npayment-events]
        F --> G{Kafka send\nsuccessful?}
        G -- No --> H[Abort Kafka Txn\nRollback DB sync]
        G -- Yes --> I[Commit Kafka Txn\nCommit DB sync]
        I --> J[201 Created]
    end

    subgraph Consumer["Payment Processor (read_committed)"]
        K[poll payment-events\nread_committed] --> L[FraudService.screen]
        L --> M{Fraud\ndetected?}
        M -- Yes --> N[throw InvalidPaymentException]
        N --> O[DefaultErrorHandler\nretry 3x / 1s]
        O --> P[DeadLetterPublishingRecoverer\npublish to payment-events.DLT]
        P --> Q[Acknowledge original]
        M -- No --> R[AccountService.debit]
        R --> S[Acknowledge offset]
    end

    I -.->|Kafka commit visible\nafter broker confirms| K
```

---

## 6. Consumer Health Checks and Observability

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, info, kafka, metrics, prometheus
  health:
    kafka:
      enabled: true

spring:
  kafka:
    listener:
      observation-enabled: true    # Micrometer tracing spans per message
```

`observation-enabled: true` injects a Micrometer `Observation` around each `@KafkaListener` invocation. Combined with a `Tracer` bean (Brave or OpenTelemetry), this produces distributed traces that connect the HTTP request (producer side) to the Kafka consumer invocation.

**Programmatic consumer lag check:**

```java
@Component
@RequiredArgsConstructor
public class KafkaLagHealthIndicator implements HealthIndicator {

    private final KafkaListenerEndpointRegistry registry;
    private final AdminClient adminClient;

    @Override
    public Health health() {
        try {
            var container = registry.getListenerContainer("payment-processor");
            if (container == null || !container.isRunning()) {
                return Health.down().withDetail("reason", "container not running").build();
            }

            Map<TopicPartition, OffsetAndMetadata> offsets =
                adminClient.listConsumerGroupOffsets("payment-processor")
                           .partitionsToOffsetAndMetadata().get(5, TimeUnit.SECONDS);

            long totalLag = calculateLag(offsets);
            if (totalLag > 100_000) {
                return Health.degraded()
                    .withDetail("lag", totalLag)
                    .withDetail("threshold", 100_000)
                    .build();
            }
            return Health.up().withDetail("lag", totalLag).build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}
```

---

## 7. Testing with `@EmbeddedKafka` and KRaft Mode

SK4's `@EmbeddedKafka` runs in KRaft mode by default — no ZooKeeper process is started. The `EmbeddedKafkaBroker` API is unchanged from SK3, so existing tests compile without modification, but the underlying broker is now a KRaft broker.

```java
@SpringBootTest
@EmbeddedKafka(
    partitions = 3,
    brokerProperties = {
        "listeners=PLAINTEXT://localhost:${random.int[10000,20000]}",
        "log.dir=/tmp/kafka-test-${random.uuid}"
    },
    topics = { "payment-events", "payment-events.DLT" }
)
@TestPropertySource(properties = {
    "spring.kafka.consumer.auto-offset-reset=earliest",
    "spring.kafka.consumer.group-id=payment-processor-test"
})
class PaymentEventConsumerIntegrationTest {

    @Autowired
    EmbeddedKafkaBroker broker;

    @Autowired
    KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    @MockitoBean
    FraudService fraudService;

    @MockitoBean
    AccountService accountService;

    @Test
    void paymentEvent_processedSuccessfully() throws Exception {
        var event = PaymentEvent.created("pay-001", "acc-123", new BigDecimal("250.00"), "GBP");

        doNothing().when(fraudService).screen(event);
        doNothing().when(accountService).debit(any(), any());

        kafkaTemplate.send("payment-events", event.paymentId(), event).get(10, SECONDS);

        await().atMost(10, SECONDS)
               .untilAsserted(() ->
                   verify(accountService).debit("acc-123", new BigDecimal("250.00")));
    }

    @Test
    void fraudulentPayment_publishedToDlt() throws Exception {
        var event = PaymentEvent.created("pay-002", "acc-456", new BigDecimal("99999.00"), "GBP");

        doThrow(new FraudDetectedException("velocity limit exceeded"))
            .when(fraudService).screen(event);

        kafkaTemplate.send("payment-events", event.paymentId(), event).get(10, SECONDS);

        // DefaultErrorHandler retries 3x then publishes to DLT
        await().atMost(30, SECONDS).untilAsserted(() -> {
            var consumer = createConsumer(broker, "payment-events.DLT");
            var dltRecords = KafkaTestUtils.getRecords(consumer);
            assertThat(dltRecords).hasSize(1);
            assertThat(dltRecords.iterator().next().key()).isEqualTo("pay-002");
        });
    }
}
```

**Important**: `@EmbeddedKafka` starts a fresh broker per test class by default. For large test suites, annotate the test class with `@DirtiesContext(classMode = AFTER_CLASS)` only if you mutate shared Kafka state — otherwise leave it off. See Lesson 8 for detailed test performance guidance.

---

## Summary

- **KRaft is the only mode** in Kafka 4.0. Remove all `zookeeper.*` properties from your Spring Boot application configs — SK4 will warn and Kafka 4.0 brokers will ignore them.
- **`ListenableFuture` is gone** — all `KafkaTemplate.send()` calls return `CompletableFuture<SendResult<K, V>>`. Update all callback code to use `thenApply` / `exceptionally`.
- **EOS requires** `transaction-id-prefix` + `enable.idempotence=true` + `acks=all` on the producer, and `isolation-level=read_committed` on consumers. Span DB + Kafka writes in a single `@Transactional(transactionManager = "kafkaTransactionManager")` method; use the outbox pattern for the strongest guarantees.
- **`CommonErrorHandler`** replaces `ErrorHandler` and `BatchErrorHandler`. Use `DefaultErrorHandler` with `FixedBackOff` and `DeadLetterPublishingRecoverer` for retry + DLT in one configuration.
- **`observation-enabled: true`** wires Micrometer tracing spans around listener invocations for distributed tracing without code changes.
- **`@EmbeddedKafka`** in SK4 runs KRaft mode by default — existing test code compiles unchanged.

---

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-06-01",
    "question": "A Spring Boot 3.x payment service has spring.kafka.properties.zookeeper.connect=zk-0:2181 in its application.yml. When migrated to Spring Boot 4 with Kafka 4.0, what is the correct action?",
    "options": [
      "Change the port from 2181 to 2888 for KRaft mode",
      "Replace it with spring.kafka.properties.kraft.quorum.voters",
      "Remove the property entirely — KRaft brokers use bootstrap-servers only",
      "Move it under spring.kafka.admin.properties"
    ],
    "correct": 2,
    "explanation": "Kafka 4.0 removes ZooKeeper entirely. Client applications only need bootstrap-servers to discover the cluster. The zookeeper.connect property is meaningless to Kafka 4.0 brokers and should be deleted from application configs. There is no kraft.quorum.voters client property."
  },
  {
    "id": "kc-06-02",
    "question": "In Spring Kafka 4, what does KafkaTemplate.send() return?",
    "options": [
      "ListenableFuture<SendResult<K, V>>",
      "Future<RecordMetadata>",
      "CompletableFuture<SendResult<K, V>>",
      "Mono<SendResult<K, V>>"
    ],
    "correct": 2,
    "explanation": "Spring Kafka 4 removes ListenableFuture (a Spring-specific type) and all send() methods return CompletableFuture<SendResult<K, V>>, aligning with the standard Java concurrency API. Reactive types like Mono are available through ReactiveKafkaProducerTemplate, not KafkaTemplate."
  },
  {
    "id": "kc-06-03",
    "question": "To configure a @KafkaListener to retry failed messages 3 times with a 1-second delay and then publish unrecoverable messages to a dead-letter topic in Spring Kafka 4, which class should you use as the CommonErrorHandler?",
    "options": [
      "SeekToCurrentErrorHandler with a DeadLetterPublishingRecoverer",
      "DefaultErrorHandler with FixedBackOff and DeadLetterPublishingRecoverer",
      "RetryingMessageListenerAdapter with ExponentialBackOff",
      "BatchErrorHandler with KafkaBackOff"
    ],
    "correct": 1,
    "explanation": "DefaultErrorHandler (which implements CommonErrorHandler) replaces SeekToCurrentErrorHandler in SK4. It accepts a RecovererAndClassifier — typically a DeadLetterPublishingRecoverer — and a BackOff strategy like FixedBackOff(1000L, 3L). SeekToCurrentErrorHandler and BatchErrorHandler are removed in SK4."
  },
  {
    "id": "kc-06-04",
    "question": "To enable distributed tracing spans around @KafkaListener invocations without writing any listener code, which Spring Boot 4 configuration property should you set?",
    "options": [
      "spring.kafka.listener.ack-mode=manual",
      "spring.kafka.listener.observation-enabled=true",
      "management.tracing.kafka.enabled=true",
      "spring.kafka.producer.properties.interceptor.classes=TracingProducerInterceptor"
    ],
    "correct": 1,
    "explanation": "spring.kafka.listener.observation-enabled=true instructs the ConcurrentMessageListenerContainer to wrap each listener invocation in a Micrometer Observation, automatically creating spans. This integrates with any registered Tracer (Brave or OpenTelemetry) without code changes in the listener."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-06",
  "title": "Build an Exactly-Once Payment Event Pipeline",
  "description": "Implement a production-grade payment event publisher and consumer with exactly-once semantics, dead-letter handling, and observability using Spring Kafka 4.",
  "tasks": [
    {
      "id": "pc-06-01",
      "description": "Configure application.yml for exactly-once semantics: set spring.kafka.producer.transaction-id-prefix=payment-svc-txn-, enable.idempotence=true, acks=all, retries=2147483647; set spring.kafka.consumer.isolation-level=read_committed and spring.kafka.listener.observation-enabled=true. Declare @Bean NewTopic beans for payment-events (12 partitions, RF 3, 7-day retention) and payment-events.DLT (12 partitions, RF 3)."
    },
    {
      "id": "pc-06-02",
      "description": "Implement PaymentCommandHandler with a method handleCreatePayment(CreatePaymentCommand) annotated @Transactional(transactionManager=\"kafkaTransactionManager\"). The method must: (1) save a Payment entity via PaymentRepository, (2) call kafkaTemplate.send(\"payment-events\", payment.getId(), PaymentEvent.created(payment)). Declare KafkaTransactionManager<String, PaymentEvent> as a @Bean in a TransactionConfig class."
    },
    {
      "id": "pc-06-03",
      "description": "Create a ConcurrentKafkaListenerContainerFactory bean named paymentListenerFactory with: concurrency=3, a DefaultErrorHandler using FixedBackOff(1000L, 3L), a DeadLetterPublishingRecoverer that routes to partition-matched DLT topic (record.topic() + \".DLT\"), and InvalidPaymentException added as a non-retryable exception. Write a @KafkaListener method in PaymentEventConsumer that calls FraudService.screen() and AccountService.debit() and uses manual Acknowledgment."
    },
    {
      "id": "pc-06-04",
      "description": "Write an @EmbeddedKafka integration test class PaymentEventConsumerIntegrationTest with two test methods: one verifying that a valid PaymentEvent results in AccountService.debit() being called (use Awaitility), and one verifying that a PaymentEvent that causes FraudDetectedException to be thrown ends up on payment-events.DLT after retries are exhausted. Use @MockitoBean for FraudService and AccountService."
    }
  ]
}
-->
