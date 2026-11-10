---
id: track-07-lesson-14
title: "Network Analysis — Graph-Based Money Laundering Detection"
slug: network-analysis
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 14
difficulty: principal
estimatedMinutes: 85
status: published
tags: [graph-analysis, network, Neo4j, smurfing, layering]
prerequisites: [track-07-lesson-04, track-07-lesson-05]
---

# Network Analysis — Graph-Based Money Laundering Detection

> [!NOTE]
> Money laundering is fundamentally a network problem: funds move through webs of accounts, entities, and jurisdictions designed to obscure their origin. Relational databases answer "who sent money to whom?" — graph databases answer "what is the full network of fund flows between these entities over three hops?" The difference in analytical power is decisive for detecting layering, smurfing, and circular fund flows.

## Why Graphs for AML

Traditional AML systems analyse transactions in isolation or with simple aggregation rules. The three stages of money laundering — placement, layering, integration — are only visible as patterns across a network of entities and transactions.

**Placement**: criminal proceeds enter the financial system (cash deposits, structuring).
**Layering**: funds move through multiple accounts and entities to obscure origin.
**Integration**: laundered funds re-enter the legitimate economy.

Layering requires following fund flows across chains of transactions. A graph traversal follows a 10-hop fund flow in milliseconds; a SQL join chain of the same depth is impractical.

---

## 1. Graph Data Model

```cypher
// Neo4j data model for AML network analysis

// Node types
(:Account  {id, type, currency, openedAt, status, riskScore})
(:Customer {id, name, dob, nationality, pepStatus, kycStatus})
(:Entity   {id, name, type, jurisdiction, registrationNumber})
(:Device   {fingerprint, ipAddress, country})
(:Merchant {id, name, mcc, country})

// Relationship types
(:Customer)-[:OWNS]->(:Account)
(:Entity)-[:CONTROLS]->(:Account)
(:Entity)-[:OWNS_SHARE_IN {percentage}]->(:Entity)  // beneficial ownership
(:Account)-[:SENT_TO {amount, currency, timestamp, txnId}]->(:Account)
(:Customer)-[:USES]->(:Device)
(:Account)-[:TRANSACTS_WITH]->(:Merchant)
(:Customer)-[:ASSOCIATED_WITH]->(:Customer)  // known associates
```

### 1.1 Neo4j Spring Data Integration

```java
@Configuration
@EnableNeo4jRepositories(basePackages = "com.fintech.aml.graph.repository")
public class Neo4jConfig {

    @Bean
    public Driver neo4jDriver(@Value("${neo4j.uri}") String uri,
                               @Value("${neo4j.username}") String username,
                               @Value("${neo4j.password}") String password) {
        return GraphDatabase.driver(uri,
                AuthTokens.basic(username, password),
                Config.builder()
                    .withMaxConnectionPoolSize(50)
                    .withConnectionAcquisitionTimeout(5, TimeUnit.SECONDS)
                    .withConnectionTimeout(10, TimeUnit.SECONDS)
                    .build());
    }
}

@Node("Account")
public class AccountNode {

    @Id
    private String id;
    private String type;
    private String currency;
    private LocalDateTime openedAt;
    private String status;
    private double riskScore;

    @Relationship(type = "SENT_TO", direction = OUTGOING)
    private List<SentToRelationship> outboundTransactions;

    @Relationship(type = "SENT_TO", direction = INCOMING)
    private List<SentToRelationship> inboundTransactions;
}

@RelationshipProperties
public class SentToRelationship {

    @Id
    @GeneratedValue
    private Long id;

    private BigDecimal amount;
    private String currency;
    private Instant timestamp;
    private String txnId;

    @TargetNode
    private AccountNode targetAccount;
}
```

---

## 2. Typology Detection with Cypher

### 2.1 Smurfing Detection

Smurfing involves multiple individuals making deposits below the CTR threshold ($10,000) on behalf of a single beneficiary. Detecting it requires finding accounts that receive funds from many small-value sources within a short time window.

```java
@Repository
public class SmurfingDetectionRepository {

    private final Driver neo4jDriver;

    // Detect accounts receiving funds from >= N distinct sources
    // within a time window where individual amounts are below CTR threshold
    private static final String SMURFING_QUERY = """
        MATCH (source:Account)-[t:SENT_TO]->(hub:Account)
        WHERE t.timestamp >= $windowStart
          AND t.timestamp <= $windowEnd
          AND t.amount < $ctrThreshold
        WITH hub, COUNT(DISTINCT source) AS senderCount,
             SUM(t.amount) AS totalReceived,
             COLLECT(DISTINCT source.id) AS senderIds
        WHERE senderCount >= $minSenders
          AND totalReceived >= $alertThreshold
        RETURN hub.id AS hubAccountId,
               senderCount,
               totalReceived,
               senderIds
        ORDER BY senderCount DESC
        LIMIT 100
        """;

    public List<SmurfingAlert> detectSmurfing(LocalDateTime windowStart,
                                               LocalDateTime windowEnd) {
        try (Session session = neo4jDriver.session()) {
            return session.executeRead(tx -> {
                var result = tx.run(SMURFING_QUERY, Map.of(
                        "windowStart",    windowStart.toString(),
                        "windowEnd",      windowEnd.toString(),
                        "ctrThreshold",   9500.00,    // slightly below $10k
                        "minSenders",     3,
                        "alertThreshold", 15000.00
                ));
                return result.list(record -> SmurfingAlert.builder()
                        .hubAccountId(record.get("hubAccountId").asString())
                        .senderCount(record.get("senderCount").asInt())
                        .totalReceived(new BigDecimal(
                                record.get("totalReceived").asString()))
                        .senderIds(record.get("senderIds").asList(Value::asString))
                        .build());
            });
        }
    }
}
```

### 2.2 Layering Detection — Multi-Hop Fund Flows

Layering involves sending money through a chain of accounts to obscure origin. The key signature is a linear chain: A -> B -> C -> D -> E, where each intermediate account passes through most of the received amount.

```java
@Repository
public class LayeringDetectionRepository {

    private final Driver neo4jDriver;

    // Find transaction chains where funds pass through N intermediate accounts
    // Each hop forwards >= 70% of received amount within 24 hours
    private static final String LAYERING_QUERY = """
        MATCH path = (source:Account)-[:SENT_TO*2..6]->(destination:Account)
        WHERE source <> destination
        AND ALL(r IN relationships(path)
                WHERE r.timestamp >= $windowStart
                  AND r.timestamp <= $windowEnd)
        AND ALL(idx IN RANGE(1, LENGTH(path)-1)
                WHERE (relationships(path)[idx]).amount >=
                      (relationships(path)[idx-1]).amount * 0.70)
        WITH path, source, destination,
             REDUCE(minAmt = 999999999.0,
                    r IN relationships(path) | CASE WHEN r.amount < minAmt
                                               THEN r.amount ELSE minAmt END)
             AS minHopAmount,
             LENGTH(path) AS hopCount
        WHERE minHopAmount >= $minAmount
        RETURN source.id    AS sourceAccountId,
               destination.id AS destAccountId,
               hopCount,
               minHopAmount,
               [n IN nodes(path) | n.id] AS accountChain,
               [r IN relationships(path) | {
                   txnId: r.txnId,
                   amount: r.amount,
                   timestamp: r.timestamp
               }] AS transactionChain
        ORDER BY hopCount DESC, minHopAmount DESC
        LIMIT 50
        """;

    public List<LayeringAlert> detectLayering(LocalDateTime windowStart,
                                               LocalDateTime windowEnd,
                                               BigDecimal minAmount) {
        try (Session session = neo4jDriver.session()) {
            return session.executeRead(tx -> {
                var result = tx.run(LAYERING_QUERY, Map.of(
                        "windowStart", windowStart.toString(),
                        "windowEnd",   windowEnd.toString(),
                        "minAmount",   minAmount.doubleValue()
                ));
                return result.list(record -> LayeringAlert.builder()
                        .sourceAccountId(record.get("sourceAccountId").asString())
                        .destAccountId(record.get("destAccountId").asString())
                        .hopCount(record.get("hopCount").asInt())
                        .minHopAmount(BigDecimal.valueOf(
                                record.get("minHopAmount").asDouble()))
                        .accountChain(record.get("accountChain")
                                .asList(Value::asString))
                        .build());
            });
        }
    }
}
```

### 2.3 Circular Fund Flow Detection

Circular flows — A -> B -> C -> A — indicate round-tripping or wash trading designed to generate fake transaction history.

```java
@Repository
public class CircularFlowDetectionRepository {

    private final Driver neo4jDriver;

    private static final String CIRCULAR_FLOW_QUERY = """
        MATCH cycle = (a:Account)-[:SENT_TO*2..5]->(a)
        WHERE ALL(r IN relationships(cycle)
                  WHERE r.timestamp >= $windowStart
                    AND r.timestamp <= $windowEnd
                    AND r.amount >= $minAmount)
        WITH cycle, a,
             LENGTH(cycle) AS cycleLength,
             REDUCE(total = 0.0,
                    r IN relationships(cycle) | total + r.amount)
             AS cycleVolume,
             [n IN nodes(cycle) | n.id] AS accountsInCycle
        RETURN a.id        AS anchorAccountId,
               cycleLength,
               cycleVolume,
               accountsInCycle
        ORDER BY cycleVolume DESC
        LIMIT 50
        """;

    public List<CircularFlowAlert> detectCircularFlows(
            LocalDateTime windowStart, LocalDateTime windowEnd) {
        try (Session session = neo4jDriver.session()) {
            return session.executeRead(tx -> {
                var result = tx.run(CIRCULAR_FLOW_QUERY, Map.of(
                        "windowStart", windowStart.toString(),
                        "windowEnd",   windowEnd.toString(),
                        "minAmount",   1000.00
                ));
                return result.list(record -> CircularFlowAlert.builder()
                        .anchorAccountId(record.get("anchorAccountId").asString())
                        .cycleLength(record.get("cycleLength").asInt())
                        .cycleVolume(BigDecimal.valueOf(
                                record.get("cycleVolume").asDouble()))
                        .accountsInCycle(record.get("accountsInCycle")
                                .asList(Value::asString))
                        .build());
            });
        }
    }
}
```

---

## 3. Graph Algorithms — PageRank for Hub Account Detection

Accounts that sit at the centre of many transaction flows act as money mule "hubs." PageRank (adapted for directed transaction graphs) scores each account by the volume and number of connections it has, weighted by the importance of connecting accounts.

```java
@Service
public class GraphAlgorithmService {

    private final Driver neo4jDriver;

    // Run Neo4j GDS (Graph Data Science) PageRank on the transaction graph
    // Requires Neo4j GDS plugin
    public List<HubAccount> runPageRank(LocalDateTime windowStart,
                                         LocalDateTime windowEnd) {
        try (Session session = neo4jDriver.session()) {

            // 1. Create in-memory projected graph for the time window
            session.executeWrite(tx -> {
                tx.run("""
                    CALL gds.graph.project(
                        'txn-graph',
                        'Account',
                        {
                            SENT_TO: {
                                properties: ['amount'],
                                orientation: 'NATURAL'
                            }
                        },
                        {
                            relationshipFilter:
                                'timestamp >= $windowStart AND timestamp <= $windowEnd'
                        }
                    )
                    """, Map.of(
                        "windowStart", windowStart.toString(),
                        "windowEnd",   windowEnd.toString()
                    ));
                return null;
            });

            // 2. Run PageRank
            List<HubAccount> results = session.executeRead(tx -> {
                var result = tx.run("""
                    CALL gds.pageRank.stream('txn-graph', {
                        maxIterations: 20,
                        dampingFactor: 0.85
                    })
                    YIELD nodeId, score
                    MATCH (a:Account) WHERE id(a) = nodeId
                    RETURN a.id AS accountId, score
                    ORDER BY score DESC
                    LIMIT 50
                    """);
                return result.list(record -> HubAccount.builder()
                        .accountId(record.get("accountId").asString())
                        .pageRankScore(record.get("score").asDouble())
                        .build());
            });

            // 3. Clean up projected graph
            session.executeWrite(tx -> {
                tx.run("CALL gds.graph.drop('txn-graph')");
                return null;
            });

            return results;
        }
    }

    // Community detection: find clusters of accounts transacting with each other
    // Useful for identifying fraud rings or money mule networks
    public List<AccountCommunity> detectCommunities() {
        try (Session session = neo4jDriver.session()) {
            session.executeWrite(tx -> {
                tx.run("""
                    CALL gds.graph.project(
                        'community-graph', 'Account',
                        {SENT_TO: {orientation: 'UNDIRECTED'}}
                    )
                    """);
                return null;
            });

            List<AccountCommunity> communities = session.executeRead(tx -> {
                var result = tx.run("""
                    CALL gds.louvain.stream('community-graph')
                    YIELD nodeId, communityId
                    MATCH (a:Account) WHERE id(a) = nodeId
                    RETURN communityId,
                           COLLECT(a.id) AS members,
                           COUNT(a.id)   AS size
                    WHERE size >= 3
                    ORDER BY size DESC
                    LIMIT 100
                    """);
                return result.list(record -> AccountCommunity.builder()
                        .communityId(record.get("communityId").asLong())
                        .members(record.get("members").asList(Value::asString))
                        .size(record.get("size").asInt())
                        .build());
            });

            session.executeWrite(tx -> {
                tx.run("CALL gds.graph.drop('community-graph')");
                return null;
            });

            return communities;
        }
    }
}
```

---

## 4. Beneficial Ownership Graph

The beneficial ownership graph maps who ultimately controls each corporate entity. Discovering that a PEP controls a company which owns an account is only possible by traversing the ownership chain.

```java
@Service
public class BeneficialOwnershipService {

    private final Driver neo4jDriver;

    // Find the ultimate beneficial owner(s) of an account
    // Follow OWNS and OWNS_SHARE_IN edges up to 10 hops
    private static final String UBO_QUERY = """
        MATCH path = (account:Account)<-[:OWNS|CONTROLS*1..10]-(owner)
        WHERE account.id = $accountId
          AND (owner:Customer OR owner:Entity)
        WITH owner, path,
             REDUCE(pct = 100.0,
                    r IN relationships(path) |
                    CASE type(r) WHEN 'OWNS_SHARE_IN'
                         THEN pct * r.percentage / 100.0
                         ELSE pct END) AS effectiveOwnership
        WHERE effectiveOwnership >= 25.0  // FATF 25% threshold
        RETURN owner.id         AS ownerId,
               labels(owner)[0] AS ownerType,
               owner.name       AS ownerName,
               effectiveOwnership,
               LENGTH(path)     AS hopCount,
               [n IN nodes(path) | {id: n.id, name: n.name, type: labels(n)[0]}]
               AS ownershipChain
        ORDER BY effectiveOwnership DESC
        """;

    public List<BeneficialOwner> findUBOs(String accountId) {
        try (Session session = neo4jDriver.session()) {
            return session.executeRead(tx -> {
                var result = tx.run(UBO_QUERY, Map.of("accountId", accountId));
                return result.list(record -> BeneficialOwner.builder()
                        .ownerId(record.get("ownerId").asString())
                        .ownerType(record.get("ownerType").asString())
                        .ownerName(record.get("ownerName").asString())
                        .effectiveOwnership(record.get("effectiveOwnership").asDouble())
                        .hopCount(record.get("hopCount").asInt())
                        .build());
            });
        }
    }

    // Check if any UBO is a PEP — required by FATF and 5AMLD
    public boolean hasUBOPepExposure(String accountId) {
        List<BeneficialOwner> ubos = findUBOs(accountId);
        return ubos.stream()
                .filter(ubo -> "Customer".equals(ubo.getOwnerType()))
                .anyMatch(ubo -> {
                    // Check PEP status from customer record
                    return customerRepo.findById(ubo.getOwnerId())
                            .map(c -> c.getPepStatus() != PepStatus.NONE)
                            .orElse(false);
                });
    }
}
```

---

## 5. Real-Time vs Batch Graph Analysis

| Approach | Latency | Throughput | Use Case |
|---|---|---|---|
| Real-time Cypher | < 100ms | Low | Transaction scoring, UBO lookup |
| Scheduled batch | Minutes-hours | High | Typology sweeps, PageRank |
| Streaming (Kafka -> Neo4j) | Seconds | Medium | Graph ingestion, alert triggers |
| Offline GDS algorithms | Hours | Very High | Community detection, full PageRank |

```java
// Real-time: check new transaction for immediate red flags
@Service
public class RealTimeGraphAnalysisService {

    private final Driver neo4jDriver;

    // Called synchronously during payment authorisation (< 100ms budget)
    public GraphRiskSignal analyseTransaction(String sourceAccountId,
                                               String destAccountId,
                                               BigDecimal amount) {
        try (Session session = neo4jDriver.session()) {
            // Check if destination account is a known hub
            var hubCheck = session.executeRead(tx -> tx.run("""
                MATCH (a:Account {id: $accountId})
                RETURN a.riskScore AS riskScore,
                       a.isKnownHub AS isKnownHub
                """, Map.of("accountId", destAccountId))
                .single());

            double destRiskScore = hubCheck.get("riskScore").asDouble(0.0);
            boolean isKnownHub   = hubCheck.get("isKnownHub").asBoolean(false);

            // Count recent in-degree for structuring detection
            var velocityCheck = session.executeRead(tx -> tx.run("""
                MATCH (src:Account)-[t:SENT_TO]->(dest:Account {id: $accountId})
                WHERE t.timestamp >= $since
                RETURN COUNT(DISTINCT src) AS senderCount,
                       SUM(t.amount)       AS recentInflow
                """, Map.of(
                    "accountId", destAccountId,
                    "since", Instant.now().minus(1, ChronoUnit.HOURS).toString()
                )).single());

            long senderCount  = velocityCheck.get("senderCount").asLong();
            double recentInflow = velocityCheck.get("recentInflow").asDouble();

            return GraphRiskSignal.builder()
                    .destAccountRiskScore(destRiskScore)
                    .isKnownHubAccount(isKnownHub)
                    .recentSenderCount(senderCount)
                    .recentInflow(BigDecimal.valueOf(recentInflow))
                    .smurfingIndicator(senderCount >= 5 && recentInflow >= 15000)
                    .build();
        }
    }
}
```

---

## 6. Graph Ingestion Pipeline

```java
@Service
public class GraphIngestionService {

    private final Driver neo4jDriver;
    private static final Logger log = LoggerFactory.getLogger(GraphIngestionService.class);

    // Ingest a completed transaction into the graph (called after settlement)
    @Transactional
    public void ingestTransaction(CompletedTransaction txn) {
        try (Session session = neo4jDriver.session()) {
            session.executeWrite(tx -> {
                // Merge accounts (create if not exists)
                tx.run("""
                    MERGE (src:Account {id: $srcId})
                    ON CREATE SET src.type = $srcType,
                                  src.currency = $currency,
                                  src.riskScore = 0.0
                    MERGE (dst:Account {id: $dstId})
                    ON CREATE SET dst.type = $dstType,
                                  dst.currency = $currency,
                                  dst.riskScore = 0.0
                    CREATE (src)-[:SENT_TO {
                        txnId: $txnId,
                        amount: $amount,
                        currency: $currency,
                        timestamp: $timestamp
                    }]->(dst)
                    """, Map.of(
                        "srcId",      txn.getSourceAccountId(),
                        "dstId",      txn.getDestAccountId(),
                        "txnId",      txn.getTransactionId(),
                        "amount",     txn.getAmount().doubleValue(),
                        "currency",   txn.getCurrency(),
                        "srcType",    txn.getSourceAccountType(),
                        "dstType",    txn.getDestAccountType(),
                        "timestamp",  txn.getSettledAt().toString()
                    ));
                return null;
            });
        } catch (Exception e) {
            log.error("Failed to ingest transaction into graph: txnId={}",
                    txn.getTransactionId(), e);
            // Queue for retry — graph lag is acceptable, graph gaps are not
            ingestionRetryQueue.enqueue(txn);
        }
    }
}
```

---

## 7. Performance at Scale

Neo4j performance degrades when queries traverse dense, highly-connected subgraphs. Mitigations:

```java
@Component
public class GraphPerformanceConfig {

    // 1. Time-bound all queries — never traverse the full graph
    // 2. Use index on Account.id and SENT_TO.timestamp
    // 3. Limit traversal depth to business-sensible values (max 6-8 hops)
    // 4. Project subgraphs for batch algorithms (GDS)
    // 5. Partition by time window for archival

    // Schema indexes — run once at setup
    private static final List<String> SCHEMA_STATEMENTS = List.of(
        "CREATE INDEX account_id    IF NOT EXISTS FOR (a:Account)   ON (a.id)",
        "CREATE INDEX customer_id   IF NOT EXISTS FOR (c:Customer)  ON (c.id)",
        "CREATE INDEX entity_id     IF NOT EXISTS FOR (e:Entity)    ON (e.id)",
        "CREATE INDEX txn_timestamp IF NOT EXISTS FOR ()-[t:SENT_TO]-() ON (t.timestamp)",
        "CREATE INDEX txn_id        IF NOT EXISTS FOR ()-[t:SENT_TO]-() ON (t.txnId)"
    );

    @PostConstruct
    public void createIndexes() {
        try (Session session = neo4jDriver.session()) {
            SCHEMA_STATEMENTS.forEach(stmt ->
                    session.executeWrite(tx -> { tx.run(stmt); return null; }));
        }
    }
}
```

---

## 8. Operational Considerations

| Concern | Approach |
|---|---|
| Graph size | Archive SENT_TO edges > 24 months to cold store; keep node history |
| Ingestion lag | Kafka -> Neo4j consumer; acceptable lag < 60 seconds |
| Query timeout | All Cypher queries have 5s timeout; async for batch typologies |
| Availability | Neo4j causal cluster (3+ nodes); reads from replicas |
| Security | Account IDs in graph — no PII; PII in relational DB |

---

## Summary

Graph-based AML is the most powerful tool for detecting sophisticated layering and circular fund flows that rule-based systems cannot see. Neo4j with Cypher provides expressive pattern matching for smurfing (fan-in), layering (chains), and circular flows (cycles). Graph algorithms — PageRank for hub detection, Louvain for community detection — identify systemic risk. The key operational principle is to time-bound all graph queries; unbounded traversals will bring down even a well-provisioned Neo4j cluster.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Why is a graph database architecturally superior to a relational database for detecting layering in money laundering?",
      "options": ["Graph databases store more data per node than relational rows", "A graph traversal follows a 10-hop fund flow in milliseconds; a SQL join chain of the same depth is impractical to write and prohibitively slow to execute", "Graph databases have better regulatory acceptance than SQL databases", "Graph databases can store transaction amounts more accurately"],
      "correct": 1,
      "explanation": "Money laundering layering requires following fund flows across chains of transactions — potentially 5-10 hops. SQL JOIN chains at this depth are complex to write and impractical to execute at scale. Graph traversal with Cypher follows the same path in milliseconds using index-based relationship traversal."
    },
    {
      "text": "What is the FATF threshold for beneficial ownership that determines when an entity owner must be identified as a UBO?",
      "options": ["10% ownership", "15% ownership", "25% ownership", "51% ownership"],
      "correct": 2,
      "explanation": "FATF Recommendation 24 and 5AMLD define a beneficial owner as a natural person who ultimately owns or controls an entity with an effective ownership percentage of 25% or more. The graph UBO query uses this threshold (effectiveOwnership >= 25.0) when traversing the OWNS_SHARE_IN relationship chain."
    },
    {
      "text": "What is the primary operational risk of unbounded Neo4j graph traversals and how should it be mitigated?",
      "options": ["Graph traversals consume too much storage", "Dense, highly-connected subgraphs can cause traversals to run indefinitely, bringing down the cluster — mitigated by enforcing hop limits (max 6-8), time-bound query execution, and projecting subgraphs for batch algorithms", "Neo4j does not support multi-tenant isolation for graph queries", "Real-time Cypher queries cannot be indexed effectively"],
      "correct": 1,
      "explanation": "Without depth limits, a query on a highly-connected hub account (which has thousands of transaction edges) can traverse millions of paths. The mitigation is to: (1) always specify hop limits (MATCH path...*1..8), (2) set query timeouts, (3) use GDS graph projections for batch algorithms rather than live Cypher traversals."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Graph-Based AML Network Analysis System",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Design and implement the Neo4j data model for AML analysis: Account, Customer, Entity, Device, and Merchant node types with appropriate properties. Implement the OWNS, CONTROLS, OWNS_SHARE_IN, SENT_TO, and USES relationship types. Create all required schema indexes (account ID, customer ID, SENT_TO timestamp) using @PostConstruct initialization."},
    {"id": "2", "description": "Implement the BeneficialOwnershipService.findUBOs() method using the provided Cypher UBO query. The method must traverse OWNS and CONTROLS relationships up to 10 hops, calculate effective ownership percentage by multiplying OWNS_SHARE_IN percentages along the path, and return only owners with 25%+ effective ownership. Test with a 3-layer ownership chain: Person A owns 60% of Company B, which owns 50% of Company C, which owns Account D."},
    {"id": "3", "description": "Implement the RealTimeGraphAnalysisService.analyseTransaction() method that checks the destination account's risk score and hub status and counts distinct senders in the past hour. The method must complete in under 100ms. Set a 5-second Cypher query timeout. Return a GraphRiskSignal with smurfingIndicator=true when 5+ distinct senders deposited in the past hour."},
    {"id": "4", "description": "Implement the GraphIngestionService.ingestTransaction() method that uses MERGE to create or update source and destination Account nodes and CREATE to add the SENT_TO relationship. Implement idempotent ingestion by checking for existing SENT_TO relationships with the same txnId before creating. Write an integration test using Neo4j Testcontainers that ingests 5 transactions from different senders to the same account and verifies the smurfing indicator fires."}
  ]
}
-->
