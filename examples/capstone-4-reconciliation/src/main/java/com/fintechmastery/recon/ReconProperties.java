package com.fintechmastery.recon;

import java.math.BigDecimal;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("recon")
public record ReconProperties(Duration timingTolerance, Duration fuzzyDateWindow, BigDecimal fourEyesThreshold,
        int maxFileBytes) {
}
