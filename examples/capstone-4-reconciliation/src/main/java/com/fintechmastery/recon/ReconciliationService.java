package com.fintechmastery.recon;

import com.fintechmastery.common.Hashing;
import com.fintechmastery.common.Money;
import java.sql.Date;
import java.time.LocalDate;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Ingest one statement file and reconcile it against the ledger, in one transaction.
 *
 * <p>Idempotent: the file's SHA-256 is UNIQUE, so a re-delivered file returns the first result.
 * Serialised per bank account with a PostgreSQL advisory lock, so two files for the same account
 * cannot match the same ledger item twice (match.ledger_item_id is also UNIQUE as a backstop).
 */
@Service
public class ReconciliationService {

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final Camt053Parser parser = new Camt053Parser();
    private final Matcher matcher;

    public ReconciliationService(JdbcClient jdbc, TransactionTemplate tx, ReconProperties props) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.matcher = new Matcher(props.timingTolerance(), props.fuzzyDateWindow());
    }

    public IngestResult ingest(byte[] xml) {
        String sha = Hashing.sha256Hex(xml);
        Optional<Long> existing = fileBySha(sha);
        if (existing.isPresent()) {
            return summary(existing.get(), true);
        }
        Statement s = parser.parse(xml); // validates structure and balances before we touch the database
        return tx.execute(status -> {
            jdbc.sql("SELECT pg_advisory_xact_lock(hashtext(:iban))").param("iban", s.iban()).query(Object.class).list();
            Optional<Long> raced = fileBySha(sha);
            if (raced.isPresent()) {
                return summary(raced.get(), true);
            }
            if (jdbc.sql("SELECT count(*) FROM statement_file WHERE statement_id = :id").param("id", s.statementId())
                    .query(Long.class).single() > 0) {
                throw new StatementConflictException("Statement " + s.statementId()
                        + " was already imported with different content; corrections need manual review");
            }
            long fileId = insertFile(s, sha);
            List<Matcher.NumberedLine> lines = s.lines().stream().map(l -> new Matcher.NumberedLine(insertLine(fileId, l), l))
                    .toList();
            List<Matcher.Outcome> outcomes = matcher.match(lines, openLedgerItems(s), s.statementDate(),
                    previousBankRefs(s.iban(), fileId));
            for (Matcher.Outcome o : outcomes) {
                switch (o) {
                    case Matcher.Matched m -> recordMatch(m);
                    case Matcher.Break b -> recordBreak(fileId, b);
                }
            }
            return summary(fileId, false);
        });
    }

    private long insertFile(Statement s, String sha) {
        return jdbc.sql("""
                INSERT INTO statement_file (sha256, statement_id, account_iban, currency, statement_date, opening_minor, closing_minor)
                VALUES (:sha, :sid, :iban, :ccy, :date, :open, :close) RETURNING id
                """)
                .param("sha", sha).param("sid", s.statementId()).param("iban", s.iban()).param("ccy", s.currency())
                .param("date", Date.valueOf(s.statementDate())).param("open", s.opening().toMinorUnits())
                .param("close", s.closing().toMinorUnits())
                .query(Long.class).single();
    }

    private long insertLine(long fileId, BankLine l) {
        return jdbc.sql("""
                INSERT INTO statement_line (file_id, bank_ref, end_to_end_id, amount_minor, currency, direction, value_date, remittance_info)
                VALUES (:file, :ref, :e2e, :amount, :ccy, :dir, :vd, :rmt) RETURNING id
                """)
                .param("file", fileId).param("ref", l.bankRef()).param("e2e", l.endToEndId())
                .param("amount", l.amount().toMinorUnits()).param("ccy", l.amount().currencyCode())
                .param("dir", l.direction().name()).param("vd", Date.valueOf(l.valueDate()))
                .param("rmt", l.remittanceInfo())
                .query(Long.class).single();
    }

    private List<Matcher.LedgerItem> openLedgerItems(Statement s) {
        record Row(long id, String endToEndId, long amountMinor, String currency, String direction, Date valueDate) {
        }
        return jdbc.sql("""
                SELECT id, end_to_end_id, amount_minor, currency, direction, value_date FROM ledger_item
                WHERE account_iban = :iban AND currency = :ccy AND NOT matched
                ORDER BY value_date, id
                """)
                .param("iban", s.iban()).param("ccy", s.currency())
                .query(Row.class).list().stream()
                .map(r -> new Matcher.LedgerItem(r.id(), r.endToEndId(), Money.ofMinor(r.amountMinor(), r.currency()),
                        Direction.valueOf(r.direction()), r.valueDate().toLocalDate()))
                .toList();
    }

    private Set<String> previousBankRefs(String iban, long currentFile) {
        return new HashSet<>(jdbc.sql("""
                SELECT l.bank_ref FROM statement_line l JOIN statement_file f ON f.id = l.file_id
                WHERE f.account_iban = :iban AND f.id <> :file
                """).param("iban", iban).param("file", currentFile).query(String.class).list());
    }

    private void recordMatch(Matcher.Matched m) {
        jdbc.sql("INSERT INTO match (statement_line_id, ledger_item_id, rule) VALUES (:l, :i, :r)")
                .param("l", m.lineId()).param("i", m.ledgerItemId()).param("r", m.rule()).update();
        jdbc.sql("UPDATE ledger_item SET matched = TRUE WHERE id = :i").param("i", m.ledgerItemId()).update();
        // A late bank booking clears an earlier MISSING_IN_BANK break automatically, with an audit event.
        List<Long> cleared = jdbc.sql("""
                UPDATE recon_break SET status = 'RESOLVED', resolution = 'AUTO_MATCHED', version = version + 1
                WHERE ledger_item_id = :i AND type = 'MISSING_IN_BANK' AND status <> 'RESOLVED'
                RETURNING id
                """).param("i", m.ledgerItemId()).query(Long.class).list();
        for (Long breakId : cleared) {
            jdbc.sql("INSERT INTO break_event (break_id, action, actor, comment) VALUES (:b, 'AUTO_RESOLVE', 'system', 'Matched by later statement')")
                    .param("b", breakId).update();
        }
    }

    private void recordBreak(long fileId, Matcher.Break b) {
        if (b.type() == BreakType.MISSING_IN_BANK && b.ledgerItemId() != null
                && jdbc.sql("SELECT count(*) FROM recon_break WHERE ledger_item_id = :i AND type = 'MISSING_IN_BANK' AND status <> 'RESOLVED'")
                        .param("i", b.ledgerItemId()).query(Long.class).single() > 0) {
            return; // already open from a previous statement: do not raise it again every day
        }
        long id = jdbc.sql("""
                INSERT INTO recon_break (file_id, type, status, statement_line_id, ledger_item_id, amount_minor, currency, detail)
                VALUES (:file, :type, 'OPEN', :line, :item, :amount, :ccy, :detail) RETURNING id
                """)
                .param("file", fileId).param("type", b.type().name()).param("line", b.lineId()).param("item", b.ledgerItemId())
                .param("amount", b.amount().toMinorUnits()).param("ccy", b.amount().currencyCode())
                .param("detail", b.detail().length() > 200 ? b.detail().substring(0, 200) : b.detail())
                .query(Long.class).single();
        jdbc.sql("INSERT INTO break_event (break_id, action, actor) VALUES (:b, 'RAISED', 'system')").param("b", id).update();
    }

    private Optional<Long> fileBySha(String sha) {
        return jdbc.sql("SELECT id FROM statement_file WHERE sha256 = :sha").param("sha", sha).query(Long.class).optional();
    }

    private IngestResult summary(long fileId, boolean alreadyImported) {
        int lines = jdbc.sql("SELECT count(*) FROM statement_line WHERE file_id = :f").param("f", fileId)
                .query(Integer.class).single();
        int matched = jdbc.sql("""
                SELECT count(*) FROM match m JOIN statement_line l ON l.id = m.statement_line_id WHERE l.file_id = :f
                """).param("f", fileId).query(Integer.class).single();
        Map<BreakType, Integer> breaks = new EnumMap<>(BreakType.class);
        record Row(String type, int n) {
        }
        jdbc.sql("SELECT type, count(*) AS n FROM recon_break WHERE file_id = :f GROUP BY type")
                .param("f", fileId).query(Row.class).list()
                .forEach(r -> breaks.put(BreakType.valueOf(r.type()), r.n()));
        return new IngestResult(fileId, alreadyImported, lines, matched, breaks);
    }

    /** Test/demo helper standing in for the feed from the payment and wallet services. */
    public void expect(String iban, String endToEndId, Money amount, Direction direction, LocalDate valueDate) {
        jdbc.sql("""
                INSERT INTO ledger_item (account_iban, end_to_end_id, amount_minor, currency, direction, value_date)
                VALUES (:iban, :e2e, :amount, :ccy, :dir, :vd)
                """)
                .param("iban", iban).param("e2e", endToEndId).param("amount", amount.toMinorUnits())
                .param("ccy", amount.currencyCode()).param("dir", direction.name()).param("vd", Date.valueOf(valueDate))
                .update();
    }
}
