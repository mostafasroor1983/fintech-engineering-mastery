# Engineering Mastery — Principal Engineer Program

A complete, production-grade self-study program for Staff and Principal Software Engineers in banking and FinTech. 287 lessons across 14 tracks, covering everything from JVM internals and distributed consensus to PCI DSS architecture and cross-team influence.

**Live site:** deploy to GitHub Pages using the instructions below, or run locally in 10 seconds.

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

| # | Track | Lessons | Hours |
|---|-------|---------|-------|
| 01 | Advanced Software Architecture | 20 | 30h |
| 02 | Distributed Systems Engineering | 22 | 33h |
| 03 | Concurrency & Thread Safety Engineering | 29 | 42h |
| 04 | Asynchronous & Reactive Systems Engineering | 20 | 30h |
| 05 | Banking & Financial Systems Architecture | 22 | 33h |
| 06 | Financial Transaction Integrity & Ledger Engineering | 24 | 36h |
| 07 | Financial Crime, Compliance & Risk Engineering | 18 | 27h |
| 08 | High Availability, Reliability & Resilience | 18 | 27h |
| 09 | Performance Engineering & JVM Internals | 22 | 33h |
| 10 | Database & Data Architecture | 22 | 33h |
| 11 | Messaging, Streaming & Enterprise Integration | 20 | 30h |
| 12 | Cloud, Infrastructure & Platform Engineering | 16 | 24h |
| 13 | Security, Observability & Production Engineering | 20 | 30h |
| 14 | Staff & Principal Engineering Leadership | 14 | 21h |
| | **Total** | **287 lessons** | **429 hours** |

Plus:
- **20 Decision Lab scenarios** — real-world fintech incidents (The Double Charge, The Split Brain, The Kafka Rebalance Storm, …)
- **6 Capstone Projects** — end-to-end system design and implementation

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
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions: deploy docs/ to GitHub Pages
├── docs/                        # Everything served as the static site
│   ├── .nojekyll               # Disables Jekyll (required for _track.json serving)
│   ├── index.html              # Single-page application shell
│   ├── 404.html                # GitHub Pages SPA redirect fallback
│   ├── assets/
│   │   ├── css/
│   │   │   ├── main.css        # Layout, sidebar, top bar, theme variables
│   │   │   ├── lesson.css      # Lesson page, code blocks, diagram zoom, KC/PC widgets
│   │   │   └── lab.css         # Decision Lab and Capstone styles
│   │   └── js/
│   │       ├── router.js       # Hash router (register/navigate/handle)
│   │       ├── app.js          # Bootstrap, sidebar, top bar, page renderers
│   │       ├── renderer.js     # Lesson fetch → frontmatter → markdown → DOM
│   │       ├── progress.js     # localStorage-backed lesson progress
│   │       ├── search.js       # lunr.js search index + results page
│   │       ├── lab.js          # Decision Lab scenario engine
│   │       └── capstone.js     # Capstone project viewer
│   ├── content/
│   │   └── tracks/
│   │       ├── track-01-architecture/
│   │       │   ├── _track.json         # Track metadata + ordered lesson list
│   │       │   ├── lesson-01-*/index.md
│   │       │   └── ...
│   │       └── track-14-leadership/    # (14 tracks total, 287 lesson files)
│   └── data/
│       ├── tracks.json                 # Top-level track metadata for sidebar + dashboard
│       ├── search-index.json           # Pre-built lunr document set (327 docs)
│       ├── curriculum-index.json       # Curriculum metadata summary
│       ├── decision-lab.json           # 20 lab scenario definitions
│       └── capstone-projects.json      # 6 capstone project definitions
├── scripts/
│   └── build-search-index.js           # Node script to rebuild search-index.json
├── rebuild_search_index.py             # Python script to rebuild search-index.json
└── README.md
```

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
