package com.fintechmastery.wallet;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The only class that writes to the ledger. Canonical lesson: Track 06 "Double-entry ledger".
 *
 * <p>Steps, all in the caller's transaction: lock accounts in id order, apply each leg to the
 * cached balance (overdraft check), append the journal entry and its postings.
 */
@Component
public class Ledger {

    private final AccountRepository accounts;
    private final JdbcClient jdbc;

    public Ledger(AccountRepository accounts, JdbcClient jdbc) {
        this.accounts = accounts;
        this.jdbc = jdbc;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public UUID post(JournalRequest request) {
        List<Long> ids = request.legs().stream().map(Leg::accountId).distinct().sorted().toList();
        Map<Long, Account> locked = accounts.lockInIdOrder(ids).stream()
                .collect(Collectors.toMap(Account::id, Function.identity()));
        if (locked.size() != ids.size()) {
            throw new IllegalArgumentException("Unknown account in journal request");
        }

        for (Leg leg : request.legs()) {
            locked.get(leg.accountId()).apply(leg.amount()); // throws InsufficientFundsException
        }

        UUID entryId = UUID.randomUUID();
        long entryPk = jdbc.sql("""
                INSERT INTO journal_entry (public_id, idempotency_key, request_hash, kind, description, fx_quote_id)
                VALUES (:publicId, :key, :hash, :kind, :description, :quote)
                RETURNING id
                """)
                .param("publicId", entryId).param("key", request.idempotencyKey())
                .param("hash", request.requestHash()).param("kind", request.kind())
                .param("description", request.description()).param("quote", request.fxQuoteId())
                .query(Long.class).single();

        for (Leg leg : request.legs()) {
            jdbc.sql("""
                    INSERT INTO posting (entry_id, account_id, amount_minor, currency)
                    VALUES (:entry, :account, :amount, :currency)
                    """)
                    .param("entry", entryPk).param("account", leg.accountId())
                    .param("amount", leg.amount().toMinorUnits()).param("currency", leg.amount().currencyCode())
                    .update();
        }
        accounts.flush(); // write balances (and bump @Version) before commit-time trigger checks
        return entryId;
    }
}
