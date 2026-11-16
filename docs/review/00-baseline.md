# Baseline Inventory — Current Curriculum State

> Generated: 2026-11-12  
> Source: `docs/content/tracks/`, `docs/data/tracks.json`, all 14 `_track.json` manifests  
> This is a read-only snapshot. Nothing is changed until Phase 0 is approved.

---

## Summary

| Metric | Value |
|--------|-------|
| Tracks | 14 |
| Lessons (registered in manifests) | 287 |
| Total declared duration | 377.3 h |
| Decision Lab scenarios | 20 |
| Capstone projects | 6 |
| Concurrency Lab experiments | 25 |
| Search index documents | 352 |
| Duplicate / orphan lesson folders | 40 |

---

## Per-Track Inventory

| # | Track | Lessons | Declared h | Avg min/lesson | Notes |
|---|-------|---------|-----------|----------------|-------|
| T01 | Advanced Software Architecture | 20 | 30.0 h | 90 | Spring Boot 4 upgrade needed |
| T02 | Distributed Systems Engineering | 22 | 33.0 h | 90 | High interview relevance |
| T03 | Concurrency & Thread Safety | 29 | 42.0 h | 87 | Loom coverage good; keep intact |
| T04 | Async & Reactive Systems | 20 | 25.9 h | 78 | **DECISION: delete track** (content absorbed by T03/T11) |
| T05 | Banking & Financial Systems | 22 | 33.0 h | 90 | ISO 20022 needs refresh |
| T06 | Financial Transaction Integrity | 24 | 34.4 h | 86 | **ALL 24 = Core; ≤40h cap** |
| T07 | Financial Crime, Compliance & Risk | 18 | 23.4 h | 78 | **DECISION: delete track** (flag T07-08, T07-09) |
| T08 | High Availability & Resilience | 18 | 27.0 h | 90 | Good coverage; trim Supporting |
| T09 | Performance Engineering & JVM | 22 | 33.0 h | 90 | ZGC lesson needs update |
| T10 | Database & Data Architecture | 22 | 33.0 h | 90 | Strong; trim Supporting |
| T11 | Messaging, Streaming & Integration | 20 | 30.0 h | 90 | Kafka depth good |
| T12 | Cloud, Infrastructure & Platform | 16 | 24.0 h | 90 | K8s lessons kept for backend context |
| T13 | Security, Observability & Production | 20 | 30.0 h | 90 | Observability = Core; security = Supporting |
| T14 | Staff & Principal Engineering Leadership | 14 | 21.0 h | 90 | Mostly Optional; 3 Core for Staff signal |
| **Total** | | **287** | **377.3 h** | | |

---

## Tier Summary (Phase 0 proposal)

| Tier | Symbol | Lessons | Hours | Description |
|------|--------|---------|-------|-------------|
| Core | C | 92 | 126.8 h | Must-do; highest interview frequency |
| Supporting | S | **13** | **~17 h** | Direct prereqs for Core; keep in main path |
| Optional | O | **144** | ~176 h | Available for depth; not on critical path |
| Delete | DEL | 35 | — | T04 + T07 (non-flagged) + orphaned lessons |
| Merge | MERGE | 1 | — | T04-01 → T03-11 intro section |
| Flag | FLAG | 2 | — | T07-08 (GDPR), T07-09 (PCI DSS) — keep, review content |

> **Note:** Starting Supporting tier from 71 lessons (92.8 h). Demoting ~58 to Optional to satisfy budget.

---

## Budget Reconciliation

```
Budget cap (main path)             260 h
─────────────────────────────────────────
New content (Phase 1–4)
  Spring Boot 4 upgrade module      24 h
  System Design module               22 h
  Capstone rewrites (6 × 10 h)      60 h
  Interview Playbook                  8 h
  90-day plan guide                   2 h
  Sub-total new                     116 h

Remaining for existing lessons    = 144 h
─────────────────────────────────────────
Existing Core   (92 lessons)       126.8 h
Existing Supporting (13 lessons)    ~17.2 h
  Sub-total existing C+S            144.0 h  ✓

Total main path                    260 h  ✓
─────────────────────────────────────────
Buffer / slack                      40 h
Grand total                        300 h  ✓
```

---

## Orphan / Duplicate Folders

40 lesson directories on disk do not map 1:1 with manifest registrations.
Full decision table in `00-duplicates.md`.

Short summary:
- **26 duplicates** — two folder names map to same registered lesson ID; keep the one matching `_track.json` path exactly, delete the other
- **14 orphans** — folder exists, no matching ID in any `_track.json`; stub files without frontmatter; safe to delete

---

## Technical Debt Flags

| Issue | Scope | Priority |
|-------|-------|----------|
| Spring Boot 3.x code throughout | T01, T02, T08, T09 | P1 — Phase 1 |
| Spring Framework 6.x imports | T01 | P1 |
| `@Autowired` field injection still used | T01, T05, T08 | P2 |
| Java 11 syntax in several T09 lessons | T09 | P2 |
| ISO 20022 schema (outdated SWIFT MT refs) | T05 | P2 |
| ZGC lesson references JDK 15 flags | T09-18 | P3 |

---

*This document is read-only until Phase 0 is approved.*
