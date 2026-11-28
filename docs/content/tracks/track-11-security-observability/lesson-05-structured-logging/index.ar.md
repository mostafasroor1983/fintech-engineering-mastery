---
id: track-11-lesson-05
title: "السجلات المنظّمة — الربط والبحث على نطاق واسع"
slug: structured-logging
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 5
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [structured-logging, JSON, correlation-id, ELK, Loki]
prerequisites: [track-11-lesson-01]
---

# التسجيل المنظم — الربط والبحث على نطاق واسع

> [!NOTE]
> في نظام مالي يعالج 50,000 معاملة في الثانية، السجلات غير المنظمة عديمة الفائدة. ويجب أن يستطيع المهندس الذي يحقق في حوالة فاشلة تشغيل استعلام واحد ورؤية كل سطر سجل عبر كل الخدمات التي لمست تلك المعاملة، بالترتيب، وبالسياق الكامل. وتتطلب هذه القدرة تسجيلًا منظمًا، ومعرّفات ترابط متسقة، ومنصة سجلات تستطيع البحث في مليار سطر سجل في أقل من 5 ثوانٍ.

## 1. التسجيل المنظم مع Logback وJSON

### 1.1 ‏Logstash Logback Encoder

```xml
<!-- pom.xml -->
<dependency>
  <groupId>net.logstash.logback</groupId>
  <artifactId>logstash-logback-encoder</artifactId>
  <version>7.4</version>
</dependency>
```

```xml
<!-- src/main/resources/logback-spring.xml -->
<configuration>

  <!-- JSON appender for production (stdout → log aggregator) -->
  <springProfile name="!local">
    <appender name="JSON_STDOUT" class="ch.qos.logback.core.ConsoleAppender">
      <encoder class="net.logstash.logback.encoder.LogstashEncoder">
        <!-- Service metadata included in every log line -->
        <customFields>{"service":"payment-service","team":"payments"}</customFields>

        <!-- Include MDC keys explicitly (don't expose all MDC in production) -->
        <includeMdcKeyName>correlation_id</includeMdcKeyName>
        <includeMdcKeyName>user_id</includeMdcKeyName>
        <includeMdcKeyName>account_id</includeMdcKeyName>
        <includeMdcKeyName>payment_id</includeMdcKeyName>
        <includeMdcKeyName>trace_id</includeMdcKeyName>
        <includeMdcKeyName>span_id</includeMdcKeyName>

        <!-- Field names in the JSON output (renaming only - masking of
             sensitive values needs a converter or the LogScrubber below) -->
        <fieldNames>
          <timestamp>@timestamp</timestamp>
          <message>message</message>
          <logger>logger</logger>
          <thread>thread</thread>
          <level>level</level>
        </fieldNames>
      </encoder>
    </appender>

    <root level="INFO">
      <appender-ref ref="JSON_STDOUT"/>
    </root>
  </springProfile>

  <!-- Human-readable format for local development -->
  <springProfile name="local">
    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
      <encoder>
        <pattern>%d{HH:mm:ss.SSS} [%thread] %-5level [%X{correlation_id}] %logger{36} - %msg%n</pattern>
      </encoder>
    </appender>
    <root level="DEBUG">
      <appender-ref ref="CONSOLE"/>
    </root>
  </springProfile>

</configuration>
```

يبدو سطر سجل JSON الناتج هكذا:

```json
{
  "@timestamp": "2025-11-08T14:23:01.482Z",
  "level": "INFO",
  "logger": "c.b.p.s.PaymentProcessingService",
  "message": "Payment processed successfully",
  "service": "payment-service",
  "team": "payments",
  "correlation_id": "pay-7f3a2b1c-4d5e-6f7a-8b9c-0d1e2f3a4b5c",
  "payment_id": "PAY-20251108-001234",
  "account_id": "ACC-7891011",
  "user_id": "usr-9876543",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "thread": "http-nio-8080-exec-3",
  "duration_ms": 142
}
```

---

## 2. ‏MDC لمعرّفات الترابط والسياق المالي

سياق التشخيص المعيّن (MDC) خريطة محلية للخيط يضمّنها Logback في كل سطر سجل. اضبطه مرة واحدة عند دخول الطلب فتتضمن كل عبارات السجل اللاحقة في الخيط نفسه القيم تلقائيًا.

### 2.1 مرشح MDC لطلبات HTTP

```java
package com.bank.payments.logging;

import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;

@Component
public class MdcLoggingFilter extends OncePerRequestFilter {

    private static final String CORRELATION_ID_HEADER = "X-Correlation-ID";
    private static final String CORRELATION_ID_MDC_KEY = "correlation_id";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {

        String correlationId = request.getHeader(CORRELATION_ID_HEADER);
        // The header comes from the client: accept it only if it looks like
        // an ID (no newlines/control chars for log injection, bounded length)
        if (correlationId == null || !correlationId.matches("[A-Za-z0-9._-]{1,64}")) {
            correlationId = "auto-" + UUID.randomUUID().toString().replace("-", "");
        }

        try {
            MDC.put(CORRELATION_ID_MDC_KEY, correlationId);
            // Also echo back to response header for client correlation
            response.addHeader(CORRELATION_ID_HEADER, correlationId);
            filterChain.doFilter(request, response);
        } finally {
            // Always clear MDC to prevent thread-local leakage in thread pool reuse
            MDC.clear();
        }
    }
}
```

### 2.2 سياق MDC في خدمة الدفع

```java
package com.bank.payments.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;

@Service
public class PaymentProcessingService {

    private static final Logger log = LoggerFactory.getLogger(PaymentProcessingService.class);

    public PaymentResult processPayment(PaymentRequest request) {
        // Enrich MDC with payment-specific context for all subsequent log lines
        MDC.put("payment_id", request.getPaymentId());
        MDC.put("payment_type", request.getType().name());
        MDC.put("payment_currency", request.getCurrency());
        // Amounts: fine in audit logs, keep them out of general debug logging
        // NEVER put account numbers, card numbers, or names

        try {
            log.info("Starting payment processing",
                // Logstash encoder also supports structured arguments via StructuredArguments
                net.logstash.logback.argument.StructuredArguments.keyValue("sender", request.getSenderRef()),
                net.logstash.logback.argument.StructuredArguments.keyValue("step", "start"));

            FraudResult fraud = fraudCheckClient.check(request);
            log.info("Fraud check completed",
                net.logstash.logback.argument.StructuredArguments.keyValue("fraud_score", fraud.getScore()),
                net.logstash.logback.argument.StructuredArguments.keyValue("fraud_decision", fraud.getDecision()));

            if (fraud.isBlocked()) {
                log.warn("Payment blocked by fraud engine",
                    net.logstash.logback.argument.StructuredArguments.keyValue("fraud_reason", fraud.getReason()));
                return PaymentResult.blocked(fraud.getReason());
            }

            LedgerEntry entry = ledgerRepository.save(LedgerEntry.from(request));
            log.info("Ledger entry created",
                net.logstash.logback.argument.StructuredArguments.keyValue("ledger_entry_id", entry.getId()));

            return PaymentResult.success(entry.getId());

        } catch (Exception e) {
            // The exception must be the LAST argument -- SLF4J only treats a
            // trailing Throwable as the exception (with stack trace)
            log.error("Payment processing failed",
                net.logstash.logback.argument.StructuredArguments.keyValue("error_type", e.getClass().getSimpleName()),
                e);
            throw e;
        } finally {
            // Remove payment-specific keys; correlation_id stays (set by filter)
            MDC.remove("payment_id");
            MDC.remove("payment_type");
            MDC.remove("payment_currency");
        }
    }
}
```

### 2.3 نشر MDC عبر الحدود غير المتزامنة

‏MDC محلي للخيط. فحين تستخدم `@Async`، أو `CompletableFuture`، أو الخيوط الافتراضية، **لا** يُنشر MDC تلقائيًا (تستطيع مكتبة context-propagation من Micrometer أتمتة ذلك؛ ويُظهر النمط اليدوي أدناه ما تفعله):

```java
package com.bank.payments.async;

import org.slf4j.MDC;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

@Service
public class AsyncNotificationService {

    /**
     * Correctly propagates MDC to async thread.
     */
    public CompletableFuture<Void> sendNotificationAsync(PaymentEvent event) {
        // Capture MDC state before submitting to async executor
        Map<String, String> mdcContext = MDC.getCopyOfContextMap();

        return CompletableFuture.runAsync(() -> {
            // Restore MDC in the async thread
            if (mdcContext != null) {
                MDC.setContextMap(mdcContext);
            }
            try {
                sendNotification(event);
            } finally {
                MDC.clear();
            }
        });
    }
}
```

لـ `@Async` في Spring مع مجمّعات الخيوط، اضبط `TaskDecorator` مخصصًا:

```java
package com.bank.payments.config;

import org.slf4j.MDC;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.TaskDecorator;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.Map;
import java.util.concurrent.Executor;

@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean(name = "paymentTaskExecutor")
    public Executor paymentTaskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setMaxPoolSize(50);
        executor.setQueueCapacity(500);
        executor.setThreadNamePrefix("payment-async-");
        executor.setTaskDecorator(new MdcTaskDecorator());
        executor.initialize();
        return executor;
    }

    private static class MdcTaskDecorator implements TaskDecorator {
        @Override
        public Runnable decorate(Runnable runnable) {
            Map<String, String> contextMap = MDC.getCopyOfContextMap();
            return () -> {
                if (contextMap != null) {
                    MDC.setContextMap(contextMap);
                }
                try {
                    runnable.run();
                } finally {
                    MDC.clear();
                }
            };
        }
    }
}
```

---

## 3. ما لا يدخل السجلات أبدًا — البيانات الشخصية والمالية

في الخدمات المالية، تسجيل البيانات الحساسة مخالفة تنظيمية (تقليل البيانات في GDPR والمادة 25، والمتطلب 3 في PCI DSS):

| الحقل | تسجيل؟ | البديل |
|-------|------|-------------|
| رقم البطاقة (PAN) | أبدًا | سجّل رمزًا مميزًا (token)، أو آخر 4 أرقام فقط |
| ‏CVV | أبدًا | لا تسجّل شيئًا — ولا رمزًا |
| رقم الحساب | أبدًا | سجّل مرجع UUID داخليًا |
| رمز الفرع + الحساب | أبدًا | سجّل معرّف الحساب الداخلي |
| الاسم الكامل | أبدًا | سجّل معرّف المستخدم / مرجع العميل |
| البريد الإلكتروني | أبدًا | سجّل بريدًا مجزّأً (hash) أو معرّف المستخدم |
| عنوان IP | بحذر | قد يكون بيانات شخصية وفق GDPR — استخدمه باعتدال |
| مبلغ الدفعة | بحذر | مقبول في سجلات التدقيق، لا في سجلات التصحيح |
| ‏IBAN | أبدًا | سجّل IBAN مقنّعًا (أول 4 + آخر 4) |

نفّذ أداة تنقية لالتقاط التسريبات العرضية:

```java
package com.bank.payments.logging;

import java.util.regex.Pattern;

/**
 * Pre-checks log message parameters to detect and redact PII patterns.
 * Use as a last resort — primary prevention is developer discipline.
 */
public class LogScrubber {

    // Patterns over-match (any 16-digit number starting with 4...): in a
    // real scrubber, confirm candidates with a Luhn check before redacting
    private static final Pattern VISA_CARD = Pattern.compile("4[0-9]{12}(?:[0-9]{3})?");
    // Mastercard: 51-55 and the 2221-2720 range
    private static final Pattern MASTERCARD =
        Pattern.compile("(?:5[1-5][0-9]{2}|222[1-9]|22[3-9][0-9]|2[3-6][0-9]{2}|27[01][0-9]|2720)[0-9]{12}");
    private static final Pattern IBAN = Pattern.compile("[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}");
    private static final Pattern UK_SORT_CODE = Pattern.compile("\\d{2}-\\d{2}-\\d{2}");

    public static String scrub(String message) {
        if (message == null) return null;
        message = VISA_CARD.matcher(message).replaceAll("[CARD-REDACTED]");
        message = MASTERCARD.matcher(message).replaceAll("[CARD-REDACTED]");
        message = IBAN.matcher(message).replaceAll("[IBAN-REDACTED]");
        message = UK_SORT_CODE.matcher(message).replaceAll("[SORTCODE-REDACTED]");
        return message;
    }
}
```

---

## 4. حزمة ELK لتجميع السجلات

### 4.1 البنية

```
Payment Services (JSON stdout)
  └─→ Fluent Bit (DaemonSet, Kubernetes)
        └─→ Logstash (parsing, enrichment)
              └─→ Elasticsearch (storage, indexing)
                    └─→ Kibana (search, dashboards)
```

### 4.2 إعداد Fluent Bit

```yaml
# fluent-bit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info
        Parsers_File  parsers.conf

    [INPUT]
        Name              tail
        Path              /var/log/containers/payment-service*.log
        # containerd/CRI-O (all current Kubernetes) write the CRI log
        # format, not Docker JSON
        multiline.parser  cri
        Tag               payment.*
        Refresh_Interval  5
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On

    [FILTER]
        Name   kubernetes
        Match  payment.*
        Merge_Log             On
        Keep_Log              Off
        K8S-Logging.Parser    On
        K8S-Logging.Exclude   Off

    [FILTER]
        Name  grep
        Match payment.*
        # Drop health check logs to reduce volume
        Exclude message /actuator/health

    [OUTPUT]
        Name            es
        Match           payment.*
        Host            elasticsearch.logging.svc.cluster.local
        Port            9200
        Suppress_Type_Name On      # Elasticsearch 8 has no mapping types
        Logstash_Format On
        Logstash_Prefix payment-logs
        tls             On
        tls.verify      On
        tls.ca_file     /fluent-bit/certs/ca.crt

  parsers.conf: |
    [PARSER]
        Name        docker
        Format      json
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L
```

### 4.3 أمثلة استعلامات Kibana

```
# Find all logs for a specific payment
payment_id: "PAY-20251108-001234"

# Find all errors in the last hour for payment-service
service: "payment-service" AND level: "ERROR"

# Find all fraud rejections with score > 0.8
fraud_decision: "BLOCKED" AND fraud_score: [0.8 TO *]

# Correlate by trace ID across all services
trace_id: "4bf92f3577b34da6a3ce929d0e0e4736"

# Find logs that took more than 1 second
duration_ms: [1000 TO *] AND service: "payment-service"
```

---

## 5. ‏Grafana Loki كبديل خفيف

‏Loki نظام تجميع سجلات من Grafana Labs. وبخلاف Elasticsearch، لا يفهرس محتوى السجلات — بل التسميات (البيانات الوصفية) فقط. وهذا يجعل تشغيله أرخص بكثير.

### 5.1 بنية Loki

```
Fluent Bit / Promtail (agent)
  └─→ Loki (storage: S3/GCS + local index)
        └─→ Grafana (unified view: metrics + logs + traces)
```

### 5.2 إعداد Promtail لخدمات الدفع

‏Promtail مُهمل (ينتهي عمره في 2026)؛ وخليفته **Grafana Alloy**، الذي يستطيع تحويل إعدادات Promtail ‏(`alloy convert`). ومفاهيم الخط أدناه — إعادة التسمية، وتحليل JSON، والتسميات منخفضة التعدد، وإسقاط الضجيج — هي نفسها في Alloy.

```yaml
# promtail-config.yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push
    tls_config:
      ca_file: /certs/ca.crt

scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: service
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
    pipeline_stages:
      - json:
          expressions:
            level: level
            correlation_id: correlation_id
            payment_id: payment_id
            trace_id: trace_id
      - labels:
          level:            # low-cardinality only; never payment_id or trace_id
                            # (service is already a label from relabel_configs)
      - drop:
          expression: ".*actuator/health.*"
          drop_counter_reason: health_check_filtered
```

### 5.3 استعلامات LogQL

```logql
# All errors for payment service in last 1h
{service="payment-service", level="ERROR"}

# Logs for a specific correlation ID
{service=~"payment.*"} | json | correlation_id="pay-7f3a2b1c"

# Payment failures with fraud context
{service="payment-service"}
  | json
  | fraud_decision="BLOCKED"
  | line_format "{{.payment_id}} fraud_score={{.fraud_score}}"

# Error rate over time (metrics from logs)
sum(rate({service="payment-service", level="ERROR"}[5m]))
/
sum(rate({service="payment-service"}[5m]))

# Slow operations from logs
{service="payment-service"}
  | json
  | duration_ms > 1000
  | line_format "slow: {{.payment_id}} took {{.duration_ms}}ms"
```

---

## 6. سياسات الاحتفاظ بالسجلات للامتثال المالي

تحدد اللوائح مدد احتفاظ دنيا. وأمثلة لشركة دفع بريطانية: تتطلب لوائح مكافحة غسل الأموال لعام 2017 حفظ سجلات المعاملات 5 سنوات؛ ويتطلب PCI DSS 10.5.1 حفظ 12 شهرًا من سجلات التدقيق مع إتاحة آخر 3 أشهر فورًا. (أما FCA COBS 11.8، الذي يُستشهد به كثيرًا هنا، فيتعلق بتسجيل المكالمات والاتصالات الإلكترونية في أعمال الاستثمار.) وتحقق من القواعد في نطاقك القضائي وترخيصك.

| فئة السجل | الحد الأدنى للاحتفاظ | الموصى به |
|-------------|------------------|-------------|
| سجلات معاملات الدفع | 5 سنوات (لوائح مكافحة غسل الأموال البريطانية) | 7 سنوات |
| سجلات ضبط الوصول / التدقيق | سنة (PCI DSS 10.5.1) | سنتان |
| سجلات الحوادث الأمنية | سنة (PCI DSS) | سنتان |
| سجلات تصحيح التطبيق | بلا إلزام | 30 يومًا |
| سجلات مسار التدقيق | 5 سنوات | 7 سنوات |

احفظ السجلات طويلة الاحتفاظ (المعاملات، ومسار التدقيق) في مخزن غير قابل للتعديل — قاعدة بيانات أو تخزين كائنات WORM — بدل إبقاء كل سجلات التطبيق في عنقود البحث 7 سنوات. فيحتاج عنقود البحث حينها أسابيع إلى أشهر فقط.

### 6.1 إدارة دورة حياة الفهارس (Elasticsearch)

```jsonc
// PUT _ilm/policy/payment-logs-policy
// (the old "freeze" action no longer exists in Elasticsearch 8 -- cold data
//  goes to searchable snapshots instead; long-term records live elsewhere)
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_primary_shard_size": "50gb",
            "max_age": "1d"
          },
          "set_priority": {"priority": 100}
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink": {"number_of_shards": 1},
          "forcemerge": {"max_num_segments": 1},
          "set_priority": {"priority": 50}
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "set_priority": {"priority": 0},
          "searchable_snapshot": {"snapshot_repository": "s3-log-archive"}
        }
      },
      "delete": {
        "min_age": "365d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

---

## 7. التنبيه القائم على السجلات

يدعم Loki قواعد التنبيه (عبر مكوّن ruler) بناءً على استعلامات مقاييس LogQL:

```yaml
# loki/rules/payment-alerts.yaml
groups:
  - name: payment_log_alerts
    rules:
      - alert: PaymentErrorLogSpike
        expr: |
          sum(rate({service="payment-service", level="ERROR"}[5m])) > 10
        for: 2m
        labels:
          severity: warning
          team: payments
        annotations:
          summary: "Payment service error log rate is high"
          description: "More than 10 error logs/s for 2 minutes"

      - alert: FraudBlockLogSpike
        expr: |
          sum(rate({service="payment-service"}
            | json
            | fraud_decision="BLOCKED" [5m])) > 5
        for: 3m
        labels:
          severity: warning
          team: fraud
        annotations:
          summary: "Fraud block rate elevated in logs"
```

---

## 8. الملخص

للتسجيل المنظم في نظام مالي ثلاثة متطلبات غير قابلة للتفاوض:

1. **يجب أن يكون كل سطر سجل كائن JSON قابلًا للتحليل آليًا.** فرسائل السجل النصية الحرة التي تتطلب تحليلًا بالتعابير النمطية عبء صيانة وبطيئة الاستعلام على نطاق واسع.

2. **يجب أن يحمل كل سطر سجل معرّف ترابط** يمتد عبر كل الخدمات المشاركة في معاملة واحدة. ودونه، لا تستطيع إعادة بناء رحلة دفعة فاشلة عبر خمس خدمات.

3. **لا بيانات شخصية أو بيانات حسابات مالية في السجلات.** وهذا متطلب تنظيمي (GDPR، وPCI DSS) ومتطلب أمني. فاستخدم معرّفات داخلية معتمة (معرّف الدفعة، ومعرّف المستخدم) في السجلات، لا أرقام البطاقات، أو أرقام الحسابات، أو البيانات الشخصية أبدًا.

حزمة ELK خيار مجرب ومرن بعبء تشغيلي أعلى. وGrafana Loki أرخص تشغيلًا ويتكامل أصليًا مع لوحات Grafana، فهو خيار ممتاز للفرق التي تستخدم بالفعل Prometheus + Grafana للمقاييس.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الحد الأدنى من الحقول التي يجب أن يتضمنها كل سطر سجل في خدمة دفع مصغّرة لتمكين ربط المعاملات عبر الخدمات؟",
      "options": ["timestamp، وservice، وlevel", "timestamp، وservice، وlevel، وcorrelation_id، وpayment_id، وtrace_id", "timestamp، وmessage، وexception", "service، وlevel، وuser_id"],
      "correct": 1,
      "explanation": "يتطلب الربط عبر الخدمات correlation_id (معرّف بنطاق الطلب يُمرر عبر كل الخدمات)، وpayment_id (معرّف مجال العمل)، وtrace_id (يربط بالتتبعات الموزعة). ودونها، لا تستطيع إعادة بناء رحلة دفعة محددة عبر خدمات متعددة."
    },
    {
      "text": "وفق لوائح مكافحة غسل الأموال البريطانية لعام 2017، ما الحد الأدنى لمدة الاحتفاظ بسجلات معاملات الدفع؟",
      "options": ["سنة واحدة", "سنتان", "5 سنوات", "7 سنوات"],
      "correct": 2,
      "explanation": "تتطلب لوائح مكافحة غسل الأموال البريطانية حفظ سجلات العناية الواجبة تجاه العملاء والمعاملات 5 سنوات (بعد انتهاء علاقة العمل / المعاملة). وتحتفظ شركات كثيرة 7 سنوات لتتوافق مع نوافذ التدقيق والإفصاح القانوني. ويمكن لإدارة دورة حياة الفهارس في Elasticsearch وقواعد دورة حياة تخزين الكائنات فرض الاحتفاظ تلقائيًا — ويُفضّل أن تكون السجلات طويلة الأمد في تخزين غير قابل للتعديل بدل عنقود بحث السجلات. (يُستشهد كثيرًا بـ FCA COBS 11.8 هنا، لكنه يغطي تسجيل الاتصالات في أعمال الاستثمار.)"
    },
    {
      "text": "لماذا يجب ألا تظهر أرقام البطاقات الكاملة (PAN) أبدًا في سجلات التطبيق؟",
      "options": ["ملفات السجلات كبيرة جدًا لتخزين هذه البيانات", "أنظمة السجلات (Elasticsearch، وLoki) ليست ضمن نطاق PCI، فأي PAN كامل في السجلات يُدخل بنية السجلات كاملة في نطاق PCI DSS وينشئ التزامات امتثال لـ GDPR", "يجعل الإخفاء البيانات غير قابلة للاستخدام في التصحيح على أي حال", "لا تستطيع أنظمة تجميع السجلات التعامل مع الحقول المشفرة"],
      "correct": 1,
      "explanation": "يتبع نطاق PCI DSS البيانات. فأي نظام يخزن بيانات حاملي البطاقات أو يعالجها أو ينقلها يجب أن يلبي متطلبات PCI DSS كاملة. وPAN كامل في سجلات تتدفق إلى Elasticsearch أو Loki يُدخل تلك الأنظمة في نطاق PCI، فيزيد عبء الامتثال وتكاليف التدقيق بشكل كبير. أما الرمز المميز (token) أو آخر أربعة أرقام فمقبولان — فالـ PAN المقتطع ليس بيانات حاملي بطاقات."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "خط تسجيل منظم لخدمات الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 55,
  "tasks": [
    {"id": "1", "description": "اضبط Logback في خدمة دفع Spring Boot لإخراج سجلات JSON منظمة تتضمن: timestamp، وlevel، وservice، وcorrelation_id، وpayment_id، وtrace_id، وspan_id، وduration_ms، ومحوّل إخفاء PAN ينقّح أرقام البطاقات المطابقة لنمط Luhn قبل وصولها إلى أي appender."},
    {"id": "2", "description": "اكتب HandlerInterceptor في Spring MVC يستخرج correlation_id من ترويسات الطلب الوارد أو يولّده ويضعه في MDC، مع ضمان نشره إلى كل استدعاءات RestTemplate وWebClient اللاحقة."},
    {"id": "3", "description": "اضبط DaemonSet لـ Fluent Bit لجمع سجلات JSON من pods ‏Kubernetes، وتحليل JSON، وإضافة تسميات البيانات الوصفية لـ Kubernetes (namespace، وpod، وapp)، وترشيح ضجيج /actuator/health، والشحن إلى فهرس Elasticsearch محلي بنمط التسمية payment-logs-YYYY.MM.DD."},
    {"id": "4", "description": "اكتب ثلاثة استعلامات Kibana/Elasticsearch: واحد يسترجع كل أسطر السجل لـ correlation_id محدد عبر كل الخدمات مرتبة حسب الطابع الزمني، وواحد يجد كل سجلات ERROR لـ payment-service في الساعة الأخيرة مع حقول payment_id، وواحد يكتشف أي سطر سجل يحتوي رقم بطاقة محتملًا غير مقنّع باستخدام نمط تعبير نمطي."}
  ]
}
-->
