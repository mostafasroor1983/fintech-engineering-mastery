package com.fintechmastery.interview;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * C06: match bank statement lines to ledger items and classify everything left over as a break.
 *
 * <ol>
 *   <li>Pass 1: exact end-to-end reference (and same amount and currency).</li>
 *   <li>Pass 2: same amount and currency, value dates within a tolerance, and exactly ONE candidate.
 *       Two or more candidates are AMBIGUOUS and go to a human: a wrong auto-match hides two real breaks.</li>
 * </ol>
 * Each line and each item is used at most once.
 */
public final class Reconciler {

    public record BankLine(String id, String reference, long amountMinor, String currency, LocalDate valueDate) { }

    public record LedgerItem(String id, String reference, long amountMinor, String currency, LocalDate valueDate) { }

    public record Match(BankLine line, LedgerItem item, String rule) { }

    public enum BreakType { MISSING_IN_LEDGER, MISSING_AT_BANK, AMBIGUOUS }

    public record Break(BreakType type, String id, String detail) { }

    public record Result(List<Match> matches, List<Break> breaks) { }

    private final int dateToleranceDays;

    public Reconciler(int dateToleranceDays) {
        if (dateToleranceDays < 0) throw new IllegalArgumentException("negative tolerance");
        this.dateToleranceDays = dateToleranceDays;
    }

    public Result reconcile(List<BankLine> lines, List<LedgerItem> items) {
        List<Match> matches = new ArrayList<>();
        List<Break> breaks = new ArrayList<>();
        Set<String> usedItems = new HashSet<>();
        List<BankLine> unmatched = new ArrayList<>();

        // Pass 1: reference index (references that appear on more than one item are not trusted)
        Map<String, List<LedgerItem>> byRef = new HashMap<>();
        for (LedgerItem i : items) {
            if (i.reference() != null && !i.reference().isBlank()) {
                byRef.computeIfAbsent(i.reference(), k -> new ArrayList<>()).add(i);
            }
        }
        for (BankLine l : lines) {
            List<LedgerItem> c = l.reference() == null ? List.of() : byRef.getOrDefault(l.reference(), List.of());
            LedgerItem hit = c.size() == 1 ? c.get(0) : null;
            if (hit != null && !usedItems.contains(hit.id()) && sameMoney(l, hit)) {
                matches.add(new Match(l, hit, "REFERENCE"));
                usedItems.add(hit.id());
            } else {
                unmatched.add(l);
            }
        }

        // Pass 2: amount + currency + date window, only when unambiguous
        for (BankLine l : unmatched) {
            List<LedgerItem> candidates = items.stream()
                    .filter(i -> !usedItems.contains(i.id()))
                    .filter(i -> sameMoney(l, i))
                    .filter(i -> Math.abs(ChronoUnit.DAYS.between(l.valueDate(), i.valueDate())) <= dateToleranceDays)
                    .toList();
            if (candidates.size() == 1) {
                matches.add(new Match(l, candidates.get(0), "AMOUNT_DATE"));
                usedItems.add(candidates.get(0).id());
            } else if (candidates.isEmpty()) {
                breaks.add(new Break(BreakType.MISSING_IN_LEDGER, l.id(), "no ledger item"));
            } else {
                breaks.add(new Break(BreakType.AMBIGUOUS, l.id(), candidates.size() + " candidates"));
            }
        }

        for (LedgerItem i : items) {
            if (!usedItems.contains(i.id())) breaks.add(new Break(BreakType.MISSING_AT_BANK, i.id(), "not on statement"));
        }
        return new Result(List.copyOf(matches), List.copyOf(breaks));
    }

    private static boolean sameMoney(BankLine l, LedgerItem i) {
        return l.amountMinor() == i.amountMinor() && l.currency().equals(i.currency());
    }
}
