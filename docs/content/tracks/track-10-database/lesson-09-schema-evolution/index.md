---
id: track-10-lesson-09
title: "Schema Evolution — Zero-Downtime Migrations"
slug: schema-evolution
track: track-10
trackName: "Database & Data Architecture"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [schema-evolution, Flyway, Liquibase, online-migration, backward-compatible]
prerequisites: [track-10-lesson-01]
---

# Schema Evolution — Zero-Downtime Migrations

> [!NOTE]
> A payment database migration that takes a table lock at 09:00 on a Monday morning will block every transaction for the duration. Financial databases cannot afford downtime for schema changes. The expand-contract pattern and PostgreSQL's online DDL tools make zero-downtime migrations achievable — but they require discipline and a phased deployment approach.

## 1. The Problem with Naive Migrations

```sql
-- DANGEROUS: This acquires an ACCESS EXCLUSIVE lock on the transactions table
-- All reads AND writes are blocked for the duration

-- Adding a NOT NULL column without a default blocks indefinitely on large tables
ALTER TABLE transactions ADD COLUMN processor_id UUID NOT NULL;

-- Renaming a column breaks all code that references the old name immediately
ALTER TABLE transactions RENAME COLUMN reference TO external_reference;

-- Adding a CHECK constraint validates all existing rows synchronously
ALTER TABLE transactions ADD CONSTRAINT chk_positive_amount CHECK (amount > 0);
```

Each of the above operations acquires an `ACCESS EXCLUSIVE` lock. For a 500M row table, the lock may hold for minutes. Meanwhile, every application waiting for a connection to `transactions` queues up — eventually exhausting connection pools across the fleet.

## 2. Flyway vs Liquibase

Both are mature schema migration tools. The choice often comes down to team preference and existing ecosystem.

| Feature | Flyway | Liquibase |
|---|---|---|
| Migration format | SQL (primary), Java | XML, YAML, JSON, SQL |
| Versioning | Sequential (V1, V2, V3) | Sequential or labeled |
| Rollback | Commercial (Teams+) | Built-in |
| Spring Boot integration | First-class | First-class |
| Dry-run | Commercial | Built-in |
| Community | Large | Large |
| Complexity | Simpler | More features |

### Flyway Setup

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-core</artifactId>
</dependency>
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-database-postgresql</artifactId>
</dependency>
```

```yaml
# application.yml
spring:
  flyway:
    enabled: true
    locations: classpath:db/migration
    baseline-on-migrate: false
    validate-on-migrate: true
    out-of-order: false       # strict ordering
    table: flyway_schema_history
```

```
src/main/resources/db/migration/
  V001__create_accounts.sql
  V002__create_transactions.sql
  V003__add_transactions_account_index.sql
  V004__add_idempotency_key.sql
```

### Liquibase Setup

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.liquibase</groupId>
    <artifactId>liquibase-core</artifactId>
</dependency>
```

```yaml
# application.yml
spring:
  liquibase:
    enabled: true
    change-log: classpath:db/changelog/db.changelog-master.yaml
    contexts: production
```

```yaml
# db/changelog/db.changelog-master.yaml
databaseChangeLog:
  - includeAll:
      path: db/changelog/changes/
      relativeToChangelogFile: true
```

## 3. The Expand-Contract Pattern

The expand-contract (also called parallel change) pattern allows schema changes to be deployed without downtime by separating the change into phases, each of which is backward-compatible.

### Phase 1: Expand (Backward-Compatible Addition)

```sql
-- V010__expand_add_processor_id.sql
-- Add the new column as NULLABLE — no NOT NULL constraint yet.
-- Existing application code doesn't know about this column; NULL is fine.
-- This migration is instant: PostgreSQL adds a nullable column with no table scan.

ALTER TABLE transactions ADD COLUMN processor_id UUID;

-- Add index concurrently (doesn't block reads/writes)
CREATE INDEX CONCURRENTLY idx_transactions_processor_id
    ON transactions (processor_id)
    WHERE processor_id IS NOT NULL;

-- Comment explains the multi-phase migration plan
COMMENT ON COLUMN transactions.processor_id IS
    'Added 2024-01-10 (Phase 1 of 3). Backfill in progress. NOT NULL constraint added in Phase 3.';
```

### Phase 2: Backfill (Populate Existing Rows)

```java
// BackfillProcessorIdJob.java — deployed and run after Phase 1
@Component
@Slf4j
public class BackfillProcessorIdJob implements ApplicationRunner {

    private final JdbcTemplate jdbcTemplate;
    private final MeterRegistry metrics;
    private static final int BATCH_SIZE = 1_000;

    /**
     * Backfill processor_id in small batches to avoid long-running transactions.
     * Uses keyset pagination to avoid OFFSET performance degradation.
     * Runs until all rows are populated.
     */
    @Override
    public void run(ApplicationArguments args) throws Exception {
        log.info("Starting processor_id backfill");
        long totalUpdated = 0;
        UUID lastId = null;

        while (true) {
            int updated;
            if (lastId == null) {
                updated = jdbcTemplate.update(
                    """
                    UPDATE transactions
                    SET processor_id = derive_processor_id(reference)
                    WHERE processor_id IS NULL
                      AND id IN (
                        SELECT id FROM transactions
                        WHERE processor_id IS NULL
                        ORDER BY id
                        LIMIT ?
                      )
                    """,
                    BATCH_SIZE
                );
            } else {
                updated = jdbcTemplate.update(
                    """
                    UPDATE transactions
                    SET processor_id = derive_processor_id(reference)
                    WHERE processor_id IS NULL
                      AND id IN (
                        SELECT id FROM transactions
                        WHERE processor_id IS NULL
                          AND id > ?
                        ORDER BY id
                        LIMIT ?
                      )
                    """,
                    lastId, BATCH_SIZE
                );
            }

            if (updated == 0) break;

            totalUpdated += updated;
            metrics.counter("migration.backfill.rows").increment(updated);

            // Small pause to avoid overwhelming the DB during peak hours
            if (isPeakHours()) {
                Thread.sleep(100);
            }

            log.info("Backfilled {} rows total", totalUpdated);
        }

        log.info("Backfill complete: {} rows total", totalUpdated);
    }

    private boolean isPeakHours() {
        int hour = LocalTime.now().getHour();
        return hour >= 8 && hour <= 20;
    }
}
```

### Phase 3: Contract (Add NOT NULL Constraint)

```sql
-- V012__contract_processor_id_not_null.sql
-- Run ONLY after backfill is 100% complete and new code writes processor_id on all inserts.
-- Uses NOT VALID + VALIDATE pattern to avoid a full table scan under lock.

-- Step 1: Add constraint without validating existing rows (fast, no lock on data)
ALTER TABLE transactions
    ADD CONSTRAINT chk_processor_id_not_null
    CHECK (processor_id IS NOT NULL)
    NOT VALID;  -- skip validation of existing rows

-- Step 2: Validate separately (uses SHARE UPDATE EXCLUSIVE — allows reads/writes!)
ALTER TABLE transactions VALIDATE CONSTRAINT chk_processor_id_not_null;

-- Now safe to convert to NOT NULL (uses existing validated constraint)
ALTER TABLE transactions ALTER COLUMN processor_id SET NOT NULL;

-- Drop the CHECK constraint (redundant now that column is NOT NULL)
ALTER TABLE transactions DROP CONSTRAINT chk_processor_id_not_null;
```

## 4. Renaming Columns — 3-Step Migration

```sql
-- Goal: rename transactions.reference -> transactions.external_reference
-- Cannot rename directly: all existing code breaks immediately

-- Step 1: Add new column (expand)
-- V015__expand_add_external_reference.sql
ALTER TABLE transactions ADD COLUMN external_reference VARCHAR(100);
-- Application code updated to write BOTH columns simultaneously
-- New code reads external_reference, falls back to reference if NULL

-- Step 2: Backfill (populate new column from old)
-- V016__backfill_external_reference.sql
UPDATE transactions SET external_reference = reference
WHERE external_reference IS NULL
  AND reference IS NOT NULL;
-- (For large tables: use batched backfill job as shown above)

-- Step 3: Contract (drop old column)
-- Run ONLY after all application instances no longer reference old column name
-- V018__contract_drop_reference.sql
ALTER TABLE transactions DROP COLUMN reference;
-- Or rename: ALTER TABLE transactions RENAME COLUMN reference TO reference_deprecated;
-- Then drop in a later migration after verification
```

## 5. Online Index Creation

```sql
-- CREATE INDEX CONCURRENTLY: does not block reads or writes
-- Uses multiple passes to build the index without an exclusive lock.
-- Takes longer than regular CREATE INDEX, but is safe for production.

CREATE INDEX CONCURRENTLY idx_transactions_external_ref
    ON transactions (external_reference)
    WHERE external_reference IS NOT NULL;

-- Check progress
SELECT phase, blocks_done, blocks_total, tuples_done, tuples_total,
       ROUND(100.0 * blocks_done / NULLIF(blocks_total, 0), 1) AS pct_done
FROM pg_stat_progress_create_index
WHERE relid = 'transactions'::regclass;

-- If CONCURRENTLY fails mid-way (connection lost, etc.), it leaves a INVALID index
-- Check for invalid indexes:
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'transactions'
  AND NOT indisvalid;  -- WARNING: this syntax may differ by version

-- Drop and retry the failed index:
DROP INDEX CONCURRENTLY idx_transactions_external_ref;
CREATE INDEX CONCURRENTLY idx_transactions_external_ref ON transactions (...);
```

## 6. Large Table Migrations with pg_repack

For migrations that require rewriting table data (e.g., changing column type, filling gaps in values), `pg_repack` rebuilds the table online without blocking.

```bash
# Install pg_repack
apt-get install postgresql-16-repack

# Rebuild the transactions table (removes bloat, reorganizes storage)
# This runs online — reads and writes continue
pg_repack \
  --host=db.internal \
  --port=5432 \
  --dbname=payments \
  --table=transactions \
  --no-superuser-check \
  --jobs=4

# Reorganize table in partition-wise fashion
pg_repack \
  --host=db.internal \
  --table=transactions_2024_01 \
  --table=transactions_2024_02
```

## 7. Spring Boot Flyway Integration

```java
@Configuration
public class FlywayConfig {

    /**
     * Custom Flyway configuration for payment database.
     * Separates DDL migrations (versioned) from data migrations (repeatable).
     */
    @Bean
    public Flyway flyway(DataSource dataSource) {
        return Flyway.configure()
            .dataSource(dataSource)
            .locations("classpath:db/migration", "classpath:db/data-migration")
            .validateMigrationNaming(true)
            .outOfOrder(false)
            .lockRetryCount(5)         // retry if another instance is migrating
            .connectRetries(3)         // retry DB connection on startup
            .baselineOnMigrate(false)
            .validateOnMigrate(true)
            .load();
    }

    @Bean
    public FlywayMigrationInitializer flywayInitializer(Flyway flyway) {
        return new FlywayMigrationInitializer(flyway, f -> {
            MigrationInfo[] pending = f.info().pending();
            if (pending.length > 0) {
                log.info("Running {} pending Flyway migrations", pending.length);
                for (MigrationInfo m : pending) {
                    log.info("  - {}: {}", m.getVersion(), m.getDescription());
                }
            }
            f.migrate();
        });
    }
}
```

## 8. Migration Rollback Strategy

Flyway Community does not support automatic rollback. The recommended approach is forward-only migrations with explicit undo scripts.

```sql
-- V020__add_settlement_account_id.sql  (forward migration)
ALTER TABLE transactions ADD COLUMN settlement_account_id UUID;
CREATE INDEX CONCURRENTLY idx_transactions_settlement_account
    ON transactions (settlement_account_id)
    WHERE settlement_account_id IS NOT NULL;

-- U020__add_settlement_account_id.sql  (undo migration — Flyway Teams / manual)
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_settlement_account;
ALTER TABLE transactions DROP COLUMN IF EXISTS settlement_account_id;
```

For Community edition, maintain manual rollback scripts and test them in staging:

```java
@Component
@Profile("staging")
public class MigrationRollbackTester {

    private final JdbcTemplate jdbcTemplate;
    private final Flyway flyway;

    /**
     * Test that the rollback script works before promoting to production.
     * Run this in staging CI after each migration.
     */
    @Test
    public void verifyRollbackScript() throws Exception {
        // Record pre-migration state
        int rowCountBefore = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM transactions", Integer.class);

        // Apply migration
        flyway.migrate();

        // Verify migration succeeded
        // ... validate new column exists, indexes are present

        // Run rollback script
        Resource rollbackScript = new ClassPathResource("db/rollback/U020__rollback.sql");
        ScriptUtils.executeSqlScript(
            jdbcTemplate.getDataSource().getConnection(),
            rollbackScript
        );

        // Verify rollback succeeded
        int rowCountAfter = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM transactions", Integer.class);
        assertThat(rowCountAfter).isEqualTo(rowCountBefore);
    }
}
```

## 9. Migration Testing with Testcontainers

```java
@SpringBootTest
@Testcontainers
@TestPropertySource(properties = {
    "spring.flyway.validate-on-migrate=true",
    "spring.flyway.out-of-order=false"
})
class FlywayMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
        .withDatabaseName("payments_test")
        .withUsername("payments")
        .withPassword("test");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired
    private Flyway flyway;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void allMigrationsShouldApplyCleanly() {
        // Flyway runs automatically on startup; if it failed, context wouldn't load
        MigrationInfo[] applied = flyway.info().applied();
        assertThat(applied).isNotEmpty();

        // Verify no failed migrations
        long failedCount = Arrays.stream(applied)
            .filter(m -> m.getState() == MigrationState.FAILED)
            .count();
        assertThat(failedCount).isZero();
    }

    @Test
    void latestMigrationShouldHaveCorrectSchema() {
        // Verify the schema is as expected after all migrations
        // This catches typos, missing columns, wrong types
        ResultSet rs = jdbcTemplate.getDataSource()
            .getConnection()
            .getMetaData()
            .getColumns(null, "public", "transactions", null);

        Map<String, String> columns = new HashMap<>();
        while (rs.next()) {
            columns.put(rs.getString("COLUMN_NAME"), rs.getString("TYPE_NAME"));
        }

        assertThat(columns).containsEntry("id", "uuid");
        assertThat(columns).containsEntry("account_id", "uuid");
        assertThat(columns).containsEntry("amount", "numeric");
        assertThat(columns).containsEntry("processor_id", "uuid");
        assertThat(columns).containsEntry("external_reference", "varchar");
    }

    @Test
    void indexesShouldExistAfterMigrations() {
        List<String> indexes = jdbcTemplate.queryForList(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'transactions'",
            String.class
        );

        assertThat(indexes).contains(
            "transactions_pkey",
            "idx_transactions_account_history",
            "idx_transactions_pending",
            "idx_transactions_external_ref"
        );
    }

    @Test
    void migrationShouldBeIdempotent() {
        // Run migrations twice — should be a no-op the second time
        flyway.migrate();
        flyway.migrate();

        // Verify no duplicate entries in schema history
        int historyRows = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM flyway_schema_history", Integer.class);

        int uniqueVersionRows = jdbcTemplate.queryForObject(
            "SELECT COUNT(DISTINCT version) FROM flyway_schema_history", Integer.class);

        assertThat(historyRows).isEqualTo(uniqueVersionRows);
    }
}
```

## 10. Zero-Downtime Migration Checklist

Before every production schema migration:

```
Pre-deployment:
[ ] Migration uses only backward-compatible DDL (nullable columns, CONCURRENTLY)
[ ] Application code handles both old and new schema (expand phase only)
[ ] Migration tested in staging with production-size data volumes
[ ] Rollback script exists and has been tested in staging
[ ] DB team has reviewed the migration for lock implications
[ ] On-call engineer is notified and monitoring dashboards are open

During deployment:
[ ] Deploy application code first (reads new schema gracefully if column missing)
[ ] Run migration (Flyway migrates on startup — verify in logs)
[ ] Monitor: connection pool saturation, query latency, error rate
[ ] Verify migration completed successfully in flyway_schema_history

Post-deployment:
[ ] Run backfill job if required (Phase 2)
[ ] Monitor backfill progress and DB impact
[ ] Schedule Phase 3 (NOT NULL constraint / column drop) for next sprint
[ ] Update rollback runbook to reflect current state
```

> [!WARNING]
> The expand-contract pattern requires at minimum two separate deployments and often three. Teams under time pressure often try to combine phases. Resist this. A single combined migration that renames a column and drops the old name in one deployment will cause an outage. The extra deployment cost is always less than the cost of a production incident in a financial system.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "You need to add a NOT NULL column `processor_id UUID NOT NULL` to a 500M row transactions table in production. If you run this as a single ALTER TABLE statement, what happens?",
      "options": [
        "PostgreSQL adds the column instantly using metadata only, with no lock",
        "PostgreSQL acquires an ACCESS EXCLUSIVE lock and scans all 500M rows to validate the NOT NULL constraint, blocking all reads and writes for minutes",
        "PostgreSQL rejects the statement because NOT NULL columns cannot be added to existing tables",
        "PostgreSQL adds the column with NULL values for existing rows and enforces NOT NULL only for new inserts"
      ],
      "correct": 1,
      "explanation": "ALTER TABLE ... ADD COLUMN ... NOT NULL acquires an ACCESS EXCLUSIVE lock (blocks all reads and writes) and must validate the NOT NULL constraint against every existing row. For a 500M row table, this lock could last several minutes, causing a production outage. The expand-contract pattern avoids this: add as nullable (Phase 1, instant), backfill (Phase 2, no lock), then add CHECK NOT VALID + VALIDATE separately (Phase 3, SHARE UPDATE EXCLUSIVE lock — allows reads/writes)."
    },
    {
      "text": "You are renaming column `transactions.reference` to `transactions.external_reference`. What is the minimum number of deployments required to do this with zero downtime?",
      "options": [
        "One deployment with a single RENAME COLUMN migration",
        "Two deployments: one to add the new column, one to drop the old after backfill",
        "Three deployments: add new column (Phase 1), write to both + backfill (Phase 2), drop old column after all app instances are updated (Phase 3)",
        "Four deployments: add column, backfill, switch reads, drop old column"
      ],
      "correct": 2,
      "explanation": "Column renaming requires at least three phases because application code and database schema must be changed independently to maintain backward compatibility. Phase 1: add external_reference as nullable. Phase 2: deploy app code that writes to BOTH columns and reads external_reference (falling back to reference if null); backfill existing rows. Phase 3: once all instances are on Phase 2 code and backfill is 100% complete, drop the old reference column. A direct RENAME breaks all existing app code that references the old name."
    },
    {
      "text": "During a CREATE INDEX CONCURRENTLY operation on the transactions table, the database connection drops. What is the correct recovery procedure?",
      "options": [
        "Re-run the same CREATE INDEX CONCURRENTLY command — it will resume from where it left off",
        "Run REINDEX CONCURRENTLY to fix the partially built index",
        "Drop the INVALID index with DROP INDEX CONCURRENTLY, then re-run the CREATE INDEX CONCURRENTLY",
        "Run VACUUM FULL transactions to clean up the broken index"
      ],
      "correct": 2,
      "explanation": "When CREATE INDEX CONCURRENTLY fails mid-way, it leaves behind an index marked as INVALID in pg_indexes. This index is not usable for queries but still incurs maintenance overhead on every write. The correct procedure is: (1) find the invalid index with SELECT indexname FROM pg_indexes WHERE NOT indisvalid, (2) DROP INDEX CONCURRENTLY idx_name, (3) retry the CREATE INDEX CONCURRENTLY. REINDEX CONCURRENTLY would work for a valid but bloated index, but cannot fix an INVALID index from a failed CREATE."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Zero-Downtime Schema Migration for Payment Processor",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Design a complete 3-phase expand-contract migration plan for adding a mandatory `settlement_batch_id UUID NOT NULL` column to a 300M row transactions table. Write all three Flyway migration scripts (V020, V021, V022) with comments explaining each step, the lock type held, and the expected duration on a production table. Include the backfill job implementation with batched updates and progress tracking."},
    {"id": "2", "description": "Write a Testcontainers-based migration test that validates: (a) all existing migrations apply cleanly to a fresh PostgreSQL 16 container, (b) no INVALID indexes exist after migrations, (c) the schema matches the expected DDL, and (d) a rollback script successfully undoes the latest migration without data loss. Run this test in CI against every PR."},
    {"id": "3", "description": "Implement a migration safety checker that runs before any migration in the CI pipeline. It should analyze each migration file and flag: ACCESS EXCLUSIVE locks on large tables (> 10M rows), direct RENAME COLUMN operations, NOT NULL constraints added without NOT VALID, and DROP TABLE/COLUMN without a matching expand phase. Output a human-readable risk assessment report."},
    {"id": "4", "description": "Simulate a production migration failure scenario: a column rename is deployed in one step, causing the app to crash immediately. Write the incident runbook including: how to identify the failing migration, how to roll back using a pre-migration snapshot, how to verify data integrity after rollback, and how to implement the correct 3-phase migration in the subsequent deployment."}
  ]
}
-->
