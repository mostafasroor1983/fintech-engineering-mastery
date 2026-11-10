---
id: track-01-lesson-13
title: "Contract Testing — Consumer-Driven Contracts with Pact"
slug: contract-testing
track: track-01
trackName: "Financial Services Architecture"
sequence: 13
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [Pact, contract-testing, consumer-driven, provider-verification, OpenAPI]
prerequisites: []
---

# Contract Testing — Consumer-Driven Contracts with Pact

> [!NOTE]
> In financial services, a broken API contract between a payment gateway consumer and a provider can halt transactions worth millions of dollars per hour. Consumer-driven contract testing with Pact catches these breakages before they reach production, shifting the verification left to the point where the consumer's expectations are codified as executable contracts.

## Why Contract Testing Matters in Fintech

Integration testing between microservices in a payment platform presents a fundamental dilemma: end-to-end tests that spin up all services are slow, brittle, and expensive; pure unit tests with mocks may diverge from reality; and deploying to a shared integration environment creates a bottleneck that slows continuous delivery.

**Contract testing** resolves this by separating concerns:

- The **consumer** defines exactly what it needs from the provider (the contract)
- The **provider** verifies it can satisfy every consumer's contract independently
- Neither side needs the other running during their tests

For a payment platform with services like `payment-service`, `account-service`, `fraud-service`, and `notification-service`, each service can verify contracts in isolation, enabling true independent deployability.

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

## Pact JVM: Core Concepts

**Pact** defines contracts as a set of interactions: each interaction specifies a request and the expected response. The consumer test produces a Pact file (JSON), which is published to a Pact Broker. The provider then replays each interaction against the real provider implementation.

Add the dependencies to `payment-service/build.gradle`:

```groovy
dependencies {
    testImplementation 'au.com.dius.pact.consumer:junit5:4.6.5'
    testImplementation 'au.com.dius.pact.provider:junit5spring:4.6.5'
    testImplementation 'au.com.dius.pact.provider:spring:4.6.5'
}
```

---

## Writing Consumer Tests

The consumer (`payment-service`) needs to call `account-service` to validate that an account exists and has sufficient balance before processing a payment.

### Domain Model

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

### Consumer Pact Test

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

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

@ExtendWith(PactConsumerTestExt.class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
@PactTestFor(providerName = "account-service")
@TestPropertySource(properties = "account.service.url=http://localhost:${pact.mock.port}")
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
                    .datetime("createdAt", "yyyy-MM-dd'T'HH:mm:ssZ",
                              "2024-01-15T10:30:00+0000")
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

### Key Design Principle: Type Matchers vs Exact Values

A common mistake is writing consumer contracts that assert exact values (e.g., `availableBalance = 5000.00`). This creates brittle contracts that break when test data changes. Instead:

- Use **type matchers** (`stringType`, `decimalType`, `integerType`) for field shapes
- Use **regex matchers** for structured formats (account IDs, ISBANs, currencies)
- Use **exact values** only when semantic equality is contractual (status enum values, error codes)

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

## Provider Verification

On the `account-service` side, Pact downloads contracts from the broker and replays each interaction against the running Spring Boot application.

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
import org.springframework.boot.test.mock.mockito.MockBean;
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

    @MockBean
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

### Provider State Teardown

For stateful tests with real databases, use state setup and teardown hooks:

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

## Pact Broker Setup

The Pact Broker is a central registry for contracts. Using Docker Compose for a local/CI setup:

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

### Publishing Contracts from Consumer

Configure the Pact Gradle plugin to publish contracts after the consumer test run:

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
        consumerVersion = project.version
        tags = [System.getenv("GIT_BRANCH") ?: "local", "latest"]
    }
}
```

Run with: `./gradlew test pactPublish`

---

## CI/CD Integration

The power of Pact is realized through the **can-i-deploy** tool, which queries the Pact Broker to determine whether it is safe to deploy a service to an environment.

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
        run: |
          ./gradlew test pactPublish \
            -Dpact.consumer.version=${{ github.sha }} \
            -Dpact.tag=${{ github.ref_name }}

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

      - name: Verify provider contracts
        env:
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
          PACT_PROVIDER_VERSION: ${{ github.sha }}
        run: |
          ./gradlew pactVerify \
            -Dpact.broker.url=$PACT_BROKER_URL \
            -Dpact.provider.version=$PACT_PROVIDER_VERSION \
            -Dpact.publish.results=true
```

### Webhook-Triggered Verification

Configure the Pact Broker to trigger provider verification automatically when a new consumer contract is published:

```bash
# Create a webhook on the Pact Broker to notify account-service when payment-service publishes a new pact
curl -X POST "http://localhost:9292/webhooks" \
  -H "Content-Type: application/json" \
  -u "admin:secret" \
  -d '{
    "description": "Trigger account-service verification when payment-service publishes",
    "events": [{"name": "contract_content_changed"}],
    "request": {
      "method": "POST",
      "url": "https://api.github.com/repos/myorg/account-service/actions/workflows/provider-verify.yml/dispatches",
      "headers": {
        "Authorization": "Bearer ${user.name}",
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

## OpenAPI Contract Testing

For teams already using OpenAPI specs, Pact can be combined with OpenAPI validation to enforce schema compliance:

```java
// Use swagger-request-validator-pact for OpenAPI + Pact hybrid approach
dependencies {
    testImplementation 'com.atlassian.oai:swagger-request-validator-pact:2.40.0'
}
```

```java
// Validate that the provider's OpenAPI spec covers all consumer interactions
@Test
void openApiSpecCoversPactInteractions() throws IOException {
    String openApiSpec = Files.readString(
        Path.of("src/main/resources/openapi/account-service-v1.yaml")
    );

    OpenApiInteractionValidator validator = OpenApiInteractionValidator
        .createForInlineApiSpecification(openApiSpec)
        .build();

    // Load the pact file produced by consumer tests
    Pact pact = PactReader.loadPact(
        new File("build/pacts/payment-service-account-service.json")
    );

    for (Interaction interaction : pact.getInteractions()) {
        Request request = ((RequestResponseInteraction) interaction).getRequest();
        Response response = ((RequestResponseInteraction) interaction).getResponse();

        SimpleRequest simpleRequest = SimpleRequest.Builder
            .from(request.getMethod(), request.getPath())
            .withBody(request.getBody().orElse(""))
            .build();

        SimpleResponse simpleResponse = SimpleResponse.Builder
            .status(response.getStatus())
            .withBody(response.getBody().orElse(""))
            .build();

        ValidationReport report = validator.validate(simpleRequest, simpleResponse);
        assertThat(report.getMessages())
            .as("OpenAPI violations in interaction: %s", interaction.getDescription())
            .isEmpty();
    }
}
```

### OpenAPI Schema Compatibility with Spectral

For payment APIs, enforce backwards compatibility rules as part of CI:

```yaml
# .spectral.yml — governance rules for payment API
rules:
  # Ensure no required fields are removed (breaking change)
  no-required-field-removal:
    message: "Removing a required field is a breaking change"
    severity: error
    given: "$.paths[*][*].requestBody.content[*].schema.required"
    then:
      function: schema

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

---

## Testing Fraud Check API Contracts

A more complex example: `payment-service` calls `fraud-service` for a fraud assessment before authorising a payment.

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

## Pending Pacts and Work In Progress

Pact Broker supports **Pending Pacts** — a feature critical for fintech teams adopting contract testing incrementally. When a consumer publishes a new contract that the provider hasn't yet verified, it is marked as "pending" and failing verification does not break the provider's CI pipeline.

```java
@PactBroker(
    url = "${pact.broker.url}",
    consumersWithSelectors = {
        @ConsumerVersionSelectors(tag = "main"),
        @ConsumerVersionSelectors(deployedOrReleased = true)
    },
    enablePendingPacts = true,        // Don't fail build for new unverified pacts
    providerTagsToCheckFunctionallyEquivalent = {"main"}
)
```

This allows:
1. Consumer team to publish a new contract (pending)
2. Provider team to see it in their verification output as "pending"
3. Provider works to satisfy the contract in their own sprint
4. Once satisfied, the pact becomes "verified" and enforced

---

## Common Pitfalls

**1. Over-specifying the Contract**
Using exact field values instead of type matchers creates contracts that break when the provider changes test data. The contract should specify the *shape* of the response, not the exact data.

**2. Missing Provider States**
If the consumer writes `given("account has sufficient balance")` but the provider never implements that `@State`, verification will pass against an empty/default system state — giving a false green.

**3. Testing Business Logic in Contracts**
Contracts verify that services can communicate — not that the business logic is correct. Do not use Pact to test that "a payment is declined when balance is insufficient." Use service-level integration tests for that.

**4. Not Publishing Provider Verification Results**
If providers don't publish verification results back to the Pact Broker, the `can-i-deploy` check cannot determine whether it is safe to deploy. Always set `-Dpact.publish.results=true` in CI.

**5. Ignoring Contract Drift in Long-Running Services**
Payment platforms evolve. Set up Pact webhooks so that when any consumer publishes a new pact version, the provider's CI is immediately triggered — otherwise drift accumulates silently.

---

## Production Tips

**Version Pacts by Git SHA, not Semantic Version**
Using the git commit SHA as the pact version enables the `can-i-deploy` check to work correctly with specific commits rather than coarse-grained releases.

**Use Environment Tracking**
Register which versions are deployed to which environments in the Pact Broker:

```bash
# After deploying account-service to production:
pact-broker record-deployment \
  --pacticipant account-service \
  --version $GIT_SHA \
  --environment production
```

**Consumer selectors for realistic verification**
Verify against contracts that are deployed to production, not just the latest:

```java
@ConsumerVersionSelectors({
    @ConsumerVersionSelector(deployedOrReleased = true),  // currently in prod
    @ConsumerVersionSelector(branch = "main"),             // what will be deployed next
    @ConsumerVersionSelector(matchingBranch = true)        // feature branch pacts (WIP)
})
```

**Store Pact files in source control as a fallback**
For air-gapped environments or disaster recovery, commit generated pact JSON files to a `/contracts` directory in the provider repository. This provides an offline verification path when the Pact Broker is unavailable.

**Correlate Pact failures with OpenAPI changes**
In your provider's CI, diff the OpenAPI spec between HEAD and the last verified commit. If the spec changed and Pact verification fails, the OpenAPI change is the likely culprit — surface this in the failure output.

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
      "text": "A consumer Pact test asserts that the availableBalance field in the account balance response equals exactly 5000.00. What problem does this create and how should it be fixed?",
      "options": [
        "The exact value assertion is correct — contracts should be as specific as possible to prevent regressions.",
        "Using an exact value creates a brittle contract that breaks when the provider changes test data. It should use a type matcher (decimalType) instead, specifying only the shape of the field.",
        "Exact values are only problematic for string fields; numeric fields like BigDecimal are safe to assert exactly.",
        "The test should use a regex matcher instead of an exact value assertion for all numeric fields."
      ],
      "correct": 1,
      "explanation": "Contracts should specify the shape of a response (field type, format), not exact test data values. Using decimalType('availableBalance', new BigDecimal('100.00')) verifies the field exists and is a decimal, without coupling the contract to specific test data. Exact values break when the provider's test data changes, producing false contract failures unrelated to actual API compatibility."
    },
    {
      "text": "The Pact Broker's 'can-i-deploy' check returns a failure for the payment-service. What does this indicate and what action should the team take?",
      "options": [
        "The Pact Broker is unavailable and the team should proceed with deployment.",
        "The payment-service has a consumer contract that the provider (account-service) cannot satisfy in the target environment, meaning deploying now would break the integration.",
        "The payment-service has not published its pact file to the broker after the latest consumer test run.",
        "The provider verification results have not been published back to the Pact Broker, so the deployment status cannot be determined."
      ],
      "correct": 1,
      "explanation": "can-i-deploy queries the Pact Broker to determine whether deploying a specific version of a service would break any existing consumer-provider relationships. A failure means at least one consumer contract the service must satisfy is not verified for the current version — deploying would break a known integration. The team should investigate which interaction is failing before deploying."
    },
    {
      "text": "A provider @State method is missing for the state 'account ACC-001 has sufficient balance' that a consumer defined in its @Pact. What is the consequence?",
      "options": [
        "The Pact framework throws a ProviderStateNotFound exception and the verification test fails immediately.",
        "The provider verification runs against the system's default state (empty or minimal data), potentially passing when the actual implementation would fail — a false green result.",
        "The consumer test will fail because the mock server cannot find the matching provider state.",
        "The pact file is marked as pending in the Pact Broker until a provider state is implemented."
      ],
      "correct": 1,
      "explanation": "If a provider state is not implemented, verification runs against whatever data exists in the system by default. This can produce a false green result — the interaction passes against empty/default state, but the real endpoint would behave differently when the described state is actually set up. Missing provider states are one of the most common sources of incorrect contract test results."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Implement Consumer-Driven Contract Testing for a Payment Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 60,
  "tasks": [
    {"id": "1", "description": "Write a complete consumer Pact test for the payment-service calling account-service. Define three interactions: (a) fetching an active account using type matchers and regex matchers for the accountId and currency fields, (b) fetching an account balance using decimalType for availableBalance and ledgerBalance, and (c) handling a 404 for a non-existent account. All three must use appropriate matchers — no exact value assertions except for status enum values and error codes."},
    {"id": "2", "description": "Write the provider verification test for account-service using @Provider, @PactBroker, and @State annotations. Implement three provider state setup methods matching the consumer's given clauses. Configure MockMvc as the test target. Set up provider state teardown using StateChangeAction.TEARDOWN with a real database (via JdbcTemplate) rather than @MockBean, and verify the teardown correctly removes test data after each interaction."},
    {"id": "3", "description": "Write a GitHub Actions CI workflow for the payment-service that: (a) runs consumer contract tests and publishes pacts to the Pact Broker using the git SHA as the consumer version, (b) runs the can-i-deploy check against the production environment before the deploy step, and (c) records the deployment to the Pact Broker after a successful deploy. Configure a Pact Broker webhook that triggers account-service provider verification automatically whenever payment-service publishes a new pact."},
    {"id": "4", "description": "Write a Spectral ruleset (.spectral.yml) for the account-service OpenAPI spec that enforces: (a) all monetary amount fields must be string type to preserve decimal precision, (b) all required fields must have descriptions, and (c) all error response schemas must include errorCode and message fields. Write a test that loads a sample OpenAPI spec with two deliberate violations and verifies that Spectral reports exactly those two errors."}
  ]
}
-->
