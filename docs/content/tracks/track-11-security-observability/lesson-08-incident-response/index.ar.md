---
id: track-11-lesson-08
title: "الاستجابة للحوادث — أدلة المناوبة وكتيّبات التشغيل"
slug: incident-response
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 8
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [incident-response, runbook, playbook, P1, escalation]
prerequisites: [track-11-lesson-07]
---

# الاستجابة للحوادث — أدلة المناوبة وأدلة التشغيل

> [!NOTE]
> حادث في نظام دفع عند الثانية فجرًا ليس وقت الارتجال. والفرق بين حل في 15 دقيقة وانقطاع 3 ساعات يكاد يكون دائمًا الاستعداد: أدلة تشغيل مكتوبة مسبقًا، ومسارات تصعيد موثقة، وقوالب تواصل جاهزة، والتزامات تنظيمية مفهومة قبل أن يشتد الضغط.

## دورة حياة الاستجابة للحوادث

يتبع كل حادث في نظام الدفع دورة الحياة نفسها، بغض النظر عن السبب أو الخطورة:

```
DETECT → DECLARE → TRIAGE → MITIGATE → RESOLVE → POSTMORTEM
```

| المرحلة | الهدف | الإجراءات الأساسية | الزمن المستهدف |
|-------|------|-------------|-------------|
| الاكتشاف | معرفة وجود مشكلة | ينطلق تنبيه، وتُظهر المراقبة تدهورًا | < 5 دقائق من بدء الأثر |
| الإعلان | تعيين الملكية والخطورة | الإقرار بالاستدعاء، وتقييم P1/P2/P3، وتعيين قائد الحادث | < دقيقتين من التنبيه |
| الفرز | فهم ما تعطّل | فحص اللوحات، والسجلات، والنشرات الحديثة، وتحديد نطاق الضرر | < 10 دقائق |
| التخفيف | إيقاف النزيف | التراجع، أو قطع الدائرة، أو التوسيع، أو تعطيل مفتاح ميزة | < 15 دقيقة |
| الحل | الاستعادة الكاملة | تأكيد السبب الجذري، والخدمة تعمل بالكامل | يختلف حسب الخطورة |
| مراجعة ما بعد الحادث | منع التكرار | تحليل بلا لوم، وبنود عمل، ونشر الخط الزمني | خلال 5 أيام |

---

## تصنيف الخطورة لأنظمة الدفع

يحدد تصنيف الخطورة من توقظ ومدى سرعة تصرفك.

| الخطورة | التعريف | مثال | اتفاقية زمن الاستجابة |
|----------|-----------|---------|--------------|
| P1 — حرج | فشل كامل لمعالجة الدفع أو خطر على سلامة البيانات | واجهة الدفع تعيد 500 لكل المعاملات | فوري — مناوبة 24/7 |
| P2 — مرتفع | تدهور كبير يؤثر على >10% من المعاملات | زمن p99 > 10 ثوانٍ، وإخفاقات دفع جزئية | 30 دقيقة (ساعات العمل)، وساعة (الليالي/عطلات نهاية الأسبوع) |
| P3 — متوسط | تدهور جزئي، مع حل مؤقت متاح | فشل طريقة دفع محددة، أو تأخر التسوية | 4 ساعات في ساعات العمل فقط |
| P4 — منخفض | مشكلات صغيرة، بلا أثر على العملاء | تنبيه مراقبة متذبذب، أو تدهور خدمة غير حرجة | يوم العمل التالي |

للخدمات المالية الخاضعة للتنظيم، قد تطلق حوادث P1 المؤثرة على العملاء التزامات إبلاغ تنظيمي (انظر قسم الالتزامات التنظيمية).

---

## بنية دليل تشغيل المناوبة

دليل التشغيل دليل تشخيص ومعالجة خطوة بخطوة لتنبيه محدد. ويجيب عن: "انطلق التنبيه عند الثانية فجرًا، فماذا الآن؟"

### قالب دليل التشغيل

```markdown
# Runbook: [Alert Name]

## Overview
- **Service**: payment-service
- **Alert**: PaymentApiHighErrorRate
- **Severity**: P1
- **Team**: Payments Engineering
- **Last tested**: 2026-10-15

## Triggers
This runbook is triggered when:
- Payment API error rate exceeds 14x burn rate for > 2 minutes (SLO burn rate alert)
- More than 5% of payment transactions returning 5xx in the last 5 minutes

## Impact
- Customers cannot submit payments
- Standing orders and direct debits may fail to process
- May be reportable to regulators — assess against the firm's incident classification criteria (impact, duration, customers affected)

## Diagnosis Steps

### Step 1: Confirm the incident (2 minutes)
1. Open Grafana dashboard: https://grafana.example.com/d/payment-overview
2. Confirm: error rate elevated on `payment-service` pods?
3. Check: which endpoints are failing? (all endpoints vs specific paths)
4. Check: when did it start? (look for correlated deploy, config change, infrastructure event)

### Step 2: Check database connectivity (3 minutes)
~~~bash
# From payment-service pod
kubectl exec -n payments deployment/payment-service -- \
  curl -s http://localhost:8080/actuator/health | jq '.components.db'

# Expected healthy output:
# {"status": "UP", "details": {"database": "PostgreSQL", "result": 1}}

# If database is DOWN:
# → Check PostgreSQL pod: kubectl get pods -n data -l app=postgresql
# → Check connection pool: GET /actuator/metrics/hikaricp.connections.active
~~~

### Step 3: Check downstream dependencies (3 minutes)
~~~bash
# Fraud service health
curl -s http://fraud-service/actuator/health | jq '.status'

# Notification service
curl -s http://notification-service/actuator/health | jq '.status'

# External payment gateway (check status page: https://status.paymentgateway.com)
curl -s http://payment-service/actuator/health | jq '.components.paymentGateway'
~~~

### Step 4: Check Kafka consumer lag (2 minutes)
~~~bash
# If payment events are backed up, lag will be growing
kubectl exec -n kafka kafka-0 -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group payment-processor \
  --describe | awk '$1=="payment-processor" {print $2, $3, $6}'
# Columns: GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG ...
# printed: topic, partition, LAG
# LAG > 10,000 and growing = Kafka consumer is overwhelmed
~~~

### Step 5: Check recent deployments
~~~bash
# Recent rollouts in the last 2 hours
kubectl rollout history deployment/payment-service -n payments
# If recent deploy correlates with incident start time → rollback (Step 6a)
~~~

## Mitigation Options

### 6a: Rollback deployment (if deploy caused the issue)
~~~bash
# Rollback to previous version
kubectl rollout undo deployment/payment-service -n payments

# Monitor rollout
kubectl rollout status deployment/payment-service -n payments --timeout=5m

# Verify error rate drops within 2 minutes
# Dashboard: https://grafana.example.com/d/payment-overview
~~~

### 6b: Restart pods (if memory/thread issue)
~~~bash
# Rolling restart — does not cause downtime with 3+ replicas
kubectl rollout restart deployment/payment-service -n payments
~~~

### 6c: Scale up (if traffic spike)
~~~bash
# With an HPA, "kubectl scale" is overridden at the next evaluation --
# raise the HPA's minimum instead
kubectl patch hpa payment-service -n payments \
  --type=merge -p '{"spec":{"minReplicas":10}}'
kubectl get hpa -n payments
# (GitOps: commit the change afterwards, or self-heal will revert it)
~~~

### 6d: Fall back on the fraud check (if the fraud service is degraded)
ONLY with a fallback that the fraud/risk owner has approved IN ADVANCE --
e.g. local rules: approve low-value payments from known devices, queue or
decline the rest. Letting all payments through unchecked is a risk and
scheme-rule decision, not an on-call decision.
~~~bash
# Switch the pre-approved fallback on via the feature-flag service
# (instant, audited, no restart). "kubectl set env" would restart all pods
# and drift from Git -- avoid it for runtime switches
flagctl set fraud-check-mode=fallback-rules --env production \
  --reason "INC-2026-11-08-001"

# Notify the fraud/risk and compliance owners immediately;
# document the time in the incident channel
~~~

### 6e: Enable maintenance mode (last resort)
~~~bash
# Returns 503 with Retry-After to all payment endpoints
# Prevents partial failures and confusing error states
flagctl set maintenance-mode=on --env production --reason "INC-2026-11-08-001"
# Update status page: https://status.example.com/admin
~~~

## Escalation

| Condition | Escalate To | Via |
|-----------|-------------|-----|
| Database corruption suspected | DBA on-call | PagerDuty: dba-oncall |
| > 15 min outage | Engineering Manager | PagerDuty: eng-mgr-oncall |
| Regulatory notification threshold | Head of Operations | Phone: listed in ESCALATION.md |
| Security breach suspected | CISO / Security team | PagerDuty: security-oncall (do NOT use Slack) |

## Post-Incident Actions
- [ ] Confirm error rate returned to normal baseline
- [ ] Check for failed payments requiring retry or compensation
- [ ] Assess whether regulatory notification is required
- [ ] Schedule postmortem within 5 business days
- [ ] File Jira ticket for root cause fix
```

---

## تكامل PagerDuty مع Prometheus

```yaml
# alertmanager.yml — PagerDuty integration
receivers:
  - name: 'pagerduty-payments-p1'
    pagerduty_configs:
      # Alertmanager does not expand environment variables in its config:
      # read the key from a mounted secret file instead
      - routing_key_file: /etc/alertmanager/secrets/pagerduty-payments-key
        severity: critical
        description: '{{ .CommonAnnotations.summary }}'
        details:
          alert: '{{ .CommonLabels.alertname }}'
          environment: '{{ .CommonLabels.environment }}'
          service: '{{ .CommonLabels.job }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'
          dashboard: '{{ .CommonAnnotations.dashboard_url }}'
          value: '{{ .CommonAnnotations.description }}'
        # Link to Grafana for one-click context
        links:
          - href: '{{ .CommonAnnotations.dashboard_url }}'
            text: 'Grafana Dashboard'
          - href: '{{ .CommonAnnotations.runbook_url }}'
            text: 'Runbook'
        # Auto-resolve when alert clears
        send_resolved: true
```

```java
// Spring Boot — structured logs for incident correlation
// Logs indexed in ELK/Loki, searchable during incidents
@Slf4j
@Service
public class PaymentService {

    public PaymentResult processPayment(PaymentRequest request) {
        String txId = generateTransactionId();
        MDC.put("transactionId", txId);
        MDC.put("customerId", request.getCustomerId());   // internal ID, not a name
        MDC.put("currency", request.getCurrency());

        try {
            log.info("Payment processing started");
            PaymentResult result = executePayment(request);
            log.info("Payment processing completed status={}", result.getStatus());
            return result;
        } catch (Exception e) {
            log.error("Payment processing failed", e);
            throw e;
        } finally {
            MDC.clear();
        }
    }
}
```

---

## قوالب التواصل

أثناء حادث P1، انضباط التواصل بأهمية التشخيص التقني. واستخدم القوالب لضمان الاتساق ومنع الذعر.

### تواصل Slack الداخلي (قناة غرفة العمليات)

```
# INCIDENT DECLARED — #incident-payments-2026-11-08-001

**Severity**: P1
**Incident Commander**: @engineer-name
**Tech Lead**: @tech-lead-name
**Status**: TRIAGING
**Start Time**: 2026-11-08 02:17 UTC

**What we know**:
- Payment API error rate at 15% (14x SLO burn rate)
- Started ~02:15 UTC
- No recent deployment in the last 2 hours

**What we're checking**:
- Database connectivity (assigned: @engineer-a)
- Kafka consumer lag (assigned: @engineer-b)

**Next update**: in 10 minutes or on new information

---
# DO NOT speculate about cause in this channel until confirmed
# DO NOT DM individual engineers — post all updates here
```

### تحديث صفحة الحالة (موجه للعملاء)

```
# Template for status.example.com

INVESTIGATING: Payment processing degradation
Posted: 2026-11-08 02:20 UTC

We are aware of issues affecting payment processing. 
Our engineers are actively investigating.

Affected services: Payment submission, standing orders
Unaffected: Account viewing, card management, transaction history

We will post an update within 15 minutes.
```

### بريد أصحاب المصلحة (إذا تجاوزت المدة 30 دقيقة)

```
Subject: [P1 Incident] Payment Processing Degradation — Active Investigation

To: Head of Payments, Head of Operations, CTO
From: On-Call Engineer

SUMMARY: Payment processing is experiencing degraded performance.
We have an active incident response in progress.

IMPACT:
- Start time: 02:15 UTC
- Affected: Approximately 15% of payment submissions failing
- Unaffected: Account access, card controls, transaction history

CURRENT STATUS: Triaging. Root cause under investigation.

MITIGATION: If this continues beyond 15 minutes, we will apply
circuit breaking to prevent cascading failures.

NEXT UPDATE: 02:45 UTC or sooner if status changes.

Incident channel: #incident-payments-2026-11-08-001
```

---

## متطلبات الإبلاغ التنظيمي

للخدمات المالية الخاضعة للتنظيم مهل إبلاغ إلزامية للحوادث الكبيرة. والتأخر في إبلاغ المنظمين مخالفة تنظيمية مستقلة. والجدول نظرة عامة مبسطة — فالقواعد الدقيقة تعتمد على الترخيص، وحجم الكيان، ونوع الحادث، وتتغير مع الزمن:

| المنظم / القاعدة | النطاق | سبب الإبلاغ | المهلة |
|-----------|-------------|---------------------|----------|
| ‏FCA / PRA ‏(SUP 15، والقواعد الأساسية) | المملكة المتحدة | أمور يتوقع المنظم بشكل معقول إخطاره بها، مثل الحوادث التشغيلية الخطيرة | فورًا — تواصل أولي غير رسمي، ثم تفاصيل مكتوبة |
| ‏OCC / FDIC / الاحتياطي الفيدرالي | الولايات المتحدة | "حادث إبلاغ" (حادث أمن حاسوبي بأثر جوهري) | في أقرب وقت ممكن، وفي موعد لا يتجاوز 36 ساعة بعد التحديد |
| ‏RBI / CERT-In | الهند | حوادث الأمن السيبراني | خلال 6 ساعات |
| ‏DORA (السلطة المختصة الوطنية؛ وECB للبنوك المهمة) | الاتحاد الأوروبي | حادث كبير متعلق بتقنية المعلومات والاتصالات | أولي: 4 ساعات بعد التصنيف كحادث كبير، وبحد أقصى 24 ساعة بعد العلم؛ ووسيط: 72 ساعة؛ ونهائي: شهر |
| ‏GDPR (سلطة حماية البيانات) | الاتحاد الأوروبي / المملكة المتحدة | خرق بيانات شخصية بخطر على الأفراد | 72 ساعة بعد العلم |
| شبكات البطاقات / المستحوذ (سياق PCI) | عالمي | اشتباه باختراق بيانات حاملي البطاقات | فورًا، وفق قواعد الشبكة |

> [!WARNING]
> تبدأ معظم المهل من لحظة علمك بالحادث (أو تصنيفه)، لا من بدء الحادث. فوثّق الطوابع الزمنية للعلم، والتصنيف، والإعلان. واستشر رئيس المخاطر أو رئيس الامتثال قبل إرسال الإبلاغات التنظيمية — ولا تبلّغ ذاتيًا دون توجيه.

```java
// Incident tracking with regulatory notification flag
@Entity
@Table(name = "incidents")
public class Incident {
    @Id
    private String incidentId;
    private Instant startTime;
    private Instant detectedTime;      // When on-call was alerted
    private Instant declaredTime;      // When incident was formally declared
    private Severity severity;
    private boolean customerImpact;
    private boolean regulatoryNotificationRequired;
    private Instant regulatoryNotificationDeadline;  // Auto-computed from detectedTime
    private Instant regulatoryNotificationSentTime;
    private String status;             // OPEN, MITIGATED, RESOLVED
}
```

---

## ثقافة عدم اللوم في الخدمات المالية

لمراجعات ما بعد الحادث في الخدمات المالية أحيانًا أبعاد قانونية وتنظيمية، وهذا قد يثبط الإبلاغ الصادق. فابنِ ثقافة عدم اللوم صراحة.

### مبادئ مراجعات ما بعد الحادث بلا لوم

**الناس ليسوا المشكلة.** اتخذ المهندسون قرارات بالمعلومات والأدوات المتاحة لهم في ذلك الوقت. والسبب الجذري دائمًا مشكلة في النظام — عملية، أو أدوات، أو مراقبة، أو تصميم — لا فشل فردي.

**الخط الزمني بدل اللوم.** تبني مراجعة ما بعد الحادث خطًا زمنيًا لما حدث ومتى. ولا تنسب لومًا شخصيًا. بل تحدد العوامل المساهمة.

**خمسة "لماذا"، لا "من" واحدة.** بدل "من نشر الشيفرة المعيبة؟"، اسأل "لماذا وصل تغيير بهذا العيب إلى الإنتاج؟ ولماذا لم يكتشفه الاختبار؟ ولماذا لم يكن التراجع أسرع؟"

**بنود عمل، لا توبيخ.** تنتهي كل مراجعة ما بعد حادث ببنود عمل محددة ومعيّنة ومحددة زمنيًا لمنع التكرار. وهي تحسينات هندسية، لا إجراءات تأديبية.

### قالب مراجعة ما بعد الحادث

*مثال توضيحي لمراجعة ما بعد حادث:*

```markdown
# Postmortem: Payment Processing Degradation 2026-11-08

**Date**: 2026-11-08
**Duration**: 02:15 UTC — 02:47 UTC (32 minutes)
**Severity**: P1
**Author**: @incident-commander
**Status**: Draft (review by 2026-11-13)

## Impact
- 15% of payment submissions failed for 32 minutes
- ~4,800 failed payment attempts (estimated)
- 0 payments lost (failed requests retried successfully by clients)
- Regulatory notification assessed against the firm's criteria: not reportable (partial degradation, no data compromise)

## Timeline (UTC)
| Time | Event |
|------|-------|
| 02:12 | HikariCP leak detection alert fires (ignored — no runbook) |
| 02:15 | Payment error rate crosses 14x burn rate threshold |
| 02:16 | PagerDuty fires PaymentApiSLOBudgetBurnRateCritical |
| 02:17 | On-call acknowledges, declares P1, opens war room |
| 02:19 | Database confirmed UP, Kafka lag normal |
| 02:24 | HikariCP active connections at maximum (20/20) |
| 02:26 | Root cause identified: slow query from upstream marketing service |
| 02:31 | Circuit breaker enabled to marketing data lookup (feature flag) |
| 02:33 | Error rate returns to baseline |
| 02:47 | Incident resolved, monitoring confirmed normal |

## Root Cause
A marketing service deployed at 01:48 UTC began calling payment-service's
internal `/customer-segment` endpoint on every payment event, triggering
a full table scan on the transactions table. This held JDBC connections
for 15-30 seconds each, exhausting HikariCP's 20-connection pool.

## Contributing Factors
1. The `/customer-segment` endpoint had no query timeout configured
2. HikariCP leak detection alert had no runbook — ignored at 02:12
3. Marketing service deployment did not go through payments team review
4. No rate limiting on internal `/customer-segment` endpoint

## Action Items
| Item | Owner | Due | Ticket |
|------|-------|-----|--------|
| Add 2s query timeout to all JPA queries via @QueryHints | @engineer-a | 2026-11-15 | PAY-1234 |
| Write runbook for HikariCP connection exhaustion alert | @engineer-b | 2026-11-12 | PAY-1235 |
| Add rate limiting to all internal service endpoints | @engineer-c | 2026-11-22 | PAY-1236 |
| Require payments team review for services that call payment-service | @eng-manager | 2026-11-30 | PAY-1237 |
| Add HikariCP pool exhaustion as explicit SLO indicator | @engineer-a | 2026-11-15 | PAY-1238 |

## What Went Well
- SLO burn rate alerting fired quickly (5 minutes from impact start)
- War room communication was orderly — no duplicate work
- Circuit breaker mitigation was fast once root cause identified
- No data loss or regulatory breach

## What Could Be Improved
- HikariCP leak detection alert should have been investigated immediately at 02:12
- Runbook for database connection exhaustion was missing
- 9 minutes from alert to root cause identification — target is < 5 minutes
```

---

## الخلاصات الأساسية

- نظّم كل دليل تشغيل بالأقسام نفسها: المُطلِقات، وخطوات التشخيص، وخيارات التخفيف، ومسارات التصعيد — يجب أن يستطيع المهندسون التنفيذ في الثانية فجرًا دون قراءة توثيق
- يقود تصنيف الخطورة التصعيد: يجب أن تكون استجابة P1 فورية، ويمكن أن تنتظر P2/P3 ساعات العمل
- تبدأ مهل الإبلاغ التنظيمي عمومًا من العلم (أو التصنيف)، لا من بدء الحادث — وثّق متى علمت وأعلنت الحادث
- تمنع قوالب التواصل الذعر وتضمن رسائل متسقة للعملاء وأصحاب المصلحة
- مراجعات ما بعد الحادث بلا لوم مع بنود عمل محددة هي الآلية الأساسية لتحسين الموثوقية في أنظمة الدفع
- أثمن استثمار في الاستجابة للحوادث كتابة أدلة التشغيل قبل وقوع الحوادث، لا بعدها

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "وفق معظم قواعد الإبلاغ عن الحوادث والخروقات (مثل 72 ساعة في GDPR، وقاعدة الـ 36 ساعة الأمريكية، وDORA)، من أي نقطة تبدأ ساعة الإبلاغ عادةً؟",
      "options": ["حين يُحل الحادث بالكامل", "حين يكمل فريق الأمان تحقيقه", "من لحظة العلم — حين علمت المؤسسة أو كان يجب أن تعلم بالحادث", "حين يُفصح عن الحادث علنًا"],
      "correct": 2,
      "explanation": "تبدأ مهل الإبلاغ من لحظة العلم (أو، وفق DORA، من تصنيف الحادث ككبير — وفي موعد لا يتجاوز 24 ساعة بعد العلم)، لا من حل الحادث. ويتيح GDPR ‏72 ساعة بعد العلم بخرق بيانات شخصية؛ ويتوقع منظمو البنوك الأمريكيون الإخطار خلال 36 ساعة من تحديد حادث إبلاغ. ولهذا يجب أن يوثّق قادة الحوادث فورًا متى اكتُشف الحادث وصُنّف وأُعلن — كي لا تفوت المهل في فوضى الاستجابة."
    },
    {
      "text": "ما الغرض الأساسي من مراجعة ما بعد الحادث بلا لوم في فريق هندسي للخدمات المالية؟",
      "options": ["تحديد المهندس الذي سبب الحادث ومعاقبته", "إنشاء سجل مكتوب للأغراض التنظيمية", "تحديد العوامل النظامية والتحسينات القابلة للتنفيذ دون خلق ثقافة خوف تثبط الشفافية مستقبلًا", "تلبية متطلبات التوثيق لفريق SRE"],
      "correct": 2,
      "explanation": "تركز مراجعات ما بعد الحادث بلا لوم على الأسباب النظامية — العمليات، والأدوات، وفجوات المراقبة — بدل اللوم الفردي. فحين يخشى المهندسون اللوم، يحجبون المعلومات أثناء الحوادث (فيبطئ الحل) ويتجنبون الإبلاغ عن الحوادث الوشيكة (فتضيع فرص التعلم). وثقافة عدم اللوم شرط مسبق للموثوقية."
    },
    {
      "text": "في الحادث من الدرس، ما السبب الجذري لاستنفاد مجمّع اتصالات HikariCP الذي استغرق تحديده 9 دقائق؟",
      "options": ["فشل خادم قاعدة البيانات", "نشر لخدمة التسويق استدعى نقطة في payment-service مع كل حدث دفع، فأطلق مسحًا كاملًا للجدول حجز الاتصالات 15-30 ثانية", "ذروة في تأخر مستهلكي Kafka", "شهادة TLS منتهية الصلاحية"],
      "correct": 1,
      "explanation": "بدأت خدمة التسويق المنشورة عند 01:48 UTC باستدعاء نقطة /customer-segment في payment-service مع كل حدث دفع. وأطلق هذا مسحًا كاملًا لجدول المعاملات، فحجز اتصالات JDBC لمدة 15-30 ثانية لكل منها واستنفد مجمّع HikariCP ذا الاتصالات العشرين. ولم يكن لتنبيه كشف تسرب HikariCP دليل تشغيل فتُجوهل عند 02:12."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "دليل تشغيل الاستجابة للحوادث ومراجعة ما بعد الحادث",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    {"id": "1", "description": "اكتب دليل تشغيل كاملًا لاستنفاد مجمّع اتصالات HikariCP في خدمة دفع Spring Boot: شروط الإطلاق، وأوامر تشخيص خطوة بخطوة (kubectl، واستعلامات SQL، وفحوص المقاييس)، وثلاثة خيارات تخفيف مرتبة حسب الخطر، ومسار التصعيد، وشجرة قرار الإبلاغ التنظيمي."},
    {"id": "2", "description": "صمّم مصفوفة تصنيف خطورة الحوادث لمنصة دفع بمستويات P1-P4، محددًا لكل مستوى: عتبة الأثر على العملاء، واتفاقية زمن الاستجابة، ومسار التصعيد، ووتيرة التواصل، ومُطلِق الإبلاغ التنظيمي."},
    {"id": "3", "description": "اكتب بوت Slack أو معالج webhook ينشئ تلقائيًا قناة غرفة عمليات حين ينطلق تنبيه P1 من PagerDuty، وينشر رابط دليل التشغيل، ويعيّن قائد حادث من دورة المناوبة، ويرسل أول قالب تواصل مع العملاء."},
    {"id": "4", "description": "أجرِ تمرينًا مكتبيًا: بالاعتماد على الخط الزمني للحادث من هذا الدرس (خدمة التسويق تسبب استنفاد مجمّع الاتصالات)، اكتب مراجعة ما بعد حادث كاملة بلا لوم بخط زمني، وسبب جذري، وعوامل مساهمة، و5 بنود عمل محددة (لكل منها مالك وتاريخ استحقاق)، وما سار جيدًا."}
  ]
}
-->
