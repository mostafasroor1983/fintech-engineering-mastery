---
id: "track-05-lesson-21"
title: "Financial Audit Trails and Immutable Ledger Design"
track: "track-05"
track-name: "Financial Transaction Integrity & Ledger Engineering"
sequence: 21
slug: "audit-trails"
difficulty: "advanced"
estimated-minutes: 70
status: "published"
last-updated: "2026-11-07"

prerequisites:
  - "track-05-lesson-01"
  - "track-05-lesson-18"

tags:
  - "audit-trail"
  - "immutable-ledger"
  - "append-only"
  - "compliance"
  - "tamper-evidence"

java-versions: [17, 21]

topics:
  - "PCI-DSS / SOX / PSD2 Compliance"
  - "Append-Only Ledger Schema"
  - "Database Enforcement with Row Security"
  - "Hash Chains for Tamper Evidence"
  - "Hibernate Envers"
  - "Operational Partitioning and Archival"

components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true

references:
  - "PCI DSS v4.0 — Requirement 10: Log and Monitor All Access to System Components"
  - "SOX Section 802 — Criminal Penalties for Altering Documents"
  - "PSD2 Article 94 — Data Protection"
  - "Hibernate Envers Documentation — Auditing Entities"
  - "PostgreSQL Documentation — Row Security Policies"
---

## Overview

A financial audit trail is not a feature — it is a legal obligation. PCI DSS requires audit logs to be protected from modification; SOX requires reliable financial records and internal controls over them; payment and anti-money-laundering rules require transaction records to be kept for defined periods. When regulators or forensic auditors examine a system after a fraud event, they will ask two questions: can you prove what happened, and can you prove that the records have not been altered? This lesson builds an audit trail that answers both questions definitively, from the database schema and permissions layer through to the cryptographic hash chain and point-in-time query API.

## Learning Objectives

By the end of this lesson you will be able to:

- Identify the regulatory drivers for immutable audit logs (PCI DSS, SOX, payment and AML record-keeping rules)
- Design an append-only ledger schema with running balance and enforce it at the database level
- Implement PostgreSQL row security and privilege revocation to prevent mutations
- Build a SHA-256 hash chain in Java that links each ledger entry to its predecessor
- Use Hibernate Envers `@Audited` and `AuditReader` for point-in-time entity queries
- Design a partition-and-archival strategy for a ledger that grows indefinitely
- Write a verification job that detects hash chain tampering

## Business Context

*Composite example:* a US payments processor faces a regulatory enforcement action after an internal fraud investigation finds that a database administrator had retroactively altered transaction timestamps to cover up a settlement timing error. The alteration was possible because the application role had `UPDATE` and `DELETE` privileges on the transaction table. No hash chain or write-once enforcement existed. The DBA's actions went undetected for 11 months because the audit log was implemented as a mutable table in the same database — also modified.

The remediation required rebuilding the entire transaction history from external bank statement feeds — months of engineering work. Had the team implemented an append-only ledger with database-enforced immutability and a cryptographic hash chain, the tampering would have been mathematically detectable on the next nightly verification run.

> [!IMPORTANT]
> The application role that writes ledger entries must never hold `UPDATE` or `DELETE` privileges on the ledger table. Immutability must be enforced by the database — not by application discipline alone.

## Append-Only Ledger Schema

The fundamental design constraint is simple: **never `UPDATE` or `DELETE` a ledger entry**. Every financial event is a new row. The running balance is computed at insert time and stored alongside the entry for fast retrieval, but the source of truth is always the full sequence of entries.

```sql
CREATE TYPE ledger_entry_type AS ENUM (
    'CREDIT',
    'DEBIT',
    'FEE',
    'INTEREST',
    'REVERSAL',
    'ADJUSTMENT'
);

CREATE TABLE ledger_entries (
    id               UUID         NOT NULL DEFAULT gen_random_uuid(),
    account_id       UUID         NOT NULL,
    entry_type       ledger_entry_type NOT NULL,
    sequence_number  BIGINT       NOT NULL,       -- 1, 2, 3 ... per account: the chain order
    amount_cents     BIGINT       NOT NULL,       -- always positive; sign from entry_type
    running_balance  BIGINT       NOT NULL,       -- balance after this entry
    previous_hash    CHAR(64)     NOT NULL,       -- SHA-256 of previous entry (hex)
    entry_hash       CHAR(64)     NOT NULL,       -- SHA-256(previous_hash || entry_data)
    transaction_ref  VARCHAR(64)  NOT NULL,       -- idempotency key / external reference
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by       VARCHAR(128) NOT NULL,       -- service account or user principal
    CONSTRAINT pk_ledger_entries PRIMARY KEY (id),
    CONSTRAINT uq_transaction_ref UNIQUE (transaction_ref),
    -- one entry per position in each account's chain: a forked chain is impossible
    CONSTRAINT uq_account_sequence UNIQUE (account_id, sequence_number),
    CONSTRAINT chk_amount_positive CHECK (amount_cents > 0)
);

-- Account + time range queries, also covering running-balance lookups
CREATE INDEX idx_ledger_account_time
    ON ledger_entries (account_id, created_at DESC)
    INCLUDE (running_balance);
```

```mermaid
erDiagram
    ACCOUNTS {
        uuid id PK
        varchar iban
        bigint balance_cents
        timestamptz updated_at
    }
    LEDGER_ENTRIES {
        uuid id PK
        uuid account_id FK
        bigint sequence_number
        ledger_entry_type entry_type
        bigint amount_cents
        bigint running_balance
        char previous_hash
        char entry_hash
        varchar transaction_ref
        timestamptz created_at
        varchar created_by
    }
    ACCOUNTS ||--o{ LEDGER_ENTRIES : "has"
```

> [!NOTE]
> `amount_cents` is always stored as a positive integer. The semantic sign (credit increases balance, debit decreases it) is derived from `entry_type`. This avoids the ambiguity of a signed amount where the caller must know the account type to interpret the sign correctly. `REVERSAL` and `ADJUSTMENT` can go either way, so those commands carry an explicit direction.

## Database Enforcement: Row Security and Privilege Revocation

Application-layer validation is insufficient. A compromised service account, a misconfigured ORM, or a direct database connection bypasses all application guards. Immutability must be enforced at the database level.

```sql
-- Step 1: Revoke mutation privileges from the application role
REVOKE UPDATE, DELETE ON ledger_entries FROM app_role;
REVOKE TRUNCATE ON ledger_entries FROM app_role;

-- Step 2: Row-level security as a belt-and-suspenders measure
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

-- Allow INSERT (new entries only) and SELECT for the application role
CREATE POLICY ledger_insert ON ledger_entries
    FOR INSERT TO app_role
    WITH CHECK (true);

CREATE POLICY ledger_select ON ledger_entries
    FOR SELECT TO app_role
    USING (true);

-- Explicitly deny UPDATE and DELETE (belt-and-suspenders)
CREATE POLICY no_update ON ledger_entries
    FOR UPDATE USING (false);

CREATE POLICY no_delete ON ledger_entries
    FOR DELETE USING (false);

-- Step 3: Grant DBA role SELECT-only for audits; separate privileged role for schema changes
GRANT SELECT ON ledger_entries TO dba_audit_role;
```

> [!WARNING]
> `FORCE ROW LEVEL SECURITY` applies policies even to the table owner. Without it, the table owner bypasses RLS. Always set both `ENABLE` and `FORCE` on audit tables. Two more rules: the application role must **not own** the table (an owner can simply grant itself the privileges back or alter the policies), and superusers and roles with `BYPASSRLS` ignore RLS completely — keep those few accounts separate, logged and tightly controlled.

## Hash Chain for Tamper Evidence

A hash chain makes tampering detectable. Each entry stores the SHA-256 hash of the previous entry's hash concatenated with the current entry's data. Altering any historical entry invalidates every subsequent hash in the chain, which a nightly verification job will detect.

One limit matters: someone who can write to the table can also *recompute* the whole chain after changing an entry. So **anchor** the chain outside the database: regularly (for example every hour) copy each account's latest `entry_hash` — or one hash over all of them — to a separate system the database administrators cannot change, such as WORM object storage, or sign it with a key held in an HSM. The verification job compares against those anchors.

```mermaid
graph LR
    G["Genesis entry\nprevious_hash = 0000...0000"]
    E1["Entry 1\nentry_hash = SHA256(genesis_hash || e1_data)"]
    E2["Entry 2\nentry_hash = SHA256(e1_hash || e2_data)"]
    E3["Entry 3\nentry_hash = SHA256(e2_hash || e3_data)"]

    G --> E1 --> E2 --> E3

    style G fill:#e0f2fe
    style E1 fill:#d1fae5
    style E2 fill:#d1fae5
    style E3 fill:#d1fae5
```

```java
@Component
@RequiredArgsConstructor
public class LedgerHashChain {

    public static final String GENESIS_HASH = "0".repeat(64);
    private static final String HASH_ALGORITHM = "SHA-256";

    /**
     * Compute the entry_hash for a new ledger entry.
     * previousHash is the entry_hash of the previous entry for this account
     * (by sequence_number), or GENESIS_HASH if this is the first entry.
     */
    public String computeEntryHash(String previousHash, LedgerEntryData data) {
        // A delimiter between fields: without it "12"+"3" and "1"+"23" hash the same
        String input = String.join("|",
            previousHash,
            data.id(),
            data.accountId(),
            Long.toString(data.sequenceNumber()),
            data.entryType(),
            Long.toString(data.amountCents()),
            Long.toString(data.runningBalance()),
            data.transactionRef(),
            data.createdAt().toString());   // Instant, truncated to microseconds
        try {
            MessageDigest digest = MessageDigest.getInstance(HASH_ALGORITHM);
            byte[] hashBytes = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hashBytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    /**
     * Verify the full hash chain for a given account.
     * entries must be ordered by sequence_number ascending.
     * Returns the index of the first broken link, or -1 if the chain is intact.
     */
    public int verifyChain(List<LedgerEntry> entriesAscending) {
        String expectedPreviousHash = GENESIS_HASH;
        for (int i = 0; i < entriesAscending.size(); i++) {
            LedgerEntry entry = entriesAscending.get(i);
            if (entry.getSequenceNumber() != i + 1                      // a deleted entry
                    || !entry.getPreviousHash().equals(expectedPreviousHash)) {
                return i;
            }
            String recomputedHash = computeEntryHash(
                expectedPreviousHash,
                LedgerEntryData.from(entry));
            if (!recomputedHash.equals(entry.getEntryHash())) {
                return i;
            }
            expectedPreviousHash = entry.getEntryHash();
        }
        return -1; // chain intact (then compare the last hash with the external anchor)
    }
}
```

```java
@Service
@RequiredArgsConstructor
public class LedgerEntryWriter {

    private final LedgerEntryRepository repository;
    private final AccountRepository     accountRepository;
    private final LedgerHashChain       hashChain;

    @Transactional
    public LedgerEntry post(PostEntryCommand command) {
        // Serialise posts per account: lock the account row (SELECT ... FOR UPDATE).
        // Without it, two concurrent posts read the same previous entry and
        // fork the chain / compute a wrong running balance. The UNIQUE
        // (account_id, sequence_number) constraint is the backstop.
        accountRepository.findByIdForUpdate(command.accountId())
            .orElseThrow(() -> new AccountNotFoundException(command.accountId()));

        Optional<LedgerEntry> previous =
            repository.findTopByAccountIdOrderBySequenceNumberDesc(command.accountId());
        String previousHash = previous.map(LedgerEntry::getEntryHash)
                                      .orElse(LedgerHashChain.GENESIS_HASH);
        long   sequence     = previous.map(e -> e.getSequenceNumber() + 1).orElse(1L);
        long   current      = previous.map(LedgerEntry::getRunningBalance).orElse(0L);
        long   runningBalance = applyEntry(current, command);

        UUID    entryId   = UUID.randomUUID();
        // The SAME timestamp goes into the hash and into the row (PostgreSQL
        // stores microseconds), so the verifier can recompute the hash later
        Instant createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);

        String entryHash = hashChain.computeEntryHash(previousHash,
            new LedgerEntryData(
                entryId.toString(), command.accountId().toString(), sequence,
                command.entryType().name(), command.amountCents(),
                runningBalance, command.transactionRef(), createdAt));

        LedgerEntry entry = LedgerEntry.builder()
            .id(entryId)
            .accountId(command.accountId())
            .sequenceNumber(sequence)
            .entryType(command.entryType())
            .amountCents(command.amountCents())
            .runningBalance(runningBalance)
            .previousHash(previousHash)
            .entryHash(entryHash)
            .transactionRef(command.transactionRef())
            .createdAt(createdAt)
            .createdBy(command.principal())
            .build();

        return repository.save(entry);
    }

    private long applyEntry(long current, PostEntryCommand command) {
        long amount = command.amountCents();
        return switch (command.entryType()) {
            case CREDIT, INTEREST -> current + amount;
            case DEBIT, FEE       -> current - amount;
            // A reversal undoes either a credit or a debit, an adjustment can go
            // either way: these commands carry an explicit direction
            case REVERSAL, ADJUSTMENT ->
                command.direction() == Direction.CREDIT ? current + amount : current - amount;
        };
    }
}
```

## Hibernate Envers for Point-in-Time Queries

Hibernate Envers provides entity-level audit history without bespoke trigger logic. It intercepts Hibernate flushes and writes revision records to `*_aud` tables alongside a `revinfo` table.

```java
@Entity
@Table(name = "accounts")
@Audited  // Envers will track all changes to this entity
@Data
public class Account {

    @Id
    private UUID id;

    private String iban;

    private long balanceCents;

    @Enumerated(EnumType.STRING)
    private AccountStatus status;

    @Version
    private long version;
}
```

```sql
-- Tables created by Envers automatically:
-- revinfo          (rev SERIAL, revtstmp BIGINT)
-- accounts_aud     (id UUID, rev INT FK revinfo, revtype SMALLINT,
--                   iban VARCHAR, balance_cents BIGINT, status VARCHAR)
-- revtype: 0=INSERT, 1=UPDATE, 2=DELETE
```

```java
@Service
@RequiredArgsConstructor
public class AccountAuditService {

    private final AuditReader auditReader;  // a bean you define: AuditReaderFactory.get(entityManager)

    /**
     * Retrieve the state of an account as it was at a specific point in time.
     * Used by compliance officers during fraud investigations.
     */
    public Optional<Account> getAccountAtPointInTime(UUID accountId, Instant asOf) {
        try {
            // Highest (global) revision committed at or before asOf ...
            Number rev = auditReader.getRevisionNumberForDate(Date.from(asOf));
            // ... and the entity state as of that revision (null if it did not exist yet)
            return Optional.ofNullable(auditReader.find(Account.class, accountId, rev));
        } catch (RevisionDoesNotExistException e) {
            return Optional.empty();   // no revision at all before asOf
        }
    }

    /**
     * Return the full revision history of an account for an audit report.
     */
    public List<AccountRevision> getFullHistory(UUID accountId) {
        AuditQuery query = auditReader.createQuery()
            .forRevisionsOfEntity(Account.class, false, true)
            .add(AuditEntity.id().eq(accountId))
            .addOrder(AuditEntity.revisionNumber().asc());

        return ((List<?>) query.getResultList()).stream()
            .map(row -> {
                Object[] tuple = (Object[]) row;
                Account snapshot = (Account) tuple[0];
                DefaultRevisionEntity revision = (DefaultRevisionEntity) tuple[1];
                RevisionType revType = (RevisionType) tuple[2];
                return new AccountRevision(snapshot, revision.getRevisionDate(), revType);
            })
            .toList();
    }
}
```

> [!NOTE]
> Envers history is **not** tamper-evident: the `*_aud` tables are ordinary tables that anyone with write access can change. Use Envers for convenient point-in-time *views* of entities, and the append-only, hash-chained ledger as the evidence. Envers audit tables also grow without bound. For high-volume accounts with thousands of daily state changes, consider archiving `*_aud` rows older than a configurable horizon to cold storage, keeping only a summary snapshot in the hot table.

## Operational: Partitioning and Archival

A ledger for a mid-sized bank with 1 million active accounts at 10 transactions per account per day accumulates 3.65 billion rows per year at approximately 350 bytes per row — roughly 1.3 TB annually. Partition by year to enable efficient archival and time-range queries. Below is the partitioned version of the same table. Note one PostgreSQL rule: a primary key or unique constraint on a partitioned table must include the partition key, so a *global* uniqueness rule such as `UNIQUE (transaction_ref)` has to live in a small separate, non-partitioned table.

```sql
-- Range-partition the ledger by year for archival efficiency
CREATE TABLE ledger_entries (
    id               UUID         NOT NULL,
    account_id       UUID         NOT NULL,
    sequence_number  BIGINT       NOT NULL,
    entry_type       ledger_entry_type NOT NULL,
    amount_cents     BIGINT       NOT NULL,
    running_balance  BIGINT       NOT NULL,
    previous_hash    CHAR(64)     NOT NULL,
    entry_hash       CHAR(64)     NOT NULL,
    transaction_ref  VARCHAR(64)  NOT NULL,
    created_at       TIMESTAMPTZ  NOT NULL,
    created_by       VARCHAR(128) NOT NULL,
    PRIMARY KEY (id, created_at)          -- must include the partition key
) PARTITION BY RANGE (created_at);

-- Global uniqueness of external references (cannot be a constraint on the
-- partitioned table, because it does not include created_at)
CREATE TABLE ledger_transaction_refs (
    transaction_ref  VARCHAR(64)  PRIMARY KEY,
    entry_id         UUID         NOT NULL
);

-- Create annual partitions; automate with pg_partman
CREATE TABLE ledger_entries_2024
    PARTITION OF ledger_entries
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

CREATE TABLE ledger_entries_2025
    PARTITION OF ledger_entries
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

CREATE TABLE ledger_entries_2026
    PARTITION OF ledger_entries
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

-- Index on the most selective columns per partition
CREATE INDEX ON ledger_entries_2026 (account_id, created_at DESC);
```

```java
// Archival job — runs annually, exports the oldest partition to cold storage.
// Runs under a separate, privileged archival role: the application role cannot
// detach or drop ledger partitions.
@Component
@RequiredArgsConstructor
public class LedgerArchivalJob {

    private final JdbcTemplate archivalJdbc;   // connected as the archival role
    private final S3LedgerArchive s3Archive;

    @Scheduled(cron = "0 0 2 1 1 *") // 02:00 on 1 Jan every year
    public void archiveOldestYear() {
        int archiveYear = Year.now().getValue() - 8; // keep the last 7 full years hot
        String partition = "ledger_entries_" + archiveYear;

        // 1. Export the partition (with its hash chain) to Parquet on WORM storage
        s3Archive.exportPartition(partition, archiveYear);

        // 2. Verify the export: row count and the last entry_hash per account match
        if (!s3Archive.verifyExport(partition, archiveYear)) {
            throw new IllegalStateException("Archive verification failed for " + partition);
        }

        // 3. Only then detach and drop the hot partition
        archivalJdbc.execute("ALTER TABLE ledger_entries DETACH PARTITION " + partition);
        archivalJdbc.execute("DROP TABLE " + partition);
    }
}
```

Retention rules differ by record type. For *system audit logs*, PCI DSS v4.0 Requirement 10.5.1 asks for at least 12 months of history, with the most recent three months immediately available. Retention of the *financial records* themselves is driven by accounting, tax and anti-money-laundering law (in the EU and UK, AML records are typically kept for five years after the customer relationship ends) and by local banking law — in practice often 7–10 years. Confirm the exact periods with your compliance team.

## Knowledge Check

**Q1: A developer proposes adding a `status` column to the `ledger_entries` table so that entries can be marked `PENDING` or `SETTLED`. Why is this problematic for an immutable ledger, and what is the correct design?**

A: Updating a `status` column on an existing row violates the append-only constraint. It also makes the tamper-evidence hash chain unverifiable, since the hash was computed over the original row data. The correct design is to post a new ledger entry of type `SETTLEMENT` that references the original entry's `transaction_ref`. State transitions are expressed as new entries, not mutations. If a view of "current status" is needed, it is derived from the most recent entry for a given `transaction_ref`, not stored on any single row.

---

**Q2: Hibernate Envers is auditing the `Account` entity. A compliance officer asks for the account's balance as it stood on 14 March 2025 at 09:47 UTC. What Envers API calls accomplish this, and what are the limitations of this approach?**

A: Use `AuditReader.getRevisionNumberForDate(Date.from(instant))` to find the latest revision at or before that timestamp, then `AuditReader.find(Account.class, accountId, revisionNumber)` to retrieve the entity snapshot as of that revision. The limitations: Envers creates **one revision per transaction**, so if the entity changed several times inside one transaction, only the final state is recorded, and the revision timestamp is the application server's clock at commit. Envers only sees changes made through Hibernate — columns updated via native SQL or bulk JPQL updates bypass it entirely. And the audit tables are ordinary, mutable tables, so they are not tamper evidence.

## Practical Challenge

Your team is building the audit trail infrastructure for a new PSD2-compliant payment institution. The regulator requires that all payment events be immutable, tamper-evident, and queryable at any point in time for the previous 7 years.

**Task 1 — Schema:** Design the complete `ledger_entries` DDL including partitioning strategy, indexes, constraints, and the `CREATE TYPE` for entry types. Justify each index.

**Task 2 — Enforcement:** Write the SQL to revoke mutation privileges from the application role and implement row security policies. Explain why both mechanisms are needed.

**Task 3 — Hash Chain:** Implement a `HashChainVerificationJob` that queries all entries for a given account in ascending order and verifies the full hash chain, logging the first broken link with enough context (entry ID, sequence number, stored hash, computed hash) for a forensic analyst to investigate. The job should run nightly and alert via a `VerificationFailureEvent`.

**Task 4 — Point-in-Time:** A fraud analyst reports a suspicious transaction and asks for the account balance as of exactly 72 hours before the transaction timestamp. Using Hibernate Envers, implement a REST endpoint `GET /accounts/{id}/balance?asOf={iso8601}` that returns the account snapshot at that moment, including revision metadata (who changed it and when).

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A developer proposes adding a status column to ledger_entries so entries can be marked PENDING or SETTLED. Why is this problematic for an immutable ledger, and what is the correct design?",
      "options": [
        "Adding columns to ledger_entries requires a schema migration that may lock the table — use a separate status table instead",
        "Updating a status column on an existing row violates the append-only constraint and breaks the hash chain (the hash was computed over the original row data) — the correct design is to post a new ledger entry of type SETTLEMENT referencing the original transaction_ref, expressing state transitions as new entries not mutations",
        "The status column should use a VARCHAR instead of an ENUM to allow future values without schema changes",
        "The status column is acceptable as long as it is not included in the hash chain computation"
      ],
      "correct": 1,
      "explanation": "Updating a posted ledger entry violates the append-only constraint required by financial record-keeping regulations. It also invalidates the cryptographic hash chain — the entry_hash was computed over the original row data, so any mutation produces a hash that no longer matches. The correct pattern is to post a new entry (e.g., type SETTLEMENT) with a reference to the original transaction_ref. State transitions are expressed as facts that happened, not as mutations of existing facts."
    },
    {
      "text": "What must be true about the application role's privileges on the ledger_entries table to enforce immutability, and why is application-layer validation alone insufficient?",
      "options": [
        "The application role needs SELECT and INSERT only; UPDATE and DELETE must be REVOKED at the database level — application-layer checks can be bypassed by a compromised service account, a misconfigured ORM, or a direct database connection",
        "The application role needs all privileges but the application code must check a boolean flag before executing any UPDATE",
        "Row-level security alone is sufficient — no privilege changes are needed",
        "The application role should use a read-only connection that prevents all mutations"
      ],
      "correct": 0,
      "explanation": "In the business context, the tampering was possible precisely because the application role had UPDATE and DELETE privileges — a DBA used them directly. Application-layer validation is bypassed by any direct database connection, a misconfigured ORM, or a compromised service account. Database-level enforcement (REVOKE UPDATE, DELETE, TRUNCATE from an app_role that does not own the table) is the durable guarantee. Row-level security (FORCE ROW LEVEL SECURITY) adds a belt-and-suspenders layer but is secondary to privilege revocation."
    },
    {
      "text": "What is the operational risk of using pg_partman to manage annual ledger partitions, and what is the correct way to retire a partition that has passed its retention period?",
      "options": [
        "Annual partitions cause index bloat — use monthly partitions instead and retain 84 monthly partitions",
        "If pg_partman fails to create next year's partition before year-end, inserts will fail — monitor partition creation; to retire an old partition, export it to cold storage (e.g. Parquet on WORM storage), verify the export, then detach and drop it under a privileged archival role",
        "Partitions cannot be detached without downtime — archive by moving rows to a separate cold table in the same database",
        "PCI DSS requires all ledger data to remain in hot storage for 10 years — no archival is permitted"
      ],
      "correct": 1,
      "explanation": "pg_partman automates partition creation but requires monitoring to ensure the next partition exists before year-end — an INSERT into a date range with no matching partition fails. Retention periods depend on the record type: PCI DSS v4.0 (10.5.1) asks for 12 months of audit log history with three months immediately available, while financial records follow accounting, tax, AML and banking law — often 7–10 years in practice. The correct retirement procedure is: export the partition to cold storage, verify the export (row counts, last hash per account), then detach and drop the partition from the hot database."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a PSD2-Compliant Immutable Audit Trail with Hash Chain Verification",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design the complete ledger_entries DDL with range partitioning by created_at (annual partitions), all required indexes (composite on account_id+created_at DESC, covering index including running_balance, partial index on transaction_ref), and a CREATE TYPE for entry types. Justify each index with the query pattern it supports. Include the CONSTRAINT chk_amount_positive and CONSTRAINT uq_transaction_ref constraints."},
    {"id": "2", "description": "Write the SQL to revoke UPDATE, DELETE, and TRUNCATE from the application role app_role on ledger_entries. Enable and FORCE row-level security. Create policies: ledger_insert (FOR INSERT WITH CHECK (true)), ledger_select (FOR SELECT USING (true)), no_update (FOR UPDATE USING (false)), no_delete (FOR DELETE USING (false)). Explain why both REVOKE and RLS are needed — what scenario does each defend against that the other does not?"},
    {"id": "3", "description": "Implement HashChainVerificationJob as a nightly @Scheduled job that iterates over all accounts with activity in the last 7 days, calls LedgerHashChain.verifyChain() for each, and for the first broken link logs: account_id, sequence_number_of_broken_entry, stored_previous_hash, expected_previous_hash, stored_entry_hash, recomputed_entry_hash. Publish a VerificationFailureEvent via the outbox pattern so the alert is delivered even if the application restarts immediately after detection."},
    {"id": "4", "description": "Implement REST endpoint GET /accounts/{id}/balance?asOf={iso8601} using Hibernate Envers AuditReader. The endpoint must return: account_id, balance_cents at the requested point-in-time, the revision number, revision timestamp, and the principal that made the last change before asOf. Handle the case where no revision exists before asOf (account did not exist yet) by returning HTTP 404 with a descriptive message. Document the two Envers limitations that a compliance officer must understand when interpreting point-in-time results."}
  ]
}
-->
