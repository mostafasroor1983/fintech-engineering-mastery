package com.fintechmastery.interview;

import java.time.Duration;
import java.util.concurrent.Callable;
import java.util.function.LongSupplier;
import java.util.function.Predicate;
import java.util.random.RandomGenerator;

/**
 * C08: retries with capped exponential backoff and full jitter, a maximum number of attempts and an
 * overall deadline. Only errors the caller marks as retryable are retried: never retry a non-idempotent
 * call that might already have succeeded.
 *
 * <p>Full jitter: delay = random(0, min(cap, base * 2^attempt)). It spreads retries from many
 * clients so they don't hit the recovering service in synchronised waves.
 */
public final class Retrier {

    /** Sleeping is injected so tests run instantly and can record the delays. */
    public interface Sleeper {
        void sleep(Duration d) throws InterruptedException;
    }

    private final int maxAttempts;
    private final Duration base;
    private final Duration cap;
    private final Duration deadline;
    private final Predicate<Exception> retryable;
    private final Sleeper sleeper;
    private final RandomGenerator random;
    private final LongSupplier nanoClock;

    public Retrier(int maxAttempts, Duration base, Duration cap, Duration deadline,
                   Predicate<Exception> retryable, Sleeper sleeper, RandomGenerator random, LongSupplier nanoClock) {
        if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts must be >= 1");
        this.maxAttempts = maxAttempts;
        this.base = base;
        this.cap = cap;
        this.deadline = deadline;
        this.retryable = retryable;
        this.sleeper = sleeper;
        this.random = random;
        this.nanoClock = nanoClock;
    }

    public <T> T call(Callable<T> action) throws Exception {
        long start = nanoClock.getAsLong();
        for (int attempt = 1; ; attempt++) {
            try {
                return action.call();
            } catch (Exception e) {
                if (!retryable.test(e) || attempt >= maxAttempts) throw e;
                long backoffCap = Math.min(cap.toNanos(), base.toNanos() << Math.min(attempt - 1, 30));
                long delay = random.nextLong(backoffCap + 1);          // full jitter: [0, backoffCap]
                long remaining = deadline.toNanos() - (nanoClock.getAsLong() - start);
                if (delay >= remaining) throw e;                         // would miss the deadline: give up now
                try {
                    sleeper.sleep(Duration.ofNanos(delay));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();                  // keep the interrupt for the caller
                    e.addSuppressed(ie);
                    throw e;
                }
            }
        }
    }
}
