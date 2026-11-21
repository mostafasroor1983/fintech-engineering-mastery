---
id: track-05-lesson-12
sequence: 12
title: "منع التكرار (Idempotency) — أنماط التصميم والتنفيذ"
slug: idempotency-patterns
track: track-05
difficulty: advanced
estimatedMinutes: 85
status: published
tags: [idempotency, idempotency-key, UNIQUE-constraint, Redis, distributed-idempotency]
java-versions: [17, 21]
---

# أنماط الـ Idempotency — HTTP وقاعدة البيانات والرسائل

## نظرة عامة

الـ Idempotency ضمان تعاقدي بأن تقديم عملية متطابقة عدة مرات ينتج النتيجة نفسها بالضبط كتقديمها مرة واحدة. وفي أنظمة الدفع هذا الضمان ليس ميزة للراحة — بل متطلب صحة. فكل مسار إعادة محاولة، وكل انتهاء مهلة شبكة، وكل إعادة تسليم في Kafka تكرار محتمل، ودون idempotency يدفع العميل مرتين. يغطي هذا الدرس الـ idempotency بدقة: التعريف الرياضي، والطبقات الثلاث التي يجب فرضها فيها (HTTP، وقاعدة البيانات، والرسائل)، وكيف يتعامل مخزن Redis موزع مع حالات السباق، وكيف تختبر الـ idempotency تحت التزامن.

## أهداف التعلم

في نهاية هذا الدرس ستستطيع:

- ذكر التعريف الرياضي الدقيق للـ idempotency وشرح لماذا ينطبق على كل طبقة في منظومة الدفع.
- تنفيذ `IdempotencyFilter` على طبقة HTTP باستخدام `SET NX` في Redis مع مدة صلاحية، وشرح ما يحدث عند إخفاق الكاش مقابل إصابته.
- تصميم حارس idempotency على طبقة قاعدة البيانات باستخدام قيد `UNIQUE` و`INSERT … ON CONFLICT DO NOTHING RETURNING`.
- ضبط الـ idempotency في منتج Kafka ‏(`enable.idempotence=true`) وتنفيذ إزالة التكرار في جانب المستهلك عبر جدول `processed_events`.
- شرح لماذا قد يضيع حجز `SET NX` في Redis عند التحول (failover) بسبب النسخ غير المتزامن، ولماذا يجب أن تبقى قاعدة البيانات الحَكَم النهائي.
- كتابة اختبار تكامل متزامن يقدم الدفعة نفسها ثلاث مرات في آن واحد ويؤكد أن الأثر الجانبي حدث مرة واحدة بالضبط.

## سياق العمل

**حادث تحويل مكرر (مثال مركّب، مبني على نمط شائع)**

يتعرض بنك رقمي أوروبي لحادث إنتاج تسببت فيه عاصفة إعادات محاولة في جانب العميل — أطلقها انتهاء مهلة شبكة بعد 30 ثانية — في معالجة 847 طلب تحويل دفع مرتين. وبلغ مجموع المدفوعات المكررة 1.2 مليون يورو. وتطلب التعافي عكسًا يدويًا، وثلاثة أيام من عمل المطابقة، وتقرير حادث إلى الجهة الرقابية.

حدد تحليل السبب الجذري ثلاثة ضوابط مفقودة:

1. لا مفتاح idempotency على نقطة `/transfers`. فعوملت كل إعادة محاولة HTTP كطلب جديد.
2. لا قيد `UNIQUE` على جدول `payment_requests`. فاعتمد التطبيق فقط على إزالة التكرار على مستوى التطبيق، التي فشلت تحت إعادات المحاولة المتزامنة.
3. لم يكن لدى مستهلك Kafka إزالة تكرار في جانبه. فتسبب تحول وسيط في إعادة تسليم الرسائل (وهو ما يسمح به التسليم مرة واحدة على الأقل دائمًا)، فعالجها المستهلك مرة ثانية.

كانت الثغرات الثلاث قابلة للاستغلال كل منها مستقلة. ويغطي هذا الدرس الإصلاحات الثلاثة.

> [!IMPORTANT]
> تحت الحمل العادي تكون إعادات المحاولة جزءًا صغيرًا من استدعاءات واجهة الدفع، لكنها قد تقفز بحدة أثناء حوادث البنية التحتية — بالضبط حين تكون الأنظمة مجهدة أصلًا. فيجب أن تتعامل طبقة الـ idempotency لديك مع الحالة المستقرة وحالة القفزة كلتيهما دون تدهور الزمن.

## 1. التعريف الدقيق

تكون الدالة `f` idempotent إذا وفقط إذا:

```
f(f(x)) = f(x)   for all x in the domain of f
```

في HTTP تعني الـ idempotency أن تكرار الطلب له الأثر نفسه على الخادم كإرساله مرة. و`GET` و`PUT` و`DELETE` معرّفة بأنها idempotent؛ أما `POST` فلا. ولعمليات الدفع نجعل `POST /payments` يتصرف بشكل idempotent بالاعتماد على مفتاح idempotency يقدمه العميل. والعقد:

- مفتاح الـ idempotency نفسه + جسم الطلب نفسه ← الرد نفسه، والأثر الجانبي يُنفذ مرة واحدة على الأكثر.
- مفتاح الـ idempotency نفسه + جسم طلب مختلف ← `422 Unprocessable Entity` (كشف التعارض).
- مفتاح idempotency مختلف ← تنفيذ جديد.

> [!NOTE]
> يعرّف RFC 9110 (الذي حل محل RFC 7231 في 2022) الـ idempotency لطرق HTTP لكنه لا يقدم آلية لجعل `POST` idempotent. ونشرت Stripe نمط ترويسة `Idempotency-Key`، وهو الآن معيار مقترح في IETF ‏(draft-ietf-httpapi-idempotency-key-header).

## 2. مفتاح الـ Idempotency

يولّد العميل UUID v4 قبل المحاولة الأولى ويرسله كترويسة طلب:

```
POST /api/v1/payments
Idempotency-Key: 7f3c2a1e-4b8d-4f9e-a1c2-3d5e7f9a0b2c
Content-Type: application/json

{ "amount": 10000, "currency": "GBP", "creditorAccount": "GB29NWBK..." }
```

يخزن الخادم المفتاح مع:
- تجزئة SHA-256 لجسم الطلب (لكشف عدم تطابق الجسم عند إعادة التشغيل).
- الرد المتسلسل (رمز الحالة + الجسم).
- مدة صلاحية 24 ساعة (تستخدم Stripe ‏24 ساعة؛ واضبطها حسب نافذة اتفاقية الخدمة لديك).

وفي طلب لاحق بالمفتاح نفسه يعيد الخادم الرد المخزن فورًا، دون إعادة تنفيذ أي منطق عمل.

```java
// IdempotencyKeyGenerator.java — client side utility
public final class IdempotencyKeyGenerator {

    private IdempotencyKeyGenerator() {}

    /**
     * Generate a stable key for an operation. The caller should persist this
     * key and reuse it on every retry of the same logical operation.
     */
    public static String generate() {
        return UUID.randomUUID().toString();
    }

    /**
     * Deterministic key for a business operation — useful when the client
     * cannot persist state (e.g. a batch job replaying after a crash).
     * Derived ONLY from the stable business identity of the operation.
     * Never mix in the current date or time: a retry that runs after
     * midnight would get a new key and pay a second time.
     */
    public static String deterministic(String operationType, String businessId) {
        String seed = operationType + ":" + businessId;   // e.g. "payroll-line:2026-11-batch7:row42"
        return UUID.nameUUIDFromBytes(seed.getBytes(StandardCharsets.UTF_8)).toString();
    }
}
```

يُشتق المفتاح الحتمي فقط من الهوية التجارية الثابتة للعملية. ولا تخلط أبدًا التاريخ أو الوقت الحالي: فإعادة المحاولة التي تعمل بعد منتصف الليل ستحصل على مفتاح جديد وتدفع مرة ثانية.

## 3. الطبقة 1 — مرشّح الـ Idempotency على HTTP

يعترض المرشّح كل طلب مغيّر قبل أن يصل إلى المتحكم. ويستخدم `SET key value EX seconds NX` في Redis — أمرًا ذريًا واحدًا يضبط المفتاح فقط إذا لم يكن موجودًا.

```java
// IdempotencyFilter.java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class IdempotencyFilter extends OncePerRequestFilter {

    private static final String HEADER          = "Idempotency-Key";
    private static final Duration TTL           = Duration.ofHours(24);
    private static final String PREFIX          = "idmp:";

    private final StringRedisTemplate redis;
    private final ObjectMapper        mapper;

    public IdempotencyFilter(StringRedisTemplate redis, ObjectMapper mapper) {
        this.redis  = redis;
        this.mapper = mapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {

        // Only intercept state-mutating methods
        if (!isMutating(request.getMethod())) {
            chain.doFilter(request, response);
            return;
        }

        String idempotencyKey = request.getHeader(HEADER);
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            response.sendError(HttpServletResponse.SC_BAD_REQUEST,
                    "Idempotency-Key header is required");
            return;
        }

        if (!isValidUuid(idempotencyKey)) {
            // RETURN after sending the error — otherwise the request would
            // still be processed
            response.sendError(HttpServletResponse.SC_BAD_REQUEST,
                    "Idempotency-Key must be a valid UUID");
            return;
        }

        // Scope the key to the authenticated client: two clients that happen to
        // send the same key must never see each other's stored responses
        String redisKey = PREFIX + clientId(request) + ":" + idempotencyKey;

        // Try to claim the key — NX means "only if not exists"
        Boolean claimed = redis.opsForValue()
                .setIfAbsent(redisKey, "PROCESSING", TTL);

        if (Boolean.FALSE.equals(claimed)) {
            // Key already exists — either PROCESSING or a completed response
            String stored = redis.opsForValue().get(redisKey);

            if ("PROCESSING".equals(stored)) {
                // Another thread is mid-flight — return 409 so client backs off
                response.setStatus(HttpStatus.CONFLICT.value());
                response.getWriter().write("{\"error\":\"request_in_progress\"}");
                return;
            }

            // Stored value is a serialised CachedResponse
            CachedResponse cached = mapper.readValue(stored, CachedResponse.class);
            replayResponse(cached, response);
            return;
        }

        // We own the key — wrap the response to capture it
        ContentCachingResponseWrapper wrapper =
                new ContentCachingResponseWrapper(response);
        try {
            chain.doFilter(request, wrapper);
            wrapper.copyBodyToResponse();

            if (wrapper.getStatus() >= 500) {
                // Server error: the outcome may be unknown — do not cache it as
                // final. Release the key; the database layer still prevents a
                // second execution if the first one actually committed.
                redis.delete(redisKey);
                return;
            }
            // Serialise and store the completed response, replacing PROCESSING
            byte[] body    = wrapper.getContentAsByteArray();
            CachedResponse cached = new CachedResponse(
                    wrapper.getStatus(), body, wrapper.getContentType());
            redis.opsForValue().set(redisKey, mapper.writeValueAsString(cached), TTL);

        } catch (Exception ex) {
            // On failure, remove the key so the client can retry
            redis.delete(redisKey);
            throw ex;
        }
    }

    private void replayResponse(CachedResponse cached, HttpServletResponse response)
            throws IOException {
        response.setStatus(cached.status());
        response.setContentType(cached.contentType());
        response.getOutputStream().write(cached.body());
    }

    private boolean isMutating(String method) {
        return "POST".equalsIgnoreCase(method)
                || "PUT".equalsIgnoreCase(method)
                || "PATCH".equalsIgnoreCase(method);
    }

    private boolean isValidUuid(String key) {
        try {
            UUID.fromString(key);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    public record CachedResponse(int status, byte[] body, String contentType) {}
}
```

يجب **العودة** بعد إرسال خطأ صيغة المفتاح — وإلا سيُعالج الطلب مع ذلك. ويُحدد نطاق المفتاح بالعميل الموثَّق: فعميلان يرسلان صدفة المفتاح نفسه يجب ألا يرى أحدهما الردود المخزنة للآخر أبدًا. وخطأ الخادم (5xx) قد تكون نتيجته مجهولة، فلا يُخزن كنهائي: يُحرر المفتاح، وما زالت طبقة قاعدة البيانات تمنع تنفيذًا ثانيًا إذا كان الأول قد التزم فعلًا.

> [!WARNING]
> لنمط الكتابة على خطوتين أعلاه (`PROCESSING` ثم القيمة النهائية) نافذة صغيرة يرى فيها طلب متزامن `PROCESSING` فيتلقى 409. ويجب أن يتعامل العملاء مع 409 بتراجع قصير (200 مللي ثانية). وهذا أفضل من السماح بتنفيذين متزامنين.

## 4. الطبقة 2 — الـ Idempotency في قاعدة البيانات

يتعامل مرشّح HTTP مع الحالة الشائعة. ولديمومة عبر إعادات تشغيل الخادم (إخلاء Redis، وإعادة تدوير الحاويات)، توفر قاعدة البيانات ضمانًا ثانيًا.

```sql
-- Schema
CREATE TABLE payment_requests (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key   UUID        NOT NULL,
    request_hash      CHAR(64)    NOT NULL,   -- SHA-256 of canonical request body
    status            TEXT        NOT NULL DEFAULT 'PENDING',
    response_body     JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,

    CONSTRAINT uq_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX idx_payment_requests_created ON payment_requests (created_at);
```

تستخدم طبقة الخدمة `INSERT … ON CONFLICT DO NOTHING RETURNING`. فإذا أدرج طلب متزامن بالمفتاح نفسه لكنه لم يلتزم بعد، يجعل PostgreSQL الإدراج الثاني ينتظره — فيرى مسار التكرار دائمًا الصف الملتزم. وخزّن الرد في المعاملة نفسها مع عمل العمل، فيكون للصف الملتزم رده دائمًا:

```java
// PaymentRequestRepository.java
@Repository
public class PaymentRequestRepository {

    private final JdbcTemplate jdbc;

    public PaymentRequestRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Attempt to insert a new payment request record.
     * Returns the existing record's id if the idempotency key was already used.
     */
    public IdempotencyResult upsertRequest(UUID idempotencyKey,
                                           String requestHash) {
        // Returns the id of the newly inserted row, or empty on conflict
        List<UUID> inserted = jdbc.query(
            """
            INSERT INTO payment_requests (idempotency_key, request_hash)
            VALUES (?, ?)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
            """,
            (rs, row) -> (UUID) rs.getObject("id"),
            idempotencyKey, requestHash
        );

        if (!inserted.isEmpty()) {
            return IdempotencyResult.newRequest(inserted.get(0));
        }

        // Conflict — fetch the existing record
        PaymentRequest existing = jdbc.queryForObject(
            """
            SELECT id, request_hash, status, response_body
            FROM payment_requests
            WHERE idempotency_key = ?
            """,
            this::mapRow, idempotencyKey
        );

        // Guard against body mismatch (different request, same key)
        if (!requestHash.equals(existing.requestHash())) {
            throw new IdempotencyConflictException(
                "Idempotency key reused with a different request body");
        }

        return IdempotencyResult.duplicate(existing);
    }

    private PaymentRequest mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new PaymentRequest(
            (UUID) rs.getObject("id"),
            rs.getString("request_hash"),
            rs.getString("status"),
            rs.getString("response_body")
        );
    }
}

public sealed interface IdempotencyResult {
    record NewRequest(UUID requestId)             implements IdempotencyResult {}
    record Duplicate(PaymentRequest existing)     implements IdempotencyResult {}

    static IdempotencyResult newRequest(UUID id)        { return new NewRequest(id); }
    static IdempotencyResult duplicate(PaymentRequest p){ return new Duplicate(p); }
}
```

```java
// PaymentService.java (excerpt)
@Service
@Transactional
public class PaymentService {

    public PaymentResponse createPayment(CreatePaymentRequest request,
                                         UUID idempotencyKey) {

        String requestHash = sha256(request);
        IdempotencyResult result =
                paymentRequestRepo.upsertRequest(idempotencyKey, requestHash);

        return switch (result) {
            case IdempotencyResult.NewRequest(UUID requestId) ->
                    executePayment(requestId, request);
            case IdempotencyResult.Duplicate(PaymentRequest existing) ->
                    deserialiseResponse(existing.responseBody());
        };
    }

    private String sha256(Object obj) {
        try {
            // Canonical JSON (fixed field order, e.g. ORDER_MAP_ENTRIES_BY_KEYS /
            // SORT_PROPERTIES_ALPHABETICALLY) — otherwise identical requests can hash differently
            byte[] bytes = canonicalMapper.writeValueAsBytes(obj);
            return Hex.encodeHexString(
                MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException("Failed to hash request", e);
        }
    }
}
```

## 5. الطبقة 3 — الـ Idempotency في Kafka

### جانب المنتج

```java
// KafkaProducerConfig.java
@Configuration
public class KafkaProducerConfig {

    @Bean
    public ProducerFactory<String, String> producerFactory(KafkaProperties props) {
        Map<String, Object> config = new HashMap<>(props.buildProducerProperties());

        // Idempotent producer: deduplicates within a single producer session.
        // Requires acks=all and retries > 0.
        config.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        config.put(ProducerConfig.ACKS_CONFIG, "all");
        config.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        config.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);

        return new DefaultKafkaProducerFactory<>(config);
    }
}
```

> [!NOTE]
> يزيل `enable.idempotence=true` التكرار فقط داخل جلسة المنتج نفسها (الحقبة نفسها). وبعد إعادة تشغيل المنتج يسند الوسيط PID جديدًا، ولا تُرشّح الرسائل المكررة من قبل إعادة التشغيل. فما زالت إزالة التكرار في جانب المستهلك مطلوبة.

### جانب المستهلك

```sql
-- Processed events deduplication table
CREATE TABLE processed_events (
    event_id    UUID        PRIMARY KEY,
    topic       TEXT        NOT NULL,
    partition   INT         NOT NULL,
    offset_val  BIGINT      NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the archival job that purges old rows.
-- (A partial index "WHERE processed_at > NOW() - ..." is not allowed:
--  index predicates may only use IMMUTABLE functions, and NOW() is not.)
CREATE INDEX idx_processed_events_processed_at
    ON processed_events (processed_at);
```

```java
// IdempotentPaymentEventConsumer.java
@Component
public class IdempotentPaymentEventConsumer {

    private static final Logger log =
            LoggerFactory.getLogger(IdempotentPaymentEventConsumer.class);

    private final JdbcTemplate   jdbc;
    private final PaymentService paymentService;

    @KafkaListener(topics = "payment-commands", groupId = "payment-processor")
    // The DATABASE transaction manager: the dedup insert and the payment commit
    // together. (A KafkaTransactionManager does not cover JDBC.) The container
    // commits the offset after this method returns, i.e. after the DB commit.
    @Transactional
    public void consume(ConsumerRecord<String, String> record) {
        UUID eventId = extractEventId(record);

        // Atomic insert — if the row already exists, do nothing
        int inserted = jdbc.update(
            """
            INSERT INTO processed_events (event_id, topic, partition, offset_val)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (event_id) DO NOTHING
            """,
            eventId, record.topic(),
            record.partition(), record.offset()
        );

        if (inserted == 0) {
            log.info("Skipping duplicate event {}", eventId);
            return;
        }

        PaymentCommand command = deserialise(record.value());
        paymentService.executeCommand(command);
    }

    private UUID extractEventId(ConsumerRecord<String, String> record) {
        // Event ID is embedded in the message header by the producer
        Header header = record.headers().lastHeader("event-id");
        if (header == null) {
            throw new IllegalArgumentException(
                "Missing event-id header on record " + record.offset());
        }
        return UUID.fromString(new String(header.value(), StandardCharsets.UTF_8));
    }
}
```

يُستخدم مدير معاملات **قاعدة البيانات**: فإدراج إزالة التكرار والدفعة يلتزمان معًا (ولا يغطي `KafkaTransactionManager` JDBC). وتلتزم الحاوية بالإزاحة بعد عودة الدالة، أي بعد التزام قاعدة البيانات.

## 6. مخزن Idempotency موزع وحالات السباق

أمر `SET key value EX seconds NX` في Redis ذري على عقدة Redis واحدة، وفي Redis Cluster يعيش كل مفتاح على خادم رئيسي واحد بالضبط في وقت واحد، فيبقى `NX` ذريًا لكل مفتاح.

الثغرة الحقيقية هي **التحول (failover)**. فـ Redis ينسخ إلى نسخه الاحتياطية **بشكل غير متزامن**. فإذا أقرّ الخادم الرئيسي بـ `SET idmp:abc PROCESSING NX` ثم تعطل قبل أن تصل تلك الكتابة إلى نسخة احتياطية، فالنسخة المرقّاة لم ترَ المفتاح قط — فينجح `SET NX` لإعادة محاولة مجددًا. والنافذة صغيرة لكنها حقيقية (يستطيع `WAIT` تضييقها لا إغلاقها). ولهذا لا يكون Redis إلا الطبقة الأولى السريعة؛ ويجب أن يكون قيد `UNIQUE` في قاعدة البيانات الحَكَم النهائي.

```java
// RedisIdempotencyStore.java
@Component
public class RedisIdempotencyStore {

    private final RedisTemplate<String, String> redis;

    private static final String PROCESSING_SENTINEL = "__PROCESSING__";
    private static final Duration TTL = Duration.ofHours(24);
    private static final String  NS  = "idmp:v1:";

    public ClaimResult claim(String idempotencyKey) {
        String key     = NS + idempotencyKey;
        Boolean claimed = redis.opsForValue()
                .setIfAbsent(key, PROCESSING_SENTINEL, TTL);

        if (Boolean.TRUE.equals(claimed)) {
            return ClaimResult.CLAIMED;
        }

        String value = redis.opsForValue().get(key);
        if (PROCESSING_SENTINEL.equals(value)) {
            return ClaimResult.IN_PROGRESS;
        }
        return ClaimResult.DUPLICATE;
    }

    public void storeResult(String idempotencyKey, String serialisedResponse) {
        // Overwrite the PROCESSING sentinel with the actual response.
        // Keep the original TTL by using GETSET + EXPIREAT, or simply
        // accept a refreshed TTL with SET EX (simpler, acceptable trade-off).
        redis.opsForValue().set(NS + idempotencyKey,
                serialisedResponse, TTL);
    }

    public Optional<String> getStoredResult(String idempotencyKey) {
        String value = redis.opsForValue().get(NS + idempotencyKey);
        if (value == null || PROCESSING_SENTINEL.equals(value)) {
            return Optional.empty();
        }
        return Optional.of(value);
    }

    public enum ClaimResult { CLAIMED, IN_PROGRESS, DUPLICATE }
}
```

> [!WARNING]
> لمتطلبات الاتساق القصوى (أنظمة تسوية البنوك المركزية)، استبدل Redis بمخزن idempotency مدعوم بقاعدة بيانات. فقيد `UNIQUE` على جدول PostgreSQL يعطي ضمانًا دائمًا ومعاملاتيًا عند أي مستوى عزل — أقوى من Redis، بكلفة زمن أعلى.

## 7. الـ Idempotency للعمليات ذات الآثار الجانبية الخارجية

عندما تستدعي خدمتك واجهة لاحقة (شبكة بطاقات، أو بوابة SWIFT)، يجب أن يكون ذلك الاستدعاء اللاحق idempotent أيضًا. فمرر مفتاح الـ idempotency لديك إلى الأسفل:

```java
// ExternalProcessorClient.java
@Component
public class ExternalProcessorClient {

    private final RestClient restClient;

    public ProcessorResponse submit(PaymentOrder order, UUID idempotencyKey) {
        return restClient.post()
                .uri("/v1/payments")
                .header("Idempotency-Key", idempotencyKey.toString())
                .body(order)
                .retrieve()
                .body(ProcessorResponse.class);
    }
}
```

**عندما لا تدعم الواجهة الخارجية مفاتيح الـ idempotency:**

1. **احجز أولًا:** أدرج سجلًا بحالة `PENDING` بمفتاح الـ idempotency لديك (`ON CONFLICT DO NOTHING`) والتزم به *قبل* الاستدعاء. ولا يجوز أن يستدعي النظام الخارجي إلا الطلب الفائز بالحجز.
2. استدعِ، ثم خزّن النتيجة مقابل ذلك السجل.
3. إذا وجدت سجلًا ما زال `PENDING` (حدث تعطل أو انتهاء مهلة بعد الاستدعاء)، فالنتيجة **مجهولة**: استعلم النظام الخارجي عن المعاملة قبل أي شيء آخر — ولا تستدعه مجددًا أعمى أبدًا.

```java
// ExternalCallGuard.java — wraps non-idempotent external APIs
// NOT @Transactional around the HTTP call: each step commits on its own
@Component
@RequiredArgsConstructor
public class ExternalCallGuard {

    private final ExternalCallRecordRepository records;
    private final ExternalProcessorClient      client;

    public ProcessorResponse submitOnce(PaymentOrder order, UUID idempotencyKey) {

        // 1. Claim (own short transaction): INSERT ... ON CONFLICT DO NOTHING
        boolean claimed = records.claimPending(idempotencyKey);
        if (!claimed) {
            ExternalCallRecord existing = records.findByIdempotencyKey(idempotencyKey).orElseThrow();
            if (existing.isCompleted()) {
                return existing.response();
            }
            // PENDING: another attempt is in flight or crashed mid-call —
            // the outcome is unknown, so ask the external system first
            throw new OutcomeUnknownException(idempotencyKey);
        }

        // 2. Only the claim winner calls out
        ProcessorResponse response = client.submit(order, idempotencyKey);

        // 3. Record the outcome (own short transaction). If we crash before this,
        //    the record stays PENDING and the reconciliation job queries the
        //    external system to find out what happened.
        records.complete(idempotencyKey, response);
        return response;
    }
}
```

## 8. اختبار الـ Idempotency تحت التزامن

```java
// IdempotencyIntegrationTest.java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class IdempotencyIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres =
            new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    static GenericContainer<?> redis =
            new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @Autowired
    private TestRestTemplate http;

    @Autowired
    private PaymentRepository paymentRepository;

    @Test
    void sameIdempotencyKey_concurrentRequests_sideEffectOccursOnce()
            throws InterruptedException {

        UUID idempotencyKey = UUID.randomUUID();
        HttpHeaders headers = new HttpHeaders();
        headers.set("Idempotency-Key", idempotencyKey.toString());
        headers.setContentType(MediaType.APPLICATION_JSON);

        String body = """
                {"amount": 5000, "currency": "GBP",
                 "creditorAccount": "GB29NWBK60161331926819"}
                """;
        HttpEntity<String> entity = new HttpEntity<>(body, headers);

        int concurrency    = 3;
        CountDownLatch latch    = new CountDownLatch(concurrency);
        List<ResponseEntity<String>> responses =
                Collections.synchronizedList(new ArrayList<>());

        ExecutorService pool = Executors.newFixedThreadPool(concurrency);

        for (int i = 0; i < concurrency; i++) {
            pool.submit(() -> {
                try {
                    ResponseEntity<String> r = http.exchange(
                            "/api/v1/payments", HttpMethod.POST,
                            entity, String.class);
                    responses.add(r);
                } finally {
                    latch.countDown();
                }
            });
        }

        latch.await(10, TimeUnit.SECONDS);
        pool.shutdown();

        // Requests that overlapped the first one may get 409 "in progress";
        // every other response must be the ORIGINAL response
        assertThat(responses).hasSize(concurrency);
        List<ResponseEntity<String>> completed = responses.stream()
                .filter(r -> r.getStatusCode() != HttpStatus.CONFLICT).toList();
        assertThat(completed).isNotEmpty();
        String originalBody = completed.get(0).getBody();
        for (ResponseEntity<String> r : completed) {
            assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
            assertThat(r.getBody()).isEqualTo(originalBody);
        }

        // A retry now (after completion) replays the original response
        ResponseEntity<String> retry = http.exchange(
                "/api/v1/payments", HttpMethod.POST, entity, String.class);
        assertThat(retry.getBody()).isEqualTo(originalBody);

        // The payment must have been created exactly once
        long paymentCount = paymentRepository
                .countByIdempotencyKey(idempotencyKey);
        assertThat(paymentCount).isEqualTo(1);
    }
}
```

الطلبات التي تداخلت مع الأول قد تتلقى 409 "قيد التنفيذ"؛ وكل رد آخر يجب أن يكون الرد **الأصلي**، وإعادة المحاولة بعد الاكتمال تعيد تشغيل الرد الأصلي.

## اختبار المعرفة

**س1: يرسل عميل طلب `POST /payments` بـ `Idempotency-Key: abc-123`. ويعالج الخادم الدفعة بنجاح ويخزن النتيجة في Redis. وبعد عشرين دقيقة يعيد العميل المحاولة بالمفتاح نفسه. وقد أُخلي Redis (سياسة نفاد الذاكرة `allkeys-lru`). ماذا يحدث؟**

ج: يُخفق البحث في Redis ‏(`null`). فيمضي المرشّح كأنه طلب جديد. ويلتقط حارس طبقة قاعدة البيانات التكرار عبر قيد `UNIQUE (idempotency_key)` ويعيد الرد المخزن. ولهذا تحتاج الطبقتين: Redis للسرعة، وقاعدة البيانات للديمومة. وإذا كانت نافذة مدة الصلاحية أقصر من اتفاقية الخدمة لأهلية إعادة المحاولة، تدافع قاعدة البيانات أيضًا ضد إعادات التشغيل بعد انتهاء الصلاحية.

**س2: ضُبط `enable.idempotence=true` على منتج Kafka لديك. ويسبب انقسام شبكة إعادة تشغيل المنتج. وبعد إعادة التشغيل يعيد محاولة آخر دفعة رسائل. هل يرشّح الوسيط التكرارات؟**

ج: لا. يزيل `enable.idempotence=true` التكرار داخل جلسة منتج واحدة (يعرّفها معرّف منتج يُسند عند البدء). وبعد إعادة التشغيل يحصل المنتج غير المعاملاتي على PID جديد. (والمنتج المعاملاتي الذي يعيد استخدام `transactional.id` يحتفظ بهويته، لكن ذلك ما زال يغطي كتابات Kafka فقط.) ولا يملك الوسيط طريقة لمطابقة PID الجديد بأرقام تسلسل الجلسة السابقة. فإزالة التكرار في جانب المستهلك باستخدام جدول `processed_events` إلزامية للتعامل مع التكرارات عبر الجلسات.

## التحدي العملي

**الهدف**: نفّذ منظومة idempotency كاملة من ثلاث طبقات وتحقق منها باختبار فوضى.

1. **طبقة HTTP**: انشر `IdempotencyFilter` المدعوم بـ Redis. وأضف عداد مقياس `idempotency.hits` (يزيد عند إصابة الكاش) و`idempotency.misses` (يزيد عند إخفاقه) باستخدام Micrometer.

2. **طبقة قاعدة البيانات**: أضف جدول `payment_requests` بقيد `UNIQUE (idempotency_key)`. واكتب `PaymentRequestRepository.upsertRequest` تستخدم `INSERT … ON CONFLICT DO NOTHING RETURNING` وتتحقق من تجزئة الطلب.

3. **طبقة Kafka**: اضبط المستهلك ليدرج في `processed_events` قبل المعالجة. وتحقق عبر اختبار يحقن رسالة مكررة بعد أن التزم المستهلك.

4. **اختبار الفوضى**: اكتب اختبار JUnit 5:
   - يقدم الدفعة نفسها 50 مرة بالتزامن باستخدام مجمع `CompletableFuture`.
   - يؤكد وجود صف دفع واحد بالضبط في قاعدة البيانات.
   - يؤكد أن كل رد HTTP إما الرد الأصلي أو `409 request_in_progress`، وأن إعادة محاولة ردود 409 بعد الاكتمال تعيد الرد الأصلي.
   - يؤكد أن `idempotency.misses` يساوي 1 (طلب واحد فقط يحجز المفتاح أبدًا).

5. **هدف إضافي**: نفّذ مهمة تنظيف ليلية (`@Scheduled(cron = "0 2 * * *")`) تحذف صفوف `payment_requests` الأقدم من 24 ساعة وتنظف مفاتيح Redis المقابلة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يرسل عميل POST /payments بـ Idempotency-Key: abc-123. ويعالج الخادم الدفعة ويخزن النتيجة في Redis بمدة صلاحية 24 ساعة. ثم يُخلي Redis المفتاح تحت ضغط الذاكرة allkeys-lru. ويعيد العميل المحاولة بعد ساعتين بالمفتاح نفسه. ما الذي يمنع الدفعة المكررة؟",
      "options": [
        "مدة صلاحية Redis تمنع معالجة إعادة المحاولة لأن المفتاح اختفى",
        "يلتقط قيد UNIQUE على idempotency_key في قاعدة البيانات التكرار عبر INSERT ... ON CONFLICT DO NOTHING، فيعيد الرد المخزن",
        "يعيد مرشّح HTTP الرد 409 لأن Redis يعيد null",
        "تُرفض إعادة المحاولة لأن عنوان IP نفسه للعميل أرسل هذا الطلب بالفعل"
      ],
      "correct": 1,
      "explanation": "يسبب إخلاء Redis إخفاقًا في كاش مرشّح HTTP، فيمضي كأنه طلب جديد. وطبقة قاعدة البيانات هي السند الدائم: يلتقط قيد UNIQUE(idempotency_key) على payment_requests التكرار. فلا يعيد الإدراج صفوفًا (تعارض)، فينطلق مسار التكرار الذي يعيد الرد المخزن. ولهذا تلزم الطبقتان: Redis للسرعة، وقاعدة البيانات للديمومة عبر الإخلاءات وإعادات التشغيل."
    },
    {
      "text": "ضُبط enable.idempotence=true على منتج Kafka. ويُعاد تشغيل المنتج بسبب فشل حاوية ويعيد محاولة آخر دفعة. هل يرشّح الوسيط الرسائل المعاد محاولتها كتكرارات؟",
      "options": [
        "نعم — يزيل enable.idempotence=true تكرار كل إعادات المحاولة عبر جلسات المنتج باستخدام معرّف منتج دائم مخزن في Kafka",
        "لا — يزيل enable.idempotence=true التكرار فقط داخل حقبة منتج واحدة؛ وإعادة التشغيل تسند PID جديدًا فلا يستطيع الوسيط مطابقة أرقام التسلسل عبر الجلسات",
        "نعم — دلالات التسليم مرة واحدة بالضبط في Kafka تضمن إزالة التكرار حتى عبر إعادات التشغيل",
        "لا — إزالة التكرار ممكنة فقط مع ضبط acks=0"
      ],
      "correct": 1,
      "explanation": "يسند enable.idempotence=true معرّف منتج (PID) عند البدء ويستخدم أرقام تسلسل لكل قسم لإزالة التكرار داخل تلك الجلسة. وبعد إعادة التشغيل يحصل المنتج غير المعاملاتي على PID جديد — فلا يستطيع الوسيط ربط تسلسلاته بالجلسة السابقة. فإزالة التكرار في جانب المستهلك باستخدام جدول processed_events إلزامية للتعامل مع التكرارات عبر الجلسات."
    },
    {
      "text": "تحجز خدمة دفع مفاتيح الـ idempotency بـ SET NX في Redis. ويُقرّ خادم Redis الرئيسي بـ SET idmp:abc PROCESSING NX، ثم يتعطل قبل نسخ الكتابة، وتُرقّى نسخة احتياطية. ما الخطر وما التخفيف الأكثر ديمومة؟",
      "options": [
        "قد ينجح SET NX لإعادة محاولة على الخادم الرئيسي الجديد، فيُسمح بتنفيذين للدفعة نفسها — ويُخفف بإبقاء قيد UNIQUE في قاعدة البيانات الحَكَم النهائي للـ idempotency",
        "يتلقى الطلبان كلاهما خطأ لأن عمليات NX محجوبة أثناء التحول",
        "يُنسخ المفتاح بشكل متزامن، فلا خطر",
        "طلب واحد فقط يستطيع النجاح لأن Redis Cluster يضمن NX ذريًا عبر كل العقد"
      ],
      "correct": 0,
      "explanation": "ينسخ Redis بشكل غير متزامن. فالكتابة التي أقرّها الخادم الرئيسي القديم ولم تُنسخ بعد تضيع عند ترقية نسخة احتياطية، فينجح SET NX لإعادة محاولة مجددًا ويمكن أن يبدأ تنفيذ ثانٍ. وقيد UNIQUE(idempotency_key) في قاعدة البيانات هو التخفيف الدائم: فحتى لو اجتاز طلبان طبقة Redis، لن ينجح إلا إدراج واحد."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ منظومة Idempotency من ثلاث طبقات واختبارها باختبار فوضى",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "انشر IdempotencyFilter المدعوم بـ Redis مع SET NX. وأضف عدادَي Micrometer: ‏idempotency.hits (يزيد عند إعادة تشغيل رد مخزن) وidempotency.misses (يزيد عند حجز المفتاح جديدًا). وأضف عدادًا ثالثًا idempotency.in_progress_conflicts لردود 409 عند مصادفة علامة PROCESSING."},
    {"id": "2", "description": "أضف جدول payment_requests بقيد UNIQUE(idempotency_key) وعمود request_hash CHAR(64). ونفّذ PaymentRequestRepository.upsertRequest باستخدام INSERT ... ON CONFLICT DO NOTHING RETURNING id. وأضف كشف عدم تطابق الجسم: إذا كان للصف المتعارض request_hash مختلف، ارمِ IdempotencyConflictException بحالة 422."},
    {"id": "3", "description": "اضبط مستهلك Kafka ليدرج في processed_events قبل معالجة كل رسالة، باستخدام ON CONFLICT (event_id) DO NOTHING. واكتب اختبار تكامل ينشر رسالة payment-commands، ثم يعيد نشر event_id نفسه يدويًا، ويؤكد أن الدفعة عولجت مرة واحدة بالضبط وأن processed_events يحتوي صفًا واحدًا بالضبط لذلك event_id."},
    {"id": "4", "description": "اكتب اختبار فوضى JUnit 5 يقدم الدفعة نفسها 50 مرة بالتزامن باستخدام CompletableFuture.allOf مع مجمع خيوط ثابت من 50. وأكد: صف دفع واحدًا بالضبط في قاعدة البيانات؛ وأن كل رد HTTP إما الرد الأصلي أو 409 request_in_progress؛ وأن إعادة المحاولة بعد الاكتمال تعيد الرد الأصلي؛ وأن idempotency.misses يساوي 1. ثم أخلِ مفتاح Redis بعد الطلب الأول وتحقق من أن طبقة قاعدة البيانات ما زالت تمنع أي دفعة ثانية."}
  ]
}
-->
