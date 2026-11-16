package com.fintechmastery.wallet;

import com.fintechmastery.common.Money;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record FxQuote(UUID id, Money sell, Money buy, BigDecimal rate, Instant expiresAt) {
}
