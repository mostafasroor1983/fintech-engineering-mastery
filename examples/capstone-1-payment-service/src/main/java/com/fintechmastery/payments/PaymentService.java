package com.fintechmastery.payments;

import com.fintechmastery.common.Hashing;
import com.fintechmastery.common.Money;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/**
 * Accepts a payment exactly once per (merchant, Idempotency-Key).
 *
 * <p>Everything happens in ONE database transaction: claim the key, insert the payment, insert the
 * outbox event, store the response. Either all four commit or none do. Canonical lessons:
 * Track 06 "Idempotency" and "Transactional outbox".
 */
@Service
public class PaymentService {

    private final JdbcClient jdbc;
    private final PaymentRepository payments;
    private final JsonMapper json;
    private final Clock clock;

    public PaymentService(JdbcClient jdbc, PaymentRepository payments, JsonMapper json, Clock clock) {
        this.jdbc = jdbc;
        this.payments = payments;
        this.json = json;
        this.clock = clock;
    }

    @Transactional
    public StoredResponse create(String merchantId, String idempotencyKey, CreatePaymentRequest request) {
        String requestHash = Hashing.sha256Hex(request.canonical());

        // 1. Claim the key. If another transaction holds the same key, PostgreSQL makes this
        //    statement WAIT until that transaction commits or rolls back. No race window.
        int claimed = jdbc.sql("""
                INSERT INTO idempotency_key (merchant_id, idempotency_key, request_hash)
                VALUES (:merchant, :key, :hash)
                ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
                """)
                .param("merchant", merchantId).param("key", idempotencyKey).param("hash", requestHash)
                .update();

        if (claimed == 0) {
            return replay(merchantId, idempotencyKey, requestHash);
        }

        // 2. Business write. Money validates scale against the currency (no silent rounding).
        Instant now = clock.instant();
        Money amount = Money.of(request.amount(), request.currency());
        Payment payment = payments.saveAndFlush(Payment.accept(merchantId, request.debtorAccount(),
                request.creditorAccount(), amount, request.reference(), now));

        // 3. Outbox row in the SAME transaction. The relay publishes it to Kafka later.
        UUID eventId = UUID.randomUUID();
        String event = json.writeValueAsString(new PaymentAcceptedEvent(eventId, payment.publicId(),
                amount.toMinorUnits(), amount.currencyCode(), now));
        jdbc.sql("""
                INSERT INTO outbox_event (event_id, aggregate_id, event_type, payload)
                VALUES (:eventId, :aggregateId, 'PaymentAccepted', :payload)
                """)
                .param("eventId", eventId).param("aggregateId", payment.publicId().toString()).param("payload", event)
                .update();

        // 4. Store the exact response so a retry gets the same answer.
        String body = json.writeValueAsString(PaymentResponse.from(payment));
        jdbc.sql("""
                UPDATE idempotency_key SET response_status = 201, response_body = :body
                WHERE merchant_id = :merchant AND idempotency_key = :key
                """)
                .param("body", body).param("merchant", merchantId).param("key", idempotencyKey)
                .update();
        return new StoredResponse(201, body, false);
    }

    private StoredResponse replay(String merchantId, String key, String requestHash) {
        record Row(String requestHash, int responseStatus, String responseBody) {
        }
        Row row = jdbc.sql("""
                SELECT request_hash, response_status, response_body FROM idempotency_key
                WHERE merchant_id = :merchant AND idempotency_key = :key
                """)
                .param("merchant", merchantId).param("key", key)
                .query(Row.class)
                .single();
        if (!row.requestHash().equals(requestHash)) {
            throw new IdempotencyException("Idempotency-Key was already used with a different request body");
        }
        return new StoredResponse(row.responseStatus(), row.responseBody(), true);
    }

    public record PaymentAcceptedEvent(UUID eventId, UUID paymentId, long amountMinor, String currency,
            Instant occurredAt) {
    }
}
