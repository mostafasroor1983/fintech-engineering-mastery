package com.fintechmastery.sb4.lesson02;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient
class FrameworkSevenTest {

    static final FakePsp PSP = new FakePsp();

    @DynamicPropertySource
    static void psp(DynamicPropertyRegistry r) {
        r.add("spring.http.serviceclient.psp.base-url", PSP::url);
        r.add("spring.http.serviceclient.psp.read-timeout", () -> "2s");
    }

    @Autowired
    RestTestClient http;

    @Autowired
    ChargeGateway gateway;

    final PspClient.ChargeRequest request = new PspClient.ChargeRequest("tok_1", new BigDecimal("42.00"), "GBP");

    @BeforeEach
    void reset() {
        PSP.reset();
    }

    @Test
    void versionFromHeaderSelectsTheHandler() {
        http.get().uri("/balance").exchange()
                .expectStatus().isOk().expectBody().jsonPath("$.balance").isEqualTo(120.00); // default version 1
        http.get().uri("/balance").header("API-Version", "2").exchange()
                .expectStatus().isOk().expectBody().jsonPath("$.pending.value").isEqualTo(15.25);
        http.get().uri("/balance").header("API-Version", "3").exchange()
                .expectStatus().isBadRequest();                                               // unsupported
    }

    @Test
    void bugRetryWithANewKeyChargesTheCustomerTwice() {
        gateway.chargeUnsafe(request);

        assertThat(PSP.requests).hasValue(2);           // first attempt got a 503, the retry succeeded...
        assertThat(PSP.chargesByKey).hasSize(2);        // ...but the PSP booked TWO charges
    }

    @Test
    void fixSameKeyOnEveryAttemptChargesOnce() {
        PspClient.ChargeResponse r = gateway.charge("order-1001-charge", request);

        assertThat(PSP.requests).hasValue(2);
        assertThat(PSP.chargesByKey).hasSize(1);        // one charge, recognised on retry
        assertThat(r.chargeId()).isEqualTo("ch_0");
    }

    @Test
    void retriesStopAfterMaxRetries() {
        PSP.failFirst = 10;
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> gateway.charge("order-1002-charge", request))
                .isInstanceOf(org.springframework.web.client.HttpServerErrorException.ServiceUnavailable.class);
        assertThat(PSP.requests).hasValue(3);           // 1 call + maxRetries 2
    }
}
