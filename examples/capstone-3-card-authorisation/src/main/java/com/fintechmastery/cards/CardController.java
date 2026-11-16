package com.fintechmastery.cards;

import com.fintechmastery.common.Money;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.math.BigDecimal;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/{version}/authorisations")
public class CardController {

    public record AuthoriseRequest(@NotBlank @Pattern(regexp = "tok_[A-Za-z0-9]{8,60}") String cardToken,
            @NotBlank @Pattern(regexp = "[a-z0-9-]{1,64}") String merchantId,
            @NotNull @DecimalMin("0.01") @Digits(integer = 12, fraction = 3) BigDecimal amount,
            @NotNull @Pattern(regexp = "[A-Z]{3}") String currency) {
    }

    public record AmountRequest(@NotNull @DecimalMin("0.01") @Digits(integer = 12, fraction = 3) BigDecimal amount,
            @NotNull @Pattern(regexp = "[A-Z]{3}") String currency) {

        Money money() {
            return Money.of(amount, currency);
        }
    }

    public record AuthView(UUID id, String status, String reason, BigDecimal authorised, BigDecimal captured,
            BigDecimal refunded, BigDecimal chargedBack, String currency) {

        static AuthView of(CardAuthorisation a) {
            return new AuthView(a.publicId(), a.status().name(), a.decisionReason(), a.authorised().amount(),
                    a.captured().amount(), a.refunded().amount(), a.chargedBack().amount(), a.authorised().currencyCode());
        }
    }

    private final CardService cards;

    public CardController(CardService cards) {
        this.cards = cards;
    }

    @PostMapping(version = "1")
    @ResponseStatus(HttpStatus.CREATED)
    public AuthView authorise(@Valid @RequestBody AuthoriseRequest req) {
        return AuthView.of(cards.authorise(req.cardToken(), req.merchantId(), Money.of(req.amount(), req.currency())));
    }

    @GetMapping(path = "/{id}", version = "1")
    public AuthView get(@PathVariable UUID id) {
        return AuthView.of(cards.get(id));
    }

    @PostMapping(path = "/{id}/captures", version = "1")
    public AuthView capture(@PathVariable UUID id, @RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String key,
            @Valid @RequestBody AmountRequest req) {
        return AuthView.of(cards.apply(id, new CardCommand.Capture(key, req.money())));
    }

    @PostMapping(path = "/{id}/reversals", version = "1")
    public AuthView reverse(@PathVariable UUID id, @RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String key) {
        return AuthView.of(cards.apply(id, new CardCommand.Reverse(key)));
    }

    @PostMapping(path = "/{id}/refunds", version = "1")
    public AuthView refund(@PathVariable UUID id, @RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String key,
            @Valid @RequestBody AmountRequest req) {
        return AuthView.of(cards.apply(id, new CardCommand.Refund(key, req.money())));
    }

    @PostMapping(path = "/{id}/chargebacks", version = "1")
    public AuthView chargeback(@PathVariable UUID id, @RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String key,
            @Valid @RequestBody AmountRequest req) {
        return AuthView.of(cards.apply(id, new CardCommand.Chargeback(key, req.money())));
    }
}
