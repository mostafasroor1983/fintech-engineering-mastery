---
id: track-02-lesson-01
title: "The CAP Theorem — Consistency, Availability, Partition Tolerance"
slug: cap-theorem
track: track-02
trackName: Distributed Systems Engineering
sequence: 1
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [CAP, consistency, availability, partition-tolerance, PACELC]
prerequisites: []
---

# The CAP Theorem — Consistency, Availability, Partition Tolerance

> [!NOTE]
> The CAP theorem is the foundational constraint of distributed systems. Every architectural decision in a distributed financial system is a trade-off that CAP — and its more nuanced successor, PACELC — helps you reason about.

## The Theorem

In 2000, Eric Brewer conjectured, and Gilbert and Lynch later proved, that a distributed data store can provide **at most two** of the following three guarantees simultaneously:

- **Consistency (C)** — Every read receives the most recent write or an error (formally, linearizability). The system behaves as if there were a single copy of the data.
- **Availability (A)** — Every request receives a response (not an error), though the response may not contain the most recent write.
- **Partition Tolerance (P)** — The system continues operating even when network messages between nodes are lost or delayed.

```mermaid
graph TD
    CAP[CAP Triangle]
    C[Consistency\nAll nodes agree]
    A[Availability\nAlways responds]
    P[Partition Tolerance\nSurvives network splits]
    
    CAP --> C
    CAP --> A
    CAP --> P
    
    C --- CA[CA\nOnly without partitions\ne.g. a single-node DB]
    A --- CA
    C --- CP[CP Systems\nMongoDB, HBase\nMay refuse requests]
    P --- CP
    A --- AP[AP Systems\nCassandra, DynamoDB\nMay return stale data]
    P --- AP
```

> [!WARNING]
> The choice is not "pick 2 of 3" in practice. Network partitions **will** occur in any distributed system. Therefore the real choice is: **when a partition happens, do you sacrifice consistency or availability?**

---

## Why Partition Tolerance Is Not Optional

A network partition is any scenario where nodes cannot communicate:

- A network cable is cut between data centres
- A switch fails under load
- A noisy neighbour saturates a network interface
- A cloud provider has a BGP routing incident

In any system spanning more than one process (which includes every distributed financial system), you must tolerate partitions. The P in CAP is therefore not a choice — it is a requirement.

The real choice is **CP vs AP**: what do you do *during* a partition?

```mermaid
sequenceDiagram
    participant Client
    participant Node1 as Node 1 (Primary)
    participant Node2 as Node 2 (Replica)

    Note over Node1,Node2: Network Partition Occurs

    Client->>Node1: Write: balance = £1000
    Node1-->>Client: 200 OK (write accepted)
    
    Note over Node1,Node2: Replication blocked by partition
    
    Client->>Node2: Read: what is balance?
    
    alt CP System (Consistency Priority)
        Node2-->>Client: 503 Service Unavailable\n(refuses to answer without quorum)
    else AP System (Availability Priority)
        Node2-->>Client: 200 OK: balance = £900\n(returns stale data)
    end
```

---

## CP Systems — Consistency Over Availability

CP systems refuse to respond when they cannot guarantee the response is current. They prioritise **correctness** over uptime.

**Examples:** HBase, MongoDB (with majority write concern), etcd, ZooKeeper, Consul

**Financial use cases where CP is correct:**
- Account balance reads during a payment authorisation
- Distributed lock acquisition for idempotency
- Consensus on who is the current leader in a payment processor cluster
- Atomic multi-account balance transfer

```java
// etcd CP lock — a transaction that creates the key only if it does not exist yet.
// The write needs a Raft majority: during a partition the minority side cannot
// take the lock — it fails instead of granting the lock twice.
ByteSequence key = ByteSequence.from("payment-lock/txn-abc123", UTF_8);
CompletableFuture<TxnResponse> response = etcdClient.getKVClient().txn()
    .If(new Cmp(key, Cmp.Op.EQUAL, CmpTarget.createRevision(0)))      // key absent
    .Then(Op.put(key, ByteSequence.from(nodeId, UTF_8),
                 PutOption.newBuilder().withLeaseId(leaseId).build()))  // TTL-based lock
    .commit();

try {
    TxnResponse result = response.get(500, TimeUnit.MILLISECONDS);
    if (!result.isSucceeded()) {
        throw new LockHeldException("Another node holds the lock");
    }
    // Lock acquired — safe to proceed (still protect the write with a DB constraint)
} catch (TimeoutException | ExecutionException e) {
    // Partition or quorum loss — cannot proceed safely
    throw new DistributedLockException("Cannot acquire lock during partition", e);
}
```

---

## AP Systems — Availability Over Consistency

AP systems continue responding during a partition, potentially returning stale data. They prioritise **uptime** over correctness.

**Examples:** Cassandra, DynamoDB, CouchDB, DNS

**Financial use cases where AP is correct:**
- Fraud score cache reads (slightly stale is acceptable; refusing is not)
- Exchange rate feeds (approximate rate is better than error)
- Product catalogue and fee schedule reads
- Read-heavy reference data (account metadata, BIC codes)

```java
// Cassandra AP read — QUORUM consistency for most operations
// ONE consistency for latency-sensitive, stale-tolerant reads
Session session = cassandraCluster.connect("payments_keyspace");

// AP: accept potentially stale data for exchange rate lookup
Row exchangeRate = session.execute(
    QueryBuilder.select().all()
        .from("exchange_rates")
        .where(QueryBuilder.eq("currency_pair", "GBP/USD"))
        .setConsistencyLevel(ConsistencyLevel.ONE)  // AP: respond even during partition
).one();

// Stronger: QUORUM reads see the latest QUORUM write. But a read-modify-write of a
// balance still needs a lightweight transaction (IF ... with SERIAL consistency)
// to avoid lost updates — most teams keep balances in a relational database.
Row accountBalance = session.execute(
    QueryBuilder.select().all()
        .from("accounts")
        .where(QueryBuilder.eq("account_id", accountId))
        .setConsistencyLevel(ConsistencyLevel.QUORUM)  // needs a majority of replicas
).one();
```

---

## PACELC — The More Complete Model

CAP only describes behaviour *during* partitions. The **PACELC theorem** (Daniel Abadi, 2012) extends this to normal operations:

> If there is a **P**artition, choose between **A**vailability and **C**onsistency.
> **E**lse (no partition), choose between **L**atency and **C**onsistency.

```mermaid
graph LR
    P{Network\nPartition?}
    P -->|Yes| PA[PA: Available but\npossibly stale]
    P -->|Yes| PC[PC: Consistent but\nmay refuse]
    P -->|No| EL[EL: Low latency\nbut may be stale]
    P -->|No| EC[EC: Consistent\nbut higher latency]
    
    PA --> Cassandra[Cassandra\nPA/EL]
    PC --> etcd[etcd\nPC/EC]
    EL --> DynamoDB[DynamoDB\nPA/EL]
    EC --> Spanner[Google Spanner\nPC/EC]
```

| System | Partition | Normal Ops | Use in Finance |
|---|---|---|---|
| Cassandra | PA | EL | Reference data, fraud cache |
| etcd | PC | EC | Leader election, distributed locks |
| DynamoDB (default) | PA | EL | Session state, rate limit counters |
| Google Spanner | PC | EC | Ledger entries, account balances |
| PostgreSQL single-node | — | EC | OLTP transactions |
| CockroachDB | PC | EC | Multi-region financial records |

---

## Applying CAP to Financial System Design

### The Payment Authorisation Decision

A payment authorisation must decide: should I authorise this payment when I cannot confirm the current account balance?

```mermaid
flowchart TD
    A[Authorisation Request\n£500 payment] --> B{Can reach\nauthoritative\nbalance source?}
    B -->|Yes| C[Read confirmed balance\n£1,200 available]
    C --> D[Authorise payment\nCP behaviour]
    B -->|No — Partition| E{System Design\nDecision}
    E -->|CP Strategy| F[Reject authorisation\n503 or decline]
    E -->|AP Strategy| G{Cached balance\navailable?}
    G -->|Yes, recent < 30s| H[Authorise using\ncached balance\nAP behaviour]
    G -->|No or stale| I[Decline with\nretry instruction]
```

**The principal engineer's decision:** A £500 payment on a £1,200 account with a 30-second-old cache is almost certainly safe to authorise. A £5,000 payment on a £5,200 account with a 2-minute-old cache is not — the customer may have already spent that money.

The right answer depends on:
- **Maximum stale window tolerated** by business risk
- **Consequence of inconsistency** (can it be reversed? Is fraud the concern?)
- **Consequence of unavailability** (declined payment at checkout = customer lost)

---

## Principal Engineer's CAP Decision Framework

When selecting a data store or designing a distributed data architecture:

**Step 1 — Identify the partition scenario.** What happens when two nodes cannot communicate? What does the user experience?

**Step 2 — Classify the data by consistency requirement:**

| Consistency Tier | Description | Acceptable Stale Window |
|---|---|---|
| **Strict** | Account balances, ledger entries | Zero — always current |
| **High** | Payment state, idempotency keys | < 1 second |
| **Moderate** | Fraud scores, credit limits | < 30 seconds |
| **Low** | Exchange rates, fees | < 5 minutes |
| **Very Low** | Reference data, BIC codes | Hours |

**Step 3 — Map requirements to system choice:**
- Strict/High → CP systems (PostgreSQL, Spanner, etcd)
- Moderate → Tunable consistency with read quorum (Cassandra QUORUM, DynamoDB Strong Reads)
- Low/Very Low → AP systems (Cassandra ONE, Redis, DynamoDB Eventual Reads)

**Step 4 — Design the partition behaviour explicitly.** Don't let it happen by accident — document what your system does during a partition in the ADR.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "During a network partition, your payment authorisation service cannot reach the primary database. It has a 15-second-old cached balance showing £2,000 available. The payment request is for £1,500. What is the most defensible decision?",
      "options": [
        "Always decline during a partition — consistency is non-negotiable for payments",
        "Always approve from cache — availability is non-negotiable for payments",
        "Approve if the stale window and amount are within defined risk parameters, with the ability to reverse if reconciliation fails",
        "Queue the request and retry when the partition heals"
      ],
      "correct": 2,
      "explanation": "The correct answer depends on context, but option C represents principled AP design: define acceptable stale windows and amount thresholds explicitly, approve within those bounds, and have a reconciliation path. Pure CP (always decline) is a poor UX. Pure AP (always approve) is a risk management failure. Queueing is not viable for real-time payment auth."
    },
    {
      "id": "q2",
      "text": "PACELC extends CAP by considering what scenario that CAP ignores?",
      "options": [
        "The latency-consistency trade-off during normal (non-partition) operation",
        "The cost of storage versus performance",
        "The choice between SQL and NoSQL databases",
        "The number of replicas needed for durability"
      ],
      "correct": 0,
      "explanation": "PACELC asks: when there is NO partition, do you optimise for Latency or Consistency? CAP only addresses the partition scenario. This is critical for financial systems because low-latency reads that return slightly stale data (EL) versus consistent reads with higher latency (EC) is a constant design decision."
    },
    {
      "id": "q3",
      "text": "You are designing a distributed fraud score cache. Fraud scores are recalculated every 60 seconds. During a partition, nodes continue serving requests from their local cache. Which CAP classification does this represent?",
      "options": [
        "CP — because fraud scores are financial data",
        "CA — because you're not accepting partitions",
        "AP — because nodes remain available but may serve stale data",
        "CP — because nodes will eventually converge"
      ],
      "correct": 2,
      "explanation": "This is AP. Nodes continue responding (Available) during a partition (Partition tolerant), but may serve fraud scores calculated before the partition (not Consistent). This is an appropriate design for fraud scoring where slight staleness is acceptable and refusing to serve increases false positives."
    },
    {
      "id": "q4",
      "text": "An engineer proposes using Cassandra with ConsistencyLevel.ONE for account balance writes to achieve maximum write throughput. What is the CAP implication?",
      "options": [
        "This is fine — Cassandra is eventually consistent so reads will catch up",
        "This makes the balance store AP: writes succeed even if only one replica acknowledges, creating diverged state during partitions",
        "This makes the balance store CP: Cassandra's replication ensures consistency",
        "ConsistencyLevel.ONE only affects read latency, not consistency guarantees"
      ],
      "correct": 1,
      "explanation": "ConsistencyLevel.ONE means a write succeeds if any single replica acknowledges it. During a partition, different replicas may accept different writes, creating diverged state. This is AP behaviour. For account balances, QUORUM is the minimum, and read-modify-write updates also need lightweight transactions (SERIAL) to avoid lost updates — which is why balances usually live in a relational database."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "CAP in Practice — Partition Behaviour of a Payment Balance Service",
  "difficulty": "advanced",
  "estimatedMinutes": 85,
  "tasks": [
    {
      "id": "1",
      "description": "Run a 3-node etcd (or CockroachDB) cluster and a 3-node Cassandra cluster in Testcontainers. Use Toxiproxy to cut one node off and record, for each store, whether reads and writes on the minority side fail or return stale data."
    },
    {
      "id": "2",
      "description": "Implement the payment-authorisation flowchart from this lesson in a Spring Boot service: during a partition, approve from a cached balance only when the cache age and the amount are within configured limits; otherwise decline. Write a test for each branch."
    },
    {
      "id": "3",
      "description": "Add Micrometer metrics for authorisations decided from the cache versus the authoritative source, the cache age at decision time, and declines caused by partitions. Add an alert on the cache-based approval rate."
    },
    {
      "id": "4",
      "description": "Write an ADR that classifies your payment data into the five consistency tiers from this lesson, names the store and consistency level used for each, and documents what the system does during a partition."
    }
  ]
}
-->
