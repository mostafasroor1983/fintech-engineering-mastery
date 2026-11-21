---
id: track-05-lesson-23
sequence: 23
title: "Compensating Transactions and Financial Reversals"
slug: compensating-transactions
track: track-05
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [compensation, reversal, refund, CAMT.056, ISO-20022]
java-versions: [17, 21]
---

## Overview

In financial systems, mistakes happen: a payment is sent to the wrong account, a card transaction is disputed, a batch job double-posts an entry. The disciplined response is never to delete or update the original record. Instead, you append a new transaction that neutralises the effect of the first. This is a **compensating transaction** — an immutable, traceable correction that preserves the full audit trail required by regulators and reconciliation systems. Getting compensation right is one of the clearest marks of a principal-level financial engineer.

## Learning Objectives

- Distinguish between reversal, refund, and chargeback and select the correct ledger entry type for each
- Design a compensation schema that makes double-reversal structurally impossible through database constraints
- Implement idempotent reversal logic in Java with a deterministic `reversal_reference` key
- Enforce the partial-reversal business rule: cumulative reversals cannot exceed the original amount
- Parse an ISO 20022 CAMT.056 payment recall message in Java using JAXB
- Write tests that verify balance invariants, idempotency, and boundary conditions for partial reversals

## Business Context

*Composite example:* a European payment processor experiences a P1 incident during a batch salary run. A bug in their overnight job submitted 14,000 payroll credits twice. The engineering team's first instinct was to issue a corrective batch that deleted the duplicate rows from the ledger. Their compliance officer stopped them: deleting posted ledger entries would violate the firm's record-keeping obligations and would cause the reconciliation run to fail catastrophically because external bank statements already reflected the original credits.

The correct fix was to post 14,000 compensating debit entries — one per duplicated credit — each referencing the original transaction it was reversing. The ledger balance returned to correct, the audit trail was intact, every entry was traceable, and the reconciliation job processed normally the next morning. The recovery took four hours instead of the two days a deletion-and-repost approach would have required.

That incident illustrates the foundational rule of financial ledger engineering: **the ledger is append-only. Corrections are new entries, never mutations of existing ones.**

## Reversal vs. Refund vs. Chargeback

These three terms are used interchangeably in conversation but represent fundamentally different workflows, different ledger entry types, and different regulatory treatments.

```mermaid
flowchart LR
    A[Original Transaction\nposted to ledger] --> B{Who initiates\nthe correction?}
    B -->|Bank / system,\nsame day| C[REVERSAL\nEntry type: REVERSAL\nSame-day, before settlement]
    B -->|Merchant,\npost-settlement| D[REFUND\nEntry type: REFUND\nNew payment flow outbound]
    B -->|Customer dispute\nvia card scheme| E[CHARGEBACK\nEntry type: CHARGEBACK\nScheme-mediated, fee charged]
    C --> F[Ledger net = zero\nAudit shows both entries]
    D --> G[Merchant bears cost\nTwo settled transactions]
    E --> H[Chargeback fee deducted\nMerchant may contest]
```

| Dimension | Reversal | Refund | Chargeback |
|---|---|---|---|
| Initiator | Bank / system | Merchant | Customer via card scheme |
| Timing | Same business day, pre-settlement | Post-settlement, any time | Typically up to 120 days from the transaction (scheme rules vary) |
| Settlement impact | Cancels original | New outbound payment | Clawback from merchant |
| Ledger entry type | `REVERSAL` | `REFUND` | `CHARGEBACK` |
| Fee | None | None | Acquirer chargeback fee charged to the merchant (often £15–£25) |
| Regulatory classification | Internal correction | Commercial agreement | Dispute resolution |

The distinction matters for downstream systems. Reconciliation jobs must know whether a negative entry offsets a same-day credit (reversal) or represents an independent outbound payment (refund). Fraud analytics must distinguish merchant-initiated refunds from scheme-mediated chargebacks. Never conflate them in a single `entry_type = 'NEGATIVE'` column.

## The Append-Only Ledger Schema

The compensating transaction schema extends the ledger with a self-referencing foreign key: every compensation row points back to the original transaction it is offsetting.

```sql
CREATE TABLE ledger_entries (
    id                    UUID          NOT NULL DEFAULT gen_random_uuid(),
    account_id            UUID          NOT NULL,
    transaction_id        UUID          NOT NULL,  -- the business transaction this entry belongs to
    entry_type            VARCHAR(20)   NOT NULL,  -- CREDIT, DEBIT, REVERSAL, REFUND, CHARGEBACK
    amount                NUMERIC(19,4) NOT NULL,
    currency              CHAR(3)       NOT NULL,
    running_balance       NUMERIC(19,4) NOT NULL,
    reversal_of_entry_id  UUID          NULL REFERENCES ledger_entries(id),
    reversal_reference    VARCHAR(100)  NULL,      -- deterministic key for idempotency
    posted_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
    value_date            DATE          NOT NULL,
    description           VARCHAR(255)  NOT NULL,
    created_by            VARCHAR(100)  NOT NULL,  -- service or operator that created the entry
    metadata              JSONB         NULL,

    CONSTRAINT pk_ledger_entries PRIMARY KEY (id),
    CONSTRAINT uq_reversal_reference UNIQUE (reversal_reference),  -- prevents double-reversal
    CONSTRAINT chk_entry_type CHECK (entry_type IN ('CREDIT','DEBIT','REVERSAL','REFUND','CHARGEBACK')),
    CONSTRAINT chk_amount_positive CHECK (amount > 0)  -- amount is always positive; sign comes from entry_type
);

CREATE INDEX idx_ledger_account_posted ON ledger_entries (account_id, posted_at DESC);
CREATE INDEX idx_ledger_reversal_of    ON ledger_entries (reversal_of_entry_id)
    WHERE reversal_of_entry_id IS NOT NULL;
```

> [!IMPORTANT]
> The `UNIQUE(reversal_reference)` constraint is the structural guarantee against double-reversal. It is not optional. Business logic checks are necessary but not sufficient — only the database constraint provides a durable, concurrent-safe guarantee.

## Idempotent Reversal: The Deterministic Reference Key

The reversal reference is constructed deterministically from the original transaction ID plus a suffix. This means that no matter how many times the reversal service is called — due to retries, network timeouts, or at-least-once delivery from a message queue — only one reversal entry is ever inserted.

```java
public final class ReversalReferenceGenerator {

    private ReversalReferenceGenerator() {}

    /**
     * Generates a deterministic reversal reference for a full reversal.
     * Format: "{originalEntryId}:REVERSAL"
     */
    public static String forFullReversal(UUID originalEntryId) {
        return originalEntryId.toString() + ":REVERSAL";
    }

    /**
     * Generates a deterministic reversal reference for one partial reversal.
     * The caller's idempotency key (one per partial-reversal REQUEST) makes
     * several partial reversals of the same entry possible, while a retry of
     * the same request maps to the same reference. (A reason code would not
     * work: two genuine partial reversals can share the same reason.)
     * Format: "{originalEntryId}:PARTIAL:{idempotencyKey}"
     */
    public static String forPartialReversal(UUID originalEntryId, String idempotencyKey) {
        Objects.requireNonNull(idempotencyKey, "idempotencyKey must not be null");
        if (idempotencyKey.isBlank() || idempotencyKey.length() > 50) {
            throw new IllegalArgumentException("idempotencyKey must be 1–50 characters");
        }
        return originalEntryId.toString() + ":PARTIAL:" + idempotencyKey;
    }
}
```

The service uses this key as the idempotency guard before attempting the insert:

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class ReversalService {

    private final LedgerEntryRepository ledgerEntryRepository;
    private final AccountRepository accountRepository;

    @Transactional
    public LedgerEntry reverseTransaction(ReversalRequest request) {
        String reversalReference = ReversalReferenceGenerator
            .forFullReversal(request.originalEntryId());

        // Lock the ORIGINAL entry row (SELECT ... FOR UPDATE): all reversals of
        // this entry — full or partial — are serialised from here on
        LedgerEntry original = ledgerEntryRepository.findByIdForUpdate(request.originalEntryId())
            .orElseThrow(() -> new EntryNotFoundException(request.originalEntryId()));

        // Idempotency check — after the lock, so a concurrent duplicate that
        // committed first is visible here
        Optional<LedgerEntry> existing =
            ledgerEntryRepository.findByReversalReference(reversalReference);
        if (existing.isPresent()) {
            log.info("Reversal already exists for entry {}, returning existing entry {}",
                request.originalEntryId(), existing.get().getId());
            return existing.get();
        }

        validateReversalEligibility(original);

        // A "full" reversal reverses what is LEFT: earlier partial reversals count
        BigDecimal alreadyReversed = ledgerEntryRepository
            .sumReversedAmountForEntry(original.getId());
        BigDecimal remaining = original.getAmount().subtract(alreadyReversed);
        if (remaining.signum() <= 0) {
            throw new AlreadyFullyReversedException(original.getId());
        }

        // The balance effect is the mirror of the ORIGINAL entry type:
        // undoing a credit lowers the balance, undoing a debit raises it.
        // (Locks the account row and applies the delta.)
        BigDecimal newBalance = computeBalanceAfterUndo(
            original.getAccountId(), remaining, original.getEntryType());

        LedgerEntry reversal = LedgerEntry.builder()
            .accountId(original.getAccountId())
            .transactionId(UUID.randomUUID())
            .entryType(EntryType.REVERSAL)
            .amount(remaining)
            .currency(original.getCurrency())
            .runningBalance(newBalance)
            .reversalOfEntryId(original.getId())
            .reversalReference(reversalReference)
            .valueDate(request.valueDate())
            .description("Reversal of entry " + original.getId())
            .createdBy(request.initiatedBy())
            .build();

        return ledgerEntryRepository.save(reversal);
    }

    private void validateReversalEligibility(LedgerEntry original) {
        // Only CREDIT and DEBIT entries can be reversed; never a reversal itself
        if (original.getEntryType() == EntryType.REVERSAL
                || original.getReversalOfEntryId() != null) {
            throw new ReversalOfReversalException(original.getId());
        }
        if (original.getEntryType() != EntryType.CREDIT
                && original.getEntryType() != EntryType.DEBIT) {
            throw new IllegalArgumentException(
                "Cannot reverse entry of type: " + original.getEntryType());
        }
    }
}
```

> [!NOTE]
> Both credit reversals and debit reversals use `EntryType.REVERSAL`. The direction of the balance effect is inferred: reversing a credit reduces the balance; reversing a debit increases it. That is why the service passes the **original** entry type to `computeBalanceAfterUndo` — the reversal's own type does not say which way to go. A concurrent duplicate that slips past the idempotency check (for example from another code path that does not take the lock) still fails on `UNIQUE(reversal_reference)` at flush; translate that exception, outside the transaction, into "return the existing reversal".

## Partial Reversal: Enforcing the Business Rule

A partial reversal releases only part of the original transaction amount. The core business rule is: **the sum of all partial reversals against a single original entry must not exceed that entry's amount.** This requires a sum query before inserting the new reversal.

```java
@Transactional
public LedgerEntry partiallyReverse(PartialReversalRequest request) {
    String reversalReference = ReversalReferenceGenerator
        .forPartialReversal(request.originalEntryId(), request.idempotencyKey());

    // Lock the original entry first — this serialises concurrent partial
    // reversals of the same entry and closes the check-then-insert race
    LedgerEntry original = ledgerEntryRepository.findByIdForUpdate(request.originalEntryId())
        .orElseThrow(() -> new EntryNotFoundException(request.originalEntryId()));

    // Idempotency check: a retry of the same request returns the same entry —
    // but only if it really is the same request
    Optional<LedgerEntry> existing =
        ledgerEntryRepository.findByReversalReference(reversalReference);
    if (existing.isPresent()) {
        if (existing.get().getAmount().compareTo(request.reversalAmount()) != 0) {
            throw new IdempotencyKeyReusedException(request.idempotencyKey());
        }
        return existing.get();
    }

    validateReversalEligibility(original);

    // Business rule: sum of all prior reversals + this reversal <= original amount
    BigDecimal alreadyReversed = ledgerEntryRepository
        .sumReversedAmountForEntry(request.originalEntryId());

    BigDecimal totalAfterThisReversal = alreadyReversed.add(request.reversalAmount());

    if (totalAfterThisReversal.compareTo(original.getAmount()) > 0) {
        throw new PartialReversalExceedsOriginalException(
            request.originalEntryId(),
            original.getAmount(),
            alreadyReversed,
            request.reversalAmount()
        );
    }

    BigDecimal newBalance = computeBalanceAfterUndo(
        original.getAccountId(), request.reversalAmount(), original.getEntryType());

    LedgerEntry reversal = LedgerEntry.builder()
        .accountId(original.getAccountId())
        .transactionId(UUID.randomUUID())
        .entryType(EntryType.REVERSAL)
        .amount(request.reversalAmount())
        .currency(original.getCurrency())
        .runningBalance(newBalance)
        .reversalOfEntryId(original.getId())
        .reversalReference(reversalReference)
        .valueDate(request.valueDate())
        .description("Partial reversal of entry " + original.getId()
            + ": " + request.reasonCode())
        .createdBy(request.initiatedBy())
        .build();

    return ledgerEntryRepository.save(reversal);
}
```

The repository query that sums prior reversals:

```sql
-- Sum all reversal amounts already posted against a given original entry
SELECT COALESCE(SUM(amount), 0)
  FROM ledger_entries
 WHERE reversal_of_entry_id = :originalEntryId
   AND entry_type = 'REVERSAL';
```

```java
@Repository
public interface LedgerEntryRepository extends JpaRepository<LedgerEntry, UUID> {

    Optional<LedgerEntry> findByReversalReference(String reversalReference);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT e FROM LedgerEntry e WHERE e.id = :id")
    Optional<LedgerEntry> findByIdForUpdate(@Param("id") UUID id);

    // COALESCE: SUM over no rows is NULL. Compare the enum to its constant,
    // not to a string literal.
    @Query("""
        SELECT COALESCE(SUM(e.amount), 0)
          FROM LedgerEntry e
         WHERE e.reversalOfEntryId = :originalEntryId
           AND e.entryType = com.bank.ledger.EntryType.REVERSAL
        """)
    BigDecimal sumReversedAmountForEntry(@Param("originalEntryId") UUID originalEntryId);

    long countByReversalOfEntryId(UUID originalEntryId);
}
```

> [!WARNING]
> Without the lock, the partial reversal check is a time-of-check/time-of-use (TOCTOU) race: two concurrent requests for the same original entry could both pass the sum check and together exceed the original amount. The `UNIQUE(reversal_reference)` constraint only stops exact duplicates (same idempotency key). That is why both methods start with `SELECT ... FOR UPDATE` on the original entry row. (A database trigger that re-sums is only safe if it takes the same lock first — otherwise it has the same race.)

## ISO 20022 CAMT.056 Payment Recall

CAMT.056 (`FIToFIPaymentCancellationRequest`) is the ISO 20022 message used by one financial institution to request that another reverse a payment it initiated. It is the standard mechanism for bank-to-bank payment recalls in SEPA and many domestic schemes.

A minimal CAMT.056 structure looks like this:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.056.001.08">
  <FIToFIPmtCxlReq>
    <Assgnmt>
      <Id>RECALL-2024-001-XYZ</Id>
      <Assgnr><Agt><FinInstnId><BICFI>BARCGB22XXX</BICFI></FinInstnId></Agt></Assgnr>
      <Assgne><Agt><FinInstnId><BICFI>HSBCGB2LXXX</BICFI></FinInstnId></Agt></Assgne>
      <CreDtTm>2024-03-15T10:30:00Z</CreDtTm>
    </Assgnmt>
    <Undrlyg>
      <TxInf>
        <CxlId>CXL-20240315-001</CxlId>
        <OrgnlGrpInf>
          <OrgnlMsgId>MSG-20240315-PAY-001</OrgnlMsgId>
          <OrgnlMsgNmId>pacs.008.001.08</OrgnlMsgNmId>
        </OrgnlGrpInf>
        <OrgnlTxId>TXN-20240315-98765</OrgnlTxId>
        <OrgnlIntrBkSttlmAmt Ccy="GBP">5000.00</OrgnlIntrBkSttlmAmt>
        <CxlRsnInf>
          <Rsn><Cd>DUPL</Cd></Rsn>
          <AddtlInf>Duplicate salary payment identified during reconciliation</AddtlInf>
        </CxlRsnInf>
      </TxInf>
    </Undrlyg>
  </FIToFIPmtCxlReq>
</Document>
```

Common CAMT.056 cancellation reason codes used in practice:

| Code | Meaning | Typical trigger |
|---|---|---|
| `DUPL` | Duplicate payment | Batch job double-posting |
| `FRAD` | Fraudulent origin | AML / fraud system detection |
| `TECH` | Technical problem | Settlement system error |
| `CUST` | Customer request | Customer contacts bank |
| `UPAY` | Undue payment | The payment should not have been made |
| `AC03` | Wrong beneficiary account (IBAN) | Customer typed a wrong IBAN |
| `AM09` | Wrong amount | Amount error |

A recall is a **request**, not an instruction. The receiving (beneficiary) bank decides: depending on the reason and the scheme rules it may need the beneficiary's consent, and the funds may already be gone. A positive answer returns the money with a `pacs.004` payment return; a negative answer is sent as a `camt.029` resolution of investigation. So the processor below first records the recall as a case; the reversal is posted only once the recall has been **accepted**.

Parsing the recall in Java using JAXB with the Jakarta namespace:

```java
import jakarta.xml.bind.JAXBContext;
import jakarta.xml.bind.JAXBException;
import jakarta.xml.bind.Unmarshaller;
import java.io.StringReader;

@Service
@Slf4j
public class Camt056RecallProcessor {

    private final JAXBContext jaxbContext;
    private final ReversalService reversalService;
    private final LedgerEntryRepository ledgerEntryRepository;
    private final RecallCaseRepository recallCases;

    public Camt056RecallProcessor(ReversalService reversalService,
                                  LedgerEntryRepository ledgerEntryRepository,
                                  RecallCaseRepository recallCases) throws JAXBException {
        // JAXBContext is thread-safe and expensive to create — build once at startup
        this.jaxbContext = JAXBContext.newInstance(Document.class);
        this.reversalService = reversalService;
        this.ledgerEntryRepository = ledgerEntryRepository;
        this.recallCases = recallCases;
    }

    /** Step 1: register the recall as a case — idempotent on the assignment id. */
    public RecallCase registerRecall(String camt056Xml) {
        Document document = unmarshal(camt056Xml);
        FIToFIPaymentCancellationRequestV08 request = document.getFIToFIPmtCxlReq();

        TransactionInformation32 txInfo = request.getUndrlyg()
            .getFirst()
            .getTxInf()
            .getFirst();

        String originalTxId  = txInfo.getOrgnlTxId();   // interbank id, NOT our UUID
        String reasonCode    = txInfo.getCxlRsnInf().getFirst().getRsn().getCd();
        String assignmentId  = request.getAssgnmt().getId();

        log.info("Registering CAMT.056 recall: assignmentId={}, originalTxId={}, reason={}",
            assignmentId, originalTxId, reasonCode);

        // INSERT ... ON CONFLICT (assignment_id) DO NOTHING, then read back
        return recallCases.registerOnce(assignmentId, originalTxId, reasonCode);
    }

    /** Step 2: after the recall is ACCEPTED, post the reversal (then send pacs.004). */
    public RecallResult executeAcceptedRecall(RecallCase recall) {
        // Resolve our ledger entry from the scheme's transaction id
        Optional<LedgerEntry> original =
            ledgerEntryRepository.findByExternalTransactionId(recall.originalTxId());
        if (original.isEmpty()) {
            log.warn("CAMT.056 recall references unknown transaction: {}", recall.originalTxId());
            return RecallResult.rejected(recall.assignmentId(), "TRANSACTION_NOT_FOUND"); // camt.029
        }

        ReversalRequest reversalRequest = ReversalRequest.builder()
            .originalEntryId(original.get().getId())
            .initiatedBy("CAMT056:" + recall.assignmentId())
            .valueDate(LocalDate.now())
            .build();

        try {
            LedgerEntry reversal = reversalService.reverseTransaction(reversalRequest);
            return RecallResult.accepted(recall.assignmentId(), reversal.getId()); // pacs.004
        } catch (ReversalOfReversalException | AlreadyFullyReversedException ex) {
            log.warn("CAMT.056 recall targets an already-reversed entry: {}", recall.originalTxId());
            return RecallResult.rejected(recall.assignmentId(), "ALREADY_REVERSED");  // camt.029
        }
    }

    private Document unmarshal(String xml) {
        try {
            Unmarshaller unmarshaller = jaxbContext.createUnmarshaller();
            // Interbank messages are external input: parse with external
            // entities disabled (no XXE). The generated Document class usually
            // has no @XmlRootElement, so ask for the declared type.
            XMLStreamReader reader = secureXmlInputFactory()
                .createXMLStreamReader(new StringReader(xml));
            return unmarshaller.unmarshal(reader, Document.class).getValue();
        } catch (JAXBException | XMLStreamException ex) {
            throw new InvalidCamt056MessageException("Failed to parse CAMT.056 message", ex);
        }
    }
}
```

> [!NOTE]
> The JAXB classes (`Document`, `FIToFIPaymentCancellationRequestV08`, etc.) are generated from the ISO 20022 XSD schemas published at `https://www.iso20022.org/catalogue-messages/iso-20022-messages-archive`. In a production project these generated classes live in a separate `iso20022-model` Maven module shared across all message-type processors.

## End-to-End Reversal Flow

```mermaid
sequenceDiagram
    participant Caller as Caller (API / Message Consumer)
    participant RS as ReversalService
    participant Repo as LedgerEntryRepository
    participant DB as PostgreSQL

    Caller->>RS: reverseTransaction(originalTxId, initiatedBy)
    RS->>Repo: findByIdForUpdate(originalEntryId)
    Repo->>DB: SELECT * FROM ledger_entries WHERE id = ? FOR UPDATE
    DB-->>Repo: original entry (CREDIT, £500) — now locked
    Repo-->>RS: LedgerEntry

    RS->>Repo: findByReversalReference("entryId:REVERSAL")
    Repo->>DB: SELECT * FROM ledger_entries WHERE reversal_reference = ?
    DB-->>Repo: empty
    Repo-->>RS: Optional.empty()

    RS->>RS: validateReversalEligibility(original)
    RS->>RS: computeBalanceAfterUndo(accountId, £500, CREDIT)

    RS->>Repo: save(reversalEntry)
    Repo->>DB: INSERT INTO ledger_entries (..., reversal_reference='entryId:REVERSAL')
    Note over DB: UNIQUE constraint enforced atomically
    DB-->>Repo: saved entry
    Repo-->>RS: LedgerEntry
    RS-->>Caller: LedgerEntry (reversal posted)
```

## Testing Reversal Logic

Well-structured tests verify four independent behaviours: balance invariant after reversal, double-reversal rejection, partial reversal within limit, and partial reversal above limit.

```java
@SpringBootTest
@Transactional
class ReversalServiceTest {

    @Autowired ReversalService reversalService;
    @Autowired LedgerEntryRepository ledgerEntryRepository;
    @Autowired AccountRepository accountRepository;

    private UUID accountId;
    private LedgerEntry originalCredit;

    @BeforeEach
    void setUp() {
        accountId = createTestAccount(new BigDecimal("1000.00"));
        originalCredit = postCredit(accountId, new BigDecimal("500.00"));
    }

    @Test
    @DisplayName("Balance after full reversal equals balance before original transaction")
    void fullReversal_restoresBalanceToPreTransactionState() {
        BigDecimal balanceBeforeOriginal =
            originalCredit.getRunningBalance().subtract(originalCredit.getAmount());

        LedgerEntry reversal = reversalService.reverseTransaction(ReversalRequest.builder()
            .originalEntryId(originalCredit.getId())
            .initiatedBy("test-service")
            .valueDate(LocalDate.now())
            .build());

        assertThat(reversal.getRunningBalance())
            .isEqualByComparingTo(balanceBeforeOriginal);
    }

    @Test
    @DisplayName("Calling reverseTransaction twice returns the same entry — idempotent")
    void doubleReversal_isIdempotent_returnsSameEntry() {
        ReversalRequest request = ReversalRequest.builder()
            .originalEntryId(originalCredit.getId())
            .initiatedBy("test-service")
            .valueDate(LocalDate.now())
            .build();

        LedgerEntry first  = reversalService.reverseTransaction(request);
        LedgerEntry second = reversalService.reverseTransaction(request);

        assertThat(second.getId()).isEqualTo(first.getId());
        assertThat(ledgerEntryRepository.countByReversalOfEntryId(originalCredit.getId()))
            .isEqualTo(1);
    }

    @Test
    @DisplayName("Partial reversal within original amount is accepted")
    void partialReversal_withinLimit_succeeds() {
        LedgerEntry partial = reversalService.partiallyReverse(PartialReversalRequest.builder()
            .originalEntryId(originalCredit.getId())
            .reversalAmount(new BigDecimal("200.00"))
            .reasonCode("PARTIAL_DISPUTE")
            .idempotencyKey("partial_dispute-req-1")
            .initiatedBy("test-service")
            .valueDate(LocalDate.now())
            .build());

        assertThat(partial.getAmount()).isEqualByComparingTo("200.00");
        assertThat(partial.getEntryType()).isEqualTo(EntryType.REVERSAL);
    }

    @Test
    @DisplayName("Partial reversal that would exceed original amount is rejected")
    void partialReversal_exceedingOriginal_throwsException() {
        // Post £300 partial reversal — within the £500 limit
        reversalService.partiallyReverse(PartialReversalRequest.builder()
            .originalEntryId(originalCredit.getId())
            .reversalAmount(new BigDecimal("300.00"))
            .reasonCode("FIRST_PARTIAL")
            .idempotencyKey("first_partial-req-1")
            .initiatedBy("test-service")
            .valueDate(LocalDate.now())
            .build());

        // Attempt £250 more — total would be £550, exceeding £500
        assertThatThrownBy(() -> reversalService.partiallyReverse(
            PartialReversalRequest.builder()
                .originalEntryId(originalCredit.getId())
                .reversalAmount(new BigDecimal("250.00"))
                .reasonCode("SECOND_PARTIAL")
                .idempotencyKey("second_partial-req-1")
                .initiatedBy("test-service")
                .valueDate(LocalDate.now())
                .build()))
            .isInstanceOf(PartialReversalExceedsOriginalException.class)
            .hasMessageContaining("500.00");
    }
}
```

> [!IMPORTANT]
> The `doubleReversal_isIdempotent_returnsSameEntry` test should also be run with concurrent callers to verify the lock and the `UNIQUE(reversal_reference)` constraint under a true race. Use `@RepeatedTest(10)` with two threads launched via `CompletableFuture`. That concurrent test must **not** be `@Transactional`: inside one test transaction nothing is committed, so the second thread would never see the first thread's work.

## Knowledge Check

**Q1: A developer proposes handling reversals by adding a `reversed = true` flag to the original ledger entry and skipping it in balance calculations. What are the two critical problems with this approach?**

A: First, it violates the append-only audit trail requirement. Modifying a posted ledger entry breaks record-keeping obligations (for example the FCA's SYSC 9 record-keeping rules) and basic accounting practice. External reconciliation systems — including SWIFT and ISO 20022 settlement statements — will have already recorded the original entry; changing the internal ledger creates a mismatch that breaks reconciliation. Second, the approach is not atomic. If the `UPDATE` to set `reversed = true` and the balance adjustment are separate operations, a failure between them produces an inconsistent state: the entry is marked reversed but the balance has not been corrected, or vice versa. The compensating transaction approach combines both effects in a single new INSERT that is atomic, leaves the original entry unchanged, and can be re-played safely on retry.

**Q2: Your partial reversal service passes all unit tests but you observe occasional cases in production where the cumulative reversal amount exceeds the original transaction amount. The sum-check query and insert are inside a single `@Transactional` method. What is the root cause and what are two valid remedies?**

A: The root cause is a TOCTOU (time-of-check/time-of-use) race condition. Two concurrent partial reversal requests both read the current sum (e.g., £0), both calculate that their requested amount (e.g., £400 each) fits within the original £500, and both proceed to insert. Because neither transaction holds a lock on the original entry row, both inserts succeed — the cumulative total becomes £800. Remedy one: add `SELECT ... FOR UPDATE` on the original ledger entry row at the start of the partial reversal transaction, serialising concurrent partial reversals for the same original entry. Remedy two: run the check-and-insert in `SERIALIZABLE` transactions and retry on serialization failure — PostgreSQL then detects that the two transactions' reads and writes conflict. (A trigger that re-sums on each insert is *not* enough on its own: under `READ COMMITTED` two concurrent triggers still miss each other's uncommitted rows, unless the trigger first takes the same row lock.)

## Practical Challenge

**Scenario:** You are building the compensation module for a real-time payments platform. The platform processes SEPA Instant Credit Transfers and must handle CAMT.056 payment recalls within the scheme's recall window (10 banking business days for duplicate, technical and fraud reasons; customer-requested recalls for a wrong IBAN, a wrong amount or a customer reason may be made for up to 13 months).

**Task:**

1. Extend the `ledger_entries` schema to add a `recall_window_expires_at` column (computed as `posted_at + INTERVAL '10 business days'`). Write a PostgreSQL function `is_within_recall_window(entry_id UUID) RETURNS BOOLEAN` that returns `true` if the current timestamp is before the recall window expiry. Integrate this check into the `validateReversalEligibility` method.

2. Implement a `RecallWindowScheduler` Spring component using `@Scheduled(cron = "0 0 18 * * MON-FRI")` to query for all entries whose recall window expires at end-of-day and publish a `RecallWindowClosingEvent` to a Kafka topic for downstream notification to originators.

3. Write a `Camt056MessageValidator` that validates an incoming CAMT.056 XML against the ISO 20022 XSD schema before unmarshalling. Use `javax.xml.validation.SchemaFactory` with the XSD loaded from the classpath. Return a `ValidationResult` record containing `boolean valid` and `List<String> errors`.

4. Write an integration test that posts a credit entry, then submits two concurrent CAMT.056 recall requests for the same transaction using `CompletableFuture.allOf(...)`. Assert that exactly one reversal is committed and the other either returns the existing reversal (idempotent path) or is rejected with a database constraint violation that the service translates to a `DuplicateReversalException`.

> [!IMPORTANT]
> The CAMT.056 processor must be idempotent at the message level as well as the transaction level. Use the CAMT.056 `Assgnmt/Id` (assignment ID) as a second idempotency key in a separate `processed_recalls` table. This guards against the case where the same recall message is delivered twice over the interbank network, even if it references two different internal transaction IDs.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A developer proposes handling reversals by adding a reversed=true flag to the original ledger entry and skipping it in balance calculations. What are the two critical problems with this approach?",
      "options": [
        "The flag approach is slower than posting a new entry because it requires an UPDATE instead of an INSERT",
        "It violates the append-only record-keeping requirement (modifying posted records breaks record-keeping obligations and invalidates external reconciliation) AND the UPDATE is not atomic with the balance adjustment — a failure between them leaves the system in an inconsistent state where the entry is marked reversed but the balance is not corrected",
        "Flags are not supported by standard JAXB parsers used for ISO 20022 messages",
        "The flag cannot distinguish full reversals from partial reversals without an additional amount column"
      ],
      "correct": 1,
      "explanation": "Two critical problems: (1) Modifying a posted ledger entry violates append-only record-keeping obligations (for example the FCA's SYSC 9 rules) and accounting practice. External reconciliation systems have already recorded the original entry — changing it internally creates a mismatch. (2) The UPDATE to set reversed=true and the balance adjustment are non-atomic operations. A failure between them produces an inconsistent state. The compensating transaction approach combines both effects in a single atomic INSERT, leaves the original unchanged, is re-playable on retry, and preserves the full audit trail."
    },
    {
      "text": "What is the TOCTOU race condition in partial reversal processing, and what are two valid remedies?",
      "options": [
        "Two partial reversals with the same idempotency key arrive simultaneously — the UNIQUE(reversal_reference) constraint handles this",
        "Two partial reversals with DIFFERENT idempotency keys both pass the cumulative sum check concurrently and together exceed the original amount — remedy 1: SELECT ... FOR UPDATE on the original entry during validation; remedy 2: SERIALIZABLE transactions with retry on serialization failure",
        "The sum query and INSERT are not in the same transaction, allowing the sum to change between check and insert",
        "The partial reversal runs in READ COMMITTED isolation which allows phantom reads to show a stale cumulative sum"
      ],
      "correct": 1,
      "explanation": "UNIQUE(reversal_reference) only prevents exact duplicates (same idempotency key). Two concurrent requests with different keys both execute the cumulative sum query before either has committed, both see the current sum as, say, £0, both calculate that their £400 request fits within a £500 original, and both insert — resulting in £800 total. Remedy 1: SELECT ... FOR UPDATE on the original entry serialises concurrent partial reversals for the same original. Remedy 2: SERIALIZABLE isolation makes PostgreSQL detect the conflicting reads and writes and abort one transaction, which is then retried. A summing trigger alone is not enough under READ COMMITTED unless it takes the same lock."
    },
    {
      "text": "What distinguishes a REVERSAL from a REFUND, and why does this distinction matter for downstream reconciliation systems?",
      "options": [
        "They are functionally identical — the distinction is only cosmetic for customer statements",
        "A REVERSAL is a same-day, pre-settlement bank/system-initiated correction that nets to zero; a REFUND is a post-settlement, merchant-initiated new outbound payment — reconciliation systems must distinguish them because a reversal cancels the original transaction while a refund represents two separate settled transactions with different cash flows",
        "A REVERSAL can only be initiated by the card scheme while a REFUND can be initiated by the merchant",
        "A REFUND requires a new ISO 20022 CAMT.056 message while a REVERSAL uses CAMT.053"
      ],
      "correct": 1,
      "explanation": "The distinction is critical for reconciliation. A REVERSAL cancels the original transaction before or at settlement — the net effect is zero, with two ledger entries that sum to zero. A REFUND is an independent new outbound payment that settles separately — both the original debit and the refund credit appear on bank statements as separate settled transactions. Conflating them breaks external reconciliation: a system expecting two matched pairs instead sees one matched pair and two unmatched singles, generating false INTERNAL_ONLY and EXTERNAL_ONLY items."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a SEPA Instant Recall System with CAMT.056 Processing and Idempotent Reversal",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Extend the ledger_entries schema with a recall_window_expires_at column computed as posted_at + INTERVAL '10 business days' (use a PostgreSQL function that skips weekends). Write PostgreSQL function is_within_recall_window(entry_id UUID) RETURNS BOOLEAN. Integrate this check into validateReversalEligibility() — throw RecallWindowExpiredException if the window has closed, with the expiry timestamp in the exception message."},
    {"id": "2", "description": "Implement RecallWindowScheduler using @Scheduled(cron = '0 0 18 * * MON-FRI') that queries for all ledger entries where recall_window_expires_at < now() + INTERVAL '1 hour' AND recall_window_expires_at > now() AND no reversal exists. For each such entry, publish a RecallWindowClosingEvent to Kafka via the outbox pattern. Write a test that inserts an entry with recall_window_expires_at = now() + 30 minutes and verifies the event is published on the next scheduler tick."},
    {"id": "3", "description": "Write Camt056MessageValidator that validates incoming CAMT.056 XML against the ISO 20022 XSD schema using javax.xml.validation.SchemaFactory before unmarshalling. Load the XSD from the classpath at startup (not per-request). Return a ValidationResult record(boolean valid, List<String> errors). Write a unit test that provides a malformed CAMT.056 (missing required Assgnmt/Id element) and asserts valid=false with a non-empty errors list containing the missing element path."},
    {"id": "4", "description": "Write an integration test that posts a credit entry, then submits two concurrent CAMT.056 recall requests for the same transaction using CompletableFuture.allOf() with a fixed thread pool of 2. Assert: exactly one reversal row exists in ledger_entries (countByReversalOfEntryId = 1), the second concurrent call either returns the existing reversal (idempotent path) or is translated to DuplicateReversalException from the UNIQUE(reversal_reference) constraint violation. Use @RepeatedTest(10) to verify the race condition is consistently handled."}
  ]
}
-->
