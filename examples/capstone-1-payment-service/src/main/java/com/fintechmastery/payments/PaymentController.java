package com.fintechmastery.payments;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Versioned with Spring Framework 7 built-in API versioning: path segment 0 holds the version
 * (see spring.mvc.apiversion.* in application.yml).
 *
 * <p>X-Merchant-Id stands in for the authenticated client. In production it comes from the
 * OAuth2 token (capstone 5 shows that), never from a header the caller controls.
 */
@RestController
@Validated
@RequestMapping("/{version}/payments")
public class PaymentController {

    private final PaymentService service;
    private final PaymentRepository payments;
    private final JsonMapper json;

    public PaymentController(PaymentService service, PaymentRepository payments, JsonMapper json) {
        this.service = service;
        this.payments = payments;
        this.json = json;
    }

    @PostMapping(version = "1", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> create(
            @RequestHeader("X-Merchant-Id") @Pattern(regexp = "[a-z0-9-]{1,64}") String merchantId,
            @RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String idempotencyKey,
            @Valid @RequestBody CreatePaymentRequest request) {
        StoredResponse r = service.create(merchantId, idempotencyKey, request);
        UUID id = json.readValue(r.body(), PaymentResponse.class).id();
        return ResponseEntity.status(r.status())
                .location(URI.create("/v1/payments/" + id))
                .header("Idempotent-Replayed", String.valueOf(r.replayed()))
                .contentType(MediaType.APPLICATION_JSON)
                .body(r.body());
    }

    @GetMapping(path = "/{id}", version = "1")
    public PaymentResponse get(@RequestHeader("X-Merchant-Id") String merchantId, @PathVariable UUID id) {
        // Scope every read by owner: returning someone else's payment is OWASP API1 (BOLA).
        return payments.findByPublicIdAndMerchantId(id, merchantId)
                .map(PaymentResponse::from)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Payment not found"));
    }
}
