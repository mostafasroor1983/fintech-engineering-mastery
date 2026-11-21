---
id: track-02-lesson-12
title: "بروتوكولات Gossip والخوارزميات الوبائية"
slug: gossip-protocols
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 12
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [gossip, epidemic-algorithm, Cassandra, membership, SWIM]
prerequisites: []
---

# بروتوكولات Gossip والخوارزميات الوبائية

> [!NOTE]
> تشغّل بروتوكولات Gossip بعض أكثر قواعد البيانات الموزعة موثوقية في التقنية المالية: فـ Cassandra تستخدم Gossip لعضوية العنقود ونشر المخطط، وتصميم Dynamo الأصلي من Amazon (ورقة 2007) استخدم Gossip للعضوية أيضًا. (أما DynamoDB، الخدمة المُدارة، فلها تصميم مختلف يستخدم Multi-Paxos لكل قسم.) وفهم Gossip ضروري لتشغيل مخازن حالة المعاملات المبنية على Cassandra وتصحيح أخطائها وتوسيعها.

## تشبيه النميمة

ينشر بروتوكول Gossip المعلومات في العنقود بالطريقة نفسها التي تنتشر بها النميمة في مكتب: تختار كل عقدة دوريًا بضعة نظراء عشوائيين وتتبادل المعلومات معهم. ثم يخبر كل مستلم نظراء آخرين. وخلال عدد لوغاريتمي من الجولات تكون المعلومة قد وصلت إلى كل عقدة في العنقود.

وقوة Gossip في خصائصه:
- **لا مركزي**: لا منسّق واحد؛ وأي عقدة تستطيع نشر المعلومات
- **مرن**: أعطال العقد تبطئ التقارب فقط، ولا توقفه
- **قابل للتوسع**: التعقيد O(log N) جولة × انتشار ثابت، لا O(N)
- **متسق في النهاية**: تتقارب كل العقد إلى الحالة نفسها مع الوقت الكافي

في الأنظمة المالية لا يُستخدم Gossip لنسخ بيانات المعاملات (التي تتطلب ضمانات اتساق أقوى)، بل لـ **عضوية العنقود**، و**اكتشاف الأعطال**، و**تغييرات المخطط**، و**نشر الحالة الخفيفة**.

---

## أساسيات بروتوكول Gossip

### الخوارزمية الأساسية

في كل جولة Gossip:
1. تختار العقدة A عددًا k من النظراء العشوائيين (عامل **الانتشار** fan-out، عادة 2-3)
2. ترسل A ملخص حالتها الحالية إلى كل نظير
3. يرد كل نظير بأي معلومات لديه تنقص A
4. تحدّث A حالتها المحلية بالمعلومات الجديدة

```java
@Service
public class GossipEngine {

    private final NodeStateStore localState;
    private final MembershipView membershipView;
    private final GossipTransport transport;
    private final Random random = new SecureRandom();

    private static final int FAN_OUT = 3;
    private static final Duration GOSSIP_INTERVAL = Duration.ofMillis(1000);

    @Scheduled(fixedDelayString = "1000")
    public void runGossipRound() {
        // Select FAN_OUT random live members (excluding self)
        List<NodeDescriptor> livePeers = membershipView.liveMembers();
        List<NodeDescriptor> targets = selectRandom(livePeers, FAN_OUT);

        GossipDigest localDigest = localState.buildDigest();

        for (NodeDescriptor target : targets) {
            try {
                GossipSyn synMessage = GossipSyn.builder()
                    .senderId(localState.nodeId())
                    .senderGeneration(localState.generation())
                    .digest(localDigest)
                    .build();

                GossipAck ack = transport.sendSyn(target, synMessage);

                // Apply new information received from the peer
                applyAck(ack);

                // Send our missing data to the peer
                GossipAck2 ack2 = buildAck2(ack.requestedKeys());
                transport.sendAck2(target, ack2);

            } catch (GossipTransportException e) {
                // Gossip failure is not fatal — record the failure for
                // the failure detector, but continue the round
                membershipView.recordContactFailure(target.nodeId(), Instant.now());
            }
        }
    }

    private void applyAck(GossipAck ack) {
        for (NodeState state : ack.newStates()) {
            // update() keeps only newer information: higher generation first,
            // then higher heartbeat within the same generation
            localState.update(state);
        }
    }

    private List<NodeDescriptor> selectRandom(List<NodeDescriptor> peers, int count) {
        List<NodeDescriptor> copy = new ArrayList<>(peers);
        Collections.shuffle(copy, random);
        return copy.subList(0, Math.min(count, copy.size()));
    }
}
```

فشل Gossip ليس قاتلًا: يُسجَّل الفشل لكاشف الأعطال، وتستمر الجولة.

### إصدار الحالة بالجيل والنبض

تحتفظ كل عقدة بـ **جيل** (generation، يزيد عند إعادة التشغيل) و**نبض** (heartbeat، يزيد في كل جولة). ومعًا يشكلان ساعة منطقية تتيح للعقد تحديد أي المعلومات أحدث:

```java
@Component
public class NodeStateStore {

    // Generation: incremented when the node restarts (persisted to disk)
    // Heartbeat: incremented each gossip round (in-memory)
    private final long generation;
    private final AtomicLong heartbeat = new AtomicLong(0);

    // State map: nodeId → NodeState (generation, heartbeat, metadata)
    private final ConcurrentHashMap<String, NodeState> stateMap =
        new ConcurrentHashMap<>();

    public NodeStateStore(@Value("${node.id}") String nodeId,
                           GenerationStore generationStore) {
        this.generation = generationStore.loadOrCreate(nodeId);
        stateMap.put(nodeId, NodeState.initial(nodeId, generation));
    }

    @Scheduled(fixedDelayString = "1000")
    public void incrementHeartbeat() {
        long hb = heartbeat.incrementAndGet();
        stateMap.compute(localNodeId(), (id, state) ->
            state.withHeartbeat(hb));
    }

    /**
     * Builds a compact digest of all known node states.
     * This is exchanged with peers to identify what information
     * we need from each other.
     */
    public GossipDigest buildDigest() {
        return GossipDigest.of(
            stateMap.entrySet().stream()
                .collect(Collectors.toMap(
                    Map.Entry::getKey,
                    e -> DigestEntry.of(
                        e.getValue().generation(),
                        e.getValue().heartbeat())
                ))
        );
    }

    public boolean update(NodeState incoming) {
        return stateMap.compute(incoming.nodeId(), (id, current) -> {
            if (current == null) return incoming;
            // Higher generation always wins (node restarted)
            if (incoming.generation() > current.generation()) return incoming;
            // Same generation: higher heartbeat wins
            if (incoming.generation() == current.generation()
                    && incoming.heartbeat() > current.heartbeat()) return incoming;
            return current; // Our info is newer or equal
        }) != null;
    }
}
```

الجيل الأعلى يفوز دائمًا (أعيد تشغيل العقدة)، وداخل الجيل نفسه يفوز النبض الأعلى.

---

## مقاومة الإنتروبيا (Anti-Entropy)

**مقاومة الإنتروبيا** آلية مطابقة مبنية على Gossip تضمن أن كل نسخ البيانات تتقارب في النهاية إلى الحالة نفسها، حتى بعد أعطال جزئية. وبينما يستخدم Gossip العضوية نبضات خفيفة، يتبادل Gossip مقاومة الإنتروبيا مجاميع اختبارية فعلية للبيانات (أشجار Merkle) لاكتشاف التباعد وإصلاحه.

تستخدم Cassandra الإصلاح (repair) لمطابقة النسخ. ويجب على الأنظمة المالية التي تشغّل Cassandra إجراء عمليات إصلاح منتظمة لضمان اتساق سجلات المعاملات عبر النسخ:

```java
@Service
public class AntiEntropyRepairScheduler {

    private final CassandraSession cassandraSession;
    private final AlertingService alerting;

    /**
     * Schedule Cassandra repair for the transactions keyspace.
     * The hard rule: every range must be repaired within gc_grace_seconds
     * (default 10 days), or deleted data can come back. Many teams use a
     * tool such as Cassandra Reaper instead of hand-written scheduling.
     * During repair, the node exchanges Merkle tree digests with peers
     * and streams missing mutations.
     */
    @Scheduled(cron = "0 0 2 * * SUN")  // Every Sunday at 02:00 (Spring cron has 6 fields)
    public void scheduleWeeklyRepair() {
        log.info("Initiating weekly incremental repair for transactions keyspace");
        try {
            // Use nodetool repair via JMX
            StorageServiceMBean storageProxy = getStorageProxy();
            int repairJobId = storageProxy.repairAsync(
                "transactions",           // keyspace
                Map.of(
                    "incremental", "true",   // Only repair recently changed SSTables
                    "parallelism", "parallel",
                    "primaryRange", "true"   // Only repair ranges this node is primary for
                )
            );

            log.info("Repair job {} started", repairJobId);
            alerting.sendInfo("Cassandra repair started", "job=" + repairJobId);
        } catch (Exception e) {
            log.error("Failed to start Cassandra repair", e);
            alerting.sendWarning("Cassandra repair failed to start", e.getMessage());
        }
    }
}
```

القاعدة الصارمة: يجب إصلاح كل نطاق خلال `gc_grace_seconds` (افتراضيًا 10 أيام)، وإلا قد تعود بيانات محذوفة. وتستخدم فرق كثيرة أداة مثل Cassandra Reaper بدل الجدولة اليدوية.

---

## بروتوكول SWIM

‏**SWIM** ‏(Scalable Weakly-consistent Infection-style Process Group Membership) هو الأساس الأكاديمي لاكتشاف الأعطال الحديث المبني على Gossip. وهو يعالج نقطة الضعف الرئيسية في أساليب النبض البسيطة — الإنذارات الكاذبة من مشكلات الشبكة العابرة — عبر **الفحص غير المباشر**.

### خوارزمية SWIM لاكتشاف الأعطال

```
Direct probe:
  Node A pings Node B
  If B doesn't respond within timeout:
    A does NOT immediately mark B as failed

Indirect probe:
  A asks k other nodes (C, D, E) to ping B on A's behalf
  If none of C, D, E can reach B either:
    B is marked as SUSPECTED
  After a grace period with no response from B:
    B is marked as FAILED and gossip spreads

This prevents false positives when A and B have a temporary network issue
but B is reachable from the rest of the cluster.
```

إذا لم ترد B على فحص A المباشر، لا تعلّمها A معطلة فورًا، بل تطلب من k عقد أخرى فحصها نيابة عنها. فإن لم تصل إليها أي منها تُعلَّم B "مشتبهًا بها"، وبعد مهلة سماح دون رد تُعلَّم "معطلة" وينتشر الخبر. وهذا يمنع الإنذارات الكاذبة عندما تكون المشكلة بين A وB فقط.

```java
@Service
public class SwimFailureDetector {

    private final NodeRegistry nodeRegistry;
    private final GossipTransport transport;
    private final MembershipView membershipView;

    private static final Duration DIRECT_PROBE_TIMEOUT = Duration.ofMillis(500);
    private static final Duration SUSPICION_TIMEOUT = Duration.ofSeconds(10);
    private static final int INDIRECT_PROBE_COUNT = 3;

    @Scheduled(fixedDelayString = "1000")
    public void runProbeRound() {
        // Select one random member to probe this round
        NodeDescriptor target = membershipView.selectRandomLiveMember();
        if (target == null) return;

        if (!directProbe(target)) {
            indirectProbe(target);
        }
    }

    private boolean directProbe(NodeDescriptor target) {
        try {
            transport.ping(target, DIRECT_PROBE_TIMEOUT);
            // Successful ping — reset failure counter
            membershipView.recordSuccessfulContact(target.nodeId());
            return true;
        } catch (TimeoutException | TransportException e) {
            log.debug("Direct probe failed for {}", target.nodeId());
            return false;
        }
    }

    private void indirectProbe(NodeDescriptor target) {
        List<NodeDescriptor> helpers = membershipView.selectRandom(
            INDIRECT_PROBE_COUNT, excluding(target));

        List<CompletableFuture<Boolean>> probes = helpers.stream()
            .map(helper -> CompletableFuture.supplyAsync(() -> {
                try {
                    // Ask helper to ping target on our behalf
                    transport.pingRequest(helper, target, DIRECT_PROBE_TIMEOUT);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }))
            .collect(Collectors.toList());

        boolean anySucceeded = probes.stream()
            .map(CompletableFuture::join)
            .anyMatch(Boolean::booleanValue);

        if (!anySucceeded) {
            // No helper could reach target — mark as suspected
            log.warn("SWIM: node {} not reachable by {} indirect probes — marking SUSPECTED",
                target.nodeId(), INDIRECT_PROBE_COUNT);
            membershipView.markSuspected(target.nodeId(), Instant.now());

            // Schedule confirmation: if still suspected after timeout, mark FAILED
            scheduleSuspicionConfirmation(target.nodeId());
        }
    }

    private void scheduleSuspicionConfirmation(String nodeId) {
        CompletableFuture.delayedExecutor(
            SUSPICION_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS
        ).execute(() -> {
            if (membershipView.isSuspected(nodeId)) {
                log.warn("SWIM: node {} remains unreachable — marking FAILED and gossiping",
                    nodeId);
                membershipView.markFailed(nodeId);
                gossipFailure(nodeId);
            }
        });
    }

    private void gossipFailure(String failedNodeId) {
        // Simplified: real SWIM piggybacks this notification on its ping and ack
        // messages, so it spreads epidemically. A suspected node that is alive
        // refutes the suspicion by gossiping a higher incarnation number.
        FailureNotification notification = FailureNotification.builder()
            .failedNodeId(failedNodeId)
            .detectedBy(nodeRegistry.localNodeId())
            .detectedAt(Instant.now())
            .incarnation(membershipView.incarnationOf(failedNodeId))
            .build();

        membershipView.liveMembers().forEach(peer ->
            transport.sendFailureNotification(peer, notification));
    }
}
```

في SWIM الحقيقي يُحمَّل إشعار العطل على رسائل الفحص والتأكيد، فينتشر وبائيًا. والعقدة المشتبه بها التي هي حية فعلًا تدحض الشبهة بنشر رقم تجسّد (incarnation) أعلى.

---

## Gossip في Cassandra لعضوية العنقود

تستخدم Cassandra الـ Gossip لثلاثة أغراض:
1. **العضوية**: أي العقد في الحلقة وأي نطاقات رموز تملكها
2. **اكتشاف الأعطال**: اكتشاف العقد الميتة أو البطيئة بكاشف أعطال phi-accrual ‏(Hayashibara وزملاؤه) — لا SWIM
3. **نشر المخطط**: توزيع تغييرات المخطط عبر العنقود

### البنية الداخلية لـ Gossip في Cassandra

يعمل Gossip في Cassandra كل ثانية. وتحتفظ كل عقدة بـ **EndpointState** لكل عقدة أخرى تعرفها، يتضمن:
- **HeartbeatState**: الجيل والإصدار (عدّاد النبض)
- **ApplicationState**: بيانات العقدة الوصفية (STATUS، وLOAD، وSCHEMA، وDC، وRACK، وRELEASE_VERSION، وTOKENS)

```java
// Equivalent to Cassandra's internal GossipDigestSyn message
// (conceptual — not actual Cassandra code)
public class CassandraStyleGossipMessage {

    /**
     * Cassandra gossips three types of messages in sequence:
     * 1. SYN: "Here are my digests (nodeId → generation + max version)"
     * 2. ACK: "Here's what I know that you don't + request for what you have that I need"
     * 3. ACK2: "Here's the data you requested"
     */
    public enum MessageType { GOSSIP_DIGEST_SYN, GOSSIP_DIGEST_ACK, GOSSIP_DIGEST_ACK2 }
}
```

تتبادل Cassandra ثلاثة أنواع من الرسائل بالترتيب: SYN (ملخصاتي)، ثم ACK (ما أعرفه ولا تعرفه + طلب ما ينقصني)، ثم ACK2 (البيانات التي طلبتها).

### مراقبة صحة Gossip في Cassandra

```java
@Service
public class CassandraGossipMonitor {

    private final Session cassandraSession;

    /**
     * Check gossip state across all nodes.
     * Nodes with STATUS != NORMAL may have ring issues affecting
     * transaction state availability.
     */
    public ClusterGossipHealth checkGossipHealth() {
        ResultSet rs = cassandraSession.execute(
            "SELECT peer, data_center, rack, release_version, " +
            "       rpc_address, schema_version, tokens " +
            "FROM system.peers");

        List<PeerInfo> peers = new ArrayList<>();
        for (Row row : rs) {
            peers.add(PeerInfo.builder()
                .address(row.getInetAddress("peer"))
                .dataCenter(row.getString("data_center"))
                .rack(row.getString("rack"))
                .schemaVersion(row.getUUID("schema_version"))
                .tokenCount(row.getSet("tokens", String.class).size())
                .build());
        }

        // Check for schema disagreement — a sign of gossip issues
        Set<UUID> schemaVersions = peers.stream()
            .map(PeerInfo::schemaVersion)
            .collect(Collectors.toSet());

        if (schemaVersions.size() > 1) {
            log.warn("Schema disagreement detected across {} versions: {}",
                schemaVersions.size(), schemaVersions);
        }

        return ClusterGossipHealth.builder()
            .totalPeers(peers.size())
            .schemaVersions(schemaVersions)
            .schemaAgreement(schemaVersions.size() == 1)
            .peersByDataCenter(groupByDataCenter(peers))
            .build();
    }

    /**
     * The nodetool gossipinfo equivalent via JMX: each node's gossip state as
     * seen from the local node, as text (FailureDetectorMBean).
     */
    public String getGossipInfo() {
        FailureDetectorMBean failureDetector = getFailureDetectorProxy();
        return failureDetector.getAllEndpointStates();
    }
}
```

اختلاف إصدارات المخطط بين العقد علامة على مشكلات في Gossip. ويعرض `FailureDetectorMBean` حالة Gossip لكل عقدة كما تراها العقدة المحلية، كمكافئ لأمر `nodetool gossipinfo`.

### مستويات الاتساق في Cassandra وGossip

يحدد Gossip أي العقد حية، وهذا يؤثر مباشرة في سلوك مستويات الاتساق في Cassandra:

```java
@Repository
public class TransactionStateRepository {

    private final Session session;

    // Prepared statement for writing transaction state
    private final PreparedStatement insertTxState;
    private final PreparedStatement readTxState;

    public TransactionStateRepository(Session session) {
        this.session = session;
        this.insertTxState = session.prepare(
            "INSERT INTO transactions.payment_state " +
            "(payment_id, state, amount_cents, currency, updated_at) " +
            "VALUES (?, ?, ?, ?, ?) " +
            "USING TIMESTAMP ?"   // no TTL: payment state must not silently expire
        );
        this.readTxState = session.prepare(
            "SELECT payment_id, state, amount_cents, currency, updated_at " +
            "FROM transactions.payment_state " +
            "WHERE payment_id = ?"
        );
    }

    /**
     * Write payment state with LOCAL_QUORUM consistency.
     * This requires acknowledgment from a majority of replicas in the
     * local DC; combined with LOCAL_QUORUM reads it gives read-your-writes
     * within a datacenter without the latency of cross-DC writes.
     *
     * Gossip health affects this: if the coordinator already knows (via
     * gossip) that too few replicas are alive, it fails fast with
     * UnavailableException instead of trying.
     */
    public void savePaymentState(PaymentState state) {
        BoundStatement stmt = insertTxState.bind(
            state.paymentId(),
            state.status().name(),
            state.amountCents(),
            state.currency(),
            state.updatedAt(),
            state.updatedAt().toEpochMilli() * 1000  // Cassandra timestamp in microseconds
        ).setConsistencyLevel(ConsistencyLevel.LOCAL_QUORUM);

        try {
            session.execute(stmt);
        } catch (UnavailableException e) {
            // Gossip says fewer than LOCAL_QUORUM replicas are alive
            log.error("Cannot write payment state — quorum unavailable: {} of {} alive",
                e.getAliveReplicas(), e.getRequiredReplicas());
            throw new PaymentSystemUnavailableException(
                "Cassandra quorum unavailable — transaction state cannot be persisted", e);
        } catch (WriteTimeoutException e) {
            // Write started but acknowledgment timed out
            // The write MAY have succeeded on some replicas — idempotency is critical
            log.warn("Write timeout for payment {} — checking idempotency key before retry",
                state.paymentId());
            throw e;   // the caller decides; a retry must be safe to repeat
        }
    }

    /**
     * Read with SERIAL consistency: a linearizable read that also completes
     * any in-flight lightweight transaction. Only meaningful when the writes
     * to this row also use LWT (IF ...) — mixing LWT and plain writes on the
     * same data is unsafe.
     */
    public Optional<PaymentState> findByIdLinearizable(UUID paymentId) {
        BoundStatement stmt = readTxState.bind(paymentId)
            .setConsistencyLevel(ConsistencyLevel.SERIAL);

        ResultSet rs = session.execute(stmt);
        Row row = rs.one();
        return Optional.ofNullable(row).map(this::mapRow);
    }
}
```

إذا عرف المنسّق مسبقًا (عبر Gossip) أن النسخ الحية أقل من المطلوب، يفشل فورًا بـ `UnavailableException` بدل المحاولة. أما انتهاء مهلة الكتابة فيعني أن الكتابة **ربما** نجحت على بعض النسخ — فيجب أن تكون إعادة المحاولة آمنة من التكرار. ولا توضع مدة صلاحية على حالة الدفع، لأنها يجب ألا تنتهي بصمت. وقراءات SERIAL لا معنى لها إلا إذا كانت الكتابات على الصف نفسه تستخدم أيضًا المعاملات الخفيفة (LWT).

---

## خصائص التقارب

الخاصية الرياضية الأساسية لبروتوكولات Gossip هي **التقارب**: في عنقود من N عقدة وانتشار k، تصل المعلومة إلى كل العقد خلال O(log_k(N)) جولة.

لعنقود من 100 عقدة بانتشار 3:
- الجولة 1: عقدة واحدة تعرف ← تخبر 3 (4 إجمالًا)
- الجولة 2: 4 عقد تعرف ← تخبر 12 (16 إجمالًا)
- الجولة 3: 16 عقدة تعرف ← تخبر 48 (64 إجمالًا)
- الجولة 4: كل العقد تعرف (تقارب في نحو 4 جولات)

```java
@Component
public class GossipConvergenceCalculator {

    /**
     * Calculate expected convergence time for the cluster.
     * Used to set appropriate timeouts for operations that
     * require cluster-wide agreement (e.g., schema changes).
     */
    public Duration expectedConvergenceTime(int clusterSize, int fanOut,
                                             Duration gossipInterval) {
        int rounds = (int) Math.ceil(
            Math.log(clusterSize) / Math.log(fanOut)
        );
        // Add 2x safety margin for network jitter
        return gossipInterval.multipliedBy(rounds * 2);
    }

    /**
     * For a 50-node Cassandra cluster with 1-second gossip interval and fan-out 3:
     * rounds = ceil(log(50)/log(3)) = ceil(3.56) = 4
     * expected convergence = 4 * 2 * 1s = 8 seconds
     *
     * This means schema changes in Cassandra can take up to ~8 seconds
     * to propagate to all nodes. Operations requiring schema agreement
     * should wait at least this long.
     */
    public void logConvergenceEstimate(int clusterSize) {
        Duration convergence = expectedConvergenceTime(clusterSize, 3, Duration.ofSeconds(1));
        log.info("Gossip convergence estimate for {} nodes: {}ms",
            clusterSize, convergence.toMillis());
    }
}
```

---

## Gossip في التقنية المالية: Cassandra لحالة المعاملات

تستخدم بنية مالية شائعة Cassandra كمخزن لحالة المعاملات الموزعة — خاصة لمفاتيح منع التكرار للمدفوعات، وحالة الجلسات، والأقفال الموزعة (عبر المعاملات الخفيفة في Cassandra).

### تصميم المخطط لمفاتيح منع التكرار

```sql
-- Cassandra CQL schema for payment idempotency store
CREATE KEYSPACE IF NOT EXISTS payments
WITH replication = {
    'class': 'NetworkTopologyStrategy',
    'us-east-1': 3,    -- 3 replicas in primary DC
    'us-west-2': 2     -- 2 replicas in DR DC
}
AND durable_writes = true;

CREATE TABLE payments.idempotency_keys (
    idempotency_key   TEXT,
    created_at        TIMESTAMP,
    payment_id        UUID,
    status            TEXT,
    response_body     BLOB,
    expires_at        TIMESTAMP,
    PRIMARY KEY (idempotency_key)
) WITH default_time_to_live = 86400  -- Keys expire after 24 hours
  AND gc_grace_seconds = 864000      -- 10 days: must exceed the repair interval
  AND compaction = {
      'class': 'LeveledCompactionStrategy'
  };
```

```java
@Service
public class CassandraIdempotencyStore {

    private final Session session;
    private final PreparedStatement insertIfAbsent;
    private final PreparedStatement fetchKey;

    // Prepare in the constructor: a field initializer would run before
    // `session` is assigned
    public CassandraIdempotencyStore(Session session) {
        this.session = session;
        this.insertIfAbsent = session.prepare(
            "INSERT INTO payments.idempotency_keys " +
            "(idempotency_key, created_at, payment_id, status, response_body, expires_at) " +
            "VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS");
        this.fetchKey = session.prepare(
            "SELECT payment_id, status, response_body " +
            "FROM payments.idempotency_keys WHERE idempotency_key = ?");
    }

    /**
     * Atomically insert an idempotency key using Cassandra LWT (IF NOT EXISTS).
     * LWT runs Paxos among the key's replicas, so the claim is linearizable
     * for this key (it still needs a quorum of those replicas to be alive).
     * SERIAL spans all DCs; LOCAL_SERIAL is faster but only safe if each key
     * is always claimed in the same DC.
     *
     * Returns the existing entry if the key already exists (duplicate request),
     * or empty if this is a new request.
     */
    public Optional<IdempotencyRecord> claimKey(String idempotencyKey, UUID paymentId) {
        BoundStatement stmt = insertIfAbsent.bind(
            idempotencyKey,
            Instant.now(),
            paymentId,
            "PENDING",
            null,
            Instant.now().plus(Duration.ofHours(24))
        ).setConsistencyLevel(ConsistencyLevel.QUORUM)
         .setSerialConsistencyLevel(ConsistencyLevel.SERIAL);

        ResultSet rs = session.execute(stmt);
        Row applied = rs.one();

        if (applied.getBool("[applied]")) {
            return Optional.empty(); // New key — proceed with payment
        }

        // Key already exists — this is a duplicate request
        return Optional.of(IdempotencyRecord.builder()
            .paymentId(applied.getUUID("payment_id"))
            .status(applied.getString("status"))
            .responseBody(applied.getBytes("response_body"))
            .build());
    }
}
```

تُحضّر الجمل في المُنشئ، لأن مُهيِّئ الحقل يعمل قبل تعيين `session`. ويشغّل LWT خوارزمية Paxos بين نسخ المفتاح، فيكون الحجز خطيًا لهذا المفتاح (ما زال يحتاج نصابًا حيًا من تلك النسخ). ويمتد SERIAL عبر كل مراكز البيانات؛ أما LOCAL_SERIAL فأسرع لكنه آمن فقط إذا حُجز كل مفتاح دائمًا في المركز نفسه.

---

## ضبط عامل الانتشار

يؤثر عامل الانتشار (عدد النظراء الذين يُتصل بهم في كل جولة) مباشرة في:
- **سرعة التقارب**: انتشار أعلى ← تقارب أسرع
- **كلفة الشبكة**: انتشار أعلى ← حركة Gossip أكثر
- **حد حجم العنقود**: عرض نطاق Gossip يتزايد بمقدار O(N × الانتشار) في كل جولة

ولا تستخدم Cassandra نفسها انتشارًا قابلًا للضبط: ففي كل ثانية تتبادل العقدة Gossip مع نظير حي عشوائي واحد، وأحيانًا أيضًا مع عقدة غير قابلة للوصول ومع عقدة بذرة. وما تضبطه هو اكتشاف الأعطال والطوبولوجيا. لعنقود Cassandra يُستخدم لحالة المعاملات المالية:

```yaml
# cassandra.yaml — gossip tuning
# Default gossip interval is 1 second — rarely need to change this

# phi_convict_threshold: sensitivity of failure detection
# Lower = more aggressive (faster failure detection, more false positives)
# Higher = more conservative (slower detection, fewer false positives)
# Default 8.0, range 5-16
# For payment systems: 10-12 to reduce false positives from GC pauses
phi_convict_threshold: 10.0

# endpoint_snitch determines how Cassandra understands topology
# (affects gossip propagation and replica placement)
endpoint_snitch: GossipingPropertyFileSnitch
```

```java
@Component
public class CassandraGossipHealthMetrics {

    private final MeterRegistry meterRegistry;
    private final AlertingService alerting;
    private static final int REPLICATION_FACTOR = 3;

    // Gauges need a long-lived holder: registering a boxed Long each time
    // would be garbage-collected and report NaN
    private final Map<String, AtomicLong> nodesByStatus = new ConcurrentHashMap<>();

    @Scheduled(fixedDelayString = "30000")
    public void collectGossipMetrics() {
        try {
            Map<String, Long> stateCount = getNodeStates()
                .entrySet().stream()
                .collect(Collectors.groupingBy(
                    e -> e.getValue().status(), Collectors.counting()));

            stateCount.forEach((status, count) ->
                nodesByStatus.computeIfAbsent(status, st -> meterRegistry.gauge(
                        "cassandra.gossip.nodes", Tags.of("status", st), new AtomicLong()))
                    .set(count));

            long downNodes = stateCount.getOrDefault("DOWN", 0L)
                + stateCount.getOrDefault("LEAVING", 0L);

            // Quorum is per REPLICA SET (replication factor), not per cluster:
            // with RF=3, two down nodes that share a token range already break
            // LOCAL_QUORUM for that range, even in a 30-node cluster
            int quorum = REPLICATION_FACTOR / 2 + 1;
            if (downNodes > REPLICATION_FACTOR - quorum) {
                alerting.sendP1Alert("Cassandra quorum at risk",
                    downNodes + " nodes down — some token ranges may have lost quorum");
            } else if (downNodes > 0) {
                log.warn("Cassandra gossip: {} nodes in abnormal state", downNodes);
            }
        } catch (Exception e) {
            log.error("Failed to collect Cassandra gossip metrics", e);
        }
    }
}
```

النصاب في Cassandra لكل **مجموعة نسخ** (عامل النسخ)، لا للعنقود كله: فمع RF=3 تكفي عقدتان معطلتان تتشاركان نطاق رموز لكسر LOCAL_QUORUM لذلك النطاق، حتى في عنقود من 30 عقدة. وتحتاج مقاييس gauge إلى حاوية طويلة العمر، لأن تسجيل قيمة Long مغلّفة في كل مرة يجعلها تُجمع كنفايات فتعرض NaN.

---

## نصائح للإنتاج وأخطاء شائعة

### الخطأ 1: توقفات GC تسبب إنذارات كاذبة

توقفات جمع النفايات الطويلة في JVM (أكبر من عتبة phi) قد تجعل كواشف الأعطال في العقد الأخرى تعلّم عقدة Cassandra على أنها DOWN، رغم أنها حية فعلًا. والنتيجة عمل غير ضروري في التسليم المؤجل (hinted handoff) والإصلاح. والحلول:

```bash
# JVM tuning to minimize GC pauses (cassandra-env.sh; in Cassandra 4.x and
# later these flags usually live in conf/jvm*-server.options)
JVM_OPTS="$JVM_OPTS -XX:+UseG1GC"
JVM_OPTS="$JVM_OPTS -XX:MaxGCPauseMillis=300"
JVM_OPTS="$JVM_OPTS -XX:G1HeapRegionSize=16m"
JVM_OPTS="$JVM_OPTS -XX:InitiatingHeapOccupancyPercent=70"
```

```yaml
# cassandra.yaml — increase phi threshold to tolerate GC pauses
phi_convict_threshold: 12.0
```

### الخطأ 2: تغييرات المخطط أثناء الحمل العالي

تنشر Cassandra تغييرات المخطط عبر Gossip. وأثناء ترحيل مخطط في بيئة دفع عالية الحركة، قد يسبب اختلاف المخطط بين العقد فشل الاستعلامات. لذلك دائمًا:

```java
@Service
public class CassandraSchemaManager {

    public void applySchemaChange(String ddl) throws InterruptedException {
        log.info("Applying schema change: {}", ddl);

        // 1. Apply the change (the driver itself waits briefly for agreement,
        //    up to maxSchemaAgreementWaitSeconds — this loop adds a longer,
        //    explicit wait and a clear failure)
        session.execute(ddl);

        // 2. Wait for schema agreement across all nodes
        int maxWaitSeconds = 60;
        int waited = 0;
        while (!session.getCluster().getMetadata().checkSchemaAgreement()
                && waited < maxWaitSeconds) {
            log.info("Waiting for schema agreement... ({}/{}s)", waited, maxWaitSeconds);
            Thread.sleep(1000);
            waited++;
        }

        if (!session.getCluster().getMetadata().checkSchemaAgreement()) {
            throw new SchemaAgreementException(
                "Schema change applied but agreement not reached after " +
                maxWaitSeconds + "s — investigate gossip health");
        }

        log.info("Schema agreement confirmed after {}s", waited);
    }
}
```

### الخطأ 3: تراكم شواهد الحذف (Tombstones) وتفاعلها مع Gossip

تتحول الصفوف المحذوفة في Cassandra إلى شواهد حذف، تُجمع كنفايات بعد `gc_grace_seconds`. فإذا فاتت نسخةً شاهدةُ حذف ولم تُصلَح خلال `gc_grace_seconds`، قد تعيد إظهار بيانات محذوفة — وهذه مشكلة اتساق لسجلات المعاملات. ويترتب على ذلك قاعدتان: أصلح كل نطاق خلال `gc_grace_seconds`، ولا تسمح أبدًا لعقدة توقفت أطول من ذلك بالانضمام مجددًا دون إعادة بنائها أو استبدالها:

```sql
-- 10 days (the default): repairs must complete within this window,
-- and a node down longer than this must be rebuilt, not just restarted
ALTER TABLE payments.idempotency_keys
WITH gc_grace_seconds = 864000;  -- 10 days
```

---

## الخلاصة

توفر بروتوكولات Gossip آلية قابلة للتوسع ومرنة لنشر المعلومات عبر العنقود دون نقطة تنسيق واحدة. وفي سياق التقنية المالية:

- تستخدم Cassandra الـ Gossip للعضوية، واكتشاف الأعطال، ونشر المخطط
- يمنع الفحص غير المباشر في بروتوكول SWIM الإنذارات الكاذبة من مشكلات الشبكة العابرة
- يضمن إصلاح مقاومة الإنتروبيا الاتساق النهائي لبيانات المعاملات عبر النسخ
- يتقارب Gossip في O(log N) جولة؛ وتتبادل Cassandra الـ Gossip مرة كل ثانية مع نظير حي عشوائي واحد (وأحيانًا مع عقدة غير قابلة للوصول وعقدة بذرة)
- لأنظمة الدفع على Cassandra: استخدم LOCAL_QUORUM للقراءة والكتابة، وراقب توافق المخطط، وأنهِ الإصلاحات خلال gc_grace_seconds، واضبط عتبة phi لتتحمل توقفات GC في JVM

ليس Gossip آلية لنسخ بيانات المعاملات المالية — فذلك يحتاج نسخًا بالنصاب أو إجماعًا. إنما Gossip طبقة البيانات الوصفية التي تجعل بروتوكولات الإجماع ممكنة بإبقاء كل عقدة على علم بعضوية العنقود وصحته.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لماذا يُستخدم بروتوكول Gossip لعضوية عنقود Cassandra لا لنسخ بيانات المعاملات؟",
      "options": ["Gossip أسرع من Paxos لكل أنواع البيانات", "يوفر Gossip اتساقًا نهائيًا فقط، وهذا غير كافٍ لصحة بيانات المعاملات لكنه مقبول لحالة العضوية والمخطط", "لا تدعم Cassandra النسخ القائم على النصاب", "يتطلب Gossip عرض نطاق شبكي أقل من أي استراتيجية نسخ أخرى"],
      "correct": 1,
      "explanation": "‏Gossip متسق في النهاية — تتقارب كل العقد في النهاية لكن لا ضمان للحداثة في أي لحظة. وبيانات المعاملات تتطلب ضمانات اتساق قوية (تستخدم Cassandra لها النسخ القائم على النصاب). أما عضوية العنقود، واكتشاف الأعطال، ونشر المخطط فتتحمل الاتساق النهائي."
    },
    {
      "text": "ماذا يقيس كاشف الأعطال phi accrual الذي يستخدمه Gossip في Cassandra؟",
      "options": ["عدد مهام الضغط المعلّقة على العقدة", "مستوى اشتباه مستمرًا مبنيًا على الفواصل الزمنية بين وصول النبضات، فيسمح باكتشاف تكيّفي للأعطال لا ثنائي", "تأخر النسخ بين النسخ الأساسية والثانوية", "استخدام المعالج لكل نظير Gossip"],
      "correct": 1,
      "explanation": "يحسب كاشف الأعطال phi accrual قيمة اشتباه (phi) مبنية على التوزيع الإحصائي للفواصل بين وصول النبضات. وتُعلَّم العقدة DOWN عندما تتجاوز phi عتبة معينة. وهذا الأسلوب التكيّفي يتجنب الإنذارات الكاذبة من التأخيرات العابرة مثل توقفات GC في JVM."
    },
    {
      "text": "في عنقود Cassandra من 10 عقد بانتشار 3 وجولات Gossip كل ثانية، كم جولة تقريبًا تحتاج كل العقد لتلقي معلومة جديدة؟",
      "options": ["10 جولات", "O(log N) جولة — نحو 3-4 جولات", "جولة واحدة (بث)", "N/الانتشار = 3-4 جولات لكن مع تسليم مضمون"],
      "correct": 1,
      "explanation": "زمن تقارب Gossip هو O(log N) جولة مع انتشار k. ولـ N=10 وانتشار 3، يستغرق التقارب نحو log_3(10) ≈ 2.1 جولة، أي نحو 3 فترات Gossip. وهذا التدرج اللوغاريتمي هو سبب كفاءة Gossip حتى في العناقيد الكبيرة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مراقبة Gossip في Cassandra ومقاومة الإنتروبيا لمخزن حالة المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "انشر عنقود Cassandra من 3 عقد محليًا باستخدام Docker Compose. واستخدم nodetool gossipinfo وnodetool ring لفحص حالة Gossip. وحاكِ تعطل عقدة ولاحظ مدى سرعة تحديث العقد الأخرى لرؤيتها للعضوية. وقِس زمن التقارب مقابل الحد النظري O(log N)."},
    {"id": "2", "description": "نفّذ محاكاة Gossip في Java باستخدام نمط GossipEngine من الدرس. وحاكِ عنقودًا من 20 عقدة بانتشار 3 وقِس عدد الجولات حتى تتلقى كل العقد تغيير مخطط. وارسم زمن التقارب مقابل حجم العنقود للتحقق من العلاقة اللوغاريتمية."},
    {"id": "3", "description": "اضبط phi_convict_threshold في Cassandra وخيار read_repair على مستوى الجدول (أُزيل read_repair_chance في Cassandra 4.0) لمساحة مفاتيح المدفوعات. واصنع عدم اتساق متعمدًا (أوقف عقدة، واكتب، ثم أعد تشغيلها)، وشغّل nodetool repair، وتحقق من تقارب كل النسخ إلى البيانات نفسها."},
    {"id": "4", "description": "ابنِ لوحة لصحة Gossip مبنية على Micrometer: أضف إلى خدمة مبنية على Cassandra مقاييس لتوافق المخطط (مخرجات nodetool describecluster)، وعدد العقد غير القابلة للوصول، وزمن جولة Gossip. وأطلق تنبيهًا عندما ينخفض توافق المخطط عن 100% لأكثر من 60 ثانية."}
  ]
}
-->
