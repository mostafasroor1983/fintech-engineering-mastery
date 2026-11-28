#!/usr/bin/env python3
"""Load every page of the site in headless Chrome, in English and Arabic, and fail on any problem.

For each route (dashboard, curriculum, every track and lesson, labs, capstones, study plan, glossary,
search, about and an unknown route) it records:
  * console.error / console.warn calls, uncaught exceptions, unhandled promise rejections
  * failed resources (HTTP >= 400, scripts or styles that fail to load)
  * Mermaid diagrams that did not render or rendered a syntax error
  * lessons without a knowledge check or practical challenge
  * Arabic pages that fall back to English
  * pages that show the app's own error message

Needs Google Chrome or Chromium (set CHROME=/path/to/chrome if it is not found) and network access
to the CDN and Google Fonts, the same as a visitor's browser.

Usage: python3 tools/site_check.py [--lang en|ar|both] [--limit N] [--json report.json]
"""
import argparse
import functools
import html
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
HARNESS = os.path.join(ROOT, "tools", "site-check", "crawl.html")


def find_chrome():
    candidates = [os.environ.get("CHROME"), "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    for c in candidates:
        if c and (shutil.which(c) or os.path.exists(c)):
            return shutil.which(c) or c
    sys.exit("Chrome not found: set CHROME=/path/to/chrome")


def load(path):
    with open(os.path.join(DOCS, path), encoding="utf-8") as f:
        return json.load(f)


def items(data, key):
    return data if isinstance(data, list) else data.get(key, [])


def routes():
    r = ["/", "/curriculum", "/decision-lab", "/concurrency-lab", "/capstone", "/search", "/about",
         "/study-plan", "/glossary", "/no-such-page"]
    tracks = load("data/tracks.json")
    r += ["/curriculum/track/" + t["id"] for t in tracks]
    for t in tracks:
        manifest = load(f"content/tracks/{t['id']}-{t['slug']}/_track.json")
        r += [f"/tracks/{t['id']}/lessons/{l['id']}" for l in manifest["lessons"]]
    r += ["/decision-lab/" + s["id"] for s in items(load("data/decision-lab.json"), "scenarios")]
    r += ["/concurrency-lab/" + e["id"] for e in items(load("data/concurrency-lab.json"), "experiments")]
    r += ["/capstone/" + p["id"] for p in items(load("data/capstone-projects.json"), "projects")]
    return r


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(webroot):
    handler = functools.partial(_QuietHandler, directory=webroot)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def crawl(chrome, port, lang, limit, profile):
    url = f"http://127.0.0.1:{port}/crawl.html?lang={lang}" + (f"&only={limit}" if limit else "")
    args = [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
            f"--user-data-dir={profile}", "--virtual-time-budget=5000000", "--dump-dom", url]
    out = subprocess.run(args, capture_output=True, text=True, timeout=1800).stdout
    m = re.search(r'<pre id="out">(.*?)</pre>', out, re.S)
    text = html.unescape(m.group(1)) if m else ""
    if not text.startswith("DONE"):
        sys.exit(f"[{lang}] the crawl did not finish: {text[:200] or 'no output from Chrome'}")
    return json.loads(text[4:])


def problems(report):
    lang, out = report["lang"], []
    for msg in report["early"]:
        out.append(f"[{lang}] startup: {msg}")
    for r in report["results"]:
        where = f"[{lang}] {r['route']}"
        out += [f"{where}: {m}" for m in r["console"]]
        if r["mermaidSvg"] < r["mermaid"]:
            out.append(f"{where}: {r['mermaid'] - r['mermaidSvg']} diagram(s) did not render")
        if r["mermaidErr"]:
            out.append(f"{where}: {r['mermaidErr']} diagram(s) show a Mermaid syntax error")
        if "/lessons/" in r["route"] and (r["kc"] == 0 or r["pc"] == 0):
            out.append(f"{where}: knowledge check or practical challenge missing")
        if lang == "ar" and r["fallback"]:
            out.append(f"{where}: no Arabic version, English shown")
        if r["errText"]:
            out.append(f"{where}: page shows an error message")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--lang", default="both", choices=["en", "ar", "both"])
    ap.add_argument("--limit", type=int, default=0, help="check only the first N routes")
    ap.add_argument("--json", help="write the full report to this file")
    a = ap.parse_args()

    chrome = find_chrome()
    work = tempfile.mkdtemp(prefix="site-check-")
    try:
        os.symlink(DOCS, os.path.join(work, "site"))
        shutil.copy(HARNESS, os.path.join(work, "crawl.html"))
        all_routes = routes()
        with open(os.path.join(work, "routes.json"), "w") as f:
            json.dump(all_routes, f)
        httpd = serve(work)
        langs = ["en", "ar"] if a.lang == "both" else [a.lang]
        reports = [crawl(chrome, httpd.server_address[1], l, a.limit, os.path.join(work, "profile-" + l)) for l in langs]
        httpd.shutdown()
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if a.json:
        with open(a.json, "w") as f:
            json.dump(reports, f, indent=1, ensure_ascii=False)
    found = [p for rep in reports for p in problems(rep)]
    for rep in reports:
        res = rep["results"]
        print(f"[{rep['lang']}] {len(res)} pages, {sum(r['mermaidSvg'] for r in res)}/"
              f"{sum(r['mermaid'] for r in res)} diagrams rendered, "
              f"fonts: {', '.join(sorted({f.split(':')[0] for f in rep['fonts'] if f.endswith('loaded')})) or 'none'}")
    if found:
        print(f"\nSITE CHECK FAILED: {len(found)} problem(s)")
        for p in found[:200]:
            print("  " + p)
        sys.exit(1)
    print("✓ Site check passed: no console errors, failed requests or broken diagrams")


if __name__ == "__main__":
    main()
