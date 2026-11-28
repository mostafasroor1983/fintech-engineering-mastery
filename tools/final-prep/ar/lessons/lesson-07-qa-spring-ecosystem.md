---
id: "track-17-lesson-07"
title: "الأسئلة 251-300: Spring Security وCloud وBatch والمراسلة والذكاء الاصطناعي"
track: "track-17"
trackName: "التحضير النهائي للمقابلات"
sequence: 7
slug: "qa-spring-ecosystem"
difficulty: "senior"
estimatedMinutes: 40
status: "published"
lastUpdated: "2026-11-28"
tier: "core"
prerequisites: ["track-17-lesson-01"]
tags: ["spring-security", "spring-batch", "kafka", "spring-ai", "interview"]
references:
  - "Spring Security 7 Reference (docs.spring.io)"
  - "Spring for Apache Kafka and Spring Batch Reference Documentation (docs.spring.io)"
  - "Apache Kafka Documentation 4.x: Design and Semantics (kafka.apache.org)"
---

## في دقيقة واحدة

خمسون سؤال مقابلة عن Spring Security وOAuth2، والمرونة مع Spring Cloud وResilience4j، وقابلية إعادة التشغيل في Spring Batch، وKafka وRabbitMQ مع Spring، وSpring Integration، وSpring AI، وقابلية المراقبة، ولكل منها إجابة موجزة تغطي المقايضة، أو الحالة الحدية، أو نمط الإخفاق في الإنتاج الذي ينتظره المُقابِل. والإجابات مخفية: اقرأ السؤال، و**أجب بصوت عالٍ في نحو 30 ثانية**، ثم افتح الإجابة وقارن. الميزانية: **40 دقيقة** (نحو 45 ثانية لكل سؤال، مع التعليم).

## كيف تستخدم هذا البنك

1. أجب قبل أن تفتح. فإن لم تستطع البدء بإجابة خلال 10 ثوانٍ، فعلّم السؤال وامضِ.
2. حين تفتح إجابة، تحقق من *الآلية* و*نمط الإخفاق*، لا من الصياغة.
3. علّم كل سؤال: ✓ (متمكن)، ~ (جزئي)، ✗ (فاتك). وأعد زيارة ~ و✗ فقط في كتلة المراجعة النهائية (الدرس 18).
4. قل الإجابة بكلماتك مرة أخرى بعد قراءتها؛ فهذا ما ينقلها إلى الذاكرة.

## الأسئلة 251-300

@@QA qa/06-spring-ecosystem.txt@@

## الخلاصة

- علّم أسئلتك ~ و✗؛ فهي مدخلك إلى كتلة المراجعة النهائية.
- كل إجابة قوية تسمّي آلية، وكلفة، وما يحدث حين تفشل.

<!-- KNOWLEDGE-CHECK
[
  {
    "id": "kc-1707-01",
    "question": "تُعاد مهمة Spring Batch بعد فشلها في منتصفها. ماذا يجب أن يكون الكاتب؟",
    "options": [
      "سريعًا",
      "معاملاتيًا عبر كل الدفعات",
      "عديم الأثر عند التكرار، لأن دفعة معالجة جزئيًا قد تُشغّل مجددًا",
      "أحادي الخيط"
    ],
    "correct": 2,
    "explanation": "إعادة التشغيل تستأنف بعد آخر دفعة مؤكدة."
  },
  {
    "id": "kc-1707-02",
    "question": "دلالات EOS في Kafka مع مستهلك يكتب في PostgreSQL. ماذا تحتاج أيضًا؟",
    "options": [
      "لا شيء",
      "‏acks=0",
      "قسمًا واحدًا",
      "مستهلكًا عديم الأثر عند التكرار (جدول أحداث معالجة في معاملة قاعدة البيانات نفسها)"
    ],
    "correct": 3,
    "explanation": "‏EOS يغطي من Kafka إلى Kafka فقط."
  }
]
-->

<!-- PRACTICAL-CHALLENGE
{
  "id": "pc-1707",
  "title": "تدريب على الأسئلة 251-300",
  "description": "حوّل القراءة إلى تذكر: أجب بصوت عالٍ أولًا، ثم تحقق.",
  "tasks": [
    {
      "id": "pc-1707-01",
      "description": "أجب عن الأسئلة 251-300 بصوت عالٍ والإجابات مخفية، وعلّم الضعيفة منها."
    },
    {
      "id": "pc-1707-02",
      "description": "ارسم إعداد مستهلك Spring Kafka مع إعادات المحاولة، وموضوع رسائل ميتة، وكتابة عديمة الأثر عند التكرار."
    },
    {
      "id": "pc-1707-03",
      "description": "اشرح كيف تستخدم Spring AI في منتج منظَّم دون السماح للنموذج بنقل الأموال."
    }
  ]
}
-->
