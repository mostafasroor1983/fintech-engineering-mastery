---
id: track-10-lesson-16
title: "إطار المهندس الرئيسي لقرارات البنية السحابية"
slug: cloud-decision-framework
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 16
difficulty: principal
estimatedMinutes: 65
status: published
tags: [decision-framework, cloud, trade-offs, staff-engineer, platform]
prerequisites: []
---

# إطار قرارات البنية السحابية للمهندس الرئيسي

> [!NOTE]
> أخطر عبارة في البنية السحابية هي "سنستخدم الخدمة المُدارة لأنها أبسط". أحيانًا يكون هذا صحيحًا. وأحيانًا يستبدل مجموعة مشكلات بأخرى أصعب تصحيحًا في الثالثة فجرًا، أو أغلى عند التوسع، أو يُدخل فجوة امتثال لا تظهر إلا أثناء تدقيق. وقيمة المهندس الرئيسي في جعل هذه المفاضلات مرئية ومقصودة — لا في الانسياق وراء أحدث إعلان من AWS أو تقنيات الشركة السابقة.

## إطار القرار

يتطلب قرار بنية مبدئي تقييمًا صريحًا عبر خمسة أبعاد:

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

## القرار 1: خدمة مُدارة مقابل قاعدة بيانات مستضافة ذاتيًا

القرار الأكثر أثرًا لمعظم منصات التقنية المالية.

### ‏RDS مقابل PostgreSQL مُدار ذاتيًا على Kubernetes

```
OPTION A: AWS RDS PostgreSQL (managed)

  Operational simplicity:
    + Automated backups, point-in-time recovery
    + Automated minor version patching
    + Multi-AZ failover in 60-120 seconds
    + Read replica creation via console
    + Performance Insights for query monitoring
    - Limited visibility into PostgreSQL internals (no superuser, no OS access)
    - Only extensions on the RDS supported list (it includes PostGIS,
      pgvector, pg_partman, pg_cron; not e.g. TimescaleDB or your own C
      extensions -- Trusted Language Extensions cover some cases)
    - Maintenance windows: AWS may restart during scheduled maintenance

  Financial cost (us-east-1, db.r6g.4xlarge, Multi-AZ, 1TB gp3) --
  rough list prices; check the AWS pricing calculator:
    Instance:  ~$2,400/month (On-Demand; Multi-AZ doubles the instance price)
    Storage:   ~$230/month (1TB gp3, Multi-AZ @ ~$0.23/GB-month)
    Backups:   included up to the database size; extra retention billed
    Total:     ~$2,600/month
    1yr RI:    ~$1,800/month (about -30%)

  Performance ceiling:
    Largest instances: e.g. db.r7i.48xlarge (192 vCPU, 1.5 TiB RAM)
    io2 Block Express storage: up to 256,000 IOPS
    Read replicas: up to 15

  Compliance:
    + AWS encrypts at rest (KMS CMK supported)
    + AWS CloudTrail logs all API calls to RDS
    + Can restrict to VPC (no public endpoint)
    + AWS is a PCI-DSS Level 1 service provider (Attestation of Compliance
      available in AWS Artifact); a BAA is the HIPAA equivalent
    - Shared responsibility model: you own data, access control and
      configuration; AWS owns the underlying infrastructure

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
    + Can install any extension (TimescaleDB, custom C extensions, ...)
    + Can tune to your exact workload
    + No maintenance windows imposed by AWS

  Financial cost (EKS, 3x c6i.4xlarge nodes dedicated to PG, 500GB EBS io2):
    Compute: 3 * $0.68/hr * 730hr = $1,490/month
    Storage: 3 * 500GB * $0.125/GB (io2) = $188/month (+ provisioned IOPS)
    Snapshots: ~$50/month
    Total: ~$1,730/month + IOPS
    Savings vs RDS: ~$900/month -- far less than the cost of the engineering
    time needed to run it safely (not compelling)

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
    - Cost at scale makes RDS uneconomical (many TB, the largest instances)
    - You have deep PostgreSQL expertise on the team

Decision record format:
  Title: Payment Database: RDS vs Self-Managed PostgreSQL
  Status: ACCEPTED
  Date: 2026-11-08
  Decision: Use RDS PostgreSQL Multi-AZ
  Rationale: Lower operational risk, adequate performance for current scale,
             cost difference ~$900/month, team lacks Patroni expertise.
  Trade-off: Accept RDS limitations (extension list, maintenance windows).
  Review trigger: If monthly cost exceeds $5,000 or we need an extension
                  RDS does not offer (e.g. TimescaleDB).
```

---

## القرار 2: سحب متعددة مقابل سحابة واحدة

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
    Regions do fail as a whole now and then -- us-east-1 had high-profile
    regional outages (e.g. December 2021, October 2025) that also hit
    "global" services hosted there
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

## القرار 3: اعتماد شبكة الخدمات

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
    - At ~$0.004/GB-hr on EC2: 7.5 × 0.004 × 730 ≈ $22/month for the memory
      (plus the sidecars' CPU) -- the infrastructure bill is small
    - Added latency: typically ~1ms or less per hop with sidecars
      (ambient mode lowers both overhead and latency)
    - Operational complexity: Istio has a learning curve and failure modes --
      this, not the bill, is the real cost

  mTLS value for PCI-DSS:
    PCI-DSS 4.2.1 requires strong cryptography for cardholder data on OPEN,
    PUBLIC networks; many companies' security standards (and QSAs, for
    segmentation) also require encryption inside the CDE
    Istio mTLS meets that internal-encryption requirement pod-to-pod
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

## القرار 4: العائد على الاستثمار في هندسة المنصات

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

## القرار 5: نموذج حوكمة التكلفة السحابية

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

## القرار 6: إدارة مخاطر الارتهان للمزوّد

```
Spectrum of lock-in:

LOW LOCK-IN:
  Kubernetes (CNCF standard)      → migrate between EKS/GKE/AKS
  PostgreSQL                       → run on RDS, Aurora, Cloud SQL, or self-managed
  Kafka (Apache)                   → run on Confluent, MSK, or self-managed
  Terraform (HCL)                  → multi-cloud (but AWS-specific resources still exist)
  GitHub Actions                   → migrate to Tekton/GitLab CI with effort
  Prometheus + Grafana             → runs anywhere

MEDIUM LOCK-IN:
  Aurora PostgreSQL               → wire-compatible with PostgreSQL; leaving means
                                    a data migration (logical replication / dump)
                                    and losing Aurora-only features

HIGH LOCK-IN:
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
    Mitigation: envelope encryption alone does NOT remove the lock-in -- the
      data keys are stored wrapped by a KMS key and need KMS to unwrap.
      Real options: imported key material (BYOK, a copy of the key stays
      with you), the External Key Store (keys in your own HSM), or keeping
      the data keys under a key hierarchy you control
```

---

## سجل القرار المعماري (ADR)

يجب توثيق كل قرار بنية مهم كسجل قرار معماري. وهذا يمنع نسيان القرارات ويوفر السياق للمهندسين في المستقبل.

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
  2. Aurora rejected: higher cost at current scale for this workload, proprietary
     storage/replication layer, Aurora-only features would add lock-in.
  3. Self-managed rejected: team does not have Patroni/CloudNativePG operational experience.
     Risk of misconfigured failover causing data loss outweighs cost savings of ~$900/month.
  4. CockroachDB rejected: PostgreSQL-compatible but behavioral differences in edge cases.
     Financial data correctness is paramount; introducing behavioral uncertainty is unacceptable.
  5. RDS cost: ~$2,600/month On-Demand, ~$1,800/month with 1-year RI.
     Acceptable for current scale.

## Trade-offs Accepted
  - Limited to the RDS extension list (pg_partman, pg_cron, PostGIS are available;
    TimescaleDB is not).
  - Maintenance windows: AWS may restart instance; Patroni self-managed would be faster.
  - Cost at 10x scale: may need to revisit (Aurora or self-managed may be more economical).

## Consequences
  - All payment data is in a single AWS region (us-east-1) with Multi-AZ standby.
  - DR requires cross-region restore from automated backup (RTO: 2-4 hours).
  - Engineering team must NOT use Aurora-specific features to maintain RDS portability.

## Review Triggers
  - Monthly cost exceeds $6,000 (re-evaluate Aurora vs self-managed)
  - Need for an extension that RDS does not offer
  - Projected scale approaches the largest RDS instance sizes
  - Team hires PostgreSQL DBA with Patroni experience (re-evaluate self-managed)

## Alternatives Remaining Open
  Read replicas: add RDS read replicas before moving to self-managed.
  Aurora: reconsider if 10x scale makes Aurora Serverless v2 cost-competitive.
```

---

## قائمة تحقق: جودة القرار المعماري

يجيب القرار المعماري الجيد لمنصة مالية عن كل هذه الأسئلة:

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

## الخلاصات الأساسية للمهندسين الرئيسيين

1. **اجعل الخدمات المُدارة افتراضيًا، لكن وثّق المفاضلات صراحة** — كثيرًا ما يكون RDS الخيار الصحيح بدل PostgreSQL المُدار ذاتيًا، لكن يجب أن يكون القرار صريحًا بمفاضلات معلنة. "اخترنا RDS لأنه أسهل" ليس قرارًا معماريًا؛ بل تهرب من التفكير.

2. **السحب المتعددة ليست استراتيجية مرونة** — المناطق المتعددة على سحابة واحدة توفر مرونة أفضل بتعقيد أقل من السحب المتعددة لمعظم منصات الدفع. وأضف سحابة ثانية فقط حين يكون لديك سبب محدد ومبرر.

3. **الارتهان للمزوّد مقبول للحوسبة والشبكات، وخطر للبيانات والمراسلة** — يمكن استبدال موازنات الحمل في AWS. أما طوبولوجيا النسخ الخاصة بـ Aurora فلا. فارسم حد الارتهان عند طبقة البيانات.

4. **شبكة الخدمات استثمار تشغيلي، لا ترقية مجانية** — يضيف Istio استهلاك ذاكرة حقيقيًا، وتعقيدًا حقيقيًا، وأنماط فشل حقيقية. ولمتطلبات mTLS في PCI-DSS، كثيرًا ما يستحق ذلك. أما للرصد العام، فيمكن لـ Prometheus مع التتبع الموزع أن يوصلك إلى معظم الطريق بتكلفة أقل.

5. **يُقاس عائد هندسة المنصات بساعات الهندسة، لا بدولارات البنية التحتية** — تظهر قيمة فريق المنصة في تكرار النشر، وزمن التسليم، ومعدل الحوادث الأمنية — لا في توفير مباشر في تكلفة البنية التحتية. واستخدم مقاييس DORA كإطار للعائد.

6. **يجب مراجعة القرارات المعمارية عند المُطلِق، لا وفق جدول** — اكتب الشروط التي ستعيد فيها النظر في كل قرار. وحين تتحقق هذه الشروط (عتبة تكلفة، أو حد توسع، أو تغيير تنظيمي)، يصبح القرار تلقائيًا على جدول الأعمال. وهذا يمنع التحسين المبكر والقرارات "الميتة الحية" التي كان يجب مراجعتها منذ سنوات.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "تختار شركة تقنية مالية ناشئة PostgreSQL مُدارًا ذاتيًا على EC2 بدل Amazon RDS Aurora لأنها تريد تحكمًا كاملًا في إعدادات PostgreSQL. وبعد 18 شهرًا، أنفق الفريق 400 ساعة هندسية على: حوادث توسيع التخزين، وتصحيح تأخر النسخ المتماثلة، وإجراءات التحول اليدوي عند الفشل، وترقيات إصدارات PostgreSQL. بماذا كان سيوصي المهندس الرئيسي في البداية ولماذا؟",
      "options": ["كان PostgreSQL المُدار ذاتيًا الخيار الصحيح؛ يحتاج الفريق فقط أدوات تشغيل أفضل", "كان RDS Aurora PostgreSQL على الأرجح خيار البداية الأفضل: فهو يتولى التحول التلقائي عند الفشل في أقل من 30 ثانية، والتوسع التلقائي للتخزين حتى 128TB، وترقيات الإصدارات الفرعية الآلية، والنسخ عبر مناطق التوفر — فتختفي معظم ساعات العمل التشغيلي الـ 400، وتكلفة RDS مقابل EC2 مع التشغيل تكون عادةً أقل حين يُحتسب وقت الهندسة", "كان يجب أن يستخدم الفريق Google Cloud SQL بدل AWS RDS لتوافق أفضل مع PostgreSQL", "كانت التوصية الصحيحة CockroachDB الذي يلغي كل العبء التشغيلي لعناقيد PostgreSQL"],
      "correct": 1,
      "explanation": "ينطبق هنا مبدأ المهندس الرئيسي بتفضيل الخدمات المُدارة افتراضيًا. فقواعد البيانات المُدارة ذاتيًا تتطلب أن يصبح الفريق خبيرًا في تشغيل PostgreSQL — النسخ، والتحول عند الفشل، والنسخ الاحتياطي، والمراقبة، والترقيات — إضافة إلى عمل منتجه الأساسي. ولمعظم الشركات الناشئة في التقنية المالية، هذا الاستثمار التشغيلي ليس ميزة تنافسية. ويلغي التحول التلقائي وإدارة التخزين والنسخ الاحتياطي في RDS Aurora أشيع الحوادث التشغيلية. ويمكن عادةً ضبط معاملات الإعداد التي دفعت لاختيار الإدارة الذاتية (مثل max_connections، وshared_buffers) عبر مجموعات معاملات RDS."
    },
    {
      "text": "تستخدم منصة دفع AWS حصريًا. ويقترح المدير التقني استراتيجية سحب متعددة مع Azure كسحابة ثانوية للمرونة. ويقيّم مهندس رئيسي هذا الاقتراح. ما أهم سؤال يجب الإجابة عنه قبل الالتزام بالسحب المتعددة؟",
      "options": ["أي منطقة في Azure لها أقل زمن إلى منطقة AWS الحالية", "هل يُخدم هدف المرونة (النجاة من انقطاع إقليمي كامل في AWS) بشكل أفضل بالمناطق المتعددة على AWS مقارنة بالسحب المتعددة، بالنظر إلى أن السحب المتعددة تضاعف التعقيد التشغيلي، وتتطلب أدوات مستقلة عن السحابة، ونادرًا ما توفر توفرًا فعليًا أفضل من بنية AWS متعددة المناطق جيدة التصميم", "هل يدعم Azure كل خدمات AWS التي تستخدمها المنصة حاليًا", "هل يملك الفريق شهادات Azure لتشغيل السحابة الثانية"],
      "correct": 1,
      "explanation": "كثيرًا ما تُقترح السحب المتعددة كاستراتيجية مرونة لكنها نادرًا ما تحقق توفرًا أفضل من المناطق المتعددة على سحابة واحدة. فالانقطاعات الإقليمية تحدث — إذ شهدت us-east-1 عدة انقطاعات أثرت أيضًا على خدمات عالمية — لكن مناطق AWS مصممة لتفشل باستقلال، فتغطي بنية متعددة المناطق جيدة التصميم (مثل us-east-1 + us-west-2) هذا الخطر بتعقيد تشغيلي لمنصة واحدة. أما السحب المتعددة فتتطلب خبرة في منصتين، وتجريدات مستقلة عن السحابة (فقدان الخدمات الأصلية)، وشبكات عبر السحب (زمن وتكلفة خروج). ويجب أن يحدد المهندس الرئيسي كميًا فجوة المرونة التي تسدها السحب المتعددة مقابل التكلفة التشغيلية التي تضيفها."
    },
    {
      "text": "تقيّم منصة دفع اعتماد شبكة خدمات Istio. وتشمل معايير التقييم: متطلبات mTLS في PCI-DSS بين كل خدمات الدفع، وتغطية الرصد الحالية (Prometheus + Jaeger منشوران بالفعل)، وخبرة الفريق في Kubernetes (متوسطة). ما توصية المهندس الرئيسي؟",
      "options": ["اعتمد Istio فورًا؛ فـ mTLS متطلب في PCI-DSS وIstio معيار الصناعة", "اعتمد Istio لمتطلب mTLS في PCI-DSS لأن البديل (mTLS على مستوى التطبيق مع إدارة شهادات لكل خدمة) أعقد؛ واعترف بعبء الذاكرة (50-100MB لكل وكيل جانبي) واستثمر في تدريب الفريق قبل الإطلاق في الإنتاج", "ارفض Istio؛ واستخدم NetworkPolicy في Kubernetes لامتثال PCI-DSS بدل شبكة الخدمات", "أجّل القرار حتى يملك الفريق خبرة كبيرة في Istio؛ واعمل بـ TLS على مستوى التطبيق في الأثناء"],
      "correct": 1,
      "explanation": "متطلب mTLS في PCI-DSS سبب ملموس ومبرر لاعتماد شبكة الخدمات. فدون Istio، يتطلب تحقيق mTLS بين كل الخدمات أن تنفذ كل خدمة إدارة الشهادات، وتدويرها، والمصادقة المتبادلة — عبء كبير لكل خدمة. ويوفر Istio هذا بشفافية عبر الوكيل الجانبي. ويحدد التقييم المفاضلات بشكل صحيح: عبء ذاكرة الوكيل الجانبي (خطط له في ميزانيات الموارد)، والتعقيد التشغيلي (استثمر في التدريب)، وحقيقة أن Prometheus + Jaeger منشوران بالفعل (فقيمة الرصد في Istio مكررة جزئيًا لكنها غير ضارة). وهذا اعتماد مبرر، لا تحسين مبكر."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "بناء إطار قرارات البنية السحابية ونظام سجلات القرار المعماري",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "اكتب سجل قرار معماري (ADR) رسميًا يقيّم RDS Aurora PostgreSQL مقابل PostgreSQL مُدار ذاتيًا على EKS لمنصة دفع تعالج 20 ألف معاملة في الثانية. ويجب أن يتضمن الـ ADR: السياق (الحالة الحالية، والدوافع، والقيود)، والقرار (الخيار المختار بمنطق صريح)، والعواقب (الإيجابية والسلبية، بما فيها تقدير التكلفة الإجمالية للملكية لخمس سنوات لكل خيار مع احتساب ساعات الهندسة)، ومُطلِقات المراجعة (مقاييس محددة مثل سقف المعاملات في الثانية، أو معدل الحوادث التشغيلية، أو عتبة تكلفة تستدعي إعادة النظر). ويجب أن يكون الـ ADR بصيغة تلبي متطلبات توثيق تدقيق SOC 2."
    },
    {
      "id": "2",
      "description": "نفّذ صنف CloudDecisionMatrix يقيّم تغيير بنية مقترحًا عبر 5 أبعاد: (1) operational_cost: درجة 1-5 حسب ساعات الموظفين المطلوبة شهريًا، (2) financial_cost: درجة حسب تقدير التكلفة الإجمالية لثلاث سنوات، (3) performance_reliability: درجة حسب اتفاقية مستوى الخدمة الموثقة وزمن التحول عند الفشل، (4) compliance_security: درجة حسب تغطية ضوابط PCI-DSS وSOC 2، (5) strategic_flexibility: درجة حسب مستوى الارتهان للمزوّد (1=مرتهن كليًا، 5=قابل للنقل كليًا). وأدخل خيارين معماريين؛ وأخرج درجة موزونة لكل بُعد مع توصية إجمالية. واكتب اختبارات لسيناريو RDS مقابل PostgreSQL المُدار ذاتيًا."
    },
    {
      "id": "3",
      "description": "أنشئ خدمة ArchitectureDecisionRegistry في Spring تخزن سجلات القرار في PostgreSQL بدورة حياة للحالة (مقترح، ومقبول، ومستبدل، ومهمل). ونفّذ: (أ) نظام ReviewTrigger حيث لكل ADR عتبات مقاييس مرتبطة (مثل cost_per_1000_tx > $0.50، وtps_ceiling_hit = true)؛ (ب) مهمة مجدولة تقيّم كل مُطلِقات الـ ADR النشطة مقابل مقاييس Prometheus الحالية يوميًا؛ (ج) إشعار Slack تلقائي حين يتحقق مُطلِق، يتضمن عنوان الـ ADR، والمقياس الذي أطلق المراجعة، ورابطًا للـ ADR. واكتب اختبارًا يتحقق من إرسال الإشعار عند تجاوز عتبة."
    },
    {
      "id": "4",
      "description": "صمّم ووثّق تقييم مخاطر الارتهان للمزوّد لتقنيات منصة الدفع الحالية. صنّف كل تقنية حسب مستوى الارتهان (منخفض/متوسط/مرتفع) وجهد النقل (أيام/أسابيع/أشهر): EKS، وRDS Aurora، وSQS، وS3، وCloudFront، وDatadog، وPagerDuty، وGitHub Actions. ولكل مكوّن عالي الارتهان، حدد: (أ) واجهة AWS أو الميزة المحددة المسببة للارتهان، (ب) البديل القابل للنقل (مثل SQS ← Kafka)، (ج) تقدير جهد الترحيل، (د) مُطلِق العمل الذي يبرر الترحيل. ونفّذ حاسبة LockInRiskScore تنتج درجة اعتماد إجمالية على المزوّد للمنصة."
    }
  ]
}
-->
