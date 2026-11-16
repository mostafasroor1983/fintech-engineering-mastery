# Phase 3C: Capstone rewrites (report)

Date: 2026-11-12. Scope: section 3C of the rebuild brief (exactly 5 capstones, about 12 h each, runnable
and tested, interview-ready READMEs). No commits were made; all changes are in the working tree.

## What changed

| Before (6 capstones) | After (5) | Code module |
|---|---|---|
| A: High-Throughput Payment Processing Platform | A: Payment Service with Idempotency, Transactional Outbox and Kafka | `examples/capstone-1-payment-service` |
| B: Concurrent Double-Entry Ledger Engine | B: Multi-Currency Wallet on a Double-Entry Ledger, with FX Transfers | `examples/capstone-2-wallet-ledger` |
| C: Distributed AML & Sanctions Screening (folder `project-c-aml-screening`) | C: Card Authorisation and Clearing with a Fraud Hook and Resilience (`git mv` → `project-c-card-authorisation`) | `examples/capstone-3-card-authorisation` |
| D: Financial Reconciliation Engine | D: Settlement and Reconciliation Pipeline (CAMT.053 ingest, matching, breaks) | `examples/capstone-4-reconciliation` |
| E: Multi-Region Banking Platform (folder `project-e-multi-region-banking`) | E: Instant P2P Transfer API with OAuth2, Per-Tenant Rate Limiting and Webhooks (`git mv` → `project-e-instant-p2p`) | `examples/capstone-5-instant-p2p` |
| F: Production Observability & Incident Investigation Platform | **Removed** (`git rm`); the brief asks for exactly 5 | – |

**Uncommitted work preserved:** the working-tree versions of all six old pages (which had uncommitted
edits) and the old `capstone-projects.json` are copied to `docs/review/archive/capstones-pre-phase3/`
before anything was overwritten or deleted.

### Files added

- `examples/` Maven multi-module project: `pom.xml`, `README.md`, `fintech-common`, 5 capstone modules
  (each with `README.md`, Flyway schema, code, integration tests, a `@Tag("load")` load test).
- `tools/build_capstone_pages.py`: generates the 5 site pages, `capstone-projects.json`, the
  `capstoneProjects` list in `curriculum-index.json`, and the capstone documents in `search-index.json`
  from the module READMEs (single source of truth). `--check` mode fails if they drift.

### Files modified

- `docs/content/capstone/*/index.md`: generated, do not edit by hand.
- `docs/data/capstone-projects.json`, `curriculum-index.json`, `search-index.json`: capstone entries only.
  The old manifest referenced the deleted `track-04` and `track-07`; those references are gone.
- `tools/validate_content.py`: new CHECK 8. It requires exactly 5 capstones, contiguous sequence, pages
  and code modules present, no deleted-track references, links pointing at existing tracks, and generated
  pages in sync. Capstone hours now come from the manifest (60 h) instead of the hardcoded 116 h estimate;
  the other new content keeps the Phase 0 estimate (56 h).
- `docs/assets/js/renderer.js`: added `postProcess(el)` (5 lines). **Pre-existing bug:** `capstone.js` called
  `EM.Renderer.postProcess`, which did not exist, so every capstone page showed
  "TypeError: EM.Renderer.postProcess is not a function". This was required to make the pages render.
- `docs/assets/js/capstone.js`: one line. The hours badge used CSS classes that do not exist, so the
  clock icon rendered full-width; it now uses the lesson page's `lesson-meta-row` / `lesson-meta-item`.
- `docs/assets/js/app.js`: About page says "5 capstone projects" (was 6); the stale roadmap list no
  longer names the AML capstone.

## Test results (real output)

`cd examples && mvn test` on 2026-11-12 (JDK 21.0.9, Maven 3.10.0, Docker 29.9.2):

```text
Tests run: 8,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.common.MoneyTest
Tests run: 9,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.payments.PaymentApiTest
Tests run: 4,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.payments.OutboxFlowTest
Tests run: 11, Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.wallet.LedgerTest
Tests run: 2,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.wallet.WalletApiTest
Tests run: 10, Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.cards.CardLifecycleTest
Tests run: 4,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.recon.Camt053ParserTest
Tests run: 7,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.recon.ReconciliationIntegrationTest
Tests run: 4,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.recon.MatcherTest
Tests run: 8,  Failures: 0, Errors: 0, Skipped: 0 -- in com.fintechmastery.p2p.P2pApiTest
BUILD SUCCESS   Total time: 47.9 s   (67 tests)
```

Load tests (`mvn test -Dgroups=load`), run once on an Apple M1 Pro (8 cores, 16 GB), with containers on the same
laptop. These are illustrative and are labelled that way in each README:

```text
LOAD capstone-1: 4000 requests in 3.0 s = 1353 req/s; p50 116.0 ms, p99 590.8 ms, errors 0
LOAD capstone-2: 4764 ok + 123 rejected in 4.3 s = 1146 tx/s; p50 77.1 ms, p99 240.8 ms
LOAD capstone-3: 2000 auth+capture in 2.1 s = 967/s; p50 63.3 ms, p99 613.1 ms, fraud calls 1834
LOAD capstone-4: 10000 lines (2177 KB) ingested and matched in 9.0 s; matched 9900, breaks {AMOUNT_MISMATCH=100}
LOAD capstone-5: 2000 requests in 3.5 s = 575 req/s; p50 113.6 ms, p99 968.9 ms; {noisy-201=64, quiet-201=1000, noisy-429=936}
BUILD SUCCESS
```

`mvn clean compile test-compile` with `-Xlint:all`: no compiler warnings.

### Failures hit during development (and fixes)

| Failure | Cause | Fix |
|---|---|---|
| Hibernate schema validation: `found bpchar, expecting varchar` | `CHAR(3)` columns vs a `String` field; `columnDefinition` alone does not change the JDBC type Hibernate 7 compares | `@JdbcTypeCode(SqlTypes.CHAR) @Column(length = 3)` |
| `deadlock detected` in test cleanup | `TRUNCATE` (ACCESS EXCLUSIVE) raced the Kafka listener still retrying the previous test's message | Row-level `DELETE` in cleanup |
| Append-only test: `BadSqlGrammarException` | Trigger raised SQLSTATE `insufficient_privilege`, which Spring translates as a grammar error | `restrict_violation` → `DataIntegrityViolationException` |
| Fraud timeout test passed a "slow" call | Test pollution: the bulkhead test lowered the fake server delay and `reset()` did not restore it | `reset()` restores the 1 s delay |
| Site: capstone pages blank | Pre-existing missing `EM.Renderer.postProcess` (see above) | Added `postProcess` |
| Site: Mermaid "Syntax error in text" in capstone 1 | `;` inside a sequence-diagram message is a statement separator | Removed semicolons from messages |

## Rendering check

Served `docs/` with `python3 -m http.server` and drove Google Chrome headless (Playwright). The capstone
index shows 5 cards. Each page renders its tables and all 8 Mermaid diagrams (2+1+2+1+2) with zero
Mermaid errors and zero console errors. A lesson link (`#/tracks/track-13/lessons/track-13-lesson-10`)
opens the right lesson. Validator: `✓ All checks passed` (133 pre-existing warnings, mostly lessons over
75 min outside this phase's scope).

## Verified versions and discrepancies with the brief

Verified from the Spring Boot 4.0.9 BOM on Maven Central (2026-11-12): Framework 7.0.10, Security 7.0.8,
Spring Kafka 4.0.8, Kafka client 4.1.2, Hibernate 7.2.25.Final, Jackson 3.1.7, JUnit 6.0.3,
Testcontainers 2.0.5, Flyway 11.14.1. Resilience4j 2.4.0 (has a `resilience4j-spring-boot4` module;
the capstones use the core library programmatically).

| Brief says / assumption | Actual | Used |
|---|---|---|
| "Spring Boot 4.0.x" | 4.0.9 is the latest 4.0.x; **4.1.2 is the current GA** | 4.0.9, per the brief. Upgrading to 4.1 is a one-line parent change, but untested. |
| OAuth2 resource server starter | `spring-boot-starter-security-oauth2-resource-server`; the old `spring-boot-starter-oauth2-resource-server` still exists in the 4.0 BOM | the `security-` name |
| `RestTestClient` | lives in `spring-boot-resttestclient`; enable with `@AutoConfigureRestTestClient` | as verified |
| Testcontainers 2 artifacts | `testcontainers-postgresql`, `testcontainers-kafka`, `testcontainers-junit-jupiter`; classes `org.testcontainers.postgresql.PostgreSQLContainer`, `org.testcontainers.kafka.KafkaContainer`; **no Redis module** | `GenericContainer` + `@ServiceConnection(name = "redis")` |
| `@ConcurrencyLimit` as a bulkhead | Default policy is **BLOCK** (queues); `policy = REJECT` throws `InvocationRejectedException` | REJECT |
| Core resilience annotations | Spring Framework 7 has `@Retryable` and `@ConcurrencyLimit` but **no circuit breaker** | Resilience4j for the breaker |
| HTTP Service Client properties | `spring.http.serviceclient.<group>.base-url / connect-timeout / read-timeout` | as verified |
| API versioning properties | `spring.mvc.apiversion.use.path-segment`, `.supported`, `.default`, `.required` | path segment 0 |
| `mvn test -pl <module>` | Needs `-am` (or `mvn install -pl fintech-common` first) because modules share `fintech-common` | documented |

## Decisions that need you

1. **Capstone F (observability / incident investigation) was removed** to meet "exactly 5". Its text is in
   the archive. Some of it (the high-latency → pool-exhaustion incident walk-through) fits the Spring
   track's planned "debug a production incident" lesson. Should it be salvaged there?
2. **The old capstone C (AML & sanctions screening) was replaced**, consistent with the Track 07 decision
   and the "AML excluded" note in 3B. It is archived, not re-homed.
3. **Track renumbering (Phase 1) is not yet in the working tree:** tracks are still 01, 02, 03, 05, 06, 08…16.
   Capstone links are resolved from the manifests by the generator, so after renumbering, re-run
   `python3 tools/build_capstone_pages.py` and they update automatically. The README links use folder
   paths, which `git mv` changes, so update those with the renumbering.
4. **Docker Desktop on this Mac** shut down twice right after start-up (its log shows an admin-privileges prompt, then a GUI-requested shutdown), and Testcontainers
   needs `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` (documented in `examples/README.md`).

## Not done in this step (still open in the brief)

- 3A Spring Boot 4 track (existing Track 15 has 8 lessons vs the 18–22 asked), 3B system-design problems,
  3D interview playbook, 3E first 90 days, Phase 4 manifests and the 30-week plan, and the final
  `99-summary.md`.
- Capstone pages use plain table styling (the lesson CSS targets `#lesson-body`); this is cosmetic, so the CSS was left alone.
- `search-index.json` counts 12 tracks while `tracks.json` has 14 (Tracks 15 and 16 are not indexed). This
  predates this step. Run `rebuild_search_index.py` in Phase 4.
