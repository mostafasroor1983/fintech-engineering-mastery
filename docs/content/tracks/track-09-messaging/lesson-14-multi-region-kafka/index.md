---
id: track-09-lesson-14
title: "Multi-Region Kafka — MirrorMaker 2 and Replication"
slug: multi-region-kafka
track: track-09
trackName: "Kafka & Event-Driven Architecture"
sequence: 14
difficulty: principal
estimatedMinutes: 85
status: published
tags: [MirrorMaker, multi-region, geo-replication, failover, Kafka]
prerequisites: ["track-09-lesson-01", "track-09-lesson-08"]
---

# Multi-Region Kafka — MirrorMaker 2 and Replication

> [!NOTE]
> A single-region Kafka cluster is a single point of failure for all payment processing. Financial institutions require multi-region Kafka for disaster recovery, geographic compliance (data residency), and low-latency access from regional services. MirrorMaker 2, built on Kafka Connect, is the production-grade solution — but its offset translation mechanism and failover procedure require deep understanding to operate correctly.

## Why Multi-Region Kafka

```
Single Region — Single Point of Failure:
  ┌──────────────────────────────────────────────────────┐
  │  AWS eu-west-1 (London)                              │
  │  Kafka Cluster + All Payment Services                │
  │  → Data centre outage = ALL payment processing stops │
  └──────────────────────────────────────────────────────┘

Multi-Region — Active-Passive:
  ┌─────────────────────┐         ┌─────────────────────┐
  │  eu-west-1 (Active) │───────► │  eu-west-2 (Standby)│
  │  Primary Cluster    │  Mirror │  Replica Cluster    │
  │  All writes here    │  Maker 2│  Reads in failover  │
  └─────────────────────┘         └─────────────────────┘

Multi-Region — Active-Active:
  ┌─────────────────────┐         ┌─────────────────────┐
  │  eu-west-1          │◄──────► │  us-east-1          │
  │  EU payment writes  │  Bidirec│  US payment writes  │
  │  Reads EU events    │  tional │  Reads US events    │
  └─────────────────────┘         └─────────────────────┘
```

**Data residency:** Some payment regulators require that transaction data for EU customers must remain in the EU. Selective topic replication allows compliance: EU payment topics replicate within EU only; US topics replicate within US only.

---

## MirrorMaker 2 Architecture

MirrorMaker 2 (MM2) is built on Kafka Connect. It runs as a Kafka Connect cluster that uses internal connectors to replicate topics between clusters.

```
Source Cluster (eu-west-1)        MM2 (Kafka Connect)        Target Cluster (eu-west-2)
payments.events ───────────────► MirrorSourceConnector ─────► eu-west-1.payments.events
                                 MirrorCheckpointConnector ──► eu-west-1.checkpoints.internal
                                 MirrorHeartbeatConnector ───► heartbeats
```

**Three internal connectors:**

| Connector | Purpose |
|-----------|---------|
| `MirrorSourceConnector` | Replicates topic data from source to target |
| `MirrorCheckpointConnector` | Replicates consumer group offsets |
| `MirrorHeartbeatConnector` | Monitors replication health |

**Topic naming convention:** With the default replication policy, replicated topics are prefixed with the source cluster alias. `payments.events` on `eu-west-1` becomes `eu-west-1.payments.events` on `eu-west-2`. This prevents naming collisions and replication loops in active-active setups. (For a pure active-passive DR copy, `replication.policy.class=org.apache.kafka.connect.mirror.IdentityReplicationPolicy`, Kafka 3.0+, keeps the original names — but then loops must be ruled out by design.)

---

## MirrorMaker 2 Configuration

```properties
# mm2.properties — MirrorMaker 2 configuration

# Cluster aliases
clusters = eu-west-1, eu-west-2

# Source cluster connection
eu-west-1.bootstrap.servers = kafka-eu1-broker1:9092,kafka-eu1-broker2:9092,kafka-eu1-broker3:9092
eu-west-1.security.protocol = SASL_SSL
eu-west-1.sasl.mechanism = SCRAM-SHA-512
eu-west-1.sasl.jaas.config = org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="mm2-replicator" password="${file:/etc/mm2/secrets.properties:eu1.password}";

# Target cluster connection
eu-west-2.bootstrap.servers = kafka-eu2-broker1:9092,kafka-eu2-broker2:9092,kafka-eu2-broker3:9092
eu-west-2.security.protocol = SASL_SSL
eu-west-2.sasl.mechanism = SCRAM-SHA-512
eu-west-2.sasl.jaas.config = org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="mm2-replicator" password="${file:/etc/mm2/secrets.properties:eu2.password}";
config.providers = file
config.providers.file.class = org.apache.kafka.common.config.provider.FileConfigProvider

# Replication flow: eu-west-1 → eu-west-2
eu-west-1->eu-west-2.enabled = true
eu-west-1->eu-west-2.topics = payments\..*, accounts\..*, audit\..*
eu-west-1->eu-west-2.groups = payment-processor, settlement-service

# Topic replication config
replication.factor = 3
checkpoints.topic.replication.factor = 3
heartbeats.topic.replication.factor = 3
offset-syncs.topic.replication.factor = 3

# (MM2 has no "max lag" setting -- replication lag is MONITORED through
#  its metrics, e.g. replication-latency-ms, and alerted on; see below)

# Consumer group offset replication interval
emit.checkpoints.interval.seconds = 10
emit.heartbeats.interval.seconds = 1

# Sync consumer group offsets for failover (Kafka 2.7+): MM2 writes the
# TRANSLATED offsets directly into the target cluster's consumer groups
# (only while those groups are inactive there), so consumers that start on
# eu-west-2 with the same group id resume from the right place
sync.group.offsets.enabled = true
sync.group.offsets.interval.seconds = 60
```

---

## Offset Translation

This is the critical concept that makes MM2 failover work. Offsets on the source cluster and target cluster are **different**: the target assigns its own offsets (replication may have started at a different point, retention or compaction may have removed records, transaction markers are not copied). Offset 1000 of `payments.events` on `eu-west-1` is generally not offset 1000 of `eu-west-1.payments.events` on `eu-west-2`.

```
Source (eu-west-1):              Target (eu-west-2):
payments.events partition 0      eu-west-1.payments.events partition 0
  offset 500: msg-A                offset 0: msg-A   (replication began here)
  offset 501: msg-B                offset 1: msg-B
  offset 502: msg-C  [replicated]  offset 2: msg-C
  offset 503: msg-D ←───────────── [not yet replicated — replication lag]
  offset 504: msg-E

Consumer group "settlement":
  Source committed offset: 503 (has consumed msg-A, msg-B, msg-C)
  Translated target offset: 3 (= next record after msg-C on the target)

MM2 records offset pairs (offset-syncs) only from time to time, so the
translation is CONSERVATIVE: after failover a consumer may re-read a few
records it already processed -- consumers must be idempotent.
```

MM2's `MirrorCheckpointConnector` writes translated consumer-group offsets to `eu-west-1.checkpoints.internal` on the target cluster. With `sync.group.offsets.enabled=true` they are also applied to the target's consumer groups automatically; otherwise read them with the client API below.

### Reading Translated Offsets in Java

```java
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.connect.mirror.RemoteClusterUtils;
import java.time.Duration;
import java.util.Map;

public class FailoverConsumerManager {

    private final Map<String, Object> targetClusterProps;   // bootstrap.servers + security of eu-west-2

    /**
     * On failover: read the translated consumer group offsets from the
     * TARGET cluster's checkpoint topic. The returned keys are already the
     * REMOTE topic partitions (e.g. eu-west-1.payments.events-0) -- do not
     * add the prefix a second time.
     */
    public Map<TopicPartition, OffsetAndMetadata> getTranslatedOffsets(
            String consumerGroup, String sourceClusterAlias) throws Exception {
        return RemoteClusterUtils.translateOffsets(
                targetClusterProps, sourceClusterAlias, consumerGroup,
                Duration.ofSeconds(30));
    }

    /**
     * Apply translated offsets to a consumer before starting it on the target cluster.
     * (Not needed when sync.group.offsets.enabled=true already wrote them
     *  into the target consumer group.)
     */
    public void seekToTranslatedOffsets(
            KafkaConsumer<?, ?> consumer,
            Map<TopicPartition, OffsetAndMetadata> translatedOffsets) {

        consumer.assign(translatedOffsets.keySet());
        translatedOffsets.forEach((tp, om) -> consumer.seek(tp, om.offset()));
        log.info("Consumer seeked to translated offsets after failover: {}", translatedOffsets);
    }
}
```

---

## Active-Active vs Active-Passive

### Active-Passive (Recommended for Payments)

```
Normal operation:
  eu-west-1 (active): all payment writes + reads
  eu-west-2 (passive): receives replicated data, no writes, no reads

Failover:
  eu-west-1 goes down
  Consumers switch to eu-west-2, seek to translated offsets
  New writes go to eu-west-2
  When eu-west-1 recovers: start replicating from eu-west-2 back to eu-west-1
  Then switch back (optional)

Pros: Simple, no conflict resolution needed
Cons: eu-west-2 resources underutilised during normal operation
```

### Active-Active (Complex — Use Cautiously)

```
Normal operation:
  eu-west-1: handles EU customer payments
  us-east-1: handles US customer payments
  Each cluster replicates to the other bidirectionally

Complexity:
  - Avoid replicating back to origin (infinite loop)
    → MM2 uses provenance to detect and stop loops
    → Topics: eu-west-1.payments.events ≠ payments.events
  - Conflict resolution for same-entity updates
  - Consumer group offset sync must be bidirectional

Pros: Both clusters active, lower latency per region
Cons: Conflict resolution complexity, harder to reason about consistency
```

**Principal engineer recommendation:** Use active-passive for financial payment systems unless you have a specific latency requirement that mandates active-active. The operational complexity of active-active conflict resolution is significant.

---

## Failover Procedure

A documented runbook for failing over consumers from eu-west-1 to eu-west-2:

```
FAILOVER RUNBOOK: eu-west-1 → eu-west-2

Pre-condition: eu-west-1 Kafka is unavailable or degraded.

Step 1: Assess replication lag (before eu-west-1 fails)
  - Check MM2 metrics: kafka_connect_mirror_source_connector_replication_latency_ms
  - If lag > 5 seconds: some recent messages may not be replicated

Step 2: Stop consumers and producers on eu-west-1 (if still accessible)
  - Scale the applications that use eu-west-1 to zero, so nobody keeps
    writing to or consuming from the old cluster (split brain)

Step 3: Get translated offsets for each consumer group
  - Use MirrorClient.remoteConsumerOffsets() (see code above)
  - Or: kafka-consumer-groups.sh --bootstrap-server kafka-eu2:9092 \
      --group settlement-service --describe
      (shows offsets from eu-west-1.checkpoints.internal)

Step 4: Start consumers on eu-west-2 with translated offsets
  - Update application configuration: BOOTSTRAP_SERVERS=kafka-eu2-broker1:9092
  - Seek to translated offsets before starting consumption
  - Topic names change: payments.events → eu-west-1.payments.events
    (unless IdentityReplicationPolicy is used)
  - Expect a few re-processed messages (conservative offset translation):
    consumers must be idempotent

Step 5: Verify consumers are processing normally
  - Monitor consumer lag on eu-west-2
  - Verify payment processing metrics are normal

Step 6: Handle the gap (messages that didn't replicate)
  - If eu-west-1 recovers: replay un-replicated messages manually
  - If eu-west-1 is permanently lost: accept the gap, audit and compensate
```

---

## Monitoring MirrorMaker 2 Replication Lag

```java
@Component
public class MirrorMaker2Monitor {

    @Autowired private AdminClient targetAdminClient;
    @Autowired private AlertService alertService;

    private static final Duration LAG_ALERT_THRESHOLD = Duration.ofSeconds(10);
    private final AtomicLong lagMsHolder = new AtomicLong();

    // Gauge registered ONCE; the scheduled job only updates the holder
    @Autowired
    void registerGauge(MeterRegistry meterRegistry) {
        Gauge.builder("kafka.mm2.replication.lag.ms", lagMsHolder, AtomicLong::get)
            .tags("source", "eu-west-1", "target", "eu-west-2")
            .register(meterRegistry);
    }

    @Scheduled(fixedDelay = 30_000)
    public void monitorReplicationLag() {
        try {
            // Read replication lag from MM2's JMX metrics, e.g.
            // kafka.connect.mirror:type=MirrorSourceConnector,target=eu-west-2,
            //   topic=eu-west-1.payments.events,partition=0
            //   attribute replication-latency-ms-max
            double lagMs = getMm2ReplicationLagMs();
            lagMsHolder.set(Math.round(lagMs));

            if (lagMs > LAG_ALERT_THRESHOLD.toMillis()) {
                alertService.sendAlert(AlertSeverity.HIGH,
                        String.format("MirrorMaker 2 replication lag is %.0fms (threshold: %dms)",
                                lagMs, LAG_ALERT_THRESHOLD.toMillis()));
            }

        } catch (Exception e) {
            log.error("Failed to monitor MM2 replication lag", e);
            alertService.sendAlert(AlertSeverity.CRITICAL,
                    "Cannot read MM2 replication lag — monitoring failure");
        }
    }

    // Check that all topics are being replicated
    @Scheduled(fixedDelay = 300_000)
    public void verifyTopicReplication() throws Exception {
        List<String> expectedTopics = List.of(
                "eu-west-1.payments.events",
                "eu-west-1.payments.audit",
                "eu-west-1.account.events"
        );

        Set<String> existingTopics = targetAdminClient.listTopics().names().get();

        for (String topic : expectedTopics) {
            if (!existingTopics.contains(topic)) {
                alertService.sendAlert(AlertSeverity.CRITICAL,
                        "Replicated topic " + topic + " not found on target cluster");
            }
        }
    }
}
```

**Key metrics to monitor:**

```yaml
# Prometheus alert rules for MM2
groups:
  - name: mirrormaker2
    rules:
      - alert: MM2ReplicationLagHigh
        expr: kafka_mm2_replication_lag_ms > 10000
        for: 2m
        annotations:
          summary: "MM2 replication lag > 10s — failover readiness degraded"

      - alert: MM2ConnectorNotRunning
        # metric name depends on your Connect exporter
        expr: kafka_connect_connector_status{connector="MirrorSourceConnector"} != 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "MM2 source connector not running — replication stopped"
```

---

## Data Residency with Selective Replication

For GDPR and FCA compliance, selectively replicate only non-sensitive or permitted topics:

```properties
# Replicate payment and account events -- an explicit allow-list (safest
# for compliance)
eu-west-1->eu-west-2.topics = ^(payments|accounts|audit)\..*$

# Additionally exclude PII topics by name (topics.exclude, Kafka 2.7+;
# the old name topics.blacklist is deprecated)
eu-west-1->eu-west-2.topics.exclude = customers\.pii, identity\.documents
```

---

## Key Takeaways

- MirrorMaker 2 is built on Kafka Connect — it uses source, checkpoint, and heartbeat connectors to replicate topics and consumer group offsets.
- Replicated topics are prefixed with the source cluster alias: `payments.events` → `eu-west-1.payments.events`.
- **Offset translation** is the critical failover mechanism — source offsets do not map directly to target offsets; enable `sync.group.offsets.enabled` or use `RemoteClusterUtils.translateOffsets()`, and keep consumers idempotent (translation is conservative).
- **Active-passive** is recommended for payment systems — simpler, no conflict resolution, easier to reason about consistency.
- **Active-active** is viable for geographically partitioned workloads (EU writes to EU cluster, US writes to US cluster) but adds significant operational complexity.
- Monitor replication lag continuously — whatever is not yet replicated when the source fails is missing on the target (that lag is your RPO).
- Selective topic replication is essential for data residency compliance — only replicate what regulations allow.
- Document and rehearse the failover runbook quarterly — failover procedures that are not tested will fail under pressure.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What naming convention does MirrorMaker 2 apply to replicated topics, and why does this matter for failover?",
      "options": [
        "Topics are replicated with identical names; consumers do not need to change configuration",
        "Topics are prefixed with the source cluster alias (e.g., 'eu-west-1.payments.events'), requiring consumers to update their topic subscription during failover",
        "Topics are suffixed with '.replica' to distinguish them from source topics",
        "MirrorMaker 2 uses separate namespaces and no renaming is applied"
      ],
      "correct": 1,
      "explanation": "MM2 prefixes replicated topics with the source cluster alias to prevent infinite replication loops and to distinguish source from replica data. During failover, consumers must update their subscription from 'payments.events' to 'eu-west-1.payments.events' on the target cluster."
    },
    {
      "text": "Why can source consumer group offsets not be used directly on the target cluster after failover?",
      "options": [
        "The target cluster uses a different offset format",
        "The target cluster assigns its own offsets (replication may start at a different point, retention or compaction may remove records, transaction markers are not copied), so the same offset number can refer to a different message",
        "Consumer group offsets are not replicated by MirrorMaker 2",
        "Target cluster partitions always have fewer messages than the source"
      ],
      "correct": 1,
      "explanation": "MM2 copies records but not their offsets: the target topic numbers records itself, and gaps from retention, compaction or transaction markers make the numbers drift apart. MM2 therefore records offset pairs and translates consumer group offsets (checkpoints); with sync.group.offsets.enabled it applies them to the target groups. The translation is conservative, so a few records may be re-processed after failover — consumers must be idempotent."
    },
    {
      "text": "Why is active-passive recommended over active-active for financial payment systems?",
      "options": [
        "Active-passive provides higher throughput than active-active",
        "Active-active requires more MirrorMaker 2 connectors than available",
        "Active-passive avoids conflict resolution complexity from concurrent writes to the same entity across regions",
        "Active-passive is cheaper to operate than active-active"
      ],
      "correct": 2,
      "explanation": "Active-active allows writes to both clusters simultaneously. If two regions process updates to the same payment account concurrently, conflict resolution is required. For financial systems where account balance correctness is critical, the conflict resolution complexity of active-active is a significant operational risk."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Test a Multi-Region Kafka Failover for Payment Processing",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {
      "id": "1",
      "description": "Configure MirrorMaker 2 to replicate 'payments.events' and 'account.events' from eu-west-1 to eu-west-2 using an active-passive topology. Set up the MirrorSourceConnector, MirrorCheckpointConnector, and MirrorHeartbeatConnector. Configure selective replication using a topic whitelist regex that excludes customer PII topics."
    },
    {
      "id": "2",
      "description": "Implement a MirrorMaker2Monitor component that reads replication lag metrics every 30 seconds, registers a Prometheus gauge for replication latency, and sends HIGH alerts when lag exceeds 10 seconds and CRITICAL alerts when the MirrorSourceConnector is not running."
    },
    {
      "id": "3",
      "description": "Write the failover procedure: (1) measure current replication lag, (2) get the translated consumer group offsets for 'settlement-service' (sync.group.offsets.enabled, or RemoteClusterUtils.translateOffsets()), (3) stop the applications on eu-west-1 and update the consumer bootstrap configuration to eu-west-2 brokers, (4) seek consumers to the translated offsets before resuming consumption from 'eu-west-1.payments.events', and verify duplicates are absorbed by idempotent processing."
    },
    {
      "id": "4",
      "description": "Implement and automate a quarterly failover drill: simulate eu-west-1 unavailability, execute the failover runbook, verify payment processing resumes on eu-west-2 with no duplicate or missed messages, measure RTO achieved, and document the gap between target and actual RTO."
    }
  ]
}
-->
