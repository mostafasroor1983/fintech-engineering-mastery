package com.fintechmastery.wallet;

import com.fintechmastery.common.Money;

/** One side of a journal entry: which account, and the signed amount (+ credit, - debit). */
public record Leg(long accountId, Money amount) {

    public Leg {
        if (amount.isZero()) {
            throw new IllegalArgumentException("A leg cannot be zero");
        }
    }
}
