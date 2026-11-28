---
id: track-11-lesson-03
title: "Prometheus وPromQL — مقاييس الأنظمة المالية"
slug: prometheus-promql
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 3
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - Prometheus
  - PromQL
  - metrics
  - counter
  - gauge
  - histogram
  - alerting
prerequisites:
  - track-11-lesson-02
---

# ‏Prometheus وPromQL — المقاييس للأنظمة المالية

‏Prometheus المعيار الفعلي للمقاييس في الأنظمة المالية السحابية الأصلية. ونموذج الجمع بالسحب، ونموذج البيانات متعدد الأبعاد، ولغة الاستعلام القوية (PromQL) تجعله لا غنى عنه لرصد خطوط الدفع، واكتشاف انتهاكات اتفاقيات مستوى الخدمة، وقيادة التنبيه الآلي. ويغطي هذا الدرس كل شيء من اختيار نوع المقياس إلى قواعد تنبيه بجودة إنتاجية لأحمال مالية حقيقية.

## لماذا Prometheus للتقنية المالية؟

تتطلب الأنظمة المالية اكتشاف ارتفاعات معدل الأخطاء وتدهور الزمن في أقل من ثانية. ويقدم Prometheus:

- **تسميات متعددة الأبعاد** — قسّم المقاييس حسب `payment_method`، أو `currency`، أو `merchant_id`، أو `region` دون ترحيل مخطط.
- **جمع بالسحب** — تكشف الخدمات نقطة `/actuator/prometheus`؛ ويتحكم Prometheus في وتيرة الجمع.
- **تكامل مع Alertmanager** — وجّه التنبيهات إلى PagerDuty لإخفاقات الدفع P1 وإلى Slack للإشعارات المعلوماتية.
- **قواعد التسجيل** — احسب تعابير PromQL المكلفة مسبقًا كي تُحمّل اللوحات فورًا حتى مع ملايين السلاسل الزمنية.

---

## 1. أنواع مقاييس Prometheus

### العدّاد (Counter)

العدّاد يزيد فقط (أو يعود إلى الصفر عند إعادة التشغيل). استخدمه لعدّ الأحداث المنفصلة.

```
# HELP payments_processed_total Total number of payment transactions processed
# TYPE payments_processed_total counter
payments_processed_total{status="success",payment_method="card",currency="GBP"} 48291
payments_processed_total{status="failure",payment_method="card",currency="GBP"} 134
payments_processed_total{status="success",payment_method="bank_transfer",currency="EUR"} 7823
```

**القاعدة الذهبية**: لا تستخدم عدّادًا أبدًا لقيم يمكن أن تنقص. واستخدم `rate()` أو `increase()` لاشتقاق معدل في الثانية.

### المقياس اللحظي (Gauge)

يمثل المقياس اللحظي قيمة لحظية يمكن أن ترتفع أو تنخفض.

```
# HELP outbox_pending_events Number of events waiting in the transactional outbox
# TYPE outbox_pending_events gauge
outbox_pending_events{topic="payment.completed"} 12
outbox_pending_events{topic="fraud.alert"} 0
```

المقاييس اللحظية مثالية لأعماق الطوابير، وأحجام مجمّعات الاتصالات، ونسب إصابة الذاكرة المؤقتة. (اللاحقة `_total` محجوزة للعدادات — والمقياس اللحظي لا يحملها أبدًا.)

### المدرج التكراري (Histogram)

يأخذ المدرج التكراري عينات من المشاهدات ويعدّها في سلال (buckets) قابلة للضبط. ويكشف تلقائيًا السلاسل `_bucket`، و`_sum`، و`_count`.

```
# HELP payment_latency_seconds End-to-end payment processing latency
# TYPE payment_latency_seconds histogram
payment_latency_seconds_bucket{le="0.05"} 1200
payment_latency_seconds_bucket{le="0.1"}  3800
payment_latency_seconds_bucket{le="0.25"} 7100
payment_latency_seconds_bucket{le="0.5"}  9800
payment_latency_seconds_bucket{le="1.0"}  10100
payment_latency_seconds_bucket{le="+Inf"} 10234
payment_latency_seconds_sum 1823.4
payment_latency_seconds_count 10234
```

استخدم `histogram_quantile(0.99, ...)` لحساب زمن p99 عبر أسطول من النسخ.

### الملخص (Summary)

يحسب الملخص المئينات من جهة العميل. وبخلاف المدرجات التكرارية، **لا يمكن تجميع الملخصات عبر النسخ**، فهي غير مناسبة لخدمات الدفع الموسّعة أفقيًا.

**قاعدة القرار**: فضّل دائمًا المدرجات التكرارية على الملخصات في أنظمة التقنية المالية الموزعة.

---

## 2. تكامل Micrometer مع Spring Boot

‏Micrometer واجهة التجهيز التي تقع بين شيفرة تطبيقك وPrometheus.

### اعتمادية Maven

```xml
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
  </dependency>
  <dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
  </dependency>
</dependencies>
```

### ‏application.yml

```yaml
management:
  endpoints:
    web:
      exposure:
        include: prometheus,health,info
  metrics:
    distribution:
      percentiles-histogram:
        payment.latency: true          # enables histogram buckets
      slo:                             # extra buckets at the SLO boundaries
        payment.latency: 50ms,100ms,250ms,500ms,1000ms
      # (avoid "percentiles:" here: client-side percentiles are computed per
      #  instance and cannot be aggregated across pods)
    tags:
      application: payment-service
      environment: production
      region: eu-west-1
```

### مدرج زمن الدفع التكراري (Java)

```java
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Service;

import java.time.Duration;

@Service
public class PaymentMetrics {

    private final MeterRegistry registry;
    private final Timer paymentLatency;

    public PaymentMetrics(MeterRegistry registry, OutboxRepository outboxRepository) {
        this.registry = registry;

        // Histogram for end-to-end payment latency
        this.paymentLatency = Timer.builder("payment.latency")
            .description("End-to-end payment processing latency")
            .publishPercentileHistogram(true)
            .minimumExpectedValue(Duration.ofMillis(10))
            .maximumExpectedValue(Duration.ofSeconds(10))
            .register(registry);

        // Gauge for transactional outbox lag. Every replica reports the same
        // DB count -- aggregate it with max(), not sum(), in PromQL. The
        // query runs on every scrape: keep it cheap (or cache the value).
        Gauge.builder("outbox.pending.events",
                outboxRepository, OutboxRepository::countPending)
            .description("Number of events pending in the transactional outbox")
            .register(registry);
    }

    public PaymentResult processPayment(PaymentRequest request) {
        return paymentLatency.record(() -> {
            try {
                PaymentResult result = doProcessPayment(request);
                outcome("success", "none").increment();
                return result;
            } catch (PaymentException ex) {
                // failure reason as a tag (bounded set of error codes)
                outcome("failure", ex.getErrorCode()).increment();
                throw ex;
            }
        });
    }

    // The Prometheus registry requires every meter with the same name to
    // have the SAME set of tag keys -- so "reason" is always present
    // ("none" for successes). Mixing {status} and {status,reason} under one
    // name fails at registration. Micrometer caches the counter per tag set.
    private Counter outcome(String status, String reason) {
        return Counter.builder("payments.processed")
            .description("Payments processed, by outcome")
            .tags("status", status, "reason", reason)
            .register(registry);
    }
}
```

### تحذير التعدد العالي (High-Cardinality)

لا تستخدم أبدًا قيمًا ديناميكية (معرّفات المستخدمين، ومعرّفات المعاملات، وأرقام الحسابات) كقيم تسميات. فكل تركيبة فريدة من التسميات تنشئ سلسلة زمنية جديدة. وتسمية واحدة مضبوطة خطأً قد تولّد ملايين السلاسل وتُسقط Prometheus.

```java
// WRONG — creates millions of time series
Counter.builder("payment.processed")
    .tags("account_id", request.getAccountId())   // cardinality bomb
    .register(registry)
    .increment();

// CORRECT — bounded cardinality
Counter.builder("payment.processed")
    .tags("payment_method", request.getPaymentMethod(),   // card, bank_transfer
          "currency", request.getCurrency(),               // GBP, EUR, USD
          "merchant_category", request.getMcc())           // ~200 MCC codes
    .register(registry)
    .increment();
```

---

## 3. عوامل PromQL

### ‏rate() — معدل العداد الآمن

يحسب `rate()` متوسط معدل الزيادة في الثانية عبر نطاق زمني، ويتعامل مع إعادة ضبط العدادات بسلاسة (إعادة تشغيل الـ pods، والنشرات).

```promql
# Payment success rate per second over last 5 minutes
rate(payments_processed_total{status="success"}[5m])

# Grouped by payment method
sum by(payment_method) (rate(payments_processed_total{status="success"}[5m]))
```

### ‏irate() — المعدل اللحظي

يستخدم `irate()` آخر نقطتي بيانات فقط. وهو أكثر استجابة لكنه أكثر تذبذبًا. استخدمه للوحات، لا للتنبيهات.

```promql
# Instantaneous TPS for real-time dashboard panel
irate(payments_processed_total{status="success"}[2m])
```

### ‏histogram_quantile()

يحسب المئين من سلال المدرج التكراري. ويجب أن تكون نافذة المعدل واسعة بما يكفي لوجود عينات كافية.

```promql
# p99 payment latency across all instances over 5 minutes
histogram_quantile(0.99,
  sum by(le) (
    rate(payment_latency_seconds_bucket[5m])
  )
)

# p99 per payment method
histogram_quantile(0.99,
  sum by(le, payment_method) (
    rate(payment_latency_seconds_bucket[5m])
  )
)
```

### حساب معدل الأخطاء

```promql
# Payment error rate as a fraction (0.0 to 1.0)
sum(rate(payments_processed_total{status="failure"}[5m]))
  /
sum(rate(payments_processed_total[5m]))

# As a percentage
100 * (
  sum(rate(payments_processed_total{status="failure"}[5m]))
  /
  sum(rate(payments_processed_total[5m]))
)
```

### عوامل التجميع

```promql
# Total TPS across all regions
sum(rate(payments_processed_total[5m]))

# p99 latency per pod (find the outlier pod)
max by(pod) (
  histogram_quantile(0.99,
    sum by(le, pod) (rate(payment_latency_seconds_bucket[5m]))
  )
)

# Outbox backlog per topic: every replica reports the same DB count,
# so take max (sum would multiply it by the replica count)
max by(topic) (outbox_pending_events)
```

---

## 4. إعداد الجمع لـ Pods في Kubernetes

يكتشف Prometheus الأهداف باستخدام اكتشاف الخدمات في Kubernetes. وعلّق الـ pods للتحكم في الجمع. (مع Prometheus Operator، الطريقة المعتادة مورد `PodMonitor` أو `ServiceMonitor` بدل التعليقات؛ واصطلاح التعليقات أدناه لـ Prometheus العادي.)

### تعليقات الـ Pod

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
spec:
  template:
    metadata:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/actuator/prometheus"
      labels:
        app: payment-service
        version: v2.4.1
```

### إعداد اكتشاف Kubernetes في prometheus.yml

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: prod-eu-west-1
    environment: production

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [payments, fraud-detection, reconciliation]
    relabel_configs:
      # Only scrape pods with the annotation
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      # Use the annotated port: keep the pod IP from __address__ and swap
      # in the port (replacing __address__ with only the port would leave
      # Prometheus without a host to scrape)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
      # Use the annotated path
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      # Carry pod labels into Prometheus labels
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
```

---

## 5. مورد PrometheusRule للتنبيه

يوسّع Prometheus Operator ‏Kubernetes بمورد `PrometheusRule`. وتُحمّل التنبيهات المعرّفة فيه تلقائيًا دون إعادة تشغيل Prometheus.

### قواعد تنبيه نظام الدفع

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-service-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus       # must match Prometheus CR selector
    role: alert-rules
spec:
  groups:
    - name: payment.errors
      interval: 30s
      rules:
        # Alert when payment error rate exceeds 1% over 5 minutes
        - alert: PaymentErrorRateHigh
          expr: |
            (
              sum(rate(payments_processed_total{status="failure"}[5m]))
              /
              sum(rate(payments_processed_total[5m]))
            ) > 0.01
          for: 2m
          labels:
            severity: critical
            team: payments
          annotations:
            # runbook links are annotations (labels identify the alert)
            runbook_url: "https://wiki.example.com/runbooks/payment-error-rate"
            summary: "Payment error rate is {{ $value | humanizePercentage }}"
            description: >
              Payment error rate has exceeded 1% for more than 2 minutes.
              Current rate: {{ $value | humanizePercentage }}.
              Investigate the payment-service logs immediately.

    - name: payment.latency
      rules:
        # Alert when p99 latency exceeds 500ms
        - alert: PaymentLatencyP99High
          expr: |
            histogram_quantile(0.99,
              sum by(le) (
                rate(payment_latency_seconds_bucket[5m])
              )
            ) > 0.5
          for: 3m
          labels:
            severity: warning
            team: payments
          annotations:
            summary: "Payment p99 latency is {{ $value | humanizeDuration }}"
            description: >
              p99 payment latency has exceeded 500ms for 3 minutes.
              This may indicate downstream database or fraud-check timeouts.

        # Alert when p99 latency exceeds 2 seconds — escalate
        - alert: PaymentLatencyP99Critical
          expr: |
            histogram_quantile(0.99,
              sum by(le) (
                rate(payment_latency_seconds_bucket[5m])
              )
            ) > 2.0
          for: 1m
          labels:
            severity: critical
            team: payments
          annotations:
            summary: "Payment p99 latency CRITICAL: {{ $value | humanizeDuration }}"

    - name: outbox.lag
      rules:
        # Alert when more than 1000 events wait in the outbox for 60s
        - alert: OutboxLagHigh
          expr: |
            max by(topic) (outbox_pending_events) > 1000
          for: 60s
          labels:
            severity: warning
            team: messaging
          annotations:
            summary: "Outbox topic {{ $labels.topic }} has {{ $value }} pending events"
            description: >
              The transactional outbox for topic {{ $labels.topic }} has accumulated
              more than 1000 pending events, suggesting the relay processor is falling
              behind or has stopped. Check Kafka connectivity and relay pod health.

        # Dead outbox — no events processed in 5 minutes when queue is non-empty
        - alert: OutboxRelayStalled
          # Both sides aggregated to the SAME labels (topic): "and" matches
          # series by labels, so a side keeping pod/instance labels would
          # never match and the alert could never fire
          expr: |
            (max by(topic) (outbox_pending_events) > 0)
            and
            (sum by(topic) (rate(outbox_events_published_total[5m])) == 0)
          for: 5m
          labels:
            severity: critical
            team: messaging
          annotations:
            summary: "Outbox relay has stalled for topic {{ $labels.topic }}"
```

---

## 6. قواعد التسجيل للاستعلامات المحسوبة مسبقًا

تجسّد قواعد التسجيل الاستعلامات المكلفة في سلاسل زمنية جديدة، فتُحمّل اللوحات بسرعة.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payment-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: payment.rates
      interval: 30s
      rules:
        # Pre-compute payment TPS per method and currency
        - record: payment_method_currency:payments_processed_success:rate5m
          expr: |
            sum by(payment_method, currency) (
              rate(payments_processed_total{status="success"}[5m])
            )

        # Pre-compute error ratio for SLO tracking (aggregated over everything)
        - record: cluster:payments_error_ratio:rate5m
          expr: |
            sum(rate(payments_processed_total{status="failure"}[5m]))
            /
            sum(rate(payments_processed_total[5m]))

        # Pre-compute the aggregated bucket rates once...
        - record: le:payment_latency_seconds_bucket:rate5m
          expr: |
            sum by(le) (rate(payment_latency_seconds_bucket[5m]))

        # ...and derive quantiles from them cheaply
        - record: cluster:payment_latency_seconds:p99_5m
          expr: |
            histogram_quantile(0.99, le:payment_latency_seconds_bucket:rate5m)

        - record: cluster:payment_latency_seconds:p50_5m
          expr: |
            histogram_quantile(0.50, le:payment_latency_seconds_bucket:rate5m)
```

تتبع أسماء قواعد التسجيل الاصطلاح `level:metric:operations` — حيث *level* يسمّي التسميات المتبقية بعد التجميع (`cluster` حين يُجمع كل شيء، و`payment_method_currency` حين تُبقى هاتان) — لتوضيح أصلها في اللوحات.

---

## 7. بنية Prometheus للإنتاج

```
                    ┌─────────────────────────────────────────┐
                    │          Kubernetes Cluster             │
                    │                                         │
  ┌──────────────┐  │  ┌────────────┐  ┌───────────────────┐ │
  │   Grafana    │  │  │  Payment   │  │  Fraud Detection  │ │
  │  Dashboards  │  │  │  Service   │  │      Service      │ │
  └──────┬───────┘  │  │ :8080/     │  │ :8080/            │ │
         │          │  │ actuator/  │  │ actuator/         │ │
         │ query    │  │ prometheus │  │ prometheus        │ │
         ▼          │  └─────┬──────┘  └────────┬──────────┘ │
  ┌──────────────┐  │        │ scrape            │ scrape     │
  │  Prometheus  │◄─┤────────┴───────────────────┘           │
  │  (operator)  │  │                                         │
  └──────┬───────┘  │  ┌────────────────────────────────────┐│
         │          │  │  PrometheusRule CRDs                ││
         │ alerts   │  │  - payment-service-alerts           ││
         ▼          │  │  - recording-rules                  ││
  ┌──────────────┐  │  └────────────────────────────────────┘│
  │ Alertmanager │  └─────────────────────────────────────────┘
  └──────┬───────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
 PagerDuty  Slack
```

---

## مزالق الإنتاج

### المزلق 1: إعداد سلال المدرج التكراري الخاطئ يخفي الزمن الحقيقي

كثيرًا ما لا تتوافق سلال المدرج التكراري الافتراضية في Micrometer مع أهداف مستوى الخدمة لديك، ويُستكمل المئين *داخل* السلة — فمع سلة من 300ms إلى ثانية، يكون "p99 = 480ms" تقديرًا قد يخفي p99 حقيقيًا قدره 900ms. وإذا وقع المئين في السلة الأخيرة (`+Inf`)، يعيد `histogram_quantile` ببساطة الحد الأعلى لأعلى سلة محدودة — فتصبح الأزمنة الأكبر من أكبر سلة لديك غير مرئية.

**الحل**: اضبط دائمًا سلالًا صريحة متوافقة مع أهداف مستوى الخدمة.

```yaml
# application.yml
management:
  metrics:
    distribution:
      slo:
        payment.latency: 50ms,100ms,200ms,300ms,500ms,750ms,1000ms,2000ms,5000ms
      percentiles-histogram:
        payment.latency: true
```

تحقق بالاستعلام عن السلال الخام: `payment_latency_seconds_bucket`. وتأكد من انتشار المشاهدات عبر السلال، لا تكدسها كلها في `+Inf`.

### المزلق 2: استخدام تسميات بتعدد غير محدود

التسمية التي تأتي قيمتها من مدخلات المستخدم أو تُولّد لكل طلب (مثل معرّف المعاملة، أو عنوان IP، أو رقم الحساب) تنتج سلسلة زمنية لكل قيمة فريدة. ومع ملايين المعاملات، يستنفد هذا ذاكرة Prometheus ويسبب إعادة تشغيل بنفاد الذاكرة.

**الحل**: أزل الوسوم المحظورة واحدد عدد السلاسل لكل مقياس في Micrometer بمرشحات `MeterFilter`.

```java
@Bean
public MeterFilter stripUnboundedTags() {
    // Remove per-entity identifiers from every meter, wherever they come from
    return MeterFilter.ignoreTags("account_id", "transaction_id", "user_id");
}

@Bean
public MeterFilter capUriTagCardinality() {
    // At most 100 distinct "uri" values for HTTP metrics; beyond that new
    // values are denied instead of creating new time series
    return MeterFilter.maximumAllowableTags(
        "http.server.requests", "uri", 100, MeterFilter.deny());
}
```

وكخط دفاع ثانٍ في جهة Prometheus، اضبط `sample_limit` و`label_limit` في إعداد الجمع، كي لا تستطيع خدمة واحدة سيئة السلوك إغراق الخادم — فيفشل الجمع بشكل مرئي بدلًا من ذلك.

### المزلق 3: تذبذب التنبيهات بسبب نوافذ تقييم قصيرة

التنبيه بـ `for: 0` ينطلق عند شذوذ جمع واحد (انقطاع شبكة عابر، أو جمع بطيء). ولأنظمة الدفع أنماط دفقات طبيعية؛ ويجب ألا توقظ ذروة 15 ثانية في معدل الأخطاء المهندسين في الثالثة فجرًا.

**الحل**: استخدم دائمًا مدة `for:` ذات معنى. لتنبيهات الدفع الحرجة، استخدم `for: 2m`. وللتحذيرات، استخدم `for: 5m`. واجمعها مع `repeat_interval` في Alertmanager لمنع إعادة الإشعار في الحوادث المستمرة.

```yaml
# Alertmanager config
route:
  receiver: payments-pagerduty
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h          # re-notify every 4h while the alert keeps firing
  routes:
    - matchers:                # "match:" is the deprecated older syntax
        - severity="critical"
      receiver: payments-pagerduty
      repeat_interval: 1h
    - matchers:
        - severity="warning"
      receiver: payments-slack
      repeat_interval: 24h
```

---

## قائمة تحقق الإنتاج

- [ ] كل عدادات الدفع تستخدم تسميات بتعدد محدود (payment_method، وcurrency، وstatus)
- [ ] سلال المدرج التكراري للزمن متوافقة مع عتبات أهداف مستوى الخدمة
- [ ] ‏`histogram_quantile` يستخدم `sum by(le)` قبل استدعاء الدالة
- [ ] نافذة `rate()` تساوي 4 أضعاف فترة الجمع على الأقل
- [ ] موارد PrometheusRule منشورة ومحمّلة (تحقق بـ `kubectl get prometheusrule`)
- [ ] مسارات Alertmanager مختبرة بـ `amtool check-config`
- [ ] قواعد التسجيل تغطي كل لوحات اللوحة المستخدمة في تتبع أهداف مستوى الخدمة
- [ ] حماية من التعدد العالي منفذة عبر MeterFilter ‏(ignoreTags / maximumAllowableTags) و`sample_limit` في الجمع
- [ ] كل المقاييس التي تتشارك اسمًا تستخدم مفاتيح الوسوم نفسها
- [ ] تعليقات أهداف الجمع متحقق منها — راجع `Status > Targets` في واجهة Prometheus
- [ ] مدد `for:` للتنبيهات مراجَعة وموثقة في أدلة التشغيل
- [ ] تنبيه تأخر الـ outbox يعمل ويُوجّه إلى المستقبل الصحيح
- [ ] ‏`external_labels` مضبوطة على العنقود والبيئة للاتحاد/Thanos

<!-- KNOWLEDGE-CHECK {
  "questions": [
    {
      "text": "تعمل خدمة دفع بـ 50 pod. وتريد حساب زمن الدفع عند p99 عبر الأسطول كاملًا. أي تعبير PromQL صحيح؟",
      "options": [
        "histogram_quantile(0.99, rate(payment_latency_seconds_bucket[5m]))",
        "histogram_quantile(0.99, sum by(le) (rate(payment_latency_seconds_bucket[5m])))",
        "avg(histogram_quantile(0.99, rate(payment_latency_seconds_bucket[5m])))",
        "quantile(0.99, payment_latency_seconds_bucket[5m])"
      ],
      "correct": 1,
      "explanation": "يجب جمع سلال المدرج التكراري عبر كل النسخ باستخدام sum by(le) قبل تمريرها إلى histogram_quantile. فالخيار A يحسب مئينات لكل نسخة ويعيد متجهًا. والخيار C يأخذ متوسط مئينات النسخ وهذا خاطئ إحصائيًا. والخيار D ليس PromQL صالحًا للمدرجات التكرارية."
    },
    {
      "text": "يضيف مطوّر جديد account_id كتسمية Micrometer على عدّاد دفع. ما الأثر الإنتاجي الأرجح؟",
      "options": [
        "يزيد زمن جمع Prometheus بمقدار 10ms",
        "ينفد Prometheus من الذاكرة بسبب انفجار التعدد ويُعاد تشغيله",
        "يختفي المقياس من لوحات Grafana",
        "يتوقف Alertmanager عن إرسال الإشعارات"
      ],
      "correct": 1,
      "explanation": "كل تركيبة قيم تسميات فريدة تنشئ سلسلة زمنية جديدة. ومع ملايين معرّفات الحسابات الفريدة، ينشئ Prometheus ملايين السلاسل الزمنية فيتعطل بنفاد الذاكرة (OOM). ويُعرف هذا بقنبلة التعدد وهو من أشيع حوادث Prometheus الإنتاجية في التقنية المالية."
    },
    {
      "text": "تنبيه لمعدل أخطاء الدفع يستخدم for: 0. وعند الثانية فجرًا، يسبب جمع Prometheus بطيء واحد ارتفاعًا لحظيًا. ماذا يحدث؟",
      "options": [
        "لا شيء — يتجاهل Prometheus الشذوذات أحادية العينة",
        "ينتظر Alertmanager مدة group_wait قبل الإرسال",
        "ينطلق التنبيه فورًا ويستدعي مهندس المناوبة",
        "يُكتم التنبيه حتى ساعات العمل"
      ],
      "correct": 2,
      "explanation": "مع for: 0، يصبح التنبيه نشطًا عند أول تقييم يحقق الشرط، دون فترة استقرار. ولا ينتظر Alertmanager إلا مدة group_wait القصيرة (مثل 30 ثانية) لتجميع التنبيهات، ثم يستدعي — فيوقظ شذوذ لحظي مهندس المناوبة، ويتذبذب التنبيه. ويجب أن تستخدم تنبيهات الإنتاج دائمًا مدة for: ذات معنى (2m للحرجة، و5m للتحذيرات) لترشيح الضجيج العابر."
    }
  ]
} -->

<!-- PRACTICAL-CHALLENGE {
  "title": "تجهيز Prometheus لخدمة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 90,
  "tasks": [
    {
      "id": "task-1",
      "description": "جهّز خدمة دفع Spring Boot بـ Micrometer: أضف Timer لزمن الدفع بسلال مدرج تكراري متوافقة مع أهداف مستوى الخدمة (50ms، و100ms، و250ms، و500ms، وثانية، وثانيتان)، وCounter مقسمًا حسب status وpayment_method، وGauge لعدد أحداث الـ outbox المعلقة. وتحقق من ظهور المقاييس على /actuator/prometheus."
    },
    {
      "id": "task-2",
      "description": "اكتب ثلاثة استعلامات PromQL: (1) معاملات الدفع الناجحة في الثانية مجمّعة حسب العملة، (2) زمن p99 وp50 للأسطول، (3) معدل الأخطاء كنسبة مئوية. وتحقق منها على نسخة Prometheus محلية باستخدام docker-compose مع خدمة الدفع كهدف جمع."
    },
    {
      "id": "task-3",
      "description": "أنشئ مورد PrometheusRule بثلاث قواعد تنبيه: PaymentErrorRateHigh (> 1% لمدة 2m، وseverity: critical)، وPaymentLatencyP99High (> 500ms لمدة 3m، وseverity: warning)، وOutboxLagHigh (> 500 حدث معلق لمدة 60s، وseverity: warning). وضمّن تعليقات أدلة التشغيل. وانشره على عنقود kind محلي مع prometheus-operator."
    },
    {
      "id": "task-4",
      "description": "أضف قواعد تسجيل تحسب مسبقًا معدلات سلال الزمن المجمّعة، وزمن p99، ونسبة الأخطاء، بأسماء وفق اصطلاح level:metric:operations ‏(level = التسميات المُبقاة). وأضف مرشحات MeterFilter تزيل الوسوم غير المحدودة (account_id، وtransaction_id، وuser_id) وتحدّ تعدد وسم uri. واكتب اختبار وحدة باستخدام SimpleMeterRegistry للتحقق من أن المرشحات تمنع قنابل التعدد."
    }
  ]
} -->
