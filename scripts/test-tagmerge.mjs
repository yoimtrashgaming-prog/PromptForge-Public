// Merging a primary tagger with a second opinion.
//
//   node scripts/test-tagmerge.mjs
//
// Every case here is real data from the 7 Sep 2026 measurement on one anime
// screenshot, three taggers at a 0.05 floor. The design is the owner's: the
// primary does the heavy lifting, a broader model may ADD to it, and nothing
// may overrule it.

import { mergeReads, resolveColourConflicts, colourFamily } from '../server/tagmerge.mjs';

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};
const t = (tag, confidence) => ({ tag, confidence });
const tags = (rows) => rows.map((r) => r.tag);

// ── families ────────────────────────────────────────────────
check('white_shirt and black_shirt are one family',
  colourFamily('white_shirt') === 'shirt' && colourFamily('black_shirt') === 'shirt');
check('a shirt and a belt are not', colourFamily('white_shirt') !== colourFamily('black_belt'));
// The prefix of a `*_hair` tag is not always a colour, which is why
// COLOUR_WORDS is a list and not a pattern.
check('long_hair is not a colour claim', colourFamily('long_hair') === null);
check('striped_shirt is not a colour claim', colourFamily('striped_shirt') === null);
check('messy_hair is not a colour claim', colourFamily('messy_hair') === null);

// ── the contradiction is INSIDE one tagger ──────────────────
// The surprise in the measurement, and the reason "the primary wins" is not
// enough on its own: `white_shirt` 12% and `black_shirt` 9% were BOTH EVA02's,
// on a shirt that is black-and-white striped. It hedged rather than
// disagreeing with anybody.
{
  const rows = resolveColourConflicts([
    t('striped_shirt', 0.71), t('white_shirt', 0.12), t('black_shirt', 0.09),
  ]);
  check('one tagger hedging on a shirt keeps only its best guess',
    tags(rows).join(',') === 'striped_shirt,white_shirt', tags(rows).join(','));
  check('the striped tag survives, being no colour claim', tags(rows).includes('striped_shirt'));
}

// ── multicolour disables the dedupe, per feature ────────────
{
  const rows = resolveColourConflicts([
    t('two-tone_hair', 0.8), t('white_hair', 0.7), t('black_hair', 0.6), t('green_eyes', 0.9), t('blue_eyes', 0.2),
  ]);
  check('two-tone_hair spares both hair colours',
    tags(rows).includes('white_hair') && tags(rows).includes('black_hair'), tags(rows).join(','));
  check('and does NOT spare the eyes',
    tags(rows).includes('green_eyes') && !tags(rows).includes('blue_eyes'), tags(rows).join(','));
}
{
  const rows = resolveColourConflicts([
    t('heterochromia', 0.8), t('green_eyes', 0.7), t('blue_eyes', 0.6),
  ]);
  check('heterochromia spares both eye colours',
    tags(rows).includes('green_eyes') && tags(rows).includes('blue_eyes'), tags(rows).join(','));
}

// ── the merge ───────────────────────────────────────────────
const ANI = { key: 'animetimm', general: [
  t('frieren_core', 0.99), t('green_eyes', 0.90), t('white_hair', 0.82), t('striped_shirt', 0.71),
] };
const EVA = { key: 'eva02', general: [
  t('green_eyes', 0.95), t('dappled_sunlight', 0.07), t('anime_coloring', 0.23), t('high_collar', 0.07),
] };
// MOAT's real unique output on that image. Both eye colours are wrong; all
// three taggers agreed on green_eyes at 90%.
const MOAT = { key: 'moat', general: [
  t('grey_eyes', 0.36), t('blue_eyes', 0.09), t('logo', 0.07), t('ruins', 0.22),
] };

{
  const out = mergeReads([ANI, EVA]);
  const names = tags(out);
  check('everything the primary said survives',
    ['frieren_core', 'green_eyes', 'white_hair', 'striped_shirt'].every((x) => names.includes(x)), names.join(','));
  check('the second opinion ADDS what the primary missed',
    ['dappled_sunlight', 'anime_coloring', 'high_collar'].every((x) => names.includes(x)), names.join(','));
  // The whole reason not to use an intersection: these three are correct and
  // specific, and only one tagger saw any of them.
  check('a tag only the secondary saw is credited to it',
    out.find((r) => r.tag === 'dappled_sunlight').found_by.join(',') === 'eva02');
  check('a tag both saw is credited to both',
    out.find((r) => r.tag === 'green_eyes').found_by.join(',') === 'animetimm,eva02');
  check('confirmation raises confidence to the highest anyone had',
    out.find((r) => r.tag === 'green_eyes').confidence === 0.95);
  check('output is ranked by confidence', out[0].tag === 'frieren_core');
}

// ── a second opinion may add, never overrule ────────────────
{
  const out = mergeReads([ANI, EVA, MOAT]);
  const names = tags(out);
  check('a secondary cannot contradict the primary on eye colour',
    !names.includes('grey_eyes') && !names.includes('blue_eyes'), names.join(','));
  check('and the primary answer stands', names.includes('green_eyes'));
  // Refusing the contradiction must not refuse the whole tagger.
  check('its non-contradicting tags still land',
    names.includes('ruins') && names.includes('logo'), names.join(','));
}

// ── order matters, and that is the point ────────────────────
{
  const primaryFirst = tags(mergeReads([ANI, MOAT]));
  const moatFirst = tags(mergeReads([MOAT, ANI]));
  check('with animetimm primary, green_eyes wins',
    primaryFirst.includes('green_eyes') && !primaryFirst.includes('grey_eyes'), primaryFirst.join(','));
  check('with MOAT primary, its wrong answer wins instead',
    moatFirst.includes('grey_eyes') && !moatFirst.includes('green_eyes'), moatFirst.join(','));
}

// ── degenerate inputs ───────────────────────────────────────
check('no reads gives no tags', mergeReads([]).length === 0);
check('one read is just that read, resolved',
  tags(mergeReads([ANI])).length === 4, tags(mergeReads([ANI])).join(','));
check('an empty secondary changes nothing',
  tags(mergeReads([ANI, { key: 'x', general: [] }])).join(',') === tags(mergeReads([ANI])).join(','));
check('a missing general array does not throw',
  mergeReads([ANI, { key: 'x' }]).length === 4);

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
