---
id: track-11-lesson-17
title: "Kafka Monitoring — Consumer Lag and Broker Metrics"
slug: kafka-monitoring
track: track-11
trackName: "Kafka & Event-Driven Architecture"
sequence: 17
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [Kafka, monitoring, consumer-lag, JMX, Prometheus]
prerequisites: [kafka-architecture, kafka-consumer]
---

# Kafka Monitoring — Consumer Lag and Broker Metrics

> [!NOTE]
> Kafka's operational health is invisible without active monitoring. A consumer group that is falling behind — processing payments slower than they arrive — will not throw an exception or log an obvious error. The only signal is a growing consumer lag metric. By the time a business stakeholder notices payments are delayed, the lag may represent hours of backlog. Build monitoring before you need it.

## What to Monitor

Kafka monitoring operates at three levels:

```
Level 1: Broker Health
  → Is the cluster healthy? Is the leader balanced? Are replicas in sync?
  → Metrics: UnderReplicatedPartitions, ActiveControllerCount, ISR changes

Level 2: Consumer Group Lag
  → Are consumers keeping up with producers?
  → Metrics: records-lag, records-lag-max, consumer group offset vs end offset

Level 3: Producer Health
  → Is production working? Are records being written successfully?
  → Metrics: record-send-rate, record-error-rate, request-latency
```

---

## JMX Metrics

Kafka exposes all internal metrics via JMX (Java Management Extensions). Every broker, producer, and consumer has hundreds of JMX metrics. The challenge is selecting the right ones.

### Enabling JMX on Brokers

```bash
# In kafka-server-start.sh or Kafka environment variables
export JMX_PORT=9999
export KAFKA_JMX_OPTS="-Dcom.sun.management.jmxremote \
    -Dcom.sun.management.jmxremote.authenticate=false \
    -Dcom.sun.management.jmxremote.ssl=false \
    -Dcom.sun.management.jmxremote.port=9999 \
    -Djava.rmi.server.hostname=broker1.kafka.internal"
```

### Prometheus JMX Exporter Configuration

```yaml
# jmx-exporter-config.yml
startDelaySeconds: 0
ssl: false
lowercaseOutputName: true
lowercaseOutputLabelNames: true
rules:
  # Broker request metrics
  - pattern: "kafka.server<type=BrokerTopicMetrics, name=(.+), topic=(.+)><>(Count|OneMinuteRate)"
    name: "kafka_server_broker_topic_metrics_$1"
    labels:
      topic: "$2"
      type: "$3"

  # Controller metrics
  - pattern: "kafka.controller<type=KafkaController, name=(.+)><>Value"
    name: "kafka_controller_$1"

  # Consumer metrics
  - pattern: "kafka.consumer<type=consumer-fetch-manager-metrics, client-id=(.+)><>records-lag-max"
    name: "kafka_consumer_records_lag_max"
    labels:
      client_id: "$1"

  # Producer metrics
  - pattern: "kafka.producer<type=producer-metrics, client-id=(.+)><>record-send-rate"
    name: "kafka_producer_record_send_rate"
    labels:
      client_id: "$1"
```

```yaml
# Kubernetes deployment for JMX exporter sidecar
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: kafka
      image: confluentinc/cp-kafka:7.6.0
    - name: jmx-exporter
      image: bitnami/jmx-exporter:0.19.0
      args: ["9404", "/etc/jmx-exporter/config.yml"]
      ports:
        - containerPort: 9404
          name: jmx-metrics
```

---

## Critical Broker Metrics

### UnderReplicatedPartitions

```
kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions

Healthy value: 0
Alert threshold: > 0 for more than 60 seconds

Meaning: Partitions where not all replicas have caught up with the leader.
  - Value > 0 means data durability is reduced
  - If a broker fails while partitions are under-replicated, messages may be lost
  - Common cause: broker is overloaded, network issue, or rebalancing

Immediate action: Check broker logs, check network connectivity,
  check disk space and I/O on the lagging broker.
```

### ActiveControllerCount

```
kafka.controller:type=KafkaController,name=ActiveControllerCount

Healthy value: 1 (exactly one controller per cluster)
Alert threshold: != 1

Value = 0: No controller — cluster is unavailable
Value > 1: Split brain — multiple controllers (critical failure)
```

### RequestHandlerAvgIdlePercent

```
kafka.server:type=KafkaRequestHandlerPool,name=RequestHandlerAvgIdlePercent

Healthy value: > 0.3 (30% idle — handlers have headroom)
Alert threshold: < 0.2 for more than 5 minutes

Meaning: If request handlers are < 20% idle, the broker is overloaded.
  - Slow responses to producers and consumers
  - Replication may fall behind
  - Consider adding brokers or reducing load
```

### Full Broker Health Check

```java
import org.apache.kafka.clients.admin.*;
import org.springframework.stereotype.Component;
import org.springframework.scheduling.annotation.Scheduled;

@Component
public class KafkaBrokerHealthChecker {

    @Autowired private AdminClient adminClient;
    @Autowired private MeterRegistry meterRegistry;
    @Autowired private AlertService alertService;

    @Scheduled(fixedDelay = 60_000)
    public void checkBrokerHealth() throws Exception {
        // Check under-replicated partitions via describe topics
        DescribeClusterResult cluster = adminClient.describeCluster();
        Collection<Node> nodes = cluster.nodes().get();

        meterRegistry.gauge("kafka.cluster.broker.count", nodes.size());

        // Check topic partition health
        ListTopicsResult topics = adminClient.listTopics();
        Set<String> topicNames = topics.names().get();

        DescribeTopicsResult topicDetails = adminClient.describeTopics(
                new ArrayList<>(topicNames));
        Map<String, TopicDescription> descriptions = topicDetails.all().get();

        int underReplicated = 0;
        int offlinePartitions = 0;

        for (TopicDescription td : descriptions.values()) {
            for (TopicPartitionInfo pi : td.partitions()) {
                if (pi.replicas().size() != pi.isr().size()) {
                    underReplicated++;
                }
                if (pi.leader() == null) {
                    offlinePartitions++;
                }
            }
        }

        meterRegistry.gauge("kafka.partitions.under_replicated", underReplicated);
        meterRegistry.gauge("kafka.partitions.offline", offlinePartitions);

        if (underReplicated > 0) {
            alertService.sendAlert(AlertSeverity.HIGH,
                    "Kafka has " + underReplicated + " under-replicated partitions");
        }
        if (offlinePartitions > 0) {
            alertService.sendAlert(AlertSeverity.CRITICAL,
                    "Kafka has " + offlinePartitions + " offline partitions");
        }
    }
}
```

---

## Consumer Lag Monitoring

Consumer lag is the most important operational metric for financial Kafka systems. It directly answers: "How far behind are we in processing payments?"

```
Consumer Lag = End Offset (latest message) − Current Offset (last consumed)

Example:
  payments.events partition 0:
    Latest offset: 1,000,000
    Consumer group "settlement-service" committed offset: 999,500
    Lag = 500 messages
```

### Spring Boot Consumer Lag Metrics

Micrometer (via Spring Kafka) exposes consumer lag automatically:

```properties
# application.properties
management.metrics.enable.kafka.consumer=true
```

The metric name is:
```
kafka.consumer.fetch-manager-metrics.records-lag{client-id="...", topic="...", partition="..."}
```

### Manual Lag Monitoring

```java
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.ListConsumerGroupOffsetsResult;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;

@Component
public class ConsumerLagMonitor {

    @Autowired private AdminClient adminClient;
    @Autowired private MeterRegistry meterRegistry;
    @Autowired private AlertService alertService;

    private static final Map<String, Long> LAG_ALERT_THRESHOLDS = Map.of(
            "settlement-service", 1_000L,       // Alert if 1000+ messages behind
            "notification-service", 5_000L,     // Less critical — higher threshold
            "compliance-archival", 50_000L      // Batch processing — high threshold OK
    );

    @Scheduled(fixedDelay = 30_000)
    public void monitorConsumerLag() throws Exception {
        for (Map.Entry<String, Long> entry : LAG_ALERT_THRESHOLDS.entrySet()) {
            String groupId = entry.getKey();
            long alertThreshold = entry.getValue();

            Map<TopicPartition, Long> lag = calculateLag(groupId);

            long totalLag = lag.values().stream().mapToLong(Long::longValue).sum();
            long maxPartitionLag = lag.values().stream().mapToLong(Long::longValue).max()
                    .orElse(0L);

            // Record metrics
            meterRegistry.gauge("kafka.consumer.group.lag.total",
                    Tags.of("group", groupId), totalLag);
            meterRegistry.gauge("kafka.consumer.group.lag.max.partition",
                    Tags.of("group", groupId), maxPartitionLag);

            // Alert if threshold exceeded
            if (totalLag > alertThreshold) {
                alertService.sendAlert(AlertSeverity.HIGH,
                        String.format("Consumer group %s lag = %d (threshold: %d)",
                                groupId, totalLag, alertThreshold));
            }

            // Per-partition breakdown for debugging
            lag.forEach((tp, partLag) -> {
                if (partLag > 0) {
                    meterRegistry.gauge("kafka.consumer.partition.lag",
                            Tags.of("group", groupId, "topic", tp.topic(),
                                    "partition", String.valueOf(tp.partition())),
                            partLag);
                }
            });
        }
    }

    private Map<TopicPartition, Long> calculateLag(String groupId) throws Exception {
        // Get committed offsets for the consumer group
        Map<TopicPartition, OffsetAndMetadata> committedOffsets =
                adminClient.listConsumerGroupOffsets(groupId)
                        .partitionsToOffsetAndMetadata().get();

        if (committedOffsets.isEmpty()) {
            return Map.of();
        }

        // Get the end offsets (latest message position)
        Map<TopicPartition, Long> endOffsets =
                adminClient.listOffsets(
                        committedOffsets.keySet().stream()
                                .collect(Collectors.toMap(
                                        tp -> tp,
                                        tp -> OffsetSpec.latest()
                                ))
                ).all().get()
                .entrySet().stream()
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        e -> e.getValue().offset()
                ));

        // Calculate lag per partition
        return committedOffsets.entrySet().stream()
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        e -> Math.max(0, endOffsets.getOrDefault(e.getKey(), 0L)
                                - e.getValue().offset())
                ));
    }
}
```

### CLI Lag Check

```bash
# Check consumer group lag for all topics
kafka-consumer-groups.sh \
    --bootstrap-server kafka:9092 \
    --group settlement-service \
    --describe

# Output:
# GROUP              TOPIC            PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# settlement-service payments.events  0          998432          999001          569
# settlement-service payments.events  1          997861          998400          539
# settlement-service payments.events  2          999100          999200          100

# Total lag = 569 + 539 + 100 = 1208 messages
```

---

## Burrow for Consumer Lag Monitoring

LinkedIn's **Burrow** is a dedicated Kafka consumer monitoring tool that evaluates consumer group health over time:

```yaml
# burrow.toml — Burrow configuration
[zookeeper]
servers=["zk1:2181", "zk2:2181", "zk3:2181"]

[kafka.payment-cluster]
servers=["broker1:9092", "broker2:9092", "broker3:9092"]

[consumer.payment-cluster]
cluster="payment-cluster"
servers=["broker1:9092"]

[httpserver.default]
address=":8000"

[storage.default]
class="inmemory"
intervals=10
expire-group=604800  # 7 days
```

Burrow classifies consumer groups as:
- `OK` — consuming faster than producing
- `WARNING` — lag growing slowly
- `ERROR` — lag growing quickly or consumer stopped

---

## Grafana Dashboard for Kafka

Key panels for a Kafka Grafana dashboard:

```json
{
    "panels": [
        {
            "title": "Consumer Lag by Group",
            "type": "timeseries",
            "targets": [{
                "expr": "sum by (group) (kafka_consumer_group_lag_total)",
                "legendFormat": "{{group}}"
            }]
        },
        {
            "title": "Under-Replicated Partitions",
            "type": "stat",
            "targets": [{
                "expr": "kafka_partitions_under_replicated",
                "thresholds": {"steps": [{"value": 0, "color": "green"}, {"value": 1, "color": "red"}]}
            }]
        },
        {
            "title": "Broker Request Handler Idle %",
            "type": "timeseries",
            "targets": [{
                "expr": "kafka_server_request_handler_avg_idle_percent",
                "legendFormat": "{{broker}}"
            }]
        },
        {
            "title": "Messages In Per Second (by topic)",
            "type": "timeseries",
            "targets": [{
                "expr": "rate(kafka_server_broker_topic_metrics_messagesin_count[5m])",
                "legendFormat": "{{topic}}"
            }]
        }
    ]
}
```

---

## Alerting Rules

```yaml
# prometheus-alerts.yml
groups:
  - name: kafka-critical
    rules:
      - alert: KafkaOfflinePartitions
        expr: kafka_partitions_offline > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "{{ $value }} offline partitions — cluster data loss risk"

      - alert: KafkaUnderReplicatedPartitions
        expr: kafka_partitions_under_replicated > 0
        for: 60s
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} under-replicated partitions"

      - alert: KafkaConsumerLagSpike
        expr: kafka_consumer_group_lag_total{group="settlement-service"} > 1000
        for: 5m
        labels:
          severity: high
        annotations:
          summary: "Settlement service consumer lag = {{ $value }} messages"

      - alert: KafkaBrokerDown
        expr: kafka_cluster_broker_count < 3
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Kafka cluster has only {{ $value }} brokers (expected 3)"

      - alert: KafkaRequestHandlerOverloaded
        expr: kafka_server_request_handler_avg_idle_percent < 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kafka request handlers < 20% idle — broker may be overloaded"
```

---

## Key Takeaways

- **Consumer lag** is the most critical operational metric — a consumer falling behind is a silent failure that becomes a business incident.
- Expose JMX metrics via Prometheus JMX Exporter; use Micrometer in Spring Boot for automatic consumer metrics.
- **UnderReplicatedPartitions=0** must hold at all times — any value above 0 reduces data durability.
- **ActiveControllerCount=1** exactly — 0 means the cluster is unavailable, >1 means split brain.
- **RequestHandlerAvgIdlePercent > 0.3** — below 20% the broker is overloaded and needs capacity.
- Use `kafka-consumer-groups.sh` for quick lag checks; build automated monitoring for continuous alerting.
- Set lag alert thresholds per consumer group based on the business SLA: settlement (strict), notifications (lenient), archival (very lenient).
- Consumer lag + Grafana dashboard + Prometheus alerts is the minimum monitoring stack for a production financial Kafka cluster.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What does consumer lag represent and why is it the most critical operational metric for a payment Kafka system?",
      "options": [
        "The network latency between producer and broker",
        "The number of partitions without an active consumer",
        "The difference between the latest partition offset and the consumer group's committed offset — directly measuring how far behind payment processing is",
        "The time since the last broker restart"
      ],
      "correct": 2,
      "explanation": "Consumer lag = end offset - committed offset. For a payment settlement consumer, lag directly means 'this many payments are waiting to be processed.' A growing lag is a silent failure — no exception is thrown, but payment settlement is falling behind, which becomes a business incident."
    },
    {
      "text": "What does ActiveControllerCount != 1 indicate about a Kafka cluster?",
      "options": [
        "The cluster has too many brokers for the current load",
        "ActiveControllerCount=0 means the cluster has no active controller and is unavailable; >1 indicates split-brain",
        "The monitoring agent is not reading JMX metrics correctly",
        "One broker is performing leader election which is normal"
      ],
      "correct": 1,
      "explanation": "Exactly one Kafka broker must be the active controller at all times. ActiveControllerCount=0 means no broker has been elected controller — the cluster cannot accept producer or consumer connections. ActiveControllerCount>1 would indicate split-brain (a catastrophic state). Both are critical alerts requiring immediate response."
    },
    {
      "text": "Why should lag alert thresholds differ between consumer groups like settlement-service and compliance-archival?",
      "options": [
        "Different groups use different serialization formats that affect lag calculation",
        "Different consumer groups have different business SLAs — settlement requires near-real-time processing while archival can tolerate large backlogs",
        "Compliance archival processes larger message payloads so has inherently higher lag",
        "Alert thresholds should always be identical for consistency"
      ],
      "correct": 1,
      "explanation": "Settlement service processes financial transactions — a lag of 1,000 messages may mean payments delayed. Compliance archival stores records for audit — a lag of 50,000 messages is acceptable if it catches up within hours. Thresholds must reflect business SLAs, not technical uniformity."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Complete Kafka Monitoring Stack for a Payment Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "Implement a ConsumerLagMonitor that uses AdminClient to calculate lag per partition for three consumer groups (settlement-service threshold: 1,000; notification-service: 5,000; compliance-archival: 50,000). Register Prometheus gauges for total lag and max partition lag per group. Send HIGH severity alerts when thresholds are exceeded."},
    {"id": "2", "description": "Expose JMX broker metrics via the Prometheus JMX Exporter for UnderReplicatedPartitions, ActiveControllerCount, OfflinePartitionsCount, and RequestHandlerAvgIdlePercent. Configure Prometheus scraping and implement alert rules: UnderReplicatedPartitions>0 (warning), ActiveControllerCount!=1 (critical), OfflinePartitions>0 (critical), RequestHandlerAvgIdlePercent<0.2 (warning)."},
    {"id": "3", "description": "Build a Grafana dashboard with four panels: (1) consumer lag time-series by group, (2) under-replicated partitions stat with red threshold at 1, (3) broker request handler idle % time-series with 20% alert line, (4) messages in per second by topic. Export the dashboard JSON for GitOps deployment."},
    {"id": "4", "description": "Configure Burrow to monitor the payment-cluster, categorise consumer groups as OK/WARNING/ERROR, and expose health status via its HTTP API. Implement a Spring Boot health indicator that queries Burrow's API and reports DOWN if any monitored consumer group is in ERROR state for more than 5 minutes."}
  ]
}
-->
