#!/usr/bin/env python3
"""Generate the Track 17 (Final Interview Prep) lessons from compact sources in tools/final-prep/.

Sources
  lessons/<lesson-dir>.md   a full lesson (front matter + Markdown) that may contain directives
  qa/*.txt                  Q&A banks        ("## Section", "Q: ...", "A: ...")
  mcq/*.txt                 multiple choice  ("Q: ...", "- wrong", "* correct", "E: explanation")
  tips/*.txt                tips             ("## Section", "- tip")

Directives (each on its own line in a lesson file)
  @@QA qa/01-financial-systems.txt@@   numbered, collapsible Q&As (answer first, then reveal)
  @@MCQ mcq/part-1.txt@@               a KNOWLEDGE-CHECK block (the site's scored quiz)
  @@TIPS tips/part-1.txt@@             numbered tips grouped by section
  @@JAVA Money.java@@                  the tested source from examples/track-17-coding, byte for byte

Numbering continues across files in name order, so Q&As run 1-500, MCQs 1-100, tips 1-300.
Checks (exit 1): every MCQ has 4 options and exactly one correct; no duplicate questions; the
generated files are up to date (--check).

Usage: python3 tools/build_final_prep.py [--check]
"""
import glob
import html
import json
import os
import random
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "final-prep")
OUT = os.path.join(ROOT, "docs", "content", "tracks", "track-17-final-prep")
JAVA = os.path.join(ROOT, "examples", "track-17-coding", "src", "main", "java", "com", "fintechmastery", "interview")
DIRECTIVE = re.compile(r"^@@(QA|MCQ|TIPS|JAVA) ([\w./-]+)@@\s*$", re.M)
errors = []


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def inline_html(text):
    """Markdown `code` and **bold** for use inside raw HTML (<summary> is not parsed as Markdown)."""
    parts = re.split(r"(`[^`]+`)", text)
    out = []
    for p in parts:
        if p.startswith("`") and p.endswith("`") and len(p) > 1:
            out.append("<code>" + html.escape(p[1:-1]) + "</code>")
        else:
            p = html.escape(p, quote=False)
            out.append(re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", p))
    return "".join(out)


def parse_blocks(text, keys):
    """Split a source file into (kind, value) records; continuation lines join the previous value."""
    records = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.startswith("#!") or line.startswith("//"):
            continue
        m = re.match(r"^(##|" + "|".join(re.escape(k) for k in keys) + r")\s?(.*)$", line)
        if m:
            records.append([m.group(1), m.group(2).strip()])
        elif records:
            records[-1][1] += " " + line.strip()
        else:
            errors.append(f"text before the first record: {line[:60]}")
    return records


# ---------------------------------------------------------------- counters shared across files
counters = {"QA": 0, "MCQ": 0, "TIPS": 0}
seen_questions = {}
LANG_SRC = [SRC]          # source root of the language being rendered (SRC, or SRC/ar)
english = {}              # (kind, rel) -> (first number, count, MCQ answer positions), from the English pass


def render_qa(rel):
    out, q = [], None
    for kind, value in parse_blocks(read(os.path.join(LANG_SRC[0], rel)), ["Q:", "A:"]):
        if kind == "##":
            out.append(f"\n### {value}\n")
        elif kind == "Q:":
            q = value
            key = re.sub(r"\W+", " ", q.lower()).strip()
            if key in seen_questions:
                errors.append(f"duplicate question in {rel}: {q[:70]} (also {seen_questions[key]})")
            seen_questions[key] = rel
        elif kind == "A:":
            if q is None:
                errors.append(f"{rel}: answer without a question: {value[:60]}")
                continue
            counters["QA"] += 1
            n = counters["QA"]
            out.append(f'<details class="qa" id="q{n}">\n<summary><strong>Q{n}.</strong> {inline_html(q)}</summary>\n\n'
                       f"{value}\n\n</details>\n")
            q = None
    if q is not None:
        errors.append(f"{rel}: question without an answer: {q[:60]}")
    return "\n".join(out).strip("\n")


def render_mcq(rel):
    questions, cur = [], None
    for kind, value in parse_blocks(read(os.path.join(LANG_SRC[0], rel)), ["Q:", "-", "*", "E:"]):
        if kind == "Q:":
            cur = {"question": value, "options": [], "correct": None, "explanation": ""}
            questions.append(cur)
        elif kind in ("-", "*") and cur is not None:
            if kind == "*":
                if cur["correct"] is not None:
                    errors.append(f"{rel}: two correct options: {cur['question'][:60]}")
                cur["correct"] = len(cur["options"])
            cur["options"].append(value)
        elif kind == "E:" and cur is not None:
            cur["explanation"] = value
    block = []
    # Balance the position of the correct answer: in every run of 4 questions it lands once in each
    # position (seeded, so the output is stable). Wrong options keep their written order; numeric
    # scales ("1", "2", "3", "4") keep their natural order.
    rng = random.Random(rel)
    targets = []
    for q in questions:
        counters["MCQ"] += 1
        n = counters["MCQ"]
        if len(q["options"]) != 4 or q["correct"] is None or not q["explanation"]:
            errors.append(f"{rel} MCQ {n}: needs 4 options, one correct (*) and an explanation: {q['question'][:60]}")
            continue
        if not targets:
            targets = [0, 1, 2, 3]
            rng.shuffle(targets)
        target = targets.pop()
        if not all(re.fullmatch(r"-?[\d.,]+%?", o.strip()) for o in q["options"]):
            right = q["options"][q["correct"]]
            wrong = [o for i, o in enumerate(q["options"]) if i != q["correct"]]
            q["options"] = wrong[:target] + [right] + wrong[target:]
            q["correct"] = target
        block.append({"id": f"mcq-{n:03d}", "question": f"{n}. {q['question']}", "options": q["options"],
                      "correct": q["correct"] if q["correct"] is not None else 0, "explanation": q["explanation"]})
    LAST_MCQ_POSITIONS[:] = [q["correct"] for q in block]
    return "<!-- KNOWLEDGE-CHECK\n" + json.dumps(block, indent=2, ensure_ascii=False) + "\n-->"


def render_tips(rel):
    out, in_list = [], False
    for kind, value in parse_blocks(read(os.path.join(LANG_SRC[0], rel)), ["-"]):
        if kind == "##":
            out.append(f"\n### {value}\n")
        else:
            counters["TIPS"] += 1
            out.append(f"{counters['TIPS']}. {value}")
    return "\n".join(out).strip("\n")


def render_java(name):
    path = os.path.join(JAVA, name)
    if not os.path.exists(path):
        errors.append(f"missing Java source {name}")
        return ""
    code = read(path)
    code = re.sub(r"^package [\w.]+;\n\n", "", code)           # the package line is noise on the page
    return "```java\n" + code.rstrip("\n") + "\n```"


RENDER = {"QA": render_qa, "MCQ": render_mcq, "TIPS": render_tips, "JAVA": render_java}
LAST_MCQ_POSITIONS = []
AR = os.path.join(SRC, "ar")


def expand(kind, rel, lang):
    """Render one directive. Arabic reuses the English numbering and must match English counts."""
    if kind == "JAVA":
        return render_java(rel)
    if lang == "ar":
        if (kind, rel) not in english:
            errors.append(f"ar: {rel} has no English counterpart")
            return ""
        counters[kind] = english[(kind, rel)][0]
    start = counters[kind]
    out = RENDER[kind](rel)
    count = counters[kind] - start
    if lang == "en":
        english[(kind, rel)] = (start, count, list(LAST_MCQ_POSITIONS) if kind == "MCQ" else None)
    else:
        en_start, en_count, en_pos = english[(kind, rel)]
        if count != en_count:
            errors.append(f"ar/{rel}: {count} items, English has {en_count}")
        elif kind == "MCQ" and LAST_MCQ_POSITIONS != en_pos:
            errors.append(f"ar/{rel}: option order differs from English (keep the options in the same order)")
    return out


BLOCK = re.compile(r"<!--\s*(KNOWLEDGE-CHECK|PRACTICAL-CHALLENGE)\s*(.*?)\s*-->", re.S)


def check_block_parity(en_text, ar_text, name):
    """Hand-written quiz/challenge blocks: same ids, option counts and correct answers in both languages."""
    def shape(text):
        out = []
        for kind, raw in BLOCK.findall(text):
            data = json.loads(raw)
            if kind == "KNOWLEDGE-CHECK":
                out.append((kind, [(q["id"], len(q["options"]), q["correct"]) for q in data]))
            else:
                out.append((kind, data["id"], [t["id"] for t in data["tasks"]]))
        return out
    try:
        if shape(en_text) != shape(ar_text):
            errors.append(f"ar/lessons/{name}.md: quiz/challenge blocks differ from English (ids, options or correct answers)")
    except (ValueError, KeyError) as e:
        errors.append(f"ar/lessons/{name}.md: invalid quiz/challenge JSON: {e}")


def build():
    outputs = {}
    # English first (it defines numbering), then Arabic (tools/final-prep/ar/, same layout) where translated
    for lang, root, out_name in (("en", SRC, "index.md"), ("ar", AR, "index.ar.md")):
        LANG_SRC[0] = root
        seen_questions.clear()
        for src in sorted(glob.glob(os.path.join(root, "lessons", "*.md"))):
            name = os.path.splitext(os.path.basename(src))[0]
            if lang == "ar" and not os.path.exists(os.path.join(SRC, "lessons", name + ".md")):
                errors.append(f"ar/lessons/{name}.md has no English lesson")
                continue
            if lang == "ar":
                check_block_parity(read(os.path.join(SRC, "lessons", name + ".md")), read(src), name)
            body = DIRECTIVE.sub(lambda m: expand(m.group(1), m.group(2), lang), read(src))
            # mark the file as generated, right after the front matter
            body = re.sub(r"^(---\n.*?\n---\n)", r"\1<!-- GENERATED by tools/build_final_prep.py from tools/final-prep/. "
                          r"Edit the sources, then re-run it. -->\n", body, count=1, flags=re.S)
            outputs[os.path.join(OUT, name, out_name)] = body
        if lang == "en":
            totals = dict(counters)
    counters.update(totals)                       # report the English totals
    return outputs


def main():
    outputs = build()
    if errors:
        print("Final prep errors:", *errors, sep="\n  ")
        sys.exit(1)
    if "--check" in sys.argv:
        stale = [p for p, t in outputs.items() if not os.path.exists(p) or read(p) != t]
        if stale:
            print("Track 17 lessons out of date: run tools/build_final_prep.py |", os.path.relpath(stale[0], ROOT))
            sys.exit(1)
        print(f"Final prep OK: {counters['QA']} Q&As, {counters['MCQ']} MCQs, {counters['TIPS']} tips.")
        return
    for path, text in outputs.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    print(f"Wrote {len(outputs)} lessons: {counters['QA']} Q&As, {counters['MCQ']} MCQs, {counters['TIPS']} tips.")


if __name__ == "__main__":
    main()
