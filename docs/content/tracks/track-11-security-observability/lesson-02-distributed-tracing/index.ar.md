---
id: track-11-lesson-02
title: "التتبع الموزع — السببية وأخذ العينات والتحليل"
slug: distributed-tracing
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 2
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [distributed-tracing, Jaeger, Zipkin, sampling, correlation-id]
prerequisites: [track-11-lesson-01]
---

# التتبع الموزع — السببية، وأخذ العينات، والتحليل

> [!NOTE]
> التتبع الموزع هو الفرق بين تخمين مكان الزمن الضائع ومعرفة أي خدمة، أو استدعاء قاعدة بيانات، أو اعتمادية خارجية أضافت بالضبط 400ms إلى زمن استجابة الدفع عند P99. وعلى مستوى المهندس الرئيسي يجب أن تملك لا التجهيز فقط بل استراتيجية أخذ العينات، وتكلفة التخزين، وسير عمل التحليل الذي يستخدمه فريقك أثناء الحوادث.

## 1. نموذج التتبع في OpenTelemetry

يمثل **التتبع (trace)** الرحلة الكاملة لطلب عبر نظامك الموزع. وهو رسم بياني موجّه لا دوري من **الامتدادات (spans)**، يمثل كل منها وحدة عمل واحدة (استدعاء معالج HTTP، أو استعلام قاعدة بيانات، أو نشر في Kafka). ويسجل كل امتداد:

- ‏`traceId` — معرّف 128 بت يتشاركه كل امتداد في التتبع
- ‏`spanId` — معرّف 64 بت فريد لهذا الامتداد
- ‏`parentSpanId` — معرّف الامتداد المستدعي (غائب في الامتداد الجذري)
- ‏`startTime` / ‏`endTime` — أوقات بدقة النانوثانية
- ‏`status` — ‏OK، أو ERROR، أو UNSET
- ‏`attributes` — أزواج مفتاح/قيمة (طريقة HTTP، وعبارة قاعدة البيانات، إلخ)
- ‏`events` — سجلات بطابع زمني داخل عمر الامتداد
- ‏`links` — مراجع عبر التتبعات (مثل مستهلك Kafka يرتبط بتتبع المنتج)

### 1.1 أنواع الامتدادات

| النوع | الاستخدام |
|------|-----|
| `SERVER` | معالج HTTP/gRPC وارد |
| `CLIENT` | استدعاء HTTP/gRPC/قاعدة بيانات صادر |
| `PRODUCER` | نشر في Kafka/JMS |
| `CONSUMER` | استقبال من Kafka/JMS |
| `INTERNAL` | منطق عمل داخل خدمة |

### 1.2 إضافة OpenTelemetry إلى Spring Boot

```xml
<!-- pom.xml -->
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>io.opentelemetry.instrumentation</groupId>
      <artifactId>opentelemetry-instrumentation-bom</artifactId>
      <version>2.5.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <!-- The starter brings the API, SDK, OTLP exporter and auto-configuration.
       (Use a current BOM version. Spring Boot's own alternative is Micrometer
       Tracing with the OTel bridge -- pick ONE of the two, not both.) -->
  <dependency>
    <groupId>io.opentelemetry.instrumentation</groupId>
    <artifactId>opentelemetry-spring-boot-starter</artifactId>
  </dependency>
</dependencies>
```

```yaml
# application.yaml — OTel SDK configuration (OpenTelemetry starter keys;
# "management.tracing.*" would configure Micrometer Tracing instead)
otel:
  traces:
    sampler: parentbased_traceidratio   # follow the caller's decision
    sampler.arg: 1.0                     # 100% in dev; 0.01-0.1 in production
  exporter:
    otlp:
      endpoint: http://otel-collector:4317
      protocol: grpc
  resource:
    attributes:
      service.name: payment-service
      service.version: ${APP_VERSION:local}
      deployment.environment: ${ENVIRONMENT:dev}
  # exporters: otlp is the default for traces, metrics and logs
```

### 1.3 إنشاء امتدادات يدويًا لمنطق عمل الدفع

يغطي التجهيز التلقائي HTTP وJDBC تلقائيًا. ولخطوات الدفع الحرجة للعمل تحتاج امتدادات صريحة:

```java
package com.bank.payments.service;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import org.springframework.stereotype.Service;

@Service
public class PaymentProcessingService {

    private static final Tracer tracer =
        GlobalOpenTelemetry.getTracer("payment-service", "1.0.0");

    private final FraudCheckClient fraudCheckClient;
    private final LedgerRepository ledgerRepository;
    private final NotificationService notificationService;

    public PaymentProcessingService(FraudCheckClient fraudCheckClient,
                                    LedgerRepository ledgerRepository,
                                    NotificationService notificationService) {
        this.fraudCheckClient = fraudCheckClient;
        this.ledgerRepository = ledgerRepository;
        this.notificationService = notificationService;
    }

    public PaymentResult processPayment(PaymentRequest request) {
        Span span = tracer.spanBuilder("processPayment")
            .setSpanKind(SpanKind.INTERNAL)
            .startSpan();

        try (Scope scope = span.makeCurrent()) {
            span.setAttribute("payment.amount", request.getAmount().toPlainString());
            span.setAttribute("payment.currency", request.getCurrency());
            span.setAttribute("payment.type", request.getType().name());
            span.setAttribute("payment.sender_account_id", request.getSenderAccountId());

            FraudResult fraud = runFraudCheck(request);
            if (fraud.isBlocked()) {
                // A fraud block is an expected BUSINESS outcome, not a
                // technical error: record it as an attribute and leave the
                // status OK, or error dashboards and "keep all errors"
                // sampling fill up with normal declines
                span.setAttribute("payment.fraud_blocked", true);
                return PaymentResult.blocked(fraud.getReason());
            }

            LedgerEntry entry = postToLedger(request);
            notifyParties(request, entry);

            span.setAttribute("payment.ledger_entry_id", entry.getId());
            span.setStatus(StatusCode.OK);
            return PaymentResult.success(entry.getId());

        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            throw e;
        } finally {
            span.end();
        }
    }

    private FraudResult runFraudCheck(PaymentRequest request) {
        // INTERNAL: the HTTP client call inside creates its own CLIENT span
        Span fraudSpan = tracer.spanBuilder("fraudCheck")
            .setSpanKind(SpanKind.INTERNAL)
            .startSpan();
        try (Scope scope = fraudSpan.makeCurrent()) {
            fraudSpan.setAttribute("fraud.model_version", "v3.2");
            FraudResult result = fraudCheckClient.check(request);
            fraudSpan.setAttribute("fraud.score", result.getScore());
            fraudSpan.setAttribute("fraud.decision", result.getDecision().name());
            return result;
        } catch (Exception e) {
            fraudSpan.recordException(e);
            fraudSpan.setStatus(StatusCode.ERROR, e.getMessage());
            throw e;
        } finally {
            fraudSpan.end();
        }
    }

    private LedgerEntry postToLedger(PaymentRequest request) {
        Span ledgerSpan = tracer.spanBuilder("postLedgerEntry")
            .setSpanKind(SpanKind.INTERNAL)
            .startSpan();
        try (Scope scope = ledgerSpan.makeCurrent()) {
            LedgerEntry entry = ledgerRepository.save(LedgerEntry.from(request));
            ledgerSpan.setAttribute("db.operation", "INSERT");
            ledgerSpan.setAttribute("db.table", "ledger_entries");
            ledgerSpan.setAttribute("ledger.entry_id", entry.getId());
            return entry;
        } finally {
            ledgerSpan.end();
        }
    }

    private void notifyParties(PaymentRequest request, LedgerEntry entry) {
        // INTERNAL wrapper; the Kafka send inside gets its own PRODUCER span
        Span notifySpan = tracer.spanBuilder("notifyParties")
            .setSpanKind(SpanKind.INTERNAL)
            .startSpan();
        try (Scope scope = notifySpan.makeCurrent()) {
            notificationService.sendPaymentConfirmation(request, entry);
        } finally {
            notifySpan.end();
        }
    }
}
```

---

## 2. نشر سياق التتبع — W3C TraceContext

تعرّف مواصفة W3C TraceContext ترويستي HTTP تحملان حالة التتبع عبر حدود الخدمات:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              ^^ version  ^^ trace-id (128-bit hex)  ^^ span-id  ^^ flags
tracestate:  rojo=00f067aa0ba902b7,congo=t61rcWkgMzE
```

البت الأدنى في بايت `flags` هو علم **العينة (sampled)**. ومع المُعيّن (sampler) القائم على الأب المعتاد، تتبعه الخدمات اللاحقة: حين يكون `1` تسجل امتداداتها أيضًا، وحين يكون `0` لا تسجل. وهذا أساس أخذ العينات من الرأس.

### 2.1 نشر TraceContext عبر Kafka

يتولى التجهيز التلقائي نشر HTTP — ويتولى عامل Java أو مراقبة Spring Kafka أيضًا Kafka. والنسخة الصريحة أدناه لازمة فقط دونهما (وتُظهر ما يفعلانه):

```java
package com.bank.payments.messaging;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.Headers;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;

@Component
public class PaymentEventMessaging {

    private static final TextMapGetter<Headers> KAFKA_GETTER = new TextMapGetter<>() {
        @Override
        public Iterable<String> keys(Headers carrier) {
            return () -> java.util.Arrays.stream(carrier.toArray())
                .map(h -> h.key()).iterator();
        }

        @Override
        public String get(Headers carrier, String key) {
            var header = carrier.lastHeader(key);
            return header == null ? null
                : new String(header.value(), StandardCharsets.UTF_8);
        }
    };

    private static final TextMapSetter<ProducerRecord<?, ?>> KAFKA_SETTER =
        (carrier, key, value) ->
            carrier.headers().add(key, value.getBytes(StandardCharsets.UTF_8));

    private final KafkaTemplate<String, PaymentEvent> kafkaTemplate;

    public PaymentEventMessaging(KafkaTemplate<String, PaymentEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publishPaymentConfirmed(PaymentEvent event) {
        ProducerRecord<String, PaymentEvent> record =
            new ProducerRecord<>("payment.confirmed", event.getPaymentId(), event);

        GlobalOpenTelemetry.getPropagators()
            .getTextMapPropagator()
            .inject(Context.current(), record, KAFKA_SETTER);

        kafkaTemplate.send(record);
    }

    @KafkaListener(topics = "payment.confirmed", groupId = "notification-service")
    public void onPaymentConfirmed(ConsumerRecord<String, PaymentEvent> record) {
        Context extractedContext = GlobalOpenTelemetry.getPropagators()
            .getTextMapPropagator()
            .extract(Context.current(), record.headers(), KAFKA_GETTER);

        Span span = GlobalOpenTelemetry.getTracer("notification-service")
            .spanBuilder("processPaymentConfirmed")
            .setParent(extractedContext)
            .setSpanKind(SpanKind.CONSUMER)
            .startSpan();

        try (var scope = span.makeCurrent()) {
            span.setAttribute("messaging.system", "kafka");
            span.setAttribute("messaging.destination.name", record.topic());
            span.setAttribute("messaging.kafka.partition", record.partition());
            span.setAttribute("payment.id", record.value().getPaymentId());
            // process notification...
        } finally {
            span.end();
        }
    }
}
```

---

## 3. استراتيجيات أخذ العينات

أخذ العينات أهم قرار معماري في التتبع الموزع. فالأنظمة المالية تعالج آلاف المدفوعات في الثانية؛ وتخزين كل تتبع مكلف بشكل مانع. والهدف: التقاط كل التتبعات الشاذة (الأخطاء، والقيم البطيئة المتطرفة) مع التخلص من التتبعات الناجحة الروتينية.

### 3.1 أخذ العينات من الرأس

يُتخذ قرار أخذ العينة عند **الامتداد الجذري** قبل أي عمل لاحق — في SDK الخدمة الأولى. وترث كل الامتدادات الفرعية القرار عبر علم `sampled` في `traceparent`.

**المزايا:** الطلبات غير المأخوذة لا تنتج بيانات امتدادات في أي مكان — الخيار الأرخص. وسهل الفهم.
**العيوب:** لا يمكن أخذ عينة بأثر رجعي من تتبعات تبين أنها مهمة لأن القرار اتُخذ مسبقًا قبل معرفة النتيجة.

```yaml
# Head-based sampling is configured in the SDK (env vars or properties):
#   OTEL_TRACES_SAMPLER=parentbased_traceidratio
#   OTEL_TRACES_SAMPLER_ARG=0.05            # root spans: keep 5%
#
# A probabilistic sampler in the COLLECTOR is a different thing: spans are
# still created and sent, and the collector keeps 5% (consistently per
# trace ID, so a trace is kept or dropped as a whole)
processors:
  probabilistic_sampler:
    sampling_percentage: 5

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [probabilistic_sampler, batch]
      exporters: [otlp/jaeger]   # Jaeger accepts OTLP (the old "jaeger" exporter was removed)
```

### 3.2 أخذ العينات من الذيل

يؤجَّل قرار أخذ العينة حتى **تصل كل امتدادات التتبع** إلى مُجمّع. وهذا يتيح أخذ العينات بناءً على نتيجة التتبع الكاملة: احتفظ بـ 100% من تتبعات الأخطاء والتتبعات البطيئة بغض النظر عن النسبة الإجمالية. ويجب أن تصل كل امتدادات التتبع إلى نسخة المُجمّع نفسها — ومع عدة نسخ، وجّه حسب معرّف التتبع أولًا (مصدّر loadbalancing). وتأخذ الـ SDKs حينها عينات بنسبة 100% (أو نسبة عالية)، فيتدفق الحجم الكامل إلى المُجمّعات.

```yaml
# OTel Collector — tail-based sampling
processors:
  tail_sampling:
    decision_wait: 10s          # wait up to 10s for all spans to arrive
    num_traces: 100000          # in-memory trace buffer
    expected_new_traces_per_sec: 10000
    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}

      - name: slow-payment-traces
        type: latency
        latency: {threshold_ms: 1000}

      - name: fraud-service-errors
        type: and
        and:
          and_sub_policy:
            - name: service-name-filter
              type: string_attribute
              string_attribute:
                key: service.name
                values: [fraud-check-service]
            - name: error-filter
              type: status_code
              status_code: {status_codes: [ERROR]}

      - name: default-policy
        type: probabilistic
        probabilistic: {sampling_percentage: 1}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, batch]
      exporters: [otlp/jaeger]
```

### 3.3 مصفوفة قرار أخذ العينات للخدمات المالية

| نتيجة التتبع | الحجم | نسبة العينة الموصى بها |
|---------------|--------|--------------------------|
| أي خطأ (4xx/5xx) | منخفض | 100% — احتفظ دائمًا |
| المدة > عتبة P95 | منخفض | 100% — احتفظ دائمًا |
| دفعة عالية القيمة (حوالة، دولية) | متوسط | 100% — احتفظ دائمًا |
| معاملة معلَّمة بالاحتيال | منخفض | 100% — احتفظ دائمًا |
| نجاح دفعة تجزئة عادية | مرتفع | 1-5% |
| فحص صحة / ping داخلي | مرتفع جدًا | 0% — تخلص منه كليًا |

---

## 4. نشر Jaeger والاستعلام منه

### 4.1 بنية Jaeger الإنتاجية

بلغ Jaeger v1 نهاية عمره في نهاية 2025؛ وJaeger v2 مبني على OpenTelemetry Collector ‏(`jaegertracing/jaeger:2.x`، ويُضبط بملف YAML بأسلوب المُجمّع). وما زال ملف compose أدناه للإصدار v1 يُظهر الأجزاء المتحركة — ولإعداد جديد، استخدم v2 (أو Grafana Tempo).

```yaml
# docker-compose for local development (Jaeger v1 layout)
services:
  jaeger:
    image: jaegertracing/all-in-one:1.57
    ports:
      - "16686:16686"   # Jaeger UI
      - "4317:4317"     # OTLP gRPC
      - "4318:4318"     # OTLP HTTP
    environment:
      SPAN_STORAGE_TYPE: elasticsearch
      ES_SERVER_URLS: http://elasticsearch:9200
      ES_INDEX_PREFIX: jaeger
      COLLECTOR_OTLP_ENABLED: "true"

  elasticsearch:
    image: elasticsearch:8.13.0
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"
      ES_JAVA_OPTS: "-Xms2g -Xmx2g"
    volumes:
      - es-data:/usr/share/elasticsearch/data

volumes:
  es-data:
```

للإنتاج، انشر Jaeger Collector وJaeger Query كخدمتين منفصلتين خلف موازن حمل، مع Elasticsearch كواجهة خلفية موزعة. واستخدم إدارة دورة حياة الفهارس (ILM) لتدوير التتبعات بعد 30 يومًا.

### 4.2 الاستعلام عن التتبعات عبر واجهة HTTP في Jaeger

‏(`/api/traces` هي واجهة JSON الداخلية التي تستخدمها واجهة Jaeger — مريحة للأدوات لكنها ليست عقدًا مستقرًا؛ ويقدم Jaeger v2 أيضًا الواجهة الموثقة `/api/v3`.)

```java
package com.bank.payments.ops;

import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

/**
 * Programmatic access to Jaeger for incident investigation tooling.
 */
public class JaegerQueryClient {

    private final RestTemplate restTemplate;
    private final String jaegerQueryUrl;

    public JaegerQueryClient(RestTemplate restTemplate, String jaegerQueryUrl) {
        this.restTemplate = restTemplate;
        this.jaegerQueryUrl = jaegerQueryUrl;
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> findPaymentErrorTraces() {
        Instant now = Instant.now();
        Instant oneHourAgo = now.minus(1, ChronoUnit.HOURS);

        String url = UriComponentsBuilder
            .fromHttpUrl(jaegerQueryUrl + "/api/traces")
            .queryParam("service", "payment-service")
            .queryParam("tags", "{\"error\":\"true\"}")
            .queryParam("start", oneHourAgo.toEpochMilli() * 1000)
            .queryParam("end", now.toEpochMilli() * 1000)
            .queryParam("limit", 100)
            .toUriString();

        Map<String, Object> response = restTemplate.getForObject(url, Map.class);
        return (List<Map<String, Object>>) response.get("data");
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> findSlowPaymentTraces(long minDurationMs) {
        Instant now = Instant.now();
        Instant oneHourAgo = now.minus(1, ChronoUnit.HOURS);

        String url = UriComponentsBuilder
            .fromHttpUrl(jaegerQueryUrl + "/api/traces")
            .queryParam("service", "payment-service")
            .queryParam("operation", "processPayment")
            .queryParam("minDuration", minDurationMs + "ms")
            .queryParam("start", oneHourAgo.toEpochMilli() * 1000)
            .queryParam("end", now.toEpochMilli() * 1000)
            .queryParam("limit", 50)
            .toUriString();

        Map<String, Object> response = restTemplate.getForObject(url, Map.class);
        return (List<Map<String, Object>>) response.get("data");
    }
}
```

---

## 5. ‏Zipkin مقابل Jaeger — مقارنة تشغيلية

| البُعد | Jaeger | Zipkin |
|-----------|--------|--------|
| صيغة النقل | OTLP (أصلي)، وThrift (قديم) | ترويسات B3، وJSON |
| تخزين الواجهة الخلفية | Cassandra، وElasticsearch، وBadger | Cassandra، وElasticsearch، وMySQL |
| الواجهة | أغنى، مقارنة التتبعات، عرض DAG | أبسط، ومجربة في الإنتاج |
| تعقيد النشر | متوسط (مجمّع/استعلام منفصلان) | منخفض (ملف jar واحد) |
| أصلي في OTel | نعم | عبر جسر OTLP |
| التوصية | **النشرات الجديدة** | الفرق القديمة أو المعتمدة على Zipkin فقط |

إذا كانت لديك بنية Zipkin قائمة، يستطيع OTel Collector استقبال OTLP والتصدير بصيغة Zipkin، فيتيح لك ترحيل التجهيز دون تغيير الواجهة الخلفية فورًا.

---

## 6. تحليل التتبعات للتحقيق في زمن الدفع

### 6.1 تحديد الامتداد البطيء في المخطط الشلالي

*سيناريو توضيحي:* خدمة دفع بـ P99 = ‏1.8 ثانية يرتفع فجأة إلى 4.2 ثانية. باستخدام مقارنة التتبعات في Jaeger:

1. اسحب تتبعًا "عاديًا" (1.4 ثانية) والتتبع البطيء (4.2 ثانية) جنبًا إلى جنب.
2. في المخطط الشلالي، وسّع مدة كل امتداد. يُظهر التتبع البطيء `fraudCheck` يستغرق 2.9 ثانية بدل 180ms المتوقعة.
3. للامتداد `fraudCheck` السمة `fraud.model_version: v3.3` بينما يُظهر التتبع العادي `v3.2`. فقد نشر تحديث نموذج نموذج تعلم آلي أثقل دون تغيير المهلة.

**نصيحة إنتاجية:** اضبط دائمًا سمات الامتدادات لأرقام الإصدارات، ومفاتيح الميزات، والإعدادات التي قد تؤثر على الأداء. فهذا يحوّل تحقيقًا من 30 دقيقة إلى 3 دقائق.

### 6.2 اكتشاف مشكلات استعلامات N+1 عبر التتبعات

```java
/**
 * N+1 anti-pattern — this generates one SELECT per account in the list.
 * Visible in traces as 50-200 sequential database spans.
 */
public List<AccountSummary> getAccountSummariesBad(List<String> accountIds) {
    return accountIds.stream()
        .map(id -> accountRepository.findById(id))  // N separate SQL queries
        .filter(Optional::isPresent)
        .map(opt -> AccountSummary.from(opt.get()))
        .collect(Collectors.toList());
}

/**
 * Fixed: single IN query. In traces, one database span replaces N spans.
 */
public List<AccountSummary> getAccountSummaries(List<String> accountIds) {
    return accountRepository.findAllById(accountIds).stream()  // 1 query
        .map(AccountSummary::from)
        .collect(Collectors.toList());
}
```

في Jaeger، نمط N+1 لا يخطئه أحد: يُظهر المخطط الشلالي للتتبع 50-200 امتداد `db.query` صغير متتابع. وتُظهر النسخة المُصلحة امتداد `db.query` واحدًا.

### 6.3 رسوم اعتماديات الخدمات

يعرض تبويب "System Architecture" في Jaeger رسم اعتماديات حيًا مشتقًا من بيانات التتبع الفعلية. ولأنظمة الدفع، يكشف الرسم:

- أي الخدمات مقترنة تزامنيًا (المسار الحرج)
- أي الخدمات اللاحقة تلمسها الدفعة (نطاق الضرر عند الانقطاعات)
- استدعاءات غير متوقعة (خدمة دفع تستدعي واجهة إدارية داخلية لا يجب أن تصل إليها)

---

## 7. التجهيز التلقائي في Spring Boot

يجهّز عامل OpenTelemetry لـ Java ‏(`opentelemetry-javaagent.jar`) على مستوى الشيفرة الثنائية دون تغييرات في الشيفرة:

```bash
# Dockerfile — attach OTel Java agent
FROM eclipse-temurin:21-jre

COPY opentelemetry-javaagent-2.5.0.jar /app/otel-agent.jar
COPY payment-service.jar /app/app.jar

ENV OTEL_SERVICE_NAME=payment-service
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
ENV OTEL_EXPORTER_OTLP_PROTOCOL=grpc
ENV OTEL_RESOURCE_ATTRIBUTES=service.namespace=banking,deployment.environment=production

ENTRYPOINT ["java", \
  "-javaagent:/app/otel-agent.jar", \
  "-jar", "/app/app.jar"]
```

يجهّز العامل تلقائيًا: Spring MVC/WebFlux، وSpring Data JPA/JDBC، وSpring Kafka، وOkHttp/Apache HttpClient/WebClient، ودعامات gRPC، وRedis ‏(Lettuce، وJedis).

**ما يحتاج تجهيزًا يدويًا:** امتدادات مجال العمل (تقييم الاحتيال، وتصنيف المخاطر، والترحيل في الدفتر) وأي منطق توجيه مخصص في Kafka.

---

## 8. ربط معرّفات الترابط

يتطلب ربط التتبعات بالسجلات تضمين `traceId` و`spanId` في كل سطر سجل:

```xml
<!-- logback-spring.xml -->
<configuration>
  <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
    <!-- LogstashEncoder writes every MDC entry as a JSON field by default,
         so trace_id / span_id / trace_flags appear without extra config -->
    <encoder class="net.logstash.logback.encoder.LogstashEncoder"/>
  </appender>
  <root level="INFO">
    <appender-ref ref="JSON"/>
  </root>
</configuration>
```

يملأ OTel Spring Boot starter تلقائيًا مفاتيح MDC ‏`trace_id`، و`span_id`، و`trace_flags` في كل عبارة سجل داخل امتداد نشط. وهذا يتيح لاستعلام Loki الانتقال مباشرة إلى تتبع Jaeger المطابق:

```
# Loki query: find logs for a specific trace
{service="payment-service"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"
```

---

## 9. تنقية سمات الامتدادات وفق PCI DSS

**لا** تُدرج ما يلي كسمات امتدادات:

- أرقام البطاقات (PAN) — ولو مقنّعة
- قيم CVV
- أرقام الحسابات الكاملة
- رمز PIN أو كلمات المرور
- الأسماء الكاملة مقرونة بمعرّفات الحسابات

استخدم معرّفات معتمة (معرّفات دفع UUID، ومراجع حسابات مقنّعة) في التتبعات. وأضف معالج تنقية في OTel Collector كشبكة أمان أخيرة:

```yaml
processors:
  redaction:
    allow_all_keys: true
    blocked_values:
      - "4[0-9]{12}(?:[0-9]{3})?"    # Visa card pattern
      - "[0-9]{3}-[0-9]{2}-[0-9]{4}" # SSN pattern
    summary: debug
```

---

## 10. تحجيم المُجمّع للأحمال المالية

لنظام يعالج 10,000 دفعة في الثانية بأخذ عينات 5% (500 تتبع/ثانية، ونحو 20 امتدادًا لكل تتبع = 10,000 امتداد/ثانية):

- ‏OTel Collector: ‏2 معالج / 4 GB ذاكرة لكل نسخة، 3 نسخ على الأقل
- ‏Elasticsearch: ‏32 GB ذاكرة، و1 TB SSD لكل عقدة، وعنقود من 3 عقد
- الاحتفاظ: 7 أيام ساخنة (SSD)، و30 يومًا دافئة (HDD)، والحذف بعد 90 يومًا

اضبط BatchSpanProcessor كي لا يحجب عدم توفر المُجمّع تطبيقك:

```yaml
otel:
  bsp:
    schedule_delay: 5000ms
    max_queue_size: 2048
    max_export_batch_size: 512
    export_timeout: 30000ms
```

---

## 11. الملخص

يتطلب التتبع الموزع على مستوى المهندس الرئيسي ثلاث كفاءات متمايزة:

1. **تصميم التجهيز** — أي الامتدادات تضيف قيمة تشخيصية مقابل الضجيج. جهّز كل الاستدعاءات المتزامنة بين الخدمات تلقائيًا، وكل تدفقات Kafka صراحة، وكل نقاط القرار الحرجة للعمل يدويًا.

2. **استراتيجية أخذ العينات** — أخذ العينات من الذيل هو الافتراضي الصحيح للأنظمة المالية لأنه يضمن الاحتفاظ بتتبعات الأخطاء والقيم المتطرفة في الزمن. والتكلفة نافذة قرار 10-15 ثانية وبنية مجمّعات ذات حالة.

3. **سير عمل التحليل** — يأتي العائد من التتبع من التحليل. فابنِ دليل تشغيل يخبر مهندسي المناوبة: "ارتفاع زمن P99 ← افتح Jaeger ← رشّح `payment-service` بمدة > ثانية ← قارن الامتداد البطيء بتتبع أساس عند P50".

والفرق بين الفرق التي تستفيد من التتبع والتي لا تستفيد يكاد يكون دائمًا النقطة الثالثة: فدون سير عمل تحليل مدمج في أدلة التشغيل، تتراكم التتبعات دون أن يستخدمها أحد منهجيًا.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "أي استراتيجية لأخذ العينات في OpenTelemetry هي الأنسب لخدمة دفع تعالج 50,000 معاملة في الثانية حيث يجب التقاط كل تتبع خطأ؟",
      "options": ["أخذ العينات من الرأس بنسبة 1%", "أخذ العينات من الذيل بقاعدة الاحتفاظ الدائم بالأخطاء", "بلا أخذ عينات — التقاط كل التتبعات", "أخذ عينات عشوائي بنسبة 10%"],
      "correct": 1,
      "explanation": "يتخذ أخذ العينات من الذيل قرار العينة بعد اكتمال التتبع، فيتيح فرض قواعد مثل 'خذ دائمًا التتبعات التي تحتوي أخطاء' بغض النظر عن الحجم. أما أخذ العينات من الرأس بنسبة ثابتة فسيفوّت كثيرًا من تتبعات الأخطاء."
    },
    {
      "text": "ما الغرض الأساسي من صيغة ترويسة نشر W3C TraceContext في التتبع الموزع؟",
      "options": ["تشفير بيانات التتبع بين الخدمات", "حمل معرّفي التتبع والامتداد عبر حدود الخدمات لربط الامتدادات في تتبع واحد", "تعريف نسب أخذ العينات عبر الخدمات", "تخزين سمات الامتدادات في ترويسات HTTP"],
      "correct": 1,
      "explanation": "تحمل W3C TraceContext ‏(ترويسة `traceparent`) معرّف التتبع ومعرّف الامتداد الأب عبر حدود الخدمات، فتتيح ربط كل الامتدادات من الخدمات المختلفة التي خدمت طلبًا واحدًا في تتبع موزع واحد."
    },
    {
      "text": "لماذا يجب ألا تُدرج أرقام البطاقات (PAN) أبدًا كسمات امتدادات في OpenTelemetry ولو بشكل مقنّع؟",
      "options": ["تزيد سمات الامتدادات تكاليف تخزين التتبعات بشكل كبير", "واجهات التتبع الخلفية ليست ضمن نطاق PCI DSS وقد تُصدَّر بيانات الامتدادات إلى تخزين غير ممتثل", "لا تستطيع سمات الامتدادات حمل قيم نصية", "لا يدعم Jaeger أنواع بيانات PCI"],
      "correct": 1,
      "explanation": "يتطلب PCI DSS تحكمًا صارمًا في أماكن تخزين بيانات حاملي البطاقات ونقلها. وواجهات التتبع الخلفية (Jaeger، وZipkin، وTempo) ليست أنظمة ضمن نطاق PCI. وإدراج بيانات PAN في الامتدادات يُدخل بنية التتبع كاملة في نطاق PCI، فيزيد عبء الامتثال بشكل كبير."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "التتبع الموزع للتحقيق في زمن الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "جهّز خدمة دفع Spring Boot بـ OpenTelemetry، مضيفًا امتدادات عمل مخصصة لخطوات فحص الاحتيال، والترحيل في الدفتر، والإشعار، مع سمات لنوع الدفعة، والعملة، وفئة المبلغ (لا المبلغ الفعلي)."},
    {"id": "2", "description": "اضبط أخذ العينات من الذيل في OTel Collector بحيث يلتقط دائمًا تتبعات الأخطاء، ويلتقط دائمًا التتبعات التي تتجاوز ثانيتين، ويأخذ عينة 1% من التتبعات الناجحة السريعة."},
    {"id": "3", "description": "انشر نسخة Jaeger محلية وتحقق من ظهور التتبعات بتسلسل الامتدادات الأب-الابن الصحيح؛ واستخدم واجهة HTTP في Jaeger لجلب أبطأ 10 تتبعات من الساعة الماضية برمجيًا."},
    {"id": "4", "description": "اضبط Logback لحقن trace_id وspan_id في كل سطر سجل، ثم اكتب استعلام LogQL في Grafana ينتقل من معرّف تتبع Jaeger إلى كل أسطر السجلات المرتبطة عبر payment-service وfraud-service."}
  ]
}
-->
