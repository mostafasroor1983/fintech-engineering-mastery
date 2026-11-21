#!/usr/bin/env python3
"""Generate Arabic track metadata from the English files + tools/i18n/ar_tracks.py.

  python3 tools/i18n/build_ar_tracks.py

Writes docs/data/ar/tracks.json and docs/content/tracks/*/_track.ar.json.
Everything except titles/descriptions (ids, paths, hours, tags, tiers) is copied
from the English source, so re-run it after editing the English track files.
"""
import json, glob, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from ar_tracks import TRACKS, LESSONS

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'docs')
missing = []

def tr_track(t):
    short, title, desc = TRACKS[t['id']]
    t = dict(t)
    t['shortTitle'], t['title'], t['description'] = short, title, desc
    return t

tracks = json.load(open(os.path.join(ROOT, 'data/tracks.json'), encoding='utf-8'))
os.makedirs(os.path.join(ROOT, 'data/ar'), exist_ok=True)
json.dump([tr_track(t) for t in tracks], open(os.path.join(ROOT, 'data/ar/tracks.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

for f in sorted(glob.glob(os.path.join(ROOT, 'content/tracks/*/_track.json'))):
    t = tr_track(json.load(open(f, encoding='utf-8')))
    lessons = []
    for l in t['lessons']:
        l = dict(l)
        if l['id'] in LESSONS: l['title'] = LESSONS[l['id']]
        else: missing.append(l['id'])
        lessons.append(l)
    t['lessons'] = lessons
    json.dump(t, open(f.replace('_track.json', '_track.ar.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print('tracks:', len(tracks), '| missing lesson titles:', missing or 'none')
