// Find character-table rows that describe a co-star instead of the character.
//
//   node scripts/table-contamination-sweep.mjs                 offline pass only
//   node scripts/table-contamination-sweep.mjs --live [--limit 300]
//
// Run it ON THE P40: it reads data/tags/character_traits.sqlite, the two source
// lists behind it, and the tag database; --live asks danbooru too.
//
// ── what it is for ──
//
// Ainz Ooal Gown's table row is Albedo's look plus his skeleton. His live
// sample was clean, so no companion was found and nothing subtracted her, and
// the merge appended her wings and breasts under his skull. The fix is
// `table_contaminants` in config/same-person.yaml; this finds the rest.
//
// ── what it does ──
//
//   1. Offline. For every character in their own posts less than half the time
//      (a solo character's row is built from solo posts and cannot be mixed),
//      find the same-franchise character whose row contains most of theirs,
//      weighting each tag by how rare it is on danbooru so that `long_hair`
//      proves nothing and `demon_wings` proves a lot. Already-listed identities
//      are skipped — a second name for the same face is supposed to match.
//   2. --live. For each suspect, the real lookup twice: as it is, and with the
//      co-star listed. Reports what listing would remove, next to the live
//      sample's own traits, so a human can tell Albedo-on-Ainz from twins.
//
// ── the verdicts are suspects, not answers ──
//
// Two characters can share a row honestly: twins, a uniform, a recolour, a
// mascot drawn as its owner. A suspect is worth listing only when the removed
// traits are visibly not this character. Read every one.
//
// Output: logs/table-contamination/suspects.json (+ live.json, report.txt).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.mjs';
import { createTagStore } from '../server/tags.mjs';
import { createTraitStore, buildIdentityGroups, companionsIn } from '../server/traits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const LIVE = argv.includes('--live');
const LIMIT = Number(flag('--limit', 400));
const MIN_POSTS = Number(flag('--min', 100));
const MAX_SOLO = Number(flag('--solo', 0.5));
const MIN_SCORE = Number(flag('--score', 0.7));
// The co-star must have at least this share of the character's posts. The
// contaminant is usually the one drawn more (Albedo 1,573 to Ainz's 310), but
// not always: Pikachu's row carries Ash's cap, and Ash has fewer posts.
const MIN_RATIO = Number(flag('--ratio', 0.3));
// The shared tags must weigh this much in total, so a row that is only
// `no_humans, pokemon_(creature)` is not a match with every other Pokemon.
const MIN_WEIGHT = Number(flag('--weight', 8));
const OUT = path.join(ROOT, 'logs', 'table-contamination');
mkdirSync(OUT, { recursive: true });

const FRAMING = new Set(['1girl', '1boy', '1other', 'solo', 'male_focus', 'female', 'male', 'breasts']);

// ── the table ──
const table = new DatabaseSync(path.join(ROOT, 'data', 'tags', 'character_traits.sqlite'), { readOnly: true });
const rows = new Map();
for (const r of table.prepare('SELECT tag, traits, posts, solo, gender FROM characters').all()) {
  const tags = JSON.parse(r.traits).map((t) => t.tag).filter((t) => !FRAMING.has(t));
  rows.set(r.tag, { tag: r.tag, tags, posts: r.posts ?? 0, solo: r.solo ?? 0, gender: r.gender });
}
table.close();

// ── franchises, from both source lists ──
const copyrights = new Map();
const addCr = (tag, cr) => {
  if (!tag || !cr) return;
  if (!copyrights.has(tag)) copyrights.set(tag, new Set());
  copyrights.get(tag).add(cr);
};
const csv = readFileSync(path.join(ROOT, 'data', 'tags', 'danbooru_character.csv'), 'utf8');
for (const line of csv.split('\n').slice(1)) {
  // character,copyright,... — neither of the first two fields is ever quoted.
  const [tag, cr] = line.split(',', 2);
  for (const c of (cr ?? '').split(' ')) addCr(tag, c);
}
for (const e of JSON.parse(readFileSync(path.join(ROOT, 'data', 'tags', 'deepghs_characters.json'), 'utf8'))) {
  for (const c of e.copyrights ?? [e.copyright]) addCr(e.tag, c);
}
const byCopyright = new Map();
for (const [tag, crs] of copyrights) {
  if (!rows.has(tag)) continue;
  for (const c of crs) {
    if (!byCopyright.has(c)) byCopyright.set(c, []);
    byCopyright.get(c).push(tag);
  }
}

// ── rarity weights ──
const { config } = loadConfig(ROOT, 'server');
const tagStore = createTagStore(ROOT, config, { warn: () => {} });
const TOTAL_POSTS = 9_000_000;
const weight = (t) => Math.log(TOTAL_POSTS / Math.max(tagStore.postCount(t) || 0, 1000));

// ── identities, so a second name for the same face is not a suspect ──
const declared = loadConfig(ROOT, 'same-person').config ?? {};
const groups = buildIdentityGroups(declared.same_person ?? []);
const suffixes = new Set((declared.same_person_suffixes ?? []).map(String));
const prefixes = new Set((declared.same_person_prefixes ?? []).map(String));
const samePerson = (a, b) => companionsIn(a, Array.from({ length: 4 }, () => ({
  tag_string_character: `${a} ${b}`, tag_string_general: 'x',
})), 0.5, groups, suffixes, prefixes).length === 0;
// --all keeps characters already listed, to check the pass still finds them.
const listed = new Set(argv.includes('--all') ? [] : Object.keys(declared.table_contaminants ?? {}));

// ── 1. offline ──
const suspects = [];
for (const c of rows.values()) {
  if (c.posts < MIN_POSTS || !c.tags.length || c.solo / c.posts >= MAX_SOLO || listed.has(c.tag)) continue;
  const total = c.tags.reduce((s, t) => s + weight(t), 0);
  if (total <= 0) continue;
  let best = null;
  const seen = new Set();
  for (const cr of copyrights.get(c.tag) ?? []) {
    for (const xTag of byCopyright.get(cr) ?? []) {
      if (xTag === c.tag || seen.has(xTag)) continue;
      seen.add(xTag);
      const x = rows.get(xTag);
      const xs = new Set(x.tags);
      const shared = c.tags.filter((t) => xs.has(t));
      if (x.posts < c.posts * MIN_RATIO) continue;
      const sharedWeight = shared.reduce((s, t) => s + weight(t), 0);
      if (sharedWeight < MIN_WEIGHT) continue;
      const score = sharedWeight / total;
      if (!best || score > best.score) best = { x: xTag, score, shared };
    }
  }
  if (!best || best.score < MIN_SCORE) continue;
  if (samePerson(c.tag, best.x)) continue;
  suspects.push({
    tag: c.tag, posts: c.posts, solo: c.solo, gender: c.gender,
    costar: best.x, costar_posts: rows.get(best.x).posts, costar_gender: rows.get(best.x).gender,
    score: Number(best.score.toFixed(3)), row: c.tags, shared: best.shared,
  });
}
suspects.sort((a, b) => b.posts - a.posts);
writeFileSync(path.join(OUT, 'suspects.json'), JSON.stringify(suspects, null, 2));
console.log(`offline: ${suspects.length} suspects from ${rows.size} rows (posts>=${MIN_POSTS}, solo<${MAX_SOLO}, score>=${MIN_SCORE})`);
if (!LIVE) process.exit(0);

// ── 2. live ──
// A copy of the app's cache, so answers already fetched cost nothing and the
// running server's cache is never written.
const cachePath = path.join('data', 'tags', 'sweep-tc.sqlite');
const appCache = path.join(ROOT, config.traits?.db_path ?? 'data/tags/traits.sqlite');
if (!existsSync(path.join(ROOT, cachePath)) && existsSync(appCache)) copyFileSync(appCache, path.join(ROOT, cachePath));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
// Polite and patient: one request at a time, and a 429 or a Cloudflare page
// waits and retries instead of reading as "no posts".
const politeFetch = async (url, init) => {
  for (let attempt = 0; ; attempt += 1) {
    const wait = last + 700 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(url, { ...init, headers: { 'user-agent': 'promptforge-sweep', ...(init?.headers ?? {}) } });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await sleep(5000 * (attempt + 1)); continue; }
    return res;
  }
};
const store = (extra) => createTraitStore(ROOT, {
  ...config, traits: { ...config.traits, db_path: cachePath, ...extra },
}, { warn: () => {}, fetchImpl: politeFetch });

const results = [];
const report = [];
let n = 0;
// One danbooru stream at a time: parallel sweeps drew Cloudflare challenges.
// Wait while an identity sweep from another session is running.
const otherSweep = () => {
  // The bracket keeps pgrep from matching the shell that runs it.
  try { return execSync('pgrep -f "identity-swee[p].mjs"',{ encoding: 'utf8' }).trim().length > 0; } catch { return false; }
};
for (const s of suspects.slice(0, LIMIT)) {
  n += 1;
  if (otherSweep()) {
    console.log('  waiting: another sweep is running');
    while (otherSweep()) await sleep(30000);
  }
  try {
    const plain = store({ table_contaminants: {} });
    const fixed = store({ table_contaminants: { [s.tag]: [s.costar] } });
    const before = await plain.lookup(s.tag, tagStore);
    const after = await fixed.lookup(s.tag, tagStore);
    const live = await plain.liveLookup(s.tag, tagStore);
    plain.close(); fixed.close();
    const b = (before.traits ?? []).map((t) => t.tag);
    const a = (after.traits ?? []).map((t) => t.tag);
    const removed = b.filter((t) => !a.includes(t));
    const row = {
      ...s, source: before.source, live_mixed: Boolean(live.mixed), companion: before.companion ?? null,
      live: (live.traits ?? []).map((t) => t.tag), removed, after: a,
    };
    results.push(row);
    if (removed.length) {
      report.push(`[${removed.length}] ${s.tag} (${s.posts} posts, ${s.solo} solo) <- ${s.costar} score ${s.score}`
        + `\n   live:    ${row.live.join(', ') || '(none)'}${row.live_mixed ? '  [mixed]' : ''}`
        + `\n   removed: ${removed.join(', ')}`
        + `\n   after:   ${a.join(', ')}\n`);
    }
  } catch (err) {
    results.push({ ...s, error: String(err) });
  }
  if (n % 10 === 0) {
    console.log(`  live ${n}/${Math.min(LIMIT, suspects.length)}`);
    writeFileSync(path.join(OUT, 'live.json'), JSON.stringify(results, null, 2));
    writeFileSync(path.join(OUT, 'report.txt'), report.join('\n'));
  }
}
writeFileSync(path.join(OUT, 'live.json'), JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, 'report.txt'), report.join('\n'));
console.log(`live: ${results.length} checked, ${report.length} would change, ${results.filter((r) => r.error).length} errors`);
