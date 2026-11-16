package com.fintechmastery.wallet;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("wallet")
public record WalletProperties(Fx fx) {

    /** midRates key format: "GBP-EUR" = how many EUR one GBP buys at mid-market. */
    public record Fx(Duration quoteTtl, int spreadBps, Map<String, BigDecimal> midRates) {
    }
}
