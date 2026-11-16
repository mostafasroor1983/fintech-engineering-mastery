# Fintech Engineering Mastery: a 30-week Java/Spring curriculum for senior fintech interviews

A focused self-study program for **Senior Software Engineer** roles at large fintechs and banks:
payments, ledgers, wallets, FX, cards, reconciliation and resilience, in **Java 21 and Spring Boot 4**.
It is sized to **30 weeks × 10 hours**: a 228.5-hour main path (lessons + five capstone projects), plus
reserved time for mock interviews, review and slack.

**Start here:**

| | |
|---|---|
| 30-week study plan | [`docs/content/study-plan.md`](docs/content/study-plan.md) (generated and checked: every week ≤ 10 h) |
| Capstone projects (runnable, tested) | [`examples/`](examples/README.md): five Spring Boot 4.0.9 services, 67 tests on real PostgreSQL/Kafka/Redis |
| Interview playbook | Track 15 (`docs/content/interview/`): STAR stories, the 45-minute design round, top 60 questions, 10 mock interviews |
| First 90 days in a new job | Track 16 (`docs/content/new-job/`) |
| Review notes and decisions | [`docs/review/`](docs/review/) |

**Live site:** deploy to GitHub Pages using the instructions below, or run it locally in 10 seconds.

---

## Quick Start (Local)

```bash
# Clone the repo
git clone https://github.com/<your-username>/fintech-engineering-mastery.git
cd fintech-engineering-mastery

# Serve with any static file server — no build step required
python3 -m http.server 8080 --directory docs
# or
npx serve docs
# or
npx http-server docs -p 8080
```

Open `http://localhost:8080` in your browser.

---

## Deploy to GitHub Pages

### Automatic (recommended)

1. Push the repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, select **GitHub Actions**.
4. The workflow at `.github/workflows/deploy.yml` runs automatically on every push to `main` and publishes the `docs/` folder.
5. Your site will be live at `https://<username>.github.io/<repo-name>/`.

### Manual (branch-based)

1. Go to **Settings → Pages**.
2. Set **Source** to **Deploy from a branch**.
3. Choose branch `main`, folder `/docs`.
4. Click **Save**.

> The `docs/.nojekyll` file is already in place — this disables Jekyll and ensures `_track.json` files (which start with `_`) are served correctly.

---

## Course Structure

Each lesson is tiered **Core**, **Supporting** (together: the main path, inside the time budget) or
**Optional** (kept for depth, outside the budget; shown under "Optional" on each track page).
Track 05 (transaction integrity) is entirely Core and is studied early (weeks 3–6).

| # | Id | Track | Lessons | Main path | All lessons |
|---|----|-------|---------|-----------|-------------|
| 01 | `track-01` | Advanced Software Architecture | 20 | 9.9 h | 26.2 h |
| 02 | `track-02` | Distributed Systems Engineering | 22 | 11.2 h | 29.2 h |
| 03 | `track-03` | Concurrency & Thread Safety Engineering | 29 | 26.4 h | 38.1 h |
| 04 | `track-04` | Banking & Financial Systems Architecture | 22 | 8.6 h | 30.4 h |
| 05 | `track-05` | Financial Transaction Integrity & Ledger Engineering | 24 | 34.4 h | 34.4 h |
| 06 | `track-06` | High Availability, Reliability & Resilience | 18 | 6.5 h | 23.2 h |
| 07 | `track-07` | Performance Engineering & JVM Internals | 22 | 10.9 h | 29.0 h |
| 08 | `track-08` | Database & Data Architecture | 22 | 11.2 h | 28.9 h |
| 09 | `track-09` | Messaging, Streaming & Enterprise Integration | 20 | 8.4 h | 26.6 h |
| 10 | `track-10` | Cloud, Infrastructure & Platform Engineering | 16 | 4.2 h | 21.2 h |
| 11 | `track-11` | Security, Observability & Production Engineering | 20 | 5.4 h | 25.8 h |
| 12 | `track-12` | Staff & Principal Engineering Leadership | 14 | 6.2 h | 17.4 h |
| 13 | `track-13` | Spring Boot 4 for Senior Fintech Engineers | 8 | 9.7 h | 9.7 h |
| 14 | `track-14` | System Design for Fintech Interviews | 8 | 9.8 h | 9.8 h |
| 15 | `track-15` | Interview Playbook | 5 | 4.2 h | 4.2 h |
| 16 | `track-16` | First 90 Days | 2 | 1.6 h | 1.6 h |
| | | **Total** | **272** | **168.6 h** | **355.7 h** |

Plus **five capstone projects** (12 h each, 60 h, in the main path) and **20 Decision Lab scenarios**.

---

## Features

### Navigation
- **Hash-based routing** — all navigation uses `#/path` fragments, so every page is bookmarkable and shareable without server configuration
- **Sidebar** — collapsible track list with per-track color coding; collapse state persists via `localStorage`
- **Breadcrumb** — Dashboard → Curriculum → Track → Lesson, all clickable
- **Prev / Next** — in-lesson navigation between sequential lessons
- **Keyboard shortcuts** — `/` or `Ctrl+K` opens search from anywhere

### Content
- **Markdown lessons** — rendered client-side with `marked.js`; custom heading renderer adds anchor IDs
- **Syntax highlighting** — `Prism.js` for Java, SQL, YAML, JSON, Bash, XML
- **Mermaid diagrams** — architecture, sequence, state, and Gantt diagrams with **zoom controls** (in, out, reset, fullscreen modal)
- **Knowledge Check** — interactive multiple-choice quiz at the end of each lesson; shows correct/incorrect and explanation
- **Practical Challenge** — structured task checklist with per-item completion state persisted to `localStorage`
- **Progress tracking** — mark lessons complete; overall and per-track progress rings on the Dashboard and Curriculum pages

### Search
- **Full-text search** via `lunr.js` over 327 indexed documents (lessons, tracks, scenarios, capstones)
- Searches title (boost ×10), tags (×6), subtitle (×4), track name (×3), body text (×1)
- Results grouped by type with direct links

### Theme
- Dark mode (default) and light mode toggle — preference persisted via `localStorage`

---

## Project Layout

```
fintech-engineering-mastery/
├── docs/                              # The static site (GitHub Pages serves this folder)
│   ├── index.html, assets/            # SPA shell, CSS, JS (router, renderer, search, capstones)
│   ├── content/
│   │   ├── tracks/track-NN-*/         # _track.json (ordered lessons, tiers) + lesson-*/index.md
│   │   ├── interview/                 # Track 15 lessons (interview playbook)
│   │   ├── new-job/                   # Track 16 lessons (first 90 days)
│   │   ├── capstone/project-*/        # GENERATED from examples/*/README.md
│   │   ├── study-plan.md              # GENERATED 30-week plan
│   │   └── glossary.md                # Terms defined in the lessons
│   ├── data/                          # tracks.json, search-index.json, curriculum-index.json, capstone-projects.json
│   └── review/                        # Phase reports, corrections log, decisions, archive of replaced content
├── examples/                          # Maven multi-module project: capstones + lesson code, all tested
├── tools/
│   ├── validate_content.py            # The validator (run before every commit)
│   ├── build_capstone_pages.py        # examples/*/README.md -> capstone pages + manifests
│   ├── sync_manifest_tiers.py         # tiers -> _track.json and tracks.json totals
│   └── build_study_plan.py            # schedule -> docs/content/study-plan.md (with checks)
├── rebuild_search_index.py            # Rebuild docs/data/search-index.json
└── README.md
```

## Maintenance

```bash
python3 tools/sync_manifest_tiers.py     # after changing tiers (CORE_IDS / SUPPORTING_IDS in the validator)
python3 tools/build_capstone_pages.py    # after editing a capstone README in examples/
python3 tools/build_study_plan.py        # after changing the schedule or lesson minutes
python3 rebuild_search_index.py          # after adding or editing lessons
python3 tools/validate_content.py --verbose   # must print "All checks passed"

cd examples && mvn test                  # all modules; needs Docker (Testcontainers)
```

The validator fails if the generated files are out of date, if any week of the plan exceeds 10 hours,
if the main path exceeds 260 hours, or if any Track 05 lesson is missing.

---

## Lesson Format

Every lesson is a Markdown file with YAML frontmatter:

```markdown
---
id: track-03-lesson-29
title: "Thread-Safety Audit — Class, Module and Application Level"
slug: thread-safety-audit
track: track-03
trackName: "Concurrency & Thread Safety Engineering"
sequence: 29
difficulty: advanced
estimatedMinutes: 90
status: published
tags: [thread-safety, audit, shared-state, concurrent-design]
prerequisites: [track-03-lesson-02, track-03-lesson-07]
---

## Overview
...

<!-- KNOWLEDGE-CHECK
{"questions":[{"text":"...","options":["a","b","c","d"],"correct":1,"explanation":"..."}]}
-->

<!-- PRACTICAL-CHALLENGE
{"title":"...","difficulty":"advanced","estimatedMinutes":90,"tasks":[{"id":"1","description":"..."}]}
-->
```

**Rules for `_track.json` paths:** The `path` field in `_track.json` is the canonical path the renderer fetches. Lesson directories on disk must match it exactly:

```json
{
  "id": "track-03-lesson-29",
  "path": "content/tracks/track-03-concurrency/lesson-29-thread-safety-audit/index.md"
}
```

---

## Rebuilding the Search Index

After adding new lessons, regenerate the search index:

```bash
# Python (no dependencies)
python3 rebuild_search_index.py

# Node.js
node scripts/build-search-index.js
```

---

## CDN Dependencies

All runtime libraries are loaded from jsDelivr CDN — no npm install or bundler required:

| Library | Version | Purpose |
|---------|---------|---------|
| `marked` | 14.1.3 | Markdown → HTML |
| `js-yaml` | 4.1.0 | YAML frontmatter parsing |
| `mermaid` | 11.4.1 | Architecture and sequence diagrams |
| `prismjs` | 1.29.0 | Syntax highlighting (Java, SQL, YAML, JSON, Bash) |
| `lunr` | 2.3.9 | Full-text search index |
| `katex` | 0.16.11 | Mathematical notation (CSS; JS loaded on demand) |

The site works offline after the first load (CDN assets cached by the browser).

---

## Technology Stack

All lessons use these versions exclusively:

- **Java 17 / Java 21** — record classes, sealed interfaces, virtual threads (Project Loom), structured concurrency
- **Spring Boot 4.x / Spring Framework 7.x**
- **Apache Kafka** (Confluent, AWS MSK)
- **PostgreSQL** with `pg_partman`, `TimescaleDB`, `pgvector`
- **Redis** (Jedis, Lettuce, Redisson)
- **Kubernetes** (EKS, GKE, AKS), Istio, ArgoCD
- **JMH** (benchmarking), **jcstress** (concurrency stress tests), **Testcontainers**

---

## Browser Support

Chrome 90+, Firefox 88+, Safari 14+, Edge 90+. Requires JavaScript enabled. No IE support.

---

## License

Content is for personal educational use. Code examples are MIT licensed.
