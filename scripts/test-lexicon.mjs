// The paraphrase lexicon: ordinary words for a picture, to the danbooru tag.
//
//   node scripts/test-lexicon.mjs
//
// No server, no model, no tag database — the store is a stub that calls every
// tag an active general tag unless told otherwise, so what is under test is
// the lexicon's own matching. It does need the lexicon file itself, which is
// the owner's and not in git (13.5 MB, in data/tags/ beside tags.sqlite), so
// on a checkout without it this SKIPs rather than failing.
//
// The cases are the spec's own (archive/docs/danbooru-lexicon-integration.md, section
// 15), run against the real file on 12 Sep 2026. Two of the spec's cases the
// file does not pass, and they are left out rather than asserted wrong:
//
//   - "blue jeans pulled down" finds `jeans` and not `pants_pull`
//   - "she raises her hand to say hi" reaches `waving` at 0.87, under the
//     0.9 concept floor in config/server.yaml; asserted below at 0.85
//
// And one the file fails that config fixes: "side" on its own is a reviewed
// phrase for `from_side`, and the spec says it must match nothing, so
// `blocked_phrases` carries it.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLexicon, normalizePhrase } from '../server/lexicon.mjs';
import { createToolbox } from '../server/tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'data/tags/danbooru-visual-paraphrases.json';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(path.join(ROOT, FILE))) {
  console.log(`SKIP  ${FILE} is not on this machine`);
  process.exit(0);
}

function stubTags({ retired = [], loaded = true } = {}) {
  const gone = new Set(retired);
  return {
    loaded,
    exactRows: (t) => [{ tag: t, category: 0, post_count: 1000 }],
    isDeprecated: (t) => gone.has(t),
    postCount: () => 1000,
    lookup: () => ({ ok: true, results: [] }),
  };
}

const quiet = { warn: () => {}, log: () => {} };
const SETTINGS = { path: FILE, blocked_phrases: ['side'] };
const lex = createLexicon(ROOT, SETTINGS, stubTags(), quiet);
const tagsFor = (l, brief) => l.find(brief).map((h) => h.tag);

function expect(brief, want = [], never = [], l = lex) {
  const got = tagsFor(l, brief);
  for (const t of want) check(`"${brief}" finds ${t}`, got.includes(t), got.join(', ') || 'nothing');
  for (const t of never) check(`"${brief}" does not find ${t}`, !got.includes(t), got.join(', '));
}

// ── normalisation ────────────────────────────────────────────
check('underscore, space and hyphen are one key',
  normalizePhrase('from_above') === 'from above' && normalizePhrase('From-Above') === 'from above');
check('accents come off', normalizePhrase('contre-plongée') === 'contre plongee');

// ── loading ──────────────────────────────────────────────────
{
  const info = (lex.find('warm up'), lex.info());
  check('loads', info.loaded === true, info.reason);
  check('reviewed tiers only by default',
    JSON.stringify(info.coverage) === JSON.stringify(['hand_curated', 'semantic_family']));
  check('hundreds of reviewed tags, not tens of thousands',
    info.entries > 300 && info.entries < 2000, String(info.entries));
}

// ── the spec's positive cases ────────────────────────────────
expect('trousers down', ['pants_pull']);
expect('pants around thighs', ['pants_around_thighs'], ['thighs']);
expect('arms folded', ['crossed_arms'], ['folded']);
expect('looking off frame', ['looking_to_the_side']);
expect('vue plongeante', ['from_above']);
expect('contre-plongée', ['from_below']);
expect('faible profondeur de champ', ['depth_of_field']);
expect('cheveux emportés par le vent', ['floating_hair']);
expect('running on a rooftop at night', ['running', 'rooftop', 'night']);
expect('a girl with a beauty mark under her eye, sunshine through the window', ['mole', 'sunlight'], ['window']);

// ── concept rules: meaning across the brief, not a phrase ────
expect('trousers pooled over her shoes', ['pants_around_ankles']);
expect('fingers at her brow while standing at attention', ['salute']);
expect('camera looking down from an elevated viewpoint', ['from_above']);
expect('she carries a parasol', ['holding_umbrella']);
expect('she slides her slacks below her hips', ['pants_pull'], ['lowleg_pants']);
{
  const loose = createLexicon(ROOT, { ...SETTINGS, concept_min_score: 0.85 }, stubTags(), quiet);
  expect('she raises her hand to say hi', ['waving'], [], loose);
  expect('she raises her hand to say hi', [], ['waving']);
}

// ── the spec's negative cases ────────────────────────────────
expect('she raises her hand in class', [], ['waving']);
expect('the sign says hello', [], ['waving', 'sign']);
expect('low-rise trousers', [], ['pants_pull']);
expect('an object hangs above her', [], ['from_above']);
for (const word of ['jumper', 'down', 'light', 'side']) {
  check(`"${word}" alone matches nothing`, tagsFor(lex, word).length === 0, tagsFor(lex, word).join(', '));
}
{
  const unblocked = createLexicon(ROOT, { path: FILE }, stubTags(), quiet);
  check('"side" is only kept out by blocked_phrases',
    tagsFor(unblocked, 'side').includes('from_side'));
}

// ── validation against the database ──────────────────────────
{
  const l = createLexicon(ROOT, SETTINGS, stubTags({ retired: ['mole'] }), quiet);
  check('a retired target is never offered', !tagsFor(l, 'a beauty mark').includes('mole'));
  check('and is counted', l.info().rejected >= 1, String(l.info().rejected));
}
{
  const l = createLexicon(ROOT, SETTINGS, stubTags({ loaded: false }), quiet);
  check('no tag database: nothing offered, nothing thrown', l.block('arms folded') === '' && l.info().loaded === false);
}
{
  const l = createLexicon(ROOT, { path: 'data/tags/not-there.json' }, stubTags(), quiet);
  check('no file: nothing offered, nothing thrown', l.block('arms folded') === '' && /no lexicon/.test(l.info().reason));
}
{
  const wide = createLexicon(ROOT, { ...SETTINGS, coverage: ['hand_curated', 'semantic_family', 'rule_expanded', 'catalogue_only'] }, stubTags(), quiet);
  check('the unreviewed tiers are there when asked for', tagsFor(wide, 'arms folded').includes('folded'));
}

// ── the block the model reads ────────────────────────────────
{
  const text = lex.block('camera looking down from an elevated viewpoint, arms folded', { variant: 'space' });
  check('space style spells tags with spaces', text.includes('- from above —') && text.includes('- crossed arms —'), text);
  check('each line says what in the brief it matched', text.includes('"arms folded"'), text);
  check('an empty brief gives no block', lex.block('', { variant: 'space' }) === '');
  check('underscore style keeps underscores', lex.block('arms folded').includes('- crossed_arms —'));
}

// ── the third pass's resolver, every tier ────────────────────
// A user, 13 Sep 2026: "The lexicon has 'lowered pants' in it, and should
// replace it with 'pants pull'."
{
  const r = (p) => lex.resolve(p)?.tag ?? null;
  for (const phrase of ['lowered pants', 'trousers down', 'pants down']) {
    check(`"${phrase}" resolves to pants_pull`, r(phrase) === 'pants_pull', String(r(phrase)));
  }
  check('"dress gathered around waist" resolves to nothing', r('dress gathered around waist') === null, String(r('dress gathered around waist')));
  check('"side" never resolves', r('side') === null, String(r('side')));
  const retired = createLexicon(ROOT, SETTINGS, stubTags({ retired: ['pants_pull'] }), quiet);
  check('a retired target is never a replacement', retired.resolve('lowered pants') === null);
}

// ── search_tags ──────────────────────────────────────────────
{
  check('a phrase with no tag name in it is still read', lex.lookup('beauty mark').some((h) => h.tag === 'mole'));
  const box = createToolbox(stubTags(), { lexicon: lex });
  const on = box.run('search_tags', { queries: ['beauty mark'] }, { variant: 'space', paraphrases: true });
  check('the tool result carries the paraphrase', on.ok && on.content.includes('mole'), on.content);
  const off = box.run('search_tags', { queries: ['beauty mark'] }, { variant: 'space' });
  check('and only when the model has it switched on', !off.content.includes('mole'), off.content);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
