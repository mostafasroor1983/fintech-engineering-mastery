---
id: track-14-lesson-07
title: "Mentoring Senior Engineers — Growing Technical Talent"
slug: mentoring
track: track-14
trackName: "Staff & Principal Engineering Leadership"
sequence: 7
difficulty: principal
estimatedMinutes: 70
status: published
tags: [mentoring, coaching, growth, feedback, 1:1]
prerequisites: [track-14-lesson-06]
---

# Mentoring Senior Engineers — Growing Technical Talent

> [!NOTE]
> Mentoring senior engineers is the highest-leverage activity available to a principal engineer. Each senior engineer you help grow to staff level multiplies your impact across the entire organisation. It is also among the most difficult—senior engineers have strong opinions, established habits, and clear ideas about their own trajectory.

## Mentoring vs Coaching: Know Which Mode You're In

These terms are often used interchangeably but describe different relationships:

**Mentoring**: You have relevant experience and are sharing it. The mentor provides direction, suggestions, and advice. "Here's what worked for me in this situation."

**Coaching**: You ask questions that help the mentee think through their own situation. The coach does not provide answers. "What do you think the right approach is? What's holding you back?"

Both are valuable. The mistake is using mentoring mode when coaching is needed (solving their problem instead of helping them develop) or using coaching mode when they need direct advice (asking questions when time is short and stakes are high).

**Practical guide**: For skill-building (how to write an RFC, how to do a design review), use mentoring—share your experience. For career decisions and self-awareness (should I move to management? am I underestimating my own impact?), use coaching—ask questions.

---

## 1:1 Structure for Technical Growth

A principal engineer's 1:1 with a mentee should be explicitly not a status update. Status updates are for manager 1:1s. This is technical growth time.

### Agenda Structure (60 minutes monthly or biweekly)

**15 min: What's on their mind?**
Free-form. What are they wrestling with this week? This surfaces the real work, not the sanitised version.

**20 min: Deep technical discussion**
Rotate through: a design they're working on, a production incident they handled, a technology they're exploring. Go deep on one thing rather than shallow on five things. You are demonstrating what deep technical thinking looks like.

**15 min: Growth-focused feedback**
Based on what you observed this month: code reviews, design documents, meetings. Use the SBI model (below). Be specific. Avoid generic praise.

**10 min: Looking ahead**
What are they working on next? Where is the opportunity to stretch? What support do they need from you?

---

## Giving Technical Feedback Using SBI

**SBI** (Situation, Behaviour, Impact) is a structured feedback model that makes feedback concrete and actionable rather than personal and vague.

**Situation**: Describe the specific context. When and where did this happen?

**Behaviour**: Describe the observable behaviour. Not the person's intent or character—what they did or said.

**Impact**: Describe the consequence of the behaviour. On you, the team, the product, or the customer.

### Example 1: Positive Feedback

```
"During the RFC review for the settlement migration last Tuesday (Situation),
you proactively addressed the idempotency concern before anyone asked about it
and had a written analysis of three approaches with their tradeoffs (Behaviour).
This gave the reviewers confidence that you had thought the problem through, and
the review wrapped up 30 minutes early because we didn't have to work through
the idempotency issue from scratch (Impact)."
```

Compare to the common alternative: "Great RFC—really thorough." This is nice to hear but tells the engineer nothing about what specifically to repeat.

### Example 2: Developmental Feedback

```
"In the architecture review for the fraud service redesign last Thursday (Situation),
when [@senior-architect] asked about the database sharding approach, you defended
your original proposal without acknowledging the concerns he raised about hot keys (Behaviour).
Two engineers in the room told me afterward that they agreed with his concern but
didn't want to pile on. The sharding strategy now needs revisiting after three months
of implementation (Impact).

What I want to explore with you is: what was going through your mind when he raised that?"
```

The question at the end opens a coaching conversation rather than delivering a verdict.

---

## Designing Stretch Assignments

Growth comes from doing things that are beyond current capability but not so far beyond that failure is likely. The right stretch assignment:

- Has enough support (you, the manager, relevant documentation)
- Has clear success criteria (the mentee knows what "good" looks like)
- Has real stakes but bounded blast radius (not a critical path item, but not a toy project)
- Surfaces learning opportunities specific to the mentee's growth areas

### Example Stretch Assignments for Senior → Staff Transition

**Scope expansion**: "Lead the design review for the payment audit system. I'll review your design document before you present it, but I won't be in the room for the review itself. After, let's debrief on how it went."

**Cross-team influence**: "There are three teams that need to agree on the event schema for payment events. Drive that alignment. I'm available as a sounding board but am not attending those meetings."

**Writing for a broader audience**: "Write an RFC for migrating our fraud scoring to a real-time model. This needs to reach the VP level—the RFC should be readable by someone who doesn't know our fraud service."

**On-call leadership**: "You're primary on-call next week. I'll be backup. For any P1 incidents, I want you to lead the incident response. I'll be available to advise but not to run it."

---

## Helping Engineers Get Promoted

Helping a senior engineer get promoted to staff is a substantial part of a principal engineer's value to the organisation. It requires:

**Understanding the promotion criteria**: Read your company's engineering levels document carefully. If it doesn't exist, make it your first project to get clarity on what staff-level behaviours look like.

**Evidence collection**: Promotions are won in the room by the manager with the evidence binder. Help the engineer collect evidence throughout the year, not in a panic before the promotion cycle.

```
Evidence types that move promotions:
  Technical: RFCs authored, designs that shipped, complex bugs found and fixed
  Scope: Cross-team problems solved, decisions made without being directed
  Influence: Code reviews that improved others' work, documentation that helped teams
  Leadership: Engineers they mentored, decisions they drove
  Business impact: Performance improvements with measured outcomes, reliability improvements
```

**Visibility work**: Promotions require visibility. Help your mentee find opportunities to present at internal tech talks, lead cross-team design reviews, and author blog posts or RFCs that reach the VP level.

**The sponsor-mentor distinction**: A mentor helps you grow. A sponsor advocates for you in rooms you are not in. At the principal level, you should aim to be both for high-potential engineers. Explicitly sponsor engineers in calibration meetings: "I want to highlight @engineer's work on the settlement migration—it had the complexity and cross-team scope that characterises staff-level work."

---

## IC vs Management Track Discussion

This conversation will come up with every senior engineer you mentor. Handle it with care.

**What not to do**: Tell them which track is right for them. You don't know. What you can do is help them think clearly about it.

**Questions to ask:**

```
"What energises you at work? Is it solving hard technical problems, or is it
 helping people around you grow and succeed?"

"When you imagine yourself at 45, what does a great day look like?
 Walking into a design review and driving the architecture? Or walking into
 a 1:1 with a struggling engineer and helping them figure out the path forward?"

"The management track creates leverage through people. The IC track creates
 leverage through ideas and systems. Which form of leverage feels more natural?"

"What would you be giving up if you chose management? How do you feel about
 not writing code every day?"
```

The goal is clarity, not advocacy for one path. Both paths are legitimate and valuable. Many excellent engineers try management, discover it's not for them, and return to IC roles. That's not failure—it's self-knowledge.

---

## Knowledge Transfer Patterns

As a principal engineer, your most valuable asset is not your code—it is your mental models, your pattern library, and your institutional knowledge. Transferring this knowledge multiplies your impact.

**Code reviews as teaching**: Don't just approve or reject PRs. Add explanatory comments: "I'd change this to use a parameterised query. Here's why: [link to ADR-003 or explanation]. The pattern we use in the settlement service is a good reference."

**Design reviews with narration**: When reviewing a design, narrate your thought process out loud: "The first thing I look at in any payment service design is: what happens when the downstream call fails? Let me walk through that failure mode with this design."

**Pairing on hard problems**: Schedule working sessions on genuinely hard problems. The mentee observes how you think through ambiguity, not just what conclusions you reach.

**Writing**: The highest-leverage knowledge transfer is written. An ADR, a runbook, a tech talk that reaches 50 engineers multiplies your impact far beyond any 1:1.

---

## Mentoring in Regulated Fintech

Fintech has unique mentoring requirements that do not exist in product companies:

**Compliance literacy**: A senior engineer aspiring to staff level in fintech must understand PCI DSS, GDPR, FCA/OCC requirements well enough to identify when a design decision has compliance implications. Build this into mentoring conversations: "Walk me through the compliance implications of this design decision."

**Risk thinking**: Financial services operates in an environment where mistakes have direct customer and regulatory consequences. Help mentees develop a reflexive habit of asking "what is the worst-case outcome here?" and "how do we know if this is happening?"

**Security training**: Many fintech companies require annual security awareness training. Beyond the mandatory training, help mentees build real security engineering instincts through design reviews that include security threat modelling.

---

## Key Takeaways

- Distinguish mentoring (sharing your experience and advice) from coaching (asking questions to develop the mentee's own thinking)—use the right mode for the situation
- Use SBI (Situation, Behaviour, Impact) for feedback: specific, observable, consequential—not "great work" or "you need to communicate better"
- Promotion is won by the manager in a room you are not in—help engineers collect evidence all year, not just at calibration time, and explicitly sponsor them in those rooms
- Stretch assignments must have real stakes, clear success criteria, and adequate support—too easy and there is no learning; too hard and confidence is damaged
- IC vs management track is the mentee's decision, not yours—your job is to help them think clearly about what energises them, not to tell them which path is right
- In fintech specifically, build compliance literacy, risk thinking, and security engineering instincts into mentoring conversations—these are non-negotiable at staff level in regulated environments

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A mentee comes to you with a career question: 'Should I move into engineering management or stay on the IC track?' What is the correct response as a principal engineer mentor?",
      "options": ["Tell them directly which track is better suited to their skills based on your observations", "Refuse to discuss it — career decisions are for HR", "Ask coaching questions that help them clarify what energises them and what they would give up on each path, without advocating for either", "Recommend management because it has more organisational impact"],
      "correct": 2,
      "explanation": "The IC vs management track decision belongs to the mentee, not the mentor. The mentor's role is to help them think clearly — asking questions like 'what energises you?' and 'what would you be giving up?' — rather than telling them which path is right. The mentor has an inherent bias (they are on the IC track) and does not have enough information about the mentee's deeper motivations to make this decision for them."
    },
    {
      "text": "What is wrong with the feedback 'Great RFC — really thorough'?",
      "options": ["It is too positive and may embarrass the engineer", "It is not specific enough — it tells the engineer nothing about what behaviours to repeat", "It should include negative feedback to be balanced", "Principal engineers should not give positive feedback"],
      "correct": 1,
      "explanation": "Generic praise like 'great job' or 'really thorough' is pleasant but not actionable. The engineer does not know which specific behaviors produced the positive outcome. SBI (Situation, Behaviour, Impact) feedback gives the engineer precise information: what they did (behavior), when (situation), and what resulted (impact). This allows them to deliberately repeat the behavior."
    },
    {
      "text": "What distinguishes a mentor from a sponsor at the principal engineer level?",
      "options": ["Mentors are more senior than sponsors", "Mentors help engineers grow through guidance and feedback; sponsors advocate for engineers in rooms they are not present in (calibration meetings, promotion decisions)", "Sponsors are assigned by HR; mentors are chosen informally", "There is no meaningful difference between the two roles"],
      "correct": 1,
      "explanation": "A mentor helps you grow through 1:1 guidance, feedback, and stretch assignments. A sponsor uses their credibility and presence in leadership rooms to advocate for you when you are not there — in promotion calibration meetings, in project assignments, in org-wide visibility opportunities. At principal level, being both for high-potential engineers is explicitly part of the role."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Mentoring Program Design for Senior-to-Staff Engineer Transitions",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "Design a 6-month mentoring plan for a senior engineer targeting staff promotion. The plan must include: 3 specific stretch assignments with real stakes and bounded blast radius, a monthly 1:1 agenda structure, 4 evidence collection milestones (what artifacts to gather and when), and 2 visibility opportunities (forums where the mentee can demonstrate staff-level impact)."},
    {"id": "2", "description": "Write three SBI-formatted feedback examples for a hypothetical senior engineer: (1) positive feedback for a well-handled architecture review, (2) developmental feedback for a decision made without adequately considering failure modes, and (3) positive feedback for cross-team collaboration. Each must include all three SBI components and end with a question that opens a coaching conversation."},
    {"id": "3", "description": "Create a fintech-specific mentoring curriculum covering three competency gaps common in senior engineers transitioning to staff: (a) understanding PCI DSS implications of a new feature design, (b) applying risk thinking to identify failure modes in a payment flow, and (c) writing an RFC that is readable at the VP level. For each, design one specific activity or exercise."},
    {"id": "4", "description": "Design a promotion evidence binder template for a senior-to-staff promotion in a fintech engineering org. The template must include sections for: technical impact (with measurement criteria), scope and influence, business outcomes, compliance and risk contributions, and engineer development. For each section, provide 2-3 concrete examples of what strong evidence looks like."}
  ]
}
-->

