package com.fintechmastery.payments;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record PaymentResponse(UUID id, String status, BigDecimal amount, String currency, String debtorAccount,
        String creditorAccount, Instant createdAt) {

    static PaymentResponse from(Payment p) {
        return new PaymentResponse(p.publicId(), p.status().name(), p.amount().amount(), p.amount().currencyCode(),
                p.debtorAccount(), p.creditorAccount(), p.createdAt());
    }
}
