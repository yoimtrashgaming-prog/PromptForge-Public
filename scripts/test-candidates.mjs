// Turning a brief into real danbooru tags, before generation.
//
//   node scripts/test-candidates.mjs
//
// No server, no model, no GPU, no tag database — the store is a stub.
//
// Every case here is a failure this actually had during the hour it was
// written, on 30 Aug 2026, against the owner's own example brief. They are
// worth keeping because each one is silent: a candidate list with the wrong
// tags in it does not error, it just quietly makes the prompt worse, and the
// only symptom is a generated image with something in it nobody asked for.
//
//   1. A substring match for "reading" returns `spreading_own_pussy`, because
//      "reading" is inside "spreading". Word boundaries are the fix.
//   2. Matching on one word of a compound drags in the rest of it: "girl"
//      returns `horse_girl`, "standing" returns `standing_sex`. Requiring
//      every word of a tag to be in the brief is the fix.
//   3. "street" and "night" reach `street_fighter` and `fate/stay_night`,
//      which house-rules.md forbids adding. General tags only is the fix.
//   4. "field of flowers" must find `flower_field` — different word order, and
//      a stopword in the middle.

import { createCandidateFinder, forms, phrases } from '../server/candidates.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A tag store answering from a fixed table, keyed on the words asked for.
 *
 * The every-word rule and the category filter are the tool's job, not the
 * store's, so this returns whatever the table says and lets the assertions
 * find out whether candidates.mjs filtered it.
 */
function stubStore(table, { loaded = true } = {}) {
  const calls = [];
  return {
    calls,
    loaded,
    tagsWithTokens(words, opts) {
      calls.push({ words: [...words], opts });
      if (!loaded) return [];
      return (table[[...words].sort().join(' ')] ?? []).filter(
        (r) => !opts?.categories || opts.categories.includes(r.category ?? 0)
      );
    },
  };
}

const row = (tag, post_count, category = 0) => ({
  tag,
  post_count,
  category,
  category_name: category === 0 ? 'general' : category === 3 ? 'copyright' : 'character',
});

// ── the word helpers ─────────────────────────────────────────

check('a plural is tried alongside the word as typed', forms('flowers').includes('flower'));
check('...and the word as typed survives', forms('flowers').includes('flowers'),
  'danbooru writes `boots` and `twintails` plural, so stripping the s unconditionally loses them');
check('-ies becomes -y', forms('bodies').includes('body'));
check('-shes loses only the es', forms('dishes').includes('dish'));
check('a double s is left alone', !forms('dress').includes('dres'),
  'a real stemmer would do this; three rules and no dictionary must not');
check('short words are left alone', eq(forms('is'), ['is']));

check(
  'stopwords are dropped',
  eq(phrases('a girl in the rain'), [['girl', 'rain']])
);
check(
  'punctuation cuts a brief into separate phrases',
  eq(phrases('a girl, wet boots'), [['girl'], ['wet', 'boots']]),
  'the comma says those belong to different thoughts, so `girl wet` must never be a pair'
);
check('an empty brief yields nothing', eq(phrases(''), []));
check('a brief of pure stopwords yields nothing', eq(phrases('the a of and'), []));

// ── what reaches the prompt ──────────────────────────────────

{
  const store = stubStore({
    'field flower': [row('flower_field', 8766)],
    field: [row('field', 14162)],
    flower: [row('flower', 617843)],
  });
  const out = createCandidateFinder(store).find('a field of flowers');
  const found = out.results.map((r) => r.tag);
  check(
    'a phrase resolves to the tag danbooru actually spells it as',
    found.includes('flower_field'),
    '"field of flowers" and `flower_field` share no word order and have a stopword between them'
  );
  check('and the single words still come through', found.includes('field') && found.includes('flower'));
  check(
    'the phrase match is offered first',
    found[0] === 'flower_field',
    'a model reading top-down should meet the specific tag before the generic one'
  );
}

{
  const store = stubStore({ girl: [row('horse_girl', 114299), row('cat_girl', 88644)] });
  const out = createCandidateFinder(store).find('a girl');
  check(
    'a compound tag whose other words are not in the brief is refused',
    out.results.length === 0,
    'this is the horse_girl case — "girl" must not import a horse'
  );
}

{
  const store = stubStore({ standing: [row('standing', 896303), row('standing_sex', 13635)] });
  const out = createCandidateFinder(store).find('standing in the rain');
  check(
    'the exact tag survives the same rule',
    out.results.map((r) => r.tag).includes('standing')
  );
  check(
    'and its unasked-for compound does not',
    !out.results.map((r) => r.tag).includes('standing_sex'),
    'a wholesome brief must not have this arrive as a suggestion'
  );
}

{
  const store = stubStore({
    street: [row('street', 8359), row('street_fighter', 25144, 3)],
    night: [row('night', 115854)],
  });
  const out = createCandidateFinder(store).find('a street at night');
  check(
    'only general tags are asked for',
    store.calls.every((c) => eq(c.opts?.categories, [0])),
    'house-rules.md forbids adding a franchise the user did not mention, so offering ' +
      'street_fighter as a candidate puts the prompt file in conflict with its own input'
  );
  check('and the ordinary tags come through', out.results.map((r) => r.tag).includes('street'));
}

{
  const store = stubStore({ boots: [row('boots', 452633)] });
  const out = createCandidateFinder(store).find('BOOTS');
  check('case does not matter', out.results.map((r) => r.tag).includes('boots'));
}

{
  const store = stubStore({ boots: [row('boots', 452633)] });
  const out = createCandidateFinder(store).find('boots', { variant: 'space' });
  check(
    'a space-style model is given the spelling it writes',
    out.results[0]?.tag === 'boots'
  );
  const store2 = stubStore({ 'boots thigh': [row('thigh_boots', 89255)] });
  const spaced = createCandidateFinder(store2).find('thigh boots', { variant: 'space' });
  check(
    '...including on a multi-word tag',
    spaced.results[0]?.tag === 'thigh boots',
    'an underscore handed to pony is a spelling its prompt file says is wrong'
  );
}

{
  const store = stubStore({ boots: [row('boots', 1)] });
  createCandidateFinder(store, { min_post_count: 900 }).find('boots');
  check('the post-count floor reaches the store', store.calls[0]?.opts?.minPostCount === 900);
}

{
  const table = {};
  for (const w of ['aa', 'bb', 'cc', 'dd', 'ee']) table[w] = [row(w, 1000)];
  const out = createCandidateFinder(stubStore(table), { max_tags: 3 }).find('aa bb cc dd ee');
  check('the list is capped', out.results.length === 3, 'forty tags is a shortlist; four hundred is a dump');
}

{
  const store = stubStore({ boots: [row('boots', 452633)] });
  const out = createCandidateFinder(store).find('boots boots boots');
  check('a repeated word is offered once', out.results.length === 1);
}

// ── degrading ────────────────────────────────────────────────

{
  const out = createCandidateFinder(stubStore({}, { loaded: false })).find('boots');
  check(
    'no tag database means no candidates and a reason',
    out.ok === false && out.results.length === 0 && out.reason === 'no tag database',
    'a fresh checkout has no tags.sqlite until update-tags runs'
  );
  check(
    'and the block is empty rather than a heading with nothing under it',
    createCandidateFinder(stubStore({}, { loaded: false })).block('boots') === ''
  );
}

{
  const empty = createCandidateFinder(stubStore({})).block('xyzzy plugh');
  check('a brief that matches nothing produces no block', empty === '');
}

{
  const store = stubStore({ boots: [row('boots', 452633)] });
  const block = createCandidateFinder(store).block('boots');
  check('the block names the tag', block.includes('boots'));
  check('with its post count', block.includes('452,633'));
  check(
    'and says it is not the prompt and not a limit',
    /not the prompt and it is not a limit/i.test(block),
    'a model handed forty tags under a heading that reads like an order writes all forty'
  );
  check(
    'and that a missing tag means describe it, not drop it',
    /never a reason to drop it/i.test(block),
    "the owner's rule, 30 Aug 2026: if there is no tag for it, use the user's " +
      'input and expand on it. The same correction he made to the search tool, ' +
      'which had been answering an empty result with "do not write it"'
  );
  check(
    'and that expanding is still the job',
    /expand what the person wrote/i.test(block),
    'a list of the words they already typed reads as the finished vocabulary ' +
      'unless something says otherwise'
  );
  check(
    'and admits what it cannot know',
    /lighting/i.test(block),
    'it only knows the words that were typed; the model has to be told that or it ' +
      'will treat the list as the whole of what is available'
  );
}

// ── report ───────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} FAILED:`);
  for (const f of failures) console.log(`    FAIL  ${f}`);
  console.log('');
  console.log(`${failures.length} of ${passed + failures.length} FAILED`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
