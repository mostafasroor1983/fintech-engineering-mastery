# Fintech Engineering Mastery: a 30-week Java/Spring curriculum for senior fintech interviews

A focused self-study program for **Senior Software Engineer** roles at large fintechs and banks:
payments, ledgers, wallets, FX, cards, reconciliation and resilience, in **Java 21 and Spring Boot 4**.
It is sized to **30 weeks × 10 hours**: a 227.8-hour main path (167.8 h of lessons + 60 h for five capstone projects), plus
reserved time for mock interviews, review and slack.

**Start here:**

| | |
|---|---|
| 30-week study plan | [`docs/content/study-plan.md`](docs/content/study-plan.md) (generated and checked: every week ≤ 10 h) |
| Capstone projects (runnable, tested) | [`examples/`](examples/README.md): five Spring Boot 4.0.9 services, 67 tests on real PostgreSQL/Kafka/Redis |
| Interview playbook | Track 15 (`docs/content/interview/`): STAR stories, the 45-minute design round, top 60 questions, 10 mock interviews |
| First 90 days in a new job | Track 16 (`docs/content/new-job/`) |
| Review notes and decisions | [`docs/review/`](docs/review/) |
| Arabic version | Every lesson, lab, capstone page, the study plan and the glossary (`*.ar.md`, `docs/data/ar/`); switch language in the site's top bar |

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

The default branch is **`v1`**. The site needs no build step: GitHub Pages serves the `docs/` folder as is.

### Branch-based (current setup)

1. Go to **Settings → Pages**.
2. Set **Source** to **Deploy from a branch**.
3. Choose branch `v1`, folder `/docs`, and click **Save**.
4. Every push to `v1` republishes the site at `https://<username>.github.io/<repo-name>/`.

### GitHub Actions (alternative)

`.github/workflows/deploy.yml` validates the content and then publishes `docs/`. It runs only when started
by hand (**Actions → Deploy to GitHub Pages → Run workflow**), so it doesn't compete with the branch-based
setup. To use it instead, set **Source** to **GitHub Actions** and add a `push: branches: [v1]` trigger
to the workflow.

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
| 14 | `track-14` | System Design for Fintech Interviews | 8 | 9.1 h | 9.1 h |
| 15 | `track-15` | Interview Playbook | 5 | 4.2 h | 4.2 h |
| 16 | `track-16` | First 90 Days | 2 | 1.6 h | 1.6 h |
| | | **Total** | **272** | **167.8 h** | **354.8 h** |

Plus **five capstone projects** (12 h each, 60 h, in the main path), **20 Decision Lab scenarios** and **25 Concurrency Lab experiments**.

---

## Features

### Navigation
- **Hash-based routing** — all navigation uses `#/path` fragments, so every page is bookmarkable and shareable without server configuration
- **Sidebar** — collapsible track list with per-track color coding; collapse state persists via `localStorage`
- **Breadcrumb** — Dashboard → Curriculum → Track → Lesson, all clickable
- **Prev / Next** — in-lesson navigation between sequential lessons
- **Keyboard shortcuts** — `/` or `Ctrl+K` opens search from anywhere
- **Study plan and glossary pages** — `#/study-plan` and `#/glossary` render `docs/content/study-plan.md` and `glossary.md` (or their Arabic versions), with repo file links turned into site links

### Content
- **Markdown lessons** — rendered client-side with `marked.js`; custom heading renderer adds anchor IDs
- **Syntax highlighting** — `Prism.js` for Java, SQL, YAML, JSON, Bash, XML
- **Mermaid diagrams** — architecture, sequence, state, and Gantt diagrams with **zoom controls** (in, out, reset, fullscreen modal)
- **Knowledge Check** — interactive multiple-choice quiz at the end of each lesson; shows correct/incorrect and explanation
- **Practical Challenge** — structured task checklist with per-item completion state persisted to `localStorage`
- **Progress tracking** — mark lessons complete; overall and per-track progress rings on the Dashboard and Curriculum pages

### Search
- **Full-text search** via `lunr.js` over 338 indexed documents (lessons, tracks, scenarios, experiments, capstones), with a separate Arabic index
- Searches title (boost ×10), tags (×6), subtitle (×4), track name (×3), body text (×1)
- Results grouped by type with direct links

### Theme and language
- Dark mode (default) and light mode toggle — preference persisted via `localStorage`
- English / Arabic switch in the top bar (right-to-left layout for Arabic); pages without an Arabic file fall back to English with a notice

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
│   │   ├── study-plan.md              # GENERATED 30-week plan (study-plan.ar.md: Arabic, also generated)
│   │   └── glossary.md                # Terms defined in the lessons (glossary.ar.md: Arabic)
│   ├── data/                          # tracks.json, search-index.json, curriculum-index.json, capstone-projects.json
│   │   └── ar/                        # Arabic versions of the data files (GENERATED by tools/i18n/build_ar_data.py)
│   └── review/                        # Phase reports, corrections log, decisions, archive of replaced content
├── examples/                          # Maven multi-module project: capstones + lesson code, all tested
├── tools/
│   ├── validate_content.py            # The validator (run before every commit)
│   ├── build_capstone_pages.py        # examples/*/README.md -> capstone pages + manifests
│   ├── sync_manifest_tiers.py         # tiers -> _track.json and tracks.json totals
│   ├── build_study_plan.py            # schedule -> docs/content/study-plan.md (with checks)
│   └── i18n/                          # Arabic: lesson assembler, data/track builders, Arabic study plan, glossary of terms
├── rebuild_search_index.py            # Rebuild docs/data/search-index.json
└── README.md
```

## Maintenance

```bash
python3 tools/sync_manifest_tiers.py     # after changing tiers (CORE_IDS / SUPPORTING_IDS in the validator)
python3 tools/build_capstone_pages.py    # after editing a capstone README in examples/
python3 tools/build_study_plan.py        # after changing the schedule or lesson minutes
python3 tools/i18n/build_study_plan_ar.py  # after build_study_plan.py (Arabic plan)
python3 rebuild_search_index.py          # after adding or editing lessons
python3 tools/i18n/build_ar_data.py      # after the line above (Arabic search index and data)
python3 tools/validate_content.py --verbose   # must print "All checks passed"
python3 tools/site_check.py               # every page in headless Chrome (EN + AR): zero console errors, all diagrams render
python3 tools/check_code_blocks.py        # parse every code block (Java, SQL, YAML, JSON, Bash, properties); needs pip install -r tools/requirements.txt
python3 tools/responsive_check.py         # 14 device classes (320px to 3440px, touch, landscape), EN/AR, dark/light: overflow, 44px targets, 12px text, contrast; needs pip install playwright

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

After adding or editing lessons, regenerate the search indexes (English, then Arabic):

```bash
python3 rebuild_search_index.py          # docs/data/search-index.json (no dependencies)
python3 tools/i18n/build_ar_data.py      # docs/data/ar/search-index.json and the other Arabic data
```

The validator fails if a lesson's text in `search-index.json` no longer matches the lesson file.

---

## CDN Dependencies

All runtime libraries are loaded from jsDelivr CDN — no npm install or bundler required:

| Library | Version | Purpose |
|---------|---------|---------|
| `marked` | 14.1.3 | Markdown → HTML |
| `js-yaml` | 4.1.0 | YAML frontmatter parsing |
| `mermaid` | 11.4.1 | Architecture and sequence diagrams (loaded only when a page has a diagram) |
| `prismjs` | 1.29.0 | Syntax highlighting; the autoloader fetches each language on first use |
| `lunr` | 2.3.9 | Full-text search index |

Every CDN script is pinned to an exact version and checked with a Subresource Integrity (SRI) hash.
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
