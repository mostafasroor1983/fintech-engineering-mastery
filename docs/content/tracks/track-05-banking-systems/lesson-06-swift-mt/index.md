---
id: "track-05-lesson-06"
title: "SWIFT MT Message Format"
track: "track-05"
track-name: "Banking & Financial Systems Architecture"
sequence: 6
slug: "swift-mt-messages"
difficulty: "advanced"
estimated-minutes: 85
status: "published"
last-updated: "2026-11-08"
prerequisites: []
tags: ["SWIFT", "MT103", "MT202", "MT940", "correspondent-banking", "SWIFT-network"]
java-versions: [17, 21]
topics:
  - "SWIFT Network Architecture"
  - "MT Message Block Structure"
  - "MT103 Field-by-Field Breakdown"
  - "MT202 Financial Institution Transfer"
  - "MT940 Account Statement and Reconciliation"
  - "Java SwiftMessageParser"
  - "SWIFT GPI and UETR Tracking"
  - "Error Handling and Rejection Codes"
components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true
references:
  - "SWIFT MT Standards Release Guide 2024, SWIFT SCRL"
  - "prowide-core (WIFE) library documentation — https://github.com/prowide/prowide-core"
  - "SWIFT Global Payments Innovation (GPI) Customer Credit Transfer Guide, 2023"
  - "Bank for International Settlements, 'Correspondent Banking' CPMI Report No. 147, 2016"
---

SWIFT (Society for Worldwide Interbank Financial Telecommunication) carries over 44 million messages per day across more than 11,500 financial institutions in 200+ countries. Despite ISO 20022 migration underway, the MT (Message Type) format remains the operational backbone of cross-border payments for the foreseeable future. Senior engineers maintaining payment gateways must understand the byte-level structure of MT messages, the correspondent banking topology those messages traverse, and how to parse, validate, and route them reliably in Java.

## Learning Objectives

- Describe the SWIFT network topology including BIC codes, the FIN service, and correspondent banking chains
- Identify all five blocks of an MT message and explain the purpose of each header and trailer field
- Parse an MT103 message field-by-field, mapping tag numbers to business semantics
- Implement a `SwiftMessageParser` in Java using prowide-core that extracts payment-critical fields with full error handling
- Distinguish MT103 (customer credit transfer) from MT202 (financial institution cover) and explain when each is used
- Parse an MT940 customer statement for automated reconciliation against a nostro ledger
- Explain SWIFT GPI, extract the UETR from field 121, and track payment status via the Tracker API
- Handle SWIFT rejection codes (NAK, NACK) and implement retry/escalation logic in Java

## Business Context

In November 2022, a major European bank's payment operations team discovered that 3,400 cross-border MT103 messages had been silently rejected by SWIFT's FIN service over a 48-hour window due to a malformed Block 2 application header — specifically, a one-character error in the message priority field. The messages were queued internally but never transmitted. The total trapped value was €217 million. The incident was not detected by monitoring because the internal queue counter and the SWIFT confirmation counter were reconciled only at end-of-day. By the time operations identified the discrepancy, 14 beneficiaries in six countries had escalated through their banks, and the institution incurred €480,000 in penalty interest, €120,000 in manual repair costs, and significant reputational damage with two correspondent partners who threatened to review the relationship. The root cause was a 2019 internal serializer that had never been validated against the SWIFT MT standards and had accumulated undocumented drift. This lesson ensures you can build a correct, well-tested MT message pipeline that never silently fails.

## SWIFT Network Architecture

SWIFT is not a payment system — it is a **secure messaging network**. No money moves on SWIFT; only instructions move. Settlement happens through correspondent accounts or central bank systems. Every institution on SWIFT is identified by a **BIC (Business Identifier Code)**, also called a SWIFT code.

A BIC has the format `BANKCCLL[BBB]`:
- `BANK` — 4-character institution code
- `CC` — ISO 3166-1 alpha-2 country code
- `LL` — 2-character location code
- `BBB` — optional 3-character branch code (omitted = head office, `XXX` = head office explicitly)

**Correspondent banking** is the arrangement by which Bank A (without a presence in a foreign country) uses Bank B (which has that presence) to execute transactions there. Bank A holds a **nostro account** at Bank B ("our money at your bank"). Bank B records the same account as a **vostro** ("your money at our bank"). A cross-border USD payment from a small European bank to a beneficiary in Brazil may traverse two or three correspondent hops.

```mermaid
graph LR
    A["Originating Bank\n(DEUTDEDB)\nGermany"] -->|MT103| B["Correspondent A\n(CHASUS33)\nUSA"]
    B -->|MT103| C["Correspondent B\n(BRASBRRJBHE)\nBrazil"]
    C -->|Credit to account| D["Beneficiary Bank\n(ITAUBRSP)\nBrazil"]
    D --> E["Beneficiary"]

    style A fill:#1e3a5f,color:#fff
    style B fill:#1e3a5f,color:#fff
    style C fill:#1e3a5f,color:#fff
    style D fill:#2d6a4f,color:#fff
    style E fill:#2d6a4f,color:#fff
```

The FIN service (the main SWIFT messaging service) guarantees **store-and-forward** delivery with configurable priority: Urgent (U), Normal (N), or System (S). Every message is assigned a unique **MIR (Message Input Reference)** at the input side and a **MOR (Message Output Reference)** at the output side.

> [!NOTE]
> SWIFT Alliance Gateway, SWIFT Alliance Access, and cloud-based SWIFT Alliance Connect Virtual are the main connectivity products. Most large banks run on-premises Alliance Access, which writes messages to a local database before forwarding. Your Java application typically integrates via MQ (WebSphere MQ / ActiveMQ / IBM MQ) or file-based interfaces, not directly to the SWIFT network.

## MT Message Block Structure

Every MT message is composed of exactly five blocks, delimited by `{n:` and `}`:

| Block | Name | Mandatory | Contents |
|-------|------|-----------|----------|
| 1 | Basic Header | Yes | LT address, session/sequence |
| 2 | Application Header | Yes | Message type, receiver BIC, priority |
| 3 | User Header | No | Bank priority, MUR, service codes |
| 4 | Text Block | Yes | The actual MT fields (tagged) |
| 5 | Trailer | Yes | Checksums, possible encryption indicator |

A minimal MT103 message on the wire looks like:

```
{1:F01DEUTDEDBAXXX0000000001}
{2:I103CHASUS33XXXXN}
{3:{108:REF20241101001}}
{4:
:20:TXREF20241101001
:23B:CRED
:32A:241101USD50000,00
:50K:/DE89370400440532013000
ACME EXPORTS GMBH
FRANKFURT AM MAIN
:57A:BOFAUS3N
:59:/123456789
WIDGETS INC
NEW YORK NY USA
:70:INVOICE INV-2024-00891
:71A:SHA
-}
{5:{CHK:3B4F2D1E9A7C}}
```

**Block 1** encodes:
- `F` — Application identifier (F = FIN)
- `01` — Service identifier
- `DEUTDEDBAXXX` — LT (Logical Terminal) address of the sender (12-char BIC)
- `0000` — Session number
- `000001` — Sequence number

**Block 2** (Input mode `I` prefix): `I103CHASUS33XXXXN`
- `I` — Input direction (bank sending to SWIFT)
- `103` — Message type
- `CHASUS33XXXX` — Receiver BIC
- `N` — Priority (Normal)

> [!WARNING]
> Block 2 has two forms: **Input** (`I` prefix, used when a bank sends to SWIFT) and **Output** (`O` prefix, used when SWIFT delivers to the receiver bank). Many parser bugs arise from treating them identically. The output form includes a sender's date-time and the MIR, adding significant extra bytes before the priority field.

**Block 4** contains tagged fields. Each field starts with `:TAG:` or `:TAG/QUALIFIER:`. Multi-line field values use the continuation convention (lines after the first begin with no colon). Block 4 is terminated with `-}`.

**Block 5 trailers** include:
- `CHK` — 12-hex-character checksum over Block 4
- `MAC` — Message Authentication Code (older bilateral key exchange)
- `PKI` — Public Key Infrastructure signature (SWIFTNet PKI)
- `PDE` — Possible Duplicate Emission flag

## MT103 Field-by-Field Breakdown

MT103 is the workhorse of international customer credit transfers. The following are the most critical fields:

| Tag | Name | M/O | Format | Example |
|-----|------|-----|--------|---------|
| 20 | Transaction Reference Number | M | 16x | `TXREF20241101001` |
| 23B | Bank Operation Code | M | 4!a | `CRED` |
| 32A | Value Date / Currency / Amount | M | 6!n3!a15d | `241101USD50000,00` |
| 33B | Currency / Instructed Amount | O | 3!a15d | `EUR46200,00` |
| 50K | Ordering Customer | M | 35x | ACME EXPORTS GMBH |
| 52A | Ordering Institution | O | BIC | `DEUTDEDBAXXX` |
| 56A | Intermediary Institution | O | BIC | `IRVTUS3N` |
| 57A | Account With Institution | O | BIC | `BOFAUS3N` |
| 59 | Beneficiary Customer | M | 35x | WIDGETS INC |
| 70 | Remittance Information | O | 4*35x | `INVOICE INV-2024-00891` |
| 71A | Details of Charges | M | 3!a | `SHA` / `OUR` / `BEN` |
| 71F | Sender's Charges | O | 3!a15d | `USD25,00` |
| 72 | Sender to Receiver Information | O | 6*35x | `/INS/CHASUS33` |
| 121 | UETR (GPI) | O (GPI M) | UUID | `550e8400-e29b-41d4-a716-...` |

> [!IMPORTANT]
> Field 32A uses a **comma as the decimal separator** (European convention), not a period. `50000,00` means fifty thousand USD. Parsing this with `Double.parseDouble()` without replacing the comma first will silently produce `50000` (or throw a `NumberFormatException` depending on locale). Always use `BigDecimal` for monetary amounts.

## Java SwiftMessageParser

The **prowide-core** (formerly WIFE) open-source library is the standard choice for MT parsing in Java. Add the dependency:

```xml
<!-- pom.xml -->
<dependency>
    <groupId>com.prowidesoftware</groupId>
    <artifactId>pw-swift-core</artifactId>
    <version>SRU2024-10.1.0</version>
</dependency>
```

A production-grade parser that extracts payment fields and validates critical constraints:

```java
import com.prowidesoftware.swift.model.SwiftMessage;
import com.prowidesoftware.swift.model.mt.mt1xx.MT103;
import com.prowidesoftware.swift.model.field.*;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Optional;

public class SwiftMessageParser {

    private static final DateTimeFormatter SWIFT_DATE = DateTimeFormatter.ofPattern("yyMMdd");

    public ParsedMt103 parseMt103(String rawMessage) {
        SwiftMessage swiftMessage = SwiftMessage.parse(rawMessage);

        if (swiftMessage == null || swiftMessage.getBlock4() == null) {
            throw new SwiftParseException("Null or empty Block4 — message is malformed");
        }

        MT103 mt103 = new MT103(swiftMessage);
        validateMandatoryFields(mt103);

        return ParsedMt103.builder()
                .transactionRef(extractField20(mt103))
                .valueDate(extractValueDate(mt103))
                .currency(extractCurrency(mt103))
                .amount(extractAmount(mt103))
                .orderingCustomer(extractOrderingCustomer(mt103))
                .beneficiary(extractBeneficiary(mt103))
                .accountWithInstitution(extractAwi(mt103))
                .chargeBearer(extractChargeBearer(mt103))
                .remittanceInfo(extractRemittance(mt103))
                .uetr(extractUetr(mt103))
                .build();
    }

    private void validateMandatoryFields(MT103 mt103) {
        if (mt103.getField20() == null) {
            throw new SwiftValidationException("MT103 missing mandatory field 20 (TRN)");
        }
        if (mt103.getField32A() == null) {
            throw new SwiftValidationException("MT103 missing mandatory field 32A (Value/Currency/Amount)");
        }
        if (mt103.getField59() == null && mt103.getField59A() == null && mt103.getField59F() == null) {
            throw new SwiftValidationException("MT103 missing mandatory field 59 (Beneficiary)");
        }
        if (mt103.getField71A() == null) {
            throw new SwiftValidationException("MT103 missing mandatory field 71A (Charge Bearer)");
        }
    }

    private String extractField20(MT103 mt103) {
        return mt103.getField20().getValue().trim();
    }

    private LocalDate extractValueDate(MT103 mt103) {
        String raw = mt103.getField32A().getComponent1(); // yyMMdd
        return LocalDate.parse(raw, SWIFT_DATE);
    }

    private String extractCurrency(MT103 mt103) {
        return mt103.getField32A().getComponent2(); // ISO 4217
    }

    private BigDecimal extractAmount(MT103 mt103) {
        String raw = mt103.getField32A().getComponent3(); // e.g. "50000,00"
        return new BigDecimal(raw.replace(",", "."));
    }

    private String extractOrderingCustomer(MT103 mt103) {
        // Field 50K or 50A or 50F depending on structure used
        if (mt103.getField50K() != null) return mt103.getField50K().getValue();
        if (mt103.getField50A() != null) return mt103.getField50A().getValue();
        if (mt103.getField50F() != null) return mt103.getField50F().getValue();
        throw new SwiftValidationException("MT103 missing field 50 (Ordering Customer)");
    }

    private String extractBeneficiary(MT103 mt103) {
        if (mt103.getField59() != null)  return mt103.getField59().getValue();
        if (mt103.getField59A() != null) return mt103.getField59A().getValue();
        if (mt103.getField59F() != null) return mt103.getField59F().getValue();
        throw new SwiftValidationException("MT103 missing field 59 (Beneficiary)");
    }

    private Optional<String> extractAwi(MT103 mt103) {
        return Optional.ofNullable(mt103.getField57A())
                .map(Field57A::getValue)
                .map(String::trim);
    }

    private ChargeBearer extractChargeBearer(MT103 mt103) {
        return switch (mt103.getField71A().getValue().trim()) {
            case "SHA" -> ChargeBearer.SHARED;
            case "OUR" -> ChargeBearer.SENDER;
            case "BEN" -> ChargeBearer.BENEFICIARY;
            default -> throw new SwiftValidationException(
                "Invalid 71A value: " + mt103.getField71A().getValue());
        };
    }

    private Optional<String> extractRemittance(MT103 mt103) {
        return Optional.ofNullable(mt103.getField70()).map(Field70::getValue);
    }

    private Optional<String> extractUetr(MT103 mt103) {
        // UETR is in block 3 service type identifier or field 121 (GPI)
        return Optional.ofNullable(mt103.getSwiftMessage().getBlock3())
                .map(b3 -> b3.getTagValue("121"));
    }
}
```

```java
// Domain model
public record ParsedMt103(
        String transactionRef,
        LocalDate valueDate,
        String currency,
        BigDecimal amount,
        String orderingCustomer,
        String beneficiary,
        Optional<String> accountWithInstitution,
        ChargeBearer chargeBearer,
        Optional<String> remittanceInfo,
        Optional<String> uetr
) {}

public enum ChargeBearer { SHARED, SENDER, BENEFICIARY }
```

## MT202 Financial Institution Transfer

MT202 is used for **bank-to-bank transfers**, typically as the cover payment that accompanies a serial MT103 chain or settles interbank positions. It does **not** contain ordering customer or beneficiary customer fields — those are strictly interbank.

Key differences from MT103:

| Field | MT103 | MT202 |
|-------|-------|-------|
| 50 (Ordering Customer) | Mandatory | Not present |
| 59 (Beneficiary Customer) | Mandatory | Not present |
| 58A (Beneficiary Institution) | Not present | Mandatory |
| 21 (Related Reference) | Optional | Mandatory |
| 72 (Sender to Receiver) | Optional | Optional |

> [!NOTE]
> MT202COV (the "covered" variant) was introduced to address a FATF recommendation. When an MT202COV accompanies a customer payment, it must contain the originator and beneficiary details in field 50a and 59a of a mandatory "underlying customer credit transfer" sequence. This closed a loophole where correspondent banks could not screen end-customers.

## MT940 Account Statement and Reconciliation

MT940 is the **customer statement message** sent by a bank to its customer (or correspondent) summarizing account movements. It is the primary feed for nostro reconciliation.

```
{1:F01CHASUS33AXXX0000000500}
{2:O9400900241102DEUTDEDBAXXX00000000012411020900N}
{4:
:20:STMT20241102001
:25:12345678901234
:28C:00050/001
:60F:C241101USD1250000,00
:61:2411021102CD50000,00NTRFREF20241101001//CHREF001
:86:INCOMING WIRE TRANSFER
ACME EXPORTS GMBH
:62F:C241102USD1300000,00
-}
```

| Tag | Name | Meaning |
|-----|------|---------|
| 20 | Statement Reference | Unique reference for this statement |
| 25 | Account Identification | Account number |
| 28C | Statement / Sequence Number | Statement number / page number |
| 60F | Opening Balance | C/D + date + currency + amount |
| 61 | Statement Line | Individual transaction (value date, booking date, D/C, amount, type, ref) |
| 86 | Information to Account Owner | Free-text narrative for field 61 |
| 62F | Closing Balance | End-of-day balance |

A Java reconciliation processor that matches MT940 entries against expected nostro postings:

```java
import com.prowidesoftware.swift.model.mt.mt9xx.MT940;
import com.prowidesoftware.swift.model.field.Field61;

import java.math.BigDecimal;
import java.util.List;
import java.util.stream.Collectors;

public class NostroReconciliationService {

    private final NostroLedgerRepository ledger;

    public ReconciliationResult reconcile(String mt940Raw) {
        MT940 stmt = MT940.parse(mt940Raw);
        String accountId = stmt.getField25().getValue().trim();
        BigDecimal openingBalance = parseBalance(stmt.getField60F().getValue());

        List<StatementEntry> statementEntries = stmt.getField61()
                .stream()
                .map(this::toStatementEntry)
                .collect(Collectors.toList());

        List<NostroPosting> ledgerPostings = ledger.findByAccountAndDate(
                accountId, stmt.getField60F().getComponent2());

        return ReconciliationEngine.match(statementEntries, ledgerPostings, openingBalance);
    }

    private StatementEntry toStatementEntry(Field61 f61) {
        String dOrC     = f61.getComponent3(); // "D", "C", "RD", "RC"
        BigDecimal amt  = new BigDecimal(f61.getComponent5().replace(",", "."));
        boolean isDebit = dOrC.startsWith("D");
        return new StatementEntry(
                f61.getComponent1(),                     // value date
                isDebit ? amt.negate() : amt,
                f61.getComponent9(),                     // customer reference
                f61.getComponent10()                     // bank reference
        );
    }

    private BigDecimal parseBalance(String raw) {
        // Format: C/D + 6-digit date + 3-char currency + amount,cents
        boolean credit = raw.charAt(0) == 'C';
        String amountPart = raw.substring(10).replace(",", ".");
        BigDecimal value = new BigDecimal(amountPart);
        return credit ? value : value.negate();
    }
}
```

## SWIFT GPI and UETR Tracking

SWIFT Global Payments Innovation (GPI) is the overlay service that adds end-to-end tracking, speed SLAs, and fee transparency to the existing MT infrastructure. GPI mandates:

1. A **UETR (Unique End-to-end Transaction Reference)** — a UUID v4 — in Block 3, tag `{121:}` for every payment in the chain
2. Each bank in the chain must update the GPI Tracker within **hours** (the standard SLA is payment credited same day, with the majority credited within minutes)
3. Status codes are reported: `ACSP` (accepted, settlement in process), `ACCC` (accepted, credit completed), `RJCT` (rejected)

```java
public class GpiTracker {

    private final SwiftTrackerApiClient trackerClient;

    public PaymentStatus queryStatus(String uetr) {
        GpiTrackerResponse response = trackerClient.getTransaction(uetr);
        return switch (response.getTransactionStatus()) {
            case "ACCC" -> PaymentStatus.CREDITED;
            case "ACSP" -> PaymentStatus.IN_TRANSIT;
            case "RJCT" -> PaymentStatus.REJECTED;
            case "PDNG" -> PaymentStatus.PENDING;
            default -> PaymentStatus.UNKNOWN;
        };
    }

    public String generateUetr() {
        return java.util.UUID.randomUUID().toString();
    }

    public void updateTrackerOnCredit(String uetr, String creditedAccountBic,
                                       BigDecimal amount, String currency) {
        trackerClient.postStatusUpdate(GpiStatusUpdate.builder()
                .uetr(uetr)
                .transactionStatus("ACCC")
                .instructedAmount(amount)
                .instructedCurrency(currency)
                .creditedDebtorAccount(creditedAccountBic)
                .acceptanceDateTime(java.time.OffsetDateTime.now())
                .build());
    }
}
```

## Error Handling and Rejection Codes

SWIFT FIN can reject messages at the network level (NAK) or the receiving bank can generate a negative acknowledgement (N999 / MT199). Common NAK codes:

| Code | Meaning | Java Handling |
|------|---------|---------------|
| T13 | Invalid currency code in field 32A | Reject at parse time, dead-letter queue |
| T14 | Amount too large for currency | Reject with business error |
| T18 | Invalid BIC in field 57A | Validate BIC before sending |
| T28 | Field 20 contains forbidden characters | Strip/replace at serialization |
| D97 | Duplicate MUR (block 3 field 108) | Idempotency check before submit |
| E10 | Block 2 format error | Critical — means serializer is broken |

```java
public class SwiftSubmissionService {

    private final SwiftGateway gateway;
    private final DeadLetterQueue dlq;

    public SubmissionResult submit(ParsedMt103 payment) {
        String mtRaw;
        try {
            mtRaw = Mt103Serializer.serialize(payment);
        } catch (SerializationException ex) {
            dlq.enqueue(payment, "SERIALIZATION_FAILURE", ex.getMessage());
            return SubmissionResult.failure("SERIALIZATION_FAILURE");
        }

        GatewayResponse response = gateway.send(mtRaw);

        return switch (response.getAck()) {
            case ACK  -> SubmissionResult.success(response.getMir());
            case NAK  -> handleNak(payment, response);
            case TIMEOUT -> {
                // PDE (Possible Duplicate Emission) guard: check if already delivered
                boolean alreadyDelivered = gateway.checkDuplicate(payment.transactionRef());
                yield alreadyDelivered
                        ? SubmissionResult.possibleDuplicate(response.getCode())
                        : SubmissionResult.retry(response.getCode());
            }
        };
    }

    private SubmissionResult handleNak(ParsedMt103 payment, GatewayResponse response) {
        return switch (response.getNakCode()) {
            case "D97" -> {
                // Duplicate — safe to discard if idempotent
                log.warn("Duplicate MUR detected for TRN {}", payment.transactionRef());
                yield SubmissionResult.duplicate();
            }
            case "T13", "T14", "T28" -> {
                dlq.enqueue(payment, "BUSINESS_VALIDATION", response.getNakCode());
                yield SubmissionResult.failure(response.getNakCode());
            }
            default -> {
                dlq.enqueue(payment, "SWIFT_REJECTION", response.getNakCode());
                yield SubmissionResult.failure(response.getNakCode());
            }
        };
    }
}
```

> [!WARNING]
> Never auto-retry a NAK without first diagnosing the rejection code. Retrying a D97 (duplicate) will generate a second D97. Retrying a T18 (invalid BIC) will fail every time. Build a classification layer that distinguishes retryable network errors from permanent business rejections before any retry logic.

## Knowledge Check

**Q1: An MT103 arrives where field 32A contains `241101EUR1234567,` (note trailing comma, no cents). Your parser calls `new BigDecimal(raw.replace(",", "."))` and receives `1234567.` — which is valid BigDecimal. Should this message be accepted?**

A: Technically BigDecimal accepts `1234567.` but the SWIFT format rule for field 32A specifies the amount sub-field as `15d` — meaning up to 15 digits with the comma being mandatory only if decimals are present. A trailing comma with no following digits violates the format specification. The message should be rejected with a format validation error logged against field 32A, and an MT199 negative acknowledgement sent to the originator. Never silently accept a malformed amount field in a payment system — the cents omission could indicate a data corruption issue.

**Q2: Your SWIFT gateway sends an MT103 and receives no ACK or NAK within the timeout window. How should your system handle the possible duplicate emission scenario?**

A: When a timeout occurs, the message may or may not have been received by SWIFT. If you retransmit without safeguards you risk double-crediting the beneficiary. The correct protocol is: (1) set a PDE (Possible Duplicate Emission) flag in block 5 trailer `{PDE:}` on any retransmit; (2) check the SWIFT Alliance Access local journal for any MIR assigned to the original message, since ACK can sometimes arrive late; (3) query the GPI Tracker by UETR — if status is `ACCC` the payment was delivered and retransmit must be suppressed; (4) if UETR status is absent or `PDNG`, retransmit with PDE and use an idempotency key (MUR in block 3) so the receiving bank can deduplicate.

## Practical Challenge

1. **Parser implementation:** Using prowide-core, write a `SwiftMt940Parser` that reads an MT940 message and returns a list of `StatementLine` records containing: value date, booking date, debit/credit indicator, amount as `BigDecimal`, customer reference, and bank reference. Validate that the sum of all debit and credit entries reconciles with the difference between field 60F and field 62F balances. Throw a `ReconciliationException` with the discrepancy amount if they do not match.

2. **MT103 serializer with GPI:** Write an `Mt103Builder` class that constructs a valid MT103 raw string from a `PaymentInstruction` domain object. The builder must: generate a UUID v4 UETR and inject it into Block 3 as tag `{121:}`; format field 32A correctly (comma decimal separator, `yyMMdd` date format); enforce the 16-character limit on field 20; and pad or truncate field 70 remittance info to exactly 4 lines of 35 characters.

3. **Error classification service:** Implement a `SwiftNakClassifier` that takes a NAK code string and returns one of four enum values: `RETRYABLE_NETWORK`, `RETRYABLE_BUSINESS`, `PERMANENT_FORMAT`, `PERMANENT_DUPLICATE`. Write unit tests covering codes E10, T13, T18, D97, and Y04. The classifier should read its rules from an injected configuration map to remain extensible without code changes.

4. **GPI status polling job:** Write a Spring `@Scheduled` job that queries the SWIFT GPI Tracker for all in-flight payments (status `ACSP`) older than 4 hours. For each, fetch current status. If still `ACSP`, emit a monitoring alert. If `ACCC`, update the payment record to `CREDITED` and release any downstream holds. If `RJCT`, trigger the payment repair workflow. Ensure the job is idempotent and safe to run on multiple nodes using a database-level advisory lock or a distributed lock via Redis.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "An MT103 field 32A contains `241101EUR1234567,` (trailing comma, no cents). Your parser produces a valid BigDecimal of `1234567.`. Should this message be accepted?",
      "options": [
        "Yes — BigDecimal accepts it and the amount is unambiguous",
        "No — the trailing comma violates the SWIFT 15d format specification and must be rejected with an MT199 NAK",
        "Yes — silently strip the trailing comma and process normally",
        "No — reject with a T18 (invalid BIC) error code"
      ],
      "correct": 1,
      "explanation": "SWIFT field 32A specifies the amount sub-field as `15d`. A trailing comma with no following digits violates the format specification. The message must be rejected with a format validation error logged against field 32A and an MT199 negative acknowledgement sent to the originator. Never silently accept a malformed amount field."
    },
    {
      "text": "Your SWIFT gateway sends an MT103 and receives no ACK or NAK within the timeout window. What is the correct protocol for handling the possible duplicate emission scenario?",
      "options": [
        "Immediately retransmit the same message without any changes",
        "Cancel the payment and notify the customer",
        "Set a PDE flag on retransmit, check GPI Tracker by UETR, and suppress retransmit if status is ACCC",
        "Wait 24 hours before taking any action"
      ],
      "correct": 2,
      "explanation": "On timeout, set a PDE (Possible Duplicate Emission) flag in block 5 trailer `{PDE:}` on any retransmit, check the SWIFT Alliance Access local journal for a MIR, then query the GPI Tracker by UETR. If status is `ACCC` the payment was delivered and retransmit must be suppressed. If status is `PDNG`, retransmit with PDE and use an idempotency key (MUR in block 3)."
    },
    {
      "text": "Which SWIFT block contains the UETR (Unique End-to-end Transaction Reference) used by GPI tracking?",
      "options": [
        "Block 1 (Basic Header)",
        "Block 2 (Application Header)",
        "Block 3 (User Header), tag {121:}",
        "Block 4 (Text Block), field 20"
      ],
      "correct": 2,
      "explanation": "The UETR is a UUID v4 placed in Block 3 (User Header) under tag `{121:}`. It enables end-to-end GPI tracking across the entire correspondent chain and must be generated by the originating bank and preserved by all intermediary banks."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "SWIFT MT Processing and GPI Tracking Implementation",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Using prowide-core, write a `SwiftMt940Parser` that reads an MT940 message and returns a list of `StatementLine` records. Validate that the sum of all debit and credit entries reconciles with the difference between field 60F and field 62F balances. Throw a `ReconciliationException` with the discrepancy amount if they do not match."
    },
    {
      "id": "2",
      "description": "Write an `Mt103Builder` class that constructs a valid MT103 raw string from a `PaymentInstruction` domain object. Generate a UUID v4 UETR and inject it into Block 3 as tag `{121:}`; format field 32A correctly with comma decimal separator and `yyMMdd` date format; enforce the 16-character limit on field 20."
    },
    {
      "id": "3",
      "description": "Implement a `SwiftNakClassifier` that takes a NAK code string and returns one of four enum values: `RETRYABLE_NETWORK`, `RETRYABLE_BUSINESS`, `PERMANENT_FORMAT`, `PERMANENT_DUPLICATE`. Write unit tests covering codes E10, T13, T18, D97, and Y04. The classifier should read its rules from an injected configuration map."
    },
    {
      "id": "4",
      "description": "Write a Spring `@Scheduled` job that queries the SWIFT GPI Tracker for all in-flight payments (status `ACSP`) older than 4 hours. Update status to `CREDITED` for `ACCC`, trigger repair for `RJCT`, and emit alerts for still-`ACSP` payments. Ensure the job is idempotent across multiple nodes using a distributed lock."
    }
  ]
}
-->
