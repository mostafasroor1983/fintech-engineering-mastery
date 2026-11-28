---
id: "track-13-lesson-08"
title: "الاختبار في Spring Boot 4 — اختبارات الشرائح وTestcontainers"
track: "track-13"
trackName: "Spring Boot 4 لمهندسي التقنية المالية"
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

# الاختبار في Spring Boot 4 — الشرائح، وTestcontainers، وقابلية المراقبة

الاختبار الفعال هو الفرق بين خدمة تستطيع إعادة هيكلتها بثقة وأخرى تخشى لمسها. ويرسّخ Spring Boot 4 منظومة اختبار نضجت عبر خط 3.x: يحل `@MockitoBean` محل `@MockBean` الخاص بـ Boot، ويزيل `@ServiceConnection` الربط اليدوي لخصائص الحاويات، ويتيح لك `TestObservationRegistry` من Micrometer التحقق من إشارات قابلية المراقبة. ويغطي هذا الدرس كل ما يلزم لكتابة مجموعة اختبارات بجودة الإنتاج لخدمة دفع في التقنية المالية.

---

## 1. ‏`@MockitoBean` و`@MockitoSpyBean`

قدّم Spring Framework 6.2 ‏`@MockitoBean` و`@MockitoSpyBean` كتعليقات Spring أصيلة في `spring-test`. وهي مكافئة وظيفيًا لـ `@MockBean` / `@SpyBean` من `spring-boot-test`، اللذين **أُزيلا** في Spring Boot 4.

**فروق أساسية يجب فهمها:**

| الميزة | ‏`@MockBean` ‏(SB3، مُزال) | ‏`@MockitoBean` ‏(SB4) |
|---|---|---|
| الوحدة | ‏`spring-boot-test` | ‏`spring-test` ‏(Spring Framework 6.2+) |
| يعمل في `@SpringBootTest` | نعم | نعم |
| يعمل في `@WebMvcTest` | نعم | نعم |
| يعمل خارج SB ‏(`@SpringJUnitConfig` العادي) | لا | نعم |
| يعيد ضبط المحاكاة بين الاختبارات | نعم (افتراضيًا) | نعم (افتراضيًا) |
| مسموح في أصناف `@Configuration` / `@TestConfiguration` | نعم | لا — صرّح به على حقول صنف الاختبار |

**اختبار خدمة دفع مع `@MockitoBean`:**

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
    // roles and authorities cannot be combined in @WithMockUser — use authorities only
    @WithMockUser(username = "user-7f3a",
                  authorities = { "ROLE_PAYMENT_INITIATOR", "SCOPE_payment:initiate" })
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

**‏`@MockitoSpyBean`** يغلّف bean حقيقيًا بجاسوس Mockito — مفيد حين تحتاج معظم السلوك الحقيقي لكن تريد التحقق أو التجهيز الجزئي:

```java
@SpringBootTest
class AuditServiceTest {

    @MockitoSpyBean       // real AuditService bean, wrapped in a Mockito spy
    AuditService auditService;

    @Autowired
    PaymentService paymentService;

    @Test
    void paymentCreation_triggersAuditLog() {
        paymentService.initiatePayment("acc-001", new BigDecimal("100.00"), "GBP");

        // The real audit method ran, and we can still verify the interaction
        // (timeout: the audit log is written asynchronously)
        verify(auditService, timeout(1000)).logPaymentCreated(any());
    }
}
```

---

## 2. شرائح الاختبار في Spring Boot 4

تحمّل شرائح الاختبار مجموعة فرعية مركّزة من سياق التطبيق. وهي أسرع بكثير من `@SpringBootTest` لأنها تتخطى البنية التحتية غير ذات الصلة بالاختبار.

### نظرة عامة على الشرائح

| الشريحة | ما تحمّله | ما تستبعده |
|---|---|---|
| ‏`@WebMvcTest` | المتحكمات، و`SecurityFilterChain`، و`HandlerMethodArgumentResolver`، و`Filter` | الخدمات، والمستودعات، وKafka، وRedis |
| ‏`@DataJpaTest` | كيانات JPA، والمستودعات، وFlyway/Liquibase، و`DataSource` | طبقة الويب، والأمان، وKafka، وRedis |
| ‏`@DataJdbcTest` | مستودعات Spring Data JDBC، و`JdbcTemplate` | JPA، والويب، والأمان، وKafka |
| ‏`@DataRedisTest` | مستودعات Spring Data Redis، و`RedisTemplate` | الويب، والأمان، وJPA، وKafka |
| ‏`@JsonTest` | ‏`ObjectMapper` في Jackson، وbeans ‏`JsonComponent` | كل ما عدا ذلك |

### ‏`@DataJpaTest` مع PostgreSQL من Testcontainers

افتراضيًا، يستبدل `@DataJpaTest` الـ `DataSource` المضبوط بقاعدة بيانات H2 في الذاكرة. ولخدمات التقنية المالية، هذا خطير — فسلوك الاستعلامات الخاص بـ PostgreSQL، ومعاملات JSON، والأنواع المخصصة تتصرف بشكل مختلف في H2. فاستخدم `@AutoConfigureTestDatabase(replace = NONE)` مع حاوية Testcontainers.

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

## 3. ‏Testcontainers + ‏`@ServiceConnection`

يربط `@ServiceConnection` ‏(المقدم في SB3.1، والناضج تمامًا في SB4) تفاصيل الاتصال من حاوية Testcontainers تلقائيًا في الإعداد التلقائي لـ Spring — فيزيل كل تجاوزات `@DynamicPropertySource` اليدوية.

### كيف يعمل

حين يرى Spring Boot حقل `@Container` معلّمًا بـ `@ServiceConnection`، يستخدم تنفيذ `ConnectionDetails` الخاص بالحاوية لتعبئة الخصائص نفسها التي يضبطها `application.yml`. ولا حاجة إلى `@DynamicPropertySource`.

### إعداد PostgreSQL + Redis + Kafka

> [!NOTE]
> يدير Spring Boot 4 ‏Testcontainers 2.x، الذي ينقل كثيرًا من أصناف الحاويات إلى حزم خاصة بكل وحدة (مثل `org.testcontainers.postgresql.PostgreSQLContainer` و`org.testcontainers.kafka.KafkaContainer`)؛ والأصناف القديمة `org.testcontainers.containers.*` مُهملة. وتستخدم الأمثلة أسماء الأصناف الكلاسيكية — فعدّل الاستيرادات حسب إصدارك.

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
    static KafkaContainer kafka =            // org.testcontainers.kafka.KafkaContainer
        new KafkaContainer("apache/kafka:4.0.0");   // KRaft only — no ZooKeeper container

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

**ما يضبطه `@ServiceConnection` تلقائيًا:**

- ‏`PostgreSQLContainer` ← ‏`spring.datasource.url`، و`username`، و`password`، و`driver-class-name`
- ‏`RedisContainer` ← ‏`spring.data.redis.host`، و`port`
- ‏`KafkaContainer` ← ‏`spring.kafka.bootstrap-servers`

لا رد نداء `@DynamicPropertySource`. ولا `@TestPropertySource` بمنافذ مكتوبة في الكود. تبدأ الحاوية، وتسجل `ConnectionDetails` الخاصة بها، ويربطها Spring.

---

## 4. ‏WireMock 3.x لواجهات قنوات الدفع الخارجية

تستدعي خدمات الدفع قنوات خارجية: FPS ‏(خدمة المدفوعات السريعة)، وSWIFT، وشبكات البطاقات. ولا يمكن استدعاؤها في الاختبارات. ويوفر امتداد JUnit 5 في WireMock 3.x التعليق `@WireMockTest` لعزل نظيف لكل اختبار، ويغطي تكامل WireMock مع Spring Boot الاختبارات التي تحتاج سياق Spring.

```java
// @WireMockTest is WireMock's own JUnit 5 extension — there is no Spring
// context here, so build the client yourself against WireMock's URL
@WireMockTest
class FpsClientTest {

    FpsClient fpsClient;

    @BeforeEach
    void setUp(WireMockRuntimeInfo wm) {
        var requestFactory = new JdkClientHttpRequestFactory();
        requestFactory.setReadTimeout(Duration.ofSeconds(2));   // client timeout
        fpsClient = new FpsClient(RestClient.builder()
            .baseUrl(wm.getHttpBaseUrl())
            .requestFactory(requestFactory));
    }

    @Test
    void submitPayment_successResponse_returnsFpsReference() {
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
    void submitPayment_fps503_throwsFpsUnavailableException() {
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
    void submitPayment_networkTimeout_throwsRetryableException() {
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

**مع سياق Spring بدلًا من ذلك:** يبدأ تكامل WireMock الرسمي مع Spring Boot خادم WireMock ويكتب عنوانه في خاصية يقرؤها عميلك بالفعل:

```java
// org.wiremock.integrations:wiremock-spring-boot
@SpringBootTest
@EnableWireMock(@ConfigureWireMock(baseUrlProperties = "clients.fps.base-url"))
class FpsClientSpringTest {

    @Autowired
    FpsClient fpsClient;   // the real bean, pointed at WireMock

    // ... same stubs and assertions as above
}
```

---

## 5. اختبار قابلية المراقبة بـ `TestObservationRegistry`

توفر وحدة `micrometer-observation-test` في Micrometer ‏`TestObservationRegistry`، التي تسجل كل ملاحظة لتتمكن من التحقق من الأسماء والقيم والأخطاء. وسجّلها كـ bean في الاختبار — فيتراجع `ObservationRegistry` المضبوط تلقائيًا في Spring Boot حين يوجد واحد. ‏(أما `@AutoConfigureObservability` في Spring Boot فشيء آخر: فهو يعيد تفعيل *تصدير* المقاييس والتتبع في الاختبارات.)

```java
@SpringBootTest
class PaymentObservabilityTest {

    @TestConfiguration
    static class ObservationTestConfig {
        @Bean
        TestObservationRegistry observationRegistry() {
            return TestObservationRegistry.create();
        }
    }

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
            .assertThatError()
            .isInstanceOf(FraudDetectedException.class);
    }
}
```

يجب أن تنشئ `PaymentService` الملاحظة — إما بـ `@Observed` أو يدويًا. واستخدم أحدهما: فتعليم الصنف *و*إنشاء الملاحظة يدويًا يسجلانها مرتين.

```java
@Service
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

## 6. مخطط بنية شرائح الاختبار

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

الفكرة الأساسية: يجب أن تغطي كل شريحة شأنًا معماريًا واحدًا بالضبط. فـ `@WebMvcTest` يختبر التفويض وربط الطلب/الاستجابة؛ و`@DataJpaTest` يختبر صحة الاستعلامات؛ و`@EmbeddedKafka` يختبر تدفق الأحداث؛ و`@WireMockTest` يختبر سلوك عميل HTTP. واحتفظ بـ `@SpringBootTest` لعدد صغير من اختبارات الدخان من طرف إلى طرف.

---

## 7. أداء الاختبارات — تجنب `@DirtiesContext`

### النمط المضاد `@DirtiesContext` لاختبارات Kafka

يجبر `@DirtiesContext` ‏Spring على تدمير `ApplicationContext` وإعادة بنائه بعد صنف الاختبار المعلّم. وهو مغرٍ لاختبارات Kafka — فإزاحات مجموعات المستهلكين قد تلوث الاختبارات اللاحقة. والكلفة إعادة تشغيل كاملة للسياق: في خدمة كبيرة، 30-60 ثانية لكل مرة.

**نهج أفضل: عزل مجموعة المستهلكين لكل صنف اختبار**

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

مع `group-id` فريد، يبدأ كل صنف اختبار القراءة من أقدم إزاحة في مجموعة مستهلكيه الخاصة، فيزيل تلوث الحالة بين الاختبارات دون تدمير السياق.

### التخزين المؤقت للسياق

يخزن Spring نسخ `ApplicationContext` مؤقتًا بين الاختبارات ذات الإعداد نفسه. ويجعل `@MockitoBean` مفتاح التخزين المؤقت مختلفًا للصنف الذي يصرّح به (السلوك نفسه لـ `@MockBean` في SB3). ولتعظيم إعادة استخدام الذاكرة المؤقتة:

1. اجمع الاختبارات ذات مجموعة `@MockitoBean` نفسها في صنف الاختبار نفسه.
2. صرّح بالمحاكاة المشتركة مرة واحدة — في صنف أساس مشترك أو واجهة اختبار — لتتشارك أصناف الاختبار المجموعة نفسها فعلًا.
3. تجنب `@DirtiesContext` إلا إن كنت تعدّل حالة ساكنة (مثل `SecurityContextHolder` المحلي للخيط).

### تجنب الاختبارات المعتمدة على الترتيب

من المغري تقسيم دورة حياة إنشاء ← تسوية إلى دوال اختبار مرتبة (`@TestMethodOrder`) تتشارك معرّفًا ساكنًا. وفي `@DataJpaTest` هذا لا يعمل أصلًا: فكل دالة اختبار تعمل في معاملة **يُتراجع** عنها في النهاية، فيختفي الصف الذي أنشأته الدالة الأولى قبل أن تبدأ الثانية. فأبقِ دورة الحياة في اختبار واحد، وأجبر رحلات حقيقية إلى قاعدة البيانات بـ `flush()` و`clear()`:

```java
@DataJpaTest
class PaymentLifecycleTest {

    @Autowired
    PaymentRepository repository;

    @Autowired
    TestEntityManager entityManager;

    @Test
    void payment_canBeCreatedAndSettled() {
        var payment = repository.save(Payment.pending("acc-001", new BigDecimal("100.00"), "GBP"));
        entityManager.flush();
        entityManager.clear();   // next read really hits the database

        var loaded = repository.findById(payment.getId()).orElseThrow();
        loaded.settle("FPS-REF-001");
        entityManager.flush();
        entityManager.clear();

        assertThat(repository.findById(payment.getId()).orElseThrow().getStatus())
            .isEqualTo(PaymentStatus.SETTLED);
    }
}
```

الاختبارات المستقلة تستطيع العمل بأي ترتيب (أو بالتوازي) وتنجح مع ذلك — وهذه خاصية تستحق الحماية في قاعدة كود دفع كبيرة.

---

## 8. ‏`@WebMvcTest` كامل لتفويض الدفع

هذا اختبار جاهز للإنتاج يغطي دورة الأمان + الطلب كاملة لنقطة تفويض دفع:

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
    @WithMockUser(username = "user-abc",
                  authorities = { "ROLE_PAYMENT_INITIATOR", "SCOPE_payment:initiate" })
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
                        .claim("scope", "payment:initiate account:read"))
                    .authorities(new JwtConverterConfig.FinancialPermissionsConverter()))
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
                .content("{\"accountId\":\"acc-001\",\"amount\":100.00,\"currency\":\"GBP\"}"))
            .andExpect(status().isUnauthorized());

        verifyNoInteractions(paymentService);
    }

    @Test
    @WithMockUser(roles = "VIEWER")
    void initiatePayment_missingScope_returns403() throws Exception {
        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("{\"accountId\":\"acc-001\",\"amount\":100.00,\"currency\":\"GBP\"}"))
            .andExpect(status().isForbidden());

        verifyNoInteractions(paymentService);
    }

    // ---- Input validation ----

    @Test
    @WithMockUser(authorities = { "ROLE_PAYMENT_INITIATOR", "SCOPE_payment:initiate" })
    void initiatePayment_negativeAmount_returns400() throws Exception {
        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("{\"accountId\":\"acc-001\",\"amount\":-50.00,\"currency\":\"GBP\"}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value("VALIDATION_ERROR"));

        verifyNoInteractions(paymentService);
    }

    @Test
    @WithMockUser(authorities = { "ROLE_PAYMENT_INITIATOR", "SCOPE_payment:initiate" })
    void initiatePayment_serviceThrowsInsufficientFunds_returns422() throws Exception {
        given(paymentService.initiatePayment(any(), any(), any()))
            .willThrow(new InsufficientFundsException("acc-001"));

        mockMvc.perform(post("/api/v1/payments")
                .contentType(APPLICATION_JSON)
                .content("{\"accountId\":\"acc-001\",\"amount\":999999.00,\"currency\":\"GBP\"}"))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.error").value("INSUFFICIENT_FUNDS"));
    }
}
```

---

## الخلاصة

- يحل **`@MockitoBean` / `@MockitoSpyBean`** محل `@MockBean` / `@SpyBean` من `spring-boot-test`. وهما تعليقان من Spring Framework ‏(منذ 6.2) يعملان في أي سياق `@SpringJUnitConfig`، لا في اختبارات Spring Boot فقط.
- تحمّل **شرائح الاختبار** ‏(`@WebMvcTest`، و`@DataJpaTest`، و`@DataRedisTest`) سياقًا مركّزًا — ففضّل دائمًا الشرائح على `@SpringBootTest` للاختبارات بأسلوب الوحدة. واستخدم `@AutoConfigureTestDatabase(replace = NONE)` مع Testcontainers لسلوك JPA واقعي.
- يزيل **`@ServiceConnection`** ‏`@DynamicPropertySource` لحاويات Testcontainers — علّم `@Container` بـ `@ServiceConnection` ويربط Spring تفاصيل الاتصال تلقائيًا.
- يوفر **WireMock 3.x** مع `@WireMockTest` ‏(JUnit العادي) أو `@EnableWireMock` ‏(سياق Spring) عزلًا لكل اختبار لواجهات قنوات الدفع الخارجية. واختبر سيناريوهات المهلة، و5xx، وإخفاق الشبكة — لا المسارات السعيدة فقط.
- يتيح لك **`TestObservationRegistry`**، المسجّل كـ bean اختبار، التحقق من أسماء الملاحظات، والوسوم منخفضة الأصالة، وحالة الخطأ. واستخدمه لفرض عقود قابلية المراقبة في CI.
- **تجنب `@DirtiesContext` لاختبارات Kafka** — استخدم قيم `group-id` فريدة لكل صنف اختبار بدلًا من ذلك. فهذا يتجنب إعادات بناء السياق المكلفة مع الحفاظ على عزل الحالة.
- **أبقِ الاختبارات مستقلة** — يتراجع `@DataJpaTest` عن كل اختبار، فمكان سيناريوهات دورة الحياة دالة اختبار واحدة.

---

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-08-01",
    "question": "في Spring Boot 4، أي تعليق يحل محل @MockBean من spring-boot-test حين تحتاج تسجيل محاكاة Mockito في ApplicationContext لاختبار @WebMvcTest؟",
    "options": [
      "@Mock ‏(Mockito)",
      "@MockitoBean ‏(Spring Framework / spring-test، منذ 6.2)",
      "@TestBean ‏(Spring Boot 4)",
      "@InjectMocks ‏(Mockito)"
    ],
    "correct": 1,
    "explanation": "‏@MockitoBean تعليق من Spring Framework ‏(spring-test، منذ 6.2) يسجل محاكاة Mockito في ApplicationContext طوال مدة الاختبار. أما @Mock فينشئ محاكاة Mockito مجردة دون تكامل مع سياق Spring. وأُزيل @MockBean من spring-boot-test في Spring Boot 4."
  },
  {
    "id": "kc-08-02",
    "question": "تكتب @DataJpaTest لـ PaymentRepository يستخدم معاملات JSON الخاصة بـ PostgreSQL. أي تركيبة تضبط الاختبار بشكل صحيح لاستخدام قاعدة بيانات PostgreSQL حقيقية عبر Testcontainers؟",
    "options": [
      "@DataJpaTest + @AutoConfigureTestDatabase(replace = ANY) + @Container PostgreSQLContainer",
      "@DataJpaTest + @AutoConfigureTestDatabase(replace = NONE) + @Container @ServiceConnection PostgreSQLContainer",
      "@SpringBootTest + @Container PostgreSQLContainer دون @ServiceConnection",
      "@DataJpaTest + @DynamicPropertySource لتجاوز spring.datasource.url"
    ],
    "correct": 1,
    "explanation": "يمنع @AutoConfigureTestDatabase(replace = NONE) ‏Spring من استبدال DataSource بـ H2. ويربط @ServiceConnection على حقل @Container تفاصيل اتصال PostgreSQLContainer ‏(العنوان، واسم المستخدم، وكلمة المرور) تلقائيًا في الإعداد التلقائي لـ DataSource — دون الحاجة إلى @DynamicPropertySource."
  },
  {
    "id": "kc-08-03",
    "question": "لدى فريق 50 صنف @SpringBootTest يستخدم كل منها @DirtiesContext(classMode = AFTER_CLASS) لإعادة ضبط حالة مجموعة مستهلكي Kafka بين أصناف الاختبار. ما الطريقة الأكثر فعالية لإزالة هذا العبء؟",
    "options": [
      "استخدم @TestMethodOrder(MethodOrderer.Random.class) لجعل ترتيب تنفيذ الاختبارات عشوائيًا",
      "استبدل @SpringBootTest بـ @WebMvcTest لكل اختبارات Kafka",
      "اضبط spring.kafka.consumer.group-id على قيمة فريدة لكل صنف اختبار باستخدام @TestPropertySource(properties = {\"spring.kafka.consumer.group-id=test-${random.uuid}\"})",
      "أضف @Transactional لكل دالة اختبار للتراجع عن حالة Kafka"
    ],
    "correct": 2,
    "explanation": "يقرأ كل صنف اختبار من مجموعة مستهلكيه الفريدة الخاصة، فلا تؤثر عليه حالة الإزاحات من الأصناف السابقة. وهذا يتجنب تدمير السياق وإعادة إنشائه (عبء 30-60 ثانية لكل مرة) مع الحفاظ على عزل كامل للحالة. وKafka ليس معاملاتيًا بهذا المعنى فلا أثر لـ @Transactional على إزاحات المستهلكين."
  },
  {
    "id": "kc-08-04",
    "question": "للتحقق من أن PaymentService.initiatePayment() تصدر ملاحظة Micrometer باسم 'payment.initiate' بمفتاح منخفض الأصالة 'currency' في @SpringBootTest، أي واجهة تحقق يجب أن تستخدم؟",
    "options": [
      "Mockito.verify(meterRegistry).counter(\"payment.initiate\", \"currency\", \"GBP\")",
      "assertThat(observationRegistry).hasObservationWithNameEqualTo(\"payment.initiate\").that().hasLowCardinalityKeyValue(\"currency\", \"GBP\")",
      "assertThat(prometheusRegistry.get(\"payment.initiate\").counter().count()).isEqualTo(1)",
      "verify(tracer).startScopedSpan(\"payment.initiate\")"
    ],
    "correct": 1,
    "explanation": "يكشف TestObservationRegistry ‏(من micrometer-observation-test، المسجّل كـ bean في @TestConfiguration فيتراجع السجل المضبوط تلقائيًا في Boot) تحققات قائمة على AssertJ. فيجد hasObservationWithNameEqualTo() الملاحظة بالاسم، ويتحقق that().hasLowCardinalityKeyValue() من الوسوم دون الارتباط بتنفيذات مقاييس محددة."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-08",
  "title": "بناء مجموعة اختبارات كاملة لخدمة تفويض الدفع",
  "description": "نفّذ مجموعة اختبارات متعددة الطبقات تغطي أمان الويب، والوصول إلى البيانات، ومحاكاة الواجهات الخارجية، والتحقق من قابلية المراقبة لخدمة دفع في التقنية المالية.",
  "tasks": [
    {
      "id": "pc-08-01",
      "description": "اكتب صنف @WebMvcTest باسم PaymentControllerSecurityTest لـ PaymentController يغطي خمسة سيناريوهات: (1) طلب POST غير موثق يعيد 401 دون تفاعل مع PaymentService، (2) ‏@WithMockUser بـ ROLE_VIEWER يعيد 403، (3) ‏@WithMockUser بصلاحيتي ROLE_PAYMENT_INITIATOR وSCOPE_payment:initiate يعيد 201 مع paymentId في جسم الاستجابة، (4) رمز JWT محقون عبر SecurityMockMvcRequestPostProcessors.jwt() مع financial_roles=[\"PAYMENT_INITIATOR\"] يعيد 201، (5) خدمة ترمي InsufficientFundsException تعيد 422. واستخدم @MockitoBean لـ PaymentService."
    },
    {
      "id": "pc-08-02",
      "description": "اكتب صنف @DataJpaTest باسم PaymentRepositoryTest مع @AutoConfigureTestDatabase(replace = NONE) يستخدم @Container @ServiceConnection PostgreSQLContainer<?>. ونفّذ اختبارين: واحد يتحقق من أن findByAccountIdAndStatus() تعيد مدفوعات PENDING فقط (احفظ واحدة PENDING وواحدة SETTLED عبر TestEntityManager)، وواحد يتحقق من أن sumAmountByAccount() تعيد مجموع BigDecimal الدقيق 0.01 + 0.01 = 0.02 ‏(لاختبار دقة numeric في PostgreSQL)."
    },
    {
      "id": "pc-08-03",
      "description": "اكتب صنف @WireMockTest باسم FpsClientTest بثلاث دوال اختبار: (1) جهّز POST /payments ليعيد 201 مع fpsReference=FPS-2024-001 وتحقق من أن FpsClient.submit() يعيد ذلك المرجع، (2) جهّز إعادة 503 وتحقق من رمي FpsUnavailableException، (3) جهّز withFixedDelay(10000) وتحقق من رمي RetryablePaymentException بسبب مهلة قراءة العميل البالغة ثانيتين. وابنِ FpsClient في دالة @BeforeEach من WireMockRuntimeInfo.getHttpBaseUrl() ‏(لا سياق Spring في @WireMockTest)؛ واختياريًا أضف صيغة Spring بـ @EnableWireMock."
    },
    {
      "id": "pc-08-04",
      "description": "اكتب صنف @SpringBootTest باسم PaymentObservabilityTest يسجل bean من نوع TestObservationRegistry في @TestConfiguration متداخل ويحقنه. واختبر أن PaymentService.initiatePayment() مع دفعة صالحة تصدر ملاحظة باسم 'payment.initiate' بمفتاح منخفض الأصالة 'currency' مضبوط على 'GBP' ودون خطأ. وأضف اختبارًا ثانيًا يتحقق من أنه حين ترمي الخدمة FraudDetectedException، يكون للملاحظة نفسها خطأ من نوع FraudDetectedException ‏(assertThatError())."
    }
  ]
}
-->
