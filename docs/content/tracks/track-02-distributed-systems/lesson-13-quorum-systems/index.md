---
id: track-02-lesson-13
title: "Quorum-Based Systems and Read/Write Quorums"
slug: quorum-systems
track: track-02
trackName: Distributed Systems Engineering
sequence: 13
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [quorum, read-quorum, write-quorum, ROWA, replication]
prerequisites: []
---

# Quorum-Based Systems and Read/Write Quorums

> [!NOTE]
> Quorum is the mathematical guarantee that sits between "any node can answer" and "all nodes must agree." For financial systems, choosing the right quorum configuration is a direct trade-off between consistency guarantees and availability during partial failures. Getting it wrong means either stale balances or unnecessary downtime.

## The Quorum Formula

A quorum system with N replicas satisfies **strong consistency** when:

```
R + W > N
```

Where:
- **N** = total number of replicas
- **R** = number of replicas that must respond to a read (read quorum)
- **W** = number of replicas that must acknowledge a write (write quorum)

The intuition: if `R + W > N`, then any read quorum and any write quorum must share at least one node. That shared node has seen the latest write. Therefore, a read that contacts R replicas will always find at least one replica with the most recent data.

```
Example: N=3, W=2, R=2 (the classic "majority quorum")

Write: must reach 2 of 3 replicas
Read:  must reach 2 of 3 replicas
Overlap: at least 1 replica is in both sets
         → reads always see the latest write ✓

R + W = 4 > 3 = N ✓

Example: N=3, W=1, R=1 (AP — no consistency guarantee)

Write: reaches only 1 replica
Read:  reads only 1 replica
Overlap: might be 0 replicas in common
         → reads may return stale data ✗

R + W = 2 ≤ 3 = N ✗ (not a quorum system)
```

---

## Read-Your-Writes with Quorums

**Read-your-writes** consistency is a session-level guarantee that a client always sees its own most recent writes. This is essential in banking: if a customer transfers funds, their next balance inquiry must reflect the transfer.

With quorums, read-your-writes is guaranteed when `R + W > N`. With weaker settings (e.g., `W=1, R=1`), the read might hit a replica that hasn't yet received the write.

```java
@Service
public class AccountBalanceService {

    private final CassandraSession session;

    private final PreparedStatement debitStmt = session.prepare(
        "UPDATE accounts.balances " +
        "SET balance_cents = balance_cents - ?, " +
        "    version = version + 1, " +
        "    last_modified = ? " +
        "WHERE account_id = ? " +
        "IF balance_cents >= ?"  // Lightweight transaction — optimistic check
    );

    private final PreparedStatement readStmt = session.prepare(
        "SELECT account_id, balance_cents, version, last_modified " +
        "FROM accounts.balances " +
        "WHERE account_id = ?"
    );

    /**
     * Debit an account with QUORUM write consistency.
     * This guarantees the write is durable on a majority of replicas
     * before we return success to the caller.
     */
    public DebitResult debit(UUID accountId, long amountCents, String idempotencyKey) {
        BoundStatement stmt = debitStmt.bind(
            amountCents, Instant.now(), accountId, amountCents
        ).setConsistencyLevel(ConsistencyLevel.QUORUM);

        ResultSet rs = session.execute(stmt);
        Row result = rs.one();

        if (!result.getBool("[applied]")) {
            return DebitResult.insufficientFunds(
                result.getLong("balance_cents"), amountCents);
        }

        return DebitResult.success(result.getLong("balance_cents"));
    }

    /**
     * Read balance with QUORUM consistency.
     * Combined with QUORUM writes (R + W = 4 > N = 3),
     * this guarantees read-your-writes.
     */
    public AccountBalance readBalance(UUID accountId) {
        BoundStatement stmt = readStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.QUORUM);

        Row row = session.execute(stmt).one();
        if (row == null) {
            throw new AccountNotFoundException(accountId.toString());
        }

        return AccountBalance.builder()
            .accountId(accountId)
            .balanceCents(row.getLong("balance_cents"))
            .version(row.getLong("version"))
            .lastModified(row.getInstant("last_modified"))
            .build();
    }

    /**
     * For read-intensive inquiry paths where slight staleness is acceptable
     * (e.g., dashboard balance display — not for payment authorization).
     * Uses LOCAL_ONE for lower latency at the cost of potential staleness.
     */
    public AccountBalance readBalanceEventuallyConsistent(UUID accountId) {
        BoundStatement stmt = readStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.LOCAL_ONE);

        Row row = session.execute(stmt).one();
        return mapRow(row);
    }
}
```

---

## Cassandra Consistency Levels Deep Dive

Cassandra's consistency levels are a direct expression of the R and W in the quorum formula. With a replication factor of 3 (N=3):

| Consistency Level | Replicas Required | R+W > N? | Use Case |
|---|---|---|---|
| ONE | 1 | No (1+1=2 ≤ 3) | Logging, analytics, non-critical reads |
| TWO | 2 | Borderline | Avoid — use QUORUM instead |
| QUORUM | 2 (⌈3/2⌉+1 = 2) | Yes (2+2=4 > 3) | Most financial operations |
| ALL | 3 | Yes | Highest consistency, lowest availability |
| LOCAL_QUORUM | 2 in local DC | Yes (within DC) | Multi-DC: consistency within DC |
| EACH_QUORUM | 2 per DC | Yes (per DC) | Synchronous multi-DC writes |
| SERIAL | Paxos consensus | Full linearizability | CAS operations, idempotency checks |

```java
@Configuration
public class CassandraConsistencyConfiguration {

    /**
     * Different operations in a payment system require different
     * consistency levels. Configure these explicitly rather than
     * using a single global default.
     */

    // Payment authorization — maximum consistency
    public static final ConsistencyLevel PAYMENT_WRITE_CL  = ConsistencyLevel.LOCAL_QUORUM;
    public static final ConsistencyLevel PAYMENT_READ_CL   = ConsistencyLevel.LOCAL_QUORUM;

    // Idempotency key claims — requires linearizability
    public static final ConsistencyLevel IDEMPOTENCY_CL    = ConsistencyLevel.SERIAL;

    // Balance display on dashboard — eventual consistency acceptable
    public static final ConsistencyLevel BALANCE_DISPLAY_CL = ConsistencyLevel.LOCAL_ONE;

    // Transaction history query — slight staleness acceptable
    public static final ConsistencyLevel HISTORY_READ_CL   = ConsistencyLevel.LOCAL_ONE;

    // Audit log writes — must be durable on all replicas
    public static final ConsistencyLevel AUDIT_WRITE_CL    = ConsistencyLevel.ALL;
}
```

### LOCAL_QUORUM vs QUORUM

For multi-datacenter deployments, `QUORUM` counts replicas across ALL datacenters while `LOCAL_QUORUM` only counts replicas in the local DC. For a payment system with 3 replicas per DC across 2 DCs (N=6 globally, N=3 per DC):

```
QUORUM:        requires ⌈6/2⌉+1 = 4 replicas (must cross DC boundary — adds ~20ms latency)
LOCAL_QUORUM:  requires ⌈3/2⌉+1 = 2 replicas in local DC (stays within DC — ~1ms latency)
```

For payment processing, `LOCAL_QUORUM` is almost always the right choice: strong consistency within the datacenter, with async replication to the DR datacenter.

---

## Sloppy Quorums and Hinted Handoff

A **sloppy quorum** is a relaxation used by systems like Cassandra (and originally DynamoDB) to maintain write availability even when the designated replicas for a data partition are unavailable.

In a sloppy quorum, if one of the designated N replicas is down, another node in the cluster temporarily accepts the write on its behalf. This accepting node stores a **hint** — a note that it needs to forward this write to the original replica when it recovers.

```
Normal quorum write (N=3, W=2):
  Data for token range [0, 1000] → Nodes A, B, C
  Write: A ✓, B ✓, C (unreachable)
  Result: Write succeeds (2/3 = quorum)

Sloppy quorum (W=3, A and B down):
  Data for token range [0, 1000] → Nodes A, B, C
  A and B unreachable → Node D accepts write with hint for A and B
  Write: C ✓, D ✓ (hint for A), E ✓ (hint for B)
  Result: Write succeeds! But D and E are "wrong" replicas.

  When A and B recover:
    D forwards hint to A
    E forwards hint to B
  → Hinted handoff restores consistency
```

```java
@Service
public class HintedHandoffMonitor {

    private final Session cassandraSession;

    /**
     * Monitor hinted handoff status. If hints accumulate
     * faster than they are delivered, it indicates persistent
     * replica unavailability — a risk for financial data.
     */
    public HintedHandoffStatus checkHintedHandoff() {
        // Query system.hints (Cassandra 2.x) or
        // system_distributed.hints (Cassandra 3+)
        ResultSet rs = cassandraSession.execute(
            "SELECT target_id, hints_in_progress, hint_count " +
            "FROM system_distributed.view_build_status"
        );

        // For actual hint monitoring, use JMX:
        StorageProxyMBean proxy = getStorageProxy();
        long totalHints = proxy.getTotalHints();
        long hintsInProgress = proxy.getTotalHintsInProgress();

        if (totalHints > 10000) {
            log.warn("High hint count: {} — indicates replica unavailability. " +
                "Payment data may be pending delivery to replicas.", totalHints);
        }

        return HintedHandoffStatus.builder()
            .totalHints(totalHints)
            .hintsInProgress(hintsInProgress)
            .build();
    }
}
```

### When Sloppy Quorums Are Dangerous for Financial Data

Sloppy quorums prioritize availability over strict consistency. For payment systems, this creates a subtle risk: a read with `R=2` after a sloppy quorum write may not contact the hint-holding nodes, returning stale data.

```java
@Service
public class FinancialDataConsistencyPolicy {

    /**
     * For payment authorization, disable sloppy quorum behavior by
     * requiring reads to contact ONLY the designated replicas.
     * In Cassandra, this is controlled by using LOCAL_SERIAL for
     * read-before-write patterns.
     */
    public boolean isPaymentAmountValid(UUID paymentId, long expectedAmount) {
        // Use SERIAL consistency to bypass the coordinator's cache
        // and ensure we read from the Paxos quorum (not a hinted replica)
        BoundStatement stmt = readPaymentStmt.bind(paymentId)
            .setConsistencyLevel(ConsistencyLevel.LOCAL_SERIAL);

        Row row = session.execute(stmt).one();
        return row != null && row.getLong("amount_cents") == expectedAmount;
    }
}
```

---

## DynamoDB Quorums

Amazon DynamoDB originally used a quorum-based replication scheme (described in the 2007 Dynamo paper). DynamoDB now abstracts this from users, but the underlying principle is the same: strong consistency reads in DynamoDB contact a quorum of replicas.

```java
@Service
public class DynamoDbPaymentRepository {

    private final DynamoDbClient dynamoClient;
    private static final String TABLE = "PaymentTransactions";

    /**
     * DynamoDB strongly consistent read contacts a quorum of replicas.
     * For payment systems, always use strongly consistent reads for
     * authorization checks.
     */
    public Optional<PaymentItem> findPayment(String paymentId) {
        GetItemRequest request = GetItemRequest.builder()
            .tableName(TABLE)
            .key(Map.of("paymentId", AttributeValue.fromS(paymentId)))
            .consistentRead(true)   // Strongly consistent = quorum read
            .build();

        try {
            GetItemResponse response = dynamoClient.getItem(request);
            if (response.item().isEmpty()) {
                return Optional.empty();
            }
            return Optional.of(mapToPayment(response.item()));
        } catch (ProvisionedThroughputExceededException e) {
            throw new RateLimitException("DynamoDB throughput exceeded for payments table", e);
        }
    }

    /**
     * Eventually consistent read (default) is cheaper (half the cost)
     * and lower latency. Use only for non-critical reads like
     * transaction history display.
     */
    public List<PaymentItem> findPaymentHistoryEventual(String accountId,
                                                         Instant from,
                                                         Instant to) {
        QueryRequest request = QueryRequest.builder()
            .tableName(TABLE)
            .indexName("accountId-createdAt-index")
            .keyConditionExpression(
                "accountId = :aid AND createdAt BETWEEN :from AND :to")
            .expressionAttributeValues(Map.of(
                ":aid",  AttributeValue.fromS(accountId),
                ":from", AttributeValue.fromS(from.toString()),
                ":to",   AttributeValue.fromS(to.toString())
            ))
            .consistentRead(false)  // Eventually consistent — OK for history display
            .build();

        return dynamoClient.queryPaginator(request)
            .items().stream()
            .map(this::mapToPayment)
            .collect(Collectors.toList());
    }

    /**
     * Conditional write (optimistic concurrency control using version attribute).
     * Ensures we don't overwrite a newer version — equivalent to CAS in Cassandra LWT.
     */
    public UpdateResult updatePaymentStatus(String paymentId,
                                             String newStatus,
                                             long expectedVersion) {
        UpdateItemRequest request = UpdateItemRequest.builder()
            .tableName(TABLE)
            .key(Map.of("paymentId", AttributeValue.fromS(paymentId)))
            .updateExpression(
                "SET #s = :newStatus, #v = :newVersion, updatedAt = :now")
            .conditionExpression("#v = :expectedVersion")
            .expressionAttributeNames(Map.of(
                "#s", "status",
                "#v", "version"
            ))
            .expressionAttributeValues(Map.of(
                ":newStatus",       AttributeValue.fromS(newStatus),
                ":newVersion",      AttributeValue.fromN(String.valueOf(expectedVersion + 1)),
                ":expectedVersion", AttributeValue.fromN(String.valueOf(expectedVersion)),
                ":now",             AttributeValue.fromS(Instant.now().toString())
            ))
            .build();

        try {
            dynamoClient.updateItem(request);
            return UpdateResult.success();
        } catch (ConditionalCheckFailedException e) {
            return UpdateResult.versionConflict(expectedVersion);
        }
    }
}
```

---

## ROWA: Read One Write All

**ROWA** (Read One, Write All) is the extreme strong consistency strategy: every write must be acknowledged by ALL replicas, but reads can go to any single replica.

```
ROWA: R=1, W=N
R + W = 1 + N > N ✓ (strong consistency)
```

ROWA is rarely used in practice because a single unavailable replica blocks ALL writes — terrible availability. However, a variant is used for small, critical datasets where you can afford to block on writes:

```java
@Service
public class RiskParameterStore {

    /**
     * Risk parameters (velocity limits, country blacklists, BIN block lists)
     * are written rarely but read on every transaction.
     * ROWA is appropriate here: writes are infrequent, reads must be fast
     * and always see the latest risk rules.
     */
    private final List<RiskParameterReplica> allReplicas;

    public void updateRiskParameter(RiskParameter param) {
        // Write to ALL replicas before confirming
        List<CompletableFuture<Void>> writes = allReplicas.stream()
            .map(r -> CompletableFuture.runAsync(() -> r.write(param)))
            .collect(Collectors.toList());

        // Wait for ALL — this is the ROWA invariant
        CompletableFuture.allOf(writes.toArray(new CompletableFuture[0]))
            .orTimeout(5, TimeUnit.SECONDS)
            .join();  // Throws if any replica fails

        log.info("Risk parameter {} written to all {} replicas",
            param.key(), allReplicas.size());
    }

    /**
     * Read from local replica only — always consistent because we wrote to all.
     */
    public RiskParameter readRiskParameter(String key) {
        return localReplica.read(key);
    }
}
```

---

## Strong Consistency via Quorum

The combination of quorum reads and quorum writes provides the strongest consistency guarantee achievable without global locking. For financial systems, this is the minimum acceptable for any operation that affects account state.

### Quorum in a 5-Node Payment Cluster

```java
@Service
public class FiveNodeQuorumPaymentLedger {

    // N=5, W=3, R=3 → R+W=6>5 ✓
    // This tolerates 2 node failures on both reads and writes
    private static final int N = 5;
    private static final int W = 3;
    private static final int R = 3;

    private final List<LedgerReplica> replicas;

    @Transactional
    public WriteReceipt writeLedgerEntry(LedgerEntry entry) {
        List<CompletableFuture<ReplicaAck>> writes = replicas.stream()
            .map(r -> CompletableFuture
                .supplyAsync(() -> r.write(entry))
                .orTimeout(500, TimeUnit.MILLISECONDS)
                .exceptionally(ex -> ReplicaAck.failed(r.nodeId(), ex.getMessage())))
            .collect(Collectors.toList());

        int acks = 0;
        List<String> succeeded = new ArrayList<>();
        List<String> failed = new ArrayList<>();

        for (CompletableFuture<ReplicaAck> f : writes) {
            ReplicaAck ack = f.join();
            if (ack.isSuccessful()) {
                succeeded.add(ack.nodeId());
                acks++;
            } else {
                failed.add(ack.nodeId());
                log.warn("Replica {} failed to acknowledge ledger write: {}",
                    ack.nodeId(), ack.error());
            }
        }

        if (acks < W) {
            // Roll back any partial writes
            rollbackPartialWrites(entry.id(), succeeded);
            throw new QuorumWriteFailedException(
                String.format("Ledger write quorum not met: %d/%d acks (need %d). Failed: %s",
                    acks, N, W, failed));
        }

        return WriteReceipt.builder()
            .entryId(entry.id())
            .ackedBy(succeeded)
            .ackedCount(acks)
            .requiredAcks(W)
            .build();
    }

    public LedgerEntry readLedgerEntry(String entryId) {
        List<CompletableFuture<ReplicaReadResult>> reads = replicas.stream()
            .map(r -> CompletableFuture
                .supplyAsync(() -> r.read(entryId))
                .orTimeout(300, TimeUnit.MILLISECONDS)
                .exceptionally(ex -> ReplicaReadResult.failed(r.nodeId())))
            .collect(Collectors.toList());

        List<LedgerEntry> results = new ArrayList<>();
        int successCount = 0;

        for (CompletableFuture<ReplicaReadResult> f : reads) {
            ReplicaReadResult result = f.join();
            if (result.isSuccessful()) {
                results.add(result.entry());
                successCount++;
            }
        }

        if (successCount < R) {
            throw new QuorumReadFailedException(
                String.format("Read quorum not met: %d/%d responses (need %d)",
                    successCount, N, R));
        }

        // Return the most recently written version (highest version wins)
        return results.stream()
            .max(Comparator.comparingLong(LedgerEntry::version))
            .orElseThrow();
    }

    private void rollbackPartialWrites(String entryId, List<String> succeeded) {
        succeeded.forEach(nodeId -> {
            try {
                LedgerReplica replica = findReplica(nodeId);
                replica.rollback(entryId);
            } catch (Exception e) {
                log.error("Failed to rollback partial write on {}: {}", nodeId, e.getMessage());
            }
        });
    }
}
```

---

## Trade-offs for Financial Data

Different parts of a payment system have different consistency requirements. Using the same quorum configuration everywhere leads to either over-engineering (high latency for non-critical reads) or under-engineering (stale data for critical operations).

```java
@Configuration
public class FinancialDataConsistencyMatrix {

    /**
     * Consistency requirement matrix for a payment processing system.
     * Design principle: each data type gets the MINIMUM consistency
     * level that meets its business requirements.
     */

    // Account balances during payment authorization — MUST be strongly consistent
    // Wrong: payment could overdraw account
    public ConsistencyLevel accountBalanceAuthorizationRead() {
        return ConsistencyLevel.QUORUM;  // R+W>N
    }

    // Account balances for display — eventual consistency acceptable
    // Wrong: stale balance shown on dashboard (annoying but not harmful)
    public ConsistencyLevel accountBalanceDashboardRead() {
        return ConsistencyLevel.ONE;  // Lower latency, slight staleness OK
    }

    // Payment idempotency key claims — MUST be linearizable
    // Wrong: same payment processed twice → double charge
    public ConsistencyLevel idempotencyKeyWrite() {
        return ConsistencyLevel.SERIAL;  // Paxos-based CAS
    }

    // Fraud rules — strongly consistent writes, single-replica reads OK
    // Wrong write: stale fraud rules allow fraudulent transaction
    // Wrong read: local replica always has latest (ROWA write pattern)
    public ConsistencyLevel fraudRuleWrite() {
        return ConsistencyLevel.ALL;  // Write to all replicas (ROWA)
    }

    public ConsistencyLevel fraudRuleRead() {
        return ConsistencyLevel.ONE;  // Can read from any replica (ROWA guarantee)
    }

    // Transaction history — eventual consistency acceptable
    // Wrong: stale history display (corrects within seconds)
    public ConsistencyLevel transactionHistoryRead() {
        return ConsistencyLevel.ONE;
    }

    // Audit log — must be durable on majority; never read with inconsistency
    public ConsistencyLevel auditLogWrite() {
        return ConsistencyLevel.QUORUM;
    }
}
```

---

## SQL Equivalent: Synchronous Replication as Quorum

In PostgreSQL with synchronous replication, you can configure quorum commit — requiring acknowledgment from K of N standbys before the write is confirmed:

```sql
-- postgresql.conf
-- Require acknowledgment from ANY 2 of 3 standbys (quorum commit)
synchronous_standby_names = 'ANY 2 (standby1, standby2, standby3)'

-- This means: W = 1 (primary) + 2 (standbys) = 3
-- With a quorum read (connecting to the primary after write):
-- R = 1 (primary always has latest), W = 3
-- R + W = 4 > N (1 primary + 3 standbys = 4), so R + W > N ✓
```

```java
@Service
public class PostgresQuorumPaymentWriter {

    private final DataSource primaryDataSource;
    private final List<DataSource> standbyDataSources;

    /**
     * Writes to PostgreSQL primary with synchronous replication.
     * The 'synchronous_commit = on' setting ensures the write is
     * durable on the required number of standbys before returning.
     */
    @Transactional
    public PaymentRecord writePayment(PaymentRequest request) {
        try (Connection conn = primaryDataSource.getConnection()) {
            // Set synchronous_commit for this transaction (can override per-txn)
            try (PreparedStatement syncStmt = conn.prepareStatement(
                    "SET synchronous_commit = 'on'")) {
                syncStmt.execute();
            }

            try (PreparedStatement ps = conn.prepareStatement(
                    "INSERT INTO payments " +
                    "(payment_id, amount_cents, currency, status, created_at) " +
                    "VALUES (?, ?, ?, 'PENDING', NOW()) " +
                    "RETURNING payment_id, created_at")) {
                ps.setObject(1, request.paymentId());
                ps.setLong(2, request.amountCents());
                ps.setString(3, request.currency());

                ResultSet rs = ps.executeQuery();
                rs.next();

                return PaymentRecord.builder()
                    .paymentId((UUID) rs.getObject("payment_id"))
                    .createdAt(rs.getTimestamp("created_at").toInstant())
                    .build();
            }
        } catch (SQLException e) {
            throw new PaymentWriteException("Failed to write payment", e);
        }
    }

    /**
     * Monitor replication lag to understand quorum health.
     * If lag exceeds threshold, the system is at risk of losing
     * quorum acknowledgments, potentially blocking writes.
     */
    public ReplicationLagReport checkReplicationLag() {
        String sql = """
            SELECT
                application_name,
                client_addr,
                state,
                EXTRACT(EPOCH FROM write_lag)  AS write_lag_s,
                EXTRACT(EPOCH FROM flush_lag)  AS flush_lag_s,
                EXTRACT(EPOCH FROM replay_lag) AS replay_lag_s,
                sync_state
            FROM pg_stat_replication
            ORDER BY replay_lag DESC NULLS LAST
            """;

        List<ReplicaLag> lags = new ArrayList<>();
        try (Connection conn = primaryDataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql);
             ResultSet rs = ps.executeQuery()) {

            while (rs.next()) {
                lags.add(ReplicaLag.builder()
                    .applicationName(rs.getString("application_name"))
                    .writeLagSeconds(rs.getDouble("write_lag_s"))
                    .flushLagSeconds(rs.getDouble("flush_lag_s"))
                    .replayLagSeconds(rs.getDouble("replay_lag_s"))
                    .syncState(rs.getString("sync_state"))
                    .build());
            }
        } catch (SQLException e) {
            log.error("Failed to check replication lag", e);
        }

        double maxLag = lags.stream()
            .mapToDouble(ReplicaLag::flushLagSeconds)
            .max()
            .orElse(0);

        if (maxLag > 1.0) {
            log.warn("Replication lag warning: max flush lag = {}s. " +
                "Payment write latency may increase.", maxLag);
        }

        return ReplicationLagReport.of(lags, maxLag);
    }
}
```

---

## Production Tips and Pitfalls

### Pitfall 1: Using ONE Consistency for Payment Authorization

The most dangerous mistake in a Cassandra-backed payment system is using `ConsistencyLevel.ONE` for payment authorization reads. With a recently failed replica and async replication still catching up, `ONE` can return a stale balance that makes an overdraft appear valid:

```java
// WRONG — do not do this for payment authorization
public boolean hasSufficientFunds(UUID accountId, long amount) {
    // ONE only contacts 1 replica — may return stale balance
    Row row = session.execute(
        readBalanceStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.ONE)  // WRONG
    ).one();
    return row.getLong("balance_cents") >= amount;
}

// CORRECT
public boolean hasSufficientFunds(UUID accountId, long amount) {
    Row row = session.execute(
        readBalanceStmt.bind(accountId)
            .setConsistencyLevel(ConsistencyLevel.LOCAL_QUORUM)  // CORRECT
    ).one();
    return row.getLong("balance_cents") >= amount;
}
```

### Pitfall 2: Assuming Quorum Means No Conflicts

Quorum ensures you read the latest write, but it does NOT prevent concurrent writes from conflicting. Two concurrent debits on the same account can still both succeed if neither checks the balance under a lock:

```java
// WRONG — race condition: both writes pass the balance check
// if they execute concurrently
public void debit(UUID accountId, long amount) {
    long balance = readBalance(accountId);  // Both see $500
    if (balance >= amount) {               // Both pass: 500 >= 200
        writeNewBalance(accountId, balance - amount); // Both write $300
    }
    // Account is now at $300 but should be $100 — $200 double-spent
}

// CORRECT — use Cassandra LWT (IF balance_cents >= :amount)
// or PostgreSQL SELECT FOR UPDATE
public DebitResult debitWithCas(UUID accountId, long amount) {
    BoundStatement stmt = debitIfSufficientStmt.bind(amount, accountId, amount)
        .setConsistencyLevel(ConsistencyLevel.QUORUM)
        .setSerialConsistencyLevel(ConsistencyLevel.SERIAL);

    ResultSet rs = session.execute(stmt);
    return rs.one().getBool("[applied]")
        ? DebitResult.success()
        : DebitResult.insufficientFunds();
}
```

### Pitfall 3: Not Handling WriteTimeoutException

A `WriteTimeoutException` means the write succeeded on some replicas but not enough for the requested consistency level. For idempotent operations, it is safe to retry. For non-idempotent payment operations, you must check whether the write actually succeeded before retrying:

```java
public void writePaymentSafely(Payment payment) {
    try {
        session.execute(writePaymentStmt.bind(...));
    } catch (WriteTimeoutException e) {
        // The write MAY have partially succeeded
        // Check the idempotency key before deciding to retry
        log.warn("Write timeout for payment {} — checking idempotency before retry",
            payment.id());

        Optional<PaymentRecord> existing = findByIdempotencyKey(payment.idempotencyKey());
        if (existing.isPresent()) {
            log.info("Payment {} already exists despite timeout — idempotent", payment.id());
            return; // Already written — do not retry
        }

        // Not found — safe to retry
        retryWrite(payment);
    }
}
```

---

## Summary

Quorum systems provide the mathematical foundation for consistency guarantees in distributed financial databases. The key insights:

| Formula | Meaning |
|---|---|
| `R + W > N` | Strong consistency — reads always see latest writes |
| `W = ALL` | ROWA — maximum consistency, low write availability |
| `W = ⌈N/2⌉+1, R = ⌈N/2⌉+1` | Majority quorum — balanced consistency and availability |
| `W = 1, R = 1` | No consistency guarantee — eventual only |

For financial systems on Cassandra:
- Payment authorization: `LOCAL_QUORUM` for both reads and writes
- Idempotency keys: `SERIAL` consistency (Paxos)
- Risk rules: `ALL` writes + `ONE` reads (ROWA pattern)
- Display/inquiry: `LOCAL_ONE` for lower latency

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "In a Cassandra cluster with N=5 replicas, if W=3 and R=3, is strong consistency guaranteed?",
      "options": ["No, because W+R=6 which is greater than N=5 so overlap is not guaranteed", "Yes, because R+W=6 > N=5 guarantees at least one replica overlap between any read and write quorum", "Only if the replication factor is set to ALL", "No, strong consistency requires W=N"],
      "correct": 1,
      "explanation": "The quorum formula R+W > N guarantees that any read quorum and any write quorum must share at least one node. With R=3, W=3, N=5: 3+3=6 > 5, so at least one node is in both sets, ensuring a read always finds the latest write."
    },
    {
      "text": "What is the ROWA (Read One, Write All) pattern used for in financial systems?",
      "options": ["Maximizing read throughput for analytics workloads", "Ensuring every replica has the latest data before confirming a write, so reads can go to any single replica with full confidence", "Reducing write latency by batching updates to replicas", "Enabling cross-datacenter reads without quorum coordination"],
      "correct": 1,
      "explanation": "ROWA writes to all N replicas (W=N) before confirming success. This guarantees that any single replica has the latest data, so reads can use R=1 for minimal latency. It is used for data like risk rules where read latency matters but write availability can be sacrificed."
    },
    {
      "text": "Why is Cassandra's SERIAL consistency level (Paxos) used for idempotency key claims rather than LOCAL_QUORUM?",
      "options": ["SERIAL is faster than LOCAL_QUORUM for small key-value operations", "LOCAL_QUORUM can allow two concurrent requests to both read 'key not found' and both create the same record; SERIAL uses lightweight transactions to atomically compare and set", "SERIAL works across datacenters while LOCAL_QUORUM is datacenter-scoped", "Idempotency keys are too large for quorum-based replication"],
      "correct": 1,
      "explanation": "LOCAL_QUORUM reads and writes are not atomic as a unit — two concurrent requests can both read 'key absent' and both proceed to write, creating a duplicate. Cassandra's SERIAL consistency uses a Paxos round-trip (lightweight transaction) to atomically claim the key only if it does not exist."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Quorum Configuration and Consistency Verification for a Payment Keyspace",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Create a Cassandra keyspace for payments with replication factor 3. Experiment with all four quorum configurations (W=1/R=3, W=2/R=2, W=3/R=1, W=3/R=3) and verify which satisfy R+W > N = 3. Write a test that proves a stale read is possible when R+W <= N."},
    {"id": "2", "description": "Implement idempotency key registration in Cassandra using a lightweight transaction (IF NOT EXISTS). Write a concurrent test that fires 50 parallel requests with the same idempotency key and verifies that exactly one succeeds with APPLIED=true and the rest receive the existing record."},
    {"id": "3", "description": "Simulate a replica failure by stopping one of three Cassandra nodes. Verify that LOCAL_QUORUM writes (W=2) still succeed, then verify that ALL writes (W=3) fail. Measure the difference in write availability and document the trade-off for a payment system."},
    {"id": "4", "description": "Build a quorum health monitor for a Spring Boot service: expose a custom actuator endpoint that queries each Cassandra replica directly and reports how many replicas have the latest version of a sentinel key. Alert when fewer than N/2+1 replicas are in sync."}
  ]
}
-->

The quorum formula is not just a theoretical construct — it directly maps to business outcomes. A payment system that uses `ONE` for authorization will eventually double-charge a customer. A system that uses `ALL` will have unacceptable availability during routine deployments. The right quorum configuration is an engineering decision with direct financial and regulatory consequences.
