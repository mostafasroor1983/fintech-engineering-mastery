#!/usr/bin/env python3
"""Assemble an Arabic lesson (index.ar.md) from an Arabic draft and the English source.

The draft is the Arabic prose with placeholders, so code is never retyped by hand:

  @@FRONTMATTER@@   -> the English front matter, with `title` (and trackName / track-name)
                       replaced by the Arabic values from the track's _track.ar.json
  @@CODE n@@        -> the n-th fenced code block (1-based, including mermaid) of index.md,
                       copied byte for byte

Usage (from the repo root):
  python3 tools/i18n/assemble_lesson.py <lesson-dir> <draft-file>
Writes <lesson-dir>/index.ar.md and checks that every English code block was used once,
and that KNOWLEDGE-CHECK / PRACTICAL-CHALLENGE blocks are valid JSON.
"""
import json, os, re, sys

FENCE = re.compile(r'^(```|~~~)[^\n]*\n.*?^\1[ \t]*$', re.M | re.S)
BLOCK = re.compile(r'<!--\s*(KNOWLEDGE-CHECK|PRACTICAL-CHALLENGE)\s*(\{.*?\})\s*-->', re.S)


def main(lesson_dir, draft_path):
    en = open(os.path.join(lesson_dir, 'index.md'), encoding='utf-8').read()
    draft = open(draft_path, encoding='utf-8').read()

    fm = re.match(r'^---\n.*?\n---\n', en, re.S)
    body = en[fm.end():] if fm else en
    blocks = [m.group(0) for m in FENCE.finditer(body)]

    track_dir = os.path.dirname(os.path.abspath(lesson_dir))
    tr = json.load(open(os.path.join(track_dir, '_track.ar.json'), encoding='utf-8'))
    lesson_id = re.search(r'^id:\s*"?([\w-]+)"?', en, re.M).group(1)
    lesson = next(l for l in tr['lessons'] if l['id'] == lesson_id)

    if '@@FRONTMATTER@@' in draft:
        front = fm.group(0)
        front = re.sub(r'^title:.*$', 'title: ' + json.dumps(lesson['title'], ensure_ascii=False), front, flags=re.M)
        front = re.sub(r'^(trackName|track-name):.*$',
                       lambda m: m.group(1) + ': ' + json.dumps(tr['title'], ensure_ascii=False), front, flags=re.M)
        draft = draft.replace('@@FRONTMATTER@@\n', front, 1)

    used = []
    def code(m):
        n = int(m.group(1))
        if not 1 <= n <= len(blocks):
            sys.exit('draft refers to @@CODE %d@@ but index.md has %d code blocks' % (n, len(blocks)))
        used.append(n)
        return blocks[n - 1]
    out = re.sub(r'^@@CODE (\d+)@@[ \t]*$', code, draft, flags=re.M)

    missing = sorted(set(range(1, len(blocks) + 1)) - set(used))
    if missing:
        sys.exit('code blocks not used in draft: %s' % missing)
    if re.search(r'@@(CODE \d+|FRONTMATTER)@@', re.sub(FENCE, '', out)):
        sys.exit('unreplaced @@ marker left in draft')
    for m in BLOCK.finditer(out):
        json.loads(m.group(2))

    path = os.path.join(lesson_dir, 'index.ar.md')
    open(path, 'w', encoding='utf-8').write(out)
    print('wrote', path, '-', len(blocks), 'code blocks')


if __name__ == '__main__':
    main(*sys.argv[1:3])
