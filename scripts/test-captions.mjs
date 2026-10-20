// LoRA caption rules — server/captions.mjs.
//
// The trigger word, "Don't include", tag spelling and MOSS's JSON are applied
// in code after the model answers, so they hold whatever the model did. These
// are the cases that would otherwise only show up as a bad .txt in somebody's
// dataset: a doubled trigger, an excluded tag that slipped through, a quality
// tag the prompt said not to write, underscores in an Anima caption.
//
// Pure functions against the real config/captions.yaml. No model, no server.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadCaptionStyles, loadLoraTypes, captionInstructions, publicStyles, finishCaption, parseExclude, captionRequest, closestTag } from '../server/captions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const throws = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const styles = loadCaptionStyles(ROOT);
const S = Object.fromEntries(styles.map((s) => [s.id, s]));

for (const id of ['illustrious', 'anima', 'krea2', 'moss']) {
  check(`${id} is configured`, Boolean(S[id]));
  check(`${id} prompt file exists`, Boolean(S[id]) && existsSync(path.join(ROOT, 'prompts', S[id].prompt)), S[id]?.prompt);
}
check('public styles carry no prompt path', publicStyles(styles).every((s) => !('prompt' in s)));

// Illustrious: trigger first once, excludes and quality tags out, spaces.
{
  const r = finishCaption(S.illustrious,
    'mychar_v1, 1girl, long_hair, Red Hair, masterpiece, best quality, smile, smile, nozomi_(blue_archive), newest',
    { trigger: 'mychar_v1', exclude: parseExclude('red_hair\ngreen eyes') });
  check('illustrious: trigger once, first', r.caption.startsWith('mychar_v1, ') && r.caption.split('mychar_v1').length === 2, r.caption);
  check('illustrious: excluded tag removed across spelling', !/red hair/.test(r.caption), r.caption);
  check('illustrious: quality and year tags removed', !/masterpiece|best quality|newest/.test(r.caption), r.caption);
  check('illustrious: underscores become spaces', /long hair/.test(r.caption) && /nozomi \(blue archive\)/.test(r.caption), r.caption);
  check('illustrious: duplicates collapse', r.caption.split('smile').length === 2, r.caption);
}

// Anima, the shape this app's own Anima prompter writes: tags, then prose, on
// one line. Tag rules on the tag half only; the @ only for a style trigger.
{
  const raw = 'safe, 1girl, long_hair, score_7, 2b \\(nier:automata\\), smiling\n\nShe stands in a flooded hall. Light falls from the left.';
  const c = finishCaption(S.anima, raw, { trigger: 'mychar', exclude: ['long hair'], type: 'character' });
  check('anima: "trigger, tags, Prose." on one line',
    c.caption === 'mychar, safe, 1girl, 2b (nier:automata), smiling, She stands in a flooded hall. Light falls from the left.', c.caption);
  check('anima: score tag dropped, exclude applied', c.dropped.includes('score_7') && c.dropped.includes('long hair'), c.dropped.join(','));
  const s = finishCaption(S.anima, 'safe, 1girl\n\nA girl stands.', { trigger: 'greg rutkowski', type: 'style' });
  check('anima style: @ added to the trigger', s.caption.startsWith('@greg rutkowski, safe, 1girl, '), s.caption);
  const n = finishCaption(S.anima, 'safe, 1girl, smile, She stands in a hall, one hand raised, and smiles.', { type: 'character' });
  check('anima: no blank line, prose still kept whole',
    n.caption === 'safe, 1girl, smile, She stands in a hall, one hand raised, and smiles.' && !n.tags.some((t) => /hand raised/.test(t)), JSON.stringify(n));
}

// Krea 2, the way Krea's own LoRAs do it: the trigger at the end - after a
// comma with the last full stop dropped for a style, after a space otherwise.
{
  const raw = 'A deer grazes in a forest clearing. Tall pines stand behind it.';
  const s = finishCaption(S.krea2, raw, { trigger: 'art deco watercolor style', type: 'style' });
  check('krea2 style: ", trigger" at the end', s.caption === 'A deer grazes in a forest clearing. Tall pines stand behind it, art deco watercolor style', s.caption);
  const o = finishCaption(S.krea2, 'A cup sits on a wooden table.', { trigger: 'b3rcup', type: 'object' });
  check('krea2 object: " trigger" at the end', o.caption === 'A cup sits on a wooden table. b3rcup', o.caption);
  const d = finishCaption(S.krea2, '"A cup sits on a table, b3rcup"', { trigger: 'b3rcup', type: 'object' });
  check('krea2: a trigger the model wrote at the end is not doubled', d.caption === 'A cup sits on a table b3rcup', d.caption);
}

// Visible text the model copied into the tag line is dropped from the tags.
{
  const r = finishCaption(S.anima, 'safe, 1girl, "promptforge", anvil\n\nThe anvil reads "PromptForge".', {});
  check('quoted text is not a tag', !r.tags.some((t) => t.includes('promptforge')) && /reads "PromptForge"/.test(r.caption), r.caption);
}

// A trigger that is an ordinary word only goes when it stands apart.
{
  const k = finishCaption(S.krea2, 'A cat sits beside a girl.', { trigger: 'girl', type: 'object' });
  check('trigger as a plain word: the caption keeps its last word', k.caption === 'A cat sits beside a girl. girl', k.caption);
  const s = finishCaption(S.krea2, 'A cat sits on a mat, girl', { trigger: 'girl', type: 'style' });
  check('...but a trailing ", trigger" the model added is still removed', s.caption === 'A cat sits on a mat, girl', s.caption);
}

// A style's own non-danbooru tags are neither looked up nor reported.
const META = { kind: 'tags', tag_spelling: 'spaces', meta_tags: ['safe'] };

// Closest real tag: rename, then the other number, then drop words from the
// front to a COMMON tag. A fake database, so each step is pinned.
{
  const POSTS = { smile: 1e6, indoors: 5e5, side_ponytail: 2e5, log: 3000, metal: 40, '1girl': 1e7 };
  const ALIAS = { smiling: 'smile' };
  const db = { postCount: (t) => POSTS[t] ?? 0, aliasTarget: (t) => ALIAS[t] ?? null };
  const c = (t) => closestTag(t, db);
  check('closest: a real tag is left alone', c('1girl') === null);
  check('closest: danbooru rename first', c('smiling')?.tag === 'smile' && c('smiling').how === 'renamed');
  check('closest: the other number', c('indoor')?.tag === 'indoors' && c('indoor').how === 'number');
  check('closest: words dropped from the front', c('left_side_ponytail')?.tag === 'side_ponytail', JSON.stringify(c('left_side_ponytail')));
  check('closest: shortened only to a common tag', c('glowing_metal') === null, JSON.stringify(c('glowing_metal')));
  check('closest: nothing near returns null', c('blacksmith_shop') === null);
  // A bracketed form is never picked: on the real database the busiest
  // bracket of `photo` is `photo_(medium)`, a different meaning entirely.
  const q = closestTag('photo', { ...db, postCount: (x) => ({ 'photo_(medium)': 26738 }[x] ?? 0) });
  check('closest: no guessing between bracketed meanings', q === null, JSON.stringify(q));

  const asked = [];
  const resolve = (t) => { asked.push(t); return closestTag(t, db); };
  const r = finishCaption(META, 'safe, 1girl, smiling, indoor, wooden log, @an_artist', { resolve });
  check('resolve: swaps land in the caption', /1girl, smile, indoors, log/.test(r.caption), r.caption);
  check('resolve: every swap is reported', r.replaced.length === 3 && r.replaced.some((x) => x.from === 'wooden log' && x.to === 'log'), JSON.stringify(r.replaced));
  check('resolve: meta tags and artists not looked up', !asked.includes('safe') && !asked.some((t) => t.startsWith('@')), asked.join(','));
  const i = finishCaption(S.illustrious, 'smiling, smile', { resolve });
  check('resolve: a swap that lands on a duplicate collapses', i.caption === 'smile', i.caption);
  const x = finishCaption(S.illustrious, '1girl, smiling', { resolve, exclude: ['smile'] });
  check('resolve: Don\'t include still applies after a swap', x.caption === '1girl', x.caption);
}

// MOSS: the chosen length goes in the .txt; a watermark is flagged; bad JSON is an error.
{
  const raw = '```json\n{"caption":{"long":"Long.","medium":"Medium.","short":"Short."},"watermark":[{"label":"logo","box":[0,0,10,10]}],"borders":["none"]}\n```';
  const r = finishCaption(S.moss, raw, { trigger: 'tok', length: 'short' });
  check('moss: picked length', r.caption === 'tok, Short.' && r.length === 'short', r.caption);
  check('moss: all three kept', Object.keys(r.captions).length === 3);
  check('moss: watermark flagged', r.watermark === true);
  check('moss: not JSON is an error', throws(() => finishCaption(S.moss, 'just prose', {}))?.code === 'unparseable');
}

check('empty reply is an error', throws(() => finishCaption(S.illustrious, 'masterpiece, best quality', { trigger: 'x' }))?.code === 'unparseable');
check('request names the excludes and the trigger',
  /red hair/.test(captionRequest(S.illustrious, { exclude: ['red hair'], trigger: 'mychar' })) &&
  /"mychar"/.test(captionRequest(S.illustrious, { trigger: 'mychar' })));
check('request names the LoRA type', /kind: Art style/.test(captionRequest(S.krea2, { typeLabel: 'Art style' })));

// LoRA types: every one has its shared instruction file; a model's own
// version wins where it has one (Krea 2's style LoRAs); no type, no section.
{
  const types = loadLoraTypes(ROOT);
  check('six LoRA types configured', types.length === 6, types.map((t) => t.id).join(','));
  for (const t of types) {
    check(`type ${t.id}: shared file exists`, existsSync(path.join(ROOT, 'prompts', 'captions', 'types', `${t.id}.md`)));
    check(`type ${t.id}: has a label and a Don't include hint`, Boolean(t.label && t.exclude));
  }
  const kStyle = captionInstructions(ROOT, S.krea2, 'style');
  check('krea2 style: its own type file, not the shared one', /reference trainer captions style LoRAs/.test(kStyle) && !/If the\s+caption could tell someone/.test(kStyle));
  const aStyle = captionInstructions(ROOT, S.anima, 'style');
  check('anima style: the shared type file after the base', aStyle.indexOf('# Anima') === 0 && /If the\s+caption could tell someone/.test(aStyle));
  const none = captionInstructions(ROOT, S.illustrious, 'nonexistent');
  check('unknown type: the base prompt alone', none.startsWith('# Illustrious') && !/## This is a/.test(none));
  check('missing base prompt: empty, for the caller to report', captionInstructions(ROOT, { id: 'x', prompt: 'captions/nope.md' }, 'style') === '');
}
check('prose with only the trigger is an error', throws(() => finishCaption(S.krea2, 'mychar.', { trigger: 'mychar' }))?.code === 'unparseable');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
