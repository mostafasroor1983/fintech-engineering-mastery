---
id: track-04-lesson-16
title: "Reactive Saga — Coordinating Distributed Transactions"
slug: reactive-saga
track: track-04
trackName: "Async & Reactive Systems"
sequence: 16
difficulty: principal
estimatedMinutes: 85
status: published
tags: [saga, reactive, distributed-transaction, choreography, orchestration]
prerequisites: [track-04-lesson-15]
---

# Reactive Saga — Coordinating Distributed Transactions

> [!NOTE]
> The Saga pattern is not about avoiding failure — it is about making failure a first-class citizen in your domain model. In financial systems, every distributed operation must have a defined compensation path before it enters production. A saga without its compensations is an incomplete specification.

## Why Sagas in Reactive Financial Systems

Distributed transactions across payment services, ledgers, and notification systems cannot rely on 2PC (Two-Phase Commit). 2PC is synchronous, requires a coordinator that becomes a single point of failure, and holds locks across service boundaries for the duration of the commit — unacceptable in a high-throughput reactive payment system targeting sub-100ms p99 latency.

The Saga pattern replaces atomicity with eventual consistency. Each step in a saga is a local transaction. If a step fails, compensation transactions undo the effect of previously completed steps. The result is not a rollback in the ACID sense — it is a forward-moving sequence of business-level undos.

Two variants exist:

1. **Choreography-based sagas** — Each service listens for domain events and decides what to do next. No central coordinator. Scales well, but observability is harder.
2. **Orchestration-based sagas** — A dedicated orchestrator controls the sequence, tracks state, and issues commands. Easier to reason about but introduces a coordination component.

For payment flows at scale, orchestration is typically preferred because:
- Saga state is explicit and queryable
- Failure handling logic is co-located and testable
- Compensations are deterministic and auditable

---

## Payment Saga Domain Model

A complete payment saga in a fintech platform involves four sequential steps:

1. **Reserve Funds** — Debit source account (hold)
2. **Execute Transfer** — Move funds through the payment network
3. **Credit Destination** — Credit target account
4. **Send Notification** — Notify both parties

Each step has a compensation:
1. **Release Funds** — Release the hold on source account
2. **Reverse Transfer** — Issue reversal through the payment network
3. **Debit Destination** — Reverse the credit
4. **Send Failure Notification** — Notify of failure

```java
// Payment saga step enumeration
public enum PaymentSagaStep {
    RESERVE_FUNDS,
    EXECUTE_TRANSFER,
    CREDIT_DESTINATION,
    SEND_NOTIFICATION,
    COMPLETED,
    COMPENSATING,
    COMPENSATED,
    FAILED
}

// Saga state entity stored in database via R2DBC
@Table("payment_sagas")
public record PaymentSagaState(
    @Id UUID sagaId,
    UUID paymentId,
    String sourceAccountId,
    String destinationAccountId,
    BigDecimal amount,
    String currency,
    PaymentSagaStep currentStep,
    PaymentSagaStep failedAtStep,
    String failureReason,
    String reservationId,       // idempotency token for reserve step
    String transferId,          // idempotency token for transfer step
    String creditId,            // idempotency token for credit step
    Instant createdAt,
    Instant updatedAt,
    int version                 // optimistic locking version
) {}
```

---

## Saga State Persistence with R2DBC

Saga state must survive process crashes. Use R2DBC for non-blocking persistence with optimistic locking to prevent concurrent updates from multiple orchestrator instances.

```java
@Repository
public interface PaymentSagaRepository extends ReactiveCrudRepository<PaymentSagaState, UUID> {

    @Query("SELECT * FROM payment_sagas WHERE payment_id = :paymentId")
    Mono<PaymentSagaState> findByPaymentId(UUID paymentId);

    @Query("SELECT * FROM payment_sagas WHERE current_step NOT IN ('COMPLETED','COMPENSATED','FAILED') AND created_at < :cutoff")
    Flux<PaymentSagaState> findSagasOlderThan(Instant cutoff);

    @Query("""
        UPDATE payment_sagas
        SET current_step    = :currentStep,
            failed_at_step  = :failedAtStep,
            failure_reason  = :failureReason,
            reservation_id  = COALESCE(:reservationId, reservation_id),
            transfer_id     = COALESCE(:transferId, transfer_id),
            credit_id       = COALESCE(:creditId, credit_id),
            updated_at      = NOW(),
            version         = version + 1
        WHERE saga_id = :sagaId AND version = :version
        RETURNING *
        """)
    Mono<PaymentSagaState> updateWithOptimisticLock(
        @Param("sagaId") UUID sagaId,
        @Param("currentStep") PaymentSagaStep currentStep,
        @Param("failedAtStep") PaymentSagaStep failedAtStep,
        @Param("failureReason") String failureReason,
        @Param("reservationId") String reservationId,
        @Param("transferId") String transferId,
        @Param("creditId") String creditId,
        @Param("version") int version
    );
}
```

---

## Orchestration-Based Saga Orchestrator

The orchestrator is a reactive state machine. It receives commands, executes steps, persists state transitions, and handles failures with compensation chains.

```java
@Service
@Slf4j
public class PaymentSagaOrchestrator {

    private final PaymentSagaRepository sagaRepository;
    private final AccountService accountService;
    private final TransferService transferService;
    private final NotificationService notificationService;
    private final MeterRegistry meterRegistry;

    public PaymentSagaOrchestrator(
        PaymentSagaRepository sagaRepository,
        AccountService accountService,
        TransferService transferService,
        NotificationService notificationService,
        MeterRegistry meterRegistry
    ) {
        this.sagaRepository = sagaRepository;
        this.accountService = accountService;
        this.transferService = transferService;
        this.notificationService = notificationService;
        this.meterRegistry = meterRegistry;
    }

    public Mono<PaymentSagaState> executeSaga(InitiatePaymentCommand command) {
        // Check for existing saga first (idempotency at saga level)
        return sagaRepository.findByPaymentId(command.paymentId())
            .switchIfEmpty(createNewSaga(command))
            .flatMap(state -> {
                if (isTerminalState(state.currentStep())) {
                    log.info("saga={} already in terminal state={}", state.sagaId(), state.currentStep());
                    return Mono.just(state);
                }
                return resumeSaga(state);
            });
    }

    private Mono<PaymentSagaState> createNewSaga(InitiatePaymentCommand command) {
        PaymentSagaState initialState = new PaymentSagaState(
            UUID.randomUUID(),
            command.paymentId(),
            command.sourceAccountId(),
            command.destinationAccountId(),
            command.amount(),
            command.currency(),
            PaymentSagaStep.RESERVE_FUNDS,
            null, null, null, null, null,
            Instant.now(), Instant.now(), 0
        );
        return sagaRepository.save(initialState);
    }

    private Mono<PaymentSagaState> resumeSaga(PaymentSagaState state) {
        // Resume from the current step — handles process crash recovery
        return switch (state.currentStep()) {
            case RESERVE_FUNDS    -> reserveFunds(state)
                                        .flatMap(this::executeTransfer)
                                        .flatMap(this::creditDestination)
                                        .flatMap(this::sendNotification)
                                        .flatMap(this::markCompleted)
                                        .onErrorResume(ex -> initiateCompensation(state.sagaId(), ex));
            case EXECUTE_TRANSFER -> executeTransfer(state)
                                        .flatMap(this::creditDestination)
                                        .flatMap(this::sendNotification)
                                        .flatMap(this::markCompleted)
                                        .onErrorResume(ex -> initiateCompensation(state.sagaId(), ex));
            case CREDIT_DESTINATION -> creditDestination(state)
                                        .flatMap(this::sendNotification)
                                        .flatMap(this::markCompleted)
                                        .onErrorResume(ex -> initiateCompensation(state.sagaId(), ex));
            case COMPENSATING     -> runCompensations(state);
            default               -> Mono.just(state);
        };
    }

    // --- Forward Steps ---

    private Mono<PaymentSagaState> reserveFunds(PaymentSagaState state) {
        String reservationId = "res-" + state.sagaId();
        return accountService.reserveFunds(
                state.sourceAccountId(), state.amount(), state.currency(), reservationId
            )
            .timeout(Duration.ofSeconds(10))
            .flatMap(reservation ->
                sagaRepository.updateWithOptimisticLock(
                    state.sagaId(), PaymentSagaStep.EXECUTE_TRANSFER,
                    null, null, reservationId, null, null, state.version()
                )
            )
            .doOnSuccess(s -> log.info("saga={} step=RESERVE_FUNDS status=success reservationId={}", state.sagaId(), reservationId))
            .doOnError(ex  -> log.error("saga={} step=RESERVE_FUNDS status=failed error={}", state.sagaId(), ex.getMessage()));
    }

    private Mono<PaymentSagaState> executeTransfer(PaymentSagaState state) {
        String transferId = "txf-" + state.sagaId();
        return transferService.executeTransfer(
                state.sourceAccountId(), state.destinationAccountId(),
                state.amount(), state.currency(), transferId
            )
            .timeout(Duration.ofSeconds(15))
            .flatMap(transfer ->
                sagaRepository.updateWithOptimisticLock(
                    state.sagaId(), PaymentSagaStep.CREDIT_DESTINATION,
                    null, null, state.reservationId(), transferId, null, state.version()
                )
            )
            .doOnSuccess(s -> log.info("saga={} step=EXECUTE_TRANSFER status=success transferId={}", state.sagaId(), transferId));
    }

    private Mono<PaymentSagaState> creditDestination(PaymentSagaState state) {
        String creditId = "crd-" + state.sagaId();
        return accountService.creditAccount(
                state.destinationAccountId(), state.amount(), state.currency(), creditId
            )
            .timeout(Duration.ofSeconds(10))
            .flatMap(credit ->
                sagaRepository.updateWithOptimisticLock(
                    state.sagaId(), PaymentSagaStep.SEND_NOTIFICATION,
                    null, null, state.reservationId(), state.transferId(), creditId, state.version()
                )
            )
            .doOnSuccess(s -> log.info("saga={} step=CREDIT_DESTINATION status=success creditId={}", state.sagaId(), creditId));
    }

    private Mono<PaymentSagaState> sendNotification(PaymentSagaState state) {
        return notificationService.sendPaymentSuccess(
                state.sourceAccountId(), state.destinationAccountId(),
                state.amount(), state.currency()
            )
            .thenReturn(state)
            .onErrorResume(ex -> {
                // Notification is non-critical: log and continue
                log.warn("saga={} step=SEND_NOTIFICATION failed (non-critical): {}", state.sagaId(), ex.getMessage());
                return Mono.just(state);
            });
    }

    private Mono<PaymentSagaState> markCompleted(PaymentSagaState state) {
        return sagaRepository.updateWithOptimisticLock(
            state.sagaId(), PaymentSagaStep.COMPLETED,
            null, null,
            state.reservationId(), state.transferId(), state.creditId(),
            state.version()
        ).doOnSuccess(s -> {
            meterRegistry.counter("payment.saga", "outcome", "completed").increment();
            log.info("saga={} COMPLETED successfully", state.sagaId());
        });
    }

    // --- Compensation ---

    public Mono<PaymentSagaState> initiateCompensation(UUID sagaId, Throwable cause) {
        return sagaRepository.findById(sagaId)
            .flatMap(state -> {
                log.error("saga={} initiating compensation at step={} cause={}",
                    sagaId, state.currentStep(), cause.getMessage());
                return sagaRepository.updateWithOptimisticLock(
                        sagaId, PaymentSagaStep.COMPENSATING,
                        state.currentStep(), cause.getMessage(),
                        state.reservationId(), state.transferId(), state.creditId(),
                        state.version()
                    )
                    .flatMap(this::runCompensations);
            });
    }

    private Mono<PaymentSagaState> runCompensations(PaymentSagaState state) {
        // Compensations run in reverse order based on what was completed
        Mono<Void> chain = Mono.empty();

        if (state.creditId() != null) {
            chain = chain.then(
                accountService.reverseCredit(
                    state.destinationAccountId(), state.amount(), state.currency(),
                    "comp-crd-" + state.sagaId()
                ).doOnSuccess(v -> log.info("saga={} compensation=CREDIT done", state.sagaId()))
                 .onErrorResume(ex -> {
                     log.error("saga={} compensation=CREDIT FAILED — manual intervention required", state.sagaId(), ex);
                     return Mono.empty(); // continue other compensations
                 })
                 .then()
            );
        }

        if (state.transferId() != null) {
            chain = chain.then(
                transferService.reverseTransfer(state.transferId(), "comp-txf-" + state.sagaId())
                    .doOnSuccess(v -> log.info("saga={} compensation=TRANSFER done", state.sagaId()))
                    .onErrorResume(ex -> {
                        log.error("saga={} compensation=TRANSFER FAILED", state.sagaId(), ex);
                        return Mono.empty();
                    })
                    .then()
            );
        }

        if (state.reservationId() != null) {
            chain = chain.then(
                accountService.releaseReservation(state.reservationId(), "comp-res-" + state.sagaId())
                    .doOnSuccess(v -> log.info("saga={} compensation=RESERVATION done", state.sagaId()))
                    .onErrorResume(ex -> {
                        log.error("saga={} compensation=RESERVATION FAILED", state.sagaId(), ex);
                        return Mono.empty();
                    })
                    .then()
            );
        }

        return chain
            .then(notificationService.sendPaymentFailure(
                state.sourceAccountId(), state.amount(), state.failureReason()
            ).onErrorResume(ex -> Mono.empty()))
            .then(sagaRepository.updateWithOptimisticLock(
                state.sagaId(), PaymentSagaStep.COMPENSATED,
                state.failedAtStep(), state.failureReason(),
                state.reservationId(), state.transferId(), state.creditId(),
                state.version()
            ))
            .doOnSuccess(s -> {
                meterRegistry.counter("payment.saga", "outcome", "compensated",
                    "failed_at", state.failedAtStep() != null ? state.failedAtStep().name() : "unknown"
                ).increment();
                log.info("saga={} COMPENSATED after failure at step={}", state.sagaId(), state.failedAtStep());
            });
    }

    public Mono<PaymentSagaState> forceCompensate(UUID sagaId, String reason) {
        return initiateCompensation(sagaId, new RuntimeException(reason));
    }

    private boolean isTerminalState(PaymentSagaStep step) {
        return step == PaymentSagaStep.COMPLETED
            || step == PaymentSagaStep.COMPENSATED
            || step == PaymentSagaStep.FAILED;
    }
}
```

---

## Choreography-Based Saga with Kafka and Reactor

In choreography, services react to events on Kafka topics and emit their own events. There is no central orchestrator — each service is autonomous.

```java
// Domain events for choreography-based saga
public sealed interface PaymentSagaEvent permits
    FundsReservedEvent, FundsReservationFailedEvent,
    TransferExecutedEvent, TransferFailedEvent,
    DestinationCreditedEvent, CreditFailedEvent,
    PaymentCompletedEvent {}

public record FundsReservedEvent(
    UUID sagaId, UUID paymentId, String reservationId, Instant occurredAt
) implements PaymentSagaEvent {}

public record TransferFailedEvent(
    UUID sagaId, UUID paymentId, String reason, Instant occurredAt
) implements PaymentSagaEvent {}
```

```java
// Account service: listens for payment-initiated, emits funds-reserved or funds-failed
@Service
@Slf4j
public class AccountSagaParticipant {

    private final KafkaSender<String, Object> kafkaSender;
    private final IdempotentAccountService accountService;

    @Bean
    public Disposable consumePaymentInitiated(
        KafkaReceiver<String, InitiatePaymentCommand> receiver
    ) {
        return receiver.receive()
            .groupBy(ConsumerRecord::key)
            .flatMap(group -> group.concatMap(record ->
                processReservation(record.value())
                    .doFinally(signal -> record.receiverOffset().acknowledge())
                    .onErrorResume(ex -> {
                        log.error("Unrecoverable error processing record key={}", record.key(), ex);
                        record.receiverOffset().acknowledge();
                        return Mono.empty();
                    })
            ), 10) // max 10 partitions in-flight
            .subscribe();
    }

    private Mono<Void> processReservation(InitiatePaymentCommand cmd) {
        String reservationId = "res-" + cmd.sagaId();
        return accountService.reserveFunds(
                cmd.sourceAccountId(), cmd.amount(), cmd.currency(), reservationId
            )
            .flatMap(reservation ->
                publishEvent("payment-saga-events", cmd.sagaId(),
                    new FundsReservedEvent(cmd.sagaId(), cmd.paymentId(), reservationId, Instant.now()))
            )
            .onErrorResume(ex ->
                publishEvent("payment-saga-events", cmd.sagaId(),
                    new FundsReservationFailedEvent(cmd.sagaId(), cmd.paymentId(), ex.getMessage(), Instant.now()))
                .then(Mono.empty())
            );
    }

    private Mono<Void> publishEvent(String topic, UUID key, Object event) {
        SenderRecord<String, Object, String> record = SenderRecord.create(
            new ProducerRecord<>(topic, key.toString(), event), key.toString()
        );
        return kafkaSender.send(Mono.just(record)).then();
    }
}
```

---

## Saga Timeout Monitor

Sagas that never complete must be detected and compensated to prevent funds being held indefinitely.

```java
@Component
@Slf4j
public class SagaTimeoutMonitor {

    private final PaymentSagaRepository sagaRepository;
    private final PaymentSagaOrchestrator orchestrator;
    private static final Duration SAGA_TIMEOUT = Duration.ofMinutes(30);

    @Scheduled(fixedDelay = 60_000)
    public void detectTimedOutSagas() {
        sagaRepository.findSagasOlderThan(Instant.now().minus(SAGA_TIMEOUT))
            .concatMap(state -> {
                log.warn("saga={} timed out at step={} age={}",
                    state.sagaId(), state.currentStep(),
                    Duration.between(state.createdAt(), Instant.now()));
                return orchestrator.forceCompensate(
                    state.sagaId(),
                    "Saga timed out after 30 minutes at step " + state.currentStep()
                );
            })
            .subscribe(
                result -> log.info("Timed-out saga compensated sagaId={}", result.sagaId()),
                error  -> log.error("Error compensating timed-out saga", error)
            );
    }
}
```

---

## Idempotent Service Calls

Each saga step must be safe to replay. Use deterministic idempotency keys derived from the saga ID.

```java
@Service
public class IdempotentAccountService {

    private final AccountRepository accountRepository;
    private final ReservationRepository reservationRepository;

    // Safe to call multiple times with same key — returns existing result if already processed
    public Mono<Reservation> reserveFunds(
        String accountId, BigDecimal amount, String currency, String idempotencyKey
    ) {
        return reservationRepository.findByIdempotencyKey(idempotencyKey)
            .switchIfEmpty(Mono.defer(() ->
                accountRepository.findById(accountId)
                    .switchIfEmpty(Mono.error(new AccountNotFoundException(accountId)))
                    .flatMap(account -> {
                        if (account.availableBalance().compareTo(amount) < 0) {
                            return Mono.error(new InsufficientFundsException(
                                "Account %s has insufficient funds: available=%s requested=%s"
                                    .formatted(accountId, account.availableBalance(), amount)
                            ));
                        }
                        Reservation reservation = new Reservation(
                            UUID.randomUUID(), accountId, amount, currency,
                            idempotencyKey, ReservationStatus.ACTIVE, Instant.now()
                        );
                        return reservationRepository.save(reservation)
                            .then(accountRepository.decrementAvailableBalance(accountId, amount))
                            .thenReturn(reservation);
                    })
            ));
    }

    // Compensation — also idempotent
    public Mono<Void> releaseReservation(String reservationId, String idempotencyKey) {
        return reservationRepository.findByIdempotencyKey(idempotencyKey)
            .switchIfEmpty(
                reservationRepository.findById(reservationId)
                    .flatMap(reservation -> {
                        if (reservation.status() == ReservationStatus.RELEASED) {
                            return Mono.empty(); // already released
                        }
                        return accountRepository.incrementAvailableBalance(
                                reservation.accountId(), reservation.amount()
                            )
                            .then(reservationRepository.updateStatus(
                                reservationId, ReservationStatus.RELEASED, idempotencyKey
                            ));
                    })
            )
            .then();
    }
}
```

---

## Resilient Transfer Service with Circuit Breaker

```java
@Service
@Slf4j
public class ResilientTransferService {

    private final TransferGateway transferGateway;
    private final CircuitBreaker circuitBreaker;
    private final Retry retrySpec;

    public ResilientTransferService(
        TransferGateway transferGateway,
        CircuitBreakerRegistry circuitBreakerRegistry
    ) {
        this.transferGateway = transferGateway;
        this.circuitBreaker = circuitBreakerRegistry.circuitBreaker("transfer-gateway",
            CircuitBreakerConfig.custom()
                .failureRateThreshold(50)
                .waitDurationInOpenState(Duration.ofSeconds(30))
                .permittedNumberOfCallsInHalfOpenState(5)
                .slidingWindowSize(20)
                .build()
        );
        this.retrySpec = Retry.backoff(3, Duration.ofMillis(200))
            .maxBackoff(Duration.ofSeconds(2))
            .filter(ex -> ex instanceof TransientNetworkException || ex instanceof ServiceUnavailableException)
            .doBeforeRetry(signal -> log.warn(
                "Retrying transfer attempt={} lastError={}",
                signal.totalRetries() + 1, signal.failure().getMessage()
            ));
    }

    public Mono<Transfer> executeTransfer(
        String from, String to, BigDecimal amount, String currency, String idempotencyKey
    ) {
        return Mono.defer(() ->
            transferGateway.transfer(from, to, amount, currency, idempotencyKey)
        )
        .transformDeferred(CircuitBreakerOperator.of(circuitBreaker))
        .retryWhen(retrySpec)
        .onErrorMap(CallNotPermittedException.class, ex ->
            new TransferCircuitOpenException("Transfer gateway circuit breaker is OPEN", ex)
        )
        .doOnSuccess(t -> log.info("Transfer executed transferId={}", t.id()))
        .doOnError(ex -> log.error("Transfer failed idempotencyKey={} error={}", idempotencyKey, ex.getMessage()));
    }
}
```

---

## Saga Observability: Distributed Tracing

Each saga step should propagate trace context to correlate all operations belonging to a single payment flow.

```java
@Component
public class SagaTracingDecorator {

    private final Tracer tracer;

    public <T> Mono<T> withSpan(String stepName, UUID sagaId, Mono<T> mono) {
        return Mono.defer(() -> {
            Span span = tracer.nextSpan()
                .name("saga." + stepName)
                .tag("saga.id", sagaId.toString())
                .tag("saga.step", stepName)
                .start();

            try (Tracer.SpanInScope scope = tracer.withSpan(span)) {
                return mono
                    .doOnSuccess(result -> span.tag("saga.result", "success").end())
                    .doOnError(ex -> span
                        .tag("saga.result", "failure")
                        .tag("error.type", ex.getClass().getSimpleName())
                        .tag("error.message", ex.getMessage())
                        .end()
                    );
            }
        });
    }
}
```

---

## Saga Query and Operations API

```java
@RestController
@RequestMapping("/internal/sagas")
@Slf4j
public class SagaOperationsController {

    private final PaymentSagaRepository sagaRepository;
    private final PaymentSagaOrchestrator orchestrator;

    @GetMapping("/{sagaId}")
    public Mono<ResponseEntity<SagaStateResponse>> getSaga(@PathVariable UUID sagaId) {
        return sagaRepository.findById(sagaId)
            .map(state -> ResponseEntity.ok(SagaStateResponse.from(state)))
            .defaultIfEmpty(ResponseEntity.notFound().build());
    }

    @GetMapping("/payment/{paymentId}")
    public Mono<ResponseEntity<SagaStateResponse>> getSagaByPayment(@PathVariable UUID paymentId) {
        return sagaRepository.findByPaymentId(paymentId)
            .map(state -> ResponseEntity.ok(SagaStateResponse.from(state)))
            .defaultIfEmpty(ResponseEntity.notFound().build());
    }

    @PostMapping("/{sagaId}/force-compensate")
    @PreAuthorize("hasRole('OPERATIONS')")
    public Mono<ResponseEntity<SagaStateResponse>> forceCompensate(
        @PathVariable UUID sagaId,
        @RequestBody ForceCompensateRequest request,
        @AuthenticationPrincipal UserDetails operator
    ) {
        log.warn("Manual compensation sagaId={} operator={} reason={}",
            sagaId, operator.getUsername(), request.reason());
        return orchestrator.forceCompensate(sagaId, "Manual: " + request.reason())
            .map(state -> ResponseEntity.ok(SagaStateResponse.from(state)));
    }
}
```

---

## Testing Reactive Sagas

```java
@ExtendWith(SpringExtension.class)
@SpringBootTest
class PaymentSagaOrchestratorTest {

    @Autowired
    private PaymentSagaOrchestrator orchestrator;

    @MockBean
    private AccountService accountService;

    @MockBean
    private TransferService transferService;

    @MockBean
    private NotificationService notificationService;

    @Test
    void shouldCompleteSagaWhenAllStepsSucceed() {
        InitiatePaymentCommand command = new InitiatePaymentCommand(
            UUID.randomUUID(), UUID.randomUUID(),
            "ACC-001", "ACC-002", new BigDecimal("100.00"), "GBP"
        );

        when(accountService.reserveFunds(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubReservation()));
        when(transferService.executeTransfer(any(), any(), any(), any(), any()))
            .thenReturn(Mono.just(stubTransfer()));
        when(accountService.creditAccount(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubCredit()));
        when(notificationService.sendPaymentSuccess(any(), any(), any(), any()))
            .thenReturn(Mono.empty());

        StepVerifier.create(orchestrator.executeSaga(command))
            .assertNext(state -> {
                assertThat(state.currentStep()).isEqualTo(PaymentSagaStep.COMPLETED);
                assertThat(state.failureReason()).isNull();
                assertThat(state.reservationId()).startsWith("res-");
                assertThat(state.transferId()).startsWith("txf-");
                assertThat(state.creditId()).startsWith("crd-");
            })
            .verifyComplete();
    }

    @Test
    void shouldCompensateWhenTransferFails() {
        InitiatePaymentCommand command = new InitiatePaymentCommand(
            UUID.randomUUID(), UUID.randomUUID(),
            "ACC-001", "ACC-002", new BigDecimal("500.00"), "GBP"
        );

        when(accountService.reserveFunds(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubReservation()));
        when(transferService.executeTransfer(any(), any(), any(), any(), any()))
            .thenReturn(Mono.error(new TransferFailedException("Network timeout")));
        when(accountService.releaseReservation(any(), any()))
            .thenReturn(Mono.empty());
        when(notificationService.sendPaymentFailure(any(), any(), any()))
            .thenReturn(Mono.empty());

        StepVerifier.create(orchestrator.executeSaga(command))
            .assertNext(state -> {
                assertThat(state.currentStep()).isEqualTo(PaymentSagaStep.COMPENSATED);
                assertThat(state.failedAtStep()).isEqualTo(PaymentSagaStep.EXECUTE_TRANSFER);
                assertThat(state.failureReason()).contains("Network timeout");
            })
            .verifyComplete();

        verify(accountService).releaseReservation(startsWith("res-"), startsWith("comp-res-"));
        verify(accountService, never()).reverseCredit(any(), any(), any(), any());
    }

    @Test
    void shouldBeIdempotentWhenExecutedTwice() {
        UUID paymentId = UUID.randomUUID();
        InitiatePaymentCommand command = buildCommand(paymentId);

        when(accountService.reserveFunds(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubReservation()));
        when(transferService.executeTransfer(any(), any(), any(), any(), any()))
            .thenReturn(Mono.just(stubTransfer()));
        when(accountService.creditAccount(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubCredit()));
        when(notificationService.sendPaymentSuccess(any(), any(), any(), any()))
            .thenReturn(Mono.empty());

        // First execution
        orchestrator.executeSaga(command).block();

        // Second execution with same paymentId
        StepVerifier.create(orchestrator.executeSaga(command))
            .assertNext(state -> assertThat(state.currentStep()).isEqualTo(PaymentSagaStep.COMPLETED))
            .verifyComplete();

        // Downstream called only once
        verify(transferService, times(1)).executeTransfer(any(), any(), any(), any(), any());
    }
}
```

---

## Production Considerations

**Saga log persistence**: The saga state table is your primary audit trail for every distributed payment operation. Never delete saga records. Archive to cold storage after 90 days with the full compensation history intact.

**Compensation idempotency**: Each compensation step must use idempotency keys prefixed differently from the forward step (e.g., `comp-res-{sagaId}` vs `res-{sagaId}`). Both steps may execute if the process crashes between execution and state persistence.

**Partial compensation failures**: If a compensation step fails, the saga is in an inconsistent state. Implement a dead-letter saga queue with PagerDuty alerts. Never silently swallow compensation failures — a failed compensation means real funds may be in an inconsistent state.

**Concurrent orchestrator instances**: Use `SELECT FOR UPDATE SKIP LOCKED` to prevent multiple workers from processing the same saga. The optimistic lock version column catches the race condition if two instances somehow grab the same saga simultaneously.

**Saga version schema evolution**: When adding new steps to an existing saga type, in-flight sagas won't have state for new fields. Use nullable fields and handle the absence gracefully in compensation logic.

**Latency budget per step**: Each step should have a timeout tuned to its SLA. A step that hangs indefinitely will block the saga pipeline and exhaust connection pools. Default to `Duration.ofSeconds(10)` for account operations and `Duration.ofSeconds(15)` for external payment network calls.

**Key metrics to monitor**:
- `payment.saga` by `outcome=completed|compensated` — baseline and trend
- `payment.saga.step.duration` histogram by `step` — SLA tracking
- `payment.saga.in_flight` gauge — number of non-terminal sagas
- `payment.saga` by `failed_at=EXECUTE_TRANSFER` — isolates specific step failures
- Alert when `payment.saga{outcome=compensated}` exceeds 1% of total sagas

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why is 2PC (Two-Phase Commit) unsuitable for distributed payment transactions across microservices?",
      "options": ["2PC is not supported by modern databases", "2PC requires a coordinator that holds distributed locks across service boundaries for the duration of the commit, causing latency spikes and availability reduction unacceptable for high-throughput reactive payment systems", "2PC cannot handle more than 2 participants", "2PC does not support asynchronous message delivery"],
      "correct": 1,
      "explanation": "2PC requires all participants to hold locks from the prepare phase until the commit decision. With multiple microservices across network boundaries, any slow participant blocks all others. The coordinator is a single point of failure. For payment systems targeting sub-100ms p99, this lock-holding behavior is unacceptable."
    },
    {
      "text": "In a payment saga, what is the purpose of a compensation transaction?",
      "options": ["A compensation retries the failed step with different parameters", "A compensation is a business-level undo that reverses the effect of a previously completed saga step — e.g., releasing a fund hold if the transfer step fails", "A compensation sends a notification to the customer about the failure", "A compensation is a database rollback issued by the saga orchestrator"],
      "correct": 1,
      "explanation": "Unlike ACID rollbacks, compensations are forward-moving business operations. If step 2 (Execute Transfer) fails, the compensation for step 1 (Reserve Funds) releases the hold. The account is not rolled back in the database sense — a new ledger entry reverses the hold. Each step must have a defined compensation before the saga enters production."
    },
    {
      "text": "What is the main advantage of orchestration-based sagas over choreography-based sagas in a payment system?",
      "options": ["Orchestration has lower network latency because there is no central coordinator", "Orchestration centralizes saga state, compensation logic, and failure handling in one place, making it explicit, queryable, and testable — unlike choreography where saga state is implicit across events", "Orchestration does not require a message broker", "Choreography-based sagas cannot handle more than 3 steps"],
      "correct": 1,
      "explanation": "In choreography, each service listens for events and decides what to do — saga state is distributed across multiple service logs, making debugging and compensation sequencing difficult. Orchestration uses a dedicated orchestrator that holds explicit saga state, issues commands, and handles failures deterministically."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Reactive Saga Orchestrator for a Four-Step Payment Flow",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a reactive saga orchestrator for the four-step payment flow (Reserve Funds → Execute Transfer → Credit Destination → Send Notification). Each step must be a Mono<StepResult> that persists state to a R2DBC repository before returning. The orchestrator must chain steps using flatMap and trigger compensation in reverse order on any step failure."},
    {"id": "2", "description": "Make the saga idempotent: before executing each step, check the persisted saga state to determine if the step was already completed. If COMPLETED, skip to the next step. If IN_PROGRESS (from a crashed execution), determine whether to retry or treat as failed. Write a test that simulates a crash mid-saga and verifies correct resumption."},
    {"id": "3", "description": "Implement compensation as a reactive chain: if the Execute Transfer step fails, run Release Funds compensation as a Mono that retries 3 times with exponential backoff. If compensation itself fails, mark the saga as COMPENSATION_FAILED and emit to a human intervention queue. Test compensation with a forced failure of the Execute Transfer step."},
    {"id": "4", "description": "Add saga observability: instrument each step transition with a Micrometer histogram (payment.saga.step.duration tagged by step and outcome), a gauge for in-flight sagas (payment.saga.in_flight), and a counter for compensated sagas. Build a Grafana dashboard showing saga throughput, step failure rates, and compensation frequency."}
  ]
}
-->

---
