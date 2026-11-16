package com.fintechmastery.sb4.lesson07;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.math.BigDecimal;
import java.time.Instant;

/**
 * The fix for a public contract: pin the order explicitly, and make "may be missing or null"
 * fields nullable wrappers instead of primitives. (jackson-annotations keeps the com.fasterxml
 * package in Jackson 3.)
 */
@JsonPropertyOrder({"reference", "amount", "currency", "attempts", "bookedAt"})
public class TransferV2 {

    public String reference;
    public BigDecimal amount;
    public String currency;
    public Integer attempts;
    public Instant bookedAt;
}
