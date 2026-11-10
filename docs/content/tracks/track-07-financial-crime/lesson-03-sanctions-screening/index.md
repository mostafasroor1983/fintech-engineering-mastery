---
id: track-07-lesson-03
title: "Sanctions Screening — OFAC, UN, and EU List Processing"
slug: sanctions-screening
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 3
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [sanctions, OFAC, fuzzy-matching, screening, SDN]
prerequisites: [track-07-lesson-02]
---

# Sanctions Screening — OFAC, UN, and EU List Processing

> [!NOTE]
> A single missed sanctions match can result in multi-million dollar fines, correspondent banking relationships being terminated, and criminal prosecution of compliance officers. OFAC penalties are strict liability — you do not need to have intended to violate sanctions to be fined. Sanctions screening must be fast, accurate, and complete.

## Sanctions Regulatory Landscape

Financial institutions must screen against multiple sanctions lists simultaneously:

| Authority | List | Scope | Update Frequency |
|---|---|---|---|
| US OFAC | Specially Designated Nationals (SDN) | US person or US nexus transactions | Multiple times daily |
| US OFAC | Consolidated Sanctions List | Additional OFAC programs | Daily |
| UN Security Council | Consolidated List | All UN member state entities | Irregular |
| EU | EU Consolidated List | EU-based entities | Irregular, often aligned with UN |
| UK | UK Financial Sanctions List | UK-based entities (post-Brexit) | Irregular |
| HM Treasury | OFSI Asset Freeze Targets | UK-specific | Irregular |

Screening must occur:
1. **At onboarding** — before accepting a customer
2. **On every transaction** — both sender and receiver
3. **Daily batch re-screening** — existing customers against updated lists
4. **On list updates** — immediate re-screen against new additions

---

## Sanctions List Data Model

```java
// Sanctions list entry
@Entity
@Table(name = "sanctions_entries")
@Index(name = "idx_sanctions_name", columnList = "normalized_name")
@Index(name = "idx_sanctions_entity_type", columnList = "entity_type,list_source")
public class SanctionsEntry {

    @Id
    private UUID id;

    private String listSource;      // "OFAC_SDN", "UN_CONSOLIDATED", "EU_CONSOLIDATED", "UK_OFSI"
    private String listEntryId;     // Unique ID in the source list
    private String entityType;      // "individual", "entity", "vessel", "aircraft"

    // Names — may have multiple aliases
    @OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)
    @JoinColumn(name = "sanctions_entry_id")
    private List<SanctionsName> names;

    // Personal/entity details
    private String dateOfBirth;      // may be partial: "circa 1960"
    private String nationality;
    private String placeOfBirth;

    // Addresses
    @OneToMany(cascade = CascadeType.ALL)
    private List<SanctionsAddress> addresses;

    // Identifiers (passport, national ID, company registration)
    @OneToMany(cascade = CascadeType.ALL)
    private List<SanctionsIdentifier> identifiers;

    private Instant listedAt;
    private Instant listUpdatedAt;
    private boolean isActive;

    private String programName;     // e.g., "IRAN", "RUSSIA-EO14024"
    private String remarks;
}

@Entity
@Table(name = "sanctions_names")
public class SanctionsName {

    @Id
    private UUID id;
    private UUID sanctionsEntryId;

    private String originalName;
    private String normalizedName;    // lowercase, diacritics removed, standardized
    private String nameType;          // "primary", "alias", "formerly_known_as"
    private String script;            // "latin", "arabic", "cyrillic"

    // Pre-computed phonetic and fuzzy keys for fast matching
    private String metaphoneKey;
    private String soundexKey;
    private String[] nameTokensSorted;  // for token-based matching
}
```

---

## Sanctions List Loading and Update Pipeline

```java
@Service
@Slf4j
public class SanctionsListLoader {

    private final SanctionsEntryRepository sanctionsRepository;
    private final SanctionsListSourceRegistry sourceRegistry;

    // Load or update OFAC SDN list from OFAC's XML feed
    public void loadOfacSdnList() {
        SanctionsListSource source = sourceRegistry.get("OFAC_SDN");
        byte[] xmlData = source.fetchLatest();
        String checksum = sha256(xmlData);

        if (sanctionsRepository.isCurrentChecksum(checksum)) {
            log.debug("OFAC SDN list unchanged, skipping load");
            return;
        }

        log.info("Loading updated OFAC SDN list");
        List<SanctionsEntry> entries = new OfacSdnXmlParser().parse(xmlData);

        // Transactional bulk replace
        sanctionsRepository.deactivateAll("OFAC_SDN");
        sanctionsRepository.bulkInsert(entries);
        sanctionsRepository.updateListChecksum("OFAC_SDN", checksum, Instant.now());

        log.info("OFAC SDN list loaded: {} entries", entries.size());

        // Trigger immediate re-screening for newly added entities
        triggerDifferentialScreening("OFAC_SDN");
    }

    private void triggerDifferentialScreening(String listSource) {
        // Find entries added in the latest update
        List<SanctionsEntry> newEntries = sanctionsRepository.findAddedSinceLastLoad(listSource);
        log.info("Triggering re-screening for {} new entries on list={}", newEntries.size(), listSource);

        // Queue async screening jobs for all active customers
        newEntries.forEach(entry ->
            screeningJobQueue.enqueue(new DifferentialScreeningJob(listSource, entry.getId()))
        );
    }

    // Normalize names for consistent matching
    public static String normalizeName(String name) {
        return name
            .toLowerCase(Locale.ROOT)
            .replaceAll("[àáâãäå]", "a")
            .replaceAll("[èéêë]", "e")
            .replaceAll("[ìíîï]", "i")
            .replaceAll("[òóôõö]", "o")
            .replaceAll("[ùúûü]", "u")
            .replaceAll("[ñ]", "n")
            .replaceAll("[ç]", "c")
            .replaceAll("[^a-z0-9\\s]", "") // remove all non-alphanumeric except spaces
            .replaceAll("\\s+", " ")
            .trim();
    }
}
```

---

## Fuzzy Name Matching Algorithms

Exact string matching misses transliterations, abbreviations, and name variations. Sanctions screening requires fuzzy matching.

```java
@Service
public class FuzzyNameMatcher {

    // Jaro-Winkler: best for short strings, name matching
    // Returns 0.0 (no match) to 1.0 (identical)
    public double jaroWinkler(String s1, String s2) {
        if (s1.equals(s2)) return 1.0;

        int matchDistance = Math.max(s1.length(), s2.length()) / 2 - 1;

        boolean[] s1Matches = new boolean[s1.length()];
        boolean[] s2Matches = new boolean[s2.length()];

        int matches = 0;
        int transpositions = 0;

        for (int i = 0; i < s1.length(); i++) {
            int start = Math.max(0, i - matchDistance);
            int end = Math.min(i + matchDistance + 1, s2.length());

            for (int j = start; j < end; j++) {
                if (s2Matches[j] || s1.charAt(i) != s2.charAt(j)) continue;
                s1Matches[i] = true;
                s2Matches[j] = true;
                matches++;
                break;
            }
        }

        if (matches == 0) return 0.0;

        int k = 0;
        for (int i = 0; i < s1.length(); i++) {
            if (!s1Matches[i]) continue;
            while (!s2Matches[k]) k++;
            if (s1.charAt(i) != s2.charAt(k)) transpositions++;
            k++;
        }

        double jaro = ((double) matches / s1.length()
            + (double) matches / s2.length()
            + (double) (matches - transpositions / 2) / matches) / 3;

        // Winkler prefix bonus (up to 4 chars)
        int prefix = 0;
        for (int i = 0; i < Math.min(4, Math.min(s1.length(), s2.length())); i++) {
            if (s1.charAt(i) == s2.charAt(i)) prefix++;
            else break;
        }

        return jaro + prefix * 0.1 * (1 - jaro);
    }

    // Levenshtein distance: edit distance, good for typos
    public int levenshtein(String s1, String s2) {
        int m = s1.length(), n = s2.length();
        int[][] dp = new int[m + 1][n + 1];

        for (int i = 0; i <= m; i++) dp[i][0] = i;
        for (int j = 0; j <= n; j++) dp[0][j] = j;

        for (int i = 1; i <= m; i++) {
            for (int j = 1; j <= n; j++) {
                if (s1.charAt(i - 1) == s2.charAt(j - 1)) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = 1 + Math.min(dp[i - 1][j - 1],
                                    Math.min(dp[i - 1][j], dp[i][j - 1]));
                }
            }
        }
        return dp[m][n];
    }

    // Normalised Levenshtein: edit distance as percentage of string length
    public double normalizedLevenshtein(String s1, String s2) {
        int distance = levenshtein(s1, s2);
        return 1.0 - (double) distance / Math.max(s1.length(), s2.length());
    }

    // Composite scoring: combine multiple algorithms for best accuracy
    public double compositeScore(String queryName, String candidateName) {
        String n1 = SanctionsListLoader.normalizeName(queryName);
        String n2 = SanctionsListLoader.normalizeName(candidateName);

        if (n1.equals(n2)) return 1.0; // exact match shortcut

        double jw = jaroWinkler(n1, n2);
        double lev = normalizedLevenshtein(n1, n2);

        // Weight Jaro-Winkler more for short names, Levenshtein more for longer
        double weight = n1.length() < 10 ? 0.7 : 0.4;
        double score = jw * weight + lev * (1 - weight);

        // Token set ratio: compare sorted word tokens (handles name order variations)
        double tokenScore = tokenSetRatio(n1, n2);
        score = Math.max(score, tokenScore);

        return score;
    }

    // "John Smith" vs "Smith John" should score 1.0
    private double tokenSetRatio(String s1, String s2) {
        Set<String> tokens1 = new TreeSet<>(Arrays.asList(s1.split("\\s+")));
        Set<String> tokens2 = new TreeSet<>(Arrays.asList(s2.split("\\s+")));

        String sorted1 = String.join(" ", tokens1);
        String sorted2 = String.join(" ", tokens2);

        return jaroWinkler(sorted1, sorted2);
    }
}
```

---

## Screening Engine

```java
@Service
@Slf4j
public class SanctionsScreeningEngine {

    private final SanctionsEntryRepository sanctionsRepository;
    private final FuzzyNameMatcher matcher;
    private final MeterRegistry meterRegistry;

    // Configurable thresholds
    private static final double MATCH_THRESHOLD = 0.85;      // above this: potential match
    private static final double ALERT_THRESHOLD = 0.90;      // above this: auto-alert
    private static final double AUTO_CLEAR_THRESHOLD = 0.75; // below this: auto-clear

    public ScreeningResult screen(ScreeningRequest request) {
        long start = System.currentTimeMillis();
        String normalizedName = SanctionsListLoader.normalizeName(request.name());

        // Phase 1: Candidate retrieval (fast, approximate)
        // Use pre-computed phonetic keys to reduce search space from 1M+ to <1000
        List<SanctionsEntry> candidates = getCandidates(normalizedName);

        // Phase 2: Detailed scoring
        List<SanctionsMatch> matches = candidates.stream()
            .flatMap(entry -> scoreEntry(request, entry))
            .filter(match -> match.score() >= MATCH_THRESHOLD)
            .sorted(Comparator.comparing(SanctionsMatch::score).reversed())
            .limit(10)
            .collect(toList());

        ScreeningDecision decision = determineDecision(matches);

        meterRegistry.timer("sanctions.screening.duration").record(
            Duration.ofMillis(System.currentTimeMillis() - start)
        );
        meterRegistry.counter("sanctions.screening",
            "outcome", decision.name(),
            "list_sources", matches.isEmpty() ? "none" : matches.get(0).listSource()
        ).increment();

        return new ScreeningResult(request.referenceId(), decision, matches, Instant.now());
    }

    private List<SanctionsEntry> getCandidates(String normalizedName) {
        // Build candidate set using multiple retrieval strategies
        Set<UUID> candidateIds = new HashSet<>();

        // 1. Exact name match (fast index scan)
        sanctionsRepository.findByNormalizedName(normalizedName)
            .forEach(e -> candidateIds.add(e.getId()));

        // 2. Metaphone phonetic key (catches "Smith" / "Smyth")
        String metaphoneKey = computeMetaphone(normalizedName);
        sanctionsRepository.findByMetaphoneKey(metaphoneKey)
            .forEach(e -> candidateIds.add(e.getId()));

        // 3. First-token prefix search (catches "Mohammed" / "Mohammad" / "Mohamed")
        String firstToken = normalizedName.split("\\s+")[0];
        sanctionsRepository.findByNamePrefix(firstToken)
            .forEach(e -> candidateIds.add(e.getId()));

        return sanctionsRepository.findAllById(candidateIds);
    }

    private Stream<SanctionsMatch> scoreEntry(ScreeningRequest request, SanctionsEntry entry) {
        return entry.getNames().stream()
            .map(name -> {
                double score = matcher.compositeScore(request.name(), name.getOriginalName());
                return new SanctionsMatch(
                    entry.getId(), entry.getListSource(), entry.getListEntryId(),
                    name.getOriginalName(), score, entry.getEntityType(),
                    entry.getProgramName(), entry.isActive()
                );
            });
    }

    private ScreeningDecision determineDecision(List<SanctionsMatch> matches) {
        if (matches.isEmpty()) return ScreeningDecision.CLEAR;

        double topScore = matches.get(0).score();

        if (topScore >= ALERT_THRESHOLD) return ScreeningDecision.MATCH;        // Positive match — block
        if (topScore >= MATCH_THRESHOLD) return ScreeningDecision.POTENTIAL_MATCH; // Needs human review
        return ScreeningDecision.CLEAR;
    }
}

public enum ScreeningDecision {
    CLEAR,            // No meaningful match
    POTENTIAL_MATCH,  // Above threshold — requires human review
    MATCH             // High confidence match — auto-alert and block
}
```

---

## Transaction-Time Screening

Sanctions screening must happen on every payment, with strict latency requirements.

```java
@Service
@Slf4j
public class TransactionSanctionsScreener {

    private final SanctionsScreeningEngine screeningEngine;
    private final SanctionsAlertRepository alertRepository;
    private final TransactionBlocker transactionBlocker;
    private static final Duration SCREENING_TIMEOUT = Duration.ofMillis(50); // <50ms SLA

    public SanctionsScreeningOutcome screenTransaction(Transaction transaction) {
        long start = System.nanoTime();

        try {
            // Screen both sender and receiver
            ScreeningResult senderResult = screenWithTimeout(
                new ScreeningRequest(transaction.id(), transaction.senderName(),
                    transaction.senderCountry(), transaction.senderDateOfBirth())
            );
            ScreeningResult receiverResult = screenWithTimeout(
                new ScreeningRequest(transaction.id(), transaction.receiverName(),
                    transaction.receiverCountry(), null)
            );

            long latencyMs = (System.nanoTime() - start) / 1_000_000;
            log.debug("Sanctions screening tx={} latencyMs={}", transaction.id(), latencyMs);

            if (senderResult.decision() == ScreeningDecision.MATCH
                || receiverResult.decision() == ScreeningDecision.MATCH) {

                // Auto-block and create alert
                transactionBlocker.blockTransaction(transaction.id(),
                    "Sanctions screening: MATCH");
                alertRepository.createAlert(SanctionsAlert.fromScreeningResult(
                    transaction, senderResult, receiverResult
                ));
                return SanctionsScreeningOutcome.BLOCKED;
            }

            if (senderResult.decision() == ScreeningDecision.POTENTIAL_MATCH
                || receiverResult.decision() == ScreeningDecision.POTENTIAL_MATCH) {

                // Hold for review, do not auto-block
                transactionBlocker.holdTransaction(transaction.id(),
                    "Sanctions screening: POTENTIAL_MATCH — pending review");
                alertRepository.createAlert(SanctionsAlert.fromScreeningResult(
                    transaction, senderResult, receiverResult
                ).withReviewRequired(true));
                return SanctionsScreeningOutcome.HELD_FOR_REVIEW;
            }

            return SanctionsScreeningOutcome.CLEARED;

        } catch (TimeoutException ex) {
            // Sanctions screening timeout — policy decision: fail open or fail closed?
            // For high-value or high-risk transactions: fail closed (block pending timeout)
            // For standard transactions: may allow through with post-processing alert
            log.error("Sanctions screening timeout tx={}", transaction.id(), ex);
            if (transaction.amount().compareTo(TIMEOUT_FAIL_CLOSED_THRESHOLD) > 0) {
                transactionBlocker.holdTransaction(transaction.id(), "Sanctions screening timeout");
                return SanctionsScreeningOutcome.HELD_FOR_REVIEW;
            }
            return SanctionsScreeningOutcome.CLEARED_WITH_TIMEOUT_WARNING;
        }
    }

    private ScreeningResult screenWithTimeout(ScreeningRequest request) {
        return CompletableFuture.supplyAsync(() -> screeningEngine.screen(request))
            .orTimeout(SCREENING_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
            .join();
    }

    private static final BigDecimal TIMEOUT_FAIL_CLOSED_THRESHOLD = new BigDecimal("10000");
}
```

---

## False Positive Management

Fuzzy matching generates false positives. A well-tuned system might have a false positive rate of 2-5% — meaning 2-5% of legitimate transactions are held for manual review.

```java
@Service
public class SanctionsFalsePositiveManager {

    private final SanctionsAlertRepository alertRepository;
    private final SanctionsDecisionRepository decisionRepository;

    // Analyst clears a false positive with documented justification
    public void clearFalsePositive(UUID alertId, String analystId, String justification,
                                    FalsePositiveReason reason) {
        SanctionsAlert alert = alertRepository.findById(alertId).orElseThrow();

        if (alert.status() != AlertStatus.PENDING_REVIEW) {
            throw new InvalidAlertStateException("Alert is not pending review");
        }

        SanctionsDecision decision = new SanctionsDecision(
            UUID.randomUUID(), alertId, alert.transactionId(),
            DecisionOutcome.FALSE_POSITIVE, analystId, justification,
            reason, Instant.now()
        );

        decisionRepository.save(decision);
        alertRepository.updateStatus(alertId, AlertStatus.CLEARED, analystId);

        // Build tuning data: false positive patterns fed back to improve thresholds
        tuningService.recordFalsePositive(alert.matchedName(), alert.queryName(),
            alert.matchScore(), reason);
    }

    // Build a watchlist of known false positives to auto-clear in future
    public void addToAllowList(String customerName, String sanctionsEntryId, String authorisedBy) {
        // After 3 false positive clearances for same pair: add to allow list
        // Requires senior compliance officer authorisation
        allowListRepository.save(new SanctionsAllowListEntry(
            UUID.randomUUID(), customerName, sanctionsEntryId,
            authorisedBy, Instant.now()
        ));
    }
}

public enum FalsePositiveReason {
    NAME_TOO_COMMON,                  // "Mohammed Ali" vs a specific sanctioned individual
    DATE_OF_BIRTH_MISMATCH,           // Same name, different DOB
    NATIONALITY_MISMATCH,             // Same name, different country
    DIFFERENT_ENTITY_TYPE,            // Person vs company
    PREVIOUSLY_CLEARED,               // Identical to a known false positive
    ADDITIONAL_DOCUMENTATION_PROVIDED // Customer provided evidence of different identity
}
```

---

## Batch Re-Screening

All existing customers must be re-screened when sanctions lists are updated.

```java
@Service
@Slf4j
public class BatchReScreeningService {

    private final CustomerRepository customerRepository;
    private final SanctionsScreeningEngine screeningEngine;
    private final SanctionsAlertRepository alertRepository;

    // Triggered after a list update or on schedule
    public void reScreenAllActiveCustomers() {
        log.info("Starting batch re-screening");
        AtomicLong screened = new AtomicLong();
        AtomicLong alerts = new AtomicLong();

        customerRepository.findAllActiveCustomers()
            .forEach(customer -> {
                try {
                    ScreeningResult result = screeningEngine.screen(
                        ScreeningRequest.forCustomer(customer)
                    );

                    if (result.decision() != ScreeningDecision.CLEAR) {
                        alertRepository.createAlert(SanctionsAlert.fromCustomerScreening(
                            customer, result
                        ));
                        alerts.incrementAndGet();
                    }

                    screened.incrementAndGet();
                    if (screened.get() % 10_000 == 0) {
                        log.info("Batch re-screening progress: screened={} alerts={}",
                            screened.get(), alerts.get());
                    }

                } catch (Exception ex) {
                    log.error("Batch screening failed for customerId={}", customer.getId(), ex);
                }
            });

        log.info("Batch re-screening complete: screened={} alerts={}", screened.get(), alerts.get());
    }
}
```

---

## Production Considerations

**List freshness**: OFAC can update the SDN list multiple times per day. Poll for updates every 15 minutes using OFAC's delta endpoint. Have monitoring alert if the list has not been updated for >4 hours.

**In-memory caching**: For transaction-time screening, cache the entire normalized sanctions name set in memory (typically 50-100MB compressed). This reduces screening latency from 20-50ms (DB query) to under 2ms (memory lookup). Refresh the cache on each list update.

**Phonetic algorithm selection**: Metaphone 3 outperforms Soundex for sanctions screening. It correctly handles Arabic, Russian, and Chinese transliterations better. Use `Apache Commons Codec` for a production-grade implementation.

**Concurrency**: Batch re-screening of 10 million customers must complete within hours. Use parallel streams with controlled thread pools. Never use `ForkJoinPool.commonPool()` for I/O-bound tasks — use a dedicated executor with known size.

**SDN list parsing**: The OFAC SDN XML format has changed multiple times. Always validate against the official schema before importing. A broken import that truncates the list is as dangerous as no screening at all.

**Audit requirements**: Every screening decision must be logged with the list version used. Regulators will ask "what version of the SDN list were you using when you approved this transaction?" You must be able to answer.

**Key metrics to monitor**:
- `sanctions.screening.duration` histogram — p99 must be <50ms for transaction screening
- `sanctions.screening{outcome=match}` — count of blocked transactions
- `sanctions.screening{outcome=potential_match}` — volume of manual reviews
- `sanctions.list.last_updated` timestamp — freshness of each list
- `sanctions.alerts.pending_review` gauge — analyst queue depth

---

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "Your payment processor receives a transaction for 'Muhammad Al-Rashid'. The OFAC SDN list contains 'Mohammed Al Rasheed'. What combination of matching techniques provides the best sanctions screening accuracy?",
      "options": [
        "Exact string match only — false positives are too costly to business",
        "Jaro-Winkler similarity alone with a 0.85 threshold",
        "Composite score combining Jaro-Winkler, Levenshtein distance, and phonetic matching",
        "Phonetic matching only using Soundex algorithm"
      ],
      "correct": 2,
      "explanation": "A composite scoring approach combining Jaro-Winkler (character similarity), Levenshtein distance (edit distance), and phonetic matching (Metaphone/Soundex for transliteration variations) provides the best balance of recall and precision. Single-algorithm approaches either miss true matches or generate excessive false positives for Arabic and Russian names."
    },
    {
      "text": "The OFAC screening service experiences a timeout during a transaction authorization. What is the correct fail behavior?",
      "options": [
        "Fail-open: approve the transaction and log the screening failure for async review",
        "Fail-closed: decline the transaction and return an error to the customer",
        "Fail with a configurable strategy: fail-closed for new customers, fail-open for existing",
        "Retry indefinitely until the screening service responds"
      ],
      "correct": 1,
      "explanation": "For sanctions screening in a blocking payment path, fail-closed (decline on timeout) is the regulatory-safe default. OFAC compliance requires that you do not process transactions with sanctioned parties. Processing a transaction without completing sanctions screening is a regulatory violation. The strategy may vary by customer tier but the default must be fail-closed."
    },
    {
      "text": "A compliance analyst marks a potential sanctions match as a false positive for 'Ahmed Hassan' vs 'Ahmed Al-Hassan (deceased 1998)'. What should happen to future transactions for the same customer-entity pair?",
      "options": [
        "Re-screen on every transaction — false positive records expire after 30 days",
        "Store the false positive with an expiry date and suppress re-review for that customer-entity pair until expiry",
        "Whitelist the customer permanently to avoid any future sanctions screening",
        "Flag all future transactions for manual review regardless"
      ],
      "correct": 1,
      "explanation": "False positive suppression with an expiry date (e.g. 365 days) prevents repetitive analyst work while maintaining regulatory compliance. The suppression is specific to the customer-entity pair and reason. After expiry, the system re-screens normally. Permanent whitelisting is too broad and may miss future real matches if the entity's status changes."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "Implement a Fuzzy Sanctions Screening Engine",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {
      "id": 1,
      "description": "Build a NameNormalizationService that standardises names for comparison: lowercase conversion, Unicode normalization (NFD), diacritic stripping, removal of honorifics (Mr/Mrs/Dr), and expansion of common abbreviations. The normalizer must be deterministic — the same input always produces the same output."
    },
    {
      "id": 2,
      "description": "Implement a composite fuzzy matching scorer that combines Jaro-Winkler similarity (40% weight), token set ratio (35% weight), and Double Metaphone phonetic comparison (25% weight). The scorer should return a composite score between 0.0 and 1.0 and classify matches as NO_MATCH (<0.70), POTENTIAL_MATCH (0.70-0.85), or MATCH (>0.85)."
    },
    {
      "id": 3,
      "description": "Build a transaction-time screening endpoint that must complete within 50ms. Use an in-memory cache of the normalized SDN name set (refreshed on list updates via Kafka), a phonetic index for fast candidate retrieval, and a circuit breaker that fails-closed when the screening service is unavailable."
    },
    {
      "id": 4,
      "description": "Implement a FalsePositiveSuppressionService that stores analyst override decisions with a 365-day expiry. The service must check suppression records before returning a POTENTIAL_MATCH to analysts, record every suppression with reason and analyst ID for the audit trail, and bulk-invalidate suppressions when a list is updated with new entity information."
    }
  ]
} -->
