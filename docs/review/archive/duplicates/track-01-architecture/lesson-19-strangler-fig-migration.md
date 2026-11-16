---
id: track-01-lesson-19
title: "Strangler Fig and Incremental Migration Patterns"
slug: strangler-fig-migration
track: track-01
trackName: "Financial Services Architecture"
sequence: 19
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [strangler-fig, migration, legacy-modernisation, anti-corruption-layer, proxy]
prerequisites: []
---

# Strangler Fig and Incremental Migration Patterns

> [!NOTE]
> Rewriting a core banking system in a single "big bang" cutover is one of the most reliable ways to cause a production incident that makes the financial press. The strangler fig pattern — incrementally replacing a legacy system while keeping it running — is how mature engineering teams at financial institutions deliver modernisation without the existential risk of a full cutover.

## Why Big-Bang Rewrites Fail in Financial Services

Legacy core banking systems — often COBOL-based, running on IBM mainframes, with 30+ years of business logic embedded in them — cannot be simply replaced. The failure modes of attempted big-bang rewrites are well-documented:

- **Data migration errors**: Subtle differences in decimal precision, currency rounding, and date handling cause balance discrepancies
- **Hidden business rules**: Undocumented edge cases in the legacy system only surface under production load from real customers
- **Integration complexity**: Hundreds of downstream integrations, batch jobs, and regulatory reports all depend on existing data formats
- **Regulatory continuity**: Regulators require that the new system produce identical audit trails to the legacy system during the transition period

The **strangler fig** metaphor (from Martin Fowler) describes how a fig tree grows around an existing tree, eventually replacing it entirely while the original tree provides structural support. In software: new functionality is built in the new system, and old functionality is migrated piece by piece, until the legacy system is left with nothing to do.

```
Strangler Fig Migration — Architecture Evolution:

Phase 1: Proxy in front, all traffic to legacy
  Client --> [Strangler Proxy] --> [Legacy Core Banking]

Phase 2: New features in new system, legacy for existing
  Client --> [Strangler Proxy] --> [Legacy Core Banking]  (existing flows)
                              --> [New Payment Service]   (new flows)

Phase 3: Migrated flows redirect to new system
  Client --> [Strangler Proxy] --> [New Payment Service]  (migrated)
                              --> [Legacy Core Banking]   (remaining)

Phase 4: Legacy decommissioned
  Client --> [New Payment Service]
```

---

## The Strangler Proxy

The first step in a strangler fig migration is placing a proxy in front of the legacy system. All traffic flows through the proxy; initially it forwards everything to legacy unchanged.

```java
// src/main/java/com/fintech/migration/proxy/StranglerFigProxy.java
package com.fintech.migration.proxy;

import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class StranglerFigRoutingConfig {

    private final FeatureFlagService featureFlags;
    private final MigrationStateRepository migrationState;

    public StranglerFigRoutingConfig(FeatureFlagService featureFlags,
                                      MigrationStateRepository migrationState) {
        this.featureFlags   = featureFlags;
        this.migrationState = migrationState;
    }

    @Bean
    public RouteLocator stranglerRoutes(RouteLocatorBuilder builder) {
        return builder.routes()

            // Payments: route to new service if payment module migrated
            .route("payment-new", r -> r
                .path("/api/v1/payments/**")
                .and()
                .predicate(exchange ->
                    featureFlags.isEnabled("payment-service-migration",
                                           getCustomerId(exchange))
                )
                .uri("lb://new-payment-service")
            )

            // Accounts: route to new service for newly-opened accounts
            .route("account-new", r -> r
                .path("/api/v1/accounts/**")
                .and()
                .predicate(exchange ->
                    isAccountMigratedToNewSystem(exchange)
                )
                .uri("lb://new-account-service")
            )

            // Default: all other traffic to legacy core banking system
            .route("legacy-fallback", r -> r
                .path("/**")
                .uri("http://legacy-corebanking:8080")
            )

            .build();
    }

    private boolean isAccountMigratedToNewSystem(
            org.springframework.web.server.ServerWebExchange exchange) {
        String accountId = extractAccountId(exchange);
        if (accountId == null) return false;
        return migrationState.isAccountMigrated(accountId);
    }
}
```

### Custom Routing Filter for Per-Customer Migration

```java
@Component
public class CustomerMigrationRoutingFilter implements GlobalFilter, Ordered {

    private static final String ROUTE_TO_NEW_SYSTEM = "X-Route-New-System";

    private final CustomerMigrationRegistry migrationRegistry;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String customerId = extractCustomerId(exchange.getRequest());
        String endpoint   = exchange.getRequest().getPath().value();

        MigrationStatus status = migrationRegistry.getStatus(customerId, endpoint);

        ServerWebExchange modifiedExchange = exchange.mutate()
            .request(r -> r.header(ROUTE_TO_NEW_SYSTEM,
                                    String.valueOf(status.isOnNewSystem())))
            .build();

        return chain.filter(modifiedExchange);
    }

    @Override
    public int getOrder() {
        return -100;  // Run before routing decisions
    }
}
```

---

## Branch by Abstraction

For migrating internal service dependencies, **branch by abstraction** allows the new implementation to live alongside the old one, controlled by a feature flag.

```java
// Step 1: Extract an abstraction over the legacy behaviour
public interface PaymentProcessor {
    PaymentResult processPayment(PaymentRequest request);
    PaymentStatus getPaymentStatus(String paymentId);
    List<Payment> getPaymentHistory(String accountId, DateRange range);
}
```

```java
// Step 2: Wrap legacy system behind the abstraction
@Component("legacyPaymentProcessor")
public class LegacyPaymentProcessorAdapter implements PaymentProcessor {

    private final LegacyCoreSystemClient legacyClient;

    @Override
    public PaymentResult processPayment(PaymentRequest request) {
        // Translate modern request model to legacy XML/COBOL record format
        LegacyPaymentRecord legacyRecord = toLegacyFormat(request);
        LegacyResponse response = legacyClient.submitPayment(legacyRecord);
        return fromLegacyFormat(response);
    }

    private LegacyPaymentRecord toLegacyFormat(PaymentRequest request) {
        // Legacy system uses fixed-width decimal strings, not BigDecimal
        return LegacyPaymentRecord.builder()
            .paymentRef(request.paymentId())
            .debitAccount(request.sourceAccountNumber())
            .creditAccount(request.destinationAccountNumber())
            // Legacy stores amounts as pence/cents (integer), not decimals
            .amountMinorUnits(
                request.amount()
                        .multiply(BigDecimal.valueOf(100))
                        .longValueExact()
            )
            .currencyCode(request.currency())
            .valueDate(request.requestedValueDate()
                               .format(DateTimeFormatter.ofPattern("yyyyMMdd")))
            .build();
    }
}
```

```java
// Step 3: Build the new implementation
@Component("modernPaymentProcessor")
public class ModernPaymentProcessor implements PaymentProcessor {

    private final PaymentRepository    paymentRepository;
    private final LedgerService        ledgerService;
    private final FraudCheckService    fraudCheckService;

    @Override
    public PaymentResult processPayment(PaymentRequest request) {
        FraudAssessment fraud = fraudCheckService.assess(request);
        if (fraud.isDeclined()) {
            return PaymentResult.declined(request.paymentId(), fraud.reason());
        }

        Payment payment = paymentRepository.save(Payment.from(request));
        ledgerService.postDoubleEntry(payment);

        return PaymentResult.submitted(payment.id(), payment.status());
    }
}
```

```java
// Step 4: Feature-flag-driven selection between implementations
@Service
public class PaymentProcessorFacade implements PaymentProcessor {

    private final PaymentProcessor  legacy;
    private final PaymentProcessor  modern;
    private final FeatureFlagService flags;

    public PaymentProcessorFacade(
            @Qualifier("legacyPaymentProcessor") PaymentProcessor legacy,
            @Qualifier("modernPaymentProcessor")  PaymentProcessor modern,
            FeatureFlagService flags) {
        this.legacy = legacy;
        this.modern = modern;
        this.flags  = flags;
    }

    @Override
    public PaymentResult processPayment(PaymentRequest request) {
        if (flags.isEnabled("use-modern-payment-processor",
                             request.customerId())) {
            return modern.processPayment(request);
        }
        return legacy.processPayment(request);
    }
}
```

---

## Anti-Corruption Layer

When the new system must coexist with the legacy system, an **anti-corruption layer (ACL)** insulates the new domain model from leaking legacy concepts.

```java
// The legacy system has a deeply problematic "Account" model that conflates
// customer identity, accounts, and products. The ACL translates between worlds.
@Component
public class LegacyAccountAntiCorruptionLayer {

    private final LegacyCoreClient legacyClient;

    /**
     * Translate a legacy "CUST_ACCT" record (which mixes customer + account data)
     * into the clean domain model used by the new account service.
     */
    public Account translateLegacyAccount(String legacyAccountRef) {
        LegacyCustAcctRecord legacyRecord =
            legacyClient.getCustAcct(legacyAccountRef);

        // Legacy uses numeric codes for account types; new system uses enums
        AccountType accountType = switch (legacyRecord.getProductCode()) {
            case "CUR001", "CUR002" -> AccountType.CURRENT;
            case "SAV001", "SAV002" -> AccountType.SAVINGS;
            case "LOAN01"           -> AccountType.LOAN;
            case "MORT01"           -> AccountType.MORTGAGE;
            default -> throw new UnknownLegacyProductCodeException(
                legacyRecord.getProductCode());
        };

        // Legacy stores IBAN without spaces; new model normalises to formatted IBAN
        String iban = IbanUtils.format(legacyRecord.getIbanRaw());

        // Legacy stores balance as signed integer (pence); new system uses BigDecimal
        BigDecimal balance = BigDecimal.valueOf(legacyRecord.getBalancePence())
                                        .movePointLeft(2);

        return Account.builder()
            .id(UUID.nameUUIDFromBytes(legacyRecord.getAccountRef().getBytes()))
            .legacyRef(legacyRecord.getAccountRef())
            .iban(iban)
            .currency(Currency.getInstance(legacyRecord.getCurrencyIso()))
            .accountType(accountType)
            .balance(balance)
            .status(translateStatus(legacyRecord.getStatusFlag()))
            .customerId(legacyRecord.getCustomerNumber())
            .build();
    }

    private AccountStatus translateStatus(char legacyStatusFlag) {
        return switch (legacyStatusFlag) {
            case 'A' -> AccountStatus.ACTIVE;
            case 'D' -> AccountStatus.DORMANT;
            case 'S' -> AccountStatus.SUSPENDED;
            case 'C' -> AccountStatus.CLOSED;
            default  -> throw new UnknownLegacyStatusException(legacyStatusFlag);
        };
    }
}
```

---

## Dual-Run Strategy (Shadow Mode)

Before completing a migration, run both systems in parallel and compare outputs. This validates the new system without putting real transactions at risk.

```java
@Component
public class DualRunPaymentProcessor {

    private final PaymentProcessor legacy;
    private final PaymentProcessor modern;
    private final DualRunComparisonService comparisonService;
    private final FeatureFlagService       flags;
    private final MeterRegistry            metrics;

    /**
     * Shadow mode: execute on legacy (authoritative), also execute on modern,
     * compare results, log discrepancies. No impact on actual outcomes.
     */
    public PaymentResult processWithShadow(PaymentRequest request) {
        // Execute legacy — this is the authoritative result
        PaymentResult legacyResult = legacy.processPayment(request);

        if (!flags.isEnabled("shadow-modern-payment-processor")) {
            return legacyResult;
        }

        // Execute modern in background — do not block on result
        CompletableFuture.runAsync(() -> {
            try {
                PaymentResult modernResult = modern.processPayment(
                    request.withIdempotencyKey(request.paymentId() + ":shadow")
                );
                comparisonService.compare(request, legacyResult, modernResult);
            } catch (Exception ex) {
                metrics.counter("dual_run.modern.error",
                                 "type", ex.getClass().getSimpleName())
                        .increment();
                log.error("Modern processor shadow run failed for {}: {}",
                           request.paymentId(), ex.getMessage());
            }
        }, shadowExecutor);

        return legacyResult;
    }
}
```

```java
@Service
public class DualRunComparisonService {

    private static final Logger log =
        LoggerFactory.getLogger(DualRunComparisonService.class);

    private final DualRunDiscrepancyRepository discrepancyRepo;
    private final MeterRegistry                metrics;

    public void compare(PaymentRequest request,
                         PaymentResult legacy,
                         PaymentResult modern) {
        List<String> discrepancies = new ArrayList<>();

        // Status must match
        if (!legacy.status().equals(modern.status())) {
            discrepancies.add("status: legacy=%s modern=%s"
                .formatted(legacy.status(), modern.status()));
        }

        // For completed payments, amounts must match exactly
        if (legacy.status() == PaymentStatus.COMPLETED
                && modern.status() == PaymentStatus.COMPLETED) {
            if (legacy.processedAmount().compareTo(modern.processedAmount()) != 0) {
                discrepancies.add("amount: legacy=%s modern=%s"
                    .formatted(legacy.processedAmount(),
                               modern.processedAmount()));
            }
        }

        if (!discrepancies.isEmpty()) {
            metrics.counter("dual_run.discrepancy").increment();
            log.warn("Dual-run discrepancy for payment {}: {}",
                      request.paymentId(), discrepancies);

            discrepancyRepo.save(DualRunDiscrepancy.builder()
                .paymentId(request.paymentId())
                .customerId(request.customerId())
                .discrepancies(discrepancies)
                .legacyResult(legacy)
                .modernResult(modern)
                .detectedAt(Instant.now())
                .build());
        } else {
            metrics.counter("dual_run.match").increment();
        }
    }
}
```

---

## Database Migration Strategy

One of the hardest parts of core banking migration is moving data while keeping both systems operational.

### Synchronous Write-Through

During migration, write to both databases simultaneously and read from the system-of-record for each account segment:

```java
@Service
public class DualWriteAccountRepository {

    private final LegacyAccountDao    legacyDao;
    private final ModernAccountRepo   modernRepo;
    private final MigrationStateRepo  migrationState;

    /**
     * Write to both systems. Modern is the system-of-record for migrated accounts;
     * legacy remains system-of-record for non-migrated accounts.
     */
    @Transactional
    public Account save(Account account) {
        boolean isMigrated = migrationState.isAccountMigrated(account.id());

        if (isMigrated) {
            // Modern is the source of truth; write to legacy for data consistency
            Account saved = modernRepo.save(account);
            try {
                legacyDao.update(toLegacyRecord(account));
            } catch (Exception ex) {
                // Log and alert but don't fail — legacy will be decommissioned
                log.error("Legacy write-through failed for account {}: {}",
                           account.id(), ex.getMessage());
                metrics.counter("legacy.write_through.failure").increment();
            }
            return saved;
        } else {
            // Legacy is source of truth; write to modern for pre-migration syncing
            LegacyCustAcctRecord legacyRecord = legacyDao.save(toLegacyRecord(account));
            try {
                modernRepo.save(fromLegacyRecord(legacyRecord));
            } catch (Exception ex) {
                log.error("Modern write-through failed for account {}: {}",
                           account.id(), ex.getMessage());
                metrics.counter("modern.write_through.failure").increment();
            }
            return fromLegacyRecord(legacyRecord);
        }
    }

    public Account findById(String accountId) {
        boolean isMigrated = migrationState.isAccountMigrated(accountId);
        return isMigrated
            ? modernRepo.findById(accountId).orElseThrow()
            : fromLegacyRecord(legacyDao.findByAccountId(accountId));
    }
}
```

### Batch Migration with Consistency Validation

```sql
-- Track migration state per account
CREATE TABLE account_migration_state (
    account_id          VARCHAR(50)  PRIMARY KEY,
    legacy_ref          VARCHAR(50)  NOT NULL,
    migration_phase     VARCHAR(50)  NOT NULL DEFAULT 'NOT_STARTED',
    -- NOT_STARTED, DATA_COPIED, SHADOW_RUNNING, MIGRATED, ROLLED_BACK
    data_copied_at      TIMESTAMPTZ,
    shadow_started_at   TIMESTAMPTZ,
    migrated_at         TIMESTAMPTZ,
    rolled_back_at      TIMESTAMPTZ,
    validation_errors   JSONB,
    last_updated        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Validation: compare balances between legacy and modern after data copy
CREATE OR REPLACE FUNCTION validate_account_migration(p_account_id VARCHAR)
RETURNS TABLE (
    check_name   VARCHAR,
    legacy_value TEXT,
    modern_value TEXT,
    match        BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        'balance_match'::VARCHAR,
        l.balance::TEXT,
        m.available_balance::TEXT,
        ABS(l.balance - m.available_balance) < 0.01
    FROM legacy_accounts l
    JOIN accounts m ON m.legacy_ref = l.account_ref
    WHERE l.account_ref = (
        SELECT legacy_ref FROM account_migration_state
        WHERE account_id = p_account_id
    );
END;
$$ LANGUAGE plpgsql;
```

---

## Feature Toggles During Migration

```java
// Feature flag configuration backed by database for dynamic control
@Service
public class FeatureFlagService {

    private final FeatureFlagRepository flagRepo;
    private final LoadingCache<String, FeatureFlag> cache;

    public FeatureFlagService(FeatureFlagRepository flagRepo) {
        this.flagRepo = flagRepo;
        this.cache    = Caffeine.newBuilder()
            .expireAfterWrite(Duration.ofSeconds(30))  // 30s cache TTL
            .build(key -> flagRepo.findByName(key).orElse(FeatureFlag.disabled()));
    }

    /**
     * Check flag with percentage rollout and customer-segment targeting.
     * This enables migrating 1% of customers first, then 5%, 10%, 50%, 100%.
     */
    public boolean isEnabled(String flagName, String customerId) {
        FeatureFlag flag = cache.get(flagName);
        if (!flag.enabled()) return false;

        // Explicit allow/deny list takes priority
        if (flag.allowedCustomerIds().contains(customerId)) return true;
        if (flag.deniedCustomerIds().contains(customerId))  return false;

        // Percentage rollout based on consistent hash of customer ID
        // Same customer always gets the same result for a given percentage
        int bucket = Math.abs(customerId.hashCode() % 100);
        return bucket < flag.rolloutPercentage();
    }
}
```

```sql
CREATE TABLE feature_flags (
    name                VARCHAR(200)  PRIMARY KEY,
    enabled             BOOLEAN       NOT NULL DEFAULT FALSE,
    rollout_percentage  INTEGER       NOT NULL DEFAULT 0 CHECK (rollout_percentage BETWEEN 0 AND 100),
    allowed_customer_ids TEXT[],
    denied_customer_ids  TEXT[],
    description         TEXT,
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_by          VARCHAR(100)
);

-- Audit log of feature flag changes
CREATE TABLE feature_flag_audit (
    id              BIGSERIAL    PRIMARY KEY,
    flag_name       VARCHAR(200) NOT NULL,
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    changed_by      VARCHAR(100),
    old_value       JSONB,
    new_value       JSONB
);
```

---

## Monitoring a Dual-Run Migration

Observability during migration is critical. You need to know at all times:
- What percentage of traffic is on the new system?
- Are dual-run results matching?
- Is the new system performing better or worse than legacy?

```java
@Component
public class MigrationMetricsCollector {

    private final MeterRegistry metrics;

    @Scheduled(fixedDelay = 60_000)
    public void collectMigrationMetrics() {
        MigrationSummary summary = migrationStateRepo.getSummary();

        // Traffic distribution
        metrics.gauge("migration.accounts.total",     summary.totalAccounts());
        metrics.gauge("migration.accounts.migrated",  summary.migratedAccounts());
        metrics.gauge("migration.accounts.shadow",    summary.shadowRunningAccounts());
        metrics.gauge("migration.accounts.legacy",    summary.legacyOnlyAccounts());

        double migrationPct = (double) summary.migratedAccounts()
                              / summary.totalAccounts() * 100;
        metrics.gauge("migration.progress.percent", migrationPct);

        // Dual-run health
        metrics.gauge("migration.dual_run.match_rate",
                       summary.dualRunMatchRate());
        metrics.gauge("migration.dual_run.discrepancy_count_24h",
                       summary.discrepanciesLast24Hours());
    }
}
```

Alerting rules (Prometheus format):

```yaml
# prometheus/alerts/migration.yml
groups:
  - name: migration
    rules:
      - alert: DualRunDiscrepancyRateHigh
        expr: rate(dual_run_discrepancy_total[5m]) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Dual-run discrepancy rate above 1% — halt migration rollout"

      - alert: LegacyWriteThroughFailureHigh
        expr: rate(legacy_write_through_failure_total[5m]) > 0.001
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Legacy write-through failures — data may diverge"
```

---

## Rollback Strategy

Every migration step must have a tested rollback path:

```java
@Service
public class MigrationRollbackService {

    private final MigrationStateRepo  migrationState;
    private final FeatureFlagService  featureFlags;
    private final EventPublisher      eventPublisher;

    /**
     * Emergency rollback: revert a batch of accounts to legacy system-of-record.
     * This is a last-resort operation — data synced during shadow running
     * ensures legacy is current enough to take over.
     */
    @Transactional
    public RollbackResult rollbackSegment(String segment,
                                           String reason,
                                           String authorisedBy) {
        log.warn("MIGRATION ROLLBACK initiated for segment {} by {}: {}",
                  segment, authorisedBy, reason);

        List<String> accountIds = migrationState
            .findMigratedAccountsBySegment(segment);

        // Disable feature flag for this segment first (immediate effect)
        featureFlags.disableForSegment("use-modern-payment-processor", segment);

        // Mark accounts as rolled back in migration state
        int rolledBack = migrationState.markRolledBack(accountIds, reason);

        // Publish event for ops team and audit trail
        eventPublisher.publish(new MigrationRolledBackEvent(
            segment, accountIds.size(), reason, authorisedBy, Instant.now()
        ));

        metrics.counter("migration.rollback.accounts",
                         "segment", segment)
                .increment(rolledBack);

        return new RollbackResult(segment, rolledBack, Instant.now());
    }
}
```

---

## Common Pitfalls

**1. Not Putting the Proxy In Place Before Starting**
Teams often start by building the new system and only add the proxy later. The proxy must be in production — even if it forwards 100% of traffic to legacy — before any migration work starts. It is the control plane for the entire migration.

**2. Underestimating the Anti-Corruption Layer Complexity**
Legacy banking systems contain decades of business logic embedded in data encodings, status flags, and product codes. The ACL translation layer will contain more code than teams expect. Budget significant engineering effort for it, and test it exhaustively against production data samples.

**3. Migrating Data and Behaviour at the Same Time**
Data migration and behavioural migration are separate concerns. First migrate the data model (while keeping legacy as system-of-record), validate data equivalence, then switch behaviour. Doing both simultaneously doubles the risk.

**4. Insufficient Dual-Run Duration**
Month-end, quarter-end, and year-end processing patterns in banking systems will not appear in a one-week dual run. Run shadow mode across at least one full statement cycle (usually monthly) before cutting over.

**5. No Emergency Stop Mechanism**
Every feature flag in a migration must be reachable by an operations engineer at 2 AM without a code deployment. If the rollback path requires a deployment or a database migration, it is not a real rollback path.

---

## Production Tips

**Migrate by Customer Cohort, Not by Feature**
Migrating "all payment submissions" for all customers at once is a large blast radius. Instead, migrate a cohort of 1,000 low-risk customers completely across all features, validate, then expand. This isolates impact and builds confidence.

**Keep Legacy Running for 90 Days After Full Cutover**
Even after 100% of traffic is on the new system, do not decommission the legacy system for at least 90 days. Edge cases involving backdated transactions, corrections, and long-running batch jobs may still reference legacy data.

**Use Database-Backed Feature Flags, Not Config Files**
Feature flags that require a service restart to change are not feature flags — they are configuration. Flags controlling a live migration must be changeable in real time by operations engineers without any deployment.

**Automate Migration State Reconciliation**
Run an hourly job that reconciles account balances between legacy and modern systems for all dual-write accounts. Alert immediately on any discrepancy greater than £0.01. Silent data drift is the most dangerous failure mode.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why must the strangler proxy be deployed to production before any migration work begins, even if it initially forwards 100% of traffic to the legacy system?",
      "options": [
        "The proxy is required to decrypt TLS traffic from clients before it can be inspected and routed.",
        "The proxy is the control plane for the entire migration — it must be in production before any traffic can be selectively redirected to the new system.",
        "Regulators require a proxy layer for all payment systems processing above a minimum transaction volume threshold.",
        "The proxy enables dual-write mode, which is required before any data migration can begin."
      ],
      "correct": 1,
      "explanation": "The proxy is the migration control plane. Without it in place, there is no mechanism to selectively route traffic to the new system, roll back individual customer segments, or monitor the migration. Teams that add the proxy after starting migration work lose the ability to incrementally redirect and roll back — the most dangerous pitfall identified in this lesson."
    },
    {
      "text": "During a dual-run migration, the DualRunComparisonService detects a discrepancy: the legacy system returns COMPLETED status for payment PAY-001 but the modern system returns PENDING. What should happen?",
      "options": [
        "The modern system's result should be used as the authoritative answer because it is the target system.",
        "The discrepancy should be logged and alerted, the legacy result should remain authoritative, and the incident should be investigated before expanding the migration rollout.",
        "The payment should be marked as FAILED in both systems to prevent an inconsistent state from reaching customers.",
        "The migration should immediately be rolled back for all accounts, not just the affected customer segment."
      ],
      "correct": 1,
      "explanation": "During shadow mode, the legacy system is authoritative — the modern system's result is for comparison only. Discrepancies must be logged, alerted, and investigated before expanding the rollout. If the discrepancy rate exceeds 1% (the alert threshold), the migration rollout should be halted. The dual-run comparison service exists precisely to find these discrepancies before the new system handles real traffic."
    },
    {
      "text": "A team decides to migrate data and behaviour simultaneously — switching both the data model and the routing to the new system in the same migration step. Why is this more risky than separating the two concerns?",
      "options": [
        "Simultaneous migration is technically impossible because the strangler proxy cannot route to a system that is also changing its data model.",
        "Doing both simultaneously doubles the blast radius — a data model issue and a behavioural issue occurring together are harder to diagnose, and rolling back requires reverting two independent changes at once.",
        "The dual-run comparison service cannot operate during data model migrations because the field mappings change at the same time.",
        "Regulators require a minimum 30-day separation between data migration and behavioural migration for all core banking system changes."
      ],
      "correct": 1,
      "explanation": "Data migration and behavioural migration are separate risk surfaces. Combining them means a problem in either dimension affects the combined migration step, doubles the diagnostic complexity, and makes rollback harder because two independent changes must be simultaneously reverted. Best practice is to migrate the data model first (keeping legacy as system-of-record), validate data equivalence, then switch behaviour."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement a Strangler Fig Migration for a Core Banking Payment System",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a Spring Cloud Gateway StranglerFigRoutingConfig that routes payment API traffic to the new payment service when a customer-level feature flag is enabled, routes account API traffic to the new account service for migrated accounts (determined by a MigrationStateRepository), and falls back to the legacy core banking system for all other traffic. Write a custom GlobalFilter that adds the migration routing decision as a request header for observability."},
    {"id": "2", "description": "Implement the branch-by-abstraction pattern for a PaymentProcessor interface. Write LegacyPaymentProcessorAdapter (wrapping a COBOL-era SOAP client that uses integer pence amounts and DrCrIndicator fields) and ModernPaymentProcessor (using the domain model from lesson 05). Write PaymentProcessorFacade that selects between the two implementations based on a customer-level feature flag. Write unit tests for the facade verifying both routing paths and correct translation in the legacy adapter."},
    {"id": "3", "description": "Implement a DualRunPaymentProcessor that executes the legacy processor as authoritative and the modern processor asynchronously in shadow mode. Write a DualRunComparisonService that compares payment status and processed amount, logs discrepancies, persists them to a DualRunDiscrepancy table, and increments a Micrometer counter. Write a Prometheus alerting rule that fires when the discrepancy rate exceeds 1% over a 5-minute window."},
    {"id": "4", "description": "Design and implement the account_migration_state table schema with phases NOT_STARTED, DATA_COPIED, SHADOW_RUNNING, MIGRATED, and ROLLED_BACK. Write a MigrationRollbackService that disables the feature flag for a customer segment, marks accounts as rolled back, and publishes a MigrationRolledBackEvent. Write a PostgreSQL function validate_account_migration that compares balances between legacy and modern tables and returns a table of check results. Write a test verifying that rollback for one segment does not affect other migrated segments."}
  ]
}
-->
