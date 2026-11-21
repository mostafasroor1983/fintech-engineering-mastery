#!/usr/bin/env python3
"""Generate Arabic JSON data files from English sources + Arabic text modules.

  python3 tools/i18n/build_ar_data.py

- docs/data/ar/capstone-projects.json   (from ar_capstones.py)
- docs/data/ar/decision-lab.json        (from ar_decision_lab*.py, when present)
Structural fields (ids, scores, order, paths) always come from the English file,
so only text needs translating and the two languages cannot drift apart.
"""
import json, os, sys, glob, importlib
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.join(HERE, '..', '..', 'docs')
AR = os.path.join(ROOT, 'data', 'ar')
os.makedirs(AR, exist_ok=True)

def load(p): return json.load(open(os.path.join(ROOT, p), encoding='utf-8'))

# Code-like Latin runs inside Arabic sentences (SQL, expressions, method calls) are wrapped
# in backticks so the page renders them as isolated left-to-right <code> spans; otherwise the
# browser's bidi algorithm reorders their operators and parentheses.
import re
_RUN = re.compile(r"-?[A-Za-z_(][A-Za-z0-9_.,:;=<>!*+/()'\[\]{}%@#$? -]*[A-Za-z0-9_)'\]>;*]")
def _codeish(run):
    if len(run) < 8 or re.match(r'^[a-z] ', run) or re.fullmatch(r'[A-Za-z ]+= ?\d+', run):
        return False
    return bool(re.search(r'[=<>]', run) or re.search(r'[A-Za-z_]\(', run) or re.search(r':[a-z]', run))
def _trim(run):
    run = re.sub(r'^[A-Za-z]+: ', '', run)                 # "Java: Caffeine..." -> "Caffeine..."
    run = re.sub(r'^[A-Z][a-z]+ (?=\()', '', run)           # "Kafka (x=y)"      -> "(x=y)"
    while run.endswith(')') and run.count('(') < run.count(')'): run = run[:-1]
    while run.startswith('(') and run.count('(') > run.count(')'): run = run[1:]
    if run.startswith('(') and run.endswith(')'):
        inner = run[1:-1]
        if inner.count('(') == inner.count(')'): run = inner
    return run.rstrip(':').strip()
def wrap_code(text, log=None):
    parts = text.split('`')
    for i in range(0, len(parts), 2):          # only outside existing backticks
        def sub(m):
            run = _trim(m.group(0).strip())
            if not _codeish(run): return m.group(0)
            if log is not None: log.append(run)
            return m.group(0).replace(run, '`' + run + '`', 1)
        parts[i] = _RUN.sub(sub, parts[i])
    return '`'.join(parts)
def save(name, data):
    json.dump(data, open(os.path.join(AR, name), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

# ---- capstones
from ar_capstones import CAPSTONES
cs = load('data/capstone-projects.json')
for p in cs['projects']:
    t = CAPSTONES[p['id']]
    assert len(t['objectives']) == len(p['objectives']), p['id']
    p.update(t)
save('capstone-projects.json', cs)
print('capstones:', len(cs['projects']))

# ---- decision lab (one module per batch of scenarios: ar_decision_lab_*.py, each defining SCENARIOS)
AR_DL = {}
WRAPPED = []
for f in sorted(glob.glob(os.path.join(HERE, 'ar_decision_lab_*.py'))):
    AR_DL.update(importlib.import_module(os.path.basename(f)[:-3]).SCENARIOS)
if AR_DL:
    dl = load('data/decision-lab.json')
    out = []
    for s in dl['scenarios']:
        a = AR_DL.get(s['id'])
        if not a:
            continue  # untranslated scenarios are left out; the page falls back per file, so require all
        s = json.loads(json.dumps(s))
        W = lambda t: wrap_code(t, WRAPPED)
        for k in ('title', 'subtitle'): s[k] = a[k]
        s['context'] = W(a['context'])
        assert len(a['constraints']) == len(s['systemConstraints']), (s['id'], 'constraints')
        s['systemConstraints'] = a['constraints']
        assert len(a['stages']) == len(s['stages']), s['id']
        for st, ast in zip(s['stages'], a['stages']):
            st['question'] = W(ast['q'])
            st['principalRationale'] = W(ast['r'])
            assert len(ast['o']) == len(st['options']), (s['id'], st['id'])
            for o, (txt, fb) in zip(st['options'], ast['o']):
                o['text'], o['feedback'] = W(txt), W(fb)
        d = a['debrief']
        assert len(d['takeaways']) == len(s['debrief']['keyTakeaways']), (s['id'], 'takeaways')
        s['debrief'] = {'summary': W(d['summary']), 'keyTakeaways': [W(t) for t in d['takeaways']],
                        'furtherReading': s['debrief']['furtherReading']}  # references stay in English
        out.append(s)
    if len(out) == len(dl['scenarios']):
        dl['scenarios'] = out
        save('decision-lab.json', dl)
        print('decision lab: all', len(out), 'scenarios translated;', len(WRAPPED), 'code fragments wrapped')
        if '--show-code' in sys.argv:
            for w in sorted(set(WRAPPED)): print('   `' + w + '`')
    else:
        print('decision lab: %d/%d translated — not written yet' % (len(out), len(dl['scenarios'])))

# ---- concurrency lab (modules ar_clab_*.py, each defining EXPERIMENTS = {id: {path: arabic}})
CLAB_PATTERNS = [r'title', r'subtitle', r'scenario', r'impact', r'failureExplanation', r'correctExplanation',
                 r'performanceNotes', r'incorrectAnnotations\.\d+\.note',
                 r'simulation\.(title|bugAnnotation|safeAnnotation)', r'simulation\.(buggySteps|safeSteps)\.\d+\.note',
                 r'alternatives\.\d+\.(name|whenToUse|pros\.\d+|cons\.\d+)', r'performanceTable\.\d+\.notes',
                 r'tests\.\d+\.(explanation|limitations)', r'monitoringSymptoms\.\d+', r'debugTips\.\d+',
                 r'productionRecommendations\.\d+', r'assessment\.\d+\.(text|explanation|options\.\d+)']
CLAB_RE = re.compile('^(' + '|'.join(CLAB_PATTERNS) + ')$')

def clab_paths(exp):
    """Yield (path, english) for every translatable string in one experiment."""
    def walk(x, path):
        if isinstance(x, dict):
            for k, v in x.items(): yield from walk(v, path + [k])
        elif isinstance(x, list):
            for i, v in enumerate(x): yield from walk(v, path + [str(i)])
        elif isinstance(x, str):
            p = '.'.join(path)
            if CLAB_RE.match(p) and not (p.startswith('debugTips') and '\n' in x):
                yield p, x
    yield from walk(exp, [])

def clab_set(exp, path, value):
    keys = path.split('.'); node = exp
    for k in keys[:-1]: node = node[int(k)] if isinstance(node, list) else node[k]
    last = keys[-1]
    if isinstance(node, list): node[int(last)] = value
    else: node[last] = value

if __name__ == '__main__' and '--dump-clab' in sys.argv:
    ids = sys.argv[sys.argv.index('--dump-clab') + 1:]
    for e in load('data/concurrency-lab.json')['experiments']:
        if e['id'] in ids:
            print('\n######', e['id'])
            for p, t in clab_paths(e): print('%s :: %s' % (p, t))
    sys.exit(0)

AR_CL = {}
for f in sorted(glob.glob(os.path.join(HERE, 'ar_clab_*.py'))):
    AR_CL.update(importlib.import_module(os.path.basename(f)[:-3]).EXPERIMENTS)
if AR_CL:
    cl = load('data/concurrency-lab.json')
    missing, CL_WRAPPED = [], []
    for e in cl['experiments']:
        tr = AR_CL.get(e['id'])
        if not tr:
            missing.append(e['id']); continue
        for p, en in list(clab_paths(e)):
            if p not in tr: missing.append(e['id'] + ':' + p); continue
            clab_set(e, p, wrap_code(tr[p], CL_WRAPPED))
        extra = set(tr) - {p for p, _ in clab_paths(json.loads(json.dumps(e)))} - set(dict(clab_paths(e)))
    if missing:
        print('concurrency lab: %d missing — not written yet (first: %s)' % (len(missing), missing[:5]))
    else:
        save('concurrency-lab.json', cl)
        print('concurrency lab: all', len(cl['experiments']), 'experiments translated;', len(CL_WRAPPED), 'code fragments wrapped')
        if '--show-code' in sys.argv:
            for w in sorted(set(CL_WRAPPED)): print('   `' + w + '`')

# ---- search index (Arabic): English index with titles/bodies swapped for the Arabic versions that exist.
# Lessons keep their English body until index.ar.md exists, so English technical terms stay searchable.
def _plain(md, limit):
    md = re.sub(r'```.*?```', ' ', md, flags=re.S)
    md = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', md)
    md = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', md)
    md = re.sub(r'[#>*_`|]+|\[!\w+\]', ' ', md)
    return re.sub(r'\s+', ' ', md).strip()[:limit]
def _nocode(s): return s.replace('`', '')
if os.path.exists(os.path.join(AR, 'concurrency-lab.json')):
    si = load('data/search-index.json')
    ar_tracks = {t['id']: t for t in json.load(open(os.path.join(AR, 'tracks.json'), encoding='utf-8'))}
    ar_lessons = {}
    for f in glob.glob(os.path.join(ROOT, 'content/tracks/*/_track.ar.json')):
        for l in json.load(open(f, encoding='utf-8'))['lessons']: ar_lessons[l['id']] = l
    ar_dl = {s['id']: s for s in json.load(open(os.path.join(AR, 'decision-lab.json'), encoding='utf-8'))['scenarios']}
    ar_cl = {e['id']: e for e in json.load(open(os.path.join(AR, 'concurrency-lab.json'), encoding='utf-8'))['experiments']}
    ar_cs = {p['id']: p for p in json.load(open(os.path.join(AR, 'capstone-projects.json'), encoding='utf-8'))['projects']}
    CL_NAME = {'java-concurrency': 'التزامن في Java', 'async-reactive': 'البرمجة غير المتزامنة والتفاعلية', 'financial': 'الأنظمة المالية'}
    n_body = 0
    for d in si['documents']:
        t = d['type']
        if d.get('track') in ar_tracks: d['trackName'] = ar_tracks[d['track']]['title']
        if t == 'track':
            a = ar_tracks[d['id']]; d['title'] = d['trackName'] = a['title']; d['body'] = a['description']
        elif t == 'lesson' and d['id'] in ar_lessons:
            a = ar_lessons[d['id']]; d['title'] = a['title']
            p = os.path.join(ROOT, re.sub(r'index\.md$', 'index.ar.md', a['path']))
            if os.path.exists(p):
                d['body'] = _plain(open(p, encoding='utf-8').read(), 500); n_body += 1
        elif t == 'scenario':
            a = ar_dl[d['id']]; d['title'], d['subtitle'] = a['title'], a['subtitle']
            d['trackName'] = 'مختبر القرارات'; d['body'] = _nocode(a['context'])[:1200]
        elif t == 'experiment':
            a = ar_cl[d['id']]; d['title'], d['subtitle'] = a['title'], _nocode(a['subtitle'])
            d['trackName'] = 'مختبر التزامن — ' + CL_NAME.get(a['category'], a['category'])
            d['body'] = _nocode(a['scenario'] + ' ' + a['impact'] + ' ' + a['failureExplanation'])[:1200]
        elif t == 'capstone':
            a = ar_cs[d['id']]; d['title'], d['shortTitle'] = a['title'], a['shortTitle']
            d['trackName'] = 'المشاريع التطبيقية'; d['body'] = a['description']
    save('search-index.json', si)
    print('search index (ar):', len(si['documents']), 'docs;', n_body, 'lesson bodies in Arabic')
