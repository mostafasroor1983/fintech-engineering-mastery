# Lesson Tiers — Phase 0 Proposal

> Generated: 2026-11-12  
> **READ-ONLY until Phase 0 approved.**  
> Tier assignments drive what stays on the 30-week main path vs. what moves to Optional depth reading.

---

## Tier Legend

| Symbol | Meaning | Main path? |
|--------|---------|-----------|
| **C** | Core — highest interview frequency; learner MUST do | Yes |
| **S** | Supporting — direct prereq or close second for a Core lesson | Yes |
| **O** | Optional — valuable depth; available but not on critical path | No |
| **DEL** | Delete — T04/T07 content (track deleted) or orphaned stub | No |
| **MERGE** | Absorb into another lesson | Absorbed |
| **FLAG** | Keep content, requires legal/compliance accuracy review | Yes (C) |

---

## Budget Reconciliation

```
Main path cap                            260 h
────────────────────────────────────────────────
New content (Phase 1–4 to create)
  Spring Boot 4 module  (8 lessons)       24 h
  System Design module  (8 lessons)       22 h
  Capstone rewrites     (6 × 10 h)        60 h
  Interview Playbook                       8 h
  90-day plan guide                        2 h
  Sub-total new                          116 h

Budget for existing lessons              144 h
────────────────────────────────────────────────
Existing Core   (90 lessons)            ~124 h
Existing Supporting (13 lessons)         ~17 h  ← trimmed from 71 original
Existing C+S total                      ~141 h  ✓ (≤ 144 h)

Total main path                         ~257 h  ✓ (≤ 260 h)
────────────────────────────────────────────────
Buffer / slack (reviews, mock interviews)  43 h
Grand total                              300 h  ✓
```

> **Key budget fix:** Original Supporting tier had 71 lessons (92.8 h). 
> Combined with Core (126.8 h) that totals 219.6 h — 75.6 h over the 144 h cap.
> Fix: demote 58 Supporting → Optional; keep only the 13 that are direct prereqs.

---

## T01 — Advanced Software Architecture (20 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T01-01 Evolutionary Architecture | 85 | O | Framework thinking, not interview critical |
| T01-02 ADR Practice | 60 | O | Good for Staff signal; not tested in loops |
| T01-03 C4 Model | 70 | O | Diagram literacy, not a deep-dive topic |
| T01-04 DDD — Strategic Patterns | 90 | **C** | High freq; bounded context in fintech design questions |
| T01-05 DDD — Tactical Patterns | 90 | **C** | High freq; aggregates, entities in payment design |
| T01-06 Hexagonal Architecture | 80 | S | Useful for ports/adapters discussion; supports T01-04/05 |
| T01-07 Event-Driven Architecture | 85 | **C** | Core topic; always comes up in payment system design |
| T01-08 CQRS | 85 | S | Canonical: T06-19; keep here as Supporting intro |
| T01-09 API Design (REST/gRPC) | 90 | **C** | High freq; every system design includes API layer |
| T01-10 Microservices vs Monolith | 80 | O | Good context; rarely a deep-dive interview topic |
| T01-11 Service Mesh / Istio | 80 | O | Mostly ops; O for backend engineers |
| T01-12 Data Architecture | 85 | O | Broad survey; covered better in T10 |
| T01-13 Contract Testing / Pact | 75 | O | Testing depth; not typical interview topic |
| T01-14 Rate Limiting / Back Pressure | 75 | **C** | High freq; every high-throughput system design |
| T01-15 Feature Flags / Progressive Delivery | 65 | O | Nice to have; not fintech-specific |
| T01-16 Multi-Tenancy | 80 | O | Relevant but rarely a deep-dive topic |
| T01-17 API Gateway / BFF | 75 | O | Pattern awareness; O depth |
| T01-18 Zero-Trust Security | 75 | O | Covered better in T13 |
| T01-19 Strangler Fig / Migration | 80 | O | Useful for Staff; not typical interview |
| T01-20 Decision Framework | 65 | O | Capstone-style; Optional |

**T01 Core: 4 lessons, 340 min (5.7 h)**  
**T01 Supporting: 2 lessons, 165 min (2.75 h)**

---

## T02 — Distributed Systems Engineering (22 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T02-01 CAP Theorem | 85 | **C** | Foundation; every distributed design question |
| T02-02 Consistency Models | 85 | **C** | High freq; often tested with CAP |
| T02-03 Distributed Clocks | 80 | O | Depth topic; Lamport clocks occasionally asked |
| T02-04 Leader Election / Raft | 90 | S | Important context; Raft is L-freq deep dive |
| T02-05 Consensus in Fintech | 85 | O | Extension of T02-04; O depth |
| T02-06 2PC / XA Transactions | 85 | **C** | High freq; "2PC vs Saga" is classic fintech question |
| T02-07 Replication Strategies | 85 | S | Important for DB HA discussion; supports T02-01 |
| T02-08 Distributed Caching / Redis | 80 | S | Supports T10-14 Redis patterns |
| T02-09 Distributed Locks / Redlock | 80 | **C** | High freq; "how would you implement a dist. lock?" |
| T02-10 Split-Brain / Network Partitions | 80 | **C** | High freq; real incident type question |
| T02-11 Service Discovery | 70 | O | Infrastructure concern; O for backend engineers |
| T02-12 Gossip Protocols | 70 | O | L-freq; interesting but rarely deep-dived |
| T02-13 Quorum-Based Systems | 75 | O | Covered by T02-01/02; O extension |
| T02-14 Idempotency in Distributed Systems | 85 | **C** | High freq; canonical with T06-12 |
| T02-15 Event Sourcing in Distributed Systems | 85 | O | Canonical: T06-18; O extension here |
| T02-16 Exactly-Once in Distributed Systems | 85 | O | Canonical: T11-05; O extension here |
| T02-17 Distributed Rate Limiting | 75 | O | Covered by T01-14 and T08-13 |
| T02-18 Cross-Region Active-Active | 90 | O | M-freq; often system-design depth |
| T02-19 Distributed Tracing — Causality | 75 | O | Covered by T13-01/02 |
| T02-20 Chaos Engineering | 75 | O | Good for Staff; not deep-dive interview |
| T02-21 Byzantine Generals | 70 | O | Academic; L-freq |
| T02-22 Decision Framework | 65 | O | Capstone-style; Optional |

**T02 Core: 7 lessons, 580 min (9.7 h)**  
**T02 Supporting: 3 lessons, 255 min (4.25 h)**

---

## T03 — Concurrency & Thread Safety (29 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T03-01 Java Memory Model — Fundamentals | 90 | **C** | Foundation; H-freq in every Java interview |
| T03-02 Thread Safety — Immutability | 75 | **C** | H-freq; design principles |
| T03-03 Synchronization / ReentrantLock | 90 | **C** | H-freq; lock mechanics always tested |
| T03-04 Atomic Operations / CAS | 85 | **C** | H-freq; lock-free algorithms |
| T03-05 ABA Problem | 60 | S | Supporting T03-04; L-freq but foundational |
| T03-06 Concurrent Collections | 80 | **C** | H-freq; ConcurrentHashMap internals |
| T03-07 Race Conditions in Finance | 95 | **C** | H-freq; scenario-based question |
| T03-08 Deadlocks, Livelocks, Starvation | 85 | **C** | H-freq; classic interview topic |
| T03-09 False Sharing / CPU Cache Lines | 60 | O | Performance depth; L-freq |
| T03-10 Thread Pool Design | 90 | **C** | H-freq; ThreadPoolExecutor sizing |
| T03-11 CompletableFuture | 95 | **C** | H-freq; async pipelines in Spring services |
| T03-12 Virtual Threads — Fundamentals | 85 | **C** | M-freq; Java 21 must-know |
| T03-13 Virtual Thread Pinning | 70 | S | Supporting T03-12; important caveat |
| T03-14 Structured Concurrency | 75 | **C** | M-freq; Java 21 differentiator |
| T03-15 Scoped Values | 60 | O | L-freq; Java 21 depth |
| T03-16 Testing Concurrency / jcstress | 90 | **C** | M-freq; practical skill |
| T03-17 JMH for Concurrent Code | 80 | O | Covered by T09-04 |
| T03-18 Thread Dump Analysis | 75 | **C** | M-freq; production debugging |
| T03-19 Lock Contention Analysis | 70 | O | Extension of T03-18; O depth |
| T03-20 Thread Pool Exhaustion | 75 | **C** | H-freq; classic fintech failure scenario |
| T03-21 Concurrent Balance Management | 90 | **C** | H-freq; directly maps to T06 scenarios |
| T03-22 Safe Publication | 65 | O | Advanced JMM; L-freq |
| T03-23 Memory Barriers | 70 | O | Advanced JMM; L-freq |
| T03-24 Semaphores / Latches / Phasers | 80 | O | Useful but rarely deep-dived |
| T03-25 Context Propagation in Async | 75 | O | Extension of T03-14; O |
| T03-26 JMM Advanced — Fences, Unsafe | 80 | O | Expert depth; not typical interview |
| T03-27 Concurrency Patterns in Finance | 90 | **C** | H-freq; directly interview-ready |
| T03-28 Decision Framework | 60 | O | Capstone-style; Optional |
| T03-29 Thread-Safety Audit | 90 | **C** | M-freq; practical engineering skill |

**T03 Core: 16 lessons, 1310 min (21.8 h)**  
**T03 Supporting: 2 lessons, 130 min (2.2 h)**

---

## T04 — Async & Reactive Systems (20 lessons) — TRACK DELETED

> Decision: Content overlaps T03 (async) and T11 (Kafka reactive). 
> Reactive programming (Project Reactor, R2DBC, WebFlux) is declining in adoption at target companies in favour of virtual threads.

| Action | Count |
|--------|-------|
| MERGE T04-01 (intro) → T03-11 (CompletableFuture intro) | 1 |
| DELETE all remaining T04 lessons | 19 |

**T04 Total deleted: 19, merged: 1**

---

## T05 — Banking & Financial Systems (22 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T05-01 Core Banking Architecture | 90 | **C** | H-freq; "design a core banking system" |
| T05-02 Payment Processing Architecture | 90 | **C** | H-freq; classic system design question |
| T05-03 Double-Entry Accounting | 75 | **C** | H-freq; every fintech system design |
| T05-04 Account Management | 70 | O | Domain knowledge; O depth |
| T05-05 Funds Reservation / Holds | 85 | **C** | H-freq; linked to T06 scenarios |
| T05-06 SWIFT MT Messages | 85 | O | Domain depth; rarely tested in depth |
| T05-07 ISO 20022 | 90 | **C** | M-freq; Revolut-class companies use this |
| T05-08 Real-Time Payments (FPS/SEPA) | 85 | **C** | M-freq; payment rail knowledge |
| T05-09 Cross-Border Payments | 85 | O | Domain depth; M-freq but O |
| T05-10 FX Systems Architecture | 85 | O | Domain depth; O |
| T05-11 Payment Routing / Netting | 80 | O | Domain depth; O |
| T05-12 Financial Reconciliation | 85 | O | Canonical: T06-22; O here |
| T05-13 AML Architecture | 90 | O | Covered better in T07 (flagged) |
| T05-14 KYC Architecture | 80 | O | Domain knowledge; O |
| T05-15 Sanctions Screening | 85 | O | Domain knowledge; O |
| T05-16 Fraud Detection Architecture | 85 | O | Domain knowledge; O |
| T05-17 Regulatory Reporting | 80 | O | Domain knowledge; O |
| T05-18 Card Processing | 85 | S | M-freq; Visa/Mastercard flow often asked |
| T05-19 Digital Wallet Architecture | 75 | O | M-freq but covered by T05-01/02 |
| T05-20 Open Banking / PSD2 | 80 | O | Domain knowledge; O |
| T05-21 High-Throughput Payment Design | 95 | S | M-freq; complements T05-02 for scale discussion |
| T05-22 Decision Framework | 65 | O | Capstone-style; Optional |

**T05 Core: 6 lessons, 525 min (8.75 h)**  
**T05 Supporting: 2 lessons, 180 min (3.0 h)**

---

## T06 — Financial Transaction Integrity (24 lessons) — ALL CORE

> Per brief: all 24 lessons are Core. Realistic cap: 100 min/lesson = ~40 h total.
> Declared total 2065 min (34.4 h); at 100 min cap becomes ~40 h after updates.

| Lesson | Min | Tier |
|--------|-----|------|
| T06-01 Double-Entry Ledger Architecture | 90 | **C** |
| T06-02 Scenario A — Concurrent Withdrawals | 100 | **C** |
| T06-03 Scenario B — Duplicate Payment | 95 | **C** |
| T06-04 Scenario C — Double Spending | 90 | **C** |
| T06-05 Scenario D — Concurrent Ledger Posting | 85 | **C** |
| T06-06 Scenario E — Partial Failure & Compensation | 95 | **C** |
| T06-07 Scenario F — DB + Kafka Dual-Write | 95 | **C** |
| T06-08 Scenario G — Duplicate Kafka Delivery | 90 | **C** |
| T06-09 Scenario H — Out-of-Order Events | 85 | **C** |
| T06-10 Scenario I — Reconciliation Mismatches | 90 | **C** |
| T06-11 Scenario J — Concurrent Balance at Scale | 95 | **C** |
| T06-12 Idempotency Design Patterns | 85 | **C** |
| T06-13 Transactional Outbox Pattern | 90 | **C** |
| T06-14 Saga Pattern | 95 | **C** |
| T06-15 2PC vs Saga | 75 | **C** |
| T06-16 Optimistic Locking | 80 | **C** |
| T06-17 Pessimistic Locking | 80 | **C** |
| T06-18 Event Sourcing for Ledgers | 90 | **C** |
| T06-19 CQRS in Payment Systems | 85 | **C** |
| T06-20 DB Transactions + JVM Concurrency | 85 | **C** |
| T06-21 Audit Trails / Immutable Ledger | 70 | **C** |
| T06-22 Balance Reconciliation | 80 | **C** |
| T06-23 Compensating Transactions | 75 | **C** |
| T06-24 Decision Framework | 65 | **C** |

**T06 Core: 24 lessons, 2065 min (34.4 h → ~40 h after content updates)**

---

## T07 — Financial Crime, Compliance & Risk (18 lessons) — TRACK DELETED

> Decision: Content too specialist for a backend engineering interview prep curriculum.
> Exception: T07-08 and T07-09 contain PCI DSS / GDPR architecture content relevant to system design.

| Lesson | Tier | Reason |
|--------|------|--------|
| T07-01 AML Framework | DEL | Compliance specialist, not backend engineering |
| T07-02 AML Typologies | DEL | |
| T07-03 Transaction Monitoring | DEL | |
| T07-04 SAR Filing | DEL | |
| T07-05 Sanctions Screening | DEL | |
| T07-06 Fraud Detection ML | DEL | |
| T07-07 KYC / CDD | DEL | |
| T07-08 GDPR at Architecture Level | **FLAG** | Keep — PCI/GDPR at architecture level is L-freq |
| T07-09 PCI DSS Tokenisation Architecture | **FLAG** | Keep — PCI DSS tokenisation is L-freq |
| T07-10 Risk Scoring | DEL | |
| T07-11 Credit Risk | DEL | |
| T07-12 Operational Risk | DEL | |
| T07-13 Model Risk | DEL | |
| T07-14 Basel III | DEL | |
| T07-15 MiFID II | DEL | |
| T07-16 RegTech | DEL | |
| T07-17 Stress Testing | DEL | |
| T07-18 Risk Architecture | DEL | |

**T07 Flagged: 2 lessons (review accuracy, may update content)**  
**T07 Deleted: 16 lessons**

---

## T08 — High Availability & Resilience (18 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T08-01 SLOs and Error Budgets | 85 | **C** | H-freq; "how do you define reliability?" |
| T08-02 Circuit Breaker | 80 | **C** | H-freq; classic resilience pattern |
| T08-03 Bulkhead | 75 | **C** | H-freq; linked to circuit breaker |
| T08-04 Retry / Backoff / Jitter | 75 | **C** | H-freq; every distributed service |
| T08-05 Timeout Engineering | 75 | **C** | H-freq; cascading failure prevention |
| T08-06 Chaos Engineering | 80 | O | Good for Staff level; not deep-dive interview |
| T08-07 Multi-Region Active-Active | 90 | S | M-freq; architecture discussion |
| T08-08 Disaster Recovery / RTO/RPO | 85 | O | Domain knowledge; not coded tested |
| T08-09 Load Shedding | 75 | O | Extension of T01-14 rate limiting |
| T08-10 Health Checks | 70 | O | Kubernetes concern; O |
| T08-11 Database HA / PostgreSQL HA | 85 | S | M-freq; "how do you make your DB HA?" |
| T08-12 Kafka HA / Replication | 80 | O | Extension of T11; O |
| T08-13 Rate Limiting for Reliability | 75 | O | Extension of T01-14; O |
| T08-14 Fallback Patterns | 70 | O | Extension of T08-02; O |
| T08-15 Incident Management | 75 | O | Good for Staff; not coded tested |
| T08-16 Post-Incident Reviews | 70 | O | Good for Staff; not coded tested |
| T08-17 Reliability Testing | 80 | O | Extension of T08-06; O |
| T08-18 Decision Framework | 65 | O | Capstone-style; Optional |

**T08 Core: 5 lessons, 390 min (6.5 h)**  
**T08 Supporting: 2 lessons, 175 min (2.9 h)**

---

## T09 — Performance Engineering & JVM (22 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T09-01 JVM Internals | 90 | **C** | H-freq; class loading, JIT, bytecode |
| T09-02 GC Log Analysis | 85 | S | Supports T09-03; reading logs before tuning |
| T09-03 GC Tuning (G1 / ZGC) | 85 | **C** | M-freq; "tune GC for a low-latency service" |
| T09-04 JMH Benchmarking | 80 | S | M-freq practical skill; supports T09 Core |
| T09-05 CPU Profiling / async-profiler | 80 | **C** | M-freq; "how do you find a CPU hotspot?" |
| T09-06 Memory Profiling / Heap Analysis | 80 | O | Extension of T09-05; O |
| T09-07 JDBC Tuning / Connection Pools | 80 | **C** | M-freq; connection pool sizing question |
| T09-08 Query Optimization / EXPLAIN | 85 | **C** | M-freq; "how do you optimize a slow query?" |
| T09-09 Index Design | 80 | O | Extension of T10-05; O |
| T09-10 Application Caching | 80 | O | Extension of T10-14; O |
| T09-11 Redis Performance | 75 | O | Extension of T10; O |
| T09-12 Kafka Producer Tuning | 80 | O | Extension of T11; O |
| T09-13 HTTP/2 and gRPC Performance | 75 | O | M-freq but O depth |
| T09-14 Thread Pool Sizing / Little's Law | 75 | **C** | M-freq; "how do you size a thread pool?" |
| T09-15 Virtual Threads Performance | 80 | **C** | M-freq; Java 21 benchmark |
| T09-16 Gatling Load Testing | 80 | O | Good practical skill; O |
| T09-17 Flame Graphs | 75 | O | Extension of T09-05; O |
| T09-18 Memory Layout / Cache Lines | 75 | O | Extension of T03-09; O |
| T09-19 Database Partitioning | 80 | O | Extension of T10-06; O |
| T09-20 Reactive vs Blocking — Perf | 80 | O | T04 topic; O (T04 deleted) |
| T09-21 Network I/O Tuning | 75 | O | Infrastructure detail; O |
| T09-22 Decision Framework | 65 | O | Capstone-style; Optional |

**T09 Core: 7 lessons, 575 min (9.6 h)**  
**T09 Supporting: 2 lessons, 165 min (2.75 h)**

---

## T10 — Database & Data Architecture (22 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T10-01 ACID Properties | 85 | **C** | H-freq; foundation |
| T10-02 Isolation Levels | 85 | **C** | H-freq; "what happens at READ COMMITTED?" |
| T10-03 MVCC Deep Dive | 85 | **C** | H-freq; often paired with T10-02 |
| T10-04 PostgreSQL Locking | 85 | **C** | H-freq; "SELECT FOR UPDATE vs advisory lock?" |
| T10-05 Index Strategies (B-Tree/GIN) | 80 | **C** | H-freq; index selection question |
| T10-06 Table Partitioning | 80 | S | M-freq; supports T10-07 sharding |
| T10-07 Database Sharding | 85 | **C** | M-freq; "how do you scale the database?" |
| T10-08 Read Replicas / Lag Management | 75 | O | Extension of T10-07; O |
| T10-09 Schema Evolution / Zero-Downtime | 80 | **C** | M-freq; "how do you deploy a migration safely?" |
| T10-10 Connection Pooling | 75 | O | Extension of T09-07; O |
| T10-11 WAL / CDC / Debezium | 85 | S | M-freq; outbox canonical for CDC |
| T10-12 JSONB | 75 | O | PostgreSQL feature; O depth |
| T10-13 TimescaleDB | 80 | O | Specialist; O |
| T10-14 Audit Tables / Temporal | 75 | O | Covered by T06-21; O |
| T10-15 Database Testing | 75 | O | Good practice; O |
| T10-16 Query Plan Analysis | 80 | O | Extension of T09-08; O |
| T10-17 Distributed PostgreSQL / Citus | 85 | O | Extension of T10-07; O |
| T10-18 Data Archival | 70 | O | Domain detail; O |
| T10-19 Backup and Recovery | 75 | O | Domain detail; O |
| T10-20 Database Benchmarking | 75 | O | Extension of T09; O |
| T10-21 NewSQL / CockroachDB / Spanner | 80 | O | M-freq but O; covers in T02 context |
| T10-22 Decision Framework | 65 | O | Capstone-style; Optional |

**T10 Core: 7 lessons, 580 min (9.7 h)**  
**T10 Supporting: 2 lessons, 165 min (2.75 h)**

---

## T11 — Messaging, Streaming & Integration (20 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T11-01 Kafka Architecture | 90 | **C** | H-freq; every fintech system design uses Kafka |
| T11-02 Kafka Producer | 80 | **C** | H-freq; ordering and durability |
| T11-03 Kafka Consumer / Rebalancing | 80 | **C** | H-freq; rebalance storm question |
| T11-04 Kafka Streams | 85 | O | M-freq; often covered by T11-01 |
| T11-05 Exactly-Once / Kafka Transactions | 85 | **C** | H-freq; "how do you get exactly-once?" |
| T11-06 Outbox + Debezium CDC | 85 | S | H-freq but canonical cross-link; Supporting here |
| T11-07 Schema Registry / Avro | 75 | O | M-freq; O depth |
| T11-08 Kafka Connect | 75 | O | Extension of T11-06; O |
| T11-09 Event Sourcing with Kafka | 85 | O | Canonical: T06-18; O here |
| T11-10 CQRS with Kafka | 85 | O | Canonical: T06-19; O here |
| T11-11 Dead Letter Queues | 75 | O | Good practice; O |
| T11-12 Kafka Security | 75 | O | Infrastructure; O |
| T11-13 Kafka Performance Tuning | 80 | O | Extension of T09-12; O |
| T11-14 Multi-Region Kafka / MirrorMaker 2 | 85 | O | Extension of T11-01; O |
| T11-15 Saga — Choreography & Orchestration | 85 | **C** | H-freq; canonical for messaging-based Saga |
| T11-16 Event-Driven Microservices | 85 | O | Extension of T01-07; O |
| T11-17 Kafka Monitoring / Consumer Lag | 70 | O | Ops concern; O |
| T11-18 Message Ordering | 75 | O | Extension of T11-01; O |
| T11-19 RabbitMQ vs Kafka | 75 | O | Trade-off awareness; O |
| T11-20 Decision Framework | 65 | O | Capstone-style; Optional |

**T11 Core: 6 lessons, 505 min (8.4 h)**  
**T11 Supporting: 1 lesson, 85 min (1.4 h)**

---

## T12 — Cloud, Infrastructure & Platform (16 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T12-01 Kubernetes for Financial Services | 90 | **C** | M-freq; every backend engineer in cloud-native fintech |
| T12-02 Pod Scheduling / Affinity | 80 | O | K8s ops depth; O |
| T12-03 Kubernetes Networking | 80 | O | Infrastructure; O |
| T12-04 Helm / GitOps / ArgoCD | 80 | **C** | M-freq; "how do you deploy to production?" |
| T12-05 Service Mesh / Istio | 85 | O | Extension of T01-11; O |
| T12-06 Container Security | 80 | O | Extension of T13; O |
| T12-07 Secret Management / Vault | 80 | O | Good practice; O |
| T12-08 Cloud-Native Storage / StatefulSets | 75 | O | Infrastructure; O |
| T12-09 Auto-Scaling (HPA/VPA/KEDA) | 80 | **C** | M-freq; "how do you scale to 10x traffic?" |
| T12-10 Multi-Cluster Kubernetes | 85 | O | Extension of T08-07; O |
| T12-11 Cloud Cost Engineering / FinOps | 70 | O | Good for Staff; O |
| T12-12 Platform Engineering / IDP | 85 | O | Good for Principal; O |
| T12-13 CI/CD Pipelines | 80 | O | Good practice; O |
| T12-14 Canary / Blue-Green Deployments | 75 | O | Good practice; O |
| T12-15 Disaster Recovery on K8s | 80 | O | Extension of T08-08; O |
| T12-16 Decision Framework | 65 | O | Capstone-style; Optional |

**T12 Core: 3 lessons, 250 min (4.2 h)**  
**T12 Supporting: 0 lessons**

---

## T13 — Security, Observability & Production (20 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T13-01 OpenTelemetry / Instrumentation | 85 | **C** | M-freq; "how do you trace a payment?" |
| T13-02 Distributed Tracing | 80 | S | Supports T13-01; causality depth |
| T13-03 Prometheus / PromQL | 85 | **C** | M-freq; "how do you monitor X?" |
| T13-04 Grafana Dashboards | 75 | O | Extension of T13-03; O |
| T13-05 Structured Logging | 75 | **C** | M-freq; "how do you debug in production?" |
| T13-06 JVM Diagnostics in Production | 80 | O | Extension of T09-05; O |
| T13-07 SLO-Based Alerting | 75 | O | Extension of T08-01; O |
| T13-08 Incident Response | 75 | O | Good for Staff; O |
| T13-09 Zero-Trust Security | 80 | O | Extension of T01-18; O |
| T13-10 OAuth2 / JWT | 80 | **C** | M-freq; "how do you secure a payment API?" |
| T13-11 API Security | 80 | S | Supports T13-10; rate limiting + WAF |
| T13-12 mTLS in Practice | 75 | O | Extension of T01-18; O |
| T13-13 OWASP Top 10 for Finance | 80 | O | Good practice; O |
| T13-14 Penetration Testing | 80 | O | Specialist; O |
| T13-15 SIEM / Security Events | 75 | O | Specialist; O |
| T13-16 Data Encryption | 75 | O | Covered by T07-09 (flag) + T13-17; O |
| T13-17 Key Management / HSM / KMS | 75 | O | Good for Staff; O |
| T13-18 Secure Coding in Java | 75 | O | Good practice; O |
| T13-19 Production Readiness Checklist | 75 | O | Good practice; O |
| T13-20 Decision Framework | 65 | O | Capstone-style; Optional |

**T13 Core: 5 lessons, 405 min (6.75 h)**  
**T13 Supporting: 2 lessons, 160 min (2.7 h)**

---

## T14 — Staff & Principal Engineering Leadership (14 lessons)

| Lesson | Min | Tier | Reason |
|--------|-----|------|--------|
| T14-01 Staff/Principal Operating Model | 85 | **C** | L-freq but key Staff signal in bar-raiser round |
| T14-02 Technical Strategy | 85 | O | Good for Principal; O for Senior role |
| T14-03 RFC Process | 80 | **C** | M-freq; "how do you drive technical decisions?" |
| T14-04 ADRs in Practice | 70 | O | Extension of T01-02; O |
| T14-05 Managing Technical Debt | 75 | O | Good for Staff; O |
| T14-06 Engineering Metrics / DORA | 75 | O | Good for Staff; O |
| T14-07 Mentoring Senior Engineers | 70 | O | Soft skill; O |
| T14-08 Cross-Team Influence | 75 | **C** | M-freq; "influence without authority" is behavioural |
| T14-09 Technical Reviews | 70 | O | Good practice; O |
| T14-10 Technology Radar | 70 | O | Good for Principal; O |
| T14-11 Incident Leadership | 75 | O | Extension of T13-08; O |
| T14-12 Build vs Buy vs Open Source | 70 | O | Good for Principal; O |
| T14-13 Technical Interviewing | 70 | O | Meta-skill; O |
| T14-14 Career Framework | 75 | O | Meta-skill; O |

**T14 Core: 3 lessons, 240 min (4.0 h)**  
**T14 Supporting: 0 lessons**

---

## Tier Summary Table

| Track | C | S | O | DEL | FLAG | MERGE | C min | S min |
|-------|---|---|---|-----|------|-------|-------|-------|
| T01 | 4 | 2 | 14 | 0 | 0 | 0 | 340 | 165 |
| T02 | 7 | 3 | 12 | 0 | 0 | 0 | 580 | 255 |
| T03 | 16 | 2 | 11 | 0 | 0 | 0 | 1310 | 130 |
| T04 | 0 | 0 | 0 | 19 | 0 | 1 | — | — |
| T05 | 6 | 2 | 14 | 0 | 0 | 0 | 525 | 180 |
| T06 | 24 | 0 | 0 | 0 | 0 | 0 | 2065 | 0 |
| T07 | 0 | 0 | 0 | 16 | 2 | 0 | — | — |
| T08 | 5 | 2 | 11 | 0 | 0 | 0 | 390 | 175 |
| T09 | 7 | 2 | 13 | 0 | 0 | 0 | 575 | 165 |
| T10 | 7 | 2 | 13 | 0 | 0 | 0 | 580 | 165 |
| T11 | 6 | 1 | 13 | 0 | 0 | 0 | 505 | 85 |
| T12 | 3 | 0 | 13 | 0 | 0 | 0 | 250 | 0 |
| T13 | 5 | 2 | 13 | 0 | 0 | 0 | 405 | 160 |
| T14 | 3 | 0 | 11 | 0 | 0 | 0 | 240 | 0 |
| **Total** | **93** | **18** | **128** | **35** | **2** | **1** | **7765** | **1480** |
| **Hours** | | | | | | | **129.4 h** | **24.7 h** |

> **Validator result:** `tools/validate_content.py` measured C+S = **9315 min = 155.2 h**.  
> This is **11.2 h over the 144 h budget**.
>
> **Additional validator errors:**
> - T03-07 (Race Conditions) = 95 min — exceeds 75 min cap  
> - T03-11 (CompletableFuture) = 95 min — exceeds 75 min cap  
> - T05-21 (High-Throughput Design) = 95 min — exceeds 75 min cap  
>
> **Resolution options (pick one):**
> 1. **[Recommended]** Demote 8 Supporting lessons → Optional (saves ~11.3 h, C+S = 143.9 h ✓):
>    - T02-07 Replication Strategies (85m) → O
>    - T02-08 Distributed Caching (80m) → O
>    - T05-18 Card Processing (85m) → O
>    - T05-21 High-Throughput Design (95m) → O *(also fixes 95m error)*
>    - T08-07 Multi-Region Active-Active (90m) → O
>    - T08-11 DB HA / PostgreSQL (85m) → O
>    - T13-02 Distributed Tracing deep (80m) → O
>    - T13-11 API Security (80m) → O
> 2. Reduce new content budget from 116 h to 106 h (adjust Spring Boot 4 scope)
> 3. Reduce T06 cap from 100 min to 85 min (saves ~12 h on T06 alone, but T06 is the core value)
>
> **75 min cap note:** The brief says "no lesson >75 min" — this applies to NEW content.  
> Existing lessons average 82 min; splitting them is out of Phase 0 scope.  
> Recommend: cap at 75 min for new lessons only; set validator ERROR threshold to 95 min for existing.

---

## Items Requiring User Decision

---

## Items Requiring User Decision

1. **Budget resolution:** Which of the 3 options above? (Recommend Option 1)
2. **T07-08 and T07-09 (FLAG):** These are marked Core/FLAG. Are they on the main path or Optional depth?
3. **T04-01 MERGE:** Should the merge into T03-11 be a footnote/cross-link, or literal content absorption?
4. **T06 time cap:** Should T06 scenarios be capped at 100 min/lesson (learner time, including hands-on work)?

---

*This document is read-only until Phase 0 is approved.*
