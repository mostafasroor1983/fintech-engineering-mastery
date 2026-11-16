package com.fintechmastery.wallet;

import com.fintechmastery.common.Hashing;
import com.fintechmastery.common.Money;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Wallet use cases. Each one builds a balanced {@link JournalRequest} and hands it to the {@link Ledger}.
 *
 * <p>Idempotency here uses a natural business key: the journal entry itself has a UNIQUE
 * idempotency_key. A retry finds the entry it already created. (Capstone 1 shows the other
 * style: a separate key table that stores the full HTTP response.)
 */
@Service
public class WalletService {

    static final String HOUSE = "house";

    private final AccountRepository accounts;
    private final Ledger ledger;
    private final FxService fx;
    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final Clock clock;

    public WalletService(AccountRepository accounts, Ledger ledger, FxService fx, JdbcClient jdbc,
            TransactionTemplate tx, Clock clock) {
        this.accounts = accounts;
        this.ledger = ledger;
        this.fx = fx;
        this.jdbc = jdbc;
        this.tx = tx;
        this.clock = clock;
    }

    public Account openWallet(String ownerId, String currency) {
        return tx.execute(s -> accounts.save(Account.open(ownerId, AccountType.CUSTOMER_WALLET, currency, clock.instant())));
    }

    /** House accounts are created lazily and only once (unique index on owner, currency, type). */
    Account houseAccount(AccountType type, String currency) {
        return accounts.findByOwnerIdAndCurrencyAndType(HOUSE, currency, type).orElseGet(() -> {
            try {
                return tx.execute(s -> accounts.saveAndFlush(Account.open(HOUSE, type, currency, clock.instant())));
            } catch (org.springframework.dao.DataIntegrityViolationException raceLost) {
                return accounts.findByOwnerIdAndCurrencyAndType(HOUSE, currency, type).orElseThrow();
            }
        });
    }

    /** Money arrives from outside: debit the funding account, credit the wallet. */
    public UUID deposit(String idempotencyKey, UUID walletId, Money amount) {
        Account wallet = accounts.findByPublicId(walletId).orElseThrow(() -> new UnknownAccountException(walletId));
        Account funding = houseAccount(AccountType.FUNDING, amount.currencyCode());
        String hash = Hashing.sha256Hex("deposit|" + walletId + "|" + amount);
        return idempotent(idempotencyKey, hash, () -> ledger.post(new JournalRequest(idempotencyKey, hash, "DEPOSIT",
                "Top-up", null, List.of(new Leg(funding.id(), amount.negate()), new Leg(wallet.id(), amount)))));
    }

    public UUID transfer(String idempotencyKey, UUID fromId, UUID toId, Money amount, String description) {
        if (!amount.isPositive()) {
            throw new IllegalArgumentException("Amount must be positive");
        }
        if (fromId.equals(toId)) {
            throw new IllegalArgumentException("Cannot transfer to the same account");
        }
        Account from = accounts.findByPublicId(fromId).orElseThrow(() -> new UnknownAccountException(fromId));
        Account to = accounts.findByPublicId(toId).orElseThrow(() -> new UnknownAccountException(toId));
        String hash = Hashing.sha256Hex("transfer|" + fromId + "|" + toId + "|" + amount);
        return idempotent(idempotencyKey, hash, () -> ledger.post(new JournalRequest(idempotencyKey, hash, "TRANSFER",
                description, null, List.of(new Leg(from.id(), amount.negate()), new Leg(to.id(), amount)))));
    }

    /**
     * Cross-currency transfer at a quoted rate. Four legs, and each currency balances on its own:
     * customer GBP -> house GBP position, house EUR position -> customer EUR.
     */
    public UUID fxTransfer(String idempotencyKey, UUID quoteId, UUID fromId, UUID toId) {
        Account from = accounts.findByPublicId(fromId).orElseThrow(() -> new UnknownAccountException(fromId));
        Account to = accounts.findByPublicId(toId).orElseThrow(() -> new UnknownAccountException(toId));
        String hash = Hashing.sha256Hex("fx|" + quoteId + "|" + fromId + "|" + toId);
        // Resolve house accounts outside the posting transaction (they may need creating).
        Account houseSell = houseAccount(AccountType.FX_POSITION, from.currency());
        Account houseBuy = houseAccount(AccountType.FX_POSITION, to.currency());
        return idempotent(idempotencyKey, hash, () -> {
            FxQuote q = fx.consume(quoteId);
            if (!q.sell().currencyCode().equals(from.currency()) || !q.buy().currencyCode().equals(to.currency())) {
                throw new IllegalArgumentException("Quote currencies do not match the accounts");
            }
            return ledger.post(new JournalRequest(idempotencyKey, hash, "FX_TRANSFER",
                    "FX " + q.sell() + " -> " + q.buy() + " @ " + q.rate().toPlainString(), quoteId, List.of(
                            new Leg(from.id(), q.sell().negate()),
                            new Leg(houseSell.id(), q.sell()),
                            new Leg(houseBuy.id(), q.buy().negate()),
                            new Leg(to.id(), q.buy()))));
        });
    }

    /**
     * Runs the posting in its own transaction. If the key already exists (a retry, or a concurrent
     * duplicate that lost the race on the UNIQUE index), return the original entry instead.
     */
    private UUID idempotent(String key, String hash, Supplier<UUID> posting) {
        Optional<UUID> existing = findExisting(key, hash);
        if (existing.isPresent()) {
            return existing.get();
        }
        try {
            return tx.execute(s -> posting.get());
        } catch (DuplicateKeyException | QuoteUnavailableException raceLost) {
            // A concurrent twin committed first: it hit the UNIQUE key, or it already consumed the quote.
            // If an entry with our key exists, our request DID succeed; return that result.
            return findExisting(key, hash).orElseThrow(() -> raceLost);
        }
    }

    private Optional<UUID> findExisting(String key, String hash) {
        record Row(UUID publicId, String requestHash) {
        }
        return jdbc.sql("SELECT public_id, request_hash FROM journal_entry WHERE idempotency_key = :key")
                .param("key", key).query(Row.class).optional()
                .map(row -> {
                    if (!row.requestHash().equals(hash)) {
                        throw new IllegalStateException("Idempotency key reused with a different request");
                    }
                    return row.publicId();
                });
    }

    public Account account(UUID id) {
        return accounts.findByPublicId(id).orElseThrow(() -> new UnknownAccountException(id));
    }
}
