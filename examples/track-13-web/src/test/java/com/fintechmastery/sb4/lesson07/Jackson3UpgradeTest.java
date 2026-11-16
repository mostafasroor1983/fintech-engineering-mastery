package com.fintechmastery.sb4.lesson07;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.Instant;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import tools.jackson.core.exc.StreamReadException;
import tools.jackson.databind.exc.MismatchedInputException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Pins the Jackson 3 behaviour changes that surprise teams upgrading from Boot 3 (Jackson 2).
 * Measured on Spring Boot 4.0.9 / Jackson 3.1.7.
 */
class Jackson3UpgradeTest {

    static Transfer sample() {
        Transfer t = new Transfer();
        t.reference = "R1";
        t.amount = new BigDecimal("10.50");
        t.currency = "GBP";
        t.bookedAt = Instant.parse("2026-11-12T09:30:00Z");
        return t;
    }

    @Nested
    @SpringBootTest
    class BootFourDefaults {

        @Autowired
        JsonMapper json;

        @Test
        void propertiesAreSortedAlphabetically() {
            assertThat(json.writeValueAsString(sample()))
                    .isEqualTo("{\"amount\":10.50,\"attempts\":0,\"bookedAt\":\"2026-11-12T09:30:00Z\",\"currency\":\"GBP\",\"reference\":\"R1\"}");
        }

        @Test
        void nullForAPrimitiveIsRejected() {
            assertThatThrownBy(() -> json.readValue("{\"attempts\":null}", Transfer.class))
                    .isInstanceOf(MismatchedInputException.class);
        }

        @Test
        void trailingGarbageIsRejected() {
            assertThatThrownBy(() -> json.readValue("{\"reference\":\"R1\"} x", Transfer.class))
                    .isInstanceOf(StreamReadException.class);
        }

        @Test
        void unknownPropertiesAreIgnored() {
            assertThat(json.readValue("{\"reference\":\"R1\",\"newField\":1}", Transfer.class).reference).isEqualTo("R1");
        }

        @Test
        void fixPinnedOrderAndNullableFieldKeepTheOldContract() {
            TransferV2 t = json.readValue("{\"reference\":\"R1\",\"attempts\":null}", TransferV2.class);
            t.amount = new BigDecimal("10.50");
            t.currency = "GBP";
            assertThat(t.attempts).isNull();
            assertThat(json.writeValueAsString(t)).startsWith("{\"reference\":\"R1\",\"amount\":10.50,\"currency\":\"GBP\"");
        }
    }

    /** Temporary migration switch: behaves like Jackson 2 while you fix contracts one by one. */
    @Nested
    @SpringBootTest(properties = "spring.jackson.use-jackson2-defaults=true")
    class Jackson2Defaults {

        @Autowired
        JsonMapper json;

        @Test
        void declarationOrderAndLenientReading() {
            assertThat(json.writeValueAsString(sample())).startsWith("{\"reference\":\"R1\",\"amount\":10.50");
            assertThat(json.readValue("{\"attempts\":null}", Transfer.class).attempts).isZero();
        }
    }
}
