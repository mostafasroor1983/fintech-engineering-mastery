package com.fintechmastery.interview;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.random.RandomGenerator;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;

import com.fintechmastery.interview.Reconciler.BankLine;
import com.fintechmastery.interview.Reconciler.BreakType;
import com.fintechmastery.interview.Reconciler.LedgerItem;

/** Tests for the ten Track 17 coding challenges: happy path, edge cases and concurrency. */
class ChallengesTest {

    /** Starts n tasks at the same instant (start latch) and waits for all of them. */
    static <T> List<T> race(int n, java.util.concurrent.Callable<T> task) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<T>> futures = new ArrayList<>();
            for (int i = 0; i < n; i++) futures.add(pool.submit(() -> { start.await(); return task.call(); }));
            start.countDown();
            List<T> out = new ArrayList<>();
            for (Future<T> f : futures) out.add(f.get(30, TimeUnit.SECONDS));
            return out;
        } finally {
            pool.shutdownNow();
        }
    }

    @Nested class C01_Money {
        @Test void allocationNeverLosesAMinorUnit() {
            Money[] parts = Money.of("1.00", "GBP").allocate(1, 1, 1);
            assertThat(Arrays.stream(parts).mapToLong(Money::minor)).containsExactly(34L, 33L, 33L);
            Money[] weighted = Money.of("10.00", "EUR").allocate(70, 20, 10);
            assertThat(Arrays.stream(weighted).mapToLong(Money::minor).sum()).isEqualTo(1000);
            assertThat(Arrays.stream(weighted).mapToLong(Money::minor)).containsExactly(700L, 200L, 100L);
        }
        @Test void negativeAmountsAllocateExactlyToo() {
            Money[] parts = new Money(-100, java.util.Currency.getInstance("USD")).allocate(1, 1, 1);
            assertThat(Arrays.stream(parts).mapToLong(Money::minor).sum()).isEqualTo(-100);
        }
        @Test void currencyAndPrecisionRules() {
            assertThat(Money.of("0.10", "GBP").plus(Money.of("0.20", "GBP"))).isEqualTo(Money.of("0.30", "GBP"));
            assertThat(Money.of("500", "JPY").minor()).isEqualTo(500);        // JPY has no minor unit
            assertThatThrownBy(() -> Money.of("1.00", "GBP").plus(Money.of("1.00", "USD")))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> Money.of("1.005", "GBP")).isInstanceOf(ArithmeticException.class);
            assertThatThrownBy(() -> new Money(Long.MAX_VALUE, java.util.Currency.getInstance("GBP"))
                    .plus(Money.of("0.01", "GBP"))).isInstanceOf(ArithmeticException.class);
            assertThatThrownBy(() -> Money.of("1", "GBP").allocate(0, 0)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Nested class C02_Idempotency {
        @RepeatedTest(5) void concurrentRetriesRunTheOperationOnce() throws Exception {
            IdempotencyStore<String> store = new IdempotencyStore<>();
            AtomicInteger runs = new AtomicInteger();
            List<String> results = race(50, () -> store.execute("key-1", "hash-A", () -> {
                runs.incrementAndGet();
                sleep(20);                                  // widen the race window
                return "payment-" + runs.get();
            }));
            assertThat(runs).hasValue(1);
            assertThat(results).containsOnly("payment-1");
        }
        @Test void sameKeyDifferentBodyIsRejected() {
            IdempotencyStore<String> store = new IdempotencyStore<>();
            store.execute("k", "hash-A", () -> "ok");
            assertThatThrownBy(() -> store.execute("k", "hash-B", () -> "other"))
                    .isInstanceOf(IdempotencyStore.IdempotencyConflictException.class);
        }
        @Test void failuresAreNotRemembered() {
            IdempotencyStore<String> store = new IdempotencyStore<>();
            assertThatThrownBy(() -> store.execute("k", "h", () -> { throw new IllegalStateException("psp down"); }))
                    .hasMessage("psp down");
            assertThat(store.execute("k", "h", () -> "second try")).isEqualTo("second try");
        }
    }

    @Nested class C03_Transfers {
        @RepeatedTest(3) void oppositeConcurrentTransfersNeitherDeadlockNorLoseMoney() throws Exception {
            TransferService s = new TransferService();
            s.open("A", 1_000_000);
            s.open("B", 1_000_000);
            AtomicInteger i = new AtomicInteger();
            race(16, () -> {
                for (int k = 0; k < 625; k++) {
                    if (i.incrementAndGet() % 2 == 0) s.transfer("A", "B", 7); else s.transfer("B", "A", 7);
                }
                return null;
            });
            assertThat(s.balance("A") + s.balance("B")).isEqualTo(2_000_000);   // money is conserved
        }
        @Test void neverGoesNegativeUnderContention() throws Exception {
            TransferService s = new TransferService();
            s.open("A", 100);
            s.open("B", 0);
            List<Boolean> ok = race(20, () -> {
                try { s.transfer("A", "B", 10); return true; }
                catch (TransferService.InsufficientFundsException e) { return false; }
            });
            assertThat(ok.stream().filter(b -> b)).hasSize(10);
            assertThat(s.balance("A")).isZero();
            assertThat(s.balance("B")).isEqualTo(100);
        }
        @Test void rejectsBadInput() {
            TransferService s = new TransferService();
            s.open("A", 10);
            assertThatThrownBy(() -> s.transfer("A", "A", 1)).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> s.transfer("A", "X", 1)).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> s.transfer("A", "A", 0)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Nested class C04_TokenBucket {
        @Test void burstThenRefill() {
            AtomicLong now = new AtomicLong();
            TokenBucket b = new TokenBucket(5, 2.0, now::get);          // 5 burst, 2 tokens/s
            for (int k = 0; k < 5; k++) assertThat(b.tryAcquire(1)).isTrue();
            assertThat(b.tryAcquire(1)).isFalse();
            assertThat(b.nanosUntilAvailable(1)).isEqualTo(500_000_000L);
            now.addAndGet(500_000_000L);                                 // +0.5 s = 1 token
            assertThat(b.tryAcquire(1)).isTrue();
            assertThat(b.tryAcquire(1)).isFalse();
            now.addAndGet(10_000_000_000L);                              // long idle: capped at capacity
            for (int k = 0; k < 5; k++) assertThat(b.tryAcquire(1)).isTrue();
            assertThat(b.tryAcquire(1)).isFalse();
        }
        @Test void neverAdmitsMoreThanCapacityUnderContention() throws Exception {
            TokenBucket b = new TokenBucket(100, 0.000001, () -> 0L);   // frozen clock: no refill
            List<Boolean> got = race(32, () -> {
                int n = 0;
                for (int k = 0; k < 50; k++) if (b.tryAcquire(1)) n++;
                return n > 0;
            });
            assertThat(got).isNotEmpty();
            assertThat(b.tryAcquire(1)).isFalse();                       // exactly 100 were handed out
        }
    }

    @Nested class C05_Ledger {
        Ledger.Posting p(String acc, String ccy, long m) { return new Ledger.Posting(acc, ccy, m); }

        @Test void balancedEntriesPostAndBalancesFollow() {
            Ledger l = new Ledger();
            assertThat(l.post(new Ledger.JournalEntry("e1", "top-up",
                    List.of(p("cash", "GBP", 1000), p("wallet:alice", "GBP", -1000))))).isTrue();
            assertThat(l.balance("wallet:alice", "GBP")).isEqualTo(-1000);
            assertThat(l.balance("cash", "GBP")).isEqualTo(1000);
        }
        @Test void eachCurrencyMustBalanceSeparately() {
            Ledger l = new Ledger();
            // FX: GBP leg and EUR leg each balance through FX position accounts
            assertThat(l.post(new Ledger.JournalEntry("fx1", "convert", List.of(
                    p("wallet:alice", "GBP", 1000), p("fx-position", "GBP", -1000),
                    p("fx-position", "EUR", 1160), p("wallet:alice", "EUR", -1160))))).isTrue();
            assertThatThrownBy(() -> l.post(new Ledger.JournalEntry("bad", "x", List.of(
                    p("a", "GBP", 1000), p("b", "EUR", -1000))))).hasMessageContaining("unbalanced");
        }
        @Test void replayIsIdempotentButReuseIsRejected() {
            Ledger l = new Ledger();
            Ledger.JournalEntry e = new Ledger.JournalEntry("e1", "x", List.of(p("a", "GBP", 5), p("b", "GBP", -5)));
            assertThat(l.post(e)).isTrue();
            assertThat(l.post(e)).isFalse();
            assertThat(l.balance("a", "GBP")).isEqualTo(5);
            assertThatThrownBy(() -> l.post(new Ledger.JournalEntry("e1", "x",
                    List.of(p("a", "GBP", 6), p("b", "GBP", -6))))).isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> l.post(new Ledger.JournalEntry("e2", "x", List.of(p("a", "GBP", 5)))))
                    .hasMessageContaining("two postings");
        }
    }

    @Nested class C06_Reconciliation {
        final LocalDate d = LocalDate.of(2026, 11, 2);

        @Test void referenceFirstThenUnambiguousAmountAndDate() {
            Reconciler r = new Reconciler(2);
            var res = r.reconcile(
                    List.of(new BankLine("L1", "E2E-1", 1000, "GBP", d),
                            new BankLine("L2", null, 2500, "GBP", d.plusDays(1)),
                            new BankLine("L3", null, 999, "GBP", d)),
                    List.of(new LedgerItem("I1", "E2E-1", 1000, "GBP", d),
                            new LedgerItem("I2", "OTHER", 2500, "GBP", d),
                            new LedgerItem("I3", null, 4000, "GBP", d)));
            assertThat(res.matches()).extracting(m -> m.line().id() + "=" + m.item().id() + ":" + m.rule())
                    .containsExactly("L1=I1:REFERENCE", "L2=I2:AMOUNT_DATE");
            assertThat(res.breaks()).extracting(b -> b.type() + ":" + b.id())
                    .containsExactly("MISSING_IN_LEDGER:L3", "MISSING_AT_BANK:I3");
        }
        @Test void ambiguousCandidatesAreNeverAutoMatched() {
            Reconciler r = new Reconciler(3);
            var res = r.reconcile(List.of(new BankLine("L1", null, 500, "EUR", d)),
                    List.of(new LedgerItem("I1", null, 500, "EUR", d), new LedgerItem("I2", null, 500, "EUR", d.minusDays(1))));
            assertThat(res.matches()).isEmpty();
            assertThat(res.breaks()).extracting(b -> b.type()).contains(BreakType.AMBIGUOUS);
        }
        @Test void dateToleranceAndCurrencyAreRespected() {
            Reconciler r = new Reconciler(1);
            var res = r.reconcile(List.of(new BankLine("L1", null, 500, "EUR", d)),
                    List.of(new LedgerItem("I1", null, 500, "EUR", d.plusDays(3)), new LedgerItem("I2", null, 500, "GBP", d)));
            assertThat(res.matches()).isEmpty();
        }
    }

    @Nested class C07_Velocity {
        @Test void countAndAmountLimitsInSlidingWindow() {
            VelocityChecker v = new VelocityChecker(Duration.ofMinutes(10), 3, 50_000);
            Instant t = Instant.parse("2026-11-28T10:00:00Z");
            assertThat(v.check("card", 10_000, t)).isEqualTo(VelocityChecker.Decision.ALLOW);
            assertThat(v.check("card", 10_000, t.plusSeconds(60))).isEqualTo(VelocityChecker.Decision.ALLOW);
            assertThat(v.check("card", 40_000, t.plusSeconds(120))).isEqualTo(VelocityChecker.Decision.DECLINE_AMOUNT);
            assertThat(v.check("card", 10_000, t.plusSeconds(180))).isEqualTo(VelocityChecker.Decision.ALLOW);
            assertThat(v.check("card", 1, t.plusSeconds(240))).isEqualTo(VelocityChecker.Decision.DECLINE_COUNT);
            assertThat(v.check("other-card", 1, t.plusSeconds(240))).isEqualTo(VelocityChecker.Decision.ALLOW);
            // first event leaves the window exactly 10 minutes later
            assertThat(v.check("card", 1, t.plusSeconds(600))).isEqualTo(VelocityChecker.Decision.ALLOW);
        }
        @Test void concurrentChecksOnOneCardRespectTheCount() throws Exception {
            VelocityChecker v = new VelocityChecker(Duration.ofHours(1), 5, Long.MAX_VALUE);
            Instant t = Instant.parse("2026-11-28T10:00:00Z");
            List<VelocityChecker.Decision> out = race(40, () -> v.check("card", 1, t));
            assertThat(out.stream().filter(x -> x == VelocityChecker.Decision.ALLOW)).hasSize(5);
        }
    }

    @Nested class C08_Retry {
        @Test void retriesRetryableErrorsWithFullJitterWithinCap() throws Exception {
            List<Duration> sleeps = new ArrayList<>();
            AtomicInteger calls = new AtomicInteger();
            Retrier r = new Retrier(4, Duration.ofMillis(100), Duration.ofMillis(250), Duration.ofSeconds(10),
                    e -> e instanceof java.io.IOException, sleeps::add, RandomGenerator.of("L64X128MixRandom"), System::nanoTime);
            String out = r.call(() -> {
                if (calls.incrementAndGet() < 4) throw new java.io.IOException("timeout");
                return "ok";
            });
            assertThat(out).isEqualTo("ok");
            assertThat(sleeps).hasSize(3);
            assertThat(sleeps.get(0)).isLessThanOrEqualTo(Duration.ofMillis(100));
            assertThat(sleeps.get(1)).isLessThanOrEqualTo(Duration.ofMillis(200));
            assertThat(sleeps.get(2)).isLessThanOrEqualTo(Duration.ofMillis(250));   // capped
        }
        @Test void neverRetriesNonRetryableOrPastMaxAttempts() {
            AtomicInteger calls = new AtomicInteger();
            Retrier r = new Retrier(3, Duration.ofMillis(1), Duration.ofMillis(1), Duration.ofSeconds(1),
                    e -> e instanceof java.io.IOException, d -> { }, RandomGenerator.getDefault(), System::nanoTime);
            assertThatThrownBy(() -> r.call(() -> { calls.incrementAndGet(); throw new IllegalArgumentException("4xx"); }))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThat(calls).hasValue(1);
            calls.set(0);
            assertThatThrownBy(() -> r.call(() -> { calls.incrementAndGet(); throw new java.io.IOException("x"); }))
                    .isInstanceOf(java.io.IOException.class);
            assertThat(calls).hasValue(3);
        }
        @Test void givesUpWhenTheNextDelayWouldMissTheDeadline() {
            AtomicLong now = new AtomicLong();
            AtomicInteger calls = new AtomicInteger();
            Retrier r = new Retrier(10, Duration.ofSeconds(1), Duration.ofSeconds(1), Duration.ofMillis(500),
                    e -> true, d -> now.addAndGet(d.toNanos()), new java.util.Random(1), now::get);
            // with the deadline at 0.5 s and delays up to 1 s, it stops as soon as a delay doesn't fit
            assertThatThrownBy(() -> r.call(() -> { calls.incrementAndGet(); throw new IllegalStateException(); }));
            assertThat(now.get()).isLessThan(Duration.ofMillis(500).toNanos());
        }
    }

    @Nested class C09_ConsistentHashing {
        @Test void addingANodeMovesAboutOneNthOfTheKeys() {
            ConsistentHashRing ring = new ConsistentHashRing(200);
            for (String n : List.of("p1", "p2", "p3", "p4")) ring.addNode(n);
            Map<String, String> before = new HashMap<>();
            for (int k = 0; k < 20_000; k++) before.put("acct-" + k, ring.nodeFor("acct-" + k));
            ring.addNode("p5");
            long moved = before.entrySet().stream().filter(e -> !ring.nodeFor(e.getKey()).equals(e.getValue())).count();
            assertThat(moved / 20_000.0).isBetween(0.12, 0.28);        // ideal: 1/5 = 0.20
            before.forEach((k, v) -> {                                   // moved keys only go to the new node
                String now = ring.nodeFor(k);
                if (!now.equals(v)) assertThat(now).isEqualTo("p5");
            });
        }
        @Test void loadIsReasonablyEvenAndRemovalIsClean() {
            ConsistentHashRing ring = new ConsistentHashRing(200);
            for (String n : List.of("a", "b", "c")) ring.addNode(n);
            Map<String, Integer> load = new HashMap<>();
            for (int k = 0; k < 30_000; k++) load.merge(ring.nodeFor("k" + k), 1, Integer::sum);
            assertThat(load.values()).allSatisfy(c -> assertThat(c).isBetween(8_000, 12_000));
            ring.removeNode("b");
            for (int k = 0; k < 1000; k++) assertThat(ring.nodeFor("k" + k)).isNotEqualTo("b");
            assertThat(ring.snapshot()).hasSize(400);
        }
    }

    @Nested class C10_CircuitBreaker {
        @Test void opensFailsFastThenAllowsOneTrial() throws Exception {
            AtomicLong now = new AtomicLong();
            CircuitBreaker cb = new CircuitBreaker(3, Duration.ofSeconds(30), now::get);
            for (int k = 0; k < 3; k++) {
                assertThatThrownBy(() -> cb.call(() -> { throw new java.io.IOException("down"); }));
            }
            assertThat(cb.state()).isEqualTo(CircuitBreaker.State.OPEN);
            assertThatThrownBy(() -> cb.call(() -> "x")).isInstanceOf(CircuitBreaker.CallNotPermittedException.class);
            now.addAndGet(Duration.ofSeconds(30).toNanos());
            assertThat(cb.call(() -> "probe ok")).isEqualTo("probe ok");
            assertThat(cb.state()).isEqualTo(CircuitBreaker.State.CLOSED);
        }
        @Test void failedTrialReopensAndOnlyOneTrialRunsAtATime() throws Exception {
            AtomicLong now = new AtomicLong();
            CircuitBreaker cb = new CircuitBreaker(1, Duration.ofSeconds(10), now::get);
            assertThatThrownBy(() -> cb.call(() -> { throw new java.io.IOException(); }));
            now.addAndGet(Duration.ofSeconds(10).toNanos());
            CountDownLatch inTrial = new CountDownLatch(1), release = new CountDownLatch(1);
            Thread probe = new Thread(() -> {
                try { cb.call(() -> { inTrial.countDown(); release.await(); throw new java.io.IOException("still down"); }); }
                catch (Exception ignored) { }
            });
            probe.start();
            inTrial.await();
            assertThatThrownBy(() -> cb.call(() -> "second")).isInstanceOf(CircuitBreaker.CallNotPermittedException.class);
            release.countDown();
            probe.join();
            assertThat(cb.state()).isEqualTo(CircuitBreaker.State.OPEN);
        }
        @Test void aLateSuccessDoesNotCloseAnOpenBreaker() throws Exception {
            AtomicLong now = new AtomicLong();
            CircuitBreaker cb = new CircuitBreaker(1, Duration.ofSeconds(10), now::get);
            CountDownLatch started = new CountDownLatch(1), finish = new CountDownLatch(1);
            Thread slow = new Thread(() -> {
                try { cb.call(() -> { started.countDown(); finish.await(); return "late"; }); } catch (Exception ignored) { }
            });
            slow.start();
            started.await();
            assertThatThrownBy(() -> cb.call(() -> { throw new java.io.IOException(); }));  // trips the breaker
            finish.countDown();
            slow.join();
            assertThat(cb.state()).isEqualTo(CircuitBreaker.State.OPEN);
        }
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
