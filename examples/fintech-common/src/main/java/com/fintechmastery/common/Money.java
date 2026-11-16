package com.fintechmastery.common;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Currency;
import java.util.Objects;

/**
 * An amount of money. The currency always travels with the amount.
 *
 * <p>Rules enforced here (see Track 06, double-entry ledger lesson):
 * <ul>
 *   <li>{@link BigDecimal} only, never float/double.</li>
 *   <li>The scale always equals the currency's minor-unit digits (GBP 2, JPY 0, KWD 3).</li>
 *   <li>Constructing money with more decimals than the currency allows fails loudly
 *       instead of rounding silently. Rounding happens only in {@link #convert}, with an
 *       explicit {@link RoundingMode}.</li>
 * </ul>
 */
public record Money(BigDecimal amount, Currency currency) implements Comparable<Money> {

    public Money {
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(currency, "currency");
        int digits = currency.getDefaultFractionDigits();
        if (digits < 0) {
            throw new IllegalArgumentException("Currency has no minor unit: " + currency);
        }
        try {
            amount = amount.setScale(digits, RoundingMode.UNNECESSARY);
        } catch (ArithmeticException e) {
            throw new IllegalArgumentException(
                    "Amount " + amount.toPlainString() + " has more than " + digits + " decimals for " + currency, e);
        }
    }

    public static Money of(String amount, String currencyCode) {
        return new Money(new BigDecimal(amount), Currency.getInstance(currencyCode));
    }

    public static Money of(BigDecimal amount, String currencyCode) {
        return new Money(amount, Currency.getInstance(currencyCode));
    }

    public static Money zero(Currency currency) {
        return new Money(BigDecimal.ZERO, currency);
    }

    /** Builds money from minor units, e.g. 1050 GBP pence = 10.50 GBP. */
    public static Money ofMinor(long minorUnits, String currencyCode) {
        Currency c = Currency.getInstance(currencyCode);
        return new Money(BigDecimal.valueOf(minorUnits, c.getDefaultFractionDigits()), c);
    }

    public long toMinorUnits() {
        return amount.movePointRight(currency.getDefaultFractionDigits()).longValueExact();
    }

    public String currencyCode() {
        return currency.getCurrencyCode();
    }

    public Money plus(Money other) {
        requireSameCurrency(other);
        return new Money(amount.add(other.amount), currency);
    }

    public Money minus(Money other) {
        requireSameCurrency(other);
        return new Money(amount.subtract(other.amount), currency);
    }

    public Money negate() {
        return new Money(amount.negate(), currency);
    }

    public boolean isPositive() {
        return amount.signum() > 0;
    }

    public boolean isNegative() {
        return amount.signum() < 0;
    }

    public boolean isZero() {
        return amount.signum() == 0;
    }

    public boolean isGreaterThan(Money other) {
        return compareTo(other) > 0;
    }

    /**
     * Converts to another currency at {@code rate} (units of target per one unit of this currency).
     * The caller chooses the rounding mode, because who absorbs the fraction is a business decision.
     */
    public Money convert(Currency target, BigDecimal rate, RoundingMode rounding) {
        Objects.requireNonNull(rate, "rate");
        Objects.requireNonNull(rounding, "rounding");
        if (rate.signum() <= 0) {
            throw new IllegalArgumentException("FX rate must be positive");
        }
        BigDecimal converted = amount.multiply(rate).setScale(target.getDefaultFractionDigits(), rounding);
        return new Money(converted, target);
    }

    @Override
    public int compareTo(Money other) {
        requireSameCurrency(other);
        return amount.compareTo(other.amount);
    }

    private void requireSameCurrency(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException("Currency mismatch: " + currency + " vs " + other.currency);
        }
    }

    @Override
    public String toString() {
        return amount.toPlainString() + " " + currency.getCurrencyCode();
    }
}
