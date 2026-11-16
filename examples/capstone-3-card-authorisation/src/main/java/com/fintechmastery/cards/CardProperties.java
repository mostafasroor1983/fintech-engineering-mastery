package com.fintechmastery.cards;

import java.math.BigDecimal;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("cards")
public record CardProperties(int declineScore, BigDecimal standInLimit, Duration authValidity, Fraud fraud) {

    public record Fraud(int maxConcurrentCalls, CircuitBreaker circuitBreaker) {
    }

    public record CircuitBreaker(float failureRateThreshold, int slidingWindowSize, int minimumNumberOfCalls,
            Duration waitInOpenState) {
    }
}
