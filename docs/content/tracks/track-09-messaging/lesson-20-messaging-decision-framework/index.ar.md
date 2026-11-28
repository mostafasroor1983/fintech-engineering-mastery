---
id: track-09-lesson-20
title: "إطار المهندس الرئيسي لقرارات أنظمة الرسائل"
slug: messaging-decision-framework
track: track-09
trackName: "الرسائل وتدفق البيانات وتكامل الأنظمة"
sequence: 20
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, messaging, trade-offs, staff-engineer, broker]
prerequisites: ["track-09-lesson-01", "track-09-lesson-19", "track-09-lesson-12", "track-09-lesson-13"]
---

# إطار قرارات المراسلة للمهندس الرئيسي

> [!NOTE]
> بصفتك مهندسًا رئيسيًا أو مهندس طاقم (staff)، أنت مسؤول عن قرارات بنية المراسلة التي ستقيّد منصتك لـ 3–5 سنوات. والهدف ليس اختيار أعقد تقنية — بل اختيار التقنية الصحيحة لسياقك، وتوثيق منطقك، وجعل المفاضلات صريحة. وهذا الدرس إطار قائم على قوائم التحقق، لا درس تعليمي. استخدمه في مراجعات البنية، ووثائق RFC، ونقاشات الاستراتيجية التقنية.

## لماذا تلتصق قرارات بنية المراسلة

قرارات المراسلة مكلفة العكس:

- **ترحيل البيانات** — نقل تيرابايتات من الأحداث المحفوظة مشروع يمتد أشهرًا
- **اقتران المستهلكين** — تغيير مخططات الرسائل أو الوسطاء يتطلب تنسيق كل الخدمات المستهلكة
- **الذاكرة العضلية التشغيلية** — تتعلم الفرق الأنماط التشغيلية لوسيط واحد؛ وتغيير الوسيط يتطلب إعادة تدريب
- **ترقيم إصدارات العقود** — مخططات الأحداث المنشورة لشركاء خارجيين أو جهات رقابية لا يمكن تغييرها من طرف واحد
- **التكلفة** — بنية الوسيط التحتية ومراقبته وخبرته تكاليف مستمرة كبيرة

اتخذ هذه القرارات بتأنٍّ، مع توثيق صريح للبدائل التي دُرست والمفاضلات التي قُبلت.

## إطار اختيار الوسيط

### شجرة القرار

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

## مصفوفة مقارنة الوسطاء

مقارنة نوعية — فحدود الخدمات المُدارة وميزاتها تتغير، فراجع التوثيق الحالي قبل القرار:

| البُعد | Kafka | RabbitMQ | AWS SQS/SNS | Azure Service Bus | Pulsar |
|-----------|-------|---------|-------------|-------------------|--------|
| الإنتاجية | عالية جدًا (تتوسع بالأقسام) | معتدلة لكل طابور؛ وتتوسع بطوابير / تدفقات كثيرة | الطوابير القياسية: عالية جدًا؛ FIFO: محدودة لكل مجموعة رسائل | معتدلة؛ تتوسع بوحدات المراسلة الممتازة (وEvent Hubs خيار Azure عالي الإنتاجية) | عالية جدًا |
| الاحتفاظ | بحسب الوقت/الحجم، حتى بلا حد؛ والضغط | حتى ACK (التدفقات: بحسب الوقت/الحجم) | حتى 14 يومًا، حتى الحذف | حتى الاستهلاك / TTL | بحسب الوقت/الحجم، وتخزين متدرج |
| إعادة التشغيل | نعم | التدفقات فقط | لا | لا | نعم |
| الترتيب | لكل قسم | لكل طابور (مستهلك واحد) | ‏FIFO: لكل MessageGroupId | لكل جلسة | لكل قسم / مفتاح |
| مرة واحدة بالضبط | داخل Kafka (المعاملات) | لا — مرة على الأقل + تساوي القوة | ‏FIFO: إزالة تكرار ضمن نافذة 5 دقائق | كشف التكرار ضمن نافذة زمنية | المعاملات |
| تطور المخطط | Schema Registry | على مستوى التطبيق | على مستوى التطبيق | على مستوى التطبيق | سجل مخططات مدمج |
| الخيار المُدار | MSK، وConfluent Cloud، وغيرها | Amazon MQ، وCloudAMQP | أصلي في AWS | أصلي في Azure | StreamNative وغيرها |
| تعدد المستأجرين | ACLs، والحصص، واصطلاحات التسمية | عبر vhosts | لكل حساب / طابور | عبر namespaces | أصلي (مستأجرون، وnamespaces) |
| النسخ الجغرافي | MirrorMaker 2، وCluster Linking | Federation / Shovel | لكل منطقة (تبنيه بنفسك) | التعافي من الكوارث / النسخ الجغرافي (الممتاز) | مدمج |

## دليل اختيار ضمان التسليم

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

## شجرة قرار متطلبات الترتيب

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

## قائمة تحقق استراتيجية تطور المخططات

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

## قرارات تصميم DLQ

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

## قائمة تحقق متطلبات المراقبة

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

## اعتبارات التكلفة في التقنية المالية

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

## قالب سجل القرار المعماري

استخدم هذا القالب عند توثيق قرارات المراسلة:

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

## الختام: قائمة تحقق المراسلة للمهندس الرئيسي

قبل اعتماد أي بنية مراسلة لنظام مالي:

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

## الخلاصات الأساسية

- قرارات المراسلة تلتصق — وثّق المفاضلات صراحة بسجلات القرار المعماري (ADR) قبل أن تقرر، لا بعده.
- السؤال الحاسم لاختيار الوسيط هو **دلالات الرسالة** (حدث مقابل مهمة) و**متطلب الاحتفاظ** (إعادة التشغيل مقابل الحذف بعد ACK).
- يجب تحديد ضمان التسليم لكل موضوع بناءً على تكلفة الرسالة المفقودة أو المكررة — لا كسياسة شاملة.
- يمنع Schema Registry مع فرض توافق FULL كسر المستهلكين الصامت — فاجعله إلزاميًا في CI/CD.
- تصميم DLQ ليس فكرة لاحقة: صنّف الإخفاقات، وحدد اتفاقيات مستوى الخدمة لكل فئة، وأتمت إعادة التشغيل للإخفاقات العابرة.
- يجب أن تكون المراقبة جاهزة قبل الإطلاق — فتأخر المستهلكين، وصحة الوسطاء، ومقاييس DLQ هي الحد الأدنى القابل للتطبيق.
- استخدم قائمة التحقق هذه في مراجعات البنية، لا كتدقيق بعد النشر. فالوقاية أرخص بكثير من العلاج.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تحتاج خدمة تعليمات تسوية جديدة لاستهلاك أحداث الدفع. ويجب أن تستهلك خدمة أرشفة امتثال قائمة الأحداث نفسها أيضًا. وتتطلب تعليمات التسوية دلالات المرة الواحدة بالضبط. أي وسيط وإعداد هو الأنسب؟",
      "options": [
        "‏AWS SQS FIFO — يزيل تكرار الرسائل عبر MessageDeduplicationId",
        "‏Kafka — يتيح النموذج القائم على السجل مجموعات مستهلكين مستقلة للتسوية والامتثال؛ وتوفر Kafka EOS ‏(منتج معاملاتي + read_committed) المرة الواحدة بالضبط للتسوية",
        "‏RabbitMQ بمبادلة fanout — تبث إلى الطابورين في وقت واحد",
        "‏Azure Service Bus — توفر الجلسات ترتيبًا بمرة واحدة بالضبط"
      ],
      "correct": 1,
      "explanation": "نموذج Kafka القائم على السجل هو الخيار الصحيح حين تحتاج خدمات مستقلة متعددة الرسائل نفسها (لكل منها مجموعة مستهلكين وإزاحة خاصة). أما SQS فطابور — فالرسالة المستهلكة والمحذوفة تختفي عن المستهلكين الآخرين، وإزالة التكرار في FIFO تغطي نافذة 5 دقائق فقط. وتسلّم مبادلة fanout في RabbitMQ نسخة لكل طابور لكنها تتطلب إدارة طوابير منفصلة وتفتقر إلى إعادة التشغيل. وتعطي Kafka EOS ‏(منتج معاملاتي + مستهلك بـ isolation.level=read_committed) المرة الواحدة بالضبط لخطوات Kafka-إلى-Kafka؛ وحين تستدعي خدمة التسوية بعدها بنكًا أو تكتب في قاعدة بيانات، يظل مفتاح تساوي القوة لازمًا لذلك الأثر الجانبي. أما جلسات Azure Service Bus فتوفر الترتيب، لا نموذج السجل متعدد المستهلكين هذا."
    },
    {
      "text": "يلزم تغيير مخطط موضوع payments.events: يجب إضافة حقل إلزامي جديد 'regulatory_code'. ويستخدم الفريق Avro بوضع توافق FULL. ما إجراء الترحيل الصحيح؟",
      "options": [
        "أضف 'regulatory_code' كحقل إلزامي بلا قيمة افتراضية وانشر المنتجين أولًا",
        "أضف 'regulatory_code' كحقل اختياري بقيمة افتراضية في مخطط V2؛ وانشر المستهلكين للتعامل مع الحقل الجديد (الذين سيتلقون null/القيمة الافتراضية للسجلات القديمة)؛ ثم انشر المنتجين لملئه",
        "احذف الموضوع وأعد إنشاءه بالمخطط الجديد — فتوافق FULL ينطبق فقط خلال عمر الموضوع",
        "غيّر وضع التوافق إلى NONE طوال مدة الترحيل، ثم أعده إلى FULL"
      ],
      "correct": 1,
      "explanation": "يعني توافق FULL أن المخططات الجديدة متوافقة للخلف (المستهلكون بالمخطط الجديد يقرؤون السجلات القديمة) ومتوافقة للأمام (المستهلكون بالمخطط القديم يقرؤون السجلات الجديدة). والحقل الإلزامي بلا قيمة افتراضية يكسر التوافق للخلف: فالقارئ بالمخطط الجديد لا يستطيع قراءة السجلات القديمة، إذ لا قيمة يملأ بها الحقل الناقص. والإجراء الآمن: أضف الحقل اختياريًا بقيمة افتراضية ← انشر المستهلكين ← انشر المنتجين لملئه ← واملأ القديم اختياريًا. ويُفرض 'الإلزام' حينها بالتحقق في منطق العمل، لا بالمخطط. ولا تستخدم NONE أبدًا في الإنتاج ولا تحذف مواضيع تحتفظ بأحداث مالية."
    },
    {
      "text": "تتراكم إدخالات في DLQ منذ 6 ساعات. ويريد مهندس المناوبة إعادة تشغيل كل رسائل DLQ إلى الموضوع الأصلي. ما الشرط المسبق الذي يجب التحقق منه قبل بدء إعادة التشغيل الآلية؟",
      "options": [
        "يجب إعادة تشغيل كل رسائل DLQ فورًا — فالتأخير يزيد خطر فقدان البيانات",
        "تحقق من فئة الإخفاق: فإخفاقات TRANSIENT فقط (مهل الخدمات اللاحقة، وعدم التوفر المؤقت) آمنة لإعادة التشغيل الآلية؛ أما إخفاقات SCHEMA وBUSINESS فتتطلب تحقيقًا يدويًا أولًا",
        "تأكد من أن تأخر المستهلك على الموضوع الرئيسي صفر قبل إدخال رسائل أخرى",
        "تأكد من أن DLQ يحوي أقل من 1,000 رسالة لمنع إعادة التشغيل من إغراق المستهلك"
      ],
      "correct": 1,
      "explanation": "إعادة التشغيل الآلية آمنة فقط لإخفاقات TRANSIENT — الناتجة عن ظروف مؤقتة زالت منذ ذلك الحين (مهلة خدمة لاحقة، أو انقطاع شبكة عابر). أما إخفاقات SCHEMA (أخطاء إلغاء التسلسل) فستفشل مجددًا عند إعادة التشغيل لأن الرسالة ما زالت تالفة. وستفشل إخفاقات BUSINESS (رفض التحقق) مجددًا أيضًا لأن قاعدة العمل لم تتغير. وإعادة تشغيل هذه الفئات دون تحقيق تخلق حلقة لا نهائية في DLQ. ويوصي قسم تصميم DLQ في الدرس صراحة بتصنيف الإخفاقات وأتمتة إعادة التشغيل لـ TRANSIENT فقط."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "قرار بنية المراسلة وسجل ADR لمنصة دفع جديدة",
  "difficulty": "principal",
  "estimatedMinutes": 65,
  "tasks": [
    "باستخدام شجرة قرار اختيار الوسيط من هذا الدرس، قيّم ثلاثة خيارات (Kafka على MSK، وAWS SQS+SNS، وRabbitMQ مُدار ذاتيًا) لمنصة دفع جديدة بالمتطلبات: إنتاجية ذروة 200 ألف رسالة/ثانية، وإعادة تشغيل الأحداث 7 أيام للامتثال، و4 خدمات مستهلكة مستقلة، ونشر أصلي في AWS، وفريق من 8 بخبرة Kafka متوسطة. ووثّق تقييمك في ADR باستخدام القالب المقدم في الدرس.",
    "صمم مصفوفة ضمانات التسليم للمنصة: اربط كل موضوع (payments.events، وfraud.checks، وsettlement.instructions، وnotifications.email) بالضمان المناسب (مرة على الأكثر / مرة على الأقل / مرة واحدة بالضبط داخل Kafka) مع آلية تساوي القوة للآثار الجانبية خارج Kafka، بناءً على إطار تحليل تكلفة الفقدان وتكلفة التكرار من الدرس. ووثّق المنطق لكل موضوع.",
    "نفّذ خدمة إدارة DLQ: (1) تستهلك من موضوع DLQ، (2) تصنّف كل إدخال إلى TRANSIENT / SCHEMA / BUSINESS / DESERIALIZATION بناءً على نوع الاستثناء المخزن في ترويسة، (3) تعيد تشغيل إدخالات TRANSIENT تلقائيًا بعد تأخير 60 ثانية، (4) توجّه إدخالات SCHEMA وBUSINESS إلى طوابير تنبيه منفصلة، (5) تسجّل كل الإجراءات مع بيانات تدقيق على مستوى المشغّل. واكتب اختبارات وحدة لكل مسار تصنيف.",
    "ابنِ فحص Schema Registry في CI/CD: خطوة في سير عمل GitHub Actions تستخدم واجهة REST لـ Confluent Schema Registry للتحقق من أن تغيير مخطط Avro المقترح لـ payments.events متوافق FULL قبل دمج طلب السحب. وإذا فشل الفحص، يجب أن يُخرج سير العمل خطأ التوافق المحدد ويمنع الدمج. واختبر سير العمل بتغيير متوافق (إضافة حقل اختياري) وتغيير غير متوافق (إعادة تسمية حقل)."
  ]
}
-->
