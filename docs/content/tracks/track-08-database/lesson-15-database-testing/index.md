---
id: track-08-lesson-15
title: "Database Testing — Property-Based and Integration Testing"
slug: database-testing
track: track-08
trackName: "Database & Data Architecture"
sequence: 15
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [database-testing, Testcontainers, property-based, integration-testing, migration-testing]
prerequisites: [track-08-lesson-01, track-08-lesson-09]
---

# Database Testing — Property-Based and Integration Testing

> [!NOTE]
> Financial systems have a testing contract with their users: balances are always consistent, money is never created or destroyed, and concurrent operations produce correct results. This contract cannot be verified with mocked repositories. It requires real database integration tests that run on the actual schema, with the actual database engine, under concurrent load. This lesson builds that testing infrastructure.

## Why Database Tests Must Use Real Databases

The pattern of mocking repositories in unit tests creates a dangerous illusion of correctness. Mocks verify that your code calls the right repository method with the right arguments. They say nothing about:

- Whether the SQL is syntactically and semantically correct against the actual schema
- Whether indexes exist to make the query fast
- Whether constraint violations are correctly caught and handled
- Whether concurrent updates violate invariants under realistic contention
- Whether Flyway migrations apply cleanly to the existing schema
- Whether the query planner produces an efficient plan on realistic data volumes

For financial systems, the cost of these gaps is not a failed test but a production incident — a double charge, a negative balance, or a failed regulatory query.

The solution is a testing pyramid where integration tests run against an ephemeral PostgreSQL instance (via Testcontainers) that is schema-identical to production.

---

## Testcontainers for PostgreSQL

Testcontainers starts a real PostgreSQL in Docker for the tests; Spring Boot then runs the Flyway migrations against it at context start. With `@Container` fields the container lives for one test class; for a whole suite, use the **singleton container** pattern below (start it once per JVM; Testcontainers' Ryuk sidecar removes it when the JVM exits).

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

---

## @DataJpaTest Configuration

`@DataJpaTest` is a focused slice test that loads only JPA-related beans. Combined with Testcontainers, it provides fast, isolated repository tests.

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

---

## Transactional Test Isolation

Each test should run in isolation without leaving state that affects other tests. There are two patterns:

**Pattern 1: `@Transactional` on the test** — the test runs in a transaction that is rolled back after the test. This is the fastest approach. Its limitation: tests cannot verify behaviour that depends on transaction boundaries (commit-time constraint checks, `REQUIRES_NEW`, other threads or connections, deadlock handling) — work on other connections cannot even see the test's uncommitted rows.

**Pattern 2: `@Sql` truncation before each test** — explicitly clean up between tests. Use this when you need to test across transaction boundaries.

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

---

## Flyway Migration Testing

Every schema migration must be tested in isolation before it is merged. Test three things:
1. The migration applies cleanly to the current schema
2. The migration is reversible (or explicitly irreversible with justification)
3. Existing queries still work after the migration

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

---

## Property-Based Testing for Financial Invariants

Property-based testing generates hundreds of random inputs to verify invariants that must hold for all valid inputs. For financial systems, the most critical invariants are:

- Account balance is never negative (the service refuses overdrafts)
- Money is conserved: transfers move money but never create or destroy it
- The sum of all debit ledger entries equals the sum of all credit ledger entries (double-entry invariant)
- A payment's amount in the ledger matches the original authorised amount
- Status transitions are only forward (PENDING -> AUTHORISED -> SETTLED, never backward)

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

---

## Testing Concurrent Operations

Concurrency bugs are among the most dangerous in financial systems and the hardest to catch with sequential tests. Use multi-threaded tests with controlled timing to reproduce race conditions.

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

---

## Test Data Builders for Financial Entities

Readable test data builders prevent tests from being brittle and unreadable. The builder pattern allows tests to specify only the attributes relevant to the scenario being tested.

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

---

## Performance Testing Queries in the Test Suite

Include a performance test layer that verifies key queries execute within acceptable latency bounds, using realistic data volumes.

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

---

## Test Configuration with application-test.yml

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

---

## Key Takeaways

1. **Never use H2 or mocked repositories** for database integration tests in financial systems — schema differences, type handling, and locking behaviour differ critically from PostgreSQL.
2. **A singleton Testcontainers instance** (started once per JVM) amortises container startup — a few seconds — across the whole suite. `withReuse(true)` can additionally keep it between local runs, but is opt-in and not meant for CI.
3. **`@DataJpaTest` with `Replace.NONE`** is the right slice for repository-layer tests; `@SpringBootTest` for service-layer tests that cross transaction boundaries.
4. **Property-based tests** (jqwik) are more valuable than example-based tests for financial invariants — they generate edge cases you would not think to write manually.
5. **Concurrent tests with `CountDownLatch`** make race conditions far more likely by starting all threads at once — not certain, so repeat them, and never swallow unexpected exceptions.
6. **Test data builders** make tests self-documenting and resilient to schema evolution.
7. **EXPLAIN ANALYZE assertions** in tests prevent index regressions — if a migration drops an index, the performance test fails before production deployment.
8. **Flyway migration tests** must be part of the CI pipeline, not an afterthought — they catch incompatible schema changes before they reach production.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A test class annotated with @DataJpaTest uses the default configuration. A developer runs the tests and finds that a custom PostgreSQL-specific CHECK constraint is silently ignored. What is the root cause and the correct fix?",
      "options": [
        "@DataJpaTest auto-configures an H2 in-memory database which does not support PostgreSQL CHECK constraint syntax; fix by adding @AutoConfigureTestDatabase(replace = Replace.NONE) and providing a Testcontainers PostgreSQL datasource",
        "The CHECK constraint needs to be annotated with @Column(columnDefinition = ...) to be picked up by the test slice",
        "JPA ignores CHECK constraints by design; use a @PrePersist listener instead",
        "Add spring.jpa.hibernate.ddl-auto=validate to force constraint validation in tests"
      ],
      "correct": 0,
      "explanation": "@DataJpaTest by default replaces the configured datasource with an embedded H2 database. H2 either ignores or misinterprets PostgreSQL-specific DDL including CHECK constraints, custom types, and PostgreSQL functions. The fix is @AutoConfigureTestDatabase(replace = Replace.NONE) combined with a Testcontainers PostgreSQL container as the test datasource, which runs the actual Flyway migrations against real PostgreSQL."
    },
    {
      "text": "A property-based test using jqwik verifies that PaymentService.transfer(from, to, amount) never produces a negative balance. The test generates 1,000 random transfer scenarios. The test passes on the developer's laptop but fails intermittently in CI. What is the most likely cause?",
      "options": [
        "jqwik uses a different random seed in CI than on the developer's laptop",
        "The generated cases share database state: tries run one after another, but rows left behind by earlier tries (or by other test classes running in parallel against the same database in CI) change the balances a later try depends on",
        "jqwik is not compatible with Testcontainers in CI environments",
        "Property-based tests require a fixed @Seed annotation to be deterministic in CI"
      ],
      "correct": 1,
      "explanation": "jqwik runs the tries of a property sequentially, but every try writes committed data. If tries reuse the same accounts, or other test classes run in parallel against the same database in CI, a later try sees balances changed by someone else — results then depend on ordering and timing, which differ between laptop and CI. The fix is to give every try its own freshly created accounts (new UUIDs) and to assert only on those rows, or to isolate the database per test class. A fixed seed only makes the generated inputs repeatable; it does not remove shared state."
    },
    {
      "text": "A concurrent test uses CountDownLatch to verify that two simultaneous SELECT FOR UPDATE transactions on the same payment row do not both proceed — one must wait. The test creates two threads, both call latch.await() before executing the query, then releases the latch. The test passes locally but always passes even when the SELECT FOR UPDATE is accidentally removed. What is wrong with the test design?",
      "options": [
        "CountDownLatch does not work with database operations",
        "The test does not assert that one thread was blocked — it only asserts that both threads completed without exception, which also passes when there is no locking",
        "The two threads need to use different database connections for locking to work",
        "SELECT FOR UPDATE requires SERIALIZABLE isolation level to function correctly"
      ],
      "correct": 1,
      "explanation": "A test that only asserts no exceptions were thrown passes whether or not locking occurs. To correctly test SELECT FOR UPDATE serialisation, the test must assert the temporal ordering: thread 2 must not complete before thread 1 releases the lock. This requires capturing timestamps or using a second CountDownLatch that thread 1 signals only after completing its transaction, then asserting that thread 2's start time is after thread 1's commit time."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Comprehensive Database Test Suite with Testcontainers",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Configure a shared Testcontainers PostgreSQL instance for the entire test suite using the singleton pattern: a static container on an abstract base class, started once in a static initializer (not a @Container field), with @ServiceConnection or @DynamicPropertySource for the Spring datasource. Verify that the same container is used by two test classes by checking that both see the same Docker container ID. Add a Flyway migration test that asserts all migrations in db/migration apply cleanly from V1 to current version."
    },
    {
      "id": "2",
      "description": "Write a property-based test using jqwik (with jqwik-spring / @JqwikSpringSupport) for PaymentService.transfer(UUID from, UUID to, BigDecimal amount) that verifies three invariants across 500 generated scenarios: (a) the sum of all account balances is preserved, (b) no account balance goes below zero, (c) the transfer is idempotent given the same idempotency key. Use @ForAll @BigRange(min = 1, max = 10000) for amounts and ensure each scenario uses isolated accounts to avoid inter-scenario interference."
    },
    {
      "id": "3",
      "description": "Write a concurrent test that verifies SELECT FOR UPDATE prevents double-spending: 10 threads each attempt to debit the same account for 100 units when the balance is 500 (meaning at most 5 should succeed). Use CountDownLatch to synchronise thread start. Assert that exactly 5 threads succeed and exactly 5 receive InsufficientFundsException. Assert that the final balance is exactly 0. The test must be deterministic across 10 runs."
    },
    {
      "id": "4",
      "description": "Add an EXPLAIN ANALYZE assertion test: after running CREATE INDEX CONCURRENTLY on (account_id, created_at) for a payments table, execute a query SELECT * FROM payments WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10 and capture the EXPLAIN (ANALYZE, FORMAT JSON) output. Assert that the plan contains 'Index Scan' (not 'Seq Scan') and that the actual total time is under 5ms on a dataset of 100,000 rows. This test should fail if a future migration drops the index."
    }
  ]
}
-->
