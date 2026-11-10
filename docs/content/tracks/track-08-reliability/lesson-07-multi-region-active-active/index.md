---
id: track-08-lesson-07
title: "Multi-Region Active-Active Architecture"
slug: multi-region-active-active
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 7
difficulty: principal
estimatedMinutes: 90
status: published
tags: [active-active, multi-region, geo-replication, conflict-resolution, latency]
prerequisites: []
---

# Multi-Region Active-Active Architecture

> [!NOTE]
> Active-active is not a deployment pattern — it is a data architecture decision. You can deploy services in multiple regions in minutes. Making the data layer globally consistent and conflict-free takes months of careful design.

## 1. Active-Active vs Active-Passive

| Dimension | Active-Passive | Active-Active |
|---|---|---|
| Traffic handling | One region handles all traffic | All regions handle traffic |
| Failover time | 30s–5min (automated) | Near-zero (traffic rerouting) |
| Data writes | Single primary | Multiple concurrent primaries |
| Conflict risk | None (single write path) | High (must design for it) |
| Cost | 1x + warm standby overhead | ~2x (full capacity in each region) |
| RTO | Minutes | Seconds |
| RPO | Seconds (async replication) | Near-zero |
| Use case | Most financial services | High-availability critical paths |

For most payment services, active-passive with automated failover achieves a satisfactory RTO/RPO. Active-active is warranted for:
- Payment systems requiring near-zero RTO (global card networks)
- Read-heavy workloads that can tolerate eventual consistency (transaction history)
- Latency-sensitive operations requiring geographic routing (FX trading)

## 2. Global Load Balancing

```java
/**
 * Geographic routing strategy for multi-region payment processing.
 * Requests are routed to the nearest healthy region.
 * Failover is automatic when health checks fail.
 */
@Configuration
public class GlobalRoutingConfig {

    /**
     * AWS Route 53 or Cloudflare-based routing is handled at infrastructure level.
     * At the application level, we implement region affinity for session continuity.
     *
     * Payment sessions should stick to one region to avoid cross-region
     * read-after-write inconsistency during a payment flow.
     */
    @Bean
    public RegionAffinityFilter regionAffinityFilter() {
        return new RegionAffinityFilter();
    }
}

@Component
public class RegionAffinityFilter extends OncePerRequestFilter {

    private static final String REGION_HEADER = "X-Processing-Region";
    private static final String REGION_COOKIE = "pmt-region";

    @Value("${cloud.aws.region.static}")
    private String currentRegion;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                     HttpServletResponse response,
                                     FilterChain filterChain)
            throws ServletException, IOException {
        // Tag response with processing region for client-side affinity
        response.setHeader(REGION_HEADER, currentRegion);
        response.addCookie(buildRegionCookie(currentRegion));
        filterChain.doFilter(request, response);
    }

    private Cookie buildRegionCookie(String region) {
        Cookie cookie = new Cookie(REGION_COOKIE, region);
        cookie.setPath("/");
        cookie.setMaxAge(3600);  // 1 hour affinity window
        cookie.setSecure(true);
        cookie.setHttpOnly(true);
        return cookie;
    }
}
```

## 3. Data Replication Strategies

The hardest problem in active-active is data: writes in region A must reach region B before region B reads the same data, or region B might serve stale data.

```
Strategy 1: Global Single-Primary (Semi-Active-Active)
  - Reads: local region (fast, possibly stale)
  - Writes: always route to primary region
  - Latency: reads fast, writes add cross-region round trip
  - Consistency: strong (single write path)
  - Use for: account balances, payment final status

Strategy 2: Regional Partitioning
  - Each account "lives in" one region
  - That region is primary for that account's writes
  - Other regions are replicas for reads only
  - Consistency: strong within partition, eventual across
  - Use for: account management, payment history

Strategy 3: Multi-Primary with Conflict Resolution
  - Any region can write any record
  - Conflicts detected and resolved automatically
  - Consistency: eventual
  - Use for: idempotency keys, rate counters, audit logs
```

```java
/**
 * Account partition routing — each account has a home region.
 * Writes for that account go to home region; reads can be local.
 */
@Service
@RequiredArgsConstructor
public class AccountRegionRouter {

    private static final Map<String, String> REGION_ENDPOINTS = Map.of(
        "us-east-1", "https://payments-use1.example.com",
        "eu-west-1", "https://payments-euw1.example.com",
        "ap-southeast-1", "https://payments-apse1.example.com"
    );

    /**
     * Route write operations to the account's home region.
     * Account home region is determined by account ID prefix or
     * a consistent hash of account ID.
     */
    public String getHomeRegion(String accountId) {
        // Accounts are assigned to regions at creation time
        // Stored in a globally-replicated accounts metadata table
        return accountRegionCache.getRegion(accountId);
    }

    public boolean isLocalAccount(String accountId) {
        return currentRegion.equals(getHomeRegion(accountId));
    }

    /**
     * For non-local accounts, proxy the write to the home region.
     * This adds ~10–50ms latency for cross-region writes.
     */
    public PaymentResponse routePaymentWrite(PaymentRequest request) {
        String homeRegion = getHomeRegion(request.getDebitAccountId());
        if (isLocalAccount(request.getDebitAccountId())) {
            return localPaymentService.process(request);
        }
        // Forward to home region
        String homeEndpoint = REGION_ENDPOINTS.get(homeRegion);
        return crossRegionClient.forwardPayment(homeEndpoint, request);
    }
}
```

## 4. Conflict Resolution — Last-Write-Wins

The simplest conflict resolution strategy is last-write-wins (LWW) using a logical timestamp (Lamport clock or vector clock) rather than wall clock time.

```java
/**
 * Last-write-wins conflict resolution using vector clocks.
 * Each record carries a vector clock tracking causality across regions.
 */
@Entity
@Table(name = "account_preferences")
public class AccountPreference {

    @Id
    private UUID accountId;

    private String preferredCurrency;
    private String defaultPaymentMethod;
    private String notificationEmail;

    /**
     * Vector clock: maps region → logical timestamp.
     * Updated on every write in the writing region.
     * Used to determine which concurrent update "wins".
     */
    @Convert(converter = VectorClockConverter.class)
    @Column(name = "vector_clock", columnDefinition = "jsonb")
    private VectorClock vectorClock;

    @Column(name = "last_modified_at")
    private Instant lastModifiedAt;

    @Column(name = "last_modified_region")
    private String lastModifiedRegion;
}

@Service
@RequiredArgsConstructor
public class AccountPreferenceService {

    private final AccountPreferenceRepository repository;

    @Value("${cloud.aws.region.static}")
    private String currentRegion;

    public AccountPreference update(String accountId,
                                     AccountPreferenceUpdate update) {
        AccountPreference pref = repository.findById(UUID.fromString(accountId))
            .orElseGet(() -> new AccountPreference(UUID.fromString(accountId)));

        // Advance local region clock
        VectorClock newClock = pref.getVectorClock().increment(currentRegion);

        pref.setPreferredCurrency(update.getPreferredCurrency());
        pref.setVectorClock(newClock);
        pref.setLastModifiedAt(Instant.now());
        pref.setLastModifiedRegion(currentRegion);

        return repository.save(pref);
    }

    /**
     * Resolve conflict when replication brings in a concurrent update.
     * For account preferences, LWW by wall clock is acceptable
     * (losing a preference update is not a financial error).
     * For financial data, use a stricter strategy.
     */
    public AccountPreference resolveConflict(AccountPreference local,
                                              AccountPreference remote) {
        VectorClock.ComparisonResult comparison =
            local.getVectorClock().compareTo(remote.getVectorClock());

        return switch (comparison) {
            case BEFORE -> remote;    // Remote is strictly newer — use it
            case AFTER -> local;     // Local is strictly newer — keep it
            case CONCURRENT -> {
                // Concurrent updates — use last-modified timestamp as tiebreaker
                log.warn("Concurrent update conflict for accountId={} " +
                    "localRegion={} remoteRegion={}",
                    local.getAccountId(),
                    local.getLastModifiedRegion(),
                    remote.getLastModifiedRegion());
                yield local.getLastModifiedAt().isAfter(remote.getLastModifiedAt())
                    ? local : remote;
            }
            case EQUAL -> local;    // Identical — no conflict
        };
    }
}
```

## 5. CRDTs for Conflict-Free Distributed Counters

For financial counters (rate limits, daily limits, attempt counters), Conflict-free Replicated Data Types (CRDTs) allow concurrent increments from multiple regions without conflict.

```java
/**
 * G-Counter CRDT: each region maintains its own increment counter.
 * Total value = sum of all regional counters.
 * No conflict possible — each region only writes to its own slot.
 */
public class GCounter {

    // Map of region → count incremented by that region
    private final Map<String, Long> counters;

    public GCounter(Map<String, Long> counters) {
        this.counters = new HashMap<>(counters);
    }

    public static GCounter zero() {
        return new GCounter(Map.of());
    }

    /**
     * Increment counter for the local region.
     * Only the owning region should call this.
     */
    public GCounter increment(String region, long amount) {
        Map<String, Long> updated = new HashMap<>(counters);
        updated.merge(region, amount, Long::sum);
        return new GCounter(updated);
    }

    /**
     * Total value = sum across all regions.
     */
    public long value() {
        return counters.values().stream().mapToLong(Long::longValue).sum();
    }

    /**
     * Merge with another replica.
     * Take the maximum of each region's counter (since regions only increment).
     */
    public GCounter merge(GCounter other) {
        Map<String, Long> merged = new HashMap<>(counters);
        other.counters.forEach((region, count) ->
            merged.merge(region, count, Math::max));
        return new GCounter(merged);
    }
}

/**
 * Daily transaction limit enforced using G-Counter CRDT.
 * Each region tracks its own spend; total = sum across regions.
 * No coordination needed — merge handles eventual consistency.
 */
@Service
@RequiredArgsConstructor
public class DailyLimitService {

    private final DailyLimitRepository repository;

    @Value("${cloud.aws.region.static}")
    private String currentRegion;

    public boolean checkAndIncrement(String accountId,
                                      long amountCents,
                                      long dailyLimitCents) {
        DailyLimitRecord record = repository.findOrCreate(accountId, LocalDate.now());
        GCounter counter = record.getCounter();

        // Check current total (may be slightly stale for other regions)
        long currentTotal = counter.value();
        if (currentTotal + amountCents > dailyLimitCents) {
            return false;  // Limit would be exceeded
        }

        // Increment local region counter
        GCounter updated = counter.increment(currentRegion, amountCents);
        record.setCounter(updated);
        repository.save(record);
        return true;
    }
}
```

## 6. PostgreSQL Logical Replication for Multi-Region

```sql
-- On primary (us-east-1): create publication for payment tables
CREATE PUBLICATION payment_tables_pub
    FOR TABLE payments, accounts, audit_log
    WITH (publish = 'insert,update,delete');

-- On replica (eu-west-1): create subscription to primary
CREATE SUBSCRIPTION payment_tables_sub
    CONNECTION 'host=primary.use1.example.com port=5432 dbname=payments user=replicator password=...'
    PUBLICATION payment_tables_pub
    WITH (copy_data = true, synchronous_commit = 'remote_write');
```

```java
/**
 * Application-level replication lag monitoring.
 * Replication lag is the gap between primary and replica.
 * For payment systems, alert if lag exceeds 5 seconds.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ReplicationLagMonitor {

    private final DataSource primaryDataSource;
    private final DataSource replicaDataSource;
    private final MeterRegistry meterRegistry;

    @Scheduled(fixedDelay = 10_000)  // Every 10s
    public void measureReplicationLag() {
        try {
            // Write a heartbeat to primary
            Instant heartbeatTime = Instant.now();
            writeHeartbeat(primaryDataSource, heartbeatTime);

            // Read from replica and compare
            Instant replicaHeartbeat = readLatestHeartbeat(replicaDataSource);
            if (replicaHeartbeat != null) {
                long lagMs = Duration.between(replicaHeartbeat, heartbeatTime).toMillis();
                meterRegistry.gauge("postgresql.replication.lag.ms",
                    Tags.of("replica", "eu-west-1"), lagMs);

                if (lagMs > 5_000) {
                    log.warn("Replication lag HIGH: {}ms to eu-west-1", lagMs);
                }
                if (lagMs > 30_000) {
                    log.error("Replication lag CRITICAL: {}ms — routing reads to primary",
                        lagMs);
                    // Temporarily redirect reads to primary to avoid stale data
                    routingConfig.disableReplicaReads("eu-west-1");
                }
            }
        } catch (Exception e) {
            log.error("Failed to measure replication lag", e);
        }
    }

    /**
     * Query PostgreSQL's built-in replication lag view.
     */
    @Query(nativeQuery = true,
        value = "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000")
    Double getReplicationLagMs();
}
```

## 7. Regional Consistency Guarantees

```java
/**
 * Read consistency policy based on data criticality.
 *
 * STRONG: Always read from primary.
 *   - Used for: account balance before debit, fraud check state
 *   - Cost: cross-region latency for non-primary regions
 *
 * BOUNDED_STALENESS: Read from local replica if lag < threshold.
 *   - Used for: payment history, account metadata
 *   - Cost: possible stale reads up to threshold
 *
 * EVENTUAL: Always read from local replica.
 *   - Used for: exchange rate caches, notification preferences
 *   - Cost: possible stale reads (bounded by replication lag)
 */
public enum ConsistencyLevel {
    STRONG, BOUNDED_STALENESS, EVENTUAL
}

@Service
@RequiredArgsConstructor
public class ConsistencyAwareRepository {

    private final DataSource primaryDataSource;
    private final DataSource replicaDataSource;
    private final ReplicationLagMonitor lagMonitor;

    public Optional<Account> findAccount(String accountId,
                                          ConsistencyLevel consistency) {
        DataSource ds = switch (consistency) {
            case STRONG -> primaryDataSource;
            case BOUNDED_STALENESS -> {
                long lagMs = lagMonitor.getCurrentLagMs("eu-west-1");
                yield lagMs < 2_000 ? replicaDataSource : primaryDataSource;
            }
            case EVENTUAL -> replicaDataSource;
        };

        return new JdbcTemplate(ds).queryForObject(
            "SELECT * FROM accounts WHERE id = ?",
            accountRowMapper,
            UUID.fromString(accountId)
        );
    }
}
```

## 8. Failover Automation

```java
/**
 * Regional failover controller.
 * Monitors region health and triggers automatic failover.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RegionalFailoverController {

    private final RegionHealthChecker healthChecker;
    private final TrafficRouter trafficRouter;
    private final AlertingService alerting;

    private volatile String activeRegion = "us-east-1";
    private volatile FailoverState state = FailoverState.NORMAL;

    @Scheduled(fixedDelay = 15_000)  // Check every 15s
    public void checkAndFailover() {
        RegionHealth health = healthChecker.checkAllRegions();

        if (health.isPrimaryHealthy() && state == FailoverState.NORMAL) {
            return;  // All good
        }

        if (!health.isPrimaryHealthy() && state == FailoverState.NORMAL) {
            initiateFailover(health.getHealthyRegion());
        }

        if (health.isPrimaryHealthy() && state == FailoverState.FAILED_OVER) {
            initiateFailback();
        }
    }

    private void initiateFailover(String targetRegion) {
        log.error("PRIMARY REGION UNHEALTHY — initiating failover to {}",
            targetRegion);

        state = FailoverState.FAILING_OVER;

        // Alert team immediately
        alerting.page(PagerDutyAlert.critical(
            "Regional failover initiated to " + targetRegion));

        try {
            // 1. Stop writing to unhealthy primary
            trafficRouter.drainRegion(activeRegion);

            // 2. Wait for in-flight requests to complete (max 30s)
            trafficRouter.awaitDrain(activeRegion, Duration.ofSeconds(30));

            // 3. Route traffic to target region
            trafficRouter.activateRegion(targetRegion);
            activeRegion = targetRegion;
            state = FailoverState.FAILED_OVER;

            log.info("Failover complete — now serving from {}", targetRegion);
        } catch (Exception e) {
            log.error("Failover to {} failed!", targetRegion, e);
            state = FailoverState.NORMAL;
            alerting.page(PagerDutyAlert.critical("FAILOVER FAILED: " + e.getMessage()));
        }
    }

    private void initiateFailback() {
        log.info("Primary region healthy — initiating failback to us-east-1");
        // Failback is manual — requires ops approval to avoid oscillation
        alerting.notify("Primary region recovered — manual failback available");
    }
}
```

## 9. Latency Implications of Multi-Region

```
Inter-region latency (approximate AWS round trips):
  us-east-1 ↔ us-west-2:         ~65ms
  us-east-1 ↔ eu-west-1:        ~80ms
  us-east-1 ↔ ap-southeast-1:   ~230ms
  eu-west-1 ↔ ap-southeast-1:   ~170ms

Impact on payment processing:
  Strong consistency read (primary in us-east-1, user in eu-west-1):
    + 80ms round trip added to every read
    → Mitigate: regional partitioning (account lives in its nearest region)

  Cross-region write forwarding (home region routing):
    + 80ms for EU users paying from EU accounts via EU gateway
    → 0ms if account is home-region in EU

  Replication lag for async replica reads:
    → p99 replication lag: 50–200ms under normal conditions
    → p99 replication lag: 500ms–5s during batch settlement windows
    → Mitigate: bounded staleness routing + replication lag monitoring
```

```java
/**
 * Latency budget adjustment for multi-region operations.
 * Cross-region calls must account for inter-region round trip.
 */
@Component
public class MultiRegionLatencyBudget {

    private static final Map<String, Map<String, Duration>> REGION_LATENCIES = Map.of(
        "us-east-1", Map.of(
            "us-west-2", Duration.ofMillis(65),
            "eu-west-1", Duration.ofMillis(80),
            "ap-southeast-1", Duration.ofMillis(230)
        ),
        "eu-west-1", Map.of(
            "us-east-1", Duration.ofMillis(80),
            "ap-southeast-1", Duration.ofMillis(170)
        )
    );

    public Duration estimatedCrossRegionLatency(String sourceRegion,
                                                  String targetRegion) {
        return REGION_LATENCIES
            .getOrDefault(sourceRegion, Map.of())
            .getOrDefault(targetRegion, Duration.ofMillis(300)); // conservative default
    }

    /**
     * Adjust operation timeout to account for cross-region routing.
     */
    public Duration adjustedTimeout(Duration baseTimeout,
                                     String sourceRegion,
                                     String targetRegion) {
        if (sourceRegion.equals(targetRegion)) {
            return baseTimeout;
        }
        Duration overhead = estimatedCrossRegionLatency(sourceRegion, targetRegion)
            .multipliedBy(2);  // Round trip
        return baseTimeout.plus(overhead);
    }
}
```

## 10. Payment Routing Across Regions

```java
/**
 * Global payment router: determines which region should process a payment.
 * Considers: account home region, gateway availability, regulatory requirements.
 */
@Service
@RequiredArgsConstructor
public class GlobalPaymentRouter {

    private final AccountRegionRouter accountRouter;
    private final GatewayAvailabilityRegistry gatewayRegistry;
    private final RegulatoryRoutingPolicy regulatoryPolicy;

    public PaymentRoute determineRoute(PaymentRequest request) {
        // 1. Regulatory check: some transactions must stay in specific jurisdictions
        Optional<String> mandatedRegion = regulatoryPolicy.getMandatedRegion(request);
        if (mandatedRegion.isPresent()) {
            return PaymentRoute.of(mandatedRegion.get(),
                RoutingReason.REGULATORY_MANDATE);
        }

        // 2. Account home region (minimize cross-region write forwarding)
        String debitAccountRegion = accountRouter.getHomeRegion(
            request.getDebitAccountId());

        // 3. Check if home region gateway is available
        if (gatewayRegistry.isAvailable(debitAccountRegion)) {
            return PaymentRoute.of(debitAccountRegion,
                RoutingReason.ACCOUNT_HOME_REGION);
        }

        // 4. Home region gateway unavailable — find nearest healthy region
        String fallbackRegion = gatewayRegistry.getNearestHealthyRegion(
            debitAccountRegion);

        log.warn("Gateway unavailable in home region={}, routing to fallback={}",
            debitAccountRegion, fallbackRegion);

        return PaymentRoute.of(fallbackRegion, RoutingReason.GATEWAY_FAILOVER);
    }
}
```

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the fundamental challenge that makes active-active architecture difficult compared to active-passive?",
      "options": ["Higher infrastructure cost", "Concurrent writes to multiple primaries creating potential data conflicts", "More complex load balancing", "Higher network latency between regions"],
      "correct": 1,
      "explanation": "Active-passive has a single write path, so there are no concurrent write conflicts. Active-active allows writes in multiple regions simultaneously, requiring conflict detection and resolution strategies. The data architecture is what makes active-active hard, not the infrastructure deployment."
    },
    {
      "text": "Which CRDT type is appropriate for tracking a distributed daily spending limit across multiple regions without requiring coordination?",
      "options": ["LWW-Register (Last-Write-Wins)", "OR-Set (Observed-Remove Set)", "G-Counter (Grow-only Counter)", "2P-Set (Two-Phase Set)"],
      "correct": 2,
      "explanation": "A G-Counter is a grow-only counter where each region maintains its own increment slot and the total is the sum of all regional counters. It has no conflicts because each region only writes to its own slot, making it ideal for distributed spend tracking."
    },
    {
      "text": "When should a payment system use STRONG consistency reads rather than reading from a local replica?",
      "options": ["For transaction history queries", "For reading exchange rate caches", "For reading account balance before a debit operation", "For notification preference lookups"],
      "correct": 2,
      "explanation": "Account balance before a debit must be read with STRONG consistency from the primary to prevent overdrafts. Reading stale balance data from a replica could allow a debit that exceeds the actual balance. Transaction history and preferences tolerate staleness."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Multi-Region Payment Routing with Conflict Resolution",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement an AccountRegionRouter that assigns each account to a home region using consistent hashing, routes writes to the home region (forwarding cross-region writes via HTTP), and allows eventual-consistency reads from local replicas for non-financial data."},
    {"id": "2", "description": "Build a G-Counter CRDT for distributed daily spending limits: each region increments only its own slot, the total is the sum of all slots, and merge() takes the max of each regional value. Test with concurrent increments from two simulated regions."},
    {"id": "3", "description": "Implement a ReplicationLagMonitor that writes heartbeat records to the primary, reads them back from the replica, computes lag in milliseconds, publishes the gauge to Prometheus, and disables replica reads when lag exceeds 30 seconds."},
    {"id": "4", "description": "Build a GlobalPaymentRouter that checks regulatory mandates first, falls back to account home region routing, and falls back again to the nearest healthy region when the home region gateway is unavailable. Write unit tests for all three routing paths."}
  ]
}
-->

