// Two mechanical defects in generated POSITIVE prompts. The negative has had
// this treatment since 21 Aug; the positive never did, which is backwards -
// it is the half the user actually ships.
//
// Found in real output on 1 Sep, illustrious asked for "frieren sitting in a
// coffee shop", through the app so the character lookup had already supplied
// her canonical traits:
//
//   masterpiece, best_quality, very_aesthetic, frieren, frieren_(frieren),
//   frieren, solo, 1girl, elf, long_pointy_ears, white_hair, ...
//
// 1. `frieren` twice in one list, which is the same degeneration cleanNegative
//    was written for. illustrious.md warns that past roughly fifteen tags the
//    list "stops helping and starts pulling colour and contrast out of the
//    image", so a wasted slot is not merely untidy.
//
// 2. `frieren_(frieren)` - an invented tag. The database has `frieren` at
//    8,253 posts and no such parenthesised form. An invented tag steers
//    nothing and displaces the one that would have worked.
//
// **Why unknown tags are not simply stripped.** Most of a good positive prompt
// is not danbooru vocabulary at all. Measured against the live database:
// `masterpiece`, `best_quality`, `very_aesthetic`, `score_9`, `score_8`,
// `newest`, `safe`, `soft_lighting`, `detailed_background` and `coffee_shop`
// are all absent, and every one of them is correct - quality presets, Pony's
// score ladder, Anima's required tags, ordinary descriptive language the
// checkpoints understand. Dropping unknowns wholesale would delete the
// quality preset and the entire point of pony.md.
//
// So only PARENTHESISED unknowns are removed. `name_(series)` is a pure
// danbooru convention; nothing outside booru vocabulary is written that way,
// so an unknown wearing that shape is invented with near-certainty. A real one
// - `fern_(sousou_no_frieren)`, 5,355 posts - is in the database and survives.
//
// Deliberately NOT doing anything about length, ordering, or which tags are
// sensible. Those are judgement, and judgement belongs in prompts/.

import { normaliseTag } from './negative.mjs';

const split = (s) => String(s ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/**
 * Does this comma-separated item read as prose rather than a tag?
 *
 * Anima's dialect is a hybrid: tags first, then a flowing sentence describing
 * the scene. That sentence is comma-separated like everything else, so a naive
 * pass would treat each clause as a tag, fail to find it in a booru database,
 * and shred the half of the prompt anima.md exists to produce.
 *
 * Word count was the whole test until 4 Sep 2026, at five words. That broke
 * when Anima started emitting a user's TEXT MODIFIERS — English visual
 * directions that sit in the tag list rather than in the sentence, and some of
 * which are exactly five words: `warm highlights and cool shadows`, `teal and
 * orange color grading`. The first one flipped the pass into prose mode, and
 * every item after it — the whole rest of the modifier run — stopped being
 * deduplicated.
 *
 * Capitalisation is what actually separates the two. A modifier is lowercase
 * by construction; the prose half is a sentence and starts with a capital. So
 * a middling item is prose only if it also reads like the start of one, and
 * anything long enough is prose whatever its case.
 */
export function looksLikeProse(item) {
  const words = item.split(/\s+/).filter(Boolean).length;
  if (words >= 8) return true;
  return words >= 5 && /^[A-Z]/.test(item.trim());
}

/**
 * Strip invented parenthesised tags and duplicates from a positive prompt.
 *
 * @param {string} positive   the model's positive prompt segment
 * @param {object} opts
 * @param {(tag:string)=>boolean} [opts.known]  is this a real tag? null skips
 *                                              the invented-tag check entirely,
 *                                              which is the right behaviour on
 *                                              a box with no tag database.
 * @param {string[]} [opts.protected]  never removed, whatever the database
 *                                     says - config defaults and anything the
 *                                     user typed.
 * @returns {{cleaned:string, removed:{duplicates:string[], invented:string[]}}}
 */
export function cleanPositive(positive, opts = {}) {
  // Config and user input are never second-guessed, exactly as in
  // cleanNegative. A user who types a tag has asserted it exists.
  const spared = new Set();
  for (const source of opts.protected ?? []) {
    for (const tag of split(source)) spared.add(normaliseTag(tag));
  }
  spared.delete('');

  const seen = new Set();
  const kept = [];
  const duplicates = [];
  const invented = [];

  const items = split(positive);
  let inProse = false;

  for (const raw of items) {
    // Once the prose tail starts it runs to the end, so everything from here
    // is passed through untouched - including any repetition inside it, which
    // is a sentence doing its job rather than a tag list degenerating.
    if (inProse || looksLikeProse(raw)) {
      inProse = true;
      kept.push(raw);
      continue;
    }

    const key = normaliseTag(raw);
    if (!key) continue;

    if (seen.has(key)) {
      duplicates.push(raw);
      continue;
    }

    // Parenthesised and unknown means invented. The test is on the RAW form
    // because normaliseTag strips brackets - that is what makes it useful for
    // comparing spellings and useless for spotting this.
    //
    // Looked up WITHOUT the backslash escaping. Anima writes a character tag
    // as `shiroko terror \(blue archive\)`, and the database holds
    // `shiroko_terror_(blue_archive)`; postCount already turns the spaces into
    // underscores, but the backslashes made every escaped tag a miss, so a real
    // character (4,701 posts) was deleted as "invented". Seen in the journal on
    // 9 and 11 Sep 2026, and it is what a user reported as character
    // identification failing.
    if (
      opts.known &&
      !spared.has(key) &&
      /\([^)]*\)\s*$/.test(raw) &&
      !opts.known(raw.replace(/\\([()])/g, '$1'))
    ) {
      invented.push(raw);
      continue;
    }

    seen.add(key);
    kept.push(raw);
  }

  return {
    cleaned: kept.join(', '),
    removed: { duplicates, invented },
  };
}
