package com.fintechmastery.sb4.lesson02;

import java.math.BigDecimal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Two versions of one endpoint in one controller: no copy-pasted /v2 controllers. */
@RestController
class BalanceController {

    record BalanceV1(BigDecimal balance, String currency) {
    }

    record Amount(BigDecimal value, String currency) {
    }

    record BalanceV2(Amount available, Amount pending) {
    }

    @GetMapping(path = "/balance", version = "1")
    BalanceV1 v1() {
        return new BalanceV1(new BigDecimal("120.00"), "GBP");
    }

    @GetMapping(path = "/balance", version = "2")
    BalanceV2 v2() {
        return new BalanceV2(new Amount(new BigDecimal("120.00"), "GBP"), new Amount(new BigDecimal("15.25"), "GBP"));
    }
}
