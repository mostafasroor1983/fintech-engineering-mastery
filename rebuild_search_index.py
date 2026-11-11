#!/usr/bin/env python3
"""
Rebuild search-index.json for fintech-engineering-mastery.
- Reads all _track.json files
- Extracts frontmatter from each lesson's index.md
- Builds rich lesson documents with body text
- Keeps existing track, scenario, and capstone docs (updated from tracks.json)
"""

import json
import os
import re
import sys

BASE = '/Users/mostafasrour/Desktop/fintech-engineering-mastery/docs'
TRACKS_JSON = os.path.join(BASE, 'data', 'tracks.json')
SEARCH_INDEX = os.path.join(BASE, 'data', 'search-index.json')
TRACKS_DIR = os.path.join(BASE, 'content', 'tracks')


def parse_frontmatter(lines):
    """Extract YAML frontmatter from a list of lines. Returns (meta_dict, body_lines)."""
    if not lines or lines[0].strip() != '---':
        return {}, lines
    end = None
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == '---':
            end = i
            break
    if end is None:
        return {}, lines

    fm_lines = lines[1:end]
    body_lines = lines[end + 1:]
    meta = {}
    for line in fm_lines:
        # Handle simple key: value and key: [inline, array]
        m = re.match(r'^(\w[\w-]*)\s*:\s*(.*)', line)
        if m:
            key = m.group(1)
            val = m.group(2).strip()
            # Inline array: [a, b, c]
            if val.startswith('[') and val.endswith(']'):
                inner = val[1:-1]
                meta[key] = [v.strip().strip('"\'') for v in inner.split(',') if v.strip()]
            elif val.startswith('"') and val.endswith('"'):
                meta[key] = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                meta[key] = val[1:-1]
            elif val.isdigit():
                meta[key] = int(val)
            else:
                meta[key] = val
    return meta, body_lines


def strip_markdown(text):
    """Remove common markdown symbols to get plain text."""
    # Remove code blocks
    text = re.sub(r'```[\s\S]*?```', ' ', text)
    text = re.sub(r'`[^`]*`', ' ', text)
    # Remove headings
    text = re.sub(r'^#+\s+', '', text, flags=re.MULTILINE)
    # Remove bold/italic
    text = re.sub(r'\*{1,3}([^*]+)\*{1,3}', r'\1', text)
    text = re.sub(r'_{1,3}([^_]+)_{1,3}', r'\1', text)
    # Remove links
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)
    # Remove HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    # Remove horizontal rules
    text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    # Remove list bullets
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*\d+\.\s+', '', text, flags=re.MULTILINE)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def get_lesson_body(md_path):
    """Read markdown file and return first 500 chars of stripped body."""
    if not os.path.exists(md_path):
        return ''
    try:
        with open(md_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        # Only read first 100 lines per spec
        lines = lines[:100]
        _, body_lines = parse_frontmatter([l.rstrip('\n') for l in lines])
        body_text = strip_markdown('\n'.join(body_lines))
        return body_text[:500]
    except Exception as e:
        print(f'  WARN: could not read {md_path}: {e}', file=sys.stderr)
        return ''


def get_lesson_meta(md_path, lesson_from_track):
    """Get metadata from markdown frontmatter, falling back to _track.json data."""
    meta = dict(lesson_from_track)  # start with _track.json data
    if os.path.exists(md_path):
        try:
            with open(md_path, 'r', encoding='utf-8') as f:
                lines = [l.rstrip('\n') for l in f.readlines()[:100]]
            fm, _ = parse_frontmatter(lines)
            if fm:
                # Override with frontmatter values if present
                for k in ('id', 'title', 'slug', 'difficulty', 'estimatedMinutes', 'tags', 'status'):
                    if k in fm:
                        meta[k] = fm[k]
        except Exception as e:
            print(f'  WARN: frontmatter parse failed for {md_path}: {e}', file=sys.stderr)
    return meta


def main():
    # Load tracks.json for color/name info
    with open(TRACKS_JSON, 'r') as f:
        tracks_list = json.load(f)
    tracks_map = {t['id']: t for t in tracks_list}

    # Load existing search index to keep scenario and capstone docs
    with open(SEARCH_INDEX, 'r') as f:
        existing = json.load(f)

    # Separate out non-lesson, non-track docs (scenarios, capstones)
    keep_docs = [d for d in existing['documents'] if d['type'] not in ('lesson', 'track')]
    print(f'Keeping {len(keep_docs)} scenario/capstone docs')

    # Build fresh track docs from tracks.json
    track_docs = []
    for t in tracks_list:
        track_docs.append({
            'id': t['id'],
            'type': 'track',
            'title': t['title'],
            'track': t['id'],
            'trackName': t['title'],
            'trackColor': t['color'],
            'slug': t['slug'],
            'url': f"/curriculum/track/{t['id']}",
            'difficulty': t['difficulty'],
            'estimatedHours': t['estimatedHours'],
            'status': t['status'],
            'tags': t['tags'],
            'body': t['description']
        })
    print(f'Built {len(track_docs)} track docs')

    # Build lesson docs from _track.json files
    lesson_docs = []
    track_dirs = sorted(os.listdir(TRACKS_DIR))
    for track_dir in track_dirs:
        track_dir_path = os.path.join(TRACKS_DIR, track_dir)
        if not os.path.isdir(track_dir_path):
            continue
        track_json_path = os.path.join(track_dir_path, '_track.json')
        if not os.path.exists(track_json_path):
            print(f'  WARN: no _track.json in {track_dir}')
            continue
        with open(track_json_path, 'r') as f:
            track_data = json.load(f)

        track_id = track_data['id']
        track_info = tracks_map.get(track_id, {})
        track_name = track_data.get('title', track_info.get('title', ''))
        track_color = track_info.get('color', track_data.get('color', ''))

        lessons = track_data.get('lessons', [])
        for lesson in lessons:
            lesson_id = lesson.get('id', '')
            lesson_slug = lesson.get('slug', '')
            md_path = os.path.join(BASE, lesson.get('path', ''))

            meta = get_lesson_meta(md_path, lesson)
            body = get_lesson_body(md_path)

            doc = {
                'id': lesson_id,
                'type': 'lesson',
                'title': meta.get('title', lesson.get('title', '')),
                'track': track_id,
                'trackName': track_name,
                'trackColor': track_color,
                'slug': meta.get('slug', lesson_slug),
                'url': f'/tracks/{track_id}/lessons/{lesson_id}',
                'difficulty': meta.get('difficulty', lesson.get('difficulty', 'advanced')),
                'estimatedMinutes': meta.get('estimatedMinutes', lesson.get('estimatedMinutes', 0)),
                'status': 'published',
                'tags': meta.get('tags', lesson.get('tags', [])),
                'body': body
            }
            lesson_docs.append(doc)

        print(f'  {track_id}: {len(lessons)} lessons')

    print(f'Built {len(lesson_docs)} lesson docs')

    # Assemble final document list: tracks first, then lessons, then scenarios/capstones
    all_docs = track_docs + lesson_docs + keep_docs
    total = len(all_docs)
    print(f'Total docs: {total}')

    result = {
        'version': '1.0',
        'lastBuilt': '2026-11-11',
        'totalDocs': total,
        'documents': all_docs
    }

    with open(SEARCH_INDEX, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f'Written: {SEARCH_INDEX}')

    # Verify
    with open(SEARCH_INDEX) as f:
        verify = json.load(f)
    from collections import Counter
    c = Counter(d['type'] for d in verify['documents'])
    print(f'Verification: {dict(c)}')
    print(f'  total: {verify["totalDocs"]}, lastBuilt: {verify["lastBuilt"]}')

    # Check lesson-29 is present
    found = any(d['id'] == 'track-03-lesson-29' for d in verify['documents'])
    print(f'  track-03-lesson-29 present: {found}')


if __name__ == '__main__':
    main()
