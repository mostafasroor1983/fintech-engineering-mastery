package com.fintechmastery.recon;

import com.fintechmastery.common.Money;
import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Exception workflow for breaks: OPEN -> INVESTIGATING -> RESOLVED.
 *
 * <p>Controls: every action is written to break_event (append-only); updates use optimistic
 * locking (expected version), so two analysts cannot silently overwrite each other; write-offs
 * above a threshold need a second person (maker-checker / four-eyes).
 */
@Service
public class BreakWorkflow {

    public enum Resolution { LEDGER_ADJUSTED, BANK_CORRECTED, MATCHED_MANUALLY, WRITE_OFF }

    public record BreakView(long id, String type, String status, long amountMinor, String currency, String detail,
            @Nullable String assignee, @Nullable String resolution, long version) {
    }

    public static class WorkflowException extends RuntimeException {

        public WorkflowException(String message) {
            super(message);
        }
    }

    public static class StaleBreakException extends RuntimeException {

        public StaleBreakException() {
            super("Break was changed by someone else; reload and retry");
        }
    }

    private final JdbcClient jdbc;
    private final ReconProperties props;

    public BreakWorkflow(JdbcClient jdbc, ReconProperties props) {
        this.jdbc = jdbc;
        this.props = props;
    }

    public List<BreakView> list(String status) {
        return jdbc.sql("""
                SELECT id, type, status, amount_minor, currency, detail, assignee, resolution, version
                FROM recon_break WHERE status = :status ORDER BY id
                """).param("status", status).query(BreakView.class).list();
    }

    public BreakView get(long id) {
        return jdbc.sql("""
                SELECT id, type, status, amount_minor, currency, detail, assignee, resolution, version
                FROM recon_break WHERE id = :id
                """).param("id", id).query(BreakView.class).optional()
                .orElseThrow(() -> new WorkflowException("Unknown break"));
    }

    @Transactional
    public BreakView assign(long id, String actor, long expectedVersion) {
        BreakView b = get(id);
        if (!b.status().equals("OPEN")) {
            throw new WorkflowException("Only OPEN breaks can be assigned");
        }
        update(id, expectedVersion, "INVESTIGATING", actor, null);
        event(id, "ASSIGN", actor, null);
        return get(id);
    }

    @Transactional
    public BreakView resolve(long id, String actor, Resolution resolution, String comment, @Nullable String approver,
            long expectedVersion) {
        BreakView b = get(id);
        if (!b.status().equals("INVESTIGATING")) {
            throw new WorkflowException("Only INVESTIGATING breaks can be resolved");
        }
        if (!actor.equals(b.assignee())) {
            throw new WorkflowException("Only the assignee can resolve the break");
        }
        if (comment == null || comment.isBlank()) {
            throw new WorkflowException("A resolution comment is mandatory");
        }
        Money amount = Money.ofMinor(b.amountMinor(), b.currency());
        if (resolution == Resolution.WRITE_OFF && amount.isGreaterThan(Money.of(props.fourEyesThreshold(), b.currency()))) {
            if (approver == null || approver.equals(actor)) {
                throw new WorkflowException("Write-off above " + props.fourEyesThreshold() + " needs a different approver");
            }
        }
        update(id, expectedVersion, "RESOLVED", b.assignee(), resolution.name());
        event(id, "RESOLVE_" + resolution.name(), actor, comment + (approver == null ? "" : " [approved by " + approver + "]"));
        return get(id);
    }

    private void update(long id, long expectedVersion, String status, @Nullable String assignee, @Nullable String resolution) {
        int rows = jdbc.sql("""
                UPDATE recon_break SET status = :status, assignee = :assignee, resolution = :resolution, version = version + 1
                WHERE id = :id AND version = :version
                """)
                .param("status", status).param("assignee", assignee).param("resolution", resolution)
                .param("id", id).param("version", expectedVersion)
                .update();
        if (rows == 0) {
            throw new StaleBreakException();
        }
    }

    private void event(long id, String action, String actor, @Nullable String comment) {
        jdbc.sql("INSERT INTO break_event (break_id, action, actor, comment) VALUES (:b, :a, :actor, :c)")
                .param("b", id).param("a", action).param("actor", Objects.requireNonNull(actor)).param("c", comment)
                .update();
    }
}
