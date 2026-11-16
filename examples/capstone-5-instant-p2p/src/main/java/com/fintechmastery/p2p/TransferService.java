package com.fintechmastery.p2p;

import com.fintechmastery.common.Hashing;
import com.fintechmastery.common.Money;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * Instant transfer between two accounts of the same tenant, completed synchronously.
 * Debit and credit, both movement rows, the transfer row and the webhook delivery commit together.
 */
@Service
public class TransferService {

    public record TransferView(UUID id, UUID from, UUID to, long amountMinor, String currency, String status,
            Instant createdAt) {
    }

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final JsonMapper json;

    public TransferService(JdbcClient jdbc, TransactionTemplate tx, JsonMapper json) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.json = json;
    }

    public TransferView transfer(Caller caller, String idempotencyKey, UUID from, UUID to, Money amount) {
        if (from.equals(to)) {
            throw new IllegalArgumentException("Cannot transfer to the same account");
        }
        String hash = Hashing.sha256Hex(from + "|" + to + "|" + amount);
        Optional<TransferView> previous = findByKey(caller, idempotencyKey, hash);
        if (previous.isPresent()) {
            return previous.get();
        }
        try {
            return tx.execute(s -> doTransfer(caller, idempotencyKey, hash, from, to, amount));
        } catch (DuplicateKeyException raceLost) {
            return findByKey(caller, idempotencyKey, hash).orElseThrow(() -> raceLost);
        }
    }

    private TransferView doTransfer(Caller caller, String key, String hash, UUID from, UUID to, Money amount) {
        // Authorisation at object level (OWASP API1 BOLA): the source must belong to the caller, the
        // destination to the same tenant. A wrong id and a foreign id give the same answer.
        String fromCcy = jdbc.sql("SELECT currency FROM account WHERE id = :id AND tenant_id = :t AND owner_user_id = :u")
                .param("id", from).param("t", caller.tenantId()).param("u", caller.userId())
                .query(String.class).optional().orElseThrow(() -> new NotFoundException("Source account"));
        String toCcy = jdbc.sql("SELECT currency FROM account WHERE id = :id AND tenant_id = :t")
                .param("id", to).param("t", caller.tenantId())
                .query(String.class).optional().orElseThrow(() -> new NotFoundException("Destination account"));
        if (!fromCcy.equals(amount.currencyCode()) || !toCcy.equals(amount.currencyCode())) {
            throw new IllegalArgumentException("Both accounts must hold " + amount.currencyCode());
        }

        // Touch the two rows in a fixed (id) order so A->B and B->A cannot deadlock.
        long minor = amount.toMinorUnits();
        for (UUID account : List.of(from, to).stream().sorted(Comparator.naturalOrder()).toList()) {
            if (account.equals(from)) {
                // Conditional debit: check and update in ONE statement, no read-modify-write race.
                int debited = jdbc.sql("UPDATE account SET balance_minor = balance_minor - :m WHERE id = :id AND balance_minor >= :m")
                        .param("m", minor).param("id", from).update();
                if (debited == 0) {
                    throw new InsufficientFundsException();
                }
            } else {
                jdbc.sql("UPDATE account SET balance_minor = balance_minor + :m WHERE id = :id").param("m", minor).param("id", to).update();
            }
        }

        UUID id = UUID.randomUUID();
        Instant createdAt = jdbc.sql("""
                INSERT INTO transfer (id, tenant_id, idempotency_key, request_hash, initiated_by, from_account, to_account,
                                      amount_minor, currency, status)
                VALUES (:id, :t, :key, :hash, :u, :from, :to, :m, :ccy, 'COMPLETED') RETURNING created_at
                """)
                .param("id", id).param("t", caller.tenantId()).param("key", key).param("hash", hash)
                .param("u", caller.userId()).param("from", from).param("to", to).param("m", minor)
                .param("ccy", amount.currencyCode())
                .query(java.sql.Timestamp.class).single().toInstant();
        jdbc.sql("INSERT INTO account_movement (transfer_id, account_id, amount_minor) VALUES (:t, :a, :m), (:t, :b, :n)")
                .param("t", id).param("a", from).param("m", -minor).param("b", to).param("n", minor).update();

        TransferView view = new TransferView(id, from, to, minor, amount.currencyCode(), "COMPLETED", createdAt);
        // Webhook is queued in the same transaction (an outbox): no event for a rolled-back transfer,
        // and no lost event for a committed one.
        jdbc.sql("""
                INSERT INTO webhook_delivery (id, tenant_id, event_type, payload, status)
                SELECT :id, tenant_id, 'transfer.completed', :payload, 'PENDING' FROM webhook_endpoint WHERE tenant_id = :t
                """)
                .param("id", UUID.randomUUID()).param("payload", json.writeValueAsString(view)).param("t", caller.tenantId())
                .update();
        return view;
    }

    private Optional<TransferView> findByKey(Caller caller, String key, String hash) {
        record Row(UUID id, UUID fromAccount, UUID toAccount, long amountMinor, String currency, String status,
                java.sql.Timestamp createdAt, String requestHash) {
        }
        return jdbc.sql("""
                SELECT id, from_account, to_account, amount_minor, currency, status, created_at, request_hash
                FROM transfer WHERE tenant_id = :t AND idempotency_key = :key
                """).param("t", caller.tenantId()).param("key", key).query(Row.class).optional()
                .map(r -> {
                    if (!r.requestHash().equals(hash)) {
                        throw new IllegalStateException("Idempotency-Key reused with a different request");
                    }
                    return new TransferView(r.id(), r.fromAccount(), r.toAccount(), r.amountMinor(), r.currency(),
                            r.status(), r.createdAt().toInstant());
                });
    }

    public TransferView get(Caller caller, UUID id) {
        record Row(UUID id, UUID fromAccount, UUID toAccount, long amountMinor, String currency, String status,
                java.sql.Timestamp createdAt) {
        }
        // Visible only to the tenant, and only to a user who owns one of the two accounts.
        return jdbc.sql("""
                SELECT t.id, t.from_account, t.to_account, t.amount_minor, t.currency, t.status, t.created_at
                FROM transfer t
                WHERE t.id = :id AND t.tenant_id = :tenant
                  AND EXISTS (SELECT 1 FROM account a WHERE a.id IN (t.from_account, t.to_account) AND a.owner_user_id = :user)
                """).param("id", id).param("tenant", caller.tenantId()).param("user", caller.userId())
                .query(Row.class).optional()
                .map(r -> new TransferView(r.id(), r.fromAccount(), r.toAccount(), r.amountMinor(), r.currency(),
                        r.status(), r.createdAt().toInstant()))
                .orElseThrow(() -> new NotFoundException("Transfer"));
    }
}
