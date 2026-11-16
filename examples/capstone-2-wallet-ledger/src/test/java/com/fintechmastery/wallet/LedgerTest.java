package com.fintechmastery.wallet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fintechmastery.common.Money;
import java.util.ArrayList;
import java.util.Currency;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;

@SpringBootTest
@Import(TestcontainersConfig.class)
class LedgerTest {

    @Autowired
    WalletService wallets;

    @Autowired
    FxService fx;

    @Autowired
    ReconciliationService recon;

    @Autowired
    JdbcClient jdbc;

    UUID alice;
    UUID bob;

    @BeforeEach
    void setUp() {
        jdbc.sql("TRUNCATE posting, journal_entry, fx_quote, account CASCADE").update();
        alice = wallets.openWallet("alice", "GBP").publicId();
        bob = wallets.openWallet("bob", "GBP").publicId();
        wallets.deposit("dep-" + UUID.randomUUID(), alice, Money.of("100.00", "GBP"));
    }

    Money balance(UUID id) {
        return wallets.account(id).balance();
    }

    @Test
    void transferMovesMoneyAndTheLedgerStaysBalanced() {
        wallets.transfer("t-00000001", alice, bob, Money.of("30.00", "GBP"), "rent");

        assertThat(balance(alice)).isEqualTo(Money.of("70.00", "GBP"));
        assertThat(balance(bob)).isEqualTo(Money.of("30.00", "GBP"));
        assertThat(recon.run().clean()).isTrue();
    }

    @Test
    void insufficientFundsWritesNothing() {
        assertThatThrownBy(() -> wallets.transfer("t-00000002", alice, bob, Money.of("100.01", "GBP"), "too much"))
                .isInstanceOf(InsufficientFundsException.class);

        assertThat(balance(alice)).isEqualTo(Money.of("100.00", "GBP"));
        assertThat(jdbc.sql("SELECT count(*) FROM journal_entry WHERE kind = 'TRANSFER'").query(Long.class).single()).isZero();
    }

    @Test
    void retryWithSameKeyDoesNotMoveMoneyTwice() {
        UUID first = wallets.transfer("t-00000003", alice, bob, Money.of("10.00", "GBP"), "x");
        UUID retry = wallets.transfer("t-00000003", alice, bob, Money.of("10.00", "GBP"), "x");

        assertThat(retry).isEqualTo(first);
        assertThat(balance(alice)).isEqualTo(Money.of("90.00", "GBP"));
    }

    @Test
    void concurrentSpendingNeverOverdraws() throws Exception {
        // 50 concurrent transfers of 10.00 from a 100.00 balance: exactly 10 may succeed.
        AtomicInteger ok = new AtomicInteger();
        AtomicInteger rejected = new AtomicInteger();
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < 50; i++) {
                String key = "race-" + i;
                futures.add(pool.submit(() -> {
                    try {
                        wallets.transfer(key, alice, bob, Money.of("10.00", "GBP"), "race");
                        ok.incrementAndGet();
                    } catch (InsufficientFundsException e) {
                        rejected.incrementAndGet();
                    }
                }));
            }
            for (Future<?> f : futures) {
                f.get();
            }
        }
        assertThat(ok).hasValue(10);
        assertThat(rejected).hasValue(40);
        assertThat(balance(alice)).isEqualTo(Money.zero(Currency.getInstance("GBP")));
        assertThat(recon.run().clean()).isTrue();
    }

    @Test
    void opposingTransfersDoNotDeadlock() throws Exception {
        wallets.deposit("dep-bob", bob, Money.of("100.00", "GBP"));
        // A->B and B->A at the same time. Without ordered locking PostgreSQL detects a deadlock
        // and aborts one transaction; with id-ordered locking every call succeeds.
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<UUID>> futures = new ArrayList<>();
            for (int i = 0; i < 40; i++) {
                boolean aToB = i % 2 == 0;
                String key = "dl-" + i;
                futures.add(pool.submit(() -> aToB
                        ? wallets.transfer(key, alice, bob, Money.of("1.00", "GBP"), "dl")
                        : wallets.transfer(key, bob, alice, Money.of("1.00", "GBP"), "dl")));
            }
            for (Future<UUID> f : futures) {
                assertThat(f.get()).isNotNull(); // would throw ExecutionException(CannotAcquireLock) on deadlock
            }
        }
        assertThat(balance(alice)).isEqualTo(Money.of("100.00", "GBP"));
        assertThat(balance(bob)).isEqualTo(Money.of("100.00", "GBP"));
    }

    @Test
    void databaseRejectsAnUnbalancedEntry() {
        // Simulates a bug that bypasses the Java check: one leg only.
        long accountId = jdbc.sql("SELECT id FROM account WHERE public_id = :id").param("id", alice).query(Long.class).single();
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
                    long entry = jdbc.sql("""
                            INSERT INTO journal_entry (public_id, idempotency_key, request_hash, kind)
                            VALUES (gen_random_uuid(), 'bad-entry', repeat('0', 64), 'TRANSFER') RETURNING id
                            """).query(Long.class).single();
                    jdbc.sql("INSERT INTO posting (entry_id, account_id, amount_minor, currency) VALUES (:e, :a, 500, 'GBP')")
                            .param("e", entry).param("a", accountId).update();
                }))  // the deferred trigger fires at COMMIT
                .isInstanceOf(DataAccessException.class)
                .hasMessageContaining("is not balanced");
    }

    @Autowired
    org.springframework.transaction.support.TransactionTemplate tx;

    @Test
    void ledgerIsAppendOnly() {
        assertThatThrownBy(() -> jdbc.sql("UPDATE posting SET amount_minor = 1").update())
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class)
                .rootCause().hasMessageContaining("posting is append-only");
        assertThatThrownBy(() -> jdbc.sql("DELETE FROM journal_entry").update())
                .rootCause().hasMessageContaining("journal_entry is append-only");
    }

    @Test
    void reconciliationDetectsABalanceThatDriftedFromThePostings() {
        // Simulate a bug that updated the cached balance without a posting.
        jdbc.sql("UPDATE account SET balance_minor = balance_minor + 1 WHERE public_id = :id").param("id", bob).update();

        ReconciliationService.Report report = recon.run();
        assertThat(report.clean()).isFalse();
        assertThat(report.balanceBreaks()).singleElement().satisfies(b -> {
            assertThat(b.account()).isEqualTo(bob);
            assertThat(b.cachedMinor()).isEqualTo(1);
            assertThat(b.ledgerMinor()).isZero();
        });
    }

    @Test
    void fxTransferBalancesPerCurrencyAndRoundsDownForTheCustomer() {
        UUID bobEur = wallets.openWallet("bob", "EUR").publicId();
        // mid 1.15, spread 50 bps -> rate 1.14425000; 100.00 GBP -> 114.425 EUR -> DOWN -> 114.42
        FxQuote q = fx.quote(Money.of("100.00", "GBP"), Currency.getInstance("EUR"));
        assertThat(q.rate()).isEqualByComparingTo("1.14425");
        assertThat(q.buy()).isEqualTo(Money.of("114.42", "EUR"));

        wallets.fxTransfer("fx-00000001", q.id(), alice, bobEur);

        assertThat(balance(alice)).isEqualTo(Money.of("0.00", "GBP"));
        assertThat(balance(bobEur)).isEqualTo(Money.of("114.42", "EUR"));
        assertThat(recon.run().clean()).isTrue(); // each currency sums to zero on its own
    }

    @Test
    void quoteCanBeUsedOnlyOnceAndNotAfterExpiry() {
        UUID bobEur = wallets.openWallet("bob", "EUR").publicId();
        FxQuote q = fx.quote(Money.of("10.00", "GBP"), Currency.getInstance("EUR"));
        wallets.fxTransfer("fx-00000002", q.id(), alice, bobEur);

        assertThatThrownBy(() -> wallets.fxTransfer("fx-00000003", q.id(), alice, bobEur))
                .isInstanceOf(QuoteUnavailableException.class);

        FxQuote expired = fx.quote(Money.of("10.00", "GBP"), Currency.getInstance("EUR"));
        jdbc.sql("UPDATE fx_quote SET expires_at = now() - interval '1 second' WHERE id = :id").param("id", expired.id()).update();
        assertThatThrownBy(() -> wallets.fxTransfer("fx-00000004", expired.id(), alice, bobEur))
                .isInstanceOf(QuoteUnavailableException.class);
        assertThat(balance(alice)).isEqualTo(Money.of("90.00", "GBP"));
    }

    @Test
    void concurrentRetriesOfOneFxTransferReturnTheSameEntry() throws Exception {
        UUID bobEur = wallets.openWallet("bob", "EUR").publicId();
        FxQuote q = fx.quote(Money.of("10.00", "GBP"), Currency.getInstance("EUR"));
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<UUID>> futures = new ArrayList<>();
            for (int i = 0; i < 10; i++) {
                futures.add(pool.submit(() -> wallets.fxTransfer("fx-retry-1", q.id(), alice, bobEur)));
            }
            List<UUID> ids = new ArrayList<>();
            for (Future<UUID> f : futures) {
                ids.add(f.get());
            }
            assertThat(ids).containsOnly(ids.getFirst());
        }
        assertThat(balance(alice)).isEqualTo(Money.of("90.00", "GBP"));
    }
}
