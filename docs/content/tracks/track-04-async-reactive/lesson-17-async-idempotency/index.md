---
id: track-04-lesson-17
title: "Async Idempotency — At-Least-Once in Reactive Systems"
slug: async-idempotency
track: track-04
trackName: "Async & Reactive Systems"
sequence: 17
difficulty: principal
estimatedMinutes: 80
status: published
tags: [idempotency, async, deduplication, at-least-once, reactive]
prerequisites: [track-04-lesson-16]
---

# Async Idempotency — At-Least-Once in Reactive Systems

> [!NOTE]
> At-least-once delivery is the default guarantee for Kafka, most HTTP retry policies, and virtually every async messaging system. Without idempotency, at-least-once becomes "charge-the-customer-twice". In financial systems, idempotency is not an optimisation — it is a correctness requirement.

## The Idempotency Problem in Reactive Systems

Reactive and async systems deliver events at-least-once by design. Network retries, Kafka consumer rebalances, process restarts, and saga compensation all cause the same message to be processed multiple times. The question is never "will this message be replayed?" but "how many times and with what state when it arrives the second time?"

Classical idempotency approaches — checking a database row before writing — do not compose well with non-blocking pipelines. You need patterns that fit naturally into `Mono` and `Flux` chains without introducing blocking checkpoints.

This lesson covers:
- Idempotency at the HTTP layer (WebFlux request deduplication)
- Idempotency at the message layer (Kafka consumer deduplication)
- Redis-backed idempotency store with reactive client
- `Mono.cache()` for in-process deduplication
- Replay window management and TTL strategy

---

## Idempotency Key Design

An idempotency key uniquely identifies an operation. The key must be:
- **Deterministic** — same input always produces the same key
- **Scoped** — unique within an operation type, not globally
- **Bounded lifetime** — keys expire after a replay window (typically 24h–7d)

```java
// Idempotency key strategies for different operation types
public class IdempotencyKeyStrategy {

    // For HTTP APIs: client-provided key in header
    public static String fromHeader(ServerHttpRequest request) {
        String key = request.getHeaders().getFirst("Idempotency-Key");
        if (key == null || key.isBlank()) {
            throw new MissingIdempotencyKeyException("Idempotency-Key header required");
        }
        return key;
    }

    // For payment operations: deterministic from payment attributes
    public static String forPayment(String sourceAccount, String destAccount,
                                     BigDecimal amount, String currency, Instant requestTime) {
        // Round to 1-minute buckets to allow natural retry within a minute
        long bucket = requestTime.getEpochSecond() / 60;
        return "pay-%s-%s-%s-%s-%d".formatted(
            sourceAccount, destAccount, amount.toPlainString(), currency, bucket
        );
    }

    // For Kafka messages: use the Kafka record key + offset
    public static String fromKafkaRecord(String topic, int partition, long offset) {
        return "kafka-%s-%d-%d".formatted(topic, partition, offset);
    }

    // For saga steps: derived from saga ID and step name
    public static String forSagaStep(UUID sagaId, String stepName) {
        return "%s-%s".formatted(stepName.toLowerCase(), sagaId);
    }
}
```

---

## Redis-Backed Reactive Idempotency Store

The idempotency store is the backbone of deduplication. It must be:
- Non-blocking (uses ReactiveRedisTemplate)
- Atomic SET-NX operations to prevent race conditions
- TTL-managed to bound storage growth

```java
@Component
@Slf4j
public class ReactiveIdempotencyStore {

    private final ReactiveRedisTemplate<String, IdempotencyRecord> redisTemplate;
    private static final Duration DEFAULT_TTL = Duration.ofHours(24);
    private static final String KEY_PREFIX = "idempotency:";

    public ReactiveIdempotencyStore(ReactiveRedisTemplate<String, IdempotencyRecord> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    // Returns existing result if key already processed, or executes and stores the result
    public <T> Mono<T> executeIdempotently(
        String idempotencyKey,
        Mono<T> operation,
        Class<T> resultType,
        Duration ttl
    ) {
        String redisKey = KEY_PREFIX + idempotencyKey;

        return redisTemplate.opsForValue().get(redisKey)
            .flatMap(existing -> {
                if (existing.status() == IdempotencyStatus.COMPLETED) {
                    log.debug("Idempotency hit key={} returning cached result", idempotencyKey);
                    return Mono.just(resultType.cast(existing.result()));
                }
                if (existing.status() == IdempotencyStatus.IN_PROGRESS) {
                    // Another instance is processing this key — wait and retry
                    return Mono.error(new IdempotencyConflictException(
                        "Key %s is being processed by another instance".formatted(idempotencyKey)
                    ));
                }
                return Mono.error(new IllegalStateException("Unknown status: " + existing.status()));
            })
            .switchIfEmpty(Mono.defer(() -> {
                // Atomically claim the key
                IdempotencyRecord inProgress = new IdempotencyRecord(
                    idempotencyKey, IdempotencyStatus.IN_PROGRESS, null, Instant.now()
                );
                return redisTemplate.opsForValue()
                    .setIfAbsent(redisKey, inProgress, ttl)
                    .flatMap(acquired -> {
                        if (!acquired) {
                            // Lost the race — another instance claimed it
                            return Mono.error(new IdempotencyConflictException(
                                "Key %s claimed by concurrent request".formatted(idempotencyKey)
                            ));
                        }
                        // Execute and store result
                        return operation
                            .flatMap(result -> {
                                IdempotencyRecord completed = new IdempotencyRecord(
                                    idempotencyKey, IdempotencyStatus.COMPLETED, result, Instant.now()
                                );
                                return redisTemplate.opsForValue()
                                    .set(redisKey, completed, ttl)
                                    .thenReturn(result);
                            })
                            .onErrorResume(ex -> {
                                // Remove the in-progress marker so the client can retry
                                return redisTemplate.delete(redisKey)
                                    .then(Mono.error(ex));
                            });
                    });
            }));
    }

    public Mono<Boolean> hasBeenProcessed(String idempotencyKey) {
        return redisTemplate.hasKey(KEY_PREFIX + idempotencyKey);
    }

    public Mono<Void> invalidate(String idempotencyKey) {
        return redisTemplate.delete(KEY_PREFIX + idempotencyKey).then();
    }
}

// Idempotency record stored in Redis
public record IdempotencyRecord(
    String key,
    IdempotencyStatus status,
    Object result,         // serialized response body
    Instant processedAt
) {}

public enum IdempotencyStatus { IN_PROGRESS, COMPLETED, FAILED }
```

---

## WebFlux Idempotency Filter

A WebFlux filter intercepts all requests that carry an `Idempotency-Key` header and applies deduplication transparently.

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
@Slf4j
public class IdempotencyWebFilter implements WebFilter {

    private final ReactiveIdempotencyStore idempotencyStore;
    private static final Set<String> IDEMPOTENCY_REQUIRED_METHODS = Set.of("POST", "PATCH");
    private static final Set<String> IDEMPOTENCY_APPLICABLE_PATHS = Set.of(
        "/payments", "/transfers", "/refunds", "/mandates"
    );

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        ServerHttpRequest request = exchange.getRequest();

        if (!requiresIdempotencyCheck(request)) {
            return chain.filter(exchange);
        }

        String idempotencyKey = request.getHeaders().getFirst("Idempotency-Key");
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return writeError(exchange, HttpStatus.BAD_REQUEST,
                "Idempotency-Key header is required for this operation");
        }

        return idempotencyStore.executeIdempotently(
                idempotencyKey,
                captureResponse(exchange, chain),
                CapturedResponse.class,
                Duration.ofHours(24)
            )
            .flatMap(captured -> replayResponse(exchange, captured))
            .onErrorResume(IdempotencyConflictException.class, ex ->
                writeError(exchange, HttpStatus.CONFLICT,
                    "Request with this Idempotency-Key is already being processed")
            );
    }

    private boolean requiresIdempotencyCheck(ServerHttpRequest request) {
        String method = request.getMethod().name();
        String path = request.getPath().value();
        return IDEMPOTENCY_REQUIRED_METHODS.contains(method)
            && IDEMPOTENCY_APPLICABLE_PATHS.stream().anyMatch(path::startsWith);
    }

    private Mono<CapturedResponse> captureResponse(ServerWebExchange exchange, WebFilterChain chain) {
        ServerHttpResponseDecorator decorator = new ServerHttpResponseDecorator(exchange.getResponse()) {
            private final DataBufferFactory bufferFactory = exchange.getResponse().bufferFactory();
            private final List<DataBuffer> buffers = new ArrayList<>();

            @Override
            public Mono<Void> writeWith(Publisher<? extends DataBuffer> body) {
                return Flux.from(body)
                    .doOnNext(buffers::add)
                    .then(super.writeWith(Flux.fromIterable(buffers)));
            }
        };

        ServerWebExchange mutated = exchange.mutate().response(decorator).build();
        return chain.filter(mutated)
            .then(Mono.just(new CapturedResponse(
                decorator.getStatusCode(),
                decorator.getHeaders(),
                captureBody(decorator)
            )));
    }

    private Mono<Void> replayResponse(ServerWebExchange exchange, CapturedResponse captured) {
        exchange.getResponse().setStatusCode(captured.statusCode());
        exchange.getResponse().getHeaders().addAll(captured.headers());
        exchange.getResponse().getHeaders().set("Idempotent-Replayed", "true");
        DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(captured.body());
        return exchange.getResponse().writeWith(Mono.just(buffer));
    }

    private Mono<Void> writeError(ServerWebExchange exchange, HttpStatus status, String message) {
        exchange.getResponse().setStatusCode(status);
        byte[] bytes = ("{\"error\":\"%s\"}".formatted(message)).getBytes(StandardCharsets.UTF_8);
        DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(bytes);
        return exchange.getResponse().writeWith(Mono.just(buffer));
    }
}
```

---

## Service-Layer Idempotency

For finer-grained control, apply idempotency at the service layer rather than the filter layer.

```java
@Service
@Slf4j
public class PaymentService {

    private final ReactiveIdempotencyStore idempotencyStore;
    private final PaymentRepository paymentRepository;
    private final LedgerService ledgerService;

    public Mono<PaymentResponse> initiatePayment(PaymentRequest request, String idempotencyKey) {
        return idempotencyStore.executeIdempotently(
            "payment:" + idempotencyKey,
            Mono.defer(() -> doInitiatePayment(request)),
            PaymentResponse.class,
            Duration.ofHours(24)
        );
    }

    private Mono<PaymentResponse> doInitiatePayment(PaymentRequest request) {
        Payment payment = Payment.create(request);

        return paymentRepository.findByClientReference(request.clientReference())
            .switchIfEmpty(paymentRepository.save(payment))
            .flatMap(saved ->
                ledgerService.debitAccount(
                    saved.sourceAccountId(), saved.amount(), saved.currency(), saved.id().toString()
                )
                .thenReturn(PaymentResponse.from(saved))
            );
    }
}
```

---

## Deduplicating Kafka Messages Reactively

Kafka delivers messages at-least-once. Each consumer must deduplicate before processing.

```java
@Service
@Slf4j
public class ReactivePaymentEventConsumer {

    private final ReactiveIdempotencyStore idempotencyStore;
    private final PaymentProcessingService processingService;
    private final KafkaReceiver<String, PaymentEvent> receiver;

    @Bean
    public Disposable consumePaymentEvents() {
        return receiver.receive()
            .groupBy(record -> record.partition())
            .flatMap(partitionFlux -> partitionFlux
                .concatMap(record -> processWithDeduplication(record)
                    .doFinally(signal -> record.receiverOffset().acknowledge())
                ),
                10 // concurrency: max 10 partitions in-flight
            )
            .subscribe(
                result -> log.debug("Processed event: {}", result),
                error  -> log.error("Fatal error in payment consumer", error)
            );
    }

    private Mono<Void> processWithDeduplication(ReceiverRecord<String, PaymentEvent> record) {
        PaymentEvent event = record.value();
        String idempotencyKey = "kafka-event:" + event.eventId();

        return idempotencyStore.hasBeenProcessed(idempotencyKey)
            .flatMap(alreadyProcessed -> {
                if (alreadyProcessed) {
                    log.debug("Duplicate event skipped eventId={} topic={} partition={} offset={}",
                        event.eventId(), record.topic(), record.partition(), record.offset());
                    return Mono.empty();
                }

                return processingService.processPaymentEvent(event)
                    .flatMap(result ->
                        idempotencyStore.executeIdempotently(
                            idempotencyKey,
                            Mono.just(result),
                            ProcessingResult.class,
                            Duration.ofDays(7) // 7-day replay window for Kafka
                        )
                    )
                    .then();
            });
    }
}
```

---

## Mono.cache() for In-Process Deduplication

`Mono.cache()` caches the first subscription's result and replays it to subsequent subscribers. This is useful for deduplicating concurrent in-process calls, not cross-process or cross-restart deduplication.

```java
@Service
public class ExchangeRateService {

    private final ExchangeRateGateway gateway;
    // Cache exchange rates per currency pair for 30 seconds
    private final Map<String, Mono<ExchangeRate>> rateCache = new ConcurrentHashMap<>();

    public Mono<ExchangeRate> getRate(String fromCurrency, String toCurrency) {
        String cacheKey = fromCurrency + "-" + toCurrency;
        return rateCache.computeIfAbsent(cacheKey, k ->
            gateway.fetchRate(fromCurrency, toCurrency)
                .cache(Duration.ofSeconds(30))  // shares result for 30s across all callers
                .doOnSuccess(rate -> log.debug("Fetched exchange rate {} -> {} = {}", fromCurrency, toCurrency, rate.rate()))
        );
    }

    // For payment fee calculations — deduplicate concurrent calls for the same fee schedule
    public Mono<FeeSchedule> getFeeSchedule(String merchantCategory, String region) {
        return Mono.defer(() ->
            feeScheduleRepository.findByMerchantCategoryAndRegion(merchantCategory, region)
        )
        .cache(Duration.ofMinutes(5)); // shared across all concurrent requests for 5 minutes
    }
}
```

**Important limitation**: `Mono.cache()` with a TTL creates a shared `Mono` — once it emits, all subscribers get the same cached value until TTL expires. After expiry, the next subscriber triggers a fresh upstream call and all concurrent subscribers wait for that result. This is correct for read-only data but never appropriate for write operations.

---

## Database-Level Idempotency with Unique Constraints

For critical financial operations, back idempotency with a database unique constraint as a last line of defence.

```java
// Payment table schema includes unique constraint on idempotency_key
// CREATE UNIQUE INDEX payments_idempotency_key_idx ON payments(idempotency_key) WHERE status != 'CANCELLED';

@Service
public class RobustPaymentService {

    private final PaymentRepository paymentRepository;
    private final ReactiveIdempotencyStore idempotencyStore;

    public Mono<Payment> createPayment(CreatePaymentCommand command) {
        // Layer 1: Redis fast-path check
        String idemKey = command.idempotencyKey();
        return idempotencyStore.hasBeenProcessed("create-payment:" + idemKey)
            .flatMap(alreadyDone -> {
                if (alreadyDone) {
                    return paymentRepository.findByIdempotencyKey(idemKey);
                }
                return executeCreatePayment(command, idemKey);
            });
    }

    private Mono<Payment> executeCreatePayment(CreatePaymentCommand command, String idemKey) {
        Payment payment = new Payment(
            UUID.randomUUID(),
            command.sourceAccount(),
            command.destinationAccount(),
            command.amount(),
            command.currency(),
            idemKey,
            PaymentStatus.PENDING,
            Instant.now()
        );

        return paymentRepository.save(payment)
            // Layer 2: Database unique constraint catches any Redis miss
            .onErrorResume(DataIntegrityViolationException.class, ex -> {
                log.warn("Duplicate payment detected via DB constraint idempotencyKey={}", idemKey);
                return paymentRepository.findByIdempotencyKey(idemKey);
            })
            .flatMap(saved ->
                idempotencyStore.executeIdempotently(
                    "create-payment:" + idemKey,
                    Mono.just(saved),
                    Payment.class,
                    Duration.ofHours(24)
                )
            );
    }
}
```

---

## Replay Window Strategy

The replay window is the period during which a duplicate request is detected and the original response is returned. After the window expires, the same key is treated as a new request.

```java
@Component
public class IdempotencyWindowPolicy {

    // Different replay windows for different operation risk levels
    public Duration windowFor(OperationType type) {
        return switch (type) {
            // Payment operations: 24h (covers retry within business day)
            case PAYMENT_INITIATION   -> Duration.ofHours(24);
            // Refunds: 7 days (covers manual retry by support team)
            case REFUND               -> Duration.ofDays(7);
            // Webhooks: 72h (covers retry backoff by third-party systems)
            case WEBHOOK_DELIVERY     -> Duration.ofHours(72);
            // Read operations: not idempotency-managed (always safe to retry)
            case BALANCE_INQUIRY      -> Duration.ZERO;
            // Kafka messages: 7 days (covers Kafka retention period)
            case KAFKA_EVENT          -> Duration.ofDays(7);
        };
    }

    // Store size estimation: each key ~200 bytes in Redis
    // 1M payments/day * 200 bytes * 7 days = ~1.4GB
    // Redis memory planning should account for this
    public long estimatedStoreSize(long dailyOperations, Duration window) {
        long windowDays = window.toDays() + 1;
        long bytesPerKey = 200;
        return dailyOperations * windowDays * bytesPerKey;
    }
}
```

---

## Handling Partial Success in Idempotent Operations

When an operation partially succeeds before failure, subsequent retries must resume correctly.

```java
@Service
@Slf4j
public class IdempotentLedgerService {

    private final ReactiveIdempotencyStore idempotencyStore;
    private final LedgerEntryRepository ledgerRepository;
    private final AccountRepository accountRepository;

    // A ledger entry write is a two-phase operation:
    // 1. Write ledger entry
    // 2. Update account balance
    // If step 2 fails, retry must not duplicate the ledger entry
    public Mono<LedgerEntry> writeLedgerEntry(
        String accountId, BigDecimal amount, LedgerEntryType type, String idempotencyKey
    ) {
        return idempotencyStore.executeIdempotently(
            "ledger:" + idempotencyKey,
            Mono.defer(() ->
                // Check if ledger entry already exists (handles crash between steps 1 and 2)
                ledgerRepository.findByIdempotencyKey(idempotencyKey)
                    .switchIfEmpty(ledgerRepository.save(new LedgerEntry(
                        UUID.randomUUID(), accountId, amount, type, idempotencyKey, Instant.now()
                    )))
                    .flatMap(entry ->
                        // Check if balance already updated
                        accountRepository.isBalanceUpdatedFor(idempotencyKey)
                            .flatMap(alreadyUpdated -> {
                                if (alreadyUpdated) {
                                    return Mono.just(entry);
                                }
                                return accountRepository.updateBalance(accountId, amount, idempotencyKey)
                                    .thenReturn(entry);
                            })
                    )
            ),
            LedgerEntry.class,
            Duration.ofHours(24)
        );
    }
}
```

---

## Testing Idempotency in Reactive Pipelines

```java
@SpringBootTest
@ExtendWith(SpringExtension.class)
class ReactiveIdempotencyTest {

    @Autowired
    private PaymentService paymentService;

    @Autowired
    private ReactiveIdempotencyStore idempotencyStore;

    @MockBean
    private LedgerService ledgerService;

    @Test
    void shouldReturnSameResultForDuplicateIdempotencyKey() {
        String idemKey = UUID.randomUUID().toString();
        PaymentRequest request = PaymentRequest.builder()
            .sourceAccount("ACC-001")
            .destinationAccount("ACC-002")
            .amount(new BigDecimal("250.00"))
            .currency("GBP")
            .build();

        when(ledgerService.debitAccount(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubLedgerEntry()));

        // First call
        PaymentResponse first = paymentService.initiatePayment(request, idemKey).block();

        // Second call with same key — debit should NOT be called again
        PaymentResponse second = paymentService.initiatePayment(request, idemKey).block();

        assertThat(first.paymentId()).isEqualTo(second.paymentId());
        assertThat(second.idempotentReplay()).isTrue();
        verify(ledgerService, times(1)).debitAccount(any(), any(), any(), any());
    }

    @Test
    void shouldProcessDifferentKeysIndependently() {
        when(ledgerService.debitAccount(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubLedgerEntry()));

        String key1 = UUID.randomUUID().toString();
        String key2 = UUID.randomUUID().toString();
        PaymentRequest request = stubRequest();

        PaymentResponse r1 = paymentService.initiatePayment(request, key1).block();
        PaymentResponse r2 = paymentService.initiatePayment(request, key2).block();

        assertThat(r1.paymentId()).isNotEqualTo(r2.paymentId());
        verify(ledgerService, times(2)).debitAccount(any(), any(), any(), any());
    }

    @Test
    void shouldNotCacheFailedOperation() {
        String idemKey = UUID.randomUUID().toString();
        PaymentRequest request = stubRequest();

        // First call fails
        when(ledgerService.debitAccount(any(), any(), any(), any()))
            .thenReturn(Mono.error(new LedgerException("Ledger unavailable")));

        StepVerifier.create(paymentService.initiatePayment(request, idemKey))
            .expectError(LedgerException.class)
            .verify();

        // Second call should retry, not return cached failure
        when(ledgerService.debitAccount(any(), any(), any(), any()))
            .thenReturn(Mono.just(stubLedgerEntry()));

        StepVerifier.create(paymentService.initiatePayment(request, idemKey))
            .assertNext(response -> assertThat(response).isNotNull())
            .verifyComplete();

        verify(ledgerService, times(2)).debitAccount(any(), any(), any(), any());
    }

    @Test
    void concurrentRequestsWithSameKeyProcessedOnce() throws InterruptedException {
        String idemKey = UUID.randomUUID().toString();
        AtomicInteger processingCount = new AtomicInteger(0);
        CountDownLatch latch = new CountDownLatch(1);

        when(ledgerService.debitAccount(any(), any(), any(), any()))
            .thenAnswer(inv -> Mono.defer(() -> {
                processingCount.incrementAndGet();
                return Mono.just(stubLedgerEntry()).delayElement(Duration.ofMillis(50));
            }));

        // Fire 10 concurrent requests with the same idempotency key
        List<Mono<PaymentResponse>> requests = IntStream.range(0, 10)
            .mapToObj(i -> paymentService.initiatePayment(stubRequest(), idemKey))
            .collect(toList());

        List<PaymentResponse> results = Flux.merge(requests)
            .collectList()
            .block(Duration.ofSeconds(5));

        // All responses should be for the same payment
        assertThat(results).hasSize(10);
        assertThat(results.stream().map(PaymentResponse::paymentId).distinct().count()).isEqualTo(1L);
        // Ledger debited exactly once
        assertThat(processingCount.get()).isEqualTo(1);
    }
}
```

---

## Production Considerations

**Redis availability**: If Redis is unavailable, the idempotency store falls back to database-level duplicate detection (unique constraint). Never let Redis unavailability block all payment processing — degrade gracefully to the database layer.

```java
public <T> Mono<T> executeIdempotentlyWithFallback(
    String key, Mono<T> operation, Class<T> type, Duration ttl
) {
    return executeIdempotently(key, operation, type, ttl)
        .onErrorResume(RedisConnectionException.class, ex -> {
            log.warn("Redis unavailable for idempotency check key={} falling back to DB", key);
            return operation; // DB unique constraints are the safety net
        });
}
```

**Key collision analysis**: Idempotency keys must be unique per customer per operation type. A key shared across customers is a security vulnerability — customer A could inadvertently see customer B's response. Always scope keys by customer ID.

**Storing response vs storing outcome**: Storing the full HTTP response body costs more memory but enables exact replay including headers and status code. Storing just the outcome (payment ID, status) is more memory-efficient and sufficient for most financial operations.

**Clock drift in time-bucketed keys**: When using time-based key bucketing, account for clock skew across service instances. Use a 2x bucket overlap or rely on client-provided idempotency keys rather than server-generated time-based keys.

**Key metrics to monitor**:
- `idempotency.cache.hit_rate` — high hit rate under normal conditions is expected during batch retries
- `idempotency.conflict` counter — concurrent requests for the same key; investigate if elevated
- `idempotency.redis.errors` — Redis failures degrading to DB-only mode
- `payment.duplicate_detected` — count of deduplicated payments prevented

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why is at-least-once delivery the default guarantee in Kafka and most async messaging systems, and what problem does this create for financial systems?",
      "options": ["At-least-once is the safest delivery guarantee", "Exactly-once delivery requires distributed consensus on every message, which is too expensive; at-least-once is achievable with retries. For financial systems, this means the same payment event may be processed multiple times without idempotency, causing duplicate charges.", "At-least-once is configured for performance; exactly-once is an option teams do not enable", "Kafka retries only occur during rebalances, not during normal operation"],
      "correct": 1,
      "explanation": "Exactly-once delivery requires distributed coordination that adds latency and complexity. At-least-once is cheaper: if a message is not acknowledged, retry it. The downside is duplicates. Financial systems must implement idempotency to ensure duplicate messages produce the same result as a single message."
    },
    {
      "text": "What are the three required properties of a well-designed idempotency key?",
      "options": ["Random, globally unique, long-lived", "Deterministic (same input → same key), scoped to an operation type, and bounded lifetime (expires after a replay window)", "UUID-based, stored in Redis, and hashed with SHA-256", "Client-provided, server-validated, and stored in the database as a primary key"],
      "correct": 1,
      "explanation": "Determinism ensures the same operation always produces the same key, enabling deduplication. Scoping prevents collisions across different operation types. Bounded lifetime (24h–7d TTL) prevents the idempotency store from growing unboundedly while covering reasonable retry windows."
    },
    {
      "text": "Why is Redis preferred over a relational database for the idempotency store in a high-throughput reactive payment service?",
      "options": ["Redis supports JSON natively, making response storage simpler", "Redis offers sub-millisecond SET NX operations (atomic check-and-set) with built-in TTL expiration, adding minimal latency to the payment critical path; a relational DB row check adds significant latency under high concurrency", "Redis is ACID-compliant and supports distributed transactions", "Redis idempotency keys survive process restarts unlike in-memory caches"],
      "correct": 1,
      "explanation": "The idempotency check is on the payment critical path — it must complete in under 1ms to avoid adding meaningful latency. Redis SET NX (Set if Not eXists) is atomic and executes in sub-millisecond. Its built-in TTL handles expiration automatically. RDBMS row checks under high concurrency add lock contention and query latency."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Redis-Backed Reactive Idempotency Layer for Payment Processing",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a reactive IdempotencyService using Lettuce (reactive Redis client) that: (1) attempts SET NX with 24h TTL on a composite key of operation-type + idempotency key, (2) if SET returns 1 (new key), processes the payment and stores the response in Redis, (3) if SET returns 0 (duplicate), retrieves and returns the stored response. Verify exactly-once processing with a concurrent test of 50 requests with the same key."},
    {"id": "2", "description": "Implement idempotency degradation: if Redis is unavailable, fall back to a database-backed idempotency check using R2DBC with a PostgreSQL table. Use onErrorResume to switch to the DB fallback and emit a Redis-unavailable metric. Test that payment processing continues during a simulated Redis outage."},
    {"id": "3", "description": "Handle the race condition between two concurrent requests with the same idempotency key: the first request is mid-processing when the second arrives. Implement a 'processing' sentinel value in Redis that the second request detects, then polls with a 100ms retry interval for up to 5 seconds for the first request to complete. Write a test using two parallel Monos that simulates this race."},
    {"id": "4", "description": "Build a Kafka consumer idempotency layer: for each payment event, extract a composite key from the Kafka headers (original-topic + partition + offset). Before processing, check Redis using SET NX. After successful processing, acknowledge the offset. Verify with a test that replaying the same Kafka offset 3 times results in exactly one payment record created."}
  ]
}
-->

---
