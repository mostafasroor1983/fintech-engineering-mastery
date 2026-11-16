package com.fintechmastery.payments;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.client.EntityExchangeResult;

class PaymentApiTest extends IntegrationTest {

    EntityExchangeResult<PaymentResponse> post(String merchant, String key, String json) {
        return http.post().uri("/v1/payments")
                .header("X-Merchant-Id", merchant)
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .body(json)
                .exchange()
                .expectBody(PaymentResponse.class)
                .returnResult();
    }

    @Test
    void createsPaymentAndOutboxEventInOneTransaction() {
        var result = post("acme", "key-00000001", body("10.50", "GBP"));

        assertThat(result.getStatus()).isEqualTo(HttpStatus.CREATED);
        assertThat(result.getResponseBody().amount()).isEqualByComparingTo("10.50");
        assertThat(result.getResponseHeaders().getFirst("Idempotent-Replayed")).isEqualTo("false");
        assertThat(count("payment")).isEqualTo(1);
        assertThat(count("outbox_event WHERE published_at IS NULL")).isEqualTo(1);
    }

    @Test
    void retryWithSameKeyReplaysTheOriginalResponse() {
        var first = post("acme", "key-00000002", body("10.50", "GBP"));
        var retry = post("acme", "key-00000002", body("10.50", "GBP"));

        assertThat(retry.getStatus()).isEqualTo(HttpStatus.CREATED);
        assertThat(retry.getResponseBody().id()).isEqualTo(first.getResponseBody().id());
        assertThat(retry.getResponseHeaders().getFirst("Idempotent-Replayed")).isEqualTo("true");
        assertThat(count("payment")).isEqualTo(1);
        assertThat(count("outbox_event")).isEqualTo(1);
    }

    @Test
    void sameKeyIsScopedPerMerchant() {
        post("acme", "key-00000003", body("10.50", "GBP"));
        post("globex", "key-00000003", body("10.50", "GBP"));
        assertThat(count("payment")).isEqualTo(2);
    }

    @Test
    void sameKeyWithDifferentBodyIsRejected() {
        post("acme", "key-00000004", body("10.50", "GBP"));

        http.post().uri("/v1/payments")
                .header("X-Merchant-Id", "acme").header("Idempotency-Key", "key-00000004")
                .contentType(MediaType.APPLICATION_JSON).body(body("99.00", "GBP"))
                .exchange()
                .expectStatus().isEqualTo(422)
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody().jsonPath("$.title").isEqualTo("Idempotency key reuse");
        assertThat(count("payment")).isEqualTo(1);
    }

    @Test
    void concurrentDuplicatesCreateExactlyOnePayment() throws Exception {
        // The bug this prevents: "SELECT key; if absent INSERT payment" lets two threads both see "absent".
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<EntityExchangeResult<PaymentResponse>>> calls = IntStream.range(0, 20)
                    .mapToObj(i -> pool.submit(() -> post("acme", "key-concurrent", body("25.00", "EUR"))))
                    .toList();
            List<UUID> ids = calls.stream().map(f -> {
                try {
                    var r = f.get();
                    assertThat(r.getStatus()).isEqualTo(HttpStatus.CREATED);
                    return r.getResponseBody().id();
                } catch (Exception e) {
                    throw new AssertionError(e);
                }
            }).distinct().toList();
            assertThat(ids).hasSize(1);
        }
        assertThat(count("payment")).isEqualTo(1);
        assertThat(count("outbox_event")).isEqualTo(1);
    }

    @Test
    void tooManyDecimalsForTheCurrencyIsRejectedNotRounded() {
        http.post().uri("/v1/payments")
                .header("X-Merchant-Id", "acme").header("Idempotency-Key", "key-00000005")
                .contentType(MediaType.APPLICATION_JSON).body(body("10.005", "GBP"))
                .exchange()
                .expectStatus().isBadRequest()
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON);
        assertThat(count("payment")).isZero();
        assertThat(count("idempotency_key")).isZero(); // the whole transaction rolled back
    }

    @Test
    void invalidInputAndMissingKeyAreRejected() {
        http.post().uri("/v1/payments")
                .header("X-Merchant-Id", "acme").header("Idempotency-Key", "key-00000006")
                .contentType(MediaType.APPLICATION_JSON)
                .body(body("10.00", "GBP").replace("GB33BUKB20201555555555", "not-an-iban"))
                .exchange()
                .expectStatus().isBadRequest();

        http.post().uri("/v1/payments")
                .header("X-Merchant-Id", "acme")
                .contentType(MediaType.APPLICATION_JSON).body(body("10.00", "GBP"))
                .exchange()
                .expectStatus().isBadRequest();
    }

    @Test
    void anotherMerchantCannotReadMyPayment() {
        UUID id = post("acme", "key-00000007", body("10.50", "GBP")).getResponseBody().id();

        http.get().uri("/v1/payments/{id}", id).header("X-Merchant-Id", "acme")
                .exchange().expectStatus().isOk();
        http.get().uri("/v1/payments/{id}", id).header("X-Merchant-Id", "globex")
                .exchange().expectStatus().isNotFound();
    }

    @Test
    void unsupportedApiVersionIsRejected() {
        http.post().uri("/v2/payments")
                .header("X-Merchant-Id", "acme").header("Idempotency-Key", "key-00000008")
                .contentType(MediaType.APPLICATION_JSON).body(body("10.50", "GBP"))
                .exchange()
                .expectStatus().isBadRequest();
    }
}
