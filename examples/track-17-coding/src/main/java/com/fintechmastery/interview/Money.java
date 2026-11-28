package com.fintechmastery.interview;

import java.math.BigDecimal;
import java.util.Currency;
import java.util.Objects;

/**
 * C01: an immutable money value object in minor units (pence, cents) with fair allocation.
 *
 * <p>Minor units in a {@code long} avoid floating-point error and make equality exact.
 * Every operation checks the currency and uses {@link Math#addExact} so overflow fails loudly.
 */
public record Money(long minor, Currency currency) {

    public Money {
        Objects.requireNonNull(currency, "currency");
    }

    public static Money of(String amount, String currencyCode) {
        Currency c = Currency.getInstance(currencyCode);
        BigDecimal value = new BigDecimal(amount);   // from a String: exact, never from a double
        // movePointRight + longValueExact rejects more decimals than the currency allows (e.g. 1.005 GBP)
        long minor = value.movePointRight(c.getDefaultFractionDigits()).longValueExact();
        return new Money(minor, c);
    }

    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(Math.addExact(minor, other.minor), currency);
    }

    public Money minus(Money other) {
        requireSameCurrency(other);
        return new Money(Math.subtractExact(minor, other.minor), currency);
    }

    public boolean isNegative() {
        return minor < 0;
    }

    /**
     * Splits this amount by ratios without creating or losing a single minor unit
     * (largest-remainder method). Example: 100 by {1, 1, 1} gives 34, 33, 33.
     */
    public Money[] allocate(int... ratios) {
        if (ratios.length == 0) throw new IllegalArgumentException("no ratios");
        long total = 0;
        for (int r : ratios) {
            if (r < 0) throw new IllegalArgumentException("negative ratio");
            total = Math.addExact(total, r);
        }
        if (total == 0) throw new IllegalArgumentException("ratios sum to zero");

        long[] shares = new long[ratios.length];
        long[] remainders = new long[ratios.length];
        long allocated = 0;
        for (int i = 0; i < ratios.length; i++) {
            // multiplyExact: minor * ratio can overflow for huge amounts; fail instead of wrapping
            long product = Math.multiplyExact(minor, (long) ratios[i]);
            shares[i] = Math.floorDiv(product, total);
            remainders[i] = Math.floorMod(product, total);
            allocated += shares[i];
        }
        // Hand out the leftover units one by one to the largest remainders (ties: earliest first)
        long leftover = minor - allocated;
        boolean[] given = new boolean[ratios.length];
        for (long k = 0; k < leftover; k++) {
            int best = -1;
            for (int i = 0; i < ratios.length; i++) {
                if (!given[i] && (best < 0 || remainders[i] > remainders[best])) best = i;
            }
            shares[best]++;
            given[best] = true;
        }
        Money[] out = new Money[ratios.length];
        for (int i = 0; i < ratios.length; i++) out[i] = new Money(shares[i], currency);
        return out;
    }

    private void requireSameCurrency(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException("currency mismatch: " + currency + " vs " + other.currency);
        }
    }

    @Override
    public String toString() {
        return BigDecimal.valueOf(minor, currency.getDefaultFractionDigits()).toPlainString() + " " + currency;
    }
}
