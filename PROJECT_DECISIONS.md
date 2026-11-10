# PROJECT DECISIONS — Engineering Mastery

**Project:** Engineering Mastery — Principal Software Engineer Development Program  
**Version:** 1.0  
**Date:** 2026-11-07  
**Status:** Approved Architecture

---

## ADR-001 — Static Website Only

**Decision:** The website is a fully static site: HTML5, CSS3, and Vanilla JavaScript only.

**Rationale:** Personal educational use. No multi-user requirements. No backend needed. GitHub Pages compatible. Zero infrastructure cost and operational complexity.

**Consequences:** No server-side rendering, no authentication, no database queries at runtime. All dynamic behavior handled client-side via JavaScript and LocalStorage.

**Rejected alternatives:** React/Next.js SPA, Spring Boot backend, WordPress CMS.

---

## ADR-002 — Hash-Based Client-Side Routing

**Decision:** Navigation uses hash-based URLs (`#/tracks/03/lessons/07`) with a custom vanilla JS router.

**Rationale:** GitHub Pages does not support server-side URL rewriting. Hash routing works without a server and requires no build tooling.

**Consequences:** URLs contain `#`. Deep links work correctly. Browser back/forward buttons work via `hashchange` events.

**Rejected alternatives:** History API routing (requires server rewrite rules), no routing (full page reloads).

---

## ADR-003 — Markdown-Based Lesson Content

**Decision:** All lesson content is authored in Markdown with YAML frontmatter. Files are fetched at runtime and rendered via `marked.js`.

**Rationale:** Markdown is easy to author, review in Git, and diff. Separates content from presentation. Enables future tooling (search indexers, validators, exporters).

**Consequences:** Lessons are plain `.md` files. A runtime fetch is required per lesson load. No offline support unless a service worker is added later.

**Rejected alternatives:** HTML lesson files (harder to author/maintain), JSON content (verbose, not human-friendly).

---

## ADR-004 — LocalStorage for Progress Tracking

**Decision:** Learner progress is persisted exclusively in `localStorage` under the key `em_progress`.

**Rationale:** No authentication or backend. Single-learner use. LocalStorage is universally available, requires zero infrastructure, and survives browser restarts.

**Consequences:** Progress is per-browser and not synced across devices. Clearing browser data resets progress. Export-to-JSON feature should be added for backup.

**Rejected alternatives:** IndexedDB (unnecessary complexity for this scale), cookies (size limits, expiry), remote storage (requires backend).

---

## ADR-005 — lunr.js for Client-Side Search

**Decision:** Full-text search is powered by `lunr.js` loading a pre-built `search-index.json`.

**Rationale:** No server required. lunr.js is well-proven for static sites. Pre-building the index at content-generation time means instant search with no runtime indexing cost.

**Consequences:** Search index must be regenerated when content is added or changed. Index file size grows with content volume (expected manageable for 14 tracks × ~20 lessons).

**Rejected alternatives:** Algolia (external dependency/cost), browser `Ctrl+F` only (not structured), real-time indexing (slow on initial load).

---

## ADR-006 — Mermaid.js for Architecture and Sequence Diagrams

**Decision:** All diagrams in lessons are authored as Mermaid code blocks in Markdown and rendered at runtime via `mermaid.js`.

**Rationale:** Diagrams remain version-controlled as text in Markdown. No external diagram hosting. Mermaid supports flowcharts, sequence diagrams, ER diagrams, and state machines — all needed for financial systems content.

**Consequences:** Diagram rendering is client-side. Authors must learn Mermaid DSL. Complex diagrams may hit Mermaid rendering limits.

**Rejected alternatives:** PNG/SVG image files (not version-controllable as text, harder to edit), draw.io embeds (external dependency), PlantUML (requires server-side rendering).

---

## ADR-007 — Prism.js for Syntax Highlighting

**Decision:** Code blocks use `prism.js` for syntax highlighting.

**Rationale:** Lightweight, works with Markdown-rendered `<pre><code>` blocks, supports Java, SQL, YAML, JSON, XML, Bash — all required languages.

**Consequences:** Prism must be initialized after Markdown rendering completes (post-fetch hook).

---

## ADR-008 — KaTeX for Mathematical Notation

**Decision:** Mathematical notation (Amdahl's Law, latency percentiles, probability calculations) is rendered via `KaTeX`, loaded only on lessons that require it.

**Rationale:** KaTeX is faster than MathJax and renders server-side compatible CSS. Mathematical content is limited to performance and reliability tracks.

**Consequences:** Lessons with math must declare `katex: true` in frontmatter so the loader can conditionally include the library.

---

## ADR-009 — Lesson Content Schema with YAML Frontmatter

**Decision:** Every lesson `.md` file begins with a YAML frontmatter block containing standardized metadata fields (see Content Schema section in PLAN.md).

**Rationale:** Enables automated search index generation, curriculum navigation, prerequisite resolution, and progress tracking without a database.

**Consequences:** Authors must follow the schema strictly. A frontmatter validator script is part of the testing strategy.

---

## ADR-010 — Decision Lab as Pure Client-Side JSON State Machine

**Decision:** The Principal Engineer Decision Lab loads scenario definitions from JSON files and runs a multi-stage state machine (Context → Analysis → Decision → Evaluation → Rubric) entirely in the browser.

**Rationale:** No backend required. Scenarios are version-controlled JSON. The rubric deliberately avoids single-answer scoring to reflect real Staff/Principal engineering trade-off analysis.

**Consequences:** No adaptive personalization beyond the current session. No server-side answer recording.

---

## ADR-011 — No Build Step Required for Core Function

**Decision:** The website functions without a build or compilation step. The optional build script (`scripts/build-search-index.js`) generates `search-index.json` but is not required for page rendering.

**Rationale:** Simplicity. GitHub Pages serves static files directly. Authors can add content and see results without running any toolchain.

**Consequences:** No minification or bundling by default. Performance optimization (bundling, compression) can be added via GitHub Actions if needed.

---

## ADR-012 — GitHub Pages Deployment via /docs Folder

**Decision:** The site is deployed from the `main` branch `/docs` folder, not a separate `gh-pages` branch.

**Rationale:** Keeping deployable content in `main` avoids branch management complexity. The `/docs` folder convention is natively supported by GitHub Pages.

**Consequences:** All deliverable web content lives under `/docs`. The root of the repo contains reference documents and tooling.

---

## ADR-013 — Java Code Examples: Dual-Version Tabs (17 and 21)

**Decision:** Lessons covering Java implementations present Java 17 and Java 21 versions in switchable tab components, not duplicate prose.

**Rationale:** The reference specification requires both versions be explained for every relevant topic. Tabs avoid duplicate scrolling and allow direct comparison.

**Consequences:** The lesson markdown must use a custom fenced block convention (e.g., ` ```java17 ` and ` ```java21 `) that the renderer detects and converts to tab UI components.

---

## ADR-014 — Financial Correctness Over Performance

**Decision:** When content presents trade-offs between financial correctness and throughput, correctness is always the recommended default, with performance optimization as a secondary concern documented separately.

**Rationale:** Directly mandated by the reference specification. Reflects real Staff/Principal engineering judgment in banking and FinTech institutions.

---

## ADR-015 — No Preview Java Features as Production Defaults

**Decision:** Java preview features (e.g., features that were preview in Java 17 or 21) are documented as preview only. Production implementation guidance uses only GA features.

**Rationale:** Reference specification explicitly requires this distinction. Prevents learners from deploying unstable APIs in production financial systems.

---

## ADR-016 — Content-First Phased Delivery (Tracks 3, 6, 5 First)

**Decision:** Content delivery prioritizes Track 3 (Concurrency), Track 6 (Financial Transaction Integrity), and Track 5 (Banking Systems) before the remaining tracks.

**Rationale:** The reference specification identifies concurrency, financial integrity, and thread safety as the core competency differentiators for Staff/Principal engineers in banking. Delivering these first provides the most immediate value.

---

## Change Log

| Version | Date       | Change                              | Author    |
|---------|------------|-------------------------------------|-----------|
| 1.0     | 2026-11-07 | Initial architecture decisions      | Architect |
