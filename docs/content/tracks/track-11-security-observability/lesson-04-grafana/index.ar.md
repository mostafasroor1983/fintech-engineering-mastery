---
id: track-11-lesson-04
title: "لوحات Grafana — تصوير سلامة الأنظمة المالية"
slug: grafana-dashboards
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 4
difficulty: advanced
estimatedMinutes: 65
status: published
tags:
  - Grafana
  - dashboard
  - SLO
  - RED-method
  - alerting
  - Loki
prerequisites:
  - track-11-lesson-03
---

# لوحات Grafana — تصوّر صحة النظام المالي

يعطيك Prometheus البيانات. ويعطيك Grafana القصة. ولمنصة دفع، يجب أن تجيب هذه القصة بلمحة عن ثلاثة أسئلة: ما سرعة حركة المال، وكم منه يفشل، وما مدى تباطئه؟ ويبني هذا الدرس لوحات Grafana بجودة إنتاجية باستخدام طريقة RED، وينفذ التنبيه بمعدل حرق ميزانية الخطأ (burn rate) لأهداف مستوى الخدمة، ويربط السجلات عبر Loki، ويرمّز اللوحات كبنية تحتية.

---

## 1. طريقة RED للخدمات المالية

توفر طريقة RED ‏(المعدل، والأخطاء، والمدة) رؤية مختصرة وكاملة لأي خدمة من منظور المستخدم. ولأنظمة الدفع، ترتبط RED مباشرة بنتائج العمل.

| البُعد | PromQL | المعنى التجاري |
|-----------|--------|-----------------|
| المعدل (Rate) | `sum(rate(payments_processed_total[5m]))` | المعاملات في الثانية — هل يتدفق المال؟ |
| الأخطاء (Errors) | `sum(rate(payments_processed_total{status="failure"}[5m])) / sum(rate(payments_processed_total[5m]))` | أي نسبة من المدفوعات تفشل؟ |
| المدة (p99) | `histogram_quantile(0.99, sum by(le) (rate(payment_latency_seconds_bucket[5m])))` | هل ينتظر العملاء طويلًا؟ |

تُظهر خدمة الدفع السليمة معدلًا مستقرًا، وأخطاء قريبة من الصفر، ومدة تحت عتبة اتفاقية مستوى الخدمة. وأي انحراف عن هذا الأساس إشارة حادث.

### تخطيط لوحة RED

```
┌─────────────────────────────────────────────────────────────────┐
│  PAYMENT SERVICE HEALTH                       env: production    │
├─────────────────┬───────────────────┬───────────────────────────┤
│  TPS (Rate)     │  Error Rate (%)   │  p99 Latency             │
│  ┌───────────┐  │  ┌─────────────┐  │  ┌──────────────────────┐│
│  │  stat:    │  │  │  stat:      │  │  │  stat:               ││
│  │  142 TPS  │  │  │  0.3%       │  │  │  187ms               ││
│  └───────────┘  │  └─────────────┘  │  └──────────────────────┘│
├─────────────────┴───────────────────┴───────────────────────────┤
│  TPS over time (time-series panel, 24h)                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~                      │ │
│  └────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Error Rate over time          │  p99 Latency over time         │
│  ┌─────────────────────────┐   │  ┌──────────────────────────┐  │
│  │  threshold: 1%  ─ ─ ─   │   │  │  SLO: 500ms  ─ ─ ─ ─    │  │
│  │  actual: ~~~             │   │  │  actual: ~~~             │  │
│  └─────────────────────────┘   │  └──────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Outbox Lag (gauge)   │  Dead Payments (stat)  │  TPS by Method │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. لوحات العرض بالتفصيل

### اللوحة 1: المعاملات في الثانية (TPS)

تُظهر لوحة الإحصاء هذه المعاملات الحالية في الثانية مع خط مصغر. وتستخدم قاعدة التسجيل المحسوبة مسبقًا لتقليل كلفة الاستعلام.

```json
{
  "type": "stat",
  "title": "Payment TPS",
  "targets": [
    {
      "expr": "sum(payment_method_currency:payments_processed_success:rate5m)",
      "legendFormat": "TPS"
    }
  ],
  "options": {
    "reduceOptions": { "calcs": ["lastNotNull"] },
    "orientation": "horizontal",
    "colorMode": "background",
    "graphMode": "area",
    "justifyMode": "auto"
  },
  "fieldConfig": {
    "defaults": {
      "unit": "reqps",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "red",    "value": 0 },
          { "color": "yellow", "value": 10 },
          { "color": "green",  "value": 50 }
        ]
      }
    }
  }
}
```

### اللوحة 2: معدل الأخطاء مع عتبة التنبيه

```json
{
  "type": "timeseries",
  "title": "Payment Error Rate",
  "targets": [
    {
      "expr": "100 * (sum(rate(payments_processed_total{status=\"failure\"}[5m])) / sum(rate(payments_processed_total[5m])))",
      "legendFormat": "Error Rate %"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "percent",
      "custom": {
        "thresholdsStyle": { "mode": "dashed" }
      },
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green",  "value": 0 },
          { "color": "yellow", "value": 0.5 },
          { "color": "red",    "value": 1.0 }
        ]
      }
    }
  }
}
```

### اللوحة 3: مئين زمن p99 من المدرج التكراري

```json
{
  "type": "timeseries",
  "title": "Payment Latency (p50 / p95 / p99)",
  "targets": [
    {
      "expr": "histogram_quantile(0.50, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
      "legendFormat": "p50"
    },
    {
      "expr": "histogram_quantile(0.95, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
      "legendFormat": "p95"
    },
    {
      "expr": "histogram_quantile(0.99, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
      "legendFormat": "p99"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "s",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green",  "value": 0 },
          { "color": "yellow", "value": 0.3 },
          { "color": "red",    "value": 0.5 }
        ]
      }
    }
  }
}
```

### اللوحة 4: مقياس تأخر الـ Outbox

```json
{
  "type": "gauge",
  "title": "Outbox Pending Events",
  "targets": [
    {
      "expr": "max by(topic) (outbox_pending_events)",
      "legendFormat": "{{ topic }}"
    }
  ],
  "options": {
    "minValue": 0,
    "maxValue": 5000
  },
  "fieldConfig": {
    "defaults": {
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green",  "value": 0 },
          { "color": "yellow", "value": 100 },
          { "color": "red",    "value": 500 }
        ]
      }
    }
  }
}
```

---

## 3. لوحة أهداف مستوى الخدمة وميزانية الخطأ

تتتبع لوحة SLO وعدك للعملاء — مثلًا: 99.9% من المدفوعات تنجح خلال 500ms. وميزانية الخطأ هي هامش الفشل المسموح.

```
                                   (1 - actual_availability)
error_budget_remaining = 1  -  ─────────────────────────────
                                   (1 - availability_target)

e.g. target 99.9%, actual 99.95%:  1 - 0.0005 / 0.001 = 0.5  → 50% left
```

### تعابير PromQL لأهداف مستوى الخدمة

```promql
# 28-day availability (success rate)
(
  1 - (
    sum(increase(payments_processed_total{status="failure"}[28d]))
    /
    sum(increase(payments_processed_total[28d]))
  )
)

# Error budget remaining (as fraction of 0.001 for 99.9% SLO)
(
  0.001 -
  (
    sum(increase(payments_processed_total{status="failure"}[28d]))
    /
    sum(increase(payments_processed_total[28d]))
  )
) / 0.001
```

### تنبيه معدل الحرق

ينطلق تنبيه معدل الحرق حين تستهلك ميزانية الخطأ أسرع من معدل تجددها الطبيعي. ومعدل حرق 1x يعني أنك ستستنفد الميزانية بالضبط عند نهاية النافذة؛ وعند N× تكفي الميزانية مدة النافذة ÷ N.

```promql
# 1-hour burn rate for a 99.9% SLO over a 30-day window.
# Fast-burn threshold 14.4 = burning 2% of the 30-day budget in ONE hour
# (0.02 × 720 hours) -- the value from the Google SRE workbook
(
  sum(rate(payments_processed_total{status="failure"}[1h]))
  /
  sum(rate(payments_processed_total[1h]))
) / (1 - 0.999)
```

معدل حرق فوق 14.4 يعني أن 2% من الميزانية الشهرية تختفي كل ساعة — فتنفد ميزانية الثلاثين يومًا كاملة في نحو يومين (720 ساعة ÷ 14.4 = 50 ساعة). وهذا استدعاء P1. وفي الإنتاج، اقرن نافذة الساعة بنافذة قصيرة (مثل 5 دقائق، بالعتبة نفسها) كي *يتوقف* التنبيه أيضًا بسرعة بمجرد إصلاح المشكلة.

```yaml
# PrometheusRule for SLO burn rate
- alert: PaymentSLOBurnRateCritical
  expr: |
    (
      sum(rate(payments_processed_total{status="failure"}[1h]))
      /
      sum(rate(payments_processed_total[1h]))
    ) / (1 - 0.999) > 14.4
  for: 5m
  labels:
    severity: critical
    slo: payment-availability
  annotations:
    summary: "Payment SLO burn rate is {{ $value | humanize }}x — budget exhaustion imminent"
    description: >
      Burning error budget at {{ $value | humanize }}x the sustainable rate:
      at this pace the 30-day budget lasts about 720 / {{ $value | humanize }}
      hours. Immediate action required.
```

---

## 4. اللوحات كشيفرة

يمنع تخزين اللوحات كشيفرة انحرافها، ويتيح المراجعة بين الزملاء، ويسمح بالنشر الآلي.

### مزوّد Grafana في Terraform

```hcl
terraform {
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}

provider "grafana" {
  url  = "https://grafana.example.com"
  auth = var.grafana_service_account_token
}

resource "grafana_folder" "payments" {
  title = "Payment Systems"
}

resource "grafana_dashboard" "payment_health" {
  folder      = grafana_folder.payments.uid
  config_json = file("${path.module}/dashboards/payment-health.json")
  # Manual edits in the UI are overwritten by the next "terraform apply";
  # lock editing for humans (folder permissions) so Git stays the source
}

# Grafana-managed alert rules are defined as a rule GROUP
resource "grafana_rule_group" "payment_alerts" {
  name             = "payment-alerts"
  folder_uid       = grafana_folder.payments.uid
  interval_seconds = 60

  rule {
    name           = "Payment Error Rate High"
    condition      = "C"
    for            = "2m"
    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    labels = {
      severity = "critical"
      team     = "payments"
    }

    data {
      ref_id         = "A"
      datasource_uid = "prometheus"
      relative_time_range {
        from = 300
        to   = 0
      }
      model = jsonencode({
        expr  = "sum(rate(payments_processed_total{status=\"failure\"}[5m])) / sum(rate(payments_processed_total[5m]))"
        refId = "A"
      })
    }

    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "C"
        type       = "threshold"
        expression = "A"
        conditions = [{ evaluator = { type = "gt", params = [0.01] } }]
      })
    }
  }
}
```

### ‏Grafonnet (مكتبة Jsonnet)

يستخدم المثال واجهة `grafonnet-lib` الكلاسيكية، وهي مُهملة؛ وتستخدم المشاريع الجديدة مكتبة `grafonnet` المولّدة من `grafana/grafonnet` (الفكرة نفسها، بأسماء دوال مختلفة).

```jsonnet
// payment-dashboard.libsonnet
local grafana   = import 'grafonnet/grafana.libsonnet';
local dashboard = grafana.dashboard;
local row       = grafana.row;
local prometheus = grafana.prometheus;
local graphPanel = grafana.graphPanel;
local statPanel  = grafana.statPanel;

dashboard.new(
  'Payment Service Health',
  tags=['payments', 'RED', 'SLO'],
  time_from='now-6h',
  refresh='30s',
  schemaVersion=36,
)
.addPanel(
  statPanel.new(
    'TPS',
    datasource='Prometheus',
    unit='reqps',
  ).addTarget(
    prometheus.target(
      'sum(payment_method_currency:payments_processed_success:rate5m)',
      legendFormat='TPS',
    )
  ), gridPos={ h: 4, w: 6, x: 0, y: 0 }
)
.addPanel(
  statPanel.new(
    'Error Rate',
    datasource='Prometheus',
    unit='percentunit',
    thresholds=[
      { color: 'green',  value: null },
      { color: 'yellow', value: 0.005 },
      { color: 'red',    value: 0.01 },
    ],
  ).addTarget(
    prometheus.target(
      'sum(rate(payments_processed_total{status="failure"}[5m])) / sum(rate(payments_processed_total[5m]))',
    )
  ), gridPos={ h: 4, w: 6, x: 6, y: 0 }
)
```

---

## 5. إعداد التنبيه في Grafana

يدعم التنبيه الموحد في Grafana التنبيهات متعددة مصادر البيانات ويحل محل قواعد التنبيه القديمة.

### نقاط الاتصال

```yaml
# grafana/provisioning/alerting/contact-points.yaml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: payments-pagerduty
    receivers:
      - uid: pagerduty-payments
        type: pagerduty
        settings:
          integrationKey: ${PAGERDUTY_PAYMENTS_KEY}
          severity: critical
          class: payment-failure
          group: payments
          component: payment-service

  - orgId: 1
    name: payments-slack
    receivers:
      - uid: slack-payments
        type: slack
        settings:
          url: ${SLACK_WEBHOOK_URL}
          channel: "#payments-alerts"
          title: "{{ template \"slack.payment.title\" . }}"
          text: "{{ template \"slack.payment.text\" . }}"
```

### سياسات الإشعار

```yaml
# grafana/provisioning/alerting/notification-policies.yaml
apiVersion: 1
policies:
  - orgId: 1
    receiver: default-slack
    group_by: [alertname, cluster, namespace]
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    routes:
      - receiver: payments-pagerduty
        matchers:
          - severity = critical
          - team = payments
        group_wait: 10s
        repeat_interval: 1h

      - receiver: payments-slack
        matchers:
          - severity = warning
          - team = payments
        repeat_interval: 24h
```

---

## 6. تعليقات النشر التوضيحية

تعليق الرسوم بأحداث النشر أساسي لربط "متى نشرنا؟" بارتفاعات الزمن أو زيادات معدل الأخطاء.

### واجهة التعليقات في Grafana (تكامل CI/CD)

```bash
# Post annotation at deploy time from your CI/CD pipeline
DEPLOY_VERSION="v2.4.1"
DEPLOY_TIME=$(date +%s%3N)   # milliseconds since epoch

curl -X POST \
  -H "Authorization: Bearer ${GRAFANA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"dashboardUID\": \"payment-health\",
    \"panelId\": null,
    \"time\": ${DEPLOY_TIME},
    \"tags\": [\"deployment\", \"payment-service\"],
    \"text\": \"payment-service ${DEPLOY_VERSION} deployed to production\"
  }" \
  https://grafana.example.com/api/annotations
```

### تعليقات ArgoCD عبر Webhook

```yaml
# ArgoCD notification template
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
data:
  template.grafana-annotation: |
    webhook:
      grafana:
        method: POST
        path: /api/annotations
        body: |
          {
            "dashboardUID": "payment-health",
            "time": {{(now).UnixMilli}},
            "tags": ["deployment", "{{.app.metadata.name}}"],
            "text": "{{.app.metadata.name}} {{.app.status.sync.revision}} deployed"
          }
```

---

## 7. استعلامات سجلات Loki بجانب المقاييس

يتيح Loki ربط السجلات دون مغادرة واجهة Grafana.

### استعلامات LogQL لأخطاء الدفع

```logql
# All ERROR logs from payment-service in last 1 hour
{app="payment-service", namespace="payments"} |= "ERROR"

# Count of error log lines per minute
count_over_time({app="payment-service"} |= "ERROR" [1m])

# Extract payment failure reason from structured JSON logs
{app="payment-service"} | json | level="ERROR" | line_format "{{.payment_id}}: {{.error_code}}"

# Correlate with specific transaction ID from an alert
{app="payment-service"} |= "txn-id-abc123" | json
```

### لوحة Grafana بمصادر بيانات مختلطة

يمكن لصف لوحات واحد أن يجمع مقياس Prometheus (زمن p99) مع تدفق سجلات Loki، فيتيح للمهندسين ربط ارتفاع في الزمن بأول سجل ERROR ظهر.

```json
{
  "type": "logs",
  "title": "Payment Service Errors",
  "datasource": { "type": "loki", "uid": "loki" },
  "targets": [
    {
      "expr": "{app=\"payment-service\", namespace=\"payments\"} |= \"ERROR\" | json | level=\"ERROR\"",
      "legendFormat": "",
      "maxLines": 100
    }
  ],
  "options": {
    "showTime": true,
    "showLabels": true,
    "wrapLogMessage": true,
    "sortOrder": "Descending",
    "dedupStrategy": "none"
  }
}
```

---

## 8. النماذج (Exemplars) لربط التتبعات

تضمّن النماذج (exemplars) معرّف تتبع في مشاهدة المدرج التكراري كي تنتقل من ارتفاع p99 بطيء إلى تتبع Jaeger الذي سببه بالضبط.

### ‏Java — إضافة النماذج عبر Micrometer

```java
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;

@Service
public class PaymentService {

    private final Timer paymentTimer;

    public PaymentService(MeterRegistry meterRegistry) {
        this.paymentTimer = Timer.builder("payment.latency")
            .publishPercentileHistogram(true)
            .register(meterRegistry);
    }

    public PaymentResult process(PaymentRequest request) {
        // No exemplar code needed: when the timer records inside an active,
        // SAMPLED span, the Prometheus registry attaches that trace ID to
        // the histogram bucket as an exemplar
        return paymentTimer.record(() -> executePayment(request));
    }
}
```

```yaml
# application.yml — Spring Boot 3 with Micrometer Tracing (OTel bridge)
# auto-configures exemplar support for the Prometheus registry
management:
  tracing:
    sampling:
      probability: 0.1      # exemplars exist only for sampled requests
  metrics:
    distribution:
      percentiles-histogram:
        payment.latency: true
# Exemplars are only exposed in the OpenMetrics format -- Prometheus
# requests it automatically when exemplar storage is enabled
```

### تخزين Prometheus — تفعيل النماذج

```yaml
# Prometheus must run with:  --enable-feature=exemplar-storage
# prometheus.yml
global:
  scrape_interval: 15s

storage:
  exemplars:
    max_exemplars: 100000    # store up to 100k exemplars in memory
```

في Grafana، فعّل **Exemplars** على استعلام Prometheus في اللوحة واضبط رابط النماذج في مصدر بيانات Prometheus إلى مصدر بيانات Jaeger/Tempo لديك. فتظهر النماذج حينها كنقاط على رسم الزمن؛ والنقر على إحداها يفتح تتبع ذلك الطلب البطيء بالضبط.

---

## مزالق الإنتاج

### المزلق 1: انتشار اللوحات دون ملكية

تنشئ الفرق لوحات أثناء الحوادث ولا تحذفها أبدًا. وبعد 6 أشهر، يحوي Grafana ‏400 لوحة، معظمها قديم، بتعريفات متعارضة لـ "معدل الأخطاء" عبر الفرق.

**الحل**: افرض اللوحات كشيفرة بـ Terraform، وعيّن وسم `team` لكل لوحة، وجدوِل تدقيقًا ربع سنوي. وأضف تاريخ آخر مراجعة لكل لوحة.

```hcl
# Every dashboard must declare ownership
resource "grafana_dashboard" "payment_health" {
  config_json = jsonencode(merge(
    jsondecode(file("dashboards/payment-health.json")),
    {
      tags        = ["payments", "RED", "owner:payments-team"]
      # "meta" is not part of the dashboard model -- keep review data in a
      # field Grafana stores, such as the description
      description = "Owner: payments-team. Last reviewed: 2026-01"
    }
  ))
}
```

يمكن لمهمة مجدولة بعدها إيجاد اللوحات القديمة (بلا commits منذ 90 يومًا، وبلا مشاهدات منذ 30 يومًا)، ونقلها إلى مجلد `archived` وإشعار مالكيها.

### المزلق 2: التنبيه على ذروات فردية بدل معدل حرق مستمر

التنبيه بـ `if error_rate > 0.01` على نافذة دقيقة واحدة يولّد إنذارات كاذبة مع كل دفقة حركة قصيرة. فدفعة كبيرة واحدة تفشل عابرًا تنشئ ذروة تزول في أقل من 60 ثانية لكنها توقظ المهندسين.

**الحل**: استخدم تنبيهات متعددة النوافذ ومتعددة معدلات الحرق. نبّه على الحرق السريع (نافذة ساعة > 14.4x) للاستدعاءات الحرجة، والحرق البطيء (نافذة 6 ساعات > 6x) للتحذيرات.

```promql
# Fast burn — pages immediately (2% of the budget per hour: gone in ~2 days)
(
  sum(rate(payments_processed_total{status="failure"}[1h]))
  / sum(rate(payments_processed_total[1h]))
) / 0.001 > 14.4

# Slow burn — warning (budget gone in < 5 days)
(
  sum(rate(payments_processed_total{status="failure"}[6h]))
  / sum(rate(payments_processed_total[6h]))
) / 0.001 > 6
```

يلغي هذا معظم الاستدعاءات الكاذبة لأنظمة الدفع ذات أنماط الدفقات الطبيعية.

### المزلق 3: غياب تعليقات النشر يصعّب ربط الحوادث

يرى مهندس المناوبة زمن p99 يرتفع من 180ms إلى 950ms عند 14:37. ودون تعليقات النشر، يجب أن يبحث يدويًا في تواريخ النشر، ورسائل Slack، وسجلات git ليكتشف أن فهرس قاعدة بيانات جديدًا حُذف عند 14:35. وهذا يكلف دقائق حرجة أثناء الحادث.

**الحل**: احقن التعليقات في كل لوحات الإنتاج تلقائيًا كجزء من خط النشر المستمر. فكل دمج في main يطلق نشرًا إنتاجيًا يجب أن ينشر تعليقًا في Grafana.

```yaml
# .github/workflows/deploy.yml
- name: Annotate Grafana dashboards
  if: success()
  run: |
    curl -s -X POST \
      -H "Authorization: Bearer ${{ secrets.GRAFANA_API_TOKEN }}" \
      -H "Content-Type: application/json" \
      -d "{
        \"tags\": [\"deployment\", \"${{ github.repository }}\"],
        \"text\": \"${{ github.repository }} ${{ github.sha }} deployed by ${{ github.actor }}\"
      }" \
      https://grafana.example.com/api/annotations
```

---

## قائمة تحقق الإنتاج

- [ ] لوحة بطريقة RED موجودة لكل خدمة حرجة للدفع
- [ ] لوحات إحصاء المعاملات في الثانية، ومعدل الأخطاء، وزمن p99 تستخدم قواعد التسجيل (لا العدادات الخام)
- [ ] لوحة SLO تُظهر التوفر لـ 28 يومًا وميزانية الخطأ المتبقية
- [ ] تنبيهات معدل الحرق مضبوطة: حرق سريع (14.4x، حرج) وحرق بطيء (6x، تحذير)
- [ ] كل اللوحات مخزنة كشيفرة في git ‏(Terraform أو Grafonnet)
- [ ] وسوم الملكية مطبقة على اللوحات (`owner:team-name`)
- [ ] نقاط الاتصال مضبوطة لـ PagerDuty (حرج) وSlack (تحذير)
- [ ] سياسات الإشعار مختبرة بـ `grafana-tools` أو واجهة Grafana
- [ ] تعليقات النشر محقونة تلقائيًا من خط CI/CD
- [ ] مصدر بيانات Loki متصل ولوحات السجلات مضافة إلى لوحات الاستجابة للحوادث
- [ ] دعم النماذج مفعّل في Prometheus وGrafana لربط التتبعات
- [ ] النسخ الاحتياطي/الاستعادة للوحات مختبر (تصدير JSON، وإعادة الاستيراد، والتحقق من تحميل اللوحات)

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"تحتاج حساب ميزانية الخطأ المتبقية لـ 30 يومًا لخدمة دفع بهدف توفر 99.9%. وشهدت الخدمة 150 فشلًا من أصل 500,000 طلب إجمالًا خلال 30 يومًا. أي عبارة صحيحة؟","options":["ميزانية الخطأ 0.1%، تسمح بـ 500 فشل إجمالًا. ومع 150 فشلًا، استُهلك 30% من الميزانية وبقي 70%.","ميزانية الخطأ 1%، تسمح بـ 5,000 فشل إجمالًا. ومع 150 فشلًا الميزانية شبه سليمة.","لا يمكن حساب ميزانية الخطأ دون معرفة زمن p99.","ميزانية الخطأ 0.01%، تسمح بـ 50 فشلًا إجمالًا. والميزانية مستنفدة بالفعل."],"correct":0,"explanation":"هدف 99.9% يعني ميزانية خطأ 0.1%. ولـ 500,000 طلب هذا يعني 500 فشل مسموح. ومع استهلاك 150 فشلًا، يبقى 350 — أي استُهلك 30% من الميزانية وبقي 70%. وعلى مدى نافذة الثلاثين يومًا كاملة هذا معدل حرق 0.3x ‏(150 / 500): ضمن المعدل المستدام 1x بفارق كبير."},{"text":"تُظهر لوحة Grafana ارتفاع معدل أخطاء الدفع إلى 2% عند 14:37. ولا يظهر تعليق نشر على الرسم. ما أفضل إجراء فوري لمهندس المناوبة؟","options":["أعد تشغيل pods ‏payment-service فورًا لمسح ذروة الأخطاء.","افحص تاريخ git، وسجلات CI/CD، وقنوات Slack لربط التوقيت 14:37 بأي تغييرات حديثة، مع فحص Loki في الوقت نفسه بحثًا عن سجلات ERROR في ذلك الوقت.","اعترف بالتنبيه وانتظر 30 دقيقة لترى إن كانت الذروة ستزول وحدها.","تراجع عن آخر نشر دون تحقيق إضافي."],"correct":1,"explanation":"دون تعليق نشر يجب على المهندس الربط يدويًا. والنهج الصحيح فحص سجلات Loki عند 14:37 لمعرفة سبب الخطأ مع البحث في تاريخ النشر في الوقت نفسه. وإعادة تشغيل الـ pods دون تحقيق قد تدمّر الأدلة. والانتظار 30 دقيقة أثناء ذروة أخطاء حية ينتهك هدف مستوى الخدمة. والتراجع الأعمى قد لا يصلح المشكلة إذا كان السبب اعتمادية لاحقة."},{"text":"لماذا يجب أن يستخدم التنبيه في Grafana قواعد معدل حرق متعددة النوافذ بدل تنبيهات العتبة البسيطة مثل 'error_rate > 0.01 for 2m'؟","options":["لأن PromQL لا يدعم مقارنات العتبة البسيطة.","لأن العتبات البسيطة تولّد إنذارات كاذبة أثناء دفقات الحركة الطبيعية ولا تستطيع التمييز بين الذروات العابرة والتدهور المستمر المهدد لهدف مستوى الخدمة.","لأن Grafana يستطيع تقييم التنبيهات على نوافذ ساعة واحدة فقط.","لأن PagerDuty يتطلب قيم معدل الحرق لتوجيه التنبيهات بشكل صحيح."],"correct":1,"explanation":"تنطلق تنبيهات العتبة البسيطة عند أي ذروة عابرة، بما فيها أنماط الدفقات الطبيعية في أنظمة الدفع. أما تنبيهات معدل الحرق متعددة النوافذ فتقارن استهلاك الخطأ بميزانية هدف مستوى الخدمة، فلا تستدعي إلا حين يكون معدل الفشل المستمر سيستنفد الميزانية ضمن إطار زمني ذي معنى. وهذا يلغي إرهاق التنبيهات مع ضمان أن انتهاكات SLO الحقيقية تطلق الإشعارات دائمًا."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"بناء لوحة صحة دفع إنتاجية","difficulty":"advanced","estimatedMinutes":90,"tasks":[{"id":"1","description":"أنشئ لوحة Grafana بطريقة RED لخدمة دفع. وضمّن: لوحة إحصاء للمعاملات الحالية في الثانية (من قاعدة تسجيل)، ولوحة إحصاء لنسبة معدل الأخطاء (عتبات أخضر/أصفر/أحمر عند 0.5%/1%)، ولوحة سلسلة زمنية تُظهر زمن p50/p95/p99 بخط عتبة SLO عند 500ms، ولوحة مقياس لأحداث الـ outbox المعلقة. وخزّن JSON اللوحة في إدارة الإصدارات."},{"id":"2","description":"نفّذ لوحة SLO تتتبع توفر 99.9% على مدى 28 يومًا. وأضف لوحات لـ: نسبة التوفر الحالية لـ 28 يومًا، وميزانية الخطأ المستهلكة (%)، وسلسلة زمنية للحرق اليومي لميزانية الخطأ. واضبط تنبيه معدل حرق في Grafana يستدعي PagerDuty حين يتجاوز معدل الحرق لساعة 14.4x ويرسل تحذيرًا إلى Slack حين يتجاوز معدل الحرق لست ساعات 6x."},{"id":"3","description":"رمّز اللوحة باستخدام مزوّد Grafana في Terraform. ويجب أن تقوم شيفرة Terraform بـ: إنشاء مجلد Grafana باسم 'Payment Systems'، ونشر لوحة صحة الدفع من ملف JSON، وضبط نقطتي الاتصال PagerDuty وSlack باستخدام متغيرات بيئة للأسرار، وتعريف سياسة الإشعار التي توجّه التنبيهات الحرجة إلى PagerDuty والتحذيرات إلى Slack."},{"id":"4","description":"ادمج ربط سجلات Loki في اللوحة. وأضف لوحة سجلات تُظهر سجلات مستوى ERROR من مساحة الأسماء payment-service. وأضف استعلام LogQL يستخرج error_code من السجلات المنظمة بـ JSON ويعدّ تكراراته في الدقيقة. واضبط خط CI/CD لنشر تعليق Grafana مع كل نشر إنتاجي يتضمن SHA الـ commit واسم المهندس الناشر."}]} -->
