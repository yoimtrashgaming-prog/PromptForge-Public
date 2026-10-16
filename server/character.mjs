// Which character is this brief about?
//
// The point is to stop the LLM inventing what a named character looks like.
// server/traits.mjs already derives canon from danbooru and is good at it; it
// was only ever reachable from `GET /api/traits`, which means it helped the
// person who clicked trait chips and nobody else. Someone who types "Mualani
// surfing in Natlan" and presses generate gets the model's memory, and the
// model's memory is confidently wrong — measured, repeatedly: the dialect
// suite has caught qwen3:8b putting long black hair on Makima, who is a
// redhead, and the owner's own Mualani prompt came back with `dark_hair` and
// `green_eyes` against canon white-to-blue hair and blue-to-orange eyes.
//
// ── Why this resolves at all, when traits.mjs says not to ──────────────────
//
// `suggestCharacterTags` in traits.mjs carries an explicit warning: auto-
// resolving a bare name was written first, measured, and rejected as wrong
// often enough to be dangerous. Its measured failures were:
//
//     miku  → mikuma_(kancolle)    WRONG
//     rem   → remilia_scarlet      WRONG
//
// Both come from a CONTAINS search: `%miku%` reaches `mikuma_(kancolle)`, and
// `%rem%` reaches `remilia_scarlet`. That is the right shape for *suggesting*
// to a person, who can see all five options and pick — and the wrong shape for
// deciding alone.
//
// So this file does not do a contains search. It requires the character tag's
// NAME PART to equal what was found in the brief, which is a much narrower
// claim. On the two measured failures:
//
//     miku  → name part of mikuma_(kancolle) is "mikuma" ≠ "miku"  → no match
//           → name part of hatsune_miku is "hatsune_miku" ≠ "miku" → no match
//           → nothing resolved, and nothing is injected
//     rem   → name part of rem_(re:zero) is "rem" = "rem"          → match
//
// The first becomes a safe abstention instead of a wrong answer. The second
// resolves, and resolves *correctly* — Rem from Re:Zero is who anyone typing
// "rem" means, and the old failure picked Remilia only because of the
// substring. So this is not a re-litigation of that decision; it is a stricter
// rule that the two counter-examples both pass.
//
// Two further guards, because "stricter" is not "certain":
//
//   - **More than one candidate is an abstention, never a coin flip.** If the
//     name part matches two characters, nothing is injected for that name.
//     Unless the brief also names the franchise, in which case it decides —
//     "Makima from Chainsaw Man" is not ambiguous to anybody.
//   - **Abstaining is not silence.** An unresolved name still reaches the
//     model, as an instruction not to invent that character's appearance.
//     Today the model invents freely; a brief that says "do not invent" is
//     better than one that says nothing, even when canon is unavailable.
//
// Everything degrades: no tag database, no character in the brief, or a
// danbooru lookup that fails all end with nothing injected and generation
// proceeding exactly as it does today.

// Words that will never be the name part of a character tag worth resolving,
// and that would otherwise cost a database query each. Deliberately short: a
// list of "words that looked wrong" grows forever, and every entry is a
// character somebody cannot look up. These are function words only.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of',
  'on', 'or', 'the', 'to', 'with', 'her', 'his', 'its', 'their', 'he', 'she',
  'they', 'it', 'is', 'are', 'was', 'were', 'be', 'being', 'been', 'that',
  'this', 'these', 'those', 'not', 'no', 'up', 'down', 'out', 'over', 'under',
  'while', 'during', 'after', 'before', 'about', 'against', 'between',
  'wearing', 'standing', 'sitting', 'holding', 'looking', 'style', 'art',
  'anime', 'girl', 'boy', 'man', 'woman', 'character', 'scene', 'shot',
  // Counting words. `two` reaches two_(drag-on_dragoon) and has no general
  // tag to be caught by, so the noun test cannot see it.
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
]);

/** Everything before `_(` — `makima_(chainsaw_man)` -> `makima`. */
export function namePart(tag) {
  const i = String(tag ?? '').indexOf('_(');
  return i === -1 ? String(tag ?? '') : tag.slice(0, i);
}

/** Everything inside the final `(...)`, or null. */
export function franchisePart(tag) {
  const m = /_\(([^()]+)\)$/.exec(String(tag ?? ''));
  return m ? m[1] : null;
}

/** Brief text -> comparable form: lowercase, underscores as spaces. */
function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[^a-z0-9:' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Contiguous 1..n word runs of a brief, longest first so "joseph joestar"
 * is offered before "joseph".
 */
export function ngrams(text, maxWords = 3) {
  const words = normalise(text).split(' ').filter(Boolean);
  const out = [];
  for (let n = maxWords; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n);
      // A single stopword is never a name. A RUN that merely contains one is
      // fine — `rem_(re:zero)` needs "re zero" and "re" is not in the list,
      // but a name like "jack o lantern" would be.
      if (n === 1 && STOPWORDS.has(run[0])) continue;
      // Two characters is normally noise, but a name with a digit in it is
      // not: 2b_(nier:automata) carries 9,916 posts and a length floor of 3
      // made it permanently unresolvable.
      if (n === 1 && run[0].length < 3 && !/\d/.test(run[0])) continue;
      if (n === 1 && run[0].length < 2) continue;
      out.push(run.join(' '));
    }
  }
  return [...new Set(out)];
}

/**
 * Does the brief mention this tag's franchise?
 *
 * Token-wise rather than whole-string, because people write the short name:
 * `fern_(sousou_no_frieren)` is "Fern from Frieren" in every real brief, and
 * requiring the full "sousou no frieren" would never fire. One distinctive
 * token is enough; tokens under four characters are ignored so `re` in
 * `re:zero` cannot match the word "re" anywhere.
 *
 * **A token that is the character's own name proves nothing.** The franchise
 * of `knight_(hollow_knight)` contains the word "knight", so the brief "a
 * knight on a ridge" was reading its own subject back as evidence of the
 * series and lifting every guard on the strength of it. Found 28 Aug 2026 by
 * scanning ordinary brief vocabulary. "hollow knight" in a brief still is the
 * series, through its other token.
 *
 * **Nor can the whole series name, when it is spelled the same as hers.**
 * Reported 18 Sep 2026: "eating ice cream" resolved `cream_(cream)`, 114
 * posts, "via franchise named in brief" — the series is called Cream, so the
 * word "cream" named it, the bypass lifted every guard, and a character nobody
 * asked for went into the prompt. Seventeen characters with 50+ posts have
 * that shape (`omori_(omori)`, `ib_(ib)`, `hilda_(hilda)`). So the whole-string
 * match runs on the brief with her own name taken out: one word cannot be the
 * subject and the evidence for her series at once. "cream from cream" still
 * names the series.
 *
 * **Nor can one ordinary word out of a longer series name.** "tea at a cafe"
 * resolved `tea_(cafe-chan_to_break_time)`, 129 posts, because "cafe" is a
 * word of her series. So a single series word only counts when it is not an
 * ordinary word by the two tests the name itself is held to, `isCommonWord`
 * and `isDescriptiveWord`, against this character's own post count. Measured
 * 2 Oct 2026 over every character with 50+ posts: 893 stop being injected by
 * a word like "fire", "dragon" or "family"; 860 lose a short form ("Lyn from
 * Fire") but keep the whole name ("Lyn from Fire Emblem"); five obscure ones
 * (all under 230 posts, `pepper_(pepper&carrot)` the largest) are reachable
 * only by picking them by hand. None became newly reachable.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole words only: `ib_(ib)` must not find its series inside "ribbon". */
function hasPhrase(normalisedBrief, phrase) {
  return new RegExp(`(^| )${escapeRe(phrase)}( |$)`).test(normalisedBrief);
}

/** The brief with the first mention of this character's own name blanked. */
function withoutOwnName(tag, normalisedBrief) {
  const own = normalise(namePart(tag));
  if (!own) return normalisedBrief;
  return normalisedBrief.replace(new RegExp(`(^| )${escapeRe(own)}( |$)`), ' ');
}

export function franchiseMentioned(tag, normalisedBrief, tagStore = null, characterPosts = 0) {
  const fr = franchisePart(tag);
  if (!fr) return false;
  const whole = normalise(fr);
  if (whole && hasPhrase(withoutOwnName(tag, normalisedBrief), whole)) return true;
  const own = normalise(namePart(tag));
  return normalise(fr)
    .split(/[ :]+/)
    .filter((t) => t.length >= 4 && t !== own)
    .filter((t) => !tagStore || !(isCommonWord(t, tagStore, characterPosts) || isDescriptiveWord(t, tagStore, characterPosts)))
    .some((t) => new RegExp(`\\b${t}\\b`).test(normalisedBrief));
}

/**
 * Is this word an ordinary English noun rather than somebody's name?
 *
 * Measured against the real 181,714-row database rather than reasoned about,
 * because the stub suite passed while this was broken. Briefs with no
 * character in them were resolving obscure ones:
 *
 *   "hauling rope in a storm"      -> rope_(arknights), storm_(x-men)
 *   "a cup of tea on a low table"  -> tea_(cafe-chan_to_break_time)
 *   "sitting on a rock"            -> rock_(tezuka_osamu)
 *
 * Each of those injects a stranger's canon into a prompt that never mentioned
 * a person, which is a worse version of the bug this feature exists to fix.
 *
 * The separator is clean and needs no hand-written word list. Every false
 * positive has an exact GENERAL tag of the same name; no true positive has an
 * exact tag at all:
 *
 *   rope cat0:51332   storm cat0:1006   tea cat0:12292   rock cat0:27211
 *   mualani (none)    makima (none)     zhongli (none)   ganyu (none)
 *
 * A character whose name really is a common noun — Power, Rock — is therefore
 * skipped. That is an abstention, which this file treats as always safe, and
 * the person can still pick them by hand.
 */
export function isCommonWord(name, tagStore, characterPosts = 0) {
  const rows = tagStore.exactRows?.(name) ?? [];
  const general = rows.find((r) => r.category === 0)?.post_count ?? 0;
  if (!general) return false;
  // A comparison rather than mere existence, because some characters really
  // are named after nouns and the counts separate the two cleanly:
  //
  //   fern       general 1038  vs fern_(sousou_no_frieren) 5355  -> a person
  //   power      general    0  vs power_(chainsaw_man)     4826  -> a person
  //   tea        general 12292 vs tea_(cafe-chan...)        128  -> a noun
  //   maid       general 146593 vs maid_(etan14)             71  -> a noun
  //
  // Existence alone was the first rule and it cost Fern, who this group
  // actually prompts. Ties go to the noun: an even split is not evidence.
  return general >= characterPosts;
}

/**
 * Is this word a description rather than a name — even though danbooru has no
 * general tag spelled exactly that way?
 *
 * The exact-tag rule above catches nouns. It does not catch adjectives, and
 * it was never asked to until 27 Aug 2026, when the lookup budget that had
 * been hiding them was removed: there is no general tag `long`, so "a long
 * dusty road" resolved `long_(chainsaw_man)`, all 85 posts of him.
 *
 * The signal is the same shape one step out — the word is not a tag, but it
 * is a WORD IN tags, and the tags it appears in are enormous:
 *
 *   long   long_hair   4,323,141   vs long_(chainsaw_man)         85
 *   red    red_eyes    1,267,681   vs red_(pokemon)             4,924
 *   trunks swim_trunks     4,673   vs trunks_(dragon_ball)      1,224
 *   pine   pine_tree       1,923   vs pine_(bombergirl)           616
 *   power  power_lines     9,969   vs power_(chainsaw_man)      4,826  <- a person
 *   fern   fern            1,038   vs fern_(sousou_no_frieren)  5,355  <- a person
 *
 * A ratio rather than a comparison, and the margin is where the measurement
 * mattered: the two real names sit at 2.1x and 0.2x, the descriptions at 3.1x
 * and above, so the line is drawn at three. Everything on this list came out
 * of a fifteen-brief corpus of scenes with no character in them; at 3x that
 * corpus resolves nobody, and at 4x it resolves Pine.
 *
 * Only single words are asked about. `joseph_joestar` is not a token in
 * anything, and a multi-word run of English happening to be somebody's name
 * part is not the failure mode this guards.
 */
const DESCRIPTION_RATIO = 3;

/**
 * Words danbooru gives no signal about, because they are not tags in any
 * form — and which are still descriptions in every brief anyone here writes.
 *
 * This is the hand-kept list this file spent two rewrites avoiding, and the
 * reason it is defensible now is that it is no longer a life sentence: naming
 * the series overrides it, so `misty from pokemon` still resolves. An entry
 * costs a bare one-word lookup, not a character.
 *
 * **Derived, not guessed.** 209 ordinary words of scene, weather, light,
 * landscape, material and trade vocabulary were run through the resolver on
 * 28 Aug 2026; fifteen resolved somebody. These are the eleven where the word
 * is overwhelmingly a description and the character is from a series this
 * group does not work in:
 *
 *   dawn 7,698 (pokemon)      misty 3,784 (pokemon)     sunny 2,940 (omori)
 *   hare 833 (blue archive)   reed 810 (arknights)      mist 384 (fire emblem)
 *   thunder 365 (gf)          thistle 343 (dungeon meshi)
 *   scholar 305 (final fantasy)  velvet 285 (odin sphere)
 *   knight 334 (hollow knight)
 *
 * **The other four are deliberately absent**, and that is the whole judgement
 * in this list: `fern`, `amber`, `wanderer` and `archer` are Frieren, Genshin
 * and Fate characters this group actually prompts. Losing Fern to a word list
 * is the exact mistake `isCommonWord` was rewritten to stop making.
 *
 * Add to it when one bites. Do not add a word that is somebody's name here.
 */
const DESCRIPTION_WORDS = new Set([
  'dawn', 'misty', 'mist', 'sunny', 'hare', 'reed', 'thunder', 'thistle',
  'scholar', 'velvet', 'knight',
]);

export function isDescriptiveWord(name, tagStore, characterPosts = 0) {
  if (!characterPosts || String(name).includes('_')) return false;
  if (DESCRIPTION_WORDS.has(String(name).toLowerCase())) return true;
  const general = tagStore.generalTokenTop?.(name) ?? 0;
  return general >= DESCRIPTION_RATIO * characterPosts;
}


/**
 * Nouns a colour word sits in front of. If one of these follows the candidate
 * inside the same comma field, the candidate was describing it.
 */
const APPEARANCE_NOUNS = new Set([
  'hair', 'eye', 'eyes', 'skin', 'fur', 'wings', 'wing', 'tail', 'ears', 'ear',
  'horns', 'horn', 'pupils', 'irises', 'nails', 'lips', 'scales', 'feathers',
]);

/**
 * Is this word a colour modifier rather than a name?
 *
 * Reported 5 Sep 2026: "platinum blonde hair" in a brief resolved
 * `platinum_(arknights)` and injected thirteen traits, so a fairy came back a
 * horse girl — horse_ears, horse_tail, white_hair, yellow_eyes — with
 * yellow_eyes sitting next to the red_eyes the person actually asked for.
 *
 * **Every existing guard is built on the tag database, and the database had
 * nothing to say.** danbooru has no `platinum_blonde_hair` tag; the colour is
 * just `blonde_hair`. So generalTokenTop('platinum') is 0, isDescriptiveWord
 * compares 0 against three times 1,188 and abstains, and the solo floor of 500
 * passes a character with 1,188 posts. Nothing was misconfigured. The signal
 * simply is not in the database, because the word is only ever a modifier in a
 * compound somebody else's tag never spells out.
 *
 * It is in the BRIEF though, and in how this group writes: comma-separated
 * attributes. "platinum blonde hair" is one field, and inside it `platinum`
 * sits directly in front of a hair colour.
 *
 * **The commas are the whole guard**, which is why this takes the raw brief
 * rather than the normalised one. "1girl, frieren, long hair" normalises to
 * "frieren long hair" and would look identical to "platinum blonde hair" —
 * vetoing Frieren, which is far worse than the bug being fixed. Split on
 * commas first and Frieren is alone in her field with nothing after her.
 */
export function isAppearanceModifier(name, brief) {
  const word = String(name).toLowerCase();
  if (word.includes('_') || word.includes(' ')) return false;

  for (const field of String(brief ?? '').split(/[,;\n]/)) {
    const words = normalise(field).split(' ').filter(Boolean);
    const at = words.indexOf(word);
    // Only when something FOLLOWS it in the same field. A field that is just
    // the name, or ends on it, is a name being listed.
    if (at < 0 || at === words.length - 1) continue;
    // "platinum hair" — directly in front of the feature.
    if (APPEARANCE_NOUNS.has(words[at + 1])) return true;
    // "platinum blonde hair" — in front of another colour word that is.
    if (words[at + 2] && APPEARANCE_NOUNS.has(words[at + 2])) return true;
  }
  return false;
}

/**
 * Was this one-word name written as a name — capitalised somewhere in the
 * brief — or only as a word?
 *
 * A user's rule from his own Character Identification workflow, 18 Sep 2026:
 * a single-word name counts only if it is 4+ characters, capitalised and
 * unambiguous. Unambiguous this file already requires. The other two are
 * applied as an ADDITIONAL abstention, never a bypass: an uncapitalised word
 * that is short, or that is also an ordinary danbooru tag, is not resolved
 * unless the brief names the series. Capitalised, it still faces every
 * guard below. So "fern in a workshop" (the plant, as far as anyone can
 * tell) abstains, "Fern in a workshop" and "fern from frieren" still reach
 * her, and "rem" alone no longer resolves while "Rem" does.
 *
 * Any capitalised occurrence counts, sentence-initial included: that is
 * weaker evidence, which is why the guards below still apply to it.
 *
 * So does a word alone in its comma field. Tag-style briefs are lowercase by
 * convention — "1girl, fern, long hair" — and there the field boundary is the
 * signal that it is being listed as a name; "ice cream" is not "cream" alone.
 */
export function writtenAsName(name, brief) {
  const word = String(name).toLowerCase();
  const raw = String(brief ?? '');
  const capitalised = raw
    .split(/[^\p{L}\p{N}'-]+/u)
    .some((t) => t && t.toLowerCase() === word && t[0] !== t[0].toLowerCase());
  if (capitalised) return true;
  return raw.split(/[,;\n]/).some((field) => normalise(field) === word);
}

/**
 * Was this run of words written as a name? The two-and-three-word form of
 * writtenAsName, and the owner's call of 11 Oct 2026: a name of several words
 * counts only when written like one, or when the brief names the series.
 *
 * Measured that day over the real database: 574 characters whose names are
 * made of ordinary vocabulary resolved from a lowercase brief - "a red fox
 * trots across a snowy field" came back as red_fox_(kemono_friends), a fox
 * girl with gradient hair, and so did grey wolf, brown bear, male doctor,
 * rice shower and silver wolf.
 *
 * EVERY word capitalised, not the first: "Red fox trots across the snow" opens
 * a sentence and is not a name. Small joining words are exempt, so "Shadow the
 * Hedgehog" counts. A comma field holding exactly the name counts too, for
 * tag-style briefs ("1girl, princess peach, castle").
 */
const JOINING_WORDS = new Set(['a', 'an', 'the', 'of', 'no', 'and', 'de', 'in', 'on', 'to']);

export function phraseWrittenAsName(gram, brief) {
  const words = String(gram).toLowerCase().split(' ').filter(Boolean);
  const raw = String(brief ?? '');
  const tokens = raw.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  for (let i = 0; i + words.length <= tokens.length; i++) {
    const run = tokens.slice(i, i + words.length);
    if (!run.every((t, j) => t.toLowerCase() === words[j])) continue;
    if (run.every((t, j) => JOINING_WORDS.has(words[j]) || t[0] !== t[0].toLowerCase())) return true;
  }
  return raw.split(/[,;\n]/).some((field) => normalise(field) === words.join(' '));
}

/**
 * Is this several-word name made only of ordinary vocabulary - each word a
 * word inside general tags carrying 1,000+ posts? "red fox", "iron man" and
 * "princess peach" are; "hatsune miku" and "joseph joestar" are not, so those
 * still resolve however they are typed. 1,000 is the line the 11 Oct 2026
 * sweep was drawn at. Joining words are left out of the test.
 */
const ORDINARY_TOKEN_POSTS = 1000;

export function ordinaryPhrase(key, tagStore) {
  const words = String(key).split('_').filter((w) => w && !JOINING_WORDS.has(w));
  if (words.length < 2 || !tagStore?.generalTokenTop) return false;
  return words.every((w) => tagStore.generalTokenTop(w) >= ORDINARY_TOKEN_POSTS);
}

/**
 * The brief with quoted speech taken out, for name-finding only.
 *
 * What someone says is not who is in the picture. Found 11 Oct 2026: an h3
 * brief where the crowd shouts "Encore!" resolved encore_(wuthering_waves),
 * and both the 27B and the 4B dressed the street drummer in her pink
 * twintails. A capital at the start of a shouted word passes every name
 * test there is, so the dialogue is removed before any test runs. Double
 * quotes only, straight or curly: single quotes are apostrophes as often as
 * not. Replaced with a comma so the words either side stay apart.
 */
export function withoutDialogue(brief) {
  return String(brief ?? '').replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」/g, ', ');
}

export function needsCapital(name, tagStore) {
  const word = String(name);
  if (word.includes('_') || /\d/.test(word)) return false;
  if (word.length < 4) return true;
  return (tagStore.exactRows?.(word) ?? []).some((r) => r.category === 0 && (r.post_count ?? 0) > 0);
}

/**
 * Is this word naming a franchise rather than a subject?
 *
 * Two signals. The word sits immediately after "from", which in a brief is
 * almost always "<character> from <series>" — and the series half is not who
 * the picture is of. Or danbooru files the exact word as a copyright.
 *
 * Without this, "Fern from Frieren" resolves Frieren as well as Fern, and
 * "2b from nier" resolves whichever Granblue character happens to be called
 * Nier. Both then inject a second person's traits into a one-character prompt.
 */
export function isFranchiseReference(name, normalisedBrief, tagStore) {
  if (new RegExp(`\\bfrom\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(normalisedBrief)) {
    return true;
  }
  const rows = tagStore.exactRows?.(name) ?? [];
  return rows.some((r) => r.category === 3 && (r.post_count ?? 0) > 0);
}

/**
 * Is this word the series of ANOTHER character the brief names?
 *
 * "young Powder, arcane" lists the series as a field, as tag-style briefs do.
 * `isFranchiseReference` only knows "from <series>" and exact copyright tags,
 * and Arcane's copyright tag is not the bare word, so `arcane` resolved
 * arcane_(arknights) — found 19 Sep 2026.
 *
 * The word counts as a series reference when some other name in the brief has
 * a candidate whose franchise is that word, and none of this word's own
 * candidates comes from that franchise. Every one of its candidates must also
 * carry a franchise of its own: a bare tag like `frieren` IS the lead of the
 * series that shares her name, so "fern and frieren" still resolves both.
 */
export function namesAnothersSeries(gram, candidates, grams, candidatesOf) {
  if (!candidates.every((c) => franchisePart(c.tag))) return false;
  const own = new Set(candidates.map((c) => normalise(franchisePart(c.tag))));
  for (const other of grams) {
    if (other === gram || other.includes(gram) || gram.includes(other)) continue;
    for (const c of candidatesOf(other)) {
      const fr = normalise(franchisePart(c.tag) ?? '');
      if (!fr || own.has(fr)) continue;
      if (fr === gram || fr.split(/[ :]+/).includes(gram)) return true;
    }
  }
  return false;
}

/**
 * Collapse costume variants of one character into the plain form.
 *
 * danbooru gives an alternate outfit its own tag, nested:
 *
 *   zhongli_(genshin_impact)
 *   zhongli_(archon)_(genshin_impact)
 *   zhongli_(lantern_rite)_(genshin_impact)
 *
 * All three are one man. Treating them as three candidates made every popular
 * Genshin character permanently "ambiguous" and abstained on exactly the
 * people this group prompts most — Zhongli, Ganyu and Xiao all failed this way
 * on the first real-data run.
 *
 * Same name and same OUTERMOST franchise means same person, so the group
 * collapses to its plainest member: fewest parenthetical groups, then most
 * posts. Different franchises stay separate, because those are different
 * people and that ambiguity is real.
 *
 * ── Except when the plain tag itself is one of the candidates ──────────────
 *
 * A character famous enough to need no franchise gets the bare tag, and their
 * variants hang off it with a qualifier that is not a franchise at all:
 *
 *   joseph_joestar          7,678
 *   joseph_joestar_(young)  6,454
 *   joseph_joestar_(old)    1,400
 *
 * By outermost franchise those are four different people — "", "young",
 * "old", "tequila" — so the rule above made Joseph permanently ambiguous, and
 * every brief naming him got nothing. Found 27 Aug 2026 when the lookup budget
 * came off and he was still unresolvable. 116 name parts in this database have
 * that shape; reading them, they are costume, age and debut variants without
 * exception — danbooru only leaves the bare tag on a name one character owns.
 *
 * So a bare tag among the candidates claims every candidate with its name.
 */
export function collapseVariants(candidates) {
  const bare = new Set(candidates.filter((c) => !c.tag.includes('_(')).map((c) => c.tag));
  const groups = new Map();
  for (const c of candidates) {
    const name = namePart(c.tag);
    const key = bare.has(name) ? name : `${name}|${franchisePart(c.tag) ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const depth = (tag) => (tag.match(/_\(/g) ?? []).length;
  return [...groups.values()].map((list) =>
    [...list].sort((a, b) => depth(a.tag) - depth(b.tag) || b.post_count - a.post_count)[0]
  );
}

/**
 * Of several characters sharing a name, the one whose franchise the brief
 * names — or null, which means nobody.
 *
 * The subtlety is that a franchise token has to *distinguish*. Two candidates
 * can share one: `nagisa_(other_series)` and `nagisa_(third_series)` both own
 * the token "series", so a brief containing the word "series" matches both and
 * has told us nothing. Same shape in real data — "fantasy", "story", "no" and
 * "gakuen" recur across franchises.
 *
 * So: a whole-franchise-string match wins outright, and failing that only
 * tokens unique to one candidate are allowed to decide. Anything else is an
 * abstention, which is the rule this whole file is built on.
 */
export function disambiguateByFranchise(candidates, normalisedBrief) {
  const whole = candidates.filter((c) => {
    const fr = franchisePart(c.tag);
    if (!fr) return false;
    const s = normalise(fr);
    return s && hasPhrase(withoutOwnName(c.tag, normalisedBrief), s);
  });
  if (whole.length === 1) return whole[0];

  // Tokens carried by more than one candidate cannot separate them. Nor can a
  // token that is the character's own name — see `franchiseMentioned`.
  const counts = new Map();
  const tokensFor = (tag) =>
    normalise(franchisePart(tag) ?? '')
      .split(/[ :]+/)
      .filter((t) => t.length >= 4 && t !== normalise(namePart(tag)));
  for (const c of candidates) {
    for (const t of new Set(tokensFor(c.tag))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const byUnique = candidates.filter((c) =>
    tokensFor(c.tag).some(
      (t) => counts.get(t) === 1 && new RegExp(`\\b${t}\\b`).test(normalisedBrief)
    )
  );
  return byUnique.length === 1 ? byUnique[0] : null;
}

/**
 * Of several characters sharing a name, the one nobody would have to ask
 * about — or null, which means the ambiguity is real.
 *
 * Abstaining on every shared name was the first rule and it is too strict to
 * be honest. `rem` is the example this file already argues about in its own
 * header: danbooru has `rem_(re:zero)` at 9,042 posts and `rem_(death_note)`
 * at 88, and the header says outright that "Rem from Re:Zero is who anyone
 * typing 'rem' means". Abstaining there is not caution, it is refusing to
 * answer a question with one answer.
 *
 * Ten times the runner-up, measured over the whole database: 292 one-word
 * names qualify, and reading them they are Cirno, Ganyu, Saber, Link, Lumine,
 * Scaramouche, Gardevoir, and about 280 more of the same kind — in every case
 * the famous character against a cookie-variant or a fan-comic namesake. The
 * names that stay ambiguous are the ones that deserve to: two Rems is a bad
 * example, but two Nagisas at 3,000 and 2,500 is a real question.
 *
 * The margin is what makes this safe rather than a coin flip. At 2x it would
 * start deciding between characters people genuinely confuse.
 */
const DOMINANCE = 10;

export function dominantCandidate(candidates) {
  if (candidates.length < 2) return null;
  const [best, second] = [...candidates].sort((a, b) => (b.post_count ?? 0) - (a.post_count ?? 0));
  return (best.post_count ?? 0) >= DOMINANCE * (second.post_count ?? 0) ? best : null;
}

/**
 * Find the characters a brief is about.
 *
 * @param brief     what the person typed
 * @param tagStore  server/tags.mjs store; needs `charactersNamed` and `exactRows`
 * @param opts.minPostCount  ignore character tags rarer than this
 * @param opts.minSoloPostCount  the same floor for a ONE-WORD name, which is
 *                               far likelier to be an English word by accident
 * @param opts.maxCharacters cap on how many are resolved
 * @returns { resolved: [{ tag, name, via, post_count }],
 *            ambiguous: [{ name, candidates: [tag] }] }
 *
 * Every n-gram of the brief is considered. There used to be a `maxLookups`
 * budget of 24, because each gram cost a prefix query; a brief of any
 * realistic length spent it among the three-word grams and never reached the
 * character's bare name, then failed silently. `tagStore.charactersNamed` is
 * a map built once, so the budget has nothing left to buy and is gone.
 */
/**
 * The character a two- or three-word run of the brief names in full, or null.
 *
 * Danbooru files most characters under one name — `rio_(blue_archive)` — and
 * keeps the full name as an alias: `tsukatsuki_rio`, `ushio_noa`,
 * `hayase_yuuka`. The resolver only ever read the name part, so found 19 Sep
 * 2026: "rio tsukatsuki, 1girl" resolved nobody (a lowercase three-letter
 * word, a user's rule, and the surname beside it counted for nothing), and
 * "Rio Tsukatsuki and Ushio Noa" brought in Kancolle's `ushio_(kancolle)`,
 * because Noa's surname is somebody else's name.
 *
 * Either order, since people write Japanese names both ways. The alias must
 * contain the character's own name — surname plus name, not a nickname —
 * which is what keeps a two-word phrase from resolving to someone because an
 * alias happens to spell it.
 */
export function fullNameOf(gram, tagStore, minPostCount = 50) {
  if (!tagStore?.aliasTarget) return null;
  const words = String(gram).split(' ');
  if (words.length < 2 || words.length > 3) return null;
  const orders = words.length === 2 ? [words, [words[1], words[0]]] : [words];
  for (const order of orders) {
    const target = tagStore.aliasTarget(order.join('_'));
    if (!target) continue;
    const own = namePart(target).split('_');
    if (!own.every((w) => order.includes(w))) continue;
    const row = tagStore.charactersNamed(namePart(target)).find((r) => r.tag === target);
    if (row && (row.post_count ?? 0) >= minPostCount) return row;
  }
  return null;
}

export function resolveCharacters(brief, tagStore, opts = {}) {
  const { minPostCount = 50, minSoloPostCount = 500, maxCharacters = 3 } = opts;
  const empty = { resolved: [], ambiguous: [] };
  if (!brief || !tagStore?.charactersNamed) return empty;
  brief = withoutDialogue(brief);

  const norm = normalise(brief);
  const resolved = [];
  const ambiguous = [];
  const claimed = [];          // name parts already resolved, to avoid overlap

  const grams = ngrams(brief);
  const candidatesCache = new Map();
  const candidatesOf = (gram) => {
    if (!candidatesCache.has(gram)) {
      candidatesCache.set(gram, collapseVariants(
        tagStore.charactersNamed(gram.replace(/ /g, '_')).filter((r) => (r.post_count ?? 0) >= minPostCount)
      ));
    }
    return candidatesCache.get(gram);
  };

  for (const gram of grams) {
    if (resolved.length >= maxCharacters) break;
    // Skip a gram already covered by a longer resolved name: once
    // "joseph joestar" resolves, "joseph" must not resolve again.
    if (claimed.some((c) => c.includes(gram) || gram.includes(c))) continue;

    const key = gram.replace(/ /g, '_');

    // A full name is as sure as a name gets. See fullNameOf.
    // Held to the same rule as any other name of ordinary words: lowercase
    // "a white rabbit" and "a fairy maid" resolved Touhou and Alice through
    // their aliases. "rio tsukatsuki" is not ordinary words and is unaffected.
    const full = fullNameOf(gram, tagStore, minPostCount);
    if (full && ordinaryPhrase(key, tagStore) && !phraseWrittenAsName(gram, brief)
        && !franchiseMentioned(full.tag, norm, tagStore, full.post_count ?? 0)) {
      continue;
    }
    if (full) {
      resolved.push({ tag: full.tag, name: gram, via: 'full name', post_count: full.post_count });
      claimed.push(gram);
      continue;
    }

    // Exact name-part equality, out of the index. THE narrowing that makes
    // this safe — see the header. It is also free, which is why it now runs
    // before the checks below rather than after them: those cost a query
    // each, and most grams of a brief are not anybody's name.
    // One person in three outfits is one candidate, not three.
    const candidates = candidatesOf(gram);

    if (!candidates.length) continue;

    // "Fern FROM Frieren" names a series in its second half, not a second
    // subject.
    if (isFranchiseReference(key, norm, tagStore)) continue;
    // "young Powder, arcane" names Powder's series in its last field. Found
    // 19 Sep 2026: `arcane` resolved arcane_(arknights), an operator from
    // another game entirely. See namesAnothersSeries.
    if (namesAnothersSeries(gram, candidates, grams, candidatesOf)) continue;

    const bestPosts = Math.max(...candidates.map((c) => c.post_count ?? 0));

    // ── Does the brief name this character's series? ───────────────────────
    //
    // If it does, none of the three tests below applies. Every one of them is
    // a guess about whether a word was meant as a name, and a brief that says
    // where somebody is from is not a guess: "june from squeezable" has ruled
    // out the month, and "dusty from gravity daze" has ruled out the road.
    // The guess is only needed when nothing else in the brief says.
    //
    // It is also how this group writes — "Makima from Chainsaw Man", "Fern
    // from Frieren", "2b from nier" — so every character in the database stays
    // reachable, however obscure, by typing the series. That is the whole of
    // what the floor asks in exchange.
    //
    // Narrow, because it is per candidate: the brief has to mention THAT
    // character's franchise, not any franchise.
    const seriesNamed = candidates.some((c) => franchiseMentioned(c.tag, norm, tagStore, c.post_count ?? 0));

    // Outside the series bypass, deliberately, and the only guard that is.
    //
    // Naming a series says that SOMEWHERE in this brief a character is meant.
    // It does not turn every other word into one. "platinum from arknights,
    // red eyes" resolved Platinum — correctly — and then `red_(npc)_(arknights)`
    // as well, because Red is an Arknights character and the brief had already
    // said Arknights, so every database guard was dropped for her too. Found
    // 5 Sep 2026 while fixing the platinum case, in the regression run for it.
    //
    // A colour sitting in front of "eyes" is a colour whether or not the brief
    // names a franchise, so this one test still applies. The bypass keeps
    // doing its real job: an obscure character reachable by naming her series.
    if (isAppearanceModifier(key, brief)) continue;

    if (!seriesNamed) {
      // An article and one word is one word. "a knight girl resting" resolved
      // a_knight_(reverse:1999) and "the girl sits on a bench" resolved
      // the_girl_(fear_&_hunger): the two-word gram matched their name part
      // exactly and skipped every one-word guard below, `knight` in
      // DESCRIPTION_WORDS included. Found 11 Oct 2026. The guards judge the
      // word after the article; a longer name after it ("the dark urge") is
      // a run of words and is left as it was.
      const bareKey = key.replace(/^(a|an|the)_/, '');
      const guardKey = bareKey !== key && !bareKey.includes('_') ? bareKey : key;
      const guardGram = guardKey.replace(/_/g, ' ');

      // A user's rule: a short or ordinary single word must be written as a
      // name. See writtenAsName.
      if (needsCapital(guardKey, tagStore) && !writtenAsName(guardGram, brief)) continue;
      // And so must a name of several ordinary words. See phraseWrittenAsName.
      if (ordinaryPhrase(guardKey, tagStore) && !phraseWrittenAsName(guardGram, brief)) continue;

      // Is this word their name, or an English word that happens to collide?
      if (isCommonWord(guardKey, tagStore, bestPosts)) continue;
      if (isDescriptiveWord(guardKey, tagStore, bestPosts)) continue;

      // One word out of a brief carries a much higher floor than a name of two
      // or three, because one word of English landing on somebody's name part
      // is routine and a whole phrase doing it is not. Measured over a corpus
      // of briefs with no character in them: everything that resolved by
      // accident was a character with a few hundred posts —
      // `dusty_(gravity_daze)` 180, `haze_(arknights)` 117, `new_(lk)` 138 out
      // of "new york".
      //
      // A veto on the whole gram, deliberately, rather than a filter on the
      // candidates: filtering can leave one survivor and turn a safe
      // abstention into a confident wrong answer. "a jade seal" finds four
      // Jades and must stay four.
      if (!guardKey.includes('_') && bestPosts < minSoloPostCount) continue;
    }

    if (candidates.length === 1) {
      resolved.push({ tag: candidates[0].tag, name: gram, via: 'unique name', post_count: candidates[0].post_count });
      claimed.push(gram);
      continue;
    }

    // Several characters share this name. The brief decides, or the gap
    // between them does, or nobody does.
    const picked = disambiguateByFranchise(candidates, norm);
    if (picked) {
      resolved.push({ tag: picked.tag, name: gram, via: 'franchise named in brief', post_count: picked.post_count });
      claimed.push(gram);
      continue;
    }

    const best = dominantCandidate(candidates);
    if (best) {
      resolved.push({ tag: best.tag, name: gram, via: 'far the best known of that name', post_count: best.post_count });
      claimed.push(gram);
      continue;
    }

    ambiguous.push({ name: gram, candidates: candidates.slice(0, 5).map((c) => c.tag) });
    claimed.push(gram);
  }

  return { resolved, ambiguous };
}

/**
 * The block that goes into the user turn.
 *
 * Mirrors how reference images are phrased in server/imagerefs.mjs: state
 * plainly where this came from and what to do with it, and never imply the
 * model can see something it cannot.
 *
 * @param entries    [{ tag, traits: [tagString] }] canon that was found
 * @param unresolved [{ name }] names that could not be confirmed
 * @param underscore whether this model wants danbooru underscores
 */
export function characterBlock(entries, unresolved = [], underscore = true) {
  const lines = [];

  const withTraits = entries.filter((e) => e.traits?.length);
  if (withTraits.length) {
    lines.push(
      'Canonical appearance for the characters named in this brief, read from ' +
        'danbooru on this machine. These are facts, not suggestions: use them ' +
        'exactly and do not add remembered details of your own to them. Where ' +
        'an attached reference image contradicts anything below, the reference ' +
        'wins — the user chose that picture. There is deliberately no clothing ' +
        'in this list: what she wears is the brief\'s to decide, not canon\'s.'
    );
    for (const e of withTraits) {
      const name = underscore ? e.tag : e.tag.replace(/_/g, ' ');
      const traits = e.traits.map((t) => (underscore ? t : t.replace(/_/g, ' ')));
      lines.push(`  ${name} — ${traits.join(', ')}`);
    }
    // The name on the left is the danbooru tag, and it has to survive intact.
    //
    // Reported 27 Aug 2026 from real output: handed `frieren`, the 27B wrote
    // `2b from "Frieren at the Funeral"` and `frieren (konosuba)` — it kept
    // the traits, which were correct, and invented a franchise for the tag.
    // Frieren is not Konosuba. A character tag with the wrong parenthetical is
    // worse than none: it is not a tag any model was trained on, so it steers
    // nothing and displaces the one that would have.
    lines.push(
      'The name before each dash is that character\'s exact tag. Write it ' +
        'exactly as given. Do not add, remove or change a parenthetical series ' +
        'after it, do not translate it, and do not merge two of them into one ' +
        'name — a tag spelled any other way is not a tag the model knows.'
    );
  }

  if (unresolved.length) {
    lines.push(
      (lines.length ? 'Also: ' : '') +
        `these names could not be confirmed against danbooru: ${unresolved
          .map((u) => u.name)
          .join(', ')}. Do not invent hair colour, eye colour, or an outfit ` +
        'for them. Use only what the brief itself states and say so in your ' +
        'notes segment.'
    );
  }

  return lines.join('\n');
}

// ── Characters danbooru does not know ───────────────────────────────────────
//
// Asked for 19 Sep 2026: Powder the VTuber has no danbooru tag at all (the
// only `powder` characters are Arcane's), so the lookup has nothing to give
// and the model writes her from memory. `config/custom-characters.yaml` is the
// group's own list — a name, the words a brief may call them, and how they
// look — and it reaches the model the way danbooru canon does.
//
// Deliberately second to danbooru: a name danbooru resolved is not matched
// here, so "Powder from Arcane" still means Arcane's Powder, and "Powder
// streaming" means the one on the list.

/**
 * The listed characters a brief names.
 *
 * Multi-word names match as a phrase. A one-word name follows a user's rule the
 * resolver uses: if it is short or an ordinary danbooru tag (`powder` is), it
 * has to be written as a name — capitalised, or alone in its comma field.
 *
 * A `label` tells two characters of one name apart, the way danbooru writes
 * `powder_(arcane)`: "Powder (VTuber)". The owner's idea, 19 Sep 2026. The
 * labelled form is matched first and ALWAYS means this entry — "Powder
 * (VTuber)" or "powder vtuber" — even where plain "Powder" would be left to
 * danbooru. It is also the name the model reads, so it knows which Powder.
 *
 * @param brief     what the person typed
 * @param list      [{ name, label?, aliases?, trigger?, traits: [..] }]
 * @param tagStore  for the ordinary-word test; optional
 * @param taken     name grams danbooru already resolved, never re-matched
 * @returns [{ name, trigger, traits, matched }] — `name` carries the label
 */
export function findCustomCharacters(brief, list = [], tagStore = null, taken = []) {
  const norm = normalise(brief);
  const takenSet = new Set(taken.map((t) => normalise(t)));
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry?.name || !Array.isArray(entry.traits) || !entry.traits.length) continue;
    const label = entry.label ? String(entry.label).trim() : '';
    const shown = label ? `${entry.name} (${label})` : String(entry.name);
    const found = (raw, explicit) => {
      const phrase = normalise(raw);
      if (!phrase || !hasPhrase(norm, phrase)) return false;
      if (explicit) return true;
      if (takenSet.has(phrase)) return false;
      return phrase.includes(' ') || !tagStore || !needsCapital(phrase, tagStore) || writtenAsName(phrase, brief);
    };
    const hit = (label && found(`${entry.name} ${label}`, true) && `${entry.name} ${label}`)
      || [entry.name, ...(entry.aliases ?? [])].find((raw) => found(raw, false));
    if (hit) out.push({ name: shown, trigger: entry.trigger ?? null, traits: entry.traits.map(String), matched: hit });
  }
  return out;
}

/**
 * The block for listed characters, beside the danbooru one.
 *
 * Their traits are given as fact, like canon. They have no danbooru tag, so
 * the model is told not to invent one — a booru model reading `powder` would
 * draw the substance. If the group trained a LoRA for them, `trigger` is the
 * word to write, exactly.
 */
export function customCharacterBlock(entries, underscore = true) {
  if (!entries?.length) return '';
  const lines = [
    "Characters from this group's own list — they are not on danbooru, so " +
      'this is how the group describes them. Use these traits as facts and do ' +
      'not add remembered details of your own. They have no danbooru tag: do ' +
      'not invent one, and describe them with these traits instead, unless a ' +
      'trigger word is given, which must be written exactly.',
  ];
  for (const e of entries) {
    const traits = e.traits.map((t) => (underscore ? t.trim().replace(/ /g, '_') : t.trim().replace(/_/g, ' ')));
    lines.push(`  ${e.name}${e.trigger ? ` (trigger: ${e.trigger})` : ''} — ${traits.join(', ')}`);
  }
  return lines.join('\n');
}
