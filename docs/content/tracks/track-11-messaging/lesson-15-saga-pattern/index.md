---
id: track-11-lesson-15
title: "Saga Pattern — Choreography and Orchestration"
slug: saga-pattern
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 15
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [saga, choreography, orchestration, compensation, Axon]
prerequisites: [kafka-architecture, event-sourcing-kafka, cqrs-kafka]
---

# Saga Pattern — Choreography and Orchestration

> [!NOTE]
> Distributed transactions across microservices are impossible to do with ACID guarantees. When a payment transfer spans an account service, a fraud service, a notification service, and a settlement service, you cannot hold a database transaction open across all four. The Saga pattern provides consistency without distributed locking — but it requires careful design of compensation logic, state persistence, and failure modes.

## Why Sagas Exist

Traditional distributed transactions use two-phase commit (2PC):

```
Phase 1 (Prepare):  Coordinator asks all services to lock resources
Phase 2 (Commit):   If all say OK, coordinator tells all to commit

Problems:
  - Coordinator is a single point of failure
  - Lock contention blocks other transactions
  - Any service can be a bottleneck
  - Doesn't work across polyglot databases
  - Performance: each transaction requires 2× network round trips
```

Sagas replace 2PC with a sequence of local transactions, each of which publishes an event. If any step fails, compensating transactions undo the previous steps.

```
Payment Transfer Saga (Happy Path):
  1. Reserve funds from source account
  2. Fraud check passes
  3. Transfer funds to destination
  4. Send confirmation notification
  5. Record for settlement

Payment Transfer Saga (Failure at Step 3):
  1. Reserve funds from source account ✓
  2. Fraud check passes ✓
  3. Transfer to destination FAILS ✗
  → Compensate step 1: Release reserved funds
  → Send failure notification
```

---

## Choreography-Based Saga

In choreography, each service publishes events and other services react. There is no central coordinator.

```
Payment Service          Fraud Service           Account Service        Notification Service
     │                        │                       │                       │
     │── PaymentInitiated ────►│                       │                       │
     │                        │── FraudCheckPassed ──►│                       │
     │                        │                       │── FundsTransferred ──►│
     │                        │                       │                       │── NotificationSent
     │◄─────────────────────────────────────────────────────────────────────────────────────────│
```

### Choreography Implementation

```java
// Payment Service — publishes PaymentInitiated
@Service
public class PaymentInitiationService {

    @Autowired private PaymentRepository paymentRepository;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    @Transactional
    public Payment initiateTransfer(TransferCommand command) {
        // Reserve funds atomically
        Payment payment = new Payment(command);
        payment.setStatus(PaymentStatus.INITIATED);
        paymentRepository.save(payment);

        // Publish event — fraud service and account service will react
        kafkaTemplate.send("payments.initiated",
                payment.getId(),
                PaymentInitiated.from(payment).toJson());

        return payment;
    }

    // React to FraudCheckFailed — compensate
    @KafkaListener(topics = "fraud.checks.failed", groupId = "payment-saga")
    @Transactional
    public void onFraudCheckFailed(ConsumerRecord<String, String> record) {
        FraudCheckFailed event = FraudCheckFailed.fromJson(record.value());

        Payment payment = paymentRepository.findById(event.getPaymentId())
                .orElseThrow();
        payment.setStatus(PaymentStatus.REJECTED);
        payment.setRejectionReason("FRAUD_CHECK_FAILED: " + event.getReason());
        paymentRepository.save(payment);

        // Compensate: release reserved funds
        kafkaTemplate.send("accounts.release-funds",
                payment.getSourceAccountId(),
                ReleaseFundsCommand.from(payment).toJson());

        kafkaTemplate.send("payments.rejected",
                payment.getId(),
                PaymentRejected.from(payment).toJson());
    }
}

// Fraud Service — reacts to PaymentInitiated
@Service
public class FraudCheckConsumer {

    @Autowired private FraudCheckEngine fraudEngine;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    @KafkaListener(topics = "payments.initiated", groupId = "fraud-service")
    @Transactional
    public void checkFraud(ConsumerRecord<String, String> record) {
        PaymentInitiated event = PaymentInitiated.fromJson(record.value());
        FraudCheckResult result = fraudEngine.check(event);

        if (result.isPassed()) {
            kafkaTemplate.send("fraud.checks.passed",
                    event.getPaymentId(),
                    FraudCheckPassed.from(event, result).toJson());
        } else {
            kafkaTemplate.send("fraud.checks.failed",
                    event.getPaymentId(),
                    FraudCheckFailed.from(event, result).toJson());
        }
    }
}

// Account Service — reacts to FraudCheckPassed
@Service
public class TransferExecutionConsumer {

    @Autowired private AccountService accountService;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    @KafkaListener(topics = "fraud.checks.passed", groupId = "account-transfer-saga")
    @Transactional
    public void executeTransfer(ConsumerRecord<String, String> record) {
        FraudCheckPassed event = FraudCheckPassed.fromJson(record.value());

        try {
            accountService.transferFunds(
                    event.getSourceAccountId(),
                    event.getDestinationAccountId(),
                    event.getAmount()
            );

            kafkaTemplate.send("payments.completed",
                    event.getPaymentId(),
                    PaymentCompleted.from(event).toJson());

        } catch (InsufficientFundsException | AccountNotFoundException e) {
            kafkaTemplate.send("payments.transfer-failed",
                    event.getPaymentId(),
                    TransferFailed.from(event, e.getMessage()).toJson());
        }
    }
}
```

**Choreography trade-offs:**

| Aspect | Benefit | Drawback |
|--------|---------|----------|
| Coupling | Loose — services only know events | Hard to see the full saga flow |
| Failure tracking | Distributed — no single record | Requires correlation IDs across topics |
| Testing | Each service testable independently | End-to-end saga testing is complex |
| Adding steps | Add new listener to existing event | No change to other services |

---

## Orchestration-Based Saga

In orchestration, a **saga orchestrator** (a central coordinator) sends commands to services and reacts to their responses. The orchestrator maintains the saga state.

```
                    PaymentTransferSagaOrchestrator
                              │
      ┌───────────────────────┼──────────────────────────┐
      ▼                       ▼                          ▼
FraudService              AccountService          NotificationService
(responds to              (responds to            (responds to
ReserveFundsCmd)          ExecuteTransferCmd)      SendNotifCmd)
```

### Axon Framework Saga Implementation

```java
import org.axonframework.commandhandling.gateway.CommandGateway;
import org.axonframework.eventhandling.saga.SagaEventHandler;
import org.axonframework.eventhandling.saga.StartSaga;
import org.axonframework.eventhandling.saga.EndSaga;
import org.axonframework.spring.stereotype.Saga;
import org.axonframework.eventhandling.saga.SagaLifecycle;

@Saga
public class PaymentTransferSaga implements Serializable {

    @Autowired
    private transient CommandGateway commandGateway;

    private String paymentId;
    private String sourceAccountId;
    private String destinationAccountId;
    private BigDecimal amount;
    private String currency;
    private boolean fundsReserved = false;
    private boolean fraudCheckPassed = false;

    @StartSaga
    @SagaEventHandler(associationProperty = "paymentId")
    public void on(PaymentInitiatedEvent event) {
        this.paymentId = event.getPaymentId();
        this.sourceAccountId = event.getSourceAccountId();
        this.destinationAccountId = event.getDestinationAccountId();
        this.amount = event.getAmount();
        this.currency = event.getCurrency();

        // Step 1: Reserve funds
        commandGateway.send(new ReserveFundsCommand(
                sourceAccountId, paymentId, amount, currency
        ));

        log.info("Payment saga started for paymentId={}", paymentId);
    }

    @SagaEventHandler(associationProperty = "paymentId")
    public void on(FundsReservedEvent event) {
        this.fundsReserved = true;

        // Step 2: Run fraud check
        commandGateway.send(new PerformFraudCheckCommand(
                paymentId, sourceAccountId, destinationAccountId, amount
        ));
    }

    @SagaEventHandler(associationProperty = "paymentId")
    public void on(FundsReservationFailedEvent event) {
        log.warn("Funds reservation failed for paymentId={}: {}",
                paymentId, event.getReason());

        // No compensation needed — funds were never reserved
        commandGateway.send(new MarkPaymentFailedCommand(
                paymentId, "INSUFFICIENT_FUNDS: " + event.getReason()
        ));

        SagaLifecycle.end(); // Terminate the saga
    }

    @SagaEventHandler(associationProperty = "paymentId")
    public void on(FraudCheckPassedEvent event) {
        this.fraudCheckPassed = true;

        // Step 3: Execute the transfer
        commandGateway.send(new ExecuteTransferCommand(
                paymentId, sourceAccountId, destinationAccountId, amount, currency
        ));
    }

    @SagaEventHandler(associationProperty = "paymentId")
    public void on(FraudCheckFailedEvent event) {
        log.warn("Fraud check failed for paymentId={}: {}", paymentId, event.getReason());

        // Compensate: release reserved funds
        commandGateway.send(new ReleaseFundsCommand(
                sourceAccountId, paymentId, amount
        ));

        commandGateway.send(new MarkPaymentRejectedCommand(
                paymentId, "FRAUD_DETECTED: " + event.getReason()
        ));

        SagaLifecycle.end();
    }

    @SagaEventHandler(associationProperty = "paymentId")
    public void on(TransferCompletedEvent event) {
        // Step 4: Send notification
        commandGateway.send(new SendPaymentNotificationCommand(
                paymentId, sourceAccountId, destinationAccountId, amount, currency
        ));
    }

    @SagaEventHandler(associationProperty = "paymentId")
    public void on(TransferFailedEvent event) {
        // Compensate: release reserved funds
        if (fundsReserved) {
            commandGateway.send(new ReleaseFundsCommand(
                    sourceAccountId, paymentId, amount
            ));
        }

        commandGateway.send(new MarkPaymentFailedCommand(
                paymentId, "TRANSFER_FAILED: " + event.getReason()
        ));

        SagaLifecycle.end();
    }

    @EndSaga
    @SagaEventHandler(associationProperty = "paymentId")
    public void on(PaymentCompletedEvent event) {
        log.info("Payment saga completed successfully for paymentId={}", paymentId);
        // SagaLifecycle.end() is implicit due to @EndSaga
    }
}
```

---

## Saga State Persistence

Axon Framework automatically persists saga state to a repository. For custom saga implementations:

```java
@Entity
@Table(name = "payment_sagas")
public class PaymentSagaState {

    @Id
    private String paymentId;

    @Enumerated(EnumType.STRING)
    private SagaStep currentStep;

    @Enumerated(EnumType.STRING)
    private SagaStatus status;

    private String sourceAccountId;
    private String destinationAccountId;

    @Column(precision = 19, scale = 4)
    private BigDecimal amount;

    private String currency;
    private boolean fundsReserved;
    private boolean fraudCheckPassed;
    private boolean transferCompleted;

    private String failureReason;
    private Instant startedAt;
    private Instant completedAt;
    private Instant lastUpdatedAt;
    private int compensationAttempts;

    public enum SagaStep {
        FUNDS_RESERVATION, FRAUD_CHECK, TRANSFER_EXECUTION,
        NOTIFICATION, SETTLEMENT, COMPENSATING, COMPLETED, FAILED
    }

    public enum SagaStatus {
        IN_PROGRESS, COMPLETED, COMPENSATING, FAILED
    }
}
```

---

## Compensation Transaction Design

Compensation transactions must be:
1. **Idempotent** — called multiple times must have the same effect
2. **Always succeed** — the compensation itself must not fail (use retries + DLQ)
3. **Business-meaningful** — not just a technical rollback, but a proper business operation

```java
@Service
public class FundsReleaseCompensationHandler {

    @Autowired private AccountRepository accountRepository;
    @Autowired private KafkaTemplate<String, String> kafkaTemplate;

    @KafkaListener(topics = "accounts.release-funds", groupId = "compensation-handler")
    @Transactional
    public void releaseFunds(ConsumerRecord<String, String> record) {
        ReleaseFundsCommand command = ReleaseFundsCommand.fromJson(record.value());

        Account account = accountRepository.findById(command.getAccountId())
                .orElseThrow(() -> new AccountNotFoundException(command.getAccountId()));

        // Idempotency: check if funds were already released for this paymentId
        if (account.hasFundsAlreadyReleased(command.getPaymentId())) {
            log.info("Funds already released for paymentId={} — skipping (idempotent)",
                    command.getPaymentId());
            return;
        }

        // The reservation was debited in a previous step
        // This compensation credits it back
        account.releaseReservedFunds(command.getAmount(), command.getPaymentId());
        accountRepository.save(account);

        kafkaTemplate.send("accounts.funds-released",
                command.getAccountId(),
                FundsReleased.from(command).toJson());

        log.info("Released {} {} reserved for paymentId={} on account={}",
                command.getAmount(), account.getCurrency(),
                command.getPaymentId(), command.getAccountId());
    }
}
```

---

## Saga Testing

```java
import org.axonframework.test.saga.SagaTestFixture;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class PaymentTransferSagaTest {

    private SagaTestFixture<PaymentTransferSaga> fixture;

    @BeforeEach
    void setUp() {
        fixture = new SagaTestFixture<>(PaymentTransferSaga.class);
    }

    @Test
    void happyPath_completesSagaSuccessfully() {
        fixture.givenNoPriorActivity()
            .whenAggregate("payment-123").publishes(new PaymentInitiatedEvent(
                    "payment-123", "acc-source", "acc-dest",
                    new BigDecimal("100.00"), "GBP"
            ))
            .expectActiveSagas(1)
            .expectDispatchedCommands(new ReserveFundsCommand(
                    "acc-source", "payment-123", new BigDecimal("100.00"), "GBP"
            ));
    }

    @Test
    void fraudCheckFail_releasesFundsAndEndsSaga() {
        fixture.givenAggregate("payment-123").published(
                new PaymentInitiatedEvent("payment-123", "acc-source", "acc-dest",
                        new BigDecimal("100.00"), "GBP"),
                new FundsReservedEvent("payment-123", "acc-source",
                        new BigDecimal("100.00"))
        )
        .whenPublishingA(new FraudCheckFailedEvent("payment-123", "SUSPICIOUS_PATTERN"))
        .expectActiveSagas(0)  // Saga should end
        .expectDispatchedCommandsMatching(
                commandOfType(ReleaseFundsCommand.class),
                commandOfType(MarkPaymentRejectedCommand.class)
        );
    }

    @Test
    void insufficientFunds_endsSagaWithoutCompensation() {
        fixture.givenAggregate("payment-123").published(
                new PaymentInitiatedEvent("payment-123", "acc-source", "acc-dest",
                        new BigDecimal("100.00"), "GBP")
        )
        .whenPublishingA(new FundsReservationFailedEvent("payment-123", "INSUFFICIENT_FUNDS"))
        .expectActiveSagas(0)
        .expectNoDispatchedCommands(); // No compensation needed — no funds were reserved
    }
}
```

---

## Choreography vs Orchestration Decision

| Consideration | Choreography | Orchestration |
|---------------|-------------|---------------|
| Complexity per service | Low | Low (saga handles flow) |
| Saga visibility | Low — distributed | High — single class |
| Coupling | Loose | Moderate (saga knows all services) |
| Testing | Hard end-to-end | Easy (SagaTestFixture) |
| Adding new steps | Add listener | Modify saga |
| Failure debugging | Hard — distributed trace | Easy — saga state |
| Recommended for | Simple 2-3 step flows | Complex 4+ step flows |

**Payment transfer recommendation:** Use orchestration. Payment transfers involve 5+ steps with complex compensation logic. Choreography makes the flow invisible; a debugging engineer under production pressure needs the saga state visible in one place.

---

## Key Takeaways

- Sagas replace distributed 2PC with local transactions + compensating transactions — trading atomicity for availability.
- **Choreography** is decoupled but hard to debug — each service reacts to events independently.
- **Orchestration** (Axon Framework saga) has explicit state and flow — easier to debug, test, and reason about.
- Compensation transactions must be idempotent, always succeed, and represent meaningful business operations (not just technical rollbacks).
- Saga state must be persisted — a process restart must resume the saga from where it left off.
- The `@SagaEventHandler` annotation links Kafka events to saga steps via an `associationProperty` (e.g., `paymentId`).
- Test sagas with `SagaTestFixture` — it verifies which commands are dispatched and when the saga ends.
- For payment transfers with 4+ steps and complex failure modes, orchestration is strongly preferred over choreography.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the fundamental consistency model that Sagas provide compared to distributed 2PC?",
      "options": [
        "Sagas provide ACID guarantees across all participating services",
        "Sagas trade atomicity for availability using local transactions and compensating transactions",
        "Sagas use optimistic locking to coordinate distributed state changes",
        "Sagas require a central coordinator that holds distributed locks during execution"
      ],
      "correct": 1,
      "explanation": "2PC (two-phase commit) provides atomicity but requires holding distributed locks and fails if any participant is unavailable. Sagas trade atomicity for availability: each step is a local transaction, and failures are compensated by executing reversal transactions rather than rolling back a distributed lock."
    },
    {
      "text": "Why is orchestration preferred over choreography for payment transfers with 4+ steps?",
      "options": [
        "Orchestration is faster because it uses direct service calls instead of Kafka",
        "Orchestration has explicit state in a single saga class, making failure debugging and testing straightforward",
        "Choreography cannot handle more than 3 services",
        "Orchestration provides exactly-once semantics while choreography does not"
      ],
      "correct": 1,
      "explanation": "In choreography, the flow is distributed across event handlers in multiple services — debugging a failure requires tracing through Kafka topics across services. In orchestration (Axon saga), the entire flow, state, and compensation logic is visible in one class, making failures debuggable with saga state and testable with SagaTestFixture."
    },
    {
      "text": "What three properties must compensation transactions have in a payment Saga?",
      "options": [
        "Fast, synchronous, and reversible",
        "Idempotent, always succeed (with retries), and represent meaningful business operations",
        "Atomic, consistent, and isolated",
        "Asynchronous, retryable, and schema-versioned"
      ],
      "correct": 1,
      "explanation": "Compensation transactions must be idempotent (called multiple times produces the same result), must always eventually succeed (use retries + DLQ — a failed compensation leaves the system in an inconsistent state), and should represent proper business operations like ReleaseFunds rather than a technical database rollback."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build an Orchestrated Payment Transfer Saga with Axon Framework",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Implement a PaymentTransferSaga using Axon Framework with @Saga annotation. Define saga state fields (paymentId, sourceAccountId, destinationAccountId, amount, fundsReserved, fraudCheckPassed). Implement @StartSaga on PaymentInitiatedEvent that dispatches a ReserveFundsCommand."},
    {"id": "2", "description": "Complete the saga happy path: FundsReservedEvent triggers PerformFraudCheckCommand, FraudCheckPassedEvent triggers ExecuteTransferCommand, TransferCompletedEvent triggers SendPaymentNotificationCommand, and @EndSaga on PaymentCompletedEvent terminates the saga."},
    {"id": "3", "description": "Implement all compensation paths: FraudCheckFailedEvent releases reserved funds and marks payment rejected; TransferFailedEvent releases reserved funds (if fundsReserved=true) and marks payment failed; FundsReservationFailedEvent ends saga with no compensation needed. Ensure compensation commands are idempotent."},
    {"id": "4", "description": "Write SagaTestFixture tests covering: (a) happy path dispatches correct command sequence, (b) fraud check failure triggers funds release and saga ends, (c) insufficient funds ends saga without compensation, (d) transfer failure after funds reserved triggers compensation."}
  ]
}
-->
