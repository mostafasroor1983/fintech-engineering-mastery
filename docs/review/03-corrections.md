# Corrections log

Every change made to a factual claim, code example or structure, with the source used. Newest first.

> **Track numbers below are the numbers at the time of the fix (before renumbering on 2026-11-13).**
> Old → new: 05→04, 06→05, 08→06, 09→07, 10→08, 11→09, 12→10, 13→11, 14→12, 15→13, 16→14, 17→15, 18→16.
> For example, "track-06-lesson-13" is now `track-05-lesson-13`, and "Track 15 L01" is now Track 13 L01.
Categories: **code**, **technical**, **regulatory**, **references**, **clarity**, **structure**.

## 2026-11-13

| # | Category | Path | What was wrong | Fix | Source |
|---|---|---|---|---|---|
| 1 | structure | `docs/content/tracks/*/lesson-*` (46 folders) | 44 colliding lesson-number folders across 11 tracks (two or three folders per lesson number; one referenced by the manifest, the others orphaned). `00-duplicates.md` listed folders that did not exist and missed most real collisions. | Kept the referenced folder; archived 38 non-identical orphans to `docs/review/archive/duplicates/`; removed 6 identical and 2 empty ones. 11 marked as merge candidates. Validator now fails on collisions or unreferenced folders. | Disk vs `_track.json` comparison; `01-duplicates-resolved.md` |
| 2 | code | `track-06-lesson-13`, `track-08-lesson-07` (+ its duplicate), `track-16-lesson-03/05/07` | Mermaid sequence diagrams contained `;`, which Mermaid treats as a statement separator → "Syntax error in text"; the diagram did not render. | Replaced `;` with `,` inside messages and notes; validator check added. | Rendered in headless Chrome (Mermaid 11.4.1 bundled with the site) |
| 3 | references | `docs/data/decision-lab.json`, `concurrency-lab.json`, `concurrency-lab-async.json` | Links and "further reading" pointed to deleted Track 04 and Track 07 lessons. | Repointed: backpressure → T01 L14; virtual threads vs reactive → T03 L12; context propagation → T03 L25; AML → T05 L13; hot/warm/cold data → T10 L18; reactive error handling dropped. | Track manifests |
| 4 | technical | `track-16-lesson-02` (rewritten) | Claimed PostgreSQL supports "approximately 10,000 simple inserts/second on a single primary" as a fact. | Removed. The lesson now says capacity depends on hardware and transaction shape and must be measured (load test). | No primary source supports a fixed figure |
| 5 | references | Track 16, all lessons (rewritten) | Unsourced claims: "the most common Staff-level design question at Revolut, Wise and Monzo", "interviewers from Stripe backgrounds will notice", "Revolut-class interviewers look for…". | Removed; interview-format statements labelled as assumptions. | No public source found |
| 6 | clarity | Track 16 (rewritten) | Staff/principal framing ("difficulty: principal"); RADE framework instead of the required RESHADED; L08 duplicated the mock-interview material now in Track 17. | Senior level; RESHADED in every problem; L08 became the three reference sheets (patterns, estimation, database choice). Originals in `docs/review/archive/track-16-pre-hardening/`. | Brief §3B |
| 7 | structure | `tools/validate_content.py` (tiers) | Track 14 Core included "The Staff & Principal Engineer Operating Model" and "Cross-Team Influence" (staff-level), against the brief's senior-only rule. | Core = L03 RFC/design docs, L05 tech debt, L09 reviews, L11 incident leadership; Supporting = L07 mentoring; L01 and L08 → Optional. | Brief §1 |
| 8 | technical | `docs/content/interview/03-…` Q30 | Draft said to set `server.shutdown=graceful`. | Graceful shutdown is the default since Spring Boot 3.4; text says so. | Spring Boot 3.4 release notes |
| 9 | technical | `docs/content/new-job/02-production-safety` | Draft blamed `ADD COLUMN … DEFAULT` for table rewrites in general. | Precise: since PostgreSQL 11 a non-volatile default doesn't rewrite; the outage comes from the `ACCESS EXCLUSIVE` lock queue and a non-concurrent index build. Added `lock_timeout`, `CONCURRENTLY` in its own migration, Flyway `executeInTransaction=false`. | PostgreSQL docs (ALTER TABLE, CREATE INDEX); Flyway docs |
| 10 | code | `docs/assets/js/renderer.js`, `capstone.js` | `capstone.js` called `EM.Renderer.postProcess`, which did not exist: every capstone page showed a TypeError. The hours badge used non-existent CSS classes (full-width clock icon). | Added `postProcess(el)`; reused lesson-page classes. | Headless Chrome render check |
| 11 | code | `docs/data/capstone-projects.json` | Manifest referenced deleted `track-04` and `track-07`; six capstones (brief: exactly five); principal-level projects. | Regenerated from the five capstone READMEs by `tools/build_capstone_pages.py`. | Brief §3C |
| 12 | technical | Track 15 L01 (not rewritten; flagged) | States Java 21 is the minimum for Boot 4 (it is Java 17), that `spring.factories` auto-configuration removal is new in Boot 4 (it was Boot 3.0), lists `@NativeHint`, Undertow 3, removal of log4j2 starter and `SpringBootServletInitializer` (all wrong for 4.0). | **Not fixed**: Track 15 is paused at your request. Listed in the final report. | Spring Boot 4.0 Migration Guide; Boot 4.0.9 BOM |

## 2026-11-12 (capstones)

| # | Category | Path | What was wrong | Fix | Source |
|---|---|---|---|---|---|
| 13 | code | capstones 1–3 entities | `CHAR(3)` currency columns failed Hibernate 7 schema validation (`bpchar` vs `varchar`). | `@JdbcTypeCode(SqlTypes.CHAR) @Column(length = 3)`. | Test run (Hibernate 7.2.25) |
| 14 | code | capstone 2 schema | Append-only trigger used SQLSTATE `insufficient_privilege`, translated by Spring to `BadSqlGrammarException`. | `restrict_violation` → `DataIntegrityViolationException`. | Test run |
| 15 | technical | brief §3 | "`@ConcurrencyLimit` as a bulkhead": its default policy is BLOCK (queues). | Use `policy = REJECT` (throws `InvocationRejectedException`). | `spring-context` 7.0.10 bytecode (`ConcurrencyLimit.policy()` default) |
| 16 | technical | brief §3 | Spring Framework 7 has `@Retryable` and `@ConcurrencyLimit` but no circuit breaker. | Resilience4j 2.4.0 circuit breaker. | Spring Framework 7.0 release notes |
