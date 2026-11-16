#!/usr/bin/env python3
"""Generate docs/content/study-plan.md from a week-by-week schedule and verify it.

Checks (exit 1 on failure):
  * every week <= 600 minutes (10 h)
  * every main-path lesson (Core, Supporting, new-content tracks) is scheduled exactly once
  * no Optional lesson is scheduled in the main plan
  * all 24 Track 05 lessons are scheduled, within 4 consecutive weeks, starting by week 4
  * each capstone is scheduled after the lessons it depends on
  * a checkpoint ends every 4th week of the main plan (weeks 4, 8, ..., 24)

Usage: python3 tools/build_study_plan.py [--check]
"""
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
OUT = os.path.join(DOCS, "content", "study-plan.md")
WEEK_CAP = 600

spec = importlib.util.spec_from_file_location("validator", os.path.join(ROOT, "tools", "validate_content.py"))
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)


def L(track, *nums):
    return [f"track-{track:02d}-lesson-{n:02d}" for n in nums]


def CAP(n, part):
    return ("capstone", n, part)


def ACT(name, minutes, link=None):
    return ("activity", name, minutes, link)


CHECK = lambda n: ACT(f"Checkpoint {n}: timed quiz or design exercise on weeks {4 * n - 3}-{4 * n} (closed book, then mark against the lessons)", 60)

CAPSTONE_MIN = {"part1": 360, "part2": 360}
CAPSTONES = {
    1: ("Payment service (idempotency, outbox, Kafka)", "payment-service",
        L(5, 3, 7, 8, 12, 13) + L(9, 1, 3)),
    2: ("Wallet on a double-entry ledger, with FX", "wallet-ledger",
        L(5, 1, 2, 5, 17, 22) + L(4, 3)),
    3: ("Card authorisation and clearing", "card-authorisation",
        L(6, 2, 3, 5) + L(5, 16)),
    4: ("Settlement and reconciliation (camt.053)", "settlement-reconciliation",
        L(4, 7) + L(5, 10, 22)),
    5: ("Instant P2P API (OAuth2, rate limits, webhooks)", "instant-p2p",
        L(11, 10) + L(6, 4)),
}

# Each week: (theme, exercise, deliverable, items). Items are lesson ids, CAP(...) or ACT(...).
WEEKS = [
    ("Diagnostic + databases",
     "Self-assess against the competency matrix (0-3 per row), then run the isolation-level examples in psql.",
     "Your scored competency matrix; notes on which anomalies READ COMMITTED allows.",
     [ACT("Diagnostic: score yourself 0-3 on each competency in the target profile; mark the weakest five", 90,
          "review/00-target-profile.md")] + L(8, 1, 2, 3, 4) + L(3, 1)),
    ("Concurrency foundations",
     "Reproduce a lost update with two threads, then fix it two ways (lock, atomic).",
     "A failing-then-passing race test in your own repo.",
     L(3, 2, 3, 4, 6, 7, 8)),
    ("Transaction integrity I: ledger and scenarios A-E",
     "Run each scenario's failure lab, then its fix, with tests.",
     "Scenario A-E labs green; one-page ledger invariants sheet.",
     L(5, 1, 2, 3, 4, 5, 6)),
    ("Transaction integrity II: scenarios F-J",
     "Run the dual-write, duplicate-delivery and reconciliation labs.",
     "Labs green; checkpoint 1 marked.",
     L(5, 7, 8, 9, 10, 11) + [CHECK(1)]),
    ("Transaction integrity III: patterns",
     "Implement an idempotency table and an outbox poller by hand (no framework).",
     "Both patterns working with a concurrency test.",
     L(5, 12, 13, 14, 15, 16, 17)),
    ("Transaction integrity IV: event sourcing, CQRS, audit",
     "Write the decision table: which pattern for which payment problem, and why.",
     "Your Track 05 decision table (one page).",
     L(5, 18, 19, 20, 21, 22, 23, 24)),
    ("Kafka core + Spring Boot 4 basics",
     "Run a producer with acks=all and kill a broker; consume with manual commits.",
     "Notes: what was lost or duplicated in each setting.",
     L(9, 1, 2, 3, 5, 6) + L(13, 1)),
    ("Spring for messaging; capstone 1 starts",
     "Capstone 1 steps 1-3 (schema, failing concurrency test, idempotency).",
     "Idempotency tests green; checkpoint 2 marked.",
     L(13, 2, 6) + [CAP(1, "part1"), CHECK(2)]),
    ("Capstone 1 finish + testing",
     "Capstone 1 steps 4-6 (outbox, consumer, DLT, load test).",
     "Capstone 1 complete: 13 tests green, README numbers from your machine.",
     [CAP(1, "part2")] + L(13, 8) + L(9, 15)),
    ("Banking domain I",
     "Draw the money flow of a card payment and a bank transfer end to end.",
     "Two flow diagrams with every party and message.",
     L(4, 1, 2, 3, 5) + L(13, 4) + L(8, 5)),
    ("Capstone 2 starts",
     "Capstone 2 steps 1-3 (ledger, ordered locking, deadlock test).",
     "Concurrency and deadlock tests green.",
     [CAP(2, "part1")] + L(8, 9) + L(3, 21)),
    ("Capstone 2 finish + ISO 20022",
     "Capstone 2 steps 4-6 (DB invariants, FX, reconciliation).",
     "Capstone 2 complete; checkpoint 3 marked.",
     [CAP(2, "part2"), CHECK(3)] + L(4, 7)),
    ("Resilience",
     "Add a timeout, retry with jitter and a circuit breaker around a flaky HTTP stub.",
     "A test showing each pattern change the failure behaviour.",
     L(6, 1, 2, 3, 4, 5) + L(3, 10) + L(12, 11)),
    ("Async Java and virtual threads",
     "Rewrite a fan-out with CompletableFuture, then with virtual threads; compare.",
     "Benchmark notes and a pinning check on your JDK.",
     L(3, 11, 12, 13, 14) + L(13, 3) + L(7, 14) + L(12, 7)),
    ("Capstone 3 starts",
     "Capstone 3 steps 1-3 (state machine, concurrent captures).",
     "State-machine and concurrency tests green.",
     [CAP(3, "part1")] + L(13, 7) + L(3, 20)),
    ("Capstone 3 finish",
     "Capstone 3 steps 4-6 (fraud hook: timeout, breaker, bulkhead).",
     "Capstone 3 complete; checkpoint 4 marked.",
     [CAP(3, "part2"), CHECK(4)] + L(3, 16)),
    ("Payments rails + databases at scale",
     "Explain Faster Payments/SEPA Instant settlement to a friend in 3 minutes.",
     "A comparison table: batch vs instant rails.",
     L(4, 8) + L(8, 7, 11) + L(2, 1, 2) + L(3, 5) + L(12, 9)),
    ("Capstone 4 starts",
     "Capstone 4 steps 1-3 (parser, matcher, ingest).",
     "Parser (incl. XXE) and matcher tests green.",
     [CAP(4, "part1")] + L(3, 18) + L(7, 7)),
    ("Capstone 4 finish + distributed transactions",
     "Capstone 4 steps 4-6 (workflow, auto-resolve, load test).",
     "Capstone 4 complete.",
     [CAP(4, "part2")] + L(2, 6, 9)),
    ("Security and observability",
     "Secure an endpoint with JWT scopes and add one trace and one metric.",
     "A working resource server; checkpoint 5 marked; first 3 STAR stories written.",
     L(11, 10, 1, 3, 5) + [CHECK(5)] + L(13, 5) + L(15, 1) + L(12, 3)),
    ("Distributed systems depth",
     "Whiteboard split-brain and a fencing-token fix.",
     "One-page failure-mode table for a leader-based service.",
     L(2, 4, 10, 14, 16) + L(1, 14) + L(3, 27) + L(12, 5)),
    ("Capstone 5 starts",
     "Capstone 5 steps 1-3 (security, transfers, token bucket).",
     "Security and rate-limit tests green.",
     [CAP(5, "part1")] + L(7, 1, 3) + L(15, 4)),
    ("Capstone 5 finish + profiling",
     "Capstone 5 steps 4-6 (webhooks, SSRF, load test). Profile one capstone with async-profiler or JFR.",
     "Capstone 5 complete; a flame graph with one finding.",
     [CAP(5, "part2")] + L(7, 4, 5) + L(15, 3)),
    ("System design I",
     "Do problems from lessons 2-5 on paper under the 45-minute plan.",
     "Four timed designs; checkpoint 6 marked.",
     L(14, 1, 2, 3, 4, 5) + [CHECK(6)] + L(7, 8) + L(15, 2)),
    ("System design II + architecture",
     "Two more timed designs; review your weakest RESHADED step.",
     "Design notes with a failure table for each.",
     L(14, 6, 7, 8) + L(1, 4, 5, 7) + L(7, 15)),
    ("Architecture + platform",
     "Write one ADR for a decision in one of your capstones.",
     "An ADR committed next to the capstone.",
     L(1, 6, 8, 9) + L(10, 1, 4, 9) + L(3, 29)),
    # Weeks 27-30: the reserved mock-interview, review and application time (outside the lesson budget,
    # except the two short reading items).
    ("Mock interviews I + portfolio",
     "Mocks 1-3 (design). Score from the recording; redo below-3 dimensions.",
     "Three scored rubrics; capstone READMEs polished; GitHub profile pinned to the 5 capstones.",
     L(15, 5) + [ACT("Mock interviews 1-3 (45 min each, recorded)", 135),
                 ACT("Review weak areas found in the mocks (re-read linked lessons)", 180),
                 ACT("Portfolio polish: README numbers from your machine, repo description, pinned repos", 150)]),
    ("Mock interviews II + applications",
     "Mocks 4-6 (design + 2 coding).",
     "Three scored rubrics; a tailored CV; first applications sent.",
     [ACT("Mock interviews 4-6", 135),
      ACT("Review weak areas", 200),
      ACT("Applications: tailor CV bullets to each job post (link the capstone that proves each skill)", 120)]),
    ("Mock interviews III",
     "Mocks 7-9 (two deep dives + behavioural); redo the two weakest mocks.",
     "All mocks >= 3 in every dimension, or a redo scheduled.",
     [ACT("Mock interviews 7-9", 135),
      ACT("Redo the two weakest mocks (with a variation)", 90),
      ACT("Review weak areas", 180),
      ACT("Applications and recruiter calls", 120)]),
    ("Final mock + first-90-days prep",
     "Mock 10 (present a capstone); read the first-90-days lessons.",
     "Your 10-minute capstone talk, rehearsed; a 30/60/90 draft for your next job.",
     [ACT("Mock interview 10: capstone presentation", 30)] + L(16, 1, 2) +
     [ACT("Final review of your weakest five competencies", 180),
      ACT("Applications and interviews", 120)]),
]

FALLING_BEHIND = [
    ("Databases + concurrency essentials", L(8, 1, 2, 3, 4) + L(3, 1, 3)),
    ("Races, deadlocks, virtual threads; ledger", L(3, 7, 8, 12, 20) + L(5, 1, 2)),
    ("Transaction integrity I", L(5, 3, 4, 5, 6, 7, 8)),
    ("Transaction integrity II", L(5, 10, 11, 12, 13, 14) + [ACT("Checkpoint (timed quiz)", 60)]),
    ("Transaction integrity III + Kafka", L(5, 16, 17, 22) + L(9, 1, 3, 5) + L(13, 1)),
    ("Capstone 1 (first half) + security, payments", [CAP(1, "part1")] + L(11, 10) + L(4, 2)),
    ("Capstone 1 (second half) + resilience", [CAP(1, "part2")] + L(6, 2, 4)),
    ("Capstone 2 (first half)", [CAP(2, "part1")] + L(6, 5) + L(2, 1)),
    ("Capstone 2 (second half)", [CAP(2, "part2")] + L(2, 9) + L(7, 14) + [ACT("Checkpoint (timed quiz)", 60)]),
    ("System design", L(14, 1, 2, 3, 5, 6) + [ACT("Mock interview 1 (design)", 45)]),
    ("Interview playbook", L(15, 1, 2, 3, 4, 5) + [ACT("Mock interviews 5 and 9 (coding + behavioural)", 90),
                                                ACT("Review weak areas", 120)]),
    ("Mocks + review", [ACT("Mock interviews 7 and 10 (deep dive + capstone talk)", 75),
                        ACT("Review weak areas", 240), ACT("Checkpoint (timed design exercise)", 60)]),
]

READ_IF_TIME = [
    ("track-04-lesson-18", "Card payment processing: directly supports capstone 3."),
    ("track-04-lesson-12", "Reconciliation architecture: context for capstone 4."),
    ("track-04-lesson-10", "FX systems: context for capstone 2's FX transfers."),
    ("track-09-lesson-11", "Dead letter queues: poison messages, used in capstone 1."),
    ("track-09-lesson-18", "Message ordering: a frequent Kafka follow-up question."),
    ("track-02-lesson-17", "Distributed rate limiting: the theory behind capstone 5."),
    ("track-11-lesson-13", "OWASP Top 10 for financial services."),
    ("track-11-lesson-11", "API security: validation, rate limiting, WAF."),
    ("track-06-lesson-15", "Incident management: strong material for behavioural stories."),
    ("track-06-lesson-16", "Post-incident reviews: blameless culture and RCA."),
    ("track-06-lesson-10", "Health checks and probes: Kubernetes readiness for Spring services."),
    ("track-08-lesson-10", "Connection pooling: HikariCP limits with virtual threads."),
    ("track-08-lesson-16", "Query plans: EXPLAIN ANALYZE in practice."),
    ("track-03-lesson-25", "Context propagation: MDC/trace context across async boundaries."),
    ("track-03-lesson-15", "Scoped values: the ThreadLocal successor (final in JDK 25)."),
    ("track-12-lesson-04", "ADRs in practice: complements the RFC lesson."),
    ("track-01-lesson-02", "ADR practice: writing decisions down."),
    ("track-10-lesson-03", "Kubernetes workloads: deeper platform knowledge."),
]


CAPSTONE_FOLDERS = {1: "capstone/project-a-payment-platform", 2: "capstone/project-b-ledger-engine",
                    3: "capstone/project-c-card-authorisation", 4: "capstone/project-d-reconciliation-engine",
                    5: "capstone/project-e-instant-p2p"}


def rel(path):
    """Manifest paths are relative to docs/; the plan lives in docs/content/."""
    return path[len("content/"):] if path.startswith("content/") else "../" + path


def load_lessons():
    lessons = {}
    tracks = {}
    base = os.path.join(DOCS, "content", "tracks")
    for folder in sorted(os.listdir(base)):
        path = os.path.join(base, folder, "_track.json")
        if not os.path.isfile(path):
            continue
        data = json.load(open(path))
        tracks[data["id"]] = data
        for l in data["lessons"]:
            lessons[l["id"]] = dict(l, track=data["id"], trackTitle=data.get("shortTitle") or data["title"])
    return lessons, tracks


def item_minutes(item, lessons):
    if isinstance(item, str):
        return lessons[item]["estimatedMinutes"]
    if item[0] == "capstone":
        return CAPSTONE_MIN[item[2]]
    return item[2]


def item_md(item, lessons):
    if isinstance(item, str):
        l = lessons[item]
        tier = l.get("tier", "")
        return (f"[{l['trackTitle']} L{l['sequence']:02d}: {l['title']}]({rel(l['path'])})"
                f" · {l['estimatedMinutes']} min{' · ' + tier if tier else ''}")
    if item[0] == "capstone":
        title, slug, _ = CAPSTONES[item[1]]
        half = "steps 1-3" if item[2] == "part1" else "steps 4-6"
        return f"[Capstone {item[1]}: {title}]({CAPSTONE_FOLDERS[item[1]]}/index.md) ({half}) · {CAPSTONE_MIN[item[2]]} min"
    name, minutes, link = item[1], item[2], item[3]
    return f"{name} · {minutes} min"


def verify(lessons):
    errors = []
    main_ids = {lid for lid, l in lessons.items() if l.get("tier") in ("core", "supporting")}
    seen = {}
    first_week = {}
    for w, (_, _, _, items) in enumerate(WEEKS, 1):
        total = sum(item_minutes(i, lessons) for i in items)
        if total > WEEK_CAP:
            errors.append(f"Week {w}: {total} min > {WEEK_CAP}")
        for i in items:
            if isinstance(i, str):
                if i not in lessons:
                    errors.append(f"Week {w}: unknown lesson {i}")
                    continue
                if i in seen:
                    errors.append(f"{i} scheduled twice (weeks {seen[i]} and {w})")
                seen[i] = w
                if lessons[i].get("tier") == "optional":
                    errors.append(f"Week {w}: optional lesson {i} in the main plan")
            elif i[0] == "capstone":
                first_week.setdefault(i[1], w)
                for dep in CAPSTONES[i[1]][2]:
                    if seen.get(dep, 99) >= w:
                        errors.append(f"Capstone {i[1]} in week {w} before prerequisite {dep}")
    missing = sorted(main_ids - set(seen))
    if missing:
        errors.append(f"Main-path lessons not scheduled: {missing}")
    t06_weeks = sorted({seen[i] for i in seen if i.startswith("track-05")})
    t06_count = len([i for i in seen if i.startswith("track-05")])
    if t06_count != 24 or t06_weeks[-1] - t06_weeks[0] > 3 or t06_weeks[0] > 4:
        errors.append(f"Track 05: {t06_count} lessons in weeks {t06_weeks} (need all 24 in 4 consecutive weeks from week <= 4)")
    for w in range(4, 25, 4):
        if not any(not isinstance(i, str) and i[0] == "activity" and i[1].startswith("Checkpoint")
                   for i in WEEKS[w - 1][3]):
            errors.append(f"Week {w}: no checkpoint")
    fb_total = sum(item_minutes(i, lessons) for _, items in FALLING_BEHIND for i in items)
    for n, (_, items) in enumerate(FALLING_BEHIND, 1):
        t = sum(item_minutes(i, lessons) for i in items)
        if t > WEEK_CAP:
            errors.append(f"Falling-behind week {n}: {t} min > {WEEK_CAP}")
    for lid, _ in READ_IF_TIME:
        if lessons.get(lid, {}).get("tier") != "optional":
            errors.append(f"Read-if-time item {lid} is not an Optional lesson")
    return errors, fb_total


def render(lessons):
    weekly = [sum(item_minutes(i, lessons) for i in items) for (_, _, _, items) in WEEKS]
    lesson_min = sum(item_minutes(i, lessons) for (_, _, _, items) in WEEKS[:26] for i in items if isinstance(i, str))
    lesson_min += sum(item_minutes(i, lessons) for (_, _, _, items) in WEEKS[26:] for i in items if isinstance(i, str))
    cap_min = sum(item_minutes(i, lessons) for (_, _, _, items) in WEEKS for i in items
                  if not isinstance(i, str) and i[0] == "capstone")
    act_min = sum(weekly) - lesson_min - cap_min
    _, fb_total = verify(lessons)
    out = []
    out.append("""---
id: "study-plan"
title: "30-Week Study Plan (10 hours per week)"
lastUpdated: "2026-11-13"
---
<!-- GENERATED by tools/build_study_plan.py. Edit the schedule in that script, then re-run it. -->

# 30-Week Study Plan

**Budget:** 30 weeks × 10 h = 300 h. Weeks 1–26 hold the main path (every Core and Supporting lesson and
all five capstones), plus a diagnostic and six checkpoints. Weeks 27–30 are the reserved time for mock
interviews, review, portfolio polish and applications. Every week is at most 10 hours. Most weeks are
below that on purpose: the spare time is your slack for missed sessions.

""")
    out.append("| | Hours |\n|---|---|\n")
    out.append(f"| Lessons (main path) | {lesson_min / 60:.1f} |\n")
    out.append(f"| Capstones (5 × 12 h) | {cap_min / 60:.1f} |\n")
    out.append(f"| Diagnostic, checkpoints, mocks, review, portfolio, applications | {act_min / 60:.1f} |\n")
    out.append(f"| **Scheduled total** | **{sum(weekly) / 60:.1f}** of 300 |\n")
    out.append(f"| Unscheduled slack | {300 - sum(weekly) / 60:.1f} |\n\n")
    out.append("""**How to use it:** do the lessons in order inside a week. Each lesson's minutes already include reading,
running the code, the exercises and answering the interview questions aloud. Track progress in the site.
If you fall behind, see the falling-behind plan below below.

**Track 05 (transaction integrity)** is weeks 3–6: four full weeks, early, because the Spring,
messaging, capstone and system-design work all build on it.

""")
    out.append("## Week by week\n\n")
    out.append("| Week | Theme | Minutes |\n|---|---|---|\n")
    for w, ((theme, _, _, _), m) in enumerate(zip(WEEKS, weekly), 1):
        out.append(f"| {w} | {theme} | {m} ({m / 60:.1f} h) |\n")
    out.append("\n")
    for w, ((theme, exercise, deliverable, items), m) in enumerate(zip(WEEKS, weekly), 1):
        out.append(f"### Week {w}: {theme} ({m} min, {m / 60:.1f} h)\n\n")
        for i in items:
            out.append(f"- {item_md(i, lessons)}\n")
        out.append(f"\n**Exercise:** {exercise}  \n**Deliverable:** {deliverable}\n\n")
    out.append("## Falling-behind plan\n\n")
    out.append(f"""The minimum path that still covers every high-weight competency in about 12 weeks
({fb_total / 60:.0f} h, at most 10 h a week). It keeps capstones 1 and 2 only.

| Week | Focus | Minutes |\n|---|---|---|\n""")
    for n, (focus, items) in enumerate(FALLING_BEHIND, 1):
        out.append(f"| {n} | {focus} | {sum(item_minutes(i, lessons) for i in items)} |\n")
    out.append("\n")
    for n, (focus, items) in enumerate(FALLING_BEHIND, 1):
        out.append(f"**Week {n}: {focus}**\n\n")
        for i in items:
            out.append(f"- {item_md(i, lessons)}\n")
        out.append("\n")
    out.append("""### If you miss weeks in the full plan, skip in this order

1. Capstone 5 (instant P2P): frees 12 h.
2. Capstone 4 (reconciliation): frees 12 h.
3. Capstone 3 (card authorisation): frees 12 h.
4. Supporting lessons (marked *supporting*): read their summaries only.
5. Never skip Track 05, capstones 1–2, the system-design lessons or the mock interviews.

## Read if time allows (Optional lessons, by value)

These are outside the 300-hour budget. Pick them up only after the week's main work is done.

""")
    for n, (lid, why) in enumerate(READ_IF_TIME, 1):
        l = lessons[lid]
        out.append(f"{n}. [{l['trackTitle']} L{l['sequence']:02d}: {l['title']}]({rel(l['path'])})"
                   f" ({l['estimatedMinutes']} min): {why}\n")
    out.append("\n## See also\n\n- [Interview playbook](interview/01-star-stories/index.md)\n"
               "- [Capstone source code](../../examples/README.md)\n"
               "- [Competency matrix and target profile](../review/00-target-profile.md)\n")
    return "".join(out)


def main():
    check = "--check" in sys.argv
    lessons, _ = load_lessons()
    errors, _ = verify(lessons)
    if errors:
        print("Study plan errors:", *errors, sep="\n  ")
        sys.exit(1)
    text = render(lessons)
    old = open(OUT).read() if os.path.exists(OUT) else None
    if check:
        if old != text:
            print("study-plan.md out of date: run tools/build_study_plan.py")
            sys.exit(1)
        print("Study plan OK.")
        return
    open(OUT, "w").write(text)
    print("Wrote", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    main()
