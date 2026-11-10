---
id: track-01-lesson-02
title: "Architectural Decision Records — The ADR Practice"
slug: adr-practice
track: track-01
trackName: "Advanced Software Architecture"
sequence: 2
difficulty: advanced
estimatedMinutes: 70
status: published
tags:
  - ADR
  - MADR
  - architecture-decision
  - documentation
  - RFC
---

# Architectural Decision Records — The ADR Practice

Architecture decisions are the most expensive thing software teams make and the least well-documented. This lesson teaches you to capture, govern, and evolve architectural decisions using the MADR format, adr-tools, Backstage integration, and CI enforcement — all grounded in fintech production experience.

---

## 1. The "Why Didn't They Just…?" Problem

Every engineer who inherits a codebase eventually asks *why didn't they just use Kafka instead of this custom queue?* The answer is almost always locked inside someone's head or buried in a Confluence page nobody can find. The cost compounds:

- Senior engineers spend 20–40 % of onboarding time reverse-engineering past decisions
- Teams repeat expensive spikes that were already done three years ago
- Incidents caused by misunderstood constraints (e.g., "this table must never be truncated") go undetected until production blows up
- Regulatory audits (PCI-DSS, SOC 2) demand evidence of *why* controls are in place — undocumented decisions become findings

```
                    COST OF UNDOCUMENTED DECISIONS
                    ================================

  Time since decision ─────────────────────────────────►

  Reconstruct │███████████████████████████████████████
  cost        │
              │          Documented │░░░░░░░░░░░░░░░░
              │          Undocumented │████████████████████████
              │
              │     6 mo    1 yr    2 yr    3 yr    5 yr
```

Architectural Decision Records (ADRs) are short, structured documents that answer: *what* was decided, *why* that option was chosen over alternatives, and *what* we were willing to give up.

---

## 2. RFC vs ADR — When to Use Each

RFCs (Request for Comments) and ADRs are complementary, not competing.

| Dimension | RFC | ADR |
|---|---|---|
| Timing | Before the decision | After the decision is made |
| Purpose | Gather input, build consensus | Record outcome and rationale |
| Audience | Decision-makers + stakeholders | Future engineers maintaining the system |
| Length | 2–10 pages | 1–2 pages |
| Lifecycle | Accepted / Rejected / Withdrawn | Proposed / Accepted / Deprecated / Superseded / Rejected |
| Owner | Author (lead engineer / principal) | The team that owns the component |

The workflow is:

```
  New architectural need
         │
         ▼
  Write RFC (optional for small teams)
  Circulate for comment (async 48 h)
         │
         ├─── Approved ───► Write ADR (outcome summary)
         │                       │
         ├─── Rejected ──────────┤  (ADR status: REJECTED)
         │                       │
         └─── Withdrawn ─────────┘  (ADR status: SUPERSEDED)
```

**Rule of thumb for fintech:** Any decision that affects data durability, consistency guarantees, PCI scope, or availability SLAs deserves an ADR even if no RFC was written.

---

## 3. MADR Format in Full Detail

MADR (Markdown Any Decision Record) is the most widely-adopted ADR template. It is machine-readable, diff-friendly, and renders cleanly in GitHub / GitLab.

### 3.1 Template

```markdown
# [short title of solved problem and solution]

**Date:** YYYY-MM-DD
**Status:** [Proposed | Accepted | Deprecated | Superseded | Rejected]
**Supersedes:** [ADR-NNN] (if applicable)
**Superseded by:** [ADR-NNN] (if applicable)

## Context and Problem Statement

[Describe the context and problem clearly. What forces are at play?
What constraints are non-negotiable?]

## Decision Drivers

* [force 1]
* [force 2]
* [force 3]

## Considered Options

* [option 1]
* [option 2]
* [option 3]

## Decision Outcome

**Chosen option: [option X]**, because [justification — why this option
best satisfies the decision drivers].

### Positive Consequences

* [positive consequence 1]

### Negative Consequences

* [negative consequence 1]

## Pros and Cons of the Options

### [option 1]

[Description]

* Good, because [argument a]
* Bad, because [argument b]

### [option 2]
...
```

### 3.2 Worked Example — PostgreSQL vs MongoDB for a Payments Ledger

```markdown
# ADR-0012: Use PostgreSQL for the Payments Ledger

**Date:** 2024-03-15
**Status:** Accepted
**Supersedes:** N/A

## Context and Problem Statement

The new ledger service must store immutable double-entry bookkeeping
records for 50 M+ transactions per year. Each entry must reference
accounts, currencies, exchange rates, and audit metadata.
We need ACID guarantees across multi-row inserts (debit + credit must
both succeed or both fail). The team is evaluating PostgreSQL 16 vs
MongoDB 7.

## Decision Drivers

* Strict ACID semantics for double-entry inserts
* Complex query patterns: balance-at-point-in-time, monthly roll-ups
* PCI-DSS requirement for field-level encryption (column encryption)
* Team has 4 engineers with 5+ years Postgres experience; 0 with Mongo
* 99.99 % uptime SLA — primary + 2 async replicas minimum

## Considered Options

* PostgreSQL 16 with logical replication
* MongoDB 7 with multi-document ACID transactions
* CockroachDB (distributed SQL)

## Decision Outcome

**Chosen option: PostgreSQL 16**, because it provides native multi-row
ACID transactions without the overhead of session-pinned distributed
transactions, the team's existing expertise reduces operational risk,
and pgcrypto satisfies the column-encryption requirement.
CockroachDB was ruled out due to 3× cost and undocumented PCI controls.

### Positive Consequences

* Balance queries can use window functions natively
* Existing runbooks for PITR, pgBouncer, and Patroni apply directly
* Column-level encryption via pgcrypto + AWS KMS already approved by security

### Negative Consequences

* Horizontal write-sharding requires application-level partitioning if
  write throughput exceeds ~50 k TPS (acceptable for 3-year horizon)
* Schema migrations require careful expand-contract discipline

## Pros and Cons of the Options

### PostgreSQL 16

Purpose-built relational engine with 30+ years of ACID guarantees.

* Good, because multi-row transactions are first-class
* Good, because rich query planner handles complex reporting queries
* Good, because team expertise reduces onboarding risk
* Bad, because vertical scaling ceiling (~50 k TPS writes per node)

### MongoDB 7

Document store with multi-document ACID since v4.

* Good, because schema flexibility for evolving event payloads
* Bad, because distributed transaction overhead (avg +12 ms per txn)
* Bad, because column encryption requires application-side logic (not PCI-approved path)
* Bad, because no native window functions for balance aggregation

### CockroachDB

Distributed SQL with automatic sharding.

* Good, because unlimited horizontal write scaling
* Bad, because 3× infrastructure cost vs managed RDS
* Bad, because PCI compliance documentation not available for SOC 2 Type II audit
```

---

## 4. ADR Lifecycle

```
  ┌──────────┐    review     ┌──────────┐
  │ PROPOSED │──────────────►│ ACCEPTED │
  └──────────┘               └────┬─────┘
       │                          │  time passes / context changes
       │ declined                 ▼
       ▼                    ┌────────────┐    new ADR written
  ┌──────────┐              │ DEPRECATED │──────────────────►┌────────────┐
  │ REJECTED │              └────────────┘                   │ SUPERSEDED │
  └──────────┘                                               └────────────┘
```

| Status | Meaning | Action required |
|---|---|---|
| PROPOSED | Under review, decision not yet made | RFC open or awaiting principal sign-off |
| ACCEPTED | Decision in effect | Implement per the ADR |
| DEPRECATED | Decision obsolete but no replacement yet | Do not implement new work against this ADR |
| SUPERSEDED | Replaced by a newer ADR | Link `Superseded by: ADR-NNN` |
| REJECTED | Proposal not accepted | Note reason; no implementation |

---

## 5. Decision Weight Matrix

Not every choice needs an ADR. Use this matrix:

```
                 REVERSIBILITY
                 High (easy to change)   Low (costly to change)
IMPACT    Low  │ Skip                  │ Consider (1-pager)   │
          High │ Consider (1-pager)    │ REQUIRED             │
```

**Always write an ADR when:**
- The decision is hard to reverse (data model, messaging protocol, auth standard)
- It affects multiple teams or services
- It has compliance, security, or regulatory implications
- A spike or PoC was done to evaluate options

**You can skip when:**
- The decision is local to one class or module
- It follows an established pattern already captured in a higher-level ADR
- It is easily reverted with a single-day effort

---

## 6. adr-tools CLI Setup and Usage

[adr-tools](https://github.com/npryce/adr-tools) provides a command-line interface for managing ADRs in a repository.

```bash
# Install via Homebrew (macOS) or build from source
brew install adr-tools

# Initialise ADR directory in your repository
cd /path/to/your/service
adr init docs/decisions

# Creates:
# docs/decisions/0001-record-architecture-decisions.md

# Create a new ADR
adr new "Use PostgreSQL for the Payments Ledger"
# → docs/decisions/0012-use-postgresql-for-the-payments-ledger.md

# Mark an ADR as superseded
adr supersede 0012 "Use CockroachDB for Payments Ledger"

# Generate a table of contents
adr list
adr generate toc

# Generate a visual graph of ADR relationships
adr generate graph | dot -Tpng > adr-graph.png
```

### Directory convention for multi-module monorepos

```
repo-root/
  docs/
    decisions/              ← cross-cutting decisions
      0001-use-postgresql.md
      0012-fraud-async.md
  services/
    payment-service/
      docs/decisions/       ← service-specific decisions
        0001-use-stripe-sdk.md
    ledger-service/
      docs/decisions/
        0001-postgresql-ledger.md
```

---

## 7. Backstage ADR Plugin for Multi-Repo Organisations

For organisations with 10+ repositories, Backstage provides a centralised view of all ADRs via the `@backstage-community/plugin-adr` plugin.

### catalog-info.yaml annotation

```yaml
# services/payment-service/catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  annotations:
    backstage.io/adr-location: url:./docs/decisions
spec:
  type: service
  lifecycle: production
  owner: payments-team
```

### Plugin installation (Backstage app)

```typescript
// packages/app/src/App.tsx
import { AdrPage } from '@backstage-community/plugin-adr';

const routes = (
  <FlatRoutes>
    <Route path="/adrs" element={<AdrPage />} />
    {/* ... */}
  </FlatRoutes>
);
```

```typescript
// packages/app/src/components/catalog/EntityPage.tsx
import { EntityAdrContent, isAdrAvailable } from '@backstage-community/plugin-adr';

const serviceEntityPage = (
  <EntityLayout>
    <EntityLayout.Route
      path="/adrs"
      title="ADRs"
      if={isAdrAvailable}
    >
      <EntityAdrContent />
    </EntityLayout.Route>
  </EntityLayout>
);
```

This surfaces all ADRs for each component in the Backstage catalog, making cross-team discovery trivial.

---

## 8. CI Enforcement — GitHub Actions Lint Workflow

Enforce that new ADRs are well-formed and that superseded ADRs are cross-linked.

```yaml
# .github/workflows/adr-lint.yml
name: ADR Lint

on:
  pull_request:
    paths:
      - 'docs/decisions/**'
      - 'services/**/docs/decisions/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate MADR frontmatter
        run: |
          #!/usr/bin/env bash
          set -euo pipefail
          ERRORS=0
          for f in $(find . -path "*/decisions/*.md" -newer HEAD~1 2>/dev/null || \
                     git diff --name-only origin/main...HEAD | grep "decisions/.*\.md"); do
            echo "Checking $f"
            # Must contain Status line
            if ! grep -qE "^\*\*Status:\*\*" "$f"; then
              echo "ERROR: $f missing **Status:** field"
              ERRORS=$((ERRORS+1))
            fi
            # Must contain Date line
            if ! grep -qE "^\*\*Date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}" "$f"; then
              echo "ERROR: $f missing or malformed **Date:** field"
              ERRORS=$((ERRORS+1))
            fi
            # SUPERSEDED must reference a newer ADR
            if grep -qE "^\*\*Status:\*\* Superseded" "$f"; then
              if ! grep -qE "^\*\*Superseded by:\*\* ADR-[0-9]+" "$f"; then
                echo "ERROR: $f is Superseded but missing **Superseded by:** reference"
                ERRORS=$((ERRORS+1))
              fi
            fi
          done
          exit $ERRORS

      - name: Check for orphaned ADR numbers
        run: |
          # Ensure ADR filenames follow 0NNN-slug.md pattern
          find . -path "*/decisions/*.md" | \
            grep -vE "/decisions/[0-9]{4}-[a-z0-9-]+\.md$" | \
            grep -v "README" | \
            while read f; do
              echo "ERROR: $f does not follow 0NNN-slug.md naming convention"
              exit 1
            done
```

---

## 9. Linking ADRs from Code Comments

ADRs are only valuable if engineers encounter them while working. Link them from the code that implements the decision.

```java
/**
 * Ledger entry repository.
 *
 * <p>Uses PostgreSQL for all persistence — see ADR-0012 for the full
 * rationale (MongoDB and CockroachDB were evaluated and rejected).
 *
 * @see <a href="docs/decisions/0012-use-postgresql-for-the-payments-ledger.md">ADR-0012</a>
 */
@Repository
public class LedgerEntryRepository {

    // ADR-0012: double-entry inserts are wrapped in a single transaction.
    // Do NOT split debit and credit into separate transactions — this
    // was an explicit rejection criterion against MongoDB's approach.
    @Transactional
    public void record(DebitEntry debit, CreditEntry credit) {
        jdbcTemplate.update(INSERT_LEDGER_SQL, debit.toParams());
        jdbcTemplate.update(INSERT_LEDGER_SQL, credit.toParams());
    }
}
```

```java
// ADR-0017: Idempotency keys are stored in Redis with a 24-hour TTL.
// See docs/decisions/0017-idempotency-key-storage.md
// WARNING: Do not change TTL without updating ADR-0017.
private static final Duration IDEMPOTENCY_TTL = Duration.ofHours(24);
```

---

## 10. Three Fintech-Specific ADR Examples

### 10.1 ADR-0012 — Database Selection for Payments Ledger

Already shown in Section 3.2. Key takeaway: ACID multi-row transactions and column encryption drove the choice of PostgreSQL.

### 10.2 ADR-0015 — Fraud Check: Synchronous vs Asynchronous

```markdown
# ADR-0015: Run Fraud Checks Asynchronously for Low-Risk Transactions

**Date:** 2024-05-01
**Status:** Accepted

## Context and Problem Statement

The fraud detection ML model (FraudGuard v2) adds 180–220 ms p99 latency
when called synchronously in the payment authorisation path. Card network
rules require sub-300 ms responses. With existing gateway overhead (80 ms),
the synchronous call leaves only 20 ms margin — insufficient for peak load.

## Decision Drivers

* Card network sub-300 ms authorisation requirement
* Fraud detection must cover >99.5 % of transactions
* Acceptable fraud loss budget: <0.05 % of GMV

## Considered Options

* Fully synchronous (block until FraudGuard responds)
* Fully asynchronous (authorise first, cancel async if fraudulent)
* Risk-stratified: sync for high-risk, async for low-risk

## Decision Outcome

**Chosen option: Risk-stratified**, routing transactions through a rule
engine first. High-risk (>$5000, new device, foreign card) are blocked
synchronously. Low-risk bypass the synchronous call and trigger an async
review within 50 ms of authorisation.

### Negative Consequences

* ~0.3 % of low-risk transactions may need reversal if async fraud
  signal arrives within the settlement window (accepted by Risk team).
```

### 10.3 ADR-0017 — Idempotency Key Storage

```markdown
# ADR-0017: Store Idempotency Keys in Redis with PostgreSQL Fallback

**Date:** 2024-06-10
**Status:** Accepted

## Context and Problem Statement

Payment API clients retry on network failure. Without idempotency enforcement,
a client timeout can result in duplicate charges. We need sub-5 ms idempotency
checks at 20 k RPS peak load.

## Decision Drivers

* Sub-5 ms p99 idempotency lookup at 20 k RPS
* Keys must survive a Redis node failure (no duplicate charges)
* 24-hour TTL (matches maximum client retry window per API contract)

## Decision Outcome

**Chosen option: Redis (primary) + PostgreSQL write-behind (fallback).**
Redis handles the hot path. A CDC consumer writes confirmed keys to
PostgreSQL within 500 ms. On Redis cache-miss, the service checks
PostgreSQL before proceeding. TTL is enforced by both Redis expiry
and a nightly PostgreSQL purge job.
```

---

## 11. Building Culture Around ADRs

### The Principal Engineer's Role

Principal engineers are the most important lever for ADR adoption. Their responsibilities:

1. **Lead by example** — write the first 3–5 ADRs for each domain they touch
2. **Review gate** — make ADR presence a PR review criterion for consequential changes
3. **Retrospective hook** — when a production incident traces to an undocumented assumption, write a *retrospective ADR* capturing what was implicitly decided and why it was wrong
4. **Onboarding anchor** — point new engineers to ADR index as the first stop in onboarding

### Anti-Patterns to Avoid

```
ANTI-PATTERN 1: The Rubber-Stamp ADR
--------------------------------------
Symptoms: ADR written after implementation, options section is empty
         or contains obviously strawman alternatives.
Fix: ADR must be written before code is merged. The PR that
     implements the decision must link the ADR.

ANTI-PATTERN 2: The Novel
--------------------------------------
Symptoms: ADR is 15 pages with appendices, nobody reads it.
Fix: 1–2 pages maximum. Link to separate design docs for depth.

ANTI-PATTERN 3: The Oracle
--------------------------------------
Symptoms: Only the principal engineer writes ADRs; team feels
         they need "permission" to document decisions.
Fix: Any engineer can propose an ADR. The principal approves,
     not authors.

ANTI-PATTERN 4: The Graveyard
--------------------------------------
Symptoms: ADRs exist but are never updated or referenced.
Fix: CI lint + quarterly ADR review in architecture guild.
```

### Java utility: ADR reference validator at startup

```java
/**
 * On application startup, verifies that all ADR references in
 * @AdrReference annotations resolve to files that exist on the
 * classpath or the configured docs path.
 *
 * Fails fast if an ADR file is missing — prevents silent link rot.
 */
@Component
public class AdrReferenceValidator implements ApplicationRunner {

    private static final Logger log =
        LoggerFactory.getLogger(AdrReferenceValidator.class);

    @Value("${adr.docs-path:docs/decisions}")
    private String docsPath;

    @Override
    public void run(ApplicationArguments args) {
        List<String> missing = new ArrayList<>();
        ClassPathScanningCandidateComponentProvider scanner =
            new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(AdrReference.class));

        for (BeanDefinition bd : scanner.findCandidateComponents("com.example")) {
            try {
                Class<?> clazz = Class.forName(bd.getBeanClassName());
                AdrReference ref = clazz.getAnnotation(AdrReference.class);
                if (ref != null) {
                    Path adrFile = Path.of(docsPath, ref.value() + ".md");
                    if (!Files.exists(adrFile)) {
                        missing.add(clazz.getSimpleName() + " → " + adrFile);
                    }
                }
            } catch (ClassNotFoundException e) {
                log.warn("Could not inspect class {}", bd.getBeanClassName());
            }
        }

        if (!missing.isEmpty()) {
            throw new IllegalStateException(
                "ADR files referenced in code are missing:\n" +
                String.join("\n", missing));
        }
        log.info("ADR reference validation passed ({} annotations checked)",
            scanner.findCandidateComponents("com.example").size());
    }
}

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface AdrReference {
    /** ADR filename without .md extension, e.g. "0012-use-postgresql-for-the-payments-ledger" */
    String value();
}
```

---

## 12. Production Pitfalls

### Pitfall 1: Decisions scattered across Confluence, Notion, and GitHub

Teams use different tools for different decisions. Months later no search query finds all of them.

**Fix:** Consolidate ADRs in git (source of truth). Mirror to Confluence via Backstage techdocs if required, but git is canonical.

### Pitfall 2: ADR written in passive voice with no named decision-maker

"It was decided that…" tells future engineers nothing about who to ask for context.

**Fix:** Add `**Deciders:** @alice @bob` to MADR frontmatter. This creates accountability and a contact point for questions.

### Pitfall 3: Superseded ADRs deleted instead of marked

A deleted ADR leaves a gap in the number sequence and breaks links in code comments.

**Fix:** Never delete ADRs. Mark status as SUPERSEDED and add `**Superseded by:** ADR-NNNN`. The historical record is valuable.

### Pitfall 4: ADR numbers conflict in a monorepo with multiple teams

Two teams both write `0023-*.md` on the same day.

**Fix:** Use globally sequential numbers enforced by a CI check, or use directory-scoped numbering (`services/payment-service/decisions/0001-*.md`) with a cross-repo index.

### Pitfall 5: Compliance auditors cannot find the ADR for a specific control

PCI requirement 6.3.2 requires documented evidence of approved components.

**Fix:** Tag ADRs with compliance labels in frontmatter and generate a compliance manifest:

```bash
# Generate PCI control mapping from ADR frontmatter
grep -r "pci-req:" docs/decisions/ | \
  awk -F: '{print $3, $1}' | sort > compliance/pci-adr-mapping.txt
```

---

## 13. Checklist

- [ ] ADR directory initialised in every service repository (`adr init docs/decisions`)
- [ ] MADR template committed as `docs/decisions/0000-template.md`
- [ ] CI workflow lints ADR frontmatter on every PR that touches `docs/decisions/`
- [ ] Backstage `catalog-info.yaml` annotated with `adr-location` for each component
- [ ] All new PRs for consequential decisions link the relevant ADR in the description
- [ ] Code comments reference ADR numbers at every decision implementation site
- [ ] Superseded ADRs are cross-linked, not deleted
- [ ] Quarterly architecture guild session reviews stale ADRs
- [ ] Onboarding doc for new engineers includes ADR index as step 1
- [ ] Principal engineer has reviewed and accepted at least the first ADR for each domain
- [ ] Compliance-tagged ADRs feed the PCI/SOC 2 evidence manifest

---

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "An ADR has status SUPERSEDED. What action is required in the MADR document?",
      "options": [
        "Delete the file and renumber subsequent ADRs",
        "Add a **Superseded by: ADR-NNN** field linking to the replacement ADR",
        "Change the status field to DEPRECATED and leave the rest unchanged",
        "Move the file to an archive/ subdirectory"
      ],
      "correct": 1,
      "explanation": "MADR convention requires a **Superseded by:** field that links to the ADR that replaced it. The file must never be deleted, as historical context and inbound code links depend on it."
    },
    {
      "text": "A team is debating whether to write an ADR for a decision to rename a local helper class. What does the decision weight matrix say?",
      "options": [
        "Required — any code change affecting a class name must be documented",
        "Skip — low impact and high reversibility means an ADR adds no value",
        "Consider (1-pager) — class renames can affect consumers",
        "Required — all decisions in a fintech codebase need an ADR"
      ],
      "correct": 1,
      "explanation": "The decision weight matrix requires an ADR only when impact is high or reversibility is low. Renaming a local helper class is low impact and trivially reversible, so an ADR is wasteful overhead."
    },
    {
      "text": "What is the primary reason the payments ledger team in ADR-0012 rejected MongoDB 7?",
      "options": [
        "MongoDB does not support multi-document ACID transactions",
        "MongoDB distributed transactions add ~12 ms overhead and column encryption requires application-side logic outside the PCI-approved path",
        "The team lacked MongoDB operational expertise",
        "MongoDB cannot handle 50 M transactions per year"
      ],
      "correct": 1,
      "explanation": "The ADR explicitly states that MongoDB 7 multi-document transaction overhead averages +12 ms per transaction and that column encryption requires application-side logic, which was not the PCI-approved path. Team expertise was a secondary concern, not the primary rejection criterion."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "ADR Practice — Hands-On Implementation",
  "difficulty": "advanced",
  "estimatedMinutes": 90,
  "tasks": [
    {
      "id": "task-01",
      "description": "Initialise an ADR directory in a sample repository using adr-tools. Create ADR-0001 (record architecture decisions) and ADR-0002 for a fintech decision of your choice (e.g., choosing an event bus). Use the full MADR template with at least 3 considered options, decision drivers, and both positive and negative consequences."
    },
    {
      "id": "task-02",
      "description": "Write a GitHub Actions workflow (.github/workflows/adr-lint.yml) that validates on pull_request: (1) every new .md file under docs/decisions/ contains a **Status:** field, (2) SUPERSEDED ADRs have a **Superseded by:** cross-reference, and (3) filenames follow the 0NNN-slug.md pattern. The job must fail with a non-zero exit code on violations."
    },
    {
      "id": "task-03",
      "description": "Create the Backstage catalog-info.yaml annotation for a payment-service component pointing to its ADR directory. Then add the EntityAdrContent component to a mock EntityPage so ADRs appear as a tab in the Backstage UI. Write a brief explanation of what the isAdrAvailable guard does."
    },
    {
      "id": "task-04",
      "description": "Add @AdrReference annotations to three Java classes in a sample payment service (e.g., LedgerEntryRepository, IdempotencyFilter, FraudCheckRouter). Implement the AdrReferenceValidator ApplicationRunner from Section 11, wire it up with Spring Boot, and write a unit test that verifies the validator throws IllegalStateException when an ADR file is missing from the configured docs path."
    }
  ]
} -->
