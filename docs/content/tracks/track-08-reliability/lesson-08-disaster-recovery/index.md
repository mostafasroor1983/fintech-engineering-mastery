---
id: track-08-lesson-08
title: "Disaster Recovery — RTO, RPO, and Financial Continuity"
slug: disaster-recovery
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 8
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [disaster-recovery, RTO, RPO, failover, BCP]
prerequisites: []
---

# Disaster Recovery — RTO, RPO, and Financial Continuity

> [!NOTE]
> Regulators do not ask if you have a DR plan. They ask for evidence that your DR plan has been tested, that it meets your stated RTO/RPO objectives, and that your staff know how to execute it under pressure. A DR runbook nobody has practiced is not a DR plan.

## 1. RTO and RPO — Definitions and Financial Industry Targets

**Recovery Time Objective (RTO)**: Maximum acceptable time for a system to be unavailable after a disaster.

**Recovery Point Objective (RPO)**: Maximum acceptable amount of data loss measured in time (how far back can you recover to).

```
Financial Service Tier Classification:

Tier 1 — Mission Critical (payment processing, trading, settlement):
  RTO: < 15 minutes
  RPO: < 1 minute (near-zero data loss)
  DR Strategy: Hot standby, synchronous replication
  Example: Card authorization, real-time payments

Tier 2 — Business Critical (account management, loan servicing):
  RTO: < 4 hours
  RPO: < 15 minutes
  DR Strategy: Warm standby, asynchronous replication
  Example: Account opening, balance inquiries

Tier 3 — Business Important (reporting, analytics, archival):
  RTO: < 24 hours
  RPO: < 4 hours
  DR Strategy: Cold standby, daily backup + WAL archival
  Example: Monthly statements, compliance reports

Regulatory context:
  - Basel III: banks must maintain capital for operational risk
  - PCI-DSS: cardholder data must be recoverable
  - FFIEC: US banks must demonstrate DR capability
  - DORA (EU): digital operational resilience, mandatory DR testing
```

## 2. DR Tiers — Cold, Warm, Hot

```java
/**
 * DR tier selection guidance for financial services.
 * Cost increases significantly from cold to hot standby.
 */
public enum DRTier {

    /**
     * COLD STANDBY
     * Infrastructure is provisioned only during DR activation.
     * Data is restored from backup (S3 + WAL logs).
     *
     * RTO: 4–24 hours (time to provision + restore + verify)
     * RPO: Hours (last backup point)
     * Cost: ~10% of production cost
     * Activation: Manual — ops team must execute runbook
     * Use for: Tier 3 services
     */
    COLD,

    /**
     * WARM STANDBY
     * Infrastructure is running but at reduced capacity.
     * Database replica is maintained via async streaming replication.
     * Application is deployed but not receiving traffic.
     *
     * RTO: 15 minutes – 4 hours (promote replica + DNS cutover)
     * RPO: Seconds to minutes (async replication lag at time of failure)
     * Cost: ~50% of production cost
     * Activation: Semi-automated (Patroni promotes, manual DNS cutover)
     * Use for: Tier 2 services
     */
    WARM,

    /**
     * HOT STANDBY (Active-Passive with auto-failover)
     * Full-capacity replica always running.
     * Automated failover via health check + load balancer.
     *
     * RTO: < 5 minutes (automated health check → failover)
     * RPO: Seconds (synchronous or near-synchronous replication)
     * Cost: ~100% of production cost (effectively 2x)
     * Activation: Automated (requires testing to validate)
     * Use for: Tier 1 services
     */
    HOT
}
```

## 3. PostgreSQL Standby and Failover

```bash
# PostgreSQL primary configuration (postgresql.conf)
# Synchronous replication for Tier 1 (zero RPO)
synchronous_commit = remote_write        # Wait for replica WAL write
synchronous_standby_names = 'dr-replica' # Named replica list
wal_level = replica                      # Enable replication WAL
max_wal_senders = 10                     # Allow up to 10 replicas
wal_keep_size = 1GB                      # Keep 1GB of WAL for replicas
archive_mode = on
archive_command = 'aws s3 cp %p s3://payment-wal-archive/%f'
```

```java
/**
 * Application-level PostgreSQL failover handling.
 * When primary fails, Patroni promotes replica and updates DNS.
 * Application must handle the brief connection interruption gracefully.
 */
@Configuration
public class PostgresFailoverConfig {

    /**
     * HikariCP with failover-aware settings.
     * - keepaliveTime: detects dead connections before they're used
     * - connectionTimeout: fail fast when primary is gone
     * - initializationFailTimeout: don't block startup if DB is briefly unavailable
     */
    @Bean
    @Primary
    public DataSource failoverAwareDataSource() {
        HikariConfig config = new HikariConfig();

        // Use multi-host JDBC URL for automatic failover
        // Patroni updates the CNAME when it promotes a replica
        config.setJdbcUrl("jdbc:postgresql://payment-primary.db.internal:5432/payments" +
            "?targetServerType=primary" +      // Always connect to primary
            "&loginTimeout=5" +                 // 5s login timeout
            "&socketTimeout=10");               // 10s socket timeout

        config.setConnectionTimeout(3_000);      // 3s to get connection from pool
        config.setKeepaliveTime(30_000);          // 30s keepalive (detects dead connections)
        config.setMaxLifetime(300_000);            // 5min max connection age (cycling prevents stale)
        config.setInitializationFailTimeout(-1);   // Don't fail startup if DB unavailable

        // Retry on connection failure (for during Patroni promotion window)
        config.setConnectionRetryAttempts(3);
        config.setConnectionRetryInterval(2_000);

        return new HikariDataSource(config);
    }
}

/**
 * Failover-aware repository with retry logic.
 * During Patroni failover (typically 15–30s), connections may fail.
 * We need to retry with exponential backoff during this window.
 */
@Repository
@RequiredArgsConstructor
@Slf4j
public class FailoverAwarePaymentRepository {

    private final JdbcTemplate jdbcTemplate;

    @Retryable(
        retryFor = {DataAccessResourceFailureException.class,
                    CannotGetJdbcConnectionException.class},
        maxAttempts = 10,
        backoff = @Backoff(delay = 2000, multiplier = 1.5, maxDelay = 30_000)
    )
    public Optional<Payment> findById(UUID paymentId) {
        try {
            return Optional.ofNullable(
                jdbcTemplate.queryForObject(
                    "SELECT * FROM payments WHERE id = ?",
                    paymentRowMapper, paymentId));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    @Recover
    public Optional<Payment> findByIdFallback(Exception e, UUID paymentId) {
        log.error("Database unavailable after failover retries for paymentId={}",
            paymentId, e);
        // Alert ops — this shouldn't happen after Patroni promotes
        alerting.page(PagerDutyAlert.critical(
            "Database read failing after retries — check Patroni status"));
        throw new DatabaseUnavailableException(
            "Database unavailable for payment " + paymentId);
    }
}
```

## 4. Kafka MirrorMaker for DR

```java
/**
 * Kafka MirrorMaker 2 replicates Kafka topics to the DR cluster.
 * This ensures event streams are available in the DR region.
 */

// MirrorMaker 2 configuration (mm2.properties)
/*
clusters = primary, dr
primary.bootstrap.servers = primary-kafka.example.com:9092
dr.bootstrap.servers = dr-kafka.example.com:9092

# Replicate from primary to DR
primary->dr.enabled = true
primary->dr.topics = payment-events, fraud-alerts, settlement-events
primary->dr.groups = payment-processor, fraud-consumer

# Replication settings for financial data
primary->dr.replication.factor = 3
primary->dr.tasks.max = 4

# Offset sync: DR consumers can resume from correct offset after failover
emit.checkpoints.interval.seconds = 60
sync.group.offsets.enabled = true
sync.group.offsets.interval.seconds = 60
*/

@Service
@RequiredArgsConstructor
@Slf4j
public class KafkaDRConsumer {

    /**
     * Consumer that can switch between primary and DR Kafka clusters.
     * During DR activation, reconfigure consumer to read from DR cluster.
     */
    @KafkaListener(
        topics = "${kafka.topics.payment-events}",
        containerFactory = "drAwareKafkaListenerFactory"
    )
    public void processPaymentEvent(
            ConsumerRecord<String, PaymentEvent> record,
            @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) {

        log.debug("Processing payment event offset={} partition={}",
            record.offset(), record.partition());

        try {
            paymentEventHandler.handle(record.value());
        } catch (Exception e) {
            log.error("Failed to process payment event offset={}", record.offset(), e);
            // Send to DLQ — do NOT stop consumer
            dlqSender.send(record, e);
        }
    }
}

@Configuration
public class DRAwareKafkaConfig {

    /**
     * Factory that can be reconfigured to point to DR cluster.
     * During DR activation, call switchToDRCluster() to redirect.
     */
    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, PaymentEvent>
            drAwareKafkaListenerFactory(
                @Value("${kafka.bootstrap-servers}") String bootstrapServers) {

        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-processor");
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        // Add isolation.level = read_committed for transactional producers
        props.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");

        DefaultKafkaConsumerFactory<String, PaymentEvent> cf =
            new DefaultKafkaConsumerFactory<>(props,
                new StringDeserializer(),
                new JsonDeserializer<>(PaymentEvent.class));

        ConcurrentKafkaListenerContainerFactory<String, PaymentEvent> factory =
            new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(cf);
        factory.getContainerProperties()
            .setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);
        return factory;
    }
}
```

## 5. Application-Level DR — Stateless Design

```java
/**
 * Stateless service design principles for DR resilience.
 *
 * Rule 1: No in-memory session state.
 *   - All session data in Redis (with cross-region replication)
 *   - Any instance of the service can handle any request
 *
 * Rule 2: No local file system state.
 *   - All file operations via S3 or equivalent object store
 *   - No ephemeral disk state that would be lost on instance failure
 *
 * Rule 3: Idempotent operations.
 *   - Every write operation must be safe to retry
 *   - Idempotency keys stored in Redis (cross-region replicated)
 *
 * Rule 4: External state only.
 *   - Database: PostgreSQL with streaming replication
 *   - Cache: Redis with cross-region replication
 *   - Events: Kafka with MirrorMaker replication
 *   - Files: S3 with cross-region replication
 */
@Service
public class StatelessPaymentService {

    // All state externalized — no instance-local state

    public PaymentResponse processPayment(PaymentRequest request) {
        // 1. Idempotency key check (Redis — cross-region replicated)
        Optional<PaymentResponse> existing =
            idempotencyKeyStore.get(request.getIdempotencyKey());
        if (existing.isPresent()) return existing.get();

        // 2. Fraud check (stateless external call)
        FraudDecision fraud = fraudService.check(request);

        // 3. Balance check (PostgreSQL — streaming replication)
        Account account = accountRepository.findById(request.getAccountId())
            .orElseThrow(() -> new AccountNotFoundException(request.getAccountId()));

        // 4. Process (all state goes to external systems)
        PaymentResponse response = executePayment(request, fraud, account);

        // 5. Store idempotency key result (Redis)
        idempotencyKeyStore.store(request.getIdempotencyKey(), response,
            Duration.ofHours(24));

        // 6. Publish event (Kafka — MirrorMaker replicated)
        eventPublisher.publish(PaymentProcessedEvent.from(response));

        return response;
    }
}
```

## 6. DR Testing — Tabletop and DR Drill

### Tabletop Exercise

```
TABLETOP EXERCISE: Payment Service Database Failure

Scenario: PostgreSQL primary in us-east-1 fails at 14:30 on a Tuesday.
Participants: 6 engineers + 1 facilitator + 1 observer (compliance)

Questions posed by facilitator:

Q1: How do we detect the failure?
Expected: Prometheus alert "PostgreSQL primary unreachable" fires within 1m.
Actual answer given: "We'd see payment errors in Datadog."
Gap identified: Alert not configured — added to action items.

Q2: Who is notified?
Expected: PagerDuty pages on-call engineer within 2m.
Actual answer: Engineers check Slack — no automated paging configured.
Gap identified: PagerDuty runbook for DB failure not set up.

Q3: How do we promote the replica?
Expected: Patroni auto-promotes; engineer verifies via patronictl.
Actual answer: "We'd SSH into the replica and run pg_promote."
Gap identified: Patroni not deployed — adds 20 minutes to RTO.

Q4: How do we redirect application traffic?
Expected: DNS failover via Route 53 health check.
Actual answer: "We'd update the connection string and redeploy."
Gap identified: Redeployment adds 15 minutes; exceeds 15-minute RTO.

ACTION ITEMS:
1. Configure PostgreSQL primary down alert in Prometheus
2. Set up PagerDuty runbook for DB failure
3. Deploy Patroni for automatic failover
4. Configure Route 53 health check for automatic DNS failover
5. Schedule DR drill in 30 days to verify fixes
```

```java
/**
 * DR drill automation — runs the actual failover procedure
 * and measures the actual RTO achieved.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class DRDrillOrchestrator {

    public DRDrillResult executeDatabaseFailoverDrill() {
        Instant drillStart = Instant.now();
        log.info("DR DRILL STARTED: PostgreSQL primary failover");

        // 1. Record baseline metrics
        SteadyStateResult baseline = steadyStateVerifier.verify("dr-drill-baseline",
            Duration.ofMinutes(2));

        // 2. Simulate primary failure (stop PostgreSQL primary)
        log.info("DRILL: Stopping PostgreSQL primary container");
        containerManager.stopContainer("postgresql-primary");
        Instant failureTime = Instant.now();

        // 3. Monitor for Patroni promotion
        Instant promotionTime = waitForPromotion(failureTime);
        Duration timeToPromotion = Duration.between(failureTime, promotionTime);
        log.info("DRILL: Replica promoted in {}", timeToPromotion);

        // 4. Monitor for application recovery
        Instant recoveryTime = waitForApplicationRecovery();
        Duration timeToRecovery = Duration.between(failureTime, recoveryTime);
        log.info("DRILL: Application recovered in {}", timeToRecovery);

        // 5. Verify steady state
        SteadyStateResult postDrill = steadyStateVerifier.verify("dr-drill-post",
            Duration.ofMinutes(5));

        // 6. Restart primary (bring back as new replica)
        containerManager.startContainer("postgresql-primary");

        return DRDrillResult.builder()
            .drillName("PostgreSQL Primary Failover")
            .drillDate(drillStart)
            .timeToPromotion(timeToPromotion)
            .timeToApplicationRecovery(timeToRecovery)
            .rtoTarget(Duration.ofMinutes(15))
            .rtoAchieved(timeToRecovery)
            .rtoMet(timeToRecovery.compareTo(Duration.ofMinutes(15)) < 0)
            .dataLossDetected(false)  // Verify via idempotency key audit
            .baseline(baseline)
            .postDrill(postDrill)
            .build();
    }
}
```

## 7. Runbooks for Failure Scenarios

```markdown
# RUNBOOK: PostgreSQL Primary Database Failure

## Trigger
PagerDuty alert: "PostgreSQL Primary Unreachable" (severity P1)

## Expected Timeline
- T+0m: Alert fires (Prometheus detects primary down)
- T+2m: On-call engineer acknowledges alert
- T+5m: Patroni promotes replica (automated)
- T+8m: DNS failover completes (Route 53 health check)
- T+10m: Application connections re-established
- T+15m: RTO target met — normal operations resumed

## Step 1: Verify the failure (2 minutes)
1. SSH into bastion host
2. Run: `patronictl -c /etc/patroni/config.yml list`
3. Confirm primary is in "stopped" state
4. Check: `aws cloudwatch get-metric-statistics ...` for DB metrics
5. If Patroni shows healthy primary → false alarm, page on-call DB team

## Step 2: Confirm Patroni promotion (3 minutes)
1. Watch patronictl output for "replica" node to become "leader"
2. If automatic promotion fails:
   `patronictl -c /etc/patroni/config.yml failover payment-cluster`
3. Verify new primary is accepting writes:
   `psql -h new-primary-ip -c "SELECT pg_is_in_recovery();"`
   → Should return "f" (false = not in recovery = is primary)

## Step 3: Verify application connectivity (5 minutes)
1. Check application logs for "Connection refused" errors clearing
2. Verify via health endpoint: `curl https://payment-service/actuator/health/db`
3. Run smoke test: `./scripts/payment-smoke-test.sh`

## Step 4: Notify stakeholders (ongoing)
1. Post in #incidents Slack channel every 10 minutes
2. Update status page at status.example.com
3. Email regulatory contact if outage exceeds 15 minutes (DORA requirement)
```

## 8. Regulatory Notification Requirements

```java
/**
 * Automated regulatory notification for prolonged outages.
 * Financial institutions have obligations to notify regulators
 * of significant operational incidents.
 *
 * DORA (EU): Notify within 4 hours of classification as "major incident"
 * FCA (UK): Notify as soon as practicable if incident affects customers
 * OCC (US): Notify within 36 hours for bank service outages
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RegulatoryNotificationService {

    @Scheduled(fixedDelay = 60_000)
    public void checkOutageDurationAndNotify() {
        List<ActiveIncident> incidents = incidentRepository.findActiveIncidents();

        for (ActiveIncident incident : incidents) {
            Duration outageTime = Duration.between(incident.getStartTime(), Instant.now());

            // DORA: Major incident notification at 4 hours
            if (outageTime.toHours() >= 4 &&
                    !incident.isDoraNotificationSent() &&
                    incident.isCustomerFacing()) {
                sendDoraNotification(incident);
                incident.setDoraNotificationSent(true);
                incidentRepository.save(incident);
            }

            // Internal escalation at 15 minutes (exceeds Tier 1 RTO)
            if (outageTime.toMinutes() >= 15 &&
                    !incident.isEscalated() &&
                    incident.getSeverity() == Severity.P1) {
                escalateToLeadership(incident);
                incident.setEscalated(true);
            }
        }
    }

    private void sendDoraNotification(ActiveIncident incident) {
        log.info("Sending DORA regulatory notification for incident={}", incident.getId());
        // Send structured notification to regulator API or email
        regulatorNotificationClient.notify(DoraIncidentReport.builder()
            .incidentId(incident.getId())
            .startTime(incident.getStartTime())
            .description(incident.getDescription())
            .impactedServices(incident.getImpactedServices())
            .customersAffected(incident.getEstimatedCustomerImpact())
            .currentStatus(incident.getStatus())
            .build());
    }
}
```

## 9. BCP Documentation Requirements

A Business Continuity Plan (BCP) for a financial institution must contain:

```
1. SCOPE AND OBJECTIVES
   - Systems covered (payment processing, clearing, settlement)
   - RTO/RPO targets per service tier
   - Regulatory obligations driving the plan

2. RISK ASSESSMENT
   - Identified threats (data center fire, ransomware, ISP outage, key person)
   - Probability and impact matrix
   - Risk acceptance thresholds

3. RECOVERY PROCEDURES (Runbooks)
   - Step-by-step per failure scenario
   - Named roles (not individuals — people leave)
   - Contact tree with backup contacts
   - Vendor emergency contacts (AWS, payment gateway, telco)

4. TESTING SCHEDULE
   - Annual tabletop exercise for all Tier 1 services
   - Quarterly DR drills for Tier 1 (database failover, Kafka failover)
   - Semi-annual full DR activation test (promote cold standby)
   - Results documented with RTO achieved vs target

5. MAINTENANCE
   - Quarterly review of runbooks
   - Update after every major architectural change
   - Version control (every BCP change is tracked)

6. REGULATORY NOTIFICATIONS
   - DORA / FCA / OCC thresholds and procedures
   - Contact list for each regulator
   - Template notifications ready to send
```

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment processing system has an RTO of 15 minutes and an RPO of 1 minute. Which DR tier is appropriate?",
      "options": ["Cold standby with daily backups", "Warm standby with asynchronous replication", "Hot standby with synchronous replication", "Active-active with eventual consistency"],
      "correct": 2,
      "explanation": "An RTO of 15 minutes and RPO of 1 minute requires a hot standby (Tier 1). Cold standby takes 4–24 hours to restore. Warm standby can achieve RTO of 15 min–4 hours but RPO of seconds to minutes may exceed 1 minute under high write loads. Hot standby with synchronous replication ensures near-zero data loss."
    },
    {
      "text": "What is the purpose of a tabletop exercise in disaster recovery?",
      "options": ["To measure the actual RTO achieved by the system", "To rehearse failover procedures verbally and identify gaps without causing actual downtime", "To replicate data from primary to standby", "To run chaos engineering experiments"],
      "correct": 1,
      "explanation": "A tabletop exercise is a discussion-based simulation where the team walks through a failure scenario verbally. Its value is in discovering gaps — missing runbooks, undocumented procedures, missing alert configurations — before an actual DR drill or real failure."
    },
    {
      "text": "Under DORA (Digital Operational Resilience Act), within what timeframe must a financial institution notify regulators after classifying an incident as 'major'?",
      "options": ["1 hour", "4 hours", "24 hours", "36 hours"],
      "correct": 1,
      "explanation": "DORA requires notification to competent authorities within 4 hours of classifying an incident as a major incident. This is stricter than OCC (36 hours for US banks) and requires automated monitoring to track incident duration and trigger notifications."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "DR Automation and Regulatory Compliance System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Configure HikariCP for PostgreSQL failover resilience: multi-host JDBC URL with targetServerType=primary, connectionTimeout 3s, keepaliveTime 30s, and Spring @Retryable on repository methods that retries CannotGetJdbcConnectionException up to 10 times with exponential backoff during the Patroni promotion window."},
    {"id": "2", "description": "Implement a DRDrillOrchestrator that: records a steady-state baseline, stops the primary container, measures time to Patroni promotion, measures time to application recovery (by polling a health endpoint), verifies post-drill steady state, and returns a DRDrillResult with rtoMet boolean."},
    {"id": "3", "description": "Build a RegulatoryNotificationService that tracks active incidents, sends a DORA notification when customer-facing outage reaches 4 hours, escalates P1 incidents to leadership at 15 minutes (exceeding Tier 1 RTO), and records notification timestamps to prevent duplicate sends."},
    {"id": "4", "description": "Write a Kafka MirrorMaker 2 configuration for replicating payment-events, fraud-alerts, and settlement-events to a DR cluster with offset sync enabled, and implement a DRAwareKafkaConfig factory that can be switched to the DR bootstrap servers at runtime without redeployment."}
  ]
}
-->

