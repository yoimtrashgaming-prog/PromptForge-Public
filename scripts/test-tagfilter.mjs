// Which danbooru tags reach the database.
//
//   node scripts/test-tagfilter.mjs
//
// No network. Every case below is a real tag with its real category and post
// count, taken from the 124,297-tag pull on 7 Sep 2026.
//
// The half that matters is the KEEP half. The bookkeeping patterns are greedy
// by design and the first version of them ate `bad_anatomy` and twelve Zelda
// characters — caught by scripts/preview-tag-filter.mjs before it shipped, and
// pinned here so it cannot come back.

import { judgeTag, filterTags } from '../server/tagfilter.mjs';

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};
const GENERAL = 0, ARTIST = 1, COPYRIGHT = 3, CHARACTER = 4, META = 5;
const t = (name, category, post_count = 1000) => ({ name, category, post_count });
const keeps = (tag) => judgeTag(tag).keep;

// ── bookkeeping goes ─────────────────────────────────────────
// Records about a post or about the tagging process. True of a file, and
// meaningless to a diffusion model.
for (const n of ['bad_id', 'bad_pixiv_id', 'bad_twitter_id', 'bad_link', 'bad_fc2_link',
  'commentary', 'commentary_request', 'translation_request', 'translated',
  'untranslatable_commentary', 'tagme', 'md5_mismatch', 'check_translation',
  'duplicate', 'resized', 'third-party_edit', 'third-party_source', 'revision',
  'variant_set', 'self-datamine', 'game_asset', 'skeb_commission',
  'paid_reward_available', 'artist_request', 'character_request', 'source_request']) {
  check(`${n} is dropped`, !keeps(t(n, META)), judgeTag(t(n, META)).why);
}
check('unknown_artist is dropped', !keeps(t('unknown_artist', ARTIST)));

// ── and meta that describes the picture stays ────────────────
// The reason the rule is "about the site" and not "category 5". official_art
// is a style signal every booru model responds to.
for (const n of ['official_art', 'absurdres', 'highres', 'game_cg', 'monochrome',
  'promotional_art', 'key_visual', 'traditional_media']) {
  check(`${n} is kept`, keeps(t(n, META)), judgeTag(t(n, META)).why);
}

// ── the false positives that nearly shipped ──────────────────
// `^bad_` over the whole vocabulary eats the most-used negative prompt term
// in image generation, on an app that has a negatives feature.
for (const n of ['bad_anatomy', 'bad_hands', 'bad_feet', 'bad_proportions',
  'bad_perspective', 'bad_leg', 'bad_arm', 'bad_neck', 'bad_face',
  'bad_gun_anatomy', 'bad_reflection', 'bad_end', 'bad_apple!!']) {
  check(`${n} survives — it describes a drawing`, keeps(t(n, GENERAL)), judgeTag(t(n, GENERAL)).why);
}
// `_link$` over the whole vocabulary eats Zelda.
for (const n of ['young_link', 'toon_link', 'wolf_link', 'dark_link', 'deku_link',
  'jet_link', 'howard_link']) {
  check(`${n} survives — it is a character`, keeps(t(n, CHARACTER)), judgeTag(t(n, CHARACTER)).why);
}
for (const n of ['senran_kagura_new_link', 'tales_of_link', 'soul_link',
  'angelic_link', 'zelda_ii:_the_adventure_of_link', 'nijisanji_id']) {
  check(`${n} survives — it is a copyright`, keeps(t(n, COPYRIGHT)), judgeTag(t(n, COPYRIGHT)).why);
}
check('check_my_note_(idolmaster) survives', keeps(t('check_my_note_(idolmaster)', GENERAL)));
check('check_(check_book) survives — it is an artist', keeps(t('check_(check_book)', ARTIST)));

// ── bookkeeping danbooru files under general ─────────────────
// Named exactly, never matched, because a pattern here is what caused the
// damage above.
check('pixiv_id is dropped despite being general', !keeps(t('pixiv_id', GENERAL)));
check('niconico_id is dropped despite being general', !keeps(t('niconico_id', GENERAL)));

// ── the post-count floor ─────────────────────────────────────
// A backstop. The API is asked for hide_empty, so this should never fire on
// the live path — it is here for the CSV path and for a danbooru that changes
// its mind about that parameter.
check('a zero-post tag is dropped', !keeps(t('nobody_uses_this', GENERAL, 0)));
check('a missing post count is dropped', !keeps({ name: 'x', category: GENERAL }));
check('an empty name is dropped', !keeps(t('', GENERAL)));
check('50 posts is kept', keeps(t('rare_but_real', GENERAL, 50)));

// ── the tally ────────────────────────────────────────────────
{
  const { kept, dropped, tally, examples } = filterTags([
    t('1girl', GENERAL, 8000000), t('bad_id', META, 1454368),
    t('bad_anatomy', GENERAL, 18290), t('commentary', META, 3225454),
  ]);
  check('two kept, two dropped', kept.length === 2 && dropped.length === 2,
    `${kept.length}/${dropped.length}`);
  check('the tally names the class', tally['site bookkeeping'] === 2, JSON.stringify(tally));
  check('the example is the biggest of its class',
    examples['site bookkeeping'].name === 'commentary', examples['site bookkeeping']?.name);
}

// ── proportion, on the real distribution ─────────────────────
// The guard against a rule that quietly starts eating vocabulary. Measured on
// the full pull: 176 of 124,297, and every one of them meta except two named
// exceptions. If a future rule takes a percent of `general`, this fails.
{
  const sample = [
    ...Array.from({ length: 200 }, (_, i) => t(`general_tag_${i}`, GENERAL)),
    ...Array.from({ length: 50 }, (_, i) => t(`character_${i}`, CHARACTER)),
    ...Array.from({ length: 50 }, (_, i) => t(`artist_${i}`, ARTIST)),
  ];
  const { dropped } = filterTags(sample);
  check('ordinary vocabulary is untouched', dropped.length === 0, `${dropped.length} dropped`);
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
