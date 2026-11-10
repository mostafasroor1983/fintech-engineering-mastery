---
id: track-03-lesson-22
sequence: 22
title: "Safe Publication and Object Construction"
slug: safe-publication
track: track-03
difficulty: advanced
estimatedMinutes: 65
status: published
tags: [safe-publication, final-fields, constructor-safety, JMM]
java-versions: [17, 21]
---

An object is "safely published" when every thread that can see the reference to it also sees the fully initialised state of its fields. Without safe publication, another thread can observe the object in a partially constructed state — with fields holding default zero/null values even though the constructor has "completed". This is one of the most subtle and dangerous aspects of the Java Memory Model.

## Learning Objectives

By the end of this lesson you will be able to:

- Explain why object construction and publication are not automatically atomic under the JMM
- Identify all four safe publication idioms and explain the JMM guarantee behind each
- Recognise the `this` escape anti-pattern and explain why it causes partially visible construction
- Apply `final` fields correctly and understand their special JMM guarantee
- Implement the double-checked locking singleton correctly with `volatile`
- Design thread-safe lazy initialisation using the initialisation-on-demand holder idiom

## Business Context

A payment configuration service loads fee schedules and routing rules at startup. Configuration objects are constructed once, then shared across hundreds of payment processing threads. If the configuration object is not safely published, a payment thread may observe `null` for a fee table that was set in the constructor — resulting in `NullPointerException` or, worse, silently applying zero fees. Understanding safe publication prevents this class of production incident.

## What Does "Published" Mean?

An object is **published** when a reference to it is made visible to code outside the scope in which it was constructed. Publication happens when you:
- Store the reference in a public field
- Return it from a method
- Pass it to another thread's method
- Store it in a shared collection

The danger: the JMM allows the JIT compiler and CPU hardware to reorder memory writes. The constructor's field writes may be reordered after the reference is published. A reading thread may see the reference before seeing the field values.

```
Constructing thread                 Reading thread
─────────────────                   ─────────────
new FeeSchedule()
  field1 = data1          ─────────────────────────────► ref = FeeSchedule@abc
  field2 = data2    (reordered)      thread reads ref → sees FeeSchedule@abc
  ...                                thread reads field2 → sees null  ← BUG
publish ref = FeeSchedule@abc
  field1 write flush                 thread reads field1 → sees data1
```

## Unsafe Publication: The Anti-Patterns

### Stale Reference via Non-Volatile Field

```java
public class ConfigCache {
    // No volatile — unsafe publication
    private FeeSchedule feeSchedule;

    // Thread 1: initialises at startup
    public void load() {
        feeSchedule = new FeeSchedule(loadFromDatabase());
    }

    // Thread 2: reads during payment processing
    public FeeSchedule get() {
        return feeSchedule;  // May see null, or a partially constructed object
    }
}
```

### The `this` Escape Anti-Pattern

Publishing `this` before the constructor completes allows other threads to observe a partially initialised object:

```java
public class PaymentEventPublisher {

    private final EventBus eventBus;
    private final String   serviceId;

    public PaymentEventPublisher(EventBus eventBus, String serviceId) {
        this.eventBus  = eventBus;
        this.serviceId = serviceId;

        // DANGER: registering this before constructor completes
        // Another thread could call onEvent() before serviceId is set
        eventBus.register(this);  // ← this escapes before construction is done
    }

    public void onEvent(PaymentEvent event) {
        // serviceId might be null here if called from another thread
        // before the constructor finished
        log.info("Service {} received event {}", serviceId, event);
    }
}
```

**Fix:** Register the listener after construction:

```java
public class PaymentEventPublisher {
    private final EventBus eventBus;
    private final String   serviceId;

    private PaymentEventPublisher(EventBus eventBus, String serviceId) {
        this.eventBus  = eventBus;
        this.serviceId = serviceId;
    }

    public static PaymentEventPublisher create(EventBus bus, String serviceId) {
        PaymentEventPublisher pub = new PaymentEventPublisher(bus, serviceId);
        bus.register(pub);  // Register after full construction
        return pub;
    }
}
```

## The Four Safe Publication Idioms

### 1. Static Initialiser

The JVM guarantees static initialisers complete before any thread can access the class. The class loader holds a lock during static initialisation:

```java
public class FeeScheduleCache {
    // Guaranteed fully constructed before any thread can see the reference
    private static final FeeSchedule DEFAULT_SCHEDULE = new FeeSchedule(DEFAULT_FEES);
}
```

**JMM guarantee:** Static field writes in a static initialiser happen-before any access to that static field. No `volatile` or `synchronized` needed.

### 2. `final` Fields

`final` fields have a special JMM guarantee: once a constructor completes, any thread that obtains a reference to the object is guaranteed to see all `final` fields as initialised — even without synchronisation:

```java
public final class PaymentRoute {
    private final String    routingCode;
    private final BigDecimal feePercent;
    private final List<String> allowedCurrencies;

    public PaymentRoute(String routingCode, BigDecimal feePercent,
                        List<String> allowedCurrencies) {
        this.routingCode       = routingCode;
        this.feePercent        = feePercent;
        // Defensive copy — the reference is final, not the contents
        this.allowedCurrencies = List.copyOf(allowedCurrencies);
    }

    // Getters — no synchronisation needed; all fields are final
    public String    getRoutingCode()       { return routingCode; }
    public BigDecimal getFeePercent()       { return feePercent; }
    public List<String> getAllowedCurrencies() { return allowedCurrencies; }
}
```

> [!IMPORTANT]
> The `final` field guarantee applies to the **reference** stored in the field, not to the object the reference points to. `private final List<String> codes` guarantees the `List` reference is visible, but the list's contents are only thread-safe if the list itself is immutable (use `List.copyOf()` or `Collections.unmodifiableList()`).

### 3. `volatile` Field

Publishing via a `volatile` field creates a happens-before edge: the write to `volatile` happens-before any read of that field:

```java
public class ConfigCache {
    private volatile FeeSchedule feeSchedule;  // volatile = safe publication

    // Thread 1 — startup
    public void load() {
        FeeSchedule loaded = new FeeSchedule(loadFromDatabase());
        feeSchedule = loaded;  // volatile write — all prior writes are visible
    }

    // Thread 2 — payment processing
    public FeeSchedule get() {
        return feeSchedule;  // volatile read — sees fully constructed object or null
    }
}
```

**JMM guarantee:** The `volatile` write to `feeSchedule` happens-before the `volatile` read. All writes done by Thread 1 before the `volatile` write (including the FeeSchedule constructor) are visible to Thread 2 after the `volatile` read.

### 4. Synchronised Block

Releasing a lock happens-before acquiring it. Publishing inside a `synchronized` block ensures all writes before the lock release are visible to any thread that subsequently acquires the same lock:

```java
public class ConfigCache {
    private FeeSchedule feeSchedule;

    public synchronized void load() {
        feeSchedule = new FeeSchedule(loadFromDatabase());
        // Lock release here — all prior writes are flushed
    }

    public synchronized FeeSchedule get() {
        // Lock acquisition here — sees all writes before prior releases
        return feeSchedule;
    }
}
```

## Double-Checked Locking: The Correct Pattern

A common optimisation for lazy singletons. Without `volatile`, this pattern is broken:

```java
// BROKEN — without volatile, the reference can be non-null but
// the object partially constructed (field writes reordered after publication)
public class PaymentGatewayClient {
    private static PaymentGatewayClient instance;  // Missing volatile!

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {
                    instance = new PaymentGatewayClient();  // Write can be reordered
                }
            }
        }
        return instance;  // May return partially constructed object
    }
}
```

**Correct pattern** — `volatile` prevents the assignment from being reordered before the constructor completes:

```java
public class PaymentGatewayClient {
    private static volatile PaymentGatewayClient instance;  // volatile is mandatory

    private final String    endpoint;
    private final SSLContext sslContext;

    private PaymentGatewayClient() {
        this.endpoint   = Config.getGatewayEndpoint();
        this.sslContext = Config.buildSSLContext();
    }

    public static PaymentGatewayClient getInstance() {
        if (instance == null) {                        // First check — no lock (fast path)
            synchronized (PaymentGatewayClient.class) {
                if (instance == null) {                // Second check — with lock
                    instance = new PaymentGatewayClient();
                }
            }
        }
        return instance;
    }
}
```

**Why `volatile` fixes it:**
- `volatile` write to `instance` happens-before any `volatile` read
- The JVM cannot reorder the constructor's field writes to after the `volatile` write to `instance`
- Any thread reading `instance != null` is guaranteed to see the fully constructed object

## Initialisation-On-Demand Holder Idiom

Preferred over double-checked locking — simpler, correct by JVM spec, no `volatile` needed:

```java
public class PaymentGatewayClient {

    private PaymentGatewayClient() {
        // construction
    }

    // Loaded lazily when Holder class is first accessed
    // The JVM's class-loading lock guarantees exactly-once initialisation
    private static final class Holder {
        static final PaymentGatewayClient INSTANCE = new PaymentGatewayClient();
    }

    public static PaymentGatewayClient getInstance() {
        return Holder.INSTANCE;  // Class loaded on first call → static initialiser runs once
    }
}
```

**Why it works:** `Holder.INSTANCE` is a static final field. The JVM initialises `Holder` the first time `getInstance()` is called, using the class-loading lock to ensure exactly-once execution. Static field writes in the initialiser are always safely published to all threads.

## Safe Publication in Practice: Immutable Configuration

The ideal safe publication pattern combines all guarantees:

```java
public final class PaymentConfiguration {

    private final String         gatewayUrl;
    private final int            connectTimeoutMs;
    private final int            readTimeoutMs;
    private final BigDecimal     maxTransactionAmount;
    private final Set<String>    supportedCurrencies;
    private final Map<String, BigDecimal> feesByCountry;

    public PaymentConfiguration(
            String         gatewayUrl,
            int            connectTimeoutMs,
            int            readTimeoutMs,
            BigDecimal     maxTransactionAmount,
            Set<String>    supportedCurrencies,
            Map<String, BigDecimal> feesByCountry) {

        // Validate in constructor — object is always valid when constructed
        if (gatewayUrl == null || gatewayUrl.isBlank())
            throw new IllegalArgumentException("gatewayUrl required");
        if (connectTimeoutMs <= 0 || readTimeoutMs <= 0)
            throw new IllegalArgumentException("Timeouts must be positive");

        this.gatewayUrl           = gatewayUrl;
        this.connectTimeoutMs     = connectTimeoutMs;
        this.readTimeoutMs        = readTimeoutMs;
        this.maxTransactionAmount = maxTransactionAmount;
        // Defensive copy + immutable wrapper — prevents external mutation
        this.supportedCurrencies  = Set.copyOf(supportedCurrencies);
        this.feesByCountry        = Map.copyOf(feesByCountry);
    }

    // All getters — no setters
    public String    getGatewayUrl()           { return gatewayUrl; }
    public int       getConnectTimeoutMs()      { return connectTimeoutMs; }
    public int       getReadTimeoutMs()         { return readTimeoutMs; }
    public BigDecimal getMaxTransactionAmount() { return maxTransactionAmount; }
    public Set<String> getSupportedCurrencies() { return supportedCurrencies; }
    public Map<String, BigDecimal> getFeesByCountry() { return feesByCountry; }
}
```

Published once via `volatile` with hot-reload support:

```java
@Component
public class PaymentConfigService {

    private volatile PaymentConfiguration current;

    @PostConstruct
    public void init() {
        current = loadFromDatabase();
    }

    // Called by config-change event at runtime
    public void reload() {
        PaymentConfiguration updated = loadFromDatabase();
        current = updated;  // Atomic reference swap — old readers unaffected
    }

    public PaymentConfiguration get() {
        return current;  // Always returns a fully constructed, immutable object
    }
}
```

## Knowledge Check

**Q1:** A class has a `final` field that holds a `HashMap`. Another thread obtains a reference to the object and reads the `HashMap`. Is the contents of the `HashMap` guaranteed to be visible?

**A:** The reference stored in the `final` field is guaranteed to be visible. The `final` field freeze guarantee ensures the `HashMap` reference itself is correctly published. However, the **contents** of the `HashMap` are only guaranteed to be visible if no mutations occurred to the `HashMap` after the constructor completed. If the constructor populated the map and nobody modifies it afterwards, the contents are effectively visible. But HashMap is not thread-safe for concurrent reads if it was modified post-construction — use `Map.copyOf()` or `Collections.unmodifiableMap()` to be certain.

**Q2:** You remove the `volatile` modifier from the double-checked locking instance field. The code runs correctly on your development machine for months. Why might this code still be dangerous in production?

**A:** The broken double-checked locking bug is timing-sensitive and JVM/hardware dependent. Some JVMs and CPUs perform fewer reorderings than the JMM permits, making the bug rare in practice on strongly-ordered x86. It manifests more reliably on weakly-ordered architectures (ARM, some older SPARC). Production hardware, JVM version changes, or increased load changing JIT behaviour can expose the bug at any time. Never rely on hardware ordering stronger than what the JMM guarantees.

## Practical Challenge

A payment service needs a `FraudRuleEngine` that:
1. Is loaded lazily (not at startup — it takes 3 seconds to initialise)
2. Can be hot-reloaded when rules change without blocking ongoing payment checks
3. Is thread-safe for concurrent reads from hundreds of payment threads
4. Never exposes a partially constructed or partially updated rule set to any thread

**Task:** Implement `FraudRuleEngine` with the following:
- Lazy initialisation using the initialisation-on-demand holder idiom
- A `reload()` method that atomically swaps in a new rule set without blocking readers
- All rule data stored in `final` fields with defensive copies
- A `checkTransaction(Transaction tx)` method that reads rules without synchronisation
- Unit test demonstrating that after `reload()`, all subsequent calls to `checkTransaction()` use the new rules (no thread sees a mix of old and new rules mid-swap)

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A class has a final field holding a HashMap populated during construction. After safely publishing the object via a volatile write, is the HashMap's contents guaranteed to be visible to other threads?",
      "options": [
        "No, final fields only guarantee the reference is visible, not the contents of the object it points to",
        "Yes, if the HashMap was populated during the constructor and nobody modifies it afterwards, the freeze guarantee covers its contents",
        "No, HashMap is not thread-safe so its contents are never guaranteed visible",
        "Yes, but only if the HashMap is wrapped with Collections.synchronizedMap()"
      ],
      "correct": 1,
      "explanation": "The JMM freeze guarantee covers all writes that happen during the constructor before the final field freeze. Since the HashMap was populated during the constructor and the reference is a final field, all contents written during construction are visible. However, if the HashMap is later modified post-construction, those modifications are NOT covered by the freeze guarantee."
    },
    {
      "text": "What is the 'this escape' anti-pattern and why is it dangerous?",
      "options": [
        "Returning 'this' from a method, which prevents garbage collection",
        "Registering 'this' with an event listener or passing 'this' to another thread inside the constructor, before construction is complete",
        "Using 'this' as a synchronization monitor inside a method",
        "Storing 'this' in a static field, which prevents garbage collection"
      ],
      "correct": 1,
      "explanation": "The 'this escape' anti-pattern occurs when the object being constructed is published (e.g., passed to another thread or registered as a listener) before the constructor finishes. Another thread can call methods on the partially-constructed object, observing null or default values for fields that haven't been assigned yet. The fix is to use a static factory method that completes construction before publishing."
    },
    {
      "text": "Why is the double-checked locking pattern broken without the volatile keyword on the instance field?",
      "options": [
        "Without volatile, the field value may never be read from main memory",
        "Without volatile, the JIT can reorder the reference assignment before the constructor's field writes, so a reader may see a non-null but partially initialised object",
        "Without volatile, only one thread can ever see the instance",
        "Without volatile, the synchronized block does not provide mutual exclusion"
      ],
      "correct": 1,
      "explanation": "The JIT can reorder the write to the instance field (storing the reference) to occur before all the constructor's field writes complete. A reading thread may then see a non-null reference and bypass the synchronized block, but then read null or default values for the object's fields because the constructor writes haven't been flushed. The volatile write creates a happens-before edge that prevents this reordering."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Thread-Safe Lazy FraudRuleEngine with Hot Reload",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Implement a FraudRuleEngine class using the initialisation-on-demand holder idiom for lazy initialisation. The engine takes 3 seconds to initialise (simulate with Thread.sleep). All rule data (thresholds, blocked countries, velocity limits) must be stored in final fields with defensive copies using Set.copyOf() and Map.copyOf()."},
    {"id": "2", "description": "Add a reload() method to FraudRuleEngine that atomically swaps in a new RuleSet via a volatile reference swap. The swap must be atomic — no reader should ever see a mix of old and new rules. Readers calling checkTransaction() must not need any synchronisation and must not block during a reload."},
    {"id": "3", "description": "Implement a PaymentConfigService that uses a volatile reference to an immutable PaymentConfiguration record (all final fields: gatewayUrl, timeouts, maxAmount, supportedCurrencies as Set.copyOf, feesByCountry as Map.copyOf). The reload() method atomically swaps the reference. Validate all fields in the constructor to guarantee the object is always valid when constructed."},
    {"id": "4", "description": "Write a unit test for the FraudRuleEngine that: (a) loads the engine on a background thread and verifies it is not initialised before first access, (b) calls reload() with new rules from one thread while 100 reader threads continuously call checkTransaction(), and (c) asserts that after reload() completes, all subsequent checkTransaction() calls use the new rules — no thread observes a mix of old and new rule fields simultaneously."}
  ]
}
-->
