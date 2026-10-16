// Find the tags in one franchise that might name a character twice.
//
//   node scripts/identity-sweep.mjs <label> --suffix "<regex>" [--min 100]
//   node scripts/identity-sweep.mjs <label> --copyright <tag> [<tag> ...] [--min 100]
//
//   node scripts/identity-sweep.mjs genshin --suffix "_\(genshin_impact\)$"
//   node scripts/identity-sweep.mjs holo --copyright hololive hololive_english
//
// Run it ON THE P40: --suffix reads data/tags/tags.sqlite, and both ask danbooru
// a few thousand questions at a polite pace — a big franchise takes 20-40
// minutes. Reports go to logs/identity-sweeps/, which git ignores.
//
// ── what it is for ──
//
// The trait lookup subtracts a co-star's traits from a character who is never
// drawn alone, because otherwise Dodoco comes back as Klee. That is right for a
// companion and destroys a character drawn under two tags: subtract Scaramouche
// from Wanderer and his face goes. Nothing in the numbers separates the two
// (see config/same-person.yaml), so the second kind is listed by hand. This
// finds the candidates, so the hand only has to judge them.
//
// ── what it does ──
//
// For every character with at least --min posts:
//   1. Count posts where it is the only character. 12 or more means its
//      sample is never mixed and subtraction never touches it: skipped.
//   2. Otherwise sample 100 posts and find any other character in half of
//      them — the co-star that would be subtracted.
//   3. Read the character's danbooru wiki page for sentences naming that
//      co-star, and guess a verdict from the wording.
//
// ── the verdicts are proposals, not answers ──
//
// Read every one. Measured over nine franchises, they are wrong often enough
// to matter:
//   SAME       "an alternate version of", "true identity", "incarnation". Also
//              fires on "Hyacine's summonable memosprite" (a companion) and on
//              "Hinata" containing "Hina" (two different girls).
//   COMPANION  "pet", "familiar", "sister". Usually right.
//   BOTH       both kinds of word — Pollux is Castor's genderswapped TWIN.
//   UNCLEAR    the wiki names the co-star without either kind of word.
//   NO-MENTION the wiki never names them. Most rows; mostly companions.
//
// --copyright builds its roster from danbooru's related tags, which also brings
// in whoever else is drawn alongside — a Hololive sweep proposes Spider-Man.
// Judge those on their own merits or ignore them.
//
// When a verdict is unclear, measure it instead of arguing it: build a store
// with and without the pair grouped and compare what comes back. See
// docs/character-identities.md.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'logs', 'identity-sweeps');

const argv = process.argv.slice(2);
const label = argv[0];
const minIdx = argv.indexOf('--min');
const MIN_POSTS = minIdx === -1 ? 100 : Number(argv[minIdx + 1]);
const sfxIdx = argv.indexOf('--suffix');
const crIdx = argv.indexOf('--copyright');

if (!label || label.startsWith('--') || (sfxIdx === -1 && crIdx === -1)) {
  console.error('usage: identity-sweep.mjs <label> (--suffix "<regex>" | --copyright <tag> ...) [--min 100]');
  process.exit(2);
}

// Must match what server/traits.mjs does, or the sweep answers a different
// question from the one the lookup asks.
const MIN_SOLO = 12; // traits.min_sample
const SHARE = 0.5; // traits.companion_share

const UA = { 'User-Agent': 'PromptForge/2.0 (private local tool)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAILED = [];
const get = async (url) => {
  const waits = [2000, 15000, 45000, 90000, 180000];
  for (let i = 0; i <= waits.length; i += 1) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.includes('json')) return res.json();
      process.stderr.write(`  blocked ${res.status} ${type.split(';')[0]} try ${i + 1}\n`);
    } catch (e) { process.stderr.write(`  fetch error ${e}\n`); }
    if (i < waits.length) await sleep(waits[i]);
  }
  FAILED.push(url);
  return undefined;
};
const enc = encodeURIComponent;
const bare = (t) => (t.includes('_(') ? t.slice(0, t.indexOf('_(')) : t);
const flat = (s) => String(s).toLowerCase().replace(/_/g, ' ');
// Whole words, not substrings: "ui" must not match "swimsuit".
const namesIt = (sentence, name) => {
  const h = ` ${flat(sentence).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  return h.includes(` ${name} `) || h.includes(` ${name}'s `);
};

const SAME = /\b(alternate|alter ego|incarnation|identity|another name|another version|also known as|second form|form of|human form|true (?:name|form)|playable (?:as|under)|genderbend|genderswap|version of|variant|aspect|counterpart|past life|previous incarnation|reincarnation|persona|manifestation|remodel)\b/i;
const OTHER = /\b(pet|familiar|companion|mount|brother|sister|sibling|daughter|son|mother|father|friend|rival|accompan\w+|owned by|belongs to|classmate|teammate|twin|mascot|fanbase|summon\w*|memosprite)\b/i;

async function roster() {
  const found = new Map();
  if (sfxIdx !== -1) {
    const re = new RegExp(argv[sfxIdx + 1], 'i');
    const db = new DatabaseSync(path.join(ROOT, 'data', 'tags', 'tags.sqlite'), { readOnly: true });
    for (const r of db
      .prepare("select tag, post_count from tags where variant = 'underscore' and category = 4 and post_count >= ?")
      .all(MIN_POSTS)) {
      if (re.test(r.tag)) found.set(r.tag, r.post_count);
    }
    db.close();
  }
  if (crIdx !== -1) {
    // Every argument after --copyright up to the next flag.
    const tags = [];
    for (let i = crIdx + 1; i < argv.length && !argv[i].startsWith('--'); i += 1) tags.push(argv[i]);
    for (const cr of tags) {
      const rel = await get(`https://danbooru.donmai.us/related_tag.json?query=${enc(cr)}&category=character&limit=1000`);
      await sleep(600);
      for (const r of rel?.related_tags ?? []) {
        const t = r?.tag?.name;
        const n = r?.tag?.post_count ?? 0;
        // Crossover guests: keep a character only if a fifth of its posts are this franchise.
        const co = (r?.frequency ?? 0) * (rel?.post_count ?? 0);
        if (n && co / n < 0.2) continue;
        if (t && n >= MIN_POSTS && !found.has(t)) found.set(t, n);
      }
    }
  }
  return [...found.entries()].map(([tag, posts]) => ({ tag, posts })).sort((a, b) => b.posts - a.posts);
}

mkdirSync(OUT, { recursive: true });
const REPORT = path.join(OUT, `${label}-report.txt`);
const list = await roster();
writeFileSync(REPORT, `${label}: ${list.length} characters with >=${MIN_POSTS} posts\n\n`);
console.log(`${label}: ${list.length} characters — report at ${path.relative(ROOT, REPORT)}`);

const results = [];
let n = 0;
for (const c of list) {
  n += 1;
  if (n % 25 === 0) process.stderr.write(`  ${label} ${n}/${list.length}\n`);

  const cnt = await get(`https://danbooru.donmai.us/counts/posts.json?tags=${enc(`${c.tag} chartags:1 rating:general`)}`);
  await sleep(900);
  if (cnt === undefined) { appendFileSync(REPORT, `[FAILED] ${c.tag} solo count\n\n`); continue; }
  if ((cnt?.counts?.posts ?? 0) >= MIN_SOLO) continue;

  const posts = await get(`https://danbooru.donmai.us/posts.json?tags=${enc(`${c.tag} rating:general`)}&limit=100`);
  await sleep(900);
  if (posts === undefined) { appendFileSync(REPORT, `[FAILED] ${c.tag} posts\n\n`); continue; }
  if (!Array.isArray(posts) || !posts.length) continue;

  const self = bare(c.tag);
  const seen = new Map();
  for (const p of posts) {
    for (const o of String(p.tag_string_character ?? '').split(' ').filter(Boolean)) {
      if (o === c.tag || bare(o) === self) continue;
      seen.set(o, (seen.get(o) ?? 0) + 1);
    }
  }
  const top = [...seen.entries()].filter(([, k]) => k / posts.length >= SHARE).sort((a, b) => b[1] - a[1]);
  if (!top.length) continue;

  const w = await get(`https://danbooru.donmai.us/wiki_pages.json?search%5Btitle%5D=${enc(c.tag)}`);
  await sleep(900);
  if (w === undefined) appendFileSync(REPORT, `[FAILED] ${c.tag} wiki\n\n`);
  const body = String(w?.[0]?.body ?? '').replace(/\s+/g, ' ');
  const sentences = body.split(/(?<=[.!?])\s/);

  for (const [comp, k] of top) {
    const hits = sentences.filter((s) => namesIt(s, flat(bare(comp))));
    const joined = hits.join(' ');
    const same = SAME.test(joined);
    const other = OTHER.test(joined);
    const row = {
      tag: c.tag,
      posts: c.posts,
      companion: comp,
      share: +(k / posts.length).toFixed(2),
      verdict: !joined ? 'NO-MENTION' : same && !other ? 'SAME' : same && other ? 'BOTH' : other ? 'COMPANION' : 'UNCLEAR',
      evidence: hits.slice(0, 2).join(' ').slice(0, 260),
      opening: body.slice(0, 200),
    };
    results.push(row);
    appendFileSync(REPORT,
      `[${row.verdict}] ${row.tag} (${row.posts}) + ${row.companion} ${Math.round(row.share * 100)}%\n` +
      `   ${row.evidence || '(the wiki never names them)'}\n   opening: ${row.opening || '(no wiki page)'}\n\n`);
  }
}

writeFileSync(path.join(OUT, `${label}-verdicts.json`), JSON.stringify(results, null, 2));
const count = {};
for (const r of results) count[r.verdict] = (count[r.verdict] ?? 0) + 1;
console.log(`${label}: ${JSON.stringify(count)} failed=${FAILED.length}`);
