package com.fintechmastery.interview;

import java.time.Duration;
import java.util.concurrent.Callable;
import java.util.function.LongSupplier;

/**
 * C10: a circuit breaker. CLOSED counts consecutive failures; at the threshold it OPENs and fails
 * fast. After the open duration it lets exactly ONE trial call through (HALF_OPEN): success closes
 * it, failure opens it again. Fail-fast protects threads, pools and the struggling dependency.
 */
public final class CircuitBreaker {

    public enum State { CLOSED, OPEN, HALF_OPEN }

    private final int failureThreshold;
    private final long openNanos;
    private final LongSupplier nanoClock;

    private State state = State.CLOSED;     // guarded by this
    private int consecutiveFailures;        // guarded by this
    private long openedAt;                  // guarded by this
    private boolean trialInFlight;          // guarded by this

    public CircuitBreaker(int failureThreshold, Duration openDuration, LongSupplier nanoClock) {
        if (failureThreshold < 1) throw new IllegalArgumentException("threshold must be >= 1");
        this.failureThreshold = failureThreshold;
        this.openNanos = openDuration.toNanos();
        this.nanoClock = nanoClock;
    }

    public <T> T call(Callable<T> action) throws Exception {
        boolean trial = acquirePermission();      // throws CallNotPermittedException when open
        try {
            T result = action.call();             // the call runs OUTSIDE the lock
            onSuccess(trial);
            return result;
        } catch (Exception e) {
            onFailure(trial);
            throw e;
        }
    }

    public synchronized State state() {
        return state;
    }

    private synchronized boolean acquirePermission() {
        if (state == State.OPEN && nanoClock.getAsLong() - openedAt >= openNanos) {
            state = State.HALF_OPEN;
        }
        return switch (state) {
            case CLOSED -> false;
            case OPEN -> throw new CallNotPermittedException();
            case HALF_OPEN -> {
                if (trialInFlight) throw new CallNotPermittedException();   // only one probe at a time
                trialInFlight = true;
                yield true;
            }
        };
    }

    private synchronized void onSuccess(boolean trial) {
        if (trial) {                            // the probe worked: the dependency is back
            state = State.CLOSED;
            trialInFlight = false;
        }
        // A slow call that started while CLOSED and succeeds after the breaker opened must not
        // close it again: only the half-open probe decides that.
        if (state == State.CLOSED) consecutiveFailures = 0;
    }

    private synchronized void onFailure(boolean trial) {
        if (trial) {                            // the probe failed: stay away for another open period
            open();
        } else if (state == State.CLOSED && ++consecutiveFailures >= failureThreshold) {
            open();
        }
        // Late failures of calls that started before the breaker opened change nothing.
    }

    private void open() {
        state = State.OPEN;
        openedAt = nanoClock.getAsLong();
        consecutiveFailures = 0;
        trialInFlight = false;
    }

    public static final class CallNotPermittedException extends RuntimeException {
        public CallNotPermittedException() {
            super("circuit open: call not permitted");
        }
    }
}
