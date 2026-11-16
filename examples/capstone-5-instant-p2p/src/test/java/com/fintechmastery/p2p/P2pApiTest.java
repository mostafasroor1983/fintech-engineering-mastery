package com.fintechmastery.p2p;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "p2p.rate-limit.tiers.tiny.capacity=3",
        "p2p.rate-limit.tiers.tiny.refill-per-second=0.1",
        "p2p.rate-limit.tenant-tiers.tiny-co=tiny",
        "p2p.webhooks.base-backoff=20ms",
        "p2p.webhooks.max-backoff=100ms",
        "p2p.webhooks.max-attempts=3",
        "p2p.webhooks.allow-insecure-localhost=true",
        "p2p.webhooks.dispatch-enabled=false"})
@AutoConfigureRestTestClient
@Import(TestInfra.class)
class P2pApiTest {

    static final WebhookReceiver RECEIVER = new WebhookReceiver();
    static final String ALL = "transfers:write transfers:read webhooks:manage";

    @Autowired
    RestTestClient http;

    @Autowired
    JdbcClient jdbc;

    @Autowired
    JwtEncoder idp;

    @Autowired
    StringRedisTemplate redis;

    @Autowired
    WebhookDispatcher dispatcher;

    UUID aliceAcc;
    UUID bobAcc;
    UUID otherTenantAcc;

    @BeforeEach
    void setUp() {
        jdbc.sql("TRUNCATE account_movement, transfer, webhook_delivery, webhook_endpoint, account").update();
        redis.getConnectionFactory().getConnection().serverCommands().flushAll();
        RECEIVER.reset(0);
        aliceAcc = account("acme", "alice", 100_00);
        bobAcc = account("acme", "bob", 0);
        otherTenantAcc = account("globex", "carol", 0);
    }

    UUID account(String tenant, String user, long balanceMinor) {
        UUID id = UUID.randomUUID();
        jdbc.sql("INSERT INTO account (id, tenant_id, owner_user_id, currency, balance_minor) VALUES (:id, :t, :u, 'GBP', :b)")
                .param("id", id).param("t", tenant).param("u", user).param("b", balanceMinor).update();
        return id;
    }

    String token(String tenant, String user, String scopes) {
        return token(tenant, user, scopes, "p2p-api", Instant.now().plusSeconds(300));
    }

    String token(String tenant, String user, String scopes, String audience, Instant expiresAt) {
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(TestInfra.ISSUER).subject(user).audience(List.of(audience))
                .issuedAt(expiresAt.minusSeconds(600)).expiresAt(expiresAt)
                .claim("tenant_id", tenant).claim("scope", scopes)
                .build();
        return idp.encode(JwtEncoderParameters.from(JwsHeader.with(SignatureAlgorithm.RS256).build(), claims)).getTokenValue();
    }

    RestTestClient.ResponseSpec transfer(String token, String key, UUID from, UUID to, String amount) {
        return http.post().uri("/v1/transfers")
                .headers(h -> h.setBearerAuth(token))
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("from", from, "to", to, "amount", amount, "currency", "GBP"))
                .exchange();
    }

    long balance(UUID account) {
        return jdbc.sql("SELECT balance_minor FROM account WHERE id = :id").param("id", account).query(Long.class).single();
    }

    @Test
    void authenticationAndScopesAreEnforced() {
        http.post().uri("/v1/transfers").contentType(MediaType.APPLICATION_JSON).body("{}")
                .exchange().expectStatus().isUnauthorized();
        transfer(token("acme", "alice", "transfers:read"), "key-scope-01", aliceAcc, bobAcc, "1.00")
                .expectStatus().isForbidden();
        transfer(token("acme", "alice", ALL, "another-api", Instant.now().plusSeconds(300)), "key-aud-0001", aliceAcc, bobAcc, "1.00")
                .expectStatus().isUnauthorized();
        transfer(token("acme", "alice", ALL, "p2p-api", Instant.now().minusSeconds(120)), "key-exp-0001", aliceAcc, bobAcc, "1.00")
                .expectStatus().isUnauthorized();
        assertThat(balance(aliceAcc)).isEqualTo(100_00);
    }

    @Test
    void transferMovesMoneyAndReplaysOnRetry() {
        String alice = token("acme", "alice", ALL);
        UUID id = transfer(alice, "key-transfer-1", aliceAcc, bobAcc, "25.50")
                .expectStatus().isCreated()
                .expectBody(TransferService.TransferView.class).returnResult().getResponseBody().id();
        UUID replay = transfer(alice, "key-transfer-1", aliceAcc, bobAcc, "25.50")
                .expectStatus().isCreated()
                .expectBody(TransferService.TransferView.class).returnResult().getResponseBody().id();

        assertThat(replay).isEqualTo(id);
        assertThat(balance(aliceAcc)).isEqualTo(74_50);
        assertThat(balance(bobAcc)).isEqualTo(25_50);
        assertThat(jdbc.sql("SELECT sum(amount_minor) FROM account_movement").query(Long.class).single()).isZero();
    }

    @Test
    void cannotSpendFromSomeoneElsesAccountOrPayIntoAnotherTenant() {
        // BOLA: bob's token, alice's account id
        transfer(token("acme", "bob", ALL), "key-bola-0001", aliceAcc, bobAcc, "1.00").expectStatus().isNotFound();
        // Cross-tenant destination
        transfer(token("acme", "alice", ALL), "key-xten-0001", aliceAcc, otherTenantAcc, "1.00").expectStatus().isNotFound();
        // Reading another tenant's transfer
        UUID id = transfer(token("acme", "alice", ALL), "key-read-0001", aliceAcc, bobAcc, "1.00")
                .expectBody(TransferService.TransferView.class).returnResult().getResponseBody().id();
        http.get().uri("/v1/transfers/{id}", id).headers(h -> h.setBearerAuth(token("globex", "carol", ALL)))
                .exchange().expectStatus().isNotFound();
        http.get().uri("/v1/transfers/{id}", id).headers(h -> h.setBearerAuth(token("acme", "bob", ALL)))
                .exchange().expectStatus().isOk(); // bob is the recipient
    }

    @Test
    void insufficientFundsChangesNothing() {
        transfer(token("acme", "alice", ALL), "key-nsf-00001", aliceAcc, bobAcc, "100.01")
                .expectStatus().isEqualTo(422)
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON);
        assertThat(balance(aliceAcc)).isEqualTo(100_00);
        assertThat(jdbc.sql("SELECT count(*) FROM transfer").query(Long.class).single()).isZero();
    }

    @Test
    void rateLimitIsPerTenant() {
        UUID tinyA = account("tiny-co", "dave", 100_00);
        UUID tinyB = account("tiny-co", "erin", 0);
        String dave = token("tiny-co", "dave", ALL);
        for (int i = 0; i < 3; i++) {
            transfer(dave, "key-tiny-000" + i, tinyA, tinyB, "1.00").expectStatus().isCreated();
        }
        transfer(dave, "key-tiny-0009", tinyA, tinyB, "1.00")
                .expectStatus().isEqualTo(429)
                .expectHeader().exists("Retry-After")
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON);

        // The noisy tenant does not affect acme.
        transfer(token("acme", "alice", ALL), "key-acme-0001", aliceAcc, bobAcc, "1.00").expectStatus().isCreated();
    }

    @Test
    void webhookIsSignedRetriedWithBackoffAndDelivered() {
        String alice = token("acme", "alice", ALL);
        String secret = http.put().uri("/v1/webhooks").headers(h -> h.setBearerAuth(alice))
                .contentType(MediaType.APPLICATION_JSON).body(Map.of("url", RECEIVER.url()))
                .exchange().expectStatus().isOk()
                .expectBody(Map.class).returnResult().getResponseBody().get("signingSecret").toString();
        RECEIVER.secret = secret;
        RECEIVER.reset(2); // endpoint is down for the first two attempts

        transfer(alice, "key-hook-0001", aliceAcc, bobAcc, "5.00").expectStatus().isCreated();

        await().atMost(Duration.ofSeconds(10)).pollInterval(Duration.ofMillis(50)).untilAsserted(() -> {
            dispatcher.dispatchDue();
            assertThat(RECEIVER.verifiedIds).hasSize(1);
        });
        assertThat(RECEIVER.requests.get()).isEqualTo(3);
        assertThat(RECEIVER.badSignatures).isEmpty();
        assertThat(jdbc.sql("SELECT status || ':' || attempts FROM webhook_delivery").query(String.class).single())
                .isEqualTo("DELIVERED:3");
    }

    @Test
    void webhookGoesDeadAfterMaxAttempts() {
        String alice = token("acme", "alice", ALL);
        RECEIVER.secret = http.put().uri("/v1/webhooks").headers(h -> h.setBearerAuth(alice))
                .contentType(MediaType.APPLICATION_JSON).body(Map.of("url", RECEIVER.url()))
                .exchange().expectBody(Map.class).returnResult().getResponseBody().get("signingSecret").toString();
        RECEIVER.reset(Integer.MAX_VALUE);

        transfer(alice, "key-dead-0001", aliceAcc, bobAcc, "5.00").expectStatus().isCreated();

        await().atMost(Duration.ofSeconds(10)).pollInterval(Duration.ofMillis(50)).untilAsserted(() -> {
            dispatcher.dispatchDue();
            assertThat(jdbc.sql("SELECT status FROM webhook_delivery").query(String.class).single()).isEqualTo("DEAD");
        });
        assertThat(RECEIVER.requests.get()).isEqualTo(3);
    }

    @Test
    void webhookUrlsPointingInsideOurNetworkAreRejected() {
        String alice = token("acme", "alice", ALL);
        for (String url : List.of("https://169.254.169.254/latest/meta-data", "https://10.0.0.5/hook",
                "http://8.8.8.8/hook", "https://user:pw@8.8.8.8/hook")) {
            http.put().uri("/v1/webhooks").headers(h -> h.setBearerAuth(alice))
                    .contentType(MediaType.APPLICATION_JSON).body(Map.of("url", url))
                    .exchange().expectStatus().isBadRequest();
        }
    }
}
