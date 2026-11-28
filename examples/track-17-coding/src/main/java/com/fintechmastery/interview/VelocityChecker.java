package com.fintechmastery.interview;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.ConcurrentHashMap;

/**
 * C07: a sliding-window velocity rule for card fraud: "at most N authorisations and at most X in
 * value per card in the last W". Each card keeps a deque of recent events; old ones are evicted on
 * every call, so memory per card is bounded by the events inside the window.
 *
 * <p>A declined attempt is not recorded: it did not spend anything. Locking is per card, so cards do
 * not contend with each other.
 */
public final class VelocityChecker {

    private record Event(Instant at, long amountMinor) { }

    private static final class Window {
        final Deque<Event> events = new ArrayDeque<>();
        long totalMinor;
    }

    public enum Decision { ALLOW, DECLINE_COUNT, DECLINE_AMOUNT }

    private final Duration window;
    private final int maxCount;
    private final long maxAmountMinor;
    private final ConcurrentHashMap<String, Window> cards = new ConcurrentHashMap<>();

    public VelocityChecker(Duration window, int maxCount, long maxAmountMinor) {
        if (window.isNegative() || window.isZero()) throw new IllegalArgumentException("window must be positive");
        this.window = window;
        this.maxCount = maxCount;
        this.maxAmountMinor = maxAmountMinor;
    }

    public Decision check(String cardId, long amountMinor, Instant at) {
        if (amountMinor <= 0) throw new IllegalArgumentException("amount must be positive");
        Window w = cards.computeIfAbsent(cardId, k -> new Window());
        synchronized (w) {
            Instant cutoff = at.minus(window);
            // Evict events that are out of the window: (at - W, at] stays
            while (!w.events.isEmpty() && !w.events.peekFirst().at().isAfter(cutoff)) {
                w.totalMinor -= w.events.pollFirst().amountMinor();
            }
            if (w.events.size() + 1 > maxCount) return Decision.DECLINE_COUNT;
            if (w.totalMinor + amountMinor > maxAmountMinor) return Decision.DECLINE_AMOUNT;
            w.events.addLast(new Event(at, amountMinor));
            w.totalMinor += amountMinor;
            return Decision.ALLOW;
        }
    }
}
