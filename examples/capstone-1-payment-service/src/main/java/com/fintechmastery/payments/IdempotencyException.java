package com.fintechmastery.payments;

/** Same Idempotency-Key reused with a different request body. */
public class IdempotencyException extends RuntimeException {

    public IdempotencyException(String message) {
        super(message);
    }
}
