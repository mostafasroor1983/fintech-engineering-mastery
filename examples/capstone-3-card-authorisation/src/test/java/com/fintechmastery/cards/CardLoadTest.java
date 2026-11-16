package com.fintechmastery.cards;

import static org.assertj.core.api.Assertions.assertThat;

import com.fintechmastery.common.Money;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * mvn test -pl capstone-3-card-authorisation -am -Dgroups=load
 * 2,000 authorise + capture pairs from 100 workers, with the fraud engine answering in ~0 ms.
 * Shows the cost of the fraud round trip plus two short transactions per payment.
 */
@Tag("load")
@SpringBootTest
@Import(TestcontainersConfig.class)
class CardLoadTest {

    static final FakeFraudServer FRAUD = new FakeFraudServer();

    @DynamicPropertySource
    static void fraudUrl(DynamicPropertyRegistry registry) {
        registry.add("spring.http.serviceclient.fraud.base-url", FRAUD::url);
    }

    @Autowired
    CardService cards;

    @Test
    void authoriseAndCaptureUnderLoad() throws Exception {
        int n = 2_000;
        List<Long> micros = Collections.synchronizedList(new ArrayList<>());
        long start = System.nanoTime();
        try (var pool = Executors.newFixedThreadPool(100, Thread.ofVirtual().factory())) {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                String op = "load-cap-" + i;
                futures.add(pool.submit(() -> {
                    long t0 = System.nanoTime();
                    CardAuthorisation a = cards.authorise("tok_loadtest0001", "shop-load", Money.of("19.99", "GBP"));
                    cards.apply(a.publicId(), new CardCommand.Capture(op, Money.of("19.99", "GBP")));
                    micros.add((System.nanoTime() - t0) / 1_000);
                }));
            }
            for (Future<?> f : futures) {
                f.get();
            }
        }
        double seconds = (System.nanoTime() - start) / 1e9;
        List<Long> sorted = micros.stream().sorted().toList();
        System.out.printf("LOAD capstone-3: %d auth+capture in %.1f s = %.0f/s; p50 %.1f ms, p99 %.1f ms, fraud calls %d%n",
                n, seconds, n / seconds, sorted.get(n / 2) / 1000.0, sorted.get((int) (n * 0.99)) / 1000.0, FRAUD.calls.get());
        assertThat(sorted).hasSize(n);
    }
}
