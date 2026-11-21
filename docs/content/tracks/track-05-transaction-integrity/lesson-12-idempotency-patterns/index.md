---
id: track-05-lesson-12
sequence: 12
title: "Idempotency — Design Patterns and Implementation"
slug: idempotency-patterns
track: track-05
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [idempotency, idempotency-key, UNIQUE-constraint, Redis, distributed-idempotency]
java-versions: [17, 21]
---

## Overview

Idempotency is the contractual guarantee that submitting an identical operation multiple times produces exactly the same result as submitting it once. For payment systems, this guarantee is not a convenience feature — it is a correctness requirement. Every retry path, every network timeout, and every Kafka redelivery is a potential duplicate, and without idempotency the customer pays twice. This lesson covers idempotency rigorously: the mathematical definition, the three layers at which it must be enforced (HTTP, database, messaging), how a distributed Redis store handles race conditions, and how to test idempotency under concurrency.

## Learning Objectives

By the end of this lesson you will be able to:

- State the precise mathematical definition of idempotency and explain why it applies at every layer of a payment stack.
- Implement an HTTP-layer `IdempotencyFilter` using Redis `SET NX` with TTL, and explain what happens on a cache miss versus a cache hit.
- Design a database-layer idempotency guard using a `UNIQUE` constraint and `INSERT … ON CONFLICT DO NOTHING RETURNING`.
- Configure Kafka producer idempotence (`enable.idempotence=true`) and implement consumer-side deduplication via a `processed_events` table.
- Explain why a Redis `SET NX` claim can be lost on failover (asynchronous replication), and why the database must stay the final arbiter.
- Write a concurrent integration test that submits the same payment three times simultaneously and asserts the side effect occurred exactly once.

## Business Context

**A duplicate-transfer incident (composite example, based on a common pattern)**

A European neobank suffers a production incident in which a client-side retry storm — triggered by a 30-second network timeout — caused 847 payment transfer requests to be processed twice. The duplicate payments totalled EUR 1.2 million. Recovery required manual reversal, three days of reconciliation work, and an incident report to the regulator.

Root cause analysis identified three missing controls:

1. No idempotency key on the `/transfers` endpoint. Each HTTP retry was treated as a new request.
2. No `UNIQUE` constraint on the `payment_requests` table. The application relied solely on application-level deduplication, which failed under concurrent retries.
3. The Kafka consumer had no consumer-side dedup. A broker failover caused message redelivery (which at-least-once delivery always allows), and the consumer processed the messages a second time.

All three gaps were independently exploitable. This lesson covers all three fixes.

> [!IMPORTANT]
> Under normal load retries are a small fraction of payment API calls, but during infrastructure incidents they can spike sharply — exactly when systems are already stressed. Your idempotency layer must handle both the steady-state case and the spike case without degrading latency.

## 1. The Precise Definition

A function `f` is idempotent if and only if:

```
f(f(x)) = f(x)   for all x in the domain of f
```

For HTTP, idempotent means that repeating a request has the same effect on the server as sending it once. `GET`, `PUT` and `DELETE` are defined as idempotent; `POST` is not. For payment operations, we make `POST /payments` behave idempotently by keying on a client-supplied idempotency key. The contract is:

- Same idempotency key + same request body → same response, side effect executed at most once.
- Same idempotency key + different request body → `422 Unprocessable Entity` (conflict detection).
- Different idempotency key → new execution.

> [!NOTE]
> RFC 9110 (which replaced RFC 7231 in 2022) defines idempotency for HTTP methods but provides no mechanism for making `POST` idempotent. The `Idempotency-Key` header pattern was popularised by Stripe and is now a proposed IETF standard (draft-ietf-httpapi-idempotency-key-header).

## 2. The Idempotency Key

The client generates a UUID v4 before the first attempt and sends it as a request header:

```
POST /api/v1/payments
Idempotency-Key: 7f3c2a1e-4b8d-4f9e-a1c2-3d5e7f9a0b2c
Content-Type: application/json

{ "amount": 10000, "currency": "GBP", "creditorAccount": "GB29NWBK..." }
```

The server stores the key with:
- The SHA-256 hash of the request body (to detect body mismatches on replay).
- The serialised response (status code + body).
- A TTL of 24 hours (Stripe uses 24 h; adjust to your SLA window).

On a subsequent request with the same key the server returns the stored response immediately, without re-executing any business logic.

```java
// IdempotencyKeyGenerator.java — client side utility
public final class IdempotencyKeyGenerator {

    private IdempotencyKeyGenerator() {}

    /**
     * Generate a stable key for an operation. The caller should persist this
     * key and reuse it on every retry of the same logical operation.
     */
    public static String generate() {
        return UUID.randomUUID().toString();
    }

    /**
     * Deterministic key for a business operation — useful when the client
     * cannot persist state (e.g. a batch job replaying after a crash).
     * Derived ONLY from the stable business identity of the operation.
     * Never mix in the current date or time: a retry that runs after
     * midnight would get a new key and pay a second time.
     */
    public static String deterministic(String operationType, String businessId) {
        String seed = operationType + ":" + businessId;   // e.g. "payroll-line:2026-11-batch7:row42"
        return UUID.nameUUIDFromBytes(seed.getBytes(StandardCharsets.UTF_8)).toString();
    }
}
```

## 3. Layer 1 — HTTP Idempotency Filter

The filter intercepts every mutating request before it reaches the controller. It uses Redis `SET key value EX seconds NX` — a single atomic command that sets the key only if it does not exist.

```java
// IdempotencyFilter.java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class IdempotencyFilter extends OncePerRequestFilter {

    private static final String HEADER          = "Idempotency-Key";
    private static final Duration TTL           = Duration.ofHours(24);
    private static final String PREFIX          = "idmp:";

    private final StringRedisTemplate redis;
    private final ObjectMapper        mapper;

    public IdempotencyFilter(StringRedisTemplate redis, ObjectMapper mapper) {
        this.redis  = redis;
        this.mapper = mapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {

        // Only intercept state-mutating methods
        if (!isMutating(request.getMethod())) {
            chain.doFilter(request, response);
            return;
        }

        String idempotencyKey = request.getHeader(HEADER);
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            response.sendError(HttpServletResponse.SC_BAD_REQUEST,
                    "Idempotency-Key header is required");
            return;
        }

        if (!isValidUuid(idempotencyKey)) {
            // RETURN after sending the error — otherwise the request would
            // still be processed
            response.sendError(HttpServletResponse.SC_BAD_REQUEST,
                    "Idempotency-Key must be a valid UUID");
            return;
        }

        // Scope the key to the authenticated client: two clients that happen to
        // send the same key must never see each other's stored responses
        String redisKey = PREFIX + clientId(request) + ":" + idempotencyKey;

        // Try to claim the key — NX means "only if not exists"
        Boolean claimed = redis.opsForValue()
                .setIfAbsent(redisKey, "PROCESSING", TTL);

        if (Boolean.FALSE.equals(claimed)) {
            // Key already exists — either PROCESSING or a completed response
            String stored = redis.opsForValue().get(redisKey);

            if ("PROCESSING".equals(stored)) {
                // Another thread is mid-flight — return 409 so client backs off
                response.setStatus(HttpStatus.CONFLICT.value());
                response.getWriter().write("{\"error\":\"request_in_progress\"}");
                return;
            }

            // Stored value is a serialised CachedResponse
            CachedResponse cached = mapper.readValue(stored, CachedResponse.class);
            replayResponse(cached, response);
            return;
        }

        // We own the key — wrap the response to capture it
        ContentCachingResponseWrapper wrapper =
                new ContentCachingResponseWrapper(response);
        try {
            chain.doFilter(request, wrapper);
            wrapper.copyBodyToResponse();

            if (wrapper.getStatus() >= 500) {
                // Server error: the outcome may be unknown — do not cache it as
                // final. Release the key; the database layer still prevents a
                // second execution if the first one actually committed.
                redis.delete(redisKey);
                return;
            }
            // Serialise and store the completed response, replacing PROCESSING
            byte[] body    = wrapper.getContentAsByteArray();
            CachedResponse cached = new CachedResponse(
                    wrapper.getStatus(), body, wrapper.getContentType());
            redis.opsForValue().set(redisKey, mapper.writeValueAsString(cached), TTL);

        } catch (Exception ex) {
            // On failure, remove the key so the client can retry
            redis.delete(redisKey);
            throw ex;
        }
    }

    private void replayResponse(CachedResponse cached, HttpServletResponse response)
            throws IOException {
        response.setStatus(cached.status());
        response.setContentType(cached.contentType());
        response.getOutputStream().write(cached.body());
    }

    private boolean isMutating(String method) {
        return "POST".equalsIgnoreCase(method)
                || "PUT".equalsIgnoreCase(method)
                || "PATCH".equalsIgnoreCase(method);
    }

    private boolean isValidUuid(String key) {
        try {
            UUID.fromString(key);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    public record CachedResponse(int status, byte[] body, String contentType) {}
}
```

> [!WARNING]
> The two-step write pattern above (`PROCESSING` then the final value) has a small window where a concurrent request sees `PROCESSING` and receives a 409. Clients must handle 409 with a short backoff (200 ms). This is preferable to allowing two simultaneous executions through.

## 4. Layer 2 — Database Idempotency

The HTTP filter handles the common case. For durability across server restarts (Redis eviction, pod recycling), the database provides a second guarantee.

```sql
-- Schema
CREATE TABLE payment_requests (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key   UUID        NOT NULL,
    request_hash      CHAR(64)    NOT NULL,   -- SHA-256 of canonical request body
    status            TEXT        NOT NULL DEFAULT 'PENDING',
    response_body     JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,

    CONSTRAINT uq_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX idx_payment_requests_created ON payment_requests (created_at);
```

The service layer uses `INSERT … ON CONFLICT DO NOTHING RETURNING`. If a concurrent request with the same key has inserted but not yet committed, PostgreSQL makes the second INSERT wait for it — so the duplicate path always sees the committed row. Store the response in the same transaction as the business work, so a committed row always has its response:

```java
// PaymentRequestRepository.java
@Repository
public class PaymentRequestRepository {

    private final JdbcTemplate jdbc;

    public PaymentRequestRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Attempt to insert a new payment request record.
     * Returns the existing record's id if the idempotency key was already used.
     */
    public IdempotencyResult upsertRequest(UUID idempotencyKey,
                                           String requestHash) {
        // Returns the id of the newly inserted row, or empty on conflict
        List<UUID> inserted = jdbc.query(
            """
            INSERT INTO payment_requests (idempotency_key, request_hash)
            VALUES (?, ?)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
            """,
            (rs, row) -> (UUID) rs.getObject("id"),
            idempotencyKey, requestHash
        );

        if (!inserted.isEmpty()) {
            return IdempotencyResult.newRequest(inserted.get(0));
        }

        // Conflict — fetch the existing record
        PaymentRequest existing = jdbc.queryForObject(
            """
            SELECT id, request_hash, status, response_body
            FROM payment_requests
            WHERE idempotency_key = ?
            """,
            this::mapRow, idempotencyKey
        );

        // Guard against body mismatch (different request, same key)
        if (!requestHash.equals(existing.requestHash())) {
            throw new IdempotencyConflictException(
                "Idempotency key reused with a different request body");
        }

        return IdempotencyResult.duplicate(existing);
    }

    private PaymentRequest mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new PaymentRequest(
            (UUID) rs.getObject("id"),
            rs.getString("request_hash"),
            rs.getString("status"),
            rs.getString("response_body")
        );
    }
}

public sealed interface IdempotencyResult {
    record NewRequest(UUID requestId)             implements IdempotencyResult {}
    record Duplicate(PaymentRequest existing)     implements IdempotencyResult {}

    static IdempotencyResult newRequest(UUID id)        { return new NewRequest(id); }
    static IdempotencyResult duplicate(PaymentRequest p){ return new Duplicate(p); }
}
```

```java
// PaymentService.java (excerpt)
@Service
@Transactional
public class PaymentService {

    public PaymentResponse createPayment(CreatePaymentRequest request,
                                         UUID idempotencyKey) {

        String requestHash = sha256(request);
        IdempotencyResult result =
                paymentRequestRepo.upsertRequest(idempotencyKey, requestHash);

        return switch (result) {
            case IdempotencyResult.NewRequest(UUID requestId) ->
                    executePayment(requestId, request);
            case IdempotencyResult.Duplicate(PaymentRequest existing) ->
                    deserialiseResponse(existing.responseBody());
        };
    }

    private String sha256(Object obj) {
        try {
            // Canonical JSON (fixed field order, e.g. ORDER_MAP_ENTRIES_BY_KEYS /
            // SORT_PROPERTIES_ALPHABETICALLY) — otherwise identical requests can hash differently
            byte[] bytes = canonicalMapper.writeValueAsBytes(obj);
            return Hex.encodeHexString(
                MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException("Failed to hash request", e);
        }
    }
}
```

## 5. Layer 3 — Kafka Idempotency

### Producer Side

```java
// KafkaProducerConfig.java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, String> producerFactory(KafkaProperties props) {
        Map<String, Object> config = new HashMap<>(props.buildProducerProperties());

        // Idempotent producer: deduplicates within a single producer session.
        // Requires acks=all and retries > 0.
        config.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        config.put(ProducerConfig.ACKS_CONFIG, "all");
        config.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        config.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);

        return new DefaultKafkaProducerFactory<>(config);
    }
}
```

> [!NOTE]
> `enable.idempotence=true` only deduplicates within the same producer session (same epoch). After a producer restart, the broker assigns a new PID, and duplicate messages from before the restart are not filtered. Consumer-side deduplication is still required.

### Consumer Side

```sql
-- Processed events deduplication table
CREATE TABLE processed_events (
    event_id    UUID        PRIMARY KEY,
    topic       TEXT        NOT NULL,
    partition   INT         NOT NULL,
    offset_val  BIGINT      NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the archival job that purges old rows.
-- (A partial index "WHERE processed_at > NOW() - ..." is not allowed:
--  index predicates may only use IMMUTABLE functions, and NOW() is not.)
CREATE INDEX idx_processed_events_processed_at
    ON processed_events (processed_at);
```

```java
// IdempotentPaymentEventConsumer.java
@Component
public class IdempotentPaymentEventConsumer {

    private static final Logger log =
            LoggerFactory.getLogger(IdempotentPaymentEventConsumer.class);

    private final JdbcTemplate   jdbc;
    private final PaymentService paymentService;

    @KafkaListener(topics = "payment-commands", groupId = "payment-processor")
    // The DATABASE transaction manager: the dedup insert and the payment commit
    // together. (A KafkaTransactionManager does not cover JDBC.) The container
    // commits the offset after this method returns, i.e. after the DB commit.
    @Transactional
    public void consume(ConsumerRecord<String, String> record) {
        UUID eventId = extractEventId(record);

        // Atomic insert — if the row already exists, do nothing
        int inserted = jdbc.update(
            """
            INSERT INTO processed_events (event_id, topic, partition, offset_val)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (event_id) DO NOTHING
            """,
            eventId, record.topic(),
            record.partition(), record.offset()
        );

        if (inserted == 0) {
            log.info("Skipping duplicate event {}", eventId);
            return;
        }

        PaymentCommand command = deserialise(record.value());
        paymentService.executeCommand(command);
    }

    private UUID extractEventId(ConsumerRecord<String, String> record) {
        // Event ID is embedded in the message header by the producer
        Header header = record.headers().lastHeader("event-id");
        if (header == null) {
            throw new IllegalArgumentException(
                "Missing event-id header on record " + record.offset());
        }
        return UUID.fromString(new String(header.value(), StandardCharsets.UTF_8));
    }
}
```

## 6. Distributed Idempotency Store and Race Conditions

The Redis `SET key value EX seconds NX` command is atomic on a single Redis node, and in Redis Cluster each key lives on exactly one primary at a time, so `NX` stays per-key atomic.

The real gap is **failover**. Redis replicates to its replicas **asynchronously**. If the primary acknowledges `SET idmp:abc PROCESSING NX` and crashes before that write reaches a replica, the promoted replica has never seen the key — and a retry's `SET NX` succeeds again. The window is small but real (`WAIT` can narrow it, not close it). That is why Redis can only be the fast first layer; the database `UNIQUE` constraint must be the final arbiter.

```java
// RedisIdempotencyStore.java
@Component
public class RedisIdempotencyStore {

    private final RedisTemplate<String, String> redis;

    private static final String PROCESSING_SENTINEL = "__PROCESSING__";
    private static final Duration TTL = Duration.ofHours(24);
    private static final String  NS  = "idmp:v1:";

    public ClaimResult claim(String idempotencyKey) {
        String key     = NS + idempotencyKey;
        Boolean claimed = redis.opsForValue()
                .setIfAbsent(key, PROCESSING_SENTINEL, TTL);

        if (Boolean.TRUE.equals(claimed)) {
            return ClaimResult.CLAIMED;
        }

        String value = redis.opsForValue().get(key);
        if (PROCESSING_SENTINEL.equals(value)) {
            return ClaimResult.IN_PROGRESS;
        }
        return ClaimResult.DUPLICATE;
    }

    public void storeResult(String idempotencyKey, String serialisedResponse) {
        // Overwrite the PROCESSING sentinel with the actual response.
        // Keep the original TTL by using GETSET + EXPIREAT, or simply
        // accept a refreshed TTL with SET EX (simpler, acceptable trade-off).
        redis.opsForValue().set(NS + idempotencyKey,
                serialisedResponse, TTL);
    }

    public Optional<String> getStoredResult(String idempotencyKey) {
        String value = redis.opsForValue().get(NS + idempotencyKey);
        if (value == null || PROCESSING_SENTINEL.equals(value)) {
            return Optional.empty();
        }
        return Optional.of(value);
    }

    public enum ClaimResult { CLAIMED, IN_PROGRESS, DUPLICATE }
}
```

> [!WARNING]
> For extreme consistency requirements (central bank settlement systems), replace Redis with a database-backed idempotency store. A `UNIQUE` constraint on a PostgreSQL table gives a durable, transactional guarantee at any isolation level — stronger than Redis, at the cost of higher latency.

## 7. Idempotency for Operations with External Side Effects

When your service calls a downstream API (card network, SWIFT gateway), that downstream call must also be idempotent. Pass your idempotency key downstream:

```java
// ExternalProcessorClient.java
@Component
public class ExternalProcessorClient {

    private final RestClient restClient;

    public ProcessorResponse submit(PaymentOrder order, UUID idempotencyKey) {
        return restClient.post()
                .uri("/v1/payments")
                .header("Idempotency-Key", idempotencyKey.toString())
                .body(order)
                .retrieve()
                .body(ProcessorResponse.class);
    }
}
```

**When the external API does not support idempotency keys:**

1. **Claim first:** insert a `PENDING` record keyed on your idempotency key (`ON CONFLICT DO NOTHING`) and commit it *before* calling out. Only the request that wins the claim may call the external system.
2. Call out, then store the outcome against that record.
3. If you find a record still `PENDING` (a crash or timeout happened after the call), the outcome is **unknown**: query the external system for the transaction before doing anything else — never call it again blindly.

```java
// ExternalCallGuard.java — wraps non-idempotent external APIs
// NOT @Transactional around the HTTP call: each step commits on its own
@Component
@RequiredArgsConstructor
public class ExternalCallGuard {

    private final ExternalCallRecordRepository records;
    private final ExternalProcessorClient      client;

    public ProcessorResponse submitOnce(PaymentOrder order, UUID idempotencyKey) {

        // 1. Claim (own short transaction): INSERT ... ON CONFLICT DO NOTHING
        boolean claimed = records.claimPending(idempotencyKey);
        if (!claimed) {
            ExternalCallRecord existing = records.findByIdempotencyKey(idempotencyKey).orElseThrow();
            if (existing.isCompleted()) {
                return existing.response();
            }
            // PENDING: another attempt is in flight or crashed mid-call —
            // the outcome is unknown, so ask the external system first
            throw new OutcomeUnknownException(idempotencyKey);
        }

        // 2. Only the claim winner calls out
        ProcessorResponse response = client.submit(order, idempotencyKey);

        // 3. Record the outcome (own short transaction). If we crash before this,
        //    the record stays PENDING and the reconciliation job queries the
        //    external system to find out what happened.
        records.complete(idempotencyKey, response);
        return response;
    }
}
```

## 8. Testing Idempotency Under Concurrency

```java
// IdempotencyIntegrationTest.java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class IdempotencyIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres =
            new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    static GenericContainer<?> redis =
            new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @Autowired
    private TestRestTemplate http;

    @Autowired
    private PaymentRepository paymentRepository;

    @Test
    void sameIdempotencyKey_concurrentRequests_sideEffectOccursOnce()
            throws InterruptedException {

        UUID idempotencyKey = UUID.randomUUID();
        HttpHeaders headers = new HttpHeaders();
        headers.set("Idempotency-Key", idempotencyKey.toString());
        headers.setContentType(MediaType.APPLICATION_JSON);

        String body = """
                {"amount": 5000, "currency": "GBP",
                 "creditorAccount": "GB29NWBK60161331926819"}
                """;
        HttpEntity<String> entity = new HttpEntity<>(body, headers);

        int concurrency    = 3;
        CountDownLatch latch    = new CountDownLatch(concurrency);
        List<ResponseEntity<String>> responses =
                Collections.synchronizedList(new ArrayList<>());

        ExecutorService pool = Executors.newFixedThreadPool(concurrency);

        for (int i = 0; i < concurrency; i++) {
            pool.submit(() -> {
                try {
                    ResponseEntity<String> r = http.exchange(
                            "/api/v1/payments", HttpMethod.POST,
                            entity, String.class);
                    responses.add(r);
                } finally {
                    latch.countDown();
                }
            });
        }

        latch.await(10, TimeUnit.SECONDS);
        pool.shutdown();

        // Requests that overlapped the first one may get 409 "in progress";
        // every other response must be the ORIGINAL response
        assertThat(responses).hasSize(concurrency);
        List<ResponseEntity<String>> completed = responses.stream()
                .filter(r -> r.getStatusCode() != HttpStatus.CONFLICT).toList();
        assertThat(completed).isNotEmpty();
        String originalBody = completed.get(0).getBody();
        for (ResponseEntity<String> r : completed) {
            assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
            assertThat(r.getBody()).isEqualTo(originalBody);
        }

        // A retry now (after completion) replays the original response
        ResponseEntity<String> retry = http.exchange(
                "/api/v1/payments", HttpMethod.POST, entity, String.class);
        assertThat(retry.getBody()).isEqualTo(originalBody);

        // The payment must have been created exactly once
        long paymentCount = paymentRepository
                .countByIdempotencyKey(idempotencyKey);
        assertThat(paymentCount).isEqualTo(1);
    }
}
```

## Knowledge Check

**Q1: A client sends a `POST /payments` request with `Idempotency-Key: abc-123`. The server processes the payment successfully and stores the result in Redis. Twenty minutes later the client retries with the same key. Redis has been evicted (OOM policy `allkeys-lru`). What happens?**

A: The Redis lookup misses (`null`). The filter proceeds as if it were a new request. The DB-layer guard catches the duplicate via the `UNIQUE (idempotency_key)` constraint and returns the stored response. This is why you need both layers: Redis for speed, the database for durability. If your TTL window is shorter than your SLA for retry eligibility, the database also defends against post-TTL replays.

**Q2: `enable.idempotence=true` is set on your Kafka producer. A network partition causes the producer to restart. After restart, it retries the last batch of messages. Are the duplicates filtered by the broker?**

A: No. `enable.idempotence=true` deduplicates within a single producer session (identified by a Producer ID assigned at startup). After a restart, a non-transactional producer gets a new PID. (A transactional producer that reuses its `transactional.id` keeps its identity, but that still only covers Kafka writes.) The broker has no way to match the new PID against the previous epoch's sequence numbers. Consumer-side deduplication using a `processed_events` table is mandatory to handle cross-session duplicates.

## Practical Challenge

**Objective**: Implement a complete three-layer idempotency stack and validate it with a chaos test.

1. **HTTP layer**: Deploy the `IdempotencyFilter` backed by Redis. Add a metric counter `idempotency.hits` (incremented on cache hit) and `idempotency.misses` (incremented on cache miss) using Micrometer.

2. **Database layer**: Add the `payment_requests` table with the `UNIQUE (idempotency_key)` constraint. Write a `PaymentRequestRepository.upsertRequest` that uses `INSERT … ON CONFLICT DO NOTHING RETURNING` and validates the request hash.

3. **Kafka layer**: Configure the consumer to insert into `processed_events` before processing. Verify via a test that injects a duplicate message after the consumer has committed.

4. **Chaos test**: Write a JUnit 5 test that:
   - Submits the same payment 50 times concurrently using a `CompletableFuture` pool.
   - Asserts that exactly one payment row exists in the database.
   - Asserts that every HTTP response is either the original response or a `409 request_in_progress`, and that retrying the 409s after completion returns the original response.
   - Asserts that `idempotency.misses` equals 1 (only one request ever claims the key).

5. **Stretch goal**: Implement a nightly cleanup job (`@Scheduled(cron = "0 2 * * *")`) that deletes `payment_requests` rows older than 24 hours and purges the corresponding Redis keys.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A client sends a POST /payments with Idempotency-Key: abc-123. The server processes the payment and stores the result in Redis with a 24-hour TTL. Redis later evicts the key under allkeys-lru memory pressure. The client retries 2 hours later with the same key. What prevents a duplicate payment?",
      "options": [
        "The Redis TTL prevents the retry from being processed because the key is gone",
        "The database UNIQUE constraint on idempotency_key catches the duplicate via INSERT ... ON CONFLICT DO NOTHING, returning the stored response",
        "The HTTP filter returns 409 because Redis returns null",
        "The retry is rejected because the same client IP already made this request"
      ],
      "correct": 1,
      "explanation": "Redis eviction causes a cache miss in the HTTP filter, which proceeds as if it were a new request. The database layer is the durable backstop: the UNIQUE(idempotency_key) constraint on payment_requests catches the duplicate. The INSERT returns no rows (conflict), triggering the duplicate path that returns the stored response. This is why both layers are required: Redis for speed, database for durability across evictions and restarts."
    },
    {
      "text": "enable.idempotence=true is configured on the Kafka producer. The producer restarts due to a pod failure and retries its last batch. Are the retried messages filtered by the broker as duplicates?",
      "options": [
        "Yes — enable.idempotence=true deduplicates all retries across producer sessions using a persistent producer ID stored in Kafka",
        "No — enable.idempotence=true only deduplicates within a single producer epoch; a restart assigns a new PID and the broker cannot match cross-session sequence numbers",
        "Yes — Kafka's exactly-once semantics guarantee deduplication even across restarts",
        "No — deduplication is only possible with acks=0 configured"
      ],
      "correct": 1,
      "explanation": "enable.idempotence=true assigns a Producer ID (PID) at startup and uses per-partition sequence numbers for deduplication within that session. After a restart, a non-transactional producer gets a new PID — the broker cannot correlate its sequences with the previous session. Consumer-side deduplication using a processed_events table is mandatory to handle cross-session duplicates."
    },
    {
      "text": "A payment service claims idempotency keys with Redis SET NX. The Redis primary acknowledges SET idmp:abc PROCESSING NX, then crashes before replicating the write, and a replica is promoted. What is the risk and what is the most durable mitigation?",
      "options": [
        "A retry's SET NX can succeed on the new primary, allowing two executions of the same payment — mitigated by keeping the database UNIQUE constraint as the final arbiter of idempotency",
        "Both requests receive an error because NX operations are blocked during failover",
        "The key is replicated synchronously, so there is no risk",
        "Only one request can succeed because Redis Cluster guarantees atomic NX across all nodes"
      ],
      "correct": 0,
      "explanation": "Redis replicates asynchronously. A write acknowledged by the old primary but not yet replicated is lost when a replica is promoted, so a retry's SET NX succeeds again and a second execution can start. The database UNIQUE(idempotency_key) constraint is the durable mitigation: even if two requests pass the Redis layer, only one INSERT succeeds."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement and Chaos-Test a Three-Layer Idempotency Stack",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Deploy the IdempotencyFilter backed by Redis with SET NX. Instrument it with two Micrometer counters: idempotency.hits (incremented when a cached response is replayed) and idempotency.misses (incremented when the key is claimed fresh). Add a third counter idempotency.in_progress_conflicts for 409 responses when PROCESSING sentinel is encountered."
    },
    {
      "id": "2",
      "description": "Add the payment_requests table with UNIQUE(idempotency_key) and a request_hash CHAR(64) column. Implement PaymentRequestRepository.upsertRequest using INSERT ... ON CONFLICT DO NOTHING RETURNING id. Add body-mismatch detection: if the conflicting row has a different request_hash, throw IdempotencyConflictException with a 422 status."
    },
    {
      "id": "3",
      "description": "Configure the Kafka consumer to INSERT into processed_events before processing each message, using ON CONFLICT (event_id) DO NOTHING. Write an integration test that publishes a payment-commands message, manually re-publishes the same event_id, and asserts that the payment is processed exactly once and processed_events contains exactly one row for that event_id."
    },
    {
      "id": "4",
      "description": "Write a JUnit 5 chaos test that submits the same payment 50 times concurrently using CompletableFuture.allOf with a fixed thread pool of 50. Assert: exactly one payment row in the database; every HTTP response is either the original response or a 409 request_in_progress; retrying after completion returns the original response; idempotency.misses equals 1. Then evict the Redis key after the first request and verify the database layer still prevents any second payment."
    }
  ]
}
-->
