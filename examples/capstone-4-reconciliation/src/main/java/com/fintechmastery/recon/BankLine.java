package com.fintechmastery.recon;

import com.fintechmastery.common.Money;
import java.time.LocalDate;
import org.jspecify.annotations.Nullable;

/** One booked entry (Ntry) from a bank statement. endToEndId is null when the bank sent NOTPROVIDED. */
public record BankLine(String bankRef, @Nullable String endToEndId, Money amount, Direction direction,
        LocalDate valueDate, @Nullable String remittanceInfo) {
}
