package com.fintechmastery.recon;

import com.fintechmastery.common.Money;
import java.time.LocalDate;
import java.util.List;

/** A parsed CAMT.053 statement. Balances are signed: a DBIT balance is negative. */
public record Statement(String statementId, String iban, String currency, LocalDate statementDate,
        Money opening, Money closing, List<BankLine> lines) {
}
