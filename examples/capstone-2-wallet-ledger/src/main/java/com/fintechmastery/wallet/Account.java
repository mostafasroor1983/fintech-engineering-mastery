package com.fintechmastery.wallet;

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
@Table(name = "account")
public class Account {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "account_seq")
    @SequenceGenerator(name = "account_seq", sequenceName = "account_seq", allocationSize = 50)
    private Long id;

    private UUID publicId;
    private String ownerId;

    @Enumerated(EnumType.STRING)
    private AccountType type;

    @JdbcTypeCode(SqlTypes.CHAR) // ISO 4217 code, CHAR(3) in the schema
    @Column(length = 3)
    private String currency;
    private long balanceMinor;
    private boolean allowNegative;

    /** Safety net: any writer that forgot to lock still cannot overwrite a newer balance. */
    @Version
    private long version;

    private Instant createdAt;

    protected Account() {
    }

    static Account open(String ownerId, AccountType type, String currency, Instant now) {
        Account a = new Account();
        a.publicId = UUID.randomUUID();
        a.ownerId = ownerId;
        a.type = type;
        a.currency = currency;
        a.allowNegative = type != AccountType.CUSTOMER_WALLET;
        a.createdAt = now;
        return a;
    }

    /** Applies one posting leg. Positive = credit (money in), negative = debit (money out). */
    void apply(Money leg) {
        if (!leg.currencyCode().equals(currency)) {
            throw new IllegalArgumentException("Account " + publicId + " holds " + currency + ", not " + leg.currencyCode());
        }
        long next = Math.addExact(balanceMinor, leg.toMinorUnits());
        if (next < 0 && !allowNegative) {
            throw new InsufficientFundsException(publicId);
        }
        balanceMinor = next;
    }

    public Long id() {
        return id;
    }

    public UUID publicId() {
        return publicId;
    }

    public String ownerId() {
        return ownerId;
    }

    public AccountType type() {
        return type;
    }

    public String currency() {
        return currency;
    }

    public Money balance() {
        return Money.ofMinor(balanceMinor, currency);
    }
}
