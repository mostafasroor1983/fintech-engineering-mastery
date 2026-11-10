#!/usr/bin/env node
/**
 * Engineering Mastery — Search Index Builder
 *
 * Generates docs/data/search-index.json from:
 *   - docs/data/tracks.json          (14 track overview documents)
 *   - docs/content/tracks/TRACK/_track.json  (lesson metadata for each track)
 *   - docs/content/tracks/TRACK/LESSON/index.md  (lesson body — published only)
 *   - docs/data/decision-lab.json    (5 lab scenario documents)
 *
 * Run from project root:
 *   node scripts/build-search-index.js
 *
 * Output: docs/data/search-index.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DOCS_DIR   = path.resolve(__dirname, '..', 'docs');
const DATA_DIR   = path.join(DOCS_DIR, 'data');
const TRACKS_DIR = path.join(DOCS_DIR, 'content', 'tracks');
const OUT_FILE   = path.join(DATA_DIR, 'search-index.json');

/* ------------------------------------------------------------------ */
/*  Markdown → plain text stripper                                     */
/* ------------------------------------------------------------------ */
function stripMarkdown(raw) {
  return raw
    // Remove YAML frontmatter
    .replace(/^---[\s\S]*?---\n?/, '')
    // Remove HTML comments (knowledge-check, practical-challenge, etc.)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove fenced code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`[^`]*`/g, '')
    // Remove Mermaid blocks (already removed by fenced code, but belt+suspenders)
    .replace(/^```mermaid[\s\S]*?^```/gm, '')
    // Remove images
    .replace(/!\[.*?\]\(.*?\)/g, '')
    // Convert links to just link text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove blockquote markers (keep text)
    .replace(/^>\s*(\[!.*?\])?\s*/gm, '')
    // Remove heading markers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remove table delimiters
    .replace(/^\|[-|: ]+\|$/gm, '')
    .replace(/^\|/gm, '')
    .replace(/\|$/gm, '')
    .replace(/\|/g, ' ')
    // Collapse whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/* Keep body to a reasonable length for the index */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s\S+$/, '') + '…';
}

/* ------------------------------------------------------------------ */
/*  Read JSON helper                                                    */
/* ------------------------------------------------------------------ */
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Read text file (returns null if missing)                           */
/* ------------------------------------------------------------------ */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Build documents                                                     */
/* ------------------------------------------------------------------ */
const documents = [];

/* -- 1. Track-level documents -------------------------------------- */
const tracksData = readJSON(path.join(DATA_DIR, 'tracks.json'));
if (!tracksData) {
  console.error('ERROR: docs/data/tracks.json not found');
  process.exit(1);
}

const trackMap = {};
tracksData.forEach(function (track) {
  trackMap[track.id] = track;

  documents.push({
    id:             track.id,
    type:           'track',
    title:          track.title,
    track:          track.id,
    trackName:      track.title,
    trackColor:     track.color,
    slug:           track.slug,
    url:            '/curriculum/track/' + track.id,
    difficulty:     track.difficulty,
    estimatedHours: track.estimatedHours,
    status:         track.status,
    tags:           track.tags || [],
    body:           track.description || ''
  });
});

console.log('✓ ' + tracksData.length + ' track documents indexed');

/* -- 2. Lesson documents ------------------------------------------- */
let lessonCount  = 0;
let skippedCount = 0;

// Find all _track.json files
let trackDirs = [];
try {
  trackDirs = fs.readdirSync(TRACKS_DIR).filter(function (d) {
    return fs.statSync(path.join(TRACKS_DIR, d)).isDirectory();
  });
} catch (e) {
  console.warn('WARN: content/tracks directory not found — no lesson documents indexed');
}

trackDirs.forEach(function (dirName) {
  const trackJsonPath = path.join(TRACKS_DIR, dirName, '_track.json');
  const trackData = readJSON(trackJsonPath);
  if (!trackData) return;

  const appTrack = trackMap[trackData.id] || {};

  (trackData.lessons || []).forEach(function (lesson) {
    // Try to read the markdown file
    const mdPath  = path.join(DOCS_DIR, lesson.path);
    const mdRaw   = readText(mdPath);

    let body = '';
    if (mdRaw) {
      body = truncate(stripMarkdown(mdRaw), 2000);
    } else {
      // In-development: index metadata only so it's still discoverable
      body = (lesson.tags || []).join(' ');
    }

    documents.push({
      id:               lesson.id,
      type:             'lesson',
      title:            lesson.title,
      track:            trackData.id,
      trackName:        appTrack.title || trackData.title,
      trackColor:       appTrack.color || '#888',
      slug:             lesson.slug,
      url:              '/tracks/' + trackData.id + '/lessons/' + lesson.id,
      difficulty:       lesson.difficulty,
      estimatedMinutes: lesson.estimatedMinutes,
      status:           lesson.status,
      tags:             lesson.tags || [],
      body:             body
    });

    lessonCount++;
    if (!mdRaw) skippedCount++;
  });
});

console.log('✓ ' + lessonCount + ' lesson documents indexed (' +
  skippedCount + ' in-development, metadata only)');

/* -- 3. Decision Lab scenario documents ---------------------------- */
const labData = readJSON(path.join(DATA_DIR, 'decision-lab.json'));
if (labData && labData.scenarios) {
  labData.scenarios.forEach(function (scenario) {
    // Combine context + stage questions as body text
    var bodyParts = [scenario.context || ''];
    (scenario.stages || []).forEach(function (stage) {
      bodyParts.push(stage.question || '');
      (stage.options || []).forEach(function (opt) {
        bodyParts.push(opt.text || '');
      });
    });
    if (scenario.debrief) {
      bodyParts.push(scenario.debrief.summary || '');
      (scenario.debrief.keyTakeaways || []).forEach(function (t) {
        bodyParts.push(t);
      });
    }

    documents.push({
      id:               scenario.id,
      type:             'scenario',
      title:            scenario.title,
      subtitle:         scenario.subtitle,
      track:            'decision-lab',
      trackName:        'Decision Lab',
      trackColor:       '#f97316',
      slug:             scenario.slug,
      url:              '/decision-lab/' + scenario.id,
      difficulty:       scenario.difficulty,
      estimatedMinutes: scenario.estimatedMinutes,
      status:           scenario.status,
      tags:             scenario.tags || [],
      body:             truncate(bodyParts.join(' '), 2000)
    });
  });

  console.log('✓ ' + labData.scenarios.length + ' decision lab scenarios indexed');
}

/* -- 4. Capstone project documents --------------------------------- */
const capstoneData = readJSON(path.join(DATA_DIR, 'capstone-projects.json'));
if (capstoneData && capstoneData.projects) {
  capstoneData.projects.forEach(function (project) {
    // Try to read the markdown file for full-text
    var mdPath = path.join(DOCS_DIR, project.path);
    var mdRaw  = readText(mdPath);
    var body   = '';

    if (mdRaw) {
      body = truncate(stripMarkdown(mdRaw), 2000);
    } else {
      body = (project.tags || []).join(' ');
    }

    documents.push({
      id:             project.id,
      type:           'capstone',
      title:          project.title,
      shortTitle:     project.shortTitle,
      track:          'capstone',
      trackName:      'Capstone Projects',
      trackColor:     project.color || '#6366f1',
      slug:           project.slug,
      url:            '/capstone/' + project.slug,
      difficulty:     project.difficulty,
      estimatedHours: project.estimatedHours,
      status:         project.status,
      tags:           project.tags || [],
      body:           body
    });
  });

  console.log('✓ ' + capstoneData.projects.length + ' capstone projects indexed');
}

/* ------------------------------------------------------------------ */
/*  Write output                                                        */
/* ------------------------------------------------------------------ */
const output = {
  version:   '1.0',
  lastBuilt: new Date().toISOString().slice(0, 10),
  totalDocs: documents.length,
  documents: documents
};

fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');

console.log('\n✅ Search index written to docs/data/search-index.json');
console.log('   Total documents: ' + documents.length);
console.log('   Tracks:    ' + documents.filter(function (d) { return d.type === 'track'; }).length);
console.log('   Lessons:   ' + documents.filter(function (d) { return d.type === 'lesson'; }).length);
console.log('   Scenarios: ' + documents.filter(function (d) { return d.type === 'scenario'; }).length);
console.log('   Capstone:  ' + documents.filter(function (d) { return d.type === 'capstone'; }).length);
