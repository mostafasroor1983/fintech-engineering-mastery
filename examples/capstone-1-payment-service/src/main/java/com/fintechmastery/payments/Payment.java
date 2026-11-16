package com.fintechmastery.payments;

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

@Entity
@Table(name = "payment")
public class Payment {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "payment_seq")
    @SequenceGenerator(name = "payment_seq", sequenceName = "payment_seq", allocationSize = 50)
    private Long id;

    @Column(name = "public_id", nullable = false, updatable = false)
    private UUID publicId;

    private String merchantId;
    private String debtorAccount;
    private String creditorAccount;
    private long amountMinor;
    @JdbcTypeCode(SqlTypes.CHAR) // ISO 4217 code, CHAR(3) in the schema
    @Column(length = 3)
    private String currency;
    private String reference;

    @Enumerated(EnumType.STRING)
    private PaymentStatus status;

    @Version
    private long version;

    private Instant createdAt;
    private Instant updatedAt;

    protected Payment() {
        // for JPA
    }

    public static Payment accept(String merchantId, String debtor, String creditor, Money amount, String reference,
            Instant now) {
        Payment p = new Payment();
        p.publicId = UUID.randomUUID();
        p.merchantId = merchantId;
        p.debtorAccount = debtor;
        p.creditorAccount = creditor;
        p.amountMinor = amount.toMinorUnits();
        p.currency = amount.currencyCode();
        p.reference = reference;
        p.status = PaymentStatus.ACCEPTED;
        p.createdAt = now;
        p.updatedAt = now;
        return p;
    }

    public void moveTo(PaymentStatus next, Instant now) {
        if (!status.canMoveTo(next)) {
            throw new IllegalStateException("Illegal transition " + status + " -> " + next);
        }
        status = next;
        updatedAt = now;
    }

    public UUID publicId() {
        return publicId;
    }

    public Money amount() {
        return Money.ofMinor(amountMinor, currency);
    }

    public PaymentStatus status() {
        return status;
    }

    public String debtorAccount() {
        return debtorAccount;
    }

    public String creditorAccount() {
        return creditorAccount;
    }

    public String reference() {
        return reference;
    }

    public Instant createdAt() {
        return createdAt;
    }
}
