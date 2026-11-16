package com.fintechmastery.cards;

import com.fintechmastery.common.Money;
import java.time.Clock;
import java.time.Instant;
import java.util.OptionalInt;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.resilience.InvocationRejectedException;
import org.springframework.resilience.annotation.Retryable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class CardService {

    private final CardAuthorisationRepository repo;
    private final FraudCheck fraud;
    private final JdbcClient jdbc;
    private final CardProperties props;
    private final Clock clock;
    private final TransactionTemplate tx;

    public CardService(CardAuthorisationRepository repo, FraudCheck fraud, JdbcClient jdbc, CardProperties props,
            Clock clock, TransactionTemplate tx) {
        this.tx = tx;
        this.repo = repo;
        this.fraud = fraud;
        this.jdbc = jdbc;
        this.props = props;
        this.clock = clock;
    }

    /**
     * Authorisation. The fraud call happens BEFORE the database transaction: never hold a
     * connection while waiting on a remote service (that is how pools get exhausted).
     */
    public CardAuthorisation authorise(String cardToken, String merchantId, Money amount) {
        OptionalInt score;
        try {
            score = fraud.score(new FraudClient.ScoreRequest(cardToken, merchantId, amount.toMinorUnits(),
                    amount.currencyCode()));
        } catch (InvocationRejectedException bulkheadFull) {
            score = OptionalInt.empty();
        }
        Decision d = decide(score, amount);
        Instant now = clock.instant();
        return repo.save(CardAuthorisation.decide(cardToken, merchantId, amount, d.approved(), d.reason(),
                score.isPresent() ? score.getAsInt() : null, now, now.plus(props.authValidity())));
    }

    record Decision(boolean approved, String reason) {
    }

    Decision decide(OptionalInt score, Money amount) {
        if (score.isPresent()) {
            return score.getAsInt() >= props.declineScore()
                    ? new Decision(false, "FRAUD_SUSPECTED")
                    : new Decision(true, "APPROVED");
        }
        // Fraud check unavailable: fail open only for small amounts, fail closed above the limit.
        Money limit = Money.of(props.standInLimit(), amount.currencyCode());
        return amount.isGreaterThan(limit)
                ? new Decision(false, "FRAUD_CHECK_UNAVAILABLE")
                : new Decision(true, "APPROVED_STAND_IN");
    }

    /**
     * Capture / reverse / refund / chargeback. Optimistic locking (@Version) detects two concurrent
     * operations on one payment; Spring's @Retryable re-runs the loser with fresh state, so it is
     * re-validated (e.g. two partial captures cannot together exceed the authorised amount).
     */
    @Retryable(includes = ObjectOptimisticLockingFailureException.class, maxRetries = 5, delay = 20, jitter = 10)
    public CardAuthorisation apply(UUID authId, CardCommand command) {
        // Each retry runs a NEW transaction (TransactionTemplate inside the retried method),
        // so the retry re-reads the row. Do not rely on proxy ordering of @Retryable + @Transactional.
        return tx.execute(status -> applyOnce(authId, command));
    }

    private CardAuthorisation applyOnce(UUID authId, CardCommand command) {
        CardAuthorisation auth = repo.findByPublicId(authId)
                .orElseThrow(() -> new CardOperationRejectedException("Unknown authorisation"));
        if (alreadyApplied(command.operationId(), auth)) {
            return auth; // idempotent replay
        }
        auth.apply(command, clock.instant());
        repo.saveAndFlush(auth); // version check happens here
        jdbc.sql("""
                INSERT INTO card_operation (operation_id, auth_id, type, amount_minor)
                VALUES (:op, :auth, :type, :amount)
                """)
                .param("op", command.operationId()).param("auth", auth.id())
                .param("type", command.getClass().getSimpleName().toUpperCase())
                .param("amount", switch (command) {
                    case CardCommand.Capture c -> c.amount().toMinorUnits();
                    case CardCommand.Refund r -> r.amount().toMinorUnits();
                    case CardCommand.Chargeback c -> c.amount().toMinorUnits();
                    case CardCommand.Reverse r -> 0L;
                })
                .update();
        return auth;
    }

    private boolean alreadyApplied(String operationId, CardAuthorisation auth) {
        return jdbc.sql("SELECT auth_id FROM card_operation WHERE operation_id = :op")
                .param("op", operationId).query(Long.class).optional()
                .map(existing -> {
                    if (!existing.equals(auth.id())) {
                        throw new CardOperationRejectedException("Operation id already used for another payment");
                    }
                    return true;
                })
                .orElse(false);
    }

    public CardAuthorisation get(UUID id) {
        return repo.findByPublicId(id).orElseThrow(() -> new CardOperationRejectedException("Unknown authorisation"));
    }
}
