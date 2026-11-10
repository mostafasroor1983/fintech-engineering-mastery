---
id: track-02-lesson-22
title: "Principal Engineer's Distributed Systems Decision Framework"
slug: distributed-systems-decision-framework
track: track-02
trackName: Distributed Systems Engineering
sequence: 22
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, distributed-systems, trade-offs, staff-engineer, CAP]
prerequisites: []
---

# Principal Engineer's Distributed Systems Decision Framework

> [!NOTE]
> The mark of a principal engineer in distributed systems is not knowing every algorithm — it is knowing which algorithm to reach for in which situation, and being able to articulate the trade-offs clearly enough that your team can make informed decisions independently. This lesson is a structured decision framework, not new theory.

## The Core Problem: Decisions Are Permanent

Most distributed systems architectural decisions are **sticky**. Choosing Cassandra over PostgreSQL, event sourcing over CRUD, or async over synchronous communication is not a decision you can reverse next quarter. The cost of migration increases exponentially with data volume, team size, and customer count.

This means the cost of a wrong distributed systems decision is not just technical — it is organizational, financial, and temporal. A framework that forces explicit trade-off articulation before commitment is not bureaucracy; it is risk management.

---

## The Framework: Five Questions Before Any Distributed Systems Decision

### Question 1: What is the Consistency Requirement?

Before selecting any distributed technology, classify the data or operation:

```
Consistency Classification for Financial Data:

LINEARIZABLE (Strongest)
  - Balance reads during payment authorization
  - Idempotency key claims
  - Risk limit checks
  - Fraud rule enforcement
  → Technology: PostgreSQL with synchronous replication, etcd, Cassandra SERIAL,
                CockroachDB, Spanner

STRONG (Sequential Consistency)
  - Transaction recording
  - Ledger entries
  - Settlement records
  → Technology: PostgreSQL, Cassandra LOCAL_QUORUM, CockroachDB

CAUSAL
  - Payment status updates visible after the status is set
  - Notification delivery after payment completes
  → Technology: Cassandra LOCAL_QUORUM, Kafka (ordered by partition), DynamoDB

EVENTUAL
  - Balance display on dashboard
  - Transaction history queries
  - Reporting and analytics
  - Fraud model scoring (batch)
  → Technology: Cassandra LOCAL_ONE, DynamoDB eventually consistent,
                Elasticsearch, read replicas
```

```java
@Component
public class ConsistencyRequirementClassifier {

    public ConsistencyLevel classifyOperation(FinancialOperation operation) {
        return switch (operation.type()) {
            // Must be linearizable — wrong answer is a financial error
            case PAYMENT_AUTHORIZATION_READ    -> ConsistencyLevel.LINEARIZABLE;
            case IDEMPOTENCY_KEY_CLAIM         -> ConsistencyLevel.LINEARIZABLE;
            case RISK_LIMIT_CHECK              -> ConsistencyLevel.LINEARIZABLE;
            case BALANCE_CHECK_FOR_DEBIT       -> ConsistencyLevel.LINEARIZABLE;

            // Strong consistency — ordering matters, stale data is unacceptable
            case LEDGER_ENTRY_WRITE            -> ConsistencyLevel.STRONG;
            case SETTLEMENT_RECORD             -> ConsistencyLevel.STRONG;
            case COMPLIANCE_EVENT              -> ConsistencyLevel.STRONG;

            // Causal — events must appear in order to observers
            case PAYMENT_STATUS_UPDATE         -> ConsistencyLevel.CAUSAL;
            case NOTIFICATION_DELIVERY         -> ConsistencyLevel.CAUSAL;

            // Eventual — slight staleness is acceptable
            case BALANCE_DASHBOARD_DISPLAY     -> ConsistencyLevel.EVENTUAL;
            case TRANSACTION_HISTORY_QUERY     -> ConsistencyLevel.EVENTUAL;
            case ANALYTICS_READ                -> ConsistencyLevel.EVENTUAL;
        };
    }
}
```

### Question 2: What is the Availability Requirement During Partition?

CAP theorem forces a choice between consistency and availability when a network partition occurs. This choice should be explicit and documented, not accidentally made by a default configuration.

```
CAP Decision Matrix for Financial Operations:

OPERATION                    | PARTITION BEHAVIOR    | RATIONALE
-----------------------------|----------------------|---------------------------
Payment authorization        | Reject (CP)          | Cannot risk double charge
Balance debit                | Reject (CP)          | Cannot risk overdraft
Idempotency check            | Reject (CP)          | Cannot risk duplicate
Risk limit enforcement       | Reject (CP)          | Cannot exceed limits

Payment status query         | Serve stale (AP)     | Stale status < 503 to customer
Transaction history          | Serve stale (AP)     | Customer tolerates slight delay
Exchange rate display        | Serve stale (AP)     | Indicative rate OK; execution uses live
Fraud score lookup (non-block)| Serve default (AP)  | Allow with conservative fallback
```

```java
@Service
public class PartitionBehaviorPolicy {

    private final FeatureFlagClient featureFlags;

    /**
     * Defines what each operation does during a network partition.
     * This must be an explicit, reviewed decision — not an accident.
     */
    public PartitionResponse handlePartition(FinancialOperation operation) {
        return switch (operation.type()) {
            case PAYMENT_AUTHORIZATION -> {
                // CP: reject with 503 Retry-After
                yield PartitionResponse.reject(
                    "Payment system temporarily unavailable due to network partition. " +
                    "Your account has NOT been charged. Please retry in 30 seconds.",
                    Duration.ofSeconds(30)
                );
            }
            case FRAUD_SCORE_LOOKUP -> {
                // AP with fallback: return a conservative default score
                FraudScore fallback = featureFlags.isEnabled("fraud-fallback-allow-all")
                    ? FraudScore.LOW_RISK_DEFAULT
                    : FraudScore.HIGH_RISK_DEFAULT;
                yield PartitionResponse.serveDefault(fallback);
            }
            case EXCHANGE_RATE_QUERY -> {
                // AP: serve last known rate with staleness header
                ExchangeRate cachedRate = localCache.getLastKnown(operation.currencyPair());
                yield PartitionResponse.serveStale(cachedRate, Duration.ofMinutes(5));
            }
            case TRANSACTION_HISTORY -> {
                // AP: serve from local replica even if possibly stale
                yield PartitionResponse.serveStale(null, Duration.ofMinutes(1));
            }
        };
    }
}
```

### Question 3: What is the Latency Budget?

Distributed operations add latency at every hop. The latency budget for a financial transaction constrains which technologies and patterns are viable.

```
Latency Budget: Payment Authorization (target: p99 < 300ms)

Component                      | Budget  | Technology Choice Implications
-------------------------------|---------|--------------------------------
API gateway overhead           | 5ms     | -
Auth/JWT validation            | 5ms     | Local validation only (no remote call)
Idempotency check              | 15ms    | Redis or Cassandra SERIAL (< 20ms)
Fraud score lookup             | 50ms    | Pre-scored or cached, circuit breaker
Account balance check          | 30ms    | PostgreSQL primary, indexed lookup
Payment write (DB)             | 50ms    | Synchronous replication write
Kafka publish (async OK)       | 10ms    | Fire-and-forget (async ack)
Response serialization         | 5ms     | -
Network (internal)             | 20ms    | Same-region only
Buffer / p99 headroom          | 110ms   | For GC pauses, lock contention
-------------------------------|---------|--------------------------------
Total                          | 300ms   | ✓ Fits budget
```

```java
@Service
public class LatencyBudgetEnforcer {

    private final MeterRegistry meterRegistry;

    /**
     * Wraps a downstream call with a strict timeout derived from the latency budget.
     * If the call exceeds the budget, it fails fast rather than cascading the latency.
     */
    public <T> T callWithBudget(String operationName,
                                 Duration budget,
                                 Callable<T> operation,
                                 Supplier<T> fallback) {
        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            T result = CompletableFuture
                .supplyAsync(() -> {
                    try { return operation.call(); }
                    catch (Exception e) { throw new RuntimeException(e); }
                })
                .orTimeout(budget.toMillis(), TimeUnit.MILLISECONDS)
                .join();

            sample.stop(meterRegistry.timer(operationName + ".latency",
                "result", "success"));
            return result;

        } catch (CompletionException e) {
            sample.stop(meterRegistry.timer(operationName + ".latency",
                "result", "timeout"));
            log.warn("Operation {} exceeded budget of {}ms — using fallback",
                operationName, budget.toMillis());
            return fallback.get();
        }
    }
}
```

### Question 4: Synchronous or Asynchronous?

This is one of the most consequential decisions in a distributed payment system. Synchronous communication makes reasoning about consistency easier but increases coupling and latency. Asynchronous communication improves resilience and throughput but requires explicit handling of eventual consistency and failure modes.

```
Decision: Synchronous vs Asynchronous

USE SYNCHRONOUS when:
  ✓ The caller needs the result to proceed (payment authorization response)
  ✓ The operation must succeed or fail atomically within the caller's transaction
  ✓ Latency is bounded and within SLA
  ✓ The callee is in the same availability zone (< 5ms network hop)
  ✗ Avoid if callee can be slow (adds latency to every caller)
  ✗ Avoid if callee can fail independently (couples availability)

USE ASYNCHRONOUS (Kafka/messaging) when:
  ✓ Caller does not need the result immediately
  ✓ The operation can be retried independently on failure
  ✓ The operation is idempotent (or can be made so)
  ✓ You want to decouple throughput between producer and consumer
  ✓ Multiple consumers need to react to the same event
  ✗ Avoid if the caller must know immediately whether the operation succeeded
  ✗ Avoid without an explicit plan for handling consumer failures
```

```java
@Service
public class PaymentOrchestrationService {

    private final FraudDetectionClient fraudClient;        // Sync: needed to authorize
    private final AccountLedgerService ledgerService;      // Sync: needed for debit
    private final KafkaTemplate<String, Object> kafka;     // Async: post-authorization
    private final NotificationService notificationService; // Async: OK to be eventual

    @Transactional
    public AuthorizationResult authorize(PaymentRequest request) {
        // SYNCHRONOUS: fraud check is on the critical path
        // We cannot authorize without it
        FraudAssessment fraud = fraudClient.assess(request);
        if (fraud.isHighRisk()) {
            return AuthorizationResult.declined("Fraud risk too high");
        }

        // SYNCHRONOUS: balance debit must be atomic with authorization
        // Doing this async would create a window for race conditions
        DebitResult debit = ledgerService.debit(
            request.accountId(), request.amount(), request.idempotencyKey());
        if (!debit.isSuccessful()) {
            return AuthorizationResult.declined(debit.reason());
        }

        // ASYNCHRONOUS: downstream processing does not affect authorization result
        // Publish to Kafka — consumers handle these independently with retry
        kafka.send("payment-authorized",
            request.paymentId(),
            PaymentAuthorizedEvent.from(request, debit));

        // ASYNCHRONOUS: notification is best-effort
        // OK if the SMS/email arrives 1-2 seconds late
        CompletableFuture.runAsync(() ->
            notificationService.sendPaymentConfirmation(request));

        return AuthorizationResult.approved(debit.transactionId());
    }
}
```

### Question 5: Distributed Transactions or Sagas?

The two patterns for maintaining consistency across multiple services:

```
DISTRIBUTED TRANSACTIONS (2PC/XA):
  ✓ Atomic: all services commit or all roll back
  ✓ Familiar: developers know ACID semantics
  ✗ Blocking: coordinator failure leaves resources locked
  ✗ Availability: all participants must be available simultaneously
  ✗ Scalability: does not work across polyglot stores or external APIs
  → Best for: single-database multi-table updates, same-service multi-step

SAGAS:
  ✓ Available: each step is a local transaction; partial failures are recoverable
  ✓ Scalable: each service manages its own data
  ✓ Works with external systems (bank APIs, card networks)
  ✗ Eventually consistent: intermediate states are visible
  ✗ Complex compensating transactions must be explicitly designed
  ✗ Harder to reason about failure modes
  → Best for: multi-service business workflows (payment, transfer, refund)
```

```java
// Saga implementation for a cross-border payment
@Service
public class CrossBorderPaymentSaga {

    // Each step: local transaction + compensation

    // Step 1: Debit source account
    public DebitResult debitSourceAccount(SagaContext ctx) {
        return accountService.debit(
            ctx.sourceAccount(), ctx.amountCents(), ctx.sagaId());
    }

    public void compensateDebit(SagaContext ctx) {
        // Compensation: reverse the debit
        accountService.credit(
            ctx.sourceAccount(), ctx.amountCents(), ctx.sagaId() + "-compensation");
    }

    // Step 2: Convert currency (calls external FX provider)
    public FxConversionResult convertCurrency(SagaContext ctx, DebitResult debit) {
        return fxProvider.convert(
            ctx.amountCents(), ctx.sourceCurrency(), ctx.targetCurrency());
    }

    public void compensateFxConversion(SagaContext ctx, FxConversionResult fx) {
        // Compensation: reverse FX (reverse rate, fees may apply)
        fxProvider.reverseConversion(fx.conversionId());
    }

    // Step 3: Credit destination account
    public void creditDestinationAccount(SagaContext ctx, FxConversionResult fx) {
        accountService.credit(
            ctx.destinationAccount(), fx.convertedAmountCents(), ctx.sagaId());
    }

    public void compensateCreditDestination(SagaContext ctx, FxConversionResult fx) {
        // Compensation: debit back destination account
        // NOTE: this may fail if the customer has already spent the funds
        // → requires human intervention or escrow mechanism
        try {
            accountService.debit(
                ctx.destinationAccount(), fx.convertedAmountCents(),
                ctx.sagaId() + "-reversal");
        } catch (InsufficientFundsException e) {
            log.error("SAGA COMPENSATION FAILED: cannot debit destination account {}. " +
                "Manual intervention required. Saga: {}",
                ctx.destinationAccount(), ctx.sagaId());
            complianceAlerter.flagForManualReview(ctx.sagaId());
        }
    }
}
```

---

## The Decision Checklist

This checklist should be completed for any new distributed system component or significant architectural change:

```java
/**
 * Distributed Systems Architecture Decision Record (ADR) Template
 * Adapt this for your team's ADR process.
 */
public class DistributedSystemsAdr {

    // === CONSISTENCY ===
    // [ ] What consistency level is required for each operation?
    //     (Linearizable / Strong / Causal / Eventual)
    // [ ] Is eventual consistency acceptable for READ operations? (dashboard, history)
    // [ ] Does the data type have natural conflict resolution? (last-write-wins OK?)

    // === AVAILABILITY ===
    // [ ] What should happen during a network partition? (reject / serve stale / fallback)
    // [ ] What is the acceptable downtime per year? (99.9% = 8.7h, 99.99% = 52m)
    // [ ] Is the system CP or AP? Is this choice documented?

    // === LATENCY ===
    // [ ] What is the p99 latency budget for each operation?
    // [ ] Have timeouts been explicitly set at each service boundary?
    // [ ] Has the latency been measured under realistic load?

    // === SYNCHRONY ===
    // [ ] Is each service call synchronous or asynchronous? Why?
    // [ ] Are idempotency keys implemented for all async operations?
    // [ ] Is there a dead-letter queue for failed async messages?

    // === TRANSACTIONS ===
    // [ ] Does the operation span multiple services / databases?
    // [ ] If yes: distributed transaction or saga? Why?
    // [ ] Are compensating transactions designed for all saga steps?
    // [ ] Can a saga step fail without compensation possible? (escalation path?)

    // === REPLICATION ===
    // [ ] How many replicas? What is the replication factor?
    // [ ] Synchronous or asynchronous replication?
    // [ ] What is the RPO (Recovery Point Objective)?
    // [ ] What is the RTO (Recovery Time Objective)?

    // === FAILURE MODES ===
    // [ ] What happens if a downstream service is unavailable?
    //     (circuit breaker / retry / fallback / fail open / fail closed)
    // [ ] What happens during split-brain?
    // [ ] Has chaos testing validated the failure behavior?

    // === OBSERVABILITY ===
    // [ ] Are SLIs defined and instrumented?
    // [ ] Is distributed tracing configured across all hops?
    // [ ] Are alerts configured for SLO violations?
}
```

---

## CAP Theorem in Practice: The PACELC Extension

The **PACELC theorem** extends CAP by noting that even when there is no partition, there is a latency vs. consistency trade-off:

```
PACELC: If Partition → (Availability vs Consistency)
        Else         → (Latency vs Consistency)

System Examples:
  DynamoDB:       PA / EL  — Available during partition, low latency normally (eventual)
  DynamoDB (SC):  PC / EC  — Consistent during partition, higher latency for consistency
  Cassandra (Q):  PC / EC  — Quorum reads/writes: consistent, adds latency
  Cassandra (1):  PA / EL  — ONE read/write: available, low latency, eventual
  PostgreSQL sync: PC / EC  — Synchronous replication: consistent, adds ~1-5ms
  PostgreSQL async:PA / EL  — Async replication: available, lower latency, slight lag
  Spanner/CockroachDB: PC / EC — Always consistent, pays latency for it
```

```java
@Component
public class PacelcTechnologySelector {

    /**
     * Maps PACELC preferences to technology recommendations
     * for financial system components.
     */
    public TechnologyRecommendation recommend(DataAccessPattern pattern) {

        if (pattern.requiresLinearizability() && pattern.toleratesHigherLatency()) {
            return TechnologyRecommendation.builder()
                .primary("CockroachDB or Google Spanner")
                .alternative("PostgreSQL with synchronous replication")
                .pacelc("PC/EC")
                .note("Payment authorization, ledger writes — correctness over speed")
                .build();
        }

        if (pattern.requiresStrongConsistency() && pattern.isLatencySensitive()) {
            return TechnologyRecommendation.builder()
                .primary("PostgreSQL with read replicas")
                .alternative("Cassandra LOCAL_QUORUM")
                .pacelc("PC/EC")
                .note("Acceptable latency with strong consistency via synchronous replication")
                .build();
        }

        if (pattern.toleratesEventualConsistency() && pattern.requiresHighThroughput()) {
            return TechnologyRecommendation.builder()
                .primary("Cassandra LOCAL_ONE")
                .alternative("DynamoDB eventually consistent")
                .pacelc("PA/EL")
                .note("Transaction history, balance display — high read throughput")
                .build();
        }

        if (pattern.requiresLinearizableCoordination() && pattern.isLowThroughput()) {
            return TechnologyRecommendation.builder()
                .primary("etcd or ZooKeeper")
                .alternative("Redis with RedLock")
                .pacelc("PC/EC")
                .note("Distributed locks, leader election, configuration")
                .build();
        }

        throw new UnclassifiablePatternException(
            "Cannot recommend technology for pattern: " + pattern.describe() +
            ". Please classify consistency and latency requirements explicitly.");
    }
}
```

---

## Common Anti-Patterns in Financial Distributed Systems

### Anti-Pattern 1: The Distributed Monolith

Microservices that call each other synchronously in a chain of 7+ hops for a single payment:

```
Payment API → Auth Service → Fraud Service → Account Service →
Ledger Service → Notification Service → Analytics Service
(all synchronous, all blocking)

Problems:
- Availability: 7 services at 99.9% each = 99.3% combined
- Latency: each hop adds 10-50ms
- Failure coupling: any service failure fails the entire payment
```

```java
// Refactored: parallelize independent calls, async for non-critical
@Service
public class PaymentApiService {

    public AuthorizationResult authorize(PaymentRequest request) {
        // Run independent checks in parallel to reduce latency
        CompletableFuture<FraudAssessment> fraudFuture =
            CompletableFuture.supplyAsync(() -> fraudService.assess(request));
        CompletableFuture<RiskAssessment> riskFuture =
            CompletableFuture.supplyAsync(() -> riskService.assess(request));

        // Wait for both (parallel)
        FraudAssessment fraud = fraudFuture.join();
        RiskAssessment risk = riskFuture.join();

        if (fraud.isHighRisk() || risk.isAboveLimit()) {
            return AuthorizationResult.declined("Risk threshold exceeded");
        }

        // Critical path: account debit (must be synchronous)
        DebitResult debit = accountService.debit(request);

        // Post-authorization: fire and forget (async)
        kafka.send("payment-authorized", PaymentAuthorizedEvent.from(request, debit));

        return AuthorizationResult.approved(debit.transactionId());
    }
}
```

### Anti-Pattern 2: Shared Database Anti-Pattern

Multiple microservices sharing the same database schema defeats the purpose of service autonomy:

```sql
-- Anti-pattern: fraud-service and account-service both write to this table
-- This creates implicit coupling and prevents independent deployment
CREATE TABLE accounts (
    account_id    UUID PRIMARY KEY,
    balance_cents BIGINT,
    fraud_score   DECIMAL,     -- fraud-service writes this
    risk_level    VARCHAR(20), -- risk-service writes this
    last_login    TIMESTAMP    -- auth-service writes this
);

-- Correct: each service owns its own tables
-- account-service:
CREATE TABLE account_balances (account_id UUID, balance_cents BIGINT);

-- fraud-service (its own database or schema):
CREATE TABLE fraud_assessments (account_id UUID, fraud_score DECIMAL);
```

### Anti-Pattern 3: Missing Idempotency for Async Operations

Kafka messages are delivered at-least-once. Without idempotency, any consumer that crashes mid-processing will process the message again on restart, potentially executing the same payment twice:

```java
// Anti-pattern: no idempotency check
@KafkaListener(topics = "payment-instructions")
public void processPayment(PaymentInstruction instruction) {
    ledgerService.createEntry(instruction); // May be called twice!
}

// Correct: idempotency check before processing
@KafkaListener(topics = "payment-instructions")
public void processPayment(PaymentInstruction instruction) {
    if (idempotencyStore.alreadyProcessed(instruction.idempotencyKey())) {
        log.info("Payment {} already processed — skipping duplicate message",
            instruction.idempotencyKey());
        return;
    }

    ledgerService.createEntry(instruction);
    idempotencyStore.markProcessed(instruction.idempotencyKey());
}
```

---

## Decision Framework Reference Card

```
DECISION                    QUESTIONS TO ASK                    WRONG DEFAULT
---------------------------------------------------------------------------
Consistency level?          Will stale data cause financial      Eventual
                            harm? → Yes: strong consistency

Sync vs async?              Does caller need result now?         Synchronous
                            → No: use async + idempotency        (too chatty)

Distributed txn vs saga?    Single DB or multi-service?         2PC everywhere
                            → Multi-service: saga + compensate   (not scalable)

Replication factor?         What is RPO? What is RTO?           1 replica
                            → RPO=0: sync replication            (no HA)

Quorum?                     Read-your-writes required?          R=1,W=1
                            → Yes: R + W > N                     (no consistency)

CP or AP?                   What fails during partition?        Neither (no plan)
                            → Document decision explicitly

Timeouts?                   What is the latency budget?         No timeout
                            → Every service call has a timeout   (cascading failure)

Circuit breaker?            Can callee fail independently?      No circuit breaker
                            → Yes: circuit breaker with fallback (cascade failure)

Idempotency?                Can this operation run twice?       Not idempotent
                            → Any async/retried op: idempotent   (double processing)
```

---

## Putting It Together: Architecture Review Template

```java
/**
 * Template for a distributed systems architecture review.
 * Use this in design reviews before any significant distributed
 * system is built or modified.
 */
public class DistributedArchitectureReview {

    public ReviewResult review(ArchitectureProposal proposal) {
        List<ReviewFinding> findings = new ArrayList<>();

        // 1. Consistency check
        proposal.operations().forEach(op -> {
            if (op.consistencyLevel() == ConsistencyLevel.EVENTUAL
                    && op.isFinancialWrite()) {
                findings.add(ReviewFinding.critical(
                    "Operation " + op.name() + " is a financial write with " +
                    "eventual consistency — this will cause data loss"));
            }
        });

        // 2. Partition behavior check
        if (proposal.partitionBehavior() == null) {
            findings.add(ReviewFinding.critical(
                "No partition behavior defined — CP vs AP is undecided"));
        }

        // 3. Timeout check
        proposal.serviceCallsWithNoTimeout().forEach(call ->
            findings.add(ReviewFinding.major(
                "Service call to " + call.target() + " has no timeout — " +
                "will cascade failures")));

        // 4. Idempotency check
        proposal.asyncOperationsWithoutIdempotency().forEach(op ->
            findings.add(ReviewFinding.major(
                "Async operation " + op.name() + " is not idempotent — " +
                "will double-process on consumer restart")));

        // 5. Saga compensation check
        proposal.sagaStepsWithoutCompensation().forEach(step ->
            findings.add(ReviewFinding.major(
                "Saga step " + step.name() + " has no compensation — " +
                "partial failures will leave inconsistent state")));

        return ReviewResult.of(findings);
    }
}
```

---

## Summary

The principal engineer's role in distributed systems is not to implement every algorithm — it is to ensure that every architectural decision is made explicitly, with the trade-offs understood and documented.

The five questions form a decision protocol:

1. **Consistency**: What level is required? Classify each operation explicitly.
2. **Partition behavior**: CP or AP? Document the partition behavior policy.
3. **Latency budget**: What is the p99 target? Does the design fit within it?
4. **Synchrony**: Sync or async? Every hop must have a justified answer.
5. **Transaction scope**: Distributed transaction or saga? Design compensations.

The common failure mode for distributed financial systems is not picking the wrong algorithm — it is making these decisions **implicitly** through default configuration, copy-pasted code, or the path of least resistance. The framework above turns implicit decisions into explicit, reviewable, testable artifacts.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "According to the framework, which consistency level is required for balance reads during payment authorization?",
      "options": ["Eventual consistency", "Strong consistency (sequential)", "Linearizability", "Causal consistency"],
      "correct": 2,
      "explanation": "Payment authorization balance reads require linearizability — the strongest consistency model. Any read must reflect the most recent write globally, with no stale reads allowed. Using eventual consistency for balance checks risks overdrafts or double-spending."
    },
    {
      "text": "Why are most distributed systems architectural decisions described as 'sticky' in the framework?",
      "options": ["They require sticky sessions in the load balancer", "They are hard to reverse once data volume, team size, and customer count grow — the cost of migration increases exponentially", "They must be approved by a regulatory body before changing", "Distributed systems configurations are stored in immutable config maps"],
      "correct": 1,
      "explanation": "Choosing Cassandra over PostgreSQL, event sourcing over CRUD, or async over synchronous communication is very difficult to reverse. Data migration, API compatibility, and team retraining costs grow with scale. This is why explicit upfront decision-making is risk management, not bureaucracy."
    },
    {
      "text": "What is the first question the framework requires answering before selecting any distributed technology?",
      "options": ["What is the team's familiarity with the technology?", "What is the expected data volume at peak?", "What is the consistency requirement for the data or operation?", "What is the budget for infrastructure?"],
      "correct": 2,
      "explanation": "The framework's first question is consistency classification: is the data linearizable, strong, causal, or eventually consistent? The answer directly constrains which technologies are viable and which guarantees the system must provide."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Architecture Decision Record for a Multi-Region Payment Ledger System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Apply all five framework questions to a new multi-region payment ledger: consistency requirement, failure mode tolerance, latency budget, synchrony model, and transaction scope. Document your answers and use them to narrow technology choices to 2-3 candidates."},
    {"id": "2", "description": "Write a formal Architecture Decision Record (ADR) comparing CockroachDB vs Cassandra + Saga for the payment ledger. Address consistency guarantees, failure modes, latency impact, operational complexity, and total cost of ownership. Include a recommendation with explicit trade-offs."},
    {"id": "3", "description": "Prototype the consistency requirement verification: write a jepsen-style test for your chosen technology that injects network partitions during payment writes and verifies that no balance reads return stale data, confirming the linearizability guarantee holds under partition."},
    {"id": "4", "description": "Create a decision review checklist for your team: define 5 concrete questions that every distributed systems design proposal must answer before entering engineering review. For each question, list a failure mode that would have been prevented if the question had been asked during a past incident."}
  ]
}
-->

The hardest part of distributed systems at a financial institution is not the algorithms — it is the discipline to apply the framework consistently, under pressure, with legacy constraints, and while maintaining the trust of regulators, auditors, and customers who depend on the system being correct every single time.
