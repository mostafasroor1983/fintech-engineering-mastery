---
id: track-02-lesson-05
title: "Consensus in Financial Systems — Practical Applications"
slug: consensus-financial
track: track-02
trackName: "Distributed Systems Engineering"
sequence: 5
difficulty: principal
estimatedMinutes: 85
status: published
tags: [consensus, financial-systems, etcd, distributed-commit, coordinator]
prerequisites: []
---

# Consensus in Financial Systems — Practical Applications

> [!NOTE]
> Consensus is not a theoretical curiosity — it is the mechanism that prevents a payment processor from crediting the same account twice, allows a job scheduler to run end-of-day settlement exactly once across a cluster, and ensures that a distributed lock is held by exactly one service instance at a time. Every fintech system at scale uses consensus, usually without realizing it. The question is whether it is used deliberately and correctly.

## What Consensus Actually Solves in Fintech

Before diving into algorithms and tooling, let us be precise about the class of problems that consensus solves in financial systems.

**Consensus** is the problem of getting a group of nodes to agree on a single value, even when some nodes may fail. More formally, a consensus algorithm must satisfy:

- **Agreement**: No two correct nodes decide different values
- **Validity**: The decided value was proposed by some node
- **Termination**: Every correct node eventually decides a value

In practice, fintech engineers encounter consensus in three patterns:

| Pattern | Fintech Example | What Consensus Prevents |
|---|---|---|
| Leader election | Settlement job coordinator | Two nodes both running settlement, double-crediting accounts |
| Distributed lock | Idempotency key registration | Two requests both creating the same payment record |
| Distributed commit | Multi-partition transaction | Partial commits leaving accounts in inconsistent state |

The critical insight is that you almost never implement consensus yourself. You use a system that provides it — etcd, ZooKeeper, or a database with serializable isolation — and you use it correctly.

---

## Raft Consensus: The Intuition You Need

Raft was designed to be more understandable than Paxos while providing equivalent guarantees. As a principal engineer, you need the intuition, not the full proof.

### The Three Roles

```
Raft Node States:

  FOLLOWER  → receives log entries from leader, votes in elections
  CANDIDATE → running for leader, requesting votes from peers
  LEADER    → receives client writes, replicates log to followers

State transitions:
  FOLLOWER → CANDIDATE: election timeout expires (no heartbeat from leader)
  CANDIDATE → LEADER:   receives votes from majority of cluster
  CANDIDATE → FOLLOWER: discovers leader with higher term
  LEADER → FOLLOWER:    discovers node with higher term
```

### Log Replication: The Core Mechanism

```
Payment write request arrives at leader:

  Client → Leader: "Transfer $1000 from acct-A to acct-B, idempotency=txn-789"

  Step 1: Leader appends to its log (uncommitted)
    Log[42]: {term:3, op: TRANSFER, from:acct-A, to:acct-B, amount:1000, key:txn-789}

  Step 2: Leader sends AppendEntries RPC to all followers
    Leader → Follower-1: AppendEntries(term=3, prevLogIndex=41, entries=[Log[42]])
    Leader → Follower-2: AppendEntries(term=3, prevLogIndex=41, entries=[Log[42]])
    Leader → Follower-3: AppendEntries(term=3, prevLogIndex=41, entries=[Log[42]])

  Step 3: Followers append to their logs, respond success

  Step 4: Leader receives majority (2 of 3 followers) → commits entry
    Leader marks Log[42] committed, applies to state machine

  Step 5: Leader notifies followers of commit on next heartbeat

  Step 6: Leader responds success to client

If Follower-3 is partitioned:
  - Leader still commits after Follower-1 and Follower-2 respond
  - Follower-3 will catch up when partition heals
  - Client received a successful response — the write is durable
```

### Leader Election in Raft

```
Election scenario (3-node cluster):

  Normal operation:
    Leader sends heartbeats every 150ms
    Followers reset election timer on heartbeat (timeout: 150-300ms randomized)

  Leader fails:
    - Follower-1 election timer expires first (randomized timeout)
    - Follower-1 → CANDIDATE, increments term to 4
    - Follower-1 → Follower-2: RequestVote(term=4, lastLogIndex=41, lastLogTerm=3)
    - Follower-1 → Follower-3: RequestVote(term=4, lastLogIndex=41, lastLogTerm=3)

  Vote granting rules:
    - Only vote for candidate if candidate log is at least as up-to-date as own log
    - Only vote once per term

  Follower-2 grants vote (hasn't voted this term, candidate log is current)
  Follower-1 wins majority (itself + Follower-2)
  Follower-1 → LEADER, starts sending heartbeats

  Time to new leader: election timeout + RPC round trip ~ 300-600ms
```

### The Quorum Requirement

```
Cluster size vs fault tolerance:

  3 nodes: tolerates 1 failure  (quorum = 2)
  5 nodes: tolerates 2 failures (quorum = 3)
  7 nodes: tolerates 3 failures (quorum = 4)

  For financial systems:
  - 3-node cluster is minimum for any HA requirement
  - 5-node cluster is standard for critical payment infrastructure
  - Spread across 3+ availability zones

  Rule: quorum = floor(N/2) + 1

  Write latency impact (AWS us-east-1 intra-region):
  - 3-node, single AZ: ~1ms replication lag
  - 3-node, multi-AZ:  ~5-10ms replication lag (AZ-to-AZ RTT)
  - 5-node, multi-AZ:  ~5-10ms replication lag (need 2/4 followers)
```

---

## etcd for Financial Coordination

etcd is the distributed key-value store embedded in Kubernetes and widely used for distributed coordination. It implements Raft and provides the primitives fintech engineers need.

### Setting Up etcd for Payment Coordination

```yaml
# docker-compose for local development (3-node cluster)
version: '3.8'
services:
  etcd-1:
    image: quay.io/coreos/etcd:v3.5.9
    command:
      - etcd
      - --name=etcd-1
      - --initial-advertise-peer-urls=http://etcd-1:2380
      - --listen-peer-urls=http://0.0.0.0:2380
      - --listen-client-urls=http://0.0.0.0:2379
      - --advertise-client-urls=http://etcd-1:2379
      - --initial-cluster=etcd-1=http://etcd-1:2380,etcd-2=http://etcd-2:2380,etcd-3=http://etcd-3:2380
      - --initial-cluster-state=new
      - --initial-cluster-token=payment-cluster
      # Production: set appropriate quotas
      - --quota-backend-bytes=8589934592   # 8GB
      - --auto-compaction-mode=periodic
      - --auto-compaction-retention=1h
    ports:
      - "2379:2379"

  etcd-2:
    image: quay.io/coreos/etcd:v3.5.9
    command:
      - etcd
      - --name=etcd-2
      - --initial-advertise-peer-urls=http://etcd-2:2380
      - --listen-peer-urls=http://0.0.0.0:2380
      - --listen-client-urls=http://0.0.0.0:2379
      - --advertise-client-urls=http://etcd-2:2379
      - --initial-cluster=etcd-1=http://etcd-1:2380,etcd-2=http://etcd-2:2380,etcd-3=http://etcd-3:2380
      - --initial-cluster-state=new
      - --initial-cluster-token=payment-cluster

  etcd-3:
    image: quay.io/coreos/etcd:v3.5.9
    command:
      - etcd
      - --name=etcd-3
      - --initial-advertise-peer-urls=http://etcd-3:2380
      - --listen-peer-urls=http://0.0.0.0:2380
      - --listen-client-urls=http://0.0.0.0:2379
      - --advertise-client-urls=http://etcd-3:2379
      - --initial-cluster=etcd-1=http://etcd-1:2380,etcd-2=http://etcd-2:2380,etcd-3=http://etcd-3:2380
      - --initial-cluster-state=new
      - --initial-cluster-token=payment-cluster
```

### etcd Java Client Configuration

```java
// build.gradle
dependencies {
    implementation 'io.etcd:jetcd-core:0.7.5'
}
```

```java
package com.fintech.coordination;

import io.etcd.jetcd.Client;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import java.time.Duration;

@Configuration
public class EtcdConfiguration {

    @Bean
    public Client etcdClient() {
        return Client.builder()
            .endpoints(
                "http://etcd-1:2379",
                "http://etcd-2:2379",
                "http://etcd-3:2379"
            )
            .connectTimeout(Duration.ofSeconds(5))
            .keepaliveTime(Duration.ofSeconds(10))
            .keepaliveTimeout(Duration.ofSeconds(5))
            .retryMaxDuration(Duration.ofSeconds(10))
            .retryDelay(100)
            .retryMaxDelay(2000)
            .build();
    }
}
```

---

## Pattern 1: Distributed Lock for Idempotency

The most common use of consensus in payment systems is ensuring that a payment is processed exactly once. The distributed lock prevents concurrent processing of the same idempotency key.

### The Problem Without Locks

```
Without distributed lock:
  T=0ms:  Request-A arrives at Pod-1: "Process payment idempotency=pay-123"
  T=0ms:  Request-B arrives at Pod-2: "Process payment idempotency=pay-123" (retry)

  T=1ms:  Pod-1 checks DB: no record for pay-123 → proceeds
  T=1ms:  Pod-2 checks DB: no record for pay-123 → proceeds

  T=50ms: Pod-1 debits account, inserts record
  T=50ms: Pod-2 debits account, inserts record (DUPLICATE)

  Result: Account debited twice. Customer support nightmare.
```

### Distributed Lock with etcd Leases

```java
package com.fintech.coordination;

import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.Client;
import io.etcd.jetcd.lock.LockResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

@Slf4j
@Component
@RequiredArgsConstructor
public class EtcdDistributedLock {

    private final Client etcdClient;

    // Lock TTL — must be longer than max expected operation time
    // but short enough that a dead node's lock expires reasonably
    private static final long LOCK_TTL_SECONDS = 30;

    /**
     * Acquires a distributed lock on the given key, executes the action,
     * then releases the lock. If the lock cannot be acquired within
     * acquireTimeoutMs, throws LockAcquisitionException.
     *
     * Financial context: used to serialize payment processing for a
     * given idempotency key across all pods in the cluster.
     */
    public <T> T withLock(String lockKey, long acquireTimeoutMs, Supplier<T> action)
            throws LockAcquisitionException {

        var leaseClient = etcdClient.getLeaseClient();
        var lockClient  = etcdClient.getLockClient();

        long leaseId = -1;
        ByteSequence lockName = null;

        try {
            // Step 1: Create a lease — this gives the lock a TTL.
            // If this process dies, the lease expires and the lock is released.
            leaseId = leaseClient.grant(LOCK_TTL_SECONDS)
                .get(5, TimeUnit.SECONDS)
                .getID();

            // Step 2: Start keepalive to prevent lease expiry during long operations.
            // Without keepalive the lock expires while work is in progress.
            final long finalLeaseId = leaseId;
            var keepAlive = leaseClient.keepAlive(finalLeaseId,
                new io.grpc.stub.StreamObserver<>() {
                    @Override public void onNext(io.etcd.jetcd.lease.LeaseKeepAliveResponse r) {}
                    @Override public void onError(Throwable t) {
                        log.error("CRITICAL: Lease keepalive failed for key={} — lock may expire mid-operation", lockKey, t);
                    }
                    @Override public void onCompleted() {}
                }
            );

            try {
                // Step 3: Acquire lock (blocks until lock is available or timeout)
                ByteSequence lockKeyBytes = ByteSequence.from(
                    "/fintech/locks/payments/" + lockKey, StandardCharsets.UTF_8
                );

                LockResponse lockResponse = lockClient.lock(lockKeyBytes, finalLeaseId)
                    .get(acquireTimeoutMs, TimeUnit.MILLISECONDS);

                lockName = lockResponse.getKey();
                log.debug("Acquired distributed lock: key={}", lockKey);

                // Step 4: Execute the protected action
                return action.get();

            } finally {
                keepAlive.close();
                if (lockName != null) {
                    lockClient.unlock(lockName).get(5, TimeUnit.SECONDS);
                    log.debug("Released distributed lock: key={}", lockKey);
                }
            }

        } catch (java.util.concurrent.TimeoutException e) {
            throw new LockAcquisitionException(
                "Could not acquire lock for key=" + lockKey + " within " + acquireTimeoutMs + "ms", e);
        } catch (Exception e) {
            Thread.currentThread().interrupt();
            throw new LockAcquisitionException("Lock operation failed for key=" + lockKey, e);
        } finally {
            if (leaseId != -1) {
                try {
                    leaseClient.revoke(leaseId).get(5, TimeUnit.SECONDS);
                } catch (Exception ex) {
                    log.warn("Failed to revoke lease {} for key={} — TTL will clean it up", leaseId, lockKey, ex);
                }
            }
        }
    }
}
```

### Payment Service Using the Distributed Lock

```java
package com.fintech.payment;

import com.fintech.coordination.EtcdDistributedLock;
import com.fintech.coordination.LockAcquisitionException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentProcessingService {

    private final EtcdDistributedLock distributedLock;
    private final PaymentRepository    paymentRepository;
    private final AccountService       accountService;
    private final AuditService         auditService;

    /**
     * Process a payment with distributed idempotency guarantee.
     *
     * The distributed lock ensures that even if two pods receive
     * the same idempotency key concurrently, only one will execute
     * the actual payment logic. The second will block at the lock,
     * then find the existing record and return it.
     */
    public PaymentResult processPayment(PaymentRequest request) {
        String lockKey = "payment-" + request.getIdempotencyKey();

        try {
            return distributedLock.withLock(lockKey, 5_000, () -> {
                // Inside the lock: check if already processed
                return paymentRepository.findByIdempotencyKey(request.getIdempotencyKey())
                    .map(existing -> {
                        log.info("Payment already processed: idempotencyKey={} paymentId={}",
                            request.getIdempotencyKey(), existing.getId());
                        return PaymentResult.alreadyProcessed(existing);
                    })
                    .orElseGet(() -> executePayment(request));
            });

        } catch (LockAcquisitionException e) {
            // Another node is currently processing the same key.
            // Return 429 or retry after delay — do NOT process twice.
            log.warn("Concurrent processing for idempotencyKey={}", request.getIdempotencyKey());
            throw new PaymentConcurrentProcessingException(
                "Payment " + request.getIdempotencyKey() + " is currently being processed", e);
        }
    }

    @Transactional
    private PaymentResult executePayment(PaymentRequest request) {
        log.info("Executing payment: idempotencyKey={} amount={} currency={}",
            request.getIdempotencyKey(), request.getAmount(), request.getCurrency());

        accountService.debit(
            request.getSourceAccountId(), request.getAmount(), request.getCurrency());
        accountService.credit(
            request.getDestinationAccountId(), request.getAmount(), request.getCurrency());

        Payment payment = paymentRepository.save(Payment.builder()
            .idempotencyKey(request.getIdempotencyKey())
            .sourceAccountId(request.getSourceAccountId())
            .destinationAccountId(request.getDestinationAccountId())
            .amount(request.getAmount())
            .currency(request.getCurrency())
            .status(PaymentStatus.COMPLETED)
            .build());

        auditService.recordPayment(payment);
        return PaymentResult.success(payment);
    }
}
```

---

## Pattern 2: Leader Election for Job Scheduling

End-of-day settlement, monthly fee calculation, and regulatory report generation must run exactly once. Leader election via etcd ensures that exactly one pod in the cluster runs these jobs.

### etcd Lease-Based Leader Election

```java
package com.fintech.coordination;

import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.Client;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Leader election using etcd leases and a campaign-style approach.
 *
 * The key insight: whoever holds the etcd lock for the election key
 * IS the leader. When the holder's lease expires (node death) or the
 * lock is released (graceful shutdown), another candidate wins.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class EtcdLeaderElection {

    private final Client etcdClient;

    private final String nodeId = System.getenv().getOrDefault("POD_NAME",
        UUID.randomUUID().toString());

    private static final long LEASE_TTL_SECONDS = 15;
    private static final String ELECTION_PREFIX  = "/fintech/elections/";

    private final AtomicBoolean isLeader = new AtomicBoolean(false);

    /**
     * Campaigns for leadership. This method loops until interrupted:
     *   1. Acquire the election lock (blocks until won)
     *   2. Run onBecomeLeader callback
     *   3. Hold the lock via keepalive
     *   4. On error/interrupt, run onLoseLeadership and retry
     *
     * Call from a dedicated daemon thread at application startup.
     */
    public void campaignForLeadership(
            String electionName,
            Runnable onBecomeLeader,
            Runnable onLoseLeadership) {

        var leaseClient = etcdClient.getLeaseClient();
        var lockClient  = etcdClient.getLockClient();
        ByteSequence electionKey = ByteSequence.from(
            ELECTION_PREFIX + electionName, StandardCharsets.UTF_8);

        while (!Thread.currentThread().isInterrupted()) {
            long leaseId = -1;
            try {
                // Create lease
                leaseId = leaseClient.grant(LEASE_TTL_SECONDS)
                    .get(5, TimeUnit.SECONDS).getID();

                final long finalLeaseId = leaseId;
                var keepAlive = leaseClient.keepAlive(finalLeaseId,
                    new io.grpc.stub.StreamObserver<>() {
                        @Override public void onNext(io.etcd.jetcd.lease.LeaseKeepAliveResponse r) {}
                        @Override public void onError(Throwable t) {
                            log.error("Keepalive failed for election={} — may lose leadership", electionName, t);
                        }
                        @Override public void onCompleted() {}
                    }
                );

                try {
                    log.info("Campaigning for leadership: election={} nodeId={}", electionName, nodeId);

                    // This blocks until we win the election (previous leader dies/resigns)
                    var lockResponse = lockClient.lock(electionKey, finalLeaseId)
                        .get(); // No timeout — we wait indefinitely

                    isLeader.set(true);
                    log.info("ELECTED LEADER: election={} nodeId={}", electionName, nodeId);

                    try {
                        onBecomeLeader.run();
                        // Stay leader until keepalive fails or we are interrupted
                        Thread.currentThread().join(); // Wait until interrupted

                    } finally {
                        isLeader.set(false);
                        log.warn("Stepping down from leadership: election={}", electionName);
                        onLoseLeadership.run();
                        lockClient.unlock(lockResponse.getKey()).get(5, TimeUnit.SECONDS);
                    }

                } finally {
                    keepAlive.close();
                }

            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                log.error("Error in leadership campaign election={} — retrying in 5s", electionName, e);
                isLeader.set(false);
                try { Thread.sleep(5_000); } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            } finally {
                if (leaseId != -1) {
                    try {
                        leaseClient.revoke(leaseId).get(5, TimeUnit.SECONDS);
                    } catch (Exception ignored) {}
                }
            }
        }
    }

    public boolean isCurrentLeader() {
        return isLeader.get();
    }
}
```

### Settlement Job Wired to Leader Election

```java
package com.fintech.settlement;

import com.fintech.coordination.EtcdLeaderElection;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.TaskScheduler;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicReference;

@Slf4j
@Configuration
@RequiredArgsConstructor
public class SettlementJobConfiguration {

    private final EtcdLeaderElection   leaderElection;
    private final SettlementJobService settlementJobService;
    private final TaskScheduler        taskScheduler;

    private final AtomicReference<ScheduledFuture<?>> scheduledJob = new AtomicReference<>();

    @Bean
    public ApplicationRunner leaderElectionRunner() {
        return args -> {
            Thread leaderThread = new Thread(
                () -> leaderElection.campaignForLeadership(
                    "settlement-job-coordinator",
                    this::startSettlementScheduler,
                    this::stopSettlementScheduler
                ),
                "leader-election-settlement"
            );
            leaderThread.setDaemon(true);
            leaderThread.start();
            log.info("Started leader election campaign for settlement coordinator");
        };
    }

    private void startSettlementScheduler() {
        log.info("LEADER: Starting settlement job scheduler on this node");
        ScheduledFuture<?> future = taskScheduler.scheduleWithFixedDelay(
            settlementJobService::runEndOfDaySettlement,
            Instant.now(),
            Duration.ofHours(24)
        );
        scheduledJob.set(future);
    }

    private void stopSettlementScheduler() {
        log.warn("LOST LEADERSHIP: Stopping settlement scheduler");
        ScheduledFuture<?> future = scheduledJob.getAndSet(null);
        if (future != null) {
            future.cancel(false); // Do not interrupt mid-run
        }
    }
}
```

---

## Pattern 3: Watch API for Routing Configuration

The etcd Watch API lets services react instantly to configuration changes — for example, when a payment processor is added, removed, or its routing weight changes.

```java
package com.fintech.coordination;

import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.Client;
import io.etcd.jetcd.Watch;
import io.etcd.jetcd.options.WatchOption;
import io.etcd.jetcd.watch.WatchEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import javax.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;

/**
 * Watches etcd for payment routing config changes.
 * When a processor is added or removed (e.g., due to leader election),
 * this watcher updates the local routing table immediately.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PaymentRoutingWatcher {

    private final Client        etcdClient;
    private final PaymentRouter paymentRouter;

    private Watch.Watcher watcher;

    private static final String ROUTING_PREFIX = "/fintech/routing/payment-processor/";

    @PostConstruct
    public void startWatching() {
        ByteSequence prefix = ByteSequence.from(ROUTING_PREFIX, StandardCharsets.UTF_8);

        watcher = etcdClient.getWatchClient().watch(
            prefix,
            WatchOption.builder().isPrefix(true).withRevision(0).build(),
            new Watch.Listener() {

                @Override
                public void onNext(io.etcd.jetcd.watch.WatchResponse response) {
                    response.getEvents().forEach(PaymentRoutingWatcher.this::handleRoutingChange);
                }

                @Override
                public void onError(Throwable t) {
                    log.error("Routing watch error — config may be stale. Will auto-reconnect.", t);
                }

                @Override
                public void onCompleted() {
                    log.info("Watch stream completed — restarting");
                    startWatching();
                }
            }
        );

        log.info("Watching etcd routing config: prefix={}", ROUTING_PREFIX);
    }

    private void handleRoutingChange(WatchEvent event) {
        String key = event.getKeyValue().getKey().toString(StandardCharsets.UTF_8);
        String processorId = key.replace(ROUTING_PREFIX, "");

        switch (event.getEventType()) {
            case PUT -> {
                String config = event.getKeyValue().getValue().toString(StandardCharsets.UTF_8);
                log.info("Routing config updated: processorId={}", processorId);
                paymentRouter.updateProcessorConfig(processorId, config);
            }
            case DELETE -> {
                log.warn("Processor removed from routing: processorId={} — triggering failover", processorId);
                paymentRouter.removeProcessor(processorId);
            }
        }
    }

    @PreDestroy
    public void stopWatching() {
        if (watcher != null) watcher.close();
    }
}
```

---

## Consensus Overhead vs. Consistency Guarantees

### Measuring etcd Latency

```java
package com.fintech.coordination;

import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.Client;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

@Slf4j
@Component
@RequiredArgsConstructor
public class EtcdHealthCheck {

    private final Client        etcdClient;
    private final MeterRegistry meterRegistry;

    /**
     * Measure round-trip time for a consensus write.
     * A single PUT is a Raft consensus operation.
     *
     * Expected values in production:
     *   Single AZ (intra-datacenter):  1-5ms
     *   Multi-AZ (cross-datacenter):   5-20ms
     *   Cross-region:                  50-200ms (too slow for payment critical path)
     */
    public Duration measureConsensusLatency() throws Exception {
        Timer timer = meterRegistry.timer("etcd.consensus.latency");
        long start = System.nanoTime();

        etcdClient.getKVClient().put(
            ByteSequence.from("/fintech/health/probe", StandardCharsets.UTF_8),
            ByteSequence.from(String.valueOf(System.currentTimeMillis()), StandardCharsets.UTF_8)
        ).get(5, TimeUnit.SECONDS);

        Duration latency = Duration.ofNanos(System.nanoTime() - start);
        timer.record(latency);

        if (latency.toMillis() > 20) {
            log.warn("etcd consensus latency is high: {}ms — check network between etcd nodes",
                latency.toMillis());
        }

        return latency;
    }
}
```

### Decision Matrix: When to Use Consensus

```
When to use consensus (etcd/ZooKeeper):
  YES  Leader election for batch jobs (settlement, fee calculation)
  YES  Distributed lock for idempotency key registration
  YES  Configuration that must be consistent across all nodes instantly
  YES  Service discovery where stale data causes incorrect routing

When NOT to use consensus:
  NO   Per-payment routing decisions (use local cache refreshed from consensus)
  NO   Fraud score lookups (use eventual consistency — slightly stale is fine)
  NO   Rate limiting counters (use Redis with eventual consistency)
  NO   High-frequency metrics aggregation (use Kafka + stream processing)
  NO   Session state (use distributed cache)

The rule: use consensus when the cost of incorrect coordination
exceeds the cost of consensus latency.

Payment deduplication: incorrect = double charge = $$$  → use consensus
Fraud score cache:     incorrect = slightly stale data → do NOT use consensus
```

---

## Consensus in Two-Phase Commit Recovery

The distributed transaction coordinator itself needs consensus to recover correctly from crashes.

```
Two-Phase Commit with consensus-backed coordinator:

Phase 1 (Prepare):
  Coordinator → Participant-A: "Prepare debit $1000 acct-A"
  Coordinator → Participant-B: "Prepare credit $1000 acct-B"
  Coordinator → Participant-C: "Prepare audit record txn-123"
  All respond PREPARED.

Phase 2 (Commit) — coordinator persists decision to etcd FIRST:
  etcd write: /fintech/2pc/txn-123 = {"decision": "COMMIT", "participants": ["A","B","C"]}
  This is a Raft consensus write — durable across failures.

  Coordinator → Participant-A: "Commit"
  Coordinator → Participant-B: "Commit"
  Coordinator → Participant-C: "Commit"

Recovery scenario:
  Coordinator crashes after etcd write but before sending Commit to Participant-C.
  New coordinator (elected via leader election) reads:
    /fintech/2pc/txn-123 → decision = COMMIT
  New coordinator sends Commit to Participant-C.
  Transaction completes correctly.

Without consensus-backed coordinator:
  Decision was only on local disk of crashed coordinator.
  New coordinator cannot recover the decision.
  Participants are blocked in PREPARED state indefinitely.
  Accounts remain locked. Operations team must intervene manually.
```

---

## ZooKeeper vs etcd for Fintech

| Dimension | ZooKeeper | etcd |
|---|---|---|
| Consensus algorithm | ZAB (ZooKeeper Atomic Broadcast) | Raft |
| Client protocol | Custom TCP | gRPC |
| Java client maturity | Apache Curator (very mature) | jetcd (good) |
| Spring integration | Spring Cloud Zookeeper | Custom / Spring Cloud Kubernetes |
| Kubernetes integration | None native | Built-in (etcd backs Kubernetes) |
| Watch semantics | Ephemeral nodes + watches | Key ranges + leases |
| Operational complexity | High (JVM, GC tuning) | Low (Go binary, simpler ops) |
| Typical fintech use | Legacy systems, Kafka pre-KRaft | Modern Kubernetes-based systems |

```
Migration guidance:
  - Kafka 3.3+: use KRaft mode — eliminates ZooKeeper for Kafka entirely
  - New coordination needs: use etcd (already in your K8s cluster)
  - Existing ZK-only coordination: migrate to etcd over 6-12 months
  - Never run ZooKeeper only for leader election on Kubernetes — etcd is free
```

---

## Operational Runbook: etcd for Fintech

### Health Monitoring

```bash
# Check etcd cluster health
etcdctl \
  --endpoints=http://etcd-1:2379,http://etcd-2:2379,http://etcd-3:2379 \
  endpoint health

# Expected output (each node reports < 10ms commit time):
# http://etcd-1:2379 is healthy: successfully committed proposal: took = 2.1ms
# http://etcd-2:2379 is healthy: successfully committed proposal: took = 2.3ms
# http://etcd-3:2379 is healthy: successfully committed proposal: took = 2.2ms

# Check cluster status and current leader
etcdctl \
  --endpoints=http://etcd-1:2379,http://etcd-2:2379,http://etcd-3:2379 \
  --write-out=table endpoint status

# List all active payment locks
etcdctl \
  --endpoints=http://etcd-1:2379 \
  get /fintech/locks --prefix --keys-only

# List current leaders
etcdctl \
  --endpoints=http://etcd-1:2379 \
  get /fintech/elections --prefix
```

### Key Metrics to Alert On

```yaml
# Prometheus alert rules for etcd in fintech
groups:
  - name: etcd.payment.coordination
    rules:
      - alert: EtcdConsensusLatencyHigh
        expr: histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.01
        for: 2m
        labels:
          severity: critical
          team: payments-platform
        annotations:
          summary: "etcd WAL fsync p99 > 10ms — consensus writes are slow"
          runbook: "https://wiki.fintech/runbooks/etcd-latency"

      - alert: EtcdLeaderAbsent
        expr: etcd_server_has_leader == 0
        for: 1m
        labels:
          severity: page
          team: payments-platform
        annotations:
          summary: "etcd cluster has no leader — distributed locks and leader election are BLOCKED"

      - alert: EtcdProposalsFailing
        expr: rate(etcd_server_proposals_failed_total[5m]) > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "etcd proposals failing — cluster may be losing quorum"
```

### Disaster Recovery

```bash
# Scenario: etcd cluster has lost quorum (2 of 3 nodes down)
# All writes are blocked — leader election and lock acquisition fail

# Step 1: Assess surviving nodes
etcdctl --endpoints=http://etcd-1:2379 endpoint status

# Step 2 (LAST RESORT): Force a new cluster from surviving member
# WARNING: This risks data loss if surviving node is not most up-to-date.
# NEVER do this without understanding the implications.
etcd --force-new-cluster --data-dir=/var/lib/etcd

# Step 3: Verify coordination state
etcdctl --endpoints=http://etcd-1:2379 get /fintech/elections --prefix
etcdctl --endpoints=http://etcd-1:2379 get /fintech/locks --prefix

# Step 4: Bring up new members
etcdctl --endpoints=http://etcd-1:2379 member add etcd-2 \
  --peer-urls=http://etcd-2:2380

# Step 5: Check for stuck payment locks (leases expire via TTL automatically)
# If TTL was set correctly (30s), locks from dead nodes will have already expired
```

---

## Key Takeaways for Principal Engineers

1. **Consensus is not free** — a Raft commit requires a round trip to a majority of nodes. In multi-AZ deployments this is 5-20ms per coordinated operation. Keep consensus off the synchronous payment critical path where possible.

2. **Use leases, not raw locks** — etcd leases automatically expire when the holder dies, preventing stuck locks. TTL is your safety net. Set it to 2-3x your maximum expected operation duration.

3. **Leader election is the right tool for singleton jobs** — settlement, fee calculation, and regulatory reports belong behind leader election, not database-level mutual exclusion or cron locks.

4. **etcd is not a database** — it has an 8GB size limit by default and is optimized for small key-value pairs with low write rate. Store only coordination state (locks, leader identity, routing config), not business data.

5. **ZooKeeper → etcd migration is worth it** — if you are running ZooKeeper only for coordination (not Kafka), migrating to etcd reduces operational complexity significantly on Kubernetes. etcd is already there.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Which property of consensus ensures that no two correct nodes decide different values?",
      "options": ["Validity", "Termination", "Agreement", "Safety"],
      "correct": 2,
      "explanation": "Agreement is the consensus property that guarantees no two correct nodes decide different values. Validity ensures the decided value was proposed by some node, and Termination ensures every correct node eventually decides."
    },
    {
      "text": "In Raft consensus, what happens when a follower does not receive a heartbeat within the election timeout?",
      "options": ["It stops accepting client requests", "It promotes itself to leader immediately", "It becomes a candidate and starts an election", "It contacts ZooKeeper to trigger failover"],
      "correct": 2,
      "explanation": "When a follower times out without receiving a heartbeat, it transitions to the candidate state and begins a new election by incrementing its term and requesting votes from other nodes."
    },
    {
      "text": "Why should etcd NOT be used as a primary data store for financial transaction records?",
      "options": ["It does not support TLS encryption", "It has an 8 GB size limit and is optimized for small coordination state, not high-write business data", "It lacks Raft consensus guarantees", "It cannot run on Kubernetes"],
      "correct": 1,
      "explanation": "etcd has an 8 GB default size limit and is optimized for small key-value pairs with low write rates. It is designed for coordination state like locks and leader identity, not for storing high-volume business transaction data."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Distributed Leader Election and Idempotency Lock with etcd",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement a leader election service using etcd's lease-based locking API (via the Jetcd client) that allows exactly one instance of a settlement-job service to hold the leader role at a time, with automatic re-election on leader failure."},
    {"id": "2", "description": "Build a distributed idempotency key registration system backed by etcd transactions: use a Compare-And-Swap (CaS) operation to atomically claim an idempotency key only if it does not already exist, returning the existing result for duplicate requests."},
    {"id": "3", "description": "Write a chaos test that partitions the etcd leader from the cluster (by blocking its port), verifies that a new leader is elected within two election timeouts, and confirms that the settlement job migrates to the new leader without double-processing any pending job."},
    {"id": "4", "description": "Instrument the leader election service with Micrometer metrics: track leader tenure duration, election frequency, and lock acquisition latency. Add an alert that fires when election frequency exceeds 1 per 5 minutes, indicating instability."}
  ]
}
-->

6. **Consensus protects correctness, not throughput** — if your use case tolerates eventual consistency, use a cache or message queue. Reserve consensus for cases where split-brain has direct financial consequences (double charges, missed settlement).
