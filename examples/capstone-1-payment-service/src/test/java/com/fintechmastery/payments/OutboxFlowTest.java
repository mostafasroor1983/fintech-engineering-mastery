package com.fintechmastery.payments;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.ArrayList;
import java.util.List;
import org.apache.kafka.clients.consumer.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

class OutboxFlowTest extends IntegrationTest {

    @Autowired
    OutboxRelay relay;

    @Autowired
    TransactionTemplate tx;

    @Autowired
    PaymentsProperties props;

    @Autowired
    PaymentRepository payments;

    @Autowired
    KafkaTemplate<String, String> kafka;

    @Autowired
    JsonMapper json;

    UUID createPayment(String key) {
        return http.post().uri("/v1/payments")
                .header("X-Merchant-Id", "acme").header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON).body(body("42.00", "EUR"))
                .exchange()
                .expectStatus().isCreated()
                .expectBody(PaymentResponse.class).returnResult().getResponseBody().id();
    }

    @Test
    void relayPublishesAndConsumerRequestsSettlement() {
        UUID id = createPayment("key-outbox-1");

        assertThat(relay.publishPending()).isEqualTo(1);
        assertThat(count("outbox_event WHERE published_at IS NULL")).isZero();

        await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                assertThat(payments.findByPublicId(id).orElseThrow().status())
                        .isEqualTo(PaymentStatus.SETTLEMENT_REQUESTED));
        assertThat(count("settlement_instruction")).isEqualTo(1);
    }

    @Test
    void brokerDownKeepsEventsInTheOutboxUntilItRecovers() {
        createPayment("key-outbox-2");
        OutboxRelay brokenRelay = new OutboxRelay(jdbc, tx, (key, payload) -> {
            throw new java.io.IOException("broker unreachable");
        }, props);

        // Failure: the send fails, the transaction rolls back, nothing is marked published.
        assertThatThrownBy(brokenRelay::publishPending).hasMessageContaining("Broker send failed");
        assertThat(count("outbox_event WHERE published_at IS NULL")).isEqualTo(1);
        assertThat(count("payment")).isEqualTo(1); // the payment itself was never at risk

        // Recovery: the next healthy run publishes it.
        assertThat(relay.publishPending()).isEqualTo(1);
        assertThat(count("outbox_event WHERE published_at IS NULL")).isZero();
    }

    @Test
    void duplicateDeliveryIsAppliedOnce() throws Exception {
        UUID id = createPayment("key-outbox-3");
        String payload = jdbc.sql("SELECT payload FROM outbox_event").query(String.class).single();

        // At-least-once delivery: the same event arrives twice.
        kafka.send(props.topic(), id.toString(), payload).get();
        kafka.send(props.topic(), id.toString(), payload).get();

        await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                assertThat(count("processed_event")).isEqualTo(1));
        // Give the duplicate time to arrive, then check it changed nothing.
        await().pollDelay(Duration.ofSeconds(2)).atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(count("settlement_instruction")).isEqualTo(1));
    }

    @Test
    void poisonMessageGoesToDeadLetterTopicAndDoesNotBlockTheNextOne() {
        String unknownPayment = json.writeValueAsString(new PaymentService.PaymentAcceptedEvent(
                UUID.randomUUID(), UUID.randomUUID(), 100, "EUR", Instant.now()));
        kafka.send(props.topic(), "poison", unknownPayment);

        UUID id = createPayment("key-outbox-4");
        relay.publishPending();

        await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                assertThat(payments.findByPublicId(id).orElseThrow().status())
                        .isEqualTo(PaymentStatus.SETTLEMENT_REQUESTED));

        try (Consumer<String, String> dlt = consumers.createConsumer("dlt-check-" + UUID.randomUUID(), null)) {
            dlt.subscribe(List.of(props.topic() + "-dlt"));
            await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
                List<String> keys = new ArrayList<>();
                dlt.poll(Duration.ofMillis(500)).forEach(r -> keys.add(r.key()));
                assertThat(keys).contains("poison");
            });
        }
    }

    @Autowired
    ConsumerFactory<String, String> consumers;
}
