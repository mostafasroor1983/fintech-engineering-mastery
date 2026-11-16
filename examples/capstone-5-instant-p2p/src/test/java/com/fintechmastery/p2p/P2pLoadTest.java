package com.fintechmastery.p2p;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.test.web.servlet.client.RestTestClient;

/**
 * mvn test -pl capstone-5-instant-p2p -am -Dgroups=load
 * Two tenants hammer the API at once: "quiet" on the premium tier, "noisy" on a 50-request bucket.
 * Expect: quiet gets no 429s, noisy is throttled, and money is conserved.
 */
@Tag("load")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "p2p.rate-limit.tiers.small.capacity=50", "p2p.rate-limit.tiers.small.refill-per-second=5",
        "p2p.rate-limit.tenant-tiers.noisy=small", "p2p.rate-limit.tenant-tiers.quiet=premium",
        "p2p.rate-limit.tiers.premium.capacity=5000", "p2p.webhooks.dispatch-enabled=false"})
@AutoConfigureRestTestClient
@Import(TestInfra.class)
class P2pLoadTest {

    @Autowired
    RestTestClient http;

    @Autowired
    JdbcClient jdbc;

    @Autowired
    JwtEncoder idp;

    String token(String tenant, String user) {
        JwtClaimsSet claims = JwtClaimsSet.builder().issuer(TestInfra.ISSUER).subject(user).audience(List.of("p2p-api"))
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(600))
                .claim("tenant_id", tenant).claim("scope", "transfers:write").build();
        return idp.encode(JwtEncoderParameters.from(JwsHeader.with(SignatureAlgorithm.RS256).build(), claims)).getTokenValue();
    }

    UUID account(String tenant, String user, long balance) {
        UUID id = UUID.randomUUID();
        jdbc.sql("INSERT INTO account (id, tenant_id, owner_user_id, currency, balance_minor) VALUES (:id, :t, :u, 'GBP', :b)")
                .param("id", id).param("t", tenant).param("u", user).param("b", balance).update();
        return id;
    }

    @Test
    void noisyTenantIsThrottledQuietTenantIsNot() throws Exception {
        UUID qa = account("quiet", "qa", 1_000_000);
        UUID qb = account("quiet", "qb", 0);
        UUID na = account("noisy", "na", 1_000_000);
        UUID nb = account("noisy", "nb", 0);
        String quiet = token("quiet", "qa");
        String noisy = token("noisy", "na");
        Map<String, AtomicInteger> statuses = new java.util.concurrent.ConcurrentHashMap<>();
        List<Long> micros = Collections.synchronizedList(new ArrayList<>());
        int perTenant = 1_000;
        long start = System.nanoTime();
        try (var pool = Executors.newFixedThreadPool(100, Thread.ofVirtual().factory())) {
            List<Future<?>> futures = new ArrayList<>();
            for (int i = 0; i < perTenant * 2; i++) {
                boolean isQuiet = i % 2 == 0;
                String key = "load-" + i + "-" + UUID.randomUUID().toString().substring(0, 8);
                futures.add(pool.submit(() -> {
                    long t0 = System.nanoTime();
                    int status = http.post().uri("/v1/transfers")
                            .headers(h -> h.setBearerAuth(isQuiet ? quiet : noisy))
                            .header("Idempotency-Key", key).contentType(MediaType.APPLICATION_JSON)
                            .body(Map.of("from", isQuiet ? qa : na, "to", isQuiet ? qb : nb, "amount", "1.00", "currency", "GBP"))
                            .exchange().returnResult().getStatus().value();
                    micros.add((System.nanoTime() - t0) / 1_000);
                    statuses.computeIfAbsent((isQuiet ? "quiet-" : "noisy-") + status, k -> new AtomicInteger()).incrementAndGet();
                }));
            }
            for (Future<?> f : futures) {
                f.get();
            }
        }
        double seconds = (System.nanoTime() - start) / 1e9;
        List<Long> sorted = micros.stream().sorted().toList();
        System.out.printf("LOAD capstone-5: %d requests in %.1f s = %.0f req/s; p50 %.1f ms, p99 %.1f ms; %s%n",
                sorted.size(), seconds, sorted.size() / seconds, sorted.get(sorted.size() / 2) / 1000.0,
                sorted.get((int) (sorted.size() * 0.99)) / 1000.0, statuses);

        assertThat(statuses.get("quiet-201")).hasValue(perTenant);
        assertThat(statuses.get("noisy-429").get()).isGreaterThan(0);
        long total = jdbc.sql("SELECT sum(balance_minor) FROM account WHERE tenant_id IN ('quiet', 'noisy')").query(Long.class).single();
        assertThat(total).isEqualTo(2_000_000);
    }
}
