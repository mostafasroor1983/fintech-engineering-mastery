package com.fintechmastery.wallet;

import com.fintechmastery.common.Money;
import java.util.Currency;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A balanced set of legs. Validated in Java here and again by a database trigger at commit. */
public record JournalRequest(String idempotencyKey, String requestHash, String kind, String description,
        @Nullable UUID fxQuoteId, List<Leg> legs) {

    public JournalRequest {
        legs = List.copyOf(legs);
        if (legs.size() < 2) {
            throw new IllegalArgumentException("A journal entry needs at least two legs");
        }
        Map<Currency, Money> sums = new HashMap<>();
        for (Leg leg : legs) {
            sums.merge(leg.amount().currency(), leg.amount(), Money::plus);
        }
        sums.forEach((ccy, sum) -> {
            if (!sum.isZero()) {
                throw new IllegalArgumentException("Entry does not balance in " + ccy + ": " + sum);
            }
        });
    }
}
