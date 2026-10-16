// Character trait lookup — what does this character actually look like.
//
// The problem it solves is measured, not theoretical. sdxl.md requires a booru
// character tag be expanded into plain description, because base SDXL has no
// Danbooru training and the bare name renders nothing. That expansion comes
// from the LLM's own memory, and on 21 Aug the dialect suite caught qwen3:8b
// describing Makima as "long black hair". Canon is red. Every character the
// model half-knows produces a confidently wrong prompt.
//
// Danbooru knows the answer, because thousands of people tagged it. Sample the
// posts for a character, tally the general tags, and the traits fall out.
//
// The whole difficulty is separating traits from furniture. `1girl` appears on
// 80% of Makima posts — and on 66% of everything, so it says nothing about
// her. `ringed_eyes` appears on 73% of hers and on 0.2% of danbooru. That
// ratio is lift, and the global post_count needed to compute it is already in
// tags.sqlite, so this needs no data we do not have.
//
// Measured on Makima at 40 posts, cutoff lift >= 3:
//
//   kept     ringed_eyes 325 · braided_ponytail 131 · black_necktie 54
//            red_hair 14 · necktie 9.7 · yellow_eyes 9.5 · braid 8.3
//            collared_shirt 7.6 · sidelocks 5.9 · white_shirt 5.4
//   dropped  shirt 2.9 · looking_at_viewer 1.4 · 1girl 1.2 · long_hair 1.1
//            solo 0.8
//
// Note it splits `white_shirt` from its generic parent `shirt`, which is the
// distinction a person would draw by hand.
//
// Degrades like everything else here: no network, no tag database, or an
// unknown character all return an empty result with a reason. Nothing that
// calls this may treat traits as required.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
// Shared rather than copied: companion subtraction has to recognise a costume
// tag as the same character, which is exactly the name/franchise split the
// character resolver already does. character.mjs imports nothing, so this
// direction cannot cycle.
import { namePart } from './character.mjs';
import { loadConfig } from './config.mjs';

// Only a scale factor on lift — the ranking is identical for any value, so it
// affects nothing but where MIN_LIFT bites. Danbooru's post count as of
// Aug 2026, rounded. Being wrong by a million moves the cutoff by ~10%.
const TOTAL_POSTS = 9_000_000;

// Bump when rankTraits changes what it returns for the same input. Cached rows
// carrying a different value are treated as misses. 1 = the 2 Sep 2026
// contradiction fix, which was the change that revealed the cache could not
// see a ranking change at all. 2 = the 11 Sep 2026 format tags in FRAMING
// (`comic` was being handed to the model as Shiroko Terror's canon). 3 = the
// 15 Sep 2026 majority rule for hair and eye colour and hair length, which a
// lift floor of 3 had made nearly unreachable for common looks. 4 = the same
// night's switch to danbooru's related-tags counts, a far larger sample than
// one page of posts, so every row cached under 3 is re-asked. 5 = the 15 Sep
// 2026 companion subtraction, which changes what a mixed sample returns. 6 =
// the 19 Sep 2026 costume query: every costume tag was ranked from a mixed
// page, so every one cached under 5 is wrong.
const RANK_VERSION = 6;

// Tags that describe who is in frame and how it is shot. These can never be a
// character trait, and lift alone does not remove them: `1girl` and `solo` are
// common enough globally to score near 1 and fall out on their own, but
// `2boys`, `male_focus` and `multiple_boys` are rare enough to survive it.
//
// Deliberately only this one category, and deliberately short. A stoplist of
// "things that looked wrong" grows forever and starts eating real traits; a
// stoplist of "subject count and framing" has an edge you can defend.
const FRAMING = new Set([
  '1girl', '1boy', '2girls', '2boys', '3girls', '3boys',
  'multiple_girls', 'multiple_boys', 'male_focus', 'female_focus',
  'solo', 'solo_focus', 'full_body', 'upper_body', 'lower_body',
  'cowboy_shot', 'portrait', 'close-up', 'from_side', 'from_behind',
  'from_above', 'from_below', 'looking_at_viewer', 'looking_away',
  'simple_background', 'white_background', 'transparent_background',
  'greyscale', 'monochrome', 'artist_name', 'signature', 'watermark',
  'english_text', 'speech_bubble', 'commentary', 'commentary_request',
  // What the picture IS, not who is in it — the same edge as greyscale and
  // speech_bubble above. Added 11 Sep 2026: shiroko_terror_(blue_archive)
  // tallied `comic` in enough of her posts to qualify, and it went to the
  // model as her canonical appearance, steering Anima toward comic panels.
  'comic', '4koma', 'manga', 'translated', 'translation_request',
  'sketch', 'lineart', 'partially_colored', 'spot_color',
]);

// Exported since 7 Sep 2026 so server/tagmerge.mjs can share them rather than
// keep a second copy that drifts. Same vocabulary, different winner rule:
// this file votes on danbooru post counts, that one on which tagger saw it.
//
// Colour words danbooru puts in front of `_hair` and `_eyes`. Listed rather
// than pattern-matched because the prefix of a `*_hair` tag is not always a
// colour — `long_hair`, `messy_hair` and `wet_hair` all fit the same shape and
// none of them conflicts with a colour.
export const COLOUR_WORDS = new Set([
  'white', 'grey', 'gray', 'silver', 'platinum_blonde', 'blonde', 'blond',
  'black', 'brown', 'light_brown', 'dark_brown', 'red', 'dark_red', 'pink',
  'blue', 'light_blue', 'dark_blue', 'green', 'light_green', 'dark_green',
  'purple', 'light_purple', 'orange', 'aqua', 'teal', 'yellow',
]);

// Tags that legitimately put two colours on one head, or in one pair of eyes.
// Where one of these is present the character really does have both and the
// dedupe below must not fire.
export const MULTICOLOUR = new Set([
  'multicolored_hair', 'two-tone_hair', 'gradient_hair', 'streaked_hair',
  'colored_inner_hair', 'colored_tips', 'split-color_hair', 'rainbow_hair',
  'heterochromia', 'multicolored_eyes', 'gradient_eyes',
]);

// Hair length. Like the colours, these are common everywhere — `short_hair` is
// on about 35% of danbooru — so a lift floor of 3 can never be reached by one:
// it would need more than 100% of a character's posts. See isLookTrait.
export const HAIR_LENGTH = new Set([
  'very_short_hair', 'short_hair', 'medium_hair', 'long_hair', 'very_long_hair',
  'absurdly_long_hair',
]);

// One size, like one hair colour. The character table lists two for some
// characters — 2B carries both `medium_breasts` and `large_breasts` — and the
// model would write both.
export const BREAST_SIZE = new Set([
  'flat_chest', 'small_breasts', 'medium_breasts', 'large_breasts', 'huge_breasts',
  'gigantic_breasts',
]);

// What a picture shows of the body, not what the character looks like. The
// character table is built from what her posts carry most, and for many
// characters that includes how she tends to be drawn — 2B's list has `ass`,
// `thighs` and `cleavage` — which is framing wearing a trait's name. The same
// edge FRAMING draws, applied to anatomy: kept short, and never a size, a
// colour, or anything a design has.
export const BODY_FOCUS = new Set([
  'breasts', 'cleavage', 'ass', 'thighs', 'collarbone', 'navel', 'armpits',
  'nipples', 'midriff', 'stomach', 'sideboob', 'underboob', 'groin',
  'bare_shoulders', 'bare_arms', 'bare_legs', 'feet', 'barefoot', 'toes', 'soles',
]);

/**
 * A hair or eye colour, or a hair length: the looks that are common across all
 * of danbooru, and so the ones lift is structurally unable to promote.
 *
 * Measured 15 Sep 2026 on gran_(granblue_fantasy): `brown_hair` is on 88% of
 * the posts he is alone in and still scores a lift of only 3.8, because brown
 * hair is on about 23% of everything. At 62% it scores 2.7 and is cut. So
 * brown- and black-haired characters were losing their hair colour, and 79 of
 * the 95 characters then cached had no hair length at all. For these tags the
 * vote of the character's own posts decides instead — see majority_share.
 */
export function isLookTrait(tag) {
  if (HAIR_LENGTH.has(tag)) return true;
  const m = /^(.+?)_(hair|eyes)$/.exec(tag);
  return Boolean(m && COLOUR_WORDS.has(m[1]));
}

/**
 * Clean one character's list from the character table.
 *
 * The table (scripts/import-character-traits.mjs) merges two community lists
 * and records which listed each tag, deepghs's first because it is ordered by
 * frequency. Cleaned HERE, at lookup, rather than at import, so a change to
 * these rules applies to every character without rebuilding anything.
 *
 * - FRAMING and BODY_FOCUS are dropped, as they are from a live sample.
 * - One hair colour, one eye colour, one breast size. The winner is the tag
 *   BOTH lists carry, then the earlier-listed one. Measured on the table:
 *   Frieren arrives with white and grey hair, Miku with aqua and blue eyes,
 *   Rudeus with brown and blonde hair.
 * - A multicolour marker spares its whole feature, as in dropContradictions.
 *
 * @param items  [{tag, sources}] in the table's order
 * @returns      [{tag, sources}]
 */
export function cleanTableTraits(items) {
  const seen = new Set();
  const rows = [];
  for (const it of items ?? []) {
    const tag = typeof it === 'string' ? it : it?.tag;
    if (!tag || seen.has(tag) || FRAMING.has(tag) || BODY_FOCUS.has(tag)) continue;
    seen.add(tag);
    rows.push({ tag, sources: Array.isArray(it?.sources) ? it.sources : [] });
  }

  // Strictly more lists wins; a tie keeps the earlier-listed one.
  return resolveFamilies(rows, (r) => r.sources.length);
}

// How many co-stars can be subtracted from one sample. A character sharing
// their posts with more faces than this is not being described by any of them.
const MAX_COMPANIONS = 4;

/**
 * Index `traits.same_person` for lookup: name part -> which group it is in.
 *
 * Keyed on the name part rather than the whole tag so one line covers every
 * costume. `[scaramouche_(genshin_impact), wanderer_(genshin_impact)]` also
 * makes `wanderer_(mega_mgc_coffee)_(genshin_impact)` the same person as
 * Scaramouche, which it is, without listing all six of his skins.
 *
 * @param groups list of lists of tags naming one character
 * @returns Map<string, number>
 */
export function buildIdentityGroups(groups) {
  const index = new Map();
  (groups ?? []).forEach((group, i) => {
    for (const tag of group ?? []) {
      const name = namePart(String(tag ?? '').trim().toLowerCase());
      if (name) index.set(name, i);
    }
  });
  return index;
}

/**
 * Two tags naming one character: by name part, by a `same_person` group, or by
 * a `same_person_suffixes` marker.
 *
 * The suffix rule exists because one franchise made the list absurd. Kancolle
 * names every remodel `<ship>_kai`, `<ship>_kai_ni`, `<ship>_kai_san`, and a
 * remodel is the same shipgirl in an upgraded outfit — danbooru says so in as
 * many words, "the second remodel of Shigure". Measured 16 Sep 2026 there are
 * 104 such groups over 212 tags among characters with 150+ posts, and writing
 * them out one by one would be 104 lines of config restating one rule.
 *
 * Only whitelisted suffixes count, so a ship whose name merely begins with
 * another's is untouched: `kumano_maru` is an amphibious assault ship and
 * `kumano` a heavy cruiser, and `maru` is not on the list.
 */
function sameCharacter(a, b, index, suffixes, prefixes) {
  const an = namePart(a);
  const bn = namePart(b);
  if (an === bn) return true;
  const ag = index?.get(an);
  if (ag !== undefined && ag === index?.get(bn)) return true;

  // Strip one form marker from each end of BOTH names and compare what is left.
  //
  // This was a long-name-against-short-name test until 16 Sep 2026, and Fire
  // Emblem broke it. Every game with a selectable-gender player avatar tags it
  // `female_<name>` and `male_<name>` — Kancolle's admiral, Arknights' Doctor,
  // Blue Archive's Sensei, Wuthering Waves' Rover — but Fire Emblem deleted the
  // neutral tag, so there is no `byleth_(fire_emblem)` to compare against:
  // `female_byleth` and `male_byleth` have to match EACH OTHER. Stripping both
  // sides does that, and does everything the old test did.
  //
  // One marker per end, longest first, so `musashi_kai_ni` sheds `kai_ni`
  // rather than `ni` and lands on `musashi`. A stem must be left behind: a tag
  // that is nothing but a marker word stays as it is.
  const na = stripMarkers(an, prefixes, suffixes);
  const nb = stripMarkers(bn, prefixes, suffixes);
  if (na === an && nb === bn) return false; // neither had a marker to shed
  if (na === nb) return true;
  const ng = index?.get(na);
  return ng !== undefined && ng === index?.get(nb);
}

/**
 * A name with at most one whitelisted marker taken off each end.
 *
 * Longest match wins at each end, so a marker that is itself the tail of a
 * longer one — `ni` inside `kai_ni` — only applies when the longer does not.
 * Nothing is stripped that would leave an empty stem.
 */
function stripMarkers(name, prefixes, suffixes) {
  let out = name;
  if (prefixes?.size) {
    const hit = [...prefixes]
      .filter((p) => out.startsWith(`${p}_`) && out.length > p.length + 1)
      .sort((x, y) => y.length - x.length)[0];
    if (hit) out = out.slice(hit.length + 1);
  }
  if (suffixes?.size) {
    const hit = [...suffixes]
      .filter((s) => out.endsWith(`_${s}`) && out.length > s.length + 1)
      .sort((x, y) => y.length - x.length)[0];
    if (hit) out = out.slice(0, -hit.length - 1);
  }
  return out;
}

/**
 * The other characters in enough of this sample to be describing it instead.
 *
 * One dominant companion was the first shape of this and it was too narrow.
 * Measured 15 Sep 2026: Oz is with Fischl in 90% of his posts and was caught,
 * but `bob-omb` is Mario in 33%, Peach in 29% and Goomba in 23% — each under
 * any single-companion floor, together 85% of the sample, and the traits that
 * came back were Peach's. `slime` and `seelie` failed the same way. So the
 * union of everyone over `share` is subtracted, not just the leader.
 *
 * This cannot run away, because it only ever sees a sample already judged
 * mixed — fewer than min_sample posts of the character alone. Ash Ketchum is
 * in company in 96% of his posts and is never touched by any of this: he has
 * 209 solo posts, danbooru's `chartags:1` finds them, and the mixed branch is
 * never reached. What reaches it are characters with no solo posts at all,
 * where there is no honest knowledge to protect.
 *
 * Returned busiest-first and capped at MAX_COMPANIONS.
 *
 * @param key   the character being looked up, never their own companion
 * @param posts the sample, danbooru post objects
 * @param share how much of the sample a character must be in to count
 */
export function companionsIn(key, posts, share = 0.2, identities = null, suffixes = null, prefixes = null) {
  const seen = new Map();
  const total = posts?.length ?? 0;
  if (!total) return [];
  for (const p of posts) {
    for (const c of String(p?.tag_string_character ?? '').split(' ').filter(Boolean)) {
      if (c === key) continue;
      // Never the same character under another tag. Two ways that happens:
      //
      // A costume or alternate form shares the name and is tagged alongside
      // its base — `ganyu_(china_merchants_bank)` is in Ganyu's posts and
      // Ganyu is in 100% of its own — so without this the skin has its own
      // character subtracted from it and loses the face that makes it her.
      // Measured 15 Sep 2026: 17 Genshin variants, Lumine, Zhongli, Amber and
      // Arlecchino among them. The name before `_(` catches all of these.
      //
      // A second identity shares nothing at all — `wanderer` IS `scaramouche`,
      // `rex_lapis` IS `zhongli` — and no measurement can see it, so it is
      // declared in `traits.same_person`. Erring toward subtracting less is
      // the safe direction either way.
      if (sameCharacter(c, key, identities, suffixes, prefixes)) continue;
      seen.set(c, (seen.get(c) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .filter(([, n]) => n / total >= share)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COMPANIONS)
    .map(([tag]) => tag);
}

/**
 * Turn a table row's tags into names danbooru still has.
 *
 * The two community lists were built from older dumps, and measured 15 Sep
 * 2026 they carry 266 distinct tags the live database no longer holds, across
 * 5,480 of 34,157 characters. Checked one by one against danbooru, those 266
 * split cleanly in two:
 *
 * - 85 were renamed and every post moved with them — `china_dress` to `qipao`,
 *   `formal` to `formal_clothes`, `cabbie_hat` to `newsboy_cap`. The trait is
 *   still true, so renaming keeps it. Our own alias column agrees with
 *   danbooru on all 85, exactly, so this needs no network.
 * - 181 were deprecated with nothing to replace them — `bangs`, `eyebrows`,
 *   `uniform` — or survive only below the database's post-count floor. These
 *   are dropped, which is what dropping already did before this function
 *   existed; the difference is that the 85 are no longer dropped with them.
 *
 * Not a hand-maintained list, deliberately: the rule is "ask the database",
 * so a table rebuilt from a newer dump is cleaned by the same code.
 *
 * Runs BEFORE cleanTableTraits, so family resolution sees the final names and
 * a rename that collides with a tag already present is settled there rather
 * than leaving both.
 *
 * With no database loaded nothing can be checked, and then nothing is thrown
 * away — the same rule readTable already followed.
 *
 * @param items    [{tag, sources}] straight from the table
 * @param tagStore the live tag database, or null
 * @returns        [{tag, sources}] with dead names renamed or removed
 */
export function repairTableTags(items, tagStore) {
  if (!tagStore?.loaded) return items ?? [];
  const live = (tag) => (tagStore.postCount?.(tag) ?? 0) > 0;
  const out = [];
  for (const it of items ?? []) {
    const tag = typeof it === 'string' ? it : it?.tag;
    if (!tag) continue;
    const sources = Array.isArray(it?.sources) ? it.sources : [];
    if (live(tag)) {
      out.push({ tag, sources });
      continue;
    }
    const renamed = tagStore.aliasTarget?.(tag);
    if (renamed && live(renamed)) out.push({ tag: renamed, sources });
  }
  return out;
}

// The base hair lengths are one choice. `very_long_hair` and
// `absurdly_long_hair` are long hair said more strongly, so they ride with
// `long_hair` and fall with it. Measured 15 Sep 2026 on the table: Makima
// arrived with long and medium, Reze with short and medium, Rudeus with short
// and long — while long plus very long, on 22 Blue Archive girls alone, is
// simply true.
const LENGTH_BASE = new Set(['very_short_hair', 'short_hair', 'medium_hair', 'long_hair']);
const LENGTH_LONG = new Set(['very_long_hair', 'absurdly_long_hair']);

/**
 * Keep one of each set of looks that cannot all be true at once: hair colour,
 * eye colour, breast size, hair length. `rank(row)` says which wins; a tie
 * keeps the earlier row. A multicolour marker spares its whole feature.
 */
function resolveFamilies(rows, rank) {
  const skip = new Set();
  for (const r of rows) {
    if (!MULTICOLOUR.has(r.tag)) continue;
    skip.add(r.tag.includes('eye') || r.tag === 'heterochromia' ? 'eyes' : 'hair');
  }
  const familyOf = (tag) => {
    if (BREAST_SIZE.has(tag)) return 'breasts';
    if (LENGTH_BASE.has(tag)) return 'length';
    const m = /^(.+?)_(hair|eyes)$/.exec(tag);
    return m && COLOUR_WORDS.has(m[1]) ? m[2] : null;
  };

  const winner = new Map();
  for (const r of rows) {
    const family = familyOf(r.tag);
    if (!family || skip.has(family)) continue;
    const held = winner.get(family);
    if (!held || rank(r) > rank(held)) winner.set(family, r);
  }

  const length = winner.get('length')?.tag;
  return rows.filter((r) => {
    if (LENGTH_LONG.has(r.tag)) return !length || length === 'long_hair';
    const family = familyOf(r.tag);
    return !family || skip.has(family) || winner.get(family) === r;
  });
}

/**
 * The live lookup's traits, filled in from the character table.
 *
 * The table alone was measured first, 15 Sep 2026, against every character
 * then cached, and it made things worse in two ways a merge fixes:
 *
 * - Its lists are short and generic, so signature details went missing: 2B's
 *   `blindfold`, Blue Archive halos, Kakashi's `scar`, Frieren's
 *   `long_pointy_ears`. The live lookup ranks by lift, which is exactly the
 *   measure of "distinctive", so those stay.
 * - Where the two lists name two colours, the table can only guess. The live
 *   lookup, now sampling her alone, measures it: Power's `yellow_eyes` against
 *   the table's `red_eyes`. So on any colour, size or length they disagree
 *   on, live wins.
 *
 * The table adds what live missed — the brown eyes under the majority line,
 * the hair length — and nothing it contradicts.
 */
export function mergeTraits(live, table) {
  const have = new Set((live ?? []).map((t) => t.tag));
  const rows = [
    ...(live ?? []).map((t) => ({ ...t, from: 'live' })),
    ...(table ?? []).filter((t) => !have.has(t.tag)).map((t) => ({ ...t, from: 'table' })),
  ];
  return resolveFamilies(rows, (r) => (r.from === 'live' ? 1 : 0));
}

/**
 * Drop the lower-ranked of two tags that cannot both be true.
 *
 * A character has one hair colour. Danbooru does not agree with itself about
 * what it is — Frieren tallies `white_hair` and `grey_hair` because artists
 * draw her both ways — so the canon lookup was handing the model two, and the
 * model dutifully wrote both into the prompt. Seen in every arm of the 2 Sep
 * measurements, on illustrious and anima, unchanged by house rules, by the
 * model files, or by thinking. It is not a reasoning failure; nothing was
 * checking.
 *
 * **The winner is the one most of her posts actually carry, not the one with
 * the highest lift.** Danbooru is community-tagged, so the local tally is a
 * vote: it counts how many taggers looked at a picture of this character and
 * called her hair white. Lift is `share / global frequency`, which answers
 * "how distinctive is this tag" — the right question for ranking traits in
 * general and exactly the wrong one here, because `grey_hair` is globally
 * rarer than `white_hair` and lift would therefore promote it even where
 * fewer of her posts use it.
 *
 * The vote is over the sampled posts (100 fetched, filtered to single-
 * character ones), not the whole corpus, so it is a strong majority signal
 * rather than a census. Ties break on lift.
 *
 * Applied before the max_traits slice, so a dropped duplicate frees a slot for
 * a real trait rather than wasting one. Rows keep their lift ordering.
 *
 * Only colours, and only where nothing says otherwise. Hair *length* is left
 * alone: `long_hair` and `very_long_hair` co-occur constantly and reinforce
 * rather than contradict.
 */
function dropContradictions(rows) {
  const present = new Set(rows.map((r) => r.tag));
  const familyOf = (tag) => {
    const m = /^(.+?)_(hair|eyes)$/.exec(tag);
    if (!m || !COLOUR_WORDS.has(m[1])) return null;
    return m[2];
  };
  // One multicolour marker disables the whole feature it belongs to, not both.
  const skip = new Set();
  for (const tag of present) {
    if (!MULTICOLOUR.has(tag)) continue;
    skip.add(tag.includes('eye') || tag === 'heterochromia' ? 'eyes' : 'hair');
  }

  // Pick each family's winner by local tally first, lift only to break a tie.
  const winner = new Map();
  for (const r of rows) {
    const family = familyOf(r.tag);
    if (!family || skip.has(family)) continue;
    const held = winner.get(family);
    if (!held || r.posts > held.posts || (r.posts === held.posts && r.lift > held.lift)) {
      winner.set(family, r);
    }
  }

  return rows.filter((r) => {
    const family = familyOf(r.tag);
    if (!family || skip.has(family)) return true;
    return winner.get(family) === r;
  });
}

const DEFAULTS = {
  enabled: true,
  base_url: 'https://danbooru.donmai.us',
  // Sample the safe posts. Not squeamishness — it is where the character
  // design is actually visible. Measured 21 Aug on gojo_satoru: unfiltered,
  // the top traits were "plug_(piercing), yaoi, 2boys, greyscale, monochrome";
  // with rating:general they became "jujutsu_tech_uniform, round_eyewear,
  // white_hair, glasses, blue_eyes". Same character, same sample size. Set to
  // null to sample everything.
  rating_filter: 'general',
  // Fetched, not used. Most of these get discarded by the single-character
  // filter below — Fern kept 36 of 100 — so this has to be generous enough to
  // leave a usable sample behind. 200 is danbooru's ceiling.
  fetch_limit: 100,
  // If the filter leaves fewer than this, fall back to the whole sample and
  // say so, rather than ranking traits off six posts.
  min_sample: 12,
  min_share: 0.25,
  min_lift: 3,
  // A safety rail, not a tuning knob. min_share and min_lift are what decide
  // which tags qualify; this only stops a pathological character returning
  // hundreds. Measured uncapped, the thresholds yield 9 to 18 — Gojo 9, Makima
  // 11, Fern 13, Miku 14, Frieren 18 — so at 12 the cap was quietly cutting
  // real traits off the bottom of three of those, Frieren by six. Ranking is
  // by lift, so what got cut was the *least distinctive* qualifying tag, which
  // for a character with several rare props can be their hair colour.
  //
  // Costs nothing to raise: the posts are already fetched and the tally is
  // already computed, so this is a slice on an array.
  max_traits: 30,
  cache_days: 30,
  timeout_ms: 15000,
  db_path: 'data/tags/traits.sqlite',

  // Ask danbooru for single-character posts by name (`chartags:1`) instead of
  // fetching everyone's and filtering. Measured 15 Sep 2026: Gran is alone in
  // 8 of his newest 200 posts, which fell below min_sample and ranked the
  // whole mixed sample — `erune`, another character's race, came back as his.
  // The same search returns 24 posts, every one of him alone. When even that
  // is under min_sample the lookup asks again without it and falls back as
  // before, flagged mixed.
  solo_query: true,

  // A character who is never drawn alone is described by whoever stands next
  // to them. Measured 15 Sep 2026 across the Genshin roster: `dodoco` came
  // back blonde with a red coat and a newsboy cap — Klee, in every particular
  // — and `oz` came back as Fischl, `guoba` as Xiangling, `boo_tao` as Hu Tao,
  // `bob-omb` as Peach. The `chartags:1` filter cannot save them because there
  // are no solo posts to find, and the character table is built from the same
  // posts and carries the same borrowed traits, so falling back to it repeats
  // the error with `mixed` cleared.
  //
  // Every other character in at least this share of the sample has their own
  // traits subtracted from what comes back. Oz then keeps `crow` and `bird`
  // and loses Fischl's hair; Dodoco keeps almost nothing, which is the honest
  // answer. Set low enough to catch a crowd rather than only a partner: at
  // 0.5 it caught Oz and missed `bob-omb` entirely, whose sample is Mario 33%,
  // Peach 29% and Goomba 23%, no one of them dominant and all of them wrong.
  //
  // Only fires when the sample is already mixed, so a character with a real
  // solo sample is never touched — Kagamine Len shares blonde hair with Rin
  // and is alone in 1,870 posts, so he never reaches this path, and neither
  // does Ash Ketchum with 209.
  companion_share: 0.5,

  // Tags danbooru keeps separate that name ONE character. Listed because no
  // measurement can find them: see the `companion` note below for the three
  // discriminators that were tried and failed. Each entry is a group, matched
  // on the name before `_(`, so one line covers every costume of both.
  //
  // Only needed for the franchises actually in use. Adding one is cheap and
  // adding a wrong one only means subtracting less, so err toward listing.
  same_person: [],

  // The same thing said as a rule rather than a list, for franchises that name
  // their alternate forms regularly. `<name>_<suffix>` is the same character
  // as `<name>`. Kancolle alone would otherwise need 104 groups over 212 tags:
  // every shipgirl's remodel is `<ship>_kai`, `_kai_ni`, `_kai_san`, and
  // danbooru calls them "the second remodel of Shigure", "Musashi's kai form".
  //
  // Whitelisted, never a general "starts with" test, because a name that
  // merely begins with another name is usually somebody else — `kumano_maru`
  // is an amphibious assault ship and `kumano` a heavy cruiser.
  same_person_suffixes: [
    'kai', 'kai_ni', 'kai_san', 'kai_ni_go', 'ni', 'mk_ii',
    'dva', 'due', 'nuovo', 'andra', 'agb',
    'alter',
  ],

  // The same rule at the other end of the name, for franchises that put the
  // form first. Pokemon's Mega evolutions are `mega_<species>` and danbooru
  // applies both tags to every post, so all 20 measured on 16 Sep 2026 had zero
  // solo posts and were having their own species subtracted from them.
  //
  // Regional variants are deliberately absent. `alolan_vulpix` has 210 solo
  // posts and never reaches this path, and Alolan Vulpix is white where Vulpix
  // is red — for those, subtracting the base is the correct behaviour.
  //
  // `female` and `male` are here because every game with a selectable-gender
  // player avatar tags it that way, and measured 16 Sep 2026 all 25 pairs with
  // a neutral base tag were the avatar: Kancolle's admiral, Arknights' Doctor
  // and Endministrator, Blue Archive's Sensei, Wuthering Waves' Rover, Azur
  // Lane's Commander, Umamusume's Trainer, Touken Ranbu's saniwa.
  same_person_prefixes: ['mega', 'primal', 'gigantamax', 'female', 'male'],

  // Whether to subtract a companion's traits at all.
  //
  // The defect is real and was measured 15 Sep 2026 across the Genshin roster:
  // a character who is never drawn alone is described by whoever stands next
  // to them. `dodoco` came back as Klee in every particular, `oz` as Fischl,
  // `guoba` as Xiangling, `boo_tao` as Hu Tao, `bob-omb` as Peach. Subtracting
  // the co-star's own traits fixes exactly that: Oz keeps `crow` and `bird`,
  // bob-omb keeps `bomb` and `explosive`, Boo Tao keeps `ghost`.
  //
  // What it cannot do is tell a companion from the same character tagged
  // twice. Genshin does this constantly — `wanderer` IS `scaramouche`,
  // `rex_lapis` IS `zhongli`, `barbatos` IS `venti`, `cloud_retainer` IS
  // `xianyun`, `peruere` IS `arlecchino` — and the second tag sits on nearly
  // every post of the first, so it reads as a companion and takes the
  // character's face with it. Wanderer alone is 15,103 posts.
  //
  // Three discriminators were tried and all three failed on measurement:
  //
  // - Name part (`namePart`) catches the costume variants — 17 of them,
  //   `ganyu_(china_merchants_bank)` losing Ganyu — and is kept in
  //   companionsIn because it is free and correct. It cannot see
  //   wanderer/scaramouche, which share no name.
  // - Co-tag share does not separate them. Real companions: Oz with Fischl
  //   97%, Boo Tao with Hu Tao 99%, Ajaw with Kinich 98%. Same person: Rex
  //   Lapis with Zhongli 72%, Barbatos with Venti 77%. The distributions sit
  //   on top of each other; there is no floor that keeps one and drops the
  //   other. At 0.2 it fired on 92 of 247 characters, at 0.5 on 61.
  // - "Subtracting yourself leaves nothing" is false, and was briefly shipped
  //   as `companion_min_kept` before measurement removed it. A second tag
  //   removes only the other character's RANKED traits, and a big sample has
  //   plenty of unranked ones left, so Wanderer sailed over the floor — while
  //   `boo_tao`, the case the fix exists for, fell under it and was put back.
  //
  // What no measurement could find, a list can. `same_person` above declares
  // the pairs outright for the five franchises this group uses, which is what
  // makes subtraction safe to leave on THERE.
  //
  // It is honestly weaker elsewhere. A franchise nobody has curated can still
  // hit the same trap — a second identity, no solo posts, a dominant co-tag —
  // and the cost is one rarely-prompted alias name coming back thin. Bounded,
  // because the busier of the two names is the one with solo posts and the one
  // people actually type, and fixed by adding a line to `same_person`.
  companion: true,

  // Ask danbooru to do the counting. `related_tag.json` returns, for a search,
  // how often each general tag appears — over every post the search matches,
  // not one page of them. Measured 15 Sep 2026 with `chartags:1`: 2,977 posts
  // of Power alone and 3,997 of Fern, against the 200 a page holds; Gran's
  // came back brown hair 0.75, brown eyes 0.48, short hair 0.32, and no ears,
  // horns or long hair. One request per character. The same ranking rules
  // run on its counts. `related_query: false` goes back to sampling posts,
  // which also remains the fallback when this fails or covers fewer than
  // min_sample posts.
  related_query: true,
  // How many related tags to ask for. Anything under min_share (0.25) is
  // discarded anyway, so this only has to reach past the last tag that could
  // qualify.
  related_limit: 100,

  // Hair and eye colour and hair length pass on this share of the character's
  // own posts, whatever their lift — see isLookTrait. Everything else still
  // needs min_lift.
  majority_share: 0.5,

  // A hair or eye colour also passes as the clear front-runner: on at least
  // min_share of her posts and this many times the next colour. Measured 15
  // Sep 2026 on Power, 1,182 posts of her alone: yellow_eyes 33%, red_eyes
  // 21%, orange_eyes 18%. Yellow is her canon and plainly leads, but it is
  // neither a majority nor distinctive enough (lift 2.88, since over a
  // million posts carry it), so nothing reported her eyes and the character
  // table's guess of red filled the gap. At 1.3 yellow passes (1.53x red); a
  // genuine split between two colours passes neither, which is the honest
  // answer.
  plurality_margin: 1.3,

  // The character table — see scripts/import-character-traits.mjs. 34,157
  // characters from noob-wiki and deepghs's character index, built from
  // whole-dataset solo posts rather than one page. It FILLS IN the live
  // lookup and stands in when that has nothing usable; it never overrides a
  // look the live lookup measured (mergeTraits). `table: false` in
  // config/server.local.yaml puts every character back on the live lookup
  // alone; nothing else needs to change.
  table: true,
  table_path: 'data/tags/character_traits.sqlite',
  // Fewer cleaned traits than this and the table is not trusted for that
  // character; the live lookup answers instead.
  table_min_traits: 3,
};

/**
 * Rank tallied tags by lift and keep the characteristic ones.
 * Pure, so it can be tested without a network or a database.
 *
 * @param tally   Map of tag -> how many sampled posts carried it
 * @param sampled How many posts were sampled
 * @param globalCount  (tag) => danbooru-wide post count, 0 if unknown
 */
export function rankTraits(tally, sampled, globalCount, opts = {}, isDeprecated = null) {
  const { min_share, min_lift, max_traits, majority_share, plurality_margin } = { ...DEFAULTS, ...opts };
  if (!sampled) return [];

  // The clear front-runner of each colour: on at least min_share of her
  // posts and plurality_margin times the next colour's count. Taggers split
  // on eye colour more than hair — see plurality_margin — so a colour most
  // artists use can still fall under half.
  const leaders = new Set();
  if (plurality_margin != null) {
    const byFamily = new Map();
    for (const [tag, local] of tally) {
      const m = /^(.+?)_(hair|eyes)$/.exec(tag);
      if (!m || !COLOUR_WORDS.has(m[1]) || FRAMING.has(tag)) continue;
      if (!byFamily.has(m[2])) byFamily.set(m[2], []);
      byFamily.get(m[2]).push([tag, local]);
    }
    for (const list of byFamily.values()) {
      list.sort((a, b) => b[1] - a[1]);
      const [first, second] = list;
      if (first[1] / sampled >= min_share && (!second || first[1] >= second[1] * plurality_margin)) {
        leaders.add(first[0]);
      }
    }
  }

  const rows = [];
  for (const [tag, local] of tally) {
    if (FRAMING.has(tag)) continue;
    // Retired and misspelled tags, per danbooru. They survive on old posts —
    // deprecating a tag does not strip it from what already carries it — so a
    // character sampled today can still be tallying one, and it would then be
    // offered as a trait under a name nothing accepts any more.
    //
    // A predicate rather than a lookup here, so this file needs no opinion
    // about where the tag database lives; null means "nothing knows", which is
    // the case on a database built before 26 Aug 2026.
    if (isDeprecated?.(tag)) continue;
    const share = local / sampled;
    if (share < min_share) continue;
    const global = globalCount(tag) || 0;
    // An unknown tag has no global count, so its lift cannot be computed. Skip
    // rather than assume rare: assuming rare promotes typos and brand-new tags
    // straight to the top of the list.
    if (!global) continue;
    const lift = share / (global / TOTAL_POSTS);
    // A common look carried by most of her own posts is hers, however common
    // it is elsewhere. dropContradictions below still keeps only one colour.
    const byMajority = majority_share != null && share >= majority_share && isLookTrait(tag);
    if (lift < min_lift && !byMajority && !leaders.has(tag)) continue;
    rows.push({ tag, share, lift, posts: local });
  }
  rows.sort((a, b) => b.lift - a.lift);
  // The cap applies to everything but the looks. A precaution rather than a
  // measured fix: lift puts a common look at the bottom by construction, so
  // on a list long enough to hit the cap it would be the first thing cut —
  // the risk this file's config comment already names for hair colour. After
  // dropContradictions there is at most one of each look, so exempting them
  // cannot grow the list by more than a handful.
  const kept = dropContradictions(rows);
  let others = 0;
  return kept.filter((r) => isLookTrait(r.tag) || (others += 1) <= max_traits);
}

/**
 * Character tags someone typing `key` might have meant. Never picks for them.
 *
 * **This suggests; it does not resolve.** Auto-resolving was written first and
 * measured, and it was wrong often enough to be dangerous:
 *
 *   makima  → makima_(chainsaw_man)     right
 *   fern    → fern_(sousou_no_frieren)  right
 *   gojo    → gojou_satoru              right, and only via an alias
 *   zelda   → princess_zelda            right
 *   miku    → mikuma_(kancolle)         WRONG — nobody typing "miku" means her
 *   rem     → remilia_scarlet           WRONG — that is Rem from Re:Zero
 *
 * Two of eight silently wrong, and a wrong character does not fail loudly: it
 * fills the panel with someone else's hair colour and the prompt is confidently
 * wrong in exactly the way this whole feature exists to prevent. The dialect
 * suite once caught the model putting black hair on a redhead; picking the
 * wrong redhead is the same defect with a different author.
 *
 * So the caller gets a list and the person chooses. `makima` returning one
 * obvious candidate costs a click; `miku` returning several is the honest
 * answer to an ambiguous name.
 *
 * Ranked by post count, the same tiebreak autocomplete uses: the common one is
 * nearly always the one meant, which makes it the right ORDER and the wrong
 * basis for a silent decision.
 *
 * Exported for the tests, and pure apart from the tag store it is handed.
 */
/**
 * The base form a costume tag is always drawn with, or null.
 *
 *   asuna_(bunny)_(blue_archive) -> asuna_(blue_archive)
 *
 * Two parenthesised parts, the last one a franchise, and the base has to be a
 * real tag in the local database — a name that merely looks like a costume
 * (`kei_(student)` in a franchise that never tags `kei`) gets nothing.
 */
export function costumeBase(key, tagStore) {
  const m = /^(.+?)_\([^()]+\)_\(([^()]+)\)$/.exec(String(key ?? ''));
  if (!m) return null;
  const base = `${m[1]}_(${m[2]})`;
  return (tagStore?.postCount?.(base) ?? 0) > 0 ? base : null;
}

export function suggestCharacterTags(key, tagStore, limit = 5) {
  if (!key || !tagStore?.search) return [];
  const hits = tagStore.search(key, { variant: 'underscore', category: 4, limit: 8 });
  const results = hits?.results ?? [];
  // Already a character tag: nothing to suggest, the lookup will just work.
  if (results.some((r) => r.tag === key && !r.matched_alias)) return [];

  const byPrefix = results
    .filter((r) => !r.deprecated)
    .map((r) => ({ tag: r.tag, post_count: r.post_count }));

  // A CONTAINS pass as well, because prefix is the wrong shape for a bare
  // name: `miku` is not a prefix of `hatsune_miku`, and our alias data does
  // not connect them either, so prefix alone offered five Kancolle ships and
  // missed the character with 106,043 posts. `rem` reaches `rem_(re:zero)`
  // the same way.
  //
  // Only on this path, and only when the tag store offers it — 1–9ms over
  // 181,714 rows is fine once per miss and would not be fine once per letter,
  // which is why `search` stays a prefix search.
  const byContains = tagStore.findCharacters?.(key, limit) ?? [];

  const seen = new Set();
  return [...byPrefix, ...byContains]
    .filter((r) => (seen.has(r.tag) ? false : seen.add(r.tag)))
    .sort((a, b) => b.post_count - a.post_count)
    .slice(0, limit);
}

export function createTraitStore(rootDir, config, { warn = console.warn, fetchImpl = fetch } = {}) {
  const cfg = { ...DEFAULTS, ...(config.traits ?? {}) };
  // Built once: the list is config, so it cannot change under a running store.
  // The identity list lives in config/same-person.yaml, because it is data
  // rather than tuning: it grows one franchise at a time, it wants to be
  // picked up and put down, and keeping it out of server.yaml stops that file
  // gaining a hundred lines per franchise — and stops two machines editing the
  // same file, which has already cost one block of somebody else's work.
  //
  // Anything server.yaml still declares is merged on top, so an existing
  // `traits.same_person` keeps working and the test suite can pass groups
  // inline without a file on disk.
  // A missing file is not a fault — a deployment that wants no list, or a test
  // running out of a temp directory. A file that is THERE and will not parse
  // is, because silently subtracting characters from themselves is the whole
  // failure this list prevents.
  const declared = loadConfig(rootDir, 'same-person');
  if (declared.error && !/not found$/.test(declared.error)) warn(`[traits] ${declared.error}`);
  const identities = buildIdentityGroups([
    ...(declared.config?.same_person ?? []),
    ...(cfg.same_person ?? []),
  ]);
  const identityPrefixes = new Set(
    [...(declared.config?.same_person_prefixes ?? []), ...(cfg.same_person_prefixes ?? [])]
      .map((x) => String(x).trim().toLowerCase())
      .filter(Boolean)
  );
  const identitySuffixes = new Set(
    [...(declared.config?.same_person_suffixes ?? []), ...(cfg.same_person_suffixes ?? [])]
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  );
  // Characters whose character-table row describes somebody else as well —
  // see `table_contaminants` in config/same-person.yaml. Keyed by the
  // character, each naming whose look to take back out of that row.
  const tableContaminants = new Map();
  for (const source of [declared.config?.table_contaminants, cfg.table_contaminants]) {
    for (const [who, others] of Object.entries(source ?? {})) {
      const names = (Array.isArray(others) ? others : [others])
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean);
      if (names.length) tableContaminants.set(String(who).trim().toLowerCase(), names);
    }
  }
  // Hand corrections: tags taken off one character whatever the lookup says —
  // see `trait_remove` in config/same-person.yaml.
  const traitRemove = new Map();
  for (const source of [declared.config?.trait_remove, cfg.trait_remove]) {
    for (const [who, tags] of Object.entries(source ?? {})) {
      const set = new Set((Array.isArray(tags) ? tags : [tags])
        .map((x) => String(x).trim().toLowerCase().replace(/\s+/g, '_'))
        .filter(Boolean));
      if (set.size) traitRemove.set(String(who).trim().toLowerCase(), set);
    }
  }
  // Characters whose table row is everybody they are drawn with — see
  // `table_skip` in config/same-person.yaml. Never read from the table.
  const tableSkip = new Set(
    [...(declared.config?.table_skip ?? []), ...(cfg.table_skip ?? [])]
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  );
  const dbPath = path.join(rootDir, cfg.db_path);

  let db = null;
  let unavailable = null;

  // The character table. Opened read-only and apart from the cache, so a
  // missing or broken table falls back to the live lookup, and a cache that
  // will not open does not hide the table.
  let table = null;
  if (cfg.enabled && cfg.table) {
    const tablePath = path.join(rootDir, cfg.table_path);
    if (existsSync(tablePath)) {
      try {
        table = new DatabaseSync(tablePath, { readOnly: true });
      } catch (err) {
        warn(`[traits] character table unavailable: ${err.message}`);
      }
    }
  }

  const readTable = (key, tagStore) => {
    if (!table) return null;
    const rowFor = (name) => {
      try {
        return table.prepare('SELECT traits, posts, solo, gender FROM characters WHERE tag = ?').get(name);
      } catch {
        return null;
      }
    };
    let row = rowFor(key);
    // The table is keyed by whatever each list called the character when it
    // was built, and danbooru renames characters. Measured 15 Sep 2026, 6,019
    // of the 34,157 keys are no longer live danbooru tags, and the app can
    // only ever ask by the live name — so Gojo Satoru, Itadori Yuji, Ahri,
    // Jinx and 692 others were stored under a name nothing would look up.
    // Their retired names are in the live row's alias column.
    if (!row) {
      for (const retired of tagStore?.aliasesOf?.(key) ?? []) {
        row = rowFor(retired);
        if (row) break;
      }
    }
    if (!row) return null;
    // Only tags danbooru still has. The two lists were built from older
    // dumps, and measured 15 Sep 2026 they handed 53 of 96 characters `bangs`,
    // which our tag database — danbooru as of its last update — does not hold
    // at all. The live lookup already refuses a tag with no global count.
    // repairTableTags renames the ones danbooru merely renamed before the
    // rest are dropped; see its header for the split.
    const traits = cleanTableTraits(repairTableTags(JSON.parse(row.traits), tagStore));
    if (traits.length < cfg.table_min_traits) return null;
    return {
      character: key,
      traits,
      sampled: row.solo || row.posts || 0,
      posts: row.posts ?? null,
      gender: row.gender ?? null,
      source: 'table',
      mixed: false,
      cached: false,
    };
  };

  if (!cfg.enabled) {
    unavailable = 'character traits are disabled in config/server.yaml';
  } else {
    try {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS traits (
          character  TEXT PRIMARY KEY,
          traits     TEXT NOT NULL,
          sampled    INTEGER NOT NULL,
          fetched_at TEXT NOT NULL
        );
      `);
      // Added 2 Sep 2026 to an existing table, so ALTER rather than a schema
      // bump — every row already out there predates the contradiction fix and
      // defaults to 0, which is not RANK_VERSION and therefore a miss.
      const cols = db.prepare('PRAGMA table_info(traits)').all().map((c) => c.name);
      if (!cols.includes('rank_version')) {
        db.exec('ALTER TABLE traits ADD COLUMN rank_version INTEGER NOT NULL DEFAULT 0');
      }
      // Added 15 Sep 2026. Before it a mixed result lost its flag the moment
      // it was cached, so every later lookup presented other characters'
      // traits as this one's — how Gran's `erune` reached a user as fact.
      if (!cols.includes('mixed')) {
        db.exec('ALTER TABLE traits ADD COLUMN mixed INTEGER NOT NULL DEFAULT 0');
      }
      // Added 15 Sep 2026 with companion subtraction. Cached alongside the
      // traits because the character table has to be filtered by the same
      // companion on a cache hit, and without this the second lookup of a
      // character would hand back the traits the first one just removed.
      if (!cols.includes('companion')) {
        db.exec('ALTER TABLE traits ADD COLUMN companion TEXT');
      }
    } catch (err) {
      // A cache that will not open must not take the app down with it.
      unavailable = `trait cache unavailable: ${err.message}`;
      warn(`[traits] ${unavailable}`);
      db = null;
    }
  }

  const readCache = (character) => {
    if (!db) return null;
    const row = db.prepare('SELECT traits, sampled, fetched_at, rank_version, mixed, companion FROM traits WHERE character = ?').get(character);
    if (!row) return null;
    // The cache holds RANKED output, and readCache short-circuits before
    // rankTraits runs — so changing the ranking rules does nothing to any
    // character already cached, for up to cache_days. That is how the
    // white_hair/grey_hair fix would have shipped and silently not applied
    // for thirty days.
    //
    // Bump RANK_VERSION whenever rankTraits changes what it returns for the
    // same input. A stale row is then a miss and refetches on next use, which
    // costs one danbooru request per character actually looked at rather than
    // a mass invalidation.
    if ((row.rank_version ?? 0) !== RANK_VERSION) return null;
    const ageDays = (Date.now() - Date.parse(row.fetched_at)) / 86_400_000;
    if (ageDays > cfg.cache_days) return null;
    return {
      traits: JSON.parse(row.traits),
      sampled: row.sampled,
      mixed: Boolean(row.mixed),
      companion: row.companion ?? null,
      cached: true,
      age_days: Math.round(ageDays),
    };
  };

  const writeCache = (character, traits, sampled, mixed = false, companion = null) => {
    if (!db) return;
    db.prepare(
      `INSERT INTO traits (character, traits, sampled, fetched_at, rank_version, mixed, companion)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(character) DO UPDATE SET traits = excluded.traits,
         sampled = excluded.sampled, fetched_at = excluded.fetched_at,
         rank_version = excluded.rank_version, mixed = excluded.mixed,
         companion = excluded.companion`
    ).run(character, JSON.stringify(traits), sampled, new Date().toISOString(), RANK_VERSION, mixed ? 1 : 0, companion);
  };

  return {
    available: () => Boolean(db) && !unavailable,
    detail: () => unavailable,

    /**
     * Traits for one character tag: the live lookup, filled in from the
     * character table — see mergeTraits for why it is that way round. Where
     * the live lookup has nothing usable (a mixed sample, no posts, danbooru
     * unreachable) the table answers alone and says why in `live_reason`.
     * `tagStore` supplies the global post counts.
     *
     * Last, the hand corrections in `trait_remove` — see config/same-person.yaml.
     */
    async lookup(character, tagStore, opts = {}) {
      const out = await this.mergedLookup(character, tagStore, opts);
      const key = String(character ?? '').trim().toLowerCase().replace(/\s+/g, '_');
      const drop = traitRemove.get(key);
      if (!drop || !out?.traits?.length) return out;
      return { ...out, traits: out.traits.filter((t) => !drop.has(t.tag ?? t)) };
    },

    async mergedLookup(character, tagStore, opts = {}) {
      const key = String(character ?? '').trim().toLowerCase().replace(/\s+/g, '_');
      const live = await this.liveLookup(key, tagStore, opts);
      let fromTable = cfg.enabled && key && !tableSkip.has(key) ? readTable(key, tagStore) : null;
      // The table was built from the same posts the live sample was, so where
      // a companion contaminated one it contaminated the other. Without this
      // the mixed branch below hands back exactly the traits liveLookup just
      // removed — Dodoco losing Klee's hair from the sample and getting it
      // straight back from the table, with `mixed` cleared on the way out.
      if (fromTable && live.companion) {
        const borrowed = await this.companionTraits(live.companion.split(' ').filter(Boolean), tagStore, 0);
        if (borrowed) {
          const kept = fromTable.traits.filter((t) => !borrowed.tags.has(t.tag));
          fromTable = kept.length >= cfg.table_min_traits ? { ...fromTable, traits: kept } : null;
        }
      }
      // A table row can carry a co-star even where the live sample is clean,
      // and then nothing above fires. Ainz's row in the noob-wiki list reads
      // "1girl, demon girl, demon horns, large breasts, black wings, skeleton":
      // Albedo, plus one of his. His live sample was right, and the merge
      // appended her wings and breasts under it. Named by hand, because the
      // live side has no companion to point at.
      //
      // Subtracts the other character's table row as well as their live
      // traits. Albedo's live list is her 16 most distinctive tags, so live
      // alone left her `large_breasts` and `very_long_hair` on him — the same
      // leftover that keeps Topaz's hair on Numby. Anything this character's
      // own live sample carries is kept, whoever else also has it.
      const contaminants = fromTable ? tableContaminants.get(key) : null;
      if (contaminants) {
        const theirs = new Set();
        for (const who of contaminants) {
          const l = await this.liveLookup(who, tagStore, { depth: 1 });
          if (l?.traits?.length && !l.mixed) for (const t of l.traits) theirs.add(t.tag);
          for (const t of readTable(who, tagStore)?.traits ?? []) theirs.add(t.tag);
        }
        const own = new Set((live.traits ?? []).map((t) => t.tag));
        const kept = fromTable.traits.filter((t) => own.has(t.tag) || !theirs.has(t.tag));
        fromTable = kept.length >= cfg.table_min_traits ? { ...fromTable, traits: kept } : null;
      }
      if (!fromTable) return live;
      // A mixed sample normally defers to the table, which is the cleaner of
      // two poor sources. Once a companion has been subtracted from BOTH they
      // are no longer poor in the same way, and the live side is the half that
      // holds what is actually this character's — Oz's `crow` and `bird`, which
      // the table never had. So merge instead of discarding it. `mixed` still
      // rides along, because a sample with the contaminant removed is cleaner,
      // not clean.
      if (!live.traits?.length || (live.mixed && !live.companion)) {
        return {
          ...fromTable,
          companion: live.companion ?? null,
          live_reason: live.mixed ? 'mixed sample' : live.reason ?? null,
        };
      }
      return {
        ...live,
        traits: mergeTraits(live.traits, fromTable.traits),
        source: 'live+table',
        posts: fromTable.posts,
        gender: fromTable.gender,
      };
    },

    /**
     * One danbooru sample, ranked and cached; the table is not consulted.
     * Cached lookups are instant; a miss costs one or two requests.
     */
    async liveLookup(character, tagStore, { refresh = false, depth = 0 } = {}) {
      // Danbooru tags are underscored. The frontend holds them in whatever
      // spelling its model wants — Pony's pills say "makima (chainsaw man)" —
      // so accept either and normalise. Safe in this one direction: a danbooru
      // character tag never contains a literal space, so nothing is lost.
      let key = String(character ?? '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!key) return { character: key, traits: [], reason: 'no character given' };
      if (unavailable) return { character: key, traits: [], reason: unavailable };

      // A bare name is usually not the tag. Danbooru disambiguates most
      // characters with a series suffix — `makima` is a category-0 general tag
      // with **zero posts**, and the character is `makima_(chainsaw_man)` —
      // so looking up what someone typed returns an empty sample and the panel
      // says "no posts found", which is true and useless.
      //
      // Measured 26 Aug 2026 while comparing trait rankings: the tuning
      // comments in config/server.yaml cite "makima", so even the numbers this
      // file was tuned against were taken under a name that does not resolve.
      //
      // Suggested, never substituted — see suggestCharacterTags for the
      // measurement that settled it. Computed against the local tag database,
      // which is already open and already category-aware, so this costs
      // nothing and needs no network.
      const suggestions = suggestCharacterTags(key, tagStore);

      if (!refresh) {
        const hit = readCache(key);
        if (hit) return { character: key, ...hit };
      }

      // Danbooru's own counts first — see related_query. Anything wrong with
      // the answer (an error, an odd shape, too few posts behind it) falls
      // through to sampling posts below, which is the method this replaced.
      // A costume is never drawn alone. Danbooru tags every post of
      // `asuna_(bunny)_(blue_archive)` with `asuna_(blue_archive)` as well, so
      // `chartags:1` finds 0 of her 6,958 posts, and the lookup fell through
      // to the newest page of everything — which on 19 Sep 2026 was the
      // anniversary group pictures, and she came back with twelve club tags,
      // `absolutely_everyone` and Mika's wings. Her and her base form with
      // nobody else is the costume's solo post: 5,332 of them. Asked only
      // when the solo query comes up short, so a franchise that tags costumes
      // alone keeps the query it had.
      const base = costumeBase(key, tagStore);
      const soloTerms = [['chartags:1'], ...(base ? [[base, 'chartags:2']] : [])];

      if (cfg.related_query) {
        const askRelated = async (terms) => {
          try {
            const query = [key, ...terms, cfg.rating_filter ? `rating:${cfg.rating_filter}` : null]
              .filter(Boolean).join(' ');
            const url = `${cfg.base_url}/related_tag.json?query=${encodeURIComponent(query)}` +
              `&category=general&limit=${cfg.related_limit}`;
            const res = await fetchImpl(url, {
              headers: { 'user-agent': 'PromptForge/2.0 (private local tool)' },
              signal: AbortSignal.timeout(cfg.timeout_ms),
            });
            return res.ok ? await res.json() : null;
          } catch {
            return null;
          }
        };
        let related = null;
        for (const terms of soloTerms) {
          related = await askRelated(terms);
          if ((Number(related?.post_count) || 0) >= cfg.min_sample) break;
        }
        const total = Number(related?.post_count) || 0;
        if (Array.isArray(related?.related_tags) && total >= cfg.min_sample) {
          // Frequencies back into counts, so rankTraits sees exactly what it
          // sees from a sample: how many of `total` posts carried each tag.
          const tally = new Map();
          for (const r of related.related_tags) {
            const name = r?.tag?.name;
            const freq = Number(r?.frequency);
            if (name && freq > 0) tally.set(name, Math.round(freq * total));
          }
          const traits = rankTraits(
            tally,
            total,
            (tag) => tagStore?.postCount?.(tag) ?? 0,
            cfg,
            (tag) => tagStore?.isDeprecated?.(tag) ?? false
          );
          if (traits.length) {
            writeCache(key, traits, total, false);
            return { character: key, traits, sampled: total, fetched: total, mixed: false, method: 'related', cached: false };
          }
        }
      }

      const fetchPosts = async (terms) => {
        const query = [
          key,
          ...terms,
          cfg.rating_filter ? `rating:${cfg.rating_filter}` : null,
        ].filter(Boolean).join(' ');
        const url = `${cfg.base_url}/posts.json?tags=${encodeURIComponent(query)}&limit=${cfg.fetch_limit}`;
        const res = await fetchImpl(url, {
          headers: { 'user-agent': 'PromptForge/2.0 (private local tool)' },
          signal: AbortSignal.timeout(cfg.timeout_ms),
        });
        if (!res.ok) return { error: `danbooru returned ${res.status}` };
        return { posts: await res.json() };
      };

      let posts;
      try {
        let got = { posts: [] };
        for (const terms of cfg.solo_query ? soloTerms : []) {
          got = await fetchPosts(terms);
          if (got.error) return { character: key, traits: [], reason: got.error };
          if (Array.isArray(got.posts) && got.posts.length >= cfg.min_sample) break;
        }
        posts = got.posts;
        // Too few posts of her alone to rank from: ask for everything, and let
        // the filter and the mixed flag below handle it exactly as before.
        if (!cfg.solo_query || (Array.isArray(posts) && posts.length < cfg.min_sample)) {
          got = await fetchPosts([]);
          if (got.error) return { character: key, traits: [], reason: got.error };
          posts = got.posts;
        }
      } catch (err) {
        // Offline is a normal state for a tailnet box. Say so plainly.
        return { character: key, traits: [], reason: `could not reach danbooru: ${err.message}` };
      }

      if (!Array.isArray(posts) || posts.length === 0) {
        // The commonest cause is a bare name rather than a missing character:
        // danbooru disambiguates most of them with a series suffix, so
        // `makima` has zero posts while `makima_(chainsaw_man)` has 10,932.
        // Handing back the candidates turns a dead end into one click.
        return {
          character: key,
          traits: [],
          sampled: 0,
          reason: suggestions.length ? 'no posts under that exact tag' : 'no posts found for that tag',
          suggestions,
        };
      }

      // Keep only posts where this character is the ONLY character, because a
      // post with two characters cannot say which one the tags belong to.
      //
      // Measured on fern_(sousou_no_frieren), who is almost never drawn alone:
      // unfiltered, the top traits were elf, pointy_ears and white_dress —
      // all Frieren's, not hers — and lift ranked `elf` (58) above her one
      // defining feature, `purple_hair` (12), because elves are globally rarer
      // than purple hair. Filtered, elf and pointy_ears vanish and
      // `blunt_bangs` appears, which is genuinely hers. 36 of 100 posts
      // survived the filter.
      // A costume's base form does not count as a second character.
      const self = new Set([key, base].filter(Boolean));
      const solo = posts.filter((p) => {
        const chars = String(p.tag_string_character ?? '').split(' ').filter(Boolean);
        return chars.length === 1 || (chars.length > 1 && chars.every((c) => self.has(c)));
      });
      // Too few to rank from. Better a contaminated answer that says it is
      // contaminated than six posts presented as fact.
      const mixed = solo.length < cfg.min_sample;
      const used = mixed ? posts : solo;

      const tally = new Map();
      for (const p of used) {
        for (const t of String(p.tag_string_general ?? '').split(' ').filter(Boolean)) {
          tally.set(t, (tally.get(t) ?? 0) + 1);
        }
      }

      const rank = (t) => rankTraits(
        t,
        used.length,
        (tag) => tagStore?.postCount?.(tag) ?? 0,
        cfg,
        (tag) => tagStore?.isDeprecated?.(tag) ?? false
      );

      // Whoever this character is always drawn with. Off by default — see the
      // `companion` note in DEFAULTS for the measurement behind that.
      const companions = cfg.companion && mixed
        ? companionsIn(key, used, cfg.companion_share, identities, identitySuffixes, identityPrefixes)
        : [];
      const borrowed = await this.companionTraits(companions, tagStore, depth);
      if (borrowed) for (const tag of borrowed.tags) tally.delete(tag);
      const traits = rank(tally);
      writeCache(key, traits, used.length, mixed, borrowed ? borrowed.of.join(' ') : null);
      return {
        character: key,
        traits,
        sampled: used.length,
        fetched: posts.length,
        // The caller should say so in the UI: these may describe whoever else
        // was in frame.
        mixed,
        // Named when their traits were subtracted, so the caller can say whose
        // they were and filter the character table by the same set.
        companion: borrowed ? borrowed.of.join(' ') : null,
        method: 'posts',
        cached: false,
      };
    },

    /**
     * The combined traits of the characters this one is always drawn with, as
     * a set to subtract — or null when there is nobody, or nobody worth
     * trusting.
     *
     * Only ever one level deep. A companion whose own sample is mixed is
     * skipped rather than subtracted: two characters drawn only with each
     * other know nothing about each other, and subtracting a guess from a
     * guess leaves a worse guess. `depth` guards a pair that name each other.
     * `slime_(genshin_impact)` is the live example — two of its three co-stars
     * are other slimes, equally unsamplable, and only Nahida is subtracted.
     *
     * Not `refresh`ed: companions are looked up through the normal cache, so
     * the common case costs one database read each.
     *
     * @returns {{tags:Set<string>, of:string[]}|null} what to subtract, and
     *          whose it was — `of` lists only the companions actually used.
     */
    async companionTraits(companions, tagStore, depth = 0) {
      const list = Array.isArray(companions) ? companions : [companions].filter(Boolean);
      if (!list.length || depth > 0) return null;
      const tags = new Set();
      const of = [];
      for (const who of list) {
        const their = await this.liveLookup(who, tagStore, { depth: depth + 1 });
        if (!their?.traits?.length || their.mixed) continue;
        for (const t of their.traits) tags.add(t.tag);
        of.push(who);
      }
      return of.length ? { tags, of } : null;
    },

    close() {
      try { db?.close(); } catch { /* already gone */ }
      // The character table too. Left open, Windows keeps the file locked,
      // which is why test-traits could not clean up its folder there.
      try { table?.close(); } catch { /* already gone */ }
    },
  };
}
