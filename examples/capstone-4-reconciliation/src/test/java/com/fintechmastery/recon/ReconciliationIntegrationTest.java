package com.fintechmastery.recon;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fintechmastery.common.Money;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient
@Import(TestcontainersConfig.class)
class ReconciliationIntegrationTest {

    static final String IBAN = "GB29NWBK60161331926819";
    static final LocalDate D = LocalDate.of(2026, 11, 10);

    @Autowired
    ReconciliationService recon;

    @Autowired
    BreakWorkflow workflow;

    @Autowired
    JdbcClient jdbc;

    @Autowired
    RestTestClient http;

    @BeforeEach
    void seedLedger() {
        jdbc.sql("TRUNCATE break_event, recon_break, match, statement_line, statement_file, ledger_item").update();
        recon.expect(IBAN, "E2E-001", Money.of("250.00", "GBP"), Direction.CRDT, D);
        recon.expect(IBAN, "E2E-002", Money.of("110.00", "GBP"), Direction.DBIT, D);
        recon.expect(IBAN, "E2E-003", Money.of("75.50", "GBP"), Direction.CRDT, D.minusDays(1));
        recon.expect(IBAN, "E2E-004", Money.of("40.00", "GBP"), Direction.DBIT, D.minusDays(5));
        recon.expect(IBAN, "E2E-005", Money.of("60.00", "GBP"), Direction.CRDT, D);
    }

    @Test
    void ingestMatchesAndRaisesBreaks() throws Exception {
        IngestResult r = recon.ingest(Camt053ParserTest.sample());

        assertThat(r.alreadyImported()).isFalse();
        assertThat(r.lines()).isEqualTo(4);
        assertThat(r.matched()).isEqualTo(2);
        assertThat(r.breaks()).isEqualTo(Map.of(
                BreakType.AMOUNT_MISMATCH, 1, BreakType.MISSING_IN_LEDGER, 1, BreakType.MISSING_IN_BANK, 1));
    }

    @Test
    void reDeliveredFileIsIdempotent() throws Exception {
        IngestResult first = recon.ingest(Camt053ParserTest.sample());
        IngestResult again = recon.ingest(Camt053ParserTest.sample());

        assertThat(again.alreadyImported()).isTrue();
        assertThat(again.fileId()).isEqualTo(first.fileId());
        assertThat(jdbc.sql("SELECT count(*) FROM statement_line").query(Long.class).single()).isEqualTo(4);
        assertThat(jdbc.sql("SELECT count(*) FROM recon_break").query(Long.class).single()).isEqualTo(3);
    }

    @Test
    void sameStatementIdWithDifferentContentIsAConflict() throws Exception {
        recon.ingest(Camt053ParserTest.sample());
        String changed = new String(Camt053ParserTest.sample(), StandardCharsets.UTF_8)
                .replace("Invoice 1001", "Invoice 1001 corrected");
        assertThatThrownBy(() -> recon.ingest(changed.getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(StatementConflictException.class);
    }

    @Test
    void lateBankBookingAutoResolvesTheMissingInBankBreak() throws Exception {
        recon.ingest(Camt053ParserTest.sample());
        // Next day the bank books E2E-004 (40.00 DBIT): 1223.00 - 40.00 = 1183.00.
        String onlyE2e004 = statement("STMT-20261111-GB29", "2026-11-11", "1223.00", "1183.00", """
                <Ntry>
                  <Amt Ccy="GBP">40.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
                  <BookgDt><Dt>2026-11-11</Dt></BookgDt><ValDt><Dt>2026-11-11</Dt></ValDt>
                  <AcctSvcrRef>BANKREF-0005</AcctSvcrRef>
                  <NtryDtls><TxDtls><Refs><EndToEndId>E2E-004</EndToEndId></Refs></TxDtls></NtryDtls>
                </Ntry>
                """);
        IngestResult r = recon.ingest(onlyE2e004.getBytes(StandardCharsets.UTF_8));

        assertThat(r.matched()).isEqualTo(1);
        assertThat(jdbc.sql("SELECT resolution FROM recon_break WHERE type = 'MISSING_IN_BANK'").query(String.class).single())
                .isEqualTo("AUTO_MATCHED");
    }

    @Test
    void workflowEnforcesAssigneeVersionAndFourEyes() throws Exception {
        recon.ingest(Camt053ParserTest.sample());
        long fee = jdbc.sql("SELECT id FROM recon_break WHERE type = 'MISSING_IN_LEDGER'").query(Long.class).single();
        long mismatch = jdbc.sql("SELECT id FROM recon_break WHERE type = 'AMOUNT_MISMATCH'").query(Long.class).single();

        // Small write-off: the analyst alone may do it.
        BreakWorkflow.BreakView b = workflow.assign(fee, "ana", 0);
        assertThatThrownBy(() -> workflow.assign(fee, "bob", 0)).isInstanceOf(BreakWorkflow.WorkflowException.class);
        assertThatThrownBy(() -> workflow.resolve(fee, "ana", BreakWorkflow.Resolution.WRITE_OFF, "fee", null, 0))
                .isInstanceOf(BreakWorkflow.StaleBreakException.class); // stale version
        assertThat(workflow.resolve(fee, "ana", BreakWorkflow.Resolution.WRITE_OFF, "Monthly account fee", null, b.version())
                .status()).isEqualTo("RESOLVED");

        // Only the assignee may resolve.
        BreakWorkflow.BreakView m = workflow.assign(mismatch, "ana", 0);
        assertThatThrownBy(() -> workflow.resolve(mismatch, "bob", BreakWorkflow.Resolution.LEDGER_ADJUSTED, "x", null, m.version()))
                .hasMessageContaining("Only the assignee");
        assertThat(jdbc.sql("SELECT count(*) FROM break_event WHERE break_id = :b").param("b", fee).query(Long.class).single())
                .isEqualTo(3); // RAISED, ASSIGN, RESOLVE_WRITE_OFF
    }

    @Test
    void largeWriteOffNeedsADifferentApprover() throws Exception {
        recon.ingest(Camt053ParserTest.sample());
        long missing = jdbc.sql("SELECT id FROM recon_break WHERE type = 'MISSING_IN_BANK'").query(Long.class).single();
        jdbc.sql("UPDATE recon_break SET amount_minor = 50000 WHERE id = :id").param("id", missing).update(); // 500.00
        BreakWorkflow.BreakView b = workflow.assign(missing, "ana", 0);

        assertThatThrownBy(() -> workflow.resolve(missing, "ana", BreakWorkflow.Resolution.WRITE_OFF, "lost", "ana", b.version()))
                .hasMessageContaining("needs a different approver");
        assertThat(workflow.resolve(missing, "ana", BreakWorkflow.Resolution.WRITE_OFF, "lost", "head.of.ops", b.version())
                .status()).isEqualTo("RESOLVED");
    }

    @Test
    void httpUploadAndProblemDetails() throws Exception {
        http.post().uri("/v1/statements").contentType(MediaType.APPLICATION_XML).body(Camt053ParserTest.sample())
                .exchange().expectStatus().isCreated()
                .expectBody().jsonPath("$.matched").isEqualTo(2);
        http.post().uri("/v1/statements").contentType(MediaType.APPLICATION_XML).body(Camt053ParserTest.sample())
                .exchange().expectStatus().isOk()
                .expectBody().jsonPath("$.alreadyImported").isEqualTo(true);
        http.post().uri("/v1/statements").contentType(MediaType.APPLICATION_XML).body("<Document/>".getBytes())
                .exchange().expectStatus().isEqualTo(422)
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON);
        http.get().uri("/v1/breaks?status=OPEN").exchange().expectStatus().isOk()
                .expectBody().jsonPath("$.length()").isEqualTo(3);
    }

    static String statement(String id, String date, String opening, String closing, String entries) {
        return """
                <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>
                  <Id>%s</Id><CreDtTm>%sT18:00:00+00:00</CreDtTm>
                  <Acct><Id><IBAN>%s</IBAN></Id><Ccy>GBP</Ccy></Acct>
                  <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="GBP">%s</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
                  <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="GBP">%s</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
                  %s
                </Stmt></BkToCstmrStmt></Document>
                """.formatted(id, date, IBAN, opening, closing, entries);
    }
}
