---
id: track-01-lesson-13
title: "اختبار العقود — العقود التي يحددها المستهلك باستخدام Pact"
slug: contract-testing
track: track-01
trackName: "البنية المعمارية المتقدمة للبرمجيات"
sequence: 13
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Pact, contract-testing, consumer-driven, provider-verification, OpenAPI]
prerequisites: []
---

# اختبار العقود — العقود التي يحددها المستهلك باستخدام Pact

> [!NOTE]
> في الخدمات المالية، قد يوقف عقد واجهة برمجية مكسور بين مستهلك بوابة دفع ومزوّدها معاملات بملايين الدولارات في الساعة. ويكتشف اختبار العقود الذي يحدده المستهلك باستخدام Pact هذه الأعطال قبل وصولها إلى الإنتاج، فينقل التحقق إلى مرحلة مبكرة تُصاغ فيها توقعات المستهلك كعقود قابلة للتنفيذ.

## لماذا يهم اختبار العقود في التقنية المالية

يمثل اختبار التكامل بين الخدمات المصغّرة في منصة دفع معضلة أساسية: اختبارات الطرف إلى الطرف التي تشغّل كل الخدمات بطيئة وهشة ومكلفة؛ واختبارات الوحدة الخالصة مع المحاكيات قد تبتعد عن الواقع؛ والنشر في بيئة تكامل مشتركة يخلق عنق زجاجة يبطئ التسليم المستمر.

**اختبار العقود** يحل ذلك بفصل المسؤوليات:

- **المستهلك** يحدد بالضبط ما يحتاجه من المزوّد (العقد)
- **المزوّد** يتحقق باستقلال من قدرته على تلبية عقد كل مستهلك
- لا يحتاج أي طرف إلى تشغيل الطرف الآخر أثناء اختباراته

ولمنصة دفع بخدمات مثل `payment-service` و`account-service` و`fraud-service` و`notification-service`، تستطيع كل خدمة التحقق من العقود بمعزل، فيتحقق النشر المستقل فعلًا.

```
Traditional E2E Testing:
┌─────────────────────────────────────────────────────────┐
│  payment-service → account-service → ledger-service     │
│                  → fraud-service                        │
│                  → notification-service                 │
│  All must be running. One failure blocks all.           │
└─────────────────────────────────────────────────────────┘

Contract Testing:
┌───────────────────────┐    ┌───────────────────────────┐
│  Consumer Tests       │    │  Provider Verification    │
│  payment-service      │    │  account-service          │
│  defines contract     │───▶│  verifies it can satisfy  │
│  runs against mock    │    │  each consumer contract   │
└───────────────────────┘    └───────────────────────────┘
         │                               │
         └──────────┐  ┌────────────────┘
                    ▼  ▼
              ┌──────────────┐
              │  Pact Broker │
              │  (contract   │
              │   registry)  │
              └──────────────┘
```

## Pact JVM: المفاهيم الأساسية

يعرّف **Pact** العقود كمجموعة من التفاعلات: يحدد كل تفاعل طلبًا والرد المتوقع. وينتج اختبار المستهلك ملف Pact ‏(JSON) يُنشر إلى Pact Broker. ثم يعيد المزوّد تشغيل كل تفاعل على تنفيذ المزوّد الحقيقي.

أضف الاعتماديات إلى `payment-service/build.gradle`:

```groovy
dependencies {
    testImplementation 'au.com.dius.pact.consumer:junit5:4.6.5'
    testImplementation 'au.com.dius.pact.provider:junit5spring:4.6.5'
    testImplementation 'au.com.dius.pact.provider:spring:4.6.5'
}
```

---

## كتابة اختبارات المستهلك

يحتاج المستهلك (`payment-service`) إلى استدعاء `account-service` للتحقق من وجود الحساب وكفاية رصيده قبل معالجة الدفعة.

### نموذج المجال

```java
// payment-service/src/main/java/com/fintech/payment/client/AccountClient.java
package com.fintech.payment.client;

import com.fintech.payment.dto.AccountDto;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "account-service", url = "${account.service.url}")
public interface AccountClient {

    @GetMapping("/api/v1/accounts/{accountId}")
    AccountDto getAccount(@PathVariable("accountId") String accountId);

    @GetMapping("/api/v1/accounts/{accountId}/balance")
    AccountBalanceDto getBalance(@PathVariable("accountId") String accountId);
}
```

```java
// payment-service/src/main/java/com/fintech/payment/dto/AccountDto.java
package com.fintech.payment.dto;

import java.math.BigDecimal;
import java.time.OffsetDateTime;

public record AccountDto(
    String accountId,
    String accountNumber,
    String currency,
    AccountStatus status,
    String customerId,
    OffsetDateTime createdAt
) {}

public record AccountBalanceDto(
    String accountId,
    BigDecimal availableBalance,
    BigDecimal ledgerBalance,
    String currency
) {}

public enum AccountStatus {
    ACTIVE, SUSPENDED, CLOSED
}
```

### اختبار Pact للمستهلك

```java
// payment-service/src/test/java/com/fintech/payment/contract/AccountClientContractTest.java
package com.fintech.payment.contract;

import au.com.dius.pact.consumer.MockServer;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.dsl.PactDslWithProvider;
import au.com.dius.pact.consumer.junit5.PactConsumerTestExt;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.core.model.RequestResponsePact;
import au.com.dius.pact.core.model.annotations.Pact;
import com.fintech.payment.client.AccountClient;
import com.fintech.payment.dto.AccountDto;
import com.fintech.payment.dto.AccountBalanceDto;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;

import feign.FeignException;

import java.math.BigDecimal;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@ExtendWith(PactConsumerTestExt.class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
// Fixed port: the Spring context (and the Feign client URL) is built before the mock server starts
@PactTestFor(providerName = "account-service", port = "8089")
@TestPropertySource(properties = "account.service.url=http://localhost:8089")
class AccountClientContractTest {

    @Autowired
    private AccountClient accountClient;

    /**
     * Define what the payment-service expects when fetching an active account.
     * This interaction becomes a binding contract on account-service.
     */
    @Pact(consumer = "payment-service", provider = "account-service")
    RequestResponsePact getActiveAccountPact(PactDslWithProvider builder) {
        return builder
            .given("account ACC-001 exists and is active")
            .uponReceiving("a request to get account ACC-001")
                .path("/api/v1/accounts/ACC-001")
                .method("GET")
                .headers("Accept", "application/json")
            .willRespondWith()
                .status(200)
                .headers(Map.of("Content-Type", "application/json"))
                .body(new PactDslJsonBody()
                    .stringMatcher("accountId", "[A-Z]{3}-[0-9]{3}", "ACC-001")
                    .stringType("accountNumber", "GB29NWBK60161331926819")
                    .stringMatcher("currency", "GBP|USD|EUR", "GBP")
                    .stringMatcher("status", "ACTIVE|SUSPENDED", "ACTIVE")
                    .stringType("customerId", "CUST-12345")
                    .datetime("createdAt", "yyyy-MM-dd'T'HH:mm:ssXXX",
                              "2024-01-15T10:30:00Z")
                )
            .toPact();
    }

    @Pact(consumer = "payment-service", provider = "account-service")
    RequestResponsePact getAccountBalancePact(PactDslWithProvider builder) {
        return builder
            .given("account ACC-001 has sufficient balance")
            .uponReceiving("a request to get balance for ACC-001")
                .path("/api/v1/accounts/ACC-001/balance")
                .method("GET")
            .willRespondWith()
                .status(200)
                .body(new PactDslJsonBody()
                    .stringType("accountId", "ACC-001")
                    // Use type matchers, not exact values — contracts should be flexible
                    .decimalType("availableBalance", new BigDecimal("5000.00"))
                    .decimalType("ledgerBalance", new BigDecimal("5200.00"))
                    .stringMatcher("currency", "GBP|USD|EUR", "GBP")
                )
            .toPact();
    }

    @Pact(consumer = "payment-service", provider = "account-service")
    RequestResponsePact getNotFoundAccountPact(PactDslWithProvider builder) {
        return builder
            .given("account UNKNOWN-999 does not exist")
            .uponReceiving("a request to get a non-existent account")
                .path("/api/v1/accounts/UNKNOWN-999")
                .method("GET")
            .willRespondWith()
                .status(404)
                .body(new PactDslJsonBody()
                    .stringType("errorCode", "ACCOUNT_NOT_FOUND")
                    .stringType("message", "Account not found")
                )
            .toPact();
    }

    @Test
    @PactTestFor(pactMethod = "getActiveAccountPact")
    void shouldFetchActiveAccount(MockServer mockServer) {
        AccountDto account = accountClient.getAccount("ACC-001");

        assertThat(account).isNotNull();
        assertThat(account.status().name()).isEqualTo("ACTIVE");
        assertThat(account.currency()).isEqualTo("GBP");
    }

    @Test
    @PactTestFor(pactMethod = "getAccountBalancePact")
    void shouldFetchAccountBalance(MockServer mockServer) {
        AccountBalanceDto balance = accountClient.getBalance("ACC-001");

        assertThat(balance).isNotNull();
        assertThat(balance.availableBalance()).isPositive();
    }

    @Test
    @PactTestFor(pactMethod = "getNotFoundAccountPact")
    void shouldHandle404ForMissingAccount(MockServer mockServer) {
        // FeignClient should throw FeignException.NotFound
        assertThatThrownBy(() -> accountClient.getAccount("UNKNOWN-999"))
            .isInstanceOf(FeignException.NotFound.class);
    }
}
```

يستخدم الاختبار منفذًا ثابتًا لخادم المحاكاة، لأن سياق Spring (ورابط عميل Feign) يُبنى قبل أن يبدأ خادم المحاكاة.

### مبدأ تصميم أساسي: مطابِقات الأنواع أم القيم الدقيقة

من الأخطاء الشائعة كتابة عقود مستهلك تؤكد قيمًا دقيقة (مثل `availableBalance = 5000.00`). فهذا يصنع عقودًا هشة تنكسر عندما تتغير بيانات الاختبار. بدلًا من ذلك:

- استخدم **مطابِقات الأنواع** (`stringType`، و`decimalType`، و`integerType`) لأشكال الحقول
- استخدم **مطابِقات التعابير النمطية** للصيغ المنظمة (معرّفات الحسابات، وأرقام IBAN، والعملات)
- استخدم **القيم الدقيقة** فقط عندما تكون المساواة الدلالية جزءًا من العقد (قيم تعداد الحالة، ورموز الأخطاء)

```java
// WRONG: exact value creates a brittle contract
.body(new PactDslJsonBody()
    .stringValue("currency", "GBP")          // breaks if provider returns USD
    .numberValue("availableBalance", 5000.00) // breaks when test data changes
)

// CORRECT: type matchers with examples
.body(new PactDslJsonBody()
    .stringMatcher("currency", "^[A-Z]{3}$", "GBP")  // ISO 4217 format
    .decimalType("availableBalance", new BigDecimal("100.00")) // any decimal
)
```

---

## تحقق المزوّد

في جانب `account-service`، ينزّل Pact العقود من الوسيط ويعيد تشغيل كل تفاعل على تطبيق Spring Boot العامل.

```java
// account-service/src/test/java/com/fintech/account/contract/AccountServiceProviderTest.java
package com.fintech.account.contract;

import au.com.dius.pact.provider.junit5.PactVerificationContext;
import au.com.dius.pact.provider.junit5.PactVerificationInvocationContextProvider;
import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.State;
import au.com.dius.pact.provider.junitsupport.loader.PactBroker;
import au.com.dius.pact.provider.junitsupport.loader.PactBrokerAuth;
import au.com.dius.pact.provider.spring.junit5.MockMvcTestTarget;
import com.fintech.account.domain.Account;
import com.fintech.account.domain.AccountStatus;
import com.fintech.account.repository.AccountRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.TestTemplate;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;

import static org.mockito.Mockito.when;

@SpringBootTest
@AutoConfigureMockMvc
@Provider("account-service")
@PactBroker(
    url = "${pact.broker.url}",
    authentication = @PactBrokerAuth(
        username = "${pact.broker.username}",
        password = "${pact.broker.password}"
    )
)
class AccountServiceProviderTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean   // replaces the deprecated @MockBean (Spring Boot 3.4+)
    private AccountRepository accountRepository;

    @BeforeEach
    void before(PactVerificationContext context) {
        context.setTarget(new MockMvcTestTarget(mockMvc));
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verifyPact(PactVerificationContext context) {
        context.verifyInteraction();
    }

    /**
     * Provider states set up the test data that corresponds to what
     * the consumer described in its @Pact "given" clause.
     */
    @State("account ACC-001 exists and is active")
    void setupActiveAccount() {
        Account account = Account.builder()
            .id(UUID.fromString("550e8400-e29b-41d4-a716-446655440000"))
            .accountId("ACC-001")
            .accountNumber("GB29NWBK60161331926819")
            .currency("GBP")
            .status(AccountStatus.ACTIVE)
            .customerId("CUST-12345")
            .createdAt(OffsetDateTime.parse("2024-01-15T10:30:00+00:00"))
            .build();

        when(accountRepository.findByAccountId("ACC-001"))
            .thenReturn(Optional.of(account));
    }

    @State("account ACC-001 has sufficient balance")
    void setupAccountWithBalance() {
        Account account = Account.builder()
            .accountId("ACC-001")
            .availableBalance(new BigDecimal("5000.00"))
            .ledgerBalance(new BigDecimal("5200.00"))
            .currency("GBP")
            .build();

        when(accountRepository.findByAccountId("ACC-001"))
            .thenReturn(Optional.of(account));
    }

    @State("account UNKNOWN-999 does not exist")
    void setupMissingAccount() {
        when(accountRepository.findByAccountId("UNKNOWN-999"))
            .thenReturn(Optional.empty());
    }
}
```

### تنظيف حالة المزوّد

للاختبارات ذات الحالة مع قواعد بيانات حقيقية، استخدم دوال إعداد الحالة وتنظيفها:

```java
@State(value = "account ACC-001 exists and is active", action = StateChangeAction.SETUP)
void setupActiveAccountInDb() {
    jdbcTemplate.update(
        "INSERT INTO accounts (account_id, account_number, currency, status, customer_id) " +
        "VALUES (?, ?, ?, ?, ?)",
        "ACC-001", "GB29NWBK60161331926819", "GBP", "ACTIVE", "CUST-12345"
    );
}

@State(value = "account ACC-001 exists and is active", action = StateChangeAction.TEARDOWN)
void teardownActiveAccount() {
    jdbcTemplate.update("DELETE FROM accounts WHERE account_id = ?", "ACC-001");
}
```

---

## إعداد Pact Broker

‏Pact Broker سجل مركزي للعقود. باستخدام Docker Compose لإعداد محلي أو في CI:

```yaml
# docker-compose-pact.yml
version: '3.8'
services:
  pact-broker:
    image: pactfoundation/pact-broker:2.107.1
    ports:
      - "9292:9292"
    environment:
      PACT_BROKER_DATABASE_URL: "postgres://pact:password@pact-db/pact_broker"
      PACT_BROKER_BASIC_AUTH_USERNAME: "admin"
      PACT_BROKER_BASIC_AUTH_PASSWORD: "secret"
      PACT_BROKER_ALLOW_PUBLIC_READ: "true"
      PACT_BROKER_PUBLIC_HEARTBEAT: "true"
    depends_on:
      - pact-db

  pact-db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: pact_broker
      POSTGRES_USER: pact
      POSTGRES_PASSWORD: password
    volumes:
      - pact-db-data:/var/lib/postgresql/data

volumes:
  pact-db-data:
```

### نشر العقود من المستهلك

اضبط إضافة Pact في Gradle لنشر العقود بعد تشغيل اختبارات المستهلك:

```groovy
// payment-service/build.gradle
plugins {
    id 'au.com.dius.pact' version '4.6.5'
}

pact {
    publish {
        pactBrokerUrl = System.getenv("PACT_BROKER_URL") ?: "http://localhost:9292"
        pactBrokerUsername = System.getenv("PACT_BROKER_USERNAME") ?: "admin"
        pactBrokerPassword = System.getenv("PACT_BROKER_PASSWORD") ?: "secret"
        consumerVersion = System.getenv("GIT_SHA") ?: project.version   // git SHA in CI
        consumerBranch = System.getenv("GIT_BRANCH") ?: "local"         // branches replace tags
    }
}
```

شغّل بالأمر: `./gradlew test pactPublish`

---

## التكامل مع CI/CD

تتحقق قوة Pact عبر أداة **can-i-deploy**، التي تستعلم Pact Broker لتحديد هل نشر خدمة في بيئة ما آمن.

```yaml
# .github/workflows/payment-service-ci.yml
name: Payment Service CI

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  consumer-contract-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'

      - name: Run consumer contract tests and publish
        env:
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
          PACT_BROKER_USERNAME: ${{ secrets.PACT_BROKER_USERNAME }}
          PACT_BROKER_PASSWORD: ${{ secrets.PACT_BROKER_PASSWORD }}
          GIT_SHA: ${{ github.sha }}
          GIT_BRANCH: ${{ github.ref_name }}
        run: ./gradlew test pactPublish

      - name: Can I deploy?
        env:
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
        run: |
          docker run --rm \
            -e PACT_BROKER_BASE_URL=$PACT_BROKER_URL \
            -e PACT_BROKER_USERNAME=${{ secrets.PACT_BROKER_USERNAME }} \
            -e PACT_BROKER_PASSWORD=${{ secrets.PACT_BROKER_PASSWORD }} \
            pactfoundation/pact-cli:latest \
            broker can-i-deploy \
              --pacticipant payment-service \
              --version ${{ github.sha }} \
              --to-environment production

  provider-contract-verification:
    # This job runs on the account-service repo when triggered
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Verify provider contracts (JUnit 5 provider tests)
        env:
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
        run: |
          ./gradlew test --tests '*ProviderTest' \
            -Dpact.broker.url=$PACT_BROKER_URL \
            -Dpact.provider.version=${{ github.sha }} \
            -Dpact.provider.branch=${{ github.ref_name }} \
            -Dpact.verifier.publishResults=true
```

### تحقق يطلقه webhook

اضبط Pact Broker ليطلق تحقق المزوّد تلقائيًا عند نشر عقد مستهلك جديد:

```bash
# Create a webhook on the Pact Broker to notify account-service when payment-service publishes a new pact
curl -X POST "http://localhost:9292/webhooks" \
  -H "Content-Type: application/json" \
  -u "admin:secret" \
  -d '{
    "description": "Trigger account-service verification when payment-service publishes",
    "events": [{"name": "contract_requiring_verification_published"}],
    "request": {
      "method": "POST",
      "url": "https://api.github.com/repos/myorg/account-service/actions/workflows/provider-verify.yml/dispatches",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_GITHUB_TOKEN",
        "Content-Type": "application/json"
      },
      "body": {
        "ref": "main",
        "inputs": {
          "pact_url": "${pactbroker.pactUrl}"
        }
      }
    },
    "provider": {"name": "account-service"},
    "consumer": {"name": "payment-service"}
  }'
```

---

## اختبار العقود مع OpenAPI

للفرق التي تستخدم مواصفات OpenAPI بالفعل، يمكن دمج Pact مع التحقق من OpenAPI لفرض الالتزام بالمخطط:

```groovy
// Use swagger-request-validator-pact for OpenAPI + Pact hybrid approach
dependencies {
    testImplementation 'com.atlassian.oai:swagger-request-validator-pact:2.40.0'
}
```

```java
// Validate that the provider's OpenAPI spec covers all consumer interactions
@Test
void openApiSpecCoversPactInteractions() throws Exception {
    // The consumer's pact file (downloaded from the broker in CI)
    URL pactFile = Path.of("build/pacts/payment-service-account-service.json").toUri().toURL();

    PactProviderValidator validator = PactProviderValidator
        .createFor("src/main/resources/openapi/account-service-v1.yaml")
        .withConsumer("payment-service", pactFile)
        .build();

    PactProviderValidationResults results = validator.validate();

    assertThat(results.hasErrors())
        .as("OpenAPI violations in pact interactions: %s", results.getValidationFailureReport())
        .isFalse();
}
```

### توافق مخطط OpenAPI مع Spectral

لواجهات الدفع، افرض قواعد الحوكمة كجزء من CI:

```yaml
# .spectral.yml — governance rules for payment API (Spectral lints one spec at a time)
rules:
  # Error responses must use RFC 9457 problem details
  error-responses-use-problem-json:
    message: "4xx responses must be application/problem+json"
    severity: error
    given: "$.paths[*][*].responses['400','404','409','422'].content"
    then:
      field: "application/problem+json"
      function: truthy

  # Payment amounts must always be string (to preserve precision)
  payment-amount-string-type:
    message: "Payment amounts must be string type to preserve decimal precision"
    severity: error
    given: "$.components.schemas[*].properties[?(@property == 'amount')]"
    then:
      field: type
      function: enumeration
      functionOptions:
        values: ["string"]
```

يفحص Spectral إصدارًا واحدًا من المواصفة. ولاكتشاف التغييرات الكاسرة *بين* الإصدارات — حقل رد محذوف، أو حقل طلب إلزامي جديد — قارن المواصفة القديمة بالجديدة في CI بأداة مثل oasdiff: ‏`oasdiff breaking main.yaml head.yaml --fail-on ERR`.

---

## اختبار عقود واجهة فحص الاحتيال

مثال أعقد: تستدعي `payment-service` الخدمة `fraud-service` لتقييم الاحتيال قبل تفويض الدفعة.

```java
@Pact(consumer = "payment-service", provider = "fraud-service")
RequestResponsePact fraudAssessmentPact(PactDslWithProvider builder) {
    PactDslJsonBody requestBody = new PactDslJsonBody()
        .stringMatcher("paymentId", "PAY-[0-9]{8}", "PAY-20240115")
        .stringType("accountId", "ACC-001")
        .decimalType("amount", new BigDecimal("250.00"))
        .stringMatcher("currency", "^[A-Z]{3}$", "GBP")
        .stringType("merchantId", "MERCH-001")
        .stringType("merchantCategory", "RETAIL")
        .object("deviceContext")
            .stringType("ipAddress", "192.168.1.100")
            .stringType("userAgent", "Mozilla/5.0")
            .closeObject();

    PactDslJsonBody responseBody = new PactDslJsonBody()
        .stringMatcher("assessmentId", "FA-[0-9]{8}", "FA-20240115")
        .stringMatcher("decision", "APPROVE|REVIEW|DECLINE", "APPROVE")
        .numberType("riskScore", 15)
        .array("flags").closeArray()
        .datetime("assessedAt", "yyyy-MM-dd'T'HH:mm:ss.SSSZ");

    return builder
        .given("fraud service is operational")
        .uponReceiving("a fraud assessment request for a low-risk payment")
            .path("/api/v1/fraud/assess")
            .method("POST")
            .headers("Content-Type", "application/json")
            .body(requestBody)
        .willRespondWith()
            .status(200)
            .body(responseBody)
        .toPact();
}
```

---

## العقود المعلّقة والعمل الجاري

يدعم Pact Broker **العقود المعلّقة (Pending Pacts)** — وهي ميزة حاسمة لفرق التقنية المالية التي تتبنى اختبار العقود تدريجيًا. فعندما ينشر مستهلك عقدًا جديدًا لم يتحقق منه المزوّد بعد، يُعلَّم بأنه "معلّق"، ولا يكسر فشل التحقق منه خط CI لدى المزوّد.

```java
@Provider("account-service")
@PactBroker(
    url = "${pact.broker.url}",
    enablePendingPacts = "true",   // don't fail the build for new, never-verified pacts
    providerBranch = "main"        // pending status is tracked per provider branch
)
class AccountServiceProviderTest {

    @PactBrokerConsumerVersionSelectors
    static SelectorBuilder consumerVersionSelectors() {
        return new SelectorBuilder()
            .mainBranch()            // consumers' main branch
            .deployedOrReleased();   // versions running in any environment
    }
    // ... verifyPact and @State methods as above
}
```

وهذا يتيح:
1. لفريق المستهلك نشر عقد جديد (معلّق)
2. لفريق المزوّد رؤيته في مخرجات التحقق على أنه "معلّق"
3. للمزوّد العمل على تلبية العقد في سبرنت خاص به
4. وعند تلبيته، يصبح العقد "متحققًا منه" ومفروضًا

---

## أخطاء شائعة

**1. المبالغة في تحديد العقد**
استخدام قيم حقول دقيقة بدل مطابِقات الأنواع يصنع عقودًا تنكسر عندما يغيّر المزوّد بيانات الاختبار. يجب أن يحدد العقد *شكل* الرد، لا البيانات الدقيقة.

**2. حالات مزوّد مفقودة**
إذا كتب المستهلك `given("account has sufficient balance")` لكن المزوّد لم ينفّذ أبدًا `@State` المقابلة، فسيعمل التحقق على حالة النظام الفارغة أو الافتراضية — فينتج نجاحًا كاذبًا.

**3. اختبار منطق العمل في العقود**
تتحقق العقود من أن الخدمات تستطيع التواصل — لا من صحة منطق العمل. لا تستخدم Pact لاختبار أن "الدفعة تُرفض عند عدم كفاية الرصيد". استخدم اختبارات تكامل على مستوى الخدمة لذلك.

**4. عدم نشر نتائج تحقق المزوّد**
إذا لم ينشر المزوّدون نتائج التحقق إلى Pact Broker، فلن يستطيع فحص `can-i-deploy` تحديد هل النشر آمن. اضبط دائمًا `-Dpact.verifier.publishResults=true` (مع `pact.provider.version` و`pact.provider.branch`) في CI.

**5. تجاهل انحراف العقود في الخدمات طويلة العمر**
تتطور منصات الدفع. اضبط webhooks في Pact بحيث يُطلق CI لدى المزوّد فورًا عندما ينشر أي مستهلك إصدار عقد جديدًا — وإلا تراكم الانحراف بصمت.

---

## نصائح للإنتاج

**إصدار العقود بمعرّف الالتزام في Git لا بالإصدار الدلالي**
استخدام معرّف الالتزام (SHA) في git كإصدار للعقد يتيح لفحص `can-i-deploy` العمل بشكل صحيح مع التزامات محددة بدل إصدارات عامة.

**استخدم تتبع البيئات**
سجّل في Pact Broker أي الإصدارات منشورة في أي البيئات:

```bash
# After deploying account-service to production:
pact-broker record-deployment \
  --pacticipant account-service \
  --version $GIT_SHA \
  --environment production
```

**محددات المستهلكين لتحقق واقعي**
تحقق من العقود المنشورة في الإنتاج، لا من الأحدث فقط:

```java
@PactBrokerConsumerVersionSelectors
static SelectorBuilder consumerVersionSelectors() {
    return new SelectorBuilder()
        .deployedOrReleased()   // currently in an environment (e.g. production)
        .mainBranch()           // what will be deployed next
        .matchingBranch();      // consumer pacts from a feature branch with the same name
}
```

**احفظ ملفات Pact في نظام التحكم بالمصدر كاحتياط**
للبيئات المعزولة عن الشبكة أو للتعافي من الكوارث، احفظ ملفات JSON المولّدة للعقود في مجلد `/contracts` في مستودع المزوّد. فهذا يوفر مسار تحقق بلا اتصال عندما يكون Pact Broker غير متاح.

**اربط فشل Pact بتغييرات OpenAPI**
في CI لدى المزوّد، قارن مواصفة OpenAPI بين HEAD وآخر التزام متحقق منه. فإذا تغيرت المواصفة وفشل تحقق Pact، فتغيير OpenAPI هو المتهم المرجح — أظهر ذلك في مخرجات الفشل.

```yaml
# In CI, before running pact verify:
- name: Detect OpenAPI changes
  run: |
    git diff origin/main HEAD -- src/main/resources/openapi/ \
      | tee /tmp/openapi-diff.txt
    if [ -s /tmp/openapi-diff.txt ]; then
      echo "::warning::OpenAPI spec changed — verify Pact contracts carefully"
    fi
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يؤكد اختبار Pact لدى المستهلك أن الحقل availableBalance في رد رصيد الحساب يساوي 5000.00 بالضبط. ما المشكلة التي يسببها ذلك وكيف تُصلح؟",
      "options": [
        "تأكيد القيمة الدقيقة صحيح — يجب أن تكون العقود محددة قدر الإمكان لمنع التراجعات.",
        "استخدام قيمة دقيقة يصنع عقدًا هشًا ينكسر عندما يغيّر المزوّد بيانات الاختبار. يجب استخدام مطابِق نوع (decimalType) بدلًا من ذلك، يحدد شكل الحقل فقط.",
        "القيم الدقيقة مشكلة في الحقول النصية فقط؛ أما الحقول الرقمية مثل BigDecimal فتأكيدها بدقة آمن.",
        "يجب أن يستخدم الاختبار مطابِق تعبير نمطي بدل تأكيد القيمة الدقيقة لكل الحقول الرقمية."
      ],
      "correct": 1,
      "explanation": "يجب أن تحدد العقود شكل الرد (نوع الحقل وصيغته)، لا قيم بيانات اختبار دقيقة. فاستخدام decimalType('availableBalance', new BigDecimal('100.00')) يتحقق من وجود الحقل وأنه عشري، دون ربط العقد ببيانات اختبار محددة. أما القيم الدقيقة فتنكسر عندما تتغير بيانات اختبار المزوّد، فتنتج فشل عقود كاذبًا لا علاقة له بالتوافق الفعلي للواجهة."
    },
    {
      "text": "أعاد فحص 'can-i-deploy' في Pact Broker فشلًا لخدمة payment-service. علامَ يدل ذلك وماذا يجب أن يفعل الفريق؟",
      "options": [
        "Pact Broker غير متاح ويجب أن يمضي الفريق في النشر.",
        "لدى payment-service عقد مستهلك لا يستطيع المزوّد (account-service) تلبيته في البيئة الهدف، فالنشر الآن سيكسر التكامل.",
        "لم تنشر payment-service ملف العقد إلى الوسيط بعد آخر تشغيل لاختبارات المستهلك.",
        "لم تُنشر نتائج تحقق المزوّد إلى Pact Broker، فلا يمكن تحديد حالة النشر."
      ],
      "correct": 1,
      "explanation": "يستعلم can-i-deploy الوسيط لتحديد هل نشر إصدار معين من خدمة سيكسر أي علاقة قائمة بين مستهلك ومزوّد. والفشل يعني أن عقدًا واحدًا على الأقل يجب أن تلبيه الخدمة غير متحقق منه للإصدار الحالي — فالنشر سيكسر تكاملًا معروفًا. ويجب أن يحقق الفريق في التفاعل الفاشل قبل النشر."
    },
    {
      "text": "دالة @State لدى المزوّد مفقودة للحالة 'account ACC-001 has sufficient balance' التي عرّفها مستهلك في @Pact. ما العاقبة؟",
      "options": [
        "يرمي إطار Pact استثناء ProviderStateNotFound ويفشل اختبار التحقق فورًا.",
        "يعمل تحقق المزوّد على الحالة الافتراضية للنظام (بيانات فارغة أو قليلة)، وقد ينجح بينما كان التنفيذ الفعلي سيفشل — نجاح كاذب.",
        "سيفشل اختبار المستهلك لأن خادم المحاكاة لا يجد حالة المزوّد المطابقة.",
        "يُعلَّم ملف العقد بأنه معلّق في Pact Broker حتى تُنفَّذ حالة المزوّد."
      ],
      "correct": 1,
      "explanation": "إذا لم تُنفَّذ حالة المزوّد، يعمل التحقق على أي بيانات موجودة في النظام افتراضيًا. وقد ينتج ذلك نجاحًا كاذبًا — فالتفاعل ينجح على حالة فارغة أو افتراضية، بينما يتصرف المسار الحقيقي بشكل مختلف عند إعداد الحالة الموصوفة فعلًا. وحالات المزوّد المفقودة من أكثر مصادر نتائج اختبارات العقود الخاطئة شيوعًا."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تنفيذ اختبار العقود الذي يحدده المستهلك لمنصة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "اكتب اختبار Pact كاملًا للمستهلك payment-service الذي يستدعي account-service. عرّف ثلاثة تفاعلات: (أ) جلب حساب نشط باستخدام مطابِقات الأنواع ومطابِقات التعابير النمطية لحقلي accountId وcurrency، (ب) جلب رصيد حساب باستخدام decimalType للحقلين availableBalance وledgerBalance، (ج) التعامل مع 404 لحساب غير موجود. يجب أن تستخدم التفاعلات الثلاثة مطابِقات مناسبة — بلا تأكيد قيم دقيقة إلا لقيم تعداد الحالة ورموز الأخطاء."},
    {"id": "2", "description": "اكتب اختبار تحقق المزوّد لـ account-service باستخدام الوسوم @Provider و@PactBroker و@State. نفّذ ثلاث دوال لإعداد حالات المزوّد تطابق جمل given لدى المستهلك. واضبط MockMvc كهدف للاختبار. وأعدّ تنظيف حالة المزوّد باستخدام StateChangeAction.TEARDOWN مع قاعدة بيانات حقيقية (عبر JdbcTemplate) بدل المحاكاة، وتحقق من أن التنظيف يزيل بيانات الاختبار بشكل صحيح بعد كل تفاعل."},
    {"id": "3", "description": "اكتب سير عمل GitHub Actions لخدمة payment-service: (أ) يشغّل اختبارات عقود المستهلك وينشر العقود إلى Pact Broker مستخدمًا معرّف الالتزام في git كإصدار للمستهلك، (ب) يشغّل فحص can-i-deploy على بيئة الإنتاج قبل خطوة النشر، (ج) يسجّل النشر في Pact Broker بعد نجاحه. واضبط webhook في Pact Broker يطلق تحقق المزوّد account-service تلقائيًا كلما نشرت payment-service عقدًا جديدًا."},
    {"id": "4", "description": "اكتب مجموعة قواعد Spectral ‏(.spectral.yml) لمواصفة OpenAPI لخدمة account-service تفرض: (أ) أن تكون كل حقول المبالغ النقدية من النوع string للحفاظ على الدقة العشرية، (ب) أن يكون لكل حقل إلزامي وصف، (ج) أن تتضمن كل مخططات ردود الأخطاء الحقلين errorCode وmessage. واكتب اختبارًا يحمّل مواصفة OpenAPI تجريبية فيها مخالفتان مقصودتان ويتحقق من أن Spectral يبلّغ عن هاتين المخالفتين بالضبط."}
  ]
}
-->
