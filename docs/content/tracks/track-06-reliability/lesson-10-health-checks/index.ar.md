---
id: track-06-lesson-10
title: "فحوصات السلامة — Liveness وReadiness وStartup"
slug: health-checks
track: track-06
trackName: "الإتاحة العالية والموثوقية والمرونة"
sequence: 10
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [health-check, liveness, readiness, startup-probe, Actuator]
prerequisites: []
---

# فحوص الصحة — فحوص الحيوية والجاهزية وبدء التشغيل

> [!NOTE]
> الفرق بين الحيوية (liveness) والجاهزية (readiness) هو الفرق بين "يجب قتل هذه العملية وإعادة تشغيلها" و"يجب إزالة هذه العملية مؤقتًا من موازن الحمل". والخلط بينهما يسبب إعادات تشغيل غير ضرورية للنسخ أثناء تحولات قاعدة البيانات وقفزات الحركة.

## 1. دلالات فحوص Kubernetes

| الفحص | إجراء Kubernetes عند الفشل | المعنى |
|---|---|---|
| الحيوية (Liveness) | قتل النسخة وإعادة تشغيلها | "هذه النسخة في جمود أو تالفة — استبدلها" |
| الجاهزية (Readiness) | الإزالة من الـ Service (إيقاف الحركة) | "هذه النسخة سليمة لكنها ليست جاهزة للحركة الآن" |
| بدء التشغيل (Startup) | قتل النسخة إذا تجاوز بدء التشغيل الحد | "هذه النسخة تستغرق وقتًا طويلًا جدًا للبدء" |

التمييز الحرج:
- **فشل الحيوية** = "العملية نفسها معطوبة". فيقتلها Kubernetes.
- **فشل الجاهزية** = "غير قادرة مؤقتًا على خدمة الحركة". فيوجّه Kubernetes الحركة حولها. وتبقى النسخة عاملة.

لخدمات الدفع:
- فشل اتصال قاعدة البيانات ← **فشل جاهزية** (أزلها من موازن الحمل؛ النسخة سليمة)
- جمود الخيوط / تعطل JVM ← **فشل حيوية** (اقتل وأعد التشغيل)
- التطبيق ما زال يُهيأ ← **بدء التشغيل** (ينتظر Kubernetes قبل فحص الفحوص الأخرى)

> [!WARNING]
> احذر من الاعتماديات **المشتركة** في الجاهزية. فإذا تعطلت قاعدة البيانات (أو بوابة طرف ثالث)، تفشل جاهزية *كل* النسخ في اللحظة نفسها، فيزيلها Kubernetes كلها من الـ Service، ويتلقى العملاء أخطاء اتصال بدل رد `503` واضح أو إجابة متدهورة (مثلًا "الدفعة مصفوفة كـ PENDING"). فلا تضع اعتمادية في الجاهزية إلا عندما لا تستطيع النسخة فعلًا خدمة أي شيء دونها؛ واعرض البقية في مجموعة صحة منفصلة للوحات والتنبيهات.

## 2. إعداد الصحة في Spring Boot Actuator

```yaml
management:
  endpoint:
    health:
      show-details: when-authorized     # never "always" on a payment service
      probes:
        enabled: true      # Enables /actuator/health/liveness and /actuator/health/readiness
      # Custom DEGRADED status: where it ranks, and that it still returns HTTP 200
      status:
        order: DOWN, OUT_OF_SERVICE, DEGRADED, UP, UNKNOWN
        http-mapping:
          DEGRADED: 200
      # Health GROUPS live under management.endpoint.health.group
      group:
        liveness:
          include: livenessState
          # Only the liveness state — not DB, not Kafka
          # DB being down should NOT restart the pod
        readiness:
          include: readinessState,paymentsDb
          # Only what a pod truly cannot serve without
        dependencies:
          include: paymentsDb,kafka,redisRoundTrip,paymentGateway,circuitBreakerSummary
          # Everything else: visible to ops, does not change routing
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true
```

```java
@SpringBootApplication
public class PaymentServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaymentServiceApplication.class, args);
    }
}

/**
 * Spring Boot manages readiness itself: it reports ACCEPTING_TRAFFIC once the
 * application is ready, and switches to REFUSING_TRAFFIC as soon as graceful
 * shutdown starts. Publish the state yourself only for EXTRA conditions —
 * here, a reference-data cache that must be loaded before taking traffic.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ReferenceDataWarmup {

    private final ApplicationEventPublisher publisher;
    private final ReferenceDataCache cache;

    @EventListener(ApplicationReadyEvent.class)
    public void warmUp() {
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.REFUSING_TRAFFIC);
        cache.loadAll();   // e.g. currency rules, BIC directory
        AvailabilityChangeEvent.publish(publisher, this, ReadinessState.ACCEPTING_TRAFFIC);
        log.info("Payment service is ready to accept traffic");
    }
}
```

## 3. مؤشرات صحة مخصصة

```java
/**
 * Database health indicator.
 * Uses a lightweight query to verify connectivity.
 * Result affects READINESS (not liveness) — DB being down
 * should remove pod from load balancer, not restart it.
 * Bean name "paymentsDb": the names "db" and "redis" are already used by
 * Spring Boot's built-in indicators — reusing them causes a name clash.
 */
@Component("paymentsDb")
@RequiredArgsConstructor
public class DatabaseHealthIndicator implements HealthIndicator {

    private final JdbcTemplate jdbcTemplate;

    private static final Duration HEALTH_CHECK_TIMEOUT = Duration.ofSeconds(2);

    @Override
    public Health health() {
        try {
            // Use a minimal query to verify connectivity
            // Avoid SELECT 1 — it doesn't test schema access
            Integer result = jdbcTemplate.queryForObject(
                "SELECT COUNT(1) FROM payments WHERE 1=0",
                Integer.class);

            return Health.up()
                .withDetail("database", "PostgreSQL")
                .withDetail("query", "schema accessible")
                .build();

        } catch (DataAccessException e) {
            log.error("Database health check failed", e);
            return Health.down()
                .withException(e)
                .withDetail("database", "PostgreSQL")
                .withDetail("error", e.getMessage())
                .build();
        }
    }
}

/**
 * Kafka health indicator with consumer lag check.
 * Not just "can we connect to Kafka" but also "are consumers keeping up".
 */
@Component("kafka")
@RequiredArgsConstructor
public class KafkaHealthIndicator implements HealthIndicator {

    // One AdminClient, created once (e.g. from KafkaAdmin's configuration)
    private final AdminClient adminClient;
    private final KafkaConsumerLagMonitor lagMonitor;

    private static final long MAX_ACCEPTABLE_LAG = 1000;

    @Override
    public Health health() {
        try {
            // 1. Verify broker connectivity
            Map<String, Object> brokerDetails = verifyBrokerConnectivity();

            // 2. Check consumer lag
            Map<String, Long> consumerLags = lagMonitor.getCurrentLags();
            boolean lagExcessive = consumerLags.values().stream()
                .anyMatch(lag -> lag > MAX_ACCEPTABLE_LAG);

            // Consumer lag says nothing about serving HTTP: report it in the
            // dependencies group, never use it to pull a pod out of rotation
            if (lagExcessive) {
                return Health.status("DEGRADED")
                    .withDetails(brokerDetails)
                    .withDetail("consumerLags", consumerLags)
                    .withDetail("maxAcceptableLag", MAX_ACCEPTABLE_LAG)
                    .build();
            }

            return Health.up()
                .withDetails(brokerDetails)
                .withDetail("consumerLags", consumerLags)
                .build();

        } catch (Exception e) {
            return Health.down()
                .withException(e)
                .withDetail("error", "Cannot connect to Kafka brokers")
                .build();
        }
    }

    private Map<String, Object> verifyBrokerConnectivity() {
        DescribeClusterResult cluster = adminClient.describeCluster();
        try {
            Collection<Node> nodes = cluster.nodes().get(2, TimeUnit.SECONDS);
            return Map.of(
                "brokers", nodes.size(),
                "controller", cluster.controller().get(2, TimeUnit.SECONDS).idString()
            );
        } catch (Exception e) {
            throw new RuntimeException("Kafka connectivity check failed", e);
        }
    }
}

/**
 * Redis health indicator.
 * Tests read and write to verify Redis is functional.
 */
@Component("redisRoundTrip")
@RequiredArgsConstructor
public class RedisHealthIndicator implements HealthIndicator {

    private final StringRedisTemplate redisTemplate;
    // One key PER POD: with a shared key, another pod's write could land
    // between our set and get and look like a mismatch
    private static final String HEALTH_CHECK_KEY =
        "health:check:" + System.getenv().getOrDefault("HOSTNAME", "local");

    @Override
    public Health health() {
        try {
            String testValue = UUID.randomUUID().toString();
            redisTemplate.opsForValue().set(HEALTH_CHECK_KEY, testValue,
                Duration.ofSeconds(10));
            String readBack = redisTemplate.opsForValue().get(HEALTH_CHECK_KEY);

            if (!testValue.equals(readBack)) {
                return Health.down()
                    .withDetail("error", "Redis write-read mismatch")
                    .build();
            }

            // execute() borrows AND releases the connection.
            // (getConnectionFactory().getConnection().ping() leaks a connection.)
            String pong = redisTemplate.execute((RedisCallback<String>) RedisConnection::ping);
            return Health.up()
                .withDetail("pingResponse", pong)
                .build();

        } catch (Exception e) {
            return Health.down()
                .withException(e)
                .build();
        }
    }
}

/**
 * External payment gateway health indicator.
 * Tests the gateway's health endpoint with a strict timeout.
 * Informational ("dependencies" group) — a third-party outage must not take
 * every pod out of the load balancer.
 */
@Component("paymentGateway")
@RequiredArgsConstructor
public class PaymentGatewayHealthIndicator implements HealthIndicator {

    private final WebClient gatewayWebClient;

    @Override
    public Health health() {
        try {
            GatewayHealthResponse response = gatewayWebClient.get()
                .uri("/health")
                .retrieve()
                .bodyToMono(GatewayHealthResponse.class)
                .timeout(Duration.ofSeconds(3))
                .block();

            if (response != null && "UP".equals(response.getStatus())) {
                return Health.up()
                    .withDetail("gateway", "reachable")
                    .withDetail("gatewayStatus", response.getStatus())
                    .build();
            }

            return Health.status("DEGRADED")
                .withDetail("gateway", "reachable but degraded")
                .withDetail("gatewayStatus", response != null ? response.getStatus() : "null")
                .build();

        } catch (Exception e) {
            return Health.down()
                .withException(e)
                .withDetail("gateway", "unreachable")
                .build();
        }
    }
}
```

## 4. مجموعات فحص الصحة — العميقة مقابل السطحية

```java
/**
 * Shallow vs Deep health checks:
 *
 * SHALLOW (for liveness):
 *   - Is the JVM running? (JVM is alive if endpoint responds)
 *   - Is the application state valid? (no deadlock, no infinite loop)
 *   - Should NOT include database, Kafka, or external APIs
 *   - Response time: < 100ms
 *
 * DEEP (for readiness — only what this pod cannot serve without):
 *   - Can we reach the database?
 *   - Is our internal state consistent (caches loaded)?
 *   - Response time: < 2s (or health check timeouts fail)
 *
 * DEPENDENCIES (informational group):
 *   - Kafka, Redis, the payment gateway, circuit breaker states
 *   - Visible to ops and alerting; does not change routing
 *
 * Example: During a Kafka broker restart:
 *   - Shallow (liveness): UP — JVM is fine
 *   - Dependencies group: DEGRADED/DOWN — Kafka temporarily unreachable
 *   - Readiness: UP — the pod can still accept payments (events wait in the
 *     outbox until Kafka is back)
 *   → Pod is NOT killed and keeps serving
 */

// No Java bean is needed for groups: they are pure configuration.
// application.yml
/*
management:
  endpoint:
    health:
      group:
        liveness:
          include: livenessState
          show-details: never         # Minimal response — Kubernetes reads this
        readiness:
          include: readinessState,paymentsDb
          show-details: when-authorized
        dependencies:
          include: paymentsDb,kafka,redisRoundTrip,paymentGateway,circuitBreakerSummary
          show-details: when-authorized   # Ops visibility endpoint
*/
```

## 5. إعداد فحوص Kubernetes

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  template:
    spec:
      containers:
        - name: payment-service
          image: payment-service:latest

          # Startup probe: allow up to 5 minutes for JVM warmup
          # (initialDelaySeconds + periodSeconds * failureThreshold = max startup time)
          # Uses the LIVENESS endpoint (Spring Boot has no "startup" group):
          # a database outage at boot must not turn into a restart loop
          startupProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            initialDelaySeconds: 10    # Wait 10s before first check
            periodSeconds: 10          # Check every 10s
            failureThreshold: 30       # Allow up to 30 * 10s = 5 minutes
            successThreshold: 1
            timeoutSeconds: 5

          # Liveness probe: restart if JVM becomes unresponsive
          # Only checked AFTER startup probe succeeds
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            initialDelaySeconds: 0     # Start checking immediately after startup
            periodSeconds: 30          # Check every 30s (not too aggressive)
            failureThreshold: 3        # Allow 3 failures before restart (90s)
            successThreshold: 1
            timeoutSeconds: 5

          # Readiness probe: remove from load balancer if not ready
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            initialDelaySeconds: 0
            periodSeconds: 10          # Check every 10s (faster recovery detection)
            failureThreshold: 3        # Remove after 3 failures (30s)
            successThreshold: 2        # Require 2 successes before returning to service
            timeoutSeconds: 5

          # Graceful shutdown: keep serving while the pod is removed from
          # Service endpoints, then drain in-flight requests
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]  # endpoint removal propagates
      # A POD-level field (spec.template.spec), not a container field:
      # must cover preStop (15s) + Spring's shutdown phase (30s) + margin
      terminationGracePeriodSeconds: 60
```

## 6. تكامل فحص الصحة مع قواطع الدائرة

```java
/**
 * Expose circuit breaker states in health checks.
 * When a circuit breaker is OPEN, the service is degraded.
 * This surfaces to ops teams via the health endpoint — in the "dependencies"
 * group, never in readiness (see lesson 2). Bean name "circuitBreakerSummary":
 * Resilience4j already registers an indicator named "circuitBreakers".
 */
@Component("circuitBreakerSummary")
@RequiredArgsConstructor
public class CircuitBreakerHealthIndicator implements HealthIndicator {

    private final CircuitBreakerRegistry circuitBreakerRegistry;

    @Override
    public Health health() {
        Map<String, String> states = new HashMap<>();
        boolean anyOpen = false;

        for (CircuitBreaker cb : circuitBreakerRegistry.getAllCircuitBreakers()) {
            String state = cb.getState().name();
            states.put(cb.getName(), state);
            if (cb.getState() == CircuitBreaker.State.OPEN) {
                anyOpen = true;
            }
        }

        if (anyOpen) {
            long openCount = states.values().stream()
                .filter("OPEN"::equals).count();
            return Health.status("DEGRADED")
                .withDetail("circuitBreakers", states)
                .withDetail("openCount", openCount)
                .withDetail("message", openCount + " circuit breaker(s) are OPEN")
                .build();
        }

        return Health.up()
            .withDetail("circuitBreakers", states)
            .build();
    }
}
```

## 7. مهل فحص الصحة

```java
/**
 * Health checks must be fast and non-blocking.
 * A slow health check is worse than no health check.
 * If the health check itself is slow, Kubernetes marks the pod unhealthy
 * when the pod is actually fine — causing unnecessary restarts.
 *
 * Rules:
 * - Liveness: < 100ms
 * - Readiness: < 2s (matches Kubernetes timeoutSeconds)
 * - Each individual indicator: < 500ms
 */
@Component
public class TimeoutEnforcingHealthIndicator implements HealthIndicator {

    private final SlowDependencyClient slowClient;
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    @Override
    public Health health() {
        // Enforce 500ms timeout on external health checks
        try {
            Future<Health> future = executor.submit(() -> {
                try {
                    slowClient.ping();
                    return Health.up().build();
                } catch (Exception e) {
                    return Health.down().withException(e).build();
                }
            });
            try {
                return future.get(500, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                future.cancel(true);   // don't leave the probe task running
                throw e;
            }
        } catch (TimeoutException e) {
            log.warn("Health check timed out for slowClient");
            return Health.down()
                .withDetail("error", "Health check timed out after 500ms")
                .build();
        } catch (Exception e) {
            return Health.down().withException(e).build();
        }
    }
}
```

## 8. التكامل مع الإيقاف الرشيق

```java
/**
 * Graceful shutdown coordination.
 * Step 1: Set readiness to REFUSING_TRAFFIC (Kubernetes stops sending new requests)
 * Step 2: Wait for in-flight requests to complete
 * Step 3: Close database connections and Kafka consumers
 * Step 4: JVM exits
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class GracefulShutdownCoordinator {

    private final ApplicationContext context;
    private final KafkaListenerEndpointRegistry kafkaRegistry;
    private static final Duration DRAIN_TIMEOUT = Duration.ofSeconds(30);

    @EventListener(ContextClosedEvent.class)
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public void onShutdown() {
        log.info("Graceful shutdown initiated");

        // 1. Stop Kafka consumers (stop receiving new messages)
        log.info("Stopping Kafka consumers...");
        kafkaRegistry.stop();

        // 2. Wait for in-flight HTTP requests (via Spring's server shutdown)
        // Spring Boot configures this via server.shutdown=graceful
        // and spring.lifecycle.timeout-per-shutdown-phase=30s

        // 3. Close connection pools gracefully
        log.info("Graceful shutdown: waiting {}s for in-flight requests",
            DRAIN_TIMEOUT.toSeconds());
    }
}
```

```yaml
# application.yml — graceful shutdown configuration
server:
  shutdown: graceful

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s  # Wait up to 30s for in-flight requests
```

## 9. مراقبة فحوص الصحة

```yaml
# Prometheus alert rules for health check failures

groups:
  - name: payment-health
    rules:
      # Pod readiness as Kubernetes sees it (kube-state-metrics);
      # Spring Boot does not export a readiness metric by default
      - alert: PaymentServiceReadinessDown
        expr: |
          kube_pod_status_ready{condition="false", pod=~"payment-service-.*"} == 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Payment service pod is refusing traffic"
          description: "Pod {{ $labels.pod }} is refusing traffic for 2+ minutes"

      # health_check_status is a CUSTOM gauge (1 = UP, 0 = DOWN) that you
      # publish from your health indicators — it is not built in
      - alert: DatabaseHealthCheckFailing
        expr: |
          health_check_status{name="paymentsDb"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Payment service cannot reach database"
          runbook: "https://wiki.example.com/runbooks/db-health"

      - alert: AllPaymentPodsUnreachable
        # "up" = Prometheus could scrape the target (not the health status)
        expr: |
          sum(up{job="payment-service"}) == 0
        for: 30s
        labels:
          severity: critical
          page: "true"
        annotations:
          summary: "No payment service pod can be scraped — service is likely down"
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تصبح قاعدة بيانات نسخة خدمة دفع غير متاحة مؤقتًا. أي فحص Kubernetes يجب أن يفشل، وما الإجراء الذي سيتخذه Kubernetes؟",
      "options": ["يفشل فحص الحيوية — يقتل Kubernetes النسخة ويعيد تشغيلها", "يفشل فحص الجاهزية — يزيل Kubernetes النسخة من موازن الحمل دون إعادة تشغيلها", "يفشل فحص بدء التشغيل — يمنع Kubernetes النسخة من البدء", "يفشل فحصا الحيوية والجاهزية — يقتل Kubernetes النسخة"],
      "correct": 1,
      "explanation": "عدم توفر قاعدة البيانات يعني أن النسخة لا تستطيع خدمة الحركة لكنها سليمة فيما عدا ذلك. فإذا كانت قاعدة البيانات في فحص الجاهزية، يفشل ويزيل Kubernetes النسخة من الـ Service (يوقف توجيه الحركة)، لكنه لا يعيد تشغيلها؛ وتتعافى النسخة تلقائيًا عند عودة قاعدة البيانات. وتحذير واحد: الاعتمادية المشتركة تُفشل جاهزية كل النسخ في آن واحد، فلا تضمّنها إلا إذا كانت النسخة لا تستطيع فعلًا خدمة أي شيء دونها."
    },
    {
      "text": "لماذا يجب ألا تُضمّن الاعتماديات الخارجية (قاعدة البيانات، وKafka) في فحص الحيوية؟",
      "options": ["لأنها أبطأ من أن تُستعلم", "لأن تضمينها يسبب إعادات تشغيل غير ضرورية للنسخ عندما تكون الاعتماديات غير متاحة مؤقتًا", "لأن Kubernetes لا يستطيع الاتصال بالخدمات الخارجية", "لأن فحوص الحيوية تدعم فحوص مقبس TCP فقط"],
      "correct": 1,
      "explanation": "إذا كان الاتصال بقاعدة البيانات أو Kafka في فحص الحيوية، فإن كل انقطاع مؤقت لاعتمادية يطلق إعادة تشغيل للنسخة — ما لا يصلح المشكلة ويسبب اضطرابًا غير ضروري. وهذه الفحوص مكانها فحوص الجاهزية (عند الحاجة فعلًا) أو مجموعة اعتماديات للعرض فقط."
    },
    {
      "text": "ما الغرض من خطاف دورة الحياة preStop مع sleep في مواصفة نسخة Kubernetes؟",
      "options": ["تشغيل ترحيلات قاعدة البيانات قبل الإيقاف", "السماح لفشل فحص الجاهزية بالانتشار إلى موازن الحمل قبل أن تتوقف النسخة عن تلقي الحركة", "نسخ الحالة في الذاكرة احتياطيًا إلى القرص", "دفع دفعات منتج Kafka"],
      "correct": 1,
      "explanation": "عند حذف نسخة، يعلّمها Kubernetes كـ Terminating، ويبدأ إزالتها من نقاط الـ Service، ويشغّل خطاف preStop؛ ولا تتلقى الحاوية SIGTERM إلا بعد انتهاء preStop. ويُبقي الـ sleep التطبيق يخدم بينما تنتشر إزالة النقطة عبر kube-proxy وموازنات الحمل، فلا يُرسل أي طلب جديد إلى نسخة بدأت الإيقاف بالفعل — ما يمنع أخطاء 'connection refused'."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "نظام فحوص صحة شامل لبنية الدفع",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ أربعة مؤشرات صحة لـ: قاعدة البيانات (استعلام إمكانية الوصول للمخطط)، وKafka (اتصال الوسيط + عتبة تأخر المستهلك 1000)، وRedis (اختبار كتابة-قراءة بمفتاح لكل نسخة)، وبوابة الدفع (ping عبر HTTP بمهلة 3 ثوانٍ). واستخدم أسماء مكونات لا تتعارض مع المؤشرات المدمجة في Spring Boot. وضع قاعدة البيانات فقط في الجاهزية؛ والبقية في مجموعة 'dependencies' — ولا شيء منها في الحيوية."},
    {"id": "2", "description": "اضبط مجموعات الصحة في Spring Boot Actuator تحت management.endpoint.health.group: الحيوية (livenessState فقط)، والجاهزية (readinessState + قاعدة البيانات)، والاعتماديات (كل المؤشرات مع التفاصيل للمستخدمين المخوّلين). واكتب YAML لفحوص Kubernetes: بدء التشغيل (ميزانية 5 دقائق، على نقطة الحيوية)، والحيوية (فترة 30 ثانية، 3 إخفاقات)، والجاهزية (فترة 10 ثوانٍ، نجاحان للاستعادة)، مع terminationGracePeriodSeconds على مستوى النسخة."},
    {"id": "3", "description": "ابنِ CircuitBreakerHealthIndicator يعيد DEGRADED (لا DOWN) عندما تكون أي دائرة مفتوحة، مع سرد كل أسماء قواطع الدائرة وحالاتها. واضبط ترتيب حالة DEGRADED وربطها بـ HTTP 200، وضع المؤشر في مجموعة الاعتماديات — واشرح لماذا يجب ألا يساهم في الجاهزية ولا في الحيوية."},
    {"id": "4", "description": "نفّذ الإيقاف الرشيق: عند ContextClosedEvent أوقف مستهلكي Kafka أولًا، ثم اضبط الجاهزية على REFUSING_TRAFFIC. واضبط server.shutdown=graceful مع timeout-per-shutdown-phase ‏30 ثانية وsleep في preStop مدته 15 ثانية في مواصفة النسخة."}
  ]
}
-->
