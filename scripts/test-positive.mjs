// Invented tags and duplicates in a positive prompt.
//
//   node scripts/test-positive.mjs
//
// No server, no model, no network.
//
// The rule under test is narrower than it first looks. Most of a good positive
// prompt is NOT danbooru vocabulary - `masterpiece`, `score_9`, `newest`,
// `soft_lighting` are all absent from the tag database and all correct - so
// unknown tags are kept. Only unknown PARENTHESISED tags are dropped, because
// `name_(series)` is a pure danbooru convention and an unknown wearing that
// shape is invented. server/positive.mjs carries the full argument and the
// measured evidence.

import { cleanPositive } from '../server/positive.mjs';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

// A stand-in for the real database: the four tags below are the only ones
// that exist. Mirrors the live counts - `frieren` is real at 8,253 posts,
// `frieren_(frieren)` is not a tag at all.
const REAL = new Set(['frieren', 'fern_(sousou_no_frieren)', '1girl', 'solo']);
const known = (t) => REAL.has(String(t).trim().toLowerCase());

// ── the reported case ────────────────────────────────────────
// Verbatim from a run on 1 Sep 2026: illustrious asked for "frieren sitting
// in a coffee shop", through the app so the character lookup had already
// supplied her traits. `frieren` appears twice and once more invented.
{
  const out = cleanPositive(
    'masterpiece, best_quality, frieren, frieren_(frieren), frieren, solo, 1girl, soft_lighting',
    { known }
  );
  check('the invented parenthesised tag is removed',
    !out.cleaned.includes('frieren_(frieren)'), out.cleaned);
  check('it is reported as invented',
    out.removed.invented.includes('frieren_(frieren)'), JSON.stringify(out.removed));
  check('the duplicate frieren is removed',
    (out.cleaned.match(/\bfrieren\b/g) ?? []).length === 1, out.cleaned);
  check('the real frieren survives', /\bfrieren\b/.test(out.cleaned), out.cleaned);
}

// ── unknown does not mean invented ───────────────────────────
// The whole reason this is not a blanket strip. Every tag here is absent from
// the database and every one of them is correct.
{
  const out = cleanPositive(
    'masterpiece, best_quality, very_aesthetic, score_9, score_8, newest, safe, soft_lighting, coffee_shop',
    { known }
  );
  check('quality preset tags survive being unknown',
    out.cleaned.includes('masterpiece') && out.cleaned.includes('very_aesthetic'), out.cleaned);
  check("pony's score ladder survives",
    out.cleaned.includes('score_9') && out.cleaned.includes('score_8'), out.cleaned);
  check("anima's required tags survive",
    out.cleaned.includes('newest') && out.cleaned.includes('safe'), out.cleaned);
  check('ordinary descriptive tags survive',
    out.cleaned.includes('soft_lighting') && out.cleaned.includes('coffee_shop'), out.cleaned);
  check('nothing was removed at all', out.removed.invented.length === 0, JSON.stringify(out.removed));
}

// ── a real parenthesised tag is not invented ─────────────────
{
  const out = cleanPositive('fern_(sousou_no_frieren), 1girl', { known });
  check('a parenthesised tag that exists is kept',
    out.cleaned.includes('fern_(sousou_no_frieren)'), out.cleaned);
}

// ── the prose tail ───────────────────────────────────────────
// Anima's dialect is tags then a flowing sentence. The sentence is
// comma-separated like everything else and must survive untouched.
{
  const prose =
    'she sits at a small round wooden table by the window, holding a ceramic cup with both hands, ' +
    'her gaze directed slightly downward toward the liquid';
  const out = cleanPositive(`masterpiece, frieren, frieren, ${prose}`, { known });
  check('the prose tail is preserved verbatim',
    out.cleaned.includes('she sits at a small round wooden table by the window'), out.cleaned);
  check('every clause of the tail survives',
    out.cleaned.includes('her gaze directed slightly downward toward the liquid'), out.cleaned);
  check('tags before the tail are still deduplicated',
    (out.cleaned.match(/\bfrieren\b/g) ?? []).length === 1, out.cleaned);
}

// A parenthesised phrase inside prose must not be mistaken for a tag.
{
  const out = cleanPositive(
    'frieren, she raises the cup slowly and looks out at the rain (the light is failing)',
    { known }
  );
  check('a parenthesis inside the prose tail is left alone',
    out.cleaned.includes('(the light is failing)'), out.cleaned);
}

// ── a user's text modifiers are not prose ──────────────────────
//
// Added 4 Sep 2026. Anima's dialect grew a third class: English visual
// directions that sit in the TAG list rather than in the sentence. Several are
// exactly five words, which was the old prose threshold — so the first one
// used to flip the pass into prose mode and silently stop deduplicating
// everything after it, which on this dialect is the entire modifier run.
{
  const modifiers = [
    'cinematic lighting',
    'shallow depth of field',
    'warm highlights and cool shadows',
    'teal and orange color grading',
    'subtle film grain',
    'detailed hair strands',
  ].join(', ');
  const out = cleanPositive(`1girl, frieren, ${modifiers}, frieren`, { known });
  check('a five-word text modifier survives',
    out.cleaned.includes('warm highlights and cool shadows'), out.cleaned);
  check('...and so does the one after it',
    out.cleaned.includes('teal and orange color grading'), out.cleaned);
  check('deduplication still runs past a text modifier',
    (out.cleaned.match(/\bfrieren\b/g) ?? []).length === 1, out.cleaned);
  check('no modifier was mistaken for an invented tag',
    out.removed.invented.length === 0, JSON.stringify(out.removed));
}

// The sentence still has to be recognised, and it is the capital that does it
// once an item is under eight words.
{
  const out = cleanPositive('1girl, soft glow, She leans in close, dim lighting', { known });
  check('a short capitalised clause opens the prose tail',
    out.cleaned.endsWith('She leans in close, dim lighting'), out.cleaned);
  check('...and the lowercase modifier before it stayed a tag',
    out.cleaned.startsWith('1girl, soft glow, She leans'), out.cleaned);
}

// ── user input and config are never second-guessed ───────────
{
  const out = cleanPositive('frieren, madeup_(thing)', {
    known,
    protected: ['madeup_(thing)'],
  });
  check('a protected tag survives even though it is invented',
    out.cleaned.includes('madeup_(thing)'), out.cleaned);
}

// ── a real tag in Anima's escaped spelling ───────────────────
//
// Anima writes `shiroko terror \(blue archive\)`. The live lookup (postCount)
// turns spaces into underscores but never saw past the backslashes, so a real
// character with 4,701 posts was deleted as invented — journal, 9 and 11 Sep
// 2026, reported by a user as character identification failing. This
// stand-in behaves like postCount: spaces to underscores, nothing else.
{
  const REAL2 = new Set(['shiroko_terror_(blue_archive)', 'frieren']);
  const likePostCount = (t) => REAL2.has(String(t).trim().toLowerCase().replace(/\s+/g, '_'));

  const spaced = cleanPositive('masterpiece, shiroko terror \\(blue archive\\), smile', { known: likePostCount });
  check('an escaped, spaced real character tag survives',
    spaced.cleaned.includes('shiroko terror \\(blue archive\\)') && spaced.removed.invented.length === 0,
    JSON.stringify(spaced));

  const under = cleanPositive('shiroko_terror_\\(blue_archive\\), smile', { known: likePostCount });
  check('...and so does the escaped underscore spelling',
    under.removed.invented.length === 0, JSON.stringify(under));

  const fake = cleanPositive('masterpiece, frieren \\(frieren\\), smile', { known: likePostCount });
  check('an invented tag is still removed when escaped',
    fake.removed.invented.includes('frieren \\(frieren\\)'), JSON.stringify(fake.removed));
}

// ── no database, no invented-tag check ───────────────────────
// A fresh checkout has no tags.sqlite. Deduplication still has to work.
{
  const out = cleanPositive('frieren, frieren_(frieren), frieren, 1girl', {});
  check('without a database nothing is called invented',
    out.removed.invented.length === 0, JSON.stringify(out.removed));
  // Counted as whole comma-separated items, not by regex: `frieren_(frieren)`
  // contains the substring twice and a loose pattern reads it as a duplicate
  // of the bare tag when it is a different item entirely.
  const items = out.cleaned.split(',').map((s) => s.trim());
  check('without a database duplicates are still removed',
    items.filter((t) => t === 'frieren').length === 1, out.cleaned);
  check('and the parenthesised one is kept, not being checkable',
    items.includes('frieren_(frieren)'), out.cleaned);
}

// ── spelling differences still count as duplicates ───────────
// normaliseTag treats underscores and spaces alike, and strips weights.
{
  const out = cleanPositive('long_hair, long hair, (long_hair:1.2)', { known });
  check('underscore and space spellings are one tag',
    out.removed.duplicates.length === 2, JSON.stringify(out.removed));
}

console.log();
console.log('positive prompt cleaning');
console.log();
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log();
  console.log(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
