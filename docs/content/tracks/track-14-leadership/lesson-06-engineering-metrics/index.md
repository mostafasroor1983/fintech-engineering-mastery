---
id: track-14-lesson-06
title: "Engineering Metrics — DORA, SPACE, and DevEx"
slug: engineering-metrics
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 6
difficulty: principal
estimatedMinutes: 75
status: published
tags: [DORA, SPACE, DevEx, deployment-frequency, lead-time]
prerequisites: [track-14-lesson-05]
---

# Engineering Metrics — DORA, SPACE, and DevEx

> [!NOTE]
> Measuring engineering performance is genuinely hard. The wrong metrics destroy morale and incentivise gaming. The right metrics create a shared language for improvement. Principal engineers shape which metrics their organisation uses—and that choice has long-term consequences.

## Why Engineering Metrics Matter at Principal Level

As a principal engineer, you are often in conversations about engineering effectiveness with:
- Engineering managers assessing team health
- VPs planning headcount
- Executives asking "are we getting better or worse?"

You need a framework for these conversations that is grounded in research, resistant to gaming, and actionable. DORA + SPACE + DevEx provides that framework.

---

## DORA Four Metrics

The DORA (DevOps Research and Assessment) four metrics are the most research-validated set of engineering effectiveness indicators available. They predict both software delivery performance and organisational performance (revenue growth, market share, profitability).

### Metric 1: Deployment Frequency

**What it measures**: How often do you successfully release to production?

```
Elite:  On-demand (multiple deploys per day)
High:   Daily to weekly
Medium: Weekly to monthly
Low:    Monthly or less
```

**What it tells you**: High deployment frequency indicates:
- Small batch sizes (each change is small and focused)
- Fast, reliable CI/CD pipeline
- Confidence to release (test coverage, feature flags, gradual rollout)

**What it does not tell you**: Nothing about whether what you're deploying has value.

**Payment system context**: Most payment services should target High (daily to weekly). Some core ledger or settlement services may be Medium due to change risk—that is not necessarily a problem if the risk management is deliberate.

### Metric 2: Lead Time for Changes

**What it measures**: Time from code commit to code running in production.

```
Elite:  Less than 1 hour
High:   Between 1 day and 1 week
Medium: Between 1 week and 1 month
Low:    More than 1 month
```

**What it tells you**: Long lead times indicate:
- Slow CI/CD pipeline (build time > 20 minutes is a signal)
- Manual approval gates blocking releases
- Large, infrequent batches of changes (high WIP, long merge queues)
- Excessive stage environments that changes must traverse

**Measurement approach**:

```bash
# Measure lead time using git and deployment records
# Time from first commit on branch to deployment tag
git log --format="%H %ai" origin/main..HEAD | tail -1  # First commit time
# vs
kubectl get deployment payment-service -o jsonpath='{.metadata.annotations.deployment-time}'

# Or via CI/CD system metrics (GitHub Actions, Jenkins)
# Most modern CI systems expose lead time natively
```

### Metric 3: Change Failure Rate

**What it measures**: What percentage of deployments cause a production failure requiring rollback, hotfix, or remediation?

```
Elite:  0-5%
High:   5-10%
Medium: 10-15%
Low:    More than 15%
```

**What it tells you**: High failure rate indicates:
- Insufficient test coverage
- Inadequate staging environment (staging doesn't mirror production)
- Large, complex deployments (too many changes at once)
- Missing canary/gradual rollout (all traffic hits the new version simultaneously)

**What it does not mean**: Zero failure rate. Aiming for zero change failures incentivises deploying nothing, which is worse.

### Metric 4: MTTR (Mean Time to Restore)

**What it measures**: How long does it take to recover from a production failure?

```
Elite:  Less than 1 hour
High:   Less than 1 day
Medium: Between 1 day and 1 week
Low:    More than 1 week
```

**What it tells you**: Long MTTR indicates:
- Poor observability (don't know what's broken)
- Slow rollback capability (takes 20 minutes to roll back a deployment)
- Complex dependencies (fixing one thing breaks another)
- No runbooks (engineers improvise under pressure)

---

## SPACE Framework

SPACE addresses a key limitation of DORA: it only measures delivery throughput and stability. It says nothing about developer experience, collaboration, or whether engineers are working on the right things.

SPACE measures five dimensions:

**Satisfaction and wellbeing**: Are engineers satisfied with their work? Are they burning out?
*Measure*: Quarterly survey. Net Promoter Score for "would you recommend this team as a great place to work?"

**Performance**: Does the work produce the intended outcomes?
*Measure*: Business metrics per team (payment success rate, fraud prevention rate, SLO compliance).

**Activity**: What are engineers actually doing with their time?
*Measure*: Code review throughput, PRs merged per week, CI pipeline runs. Use carefully—activity metrics are most gameable.

**Communication and collaboration**: How effectively does the team work together?
*Measure*: PR review time (how long from PR opened to first review?), meeting load, incident response coordination.

**Efficiency**: How much time is blocked by waiting, interruptions, or tooling friction?
*Measure*: CI feedback time, deploy pipeline duration, time from "code complete" to deployed.

---

## DevEx Metrics

Developer Experience (DevEx) metrics focus on the friction and flow of an engineer's day-to-day work. High DevEx predicts high output quality, low burnout, and strong retention.

### Core DevEx Metrics for Fintech Teams

**Time to onboard a new engineer**
- Measure: Time from first day to first production deployment
- Target: < 2 weeks for a senior engineer
- Signal: Complexity of local development setup, quality of documentation, CI/CD friction

**CI pipeline feedback time**
- Measure: Time from `git push` to test results
- Target: < 10 minutes (> 20 minutes = significant friction; engineers stop running CI before push)
- Signal: Test parallelisation, build caching, flaky test rate

**Deploy confidence score**
- Measure: Survey — "On a scale of 1-10, how confident are you when you deploy to production?"
- Target: > 7
- Signal: Reflects test coverage, staging environment quality, rollback procedure maturity

**Toil ratio**
- Measure: % of engineering time spent on repetitive operational work vs new development
- Target: < 20% toil
- Signal: Automation opportunities, alert fatigue, manual processes

---

## Avoiding Metric Gaming

Every metric, once used for performance evaluation, creates an incentive to game it. Principal engineers must protect metrics from becoming perverse incentives.

**Deployment frequency gaming**: Teams deploy trivial changes (typo fixes, comment updates) to inflate their deployment count. Mitigation: measure deployments of meaningful changes; track change complexity alongside frequency.

**Lead time gaming**: Teams create short-lived branches for each PR to minimise measured lead time. Mitigation: measure from "ticket started" not "code committed"; use business outcomes alongside process metrics.

**MTTR gaming**: Teams close incidents prematurely to show fast resolution times. Mitigation: measure customer impact duration, not just incident ticket open/close time.

**Change failure rate gaming**: Teams classify incidents as "not related to the deployment" to avoid increasing their failure rate. Mitigation: use an independent process for incident classification.

**Principal engineer's principle**: Treat DORA metrics as organisational signals, not individual performance metrics. No engineer should have their performance review tied to their team's deployment frequency—that creates all the wrong incentives.

---

## Fintech-Specific Engineering Metrics

DORA and SPACE are horizontal (applicable to any software team). Payment systems need additional domain-specific metrics:

### Business Outcome Metrics

```
Transaction Success Rate: % of payment submissions that complete successfully
  Target: > 99.9%
  Owned by: payments team

Payment Processing Latency p99: Time from submission to authorisation
  Target: < 500ms
  Owned by: payments team

Settlement Success Rate: % of authorised payments that settle successfully
  Target: > 99.95%
  Owned by: settlement team

Fraud Detection Rate: % of fraudulent transactions caught
  Target: varies by risk appetite; track false positive rate alongside
  Owned by: fraud team

SLO Compliance: % of time within error budget for all defined SLOs
  Target: > 95% of SLOs passing in any rolling 30-day window
  Owned by: platform/SRE team
```

---

## Presenting Metrics to Leadership

Engineering metrics are only valuable if leadership understands them and uses them for decision-making.

### The One-Page Engineering Health Dashboard

```
Engineering Health — Q4 2026

DELIVERY (DORA):
  Deployment Frequency: 2.3 deploys/week (High ✓)
  Lead Time: 4 days (High ✓; target: < 1 week)
  Change Failure Rate: 8% (High ✓; improved from 14% last quarter)
  MTTR: 1.2 hours (High ✓; target: < 4 hours)

BUSINESS OUTCOMES:
  Payment Success Rate: 99.91% (SLO: 99.9% ✓)
  P99 Processing Latency: 423ms (SLO: < 500ms ✓)
  Settlement Failures: 0.04% (down from 0.11% last quarter ✓)

DEVELOPER EXPERIENCE:
  CI Feedback Time: 14 minutes (target: < 10 min ✗ — investing in parallelisation)
  Deploy Confidence: 7.2/10 (target: > 7 ✓)
  On-Call Alert Volume: 23 pages/week (target: < 15 ✗ — alert review scheduled)

TOP CONCERNS:
  1. CI pipeline speed — impacting developer productivity
  2. Alert fatigue — on-call engineers receiving too many pages
  3. Settlement service test coverage (38%) — slowing feature delivery

INVESTMENTS PLANNED Q1:
  1. CI pipeline parallelisation (target: 8 min feedback time)
  2. Alert audit and rule cleanup (target: < 15 pages/week)
  3. Settlement service test coverage sprint (target: 70%)
```

---

## Using Metrics for Improvement

The purpose of measuring is to improve, not to report. Principal engineers use metrics to identify the highest-leverage investments:

```
IF Deployment Frequency < High AND Lead Time > 1 week:
  → Investigate CI/CD pipeline; look for sequential stages that can be parallelised
  → Investigate PR review bottlenecks (> 1 day for first review?)
  → Investigate manual approval gates — can they be automated?

IF Change Failure Rate > 10%:
  → Investigate test coverage and test quality in recently changed modules
  → Investigate staging environment fidelity (does staging mirror production?)
  → Investigate deployment batch size — are changes too large?

IF MTTR > 4 hours:
  → Investigate observability: can engineers find the problem in < 30 minutes?
  → Investigate rollback procedure: does it work? How long does it take?
  → Investigate runbook quality: were runbooks used? Did they help?

IF DevEx Deploy Confidence < 6:
  → Survey engineers: what specifically causes anxiety when deploying?
  → Investigate test coverage, staging quality, and gradual rollout capability
```

---

## Key Takeaways

- DORA four metrics are research-validated and predict both delivery performance and business outcomes—use them as a foundation for all engineering effectiveness conversations
- SPACE adds the dimensions DORA misses: developer experience, satisfaction, and whether the team is working on the right things
- Metrics must never be used for individual performance evaluation—they are team and system health indicators; using them individually creates gaming and destroys trust
- Payment systems need domain-specific business metrics (transaction success rate, settlement failure rate, SLO compliance) alongside DORA—purely process metrics do not capture business impact
- Present metrics to leadership with context and trend (not just current state), top concerns, and planned investments—a number without narrative is not a conversation
- The goal is improvement, not reporting: use metrics to identify the highest-leverage investments each quarter

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A team's Change Failure Rate is 18% (Low tier). What is the most likely root cause to investigate first?",
      "options": ["Insufficient deployment frequency", "Missing test coverage or staging environment that does not mirror production", "On-call rotation problems", "Excessive MTTR"],
      "correct": 1,
      "explanation": "High Change Failure Rate indicates deployments are causing production failures. The primary causes are insufficient test coverage (problems not caught before deployment), staging environments that don't mirror production (things work in staging but fail in production), and large deployment batches (too many changes at once). These should be investigated before looking at process issues."
    },
    {
      "text": "Why should DORA metrics never be used for individual engineer performance evaluation?",
      "options": ["They are too difficult to measure at the individual level", "Using them individually creates gaming incentives — engineers will optimize for the metric rather than team outcomes, destroying the signal", "DORA metrics only apply to DevOps teams", "Individual metrics violate GDPR"],
      "correct": 1,
      "explanation": "When metrics are tied to individual performance reviews, engineers game them: deploying trivial changes to inflate frequency, closing incidents prematurely to reduce MTTR, attributing failures to other teams to lower their change failure rate. DORA metrics are organisational and team health signals — they lose their diagnostic value when used as individual scorecards."
    },
    {
      "text": "What additional metrics does a payment platform need beyond the DORA four that DORA does not capture?",
      "options": ["Git commit frequency and lines of code", "Domain-specific business metrics: transaction success rate, settlement failure rate, fraud detection rate, and SLO compliance", "Engineer satisfaction scores and meeting attendance", "Code review turnaround time"],
      "correct": 1,
      "explanation": "DORA metrics measure delivery process health (how often, how fast, how reliably you deploy). Payment platforms need domain-specific business outcomes metrics — transaction success rate, settlement failure rate, fraud detection accuracy, SLO compliance — to know whether the deployments are actually delivering business value. Process metrics alone cannot substitute for outcome metrics."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Engineering Metrics Dashboard and Improvement Framework",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design a one-page Engineering Health dashboard for a payment platform team covering: all four DORA metrics with current values, tier classification (Elite/High/Medium/Low), and quarter-over-quarter trend; three payment-specific business outcome metrics; and two DevEx metrics. Include current values that show a team in the 'High' tier with one metric at 'Medium'."},
    {"id": "2", "description": "Build a lead time measurement tool: a script or service that queries git history and deployment annotations (Kubernetes deployment metadata or CI/CD webhook events) to calculate the time from first commit on a branch to production deployment, produces percentile distributions (p50, p75, p99), and classifies the result against DORA tiers."},
    {"id": "3", "description": "Identify two specific gaming risks for the metrics in your dashboard (e.g., deploying trivial changes for frequency, closing incidents prematurely for MTTR). For each, design a secondary metric or process safeguard that detects and prevents the gaming behavior."},
    {"id": "4", "description": "Write an engineering metrics quarterly review document for a fictional payment team showing improvement in Change Failure Rate from 14% to 8% over one quarter. Include: the interventions taken, which SPACE dimensions were affected, the fintech-specific business outcomes that improved as a result, and the top three investments planned for the next quarter."}
  ]
}
-->

