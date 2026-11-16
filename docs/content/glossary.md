# Glossary

Plain-language definitions of terms used in the lessons, capstones and interview playbook.
Alphabetical. Where a lesson teaches the term properly, it is named in brackets.

| Term | Meaning |
|---|---|
| **2PC (two-phase commit)** | A protocol where a coordinator asks every participant to prepare, then tells all to commit or all to abort. Atomic, but blocks if the coordinator fails. [Track 05 L15] |
| **ACID** | Atomicity, Consistency, Isolation, Durability: the guarantees of a database transaction. [Track 08 L01] |
| **acks=all** | Kafka producer setting: the leader confirms a write only after all in-sync replicas have it. |
| **Actuator** | Spring Boot module that exposes operational endpoints such as `/actuator/health`, `/mappings`, `/beans`, `/conditions`. Expose only health and metrics publicly. [Track 16 L01] |
| **ADR (architecture decision record)** | A short document recording one decision, its context, the options and the consequences. |
| **Advisory lock** | A PostgreSQL lock on an application-chosen number (e.g. `pg_advisory_xact_lock`) rather than on a row; used to serialise work per key. |
| **API versioning (built-in)** | Spring Framework 7 feature that routes requests by a version taken from a path segment, header, query parameter or media type (`spring.mvc.apiversion.*`). |
| **At-least-once delivery** | Every message is delivered one or more times; duplicates are possible, so consumers must be idempotent. |
| **Authorisation (card)** | The issuer approves a card payment and places a hold on the funds; the money moves later at capture. [Track 04 L18] |
| **BOLA (broken object level authorisation)** | OWASP API Security risk #1: an API returns or changes an object (e.g. a payment) without checking that the caller owns it. |
| **Break (reconciliation)** | A difference between two records of the same money (e.g. ledger vs bank statement) that someone must explain and resolve. |
| **Bulkhead** | Limiting how many concurrent calls go to one dependency, so it cannot use up all capacity. In Spring Framework 7: `@ConcurrencyLimit`. [Track 06 L03] |
| **camt.053** | ISO 20022 bank-to-customer statement message: the end-of-day account statement a bank sends. |
| **Capture (clearing)** | The merchant asks for the money of an authorised card payment, fully or partly. |
| **Chargeback** | A cardholder disputes a payment through their issuer; the scheme reverses funds from the merchant side, pending evidence. |
| **Circuit breaker** | Stops calling a dependency that keeps failing, for a while, then tries again carefully. [Track 06 L02] |
| **Compensation** | A new business action that undoes the effect of an earlier step in a saga (e.g. a refund), not a database rollback. [Track 05 L23] |
| **Constant-time comparison** | Comparing secrets so that the time taken does not reveal how many leading bytes matched (`MessageDigest.isEqual`). |
| **CQRS** | Command Query Responsibility Segregation: separate models for writing and reading data. [Track 05 L19] |
| **Dead-letter topic (DLT)** | Where a message goes after bounded retries fail, so it does not block the partition; must be monitored. [Track 09 L11] |
| **Deferred constraint trigger** | A PostgreSQL trigger checked at COMMIT instead of after each statement; used to check that a journal entry balances. |
| **Double-entry bookkeeping** | Every money movement is recorded as postings that sum to zero (per currency). [Track 05 L01] |
| **Dual write** | Writing to two systems (e.g. database and Kafka) without one shared transaction; a crash between them leaves them inconsistent. [Track 05 L07] |
| **End-to-end id** | A reference set by the payer that travels with a payment through every bank; used to match bank lines to ledger items. `NOTPROVIDED` means none. |
| **Expand/contract migration** | Changing a schema in backwards-compatible steps (add, dual-write, backfill, switch, remove) so old and new code can run together. [Track 16 L02] |
| **Fencing token** | A number that increases with each lock grant; the protected resource rejects writes with an older token, so a paused client cannot write after losing the lock. |
| **Full jitter** | Retry delay chosen randomly between 0 and the exponential backoff cap, so many clients do not retry at the same moment. [Track 06 L04] |
| **HMAC** | A keyed hash (here HMAC-SHA256) used to sign webhook payloads so receivers can verify sender and integrity. |
| **HTTP Service Client** | A Java interface annotated with `@HttpExchange`/`@PostExchange` for which Spring generates the HTTP client; registered with `@ImportHttpServices`. |
| **Idempotency key** | A client-chosen unique value sent with a request (header `Idempotency-Key`) so the server can recognise retries and return the original result. [Track 05 L12] |
| **Idempotent consumer** | A message consumer that records processed message ids in the same transaction as its effect, so duplicates change nothing. [Track 05 L08] |
| **ISO 20022** | The international financial messaging standard (e.g. pacs.008 credit transfer, camt.053 statement). [Track 04 L07] |
| **Jackson 3** | The JSON library used by Spring Boot 4 (package `tools.jackson`); its defaults differ from Jackson 2 (e.g. sorted properties, strict null-for-primitive). |
| **Journal entry / posting** | A journal entry is one business event in the ledger; postings are its lines, each debiting or crediting one account. |
| **Lease (work claim)** | Marking a row as taken until a time (`lease_until`) so other workers skip it; if the worker dies, the lease expires and another worker retries. |
| **Maker-checker (four-eyes)** | A control where one person makes a change and a different person approves it. |
| **Minor units** | Money stored as a whole number of the currency's smallest unit (pence, cents): 10.50 GBP = 1050. |
| **MVCC** | Multi-version concurrency control: readers see a snapshot while writers create new row versions. [Track 08 L03] |
| **Optimistic locking** | Detecting conflicting updates with a version column (`@Version`); the losing transaction fails and retries. [Track 05 L16] |
| **Outbox (transactional)** | Writing an event row in the same database transaction as the business change, then publishing it to the broker separately. [Track 05 L13] |
| **PAN / token** | PAN is the card number; a token is a substitute value that is useless if stolen. Storing only tokens reduces PCI DSS scope. |
| **Pessimistic locking** | Locking rows before changing them (`SELECT … FOR UPDATE`) so other transactions wait. [Track 05 L17] |
| **Pinning (virtual threads)** | A virtual thread stuck to its carrier OS thread while blocked (on JDK 21–23: inside `synchronized`); fixed for `synchronized` in JDK 24 (JEP 491). |
| **ProblemDetail (RFC 9457)** | Standard JSON error format (`application/problem+json`) with `type`, `title`, `status`, `detail`. |
| **Reconciliation** | Comparing two independent records of the same money and explaining every difference. [Track 05 L22, Track 04 L12] |
| **RESHADED** | Design-interview plan: Requirements, Estimation, Schema, High-level design, API, Deep dive, Evaluate, Deliver. [Track 15 L02] |
| **Saga** | A sequence of local transactions with compensations, used instead of one distributed transaction. [Track 05 L14] |
| **SKIP LOCKED** | `SELECT … FOR UPDATE SKIP LOCKED`: take rows nobody else has locked, skipping the rest; used for work queues. |
| **SLI / SLO** | Service level indicator (a measured value, e.g. p99 latency) and objective (its target, e.g. p99 < 300 ms for 99.9% of minutes). [Track 06 L01] |
| **SSRF** | Server-side request forgery: tricking a server into calling a URL the attacker chooses, such as an internal service or cloud metadata. OWASP API7. |
| **Stand-in decision** | A pre-agreed fallback decision when a dependency (here the fraud engine) cannot answer in time. |
| **STAR** | Situation, Task, Action, Result: a structure for behavioural interview answers. [Track 15 L01] |
| **Token bucket** | Rate limiting where tokens refill at a fixed rate up to a capacity, and each request takes one. [Track 02 L17] |
| **Virtual threads** | Lightweight JVM threads (final in Java 21) that make blocking I/O cheap; they add concurrency, not speed. [Track 03 L12] |
| **XXE** | XML external entity attack: a malicious XML document makes the parser read local files or URLs. Disable DTDs and external entities. |
