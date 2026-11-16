package com.fintechmastery.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Currency;
import org.junit.jupiter.api.Test;

class MoneyTest {

    @Test
    void scaleFollowsTheCurrency() {
        assertThat(Money.of("10", "GBP").amount()).isEqualByComparingTo("10.00").hasScaleOf(2);
        assertThat(Money.of("10", "JPY").amount()).hasScaleOf(0);
        assertThat(Money.of("1.5", "KWD").amount()).hasScaleOf(3);
    }

    @Test
    void refusesToSilentlyRoundExtraDecimals() {
        assertThatThrownBy(() -> Money.of("10.005", "GBP"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("more than 2 decimals");
        assertThatThrownBy(() -> Money.of("1.5", "JPY")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void doubleArithmeticIsWhyWeUseBigDecimal() {
        // The bug: 0.1 + 0.2 in double is 0.30000000000000004
        assertThat(0.1 + 0.2).isNotEqualTo(0.3);
        // The fix:
        assertThat(Money.of("0.10", "EUR").plus(Money.of("0.20", "EUR"))).isEqualTo(Money.of("0.30", "EUR"));
    }

    @Test
    void mixingCurrenciesFails() {
        assertThatThrownBy(() -> Money.of("1", "GBP").plus(Money.of("1", "EUR")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Currency mismatch");
    }

    @Test
    void minorUnitsRoundTrip() {
        assertThat(Money.ofMinor(1050, "GBP")).isEqualTo(Money.of("10.50", "GBP"));
        assertThat(Money.of("10.50", "GBP").toMinorUnits()).isEqualTo(1050);
        assertThat(Money.ofMinor(500, "JPY").toMinorUnits()).isEqualTo(500);
    }

    @Test
    void conversionUsesExplicitRounding() {
        Money gbp = Money.of("100.00", "GBP");
        Currency eur = Currency.getInstance("EUR");
        BigDecimal rate = new BigDecimal("1.157349");
        assertThat(gbp.convert(eur, rate, RoundingMode.HALF_EVEN)).isEqualTo(Money.of("115.73", "EUR"));
        assertThat(gbp.convert(eur, rate, RoundingMode.UP)).isEqualTo(Money.of("115.74", "EUR"));
    }

    @Test
    void currencyWithoutMinorUnitIsRejected() {
        assertThatThrownBy(() -> Money.zero(Currency.getInstance("XXX"))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void hmacAndConstantTimeCompare() {
        String sig = Hashing.hmacSha256Hex("secret".getBytes(), "payload");
        assertThat(sig).hasSize(64);
        assertThat(Hashing.constantTimeEquals(sig, Hashing.hmacSha256Hex("secret".getBytes(), "payload"))).isTrue();
        assertThat(Hashing.constantTimeEquals(sig, Hashing.hmacSha256Hex("other".getBytes(), "payload"))).isFalse();
    }
}
