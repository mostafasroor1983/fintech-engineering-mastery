---
id: track-08-lesson-15
title: "اختبار قواعد البيانات — الاختبار القائم على الخصائص واختبار التكامل"
slug: database-testing
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 15
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [database-testing, Testcontainers, property-based, integration-testing, migration-testing]
prerequisites: [track-08-lesson-01, track-08-lesson-09]
---

# اختبار قواعد البيانات — الاختبار القائم على الخصائص واختبار التكامل

> [!NOTE]
> للأنظمة المالية عقد اختبار مع مستخدميها: الأرصدة متسقة دائمًا، والمال لا يُخلق ولا يُفنى أبدًا، والعمليات المتزامنة تنتج نتائج صحيحة. ولا يمكن التحقق من هذا العقد بمستودعات وهمية (mocks). بل يتطلب اختبارات تكامل حقيقية لقاعدة البيانات تعمل على المخطط الفعلي، بمحرك قاعدة البيانات الفعلي، تحت حمل متزامن. ويبني هذا الدرس بنية الاختبار تلك.

## لماذا يجب أن تستخدم اختبارات قاعدة البيانات قواعد بيانات حقيقية

نمط استخدام مستودعات وهمية في اختبارات الوحدة يخلق وهمًا خطيرًا بالصحة. فالكائنات الوهمية تتحقق من أن شيفرتك تستدعي دالة المستودع الصحيحة بالمعاملات الصحيحة. ولا تقول شيئًا عن:

- هل SQL صحيح نحويًا ودلاليًا مقابل المخطط الفعلي
- هل توجد فهارس تجعل الاستعلام سريعًا
- هل تُلتقط انتهاكات القيود وتُعالج بشكل صحيح
- هل تنتهك التحديثات المتزامنة الثوابت تحت تنازع واقعي
- هل تُطبق ترحيلات Flyway بنظافة على المخطط القائم
- هل ينتج مخطِّط الاستعلامات خطة فعالة على أحجام بيانات واقعية

وفي الأنظمة المالية، كلفة هذه الفجوات ليست اختبارًا فاشلًا بل حادث إنتاج — خصم مزدوج، أو رصيد سالب، أو استعلام رقابي فاشل.

والحل هرم اختبارات تعمل فيه اختبارات التكامل على نسخة PostgreSQL مؤقتة (عبر Testcontainers) مطابقة لمخطط الإنتاج.

## ‏Testcontainers لـ PostgreSQL

يشغّل Testcontainers نسخة PostgreSQL حقيقية في Docker للاختبارات؛ ثم يشغّل Spring Boot ترحيلات Flyway عليها عند بدء السياق. ومع حقول `@Container` تعيش الحاوية لصنف اختبار واحد؛ أما لمجموعة الاختبارات كاملة، فاستخدم نمط **الحاوية المفردة (singleton)** أدناه (شغّلها مرة واحدة لكل JVM؛ ويزيلها مكوّن Ryuk المرافق في Testcontainers حين تنتهي JVM).

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>postgresql</artifactId>
    <version>1.19.3</version>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>junit-jupiter</artifactId>
    <version>1.19.3</version>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-testcontainers</artifactId>
    <scope>test</scope>
</dependency>
```

```java
// Base class for all database integration tests.
// Singleton container: started ONCE per JVM in a static initializer.
// (A static @Container field in a base class would be started and stopped
//  again for every test class. withReuse(true) is an opt-in convenience for
//  local development only -- it needs testcontainers.reuse.enable=true in
//  ~/.testcontainers.properties and should not be relied on in CI.)
@SpringBootTest
@ActiveProfiles("test")
public abstract class DatabaseIntegrationTest {

    @ServiceConnection   // Spring Boot 3.1+: sets spring.datasource.* for us
    static final PostgreSQLContainer<?> POSTGRES =
        new PostgreSQLContainer<>("postgres:16-alpine")
            .withDatabaseName("fintech_test")
            .withUsername("test_user")
            .withPassword("test_pass")
            .withInitScript("sql/extensions.sql");  // runs before Flyway

    static {
        POSTGRES.start();
    }
}
```

```sql
-- src/test/resources/sql/extensions.sql (applied before Flyway migrations)
-- (better: create extensions in a Flyway migration, so prod and tests match)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- gen_random_uuid() is built in since PostgreSQL 13 -- uuid-ossp not needed
```

## إعداد @DataJpaTest

‏`@DataJpaTest` اختبار شريحة مركّز يحمّل فقط المكونات المتعلقة بـ JPA. ومع Testcontainers، يوفر اختبارات مستودعات سريعة ومعزولة.

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE) // use real DB, not H2
@Testcontainers
class PaymentRepositoryTest {   // @DataJpaTest: each test runs in a rolled-back transaction

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES =
        new PostgreSQLContainer<>("postgres:16-alpine")
            .withDatabaseName("test");

    @Autowired
    private PaymentRepository paymentRepository;

    @Autowired
    private TestEntityManager entityManager;

    @Test
    void should_persist_and_retrieve_payment() {
        // Arrange
        Payment payment = new Payment();
        payment.setAmountMinor(10000L);  // £100.00
        payment.setCurrencyCode("GBP");
        payment.setStatus("PENDING");
        payment.setTenantId(UUID.randomUUID());
        payment.setExternalRef("REF-001");

        // Act
        Payment saved = paymentRepository.save(payment);
        entityManager.flush();
        entityManager.clear();  // force reload from DB

        // Assert
        Payment loaded = paymentRepository.findById(saved.getId()).orElseThrow();
        assertThat(loaded.getAmountMinor()).isEqualTo(10000L);
        assertThat(loaded.getCurrencyCode()).isEqualTo("GBP");
        assertThat(loaded.getStatus()).isEqualTo("PENDING");
    }

    @Test
    void should_enforce_positive_amount_constraint() {
        Payment payment = aPayment().withAmountMinor(-100L).build();

        // The DB-level CHECK constraint should reject this. saveAndFlush()
        // goes through Spring's exception translation, so we get Spring's
        // DataIntegrityViolationException (not a Hibernate- or
        // Bean-Validation-specific ConstraintViolationException).
        assertThatThrownBy(() -> paymentRepository.saveAndFlush(payment))
            .isInstanceOf(DataIntegrityViolationException.class);
    }
}
```

## عزل الاختبارات بالمعاملات

يجب أن يعمل كل اختبار بعزل دون ترك حالة تؤثر على الاختبارات الأخرى. وهناك نمطان:

**النمط 1: `@Transactional` على الاختبار** — يعمل الاختبار في معاملة يُتراجع عنها بعده. وهذا أسرع نهج. وقيده: لا تستطيع الاختبارات التحقق من سلوك يعتمد على حدود المعاملات (فحوص القيود عند الالتزام، و`REQUIRES_NEW`، والخيوط أو الاتصالات الأخرى، ومعالجة الجمود) — بل إن العمل على اتصالات أخرى لا يرى حتى صفوف الاختبار غير الملتزمة.

**النمط 2: التفريغ بـ `@Sql` قبل كل اختبار** — نظّف صراحة بين الاختبارات. واستخدم هذا حين تحتاج اختبارًا عبر حدود المعاملات.

```java
@Test
@Transactional  // rolled back after the test — no cleanup needed
void findHighRiskPayments_returnsOnlyAboveThreshold() {
    // Arrange
    paymentRepository.save(aPayment().withRiskScore(80).withStatus("PENDING_REVIEW").build());
    paymentRepository.save(aPayment().withRiskScore(50).withStatus("PENDING_REVIEW").build());
    paymentRepository.save(aPayment().withRiskScore(90).withStatus("PENDING_REVIEW").build());

    // Act
    List<Payment> highRisk = paymentRepository.findHighRiskPendingReview(75);

    // Assert
    assertThat(highRisk).hasSize(2);
    assertThat(highRisk).allMatch(p -> p.getRiskScore() > 75);
}

// Pattern 2: SQL truncation for cross-transaction tests
@Test
@Sql(statements = "TRUNCATE TABLE payments, ledger_entries, accounts RESTART IDENTITY CASCADE",
     executionPhase = Sql.ExecutionPhase.BEFORE_TEST_METHOD)
void processPayment_creditsDestinationAndDebitsSource() {
    // This test must cross a transaction boundary to verify atomicity
    // Cannot use @Transactional here
    UUID sourceAccountId = createAccountWithBalance(50000L, "GBP");
    UUID destAccountId   = createAccountWithBalance(10000L, "GBP");

    paymentService.transfer(sourceAccountId, destAccountId, 20000L, "GBP");

    // Verify both accounts in the same committed state
    assertThat(accountRepository.findById(sourceAccountId).orElseThrow().getBalanceMinor())
        .isEqualTo(30000L);
    assertThat(accountRepository.findById(destAccountId).orElseThrow().getBalanceMinor())
        .isEqualTo(30000L);
}
```

## اختبار ترحيلات Flyway

يجب اختبار كل ترحيل مخطط بعزل قبل دمجه. واختبر ثلاثة أشياء:
1. يُطبق الترحيل بنظافة على المخطط الحالي
2. الترحيل قابل للعكس (أو غير قابل للعكس صراحة مع تبرير)
3. الاستعلامات القائمة ما زالت تعمل بعد الترحيل

```java
@SpringBootTest
@Testcontainers
class FlywayMigrationTest {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES =
        new PostgreSQLContainer<>("postgres:16-alpine");

    @Autowired
    private Flyway flyway;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void all_migrations_apply_successfully() {
        // If this test passes, all migrations in classpath://db/migration applied cleanly
        MigrationInfo[] applied = flyway.info().applied();
        assertThat(applied).isNotEmpty();

        // Verify no failed migrations
        long failed = Arrays.stream(applied)
            .filter(m -> m.getState() == MigrationState.FAILED)
            .count();
        assertThat(failed).isZero();
    }

    @Test
    void migration_V20_adds_fraud_score_column() {
        // Test that a specific migration produced the expected schema change
        int count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_name   = 'payments'
              AND column_name  = 'fraud_score_cache'
            """, Integer.class);

        assertThat(count).isEqualTo(1);
    }

    @Test
    void migration_V20_backfills_existing_rows() {
        // A backfill can only be tested with rows that exist BEFORE it runs
        // (after a full migration the test database is empty). So: migrate a
        // separate schema up to V19, insert rows, then apply V20.
        FluentConfiguration config = Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .schemas("backfill_test");                 // not the app's schema
        config.target(MigrationVersion.fromVersion("19")).load().migrate();

        jdbcTemplate.update("""
            INSERT INTO backfill_test.payments (tenant_id, amount_minor, currency_code,
                                                status, risk_data)
            VALUES (gen_random_uuid(), 1000, 'GBP', 'PENDING',
                    '{"fraud_score": 42}'::jsonb)
            """);

        config.target(MigrationVersion.fromVersion("20")).load().migrate();

        // V20 must have filled fraud_score_cache from risk_data
        int nullCount = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM backfill_test.payments
            WHERE (risk_data ->> 'fraud_score') IS NOT NULL
              AND fraud_score_cache IS NULL
            """, Integer.class);

        assertThat(nullCount).isZero();
    }
}
```

## الاختبار القائم على الخصائص للثوابت المالية

يولّد الاختبار القائم على الخصائص مئات المدخلات العشوائية للتحقق من ثوابت يجب أن تصح لكل المدخلات الصالحة. وفي الأنظمة المالية، أهم الثوابت:

- رصيد الحساب لا يكون سالبًا أبدًا (الخدمة ترفض السحب على المكشوف)
- المال محفوظ: التحويلات تنقل المال لكنها لا تخلقه ولا تفنيه أبدًا
- مجموع قيود الدفتر المدينة يساوي مجموع قيود الدفتر الدائنة (ثابت القيد المزدوج)
- مبلغ الدفعة في الدفتر يطابق المبلغ المفوَّض الأصلي
- انتقالات الحالة إلى الأمام فقط (PENDING -> AUTHORISED -> SETTLED، لا إلى الخلف أبدًا)

```xml
<!-- pom.xml -->
<dependency>
    <groupId>net.jqwik</groupId>
    <artifactId>jqwik</artifactId>
    <version>1.8.1</version>
    <scope>test</scope>
</dependency>
<!-- jqwik is its own test engine: Spring's JUnit extension and
     Testcontainers' @Container do not work in @Property methods.
     jqwik-spring adds Spring support. -->
<dependency>
    <groupId>net.jqwik</groupId>
    <artifactId>jqwik-spring</artifactId>
    <version><!-- release matching your jqwik + Spring version --></version>
    <scope>test</scope>
</dependency>
```

```java
// Uses the singleton container from DatabaseIntegrationTest (no @Container:
// jqwik does not run the Testcontainers JUnit extension)
@JqwikSpringSupport
class LedgerInvariantsTest extends DatabaseIntegrationTest {

    @Autowired
    private LedgerService ledgerService;

    @Autowired
    private AccountRepository accountRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    // Property: the service refuses every transfer that would overdraw the
    // account, and applies every other one exactly. (Checking the balance in
    // the TEST before calling the service would make this property trivially
    // true -- the service itself must be exercised with too-large amounts.)
    @Property(tries = 200)
    void transfers_never_overdraw_the_account(
        @ForAll @LongRange(min = 1000, max = 1_000_000) long initialBalance,
        @ForAll @Size(min = 1, max = 10) List<@LongRange(min = 1, max = 500_000) Long> transferAmounts
    ) {
        // Arrange: fresh accounts per try, so tries never share rows
        UUID accountId = createAccountWithBalance(initialBalance, "GBP");
        UUID destId    = createAccountWithBalance(0L, "GBP");

        for (long amount : transferAmounts) {
            long before = getBalance(accountId);
            if (amount > before) {
                assertThatThrownBy(() -> ledgerService.transfer(accountId, destId, amount, "GBP"))
                    .isInstanceOf(InsufficientFundsException.class);
                assertThat(getBalance(accountId)).isEqualTo(before);   // unchanged
            } else {
                ledgerService.transfer(accountId, destId, amount, "GBP");
                assertThat(getBalance(accountId)).isEqualTo(before - amount);
            }
        }

        assertThat(getBalance(accountId)).isGreaterThanOrEqualTo(0L);
    }

    // Property: money is conserved (and the ledger stays balanced)
    @Property(tries = 100)
    void transfers_conserve_money(
        @ForAll @Size(min = 1, max = 20) List<@LongRange(min = 1, max = 50000) Long> amounts
    ) {
        // Arrange
        List<UUID> accounts = new ArrayList<>();
        for (int i = 0; i <= amounts.size(); i++) {
            accounts.add(createAccountWithBalance(1_000_000L, "GBP"));
        }

        // Act: perform random transfers between accounts
        for (int i = 0; i < amounts.size(); i++) {
            UUID from   = accounts.get(i);
            UUID to     = accounts.get(i + 1);
            long amount = amounts.get(i);

            if (getBalance(from) >= amount) {
                ledgerService.transfer(from, to, amount, "GBP");
            }
        }

        // Assert: total money in the system is conserved
        long totalMoney = jdbcTemplate.queryForObject(
            "SELECT COALESCE(SUM(balance_minor), 0) FROM accounts WHERE id = ANY(?)",
            Long.class,
            accounts.toArray(new UUID[0])
        );
        // Total should equal initial balances (no money created or destroyed)
        long expectedTotal = (long) accounts.size() * 1_000_000L;
        assertThat(totalMoney).isEqualTo(expectedTotal);

        // Double-entry check over the whole ledger: debits = credits
        // (assuming ledger_entries(entry_type 'DEBIT'/'CREDIT', amount_minor))
        long imbalance = jdbcTemplate.queryForObject("""
            SELECT COALESCE(SUM(CASE entry_type WHEN 'DEBIT' THEN amount_minor
                                                ELSE -amount_minor END), 0)
            FROM ledger_entries
            """, Long.class);
        assertThat(imbalance).isZero();
    }

    // Property: payment status can only advance, never retreat
    @Property(tries = 50)
    void payment_status_transitions_are_forward_only(
        @ForAll("randomStatusSequences") List<String> statusSequence
    ) {
        UUID paymentId = createPayment("PENDING");

        List<String> ORDER = List.of("PENDING", "AUTHORISED", "CAPTURED", "SETTLED", "REFUNDED");

        for (String nextStatus : statusSequence) {
            String current = getPaymentStatus(paymentId);
            int currentOrdinal = ORDER.indexOf(current);
            int nextOrdinal    = ORDER.indexOf(nextStatus);

            if (nextOrdinal > currentOrdinal) {
                // Valid forward transition
                paymentService.updateStatus(paymentId, nextStatus);
                assertThat(getPaymentStatus(paymentId)).isEqualTo(nextStatus);
            } else {
                // Invalid backward transition should be rejected
                assertThatThrownBy(() -> paymentService.updateStatus(paymentId, nextStatus))
                    .isInstanceOf(IllegalStateTransitionException.class);
                // Status should be unchanged
                assertThat(getPaymentStatus(paymentId)).isEqualTo(current);
            }
        }
    }

    @Provide
    Arbitrary<List<String>> randomStatusSequences() {   // valid AND invalid steps
        return Arbitraries.of("PENDING", "AUTHORISED", "CAPTURED", "SETTLED", "REFUNDED")
                          .list().ofMinSize(1).ofMaxSize(8);
    }
}
```

## اختبار العمليات المتزامنة

أخطاء التزامن من أخطر الأخطاء في الأنظمة المالية وأصعبها التقاطًا بالاختبارات التتابعية. فاستخدم اختبارات متعددة الخيوط بتوقيت مضبوط لإعادة إنتاج حالات السباق.

```java
@SpringBootTest
@Testcontainers
class ConcurrentOperationsTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> POSTGRES =
        new PostgreSQLContainer<>("postgres:16-alpine");

    @Autowired
    private LedgerService ledgerService;

    // NOT @Transactional: every thread needs its own committed transaction
    @Test
    void concurrent_debits_should_not_overdraw_account() throws InterruptedException {
        // Create an account with exactly £100.00
        // (the latch makes the race very likely, not certain -- run such
        //  tests repeatedly, e.g. @RepeatedTest(20))
        UUID accountId = createAccountWithBalance(10000L, "GBP");

        int numThreads = 20;
        int debitAmount = 1000; // £10.00 each — 10 of these should succeed, 10 should fail

        CountDownLatch latch   = new CountDownLatch(numThreads);
        AtomicInteger succeeded = new AtomicInteger(0);
        AtomicInteger failed    = new AtomicInteger(0);

        ExecutorService executor = Executors.newFixedThreadPool(numThreads);

        for (int i = 0; i < numThreads; i++) {
            executor.submit(() -> {
                latch.countDown();
                try {
                    latch.await();  // all threads start simultaneously
                    ledgerService.debit(accountId, debitAmount, "GBP", "concurrent-test");
                    succeeded.incrementAndGet();
                } catch (InsufficientFundsException e) {
                    failed.incrementAndGet();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        }

        executor.shutdown();
        assertThat(executor.awaitTermination(30, TimeUnit.SECONDS)).isTrue();

        // Exactly 10 debits should succeed (£10.00 x 10 = £100.00)
        assertThat(succeeded.get()).isEqualTo(10);
        assertThat(failed.get()).isEqualTo(10);

        // Final balance must be exactly 0 — not negative
        long finalBalance = getBalance(accountId);
        assertThat(finalBalance).isZero();
    }

    @Test
    void concurrent_transfers_maintain_total_balance() throws InterruptedException {
        // Create a ring of 5 accounts, each with £1,000
        int numAccounts = 5;
        long initialBalance = 100_000L; // £1,000.00 each
        List<UUID> accounts = IntStream.range(0, numAccounts)
            .mapToObj(i -> createAccountWithBalance(initialBalance, "GBP"))
            .collect(Collectors.toList());

        int numTransfers = 100;
        int transferAmount = 100; // £1.00

        ExecutorService executor = Executors.newFixedThreadPool(10);
        CountDownLatch done = new CountDownLatch(numTransfers);
        Queue<Throwable> unexpected = new ConcurrentLinkedQueue<>();

        for (int i = 0; i < numTransfers; i++) {
            final int idx = i;
            executor.submit(() -> {
                try {
                    UUID from = accounts.get(idx % numAccounts);
                    UUID to   = accounts.get((idx + 1) % numAccounts);
                    ledgerService.transfer(from, to, transferAmount, "GBP");
                } catch (InsufficientFundsException e) {
                    // acceptable (cannot happen with these amounts, but harmless)
                } catch (Throwable t) {
                    // Deadlocks, serialization failures etc. are BUGS here:
                    // a ring of transfers deadlocks unless transfer() locks
                    // both accounts in a fixed order -- swallowing them would
                    // hide exactly the problem this test exists to find
                    unexpected.add(t);
                } finally {
                    done.countDown();
                }
            });
        }

        assertThat(done.await(30, TimeUnit.SECONDS)).isTrue();
        executor.shutdown();
        assertThat(unexpected).isEmpty();

        // Total money in system must equal initial total — conservation law
        long totalBalance = accounts.stream()
            .mapToLong(id -> getBalance(id))
            .sum();

        assertThat(totalBalance).isEqualTo((long) numAccounts * initialBalance);
    }
}
```

## بنّاءو بيانات الاختبار للكيانات المالية

بنّاءو بيانات الاختبار المقروؤون يمنعون الاختبارات من أن تكون هشة وغير مقروءة. ويتيح نمط البنّاء للاختبارات تحديد السمات المتعلقة بالسيناريو المختبَر فقط.

```java
// Builder pattern for financial test entities
public class PaymentBuilder {

    // No id: the entity's @GeneratedValue assigns it. Setting an id on a new
    // entity makes Spring Data treat it as existing (merge instead of
    // persist), which fails on recent Hibernate versions.
    private UUID tenantId        = UUID.randomUUID();
    private Long amountMinor     = 10000L;         // £100.00
    private String currencyCode  = "GBP";
    private String status        = "PENDING";
    private String paymentMethod = "CARD";
    private String externalRef   = "REF-" + UUID.randomUUID().toString().substring(0, 8);
    private Map<String, Object> processorData = new HashMap<>();
    private Map<String, Object> riskData      = new HashMap<>();

    public static PaymentBuilder aPayment() {
        return new PaymentBuilder();
    }

    public PaymentBuilder withAmountMinor(long amountMinor) {
        this.amountMinor = amountMinor;
        return this;
    }

    public PaymentBuilder withCurrency(String currencyCode) {
        this.currencyCode = currencyCode;
        return this;
    }

    public PaymentBuilder withStatus(String status) {
        this.status = status;
        return this;
    }

    public PaymentBuilder withRiskScore(int score) {
        this.riskData = Map.of("fraud_score", score, "model_version", "v3");
        return this;
    }

    public PaymentBuilder withProcessorRef(String ref) {
        Map<String, Object> data = new HashMap<>(this.processorData);
        data.put("processor_ref", ref);
        data.put("processor", "stripe");
        this.processorData = data;
        return this;
    }

    public PaymentBuilder pendingReview() {
        this.status = "PENDING_REVIEW";
        return this;
    }

    public PaymentBuilder settled() {
        this.status = "SETTLED";
        return this;
    }

    public Payment build() {
        Payment p = new Payment();
        p.setTenantId(tenantId);
        p.setAmountMinor(amountMinor);
        p.setCurrencyCode(currencyCode);
        p.setStatus(status);
        p.setPaymentMethod(paymentMethod);
        p.setExternalRef(externalRef);
        p.setProcessorData(processorData);
        p.setRiskData(riskData);
        return p;
    }
}

// Idiomatic test usage — reads like a specification
@Test
void findHighRiskPendingReview_returnsHighRiskPayments() {
    paymentRepository.saveAll(List.of(
        aPayment().withRiskScore(90).pendingReview().build(),
        aPayment().withRiskScore(60).pendingReview().build(),
        aPayment().withRiskScore(80).pendingReview().build(),
        aPayment().withRiskScore(90).settled().build()    // settled, should not appear
    ));

    List<Payment> results = paymentRepository.findHighRiskPendingReview(75);

    assertThat(results).hasSize(2)
        .allMatch(p -> p.getStatus().equals("PENDING_REVIEW"));
}
```

## اختبار أداء الاستعلامات ضمن مجموعة الاختبارات

ضمّن طبقة اختبار أداء تتحقق من أن الاستعلامات الأساسية تُنفذ ضمن حدود زمن مقبولة، باستخدام أحجام بيانات واقعية.

```java
@SpringBootTest
@Testcontainers
@Tag("performance")
class QueryPerformanceTest {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES =
        new PostgreSQLContainer<>("postgres:16-alpine")
            .withCommand("postgres -c shared_buffers=256MB -c max_connections=100");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeAll
    static void loadTestData() {
        // Load 1 million payment rows — representative of production scale
        // Use COPY via CopyManager for speed
    }

    @Test
    @Timeout(value = 500, unit = TimeUnit.MILLISECONDS)  // must complete in 500ms
    void high_risk_query_completes_within_sla() {
        List<Map<String, Object>> results = jdbcTemplate.queryForList("""
            SELECT *
            FROM payments
            WHERE (risk_data ->> 'fraud_score')::INTEGER > 75
              AND status = 'PENDING_REVIEW'
              AND created_at > NOW() - INTERVAL '24 hours'
            ORDER BY (risk_data ->> 'fraud_score')::INTEGER DESC
            LIMIT 100
            """);

        // Verify result correctness AND timing (timeout annotation handles latency)
        assertThat(results).isNotNull();
    }

    @Test
    void explain_analyze_shows_index_scan_not_seq_scan() {
        // Fresh statistics, otherwise the planner guesses. And use a SELECTIVE
        // value: if most rows match, a Seq Scan is the correct plan.
        jdbcTemplate.execute("ANALYZE payments");
        String plan = jdbcTemplate.queryForObject("""
            EXPLAIN (ANALYZE, FORMAT JSON)
            SELECT * FROM payments
            WHERE processor_data @> '{"processor_ref": "pi_rare_test_ref"}'::jsonb
            LIMIT 100
            """, String.class);

        // The plan must use a GIN Bitmap Index Scan, not a Sequential Scan
        assertThat(plan).doesNotContain("Seq Scan");
        assertThat(plan).containsAnyOf("Bitmap Index Scan", "Index Scan");
    }
}
```

## إعداد الاختبار بـ application-test.yml

```yaml
# src/test/resources/application-test.yml
spring:
  jpa:
    hibernate:
      ddl-auto: validate  # validate schema matches entities; never create/drop
    show-sql: false        # avoid log noise in test output
    properties:
      hibernate:
        format_sql: false
        jdbc:
          batch_size: 50
          order_inserts: true
          order_updates: true
  flyway:
    enabled: true
    locations: classpath:db/migration
    clean-disabled: true   # never allow flyway clean (the default in recent Flyway)
    validate-on-migrate: true
  datasource:
    hikari:
      maximum-pool-size: 5   # small pool for tests; containers have limited connections
      minimum-idle: 2

logging:
  level:
    org.flywaydb: INFO
    org.testcontainers: WARN
    com.zaxxer.hikari: WARN
```

## الخلاصات الأساسية

1. **لا تستخدم أبدًا H2 أو مستودعات وهمية** لاختبارات تكامل قاعدة البيانات في الأنظمة المالية — فاختلافات المخطط، ومعالجة الأنواع، وسلوك الأقفال تختلف جوهريًا عن PostgreSQL.
2. **نسخة Testcontainers مفردة** (تُشغّل مرة واحدة لكل JVM) توزّع كلفة بدء الحاوية — بضع ثوانٍ — على مجموعة الاختبارات كلها. ويمكن لـ `withReuse(true)` أيضًا إبقاؤها بين التشغيلات المحلية، لكنه اختياري وليس مخصصًا لـ CI.
3. **‏`@DataJpaTest` مع `Replace.NONE`** الشريحة الصحيحة لاختبارات طبقة المستودعات؛ و`@SpringBootTest` لاختبارات طبقة الخدمات التي تعبر حدود المعاملات.
4. **الاختبارات القائمة على الخصائص** (jqwik) أكثر قيمة من الاختبارات القائمة على الأمثلة للثوابت المالية — فهي تولّد حالات حدية لن تفكر في كتابتها يدويًا.
5. **الاختبارات المتزامنة بـ `CountDownLatch`** تجعل حالات السباق أرجح بكثير بتشغيل كل الخيوط معًا — لكنها ليست مؤكدة، فكررها، ولا تبتلع أبدًا الاستثناءات غير المتوقعة.
6. **بنّاءو بيانات الاختبار** يجعلون الاختبارات موثّقة ذاتيًا ومقاومة لتطور المخطط.
7. **تأكيدات EXPLAIN ANALYZE** في الاختبارات تمنع تراجعات الفهارس — فإذا حذف ترحيل فهرسًا، يفشل اختبار الأداء قبل النشر في الإنتاج.
8. **اختبارات ترحيلات Flyway** يجب أن تكون جزءًا من خط CI، لا فكرة لاحقة — فهي تلتقط تغييرات المخطط غير المتوافقة قبل وصولها إلى الإنتاج.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "صنف اختبار معلّم بـ @DataJpaTest يستخدم الإعداد الافتراضي. ويشغّل مطوّر الاختبارات فيجد أن قيد CHECK مخصصًا خاصًا بـ PostgreSQL يُتجاهل بصمت. ما السبب الجذري والإصلاح الصحيح؟",
      "options": ["يهيئ @DataJpaTest تلقائيًا قاعدة بيانات H2 في الذاكرة لا تدعم صيغة قيد CHECK الخاصة بـ PostgreSQL؛ والإصلاح بإضافة @AutoConfigureTestDatabase(replace = Replace.NONE) وتوفير مصدر بيانات PostgreSQL عبر Testcontainers", "يجب تعليم قيد CHECK بـ @Column(columnDefinition = ...) كي تلتقطه شريحة الاختبار", "يتجاهل JPA قيود CHECK بالتصميم؛ استخدم مستمع @PrePersist بدلًا من ذلك", "أضف spring.jpa.hibernate.ddl-auto=validate لفرض التحقق من القيود في الاختبارات"],
      "correct": 0,
      "explanation": "يستبدل @DataJpaTest افتراضيًا مصدر البيانات المُعدّ بقاعدة بيانات H2 مضمّنة. وH2 إما يتجاهل أو يسيء تفسير DDL الخاص بـ PostgreSQL بما فيه قيود CHECK، والأنواع المخصصة، ودوال PostgreSQL. والإصلاح @AutoConfigureTestDatabase(replace = Replace.NONE) مع حاوية PostgreSQL من Testcontainers كمصدر بيانات الاختبار، فتُشغّل ترحيلات Flyway الفعلية على PostgreSQL حقيقي."
    },
    {
      "text": "اختبار قائم على الخصائص باستخدام jqwik يتحقق من أن PaymentService.transfer(from, to, amount) لا ينتج رصيدًا سالبًا أبدًا. ويولّد الاختبار 1,000 سيناريو تحويل عشوائي. وينجح الاختبار على حاسوب المطوّر لكنه يفشل بشكل متقطع في CI. ما السبب الأرجح؟",
      "options": ["يستخدم jqwik بذرة عشوائية مختلفة في CI عن حاسوب المطوّر", "الحالات المولّدة تتشارك حالة قاعدة البيانات: المحاولات تعمل واحدة تلو الأخرى، لكن الصفوف التي تتركها المحاولات السابقة (أو أصناف الاختبار الأخرى التي تعمل بالتوازي على قاعدة البيانات نفسها في CI) تغيّر الأرصدة التي تعتمد عليها محاولة لاحقة", "‏jqwik غير متوافق مع Testcontainers في بيئات CI", "الاختبارات القائمة على الخصائص تتطلب تعليق @Seed ثابتًا لتكون حتمية في CI"],
      "correct": 1,
      "explanation": "يشغّل jqwik محاولات الخاصية تتابعيًا، لكن كل محاولة تكتب بيانات ملتزمة. فإذا أعادت المحاولات استخدام الحسابات نفسها، أو عملت أصناف اختبار أخرى بالتوازي على قاعدة البيانات نفسها في CI، ترى محاولة لاحقة أرصدة غيّرها طرف آخر — فتعتمد النتائج على الترتيب والتوقيت، اللذين يختلفان بين الحاسوب وCI. والإصلاح إعطاء كل محاولة حساباتها المنشأة حديثًا (UUID جديدة) والتأكيد على تلك الصفوف فقط، أو عزل قاعدة البيانات لكل صنف اختبار. والبذرة الثابتة تجعل المدخلات المولّدة قابلة للتكرار فقط؛ ولا تزيل الحالة المشتركة."
    },
    {
      "text": "يستخدم اختبار متزامن CountDownLatch للتحقق من أن معاملتي SELECT FOR UPDATE متزامنتين على صف الدفعة نفسه لا تمضيان معًا — يجب أن تنتظر إحداهما. وينشئ الاختبار خيطين، يستدعي كلاهما latch.await() قبل تنفيذ الاستعلام، ثم يحرر القفل الزمني. وينجح الاختبار محليًا لكنه ينجح دائمًا حتى حين يُزال SELECT FOR UPDATE عن طريق الخطأ. ما الخطأ في تصميم الاختبار؟",
      "options": ["‏CountDownLatch لا يعمل مع عمليات قاعدة البيانات", "لا يتحقق الاختبار من أن أحد الخيطين حُجب — بل يتحقق فقط من أن الخيطين اكتملا دون استثناء، وهو ما ينجح أيضًا حين لا يوجد قفل", "يحتاج الخيطان إلى استخدام اتصالات قاعدة بيانات مختلفة كي يعمل القفل", "يتطلب SELECT FOR UPDATE مستوى العزل SERIALIZABLE ليعمل بشكل صحيح"],
      "correct": 1,
      "explanation": "الاختبار الذي يتحقق فقط من عدم رمي استثناءات ينجح سواء حدث القفل أم لا. ولاختبار تسلسل SELECT FOR UPDATE بشكل صحيح، يجب أن يتحقق الاختبار من الترتيب الزمني: يجب ألا يكتمل الخيط 2 قبل أن يحرر الخيط 1 القفل. وهذا يتطلب التقاط طوابع زمنية أو استخدام CountDownLatch ثانٍ يشير إليه الخيط 1 فقط بعد إكمال معاملته، ثم التحقق من أن زمن بدء الخيط 2 بعد زمن التزام الخيط 1."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء مجموعة اختبارات شاملة لقاعدة البيانات باستخدام Testcontainers",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "اضبط نسخة PostgreSQL مشتركة من Testcontainers لمجموعة الاختبارات كلها باستخدام نمط الحاوية المفردة: حاوية ثابتة في صنف أساسي مجرد، تُشغّل مرة واحدة في مُهيّئ ثابت (لا حقل @Container)، مع @ServiceConnection أو @DynamicPropertySource لمصدر بيانات Spring. وتحقق من أن صنفي اختبار يستخدمان الحاوية نفسها بفحص أن كليهما يرى معرّف حاوية Docker نفسه. وأضف اختبار ترحيل Flyway يتحقق من أن كل الترحيلات في db/migration تُطبق بنظافة من V1 حتى الإصدار الحالي."
    },
    {
      "id": "2",
      "description": "اكتب اختبارًا قائمًا على الخصائص باستخدام jqwik (مع jqwik-spring / @JqwikSpringSupport) لـ PaymentService.transfer(UUID from, UUID to, BigDecimal amount) يتحقق من ثلاثة ثوابت عبر 500 سيناريو مولّد: (أ) حفظ مجموع أرصدة كل الحسابات، (ب) عدم نزول أي رصيد حساب تحت الصفر، (ج) أن التحويل idempotent بمفتاح idempotency نفسه. واستخدم @ForAll @BigRange(min = 1, max = 10000) للمبالغ وتأكد من أن كل سيناريو يستخدم حسابات معزولة لتجنب التداخل بين السيناريوهات."
    },
    {
      "id": "3",
      "description": "اكتب اختبارًا متزامنًا يتحقق من أن SELECT FOR UPDATE يمنع الإنفاق المزدوج: 10 خيوط يحاول كل منها خصم 100 وحدة من الحساب نفسه حين يكون الرصيد 500 (أي يجب أن ينجح 5 على الأكثر). واستخدم CountDownLatch لمزامنة بدء الخيوط. وتحقق من أن 5 خيوط بالضبط تنجح و5 بالضبط تتلقى InsufficientFundsException. وتحقق من أن الرصيد النهائي 0 بالضبط. ويجب أن يكون الاختبار حتميًا عبر 10 تشغيلات."
    },
    {
      "id": "4",
      "description": "أضف اختبار تأكيد EXPLAIN ANALYZE: بعد تشغيل CREATE INDEX CONCURRENTLY على (account_id، created_at) لجدول payments، نفّذ الاستعلام SELECT * FROM payments WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10 والتقط مخرج EXPLAIN (ANALYZE, FORMAT JSON). وتحقق من أن الخطة تحوي 'Index Scan' (لا 'Seq Scan') وأن الزمن الإجمالي الفعلي أقل من 5ms على مجموعة بيانات من 100,000 صف. ويجب أن يفشل هذا الاختبار إذا حذف ترحيل مستقبلي الفهرس."
    }
  ]
}
-->
