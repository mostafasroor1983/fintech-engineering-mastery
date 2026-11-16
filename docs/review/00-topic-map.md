# Topic Map — Cross-Track Coverage

> Generated: 2026-11-12  
> Shows which lessons cover each high-value topic and identifies the canonical home.
> Used to find duplication, gaps, and cross-link opportunities.

---

## How to Read This Table

- **Canonical home** = the one lesson that owns the topic (others cross-link to it)
- **Coverage** = all lesson IDs that touch the topic
- **Gap** = "—" means no existing lesson; new content needed

---

## High-Priority Topics (H-frequency in target profile)

| # | Topic | Canonical home | Also covered in | Gap? |
|---|-------|---------------|-----------------|------|
| 1 | Saga pattern (choreography + orchestration) | T06-14 | T02-18, T05-12 | No |
| 2 | Outbox pattern + Debezium CDC | T11-06 | T06-13 | No |
| 3 | Idempotency key design | T06-12 | T08-07 | Needs coding challenge |
| 4 | Exactly-once semantics (Kafka) | T11-10 | T06-12 | No |
| 5 | Distributed locking (Redis, DB) | T03-18 | T10-14, T06-11 | No |
| 6 | 2PC vs Saga trade-offs | T06-15 | T02-17 | No |
| 7 | Event sourcing | T06-18 | T02-20 | No |
| 8 | CQRS read-model | T06-19 | T02-21 | No |
| 9 | Double-entry ledger | T06-01 | T05-08 | No |
| 10 | Reconciliation engine design | T06-20 | T05-10 | No |
| 11 | Java Memory Model / happens-before | T03-02 | T03-07 | No |
| 12 | `volatile` keyword semantics | T03-03 | T03-02 | No |
| 13 | Locks: intrinsic vs `ReentrantLock` | T03-05 | T03-06 | No |
| 14 | `java.util.concurrent` — `ConcurrentHashMap`, queues | T03-09 | T03-10 | No |
| 15 | Virtual threads (Project Loom) | T03-28 | T04-01 (merge) | No |
| 16 | Structured concurrency (JEP 453) | T03-29 | — | Needs depth |
| 17 | Circuit breaker (Resilience4j) | T08-02 | T02-14 | No |
| 18 | Bulkhead / rate limiting | T08-04 | T01-15 | No |
| 19 | Kafka consumer group rebalance | T11-08 | — | No |
| 20 | Kafka partition assignment & ordering | T11-05 | T11-08 | No |
| 21 | MVCC & isolation levels | T10-03 | T06-05 | No |
| 22 | Database sharding strategies | T10-07 | T02-08 | No |
| 23 | B-tree vs LSM-tree indexes | T10-02 | T09-14 | No |
| 24 | G1 / ZGC / Shenandoah tuning | T09-17 | T09-18 | ZGC flags outdated |
| 25 | JVM heap / off-heap / GC analysis | T09-15 | T09-16 | No |
| 26 | Distributed tracing (OpenTelemetry) | T13-05 | T13-06 | No |
| 27 | Spring Boot auto-configuration | T01-03 | — | Needs SB4 update |
| 28 | Spring Security + OAuth2 | T13-12 | T01-18 | Needs SB4 update |

---

## Medium-Priority Topics (M-frequency)

| # | Topic | Canonical home | Also covered in | Gap? |
|---|-------|---------------|-----------------|------|
| 29 | FIX protocol | T05-04 | — | Low priority |
| 30 | SWIFT / ISO 20022 | T05-05 | T05-06 | Needs refresh |
| 31 | FPS / CHAPS / SEPA rails | T05-07 | T05-08 | No |
| 32 | Multi-currency precision | T06-02 | T05-09 | No |
| 33 | FX rate management | T05-10 | T06-02 | No |
| 34 | Raft consensus | T02-06 | T02-07 | No |
| 35 | Leader election patterns | T02-09 | T03-18 | No |
| 36 | Read-your-writes consistency | T02-12 | T10-05 | No |
| 37 | Write-ahead log (WAL) | T10-04 | T06-07 | No |
| 38 | pg_partman / TimescaleDB | T10-11 | — | No |
| 39 | Redis cache-aside / write-through | T10-14 | — | No |
| 40 | Kubernetes HPA & VPA | T12-07 | T12-08 | No |
| 41 | Service mesh (Istio) | T12-11 | T13-08 | No |
| 42 | Log aggregation (ELK / Loki) | T13-07 | — | No |
| 43 | Alerting & runbooks | T13-10 | — | No |

---

## Low-Priority / Flagged Topics

| # | Topic | Canonical home | Note |
|---|-------|---------------|------|
| 44 | GDPR data deletion / right-to-erasure | T07-08 | FLAG — keep but review |
| 45 | PCI DSS tokenisation architecture | T07-09 | FLAG — keep but review |
| 46 | AML typologies (Layering, Smurfing) | T07-02 | DELETE (T07 track) |
| 47 | Sanctions screening | T07-05 | DELETE (T07 track) |
| 48 | Reactive streams (Project Reactor) | T04-05 | DELETE (T04 track) |
| 49 | R2DBC | T04-12 | DELETE (T04 track) |
| 50 | WebFlux routing | T04-08 | DELETE (T04 track) |

---

## Content Duplication Map

Topics covered in 3+ lessons — flag for consolidation:

| Topic | Covered in | Action |
|-------|-----------|--------|
| Saga pattern | T06-14, T02-18, T05-12 | T06-14 canonical; others cross-link only |
| Idempotency | T06-12, T08-07, T11-07 | T06-12 canonical; trim others |
| Circuit breaker | T08-02, T02-14, T12-03 | T08-02 canonical |
| Concurrency basics | T03-01..04, T04-02 | T03 canonical; T04-02 → delete with T04 |
| Event sourcing | T06-18, T02-20, T04-19 | T06-18 canonical; T04-19 → delete with T04 |

---

## Gap Summary

| Gap | Priority | Phase |
|-----|----------|-------|
| Spring Boot 4 auto-configuration deep-dive | P1 | Phase 1 |
| Structured concurrency coding patterns | P1 | Phase 1 |
| ISO 20022 schema refresh | P2 | Phase 2 |
| ZGC JDK 21 flag updates | P2 | Phase 2 |
| System Design module (payment + pipeline) | P1 | Phase 2 |
| Interview Playbook (behavioural + patterns) | P1 | Phase 3 |

---

*This document is read-only until Phase 0 is approved.*
