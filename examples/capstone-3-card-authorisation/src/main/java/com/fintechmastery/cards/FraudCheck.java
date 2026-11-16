package com.fintechmastery.cards;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import java.util.OptionalInt;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.resilience.InvocationRejectedException;
import org.springframework.resilience.annotation.ConcurrencyLimit;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;

/**
 * Calls the fraud engine with three layers of protection:
 * <ol>
 *   <li>Timeout (read-timeout 300 ms, set on the HTTP Service Client group).</li>
 *   <li>Bulkhead: at most N calls in flight; extra callers are rejected at once, not queued
 *       (Spring Framework 7 {@code @ConcurrencyLimit} with REJECT policy).</li>
 *   <li>Circuit breaker (Resilience4j): after repeated failures, stop calling for a while.</li>
 * </ol>
 * Any failure returns "no score". The caller decides the fallback; this class never guesses.
 */
@Component
public class FraudCheck {

    private static final Logger log = LoggerFactory.getLogger(FraudCheck.class);

    private final FraudClient client;
    private final CircuitBreaker breaker;

    public FraudCheck(FraudClient client, CardProperties props) {
        this.client = client;
        CardProperties.CircuitBreaker cb = props.fraud().circuitBreaker();
        this.breaker = CircuitBreaker.of("fraud", CircuitBreakerConfig.custom()
                .failureRateThreshold(cb.failureRateThreshold())
                .slidingWindowSize(cb.slidingWindowSize())
                .minimumNumberOfCalls(cb.minimumNumberOfCalls())
                .waitDurationInOpenState(cb.waitInOpenState())
                .build());
    }

    @ConcurrencyLimit(limitString = "${cards.fraud.max-concurrent-calls}", policy = ConcurrencyLimit.ThrottlePolicy.REJECT)
    public OptionalInt score(FraudClient.ScoreRequest request) {
        try {
            return OptionalInt.of(breaker.executeSupplier(() -> client.score(request)).score());
        } catch (CallNotPermittedException open) {
            log.debug("Fraud circuit open, skipping call");
            return OptionalInt.empty();
        } catch (RestClientException e) {
            log.warn("Fraud check failed: {}", e.getClass().getSimpleName()); // no request data in logs
            return OptionalInt.empty();
        }
    }

    public CircuitBreaker.State circuitState() {
        return breaker.getState();
    }

    /** Operational hook (e.g. an admin endpoint) and test hook: close the circuit. */
    public void resetCircuit() {
        breaker.reset();
    }

    /** The bulkhead rejects by throwing before our method runs; callers treat it like "no score". */
    public static boolean isBulkheadRejection(Throwable t) {
        return t instanceof InvocationRejectedException;
    }
}
