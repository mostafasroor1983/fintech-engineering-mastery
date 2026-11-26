---
id: track-08-lesson-09
title: "تطور المخطط — الترحيل بدون توقف"
slug: schema-evolution
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 9
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [schema-evolution, Flyway, Liquibase, online-migration, backward-compatible]
prerequisites: [track-08-lesson-01]
---

# تطور المخطط — ترحيلات دون توقف

> [!NOTE]
> ترحيل لقاعدة بيانات المدفوعات يأخذ قفل جدول في التاسعة صباح يوم الاثنين سيحجب كل معاملة طوال مدته. وقواعد البيانات المالية لا تحتمل التوقف من أجل تغييرات المخطط. ونمط التوسيع ثم التقليص (expand-contract) وأدوات DDL الحية في PostgreSQL تجعل الترحيلات دون توقف ممكنة — لكنها تتطلب انضباطًا ونهج نشر على مراحل.

## 1. مشكلة الترحيلات الساذجة

```sql
-- DANGEROUS: each statement takes an ACCESS EXCLUSIVE lock on transactions

-- NOT NULL column without a default: FAILS on a non-empty table
-- ("column contains null values"). With a VOLATILE default such as
-- gen_random_uuid() it succeeds -- by rewriting every row under the lock.
ALTER TABLE transactions ADD COLUMN processor_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Renaming a column is instant, but breaks all code that uses the old name
ALTER TABLE transactions RENAME COLUMN reference TO external_reference;

-- Adding a CHECK constraint validates all existing rows while holding the lock
ALTER TABLE transactions ADD CONSTRAINT chk_positive_amount CHECK (amount > 0);
```

تأخذ كل عملية مما سبق قفل `ACCESS EXCLUSIVE`. وفي إعادة الكتابة والتحقق من CHECK على جدول من 500 مليون صف، قد يبقى القفل دقائق. وحتى العمليات الفورية يجب أن *تنتظر* أولًا كل استعلام جارٍ على الجدول — وأثناء انتظارها، يصطف كل استعلام جديد خلفها، فتُستنفد في النهاية مجمعات الاتصالات في كل الخوادم. فاضبط دائمًا `lock_timeout` قصيرًا لعمليات DDL.

## 2. ‏Flyway مقابل Liquibase

كلاهما أداة ناضجة لترحيل المخطط. وكثيرًا ما يعود الاختيار إلى تفضيل الفريق والنظام البيئي القائم.

| الميزة | Flyway | Liquibase |
|---|---|---|
| صيغة الترحيل | SQL (أساسًا)، Java | XML، YAML، JSON، SQL |
| الترقيم | متتابع (V1، V2، V3) | متتابع أو بتسميات |
| التراجع (undo) | الإصدارات المدفوعة | مدمج |
| التكامل مع Spring Boot | من الدرجة الأولى | من الدرجة الأولى |
| التشغيل التجريبي | الإصدارات المدفوعة | مدمج (`update-sql`) |
| المجتمع | كبير | كبير |
| التعقيد | أبسط | ميزات أكثر |

### إعداد Flyway

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

### إعداد Liquibase

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

## 3. نمط التوسيع ثم التقليص

يتيح نمط التوسيع ثم التقليص (ويُسمى أيضًا التغيير المتوازي) نشر تغييرات المخطط دون توقف بفصل التغيير إلى مراحل، كل منها متوافق مع الإصدار السابق.

### المرحلة 1: التوسيع (إضافة متوافقة مع السابق)

```sql
-- V010__expand_add_processor_id.sql
-- Add the new column as NULLABLE — no NOT NULL constraint yet.
-- Existing application code doesn't know about this column; NULL is fine.
-- This migration is instant: PostgreSQL adds a nullable column with no table scan.

SET lock_timeout = '3s';   -- give up instead of queueing behind long queries
ALTER TABLE transactions ADD COLUMN processor_id UUID;

-- Comment explains the multi-phase migration plan
COMMENT ON COLUMN transactions.processor_id IS
    'Added 2024-01-10 (Phase 1 of 3). Backfill in progress. NOT NULL constraint added in Phase 3.';

-- V011__index_processor_id.sql  -- a SEPARATE migration:
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, and Flyway
-- runs each migration in one (it refuses to mix transactional and
-- non-transactional statements in a single file)
CREATE INDEX CONCURRENTLY idx_transactions_processor_id
    ON transactions (processor_id)
    WHERE processor_id IS NOT NULL;
```

### المرحلة 2: الملء الرجعي (تعبئة الصفوف القائمة)

```java
// BackfillProcessorIdJob.java — run ONCE after Phase 1, and only after the
// new application code writes processor_id on every insert (otherwise new
// NULL rows keep appearing). Run it as a one-off job, not on every
// instance's startup -- or guard it with an advisory lock.
@Component
@Slf4j
public class BackfillProcessorIdJob {

    private final JdbcTemplate jdbcTemplate;
    private final MeterRegistry metrics;
    private static final int BATCH_SIZE = 1_000;

    /**
     * Backfill processor_id in small batches (one short transaction each).
     * Keyset pagination on id: every batch continues after the last id, so
     * rows whose value cannot be derived (still NULL) are never re-read
     * forever.
     */
    public void run() throws InterruptedException {
        log.info("Starting processor_id backfill");
        long totalUpdated = 0;
        UUID lastId = null;

        while (true) {
            List<UUID> ids = jdbcTemplate.queryForList(
                """
                WITH batch AS (
                    SELECT id FROM transactions
                    WHERE processor_id IS NULL
                      AND (?::uuid IS NULL OR id > ?::uuid)
                    ORDER BY id
                    LIMIT ?
                )
                UPDATE transactions t
                SET processor_id = derive_processor_id(t.reference)
                FROM batch
                WHERE t.id = batch.id
                RETURNING t.id
                """,
                UUID.class, lastId, lastId, BATCH_SIZE);

            if (ids.isEmpty()) break;

            lastId = Collections.max(ids);        // continue after this batch
            totalUpdated += ids.size();
            metrics.counter("migration.backfill.rows").increment(ids.size());

            // Small pause to avoid overwhelming the DB during peak hours
            if (isPeakHours()) {
                Thread.sleep(100);
            }

            log.info("Backfilled {} rows total", totalUpdated);
        }

        log.info("Backfill complete: {} rows total", totalUpdated);
    }

    private boolean isPeakHours() {
        int hour = LocalTime.now(ZoneOffset.UTC).getHour();
        return hour >= 8 && hour <= 20;
    }
}
```

### المرحلة 3: التقليص (إضافة قيد NOT NULL)

```sql
-- V012__contract_processor_id_not_null.sql
-- Run ONLY after backfill is 100% complete and new code writes processor_id on all inserts.
-- Uses NOT VALID + VALIDATE pattern to avoid a full table scan under lock.

-- Step 1: Add constraint without validating existing rows
-- (brief ACCESS EXCLUSIVE lock, no scan)
ALTER TABLE transactions
    ADD CONSTRAINT chk_processor_id_not_null
    CHECK (processor_id IS NOT NULL)
    NOT VALID;  -- skip validation of existing rows

-- Step 2: Validate separately (uses SHARE UPDATE EXCLUSIVE — allows reads/writes!)
ALTER TABLE transactions VALIDATE CONSTRAINT chk_processor_id_not_null;

-- Now SET NOT NULL skips the full scan (PostgreSQL 12+ uses the validated
-- CHECK constraint); it still takes a brief ACCESS EXCLUSIVE lock
ALTER TABLE transactions ALTER COLUMN processor_id SET NOT NULL;

-- Drop the CHECK constraint (redundant now that column is NOT NULL)
ALTER TABLE transactions DROP CONSTRAINT chk_processor_id_not_null;
```

## 4. إعادة تسمية الأعمدة — ترحيل من 3 خطوات

```sql
-- Goal: rename transactions.reference -> transactions.external_reference
-- Cannot rename directly: all existing code breaks immediately

-- Step 1: Add new column (expand)
-- V015__expand_add_external_reference.sql
ALTER TABLE transactions ADD COLUMN external_reference VARCHAR(100);
-- Application code updated to write BOTH columns simultaneously
-- New code reads external_reference, falls back to reference if NULL
-- (Alternative while old and new code run side by side: a trigger that
--  copies reference -> external_reference on every insert/update)

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

## 5. إنشاء الفهارس أثناء العمل

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

-- If CONCURRENTLY fails mid-way (connection lost, etc.), it leaves an INVALID index
-- Check for invalid indexes (validity lives in pg_index, not pg_indexes):
SELECT c.relname AS indexname, pg_get_indexdef(i.indexrelid) AS indexdef
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'transactions'::regclass
  AND NOT i.indisvalid;

-- Drop and retry the failed index:
DROP INDEX CONCURRENTLY idx_transactions_external_ref;
CREATE INDEX CONCURRENTLY idx_transactions_external_ref ON transactions (...);
```

## 6. إزالة الانتفاخ بعد الترحيلات الكبيرة باستخدام pg_repack

تترك عمليات الملء الرجعي والتحديث الكبيرة مساحة ميتة كثيرة خلفها. ويعيد `pg_repack` بناء الجدول أثناء العمل لإزالة ذلك الانتفاخ (أو لإعادة ترتيبه حسب فهرس) مع أقفال قصيرة فقط في البداية والنهاية. وهو **لا** يغيّر أنواع الأعمدة أو البيانات — ولتغيير الأنواع، استخدم نمط التوسيع ثم التقليص (عمود جديد، وكتابة مزدوجة، وملء رجعي، وتبديل، وحذف).

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

## 7. تكامل Flyway مع Spring Boot

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

## 8. استراتيجية التراجع عن الترحيل

لا يدعم Flyway Community التراجع التلقائي. والنهج الموصى به ترحيلات إلى الأمام فقط مع سكربتات تراجع صريحة.

```sql
-- V020__add_settlement_account_id.sql  (forward migration)
ALTER TABLE transactions ADD COLUMN settlement_account_id UUID;

-- V021__index_settlement_account_id.sql  (separate: CONCURRENTLY)
CREATE INDEX CONCURRENTLY idx_transactions_settlement_account
    ON transactions (settlement_account_id)
    WHERE settlement_account_id IS NOT NULL;

-- Rollback scripts (Flyway paid "undo" files, or kept manually):
-- U021: DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_settlement_account;
-- U020: ALTER TABLE transactions DROP COLUMN IF EXISTS settlement_account_id;
```

في الإصدار المجتمعي، احتفظ بسكربتات تراجع يدوية واختبرها في بيئة staging:

```java
// A CI test (not a runtime @Component): apply the migration, run the
// rollback script, and check the schema is back to its previous state
@SpringBootTest
@Testcontainers
class MigrationRollbackTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private DataSource dataSource;

    @Test
    void rollbackScriptRestoresPreviousSchema() throws Exception {
        // Flyway has applied all migrations at startup
        assertThat(columnExists("settlement_account_id")).isTrue();

        // Run the rollback scripts; try-with-resources returns the connection
        try (Connection con = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(con,
                new ClassPathResource("db/rollback/U021__drop_index.sql"));
            ScriptUtils.executeSqlScript(con,
                new ClassPathResource("db/rollback/U020__drop_column.sql"));
        }

        assertThat(columnExists("settlement_account_id")).isFalse();
    }

    private boolean columnExists(String column) {
        Integer n = jdbcTemplate.queryForObject("""
            SELECT count(*) FROM information_schema.columns
            WHERE table_name = 'transactions' AND column_name = ?
            """, Integer.class, column);
        return n != null && n > 0;
    }
}
```

## 9. اختبار الترحيل باستخدام Testcontainers

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
        Map<String, String> columns = new HashMap<>();
        try (Connection con = jdbcTemplate.getDataSource().getConnection();
             ResultSet rs = con.getMetaData()
                 .getColumns(null, "public", "transactions", null)) {
            while (rs.next()) {
                columns.put(rs.getString("COLUMN_NAME"), rs.getString("TYPE_NAME"));
            }
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

        // Verify no duplicate entries in schema history (versioned migrations
        // only: repeatable R__ migrations have a NULL version)
        int historyRows = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM flyway_schema_history WHERE version IS NOT NULL",
            Integer.class);

        int uniqueVersionRows = jdbcTemplate.queryForObject(
            "SELECT COUNT(DISTINCT version) FROM flyway_schema_history", Integer.class);

        assertThat(historyRows).isEqualTo(uniqueVersionRows);
    }
}
```

## 10. قائمة تحقق الترحيل دون توقف

قبل كل ترحيل مخطط في الإنتاج:

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
> يتطلب نمط التوسيع ثم التقليص نشرين منفصلين على الأقل وكثيرًا ما يتطلب ثلاثة. والفرق تحت ضغط الوقت كثيرًا ما تحاول دمج المراحل. فقاوم ذلك. فترحيل واحد مدمج يعيد تسمية عمود ويحذف الاسم القديم في نشر واحد سيسبب انقطاعًا. وكلفة النشر الإضافي أقل دائمًا من كلفة حادث إنتاج في نظام مالي.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تحتاج إضافة عمود `processor_id UUID NOT NULL DEFAULT gen_random_uuid()` إلى جدول معاملات من 500 مليون صف في الإنتاج. إذا شغّلت هذا كعبارة ALTER TABLE واحدة، ماذا يحدث؟",
      "options": [
        "يضيف PostgreSQL العمود فورًا باستخدام البيانات الوصفية فقط، دون قفل",
        "يأخذ PostgreSQL قفل ACCESS EXCLUSIVE ويعيد كتابة الـ 500 مليون صف كلها (القيمة الافتراضية متقلبة، فيحتاج كل صف قيمته الخاصة)، فيحجب كل القراءات والكتابات طوال إعادة الكتابة",
        "يرفض PostgreSQL العبارة لأن أعمدة NOT NULL لا يمكن إضافتها إلى جداول قائمة",
        "يضيف PostgreSQL العمود بقيم NULL للصفوف القائمة ويفرض NOT NULL على الإدراجات الجديدة فقط"
      ],
      "correct": 1,
      "explanation": "تأخذ ALTER TABLE ... ADD COLUMN قفل ACCESS EXCLUSIVE (يحجب كل القراءات والكتابات). ومع قيمة افتراضية متقلبة مثل gen_random_uuid()، يجب على PostgreSQL إعادة كتابة كل صف لتخزين قيمته الخاصة — دقائق من الانقطاع على جدول من 500 مليون صف. (ودون أي قيمة افتراضية تفشل العبارة ببساطة على جدول غير فارغ؛ ومع قيمة افتراضية ثابتة، يضيفها PostgreSQL 11+ فورًا عبر الكتالوج.) ونمط التوسيع ثم التقليص يتجنب القفل الطويل: أضف العمود قابلًا لـ NULL (المرحلة 1، فوري)، واملأه رجعيًا على دفعات (المرحلة 2)، ثم أضف CHECK ... NOT VALID + VALIDATE ثم SET NOT NULL (المرحلة 3، أقفال قصيرة فقط)."
    },
    {
      "text": "تعيد تسمية العمود `transactions.reference` إلى `transactions.external_reference`. ما الحد الأدنى من عمليات النشر المطلوبة لفعل ذلك دون توقف؟",
      "options": [
        "نشر واحد بترحيل RENAME COLUMN واحد",
        "نشران: واحد لإضافة العمود الجديد، وواحد لحذف القديم بعد الملء الرجعي",
        "ثلاثة نشرات: إضافة العمود الجديد (المرحلة 1)، والكتابة إلى كليهما + الملء الرجعي (المرحلة 2)، وحذف العمود القديم بعد تحديث كل نسخ التطبيق (المرحلة 3)",
        "أربعة نشرات: إضافة العمود، والملء الرجعي، وتبديل القراءات، وحذف العمود القديم"
      ],
      "correct": 2,
      "explanation": "تتطلب إعادة تسمية عمود ثلاث مراحل على الأقل لأن شيفرة التطبيق ومخطط قاعدة البيانات يجب تغييرهما باستقلال للحفاظ على التوافق مع السابق. المرحلة 1: أضف external_reference قابلًا لـ NULL. المرحلة 2: انشر شيفرة تطبيق تكتب إلى العمودين كليهما وتقرأ external_reference (مع الرجوع إلى reference إن كان NULL)؛ واملأ الصفوف القائمة رجعيًا. المرحلة 3: حالما تعمل كل النسخ بشيفرة المرحلة 2 ويكتمل الملء الرجعي 100%، احذف العمود القديم reference. وإعادة التسمية المباشرة تكسر كل شيفرة تطبيق قائمة تشير إلى الاسم القديم."
    },
    {
      "text": "أثناء عملية CREATE INDEX CONCURRENTLY على جدول المعاملات، ينقطع اتصال قاعدة البيانات. ما إجراء التعافي الصحيح؟",
      "options": [
        "أعد تشغيل أمر CREATE INDEX CONCURRENTLY نفسه — سيستأنف من حيث توقف",
        "شغّل VACUUM ANALYZE transactions كي يعلّم المخطِّط الفهرس صالحًا",
        "احذف الفهرس غير الصالح (INVALID) بـ DROP INDEX CONCURRENTLY، ثم أعد تشغيل CREATE INDEX CONCURRENTLY",
        "شغّل VACUUM FULL transactions لتنظيف الفهرس المعطوب"
      ],
      "correct": 2,
      "explanation": "حين يفشل CREATE INDEX CONCURRENTLY في منتصفه، يترك خلفه فهرسًا معلّمًا بأنه INVALID ‏(pg_index.indisvalid = false). ولا تستخدمه الاستعلامات لكنه ما زال يُحدَّث مع كل كتابة. والإجراء الموصى به: (1) اعثر عليه باستعلام على pg_index بشرط WHERE NOT indisvalid، (2) DROP INDEX CONCURRENTLY idx_name، (3) أعد محاولة CREATE INDEX CONCURRENTLY. (وإعادة بنائه بـ REINDEX INDEX CONCURRENTLY ممكنة أيضًا.) ولا يجعل VACUUM الفهرس غير الصالح صالحًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "ترحيل مخطط دون توقف لمعالج دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "صمم خطة ترحيل كاملة من 3 مراحل بنمط التوسيع ثم التقليص لإضافة عمود إلزامي `settlement_batch_id UUID NOT NULL` إلى جدول معاملات من 300 مليون صف. واكتب سكربتات ترحيل Flyway الثلاثة (V020، V021، V022) مع تعليقات تشرح كل خطوة، ونوع القفل المأخوذ، والمدة المتوقعة على جدول إنتاج. وضمّن تنفيذ مهمة الملء الرجعي بتحديثات على دفعات وتتبع للتقدم."},
    {"id": "2", "description": "اكتب اختبار ترحيل قائمًا على Testcontainers يتحقق من: (أ) أن كل الترحيلات القائمة تُطبق بنظافة على حاوية PostgreSQL 16 جديدة، (ب) عدم وجود فهارس INVALID بعد الترحيلات، (ج) تطابق المخطط مع DDL المتوقع، (د) أن سكربت تراجع يلغي آخر ترحيل بنجاح دون فقد بيانات. وشغّل هذا الاختبار في CI على كل PR."},
    {"id": "3", "description": "نفّذ فاحص أمان للترحيل يعمل قبل أي ترحيل في خط CI. ويجب أن يحلل كل ملف ترحيل ويعلّم: أقفال ACCESS EXCLUSIVE على الجداول الكبيرة (> 10 ملايين صف)، وعمليات RENAME COLUMN المباشرة، وقيود NOT NULL المضافة دون NOT VALID، وDROP TABLE/COLUMN دون مرحلة توسيع مقابلة. وأخرج تقرير تقييم مخاطر مقروءًا للبشر."},
    {"id": "4", "description": "حاكِ سيناريو فشل ترحيل في الإنتاج: إعادة تسمية عمود نُشرت في خطوة واحدة، فتعطل التطبيق فورًا. واكتب دليل الحادث متضمنًا: كيف تحدد الترحيل الفاشل، وكيف تتراجع باستخدام لقطة ما قبل الترحيل، وكيف تتحقق من سلامة البيانات بعد التراجع، وكيف تنفذ الترحيل الصحيح من 3 مراحل في النشر التالي."}
  ]
}
-->
