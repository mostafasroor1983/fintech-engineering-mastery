package com.fintechmastery.payments;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

/**
 * Load smoke test: run with  mvn test -pl capstone-1-payment-service -am -Dgroups=load
 * 200 concurrent clients send 4,000 payments, 10% of them retries of an earlier key.
 * Checks correctness under load (exactly one payment per key) and prints latency percentiles.
 * Numbers from a laptop with Docker are illustrative only, not a capacity statement.
 */
@Tag("load")
class PaymentLoadTest extends IntegrationTest {

    @Test
    void sustainedLoadKeepsExactlyOncePerKey() throws Exception {
        int requests = 4_000;
        int clients = 200;
        List<Long> latenciesMicros = Collections.synchronizedList(new ArrayList<>());
        AtomicInteger errors = new AtomicInteger();
        long start = System.nanoTime();
        try (var pool = Executors.newFixedThreadPool(clients, Thread.ofVirtual().factory())) {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < requests; i++) {
                int keyNo = i % 10 == 9 ? i - 5 : i; // every 10th request retries an earlier key
                futures.add(pool.submit(() -> {
                    long t0 = System.nanoTime();
                    int status = http.post().uri("/v1/payments")
                            .header("X-Merchant-Id", "load").header("Idempotency-Key", "load-key-" + keyNo)
                            .contentType(MediaType.APPLICATION_JSON).body(body("12.34", "GBP"))
                            .exchange().returnResult().getStatus().value();
                    latenciesMicros.add((System.nanoTime() - t0) / 1_000);
                    if (status != 201) {
                        errors.incrementAndGet();
                    }
                }));
            }
            for (Future<?> f : futures) {
                f.get();
            }
        }
        double seconds = (System.nanoTime() - start) / 1e9;
        List<Long> sorted = latenciesMicros.stream().sorted().toList();
        System.out.printf("LOAD capstone-1: %d requests in %.1f s = %.0f req/s; p50 %.1f ms, p99 %.1f ms, errors %d%n",
                requests, seconds, requests / seconds, sorted.get(sorted.size() / 2) / 1000.0,
                sorted.get((int) (sorted.size() * 0.99)) / 1000.0, errors.get());

        long distinctKeys = requests - requests / 10;
        assertThat(errors).hasValue(0);
        assertThat(count("payment")).isEqualTo(distinctKeys);
        assertThat(count("outbox_event")).isEqualTo(distinctKeys);
    }
}
