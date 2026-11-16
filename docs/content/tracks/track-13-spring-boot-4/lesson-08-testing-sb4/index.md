---
id: "track-13-lesson-08"
title: "Spring Boot 4 Testing — Slices, Testcontainers, and Observability"
track: "track-13"
trackName: "Spring Boot 4 for Senior Fintech Engineers"
sequence: 8
slug: "testing"
difficulty: "advanced"
estimatedMinutes: 70
status: "published"
lastUpdated: "2026-11-12"

prerequisites:
  - "track-13-lesson-01"

tags:
  - "testing"
  - "spring-boot-4"
  - "testcontainers"
  - "slices"
  - "mockito-5"
  - "wiremock"
  - "observability-testing"

topics:
  - "@MockitoBean and @MockitoSpyBean"
  - "Test slices — WebMvcTest, DataJpaTest, DataRedisTest"
  - "Testcontainers 1.20 with @ServiceConnection"
  - "WireMock 3.x for external payment rail APIs"
  - "Observability testing with TestObservationRegistry"
  - "Test performance — avoiding @DirtiesContext"

components:
  mermaid: true
  prism: true
  katex: false
  knowledge-check: true
  practical-challenge: true

references:
  - "Spring Framework 7.0 — MockitoBean and MockitoSpyBean"
  - "Testcontainers 1.20 Release Notes"
  - "WireMock 3.x Spring Boot Integration"
  - "Micrometer TestObservationRegistry"
  - "Spring Boot 4.0 Test Auto-Configuration"
---

# Spring Boot 4 Testing — Slices, Testcontainers, and Observability

Effective testing is the difference between a service you can refactor confidently and one you are afraid to touch. Spring Boot 4 ships with a testing story that is meaningfully better than SB3: `@MockitoBean` replaces the Boot-specific `@MockBean`, `@ServiceConnection` eliminates manual container property wiring, and `TestObservationRegistry` lets you assert on observability signals. This lesson covers everything needed to write a production-quality test suite for a fintech payment service.

---

## 1. `@MockitoBean` and `@MockitoSpyBean`

Spring Framework 7 introduces `@MockitoBean` and `@MockitoSpyBean` as first-class Spring annotations in `spring-test`. They are functionally equivalent to `@MockBean` / `@SpyBean` from `spring-boot-test`, which are **removed** in Spring Boot 4.

**Key differences to understand:**

| Feature | `@MockBean` (SB3, removed) | `@MockitoBean` (SB4) |
|---|---|---|
| Module | `spring-boot-test` | `spring-test` (Spring Framework 7) |
| Works in `@SpringBootTest` | Yes | Yes |
| Works in `@WebMvcTest` | Yes | Yes |
| Works outside SB (plain `@SpringJUnitConfig`) | No | Yes |
| Resets mock between tests | Yes (by default) | Yes (by default) |

**Payment service test with `@MockitoBean`:**

```java
@WebMvcTest(PaymentController.class)
@Import(PaymentApiSecurityConfig.class)
class PaymentAuthorizationTest {

    @Autowired
    MockMvc mockMvc;

    @MockitoBean
    PaymentService paymentService;

    @MockitoBean
    FraudService fraudService;

    @Test
    @WithMockUser(username = "user-7f3a", roles = "PAYMENT_INITIATOR",
                  authorities = "SCOPE_payment:initiate")
    void authorizedPayment_returns201() throws Exception {
        var result = new PaymentResult("pay-123", "PENDING");
        given(paymentService.initiatePayment(any(), any(), any())).willReturn(result);

        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("""
                    {"accountId":"acc-001","amount":250.00,"currency":"GBP"}
                    """))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.paymentId").value("pay-123"))
            .andExpect(jsonPath("$.status").value("PENDING"));

        verify(paymentService).initiatePayment("acc-001", new BigDecimal("250.00"), "GBP");
    }

    @Test
    void unauthenticatedRequest_returns401() throws Exception {
        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("{}"))
            .andExpect(status().isUnauthorized());

        verifyNoInteractions(paymentService);
    }

    @Test
    @WithMockUser(roles = "VIEWER")
    void insufficientAuthority_returns403() throws Exception {
        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("{}"))
            .andExpect(status().isForbidden());

        verifyNoInteractions(paymentService);
    }
}
```

**`@MockitoSpyBean`** wraps a real bean with a Mockito spy — useful when you need most of the real behaviour but want to verify or partially stub:

```java
@SpringBootTest
class AuditServiceTest {

    @MockitoSpyBean       // real AuditService bean, wrapped in a Mockito spy
    AuditService auditService;

    @Test
    void paymentCreation_triggersAuditLog() {
        // Real method is called, but we can verify interactions
        verify(auditService, timeout(1000)).logPaymentCreated(any());
    }
}
```

---

## 2. Test Slices in Spring Boot 4

Test slices load a focused subset of the application context. They are substantially faster than `@SpringBootTest` because they skip infrastructure that is irrelevant to the test.

### Slice Overview

| Slice | What it loads | What it excludes |
|---|---|---|
| `@WebMvcTest` | Controllers, `SecurityFilterChain`, `HandlerMethodArgumentResolver`, `Filter` | Services, repositories, Kafka, Redis |
| `@DataJpaTest` | JPA entities, repositories, Flyway/Liquibase, `DataSource` | Web layer, Security, Kafka, Redis |
| `@DataJdbcTest` | Spring Data JDBC repositories, `JdbcTemplate` | JPA, Web, Security, Kafka |
| `@DataRedisTest` | Spring Data Redis repositories, `RedisTemplate` | Web, Security, JPA, Kafka |
| `@JsonTest` | Jackson `ObjectMapper`, `JsonComponent` beans | Everything else |

### `@DataJpaTest` with Testcontainers PostgreSQL

By default, `@DataJpaTest` replaces the configured `DataSource` with an in-memory H2 database. For fintech services, this is dangerous — PostgreSQL-specific query behaviour, JSON operators, and custom types behave differently in H2. Use `@AutoConfigureTestDatabase(replace = NONE)` with a Testcontainers container.

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers
class PaymentRepositoryTest {

    @Container
    @ServiceConnection                          // SB4: auto-wires DataSource properties
    static PostgreSQLContainer<?> postgres =
        new PostgreSQLContainer<>("postgres:16-alpine")
            .withInitScript("schema.sql");

    @Autowired
    PaymentRepository paymentRepository;

    @Autowired
    TestEntityManager entityManager;

    @Test
    void findPendingPaymentsForAccount_returnsOnlyPending() {
        var account = "acc-001";
        entityManager.persist(Payment.pending(account, new BigDecimal("100.00"), "GBP"));
        entityManager.persist(Payment.settled(account, new BigDecimal("200.00"), "GBP"));
        entityManager.flush();

        var pending = paymentRepository.findByAccountIdAndStatus(account, PaymentStatus.PENDING);

        assertThat(pending).hasSize(1);
        assertThat(pending.get(0).getAmount()).isEqualByComparingTo("100.00");
    }

    @Test
    void paymentAmountSum_usesPostgresNumericPrecision() {
        // This test would silently pass with wrong precision on H2
        entityManager.persist(Payment.pending("acc-002", new BigDecimal("0.01"), "GBP"));
        entityManager.persist(Payment.pending("acc-002", new BigDecimal("0.01"), "GBP"));
        entityManager.flush();

        BigDecimal total = paymentRepository.sumAmountByAccount("acc-002");
        assertThat(total).isEqualByComparingTo("0.02");   // exact decimal, not floating point
    }
}
```

---

## 3. Testcontainers 1.20 + `@ServiceConnection`

`@ServiceConnection` (introduced in SB3.1, fully mature in SB4) auto-wires connection details from a Testcontainers container into Spring's auto-configuration — eliminating all manual `@DynamicPropertySource` overrides.

### How it works

When Spring Boot sees a `@ServiceConnection`-annotated `@Container` field, it uses the container's `ConnectionDetails` implementation to populate the same properties that would be set by `application.yml`. No `@DynamicPropertySource` needed.

### PostgreSQL + Redis + Kafka setup

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class PaymentServiceIntegrationTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres =
        new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    @ServiceConnection
    static RedisContainer redis =
        new RedisContainer(DockerImageName.parse("redis:7-alpine"));

    @Container
    @ServiceConnection
    static KafkaContainer kafka =
        new KafkaContainer(DockerImageName.parse("confluentinc/cp-kafka:7.6.0"))
            .withKraft();                    // KRaft mode — no ZooKeeper container

    @Autowired
    PaymentCommandHandler commandHandler;

    @Autowired
    PaymentRepository paymentRepository;

    @Test
    void createPayment_persistsAndPublishesEvent() throws Exception {
        var cmd = new CreatePaymentCommand("acc-001", new BigDecimal("150.00"), "GBP");

        PaymentResult result = commandHandler.handleCreatePayment(cmd);

        assertThat(result.paymentId()).isNotBlank();
        assertThat(paymentRepository.findById(result.paymentId())).isPresent();
        // Event publication verified separately via EmbeddedKafka or Kafka consumer
    }
}
```

**What `@ServiceConnection` configures automatically:**

- `PostgreSQLContainer` → `spring.datasource.url`, `username`, `password`, `driver-class-name`
- `RedisContainer` → `spring.data.redis.host`, `port`
- `KafkaContainer` → `spring.kafka.bootstrap-servers`

No `@DynamicPropertySource` callback. No `@TestPropertySource` with hardcoded ports. The container starts, registers its `ConnectionDetails`, and Spring wires it up.

---

## 4. WireMock 3.x for External Payment Rail APIs

Payment services call external rails: FPS (Faster Payments Service), SWIFT, card networks. These cannot be called in tests. WireMock 3.x with the Spring Boot integration provides `@WireMockTest` for clean stub-per-test isolation.

```java
@WireMockTest
class FpsClientTest {

    @Autowired
    FpsClient fpsClient;

    @Test
    void submitPayment_successResponse_returnsFpsReference(WireMockRuntimeInfo wm) {
        stubFor(post(urlEqualTo("/payments"))
            .withRequestBody(matchingJsonPath("$.amount", equalTo("100.00")))
            .willReturn(aResponse()
                .withStatus(201)
                .withHeader("Content-Type", "application/json")
                .withBody("""
                    {
                        "fpsReference": "FPS-2024-001",
                        "status": "ACCEPTED",
                        "timestamp": "2024-11-13T12:00:00Z"
                    }
                    """)));

        var request = new FpsPaymentRequest("acc-001", new BigDecimal("100.00"), "GBP");
        var response = fpsClient.submit(request);

        assertThat(response.fpsReference()).isEqualTo("FPS-2024-001");
        assertThat(response.status()).isEqualTo("ACCEPTED");

        verify(postRequestedFor(urlEqualTo("/payments"))
            .withRequestBody(matchingJsonPath("$.currency", equalTo("GBP"))));
    }

    @Test
    void submitPayment_fps503_throwsFpsUnavailableException(WireMockRuntimeInfo wm) {
        stubFor(post(urlEqualTo("/payments"))
            .willReturn(aResponse()
                .withStatus(503)
                .withBody("{\"error\":\"Service temporarily unavailable\"}")));

        var request = new FpsPaymentRequest("acc-001", new BigDecimal("50.00"), "GBP");

        assertThatThrownBy(() -> fpsClient.submit(request))
            .isInstanceOf(FpsUnavailableException.class)
            .hasMessageContaining("503");
    }

    @Test
    void submitPayment_networkTimeout_throwsRetryableException(WireMockRuntimeInfo wm) {
        stubFor(post(urlEqualTo("/payments"))
            .willReturn(aResponse()
                .withFixedDelay(10_000)   // 10s delay > client timeout
                .withStatus(200)));

        var request = new FpsPaymentRequest("acc-001", new BigDecimal("75.00"), "GBP");

        assertThatThrownBy(() -> fpsClient.submit(request))
            .isInstanceOf(RetryablePaymentException.class);
    }
}
```

**WireMock configuration for the `FpsClient` bean:**

```java
@TestConfiguration
public class WireMockFpsConfig {

    @Bean
    FpsClient fpsClient(WireMockRuntimeInfo wm) {
        return new FpsClient(RestClient.builder()
            .baseUrl(wm.getHttpBaseUrl())
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .build());
    }
}
```

---

## 5. Observability Testing with `TestObservationRegistry`

Spring Boot 4 ships `ObservabilityTestAutoConfiguration` which replaces the production `ObservationRegistry` with a `TestObservationRegistry` in `@SpringBootTest` contexts. This lets you assert that operations emit the correct metrics and traces.

```java
@SpringBootTest
class PaymentObservabilityTest {

    @Autowired
    PaymentService paymentService;

    @Autowired
    TestObservationRegistry observationRegistry;

    @Test
    void paymentInitiation_emitsObservation() {
        observationRegistry.clear();

        paymentService.initiatePayment("acc-001", new BigDecimal("100.00"), "GBP");

        assertThat(observationRegistry)
            .hasObservationWithNameEqualTo("payment.initiate")
            .that()
            .hasLowCardinalityKeyValue("currency", "GBP")
            .hasLowCardinalityKeyValue("payment.type", "domestic")
            .doesNotHaveError();
    }

    @Test
    void fraudScreening_failure_emitsObservationWithError() {
        observationRegistry.clear();

        // Assuming FraudService is real and configured to reject this amount
        assertThatThrownBy(() ->
            paymentService.initiatePayment("acc-fraud", new BigDecimal("1000000.00"), "GBP"))
            .isInstanceOf(FraudDetectedException.class);

        assertThat(observationRegistry)
            .hasObservationWithNameEqualTo("payment.initiate")
            .that()
            .hasError()
            .hasHighCardinalityKeyValue("exception", "FraudDetectedException");
    }
}
```

Your `PaymentService` must use `@Observed` or manually create observations:

```java
@Service
@Observed(name = "payment.initiate",
           contextualName = "payment-initiation",
           lowCardinalityKeyValues = {"service", "payment"})
@RequiredArgsConstructor
public class PaymentService {

    private final ObservationRegistry observationRegistry;
    private final PaymentRepository paymentRepository;

    public PaymentResult initiatePayment(String accountId, BigDecimal amount, String currency) {
        return Observation.createNotStarted("payment.initiate", observationRegistry)
            .lowCardinalityKeyValue("currency", currency)
            .lowCardinalityKeyValue("payment.type", isInternational(currency) ? "international" : "domestic")
            .observe(() -> {
                Payment payment = paymentRepository.save(
                    Payment.pending(accountId, amount, currency));
                return PaymentResult.of(payment);
            });
    }
}
```

---

## 6. Test Slice Architecture Diagram

```mermaid
graph TD
    subgraph Full["@SpringBootTest (full context)"]
        A[Web Layer] --> B[Service Layer]
        B --> C[Data Layer]
        B --> D[Kafka]
        B --> E[Redis]
        B --> F[External APIs]
    end

    subgraph WebSlice["@WebMvcTest (web slice)"]
        G[Controller] --> H[@MockitoBean Service]
        G --> I[SecurityFilterChain]
    end

    subgraph DataSlice["@DataJpaTest (data slice)"]
        J[Repository] --> K[Testcontainers PostgreSQL\n@ServiceConnection]
        L[TestEntityManager]
    end

    subgraph KafkaTest["@EmbeddedKafka (messaging)"]
        M[KafkaTemplate] --> N[EmbeddedKafkaBroker\nKRaft mode]
        O[@KafkaListener] --> N
        P[@MockitoBean Service]
    end

    subgraph WireMockTest["@WireMockTest (integration)"]
        Q[RestClient] --> R[WireMock Server]
    end
```

The key insight: each slice should cover exactly one architectural concern. `@WebMvcTest` tests authorization and request/response mapping; `@DataJpaTest` tests query correctness; `@EmbeddedKafka` tests event flow; `@WireMockTest` tests HTTP client behaviour. Reserve `@SpringBootTest` for a small number of end-to-end smoke tests.

---

## 7. Test Performance — Avoiding `@DirtiesContext`

### The `@DirtiesContext` Anti-Pattern for Kafka Tests

`@DirtiesContext` forces Spring to destroy and rebuild the `ApplicationContext` after the annotated test class. For Kafka tests this is tempting — consumer group offsets can pollute later tests. The cost is a full context restart: in a large service, 30-60 seconds per occurrence.

**Better approach: consumer group isolation per test class**

```java
// BAD — forces context rebuild
@SpringBootTest
@EmbeddedKafka(topics = "payment-events")
@DirtiesContext(classMode = AFTER_CLASS)   // destroys context, 30s+ overhead
class PaymentConsumerTest { }

// GOOD — unique group ID per test class
@SpringBootTest
@EmbeddedKafka(topics = "payment-events")
@TestPropertySource(properties = {
    "spring.kafka.consumer.group-id=test-${random.uuid}"  // unique per JVM run
})
class PaymentConsumerTest { }
```

With a unique `group-id`, each test class starts reading from the earliest offset in its own consumer group, eliminating cross-test state pollution without destroying the context.

### Context Caching

Spring caches `ApplicationContext` instances between tests with the same configuration. `@MockitoBean` invalidates the cache for the declaring test class (the same behaviour as `@MockBean` in SB3). To maximise cache reuse:

1. Group tests with the same `@MockitoBean` set into the same test class.
2. Put `@MockitoBean` on the class, not individual test methods.
3. Avoid `@DirtiesContext` unless you mutate static state (e.g. thread-local `SecurityContextHolder`).

### `@TestMethodOrder` for Stateful Tests

When test method order matters (e.g. a create → read → delete sequence in a `@DataJpaTest`), use:

```java
@DataJpaTest
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class PaymentLifecycleTest {

    @Autowired
    PaymentRepository repository;

    private static String createdPaymentId;

    @Test
    @Order(1)
    void createPayment() {
        var payment = repository.save(Payment.pending("acc-001", new BigDecimal("100.00"), "GBP"));
        createdPaymentId = payment.getId();
        assertThat(createdPaymentId).isNotBlank();
    }

    @Test
    @Order(2)
    void settlePayment() {
        var payment = repository.findById(createdPaymentId).orElseThrow();
        payment.settle("FPS-REF-001");
        repository.save(payment);
        assertThat(repository.findById(createdPaymentId).orElseThrow().getStatus())
            .isEqualTo(PaymentStatus.SETTLED);
    }
}
```

Prefer this pattern over `@BeforeEach` setup for lifecycle tests — it makes the test narrative explicit and avoids hidden setup state.

---

## 8. Complete `@WebMvcTest` for Payment Authorization

This is a production-ready test covering the full security + request lifecycle for a payment authorization endpoint:

```java
@WebMvcTest(PaymentController.class)
@Import({PaymentApiSecurityConfig.class, JwtConverterConfig.class})
class PaymentControllerSecurityTest {

    @Autowired
    MockMvc mockMvc;

    @MockitoBean
    PaymentService paymentService;

    @MockitoBean
    JwtClaimsExtractor jwtClaimsExtractor;

    // ---- Happy path ----

    @Test
    @WithMockUser(username = "user-abc", roles = "PAYMENT_INITIATOR",
                  authorities = "SCOPE_payment:initiate")
    void initiatePayment_authorizedUser_returns201WithPaymentId() throws Exception {
        given(paymentService.initiatePayment("acc-001", new BigDecimal("150.00"), "GBP"))
            .willReturn(new PaymentResult("pay-999", "PENDING"));

        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("""
                    {"accountId":"acc-001","amount":150.00,"currency":"GBP"}
                    """))
            .andExpect(status().isCreated())
            .andExpect(header().exists("Location"))
            .andExpect(jsonPath("$.paymentId").value("pay-999"))
            .andExpect(jsonPath("$.status").value("PENDING"));
    }

    // ---- JWT-based auth (non-@WithMockUser) ----

    @Test
    void initiatePayment_withJwtBearer_extractsClaimsCorrectly() throws Exception {
        given(jwtClaimsExtractor.getPaymentLimit(any())).willReturn(new BigDecimal("50000"));
        given(paymentService.initiatePayment(any(), any(), any()))
            .willReturn(new PaymentResult("pay-888", "PENDING"));

        mockMvc.perform(post("/api/v1/payments")
                .with(jwt()
                    .jwt(j -> j
                        .subject("user-jwt-001")
                        .claim("financial_roles", List.of("PAYMENT_INITIATOR"))
                        .claim("payment_limit", 50000)
                        .claim("scope", "payment:initiate account:read")))
                .contentType(APPLICATION_JSON)
                .content("""
                    {"accountId":"acc-002","amount":200.00,"currency":"EUR"}
                    """))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.paymentId").value("pay-888"));
    }

    // ---- Security rejection scenarios ----

    @Test
    void initiatePayment_noAuth_returns401() throws Exception {
        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("""{"accountId":"acc-001","amount":100.00,"currency":"GBP"}"""))
            .andExpect(status().isUnauthorized());

        verifyNoInteractions(paymentService);
    }

    @Test
    @WithMockUser(roles = "VIEWER")
    void initiatePayment_missingScope_returns403() throws Exception {
        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("""{"accountId":"acc-001","amount":100.00,"currency":"GBP"}"""))
            .andExpect(status().isForbidden());

        verifyNoInteractions(paymentService);
    }

    // ---- Input validation ----

    @Test
    @WithMockUser(roles = "PAYMENT_INITIATOR", authorities = "SCOPE_payment:initiate")
    void initiatePayment_negativeAmount_returns400() throws Exception {
        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("""{"accountId":"acc-001","amount":-50.00,"currency":"GBP"}"""))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("VALIDATION_ERROR"));

        verifyNoInteractions(paymentService);
    }

    @Test
    @WithMockUser(roles = "PAYMENT_INITIATOR", authorities = "SCOPE_payment:initiate")
    void initiatePayment_serviceThrowsInsufficientFunds_returns422() throws Exception {
        given(paymentService.initiatePayment(any(), any(), any()))
            .willThrow(new InsufficientFundsException("acc-001"));

        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("""{"accountId":"acc-001","amount":999999.00,"currency":"GBP"}"""))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.error").value("INSUFFICIENT_FUNDS"));
    }
}
```

---

## Summary

- **`@MockitoBean` / `@MockitoSpyBean`** replace `@MockBean` / `@SpyBean` from `spring-boot-test`. They are Spring Framework 7 annotations that work in any `@SpringJUnitConfig` context, not just Spring Boot tests.
- **Test slices** (`@WebMvcTest`, `@DataJpaTest`, `@DataRedisTest`) load a focused context — always prefer slices over `@SpringBootTest` for unit-style tests. Use `@AutoConfigureTestDatabase(replace = NONE)` with Testcontainers for realistic JPA behaviour.
- **`@ServiceConnection`** eliminates `@DynamicPropertySource` for Testcontainers containers — annotate `@Container` with `@ServiceConnection` and Spring auto-wires the connection details.
- **WireMock 3.x** with `@WireMockTest` provides per-test stub isolation for external payment rail APIs. Test timeout, 5xx, and network failure scenarios — not just happy paths.
- **`TestObservationRegistry`** lets you assert on metric names, low-cardinality tags, and error state from `@Observed` methods. Use it to enforce observability contracts in CI.
- **Avoid `@DirtiesContext` for Kafka tests** — use unique `group-id` values per test class instead. This avoids expensive context rebuilds while maintaining state isolation.

---

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-08-01",
    "question": "In Spring Boot 4, which annotation replaces @MockBean from spring-boot-test when you need to register a Mockito mock in the Spring ApplicationContext for a @WebMvcTest?",
    "options": [
      "@Mock (Mockito)",
      "@MockitoBean (Spring Framework 7 / spring-test)",
      "@TestBean (Spring Boot 4)",
      "@InjectMocks (Mockito)"
    ],
    "correct": 1,
    "explanation": "@MockitoBean is a Spring Framework 7 annotation in the spring-test module that registers a Mockito mock in the ApplicationContext for the duration of the test. @Mock creates a bare Mockito mock with no Spring context integration. @MockBean from spring-boot-test is removed in Spring Boot 4."
  },
  {
    "id": "kc-08-02",
    "question": "You are writing a @DataJpaTest for a PaymentRepository that uses PostgreSQL-specific JSON operators. Which combination correctly configures the test to use a real PostgreSQL database via Testcontainers?",
    "options": [
      "@DataJpaTest + @AutoConfigureTestDatabase(replace = ANY) + @Container PostgreSQLContainer",
      "@DataJpaTest + @AutoConfigureTestDatabase(replace = NONE) + @Container @ServiceConnection PostgreSQLContainer",
      "@SpringBootTest + @Container PostgreSQLContainer without @ServiceConnection",
      "@DataJpaTest + @DynamicPropertySource to override spring.datasource.url"
    ],
    "correct": 1,
    "explanation": "@AutoConfigureTestDatabase(replace = NONE) prevents Spring from replacing the DataSource with H2. @ServiceConnection on the @Container field auto-wires the PostgreSQLContainer's connection details (URL, username, password) into Spring's DataSource auto-configuration — no @DynamicPropertySource needed."
  },
  {
    "id": "kc-08-03",
    "question": "A team has 50 @SpringBootTest classes that each use @DirtiesContext(classMode = AFTER_CLASS) to reset Kafka consumer group state between test classes. What is the most effective way to eliminate this overhead?",
    "options": [
      "Use @TestMethodOrder(MethodOrderer.Random.class) to randomize test execution",
      "Replace @SpringBootTest with @WebMvcTest for all Kafka tests",
      "Set spring.kafka.consumer.group-id to a unique value per test class using @TestPropertySource(properties = {\"spring.kafka.consumer.group-id=test-${random.uuid}\"})",
      "Add @Transactional to each test method to roll back Kafka state"
    ],
    "correct": 2,
    "explanation": "Each test class reads from its own unique consumer group, so offset state from previous classes does not affect it. This avoids context destruction and recreation (30-60s overhead each) while maintaining complete state isolation. Kafka is not transactional so @Transactional has no effect on consumer offsets."
  },
  {
    "id": "kc-08-04",
    "question": "To verify that PaymentService.initiatePayment() emits a Micrometer observation named 'payment.initiate' with a low-cardinality key 'currency' in a @SpringBootTest, which assertion API should you use?",
    "options": [
      "Mockito.verify(meterRegistry).counter(\"payment.initiate\", \"currency\", \"GBP\")",
      "assertThat(observationRegistry).hasObservationWithNameEqualTo(\"payment.initiate\").that().hasLowCardinalityKeyValue(\"currency\", \"GBP\")",
      "assertThat(prometheusRegistry.get(\"payment.initiate\").counter().count()).isEqualTo(1)",
      "verify(tracer).startScopedSpan(\"payment.initiate\")"
    ],
    "correct": 1,
    "explanation": "TestObservationRegistry (auto-configured in @SpringBootTest via ObservabilityTestAutoConfiguration in SB4) exposes AssertJ-based assertions through ObservationRegistryAssert. hasObservationWithNameEqualTo() finds the observation by name, and that().hasLowCardinalityKeyValue() asserts on the tags without coupling to specific metric implementations."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-08",
  "title": "Build a Complete Test Suite for a Payment Authorization Service",
  "description": "Implement a layered test suite covering web security, data access, external API mocking, and observability verification for a fintech payment service.",
  "tasks": [
    {
      "id": "pc-08-01",
      "description": "Write a @WebMvcTest class PaymentControllerSecurityTest for PaymentController covering five scenarios: (1) unauthenticated POST returns 401 with no PaymentService interaction, (2) @WithMockUser with ROLE_VIEWER returns 403, (3) @WithMockUser with ROLE_PAYMENT_INITIATOR and SCOPE_payment:initiate returns 201 with paymentId in response body, (4) JWT bearer token injected via SecurityMockMvcRequestPostProcessors.jwt() with financial_roles=[\"PAYMENT_INITIATOR\"] returns 201, (5) service throws InsufficientFundsException returns 422. Use @MockitoBean for PaymentService."
    },
    {
      "id": "pc-08-02",
      "description": "Write a @DataJpaTest class PaymentRepositoryTest with @AutoConfigureTestDatabase(replace = NONE) using a @Container @ServiceConnection PostgreSQLContainer<?>. Implement two tests: one verifying findByAccountIdAndStatus() returns only PENDING payments (persist one PENDING and one SETTLED via TestEntityManager), and one verifying that sumAmountByAccount() returns the exact BigDecimal sum of 0.01 + 0.01 = 0.02 (testing PostgreSQL numeric precision)."
    },
    {
      "id": "pc-08-03",
      "description": "Write a @WireMockTest class FpsClientTest with three test methods: (1) stub POST /payments returning 201 with fpsReference=FPS-2024-001 and assert FpsClient.submit() returns that reference, (2) stub returning 503 and assert FpsUnavailableException is thrown, (3) stub with withFixedDelay(10000) and assert RetryablePaymentException is thrown due to timeout. Use WireMockRuntimeInfo to get the base URL and configure FpsClient via a @TestConfiguration class."
    },
    {
      "id": "pc-08-04",
      "description": "Write a @SpringBootTest class PaymentObservabilityTest that autowires TestObservationRegistry. Test that PaymentService.initiatePayment() with a valid payment emits an observation named 'payment.initiate' with low-cardinality key 'currency' set to 'GBP' and no error. Add a second test verifying that when the service throws FraudDetectedException, the same observation has an error and a high-cardinality key 'exception' set to 'FraudDetectedException'."
    }
  ]
}
-->
