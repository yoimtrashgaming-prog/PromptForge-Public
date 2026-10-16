// Two ways to answer "what does this character look like", side by side.
//
//   node scripts/probe-traits.mjs
//   node scripts/probe-traits.mjs --characters frieren,makima
//
// Needs a network connection. No GPU, no model, no server. Caches every fetch
// under the scratch directory so a re-run costs nothing and danbooru is asked
// once per character per approach.
//
// ── why this exists ──
//
// The owner's screenshot of Frieren's "Usual appearance and outfit" panel
// offered `thick_eyebrows` at 16%, `striped_shirt` at 13% and
// `black_pantyhose` at 14%. Frieren wears white. Those are not deprecated
// tags — that is a separate problem, fixed separately — they are sampling
// noise out of server/traits.mjs, which fetches 100 posts and ranks by lift.
//
// There are two candidate fixes and the plan was explicit that they should be
// MEASURED against each other rather than guessed between:
//
//   A  the sampler we have, with its thresholds tuned
//   B  danbooru's own /related_tag endpoint, which returns co-occurrence
//      frequency over the whole corpus with no sampling at all
//
// B also carries `cosine_similarity`, which is the same idea as our `lift` —
// how much more this tag belongs to this character than to danbooru at large
// — but computed across every post rather than across a hundred of them.
//
// ── what this does NOT do ──
//
// It changes nothing. It prints a table and writes a note. Which approach wins
// is the owner's call, and the number that decides it is not one this script
// can compute: "how many of these are WRONG for the character" needs someone
// who knows what Frieren wears. The script marks the candidates; a person
// marks the errors.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { rankTraits } from '../server/traits.mjs';
import { createTagStore } from '../server/tags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'probe-cache');
const BASE = 'https://danbooru.donmai.us';

// The five the tuning comments in config/server.yaml already cite, so the
// numbers here can be read against the ones already written down there.
const DEFAULT_CHARACTERS = [
  'frieren',
  // `makima` alone is NOT the character tag: danbooru has it as a category-0
  // general tag with 0 posts, and the character is `makima_(chainsaw_man)`.
  // The tuning comments in config/server.yaml cite "makima" and were measured
  // against something that no longer resolves — see the write-up.
  'makima_(chainsaw_man)',
  'fern_(sousou_no_frieren)',
  'gojo_satoru',
  'hatsune_miku',
];

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
};

const characters = (arg('characters') ?? '').trim()
  ? arg('characters').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_CHARACTERS;

mkdirSync(CACHE, { recursive: true });

/** Fetch once, then read from disk forever. danbooru is somebody else's box. */
async function cached(key, url) {
  const file = path.join(CACHE, `${key.replace(/[^a-z0-9_.-]/gi, '_')}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(url, { headers: { 'user-agent': 'PromptForge/2.0 (trait probe)' } });
  if (!res.ok) throw new Error(`${res.status} on ${url}`);
  const body = await res.json();
  writeFileSync(file, JSON.stringify(body), 'utf8');
  return body;
}

const cfg = YAML.parse(readFileSync(path.join(ROOT, 'config', 'server.yaml'), 'utf8'));
const traitCfg = cfg.traits ?? {};
const tags = createTagStore(ROOT, cfg, { warn: () => {} });
if (!tags.loaded) {
  console.error('No tag database. Run `npm run update-tags` first — approach A needs it for lift.');
  process.exit(1);
}

/** Approach A: what server/traits.mjs does today. */
async function sampler(character) {
  const query = traitCfg.rating_filter
    ? `${character} rating:${traitCfg.rating_filter}`
    : character;
  const posts = await cached(
    `posts_${character}`,
    `${BASE}/posts.json?tags=${encodeURIComponent(query)}&limit=${traitCfg.fetch_limit ?? 100}`
  );
  // Only posts where this character is the only character — a post with two
  // cannot say which one the tags belong to.
  const solo = posts.filter((p) => String(p.tag_string_character ?? '').split(' ').filter(Boolean).length === 1);
  const mixed = solo.length < (traitCfg.min_sample ?? 12);
  const used = mixed ? posts : solo;

  const tally = new Map();
  for (const p of used) {
    for (const t of String(p.tag_string_general ?? '').split(' ').filter(Boolean)) {
      tally.set(t, (tally.get(t) ?? 0) + 1);
    }
  }
  const traits = rankTraits(
    tally, used.length,
    (t) => tags.postCount(t),
    traitCfg,
    (t) => tags.isDeprecated(t)
  );
  return { traits: traits.map((t) => ({ tag: t.tag, score: t.share, extra: `lift ${t.lift.toFixed(1)}` })), sampled: used.length, mixed };
}

/** Approach B: danbooru's own co-occurrence, over every post. */
async function related(character) {
  const body = await cached(
    `related_${character}`,
    `${BASE}/related_tag.json?query=${encodeURIComponent(character)}&category=general&limit=50`
  );
  const rows = (body.related_tags ?? [])
    // Deprecated tags come marked, so this half is free here.
    .filter((r) => r?.tag && !r.tag.is_deprecated)
    // Same two gates the sampler applies, so the comparison is like for like:
    // common enough on this character, and distinctive rather than furniture.
    .filter((r) => Number(r.frequency) >= (traitCfg.min_share ?? 0.25))
    // cosine_similarity is /related_tag's answer to lift. 0.05 is the floor
    // that drops `long_hair` (0.039) while keeping `twintails` (0.081) on
    // Frieren — chosen by looking, and the number most worth arguing with.
    .filter((r) => Number(r.cosine_similarity) >= 0.05)
    .sort((a, b) => b.cosine_similarity - a.cosine_similarity)
    .slice(0, traitCfg.max_traits ?? 30);
  return {
    traits: rows.map((r) => ({
      tag: r.tag.name,
      score: r.frequency,
      extra: `cos ${Number(r.cosine_similarity).toFixed(3)}`,
    })),
    sampled: body.post_count ?? null,
    mixed: false,
  };
}

const lines = [];
const say = (s = '') => { console.log(s); lines.push(s); };

say(`# Character traits — two approaches, ${new Date().toISOString().slice(0, 10)}`);
say('');
say('Generated by `node scripts/probe-traits.mjs`. Nothing was changed by it.');
say('');
say('**A** is `server/traits.mjs` as it stands: 100 posts sampled, ranked by lift.');
say('**B** is danbooru\'s `/related_tag`: co-occurrence over every post, ranked by');
say('cosine similarity, with deprecated tags dropped (they arrive marked).');
say('');

for (const character of characters) {
  say(`## ${character}`);
  say('');
  let a; let b;
  try { a = await sampler(character); } catch (err) { say(`A failed: ${err.message}`); }
  try { b = await related(character); } catch (err) { say(`B failed: ${err.message}`); }
  if (!a || !b) { say(''); continue; }

  say(`A — ${a.traits.length} traits from ${a.sampled} sampled posts${a.mixed ? ' **(mixed: too few solo posts, may include others)**' : ''}`);
  say(`B — ${b.traits.length} traits from ${b.sampled?.toLocaleString() ?? '?'} posts, unsampled`);
  say('');
  say('| # | A (sampler) | | B (related_tag) | |');
  say('|---|---|---|---|---|');
  const rows = Math.max(a.traits.length, b.traits.length);
  for (let i = 0; i < rows; i += 1) {
    const x = a.traits[i];
    const y = b.traits[i];
    say(`| ${i + 1} | ${x ? x.tag : ''} | ${x ? `${Math.round(x.score * 100)}% · ${x.extra}` : ''} | ${y ? y.tag : ''} | ${y ? `${Math.round(y.score * 100)}% · ${y.extra}` : ''} |`);
  }
  say('');

  const setA = new Set(a.traits.map((t) => t.tag));
  const setB = new Set(b.traits.map((t) => t.tag));
  const onlyA = [...setA].filter((t) => !setB.has(t));
  const onlyB = [...setB].filter((t) => !setA.has(t));
  say(`Only A: ${onlyA.length ? onlyA.join(', ') : '—'}`);
  say('');
  say(`Only B: ${onlyB.length ? onlyB.join(', ') : '—'}`);
  say('');
  say('**Wrong for this character:** _fill in by hand — this is the number that decides it._');
  say('');
}

const out = path.join(ROOT, 'docs', `traits-eval-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`\nwritten to ${path.relative(ROOT, out)}`);
