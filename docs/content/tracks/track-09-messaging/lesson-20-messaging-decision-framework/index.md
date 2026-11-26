---
id: track-09-lesson-20
title: "Principal Engineer's Messaging Decision Framework"
slug: messaging-decision-framework
track: track-09
trackName: "Kafka & Event-Driven Architecture"
sequence: 20
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, messaging, trade-offs, staff-engineer, broker]
prerequisites: [kafka-architecture, rabbitmq-vs-kafka, kafka-security, kafka-performance]
---

# Principal Engineer's Messaging Decision Framework

> [!NOTE]
> As a principal or staff engineer, you are accountable for messaging architecture decisions that will constrain your platform for 3–5 years. The goal is not to pick the most sophisticated technology — it is to pick the right technology for your context, document your reasoning, and make the trade-offs explicit. This lesson is a checklist-driven framework, not a tutorial. Use it in architecture reviews, RFC documents, and technical strategy discussions.

## Why Messaging Architecture Decisions Are Sticky

Messaging decisions are expensive to reverse:

- **Data migration** — moving terabytes of retained events is a multi-month project
- **Consumer coupling** — changing message schemas or brokers requires coordinating all consuming services
- **Operational muscle memory** — teams learn one broker's operational patterns; changing brokers requires retraining
- **Contract versioning** — event schemas published to external partners or regulators cannot be changed unilaterally
- **Cost** — broker infrastructure, monitoring, and expertise are significant ongoing costs

Make these decisions deliberately, with explicit documentation of the alternatives considered and the trade-offs accepted.

---

## Broker Selection Framework

### Decision Tree

```
START: What problem are you solving?

1. Do you need messages to survive consumption (replay)?
   NO  → Can use RabbitMQ or SQS/SNS
   YES → Kafka or Pulsar (managed log services also allow
         replay: Kinesis, Event Hubs, Pub/Sub with seek --
         with limited retention)

2. Do multiple independent services need the same messages?
   NO  → Task queue: RabbitMQ, SQS
   YES → Log-based: Kafka, Pulsar

3. What is your expected throughput?
   <50k msg/s  → Any broker works; choose by ecosystem fit
   50k–500k/s  → Kafka (self-managed) or Pulsar
   >500k/s     → Kafka (definitely)

4. What is your cloud strategy?
   AWS-first   → MSK (managed Kafka, also serverless) or SQS/SNS
   GCP-first   → Pub/Sub (serverless), or managed Kafka if Kafka is needed
   Azure-first → Event Hubs (Kafka-compatible) or Service Bus
   On-prem     → Kafka or RabbitMQ

5. What are your team's operational capabilities?
   Strong Kafka expertise → Kafka
   No streaming expertise → Start with SQS/SNS or Service Bus (managed)
   Need message routing  → RabbitMQ

6. Do you have event sourcing or CQRS requirements?
   YES → Kafka (compacted topics, consumer groups, replay)
```

---

## Broker Comparison Matrix

A qualitative comparison — limits and features of managed services change, so check current documentation before deciding:

| Dimension | Kafka | RabbitMQ | AWS SQS/SNS | Azure Service Bus | Pulsar |
|-----------|-------|---------|-------------|-------------------|--------|
| Throughput | Very high (scales with partitions) | Moderate per queue; scale with many queues / streams | Standard queues: very high; FIFO: limited per message group | Moderate; scales with premium messaging units (Event Hubs is Azure's high-throughput option) | Very high |
| Retention | Time/size based, up to forever; compaction | Until ACK (streams: time/size based) | Up to 14 days, until deleted | Until consumed / TTL | Time/size based, tiered storage |
| Replay | Yes | Streams only | No | No | Yes |
| Ordering | Per partition | Per queue (single consumer) | FIFO: per MessageGroupId | Per session | Per partition / key |
| Exactly-once | Within Kafka (transactions) | No — at-least-once + idempotency | FIFO: deduplication within a 5-minute window | Duplicate detection within a time window | Transactions |
| Schema evolution | Schema Registry | Application level | Application level | Application level | Built-in schema registry |
| Managed option | MSK, Confluent Cloud, others | Amazon MQ, CloudAMQP | Native AWS | Native Azure | StreamNative and others |
| Multi-tenancy | ACLs, quotas, naming conventions | Via vhosts | Per account / queue | Via namespaces | Native (tenants, namespaces) |
| Geo-replication | MirrorMaker 2, Cluster Linking | Federation / Shovel | Per region (build it yourself) | Geo-disaster recovery / geo-replication (premium) | Built-in |

---

## Delivery Guarantee Selection Guide

```
CHECKLIST: Choosing your delivery guarantee

[ ] What is the cost of a lost message?
    - Zero cost (telemetry) → at-most-once acceptable
    - Any real cost (notification, payment event, settlement
      instruction) → at-least-once: acks=all, retries, commit
      offsets only AFTER processing
    (exactly-once does not lose fewer messages than at-least-once --
     it removes DUPLICATES)

[ ] What is the cost of a duplicate message?
    - Zero cost (analytics counter) → at-least-once
    - Medium cost (email notification — annoying) → at-least-once with deduplication
    - High cost (payment processing — financial loss) → idempotent consumer at minimum
    - Catastrophic (double settlement) → exactly-once + idempotent consumer

[ ] Can all consumers be made idempotent?
    YES → at-least-once + idempotent consumers = effectively exactly-once at lower cost
    NO  → Kafka EOS for Kafka-to-Kafka, outbox pattern for Kafka-to-DB

[ ] Is the pipeline purely within Kafka?
    YES → Kafka EOS (producer transactions + read_committed)
    NO  → Outbox pattern (DB) + idempotent consumer (downstream)
    Kafka EOS never covers side effects OUTSIDE Kafka (a DB write,
    a call to a bank) -- those need idempotency keys

CONCLUSION:
    Financial payment events: at-least-once + idempotent consumers
    Settlement instructions: at-least-once + idempotency key that the
        receiving system (bank, ledger) deduplicates on -- plus Kafka EOS
        where the step is Kafka-to-Kafka
    Non-financial high-volume: at-least-once
    Telemetry: at-most-once is acceptable
```

---

## Ordering Requirement Decision Tree

```
[ ] Do you need ordering?
    NO → Any partition count, no key required. Use random keys for load distribution.

[ ] What must be ordered relative to what?
    Per-entity (per account, per payment) → partition key = entity ID
    Per-batch (all events in a settlement batch) → partition key = batch ID
    Global total order → single partition (throughput bottleneck, rarely needed)

[ ] Is there a hot entity (one account generating >10% of volume)?
    NO → Standard key-based partitioning
    YES → Sub-partition high-volume entities (key = entityId + suffix)
           → Dedicated topic for high-volume entities
           → Accept cross-sub-partition ordering using sequence numbers

[ ] What happens after a failure (rebalance, restart)?
    Per-partition order is kept, but records since the last commit are
    delivered AGAIN → idempotent consumer, or sequence numbers to skip
    already-applied events
    Producer side: enable.idempotence=true (default since Kafka 3.0)
    keeps order across retries

[ ] Does ordering need to be preserved across regions (MirrorMaker 2)?
    MirrorMaker 2 keeps the order within each replicated partition, but
    events for one entity written in TWO regions (active-active) have no
    common order → one home region per entity, or sequence numbers /
    versioned updates
```

---

## Schema Evolution Strategy Checklist

```
[ ] What serialisation format will you use?
    JSON (human-readable, no schema registry required, no versioning enforcement)
    Avro (compact, Schema Registry, good evolution with BACKWARD/FULL)
    Protobuf (field numbers = safe renames, good for cross-language)

[ ] What compatibility mode will you enforce?
    NONE — only during initial development, never in production
    BACKWARD — new consumers can read old data (add optional fields with defaults)
    FORWARD — old consumers can read new data (consumers skip unknown fields)
    FULL — both (recommended for financial systems — the safest single-step mode)
    FULL_TRANSITIVE — FULL against ALL previous versions (not just the last
        one) -- the most restrictive; needed when consumers may read very
        old retained records

[ ] How will schema changes be deployed?
    Manual check → error prone, do not use
    CI/CD schema check → run Schema Registry compatibility check on PR merge
    Schema ownership → designated schema owner per topic reviews all changes

[ ] What is your breaking change procedure?
    1. Add new optional field (backward compatible) in V2
    2. Deploy all consumers to handle V2 (may receive null for new field)
    3. Deploy producers to populate new field
    4. After migration window, remove old field if needed (new major version)
    Never: rename a field in Avro in one step -- use an alias (reader
    schema) or add the new field, migrate, then remove the old one

[ ] Do you publish events to external consumers (partners, regulators)?
    YES → Stability guarantee required: no breaking changes without 6-month notice
           Version in topic name: payments.events.v1, payments.events.v2
    NO  → Internal teams only: FULL compatibility with internal migration window
```

---

## DLQ Design Decisions

```
[ ] Do you have a DLQ per topic or per consumer group?
    Per consumer group (recommended) — different consumers have different error semantics
    Per topic — simpler but less informative

[ ] What is your retry strategy?
    Immediate retry (N times) → suitable for fast transient failures
    Exponential backoff via retry topics → suitable for downstream outages
    No retry → only for messages where retry is never safe (non-idempotent)

[ ] How many retry levels?
    1 level (immediate + DLQ) → simple workloads
    3 levels (10s, 60s, 600s) → recommended for payment processing
    5+ levels → rarely needed; consider whether the downstream issue is systemic

[ ] How do you handle the DLQ operationally?
    Manual review → suitable for low-volume DLQ
    Automated replay → suitable for TRANSIENT category failures only
    Categorisation + routing → recommended (TRANSIENT vs SCHEMA vs BUSINESS vs DESERIALIZATION)

[ ] What is your DLQ SLA?
    Define: within what time must DLQ entries be resolved?
    Example: CRITICAL category (schema) = 2 hours, TRANSIENT = 4 hours, BUSINESS = 24 hours

[ ] Is the DLQ audited for financial compliance?
    Every replay and discard must be logged with operator identity and timestamp
    DLQ entries for payment events are financial records — treat accordingly
```

---

## Monitoring Requirements Checklist

```
[ ] Consumer lag alerts per consumer group
    Define threshold per group based on business SLA
    Alert before the lag causes a business incident (not after)

[ ] Broker health metrics (minimum set):
    - UnderReplicatedPartitions = 0 (alert if > 0)
    - ActiveControllerCount summed over the cluster = 1 (alert if != 1)
    - OfflinePartitions = 0 (alert immediately if > 0)
    - RequestHandlerAvgIdlePercent > 0.3 (alert if < 0.2)

[ ] Producer health metrics:
    - record-send-rate (alert on significant drop)
    - record-error-rate (alert on any errors)
    - request-latency-avg (alert if > SLA)

[ ] DLQ monitoring:
    - Unresolved DLQ count (alert if accumulating)
    - DLQ entry age (alert on SLA violation)
    - DLQ spike detector (alert on sudden increase)

[ ] Schema Registry health:
    - API availability (alert if unreachable)
    - Schema compatibility check failures (alert in CI/CD pipeline)

[ ] Operational dashboards:
    - Consumer lag by consumer group (time-series)
    - Messages in/out per topic (time-series)
    - Broker request handler idle % (time-series)
    - DLQ entries by category (bar chart)
```

---

## Cost Considerations for Fintech

```
Self-Managed Kafka (AWS EC2 or bare metal):
  Pros: Maximum control, lowest per-message cost at scale
  Cons: Operational overhead (upgrades, cert rotation, broker balancing)
  When: Large teams (>5 engineers) with Kafka expertise, >10M msg/day

MSK (AWS Managed Kafka):
  Pros: Managed upgrades, integrated with AWS IAM, MSK Connect, a serverless option
  Cons: Higher cost than self-managed, some configuration limits
  When: AWS-native platform, want reduced operational overhead

Confluent Cloud:
  Pros: Full-featured (Schema Registry, managed connectors, Flink stream
        processing, Cluster Linking), strong vendor support
  Cons: Usually the highest list price, lock-in on proprietary features
  When: Need these managed features and want to run as little as possible

AWS SQS + SNS:
  Pros: Fully serverless, pay-per-use, no operational overhead
  Cons: No replay (SQS), max 14-day retention, FIFO throughput limits,
        AWS lock-in
  When: Task queues and fan-out on AWS, teams without Kafka expertise

RabbitMQ (self-managed):
  Pros: Mature, strong routing, low-latency
  Cons: Clustering complexity, no native long-term retention
  When: Task queue use cases, existing RabbitMQ expertise, complex routing needs
```

---

## Architecture Decision Record Template

Use this template when documenting messaging decisions:

```markdown
# ADR-NNN: [Broker/Pattern Decision Title]

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-NNN

## Context
[What problem are we solving? What constraints exist?]

## Decision
[What did we decide to do?]
- Broker: [Kafka / RabbitMQ / SQS / ...]
- Delivery guarantee: [at-least-once / exactly-once]
- Schema format: [Avro / Protobuf / JSON]
- Compatibility mode: [FULL / BACKWARD / ...]
- DLQ strategy: [retry levels, timeout]
- Ordering requirement: [per-entity / global / none]

## Alternatives Considered
| Alternative | Why rejected |
|-------------|-------------|
| Kafka EOS   | Transaction overhead not justified for telemetry (example) |
| RabbitMQ    | No replay capability for compliance audit |

## Consequences
Positive:
  - [What good outcomes does this decision produce?]

Negative:
  - [What constraints or costs does this introduce?]

Risks:
  - [What could go wrong? What is the mitigation?]

## Review Date
[When will this decision be revisited? e.g., Q2 2027]
```

---

## Final: Principal Engineer's Messaging Checklist

Before signing off on any messaging architecture for a financial system:

```
Reliability:
  [ ] Delivery guarantee defined per topic (not "eventual consistency" as a hand-wave)
  [ ] DLQ designed with retry levels, categorisation, and replay procedure
  [ ] Idempotent consumers designed for all at-least-once consumers
  [ ] Outbox pattern for any DB-to-Kafka write

Security:
  [ ] TLS for all broker traffic
  [ ] SASL/SCRAM or mTLS for authentication
  [ ] ACLs per service (least privilege, not wildcard WRITE)
  [ ] Credentials in Vault or Kubernetes Secrets (never in source code)
  [ ] PCI DSS / GDPR review completed

Operations:
  [ ] Consumer lag alerts configured (per group, threshold based on SLA)
  [ ] Broker health dashboard: UnderReplicated, ActiveController, RequestHandlerIdle
  [ ] DLQ monitoring: unresolved count + age alerts
  [ ] Certificate expiry monitoring (alert at 30 days)
  [ ] Runbook for consumer group reset, topic deletion, broker failover

Schema:
  [ ] Schema Registry configured with FULL or BACKWARD compatibility
  [ ] CI/CD schema compatibility check on every PR
  [ ] Schema change procedure documented (add → migrate → remove)
  [ ] External event contracts versioned separately

Performance:
  [ ] Throughput requirements validated against partition count
  [ ] Producer config: batch.size, linger.ms, compression per use case
  [ ] Consumer config: max.poll.records tuned to processing time
  [ ] Load test completed before go-live

Ordering:
  [ ] Partition key defined per topic based on ordering requirements
  [ ] Hot partition analysis completed
  [ ] Sequence numbers or Saga pattern for cross-service ordering

Disaster Recovery:
  [ ] Multi-region strategy defined (MirrorMaker 2 or accept single-region)
  [ ] RTO/RPO defined for messaging tier
  [ ] Failover runbook tested quarterly
```

---

## Key Takeaways

- Messaging decisions are sticky — document trade-offs explicitly using ADRs before you decide, not after.
- The decisive question for broker selection is **message semantics** (event vs task) and **retention requirement** (replay vs delete-after-ACK).
- Delivery guarantee must be defined per topic based on the cost of a lost or duplicated message — not as a blanket policy.
- Schema Registry with FULL compatibility enforcement prevents silent consumer breakage — make this mandatory in CI/CD.
- DLQ design is not an afterthought: categorise failures, define SLAs per category, automate replay for transient failures.
- Monitoring must be in place before go-live — consumer lag, broker health, and DLQ metrics are the minimum viable set.
- Use this checklist in architecture reviews, not as a post-deployment audit. Prevention is significantly cheaper than remediation.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A new settlement instruction service needs to consume payment events. The same events must also be consumed by an existing compliance archival service. Settlement instructions require exactly-once semantics. Which broker and configuration is most appropriate?",
      "options": [
        "AWS SQS FIFO — it deduplicates messages via MessageDeduplicationId",
        "Kafka — log-based model allows independent consumer groups for settlement and compliance; Kafka EOS (transactional producer + read_committed) provides exactly-once for settlement",
        "RabbitMQ with a fanout exchange — broadcasts to both queues simultaneously",
        "Azure Service Bus — sessions provide exactly-once ordering"
      ],
      "correct": 1,
      "explanation": "Kafka's log-based model is the right choice when multiple independent services need the same messages (each with its own consumer group and offset). SQS is a queue — a consumed and deleted message is gone for other consumers, and FIFO deduplication only covers a 5-minute window. RabbitMQ fanout delivers a copy to both queues but requires separate queue management and lacks replay. Kafka EOS (transactional producer + isolation.level=read_committed consumer) gives exactly-once for Kafka-to-Kafka steps; when the settlement service then calls a bank or writes to a database, an idempotency key is still needed for that side effect. Azure Service Bus sessions provide ordering, not this multi-consumer log model."
    },
    {
      "text": "A schema change is needed for the payments.events topic: a new required field 'regulatory_code' must be added. The team is using Avro with FULL compatibility mode. What is the correct migration procedure?",
      "options": [
        "Add 'regulatory_code' as a required field with no default and deploy producers first",
        "Add 'regulatory_code' as an optional field with a default value in V2 schema; deploy consumers to handle the new field (which will receive null/default for old records); then deploy producers to populate it",
        "Delete the topic and recreate it with the new schema — FULL compatibility only applies within a topic's lifetime",
        "Change the compatibility mode to NONE for the duration of the migration, then switch back to FULL"
      ],
      "correct": 1,
      "explanation": "FULL compatibility means new schemas are both backward compatible (consumers on the new schema can read old records) and forward compatible (consumers on the old schema can read new records). A required field with no default breaks backward compatibility: a reader using the new schema cannot read old records, because there is no value to fill in for the missing field. The safe procedure is: add the field as optional with a default → deploy consumers → deploy producers to populate it → optionally backfill. 'Required' is then enforced by business validation, not the schema. Never use NONE in production or delete topics with retained financial events."
    },
    {
      "text": "A DLQ has been accumulating entries for 6 hours. The on-call engineer wants to replay all DLQ messages back to the original topic. What precondition must be verified before initiating automated replay?",
      "options": [
        "All DLQ messages should be replayed immediately — delay increases risk of data loss",
        "Verify the failure category: only TRANSIENT failures (downstream timeouts, temporary unavailability) are safe to replay automatically; SCHEMA and BUSINESS failures require manual investigation first",
        "Confirm that consumer lag on the main topic is zero before introducing more messages",
        "Ensure the DLQ has fewer than 1,000 messages to prevent replay from overwhelming the consumer"
      ],
      "correct": 1,
      "explanation": "Automated replay is only safe for TRANSIENT failures — those caused by temporary conditions that have since resolved (downstream service timeout, network blip). SCHEMA failures (deserialization errors) will fail again on replay because the message is still malformed. BUSINESS failures (validation rejections) will also fail again because the business rule has not changed. Replaying these categories without investigation creates an infinite loop in the DLQ. The lesson's DLQ design section explicitly recommends categorising failures and automating replay only for TRANSIENT."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Messaging Architecture Decision and ADR for a New Payment Platform",
  "difficulty": "principal",
  "estimatedMinutes": 65,
  "tasks": [
    "Using the broker selection decision tree from this lesson, evaluate three options (Kafka on MSK, AWS SQS+SNS, RabbitMQ self-managed) for a new payment platform with requirements: 200k msg/s peak throughput, 7-day event replay for compliance, 4 independent consumer services, AWS-native deployment, team of 8 with moderate Kafka experience. Document your evaluation in an ADR using the template provided in the lesson.",
    "Design the delivery guarantee matrix for the platform: map each topic (payments.events, fraud.checks, settlement.instructions, notifications.email) to its appropriate guarantee (at-most-once / at-least-once / exactly-once within Kafka) plus the idempotency mechanism for side effects outside Kafka, based on the cost-of-loss and cost-of-duplicate analysis framework from the lesson. Document the reasoning for each topic.",
    "Implement a DLQ management service that: (1) consumes from a DLQ topic, (2) categorises each entry as TRANSIENT / SCHEMA / BUSINESS / DESERIALIZATION based on the exception type stored in a header, (3) automatically replays TRANSIENT entries after a 60-second delay, (4) routes SCHEMA and BUSINESS entries to separate alerting queues, (5) logs all actions with operator-level audit metadata. Write unit tests for each categorisation path.",
    "Build a Schema Registry CI/CD check: a GitHub Actions workflow step that uses the Confluent Schema Registry REST API to verify that a proposed Avro schema change for payments.events is FULL compatible before merging the PR. If the check fails, the workflow must output the specific compatibility error and block the merge. Test the workflow with both a compatible change (add optional field) and an incompatible change (rename a field)."
  ]
}
-->
