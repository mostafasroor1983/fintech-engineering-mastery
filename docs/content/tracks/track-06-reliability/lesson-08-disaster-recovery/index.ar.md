---
id: track-06-lesson-08
title: "التعافي من الكوارث — RTO وRPO واستمرارية الأعمال المالية"
slug: disaster-recovery
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 8
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [disaster-recovery, RTO, RPO, failover, BCP]
prerequisites: []
---

# التعافي من الكوارث — RTO وRPO والاستمرارية المالية

> [!NOTE]
> لا تسأل الجهات الرقابية هل لديك خطة تعافٍ من الكوارث. بل تطلب دليلًا على أن خطتك اختُبرت، وأنها تحقق أهداف RTO/RPO المعلنة، وأن موظفيك يعرفون كيف ينفذونها تحت الضغط. ودليل تشغيل للتعافي لم يتدرب عليه أحد ليس خطة تعافٍ.

## 1. ‏RTO وRPO — التعريفات وأهداف القطاع المالي

**هدف زمن التعافي (RTO)**: أقصى مدة مقبولة لعدم توفر نظام بعد كارثة.

**هدف نقطة التعافي (RPO)**: أقصى قدر مقبول من فقدان البيانات مقاسًا بالزمن (إلى أي مدى للخلف يمكنك التعافي).

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
  - DORA (EU, since Jan 2025): ICT business continuity and DR plans,
    tested regularly; major-incident reporting
  - UK operational resilience (PRA/FCA): important business services must
    stay within set impact tolerances (fully in force since March 2025)
```

## 2. مستويات التعافي — بارد ودافئ وساخن

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

## 3. الاحتياطي والتحول في PostgreSQL

```bash
# PostgreSQL primary configuration (postgresql.conf)
# Synchronous replication for Tier 1 (near-zero RPO)
synchronous_commit = remote_write        # Commit waits until a standby has WRITTEN the WAL
                                         # (survives a primary crash; use 'on' to wait for
                                         #  the standby's FLUSH — stronger, slightly slower)
synchronous_standby_names = 'ANY 1 (dr-replica-a, dr-replica-b)'
                                         # ANY 1 of 2: with a single named standby, its
                                         # failure would BLOCK every commit on the primary
wal_level = replica                      # Enable replication WAL
max_wal_senders = 10                     # Allow up to 10 replicas
wal_keep_size = 1GB                      # Keep 1GB of WAL for replicas
archive_mode = on
archive_command = 'aws s3 cp %p s3://payment-wal-archive/%f'
                                         # must exit non-zero on failure; in production
                                         # prefer a tool such as pgBackRest or WAL-G
# Note: a synchronous standby in ANOTHER region adds one cross-region round
# trip to every commit — many teams keep the sync standby in-region and
# replicate to the DR region asynchronously (RPO = seconds).
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

        // Multi-host JDBC URL: the driver tries each host and keeps the one
        // that is currently the primary. (Alternative: a single name that
        // always points at the leader — e.g. HAProxy, vip-manager or a
        // Kubernetes Service fed by Patroni; Patroni itself does not edit DNS.)
        config.setJdbcUrl("jdbc:postgresql://pg-node-1:5432,pg-node-2:5432,pg-node-3:5432/payments" +
            "?targetServerType=primary" +      // Only accept the writable primary
            "&loginTimeout=5" +                 // 5s login timeout
            "&socketTimeout=10");               // 10s socket timeout

        config.setConnectionTimeout(3_000);      // 3s to get connection from pool
        config.setKeepaliveTime(30_000);          // 30s keepalive (detects dead connections)
        config.setMaxLifetime(300_000);            // 5min max connection age (cycling prevents stale)
        config.setInitializationFailTimeout(-1);   // Don't fail startup if DB unavailable

        // HikariCP has no "connection retry" settings: retries during the
        // promotion window belong in the application (see the repository below)

        return new HikariDataSource(config);
    }
}

/**
 * Failover-aware repository with retry logic.
 * During Patroni failover (typically 15–30s), connections may fail.
 * Retrying READS with backoff during this window is safe. A WRITE whose
 * connection dropped during COMMIT has an unknown outcome — retry it only
 * if it is idempotent (claim-first / unique key), never blindly.
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

## 4. ‏Kafka MirrorMaker للتعافي من الكوارث

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

# By default MM2 RENAMES topics on the target ("primary.payment-events").
# Keep the original names so DR consumers subscribe unchanged (Kafka 3.0+):
replication.policy.class = org.apache.kafka.connect.mirror.IdentityReplicationPolicy

# MM2 replication is ASYNCHRONOUS: events produced in the last seconds before
# a disaster may not have reached DR — RPO for Kafka is seconds, not zero.

# Offset sync: DR consumers can resume from (close to) the right offset after
# failover — offsets are synced only while the group is inactive on the target,
# so expect some reprocessing: consumers must be idempotent
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
            @Header(KafkaHeaders.RECEIVED_TOPIC) String topic,
            Acknowledgment ack) {

        log.debug("Processing payment event offset={} partition={}",
            record.offset(), record.partition());

        try {
            paymentEventHandler.handle(record.value());   // idempotent
        } catch (Exception e) {
            log.error("Failed to process payment event offset={}", record.offset(), e);
            // Send to DLQ (synchronously) — do NOT stop consumer
            dlqSender.send(record, e);
        }
        // AckMode.MANUAL_IMMEDIATE: without this the offset is NEVER committed
        // and every restart replays the partition
        ack.acknowledge();
    }
}

@Configuration
public class DRAwareKafkaConfig {

    /**
     * Listener factory for the active cluster. The bootstrap servers are fixed
     * when the consumers are created: to switch to the DR cluster at runtime,
     * stop the listener containers (KafkaListenerEndpointRegistry), point the
     * consumer factory at the DR bootstrap servers, and start them again —
     * or use a DNS alias for the bootstrap servers that DR activation repoints.
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

## 5. التعافي على مستوى التطبيق — التصميم عديم الحالة

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
 *   - Idempotency enforced by a UNIQUE key in the database (replicated with
 *     it); Redis is only a fast cache in front of it
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
        // 1. Idempotency check (cache first; the database UNIQUE key decides)
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

        // 6. Publish event via the transactional outbox (written in the same
        //    DB transaction as the payment), relayed to Kafka and mirrored
        eventPublisher.publish(PaymentProcessedEvent.from(response));

        return response;
    }
}
```

## 6. اختبار التعافي — تمرين الطاولة وتدريب التعافي

### تمرين الطاولة (Tabletop)

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
        // Run in staging, or in production only inside an approved drill window
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
            // Compare payments committed before the failure (audit log /
            // idempotency records) with what the new primary holds
            .dataLossDetected(!verifyNoCommittedPaymentsLost(failureTime))
            .baseline(baseline)
            .postDrill(postDrill)
            .build();
    }
}
```

## 7. أدلة التشغيل لسيناريوهات الفشل

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
3. Start the major-incident classification with Compliance. If the incident
   is classified as major under DORA, the initial notification is due within
   4 hours of classification (and no later than 24 hours after detection)
```

## 8. متطلبات الإبلاغ الرقابي

```java
/**
 * Regulatory notification tracking for operational incidents.
 * Financial institutions have obligations to notify regulators
 * of significant operational incidents.
 *
 * DORA (EU): initial notification within 4 hours of classifying an incident
 *   as MAJOR, and no later than 24 hours after becoming aware of it;
 *   intermediate report within 72 hours; final report within one month
 * FCA (UK): notify as soon as practicable (Principle 11 / SUP 15)
 * OCC/Fed/FDIC (US): notify within 36 hours of determining a
 *   "notification incident"
 *
 * The clock starts at CLASSIFICATION, not at "4 hours of outage". And the
 * report itself is approved by a human: this service drafts it and pages
 * Compliance — it does not auto-send to the regulator.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RegulatoryNotificationService {

    private static final Duration DORA_AFTER_CLASSIFICATION = Duration.ofHours(4);
    private static final Duration DORA_AFTER_DETECTION      = Duration.ofHours(24);

    @Scheduled(fixedDelay = 60_000)
    public void checkIncidentsAndNotify() {
        List<ActiveIncident> incidents = incidentRepository.findActiveIncidents();

        for (ActiveIncident incident : incidents) {
            Instant now = Instant.now();

            // DORA: once classified as major, draft the initial report at once
            // and track the deadline (whichever comes first)
            if (incident.getClassifiedMajorAt() != null && !incident.isDoraReportDrafted()) {
                Instant deadline = earliest(
                    incident.getClassifiedMajorAt().plus(DORA_AFTER_CLASSIFICATION),
                    incident.getDetectedAt().plus(DORA_AFTER_DETECTION));
                draftDoraInitialReport(incident, deadline);
                incident.setDoraReportDrafted(true);
                incidentRepository.save(incident);
            }

            // Internal escalation at 15 minutes (exceeds Tier 1 RTO)
            Duration outageTime = Duration.between(incident.getStartTime(), now);
            if (outageTime.toMinutes() >= 15 &&
                    !incident.isEscalated() &&
                    incident.getSeverity() == Severity.P1) {
                escalateToLeadership(incident);
                incident.setEscalated(true);
                incidentRepository.save(incident);   // persist, or it escalates every minute
            }
        }
    }

    private void draftDoraInitialReport(ActiveIncident incident, Instant deadline) {
        log.info("Drafting DORA initial report for incident={} deadline={}",
            incident.getId(), deadline);
        DoraIncidentReport draft = DoraIncidentReport.builder()
            .incidentId(incident.getId())
            .startTime(incident.getStartTime())
            .description(incident.getDescription())
            .impactedServices(incident.getImpactedServices())
            .customersAffected(incident.getEstimatedCustomerImpact())
            .currentStatus(incident.getStatus())
            .build();
        reportDraftRepository.save(draft);
        alerting.page(PagerDutyAlert.critical(
            "DORA major incident — initial report due by " + deadline
                + ". Review and submit: incident " + incident.getId()));
    }

    private static Instant earliest(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }
}
```

## 9. متطلبات توثيق خطة استمرارية الأعمال

يجب أن تتضمن خطة استمرارية الأعمال (BCP) لمؤسسة مالية:

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
   - DORA / FCA / US regulator thresholds and procedures
     (who classifies an incident as major, and who approves each report)
   - Contact list for each regulator
   - Template notifications ready to send
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لنظام معالجة دفع RTO قدره 15 دقيقة وRPO قدره دقيقة واحدة. أي مستوى تعافٍ مناسب؟",
      "options": ["احتياطي بارد مع نسخ احتياطية يومية", "احتياطي دافئ مع نسخ غير متزامن", "احتياطي ساخن مع نسخ متزامن", "نشط-نشط مع اتساق نهائي"],
      "correct": 2,
      "explanation": "يتطلب RTO قدره 15 دقيقة وRPO قدره دقيقة واحدة احتياطيًا ساخنًا (المستوى 1). فالاحتياطي البارد يستغرق 4–24 ساعة للاستعادة. والاحتياطي الدافئ قد يحقق RTO من 15 دقيقة إلى 4 ساعات لكن RPO من ثوانٍ إلى دقائق قد يتجاوز الدقيقة تحت أحمال كتابة عالية. والاحتياطي الساخن مع النسخ المتزامن يضمن فقدان بيانات قريبًا من الصفر."
    },
    {
      "text": "ما الغرض من تمرين الطاولة في التعافي من الكوارث؟",
      "options": ["قياس RTO الفعلي الذي يحققه النظام", "التدرب شفهيًا على إجراءات التحول وتحديد الثغرات دون التسبب في توقف فعلي", "نسخ البيانات من الرئيسي إلى الاحتياطي", "تشغيل تجارب هندسة الفوضى"],
      "correct": 1,
      "explanation": "تمرين الطاولة محاكاة قائمة على النقاش يمر فيها الفريق شفهيًا على سيناريو فشل. وقيمته في اكتشاف الثغرات — أدلة تشغيل مفقودة، وإجراءات غير موثقة، وإعدادات تنبيه مفقودة — قبل تدريب تعافٍ فعلي أو فشل حقيقي."
    },
    {
      "text": "بموجب قانون المرونة التشغيلية الرقمية (DORA)، خلال أي إطار زمني يجب أن تُبلغ مؤسسة مالية الجهات الرقابية بعد تصنيف حادث على أنه 'جسيم'؟",
      "options": ["ساعة واحدة", "4 ساعات", "24 ساعة", "36 ساعة"],
      "correct": 1,
      "explanation": "بموجب قواعد الإبلاغ في DORA، يُستحق الإبلاغ الأولي إلى السلطة المختصة خلال 4 ساعات من تصنيف الحادث على أنه جسيم — وفي موعد لا يتجاوز 24 ساعة من علم المؤسسة به — يليه تقرير مرحلي خلال 72 ساعة وتقرير نهائي خلال شهر. ولاحظ أن الساعة تبدأ عند التصنيف، لا بعد 4 ساعات من التوقف. وللبنوك الأمريكية 36 ساعة لإبلاغ جهتها الرقابية الأساسية بحادث يستوجب الإبلاغ."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "أتمتة التعافي من الكوارث ونظام الامتثال الرقابي",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "اضبط HikariCP لمرونة تحول PostgreSQL: عنوان JDBC متعدد المضيفين مع targetServerType=primary (أو نقطة قائد يحافظ عليها HAProxy أو vip-manager)، وconnectionTimeout ‏3 ثوانٍ، وkeepaliveTime ‏30 ثانية، و@Retryable في Spring على دوال المستودع للقراءة يعيد محاولة CannotGetJdbcConnectionException حتى 10 مرات بتراجع أسّي خلال نافذة ترقية Patroni. واشرح لماذا يجب ألا تُعاد محاولة الكتابات ذات نتيجة الالتزام المجهولة بشكل أعمى."},
    {"id": "2", "description": "نفّذ DRDrillOrchestrator: يسجّل خط أساس للحالة المستقرة، ويوقف حاوية الرئيسي، ويقيس زمن ترقية Patroni، ويقيس زمن تعافي التطبيق (باستطلاع نقطة صحة)، ويتحقق من الحالة المستقرة بعد التدريب، ويعيد DRDrillResult بقيمة منطقية rtoMet."},
    {"id": "3", "description": "ابنِ RegulatoryNotificationService يتتبع الحوادث النشطة، ويصوغ تقرير DORA الأولي فور تصنيف حادث كجسيم (الموعد: 4 ساعات بعد التصنيف، و24 ساعة كحد أقصى بعد الكشف) ويستدعي فريق الامتثال للموافقة عليه وإرساله، ويصعّد حوادث P1 إلى القيادة عند 15 دقيقة (تجاوز RTO للمستوى 1)، ويحفظ حالة الإبلاغ لمنع الإرسال المكرر."},
    {"id": "4", "description": "اكتب إعداد Kafka MirrorMaker 2 لنسخ payment-events وfraud-alerts وsettlement-events إلى مجموعة تعافٍ مع تفعيل مزامنة الإزاحات وسياسة IdentityReplicationPolicy (لتبقى أسماء المواضيع دون تغيير)، ونفّذ DRAwareKafkaConfig يمكن تحويله إلى خوادم bootstrap للتعافي وقت التشغيل بإيقاف حاويات المستمعين وإعادة تشغيلها — دون إعادة نشر."}
  ]
}
-->
