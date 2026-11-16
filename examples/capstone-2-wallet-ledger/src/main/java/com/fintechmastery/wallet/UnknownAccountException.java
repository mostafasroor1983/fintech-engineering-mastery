package com.fintechmastery.wallet;

import java.util.UUID;

public class UnknownAccountException extends RuntimeException {

    public UnknownAccountException(UUID id) {
        super("Unknown account " + id);
    }
}
