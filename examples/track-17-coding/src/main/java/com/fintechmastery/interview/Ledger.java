package com.fintechmastery.interview;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * C05: a double-entry ledger. Every journal entry has at least two postings and, per currency,
 * its postings sum to zero. Balances are derived from postings; nothing is ever updated in place.
 * Posting the same entry id twice is a no-op (idempotent), posting a different entry under a used
 * id is rejected.
 */
public final class Ledger {

    /** A signed posting: positive = debit, negative = credit (one convention, used everywhere). */
    public record Posting(String account, String currency, long amountMinor) {
        public Posting {
            Objects.requireNonNull(account);
            Objects.requireNonNull(currency);
            if (amountMinor == 0) throw new IllegalArgumentException("zero posting");
        }
    }

    public record JournalEntry(String id, String description, List<Posting> postings) {
        public JournalEntry {
            Objects.requireNonNull(id);
            postings = List.copyOf(postings);          // defensive copy: records are only shallowly immutable
        }
    }

    private final Map<String, JournalEntry> entries = new HashMap<>();
    private final Map<String, Long> balances = new HashMap<>();   // key: account|currency
    private final List<JournalEntry> journal = new ArrayList<>();

    /** Returns true if posted now, false if this exact entry was already posted. */
    public synchronized boolean post(JournalEntry entry) {
        JournalEntry previous = entries.get(entry.id());
        if (previous != null) {
            if (previous.equals(entry)) return false;  // idempotent replay
            throw new IllegalStateException("entry id reused with different content: " + entry.id());
        }
        validate(entry);
        for (Posting p : entry.postings()) {
            balances.merge(p.account() + "|" + p.currency(), p.amountMinor(), Math::addExact);
        }
        entries.put(entry.id(), entry);
        journal.add(entry);
        return true;
    }

    public synchronized long balance(String account, String currency) {
        return balances.getOrDefault(account + "|" + currency, 0L);
    }

    public synchronized List<JournalEntry> journal() {
        return List.copyOf(journal);
    }

    private static void validate(JournalEntry entry) {
        if (entry.postings().size() < 2) {
            throw new IllegalArgumentException("an entry needs at least two postings");
        }
        Map<String, Long> perCurrency = new HashMap<>();
        for (Posting p : entry.postings()) {
            perCurrency.merge(p.currency(), p.amountMinor(), Math::addExact);
        }
        perCurrency.forEach((currency, sum) -> {
            if (sum != 0) {
                throw new IllegalArgumentException("unbalanced in " + currency + ": " + sum);
            }
        });
    }
}
