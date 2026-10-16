// The booru tag search, as a tool the model calls.
//
//   node scripts/test-tools.mjs
//
// No server, no model, no GPU, no tag database — the store is a stub, so this
// runs on a fresh checkout that has never downloaded the danbooru lists.
//
// What is under test is the part that decides what the model is told. The
// whole reason tools exist here is that a 27B asked for a rainy street wrote
// `wet_boots, rainboots, rubber_boots` and only one of those is a tag; if this
// answers "no results" the same way it answers "the database is shut", the
// model has no way to tell "danbooru has no such tag" from "ask again later",
// and the feature is worse than nothing.
//
// Four things are load-bearing and each has a case below:
//
//   1. No tag database means NO TOOL OFFERED, not a tool that always fails.
//   2. A search that matches nothing says so plainly, and distinguishably from
//      a database that could not be read.
//   3. **The tool states facts and gives no instructions.** It used to answer
//      an empty search with "do not write it", and the owner stopped that on
//      30 Aug 2026 — danbooru having no entry is not the same as the words
//      doing nothing, and a post count cannot tell those apart. The policy
//      moved to prompts/_shared/tag-search.md. The assertions below are what
//      stop it drifting back into code.
//   4. Nothing here throws. A tool that throws inside the generation loop
//      takes down a request that was going fine.

import fs from 'node:fs';
import { createToolbox, toolArguments } from '../server/tools.mjs';
import { createGuidance } from '../server/guidance.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A tag store with a fixed answer, so the assertions are about the tool and
 * not about what danbooru happened to contain the day this ran.
 */
function stubStore(rowsByQuery, { loaded = true } = {}) {
  const calls = [];
  return {
    calls,
    loaded,
    lookup(query, opts) {
      calls.push({ query, opts });
      if (!loaded) return { ok: false, error: 'tag database not loaded', results: [] };
      return { ok: true, results: rowsByQuery[query] ?? [] };
    },
  };
}

const row = (tag, post_count, extra = {}) => ({
  tag,
  category: 0,
  category_name: 'general',
  post_count,
  deprecated: false,
  ...extra,
});

// ── what gets offered ────────────────────────────────────────

{
  const tb = createToolbox(stubStore({}));
  const defs = tb.definitions();
  check('one tool is offered', defs.length === 1);
  check('and it is search_tags', defs[0]?.function?.name === 'search_tags');
  const props = defs[0]?.function?.parameters?.properties ?? {};
  check('it takes a batch of queries', props.queries?.type === 'array');
  check('and a single query, for when one is all you want', props.query?.type === 'string');
  check(
    'neither is declared required',
    !defs[0]?.function?.parameters?.required?.length,
    'either one alone is a valid call, and run() explains itself when given neither'
  );
  check(
    'the batch is the one it is pushed towards',
    /ONE call/.test(defs[0]?.function?.description ?? ''),
    'six round trips to look up six words is what made a generation take 277s ' +
      'on the P40 — the searches are sqlite reads, the rounds are whole ' +
      'generations over a 7,500-token prompt'
  );
}

{
  const tb = createToolbox(stubStore({}, { loaded: false }));
  check(
    'no tag database means no tool offered at all',
    tb.definitions().length === 0 && tb.available === false,
    'a tool that always answers "unavailable" is worse than no tool'
  );
}

{
  const spaced = createToolbox(stubStore({})).definitions({ variant: 'space' });
  const under = createToolbox(stubStore({})).definitions({ variant: 'underscore' });
  check(
    'the example spelling follows the model tag style',
    spaced[0].function.description.includes('thigh boots') &&
      under[0].function.description.includes('thigh_boots'),
    'a space-style model shown thigh_boots copies the underscore into its prompt'
  );
}

// ── results ──────────────────────────────────────────────────

{
  const store = stubStore({ boots: [row('boots', 452633), row('thigh_boots', 89255)] });
  const out = createToolbox(store).run('search_tags', { query: 'boots' });
  check('a hit is ok', out.ok === true);
  check('the tag is named', out.content.includes('boots'));
  check(
    'with its post count, thousands separated',
    out.content.includes('452,633'),
    'the count is how the model tells a real tag from a technically-real one'
  );
}

{
  const store = stubStore({ wet_boots: [] });
  const out = createToolbox(store).run('search_tags', { query: 'wet_boots' });
  check(
    'nothing found reports the absence',
    /no danbooru tag contains/i.test(out.content) && out.content.includes('wet_boots')
  );
  check(
    'and says how far it looked, so the answer can be trusted',
    /searched every tag name/i.test(out.content)
  );
  check(
    'but gives NO instruction about writing it',
    !/do not write|must not|do not use|avoid/i.test(out.content),
    "the owner's call, 30 Aug 2026: an empty search is a fact about danbooru, " +
      'not a verdict on the words. `harsh lighting` has no entry and still ' +
      'reads; `wet_boots` has no entry and reads as nothing. A post count ' +
      'cannot tell those apart, so the tool must not pretend to — the policy ' +
      'lives in prompts/_shared/tag-search.md where it can be tuned'
  );
}

{
  const store = stubStore({ boots: [row('black_footwear', 15000, { deprecated: true })] });
  const out = createToolbox(store).run('search_tags', { query: 'boots' });
  check(
    'a retired tag comes back flagged, not dropped',
    out.content.includes('black_footwear') && /retired by danbooru/i.test(out.content),
    'a model told nothing about a retired tag writes it from memory anyway'
  );
  check(
    'and the flag states the fact rather than forbidding the tag',
    !/do not use|must not/i.test(out.content),
    'same rule as an empty result — what to do about a retirement is judgement'
  );
}

{
  const store = stubStore({}, { loaded: true });
  store.lookup = () => ({ ok: false, error: 'tag database is reloading', results: [] });
  const out = createToolbox(store).run('search_tags', { query: 'boots' });
  check(
    'a shut database is reported as unavailable, not as absent',
    /unavailable/i.test(out.content) && !/does not exist/i.test(out.content),
    '"come back later" and "that is not a tag" must not read the same'
  );
}

// ── the shapes a backend actually sends ──────────────────────

{
  const store = stubStore({ twintails: [row('twintails', 899847)] });
  const out = createToolbox(store).run('search_tags', '{"query":"twintails"}');
  check('arguments as a JSON string are parsed', out.ok && out.content.includes('twintails'));
}

{
  const store = stubStore({ twintails: [row('twintails', 899847)] });
  const out = createToolbox(store).run('search_tags', 'twintails');
  check(
    'a bare string is taken as the query',
    out.ok && out.content.includes('twintails'),
    'spending a round trip teaching a model the schema is worse than reading it'
  );
}

{
  const store = stubStore({ boots: [row('boots', 1)], raincoat: [row('raincoat', 2)] });
  const out = createToolbox(store).run('search_tags', { query: ['boots', 'raincoat'] });
  check(
    'an array of queries is answered rather than rejected',
    out.ok && out.content.includes('boots') && out.content.includes('raincoat')
  );
  check('and every query is reported back', out.queries?.length === 2);
}

{
  const store = stubStore({ boots: [row('boots', 1)] });
  createToolbox(store).run('search_tags', { query: 'boots', category: 'character' });
  check(
    'a category name becomes danbooru category 4',
    store.calls[0]?.opts?.category === 4
  );
}

{
  const store = stubStore({});
  const out = createToolbox(store).run('search_tags', { query: 'boots', category: 'nonsense' });
  check(
    'an unknown category is explained, not silently ignored',
    out.ok === false && out.content.includes('nonsense') && out.content.includes('general')
  );
}

{
  const store = stubStore({ boots: [row('boots', 1)] });
  createToolbox(store, { limit: 15 }).run('search_tags', { query: 'boots', limit: 500 });
  check('an absurd limit is capped', store.calls[0]?.opts?.limit <= 30);
  const store2 = stubStore({ boots: [row('boots', 1)] });
  createToolbox(store2, { limit: 15 }).run('search_tags', { query: 'boots' });
  check('and the default is the configured one', store2.calls[0]?.opts?.limit === 15);
}

{
  const store = stubStore({ boots: [row('boots', 1)] });
  createToolbox(store).run('search_tags', { query: 'boots' }, { variant: 'space' });
  check('the model tag style reaches the store', store.calls[0]?.opts?.variant === 'space');
}

// ── nothing throws ───────────────────────────────────────────

{
  const out = createToolbox(stubStore({})).run('web_search', { q: 'x' });
  check(
    'an unknown tool name is answered, not thrown',
    out.ok === false && out.content.includes('search_tags')
  );
}

{
  const out = createToolbox(stubStore({})).run('search_tags', {});
  check('a missing query is answered', out.ok === false && out.content.includes('query'));
}

{
  const out = createToolbox(stubStore({})).run('search_tags', { query: '   ' });
  check('a blank query is answered', out.ok === false);
}

{
  const store = stubStore({});
  store.lookup = () => {
    throw new Error('sqlite exploded');
  };
  const out = createToolbox(store).run('search_tags', { query: 'boots' });
  check(
    'a throwing store becomes a message, not a failed generation',
    out.ok === false && out.content.includes('sqlite exploded'),
    'the request was going fine until the tool ran'
  );
}

// ── report ───────────────────────────────────────────────────

console.log('');
// ── a degenerating model asks for thousands ──────────────────
//
// Measured on a live anima generation, 5 Sep 2026. One search_tags call whose
// query list started on the brief — "gaming chair, streaming, webcam" — and
// then free-associated through clothing, materials, weather, military and
// anatomy into cell biology and cardiology, before jamming on "actigraphy"
// repeated to the end of the list.
//
// Nothing capped it. Every query was looked up and every result was joined
// into a tool message that went straight back into the model's own context,
// which is how one bad call turned into minutes of wall time.
//
// The cap cannot stop a model degenerating. It stops the degeneration being
// expensive, which is the part this file is responsible for.
{
  const tb = createToolbox(stubStore({ long_hair: 100 }), { maxQueries: 5 });
  const runaway = Array.from({ length: 400 }, (_, i) => (i < 3 ? 'long hair' : 'actigraphy'));
  const out = tb.run('search_tags', JSON.stringify({ queries: runaway }), { variant: 'underscore' });

  check('a runaway call still answers rather than failing', out.ok === true, out.content);
  check('...running only up to the cap', out.queries.length === 5, String(out.queries.length));
  check('...and reporting how many it dropped', out.dropped === 395, String(out.dropped));
  check('...saying so in the content the model reads',
    /only the first 5 were run/.test(out.content), out.content.slice(-160));

  // The FIRST queries are the ones drawn from the brief; the list only wanders
  // later. Truncating from the front would throw away the useful half.
  check('the queries it keeps are the earliest ones',
    out.queries[0] === 'long hair' && out.queries[1] === 'long hair', JSON.stringify(out.queries));

  // An ordinary call must be untouched — 11 to 21 queries is normal here.
  const normal = createToolbox(stubStore({ long_hair: 100 }))
    .run('search_tags', JSON.stringify({ queries: ['long hair', 'blue eyes'] }), { variant: 'underscore' });
  check('an ordinary call is not truncated', normal.dropped === 0, String(normal.dropped));
  check('...and says nothing about truncation',
    !/were run/.test(normal.content), normal.content.slice(-120));
}

// ── how a tool receives its arguments ────────────────────────
//
// Reported 5 Sep 2026 as "read_guidance (failed)" three times in one log, with
// no successes ever recorded. The cause was not in guidance.mjs's logic: the
// backend hands tool arguments over as a JSON STRING — llm.mjs normalises both
// the native and the OpenAI shapes to that deliberately — and the parser that
// turned it back into an object lived INSIDE createToolbox. So search_tags
// parsed its arguments and read_guidance read `args?.name` straight off a
// string, got undefined, and answered "needs a document name" to every call it
// ever received. It cost a tool round each time and returned nothing.
//
// toolArguments is exported now and both tools use it, which is the part that
// stops the two drifting apart again.
{
  check('a JSON string parses to its object',
    toolArguments(JSON.stringify({ name: 'visual-direction' })).name === 'visual-direction');
  check('an object is passed through',
    toolArguments({ name: 'x' }).name === 'x');
  check('an unparseable string is handed back for the caller to interpret',
    toolArguments('visual-direction').__text === 'visual-direction');
  check('a non-string, non-object is an empty object',
    Object.keys(toolArguments(undefined)).length === 0);

  // The search's own reading of a bare string must survive the extraction.
  const bare = createToolbox(stubStore({})).run('search_tags', 'long hair', { variant: 'underscore' });
  check('search_tags still reads a bare string as the query', bare.ok === true);

  // And the same string shape must now work for the other tool. A stub model
  // with one document, so this needs no registry and no real file.
  const doc = 'scripts/__guidance_probe.md';
  fs.writeFileSync(doc, 'probe body', 'utf8');
  try {
    const guidance = createGuidance(process.cwd(), { warn: () => {} });
    const model = { key: 'probe', guidance: { 'probe-doc': { path: doc, about: 'a probe' } } };

    for (const [label, args] of [
      ['a JSON string', JSON.stringify({ name: 'probe-doc' })],
      ['a plain object', { name: 'probe-doc' }],
      ['the field called document', JSON.stringify({ document: 'probe-doc' })],
      ['a bare string', 'probe-doc'],
    ]) {
      const out = guidance.run(model, args);
      check(`read_guidance opens a document given ${label}`,
        out.ok === true && out.document === 'probe-doc', String(out.content).slice(0, 70));
    }

    // Real failures must stay failures, and must say what IS available —
    // "failed" on its own is what made this take a log and a bisect to find.
    const unknown = guidance.run(model, JSON.stringify({ name: 'nope' }));
    check('an unknown document still fails', unknown.ok === false);
    check('...and names what it could have opened',
      unknown.content.includes('probe-doc'), unknown.content);

    const empty = guidance.run(model, JSON.stringify({}));
    check('no name at all still fails', empty.ok === false);
    check('...and names what it could have opened',
      empty.content.includes('probe-doc'), empty.content);
  } finally {
    fs.rmSync(doc, { force: true });
  }
}

if (failures.length) {
  console.log(`  ${failures.length} FAILED:`);
  for (const f of failures) console.log(`    FAIL  ${f}`);
  console.log('');
  console.log(`${failures.length} of ${passed + failures.length} FAILED`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
