package com.fintechmastery.recon;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fintechmastery.common.Money;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class Camt053ParserTest {

    static byte[] sample() throws IOException {
        try (var in = Camt053ParserTest.class.getResourceAsStream("/camt053/statement-2026-11-10.xml")) {
            return in.readAllBytes();
        }
    }

    final Camt053Parser parser = new Camt053Parser();

    @Test
    void parsesTheStatement() throws IOException {
        Statement s = parser.parse(sample());

        assertThat(s.statementId()).isEqualTo("STMT-20261110-GB29");
        assertThat(s.iban()).isEqualTo("GB29NWBK60161331926819");
        assertThat(s.statementDate()).isEqualTo(LocalDate.of(2026, 11, 10));
        assertThat(s.opening()).isEqualTo(Money.of("1000.00", "GBP"));
        assertThat(s.closing()).isEqualTo(Money.of("1223.00", "GBP"));
        assertThat(s.lines()).hasSize(4);
        assertThat(s.lines().get(0).endToEndId()).isEqualTo("E2E-001");
        assertThat(s.lines().get(0).remittanceInfo()).isEqualTo("Invoice 1001");
        assertThat(s.lines().get(2).endToEndId()).as("NOTPROVIDED means no id").isNull();
        assertThat(s.lines().get(3).direction()).isEqualTo(Direction.DBIT);
    }

    @Test
    void rejectsAStatementThatDoesNotBalance() throws IOException {
        String tampered = new String(sample(), StandardCharsets.UTF_8).replace(">1223.00<", ">1223.01<");
        assertThatThrownBy(() -> parser.parse(tampered.getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(StatementRejectedException.class)
                .hasMessageContaining("does not balance");
    }

    @Test
    void rejectsXxePayloads() {
        String xxe = """
                <?xml version="1.0"?>
                <!DOCTYPE d [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
                <Document><BkToCstmrStmt><Stmt><Id>&xxe;</Id></Stmt></BkToCstmrStmt></Document>
                """;
        assertThatThrownBy(() -> parser.parse(xxe.getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(StatementRejectedException.class)
                .hasMessageContaining("Malformed");
    }

    @Test
    void rejectsAmountsWithTooManyDecimals() throws IOException {
        String bad = new String(sample(), StandardCharsets.UTF_8).replace(">2.50<", ">2.505<");
        assertThatThrownBy(() -> parser.parse(bad.getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(StatementRejectedException.class);
    }
}
