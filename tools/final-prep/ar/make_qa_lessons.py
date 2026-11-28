#!/usr/bin/env python3
"""Write the Arabic frames of Q&A lessons 02-11 (tools/final-prep/ar/lessons/) from the English frames.

Front matter, ids, option order and correct answers are taken from the English lesson; only the text is
Arabic. A frame is written only once its bank (ar/qa/<bank>.txt) exists. Run after translating a bank,
then run tools/build_final_prep.py.
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
EN = os.path.join(os.path.dirname(HERE), "lessons")

# lesson file -> (bank, Arabic title, focus, [KC as (question, {english option: arabic}, explanation)], PC title, [PC tasks])
L = {
 "lesson-02-qa-financial-systems": ("01-financial-systems", "الأسئلة 1-50: الأنظمة المالية والمدفوعات",
  "تمثيل المال، ودفاتر الأستاذ والقيد المزدوج، ودورة حياة البطاقات والمدفوعات الفورية، والتسوية والمطابقة، والمحافظ والصرف، والاحتيال والامتثال، والواقع التشغيلي للمالية التي تعمل 24/7",
  [("انتهت مهلة استدعاء مزوّد الدفع بعد إرسال تحصيل. ماذا تخبر العميل وماذا تخزن؟",
    {"FAILED; the client should retry": "FAILED؛ وعلى العميل إعادة المحاولة",
     "UNKNOWN/pending, return 202, resolve by status query and reconciliation": "UNKNOWN/معلقة، وأعد 202، واحسمها باستعلام الحالة والمطابقة",
     "SUCCEEDED, since most timeouts succeed": "SUCCEEDED، لأن معظم المهل تنجح",
     "Nothing until the PSP calls back": "لا شيء حتى يتصل مزوّد الدفع"},
    "انتهاء المهلة نتيجة غير معروفة؛ وتعليمها فاشلة يدعو إلى خصم مزدوج."),
   ("ما الذي يُبقي مُدخل يومية بقيدين GBP +1000 / EUR -1000 خارج دفتر الأستاذ؟",
    {"Nothing; amounts net to zero": "لا شيء؛ المبالغ صافيها صفر",
     "A per-currency balance check (each currency must sum to zero)": "فحص توازن لكل عملة (كل عملة يجب أن يكون مجموعها صفرًا)",
     "A foreign key": "مفتاح أجنبي",
     "Optimistic locking": "القفل المتفائل"},
    "العملات المختلفة لا يُحسب صافيها أبدًا؛ كل عملة يجب أن تتوازن وحدها، مع الصرف عبر حسابات المراكز.")],
  ["أجب عن الأسئلة 1-50 بصوت عالٍ والإجابات مخفية؛ وعلّم كل سؤال لم تستطع الإجابة عنه في نحو 30 ثانية.",
   "لأضعف ثلاثة أسئلة لديك، اكتب إجابة من 3 جمل من الذاكرة، ثم قارنها بالدرس.",
   "اشرح التفويض والتحصيل والتسوية ورد المبلغ لعضو فريق جديد متخيَّل في دقيقتين."]),
 "lesson-03-qa-java-language": ("02-java-language", "الأسئلة 51-100: لغة Java والسجلات وكائنات القيمة",
  "السجلات وكائنات القيمة، والمساواة والتجزئة، والمجموعات وتعقيدها، والأنواع العامة، وميزات Java الحديثة (الأنواع المختومة، ومطابقة الأنماط، والقيم ذات النطاق)، والاستثناءات، والتدفقات، وتصميم الكائنات",
  [("لماذا يمكن تعديل السجل (record) من الخارج رغم أن حقوله نهائية؟",
    {"Records aren't final": "السجلات ليست نهائية",
     "A component may be a mutable object (e.g. a List) unless copied defensively": "قد يكون أحد المكوّنات كائنًا قابلًا للتغيير (مثل List) ما لم يُنسخ دفاعيًا",
     "Reflection always allows it": "الانعكاس يسمح بذلك دائمًا",
     "Accessors return copies by default": "دوال الوصول تعيد نسخًا افتراضيًا"},
    "السجلات غير قابلة للتغيير سطحيًا فقط؛ انسخ المجموعات بـ List.copyOf في المُنشئ المختصر."),
   ("ماذا تعيد `new BigDecimal(\"1.0\").equals(new BigDecimal(\"1.00\"))`؟",
    {"true": "true",
     "false, because equals compares scale too": "false، لأن equals تقارن المقياس أيضًا",
     "It throws": "ترمي استثناءً",
     "Depends on the JVM": "يعتمد على JVM"},
    "استخدم compareTo للمساواة العددية أو وحّد المقياس.")],
  ["أجب عن الأسئلة 51-100 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "اكتب سجل `Money` بمُنشئ مختصر يتحقق من المدخلات ودالة `plus` ترفض اختلاف العملة؛ وقارنه بالتحدي C01.",
   "اشرح PECS بمثال واحد من كود المدفوعات."]),
 "lesson-04-qa-java-concurrency": ("03-java-concurrency", "الأسئلة 101-150: التزامن في Java والخيوط الافتراضية",
  "نموذج ذاكرة Java، والأقفال والعمليات الذرية، والجمود، والمنفذات وتحديد أحجام المجمعات، وCompletableFuture، والخيوط الافتراضية والتثبيت، والتزامن المهيكل، والمجموعات المتزامنة، وإخفاقات التزامن في الإنتاج",
  [("انتقلت إلى الخيوط الافتراضية فبدأت الطلبات تنتهي مهلتها عند `getConnection`. السبب الجذري؟",
    {"Pinning": "التثبيت",
     "Downstream limit: the connection pool is now the bottleneck": "حد لاحق: مجمع الاتصالات أصبح عنق الزجاجة",
     "Virtual threads are slower": "الخيوط الافتراضية أبطأ",
     "GC pauses": "توقفات جمع المهملات"},
    "التزامن يرتفع؛ ويجب أن تكون الحدود صريحة."),
   ("أيها ذري؟",
    {"`count++` on a volatile long": "‏`count++` على long من نوع volatile",
     "`AtomicLong.incrementAndGet()`": "‏`AtomicLong.incrementAndGet()`",
     "`map.get(k)` then `map.put(k, v+1)` on a ConcurrentHashMap": "‏`map.get(k)` ثم `map.put(k, v+1)` على ConcurrentHashMap",
     "Reading a long without synchronisation": "قراءة long دون مزامنة"},
    "‏volatile يعطي الرؤية فقط؛ استخدم العمليات الذرية أو compute/merge.")],
  ["أجب عن الأسئلة 101-150 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "شغّل اختبار التحدي C03 واكسره عمدًا (اقفل بترتيب المصدر ثم الوجهة) لترى الجمود في تفريغ الخيوط.",
   "اشرح في دقيقتين ما الذي يتغير حين تنتقل خدمة Spring إلى الخيوط الافتراضية."]),
 "lesson-05-qa-jvm-performance": ("04-jvm-performance", "الأسئلة 151-200: JVM وجمع المهملات والذاكرة والأداء",
  "مناطق ذاكرة JVM، وجامعو المهملات وسجلاتهم، وتسربات الذاكرة وذاكرة الحاويات، وJIT وزمن الإقلاع، والتحليل بـ JFR وasync-profiler، وهندسة الأداء المنهجية",
  [("قُتلت الحاوية لنفاد الذاكرة والكومة عند 70% فقط من الحد. الأرجح؟",
    {"Heap leak": "تسرب في الكومة",
     "Non-heap memory (Metaspace, stacks, direct buffers) exceeded the limit": "ذاكرة خارج الكومة (Metaspace، والمكدسات، والمخازن المباشرة) تجاوزت الحد",
     "GC bug": "خطأ في جمع المهملات",
     "CPU throttling": "خنق المعالج"},
    "اترك هامشًا بـ MaxRAMPercentage وافحص بـ NMT."),
   ("أي أداة تُظهر أين تنتظر الخيوط (الأقفال، والإدخال/الإخراج) حين يكون المعالج منخفضًا؟",
    {"CPU-mode flame graph": "مخطط لهب بوضع المعالج",
     "Wall-clock profiling (async-profiler -e wall) or JFR thread events": "التحليل بالوقت الفعلي (async-profiler -e wall) أو أحداث الخيوط في JFR",
     "GC logs": "سجلات جمع المهملات",
     "Heap dump": "تفريغ الكومة"},
    "ملفات المعالج تُظهر الوقت المحترق؛ والوقت الفعلي يُظهر الانتظار.")],
  ["أجب عن الأسئلة 151-200 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "فعّل سجلات جمع المهملات وJFR على أي تطبيق Spring Boot، وحمّله دقيقة، وحدد أعلى موضع تخصيص.",
   "اشرح كيف تحدد ذاكرة JVM لحاوية بـ 2 GiB."]),
 "lesson-06-qa-spring-core-data": ("05-spring-core-data", "الأسئلة 201-250: نواة Spring وBoot والمعاملات والبيانات",
  "حقن التبعيات والإعداد التلقائي، والوكلاء وAOP، وانتشار المعاملات وعزلها، وأداء JPA وأقفاله، وتصميم واجهات REST في Spring، وActuator والتشغيل، والاختبار، وSpring Boot 4",
  [("‏`@Transactional` على دالة خاصة تُستدعى من الفئة نفسها. الأثر؟",
    {"Works normally": "تعمل بشكل طبيعي",
     "No transaction: proxies don't intercept private or self-invoked methods": "لا معاملة: الوكلاء لا يعترضون الدوال الخاصة أو المستدعاة ذاتيًا",
     "Compile error": "خطأ ترجمة",
     "Starts a nested transaction": "تبدأ معاملة متداخلة"},
    "انقل الدالة إلى كائن آخر أو أعد الهيكلة."),
   ("ما الذي حل محل `@MockBean` في Spring Boot 4؟",
    {"`@Mock`": "‏`@Mock`",
     "`@MockitoBean` from Spring Framework's test module": "‏`@MockitoBean` من وحدة الاختبار في Spring Framework",
     "`@TestBean` only": "‏`@TestBean` فقط",
     "Nothing; mocks are discouraged": "لا شيء؛ المحاكاة غير مستحبة"},
    "أُهمل في 3.4 وأُزيل في 4.0.")],
  ["أجب عن الأسئلة 201-250 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "اكتب اختبار Testcontainers يثبت أن المعاملة تتراجع حين يفشل الإدراج الثاني من إدراجين.",
   "اشرح نمط النية / الاستدعاء البعيد / النتيجة لاستدعاءات مزوّد الدفع دون إبقاء معاملة مفتوحة."]),
 "lesson-07-qa-spring-ecosystem": ("06-spring-ecosystem", "الأسئلة 251-300: Spring Security وCloud وBatch والمراسلة والذكاء الاصطناعي",
  "Spring Security وOAuth2، والمرونة مع Spring Cloud وResilience4j، وقابلية إعادة التشغيل في Spring Batch، وKafka وRabbitMQ مع Spring، وSpring Integration، وSpring AI، وقابلية المراقبة",
  [("تُعاد مهمة Spring Batch بعد فشلها في منتصفها. ماذا يجب أن يكون الكاتب؟",
    {"Fast": "سريعًا",
     "Idempotent, because a partially processed chunk may run again": "عديم الأثر عند التكرار، لأن دفعة معالجة جزئيًا قد تُشغّل مجددًا",
     "Transactional across all chunks": "معاملاتيًا عبر كل الدفعات",
     "Single-threaded": "أحادي الخيط"},
    "إعادة التشغيل تستأنف بعد آخر دفعة مؤكدة."),
   ("دلالات EOS في Kafka مع مستهلك يكتب في PostgreSQL. ماذا تحتاج أيضًا؟",
    {"Nothing": "لا شيء",
     "An idempotent consumer (processed-event table in the same DB transaction)": "مستهلكًا عديم الأثر عند التكرار (جدول أحداث معالجة في معاملة قاعدة البيانات نفسها)",
     "acks=0": "‏acks=0",
     "A single partition": "قسمًا واحدًا"},
    "‏EOS يغطي من Kafka إلى Kafka فقط.")],
  ["أجب عن الأسئلة 251-300 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "ارسم إعداد مستهلك Spring Kafka مع إعادات المحاولة، وموضوع رسائل ميتة، وكتابة عديمة الأثر عند التكرار.",
   "اشرح كيف تستخدم Spring AI في منتج منظَّم دون السماح للنموذج بنقل الأموال."]),
 "lesson-08-qa-distributed-foundations": ("07-distributed-foundations", "الأسئلة 301-350: أسس الأنظمة الموزعة",
  "نماذج الاتساق وCAP، والإجماع وانتخاب القائد، والتكرار وحسم التعارضات، والتقسيم، والزمن والترتيب، ونماذج الإخفاق، والمعاملات الموزعة والساغا",
  [("عنقود Raft من 3 عقد يفقد عقدتين. ماذا يحدث؟",
    {"It keeps committing": "يستمر في التأكيد",
     "It can't commit: no majority": "لا يستطيع التأكيد: لا أغلبية",
     "It elects two leaders": "ينتخب قائدين",
     "It switches to async replication": "يتحول إلى التكرار غير المتزامن"},
    "أغلبية الثلاثة هي اثنان."),
   ("لماذا تحتاج رموز التسييج مع عقود الإيجار؟",
    {"For performance": "للأداء",
     "A paused holder may act after its lease expired; the resource must reject stale tokens": "قد يتصرف حامل متوقف بعد انتهاء عقده؛ فيجب أن يرفض المورد الرموز القديمة",
     "To encrypt the lock": "لتشفير القفل",
     "To order Kafka messages": "لترتيب رسائل Kafka"},
    "عقود الإيجار وحدها لا تضمن الاستبعاد المتبادل.")],
  ["أجب عن الأسئلة 301-350 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "ارسم ساغا تحويل بين الأجزاء مع حسابات المقاصة ومسار التعويض.",
   "اشرح القابلية للخطية مقابل القابلية للتسلسل بمثال لكل منهما."]),
 "lesson-09-qa-distributed-patterns": ("08-distributed-patterns", "الأسئلة 351-400: أنماط الأنظمة الموزعة عمليًا",
  "تنفيذ عدم التكرار، وتشغيل صندوق الصادر وCDC، وتنفيذ الساغا، ودلالات التسليم والترتيب، والضغط العكسي وإسقاط الحمل، وضبط المرونة، وتحديد المعدل، والتخزين المؤقت وأنماط التكامل",
  [("تصل إعادتا محاولة بالمفتاح نفسه معًا. أي تنفيذ آمن؟",
    {"Check if the key exists, then insert": "تحقق من وجود المفتاح، ثم أدرج",
     "Insert the key first under a unique constraint, in the payment transaction": "أدرج المفتاح أولًا تحت قيد تفرد، في معاملة الدفع",
     "A synchronized block": "كتلة synchronized",
     "A cache lookup": "بحث في الذاكرة المؤقتة"},
    "قاعدة البيانات وحدها تحكم بين النسخ."),
   ("ما المخاطرة الأساسية لإعادة المحاولة في كل طبقة؟",
    {"Lower latency": "زمن استجابة أقل",
     "Load amplification (retry storms)": "تضخيم الحمل (عواصف إعادات المحاولة)",
     "Lost messages": "رسائل مفقودة",
     "Deadlocks": "جمود"},
    "3 طبقات × 3 إعادات = حتى 27 استدعاءً.")],
  ["أجب عن الأسئلة 351-400 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "شغّل التحديين C02 وC08 واشرح كل سطر في مخزن عدم التكرار.",
   "صمّم مرحّل صندوق صادر يعمل على ثلاث نسخ دون نشر مزدوج."]),
 "lesson-10-qa-databases": ("09-databases", "الأسئلة 401-450: قواعد البيانات وهندسة البيانات",
  "‏MVCC في PostgreSQL، والتنظيف والأقفال، والفهرسة وخطط الاستعلام، وتصميم المخطط للأموال، والتقسيم، والتكرار والإتاحة العالية، واختيار مخازن البيانات، والصحة تحت التزامن",
  [("أي فهرس يخدم `WHERE account_id = ? ORDER BY created_at DESC LIMIT 20` أفضل؟",
    {"(created_at)": "(created_at)",
     "(account_id, created_at DESC)": "(account_id, created_at DESC)",
     "(created_at, account_id)": "(created_at, account_id)",
     "A GIN index": "فهرس GIN"},
    "عمود المساواة أولًا، ثم عمود الترتيب."),
   ("لماذا قد يوقف `ALTER TABLE` قصير كل الحركة؟",
    {"It rewrites the table": "يعيد كتابة الجدول",
     "It waits for an ACCESS EXCLUSIVE lock behind a long transaction while new queries queue behind it": "ينتظر قفل ACCESS EXCLUSIVE خلف معاملة طويلة بينما تصطف الاستعلامات الجديدة خلفه",
     "It disables indexes": "يعطّل الفهارس",
     "It runs VACUUM FULL": "يشغّل VACUUM FULL"},
    "اضبط lock_timeout وأعد المحاولة.")],
  ["أجب عن الأسئلة 401-450 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "اكتب DDL للقيود مع مشغّل توازن مؤجل واختبره بمُدخل غير متوازن.",
   "اشرح انحراف الكتابة بمثال الحد اليومي وإصلاحين."]),
 "lesson-11-qa-architecture-operations": ("10-architecture-operations", "الأسئلة 451-500: البنية الحديثة والتشغيل والقيادة",
  "أنماط البنية وDDD، ومقابلة تصميم الأنظمة، وKubernetes والسحابة، وSRE والحوادث، والبنية الأمنية، والقيادة التقنية على مستوى Staff",
  [("استهلاك ميزانية الأخطاء بمعدل 14.4× على مدى ساعة. الإجراء؟",
    {"Ignore until it recovers": "تجاهله حتى يتعافى",
     "Page: at this rate the 30-day budget runs out in about two days": "استدعِ المناوب: بهذا المعدل تنفد ميزانية 30 يومًا في نحو يومين",
     "Lower the SLO": "اخفض هدف مستوى الخدمة",
     "Ship more features": "أطلق ميزات أكثر"},
    "الاستهلاك السريع يستدعي المناوب، والبطيء ينشئ تذكرة."),
   ("أي مجس يجب أن يفحص تبعية مثل قاعدة البيانات؟",
    {"Liveness": "الحيوية (Liveness)",
     "Readiness": "الجاهزية (Readiness)",
     "Startup only": "الإقلاع فقط",
     "None of them, ever": "لا شيء منها، أبدًا"},
    "إعادات التشغيل بمجس الحيوية ستجعل الانقطاع أسوأ.")],
  ["أجب عن الأسئلة 451-500 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها.",
   "أعطِ إجابتك في 60 ثانية عن: 'مونوليث معياري أم خدمات مصغّرة لمنصة مدفوعات جديدة؟'",
   "اكتب ADR من صفحة واحدة لقرار من خبرتك."]),
}

TEMPLATE = """## في دقيقة واحدة

خمسون سؤال مقابلة عن {focus}، ولكل منها إجابة موجزة تغطي المقايضة، أو الحالة الحدية، أو نمط الإخفاق في الإنتاج الذي ينتظره المُقابِل. والإجابات مخفية: اقرأ السؤال، و**أجب بصوت عالٍ في نحو 30 ثانية**، ثم افتح الإجابة وقارن. الميزانية: **40 دقيقة** (نحو 45 ثانية لكل سؤال، مع التعليم).

## كيف تستخدم هذا البنك

1. أجب قبل أن تفتح. فإن لم تستطع البدء بإجابة خلال 10 ثوانٍ، فعلّم السؤال وامضِ.
2. حين تفتح إجابة، تحقق من *الآلية* و*نمط الإخفاق*، لا من الصياغة.
3. علّم كل سؤال: ✓ (متمكن)، ~ (جزئي)، ✗ (فاتك). وأعد زيارة ~ و✗ فقط في كتلة المراجعة النهائية (الدرس 18).
4. قل الإجابة بكلماتك مرة أخرى بعد قراءتها؛ فهذا ما ينقلها إلى الذاكرة.

## الأسئلة {lo}-{hi}

@@QA qa/{bank}.txt@@

## الخلاصة

- علّم أسئلتك ~ و✗؛ فهي مدخلك إلى كتلة المراجعة النهائية.
- كل إجابة قوية تسمّي آلية، وكلفة، وما يحدث حين تفشل.

"""

def main():
    written = []
    for name, (bank, title, focus, kc_ar, pc_ar) in L.items():
        if not os.path.exists(os.path.join(HERE, "qa", bank + ".txt")):
            continue
        en = open(os.path.join(EN, name + ".md"), encoding="utf-8").read()
        fm = re.match(r"^---\n.*?\n---\n", en, re.S).group(0)
        fm = re.sub(r'^title: .*$', 'title: ' + json.dumps(title, ensure_ascii=False), fm, flags=re.M)
        fm = re.sub(r'^trackName: .*$', 'trackName: "التحضير النهائي للمقابلات"', fm, flags=re.M)
        kc = json.loads(re.search(r"<!-- KNOWLEDGE-CHECK\n(.*?)\n-->", en, re.S).group(1))
        for q, (qa, opts, expl) in zip(kc, kc_ar):
            q["question"] = qa
            q["options"] = [opts[o] for o in q["options"]]      # same order as English
            q["explanation"] = expl
        pc = json.loads(re.search(r"<!-- PRACTICAL-CHALLENGE\n(.*?)\n-->", en, re.S).group(1))
        seq = int(re.search(r"^sequence: (\d+)", fm, re.M).group(1))
        lo, hi = (seq - 2) * 50 + 1, (seq - 1) * 50
        pc["title"] = f"تدريب على الأسئلة {lo}-{hi}"
        pc["description"] = "حوّل القراءة إلى تذكر: أجب بصوت عالٍ أولًا، ثم تحقق."
        for t, text in zip(pc["tasks"], pc_ar):
            t["description"] = text
        body = TEMPLATE.format(focus=focus, lo=lo, hi=hi, bank=bank)
        body += "<!-- KNOWLEDGE-CHECK\n" + json.dumps(kc, indent=2, ensure_ascii=False) + "\n-->\n\n"
        body += "<!-- PRACTICAL-CHALLENGE\n" + json.dumps(pc, indent=2, ensure_ascii=False) + "\n-->\n"
        open(os.path.join(HERE, "lessons", name + ".md"), "w", encoding="utf-8").write(fm + "\n" + body)
        written.append(name)
    print("Arabic Q&A frames:", len(written))

if __name__ == "__main__":
    main()
