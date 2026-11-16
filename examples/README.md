# Runnable examples

A Maven multi-module project with the code behind the lessons and the five capstone projects.
Everything compiles, and every test runs against real PostgreSQL, Kafka and Redis (Testcontainers).

| Module | What it is | Tests |
|---|---|---|
| `fintech-common` | `Money` (BigDecimal + currency, scale per currency, no silent rounding) and SHA-256/HMAC helpers. Plain Java, no Spring. | 8 |
| [`capstone-1-payment-service`](capstone-1-payment-service/README.md) | Idempotent payment API, transactional outbox, Kafka, idempotent consumer, DLT | 13 |
| [`capstone-2-wallet-ledger`](capstone-2-wallet-ledger/README.md) | Double-entry ledger, ordered locking, DB-enforced invariants, FX transfers, internal reconciliation | 13 |
| [`capstone-3-card-authorisation`](capstone-3-card-authorisation/README.md) | Auth / capture / reverse / refund / chargeback state machine, fraud hook with timeout, circuit breaker, bulkhead | 10 |
| [`capstone-4-reconciliation`](capstone-4-reconciliation/README.md) | camt.053 ingest (XXE-safe), matching engine, break classification, maker-checker workflow | 15 |
| [`capstone-5-instant-p2p`](capstone-5-instant-p2p/README.md) | OAuth2 resource server, per-tenant Redis rate limiting, signed webhooks with retries, SSRF checks | 8 |
| `track-13-web` | Track 13 (Spring Boot 4) lesson code, started then paused: `@SpringBootTest` no longer gives MockMvc, Jackson 3 defaults pinned by tests, header API versioning, HTTP Service Client, `@Retryable` double-charge bug and fix | 14 |

## Baseline (verified against Maven Central on 2026-11-12)

| Component | Version | Source |
|---|---|---|
| Spring Boot | 4.0.9 (latest 4.0.x patch; 4.1.2 is the newest GA) | `spring-boot-starter-parent` |
| Spring Framework / Security / Kafka | 7.0.10 / 7.0.8 / 4.0.8 | Boot 4.0.9 BOM |
| Hibernate ORM / Jackson / JUnit | 7.2.25.Final / 3.1.7 (`tools.jackson.*`) / 6.0.3 | Boot 4.0.9 BOM |
| Kafka client / Flyway / Testcontainers | 4.1.2 / 11.14.1 / 2.0.5 | Boot 4.0.9 BOM |
| Resilience4j | 2.4.0 (core `resilience4j-circuitbreaker`, used programmatically) | Maven Central |
| Java | 21 (`maven.compiler.release=21`) | |
| Images | `postgres:17-alpine`, `apache/kafka:4.1.1`, `redis:7.4-alpine` | Docker Hub |

## Run

Prerequisites: JDK 21, Maven 3.9+, Docker running.

```bash
cd examples
mvn test                                         # all modules, about 1 minute after images are pulled
mvn test -pl capstone-2-wallet-ledger -am        # one module (-am also builds fintech-common)
mvn test -pl capstone-2-wallet-ledger -am -Dgroups=load   # its load test (excluded by default)
```

`-am` ("also make") is needed because each capstone depends on `fintech-common`. Without it, run
`mvn install -pl fintech-common` once.

**Docker Desktop on macOS:** if Testcontainers says "Could not find a valid Docker environment",
point it at Docker Desktop's socket:

```bash
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
```

## Conventions used in every module

- Money is `Money` or `bigint` minor units with the currency next to it. Never `float`/`double`.
- Every state-changing endpoint takes an `Idempotency-Key`.
- Errors are RFC 9457 `application/problem+json` with safe messages (no stack traces, SQL or internals).
- Input is validated at the edge (Bean Validation); all SQL is parameterised.
- No secrets in code or config: credentials come from environment variables.
- Flyway owns the schema; Hibernate only validates it (`ddl-auto: validate`).
- Built-in API versioning (`/v1/...`, `spring.mvc.apiversion.*`).
- Request threads are virtual threads; the Hikari pool size is the real concurrency limit.
