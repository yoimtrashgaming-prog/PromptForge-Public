// Merging two taggers' reads of one reference image.
//
// The owner's design, 7 Sep 2026: "having ani do the heavy lifting and then
// comparing with a lesser more broad model might be the way to go and then
// take the best outputs of them". Not a union, which sends the model
// everything including its own contradictions, and not an intersection, which
// throws away the specific tags that are the entire reason to attach a
// reference. A primary that is trusted, and a second opinion that may add but
// may not overrule.
//
// ── Which taggers, and why it is not obvious ──────────────────────────────
//
// Measured on one anime screenshot, three taggers at a 0.05 floor:
//
//   all three agree            38 tags   the reliable core
//   animetimm alone             1 tag    `floating_earring` at 7%
//   EVA02 alone                19 tags   dappled_sunlight, anime_coloring,
//                                        cobblestone, arch, high_collar,
//                                        belt_buckle, cowboy_shot
//   MOAT alone                 11 tags   grey_eyes, blue_eyes (both WRONG -
//                                        all three agree green_eyes at 90%),
//                                        copyright, logo, and redundancies
//
// So animetimm's value is not what it finds alone. It is the reliable core
// plus a character head the others do not have — it is the only one of the
// three that identified the character. EVA02 is the broad one. MOAT's unique
// contribution is two wrong eye colours and a watermark, and it was dropped.
//
// ── Contradictions come from INSIDE a tagger, not between them ────────────
//
// The surprise in that measurement. `white_shirt` at 12% and `black_shirt` at
// 9% were both EVA02's, on a shirt that is black-and-white striped: it hedged
// rather than disagreeing with anybody. So "the primary wins" does not fix
// contradictions on its own, and each tagger's own output has to be resolved
// before the two are merged at all.
//
// The resolution itself is server/traits.mjs's, generalised. That file has
// settled this for hair and eyes since 2 Sep — a character has one hair
// colour and danbooru does not agree with itself about which — and its
// COLOUR_WORDS and MULTICOLOUR lists are imported rather than copied. What
// changes here is only who wins: there, the tag most of the character's posts
// carry; here, the one the tagger was most confident about.

import { COLOUR_WORDS, MULTICOLOUR } from './traits.mjs';

/**
 * The `<colour>_<thing>` family a tag belongs to, or null.
 *
 * traits.mjs matches `_hair` and `_eyes` only, because canon is about a
 * person. A reference image is about a picture, and the same hedge shows up
 * on clothing: `white_shirt` and `black_shirt` are one garment described two
 * ways. The family is the noun, so `white_shirt` and `black_shirt` collide
 * while `white_shirt` and `black_belt` do not — two different garments can
 * genuinely be two different colours, and that is the whole distinction.
 */
export function colourFamily(tag) {
  const m = /^(.+?)_([a-z0-9]+)$/.exec(String(tag ?? '').toLowerCase());
  if (!m || !COLOUR_WORDS.has(m[1])) return null;
  return m[2];
}

/**
 * Drop the loser of each `<colour>_<thing>` contradiction within one list.
 *
 * @param rows  [{ tag, confidence }]
 */
export function resolveColourConflicts(rows = []) {
  const present = new Set(rows.map((r) => r.tag));
  // One multicolour marker disables that whole feature, not both. `two-tone_
  // hair` means she really does have two, and the dedupe must not fire.
  const skip = new Set();
  for (const tag of present) {
    if (!MULTICOLOUR.has(tag)) continue;
    skip.add(tag.includes('eye') || tag === 'heterochromia' ? 'eyes' : 'hair');
  }

  const winner = new Map();
  for (const r of rows) {
    const family = colourFamily(r.tag);
    if (!family || skip.has(family)) continue;
    const held = winner.get(family);
    if (!held || (r.confidence ?? 0) > (held.confidence ?? 0)) winner.set(family, r);
  }

  return rows.filter((r) => {
    const family = colourFamily(r.tag);
    if (!family || skip.has(family)) return true;
    return winner.get(family) === r;
  });
}

/**
 * Merge a primary tagger's read with one or more second opinions.
 *
 * Order of operations, and each step is load-bearing:
 *
 *   1. resolve each tagger's own colour contradictions, separately. A tagger
 *      that hedged is not evidence for either answer, and merging first would
 *      let one model's hedge outvote another model's confident single answer.
 *   2. take everything the primary says.
 *   3. add what the others found and the primary did not.
 *   4. where a secondary's addition contradicts something the primary
 *      already said, drop it. The primary is trusted; a second opinion may
 *      ADD, never overrule. This is what stops MOAT's `grey_eyes` from
 *      landing beside a `green_eyes` that three taggers agreed on.
 *
 * @param reads [{ key, name, general: [{tag, confidence}] }] primary first
 * @returns [{ tag, confidence, found_by }] ranked by confidence
 */
export function mergeReads(reads = []) {
  const cleaned = reads.map((r) => ({ ...r, general: resolveColourConflicts(r.general ?? []) }));
  const [primary, ...rest] = cleaned;
  if (!primary) return [];

  const out = new Map();
  const families = new Map();   // family -> the tag the primary claimed
  for (const t of primary.general) {
    out.set(t.tag, { tag: t.tag, confidence: t.confidence, found_by: [primary.key] });
    const f = colourFamily(t.tag);
    if (f) families.set(f, t.tag);
  }

  for (const r of rest) {
    for (const t of r.general) {
      const held = out.get(t.tag);
      if (held) {
        held.found_by.push(r.key);
        // Confirmation raises confidence to the highest anyone had. A tag two
        // models both saw is not less certain than the more certain of them.
        if ((t.confidence ?? 0) > (held.confidence ?? 0)) held.confidence = t.confidence;
        continue;
      }
      // New to the primary. Refused if the primary already answered this
      // question differently.
      const f = colourFamily(t.tag);
      if (f && families.has(f)) continue;
      out.set(t.tag, { tag: t.tag, confidence: t.confidence, found_by: [r.key] });
    }
  }

  return [...out.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}
