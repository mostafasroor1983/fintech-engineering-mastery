#!/usr/bin/env python3
"""
validate_content.py — Phase 0 curriculum validator

Checks:
  1. All lesson paths in _track.json exist on disk
  2. Each lesson has valid YAML frontmatter
  3. Lesson sequences are contiguous (no gaps)
  4. Prerequisite IDs reference known lessons (no dangling refs)
  5. Main-path (Core + Supporting) total ≤ 260 h
  6. No single lesson exceeds 75 min (T05 exception: ≤ 100 min)
  7. All 24 T05 lessons are present and ≤ 100 min
  8. Cross-check: search-index.json contains entry for each registered lesson

Usage:
    python3 tools/validate_content.py [--docs-dir docs] [--verbose]

Exit code 0 = all checks pass. Non-zero = at least one failure.
"""

import argparse
import json
import os
import re
import sys

try:
    import yaml
    YAML_AVAILABLE = True
except ImportError:
    YAML_AVAILABLE = False

# ---------------------------------------------------------------------------
# Tier configuration — mirrors 00-lesson-tiers.md
# Update this dict when tier assignments change.
# ---------------------------------------------------------------------------

CORE_IDS = {
    # T01
    "track-01-lesson-04", "track-01-lesson-05", "track-01-lesson-07",
    "track-01-lesson-09", "track-01-lesson-14",
    # T02
    "track-02-lesson-01", "track-02-lesson-02", "track-02-lesson-06",
    "track-02-lesson-09", "track-02-lesson-10", "track-02-lesson-14",
    "track-02-lesson-16",
    # T03
    "track-03-lesson-01", "track-03-lesson-02", "track-03-lesson-03",
    "track-03-lesson-04", "track-03-lesson-06", "track-03-lesson-07",
    "track-03-lesson-08", "track-03-lesson-10", "track-03-lesson-11",
    "track-03-lesson-12", "track-03-lesson-14", "track-03-lesson-16",
    "track-03-lesson-18", "track-03-lesson-20", "track-03-lesson-21",
    "track-03-lesson-27", "track-03-lesson-29",
    # T04
    "track-04-lesson-01", "track-04-lesson-02", "track-04-lesson-03",
    "track-04-lesson-05", "track-04-lesson-07", "track-04-lesson-08",
    # T05 — all 24
    "track-05-lesson-01", "track-05-lesson-02", "track-05-lesson-03",
    "track-05-lesson-04", "track-05-lesson-05", "track-05-lesson-06",
    "track-05-lesson-07", "track-05-lesson-08", "track-05-lesson-09",
    "track-05-lesson-10", "track-05-lesson-11", "track-05-lesson-12",
    "track-05-lesson-13", "track-05-lesson-14", "track-05-lesson-15",
    "track-05-lesson-16", "track-05-lesson-17", "track-05-lesson-18",
    "track-05-lesson-19", "track-05-lesson-20", "track-05-lesson-21",
    "track-05-lesson-22", "track-05-lesson-23", "track-05-lesson-24",
    # T06
    "track-06-lesson-01", "track-06-lesson-02", "track-06-lesson-03",
    "track-06-lesson-04", "track-06-lesson-05",
    # T07
    "track-07-lesson-01", "track-07-lesson-03", "track-07-lesson-05",
    "track-07-lesson-07", "track-07-lesson-08", "track-07-lesson-14",
    "track-07-lesson-15",
    # T08
    "track-08-lesson-01", "track-08-lesson-02", "track-08-lesson-03",
    "track-08-lesson-04", "track-08-lesson-05", "track-08-lesson-07",
    "track-08-lesson-09",
    # T09
    "track-09-lesson-01", "track-09-lesson-02", "track-09-lesson-03",
    "track-09-lesson-05", "track-09-lesson-15",
    # T10
    "track-10-lesson-01", "track-10-lesson-04", "track-10-lesson-09",
    # T11
    "track-11-lesson-01", "track-11-lesson-03", "track-11-lesson-05",
    "track-11-lesson-10",
    # T12
    # T12: senior subset only (brief: design docs/RFC, code review, incident handling, tech debt, mentoring).
    # L01 (Staff/Principal operating model) and L08 (cross-team influence) demoted to Optional, 2026-11-13.
    "track-12-lesson-03", "track-12-lesson-05", "track-12-lesson-09", "track-12-lesson-11",
}

SUPPORTING_IDS = {
    "track-12-lesson-07",  # mentoring (senior subset of T12)
    # T01
    "track-01-lesson-06", "track-01-lesson-08",
    # T02 — T02-07 and T02-08 demoted to Optional (budget fix)
    "track-02-lesson-04",
    # T03
    "track-03-lesson-05", "track-03-lesson-13",
    # T04 — T04-18 and T04-21 demoted to Optional (budget fix)
    # T06 — T06-07 and T06-11 demoted to Optional (budget fix)
    # T07
    "track-07-lesson-04",
    # T07-02 demoted to Optional (budget fix)
    "track-08-lesson-11",
    # T08-06 demoted to Optional (budget fix); T08-11 stays (CDC canonical)
    # T09-06 stays as Supporting (Outbox canonical)
    "track-09-lesson-06",
    # T11 — T11-02 and T11-11 demoted to Optional (budget fix)
}

MAIN_PATH_IDS = CORE_IDS | SUPPORTING_IDS

T06_TRACK = "track-05"
MAX_LESSON_MIN = 75
MAX_T06_MIN = 100
MAIN_PATH_CAP_HOURS = 260
# New-content tracks: every lesson is main path and counted from its real estimatedMinutes,
# and the 75-minute cap is a hard error for them (it is a warning for older lessons).
NEW_CONTENT_TRACKS = ("track-13", "track-14", "track-15", "track-16")
CAPSTONE_COUNT = 5
CAPSTONE_HOURS_EACH = 12
DELETED_TRACKS = ("track-04-async-reactive", "track-07-financial-crime")  # slugs: ids 04/07 were reused by renumbering


def _check_capstones(docs_dir, tracks_meta, errors, warnings):
    """CHECK 8: exactly 5 capstones, files and code modules exist, no deleted tracks, pages in sync.

    Returns the capstone hours that count towards the main path.
    """
    manifest_path = os.path.join(docs_dir, "data", "capstone-projects.json")
    if not os.path.exists(manifest_path):
        errors.append(f"MISSING: {manifest_path}")
        return 0
    with open(manifest_path) as f:
        projects = json.load(f).get("projects", [])
    repo_root = os.path.dirname(docs_dir)
    track_ids = {t.get("id") for t in tracks_meta}
    if len(projects) != CAPSTONE_COUNT:
        errors.append(f"Capstones: expected exactly {CAPSTONE_COUNT}, found {len(projects)}")
    seqs = sorted(p.get("sequence", 0) for p in projects)
    if seqs != list(range(1, len(projects) + 1)):
        errors.append(f"Capstones: sequence numbers must be 1..{len(projects)}, found {seqs}")
    hours = 0
    for p in projects:
        pid = p.get("id", "?")
        hours += p.get("estimatedHours", 0)
        if p.get("estimatedHours") != CAPSTONE_HOURS_EACH:
            warnings.append(f"[{pid}] estimatedHours={p.get('estimatedHours')} (plan assumes {CAPSTONE_HOURS_EACH})")
        page = os.path.join(docs_dir, p.get("path", ""))
        if not os.path.exists(page):
            errors.append(f"[{pid}] capstone page missing: {p.get('path')}")
        else:
            with open(page) as f:
                text = f.read()
            for dead in DELETED_TRACKS:
                if re.search(rf"\b{dead}\b", text):
                    errors.append(f"[{pid}] page references deleted {dead}")
            for link_track, link_lesson in re.findall(r"\(#/tracks/([^/]+)/lessons/([^)]+)\)", text):
                if link_track not in track_ids:
                    errors.append(f"[{pid}] link to unknown track {link_track}")
        for tid in p.get("tracks", []):
            if tid in DELETED_TRACKS:
                errors.append(f"[{pid}] manifest references deleted {tid}")
            elif tid not in track_ids:
                errors.append(f"[{pid}] manifest references unknown track {tid}")
        module = p.get("module", "")
        if not module:
            errors.append(f"[{pid}] no code module declared")
        else:
            for needed in ("pom.xml", "README.md"):
                if not os.path.exists(os.path.join(repo_root, module, needed)):
                    errors.append(f"[{pid}] {module}/{needed} missing")
    import subprocess
    for script, message in (
            ("build_capstone_pages.py", "Capstone pages out of sync with examples/*/README.md: run tools/build_capstone_pages.py"),
            ("sync_manifest_tiers.py", "Lesson tiers in _track.json out of sync with CORE/SUPPORTING sets: run tools/sync_manifest_tiers.py"),
            ("build_study_plan.py", "Study plan invalid or out of date: run tools/build_study_plan.py")):
        path = os.path.join(repo_root, "tools", script)
        if os.path.exists(path):
            result = subprocess.run([sys.executable, path, "--check"], capture_output=True, text=True)
            if result.returncode != 0:
                errors.append(message + " | " + (result.stdout.strip().splitlines() or [""])[-1])
    return hours


def _parse_frontmatter(content):
    """Extract YAML frontmatter between --- delimiters. Returns dict or None."""
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if not match:
        return None
    fm_text = match.group(1)
    if YAML_AVAILABLE:
        try:
            return yaml.safe_load(fm_text)
        except yaml.YAMLError:
            return None
    # Minimal regex-based fallback
    fm = {}
    for line in fm_text.splitlines():
        m = re.match(r'^(\w[\w-]*):\s*(.+)$', line)
        if m:
            fm[m.group(1)] = m.group(2).strip().strip('"\'')
    return fm


def validate(docs_dir, verbose):
    errors = []
    warnings = []

    tracks_json_path = os.path.join(docs_dir, "data", "tracks.json")
    content_dir = os.path.join(docs_dir, "content", "tracks")
    search_index_path = os.path.join(docs_dir, "data", "search-index.json")

    # -----------------------------------------------------------------
    # Load tracks.json
    # -----------------------------------------------------------------
    if not os.path.exists(tracks_json_path):
        errors.append(f"MISSING: {tracks_json_path}")
        return errors, warnings

    with open(tracks_json_path) as f:
        tracks_meta = json.load(f)

    # -----------------------------------------------------------------
    # Load search index (for cross-check)
    # -----------------------------------------------------------------
    search_indexed_ids = set()
    if os.path.exists(search_index_path):
        with open(search_index_path) as f:
            si = json.load(f)
        for doc in si.get("documents", []):
            search_indexed_ids.add(doc.get("id", ""))
    else:
        warnings.append(f"search-index.json not found at {search_index_path}")

    all_lesson_ids = {}  # id → track_json_path
    total_main_path_minutes = 0
    new_track_minutes = 0

    # -----------------------------------------------------------------
    # Per-track validation
    # -----------------------------------------------------------------
    track_dirs = sorted([
        d for d in os.listdir(content_dir)
        if os.path.isdir(os.path.join(content_dir, d))
    ])

    for track_dir in track_dirs:
        track_path = os.path.join(content_dir, track_dir)
        track_json_path = os.path.join(track_path, "_track.json")

        if not os.path.exists(track_json_path):
            warnings.append(f"No _track.json in {track_dir}")
            continue

        with open(track_json_path) as f:
            try:
                track_data = json.load(f)
            except json.JSONDecodeError as e:
                errors.append(f"JSON parse error in {track_json_path}: {e}")
                continue

        lessons = track_data.get("lessons", [])
        track_id = track_data.get("id", track_dir)

        # CHECK 10: no two lesson folders on disk share a sequence number, and none is unreferenced
        referenced = {l.get("path", "").split("/")[-2] for l in lessons if l.get("path", "").startswith("content/tracks/")}
        seen_numbers = {}
        for folder in sorted(os.listdir(track_path)):
            if not folder.startswith("lesson-") or not os.path.isdir(os.path.join(track_path, folder)):
                continue
            number = folder.split("-")[1]
            if number in seen_numbers:
                errors.append(f"[{track_id}] Colliding lesson folders: {seen_numbers[number]} and {folder}")
            seen_numbers[number] = folder
            if folder not in referenced:
                errors.append(f"[{track_id}] Lesson folder not in _track.json: {folder}")
        is_t06 = track_id.startswith(T06_TRACK)

        # CHECK 3: Contiguous sequences
        sequences = [l.get("sequence", 0) for l in lessons if l.get("sequence")]
        if sequences:
            expected = list(range(1, len(sequences) + 1))
            if sorted(sequences) != expected:
                errors.append(
                    f"[{track_id}] Sequence gaps: got {sorted(sequences)}, expected {expected}"
                )

        for lesson in lessons:
            lid = lesson.get("id", "")
            lpath = lesson.get("path", "")
            lmin = lesson.get("estimatedMinutes", 90)

            # Collect all IDs for prerequisite check
            if lid:
                all_lesson_ids[lid] = track_json_path

            # CHECK 1: Path exists
            full_path = os.path.join(docs_dir, lpath)
            if not os.path.exists(full_path):
                errors.append(f"[{lid}] Path not found: {lpath}")
                continue

            # CHECK 2: Valid frontmatter
            with open(full_path) as f:
                content = f.read()
            fm = _parse_frontmatter(content)
            if fm is None:
                errors.append(f"[{lid}] No valid YAML frontmatter in {lpath}")
            else:
                for required_field in ("id", "title", "track", "status"):
                    if required_field not in fm:
                        warnings.append(
                            f"[{lid}] Frontmatter missing field: {required_field}"
                        )
                if fm.get("id") and fm["id"] != lid:
                    errors.append(
                        f"[{lid}] Frontmatter id '{fm['id']}' does not match manifest id '{lid}'"
                    )

            # CHECK 9: Mermaid sequence diagrams must not contain ';' (it ends the statement and
            # breaks rendering with "Syntax error in text").
            for block in re.findall(r"```mermaid\n(.*?)```", content, re.S):
                if re.match(r"\s*sequenceDiagram", block) and any(
                        ";" in ln and not ln.strip().startswith("%%") for ln in block.splitlines()):
                    errors.append(f"[{lid}] Mermaid sequenceDiagram contains ';' (breaks rendering)")

            # CHECK 6: Lesson duration cap
            cap = MAX_T06_MIN if is_t06 else MAX_LESSON_MIN
            is_new = track_id in NEW_CONTENT_TRACKS
            if lmin > cap:
                # ERROR threshold = cap+25 (100m for normal, 125m for T05)
                # Existing lessons averaging 80-95m get warnings; only extreme outliers error.
                # New-content tracks must respect the cap strictly.
                severity = "ERROR" if (is_new or lmin > cap + 25) else "WARN"
                msg = (
                    f"[{lid}] estimatedMinutes={lmin} exceeds {cap}m cap"
                    f" ({'T05 100m' if is_t06 else '75m'})"
                )
                if severity == "ERROR":
                    errors.append(msg)
                else:
                    warnings.append(msg)

            # CHECK 5: Accumulate main-path minutes
            if lid in MAIN_PATH_IDS:
                total_main_path_minutes += lmin
            elif is_new:
                new_track_minutes += lmin

            # Cross-check search index
            if lid and lid not in search_indexed_ids:
                warnings.append(f"[{lid}] Not found in search-index.json")

    # CHECK 4: Prerequisites reference known IDs
    for track_dir in track_dirs:
        track_json_path = os.path.join(content_dir, track_dir, "_track.json")
        if not os.path.exists(track_json_path):
            continue
        with open(track_json_path) as f:
            try:
                track_data = json.load(f)
            except json.JSONDecodeError:
                continue
        for lesson in track_data.get("lessons", []):
            lid = lesson.get("id", "")
            lpath_full = os.path.join(docs_dir, lesson.get("path", ""))
            if not os.path.exists(lpath_full):
                continue
            with open(lpath_full) as f:
                content = f.read()
            fm = _parse_frontmatter(content)
            if fm and "prerequisites" in fm:
                prereqs = fm["prerequisites"]
                if isinstance(prereqs, list):
                    for prereq_id in prereqs:
                        if prereq_id and prereq_id not in all_lesson_ids:
                            warnings.append(
                                f"[{lid}] Prerequisite '{prereq_id}' not found in any manifest"
                            )

    # CHECK 5: Total main-path hours
    total_main_path_hours = total_main_path_minutes / 60
    # New content: capstone hours from the capstone manifest (CHECK 8) plus the real minutes of the
    # new-content tracks (Spring Boot 4, system design, interview playbook, first 90 days).
    capstone_hours = _check_capstones(docs_dir, tracks_meta, errors, warnings)
    new_track_hours = new_track_minutes / 60
    new_content_hours = new_track_hours + capstone_hours
    projected_total = total_main_path_hours + new_content_hours
    if verbose:
        print(f"\n--- Budget ---")
        print(f"  Existing C+S path:  {total_main_path_minutes} min = {total_main_path_hours:.1f} h")
        print(f"  New content:        {new_content_hours:.1f} h (tracks 13-16 {new_track_hours:.1f} h + capstones {capstone_hours} h)")
        print(f"  Projected total:    {projected_total:.1f} h (cap: {MAIN_PATH_CAP_HOURS} h)")

    if projected_total > MAIN_PATH_CAP_HOURS:
        errors.append(
            f"Budget exceeded: projected {projected_total:.1f} h > {MAIN_PATH_CAP_HOURS} h cap. "
            f"Existing C+S is {total_main_path_hours:.1f} h; must be ≤ {MAIN_PATH_CAP_HOURS - new_content_hours} h."
        )
    elif projected_total > MAIN_PATH_CAP_HOURS * 0.95:
        warnings.append(
            f"Budget tight: projected {projected_total:.1f} h (cap {MAIN_PATH_CAP_HOURS} h, <5% headroom)"
        )

    # CHECK 7: All 24 T05 lessons present
    t06_core = [lid for lid in CORE_IDS if lid.startswith("track-05")]
    t06_found = [lid for lid in t06_core if lid in all_lesson_ids]
    if len(t06_found) != 24:
        missing = set(t06_core) - set(t06_found)
        errors.append(f"T05: expected 24 Core lessons, found {len(t06_found)}. Missing: {missing}")

    return errors, warnings


def main():
    parser = argparse.ArgumentParser(description="Validate fintech-engineering-mastery curriculum")
    parser.add_argument(
        "--docs-dir",
        default=os.path.join(os.path.dirname(__file__), "..", "docs"),
        help="Path to the docs/ directory (default: ../docs relative to this script)"
    )
    parser.add_argument("--verbose", action="store_true", help="Show budget breakdown and all warnings")
    args = parser.parse_args()

    docs_dir = os.path.abspath(args.docs_dir)
    if not os.path.isdir(docs_dir):
        print(f"ERROR: docs-dir not found: {docs_dir}", file=sys.stderr)
        sys.exit(2)

    if not YAML_AVAILABLE:
        print("WARNING: PyYAML not installed; using regex frontmatter parser (less reliable)")

    errors, warnings = validate(docs_dir, args.verbose)

    if args.verbose or warnings:
        for w in warnings:
            print(f"  WARN  {w}")

    if errors:
        print(f"\n{'='*60}")
        print(f"VALIDATION FAILED — {len(errors)} error(s):")
        for e in errors:
            print(f"  ERROR {e}")
        print(f"{'='*60}")
        sys.exit(1)
    else:
        print(f"\n✓ All checks passed ({len(warnings)} warning(s))")
        sys.exit(0)


if __name__ == "__main__":
    main()
