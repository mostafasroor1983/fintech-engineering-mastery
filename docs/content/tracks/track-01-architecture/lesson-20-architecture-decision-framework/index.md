---
id: track-01-lesson-20
title: "Principal Engineer's Architecture Decision Framework"
slug: architecture-decision-framework
track: track-01
trackName: "Financial Services Architecture"
sequence: 20
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, architecture, trade-offs, staff-engineer, principal-engineer]
prerequisites: []
---

# Principal Engineer's Architecture Decision Framework

> [!NOTE]
> The difference between a senior engineer and a principal engineer is not that the principal knows more patterns — it is that the principal has a framework for choosing between patterns under real-world constraints. Good architecture decisions are not about finding the theoretically optimal solution; they are about making the best trade-off for a specific context, communicating it clearly, and knowing when to revisit it.

## What Principal Engineers Actually Do

Before discussing frameworks, it is worth being explicit about what principal and staff engineers are hired to do in financial institutions:

- **Raise the technical floor** across multiple teams, not just their own squad
- **Absorb architectural ambiguity** so that delivery teams can execute with clarity
- **Own cross-cutting technical decisions** that span service or domain boundaries
- **Provide technical risk management**: identify where the architecture is fragile before it breaks in production
- **Mentor technical decision-making** in senior engineers

This lesson focuses on the last two: how to make and communicate architecture decisions at a level of quality that scales beyond your own direct involvement.

---

## The Decision-Making Process

Good architecture decisions follow a process that can be audited and revisited. The worst outcomes come from decisions made implicitly, undocumented, and owned by no one.

```
Architecture Decision Process:

1. FRAME          Understand the actual problem, not just the stated solution
2. GATHER CONTEXT Identify constraints, non-negotiables, and stakeholders
3. ENUMERATE      List viable options (not just the first two that come to mind)
4. EVALUATE       Score each option against weighted criteria
5. DECIDE         Choose and document the rationale, not just the choice
6. REVIEW         Define when this decision should be revisited
```

### Framing the Real Problem

Teams often come to principal engineers with a solution in search of a problem. The first job is reframing:

| Stated Problem | Actual Problem to Investigate |
|---|---|
| "We need microservices" | What operational or delivery bottleneck exists today? |
| "We need Kafka" | What is the actual throughput, ordering, and replay requirement? |
| "We need a NoSQL database" | What schema flexibility or scale problem cannot be solved with indexes? |
| "Our service is slow" | Is it the query, the network, the lock contention, or the GC? |
| "We need to rewrite this" | What specific outcomes would a rewrite achieve that refactoring would not? |

---

## The Trade-Off Matrix

Every significant architectural choice involves trade-offs. Principal engineers make these explicit. Here is a canonical trade-off matrix for the most common fintech architecture decisions:

```
Trade-Off Axes in Financial Systems:

CONSISTENCY  ←────────────────────────────────→  AVAILABILITY
Strong (always current)                          Eventual (always up)
Suitable for: balances, ledgers                  Suitable for: reporting, analytics

COMPLEXITY  ←────────────────────────────────→  MAINTAINABILITY
Optimal (every last microsecond)                 Maintainable (team can own it in 3 years)
Suitable for: HFT matching engines               Suitable for: payments, accounts

AUTONOMY  ←────────────────────────────────────→  COORDINATION
Fully independent teams/services                 Shared capabilities
Suitable for: product verticals                  Suitable for: fraud, compliance, ledger

FLEXIBILITY  ←─────────────────────────────────→  PERFORMANCE
Schema-on-read (adapt easily)                    Schema-on-write (optimise access patterns)
Suitable for: analytics, ML pipelines            Suitable for: transaction processing
```

---

## Decision 1: Microservices vs Modular Monolith

This is perhaps the most frequently mis-decided architecture choice in fintech. The default answer has swung from "always monolith" to "always microservices" and back — both defaults are wrong.

### Decision Criteria

```java
// A fitness function for the microservices vs monolith decision
// Score each criterion 1-5; higher = more microservices appropriate
public record MicroservicesReadinessAssessment(
    // Team & organisational factors
    int independentDeploymentNeeded,    // Do teams need to deploy independently? (1-5)
    int teamCognitiveBoundaries,        // Are domain boundaries clear and stable? (1-5)
    int operationalMaturity,            // Does your team operate distributed systems? (1-5)

    // Technical factors
    int scalabilityDifferentiation,     // Do components need drastically different scale? (1-5)
    int technologyHeterogeneity,        // Are there justified reasons for different tech stacks? (1-5)
    int faultIsolationRequired,         // Must one component's failure not affect others? (1-5)

    // Cost factors
    int teamSize,                       // Team < 15 engineers = monolith-first
    int systemMaturity                  // Greenfield = monolith-first; established = microservices may help
) {
    public int totalScore() {
        return independentDeploymentNeeded + teamCognitiveBoundaries
            + operationalMaturity + scalabilityDifferentiation
            + technologyHeterogeneity + faultIsolationRequired
            + teamSize + systemMaturity;
    }

    public Recommendation recommend() {
        if (totalScore() < 20) return Recommendation.MODULAR_MONOLITH;
        if (totalScore() < 28) return Recommendation.MODULAR_MONOLITH_FIRST;
        return Recommendation.MICROSERVICES;
    }
}
```

### Context-Specific Guidance for Financial Services

**Use a Modular Monolith when:**
- Team size is below 15 engineers
- The domain model is still being discovered (greenfield fintech product)
- Operational infrastructure (service mesh, distributed tracing, container orchestration) is not yet mature
- Latency requirements demand in-process calls (sub-millisecond)
- The regulatory and compliance surface is shared across all features

**Use Microservices when:**
- Multiple teams need independent deployment cadences
- Components have significantly different SLA requirements (99.99% for payments vs 99.9% for reporting)
- Regulatory boundaries genuinely require data isolation (PCI-DSS scope reduction is a real driver)
- Scale requirements differ by an order of magnitude across components
- The domain is mature and bounded contexts are stable

**Red flags suggesting premature microservices:**
- Two services that are always deployed together
- Cross-service transactions implemented with distributed two-phase commit
- Services sharing a database schema
- A "gateway" service that knows all business logic (the distributed monolith anti-pattern)

---

## Decision 2: Synchronous vs Asynchronous Communication

```
Decision Framework: Sync vs Async

                   SYNC (REST/gRPC)       ASYNC (Kafka/SQS)
Coupling           Temporal coupling      Decoupled in time
Failure model      Fail fast, easy retry  At-least-once, idempotency required
Latency            Predictable P50        Variable (depends on consumer lag)
Throughput         Limited by slowest hop High; consumer scales independently
Backpressure       Automatic (HTTP 429)   Queue depth / consumer lag
Ordering           Request-response       Requires partition key design
Tracing            Easy (request ID)      Requires correlation ID propagation
Operational cost   Low                    Higher (broker ops, schema registry)

USE SYNC FOR:                             USE ASYNC FOR:
- Customer-facing responses               - Fire-and-forget notifications
- Real-time balance queries               - Audit event publishing
- Fraud checks that block payment         - Cross-domain data replication
- Payment authorisation decisions         - Batch settlement processing
- Idempotency key checks                  - Workflow orchestration
```

```java
// Example: payment submission uses sync for authorisation, async for downstream
@Service
public class PaymentOrchestrationService {

    private final FraudCheckService    fraudCheck;    // sync: blocks submission
    private final LedgerService        ledger;        // sync: in-process / critical path
    private final EventPublisher       events;        // async: downstream subscribers

    public PaymentResult submitPayment(PaymentRequest request) {
        // Synchronous — customer is waiting; decisions needed in real time
        FraudAssessment fraud = fraudCheck.assess(request);  // 50ms SLA
        if (fraud.isDeclined()) {
            return PaymentResult.declined(request.paymentId(), fraud.reason());
        }

        Payment payment = paymentRepository.save(
            Payment.from(request, PaymentStatus.PENDING)
        );

        LedgerPostingResult posting = ledger.postHold(payment);  // in-process

        // Asynchronous — customer does not wait for these
        events.publish(new PaymentSubmittedEvent(payment));
        // -> notification-service picks this up: sends confirmation email
        // -> fraud-service picks this up: updates velocity counters
        // -> reporting-service picks this up: updates dashboard

        return PaymentResult.submitted(payment.id(), posting.referenceNumber());
    }
}
```

---

## Decision 3: SQL vs NoSQL

The "just use NoSQL because it scales" argument has caused more production incidents in fintech than it has prevented.

### When SQL is the Right Choice for Financial Data

```sql
-- Financial data has properties that relational databases handle naturally:

-- 1. ACID transactions across multiple entities
BEGIN;
    UPDATE accounts SET balance = balance - 500.00 WHERE account_id = 'ACC-001';
    UPDATE accounts SET balance = balance + 500.00 WHERE account_id = 'ACC-002';
    INSERT INTO ledger_entries (debit_account, credit_account, amount)
    VALUES ('ACC-001', 'ACC-002', 500.00);
COMMIT;
-- This is trivial in PostgreSQL; it requires careful design in NoSQL

-- 2. Complex queries for regulatory reporting (Basel III, IFRS 9)
SELECT
    r.risk_weight_category,
    SUM(e.exposure_amount)              AS total_exposure,
    SUM(e.exposure_amount * r.weight)   AS risk_weighted_exposure,
    COUNT(*)                            AS position_count
FROM credit_exposures e
JOIN risk_weight_mappings r
    ON e.asset_class = r.asset_class
    AND e.credit_rating = r.credit_rating
WHERE e.reporting_date = CURRENT_DATE
GROUP BY r.risk_weight_category
ORDER BY risk_weighted_exposure DESC;
-- Ad-hoc regulatory queries like this require SQL or a SQL-compatible layer

-- 3. Referential integrity for account-to-customer relationships
ALTER TABLE accounts
    ADD CONSTRAINT fk_accounts_customer
    FOREIGN KEY (customer_id) REFERENCES customers(id)
    ON DELETE RESTRICT;  -- cannot delete customer with open accounts
```

### When NoSQL is Justified in Fintech

| Use Case | Recommended Store | Why |
|---|---|---|
| Session state / customer preferences | Redis | Fast access, TTL-based expiry, no relational queries |
| Fraud feature vectors | Redis / DynamoDB | Known access pattern (by customer ID), high read volume |
| Audit event log | Cassandra / OpenSearch | Append-only, time-series access, petabyte scale |
| Document-heavy data (KYC docs, contracts) | MongoDB / S3 + Postgres metadata | Variable schema, large binary content |
| Payment routing tables | Redis (read-through cache) | High-frequency reads, simple key-value access |

---

## Decision 4: Consistency vs Availability

For engineers who have read the CAP theorem but need to operationalise it:

```java
// In a payment processing system, different data elements have different
// consistency requirements:

public enum ConsistencyRequirement {

    // MUST be strongly consistent: stale reads risk double-spending
    ACCOUNT_BALANCE(ConsistencyLevel.STRONG,
        "Must always reflect all committed transactions"),

    PAYMENT_STATUS(ConsistencyLevel.STRONG,
        "Customer and merchant must see same terminal status"),

    LEDGER_ENTRIES(ConsistencyLevel.STRONG,
        "Regulatory requirement: single source of truth"),

    // CAN tolerate eventual consistency: staleness has bounded business impact
    TRANSACTION_HISTORY(ConsistencyLevel.EVENTUAL,
        "Displays last 30 days; 1-2 second lag is acceptable"),

    MERCHANT_ANALYTICS(ConsistencyLevel.EVENTUAL,
        "Dashboard updated every 5 minutes; no financial decision depends on it"),

    NOTIFICATION_STATUS(ConsistencyLevel.EVENTUAL,
        "Email/SMS delivery confirmation; best effort is sufficient"),

    FRAUD_VELOCITY_COUNTERS(ConsistencyLevel.CAUSAL,
        "Must reflect your own recent transactions; global sync within 500ms");
}
```

### Practical Implementation of Consistency Boundaries

```java
// The account balance must be strongly consistent.
// Use a single-master database with synchronous replication for reads.
@Repository
public class StronglyConsistentAccountRepository {

    private final JdbcTemplate primaryJdbc;   // Always read from primary

    @Transactional(isolation = Isolation.SERIALIZABLE)
    public Optional<Account> findAndLockForUpdate(String accountId) {
        return primaryJdbc.query(
            // SELECT FOR UPDATE prevents concurrent balance modifications
            "SELECT * FROM accounts WHERE account_id = ? FOR UPDATE NOWAIT",
            accountRowMapper, accountId
        ).stream().findFirst();
    }
}

// Transaction history can tolerate eventual consistency.
// Read from read replicas to reduce load on primary.
@Repository
public class EventuallyConsistentTransactionRepository {

    private final JdbcTemplate replicaJdbc;   // Safe to read from replica

    public List<Transaction> getHistory(String accountId, DateRange range) {
        return replicaJdbc.query(
            "SELECT * FROM transactions WHERE account_id = ? " +
            "AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 100",
            transactionRowMapper,
            accountId, range.from(), range.to()
        );
    }
}
```

---

## Fitness Functions

Fitness functions are automated tests that verify architectural properties are maintained over time. They prevent the common pattern of "we decided on this architecture but it has drifted".

```java
// ArchUnit tests as fitness functions for the payment service architecture
// Run these in CI on every commit — treat failures as build failures

@AnalyzeClasses(packages = "com.fintech.payment",
                importOptions = {ImportOption.DoNotIncludeTests.class})
class ArchitectureFitnessFunctions {

    @ArchTest
    static final ArchRule hexagonalArchitectureEnforced =
        layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("Domain")      .definedBy("..domain..")
            .layer("Application") .definedBy("..application..")
            .layer("Adapters")    .definedBy("..adapter..")
            .whereLayer("Domain")      .mayNotAccessAnyLayer()
            .whereLayer("Application") .mayOnlyAccessLayers("Domain")
            .whereLayer("Adapters")    .mayOnlyAccessLayers("Application", "Domain");

    @ArchTest
    static final ArchRule noDomainDependenciesOnFrameworks =
        noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat()
            .resideInAPackage("org.springframework..")
            .because("Domain model must be framework-independent");

    @ArchTest
    static final ArchRule repositoriesNotCalledFromDomainModel =
        noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat()
            .haveSimpleNameEndingWith("Repository")
            .because("Domain model must not depend on persistence layer");

    @ArchTest
    static final ArchRule noCircularDependencies =
        slices().matching("com.fintech.payment.(*)..").should().beFreeOfCycles();

    @ArchTest
    static final ArchRule entityClassesNotExposedInRestLayer =
        noClasses()
            .that().resideInAPackage("..adapter.rest..")
            .should().dependOnClassesThat()
            .areAnnotatedWith(Entity.class)
            .because("REST layer must use DTOs, not JPA entities directly");
}
```

---

## Architecture Decision Records (ADRs)

A decision is only as good as its documentation. ADRs are the standard format for recording decisions in a durable, reviewable form.

```markdown
# ADR-0023: Use Outbox Pattern for Payment Event Publishing

## Status
Accepted — 2024-03-15

## Context
The payment service needs to publish `PaymentSubmittedEvent` to Kafka after a
payment is persisted. We explored two approaches:

1. Direct Kafka publish within the payment transaction
2. Transactional outbox pattern

## Decision Drivers
- We cannot afford to publish an event for a payment that was not committed
- We cannot afford to commit a payment without eventually publishing the event
- The payment database (PostgreSQL) is the system of record
- Event publishing must survive application restarts

## Considered Options

### Option 1: Direct publish within transaction
Publish to Kafka before committing the database transaction.
- Risk: Kafka publish succeeds but database rollback occurs — phantom events
- Risk: Database commits but Kafka is unavailable — lost events

### Option 2: Transactional Outbox
Write events to an `outbox` table in the same database transaction as the
payment. A separate relay process publishes from outbox to Kafka.
- Benefit: Atomicity guaranteed by database transaction
- Benefit: Kafka outage does not affect payment submission
- Cost: Additional relay component; at-least-once delivery requires consumers
  to handle duplicates (idempotency keys)

## Decision
We adopt the **Transactional Outbox Pattern** (Option 2) using Debezium as
the CDC relay. Consumers must handle duplicate events using the event's
`eventId` as an idempotency key.

## Consequences
- Payment event consumers MUST implement idempotency on `eventId`
- The outbox table must be monitored for lag; alert if lag > 30 seconds
- Debezium connector configuration is owned by the payments team

## Review Trigger
Revisit if: event publishing lag consistently exceeds 5 seconds in production,
or if Debezium operational overhead becomes significant.
```

---

## Decision Anti-Patterns to Avoid

**1. Resume-Driven Architecture**
Choosing Kafka, Kubernetes, service mesh, or any other technology because it looks impressive — not because the problem demands it. This introduces operational complexity that the team then has to maintain for years.

**2. Cargo-Cult Architecture**
"Netflix/Uber/Revolut uses microservices, therefore we should too." These companies built their architectures in response to specific scale problems they had at specific points in their growth. Their architecture is the answer to their question, not yours.

**3. Architecture by Consensus**
Requiring unanimous agreement for every architectural decision leads to either decision paralysis or mediocre compromises that please no one and satisfy no constraints. The principal engineer's job is to decide, not to build consensus for its own sake.

**4. Optimising for the Exceptional Case**
Designing the entire system for the 99.999th percentile load event that may happen once every five years. Financial systems need to handle expected scale reliably; the marginal engineering cost of handling 100x unexpected scale is usually not justified by the probability.

**5. Ignoring Operational Complexity**
Every architectural decision adds to the operational burden. A system that requires three different types of database, four messaging systems, and two cache layers is not sophisticated — it is expensive. Count the number of different technologies your on-call engineer needs to understand at 2 AM.

---

## A Decision Checklist for Principal Engineers

Before approving or proposing a significant architectural change:

```
1. PROBLEM CLARITY
   [ ] Can you describe the problem in one sentence without naming a technology?
   [ ] Have you confirmed the problem exists with data, not anecdote?
   [ ] Do you understand why this problem exists now (and not 2 years ago)?

2. OPTION SPACE
   [ ] Have you considered at least 3 materially different options?
   [ ] Have you considered "do nothing" as a valid option?
   [ ] Have you considered a simpler version of your preferred option?

3. TRADE-OFF ANALYSIS
   [ ] Have you identified the top 3 risks of your preferred option?
   [ ] Have you identified what you are sacrificing to gain what you want?
   [ ] Have you stress-tested against: team turnover, 10x scale, regulatory change?

4. REVERSIBILITY
   [ ] Is this decision easily reversible? (If yes: proceed; don't over-analyse)
   [ ] If irreversible: have you given the decision proportional rigour?
   [ ] What is the rollback plan if this proves wrong in 12 months?

5. STAKEHOLDER ALIGNMENT
   [ ] Do the engineers who will implement this understand the rationale?
   [ ] Does the product/business owner understand the implications?
   [ ] Are there regulatory/compliance implications that need sign-off?

6. DOCUMENTATION
   [ ] Is there an ADR (Architecture Decision Record) capturing the decision?
   [ ] Are the review trigger conditions specified?
   [ ] Who owns this decision going forward?
```

---

## Common Pitfalls

**Mistaking Complexity for Sophistication**
Reviewers sometimes equate a more complex design with a better one. A principal engineer's job includes articulating why a simpler solution is superior when it is. "We could add a service mesh but here is why the problem does not require it" is a principal-level contribution.

**Making Decisions in a Vacuum**
Architecture decisions in financial services have compliance, security, and operational implications beyond the technical. Involving a compliance architect or security engineer early prevents the painful and expensive retrofitting of controls after the fact.

**Not Defining Success Criteria**
"We will migrate to the new payment service" is not a success criterion. "The new payment service processes 100% of GBP domestic payments with P99 latency below 200ms and zero dual-run discrepancies for 30 consecutive days" is a success criterion. Without measurable criteria, you cannot know when you're done.

---

## Production Tips

**Keep an Architecture Radar**
Maintain a living document that categorises technologies across your platform into Adopt, Trial, Assess, and Hold. Update it quarterly. This prevents teams from introducing new technologies ad hoc and gives new engineers a clear view of the technical landscape.

**Write ADRs for Decisions You Decided Not to Make**
"We considered introducing GraphQL and decided against it because..." is as valuable as a positive decision. Future engineers will re-evaluate the same options; a negative ADR saves them the investigation and communicates the reasoning.

**Distinguish Between Local and Global Optima**
A decision that is optimal for one team's service may impose costs on other teams through shared infrastructure, data contracts, or operational burden. Principal engineers are the people positioned to see these cross-team impacts and account for them.

**Use Fitness Functions, Not Code Reviews, to Enforce Architecture**
Code reviews that check architectural compliance are inconsistent and don't scale. ArchUnit fitness functions that run in CI on every commit are consistent and automatic. Document the architectural rules, then automate their enforcement.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A team proposes introducing Kafka because 'Netflix uses it.' Which decision anti-pattern does this represent, and what should a principal engineer ask first?",
      "options": [
        "Resume-driven architecture — the team wants Kafka for career development. The principal engineer should ask about team Kafka expertise.",
        "Cargo-cult architecture — adopting a technology because a large company uses it, not because the specific problem demands it. The principal engineer should first ask what the actual throughput, ordering, and replay requirement is.",
        "Architecture by consensus — the team is not aligned on the technology choice. The principal engineer should call a meeting to reach unanimous agreement.",
        "Optimising for the exceptional case — the team is designing for Netflix-scale traffic. The principal engineer should provide current traffic metrics."
      ],
      "correct": 1,
      "explanation": "This is cargo-cult architecture — adopting a technology because another company uses it, not because the problem requires it. Netflix/Uber/Revolut built their architectures in response to specific scale problems at specific growth stages. The correct first question is: what is the actual throughput, ordering, and replay requirement? The answer often reveals that simpler alternatives (a database queue, SQS) are sufficient."
    },
    {
      "text": "According to the principal engineer's decision checklist, which condition makes a decision reversible and therefore appropriate for less rigorous analysis?",
      "options": [
        "The decision affects only one service and no cross-team interfaces.",
        "The decision can be easily undone without data migration, significant engineering effort, or external dependencies.",
        "The decision is owned by a single engineer rather than requiring committee approval.",
        "The decision involves a technology the team has previously used in production."
      ],
      "correct": 1,
      "explanation": "A reversible decision is one that can be undone without major cost — no data migration, no contract changes with other teams, no large engineering effort. Reversible decisions warrant less rigorous analysis because mistakes are cheap to correct. Irreversible decisions (database engine selection, messaging platform, public API contracts) deserve proportional rigour because mistakes are expensive to fix."
    },
    {
      "text": "A payment service's account balance reads and transaction history reads are both handled by the same database setup. The team proposes routing all reads to a PostgreSQL read replica for performance. What is the most important question a principal engineer must ask before approving this change?",
      "options": [
        "What is the replication lag on the read replica under peak load?",
        "Which reads require strong consistency (like balance reads for payment authorisation) and which can tolerate eventual consistency (like transaction history display)?",
        "Does the read replica have the same indexes as the primary to ensure query performance is equivalent?",
        "Is the read replica in the same availability zone as the primary to minimise replication lag?"
      ],
      "correct": 1,
      "explanation": "The most important question is which reads require strong consistency. Account balance reads for payment authorisation must be strongly consistent — routing them to a read replica can allow a customer to spend money they do not have if the replica lags during high-write periods. Transaction history reads can tolerate eventual consistency. A blanket 'route all reads to replica' decision without this analysis is a consistency model error that can cause financial harm."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Apply the Architecture Decision Framework to Real-World Scenarios",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "Using the MicroservicesReadinessAssessment scoring framework, evaluate a greenfield fintech product with a team of 8 engineers, an undiscovered domain model, no existing distributed systems infrastructure, and a regulatory surface shared across all features. Score each criterion from 1 to 5 and derive the recommendation. Write a one-page ADR documenting the decision, the scoring rationale, and the conditions under which this decision should be revisited."},
    {"id": "2", "description": "A payment service must call a fraud check service before authorising payments, and also publish audit events to a compliance reporting system. Apply the sync vs async decision framework to both integrations. Write a PaymentOrchestrationService that uses synchronous REST for fraud checks (which block the authorisation response) and asynchronous Kafka events for compliance reporting (which the customer does not wait for). Write unit tests for each integration path."},
    {"id": "3", "description": "Write a complete set of ArchUnit fitness functions for a payment service that enforce: (a) hexagonal architecture layers, (b) no domain dependencies on Spring or JPA, (c) no repository calls from domain model classes, (d) no circular dependencies between slices, and (e) JPA @Entity classes not exposed directly in REST controllers. Configure the tests to run in CI with ImportOption.DoNotIncludeTests and treat failures as build failures."},
    {"id": "4", "description": "Identify three architectural decisions in your current or most recent system that do not have documented success criteria. For each, write a one-paragraph success criterion following the pattern: 'The [component] processes [scope] with [latency SLA] and [error rate SLA] for [duration] under [conditions].' Then write an ADR for the most architecturally significant of the three decisions, including the decision anti-patterns that were avoided and why."}
  ]
}
-->
