// Build the character table the trait lookup fills in from.
//
// The live lookup (server/traits.mjs) still leads: it measures one sample of
// the character alone and keeps what is distinctive. This table adds the
// common looks it misses and answers alone when the live sample is mixed,
// empty or unreachable — see mergeTraits for the measurement behind that
// order. It never overrides a colour, size or length the live lookup saw.
//
//   node scripts/import-character-traits.mjs [--noob <csv>] [--deepghs <json>] [--out <sqlite>]
//
// Two community lists of every character's core tags, merged:
//
//   data/tags/danbooru_character.csv   Laxhar/noob-wiki on Hugging Face,
//                                      Apache-2.0. 244,932 characters, 33,599
//                                      with core tags, plus post and solo counts.
//   data/tags/deepghs_characters.json  deepghs/character_index, MIT. 7,371
//                                      popular characters, core tags ordered by
//                                      frequency, and a boy/girl split.
//
// Why a table at all: the live lookup ranks one page of a character's newest
// posts, and measured 15 Sep 2026 that page can be almost entirely other
// characters — Gran is alone in 8 of his newest 200 — and its lift floor cuts
// common looks like brown hair. Both lists are built from whole datasets of
// solo posts, and both give Gran brown hair, brown eyes and short hair where
// the live lookup gave him `erune`, another character's race.
//
// Stored RAW, with which list carried each tag. The cleaning — framing, one
// hair colour, one size — is cleanTableTraits() in server/traits.mjs and runs
// at lookup, so changing a rule never needs this re-run.
//
// Built at <out>.new and swapped in only when complete, like update-tags.mjs,
// so a failed build never leaves the server reading half a table. Both input
// files and the output are gitignored; fetch the inputs from Hugging Face.

import { readFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cleanTableTraits } from '../server/traits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const NOOB = path.resolve(ROOT, flag('--noob', 'data/tags/danbooru_character.csv'));
const DEEPGHS = path.resolve(ROOT, flag('--deepghs', 'data/tags/deepghs_characters.json'));
const OUT = path.resolve(ROOT, flag('--out', 'data/tags/character_traits.sqlite'));
// Each character's series, beside the table (22 Sep 2026). Both lists carry
// it and this script used to drop it. Image Analysis' Describe reads it to
// hand the model the cast of a series the tagger recognised - see
// server/charcast.mjs. A plain tag -> series map, so it can ship small.
const SERIES_OUT = path.resolve(ROOT, flag('--series-out', path.join(path.dirname(OUT), 'character_series.json')));

/** RFC 4180 rows: quoted fields, doubled quotes, newlines inside quotes. */
function* csvRows(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const row = [];
    let field = '';
    let quoted = false;
    for (; i < n; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i += 1;
        i += 1;
        break;
      } else {
        field += c;
      }
    }
    row.push(field);
    if (row.length > 1 || row[0] !== '') yield row;
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
// Both lists spell a tag their own way: noob-wiki with spaces, deepghs with
// underscores. The table and the lookup key on danbooru's underscore form.
const toTag = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_');

if (!existsSync(NOOB) && !existsSync(DEEPGHS)) {
  console.error(`Neither input exists:\n  ${NOOB}\n  ${DEEPGHS}`);
  process.exit(1);
}

const chars = new Map();
const entry = (tag) => {
  let e = chars.get(tag);
  if (!e) {
    e = { deepghs: [], noob: [], posts: 0, solo: 0, gender: null, series: null };
    chars.set(tag, e);
  }
  return e;
};

let deepghsCount = 0;
if (existsSync(DEEPGHS)) {
  for (const x of JSON.parse(readFileSync(DEEPGHS, 'utf8'))) {
    if (!x?.tag || !Array.isArray(x.core_tags) || !x.core_tags.length) continue;
    const e = entry(x.tag);
    e.deepghs = x.core_tags.map(toTag).filter(Boolean);
    // deepghs' primary copyright wins where both have one.
    if (x.copyright) e.series = toTag(x.copyright);
    e.posts = Number(x.post_count) || e.posts;
    const g = x.gender ?? {};
    e.gender = g.girl >= 0.8 ? 'girl' : g.boy >= 0.8 ? 'boy' : 'mixed';
    deepghsCount += 1;
  }
}

let noobCount = 0;
if (existsSync(NOOB)) {
  const rows = csvRows(readFileSync(NOOB, 'utf8').replace(/^﻿/, ''));
  const head = rows.next().value ?? [];
  const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  for (const need of ['character', 'core_tags', 'count', 'solo_count']) {
    if (col[need] === undefined) {
      console.error(`${NOOB} has no "${need}" column — found: ${head.join(', ')}`);
      process.exit(1);
    }
  }
  for (const r of rows) {
    const tag = toTag(r[col.character]);
    const core = String(r[col.core_tags] ?? '').split(',').map(toTag).filter(Boolean);
    if (!tag || !core.length) continue;
    const e = entry(tag);
    e.noob = core;
    e.posts = Number(r[col.count]) || e.posts;
    e.solo = Number(r[col.solo_count]) || 0;
    if (!e.series && col.copyright !== undefined && r[col.copyright]) e.series = toTag(r[col.copyright]);
    if (!e.gender) e.gender = core.includes('1girl') ? 'girl' : core.includes('1boy') ? 'boy' : null;
    noobCount += 1;
  }
}

// deepghs first, because it is ordered by frequency and noob-wiki is not, so
// the earlier-listed tag cleanTableTraits prefers on a tie is the commoner one.
const merged = (e) => {
  const deep = new Set(e.deepghs);
  const noob = new Set(e.noob);
  return [...new Set([...e.deepghs, ...e.noob])].map((tag) => ({
    tag,
    sources: [deep.has(tag) && 'deepghs', noob.has(tag) && 'noob'].filter(Boolean),
  }));
};

const tmp = `${OUT}.new`;
for (const f of [tmp, `${tmp}-shm`, `${tmp}-wal`]) rmSync(f, { force: true });
const db = new DatabaseSync(tmp);
db.exec(`
  CREATE TABLE characters (
    tag    TEXT PRIMARY KEY,
    traits TEXT NOT NULL,
    posts  INTEGER,
    solo   INTEGER,
    gender TEXT
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const insert = db.prepare('INSERT INTO characters (tag, traits, posts, solo, gender) VALUES (?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (const [tag, e] of chars) {
  insert.run(tag, JSON.stringify(merged(e)), e.posts || null, e.solo || null, e.gender);
}
const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
meta.run('built_at', new Date().toISOString());
meta.run('characters', String(chars.size));
if (existsSync(NOOB)) meta.run('noob_wiki_sha256', sha256(NOOB));
if (existsSync(DEEPGHS)) meta.run('deepghs_sha256', sha256(DEEPGHS));
db.exec('COMMIT');
db.close();
renameSync(tmp, OUT);

console.log(`character table: ${chars.size} characters (${noobCount} from noob-wiki, ${deepghsCount} from deepghs)`);
console.log(`  wrote ${path.relative(ROOT, OUT)}`);

const series = {};
for (const [tag, e] of chars) if (e.series) series[tag] = e.series;
writeFileSync(SERIES_OUT, JSON.stringify(series));
console.log(`  wrote ${path.relative(ROOT, SERIES_OUT)} (${Object.keys(series).length} characters with a series)`);

// A few lookups as the server will see them, cleaned.
const check = new DatabaseSync(OUT, { readOnly: true });
for (const tag of ['gran_(granblue_fantasy)', 'djeeta_(granblue_fantasy)', 'power_(chainsaw_man)', 'frieren']) {
  const row = check.prepare('SELECT traits FROM characters WHERE tag = ?').get(tag);
  const kept = row ? cleanTableTraits(JSON.parse(row.traits)).map((t) => t.tag) : null;
  console.log(`  ${tag}: ${kept ? kept.join(', ') : '(not in the table)'}`);
}
check.close();
