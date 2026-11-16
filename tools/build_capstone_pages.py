#!/usr/bin/env python3
"""Generate the capstone pages of the site from the capstone READMEs in examples/.

Single source of truth: examples/<module>/README.md (what a recruiter sees on GitHub).
This script writes, for each capstone:
  * docs/content/capstone/<folder>/index.md  (front matter + README with links rewritten)
  * its entry in docs/data/capstone-projects.json
  * its entry in docs/data/curriculum-index.json (capstoneProjects)
  * its document in docs/data/search-index.json (type "capstone")

Link rewriting:
  * ../../docs/content/tracks/<track-folder>/<lesson-folder>/index.md  ->  #/tracks/<track-id>/lessons/<lesson-id>
    (resolved through each track's _track.json; an unresolved link is an error)
  * other relative links (code, sibling READMEs)                        ->  GitHub blob/tree URL

Usage:  python3 tools/build_capstone_pages.py [--check]
  --check  exit 1 if any generated file would change (use in CI / the validator).
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
EXAMPLES = os.path.join(ROOT, "examples")
GITHUB = "https://github.com/mostafasroor1983/fintech-engineering-mastery"
BRANCH = "v1"
HOURS_EACH = 12

CAPSTONES = [
    {
        "id": "project-a", "sequence": 1, "folder": "project-a-payment-platform",
        "module": "capstone-1-payment-service", "slug": "payment-service",
        "title": "Payment Service with Idempotency, Transactional Outbox and Kafka",
        "shortTitle": "Payment Service", "color": "#6366f1", "colorMuted": "rgba(99, 102, 241, 0.15)",
        "description": "A payment API that never takes a payment twice and never loses the event that tells settlement about it.",
        "objectives": [
            "Make POST /payments idempotent under concurrent retries",
            "Solve the dual-write problem with a transactional outbox",
            "Consume at-least-once events idempotently, with a dead-letter topic",
        ],
        "techStack": ["Java 21", "Spring Boot 4.0", "PostgreSQL 17", "Kafka 4.1", "Testcontainers 2"],
        "tracks": ["track-05", "track-09", "track-13", "track-14"],
        "tags": ["payments", "idempotency", "outbox", "kafka", "dead-letter-topic"],
    },
    {
        "id": "project-b", "sequence": 2, "folder": "project-b-ledger-engine",
        "module": "capstone-2-wallet-ledger", "slug": "wallet-ledger",
        "title": "Multi-Currency Wallet on a Double-Entry Ledger, with FX Transfers",
        "shortTitle": "Wallet + Ledger", "color": "#ef4444", "colorMuted": "rgba(239, 68, 68, 0.15)",
        "description": "Wallets that cannot overdraw, deadlock or drift from the ledger, including GBP to EUR transfers at a quoted rate.",
        "objectives": [
            "Post balanced journal entries with ordered pessimistic locking",
            "Enforce ledger invariants in the database (balance, append-only)",
            "Model a 4-leg FX transfer and reconcile balances against postings",
        ],
        "techStack": ["Java 21", "Spring Boot 4.0", "PostgreSQL 17", "Hibernate 7", "Testcontainers 2"],
        "tracks": ["track-05", "track-04", "track-08"],
        "tags": ["ledger", "double-entry", "fx", "locking", "reconciliation"],
    },
    {
        "id": "project-c", "sequence": 3, "folder": "project-c-card-authorisation",
        "module": "capstone-3-card-authorisation", "slug": "card-authorisation",
        "title": "Card Authorisation and Clearing with a Fraud Hook and Resilience",
        "shortTitle": "Card Authorisation", "color": "#10b981", "colorMuted": "rgba(16, 185, 129, 0.15)",
        "description": "Authorise, capture, reverse, refund and charge back card payments, with a fraud check protected by timeout, circuit breaker and bulkhead.",
        "objectives": [
            "Implement the card lifecycle as a state machine over sealed types",
            "Protect concurrent captures with optimistic locking and @Retryable",
            "Call a fraud engine with timeout, circuit breaker, bulkhead and an explicit fallback",
        ],
        "techStack": ["Java 21", "Spring Boot 4.0", "Spring Framework 7 resilience", "Resilience4j 2.4", "PostgreSQL 17"],
        "tracks": ["track-04", "track-05", "track-06", "track-13"],
        "tags": ["cards", "state-machine", "circuit-breaker", "bulkhead", "timeouts"],
    },
    {
        "id": "project-d", "sequence": 4, "folder": "project-d-reconciliation-engine",
        "module": "capstone-4-reconciliation", "slug": "settlement-reconciliation",
        "title": "Settlement and Reconciliation Pipeline (CAMT.053 ingest, matching, breaks)",
        "shortTitle": "Reconciliation", "color": "#f59e0b", "colorMuted": "rgba(245, 158, 11, 0.15)",
        "description": "Ingest bank statements safely, match them against the ledger, classify every difference and resolve it through an audited workflow.",
        "objectives": [
            "Parse ISO 20022 camt.053 statements safely (no XXE) and validate balances",
            "Match bank lines to ledger items and classify breaks",
            "Run a maker-checker exception workflow with an append-only audit trail",
        ],
        "techStack": ["Java 21", "Spring Boot 4.0", "StAX", "PostgreSQL 17", "Testcontainers 2"],
        "tracks": ["track-04", "track-05", "track-08", "track-11"],
        "tags": ["reconciliation", "iso-20022", "camt053", "settlement", "audit"],
    },
    {
        "id": "project-e", "sequence": 5, "folder": "project-e-instant-p2p",
        "module": "capstone-5-instant-p2p", "slug": "instant-p2p",
        "title": "Instant P2P Transfer API with OAuth2, Per-Tenant Rate Limiting and Webhooks",
        "shortTitle": "Instant P2P API", "color": "#8b5cf6", "colorMuted": "rgba(139, 92, 246, 0.15)",
        "description": "A multi-tenant transfer API secured by OAuth2, kept fair with a Redis token bucket, notifying tenants through signed, retried webhooks.",
        "objectives": [
            "Secure a resource server with JWT audience, scope and object-level checks",
            "Rate-limit per tenant with an atomic Redis token bucket",
            "Deliver signed webhooks with leases, backoff with jitter and SSRF protection",
        ],
        "techStack": ["Java 21", "Spring Boot 4.0", "Spring Security 7", "Redis 7.4", "PostgreSQL 17"],
        "tracks": ["track-11", "track-02", "track-06", "track-13"],
        "tags": ["p2p", "oauth2", "rate-limiting", "webhooks", "multi-tenant", "ssrf"],
    },
]

LESSON_LINK = re.compile(r"\]\(\.\./\.\./docs/content/tracks/([^/)]+)/([^/)]+)/index\.md\)")
OTHER_RELATIVE = re.compile(r"\]\((?!https?://|#|mailto:)([^)]+)\)")


def load_lesson_index():
    """(track-folder, lesson-folder) -> (track-id, lesson-id) from every _track.json."""
    index = {}
    tracks_dir = os.path.join(DOCS, "content", "tracks")
    for track_folder in sorted(os.listdir(tracks_dir)):
        manifest = os.path.join(tracks_dir, track_folder, "_track.json")
        if not os.path.isfile(manifest):
            continue
        with open(manifest) as f:
            data = json.load(f)
        track_id = data.get("id") or "-".join(track_folder.split("-")[:2])
        for lesson in data.get("lessons", []):
            path = lesson.get("path", "")
            lesson_folder = path.rstrip("/").split("/")[-2] if path.endswith("index.md") else ""
            if lesson_folder:
                index[(track_folder, lesson_folder)] = (track_id, lesson["id"])
    return index


def render(cap, lesson_index):
    readme_path = os.path.join(EXAMPLES, cap["module"], "README.md")
    with open(readme_path) as f:
        md = f.read()

    def lesson_link(m):
        key = (m.group(1), m.group(2))
        if key not in lesson_index:
            raise SystemExit(f"{readme_path}: unresolved lesson link {m.group(0)}")
        track_id, lesson_id = lesson_index[key]
        return f"](#/tracks/{track_id}/lessons/{lesson_id})"

    md = LESSON_LINK.sub(lesson_link, md)

    def code_link(m):
        target = m.group(1)
        kind = "tree" if target.endswith("/") or "." not in os.path.basename(target) else "blob"
        return f"]({GITHUB}/{kind}/{BRANCH}/examples/{cap['module']}/{target})"

    md = OTHER_RELATIVE.sub(code_link, md)

    # The page header shows the title, so drop the README's H1.
    md = re.sub(r"\A# .*\n+", "", md)
    source = (f"**Source code:** [`examples/{cap['module']}`]({GITHUB}/tree/{BRANCH}/examples/{cap['module']}) · "
              f"run `mvn test -pl {cap['module']} -am` from `examples/`\n\n")
    front = "\n".join([
        "---",
        f"id: {cap['id']}",
        f"title: \"{cap['title']}\"",
        f"slug: {cap['slug']}",
        "difficulty: advanced",
        f"estimatedHours: {HOURS_EACH}",
        "status: published",
        f"techStack: [{', '.join(cap['techStack'])}]",
        f"tracks: [{', '.join(cap['tracks'])}]",
        f"tags: [{', '.join(cap['tags'])}]",
        f"module: examples/{cap['module']}",
        "---",
        f"<!-- GENERATED from examples/{cap['module']}/README.md by tools/build_capstone_pages.py. "
        "Edit the README, then re-run the script. -->",
        "",
    ])
    return front + "\n" + source + md


def plain_text(md):
    md = re.sub(r"```.*?```", " ", md, flags=re.S)
    md = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", md)
    md = re.sub(r"[#*`>|_-]+", " ", md)
    return re.sub(r"\s+", " ", md).strip()


def manifest_entry(cap):
    keys = ["id", "sequence", "title", "shortTitle", "slug", "color", "colorMuted", "description",
            "objectives", "techStack", "tracks", "tags"]
    entry = {k: cap[k] for k in keys}
    entry.update({
        "path": f"content/capstone/{cap['folder']}/index.md",
        "difficulty": "advanced",
        "estimatedHours": HOURS_EACH,
        "status": "published",
        "module": f"examples/{cap['module']}",
    })
    order = ["id", "sequence", "title", "shortTitle", "slug", "path", "difficulty", "estimatedHours", "status",
             "color", "colorMuted", "description", "objectives", "techStack", "tracks", "tags", "module"]
    return {k: entry[k] for k in order}


def write_if_changed(path, content, check, changed):
    old = open(path).read() if os.path.exists(path) else None
    if old != content:
        changed.append(os.path.relpath(path, ROOT))
        if not check:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(content)


def main():
    check = "--check" in sys.argv
    changed = []
    lesson_index = load_lesson_index()
    pages = {}
    for cap in CAPSTONES:
        page = render(cap, lesson_index)
        pages[cap["id"]] = page
        write_if_changed(os.path.join(DOCS, "content", "capstone", cap["folder"], "index.md"), page, check, changed)

    # capstone-projects.json
    cp_path = os.path.join(DOCS, "data", "capstone-projects.json")
    with open(cp_path) as f:
        cp = json.load(f)
    cp["projects"] = [manifest_entry(c) for c in CAPSTONES]
    write_if_changed(cp_path, json.dumps(cp, indent=2, ensure_ascii=False) + "\n", check, changed)

    # curriculum-index.json
    ci_path = os.path.join(DOCS, "data", "curriculum-index.json")
    with open(ci_path) as f:
        ci = json.load(f)
    ci["capstoneProjects"] = [{"id": c["id"], "title": c["title"], "status": "published"} for c in CAPSTONES]
    write_if_changed(ci_path, json.dumps(ci, indent=2), check, changed)  # keep the file's existing format

    # search-index.json: replace capstone documents
    si_path = os.path.join(DOCS, "data", "search-index.json")
    with open(si_path) as f:
        si = json.load(f)
    docs = [d for d in si["documents"] if d.get("type") != "capstone"]
    for c in CAPSTONES:
        docs.append({
            "id": c["id"], "type": "capstone", "title": c["title"], "shortTitle": c["shortTitle"],
            "track": "capstone", "trackName": "Capstone Projects", "trackColor": c["color"],
            "slug": c["slug"], "url": f"/capstone/{c['slug']}", "difficulty": "advanced",
            "estimatedHours": HOURS_EACH, "status": "published", "tags": c["tags"],
            "body": plain_text(pages[c["id"]].split("-->", 1)[1])[:4000],
        })
    old_capstones = [d for d in si["documents"] if d.get("type") == "capstone"]
    new_capstones = [d for d in docs if d.get("type") == "capstone"]
    if old_capstones == new_capstones:
        docs = si["documents"]  # semantically up to date: leave the file (and its formatting) alone
    si["documents"] = docs
    si["totalDocs"] = len(docs)
    if isinstance(si.get("meta"), dict):
        by_type = {}
        for d in docs:
            by_type[d.get("type")] = by_type.get(d.get("type"), 0) + 1
        si["meta"]["total"] = len(docs)
        si["meta"]["byType"] = by_type
    if old_capstones != new_capstones:
        write_if_changed(si_path, json.dumps(si, indent=2), check, changed)  # keep the file's existing format

    if check:
        if changed:
            print("Capstone pages out of date (run tools/build_capstone_pages.py):", *changed, sep="\n  ")
            sys.exit(1)
        print("Capstone pages up to date.")
    else:
        print("Updated:" if changed else "No changes.", *changed, sep="\n  ")


if __name__ == "__main__":
    main()
