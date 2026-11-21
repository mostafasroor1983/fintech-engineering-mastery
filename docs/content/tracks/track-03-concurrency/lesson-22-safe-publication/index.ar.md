---
id: track-03-lesson-22
sequence: 22
title: "النشر الآمن للكائنات وبناؤها"
slug: safe-publication
track: track-03
difficulty: advanced
estimatedMinutes: 65
status: published
tags: [safe-publication, final-fields, constructor-safety, JMM]
java-versions: [17, 21]
---

# النشر الآمن للكائنات (Safe Publication)

## نظرة عامة

يكون الكائن "منشورًا بأمان" عندما يرى كل خيط يستطيع رؤية المرجع إليه أيضًا الحالة المهيأة بالكامل لحقوله. ودون النشر الآمن، قد يرى خيط آخر الكائن في حالة بناء جزئي — بحقول تحمل القيم الافتراضية صفر/null رغم أن المُنشئ "اكتمل". وهذا من أدق جوانب نموذج ذاكرة Java وأخطرها.

## أهداف التعلم

في نهاية هذا الدرس ستستطيع:

- شرح لماذا لا يكون بناء الكائن ونشره ذريين تلقائيًا في JMM
- تحديد أساليب النشر الآمن الأربعة وشرح ضمان JMM وراء كل منها
- التعرف على النمط المضاد لتسرب `this` وشرح لماذا يسبب رؤية بناء جزئي
- تطبيق الحقول `final` بشكل صحيح وفهم ضمانها الخاص في JMM
- تنفيذ نمط القفل مزدوج الفحص (double-checked locking) للكائن الوحيد بشكل صحيح مع `volatile`
- تصميم تهيئة كسولة آمنة للخيوط باستخدام أسلوب الصنف الحامل (holder) للتهيئة عند الطلب

## سياق العمل

تحمّل خدمة إعدادات المدفوعات جداول الرسوم وقواعد التوجيه عند البدء. وتُبنى كائنات الإعدادات مرة واحدة ثم تتشاركها مئات خيوط معالجة الدفع. فإذا لم يُنشر كائن الإعدادات بأمان، قد يرى خيط دفع `null` لجدول رسوم عُيّن في المُنشئ — فينتج `NullPointerException` أو، الأسوأ، تطبيق رسوم صفرية بصمت. وفهم النشر الآمن يمنع هذه الفئة من حوادث الإنتاج.

## ماذا يعني "النشر"؟

يُنشر الكائن عندما يصبح المرجع إليه مرئيًا لشيفرة خارج النطاق الذي بُني فيه. ويحدث النشر عندما:
- تخزن المرجع في حقل عام
- تعيده من طريقة
- تمرره إلى طريقة خيط آخر
- تخزنه في مجموعة مشتركة

الخطر: يسمح JMM لمترجم JIT وعتاد المعالج بإعادة ترتيب كتابات الذاكرة. فقد تُعاد كتابات حقول المُنشئ إلى ما بعد نشر المرجع. فيرى الخيط القارئ المرجع قبل أن يرى قيم الحقول.

```
Constructing thread                 Reading thread
─────────────────                   ─────────────
new FeeSchedule()
  field1 = data1          ─────────────────────────────► ref = FeeSchedule@abc
  field2 = data2    (reordered)      thread reads ref → sees FeeSchedule@abc
  ...                                thread reads field2 → sees null  ← BUG
publish ref = FeeSchedule@abc
  field1 write flush                 thread reads field1 → sees data1
```

## النشر غير الآمن: الأنماط المضادة

### مرجع قديم عبر حقل غير volatile

```java
public class ConfigCache {
    // No volatile — unsafe publication
    private FeeSchedule feeSchedule;

    // Thread 1: initialises at startup
    public void load() {
        feeSchedule = new FeeSchedule(loadFromDatabase());
    }

    // Thread 2: reads during payment processing
    public FeeSchedule get() {
        return feeSchedule;  // May see null, or a partially constructed object
    }
}
```

قد يرى الخيط 2 القيمة null، أو كائنًا مبنيًا جزئيًا.

### النمط المضاد لتسرب `this`

نشر `this` قبل اكتمال المُنشئ يسمح لخيوط أخرى برؤية كائن مهيأ جزئيًا:

```java
public class PaymentEventPublisher {

    private final EventBus eventBus;
    private final String   serviceId;

    public PaymentEventPublisher(EventBus eventBus, String serviceId) {
        this.eventBus  = eventBus;
        this.serviceId = serviceId;

        // DANGER: registering this before constructor completes
        // Another thread could call onEvent() before serviceId is set
        eventBus.register(this);  // ← this escapes before construction is done
    }

    public void onEvent(PaymentEvent event) {
        // serviceId might be null here if called from another thread
        // before the constructor finished
        log.info("Service {} received event {}", serviceId, event);
    }
}
```

ونقل `register(this)` إلى آخر سطر في المُنشئ **لا** يصلح المشكلة: فضمان الحقل `final` لا يصح إلا للخيوط التي تحصل على المرجع بعد انتهاء المُنشئ.

**الإصلاح:** سجّل المستمع بعد البناء:

```java
public class PaymentEventPublisher {
    private final EventBus eventBus;
    private final String   serviceId;

    private PaymentEventPublisher(EventBus eventBus, String serviceId) {
        this.eventBus  = eventBus;
        this.serviceId = serviceId;
    }

    public static PaymentEventPublisher create(EventBus bus, String serviceId) {
        PaymentEventPublisher pub = new PaymentEventPublisher(bus, serviceId);
        bus.register(pub);  // Register after full construction
        return pub;
    }
}
```

## أساليب النشر الآمن الأربعة

### 1. المُهيئ الساكن (Static Initialiser)

تضمن JVM اكتمال المهيئات الساكنة قبل أن يستخدم أي خيط الصنف. فتحتجز JVM **قفل تهيئة** خاصًا بكل صنف أثناء تشغيل المهيئ الساكن (JLS §12.4.2):

```java
public class FeeScheduleCache {
    // Guaranteed fully constructed before any thread can see the reference
    private static final FeeSchedule DEFAULT_SCHEDULE = new FeeSchedule(DEFAULT_FEES);
}
```

**ضمان JMM:** كتابات الحقول الساكنة في المهيئ الساكن تحدث-قبل (happens-before) أي وصول إلى ذلك الحقل الساكن. فلا حاجة إلى `volatile` ولا `synchronized`.

### 2. الحقول `final`

للحقول `final` ضمان خاص في JMM: بمجرد اكتمال المُنشئ، يُضمن لأي خيط يحصل على مرجع إلى الكائن أن يرى كل الحقول `final` مهيأة — حتى دون مزامنة:

```java
public final class PaymentRoute {
    private final String    routingCode;
    private final BigDecimal feePercent;
    private final List<String> allowedCurrencies;

    public PaymentRoute(String routingCode, BigDecimal feePercent,
                        List<String> allowedCurrencies) {
        this.routingCode       = routingCode;
        this.feePercent        = feePercent;
        // Defensive copy — the reference is final, not the contents
        this.allowedCurrencies = List.copyOf(allowedCurrencies);
    }

    // Getters — no synchronisation needed; all fields are final
    public String    getRoutingCode()       { return routingCode; }
    public BigDecimal getFeePercent()       { return feePercent; }
    public List<String> getAllowedCurrencies() { return allowedCurrencies; }
}
```

> [!IMPORTANT]
> يغطي ضمان الحقل `final` المرجع **و**كل ما يمكن الوصول إليه عبره **كما كان عند انتهاء المُنشئ** — فالقائمة التي مُلئت في المُنشئ تُرى بمحتواها. لكنه **لا** يغطي التغييرات اللاحقة: فإذا عدّل أحد `ArrayList` محفوظة في حقل `final` بعد البناء، فلا ضمان رؤية للقراء (و`ArrayList` ليست آمنة للخيوط أصلًا). لذا خزّن نسخًا غير قابلة للتغيير: `List.copyOf()` الأكثر أمانًا. (و`Collections.unmodifiableList()` مجرد عرض للقراءة فقط — من يحمل القائمة الأصلية ما زال يستطيع تغييرها.)

### 3. حقل `volatile`

النشر عبر حقل `volatile` ينشئ علاقة تحدث-قبل: الكتابة في `volatile` تحدث-قبل أي قراءة لذلك الحقل:

```java
public class ConfigCache {
    private volatile FeeSchedule feeSchedule;  // volatile = safe publication

    // Thread 1 — startup
    public void load() {
        FeeSchedule loaded = new FeeSchedule(loadFromDatabase());
        feeSchedule = loaded;  // volatile write — all prior writes are visible
    }

    // Thread 2 — payment processing
    public FeeSchedule get() {
        return feeSchedule;  // volatile read — sees fully constructed object or null
    }
}
```

**ضمان JMM:** الكتابة `volatile` في `feeSchedule` تحدث-قبل القراءة `volatile`. فكل الكتابات التي أجراها الخيط 1 قبل الكتابة `volatile` (بما فيها مُنشئ FeeSchedule) مرئية للخيط 2 بعد القراءة `volatile`.

### 4. كتلة متزامنة (synchronized)

تحرير قفل يحدث-قبل الحصول عليه. فالنشر داخل كتلة `synchronized` يضمن أن كل الكتابات قبل تحرير القفل مرئية لأي خيط يحصل لاحقًا على القفل نفسه:

```java
public class ConfigCache {
    private FeeSchedule feeSchedule;

    public synchronized void load() {
        feeSchedule = new FeeSchedule(loadFromDatabase());
        // Lock release here — all prior writes are flushed
    }

    public synchronized FeeSchedule get() {
        // Lock acquisition here — sees all writes before prior releases
        return feeSchedule;
    }
}
```

## القفل مزدوج الفحص: النمط الصحيح

تحسين شائع للكائنات الوحيدة الكسولة. ودون `volatile` يكون هذا النمط معطوبًا:

```java
// BROKEN — without volatile, the reference can be non-null but
// the object partially constructed (field writes reordered after publication)
public class PaymentGatewayClient {
    private static PaymentGatewayClient instance;  // Missing volatile!

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {
                    instance = new PaymentGatewayClient();  // Write can be reordered
                }
            }
        }
        return instance;  // May return partially constructed object
    }
}
```

**النمط الصحيح** — يمنع `volatile` إعادة ترتيب الإسناد ليسبق اكتمال المُنشئ:

```java
public class PaymentGatewayClient {
    private static volatile PaymentGatewayClient instance;  // volatile is mandatory

    private final String    endpoint;
    private final SSLContext sslContext;

    private PaymentGatewayClient() {
        this.endpoint   = Config.getGatewayEndpoint();
        this.sslContext = Config.buildSSLContext();
    }

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {                        // First check — no lock (fast path)
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {                // Second check — with lock
                    instance = new PaymentGatewayClient();
                }
            }
        }
        return instance;
    }
}
```

**لماذا يصلحه `volatile`:**
- الكتابة `volatile` في `instance` تحدث-قبل أي قراءة `volatile`
- لا تستطيع JVM نقل كتابات حقول المُنشئ إلى ما بعد الكتابة `volatile` في `instance`
- أي خيط يقرأ `instance != null` يُضمن له رؤية الكائن مبنيًا بالكامل

## أسلوب الصنف الحامل للتهيئة عند الطلب

مفضّل على القفل مزدوج الفحص — أبسط، وصحيح بحسب مواصفة JVM، ولا يحتاج `volatile`:

```java
public class PaymentGatewayClient {

    private PaymentGatewayClient() {
        // construction
    }

    // Loaded lazily when Holder class is first accessed
    // The JVM's class-loading lock guarantees exactly-once initialisation
    private static final class Holder {
        static final PaymentGatewayClient INSTANCE = new PaymentGatewayClient();
    }

    public static PaymentGatewayClient getInstance() {
        return Holder.INSTANCE;  // Class loaded on first call → static initialiser runs once
    }
}
```

**لماذا ينجح:** ‏`Holder.INSTANCE` حقل ساكن نهائي. وتهيئ JVM الصنف `Holder` في أول استدعاء لـ `getInstance()`، مستخدمة قفل تهيئة الصنف لضمان التنفيذ مرة واحدة بالضبط. وكتابات الحقول الساكنة في المهيئ تُنشر دائمًا بأمان لكل الخيوط.

> [!WARNING]
> إذا رمى المُنشئ استثناء، تعلّم JVM الصنف `Holder` على أنه **فاشل**: يتلقى المستدعي الأول `ExceptionInInitializerError` وكل استدعاء لاحق `NoClassDefFoundError` — ولا إعادة محاولة حتى تُعاد JVM. وللتهيئة التي قد تفشل (شبكة، أو قاعدة بيانات)، استخدم حقل `volatile` مع القفل مزدوج الفحص، الذي يستطيع إعادة المحاولة في الاستدعاء التالي.

## النشر الآمن عمليًا: إعدادات غير قابلة للتغيير

يجمع نمط النشر الآمن المثالي كل الضمانات:

```java
public final class PaymentConfiguration {

    private final String         gatewayUrl;
    private final int            connectTimeoutMs;
    private final int            readTimeoutMs;
    private final BigDecimal     maxTransactionAmount;
    private final Set<String>    supportedCurrencies;
    private final Map<String, BigDecimal> feesByCountry;

    public PaymentConfiguration(
            String         gatewayUrl,
            int            connectTimeoutMs,
            int            readTimeoutMs,
            BigDecimal     maxTransactionAmount,
            Set<String>    supportedCurrencies,
            Map<String, BigDecimal> feesByCountry) {

        // Validate in constructor — object is always valid when constructed
        if (gatewayUrl == null || gatewayUrl.isBlank())
            throw new IllegalArgumentException("gatewayUrl required");
        if (connectTimeoutMs <= 0 || readTimeoutMs <= 0)
            throw new IllegalArgumentException("Timeouts must be positive");

        this.gatewayUrl           = gatewayUrl;
        this.connectTimeoutMs     = connectTimeoutMs;
        this.readTimeoutMs        = readTimeoutMs;
        this.maxTransactionAmount = maxTransactionAmount;
        // Defensive copy + immutable wrapper — prevents external mutation
        this.supportedCurrencies  = Set.copyOf(supportedCurrencies);
        this.feesByCountry        = Map.copyOf(feesByCountry);
    }

    // All getters — no setters
    public String    getGatewayUrl()           { return gatewayUrl; }
    public int       getConnectTimeoutMs()      { return connectTimeoutMs; }
    public int       getReadTimeoutMs()         { return readTimeoutMs; }
    public BigDecimal getMaxTransactionAmount() { return maxTransactionAmount; }
    public Set<String> getSupportedCurrencies() { return supportedCurrencies; }
    public Map<String, BigDecimal> getFeesByCountry() { return feesByCountry; }
}
```

تحقق في المُنشئ — فيكون الكائن صالحًا دائمًا عند بنائه. ونسخ دفاعية بمجموعات غير قابلة للتغيير تمنع التعديل الخارجي. ولا توجد إلا دوال قراءة (getters) — بلا دوال تعيين.

ويُنشر مرة واحدة عبر `volatile` مع دعم إعادة التحميل أثناء التشغيل:

```java
@Component
public class PaymentConfigService {

    private volatile PaymentConfiguration current;

    @PostConstruct
    public void init() {
        current = loadFromDatabase();
    }

    // Called by config-change event at runtime
    public void reload() {
        PaymentConfiguration updated = loadFromDatabase();
        current = updated;  // Atomic reference swap — old readers unaffected
    }

    public PaymentConfiguration get() {
        return current;  // Always returns a fully constructed, immutable object
    }
}
```

تبديل المرجع ذري — والقراء الحاليون لا يتأثرون، ويعيد `get()` دائمًا كائنًا مبنيًا بالكامل وغير قابل للتغيير.

## اختبار المعرفة

**س1:** لصنف حقل `final` يحمل `HashMap`. ويحصل خيط آخر على مرجع إلى الكائن ويقرأ `HashMap`. هل محتوى `HashMap` مضمون الرؤية؟

**ج:** المرجع المخزن في الحقل `final` مضمون الرؤية. ويضمن تجميد الحقل `final` نشر مرجع `HashMap` نفسه بشكل صحيح. لكن **محتوى** `HashMap` لا يُضمن مرئيًا إلا إذا لم تحدث تعديلات عليها بعد اكتمال المُنشئ. فإذا ملأ المُنشئ الخريطة ولم يعدّلها أحد بعد ذلك، فالمحتوى مرئي فعليًا. لكن HashMap ليست آمنة للقراءات المتزامنة إذا عُدّلت بعد البناء — فاستخدم `Map.copyOf()` لتكون متأكدًا.

**س2:** تحذف المعدِّل `volatile` من حقل النسخة في القفل مزدوج الفحص. وتعمل الشيفرة بشكل صحيح على جهاز التطوير لأشهر. لماذا قد تبقى هذه الشيفرة خطرة في الإنتاج؟

**ج:** خطأ القفل مزدوج الفحص المعطوب حساس للتوقيت ويعتمد على JVM والعتاد. فمعالجات x86 لا تعيد ترتيب الكتابات مع كتابات أخرى، مما يجعل الخطأ نادرًا هناك — لكن مترجم JIT قد يعيد ترتيب الكتابات على أي معالج. ويظهر أكثر على المعماريات ضعيفة الترتيب مثل ARM (كخوادم AWS Graviton أو Apple Silicon). والانتقال إلى عتاد جديد، أو إصدار JVM جديد، أو نمط حمل يغيّر قرارات JIT قد يكشف الخطأ في أي وقت. فلا تعتمد أبدًا على ترتيب أقوى مما يضمنه JMM.

## التحدي العملي

تحتاج خدمة دفع إلى `FraudRuleEngine`:
1. يُحمَّل بكسل (لا عند البدء — فتهيئته تستغرق 3 ثوانٍ)
2. يمكن إعادة تحميله عند تغيّر القواعد دون حجب فحوص الدفع الجارية
3. آمن للخيوط في القراءات المتزامنة من مئات خيوط الدفع
4. لا يعرض أبدًا مجموعة قواعد مبنية أو محدّثة جزئيًا لأي خيط

**المهمة:** نفّذ `FraudRuleEngine` بما يلي:
- تهيئة كسولة باستخدام أسلوب الصنف الحامل للتهيئة عند الطلب
- طريقة `reload()` تبدّل ذريًا مجموعة قواعد جديدة دون حجب القراء
- كل بيانات القواعد مخزنة في حقول `final` مع نسخ دفاعية
- طريقة `checkTransaction(Transaction tx)` تقرأ القواعد دون مزامنة
- اختبار وحدة يُظهر أنه بعد `reload()` تستخدم كل الاستدعاءات اللاحقة لـ `checkTransaction()` القواعد الجديدة (لا يرى أي خيط مزيجًا من القواعد القديمة والجديدة أثناء التبديل)

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لصنف حقل final يحمل HashMap مُلئت أثناء البناء. وبعد نشر الكائن بأمان عبر كتابة volatile، هل محتوى HashMap مضمون الرؤية للخيوط الأخرى؟",
      "options": [
        "لا، الحقول final تضمن رؤية المرجع فقط، لا محتوى الكائن الذي يشير إليه",
        "نعم، إذا مُلئت HashMap في المُنشئ ولم يعدّلها أحد بعد ذلك، فضمان التجميد يغطي محتواها",
        "لا، HashMap ليست آمنة للخيوط فمحتواها غير مضمون الرؤية أبدًا",
        "نعم، لكن فقط إذا غُلّفت HashMap بـ Collections.synchronizedMap()"
      ],
      "correct": 1,
      "explanation": "يغطي ضمان الحقل final في JMM المرجع وكل ما يمكن الوصول إليه عبره كما كان عند نهاية المُنشئ. ولأن HashMap مُلئت في المُنشئ وهي محفوظة في حقل final، فكل محتواها المكتوب أثناء البناء مرئي لأي خيط يحصل على مرجع الكائن بعد البناء. أما التعديلات على HashMap بعد البناء فلا يغطيها الضمان — وHashMap ليست آمنة للتعديل المتزامن — ففضّل نسخة غير قابلة للتغيير مثل Map.copyOf()."
    },
    {
      "text": "ما النمط المضاد 'تسرب this' ولماذا هو خطر؟",
      "options": [
        "إعادة 'this' من طريقة، مما يمنع جمع النفايات",
        "تسجيل 'this' لدى مستمع أحداث أو تمرير 'this' إلى خيط آخر داخل المُنشئ، قبل اكتمال البناء",
        "استخدام 'this' كمراقب مزامنة داخل طريقة",
        "تخزين 'this' في حقل ساكن، مما يمنع جمع النفايات"
      ],
      "correct": 1,
      "explanation": "يحدث نمط تسرب 'this' عندما يُنشر الكائن قيد البناء (مثلًا يُمرر إلى خيط آخر أو يُسجّل كمستمع) قبل انتهاء المُنشئ. فيستطيع خيط آخر استدعاء طرق على الكائن المبني جزئيًا، فيرى null أو قيمًا افتراضية لحقول لم تُعيّن بعد. والإصلاح استخدام طريقة مصنع ساكنة تُكمل البناء قبل النشر."
    },
    {
      "text": "لماذا يكون نمط القفل مزدوج الفحص معطوبًا دون الكلمة volatile على حقل النسخة؟",
      "options": [
        "دون volatile قد لا تُقرأ قيمة الحقل من الذاكرة الرئيسية أبدًا",
        "دون volatile يستطيع JIT نقل إسناد المرجع ليسبق كتابات حقول المُنشئ، فقد يرى القارئ كائنًا غير null لكنه مهيأ جزئيًا",
        "دون volatile لا يستطيع إلا خيط واحد رؤية النسخة أبدًا",
        "دون volatile لا توفر كتلة synchronized الاستبعاد المتبادل"
      ],
      "correct": 1,
      "explanation": "يستطيع JIT إعادة ترتيب الكتابة في حقل النسخة (تخزين المرجع) لتحدث قبل اكتمال كل كتابات حقول المُنشئ. فقد يرى خيط قارئ مرجعًا غير null ويتجاوز كتلة synchronized، ثم يقرأ null أو قيمًا افتراضية لحقول الكائن لأن كتابات المُنشئ لم تظهر بعد. والكتابة volatile تنشئ علاقة تحدث-قبل تمنع إعادة الترتيب هذه."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "محرك قواعد احتيال كسول وآمن للخيوط مع إعادة تحميل",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "نفّذ صنف FraudRuleEngine باستخدام أسلوب الصنف الحامل للتهيئة الكسولة. تستغرق تهيئة المحرك 3 ثوانٍ (حاكِها بـ Thread.sleep). ويجب تخزين كل بيانات القواعد (العتبات، والدول المحظورة، وحدود السرعة) في حقول final مع نسخ دفاعية باستخدام Set.copyOf() وMap.copyOf()."
    },
    {
      "id": "2",
      "description": "أضف طريقة reload() إلى FraudRuleEngine تبدّل ذريًا RuleSet جديدة عبر تبديل مرجع volatile. ويجب أن يكون التبديل ذريًا — فلا يرى أي قارئ مزيجًا من القواعد القديمة والجديدة. ويجب ألا يحتاج القراء الذين يستدعون checkTransaction() إلى أي مزامنة وألا يُحجبوا أثناء إعادة التحميل."
    },
    {
      "id": "3",
      "description": "نفّذ PaymentConfigService تستخدم مرجع volatile إلى سجل PaymentConfiguration غير قابل للتغيير (كل الحقول final: ‏gatewayUrl، والمهل، وmaxAmount، وsupportedCurrencies كـ Set.copyOf، وfeesByCountry كـ Map.copyOf). وتبدّل طريقة reload() المرجع ذريًا. وتحقق من كل الحقول في المُنشئ لضمان أن الكائن صالح دائمًا عند بنائه."
    },
    {
      "id": "4",
      "description": "اكتب اختبار وحدة لـ FraudRuleEngine: ‏(أ) يحمّل المحرك على خيط خلفي ويتحقق من أنه غير مهيأ قبل أول وصول، (ب) يستدعي reload() بقواعد جديدة من خيط بينما تستدعي 100 خيط قارئ checkTransaction() باستمرار، (ج) يؤكد أنه بعد اكتمال reload() تستخدم كل استدعاءات checkTransaction() اللاحقة القواعد الجديدة — ولا يرى أي خيط مزيجًا من حقول القواعد القديمة والجديدة في الوقت نفسه."
    }
  ]
}
-->
