package com.fintechmastery.wallet;

import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Internal reconciliation: the cached balance on each account must equal the sum of its postings,
 * and all postings in each currency must sum to zero. Run it on a schedule and page someone on any
 * break. External (bank/scheme) reconciliation is capstone 4.
 */
@Service
public class ReconciliationService {

    public record BalanceBreak(java.util.UUID account, String currency, long cachedMinor, long ledgerMinor) {
    }

    public record CurrencyImbalance(String currency, long sumMinor) {
    }

    public record Report(List<BalanceBreak> balanceBreaks, List<CurrencyImbalance> currencyImbalances) {

        public boolean clean() {
            return balanceBreaks.isEmpty() && currencyImbalances.isEmpty();
        }
    }

    private final JdbcClient jdbc;

    public ReconciliationService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** REPEATABLE READ: both queries see the same snapshot, so in-flight transfers cannot cause false breaks. */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Report run() {
        List<BalanceBreak> breaks = jdbc.sql("""
                SELECT a.public_id AS account, a.currency, a.balance_minor AS cached_minor,
                       COALESCE(sum(p.amount_minor), 0) AS ledger_minor
                FROM account a LEFT JOIN posting p ON p.account_id = a.id
                GROUP BY a.id
                HAVING a.balance_minor <> COALESCE(sum(p.amount_minor), 0)
                """).query(BalanceBreak.class).list();
        List<CurrencyImbalance> imbalances = jdbc.sql("""
                SELECT currency, sum(amount_minor) AS sum_minor FROM posting
                GROUP BY currency HAVING sum(amount_minor) <> 0
                """).query(CurrencyImbalance.class).list();
        return new Report(breaks, imbalances);
    }
}
