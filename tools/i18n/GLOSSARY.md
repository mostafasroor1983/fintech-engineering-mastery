# Arabic glossary (English → Arabic)

Goal: clear, simple Modern Standard Arabic for experienced engineers.
Rules:

1. Code, identifiers, SQL, commands, config keys, class/method names: **never translate**.
2. Product and protocol names stay in English: Kafka, PostgreSQL, Redis, Spring Boot, JVM, G1GC, ZGC, Raft, CockroachDB, Pact, JFR, HikariCP...
3. Widely used English pattern names stay in English, optionally with Arabic on first use:
   Saga, Outbox / Transactional Outbox, CQRS, Event Sourcing, Circuit Breaker (قاطع الدائرة), Bulkhead (العزل), Canary, Blue-Green.
4. On first use in a page, a term may be written "Arabic (English)"; afterwards use the Arabic only.
5. Numbers, amounts and units stay as written (£1,200, 300 ms, 2.3 MB). Use Western digits.
6. Keep sentences short. Prefer active voice. Avoid rare classical vocabulary.

| English | Arabic |
|---|---|
| race condition | حالة تسابق |
| lost update | تحديث مفقود |
| deadlock / livelock | جمود (Deadlock) / جمود حي (Livelock) |
| thread / thread pool | خيط / مجمّع خيوط |
| virtual thread | خيط افتراضي |
| lock / row lock / advisory lock | قفل / قفل صف / قفل استشاري |
| optimistic / pessimistic locking | قفل متفائل / قفل متشائم |
| atomic | ذري |
| isolation level | مستوى العزل |
| write skew / phantom | انحراف الكتابة (write skew) / الصف الوهمي (phantom) |
| idempotency / idempotent | منع التكرار (idempotency) / آمن من التكرار |
| idempotency key | مفتاح منع التكرار (Idempotency-Key) |
| retry / backoff / jitter | إعادة المحاولة / التراجع / العشوائية (jitter) |
| dual-write problem | مشكلة الكتابة المزدوجة |
| at-least-once / exactly-once | مرة واحدة على الأقل / مرة واحدة فقط |
| consumer / producer / partition / offset | مستهلك / منتِج / قسم (partition) / إزاحة (offset) |
| consumer lag | تأخر المستهلك (lag) |
| rebalance | إعادة التوازن |
| compensation / compensating transaction | تعويض / معاملة تعويضية |
| ledger / journal entry / posting | دفتر الأستاذ / قيد يومية / ترحيل |
| double-entry | القيد المزدوج |
| balance / available balance | الرصيد / الرصيد المتاح |
| hold (card authorisation hold) | حجز (تعليق مبلغ) |
| settlement / clearing | التسوية / المقاصة |
| reconciliation / break | المطابقة / فرق (break) |
| cut-off / business day | وقت الإقفال / يوم العمل |
| FX / FX rate | الصرف الأجنبي / سعر الصرف |
| minor unit | الوحدة الصغرى (مثل البنس) |
| rounding | التقريب |
| suspense account | حساب معلّق |
| overdraft | سحب على المكشوف |
| chargeback / refund | اعتراض على العملية / استرداد |
| fraud check | فحص الاحتيال |
| sanctions screening | فحص العقوبات |
| AML | مكافحة غسل الأموال (AML) |
| audit trail | سجل التدقيق |
| regulator / compliance | الجهة الرقابية / الامتثال |
| SLO / SLA / error budget | هدف مستوى الخدمة (SLO) / اتفاقية مستوى الخدمة (SLA) / ميزانية الأخطاء |
| burn rate | معدل الاستهلاك (burn rate) |
| alert / page / on-call | تنبيه / استدعاء / المناوبة |
| incident / post-mortem | حادثة / تحليل ما بعد الحادثة |
| root cause | السبب الجذري |
| latency / throughput | زمن الاستجابة (الكمون) / الإنتاجية |
| P99 | P99 (المئين 99) |
| timeout | مهلة زمنية |
| cascading failure | عطل متتالٍ |
| fallback | بديل احتياطي |
| load shedding | التخلّص من الحمل |
| deployment / rollout / rollback | نشر / إطلاق تدريجي / تراجع عن الإصدار |
| feature flag | مفتاح ميزة |
| config / schema validation | الإعدادات / التحقق من المخطط |
| migration / backfill | ترحيل / تعبئة البيانات القديمة (backfill) |
| index / query plan / full table scan | فهرس / خطة الاستعلام / مسح كامل للجدول |
| partitioning / sharding | تقسيم (partitioning) / تجزئة (sharding) |
| replica / primary | نسخة متماثلة / الخادم الأساسي |
| heap / garbage collection / Full GC | الكومة (heap) / جمع المهملات (GC) / Full GC |
| memory leak | تسرّب ذاكرة |
| heap dump / thread dump | تفريغ الكومة / تفريغ الخيوط |
| cache / eviction | ذاكرة تخزين مؤقت / إخلاء |
| breaking change | تغيير غير متوافق (breaking change) |
| contract test | اختبار العقود |
| deprecation | إيقاف تدريجي للدعم |
| network partition / split brain | انقسام الشبكة / الدماغ المنقسم (split brain) |
| quorum / leaseholder | النصاب (quorum) / حامل الإيجار (leaseholder) |
| monolith / modular monolith / microservices | نظام موحّد / نظام موحّد معياري / خدمات مصغّرة |
| invariant | ثابت (شرط يجب أن يبقى صحيحًا) |
| trade-off | مفاضلة |
| leading / trailing indicator | مؤشر استباقي / مؤشر لاحق |
| Principal Engineer | المهندس الرئيسي |
| stage (Decision Lab) | مرحلة |
| debrief | التحليل النهائي |
