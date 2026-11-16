package com.fintechmastery.recon;

public enum BreakType {
    /** Same end-to-end id on both sides, different amount. */
    AMOUNT_MISMATCH,
    /** Bank booked it, our ledger has nothing (bank fees, unexpected incoming money, fraud). */
    MISSING_IN_LEDGER,
    /** Our ledger expected it, the bank has not booked it within the timing tolerance. */
    MISSING_IN_BANK,
    /** The bank reported the same booking reference twice. */
    DUPLICATE_IN_BANK,
    /** A line without end-to-end id fits more than one ledger item; a human must choose. */
    AMBIGUOUS
}
