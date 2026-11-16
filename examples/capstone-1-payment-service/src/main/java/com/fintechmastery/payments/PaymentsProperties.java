package com.fintechmastery.payments;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("payments")
public record PaymentsProperties(String topic, Outbox outbox) {

    public record Outbox(boolean relayEnabled, int batchSize, Duration pollInterval) {
    }
}
