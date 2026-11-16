package com.fintechmastery.sb4.lesson02;

import java.math.BigDecimal;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.service.annotation.PostExchange;

/** HTTP Service Client: an interface; base URL and timeouts come from spring.http.serviceclient.psp.*. */
public interface PspClient {

    record ChargeRequest(String cardToken, BigDecimal amount, String currency) {
    }

    record ChargeResponse(String chargeId, String status) {
    }

    @PostExchange("/charges")
    ChargeResponse charge(@RequestHeader("Idempotency-Key") String idempotencyKey, @RequestBody ChargeRequest request);
}
