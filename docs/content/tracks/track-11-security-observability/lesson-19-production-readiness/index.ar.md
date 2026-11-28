---
id: track-11-lesson-19
title: "قائمة الجاهزية لبيئة الإنتاج — إطلاق الخدمات المالية"
slug: production-readiness
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 19
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [production-readiness, PRR, launch-checklist, runbook, DR-test]
prerequisites: [track-11-lesson-18]
---

# قائمة تحقق الجاهزية للإنتاج — إطلاق الخدمات المالية

> [!NOTE]
> مراجعة الجاهزية للإنتاج (PRR) ليست بوابة بيروقراطية — بل بوابة جودة هندسية تسأل: "هل فكرنا في كل أبعاد تشغيل هذه الخدمة في الإنتاج؟" وفي الخدمات المالية، كلفة الإطلاق دون جاهزية كارثية: فقدان بيانات، وخرق تنظيمي، وضرر للعملاء. وقائمة التحقق تأمين رخيص.

## لماذا تحتاج الخدمات المالية مراجعة جاهزية رسمية

تغطي ممارسات PRR القياسية من Google SRE ومؤسسات هندسية أخرى قابلية المراقبة والاعتمادية. وتضيف الخدمات المالية ثلاثة أبعاد غير قابلة للتفاوض:

**الامتثال**: يجب أن تفي الخدمة بالمتطلبات التنظيمية (PCI DSS، وGDPR، وDORA، وقواعد FCA، وغيرها) قبل أن تتعامل مع بيانات عملاء أو أموال حقيقية.

**سجل التدقيق**: يجب تسجيل كل معاملة وحدث مصادقة وتغيير إعداد في نظام تدقيق يُظهر أي عبث.

**التزامات الإبلاغ عن الحوادث**: إن تعرضت الخدمة لانقطاع أو اختراق، فهناك متطلبات إبلاغ تنظيمية بمواعيد نهائية صارمة — مثل تقرير DORA الأولي خلال 4 ساعات من تصنيف الحادث كحادث كبير (وفي موعد لا يتجاوز 24 ساعة من العلم به)، أو إشعار خرق البيانات الشخصية بموجب GDPR خلال 72 ساعة.

---

## عملية مراجعة الجاهزية

```
PRR Timeline for a New Payment Service
=======================================

T-8 weeks: PRR initiated
  Engineering team completes self-assessment checklist
  Identify gaps: missing observability, unresolved security findings
  Begin remediation sprint

T-4 weeks: Initial review
  Staff/Principal engineer reviews checklist
  Security team reviews security section
  Compliance officer reviews compliance section
  Risk team reviews operational section
  Identify remaining blockers

T-2 weeks: Pre-launch testing
  Load test at 2x expected peak traffic
  Disaster recovery test (failover to secondary region)
  Security pen test completed; findings remediated
  Runbooks tested by on-call team

T-0: Launch approval
  All checklist items GREEN
  Sign-off from: Engineering Lead, Security Lead, Compliance Officer
  On-call rotation populated
  Status page service created
  Rollback procedure tested and confirmed working

POST-LAUNCH: 2-week hypercare
  Enhanced monitoring with low alert thresholds
  Daily error rate review
  On-call team on standby
  Automatic rollback triggers configured
```

---

## فئة قائمة التحقق 1: قابلية المراقبة

### فحوص الصحة

```java
// Spring Boot — health indicator for an external dependency.
// Report it on /actuator/health for dashboards, but keep it OUT of the
// liveness and readiness groups: if the gateway goes down, every pod would
// fail its probes at once -- restarting or removing the whole service
@Configuration
public class HealthCheckConfig {

    @Bean
    public HealthIndicator paymentGatewayHealth(PaymentGatewayClient gateway) {
        return () -> {
            try {
                GatewayStatus status = gateway.getStatus();
                if (status.isOperational()) {
                    return Health.up()
                        .withDetail("gateway", status.getName())
                        .withDetail("latency_ms", status.getLatencyMs())
                        .build();
                }
                return Health.down()
                    .withDetail("gateway", status.getName())
                    .withDetail("message", status.getDegradationMessage())
                    .build();
            } catch (Exception e) {
                return Health.down().withException(e).build();
            }
        };
    }
}
```

```yaml
# application.yml — health check configuration
management:
  health:
    db:
      enabled: true
    kafka:
      enabled: true
    redis:
      enabled: true
  endpoint:
    health:
      show-details: when-authorized  # Not 'always' — avoids leaking topology
      probes:
        enabled: true  # Kubernetes liveness + readiness probes
      group:
        readiness:
          include: readinessState,db   # only what THIS pod needs to serve traffic
        # liveness: livenessState only (the default) — never external systems

# kubernetes/deployment.yaml — health probe configuration
startupProbe:              # protects slow JVM start-up instead of a long initialDelay
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  periodSeconds: 5
  failureThreshold: 30     # up to 150 s to start

livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

### متطلبات المقاييس

```
REQUIRED metrics for every payment service endpoint:
  [ ] Request rate (requests/second)
  [ ] Error rate (errors/total, broken down by error type)
  [ ] Latency (p50, p95, p99, p999 — histogram, not summary)
  [ ] Active connections / thread pool utilisation
  [ ] JVM heap usage, GC pause time, thread count

REQUIRED metrics for Kafka consumers (if applicable):
  [ ] Consumer lag (per partition, per consumer group)
  [ ] Messages processed per second
  [ ] Processing error rate

REQUIRED metrics for database connections:
  [ ] HikariCP pool: active, idle, pending, max
  [ ] Query latency histogram
  [ ] Transaction commit/rollback rate

REQUIRED business metrics:
  [ ] Payment submission rate (by currency, by payment type)
  [ ] Payment success rate
  [ ] Payment processing latency (time from submission to settlement)
  [ ] Fraud rejection rate
```

### متطلبات التسجيل المنظم

```java
// Every log line must include these fields for incident investigation
// Configured via MDC in a servlet filter

@Component
public class CorrelationFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws IOException, ServletException {
        // Accept the caller's ID only if it looks like one -- a raw header
        // value in every log line invites log injection
        String header = request.getHeader("X-Correlation-ID");
        String correlationId = (header != null && header.matches("[A-Za-z0-9-]{8,64}"))
            ? header
            : UUID.randomUUID().toString();

        MDC.put("correlationId", correlationId);
        MDC.put("httpMethod", request.getMethod());
        MDC.put("httpPath", request.getRequestURI());
        MDC.put("service", "payment-service");
        MDC.put("environment", environmentName);   // from a property, e.g. ${app.environment}

        response.addHeader("X-Correlation-ID", correlationId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.clear();
        }
    }
}
```

### متطلبات التنبيه

```
PRR GATE: All alerts must exist and be tested before launch

Required alerts (minimum):
  [ ] Service availability: error rate > 5% for 5 minutes
  [ ] Latency degradation: p99 > 1s for 5 minutes
  [ ] Database connection pool: > 90% utilised for 5 minutes
  [ ] Kafka consumer lag: > 10,000 messages for 5 minutes
  [ ] JVM heap: > 85% for 5 minutes
  [ ] Certificates: long-lived certs expiring < 30 days; short-lived certs: renewal failing
  [ ] SLO burn rate: 14.4x over 1h, confirmed over 5m (page immediately)
  [ ] SLO burn rate: 6x over 6h, confirmed over 30m (page)
  [ ] SLO burn rate: 1x over 3 days (ticket)

Each alert must have:
  [ ] Runbook URL in annotations
  [ ] Dashboard URL in annotations
  [ ] Appropriate severity label
  [ ] Routing to correct on-call team in Alertmanager
```

### متطلبات لوحات المعلومات

```
Required Grafana dashboards:
  [ ] Service Overview: request rate, error rate, latency (all endpoints)
  [ ] JVM Health: heap, GC, threads, connections
  [ ] Kafka: consumer lag, throughput, errors (if applicable)
  [ ] Payment Business Metrics: submission rate, success rate by type
  [ ] SLO Dashboard: error budget remaining, burn rate
  [ ] Security Events: authentication failures, rate limit hits
```

---

## فئة قائمة التحقق 2: الاعتمادية

### قواطع الدائرة وإعادة المحاولة

```java
// Resilience4j configuration — required for all external service calls
@Configuration
public class ResilienceConfig {

    // Circuit breaker for payment gateway
    @Bean
    public CircuitBreakerConfig paymentGatewayCircuitBreaker() {
        return CircuitBreakerConfig.custom()
            .slidingWindowSize(10)
            .minimumNumberOfCalls(10)
            .failureRateThreshold(50)
            .waitDurationInOpenState(Duration.ofSeconds(30))
            .permittedNumberOfCallsInHalfOpenState(3)
            .build();
    }

    // Retry policy — only for idempotent operations (payment submissions are
    // idempotent only when they carry an idempotency key the gateway honours)
    @Bean
    public RetryConfig idempotentRetryConfig() {
        return RetryConfig.custom()
            .maxAttempts(3)
            // Exponential backoff with jitter: 500 ms, ~1 s, ~2 s (randomised)
            .intervalFunction(IntervalFunction.ofExponentialRandomBackoff(500, 2.0, 0.5))
            .retryOnException(e -> e instanceof TransientPaymentException)
            // NEVER retry on:
            // - Duplicate payment (idempotency violation)
            // - Insufficient funds
            // - Invalid account details
            .build();
    }
}
```

### الإيقاف الرشيق

```yaml
# application.yml — graceful shutdown lets in-flight requests complete
server:
  shutdown: graceful  # Stop accepting new requests, finish active ones
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s  # Maximum wait per shutdown phase

# kubernetes/deployment.yaml — give the pod enough time, and a short
# preStop pause so the endpoint is removed from Services first
terminationGracePeriodSeconds: 45
lifecycle:
  preStop:
    sleep:
      seconds: 5
```

```java
// Kafka listeners need no custom shutdown flag: on context close, Spring Kafka
// stops the listener containers -- the records already polled are processed,
// offsets are committed, and the consumer leaves the group cleanly.
// (Returning early from the listener during shutdown would be WRONG: the
// record counts as processed and its offset is committed -- the payment is
// silently skipped.)
@Bean
public ConcurrentKafkaListenerContainerFactory<String, PaymentEvent> kafkaListenerContainerFactory(
        ConsumerFactory<String, PaymentEvent> consumerFactory) {
    var factory = new ConcurrentKafkaListenerContainerFactory<String, PaymentEvent>();
    factory.setConsumerFactory(consumerFactory);
    // Must fit inside terminationGracePeriodSeconds
    factory.getContainerProperties().setShutdownTimeout(25_000);
    return factory;
}
```

### اختبار التعافي من الكوارث

```
PRR GATE: DR test must be completed before launch

DR Test Procedure:
  1. Simulate primary region failure (stop all pods in primary region)
  2. Measure RTO: time from failure to service recovery in secondary region
  3. Measure RPO: last committed transaction before failover vs first committed after
  4. Test rollback: restore primary region, fail back
  5. Document results: actual RTO/RPO vs targets

Required targets for payment services:
  RTO (Recovery Time Objective): < 15 minutes
  RPO (Recovery Point Objective): zero for committed payments (synchronous
      replication), or a small documented bound (e.g. < 1 minute) plus
      reconciliation of anything in flight
  
Document failures (and fix them before launch):
  - Pods not starting in secondary region (image pull policy, resource quotas)
  - Database replication lag causing RPO > target
  - DNS failover taking too long
  - Persistent volumes not available in secondary region
```

---

## فئة قائمة التحقق 3: الأمان

```
AUTHENTICATION & AUTHORISATION
  [ ] All API endpoints authenticated (no public endpoints without explicit justification)
  [ ] Authorisation tested: attempt cross-customer data access — confirm blocked
  [ ] Admin endpoints on separate service or separate auth
  [ ] Service accounts created per service (no default service accounts)
  [ ] NetworkPolicy applied: default-deny with explicit allow rules

SECRETS MANAGEMENT
  [ ] No hardcoded secrets in codebase (Semgrep scan passed)
  [ ] All secrets loaded from Vault or external secrets operator
  [ ] Database passwords are dynamic credentials from Vault (or rotated quarterly minimum)
  [ ] API keys and certificates in Kubernetes secrets (not ConfigMaps)

ENCRYPTION
  [ ] PAN and sensitive PII encrypted at application layer (not just disk encryption)
  [ ] TLS 1.2+ enforced for all inbound connections (TLS 1.3 preferred, strong suites only)
  [ ] mTLS configured for all service-to-service communication
  [ ] Encryption keys stored in KMS/Vault, not in application config

VULNERABILITY MANAGEMENT
  [ ] Semgrep SAST scan: zero HIGH/CRITICAL findings
  [ ] OWASP Dependency Check: zero CVE >= 7.0 unaddressed
  [ ] Container image scan: zero critical vulnerabilities in base image
  [ ] OWASP ZAP DAST scan against staging: zero HIGH findings
  [ ] Penetration test completed (for PCI-scoped services: required)

COMPLIANCE
  [ ] PCI DSS scope document reviewed and updated (if handling card data)
  [ ] GDPR Data Processing Impact Assessment (DPIA) completed (if processing PII)
  [ ] Data retention policy configured (auto-delete PII after retention period)
  [ ] Audit log enabled and writing to tamper-evident store
  [ ] Regulatory notification procedure documented and team trained
```

---

## فئة قائمة التحقق 4: التشغيل

### متطلبات أدلة التشغيل

```
PRR GATE: Runbooks must exist and be tested before launch

Required runbooks:
  [ ] High error rate (>5% of requests failing)
  [ ] High latency (p99 > 2x normal)
  [ ] Database connection exhaustion
  [ ] Kafka consumer lag growing
  [ ] Service completely unavailable (OOMKilled, CrashLoopBackOff)
  [ ] Disk full on PVC
  [ ] Certificate about to expire

Each runbook must:
  [ ] Be tested by an on-call engineer who did NOT write it
  [ ] Have a "last tested" date within 90 days
  [ ] Include rollback instructions
  [ ] Reference relevant dashboards and log queries
  [ ] Include escalation contacts for each scenario
```

### إعداد المناوبة

```
  [ ] On-call rotation populated with trained engineers (minimum 4 engineers)
  [ ] PagerDuty escalation policy configured (acknowledgement → escalate to manager → escalate to CTO)
  [ ] On-call engineers have been briefed on the service and have read all runbooks
  [ ] On-call engineers have production access (kubectl, database read-only, AWS console)
  [ ] Incident channel created in Slack (#incident-<service-name>)
  [ ] Status page service created for customer-facing incidents
```

### خطة السعة

```
  [ ] Baseline performance measured: requests/second per pod at p99 < 500ms
  [ ] Peak traffic estimated (1x, 2x, 10x — with justification)
  [ ] HPA configured with appropriate min/max replicas and scale trigger
  [ ] Load test at 2x expected peak: service held stable
  [ ] Load test at 5x expected peak: graceful degradation (not cascading failure)
  [ ] Database connection pool sized for maximum pod count
  [ ] Kafka partition count sufficient for maximum consumer count
```

---

## اعتماد الامتثال

```markdown
# Production Readiness Review Sign-Off

Service: payment-submission-service
Version: 2.3.0
Review Date: 2026-11-08

APPROVALS REQUIRED:

Engineering Lead
  Reviewer: [name]
  Status: APPROVED / BLOCKED
  Notes:

Security Lead
  Reviewer: [name]
  Status: APPROVED / BLOCKED / NOT APPLICABLE
  Security findings resolved: [link to ticket]
  Pen test completed: [link to report]

Compliance Officer
  Reviewer: [name]
  Status: APPROVED / BLOCKED / NOT APPLICABLE
  PCI DSS scope reviewed: [Yes / No / N/A]
  GDPR DPIA completed: [Yes / No / N/A]
  Regulatory notifications procedure confirmed: [Yes / No]

Risk Officer
  Reviewer: [name]
  Status: APPROVED / BLOCKED
  Known risks accepted: [list or "None"]
  Risk register updated: [Yes / No]

LAUNCH DECISION:
  [ ] All reviewers APPROVED → Cleared to launch
  [ ] One or more BLOCKED → Launch blocked; remediate and re-review
  [ ] Exceptions documented and accepted by Head of Engineering + CISO

HYPERCARE PLAN:
  Duration: 2 weeks
  Enhanced monitoring: Grafana on-call dashboard open during business hours
  Rollback trigger: > 2% error rate sustained 10 minutes
  Rollback procedure: kubectl rollout undo deployment/payment-submission-service
  Rollback tested: [Yes / No] — test date: [date]
```

---

## الخلاصات الأساسية

- مراجعة الجاهزية ليست نقطة تفتيش بيروقراطية — بل مساءلة هندسية: هل لدى هذه الخدمة كل ما تحتاجه لتعمل بأمان في الإنتاج؟
- تتطلب مراجعات الجاهزية في الخدمات المالية أربعة أقسام غير قابلة للتفاوض: قابلية المراقبة (هل ترى المشكلات؟)، والاعتمادية (هل تستطيع الخدمة التعافي؟)، والأمان (هل بيانات العملاء محمية؟)، والامتثال (هل الالتزامات التنظيمية مستوفاة؟)
- يجب أن يكون لكل تنبيه رابط دليل تشغيل — واختبر أدلة التشغيل مع مهندسين لم يكتبوها قبل الإطلاق، لا أثناء حادث في الثانية فجرًا
- يجب أن تُثبت اختبارات التعافي من الكوارث زمن التعافي (RTO) ونقطة التعافي (RPO) الفعليين — فالأهداف المكتوبة في وثيقة لا تعني شيئًا إن لم يُتحقق منها قط
- يضيف PCI DSS وGDPR نقاط تفتيش امتثال إلى المراجعة لا يمكن التنازل عنها حيث تنطبق: مراجعة وثيقة النطاق، وتقييم أثر حماية البيانات (DPIA) للمعالجة عالية المخاطر، واختبار الاختراق، والتحقق من سجل التدقيق
- أثمن استثمار في الجاهزية للإنتاج هو اختبار الحمل حتى ضعفي الذروة المتوقعة قبل الإطلاق — فاكتشاف استنفاد مجمع الخيوط أو حدود اتصالات قاعدة البيانات في الإنتاج أثناء ارتفاع مفاجئ في الحركة أمر يمكن تجنبه

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الأقسام الأربعة غير القابلة للتفاوض في مراجعة الجاهزية لنظام دفع في الخدمات المالية، وماذا يغطي كل منها؟",
      "options": ["البنية، والأداء، والتوثيق، والاختبار", "قابلية المراقبة (هل ترى المشكلات؟)، والاعتمادية (هل تستطيع الخدمة التعافي؟)، والأمان (هل بيانات العملاء محمية؟)، والامتثال (هل الالتزامات التنظيمية مستوفاة؟)", "التسجيل، والمراقبة، والتنبيه، والاستجابة للحوادث", "النشر، والتوسع، والنسخ الاحتياطي، والتعافي من الكوارث"],
      "correct": 1,
      "explanation": "تتطلب مراجعات الجاهزية في الخدمات المالية الأقسام الأربعة لأن كلًا منها يعالج فئة مخاطر مختلفة. فقابلية المراقبة تضمن اكتشاف المشكلات بسرعة. والاعتمادية تضمن تعافي الخدمة من الإخفاقات. والأمان يضمن حماية بيانات العملاء والبيانات المالية. والامتثال يضمن استيفاء الالتزامات التنظيمية (PCI DSS، وGDPR، وFCA) قبل الإطلاق."
    },
    {
      "text": "لماذا يجب أن تُثبت اختبارات التعافي من الكوارث زمن التعافي ونقطة التعافي الفعليين بدل مجرد توثيق الأهداف؟",
      "options": ["يتطلب المنظمون اختبارات تعافٍ موثقة لأغراض التدقيق", "لم يُتحقق قط من أهداف التعافي المكتوبة في وثيقة مقابل الواقع — فتكتشف الفرق أن زمن تعافيها الفعلي 4 ساعات بينما الهدف 30 دقيقة أثناء كارثة حقيقية فقط، حين يكون الأوان قد فات", "اختبارات التعافي مطلوبة لتدريب المهندسين الجدد", "تستوفي اختبارات التعافي متطلب PCI DSS للفحوص الفصلية"],
      "correct": 1,
      "explanation": "أهداف التعافي فرضيات حتى تُختبر. ومن الاكتشافات الشائعة أثناء أول اختبارات تعافٍ: استعادة النسخ الاحتياطية تستغرق ثلاثة أضعاف المتوقع، ودليل التشغيل فيه ثغرات، وتدوير الأسرار يكسر الاستعادة، أو منطقة التعافي ليس فيها سعة كافية. واكتشاف هذه في تمرين مخطط يكلف ساعات؛ واكتشافها أثناء كارثة حقيقية قد يعني أيامًا من التعافي."
    },
    {
      "text": "ما الغرض من فترة الرعاية المكثفة (hypercare) بعد إطلاق خدمة دفع جديدة، وما الذي يجب أن يطلق التراجع؟",
      "options": ["الرعاية المكثفة مصطلح تسويقي بلا معنى تشغيلي", "الرعاية المكثفة فترة مراقبة واستجابة معززة (عادة أسبوعان) مع محفزات تراجع محددة مسبقًا — عتبة معدل أخطاء أو تدهور زمن استجابة محدد، إن تُجووز، يسبب تراجعًا فوريًا إلى الإصدار السابق", "الرعاية المكثفة تعني تشغيل الخدمة في وضع القراءة فقط لأسبوعين", "تتطلب الرعاية المكثفة أن يكون كل المهندسين مناوبين على مدار الساعة لأسبوعين"],
      "correct": 1,
      "explanation": "توفر الرعاية المكثفة شبكة أمان للأسابيع الأولى بعد الإطلاق حين قد تكشف أنماط حركة الإنتاج غير المتوقعة مشكلات فاتت الاختبار. والمتطلب الأساسي أن تُحدد محفزات التراجع مسبقًا قبل الإطلاق (مثل معدل أخطاء >2% لمدة 10 دقائق) وأن يكون التراجع قد اختُبر. وتحديد المحفز مسبقًا يزيل ضغط اتخاذ القرار أثناء الحادث."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "مراجعة الجاهزية للإنتاج لخدمة إرسال المدفوعات",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "1",
      "description": "أكمل قسم قابلية المراقبة في مراجعة الجاهزية لخدمة إرسال مدفوعات جديدة: حدد المقاييس التي ستؤكد سلامة الخدمة (بعتبات تنبيه محددة)، واكتب دليل التشغيل لأرجح سيناريوهي إخفاق، وتحقق من أن التتبعات الموزعة ترتبط بأسطر السجل عبر معرّفات الارتباط."
    },
    {
      "id": "2",
      "description": "صمّم ونفّذ تجربة هندسة فوضى لخدمة الدفع: احقن زمن استجابة 500 مللي ثانية في استدعاءات خدمة الاحتيال وتحقق من أن قاطع الدائرة يُفتح بعد 5 إخفاقات، وأن واجهة الدفع تتدهور برشاقة (تعيد 503 مع Retry-After)، وأن التنبيه ينطلق خلال دقيقتين؛ ووثّق نتائج التجربة."
    },
    {
      "id": "3",
      "description": "أجرِ اختبار حمل باستخدام Gatling أو k6: ارفع الحمل تدريجيًا إلى ضعفي الذروة المتوقعة (عرّف الذروة بـ 1000 معاملة في الثانية)، وتحقق من بقاء زمن الاستجابة P99 تحت 500 مللي ثانية، ومن عدم استنفاد مجمع الاتصالات، ومن أن HPA يوسّع الـ pods بشكل مناسب؛ وأنتج تقرير اختبار حمل مناسبًا لوثيقة اعتماد المراجعة."
    },
    {
      "id": "4",
      "description": "أكمل قسم الامتثال في مراجعة الجاهزية: تحقق من توليد سجلات التدقيق لكل إرسال دفع، ومن إخفاء PAN في كل مخرجات السجل، ومن توثيق نطاق الخدمة في وثيقة نطاق PCI DSS، وتأكد من أن إجراء الإبلاغ عن الحوادث يستوفي المواعيد التنظيمية (تقارير الحوادث الكبرى في DORA، وإشعار الخرق خلال 72 ساعة بموجب GDPR، وأي قواعد إبلاغ FCA منطبقة)."
    }
  ]
}
-->
