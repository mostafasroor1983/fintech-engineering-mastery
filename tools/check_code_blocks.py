#!/usr/bin/env python3
"""Syntax-check every code block in the lessons and capstone pages.

Arabic lessons are not checked separately: the validator already requires their code blocks to be
byte-identical to the English ones.

  properties  no inline comments (Java .properties would read them as part of the value)
  json        json.loads                        (use ```jsonc for JSON with // comments)
  yaml        yaml.safe_load_all                (Helm templates with {{ }} are skipped)
  bash        bash -n                           (<placeholder> arguments are tolerated)
  sql         PostgreSQL's own parser (pglast)  (:param, ?, and "..." placeholders are tolerated)
  java*       JavaParser, newest language level (needs the jar; see --javaparser)

Blocks that are intentionally not valid on their own (another SQL dialect, a fragment shown next to
its fix, a constructor signature written as documentation) are listed in
tools/code-check/allowlist.txt as "<lesson-id> <sha1 of the code>[  # reason]". If a listed block
changes, its hash changes, so it is checked again.

Usage: python3 tools/check_code_blocks.py [--javaparser path/to/javaparser-core.jar] [--update-allowlist]
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
ALLOW = os.path.join(ROOT, "tools", "code-check", "allowlist.txt")
JAVA_CHECK = os.path.join(ROOT, "tools", "code-check", "Check.java")
FENCE = re.compile(r'^(```|~~~)([^\n]*)\n(.*?)^\1[ \t]*$', re.M | re.S)
DEFAULT_JAR = os.path.expanduser(
    "~/.m2/repository/com/github/javaparser/javaparser-core/3.26.4/javaparser-core-3.26.4.jar")


def blocks():
    files = []
    for tj in sorted(glob.glob(os.path.join(DOCS, "content", "tracks", "*", "_track.json"))):
        with open(tj) as f:
            files += [(l["id"], l["path"]) for l in json.load(f)["lessons"]]
    for p in sorted(glob.glob(os.path.join(DOCS, "content", "capstone", "*", "index.md"))):
        files.append((p.split(os.sep)[-2], os.path.relpath(p, DOCS)))
    for lid, path in files:
        with open(os.path.join(DOCS, path), encoding="utf-8") as f:
            text = f.read()
        for m in FENCE.finditer(text):
            lang = (m.group(2).strip().split() or [""])[0].lower()
            yield dict(lesson=lid, path=path, line=text[:m.start()].count("\n") + 1, lang=lang, code=m.group(3))


def sha(code):
    return hashlib.sha1(code.encode("utf-8")).hexdigest()[:16]


def check_sql(code, pglast):
    c = re.sub(r'(?<![:\w]):[A-Za-z_]\w*', '$1', code)               # :param (keeps ::casts)
    c = re.sub(r'SELECT\s+\.\.\.', 'SELECT 1', c).replace('...', '')
    try:
        pglast.parse_sql(c)
        return None
    except Exception:
        pass
    c2 = re.sub(r'(?<=[\s=(,<>])\?(?=[\s,);]|$)', '$1', c, flags=re.M)  # JDBC ? (not the JSONB ? operator)
    try:
        pglast.parse_sql(c2)
        return None
    except Exception as e:
        return str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--javaparser", default=os.environ.get("JAVAPARSER_JAR", DEFAULT_JAR))
    ap.add_argument("--update-allowlist", action="store_true",
                    help="write every current failure to the allowlist (review the diff before committing)")
    a = ap.parse_args()

    import yaml
    try:
        import pglast
    except ImportError:
        pglast = None
        print("NOTE: pglast not installed; SQL blocks not checked (pip install pglast)")
    have_java = os.path.exists(a.javaparser) and shutil.which("java")
    if not have_java:
        print(f"NOTE: JavaParser jar not found at {a.javaparser}; Java blocks not checked")

    allowed = {}
    if os.path.exists(ALLOW):
        for line in open(ALLOW, encoding="utf-8"):
            line = line.split("#", 1)
            key = line[0].strip()
            if key:
                allowed[key] = line[1].strip() if len(line) > 1 else ""

    failures, counts, java = [], {}, []
    for b in blocks():
        lang, code, err = b["lang"], b["code"], None
        if lang == "json":
            try:
                json.loads(code)
            except Exception as e:
                err = str(e)
        elif lang == "yaml" and "{{" not in code:
            try:
                list(yaml.safe_load_all(code))
            except Exception as e:
                err = str(e).replace("\n", " ")
        elif lang == "bash":
            r = subprocess.run(["bash", "-n"], input=re.sub(r"<[\w./-]+>", "PLACEHOLDER", code),
                               capture_output=True, text=True)
            err = r.stderr.strip() or None if r.returncode else None
        elif lang == "properties":
            # Java .properties has no inline comments: "key=value  # note" makes "value  # note" the value
            bad = [l for l in code.split("\n") if re.match(r"^\s*[^#!\s][^=:]*[=:].*?\s[#!]\s", l)]
            err = f"inline comment becomes part of the value: {bad[0].strip()}" if bad else None
        elif lang == "sql" and pglast:
            err = check_sql(code, pglast)
        elif lang in ("java", "java17", "java21") and have_java:
            java.append(b)
            continue
        else:
            continue
        counts[lang] = counts.get(lang, 0) + 1
        if err:
            failures.append((b, err))

    if java:
        payload = "".join(re.sub(r'(?<![\w>\])])\.\.\.', '', b["code"]).replace("…", "") + "\0END\n" for b in java)
        out = subprocess.run(["java", "-cp", a.javaparser, JAVA_CHECK], input=payload,
                             capture_output=True, text=True, check=True).stdout.splitlines()
        assert len(out) == len(java), "Java checker output does not match the input"
        for b, res in zip(java, out):
            counts[b["lang"]] = counts.get(b["lang"], 0) + 1
            if res != "OK":
                failures.append((b, res[4:]))

    new = [(b, e) for b, e in failures if f"{b['lesson']} {sha(b['code'])}" not in allowed]
    current = {f"{b['lesson']} {sha(b['code'])}" for b, _ in failures}
    stale = [k for k in allowed if k not in current]

    print("checked: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    print(f"known exceptions (allowlist): {len(failures) - len(new)}")
    if a.update_allowlist:
        with open(ALLOW, "w", encoding="utf-8") as f:
            f.write("# Code blocks that are intentionally not valid on their own. Format: <lesson> <sha1>  # reason\n"
                    "# Regenerate with: python3 tools/check_code_blocks.py --update-allowlist (then review the diff)\n")
            for b, e in sorted(failures, key=lambda x: (x[0]["lesson"], x[0]["line"])):
                k = f"{b['lesson']} {sha(b['code'])}"
                reason = allowed.get(k) or f"{b['lang']} L{b['line']}: {e[:70]}"
                f.write(f"{k}  # {reason}\n")
        print(f"allowlist rewritten: {len(failures)} entries")
        return
    if stale:
        print(f"NOTE: {len(stale)} allowlist entries no longer match a failing block (remove them)")
    if new:
        print(f"\nCODE CHECK FAILED: {len(new)} block(s) don't parse")
        for b, e in new:
            print(f"  {b['path']}:{b['line']} [{b['lang']}] {e[:160]}")
        sys.exit(1)
    print("✓ Code check passed")


if __name__ == "__main__":
    main()
