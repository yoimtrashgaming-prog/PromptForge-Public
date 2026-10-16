// Danbooru tag database import.
//
// Deliberately Node rather than a .bat/.sh pair: it is a download and a file
// move, there is no reason to maintain it twice, and it drops the curl
// dependency.
//
// The spec says to verify the filename and branch rather than assuming
// main/danbooru_tags.csv. Verified 2026-08-18: there is no such file. The
// CSVs live on the `tag-lists` branch under DATE-STAMPED names, so this
// script enumerates the branch and takes the newest match rather than
// hardcoding one — otherwise the weekly refresh breaks the next time
// upstream publishes a dated list.
//
// Storage is node:sqlite, built into Node 22.5+. That is a deliberate choice
// over better-sqlite3: native bindings ship platform-specific binaries, and
// a copied node_modules is one of the documented ways this project breaks
// when it moves to Linux.
//
//   node scripts/update-tags.mjs [--force]

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { fetchDeprecated, applyDeprecations, markDeprecated, hasDeprecatedColumn }
  from '../server/deprecations.mjs';
import { fetchTagList, toDash } from '../server/danbooru-tags.mjs';
import { filterTags } from '../server/tagfilter.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = YAML.parse(readFileSync(path.join(ROOT, 'config/server.yaml'), 'utf8'));
const T = cfg.tags ?? {};

// "danbooru" pulls from the site itself; "github" is the old CSV path, kept
// as a fallback and for reproducing an older snapshot. See
// server/danbooru-tags.mjs for why the default moved on 7 Sep 2026.
const SOURCE = T.source ?? 'danbooru';
const MIN_POST_COUNT = T.min_post_count ?? 50;
const REPO = T.repo ?? 'BetaDoggo/danbooru-tag-list';
const BRANCH = T.branch ?? 'tag-lists';
// Case-insensitive on purpose. Upstream is inconsistent about it — the README
// links `IllustriousV1.0_dash.csv` while the actual file is
// `illustriousV1.0_dash.csv` — and a filename-case mismatch is the exact class
// of bug that works on Windows and 404s on Linux.
const PATTERN = new RegExp(T.file_pattern ?? '^danbooru-(\\d{2}-\\d{2}-\\d{2})-(dash|underscore)\\.csv$', 'i');
const VARIANTS = T.variants ?? ['underscore', 'dash'];
const DB_PATH = path.join(ROOT, T.db_path ?? 'data/tags/tags.sqlite');

// Built here, then renamed over DB_PATH once everything has succeeded.
//
// This used to write straight into the live file, opening it and running
// DROP TABLE before the first download. A download that failed partway
// through therefore left the database empty, and autocomplete dead, until
// someone noticed and re-ran. That was survivable while this was a command
// somebody typed; it is not, now that a button in the UI can trigger it.
const BUILD_PATH = DB_PATH + '.new';

// Module scope so the failure path below can close it. On Windows an open
// handle makes the build file undeletable, and the cleanup fails silently.
let db = null;

/** SQLite leaves these beside the database in WAL mode. */
function sidecars(p) {
  return [p + '-wal', p + '-shm'];
}
const FORCE = process.argv.includes('--force');

// Danbooru category codes. These drive the pill colours in the UI.
export const CATEGORY = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };

const log = (...a) => console.log('[tags]', ...a);

/** Split a CSV line, honouring the quoted alias field which contains commas. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Rank a date-stamped filename. The upstream stamps are like `12-10-24` and
 * it is not stated whether that is MM-DD-YY or DD-MM-YY. The final component
 * is unambiguously the year in every published file, so ranking on year first
 * orders correctly across years; within a single year the remaining two
 * components could tie-break wrongly. Acceptable — upstream publishes rarely,
 * and the chosen file is logged so a human can see what was picked.
 */
function rankDate(stamp) {
  const [a, b, y] = stamp.split('-').map(Number);
  return y * 10000 + Math.max(a, b) * 100 + Math.min(a, b);
}

async function listBranch() {
  const url = `https://api.github.com/repos/${REPO}/contents?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'promptforge' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} listing ${REPO}@${BRANCH}`);
  return res.json();
}

/**
 * Refresh only the deprecation flags on the database that is already there.
 *
 * Worth its own path because the full import is a 40MB download and a rebuild,
 * and this is a few hundred kilobytes of tag metadata. It is also how an
 * existing box gets the flag without waiting for a scheduled refresh - which
 * matters, because every database built before 26 Aug 2026 has none.
 */
async function deprecationsOnly() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`no tag database at ${DB_PATH} - run without --deprecations-only first`);
  }
  log("fetching danbooru deprecations");
  const { ok, names, reason } = await fetchDeprecated({
    onProgress: (page, n) => log(`  page ${page}: ${n.toLocaleString()} so far`),
  });
  if (!ok) {
    log(`could not refresh deprecations - ${reason}`);
    log("the tag database is unchanged and still usable");
    return;
  }
  if (reason) log(`partial: ${reason}`);

  const db = new DatabaseSync(DB_PATH);
  try {
    const had = hasDeprecatedColumn(db);
    const { flagged, scanned } = had ? markDeprecated(db, names) : applyDeprecations(db, names);
    if (!had) log("added the deprecated column");
    log(`${scanned.toLocaleString()} deprecated on danbooru, ${flagged.toLocaleString()} rows flagged here`);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("deprecations_updated_at", new Date().toISOString());
  } finally {
    db.close();
  }
}

/**
 * Pull the list from danbooru and write both variants into `db`.
 *
 * Returns { total, kept, dropped } so the caller can say what happened rather
 * than only how many rows landed — this project's rule about numbers is that
 * an unexplained one is worse than none.
 */
/** Fresh build file and schema. Shared so the two sources cannot drift. */
function openBuild() {
  // A leftover from a previous failed run would otherwise be appended to.
  for (const f of [BUILD_PATH, ...sidecars(BUILD_PATH)]) rmSync(f, { force: true });
  const database = new DatabaseSync(BUILD_PATH);
  database.exec(`
    PRAGMA journal_mode = WAL;
    DROP TABLE IF EXISTS tags;
    CREATE TABLE tags (
      tag        TEXT    NOT NULL,
      variant    TEXT    NOT NULL,
      category   INTEGER NOT NULL,
      post_count INTEGER NOT NULL,
      aliases    TEXT,
      -- Only ever set by the GitHub path. The danbooru API is asked for
      -- is_deprecated=no, so on that source a dead tag never arrives and
      -- there is nothing to flag.
      deprecated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return database;
}

/** Indexes, VACUUM, and the rename that makes the new file live. */
function finish(database, meta, total) {
  log('building indexes');
  database.exec(`
    CREATE INDEX idx_tags_lookup ON tags (variant, tag);
    CREATE INDEX idx_tags_rank   ON tags (variant, deprecated, post_count DESC);
  `);
  const setMeta = database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) setMeta.run(k, String(v));
  database.exec('VACUUM');
  database.close();
  // Only now is the live file touched. Sidecars are cleared on both sides: a
  // stale -wal belonging to the old database next to the new one is a
  // corruption risk, not a leftover.
  for (const f of sidecars(BUILD_PATH)) rmSync(f, { force: true });
  for (const f of sidecars(DB_PATH)) rmSync(f, { force: true });
  renameSync(BUILD_PATH, DB_PATH);
  log(`done — ${total.toLocaleString()} rows in ${path.relative(ROOT, DB_PATH)}`);
}

/** The whole danbooru path: pull, filter, write. */
async function mainFromDanbooru() {
  db = openBuild();
  const insert = db.prepare(
    'INSERT INTO tags (tag, variant, category, post_count, aliases) VALUES (?, ?, ?, ?, ?)'
  );
  const { total, live } = await importFromDanbooru(db, insert);
  finish(db, {
    updated_at: new Date().toISOString(),
    source: 'danbooru.donmai.us/tags.json',
    files: JSON.stringify([]),
    total_tags: total,
    min_post_count: MIN_POST_COUNT,
    live_tags: live,
  }, total);
}

async function importFromDanbooru(db, insert) {
  log(`pulling from danbooru (post_count >= ${MIN_POST_COUNT})`);
  const { tags, aliases, aliasError } = await fetchTagList({
    minPostCount: MIN_POST_COUNT,
    onProgress: (what, page, n) => {
      if (page % 20 === 0) log(`  ${what} page ${page}: ${n.toLocaleString()} so far`);
    },
  });
  log(`${tags.length.toLocaleString()} live tags, ${aliases.size.toLocaleString()} with aliases`);
  if (aliasError) log(`aliases incomplete — ${aliasError}; tags still imported`);

  // Then drop what could never describe a picture. A separate stage because
  // it is the one judgement in this import — see server/tagfilter.mjs — and
  // it says what it removed rather than just shrinking the number.
  const { kept, dropped, tally } = filterTags(tags);
  if (dropped.length) {
    const by = Object.entries(tally).sort((a, b) => b[1] - a[1])
      .map(([why, n]) => `${n} ${why}`).join(', ');
    log(`dropped ${dropped.length.toLocaleString()} unusable (${by})`);
    log(`preview any time with: node scripts/preview-tag-filter.mjs`);
  }

  let total = 0;
  const collisions = [];
  for (const variant of VARIANTS) {
    const spell = variant === 'dash' ? toDash : (t) => t;
    // Two different danbooru tags can spell the same in dash form, because
    // dash cannot tell a word separator from a hyphen that is part of the
    // word: `t_shirt` and an existing `t-shirt` collapse together. Undetected,
    // that is a duplicate row and a doubled autocomplete entry.
    //
    // The higher post count wins, which is the same rule the rest of this
    // project uses when danbooru disagrees with itself.
    const seen = new Map();
    for (const t of kept) {
      const spelled = spell(t.name);
      const held = seen.get(spelled);
      if (held) {
        collisions.push(`${held.name} / ${t.name} -> ${spelled}`);
        if (t.post_count > held.post_count) seen.set(spelled, t);
        continue;
      }
      seen.set(spelled, t);
    }

    db.exec('BEGIN');
    for (const [spelled, t] of seen) {
      const alias = (aliases.get(t.name) ?? []).map(spell).join(',');
      insert.run(spelled, variant, t.category, t.post_count, alias);
      total += 1;
    }
    db.exec('COMMIT');
    log(`${variant}: imported ${seen.size.toLocaleString()} tags`);
  }

  if (collisions.length) {
    log(`${collisions.length} dash-spelling collision(s), highest post count kept`);
    for (const c of collisions.slice(0, 5)) log(`  ${c}`);
    if (collisions.length > 5) log(`  ... and ${collisions.length - 5} more`);
  }
  return { total, live: kept.length };
}

async function main() {
  if (process.argv.includes("--deprecations-only")) return deprecationsOnly();

  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // ── source: danbooru ──
  // The default since 7 Sep 2026. Everything below this block is the old
  // GitHub CSV path, kept because it still works and because reproducing an
  // older snapshot is occasionally what you want — set tags.source: "github".
  if (SOURCE === 'danbooru') return await mainFromDanbooru();

  log(`listing ${REPO}@${BRANCH}`);
  const files = await listBranch();

  // Pick the newest dated file per variant.
  const chosen = new Map();
  for (const f of files) {
    const m = PATTERN.exec(f.name);
    if (!m) continue;
    const [, stamp, variant] = m;
    if (!VARIANTS.includes(variant)) continue;
    const prev = chosen.get(variant);
    if (!prev || rankDate(stamp) > rankDate(prev.stamp)) {
      chosen.set(variant, { stamp, name: f.name, size: f.size });
    }
  }

  if (chosen.size === 0) {
    throw new Error(
      `no file on ${BRANCH} matched ${PATTERN}. Upstream may have renamed things — ` +
        `check the branch and update tags.file_pattern in config/server.yaml.`
    );
  }

  for (const [variant, f] of chosen) {
    log(`${variant}: ${f.name} (${(f.size / 1e6).toFixed(1)} MB)`);
  }

  // Illustrious wants underscores, Pony and SDXL want the spaced/dash form,
  // so both variants are imported and the registry's tag_style selects.
  // Start from a clean build file — a leftover from a previous failed run
  // would otherwise be appended to.
  for (const f of [BUILD_PATH, ...sidecars(BUILD_PATH)]) rmSync(f, { force: true });

  db = new DatabaseSync(BUILD_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    DROP TABLE IF EXISTS tags;
    CREATE TABLE tags (
      tag        TEXT    NOT NULL,
      variant    TEXT    NOT NULL,
      category   INTEGER NOT NULL,
      post_count INTEGER NOT NULL,
      aliases    TEXT,
      -- Danbooru deprecates tags — misspellings, retired names, ones that got
      -- split — and zeroes their post count when it does. The upstream CSV is
      -- a snapshot from before that, so a deprecated tag still carries the
      -- count it had while it was alive. Flagged rather than dropped; see
      -- server/deprecations.mjs for why the alias path still resolves them.
      deprecated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  const insert = db.prepare(
    'INSERT INTO tags (tag, variant, category, post_count, aliases) VALUES (?, ?, ?, ?, ?)'
  );

  let total = 0;
  for (const [variant, f] of chosen) {
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f.name}`;
    log(`downloading ${f.name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
    const text = await res.text();

    let n = 0;
    db.exec('BEGIN');
    // Upstream ships CRLF. Splitting on \n alone leaves a trailing \r glued to
    // the last field, which then shows up inside alias lists in the UI.
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [tag, cat, count, aliases] = splitCsvLine(line.trim());
      if (!tag) continue;
      const category = Number(cat);
      const postCount = Number(count);
      if (!Number.isFinite(category) || !Number.isFinite(postCount)) continue;
      // Drop empty alias entries so the UI never renders a blank chip.
      const cleanAliases = (aliases ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
        .join(',');
      insert.run(tag, variant, category, postCount, cleanAliases);
      n++;
    }
    db.exec('COMMIT');
    log(`${variant}: imported ${n.toLocaleString()} tags`);
    total += n;
  }

  // Indexes after bulk insert — much faster than maintaining them during.
  log('building indexes');
  db.exec(`
    CREATE INDEX idx_tags_lookup ON tags (variant, tag);
    CREATE INDEX idx_tags_rank   ON tags (variant, deprecated, post_count DESC);
  `);

  // Deprecations last, and never fatal. A tag database without the flag is
  // worse than one with it, not broken — so a network failure here logs and
  // the import still lands.
  log('fetching danbooru deprecations');
  const dep = await fetchDeprecated({
    onProgress: (page, n) => log(`  page ${page}: ${n.toLocaleString()} so far`),
  });
  if (dep.ok) {
    if (dep.reason) log(`partial: ${dep.reason}`);
    const { flagged, scanned } = markDeprecated(db, dep.names);
    log(`${scanned.toLocaleString()} deprecated on danbooru, ${flagged.toLocaleString()} rows flagged here`);
  } else {
    log(`deprecations not refreshed — ${dep.reason}`);
    log('every tag is left unflagged; autocomplete still works');
  }

  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  setMeta.run('updated_at', new Date().toISOString());
  setMeta.run('source', `${REPO}@${BRANCH}`);
  setMeta.run('files', JSON.stringify([...chosen.values()].map((f) => f.name)));
  setMeta.run('total_tags', String(total));
  if (dep.ok) setMeta.run('deprecations_updated_at', new Date().toISOString());

  db.exec('VACUUM');
  db.close();

  // Only now is the live file touched. Sidecars are cleared on both sides:
  // a stale -wal belonging to the old database next to the new one is a
  // corruption risk, not a leftover.
  for (const f of sidecars(BUILD_PATH)) rmSync(f, { force: true });
  for (const f of sidecars(DB_PATH)) rmSync(f, { force: true });
  renameSync(BUILD_PATH, DB_PATH);

  log(`done — ${total.toLocaleString()} rows in ${path.relative(ROOT, DB_PATH)}`);
}

main().catch((err) => {
  console.error(`[tags] FAILED: ${err.message}`);
  // The live database is untouched — it is only ever replaced by the rename
  // at the end of a successful run — so the failure costs nothing but the
  // download. Clear the half-built file rather than leaving 16 MB behind; the
  // next run would overwrite it anyway, but not before someone wonders what
  // it is.
  // Close first. An open handle makes the delete fail on Windows, and it
  // fails into the catch below rather than saying anything — which is how
  // the first version of this cleanup appeared to work while leaving 16 MB
  // of build files behind every time.
  try {
    db?.close();
  } catch {
    /* already closed, or never opened */
  }
  for (const f of [BUILD_PATH, BUILD_PATH + '-wal', BUILD_PATH + '-shm']) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* a locked build file is not worth failing twice over */
    }
  }
  // The app must still boot without this database; a failed update is not
  // fatal to anything but autocomplete.
  process.exit(1);
});
