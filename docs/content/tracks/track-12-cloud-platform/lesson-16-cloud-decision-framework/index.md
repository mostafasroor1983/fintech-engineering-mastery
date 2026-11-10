---
id: track-12-lesson-16
title: "Principal Engineer's Cloud Architecture Decision Framework"
slug: cloud-decision-framework
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 16
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, cloud, trade-offs, staff-engineer, platform]
prerequisites: []
---

# Principal Engineer's Cloud Architecture Decision Framework

> [!NOTE]
> The most dangerous phrase in cloud architecture is "we'll use the managed service because it's simpler." Sometimes this is correct. Sometimes it trades one set of problems for another that is harder to debug at 3am, more expensive at scale, or introduces a compliance gap that only surfaces during an audit. A principal engineer's value is in making these trade-offs visible and deliberate — not defaulting to the latest AWS announcement or the previous company's stack.

## The Decision Framework

A principled architecture decision requires explicit evaluation across five dimensions:

```
Dimensions of a cloud architecture decision:

  1. Operational cost
     Who operates it? What skills are required?
     What is the blast radius of misconfiguration?

  2. Financial cost
     Current cost at current scale?
     Projected cost at 10x scale?
     Is cost proportional to value?

  3. Performance and reliability
     What is the SLA of the managed service?
     Can you meet your RTO/RPO with this choice?
     What is the failure mode and how do you recover?

  4. Compliance and security
     Does this satisfy PCI-DSS, SOX, GDPR requirements?
     Who controls the encryption keys?
     What audit trail exists?

  5. Strategic flexibility
     Vendor lock-in risk (can you migrate in 12 months if needed)?
     Skill availability in the job market?
     Open source vs proprietary: what happens if the vendor changes pricing?
```

---

## Decision 1: Managed Service vs Self-Hosted Database

The most consequential decision for most fintech platforms.

### RDS vs Self-Managed PostgreSQL on Kubernetes

```
OPTION A: AWS RDS PostgreSQL (managed)

  Operational simplicity:
    + Automated backups, point-in-time recovery
    + Automated minor version patching
    + Multi-AZ failover in 60-120 seconds
    + Read replica creation via console
    + Performance Insights for query monitoring
    - Limited visibility into PostgreSQL internals
    - Cannot install custom extensions (unless Aurora compatible)
    - Maintenance windows: AWS may restart during scheduled maintenance

  Financial cost (us-east-1, db.r6g.4xlarge, Multi-AZ, 1TB gp3):
    Instance:  $1,643/month (On-Demand)
    Storage:   $230/month (1TB gp3 @ $0.23/GB-month)
    Backups:   $115/month (1TB @ $0.095/GB)
    Total:     ~$2,000/month
    1yr RI:    ~$1,400/month (-30%)

  Performance ceiling:
    db.r6g.8xlarge: 32 vCPU, 256GB RAM
    Max IOPS: 80,000 (io2)
    Read replicas: up to 15

  Compliance:
    + AWS encrypts at rest (KMS CMK supported)
    + AWS CloudTrail logs all API calls to RDS
    + Can restrict to VPC (no public endpoint)
    - AWS has access to data for maintenance (BAA required for HIPAA/PCI)
    - Shared responsibility model: you own data, AWS owns infrastructure

  Failure mode:
    Multi-AZ: automatic failover to standby (60-120s)
    Region failure: restore from automated cross-region backup (hours)
    Accidental DELETE: point-in-time restore (minutes to hours depending on table size)

OPTION B: PostgreSQL on Kubernetes (self-managed with Patroni or CloudNativePG)

  Operational complexity:
    - You manage everything: upgrades, backups, failover, monitoring
    - Requires deep PostgreSQL expertise on the team
    - On-call must understand Patroni leader election and failover
    + Full control over PostgreSQL configuration
    + Can install any extension (pg_partman, timescaledb, pgvector)
    + Can tune to your exact workload
    + No maintenance windows imposed by AWS

  Financial cost (EKS, 3x c6i.4xlarge nodes dedicated to PG, 500GB EBS io2):
    Compute: 3 * $0.68/hr * 730hr = $1,490/month
    Storage: 3 * 500GB * $0.125/GB (io2) = $188/month
    Snapshots: ~$50/month
    Total: ~$1,730/month
    Savings vs RDS: ~$270/month (not compelling)

  Performance ceiling:
    Limited by instance type selected (can use c6i.metal: 128 vCPU)
    Custom storage configuration: local NVMe via local-path provisioner

  Failure mode:
    Patroni leader election: 15-30 seconds (faster than RDS Multi-AZ)
    But: you must configure and test this correctly
    If Patroni misconfigured: potential split-brain = data corruption

RECOMMENDATION for typical fintech:
  Start with RDS. The cost difference is small; the operational simplicity
  is significant. Self-manage only if:
    - You need extensions RDS does not support
    - Your workload exceeds RDS maximum instance size
    - Cost at scale makes RDS uneconomical (> 10TB, > db.r6g.16xlarge)
    - You have deep PostgreSQL expertise on the team

Decision record format:
  Title: Payment Database: RDS vs Self-Managed PostgreSQL
  Status: ACCEPTED
  Date: 2026-11-08
  Decision: Use RDS PostgreSQL Multi-AZ
  Rationale: Lower operational risk, adequate performance for current scale,
             cost difference < $400/month, team lacks Patroni expertise.
  Trade-off: Accept RDS limitations (extension restrictions, maintenance windows).
  Review trigger: If monthly cost exceeds $5,000 or we need PostGIS/pg_partman.
```

---

## Decision 2: Multi-Cloud vs Single Cloud

```
OPTION A: Single cloud (AWS)

  Operational simplicity:
    + One IAM model, one billing, one support relationship
    + Deep integration between services (EKS + RDS + SQS + KMS)
    + Staff expertise concentrates on one platform
    + Better AWS support tiers available
    - Full dependency on AWS availability

  Lock-in risk:
    Real: EKS-specific features (IRSA, EKS add-ons), Aurora, SQS, KMS
    Manageable: Kubernetes portability exists but is not free
    Mitigated by: using open standards where possible (PostgreSQL vs Aurora,
                  Kafka vs SQS, Vault vs KMS where compliance allows)

  Reliability:
    AWS us-east-1 had 7 notable incidents in 2022
    Mitigated by multi-AZ (protects from single-AZ failure)
    Multi-region (protects from region failure, but adds complexity)

OPTION B: Multi-cloud (AWS primary + GCP secondary)

  Complexity:
    - Two IAM models (AWS IAM + GCP IAM)
    - Two Kubernetes distributions (EKS + GKE)
    - Engineers must understand both platforms
    - Networking between clouds (VPN or private interconnect: expensive)
    - Data transfer costs between clouds: $0.08-0.09/GB

  When it makes sense:
    + Regulatory requirement: some countries require data not to be in one provider
    + Specific GCP/Azure service you cannot replace on AWS
    + Negotiating leverage (real or theoretical)
    + M&A: acquired company on GCP, integration period

  When it does NOT make sense:
    - "Avoiding vendor lock-in" without a specific threat model
    - Running the same workload on two clouds for HA (multi-region on one cloud is simpler)
    - Cost — multi-cloud increases cost and complexity significantly

RECOMMENDATION:
  Single cloud (AWS) for most fintech.
  Multi-region for HA and DR (AWS us-east-1 + us-west-2).
  Add a second cloud only if regulatory requirement or strategic M&A.
  "Multi-cloud for resilience" is not a sufficient reason — it increases operational
  complexity more than it increases resilience for most organizations.
```

---

## Decision 3: Service Mesh Adoption

```
OPTION A: No service mesh

  When appropriate:
    + Small platform (< 20 services)
    + Team does not have Kubernetes networking expertise
    + mTLS not required by compliance
    + Service-to-service latency budget is tight (service mesh adds 1-5ms)

  What you lose:
    - mTLS (mutual TLS) between services — must implement in application layer
    - Distributed tracing without code instrumentation
    - Traffic management (canary, A/B testing) requires Argo Rollouts or similar
    - Uniform observability layer

OPTION B: Istio (or Linkerd)

  When appropriate:
    + Large platform (> 20 services, many cross-service calls)
    + PCI-DSS requires encryption in transit between all cardholder data services
    + Distributed tracing needed without application-level instrumentation
    + Fine-grained traffic control (canary with header-based routing)

  Real costs:
    - Each sidecar proxy: 50-100MB memory, 50-100m CPU
    - 100 pods × 75MB = 7.5GB memory overhead for Istio proxies
    - At $0.004/GB-hr on EC2: $218/month just for sidecar memory
    - Added latency: 1-5ms per hop (acceptable for most payment flows)
    - Operational complexity: Istio has a learning curve and failure modes

  mTLS value for PCI-DSS:
    PCI-DSS Requirement 4.2.1: transmit cardholder data over strong cryptography
    Istio mTLS satisfies this for pod-to-pod communication
    Without Istio: application code must implement TLS for every service call
    With Istio: mTLS is automatic and enforced by policy

RECOMMENDATION:
  Add Istio when:
    1. PCI-DSS mTLS requirement makes application-level TLS mandatory AND
       you want to centralize this vs each service team managing certs
    2. Platform has > 30 services and observability gap is real
    3. Traffic management complexity justifies the overhead

  Start without Istio. Add it in year 2 when complexity justifies it.
  Linkerd is a simpler alternative if mTLS is the primary driver.
```

---

## Decision 4: Platform Engineering Investment ROI

```
Investment cost:
  3 platform engineers × $200K/year = $600K/year
  Backstage deployment and maintenance: $50K/year (infra + tooling)
  Total annual investment: ~$650K

Value delivered:
  Assumption: 20 product engineers at $200K/year = $4M/year in productivity
  Current: 15% of time spent on infrastructure/deployment tasks = $600K/year "wasted"
  After IDP: reduce to 5% = $200K/year
  Annual savings: $400K/year in engineering productivity

  Additional benefits:
    - Deployment frequency: 1/week → 1/day per service
    - Lead time: 2 days → 4 hours
    - Security vulnerabilities caught automatically (SAST in every pipeline)
    - Compliance audit time: 2 weeks → 2 days (automated evidence collection)
    - Onboarding time for new engineers: 4 weeks → 1 week

ROI calculation:
  First-year savings: $400K productivity + $200K audit + $100K onboarding = $700K
  Investment: $650K
  First-year ROI: 7.7%

  Second year (investment paid down, full utilization):
    Annual savings: $700K
    Annual cost: $650K (staff is permanent)
    Net positive from year 2 onward

This is a marginal ROI — but that understates it because:
  - Developer satisfaction: hard to quantify, crucial for retention
  - Risk reduction: standardized security controls reduce breach risk
  - Regulatory: compliance automation prevents fines (PCI-DSS non-compliance: up to $100K/month)

The correct framing: platform engineering is not a cost center, it is leverage.
```

---

## Decision 5: Cloud Cost Governance Model

```
Governance model options:

OPTION A: Centralized control
  Central platform team sets budgets and reviews all resource requests.
  Engineers must justify new resources via ticket.
  
  Trade-offs:
    + Strong cost control
    - Bottleneck: platform team is a gate for every change
    - Slows engineering velocity
    - Incentive mismatch: platform team is not measured on product delivery

OPTION B: Federated accountability
  Each team has a monthly cloud budget.
  Teams can provision whatever they need within their budget.
  Budget alerts notify the team at 80% threshold.
  Monthly FinOps review: teams present their cost trends.
  
  Trade-offs:
    + Engineering velocity preserved
    + Teams are accountable for their own costs
    - Requires teams to understand cloud costs
    - Budget overruns still possible in first months

OPTION C: Policy-based guardrails with federated budgets
  OPA policies prevent clearly wasteful resource creation
  (e.g., cannot create instances > 32xlarge without architecture review).
  Kubecost provides real-time cost visibility per team.
  Chargeback: costs flow back to team's cost center automatically.
  Federated budgets: each team manages within their allocation.
  
  RECOMMENDATION: This is the right model for fintech.

Regulated services additional requirement:
  SOX: change management approval for production infrastructure changes
  PCI-DSS: access to cardholder data environment (CDE) must be logged and justified
  Fintech governance cannot be purely self-service: some resources require review
  
  Practical implementation:
    - Self-service within approved service catalog (Crossplane compositions)
    - Architecture review required for: multi-TB databases, > 32xlarge instances,
      new cloud services not in the approved list, cross-region data flow
    - Compliance scanning automated: OPA, AWS Config, Security Hub
```

---

## Decision 6: Vendor Lock-In Risk Management

```
Spectrum of lock-in:

LOW LOCK-IN:
  Kubernetes (CNCF standard)      → migrate between EKS/GKE/AKS
  PostgreSQL                       → run on RDS, Aurora, Cloud SQL, or self-managed
  Kafka (Apache)                   → run on Confluent, MSK, or self-managed
  Terraform (HCL)                  → multi-cloud (but AWS-specific resources still exist)
  GitHub Actions                   → migrate to Tekton/GitLab CI with effort
  Prometheus + Grafana             → runs anywhere

HIGH LOCK-IN:
  Aurora (AWS proprietary)        → cannot migrate to self-managed PostgreSQL easily
  SQS/SNS                         → migrate to Kafka/RabbitMQ requires code changes
  AWS Lambda                      → significant refactor to migrate to K8s
  AWS KMS for application-level   → key material cannot be exported (intentionally)
  DynamoDB                        → migrate to Cassandra/MongoDB requires redesign

STRATEGY for fintech:
  Accept lock-in for: commodity infrastructure (compute, networking, load balancers)
    These are table stakes; migrating them is mechanical.
    
  Minimize lock-in for: data tier and messaging
    Your payment ledger data outlives any cloud vendor relationship.
    Use PostgreSQL, not Aurora-specific features.
    Use Kafka (MSK is fine), not SQS/SNS.
    
  Document lock-in explicitly:
    Every architecture decision that creates lock-in should have:
    - Explicit acknowledgment of the lock-in
    - Estimated migration cost if the relationship needs to end
    - Trigger condition for revisiting the decision

  Example:
    Decision: Use AWS KMS for payment data encryption
    Lock-in: HIGH — key material cannot be exported from KMS
    Migration cost: re-encrypt all data with new keys under new provider (~$200K + 6 months)
    Trigger: AWS changes KMS pricing by > 2x, or regulatory requirement for key custody
    Mitigation: use Envelope Encryption — data keys are ours, KMS only wraps them
```

---

## The Architecture Decision Record (ADR)

Every significant architecture decision should be documented as an ADR. This prevents decision amnesia and provides context for future engineers.

```markdown
# ADR-042: Payment Database Technology Selection

## Status
ACCEPTED — 2026-11-08

## Context
Payment ledger database selection for payment-processing platform.
Current scale: 500K transactions/day, peak: 50K transactions/hour.
Projected: 5M transactions/day in 24 months.

Candidates evaluated:
  1. AWS RDS PostgreSQL Multi-AZ
  2. Amazon Aurora PostgreSQL
  3. Self-managed PostgreSQL on EKS (CloudNativePG)
  4. CockroachDB (distributed SQL)

## Decision
Use AWS RDS PostgreSQL Multi-AZ, db.r6g.4xlarge (initial), with 1-year Reserved Instance.

## Rationale
  1. Team expertise: 3 engineers with deep PostgreSQL experience, none with CockroachDB.
  2. Aurora rejected: proprietary replication, 3x cost for current scale, lock-in risk.
  3. Self-managed rejected: team does not have Patroni/CloudNativePG operational experience.
     Risk of misconfigured failover causing data loss outweighs cost savings of $270/month.
  4. CockroachDB rejected: PostgreSQL-compatible but behavioral differences in edge cases.
     Financial data correctness is paramount; introducing behavioral uncertainty is unacceptable.
  5. RDS cost: $2,000/month On-Demand, $1,400/month with 1-year RI.
     Acceptable for current scale.

## Trade-offs Accepted
  - Cannot use pg_partman (partition management extension) — must use native partitioning.
  - Maintenance windows: AWS may restart instance; Patroni self-managed would be faster.
  - Cost at 10x scale: may need to revisit (Aurora or self-managed may be more economical).

## Consequences
  - All payment data is in a single AWS region (us-east-1) with Multi-AZ standby.
  - DR requires cross-region restore from automated backup (RTO: 2-4 hours).
  - Engineering team must NOT use Aurora-specific features to maintain RDS portability.

## Review Triggers
  - Monthly cost exceeds $6,000 (re-evaluate Aurora vs self-managed)
  - Need for partition management automation beyond native PostgreSQL
  - Projected scale exceeds db.r6g.16xlarge capacity (256 vCPU, 512GB RAM)
  - Team hires PostgreSQL DBA with Patroni experience (re-evaluate self-managed)

## Alternatives Remaining Open
  Read replicas: add RDS read replicas before moving to self-managed.
  Aurora: reconsider if 10x scale makes Aurora Serverless v2 cost-competitive.
```

---

## Checklist: Architecture Decision Quality

A good architecture decision for a financial platform answers all of these questions:

```
Correctness:
  [ ] Does this satisfy the stated requirement completely?
  [ ] Are all edge cases (failure modes, scale limits) considered?
  [ ] Is the failure mode understood and acceptable?

Compliance:
  [ ] Does this satisfy PCI-DSS requirements (if cardholder data involved)?
  [ ] Is encryption at rest and in transit handled?
  [ ] Is the audit trail sufficient for SOX/SOC 2?
  [ ] Is data residency compliant with GDPR if EU customer data involved?

Cost:
  [ ] What is the current monthly cost?
  [ ] What is the projected cost at 10x scale?
  [ ] Is there a cost optimization path (RI, Spot, right-sizing)?

Operational:
  [ ] Does the team have the skills to operate this?
  [ ] What does the on-call runbook look like?
  [ ] What is the blast radius of misconfiguration?
  [ ] Is the failure mode detectable by monitoring?

Strategic:
  [ ] Is the lock-in risk understood and explicitly accepted?
  [ ] What is the migration path if this decision needs to be reversed?
  [ ] Is the vendor's service reliability track record acceptable?
  [ ] Does this align with the company's long-term cloud strategy?

Documentation:
  [ ] Is this captured as an ADR with rationale and trade-offs?
  [ ] Are review triggers defined?
  [ ] Are affected teams aware of this decision?
```

---

## Key Takeaways for Principal Engineers

1. **Default to managed services, but document the trade-offs explicitly** — RDS is usually the right choice over self-managed PostgreSQL, but the decision should be explicit with stated trade-offs. "We chose RDS because it was easier" is not an architecture decision; it is an avoidance of thinking.

2. **Multi-cloud is not a resilience strategy** — multi-region on a single cloud provides better resilience with less complexity than multi-cloud for most payment platforms. Add a second cloud only when you have a specific, justified reason.

3. **Vendor lock-in is acceptable for compute and networking, dangerous for data and messaging** — your AWS load balancers are replaceable. Your Aurora-specific replication topology is not. Draw the lock-in line at the data tier.

4. **Service mesh is an operational investment, not a free upgrade** — Istio adds real memory overhead, real complexity, and real failure modes. For PCI-DSS mTLS requirements, it is often worth it. For general observability, Prometheus + distributed tracing can get you most of the way there at lower cost.

5. **Platform engineering ROI is measured in engineering hours, not infrastructure dollars** — the platform team's value shows up in deployment frequency, lead time, and security incident rate — not in direct infrastructure cost savings. Use DORA metrics as your ROI framework.

6. **Architecture decisions must be revisited on trigger, not schedule** — write down the conditions under which you would reconsider each decision. When those conditions are met (cost threshold, scale limit, regulatory change), the decision is automatically on the agenda. This prevents both premature optimization and zombie decisions that should have been revisited years ago.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A fintech startup chooses self-managed PostgreSQL on EC2 over Amazon RDS Aurora because they want full control over PostgreSQL configuration. 18 months later the team has spent 400 engineering hours on: storage scaling incidents, replica lag debugging, manual failover procedures, and PostgreSQL version upgrades. What would a principal engineer have recommended initially and why?",
      "options": ["Self-managed PostgreSQL was the correct choice; the team simply needs better operational tooling", "RDS Aurora PostgreSQL was likely the better starting choice: it handles automated failover in <30 seconds, storage auto-scaling to 128TB, automated minor version upgrades, and multi-AZ replication — the 400 hours of operational work largely disappears, and the cost of RDS vs EC2+operations is typically lower when engineering time is factored in", "The team should have used Google Cloud SQL instead of AWS RDS for better PostgreSQL compatibility", "The correct recommendation was CockroachDB which eliminates all operational overhead for PostgreSQL clusters"],
      "correct": 1,
      "explanation": "The principal engineer's default-to-managed-services principle applies here. Self-managed databases require the team to become expert in PostgreSQL operations — replication, failover, backup, monitoring, upgrades — in addition to their core product work. For most fintech startups, this operational investment is not a differentiator. RDS Aurora's automated failover, storage management, and backup eliminate the most common operational incidents. The specific configuration parameters that motivated choosing self-managed (e.g., max_connections, shared_buffers) can typically be set via RDS parameter groups."
    },
    {
      "text": "A payment platform uses AWS exclusively. The CTO proposes a multi-cloud strategy with Azure as a secondary cloud for resilience. A principal engineer evaluates this proposal. What is the most important question to answer before committing to multi-cloud?",
      "options": ["Which Azure region has the lowest latency to the existing AWS region", "Whether the resilience goal (surviving a full AWS regional outage) is better served by multi-region on AWS versus multi-cloud, given that multi-cloud doubles operational complexity, requires cloud-agnostic tooling, and rarely provides better actual availability than a well-designed multi-region AWS architecture", "Whether Azure supports all the AWS services the platform currently uses", "Whether the team has Azure certifications to operate the second cloud"],
      "correct": 1,
      "explanation": "Multi-cloud is frequently proposed as a resilience strategy but rarely delivers better availability than multi-region on a single cloud. AWS has never had a simultaneous failure across all regions — their blast radius is typically a single availability zone. Multi-region AWS (us-east-1 + us-west-2 active-passive) provides excellent resilience with one operational complexity budget. Multi-cloud requires maintaining expertise in two cloud platforms, cloud-agnostic abstractions (losing access to native services), and cross-cloud networking (high latency and cost). The principal engineer must quantify the resilience gap multi-cloud fills versus the operational cost it adds."
    },
    {
      "text": "A payment platform evaluates adopting Istio service mesh. The evaluation criteria include: PCI-DSS mTLS requirements between all payment services, existing observability coverage (Prometheus + Jaeger already deployed), and team Kubernetes expertise (intermediate). What is the principal engineer's recommendation?",
      "options": ["Adopt Istio immediately; mTLS is a PCI-DSS requirement and Istio is the industry standard", "Adopt Istio for the PCI-DSS mTLS requirement since the alternative (application-layer mTLS with certificate management per service) is more complex; acknowledge the memory overhead (50-100MB per sidecar) and invest in team training before production rollout", "Reject Istio; use Kubernetes NetworkPolicy for PCI-DSS compliance instead of a service mesh", "Delay the decision until the team has senior Istio expertise; run with application-layer TLS in the interim"],
      "correct": 1,
      "explanation": "The PCI-DSS mTLS requirement is a concrete, justified reason for service mesh adoption. Without Istio, achieving mTLS between all services requires each service to implement certificate management, rotation, and mutual authentication — a significant per-service burden. Istio provides this transparently via the sidecar. The evaluation correctly identifies the trade-offs: sidecar memory overhead (plan for it in resource budgets), operational complexity (invest in training), and the fact that Prometheus + Jaeger are already deployed (Istio's observability value is partially redundant but not harmful). This is a justified adoption, not premature optimization."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Build a Cloud Architecture Decision Framework and ADR System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Write a formal Architecture Decision Record (ADR) evaluating RDS Aurora PostgreSQL vs self-managed PostgreSQL on EKS for a payment platform processing 20K TPS. The ADR must include: Context (current state, drivers, constraints), Decision (chosen option with explicit reasoning), Consequences (positive and negative, including 5-year TCO estimate for each option factoring engineering hours), and Review Triggers (specific metrics like TPS ceiling, operational incident rate, or cost threshold that would prompt revisiting). The ADR must be in a format that satisfies SOC 2 audit documentation requirements."
    },
    {
      "id": "2",
      "description": "Implement a CloudDecisionMatrix class that evaluates a proposed architecture change across 5 dimensions: (1) operational_cost: score 1-5 based on FTE hours required per month, (2) financial_cost: score based on 3-year TCO estimate, (3) performance_reliability: score based on documented SLA and failover time, (4) compliance_security: score based on PCI-DSS and SOC 2 control coverage, (5) strategic_flexibility: score based on vendor lock-in level (1=fully locked, 5=fully portable). Input two architecture options; output a weighted score for each dimension with an overall recommendation. Write tests for the RDS vs self-managed PostgreSQL scenario."
    },
    {
      "id": "3",
      "description": "Create an ArchitectureDecisionRegistry Spring service that stores ADRs in PostgreSQL with status lifecycle (Proposed, Accepted, Superseded, Deprecated). Implement: (a) a ReviewTrigger system where each ADR has associated metrics thresholds (e.g., cost_per_1000_tx > $0.50, tps_ceiling_hit = true); (b) a scheduled job that evaluates all active ADR triggers against current Prometheus metrics daily; (c) automatic Slack notification when a trigger is met, including the ADR title, the metric that triggered review, and a link to the ADR. Write a test verifying the notification is sent when a threshold is breached."
    },
    {
      "id": "4",
      "description": "Design and document a vendor lock-in risk assessment for the current payment platform stack. Categorise each technology by lock-in level (Low/Medium/High) and portability effort (days/weeks/months): EKS, RDS Aurora, SQS, S3, CloudFront, Datadog, PagerDuty, GitHub Actions. For each High lock-in component, define: (a) the specific AWS API or feature causing lock-in, (b) the portable alternative (e.g., SQS -> Kafka), (c) the migration effort estimate, and (d) the business trigger that would justify migration. Implement a LockInRiskScore calculator that produces an overall vendor dependency score for the platform."
    }
  ]
}
-->
