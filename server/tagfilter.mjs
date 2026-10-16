// Which danbooru tags are worth putting in a tag database at all.
//
// The owner's ask, 7 Sep 2026: pull everything, then "remove whatever isn't
// really useful", then build the list from what survives. A separate stage on
// purpose — it is the one part of the import that is a judgement rather than
// a transfer, so it is inspectable, testable, and reports what it dropped
// instead of quietly shrinking the database.
//
// ── What this is NOT for ──────────────────────────────────────────────────
//
// Not a quality filter and not an opinion about subject matter. Nothing here
// drops a tag for being rare, ugly, niche or explicit. Rarity is already
// handled upstream by the post-count floor, and everything else is the user's
// business.
//
// The single question is: **could this tag ever describe a picture somebody is
// asking an image model to draw?** Danbooru is a booru first and a tag
// vocabulary second, so a large part of category 5 is site bookkeeping —
// records about the FILE and about the tagging process. `bad_pixiv_id` is
// true of a post and means nothing to a diffusion model. `tagme` is a request
// for a human to do some work.
//
// ── The edge, and why it is drawn at bookkeeping rather than at category ──
//
// Dropping all of category 5 would be simpler and wrong. `official_art`,
// `game_cg`, `absurdres` and `monochrome` are meta on danbooru and are real
// facts about how a picture looks — `official_art` in particular is a style
// signal every booru model responds to. So the rule is not "meta" but "about
// the site", and every pattern below names a class of that with a statable
// edge.

/**
 * Site bookkeeping: records about the file, the upload, or the tagging
 * process. None of it survives into a picture.
 *
 * Patterns rather than a list wherever danbooru mints one per site —
 * `bad_pixiv_id`, `bad_twitter_id`, `bad_fc2_link` and so on are an open
 * family and enumerating them is not a finite job.
 *
 * **Only ever applied to category 5.** These patterns are far too greedy to
 * run over the whole vocabulary, and the preview script caught it before this
 * shipped: `^bad_` eats `bad_anatomy` (18,290 posts, and the most-used
 * negative prompt term there is) along with `bad_hands`, `bad_feet`,
 * `bad_proportions` and `bad_end`; `_link$` eats twelve Zelda characters —
 * `young_link`, `toon_link`, `wolf_link`, `dark_link`, `deku_link` — plus
 * several copyrights.
 *
 * Restricting to meta is not a patch over those cases, it is the actual rule:
 * site bookkeeping is a fact about a POST, and danbooru files facts about
 * posts under category 5. A `bad_` tag outside it is a description of a
 * drawing.
 */
const BOOKKEEPING = [
  /^bad_/,                       // bad_id, bad_pixiv_id, bad_link, bad_fc2_link
  /_request$/,                   // commentary_request, translation_request
  /^tagme/,                      // tagme, tagme_(artist)
  /^check_/,                     // check_translation, check_commentary
  /^md5_/,                       // md5_mismatch
  /_(id|link)$/,                 // pixiv_id, source_link
  /^duplicate$|^image_sample$|^resized$|^upscaled$|^downscaled$/,
  /^third-party_edit$|^third-party_source$|^revision$|^variant_set$/,
  /^self-datamine$|^datamined$|^game_asset$/,
  /^translated$|^partially_translated$|^untranslatable_commentary$/,
  /^commentary$|^commentary_typo$|^symbol-only_commentary$/,
  /^hard_translated|^translation_/,
  /^paid_reward|^patreon_reward|^fanbox_reward|^skeb_commission$/,
  /^has_(bad|lossless|downscaled)_|^nonexistent_/,
  /^tag(_|s_)?(request|edit)/,
  /^artist_request$|^character_request$|^copyright_request$|^source_request$/,
];

/**
 * Tags whose whole meaning is "somebody could not identify this". They are
 * true statements about a post's tagging state and say nothing about pixels.
 */
const UNIDENTIFIED = new Set([
  'unknown_artist', 'unknown_character', 'unknown_copyright',
  'artist_unknown', 'anonymous_artist',
]);

/** danbooru's category for facts about a post rather than about a picture. */
const META_CATEGORY = 5;

/** Bookkeeping danbooru happens to file under `general`. Named, not matched. */
const MISFILED = new Set(['pixiv_id', 'niconico_id', 'nonexistent_id']);

/**
 * Should this tag go into the database?
 *
 * @param tag { name, category, post_count }
 * @returns { keep, why }  `why` is null when kept, and a short class name
 *                         otherwise, so the importer can report a tally
 *                         rather than a number.
 */
export function judgeTag(tag) {
  const name = String(tag?.name ?? '').toLowerCase();
  if (!name) return { keep: false, why: 'empty' };

  // A tag nobody has used describes nothing. The API's `hide_empty` should
  // mean this never fires, so it is a backstop for the CSV path and for a
  // danbooru that changes its mind about that parameter.
  if (!Number.isFinite(tag.post_count) || tag.post_count <= 0) {
    return { keep: false, why: 'no posts' };
  }

  if (UNIDENTIFIED.has(name)) return { keep: false, why: 'unidentified' };
  // Miscategorised bookkeeping. Danbooru files these under `general`, and
  // they are unambiguous enough to name — which is the only reason they are
  // exempt from the category rule below. Exact matches, never patterns.
  if (MISFILED.has(name)) return { keep: false, why: 'site bookkeeping' };
  if (Number(tag.category) === META_CATEGORY) {
    for (const re of BOOKKEEPING) {
      if (re.test(name)) return { keep: false, why: 'site bookkeeping' };
    }
  }
  return { keep: true, why: null };
}

/**
 * Filter a list, keeping a tally of why things went.
 *
 * @returns { kept, dropped, tally, examples }
 */
export function filterTags(tags = []) {
  const kept = [];
  const dropped = [];
  const tally = {};
  const examples = {};
  for (const t of tags) {
    const { keep, why } = judgeTag(t);
    if (keep) { kept.push(t); continue; }
    dropped.push(t);
    tally[why] = (tally[why] ?? 0) + 1;
    // Keep the most-used example of each class. A dropped tag with 300,000
    // posts is worth a second look; one with 51 is not.
    if (!examples[why] || t.post_count > examples[why].post_count) examples[why] = t;
  }
  return { kept, dropped, tally, examples };
}
