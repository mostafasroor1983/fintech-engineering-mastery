package com.fintechmastery.wallet;

public enum AccountType {
    /** A customer's money. Can never go below zero. */
    CUSTOMER_WALLET,
    /** The house's position in one currency, used as the other side of FX trades. */
    FX_POSITION,
    /** Money entering from outside (card top-up, bank transfer). Mirrors a bank account we hold. */
    FUNDING
}
