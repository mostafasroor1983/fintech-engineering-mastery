---
id: "track-17-lesson-10"
title: "الأسئلة 401-450: قواعد البيانات وهندسة البيانات"
track: "track-17"
trackName: "التحضير النهائي للمقابلات"
sequence: 10
slug: "qa-databases"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["postgresql", "indexing", "mvcc", "replication", "interview"]
references:
  - "PostgreSQL 18 Documentation: Concurrency Control, Indexes, Routine Vacuuming (postgresql.org)"
  - "Markus Winand, Use The Index, Luke (use-the-index-luke.com)"
  - "Martin Kleppmann, Designing Data-Intensive Applications, chapters 5-7"
---

## في دقيقة واحدة

خمسون سؤال مقابلة عن ‏MVCC في PostgreSQL، والتنظيف والأقفال، والفهرسة وخطط الاستعلام، وتصميم المخطط للأموال، والتقسيم، والتكرار والإتاحة العالية، واختيار مخازن البيانات، والصحة تحت التزامن، ولكل منها إجابة موجزة تغطي المقايضة، أو الحالة الحدية، أو نمط الإخفاق في الإنتاج الذي ينتظره المُقابِل. والإجابات مخفية: اقرأ السؤال، و**أجب بصوت عالٍ في نحو 30 ثانية**، ثم افتح الإجابة وقارن. الميزانية: **40 دقيقة** (نحو 45 ثانية لكل سؤال، مع التعليم).

## كيف تستخدم هذا البنك

1. أجب قبل أن تفتح. فإن لم تستطع البدء بإجابة خلال 10 ثوانٍ، فعلّم السؤال وامضِ.
2. حين تفتح إجابة، تحقق من *الآلية* و*نمط الإخفاق*، لا من الصياغة.
3. علّم كل سؤال: ✓ (متمكن)، ~ (جزئي)، ✗ (فاتك). وأعد زيارة ~ و✗ فقط في كتلة المراجعة النهائية (الدرس 18).
4. قل الإجابة بكلماتك مرة أخرى بعد قراءتها؛ فهذا ما ينقلها إلى الذاكرة.

## الأسئلة 401-450

@@QA qa/09-databases.txt@@

## الخلاصة

- علّم أسئلتك ~ و✗؛ فهي مدخلك إلى كتلة المراجعة النهائية.
- كل إجابة قوية تسمّي آلية، وكلفة، وما يحدث حين تفشل.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1710-01",
    "question": "أي فهرس يخدم `WHERE account_id = ? ORDER BY created_at DESC LIMIT 20` أفضل؟",
    "options": [
      "(account_id, created_at DESC)",
      "(created_at)",
      "(created_at, account_id)",
      "فهرس GIN"
    ],
    "correct": 0,
    "explanation": "عمود المساواة أولًا، ثم عمود الترتيب."
  },
  {
    "id": "kc-1710-02",
    "question": "لماذا قد يوقف `ALTER TABLE` قصير كل الحركة؟",
    "options": [
      "يعيد كتابة الجدول",
      "ينتظر قفل ACCESS EXCLUSIVE خلف معاملة طويلة بينما تصطف الاستعلامات الجديدة خلفه",
      "يعطّل الفهارس",
      "يشغّل VACUUM FULL"
    ],
    "correct": 1,
    "explanation": "اضبط lock_timeout وأعد المحاولة."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1710",
  "title": "تدريب على الأسئلة 401-450",
  "description": "حوّل القراءة إلى تذكر: أجب بصوت عالٍ أولًا، ثم تحقق.",
  "tasks": [
    {
      "id": "pc-1710-01",
      "description": "أجب عن الأسئلة 401-450 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها."
    },
    {
      "id": "pc-1710-02",
      "description": "اكتب DDL للقيود مع مشغّل توازن مؤجل واختبره بمُدخل غير متوازن."
    },
    {
      "id": "pc-1710-03",
      "description": "اشرح انحراف الكتابة بمثال الحد اليومي وإصلاحين."
    }
  ]
}
-->
