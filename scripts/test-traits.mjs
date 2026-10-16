// Character trait lookup — ranking, caching, and every degradation path.
//
//   npm run test-traits
//
// Needs no network and no model. The one place a real danbooru response is
// involved is a saved fixture, so the numbers below are the ones actually
// measured on 21 Aug rather than invented for the test.

import {
  rankTraits, createTraitStore, suggestCharacterTags, cleanTableTraits, repairTableTags,
  companionsIn, buildIdentityGroups, costumeBase,
} from '../server/traits.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
// Counted rather than hardcoded. The reported total was the literal 38 until
// 26 Aug 2026, so adding an assertion left the summary claiming a number that
// had stopped being true - and check.mjs reads that number.
let passes = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (cond) passes += 1; else failures += 1;
};

// The real Makima sample: 40 posts, tag counts as danbooru returned them, and
// the real global post counts out of tags.sqlite. Kept as data so the ranking
// can be checked without either dependency.
const SAMPLED = 40;
const TALLY = new Map(Object.entries({
  ringed_eyes: 29, red_hair: 33, yellow_eyes: 29, '1girl': 32, braided_ponytail: 18,
  braid: 23, shirt: 23, white_shirt: 20, necktie: 19, long_hair: 22,
  looking_at_viewer: 21, breasts: 21, black_necktie: 15, sidelocks: 16, solo: 18,
  collared_shirt: 15, closed_mouth: 13, simple_background: 13, hair_between_eyes: 12,
  '1boy': 11, long_sleeves: 11, white_background: 9, black_hair: 7,
}));
const GLOBAL = {
  ringed_eyes: 20071, red_hair: 516181, yellow_eyes: 687402, '1girl': 5975112,
  braided_ponytail: 30818, braid: 626166, shirt: 1800468, white_shirt: 836409,
  necktie: 439582, long_hair: 4323141, looking_at_viewer: 3293425, breasts: 3418210,
  black_necktie: 62277, sidelocks: 607589, solo: 4974437, collared_shirt: 443589,
  closed_mouth: 1156328, simple_background: 1805467, hair_between_eyes: 1155038,
  '1boy': 1393980, long_sleeves: 1555934, white_background: 1484091, black_hair: 1900000,
};
const counts = (tag) => GLOBAL[tag] ?? 0;

console.log('\nrankTraits — traits must beat furniture\n');

const ranked = rankTraits(TALLY, SAMPLED, counts);
const kept = ranked.map((r) => r.tag);

ok(kept[0] === 'ringed_eyes', 'the rarest characteristic tag ranks first', kept[0]);
ok(kept.includes('red_hair'), 'red_hair is kept — the trait the 8B got wrong');
ok(kept.includes('yellow_eyes') && kept.includes('white_shirt'), 'eye and clothing traits are kept');

for (const junk of ['1girl', 'solo', 'looking_at_viewer', 'breasts', 'simple_background']) {
  ok(!kept.includes(junk), `generic tag is dropped: ${junk}`);
}

// `long_hair` sat in the list above until 15 Sep 2026. It is on 22 of her 40
// posts — a majority — and it is her canon (a long braid), but at 4.3M global
// posts its lift is 1.77, so the floor always cut it. The majority rule keeps
// a hair length most of her own posts carry.
ok(kept.includes('long_hair'), 'long_hair is kept: most of her posts carry it (majority rule)');

// The distinction a person would draw by hand, and the clearest evidence the
// metric is doing something real rather than just favouring rare tags.
ok(
  kept.includes('white_shirt') && !kept.includes('shirt'),
  'keeps white_shirt but drops its generic parent shirt'
);

// black_hair is present in the sample (other characters in frame) but is
// neither frequent enough nor characteristic. It must not survive, because it
// is precisely the wrong answer this whole feature exists to prevent.
ok(!kept.includes('black_hair'), 'black_hair does not survive — the wrong answer stays out');

ok(ranked.every((r) => r.lift >= 3 || r.share >= 0.5),
  'everything kept clears the lift floor, or is a look most of her posts carry');
ok(
  ranked.length === [...ranked].sort((a, b) => b.lift - a.lift).length &&
    ranked.every((r, i, a) => i === 0 || a[i - 1].lift >= r.lift),
  'results are ordered by lift, strongest first'
);

console.log('\nrankTraits — edges\n');

ok(rankTraits(new Map(), 0, counts).length === 0, 'no posts sampled returns nothing');
ok(rankTraits(TALLY, SAMPLED, () => 0).length === 0, 'no global counts returns nothing, rather than everything');
// A tag danbooru knows and our database does not must not be promoted. Without
// this, a typo or a brand-new tag reads as infinitely rare and tops the list.
{
  const t = new Map([['brand_new_tag', 40], ['red_hair', 33]]);
  const r = rankTraits(t, SAMPLED, counts).map((x) => x.tag);
  ok(!r.includes('brand_new_tag'), 'a tag with no known global count is skipped, not ranked first');
  ok(r.includes('red_hair'), 'and the known tag beside it still ranks');
}
// Looks are exempt from the cap since 15 Sep 2026 (see rankTraits), so what
// is capped is everything else.
{
  const { isLookTrait } = await import('../server/traits.mjs');
  const capped = rankTraits(TALLY, SAMPLED, counts, { max_traits: 3 });
  ok(capped.filter((r) => !isLookTrait(r.tag)).length === 3, 'max_traits caps everything but the looks',
    capped.map((r) => r.tag).join(', '));
}
ok(
  // Majority and front-runner rules off, so only lift decides — what this checks.
  rankTraits(TALLY, SAMPLED, counts, { min_lift: 100, majority_share: 2, plurality_margin: null }).map((r) => r.tag).join(',') ===
    'ringed_eyes,braided_ponytail',
  'raising the lift floor narrows to the most characteristic tags'
);

console.log('\ncreateTraitStore — degradation and caching\n');

const dir = mkdtempSync(path.join(tmpdir(), 'pf-traits-'));
const tagStore = { postCount: counts };

{
  const store = createTraitStore(dir, { traits: { enabled: false } });
  const r = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(!store.available(), 'disabled in config reports unavailable');
  ok(r.traits.length === 0 && /disabled/.test(r.reason), 'and returns a reason, not a throw', r.reason);
  store.close();
}

const fixture = () => ({
  ok: true,
  json: async () =>
    Array.from({ length: SAMPLED }, (_, i) => ({
      tag_string_general: [...TALLY.entries()]
        .filter(([, c]) => c > i)
        .map(([t]) => t)
        .join(' '),
    })),
});

{
  let calls = 0;
  // related_query off: this block counts requests, and is about the post
  // sampling that remains the fallback. The related-tags path has its own.
  const store = createTraitStore(dir, { traits: { db_path: 'a.sqlite', related_query: false } }, {
    fetchImpl: async () => { calls += 1; return fixture(); },
  });
  const first = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(first.traits.length > 0 && first.cached === false, 'a miss fetches and returns traits');
  ok(first.traits.some((t) => t.tag === 'red_hair'), 'the fetched result carries real traits');
  const second = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(second.cached === true, 'the second lookup is served from cache');
  ok(calls === 1, 'and cost no second request', `${calls} call(s)`);
  const forced = await store.lookup('makima_(chainsaw_man)', tagStore, { refresh: true });
  ok(forced.cached === false && calls === 2, 'refresh bypasses the cache');
  // Case and whitespace must not split the cache into duplicate rows.
  const messy = await store.lookup('  MAKIMA_(Chainsaw_Man)  ', tagStore);
  ok(messy.cached === true && calls === 2, 'lookup is case and whitespace insensitive');
  store.close();
}

// The single-character filter. A post with two characters cannot say which one
// the tags belong to — measured on Fern, who is almost never drawn alone:
// unfiltered, her top traits were elf and pointy_ears, which are Frieren's.
{
  const post = (chars, tags) => ({ tag_string_character: chars, tag_string_general: tags });
  // 20 solo posts carrying her traits, 20 shared ones carrying someone else's.
  const mixedFeed = [
    ...Array.from({ length: 20 }, () => post('fern_(sousou_no_frieren)', 'purple_hair blunt_bangs')),
    ...Array.from({ length: 20 }, () =>
      post('fern_(sousou_no_frieren) frieren', 'elf pointy_ears purple_hair')),
  ];
  const store = createTraitStore(dir, { traits: { db_path: 'f.sqlite', min_sample: 12 } }, {
    fetchImpl: async () => ({ ok: true, json: async () => mixedFeed }),
  });
  const r = await store.lookup('fern_(sousou_no_frieren)', {
    postCount: (t) => ({ purple_hair: 300000, blunt_bangs: 200000, elf: 120000, pointy_ears: 500000 }[t] ?? 0),
  });
  const got = r.traits.map((t) => t.tag);
  ok(r.sampled === 20 && r.fetched === 40, 'only single-character posts are ranked', `${r.sampled} of ${r.fetched}`);
  ok(!got.includes('elf') && !got.includes('pointy_ears'), 'the other character\'s traits are gone');
  ok(got.includes('purple_hair'), 'and her own survive');
  ok(r.mixed === false, 'a sufficient solo sample is not flagged mixed');
  store.close();
}

// A character who is never drawn alone. Falling back is right — a contaminated
// answer that says it is contaminated beats ranking traits off four posts.
{
  const post = (chars, tags) => ({ tag_string_character: chars, tag_string_general: tags });
  const feed = [
    ...Array.from({ length: 4 }, () => post('sidekick', 'green_hair')),
    ...Array.from({ length: 36 }, () => post('sidekick hero', 'green_hair cape')),
  ];
  const store = createTraitStore(dir, { traits: { db_path: 'g.sqlite', min_sample: 12 } }, {
    fetchImpl: async () => ({ ok: true, json: async () => feed }),
  });
  const r = await store.lookup('sidekick', { postCount: (t) => ({ green_hair: 200000, cape: 150000 }[t] ?? 0) });
  ok(r.mixed === true, 'too few solo posts falls back and flags the result mixed');
  ok(r.sampled === 40, 'the fallback ranks the whole sample', String(r.sampled));
  store.close();
}

{
  const store = createTraitStore(dir, { traits: { db_path: 'b.sqlite' } }, {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  const r = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(r.traits.length === 0 && /could not reach danbooru/.test(r.reason), 'offline degrades with a reason', r.reason);
  store.close();
}

{
  const store = createTraitStore(dir, { traits: { db_path: 'c.sqlite' } }, {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  const r = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(/429/.test(r.reason), 'a rate limit surfaces its status', r.reason);
  store.close();
}

{
  const store = createTraitStore(dir, { traits: { db_path: 'd.sqlite' } }, {
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  const r = await store.lookup('nobody_(nothing)', tagStore);
  ok(r.traits.length === 0 && /no posts found/.test(r.reason), 'an unknown character says so', r.reason);
  store.close();
}

{
  const store = createTraitStore(dir, { traits: { db_path: 'e.sqlite' } }, { fetchImpl: fixture });
  const r = await store.lookup('', tagStore);
  ok(r.traits.length === 0 && /no character/.test(r.reason), 'an empty character is refused');
  // No tag database at all — the common state on a fresh checkout.
  const noTags = await store.lookup('makima_(chainsaw_man)', null);
  ok(noTags.traits.length === 0, 'no tag database means no traits, not a crash');
  store.close();
}


console.log('\nsuggestCharacterTags — offer, never pick\n');

// A fake tag store shaped like the real one: prefix matches first, then alias
// matches, which is the order server/tags.mjs returns.
const fakeTags = (rows) => ({
  search(q, { limit = 8 } = {}) {
    const needle = String(q).toLowerCase();
    const prefix = rows
      .filter((r) => r.tag.startsWith(needle))
      .map((r) => ({ ...r, matched_alias: false }));
    const alias = rows
      .filter((r) => !r.tag.startsWith(needle) && (r.aliases ?? []).includes(needle))
      .map((r) => ({ ...r, matched_alias: true }));
    return { ok: true, results: [...prefix, ...alias].slice(0, limit) };
  },
});

{
  const store = fakeTags([{ tag: 'makima_(chainsaw_man)', post_count: 10932, deprecated: false }]);
  const out = suggestCharacterTags('makima', store);
  ok(out.length === 1 && out[0].tag === 'makima_(chainsaw_man)',
    'a bare name gets the qualified tag as a suggestion', JSON.stringify(out));
}

// The case that killed auto-resolution, and the reason this suggests rather
// than substitutes. Resolving took the query's first row, which was a prefix
// match on an unrelated Kancolle ship, over the 144k-post character reachable
// only as an alias.
{
  const store = fakeTags([
    { tag: 'mikuma_(kancolle)', post_count: 3000, deprecated: false },
    { tag: 'hatsune_miku', post_count: 144237, deprecated: false, aliases: ['miku'] },
  ]);
  const out = suggestCharacterTags('miku', store);
  ok(out[0]?.tag === 'hatsune_miku',
    'the popular alias outranks an unrelated prefix match',
    out.map((o) => o.tag).join(', '));
  ok(out.length === 2,
    '...and the other candidate is still offered rather than hidden', String(out.length));
}

{
  const store = fakeTags([{ tag: 'frieren', post_count: 16095, deprecated: false }]);
  ok(suggestCharacterTags('frieren', store).length === 0,
    'a name that IS a character tag suggests nothing, because the lookup will work');
}

// An alias hit on the exact name is not the same as being that tag: typing
// `miku` must still get suggestions even though something matched it.
{
  const store = fakeTags([
    { tag: 'hatsune_miku', post_count: 144237, deprecated: false, aliases: ['miku'] },
  ]);
  ok(suggestCharacterTags('miku', store).length === 1,
    'an alias match still suggests, since the typed name is not itself the tag');
}

{
  const store = fakeTags([{ tag: 'old_name_(series)', post_count: 900, deprecated: true }]);
  ok(suggestCharacterTags('old_name', store).length === 0,
    'a retired tag is never suggested');
}

{
  ok(suggestCharacterTags('anything', null).length === 0,
    'no tag database suggests nothing rather than throwing');
  ok(suggestCharacterTags('', fakeTags([])).length === 0,
    'an empty name suggests nothing');
}


console.log('\ncontradictory traits — one head, one colour\n');

{
  // Frieren's real problem, in the shape rankTraits sees it: danbooru carries
  // both spellings because artists draw her both ways, and until 2 Sep 2026
  // both reached the model. `grey_hair` is globally RARER than `white_hair`,
  // so ranking by lift picks grey; the local tally says white, and the local
  // tally is the community's vote on this character.
  const tally = new Map([
    ['white_hair', 31], ['grey_hair', 12], ['long_pointy_ears', 30],
    ['green_eyes', 28], ['blue_eyes', 9], ['white_capelet', 22],
  ]);
  const global = {
    white_hair: 520000, grey_hair: 190000, long_pointy_ears: 41000,
    green_eyes: 690000, blue_eyes: 1500000, white_capelet: 9000,
  };
  const r = rankTraits(tally, 40, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(r.includes('white_hair'), 'the colour most of her posts carry survives', r.join(', '));
  ok(!r.includes('grey_hair'), 'the minority spelling is dropped, not offered alongside');
  ok(r.includes('green_eyes') && !r.includes('blue_eyes'), 'same rule for eyes');
  ok(r.includes('long_pointy_ears') && r.includes('white_capelet'),
    'non-colour traits are untouched');
}

{
  // Lift and the tally disagree on purpose here: grey is rarer globally and so
  // outranks white on lift, while white leads the local count. The tally wins.
  const tally = new Map([['white_hair', 30], ['grey_hair', 20]]);
  const global = { white_hair: 520000, grey_hair: 50000 };
  const r = rankTraits(tally, 40, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(r.length === 1 && r[0] === 'white_hair',
    'the local tally beats lift when they disagree', r.join(', '));
}

{
  // A character who genuinely has two hair colours. The dedupe must not fire.
  const tally = new Map([
    ['pink_hair', 30], ['blue_hair', 28], ['two-tone_hair', 26], ['red_eyes', 25],
  ]);
  const global = { pink_hair: 400000, blue_hair: 450000, 'two-tone_hair': 60000, red_eyes: 900000 };
  const r = rankTraits(tally, 40, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(r.includes('pink_hair') && r.includes('blue_hair'),
    'two-tone_hair spares both colours', r.join(', '));
}

{
  // Hair LENGTH is not a colour and these reinforce rather than contradict.
  //
  // `long_hair` is deliberately NOT in this fixture. At 4.3M global posts its
  // lift is 1.77 against a min_lift of 3, so it never reaches the dedupe — an
  // earlier version of this test used it and failed for that reason, which
  // would have looked like the dedupe eating a length tag.
  const tally = new Map([['very_long_hair', 34], ['absurdly_long_hair', 30], ['messy_hair', 22]]);
  const global = { very_long_hair: 900000, absurdly_long_hair: 60000, messy_hair: 200000 };
  const r = rankTraits(tally, 40, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(r.includes('very_long_hair') && r.includes('absurdly_long_hair'),
    'hair length is left alone — two length tags co-occur legitimately', r.join(', '));
}

console.log('\nformat tags — what the picture is, never who is in it\n');
{
  // shiroko_terror_(blue_archive) handed the model `comic` as canon on 11 Sep
  // 2026: enough of her posts are comic pages that it cleared both
  // thresholds. The numbers here are chosen so it would clear them again —
  // share 0.75, lift ~17 — which makes FRAMING, not the thresholds, the thing
  // under test.
  const tally = new Map([['comic', 30], ['4koma', 20], ['wolf_ears', 35], ['grey_hair', 38]]);
  const global = { comic: 400000, '4koma': 90000, wolf_ears: 150000, grey_hair: 600000 };
  const r = rankTraits(tally, 40, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(!r.includes('comic') && !r.includes('4koma'), 'a format tag is never ranked as a trait', r.join(', '));
  ok(r.includes('wolf_ears') && r.includes('grey_hair'), '...while her real traits still are', r.join(', '));
}

console.log('\nthe majority rule — a common look most of her posts carry\n');
{
  // Gran, 15 Sep 2026: brown hair on 62% of a sample scores lift 2.7 because
  // brown hair is on ~23% of danbooru, and was cut. Short hair can never
  // reach lift 3 at all. The numbers here reproduce that shape.
  const tally = new Map([['brown_hair', 25], ['short_hair', 21], ['hood', 16], ['1boy', 30], ['smile', 22]]);
  const global = { brown_hair: 2_080_000, short_hair: 3_150_000, hood: 450_000, '1boy': 1_394_000, smile: 3_900_000 };
  const r = rankTraits(tally, 40, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(r.includes('brown_hair') && r.includes('short_hair'),
    "a majority's hair colour and length survive a low lift", r.join(', '));
  ok(r.includes('hood'), '...and a real trait that clears lift is untouched');
  ok(!r.includes('1boy') && !r.includes('smile'), '...while framing and a common non-look tag still do not');
}
{
  // A long list of distinctive tags all out-lifts a common look, so a cap
  // would cut the look first. A precaution, not a measured failure: three
  // rare tags, a cap of two.
  const tally = new Map([['red_horns', 30], ['cross-shaped_pupils', 28], ['sharp_teeth', 26], ['yellow_eyes', 14]]);
  const global = { red_horns: 20000, 'cross-shaped_pupils': 15000, sharp_teeth: 30000, yellow_eyes: 690000 };
  const r = rankTraits(tally, 40, (t) => global[t] ?? 0, { max_traits: 2 }).map((x) => x.tag);
  ok(r.includes('yellow_eyes'), 'a look is never cut by the cap', r.join(', '));
  ok(r.filter((t) => t !== 'yellow_eyes').length === 2, '...while everything else still is', r.join(', '));
}
{
  // Power's real counts, 15 Sep 2026: 1,182 posts of her alone, with the
  // real global counts from tags.sqlite. Yellow leads but is neither a
  // majority nor over the lift floor (2.88).
  const tally = new Map([['yellow_eyes', 385], ['red_eyes', 252], ['orange_eyes', 213], ['horns', 1132]]);
  const global = { yellow_eyes: 1_019_305, red_eyes: 1_773_608, orange_eyes: 480_000, horns: 688_382 };
  const r = rankTraits(tally, 1182, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(r.includes('yellow_eyes') && !r.includes('red_eyes'), 'the clear front-runner colour passes', r.join(', '));
  // A real split: neither leads by the margin, so neither is claimed.
  const split = new Map([['yellow_eyes', 350], ['red_eyes', 330]]);
  const s = rankTraits(split, 1182, (t) => global[t] ?? 0).map((x) => x.tag);
  ok(!s.includes('yellow_eyes') && !s.includes('red_eyes'), 'an even split claims neither colour', s.join(', '));
}

console.log('\nthe character table — cleaned on read, answered first\n');
{
  const cleaned = cleanTableTraits([
    { tag: '1boy', sources: ['noob'] },
    { tag: 'brown_hair', sources: ['deepghs', 'noob'] },
    { tag: 'blonde_hair', sources: ['noob'] },
    { tag: 'brown_eyes', sources: ['deepghs', 'noob'] },
    { tag: 'short_hair', sources: ['deepghs', 'noob'] },
    { tag: 'medium_breasts', sources: ['noob'] },
    { tag: 'large_breasts', sources: ['deepghs', 'noob'] },
    { tag: 'thighs', sources: ['noob'] },
    { tag: 'cleavage', sources: ['noob'] },
    { tag: 'mole_under_eye', sources: ['noob'] },
  ]).map((t) => t.tag);
  ok(!cleaned.includes('1boy'), 'framing never comes back from the table');
  ok(!cleaned.includes('thighs') && !cleaned.includes('cleavage'),
    'what the picture shows of the body is not a trait', cleaned.join(', '));
  ok(cleaned.includes('brown_hair') && !cleaned.includes('blonde_hair'),
    'one hair colour: the one both lists agree on', cleaned.join(', '));
  ok(cleaned.includes('large_breasts') && !cleaned.includes('medium_breasts'), 'one size, by the same rule');
  ok(['short_hair', 'mole_under_eye', 'brown_eyes'].every((t) => cleaned.includes(t)),
    'everything else survives', cleaned.join(', '));
}
{
  const tie = cleanTableTraits([
    { tag: 'white_hair', sources: ['noob'] }, { tag: 'grey_hair', sources: ['noob'] },
  ]).map((t) => t.tag);
  ok(tie.join(',') === 'white_hair', 'on a tie the earlier-listed colour wins', tie.join(','));
  const len = cleanTableTraits([
    { tag: 'long_hair', sources: ['deepghs', 'noob'] }, { tag: 'medium_hair', sources: ['noob'] },
    { tag: 'very_long_hair', sources: ['noob'] },
  ]).map((t) => t.tag);
  ok(len.includes('long_hair') && !len.includes('medium_hair') && len.includes('very_long_hair'),
    'one hair length, and very long rides with long', len.join(', '));
  const shortWins = cleanTableTraits([
    { tag: 'short_hair', sources: ['deepghs', 'noob'] }, { tag: 'very_long_hair', sources: ['noob'] },
  ]).map((t) => t.tag);
  ok(shortWins.join(',') === 'short_hair', 'very long hair falls with long when short wins', shortWins.join(', '));
  const streaked = cleanTableTraits([
    { tag: 'blonde_hair', sources: ['noob'] }, { tag: 'blue_hair', sources: ['noob'] },
    { tag: 'streaked_hair', sources: ['noob'] },
  ]).map((t) => t.tag);
  ok(streaked.includes('blonde_hair') && streaked.includes('blue_hair'),
    'streaked hair keeps both colours', streaked.join(', '));
}
{
  // Dead names in the table. A stub store that knows three live tags and one
  // rename, shaped like the real one: postCount answers 0 for anything gone.
  const LIVE = { qipao: 55967, brown_hair: 900000, hairclip: 29886, twintails: 200000 };
  const RENAMED = { china_dress: 'qipao', hairpin: 'hairclip' };
  const store = {
    loaded: true,
    postCount: (t) => LIVE[t] ?? 0,
    aliasTarget: (t) => RENAMED[t] ?? null,
  };
  const repaired = repairTableTags([
    { tag: 'china_dress', sources: ['deepghs', 'noob'] },
    { tag: 'bangs', sources: ['noob'] },
    { tag: 'brown_hair', sources: ['deepghs'] },
    { tag: 'hairpin', sources: ['noob'] },
  ], store).map((t) => t.tag);
  ok(repaired.includes('qipao') && !repaired.includes('china_dress'),
    'a renamed tag is renamed, not dropped', repaired.join(', '));
  ok(!repaired.includes('bangs'), 'a tag deprecated with no replacement is dropped', repaired.join(', '));
  ok(repaired.includes('brown_hair'), 'a live tag is left alone', repaired.join(', '));

  const kept = repairTableTags([{ tag: 'china_dress', sources: [] }], store)[0];
  ok(Array.isArray(kept.sources), 'a rename keeps its sources, so the tie-break still works');

  // A rename that lands on a tag already present must not leave both. This is
  // why repair runs before cleanTableTraits rather than after.
  const collide = cleanTableTraits(repairTableTags([
    { tag: 'hairclip', sources: ['deepghs', 'noob'] },
    { tag: 'hairpin', sources: ['noob'] },
  ], store)).map((t) => t.tag);
  ok(collide.join(',') === 'hairclip', 'a rename onto a tag already there collapses to one', collide.join(', '));

  const noDb = repairTableTags([{ tag: 'bangs', sources: [] }], { loaded: false }).map((t) => t.tag);
  ok(noDb.join(',') === 'bangs', 'with no database loaded nothing is thrown away', noDb.join(', '));
}
{
  // A table on disk, shaped exactly as scripts/import-character-traits.mjs
  // writes one: Gran as the two lists have him, and a character with one tag.
  const t = new DatabaseSync(path.join(dir, 'table.sqlite'));
  t.exec('CREATE TABLE characters (tag TEXT PRIMARY KEY, traits TEXT NOT NULL, posts INTEGER, solo INTEGER, gender TEXT)');
  const put = t.prepare('INSERT INTO characters VALUES (?, ?, ?, ?, ?)');
  put.run('gran_(granblue_fantasy)', JSON.stringify([
    { tag: 'brown_hair', sources: ['deepghs', 'noob'] }, { tag: 'brown_eyes', sources: ['deepghs', 'noob'] },
    { tag: 'short_hair', sources: ['deepghs', 'noob'] }, { tag: 'bangs', sources: ['deepghs'] },
    { tag: '1boy', sources: ['noob'] },
  ]), 2548, 237, 'boy');
  put.run('tiny_(series)', JSON.stringify([{ tag: 'red_hair', sources: ['noob'] }]), 3, 1, 'girl');
  // Power as the two lists have her: both name red eyes, and the medium hair
  // and blonde hair are there to be merged against a live sample.
  put.run('power_(chainsaw_man)', JSON.stringify([
    { tag: 'red_eyes', sources: ['deepghs', 'noob'] }, { tag: 'blonde_hair', sources: ['deepghs', 'noob'] },
    { tag: 'medium_hair', sources: ['noob'] }, { tag: 'horns', sources: ['deepghs', 'noob'] },
  ]), 4688, 2029, 'girl');
  t.close();

  // Gran: the fixture has no single-character posts, so the live sample is
  // mixed — the case that gave him `erune`. The table stands in.
  const store = createTraitStore(dir, { traits: { db_path: 'h.sqlite', table_path: 'table.sqlite' } }, {
    fetchImpl: async () => fixture(),
  });
  const gran = await store.lookup('gran_(granblue_fantasy)', tagStore);
  ok(gran.source === 'table', 'a mixed live sample defers to the table', gran.source);
  ok(gran.live_reason === 'mixed sample', '...and says why', String(gran.live_reason));
  const got = gran.traits.map((x) => x.tag);
  ok(got.includes('brown_hair') && got.includes('short_hair') && !got.includes('1boy'),
    "the table's cleaned traits come back", got.join(', '));
  const thin = await store.lookup('tiny_(series)', tagStore);
  ok(thin.source !== 'table', 'too few table traits leaves the live lookup to answer');
  store.close();

  // Power: a clean live sample of her alone. Where it and the table disagree
  // on a look, it wins; what it missed, the table adds.
  const solo = Array.from({ length: 30 }, () => ({
    tag_string_character: 'power_(chainsaw_man)',
    tag_string_general: 'yellow_eyes cross-shaped_pupils red_horns long_hair',
  }));
  const merged = createTraitStore(dir, { traits: { db_path: 'm.sqlite', table_path: 'table.sqlite' } }, {
    fetchImpl: async () => ({ ok: true, json: async () => solo }),
  });
  const power = await merged.lookup('power_(chainsaw_man)', {
    postCount: (x) => ({ yellow_eyes: 690000, 'cross-shaped_pupils': 40000, red_horns: 60000, long_hair: 4300000 }[x] ?? 0),
  });
  const p = power.traits.map((x) => x.tag);
  ok(power.source === 'live+table', 'a clean live sample is merged with the table', power.source);
  ok(p.includes('yellow_eyes') && !p.includes('red_eyes'), "live's eye colour beats the table's", p.join(', '));
  ok(p.includes('long_hair') && !p.includes('medium_hair'), "live's hair length beats the table's", p.join(', '));
  ok(p.includes('cross-shaped_pupils'), "live's distinctive traits survive", p.join(', '));
  ok(p.includes('blonde_hair') && p.includes('horns'), 'and the table fills in what live missed', p.join(', '));
  merged.close();

  // A table row that describes a co-star too. Ainz's live sample is his
  // alone and right; his row is mostly Albedo. Listed, her look comes out of
  // the row — including what only her own row carries — and his stays.
  const tc = new DatabaseSync(path.join(dir, 'table-tc.sqlite'));
  tc.exec('CREATE TABLE characters (tag TEXT PRIMARY KEY, traits TEXT NOT NULL, posts INTEGER, solo INTEGER, gender TEXT)');
  const putTc = tc.prepare('INSERT INTO characters VALUES (?, ?, ?, ?, ?)');
  putTc.run('ainz_(x)', JSON.stringify([
    { tag: 'demon_girl', sources: ['noob'] }, { tag: 'large_breasts', sources: ['noob'] },
    { tag: 'black_wings', sources: ['noob'] }, { tag: 'skeleton', sources: ['noob'] },
    { tag: 'red_eyes', sources: ['noob'] }, { tag: 'hood', sources: ['noob'] },
  ]), 310, 64, 'girl');
  putTc.run('albedo_(x)', JSON.stringify([
    { tag: 'demon_girl', sources: ['noob'] }, { tag: 'large_breasts', sources: ['noob'] },
    { tag: 'black_wings', sources: ['noob'] }, { tag: 'yellow_eyes', sources: ['noob'] },
  ]), 1500, 900, 'girl');
  tc.close();
  const alone = (who, general) => Array.from({ length: 30 }, () => ({ tag_string_character: who, tag_string_general: general }));
  const tcFetch = async (u) => ({ ok: true, json: async () => (decodeURIComponent(u).includes('albedo_(x)')
    ? alone('albedo_(x)', 'demon_girl black_wings yellow_eyes')
    : alone('ainz_(x)', 'skeleton skull robe')) });
  const tcCounts = { postCount: (x) => ({ skeleton: 20000, skull: 30000, robe: 40000, demon_girl: 30000, black_wings: 20000, yellow_eyes: 690000 }[x] ?? 0) };
  const tcNames = async (extra) => {
    const s = createTraitStore(dir, { traits: { db_path: `tc-${extra ? 'on' : 'off'}.sqlite`, table_path: 'table-tc.sqlite', related_query: false, ...extra } }, { fetchImpl: tcFetch });
    const r = await s.lookup('ainz_(x)', tcCounts);
    s.close();
    return r.traits.map((x) => x.tag);
  };
  const tcOff = await tcNames(null);
  ok(tcOff.includes('demon_girl') && tcOff.includes('large_breasts'),
    "unlisted, a co-star's look in the table row rides in under a clean live sample", tcOff.join(', '));
  const tcOn = await tcNames({ table_contaminants: { 'ainz_(x)': ['albedo_(x)'] } });
  ok(!tcOn.includes('demon_girl') && !tcOn.includes('black_wings'),
    "listed, the co-star's live traits come out of the table row", tcOn.join(', '));
  ok(!tcOn.includes('large_breasts'), "...and so does what only the co-star's own table row carries", tcOn.join(', '));
  ok(tcOn.includes('skeleton') && tcOn.includes('red_eyes') && tcOn.includes('hood'),
    "...and the character's own look stays", tcOn.join(', '));

  // Danbooru unreachable: the table alone, rather than nothing.
  const offline = createTraitStore(dir, { traits: { db_path: 'n.sqlite', table_path: 'table.sqlite' } }, {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  const off1 = await offline.lookup('gran_(granblue_fantasy)', tagStore);
  ok(off1.source === 'table' && /could not reach/.test(off1.live_reason ?? ''),
    'offline, the table answers alone and says why', `${off1.source}: ${off1.live_reason}`);

  // A tag the lists carry and danbooru no longer has. `bangs` reached 53 of 96
  // characters this way on 15 Sep 2026. With a real tag database loaded it is
  // dropped; the rest of Gran survives it.
  const liveDb = {
    loaded: true,
    postCount: (x) => ({ brown_hair: 2_080_000, brown_eyes: 1_100_000, short_hair: 3_150_000 }[x] ?? 0),
  };
  const off2 = await offline.lookup('gran_(granblue_fantasy)', liveDb);
  const g2 = off2.traits.map((x) => x.tag);
  ok(!g2.includes('bangs') && g2.includes('brown_hair') && g2.includes('short_hair'),
    'a table tag the tag database does not hold is dropped', g2.join(', '));

  // A character danbooru has since renamed. The table is keyed by the old
  // name, the app can only ask by the new one, and the alias column joins
  // them — the case that hid Gojo, Itadori, Ahri and Jinx from the table.
  const renamedDb = {
    ...liveDb,
    aliasesOf: (x) => (x === 'gran_(granblue)' ? ['gran_(granblue_fantasy)'] : []),
  };
  const off3 = await offline.lookup('gran_(granblue)', renamedDb);
  ok(off3.source === 'table', 'a renamed character still finds its table row', String(off3.source));
  ok(off3.character === 'gran_(granblue)', '...and answers under the name asked for', String(off3.character));
  ok(off3.traits.map((x) => x.tag).includes('brown_hair'),
    '...with the row the old key holds', off3.traits.map((x) => x.tag).join(', '));

  const unknownName = await offline.lookup('nobody_(nowhere)', renamedDb);
  ok(unknownName.source !== 'table', 'a name with no row and no alias still finds nothing');
  offline.close();
}

console.log('\nthe character who is never drawn alone\n');
{
  const post = (chars, general) => ({ tag_string_character: chars, tag_string_general: general });
  ok(companionsIn('oz', Array.from({ length: 10 }, () => post('oz fischl', 'crow'))).join(',') === 'fischl',
    'one character in the whole sample is the companion');
  ok(companionsIn('oz', [
    ...Array.from({ length: 4 }, () => post('oz fischl', 'crow')),
    ...Array.from({ length: 6 }, () => post('oz mona', 'crow')),
  ]).join(',') === 'mona,fischl', 'both are returned, the one in most of it first');
  // bob-omb: Mario 33%, Peach 29%, Goomba 23%. No leader, all three wrong.
  ok(companionsIn('bob-omb', [
    ...Array.from({ length: 33 }, () => post('bob-omb mario', 'bomb')),
    ...Array.from({ length: 29 }, () => post('bob-omb princess_peach', 'bomb')),
    ...Array.from({ length: 23 }, () => post('bob-omb goomba', 'bomb')),
    ...Array.from({ length: 15 }, () => post('bob-omb', 'bomb')),
  ]).sort().join(',') === 'goomba,mario,princess_peach',
    'a crowd is subtracted whole — no one of them leads');
  // Ash Ketchum: never alone, but the company is six different faces and none
  // of them clears the floor. He is also never mixed, so he never gets here.
  ok(companionsIn('ash', [
    post('ash misty', 'x'), post('ash brock', 'x'), post('ash pikachu', 'x'),
    post('ash gary', 'x'), post('ash dawn', 'x'), post('ash serena', 'x'),
  ]).length === 0, 'a scattered crowd has no companion — this is why Ash is safe');
  ok(companionsIn('oz', []).length === 0, 'an empty sample has no companion');
  ok(companionsIn('oz', [post('oz', 'crow')]).length === 0, 'a character is never their own companion');
  // A costume is tagged next to its base character. Subtracting the base from
  // the skin deletes the face the skin is of — it fired on 17 Genshin variants
  // before this guard, Ganyu's bank collab and Zhongli's lantern rite included.
  ok(companionsIn('ganyu_(china_merchants_bank)',
    Array.from({ length: 10 }, () => post('ganyu_(china_merchants_bank) ganyu_(genshin_impact)', 'blue_hair'))
  ).length === 0, 'a costume never subtracts its own base character');
  ok(companionsIn('xiao_(bird)', Array.from({ length: 10 }, () => post('xiao_(bird) xiao_(genshin_impact)', 'bird')))
    .length === 0, '...however different the parenthesis');
  // But a genuinely different character who merely shares a word is still one.
  ok(companionsIn("scaramouche's_sickly_friend",
    Array.from({ length: 10 }, () => post("scaramouche's_sickly_friend scaramouche_(genshin_impact)", 'x'))
  ).join(',') === 'scaramouche_(genshin_impact)', 'a different character sharing a name is still a companion');
  ok(companionsIn('x', Array.from({ length: 10 }, (_, i) => post(`x c${i} d${i} e${i} f${i} g${i}`, 'y'))).length === 0,
    'ten different co-stars is a crowd, not a companion');
}
{
  // Oz as danbooru actually has him: always with Fischl, so the solo filter
  // finds nothing and the sample describes her. Fischl herself samples clean.
  const FISCHL = 'blonde_hair green_eyes two_side_up eyepatch hair_over_one_eye detached_sleeves';
  const fetchByTag = async (url) => {
    const solo = /chartags%3A1/.test(url);
    const who = /query=|tags=/.test(url) ? decodeURIComponent(url).match(/(?:query|tags)=([^ &]+)/)?.[1] : '';
    if (who === 'fischl') {
      return { ok: true, json: async () => Array.from({ length: 30 }, () => ({
        tag_string_character: 'fischl', tag_string_general: FISCHL,
      })) };
    }
    // Oz alone: nothing. Oz at all: 30 posts of him on Fischl's shoulder.
    if (solo) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => Array.from({ length: 30 }, () => ({
      tag_string_character: 'oz fischl', tag_string_general: `${FISCHL} crow bird feathers talons`,
    })) };
  };
  const counts = {
    blonde_hair: 1_400_000, green_eyes: 900_000, two_side_up: 90_000, eyepatch: 70_000,
    hair_over_one_eye: 300_000, detached_sleeves: 400_000, crow: 9_000, bird: 90_000,
    feathers: 120_000, talons: 6_000,
  };
  const db2 = { loaded: true, postCount: (t) => counts[t] ?? 0 };

  const dir2 = mkdtempSync(path.join(tmpdir(), 'pf-companion-'));
  const store = createTraitStore(dir2, {
    // `companion` is off by default — see DEFAULTS in traits.mjs for the
    // measurement that turned it off. These two blocks test it on, so the
    // mechanism stays covered whichever way the switch ends up.
    traits: { db_path: 'c.sqlite', related_query: false, companion: true },
  }, { fetchImpl: fetchByTag });

  const oz = await store.liveLookup('oz', db2);
  const got = oz.traits.map((t) => t.tag);
  ok(oz.companion === 'fischl', 'the companion is named', String(oz.companion));
  ok(got.includes('crow') && got.includes('bird'), "what is actually his survives", got.join(', '));
  ok(!got.includes('blonde_hair') && !got.includes('eyepatch') && !got.includes('two_side_up'),
    "his companion's traits are gone", got.join(', '));
  ok(oz.mixed, 'and the sample still says it was mixed');

  // The cache has to remember whose traits were taken out, or the second
  // lookup filters the table by nothing and hands them straight back.
  const again = await store.liveLookup('oz', db2);
  ok(again.cached && again.companion === 'fischl', 'the companion survives the cache', String(again.companion));
  store.close();

  // `wanderer` and `scaramouche` are one character tagged twice. Nothing in
  // the sample can show that — see the `companion` note in traits.mjs for the
  // three discriminators that failed — so it is declared, and the declaration
  // is matched on the name part, which is what makes it cover the costumes.
  const twice = createTraitStore(dir2, {
    traits: {
      db_path: 'd.sqlite', related_query: false, companion: true,
      same_person: [['wanderer_(genshin_impact)', 'scaramouche_(genshin_impact)']],
    },
  }, {
    fetchImpl: async (url) => {
      const who = decodeURIComponent(url).match(/tags=([^ &]+)/)?.[1] ?? '';
      if (who === 'scaramouche') {
        return { ok: true, json: async () => Array.from({ length: 30 }, () => ({
          tag_string_character: 'scaramouche', tag_string_general: FISCHL,
        })) };
      }
      if (/chartags%3A1/.test(url)) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => Array.from({ length: 30 }, () => ({
        tag_string_character: 'wanderer scaramouche', tag_string_general: FISCHL,
      })) };
    },
  });
  const w = await twice.liveLookup('wanderer', db2);
  ok(w.companion === null, 'a character tagged twice is not their own companion', String(w.companion));
  ok(w.traits.length > 0, '...and keeps the traits rather than being emptied', w.traits.map((t) => t.tag).join(', '));
  twice.close();

  // A group covers every costume of both names, not just the two listed.
  const post = (chars, general) => ({ tag_string_character: chars, tag_string_general: general });
  const groups = buildIdentityGroups([['wanderer_(genshin_impact)', 'scaramouche_(genshin_impact)']]);
  ok(companionsIn('wanderer_(mega_mgc_coffee)_(genshin_impact)',
    Array.from({ length: 10 }, () => post('wanderer_(mega_mgc_coffee)_(genshin_impact) scaramouche_(genshin_impact)', 'x')),
    0.5, groups).length === 0, 'a declared identity covers the costumes of both names');
  ok(companionsIn('wanderer_(genshin_impact)',
    Array.from({ length: 10 }, () => post('wanderer_(genshin_impact) nahida_(genshin_impact)', 'x')),
    0.5, groups).join(',') === 'nahida_(genshin_impact)',
    '...and leaves a genuine companion alone');

  // Kancolle names every remodel regularly enough to be a rule rather than
  // 104 lines of list. A remodel is the same shipgirl in a better outfit.
  const kai = new Set(['kai', 'kai_ni', 'kai_san', 'ni']);
  const ships = (a, b) => Array.from({ length: 10 }, () => post(`${a} ${b}`, 'x'));
  ok(companionsIn('shigure_(kancolle)', ships('shigure_(kancolle)', 'shigure_kai_ni_(kancolle)'),
    0.5, null, kai).length === 0, 'a remodel is the same shipgirl');
  ok(companionsIn('musashi_kai_(kancolle)', ships('musashi_kai_(kancolle)', 'musashi_kai_ni_(kancolle)'),
    0.5, null, kai).length === 0, '...including one remodel against the next');
  // The whole reason the suffixes are a whitelist and not a prefix test.
  ok(companionsIn('kumano_(kancolle)', ships('kumano_(kancolle)', 'kumano_maru_(kancolle)'),
    0.5, null, kai).join(',') === 'kumano_maru_(kancolle)',
    'a ship whose name merely starts with another is still someone else');
  ok(companionsIn('shigure_(kancolle)', ships('shigure_(kancolle)', 'yuudachi_(kancolle)'),
    0.5, null, kai).join(',') === 'yuudachi_(kancolle)', '...and so is a different ship entirely');
  ok(companionsIn('shigure_(kancolle)', ships('shigure_(kancolle)', 'shigure_kai_ni_(kancolle)'),
    0.5, null, null).length === 1, 'with no suffixes configured the rule does nothing');

  // The same rule at the front of the name: Pokemon puts the form first, and
  // danbooru tags the species on every Mega post, so the species was being
  // subtracted from its own Mega evolution.
  const forms = new Set(['mega', 'primal', 'gigantamax']);
  ok(companionsIn('mega_lucario', ships('mega_lucario', 'lucario'), 0.5, null, null, forms).length === 0,
    'a Mega evolution is the same creature as its species');
  ok(companionsIn('primal_groudon', ships('primal_groudon', 'groudon'), 0.5, null, null, forms).length === 0,
    '...and so is a Primal form');
  // Regional variants are left out of the list on purpose: they look different
  // from the base, so subtracting it is right.
  ok(companionsIn('alolan_vulpix', ships('alolan_vulpix', 'vulpix'), 0.5, null, null, forms).join(',') === 'vulpix',
    'a regional variant is not covered, because it does not look like the base');
  ok(companionsIn('mega_lucario', ships('mega_lucario', 'lucario'), 0.5, null, null, null).length === 1,
    'with no prefixes configured the rule does nothing');

  // The selectable-gender player avatar. Fire Emblem deleted the neutral tag,
  // so the two gendered ones have to find each other rather than a base.
  const avatar = new Set(['female', 'male']);
  const fe = (a, b) => Array.from({ length: 10 }, () => post(`${a} ${b}`, 'x'));
  ok(companionsIn('female_byleth_(fire_emblem)', fe('female_byleth_(fire_emblem)', 'male_byleth_(fire_emblem)'),
    0.5, null, null, avatar).length === 0, 'female and male avatars are one character with no neutral tag between them');
  ok(companionsIn('female_admiral_(kancolle)', fe('female_admiral_(kancolle)', 'admiral_(kancolle)'),
    0.5, null, null, avatar).length === 0, '...and match the neutral tag where one exists');
  ok(companionsIn('female_byleth_(fire_emblem)', fe('female_byleth_(fire_emblem)', 'edelgard_von_hresvelg_(fire_emblem)'),
    0.5, null, null, avatar).join(',') === 'edelgard_von_hresvelg_(fire_emblem)',
    'an avatar standing next to somebody else still loses that somebody');

  // Stripping both names must not break what the long-against-short test did.
  const both = new Set(['kai', 'kai_ni', 'ni']);
  ok(companionsIn('musashi_kai_(kancolle)', ships('musashi_kai_(kancolle)', 'musashi_kai_ni_(kancolle)'),
    0.5, null, both, null).length === 0, 'kai against kai_ni sheds the longer marker, not just "ni"');
  ok(companionsIn('kumano_(kancolle)', ships('kumano_(kancolle)', 'kumano_maru_(kancolle)'),
    0.5, null, both, avatar).join(',') === 'kumano_maru_(kancolle)', 'kumano_maru is still a different ship');
  ok(companionsIn('ni', ships('ni', 'x_ni'), 0.5, null, both, null).length === 1,
    'a name that is nothing but a marker is not stripped to nothing');

  // The list's real home is config/same-person.yaml, so a store built over a
  // directory holding one must read it without being told.
  const fileDir = mkdtempSync(path.join(tmpdir(), 'pf-identity-'));
  mkdirSync(path.join(fileDir, 'config'), { recursive: true });
  writeFileSync(path.join(fileDir, 'config', 'same-person.yaml'),
    'same_person:\n  - ["wanderer_(x)", "scaramouche_(x)"]\nsame_person_suffixes: ["kai"]\n', 'utf8');
  const fromFile = createTraitStore(fileDir, {
    traits: { db_path: 'f.sqlite', related_query: false, companion: true },
  }, { fetchImpl: fetchByTag });
  const fileLive = await fromFile.liveLookup('wanderer_(x)', {
    loaded: true, postCount: () => 1000,
  });
  ok(fileLive.companion !== 'scaramouche_(x)',
    'a group in config/same-person.yaml is read without being passed in');
  fromFile.close();
  rmSync(fileDir, { recursive: true, force: true });

  // The switch still turns the whole thing off for anyone who wants it off.
  const off = createTraitStore(dir2, { traits: { db_path: 'e.sqlite', related_query: false, companion: false } }, {
    fetchImpl: fetchByTag,
  });
  const ozOff = await off.liveLookup('oz', db2);
  ok(ozOff.companion === null, 'traits.companion: false subtracts nothing', String(ozOff.companion));
  ok(ozOff.traits.map((t) => t.tag).includes('blonde_hair'),
    "...and Fischl's hair comes back on Oz, which is the defect it exists for",
    ozOff.traits.map((t) => t.tag).join(', '));
  off.close();
  rmSync(dir2, { recursive: true, force: true });
}

{
  const off = createTraitStore(dir, { traits: { db_path: 'i.sqlite', table_path: 'table.sqlite', table: false } }, {
    fetchImpl: async () => fixture(),
  });
  ok((await off.lookup('gran_(granblue_fantasy)', tagStore)).source !== 'table',
    'traits.table: false turns the table off');
  off.close();

  const missing = createTraitStore(dir, { traits: { db_path: 'j.sqlite', table_path: 'nope.sqlite' } }, {
    fetchImpl: async () => fixture(),
  });
  ok((await missing.lookup('makima_(chainsaw_man)', tagStore)).traits.length > 0,
    'a missing table degrades to the live lookup');
  missing.close();
}

console.log('\nthe live lookup — asking for her alone, and keeping the mixed flag\n');
{
  const urls = [];
  const store = createTraitStore(dir, { traits: { db_path: 'k.sqlite', table: false, related_query: false } }, {
    fetchImpl: async (u) => { urls.push(u); return fixture(); },
  });
  await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(/chartags%3A1/.test(urls[0] ?? ''), 'danbooru is asked for single-character posts', urls[0]);
  store.close();
}
{
  // Fewer solo posts than min_sample: a second request without chartags:1,
  // and the mixed flag survives the cache — which it did not before 15 Sep.
  const post = (chars, tags) => ({ tag_string_character: chars, tag_string_general: tags });
  const urls = [];
  const store = createTraitStore(dir, { traits: { db_path: 'l.sqlite', table: false, min_sample: 12, related_query: false } }, {
    fetchImpl: async (u) => {
      urls.push(u);
      const soloOnly = /chartags%3A1/.test(u);
      const feed = soloOnly
        ? Array.from({ length: 4 }, () => post('sidekick', 'green_hair'))
        : [
            ...Array.from({ length: 4 }, () => post('sidekick', 'green_hair')),
            ...Array.from({ length: 36 }, () => post('sidekick hero', 'green_hair cape')),
          ];
      return { ok: true, json: async () => feed };
    },
  });
  const first = await store.lookup('sidekick', { postCount: (t) => ({ green_hair: 200000, cape: 150000 }[t] ?? 0) });
  // Counting the first two rather than all of them: `hero` is in 36 of the 40
  // posts, so this fixture also trips companion subtraction, which asks after
  // him on its own. That is the next two requests and the assertions below.
  ok(/chartags/.test(urls[0]) && !/chartags/.test(urls[1]),
    'too few solo posts asks again for everything', urls.slice(0, 2).join(' , '));
  ok(first.mixed === true, '...and flags the result mixed');
  // `hero` is in 36 of the 40 posts, so he is the dominant companion — but he
  // is never alone in this fixture either, so his own traits are a guess too.
  // Subtracting a guess from a guess is refused, and nothing is taken out.
  ok(first.companion === null, 'a companion who is never alone either is refused', String(first.companion));
  const kept = first.traits.map((t) => t.tag);
  ok(kept.includes('green_hair') && kept.includes('cape'),
    '...and the mixed sample comes back whole, still flagged', kept.join(', '));
  const again = await store.lookup('sidekick', { postCount: () => 0 });
  ok(again.cached === true && again.mixed === true, 'the mixed flag survives the cache');
  store.close();
}

console.log('\ndanbooru related tags — its counts, the same rules\n');
{
  // Makima's measured shares, as related_tag.json would return them.
  const rel = {
    post_count: 40,
    related_tags: [
      { tag: { name: 'red_hair' }, frequency: 0.825 }, { tag: { name: 'ringed_eyes' }, frequency: 0.725 },
      { tag: { name: 'long_hair' }, frequency: 0.55 }, { tag: { name: '1girl' }, frequency: 0.99 },
      { tag: { name: 'solo' }, frequency: 0.9 }, { tag: { name: 'black_hair' }, frequency: 0.1 },
    ],
  };
  const urls = [];
  const store = createTraitStore(dir, { traits: { db_path: 'o.sqlite', table: false } }, {
    fetchImpl: async (u) => { urls.push(u); return { ok: true, json: async () => rel }; },
  });
  const r = await store.lookup('makima_(chainsaw_man)', tagStore);
  const got = r.traits.map((t) => t.tag);
  ok(urls.length === 1 && /related_tag\.json/.test(urls[0]) && /chartags%3A1/.test(urls[0]),
    'one related-tags request, for posts of her alone', urls.join(' | '));
  ok(/rating%3Ageneral/.test(urls[0]), '...with the same rating filter as sampling', urls[0]);
  ok(got.includes('red_hair') && got.includes('ringed_eyes') && got.includes('long_hair'),
    'its counts rank the way a sample does', got.join(', '));
  ok(!got.includes('1girl') && !got.includes('black_hair'), '...under the same rules', got.join(', '));
  ok(r.sampled === 40 && r.method === 'related', 'and it reports how many posts it covered', `${r.sampled} via ${r.method}`);
  const again = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(again.cached === true && urls.length === 1, 'the result is cached like any other');
  store.close();
}
{
  // Too few posts behind the counts: the post sampling answers instead.
  const urls = [];
  const store = createTraitStore(dir, { traits: { db_path: 'p.sqlite', table: false, min_sample: 12 } }, {
    fetchImpl: async (u) => {
      urls.push(u);
      return /related_tag/.test(u)
        ? { ok: true, json: async () => ({ post_count: 3, related_tags: [{ tag: { name: 'red_hair' }, frequency: 1 }] }) }
        : fixture();
    },
  });
  const r = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(/related_tag/.test(urls[0]) && urls.slice(1).some((u) => /posts\.json/.test(u)) && r.method === 'posts',
    'too few posts behind the counts falls back to sampling posts', `${urls.length} request(s), ${r.method}`);
  store.close();
}
{
  // danbooru answering the related-tags request with an error.
  const store = createTraitStore(dir, { traits: { db_path: 'q.sqlite', table: false } }, {
    fetchImpl: async (u) => (/related_tag/.test(u) ? { ok: false, status: 500, json: async () => ({}) } : fixture()),
  });
  const r = await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(r.method === 'posts' && r.traits.length > 0, 'a failed related-tags request falls back to sampling posts');
  store.close();
}
{
  const urls = [];
  const store = createTraitStore(dir, { traits: { db_path: 'r.sqlite', table: false, related_query: false } }, {
    fetchImpl: async (u) => { urls.push(u); return fixture(); },
  });
  await store.lookup('makima_(chainsaw_man)', tagStore);
  ok(!urls.some((u) => /related_tag/.test(u)), 'related_query: false never asks for related tags');
  store.close();
}

// ── a costume is never drawn alone ──
// 19 Sep 2026: every post of asuna_(bunny)_(blue_archive) also carries
// asuna_(blue_archive), so chartags:1 found 0 of 6,958 and she was ranked from
// the anniversary group pictures. Costume plus base with nobody else is her
// solo post.
{
  const BA = { postCount: (t) => ({ 'asuna_(blue_archive)': 18000, blonde_hair: 1_000_000, mole_on_breast: 20000, blue_leotard: 30000 }[t] ?? 0) };
  ok(costumeBase('asuna_(bunny)_(blue_archive)', BA) === 'asuna_(blue_archive)', 'costumeBase finds the base form');
  ok(costumeBase('asuna_(blue_archive)', BA) === null, '...a plain character has none');
  ok(costumeBase('kei_(student)_(blue_archive)', BA) === null, '...and a base that is not a tag is not invented');

  const asked = [];
  const rel = createTraitStore(dir, { traits: { db_path: 'costume-rel.sqlite', table: false } }, {
    fetchImpl: async (url) => {
      const q = decodeURIComponent(url);
      asked.push(q);
      if (/related_tag/.test(q) && q.includes('asuna_(blue_archive) chartags:2')) {
        return { ok: true, json: async () => ({ post_count: 5332, related_tags: [
          { tag: { name: 'mole_on_breast' }, frequency: 0.6 },
          { tag: { name: 'blue_leotard' }, frequency: 0.8 },
        ] }) };
      }
      if (/related_tag/.test(q)) return { ok: true, json: async () => ({ post_count: 0, related_tags: [] }) };
      return { ok: true, json: async () => [] };
    },
  });
  const r = await rel.lookup('asuna_(bunny)_(blue_archive)', BA);
  ok(r.method === 'related' && !r.mixed, 'a costume is ranked from costume-plus-base posts', `${r.method} mixed=${r.mixed}`);
  ok(r.traits.some((t) => t.tag === 'mole_on_breast'), '...and gets her traits', r.traits.map((t) => t.tag).join(', '));
  ok(asked.some((q) => /chartags:1/.test(q)), '...after the solo query was tried first');
  rel.close();

  const pair = (n) => Array.from({ length: n }, () => ({
    tag_string_character: 'asuna_(bunny)_(blue_archive) asuna_(blue_archive)',
    tag_string_general: 'blonde_hair mole_on_breast blue_leotard',
  }));
  const posts = createTraitStore(dir, { traits: { db_path: 'costume-posts.sqlite', table: false, related_query: false } }, {
    fetchImpl: async (url) => {
      const q = decodeURIComponent(url);
      if (/chartags:1/.test(q)) return { ok: true, json: async () => [] };
      if (/chartags:2/.test(q)) return { ok: true, json: async () => pair(30) };
      return { ok: true, json: async () => [] };
    },
  });
  const p = await posts.lookup('asuna_(bunny)_(blue_archive)', BA);
  ok(p.mixed === false && p.sampled === 30, 'sampling posts, the base form is not a second character', `mixed=${p.mixed} sampled=${p.sampled}`);
  posts.close();
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? `ALL PASSED (${passes})` : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
