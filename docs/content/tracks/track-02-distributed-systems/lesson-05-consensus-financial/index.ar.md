---
id: track-02-lesson-05
title: "الإجماع في الأنظمة المالية — تطبيقات عملية"
slug: consensus-financial
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 5
difficulty: principal
estimatedMinutes: 85
status: published
tags: [consensus, financial-systems, etcd, distributed-commit, coordinator]
prerequisites: []
---

# الإجماع في الأنظمة المالية — تطبيقات عملية

> [!NOTE]
> الإجماع ليس فضولًا نظريًا — بل هو الآلية التي تمنع معالج المدفوعات من الإضافة إلى الحساب نفسه مرتين، وتسمح لمجدول المهام بتشغيل تسوية نهاية اليوم مرة واحدة بالضبط عبر العنقود، وتضمن أن القفل الموزع تملكه نسخة خدمة واحدة فقط في كل لحظة. وكل نظام مالي كبير يستخدم الإجماع، غالبًا دون أن يدرك ذلك. والسؤال هو: هل يُستخدم عن قصد وبشكل صحيح؟

## ما الذي يحله الإجماع فعلًا في التقنية المالية

قبل الدخول في الخوارزميات والأدوات، لنحدد بدقة فئة المشكلات التي يحلها الإجماع في الأنظمة المالية.

**الإجماع** هو مشكلة جعل مجموعة من العقد تتفق على قيمة واحدة، حتى عندما قد تتعطل بعض العقد. وبصورة أدق، يجب أن تحقق خوارزمية الإجماع:

- **الاتفاق (Agreement)**: لا تقرر عقدتان سليمتان قيمتين مختلفتين
- **الصلاحية (Validity)**: القيمة المقررة اقترحتها عقدة ما
- **الانتهاء (Termination)**: كل عقدة سليمة تقرر قيمة في النهاية

عمليًا، يصادف مهندسو التقنية المالية الإجماع في ثلاثة أنماط:

| النمط | مثال مالي | ما يمنعه الإجماع |
|---|---|---|
| انتخاب القائد | منسّق مهمة التسوية | تشغيل عقدتين للتسوية معًا، فتُضاف المبالغ إلى الحسابات مرتين |
| القفل الموزع | تسجيل مفتاح منع التكرار | إنشاء طلبين لسجل الدفع نفسه |
| الالتزام الموزع | معاملة متعددة الأقسام | التزامات جزئية تترك الحسابات في حالة غير متسقة |

والفكرة الحاسمة أنك لا تنفّذ الإجماع بنفسك تقريبًا أبدًا. بل تستخدم نظامًا يوفره — etcd، أو ZooKeeper، أو قاعدة بيانات بعزل قابل للتسلسل — وتستخدمه بشكل صحيح.

---

## إجماع Raft: الحدس الذي تحتاجه

صُمم Raft ليكون أسهل فهمًا من Paxos مع ضمانات مكافئة. وبصفتك مهندسًا رئيسيًا، تحتاج إلى الحدس، لا إلى البرهان الكامل.

### الأدوار الثلاثة

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

التابع يستقبل مدخلات السجل من القائد ويصوّت في الانتخابات؛ والمرشح يطلب الأصوات؛ والقائد يستقبل كتابات العملاء وينسخ السجل إلى التابعين. ومن يكتشف فترة (term) أعلى يعود تابعًا.

### نسخ السجل: الآلية الأساسية

```
Payment write request arrives at leader:

  Client → Leader: "Transfer $1000 from acct-A to acct-B, idempotency=txn-789"

  Step 1: Leader appends to its log (uncommitted)
    Log[42]: {term:3, op: TRANSFER, from:acct-A, to:acct-B, amount:1000, key:txn-789}

  Step 2: Leader sends AppendEntries RPC to all followers
    Leader → Follower-1: AppendEntries(term=3, prevLogIndex=41, entries=[Log[42]])
    Leader → Follower-2: AppendEntries(term=3, prevLogIndex=41, entries=[Log[42]])
    Leader → Follower-3: AppendEntries(term=3, prevLogIndex=41, entries=[Log[42]])

  Step 3: Followers append to their logs, fsync to disk, respond success

  Step 4: Leader receives majority (2 of 3 followers) → commits entry
    Leader marks Log[42] committed, applies to state machine

  Step 5: Leader notifies followers of commit on next heartbeat

  Step 6: Leader responds success to client

If Follower-3 is partitioned:
  - Leader still commits after Follower-1 and Follower-2 respond
  - Follower-3 will catch up when partition heals
  - Client received a successful response — the write is durable
```

يضيف القائد العملية إلى سجله، ويرسلها إلى التابعين، وينتظر حتى تكتبها الأغلبية على القرص، ثم يلتزم بها ويطبقها ويرد على العميل. وإذا كان أحد التابعين معزولًا، يلتزم القائد مع ذلك بعد رد الأغلبية، ويلحق التابع المعزول عند التئام الشبكة.

### انتخاب القائد في Raft

```
Election scenario (3-node cluster):

  Normal operation:
    Leader sends heartbeats every 50ms (well below the election timeout)
    Followers reset election timer on heartbeat (timeout: 150-300ms randomized)

  Leader fails:
    - Follower-1 election timer expires first (randomized timeout)
    - Follower-1 → CANDIDATE, increments term to 4
    - Follower-1 → Follower-2: RequestVote(term=4, lastLogIndex=41, lastLogTerm=3)
    - Follower-1 → old leader:  RequestVote(...) — no reply, it is down

  Vote granting rules:
    - Only vote for candidate if candidate log is at least as up-to-date as own log
    - Only vote once per term

  Follower-2 grants vote (hasn't voted this term, candidate log is current)
  Follower-1 wins majority (itself + Follower-2)
  Follower-1 → LEADER, starts sending heartbeats

  Time to new leader: election timeout + RPC round trip ~ 150-350ms
```

قواعد منح الصوت: لا يصوّت التابع إلا لمرشح سجله محدّث بقدر سجله على الأقل، ولا يصوّت إلا مرة واحدة في كل فترة. ويجب أن تكون فترة النبض أقصر بكثير من مهلة الانتخاب.

### متطلب النصاب

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

القاعدة: النصاب = floor(N/2) + 1. فعنقود من 3 عقد يتحمل عطلًا واحدًا، ومن 5 عقد يتحمل عطلين. وفي الأنظمة المالية، 3 عقد هي الحد الأدنى لأي متطلب إتاحة عالية، و5 عقد هي المعيار للبنية التحتية الحرجة للمدفوعات، موزعة على 3 مناطق توفر أو أكثر.

---

## etcd للتنسيق المالي

‏etcd مخزن مفتاح-قيمة موزع مدمج في Kubernetes ويُستخدم على نطاق واسع للتنسيق الموزع. وهو ينفّذ Raft ويقدم العناصر الأساسية التي يحتاجها مهندسو التقنية المالية.

### إعداد etcd لتنسيق المدفوعات

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

### إعداد عميل etcd في Java

```groovy
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

## النمط 1: القفل الموزع لمنع التكرار

أكثر استخدامات الإجماع شيوعًا في أنظمة الدفع هو ضمان معالجة الدفعة مرة واحدة بالضبط. فالقفل الموزع يمنع المعالجة المتزامنة لمفتاح منع التكرار نفسه.

### المشكلة بدون أقفال

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

يصل الطلب وإعادة محاولته إلى نسختين مختلفتين في الوقت نفسه، فتفحص كلتاهما قاعدة البيانات ولا تجدان سجلًا، فتخصمان من الحساب مرتين.

### قفل موزع بإيجارات etcd

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

    // Lease TTL — the lease is kept alive while we work, so the TTL only
    // decides how quickly a DEAD holder's lock is released
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
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();   // restore the flag only when interrupted
            throw new LockAcquisitionException("Interrupted while locking key=" + lockKey, e);
        } catch (java.util.concurrent.ExecutionException e) {
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

يُمنح إيجار بمدة، ويُبقى حيًا أثناء العمل، ثم يُؤخذ القفل وتُنفّذ العملية ويُحرر القفل. ومدة الإيجار هنا تحدد فقط سرعة تحرير قفل مالك ميت. ولاحظ أن علامة المقاطعة تُستعاد فقط عند InterruptedException، لا عند أي استثناء.

### خدمة الدفع باستخدام القفل الموزع

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
    private final PaymentExecutor      paymentExecutor;

    /**
     * Process a payment with distributed idempotency guarantee.
     *
     * The distributed lock ensures that even if two pods receive
     * the same idempotency key concurrently, only one will execute
     * the actual payment logic. The second will block at the lock,
     * then find the existing record and return it.
     *
     * The lock is an optimisation, not the last line of defence: a lease can
     * expire during a long GC pause. The UNIQUE constraint on
     * payments.idempotency_key is what finally prevents a double debit.
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
                    .orElseGet(() -> paymentExecutor.execute(request));
            });

        } catch (LockAcquisitionException e) {
            // Another node is currently processing the same key.
            // Return 409 Conflict ("in progress") — do NOT process twice.
            log.warn("Concurrent processing for idempotencyKey={}", request.getIdempotencyKey());
            throw new PaymentConcurrentProcessingException(
                "Payment " + request.getIdempotencyKey() + " is currently being processed", e);
        }
    }

}

// A separate bean: @Transactional does not apply to private methods or to
// calls from inside the same class (Spring proxies are bypassed).
@Service
@RequiredArgsConstructor
class PaymentExecutor {

    private final PaymentRepository paymentRepository;
    private final AccountService    accountService;
    private final AuditService      auditService;

    @Transactional
    public PaymentResult execute(PaymentRequest request) {
        accountService.debit(
            request.getSourceAccountId(), request.getAmount(), request.getCurrency());
        accountService.credit(
            request.getDestinationAccountId(), request.getAmount(), request.getCurrency());

        Payment payment = paymentRepository.save(Payment.builder()
            .idempotencyKey(request.getIdempotencyKey())   // UNIQUE column
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

القفل تحسين، لا خط الدفاع الأخير: فقد ينتهي الإيجار أثناء توقف GC طويل. والقيد الفريد على عمود مفتاح منع التكرار هو ما يمنع الخصم المزدوج في النهاية. ولاحظ أن `@Transactional` لا يعمل على الطرق الخاصة (private) ولا على الاستدعاءات من داخل الصنف نفسه، لذلك نُقل التنفيذ إلى bean منفصل. وعند تعذر أخذ القفل تُعاد الحالة 409 ("قيد المعالجة").

---

## النمط 2: انتخاب القائد لجدولة المهام

يجب أن تعمل تسوية نهاية اليوم، وحساب الرسوم الشهرية، وإنشاء التقارير التنظيمية مرة واحدة بالضبط. وانتخاب القائد عبر etcd يضمن أن نسخة واحدة بالضبط في العنقود تشغّل هذه المهام.

### انتخاب القائد بإيجارات etcd

```java
package com.fintech.coordination;

import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.Client;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
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
                CountDownLatch leaseLost = new CountDownLatch(1);
                var keepAlive = leaseClient.keepAlive(finalLeaseId,
                    new io.grpc.stub.StreamObserver<>() {
                        @Override public void onNext(io.etcd.jetcd.lease.LeaseKeepAliveResponse r) {}
                        @Override public void onError(Throwable t) {
                            log.error("Keepalive failed for election={} — stepping down", electionName, t);
                            leaseLost.countDown();
                        }
                        @Override public void onCompleted() { leaseLost.countDown(); }
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
                        // Stay leader until the lease is lost or we are interrupted.
                        // (Thread.join() on yourself would wait forever and keep
                        // isLeader=true after the lease had already expired.)
                        leaseLost.await();

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

من يملك قفل etcd لمفتاح الانتخاب هو القائد. وعندما ينتهي إيجار المالك (موت العقدة) أو يُحرر القفل (إيقاف منظم)، يفوز مرشح آخر. ويبقى القائد قائدًا حتى يُفقد الإيجار — فاستدعاء `Thread.join()` على الخيط نفسه كان سينتظر إلى الأبد ويُبقي `isLeader=true` حتى بعد انتهاء الإيجار.

### مهمة التسوية موصولة بانتخاب القائد

```java
package com.fintech.settlement;

import com.fintech.coordination.EtcdLeaderElection;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.TaskScheduler;

import org.springframework.scheduling.support.CronTrigger;

import java.time.ZoneId;
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
        // A cron trigger, not "every 24h from now": a fixed delay starting now
        // would run settlement immediately on every leadership change.
        // runEndOfDaySettlement() also claims the date first (UNIQUE row),
        // so an old and a new leader can never both settle the same day.
        ScheduledFuture<?> future = taskScheduler.schedule(
            settlementJobService::runEndOfDaySettlement,
            new CronTrigger("0 0 23 * * *", ZoneId.of("Europe/London"))
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

يُستخدم مُشغِّل cron، لا "كل 24 ساعة من الآن": فالتأخير الثابت الذي يبدأ الآن كان سيشغّل التسوية فورًا عند كل تغيير في القيادة. كما تحجز مهمة التسوية التاريخ أولًا (صف فريد)، فلا يستطيع قائد قديم وقائد جديد تسوية اليوم نفسه.

---

## النمط 3: واجهة المراقبة (Watch) لإعدادات التوجيه

تتيح واجهة Watch في etcd للخدمات التفاعل فورًا مع تغييرات الإعداد — مثلًا عند إضافة معالج دفع أو إزالته أو تغيير وزن توجيهه.

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

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
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

    // On start-up (and after a reconnect), load the full prefix with a GET and
    // watch from that GET's revision + 1, so no change is missed in between.
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

عند البدء (وبعد إعادة الاتصال)، حمّل البادئة كاملة بعملية GET، ثم راقب من مراجعة ذلك الـ GET + 1، حتى لا يضيع أي تغيير بينهما.

---

## كلفة الإجماع مقابل ضمانات الاتساق

### قياس زمن etcd

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

القيم المتوقعة: 1-5ms داخل منطقة توفر واحدة، و5-20ms بين مناطق التوفر، و50-200ms بين المناطق الجغرافية — وهذا بطيء جدًا للمسار الحرج للمدفوعات.

### مصفوفة القرار: متى تستخدم الإجماع

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

استخدم الإجماع لانتخاب القائد للمهام الدفعية، وللأقفال الموزعة لتسجيل مفاتيح منع التكرار، وللإعدادات التي يجب أن تتسق فورًا. ولا تستخدمه لقرارات التوجيه لكل دفعة، أو قراءات درجات الاحتيال، أو عدّادات تحديد المعدّل، أو حالة الجلسة. والقاعدة: استخدم الإجماع عندما تتجاوز كلفة التنسيق الخاطئ كلفة زمن الإجماع.

---

## الإجماع في استرداد الالتزام على مرحلتين

يحتاج منسّق المعاملات الموزعة نفسه إلى الإجماع ليتعافى بشكل صحيح من الأعطال.

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

يحفظ المنسّق قراره (COMMIT) في etcd أولًا، وهي كتابة إجماع دائمة. فإذا تعطل المنسّق قبل إرسال الالتزام إلى أحد المشاركين، يقرأ المنسّق الجديد القرار ويكمل المعاملة. أما بدون منسّق مدعوم بالإجماع، فيبقى القرار على قرص المنسّق المعطل، ويظل المشاركون عالقين في حالة PREPARED، وتبقى الحسابات مقفلة حتى يتدخل فريق العمليات يدويًا.

---

## ZooKeeper مقابل etcd في التقنية المالية

| البُعد | ZooKeeper | etcd |
|---|---|---|
| خوارزمية الإجماع | ZAB ‏(ZooKeeper Atomic Broadcast) | Raft |
| بروتوكول العميل | TCP مخصص | gRPC |
| نضج عميل Java | Apache Curator (ناضج جدًا) | jetcd (جيد) |
| التكامل مع Spring | Spring Cloud Zookeeper | مخصص / Spring Cloud Kubernetes |
| التكامل مع Kubernetes | لا يوجد تكامل أصلي | مدمج (etcd يدعم Kubernetes) |
| دلالات المراقبة | عقد مؤقتة + مراقبات | نطاقات مفاتيح + إيجارات |
| التعقيد التشغيلي | عالٍ (JVM، وضبط GC) | منخفض (ملف Go تنفيذي، تشغيل أبسط) |
| الاستخدام المالي النموذجي | الأنظمة القديمة، وKafka قبل KRaft | الأنظمة الحديثة المبنية على Kubernetes |

```
Migration guidance:
  - Kafka: use KRaft mode (production-ready since 3.3; Kafka 4.0 removed ZooKeeper)
  - Leader election on Kubernetes: the Kubernetes Lease API (coordination.k8s.io,
    e.g. Spring Cloud Kubernetes leader election) is often enough
  - Locks and coordination data: a DEDICATED etcd cluster — never your
    application's keys in the Kubernetes control-plane etcd
  - Existing ZK-only coordination: migrate gradually (6-12 months)
```

- **Kafka**: استخدم وضع KRaft (جاهز للإنتاج منذ 3.3، وأزال Kafka 4.0 الاعتماد على ZooKeeper).
- **انتخاب القائد على Kubernetes**: واجهة Lease في Kubernetes كافية غالبًا.
- **الأقفال وبيانات التنسيق**: عنقود etcd **مخصص** — لا تضع أبدًا مفاتيح تطبيقك في etcd الخاص بطبقة التحكم في Kubernetes.

---

## دليل التشغيل: etcd في التقنية المالية

### مراقبة الصحة

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

### المقاييس الأساسية للتنبيه

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

نبّه على: ارتفاع زمن fsync لسجل الكتابة المسبقة (p99 أعلى من 10ms)، وغياب القائد (فتتوقف الأقفال الموزعة وانتخاب القائد)، وفشل المقترحات (قد يكون العنقود يفقد النصاب).

### التعافي من الكوارث

```bash
# Scenario: etcd cluster has lost quorum (2 of 3 nodes down)
# All writes are blocked — leader election and lock acquisition fail

# Step 1: Assess surviving nodes
etcdctl --endpoints=http://etcd-1:2379 endpoint status

# Step 2: Preferred — restore from the latest snapshot on new members
#   etcdutl snapshot restore backup.db --data-dir=/var/lib/etcd-restored ...
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

إذا فقد العنقود النصاب، تتوقف كل الكتابات. والطريقة المفضلة هي الاستعادة من أحدث لقطة على أعضاء جدد. أما `--force-new-cluster` من العضو الناجي فهو الملاذ الأخير، لأنه يخاطر بفقدان بيانات إذا لم يكن العضو الناجي هو الأحدث.

---

## خلاصات للمهندسين الرئيسيين

1. **الإجماع ليس مجانيًا** — التزام Raft يتطلب رحلة ذهاب وإياب إلى أغلبية العقد. وفي النشر عبر عدة مناطق توفر يكلف هذا 5-20ms لكل عملية منسقة. أبقِ الإجماع خارج المسار الحرج المتزامن للدفع قدر الإمكان.

2. **استخدم الإيجارات، لا الأقفال الخام** — تنتهي إيجارات etcd تلقائيًا عندما يموت المالك، فتمنع الأقفال العالقة. أبقِ الإيجار حيًا أثناء العمل؛ فتحدد المدة حينها فقط سرعة تحرير قفل مالك ميت. وادعم كل قفل برمز تسييج أو قيد في قاعدة البيانات، لأن توقفًا طويلًا قد يتجاوز أي إيجار.

3. **انتخاب القائد هو الأداة الصحيحة للمهام الفردية** — التسوية، وحساب الرسوم، والتقارير التنظيمية مكانها خلف انتخاب القائد، لا الاستبعاد المتبادل على مستوى قاعدة البيانات أو أقفال cron.

4. **etcd ليس قاعدة بيانات** — حصة تخزينه 2GB افتراضيًا (و8GB هو الحد الأقصى المقترح)، وهو محسّن لأزواج مفتاح-قيمة صغيرة بمعدل كتابة منخفض. خزّن فيه حالة التنسيق فقط (الأقفال، وهوية القائد، وإعدادات التوجيه)، لا بيانات العمل.

5. **الانتقال من ZooKeeper يستحق العناء** — إذا كنت تشغّل ZooKeeper للتنسيق فقط (لا لـ Kafka)، فخدمة تنسيق أبسط تقلل التعقيد التشغيلي. وعلى Kubernetes، تكفي واجهة Lease المدمجة غالبًا لانتخاب القائد.

6. **الإجماع يحمي الصحة، لا الإنتاجية** — إذا كانت حالة استخدامك تتحمل الاتساق النهائي، فاستخدم ذاكرة مؤقتة أو طابور رسائل. واحتفظ بالإجماع للحالات التي يكون للدماغ المنقسم فيها عواقب مالية مباشرة (خصم مزدوج، أو تسوية فائتة).

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "أي خاصية من خصائص الإجماع تضمن ألا تقرر عقدتان سليمتان قيمتين مختلفتين؟",
      "options": ["الصلاحية (Validity)", "الانتهاء (Termination)", "الاتفاق (Agreement)", "السلامة (Safety)"],
      "correct": 2,
      "explanation": "الاتفاق هو خاصية الإجماع التي تضمن ألا تقرر عقدتان سليمتان قيمتين مختلفتين. أما الصلاحية فتضمن أن القيمة المقررة اقترحتها عقدة ما، والانتهاء يضمن أن كل عقدة سليمة تقرر في النهاية."
    },
    {
      "text": "في إجماع Raft، ماذا يحدث عندما لا يتلقى التابع نبضة خلال مهلة الانتخاب؟",
      "options": ["يتوقف عن قبول طلبات العملاء", "يرقّي نفسه إلى قائد فورًا", "يصبح مرشحًا ويبدأ انتخابًا", "يتصل بـ ZooKeeper لبدء التحويل"],
      "correct": 2,
      "explanation": "عندما تنتهي مهلة التابع دون تلقي نبضة، ينتقل إلى حالة المرشح ويبدأ انتخابًا جديدًا بزيادة رقم فترته وطلب الأصوات من العقد الأخرى."
    },
    {
      "text": "لماذا يجب ألا يُستخدم etcd مخزنًا أساسيًا لسجلات المعاملات المالية؟",
      "options": ["لا يدعم تشفير TLS", "حصة تخزينه صغيرة (2 GB افتراضيًا، و8 GB حد أقصى مقترح) وهو محسّن لحالة تنسيق صغيرة، لا لبيانات عمل كثيفة الكتابة", "يفتقر إلى ضمانات إجماع Raft", "لا يعمل على Kubernetes"],
      "correct": 1,
      "explanation": "حصة تخزين etcd هي 2 GB افتراضيًا (و8 GB هو الحد الأقصى المقترح)، وهو محسّن لأزواج مفتاح-قيمة صغيرة بمعدل كتابة منخفض. فهو مصمم لحالة التنسيق مثل الأقفال وهوية القائد، لا لتخزين بيانات معاملات عمل بحجم كبير."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "انتخاب القائد الموزع وقفل منع التكرار باستخدام etcd",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ خدمة انتخاب قائد باستخدام واجهة القفل المبنية على الإيجارات في etcd (عبر عميل Jetcd) تسمح لنسخة واحدة فقط من خدمة مهمة التسوية بحمل دور القائد في كل لحظة، مع إعادة انتخاب تلقائية عند تعطل القائد."},
    {"id": "2", "description": "ابنِ نظام تسجيل مفاتيح منع تكرار موزعًا مدعومًا بمعاملات etcd: استخدم عملية مقارنة-وتبديل (CaS) لحجز مفتاح منع التكرار ذريًا فقط إذا لم يكن موجودًا، وأعد النتيجة الموجودة للطلبات المكررة."},
    {"id": "3", "description": "اكتب اختبار فوضى يعزل قائد etcd عن العنقود (بحجب منفذه)، ويتحقق من انتخاب قائد جديد خلال مهلتي انتخاب، ويؤكد أن مهمة التسوية تنتقل إلى القائد الجديد دون معالجة أي مهمة معلّقة مرتين."},
    {"id": "4", "description": "أضف إلى خدمة انتخاب القائد مقاييس Micrometer: تتبّع مدة بقاء القائد، وتكرار الانتخابات، وزمن أخذ القفل. وأضف تنبيهًا ينطلق عندما يتجاوز تكرار الانتخابات انتخابًا واحدًا كل 5 دقائق، دلالةً على عدم الاستقرار."}
  ]
}
-->
