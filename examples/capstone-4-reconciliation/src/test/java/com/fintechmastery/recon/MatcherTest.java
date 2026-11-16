package com.fintechmastery.recon;

import static org.assertj.core.api.Assertions.assertThat;

import com.fintechmastery.common.Money;
import java.time.Duration;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MatcherTest {

    static final LocalDate D = LocalDate.of(2026, 11, 10);
    final Matcher matcher = new Matcher(Duration.ofDays(2), Duration.ofDays(2));

    static Matcher.NumberedLine line(long id, String ref, String e2e, String amount, Direction dir, LocalDate vd) {
        return new Matcher.NumberedLine(id, new BankLine(ref, e2e, Money.of(amount, "GBP"), dir, vd, null));
    }

    static Matcher.LedgerItem item(long id, String e2e, String amount, Direction dir, LocalDate vd) {
        return new Matcher.LedgerItem(id, e2e, Money.of(amount, "GBP"), dir, vd);
    }

    @Test
    void classifiesEveryKindOfOutcome() {
        List<Matcher.Outcome> out = matcher.match(
                List.of(line(1, "R1", "E1", "250.00", Direction.CRDT, D),
                        line(2, "R2", "E2", "100.00", Direction.DBIT, D),
                        line(3, "R3", null, "75.50", Direction.CRDT, D),
                        line(4, "R4", null, "2.50", Direction.DBIT, D)),
                List.of(item(10, "E1", "250.00", Direction.CRDT, D),
                        item(20, "E2", "110.00", Direction.DBIT, D),
                        item(30, "E3", "75.50", Direction.CRDT, D.minusDays(1)),
                        item(40, "E4", "40.00", Direction.DBIT, D.minusDays(5)),   // old: missing in bank
                        item(50, "E5", "60.00", Direction.CRDT, D)),                // recent: in transit
                D, Set.of());

        assertThat(out).contains(
                new Matcher.Matched(1, 10, "EXACT"),
                new Matcher.Matched(3, 30, "FUZZY_AMOUNT_DATE"));
        assertThat(out).filteredOn(o -> o instanceof Matcher.Break).extracting(o -> ((Matcher.Break) o).type())
                .containsExactlyInAnyOrder(BreakType.AMOUNT_MISMATCH, BreakType.MISSING_IN_LEDGER, BreakType.MISSING_IN_BANK);
    }

    @Test
    void fuzzyMatchWithTwoCandidatesIsAmbiguousNotAGuess() {
        List<Matcher.Outcome> out = matcher.match(
                List.of(line(1, "R1", null, "20.00", Direction.CRDT, D)),
                List.of(item(10, "E1", "20.00", Direction.CRDT, D), item(11, "E2", "20.00", Direction.CRDT, D)),
                D, Set.of());
        assertThat(out).singleElement().isInstanceOfSatisfying(Matcher.Break.class,
                b -> assertThat(b.type()).isEqualTo(BreakType.AMBIGUOUS));
    }

    @Test
    void sameBankReferenceTwiceIsADuplicate() {
        List<Matcher.Outcome> out = matcher.match(
                List.of(line(1, "R1", "E1", "20.00", Direction.CRDT, D)),
                List.of(item(10, "E1", "20.00", Direction.CRDT, D)),
                D, Set.of("R1")); // R1 arrived in yesterday's file already
        assertThat(out).singleElement().isInstanceOfSatisfying(Matcher.Break.class,
                b -> assertThat(b.type()).isEqualTo(BreakType.DUPLICATE_IN_BANK));
    }

    @Test
    void directionMattersNotJustAmount() {
        List<Matcher.Outcome> out = matcher.match(
                List.of(line(1, "R1", "E1", "20.00", Direction.DBIT, D)),
                List.of(item(10, "E1", "20.00", Direction.CRDT, D)),
                D, Set.of());
        assertThat(out).singleElement().isInstanceOfSatisfying(Matcher.Break.class,
                b -> assertThat(b.type()).isEqualTo(BreakType.AMOUNT_MISMATCH));
    }
}
