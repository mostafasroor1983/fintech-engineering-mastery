---
id: track-02-lesson-04
title: "انتخاب القائد — Paxos وRaft وZooKeeper"
slug: leader-election
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 4
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [Paxos, Raft, ZooKeeper, leader-election, consensus]
prerequisites: []
---

# انتخاب القائد — Paxos وRaft وZooKeeper

> [!NOTE]
> عندما تعمل مهمة تسوية مدفوعات على عقدتين في الوقت نفسه، قد تعالج الدفعة نفسها مرتين — فتُضيف إلى الحسابات مرتين وتخصم منها مرتين. وعندما يكون لقفل موزع مالكان متزامنان، قد تنجح دفعتان في فحص رصيد كان سيرفض إحداهما. وانتخاب القائد هو الآلية التي تضمن أن عقدة واحدة فقط تعمل كمنسّق في أي لحظة — وفي الأنظمة المالية، "واحدة فقط" ليست اقتراحًا.

## لماذا يهم انتخاب القائد في التقنية المالية

كثير من العمليات المالية أحادية الخيط بطبيعتها:

- **مهام التسوية الدفعية**: يجب أن تعمل تسوية نهاية اليوم مرة واحدة بالضبط
- **كاتب سجل مفاتيح منع التكرار**: كاتب موثوق واحد يمنع التكرار
- **تسلسل المدفوعات**: يجب أن تتزايد الأرقام التسلسلية للمدفوعات بانتظام من مصدر واحد
- **مهام حساب الرسوم**: يجب أن يعمل حساب الرسوم الشهرية مرة واحدة بالضبط لكل عميل
- **إنشاء التقارير التنظيمية**: لا يمكن إنشاء تقارير Basel III أو IFRS 9 مرتين ببيانات مختلفة

الحل الساذج — مهمة cron على خادم واحد — يفشل عندما يتعطل ذلك الخادم. والحل الموزع يتطلب **إجماعًا** بين عدة عقد لانتخاب قائد واحد.

```
Leader Election Problem:

  Node A, Node B, Node C — any node can fail at any time
  After any failure, exactly one surviving node must be LEADER

  Safety:    At most one leader at any time
  Liveness:  Eventually, a leader will be elected

  Safety can always be kept. Liveness needs a quorum (majority) of
  nodes to be up and the network to be stable for long enough
  (no algorithm can guarantee it in a fully asynchronous network — FLP).

  Quorum for 3 nodes: 2
  Quorum for 5 nodes: 3
```

السلامة: قائد واحد على الأكثر في أي لحظة. والحيوية: سيُنتخب قائد في النهاية. ويمكن الحفاظ على السلامة دائمًا، أما الحيوية فتحتاج إلى أن تكون أغلبية (نصاب) العقد عاملة وأن تستقر الشبكة مدة كافية. والنصاب لـ 3 عقد هو 2، ولـ 5 عقد هو 3.

---

## Paxos: الأساس

Paxos هو الأساس النظري لمعظم خوارزميات الإجماع. وهو معروف بصعوبة فهمه وتنفيذه بشكل صحيح، لكن فهم بنيته يوضح لماذا وُجدت خوارزميات عملية مثل Raft.

### أدوار Paxos

- **المقترِح (Proposer)**: يقترح قيمة ليُختار
- **المقبِل (Acceptor)**: يصوّت على المقترحات؛ وأغلبية المقبلين تحدد النتيجة
- **المتعلّم (Learner)**: يتعلم القيمة المختارة

### Paxos بقرار واحد (تصوريًا)

```
Phase 1 (Prepare/Promise):
  Proposer selects proposal number N (must be greater than any it has used)
  Proposer sends PREPARE(N) to a majority of acceptors
  
  Each acceptor:
    If N > any prepare it has seen:
      Promise to never accept proposals with number < N
      Reply with the highest-numbered proposal it has already accepted (if any)

Phase 2 (Accept/Accepted):
  If proposer receives promises from majority:
    If any promise included an already-accepted value V:
      Must propose V (not its own value — this is the safety property)
    Else:
      May propose its own value
    Sends ACCEPT(N, V) to a majority of acceptors
  
  Each acceptor:
    If it has not promised to ignore proposals with number < N:
      Accept the proposal
      Notify learners

The value V is "chosen" when a majority of acceptors have accepted it.
```

في المرحلة الأولى يرسل المقترِح PREPARE(N) برقم مقترح أكبر من أي رقم سابق، ويعد كل مقبِل بألا يقبل مقترحات أصغر، ويعيد أعلى مقترح قبله سابقًا. وفي المرحلة الثانية، إذا تضمن أي وعد قيمة مقبولة سابقًا فيجب على المقترِح اقتراحها هي لا قيمته — وهذه خاصية السلامة. وتُعد القيمة "مختارة" عندما تقبلها أغلبية المقبلين.

### لماذا يصعب تنفيذ Paxos

1. **Multi-Paxos** (لسلسلة من القيم) يتطلب إدارة سجل معقدة
2. **تغيير القائد** في Paxos يتطلب جولة Paxos كاملة لانتخاب مقترِح جديد
3. **تغييرات الإعداد** (إضافة عقد أو إزالتها) تتطلب صيغًا خاصة دقيقة من Paxos
4. **الحيوية تحت التنافس** غير مضمونة — فقد يتسبب مقترِحون متنافسون في انسداد حي (livelock)

وهذا ما دفع إلى تطوير Raft، الذي يحقق خصائص السلامة نفسها ببنية أسهل فهمًا.

---

## خوارزمية الإجماع Raft

يقسّم Raft الإجماع إلى ثلاث مسائل فرعية مستقلة نسبيًا:
1. **انتخاب القائد**: ضمان قائد واحد على الأكثر في كل فترة (term)
2. **نسخ السجل**: يقبل القائد المدخلات وينسخها إلى التابعين
3. **السلامة**: ضمان عدم ضياع المدخلات الملتزمة أبدًا

### جولة في انتخاب القائد في Raft

```
State Machine for Raft Nodes:
  Each node is in one of three states:
  FOLLOWER -> CANDIDATE -> LEADER

  FOLLOWER:
    - Waits for heartbeats from leader
    - If no heartbeat within election timeout: becomes CANDIDATE
    - Resets election timeout on each heartbeat received

  CANDIDATE:
    - Increments currentTerm
    - Votes for itself
    - Sends RequestVote to all other nodes
    - If receives majority votes: becomes LEADER
    - If receives AppendEntries from new leader: returns to FOLLOWER
    - If election timeout expires: starts new election

  LEADER:
    - Sends periodic heartbeats (empty AppendEntries) to all followers
    - Handles client requests
    - Replicates log entries to followers

Election Timeline:
  t=0:   Cluster starts; all nodes are FOLLOWERS, random election timeouts set
         Node A timeout: 150ms, Node B timeout: 200ms, Node C timeout: 300ms

  t=150ms: Node A's timeout fires -> becomes CANDIDATE, term=1
           Sends RequestVote(term=1, lastLogIndex=0) to B and C

  t=152ms: Node B receives RequestVote
           B has not voted in term 1, and A's log is at least as up to date as B's
           -> B grants vote, resets timeout

  t=152ms: Node C receives RequestVote
           -> C grants vote, resets timeout

  t=153ms: Node A receives votes from B and C (majority of 3)
           -> Node A becomes LEADER for term 1
           Begins sending heartbeats every 50ms
```

لكل عقدة ثلاث حالات: تابع، ومرشح، وقائد. ينتظر التابع نبضات القائد، وإذا لم تصله نبضة خلال مهلة الانتخاب يصبح مرشحًا: يزيد رقم الفترة، ويصوّت لنفسه، ويطلب الأصوات. ومن يحصل على الأغلبية يصبح قائدًا ويرسل نبضات دورية. والمهل العشوائية (150-300ms) تمنع انقسام الأصوات.

### تنفيذ Raft في Java

```java
// Raft node state machine — simplified for illustration
// In production use a proven implementation (etcd's raft, Apache Ratis),
// or better, a service built on one (etcd, ZooKeeper, Consul)

public class RaftNode {

    private volatile NodeState state = NodeState.FOLLOWER;
    private volatile int       currentTerm = 0;
    private volatile String    votedFor    = null;
    private volatile String    currentLeaderId = null;

    private final String       nodeId;
    private final List<String> peerIds;
    private final RaftRpc      rpc;
    private final RaftLog      raftLog;

    private ScheduledFuture<?> electionTimer;
    private ScheduledFuture<?> heartbeatTimer;

    // Election timeout: randomised between 150-300ms to prevent split votes
    private static final int ELECTION_TIMEOUT_MIN_MS = 150;
    private static final int ELECTION_TIMEOUT_MAX_MS = 300;
    private static final int HEARTBEAT_INTERVAL_MS   = 50;

    public synchronized void startElection() {
        state = NodeState.CANDIDATE;
        currentTerm++;
        votedFor = nodeId;  // Vote for self
        log.info("Node {} starting election for term {}", nodeId, currentTerm);

        AtomicInteger votesReceived = new AtomicInteger(1); // Self-vote

        for (String peerId : peerIds) {
            RequestVoteRequest request = RequestVoteRequest.builder()
                .term(currentTerm)
                .candidateId(nodeId)
                .lastLogIndex(raftLog.getLastIndex())
                .lastLogTerm(raftLog.getLastTerm())
                .build();

            rpc.sendRequestVoteAsync(peerId, request)
               .thenAccept(response -> {
                   synchronized (this) {
                       if (response.term() > currentTerm) {
                           // A higher term exists — revert to follower
                           becomeFollower(response.term());
                           return;
                       }

                       // Ignore late replies from an earlier election
                       if (state != NodeState.CANDIDATE
                           || currentTerm != request.term()) return;
                       if (!response.voteGranted()) return;

                       int votes = votesReceived.incrementAndGet();
                       int majority = (peerIds.size() + 1) / 2 + 1;

                       if (votes >= majority) {
                           becomeLeader();
                       }
                   }
               });
        }

        resetElectionTimer();
    }

    private synchronized void becomeLeader() {
        state = NodeState.LEADER;
        currentLeaderId = nodeId;
        log.info("Node {} became LEADER for term {}", nodeId, currentTerm);

        stopElectionTimer();
        startHeartbeatTimer();

        // Send immediate heartbeat to establish authority
        sendHeartbeats();
    }

    private synchronized void becomeFollower(int term) {
        state       = NodeState.FOLLOWER;
        currentTerm = term;
        votedFor    = null;

        stopHeartbeatTimer();
        resetElectionTimer();
    }

    private void sendHeartbeats() {
        if (state != NodeState.LEADER) return;

        for (String peerId : peerIds) {
            AppendEntriesRequest heartbeat = AppendEntriesRequest.builder()
                .term(currentTerm)
                .leaderId(nodeId)
                .prevLogIndex(raftLog.getLastIndex())
                .prevLogTerm(raftLog.getLastTerm())
                .entries(List.of())  // Empty = heartbeat
                .leaderCommit(raftLog.getCommitIndex())
                .build();

            rpc.sendAppendEntriesAsync(peerId, heartbeat)
               .thenAccept(response -> {
                   synchronized (this) {
                       if (response.term() > currentTerm) {
                           becomeFollower(response.term());
                       }
                   }
               });
        }
    }

    private void resetElectionTimer() {
        if (electionTimer != null) electionTimer.cancel(false);
        int timeout = ELECTION_TIMEOUT_MIN_MS
            + ThreadLocalRandom.current().nextInt(
                ELECTION_TIMEOUT_MAX_MS - ELECTION_TIMEOUT_MIN_MS
              );
        electionTimer = scheduler.schedule(this::startElection,
                                            timeout,
                                            TimeUnit.MILLISECONDS);
    }
}

public enum NodeState { FOLLOWER, CANDIDATE, LEADER }
```

لاحظ تجاهل الردود المتأخرة من انتخاب سابق: يُحسب الصوت فقط إذا كانت العقدة ما زالت مرشحة وفي الفترة نفسها التي أُرسل فيها الطلب. وفي الإنتاج استخدم تنفيذًا مجرّبًا، أو الأفضل خدمة مبنية عليه (etcd، أو ZooKeeper، أو Consul).

---

## انتخاب القائد في ZooKeeper

في الأنظمة المالية الإنتاجية، لا حاجة لتنفيذ Raft من الصفر. فـ ZooKeeper يقدم خدمة تنسيق موزعة مجرّبة يُعد فيها انتخاب القائد عنصرًا أساسيًا.

### نمط العقد المؤقتة في ZooKeeper

```java
// Leader election using ZooKeeper ephemeral sequential nodes
// Curator Framework (Apache) provides high-level leader election

@Component
public class ZooKeeperLeaderElection implements LeaderElectionParticipant {

    private static final Logger log =
        LoggerFactory.getLogger(ZooKeeperLeaderElection.class);

    private final CuratorFramework client;
    private final LeaderLatch       leaderLatch;
    private final String            nodeId;
    private final LeaderCallback    leaderCallback;

    public ZooKeeperLeaderElection(CuratorFramework client,
                                    @Value("${app.node-id}") String nodeId,
                                    LeaderCallback leaderCallback) {
        this.client         = client;
        this.nodeId         = nodeId;
        this.leaderCallback = leaderCallback;

        // LeaderLatch uses ephemeral sequential nodes under this path
        this.leaderLatch = new LeaderLatch(
            client,
            "/payment-jobs/settlement-leader",
            nodeId
        );
        this.leaderLatch.addListener(new LeaderLatchListener() {
            @Override
            public void isLeader() {
                log.info("Node {} acquired leadership", nodeId);
                leaderCallback.onLeadershipAcquired();
            }

            @Override
            public void notLeader() {
                log.info("Node {} lost leadership", nodeId);
                leaderCallback.onLeadershipLost();
            }
        });
    }

    @PostConstruct
    public void start() throws Exception {
        leaderLatch.start();
        log.info("Node {} joined leader election", nodeId);
    }

    @PreDestroy
    public void stop() throws IOException {
        leaderLatch.close();
        log.info("Node {} left leader election", nodeId);
    }

    public boolean isLeader() {
        return leaderLatch.hasLeadership();
    }

    /**
     * Wait up to timeout for leadership to be acquired.
     * Useful during application startup when you need to know the initial leader.
     */
    public boolean awaitLeadership(Duration timeout) throws InterruptedException {
        return leaderLatch.await(timeout.toMillis(), TimeUnit.MILLISECONDS);
    }
}
```

### مهمة تسوية مع انتخاب القائد

```java
@Service
public class SettlementBatchService {

    private final ZooKeeperLeaderElection leaderElection;
    private final SettlementRepository    settlementRepo;
    private final LedgerService           ledger;
    private final MeterRegistry           metrics;

    /**
     * This job runs on all nodes, but only the leader actually processes.
     * Non-leaders skip the work. If the leader dies mid-run, a new leader is
     * elected within seconds — but the cron will not fire again until
     * tomorrow, so a recovery check must re-run unfinished settlements.
     */
    @Scheduled(cron = "0 0 23 * * *", zone = "Europe/London")  // 11 PM daily
    public void runEndOfDaySettlement() {
        if (!leaderElection.isLeader()) {
            log.debug("Skipping settlement — not the leader");
            return;
        }

        log.info("Node {} running end-of-day settlement as leader",
                  nodeId);

        LocalDate settlementDate = LocalDate.now(ZoneId.of("Europe/London"));

        // Claim the run first: INSERT into settlement_runs with a UNIQUE
        // settlement_date (ON CONFLICT DO NOTHING). A check-then-run would let
        // an old and a new leader both pass the check during a failover.
        if (!settlementRepo.claimRun(settlementDate, nodeId)) {
            log.warn("Settlement for {} already claimed. Skipping.",
                      settlementDate);
            return;
        }

        try {
            SettlementResult result = processSettlement(settlementDate);
            metrics.counter("settlement.completed",
                             "date", settlementDate.toString())
                    .increment();
            log.info("Settlement completed: {}", result.summary());
        } catch (Exception ex) {
            metrics.counter("settlement.failed").increment();
            log.error("Settlement failed for {}", settlementDate, ex);
            // Alert ops — do not retry automatically, require human investigation
            alertingService.raiseSettlementFailureAlert(settlementDate, ex);
            throw ex;
        }
    }
}
```

تعمل المهمة على كل العقد، لكن القائد وحده يعالج. ويُحجز تشغيل اليوم أولًا بإدخال في جدول بقيد فريد على تاريخ التسوية، لأن "افحص ثم شغّل" قد يسمح لقائد قديم وقائد جديد بالمرور معًا أثناء تبديل القيادة. وإذا تعطل القائد أثناء التشغيل، يُنتخب قائد جديد خلال ثوانٍ — لكن cron لن يعمل مجددًا حتى الغد، لذا يجب أن يعيد فحص استرداد تشغيل التسويات غير المكتملة.

---

## انتخاب القائد في etcd

‏etcd بديل شائع لـ ZooKeeper، ويُستخدم بكثرة في بيئات Kubernetes. وهو مناسب لنشرات التقنية المالية السحابية. وتوفر مكتبة jetcd أيضًا عميل انتخاب جاهزًا (`campaign` و`observe` و`resign`)؛ والحلقة أدناه تُظهر الآلية التي تحته.

```java
@Component
public class EtcdLeaderElection {

    private final Client etcdClient;
    private final String leaderKey = "/fintech/payment-processor/leader";
    private final String nodeId;
    private final long   leaseTtlSeconds = 15;

    private volatile LeaderStatus leaderStatus = LeaderStatus.FOLLOWER;
    private volatile long         currentLeaseId;

    @PostConstruct
    public void participate() {
        // Run leader election in a background thread
        executorService.submit(this::runElectionLoop);
    }

    private void runElectionLoop() {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                // Create a lease (TTL-based lock)
                LeaseGrantResponse leaseGrant = etcdClient.getLeaseClient()
                    .grant(leaseTtlSeconds)
                    .get();
                long leaseId = leaseGrant.getID();
                currentLeaseId = leaseId;

                // Try to atomically write our node ID to the leader key
                // Only succeeds if the key does not already exist
                Txn txn = etcdClient.getKVClient().txn();
                TxnResponse response = txn
                    .If(new Cmp(ByteSequence.from(leaderKey.getBytes()),
                                Cmp.Op.VERSION,
                                CmpTarget.version(0)))
                    .Then(Op.put(
                        ByteSequence.from(leaderKey.getBytes()),
                        ByteSequence.from(nodeId.getBytes()),
                        PutOption.newBuilder().withLeaseId(leaseId).build()
                    ))
                    .commit()
                    .get();

                if (response.isSucceeded()) {
                    // We are the leader
                    leaderStatus = LeaderStatus.LEADER;
                    log.info("Node {} elected as leader", nodeId);
                    keepLeaderLeaseAlive(leaseId);
                } else {
                    // Another node is the leader — watch for changes
                    leaderStatus = LeaderStatus.FOLLOWER;
                    etcdClient.getLeaseClient().revoke(leaseId).get();
                    watchForLeaderChange();
                }

            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception ex) {
                log.error("Error in leader election loop", ex);
                sleepQuietly(Duration.ofSeconds(5));
            }
        }
    }

    private void keepLeaderLeaseAlive(long leaseId) throws Exception {
        // Send keepalive every leaseTtlSeconds/3 to prevent lease expiry
        CloseableClient keepAlive = etcdClient.getLeaseClient()
            .keepAlive(leaseId, new StreamObserver<>() {
                @Override public void onNext(LeaseKeepAliveResponse response) {
                    log.trace("Lease {} renewed; TTL={}", leaseId, response.getTTL());
                }
                @Override public void onError(Throwable t) {
                    // The lease may already have expired on the server: stop
                    // leader work now; fencing tokens catch any writes in flight
                    log.warn("Lease keepalive error — may lose leadership", t);
                    leaderStatus = LeaderStatus.FOLLOWER;
                }
                @Override public void onCompleted() {
                    leaderStatus = LeaderStatus.FOLLOWER;
                }
            });

        // Block until we lose leadership
        while (leaderStatus == LeaderStatus.LEADER && !Thread.interrupted()) {
            Thread.sleep(1000);
        }

        keepAlive.close();
    }

    public boolean isLeader() {
        return leaderStatus == LeaderStatus.LEADER;
    }
}
```

تُنشئ العقدة إيجارًا (lease) بمدة، ثم تحاول في معاملة ذرية كتابة معرّفها في مفتاح القائد فقط إذا لم يكن موجودًا. فإن نجحت صارت قائدًا وأبقت الإيجار حيًا؛ وإلا راقبت تغيّر القائد. وعند فشل تجديد الإيجار يجب أن يتوقف عمل القائد فورًا.

---

## رموز التسييج (Fencing Tokens)

مشكلة حرجة في انتخاب القائد: **قد لا يعرف القائد المعزول أنه عُزل**. تأمّل:

```
Split-brain scenario without fencing:

  t=0:   Node A is leader
  t=5s:  Network partition: Node A is isolated
         Nodes B and C elect Node B as leader (term 2)
  t=6s:  Node A is still alive, still thinks it is leader
         Node A and Node B are BOTH trying to be leader

If Node A writes to the payment database in this window,
it may corrupt data committed by Node B.
```

إذا كتبت العقدة A في قاعدة بيانات المدفوعات في هذه النافذة، فقد تُفسد بيانات التزمت بها العقدة B.

**رموز التسييج** تحل هذه المشكلة: كل منح للقيادة يتضمن رمزًا يتزايد باستمرار. وترفض قاعدة البيانات (أو أي مورد) العمليات من حاملي الرموز الأقدم.

```java
// Fencing token: a number that grows with every new leadership.
// With ZooKeeper, use the creation zxid (czxid) of the leader's latch znode;
// with etcd, use the revision at which the leader key was created.
// (ZooKeeper session IDs are NOT suitable — they are not ordered.)

@Component
public class FencedLeaderOperation {

    private final ZooKeeperLeaderElection election;
    private final PaymentDatabase         database;

    /**
     * Any database operation that must only be performed by the current leader
     * must include the fencing token. The database rejects stale tokens.
     */
    public void processPaymentAsBatch(List<Payment> payments) {
        if (!election.isLeader()) {
            throw new NotLeaderException("Cannot process batch — not the leader");
        }

        long fencingToken = election.getCurrentFencingToken();

        for (Payment payment : payments) {
            database.executeWithFencingToken(fencingToken, conn -> {
                // check_fencing_token (below) locks the leader_state row until
                // commit and returns false if a newer token has been seen.
                // payment_id is UNIQUE, so a retried batch cannot double-process.
                PreparedStatement stmt = conn.prepareStatement(
                    "INSERT INTO payment_processing_log " +
                    "(payment_id, processed_at, leader_token) " +
                    "SELECT ?, NOW(), ? " +
                    "WHERE check_fencing_token('settlement', ?, ?)"
                );
                stmt.setString(1, payment.paymentId());
                stmt.setLong(2, fencingToken);
                stmt.setLong(3, fencingToken);
                stmt.setString(4, nodeId);

                int rows = stmt.executeUpdate();
                if (rows == 0) {
                    throw new StaleFencingTokenException(
                        "Leadership has changed; this node is no longer the leader"
                    );
                }
            });
        }
    }
}
```

في ZooKeeper استخدم معرّف المعاملة عند إنشاء عقدة القائد (czxid)، وفي etcd استخدم المراجعة (revision) التي أُنشئ عندها مفتاح القائد. أما معرّفات جلسات ZooKeeper فلا تصلح لأنها غير مرتبة.

```sql
-- Database-side fencing token enforcement
CREATE TABLE leader_state (
    resource_name   VARCHAR(200) PRIMARY KEY,
    current_token   BIGINT       NOT NULL DEFAULT 0,
    leader_node_id  VARCHAR(200),
    acquired_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Function to check and update fencing token
CREATE OR REPLACE FUNCTION check_fencing_token(
    p_resource_name VARCHAR,
    p_token         BIGINT,
    p_node_id       VARCHAR
) RETURNS BOOLEAN AS $$
DECLARE
    v_current_token BIGINT;
BEGIN
    SELECT current_token INTO v_current_token
    FROM leader_state
    WHERE resource_name = p_resource_name
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO leader_state (resource_name, current_token, leader_node_id)
        VALUES (p_resource_name, p_token, p_node_id);
        RETURN TRUE;
    END IF;

    IF p_token < v_current_token THEN
        RETURN FALSE;  -- Stale token: reject operation
    END IF;

    IF p_token > v_current_token THEN
        UPDATE leader_state
        SET current_token = p_token, leader_node_id = p_node_id, acquired_at = NOW()
        WHERE resource_name = p_resource_name;
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
```

تقفل الدالة صف `leader_state` حتى الالتزام، وتعيد false إذا سبق رؤية رمز أحدث. وأول كتابة من قائد جديد ترفع الرمز المسجّل، فتُرفض بعدها كل كتابات القائد القديم.

---

## التكامل مع Spring: انتخاب القائد مع Spring Batch

```java
// Spring Batch 5 (Spring Boot 3) with ZooKeeper leader election

@Configuration
public class SettlementBatchConfig {

    @Bean
    public Job settlementJob(JobRepository jobRepository, Step settlementStep) {
        return new JobBuilder("settlement-job", jobRepository)
            .start(settlementStep)
            .build();
    }

    @Bean
    public Step settlementStep(JobRepository jobRepository,
                               PlatformTransactionManager txManager,
                               ZooKeeperLeaderElection election) {
        return new StepBuilder("settlement-step", jobRepository)
            .<Payment, Payment>chunk(100, txManager)
            .reader(pendingPaymentsReader())
            .processor(item -> {
                // Re-check leadership for every item; fencing tokens in the
                // writer still guard against a leader that has not noticed yet
                if (!election.isLeader()) {
                    throw new LeadershipLostException(
                        "Leadership lost mid-batch; aborting"
                    );
                }
                return item;
            })
            .writer(settlementWriter())   // writes include the fencing token
            .build();                     // no skip policy: any error fails the step
    }
}
```

يُعاد فحص القيادة لكل عنصر، وتبقى رموز التسييج في الكاتب حماية من قائد لم ينتبه بعد إلى فقدان القيادة. ولا توجد سياسة تخطٍّ: أي خطأ يُفشل الخطوة، لأن البيانات المالية يجب ألا تُتخطى بصمت.

---

## أخطاء شائعة

**1. عدم حساب أن القائد يظن أنه ما زال قائدًا**
القائد المعزول عن النصاب بانقسام الشبكة قد يستمر في العمل حتى يلاحظ أنه لا يستطيع تجديد إيجاره — وقد تجعله توقفات GC يلاحظ متأخرًا. وإطالة مدة الإيجار لا تحل المشكلة؛ بل تؤخر التحويل فقط. يجب أن يوقف القائد القديم عمل القيادة فور فشل التجديد، ويجب أن ترفض رموز التسييج أي كتابات ما زال يرسلها.

**2. استخدام أقفال قاعدة البيانات لانتخاب القائد دون حذر**
قفل الصف أو القفل الاستشاري في PostgreSQL يربط القيادة باتصال واحد بقاعدة البيانات. وقد يُبقي اتصال TCP نصف مفتوح القفل لدقائق (حتى يستسلم TCP keepalive)، وتُخفي مجمّعات الاتصالات أي جلسة تملكه. يمكن أن ينجح ذلك مع keepalive قصير ورموز تسييج، لكن ZooKeeper وetcd يقدمان جلسات وإيجارات ومراقبات مصممة لهذا تحديدًا.

**3. تجاهل رموز التسييج**
تنفيذ انتخاب القائد دون رموز تسييج يتركك عرضة لقادة معزولين يستمرون في كتابة البيانات. فالقائد المعزول الذي يكتب في قاعدة بيانات المدفوعات قد يُفسد نتائج التسوية. نفّذ التسييج دائمًا.

**4. مدد إيجار قصيرة جدًا**
مدد الإيجار الأقصر من أطول توقف GC (وقد يبلغ مئات المللي ثواني في Java) ستجعل القادة يفقدون إيجاراتهم أثناء توقفات GC. اضبط مدة الإيجار على 5 أضعاف أطول توقف GC متوقع على الأقل — واستخدم رموز التسييج مع ذلك، لأن توقفًا نادرًا قد يتجاوز أي مدة.

**5. الدماغ المنقسم عند التئام الشبكة**
مع الانتخاب القائم على النصاب، لا يستطيع انتخاب قائد جديد إلا جانب الأغلبية، لكن القائد القديم في جانب الأقلية قد يظل يظن أنه القائد. وعند التئام الشبكة تُنزله الفترة الأعلى (في Raft) أو الجلسة المنتهية (في ZooKeeper) — لكن أي كتابات أرسلها في الأثناء يجب أن تكون قد رُفضت بالتسييج.

---

## نصائح للإنتاج

**استخدم عنقود ZooKeeper أو etcd مخصصًا**
مشاركة عنقود ZooKeeper أو etcd بين عدة تطبيقات في مؤسسة مالية مغرية لأسباب الكلفة. تجنبها: فتطبيق مزعج يستهلك مراقبات ZooKeeper بكثرة قد يسبب انتهاء مهل الانتخاب في كل التطبيقات المعتمدة في الوقت نفسه.

**راقب أحداث انتخاب القائد كمقياس للموثوقية**
يجب تسجيل كل حدث انتخاب وقياسه. فارتفاع عدد الانتخابات يدل على عدم استقرار العنقود — مشكلات شبكة، أو توقفات GC، أو عقد مثقلة. وأطلق تنبيهًا عند وقوع أكثر من انتخابين خلال 5 دقائق.

**اختبر تحويل القيادة بهندسة الفوضى**
أسوأ وقت لاكتشاف أن تحويل القيادة يستغرق 45 ثانية بدل 5 ثوانٍ المتوقعة هو أثناء حادث. شغّل اختبارات فوضى منتظمة تقتل عقدة القائد وتقيس زمن تفعيل قائد جديد واستئناف المعالجة.

**وثّق أقصى فجوة في القيادة**
وثّق رسميًا واختبر أقصى زمن بين تعطل القائد واكتمال انتخاب قائد جديد. ففي مهمة تسوية مدفوعات، هذا هو أقصى تأخير في معالجة التسوية. ويحتاج أصحاب المصلحة في العمل إلى هذا الرقم لضبط توقعات اتفاقية مستوى الخدمة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "عنقود Raft فيه 5 عقد. كم عطلًا في العقد يستطيع تحمّله مع بقاء قدرته على انتخاب قائد والتزام المدخلات؟",
      "options": [
        "عقدة واحدة — يحتاج العنقود إلى اتفاق العقد الخمس على القائد.",
        "عقدتان — يحتاج العنقود إلى نصاب 3 من 5 لانتخاب قائد والتزام المدخلات.",
        "3 عقد — يستطيع العنقود العمل بأي عقدتين باقيتين تشكلان نصابًا.",
        "4 عقد — لا يفشل العنقود إلا إذا تعطلت العقد الخمس معًا."
      ],
      "correct": 1,
      "explanation": "يحتاج عنقود Raft من N عقدة إلى نصاب floor(N/2)+1 لانتخاب قائد والتزام مدخلات السجل. ولـ N=5 يكون النصاب 3، فيتحمل العنقود عطلين (5-3=2). ومع عقدتين باقيتين فقط لا تستطيع أي منهما تشكيل نصاب فيصبح العنقود غير متاح — وهذه هي المفاضلة الصحيحة بين السلامة والحيوية."
    },
    {
      "text": "يستخدم انتخاب قائد مبني على ZooKeeper عقدة znode مؤقتة تسلسلية. العقدة B تملك znode القائد ثم تتعطل. ما الآلية التي تجعل العقدة C القائد الجديد؟",
      "options": [
        "ترسل العقدة B رسالة 'تنحٍّ' إلى العقدة C قبل تعطلها، فيبدأ نقل مخطط للقيادة.",
        "يكتشف ZooKeeper انتهاء مهلة جلسة العقدة B ويحذف تلقائيًا znode المؤقتة الخاصة بها؛ فتتلقى العقدة C، التي كانت تراقب تلك znode، حدث حذف وترقّي نفسها.",
        "تفحص مهمة cron عقدة znode القائد كل 30 ثانية وتعيد تعيين القيادة إذا لم يستجب القائد الحالي.",
        "تحتفظ العقدة C بنسخة من znode القائد وتفعّلها بعد 10 ثوانٍ بلا نبضة من العقدة B."
      ],
      "correct": 1,
      "explanation": "تُحذف العقد المؤقتة في ZooKeeper تلقائيًا عندما تنتهي الجلسة التي أنشأتها (ينقطع العميل أو تنتهي مهلته). فعندما تتعطل العقدة B تنتهي جلستها، فيحذف ZooKeeper عقدة القائد، وتتلقى العقدة C (التي كانت تراقب znode عبر Watcher) حدث NodeDeleted. ثم تحاول C أن تصبح القائد — فإن نجحت صارت القائد الجديد."
    },
    {
      "text": "قفل في etcd مأخوذ بإيجار لا يُبقى حيًا أثناء تنفيذ العمل. لماذا يجب أن تكون مدته أطول بكثير من أقصى مدة متوقعة للعملية؟",
      "options": [
        "المدة القصيرة جدًا تجعل etcd ينسخ حالة القفل بتكرار أكبر، فيزيد تضخيم الكتابة في العنقود.",
        "المدة الأقصر من مدة العملية قد تنتهي بينما ما زال مالك القفل يعالج، فتملك عقدتان القفل في الوقت نفسه — وهو بالضبط سيناريو الدماغ المنقسم الذي صُمم القفل لمنعه.",
        "يفرض etcd حدًا أدنى للمدة قدره 30 ثانية، فالمدد القصيرة غير ممكنة تقنيًا.",
        "المدة القصيرة تجعل مالك القفل يرسل طلبات نبض مفرطة إلى etcd، فتُغرق العنقود تحت الحمل العالي."
      ],
      "correct": 1,
      "explanation": "إذا انتهت المدة بينما ما زال مالك القفل يعالج (بسبب توقف GC، أو استعلام بطيء، أو تأخر الشبكة)، تأخذ عقدة أخرى القفل. فتعمل عقدتان كمالكتين في الوقت نفسه — وهي حالة الدماغ المنقسم التي صُمم القفل لمنعها. والهامش الكبير يساعد، لكن التصميم المتين يُبقي الإيجار حيًا أثناء العمل ويستخدم رموز التسييج، لأن توقفًا طويلًا قد يتجاوز أي مدة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ انتخاب القائد والقفل الموزع لمهام المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "نفّذ انتخاب قائد مبنيًا على ZooKeeper باستخدام LeaderLatch من Apache Curator. واكتب SettlementJobCoordinator يأخذ القيادة عبر LeaderLatch، ويشغّل التسوية الدفعية فقط عندما يكون القائد، ويحرر القيادة بلطف عند الإيقاف. وأضف مقاييس Micrometer تتتبع: (أ) حالة القيادة الحالية (1=قائد، 0=تابع)، (ب) عدد انتقالات القيادة في آخر 5 دقائق، (ج) الزمن منذ آخر أخذ ناجح للقيادة. واكتب اختبارًا باستخدام نسخة ZooKeeper محلية يشغّل ثلاث عقد ويتحقق من أن واحدة فقط تشغّل مهمة التسوية."},
    {"id": "2", "description": "نفّذ قفلًا موزعًا مبنيًا على etcd باستخدام Jetcd. واكتب صنف DistributedPaymentLock يأخذ إيجارًا في etcd، ويُنشئ مفتاحًا مرتبطًا بالإيجار كمدة، ويحرر القفل بحذف المفتاح وإلغاء الإيجار. ونفّذ آلية keepalive تجدد الإيجار كل TTL/3 ثانية ما دام القفل مأخوذًا. واكتب اختبارًا يحاكي موت مالك القفل (بعدم تجديد الإيجار) ويتحقق من أن عقدة أخرى تأخذ القفل خلال مدة TTL واحدة."},
    {"id": "3", "description": "نفّذ تسجيل مفاتيح منع التكرار باستخدام معاملات etcd. واكتب IdempotencyKeyRegistry تستخدم عملية مقارنة-وتبديل في etcd لفحص وجود المفتاح وإنشائه ذريًا فقط إذا لم يكن موجودًا. ويجب أن تضبط السجلّ مدة 24 ساعة لكل مفتاح. واكتب اختبارًا متزامنًا بـ 10 خيوط تسجّل كلها مفتاح منع التكرار نفسه في الوقت نفسه، وتحقق من نجاح واحد بالضبط وحصول التسعة الآخرين على DuplicateIdempotencyKeyException."},
    {"id": "4", "description": "اكتب اختبار هندسة فوضى لتحويل قيادة انتخاب القائد. يجب أن يقوم الاختبار بما يلي: (أ) تشغيل عنقود Raft من 3 عقد (بتنفيذ Raft مضمّن أو testcontainers)، (ب) انتخاب قائد وبدء معالجة أحداث الدفع، (ج) قتل عقدة القائد، (د) قياس الزمن حتى يصبح القائد الجديد نشطًا ويستأنف المعالجة، (هـ) التأكد من أن التحويل يكتمل خلال 10 ثوانٍ وأن أي حدث دفع لا يُعالج مرتين. وسجّل أقصى فجوة في القيادة في تقرير الاختبار."}
  ]
}
-->
