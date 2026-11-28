package com.fintechmastery.interview;

import java.util.function.LongSupplier;

/**
 * C04: a thread-safe token bucket: bursts up to {@code capacity}, refilled at a steady rate.
 *
 * <p>The clock is injected (nanoseconds, monotonic like {@link System#nanoTime}) so tests are
 * deterministic. Tokens are tracked as a double so slow rates (0.5/s) still refill smoothly.
 */
public final class TokenBucket {

    private final long capacity;
    private final double refillPerNano;
    private final LongSupplier nanoClock;

    private double tokens;          // guarded by this
    private long lastRefillNanos;   // guarded by this

    public TokenBucket(long capacity, double refillPerSecond, LongSupplier nanoClock) {
        if (capacity <= 0) throw new IllegalArgumentException("capacity must be positive");
        if (refillPerSecond <= 0) throw new IllegalArgumentException("refill rate must be positive");
        this.capacity = capacity;
        this.refillPerNano = refillPerSecond / 1_000_000_000.0;
        this.nanoClock = nanoClock;
        this.tokens = capacity;                       // start full
        this.lastRefillNanos = nanoClock.getAsLong();
    }

    /** Takes {@code permits} tokens if all are available; never blocks. */
    public synchronized boolean tryAcquire(int permits) {
        if (permits <= 0 || permits > capacity) throw new IllegalArgumentException("permits out of range");
        refill();
        if (tokens >= permits) {
            tokens -= permits;
            return true;
        }
        return false;
    }

    /** Nanoseconds until {@code permits} tokens will be available (0 if they are now): for Retry-After. */
    public synchronized long nanosUntilAvailable(int permits) {
        refill();
        double missing = permits - tokens;
        return missing <= 0 ? 0 : (long) Math.ceil(missing / refillPerNano);
    }

    private void refill() {
        long now = nanoClock.getAsLong();
        long elapsed = now - lastRefillNanos;          // nanoTime-style values: compare by difference
        if (elapsed > 0) {
            tokens = Math.min(capacity, tokens + elapsed * refillPerNano);
            lastRefillNanos = now;
        }
    }
}
