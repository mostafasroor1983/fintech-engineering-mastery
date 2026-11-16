package com.fintechmastery.wallet;

import com.fintechmastery.common.Money;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.Currency;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Thin HTTP layer. Authentication is out of scope here (see capstone 5); ownerId stands in for the principal. */
@RestController
@Validated
@RequestMapping("/{version}")
public class WalletController {

    public record OpenWallet(@NotBlank @Pattern(regexp = "[a-z0-9-]{1,64}") String ownerId,
            @NotNull @Pattern(regexp = "[A-Z]{3}") String currency) {
    }

    public record AccountView(UUID id, String ownerId, String currency, BigDecimal balance) {

        static AccountView of(Account a) {
            return new AccountView(a.publicId(), a.ownerId(), a.currency(), a.balance().amount());
        }
    }

    public record TransferRequest(@NotNull UUID from, @NotNull UUID to,
            @NotNull @DecimalMin("0.01") @Digits(integer = 12, fraction = 3) BigDecimal amount,
            @NotNull @Pattern(regexp = "[A-Z]{3}") String currency, @Size(max = 140) String description) {
    }

    public record QuoteRequest(@NotNull @DecimalMin("0.01") @Digits(integer = 12, fraction = 3) BigDecimal sellAmount,
            @NotNull @Pattern(regexp = "[A-Z]{3}") String sellCurrency,
            @NotNull @Pattern(regexp = "[A-Z]{3}") String buyCurrency) {
    }

    public record FxTransferRequest(@NotNull UUID quoteId, @NotNull UUID from, @NotNull UUID to) {
    }

    private final WalletService wallets;
    private final FxService fx;

    public WalletController(WalletService wallets, FxService fx) {
        this.wallets = wallets;
        this.fx = fx;
    }

    @PostMapping(path = "/wallets", version = "1")
    @ResponseStatus(HttpStatus.CREATED)
    public AccountView open(@Valid @RequestBody OpenWallet req) {
        return AccountView.of(wallets.openWallet(req.ownerId(), req.currency()));
    }

    @GetMapping(path = "/wallets/{id}", version = "1")
    public AccountView get(@PathVariable UUID id) {
        return AccountView.of(wallets.account(id));
    }

    @PostMapping(path = "/transfers", version = "1")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, UUID> transfer(@RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String key,
            @Valid @RequestBody TransferRequest req) {
        UUID entry = wallets.transfer(key, req.from(), req.to(), Money.of(req.amount(), req.currency()), req.description());
        return Map.of("entryId", entry);
    }

    @PostMapping(path = "/fx/quotes", version = "1")
    @ResponseStatus(HttpStatus.CREATED)
    public FxQuote quote(@Valid @RequestBody QuoteRequest req) {
        return fx.quote(Money.of(req.sellAmount(), req.sellCurrency()), Currency.getInstance(req.buyCurrency()));
    }

    @PostMapping(path = "/fx/transfers", version = "1")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, UUID> fxTransfer(@RequestHeader("Idempotency-Key") @Pattern(regexp = "[A-Za-z0-9-]{8,64}") String key,
            @Valid @RequestBody FxTransferRequest req) {
        return Map.of("entryId", wallets.fxTransfer(key, req.quoteId(), req.from(), req.to()));
    }
}
