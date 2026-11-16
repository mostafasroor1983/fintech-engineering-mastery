package com.fintechmastery.cards;

import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.service.annotation.PostExchange;

/**
 * HTTP Service Client (Spring Framework 7 / Boot 4): Spring generates the implementation.
 * Base URL and timeouts come from spring.http.serviceclient.fraud.*.
 */
public interface FraudClient {

    record ScoreRequest(String cardToken, String merchantId, long amountMinor, String currency) {
    }

    record ScoreResponse(int score) {
    }

    @PostExchange("/v1/score")
    ScoreResponse score(@RequestBody ScoreRequest request);
}
