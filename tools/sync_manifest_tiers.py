#!/usr/bin/env python3
"""Write each lesson's tier into its _track.json and refresh track totals in docs/data/tracks.json.

Source of truth for tiers: CORE_IDS / SUPPORTING_IDS / NEW_CONTENT_TRACKS in tools/validate_content.py.
New-content tracks keep the tier written in their own manifests (core or supporting).
Everything else not in Core or Supporting is "optional" (kept, outside the time budget).

Usage: python3 tools/sync_manifest_tiers.py [--check]
"""
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
spec = importlib.util.spec_from_file_location("validator", os.path.join(ROOT, "tools", "validate_content.py"))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def indent_of(text):
    for line in text.splitlines()[1:3]:
        stripped = line.lstrip(" ")
        if stripped and len(line) != len(stripped):
            return len(line) - len(stripped)
    return 2


def dump(obj, original):
    out = json.dumps(obj, indent=indent_of(original), ensure_ascii=False)
    return out + ("\n" if original.endswith("\n") else "")


def main():
    check = "--check" in sys.argv
    changed = []
    totals = {}
    tracks_dir = os.path.join(DOCS, "content", "tracks")
    for folder in sorted(os.listdir(tracks_dir)):
        path = os.path.join(tracks_dir, folder, "_track.json")
        if not os.path.isfile(path):
            continue
        original = open(path).read()
        data = json.loads(original)
        new_track = data["id"] in v.NEW_CONTENT_TRACKS
        main_min = all_min = 0
        for lesson in data.get("lessons", []):
            if lesson["id"] in v.CORE_IDS:
                tier = "core"
            elif lesson["id"] in v.SUPPORTING_IDS:
                tier = "supporting"
            elif new_track:
                tier = lesson.get("tier", "core")
            else:
                tier = "optional"
            lesson["tier"] = tier
            minutes = lesson.get("estimatedMinutes", 0)
            all_min += minutes
            if tier != "optional":
                main_min += minutes
        data["mainPathMinutes"] = main_min
        data["optionalLessonCount"] = sum(1 for l in data.get("lessons", []) if l["tier"] == "optional")
        totals[data["id"]] = (len(data.get("lessons", [])), round(all_min / 60, 1), round(main_min / 60, 1))
        new_text = dump(data, original)
        if new_text != original:
            changed.append(os.path.relpath(path, ROOT))
            if not check:
                open(path, "w").write(new_text)

    tj = os.path.join(DOCS, "data", "tracks.json")
    original = open(tj).read()
    tracks = json.loads(original)
    for t in tracks:
        if t["id"] in totals:
            count, all_h, main_h = totals[t["id"]]
            t["lessonCount"] = count
            t["estimatedHours"] = all_h
            t["mainPathHours"] = main_h
    new_text = dump(tracks, original)
    if new_text != original:
        changed.append(os.path.relpath(tj, ROOT))
        if not check:
            open(tj, "w").write(new_text)

    if check and changed:
        print("Manifest tiers out of date (run tools/sync_manifest_tiers.py):", *changed, sep="\n  ")
        sys.exit(1)
    print(("Up to date." if not changed else "Updated:"), *changed, sep="\n  ")


if __name__ == "__main__":
    main()
