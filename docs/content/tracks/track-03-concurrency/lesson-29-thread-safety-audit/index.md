---
id: track-03-lesson-29
title: "Thread-Safety Audit — Class, Module and Application Level"
slug: thread-safety-audit
track: track-03
trackName: "Concurrency & Thread Safety Engineering"
sequence: 29
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [thread-safety, audit, shared-state, concurrent-design, review-checklist]
prerequisites: [track-03-lesson-02, track-03-lesson-07]
---

# Thread-Safety Audit — Class, Module and Application Level

Concurrency bugs are the most dangerous class of defect in fintech systems. They are latent, non-deterministic, and virtually invisible in unit tests. They surface under production load, often at the worst possible moment — during peak trading hours, end-of-day settlement, or a Black Friday payment surge. This lesson provides a systematic, practical audit framework operating at three levels of granularity: class, module/service, and application. Each level has its own failure modes, detection strategies, and remediation patterns.

---

## 1. Why Thread-Safety Audits Matter

### Concurrency Bugs Are Latent

A thread-safety bug can live in a codebase for months or years before it manifests. Unit tests run sequentially by default. Integration tests rarely simulate thousands of concurrent users hammering the same account. Code review catches style issues and logic errors, but a reviewer cannot mentally simulate the interleaving of fifty threads.

The classic conditions for a concurrency bug to surface:

- More than one thread accesses the same mutable object
- At least one thread writes to it
- No synchronization governs the access order

In development, your service handles ten requests per minute. The bug never fires. In production, it handles ten thousand requests per minute, and suddenly two threads read the same account balance at the same time, both decide the balance is sufficient, both debit it, and a customer ends up with a negative balance — or worse, a fraudster exploits the window to withdraw twice.

### Typical Fintech Incidents Caused by Thread-Safety Failures

*Composite examples, based on common industry failure patterns — not specific companies.*

**Balance corruption:** A payment gateway maintained a per-user balance cache in a `HashMap`. Two threads simultaneously called `updateBalance()` on the same user key. HashMap's internal resize operation is not thread-safe; during resize, the internal linked-list structure can form an infinite loop, causing CPU pinning and a service freeze. Even before resize, a lost update can silently zero out a balance increment.

**Duplicate transaction processing:** An order management system used a singleton `OrderProcessor` with an instance field `private Order currentOrder`. Under concurrent load, Thread A set `currentOrder = orderA`, then Thread B set `currentOrder = orderB`. Thread A then processed `orderB` using `orderA`'s data. The result: orderA was debited but never fulfilled; orderB was fulfilled but never debited.

**Lost updates in settlement:** A batch settlement job and an inbound payment handler both updated the same account ledger entry. The settlement job read the balance, the payment handler wrote a new balance, then the settlement job wrote its stale balance back — erasing the payment handler's update. The account appeared to receive a payment that was not reflected in its balance.

**Stale cache leading to limit bypass:** A fraud detection service cached per-user daily spending limits. A race condition between cache invalidation and limit checking allowed a user to exceed their daily limit by submitting rapid concurrent transactions, each of which read the cache before any single one triggered invalidation.

### The Audit as a First-Class Engineering Activity

Thread-safety audits should not be an afterthought. They should be:

- A formal gate in the code review checklist for any class that will be used in a concurrent context
- A recurring activity when onboarding new engineers to an existing service
- A mandatory step before any significant refactoring of shared infrastructure components
- Documented as part of the class or service contract (Javadoc `@GuardedBy`, `@ThreadSafe`, `@NotThreadSafe`)

The three levels of audit correspond to three distinct questions:

| Level | Question |
|---|---|
| Class | Is this individual class safe when accessed from multiple threads? |
| Module/Service | Is this service safe when the Spring container manages its lifecycle and multiple request threads share it? |
| Application | Is this system safe against races that span process boundaries — databases, caches, message brokers? |

---

## 2. Level 1: Class-Level Audit

The class-level audit examines a single Java class in isolation. The goal is to determine whether every public method can be called from multiple concurrent threads without producing incorrect results.

### Scenario: Shared Mutable State

**Identify all instance fields that are mutable.** Any instance field that is not `final` and not immutable is a candidate for a thread-safety problem if the class is used as a shared singleton.

**UNSAFE — Primitive counter in a singleton bean:**

```java
// UNSAFE: non-atomic increment in a shared singleton
@Component
public class TransactionCounter {

    // Multiple threads will read-modify-write this field concurrently.
    // The ++ operator is NOT atomic: it compiles to a read, an increment, and a write.
    // Under concurrent access, increments are silently lost.
    private int processedCount = 0;

    public void recordTransaction() {
        processedCount++; // RACE CONDITION: lost updates guaranteed under load
    }

    public int getProcessedCount() {
        return processedCount; // May return a stale or inconsistent value
    }
}
```

**SAFE — AtomicInteger:**

```java
// SAFE: AtomicInteger provides atomic read-modify-write operations
@Component
public class TransactionCounter {

    private final AtomicInteger processedCount = new AtomicInteger(0);

    public void recordTransaction() {
        processedCount.incrementAndGet(); // Atomic; no lost updates
    }

    public int getProcessedCount() {
        return processedCount.get(); // Always consistent
    }
}
```

**UNSAFE — HashMap as a balance cache in a singleton:**

```java
// UNSAFE: HashMap is not thread-safe. Concurrent puts can corrupt internal state.
// Even concurrent reads during a resize can cause infinite loops (Java 7 and below)
// or silent data loss (Java 8+).
@Component
public class BalanceCacheService {

    private final Map<String, BigDecimal> balanceCache = new HashMap<>();

    public BigDecimal getBalance(String accountId) {
        return balanceCache.get(accountId); // UNSAFE under concurrent access
    }

    public void updateBalance(String accountId, BigDecimal balance) {
        balanceCache.put(accountId, balance); // UNSAFE: can corrupt map structure
    }
}
```

**SAFE — ConcurrentHashMap:**

```java
// SAFE: ConcurrentHashMap uses segment-level locking (Java 7) or CAS operations
// (Java 8+) to allow safe concurrent reads and writes.
@Component
public class BalanceCacheService {

    private final ConcurrentMap<String, BigDecimal> balanceCache = new ConcurrentHashMap<>();

    public BigDecimal getBalance(String accountId) {
        return balanceCache.get(accountId); // Safe; no locking needed for reads
    }

    public void updateBalance(String accountId, BigDecimal balance) {
        balanceCache.put(accountId, balance); // Safe; atomic put
    }
}
```

### Scenario: Non-Atomic Compound Operations

A single atomic operation (like `ConcurrentHashMap.put`) is thread-safe by itself, but a sequence of two or more individually atomic operations is NOT guaranteed to be atomic as a whole. The gap between operations is a race window.

**UNSAFE — Check-then-act with a race window:**

```java
// UNSAFE: containsKey and get are individually safe on ConcurrentHashMap,
// but the check-then-act sequence is not atomic. Another thread can insert
// between containsKey and get, or remove between containsKey and get.
@Component
public class FeeScheduleCache {

    private final ConcurrentMap<String, BigDecimal> feeSchedule = new ConcurrentHashMap<>();

    public BigDecimal getFee(String productCode) {
        // RACE WINDOW: another thread could remove productCode between these two calls
        if (feeSchedule.containsKey(productCode)) {
            return feeSchedule.get(productCode); // May return null despite the check
        }
        return loadFeeFromDatabase(productCode);
    }
}
```

**SAFE — computeIfAbsent eliminates the race window:**

```java
@Component
public class FeeScheduleCache {

    // Cache FUTURES, not values: putIfAbsent is atomic, and the slow database
    // call runs OUTSIDE the map. (Calling the DB inside computeIfAbsent would
    // hold a map bin lock during I/O and block other keys in that bin.)
    private final ConcurrentMap<String, CompletableFuture<BigDecimal>> feeSchedule =
        new ConcurrentHashMap<>();

    public BigDecimal getFee(String productCode) {
        CompletableFuture<BigDecimal> fresh = new CompletableFuture<>();
        CompletableFuture<BigDecimal> existing = feeSchedule.putIfAbsent(productCode, fresh);
        if (existing != null) {
            return existing.join();          // another thread is loading / has loaded it
        }
        try {
            // We won the race: load exactly once per productCode
            BigDecimal fee = loadFeeFromDatabase(productCode);
            fresh.complete(fee);
            return fee;
        } catch (RuntimeException e) {
            feeSchedule.remove(productCode, fresh);   // allow a retry later
            fresh.completeExceptionally(e);
            throw e;
        }
    }

    private BigDecimal loadFeeFromDatabase(String productCode) {
        return feeRepository.findFeeByProductCode(productCode);
    }
}
```

**UNSAFE — Read-modify-write without synchronization:**

```java
// UNSAFE: reading balance and writing the updated balance is a compound operation.
// Thread A reads balance = 1000. Thread B reads balance = 1000. Thread A writes 900.
// Thread B writes 900. The first debit is silently lost. Balance should be 800.
public class AccountLedger {

    private BigDecimal balance = BigDecimal.ZERO;

    public void debit(BigDecimal amount) {
        // RACE CONDITION: read-modify-write is not atomic
        balance = balance.subtract(amount);
    }
}
```

**SAFE — AtomicReference with compareAndSet:**

```java
public class AccountLedger {

    private final AtomicReference<BigDecimal> balance =
        new AtomicReference<>(BigDecimal.ZERO);

    public void debit(BigDecimal amount) {
        // CAS loop: retry until we win the compare-and-swap
        BigDecimal current;
        BigDecimal updated;
        do {
            current = balance.get();
            updated = current.subtract(amount);
            if (updated.compareTo(BigDecimal.ZERO) < 0) {
                throw new InsufficientFundsException("Balance would go negative");
            }
        } while (!balance.compareAndSet(current, updated));
        // compareAndSet succeeds only if no other thread modified balance since we read it
    }

    public BigDecimal getBalance() {
        return balance.get();
    }
}
```

### Scenario: Unsafe Lazy Initialization

Lazy initialization of a singleton is a frequent source of thread-safety bugs. The classic double-checked locking pattern is broken without `volatile`.

**UNSAFE — Double-checked locking without volatile:**

```java
// UNSAFE: without volatile, the JVM may reorder the instructions inside the
// constructor. A partially initialized object can be assigned to 'instance'
// before its fields are fully written. A second thread can then read a
// non-null but corrupt 'instance'.
public class PaymentGatewayClient {

    private static PaymentGatewayClient instance; // MISSING volatile

    private final String apiKey;
    private final HttpClient httpClient;

    private PaymentGatewayClient() {
        this.apiKey = ConfigLoader.getApiKey();
        this.httpClient = HttpClient.newHttpClient(); // May not be visible to other threads
    }

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {                      // Check 1 (no lock)
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {              // Check 2 (with lock)
                    instance = new PaymentGatewayClient(); // UNSAFE: partial init visible
                }
            }
        }
        return instance; // May return partially constructed object
    }
}
```

**SAFE — Double-checked locking with volatile:**

```java
public class PaymentGatewayClient {

    // volatile ensures that the write to 'instance' happens-before any read of it.
    // This prevents the partial initialization visibility problem.
    private static volatile PaymentGatewayClient instance;

    private final String apiKey;
    private final HttpClient httpClient;

    private PaymentGatewayClient() {
        this.apiKey = ConfigLoader.getApiKey();
        this.httpClient = HttpClient.newHttpClient();
    }

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {
                    instance = new PaymentGatewayClient(); // Safe: volatile write
                }
            }
        }
        return instance;
    }
}
```

**BEST — Initialization-on-demand holder idiom (preferred):**

```java
// The JVM guarantees that the static initializer of a nested class runs
// exactly once, under the class initialization lock, the first time the
// class is used.
// This is simpler, safer, and performs as well as double-checked locking.
public class PaymentGatewayClient {

    private PaymentGatewayClient() {
        // private constructor
    }

    // The JVM loads this class only when getInstance() is first called.
    // Class loading is inherently thread-safe.
    private static final class Holder {
        static final PaymentGatewayClient INSTANCE = new PaymentGatewayClient();
    }

    public static PaymentGatewayClient getInstance() {
        return Holder.INSTANCE; // No synchronization needed here
    }
}
```

### Scenario: Mutable Object Returned from Getter

Returning a reference to an internal mutable collection from a getter leaks the internal state. Any caller can modify the collection without the class's knowledge, potentially while another thread is iterating it.

**UNSAFE — Returning live internal list:**

```java
@Component
public class PendingPaymentRegistry {

    // This list is the internal state of the registry
    private final List<Payment> pendingPayments = new ArrayList<>();

    public void register(Payment payment) {
        pendingPayments.add(payment);
    }

    // UNSAFE: caller receives a reference to the actual internal list.
    // Caller can call .clear(), .add(), .remove(), or iterate while
    // another thread is modifying it — causing ConcurrentModificationException
    // or silent data loss.
    public List<Payment> getPendingPayments() {
        return pendingPayments;
    }
}
```

**SAFE — Return an unmodifiable view or a defensive copy:**

```java
@Component
public class PendingPaymentRegistry {

    private final List<Payment> pendingPayments =
        Collections.synchronizedList(new ArrayList<>());

    public void register(Payment payment) {
        pendingPayments.add(payment);
    }

    // Option 1: unmodifiable view — prevents writes but still a live view
    // (callers must still synchronize on the list while iterating it)
    public List<Payment> getPendingPayments() {
        return Collections.unmodifiableList(pendingPayments);
    }

    // Option 2: defensive copy — snapshot at the time of the call (preferred for safety)
    public List<Payment> getPendingPaymentsSnapshot() {
        synchronized (pendingPayments) {
            return new ArrayList<>(pendingPayments);
        }
    }
}
```

### Scenario: `this` Escape in Constructor

Publishing the `this` reference before the constructor completes allows other threads to observe a partially constructed object.

**UNSAFE — `this` escape via listener registration:**

```java
// UNSAFE: registering 'this' in the constructor publishes the reference
// before the constructor finishes. If the EventBus delivers an event to
// onPaymentEvent() before the constructor sets this.processorId, the handler
// reads a null processorId.
public class PaymentEventHandler {

    private final String processorId;

    public PaymentEventHandler(EventBus bus) {
        bus.register(this); // 'this' escapes before processorId is set
        this.processorId = UUID.randomUUID().toString(); // Too late!
    }

    public void onPaymentEvent(PaymentEvent event) {
        // processorId may be null here if an event was delivered during construction
        log.info("Processor {} handling event {}", processorId, event.getId());
    }
}
```

**SAFE — Factory method pattern:**

```java
public class PaymentEventHandler {

    private final String processorId;
    private final EventBus bus;

    // Private constructor: does not publish 'this'
    private PaymentEventHandler(EventBus bus) {
        this.processorId = UUID.randomUUID().toString();
        this.bus = bus;
        // 'this' is NOT published here; all fields are fully initialized
    }

    // Factory method: registers only after the object is fully constructed
    public static PaymentEventHandler create(EventBus bus) {
        PaymentEventHandler handler = new PaymentEventHandler(bus);
        bus.register(handler); // Safe: handler is fully initialized
        return handler;
    }

    public void onPaymentEvent(PaymentEvent event) {
        log.info("Processor {} handling event {}", processorId, event.getId());
    }
}
```

### Class-Level Audit Checklist

- [ ] **Identify all non-final instance fields.** Each is a candidate for a thread-safety problem if the class is used as a shared singleton.
- [ ] **For each mutable field, check for atomic visibility.** Does every write happen-before every subsequent read? If not, `volatile` or synchronization is required.
- [ ] **For numeric counters, use AtomicInteger / AtomicLong.** Never use `++` or `+= N` on a plain `int` or `long` in a shared class.
- [ ] **For reference fields that are swapped, use `volatile` or `AtomicReference`.** A reference write is always atomic (only non-volatile `long`/`double` writes may be split), but without `volatile` other threads may not see it — and conditional swaps need CAS.
- [ ] **Replace HashMap/HashSet/ArrayList in singletons with thread-safe alternatives.** Use `ConcurrentHashMap`, `CopyOnWriteArrayList`, or synchronize explicitly.
- [ ] **Identify all compound operations (check-then-act, read-modify-write, iterate-and-modify).** Each must be executed as a single atomic operation or under a lock.
- [ ] **Audit all lazy initialization.** Use `volatile` double-checked locking or the holder idiom; never use plain double-checked locking.
- [ ] **Audit all getters that return mutable objects.** Return unmodifiable views or defensive copies instead of internal references.
- [ ] **Check all constructors for `this` escape.** If `this` must be published before the constructor completes, use a factory method instead.
- [ ] **Check for `synchronized` on wrong object.** `synchronized (this)` is correct only if callers also synchronize on the same instance; `synchronized` on a local variable is always a bug.
- [ ] **Annotate the class with `@ThreadSafe`, `@NotThreadSafe`, or `@Immutable`.** Make the thread-safety contract explicit in the Javadoc.
- [ ] **Verify that `@GuardedBy` annotations are present on every field that requires a lock.** Error Prone's `GuardedBy` check enforces them at compile time; SpotBugs flags inconsistent synchronization.

---

## 3. Level 2: Module / Service Level Audit

The module-level audit examines how a Spring-managed bean interacts with its lifecycle and with concurrent request threads. Spring creates one instance of each `@Service`, `@Component`, and `@Repository` bean and shares it across all request threads. Any instance field on these beans is shared state.

### Scenario: Stateful Spring Beans

**UNSAFE — Per-request state stored in an instance field:**

```java
// UNSAFE: Spring creates one instance of PaymentProcessingService.
// All request threads share this single instance.
// Thread A sets currentPayment = paymentA, then Thread B sets currentPayment = paymentB.
// Thread A then calls processCurrentPayment() and processes paymentB with paymentA's context.
// This is a classic data contamination bug.
@Service
public class PaymentProcessingService {

    // UNSAFE: this field is shared across all concurrent request threads
    private Payment currentPayment;
    private String currentCorrelationId;

    public PaymentResult process(Payment payment, String correlationId) {
        this.currentPayment = payment;              // Thread A writes paymentA
        this.currentCorrelationId = correlationId; // Thread B may overwrite before A reads

        validatePayment();     // Uses this.currentPayment — may be wrong thread's payment
        enrichPayment();       // Uses this.currentPayment — same problem
        return submitPayment(); // Uses this.currentPayment — submits wrong payment
    }

    private void validatePayment() {
        validator.validate(currentPayment); // Which thread's payment is this?
    }
}
```

**SAFE — Pass state as method parameters:**

```java
// SAFE: no instance fields hold per-request state.
// All state is passed explicitly through the call stack.
// Spring can safely share this instance across all threads.
@Service
public class PaymentProcessingService {

    // Only stateless collaborators as fields — these are themselves thread-safe
    private final PaymentValidator validator;
    private final PaymentEnricher enricher;
    private final PaymentGatewayClient gatewayClient;

    public PaymentProcessingService(PaymentValidator validator,
                                    PaymentEnricher enricher,
                                    PaymentGatewayClient gatewayClient) {
        this.validator = validator;
        this.enricher = enricher;
        this.gatewayClient = gatewayClient;
    }

    public PaymentResult process(Payment payment, String correlationId) {
        validatePayment(payment);           // payment is local to this invocation
        Payment enriched = enrichPayment(payment, correlationId);
        return submitPayment(enriched, correlationId);
    }

    private void validatePayment(Payment payment) {
        validator.validate(payment); // No shared state touched
    }
}
```

### Scenario: ThreadLocal Leaks

`ThreadLocal` is a legitimate tool for isolating per-thread state, but it must be cleaned up. In a thread-pool environment (which all application servers use), threads are reused across requests. A `ThreadLocal` value set during request N will still be present during request N+1 on the same thread.

**UNSAFE — ThreadLocal without cleanup:**

```java
// UNSAFE: if the thread is returned to the pool without cleanup,
// the next request on this thread will find the previous request's
// correlationId in the ThreadLocal — leading to logging under the wrong
// correlation ID or, worse, using stale state for business logic.
@Component
public class CorrelationContext {

    private static final ThreadLocal<String> CORRELATION_ID = new ThreadLocal<>();

    public void set(String correlationId) {
        CORRELATION_ID.set(correlationId);
    }

    public String get() {
        return CORRELATION_ID.get();
    }

    // remove() exists but is never called — LEAK
}
```

**SAFE — ThreadLocal with guaranteed cleanup in finally block:**

```java
@Component
public class CorrelationContext {

    private static final ThreadLocal<String> CORRELATION_ID = new ThreadLocal<>();

    public void set(String correlationId) {
        CORRELATION_ID.set(correlationId);
    }

    public String get() {
        return CORRELATION_ID.get();
    }

    public void clear() {
        CORRELATION_ID.remove(); // Must be called remove(), not set(null)
    }
}

// In a servlet filter or request interceptor:
@Component
public class CorrelationFilter implements Filter {

    private final CorrelationContext context;

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {

        String correlationId = UUID.randomUUID().toString();
        context.set(correlationId);
        try {
            chain.doFilter(req, res);
        } finally {
            context.clear(); // Always executed, even if the request throws
        }
    }
}
```

### Scenario: Shared Cache with Concurrent Invalidation

A cache read followed by a business-logic decision followed by a cache invalidation is a compound operation. Any of its parts can be interleaved with another thread's identical sequence.

**UNSAFE — Race between invalidation and read:**

```java
// UNSAFE: Thread A reads limit = 5000. Thread B also reads limit = 5000.
// Thread A processes payment of 4000 and invalidates cache (new limit = 1000).
// Thread B, having already read limit = 5000, also processes payment of 4000.
// Both pass the limit check. Combined spending = 8000, which exceeds the 5000 limit.
@Service
public class PaymentLimitService {

    private final Map<String, BigDecimal> limitCache = new ConcurrentHashMap<>();

    public boolean canProcess(String userId, BigDecimal amount) {
        BigDecimal currentLimit = limitCache.get(userId); // Read
        if (currentLimit == null) {
            currentLimit = loadLimitFromDb(userId);
            limitCache.put(userId, currentLimit);
        }
        return amount.compareTo(currentLimit) <= 0; // Check — RACE WINDOW BEFORE NEXT LINE
    }

    public void recordPayment(String userId, BigDecimal amount) {
        // Between canProcess and here, another thread may have also passed the check
        limitCache.remove(userId); // Invalidate — too late
    }
}
```

**SAFE — ReadWriteLock for coordinated cache access:**

```java
@Service
public class PaymentLimitService {

    // NOTE: a JVM lock protects ONE instance only. With several instances,
    // the remaining limit must be checked-and-reserved atomically in a shared
    // store (database conditional UPDATE or a Redis script — see Level 3)
    private final Map<String, BigDecimal> limitCache = new HashMap<>();
    private final ReadWriteLock lock = new ReentrantReadWriteLock();

    public boolean canProcessAndReserve(String userId, BigDecimal amount) {
        // Load OUTSIDE the lock — never hold a lock during a database call
        BigDecimal loaded = limitCache.containsKey(userId) ? null : loadLimitFromDb(userId);

        lock.writeLock().lock(); // Exclusive lock: no other thread can read or write
        try {
            BigDecimal currentLimit = limitCache.get(userId);
            if (currentLimit == null) {
                currentLimit = (loaded != null) ? loaded : loadLimitFromDb(userId);
                limitCache.put(userId, currentLimit);
            }
            if (amount.compareTo(currentLimit) > 0) {
                return false;
            }
            // Check and reserve happen under the same lock: no race window
            limitCache.put(userId, currentLimit.subtract(amount));
            return true;
        } finally {
            lock.writeLock().unlock();
        }
    }

    /** Remaining limit if cached, otherwise null (the caller loads it). */
    public BigDecimal getCurrentLimit(String userId) {
        lock.readLock().lock(); // Shared lock: multiple readers allowed concurrently
        try {
            return limitCache.get(userId);
        } finally {
            lock.readLock().unlock();
        }
    }

    public void invalidateLimit(String userId) {
        lock.writeLock().lock();
        try {
            limitCache.remove(userId);
        } finally {
            lock.writeLock().unlock();
        }
    }
}
```

### Scenario: Connection Pool Thread Safety

JDBC connections are stateful and not thread-safe. A connection holds transaction state, cursor position, and auto-commit settings. Sharing a single connection across threads corrupts all of these.

**UNSAFE — Shared connection instance:**

```java
// UNSAFE: one Connection shared across all threads.
// Thread A begins a transaction. Thread B commits it accidentally.
// Thread A's ResultSet is closed by Thread B's query.
// Thread safety contract of java.sql.Connection: "A Connection object is NOT thread-safe."
@Repository
public class PaymentRepository {

    // UNSAFE: single connection shared across all concurrent threads
    private final Connection sharedConnection;

    public PaymentRepository(DataSource dataSource) throws SQLException {
        this.sharedConnection = dataSource.getConnection(); // Never do this
    }

    public Payment findById(String id) throws SQLException {
        PreparedStatement ps = sharedConnection.prepareStatement(
            "SELECT * FROM payments WHERE id = ?"); // Shared state corruption
        ps.setString(1, id);
        return mapResult(ps.executeQuery());
    }
}
```

**SAFE — Connection obtained per operation from pool:**

```java
// SAFE: each operation acquires its own connection from the pool,
// uses it, and returns it. HikariCP and similar pools are designed for this.
@Repository
public class PaymentRepository {

    private final DataSource dataSource; // DataSource is thread-safe; Connection is not

    public PaymentRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public Payment findById(String id) throws SQLException {
        // try-with-resources ensures connection is returned to pool even on exception
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(
                 "SELECT * FROM payments WHERE id = ?")) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? mapResult(rs) : null;
            }
        }
    }
}
```

### Scenario: Async/Multi-Threaded Service Methods

Spring's `@Async` causes a method to run on a separate thread from the caller. If the async method accesses or modifies shared state, that state must be explicitly synchronized.

**UNSAFE — `@Async` method modifying shared state:**

```java
// UNSAFE: notificationsSent is a plain list in a singleton bean.
// @Async causes sendNotification() to run on a different thread.
// Multiple concurrent async calls all add to the same unsynchronized list.
@Service
public class NotificationService {

    private final List<String> notificationsSent = new ArrayList<>(); // UNSAFE

    @Async
    public void sendNotification(String userId, String message) {
        emailClient.send(userId, message);
        notificationsSent.add(userId); // ConcurrentModificationException or lost update
    }

    public List<String> getSentNotifications() {
        return notificationsSent; // Returns a live unsynchronized list
    }
}
```

**SAFE — Stateless async method, state stored in thread-safe structures:**

```java
@Service
public class NotificationService {

    // CopyOnWriteArrayList: thread-safe, good for read-heavy, infrequent-write patterns
    private final List<String> notificationsSent = new CopyOnWriteArrayList<>();

    @Async
    public void sendNotification(String userId, String message) {
        // All inputs arrive as parameters — no shared mutable state read here
        emailClient.send(userId, message);
        notificationsSent.add(userId); // Thread-safe add
    }

    public List<String> getSentNotifications() {
        return Collections.unmodifiableList(notificationsSent);
    }
}
```

### Module-Level Audit Checklist

- [ ] **Inspect every `@Service`, `@Component`, `@Repository`, and `@Controller` for mutable instance fields.** There should be none; all state must be passed through method parameters.
- [ ] **Verify that all collaborating beans injected into singletons are themselves thread-safe.** If a dependency is `@Scope("prototype")`, it is not safe to hold it as a singleton field.
- [ ] **Audit every `ThreadLocal` usage.** Confirm that `remove()` is called in a `finally` block at the end of every request lifecycle.
- [ ] **Identify every cache read-then-act sequence.** If the check and the act are not performed under the same lock, the sequence is a race condition.
- [ ] **Confirm that JDBC connections are never stored as instance fields or static fields.** Connections must be obtained per operation from a `DataSource`.
- [ ] **Audit all `@Async` methods.** They must be stateless (all state passed as parameters) or access only thread-safe shared state.
- [ ] **Check for `@Scope("session")` or `@Scope("request")` beans injected into singletons.** This requires scoped proxies (`@Scope(proxyMode = ScopedProxyMode.TARGET_CLASS)`) or the injection will silently share state.
- [ ] **Review all `static` fields.** Static fields are shared across all instances and all threads in the JVM. Each must be either immutable or explicitly synchronized.
- [ ] **Verify that prototype-scoped beans are obtained via `ApplicationContext.getBean()` or via `@Lookup` injection, not injected as a field.** A prototype bean injected as a field is instantiated once and shared — defeating its purpose.
- [ ] **Check all event listeners (`@EventListener`, `ApplicationListener`).** They run on the publisher's thread by default. Any shared state they access must be thread-safe.

---

## 4. Level 3: Application-Level Audit

Application-level races are the most dangerous because they cannot be fixed with Java synchronization primitives. They involve multiple JVM processes, database transactions, and distributed systems components. Java locks protect shared heap memory within a single JVM; they offer no protection against races that span process boundaries.

### Scenario: Database-Level Race Conditions (TOCTOU)

Time-of-check to time-of-use (TOCTOU) races are endemic in fintech. The classic pattern: check a condition in one SQL statement, then act on it in another. Between the two statements, another transaction changes the data.

**UNSAFE — SELECT then conditional UPDATE:**

```java
// UNSAFE: SELECT and UPDATE are two separate database round-trips.
// Between them, another transaction (from another application instance,
// another thread, or a background job) can modify the balance.
// Two concurrent threads both read balance = 1000, both pass the >= 500 check,
// both debit 500, resulting in balance = 0 instead of the correct rejection of the second.
@Service
public class FundsTransferService {

    @Transactional
    public void debit(String accountId, BigDecimal amount) {
        BigDecimal balance = accountRepository.findBalance(accountId); // SELECT
        if (balance.compareTo(amount) < 0) {
            throw new InsufficientFundsException();
        }
        // RACE WINDOW: another transaction can debit here before we do
        accountRepository.updateBalance(accountId, balance.subtract(amount)); // UPDATE
    }
}
```

**SAFE (simplest) — one conditional UPDATE:** `UPDATE accounts SET balance = balance - :amount WHERE id = :id AND balance >= :amount` — 0 rows updated means insufficient funds. The check and the change are one atomic statement.

**SAFE — SELECT FOR UPDATE (pessimistic locking):**

```java
@Service
public class FundsTransferService {

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void debit(String accountId, BigDecimal amount) {
        // SELECT FOR UPDATE acquires a row-level exclusive lock.
        // All other transactions attempting to SELECT FOR UPDATE on this row
        // will block until this transaction commits or rolls back.
        // This eliminates the TOCTOU race.
        Account account = accountRepository.findByIdForUpdate(accountId); // SELECT FOR UPDATE

        if (account.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException();
        }
        account.setBalance(account.getBalance().subtract(amount));
        accountRepository.save(account); // UPDATE within the same transaction
    }
}

// In the repository:
@Repository
public interface AccountRepository extends JpaRepository<Account, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT a FROM Account a WHERE a.id = :id")
    Optional<Account> findByIdForUpdate(@Param("id") String id);
}
```

**SAFE — Optimistic locking with `@Version`:**

```java
// Optimistic locking is better for low-contention scenarios.
// @Version adds a version column. Hibernate automatically appends
// WHERE version = :expectedVersion to every UPDATE.
// If the version has changed, the commit fails with Spring's
// ObjectOptimisticLockingFailureException.
@Entity
public class Account {

    @Id
    private String id;

    private BigDecimal balance;

    @Version
    private Long version; // Hibernate manages this automatically
}

// The RETRY must sit OUTSIDE the transaction: the conflict is detected at
// commit, and each attempt needs a fresh transaction that reloads the row.
// So put @Retryable on a different bean that calls the @Transactional one.
@Service
public class FundsTransferFacade {

    private final FundsTransferService service;

    @Retryable(retryFor = ObjectOptimisticLockingFailureException.class,
               maxAttempts = 3, backoff = @Backoff(delay = 20, multiplier = 2))
    public void debit(String accountId, BigDecimal amount) {
        service.debit(accountId, amount);   // new transaction per attempt
    }
}

@Service
public class FundsTransferService {

    @Transactional
    public void debit(String accountId, BigDecimal amount) {
        Account account = accountRepository.findById(accountId)
            .orElseThrow(AccountNotFoundException::new);

        if (account.getBalance().compareTo(amount) < 0) {
            throw new InsufficientFundsException();
        }
        account.setBalance(account.getBalance().subtract(amount));
        // Hibernate at commit: UPDATE accounts SET balance=?, version=version+1
        //                      WHERE id=? AND version=?
        // 0 rows updated → ObjectOptimisticLockingFailureException → facade retries
    }
}
```

### Scenario: Distributed Cache Inconsistency

When multiple application instances share a distributed cache (Redis, Memcached), a stale-read race can allow multiple instances to simultaneously conclude that the same action is safe to take.

**UNSAFE — Multiple instances, stale cache read:**

```java
// UNSAFE: Instance A reads daily_spend[userId] = 4500 from Redis.
// Instance B also reads daily_spend[userId] = 4500 from Redis.
// Instance A approves a 400-unit transaction (4500 + 400 = 4900 < 5000 limit).
// Instance B also approves a 400-unit transaction (4500 + 400 = 4900 < 5000 limit).
// Both write 4900 to Redis. The user has actually spent 5300, exceeding the 5000 limit.
@Service
public class DailySpendingLimitService {

    private final RedisTemplate<String, BigDecimal> redis;

    public boolean approveTransaction(String userId, BigDecimal amount) {
        BigDecimal dailySpend = redis.opsForValue().get("daily_spend:" + userId);
        BigDecimal limit = BigDecimal.valueOf(5000);
        if (dailySpend == null) dailySpend = BigDecimal.ZERO;

        if (dailySpend.add(amount).compareTo(limit) > 0) {
            return false; // TOCTOU: stale read; another instance may also be checking
        }
        redis.opsForValue().set("daily_spend:" + userId, dailySpend.add(amount));
        return true;
    }
}
```

**SAFE — one atomic check-and-add on the Redis server:**

Redis runs a Lua script as a single atomic step, so the check and the increment cannot interleave with another instance. Amounts are stored in integer minor units (cents), so `INCRBY` works. (A distributed lock around separate GET and SET would also work, but adds lock-expiry risks and an extra round-trip.)

```java
@Service
public class DailySpendingLimitService {

    private final StringRedisTemplate redis;

    // Returns the new total, or -1 if the limit would be exceeded
    private static final RedisScript<Long> CHECK_AND_ADD = RedisScript.of("""
        local spent  = tonumber(redis.call('GET', KEYS[1]) or '0')
        local amount = tonumber(ARGV[1])
        local limit  = tonumber(ARGV[2])
        if spent + amount > limit then
            return -1
        end
        local total = redis.call('INCRBY', KEYS[1], amount)
        if redis.call('TTL', KEYS[1]) < 0 then
            redis.call('EXPIRE', KEYS[1], ARGV[3])   -- reset after the day ends
        end
        return total
        """, Long.class);

    public boolean approveTransaction(String userId, long amountCents) {
        Long result = redis.execute(CHECK_AND_ADD,
            List.of("daily_spend:" + userId),
            String.valueOf(amountCents),
            String.valueOf(500_000L),          // limit: 5,000.00 in cents
            String.valueOf(secondsUntilMidnight()));
        return result != null && result >= 0;
        // If the payment later FAILS, release the amount (DECRBY) — the
        // reservation must not stay counted against the limit
    }
}
```

### Scenario: Kafka Consumer Parallelism

Kafka guarantees ordered delivery within a partition. If you process messages from the same partition in multiple threads concurrently, you break that ordering guarantee and introduce races on shared state keyed by the same entity.

**UNSAFE — Concurrent processing of the same partition:**

```java
// UNSAFE: a custom ExecutorService dispatches messages from the same partition
// to multiple threads. Two messages for account "ACC-123" may be processed
// concurrently, with the second message's debit applied before the first's credit.
// (It also commits offsets for messages that are still being processed.)
@Component
public class PaymentEventConsumer {

    private final ExecutorService executor = Executors.newFixedThreadPool(10);

    @KafkaListener(topics = "payment-events")
    public void onMessage(ConsumerRecord<String, PaymentEvent> record) {
        // UNSAFE: message for key "ACC-123" can be on this thread while another
        // "ACC-123" message is on a different thread in the pool
        executor.submit(() -> processEvent(record.value()));
    }
}
```

**SAFE — One thread per partition, sequential processing within partition:**

```java
// SAFE: Kafka's default behavior — one consumer thread per partition.
// All messages for a given account key are routed to the same partition
// (by key hash), so they are always processed sequentially.
// No external synchronization needed for per-account state.
@Component
public class PaymentEventConsumer {

    private final PaymentEventProcessor processor;

    @KafkaListener(
        topics = "payment-events",
        concurrency = "3" // 3 threads, each assigned its own partitions
    )
    public void onMessage(ConsumerRecord<String, PaymentEvent> record) {
        // This method is called sequentially within a partition.
        // Events for the same account key (routed to the same partition) are ordered.
        processor.processEvent(record.value());
    }
}
```

### Scenario: Scheduler + Application Server Conflict

A `@Scheduled` job and an HTTP request handler may both attempt to modify the same aggregate (e.g., a settlement batch) concurrently. Java locks cannot help here if the application runs on multiple nodes.

**UNSAFE — Scheduler and request handler conflict:**

```java
// UNSAFE: in a multi-instance deployment, all instances run the @Scheduled job.
// Two instances simultaneously run the settlement job. They both read the same
// unsettled payments. They both process them. Payments are settled twice.
@Service
public class SettlementService {

    @Scheduled(cron = "0 0 1 * * *") // 1 AM daily
    public void runDailySettlement() {
        List<Payment> unsettled = paymentRepository.findUnsettled();
        for (Payment p : unsettled) {
            settle(p); // Multiple instances execute this simultaneously
        }
    }
}
```

**SAFE — Distributed lock on the scheduler:**

```java
@Service
public class SettlementService {

    private final RedissonClient redisson;

    @Scheduled(cron = "0 0 1 * * *")
    public void runDailySettlement() {
        RLock lock = redisson.getLock("settlement_job_lock");
        // tryLock with 0 wait: if another instance already holds the lock, skip
        if (!lock.tryLock()) {
            log.info("Settlement job already running on another instance. Skipping.");
            return;
        }
        try {
            List<Payment> unsettled = paymentRepository.findUnsettled();
            for (Payment p : unsettled) {
                // Defence in depth: a distributed lock can be lost (network
                // partition, long GC pause). Make each settlement idempotent by
                // claiming the row: UPDATE payments SET status='SETTLING'
                // WHERE id=? AND status='UNSETTLED' — skip it if 0 rows
                settle(p);
            }
        } finally {
            lock.unlock();
        }
    }
}
```

### Scenario: Stateful HTTP Session Sharing

HTTP sessions can be accessed by two concurrent requests from the same user (browser tabs, parallel AJAX calls). Storing mutable business state in an `HttpSession` without synchronization is a thread-safety bug.

**UNSAFE — Concurrent session access without synchronization:**

```java
// UNSAFE: two concurrent AJAX calls from the same browser session both
// call this endpoint. Both read pendingAmount, both check it, both modify it.
// The result is unpredictable.
@RestController
public class CheckoutController {

    @PostMapping("/checkout/add-item")
    public ResponseEntity<Void> addItem(HttpSession session, @RequestBody Item item) {
        BigDecimal pendingAmount = (BigDecimal) session.getAttribute("pendingAmount");
        if (pendingAmount == null) pendingAmount = BigDecimal.ZERO;
        // RACE: another request may also be adding an item at the same time
        session.setAttribute("pendingAmount", pendingAmount.add(item.getPrice()));
        return ResponseEntity.ok().build();
    }
}
```

**SAFE — Stateless design with server-side cart stored in a database:**

```java
// SAFE: session stores only an immutable cart ID. All cart state lives in the
// database, protected by optimistic locking. No mutable state in the session.
@RestController
public class CheckoutController {

    private final CartService cartService;

    @PostMapping("/checkout/add-item")
    public ResponseEntity<Void> addItem(HttpSession session, @RequestBody Item item) {
        String cartId = (String) session.getAttribute("cartId");
        if (cartId == null) {
            cartId = cartService.createCart();
            session.setAttribute("cartId", cartId); // Immutable ID, safe to store
        }
        // Cart state is in the database; addItem uses optimistic locking (@Version)
        cartService.addItem(cartId, item);
        return ResponseEntity.ok().build();
    }
}
```

### Application-Level Audit Checklist

- [ ] **Identify every read-then-conditional-write sequence that spans two SQL statements.** Each must become one conditional `UPDATE`, or be protected by `SELECT FOR UPDATE` (pessimistic) or `@Version` (optimistic).
- [ ] **Audit every distributed cache read-then-act sequence.** Across multiple instances, use an atomic server-side operation (Lua script, `INCRBY`), a distributed lock, or an idempotency key mechanism.
- [ ] **Verify Kafka consumer concurrency settings.** Confirm that messages for the same entity key are routed to the same partition (consistent hashing by key) and processed by one thread per partition.
- [ ] **Audit all `@Scheduled` jobs.** In a multi-instance deployment, every job must acquire a distributed lock before executing or be deployed only to a dedicated scheduler node.
- [ ] **Review all uses of `HttpSession`.** Sessions should store only immutable identifiers (IDs), never mutable business objects.
- [ ] **Identify every write-after-read pattern that spans a network call.** Any read from a service, followed by a write to a different service, based on the read result, is a potential TOCTOU race.
- [ ] **Audit idempotency key handling.** Duplicate message delivery (Kafka at-least-once, HTTP retry) must be handled with idempotency keys stored in the database with a unique constraint.
- [ ] **Review event sourcing / outbox patterns.** The transactional outbox pattern must write the event and the state change in the same database transaction. Never update the database and publish to the broker as two separate steps of one business operation (the dual-write problem) — let a relay publish from the outbox.
- [ ] **Audit all long-running transactions.** Transactions held open for the duration of an HTTP request increase the TOCTOU window and the probability of deadlock.
- [ ] **Verify that optimistic lock retry logic has a bounded retry count and exponential backoff.** Unbounded retries under high contention can amplify the problem rather than resolving it.

---

## 5. The Thread-Safety Audit Process

A thread-safety audit is most effective when structured in phases, moving from automated detection to human review to empirical validation.

### Phase 1: Static Analysis

**SpotBugs with `@GuardedBy`:**

Annotate every field that requires a lock with `@GuardedBy` (from `net.jcip:jcip-annotations` or Error Prone's annotations). **Error Prone**'s `GuardedBy` check enforces it at compile time; **SpotBugs** detects inconsistent synchronization (`IS2_INCONSISTENT_SYNC`) — a field accessed sometimes with and sometimes without the lock:

```java
import net.jcip.annotations.GuardedBy;
import net.jcip.annotations.ThreadSafe;

@ThreadSafe
public class PaymentLedger {

    private final Object lock = new Object();

    @GuardedBy("lock")
    private BigDecimal balance = BigDecimal.ZERO;

    public void credit(BigDecimal amount) {
        synchronized (lock) {
            balance = balance.add(amount);
        }
    }
}
```

Error Prone will reject any access to `balance` that is not inside a `synchronized (lock)` block.

**SonarQube rules to enable:**

- `java:S2886` — Getters and setters should be synchronized in pairs
- `java:S3077` — Non-primitive fields should not be `volatile` (volatile does not make the object's contents thread-safe)
- `java:S2445` — Blocks should be synchronized on `private final` fields
- `java:S2222` — Locks should be released on all paths
- SpotBugs `IS2_INCONSISTENT_SYNC` (via the SpotBugs plugin) — field accessed both with and without synchronization

**Maven plugin configuration:**

```xml
<plugin>
  <groupId>com.github.spotbugs</groupId>
  <artifactId>spotbugs-maven-plugin</artifactId>
  <version>4.8.3.0</version>
  <configuration>
    <effort>Max</effort>
    <threshold>Low</threshold>
    <includeFilterFile>spotbugs-include.xml</includeFilterFile>
  </configuration>
  <executions>
    <execution>
      <goals><goal>check</goal></goals>
    </execution>
  </executions>
</plugin>
```

### Phase 2: Code Review Checklist Walkthrough

For every pull request touching a class used in a concurrent context, the reviewer should:

1. Run the class-level, module-level, and application-level checklists above against every changed file.
2. Ask: "If fifty threads called every public method of this class simultaneously, what would happen?"
3. Ask: "Does this method have any side effects on shared state?"
4. Ask: "Does this method assume any state that was set in a previous method call?"
5. Document findings and require fixes before merge.

### Phase 3: Load Testing with Concurrent Users

Static analysis and code review are necessary but not sufficient. Load testing under realistic concurrency is required to verify that no data corruption occurs.

```bash
# Gatling load test: 100 concurrent users, 60 seconds, targeting the payment endpoint
mvn gatling:test -Dgatling.simulationClass=PaymentLoadSimulation

# Verify post-test: check for balance inconsistencies, duplicate transactions,
# and negative balances in the test database
psql -d testdb -c "SELECT id, balance FROM accounts WHERE balance < 0;"
psql -d testdb -c "SELECT payment_id, COUNT(*) FROM settled_payments GROUP BY payment_id HAVING COUNT(*) > 1;"
```

### Phase 4: jcstress for Low-Level Concurrency Tests

[jcstress](https://github.com/openjdk/jcstress) is the OpenJDK harness for writing and running concurrency stress tests at the JVM level. It is particularly useful for testing custom synchronization mechanisms, `AtomicReference` CAS loops, and visibility guarantees.

```java
// Initial balance 50; two actors each try to debit 50 with a CAS loop.
// r1/r2 = 1 if that actor's debit succeeded, 0 if it was refused.
@JCStressTest
@Outcome(id = "1, 0", expect = ACCEPTABLE, desc = "Actor 1 debited, actor 2 refused")
@Outcome(id = "0, 1", expect = ACCEPTABLE, desc = "Actor 2 debited, actor 1 refused")
@Outcome(id = "1, 1", expect = FORBIDDEN,  desc = "Both debited — balance went negative")
@Outcome(id = "0, 0", expect = FORBIDDEN,  desc = "Both refused — a debit was lost")
@State
public class BalanceCasTest {

    final AtomicReference<BigDecimal> balance =
        new AtomicReference<>(BigDecimal.valueOf(50));

    private int tryDebit(BigDecimal amount) {
        BigDecimal cur, upd;
        do {
            cur = balance.get();
            upd = cur.subtract(amount);
            if (upd.signum() < 0) return 0;          // refuse: insufficient funds
        } while (!balance.compareAndSet(cur, upd));
        return 1;
    }

    @Actor
    public void actor1(II_Result r) {
        r.r1 = tryDebit(BigDecimal.valueOf(50));
    }

    @Actor
    public void actor2(II_Result r) {
        r.r2 = tryDebit(BigDecimal.valueOf(50));
    }
}
```

### Tools Summary

| Tool | Purpose | Integration Point |
|---|---|---|
| SpotBugs | Static detection of common concurrency bugs | Maven/Gradle build, CI pipeline |
| SonarQube | Continuous code quality including thread-safety rules | CI/CD gate |
| IntelliJ IDEA | Real-time inspections: synchronized on non-final field, ThreadLocal without remove | IDE |
| jcstress | Low-level JVM concurrency stress testing | Dedicated test suite |
| Gatling / k6 | Application-level load testing for data corruption | Pre-production pipeline |
| Redisson | Distributed locking for multi-instance coordination | Runtime library |

---

## 6. Quick Reference: Java Thread-Safety Primitives

Choosing the wrong primitive is as dangerous as using no synchronization at all. This table provides decision guidance.

| Primitive | Use When | Avoid When |
|---|---|---|
| `synchronized` | Simple mutual exclusion on a single object; short critical sections | Long-running operations (causes contention); no need for try-lock |
| `ReentrantLock` | Need `tryLock()`, `lockInterruptibly()`, or `Condition`; finer control | Simple cases where `synchronized` suffices |
| `AtomicInteger/Long` | Single numeric counter with increment/decrement/CAS | Coordinating updates across multiple related fields |
| `AtomicReference` | Single reference with CAS; building lock-free data structures | Coordinating multiple fields (use `synchronized` instead) |
| `volatile` | Single field visibility guarantee; flags and status fields | Compound operations (read-modify-write still needs CAS or lock) |
| `ConcurrentHashMap` | High-concurrency key-value store; individual operations must be atomic | Compound operations across multiple keys (need external lock) |
| `CopyOnWriteArrayList` | Read-heavy collections with infrequent writes | Write-heavy collections (copy on every write is expensive) |
| `ReadWriteLock` | Many readers, few writers; reading is cheap, writing is rare | Write-heavy workloads (readers block writers; writers block all) |
| Immutable objects | State that does not change after construction; value objects | Objects that must change frequently |
| `ThreadLocal` | Per-thread context (correlation ID, security context) | Business state that must be shared across threads |

---

## 7. Production Pitfalls

### Pitfall 1: Synchronizing on a Non-Final Field

```java
// UNSAFE: if 'lock' is reassigned between two synchronized blocks,
// the two synchronized blocks protect different monitor objects.
// No mutual exclusion is achieved.
public class PaymentProcessor {

    private Object lock = new Object(); // UNSAFE: non-final

    public void process(Payment p) {
        synchronized (lock) { // Uses lock@address1
            // ...
        }
    }

    public void reconfigure() {
        lock = new Object(); // Reassigns lock — now process() uses a different monitor
    }
}

// SAFE: lock is final; it is always the same object
public class PaymentProcessor {

    private final Object lock = new Object(); // SAFE: final, never reassigned

    public void process(Payment p) {
        synchronized (lock) {
            // ...
        }
    }
}
```

### Pitfall 2: Catching InterruptedException and Not Re-Interrupting

```java
// UNSAFE: swallowing InterruptedException prevents the thread pool from
// shutting down cleanly. The interrupted flag is cleared by catch; if the
// thread pool needs to stop, it will hang.
public void waitForSettlement() {
    try {
        settlementLatch.await();
    } catch (InterruptedException e) {
        log.warn("Interrupted while waiting"); // WRONG: flag is cleared, shutdown hangs
    }
}

// SAFE: re-interrupt the thread so callers can observe the interruption
public void waitForSettlement() {
    try {
        settlementLatch.await();
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt(); // Restore the interrupted flag
        throw new PaymentProcessingException("Settlement wait interrupted", e);
    }
}
```

### Pitfall 3: Using `size()` to Guard a Collection Operation

```java
// UNSAFE: even on a ConcurrentLinkedQueue, size() and poll() are two
// separate operations. The queue may become empty between the size() check
// and the poll() call. This is not a data corruption bug here, but it is
// a logic error that is symptomatic of incorrect reasoning about atomicity.
// In a ConcurrentHashMap, checking size() before putIfAbsent() is a classic
// race condition.
ConcurrentLinkedQueue<Payment> queue = new ConcurrentLinkedQueue<>();

if (queue.size() > 0) {           // Queue has elements... maybe
    Payment p = queue.poll();     // May return null if another thread emptied it
    processPayment(p);            // NullPointerException
}

// SAFE: use the return value of the atomic operation directly
Payment p = queue.poll();
if (p != null) {
    processPayment(p); // Safe: p is a local variable captured from the queue
}
```

### Pitfall 4: Calling `wait()` Outside a `while` Loop

```java
// UNSAFE: Java's Object.wait() can return spuriously (without notify being called).
// Using if() instead of while() means the spurious wake-up is treated as a
// legitimate signal. The balance may still be insufficient when processing begins.
public synchronized void processWhenFunded(BigDecimal required) throws InterruptedException {
    if (balance.compareTo(required) < 0) { // WRONG: use while
        wait(); // May wake up spuriously
    }
    // Balance may still be < required here — spurious wake-up was not a real signal
    debitBalance(required);
}

// SAFE: always loop on the condition in a while loop
public synchronized void processWhenFunded(BigDecimal required) throws InterruptedException {
    while (balance.compareTo(required) < 0) { // CORRECT: re-checks condition after every wake
        wait();
    }
    // Here, balance is guaranteed to be >= required
    debitBalance(required);
}
```

---

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A singleton Spring @Service bean has an instance field 'private List<Payment> pending = new ArrayList<>()'. Multiple request threads call methods on this bean concurrently. Which statement best describes the thread-safety risk?",
      "options": [
        "There is no risk because Spring manages the bean lifecycle and synchronizes access automatically.",
        "The risk is limited to ConcurrentModificationException during iteration, which can be suppressed with a try-catch.",
        "The ArrayList is shared across all concurrent request threads with no synchronization, exposing it to lost updates, ConcurrentModificationException, and silent data corruption.",
        "The risk exists only if the list exceeds its initial capacity and triggers a resize."
      ],
      "correct": 2,
      "explanation": "Spring creates one instance of a singleton bean and shares it across all request threads. ArrayList is not thread-safe; concurrent reads and writes can corrupt its internal array, lose updates, or throw ConcurrentModificationException during iteration. Spring provides no automatic synchronization of bean fields. The correct fix is to remove mutable instance state from singleton beans entirely or use a thread-safe collection such as CopyOnWriteArrayList."
    },
    {
      "text": "An account balance debit operation reads the current balance via SELECT, checks if it is sufficient, then executes an UPDATE in a separate SQL statement — all within a single @Transactional method with READ_COMMITTED isolation. A Java ReentrantLock is acquired at the start and released at the end of the method. Is this approach sufficient to prevent double-debit in a horizontally scaled multi-instance deployment?",
      "options": [
        "Yes. @Transactional with READ_COMMITTED and a ReentrantLock guarantee atomicity across all instances.",
        "Yes. READ_COMMITTED isolation prevents dirty reads, so no double-debit is possible.",
        "No. A ReentrantLock is JVM-local; it does not coordinate across separate application instances. A conditional UPDATE, SELECT FOR UPDATE, @Version, or a distributed lock is required.",
        "No. @Transactional must use SERIALIZABLE isolation to prevent this race; READ_COMMITTED is insufficient."
      ],
      "correct": 2,
      "explanation": "A ReentrantLock lives in the JVM heap of one process. In a multi-instance deployment, each instance has its own lock object; acquiring it in one JVM has no effect on the others. To prevent concurrent modification of the same row across instances, use: (1) a single conditional UPDATE (WHERE balance >= :amount), (2) SELECT FOR UPDATE to take a row lock within the transaction, (3) optimistic locking with @Version, or (4) a distributed lock. READ_COMMITTED isolation alone does not prevent this TOCTOU race."
    },
    {
      "text": "A developer uses the following double-checked locking pattern to lazily initialize a shared payment client: 'private static PaymentClient instance; ... if (instance == null) { synchronized(...) { if (instance == null) { instance = new PaymentClient(); } } }'. What is the precise defect in this code?",
      "options": [
        "The outer null check is redundant; removing it would fix the issue.",
        "Without the volatile keyword on 'instance', the JVM may reorder instructions within the PaymentClient constructor, making a partially initialized object visible to threads that read 'instance' in the outer null check.",
        "The synchronized block must use a lock object separate from the class object to prevent deadlock.",
        "Double-checked locking is inherently broken in Java regardless of volatile and must be replaced with synchronized getInstance()."
      ],
      "correct": 1,
      "explanation": "Without volatile, the Java Memory Model permits the writes that initialize PaymentClient's fields to be reordered with the assignment to 'instance'. A thread reading 'instance' in the outer check can see a non-null reference to an object whose constructor writes are not yet visible — so non-final fields may hold null or zero. Declaring 'instance' volatile establishes happens-before: the constructor's writes are visible to any thread that reads the non-null reference. Alternatively, the initialization-on-demand holder idiom avoids volatile by relying on the JVM's class initialization lock."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Thread-Safety Audit Lab: Payment Processing Service",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {
      "id": "task-01",
      "description": "You are given a PaymentProcessingService singleton bean that has three instance fields: a HashMap<String, BigDecimal> for balance caching, a plain int counter for metrics, and a Payment field for per-request state. Perform a class-level audit: identify all thread-safety violations, classify each as shared mutable state, non-atomic compound operation, or mutable return value, and produce a refactored version of the class that eliminates all violations. Document each fix with a comment explaining the specific Java Memory Model guarantee it relies on."
    },
    {
      "id": "task-02",
      "description": "Implement a thread-safe PaymentLimitService that must: (1) cache per-user daily spending limits loaded from a database (load outside any lock or compute function), (2) atomically check whether a new transaction would exceed the limit and, if not, reserve the amount, (3) support concurrent cache invalidation when limits are reconfigured. Write the implementation using ReadWriteLock, then a second one using ConcurrentHashMap.compute() (with only fast, in-memory work inside compute). Write a jcstress test that verifies no limit is exceeded under concurrent actors all attempting to reserve amounts that sum to more than the limit. Finally, explain why both versions are only correct within one JVM."
    },
    {
      "id": "task-03",
      "description": "A settlement batch job runs via @Scheduled(cron = ...) and also exposes a manual trigger HTTP endpoint. The application runs on three instances. Implement a solution using Redisson distributed locks that ensures: (1) only one instance runs the job at any given time regardless of trigger source, (2) if the HTTP trigger fires while the scheduled job is running, it returns a 409 Conflict with a meaningful message rather than blocking, (3) the lock is always released even if the job throws a RuntimeException. Include a unit test that mocks Redisson and verifies the 409 path and the exception cleanup path."
    },
    {
      "id": "task-04",
      "description": "Conduct an application-level audit of the following scenario: a Kafka consumer processes AccountFundedEvent messages, and for each event, reads the account from the database, computes a referral bonus, and writes it back. Multiple consumer threads are active; the topic has 10 partitions; account IDs are used as the Kafka message key. Identify: (1) whether the current partition-key strategy is sufficient to prevent duplicate bonus crediting, (2) under what failure scenario (consumer crash, rebalance) a duplicate could still occur, and (3) implement an idempotency key mechanism using a processed_events table with a unique constraint on (account_id, event_id) that prevents duplicate bonuses even after redelivery."
    }
  ]
}
-->
