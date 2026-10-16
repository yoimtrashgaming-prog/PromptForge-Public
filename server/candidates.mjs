// The brief, turned into a list of real danbooru tags, before generation.
//
// The owner's idea, 30 Aug 2026, put as a question about whether it was a good
// one: "user inserts a prompt, AI sees that prompt runs a script through all
// the booru tags, takes those tags and then uses those tags to generate a
// prompt." It is a good one, and this is it.
//
// **Why it beats the tool on this hardware.** server/tools.mjs lets the model
// ask the database whatever it likes, which is strictly more capable and costs
// a full generation per round — measured on the P40, six rounds took 277
// seconds against 84 for the same brief with no tools. This costs zero
// generations. It is a sqlite read before the first token. On a Pascal card
// that difference decides the feature.
//
// It also works on models with no tool calling at all, which is the whole of
// `hf.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED:Q4_K_M` and any future backend
// that does not implement the API.
//
// **What it cannot do, and the tool can.** This only knows the words the
// person typed. A brief reading "frieren sitting in a field of flowers
// reading a book" contains no lighting word, so nothing here will ever surface
// `dappled_sunlight` — where the model, given a search tool, went and looked
// for lighting unprompted and came back with `neon_lights` and `wet_ground`.
// A script checks; the tool reaches. The two are not the same feature and this
// file does not pretend to replace the other one.
//
// Character names are deliberately NOT this module's job. server/character.mjs
// already resolves them and looks up canonical traits from danbooru, and has
// since before this existed — a second opinion on who Frieren is, arriving in
// the same prompt from a different code path, is how two subsystems disagree
// in front of a model.

/**
 * Words that carry no tag. Function words, and the handful of verbs a brief
 * uses to glue a scene together.
 *
 * Deliberately short. Every word removed here is a tag that can never be
 * found, and the token index is precise enough that an ordinary noun costs
 * little — the failure this list prevents is `a` and `of` matching thousands
 * of tags, not a general war on common words.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'into', 'onto', 'over', 'under', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'there', 'here', 'her', 'his', 'their', 'them', 'they',
  'she', 'he', 'him', 'you', 'your', 'my', 'me', 'we', 'our', 'while',
  'very', 'some', 'more', 'most', 'also', 'then', 'than', 'so', 'such',
]);

/**
 * A word and the singular it might be.
 *
 * Danbooru files most things singular — `flower`, `boot` — but not all of
 * them: `boots`, `twintails` and `thighhighs` are the real tag names. So both
 * forms are tried and whichever the database actually has wins, rather than
 * this guessing which convention applies to a given noun.
 *
 * Three rules and no dictionary. A stemmer would turn `dress` into `dres`.
 */
export function forms(word) {
  const w = String(word ?? '').toLowerCase();
  const out = new Set([w]);
  if (w.length > 3 && w.endsWith('ies')) out.add(w.slice(0, -3) + 'y');
  if (w.length > 3 && /(ches|shes|sses|xes|zes)$/.test(w)) out.add(w.slice(0, -2));
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
  return [...out];
}

/**
 * The words of a brief, in order, minus the ones that cannot be tags.
 *
 * Punctuation splits phrases as well as separating them: "a girl, wet boots"
 * must not produce the pair `girl wet`, because the comma says they belong to
 * different thoughts. So the brief is cut on punctuation first and each piece
 * is tokenised separately, and n-grams never cross a cut.
 */
export function phrases(brief) {
  return String(brief ?? '')
    .toLowerCase()
    .split(/[,.;:!?()[\]{}"\n]+/)
    .map((piece) =>
      piece
        .split(/[^a-z0-9'-]+/)
        .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
        .filter((w) => w && !STOPWORDS.has(w))
    )
    .filter((words) => words.length);
}

export function createCandidateFinder(tags, settings = {}) {
  const maxTags = settings.max_tags ?? 40;
  const perPhrase = settings.per_phrase ?? 3;
  const minPostCount = settings.min_post_count ?? 500;
  const maxGram = settings.max_gram ?? 3;

  /**
   * Candidate tags for a brief, most specific match first.
   *
   * Longer n-grams are tried before shorter ones and claim their tags first,
   * so "field of flowers" resolves to `flower_field` and the single word
   * `field` does not then also drag in `field_of_blades`. A tag already found
   * by a longer phrase is never offered again under a shorter one.
   */
  function find(brief, { variant = 'underscore' } = {}) {
    if (!tags?.loaded) return { ok: false, results: [], reason: 'no tag database' };

    const seen = new Set();
    const results = [];

    // Every word the brief contains, in every spelling we would look up.
    //
    // **A tag qualifies only if all of its words are in here.** Without that
    // rule, matching on one word drags in whatever compound is popular:
    // measured 30 Aug 2026, "girl" returned `horse_girl`, `cat_girl` and
    // `demon_girl`; "standing" returned `standing_sex`; "tall" returned
    // `tall_grass` and `tall_hair`. Each of those adds a concept the person
    // never asked for, to a list the model is being told is what they asked
    // for.
    //
    // The cost is real and worth stating: it also drops `thigh_boots` for a
    // brief that only said "boots", and `open_book` for one that only said
    // "book". Those are good suggestions. But suggesting is the thing a script
    // keyed on the person's own words cannot do safely — it has no way to tell
    // `open_book` from `horse_girl`, because both are one word away. What this
    // does well is spell what they DID say the way danbooru spells it, and
    // `flower_field` for "field of flowers" is that job done.
    const vocabulary = new Set();
    for (const words of phrases(brief)) {
      for (const w of words) for (const form of forms(w)) vocabulary.add(form);
    }

    for (const words of phrases(brief)) {
      for (let n = Math.min(maxGram, words.length); n >= 1; n--) {
        for (let i = 0; i + n <= words.length; i++) {
          if (results.length >= maxTags) break;
          const gram = words.slice(i, i + n);

          // Every combination of singular and plural for this n-gram. One word
          // gives at most two lookups; three words give at most eight, and the
          // index makes each of them a map read.
          const tried = new Set();
          let found = 0;
          for (const combo of expand(gram.map(forms))) {
            const key = combo.join(' ');
            if (tried.has(key)) continue;
            tried.add(key);
            for (const row of tags.tagsWithTokens(combo, {
              limit: perPhrase,
              minPostCount,
              // General tags only. **Not a tidiness call.** Measured 30 Aug
              // 2026 on the rain brief, this pool contained `street_fighter`,
              // `street_fighter_6`, `fate/stay_night` and `summon_night` —
              // franchises reached by the words "street" and "night" — and on
              // the shrine brief `mountain_(arknights)` and `sun_wukong`.
              // house-rules.md forbids adding "a character, franchise, or
              // artist the user did not mention", so offering them as
              // candidates puts the prompt file and its own input in direct
              // conflict. Character names are already resolved properly by
              // server/character.mjs, which checks post counts and pulls
              // canonical traits rather than matching a word.
              categories: [0],
            })) {
              if (seen.has(row.tag) || found >= perPhrase) continue;
              const parts = row.tag.split('_').filter(Boolean);
              if (!parts.every((p) => vocabulary.has(p))) continue;
              seen.add(row.tag);
              found += 1;
              results.push({
                ...row,
                tag: variant === 'space' ? row.tag.replace(/_/g, ' ') : row.tag,
                matched: gram.join(' '),
              });
            }
          }
        }
      }
    }

    return { ok: true, results: results.slice(0, maxTags), reason: null };
  }

  /**
   * The block that goes into the user message, or '' when there is nothing
   * worth saying.
   *
   * Presented as a shortlist and explicitly not as an instruction to use all
   * of them. A model handed forty tags under a heading that reads like a
   * requirement will write all forty, which is the runaway this project has
   * already measured once from a different cause.
   */
  function block(brief, { variant = 'underscore' } = {}) {
    const { ok, results } = find(brief, { variant });
    if (!ok || !results.length) return '';
    const lines = results.map(
      (r) => `- ${r.tag} (${r.post_count.toLocaleString('en-GB')} posts)`
    );
    return (
      'Danbooru spells some of this brief differently than the person did. ' +
      'These are the real tag names for the words they used, looked up in the ' +
      'database rather than recalled — the number is how many posts use each ' +
      'one, so a high count is a name this model was trained on:\n' +
      lines.join('\n') +
      '\n\n**This list is a spelling aid. It is not the prompt and it is not a ' +
      'limit.** Your job is still to expand what the person wrote into ' +
      'something fuller than they typed, as far as the Creativity control ' +
      'above allows. Use these names where they fit; where ' +
      'the list has nothing for what you mean, write it in your own words and ' +
      'keep going. A real tag is stronger where one exists, and the absence of ' +
      'one is a reason to describe the thing, never a reason to drop it.\n\n' +
      'The list only contains words the person actually typed. Everything else ' +
      'a good prompt needs — lighting, framing, mood, composition, the detail ' +
      'they did not think to mention — is absent from it and is still yours to ' +
      'add.'
    );
  }

  return { find, block };
}

/** Cartesian product of per-word spelling options. */
function expand(optionsPerWord) {
  let out = [[]];
  for (const options of optionsPerWord) {
    const next = [];
    for (const prefix of out) for (const o of options) next.push([...prefix, o]);
    out = next;
  }
  return out;
}
