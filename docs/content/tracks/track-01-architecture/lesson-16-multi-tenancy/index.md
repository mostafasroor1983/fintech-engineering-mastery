---
id: "track-01-lesson-16"
title: "Multi-Tenancy Architecture in FinTech Platforms"
track: "track-01"
track-name: "Advanced Software Architecture"
sequence: 16
slug: "multi-tenancy"
difficulty: "advanced"
estimated-minutes: 80
status: "published"
last-updated: "2026-11-08"
prerequisites: []
tags: ["multi-tenancy", "tenant-isolation", "data-partitioning", "SaaS", "row-level-security"]
java-versions: [17, 21]
topics: ["multi-tenancy", "row-level-security", "tenant-context", "data-isolation", "schema-design", "noisy-neighbour"]
components:
  mermaid: true
  prism: true
  katex: false
  code-tabs: true
  knowledge-check: true
  practical-challenge: true
references:
  - "Tod Golding, 'Building Multi-Tenant SaaS Architectures', O'Reilly, 2023"
  - "AWS Well-Architected Framework, 'SaaS Lens', 2024"
  - "PostgreSQL Documentation, 'Row Security Policies', version 16"
---

When a European payment infrastructure provider launched its SaaS platform in 2019, it initially gave every bank customer a dedicated database. Within two years, with 400 clients onboarded, the operational cost of managing 400 separate database clusters had consumed the entire platform margin. The re-architecture to a shared-database multi-tenant model — done correctly, with strong isolation guarantees — reduced infrastructure cost by 73% while maintaining strict data separation auditable under GDPR. This lesson covers the full spectrum of tenancy models and the engineering patterns needed to build them correctly.

## Learning Objectives

- Compare the three tenancy models — silo, pool, and bridge — and select the appropriate model based on isolation requirements, compliance constraints, and cost
- Implement row-level security in PostgreSQL to enforce tenant isolation at the database layer
- Build a `TenantContext` using thread-local storage with a Spring interceptor that propagates tenant identity through every layer
- Design a `TenantAwareDataSource` that routes connections to the correct database or schema per request
- Configure Hibernate's multi-tenancy support using `CurrentTenantIdentifierResolver` and `MultiTenantConnectionProvider`
- Automate tenant onboarding with schema provisioning and baseline data population
- Identify and mitigate noisy-neighbour effects in a shared-infrastructure tenancy model
- Map data isolation trade-offs to compliance requirements including GDPR data residency and PCI DSS zone separation

## Business Context

In 2023, a UK embedded finance platform experienced a data isolation breach in its multi-tenant environment. A missing `tenant_id` filter in a single JPQL query in the account history service caused one tenant's transaction history to be visible in another tenant's dashboard for approximately 90 minutes before automated anomaly detection raised an alert. The affected query had bypassed row-level security because it used a native SQL path that the RLS policy did not cover. The incident cost the platform its FCA authorisation for three months and triggered a mandatory audit of all 1,400 database queries. The lesson is not that multi-tenancy is dangerous — it is that tenant isolation must be enforced at the database layer, not only at the application layer.

## Tenancy Models

The three models represent points on the isolation-versus-cost spectrum. No single model is correct for all situations.

```mermaid
graph TD
    subgraph Silo["Silo Model — Full Isolation"]
        T1DB[(Tenant A\nDatabase)]
        T2DB[(Tenant B\nDatabase)]
        T3DB[(Tenant C\nDatabase)]
    end
    subgraph Bridge["Bridge Model — Schema per Tenant"]
        SHAREDDB[(Shared\nDatabase)]
        S1[Schema: tenant_a]
        S2[Schema: tenant_b]
        SHAREDDB --> S1
        SHAREDDB --> S2
    end
    subgraph Pool["Pool Model — Shared Tables"]
        POOLDB[(Shared\nDatabase)]
        ACCOUNTS[accounts\ntenant_id column]
        PAYMENTS[payments\ntenant_id column]
        POOLDB --> ACCOUNTS
        POOLDB --> PAYMENTS
    end
```

| Dimension | Silo | Bridge (Schema) | Pool (Shared Table) |
|---|---|---|---|
| **Isolation strength** | Maximum | High | Requires RLS |
| **Operational cost** | Very high | Moderate | Low |
| **Noisy neighbour risk** | None | Low | High without throttling |
| **Data residency** | Trivial | Per-database grouping | Complex |
| **Tenant onboarding** | Provision new cluster | Create schema + migrate | Insert configuration row |
| **Blast radius on breach** | One tenant | One schema | All tenants |
| **Recommended for** | Regulated banks, PCI Tier 1 | Mid-market SaaS | High-volume, homogeneous tenants |

## Row-Level Security in PostgreSQL

PostgreSQL's native RLS enforces tenant isolation at the storage layer. Even if application code has a bug that omits the `tenant_id` filter, RLS will apply the correct filter or block access entirely.

```sql
-- Enable RLS on the payments table
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;

-- Policy: each database session can only see rows for its tenant
CREATE POLICY tenant_isolation_policy ON payments
    USING (tenant_id = current_setting('app.current_tenant')::uuid);

-- Application sets the tenant before any query in the session.
-- Spring interceptor calls: SET LOCAL app.current_tenant = '<uuid>';

-- Verify: even without a WHERE clause, only current tenant rows returned
SELECT count(*) FROM payments;
-- Returns only rows where tenant_id = current_setting('app.current_tenant')

-- Administrative bypass for platform operations (superuser only)
CREATE POLICY admin_bypass ON payments
    USING (current_user = 'platform_admin');
```

> [!WARNING]
> `FORCE ROW LEVEL SECURITY` is essential. Without it, the table owner (typically the application database user) bypasses all policies. If your application connects as the table owner, RLS provides no protection.

## TenantContext and Spring Interceptor

The `TenantContext` thread-local is the single source of truth for tenant identity within a request. It must be set at the boundary (HTTP interceptor or message consumer), propagated through async calls, and always cleared after the request completes.

```java
// Thread-local tenant context
public final class TenantContext {

    private static final ThreadLocal<String> CURRENT_TENANT = new InheritableThreadLocal<>();

    private TenantContext() {}

    public static void setCurrentTenant(String tenantId) {
        if (tenantId == null || tenantId.isBlank()) {
            throw new IllegalArgumentException("tenantId must not be null or blank");
        }
        CURRENT_TENANT.set(tenantId);
    }

    public static String getCurrentTenant() {
        String tenantId = CURRENT_TENANT.get();
        if (tenantId == null) {
            throw new TenantContextMissingException(
                "No tenant context set — this is a programming error");
        }
        return tenantId;
    }

    public static void clear() {
        CURRENT_TENANT.remove();
    }
}

// Spring interceptor — sets tenant from JWT claim on every request
@Component
public class TenantResolutionInterceptor implements HandlerInterceptor {

    private static final String TENANT_CLAIM = "tenant_id";

    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response,
                             Object handler) throws Exception {
        String tenantId = extractTenantFromJwt(request);
        TenantContext.setCurrentTenant(tenantId);
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request,
                                HttpServletResponse response,
                                Object handler, Exception ex) {
        TenantContext.clear();  // Always clear — prevents context leakage across requests
    }

    private String extractTenantFromJwt(HttpServletRequest request) {
        String bearer = request.getHeader("Authorization");
        Jwt jwt = jwtDecoder.decode(bearer.substring(7));
        return jwt.getClaimAsString(TENANT_CLAIM);
    }
}
```

## TenantAwareDataSource Routing

In a bridge model (schema-per-tenant), the application uses a single JDBC URL but switches the active schema per request. `AbstractRoutingDataSource` from Spring provides the hook.

```java
// Routes to the correct datasource or schema based on current tenant
public class TenantAwareDataSource extends AbstractRoutingDataSource {

    @Override
    protected Object determineCurrentLookupKey() {
        return TenantContext.getCurrentTenant();
    }
}

@Configuration
public class MultiTenantDataSourceConfig {

    @Bean
    public DataSource dataSource(TenantDataSourceRegistry registry) {
        TenantAwareDataSource routingDataSource = new TenantAwareDataSource();
        routingDataSource.setTargetDataSources(registry.getDataSourceMap());
        routingDataSource.setDefaultTargetDataSource(registry.getDefaultDataSource());
        return routingDataSource;
    }
}

// For pool model: sets PostgreSQL session variable before each query
@Component
public class TenantSchemaConnectionDecorator implements ConnectionPreparer {

    @Override
    public void prepare(Connection connection) throws SQLException {
        String tenantId = TenantContext.getCurrentTenant();
        try (Statement stmt = connection.createStatement()) {
            stmt.execute("SET LOCAL app.current_tenant = '"
                + tenantId.replace("'", "''") + "'");
        }
    }
}
```

## Hibernate Multi-Tenancy Configuration

Hibernate provides first-class multi-tenancy support through `CurrentTenantIdentifierResolver` and `MultiTenantConnectionProvider`. This integrates the tenant-aware routing with the ORM layer.

```java
@Component
public class TenantIdentifierResolver implements CurrentTenantIdentifierResolver<String> {

    @Override
    public String resolveCurrentTenantIdentifier() {
        try {
            return TenantContext.getCurrentTenant();
        } catch (TenantContextMissingException e) {
            return "system";  // For platform-level operations only
        }
    }

    @Override
    public boolean validateExistingCurrentSessions() {
        return true;
    }
}

@Component
public class SchemaBasedMultiTenantConnectionProvider
        implements MultiTenantConnectionProvider<String> {

    private final DataSource dataSource;

    @Override
    public Connection getConnection(String tenantIdentifier) throws SQLException {
        Connection connection = dataSource.getConnection();
        // Switch schema for bridge model — sanitise to prevent injection
        connection.createStatement()
            .execute("SET search_path TO tenant_"
                + sanitize(tenantIdentifier) + ", public");
        return connection;
    }

    @Override
    public void releaseConnection(String tenantIdentifier, Connection connection)
            throws SQLException {
        // Reset to default schema before returning connection to pool
        connection.createStatement().execute("SET search_path TO public");
        connection.close();
    }

    private String sanitize(String tenantId) {
        return tenantId.replaceAll("[^a-zA-Z0-9_]", "");
    }
}

@Configuration
public class HibernateMultiTenancyConfig {

    @Bean
    public LocalContainerEntityManagerFactoryBean entityManagerFactory(
            DataSource dataSource,
            TenantIdentifierResolver tenantResolver,
            SchemaBasedMultiTenantConnectionProvider connectionProvider) {

        Map<String, Object> jpaProperties = new HashMap<>();
        jpaProperties.put(AvailableSettings.MULTI_TENANT_IDENTIFIER_RESOLVER, tenantResolver);
        jpaProperties.put(AvailableSettings.MULTI_TENANT_CONNECTION_PROVIDER, connectionProvider);
        jpaProperties.put(AvailableSettings.JAKARTA_HBM2DDL_AUTO, "validate");

        LocalContainerEntityManagerFactoryBean factory =
            new LocalContainerEntityManagerFactoryBean();
        factory.setDataSource(dataSource);
        factory.setJpaPropertyMap(jpaProperties);
        return factory;
    }
}
```

## Tenant Onboarding Automation

Tenant onboarding must be atomic, idempotent, and auditable. A partial onboarding that fails mid-way leaves the platform in an inconsistent state.

```java
@Service
@Transactional
public class TenantOnboardingService {

    private final TenantRepository tenantRepository;
    private final SchemaProvisioner schemaProvisioner;
    private final BaselineDataLoader baselineLoader;
    private final AuditLogService auditLog;

    public TenantOnboardingResult onboard(TenantOnboardingRequest request) {
        // Idempotency check — safe to retry
        if (tenantRepository.existsById(request.tenantId())) {
            return TenantOnboardingResult.alreadyExists(request.tenantId());
        }

        try {
            Tenant tenant = tenantRepository.save(Tenant.builder()
                .id(request.tenantId())
                .name(request.name())
                .tier(request.tier())
                .region(request.region())
                .status(TenantStatus.PROVISIONING)
                .build());

            schemaProvisioner.createSchema(request.tenantId());
            schemaProvisioner.runMigrations(request.tenantId());
            baselineLoader.load(request.tenantId(), request.tier());

            tenant.setStatus(TenantStatus.ACTIVE);
            tenantRepository.save(tenant);

            auditLog.record("TENANT_ONBOARDED", request.tenantId(), request.requestedBy());
            return TenantOnboardingResult.success(request.tenantId());

        } catch (Exception e) {
            schemaProvisioner.dropSchemaIfEmpty(request.tenantId());
            tenantRepository.deleteById(request.tenantId());
            throw new TenantOnboardingException(
                "Onboarding failed for " + request.tenantId(), e);
        }
    }
}
```

## Noisy-Neighbour Mitigation

In a pool model, one tenant executing heavy batch queries degrades performance for all others. Per-tenant connection-pool limits combined with PostgreSQL statement timeouts per role provide defence-in-depth.

```java
@Component
public class TenantAwareConnectionPoolManager {

    private final Map<String, HikariDataSource> tenantPools = new ConcurrentHashMap<>();

    public DataSource getPoolForTenant(String tenantId, TenantTier tier) {
        return tenantPools.computeIfAbsent(tenantId, id -> {
            HikariConfig config = new HikariConfig();
            config.setJdbcUrl(databaseUrl);
            // Tier-based caps: GOLD=20, SILVER=10, BRONZE=5 connections max
            config.setMaximumPoolSize(tier.maxConnections());
            config.setMinimumIdle(tier.minIdleConnections());
            config.setConnectionTimeout(tier.connectionTimeoutMs());
            config.addDataSourceProperty("ApplicationName",
                "fintech-platform-tenant-" + id);
            return new HikariDataSource(config);
        });
    }
}
```

```sql
-- PostgreSQL: statement timeouts by tier prevent runaway queries
ALTER ROLE tenant_bronze SET statement_timeout = '5000ms';
ALTER ROLE tenant_silver SET statement_timeout = '15000ms';
ALTER ROLE tenant_gold   SET statement_timeout = '60000ms';

-- Monitor connection consumption per tenant for noisy-neighbour detection
SELECT application_name AS tenant, count(*) AS connections,
       round(100.0 * count(*) /
           (SELECT setting::int FROM pg_settings WHERE name = 'max_connections'), 1) AS pct
FROM pg_stat_activity
WHERE application_name LIKE 'fintech-platform-tenant-%'
GROUP BY application_name
ORDER BY connections DESC;
```

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "id": "q1",
      "text": "Your fintech SaaS platform has a Tier-1 bank as a tenant. The bank requires that its data never co-exists in the same database instance as other tenants due to its internal data governance policy. Which tenancy model must you offer this tenant?",
      "options": [
        "Pool model with row-level security — RLS provides sufficient isolation",
        "Bridge model with schema-per-tenant in a shared database cluster",
        "Silo model with a dedicated database instance for this tenant",
        "Pool model with tenant_id column and application-layer filtering"
      ],
      "correct": 2,
      "explanation": "The silo model is the only option that satisfies 'data never co-exists in the same database instance as other tenants.' RLS and schema isolation both share the underlying database cluster. For regulated banks with strict data governance policies, the silo model is required. This comes at significant operational cost and should be reflected in the tenant's pricing tier."
    },
    {
      "id": "q2",
      "text": "In a pool-model multi-tenant system, an engineer forgets to add a WHERE tenant_id = ? clause to a native SQL query. What is the most effective defence that prevents data leaking to the wrong tenant?",
      "options": [
        "Code review — a second engineer will catch the missing WHERE clause",
        "Integration tests with multi-tenant test fixtures",
        "PostgreSQL row-level security with FORCE ROW LEVEL SECURITY enabled and the session variable set by the interceptor",
        "Application-level assertions that validate result sets before returning them"
      ],
      "correct": 2,
      "explanation": "Database-layer enforcement via RLS with FORCE ROW LEVEL SECURITY is the only defence that works even when application code has bugs. Code review and tests are valuable but not exhaustive — they can miss edge cases. Application-layer assertions are too late — the data was already read. RLS with FORCE ROW LEVEL SECURITY ensures even the table owner cannot bypass the policy, making tenant isolation a database guarantee rather than an application convention."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
## Practical Challenge

**Scenario:** You are building a multi-tenant payment processing platform. Your first three tenants are: a Tier-1 bank (requires silo isolation, GDPR data residency in EU), a mid-market lender (schema isolation sufficient), and a fintech startup (cost-sensitive, pool model acceptable).

**Task 1 — Tenancy Model Selection**
Write an ADR for the tenancy model. How do you support all three tenants from a single platform without maintaining three entirely separate codebases? Define the tiering model that maps tenant requirements to isolation level.

**Task 2 — RLS Implementation**
Implement the full PostgreSQL RLS setup for the pool-model tenant. Include the policy, the session variable setting mechanism, and a test that proves RLS blocks cross-tenant reads even when the WHERE clause is omitted.

**Task 3 — TenantContext Propagation in Async Code**
When a payment event triggers an async Kafka consumer, `TenantContext` (a ThreadLocal) is not automatically propagated to the consumer thread. Design and implement a solution that correctly propagates tenant identity into async processing without leaking context between messages.

**Task 4 — Noisy-Neighbour Incident Response**
Your monitoring shows that the fintech startup tenant is running a nightly batch job consuming 80% of database connections, causing timeouts for other tenants. Design and implement the connection pool enforcement that prevents this, and define the SLA breach thresholds and alerting.
-->
