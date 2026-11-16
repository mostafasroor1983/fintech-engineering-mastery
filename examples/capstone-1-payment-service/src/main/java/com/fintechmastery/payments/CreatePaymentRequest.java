package com.fintechmastery.payments;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;

/** Input is validated at the edge: format, size and range. Never trust the client. */
public record CreatePaymentRequest(
        @NotBlank @Pattern(regexp = "[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}", message = "must be an IBAN") String debtorAccount,
        @NotBlank @Pattern(regexp = "[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}", message = "must be an IBAN") String creditorAccount,
        @NotNull @DecimalMin(value = "0.01") @Digits(integer = 12, fraction = 3) BigDecimal amount,
        @NotNull @Pattern(regexp = "[A-Z]{3}", message = "must be an ISO 4217 code") String currency,
        @Size(max = 140) @Pattern(regexp = "[\\p{L}\\p{N} .,/\\-]*", message = "contains illegal characters") String reference) {

    /** A stable string of every business field. Its hash detects "same key, different body". */
    String canonical() {
        return String.join("|", debtorAccount, creditorAccount, amount.stripTrailingZeros().toPlainString(), currency,
                reference == null ? "" : reference);
    }
}
