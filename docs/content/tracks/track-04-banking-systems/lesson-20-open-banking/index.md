---
id: "track-04-lesson-20"
title: "Open Banking, PSD2, and API Architecture"
track: "track-04"
track-name: "Banking & Financial Systems Architecture"
sequence: 20
slug: "open-banking-psd2"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"
prerequisites: ["track-04-lesson-08", "track-04-lesson-19"]
tags: ["open-banking", "PSD2", "AISP", "PISP", "consent-management", "CDR"]
java-versions: [17, 21]
topics:
  - "PSD2 Roles: AISP, PISP, and CBPII"
  - "Consent Lifecycle"
  - "Open Banking UK vs Berlin Group vs CDR"
  - "ConsentService Implementation"
  - "OAuth2 and FAPI Security Profile"
  - "AccountInformationController"
  - "Strong Customer Authentication and Exemptions"
  - "PaymentInitiationController with Idempotency"
  - "eIDAS Certificates and mTLS"
  - "API Rate Limiting per TPP"
components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true
references:
  - "PSD2 Directive 2015/2366/EU — Articles 65-67, 97-98"
  - "OpenID Foundation FAPI 2.0 Security Profile, 2023"
  - "Open Banking Limited — Open Banking API Specification v3.1.11"
  - "Australian Treasury — Consumer Data Right (CDR) Rules 2020"
---

## Overview

Open banking mandates that financial institutions expose customer account data and payment initiation capabilities to regulated third parties via standardised APIs — fundamentally changing the competitive architecture of retail banking. By 2025 the UK ecosystem had more than 10 million users and handled well over a billion API calls a month. For the engineering teams building both the bank-side API infrastructure (Account Servicing Payment Service Providers — ASPSPs) and the TPP-side integrations, the domain introduces a distinctive set of challenges: consent management as a first-class stateful resource, cryptographic identity via certificates (eIDAS in the EU, Open Banking certificates in the UK) rather than shared API keys, and the Financial-grade API (FAPI) security profile that extends OAuth2 to meet banking-specific threat models.

## Learning Objectives

- Define the three PSD2 TPP roles (AISP, PISP, CBPII) and map their permissions to the specific API endpoints and data scopes each requires
- Model the consent lifecycle (awaiting authorisation, authorised, rejected, revoked, expired, consumed) as a state machine and implement it as a PostgreSQL-backed `ConsentService`
- Compare Open Banking UK, Berlin Group NextGenPSD2, and Australian CDR API standards across data model, authorisation flow, and consent semantics
- Implement an OAuth2 + FAPI 2.0 authorisation flow including PAR (Pushed Authorisation Request) and DPoP-bound access tokens
- Build an `AccountInformationController` exposing balances and transactions with correct consent scope verification
- Implement a `PaymentInitiationController` with strict idempotency semantics and domestic/international payment routing
- Apply SCA exemption logic to reduce unnecessary friction, tracking exemption application rates in Prometheus metrics
- Configure mTLS client authentication against an eIDAS QWAC (EU) or Open Banking certificate (UK) and validate it against the scheme's trust store (e.g., the Open Banking Directory)

## Business Context

*Composite example (based on common open banking implementation defects, not a specific bank):* an ASPSP's internal review finds three problems in its open banking API. Third-party access kept working long past the point where the customer should have re-authenticated; access was not reviewed when the customer reported their credentials compromised and reset their password; and the account information API returned transactions outside the date range the customer had consented to. All three had one root cause: consent was modelled as a flag on the user account rather than as an independent stateful entity with its own lifecycle. When credentials changed, nothing looked at the flag. When the re-authentication interval passed, nothing expired it. When the transaction query ran, it did not check the requested dates against the consent. Modelling consent as a first-class domain entity — with explicit state transitions, expiry enforcement, and scope validation at every API call — prevents all three.

## PSD2 Roles: AISP, PISP, and CBPII

PSD2 defines three categories of third-party payment service provider, each with distinct permissions:

| Role | Full name | Permitted actions | Data accessed |
|---|---|---|---|
| AISP | Account Information Service Provider | Read balances, transactions, account metadata | Account data only — no payment initiation |
| PISP | Payment Initiation Service Provider | Initiate payments from customer's account | Only confirms initiation; no balance/transaction access |
| CBPII | Card-Based Payment Instrument Issuer | Check available funds before card authorisation | Balance confirmation only (yes/no) — no amounts |

A single TPP may hold all three licences. The permissions are additive but scope-isolated: an AISP consent does not grant payment initiation rights; a PISP cannot access transaction history unless it also holds AISP consent separately granted.

> [!NOTE]
> Under PSD2 Article 68(5), an ASPSP may deny a TPP access for "objectively justified and duly evidenced reasons relating to unauthorised or fraudulent access", but must inform the customer and report the incident to the competent authority immediately. An automated TPP anomaly detection system (unusual request rates, out-of-hours access patterns) that can suspend a TPP's access, record the evidence, and start the regulatory notification is therefore strongly advisable. Note also RTS Article 36(5): without the customer actively requesting it, an AISP may access account data at most four times in 24 hours (unless agreed otherwise).

## Consent Lifecycle

```mermaid
stateDiagram-v2
    [*] --> AwaitingAuthorisation : TPP creates consent intent
    AwaitingAuthorisation --> Authorised : Customer completes SCA
    AwaitingAuthorisation --> Rejected : Customer declines or SCA fails
    Authorised --> Revoked : Customer or TPP revokes
    Authorised --> Expired : Consent expiry date or\nre-authentication interval reached
    Authorised --> Consumed : PISP one-off payment executed\n(single-use consents only)
    Rejected --> [*]
    Revoked --> [*]
    Expired --> [*]
    Consumed --> [*]
```

Each transition must be persisted with a timestamp and actor (customer, TPP, ASPSP system) for audit. Security events — such as the customer reporting compromised credentials — should trigger a review of active consents rather than being ignored.

How long access lasts without the customer re-authenticating with the bank depends on the jurisdiction. In the EU, the amended RTS (since 2023) require SCA at the bank for AIS access via an AISP at least every **180 days**. In the UK, since 2022 the **TPP** reconfirms the customer's consent every 90 days and the bank no longer has to apply SCA again. Make this interval configuration, not a hard-coded constant.

The `AwaitingAuthorisation` state has its own timeout (typically 15-30 minutes): if the customer does not complete SCA within the window, the consent intent is abandoned.

## ConsentService Implementation

```java
@Service
@Slf4j
public class ConsentService {

    private final ConsentRepository consentRepo;
    private final Clock clock;

    /**
     * Creates a consent intent (AwaitingAuthorisation).
     * Returns a consentId that the TPP embeds in the OAuth2 authorisation request.
     */
    @Transactional
    public Consent createConsentIntent(ConsentRequest request) {
        validateScopes(request.scopes(), request.tppRole());

        Consent consent = Consent.builder()
            .consentId(UUID.randomUUID().toString())
            .tppId(request.tppId())
            .customerId(null)              // Not yet known — customer hasn't authenticated
            .scopes(request.scopes())
            .permissions(request.permissions())
            .fromDate(request.fromDate())
            .toDate(request.toDate())
            .expirationDateTime(request.expirationDateTime())
            .status(ConsentStatus.AWAITING_AUTHORISATION)
            .createdAt(clock.instant())
            .intentExpiresAt(clock.instant().plus(Duration.ofMinutes(15)))
            .build();

        return consentRepo.save(consent);
    }

    /**
     * Customer has completed SCA — transition to Authorised.
     * Called by the ASPSP's authorisation server after successful authentication.
     */
    @Transactional
    public Consent authorise(String consentId, String customerId) {
        Consent consent = getConsentOrThrow(consentId);

        if (consent.status() != ConsentStatus.AWAITING_AUTHORISATION) {
            throw new InvalidConsentStateException(consentId, consent.status(),
                ConsentStatus.AWAITING_AUTHORISATION);
        }
        if (clock.instant().isAfter(consent.intentExpiresAt())) {
            throw new ConsentIntentExpiredException(consentId);
        }

        // Compute actual expiry: min(requested expiry, now + re-authentication
        // interval for this jurisdiction — e.g. 180 days in the EU since 2023)
        Instant maxExpiry = clock.instant().plus(jurisdictionPolicy.reauthenticationInterval());
        Instant effectiveExpiry = consent.expirationDateTime() != null
            ? consent.expirationDateTime().isBefore(maxExpiry)
                ? consent.expirationDateTime() : maxExpiry
            : maxExpiry;

        return consentRepo.save(consent.toBuilder()
            .customerId(customerId)
            .status(ConsentStatus.AUTHORISED)
            .authorisedAt(clock.instant())
            .effectiveExpiresAt(effectiveExpiry)
            .build());
    }

    /**
     * Revoke an existing consent. Any party (customer, TPP, or ASPSP) may revoke.
     */
    @Transactional
    public void revoke(String consentId, RevocationActor actor, String reason) {
        Consent consent = getConsentOrThrow(consentId);
        if (!consent.isRevocable()) {
            throw new InvalidConsentStateException(consentId, consent.status(), null);
        }
        consentRepo.save(consent.toBuilder()
            .status(ConsentStatus.REVOKED)
            .revokedAt(clock.instant())
            .revokedBy(actor)
            .revocationReason(reason)
            .build());
        log.info("Consent revoked: consentId={}, actor={}, reason={}", consentId, actor, reason);
    }

    /**
     * Verifies that an active consent covers the requested permission and date range.
     * Called by API controllers before returning any data.
     */
    public void verifyActive(String consentId, Permission requiredPermission,
                              LocalDate queryFromDate, LocalDate queryToDate) {
        Consent consent = getConsentOrThrow(consentId);

        if (consent.status() != ConsentStatus.AUTHORISED) {
            throw new ConsentNotActiveException(consentId, consent.status());
        }
        if (clock.instant().isAfter(consent.effectiveExpiresAt())) {
            // Expire lazily on access
            consentRepo.save(consent.toBuilder().status(ConsentStatus.EXPIRED).build());
            throw new ConsentExpiredException(consentId);
        }
        if (!consent.permissions().contains(requiredPermission)) {
            throw new InsufficientConsentPermissionsException(consentId, requiredPermission);
        }
        // BOTH ends of the requested range must lie inside the consented range
        if (queryFromDate != null && consent.fromDate() != null
                && queryFromDate.isBefore(consent.fromDate())) {
            throw new ConsentDateRangeViolationException(consentId, queryFromDate, consent.fromDate());
        }
        if (queryToDate != null && consent.toDate() != null
                && queryToDate.isAfter(consent.toDate())) {
            throw new ConsentDateRangeViolationException(consentId, queryToDate, consent.toDate());
        }
    }

    private Consent getConsentOrThrow(String consentId) {
        return consentRepo.findById(consentId)
            .orElseThrow(() -> new ConsentNotFoundException(consentId));
    }
}
```

## OAuth2 and FAPI 2.0 Security Profile

FAPI (Financial-grade API) is an OpenID Foundation profile that extends OAuth2 with additional security requirements for high-value API access.

| Requirement | Vanilla OAuth2 | FAPI 1.0 Advanced | FAPI 2.0 |
|---|---|---|---|
| Client authentication | client_secret (basic/post) | private_key_jwt or mTLS | private_key_jwt or mTLS |
| Authorisation request | Query string | JAR (signed request object), or PAR | PAR required (JAR optional) |
| Token binding | None (bearer) | mTLS-bound tokens | Sender-constrained: mTLS or DPoP |
| Redirect URI | Pre-registered | Pre-registered + exact match | Pre-registered + exact match |
| PKCE | Recommended | Required with PAR | Required (S256) |
| CSRF protection | `state` recommended | `state` required | PKCE (no separate `state` requirement) |

**Pushed Authorisation Requests (PAR):** Instead of sending authorisation parameters in the browser redirect URL (exposing them in browser history, server logs), PAR sends them directly to the authorisation server in a back-channel POST, returning an opaque `request_uri` reference used in the browser redirect.

```java
// FAPI 2.0 PAR request (back-channel, server-to-server)
@PostMapping("/as/par")
public ParResponse pushedAuthorisationRequest(
        @RequestHeader(value = "DPoP", required = false) String dpopProof,  // if DPoP is used
        @RequestBody MultiValueMap<String, String> params,
        HttpServletRequest httpRequest) {

    // Authenticate the client: mTLS certificate (eIDAS QWAC / OB certificate)
    // or private_key_jwt client assertion
    X509Certificate clientCert = extractAndVerifyClientCertificate(httpRequest);
    String tppId = certificateValidator.validateAndExtract(clientCert).organisationId();

    // Validate signed JWT request object (JAR), if the profile uses one
    JwtClaimsSet claims = jarValidator.validate(params.getFirst("request"),
        tppPublicKeyResolver.resolve(tppId));

    String consentId = claims.getClaim("consentId");
    Consent consent = consentService.getConsentOrThrow(consentId);   // must exist...
    if (!consent.tppId().equals(tppId)) {                            // ...and belong to THIS TPP
        throw new InvalidRequestObjectException("Consent belongs to another TPP");
    }

    // Short-lived, ONE-TIME request_uri (RFC 9126 format)
    String requestUri = "urn:ietf:params:oauth:request_uri:" + UUID.randomUUID();
    parStore.storeOneTime(requestUri, claims, Duration.ofSeconds(60));

    return new ParResponse(requestUri, 60);
}
```

> [!IMPORTANT]
> Client certificates — eIDAS QWACs in the EU; in the UK, Open Banking certificates issued through the Open Banking Directory (eIDAS certificates are no longer recognised there after Brexit) — must be checked for revocation continuously, not just at onboarding, and the TPP's **authorisation status** must be checked against the register too: a TPP's licence can be withdrawn while its certificate is still technically valid. Cache OCSP responses for performance, but never beyond their validity period. Respond to a revoked certificate or deregistered TPP with a clear, specific error rather than a generic 401.

## AccountInformationController

```java
@RestController
@RequestMapping("/open-banking/v3.1/aisp")
public class AccountInformationController {

    private final ConsentService consentService;
    private final AccountService accountService;
    private final TransactionService transactionService;

    @GetMapping("/accounts")
    public ResponseEntity<OBReadAccount6> getAccounts(
            @RequestAttribute("consentId") String consentId,
            @RequestAttribute("customerId") String customerId) {

        consentService.verifyActive(consentId, Permission.READ_ACCOUNTS_BASIC, null, null);

        List<Account> accounts = accountService.findByCustomer(customerId);
        OBReadAccount6 response = accountMapper.toOBReadAccount6(accounts);
        return ResponseEntity.ok(response);
    }

    @GetMapping("/accounts/{accountId}/transactions")
    public ResponseEntity<OBReadTransaction6> getTransactions(
            @PathVariable String accountId,
            @RequestParam(required = false) @DateTimeFormat(iso = ISO.DATE) LocalDate fromBookingDate,
            @RequestParam(required = false) @DateTimeFormat(iso = ISO.DATE) LocalDate toBookingDate,
            @RequestAttribute("consentId") String consentId,
            @RequestAttribute("customerId") String customerId) {

        // Verify consent covers this permission and date range
        consentService.verifyActive(consentId, Permission.READ_TRANSACTIONS_DETAIL,
            fromBookingDate, toBookingDate);

        // Verify the account belongs to the consenting customer AND was one of
        // the accounts the customer selected when granting this consent
        accountService.verifyOwnership(accountId, customerId);
        consentService.verifyAccountInConsent(consentId, accountId);

        // No dates given → default to the consented range, never "everything"
        DateRange range = consentService.clampToConsent(consentId, fromBookingDate, toBookingDate);
        List<Transaction> transactions = transactionService.find(
            accountId, range.from(), range.to());

        return ResponseEntity.ok(transactionMapper.toOBReadTransaction6(transactions));
    }
}
```

## Strong Customer Authentication and Exemptions

SCA requires at least two independent factors from different categories: something you know (PIN/password), something you have (device/card), something you are (biometric). The RTS specify several exemptions where SCA may be skipped. Note who decides: for a payment initiated through a PISP, it is the **ASPSP** (the payer's bank) that applies or refuses an exemption — the PISP cannot force one. The evaluator below therefore runs on the ASPSP side.

```java
public class ScaExemptionEvaluator {

    private final TransactionRiskAssessor riskAssessor;
    private final TrustedBeneficiaryRegistry trustedBeneficiaries;
    private final ExemptionMetrics metrics;

    public ScaExemptionResult evaluate(PaymentInitiationRequest request) {
        // Low-value (remote) exemption: single ≤ €30, until cumulative > €100
        // or 5 consecutive transactions since the last SCA
        if (request.amount().compareTo(LOW_VALUE_THRESHOLD) <= 0
                && !lowValueCumulativeExceeded(request.psuId())) {
            metrics.increment("low_value_exemption_applied");
            return ScaExemptionResult.exempt(ExemptionType.LOW_VALUE);
        }

        // Trusted beneficiary: PSU has added this payee to their trusted list
        // (creating or changing that list itself requires SCA)
        if (trustedBeneficiaries.isTrusted(request.psuId(), request.creditorIban())) {
            metrics.increment("trusted_beneficiary_exemption_applied");
            return ScaExemptionResult.exempt(ExemptionType.TRUSTED_BENEFICIARY);
        }

        // TRA exemption for CREDIT TRANSFERS: this PSP's fraud rate must be
        // below the reference rate for the amount band —
        //   ≤ €100: 0.015%;  ≤ €250: 0.01%;  ≤ €500: 0.005%
        // (card payments use 0.13% / 0.06% / 0.01%), AND the real-time risk
        // analysis must find no abnormal signals for this payment
        TransactionRiskScore riskScore = riskAssessor.score(request);
        if (request.amount().compareTo(TRA_MAX_AMOUNT) <= 0       // €500
                && fraudRateWithinThreshold(request.amount())
                && riskScore.isLow()) {
            metrics.increment("tra_exemption_applied");
            return ScaExemptionResult.exempt(ExemptionType.TRANSACTION_RISK_ANALYSIS);
        }

        return ScaExemptionResult.scaRequired();
    }
}
```

## PaymentInitiationController with Idempotency

```java
@RestController
@RequestMapping("/open-banking/v3.1/pisp")
public class PaymentInitiationController {

    private final ConsentService consentService;
    private final PaymentInitiationService paymentService;
    private final IdempotencyRepository idempotencyRepo;

    @PostMapping("/domestic-payments")
    public ResponseEntity<OBWriteDomesticResponse5> createDomesticPayment(
            @RequestHeader("x-idempotency-key") String idempotencyKey,
            @RequestBody OBWriteDomestic2 request,
            @RequestAttribute("tppId") String tppId,
            @RequestAttribute("consentId") String consentId,
            @RequestAttribute("customerId") String customerId) {

        // Idempotency FIRST — a single-use consent is CONSUMED by the first
        // payment, so checking the consent first would reject a legitimate retry.
        // Claim the key atomically with a hash of the payload
        // (INSERT ... ON CONFLICT DO NOTHING), scoped to this TPP.
        String payloadHash = sha256(canonicalJson(request));
        IdempotencyClaim claim = idempotencyRepo.claim(tppId, idempotencyKey, payloadHash);
        if (claim.isExisting()) {
            if (!claim.payloadHash().equals(payloadHash)) {
                // Same key, different payment → never process, never replay
                throw new IdempotencyPayloadMismatchException(idempotencyKey);   // HTTP 422
            }
            if (claim.isInProgress()) {
                throw new RequestInProgressException(idempotencyKey);           // HTTP 409, retry later
            }
            log.info("Idempotent response returned: key={}", idempotencyKey);
            return ResponseEntity.status(201).body(claim.storedResponse(OBWriteDomesticResponse5.class));
        }

        consentService.verifyActive(consentId, Permission.CREATE_DOMESTIC_PAYMENT, null, null);

        // Validate that payment data matches the consent
        validatePaymentMatchesConsent(request, consentId);

        PaymentInitiationResult result = paymentService.initiate(
            mapToInternalRequest(request, customerId, consentId));

        OBWriteDomesticResponse5 response = responseMapper.map(result);

        // Store the response against the claimed key (kept for the idempotency window)
        idempotencyRepo.complete(tppId, idempotencyKey, response);

        return ResponseEntity.status(201).body(response);
    }

    private void validatePaymentMatchesConsent(OBWriteDomestic2 payment, String consentId) {
        // The payment's Initiation block must EXACTLY match the consented one:
        // amount, currency, creditor account, reference. Any deviation is rejected.
        Consent consent = consentService.getConsentOrThrow(consentId);
        if (!payment.getData().getConsentId().equals(consentId)) {
            throw new PaymentConsentMismatchException("ConsentId mismatch");
        }
        if (!payment.getData().getInitiation().equals(consent.paymentInitiation())) {
            throw new PaymentConsentMismatchException("Initiation does not match consent");
        }
    }
}
```

> [!WARNING]
> Idempotency keys for payment initiation must be validated for exact payload match — not just key existence. If a TPP sends the same idempotency key with a different payment amount (a bug or attempted fraud), the ASPSP must return HTTP 422 `PAYLOAD_MISMATCH` rather than processing the second request or returning the cached first response. This prevents a class of attack where a low-value payment is used to establish an idempotency key, which is then reused with a high-value amount.

## eIDAS Certificates and mTLS

```java
@Component
public class EidasCertificateValidator {

    private final OpenBankingDirectoryClient directoryClient;

    /**
     * Validates that the client's TLS certificate is (EU / eIDAS variant):
     * 1. A valid eIDAS QWAC (Qualified Website Authentication Certificate)
     * 2. Issued by a qualified trust service provider on the EU trusted lists
     * 3. Not revoked (checked via OCSP)
     * 4. Carries an organisationIdentifier matching an authorised TPP, and PSD2
     *    roles (in the QCStatement) that allow the API being called
     */
    public TppIdentity validateAndExtract(X509Certificate cert) {
        // Check certificate policy OID for QWAC (0.4.0.194112.1.4)
        verifyQwacPolicyOid(cert);

        // Extract organisationIdentifier from the subject DN (OID 2.5.4.97);
        // PSD2 roles (PSP_AI, PSP_PI, ...) come from the QCStatement
        String orgId = extractOrganisationId(cert);

        // OCSP check against issuing CA
        OcspResult ocsp = performOcspCheck(cert);
        if (ocsp.status() == OcspStatus.REVOKED) {
            throw new CertificateRevokedException(orgId, ocsp.revocationTime());
        }

        // Verify TPP is registered and active in OB Directory
        TppRegistration tpp = directoryClient.lookupTpp(orgId)
            .orElseThrow(() -> new UnregisteredTppException(orgId));

        if (!tpp.isActive()) {
            throw new TppNotActiveException(orgId, tpp.status());
        }

        return new TppIdentity(orgId, tpp.name(), tpp.roles(), cert.getNotAfter().toInstant());
    }
}
```

## API Rate Limiting per TPP

Each TPP's API access must be rate-limited independently to prevent a single misbehaving or compromised TPP from impacting the ASPSP's availability for all other TPPs.

```java
@Component
public class TppRateLimiter {

    // Limits are the ASPSP's own fairness and capacity settings — they must
    // protect availability without obstructing TPPs. Load them from config
    // (per TPP and per API category), not hard-coded constants.
    private final RateLimitProperties limits;
    private final RateLimiterRegistry registry;  // Resilience4j — per node; use a
                                                 // shared store (e.g. Redis) for a cluster-wide limit

    public void checkLimit(String tppId, ApiEndpointType endpointType) {
        String limiterKey = tppId + ":" + endpointType.category();
        RateLimiter limiter = registry.rateLimiter(limiterKey, () ->
            buildConfig(tppId, endpointType));

        if (!limiter.acquirePermission()) {
            throw new TppRateLimitExceededException(tppId, endpointType,
                limiter.getMetrics().getAvailablePermissions());
        }
    }

    private RateLimiterConfig buildConfig(String tppId, ApiEndpointType type) {
        int rpm = limits.requestsPerMinute(tppId, type.category());
        return RateLimiterConfig.custom()
            .limitForPeriod(rpm)
            .limitRefreshPeriod(Duration.ofMinutes(1))
            .timeoutDuration(Duration.ZERO)   // Fail fast — do not queue
            .build();
    }
}
```

## Open Banking UK vs Berlin Group vs CDR Comparison

| Dimension | Open Banking UK | Berlin Group NextGenPSD2 | Australian CDR |
|---|---|---|---|
| Mandate | CMA Order 2017 (9 banks) | PSD2 RTS (all EU banks) | Consumer Data Right Act 2019 |
| API standard body | Open Banking Ltd | Berlin Group | Data Standards Body (Treasury) |
| Authorisation | Redirect (incl. app-to-app) and decoupled | Redirect, embedded, decoupled or OAuth | Redirect |
| Consent UI | ASPSP-hosted | ASPSP-hosted | ASPSP-hosted |
| Data model | OB UK schema (v3.1 / v4) | NextGenPSD2 schema (ISO 20022-based) | CDR Banking schema |
| Payment types | Domestic (FPS), scheduled, standing orders, international | SEPA CT / SEPA Instant | Not in the original CDR scope (action initiation came later) |
| Access renewal | TPP reconfirms consent every 90 days | SCA at the bank at least every 180 days (since 2023) | Consent up to 12 months |
| Accreditation | FCA register + OB Directory | NCA register + eIDAS | ACCC accreditation |

## Knowledge Check

**Q1: A PISP submits a payment initiation request with idempotency key `pay-abc-001`. The request succeeds and the payment enters `AcceptedSettlementInProcess` status. Five minutes later, the same TPP resubmits with key `pay-abc-001` but with the payment amount doubled. What must the ASPSP return and why?**

A: The ASPSP must return HTTP 422 Unprocessable Entity with error code `PAYLOAD_MISMATCH` (or equivalent per the Open Banking specification being implemented). Idempotency in payment APIs means that the same key guarantees the same payment is not processed twice — it does not mean the key can be reused to submit a different payment. When a key is reused with a different payload, it indicates either a TPP bug or an attempted fraud pattern (establishing a key with a low-value payment, then attempting to reuse it for a high-value one). The ASPSP must compare the hash of the new request body against the stored hash for the idempotency key and reject any mismatch. It must not process the new payment and must not return the cached response for the original payment, since that would give the TPP a false impression of which payment was executed.

**Q2: Explain the difference between PAR (Pushed Authorisation Request) and a standard OAuth2 authorisation request, and why FAPI 2.0 mandates PAR for open banking.**

A: In a standard OAuth2 authorisation request, the client embeds authorisation parameters (client ID, scope, state, PKCE challenge, redirect URI) in the URL of the browser redirect to the authorisation server. This means the parameters travel through the browser — they appear in browser history, can be logged by intermediary proxies, and are visible to browser extensions. For standard OAuth2 this is an acceptable trade-off. In FAPI 2.0 for open banking, PAR requires the client to first POST the authorisation parameters directly to the authorisation server's PAR endpoint over mTLS (back-channel), receiving an opaque `request_uri` in response. The browser redirect to the authorisation server then contains only this short-lived `request_uri` reference. This means sensitive parameters (including the signed JAR containing payment details or account consent scope) never traverse the browser. PAR also enables the authorisation server to validate the request before the customer is redirected, returning errors immediately in the back-channel rather than via a browser redirect that could be observed or manipulated.

## Practical Challenge

1. **ConsentService with State Machine:** Implement the full `ConsentService` including all state transitions, a configurable re-authentication cap on `authorise()` (180 days for the EU profile), and lazy expiry detection in `verifyActive()`. Use a PostgreSQL-backed repository with a `consents` table and a `consent_audit_log` table that records every state transition with actor, timestamp, and reason. Write integration tests covering: consent created → authorised → expired after 181 days with the EU profile (using a `TestClock`); consent created → revoked by customer → subsequent API call returns `ConsentNotActive`; consent created → intent expires after 15 minutes without authorisation.

2. **FAPI 2.0 PAR Endpoint:** Implement the `/as/par` endpoint with mTLS client authentication, JAR (signed JWT request object) validation, and an in-memory PAR store with 10-minute TTL. The JAR must be validated with the TPP's registered public key (retrieved from a stubbed `TppKeystore`). Write a test using a real RSA key pair that generates a valid signed JAR and asserts a `request_uri` is returned, and another test with a tampered JWT signature that asserts HTTP 400 `INVALID_REQUEST_OBJECT`.

3. **Rate Limiter Integration Test:** Configure Resilience4j rate limiters for a set of three test TPPs with AIS limits of 10 requests per minute. Write a test that fires 15 rapid requests from TPP-1 and asserts that requests 11-15 receive `TppRateLimitExceededException`. Concurrently fire 10 requests from TPP-2 and assert all succeed (TPP limits are independent). Verify that after a 60-second `TestClock` advance, TPP-1 can make requests again.

4. **Berlin Group NextGenPSD2 Compatibility:** Research the Berlin Group NextGenPSD2 Account Information API v1.3 (GET `/v1/accounts/{account-id}/transactions`) and implement a second controller alongside `AccountInformationController` that serves the same underlying data in NextGenPSD2 JSON schema. The two controllers should share the same `ConsentService` and `TransactionService` but use separate schema mappers. Write a contract test using a Pact consumer contract file that validates the JSON response structure matches the NextGenPSD2 specification.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A PISP submits a payment initiation request with idempotency key `pay-abc-001`. The request succeeds. Five minutes later the same TPP resubmits with the same key but a doubled payment amount. What must the ASPSP return?",
      "options": [
        "HTTP 200 with the cached response from the first request",
        "HTTP 422 Unprocessable Entity with error code `PAYLOAD_MISMATCH` — the idempotency key cannot be reused with a different payload",
        "HTTP 409 Conflict — a payment with this key already exists",
        "HTTP 201 Created — process the new payment as a fresh request"
      ],
      "correct": 1,
      "explanation": "The ASPSP must return HTTP 422 with `PAYLOAD_MISMATCH`. Idempotency guarantees the same payment is not processed twice — it does not allow the key to be reused for a different payment. The ASPSP must compare the hash of the new request against the stored hash and reject any mismatch. It must not process the new payment nor return the cached response for the original."
    },
    {
      "text": "What is the key difference between PAR (Pushed Authorisation Request) and a standard OAuth2 authorisation request, and why does FAPI 2.0 mandate PAR?",
      "options": [
        "PAR is faster because it eliminates the browser redirect entirely",
        "PAR requires the client to first POST authorisation parameters directly to the authorisation server over mTLS (back-channel), receiving an opaque `request_uri`, so sensitive parameters never traverse the browser",
        "PAR adds a second factor of authentication for the customer",
        "PAR replaces OAuth2 tokens with certificate-based authentication"
      ],
      "correct": 1,
      "explanation": "In standard OAuth2, authorisation parameters travel through the browser redirect — visible in browser history, proxy logs, and browser extensions. In FAPI 2.0 PAR, the client POSTs parameters directly to the authorisation server over mTLS (back-channel), receiving only an opaque `request_uri`. The browser redirect contains only this reference, so sensitive parameters (including signed JAR with payment details) never traverse the browser."
    },
    {
      "text": "Under the amended EU RTS (in force since 2023), how often must a customer re-authenticate with SCA at their bank for continued account information access through an AISP?",
      "options": [
        "Every 30 days",
        "Every 90 days",
        "At least every 180 days",
        "Never — consent lasts until revoked"
      ],
      "correct": 2,
      "explanation": "Delegated Regulation (EU) 2022/2360 extended the re-authentication interval for AIS access via an AISP from 90 to 180 days and made the exemption mandatory for banks. The UK went a different way: since 2022 the TPP reconfirms consent with the customer every 90 days and the bank does not apply SCA again. Make the interval jurisdiction-specific configuration in `ConsentService.authorise()`."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Open Banking Consent Management and FAPI 2.0 PAR",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Implement the full `ConsentService` including all state transitions, a configurable re-authentication cap on `authorise()` (180 days for the EU profile), and lazy expiry detection in `verifyActive()`. Use PostgreSQL-backed repository with `consents` and `consent_audit_log` tables. Write integration tests covering: 181-day expiry via `TestClock`; customer revocation; 15-minute intent expiry without authorisation."
    },
    {
      "id": "2",
      "description": "Implement the `/as/par` endpoint with mTLS client authentication, JAR (signed JWT request object) validation, and in-memory PAR store with 10-minute TTL. Validate JAR with the TPP's registered public key from a stubbed `TppKeystore`. Write tests for a valid signed JAR returning `request_uri` and a tampered JWT signature returning HTTP 400 `INVALID_REQUEST_OBJECT`."
    },
    {
      "id": "3",
      "description": "Configure Resilience4j rate limiters for three test TPPs with AIS limits of 10 requests per minute. Write a test firing 15 rapid requests from TPP-1 asserting requests 11-15 receive `TppRateLimitExceededException`. Concurrently fire 10 requests from TPP-2 asserting all succeed (limits are independent). Verify after a 60-second `TestClock` advance, TPP-1 can make requests again."
    },
    {
      "id": "4",
      "description": "Research the Berlin Group NextGenPSD2 Account Information API v1.3 and implement a second controller alongside `AccountInformationController` serving the same data in NextGenPSD2 JSON schema. Share the same `ConsentService` and `TransactionService` but use separate schema mappers. Write a Pact contract test validating the JSON response structure."
    }
  ]
}
-->
