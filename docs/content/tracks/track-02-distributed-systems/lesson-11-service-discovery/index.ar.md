---
id: track-02-lesson-11
title: "اكتشاف الخدمات وفحص سلامتها"
slug: service-discovery
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 11
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [service-discovery, Consul, Eureka, health-check, DNS]
prerequisites: []
---

# اكتشاف الخدمات وفحص سلامتها

> [!NOTE]
> في بنية مدفوعات مبنية على الخدمات المصغّرة، الخدمة التي لا تجد اعتمادياتها لا تستطيع معالجة المعاملات. فاكتشاف الخدمات ليس رفاهية في البنية التحتية — بل مسألة موثوقية من الدرجة الأولى. واستراتيجية الاكتشاف الخاطئة قد تُدخل قفزات في الزمن، أو توجيهًا قديمًا، أو أعطالًا متتالية تُسقط مسار معالجة المدفوعات بالكامل.

## مشكلة اكتشاف الخدمات

عندما كانت التطبيقات المصرفية الموحّدة تعمل على مجموعة ثابتة من الخوادم بعناوين IP ثابتة، كان التواصل بين الخدمات يُضبط في ملفات الإعداد. أما في بيئة الخدمات المصغّرة الحديثة القائمة على الحاويات، فتظهر نسخ الخدمات وتختفي باستمرار: التوسع التلقائي يضيف نسخًا تحت الحمل، والنشر المتدرج يستبدل النسخ، والأعطال تسبب إعادة التشغيل، وKubernetes يعيد جدولة الـ pods عبر العقد.

و**سجل الخدمات** هو الحل: دليل مركزي (أو موزع) يربط أسماء الخدمات المنطقية بمواقعها الحالية على الشبكة. تسجّل الخدمات نفسها عند البدء وتلغي تسجيلها عند الإيقاف. ويستعلم العملاء السجل للعثور على النسخ السليمة.

البنيتان الأساسيتان هما:

- **الاكتشاف من جهة العميل**: يستعلم المستهلك السجل ويوزع الحمل بنفسه
- **الاكتشاف من جهة الخادم**: يستدعي المستهلك نقطة ثابتة (موازن حمل أو وكيل) تستعلم السجل وتوجّه الطلب

```
Client-Side Discovery:
  Payment Service ──► Service Registry ──► [Instance A: 10.0.1.5:8080]
                                           [Instance B: 10.0.1.6:8080]  (client chooses)
                                           [Instance C: 10.0.1.7:8080]

Server-Side Discovery:
  Payment Service ──► Load Balancer ──► Service Registry
                                              │
                                    ──► Instance A, B, or C  (LB chooses)
```

---

## الاكتشاف من جهة العميل مع Netflix Eureka وSpring Cloud

‏Netflix Eureka هو الحل المعياري للاكتشاف من جهة العميل في منظومة Spring Cloud. وكل خدمة مصغّرة عميل لـ Eureka (تسجّل نفسها) ومستهلك للسجل (تكتشف نظيراتها) في الوقت نفسه.

### إعداد خادم Eureka

```java
// EurekaServerApplication.java
@SpringBootApplication
@EnableEurekaServer
public class EurekaServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(EurekaServerApplication.class, args);
    }
}
```

```yaml
# application.yml for Eureka Server (High Availability — 3-node cluster)
server:
  port: 8761

spring:
  application:
    name: eureka-server

eureka:
  instance:
    hostname: eureka-1.payments.internal
  client:
    registerWithEureka: true   # In HA mode, peers register with each other
    fetchRegistry: true
    serviceUrl:
      defaultZone: >
        http://eureka-2.payments.internal:8761/eureka/,
        http://eureka-3.payments.internal:8761/eureka/
  server:
    # Disable self-preservation for faster deregistration in production
    # WARNING: only disable if you have stable infrastructure; in unstable
    # networks this causes unnecessary deregistrations
    enableSelfPreservation: false
    evictionIntervalTimerInMs: 5000
```

### تسجيل خدمة دفع

```java
// PaymentProcessorApplication.java
@SpringBootApplication
@EnableDiscoveryClient
public class PaymentProcessorApplication {
    public static void main(String[] args) {
        SpringApplication.run(PaymentProcessorApplication.class, args);
    }
}
```

```yaml
# application.yml for Payment Processor Service
spring:
  application:
    name: payment-processor  # This is the service name in the registry

eureka:
  instance:
    # Use IP address rather than hostname for container environments
    preferIpAddress: true
    # Eureka does NOT poll this URL itself — it only trusts heartbeats.
    # client.healthcheck.enabled (below) makes the heartbeat carry the
    # actuator health status, so a DOWN instance is marked DOWN in Eureka.
    healthCheckUrlPath: /actuator/health
    statusPageUrlPath: /actuator/info
    # How often to send heartbeats to Eureka (default 30s — reduce for faster failover)
    leaseRenewalIntervalInSeconds: 10
    # How long before Eureka removes an instance with no heartbeats (default 90s)
    leaseExpirationDurationInSeconds: 30
    metadata-map:
      version: ${app.version}
      region: ${cloud.region}
      datacenter: ${datacenter.name}
  client:
    healthcheck:
      enabled: true
    serviceUrl:
      defaultZone: http://eureka-1.payments.internal:8761/eureka/
    # Cache TTL — lower values mean faster discovery of new instances
    registryFetchIntervalSeconds: 5
```

لا يستطلع Eureka رابط الصحة بنفسه — بل يثق بالنبضات فقط. والخيار `client.healthcheck.enabled` يجعل النبضة تحمل حالة الصحة من actuator، فتُعلَّم النسخة المعطلة DOWN في Eureka.

### استدعاء خدمة عبر الاكتشاف

```java
@Service
public class FraudCheckClient {

    private final RestTemplate restTemplate;        // @LoadBalanced: resolves service names
    private final RestTemplate plainRestTemplate;   // NOT load-balanced: for host:port URLs
    private final LoadBalancerClient loadBalancer;

    // Spring Cloud's @LoadBalanced RestTemplate automatically resolves
    // service names to instances via the discovery registry
    public FraudCheckClient(
            @LoadBalanced RestTemplate restTemplate,
            @Qualifier("plainRestTemplate") RestTemplate plainRestTemplate,
            LoadBalancerClient loadBalancer) {
        this.restTemplate = restTemplate;
        this.plainRestTemplate = plainRestTemplate;
        this.loadBalancer = loadBalancer;
    }

    public FraudAssessment checkTransaction(TransactionContext ctx) {
        // "fraud-detection-service" is the logical name in the registry
        // Spring Cloud resolves this to a real host:port at call time
        return restTemplate.postForObject(
            "http://fraud-detection-service/v1/assess",
            FraudCheckRequest.from(ctx),
            FraudAssessment.class
        );
    }

    /**
     * When you need explicit control over instance selection.
     * Note: choose() alone is not sticky — for real affinity configure a
     * request-based sticky-session load balancer or hash the session key.
     * The URL already contains host:port, so it must go through a plain
     * RestTemplate: a @LoadBalanced one would treat the IP as a service name.
     */
    public FraudAssessment checkWithAffinity(TransactionContext ctx, String sessionKey) {
        ServiceInstance instance = loadBalancer.choose("fraud-detection-service");
        if (instance == null) {
            throw new ServiceUnavailableException("No healthy instances of fraud-detection-service");
        }

        String url = String.format("http://%s:%d/v1/assess",
            instance.getHost(), instance.getPort());

        return plainRestTemplate.postForObject(url,
            FraudCheckRequest.from(ctx).withSessionKey(sessionKey),
            FraudAssessment.class
        );
    }
}
```

يحوّل `RestTemplate` المعلَّم بـ `@LoadBalanced` أسماء الخدمات إلى نسخ عبر السجل. أما عندما يحتوي الرابط على العنوان والمنفذ مباشرة، فيجب استخدام `RestTemplate` عادي، لأن النسخة الموزّعة للحمل ستعامل عنوان IP كاسم خدمة. ولاحظ أن `choose()` وحده لا يضمن الالتصاق بنسخة معينة.

---

## شبكة الخدمات في Consul

يوسّع HashiCorp Consul اكتشاف الخدمات إلى **شبكة خدمات** كاملة: تسجيل الخدمات، وفحص سلامتها، والتفويض بين الخدمات (intentions)، وmTLS بينها. وفي مؤسسة مالية، يكون التفويض القائم على النوايا في Consul مفيدًا خاصة — فهو يفرض على مستوى الشبكة أي الخدمات مسموح لها باستدعاء أيها.

### تسجيل خدمة في Consul

```jsonc
// consul-service-definition.json — payment-processor service
{
  "service": {
    "name": "payment-processor",
    "id": "payment-processor-1",
    "address": "10.0.1.5",
    "port": 8080,
    "tags": ["v2", "primary-region", "payments"],
    "meta": {
      "version": "2.4.1",
      "environment": "production"
    },
    "checks": [
      {
        "id": "http-health",
        "name": "HTTP health check",
        "http": "http://10.0.1.5:8080/actuator/health",
        "interval": "10s",
        "timeout": "5s",
        "deregisterCriticalServiceAfter": "60s"
      },
      {
        "id": "tcp-port",
        "name": "TCP port check",
        "tcp": "10.0.1.5:8080",
        "interval": "5s",
        "timeout": "2s"
      }
    ],
    "connect": {
      "sidecar_service": {
        "proxy": {
          "upstreams": [
            {
              "destination_name": "fraud-detection-service",
              "local_bind_port": 9191
            },
            {
              "destination_name": "account-service",
              "local_bind_port": 9192
            }
          ]
        }
      }
    }
  }
}
```

### نوايا Consul — تفويض الخدمات

```bash
# Only payment-processor is allowed to call account-service
consul intention create -allow payment-processor account-service

# fraud-detection-service can call account-service (read-only lookup)
consul intention create -allow fraud-detection-service account-service

# Default deny — no other service can call account-service
consul intention create -deny "*" account-service

# View effective intentions
consul intention list

# Note: newer Consul versions manage intentions as "service-intentions"
# config entries (consul config write), which can be kept in Git
```

### استعلام Consul من Java

```java
@Service
public class ConsulServiceDiscovery {

    private final ConsulClient consulClient;

    public ConsulServiceDiscovery(@Value("${consul.host}") String consulHost,
                                   @Value("${consul.port}") int consulPort) {
        this.consulClient = new ConsulClient(consulHost, consulPort);
    }

    /**
     * Returns only healthy instances of the given service.
     * Uses Consul's health endpoint which filters out instances
     * with failing health checks.
     */
    public List<ServiceEndpoint> discoverHealthyInstances(String serviceName) {
        Response<List<HealthService>> response =
            consulClient.getHealthServices(serviceName, true, null);

        return response.getValue().stream()
            .map(hs -> ServiceEndpoint.builder()
                .host(hs.getService().getAddress())
                .port(hs.getService().getPort())
                .nodeId(hs.getNode().getNode())
                .version(hs.getService().getMeta().get("version"))
                .build())
            .collect(Collectors.toList());
    }

    /**
     * Watch for service changes using Consul's blocking queries.
     * The index parameter enables long-polling — Consul returns
     * immediately only when the service list changes.
     */
    public void watchService(String serviceName, Consumer<List<ServiceEndpoint>> onChange) {
        long lastIndex = 0;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                QueryParams params = QueryParams.Builder.builder()
                    .setIndex(lastIndex)
                    .setWaitTime(30)  // Block for up to 30 seconds
                    .build();

                Response<List<HealthService>> response =
                    consulClient.getHealthServices(serviceName, true, params);

                long newIndex = response.getConsulIndex();
                if (newIndex > lastIndex) {
                    lastIndex = newIndex;
                    onChange.accept(mapToEndpoints(response.getValue()));
                }
            } catch (Exception e) {
                log.warn("Consul watch error for {}: {}", serviceName, e.getMessage());
                sleepQuietly(Duration.ofSeconds(5));
            }
        }
    }

    private void sleepQuietly(Duration d) {
        try { Thread.sleep(d.toMillis()); }
        catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }
}
```

تعيد طريقة الاكتشاف النسخ السليمة فقط، لأن نقطة الصحة في Consul تستبعد النسخ ذات الفحوص الفاشلة. وتستخدم المراقبة الاستعلامات الحاجبة (long-polling): لا يرد Consul إلا عندما تتغير قائمة الخدمة أو تنقضي مدة الانتظار.

---

## الاكتشاف القائم على DNS

الاكتشاف عبر DNS هو الأسلوب الأبسط والأوسع توافقًا. تُسجّل الخدمات كسجلات DNS من نوع A/SRV وتُحدّث عند تغير النسخ. ويستخدم Kubernetes الاكتشاف عبر DNS أصلًا.

### سجلات DNS SRV لخدمات الدفع

```bash
# SRV record format: _port-name._proto.service.namespace.svc.zone TTL class SRV priority weight port target
# Kubernetes publishes these for named ports; for a headless Service there is one per pod
_http._tcp.payment-processor.payments.svc.cluster.local. 5 IN SRV 0 33 8080 10-0-1-5.payment-processor.payments.svc.cluster.local.
_http._tcp.payment-processor.payments.svc.cluster.local. 5 IN SRV 0 33 8080 10-0-1-6.payment-processor.payments.svc.cluster.local.
_http._tcp.payment-processor.payments.svc.cluster.local. 5 IN SRV 0 33 8080 10-0-1-7.payment-processor.payments.svc.cluster.local.
```

ينشر Kubernetes هذه السجلات للمنافذ المسمّاة؛ ولخدمة headless يوجد سجل لكل pod.

```java
@Service
public class DnsServiceDiscovery {

    /**
     * Resolve service instances via DNS SRV records.
     * Lower TTL (5s) ensures rapid propagation of instance changes —
     * provided nothing in between caches longer (check the JVM's
     * networkaddress.cache.ttl and any local DNS cache).
     * Example: resolveViaSrv("http", "payment-processor.payments.svc.cluster.local")
     */
    public List<ServiceEndpoint> resolveViaSrv(String portName, String serviceDomain) {
        String srvQuery = String.format("_%s._tcp.%s", portName, serviceDomain);

        try {
            Hashtable<String, String> env = new Hashtable<>();
            env.put(Context.INITIAL_CONTEXT_FACTORY,
                "com.sun.jndi.dns.DnsContextFactory");
            env.put(Context.PROVIDER_URL, "dns://");

            DirContext ctx = new InitialDirContext(env);
            Attributes attrs = ctx.getAttributes(
                srvQuery, new String[]{"SRV"});
            Attribute srvAttr = attrs.get("SRV");

            List<ServiceEndpoint> endpoints = new ArrayList<>();
            if (srvAttr != null) {
                NamingEnumeration<?> records = srvAttr.getAll();
                while (records.hasMore()) {
                    String record = (String) records.next();
                    endpoints.add(parseSrvRecord(record));
                }
            }
            return endpoints;

        } catch (NamingException e) {
            log.error("DNS SRV lookup failed for {}: {}", srvQuery, e.getMessage());
            return Collections.emptyList();
        }
    }

    private ServiceEndpoint parseSrvRecord(String record) {
        // SRV record: "priority weight port target"
        String[] parts = record.split(" ");
        return ServiceEndpoint.builder()
            .host(parts[3].replaceAll("\\.$", "")) // Remove trailing dot
            .port(Integer.parseInt(parts[2]))
            .priority(Integer.parseInt(parts[0]))
            .weight(Integer.parseInt(parts[1]))
            .build();
    }
}
```

المدة القصيرة (5 ثوانٍ) تضمن انتشارًا سريعًا لتغييرات النسخ — بشرط ألا يخزن شيء في الطريق لمدة أطول (تحقق من `networkaddress.cache.ttl` في JVM ومن أي ذاكرة DNS محلية).

---

## اكتشاف الخدمات في Kubernetes

يوفر Kubernetes اكتشاف خدمات مدمجًا عبر مفهوم Service. فلكل Service اسم DNS ثابت وعنوان IP افتراضي، ويتولى kube-proxy توزيع الحمل على الـ pods السليمة.

```yaml
# payment-processor-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-processor
  namespace: payments
  labels:
    app: payment-processor
    tier: processing
spec:
  selector:
    app: payment-processor
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: 8080
  type: ClusterIP  # Internal only — not exposed externally

---
# payment-processor-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
    spec:
      # Must exceed the preStop sleep plus Spring's graceful shutdown time
      terminationGracePeriodSeconds: 45
      containers:
        - name: payment-processor
          image: payments/processor:2.4.1
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                # Give endpoints/kube-proxy time to stop routing here before
                # SIGTERM; Spring Boot (server.shutdown: graceful) then
                # finishes the in-flight requests
                command: ["/bin/sh", "-c", "sleep 15"]
```

يمنح الأمر `sleep 15` في `preStop` وقتًا لنقاط النهاية وkube-proxy لإيقاف التوجيه إلى الـ pod قبل SIGTERM، ثم ينهي Spring Boot ‏(`server.shutdown: graceful`) الطلبات الجارية. ويجب أن تتجاوز `terminationGracePeriodSeconds` مدة الانتظار مع زمن الإيقاف.

داخل مساحة الأسماء `payments`، يمكن لأي خدمة الوصول إلى `payment-processor` عبر:
- ‏`payment-processor` (الاسم القصير)
- ‏`payment-processor.payments` (الاسم + مساحة الأسماء)
- ‏`payment-processor.payments.svc.cluster.local` (الاسم الكامل)

---

## نقاط فحص السلامة

نظام اكتشاف الخدمات جيد بقدر جودة فحوص سلامته. فإذا بقيت نسخ معطلة مسجّلة، سيوجّه العملاء الطلبات إليها فتفشل. ويجب أن تعكس فحوص السلامة القدرة الفعلية للخدمة على معالجة الطلبات — لا مجرد أن العملية تعمل.

### فحوص السلامة في Spring Boot Actuator

```java
@Configuration
public class PaymentHealthConfiguration {

    @Bean
    public HealthIndicator databaseHealthIndicator(DataSource dataSource) {
        return () -> {
            try (Connection conn = dataSource.getConnection()) {
                // Checks the ledger table is readable — a read, not a write test
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT 1 FROM payment_ledger LIMIT 1")) {
                    ps.executeQuery();
                }
                return Health.up()
                    .withDetail("database", "reachable")
                    .build();
            } catch (SQLException e) {
                return Health.down()
                    .withDetail("database", "unreachable")
                    .withException(e)
                    .build();
            }
        };
    }

    @Bean
    public HealthIndicator kafkaHealthIndicator(KafkaAdmin kafkaAdmin) {
        return () -> {
            // Short-lived admin client, always closed (creating a producer per
            // probe and never closing it leaks threads and connections)
            try (AdminClient admin = AdminClient.create(kafkaAdmin.getConfigurationProperties())) {
                admin.describeCluster().nodes().get(3, TimeUnit.SECONDS);
                return Health.up().withDetail("kafka", "reachable").build();
            } catch (Exception e) {
                return Health.down()
                    .withDetail("kafka", "unreachable")
                    .withException(e)
                    .build();
            }
        };
    }

    @Bean
    public HealthIndicator fraudServiceHealthIndicator(FraudCheckClient client) {
        return () -> {
            try {
                client.ping();
                return Health.up()
                    .withDetail("fraud-service", "reachable")
                    .build();
            } catch (Exception e) {
                // Downstream dependency failure — still return UP if degraded mode is OK,
                // but mark DOWN if fraud checks are mandatory
                return Health.down()
                    .withDetail("fraud-service", "unreachable — payments halted")
                    .withException(e)
                    .build();
            }
        };
    }
}
```

يُنشأ عميل الإدارة في فحص Kafka لمدة قصيرة ويُغلق دائمًا — فإنشاء منتج في كل فحص دون إغلاقه يسرّب الخيوط والاتصالات.

```yaml
# application.yml — health endpoint configuration
management:
  endpoints:
    web:
      exposure:
        include: health, info, metrics, prometheus
  endpoint:
    health:
      show-details: when-authorized
      probes:
        enabled: true  # Enables /actuator/health/liveness and /readiness
      group:
        readiness:
          include: readinessState, db
          # Only dependencies THIS instance owns. If a SHARED downstream service
          # (fraud, Kafka) were in readiness, its outage would mark EVERY
          # instance unready and Kubernetes would remove them all at once.
          # Handle shared dependencies with circuit breakers instead.
        liveness:
          include: livenessState
          # Never include external systems: a DB outage must not restart pods
```

> [!WARNING]
> ضع في فحص الجاهزية فقط الاعتماديات التي تملكها هذه النسخة. فلو أُدرجت خدمة لاحقة مشتركة (الاحتيال، أو Kafka)، لجعل انقطاعها **كل** النسخ غير جاهزة، فيزيلها Kubernetes كلها دفعة واحدة. تعامل مع الاعتماديات المشتركة بقواطع الدائرة. ولا تُدرج أبدًا أنظمة خارجية في فحص الحيوية (liveness): فانقطاع قاعدة البيانات يجب ألا يعيد تشغيل الـ pods.

### الجاهزية مقابل الحيوية

هذا التمييز حاسم في خدمة دفع على Kubernetes:

- **فحص الحيوية (Liveness)**: هل العملية سليمة؟ إذا فشل يعيد Kubernetes تشغيل الحاوية.
- **فحص الجاهزية (Readiness)**: هل الخدمة جاهزة لاستقبال الحركة؟ إذا فشل يزيلها Kubernetes من موازن الحمل — لكنه **لا** يعيد تشغيلها.

```java
@Component
public class PaymentProcessorWarmUp implements ApplicationRunner {

    private final ApplicationEventPublisher events;
    private final LedgerConnectionPool ledgerPool;
    private final ConfigurationCache configurationCache;

    /**
     * Spring Boot reports ReadinessState.ACCEPTING_TRAFFIC only after all
     * ApplicationRunners have finished, so warming up here keeps payment
     * requests away until the connection pool and configuration are ready.
     */
    @Override
    public void run(ApplicationArguments args) {
        try {
            ledgerPool.initialize(minimumPoolSize());   // pre-warm connections
            configurationCache.refresh();               // fraud rules, FX rates, ...
            log.info("Payment processor warmed up");
        } catch (Exception e) {
            log.error("Startup initialization failed — refusing traffic", e);
            AvailabilityChangeEvent.publish(events, this, ReadinessState.REFUSING_TRAFFIC);
        }
    }
}
```

لا يعلن Spring Boot حالة `ACCEPTING_TRAFFIC` إلا بعد انتهاء كل `ApplicationRunner`، فالتسخين هنا يُبقي طلبات الدفع بعيدة حتى تجهز مجموعة الاتصالات والإعدادات.

---

## إلغاء التسجيل عند الفشل

من أهم المتطلبات التشغيلية **إلغاء التسجيل السريع**: عندما تموت نسخة خدمة، يجب إزالتها من السجل بسرعة حتى يتوقف العملاء عن توجيه الطلبات إليها.

### الإيقاف المنظم مع إلغاء التسجيل

```java
@Component
public class GracefulShutdownHandler {

    private final ServiceRegistry serviceRegistry;
    private final ActiveRequestTracker activeRequests;

    // Spring Boot can do the waiting for you: server.shutdown: graceful and
    // spring.lifecycle.timeout-per-shutdown-phase: 30s. This handler shows
    // the extra step for registries outside Kubernetes: deregister FIRST.
    @PreDestroy
    public void shutdown() {
        log.info("Shutdown initiated — deregistering from service registry");

        // 1. Mark as not-ready (stop receiving new requests via load balancer)
        serviceRegistry.deregister(selfRegistration());

        // 2. Wait for in-flight requests to complete (up to 30 seconds)
        Instant deadline = Instant.now().plus(Duration.ofSeconds(30));
        while (activeRequests.count() > 0 && Instant.now().isBefore(deadline)) {
            log.info("Waiting for {} in-flight payment requests to complete...",
                activeRequests.count());
            sleepQuietly(Duration.ofSeconds(1));
        }

        if (activeRequests.count() > 0) {
            log.warn("Shutdown proceeding with {} incomplete requests after timeout",
                activeRequests.count());
        }

        log.info("Shutdown complete");
    }
}
```

يستطيع Spring Boot الانتظار نيابة عنك (`server.shutdown: graceful` و`spring.lifecycle.timeout-per-shutdown-phase`). ويُظهر هذا المعالج الخطوة الإضافية للسجلات خارج Kubernetes: ألغِ التسجيل **أولًا**، ثم انتظر الطلبات الجارية.

### إلغاء التسجيل في Consul عند فشل الفحص الحرج

هناك آليتان منفصلتان. **يتوقف التوجيه فور تحول الفحص إلى حرج**: فالعملاء الذين يطلبون من Consul النسخ الناجحة فقط (واجهة الصحة مع `passing=true`، أو DNS في Consul، أو Connect) يتخطون النسخة فورًا. أما **التنظيف** فيتولاه `deregisterCriticalServiceAfter`، الذي يزيل نسخة بقيت في حالة حرجة المدة المحددة — للعمليات التي تموت دون استدعاء واجهة إلغاء التسجيل. وحده الأدنى دقيقة واحدة، وتعمل عملية الإزالة كل 30 ثانية تقريبًا:

```json
{
  "check": {
    "http": "http://localhost:8080/actuator/health",
    "interval": "10s",
    "timeout": "5s",
    "deregisterCriticalServiceAfter": "60s"
  }
}
```

في أنظمة الدفع، اجعل الاكتشاف سريعًا — فهو ما يوقف التوجيه — وأبقِ التنظيف عند حده الأدنى:

```json
{
  "check": {
    "http": "http://localhost:8080/actuator/health/readiness",
    "interval": "5s",
    "timeout": "3s",
    "deregisterCriticalServiceAfter": "1m"
  }
}
```

---

## اكتشاف الخدمات في الخدمات المصغّرة للمدفوعات

يتضمن مسار معالجة الدفع عادة عدة استدعاءات: التفويض، وكشف الاحتيال، وفحص رصيد الحساب، والتسجيل في دفتر الأستاذ، والإشعار. ويجب أن تصل كل خطوة إلى نسخة سليمة. واستراتيجية الاكتشاف تؤثر كثيرًا في الزمن الكلي وسلوك الفشل.

### دمج قاطع الدائرة مع اكتشاف الخدمات

يجب دمج اكتشاف الخدمات مع قواطع الدائرة. فعندما تفشل نسخة مكتشفة مرارًا، ينفتح قاطع الدائرة ويمنع مزيدًا من الاستدعاءات إليها:

```java
@Service
public class ResilientPaymentClient {

    private final LoadBalancerClient loadBalancer;
    private final CircuitBreakerRegistry circuitBreakerRegistry;
    private final RestTemplate restTemplate;

    public AuthorizationResult callAuthorizationService(PaymentRequest request) {
        ServiceInstance instance = loadBalancer.choose("authorization-service");
        if (instance == null) {
            throw new ServiceUnavailableException(
                "No healthy instances of authorization-service found in registry");
        }

        String instanceKey = instance.getHost() + ":" + instance.getPort();
        CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker(
            "auth-" + instanceKey,
            CircuitBreakerConfig.custom()
                .failureRateThreshold(50)
                .waitDurationInOpenState(Duration.ofSeconds(10))
                .slidingWindowSize(10)
                .build()
        );

        return cb.executeSupplier(() -> {
            String url = String.format("http://%s:%d/v1/authorize",
                instance.getHost(), instance.getPort());
            return restTemplate.postForObject(url, request, AuthorizationResult.class);
        });
    }
}
```

### الإعداد الكامل لاكتشاف الخدمات في خدمة دفع

```yaml
# application.yml — complete service discovery config for payment microservice
spring:
  application:
    name: payment-processor
  cloud:
    loadbalancer:
      # Spring Cloud LoadBalancer (Ribbon was removed in Spring Cloud 2020)
      retry:
        enabled: true
        max-retries-on-next-service-instance: 2  # Try up to 2 other instances on failure
        retry-on-all-operations: false   # Only retry on GET; POST retries need idempotency keys

resilience4j:
  circuitbreaker:
    instances:
      fraud-detection-service:
        registerHealthIndicator: true
        slidingWindowSize: 20
        minimumNumberOfCalls: 5
        permittedNumberOfCallsInHalfOpenState: 3
        automaticTransitionFromOpenToHalfOpenEnabled: true
        waitDurationInOpenState: 15s
        failureRateThreshold: 50
        slowCallRateThreshold: 100
        slowCallDurationThreshold: 2s
      account-service:
        slidingWindowSize: 10
        waitDurationInOpenState: 10s
        failureRateThreshold: 60
```

إعادة المحاولة على نسخة أخرى تقتصر على طلبات GET؛ فإعادة محاولة POST تتطلب مفاتيح منع التكرار.

---

## نصائح للإنتاج وأخطاء شائعة

### الخطأ 1: ذاكرة سجل قديمة

يخزن عملاء Eureka السجل محليًا، والتأخيرات تتراكم: يجب أن ينتهي الإيجار (90 ثانية افتراضيًا)، وأن تعمل مهمة الإزالة في الخادم، وتُحدَّث ذاكرة الردود في الخادم كل 30 ثانية، ويجلب كل عميل السجل كل 30 ثانية. فمع القيم الافتراضية قد تستمر نسخة معطلة في تلقي الحركة دقيقتين أو أكثر. خفّض هذه القيم لخدمات الدفع (واستخدم `eureka.server.responseCacheUpdateIntervalMs` في الخادم):

```yaml
eureka:
  client:
    registryFetchIntervalSeconds: 5
  instance:
    leaseRenewalIntervalInSeconds: 10
    leaseExpirationDurationInSeconds: 20
```

### الخطأ 2: فحوص سلامة لا تعكس الواقع

فحص السلامة الذي يتحقق فقط من `SELECT 1` في قاعدة البيانات مضلل — فهو يثبت أن قاعدة البيانات قابلة للوصول، لا أن الخدمة تستطيع فعلًا معالجة المدفوعات. ويجب أن يمر الفحص العميق بالمسار الحرج. اعرضه كنقطة منفصلة للمراقبة والتنبيه — لا كفحص للجاهزية — حتى لا يُخرج فشل اعتمادية مشتركة واحدة كل النسخ من التوجيه دفعة واحدة:

```java
@Component("deepPaymentHealthCheck")
public class DeepPaymentHealthIndicator implements HealthIndicator {

    @Override
    public Health health() {
        // Check all critical dependencies in one probe
        List<String> failures = new ArrayList<>();

        if (!canWriteToLedger()) failures.add("ledger-write-failed");
        if (!canReachFraudService()) failures.add("fraud-service-unreachable");
        if (!canPublishToKafka()) failures.add("kafka-publish-failed");
        if (!exchangeRatesAreFresh()) failures.add("exchange-rates-stale");

        if (failures.isEmpty()) {
            return Health.up().withDetail("checks", "all-passed").build();
        }
        return Health.down().withDetail("failures", failures).build();
    }
}
```

### الخطأ 3: وضع الحفاظ على الذات في Eureka

يمنع وضع الحفاظ على الذات (self-preservation) في Eureka إلغاء تسجيل النسخ عندما يظن أنه يواجه مشكلة شبكة. وفي نظام دفع تموت فيه النسخ بانتظام (النشر، والأعطال)، قد يجعل هذا الوضع العملاء يوجّهون الطلبات إلى نسخ ميتة:

```yaml
eureka:
  server:
    # Disable self-preservation only if your network is stable
    # and you have good health checks with fast deregistration
    enableSelfPreservation: false
    evictionIntervalTimerInMs: 3000
```

### الخطأ 4: غياب تأخير فحص الجاهزية

تبدأ النسخ الجديدة في تلقي حركة الدفع قبل اكتمال تهيئتها — مجموعات الاتصال باردة، والذاكرة المؤقتة فارغة، والإعدادات لم تُحمّل. اجعل الجاهزية تعكس التسخين (انظر ApplicationRunner أعلاه)، وللبدء البطيء أضف `startupProbe`؛ ويساعد أيضًا `initialDelaySeconds` معتدل في فحص الجاهزية:

```yaml
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  initialDelaySeconds: 20   # Allow time for initialization
  periodSeconds: 5
  failureThreshold: 3
  successThreshold: 1
```

---

## الخلاصة

اكتشاف الخدمات هو العمود الفقري للخدمات المصغّرة المرنة في المدفوعات. والقرارات الأساسية هي:

| المسألة | التوصية للمدفوعات |
|---|---|
| أسلوب الاكتشاف | من جهة العميل (Spring Cloud + Eureka) أو Consul لشبكة الخدمات |
| تكرار فحص السلامة | كل 5-10 ثوانٍ للخدمات الحرجة للمدفوعات |
| إيقاف التوجيه إلى نسخة معطلة | فحوص سريعة (5 ثوانٍ) + عملاء يستخدمون النسخ الناجحة فقط؛ و`deregisterCriticalServiceAfter` (حد أدنى دقيقة) للتنظيف |
| مدة ذاكرة السجل | 5 ثوانٍ (خفّض قيمة Eureka الافتراضية البالغة 30 ثانية) |
| الجاهزية مقابل الحيوية | الجاهزية تفحص الاعتماديات الحرجة الخاصة بالنسخة؛ والحيوية تفحص العملية فقط |
| توزيع الحمل | ادمجه مع قواطع الدائرة لتجنب التوجيه إلى نسخ متدهورة |
| Kubernetes | استخدم فحوص الجاهزية والحيوية + خطاف `preStop` للإيقاف المنظم |

المبدأ الأساسي: **يجب أن يعكس السجل الواقع دائمًا**. فأي فجوة بين حالة السجل وسلامة الخدمة الفعلية تتحول مباشرة إلى معاملات دفع فاشلة.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما الفرق الأساسي بين الاكتشاف من جهة العميل والاكتشاف من جهة الخادم؟",
      "options": ["الاكتشاف من جهة العميل يستخدم DNS؛ ومن جهة الخادم يستخدم عناوين IP", "في الاكتشاف من جهة العميل يستعلم المستهلك السجل ويختار نسخة؛ وفي الاكتشاف من جهة الخادم يستعلم موازن حمل السجل ويوجّه الاستدعاء", "الاكتشاف من جهة العميل يتطلب Kubernetes؛ ومن جهة الخادم يعمل على الخوادم الفعلية فقط", "الاكتشاف من جهة الخادم لا يستطيع إجراء فحوص السلامة"],
      "correct": 1,
      "explanation": "في الاكتشاف من جهة العميل (مثل Netflix Eureka مع Spring Cloud LoadBalancer) يجلب المستهلك قائمة النسخ من السجل ويوزع الحمل بنفسه. وفي الاكتشاف من جهة الخادم (مثل AWS ALB، أو Consul مع Envoy) يستدعي المستهلك نقطة ثابتة ويتولى وسيط البحث والتوجيه."
    },
    {
      "text": "لماذا يجب أن تتحقق نقطة فحص سلامة خدمة الدفع من اتصال قاعدة البيانات والاعتماديات بدل أن تعيد HTTP 200 فقط؟",
      "options": ["إعادة HTTP 200 وحدها تجعل Eureka يلغي تسجيل النسخة", "الخدمة التي لا تصل إلى قاعدة بياناتها ستفشل في كل طلب؛ وتوجيه الحركة إليها يهدر السعة ويسبب أعطالًا متتالية", "يتجاهل Kubernetes ردود HTTP 200 في فحوص الحيوية", "الفحوص العميقة يفرضها PCI-DSS"],
      "correct": 1,
      "explanation": "الفحص السطحي الذي يؤكد فقط أن العملية تعمل يسمح لنسخة معطلة (قاعدة بيانات غير قابلة للوصول، أو مجموعة خيوط مشبعة) بالبقاء في السجل وتلقي الحركة. ويجب أن تتحقق الفحوص من أن النسخة تستطيع فعلًا معالجة الطلبات — لكن أبقِ الخدمات اللاحقة المشتركة خارج فحص الجاهزية، وإلا سيُخرج انقطاع واحد كل النسخ من التوجيه دفعة واحدة."
    },
    {
      "text": "ما العيب الأساسي لنبضة Eureka الافتراضية البالغة 30 ثانية ومدة ذاكرة التسجيل في بيئة دفع على Kubernetes؟",
      "options": ["يمنع تسجيل أكثر من 500 نسخة خدمة", "يستمر التوجيه القديم حتى 90 ثانية بعد تعطل النسخة، فتُرسل المدفوعات إلى pods ميتة", "يصبح Consul نقطة فشل واحدة", "لا يمكن تجديد شهادات mTLS خلال نافذة المدة"],
      "correct": 1,
      "explanation": "مع نبضة كل 30 ثانية وحد إزالة بعد 3 نبضات فائتة، قد تبقى النسخة المعطلة في السجل حتى 90 ثانية. وخلال هذه النافذة يوجّه العملاء طلبات الدفع إلى نسخة خدمة ميتة، فتفشل."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "اكتشاف الخدمات مع فحوص سلامة عميقة لعنقود خدمات دفع مصغّرة",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "اضبط خدمة دفع في Spring Boot لتسجّل كعميل Eureka. ونفّذ HealthIndicator مخصصًا يفحص اتصال قاعدة البيانات، وإتاحة Redis، وإمكانية الوصول إلى خدمة الاحتيال اللاحقة. وتحقق من أن نسخة Eureka تُعلَّم DOWN عندما تكون أي اعتمادية غير سليمة."},
    {"id": "2", "description": "خفّض مدة ذاكرة Eureka الافتراضية إلى 5 ثوانٍ وفترة النبض إلى 5 ثوانٍ. انشر 3 نسخ من خدمة الدفع، واقتل واحدة، وقِس الزمن الفعلي قبل إزالتها من التوجيه النشط. وقارنه بأسوأ حالة افتراضية البالغة 90 ثانية."},
    {"id": "3", "description": "نفّذ بديلًا للاكتشاف مبنيًا على Consul لخدمة الدفع نفسها باستخدام Spring Cloud Consul. اضبط فحص TCP على منفذ الخدمة وفحص HTTP على /actuator/health. واختبر إلغاء التسجيل المنظم باستخدام نمط خطاف preStop."},
    {"id": "4", "description": "ابنِ اختبار فوضى يستخدم iptables لمنع خدمة الدفع من الوصول إلى Eureka. وتحقق من أن الخدمة تستمر في معالجة الطلبات باستخدام سجلها المخزن محليًا لمدة 60 ثانية، ثم نفّذ تنبيه قِدم ينطلق عندما يتجاوز عمر الذاكرة المحلية المدة المضبوطة."}
  ]
}
-->
