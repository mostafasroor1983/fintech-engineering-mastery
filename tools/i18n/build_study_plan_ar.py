#!/usr/bin/env python3
"""Generate docs/content/study-plan.ar.md, the Arabic version of the 30-week study plan.

The schedule (weeks, lessons, minutes, checks) comes from tools/build_study_plan.py, so the two
languages can never drift apart. This file only holds the Arabic wording; lesson and track titles
come from each track's _track.ar.json. Run tools/build_study_plan.py first, then this script.

Usage: python3 tools/i18n/build_study_plan_ar.py [--check]
"""
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
spec = importlib.util.spec_from_file_location("plan", os.path.join(ROOT, "tools", "build_study_plan.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

OUT = os.path.join(P.DOCS, "content", "study-plan.ar.md")

# One entry per week, same order as P.WEEKS: (theme, exercise, deliverable)
WEEKS_AR = [
    ("التشخيص + قواعد البيانات",
     "قيّم نفسك مقابل مصفوفة الكفاءات (0-3 لكل صف)، ثم شغّل أمثلة مستويات العزل في psql.",
     "مصفوفة كفاءاتك مقيّمة؛ وملاحظات عن الشذوذات التي يسمح بها READ COMMITTED."),
    ("أساسيات التزامن",
     "أعد إنتاج تحديث مفقود بخيطين، ثم أصلحه بطريقتين (قفل، وعملية ذرية).",
     "اختبار سباق يفشل ثم ينجح في مستودعك الخاص."),
    ("سلامة المعاملات 1: دفتر الأستاذ والسيناريوهات A-E",
     "شغّل مختبر الإخفاق لكل سيناريو، ثم إصلاحه، مع الاختبارات.",
     "مختبرات السيناريوهات A-E خضراء؛ وورقة من صفحة واحدة بثوابت دفتر الأستاذ."),
    ("سلامة المعاملات 2: السيناريوهات F-J",
     "شغّل مختبرات الكتابة المزدوجة، والتسليم المكرر، والمطابقة.",
     "المختبرات خضراء؛ ونقطة التحقق 1 مصححة."),
    ("سلامة المعاملات 3: الأنماط",
     "نفّذ جدول عدم تكرار ومستطلِع صندوق صادر يدويًا (بلا إطار عمل).",
     "النمطان يعملان مع اختبار تزامن."),
    ("سلامة المعاملات 4: مصادر الأحداث، وCQRS، والتدقيق",
     "اكتب جدول القرار: أي نمط لأي مشكلة دفع، ولماذا.",
     "جدول قرار المسار 05 الخاص بك (صفحة واحدة)."),
    ("أساسيات Kafka + أساسيات Spring Boot 4",
     "شغّل منتجًا بـ acks=all وأوقف وسيطًا؛ واستهلك بتأكيدات يدوية.",
     "ملاحظات: ما الذي فُقد أو تكرر في كل إعداد."),
    ("Spring للمراسلة؛ بدء المشروع الختامي 1",
     "الخطوات 1-3 من المشروع الختامي 1 (المخطط، واختبار التزامن الفاشل، وعدم التكرار).",
     "اختبارات عدم التكرار خضراء؛ ونقطة التحقق 2 مصححة."),
    ("إنهاء المشروع الختامي 1 + الاختبار",
     "الخطوات 4-6 من المشروع الختامي 1 (صندوق الصادر، والمستهلك، وDLT، واختبار الحمل).",
     "المشروع الختامي 1 مكتمل: 13 اختبارًا خضراء، وأرقام README من جهازك."),
    ("المجال المصرفي 1",
     "ارسم تدفق الأموال لدفعة بطاقة وتحويل بنكي من البداية إلى النهاية.",
     "مخططا تدفق بكل طرف ورسالة."),
    ("بدء المشروع الختامي 2",
     "الخطوات 1-3 من المشروع الختامي 2 (دفتر الأستاذ، والقفل المرتب، واختبار الجمود).",
     "اختبارات التزامن والجمود خضراء."),
    ("إنهاء المشروع الختامي 2 + ISO 20022",
     "الخطوات 4-6 من المشروع الختامي 2 (ثوابت قاعدة البيانات، وصرف العملات، والمطابقة).",
     "المشروع الختامي 2 مكتمل؛ ونقطة التحقق 3 مصححة."),
    ("المرونة",
     "أضف مهلة، وإعادة محاولة مع تشتيت، وقاطع دائرة حول بديل HTTP متقلب.",
     "اختبار يُظهر كيف يغيّر كل نمط سلوك الإخفاق."),
    ("Java غير المتزامنة والخيوط الافتراضية",
     "أعد كتابة توزيع متفرع بـ CompletableFuture، ثم بالخيوط الافتراضية؛ وقارن.",
     "ملاحظات القياس المعياري وفحص التثبيت على JDK الخاص بك."),
    ("بدء المشروع الختامي 3",
     "الخطوات 1-3 من المشروع الختامي 3 (آلة الحالات، والتحصيلات المتزامنة).",
     "اختبارات آلة الحالات والتزامن خضراء."),
    ("إنهاء المشروع الختامي 3",
     "الخطوات 4-6 من المشروع الختامي 3 (خطاف الاحتيال: المهلة، والقاطع، والحاجز).",
     "المشروع الختامي 3 مكتمل؛ ونقطة التحقق 4 مصححة."),
    ("قنوات المدفوعات + قواعد البيانات على نطاق واسع",
     "اشرح تسوية Faster Payments/SEPA Instant لصديق في 3 دقائق.",
     "جدول مقارنة: القنوات الدفعية مقابل الفورية."),
    ("بدء المشروع الختامي 4",
     "الخطوات 1-3 من المشروع الختامي 4 (المحلل، والمطابِق، والاستيعاب).",
     "اختبارات المحلل (بما فيها XXE) والمطابِق خضراء."),
    ("إنهاء المشروع الختامي 4 + المعاملات الموزعة",
     "الخطوات 4-6 من المشروع الختامي 4 (سير العمل، والحسم التلقائي، واختبار الحمل).",
     "المشروع الختامي 4 مكتمل."),
    ("الأمان وقابلية المراقبة",
     "أمّن نقطة بنطاقات JWT وأضف تتبعًا واحدًا ومقياسًا واحدًا.",
     "خادم موارد يعمل؛ ونقطة التحقق 5 مصححة؛ وأول 3 قصص STAR مكتوبة."),
    ("التعمق في الأنظمة الموزعة",
     "اشرح على السبورة انقسام الدماغ (split-brain) وإصلاحًا برمز تسييج.",
     "جدول أنماط إخفاق من صفحة واحدة لخدمة قائمة على قائد."),
    ("بدء المشروع الختامي 5",
     "الخطوات 1-3 من المشروع الختامي 5 (الأمان، والتحويلات، ودلو الرموز).",
     "اختبارات الأمان وتحديد المعدل خضراء."),
    ("إنهاء المشروع الختامي 5 + التحليل الأدائي",
     "الخطوات 4-6 من المشروع الختامي 5 (webhooks، وSSRF، واختبار الحمل). وحلّل أداء مشروع ختامي واحد بـ async-profiler أو JFR.",
     "المشروع الختامي 5 مكتمل؛ ومخطط لهب (flame graph) مع اكتشاف واحد."),
    ("تصميم الأنظمة 1",
     "حل مشكلات الدروس 2-5 على الورق وفق خطة الـ 45 دقيقة.",
     "أربعة تصاميم مؤقتة؛ ونقطة التحقق 6 مصححة."),
    ("تصميم الأنظمة 2 + البنية المعمارية",
     "تصميمان مؤقتان آخران؛ وراجع أضعف خطوة لديك في RESHADED.",
     "ملاحظات تصميم مع جدول إخفاقات لكل منها."),
    ("البنية المعمارية + المنصة",
     "اكتب سجل قرار معماري (ADR) واحدًا لقرار في أحد مشاريعك الختامية.",
     "سجل ADR مؤكد بجانب المشروع الختامي."),
    ("المقابلات التجريبية 1 + ملف الأعمال",
     "المقابلات التجريبية 1-3 (التصميم). قيّم من التسجيل؛ وأعد الأبعاد التي تقل عن 3.",
     "ثلاثة معايير تقييم مقيّمة؛ وملفات README للمشاريع الختامية مصقولة؛ وملف GitHub مثبت عليه المشاريع الختامية الخمسة."),
    ("المقابلات التجريبية 2 + التقديم على الوظائف",
     "المقابلات التجريبية 4-6 (تصميم + برمجة مرتين).",
     "ثلاثة معايير تقييم مقيّمة؛ وسيرة ذاتية مكيّفة؛ وأول طلبات توظيف مرسلة."),
    ("المقابلات التجريبية 3",
     "المقابلات التجريبية 7-9 (تعمقان + سلوكية)؛ وأعد أضعف مقابلتين تجريبيتين.",
     "كل المقابلات التجريبية ≥ 3 في كل بُعد، أو إعادة مجدولة."),
    ("المقابلة التجريبية الأخيرة + التحضير لأول 90 يومًا",
     "المقابلة التجريبية 10 (اعرض مشروعًا ختاميًا)؛ واقرأ دروس أول 90 يومًا.",
     "عرضك للمشروع الختامي في 10 دقائق، متدربًا عليه؛ ومسودة 30/60/90 لوظيفتك القادمة."),
]

# Activity names (exact English text -> Arabic). Checkpoints are handled by a pattern.
ACT_AR = {
    "Diagnostic: score yourself 0-3 on each competency in the target profile; mark the weakest five":
        "التشخيص: قيّم نفسك من 0 إلى 3 في كل كفاءة في الملف المستهدف؛ وعلّم أضعف خمس",
    "Mock interviews 1-3 (45 min each, recorded)": "المقابلات التجريبية 1-3 (45 دقيقة لكل منها، مسجلة)",
    "Review weak areas found in the mocks (re-read linked lessons)":
        "راجع نقاط الضعف التي ظهرت في المقابلات التجريبية (أعد قراءة الدروس المرتبطة)",
    "Portfolio polish: README numbers from your machine, repo description, pinned repos":
        "صقل ملف الأعمال: أرقام README من جهازك، ووصف المستودع، والمستودعات المثبتة",
    "Mock interviews 4-6": "المقابلات التجريبية 4-6",
    "Review weak areas": "راجع نقاط الضعف",
    "Applications: tailor CV bullets to each job post (link the capstone that proves each skill)":
        "طلبات التوظيف: كيّف نقاط السيرة الذاتية لكل إعلان وظيفة (اربط المشروع الختامي الذي يثبت كل مهارة)",
    "Mock interviews 7-9": "المقابلات التجريبية 7-9",
    "Redo the two weakest mocks (with a variation)": "أعد أضعف مقابلتين تجريبيتين (مع تنويع)",
    "Applications and recruiter calls": "طلبات التوظيف ومكالمات مسؤولي التوظيف",
    "Mock interview 10: capstone presentation": "المقابلة التجريبية 10: عرض المشروع الختامي",
    "Final review of your weakest five competencies": "المراجعة النهائية لأضعف خمس كفاءات لديك",
    "Applications and interviews": "طلبات التوظيف والمقابلات",
    "Checkpoint (timed quiz)": "نقطة تحقق (اختبار مؤقت)",
    "Mock interview 1 (design)": "المقابلة التجريبية 1 (تصميم)",
    "Mock interviews 5 and 9 (coding + behavioural)": "المقابلتان التجريبيتان 5 و9 (برمجة + سلوكية)",
    "Mock interviews 7 and 10 (deep dive + capstone talk)": "المقابلتان التجريبيتان 7 و10 (تعمق + عرض المشروع الختامي)",
    "Checkpoint (timed design exercise)": "نقطة تحقق (تمرين تصميم مؤقت)",
}
CHECK_RE = re.compile(r"^Checkpoint (\d+): timed quiz or design exercise on weeks (\d+)-(\d+) "
                      r"\(closed book, then mark against the lessons\)$")

CAPSTONES_AR = {
    1: "خدمة الدفع (عدم التكرار، وصندوق الصادر، وKafka)",
    2: "محفظة على دفتر أستاذ بالقيد المزدوج، مع صرف العملات",
    3: "تفويض البطاقات ومقاصتها",
    4: "التسوية والمطابقة (camt.053)",
    5: "واجهة التحويل الفوري بين الأفراد (OAuth2، وحدود المعدل، وwebhooks)",
}

FALLING_BEHIND_AR = [
    "أساسيات قواعد البيانات + التزامن",
    "السباقات، والجمود، والخيوط الافتراضية؛ ودفتر الأستاذ",
    "سلامة المعاملات 1",
    "سلامة المعاملات 2",
    "سلامة المعاملات 3 + Kafka",
    "المشروع الختامي 1 (النصف الأول) + الأمان، والمدفوعات",
    "المشروع الختامي 1 (النصف الثاني) + المرونة",
    "المشروع الختامي 2 (النصف الأول)",
    "المشروع الختامي 2 (النصف الثاني)",
    "تصميم الأنظمة",
    "دليل المقابلات",
    "المقابلات التجريبية + المراجعة",
]

READ_IF_TIME_AR = {
    "track-04-lesson-18": "معالجة مدفوعات البطاقات: يدعم المشروع الختامي 3 مباشرة.",
    "track-04-lesson-12": "بنية المطابقة: سياق للمشروع الختامي 4.",
    "track-04-lesson-10": "أنظمة صرف العملات: سياق لتحويلات صرف العملات في المشروع الختامي 2.",
    "track-09-lesson-11": "طوابير الرسائل الميتة: الرسائل السامة، المستخدمة في المشروع الختامي 1.",
    "track-09-lesson-18": "ترتيب الرسائل: سؤال متابعة متكرر عن Kafka.",
    "track-02-lesson-17": "تحديد المعدل الموزع: النظرية وراء المشروع الختامي 5.",
    "track-11-lesson-13": "‏OWASP Top 10 للخدمات المالية.",
    "track-11-lesson-11": "أمان الواجهات: التحقق، وتحديد المعدل، وWAF.",
    "track-06-lesson-15": "إدارة الحوادث: مادة قوية للقصص السلوكية.",
    "track-06-lesson-16": "مراجعات ما بعد الحوادث: ثقافة بلا لوم وتحليل السبب الجذري.",
    "track-06-lesson-10": "فحوص الصحة والمجسات: جاهزية Kubernetes لخدمات Spring.",
    "track-08-lesson-10": "تجميع الاتصالات: حدود HikariCP مع الخيوط الافتراضية.",
    "track-08-lesson-16": "خطط الاستعلام: EXPLAIN ANALYZE عمليًا.",
    "track-03-lesson-25": "نشر السياق: سياق MDC/التتبع عبر الحدود غير المتزامنة.",
    "track-03-lesson-15": "القيم ذات النطاق (Scoped values): خليفة ThreadLocal (نهائية في JDK 25).",
    "track-12-lesson-04": "سجلات ADR عمليًا: تكمّل درس RFC.",
    "track-01-lesson-02": "ممارسة ADR: تدوين القرارات.",
    "track-10-lesson-03": "أحمال عمل Kubernetes: معرفة أعمق بالمنصة.",
}


def ar_path(path):
    return path.replace("index.md", "index.ar.md")


def load_ar():
    """Arabic lesson title and track short title, keyed by lesson id."""
    out = {}
    base = os.path.join(P.DOCS, "content", "tracks")
    for folder in sorted(os.listdir(base)):
        path = os.path.join(base, folder, "_track.ar.json")
        if not os.path.isfile(path):
            continue
        data = json.load(open(path, encoding="utf-8"))
        short = data.get("shortTitle") or data["title"]
        for l in data["lessons"]:
            out[l["id"]] = (l["title"], short)
    return out


def act_ar(name):
    m = CHECK_RE.match(name)
    if m:
        return f"نقطة التحقق {m.group(1)}: اختبار مؤقت أو تمرين تصميم على الأسابيع {m.group(2)}-{m.group(3)} (دون مراجع، ثم صحّح مقابل الدروس)"
    if name not in ACT_AR:
        sys.exit(f"missing Arabic for activity: {name!r}")
    return ACT_AR[name]


TIER_AR = {"core": "أساسي", "supporting": "داعم", "optional": "اختياري"}


def lesson_link(l, ar):
    title, short = ar.get(l["id"], (l["title"], l["trackTitle"]))
    return f"[{short} الدرس {l['sequence']:02d}: {title}]({ar_path(P.rel(l['path']))})"


def item_md(item, lessons, ar):
    if isinstance(item, str):
        l = lessons[item]
        tier = TIER_AR.get(l.get("tier", ""), "")
        return f"{lesson_link(l, ar)} · {l['estimatedMinutes']} دقيقة{' · ' + tier if tier else ''}"
    if item[0] == "capstone":
        half = "الخطوات 1-3" if item[2] == "part1" else "الخطوات 4-6"
        return (f"[المشروع الختامي {item[1]}: {CAPSTONES_AR[item[1]]}]({P.CAPSTONE_FOLDERS[item[1]]}/index.ar.md)"
                f" ({half}) · {P.CAPSTONE_MIN[item[2]]} دقيقة")
    return f"{act_ar(item[1])} · {item[2]} دقيقة"


def h(m):
    return f"{m / 60:.1f} س"


def render(lessons, ar):
    assert len(WEEKS_AR) == len(P.WEEKS) and len(FALLING_BEHIND_AR) == len(P.FALLING_BEHIND)
    mins = P.item_minutes
    weekly = [sum(mins(i, lessons) for i in items) for (_, _, _, items) in P.WEEKS]
    lesson_min = sum(mins(i, lessons) for (_, _, _, items) in P.WEEKS for i in items if isinstance(i, str))
    cap_min = sum(mins(i, lessons) for (_, _, _, items) in P.WEEKS for i in items
                  if not isinstance(i, str) and i[0] == "capstone")
    act_min = sum(weekly) - lesson_min - cap_min
    _, fb_total = P.verify(lessons)
    o = []
    o.append("""---
id: "study-plan"
title: "خطة الدراسة لـ 30 أسبوعًا (10 ساعات في الأسبوع)"
lastUpdated: "2026-11-13"
---
<!-- GENERATED by tools/i18n/build_study_plan_ar.py from tools/build_study_plan.py. Edit the schedule there, then re-run both. -->

# خطة الدراسة لـ 30 أسبوعًا

**الميزانية:** ‏30 أسبوعًا × 10 ساعات = 300 ساعة. وتضم الأسابيع 1–26 المسار الرئيسي (كل درس أساسي وداعم وكل المشاريع الختامية الخمسة)، إضافة إلى تشخيص وست نقاط تحقق. والأسابيع 27–30 هي الوقت المحجوز للمقابلات التجريبية، والمراجعة، وصقل ملف الأعمال، والتقديم على الوظائف. ولا يتجاوز أي أسبوع 10 ساعات. ومعظم الأسابيع أقل من ذلك عمدًا: فالوقت الفائض هو هامشك للجلسات الفائتة.

""")
    o.append("| | الساعات |\n|---|---|\n")
    o.append(f"| الدروس (المسار الرئيسي) | {lesson_min / 60:.1f} |\n")
    o.append(f"| المشاريع الختامية (5 × 12 ساعة) | {cap_min / 60:.1f} |\n")
    o.append(f"| التشخيص، ونقاط التحقق، والمقابلات التجريبية، والمراجعة، وملف الأعمال، والتقديم | {act_min / 60:.1f} |\n")
    o.append(f"| **المجموع المجدول** | **{sum(weekly) / 60:.1f}** من 300 |\n")
    o.append(f"| هامش غير مجدول | {300 - sum(weekly) / 60:.1f} |\n\n")
    o.append("""**كيف تستخدمها:** أدِّ الدروس بالترتيب داخل الأسبوع. ودقائق كل درس تشمل بالفعل القراءة، وتشغيل الكود، والتمارين، والإجابة عن أسئلة المقابلة بصوت عالٍ. وتابع تقدمك في الموقع. وإن تأخرت، فانظر خطة التأخر أدناه.

**المسار 05 (سلامة المعاملات)** يشغل الأسابيع 3–6: أربعة أسابيع كاملة، ومبكرًا، لأن أعمال Spring، والمراسلة، والمشاريع الختامية، وتصميم الأنظمة كلها تُبنى عليه.

""")
    o.append("## أسبوعًا بأسبوع\n\n| الأسبوع | الموضوع | الدقائق |\n|---|---|---|\n")
    for w, ((theme, _, _), m) in enumerate(zip(WEEKS_AR, weekly), 1):
        o.append(f"| {w} | {theme} | {m} ({h(m)}) |\n")
    o.append("\n")
    for w, ((theme, ex, dl), (_, _, _, items), m) in enumerate(zip(WEEKS_AR, P.WEEKS, weekly), 1):
        o.append(f"### الأسبوع {w}: {theme} ({m} دقيقة، {h(m)})\n\n")
        for i in items:
            o.append(f"- {item_md(i, lessons, ar)}\n")
        o.append(f"\n**التمرين:** {ex}  \n**المُخرج:** {dl}\n\n")
    o.append("## خطة التأخر\n\n")
    o.append(f"""أقصر مسار ما زال يغطي كل كفاءة عالية الوزن في نحو 12 أسبوعًا ({fb_total / 60:.0f} ساعة، و10 ساعات في الأسبوع على الأكثر). ويحتفظ بالمشروعين الختاميين 1 و2 فقط.

| الأسبوع | التركيز | الدقائق |\n|---|---|---|\n""")
    for n, (focus, (_, items)) in enumerate(zip(FALLING_BEHIND_AR, P.FALLING_BEHIND), 1):
        o.append(f"| {n} | {focus} | {sum(mins(i, lessons) for i in items)} |\n")
    o.append("\n")
    for n, (focus, (_, items)) in enumerate(zip(FALLING_BEHIND_AR, P.FALLING_BEHIND), 1):
        o.append(f"**الأسبوع {n}: {focus}**\n\n")
        for i in items:
            o.append(f"- {item_md(i, lessons, ar)}\n")
        o.append("\n")
    o.append("""### إن فاتتك أسابيع في الخطة الكاملة، فتجاوز بهذا الترتيب

1. المشروع الختامي 5 (التحويل الفوري بين الأفراد): يوفر 12 ساعة.
2. المشروع الختامي 4 (المطابقة): يوفر 12 ساعة.
3. المشروع الختامي 3 (تفويض البطاقات): يوفر 12 ساعة.
4. الدروس الداعمة (الموسومة *داعم*): اقرأ ملخصاتها فقط.
5. لا تتجاوز أبدًا المسار 05، أو المشروعين الختاميين 1–2، أو دروس تصميم الأنظمة، أو المقابلات التجريبية.

## اقرأ إن سمح الوقت (الدروس الاختيارية، حسب القيمة)

هذه خارج ميزانية الـ 300 ساعة. ولا تأخذها إلا بعد إنجاز العمل الرئيسي للأسبوع.

""")
    for n, (lid, _) in enumerate(P.READ_IF_TIME, 1):
        l = lessons[lid]
        o.append(f"{n}. {lesson_link(l, ar)} ({l['estimatedMinutes']} دقيقة): {READ_IF_TIME_AR[lid]}\n")
    o.append("\n## انظر أيضًا\n\n- [دليل المقابلات](interview/01-star-stories/index.ar.md)\n"
             "- [الكود المصدري للمشاريع الختامية](../../examples/README.md)\n"
             "- [مصفوفة الكفاءات والملف المستهدف](../review/00-target-profile.md)\n")
    return "".join(o)


def main():
    lessons, _ = P.load_lessons()
    errors, _ = P.verify(lessons)
    if errors:
        sys.exit("Study plan errors:\n  " + "\n  ".join(errors))
    text = render(lessons, load_ar())
    if "--check" in sys.argv:
        old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else None
        if old != text:
            sys.exit("study-plan.ar.md out of date: run tools/i18n/build_study_plan_ar.py")
        print("Arabic study plan OK.")
        return
    open(OUT, "w", encoding="utf-8").write(text)
    print("Wrote", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    main()
