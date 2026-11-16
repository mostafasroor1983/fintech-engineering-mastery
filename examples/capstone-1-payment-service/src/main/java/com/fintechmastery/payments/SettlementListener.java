package com.fintechmastery.payments;

import java.time.Clock;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Idempotent consumer. Kafka and the outbox both deliver at least once, so the same event can
 * arrive twice. We record the event id and the side effect in ONE database transaction; a
 * duplicate hits the primary key and is skipped.
 */
@Component
public class SettlementListener {

    static final String CONSUMER = "settlement";

    private final JdbcClient jdbc;
    private final PaymentRepository payments;
    private final JsonMapper json;
    private final Clock clock;

    public SettlementListener(JdbcClient jdbc, PaymentRepository payments, JsonMapper json, Clock clock) {
        this.jdbc = jdbc;
        this.payments = payments;
        this.json = json;
        this.clock = clock;
    }

    @KafkaListener(topics = "${payments.topic}", groupId = "settlement")
    @Transactional
    public void onEvent(String message) {
        JsonNode event = json.readTree(message);
        UUID eventId = UUID.fromString(event.get("eventId").asString());
        UUID paymentId = UUID.fromString(event.get("paymentId").asString());

        int firstTime = jdbc.sql("""
                INSERT INTO processed_event (consumer, event_id) VALUES (:consumer, :eventId)
                ON CONFLICT DO NOTHING
                """)
                .param("consumer", CONSUMER).param("eventId", eventId)
                .update();
        if (firstTime == 0) {
            return; // duplicate delivery: already applied
        }
        Payment payment = payments.findByPublicId(paymentId)
                .orElseThrow(() -> new IllegalStateException("Unknown payment " + paymentId));
        payment.moveTo(PaymentStatus.SETTLEMENT_REQUESTED, clock.instant());
        jdbc.sql("INSERT INTO settlement_instruction (payment_id) VALUES (:id)").param("id", paymentId).update();
    }
}
