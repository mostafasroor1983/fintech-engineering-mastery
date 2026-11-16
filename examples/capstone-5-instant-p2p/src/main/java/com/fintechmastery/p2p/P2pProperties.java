package com.fintechmastery.p2p;

import java.time.Duration;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("p2p")
public record P2pProperties(RateLimit rateLimit, Webhooks webhooks) {

    public record Tier(int capacity, double refillPerSecond) {
    }

    public record RateLimit(String defaultTier, Map<String, Tier> tiers, Map<String, String> tenantTiers, boolean failOpen) {

        Tier tierFor(String tenant) {
            return tiers.get(tenantTiers.getOrDefault(tenant, defaultTier));
        }
    }

    public record Webhooks(int maxAttempts, Duration baseBackoff, Duration maxBackoff, Duration lease, int batchSize,
            boolean allowInsecureLocalhost, boolean dispatchEnabled, Duration dispatchInterval) {
    }
}
