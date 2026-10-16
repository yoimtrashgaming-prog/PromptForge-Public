// The third pass: every tag the model wrote, checked after generation.
//
//   node scripts/test-tagpass.mjs
//
// No server, no model. The database and the lexicon are stubs, so what is
// under test is the pass itself; the real lexicon's resolver is covered in
// test-lexicon.mjs. The headline cases are a user's, from 13 Sep 2026: v4 wrote
// `lowered pants`, which should have become `pants pull`, and `blue dress
// gathered around waist` "never worked".

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagPass, splitLabelled, loadModifierVocabulary } from '../server/tagpass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

// The only tags that exist, in the database's underscore form.
const REAL = new Set([
  '1girl', 'solo', 'pants_pull', 'blue_dress', 'crossed_arms', 'from_above',
  'depth_of_field', 'white_hair', '2b_(nier:automata)', 'nier:automata',
]);
const known = (t) => REAL.has(String(t).trim().toLowerCase().replace(/\s+/g, '_'));

// What the lexicon would say.
const MAP = {
  'lowered pants': 'pants_pull',
  'trousers down': 'pants_pull',
  'arms folded': 'crossed_arms',
  'high-angle shot': 'from_above',
};
const resolve = (p) => (MAP[p.trim().toLowerCase()] ? { tag: MAP[p.trim().toLowerCase()] } : null);

const BASE = {
  known,
  resolve,
  allowed: ['masterpiece', 'best quality', 'safe'],
  variant: 'space',
};

// ── a user's case, on a labelled v5 prompt ─────────────────────
{
  const out = tagPass(
    [
      'Core tags: masterpiece, best quality, score_7, safe, 1girl, solo, lowered pants, blue dress gathered around waist, blue dress, pants pull',
      'Text modifiers: cinematic lighting, warm lamplight',
      'Description: She stands by the window, her dress gathered at the waist.',
    ].join('\n'),
    BASE
  );
  const t = out.text;
  check('labelled is recognised', out.labelled);
  check('lowered pants is replaced', !t.includes('lowered pants') && out.replaced.includes('lowered pants → pants pull'), t);
  check('and the replacement is not doubled by the real one', t.split('pants pull').length === 2, t);
  check('a fake compound on the tag line is removed', !t.includes('blue dress gathered around waist'), t);
  check('and reported', out.dropped.includes('blue dress gathered around waist'));
  check('the real tag beside it stays', t.includes('blue dress,'), t);
  check('quality words and score_7 stay', t.startsWith('masterpiece, best quality, score_7, safe'), t);
  check('modifiers are never checked', t.includes('cinematic lighting, warm lamplight'), t);
  check('the description ends the line, untouched', t.endsWith('She stands by the window, her dress gathered at the waist.'), t);
  check('no labels survive', !/core tags|text modifiers|description:/i.test(t), t);
}

// ── one list: replace, never remove ──────────────────────────
{
  const text = 'masterpiece, 1girl, lowered pants, warm lamplight, cinematic lighting, She walks home under a streetlamp while the rain comes down.';
  const out = tagPass(text, BASE);
  check('one list: lowered pants is replaced', out.text.includes('pants pull') && !out.text.includes('lowered pants'), out.text);
  check('one list: an unknown modifier is kept', out.text.includes('warm lamplight'), out.text);
  check('one list: nothing is removed', out.dropped.length === 0);
  check('one list: the prose is untouched', out.text.endsWith('She walks home under a streetlamp while the rain comes down.'), out.text);
}
{
  const text = 'masterpiece,  1girl, solo, warm lamplight,  She walks.';
  check('nothing to replace: the text comes back byte for byte', tagPass(text, BASE).text === text);
}
{
  const out = tagPass('1girl, high-angle shot, solo', { ...BASE, modifiers: new Set(['high angle shot']) });
  check("a user's listed modifiers are never remapped on one list", out.text === '1girl, high-angle shot, solo', out.text);
}

// ── what must never be harmed ────────────────────────────────
{
  const out = tagPass('Core tags: 1girl, lowered pants\nDescription: x.', { ...BASE, spared: ['lowered pants'] });
  check('a tag the person typed is never replaced or removed', out.text.includes('lowered pants'), out.text);
}
{
  const out = tagPass('Core tags: 1girl, (lowered pants:2), (solo:1.5)\nDescription: x.', BASE);
  check('a weight survives replacement', out.text.includes('(pants pull:2)'), out.text);
  check('a weighted real tag is kept as written', out.text.includes('(solo:1.5)'), out.text);
}
{
  const out = tagPass('Core tags: 1girl, 2b \\(nier:automata\\), nier:automata, @big chungus, year 2025\nDescription: x.', BASE);
  check('an escaped character tag is real', out.text.includes('2b \\(nier:automata\\)'), out.text);
  check('an @artist and a year tag pass', out.text.includes('@big chungus') && out.text.includes('year 2025'), out.text);
  check('nothing dropped among them', out.dropped.length === 0, out.dropped.join(', '));
}
{
  const out = tagPass('Core tags: 1girl, made up tag\nText modifiers: soft glow\nDescription: She waits.', { ...BASE, known: null });
  check('no database: nothing is removed', out.text.includes('made up tag'), out.text);
  check('no database: the labels are still joined', out.text === '1girl, made up tag, soft glow, She waits.', out.text);
}
{
  const out = tagPass('Core tags: 1girl, lowered pants\nDescription: x.', { ...BASE, variant: 'underscore' });
  check('underscore style spells the replacement with underscores', out.text.includes('pants_pull'), out.text);
}
{
  const out = tagPass('Core tags: 1girl, (fake thing:2)\nDescription: x.', BASE);
  check('a weighted fake is removed like any other', !out.text.includes('fake thing'), out.text);
}
{
  const out = tagPass('Core tags: 1girl, depth of field\nText modifiers: depth of field, creamy bokeh\nDescription: x.', BASE);
  check('a modifier repeating a tag goes', out.text === '1girl, depth of field, creamy bokeh, x.', out.text);
}

{
  // Measured 13 Sep 2026 on the P40: `three-quarter view`, one of a user's own
  // modifiers, written on the tag line and deleted there.
  const out = tagPass('Core tags: 1girl, three-quarter view, fake thing\nText modifiers: soft glow\nDescription: x.', {
    ...BASE,
    modifiers: new Set(['three quarter view']),
  });
  check('a listed modifier on the tag line is moved, not removed', out.text === '1girl, three-quarter view, soft glow, x.', out.text);
  check('and reported as moved', out.moved.includes('three-quarter view') && !out.dropped.includes('three-quarter view'));
  check('while a real fake beside it still goes', out.dropped.includes('fake thing'));
}

// ── the label parser ─────────────────────────────────────────
{
  const p = splitLabelled('**Core tags:** 1girl, solo\n**Text modifiers:** soft glow\n**Description:** She waits.\nStill waiting.');
  check('markdown-wrapped labels parse', p && p.tags === '1girl, solo' && p.modifiers === 'soft glow', JSON.stringify(p));
  check('a description over two lines is one paragraph', p?.description === 'She waits. Still waiting.', p?.description);
  check('no labels is not labelled', splitLabelled('1girl, solo, She waits.') === null);
}

// ── a user's vocabulary, read from his document ────────────────
{
  const words = loadModifierVocabulary(ROOT, 'prompts/image/references/anima-skill/references/visual-direction-compact.md');
  check('the modifier list is read', words.size > 100, String(words.size));
  check('it holds his modifiers', words.has('cinematic lighting') && words.has('warm highlights and cool shadows') && words.has('shallow depth of field'));
  check('and not his native tags', !words.has('depth of field') && !words.has('from above'));
  check('a missing document is an empty list', loadModifierVocabulary(ROOT, 'nope.md').size === 0);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
