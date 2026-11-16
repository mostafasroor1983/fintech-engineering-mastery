# Target Profile — Senior Fintech Backend Engineer

> **Curriculum design target:** Staff/Senior Software Engineer at Revolut, Wise, Monzo, Stripe, N26, Nubank, Klarna, or equivalent.
> This document drives tier decisions and gap analysis in Phase 0.

---

## Role Archetype

**Title:** Senior / Staff Backend Engineer — Payments, Ledger, or Core Platform  
**Company tier:** Revolut-class (Series D+, 1 000–10 000 engineers, regulated payment institution)  
**Team:** Payments processing, financial ledger, risk/fraud, or platform  
**YoE at target:** 5–10 years, majority in JVM languages on distributed systems  

---

## Competency Matrix — Frequency × Depth

Legend: **H** = almost every interview at this level, **M** = common, **L** = occasional

| # | Competency | Freq | Interview format | Primary tracks |
|---|-----------|------|-----------------|----------------|
| 1 | Distributed transaction design (2PC, Saga, outbox) | **H** | System design, deep-dive | T06, T02 |
| 2 | Idempotency & exactly-once semantics | **H** | System design, coding | T06, T11 |
| 3 | Java concurrency — happens-before, locks, `volatile` | **H** | Deep-dive, whiteboard | T03 |
| 4 | ACID vs BASE, MVCC, isolation levels | **H** | Deep-dive | T10, T06 |
| 5 | Kafka — partitions, consumer groups, offset management | **H** | System design, deep-dive | T11 |
| 6 | Microservice resilience — circuit breaker, bulkhead, retry | **H** | System design | T08, T02 |
| 7 | High-throughput API design — rate limiting, back-pressure | **H** | System design | T01, T08 |
| 8 | Payment rail architecture (SWIFT, ISO 20022, FPS) | **M** | System design | T05 |
| 9 | Ledger double-entry, reconciliation | **M** | System design, coding | T06 |
| 10 | Virtual threads (Project Loom) & structured concurrency | **M** | Deep-dive | T03 |
| 11 | JVM GC tuning — G1, ZGC, heap analysis | **M** | Deep-dive | T09 |
| 12 | Database sharding, partitioning, read replicas | **M** | System design | T10 |
| 13 | Event sourcing & CQRS | **M** | System design | T06 |
| 14 | Redis — distributed locks, caching patterns | **M** | System design | T10, T03 |
| 15 | Kubernetes — HPA, resource quotas, disruption budgets | **M** | Ops/design | T12 |
| 16 | Spring Boot internals — auto-config, beans, context | **M** | Deep-dive | T01 |
| 17 | Observability — distributed tracing, metrics, alerting | **M** | Design | T13 |
| 18 | Consensus (Raft/Paxos) — why it matters for leader election | **L** | Deep-dive | T02 |
| 19 | FX & treasury concepts | **L** | Domain knowledge | T05 |
| 20 | Staff-level influence — RFC process, tech strategy, mentoring | **L** | Behavioural | T14 |
| 21 | PCI DSS / GDPR at architecture level | **L** | System design | T07 (flag) |
| 22 | CQRS read-model optimisation | **L** | System design | T06 |

---

## Common Interview Patterns at Revolut-Class Companies

### Round structure (typical 5–6 round loop)
1. **Technical screen** (45 min) — coding + LC-medium; occasionally a concurrency question
2. **System design I** — payment/transaction system (ledger, idempotency, Saga)
3. **System design II** — high-throughput data pipeline (Kafka, back-pressure, fanout)
4. **Deep-dive / debugging** — JVM internals, distributed systems failure scenario
5. **Behavioural / values** — incident ownership, cross-team influence
6. **Bar-raiser / principal** — architecture trade-offs, failure modes

### High-signal topics (appear in ≥60% of reported loops)
- Design a payment processing service (idempotency, ledger, Saga)
- Design a fraud detection pipeline (stream processing, feature store)
- Explain how you would implement a distributed lock
- Kafka consumer group rebalance — what goes wrong, how to fix it
- Walk through a production incident involving race conditions or split-brain
- MVCC vs 2PL — when does each cause problems?

### Differentiators at Staff level
- Can articulate **why** a design decision (not just what)
- Familiar with regulatory constraints (PCI DSS tokenisation, GDPR article 17)
- Has a view on cost of coordination vs. availability trade-off
- Has dealt with multi-currency ledger precision issues

---

## Gaps vs. Standard "Distributed Systems" Curricula

The following topics appear in fintech loops but are **under-represented** in generic distributed-systems curricula:

| Gap | Missing depth | Planned content |
|-----|--------------|-----------------|
| ISO 20022 message schema | Zero lessons | T05 refresh |
| Spring Boot 4 / virtual-thread config | Outdated | New Spring Boot 4 module |
| Outbox pattern + Debezium CDC | One lesson (T11-06) | Keep + cross-link |
| Idempotency key design (database-level) | Partial (T06-12) | Deepen + coding challenge |
| ZGC tuning for latency-sensitive services | Partial (T09) | Flag for update |
| Structured concurrency (JEP 453) | Partial (T03-28,29) | Keep + deepen |
| System design mock — full end-to-end | No dedicated module | New System Design track (22h) |
| 90-day interview-to-offer playbook | None | New (2h) |

---

## Out of Scope (explicitly excluded)

- Front-end / mobile engineering
- Data science / ML (feature engineering, model serving)
- Financial crime compliance as a career (AML investigations, SAR filing)
- Pure DevOps / SRE tracks (K8s covered only where relevant to backend design)
- Low-code / no-code tooling

---

*Last updated: 2026-11-12. Next review: after Phase 1 content update.*
