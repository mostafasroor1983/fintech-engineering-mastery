package com.fintechmastery.cards;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fintechmastery.common.Money;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "cards.fraud.max-concurrent-calls=3",
        "cards.fraud.circuit-breaker.wait-in-open-state=60s"})
@AutoConfigureRestTestClient
@Import(TestcontainersConfig.class)
class CardLifecycleTest {

    static final FakeFraudServer FRAUD = new FakeFraudServer();

    @DynamicPropertySource
    static void fraudUrl(DynamicPropertyRegistry registry) {
        registry.add("spring.http.serviceclient.fraud.base-url", FRAUD::url);
    }

    @Autowired
    CardService cards;

    @Autowired
    FraudCheck fraudCheck;

    @Autowired
    JdbcClient jdbc;

    @Autowired
    RestTestClient http;

    @BeforeEach
    void reset() {
        FRAUD.reset();
        fraudCheck.resetCircuit(); // each test starts with a closed circuit
    }

    CardAuthorisation authorise(String amount) {
        return cards.authorise("tok_abcdefgh1234", "shop-1", Money.of(amount, "GBP"));
    }

    @Test
    void happyPathAuthoriseCaptureRefund() {
        CardAuthorisation a = authorise("100.00");
        assertThat(a.status()).isEqualTo(CardStatus.AUTHORISED);

        cards.apply(a.publicId(), new CardCommand.Capture("cap-1", Money.of("60.00", "GBP")));
        cards.apply(a.publicId(), new CardCommand.Capture("cap-2", Money.of("40.00", "GBP"))); // multi-capture
        CardAuthorisation refunded = cards.apply(a.publicId(), new CardCommand.Refund("ref-1", Money.of("25.00", "GBP")));

        assertThat(refunded.status()).isEqualTo(CardStatus.REFUNDED);
        assertThat(refunded.captured()).isEqualTo(Money.of("100.00", "GBP"));
        assertThat(refunded.refunded()).isEqualTo(Money.of("25.00", "GBP"));
        assertThat(jdbc.sql("SELECT count(*) FROM card_operation WHERE auth_id = :id")
                .param("id", refunded.id()).query(Long.class).single()).isEqualTo(3); // audit trail
    }

    @Test
    void illegalTransitionsAreRejected() {
        CardAuthorisation a = authorise("50.00");
        assertThatThrownBy(() -> cards.apply(a.publicId(), new CardCommand.Refund("r-1", Money.of("1.00", "GBP"))))
                .isInstanceOf(CardOperationRejectedException.class).hasMessageContaining("Cannot refund");
        assertThatThrownBy(() -> cards.apply(a.publicId(), new CardCommand.Capture("c-1", Money.of("50.01", "GBP"))))
                .hasMessageContaining("capture more than authorised");

        cards.apply(a.publicId(), new CardCommand.Reverse("rev-1"));
        assertThatThrownBy(() -> cards.apply(a.publicId(), new CardCommand.Capture("c-2", Money.of("1.00", "GBP"))))
                .hasMessageContaining("Cannot capture");
    }

    @Test
    void chargebackCannotExceedWhatIsLeftAfterRefunds() {
        CardAuthorisation a = authorise("100.00");
        cards.apply(a.publicId(), new CardCommand.Capture("cb-cap", Money.of("100.00", "GBP")));
        cards.apply(a.publicId(), new CardCommand.Refund("cb-ref", Money.of("30.00", "GBP")));

        assertThatThrownBy(() -> cards.apply(a.publicId(), new CardCommand.Chargeback("cb-1", Money.of("70.01", "GBP"))))
                .hasMessageContaining("charge back more than the unrefunded amount");
        assertThat(cards.apply(a.publicId(), new CardCommand.Chargeback("cb-2", Money.of("70.00", "GBP"))).status())
                .isEqualTo(CardStatus.CHARGED_BACK);
    }

    @Test
    void sameOperationIdIsAppliedOnce() {
        CardAuthorisation a = authorise("100.00");
        cards.apply(a.publicId(), new CardCommand.Capture("dup-cap", Money.of("10.00", "GBP")));
        CardAuthorisation again = cards.apply(a.publicId(), new CardCommand.Capture("dup-cap", Money.of("10.00", "GBP")));
        assertThat(again.captured()).isEqualTo(Money.of("10.00", "GBP"));
    }

    @Test
    void concurrentPartialCapturesNeverExceedTheAuthorisedAmount() throws Exception {
        // 10 concurrent captures of 30.00 against 100.00: optimistic locking + @Retryable re-validates
        // each loser against fresh state, so exactly 3 succeed.
        CardAuthorisation a = authorise("100.00");
        List<Future<Boolean>> results = new ArrayList<>();
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 10; i++) {
                String op = "par-" + i;
                results.add(pool.submit(() -> {
                    try {
                        cards.apply(a.publicId(), new CardCommand.Capture(op, Money.of("30.00", "GBP")));
                        return true;
                    } catch (CardOperationRejectedException e) {
                        return false;
                    }
                }));
            }
        }
        long ok = results.stream().filter(f -> f.resultNow()).count();
        assertThat(ok).isEqualTo(3);
        assertThat(cards.get(a.publicId()).captured()).isEqualTo(Money.of("90.00", "GBP"));
    }

    @Test
    void highFraudScoreIsDeclined() {
        FRAUD.score = 95;
        CardAuthorisation a = authorise("20.00");
        assertThat(a.status()).isEqualTo(CardStatus.DECLINED);
        assertThat(a.decisionReason()).isEqualTo("FRAUD_SUSPECTED");
    }

    @Test
    void slowFraudEngineTimesOutAndFallsBackToStandInRules() {
        FRAUD.mode = FakeFraudServer.Mode.SLOW; // 1 s, read-timeout is 300 ms
        long start = System.nanoTime();
        CardAuthorisation small = authorise("20.00");
        Duration took = Duration.ofNanos(System.nanoTime() - start);

        assertThat(took).isLessThan(Duration.ofMillis(900)); // we did not wait for the slow server
        assertThat(small.status()).isEqualTo(CardStatus.AUTHORISED);
        assertThat(small.decisionReason()).isEqualTo("APPROVED_STAND_IN");

        CardAuthorisation large = authorise("500.00");
        assertThat(large.status()).isEqualTo(CardStatus.DECLINED);
        assertThat(large.decisionReason()).isEqualTo("FRAUD_CHECK_UNAVAILABLE");
    }

    @Test
    void circuitOpensAfterRepeatedFailuresAndStopsCallingTheFraudEngine() {
        FRAUD.mode = FakeFraudServer.Mode.ERROR;
        for (int i = 0; i < 5; i++) {
            authorise("10.00"); // minimum-number-of-calls = 5, all failing
        }
        assertThat(fraudCheck.circuitState()).isEqualTo(CircuitBreaker.State.OPEN);
        int callsBefore = FRAUD.calls.get();

        CardAuthorisation a = authorise("10.00");
        assertThat(a.decisionReason()).isEqualTo("APPROVED_STAND_IN");
        assertThat(FRAUD.calls.get()).isEqualTo(callsBefore); // short-circuited: no remote call
    }

    @Test
    void bulkheadRejectsExcessConcurrentCallsInsteadOfQueueing() throws Exception {
        FRAUD.mode = FakeFraudServer.Mode.SLOW;
        FRAUD.slowMillis = 250; // under the timeout, so calls hold their permit for a while
        List<Future<CardAuthorisation>> results = new ArrayList<>();
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 12; i++) {
                results.add(pool.submit(() -> authorise("10.00")));
            }
        }
        long standIn = results.stream().filter(f -> f.resultNow().decisionReason().equals("APPROVED_STAND_IN")).count();
        assertThat(FRAUD.calls.get()).isLessThan(12);   // limit 3: most callers never reached the server
        assertThat(standIn).isGreaterThan(0);
    }

    @Test
    void httpApiReturnsProblemDetailForIllegalOperation() {
        UUID id = authorise("10.00").publicId();
        http.post().uri("/v1/authorisations/{id}/refunds", id)
                .header("Idempotency-Key", "refund-0001")
                .contentType(MediaType.APPLICATION_JSON).body("{\"amount\":5.00,\"currency\":\"GBP\"}")
                .exchange()
                .expectStatus().isEqualTo(409)
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody().jsonPath("$.title").isEqualTo("Operation not allowed");

        http.post().uri("/v1/authorisations")
                .contentType(MediaType.APPLICATION_JSON)
                .body("{\"cardToken\":\"4111111111111111\",\"merchantId\":\"shop-1\",\"amount\":5.00,\"currency\":\"GBP\"}")
                .exchange()
                .expectStatus().isBadRequest(); // a raw PAN is not a token: rejected at the edge
    }
}
