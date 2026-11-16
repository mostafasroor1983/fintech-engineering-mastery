package com.fintechmastery.p2p;

import com.fintechmastery.common.Money;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Validated
@RequestMapping("/{version}")
public class P2pController {

    public record TransferRequest(@NotNull UUID from, @NotNull UUID to,
            @NotNull @DecimalMin("0.01") @Digits(integer = 12, fraction = 3) BigDecimal amount,
            @NotNull @Pattern(regexp = "[A-Z]{3}") String currency) {
    }

    public record WebhookRequest(@NotBlank @Size(max = 2048) String url) {
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    private final TransferService transfers;
    private final WebhookUrlValidator urls;
    private final JdbcClient jdbc;

    public P2pController(TransferService transfers, WebhookUrlValidator urls, JdbcClient jdbc) {
        this.transfers = transfers;
        this.urls = urls;
        this.jdbc = jdbc;
    }

    @PostMapping(path = "/transfers", version = "1")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('SCOPE_transfers:write')")
    public TransferService.TransferView transfer(Authentication auth,
            @RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String key,
            @Valid @RequestBody TransferRequest req) {
        return transfers.transfer(Caller.from(auth), key, req.from(), req.to(), Money.of(req.amount(), req.currency()));
    }

    @GetMapping(path = "/transfers/{id}", version = "1")
    @PreAuthorize("hasAuthority('SCOPE_transfers:read')")
    public TransferService.TransferView get(Authentication auth, @PathVariable UUID id) {
        return transfers.get(Caller.from(auth), id);
    }

    /** Registers (or replaces) the tenant's webhook endpoint. The signing secret is shown once. */
    @PutMapping(path = "/webhooks", version = "1")
    @PreAuthorize("hasAuthority('SCOPE_webhooks:manage')")
    public Map<String, String> registerWebhook(Authentication auth, @Valid @RequestBody WebhookRequest req) {
        String url = urls.validate(req.url()).toString();
        byte[] secret = new byte[32];
        RANDOM.nextBytes(secret);
        String hex = HexFormat.of().formatHex(secret);
        jdbc.sql("""
                INSERT INTO webhook_endpoint (id, tenant_id, url, secret) VALUES (:id, :t, :url, :s)
                ON CONFLICT (tenant_id) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret
                """)
                .param("id", UUID.randomUUID()).param("t", Caller.from(auth).tenantId()).param("url", url).param("s", hex)
                .update();
        return Map.of("url", url, "signingSecret", hex);
    }
}
