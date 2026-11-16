package com.fintechmastery.payments;

/** Accepted by the API, then handed to settlement asynchronously via the outbox. */
public enum PaymentStatus {
    ACCEPTED,
    SETTLEMENT_REQUESTED;

    boolean canMoveTo(PaymentStatus next) {
        return this == ACCEPTED && next == SETTLEMENT_REQUESTED;
    }
}
