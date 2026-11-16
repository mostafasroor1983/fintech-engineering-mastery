package com.fintechmastery.payments;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Polls unpublished outbox rows and sends them to Kafka.
 *
 * <p>Delivery is AT LEAST ONCE: if the process dies after Kafka acked but before the UPDATE
 * commits, the row is sent again. Consumers must be idempotent (see {@link SettlementListener}).
 * FOR UPDATE SKIP LOCKED lets several relay instances run without sending the same row twice
 * at the same time.
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final OutboxSender sender;
    private final PaymentsProperties props;

    public OutboxRelay(JdbcClient jdbc, TransactionTemplate tx, OutboxSender sender, PaymentsProperties props) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.sender = sender;
        this.props = props;
    }

    @Scheduled(fixedDelayString = "${payments.outbox.poll-interval}")
    void scheduled() {
        if (props.outbox().relayEnabled()) {
            try {
                publishPending();
            } catch (RuntimeException e) {
                // Rows stay unpublished and are retried on the next poll. Alert on outbox age, not on this log.
                log.warn("Outbox relay batch failed: {}", e.getMessage());
            }
        }
    }

    /** Publishes one batch. Returns how many rows were published. */
    public int publishPending() {
        Integer published = tx.execute(status -> {
            record Row(long id, String aggregateId, String payload) {
            }
            List<Row> rows = jdbc.sql("""
                    SELECT id, aggregate_id, payload FROM outbox_event
                    WHERE published_at IS NULL
                    ORDER BY id
                    LIMIT :limit
                    FOR UPDATE SKIP LOCKED
                    """)
                    .param("limit", props.outbox().batchSize())
                    .query(Row.class)
                    .list();
            for (Row row : rows) {
                try {
                    sender.send(row.aggregateId(), row.payload());
                } catch (Exception e) {
                    throw new IllegalStateException("Broker send failed for outbox row " + row.id(), e);
                }
            }
            if (!rows.isEmpty()) {
                jdbc.sql("UPDATE outbox_event SET published_at = now() WHERE id IN (:ids)")
                        .param("ids", rows.stream().map(Row::id).toList())
                        .update();
            }
            return rows.size();
        });
        return published == null ? 0 : published;
    }
}
