package com.fintechmastery.wallet;

import com.fintechmastery.common.Money;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Instant;
import java.util.Currency;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Quotes a rate the customer can accept for a short time, then consumes it exactly once.
 * Rounding: the customer receives the buy amount rounded DOWN; the fraction stays with the house.
 * That is a business rule, so it is written down here and tested.
 */
@Service
public class FxService {

    private static final BigDecimal TEN_THOUSAND = BigDecimal.valueOf(10_000);

    private final JdbcClient jdbc;
    private final WalletProperties props;
    private final Clock clock;

    public FxService(JdbcClient jdbc, WalletProperties props, Clock clock) {
        this.jdbc = jdbc;
        this.props = props;
        this.clock = clock;
    }

    @Transactional
    public FxQuote quote(Money sell, Currency buyCurrency) {
        BigDecimal mid = props.fx().midRates().get(sell.currencyCode() + "-" + buyCurrency.getCurrencyCode());
        if (mid == null) {
            throw new IllegalArgumentException("Unsupported currency pair");
        }
        BigDecimal spread = BigDecimal.valueOf(props.fx().spreadBps()).divide(TEN_THOUSAND, MathContext.DECIMAL64);
        BigDecimal rate = mid.multiply(BigDecimal.ONE.subtract(spread)).setScale(8, RoundingMode.DOWN);
        Money buy = sell.convert(buyCurrency, rate, RoundingMode.DOWN);
        if (!buy.isPositive()) {
            throw new IllegalArgumentException("Amount too small to convert");
        }
        Instant expiresAt = clock.instant().plus(props.fx().quoteTtl());
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                INSERT INTO fx_quote (id, sell_currency, buy_currency, rate, sell_minor, buy_minor, expires_at)
                VALUES (:id, :sellCcy, :buyCcy, :rate, :sellMinor, :buyMinor, :expiresAt)
                """)
                .param("id", id).param("sellCcy", sell.currencyCode()).param("buyCcy", buy.currencyCode())
                .param("rate", rate).param("sellMinor", sell.toMinorUnits()).param("buyMinor", buy.toMinorUnits())
                .param("expiresAt", java.sql.Timestamp.from(expiresAt))
                .update();
        return new FxQuote(id, sell, buy, rate, expiresAt);
    }

    /** Marks the quote used. The WHERE clause makes "use once, before expiry" atomic. */
    @Transactional(propagation = Propagation.MANDATORY)
    public FxQuote consume(UUID quoteId) {
        record Row(String sellCurrency, String buyCurrency, BigDecimal rate, long sellMinor, long buyMinor,
                java.sql.Timestamp expiresAt) {
        }
        Row row = jdbc.sql("""
                UPDATE fx_quote SET used_at = :now
                WHERE id = :id AND used_at IS NULL AND expires_at > :now
                RETURNING sell_currency, buy_currency, rate, sell_minor, buy_minor, expires_at
                """)
                .param("id", quoteId).param("now", java.sql.Timestamp.from(clock.instant()))
                .query(Row.class).optional()
                .orElseThrow(QuoteUnavailableException::new);
        return new FxQuote(quoteId, Money.ofMinor(row.sellMinor(), row.sellCurrency()),
                Money.ofMinor(row.buyMinor(), row.buyCurrency()), row.rate(), row.expiresAt().toInstant());
    }
}
