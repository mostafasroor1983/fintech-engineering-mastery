package com.fintechmastery.wallet;

import static org.assertj.core.api.Assertions.assertThat;

import com.fintechmastery.common.Money;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;

/**
 * mvn test -pl capstone-2-wallet-ledger -am -Dgroups=load
 * 5,000 random transfers between 50 wallets from 100 concurrent workers (many hot pairs, both
 * directions). Must finish with zero deadlocks, no negative balances and a clean reconciliation.
 */
@Tag("load")
@SpringBootTest
@Import(TestcontainersConfig.class)
class LedgerLoadTest {

    @Autowired
    WalletService wallets;

    @Autowired
    ReconciliationService recon;

    @Test
    void randomTransfersKeepTheBooksBalanced() throws Exception {
        List<UUID> ids = new ArrayList<>();
        String run = UUID.randomUUID().toString().substring(0, 6);
        for (int i = 0; i < 50; i++) {
            UUID id = wallets.openWallet("load-" + run + "-" + i, "EUR").publicId();
            wallets.deposit("load-dep-" + run + "-" + i, id, Money.of("100.00", "EUR"));
            ids.add(id);
        }
        int transfers = 5_000;
        AtomicInteger ok = new AtomicInteger();
        AtomicInteger insufficient = new AtomicInteger();
        List<Long> micros = Collections.synchronizedList(new ArrayList<>());
        long start = System.nanoTime();
        try (var pool = Executors.newFixedThreadPool(100, Thread.ofVirtual().factory())) {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < transfers; i++) {
                String key = "load-" + run + "-" + i;
                futures.add(pool.submit(() -> {
                    var rnd = ThreadLocalRandom.current();
                    UUID from = ids.get(rnd.nextInt(ids.size()));
                    UUID to = ids.get(rnd.nextInt(ids.size()));
                    if (from.equals(to)) {
                        return;
                    }
                    long t0 = System.nanoTime();
                    try {
                        wallets.transfer(key, from, to, Money.of("7.00", "EUR"), "load");
                        ok.incrementAndGet();
                    } catch (InsufficientFundsException e) {
                        insufficient.incrementAndGet();
                    }
                    micros.add((System.nanoTime() - t0) / 1_000);
                }));
            }
            for (Future<?> f : futures) {
                f.get(); // a deadlock would surface here as ExecutionException
            }
        }
        double seconds = (System.nanoTime() - start) / 1e9;
        List<Long> sorted = micros.stream().sorted().toList();
        System.out.printf("LOAD capstone-2: %d ok + %d rejected in %.1f s = %.0f tx/s; p50 %.1f ms, p99 %.1f ms%n",
                ok.get(), insufficient.get(), seconds, (ok.get() + insufficient.get()) / seconds,
                sorted.get(sorted.size() / 2) / 1000.0, sorted.get((int) (sorted.size() * 0.99)) / 1000.0);

        assertThat(recon.run().clean()).isTrue();
        Money total = ids.stream().map(id -> wallets.account(id).balance()).reduce(Money::plus).orElseThrow();
        assertThat(total).isEqualTo(Money.of("5000.00", "EUR")); // money is moved, never created or lost
    }
}
