package com.fintechmastery.recon;

import static org.assertj.core.api.Assertions.assertThat;

import com.fintechmastery.common.Money;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * mvn test -pl capstone-4-reconciliation -am -Dgroups=load
 * A 10,000-entry statement against 10,000 ledger items (1% amount mismatches). Measures parse +
 * match + persist time for one file. Row-by-row inserts are the known bottleneck (see README).
 */
@Tag("load")
@SpringBootTest
@Import(TestcontainersConfig.class)
class ReconLoadTest {

    @Autowired
    ReconciliationService recon;

    @Autowired
    JdbcClient jdbc;

    @Test
    void tenThousandLineStatement() {
        jdbc.sql("TRUNCATE break_event, recon_break, match, statement_line, statement_file, ledger_item").update();
        String iban = "GB29NWBK60161331926819";
        LocalDate d = LocalDate.of(2026, 11, 10);
        int n = 10_000;
        StringBuilder entries = new StringBuilder();
        BigDecimal total = BigDecimal.ZERO;
        for (int i = 0; i < n; i++) {
            BigDecimal amount = BigDecimal.valueOf(1000 + i, 2);
            total = total.add(amount);
            recon.expect(iban, "E2E-L" + i, Money.of(i % 100 == 0 ? amount.add(BigDecimal.ONE) : amount, "GBP"),
                    Direction.CRDT, d);
            entries.append("""
                    <Ntry><Amt Ccy="GBP">%s</Amt><CdtDbtInd>CRDT</CdtDbtInd><ValDt><Dt>2026-11-10</Dt></ValDt>
                    <AcctSvcrRef>LREF-%d</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>E2E-L%d</EndToEndId></Refs></TxDtls></NtryDtls></Ntry>
                    """.formatted(amount.toPlainString(), i, i));
        }
        String xml = """
                <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>
                <Id>STMT-LOAD</Id><CreDtTm>2026-11-10T18:00:00+00:00</CreDtTm>
                <Acct><Id><IBAN>%s</IBAN></Id><Ccy>GBP</Ccy></Acct>
                <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="GBP">0.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
                <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="GBP">%s</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
                %s</Stmt></BkToCstmrStmt></Document>
                """.formatted(iban, total.toPlainString(), entries);

        long start = System.nanoTime();
        IngestResult r = recon.ingest(xml.getBytes(StandardCharsets.UTF_8));
        double seconds = (System.nanoTime() - start) / 1e9;
        System.out.printf("LOAD capstone-4: %d lines (%d KB) ingested and matched in %.1f s; matched %d, breaks %s%n",
                n, xml.length() / 1024, seconds, r.matched(), r.breaks());

        assertThat(r.matched()).isEqualTo(n - n / 100);
        assertThat(r.breaks()).containsEntry(BreakType.AMOUNT_MISMATCH, n / 100);
    }
}
