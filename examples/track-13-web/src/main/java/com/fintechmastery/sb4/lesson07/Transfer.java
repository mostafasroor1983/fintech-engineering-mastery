package com.fintechmastery.sb4.lesson07;

import java.math.BigDecimal;
import java.time.Instant;

/** A POJO (not a record) on purpose: property order and null handling differ between Jackson 2 and 3. */
public class Transfer {

    public String reference;
    public BigDecimal amount;
    public String currency;
    public int attempts;
    public Instant bookedAt;
}
