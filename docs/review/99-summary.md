# Final report (status at 2026-11-13)

Nothing is committed: every change is in the working tree (`git status`: 189 renames, 86 deletions,
20 modifications, 19 new top-level paths). Uncommitted work that existed before was preserved: replaced
or removed files were archived under `docs/review/archive/` before any overwrite.

**Validator:** `python3 tools/validate_content.py` → `✓ All checks passed` (132 warnings, all "lesson over
75 min" on older lessons; see open items). **Tests:** `cd examples && mvn test` → 81 tests, 0 failures.
**Rendering:** all 272 lessons and 5 capstone pages render in headless Chrome with zero Mermaid or
JavaScript errors.

## 1. What was done, by phase

| Phase | Status | Where |
|---|---|---|
| 0 Evidence, inventory, budget | Done earlier (not re-done). Two Phase 0 outputs proved wrong: `00-duplicates.md` (did not match the disk) and `00-target-profile.md` (no URLs or dates; unsourced percentages). | `docs/review/00-*` |
| 1 Structure | **Done**: Tracks 04 and 07 deleted (before this session); 46 colliding/orphan folders resolved; tracks **renumbered contiguously 01–16** with `git mv`; every id, path and link remapped; Optional group shown on track pages. | `01-duplicates-resolved.md` |
| 2 De-duplicate, fact-check, clarity | **Partly**: fixes found by verification (diagrams, quizzes, data references, Track 14 tiers, Track 16). The systematic fact-check and template rewrite of the ~120 older Core/Supporting lessons is **not done**. | `03-corrections.md` |
| 3A Spring Boot 4 track | **Paused at your request.** 8 existing lessons kept; lesson 1–2 and 7 code started in `examples/track-13-web` (14 tests). Known wrong claims listed below. | |
| 3B System design | **Done (8 lessons, your "keep 8 + 8" choice)**: rewritten on RESHADED, with estimates, schema, diagrams, sequences, API, deep dives, failure tables, SLOs, pitch and graded follow-ups; L08 became the three reference sheets. | Track 14 |
| 3C Capstones | **Done**: exactly 5, runnable, tested, with interview-ready READMEs. | `03-phase3-capstones.md`, `examples/` |
| 3D Interview playbook | **Done**: 5 lessons (STAR, design round, top 60 questions in 2 parts, 10 mocks with rubrics). | Track 15, `docs/content/interview/` |
| 3E First 90 days | **Done**: 2 lessons (95 min). | Track 16, `docs/content/new-job/` |
| 4 Manifests, plan, README | **Done**: tiers in every manifest, generated 30-week plan + falling-behind plan + read-if-time list, README rewritten, glossary. | `docs/content/study-plan.md` |

## 2. Files removed, merged, added

**Removed / archived**
- 46 duplicate or orphan lesson folders (38 archived to `archive/duplicates/`, 6 identical, 2 empty).
  **11 are merge candidates** (larger than the kept version): review them in Phase 2.
- Capstone F (observability) and the old AML capstone C: archived to `archive/capstones-pre-phase3/`.
- Original Track 16 (now 14) lessons: archived to `archive/track-16-pre-hardening/`.

**Renamed (git mv):** tracks 05→04, 06→05, 08→06, 09→07, 10→08, 11→09, 12→10, 13→11, 14→12, 15→13,
16→14, 17→15, 18→16. **Transaction integrity is now Track 05.**

**Added**
- `examples/`: Maven multi-module project (fintech-common, 5 capstones, track-13-web).
- Tracks 15 (Interview Playbook) and 16 (First 90 Days); `docs/content/glossary.md`; `docs/content/study-plan.md`.
- Tools: `build_capstone_pages.py`, `sync_manifest_tiers.py`, `build_study_plan.py`; the validator gained
  checks 8–10 (capstones, generated-file sync, Mermaid `;`, folder collisions).

**Lessons cut to cross-references:** none yet (Phase 2 work). **Moved to Optional this session:**
Track 12 (leadership) L01 "Staff & Principal Operating Model" and L08 "Cross-Team Influence".

## 3. Hours per area vs the budget table

| Area | Main path now (h) | Target (h) | Note |
|---|---|---|---|
| Concurrency and JVM (T03 + T07 core) | 37.3 | 22 | **15 h over**: candidates to demote in Phase 2 |
| Transaction integrity (T05, all 24 Core) + databases (T08 core) | 34.4 + 11.2 = 45.6 | 50 | T05 = 34.4 h (target ≈ 40, max 42) |
| Distributed systems + messaging (T02 + T09 core) | 19.7 | 24 | |
| Banking and payments domain (T04 core) | 8.6 | 16 | Under; FX, cards, reconciliation are Optional lessons |
| Spring Boot 4 (T13) | 9.7 | 24 | Paused |
| System design (T14) | 9.1 | 22 | You chose 8 lessons |
| Reliability, security, observability, cloud (T06 + T11 + T10 core) | 16.1 | 18 | |
| Architecture (T01 core) + senior skills (T12 subset) | 16.1 | 8 | **8 h over** |
| Interview playbook + first 90 days (T15 + T16) | 5.8 | (new) | |
| Five capstones | 60.0 | 60 | |
| **Main path total** | **227.8** | **≈ 244, ≤ 260** | Validator-enforced |

The 30-week plan schedules 265.6 h (main path + diagnostic, checkpoints, mocks, review, applications) and
leaves 34.4 h unscheduled; every week is ≤ 10 h; Track 05 occupies weeks 3–6.

## 4. Corrections by category

Full list with sources: `03-corrections.md`. Summary: **structure** 3 (duplicates, Track 14 tiers,
capstone manifest), **code** 6 (Mermaid in 9 diagrams, quiz renderer on 255 lessons, capstone renderer,
Hibernate/SQLSTATE fixes), **technical** 5, **references** 2, **clarity** 1, **regulatory** 0.

Two site-wide rendering bugs that existed before this work are fixed: knowledge checks crashed on 219
lessons (`questions.forEach is not a function`; and 36 lessons showed empty question text), and all
capstone pages failed (`EM.Renderer.postProcess` missing).

## 5. Test results (real output)

```text
fintech-common ...................... 8 tests   SUCCESS
Capstone 1 - Payment service ........ 13 tests  SUCCESS
Capstone 2 - Wallet ledger .......... 13 tests  SUCCESS
Capstone 3 - Card authorisation ..... 10 tests  SUCCESS
Capstone 4 - Reconciliation ......... 15 tests  SUCCESS
Capstone 5 - Instant P2P ............ 8 tests   SUCCESS
Track 13 web (Spring lessons 1,2,7) . 14 tests  SUCCESS
BUILD SUCCESS   Total time: 01:31 min   (81 tests)
```

Load tests (`-Dgroups=load`, 5 tests) pass; numbers are in each capstone README, labelled illustrative.

## 6. UNVERIFIED items

- `00-target-profile.md`: interview loop structure, "appear in ≥60% of reported loops", competency
  frequencies. No sources recorded. The playbook labels loop shape as an assumption.
- The ~120 older Core/Supporting lessons have **not** been fact-checked in this work. Expect errors like
  those found in Track 13 L01 and the old Track 16 (unsourced company claims, invented throughput limits).
- `estimatedMinutes` of older lessons were not recomputed as realistic totals.
- Spring Cloud 2025.1 (named in the brief) is not managed by the Boot 4.0.9 BOM and is not used; its
  compatibility was not checked.
- Decision Lab "further reading" strings are free text and some point to the wrong lesson (e.g. "Track
  02, Lesson 09 — Failure Isolation Patterns" is actually distributed locks). Not validated.

## 7. Claims in the brief that turned out different

| Brief | Actual (verified) |
|---|---|
| Spring Boot 4.0.x as current | 4.0.9 is the latest 4.0.x; **4.1.2 is the current GA**. Used 4.0.9 as asked. |
| Spring Data 2025.1, Framework 7, Security 7, Hibernate 7, Jakarta EE 11, JUnit 6, Testcontainers 2 | All correct (2025.1.8, 7.0.10, 7.0.8, 7.2.25, Servlet 6.1, 6.0.3, 2.0.5). |
| Core `@ConcurrencyLimit` as bulkhead | Default policy is BLOCK (queues); use `policy = REJECT`. |
| Core resilience annotations | `@Retryable`/`@ConcurrencyLimit` only; **no circuit breaker** in Framework 7 → Resilience4j 2.4.0. |
| OAuth2 resource server starter | Boot 4 name is `spring-boot-starter-security-oauth2-resource-server` (old name still in the BOM). |
| Testcontainers 2 per-technology modules | Exist for PostgreSQL and Kafka; **no Redis module** → `GenericContainer` + `@ServiceConnection(name="redis")`. |
| `mvn test -pl <module>` | Needs `-am` (shared `fintech-common`), or install it first. |
| Jackson 3 `tools.jackson.*` | Correct, but `jackson-annotations` keeps `com.fasterxml.jackson.annotation`. Jackson 3 changes JSON defaults (sorted properties, null-for-primitive and trailing-token failures): pinned by tests in `track-13-web`. |

## 8. Competency coverage (main path)

| Competency (target profile) | Weight | Main-path coverage |
|---|---|---|
| Distributed transactions (2PC, saga, outbox) | H | Strong: T05 L07, L13–L15, L23; T02 L06; T09 L15; capstone 1 |
| Idempotency & exactly-once | H | Strong: T05 L03, L08, L12; T02 L14, L16; T09 L05; capstones 1, 2, 5 |
| Java concurrency | H | Strong: T03 (19 lessons); capstones 2–3 concurrency tests |
| ACID, MVCC, isolation | H | Strong: T08 L01–L04 |
| Kafka | H | Strong: T09 L01–L03, L05; capstone 1 |
| Resilience (breaker, bulkhead, retry) | H | Strong: T06 L02–L05; capstone 3 |
| High-throughput APIs, rate limiting | H | Strong: T01 L14; T14 L06; capstone 5 |
| Payment rails, ISO 20022 | M | Partial: T04 L02, L07, L08; capstone 4 |
| Ledger, reconciliation | M | Strong: T05 L01, L10, L22; T14 L05; capstones 2, 4 |
| Virtual threads, structured concurrency | M | Strong: T03 L12–L14; T07 L15 |
| JVM / GC tuning | M | Partial: T07 L01, L03, L05 |
| Sharding, partitioning, replicas | M | Partial: T08 L07; T14 L05 (partitioning lesson is Optional) |
| Event sourcing, CQRS | M | Strong: T05 L18–L19 |
| Redis (locks, caching) | M | Partial: T02 L09; T14 L07; capstone 5 |
| Kubernetes | M | Partial: T10 L01, L04, L09 |
| Spring Boot internals | M | Partial: T13 (paused, has known errors); interview Q&A; capstones |
| Observability | M | Partial: T11 L01, L03, L05 |
| Consensus | L | Partial: T02 L04 |
| FX & treasury | L | Partial: capstone 2; T04 L10 is Optional |
| Senior influence (RFC, reviews, incidents) | L | Strong: T12 L03, L05, L09, L11; T15 L01 |
| PCI DSS / GDPR | L | Partial: capstone 3 (tokenisation), playbook Q60; dedicated content was in deleted Track 07 |
| CQRS read models | L | Strong: T05 L19 |

Every high-weight competency is covered by the main path.

## 9. Decisions that need you

1. **Track 07 content (unanswered from the brief):** PCI DSS and GDPR engineering existed only in the deleted
   Track 07. Do you want a short senior-level lesson on "PCI DSS scope and GDPR for backend engineers"
   (about 60 min), and in which track?
2. **Track 13 (Spring Boot 4) is paused and contains known errors** (Java 21 stated as minimum, `spring.factories`
   removal dated to Boot 4, `@NativeHint`, Undertow 3, removed starters that still exist). Until you resume it,
   consider marking its lessons Optional so the main path doesn't teach wrong facts. Keep or delete
   `examples/track-13-web`?
3. **Budget rebalancing:** concurrency/JVM (+15 h) and architecture/senior skills (+8 h) are over target;
   banking (−7 h), Spring (−14 h) and system design (−13 h) are under. Approve a Phase 2 pass that demotes
   or trims the over-target areas?
4. **11 merge candidates** from duplicate folders (`01-duplicates-resolved.md`): merge now (Phase 2) or drop?
5. **Phase 2 fact-check and template rewrite** of the older Core/Supporting lessons is the largest remaining
   job. Confirm before I start it, track by track, Core first.
6. **Progress data:** renumbering changed every lesson id from Track 04 onwards; progress saved in the
   browser under old ids will no longer show. Reset it, or I can add a one-time id migration in `progress.js`.
