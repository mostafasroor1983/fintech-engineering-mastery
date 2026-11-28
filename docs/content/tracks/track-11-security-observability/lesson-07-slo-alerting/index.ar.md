---
id: track-11-lesson-07
title: "التنبيه القائم على SLO — معدل الاستهلاك وإرهاق التنبيهات"
slug: slo-alerting
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 7
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [SLO, alerting, burn-rate, multi-window, alert-fatigue]
prerequisites: [track-11-lesson-06]
---

# التنبيه القائم على أهداف مستوى الخدمة — معدل الحرق وإرهاق التنبيهات

> [!NOTE]
> تنطلق التنبيهات القائمة على العتبات ("معدل الأخطاء > 1%") باستقلال عن هدف مستوى الخدمة (SLO)، فتسبب إرهاق التنبيهات حين تكون العتبة غير ذات صلة وصمتًا حين تهم. أما التنبيه بمعدل الحرق فينطلق بدقة حين تُستهلك ميزانية الخطأ أسرع من المستدام — فيعطيك إنذارًا مسبقًا يتناسب مع أثر العمل.

## مشكلة التنبيه القائم على العتبات

يسأل التنبيه التقليدي: "هل هذا المقياس فوق عتبة الآن؟" ولهذا النهج نمطا فشل متوطنان في أنظمة الدفع:

**صاخب جدًا**: ينطلق تنبيه مع كل ومضة فوق 1% من الأخطاء، حتى لو دامت 30 ثانية واستهلكت 0.001% من ميزانية الخطأ الشهرية. فيتعلم مهندسو المناوبة تجاهل هذه التنبيهات — إرهاق التنبيهات الكلاسيكي.

**صامت جدًا**: معدل أخطاء مستمر 0.9% يعمل أسابيع تحت العتبة، فيستهلك 90% من ميزانية الخطأ قبل أن يلاحظ أحد.

يسأل التنبيه القائم على SLO: "هل تُستهلك ميزانية الخطأ أسرع من المستدام؟" فيربط التنبيه مباشرة بأثر المستخدم والتزامات العمل.

---

## أسس ميزانية الخطأ ومعدل الحرق

### تعريف ميزانية الخطأ

لواجهة دفع بهدف توفر 99.9% على مدى 30 يومًا:

```
Total minutes in 30 days = 43,200
Error budget = (1 - 0.999) × 43,200 = 43.2 minutes of downtime allowed
```

وبالمكافئ، بعدد الطلبات: إذا تلقت الواجهة 1,000 طلب في الدقيقة:

```
Total requests in 30 days = 43,200,000
Allowed failures = 0.001 × 43,200,000 = 43,200 failed requests
```

### معدل الحرق

معدل الحرق نسبة معدل الأخطاء الحالي إلى معدل الأخطاء الذي سيستنفد الميزانية بالضبط خلال 30 يومًا.

```
1× burn rate = consuming the entire budget in exactly 30 days
                = 0.1% error rate for a 99.9% SLO

2× burn rate = consuming the budget in 15 days
                = 0.2% error rate for a 99.9% SLO

14× burn rate = consuming the budget in ~2 days
                = 1.4% error rate for a 99.9% SLO
```

### صيغة معدل الحرق

```
burn_rate = (error_rate_observed / error_rate_at_slo_boundary)

For 99.9% SLO:
  error_rate_at_slo_boundary = 1 - 0.999 = 0.001 (0.1%)

  If current error_rate = 0.014 (1.4%):
  burn_rate = 0.014 / 0.001 = 14×
```

---

## التنبيه متعدد النوافذ ومتعدد معدلات الحرق

يعرّف كتاب Google SRE Workbook المعيار الذهبي: نبّه على نافذتين في آن واحد لتقليل الإنذارات الكاذبة (الذروات القصيرة) والإغفالات (التسربات البطيئة) معًا.

### تركيبات التنبيه الأربع

| التنبيه | النافذة الطويلة | النافذة القصيرة | معدل الحرق | الميزانية المستهلكة | الإجراء |
|-------|-------------|-------------|-----------|-----------------|--------|
| P1 حرج | ساعة | 5 دقائق | 14× | 2% في ساعة | استدعاء فوري |
| P2 مرتفع | 6 ساعات | 30 دقيقة | 6× | 5% في 6 ساعات | استدعاء (ساعات العمل) |
| P3 متوسط | يوم | ساعتان | 3× | 10% في يوم | تذكرة |
| P4 منخفض | 3 أيام | 6 ساعات | 1× | 10% في 3 أيام | مراجعة أسبوعية |

**لماذا نافذتان لكل تنبيه؟**

تثبت النافذة الطويلة أن جزءًا كبيرًا من الميزانية احترق فعلًا — فذروة قصيرة لا تستطيع رفع متوسط ساعة فوق 14×. وتثبت النافذة القصيرة أن المشكلة *ما زالت تحدث*، فيتوقف التنبيه بعد التعافي بقليل بدل أن يستمر ساعة أخرى بينما يتراجع المتوسط الطويل. ويجب أن يتحقق الاثنان في آن واحد للانطلاق.

لتنبيه P1 ‏(معدل حرق 14×):
- النافذة الطويلة (ساعة): ذهب بالفعل نحو 2% على الأقل من الميزانية الشهرية — ولا تستطيع ومضة 10 ثوانٍ فعل ذلك
- النافذة القصيرة (5 دقائق): معدل الأخطاء مرتفع الآن؛ وبمجرد وصول الإصلاح، يزول التنبيه خلال دقائق

---

## قواعد تسجيل Prometheus لكفاءة SLO

حساب نسب الأخطاء على نوافذ طويلة في كل تقييم تنبيه مكلف. فاستخدم قواعد التسجيل لحسابها مسبقًا.

### إعداد قواعد التسجيل

```yaml
# prometheus/recording-rules.yml
groups:
  - name: slo_payment_api
    interval: 60s
    rules:

      # 5-minute error ratio
      - record: job:payment_api_errors:rate5m
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[5m]))
          /
          sum(rate(http_requests_total{job="payment-api"}[5m]))

      # 30-minute error ratio
      - record: job:payment_api_errors:rate30m
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[30m]))
          /
          sum(rate(http_requests_total{job="payment-api"}[30m]))

      # 1-hour error ratio
      - record: job:payment_api_errors:rate1h
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[1h]))
          /
          sum(rate(http_requests_total{job="payment-api"}[1h]))

      # 2-hour error ratio
      - record: job:payment_api_errors:rate2h
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[2h]))
          /
          sum(rate(http_requests_total{job="payment-api"}[2h]))

      # 6-hour error ratio
      - record: job:payment_api_errors:rate6h
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[6h]))
          /
          sum(rate(http_requests_total{job="payment-api"}[6h]))

      # 1-day error ratio
      - record: job:payment_api_errors:rate1d
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[1d]))
          /
          sum(rate(http_requests_total{job="payment-api"}[1d]))

      # 3-day error ratio
      - record: job:payment_api_errors:rate3d
        expr: |
          sum(rate(http_requests_total{job="payment-api", status=~"5.."}[3d]))
          /
          sum(rate(http_requests_total{job="payment-api"}[3d]))

      # Error budget remaining (percentage)
      - record: job:payment_api_error_budget_remaining:ratio
        expr: |
          1 - (
            sum(increase(http_requests_total{job="payment-api", status=~"5.."}[30d]))
            /
            (sum(increase(http_requests_total{job="payment-api"}[30d])) * 0.001)
          )
```

### قواعد التنبيه

```yaml
# prometheus/alert-rules.yml
groups:
  - name: slo_payment_api_burn_rate
    rules:

      # P1 — CRITICAL: 14x burn rate (fast burn)
      # Fires when: 1h window AND 5m window both show >= 14x burn
      # Meaning: at this rate, all 30-day error budget exhausted in ~2 days
      - alert: PaymentApiSLOBudgetBurnRateCritical
        expr: |
          (
            job:payment_api_errors:rate1h > (14 * 0.001)
            and
            job:payment_api_errors:rate5m > (14 * 0.001)
          )
        for: 2m
        labels:
          severity: critical
          slo: payment_api_availability
          team: payments
        annotations:
          summary: "Payment API SLO: critical burn rate {{ $value | humanizePercentage }} (14x)"
          description: |
            Error rate {{ $value | humanizePercentage }} is 14x the SLO budget rate.
            At this rate, the monthly error budget will be exhausted in ~2 days.
            Current error budget remaining: {{ query "job:payment_api_error_budget_remaining:ratio" | first | value | humanizePercentage }}
          runbook_url: "https://wiki.example.com/runbooks/payment-api-slo-burn"
          dashboard_url: "https://grafana.example.com/d/payment-slo/payment-api-slo"

      # P2 — HIGH: 6x burn rate (medium burn)
      # Fires when: 6h window AND 30m window both show >= 6x burn
      # Meaning: at this rate, all 30-day budget exhausted in ~5 days
      - alert: PaymentApiSLOBudgetBurnRateHigh
        expr: |
          (
            job:payment_api_errors:rate6h > (6 * 0.001)
            and
            job:payment_api_errors:rate30m > (6 * 0.001)
          )
        for: 15m
        labels:
          severity: high
          slo: payment_api_availability
          team: payments
        annotations:
          summary: "Payment API SLO: elevated burn rate {{ $value | humanizePercentage }} (6x)"
          description: |
            Error rate {{ $value | humanizePercentage }} is 6x the SLO budget rate.
            At this rate, the monthly error budget will be exhausted in ~5 days.
          runbook_url: "https://wiki.example.com/runbooks/payment-api-slo-burn"

      # P3 — MEDIUM: 3x burn rate (slow burn)
      - alert: PaymentApiSLOBudgetBurnRateMedium
        expr: |
          (
            job:payment_api_errors:rate1d > (3 * 0.001)
            and
            job:payment_api_errors:rate2h > (3 * 0.001)
          )
        for: 1h
        labels:
          severity: medium
          slo: payment_api_availability
          team: payments
        annotations:
          summary: "Payment API SLO: elevated burn rate (3x) — investigate during business hours"

      # Budget exhaustion alert
      - alert: PaymentApiSLOErrorBudgetLow
        expr: job:payment_api_error_budget_remaining:ratio < 0.10
        for: 5m
        labels:
          severity: high
          slo: payment_api_availability
        annotations:
          summary: "Payment API error budget below 10% — only {{ $value | humanizePercentage }} remaining this month"
```

---

## التنبيه على SLO الزمن

لواجهات الدفع، أهداف مستوى الخدمة للزمن بأهمية التوفر. والهدف هنا: 99.9% من إرسالات الدفع تكتمل في أقل من 500ms (والطلبات الأبطأ تُعد "سيئة"). وهذا يتطلب حد سلة في المدرج التكراري عند 0.5 ثانية بالضبط.

```yaml
# Recording rules for latency
groups:
  - name: slo_payment_latency
    rules:

      # Fraction of requests meeting the latency SLO (< 500ms)
      - record: job:payment_api_latency_slo:rate5m
        expr: |
          sum(rate(http_request_duration_seconds_bucket{
            job="payment-api",
            le="0.5"
          }[5m]))
          /
          sum(rate(http_request_duration_seconds_count{job="payment-api"}[5m]))

      - record: job:payment_api_latency_slo:rate1h
        expr: |
          sum(rate(http_request_duration_seconds_bucket{
            job="payment-api",
            le="0.5"
          }[1h]))
          /
          sum(rate(http_request_duration_seconds_count{job="payment-api"}[1h]))

      # Latency error ratio (1 - compliance)
      - record: job:payment_api_latency_errors:rate1h
        expr: 1 - job:payment_api_latency_slo:rate1h

      - record: job:payment_api_latency_errors:rate5m
        expr: 1 - job:payment_api_latency_slo:rate5m

# Alert on latency budget burn
  - name: slo_payment_latency_alerts
    rules:
      - alert: PaymentApiLatencySLOBurnRateCritical
        expr: |
          (
            job:payment_api_latency_errors:rate1h > (14 * 0.001)
            and
            job:payment_api_latency_errors:rate5m > (14 * 0.001)
          )
        for: 2m
        labels:
          severity: critical
          slo: payment_api_latency
        annotations:
          summary: "Payment API latency SLO: critical burn rate"
          description: "Slow requests (> 500ms) are arriving at more than 14x the rate the latency SLO allows."
```

---

## التوجيه والكبت في Alertmanager

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m
  slack_api_url: 'https://hooks.slack.com/services/...'

route:
  receiver: 'default'
  group_by: ['slo', 'team', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
    # Critical SLO burns → PagerDuty immediately (24/7)
    - matchers:                     # "match:" is the deprecated older syntax
        - severity="critical"
        - slo="payment_api_availability"
      receiver: 'pagerduty-payments-critical'

    # High SLO burns → PagerDuty with business hours schedule
    - matchers:
        - severity="high"
        - slo="payment_api_availability"
      receiver: 'pagerduty-payments-high'

    # Medium burns → Slack channel during business hours
    - matchers:
        - severity="medium"
      receiver: 'slack-payments-team'
      active_time_intervals:
        - business_hours

receivers:
  - name: 'default'
    slack_configs:
      - channel: '#alerts-unrouted'

  - name: 'pagerduty-payments-critical'
    pagerduty_configs:
      - routing_key: '<PAGERDUTY_KEY>'
        severity: critical
        description: '{{ template "pagerduty.description" . }}'
        details:
          slo: '{{ .CommonLabels.slo }}'
          runbook: '{{ .CommonAnnotations.runbook_url }}'
          dashboard: '{{ .CommonAnnotations.dashboard_url }}'

  - name: 'pagerduty-payments-high'
    pagerduty_configs:
      - routing_key: '<PAGERDUTY_KEY_BUSINESS_HOURS>'
        severity: error

  - name: 'slack-payments-team'
    slack_configs:
      - channel: '#payments-alerts'
        title: 'SLO Alert: {{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'
        actions:
          - type: button
            text: 'Runbook'
            url: '{{ .CommonAnnotations.runbook_url }}'

inhibit_rules:
  # If P1 fires, suppress P2 and P3 for the same SLO (avoid alert storm)
  - source_matchers:
      - severity="critical"
    target_matchers:
      - severity=~"high|medium"
    equal: ['slo', 'team']

  # Suppress component alerts when parent service is down
  - source_matchers:
      - alertname="PaymentServiceDown"
    target_matchers:
      - team="payments"
    equal: ['environment']

time_intervals:
  - name: business_hours
    time_intervals:
      - times:
          - start_time: '08:00'
            end_time: '18:00'
        weekdays: ['monday:friday']
        location: 'Europe/London'
```

---

## تقليل إرهاق التنبيهات

إرهاق التنبيهات أكبر مشكلة موثوقية في معظم المؤسسات الهندسية. فيتوقف المهندسون عن الاستجابة للاستدعاءات لأن كثيرًا منها ضجيج.

### تشخيص الإرهاق

قِس هذه المقاييس على نظام التنبيه لديك شهريًا:

| المقياس | سليم | يحتاج اهتمامًا |
|--------|---------|-----------------|
| نسبة التنبيهات إلى الحوادث | < 3:1 | > 10:1 |
| متوسط زمن الإقرار | < 5 دقائق | > 15 دقيقة |
| حُلّت تلقائيًا (انطلقت دون حاجة لإجراء) | < 20% | > 50% |
| تنبيهات مكتومة/صامتة | < 10% | > 30% |

### مبادئ جودة التنبيه

**كل تنبيه يجب أن يتطلب إجراءً بشريًا.** فإذا أمكن لتنبيه أن يُحل تلقائيًا بأمان دون تحقيق، فلا يجب أن يستدعي أحدًا. انقله إلى مقياس على لوحة.

**يجب أن تكون التنبيهات عاجلة.** فإذا أمكن أن تنتظر المشكلة حتى ساعات العمل، فوجّهها إلى Slack. واستدعاء المهندسين في الثانية فجرًا لمسائل غير عاجلة يدمّر معنويات الفريق ويقود إلى عمى التنبيهات.

**يجب أن تكون التنبيهات قابلة للتنفيذ.** فرابط دليل التشغيل في كل تنبيه ليس اختياريًا — إنه الفرق بين حل في 5 دقائق وتحقيق في 30 دقيقة. وإذا لم تستطع كتابة دليل تشغيل لتنبيه، فالتنبيه غير جاهز للإنتاج.

**تجنب تكرار التنبيهات.** استخدم قواعد الكبت في Alertmanager لكبت التنبيهات الأقل خطورة حين يغطي تنبيه أعلى خطورة الفشل نفسه بالفعل. فإذا كانت خدمة الدفع متوقفة، اكبت كل تنبيهات المكونات اللاحقة.

### إعداد إزالة تكرار التنبيهات

```java
// Spring Boot — consistent labels for effective grouping.
// Use the built-in http.server.requests metrics (status, uri, method tags
// included) and add the same common tags to every meter.
// Don't add a "job" tag yourself: Prometheus sets "job" at scrape time,
// and a clashing metric label is renamed to "exported_job". And don't put
// ".total" in counter names -- the Prometheus registry adds "_total" itself.
@Configuration
public class MetricsTagsConfig {

    @Bean
    public MeterFilter commonTags() {
        return MeterFilter.commonTags(List.of(
            Tag.of("service", "payment-service"),
            Tag.of("team", "payments")));
    }
}
// Equivalent in application.yml:
//   management.metrics.tags.service: payment-service
//   management.metrics.tags.team: payments
```

---

## مثال SLO لواجهة دفع: الإعداد الكامل

**تعريفات SLO لواجهة معالجة دفع:**

| الـ SLO | الهدف | النافذة | ميزانية الخطأ |
|-----|--------|--------|--------------|
| التوفر | نجاح 99.9% من الطلبات | 30 يومًا | 0.1% من الطلبات (≈ 43.2 دقيقة) |
| الزمن | 99.9% من الطلبات < 500ms | 30 يومًا | يمكن أن يكون 0.1% من الطلبات أبطأ |
| الزمن (المعتاد) | 50% من الطلبات < 100ms | 30 يومًا | ميزانيته الخاصة: يمكن أن يكون 50% أبطأ |

لكل SLO ميزانية خطأ **خاصة** به وتنبيهات معدل حرق خاصة به.

```yaml
# slo-definitions.yml — source of truth, referenced by alerts
slos:
  payment_api_availability:
    description: "Payment submission API availability"
    target: 0.999
    window: 30d
    sli:
      type: availability
      metric: http_requests_total
      good_filter: 'job="payment-api",status!~"5.."'
      total_filter: 'job="payment-api"'
    alert_burn_rates:
      - burn_rate: 14
        windows: [1h, 5m]
        severity: critical
      - burn_rate: 6
        windows: [6h, 30m]
        severity: high
      - burn_rate: 3
        windows: [1d, 2h]
        severity: medium

  payment_api_latency_500ms:
    description: "99.9% of payment submissions faster than 500ms"
    target: 0.999
    window: 30d
    sli:
      type: latency
      metric: http_request_duration_seconds_bucket
      threshold_seconds: 0.5
      filter: 'job="payment-api"'
```

---

## لوحات SLO في Grafana

```json
{
  "panels": [
    {
      "title": "Error Budget Remaining (30d)",
      "type": "gauge",
      "targets": [{
        "expr": "job:payment_api_error_budget_remaining:ratio * 100",
        "legendFormat": "Budget %"
      }],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "steps": [
              {"color": "red", "value": 0},
              {"color": "yellow", "value": 25},
              {"color": "green", "value": 50}
            ]
          },
          "unit": "percent",
          "min": 0,
          "max": 100
        }
      }
    },
    {
      "title": "Burn Rate (1h window)",
      "type": "timeseries",
      "targets": [{
        "expr": "job:payment_api_errors:rate1h / 0.001",
        "legendFormat": "Burn Rate (1h)"
      }],
      "thresholds": [
        {"value": 14, "color": "red", "op": "gt"},
        {"value": 6, "color": "orange", "op": "gt"},
        {"value": 1, "color": "green", "op": "gt"}
      ]
    }
  ]
}
```

---

## الخلاصات الأساسية

- يربط التنبيه بمعدل الحرق الاستدعاءات بأثر العمل: معدل حرق 14× ينطلق فورًا لأن ميزانية الخطأ ستُستنفد خلال يومين
- التنبيه متعدد النوافذ (اشتراط الساعة + 5 دقائق معًا) يلغي الإنذارات الكاذبة من الذروات القصيرة دون التضحية بسرعة الاكتشاف
- استخدم قواعد تسجيل Prometheus لحساب نسب الأخطاء على النوافذ الطويلة مسبقًا — فالاستعلام بـ `rate()[6h]` في كل تقييم مكلف
- قواعد الكبت في Alertmanager أساسية: اكبت P2 وP3 حين ينطلق P1 للـ SLO نفسه
- قِس إرهاق التنبيهات كميًا: نسبة تنبيهات إلى حوادث > 10:1 تعني أن تنبيهك معطوب
- يجب أن يحمل كل تنبيه رابط دليل تشغيل في تعليقاته — وهذا غير قابل للتفاوض لأنظمة الإنتاج
- تحتاج واجهات الدفع أهداف مستوى خدمة للتوفر والزمن معًا مع تنبيهات معدل حرق منفصلة لكل منهما

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "لواجهة دفع هدف توفر 99.9% على مدى 30 يومًا. إذا كان معدل الحرق الحالي 14x، فكم من الوقت حتى تُستنفد ميزانية الخطأ بهذا المعدل؟",
      "options": ["30 يومًا", "7 أيام", "يومان", "12 ساعة"],
      "correct": 2,
      "explanation": "عند معدل حرق 14x، تُستهلك ميزانية الخطأ أسرع بـ 14 مرة من نافذة SLO. و30 يومًا / 14 = نحو 2.1 يوم. ولهذا ينطلق تنبيه حرج عند معدل حرق 14x — فلديك نحو يومين من الميزانية، لا 30."
    },
    {
      "text": "لماذا يتطلب التنبيه بمعدل الحرق متعدد النوافذ نافذة قصيرة (مثل 5 دقائق) ونافذة طويلة (مثل ساعة) معًا لإطلاق تنبيه؟",
      "options": ["لتقليل تكاليف تخزين Prometheus", "تؤكد النافذة القصيرة أن المشكلة تحدث الآن؛ وتؤكد النافذة الطويلة أنها مستمرة بما يكفي لاستهلاك ميزانية كبيرة — واشتراط الاثنين يلغي الإنذارات الكاذبة من الذروات القصيرة", "لأن Alertmanager يتطلب شرطين", "لأن PCI DSS يتطلب تنبيهًا بنافذتين"],
      "correct": 1,
      "explanation": "نافذة 5 دقائق وحدها تنطلق على ذروات عابرة تزول من تلقاء نفسها. ونافذة ساعة وحدها تستمر في الانطلاق طويلًا بعد إصلاح الحادث، لأن متوسط الساعة يتراجع ببطء. واشتراط الاثنين معًا يعني: احترق قدر كافٍ من الميزانية فعلًا (نافذة الساعة) والمشكلة ما زالت تحدث الآن (نافذة 5 دقائق)."
    },
    {
      "text": "أي مقياس يجب أن تتتبعه شهريًا لتشخيص إرهاق التنبيهات في فريق عمليات الدفع؟",
      "options": ["عدد النشرات شهريًا", "نسبة التنبيهات إلى الحوادث — عدد التنبيهات المنطلقة مقسومًا على عدد الحوادث التي تطلبت إجراءً بشريًا", "متوسط زمن التعافي (MTTR)", "عدد انتهاكات SLO"],
      "correct": 1,
      "explanation": "تقيس نسبة التنبيهات إلى الحوادث مقدار الضجيج الذي ينتجه تنبيهك مقارنة بالتنبيهات القابلة للتنفيذ. والنسبة السليمة أقل من 3:1. وما فوق 10:1 يدل على إرهاق التنبيهات — فمعظم الاستدعاءات ضجيج، ويتوقف المهندسون عن الاستجابة سريعًا، وتُفوَّت الحوادث الحقيقية."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنبيه قائم على SLO لواجهة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "عرّف هدفي مستوى خدمة لواجهة إرسال دفع: توفر 99.9% واكتمال 99% من الطلبات في أقل من 500ms، كلاهما على نافذة 30 يومًا. واحسب ميزانية الخطأ بالدقائق/الثواني لكل منهما."},
    {"id": "2", "description": "اكتب قواعد تسجيل Prometheus لحساب نسبة الأخطاء لكل مهمة مسبقًا على نوافذ 5 دقائق، وساعة، و6 ساعات، ويوم؛ ثم اكتب قواعد تنبيه بمعدل الحرق متعدد النوافذ عند معدلات حرق 14x (حرج)، و6x (مرتفع)، و3x (متوسط)."},
    {"id": "3", "description": "اضبط قواعد الكبت في Alertmanager بحيث حين ينطلق تنبيه معدل حرق حرج 14x لواجهة الدفع، تُكبت كل تنبيهات SLO الأقل خطورة للمهمة نفسها لمنع عاصفة التنبيهات."},
    {"id": "4", "description": "ابنِ لوحة Grafana تُظهر ميزانية الخطأ المتبقية كمقياس نسبة مئوية (أخضر > 50%، وأصفر 25-50%، وأحمر < 25%) ولوحة سلسلة زمنية لمعدل الحرق بخطوط عتبة عند 14x، و6x، و1x؛ وأضف تعليق Loki يُظهر أحداث النشر على رسم معدل الحرق."}
  ]
}
-->
