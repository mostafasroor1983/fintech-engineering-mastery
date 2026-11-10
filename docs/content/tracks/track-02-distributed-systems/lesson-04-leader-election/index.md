---
id: track-02-lesson-04
title: "Leader Election — Paxos, Raft, and ZooKeeper"
slug: leader-election
track: track-02
trackName: "Distributed Systems Engineering"
sequence: 4
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [Paxos, Raft, ZooKeeper, leader-election, consensus]
prerequisites: []
---

# Leader Election — Paxos, Raft, and ZooKeeper

> [!NOTE]
> When a payment settlement job runs on two nodes simultaneously, it may process the same batch twice — crediting accounts double and debiting them double. When a distributed lock has two concurrent holders, two payments may both pass a balance check that would have rejected one of them. Leader election is the mechanism that ensures exactly one node acts as the coordinator at any time — and in financial systems, "exactly one" is not a suggestion.

## Why Leader Election Matters in Fintech

Many financial operations are inherently single-threaded:

- **Settlement batch jobs**: End-of-day settlement must run exactly once
- **Idempotency key registry writer**: One authoritative writer prevents duplicates
- **Payment sequencing**: Assigning sequence numbers to payments must be monotonically increasing from a single source
- **Fee calculation jobs**: Monthly fee calculation must run exactly once per customer
- **Regulatory report generation**: Basel III or IFRS 9 reports cannot be generated twice with different data

The naive solution — a cron job on a single server — fails when that server goes down. The distributed solution requires **consensus** among multiple nodes to elect a single leader.

```
Leader Election Problem:

  Node A, Node B, Node C — any node can fail at any time
  After any failure, exactly one surviving node must be LEADER

  Safety:    At most one leader at any time
  Liveness:  Eventually, a leader will be elected

  These cannot both be guaranteed unless we accept that liveness
  requires a quorum (majority) of nodes to be available.

  Quorum for 3 nodes: 2
  Quorum for 5 nodes: 3
```

---

## Paxos: The Foundation

Paxos is the theoretical foundation of most consensus algorithms. It is notoriously difficult to understand and implement correctly, but understanding its structure illuminates why practical algorithms like Raft exist.

### The Paxos Roles

- **Proposer**: Proposes a value to be chosen
- **Acceptor**: Votes on proposals; majority of acceptors determines the outcome
- **Learner**: Learns the chosen value

### Single-Decree Paxos (Conceptual)

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

### Why Paxos Is Hard to Implement

1. **Multi-Paxos** (for a sequence of values) requires complex log management
2. **Leader changes** in Paxos require a full round of Paxos to elect a new proposer
3. **Configuration changes** (adding/removing nodes) require careful Paxos variants
4. **Liveness under contention** is not guaranteed — competing proposers can livelock

This motivated the development of Raft, which achieves the same safety properties with a more understandable structure.

---

## Raft Consensus Algorithm

Raft decomposes consensus into three relatively independent sub-problems:
1. **Leader election**: Ensuring exactly one leader at any time
2. **Log replication**: Leader accepting entries and replicating them to followers
3. **Safety**: Ensuring committed entries are never lost

### Raft Leader Election Walk-Through

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
           B has not voted in term 1, B's log is not newer than A
           -> B grants vote, resets timeout

  t=152ms: Node C receives RequestVote
           -> C grants vote, resets timeout

  t=153ms: Node A receives votes from B and C (majority of 3)
           -> Node A becomes LEADER for term 1
           Begins sending heartbeats every 50ms
```

### Raft Implementation in Java

```java
// Raft node state machine — simplified for illustration
// Production implementations use io.etcd/jetcd or similar libraries

public class RaftNode {

    private volatile NodeState state = NodeState.FOLLOWER;
    private volatile int       currentTerm = 0;
    private volatile String    votedFor    = null;
    private volatile String    currentLeaderId = null;

    private final String       nodeId;
    private final List<String> peerIds;
    private final RaftRpc      rpc;
    private final RaftLog      log;

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
                .lastLogIndex(log.getLastIndex())
                .lastLogTerm(log.getLastTerm())
                .build();

            rpc.sendRequestVoteAsync(peerId, request)
               .thenAccept(response -> {
                   synchronized (this) {
                       if (response.term() > currentTerm) {
                           // A higher term exists — revert to follower
                           becomeFollower(response.term());
                           return;
                       }

                       if (state != NodeState.CANDIDATE) return;
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
                .prevLogIndex(log.getLastIndex())
                .prevLogTerm(log.getLastTerm())
                .entries(List.of())  // Empty = heartbeat
                .leaderCommit(log.getCommitIndex())
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

---

## ZooKeeper Leader Election

For production financial systems, implementing Raft from scratch is unnecessary. ZooKeeper provides a battle-tested distributed coordination service with leader election as a first-class primitive.

### ZooKeeper Ephemeral Nodes Pattern

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

        // LeaderLatch uses ephemeral sequential nodes under /payment-jobs/leader
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

### Settlement Job with Leader Election

```java
@Service
public class SettlementBatchService {

    private final ZooKeeperLeaderElection leaderElection;
    private final SettlementRepository    settlementRepo;
    private final LedgerService           ledger;
    private final MeterRegistry           metrics;

    /**
     * This job runs on all nodes, but only the leader actually processes.
     * Non-leaders skip the work. When the leader fails, ZooKeeper
     * elects a new leader within seconds, and the job runs on the new leader.
     */
    @Scheduled(cron = "0 0 23 * * *")  // 11 PM daily
    public void runEndOfDaySettlement() {
        if (!leaderElection.isLeader()) {
            log.debug("Skipping settlement — not the leader");
            return;
        }

        log.info("Node {} running end-of-day settlement as leader",
                  nodeId);

        LocalDate settlementDate = LocalDate.now();

        // Check idempotency: has settlement already run today?
        if (settlementRepo.hasSettlementCompleted(settlementDate)) {
            log.warn("Settlement already completed for {}. Skipping.",
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

---

## etcd Leader Election

etcd is a popular alternative to ZooKeeper, used extensively in Kubernetes environments. It is well-suited to cloud-native fintech deployments.

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

---

## Fencing Tokens

A critical issue in leader election: **the deposed leader may not know it has been deposed**. Consider:

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

**Fencing tokens** solve this: every leadership grant includes a monotonically increasing token. The database (or any resource) rejects operations from holders of older tokens.

```java
// Fencing token implementation using ZooKeeper session IDs
// ZooKeeper session IDs are monotonically increasing

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
                // The database checks: is this token >= the last seen token?
                // If not, it rejects the write — the leader has changed.
                PreparedStatement stmt = conn.prepareStatement(
                    "INSERT INTO payment_processing_log " +
                    "(payment_id, processed_at, leader_token) " +
                    "SELECT ?, NOW(), ? " +
                    "WHERE NOT EXISTS (" +
                    "  SELECT 1 FROM leader_state " +
                    "  WHERE current_token > ?" +
                    ")"
                );
                stmt.setString(1, payment.paymentId());
                stmt.setLong(2, fencingToken);
                stmt.setLong(3, fencingToken);

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

---

## Spring Integration: Leader Election with Spring Batch

```java
// Spring Batch with ZooKeeper leader election for distributed jobs

@Configuration
@EnableBatchProcessing
public class SettlementBatchConfig {

    @Bean
    public Job settlementJob(JobBuilderFactory jobs,
                              StepBuilderFactory steps,
                              ZooKeeperLeaderElection election) {
        return jobs.get("settlement-job")
            .start(steps.get("leader-check-step")
                .<Payment, Payment>chunk(100)
                .reader(pendingPaymentsReader())
                .processor(item -> {
                    // Double-check leadership before processing each chunk
                    if (!election.isLeader()) {
                        throw new LeadershipLostException(
                            "Leadership lost mid-batch; aborting"
                        );
                    }
                    return item;
                })
                .writer(settlementWriter())
                .faultTolerant()
                .skipLimit(0)  // No skips — financial data must be perfect
                .build()
            )
            .build();
    }
}
```

---

## Common Pitfalls

**1. Not Accounting for the Leader Thinking It's Still Leader**
A leader that has been network-partitioned away from the quorum may continue operating for the duration of its lease TTL. All writes during this window may be rejected (or cause split-brain) when the new leader is elected. Never set lease TTL below 2x the maximum expected network partition duration.

**2. Using Database Row Locks as Leader Election**
`SELECT FOR UPDATE` on a "leader" row in the database is not a reliable leader election mechanism. If the application crashes without releasing the lock, the lock may persist indefinitely (depending on the database's connection handling). Use purpose-built tools (ZooKeeper, etcd) for distributed coordination.

**3. Ignoring Fencing Tokens**
Implementing leader election without fencing tokens leaves you vulnerable to deposed leaders continuing to write data. A deposed leader that writes to the payment database can corrupt settlement results. Always implement fencing.

**4. Too-Short Lease Periods**
Lease periods shorter than the maximum GC pause time (which can be hundreds of milliseconds in Java) will cause leaders to expire their leases during GC pauses. Set lease TTL to at least 5x the maximum expected GC pause time.

**5. Split-Brain During Network Heals**
When a network partition heals, both partitions may have elected leaders. The resolution protocol (term comparison in Raft, session ID comparison in ZooKeeper) must correctly identify and demote the stale leader before any writes are accepted.

---

## Production Tips

**Use a Dedicated ZooKeeper or etcd Cluster**
Sharing a ZooKeeper or etcd cluster between multiple applications in a financial institution is tempting for cost reasons. Avoid it: a noisy application consuming excessive ZooKeeper watches can cause election timeouts across all dependent applications simultaneously.

**Monitor Leader Election Events as a Reliability Metric**
Every leader election event should be logged and metered. A spike in elections indicates cluster instability — network issues, GC pauses, or overloaded nodes. Alert when more than 2 elections occur in a 5-minute window.

**Test Leadership Failover with Chaos Engineering**
The worst time to discover that leadership failover takes 45 seconds instead of the expected 5 seconds is during an incident. Run regular chaos tests that kill the leader node and measure the time for a new leader to become active and resume processing.

**Document the Maximum Leadership Gap**
Formally document and test the maximum time between leader failure and new leader election completing. For a payment settlement job, this is the maximum delay in settlement processing. Business stakeholders need this number to set their SLA expectations.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A Raft cluster has 5 nodes. How many node failures can it tolerate while still being able to elect a leader and commit entries?",
      "options": [
        "1 node — the cluster requires all 5 nodes to agree on a leader.",
        "2 nodes — the cluster needs a quorum of 3 out of 5 to elect a leader and commit entries.",
        "3 nodes — the cluster can operate with any 2 surviving nodes forming a quorum.",
        "4 nodes — the cluster only fails if all 5 nodes are down simultaneously."
      ],
      "correct": 1,
      "explanation": "A Raft cluster of N nodes requires a quorum of floor(N/2)+1 nodes to elect a leader and commit log entries. For N=5, the quorum is 3, so the cluster can tolerate 2 failures (5-3=2). With only 2 surviving nodes, neither can form a quorum and the cluster becomes unavailable — the correct safety/liveness trade-off."
    },
    {
      "text": "A ZooKeeper-based leader election uses an ephemeral sequential znode. Node B holds the leader znode and crashes. What is the mechanism that causes Node C to become the new leader?",
      "options": [
        "Node B sends a 'stepping down' message to Node C before crashing, triggering a planned leadership transfer.",
        "ZooKeeper detects the session timeout for Node B and automatically deletes its ephemeral znode; Node C, which was watching that znode, receives a deletion event and promotes itself.",
        "A cron job checks the ZooKeeper leader znode every 30 seconds and reassigns leadership if the current leader is unresponsive.",
        "Node C holds a copy of the leader znode and activates its own copy after a 10-second timeout with no heartbeat from Node B."
      ],
      "correct": 1,
      "explanation": "ZooKeeper ephemeral nodes are automatically deleted when the creating session expires (the client disconnects or times out). When Node B crashes, its session expires, ZooKeeper deletes the leader znode, and Node C (which was watching the znode with a Watcher) receives a NodeDeleted event. Node C then attempts to create a new leader znode — if successful, it becomes the new leader."
    },
    {
      "text": "Why should the etcd distributed lock TTL be set to 2-3 times the maximum expected operation duration, rather than a very short TTL?",
      "options": [
        "A very short TTL causes etcd to replicate the lock state more frequently, increasing write amplification across the cluster.",
        "A TTL shorter than the operation duration can expire while the lock holder is still processing, causing two nodes to simultaneously hold the lock — the exact split-brain scenario the lock is designed to prevent.",
        "etcd enforces a minimum TTL of 30 seconds, so short TTLs are not technically possible.",
        "A short TTL causes the lock holder to send excessive heartbeat requests to etcd, overwhelming the cluster under high load."
      ],
      "correct": 1,
      "explanation": "If the TTL expires while the lock holder is still processing (due to a GC pause, slow query, or network delay), another node acquires the lock. Now two nodes hold the same lock simultaneously — the split-brain condition the lock was designed to prevent. Setting TTL to 2-3x the expected operation duration provides a safety margin for variability in processing time."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Leader Election and Distributed Locking for Payment Jobs",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a ZooKeeper-based leader election using Apache Curator's LeaderLatch. Write a SettlementJobCoordinator that acquires leadership using LeaderLatch, runs the settlement batch only when it is the leader, and gracefully releases leadership on shutdown. Add Micrometer metrics that track: (a) current leadership status (1=leader, 0=follower), (b) number of leadership transitions in the last 5 minutes, and (c) time since last successful leadership acquisition. Write a test using a local ZooKeeper instance that starts three nodes and verifies only one runs the settlement job."},
    {"id": "2", "description": "Implement an etcd-based distributed lock using Jetcd. Write a DistributedPaymentLock class that acquires an etcd lease, creates a key with the lease as TTL, and releases the lock by deleting the key and revoking the lease. Implement a keepalive mechanism that refreshes the lease every TTL/3 seconds while the lock is held. Write a test that simulates the lock holder dying (by not refreshing the lease) and verifies another node acquires the lock within one TTL period."},
    {"id": "3", "description": "Implement idempotency key registration using etcd transactions. Write an IdempotencyKeyRegistry that uses an etcd compare-and-swap operation to atomically check if a key exists and create it only if it does not. The registry must set a TTL of 24 hours on each key. Write a concurrent test with 10 threads all registering the same idempotency key simultaneously and verify that exactly one succeeds and the other nine receive a DuplicateIdempotencyKeyException."},
    {"id": "4", "description": "Write a chaos engineering test for leader election failover. The test must: (a) start a 3-node Raft cluster (using an embedded Raft implementation or testcontainers), (b) elect a leader and begin processing payment events, (c) kill the leader node, (d) measure the time for the new leader to become active and resume processing, and (e) assert that failover completes within 10 seconds and no payment events are processed twice. Report the maximum leadership gap to a test report."}
  ]
}
-->
