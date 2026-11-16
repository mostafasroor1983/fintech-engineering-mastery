package com.fintechmastery.sb4.lesson01;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.Duration;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.properties.ConfigurationPropertiesBindException;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.boot.SpringApplication;
import org.springframework.test.web.servlet.assertj.MockMvcTester;

class BootFourChangesTest {

    /** Boot 4 change: @SpringBootTest alone no longer registers MockMvc (migration guide, "Testing"). */
    @Nested
    @SpringBootTest
    class WithoutAutoConfigureMockMvc {

        @Autowired
        ApplicationContext context;

        @Test
        void mockMvcIsNotThere() {
            assertThat(context.getBeanNamesForType(MockMvc.class)).isEmpty();
        }
    }

    /** The fix: add @AutoConfigureMockMvc explicitly. */
    @Nested
    @SpringBootTest
    @AutoConfigureMockMvc
    class WithAutoConfigureMockMvc {

        @Autowired
        MockMvcTester mvc;

        @Test
        void jackson3WritesMoneyExactlyAndDatesAsIsoStrings() {
            assertThat(mvc.get().uri("/payments/7f1c2d1e-0000-4000-8000-000000000001"))
                    .hasStatusOk()
                    .bodyJson()
                    .isLenientlyEqualTo("""
                            {"amount":10.50,"currency":"GBP","createdAt":"2026-11-12T09:30:00Z"}
                            """);
            assertThat(mvc.get().uri("/payments/7f1c2d1e-0000-4000-8000-000000000001"))
                    .bodyText().contains("\"amount\":10.50"); // scale kept: 10.50, not 10.5
        }
    }

    @Nested
    @SpringBootTest
    class TypedConfiguration {

        @Autowired
        PaymentLimits limits;

        @Test
        void bindsRecordWithTypes() {
            assertThat(limits.maxSinglePayment()).isEqualByComparingTo(new BigDecimal("25000.00"));
            assertThat(limits.quoteTtl()).isEqualTo(Duration.ofSeconds(30));
        }
    }

    @Test
    void invalidConfigurationFailsAtStartup() {
        SpringApplication app = new SpringApplication(Lesson01Application.class);
        // Command-line arguments override application.yml, like an operator's typo in production would.
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> app.run("--payments.limits.currency=pounds", "--server.port=0"))
                .isInstanceOf(ConfigurationPropertiesBindException.class)
                .rootCause().hasMessageContaining("currency");
    }
}
