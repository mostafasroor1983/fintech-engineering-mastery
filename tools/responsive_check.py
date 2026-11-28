#!/usr/bin/env python3
"""Responsive and accessibility check: every device class x key pages x English/Arabic, in real Chrome.

Device profiles: phones 320-430 px (portrait), a foldable cover screen, a phone in landscape,
a split-screen half, tablets in portrait and landscape, laptops, 1920 px and two ultrawide widths,
with matching pixel density (1x-3x) and touch emulation on touch devices. Two themes (dark, light).

Fails on:
  * horizontal page overflow, or any element outside the viewport that is not inside its own
    scroll container (content hidden by an overflow:hidden parent counts as a failure)
  * wide code/tables/diagrams that are clipped instead of scrollable, clipped diagram labels
  * touch targets smaller than 44x44 px on touch devices (disabled controls excepted)
  * prose wider than 75 characters per line, text smaller than 12 px
  * text contrast below WCAG AA (4.5:1, or 3:1 for large text)
  * images not keeping their aspect ratio, console errors
  * the mobile drawer not opening, or not closing with Escape; the reduced-motion preference ignored

Needs: pip install playwright (uses the installed Google Chrome; set CHROMIUM=1 to use
Playwright's own Chromium after "playwright install chromium").
Usage: python3 tools/responsive_check.py [--pages all] [--devices phone-320,laptop-1440] [--json out.json]
"""
import argparse, functools, http.server, json, os, socketserver, sys, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEVICES = [  # name, width, height, device pixel ratio, touch
    ("phone-320", 320, 568, 2, True), ("fold-344", 344, 882, 2.6, True), ("phone-375", 375, 667, 2, True),
    ("phone-390", 390, 844, 3, True), ("phablet-430", 430, 932, 3, True), ("phone-landscape-844", 844, 390, 3, True),
    ("split-600", 600, 900, 2, True), ("tablet-768", 768, 1024, 2, True), ("tablet-landscape-1024", 1024, 768, 2, True),
    ("laptop-1280", 1280, 800, 2, False), ("laptop-1440", 1440, 900, 2, False), ("desktop-1920", 1920, 1080, 1, False),
    ("ultrawide-2560", 2560, 1080, 1, False), ("ultrawide-3440", 3440, 1440, 1, False),
]
KEY_PAGES = ["/", "/curriculum", "/curriculum/track/track-05", "/tracks/track-05/lessons/track-05-lesson-01",
             "/tracks/track-14/lessons/track-14-lesson-08", "/tracks/track-15/lessons/track-15-lesson-03",
             "/tracks/track-03/lessons/track-03-lesson-18", "/decision-lab", "/decision-lab/lab-01",
             "/concurrency-lab", "/concurrency-lab/java-01", "/capstone", "/capstone/project-a",
             "/study-plan", "/glossary", "/search", "/about"]
MAX_MEASURE_CH = 75

MEASURE = r"""() => {
  const vw = innerWidth, de = document.documentElement;
  const sel = el => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id;
    if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.'); return s; };
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
  const clippedByAncestor = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return p; } return null; };
  const sidebar = document.getElementById('sidebar');
  const inSidebarClosed = el => sidebar && sidebar.contains(el) && sidebar.getBoundingClientRect().right <= 1 || (sidebar && sidebar.contains(el) && sidebar.getBoundingClientRect().left >= vw - 1);
  const res = { vw, docOverflow: Math.max(de.scrollWidth, document.body.scrollWidth) - vw, offenders: [], unscrollable: [],
    smallTargets: [], tinyText: [], measureCh: 0, distorted: [], clippedLabels: 0, sidebarClosed: null };
  // 1. elements outside the viewport that are not inside a scroll/clip container
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || inSidebarClosed(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !clippedByAncestor(el)) res.offenders.push(sel(el) + ` [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }
  res.offenders = [...new Set(res.offenders)].slice(0, 8);
  // 2. wide content that is clipped instead of scrollable
  for (const el of document.querySelectorAll('pre, table, .mermaid-block, .table-wrap, svg')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 2 && !['auto', 'scroll'].includes(cs.overflowX) && el.tagName !== 'svg') {
      const anc = clippedByAncestor(el); const ao = anc && getComputedStyle(anc).overflowX;
      if (!(ao === 'auto' || ao === 'scroll')) res.unscrollable.push(sel(el) + ` (${el.scrollWidth}>${el.clientWidth})`);
    }
  }
  // 3. Mermaid labels clipped inside their foreignObject
  for (const d of document.querySelectorAll('.mermaid svg foreignObject > div')) if (d.scrollWidth > d.clientWidth + 2 || d.scrollHeight > d.clientHeight + 2) res.clippedLabels++;
  // 4. touch targets
  const T = 'button, [role=button], input:not([type=hidden]), select, textarea, .nav-item, .track-nav-item, a.btn, .prereq-link, .kc-option, .lesson-nav-btn, summary, .code-tab-btn, .copy-btn, .diagram-zoom-bar button';
  for (const el of document.querySelectorAll(T)) { if (el.disabled) continue;
    if (!visible(el) || inSidebarClosed(el)) continue; const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) res.smallTargets.push(sel(el) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const cnt = {}; res.smallTargets.forEach(s => { const k = s.replace(/ \d+x\d+$/, ''); cnt[k] = (cnt[k] || 0) + 1; });
  res.smallTargetCount = res.smallTargets.length; res.smallTargets = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => k + ' x' + n);
  // 5. reading measure of lesson prose, in ch of the paragraph font
  const c = document.createElement('canvas').getContext('2d');
  for (const p of document.querySelectorAll('.lesson-body > p, .doc-page > p')) { if (!visible(p)) continue;
    const cs = getComputedStyle(p); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    res.measureCh = Math.max(res.measureCh, Math.round(p.clientWidth / c.measureText('0').width)); }
  // 6. tiny text
  for (const el of document.querySelectorAll('#main-content *, #sidebar *, #topbar *')) {
    if (!el.childNodes.length || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(el) || inSidebarClosed(el) || el.closest('svg')) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 12) res.tinyText.push(sel(el) + ' ' + fs + 'px');
  }
  res.tinyText = [...new Set(res.tinyText)].slice(0, 6);
  // 7. images keep their aspect ratio
  for (const im of document.querySelectorAll('#main-content img')) { if (!im.naturalWidth || !visible(im)) continue;
    const r = im.getBoundingClientRect(); if (Math.abs(r.width / r.height - im.naturalWidth / im.naturalHeight) > 0.02 * im.naturalWidth / im.naturalHeight) res.distorted.push(im.src.slice(-40)); }
  // 8. text contrast against the effective background (WCAG AA: 4.5, or 3 for large text)
  const parse = c => { const m = c.match(/[\d.]+/g); if (!m) return [0,0,0,0]; const v = m.map(Number); if (c.startsWith('color(')) { v[0] *= 255; v[1] *= 255; v[2] *= 255; } return v; };
  const lum = ([r,g,b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.length < 4 || c[3] > 0.9) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
  res.lowContrast = [];
  for (const el of document.querySelectorAll('#main-content *, #sidebar *, #top-bar *')) {
    if (!el.childNodes.length || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(el) || inSidebarClosed(el) || el.closest('svg, pre, .mermaid')) continue;
    const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = bgOf(el);
    if (fg.length > 3 && fg[3] < 0.5) continue;
    const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) res.lowContrast.push(sel(el) + ' ' + ratio.toFixed(2) + ' ' + cs.color);
  }
  res.lowContrast = [...new Set(res.lowContrast)].slice(0, 10);
  if (sidebar) { const r = sidebar.getBoundingClientRect(); res.sidebarClosed = r.right <= 1 || r.left >= vw - 1; }
  const mb = document.getElementById('menu-btn'); if (mb && visible(mb)) { const r = mb.getBoundingClientRect(); res.menuBtn = Math.round(r.width) + 'x' + Math.round(r.height); }
  return res;
}"""


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def problems(r):
    where = f"[{r['lang']}/{r['theme']}/{r['device']}] {r['route']}"
    out = []
    if r["docOverflow"] > 0: out.append(f"{where}: page scrolls sideways by {r['docOverflow']}px")
    out += [f"{where}: outside the viewport: {o}" for o in r["offenders"]]
    out += [f"{where}: clipped, not scrollable: {o}" for o in r["unscrollable"]]
    if r["clippedLabels"]: out.append(f"{where}: {r['clippedLabels']} clipped diagram label(s)")
    if r["touch"] and r["smallTargetCount"]: out.append(f"{where}: touch targets under 44px: {', '.join(r['smallTargets'])}")
    if r["measureCh"] > MAX_MEASURE_CH: out.append(f"{where}: prose line length {r['measureCh']}ch > {MAX_MEASURE_CH}")
    out += [f"{where}: text under 12px: {t}" for t in r["tinyText"]]
    out += [f"{where}: low contrast: {t}" for t in r.get("lowContrast", [])]
    out += [f"{where}: distorted image: {t}" for t in r["distorted"]]
    out += [f"{where}: console error: {e}" for e in r["errors"]]
    for k, label in (("drawerOpens", "drawer does not open"), ("drawerEscCloses", "Escape does not close the drawer")):
        if k in r and not r[k]: out.append(f"{where}: {label}")
    if "reducedMotion" in r and r["reducedMotion"] not in ("0s", "1e-05s"): out.append(f"{where}: transitions ignore prefers-reduced-motion")
    return out


def main():
    from playwright.sync_api import sync_playwright
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pages", default="key", help="'key' (17 representative pages) or 'all' (every route)")
    ap.add_argument("--devices", help="comma-separated device names (default: all)")
    ap.add_argument("--themes", default="dark,light")
    ap.add_argument("--langs", default="en,ar")
    ap.add_argument("--json", help="write every measurement to this file")
    a = ap.parse_args()
    devices = [d for d in DEVICES if not a.devices or d[0] in a.devices.split(",")]
    if a.pages == "all":
        import site_check
        pages = site_check.routes()
    else:
        pages = KEY_PAGES

    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(_Quiet, directory=DOCS))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/index.html"
    report = []
    with sync_playwright() as p:
        browser = p.chromium.launch() if os.environ.get("CHROMIUM") else p.chromium.launch(channel="chrome")
        for theme in a.themes.split(","):
            for lang in a.langs.split(","):
                # the light theme is checked on fewer devices: layout does not depend on colours
                devs = devices if theme == "dark" else [d for d in devices if d[0] in ("phone-390", "tablet-768", "laptop-1440")] or devices[:1]
                for name, w, h, dpr, touch in devs:
                    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr, is_mobile=touch,
                                              has_touch=touch, reduced_motion="reduce" if name == "phone-390" else "no-preference")
                    ctx.add_init_script(f"try{{localStorage.setItem('em_lang','{lang}');localStorage.setItem('em_theme','{theme}')}}catch(e){{}}")
                    page = ctx.new_page(); errors = []
                    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.goto(base + "#/")
                    page.wait_for_function("document.querySelector('#main-content') && document.querySelector('#main-content').innerText.length > 50", timeout=30000)
                    for route in pages:
                        page.evaluate(f"location.hash = '#{route}'")
                        try:
                            page.wait_for_function("(() => { const m = document.querySelector('#main-content'); if (!m || m.innerText.length < 50) return false;"
                                                   " return [...document.querySelectorAll('pre.mermaid')].every(p => p.querySelector('svg')); })()", timeout=20000)
                        except Exception:
                            pass
                        page.wait_for_timeout(250)
                        r = page.evaluate(MEASURE)
                        r.update(device=name, lang=lang, theme=theme, route=route, w=w, h=h, touch=touch, errors=errors[:])
                        errors.clear()
                        if name == "phone-390" and route == "/":
                            r["reducedMotion"] = page.evaluate("getComputedStyle(document.querySelector('.nav-item')).transitionDuration")
                            page.click("#menu-btn"); page.wait_for_timeout(350)
                            r["drawerOpens"] = page.evaluate("(() => { const s = document.getElementById('sidebar').getBoundingClientRect(); return s.left >= -1 && s.right <= innerWidth + 1; })()")
                            page.keyboard.press("Escape"); page.wait_for_timeout(350)
                            r["drawerEscCloses"] = page.evaluate("(() => { const s = document.getElementById('sidebar').getBoundingClientRect(); return s.right <= 1 || s.left >= innerWidth - 1; })()")
                        report.append(r)
                    ctx.close()
        browser.close()
    httpd.shutdown()

    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
    found = [p for r in report for p in problems(r)]
    combos = {(r["theme"], r["lang"], r["device"]) for r in report}
    print(f"checked {len(report)} page views: {len(pages)} page(s) x {len(combos)} device/language/theme combinations")
    if found:
        print(f"\nRESPONSIVE CHECK FAILED: {len(found)} problem(s)")
        for p in found[:150]:
            print("  " + p)
        sys.exit(1)
    print("✓ Responsive check passed: no overflow, clipping, small targets, tiny text or low contrast")


if __name__ == "__main__":
    main()
