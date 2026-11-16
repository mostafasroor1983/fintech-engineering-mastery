package com.fintechmastery.sb4.lesson01;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record PaymentView(UUID id, BigDecimal amount, String currency, Instant createdAt) {
}
