---
id: track-14-lesson-11
title: "Incident Leadership — Command and Communication"
slug: incident-leadership
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 11
difficulty: principal
estimatedMinutes: 75
status: published
tags: [incident-leadership, incident-commander, communication, postmortem, blameless]
prerequisites: [track-14-lesson-10]
---

# Incident Leadership — Command and Communication

> [!NOTE]
> The difference between a 15-minute resolution and a 3-hour outage in a payment system is usually not technical capability—the engineers in the room have the skills. It is leadership: clear roles, structured communication, calm decision-making under pressure. These are learnable skills that principal engineers must develop.

## The Incident Commander Role

The incident commander (IC) is not the person who fixes the problem. The IC is the person who coordinates the people who fix the problem.

**IC responsibilities:**
- Maintain situational awareness: what do we know? What are we investigating? What have we tried?
- Keep investigation threads from duplicating
- Make decisions when the team is stuck or disagreeing
- Communicate status to stakeholders outside the room
- Watch the clock: if an approach hasn't worked in 15 minutes, change approach
- Escalate when expertise is needed that is not in the room

**What the IC does not do:**
- Write code or run commands during the incident (this is the tech lead's job)
- Deep-dive into one specific problem while losing sight of the broader situation
- Let seniority silence: if a junior engineer has a theory, it deserves to be heard

**Separating the IC from the tech lead is critical.** In every incident where the same person is both running commands and coordinating the response, the two roles interfere. The person debugging becomes unaware of parallel threads; stakeholder communication gets ignored.

---

## War Room Communication Discipline

An incident response with 10 engineers in a Slack channel or video call, all talking at once, is slower and noisier than 3 engineers with clear communication discipline.

### Rules for the War Room

**One person talks at a time.** The IC enforces this. If two people are talking, the IC says: "Let's hear from [person] first."

**State, action, update format.** Every communication follows this structure:

```
STATE:   What you know to be true right now
ACTION:  What you are currently doing about it
UPDATE:  When you will report back (or what would change your assessment)
```

Example:
```
"Database: connections normal at 14/20 (STATE).
 I'm checking the slow query log now (ACTION).
 Will update in 2 minutes (UPDATE)."
```

**Write everything down in the incident channel.** Decisions made verbally in a call that are not written down evaporate. The IC or a designated scribe records all key findings and decisions in the incident Slack channel in real time.

**Avoid speculation.** "It's probably the database" stated confidently without evidence sends engineers chasing a false lead. Use: "Database is a hypothesis — we need to confirm."

---

## Delegating Investigation Threads

An unmanaged incident response has everyone investigating the same thing. A managed response has parallel investigation threads with clear owners.

**Thread delegation structure:**

```
IC (Incident Commander): @alice
  Current assessment: Payment API error rate at 15% since 02:17 UTC
  Known: DB connections normal. Kafka lag normal.
  Unknown: Root cause.

  THREAD 1: Database layer
    Owner: @bob
    Investigating: Slow query log, explain plans for recent queries
    Checkpoint: 10 minutes

  THREAD 2: Recent deployments
    Owner: @charlie
    Investigating: Any deployments in last 4 hours; diff between current and previous
    Checkpoint: 5 minutes

  THREAD 3: External dependencies
    Owner: @diana
    Investigating: Payment gateway status page; fraud service health; notification service health
    Checkpoint: 5 minutes

  ESCALATION READY: @frank (database admin, paged but not yet on call)
```

**Thread checkpoint discipline:** The IC calls for thread updates at the stated intervals. If a thread has not found anything in 15 minutes, re-evaluate whether it is worth continuing.

---

## Maintaining Calm Under Pressure

Incidents in payment systems create genuine pressure: customers cannot pay, money is at risk, regulators may be involved. The IC's emotional state is contagious. If the IC is panicking, the room panics.

### Techniques for Maintaining Composure

**Slow down to speed up**: The urge to act immediately is strong. Resist it. 5 minutes of clear assessment almost always produces faster resolution than 20 minutes of uncoordinated action.

**Name the state of the room**: "We've been investigating for 20 minutes without finding root cause. That's uncomfortable, but it's normal. Let's reset and ensure our assumptions are correct."

**Normalize not knowing**: "We don't know the root cause yet" is a complete and accurate status. Pretending to know when you don't creates false leads.

**Acknowledge the pressure without being paralyzed by it**: "I know customers are waiting. We're moving as fast as we safely can. Panicking won't help them faster."

---

## Stakeholder Communication Cadence

Stakeholders outside the incident room—executives, customer support, compliance teams—need regular updates even when you don't have new information. Silence is worse than "we're still investigating."

### Communication Schedule

```
T+0 min  (alert fires):     Internal war room opened, IC assigned

T+5 min  (awareness):       Slack message to #incidents-leadership:
                             "P1 declared. Payment API elevated error rate.
                              IC: @alice. Investigating."

T+15 min (first update):    "Payment API: 15% error rate since 02:17.
                              Root cause under investigation.
                              DB and Kafka confirmed normal.
                              Next update: T+30 min or on significant finding."

T+30 min (if unresolved):   "Payment API: still investigating. No root cause yet.
                              We've ruled out: database, Kafka, recent deployments.
                              Now investigating: upstream fraud service performance.
                              Have rolled back deployment as precaution (error rate unchanged).
                              Next update: T+45 min.
                              @compliance-officer: incident duration approaching 15 minutes.
                              Preparing regulatory assessment."

T+45 min (if resolved):     "Payment API: resolved at 03:02 UTC. 45 minutes total duration.
                              Root cause: slow SQL query introduced in fraud service 02:48 deploy.
                              Fix: rolled back fraud service deployment.
                              Impact: ~6,750 failed payment attempts (reconciliation running).
                              Postmortem scheduled: [date]. Timeline and PIR to follow."
```

---

## What to Say (and What Not to Say) During Outages

### What to Say

```
ACCURATE:
"We are experiencing elevated error rates in our payment processing API.
 Our team is actively investigating. We will provide an update in 15 minutes."

ACTIONABLE:
"If you submitted a payment in the last 30 minutes and it appears to have failed,
 please do not retry. We will process or confirm all recent transactions within 2 hours."

HONEST ABOUT TIMELINE:
"We do not have an estimated resolution time yet. We will update every 15 minutes."
```

### What Not to Say

```
DON'T SPECULATE:
"The database appears to have crashed." (Until confirmed)
Incorrect speculation that gets publicly shared damages trust more than "we're investigating."

DON'T PROMISE TIMELINES YOU CAN'T KEEP:
"We'll have this resolved in 10 minutes." (Unless you are very sure)
Missed promises compound the damage.

DON'T MINIMIZE:
"This is only affecting a small number of customers."
If 847 customers cannot pay, they don't feel like a small number.
State facts: "This is affecting approximately X% of payments."

DON'T GO SILENT:
Never go more than 30 minutes without an update during an active P1 incident,
even if the update is "still investigating, no new information."
```

---

## Regulatory Notification for Financial Incidents

For payment system incidents, regulatory notification may be legally required. This is not optional.

**Key principle**: Regulatory notification obligation is triggered by awareness, not by impact assessment. Once you are aware of a significant incident, the notification clock starts.

```
Decision tree for regulatory notification:

Is this a P1 incident affecting payment processing?
  NO  → Standard incident process (no regulatory obligation)
  YES → Continue

Is customer data potentially at risk (breach scenario)?
  YES → CISO paged immediately; breach notification process activated

Has the incident lasted more than 15 minutes of meaningful customer impact?
  YES → Notify Head of Operations and Compliance Officer immediately

Is this a "major operational incident" (complete payment processing unavailability)?
  YES → FCA/PRA notification may be required (UK)
        OCC/FDIC notification within 36 hours (US)
        ECB/EBA notification within 4 hours (EU, DORA)
        RBI notification within 2-6 hours (India)
  
RULE: When in doubt, notify. Failure to notify is a separate regulatory breach.
      Your Compliance Officer makes the notification decision, not engineering.
```

---

## Running the Postmortem

The postmortem (also called a post-incident review or PIR) is where the value of an incident is extracted for the organisation.

### Postmortem Meeting Facilitation (60-90 minutes)

```
Pre-work (facilitator and IC, before meeting):
  Build the timeline from logs, Slack history, PagerDuty
  Identify contributing factors (not root causes — there are always multiple factors)
  Draft 3-5 discussion questions

Meeting opening:
  "This is a blameless review. We are here to understand the system failure,
   not to assign individual blame. Everything said in this room is for learning,
   not for performance reviews or disciplinary action."

Timeline review (20 min):
  Walk through the prepared timeline
  Engineers correct inaccuracies
  Identify: what did we know and when?

Contributing factor analysis (30 min):
  For each contributing factor: "Why was this condition present?"
  Five whys: get to systemic causes, not individual errors
  
  NOT: "Bob deployed bad code"
  YES: "The CI pipeline did not catch a performance regression that only manifests under production load"

Action item generation (20 min):
  For each contributing factor: what would prevent recurrence?
  Rate each item: High/Medium/Low impact on preventing recurrence
  Assign owner + deadline to each High-impact item

What went well (10 min):
  Genuinely acknowledge what worked: fast detection, quick escalation, good communication
  This is not PR; it identifies practices worth reinforcing
```

---

## Building a Learning Culture

Blameless culture is frequently stated and rarely practiced. The gap between statement and practice destroys trust faster than never claiming it.

**Signals of genuine blameless culture:**
- Engineers volunteer information freely in postmortems without self-protection
- Action items are systemic (CI pipeline, monitoring, process) not individual (retrain Bob)
- Postmortems are published openly to the entire engineering organisation
- Senior engineers share their own mistakes publicly in postmortems

**Signals of fake blameless culture:**
- Engineers are cautious about what they say in postmortems
- Action items include "engineer X should be more careful"
- Postmortems are circulated only to the team involved
- Nobody senior ever appears in a postmortem as the person who made a mistake

As a principal engineer, the most powerful signal you can send is sharing your own mistakes openly in postmortems. If the most senior technical person in the room describes how they made an error, contributed to an incident, and what they learned—the culture shifts.

---

## Key Takeaways

- The incident commander coordinates people, not systems—the IC should not be writing code during an incident; that role belongs to the tech lead
- War room communication discipline (state, action, update; one person at a time; write everything down) is learned, not natural—it must be taught and enforced
- Stakeholder communication must happen on a regular cadence regardless of whether you have new information: silence is worse than "still investigating, next update in 15 minutes"
- Regulatory notification obligations for financial incidents have hard deadlines from the moment of awareness—Compliance Officers make notification decisions, not engineering teams
- The postmortem is the value extraction mechanism: the incident is a costly experiment; the postmortem is where you get the lessons
- Blameless culture requires senior engineers to model it explicitly: share your own mistakes in postmortems, ensure action items are systemic not individual, publish postmortems widely

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "During a P1 payment outage, the incident commander (IC) starts running database queries and writing rollback scripts while also trying to coordinate three investigation threads. What is wrong with this and what should the IC do instead?",
      "options": ["Nothing is wrong — the most senior person should do the most critical technical work", "The IC is performing the tech lead role simultaneously; this causes the IC to lose situational awareness of parallel investigation threads and stakeholder communication; the IC should delegate technical execution to a tech lead and focus on coordination, communication, and decision-making", "The IC should delegate communication to another engineer and focus entirely on technical investigation", "The IC should stop coordinating threads and let engineers self-organise"],
      "correct": 1,
      "explanation": "The IC role and tech lead role must be separated. When the same person debugs and coordinates, they inevitably drop coordination responsibilities — parallel threads go unmonitored, stakeholder communication lapses, and the 15-minute checkpoint discipline breaks down. The IC's job is to maintain situational awareness, coordinate parallel investigation threads, communicate to stakeholders, and make decisions when the team is stuck — not to run commands or write code."
    },
    {
      "text": "An EU-regulated payment processor experiences a complete payment processing outage lasting 20 minutes. At what point does regulatory notification become a consideration, and who makes the notification decision?",
      "options": ["After full root cause analysis is complete; the principal engineer makes the decision", "After 4 hours of outage, automatically; the incident commander notifies regulators", "Within 4 hours of becoming aware of a major operational incident (EBA/DORA); the Compliance Officer makes the notification decision, not engineering", "Only if customer data was breached; the CISO makes the decision"],
      "correct": 2,
      "explanation": "Under EBA operational resilience guidelines and the EU DORA regulation, major operational incidents (including payment processing unavailability) require notification within 4 hours of awareness. The notification obligation is triggered by awareness, not by impact assessment — once you know about a significant incident, the clock starts. Critically, the Compliance Officer makes the notification decision, not engineering. Engineering's role is to inform compliance immediately so they can assess the obligation."
    },
    {
      "text": "In a postmortem, the action items list includes: 'The on-call engineer should double-check deployment checklists before releasing to production.' What is wrong with this action item?",
      "options": ["It is too vague — it needs a specific deadline and owner", "It is an individual behaviour change action item, which is a signal of non-blameless culture; effective postmortem action items are systemic (improve the CI pipeline, add automated checks, update runbooks) not individual (retrain engineer X)", "It is too broad — it should specify which checklists", "Nothing is wrong — human vigilance is a valid mitigation for deployment risks"],
      "correct": 1,
      "explanation": "Action items that target individual behaviour ('engineer X should be more careful') indicate non-blameless culture and are ineffective — humans are fallible and will make the same error again under pressure. Systemic action items address the conditions that allowed the error: 'Add automated deployment gate that validates checklist items in CI/CD' is systemic, testable, and does not rely on individual vigilance. Blameless postmortems produce system improvements, not individual performance targets."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Incident Command and Communication System for a Payment Platform",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design a complete incident response playbook for a P1 payment processing outage at an EU-regulated payment processor. The playbook must cover: IC/TL role definitions and hand-off procedure, investigation thread delegation template (with thread owner, scope, and checkpoint time), stakeholder communication cadence (T+0 through T+45 with specific message templates), regulatory notification decision tree (EBA 4-hour threshold, CISO breach protocol), and escalation matrix with named roles and trigger conditions."},
    {"id": "2", "description": "Write a complete incident response simulation script for a GameDay exercise: a payment authorisation service experiencing 15% error rate starting at 02:17 UTC. The script must include: the initial alert condition, three parallel investigation threads (database, recent deployments, external dependencies), two misleading indicators that lead threads astray before the root cause (a slow query in the fraud service deployed at 02:48), and a timeline of events for the facilitator. Include specific IC communication messages at T+5, T+15, T+30, and T+45."},
    {"id": "3", "description": "Create a blameless postmortem template and completed example for the scenario in task 2 (45-minute payment outage caused by fraud service slow query). The template must include: timeline section, contributing factor analysis using five whys (stopping at systemic factors not individual errors), 'what went well' section, and action items table with SMART criteria. The completed example must include at least 4 contributing factors and 3 High-priority action items that are systemic rather than individual."},
    {"id": "4", "description": "Design a PagerDuty escalation policy and on-call rotation for a 12-engineer payment platform team covering 24/7 P1 response. Specify: primary/secondary on-call structure, acknowledgement SLA for P1 (target: 5 minutes), escalation steps if primary does not acknowledge, out-of-hours escalation path to VP Engineering, and the 'regulatory notification ready' checklist that fires automatically for incidents exceeding 15 minutes of customer impact."}
  ]
}
-->
