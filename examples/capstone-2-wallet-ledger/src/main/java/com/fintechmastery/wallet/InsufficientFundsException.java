package com.fintechmastery.wallet;

import java.util.UUID;

public class InsufficientFundsException extends RuntimeException {

    public InsufficientFundsException(UUID account) {
        super("Insufficient funds in account " + account);
    }
}
