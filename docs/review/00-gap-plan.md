# Gap Plan — New Content Required

> Generated: 2026-11-12  
> **READ-ONLY until Phase 0 approved.**  
> Specifies all new lessons, modules, and rewrites needed to complete the 30-week curriculum.

---

## Overview

| Phase | Work | Hours (learner) | Priority |
|-------|------|-----------------|----------|
| Phase 1 | Spring Boot 4 upgrade module | 24 h | P1 |
| Phase 2 | System Design module | 22 h | P1 |
| Phase 3 | Capstone project rewrites | 60 h | P2 |
| Phase 4 | Interview Playbook + 90-day plan | 10 h | P1 |
| **Total new** | | **116 h** | |

---

## Phase 1 — Spring Boot 4 Upgrade Module

**Purpose:** Cover Spring Boot 4 / Spring Framework 7 / Java 21 changes that invalidate code in existing Core lessons.

**Location:** New track `track-15-spring-boot-4/` (or new lessons added to T01)

### New lessons to create (8 lessons, ~24 h)

| # | Title | Min | Priority | Notes |
|---|-------|-----|----------|-------|
| SB4-01 | Spring Boot 4 — What Changed from 3.x | 90 | P1 | Auto-config, GraalVM, AOT |
| SB4-02 | Spring Framework 7 — New Baseline Features | 90 | P1 | Jakarta EE 11, HTTP interfaces |
| SB4-03 | Virtual Thread Integration in Spring Boot 4 | 100 | P1 | Loom + Tomcat/Undertow config |
| SB4-04 | Spring Data 4 — JDBC, JPA, Redis changes | 90 | P1 | Spring Data repository changes |
| SB4-05 | Spring Security 7 — OAuth2 and JWT | 90 | P1 | SecurityFilterChain, method security |
| SB4-06 | Spring Kafka 4 — Configuration and EOS | 90 | P1 | Kafka 4.x client, EOS config |
| SB4-07 | Migrating Spring Boot 3.x Apps to 4.x | 100 | P1 | Migration guide, breaking changes |
| SB4-08 | Spring Boot 4 Testing — Slices and Testcontainers | 90 | P1 | @DataJpaTest, @KafkaTest, TC 1.20+ |

**Sub-total: 8 lessons, 740 min (12.3 h learner content; 24 h with hands-on labs)**

### Existing lessons requiring Spring Boot 4 code update (not new lessons — inline update)

| Lesson | Change needed |
|--------|--------------|
| T01-03 C4 / T01-04 DDD / T01-05 DDD | Spring Boot 4 POM examples |
| T08-02 Circuit Breaker | Resilience4j 3.x + SB4 starter |
| T08-04 Retry | Spring Retry 3.x API |
| T09-07 JDBC Tuning | HikariCP 6.x defaults in SB4 |
| T10-09 Schema Evolution | Flyway 11.x + SB4 auto-config |
| T13-01 OpenTelemetry | OTel Java agent 2.x + SB4 |
| T13-10 OAuth2/JWT | Spring Security 7 config style |
| T11-01 Kafka Architecture | Kafka 4.x KRaft-only config |

---

## Phase 2 — System Design Module

**Purpose:** Dedicated system design practice with full end-to-end walkthroughs for the 2 most common fintech design questions.

**Location:** New track `track-16-system-design/` or standalone `content/system-design/`

### New lessons to create (8 lessons, ~22 h)

| # | Title | Min | Notes |
|---|-------|-----|-------|
| SD-01 | System Design Framework for Fintech Interviews | 90 | RADIO framework adapted for payments |
| SD-02 | Design a Payment Processing Service — Part 1 | 100 | Requirements, API, data model |
| SD-03 | Design a Payment Processing Service — Part 2 | 100 | Idempotency, Saga, Kafka integration |
| SD-04 | Design a Fraud Detection Pipeline | 100 | Stream processing, feature store, latency |
| SD-05 | Design a Financial Ledger at Scale | 100 | Sharding, event sourcing, reconciliation |
| SD-06 | Design a Rate Limiter for a Payment API | 90 | Token bucket, Redis, distributed |
| SD-07 | Whiteboard Practice — 10 Common Fintech Problems | 90 | Problem set with model answers |
| SD-08 | System Design Mock Interview Guide | 60 | Evaluator rubric, self-assessment |

**Sub-total: 8 lessons, 730 min (12.2 h learner content; 22 h with practice time)**

---

## Phase 3 — Capstone Project Rewrites

**Purpose:** All 6 existing capstones need rewriting to target Spring Boot 4, Java 21, and Revolut-class production standards. Add interview debrief section to each.

### Capstone rewrites (6 capstones, ~60 h learner time)

| Capstone | Current state | Required changes | Hours |
|----------|--------------|-----------------|-------|
| C1 — High-Performance Payment Processor | Exists | SB4 + virtual threads + ZGC config | 10 h |
| C2 — Distributed Ledger System | Exists | SB4 + Kafka 4.x + Saga + event sourcing | 10 h |
| C3 — Fault-Tolerant Order Processing | Exists | SB4 + Resilience4j 3.x + K8s probes | 10 h |
| C4 — Real-Time Fraud Detection | Exists | SB4 + Kafka Streams + OTel 2.x | 10 h |
| C5 — Multi-Region Payment Platform | Exists | SB4 + K8s multi-region + ArgoCD | 10 h |
| C6 — Principal Engineer Portfolio | Exists | Update RFC template + ADR examples | 10 h |

**Each capstone must include:**
1. Updated implementation with Spring Boot 4 + Java 21
2. Production checklist (Dockerfile, K8s manifests, CI/CD)
3. Performance baseline (JMH / Gatling) with targets
4. Interview debrief: "What would you tell a Revolut interviewer about this?"
5. Common follow-up questions and model answers

---

## Phase 4 — Interview Playbook + 90-Day Plan

### Interview Playbook (8 h learner time)

**Location:** `content/playbook/interview-playbook.md` (single long lesson)

Sections:
1. How Revolut-class loops are structured (5–6 rounds, typical arc)
2. Cracking the System Design round (RADIO framework, common pitfalls)
3. The Deep-Dive / debugging round (JVM, distributed systems, incident replay)
4. Behavioural: STAR format for fintech-specific scenarios
5. 20 most common fintech interview questions + model answers
6. Code quality bar: what a "senior" Java solution looks like
7. Negotiation and offer evaluation

### 90-Day Interview-to-Offer Plan (2 h learner time)

**Location:** `content/playbook/90-day-plan.md`

Structure:
- **Days 1–30 (Foundation):** T06 all 24 lessons + T03 Core + T02 Core
- **Days 31–60 (Breadth):** T05 Core + T10 Core + T11 Core + T09 Core
- **Days 61–75 (New content):** SB4 module + SD module
- **Days 76–90 (Practice):** 2 capstones + system design mocks + playbook

---

## Gaps Deferred to Later Phases

| Gap | Reason deferred | Revisit |
|-----|----------------|---------|
| ISO 20022 pacs.008 deep-dive | Lower frequency; partial coverage in T05-07 | Phase 2 |
| ZGC JDK 21 flag updates (T09-03, T09-18) | Inline update, not new lesson | Phase 1 |
| pgvector / AI embedding in finance | Emerging; not yet interview standard | Phase 5+ |
| eBPF-based observability | Emerging; not yet standard | Phase 5+ |

---

*This document is read-only until Phase 0 is approved.*
