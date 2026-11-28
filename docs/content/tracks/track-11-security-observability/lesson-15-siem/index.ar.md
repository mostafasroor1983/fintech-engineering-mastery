---
id: track-11-lesson-15
title: "SIEM والأحداث الأمنية — ربط السجلات المالية"
slug: siem
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 15
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [SIEM, security-events, correlation, Splunk, detection]
prerequisites: [track-11-lesson-14]
---

# ‏SIEM والأحداث الأمنية — ربط السجلات المالية

> [!NOTE]
> الأحداث الأمنية المنفردة ضجيج. فمحاولة تسجيل دخول فاشلة واحدة أمر عادي. أما خمس محاولات فاشلة لـ 200 حساب مختلف من IP واحد خلال 60 ثانية فهي هجوم حشو بيانات اعتماد. وأنظمة SIEM موجودة لإيجاد هذه الأنماط عبر ملايين الأحداث التي لا يستطيع أي إنسان مراجعتها يدويًا.

## بنية SIEM للخدمات المالية

```
Log Sources                  Collection           SIEM Platform
──────────                   ──────────           ─────────────
Payment Service ──────────► Fluentd/Logstash ───► Splunk / Elastic SIEM
Auth Service   ──────────►  (parse, enrich,       │
Fraud Service  ──────────►   normalise)           │── Correlation Engine
Database       ──────────►                        │   (rules evaluate
WAF/API GW     ──────────►  Kafka Topic           │    continuously)
HSM/Vault      ──────────►  (security-events)     │
Kubernetes     ──────────►                        │── Alert Engine
Infrastructure ──────────►                        │   (fires when rule
Network Flow   ──────────►                        │    matches)
                                                  │
                                                  └── Case Management
                                                      (incident tracking)
```

لا يكون SIEM فعالًا إلا إذا كانت الأحداث المتدفقة إليه منظمة، ومتسقة، وتحتوي الحقول الصحيحة. فملفات السجل غير المنظمة تنتج اكتشافات صاخبة منخفضة الدقة.

---

## أنواع الأحداث الأمنية للخدمات المالية

### أحداث المصادقة

```java
@Component
public class AuthenticationEventPublisher implements
        ApplicationListener<AbstractAuthenticationEvent> {

    @Override
    public void onApplicationEvent(AbstractAuthenticationEvent event) {
        if (event instanceof AuthenticationSuccessEvent success) {
            publishSecurityEvent(SecurityEventBuilder.builder()
                .eventType("AUTHENTICATION_SUCCESS")
                .outcome("SUCCESS")
                .customerId(success.getAuthentication().getName())
                .ipAddress(getCurrentIpAddress())
                .userAgent(getCurrentUserAgent())
                .timestamp(Instant.now())
                .build());
        } else if (event instanceof AbstractAuthenticationFailureEvent failure) {
            publishSecurityEvent(SecurityEventBuilder.builder()
                .eventType("AUTHENTICATION_FAILURE")
                .outcome("FAILURE")
                .reason(failure.getException().getClass().getSimpleName())
                .attemptedUsername(failure.getAuthentication().getName())
                .ipAddress(getCurrentIpAddress())
                .userAgent(getCurrentUserAgent())
                .timestamp(Instant.now())
                .build());
        }
    }
}
```

### مخطط منظم للأحداث الأمنية

يجب أن تتبع كل الأحداث الأمنية مخططًا متسقًا ليتمكن SIEM من ربطها عبر المصادر. وبدل اختراع أسماء الحقول، فكّر في التوافق مع مخطط قياسي مثل Elastic Common Schema ‏(ECS) أو OCSF — فيعمل محتوى SIEM وقواعد الاكتشاف مباشرة دون تعديل.

```json
{
  "event": {
    "id": "evt-a3f7d2c1-1234-5678-abcd",
    "type": "AUTHENTICATION_FAILURE",
    "category": "authentication",
    "outcome": "failure",
    "severity": "medium",
    "timestamp": "2026-11-08T02:17:33.456Z",
    "source": "payment-service",
    "environment": "production",
    "version": "1.0"
  },
  "actor": {
    "type": "customer",
    "id": "CUST-123456",
    "email_hash": "sha256:a3f7...",
    "ip_address": "203.0.113.45",
    "ip_country": "GB",
    "user_agent": "Mozilla/5.0 ...",
    "session_id": "sess-abc123"
  },
  "target": {
    "type": "authentication_endpoint",
    "url": "/auth/login",
    "service": "auth-service"
  },
  "detail": {
    "failure_reason": "INVALID_PASSWORD",
    "attempt_count": 3,
    "mfa_required": true,
    "mfa_completed": false
  }
}
```

---

## قواعد الربط للخدمات المالية

تقيّم قواعد الربط تدفقات الأحداث في الوقت الفعلي. وتعرّف الأنماط التي تشير إلى هجمات أو شذوذ.

### القاعدة 1: اكتشاف حشو بيانات الاعتماد

```
RULE: credential_stuffing_detection
DESCRIPTION: Multiple accounts targeted from single IP in short window

TRIGGER:
  Count of AUTHENTICATION_FAILURE events
  WHERE actor.ip_address = X
  AND event.type = "AUTHENTICATION_FAILURE"
  AND detail.failure_reason = "INVALID_PASSWORD"
  GROUPED BY actor.ip_address
  WITHIN 60 seconds
  THRESHOLD > 10 distinct actor.id values

ALERT SEVERITY: HIGH
ACTION:
  1. Temporarily block IP address at WAF (auto-remediation via API)
  2. Create SIEM case for investigation
  3. Page security on-call team
  4. Notify fraud team

RATIONALE:
  Legitimate users don't fail authentication for 10 different accounts in 60 seconds.
  This pattern indicates automated credential stuffing from a botnet or proxy.
  Note: modern stuffing tools rotate through thousands of residential proxy IPs
  (a few attempts per IP), so pair this rule with one on the GLOBAL failure
  rate and failure ratio across all IPs.
```

### القاعدة 2: محاولة الاستيلاء على حساب

```
RULE: account_takeover_sequence
DESCRIPTION: Login from unusual location followed by payment submission

TRIGGER:
  Sequence within 10 minutes:
    Event 1: AUTHENTICATION_SUCCESS
      WHERE actor.ip_country != customer.usual_countries
      OR actor.device_id NOT IN customer.known_devices

    Event 2: PAYMENT_SUBMITTED
      WHERE actor.id = Event1.actor.id
      AND payment.amount > customer.average_payment_amount * 10

ALERT SEVERITY: CRITICAL
ACTION:
  1. Block the specific payment in real time (via fraud service API)
  2. Trigger step-up authentication for the customer
  3. Notify customer via SMS/email
  4. Create case for fraud investigation
```

### القاعدة 3: الوصول الإداري خارج ساعات العمل

```
RULE: after_hours_admin_access
DESCRIPTION: Admin account access outside business hours

TRIGGER:
  ADMIN_LOGIN event
  WHERE actor.role = "ADMIN"
  AND event.timestamp NOT IN 08:00-18:00 Monday-Friday UTC
  AND event.environment = "PRODUCTION"

ALERT SEVERITY: HIGH
ACTION:
  1. Send alert to security team (immediate Slack + PagerDuty)
  2. Log full session for review
  3. Require manager sign-off (auto-generate approval request)
```

### القاعدة 4: حجم معاملات شاذ

```
RULE: unusual_transaction_volume
DESCRIPTION: Sudden spike in transaction volume from single account

TRIGGER:
  Count of PAYMENT_SUBMITTED events
  WHERE actor.id = X
  WITHIN 1 hour
  > 3x the customer's 30-day rolling average for that hour
  AND total amount > £10,000

ALERT SEVERITY: MEDIUM
ACTION:
  1. Flag account for fraud review
  2. Apply enhanced fraud scoring to subsequent transactions
  3. Notify customer if threshold exceeded
```

---

## التكامل مع Splunk/Elastic SIEM

### تحويل السجلات المنظمة من Spring Boot

```xml
<!-- logback-spring.xml — structured JSON logs for SIEM ingestion -->
<configuration>
  <appender name="JSON_STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <includeCallerData>false</includeCallerData>
      <!-- Include MDC fields as top-level JSON keys for SIEM parsing -->
      <includeMdcKeyName>transactionId</includeMdcKeyName>
      <includeMdcKeyName>customerId</includeMdcKeyName>
      <includeMdcKeyName>sessionId</includeMdcKeyName>
      <includeMdcKeyName>ipAddress</includeMdcKeyName>
      <includeMdcKeyName>correlationId</includeMdcKeyName>
      <!-- Add service context to every log entry -->
      <customFields>{"service": "payment-service", "environment": "production"}</customFields>
    </encoder>
  </appender>

  <!-- Security events go to dedicated appender — higher reliability -->
  <appender name="SECURITY_EVENTS" class="ch.qos.logback.core.rolling.RollingFileAppender">
    <file>/var/log/payment-service/security-events.log</file>
    <encoder class="net.logstash.logback.encoder.LogstashEncoder"/>
    <rollingPolicy class="ch.qos.logback.core.rolling.TimeBasedRollingPolicy">
      <fileNamePattern>/var/log/payment-service/security-events.%d{yyyy-MM-dd}.log</fileNamePattern>
      <!-- Local buffer only: a shipper (Fluent Bit, Filebeat) forwards the file
           to the SIEM, which keeps the retention PCI DSS 10.5.1 requires
           (12 months, the last 3 immediately available) -->
      <maxHistory>7</maxHistory>
    </rollingPolicy>
  </appender>

  <!-- Security events use dedicated logger — separate from application logs -->
  <logger name="SECURITY_AUDIT" level="INFO" additivity="false">
    <appender-ref ref="SECURITY_EVENTS"/>
  </logger>

  <root level="INFO">
    <appender-ref ref="JSON_STDOUT"/>
  </root>
</configuration>
```

### استعلامات بحث Splunk لأمن الخدمات المالية

يجب إحاطة أسماء الحقول التي تحتوي نقاطًا بعلامات اقتباس مفردة داخل تعبيرات `eval` و`where`.

**اكتشاف حشو بيانات الاعتماد:**

```spl
index=payment_logs sourcetype=auth_events event.type="AUTHENTICATION_FAILURE"
| bucket span=1m _time
| stats dc(actor.id) as unique_accounts, count as attempts by _time, actor.ip_address
| where unique_accounts > 10
| sort -unique_accounts
| table _time, actor.ip_address, unique_accounts, attempts
```

**نمط احتيال الدفع — تسجيل دخول من دولة غير معتادة يليه دفع عالي القيمة** (تأتي الدولة المعتادة للعميل من جدول بحث، لأنها ليست في الأحداث):

```spl
index=payment_logs event.type IN ("AUTHENTICATION_SUCCESS", "PAYMENT_SUBMITTED")
| transaction actor.id maxspan=10m
    startswith=eval('event.type'="AUTHENTICATION_SUCCESS")
    endswith=eval('event.type'="PAYMENT_SUBMITTED")
| lookup customer_profile customer_id AS actor.id OUTPUT usual_country
| where mvindex('actor.ip_country', 0) != usual_country AND 'payment.amount' > 1000
| table _time, actor.id, actor.ip_country, usual_country, payment.amount, payment.destination_iban
```

**الوصول الإداري خارج ساعات العمل** (خارج 08:00–18:00 في أيام العمل، أو أي وقت في عطلة نهاية الأسبوع؛ اضبط المنطقة الزمنية التي تشير إليها ساعات العمل):

```spl
index=payment_logs event.type="ADMIN_LOGIN"
| eval hour = tonumber(strftime(_time, "%H")), weekday = tonumber(strftime(_time, "%u"))
| where hour < 8 OR hour >= 18 OR weekday >= 6
| table _time, actor.id, actor.ip_address, actor.ip_country, event.environment
```

**ارتفاع مفاجئ في حجم المدفوعات المرفوضة** (مقارنة بالمتوسط المتحرك لـ 168 ساعة السابقة = 7 أيام):

```spl
index=payment_logs event.type="PAYMENT_REJECTED"
| timechart span=1h count as rejected_count
| streamstats current=f window=168 avg(rejected_count) as rolling_avg
| where rejected_count > rolling_avg * 3
| table _time, rejected_count, rolling_avg
```

### قواعد اكتشاف Elastic SIEM ‏(EQL)

```
# Elastic Event Query Language (EQL) rules for payment security

# Rule: brute force on payment API — 5 failures from one IP within 1 minute
sequence by actor.ip_address with maxspan=1m
  [authentication where event.outcome == "failure"] with runs=5

# Rule: repeated failures followed by a success — the password was guessed
sequence by actor.id with maxspan=5m
  [authentication where event.outcome == "failure"] with runs=5
  [authentication where event.outcome == "success"]

# Rule: admin login followed by a data export or bulk payment
sequence by actor.id with maxspan=5m
  [authentication where actor.role == "ADMIN" and event.outcome == "success"]
  [any where event.type in ("DATA_EXPORT", "BULK_PAYMENT")]
```

تطابق تسلسلات EQL على مفاتيح ربط مشتركة (`by actor.id`)؛ ولا تستطيع مقارنة قيم الحقول *بين* الأحداث (مثل المسافة بين موقعي تسجيل دخول) ولا تذكّر السجل التاريخي. فلـ **السفر المستحيل** استخدم قاعدة ES|QL أو مهمة تعلم آلي، وللـ **سلوك لأول مرة** (مسؤول يصدّر بيانات لأول مرة) استخدم قاعدة *new terms*.

---

## سير عمل فرز التنبيهات

```
1. ALERT FIRES
   SIEM creates case automatically, assigns to on-call security analyst

2. INITIAL TRIAGE (within 15 minutes)
   Open case in SIEM
   Review triggering events in raw log view
   Determine: True positive or false positive?
   
   False positive indicators:
   - Known pentest IP address
   - Load test running
   - Known admin doing scheduled maintenance
   - Rule misconfigured (adjust rule, suppress)

   True positive indicators:
   - Unknown IP/country
   - Pattern matches known attack technique
   - Customer not aware of activity

3. TRUE POSITIVE RESPONSE
   Severity P3 (Low): Document, schedule investigation
   Severity P2 (Medium): Investigate within 2 hours, consider customer notification
   Severity P1 (High/Critical): Immediate response, escalate to incident response process

4. FALSE POSITIVE MANAGEMENT
   Document false positive in SIEM case
   Tune rule to reduce recurrence (tighten threshold, add exclusion)
   Monthly false positive review — rules with > 50% FP rate need rewriting
```

---

## تقليل الإيجابيات الكاذبة

```
Common false positives in financial SIEM and how to reduce them:

1. After-hours admin access
   False positive: Automated jobs running as admin service account
   Fix: Exclude known automation accounts from rule; create separate rule for human admin accounts

2. Unusual transaction volume
   False positive: End-of-month bulk payment processing
   Fix: Add time-of-month context; allowlist known bulk payment schedules

3. Multiple failed logins
   False positive: Mobile app aggressively retrying on network error
   Fix: Filter by user_agent to exclude known mobile app retry patterns

4. Geographic anomaly
   False positive: Customer using VPN
   Fix: Adjust threshold to require both geo anomaly AND other risk factor
```

---

## تقارير الامتثال من SIEM

يتوقع PCI DSS ‏(المتطلب 10) والجهات الرقابية (مثلًا بموجب قواعد إدارة مخاطر تقنية المعلومات والاتصالات في DORA) دليلًا على أن الأحداث الأمنية تُسجل وتُراجع.

**كل الوصول الإداري في آخر 90 يومًا** (يدعم PCI DSS 10.2.1.2 — تسجيل كل الإجراءات من الحسابات ذات الوصول الإداري):

```spl
index=payment_logs event.type="ADMIN_LOGIN" earliest=-90d
| stats count as login_count, 
        dc(actor.ip_address) as unique_ips,
        earliest(_time) as first_seen,
        latest(_time) as last_seen
  by actor.id, actor.ip_country
| outputlookup pci_admin_access_90d.csv
```

**تسجيلات الدخول الفاشلة في آخر 30 يومًا** (يدعم PCI DSS 10.2.1.4 — تسجيل محاولات الوصول المنطقي غير الصالحة):

```spl
index=payment_logs event.type="AUTHENTICATION_FAILURE" earliest=-30d
| stats count by actor.ip_address, detail.failure_reason
| sort -count
| head 100
```

---

## الخلاصات الأساسية

- لا يكون SIEM أفضل من الأحداث التي تغذيه: استثمر في تسجيل JSON منظم بأسماء حقول متسقة قبل الاستثمار في قواعد SIEM
- يجب أن تنمذج قواعد الربط سلوك المهاجم، لا الأحداث المنفردة فقط: فحشو بيانات الاعتماد غير مرئي عند النظر إلى أحداث منفردة، وواضح عند النظر إلى الأنماط عبر الأحداث
- يجب أن يغطي SIEM في الخدمات المالية: أحداث المصادقة، وعمليات الدفع، والوصول الإداري، والنشاط خارج ساعات العمل، وأنماط المعاملات الشاذة
- يتطلب فرز التنبيهات انضباطًا: قِس معدلات الإيجابيات الكاذبة شهريًا واضبط القواعد حين يتجاوز المعدل 50% — فإرهاق التنبيهات في مركز العمليات الأمنية (SOC) بخطورة إرهاق التنبيهات في الهندسة
- يفرض المتطلب 10 في PCI DSS سجلات تدقيق لكل مكونات النظام، ومراجعة يومية للأحداث الأمنية وسجلات الأنظمة الحرجة (10.4.1)، و— منذ 31 مارس 2025 — آليات آلية لتلك المراجعة (10.4.1.1)؛ وأتمتة SIEM هي طريقة تحقيق ذلك عمليًا
- ‏Elastic EQL وSplunk SPL أدوات قوية للتحقيق المخصص — ويجب أن يكون المحللون مرتاحين لكتابة الاستعلامات لمتابعة تنبيهات SIEM

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق الجوهري بين نظام SIEM ومنصة تجميع سجلات قياسية مثل Elasticsearch؟",
      "options": [
        "أنظمة SIEM تخزن بيانات سجلات أكثر",
        "أنظمة SIEM تربط الأحداث عبر مصادر متعددة بمرور الوقت لاكتشاف أنماط تشير إلى هجمات، بينما يخزن تجميع السجلات مُدخلات السجل المنفردة ويفهرسها للبحث فقط",
        "أنظمة SIEM أسرع في الاستعلام",
        "أنظمة SIEM تستطيع معالجة السجلات الأمنية فقط"
      ],
      "correct": 1,
      "explanation": "يجعل تجميع السجلات الأحداث المنفردة قابلة للبحث. ويضيف SIEM الربط — اكتشاف أن 5 محاولات دخول فاشلة لـ 200 حساب مختلف من IP واحد خلال 60 ثانية هجوم حشو بيانات اعتماد، وهو أمر غير مرئي عند النظر إلى مُدخلات سجل منفردة. ويطبق SIEM القواعد، والتعلم الآلي، والربط الزمني عبر ملايين الأحداث."
    },
    {
      "text": "أي متطلب في PCI DSS يفرض المراجعة اليومية للسجلات، وكيف تحقق أتمتة SIEM هذا المتطلب؟",
      "options": [
        "متطلب PCI DSS ‏6.3 — يحققه SIEM بفحص السجلات بحثًا عن ثغرات الكود",
        "متطلب PCI DSS ‏10 — تحقق أتمتة SIEM متطلب المراجعة اليومية بتطبيق قواعد الاكتشاف باستمرار وتوليد تنبيهات للنشاط المشبوه، مُنشئة سجل تدقيق آليًا لنشاط المراجعة",
        "متطلب PCI DSS ‏8.2 — يحققه SIEM بفرض سياسات كلمات المرور",
        "متطلب PCI DSS ‏12.1 — يحققه SIEM بالحفاظ على السياسات الأمنية"
      ],
      "correct": 1,
      "explanation": "يتطلب PCI DSS 10.4.1 مراجعة الأحداث الأمنية وسجلات مكونات النظام الحرجة يوميًا على الأقل، ويتطلب 10.4.1.1 ‏(إلزامي منذ 31 مارس 2025) آليات آلية لإجراء تلك المراجعات. ومع ملايين مُدخلات السجل اليومية، المراجعة البشرية مستحيلة. وتطبق أتمتة SIEM قواعد الاكتشاف باستمرار، وتولّد تنبيهات للشذوذ، وتنتج تقارير ملخصة يومية — فتحقق المتطلب، بينما يحقق المحللون فيما تُظهره الأتمتة."
    },
    {
      "text": "ما الإجراء الموصى به حين يتجاوز معدل الإيجابيات الكاذبة لقاعدة ربط في SIEM ‏50%؟",
      "options": [
        "تقبّل الإيجابيات الكاذبة — فكثرة التنبيهات أفضل من قلتها",
        "عطّل القاعدة كليًا واستبدلها بمراجعة يدوية",
        "اضبط القاعدة بإضافة شروط إضافية، أو رفع العتبات، أو إضافة استثناءات للأنماط المشروعة المعروفة — فإرهاق التنبيهات في مركز العمليات الأمنية بخطورة تفويت الهجمات الحقيقية",
        "زِد عدد المحللين لمعالجة الحجم"
      ],
      "correct": 2,
      "explanation": "قاعدة SIEM تولّد إيجابيات كاذبة أكثر من الإيجابيات الحقيقية تسبب إرهاق التنبيهات — فيتوقف المحللون عن التحقيق في التنبيهات لأنهم يتوقعون ضجيجًا. وهذا يعني أن الهجمات الحقيقية تبقى دون تحقيق. ويجب ضبط القواعد باستمرار باستخدام ملاحظات تحقيقات المحللين للحفاظ على معدل إيجابيات حقيقية قابل للإدارة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "قواعد اكتشاف SIEM للأحداث الأمنية المالية",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "صمّم تصنيفًا منظمًا للأحداث الأمنية لمنصة دفع: عرّف مخططات JSON لأحداث المصادقة (LOGIN_SUCCESS، وLOGIN_FAILURE، وMFA_FAILURE)، وأحداث الدفع (PAYMENT_SUBMITTED، وPAYMENT_APPROVED، وPAYMENT_REJECTED)، والأحداث الأمنية (RATE_LIMIT_EXCEEDED، وINVALID_TOKEN_PRESENTED، وSUSPICIOUS_ACTIVITY_DETECTED) بكل الحقول المطلوبة."
    },
    {
      "id": "2",
      "description": "اكتب قواعد اكتشاف Elastic EQL ‏(لغة استعلام الأحداث) لثلاثة أنماط هجوم: حشو بيانات اعتماد من IP واحد (>50 محاولة دخول فاشلة خلال 10 دقائق)، وإخفاقات متكررة يليها نجاح للحساب نفسه، واحتيال السرعة (>10 إرسالات دفع من عميل واحد خلال 5 دقائق). ثم اشرح أي نوع قاعدة (ES|QL، أو التعلم الآلي، أو new terms) ستستخدمه للسفر المستحيل ولماذا لا يستطيع EQL التعبير عنه."
    },
    {
      "id": "3",
      "description": "نفّذ SecurityAuditService في Spring Boot تكتب الأحداث الأمنية في جدول قاعدة بيانات للإلحاق فقط (باستخدام انتشار المعاملة REQUIRES_NEW) وتنشرها أيضًا إلى موضوع Kafka لاستيعاب SIEM، مع جعل عناوين IP مستعارة باستخدام تجزئة بمفتاح (HMAC) — ولاحظ أن البيانات المستعارة تظل بيانات شخصية بموجب GDPR، فتبقى قواعد الاحتفاظ والوصول سارية."
    },
    {
      "id": "4",
      "description": "أنشئ لوحة فرز تنبيهات SIEM في Grafana أو Kibana تُظهر: حجم التنبيهات حسب اسم القاعدة خلال 24 ساعة، ومعدل الإيجابيات الكاذبة لكل قاعدة (التنبيهات التي وسمها المحلل بـ 'لا حاجة لإجراء')، ومتوسط وقت الإغلاق حسب الخطورة، وجدولًا بالتنبيهات المفتوحة مرتبًا حسب الخطورة والعمر."
    }
  ]
}
-->
