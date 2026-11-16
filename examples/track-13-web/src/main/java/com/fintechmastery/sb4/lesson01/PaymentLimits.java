package com.fintechmastery.sb4.lesson01;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.math.BigDecimal;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Typed, immutable, validated configuration. A bad value stops the application at start-up,
 * not at 3 a.m. when the first large payment arrives.
 */
@Validated
@ConfigurationProperties("payments.limits")
public record PaymentLimits(
        @NotNull @DecimalMin("0.01") BigDecimal maxSinglePayment,
        @NotNull @Pattern(regexp = "[A-Z]{3}") String currency,
        @NotNull Duration quoteTtl) {
}
