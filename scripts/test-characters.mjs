// Character resolution from a brief — server/character.mjs.
//
// The suite this file exists to satisfy is the one in traits.mjs's header:
// auto-resolving a bare name was measured and rejected because `miku` reached
// mikuma_(kancolle) and `rem` reached remilia_scarlet. Those two cases are the
// point of this file. Everything else is guarding the guard.
//
// No network and no real database: the tag store is a stub, so this runs in
// the `npm run check` set.

import {
  resolveCharacters,
  characterBlock,
  namePart,
  franchisePart,
  franchiseMentioned,
  collapseVariants,
  isCommonWord,
  isDescriptiveWord,
  isAppearanceModifier,
  dominantCandidate,
  isFranchiseReference,
  ngrams,
  writtenAsName,
  needsCapital,
  namesAnothersSeries,
  findCustomCharacters,
  customCharacterBlock,
} from '../server/character.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// A stand-in for server/tags.mjs. `search` is a PREFIX search there, so it is
// a prefix search here — using contains would make this suite pass while the
// real thing behaved differently, which is the whole failure being guarded.
// Post counts are the REAL ones where a real tag is involved, so the noun test
// is exercised against the same numbers it will see in production.
const ROWS = [
  // category 4 — characters
  { tag: 'makima_(chainsaw_man)', category: 4, post_count: 7302 },
  { tag: 'power_(chainsaw_man)', category: 4, post_count: 4826 },
  { tag: 'fern_(sousou_no_frieren)', category: 4, post_count: 5355 },
  { tag: 'mualani_(genshin_impact)', category: 4, post_count: 1000 },
  { tag: 'zhongli_(genshin_impact)', category: 4, post_count: 9022 },
  // Costume variants of one man — the shape that made Genshin characters
  // permanently ambiguous before collapseVariants existed.
  { tag: 'zhongli_(archon)_(genshin_impact)', category: 4, post_count: 300 },
  { tag: 'zhongli_(lantern_rite)_(genshin_impact)', category: 4, post_count: 120 },
  { tag: 'hatsune_miku', category: 4, post_count: 106043 },
  { tag: 'mikuma_(kancolle)', category: 4, post_count: 900 },
  { tag: 'miku_(darling_in_the_franxx)', category: 4, post_count: 700 },
  { tag: 'miku_(lee)', category: 4, post_count: 600 },
  // Two different Rems, which is why the real database abstains here.
  { tag: 'rem_(re:zero)', category: 4, post_count: 12000 },
  { tag: 'rem_(death_note)', category: 4, post_count: 800 },
  { tag: 'remilia_scarlet', category: 4, post_count: 30000 },
  { tag: 'joseph_joestar', category: 4, post_count: 7678 },
  // The 5 Sep 2026 report, at its real post counts. Note what is NOT here and
  // is not in danbooru either: any general tag containing "platinum". The
  // colour is spelled blonde_hair, so the word leaves no trace for
  // isDescriptiveWord to weigh and the 500 solo floor passes 1,188.
  { tag: 'platinum_(arknights)', category: 4, post_count: 1188 },
  // Same series, and the reason the appearance guard sits outside the
  // series bypass: with Arknights named, every database guard dropped for her
  // too and "red eyes" resolved a character.
  { tag: 'red_(npc)_(arknights)', category: 4, post_count: 900 },
  { tag: 'nagisa_(some_series)', category: 4, post_count: 40 },   // under the floor
  { tag: 'nagisa_(other_series)', category: 4, post_count: 3000 },
  { tag: 'nagisa_(third_series)', category: 4, post_count: 2500 },
  // Characters whose names are ordinary nouns.
  { tag: 'tea_(cafe-chan_to_break_time)', category: 4, post_count: 128 },
  { tag: 'rope_(arknights)', category: 4, post_count: 258 },
  { tag: 'mechanic_(ragnarok_online)', category: 4, post_count: 197 },
  // A word that is no tag at all, only a word inside enormous ones.
  { tag: 'long_(chainsaw_man)', category: 4, post_count: 85 },
  // Age variants of one man, hung off a bare tag rather than a franchise.
  { tag: 'joseph_joestar_(young)', category: 4, post_count: 6454 },
  { tag: 'joseph_joestar_(old)', category: 4, post_count: 1400 },
  // Ordinary words that are somebody's name in a series nobody here works in.
  { tag: 'misty_(pokemon)', category: 4, post_count: 3784 },
  // ...and one whose series contains her own name, which used to prove itself.
  { tag: 'knight_(hollow_knight)', category: 4, post_count: 334 },
  // ...and ones whose series IS her name, at real counts. "eating ice cream"
  // resolved Cream on 18 Sep 2026 because the word named her series.
  { tag: 'cream_(cream)', category: 4, post_count: 114 },
  { tag: 'cream_(stand)', category: 4, post_count: 66 },
  { tag: 'ib_(ib)', category: 4, post_count: 1345 },
  // "young Powder, arcane" resolved an Arknights operator called Arcane,
  // 19 Sep 2026. Real counts.
  { tag: 'powder_(arcane)', category: 4, post_count: 172 },
  { tag: 'arcane_(arknights)', category: 4, post_count: 506 },
  { tag: 'frieren', category: 4, post_count: 16194 },
  // Blue Archive files students by given name and keeps the full name as an
  // alias; Noa's surname is a Kancolle girl's whole name.
  { tag: 'rio_(blue_archive)', category: 4, post_count: 14783, aliases: 'tsukatsuki_rio' },
  { tag: 'noa_(blue_archive)', category: 4, post_count: 8464, aliases: 'ushio_noa' },
  { tag: 'ushio_(kancolle)', category: 4, post_count: 3900 },
  { tag: 'rio_(pokemon)', category: 4, post_count: 60 },
  // Name parts that start with an article, at real counts (11 Oct 2026):
  // "a knight girl resting" and "the girl sits on a bench" resolved the first
  // two, because the two-word gram skipped every one-word guard.
  { tag: 'a_knight_(reverse:1999)', category: 4, post_count: 119 },
  { tag: 'the_girl_(fear_&_hunger)', category: 4, post_count: 137 },
  { tag: 'the_herta_(honkai:_star_rail)', category: 4, post_count: 3539 },
  { tag: "the_dark_urge_(baldur's_gate)", category: 4, post_count: 251 },
  // A name of ordinary words, and one met only in a shouted line (11 Oct
  // 2026), at real counts.
  { tag: 'red_fox_(kemono_friends)', category: 4, post_count: 158 },
  { tag: 'encore_(wuthering_waves)', category: 4, post_count: 509 },

  // category 0 — general tags, the counts that decide noun vs name
  { tag: 'tea', category: 0, post_count: 12292 },
  { tag: 'rope', category: 0, post_count: 51332 },
  { tag: 'mechanic', category: 0, post_count: 826 },
  { tag: 'fern', category: 0, post_count: 1038 },   // loses to Fern, 5355
  { tag: 'maid', category: 0, post_count: 146593 },
  { tag: 'long_hair', category: 0, post_count: 4323141 },  // no tag `long` exists
  { tag: 'power_lines', category: 0, post_count: 9969 },   // and Power survives it
  { tag: 'cream', category: 0, post_count: 6370 },
  { tag: 'ice_cream', category: 0, post_count: 35199 },
  { tag: 'powder', category: 0, post_count: 84 },
  { tag: 'knight', category: 0, post_count: 11470 },
  // The top general tag holding each word, at the real count.
  { tag: 'red_eyes', category: 0, post_count: 1773608 },
  { tag: 'fox_ears', category: 0, post_count: 217547 },
  // The top general tag with the word "girl" in it, at the real count.
  { tag: 'girl_on_top', category: 0, post_count: 228487 },

  // category 3 — copyright
  { tag: 'nier', category: 3, post_count: 1344 },
  { tag: 'chainsaw_man', category: 3, post_count: 30000 },
];

const tagStore = {
  // Prefix search, like the real one — using contains here would let the
  // suite pass while production behaved differently.
  search(query, { category = null, limit = 20 } = {}) {
    const q = String(query).toLowerCase();
    const results = ROWS.filter((r) => r.tag.startsWith(q))
      .filter((r) => category == null || r.category === category)
      .sort((a, b) => b.post_count - a.post_count)
      .slice(0, limit);
    return { results };
  },
  // The name-part index the resolver actually reads. Same answer the real
  // store's map gives: every live character row whose name part is exactly
  // this word, and nothing else.
  charactersNamed(name) {
    const q = String(name).toLowerCase().replace(/\s+/g, '_');
    return ROWS.filter((r) => r.category === 4 && namePart(r.tag) === q).map((r) => ({
      tag: r.tag,
      post_count: r.post_count,
    }));
  },
  // The general-tag word index. Real store builds a map; here the same
  // answer falls out of the rows, minus any parenthetical general tag.
  generalTokenTop(word) {
    const w = String(word).toLowerCase();
    let top = 0;
    for (const r of ROWS) {
      if (r.category !== 0 || r.tag.includes('(')) continue;
      if (r.tag.split('_').includes(w) && r.post_count > top) top = r.post_count;
    }
    return top;
  },
  // The alias column, as the real store's aliasTarget reads it.
  aliasTarget(tag) {
    const q = String(tag).toLowerCase().replace(/\s+/g, '_');
    return ROWS.find((r) => String(r.aliases ?? '').split(',').includes(q))?.tag ?? null;
  },
  exactRows(tag) {
    const q = String(tag).toLowerCase().replace(/\s+/g, '_');
    return ROWS.filter((r) => r.tag === q);
  },
};

const resolve = (brief) => resolveCharacters(brief, tagStore);
const tagsOf = (r) => r.resolved.map((x) => x.tag);

console.log('\nCharacter resolution\n');

// ── the two measured failures that rejected auto-resolve ───────────────────

const miku = resolve('miku singing on a neon stage');
check(
  'miku resolves to nobody rather than to mikuma_(kancolle)',
  !tagsOf(miku).includes('mikuma_(kancolle)'),
  tagsOf(miku).join(', ')
);
check(
  'miku resolves nothing at all, since no name part equals "miku"',
  miku.resolved.length === 0,
  tagsOf(miku).join(', ')
);

const rem = resolve('Rem in a maid outfit');
check(
  'rem does NOT resolve to remilia_scarlet',
  !tagsOf(rem).includes('remilia_scarlet'),
  tagsOf(rem).join(', ')
);
// Rem used to abstain here, because danbooru has a second Rem in Death Note.
// She resolves as of 27 Aug 2026, and this is the file's own header being
// applied rather than contradicted: it says outright that "Rem from Re:Zero is
// who anyone typing 'rem' means". 9,042 posts against 88 in the real database
// is not an ambiguity, it is one answer and a namesake.
check(
  'rem resolves to Re:Zero, who dwarfs the other Rem',
  tagsOf(rem).includes('rem_(re:zero)'),
  tagsOf(rem).join(', ')
);
check(
  '...and says why, so the log line does not read like a unique name',
  rem.resolved.find((r) => r.name === 'rem')?.via === 'far the best known of that name',
  JSON.stringify(rem.resolved)
);

// ── the cases this feature exists for ──────────────────────────────────────

check(
  'a unique name resolves',
  tagsOf(resolve('Mualani surfing in Natlan')).includes('mualani_(genshin_impact)')
);
check(
  'the owner\'s own brief shape resolves',
  tagsOf(resolve('mualani riding a surfboard, big wave, sunny')).includes(
    'mualani_(genshin_impact)'
  )
);
check(
  'a two-word name resolves',
  tagsOf(resolve('Joseph Joestar posing on a rooftop')).includes('joseph_joestar')
);
check(
  'the dialect suite\'s zhongli brief resolves',
  tagsOf(resolve('Zhongli from Genshin Impact sitting alone in a teahouse at midday')).includes(
    'zhongli_(genshin_impact)'
  )
);
check(
  'the dialect suite\'s makima brief resolves',
  tagsOf(resolve('Makima from Chainsaw Man on a rain-slick Tokyo rooftop at night')).includes(
    'makima_(chainsaw_man)'
  )
);

// ── ambiguity is an abstention, not a guess ────────────────────────────────

const nagisa = resolve('nagisa on a beach');
check('an ambiguous name resolves nothing', nagisa.resolved.length === 0, tagsOf(nagisa).join(', '));
check('an ambiguous name is reported as ambiguous', nagisa.ambiguous.some((a) => a.name === 'nagisa'));
check(
  'the under-floor candidate is excluded from the ambiguity list',
  !nagisa.ambiguous[0]?.candidates.includes('nagisa_(some_series)'),
  JSON.stringify(nagisa.ambiguous[0]?.candidates)
);
check(
  'naming the franchise resolves the ambiguity',
  tagsOf(resolve('nagisa from other series at the beach')).includes('nagisa_(other_series)')
);

// ── things that must not fire ──────────────────────────────────────────────

// ── ordinary nouns that happen to be somebody's name ───────────────────────
// Every one of these resolved a stranger's canon on the first real-data run.

check('"a cup of tea" does not resolve a character',
  resolve('a cup of tea on a low table').resolved.length === 0,
  tagsOf(resolve('a cup of tea on a low table')).join(', '));
check('"hauling rope" does not resolve a character',
  resolve('a keeper hauling rope in the wind').resolved.length === 0,
  tagsOf(resolve('a keeper hauling rope in the wind')).join(', '));
check('"a mechanic" does not resolve a character',
  resolve('a mechanic fixing a motorcycle').resolved.length === 0,
  tagsOf(resolve('a mechanic fixing a motorcycle')).join(', '));
check('but Fern still resolves, whose name loses to no noun',
  tagsOf(resolve('Fern in a workshop')).includes('fern_(sousou_no_frieren)'),
  tagsOf(resolve('Fern in a workshop')).join(', '));
check('and Power resolves, having no general tag at all',
  tagsOf(resolve('power from chainsaw man grinning')).includes('power_(chainsaw_man)'),
  tagsOf(resolve('power from chainsaw man grinning')).join(', '));

check('isCommonWord is a comparison, not an existence check',
  isCommonWord('fern', tagStore, 5355) === false && isCommonWord('fern', tagStore, 100) === true);
check('a tie counts as a noun', isCommonWord('mechanic', tagStore, 826) === true);

// ── costume variants are one person ────────────────────────────────────────

check('zhongli resolves despite three outfit tags',
  tagsOf(resolve('zhongli pouring tea')).includes('zhongli_(genshin_impact)'),
  tagsOf(resolve('zhongli pouring tea')).join(', '));
check('collapseVariants keeps the plainest form',
  collapseVariants([
    { tag: 'zhongli_(archon)_(genshin_impact)', post_count: 300 },
    { tag: 'zhongli_(genshin_impact)', post_count: 9022 },
  ])[0].tag === 'zhongli_(genshin_impact)');
check('collapseVariants keeps genuinely different franchises apart',
  collapseVariants([
    { tag: 'rem_(re:zero)', post_count: 12000 },
    { tag: 'rem_(death_note)', post_count: 800 },
  ]).length === 2);

// ── "from X" names a series, not a second subject ──────────────────────────

check('a copyright tag is recognised as a franchise',
  isFranchiseReference('nier', '2b from nier walking', tagStore));
check('a word after "from" is treated as a franchise',
  isFranchiseReference('frieren', 'fern from frieren in a workshop', tagStore));
check('the same word elsewhere is not',
  !isFranchiseReference('frieren', 'frieren casting a spell', tagStore));

check('an empty brief resolves nothing', resolve('').resolved.length === 0);
check('a brief with no character resolves nothing',
  resolve('a lighthouse in a storm, huge waves').resolved.length === 0);
check(
  'a common word does not reach a character whose name merely contains it',
  resolve('a cup of tea on a low table').resolved.length === 0,
  tagsOf(resolve('a cup of tea on a low table')).join(', ')
);
check('a missing tag store degrades to nothing', resolveCharacters('mualani', null).resolved.length === 0);
check(
  'a longer name wins and the short form does not resolve twice',
  resolve('Joseph Joestar').resolved.length === 1
);

// ── a word that is only a word inside other tags ──────────────────────────

check('"a long dusty road" does not resolve long_(chainsaw_man)',
  resolve('a lone traveller walking a long dusty road at noon').resolved.length === 0,
  tagsOf(resolve('a lone traveller walking a long dusty road at noon')).join(', '));
check('isDescriptiveWord catches an adjective danbooru has no tag for',
  isDescriptiveWord('long', tagStore, 85) === true);
check('...and leaves Power alone, whose ratio is 2.1x rather than 3x',
  isDescriptiveWord('power', tagStore, 4826) === false);
check('...and never fires on a multi-word name',
  isDescriptiveWord('joseph_joestar', tagStore, 7678) === false);

// ── a one-word name carries a higher floor ────────────────────────────────

check('a one-word name under the solo floor resolves nothing',
  resolveCharacters('rope hauled tight', tagStore, { minSoloPostCount: 500 }).resolved.length === 0);
check('...and the floor is a veto, not a filter: nothing is reported ambiguous either',
  resolveCharacters('rope hauled tight', tagStore, { minSoloPostCount: 500 }).ambiguous.length === 0);
check('a two-word name is not held to it',
  tagsOf(resolveCharacters('joseph joestar posing', tagStore, { minSoloPostCount: 500 })).includes('joseph_joestar'));
check('Mualani clears the default floor at 1,000 posts',
  tagsOf(resolveCharacters('mualani surfing', tagStore, {})).includes('mualani_(genshin_impact)'));
check('...and a raised floor is what would cost her, which is the knob to turn',
  resolveCharacters('mualani surfing', tagStore, { minSoloPostCount: 2000 }).resolved.length === 0);

// ── age and costume variants hung off a bare tag ──────────────────────────

check('a bare tag claims its own qualified variants',
  collapseVariants([
    { tag: 'joseph_joestar_(young)', post_count: 6454 },
    { tag: 'joseph_joestar', post_count: 7678 },
    { tag: 'joseph_joestar_(old)', post_count: 1400 },
  ]).map((c) => c.tag).join(',') === 'joseph_joestar');
check('...which is what lets Joseph resolve at all now that every gram is tried',
  tagsOf(resolve('joseph joestar posing on a rooftop in new york at sunset')).includes('joseph_joestar'),
  tagsOf(resolve('joseph joestar posing on a rooftop in new york at sunset')).join(', '));
check('and two Rems are still two people',
  collapseVariants([
    { tag: 'rem_(re:zero)', post_count: 12000 },
    { tag: 'rem_(death_note)', post_count: 800 },
  ]).length === 2);

// ── the long tail: obscure characters are reachable ─────────────────

check('naming the series lifts a character under the solo floor',
  tagsOf(resolveCharacters('tea from cafe-chan to break time, holding a cup', tagStore, {}))
    .includes('tea_(cafe-chan_to_break_time)'),
  tagsOf(resolveCharacters('tea from cafe-chan to break time, holding a cup', tagStore, {})).join(', '));
check('...even though the same word alone is read as a noun',
  resolve('a cup of tea on a low table').resolved.length === 0);
check('naming the series also lifts a character whose name is a description',
  tagsOf(resolveCharacters('long from chainsaw man in a doorway', tagStore, {}))
    .includes('long_(chainsaw_man)'),
  tagsOf(resolveCharacters('long from chainsaw man in a doorway', tagStore, {})).join(', '));
check('...and a series nobody named leaves the floor in place',
  resolve('a long dusty road at noon').resolved.length === 0);

// ── one obvious answer is not an ambiguity ─────────────────────────

check('a candidate ten times the runner-up wins',
  dominantCandidate([
    { tag: 'rem_(re:zero)', post_count: 12000 },
    { tag: 'rem_(death_note)', post_count: 800 },
  ])?.tag === 'rem_(re:zero)');
check('a close second is still an abstention',
  dominantCandidate([
    { tag: 'nagisa_(other_series)', post_count: 3000 },
    { tag: 'nagisa_(third_series)', post_count: 2500 },
  ]) === null);
check('...which is why nagisa still resolves nobody',
  resolve('nagisa on a beach').resolved.length === 0,
  tagsOf(resolve('nagisa on a beach')).join(', '));
check('one candidate is never "dominant" — that path is the unique-name one',
  dominantCandidate([{ tag: 'mualani_(genshin_impact)', post_count: 1000 }]) === null);

// ── words that describe a scene, and happen to be a name ────────────

check('"the misty lake" does not resolve Misty, who is 3,784 posts',
  resolve('the misty lake at dawn, reeds and still water').resolved.length === 0,
  tagsOf(resolve('the misty lake at dawn, reeds and still water')).join(', '));
check('...but naming the series reaches her, which is why a word list is allowed',
  tagsOf(resolve('misty from pokemon on a bike')).includes('misty_(pokemon)'),
  tagsOf(resolve('misty from pokemon on a bike')).join(', '));
check('the list does not touch a character this group prompts',
  tagsOf(resolve('Fern in a workshop')).includes('fern_(sousou_no_frieren)'));

// ── a franchise token cannot be the character's own name ────────────

check('"a knight on a ridge" does not prove the series is Hollow Knight',
  !franchiseMentioned('knight_(hollow_knight)', 'a knight on a ridge at sunset'));
check('...and the whole series name still does',
  franchiseMentioned('knight_(hollow_knight)', 'the knight from hollow knight in a corridor'));
check('...so the brief that names it resolves him',
  tagsOf(resolve('the knight from hollow knight in a corridor')).includes('knight_(hollow_knight)'),
  tagsOf(resolve('the knight from hollow knight in a corridor')).join(', '));

// ── an article and one word is one word ─────────────────────────────

check('"a knight girl resting" does not resolve a_knight_(reverse:1999)',
  !tagsOf(resolve('a knight girl resting under a cherry tree at dusk')).includes('a_knight_(reverse:1999)'),
  tagsOf(resolve('a knight girl resting under a cherry tree at dusk')).join(', '));
check('"the girl sits on a bench" does not resolve the_girl_(fear_&_hunger)',
  resolve('The girl sits on a bench in the rain').resolved.length === 0,
  tagsOf(resolve('The girl sits on a bench in the rain')).join(', '));
check('"The Herta" written as a name still resolves her',
  tagsOf(resolve('The Herta reading in a library')).includes('the_herta_(honkai:_star_rail)'),
  tagsOf(resolve('The Herta reading in a library')).join(', '));
check('a longer name after the article is left as it was',
  tagsOf(resolve('the dark urge in a crypt')).includes("the_dark_urge_(baldur's_gate)"),
  tagsOf(resolve('the dark urge in a crypt')).join(', '));
check('naming the series still reaches an article name',
  tagsOf(resolve('the girl from fear & hunger in a dungeon')).includes('the_girl_(fear_&_hunger)'),
  tagsOf(resolve('the girl from fear & hunger in a dungeon')).join(', '));

// ── a name of ordinary words must be written as one (11 Oct 2026) ───

for (const brief of ['a red fox trots across a snowy field', 'Red fox trots across the snow, then looks back']) {
  check(`"${brief}" resolves no fox girl`, !tagsOf(resolve(brief)).includes('red_fox_(kemono_friends)'),
    tagsOf(resolve(brief)).join(', '));
}
for (const brief of ['Red Fox dancing in a meadow', '1girl, red fox, forest', 'red fox from kemono friends in a forest']) {
  check(`"${brief}" still reaches her`, tagsOf(resolve(brief)).includes('red_fox_(kemono_friends)'),
    tagsOf(resolve(brief)).join(', '));
}
check('a name that is not ordinary words still resolves lowercase',
  tagsOf(resolve('hatsune miku singing on a neon stage')).includes('hatsune_miku'),
  tagsOf(resolve('hatsune miku singing on a neon stage')).join(', '));
check('...and so does joseph joestar', tagsOf(resolve('joseph joestar posing on a rooftop')).includes('joseph_joestar'),
  tagsOf(resolve('joseph joestar posing on a rooftop')).join(', '));

// ── what someone says is not who is in the picture (11 Oct 2026) ───

check('a shouted "Encore!" resolves nobody',
  resolve('A street drummer plays on buckets as a crowd gathers; someone shouts "Encore!"').resolved.length === 0,
  tagsOf(resolve('A street drummer plays on buckets as a crowd gathers; someone shouts "Encore!"')).join(', '));
check('...nor in curly quotes', resolve('Someone shouts “Encore!” from the back').resolved.length === 0);
check('the same name outside the quotes still does',
  tagsOf(resolve('Encore dances on a stage and says "Thank you!"')).includes('encore_(wuthering_waves)'),
  tagsOf(resolve('Encore dances on a stage and says "Thank you!"')).join(', '));

// ── a user's rule: a short or ordinary single word must be written as a name ──

check('"rem" lowercase in prose does not resolve — three letters, not written as a name',
  resolve('rem in a maid outfit').resolved.length === 0,
  tagsOf(resolve('rem in a maid outfit')).join(', '));
check('"fern in a workshop" lowercase is the plant until written as a name',
  resolve('fern in a workshop').resolved.length === 0,
  tagsOf(resolve('fern in a workshop')).join(', '));
check('...a tag-style list is lowercase by convention, and the comma field counts',
  tagsOf(resolve('1girl, fern, long hair')).includes('fern_(sousou_no_frieren)'));
check('...and naming the series still reaches her lowercase',
  tagsOf(resolve('fern from frieren in a workshop')).includes('fern_(sousou_no_frieren)'));
check('a name that is no ordinary word needs no capital',
  tagsOf(resolve('makima on a rooftop')).includes('makima_(chainsaw_man)'));
check('a digit name is exempt',
  !needsCapital('2b', tagStore));
check('capitalised mid-sentence counts',
  writtenAsName('fern', 'a portrait of Fern at dusk'));
check('"ice cream" is not "cream" written as a name',
  !writtenAsName('cream', '1girl, ice cream, summer'));

// ── a word that is another named character's series is that series ─────────

check('"young Powder, arcane" does not resolve the Arknights operator called Arcane',
  !tagsOf(resolve('young Powder, arcane')).includes('arcane_(arknights)'),
  tagsOf(resolve('young Powder, arcane')).join(', '));
check('...while "arcane" alone, with no Arcane character named, is left to the other guards',
  !namesAnothersSeries('arcane', [{ tag: 'arcane_(arknights)' }], ['arcane'], () => []));
check('"fern and frieren" still resolves both — a bare tag is the lead of its series',
  tagsOf(resolve('Fern and Frieren at a campfire')).includes('frieren'),
  tagsOf(resolve('Fern and Frieren at a campfire')).join(', '));

// ── the group's own list, for characters danbooru does not know ─────────────

const LIST = [
  { name: 'Powder', aliases: ['Powder VTuber'], traits: ['white hair', 'red eyes'] },
  { name: 'Sir Reginald', traits: ['monocle'], trigger: 'sirreg' },
  { name: 'Empty', traits: [] },
];
const names = (r) => r.map((c) => c.name);
check('a listed name written as a name matches',
  names(findCustomCharacters('Powder streaming at her desk', LIST, tagStore)).includes('Powder'));
check('...lowercase in a comma field matches too',
  names(findCustomCharacters('1girl, powder, smiling', LIST, tagStore)).includes('Powder'));
check('...but "powder" as a word in prose is the substance',
  !names(findCustomCharacters('snow like powder on the peaks', LIST, tagStore)).includes('Powder'));
check('an alias matches as a phrase',
  names(findCustomCharacters('the powder vtuber dancing', LIST, tagStore)).includes('Powder'));
check('a multi-word name needs no capital',
  names(findCustomCharacters('sir reginald at tea', LIST, tagStore)).includes('Sir Reginald'));
check('a name danbooru resolved is never matched from the list',
  !names(findCustomCharacters('Powder from Arcane', LIST, tagStore, ['powder'])).includes('Powder'));
{
  const LABELLED = [{ name: 'Powder', label: 'VTuber', traits: ['white hair'] }];
  const hit = (b, taken = []) => findCustomCharacters(b, LABELLED, tagStore, taken);
  check('a labelled entry is shown with its label',
    hit('Powder streaming')[0]?.name === 'Powder (VTuber)', JSON.stringify(hit('Powder streaming')));
  check('..."Powder (VTuber)" in a brief means her',
    hit('Powder (VTuber) at her desk').length === 1);
  check('...and so does "powder vtuber", lowercase',
    hit('powder vtuber dancing').length === 1);
  check('...even where danbooru took plain "powder"',
    hit('Powder (VTuber) and Powder from Arcane', ['powder']).length === 1);
  check('...while plain "Powder" danbooru took stays danbooru\'s',
    hit('Powder from Arcane', ['powder']).length === 0);
  check('the block names her with the label',
    customCharacterBlock(hit('Powder streaming'), true).includes('Powder (VTuber) —'));
}
check('an entry with no traits is ignored',
  !names(findCustomCharacters('Empty', LIST, tagStore)).includes('Empty'));
{
  const block = customCharacterBlock(findCustomCharacters('Powder and Sir Reginald', LIST, tagStore), true);
  check('the block underscores traits for tag models', block.includes('white_hair'), block);
  check('...names the trigger word when there is one', block.includes('(trigger: sirreg)'), block);
  check('...and tells the model not to invent a tag', /do not invent one/.test(block), block);
  const prose = customCharacterBlock(findCustomCharacters('Powder', LIST, tagStore), false);
  check('...and leaves words as words for prose models', prose.includes('white hair'), prose);
  check('nothing listed, nothing sent', customCharacterBlock([], true) === '');
}

// ── nor can the whole series name, when it is spelled like hers ─────────────

check('"ice cream" does not name the series Cream',
  !franchiseMentioned('cream_(cream)', 'frieren eating ice cream on a bench'));
check('...so the brief a user wrote resolves Frieren and nobody called Cream',
  !tagsOf(resolve('frieren eating ice cream on a bench')).some((t) => t.startsWith('cream')),
  tagsOf(resolve('frieren eating ice cream on a bench')).join(', '));
check('"cream from cream" still names the series',
  franchiseMentioned('cream_(cream)', 'cream from cream in a kitchen'));
check('a series name is a whole word: "ribbon" does not name Ib',
  !franchiseMentioned('ib_(ib)', 'ib holding a ribbon'));

// ── nor can one ordinary word out of a longer series name ──────────────────
//
// "tea at a cafe" resolved tea_(cafe-chan_to_break_time), 129 posts: "cafe"
// is a word of her series, so it lifted every guard. Counts are the real ones.
{
  const words = {
    exactRows: (w) => ({ cafe: [{ tag: 'cafe', category: 0, post_count: 4599 }] })[w] ?? [],
    generalTokenTop: (w) => ({ time: 120000, break: 9000 })[w] ?? 0,
  };
  const TEA = 'tea_(cafe-chan_to_break_time)';
  check('"cafe" alone does not name Cafe-chan to Break Time',
    !franchiseMentioned(TEA, 'tea at a cafe', words, 129));
  check('...nor does "time", which is in huge tags but is not one',
    !franchiseMentioned(TEA, 'tea at break time', words, 129));
  check('...but the whole series name still does',
    franchiseMentioned(TEA, 'tea from cafe chan to break time', words, 129));
  check('a series word that is not an ordinary word still counts',
    franchiseMentioned('fern_(sousou_no_frieren)', 'fern from frieren', words, 9706));
}

// ── helpers ────────────────────────────────────────────────────────────────

check('namePart splits on the franchise paren', namePart('makima_(chainsaw_man)') === 'makima');
check('namePart passes through a bare tag', namePart('joseph_joestar') === 'joseph_joestar');
check('franchisePart reads the paren', franchisePart('rem_(re:zero)') === 're:zero');
check('franchisePart is null on a bare tag', franchisePart('joseph_joestar') === null);
check(
  'a short franchise token cannot match a stray word',
  !franchiseMentioned('rem_(re:zero)', 'she said re and then left')
);
check(
  'a distinctive franchise token matches the short name people actually write',
  franchiseMentioned('fern_(sousou_no_frieren)', 'fern from frieren in a workshop')
);
check('ngrams offers the longest run first', ngrams('joseph joestar posing')[0].split(' ').length === 3);
check('ngrams drops bare stopwords', !ngrams('a girl with the sword').includes('the'));

// ── the block handed to the model ──────────────────────────────────────────

const block = characterBlock(
  [{ tag: 'mualani_(genshin_impact)', traits: ['white_hair', 'blue_eyes', 'dark_skin'] }],
  [],
  true
);
check('the block names the character', block.includes('mualani_(genshin_impact)'));
check('the block carries the traits', block.includes('white_hair'));
check('the block calls them facts', /facts, not suggestions/.test(block));
check('the block defers to an attached reference', /reference\s+wins/.test(block));
// Measured 27 Aug 2026: handed `frieren`, the 27B kept the traits and invented
// a franchise for the tag — `frieren (konosuba)`, and `2b from "Frieren at the
// Funeral"`. A tag with the wrong parenthetical steers nothing.
check('the block pins the tag spelling', /exact tag/.test(block));
check('...and forbids inventing a series after it', /parenthetical series/.test(block));
check('...and forbids merging two characters into one name', /merge two/.test(block));

const spaced = characterBlock(
  [{ tag: 'mualani_(genshin_impact)', traits: ['white_hair'] }],
  [],
  false
);
check('a spaced model gets spaced tags', spaced.includes('white hair') && !spaced.includes('white_hair'));

const warn = characterBlock([], [{ name: 'miku' }], true);
check('an unconfirmed name produces a do-not-invent line', /Do not invent/.test(warn));
check('...naming the character', warn.includes('miku'));
check('nothing at all produces an empty block', characterBlock([], [], true) === '');

// ── colour words that are also somebody's name ───────────────
//
// Reported 5 Sep 2026. "platinum blonde hair" in a brief resolved
// platinum_(arknights) and injected thirteen traits, so a fairy came back as a
// horse girl — horse_ears, horse_tail, white_hair — with yellow_eyes sitting
// beside the red_eyes the person had actually asked for.
//
// No guard was misconfigured. Every one of them reads the tag database, and
// danbooru has no platinum_blonde_hair tag at all: the colour is just
// blonde_hair, so generalTokenTop('platinum') is 0 and there was nothing to
// weigh against the character's 1,188 posts. The signal is in the brief, not
// in the database.
{
  const fairy =
    '1woman, slender, surprised, red eyes, platinum blonde hair, layered skirt, ' +
    'dragonfly wings, small, no glow, no antenna, small pointed ears, nature, ' +
    'tied up, hanging suspension, rain against window, one knee up, profile, shrine';
  check('the reported brief resolves nobody', tagsOf(resolve(fairy)).length === 0);

  check('isAppearanceModifier catches the reported phrase',
    isAppearanceModifier('platinum', fairy) === true);
  check('...and a colour directly in front of the feature',
    isAppearanceModifier('platinum', 'platinum hair, red eyes') === true);
  check('...and the same shape in another colour',
    isAppearanceModifier('jade', '1girl, jade green eyes') === true);

  // The commas are the entire guard. Without them "fern long hair" and
  // "platinum blonde hair" are the same string, and vetoing a real character
  // would be far worse than the bug being fixed.
  check('a name alone in its comma field is untouched',
    isAppearanceModifier('fern', '1girl, fern, long hair, green eyes') === false);
  check('a name at the head of a sentence is untouched',
    isAppearanceModifier('fern', 'fern sitting in a coffee shop') === false);
  check('a name with nothing after it is untouched',
    isAppearanceModifier('platinum', 'a statue of platinum') === false);

  // Naming the series must still reach her.
  check('platinum still resolves when named as the subject',
    tagsOf(resolve('platinum from arknights')).includes('platinum_(arknights)'));

  // Found in the regression run for the above. Naming a series dropped every
  // database guard for ANY candidate from that series, so "red eyes" resolved
  // red_(npc)_(arknights) alongside the character actually asked for. A colour
  // in front of "eyes" is a colour whether or not a franchise is named, so
  // that one test now sits outside the bypass.
  {
    const both = tagsOf(resolve('platinum from arknights, red eyes'));
    check('naming a series does not make every colour word a character',
      both.includes('platinum_(arknights)') && !both.some((tag) => tag.startsWith('red_')));
  }

  // The ordinary paths must all survive.
  check('a plain name still resolves',
    tagsOf(resolve('Fern sitting in a coffee shop')).includes('fern_(sousou_no_frieren)'));
  check('a name in a comma list still resolves',
    tagsOf(resolve('1girl, fern, long hair, green eyes')).includes('fern_(sousou_no_frieren)'));
  check('two characters in one brief still both resolve',
    tagsOf(resolve('makima and power from chainsaw man')).length === 2);
}

// ── full names, 19 Sep 2026 ─────────────────────────────────
{
  check('a full name resolves, surname first',
    tagsOf(resolve('Tsukatsuki Rio at the beach')).join() === 'rio_(blue_archive)');
  check('...and given name first',
    tagsOf(resolve('Rio Tsukatsuki in a swimsuit')).join() === 'rio_(blue_archive)');
  check('...and lowercase in a comma list, where the bare word would abstain',
    tagsOf(resolve('rio tsukatsuki, 1girl, sitting')).join() === 'rio_(blue_archive)');
  const two = tagsOf(resolve('Rio Tsukatsuki and Ushio Noa'));
  check("a surname is not somebody else's name",
    two.includes('noa_(blue_archive)') && !two.includes('ushio_(kancolle)'), two.join(', '));
  check('Ushio on her own is still the Kancolle girl',
    tagsOf(resolve('Ushio from kancolle')).join() === 'ushio_(kancolle)');
}

console.log(`\n${'─'.repeat(58)}`);
console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL PASSED (${pass})`);
process.exit(fail ? 1 : 0);
