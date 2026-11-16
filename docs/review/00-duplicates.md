# Duplicate & Orphan Folder Decisions

> Generated: 2026-11-12  
> **READ-ONLY until Phase 0 approved.**  
> 40 lesson directories on disk do not map 1:1 with manifest registrations.

---

## Decision Rule

- **KEEP** = folder path matches `_track.json` `path` field exactly → canonical; keep this one
- **DELETE** = folder exists on disk but its path is not referenced in any `_track.json` → safe to delete
- An "orphan" has no frontmatter or is a stub directory

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| Duplicate pairs (two paths, one ID registered) | 26 | Keep canonical; delete extra |
| Orphans (no manifest registration, stub content) | 14 | Delete |
| **Total folders to remove** | **40** | — |

---

## T01 — Advanced Software Architecture

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-01-architecture/lesson-04-ddd-strategic/` | `track-01-architecture/lesson-04-ddd/` | Old short name |
| `track-01-architecture/lesson-07-event-driven/` | `track-01-architecture/lesson-07-eda/` | Old acronym name |

---

## T02 — Distributed Systems Engineering

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-02-distributed-systems/lesson-06-two-phase-commit/` | `track-02-distributed-systems/lesson-06-2pc/` | Old abbreviation |
| `track-02-distributed-systems/lesson-14-idempotency/` | `track-02-distributed-systems/lesson-14-idempotency-distributed/` | Longer duplicate name |

---

## T07 — Financial Crime (all orphans — entire track deleted)

| Path (DELETE) | Notes |
|--------------|-------|
| `track-07-financial-crime/lesson-01-aml-framework/` | Orphan in deleted track |
| `track-07-financial-crime/lesson-03-transaction-monitoring/` | Orphan |
| `track-07-financial-crime/lesson-10-risk-scoring/` | Orphan |

---

## T08 — High Availability & Resilience

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-08-reliability/lesson-02-circuit-breaker/` | `track-08-reliability/lesson-02-circuit-breaker-pattern/` | Longer duplicate |
| `track-08-reliability/lesson-07-multi-region/` | `track-08-reliability/lesson-07-active-active/` | Alternate name |
| `track-08-reliability/lesson-11-db-ha/` | `track-08-reliability/lesson-11-postgresql-ha/` | Alternate name |

---

## T09 — Performance Engineering

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-09-performance/lesson-03-gc-tuning/` | `track-09-performance/lesson-03-g1gc-zgc/` | Alternate name |
| `track-09-performance/lesson-05-cpu-profiling/` | `track-09-performance/lesson-05-async-profiler/` | Alternate name |
| `track-09-performance/lesson-14-thread-pool-sizing/` | `track-09-performance/lesson-14-littles-law/` | Alternate name |

---

## T10 — Database & Data Architecture

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-10-database/lesson-03-mvcc/` | `track-10-database/lesson-03-multi-version-concurrency/` | Full name duplicate |
| `track-10-database/lesson-07-sharding/` | `track-10-database/lesson-07-database-sharding/` | Prefixed duplicate |
| `track-10-database/lesson-11-wal-cdc/` | `track-10-database/lesson-11-debezium/` | Alternate name |
| `track-10-database/lesson-11-cdc/` | — | Orphan (no ID match) |

---

## T11 — Messaging, Streaming & Integration

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-11-messaging/lesson-05-exactly-once/` | `track-11-messaging/lesson-05-eos/` | Acronym duplicate |
| `track-11-messaging/lesson-06-outbox-debezium/` | `track-11-messaging/lesson-06-transactional-outbox/` | Alternate name |
| `track-11-messaging/lesson-15-saga/` | `track-11-messaging/lesson-15-saga-pattern/` | Longer duplicate |

---

## T12 — Cloud, Infrastructure & Platform

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-12-cloud-platform/lesson-04-helm-gitops/` | `track-12-cloud-platform/lesson-04-argocd/` | Alternate name |
| `track-12-cloud-platform/lesson-09-autoscaling/` | `track-12-cloud-platform/lesson-09-hpa-vpa/` | Alternate name |

---

## T13 — Security, Observability & Production

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-13-security-observability/lesson-01-opentelemetry/` | `track-13-security-observability/lesson-01-otel/` | Acronym duplicate |
| `track-13-security-observability/lesson-10-oauth2-jwt/` | `track-13-security-observability/lesson-10-jwt/` | Shorter duplicate |

---

## T14 — Leadership

| Registered path (KEEP) | Extra path (DELETE) | Notes |
|------------------------|---------------------|-------|
| `track-14-leadership/lesson-03-rfc-process/` | `track-14-leadership/lesson-03-technical-rfcs/` | Alternate name |
| `track-14-leadership/lesson-08-cross-team-influence/` | `track-14-leadership/lesson-08-influence/` | Shorter duplicate |

---

## Orphan Stubs (no manifest registration, no meaningful content)

These directories contain only an empty `index.md` or no file at all:

| Path (DELETE) | Track |
|--------------|-------|
| `track-01-architecture/lesson-21-draft/` | T01 |
| `track-02-distributed-systems/lesson-23-wip/` | T02 |
| `track-03-concurrency/lesson-30-draft/` | T03 |
| `track-05-banking-systems/lesson-23-draft/` | T05 |
| `track-06-transaction-integrity/lesson-25-wip/` | T06 |
| `track-08-reliability/lesson-19-draft/` | T08 |
| `track-09-performance/lesson-23-wip/` | T09 |
| `track-10-database/lesson-23-draft/` | T10 |
| `track-11-messaging/lesson-21-draft/` | T11 |
| `track-13-security-observability/lesson-21-wip/` | T13 |
| `track-14-leadership/lesson-15-draft/` | T14 |

---

## Execution Plan (after approval)

```bash
# Dry-run first (all DELETE paths)
# Then run with rm -rf after confirmation

# Duplicate extras
rm -rf docs/content/tracks/track-01-architecture/lesson-04-ddd/
rm -rf docs/content/tracks/track-01-architecture/lesson-07-eda/
# ... (full list in Phase 1 cleanup script)

# Orphan stubs
rm -rf docs/content/tracks/track-01-architecture/lesson-21-draft/
# ... (full list in Phase 1 cleanup script)
```

**A cleanup shell script will be generated and shown for review before execution.**

---

*This document is read-only until Phase 0 is approved.*
