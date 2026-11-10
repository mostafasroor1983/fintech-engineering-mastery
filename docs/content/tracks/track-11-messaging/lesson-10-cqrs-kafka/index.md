---
id: track-11-lesson-10
title: "CQRS with Kafka — Read Model Projection Strategies"
slug: cqrs-kafka
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 10
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [CQRS, read-model, projection, eventual-consistency, Kafka]
prerequisites: [kafka-architecture, event-sourcing-kafka]
---

# CQRS with Kafka — Read Model Projection Strategies

> [!NOTE]
> CQRS separates the write path (commands that change state) from the read path (queries that return data). In financial systems, the write path prioritises correctness and consistency; the read path prioritises performance and flexibility. Kafka is the backbone that connects them — events flow from the write side to materialise read models optimised for specific query patterns.

## CQRS Fundamentals

**Command Query Responsibility Segregation** (CQRS) means:

- **Write side (Command):** Processes commands, enforces business rules, emits events
- **Read side (Query):** Consumes events, maintains denormalised read models, answers queries

```
                    Command Side                Read Side
Client ──command──► CommandHandler ──event──► Kafka ──► Projection
                    EventStore               ──────► PostgreSQL (account queries)
                                             ──────► Redis (real-time dashboards)
                                             ──────► Elasticsearch (transaction search)
```

**Why separate them?**

The write model optimises for **correctness**: normalised database, transactional consistency, constraint enforcement. The read model optimises for **query performance**: denormalised tables, materialised views, indexes tuned to specific query patterns.

A query that returns "all transactions for account X in the last 30 days with merchant enrichment" would be expensive against a normalised write model. Against a denormalised read model it is a single indexed query.

---

## Write Side Implementation

```java
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountCommandHandler {

    @Autowired private AccountRepository accountRepository;  // Event store
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    @Transactional
    public void handle(DepositFundsCommand command) {
        // 1. Load aggregate from event store
        AccountAggregate account = accountRepository.load(command.getAccountId());

        // 2. Apply command — business logic runs here
        account.depositFunds(command.getAmount(), command.getReference(), command.getChannel());

        // 3. Save uncommitted events to event store (Kafka)
        accountRepository.save(account);

        // The events are now in Kafka — read-side projections will consume them
        // The command handler does NOT need to know about read models
    }

    @Transactional
    public void handle(WithdrawFundsCommand command) {
        AccountAggregate account = accountRepository.load(command.getAccountId());
        account.withdrawFunds(command.getAmount(), command.getReference(), command.getChannel());
        accountRepository.save(account);
    }

    @Transactional
    public void handle(InitiateTransferCommand command) {
        AccountAggregate sourceAccount = accountRepository.load(command.getSourceAccountId());

        // Business rule: validate before initiating
        if (!sourceAccount.canTransfer(command.getAmount())) {
            throw new InsufficientFundsException(command.getSourceAccountId());
        }

        sourceAccount.initiateTransfer(
                command.getDestinationAccountId(),
                command.getAmount(),
                command.getCurrency(),
                command.getTransferId()
        );

        accountRepository.save(sourceAccount);
    }
}
```

---

## Read Model: PostgreSQL for Structured Queries

PostgreSQL is used for queries requiring filtering, sorting, joining, and aggregation:

```java
// Account summary projection — optimised for dashboard queries
@Entity
@Table(name = "account_summary_view",
       indexes = {
           @Index(columnList = "customer_id"),
           @Index(columnList = "status"),
           @Index(columnList = "last_activity_at DESC")
       })
public class AccountSummaryView {

    @Id
    private String accountId;
    private String customerId;
    private String accountType;
    private BigDecimal balance;
    private String currency;
    private String status;
    private int transactionCount;
    private BigDecimal totalDeposited;
    private BigDecimal totalWithdrawn;
    private Instant createdAt;
    private Instant lastActivityAt;
    private long eventVersion; // For idempotent updates
}

@Component
public class AccountSummaryProjection {

    @Autowired private AccountSummaryViewRepository viewRepository;

    @KafkaListener(
        topics = "account-events",
        groupId = "account-summary-projection",
        containerFactory = "kafkaListenerContainerFactory"
    )
    @Transactional
    public void project(ConsumerRecord<String, String> record) {
        EventEnvelope envelope = parseEnvelope(record.value());

        // Idempotency guard
        if (isAlreadyProcessed(envelope.eventId())) return;

        switch (envelope.eventType()) {
            case "AccountCreated" -> {
                AccountCreated e = parse(envelope, AccountCreated.class);
                viewRepository.save(new AccountSummaryView(
                        e.accountId(), e.customerId(), e.accountType(),
                        e.initialBalance(), e.currency(), "ACTIVE",
                        0, BigDecimal.ZERO, BigDecimal.ZERO,
                        e.occurredAt(), e.occurredAt(), e.version()
                ));
            }
            case "FundsDeposited" -> {
                FundsDeposited e = parse(envelope, FundsDeposited.class);
                viewRepository.applyDeposit(e.accountId(), e.amount(),
                        e.occurredAt(), e.version());
            }
            case "FundsWithdrawn" -> {
                FundsWithdrawn e = parse(envelope, FundsWithdrawn.class);
                viewRepository.applyWithdrawal(e.accountId(), e.amount(),
                        e.occurredAt(), e.version());
            }
        }
    }
}

public interface AccountSummaryViewRepository extends JpaRepository<AccountSummaryView, String> {

    @Modifying
    @Query("""
        UPDATE AccountSummaryView v SET
            v.balance = v.balance + :amount,
            v.totalDeposited = v.totalDeposited + :amount,
            v.transactionCount = v.transactionCount + 1,
            v.lastActivityAt = :occurredAt,
            v.eventVersion = :version
        WHERE v.accountId = :accountId AND v.eventVersion < :version
        """)
    int applyDeposit(@Param("accountId") String accountId,
                     @Param("amount") BigDecimal amount,
                     @Param("occurredAt") Instant occurredAt,
                     @Param("version") long version);

    List<AccountSummaryView> findByCustomerIdOrderByLastActivityAtDesc(String customerId);

    @Query("SELECT v FROM AccountSummaryView v WHERE v.balance > :threshold AND v.status = 'ACTIVE'")
    List<AccountSummaryView> findHighValueAccounts(@Param("threshold") BigDecimal threshold);
}
```

---

## Read Model: Redis for Real-Time Dashboards

Redis provides sub-millisecond reads for live dashboards and hot-path queries:

```java
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.kafka.annotation.KafkaListener;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;

@Component
public class RealTimeDashboardProjection {

    @Autowired private RedisTemplate<String, String> redisTemplate;
    @Autowired private ObjectMapper objectMapper;

    private static final String ACCOUNT_KEY_PREFIX = "account:";
    private static final String BALANCE_HASH_FIELD = "balance";
    private static final Duration TTL = Duration.ofHours(24);

    @KafkaListener(
        topics = "account-events",
        groupId = "realtime-dashboard-projection"
    )
    public void project(ConsumerRecord<String, String> record) {
        EventEnvelope envelope = parseEnvelope(record.value());
        String redisKey = ACCOUNT_KEY_PREFIX + envelope.aggregateId();

        switch (envelope.eventType()) {
            case "AccountCreated" -> {
                AccountCreated e = parse(envelope, AccountCreated.class);
                Map<String, String> accountData = Map.of(
                        "accountId", e.accountId(),
                        "customerId", e.customerId(),
                        "balance", e.initialBalance().toPlainString(),
                        "currency", e.currency(),
                        "status", "ACTIVE",
                        "version", String.valueOf(e.version())
                );
                redisTemplate.opsForHash().putAll(redisKey, accountData);
                redisTemplate.expire(redisKey, TTL);
            }
            case "FundsDeposited" -> {
                FundsDeposited e = parse(envelope, FundsDeposited.class);
                // Atomic increment — race-condition safe
                redisTemplate.opsForHash().increment(
                        redisKey, BALANCE_HASH_FIELD,
                        e.amount().doubleValue()
                );
                redisTemplate.opsForHash().put(redisKey, "version", String.valueOf(e.version()));
                redisTemplate.expire(redisKey, TTL); // Refresh TTL on activity
            }
            case "FundsWithdrawn" -> {
                FundsWithdrawn e = parse(envelope, FundsWithdrawn.class);
                redisTemplate.opsForHash().increment(
                        redisKey, BALANCE_HASH_FIELD,
                        -e.amount().doubleValue()
                );
                redisTemplate.opsForHash().put(redisKey, "version", String.valueOf(e.version()));
            }
        }
    }

    // Query method — returns in < 1ms from Redis
    public AccountDashboardView getAccountDashboard(String accountId) {
        String redisKey = ACCOUNT_KEY_PREFIX + accountId;
        Map<Object, Object> data = redisTemplate.opsForHash().entries(redisKey);

        if (data.isEmpty()) {
            // Cache miss — fall back to PostgreSQL
            return loadFromPostgres(accountId);
        }

        return new AccountDashboardView(
                (String) data.get("accountId"),
                new BigDecimal((String) data.get("balance")),
                (String) data.get("currency"),
                (String) data.get("status")
        );
    }
}
```

---

## Read Model: Elasticsearch for Transaction Search

Elasticsearch enables full-text and faceted search over payment transactions:

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.*;
import org.springframework.stereotype.Component;

@Component
public class TransactionSearchProjection {

    @Autowired private ElasticsearchClient elasticsearchClient;

    private static final String INDEX = "payment-transactions";

    @KafkaListener(
        topics = "account-events",
        groupId = "transaction-search-projection"
    )
    public void project(ConsumerRecord<String, String> record) {
        EventEnvelope envelope = parseEnvelope(record.value());

        switch (envelope.eventType()) {
            case "FundsDeposited" -> indexTransaction(envelope, "CREDIT");
            case "FundsWithdrawn" -> indexTransaction(envelope, "DEBIT");
            case "TransferInitiated" -> indexTransfer(envelope);
        }
    }

    private void indexTransaction(EventEnvelope envelope, String direction) {
        Map<String, Object> doc = new HashMap<>();
        doc.put("accountId", envelope.aggregateId());
        doc.put("direction", direction);
        doc.put("eventType", envelope.eventType());
        doc.put("timestamp", envelope.occurredAt());
        doc.put("@timestamp", envelope.occurredAt()); // Kibana compatibility

        try {
            elasticsearchClient.index(i -> i
                    .index(INDEX)
                    .id(envelope.eventId())  // Idempotent — same eventId = overwrite
                    .document(doc)
            );
        } catch (IOException e) {
            log.error("Failed to index transaction event {}", envelope.eventId(), e);
            throw new ProjectionException("Elasticsearch indexing failed", e);
        }
    }

    // Query: find all transactions for an account in a date range
    public List<TransactionSearchResult> searchTransactions(
            String accountId, Instant from, Instant to, String query) {
        try {
            SearchResponse<Map> response = elasticsearchClient.search(s -> s
                    .index(INDEX)
                    .query(q -> q
                            .bool(b -> b
                                    .must(m -> m.term(t -> t.field("accountId").value(accountId)))
                                    .must(m -> m.range(r -> r
                                            .field("timestamp")
                                            .gte(JsonData.of(from.toString()))
                                            .lte(JsonData.of(to.toString()))
                                    ))
                                    .should(sh -> sh.match(mt -> mt
                                            .field("merchantName").query(query)
                                    ))
                            )
                    )
                    .size(100)
                    .sort(so -> so.field(f -> f.field("timestamp").order(SortOrder.Desc))),
                    Map.class
            );

            return response.hits().hits().stream()
                    .map(hit -> TransactionSearchResult.from(hit.source()))
                    .collect(Collectors.toList());
        } catch (IOException e) {
            throw new SearchException("Transaction search failed", e);
        }
    }
}
```

---

## Handling Projection Lag

Read models are **eventually consistent** — there is a delay between a command completing and the read model reflecting the change. In financial UIs, this can confuse users.

```java
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/accounts")
public class AccountQueryController {

    @Autowired private AccountSummaryViewRepository viewRepository;
    @Autowired private KafkaLagMonitor lagMonitor;

    @GetMapping("/{accountId}/balance")
    public ResponseEntity<BalanceResponse> getBalance(
            @PathVariable String accountId,
            @RequestHeader(value = "X-Wait-For-Version", required = false) Long waitForVersion) {

        // If client specifies a minimum version, wait for the projection to catch up
        if (waitForVersion != null) {
            boolean caught = waitForProjection(accountId, waitForVersion, Duration.ofSeconds(5));
            if (!caught) {
                return ResponseEntity.status(202) // Accepted — still processing
                        .header("X-Current-Version",
                                String.valueOf(getCurrentVersion(accountId)))
                        .body(null);
            }
        }

        AccountSummaryView view = viewRepository.findById(accountId)
                .orElseThrow(() -> new AccountNotFoundException(accountId));

        return ResponseEntity.ok(new BalanceResponse(
                view.getBalance(),
                view.getCurrency(),
                view.getEventVersion(),
                lagMonitor.getProjectionLagMs("account-summary-projection")
        ));
    }

    private boolean waitForProjection(String accountId, long requiredVersion,
            Duration timeout) {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            long currentVersion = getCurrentVersion(accountId);
            if (currentVersion >= requiredVersion) return true;
            try { Thread.sleep(50); } catch (InterruptedException e) { break; }
        }
        return false;
    }

    private long getCurrentVersion(String accountId) {
        return viewRepository.findById(accountId)
                .map(AccountSummaryView::getEventVersion)
                .orElse(0L);
    }
}
```

**Strategy for handling lag in production:**

1. **Optimistic UI update** — update the client UI immediately, don't wait for the read model
2. **Version header pattern** — the write response includes the event version; the read request includes `X-Wait-For-Version`
3. **Acceptable lag SLA** — define the maximum allowed lag (e.g., 500ms), alert when exceeded
4. **Lag monitoring** — expose projection lag as a metric (see Lesson 17)

---

## Projection Versioning — Rebuilding When Models Change

When a projection schema changes (new fields, restructured queries), you need to rebuild the read model from the event stream. This is a key benefit of event sourcing: the event log is the source of truth.

```java
@Service
public class ProjectionRebuildService {

    @Autowired private KafkaAdmin kafkaAdmin;
    @Autowired private AccountSummaryViewRepository viewRepository;

    /**
     * Rebuild a projection from scratch.
     * Steps:
     * 1. Create a new consumer group
     * 2. Reset offsets to earliest
     * 3. Replay all events into the new projection
     * 4. Switch the application to use the new read model
     */
    public void rebuildAccountSummaryProjection() {
        String newGroupId = "account-summary-projection-v2";
        String topic = "account-events";

        // Step 1: Clear existing read model (or build to a parallel table)
        log.info("Clearing existing account_summary_v2 view");
        viewRepository.deleteAll(); // Or: use a versioned table account_summary_view_v2

        // Step 2: Create a new consumer group starting from offset 0
        // This is configured in Kafka consumer properties:
        // group.id = account-summary-projection-v2
        // auto.offset.reset = earliest

        // Step 3: The @KafkaListener with the new groupId will replay all events
        // Monitor progress via consumer group lag
        log.info("Rebuild initiated. Monitor consumer group {} lag to track progress.",
                newGroupId);

        // Step 4: Once lag reaches 0, switch traffic to new read model
        // This can be done via a feature flag or DNS swap
    }
}
```

**Zero-downtime projection rebuild:**

```
Phase 1: Run V1 and V2 projections simultaneously
  - V2 consumer group starts replaying from offset 0
  - V1 continues serving queries
  - V2 is dual-writing to account_summary_view_v2 table

Phase 2: V2 catches up (lag → 0)
  - Verify data correctness in V2 table

Phase 3: Switch traffic
  - Update application to query account_summary_view_v2
  - Decommission V1 projection consumer
  - Drop account_summary_view table after verification period
```

---

## Multiple Read Models from One Event Stream

The same Kafka topic powers multiple independent projections:

```
                              account-events topic
                                       │
           ┌───────────────────────────┼──────────────────────────────┐
           ▼                           ▼                              ▼
account-summary-projection    transaction-history-projection    fraud-scoring-projection
(PostgreSQL: dashboard)       (PostgreSQL: statements)          (Redis: real-time scoring)
           │                           │                              │
           ▼                           ▼                              ▼
 SELECT balance, status        SELECT * FROM history         HGET account:123 risk_score
 WHERE account_id=?            WHERE account_id=?
 AND status='ACTIVE'           AND date BETWEEN ? AND ?
```

Each projection team owns their read model. The payment event team owns the write side. They are coupled only by the event contract (schema).

---

## Consistency Guarantees for Queries

| Scenario | Consistency Level | Mechanism |
|----------|------------------|-----------|
| Read after write (same service) | Strong | Query write store directly after command |
| Read from projection | Eventual | Standard consumer lag (typically <500ms) |
| Cross-service read | Eventual | Projection + version polling |
| Analytics queries | Eventual (minutes) | Kafka → S3 → analytical store |

---

## Key Takeaways

- CQRS separates the write path (commands, event store) from the read path (projections, query models).
- Kafka is the event bus that connects them — events flow from commands to materialise multiple read models.
- **PostgreSQL** handles structured queries; **Redis** handles real-time sub-millisecond queries; **Elasticsearch** handles full-text and faceted search.
- Projections are eventual — use version headers and optimistic UI updates to manage the consistency gap.
- Each read model is an independent consumer group — teams own their projections, decoupled from the write side.
- Projection rebuilding is straightforward in event sourcing — create a new consumer group, reset to earliest, replay.
- Never block the write path waiting for projections to update — the write side must remain fast and correct.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the fundamental purpose of CQRS in a financial event-driven system?",
      "options": [
        "To eliminate the need for a database by storing all state in Kafka",
        "To separate the write path (correctness-focused) from the read path (performance-focused)",
        "To ensure strong consistency between the command handler and all read models",
        "To replace microservices with a monolithic event processor"
      ],
      "correct": 1,
      "explanation": "CQRS separates the write model (optimised for correctness: normalized DB, transactional consistency) from the read model (optimised for query performance: denormalized, indexed for specific patterns). The command side emits events that flow via Kafka to materialise multiple specialized read models."
    },
    {
      "text": "When a client needs to read its own write immediately after a command, what strategy handles projection lag correctly?",
      "options": [
        "Block the command handler until the projection is updated",
        "Return the event version in the command response and use X-Wait-For-Version header on subsequent reads",
        "Use strong consistency mode in the read model database",
        "Disable Kafka consumer batching to minimize lag"
      ],
      "correct": 1,
      "explanation": "The version header pattern returns the event version in the command response. Subsequent read requests include X-Wait-For-Version, allowing the query side to poll until the projection has applied up to that version, handling the eventual consistency gap without blocking the write path."
    },
    {
      "text": "How do you rebuild a projection when its schema changes in an event-sourced CQRS system?",
      "options": [
        "Modify the existing consumer group and replay from the current offset",
        "Manually re-import data from the write-side database",
        "Create a new consumer group with auto.offset.reset=earliest to replay all events into a new read model table",
        "Delete all events and re-create them with the new schema"
      ],
      "correct": 2,
      "explanation": "Because the event log is the source of truth, you can rebuild any projection at any time by creating a new consumer group starting from offset 0 (earliest). The new group replays all events into a new read model table, while the old projection continues serving queries until the new one catches up."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Multi-Read-Model CQRS System for Account Queries",
  "difficulty": "advanced",
  "estimatedMinutes": 65,
  "tasks": [
    {"id": "1", "description": "Implement an AccountSummaryProjection consumer group that maintains a PostgreSQL account_summary_view table with denormalized fields (balance, totalDeposited, totalWithdrawn, transactionCount, lastActivityAt). Use optimistic locking via event version in UPDATE statements to ensure idempotent processing."},
    {"id": "2", "description": "Build a RealTimeDashboardProjection that uses Redis HSET/HINCRBYFLOAT for sub-millisecond balance reads. Handle cache misses with a PostgreSQL fallback. Implement TTL refresh on every account activity event."},
    {"id": "3", "description": "Create a TransactionSearchProjection that indexes FundsDeposited, FundsWithdrawn, and TransferInitiated events into Elasticsearch. Use the event ID as the document ID for idempotent indexing. Implement a searchTransactions(accountId, from, to, query) method using the bool/must/range query pattern."},
    {"id": "4", "description": "Implement the X-Wait-For-Version pattern in the AccountQueryController: the command response returns the event version; a subsequent GET /balance request with X-Wait-For-Version header polls the projection (max 5 seconds) until the version is reached, returning HTTP 202 if the timeout is exceeded."}
  ]
}
-->
