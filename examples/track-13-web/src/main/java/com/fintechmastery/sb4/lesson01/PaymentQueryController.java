package com.fintechmastery.sb4.lesson01;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
class PaymentQueryController {

    @GetMapping("/payments/{id}")
    PaymentView get(@PathVariable UUID id) {
        return new PaymentView(id, new BigDecimal("10.50"), "GBP", Instant.parse("2026-11-12T09:30:00Z"));
    }
}
