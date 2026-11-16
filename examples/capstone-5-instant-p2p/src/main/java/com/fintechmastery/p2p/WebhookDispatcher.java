package com.fintechmastery.p2p;

import com.fintechmastery.common.Hashing;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Delivers queued webhooks at least once, with exponential backoff and full jitter.
 *
 * <p>Unlike the outbox relay in capstone 1, the HTTP call happens OUTSIDE any database
 * transaction: a row is first "leased" (lease_until) in a short transaction, then delivered, then
 * its result is recorded. A slow customer endpoint therefore never holds a DB connection or lock.
 * If the process dies mid-delivery, the lease expires and another instance retries.
 */
@Component
public class WebhookDispatcher {

    private static final Logger log = LoggerFactory.getLogger(WebhookDispatcher.class);

    private final JdbcClient jdbc;
    private final P2pProperties.Webhooks config;
    private final RestClient http;
    private final Clock clock;

    public WebhookDispatcher(JdbcClient jdbc, P2pProperties props, RestClient.Builder builder, Clock clock) {
        this.jdbc = jdbc;
        this.config = props.webhooks();
        this.clock = clock;
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2))
                .followRedirects(HttpClient.Redirect.NEVER) // a redirect could bypass the SSRF checks
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(client);
        factory.setReadTimeout(Duration.ofSeconds(5));
        this.http = builder.requestFactory(factory).build();
    }

    @Scheduled(fixedDelayString = "${p2p.webhooks.dispatch-interval}")
    void scheduled() {
        if (config.dispatchEnabled()) {
            dispatchDue();
        }
    }

    record Due(UUID id, String url, String secret, String payload, String eventType, int attempts) {
    }

    /** Leases and delivers one batch of due webhooks. Returns how many were attempted. */
    public int dispatchDue() {
        List<Due> due = jdbc.sql("""
                UPDATE webhook_delivery d SET lease_until = now() + make_interval(secs => :lease)
                FROM webhook_endpoint e
                WHERE e.tenant_id = d.tenant_id AND d.id IN (
                    SELECT id FROM webhook_delivery
                    WHERE status = 'PENDING' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
                    ORDER BY next_attempt_at LIMIT :n FOR UPDATE SKIP LOCKED)
                RETURNING d.id, e.url, e.secret, d.payload, d.event_type, d.attempts
                """)
                .param("lease", config.lease().toSeconds()).param("n", config.batchSize())
                .query(Due.class).list();
        due.forEach(this::deliver);
        return due.size();
    }

    private void deliver(Due d) {
        String timestamp = String.valueOf(clock.instant().getEpochSecond());
        String signature = Hashing.hmacSha256Hex(d.secret().getBytes(StandardCharsets.UTF_8),
                d.id() + "." + timestamp + "." + d.payload());
        String error = null;
        try {
            http.post().uri(URI.create(d.url()))
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("Webhook-Id", d.id().toString())        // receivers de-duplicate on this
                    .header("Webhook-Timestamp", timestamp)          // receivers reject old timestamps (replay)
                    .header("Webhook-Signature", "v1=" + signature)
                    .header("Webhook-Event", d.eventType())
                    .body(d.payload())
                    .retrieve()
                    .toBodilessEntity();
        } catch (RuntimeException e) {
            error = e.getClass().getSimpleName();
        }
        if (error == null) {
            jdbc.sql("UPDATE webhook_delivery SET status = 'DELIVERED', attempts = attempts + 1, lease_until = NULL WHERE id = :id")
                    .param("id", d.id()).update();
            return;
        }
        int attempts = d.attempts() + 1;
        if (attempts >= config.maxAttempts()) {
            log.warn("Webhook {} is DEAD after {} attempts", d.id(), attempts);
            jdbc.sql("UPDATE webhook_delivery SET status = 'DEAD', attempts = :a, last_error = :e, lease_until = NULL WHERE id = :id")
                    .param("a", attempts).param("e", error).param("id", d.id()).update();
            return;
        }
        jdbc.sql("""
                UPDATE webhook_delivery SET attempts = :a, last_error = :e, lease_until = NULL,
                       next_attempt_at = now() + make_interval(secs => :delay)
                WHERE id = :id
                """)
                .param("a", attempts).param("e", error).param("delay", backoff(attempts).toMillis() / 1000.0)
                .param("id", d.id()).update();
    }

    /** Full jitter: random in [0, min(max, base * 2^(n-1))], so retries from many senders spread out. */
    Duration backoff(int attempt) {
        long cap = Math.min(config.maxBackoff().toMillis(),
                config.baseBackoff().toMillis() * (1L << Math.min(attempt - 1, 30)));
        return Duration.ofMillis(ThreadLocalRandom.current().nextLong(cap + 1));
    }
}
