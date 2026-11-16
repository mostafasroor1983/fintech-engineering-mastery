package com.fintechmastery.cards;

import com.fintechmastery.common.Money;

/** Every operation after authorisation. Sealed, so the state machine's switch is checked by the compiler. */
public sealed interface CardCommand {

    String operationId();

    record Capture(String operationId, Money amount) implements CardCommand {
    }

    record Reverse(String operationId) implements CardCommand {
    }

    record Refund(String operationId, Money amount) implements CardCommand {
    }

    record Chargeback(String operationId, Money amount) implements CardCommand {
    }
}
