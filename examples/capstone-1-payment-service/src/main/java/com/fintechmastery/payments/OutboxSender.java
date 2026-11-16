package com.fintechmastery.payments;

/** Publishes one outbox row and returns only after the broker acknowledged it (or throws). */
@FunctionalInterface
public interface OutboxSender {

    void send(String key, String payload) throws Exception;
}
