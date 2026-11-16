package com.fintechmastery.wallet;

import static org.assertj.core.api.Assertions.assertThat;

import com.fintechmastery.common.Money;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient
@Import(TestcontainersConfig.class)
class WalletApiTest {

    @Autowired
    RestTestClient http;

    @Autowired
    WalletService wallets;

    UUID open(String owner, String ccy) {
        return http.post().uri("/v1/wallets").contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("ownerId", owner, "currency", ccy))
                .exchange().expectStatus().isCreated()
                .expectBody(WalletController.AccountView.class).returnResult().getResponseBody().id();
    }

    @Test
    void transferAndFxOverHttp() {
        UUID a = open("api-a-" + UUID.randomUUID().toString().substring(0, 8), "GBP");
        UUID b = open("api-b-" + UUID.randomUUID().toString().substring(0, 8), "EUR");
        UUID c = open("api-c-" + UUID.randomUUID().toString().substring(0, 8), "GBP");
        wallets.deposit("api-dep-" + a, a, Money.of("50.00", "GBP"));

        http.post().uri("/v1/transfers").header("Idempotency-Key", "api-t-" + a.toString().substring(0, 8))
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("from", a, "to", c, "amount", "60.00", "currency", "GBP"))
                .exchange().expectStatus().isEqualTo(422)
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody().jsonPath("$.title").isEqualTo("Insufficient funds");

        FxQuote q = http.post().uri("/v1/fx/quotes").contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("sellAmount", "20.00", "sellCurrency", "GBP", "buyCurrency", "EUR"))
                .exchange().expectStatus().isCreated()
                .expectBody(FxQuote.class).returnResult().getResponseBody();

        http.post().uri("/v1/fx/transfers").header("Idempotency-Key", "api-fx-" + a.toString().substring(0, 8))
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("quoteId", q.id(), "from", a, "to", b))
                .exchange().expectStatus().isCreated();

        var view = http.get().uri("/v1/wallets/{id}", b).exchange().expectStatus().isOk()
                .expectBody(WalletController.AccountView.class).returnResult().getResponseBody();
        assertThat(view.balance()).isEqualByComparingTo(q.buy().amount());
    }

    @Test
    void invalidCurrencyIsRejectedAtTheEdge() {
        http.post().uri("/v1/wallets").contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("ownerId", "x", "currency", "gbp"))
                .exchange().expectStatus().isBadRequest();
    }
}
