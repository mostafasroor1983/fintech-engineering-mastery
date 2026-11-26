---
id: track-08-lesson-17
title: "PostgreSQL الموزعة — Citus والاستعلامات الموزعة"
slug: distributed-postgresql
track: track-08
trackName: "بنية قواعد البيانات والبيانات"
sequence: 17
difficulty: principal
estimatedMinutes: 85
status: published
tags: [Citus, distributed, co-location, cross-shard, PostgreSQL]
prerequisites: [track-08-lesson-06, track-08-lesson-07]
---

# ‏PostgreSQL الموزّع — Citus والاستعلامات الموزعة

> [!NOTE]
> يوسّع Citus ‏PostgreSQL إلى قاعدة بيانات موزعة دون التضحية بلهجة SQL، أو ضمانات ACID، أو الأدوات القائمة. ولأحمال الدفع التي تجاوزت سعة الكتابة لخادم PostgreSQL واحد، يكون Citus خيار التوسع الأفقي الأكثر أمانة لـ PostgreSQL — قبل اللجوء إلى التجزئة على مستوى التطبيق أو الانتقال إلى محرك قاعدة بيانات مختلف.

## 1. بنية Citus

يستخدم Citus طوبولوجيا منسّق-عمّال:

```
Application
    |
    v
Coordinator (single PostgreSQL instance)
    |-- receives queries, creates distributed plans
    |-- metadata: which shard holds which data
    |
    +--------+--------+--------+
    v        v        v        v
Worker-1  Worker-2  Worker-3  Worker-4
(shards)  (shards)  (shards)  (shards)
```

- **المنسّق (Coordinator)**: يقبل اتصالات العملاء، ويحلل SQL، وينشئ خطط استعلام موزعة، ويجمّع النتائج (ومنذ Citus 11، تستطيع العقد العاملة أيضًا قبول الاستعلامات وتوجيهها، ما يوزع هذا الحمل)
- **العمّال (Workers)**: يخزنون أجزاء الجداول الموزعة، وينفذون الاستعلامات الجزئية
- **الجزء (Shard)**: جدول PostgreSQL فيزيائي على عامل، يحوي مجموعة فرعية من الصفوف

يُقسم كل جدول موزع إلى N جزء (الافتراضي 32، الإعداد `citus.shard_count`) موزعة على العمّال.

## 2. إعداد امتداد Citus

```sql
-- On coordinator and all workers: postgresql.conf needs
--   shared_preload_libraries = 'citus'   (restart), then:
CREATE EXTENSION citus;

-- Add worker nodes to the coordinator (Citus 10+ names; the old
-- master_add_node / master_get_active_worker_nodes are deprecated)
SELECT citus_add_node('worker-1.internal', 5432);
SELECT citus_add_node('worker-2.internal', 5432);
SELECT citus_add_node('worker-3.internal', 5432);
SELECT citus_add_node('worker-4.internal', 5432);

-- Verify cluster
SELECT * FROM citus_get_active_worker_nodes();
```

## 3. اختيار عمود التوزيع

يحدد عمود التوزيع الجزء الذي يذهب إليه الصف (عبر التجزئة). **وهذا أهم قرار معماري في نشر Citus.**

مبادئ اختيار عمود التوزيع:
1. يظهر العمود في عبارات WHERE لمعظم الاستعلامات (يتيح تقليم الأجزاء)
2. تعدد عالٍ (القيم المميزة الكثيرة توزع البيانات بالتساوي)
3. يُستخدم كمفتاح ربط بين الجداول المربوطة كثيرًا (يتيح التموضع المشترك)
4. لا يتغير بعد الإدراج (لا يسمح Citus بتحديث عمود التوزيع لصف)

```sql
-- For a payment system, account_id is the natural distribution column:
-- - Every transaction has an account_id
-- - Every query filters by account_id
-- - account_id joins transactions to accounts
-- - account_id never changes for a transaction

-- Create distributed transaction table
CREATE TABLE transactions (
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL,
    amount       NUMERIC(19,4) NOT NULL,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- primary keys / unique constraints must include the distribution column
    PRIMARY KEY (account_id, id)
);

SELECT create_distributed_table('transactions', 'account_id');
-- Creates 32 shards distributed across 4 workers (8 shards per worker)

-- Create distributed accounts table with SAME distribution column
-- This enables co-location (accounts and transactions for the same account_id
-- live on the same worker shard)
CREATE TABLE accounts (
    id           UUID PRIMARY KEY,
    -- UNIQUE (account_number) is NOT allowed here: a unique constraint on a
    -- distributed table must include the distribution column. Enforce it
    -- with a separate lookup table distributed on account_number.
    account_number VARCHAR(20) NOT NULL,
    balance      NUMERIC(19,4) NOT NULL DEFAULT 0,
    currency     CHAR(3) NOT NULL,
    status       VARCHAR(20) NOT NULL
);

SELECT create_distributed_table('accounts', 'id', colocate_with => 'transactions');
-- accounts distributed on 'id', transactions on 'account_id': same type
-- (UUID), same shard count -> one co-location group. Citus would group
-- them by default too; colocate_with makes the intent explicit.
```

## 4. التموضع المشترك للجداول

يضمن التموضع المشترك (co-location) أن الصفوف من جداول متعددة ذات قيمة مفتاح التوزيع نفسها تقع في الجزء/العامل نفسه. وهذا يتيح الربط دون جولات شبكة بين العمّال.

```sql
-- Verify co-location
SELECT logicalrelid, colocationid
FROM pg_dist_partition
WHERE logicalrelid IN ('transactions'::regclass, 'accounts'::regclass);
-- Both should have the same colocationid

-- Query that benefits from co-location (join happens on same worker)
EXPLAIN SELECT t.id, t.amount, a.account_number
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.account_id = '11111111-1111-1111-1111-111111111111';

-- Coordinator plan output (simplified):
-- Custom Scan (Citus Adaptive)  (cost=0.00..0.00 rows=0 width=0)
--   Task Count: 1              <- only 1 shard queried! shard pruning works
--   Tasks Shown: All
--   ->  Task
--         Node: host=worker-2 port=5432 dbname=payments
--         ->  Nested Loop
--               ->  Index Scan using accounts_pkey_102346 on accounts_102346 a
--                     Index Cond: (id = '1111...')
--               ->  Index Scan using transactions_pkey_102345 on transactions_102345 t
--                     Index Cond: (account_id = '1111...')
-- The join happens entirely on worker-2 — no cross-node data movement
```

## 5. المعاملات الموزعة — القيود

يدعم Citus الالتزام ثنائي المرحلة (2PC) للمعاملات الموزعة، لكن مع تحفظات مهمة:

```sql
-- Single-shard transactions: fully ACID, same as regular PostgreSQL
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = '11111111-1111-1111-1111-111111111111';
INSERT INTO transactions (account_id, amount, ...) VALUES ('11111111-1111-1111-1111-111111111111', 100, ...);
COMMIT;
-- Both rows go to the same shard (co-located) -> single-node ACID

-- Cross-shard transactions: 2PC (slower, more failure modes)
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = '11111111-1111-1111-1111-111111111111'; -- shard A
UPDATE accounts SET balance = balance + 100 WHERE id = '99999999-9999-9999-9999-999999999999'; -- shard B
INSERT INTO transactions (account_id, amount, ...) VALUES ('11111111-1111-1111-1111-111111111111', -100, ...);
INSERT INTO transactions (account_id, amount, ...) VALUES ('99999999-9999-9999-9999-999999999999',  100, ...);
COMMIT;
-- This requires 2PC across shards:
-- 1. Coordinator sends PREPARE TRANSACTION to both workers
-- 2. Both workers prepare (write to WAL, hold locks)
-- 3. Coordinator sends COMMIT PREPARED
-- If the coordinator crashes between steps 2 and 3, prepared transactions
-- are left holding their locks. Citus's maintenance daemon resolves them
-- automatically from its commit log (or run: SELECT recover_prepared_transactions();)
--
-- Also note: a cross-shard commit is atomic, but there is no single global
-- snapshot -- a concurrent reader on another node may briefly see the
-- change on one shard and not yet on the other.
```

**مبدأ التصميم**: نظّم نموذج بياناتك بحيث تلمس معظم المعاملات جزءًا واحدًا. ولتحويلات المدفوعات بين الحسابات، استخدم نمط Saga أو نمط الدفتر الذي يجعل الكتابات الفردية idempotent بدل اشتراط 2PC عبر الأجزاء.

## 6. الجداول المرجعية — بيانات البحث الصغيرة

تُنسخ الجداول المرجعية (reference tables) إلى كل العمّال، فتتيح الربط المحلي دون استعلامات عبر الأجزاء.

```sql
-- Currency table: small, rarely changes, used in joins everywhere
CREATE TABLE currencies (
    code        CHAR(3) PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    decimal_places INT NOT NULL
);

-- Make it a reference table: replicated to all workers
SELECT create_reference_table('currencies');

-- Now this join is local on each worker (no cross-node query):
SELECT t.id, t.amount, c.name AS currency_name
FROM transactions t
JOIN currencies c ON t.currency = c.code
WHERE t.account_id = '11111111-1111-1111-1111-111111111111';
```

مرشحون آخرون للجداول المرجعية في نظام دفع:
- ‏`countries` — رموز الدول، والمناطق
- ‏`fee_schedules` — إعدادات شرائح الرسوم
- ‏`payment_method_types` — تعريفات أنواع البطاقات
- ‏`bank_codes` — أرقام التوجيه، ورموز BIC

## 7. التجميع الفوري على البيانات الموزعة

```sql
-- SUM across all shards: Citus parallelizes across workers
-- Workers compute partial aggregates, coordinator combines
EXPLAIN
SELECT
    DATE_TRUNC('hour', created_at) AS hour,
    currency,
    COUNT(*) AS transaction_count,
    SUM(amount) AS total_amount
FROM transactions
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY hour, currency
ORDER BY hour DESC;

-- Plan shows:
-- Custom Scan (Citus Adaptive)
--   Task Count: 32  <- all shards queried in parallel
--   ->  Task: HashAggregate (partial aggregate on each shard)
--         ->  Seq Scan on transactions_XXXXX
--               Filter: (created_at >= (now() - '24:00:00'::interval))

-- Performance: 4 workers * 8 shards each = 32 parallel partial aggregates
-- Then coordinator combines 32 partial results
-- Wall time ≈ time of the slowest shard task, if workers have enough
-- cores and connections to run their tasks in parallel
```

## 8. ‏Citus لأحمال الدفع كثيفة الكتابة

```sql
-- Write throughput comparison (illustrative -- measure your own workload)

-- Single PostgreSQL (1 writer):
-- INSERT throughput: ~10,000 TPS (NVMe SSD, WAL / CPU bound)

-- Citus (4 workers, 32 shards):
-- INSERT throughput: ~35,000-40,000 TPS (each worker writes its own WAL)
-- Not perfectly linear: routing through the coordinator costs CPU and a
-- network hop (Citus 11+ lets clients connect to any node to spread this)

-- Check shard distribution balance (citus_shards view, Citus 10+)
SELECT
    nodename                         AS worker_node,
    COUNT(*)                         AS shard_count,
    pg_size_pretty(SUM(shard_size))  AS total_size
FROM citus_shards
WHERE table_name = 'transactions'::regclass
GROUP BY nodename
ORDER BY nodename;
```

## 9. المقارنة مع التجزئة على مستوى التطبيق

| البعد | Citus | التجزئة على مستوى التطبيق |
|---|---|---|
| الشفافية | شفاف تمامًا — SQL قياسي | يجب على التطبيق توجيه الاستعلامات يدويًا |
| الاستعلامات عبر الأجزاء | تُعالج تلقائيًا (2PC/توجيه) | يجب على التطبيق تجميعها |
| تغييرات المخطط | DDL قياسي (يُنسخ) | يجب تطبيقها على كل الأجزاء يدويًا |
| إعادة التوازن | ‏`citus_rebalance_start()` (نقل الأجزاء أثناء العمل) | يتطلب ETL مخصصًا |
| التعقيد التشغيلي | متوسط (خبرة Citus) | عالٍ (منطق تجزئة مخصص) |
| دعم الربط | كامل (ضمن مجموعة التموضع المشترك) | محدود (يجب الربط في التطبيق) |
| منحنى التعلم | متوسط (خبرة SQL + Citus) | عالٍ (أنظمة موزعة مخصصة) |
| إنتاجية الكتابة | تنمو مع عدد العمّال (ناقص كلفة التوجيه) | تنمو مع عدد الأجزاء (التوجيه في التطبيق) |

```java
// Application-level sharding: routing logic must be in the application
@Service
public class ShardedTransactionRepository {

    private final Map<Integer, JdbcTemplate> shardTemplates;

    private int getShard(UUID accountId) {
        // floorMod, not Math.abs(...) % n: Math.abs(Integer.MIN_VALUE) is
        // negative. (And mod-N routing moves most keys when N changes --
        // see Lesson 07 for consistent hashing.)
        return Math.floorMod(accountId.hashCode(), shardTemplates.size());
    }

    public Transaction save(Transaction transaction) {
        int shard = getShard(transaction.getAccountId());
        JdbcTemplate jdbc = shardTemplates.get(shard);
        // ... execute on correct shard
    }

    public List<Transaction> findByAccount(UUID accountId) {
        int shard = getShard(accountId);
        JdbcTemplate jdbc = shardTemplates.get(shard);
        // ... query correct shard
    }

    // Cross-shard query: must fan out to all shards
    public List<Transaction> findByDateRange(Instant from, Instant to) {
        return shardTemplates.values().parallelStream()
            .flatMap(jdbc -> jdbc.query(...).stream())
            .sorted(Comparator.comparing(Transaction::getCreatedAt))
            .collect(Collectors.toList());
        // Complex, slow, error-prone: Citus handles this automatically
    }
}
```

**متى تختار التجزئة على مستوى التطبيق بدل Citus**:
- حين يجب أن تعيش الأجزاء في عناقيد مُشغّلة باستقلال أو حتى في محركات قواعد بيانات مختلفة
- حين يحتاج المستأجرون المختلفون مخططات مختلفة تمامًا (ملاحظة: يقدم Citus 12+ أيضًا التجزئة القائمة على المخططات — مخطط لكل مستأجر — وهي تغطي كثيرًا من هذه الحالات)
- حين يحتاج وضع الأجزاء تحكمًا دقيقًا (فرض الإقامة الجغرافية للبيانات)
- حين يملك الفريق أصلًا خبرة وبنية تحتية للتجزئة على مستوى التطبيق

## 10. ‏Citus المُدار سحابيًا — Azure

> [!NOTE]
> بيعت نسخة Citus المُدارة من Microsoft أولًا باسم "Hyperscale (Citus)"، ثم باسم Azure Cosmos DB for PostgreSQL. ومنذ ذلك الحين وجّهت Microsoft المشاريع الجديدة إلى **العناقيد المرنة (elastic clusters)** في Azure Database for PostgreSQL ‏(Flexible Server)، المبنية أيضًا على Citus. فتحقق من العرض الحالي قبل أن تبدأ؛ ويُظهر Terraform أدناه مورد Cosmos DB for PostgreSQL كمثال.

```hcl
# terraform/azure-cosmos-postgres.tf
resource "azurerm_cosmosdb_postgresql_cluster" "payments" {
  name                = "payments-distributed"
  resource_group_name = var.resource_group_name
  location            = var.location

  administrator_login_password = var.db_admin_password

  coordinator_storage_quota_in_mb = 524288   # 512GB coordinator
  coordinator_vcore_count         = 4
  coordinator_server_edition      = "GeneralPurpose"

  node_count              = 4
  node_storage_quota_in_mb = 524288    # 512GB per worker
  node_vcores             = 8
  node_server_edition     = "MemoryOptimized"

  citus_version = "12.1"
  sql_version   = "16"

  ha_enabled = true

  tags = {
    environment = "production"
    team        = "payments-infrastructure"
  }
}
```

يوفر Citus المُدار على Azure:
- نسخًا احتياطية آلية واستعادة لنقطة زمنية (PITR)
- توفرًا عاليًا بنسخ احتياطية جاهزة
- تحديثات آلية للإصدارات الفرعية
- مراقبة مدمجة في Azure Monitor

## 11. متى يكون Citus منطقيًا في التقنية المالية

معايير القرار لاعتماد Citus:

```
Choose Citus when (thresholds are rough guides, not hard limits):
  - Single PostgreSQL server write throughput is saturated (e.g. > 10,000 TPS writes on your hardware)
  - Data volume is beyond what one server handles comfortably (e.g. > 10TB of hot data)
  - Team has strong PostgreSQL expertise
  - Queries are predominantly account-scoped (shard pruning works well)
  - Regulatory requirements allow distributed storage within a jurisdiction

Do NOT choose Citus when:
  - Throughput problem is actually a query optimization problem (try indexes first)
  - Workload is primarily analytical (consider read replicas + columnar storage)
  - Cross-shard queries are frequent (application-level sharding or NewSQL)
  - Team lacks distributed systems operational experience
  - Data volume is manageable on a single server with partitioning
```

> [!WARNING]
> تغيير عمود التوزيع لاحقًا صعب جدًا. فدالة `alter_distributed_table(..., distribution_column => ...)` موجودة، لكنها تعيد كتابة كل البيانات ونقلها مع الإمساك بأقفال ثقيلة — حدث تشغيلي كبير على جدول ضخم. فاقضِ وقتًا كافيًا في التحقق من اختيار عمود التوزيع بأنماط استعلام واقعية قبل إنشاء جداول موزعة في الإنتاج. فالاختيار الخاطئ يكلف أسابيع من عمل إعادة التجزئة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يوزع عنقود Citus جدول transactions على account_id. ويرشّح استعلام حسب created_at فقط (دون شرط على account_id). كيف ينفذ Citus هذا الاستعلام؟",
      "options": [
        "يستخدم Citus فهرس created_at على كل جزء بالتوازي، فيجعله سريعًا كاستعلام عقدة واحدة",
        "يوزع Citus الاستعلام على كل الأجزاء الـ 32 (أو أيًا كان عددها)، وينفذه على كل منها بالتوازي، ويجمّع النتائج في المنسّق — فلا يمكن تقليم الأجزاء دون عمود التوزيع في الشرط",
        "يوجّه Citus الاستعلام إلى الجزء الأول ويعيد النتائج، لأن الأجزاء نسخ متطابقة",
        "يرفض Citus الاستعلام لأن الاستعلامات عبر الأجزاء دون عمود التوزيع غير مدعومة"
      ],
      "correct": 1,
      "explanation": "تقليم الأجزاء — الفائدة الأدائية الأساسية لـ Citus — يعمل فقط حين يظهر عمود التوزيع في عبارة WHERE. فدون account_id في الشرط، لا يستطيع Citus تحديد الجزء (أو الأجزاء) الذي يحوي الصفوف المعنية ويجب أن يوزع الاستعلام على كل الأجزاء. وهذا مكلف للاستعلامات النقطية لكنه قد يبقى سريعًا للتجميعات لأن كل الأجزاء تنفذ بالتوازي. ولهذا فاختيار عمود توزيع يظهر في معظم عبارات WHERE أهم قرار معماري في نشر Citus."
    },
    {
      "text": "في Citus، ما الغرض من التموضع المشترك، وما الذي يجب أن يتحقق كي يكون جدولان موزعان متموضعين معًا؟",
      "options": [
        "التموضع المشترك يعني تخزين الجداول على الخادم الفيزيائي نفسه؛ ويجب أن يكون للجدولين عدد الصفوف نفسه",
        "التموضع المشترك يعني تخزين الصفوف ذات قيمة مفتاح التوزيع نفسها من جداول متعددة في الجزء/العامل نفسه؛ ويتحقق بتوزيع الجدولين على أعمدة متكافئة منطقيًا (مثل accounts على 'id' وtransactions على 'account_id')",
        "التموضع المشترك يعني أن الجداول تُربط دائمًا في المنسّق؛ ولا يلزم إعداد خاص",
        "التموضع المشترك مخصص فقط للجداول المرجعية المنسوخة إلى كل العمّال"
      ],
      "correct": 1,
      "explanation": "يضمن التموضع المشترك أنه لقيمة مفتاح توزيع معينة (مثل account_id = 'acct-001')، يعيش صف accounts وكل صفوف transactions لذلك الحساب في الجزء نفسه على العامل نفسه. وهذا يتيح تنفيذ JOIN كاملًا على عامل واحد دون جولات شبكة بين العقد. وللتموضع المشترك، يجب توزيع الجدولين على المفهوم المنطقي نفسه (هنا: معرّف الحساب)، ويعطيهما Citus قيمة colocationid نفسها في pg_dist_partition. ودون تموضع مشترك، يتوزع JOIN على كل العمّال ويُجمّع في المنسّق."
    },
    {
      "text": "متى يجب أن تختار Citus بدل التجزئة على مستوى التطبيق لمنصة دفع؟",
      "options": [
        "دائمًا — Citus أفضل تمامًا في كل الأبعاد من التجزئة على مستوى التطبيق",
        "حين تتجاوز إنتاجية الكتابة سعة PostgreSQL الواحد (> 10,000 TPS كتابة)، وتكون الاستعلامات غالبًا محصورة في الحساب فتتيح تقليم الأجزاء، ويملك الفريق خبرة PostgreSQL لكنه يريد الحفاظ على SQL قياسي دون منطق توجيه مخصص في التطبيق",
        "فقط حين تخزن أكثر من 10TB من البيانات، بغض النظر عن أنماط الاستعلام أو إنتاجية الكتابة",
        "حين تتطلب الإقامة الجغرافية أن تعيش صفوف معينة في مراكز بيانات معينة — يتولى Citus ذلك تلقائيًا"
      ],
      "correct": 1,
      "explanation": "يكون Citus الاختيار الصحيح حين: (1) تتجاوز سعة الكتابة لـ PostgreSQL أحادي العقدة، (2) تكون أنماط استعلامك محصورة في الحساب فيعمل تقليم الأجزاء، (3) تريد تجنب زرع منطق التجزئة في كل خدمة. والتجزئة على مستوى التطبيق مفضلة حين يجب أن تعيش الأجزاء في عناقيد أو محركات مستقلة، أو حين تحتاج وضعًا جغرافيًا دقيقًا تحت سيطرتك، أو حين يملك الفريق أصلًا بنية تحتية للتجزئة على مستوى التطبيق. والميزة الأساسية لـ Citus الشفافية — يعمل SQL القياسي دون تغيير، وتُعالج الاستعلامات عبر الأجزاء (وإن كانت أبطأ) تلقائيًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "استراتيجية توزيع Citus لأحمال الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "صمم استراتيجية التوزيع لمنصة دفع بهذه الجداول: accounts، وtransactions، وledger_entries، وsettlement_batches، وfee_schedules. ولكل جدول، اختر بين: موزع (وعلى أي عمود)، أو جدول مرجعي، أو جدول محلي. وبرّر كل اختيار بالإشارة إلى: أنماط الاستعلام، ومتطلبات الربط، وتكرار الكتابة، وحجم البيانات. وحدد أي مخاطر ربط عبر الأجزاء في تصميمك."},
    {"id": "2", "description": "باستخدام عنقود Citus محلي (Docker Compose بمنسّق واحد + عاملين)، أظهر تقليم الأجزاء: أدرج 1,000,000 صف معاملة موزعة على account_id. وشغّل EXPLAIN على استعلام بشرط account_id وتحقق من 'Task Count: 1' (جزء واحد). وشغّل EXPLAIN على استعلام دون account_id وتحقق من استعلام كل الأجزاء. وقِس فرق الزمن بين نمطي الاستعلام."},
    {"id": "3", "description": "نفّذ تحويل أموال عبر الأجزاء باستخدام نمط Saga بدل 2PC. ويجب أن تقوم الـ Saga بما يلي: (1) خصم الحساب المصدر، (2) نشر حدث TransferInitiated، (3) إضافة المبلغ للحساب الوجهة، (4) نشر حدث TransferCompleted. ونفّذ المعاملة التعويضية لكل خطوة. واكتب اختبارًا يحاكي فشلًا بين الخطوتين 2 و3 ويتحقق من أن الـ Saga تعوّض بشكل صحيح بعكس الخصم."},
    {"id": "4", "description": "قِس إنتاجية الكتابة لعنقود Citus مقابل نسخة PostgreSQL واحدة باستخدام سكربت pgbench مخصص يحاكي خصومات الدفع على جدول transactions. وسجّل TPS عند 50 و100 و200 عميل متزامن للإعدادين. ووثّق نقطة التقاطع التي يتفوق فيها Citus على PostgreSQL أحادي العقدة، وحدد أي تراجع في الزمن يسببه عبء منسّق Citus."}
  ]
}
-->
