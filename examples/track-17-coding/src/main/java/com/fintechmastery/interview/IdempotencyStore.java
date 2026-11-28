package com.fintechmastery.interview;

import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * C02: run an operation at most once per idempotency key, even when retries arrive concurrently.
 *
 * <ul>
 *   <li>First caller for a key runs the operation; concurrent callers with the same key wait for the
 *       same result instead of running it again (in-flight de-duplication).</li>
 *   <li>Same key with a different request body is a client bug: rejected, never silently replayed.</li>
 *   <li>A failed operation is not remembered, so the client can retry it.</li>
 * </ul>
 * In production the map is a database table with a unique constraint on the key (claimed in the same
 * transaction as the effect) and a retention period; this in-memory version shows the concurrency logic.
 */
public final class IdempotencyStore<T> {

    private record Entry<T>(String requestHash, CompletableFuture<T> result) { }

    private final ConcurrentHashMap<String, Entry<T>> entries = new ConcurrentHashMap<>();

    public T execute(String key, String requestHash, Supplier<T> operation) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(requestHash, "requestHash");

        CompletableFuture<T> mine = new CompletableFuture<>();
        // putIfAbsent is atomic: exactly one caller per key wins the claim
        Entry<T> existing = entries.putIfAbsent(key, new Entry<>(requestHash, mine));

        if (existing != null) {
            if (!existing.requestHash().equals(requestHash)) {
                throw new IdempotencyConflictException(key);
            }
            try {
                return existing.result().join();          // wait for the first caller's outcome
            } catch (CompletionException e) {
                throw unwrap(e);
            }
        }

        try {
            T value = operation.get();
            mine.complete(value);
            return value;
        } catch (RuntimeException | Error e) {             // Errors too, or waiters would hang forever
            entries.remove(key);                           // forget failures so a retry can run again
            mine.completeExceptionally(e);                 // waiting callers see the same failure
            throw e;
        }
    }

    private static RuntimeException unwrap(CompletionException e) {
        return e.getCause() instanceof RuntimeException r ? r : e;
    }

    public static final class IdempotencyConflictException extends RuntimeException {
        public IdempotencyConflictException(String key) {
            super("idempotency key reused with a different request: " + key);
        }
    }
}
