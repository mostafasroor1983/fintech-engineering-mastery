package com.fintechmastery.payments;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.client.RestTestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "payments.outbox.relay-enabled=false") // tests drive the relay by hand
@AutoConfigureRestTestClient
@Import(TestcontainersConfig.class)
abstract class IntegrationTest {

    @Autowired
    RestTestClient http;

    @Autowired
    JdbcClient jdbc;

    @BeforeEach
    void cleanDatabase() {
        // DELETE, not TRUNCATE: TRUNCATE takes ACCESS EXCLUSIVE locks and can deadlock with the Kafka
        // listener that is still processing (or retrying) a message from the previous test.
        for (String table : new String[] {"settlement_instruction", "processed_event", "outbox_event", "idempotency_key", "payment"}) {
            jdbc.sql("DELETE FROM " + table).update();
        }
    }

    static String body(String amount, String currency) {
        return """
                {"debtorAccount":"GB33BUKB20201555555555","creditorAccount":"DE89370400440532013000",
                 "amount":%s,"currency":"%s","reference":"Invoice 42"}
                """.formatted(amount, currency);
    }

    long count(String table) {
        return jdbc.sql("SELECT count(*) FROM " + table).query(Long.class).single();
    }
}
