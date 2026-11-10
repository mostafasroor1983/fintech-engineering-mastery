---
id: track-01-lesson-01
title: "Evolutionary Architecture — Fitness Functions and Technical Debt"
slug: evolutionary-architecture
track: track-01
trackName: Advanced Software Architecture
sequence: 1
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [evolutionary-architecture, fitness-functions, technical-debt, ADR]
prerequisites: []
---

# Evolutionary Architecture — Fitness Functions and Technical Debt

> [!NOTE]
> This lesson introduces evolutionary architecture as a disciplined approach to building systems that can change safely over time — a critical capability for long-lived financial platforms.

## Why Architecture Must Evolve

No financial system is designed once and left unchanged. Regulatory mandates arrive unexpectedly. Acquisition targets must be integrated. Traffic patterns shift with product launches. The systems that survive at scale are not the ones with the most carefully planned initial design — they are the ones built to absorb change without breaking.

**Evolutionary architecture** is the practice of designing systems to support *guided, incremental change* across multiple dimensions simultaneously, while preserving essential characteristics.

The three dimensions of change that principal engineers must manage:

| Dimension | Examples | Risk if ignored |
|---|---|---|
| **Technical** | Language versions, frameworks, protocols | Security vulnerabilities, performance cliffs |
| **Domain** | Business rules, product features, compliance | Accidental coupling, stiff-join problems |
| **Operational** | Deployment targets, cloud providers, SRE tooling | Vendor lock-in, migration risk |

---

## Fitness Functions — Executable Architectural Tests

The central mechanism of evolutionary architecture is the **fitness function**: an objective function used to assess how well a proposed change preserves a desired architectural characteristic.

Fitness functions are not new tests — they are a *classification* of tests that guard architectural properties.

```mermaid
graph LR
    A[Code Change] --> B{CI Pipeline}
    B --> C[Unit Tests]
    B --> D[Integration Tests]
    B --> E[Fitness Functions]
    E --> F[Coupling Check]
    E --> G[Performance Budget]
    E --> H[Dependency Governance]
    E --> I[Security Boundaries]
    F & G & H & I --> J{Gate}
    J -->|Pass| K[Deployment]
    J -->|Fail| L[Blocked — ADR Required]
```

### Categories of Fitness Functions

**Atomic fitness functions** run against a single component in isolation:

```java
// Dependency governance: payment module must not import fraud module directly
@Test
void paymentModule_mustNotDependOnFraudModule() {
    JavaClasses classes = new ClassFileImporter()
        .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
        .importPackages("com.bank.payment");

    noClasses()
        .that().resideInAPackage("com.bank.payment..")
        .should().dependOnClassesThat()
        .resideInAPackage("com.bank.fraud..")
        .check(classes);
}
```

**Holistic fitness functions** assess system-wide properties, typically executed in a staging environment:

```java
// Performance budget: P99 payment submission must stay under 200ms
@Test
void paymentSubmission_p99Latency_mustBeUnder200ms() throws Exception {
    GatlingRunner runner = GatlingRunner.forSimulation(PaymentSubmissionSimulation.class)
        .withUsers(500)
        .withDuration(Duration.ofMinutes(5));

    SimulationResult result = runner.run();
    
    assertThat(result.percentile(99))
        .as("P99 latency SLO")
        .isLessThanOrEqualTo(Duration.ofMillis(200));
}
```

**Triggered fitness functions** run when specific conditions change:

```java
// Schema compatibility: new Avro schema must be backward compatible
@Test
void paymentEvent_newSchemaVersion_mustBeBackwardCompatible() {
    SchemaRegistryClient client = new MockSchemaRegistryClient();
    AvroSchemaCompatibility checker = new AvroSchemaCompatibility();
    
    Schema currentSchema = loadSchema("payment-event-v2.avsc");
    Schema proposedSchema = loadSchema("payment-event-v3.avsc");
    
    assertThat(checker.isBackwardCompatible(currentSchema, proposedSchema))
        .as("Schema backward compatibility")
        .isTrue();
}
```

---

## Technical Debt as Architectural Risk

Technical debt is not a metaphor — it is a measurable drag on architectural fitness. Principal engineers must move beyond the intuitive "we have debt" to quantified assessments that influence prioritisation.

### Debt Taxonomy for Financial Systems

```mermaid
graph TD
    TD[Technical Debt] --> D1[Deliberate]
    TD --> D2[Inadvertent]
    D1 --> D1a[Prudent: Ship now, refactor post-launch]
    D1 --> D1b[Reckless: Skip design for speed]
    D2 --> D2a[Prudent: Learned better patterns later]
    D2 --> D2b[Reckless: Didn't know what we were doing]

    style D1a fill:#166534,color:#fff
    style D2a fill:#166534,color:#fff
    style D1b fill:#991b1b,color:#fff
    style D2b fill:#991b1b,color:#fff
```

The four quadrants come from Ward Cunningham and Martin Fowler. As a principal engineer, your job is to prevent the reckless quadrants and consciously manage the prudent ones.

### Measuring Architectural Coupling

**Afferent coupling (Ca)** — how many components depend *on* this component. High Ca = high impact of change.

**Efferent coupling (Ce)** — how many components this component depends *on*. High Ce = fragile, many reasons to change.

**Instability (I)** = Ce / (Ca + Ce). Components with high instability (I → 1) should be abstract; components with low instability (I → 0) should be stable.

```java
// ArchUnit: measure instability of core domain packages
@Test
void corePaymentDomain_mustBeStable() {
    JavaClasses classes = new ClassFileImporter()
        .importPackages("com.bank");

    // Packages in the core domain should have many dependants (low Ce)
    // and few dependencies themselves
    SlicesRuleDefinition.slices()
        .matching("com.bank.(*)..")
        .should().notDependOnEachOther()
        .ignoringPackages("com.bank.shared..")
        .check(classes);
}
```

### Technical Debt Prioritisation Matrix

| Debt Type | Business Risk | Effort | Priority |
|---|---|---|---|
| Security vulnerability in auth | Critical | Low | Immediate |
| Shared mutable state in payment engine | High | High | Sprint planning |
| Missing integration test coverage | Medium | Medium | Backlog |
| Outdated documentation | Low | Low | Whenever |
| Framework version lag (< 1 major) | Low | Medium | Quarterly |
| Framework version lag (> 2 major) | High | High | Roadmap item |

---

## Architectural Decision Records (ADRs)

The fitness function enforces what you have decided. The ADR explains *why* you decided it. Without the ADR, future engineers will remove the fitness function when it fails, not understanding its purpose.

An ADR answers four questions:
1. **Context** — What situation forced a decision?
2. **Decision** — What did we choose?
3. **Consequences** — What do we gain? What do we trade off?
4. **Status** — Is this current, superseded, or deprecated?

```markdown
# ADR-0023: Use Optimistic Locking for Account Balance Updates

**Status:** Accepted (2024-11-15)
**Authors:** Principal Engineer, Lead Engineer — Payments

## Context
Account balance updates currently use SELECT FOR UPDATE (pessimistic locking).
Under our projected Q1 load (50k TPS), this creates lock contention on 
high-velocity accounts (salary day, bill payment windows).

## Decision
Use @Version-based optimistic locking with a bounded retry policy (max 3 
attempts with 10ms exponential backoff). Revert to pessimistic locking only
for multi-account operations where deadlock ordering cannot be guaranteed.

## Consequences
**Gains:** Eliminates lock contention on read-heavy workloads. Scales 
horizontally without inter-node locking.
**Trade-offs:** Application-level retry logic required. Starvation possible
for high-contention accounts during peak windows (mitigated by backoff jitter).
**Fitness function added:** ConcurrentBalanceUpdateTest validates retry behaviour.
```

---

## Applying Evolutionary Architecture to Legacy Financial Systems

The most common scenario you will face is not greenfield design — it is modernising a legacy core banking system while it continues processing £5B/day.

### The Strangler Fig Strategy

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant Legacy as Legacy Core
    participant New as New Service

    Note over Proxy: Phase 1 — Passthrough
    Client->>Proxy: POST /payments
    Proxy->>Legacy: Forward 100%
    Legacy-->>Proxy: Response
    Proxy-->>Client: Response

    Note over Proxy: Phase 2 — Shadow
    Client->>Proxy: POST /payments
    Proxy->>Legacy: Forward 100%
    Proxy->>New: Mirror (async, discard response)
    Legacy-->>Proxy: Response
    Proxy-->>Client: Response

    Note over Proxy: Phase 3 — Canary
    Client->>Proxy: POST /payments
    alt 10% traffic
        Proxy->>New: Route to new service
        New-->>Proxy: Response
    else 90% traffic
        Proxy->>Legacy: Forward to legacy
        Legacy-->>Proxy: Response
    end
    Proxy-->>Client: Response

    Note over Proxy: Phase 4 — Cutover
    Client->>Proxy: POST /payments
    Proxy->>New: Route 100%
    New-->>Proxy: Response
    Proxy-->>Client: Response
```

Each phase is a fitness function gate. You do not advance to the next phase until the current one passes defined acceptance criteria — error rate parity, latency parity, reconciliation match.

### Fitness Functions for Migration Safety

```java
// Reconciliation fitness function: new service must match legacy output
@Test
void shadowMode_newPaymentService_mustMatchLegacyForAllRequests() {
    ShadowTestHarness harness = ShadowTestHarness.builder()
        .withLegacy(legacyPaymentService)
        .withCandidate(newPaymentService)
        .withSampleSize(10_000)
        .build();

    ShadowResult result = harness.runComparison(paymentRequestCorpus);

    assertThat(result.mismatchRate())
        .as("Shadow comparison mismatch rate")
        .isLessThan(0.001); // <0.1% acceptable during canary
    
    assertThat(result.candidateErrorRate())
        .as("New service error rate must not exceed legacy")
        .isLessThanOrEqualTo(result.legacyErrorRate() * 1.05);
}
```

---

## Principal Engineer Checklist — Evolutionary Architecture

Before approving any significant architectural change to a financial system:

- [ ] **Fitness functions exist** for all stated architectural characteristics (performance, security, coupling)
- [ ] **ADR written** explaining the decision, context, and trade-offs
- [ ] **Debt quadrant identified** — is new debt deliberate or inadvertent? Is it prudent or reckless?
- [ ] **Migration path defined** — if replacing existing behaviour, is there a strangler fig plan?
- [ ] **Rollback documented** — what is the rollback procedure if the change fails in production?
- [ ] **Coupling measured** — does this change increase instability in stable components?
- [ ] **Compliance reviewed** — does this affect audit trail, data residency, or regulatory boundaries?

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "A fitness function fails in CI for a module that hasn't changed. The CI failure is blocking a release. What should you do?",
      "options": [
        "Temporarily disable the fitness function to unblock the release",
        "Investigate why the fitness function now fails — an environmental or dependency change may have violated the architectural constraint",
        "Delete the fitness function since it's unreliable",
        "Increase the threshold so the test passes"
      ],
      "correct": 1,
      "explanation": "A fitness function failing without code changes indicates an external change (dependency upgrade, environment drift) has violated the architectural constraint. The correct response is investigation, not suppression. Disabling or deleting the function defeats its purpose."
    },
    {
      "id": "q2",
      "text": "You are measuring instability (I = Ce / (Ca + Ce)) for your payment domain module. It scores 0.85. What does this indicate?",
      "options": [
        "The module is highly stable and should not be changed",
        "The module has many dependants and must be carefully versioned",
        "The module depends on many other components and is at high risk of needing to change when they do",
        "The module has low coupling and is safe to evolve freely"
      ],
      "correct": 2,
      "explanation": "I = 0.85 means Ce >> Ca — the module depends on many others but few depend on it. This is a highly unstable (fragile) module that changes whenever its dependencies do. High-instability components should be abstract or at the edges of the system."
    },
    {
      "id": "q3",
      "text": "During a Strangler Fig migration in Phase 2 (shadow mode), the new service has a 2% error rate compared to the legacy system's 0.1%. What is the correct action?",
      "options": [
        "Proceed to Phase 3 (canary) since 2% is acceptable for shadow traffic",
        "Halt the migration and investigate the new service's errors before advancing",
        "Increase the shadow traffic percentage to gather more data",
        "Accept the error rate differential since shadow responses are discarded"
      ],
      "correct": 1,
      "explanation": "Shadow traffic errors are discarded from the client perspective, but a 20x higher error rate signals the new service is not equivalent to the legacy. Advancing to canary would expose real users to those errors. The shadow phase exists precisely to catch this — halt and fix before proceeding."
    },
    {
      "id": "q4",
      "text": "An engineer proposes removing a fitness function that checks for circular dependencies between bounded contexts, arguing it generates false positives. What is your response as the principal engineer?",
      "options": [
        "Agree — fitness functions that cause friction should be removed",
        "Investigate the false positives: if the architecture has legitimately changed, update the ADR and the fitness function; don't remove it",
        "Move the fitness function to run weekly instead of on every CI run",
        "Replace it with a code review checklist item"
      ],
      "correct": 1,
      "explanation": "False positives mean either the fitness function is wrong or the architecture has changed without an ADR. The correct response is to update both the fitness function and the ADR to reflect current decisions — not to remove the guard. A code review checklist does not provide the same automated enforcement."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
## Practical Challenge

**Scenario:** You join a fintech as the new principal engineer. The payment processing service has accumulated significant technical debt over 3 years. Your task is to introduce evolutionary architecture practices.

**Tasks:**

1. **Write an ArchUnit fitness function** that enforces the rule: no class in `com.bank.payment.domain` may depend on `com.bank.payment.infrastructure` (domain must not know about infrastructure).

2. **Calculate instability** for a module with 12 efferent couplings and 3 afferent couplings. Is this component stable or unstable? What should you do about it?

3. **Write an ADR** for a decision to introduce an anti-corruption layer between your payment service and a legacy SWIFT adapter. Use the four-question format (Context, Decision, Consequences, Status).

4. **Design a fitness function** that verifies your payment API's P95 latency stays under 150ms under load of 1,000 concurrent users. What tool would you use? What does the CI gate look like?

5. **Classify this debt:** "We use String concatenation to build SQL queries in 3 classes — we knew at the time it was wrong but were 2 days from a demo." Which quadrant does this fall into, and what is your prioritisation recommendation?
-->
