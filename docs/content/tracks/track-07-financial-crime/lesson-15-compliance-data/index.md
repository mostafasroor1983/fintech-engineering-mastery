---
id: track-07-lesson-15
title: "Compliance Data Architecture — Auditability at Scale"
slug: compliance-data
track: track-07
trackName: "Financial Crime & Compliance Engineering"
sequence: 15
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [compliance-data, audit-trail, immutability, retention, data-lineage]
prerequisites: [track-07-lesson-07]
---

# Compliance Data Architecture — Auditability at Scale

> [!NOTE]
> Compliance data is different from operational data. Operational data can be corrected or deleted. Compliance data must be immutable — every record is evidence. The Bank Secrecy Act requires 5 years of records; most institutions keep 7 years to cover overlapping jurisdictions. The engineering challenge is making 7 years of immutable data queryable within seconds for a regulatory examination.

## Retention Requirements by Jurisdiction

| Regulation | Jurisdiction | Retention Period | Record Types |
|---|---|---|---|
| Bank Secrecy Act (BSA) | USA | 5 years | SARs, CTRs, transaction records |
| GDPR Article 17 | EU | Until purpose expires; override for AML | AML records may exceed erasure rights |
| UK Money Laundering Regulations | UK | 5 years post-relationship | KYC, transaction monitoring records |
| MAS Notice 626 | Singapore | 5 years | CDD, transaction records |
| AUSTRAC | Australia | 7 years | AML records |
| FATF Recommendation 11 | Global | 5 years | Wire transfer records |

For multi-jurisdictional institutions, the practical retention period is **7 years** to satisfy the most restrictive requirement. GDPR's right to erasure does not override AML retention obligations — compliance records are exempt.

---

## 1. Immutable Compliance Event Store

The core data structure is an append-only event store. No UPDATE or DELETE operations are permitted on compliance records. Corrections are made by appending a correction event that references the original.

```java
@Entity
@Table(name = "compliance_events",
       indexes = {
           @Index(name = "idx_ce_customer_id",  columnList = "customer_id"),
           @Index(name = "idx_ce_event_type",   columnList = "event_type"),
           @Index(name = "idx_ce_occurred_at",  columnList = "occurred_at"),
           @Index(name = "idx_ce_entity_id",    columnList = "entity_id,entity_type")
       })
@Immutable  // Hibernate: no UPDATE statements generated
public class ComplianceEvent {

    @Id
    @Column(name = "event_id", nullable = false, updatable = false)
    private String eventId;  // UUID

    @Column(name = "event_type", nullable = false, updatable = false)
    @Enumerated(EnumType.STRING)
    private ComplianceEventType eventType;

    @Column(name = "entity_id", nullable = false, updatable = false)
    private String entityId;  // customerId, accountId, transactionId, etc.

    @Column(name = "entity_type", nullable = false, updatable = false)
    private String entityType;

    @Column(name = "customer_id", updatable = false)
    private String customerId;

    @Column(name = "occurred_at", nullable = false, updatable = false)
    private Instant occurredAt;

    @Column(name = "recorded_at", nullable = false, updatable = false)
    private Instant recordedAt;

    @Column(name = "actor_id", updatable = false)
    private String actorId;  // system or analyst who triggered the event

    @Column(name = "payload", nullable = false, updatable = false,
            columnDefinition = "jsonb")
    @Type(JsonType.class)
    private Map<String, Object> payload;

    @Column(name = "data_source", updatable = false)
    private String dataSource;

    @Column(name = "data_source_version", updatable = false)
    private String dataSourceVersion;

    @Column(name = "correlation_id", updatable = false)
    private String correlationId;  // links related events

    @Column(name = "previous_event_id", updatable = false)
    private String previousEventId;  // for corrections: points to corrected event

    @Column(name = "is_correction", updatable = false)
    private boolean isCorrection;

    // Hash chain: SHA-256(eventId + payload + previousHash)
    @Column(name = "record_hash", nullable = false, updatable = false)
    private String recordHash;

    @Column(name = "retention_expires_at", updatable = false)
    private LocalDate retentionExpiresAt;

    @PrePersist
    public void prePersist() {
        if (this.recordedAt == null) this.recordedAt = Instant.now();
        if (this.retentionExpiresAt == null) {
            // Default 7-year retention
            this.retentionExpiresAt = LocalDate.now().plusYears(7);
        }
    }
}
```

### 1.1 Compliance Event Service

```java
@Service
public class ComplianceEventService {

    private final ComplianceEventRepository eventRepo;
    private final HashChainService hashChain;
    private static final Logger log = LoggerFactory.getLogger(ComplianceEventService.class);

    @Transactional
    public ComplianceEvent record(ComplianceEventType eventType,
                                   String entityId,
                                   String entityType,
                                   String customerId,
                                   Map<String, Object> payload,
                                   String actorId) {
        // Get the last event for this entity to form the hash chain
        Optional<ComplianceEvent> lastEvent = eventRepo
                .findTopByEntityIdOrderByRecordedAtDesc(entityId);

        String previousHash = lastEvent
                .map(ComplianceEvent::getRecordHash)
                .orElse("GENESIS");

        String eventId = UUID.randomUUID().toString();

        // Compute hash: SHA-256 of eventId + payload JSON + previousHash
        String hash = hashChain.compute(eventId,
                payload, previousHash);

        ComplianceEvent event = ComplianceEvent.builder()
                .eventId(eventId)
                .eventType(eventType)
                .entityId(entityId)
                .entityType(entityType)
                .customerId(customerId)
                .occurredAt(Instant.now())
                .actorId(actorId)
                .payload(payload)
                .previousEventId(lastEvent.map(ComplianceEvent::getEventId).orElse(null))
                .recordHash(hash)
                .build();

        eventRepo.save(event);
        log.debug("Compliance event recorded: type={} entity={}", eventType, entityId);
        return event;
    }

    // Record a correction — never overwrites, appends a correction event
    @Transactional
    public ComplianceEvent recordCorrection(String originalEventId,
                                             Map<String, Object> correctedPayload,
                                             String correctionReason,
                                             String actorId) {
        ComplianceEvent original = eventRepo.findById(originalEventId)
                .orElseThrow(() -> new ComplianceDataException(
                        "Original event not found: " + originalEventId));

        Map<String, Object> correctionPayload = new HashMap<>(correctedPayload);
        correctionPayload.put("correctionReason", correctionReason);
        correctionPayload.put("originalEventId", originalEventId);
        correctionPayload.put("originalPayload", original.getPayload());

        return record(
                ComplianceEventType.CORRECTION,
                original.getEntityId(),
                original.getEntityType(),
                original.getCustomerId(),
                correctionPayload,
                actorId);
    }
}
```

---

## 2. Hot / Warm / Cold Data Tiering

Seven years of compliance events across millions of customers is too large for a single PostgreSQL tier. A tiered architecture keeps recent data fast and stores historical data cheaply.

```
Hot  (0-12 months): PostgreSQL — full ACID, indexed, fast queries
Warm (1-3 years):   PostgreSQL read-replica or Amazon Aurora — lower IOPS tier
Cold (3-7 years):   S3 Glacier Instant Retrieval — Parquet files, Athena queries
```

```java
@Service
public class ComplianceDataTieringService {

    private final ComplianceEventRepository hotTierRepo;
    private final S3Client s3Client;
    private final AthenaClient athenaClient;
    private static final Logger log = LoggerFactory.getLogger(ComplianceDataTieringService.class);

    private static final String COLD_BUCKET = "compliance-cold-tier";
    private static final String HOT_RETENTION_MONTHS = "12";

    // Nightly job: archive events older than hot-tier threshold
    @Scheduled(cron = "0 1 * * *")  // 1 AM daily
    public void archiveToCold() {
        Instant archiveThreshold = Instant.now()
                .minus(365, ChronoUnit.DAYS);

        // Paginate through events older than threshold
        Pageable page = PageRequest.of(0, 1000,
                Sort.by("recordedAt").ascending());

        while (true) {
            Page<ComplianceEvent> batch = hotTierRepo
                    .findByRecordedAtBeforeAndArchivedFalse(archiveThreshold, page);

            if (batch.isEmpty()) break;

            // Convert batch to Parquet and upload to S3
            archiveBatch(batch.getContent());

            // Mark as archived in hot tier (tombstone — do not delete yet)
            List<String> ids = batch.getContent().stream()
                    .map(ComplianceEvent::getEventId)
                    .toList();
            hotTierRepo.markAsArchived(ids);

            if (!batch.hasNext()) break;
            page = batch.nextPageable();
        }
    }

    private void archiveBatch(List<ComplianceEvent> events) {
        if (events.isEmpty()) return;

        // Partition by year/month for Athena query efficiency
        YearMonth yearMonth = YearMonth.from(
                events.get(0).getRecordedAt()
                      .atZone(ZoneOffset.UTC).toLocalDate());

        String s3Key = String.format("compliance-events/year=%d/month=%02d/%s.parquet",
                yearMonth.getYear(), yearMonth.getMonthValue(),
                UUID.randomUUID());

        byte[] parquet = parquetSerializer.serialize(events);

        s3Client.putObject(PutObjectRequest.builder()
                .bucket(COLD_BUCKET)
                .key(s3Key)
                .serverSideEncryption(ServerSideEncryption.AWS_KMS)
                .storageClass(StorageClass.GLACIER_IR)
                .build(),
                RequestBody.fromBytes(parquet));

        log.info("Archived {} compliance events to s3://{}/{}",
                events.size(), COLD_BUCKET, s3Key);
    }

    // Query cold tier via Athena
    public List<ComplianceEvent> queryColTier(String customerId,
                                               LocalDate fromDate,
                                               LocalDate toDate) {
        String athenaQuery = String.format("""
            SELECT * FROM compliance_events_cold
            WHERE customer_id = '%s'
              AND year  BETWEEN %d AND %d
              AND month BETWEEN %d AND %d
              AND recorded_at >= TIMESTAMP '%s'
              AND recorded_at <= TIMESTAMP '%s'
            ORDER BY recorded_at
            """,
            customerId,
            fromDate.getYear(), toDate.getYear(),
            fromDate.getMonthValue(), toDate.getMonthValue(),
            fromDate, toDate);

        // Start Athena query and poll for results
        StartQueryExecutionResponse queryExec = athenaClient.startQueryExecution(
                StartQueryExecutionRequest.builder()
                        .queryString(athenaQuery)
                        .queryExecutionContext(QueryExecutionContext.builder()
                                .database("compliance_archive")
                                .build())
                        .resultConfiguration(ResultConfiguration.builder()
                                .outputLocation("s3://" + COLD_BUCKET + "/athena-results/")
                                .build())
                        .build());

        return pollAthenaResults(queryExec.queryExecutionId());
    }
}
```

---

## 3. Compliance Data Partitioning Strategy

```sql
-- PostgreSQL: partition compliance_events by year
CREATE TABLE compliance_events (
    event_id          UUID          NOT NULL,
    event_type        VARCHAR(100)  NOT NULL,
    entity_id         VARCHAR(255)  NOT NULL,
    entity_type       VARCHAR(100)  NOT NULL,
    customer_id       VARCHAR(255),
    occurred_at       TIMESTAMPTZ   NOT NULL,
    recorded_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    actor_id          VARCHAR(255),
    payload           JSONB         NOT NULL,
    record_hash       CHAR(64)      NOT NULL,
    previous_event_id UUID,
    is_archived       BOOLEAN       NOT NULL DEFAULT FALSE,
    retention_expires_at DATE       NOT NULL,
    PRIMARY KEY (event_id, recorded_at)  -- include partition key in PK
) PARTITION BY RANGE (recorded_at);

-- Annual partitions — created programmatically before year start
CREATE TABLE compliance_events_2022
    PARTITION OF compliance_events
    FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');

CREATE TABLE compliance_events_2023
    PARTITION OF compliance_events
    FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');

CREATE TABLE compliance_events_2024
    PARTITION OF compliance_events
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- Indexes on each partition (automatically inherited)
CREATE INDEX ON compliance_events (customer_id, recorded_at);
CREATE INDEX ON compliance_events (entity_id,   recorded_at);
CREATE INDEX ON compliance_events (event_type,  recorded_at);
```

---

## 4. Compliance Data Lineage Tracking

Regulators ask: "Where did this customer's risk score come from?" Data lineage answers that question by tracking how data was derived, transformed, and used.

```java
@Entity
@Table(name = "data_lineage",
       indexes = {
           @Index(name = "idx_dl_entity_id", columnList = "entity_id"),
           @Index(name = "idx_dl_derived_at", columnList = "derived_at")
       })
public class DataLineageRecord {

    @Id
    private String lineageId;

    @Column(name = "entity_id")    private String entityId;
    @Column(name = "entity_type")  private String entityType;
    @Column(name = "attribute")    private String attribute;  // e.g., "riskScore"
    @Column(name = "derived_value") private String derivedValue;

    @Column(name = "derived_at")   private Instant derivedAt;
    @Column(name = "derived_by")   private String derivedBy;  // system/model

    // Source data points that contributed to this value
    @Column(name = "source_records", columnDefinition = "jsonb")
    @Type(JsonType.class)
    private List<Map<String, String>> sourceRecords;

    // Model or rule version that produced this value
    @Column(name = "computation_version") private String computationVersion;

    @Column(name = "explanation")  private String explanation;
}

@Service
public class DataLineageService {

    private final DataLineageRepository lineageRepo;

    public void recordRiskScoreDerivation(String customerId,
                                           BigDecimal riskScore,
                                           List<String> sourceEventIds,
                                           String modelVersion,
                                           String explanation) {
        DataLineageRecord record = DataLineageRecord.builder()
                .lineageId(UUID.randomUUID().toString())
                .entityId(customerId)
                .entityType("Customer")
                .attribute("riskScore")
                .derivedValue(riskScore.toPlainString())
                .derivedAt(Instant.now())
                .derivedBy("RiskScoringEngine/" + modelVersion)
                .sourceRecords(sourceEventIds.stream()
                        .map(id -> Map.of("eventId", id,
                                "type", "ComplianceEvent"))
                        .toList())
                .computationVersion(modelVersion)
                .explanation(explanation)
                .build();
        lineageRepo.save(record);
    }
}
```

---

## 5. Regulatory Query API

Regulators perform examinations and may request all records for a specific customer or time period. The query API must span both hot and cold tiers transparently.

```java
@RestController
@RequestMapping("/v1/compliance/regulatory")
@SecurityRequirement(name = "regulatory-api-key")
public class RegulatoryQueryController {

    private final ComplianceQueryService queryService;

    // All records for a customer — spans hot and cold tiers
    @GetMapping("/customers/{customerId}/events")
    public ResponseEntity<RegulatoryExportResponse> exportCustomerHistory(
            @PathVariable String customerId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(required = false) List<ComplianceEventType> eventTypes) {

        RegulatoryExport export = queryService.exportCustomerHistory(
                customerId, from, to, eventTypes);

        return ResponseEntity.ok()
                .header("X-Record-Count", String.valueOf(export.getRecordCount()))
                .header("X-Export-Id", export.getExportId())
                .body(RegulatoryExportResponse.builder()
                        .exportId(export.getExportId())
                        .customerId(customerId)
                        .fromDate(from)
                        .toDate(to)
                        .recordCount(export.getRecordCount())
                        .events(export.getEvents())
                        .build());
    }

    // Verify hash chain integrity for an audit examination
    @PostMapping("/verify-chain")
    public ResponseEntity<HashChainVerificationResult> verifyHashChain(
            @RequestBody HashChainVerificationRequest request) {
        HashChainVerificationResult result = queryService
                .verifyHashChain(request.getEntityId(),
                                  request.getFrom(),
                                  request.getTo());
        return ResponseEntity.ok(result);
    }
}

@Service
public class ComplianceQueryService {

    private final ComplianceEventRepository hotTierRepo;
    private final ComplianceDataTieringService tieringService;
    private final HashChainService hashChain;

    public RegulatoryExport exportCustomerHistory(String customerId,
                                                   LocalDate from,
                                                   LocalDate to,
                                                   List<ComplianceEventType> types) {
        List<ComplianceEvent> hotEvents = hotTierRepo
                .findByCustomerIdAndRecordedAtBetweenAndEventTypeIn(
                        customerId,
                        from.atStartOfDay().toInstant(ZoneOffset.UTC),
                        to.atTime(LocalTime.MAX).toInstant(ZoneOffset.UTC),
                        types != null ? types : List.of(ComplianceEventType.values()));

        // Check if range extends into cold tier
        List<ComplianceEvent> coldEvents = new ArrayList<>();
        if (from.isBefore(LocalDate.now().minusMonths(12))) {
            coldEvents = tieringService.queryColTier(customerId, from, to);
        }

        List<ComplianceEvent> allEvents = new ArrayList<>(coldEvents);
        allEvents.addAll(hotEvents);
        allEvents.sort(Comparator.comparing(ComplianceEvent::getRecordedAt));

        return RegulatoryExport.builder()
                .exportId(UUID.randomUUID().toString())
                .customerId(customerId)
                .events(allEvents)
                .recordCount(allEvents.size())
                .exportedAt(Instant.now())
                .build();
    }

    public HashChainVerificationResult verifyHashChain(String entityId,
                                                        LocalDate from,
                                                        LocalDate to) {
        List<ComplianceEvent> events = hotTierRepo
                .findByEntityIdAndRecordedAtBetweenOrderByRecordedAt(
                        entityId,
                        from.atStartOfDay().toInstant(ZoneOffset.UTC),
                        to.atTime(LocalTime.MAX).toInstant(ZoneOffset.UTC));

        List<HashChainViolation> violations = new ArrayList<>();
        for (int i = 1; i < events.size(); i++) {
            ComplianceEvent prev = events.get(i - 1);
            ComplianceEvent curr = events.get(i);

            // Verify: curr.recordHash == SHA-256(curr.eventId + curr.payload + prev.recordHash)
            String expectedHash = hashChain.compute(
                    curr.getEventId(), curr.getPayload(), prev.getRecordHash());

            if (!expectedHash.equals(curr.getRecordHash())) {
                violations.add(HashChainViolation.builder()
                        .eventId(curr.getEventId())
                        .expectedHash(expectedHash)
                        .actualHash(curr.getRecordHash())
                        .build());
            }
        }

        return HashChainVerificationResult.builder()
                .entityId(entityId)
                .eventsChecked(events.size())
                .violationsFound(violations.size())
                .violations(violations)
                .isIntact(violations.isEmpty())
                .verifiedAt(Instant.now())
                .build();
    }
}
```

---

## 6. Compliance Data Model — Key Tables

```sql
-- Core compliance event tables
CREATE TABLE compliance_events      ( ... );  -- immutable event log
CREATE TABLE data_lineage           ( ... );  -- derivation tracking
CREATE TABLE regulatory_filings     ( ... );  -- SAR/CTR/STR submissions

-- Supporting tables
CREATE TABLE retention_schedules (
    entity_type        VARCHAR(100) PRIMARY KEY,
    retention_years    INT          NOT NULL,
    legal_basis        TEXT,
    last_reviewed_at   DATE
);

CREATE TABLE compliance_data_exports (
    export_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by       VARCHAR(255) NOT NULL,
    request_type       VARCHAR(100) NOT NULL,  -- REGULATORY_EXAM, LEGAL_HOLD, etc.
    customer_id        VARCHAR(255),
    from_date          DATE,
    to_date            DATE,
    record_count       INT,
    export_status      VARCHAR(50),
    exported_at        TIMESTAMPTZ,
    s3_location        TEXT,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Legal hold overrides retention schedules
CREATE TABLE legal_holds (
    hold_id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id          VARCHAR(255) NOT NULL,
    entity_type        VARCHAR(100) NOT NULL,
    hold_reason        TEXT         NOT NULL,
    initiated_by       VARCHAR(255) NOT NULL,
    initiated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    released_at        TIMESTAMPTZ,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE
);
```

---

## 7. Operational Checklist

- Compliance events append-only: no UPDATE/DELETE on compliance_events
- Hash chain verified weekly for all entities with active compliance cases
- Retention schedules reviewed annually with Legal and Compliance
- Cold tier archival job monitored daily with alerting on failure
- Legal hold system tested quarterly: hold prevents deletion end-to-end
- Regulatory query API access logged at INFO level (who queried what)
- Cross-tier query latency SLO: hot tier < 100ms; cold tier < 30 seconds
- Annual data quality check: completeness, hash chain integrity, lineage coverage

---

## Summary

Compliance data architecture is defined by immutability, auditability, and long retention. The append-only event store with hash chaining ensures tamper evidence. Tiered storage balances query performance against cost — hot PostgreSQL for recent events, S3 Glacier for historical archives queried via Athena. Data lineage answers the regulator's question "where did this risk score come from?" The regulatory query API must span both tiers transparently and return results within defined SLOs to support examination timelines.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What practical retention period should a multi-jurisdictional financial institution use for compliance data, and why?",
      "options": ["5 years — the minimum BSA requirement", "7 years — to satisfy the most restrictive overlapping jurisdictional requirement", "10 years — to provide the maximum safety margin", "Determined case-by-case based on the customer's jurisdiction"],
      "correct": 1,
      "explanation": "While BSA requires 5 years and most jurisdictions specify 5 years, AUSTRAC (Australia) requires 7 years. For multi-jurisdictional institutions, the practical approach is to retain all compliance data for 7 years — satisfying the most restrictive requirement globally rather than tracking jurisdiction-specific retention per record."
    },
    {
      "text": "How does hash chaining provide tamper evidence in a compliance event store?",
      "options": ["Each record is encrypted with a unique key that only the regulator holds", "Each record's hash incorporates the previous record's hash — modifying any record invalidates all subsequent hashes, creating a detectable break in the chain", "Records are stored in a blockchain distributed across multiple institutions", "A digital signature from a certificate authority is appended to each record"],
      "correct": 1,
      "explanation": "Hash chaining means: Record N hash = SHA-256(record_N data + record_(N-1) hash). If record N is modified, its hash changes. Record N+1 references record N's (now incorrect) hash, so N+1's computed hash is also wrong. The entire chain from N onwards becomes detectably invalid without knowledge of the original data."
    },
    {
      "text": "Why must the regulatory query API span both hot (PostgreSQL) and cold (S3/Athena) storage tiers transparently?",
      "options": ["Cold storage is cheaper and should be used for all queries", "A regulatory examination may request records spanning 7 years — the application must present a unified view regardless of which tier holds the data, without requiring the examiner to query two systems", "Hot storage cannot hold more than 12 months of data", "GDPR requires all data to be in a single storage location"],
      "correct": 1,
      "explanation": "Records older than 12-24 months are archived to cold storage for cost efficiency. When a regulator requests all events for a customer from a 7-year period, the API must transparently query both tiers and merge results with consistent ordering. The examiner should not need to know or care about the storage architecture."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build an Immutable Compliance Data Store with Hash Chain Verification",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement the ComplianceEvent @Entity with @Immutable annotation and all required fields. Configure PostgreSQL to enforce immutability: revoke UPDATE and DELETE from the application role at the database level. Implement a Hibernate interceptor that throws an exception if any UPDATE or DELETE is attempted on the compliance_events table, as a defence-in-depth measure."},
    {"id": "2", "description": "Implement the HashChainService.compute() method that calculates SHA-256(eventId + JSON-serialized payload + timestamp + previousHash), using a genesis hash of 64 zeros for the first record. Implement verifyChain() that iterates through a list of events in chronological order and returns a list of HashChainViolation objects for any event whose stored hash does not match the computed hash."},
    {"id": "3", "description": "Implement the ComplianceDataTieringService that moves compliance events older than 12 months to S3 in Parquet format and registers them in an Athena table. Implement the queryColTier() method that uses the AWS SDK to execute an Athena query and return results as ComplianceEvent objects. The method must have a 30-second timeout and retry once on timeout."},
    {"id": "4", "description": "Implement the AuditChainIntegrityScheduler that runs daily at 3 AM, finds all entities with events modified in the last 24 hours, verifies the hash chain for each, and raises a CRITICAL alert if any violations are found. Write an integration test that intentionally corrupts a record's payload and verifies the scheduler detects the violation at the correct position in the chain."}
  ]
}
-->
