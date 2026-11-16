package com.fintechmastery.cards;

import com.fintechmastery.common.Money;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.SequenceGenerator;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.util.UUID;

/**
 * One card payment from authorisation to its end state. Lifecycle:
 * AUTHORISED -> CAPTURED (clearing) -> REFUNDED / CHARGED_BACK, or AUTHORISED -> REVERSED (void / expiry).
 */
@Entity
@Table(name = "card_authorisation")
public class CardAuthorisation {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "card_auth_seq")
    @SequenceGenerator(name = "card_auth_seq", sequenceName = "card_auth_seq", allocationSize = 50)
    private Long id;

    private UUID publicId;
    private String cardToken;
    private String merchantId;
    @JdbcTypeCode(SqlTypes.CHAR) // ISO 4217 code, CHAR(3) in the schema
    @Column(length = 3)
    private String currency;
    private long authorisedMinor;
    private long capturedMinor;
    private long refundedMinor;
    private long chargedBackMinor;

    @Enumerated(EnumType.STRING)
    private CardStatus status;

    private String decisionReason;
    private Integer fraudScore;
    private Instant expiresAt;

    @Version
    private long version;

    private Instant createdAt;

    protected CardAuthorisation() {
    }

    static CardAuthorisation decide(String cardToken, String merchantId, Money amount, boolean approved,
            String reason, Integer fraudScore, Instant now, Instant expiresAt) {
        CardAuthorisation a = new CardAuthorisation();
        a.publicId = UUID.randomUUID();
        a.cardToken = cardToken;
        a.merchantId = merchantId;
        a.currency = amount.currencyCode();
        a.authorisedMinor = amount.toMinorUnits();
        a.status = approved ? CardStatus.AUTHORISED : CardStatus.DECLINED;
        a.decisionReason = reason;
        a.fraudScore = fraudScore;
        a.createdAt = now;
        a.expiresAt = expiresAt;
        return a;
    }

    /** The state machine. Pattern matching over a sealed interface: a new command will not compile until handled. */
    void apply(CardCommand command, Instant now) {
        switch (command) {
            case CardCommand.Capture c -> {
                require(status == CardStatus.AUTHORISED || status == CardStatus.CAPTURED, "capture", c);
                require(now.isBefore(expiresAt), "capture an expired authorisation", c);
                long amount = minor(c.amount());
                require(capturedMinor + amount <= authorisedMinor, "capture more than authorised", c);
                capturedMinor += amount;
                status = CardStatus.CAPTURED;
            }
            case CardCommand.Reverse r -> {
                require(status == CardStatus.AUTHORISED, "reverse", r);
                status = CardStatus.REVERSED;
            }
            case CardCommand.Refund r -> {
                require(status == CardStatus.CAPTURED || status == CardStatus.REFUNDED, "refund", r);
                long amount = minor(r.amount());
                require(refundedMinor + chargedBackMinor + amount <= capturedMinor, "refund more than captured", r);
                refundedMinor += amount;
                status = CardStatus.REFUNDED;
            }
            case CardCommand.Chargeback cb -> {
                require(status == CardStatus.CAPTURED || status == CardStatus.REFUNDED, "charge back", cb);
                long amount = minor(cb.amount());
                require(refundedMinor + chargedBackMinor + amount <= capturedMinor,
                        "charge back more than the unrefunded amount", cb);
                chargedBackMinor += amount;
                status = CardStatus.CHARGED_BACK;
            }
        }
    }

    private long minor(Money m) {
        if (!m.currencyCode().equals(currency)) {
            throw new CardOperationRejectedException("Currency must be " + currency);
        }
        if (!m.isPositive()) {
            throw new CardOperationRejectedException("Amount must be positive");
        }
        return m.toMinorUnits();
    }

    private void require(boolean ok, String action, CardCommand c) {
        if (!ok) {
            throw new CardOperationRejectedException("Cannot " + action + " (status " + status + ", op "
                    + c.operationId() + ")");
        }
    }

    public Long id() {
        return id;
    }

    public UUID publicId() {
        return publicId;
    }

    public String merchantId() {
        return merchantId;
    }

    public CardStatus status() {
        return status;
    }

    public String decisionReason() {
        return decisionReason;
    }

    public Money authorised() {
        return Money.ofMinor(authorisedMinor, currency);
    }

    public Money captured() {
        return Money.ofMinor(capturedMinor, currency);
    }

    public Money refunded() {
        return Money.ofMinor(refundedMinor, currency);
    }

    public Money chargedBack() {
        return Money.ofMinor(chargedBackMinor, currency);
    }
}
