package com.fintechmastery.recon;

import com.fintechmastery.common.Money;
import java.time.Duration;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * Pure matching logic: no database, no Spring, so every rule is unit-testable.
 *
 * <p>Rules, in order:
 * <ol>
 *   <li>EXACT: same end-to-end id, amount, currency and direction.</li>
 *   <li>Same end-to-end id but different amount: AMOUNT_MISMATCH break.</li>
 *   <li>FUZZY: no end-to-end id; exactly one unmatched ledger item with the same amount, direction and a
 *       value date within the window. More than one candidate: AMBIGUOUS break.</li>
 *   <li>Leftover bank lines: MISSING_IN_LEDGER. Leftover ledger items older than the timing tolerance:
 *       MISSING_IN_BANK. Newer ones are in transit and are not breaks yet.</li>
 * </ol>
 */
public final class Matcher {

    public record LedgerItem(long id, String endToEndId, Money amount, Direction direction, LocalDate valueDate) {
    }

    public record NumberedLine(long id, BankLine line) {
    }

    public sealed interface Outcome permits Matched, Break {
    }

    public record Matched(long lineId, long ledgerItemId, String rule) implements Outcome {
    }

    public record Break(BreakType type, @Nullable Long lineId, @Nullable Long ledgerItemId, Money amount, String detail)
            implements Outcome {
    }

    private final Duration timingTolerance;
    private final Duration fuzzyWindow;

    public Matcher(Duration timingTolerance, Duration fuzzyWindow) {
        this.timingTolerance = timingTolerance;
        this.fuzzyWindow = fuzzyWindow;
    }

    public List<Outcome> match(List<NumberedLine> lines, List<LedgerItem> ledger, LocalDate statementDate,
            Set<String> previouslySeenBankRefs) {
        List<Outcome> out = new ArrayList<>();
        Map<String, LedgerItem> byE2e = new HashMap<>();
        Map<Long, LedgerItem> unmatched = new LinkedHashMap<>();
        for (LedgerItem item : ledger) {
            byE2e.put(item.endToEndId(), item);
            unmatched.put(item.id(), item);
        }
        Set<String> seenRefs = new HashSet<>(previouslySeenBankRefs);
        List<NumberedLine> needFuzzy = new ArrayList<>();

        for (NumberedLine nl : lines) {
            BankLine l = nl.line();
            if (!seenRefs.add(l.bankRef())) {
                out.add(new Break(BreakType.DUPLICATE_IN_BANK, nl.id(), null, l.amount(),
                        "Bank reference " + l.bankRef() + " reported more than once"));
                continue;
            }
            LedgerItem candidate = l.endToEndId() == null ? null : byE2e.get(l.endToEndId());
            if (candidate == null || !unmatched.containsKey(candidate.id())) {
                needFuzzy.add(nl);
            } else if (candidate.amount().equals(l.amount()) && candidate.direction() == l.direction()) {
                out.add(new Matched(nl.id(), candidate.id(), "EXACT"));
                unmatched.remove(candidate.id());
            } else {
                out.add(new Break(BreakType.AMOUNT_MISMATCH, nl.id(), candidate.id(), l.amount(),
                        "Bank " + l.direction() + " " + l.amount() + " vs ledger " + candidate.direction() + " "
                                + candidate.amount() + " for " + l.endToEndId()));
                unmatched.remove(candidate.id());
            }
        }

        for (NumberedLine nl : needFuzzy) {
            BankLine l = nl.line();
            List<LedgerItem> candidates = unmatched.values().stream()
                    .filter(i -> i.amount().equals(l.amount()) && i.direction() == l.direction())
                    .filter(i -> Math.abs(ChronoUnit.DAYS.between(i.valueDate(), l.valueDate())) <= fuzzyWindow.toDays())
                    .toList();
            if (candidates.size() == 1) {
                out.add(new Matched(nl.id(), candidates.getFirst().id(), "FUZZY_AMOUNT_DATE"));
                unmatched.remove(candidates.getFirst().id());
            } else if (candidates.size() > 1) {
                out.add(new Break(BreakType.AMBIGUOUS, nl.id(), null, l.amount(),
                        candidates.size() + " ledger items fit bank line " + l.bankRef()));
            } else {
                out.add(new Break(BreakType.MISSING_IN_LEDGER, nl.id(), null, l.amount(),
                        "No ledger item for bank line " + l.bankRef()
                                + (l.remittanceInfo() == null ? "" : " (" + l.remittanceInfo() + ")")));
            }
        }

        LocalDate cutoff = statementDate.minusDays(timingTolerance.toDays());
        for (LedgerItem item : unmatched.values()) {
            if (item.valueDate().isBefore(cutoff)) {
                out.add(new Break(BreakType.MISSING_IN_BANK, null, item.id(), item.amount(),
                        "Expected " + item.direction() + " " + item.amount() + " (" + item.endToEndId()
                                + ") not booked by the bank"));
            }
        }
        return out;
    }
}
