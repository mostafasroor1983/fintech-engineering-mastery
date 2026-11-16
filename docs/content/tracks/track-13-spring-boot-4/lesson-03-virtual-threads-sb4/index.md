---
id: "track-13-lesson-03"
title: "Virtual Thread Integration in Spring Boot 4"
track: "track-13"
track-name: "Spring Boot 4 for Senior Fintech Engineers"
sequence: 3
slug: "virtual-threads-sb4"
difficulty: "advanced"
estimated-minutes: 75
status: "published"
last-updated: "2026-11-12"
prerequisites: []
tags:
  - "virtual-threads"
  - "java-21"
  - "spring-boot-4"
  - "loom"
  - "tomcat"
  - "async"
components:
  mermaid: true
  prism: true
  knowledge-check: true
  practical-challenge: true
references:
  - "Spring Boot 4.0 Release Notes"
  - "JEP 444: Virtual Threads"
  - "JEP 453: Structured Concurrency"
---

## Overview

Virtual threads (Project Loom, finalized in Java 21 via JEP 444) change the fundamental cost model for I/O-bound concurrent Java applications. A platform thread consumes approximately 1 MB of OS stack memory and requires an OS context switch on blocking — meaning a service handling 10,000 concurrent requests needs 10,000 platform threads and 10 GB of stack memory, plus enormous scheduling overhead. A virtual thread is a JVM-managed construct scheduled on a small pool of carrier platform threads; a blocked virtual thread consumes only a few hundred bytes on the heap and yields its carrier thread for other work immediately.

Spring Boot 4 makes virtual thread adoption a one-line configuration change: `spring.threads.virtual.enabled=true`. This single property triggers auto-configuration that replaces the thread pool executors in four subsystems simultaneously: Tomcat's request handler executor, the default `@Async` task executor, the `@Scheduled` thread pool, and the `@EventListener` executor. For a payment processing service that makes multiple downstream I/O calls per request (gateway, fraud engine, ledger, FX rates), virtual threads eliminate the thread-pool sizing problem entirely.

The adoption is not entirely frictionless, however. The critical operational concern is **carrier thread pinning**: when a virtual thread executes a `synchronized` block or calls a native method, it pins to its carrier platform thread and cannot yield, defeating the entire benefit of virtual threads and potentially causing all carrier threads to be pinned simultaneously under load. Fintech codebases frequently accumulate `synchronized` usage in cryptographic libraries, connection pool code, and legacy compliance SDKs. This lesson teaches you to detect, diagnose, and fix pinning — and introduces `StructuredTaskScope` for the specific pattern of parallel fan-out that is ubiquitous in payment enrichment pipelines.

## Learning Objectives

- Understand what virtual threads are, how the JVM schedules them, and why they eliminate the thread-pool sizing problem for I/O-bound services
- Configure `spring.threads.virtual.enabled=true` and understand all four subsystems it reconfigures
- Explain what carrier thread pinning is, why `synchronized` causes it, and how to detect it with `-Djdk.tracePinnedThreads=full`
- Replace `synchronized` with `ReentrantLock` to eliminate pinning in a payment crypto library
- Use `StructuredTaskScope.ShutdownOnFailure` for parallel payment enrichment with timeout and cancellation
- Replace `ThreadLocal` with `ScopedValue` for passing request context in a virtual thread environment
- Write an integration test that verifies virtual thread usage in a Spring Boot 4 controller

## SB4 Virtual Thread Auto-Configuration

When `spring.threads.virtual.enabled=true` is set, Spring Boot 4 activates four auto-configuration customizers. Each is in its own `@ConditionalOnProperty`-gated bean, so they activate independently and can be overridden individually.

```yaml
# application.yml
spring:
  threads:
    virtual:
      enabled: true
```

**Tomcat** — `TomcatVirtualThreadsWebServerFactoryCustomizer` replaces the NIO thread pool with a virtual-thread-per-request executor:

```java
// Spring Boot 4 source (simplified) — TomcatVirtualThreadsWebServerFactoryCustomizer
@Bean
@ConditionalOnProperty(value = "spring.threads.virtual.enabled", havingValue = "true")
@ConditionalOnClass(Tomcat.class)
public TomcatProtocolHandlerCustomizer<?> virtualThreadTomcatProtocolHandlerCustomizer() {
    return protocolHandler ->
            protocolHandler.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
}
```

Each incoming HTTP request is now handled on its own virtual thread. The accept threads (the threads that accept TCP connections from the OS) remain platform threads — they are not virtual. `server.tomcat.threads.max` is ignored when virtual threads are active.

**`@Async`** — `TaskExecutionAutoConfiguration` registers a `VirtualThreadTaskExecutor` as the default `ApplicationTaskExecutor`:

```java
// Spring Boot 4 source (simplified) — TaskExecutionVirtualThreadsAutoConfiguration
@Bean(name = APPLICATION_TASK_EXECUTOR_BEAN_NAME)
@ConditionalOnMissingBean(Executor.class)
@ConditionalOnProperty(value = "spring.threads.virtual.enabled", havingValue = "true")
public VirtualThreadTaskExecutor applicationTaskExecutor() {
    return new VirtualThreadTaskExecutor("app-");
}
```

This means `@Async` methods run on virtual threads automatically. Any existing `ThreadPoolTaskExecutor` bean named `taskExecutor` will override this — review for conflicts during migration.

**`@Scheduled`** — `TaskSchedulingAutoConfiguration` registers a `VirtualThreadTaskScheduler`:

```java
// SB4 simplified
@Bean
@ConditionalOnMissingBean({ TaskScheduler.class, ScheduledExecutorService.class })
@ConditionalOnProperty(value = "spring.threads.virtual.enabled", havingValue = "true")
public ThreadPoolTaskScheduler taskScheduler() {
    var scheduler = new VirtualThreadTaskScheduler();
    scheduler.setThreadNamePrefix("scheduling-");
    return scheduler;
}
```

**`@EventListener`** — `ApplicationEventMulticasterConfiguration` reconfigures the event multicaster:

```java
// SB4 simplified
@Bean(name = APPLICATION_EVENT_MULTICASTER_BEAN_NAME)
@ConditionalOnProperty(value = "spring.threads.virtual.enabled", havingValue = "true")
public ApplicationEventMulticaster applicationEventMulticaster() {
    var multicaster = new SimpleApplicationEventMulticaster();
    multicaster.setTaskExecutor(new VirtualThreadTaskExecutor("event-"));
    return multicaster;
}
```

The resulting architecture under virtual threads:

```mermaid
flowchart TD
    subgraph IncomingRequest["HTTP Request Handling"]
        AC[Accept Thread\nplatform - fixed pool] -->|TCP accept| VT1[Virtual Thread 1\nrequest handler]
        AC -->|TCP accept| VT2[Virtual Thread 2\nrequest handler]
        AC -->|TCP accept| VTN[Virtual Thread N\nrequest handler]
    end

    subgraph CarrierThreads["JVM Carrier Thread Pool\n(size = CPU cores, e.g. 8)"]
        CT1[Carrier Thread 1]
        CT2[Carrier Thread 2]
        CT3[Carrier Thread 3]
        CT8[Carrier Thread 8]
    end

    subgraph IOBlocking["I/O Operations\nvirtual thread yields carrier"]
        DB[(PostgreSQL)]
        GW[Payment Gateway]
        KF[Kafka]
        RD[(Redis)]
    end

    VT1 -.->|mounted| CT1
    VT2 -.->|mounted| CT2
    VTN -.->|mounted| CT3

    VT1 -->|blocks on I/O - unmounts from CT1| DB
    VT2 -->|blocks on I/O - unmounts from CT2| GW
    VTN -->|blocks on I/O - unmounts from CT3| KF

    CT1 -.->|now free - mounts another VT| VTN

    style CarrierThreads fill:#fef3c7,stroke:#f59e0b
    style IncomingRequest fill:#f0fdf4,stroke:#22c55e
    style IOBlocking fill:#eff6ff,stroke:#3b82f6
```

## Carrier Thread Pinning: Detection and Diagnosis

Carrier thread pinning occurs when a virtual thread cannot be unmounted from its carrier thread. Two causes:

1. **`synchronized` block or method**: the JVM's current implementation (Java 21-23) pins the virtual thread to its carrier while inside any `synchronized` block. Java 24+ has a fix in progress (JEP 491) but SB4's Java 21 baseline means you must handle this manually.
2. **Native method call**: calling into native code via JNI pins the thread for the duration of the call.

In a payment service, pinning is dangerous because a small number of carrier threads (default: `Runtime.getRuntime().availableProcessors()`) can all be pinned simultaneously, causing the entire service to stall while thousands of virtual threads are queued waiting for a carrier.

**Detecting pinning at development time:**

```bash
# Start the payment service with pinning diagnostics enabled
java -Djdk.tracePinnedThreads=full \
     -jar payment-service.jar

# Output when pinning occurs (truncated for readability):
# Thread[#47,ForkJoinPool-1-worker-1,5,CarrierThreads]
#     com.acme.payments.crypto.LegacyHsmSigner.sign(LegacyHsmSigner.java:83)   <== synchronized method
#         com.acme.payments.service.PaymentSigningService.signPayment(PaymentSigningService.java:51)
#         com.acme.payments.service.PaymentProcessingService.initiatePayment(PaymentProcessingService.java:112)
```

**Detecting pinning at runtime with JVM flight recorder:**

```bash
# Record a 60-second JFR snapshot while running load test
java -XX:StartFlightRecording=duration=60s,filename=payment-service.jfr \
     -jar payment-service.jar

# Analyze with JDK Mission Control or jfr command:
jfr print --events jdk.VirtualThreadPinned payment-service.jfr
```

## Fixing Pinning: `ReentrantLock` vs `synchronized`

The fix for `synchronized`-caused pinning is to replace `synchronized` with `java.util.concurrent.locks.ReentrantLock`. `ReentrantLock.lock()` and `unlock()` are park/unpark operations that the JVM implements without pinning — the virtual thread unmounts while waiting for the lock.

```java
package com.acme.payments.crypto;

import java.security.PrivateKey;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Legacy HSM signing bridge — originally used synchronized to protect
 * the HSM session handle from concurrent access.
 *
 * BEFORE (causes carrier thread pinning with virtual threads):
 */
public class LegacyHsmSignerBefore {

    private final PrivateKey signingKey;

    public LegacyHsmSignerBefore(PrivateKey signingKey) {
        this.signingKey = signingKey;
    }

    // synchronized method pins the carrier thread for the entire HSM operation
    // Under virtual threads with 100 concurrent payment signings and 8 carrier threads,
    // all 8 carriers can be pinned waiting for HSM access.
    public synchronized byte[] sign(byte[] payload) {
        // HSM I/O — this blocks for 50-200ms in production
        return performHsmSign(signingKey, payload);
    }

    private byte[] performHsmSign(PrivateKey key, byte[] data) {
        // ... HSM library call (native or blocking I/O)
        return new byte[0]; // placeholder
    }
}

/**
 * AFTER: ReentrantLock eliminates carrier thread pinning.
 * Virtual threads waiting for the lock unmount from their carrier thread,
 * allowing other virtual threads to run.
 */
public class LegacyHsmSigner {

    private final PrivateKey signingKey;
    // ReentrantLock.lock() does NOT pin the carrier thread
    private final ReentrantLock hsmLock = new ReentrantLock();

    public LegacyHsmSigner(PrivateKey signingKey) {
        this.signingKey = signingKey;
    }

    public byte[] sign(byte[] payload) {
        hsmLock.lock();
        try {
            // Virtual thread is mounted for the duration of this critical section.
            // If the HSM call itself blocks internally (e.g., via a socket),
            // the virtual thread will pin only if the socket operation uses
            // a synchronized native call. For pure Java I/O it unmounts fine.
            return performHsmSign(signingKey, payload);
        } finally {
            hsmLock.unlock();
        }
    }

    private byte[] performHsmSign(PrivateKey key, byte[] data) {
        // HSM library call
        return new byte[0]; // placeholder
    }
}
```

If you cannot modify the third-party library's source, run its calls on a dedicated platform thread pool to quarantine the pinning:

```java
package com.acme.payments.crypto;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Wraps a pinning legacy crypto library in a fixed platform thread pool.
 * Virtual threads submit work here and block (without pinning) while the
 * platform thread executes the synchronized library code.
 *
 * Pool size should be set to the HSM's maximum concurrent session count.
 */
public class PinningLibraryWrapper {

    // Platform thread pool — deliberately NOT virtual threads
    private final ExecutorService hsmPlatformPool =
            Executors.newFixedThreadPool(10, Thread.ofPlatform()
                    .name("hsm-platform-", 0)
                    .factory());

    private final LegacyHsmSignerBefore legacySigner; // the pinning library

    public PinningLibraryWrapper(LegacyHsmSignerBefore legacySigner) {
        this.legacySigner = legacySigner;
    }

    /**
     * The calling virtual thread blocks here, but it does NOT pin its carrier.
     * It parks (unmounts) while the platform thread in hsmPlatformPool runs
     * the synchronized legacySigner.sign() call.
     */
    public byte[] sign(byte[] payload) throws Exception {
        return hsmPlatformPool.submit(() -> legacySigner.sign(payload)).get();
    }
}
```

## Structured Concurrency: Parallel Payment Enrichment

`StructuredTaskScope` (JEP 453, preview in Java 21, standard in Java 23+) provides a safe concurrency API for fan-out/fan-in patterns. Rather than submitting to an executor and manually managing `Future` lifecycles, you open a `StructuredTaskScope` block, fork tasks within it, and join — the scope guarantees all forked tasks are completed or cancelled before the join returns.

The `ShutdownOnFailure` policy cancels all remaining subtasks if any one fails. This is the correct policy for payment enrichment: if the fraud score lookup fails, there is no point in waiting for the FX rate.

```java
package com.acme.payments.service;

import com.acme.payments.fraud.FraudScore;
import com.acme.payments.fraud.FraudScoringClient;
import com.acme.payments.fx.ExchangeRate;
import com.acme.payments.fx.FxRateClient;
import com.acme.payments.ledger.AccountInfo;
import com.acme.payments.ledger.LedgerClient;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.StructuredTaskScope;

/**
 * Enriches a payment with data from three upstream services in parallel.
 *
 * Uses StructuredTaskScope.ShutdownOnFailure:
 *   - If any enrichment fails, the scope shuts down and remaining subtasks are cancelled
 *   - The overall timeout is 2 seconds — if any subtask doesn't complete, all are cancelled
 *   - ScopedValue propagates the request correlation ID to all subtasks without ThreadLocal
 */
@Service
public class PaymentEnrichmentService {

    // ScopedValue replaces ThreadLocal for context propagation in virtual thread environments
    public static final ScopedValue<String> CORRELATION_ID = ScopedValue.newInstance();

    private final FraudScoringClient fraudClient;
    private final FxRateClient fxRateClient;
    private final LedgerClient ledgerClient;

    public PaymentEnrichmentService(
            FraudScoringClient fraudClient,
            FxRateClient fxRateClient,
            LedgerClient ledgerClient) {
        this.fraudClient = fraudClient;
        this.fxRateClient = fxRateClient;
        this.ledgerClient = ledgerClient;
    }

    /**
     * Enriches a payment by concurrently fetching fraud score, FX rate, and account info.
     * All three calls happen in parallel. The first failure cancels the others.
     * Total timeout: 2 seconds.
     *
     * @param paymentId       the payment being enriched
     * @param sourceAccountId the account making the payment
     * @param fromCurrency    source currency for FX lookup
     * @param toCurrency      target currency for FX lookup
     * @param correlationId   request correlation ID, propagated via ScopedValue
     * @return enriched payment data
     */
    public EnrichedPayment enrich(
            UUID paymentId,
            UUID sourceAccountId,
            String fromCurrency,
            String toCurrency,
            String correlationId
    ) throws InterruptedException {

        // ScopedValue.where() binds the value for the scope of the runWhere lambda.
        // All forked subtasks inherit the binding — they read CORRELATION_ID.get()
        // and get the same correlationId without any ThreadLocal propagation.
        return ScopedValue.where(CORRELATION_ID, correlationId).call(() -> {
            try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {

                // Fork all three enrichment calls concurrently
                StructuredTaskScope.Subtask<FraudScore> fraudSubtask =
                        scope.fork(() -> fetchFraudScore(paymentId, sourceAccountId));

                StructuredTaskScope.Subtask<ExchangeRate> fxSubtask =
                        scope.fork(() -> fetchExchangeRate(fromCurrency, toCurrency));

                StructuredTaskScope.Subtask<AccountInfo> accountSubtask =
                        scope.fork(() -> fetchAccountInfo(sourceAccountId));

                // Wait for all subtasks, with a 2-second deadline
                scope.joinUntil(Instant.now().plus(Duration.ofSeconds(2)));

                // throwIfFailed() rethrows the first exception from any subtask.
                // If joinUntil timed out, throws TimeoutException.
                scope.throwIfFailed();

                // All subtasks completed successfully — assemble the enriched payment
                return new EnrichedPayment(
                        paymentId,
                        fraudSubtask.get(),
                        fxSubtask.get(),
                        accountSubtask.get()
                );

            } catch (java.util.concurrent.TimeoutException e) {
                throw new PaymentEnrichmentTimeoutException(
                        "Payment enrichment timed out for payment " + paymentId, e);
            } catch (Exception e) {
                throw new PaymentEnrichmentException(
                        "Payment enrichment failed for payment " + paymentId, e);
            }
        });
    }

    private FraudScore fetchFraudScore(UUID paymentId, UUID accountId) {
        // CORRELATION_ID.get() returns the value bound by ScopedValue.where() above.
        // This works across virtual thread boundaries — no ThreadLocal needed.
        String corrId = CORRELATION_ID.get();
        return fraudClient.score(paymentId, accountId, corrId);
    }

    private ExchangeRate fetchExchangeRate(String from, String to) {
        String corrId = CORRELATION_ID.get();
        return fxRateClient.getRate(from, to, corrId);
    }

    private AccountInfo fetchAccountInfo(UUID accountId) {
        String corrId = CORRELATION_ID.get();
        return ledgerClient.getAccount(accountId, corrId);
    }

    // ── Domain types ──────────────────────────────────────────────────────────

    public record EnrichedPayment(
            UUID paymentId,
            FraudScore fraudScore,
            ExchangeRate exchangeRate,
            AccountInfo accountInfo
    ) {}

    public static class PaymentEnrichmentTimeoutException extends RuntimeException {
        public PaymentEnrichmentTimeoutException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public static class PaymentEnrichmentException extends RuntimeException {
        public PaymentEnrichmentException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
```

```java
// Supporting interfaces for the enrichment clients
package com.acme.payments.fraud;

import java.util.UUID;

public interface FraudScoringClient {
    FraudScore score(UUID paymentId, UUID accountId, String correlationId);
}

public record FraudScore(UUID paymentId, int score, boolean blocked, String reason) {}
```

```java
package com.acme.payments.fx;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public interface FxRateClient {
    ExchangeRate getRate(String fromCurrency, String toCurrency, String correlationId);
}

public record ExchangeRate(String from, String to, BigDecimal rate, Instant fetchedAt) {}
```

```java
package com.acme.payments.ledger;

import java.math.BigDecimal;
import java.util.UUID;

public interface LedgerClient {
    AccountInfo getAccount(UUID accountId, String correlationId);
}

public record AccountInfo(UUID accountId, String iban, BigDecimal availableBalance, String currency) {}
```

## `ScopedValue` vs `ThreadLocal` for Context Propagation

`ThreadLocal` is the traditional mechanism for passing request-scoped state (correlation IDs, security context, tenant context) down a call stack without threading it through every method signature. Under virtual threads, `ThreadLocal` works but has two problems:

1. **Inheritance cost**: `InheritableThreadLocal` copies values to child threads at fork time. With `StructuredTaskScope` forking hundreds of virtual threads, this copying can be expensive.
2. **Lifecycle risk**: `ThreadLocal` values must be manually removed to prevent memory leaks and cross-request contamination. Virtual threads can be pooled internally by the JVM, so leaked `ThreadLocal` values can appear in unrelated requests.

`ScopedValue` (JEP 446, finalized in Java 21) is an immutable, structured alternative. A `ScopedValue` is bound for the duration of a `ScopedValue.where(...).run(...)` or `.call(...)` block and is automatically unbound when the block exits. It is inherited by subtasks forked within a `StructuredTaskScope` without copying.

```java
package com.acme.payments.context;

import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * Servlet filter that binds request-scoped context via ScopedValue.
 * Replaces ThreadLocal-based RequestContextHolder for virtual thread safety.
 */
@Component
public class PaymentRequestContextFilter extends OncePerRequestFilter {

    // Static ScopedValue declarations — these are shared constants, not instances per request
    public static final ScopedValue<String> CORRELATION_ID = ScopedValue.newInstance();
    public static final ScopedValue<String> TENANT_ID = ScopedValue.newInstance();
    public static final ScopedValue<String> USER_ID = ScopedValue.newInstance();

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {

        String correlationId = request.getHeader("X-Correlation-Id");
        if (correlationId == null) correlationId = java.util.UUID.randomUUID().toString();

        String tenantId = request.getHeader("X-Tenant-Id");
        String userId = request.getHeader("X-User-Id");

        // Bind all three ScopedValues for the duration of this request's filter chain.
        // Any code — including code forked in StructuredTaskScope — can read these values.
        // They are automatically unbound when the lambda exits (request complete).
        try {
            ScopedValue.where(CORRELATION_ID, correlationId)
                    .where(TENANT_ID, tenantId != null ? tenantId : "default")
                    .where(USER_ID, userId != null ? userId : "anonymous")
                    .call(() -> {
                        filterChain.doFilter(request, response);
                        return null;
                    });
        } catch (Exception e) {
            if (e instanceof ServletException se) throw se;
            if (e instanceof IOException ioe) throw ioe;
            throw new ServletException(e);
        }
    }
}
```

```java
// Anywhere in the call stack (including subtasks in StructuredTaskScope):
public class SomeDeepService {

    public void process() {
        // No method parameter threading needed — just read the ScopedValue
        String correlationId = PaymentRequestContextFilter.CORRELATION_ID.get();
        String tenantId = PaymentRequestContextFilter.TENANT_ID.get();

        // ... use correlationId and tenantId
    }
}
```

## `@Async` with Virtual Threads: Before and After

Before virtual threads, `@Async` required a custom `ThreadPoolTaskExecutor` to control pool size and queue behavior. With `spring.threads.virtual.enabled=true`, the default executor is a `VirtualThreadTaskExecutor` and no custom pool configuration is needed for most cases.

```java
package com.acme.payments.notifications;

import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;

@Service
public class PaymentNotificationService {

    // ── BEFORE virtual threads (SB3 pattern) ─────────────────────────────────
    // Required a custom @Bean ThreadPoolTaskExecutor with tuned pool size/queue.
    // Pool sizing was a guessing game: too small → queuing lag; too large → memory waste.

    // ── AFTER virtual threads (SB4 pattern) ──────────────────────────────────
    // @Async uses VirtualThreadTaskExecutor automatically.
    // No pool size tuning needed — each invocation gets its own virtual thread.

    @Async
    public CompletableFuture<Void> sendPaymentConfirmation(UUID paymentId, String recipientEmail) {
        // This runs on a virtual thread. The SMTP call blocks but doesn't consume
        // a platform thread while waiting for the mail server response.
        sendEmail(recipientEmail, buildConfirmationEmail(paymentId));
        return CompletableFuture.completedFuture(null);
    }

    @Async
    public CompletableFuture<Void> sendWebhook(UUID paymentId, String webhookUrl) {
        // HTTP POST to external webhook URL — blocking but on virtual thread
        postWebhook(webhookUrl, buildWebhookPayload(paymentId));
        return CompletableFuture.completedFuture(null);
    }

    @Async
    public CompletableFuture<Void> auditLog(UUID paymentId, String eventType) {
        // DB write — blocking I/O on virtual thread
        writeAuditRecord(paymentId, eventType);
        return CompletableFuture.completedFuture(null);
    }

    private void sendEmail(String recipient, String body) { /* SMTP call */ }
    private void postWebhook(String url, String payload) { /* HTTP POST */ }
    private void writeAuditRecord(UUID paymentId, String type) { /* JDBC write */ }
    private String buildConfirmationEmail(UUID paymentId) { return ""; }
    private String buildWebhookPayload(UUID paymentId) { return ""; }
}
```

If you have an existing `ThreadPoolTaskExecutor` bean that must be retained for other uses, pin virtual threads only to `@Async` methods that use the default executor:

```java
@Configuration
@EnableAsync
public class AsyncConfig {

    // This bean is used by @Async methods that explicitly name it
    // e.g., @Async("hsmExecutor")
    @Bean("hsmExecutor")
    public Executor hsmExecutor() {
        // Platform threads for HSM operations that cannot be de-pinned
        var executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(5);
        executor.setMaxPoolSize(10);
        executor.setQueueCapacity(50);
        executor.setThreadNamePrefix("hsm-");
        executor.initialize();
        return executor;
    }

    // No default taskExecutor bean here — SB4 auto-configuration provides
    // VirtualThreadTaskExecutor when spring.threads.virtual.enabled=true
}
```

## Summary

- `spring.threads.virtual.enabled=true` reconfigures four Spring subsystems — Tomcat, `@Async`, `@Scheduled`, `@EventListener` — to use virtual threads. No other code changes are required for the basic switch.
- Carrier thread pinning from `synchronized` blocks is the primary operational risk. Use `-Djdk.tracePinnedThreads=full` in development and JFR `jdk.VirtualThreadPinned` events in production to detect it. Replace `synchronized` with `ReentrantLock`, or quarantine pinning libraries in a dedicated platform thread pool.
- `StructuredTaskScope.ShutdownOnFailure` is the correct API for parallel fan-out in payment enrichment. It provides structured cancellation, deadline enforcement, and clean error propagation without manual `Future` management.
- `ScopedValue` replaces `ThreadLocal` for request context propagation in virtual thread environments. It is immutable, automatically unbound when the scope exits, and inherited by `StructuredTaskScope` subtasks without copying overhead.
- `@Async` with virtual threads eliminates thread-pool sizing guesswork for I/O-bound async work. Retain named platform thread executors only for code that cannot be de-pinned (native calls, legacy `synchronized` libraries).

<!-- KNOWLEDGE-CHECK [
  {
    "id": "kc-vt301-01",
    "question": "A payment service enables spring.threads.virtual.enabled=true. Under high load, the service becomes unresponsive even though CPU is idle and there are thousands of pending virtual threads. JVM thread dump shows all carrier threads are in TIMED_WAITING state inside org.bouncycastle.crypto.engines.AESEngine.processBlock(). What is the most likely cause and fix?",
    "options": [
      "The JVM's virtual thread scheduler is misconfigured — increase jdk.virtualThreadScheduler.parallelism system property",
      "BouncyCastle uses synchronized methods that pin carrier threads; replace synchronized with ReentrantLock or quarantine BouncyCastle calls in a platform thread pool",
      "Virtual threads cannot perform cryptographic operations — use @Async with a ThreadPoolTaskExecutor for all crypto calls",
      "The connection pool for the downstream database is exhausted — increase spring.datasource.hikari.maximum-pool-size"
    ],
    "correct": 1,
    "explanation": "BouncyCastle (and many crypto libraries) use synchronized methods internally, which pin virtual threads to their carrier threads on Java 21. When all carrier threads are pinned, no other virtual thread can run, causing service stall. The fix is to either replace synchronized with ReentrantLock in the library (if source is available) or run all BouncyCastle calls in a dedicated fixed platform thread pool so the pinning is quarantined. Increasing parallelism adds more carrier threads but doesn't fix the root cause."
  },
  {
    "id": "kc-vt301-02",
    "question": "A PaymentEnrichmentService uses StructuredTaskScope.ShutdownOnFailure to concurrently call fraud scoring, FX rates, and account info services with a 2-second deadline. The fraud scoring service returns a 503 after 500ms. What happens to the FX rate and account info subtasks?",
    "options": [
      "They continue running until they complete or timeout individually",
      "They are cancelled immediately when ShutdownOnFailure detects the fraud subtask failure",
      "They throw CancellationException which must be caught in each subtask's callable",
      "scope.throwIfFailed() waits for them to complete before rethrowing the fraud exception"
    ],
    "correct": 1,
    "explanation": "ShutdownOnFailure's policy is to shut down the scope (cancel all remaining subtasks) as soon as any subtask fails. When the fraud scoring subtask throws an exception due to the 503, the scope initiates shutdown: the FX rate and account info subtasks receive a cancellation interrupt and stop. scope.throwIfFailed() then rethrows the first subtask exception. The subtasks do not need to catch CancellationException — the scope handles cancellation internally."
  },
  {
    "id": "kc-vt301-03",
    "question": "A team is migrating from ThreadLocal-based correlation ID propagation to ScopedValue for virtual thread safety. Which statement correctly describes how ScopedValue propagates to subtasks forked in a StructuredTaskScope?",
    "options": [
      "ScopedValues must be explicitly re-bound in each subtask's lambda using ScopedValue.where()",
      "ScopedValues bound in the parent scope are automatically inherited by all subtasks forked within that scope without copying",
      "ScopedValues are thread-local by default and must be converted to InheritableScopedValue for subtask inheritance",
      "StructuredTaskScope propagates ScopedValues only if they are declared as static final in the same class"
    ],
    "correct": 1,
    "explanation": "ScopedValue bindings are automatically inherited by subtasks forked within a StructuredTaskScope that runs inside the ScopedValue.where(...).call() block. The subtask sees the same binding without any explicit re-binding or copying. This is a key advantage over InheritableThreadLocal, which copies all thread-local values on fork. The ScopedValue's visibility is purely structural (determined by the call stack), not by class declarations."
  },
  {
    "id": "kc-vt301-04",
    "question": "After enabling spring.threads.virtual.enabled=true, a team's existing @Async payment notification method now runs on virtual threads. However, they also have an @Async method annotated with @Async(\"hsmExecutor\") that must continue running on platform threads. What happens to the @Async(\"hsmExecutor\") method?",
    "options": [
      "It automatically switches to virtual threads because spring.threads.virtual.enabled=true overrides all executors",
      "It continues using the hsmExecutor platform thread pool because the named executor overrides the default VirtualThreadTaskExecutor",
      "It throws NoSuchBeanDefinitionException because SB4 removes support for named @Async executors",
      "It uses virtual threads internally within the hsmExecutor pool, which must be reconfigured to prevent this"
    ],
    "correct": 1,
    "explanation": "@Async methods that explicitly name an executor bean — @Async(\"hsmExecutor\") — always use that specific executor, regardless of the default. spring.threads.virtual.enabled=true only configures the DEFAULT executor (the APPLICATION_TASK_EXECUTOR_BEAN_NAME bean). The hsmExecutor ThreadPoolTaskExecutor continues to use platform threads exactly as configured. This is the recommended pattern for isolating pinning libraries."
  }
] -->

<!-- PRACTICAL-CHALLENGE {
  "id": "pc-vt3-01",
  "title": "Enable and Validate Virtual Threads in a Payment Service",
  "description": "Enable virtual threads in a Spring Boot 4 payment service, detect and fix a carrier thread pinning issue, and implement a parallel payment enrichment flow with StructuredTaskScope.",
  "tasks": [
    { "id": "pc-vt301-01", "description": "Enable spring.threads.virtual.enabled=true in a Spring Boot 4 payment service. Write an integration test using @SpringBootTest with MockMvc that sends 500 concurrent requests to POST /payments and asserts: (a) the HTTP response status is 202 for all requests, (b) the thread handling the request is a virtual thread (Thread.currentThread().isVirtual() == true, verified via a debug endpoint or test hook), and (c) the total time for 500 requests is under 10 seconds with a stubbed 20ms downstream delay per request." },
    { "id": "pc-vt301-02", "description": "Identify a synchronized method in the payment service's LegacyHsmSigner class. Run the service with -Djdk.tracePinnedThreads=full and trigger a pinning trace by calling the signing endpoint. Replace the synchronized method with ReentrantLock. Write a unit test that creates 100 virtual threads all calling sign() concurrently and verifies no deadlock or stall occurs within 5 seconds." },
    { "id": "pc-vt301-03", "description": "Implement the PaymentEnrichmentService using StructuredTaskScope.ShutdownOnFailure to call FraudScoringClient, FxRateClient, and LedgerClient in parallel with a 2-second deadline. Use ScopedValue for correlation ID propagation. Write a unit test with stubbed clients where FraudScoringClient sleeps 100ms, FxRateClient sleeps 150ms, and LedgerClient sleeps 200ms — assert that EnrichedPayment is returned in under 300ms (not 450ms sequentially). Write a second test where FraudScoringClient throws an exception and assert that PaymentEnrichmentException is thrown and the other two clients' subtasks were cancelled." }
  ]
} -->
