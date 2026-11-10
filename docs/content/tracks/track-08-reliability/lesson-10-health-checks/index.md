---
id: track-08-lesson-10
title: "Health Checks — Liveness, Readiness, and Startup Probes"
slug: health-checks
track: track-08
trackName: "Reliability & Production Engineering"
sequence: 10
difficulty: advanced
estimatedMinutes: 70
status: published
tags: [health-check, liveness, readiness, startup-probe, Actuator]
prerequisites: []
---

# Health Checks — Liveness, Readiness, and Startup Probes

> [!NOTE]
> The difference between liveness and readiness is the difference between "this process should be killed and restarted" and "this process should be temporarily removed from the load balancer." Getting them mixed up causes unnecessary pod restarts during database failovers and traffic spikes.

## 1. Kubernetes Probe Semantics

| Probe | Kubernetes Action on Failure | Meaning |
|---|---|---|
| Liveness | Kill pod and restart | "This pod is deadlocked or corrupted — replace it" |
| Readiness | Remove from Service (stop traffic) | "This pod is healthy but not ready for traffic right now" |
| Startup | Kill pod if startup exceeds limit | "This pod is taking too long to start" |

The critical distinction:
- **Liveness failure** = "The process itself is broken." Kubernetes kills it.
- **Readiness failure** = "Temporarily unable to serve traffic." Kubernetes routes around it. The pod stays running.

For payment services:
- Database connection failure → **Readiness failure** (remove from load balancer; pod is fine)
- Thread deadlock / JVM crash → **Liveness failure** (kill and restart)
- Application still initializing → **Startup** (Kubernetes waits before checking other probes)

## 2. Spring Boot Actuator Health Configuration

```yaml
management:
  endpoint:
    health:
      show-details: always
      show-components: always
      probes:
        enabled: true      # Enables /actuator/health/liveness and /actuator/health/readiness
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true
    # Group configuration
    group:
      liveness:
        include: livenessState
        # Only the liveness indicator — not DB, not Kafka
        # DB being down should NOT restart the pod
      readiness:
        include: readinessState,db,kafka,redis,paymentGateway
        # All dependencies must be reachable before accepting traffic
      startup:
        include: db,kafka
```

```java
@SpringBootApplication
public class PaymentServiceApplication {

    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(PaymentServiceApplication.class);
        app.run(args);
    }

    /**
     * Mark application as ACCEPTING_TRAFFIC only after all initialization is complete.
     * This prevents Kubernetes from sending traffic before the app is truly ready.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady(ApplicationReadyEvent event,
                                    AvailabilityChangeEvent.Publisher publisher) {
        publisher.publishEvent(ReadinessState.ACCEPTING_TRAFFIC);
        log.info("Payment service is ready to accept traffic");
    }

    /**
     * During graceful shutdown, mark REFUSING_TRAFFIC first.
     * This removes the pod from the load balancer before the JVM shuts down.
     * Kubernetes sends SIGTERM → readiness → REFUSING_TRAFFIC → 30s drain → SIGKILL
     */
    @EventListener(ContextClosedEvent.class)
    public void onContextClosed(ContextClosedEvent event,
                                 AvailabilityChangeEvent.Publisher publisher) {
        publisher.publishEvent(ReadinessState.REFUSING_TRAFFIC);
        log.info("Payment service refusing traffic — shutting down gracefully");
    }
}
```

## 3. Custom HealthIndicators

```java
/**
 * Database health indicator.
 * Uses a lightweight query to verify connectivity.
 * Result affects READINESS (not liveness) — DB being down
 * should remove pod from load balancer, not restart it.
 */
@Component("db")
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

    private final KafkaAdmin kafkaAdmin;
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
        DescribeClusterResult cluster = kafkaAdmin.describeCluster();
        try {
            Collection<Node> nodes = cluster.nodes().get(2, TimeUnit.SECONDS);
            return Map.of(
                "brokers", nodes.size(),
                "controller", cluster.controller().get().idString()
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
@Component("redis")
@RequiredArgsConstructor
public class RedisHealthIndicator implements HealthIndicator {

    private final RedisTemplate<String, String> redisTemplate;
    private static final String HEALTH_CHECK_KEY = "health:check:token";

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

            return Health.up()
                .withDetail("pingResponse", redisTemplate.getConnectionFactory()
                    .getConnection().ping())
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

## 4. Health Check Groups — Deep vs Shallow

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
 * DEEP (for readiness):
 *   - Can we reach the database?
 *   - Can we reach Kafka?
 *   - Can we reach the payment gateway?
 *   - Is our internal state consistent?
 *   - Response time: < 2s (or health check timeouts fail)
 *
 * Example: During a Kafka broker restart:
 *   - Shallow (liveness): UP — JVM is fine
 *   - Deep (readiness): DOWN — Kafka temporarily unreachable
 *   → Pod is removed from load balancer (no traffic)
 *   → Pod is NOT killed (no restart needed)
 *   → When Kafka recovers, readiness returns UP, pod gets traffic back
 */

@Configuration
public class HealthGroupConfig {

    /**
     * Custom health group for infrastructure checks.
     * Useful for ops tools that need to check specific components.
     */
    @Bean
    public HealthEndpointGroups healthEndpointGroups() {
        return HealthEndpointGroups.of(
            new DefaultHealthEndpointGroup(
                Set.of("livenessState"),
                StatusAggregator.getDefault(),
                HttpCodeStatusMapper.DEFAULT,
                null
            )
        );
    }
}

// application.yml groups
/*
management:
  health:
    group:
      liveness:
        include: livenessState
        show-details: never         # Minimal response — Kubernetes reads this
      readiness:
        include: readinessState,db,kafka,redis
        show-details: when-authorized
      infrastructure:
        include: db,kafka,redis,paymentGateway
        show-details: always        # Ops visibility endpoint
*/
```

## 5. Kubernetes Probe Configuration

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
          startupProbe:
            httpGet:
              path: /actuator/health/startup
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

          # Graceful shutdown: wait for in-flight requests to complete
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]  # Allow readiness to propagate
          terminationGracePeriodSeconds: 60
```

## 6. Health Check Integration with Circuit Breakers

```java
/**
 * Expose circuit breaker states in health checks.
 * When a circuit breaker is OPEN, the service is degraded.
 * This surfaces to ops teams via the health endpoint.
 */
@Component("circuitBreakers")
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

## 7. Health Check Timeouts

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
            return future.get(500, TimeUnit.MILLISECONDS);
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

## 8. Graceful Shutdown Integration

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

## 9. Health Check Monitoring

```yaml
# Prometheus alert rules for health check failures

groups:
  - name: payment-health
    rules:
      - alert: PaymentServiceReadinessDown
        expr: |
          spring_boot_readiness_state{state="REFUSING_TRAFFIC"} > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Payment service pod is refusing traffic"
          description: "Pod {{ $labels.pod }} is refusing traffic for 2+ minutes"

      - alert: DatabaseHealthCheckFailing
        expr: |
          health_check_status{name="db"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Payment service cannot reach database"
          runbook: "https://wiki.example.com/runbooks/db-health"

      - alert: AllPaymentPodsUnhealthy
        expr: |
          sum(up{job="payment-service"}) == 0
        for: 30s
        labels:
          severity: critical
          page: "true"
        annotations:
          summary: "ALL payment service pods are unhealthy — service is down"
```

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment service pod's database becomes temporarily unavailable. Which Kubernetes probe should fail and what action will Kubernetes take?",
      "options": ["Liveness probe fails — Kubernetes kills and restarts the pod", "Readiness probe fails — Kubernetes removes the pod from the load balancer without restarting it", "Startup probe fails — Kubernetes prevents pod from starting", "Both liveness and readiness fail — Kubernetes kills the pod"],
      "correct": 1,
      "explanation": "Database unavailability means the pod cannot serve traffic but is otherwise healthy. The readiness probe should include database connectivity; it fails and Kubernetes removes the pod from the Service (stops routing traffic), but does NOT restart it. The pod recovers automatically when the database comes back."
    },
    {
      "text": "Why should external dependencies (database, Kafka) NOT be included in a liveness probe?",
      "options": ["They are too slow to query", "Including them causes unnecessary pod restarts when dependencies are temporarily unavailable", "Kubernetes cannot connect to external services", "Liveness probes only support TCP socket checks"],
      "correct": 1,
      "explanation": "If database or Kafka connectivity is in the liveness probe, every temporary dependency outage triggers a pod restart — which doesn't fix the problem and causes unnecessary disruption. These checks belong in readiness probes, which gracefully remove the pod from load balancing without restarting it."
    },
    {
      "text": "What is the purpose of the preStop lifecycle hook with a sleep in a Kubernetes pod spec?",
      "options": ["To run database migrations before shutdown", "To allow the readiness probe failure to propagate to the load balancer before the pod stops receiving traffic", "To back up in-memory state to disk", "To flush Kafka producer batches"],
      "correct": 1,
      "explanation": "When Kubernetes sends SIGTERM, it simultaneously removes the pod from the Service endpoints AND triggers preStop. The sleep gives time for the endpoint removal to propagate through kube-proxy to all load balancers before the application begins shutting down, preventing 'connection refused' errors on in-flight requests."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Comprehensive Health Check System for Payment Infrastructure",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Implement four HealthIndicators for: database (schema accessibility query), Kafka (broker connectivity + consumer lag threshold of 1000), Redis (write-read round-trip test), and payment gateway (HTTP ping with 3s timeout). Configure each for readiness only, not liveness."},
    {"id": "2", "description": "Configure Spring Boot Actuator health groups: liveness (livenessState only), readiness (readinessState + all four indicators), infrastructure (all indicators with full details). Write Kubernetes probe YAML with startup (5 min budget), liveness (30s period, 3 failures), and readiness (10s period, 2 successes to restore) probes."},
    {"id": "3", "description": "Build a CircuitBreakerHealthIndicator that returns DEGRADED (not DOWN) when any circuit breaker is OPEN, listing all circuit breaker names and states. Ensure this contributes to readiness but does NOT contribute to liveness."},
    {"id": "4", "description": "Implement graceful shutdown: on ContextClosedEvent, stop Kafka consumers first, then set readiness to REFUSING_TRAFFIC. Configure server.shutdown=graceful with 30s timeout-per-shutdown-phase and a preStop sleep of 15s in the pod spec."}
  ]
}
-->

