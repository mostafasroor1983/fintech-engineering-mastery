---
id: track-02-lesson-11
title: "Service Discovery and Health Checking"
slug: service-discovery
track: track-02
trackName: Distributed Systems Engineering
sequence: 11
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [service-discovery, Consul, Eureka, health-check, DNS]
prerequisites: []
---

# Service Discovery and Health Checking

> [!NOTE]
> In a payment microservices architecture, a service that cannot find its dependencies cannot process transactions. Service discovery is not an infrastructure nicety — it is a first-class reliability concern. The wrong discovery strategy can introduce latency spikes, stale routing, or cascading failures that take down an entire payment processing pipeline.

## The Service Discovery Problem

When monolithic banking applications ran on a fixed set of servers with static IP addresses, service-to-service communication was configured in properties files. In a modern containerized microservices environment, service instances come and go constantly: auto-scaling adds instances under load, rolling deployments replace instances, failures cause restarts, and Kubernetes reschedules pods across nodes.

A **service registry** is the solution: a centralized (or distributed) directory that maps logical service names to their current network locations. Services register on startup and deregister on shutdown. Clients query the registry to find healthy instances.

The two fundamental architectures are:

- **Client-side discovery**: The service consumer queries the registry and performs load balancing itself
- **Server-side discovery**: The consumer calls a fixed endpoint (load balancer or proxy) that queries the registry and routes the request

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

## Client-Side Discovery with Netflix Eureka and Spring Cloud

Netflix Eureka is the canonical client-side discovery solution in the Spring Cloud ecosystem. Each microservice is both a Eureka client (registering itself) and a consumer of the registry (discovering peers).

### Setting Up Eureka Server

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

### Registering a Payment Service

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
    # Health check URL — Eureka uses this to verify instance health
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
    serviceUrl:
      defaultZone: http://eureka-1.payments.internal:8761/eureka/
    # Cache TTL — lower values mean faster discovery of new instances
    registryFetchIntervalSeconds: 5
```

### Calling a Service via Discovery

```java
@Service
public class FraudCheckClient {

    private final RestTemplate restTemplate;
    private final LoadBalancerClient loadBalancer;

    // Spring Cloud's @LoadBalanced RestTemplate automatically resolves
    // service names to instances via the discovery registry
    public FraudCheckClient(
            @LoadBalanced RestTemplate restTemplate,
            LoadBalancerClient loadBalancer) {
        this.restTemplate = restTemplate;
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
     * When you need explicit control over instance selection —
     * e.g., for sticky sessions in a stateful fraud model context.
     */
    public FraudAssessment checkWithAffinity(TransactionContext ctx, String sessionKey) {
        ServiceInstance instance = loadBalancer.choose("fraud-detection-service");
        if (instance == null) {
            throw new ServiceUnavailableException("No healthy instances of fraud-detection-service");
        }

        String url = String.format("http://%s:%d/v1/assess",
            instance.getHost(), instance.getPort());

        return restTemplate.postForObject(url,
            FraudCheckRequest.from(ctx).withSessionKey(sessionKey),
            FraudAssessment.class
        );
    }
}
```

---

## Consul Service Mesh

HashiCorp Consul extends service discovery into a full **service mesh**: service registration, health checking, service-to-service authorization (intentions), and mTLS between services. For a financial institution, Consul's intent-based authorization is particularly valuable — it enforces which services are allowed to call each other at the network layer.

### Registering a Service with Consul

```json
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

### Consul Intentions — Service Authorization

```bash
# Only payment-processor is allowed to call account-service
consul intention create -allow payment-processor account-service

# fraud-detection-service can call account-service (read-only lookup)
consul intention create -allow fraud-detection-service account-service

# Default deny — no other service can call account-service
consul intention create -deny "*" account-service

# View effective intentions
consul intention list
```

### Querying Consul from Java

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

---

## DNS-Based Service Discovery

DNS-based discovery is the simplest and most universally compatible approach. Services are registered as DNS A/SRV records and updated when instances change. Kubernetes uses DNS-based discovery natively.

### DNS SRV Records for Payment Services

```bash
# SRV record format: _service._proto.name TTL class SRV priority weight port target
_payment-processor._tcp.payments.svc.cluster.local. 5 IN SRV 10 100 8080 pp-1.payments.svc.cluster.local.
_payment-processor._tcp.payments.svc.cluster.local. 5 IN SRV 10 100 8080 pp-2.payments.svc.cluster.local.
_payment-processor._tcp.payments.svc.cluster.local. 5 IN SRV 10 100 8080 pp-3.payments.svc.cluster.local.
```

```java
@Service
public class DnsServiceDiscovery {

    /**
     * Resolve service instances via DNS SRV records.
     * Lower TTL (5s) ensures rapid propagation of instance changes.
     */
    public List<ServiceEndpoint> resolveViaSrv(String serviceName, String domain) {
        String srvQuery = String.format("_%s._tcp.%s", serviceName, domain);

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

---

## Kubernetes Service Discovery

Kubernetes provides built-in service discovery via its Service abstraction. Each Service gets a stable DNS name and virtual IP, and kube-proxy handles load balancing across healthy pods.

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
                # Allow in-flight requests to complete before the pod stops
                command: ["/bin/sh", "-c", "sleep 15"]
```

Within the `payments` namespace, any service can reach `payment-processor` at:
- `payment-processor` (short name)
- `payment-processor.payments` (name + namespace)
- `payment-processor.payments.svc.cluster.local` (fully qualified)

---

## Health Check Endpoints

A service discovery system is only as good as its health checks. If unhealthy instances remain registered, clients will route requests to them and fail. Health checks must reflect the actual ability of the service to handle requests — not just that the process is running.

### Spring Boot Actuator Health Checks

```java
@Configuration
public class PaymentHealthConfiguration {

    @Bean
    public HealthIndicator databaseHealthIndicator(DataSource dataSource) {
        return () -> {
            try (Connection conn = dataSource.getConnection()) {
                conn.setAutoCommit(false);
                // Test actual write capability, not just connectivity
                try (PreparedStatement ps = conn.prepareStatement(
                        "SELECT 1 FROM payment_ledger LIMIT 1")) {
                    ps.executeQuery();
                }
                return Health.up()
                    .withDetail("database", "writable")
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
    public HealthIndicator kafkaHealthIndicator(KafkaTemplate<?, ?> kafkaTemplate) {
        return () -> {
            try {
                // Probe Kafka connectivity by describing the topic
                kafkaTemplate.getProducerFactory()
                    .createProducer()
                    .partitionsFor("payment-events");
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
          include: db, kafka, fraudService
          # Service is not ready until all critical dependencies are healthy
        liveness:
          include: ping
          # Service is alive as long as the JVM is running
```

### Readiness vs Liveness

This distinction is critical in a Kubernetes payment service:

- **Liveness probe**: Is the process healthy? If it fails, Kubernetes restarts the container.
- **Readiness probe**: Is the service ready to serve traffic? If it fails, Kubernetes removes it from the load balancer — but does NOT restart it.

```java
@Component
public class PaymentProcessorReadinessState implements ApplicationListener<ApplicationReadyEvent> {

    private final ReadinessState readinessState;
    private final LedgerConnectionPool ledgerPool;

    /**
     * During startup, the service marks itself as not-ready until
     * it has pre-warmed its connection pool and loaded configuration.
     * This prevents premature routing of payment requests.
     */
    @Override
    public void onApplicationEvent(ApplicationReadyEvent event) {
        try {
            // Pre-warm connection pool
            ledgerPool.initialize(minimumPoolSize());
            // Load fraud rules, exchange rates, etc.
            configurationCache.refresh();

            readinessState.acceptTraffic();
            log.info("Payment processor ready — accepting traffic");
        } catch (Exception e) {
            log.error("Startup initialization failed — marking as not-ready", e);
            readinessState.refuseTraffic();
        }
    }
}
```

---

## Deregistration on Failure

One of the most critical operational requirements is **fast deregistration**: when a service instance dies, it must be removed from the registry quickly so that clients stop routing requests to it.

### Graceful Shutdown with Deregistration

```java
@Component
public class GracefulShutdownHandler {

    private final ServiceRegistry serviceRegistry;
    private final ActiveRequestTracker activeRequests;

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

### Consul Deregistration on Critical Health Failure

The `deregisterCriticalServiceAfter` field in the Consul health check definition automatically removes a service from the registry after it has been in a critical (failing) state for the specified duration. This handles cases where the service process dies without calling the deregister API:

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

For payment systems, 60 seconds of continued routing to a failed instance is too long. Use aggressive deregistration settings:

```json
{
  "check": {
    "http": "http://localhost:8080/actuator/health/readiness",
    "interval": "5s",
    "timeout": "3s",
    "deregisterCriticalServiceAfter": "15s"
  }
}
```

---

## Service Discovery in Payment Microservices

A payment processing pipeline typically involves multiple service calls: authorization, fraud detection, account balance checking, ledger recording, and notification. Each hop must route to a healthy instance. The discovery strategy significantly impacts end-to-end latency and failure behavior.

### Circuit Breaker Integration with Service Discovery

Service discovery must be combined with circuit breakers. When a discovered instance is repeatedly failing, the circuit breaker opens and prevents further calls to that instance:

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

### Complete Payment Service Discovery Configuration

```yaml
# application.yml — complete service discovery config for payment microservice
spring:
  application:
    name: payment-processor
  cloud:
    loadbalancer:
      ribbon:
        enabled: false  # Use Spring Cloud LoadBalancer, not Ribbon
      retry:
        enabled: true
        max-retries-on-next-instance: 2  # Try up to 2 other instances on failure
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

---

## Production Tips and Common Pitfalls

### Pitfall 1: Stale Registry Caches

Eureka clients cache the registry locally. If `registryFetchIntervalSeconds` is 30 (the default), a newly failed instance can receive traffic for up to 30 seconds after failing. Reduce this for payment services:

```yaml
eureka:
  client:
    registryFetchIntervalSeconds: 5
  instance:
    leaseRenewalIntervalInSeconds: 10
    leaseExpirationDurationInSeconds: 20
```

### Pitfall 2: Health Checks That Don't Reflect Reality

A health check that only verifies `SELECT 1` from the database is misleading — it proves the database is reachable but not that the service can actually process payments. Health checks should exercise the critical path:

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

### Pitfall 3: Self-Preservation Mode in Eureka

Eureka's self-preservation mode prevents it from deregistering instances when it thinks it is experiencing a network issue. In a payment system where instances die regularly (deployments, crashes), self-preservation can cause clients to route to dead instances:

```yaml
eureka:
  server:
    # Disable self-preservation only if your network is stable
    # and you have good health checks with fast deregistration
    enableSelfPreservation: false
    evictionIntervalTimerInMs: 3000
```

### Pitfall 4: Missing Readiness Probe Delay

New instances start receiving payment traffic before they are fully initialized — connection pools are cold, caches are empty, configuration hasn't loaded. Add an `initialDelaySeconds` to readiness probes:

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

## Summary

Service discovery is the backbone of resilient payment microservices. The key decisions are:

| Concern | Recommendation for Payments |
|---|---|
| Discovery approach | Client-side (Spring Cloud + Eureka) or Consul for service mesh |
| Health check frequency | Every 5-10 seconds for payment-critical services |
| Deregistration timeout | 15-30 seconds maximum (Consul `deregisterCriticalServiceAfter`) |
| Registry cache TTL | 5 seconds (reduce Eureka's default 30s) |
| Readiness vs liveness | Readiness must check ALL critical dependencies |
| Load balancing | Combine with circuit breakers to avoid routing to degraded instances |
| Kubernetes | Use readiness/liveness probes + `preStop` hook for graceful shutdown |

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "What is the fundamental difference between client-side and server-side service discovery?",
      "options": ["Client-side uses DNS; server-side uses IP addresses", "In client-side discovery the consumer queries the registry and chooses an instance; in server-side discovery a load balancer queries the registry and routes the call", "Client-side discovery requires Kubernetes; server-side works on bare metal only", "Server-side discovery cannot perform health checks"],
      "correct": 1,
      "explanation": "In client-side discovery (e.g., Netflix Eureka with Ribbon), the consumer fetches the instance list from the registry and performs load balancing itself. In server-side discovery (e.g., AWS ALB, Consul with Envoy), the consumer calls a fixed endpoint and an intermediary does the lookup and routing."
    },
    {
      "text": "Why should a payment service's health check endpoint verify its database connection and downstream dependencies rather than just returning HTTP 200?",
      "options": ["HTTP 200 alone causes Eureka to deregister the instance", "A service that cannot reach its database will fail every request; routing traffic to it wastes capacity and causes cascading failures", "Kubernetes ignores HTTP 200 responses for liveness probes", "Deep health checks are required by PCI-DSS"],
      "correct": 1,
      "explanation": "A shallow health check that only confirms the process is running allows a broken instance (unreachable database, saturated thread pool) to remain in the registry and receive traffic. Deep health checks verify that the instance can actually process requests."
    },
    {
      "text": "What is the main drawback of Eureka's default 30-second heartbeat and registration cache TTL in a Kubernetes payment environment?",
      "options": ["It prevents more than 500 service instances from registering", "Stale routing persists for up to 90 seconds after an instance failure, sending payments to dead pods", "Consul becomes the single point of failure", "mTLS certificates cannot be renewed within the TTL window"],
      "correct": 1,
      "explanation": "With a 30-second heartbeat and a 3-missed-heartbeat eviction threshold, a failed instance can remain in the registry for up to 90 seconds. During this window, clients route payment requests to a dead service instance, causing failures."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Service Discovery with Deep Health Checks for a Payment Microservices Cluster",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Configure a Spring Boot payment service with Eureka client registration. Implement a custom HealthIndicator that checks database connectivity, Redis availability, and downstream fraud service reachability. Verify that the Eureka instance is marked DOWN when any dependency is unhealthy."},
    {"id": "2", "description": "Reduce Eureka's default cache TTL to 5 seconds and heartbeat interval to 5 seconds. Deploy 3 instances of the payment service, kill one, and measure the actual time before it is removed from active routing. Compare against the default 90-second worst case."},
    {"id": "3", "description": "Implement a Consul-based service discovery alternative for the same payment service using Spring Cloud Consul. Configure a TCP health check on the service port and an HTTP check on /actuator/health. Test graceful deregistration using the preStop hook pattern."},
    {"id": "4", "description": "Build a chaos test that uses iptables to block the payment service's ability to reach Eureka. Verify the service continues to process requests using its locally cached registry for 60 seconds, then implement a staleness alert that fires when local cache age exceeds the configured TTL."}
  ]
}
-->

The fundamental principle: **the registry must always reflect reality**. Any gap between the registry state and actual service health directly translates to failed payment transactions.
