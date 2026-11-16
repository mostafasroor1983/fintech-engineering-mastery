---
id: track-11-lesson-11
title: "Dead Letter Queues — Poison Pill Handling and Retry"
slug: dead-letter-queues
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 11
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [DLQ, poison-pill, dead-letter, retry, alerting]
prerequisites: [kafka-architecture, kafka-consumer]
---

# Dead Letter Queues — Poison Pill Handling and Retry

> [!NOTE]
> A single malformed payment event can halt an entire consumer group, blocking all payment processing until someone manually fixes the message. Dead letter queues are not optional in production financial systems — they are the difference between a brief incident and an extended outage. This lesson covers the full retry topology, DLQ design, monitoring, and the operational procedures for handling DLQ failures at scale.

## The Poison Pill Problem

A **poison pill** is a message that blocks a consumer indefinitely. Common causes in payment systems:

| Category | Example |
|----------|---------|
| Malformed JSON | `{"amount": "one hundred"}` — not parseable as BigDecimal |
| Schema mismatch | Producer on v2 schema, consumer still on v1 |
| Business error | Payment references a deleted account |
| Downstream failure | Settlement service is down — every message fails |
| Data corruption | Null accountId on a FundsTransferred event |
| Integer overflow | Amount field too large for the target system |

Without a DLQ strategy:

```
Consumer Group (payment-settlement-group)
  │
  ├── [msg 1] Process OK ✓
  ├── [msg 2] Process OK ✓
  ├── [msg 3] ← POISON PILL: account not found
  │     │── throws AccountNotFoundException
  │     │── Spring retries 3 times
  │     │── All 3 fail
  │     └── Consumer STOPS — no more messages processed
  │
  └── [msg 4], [msg 5], [msg 6] ... BLOCKED INDEFINITELY
```

The consumer group is now stuck at message 3. Lag grows. Settlement stops. Alerts fire.

---

## Retry Topic Pattern

The retry topic pattern routes failed messages through increasingly delayed topics before the DLQ:

```
payments.events
  │── [Process OK] → Continue
  │── [Fail] ──────────────────────────────► payments.events.retry.0  (delay: 10s)
                                                │── [Process OK] → Continue
                                                │── [Fail] ───────► payments.events.retry.1  (delay: 60s)
                                                                      │── [Process OK] → Continue
                                                                      │── [Fail] ───────► payments.events.retry.2  (delay: 600s)
                                                                                            │── [Process OK] → Continue
                                                                                            │── [Fail] ───────► payments.events.dlq
```

This provides **exponential backoff** for transient failures while isolating permanently failing messages so the main consumer group continues processing.

---

## Spring Kafka `DeadLetterPublishingRecoverer`

```java
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.util.backoff.ExponentialBackOff;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

@Configuration
public class KafkaErrorHandlingConfig {

    @Autowired
    private KafkaTemplate<Object, Object> kafkaTemplate;

    @Bean
    public DefaultErrorHandler paymentErrorHandler() {
        // DLQ recoverer — sends failed messages to <topic>.dlq
        DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(
                kafkaTemplate,
                (record, exception) -> new TopicPartition(
                        record.topic() + ".dlq",
                        record.partition()  // Preserve partition for ordering
                )
        );

        // Enrich DLQ message headers with debugging context
        recoverer.setHeadersFunction((consumerRecord, exception) -> {
            RecordHeaders headers = new RecordHeaders();
            headers.add("dlq.original.topic",
                    consumerRecord.topic().getBytes(StandardCharsets.UTF_8));
            headers.add("dlq.original.partition",
                    ByteBuffer.allocate(4).putInt(consumerRecord.partition()).array());
            headers.add("dlq.original.offset",
                    ByteBuffer.allocate(8).putLong(consumerRecord.offset()).array());
            headers.add("dlq.exception.class",
                    exception.getClass().getName().getBytes(StandardCharsets.UTF_8));
            headers.add("dlq.exception.message",
                    Optional.ofNullable(exception.getMessage())
                            .orElse("").getBytes(StandardCharsets.UTF_8));
            headers.add("dlq.failed.at",
                    Instant.now().toString().getBytes(StandardCharsets.UTF_8));
            return headers;
        });

        // Backoff: retries at 1s, 2s, 4s — then DLQ
        ExponentialBackOff backOff = new ExponentialBackOff(1_000L, 2.0);
        backOff.setMaxElapsedTime(10_000L);

        DefaultErrorHandler errorHandler = new DefaultErrorHandler(recoverer, backOff);

        // Skip retries for these — go straight to DLQ
        errorHandler.addNotRetryableExceptions(
                DeserializationException.class,
                SchemaException.class,
                InvalidPaymentException.class
        );

        return errorHandler;
    }
}
```

---

## `@RetryableTopic` — Full Retry Topology

Spring Kafka's `@RetryableTopic` annotation creates the full retry topic chain automatically:

```java
import org.springframework.kafka.annotation.RetryableTopic;
import org.springframework.kafka.annotation.DltHandler;
import org.springframework.retry.annotation.Backoff;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.KafkaHeaders;
import org.springframework.messaging.handler.annotation.Header;

@Component
public class PaymentProcessorWithRetry {

    @Autowired private PaymentProcessingService paymentService;
    @Autowired private DlqRepository dlqRepository;
    @Autowired private AlertService alertService;

    @RetryableTopic(
        attempts = "4",          // 1 original + 3 retries
        backoff = @Backoff(
            delay = 10_000,      // 10 second initial delay
            multiplier = 6.0,    // 10s, 60s, 600s
            maxDelay = 600_000
        ),
        // Creates: payments.events-retry-10000, -retry-60000, -retry-600000, -dlt
        topicSuffixingStrategy = TopicSuffixingStrategy.SUFFIX_WITH_DELAY_VALUE,
        dltTopicSuffix = "-dlt",
        autoCreateTopics = "false",   // Create manually with correct replication
        include = {RetriableException.class},
        exclude = {NonRetriableException.class}
    )
    @KafkaListener(topics = "payments.events", groupId = "payment-processor")
    public void processPayment(ConsumerRecord<String, String> record,
                               @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) {
        log.info("Processing payment from topic={} partition={} offset={}",
                topic, record.partition(), record.offset());

        PaymentEvent event = parseEvent(record.value());

        try {
            paymentService.process(event);
        } catch (DownstreamServiceException e) {
            // Transient — will be retried via retry topics
            throw new RetriableException("Downstream service unavailable", e);
        } catch (InvalidPaymentDataException e) {
            // Permanent — go straight to DLT
            throw new NonRetriableException("Invalid payment data: " + e.getMessage(), e);
        }
    }

    @DltHandler
    public void handleDeadLetter(
            ConsumerRecord<String, String> record,
            @Header(KafkaHeaders.EXCEPTION_CLASS_NAME) String exceptionClass,
            @Header(KafkaHeaders.EXCEPTION_MESSAGE) String exceptionMessage,
            @Header(KafkaHeaders.ORIGINAL_TOPIC) String originalTopic,
            @Header(KafkaHeaders.ORIGINAL_PARTITION) int originalPartition,
            @Header(KafkaHeaders.ORIGINAL_OFFSET) long originalOffset) {

        log.error("Payment reached DLT: topic={} partition={} offset={} exception={} message={}",
                originalTopic, originalPartition, originalOffset,
                exceptionClass, exceptionMessage);

        DlqFailureCategory category = categorize(exceptionClass);

        DlqEntry entry = DlqEntry.builder()
                .originalTopic(originalTopic)
                .originalPartition(originalPartition)
                .originalOffset(originalOffset)
                .originalKey(record.key())
                .messagePayload(record.value())
                .exceptionClass(exceptionClass)
                .exceptionMessage(exceptionMessage)
                .category(category)
                .createdAt(Instant.now())
                .resolved(false)
                .build();

        dlqRepository.save(entry);

        // Alert based on category
        AlertSeverity severity = switch (category) {
            case DESERIALIZATION, SCHEMA -> AlertSeverity.CRITICAL;
            case TRANSIENT -> AlertSeverity.HIGH;
            case BUSINESS_RULE -> AlertSeverity.MEDIUM;
            default -> AlertSeverity.HIGH;
        };
        alertService.sendAlert(severity,
                String.format("Payment DLT: %s at %s[%d]@%d",
                        exceptionMessage, originalTopic, originalPartition, originalOffset));

        // DO NOT rethrow — message should not re-enter the retry cycle
    }

    private DlqFailureCategory categorize(String exceptionClass) {
        if (exceptionClass.contains("Deserialization") ||
                exceptionClass.contains("JsonParse")) return DlqFailureCategory.DESERIALIZATION;
        if (exceptionClass.contains("Schema")) return DlqFailureCategory.SCHEMA;
        if (exceptionClass.contains("InsufficientFunds") ||
                exceptionClass.contains("InvalidPayment")) return DlqFailureCategory.BUSINESS_RULE;
        return DlqFailureCategory.TRANSIENT;
    }
}
```

---

## DLQ Schema and Repository

```java
@Entity
@Table(name = "dlq_entries",
       indexes = {
           @Index(columnList = "original_topic, resolved"),
           @Index(columnList = "category, resolved"),
           @Index(columnList = "created_at")
       })
public class DlqEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "original_topic", nullable = false)
    private String originalTopic;

    @Column(name = "original_partition")
    private int originalPartition;

    @Column(name = "original_offset")
    private long originalOffset;

    @Column(name = "original_key")
    private String originalKey;

    @Column(name = "message_payload", columnDefinition = "TEXT")
    private String messagePayload;

    @Column(name = "exception_class")
    private String exceptionClass;

    @Column(name = "exception_message", columnDefinition = "TEXT")
    private String exceptionMessage;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private DlqFailureCategory category;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private boolean resolved;

    private boolean discarded;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    @Column(name = "resolution_notes", columnDefinition = "TEXT")
    private String resolutionNotes;

    // Builder, getters, setters...
}

public enum DlqFailureCategory {
    TRANSIENT,       // Retry when service recovers
    SCHEMA,          // Fix schema mismatch
    BUSINESS_RULE,   // Human review required
    DESERIALIZATION, // Malformed message
    UNKNOWN
}
```

---

## DLQ Monitoring

```java
@Component
public class DlqMonitor {

    @Autowired private DlqRepository dlqRepository;
    @Autowired private MeterRegistry meterRegistry;
    @Autowired private AlertService alertService;

    @PostConstruct
    public void registerMetrics() {
        // Gauge: unresolved DLQ entries
        Gauge.builder("kafka.dlq.unresolved.count",
                dlqRepository, repo -> repo.countByResolvedFalse())
                .description("Unresolved DLQ entries requiring attention")
                .register(meterRegistry);

        // Per-category gauges
        for (DlqFailureCategory category : DlqFailureCategory.values()) {
            Gauge.builder("kafka.dlq.unresolved.by.category",
                    category,
                    cat -> dlqRepository.countByResolvedFalseAndCategory(cat))
                    .tag("category", category.name())
                    .register(meterRegistry);
        }
    }

    @Scheduled(fixedDelay = 60_000)
    public void checkDlqHealth() {
        // Alert if any CRITICAL category entries are unresolved for > 1 hour
        Instant criticalThreshold = Instant.now().minus(Duration.ofHours(1));
        long criticalCount = dlqRepository
                .countByResolvedFalseAndCategoryInAndCreatedAtBefore(
                        List.of(DlqFailureCategory.SCHEMA, DlqFailureCategory.DESERIALIZATION),
                        criticalThreshold
                );

        if (criticalCount > 0) {
            alertService.sendAlert(AlertSeverity.CRITICAL,
                    criticalCount + " schema/deserialization DLQ entries unresolved for >1 hour");
        }

        // Alert if DLQ has accumulated more than 100 entries in the last 10 minutes
        Instant tenMinutesAgo = Instant.now().minus(Duration.ofMinutes(10));
        long recentCount = dlqRepository.countByCreatedAtAfter(tenMinutesAgo);
        if (recentCount > 100) {
            alertService.sendAlert(AlertSeverity.HIGH,
                    "DLQ spike: " + recentCount + " entries in the last 10 minutes");
        }
    }
}
```

**Prometheus alert rules:**

```yaml
groups:
  - name: kafka-dlq
    rules:
      - alert: KafkaDlqEntriesAccumulating
        expr: kafka_dlq_unresolved_count > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "DLQ has {{ $value }} unresolved entries"

      - alert: KafkaDlqCriticalUnresolved
        expr: kafka_dlq_unresolved_by_category{category=~"SCHEMA|DESERIALIZATION"} > 0
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Critical DLQ entries unresolved for 15+ minutes"
```

---

## Manual Reprocessing from DLQ

```java
@Service
public class DlqReplayService {

    @Autowired private DlqRepository dlqRepository;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;
    @Autowired private AuditLog auditLog;

    public ReplayResult replayTransientFailures(String originalTopic) {
        List<DlqEntry> entries = dlqRepository
                .findByOriginalTopicAndCategoryAndResolvedFalseOrderByCreatedAt(
                        originalTopic, DlqFailureCategory.TRANSIENT);

        int replayed = 0, failed = 0;
        for (DlqEntry entry : entries) {
            try {
                kafkaTemplate.send(
                        entry.getOriginalTopic(),
                        entry.getOriginalPartition(),
                        entry.getOriginalKey(),
                        entry.getMessagePayload()
                );
                markResolved(entry, "Replayed after transient failure resolved");
                replayed++;
            } catch (Exception e) {
                log.error("Failed to replay DLQ entry {}", entry.getId(), e);
                failed++;
            }
        }

        log.info("DLQ replay complete for topic {}: replayed={}, failed={}", 
                originalTopic, replayed, failed);
        return new ReplayResult(replayed, failed);
    }

    public void replaySingle(Long dlqEntryId, String resolverUserId) {
        DlqEntry entry = dlqRepository.findById(dlqEntryId)
                .orElseThrow(() -> new DlqEntryNotFoundException(dlqEntryId));

        if (entry.isResolved()) {
            throw new IllegalStateException("DLQ entry " + dlqEntryId + " is already resolved");
        }

        kafkaTemplate.send(entry.getOriginalTopic(), entry.getOriginalPartition(),
                entry.getOriginalKey(), entry.getMessagePayload());

        markResolved(entry, "Manually replayed by " + resolverUserId);
        auditLog.record("DLQ_REPLAY", resolverUserId, String.valueOf(dlqEntryId));
        log.info("DLQ entry {} replayed by {}", dlqEntryId, resolverUserId);
    }

    public void discard(Long dlqEntryId, String reason, String resolverUserId) {
        DlqEntry entry = dlqRepository.findById(dlqEntryId)
                .orElseThrow(() -> new DlqEntryNotFoundException(dlqEntryId));

        entry.setResolved(true);
        entry.setDiscarded(true);
        entry.setResolvedAt(Instant.now());
        entry.setResolutionNotes("Discarded by " + resolverUserId + ": " + reason);
        dlqRepository.save(entry);

        auditLog.record("DLQ_DISCARD", resolverUserId, String.valueOf(dlqEntryId), reason);
        log.info("DLQ entry {} discarded by {}: {}", dlqEntryId, resolverUserId, reason);
    }

    private void markResolved(DlqEntry entry, String notes) {
        entry.setResolved(true);
        entry.setResolvedAt(Instant.now());
        entry.setResolutionNotes(notes);
        dlqRepository.save(entry);
    }
}
```

---

## Key Takeaways

- A poison pill without DLQ handling blocks the entire consumer group indefinitely — the most common Kafka production outage pattern.
- The retry topic pattern provides exponential backoff (10s → 60s → 600s) for transient failures before routing to the DLQ.
- `@RetryableTopic` creates the full topology automatically; `@DltHandler` receives messages at the end of the retry chain.
- `DeadLetterPublishingRecoverer` enriches DLQ messages with headers for debugging: original topic, offset, exception details.
- Categorise DLQ failures: **transient** (replay when service recovers), **schema** (fix schema), **business rule** (human review), **deserialization** (investigate message).
- DLQ monitoring requires lag alerts AND entry-age alerts — a DLQ with zero consumer lag but aging unresolved entries is still a problem.
- Every DLQ replay and discard must be audited — financial messages require an immutable record of remediation actions.
- Do not throw exceptions from `@DltHandler` — the message must not re-enter the retry cycle from the DLT.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What happens to a Kafka consumer group when a poison pill message is not handled with a DLQ strategy?",
      "options": [
        "The message is automatically skipped after 3 retries",
        "The consumer logs the error and moves to the next message",
        "The consumer group stops processing all subsequent messages in the partition indefinitely",
        "The Kafka broker automatically routes the message to a system DLQ"
      ],
      "correct": 2,
      "explanation": "Without DLQ handling, a failing message blocks the consumer at that offset. The consumer retries indefinitely (or up to configured attempts), but the partition offset never advances. All subsequent messages in the partition are blocked until the poison pill is resolved."
    },
    {
      "text": "Which DLQ failure category should trigger an immediate alert and require schema team involvement rather than automated replay?",
      "options": [
        "TRANSIENT — downstream service temporarily unavailable",
        "BUSINESS_RULE — payment references a deleted account",
        "SCHEMA — consumer cannot deserialize due to schema mismatch",
        "UNKNOWN — unclassified exception"
      ],
      "correct": 2,
      "explanation": "SCHEMA failures (deserialization failures, schema mismatch) indicate a producer-consumer contract violation that cannot be fixed by replaying the message. They require schema team investigation and a schema migration. Automated replay would just fail again."
    },
    {
      "text": "Why must the @DltHandler method never rethrow exceptions?",
      "options": [
        "Exceptions in @DltHandler crash the entire application",
        "Rethrowing causes the message to re-enter the retry cycle from the DLT, creating an infinite loop",
        "The DLT topic is read-only and cannot receive re-sent messages",
        "Spring Kafka does not support exception propagation from @DltHandler"
      ],
      "correct": 1,
      "explanation": "If @DltHandler rethrows, the framework treats it as a failure and routes the message back through the retry topology, eventually landing back in the DLT — creating an infinite loop. The DLT handler is the final stop; it must absorb the failure, persist it, and alert operators."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement a Production-Grade DLQ System for Payment Processing",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Configure @RetryableTopic on the payment consumer with 4 attempts, exponential backoff (10s initial, 6x multiplier, max 600s), creating retry topics suffixed with delay values. Classify exceptions: DownstreamServiceException as RetriableException, InvalidPaymentDataException as NonRetriableException."},
    {"id": "2", "description": "Implement the @DltHandler that persists DLQ entries to a dlq_entries PostgreSQL table with fields for originalTopic, partition, offset, messagePayload, exceptionClass, category (TRANSIENT/SCHEMA/BUSINESS_RULE/DESERIALIZATION), and resolved status. Send severity-appropriate alerts based on failure category."},
    {"id": "3", "description": "Build a DlqMonitor with Prometheus gauges for unresolved DLQ count per category. Implement a scheduled check that fires CRITICAL alerts when SCHEMA or DESERIALIZATION entries remain unresolved for more than 1 hour, and HIGH alerts for DLQ spikes (>100 entries in 10 minutes)."},
    {"id": "4", "description": "Implement a DlqReplayService with methods for bulk replay of TRANSIENT failures (re-publishes to original topic at original partition) and manual single-entry replay with audit logging. Add a discard method that marks entries as resolved with reason and operator identity stored for compliance."}
  ]
}
-->
