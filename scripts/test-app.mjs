// Unit tests for pure frontend helpers in web/app.js. No DOM, no server.
//
// app.js is loaded as a <script type="module">, so importing it in Node is
// safe: the only top-level side effect is `init().catch(...)`, and errors
// from calling document-dependent code inside that async function become a
// rejected promise the .catch() swallows rather than a synchronous throw.
//
//   node scripts/test-app.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../server/registry.mjs';
import { createVersionWatch, headCommit } from '../server/version.mjs';
import { chooseModel } from '../server/llm.mjs';
import YAML from 'yaml';
import { stripPrefix, tagForModel, statusView, SERVER_UNREACHABLE, analysisValidate, promptSegments, presenceRows, lastSeenLabel, jobsByUser, gb, residentLine, doingLabel, daysUntilSwept, citationParts, chatModelGroups, chatModelNote, promptLlmState, queueNote, loadedLabel, presetForModel, clampDuration, offloadView, formatCountdown, formatElapsed, comfyLine } from '../web/app.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

console.log('\nstripPrefix — segment copy must not paste a doubled field label\n');

// The bug, measured: h3's "Music" segment UI label is "Music", but SKILL.md
// writes the body prefixed with the official field name, non_diegetic_music.
// The old stripPrefix only knew the label, so the prefix survived the copy.
ok(
  stripPrefix('Music', 'non_diegetic_music: N/A', 'non_diegetic_music') === 'N/A',
  'strips the declared field name when the body uses it, not the UI label'
);

// Existing behaviour must survive: a body prefixed with the plain label
// still strips, whether or not a field name is declared for that segment.
ok(
  stripPrefix('Summary', 'Summary: a concise recap.', undefined) === 'a concise recap.',
  'strips the plain UI label when no field name is declared'
);
ok(
  stripPrefix('Music', 'Music: N/A', 'non_diegetic_music') === 'N/A',
  'still strips the plain UI label even when a field name is declared'
);

// A body with no prefix at all is untouched either way.
ok(
  stripPrefix('Summary', 'a concise recap.', undefined) === 'a concise recap.',
  'a body with no prefix is left untouched'
);
ok(
  stripPrefix('Music', 'N/A', 'non_diegetic_music') === 'N/A',
  'a body with no prefix is left untouched when a field name is declared'
);

console.log('\ntagForModel — Tab 3 and the tag search must agree on spelling\n');

// WD returns the danbooru underscore form. Whatever comes out here has to
// match what /api/tags/search serves the same model, or the two paths inject
// two spellings of the same tag into one prompt.
ok(
  tagForModel('purple_hair', { tag_style: 'underscore' }) === 'purple_hair',
  'underscore models are left alone'
);
ok(
  tagForModel('purple_hair', { tag_style: 'space' }) === 'purple hair',
  'space models get real spaces, which is what pony.md, sdxl.md and anima.md ask for'
);
ok(
  tagForModel('purple_hair', undefined) === 'purple hair',
  'prose models with no tag_style get spaces for the brief'
);

// The reason the conversion is from underscore and never from dash. In the
// dash list a word-internal hyphen and a word separator are the same
// character, so `t-shirt` and `long-hair` cannot be told apart and a naive
// `-` to space gives "t shirt". From underscore both survive.
ok(
  tagForModel('t-shirt', { tag_style: 'space' }) === 't-shirt',
  'a word-internal hyphen is not touched'
);
ok(
  tagForModel('two-tone_hair', { tag_style: 'space' }) === 'two-tone hair',
  'hyphen and separator in the same tag are told apart'
);
ok(
  tagForModel('see-through_clothes', { tag_style: 'space' }) === 'see-through clothes',
  'and again on a 152k-post tag, not an edge case'
);

// ── The frontend must never hardcode a model ──────────────────────
//
// The project's first non-negotiable: selectors, badges, templates, quality
// ladders and button labels all derive from GET /api/models, so adding a
// model is one registry entry, one prompt file and one template file, with no
// code change. Until now that was enforced by review alone — a single
// "just special-case h3" patch would break it invisibly, and the cost lands
// on whoever adds model eleven and cannot work out why it half-appears.
//
// web/templates/ is deliberately NOT scanned. Those files are per-model by
// design and are named by each model's `template` field, which registry.mjs
// already validates against a real file at boot.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

// Model keys that are also ordinary words are the one plausible false
// positive — a settings gear called `cog`, say. Nothing needs it yet. If
// something does, add `file:key` here with a note rather than deleting the
// check, so the exception is visible.
const ALLOWED = new Set();

// Blanks comments out with spaces rather than removing them, so reported line
// numbers stay true. String-aware, because a URL's // must not read as a line
// comment.
//
// Quote state resets at every newline for ' and ", which is not decoration.
// app.js:1276 holds the regex /[&<>"']/, and a scanner that does not know
// regex literals from division reads that " as opening a string — which then
// ran to the next " two lines later and scrambled everything after it. The
// first version of this lint reported comments as hardcodes for exactly that
// reason. Since a ' or " string cannot span a newline unescaped, resetting
// there bounds any such desync to the one line that caused it. Backticks
// legitimately span lines and are left alone.
function blankComments(src, { lineComments, blockOpen, blockClose }) {
  const a = src.split('');
  const blank = (i, n) => { for (let k = i; k < i + n && k < a.length; k += 1) { if (a[k] !== NL) a[k] = ' '; } };
  const isAt = (i, tok) => a.slice(i, i + tok.length).join('') === tok;
  let i = 0;
  let quote = null;
  while (i < a.length) {
    const c = a[i];
    if (quote) {
      if (c === BACKSLASH) { i += 2; continue; }
      if (c === quote || (c === NL && quote !== '`')) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue; }
    if (blockOpen && isAt(i, blockOpen)) {
      let end = i;
      while (end < a.length && !isAt(end, blockClose)) end += 1;
      const stop = Math.min(a.length, end + blockClose.length);
      blank(i, stop - i);
      i = stop;
      continue;
    }
    if (lineComments && isAt(i, '//')) {
      let end = i;
      while (end < a.length && a[end] !== NL) end += 1;
      blank(i, end - i);
      i = end;
      continue;
    }
    i += 1;
  }
  return a.join('');
}

const isWordChar = (ch) => ch != null && /[A-Za-z0-9_]/.test(ch);

function occurrences(text, key) {
  const hits = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(key, from);
    if (at === -1) return hits;
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + key.length])) {
      hits.push(text.slice(0, at).split(NL).length);
    }
    from = at + key.length;
  }
}

console.log('');
console.log('no model key may appear in the frontend source, only in templates');
console.log('');

const SCANNED = [
  ['web/app.js', { lineComments: true, blockOpen: '/*', blockClose: '*/' }],
  ['web/styles.css', { lineComments: false, blockOpen: '/*', blockClose: '*/' }],
  ['web/index.html', { lineComments: false, blockOpen: '<!--', blockClose: '-->' }],
];

{
  const registry = loadRegistry(ROOT, { warn: () => {} });
  const keys = registry.keys();
  const found = [];
  for (const [rel, opts] of SCANNED) {
    const code = blankComments(readFileSync(path.join(ROOT, rel), 'utf8'), opts);
    for (const key of keys) {
      if (ALLOWED.has(`${rel}:${key}`)) continue;
      for (const line of occurrences(code, key)) found.push(`${rel}:${line} — ${key}`);
    }
  }
  ok(
    found.length === 0,
    `none of the ${keys.length} registry keys appear in ${SCANNED.length} frontend files`,
    found.length
      ? `${found.join('; ')}. Derive it from GET /api/models instead. If a hit is` +
        ' a coincidence rather than a model reference, rename it or add it to ALLOWED.'
      : ''
  );

  // A check that silently scans nothing is the failure mode here: point it at
  // a renamed file and it passes forever.
  // A floor, not a count. Was `>= 10` and broke the day four models were
  // removed, which is the wrong thing for a guard whose only job is to catch
  // the scan running against an empty registry.
  ok(keys.length >= 3, `the registry actually loaded — ${keys.length} models`);
}

// ── The failure table's UI response ─────────────────────────
//
// The spec calls these required, not optional, and CLAUDE.md repeats it:
// every failure state needs a defined UI response, and "it just spins
// forever" is not one of them. test-failures.mjs proves the server half of
// each row against a deliberately broken backend. This is the other half —
// what the user is actually shown — which was checked by eye until now.
//
// Two rows are out of scope here and belong to unbuilt phases: SearXNG
// (chat, Phase 4) and the training backend (Tab 2, Phase 6).

console.log('');
console.log('the failure table, as the user sees it');
console.log('');

{
  const view = statusView({ llm: { ok: true, backend: 'ollama', model: 'qwen3:8b' } });
  ok(view.dot === 'status-dot', 'a healthy backend gets the plain dot', view.dot);
  ok(view.generate === true, 'and Generate is enabled');
  ok(view.text.includes('qwen3:8b'), 'and the badge names the model', view.text);
}

{
  const view = statusView({ llm: { ok: true, backend: 'ollama', model: 'x' }, queue: { depth: 2 } });
  ok(view.text.includes('queue 2'), 'a queue depth is shown, so a wait is explained', view.text);
}

// Reported 22 Aug: "even after unloading or changing model this doesn't
// change". It said llm.model - the name in config/server.yaml - so the chip
// read identically whether the card was empty, holding that model, or holding
// something else somebody picked in chat.
{
  const chip = (resident, model = 'qwen3:8b') =>
    statusView({ llm: { ok: true, backend: 'ollama', model, resident } }).text;

  ok(chip([{ model: 'qwen3:1.7b' }]) === 'ollama · qwen3:1.7b',
    'the chip names what is actually loaded, not what is configured', chip([{ model: 'qwen3:1.7b' }]));
  // Not a fault: the next request loads one on its own.
  ok(chip([]) === 'ollama · idle', 'an empty card reads as idle', chip([]));
  // Naming both would push the queue depth off the chip; the panel lists them.
  ok(chip([{ model: 'a' }, { model: 'b' }]) === 'ollama · 2 models',
    'two resident models are counted rather than listed', chip([{ model: 'a' }, { model: 'b' }]));

  // A backend that cannot report residency is different from one reporting
  // none. Those load one model at start and hold it, so the configured name
  // is still the true answer.
  ok(loadedLabel({ backend: 'llamacpp', model: 'local-thing' }) === 'local-thing',
    'a backend with no residency reporting still names its model');
  ok(loadedLabel({ resident: [] }) === 'idle', 'while an empty list means idle');
  ok(loadedLabel({}) === 'unknown', 'and nothing known at all says so rather than guessing');
}

// ── ComfyUI's line in the On the GPU panel ─────────────────
{
  ok(comfyLine(null) === null, 'rendering off says nothing about ComfyUI');
  ok(comfyLine({ up: false }) === null, 'nor does ComfyUI asleep');
  ok(comfyLine({ up: true, busy: null })?.text === 'ComfyUI · idle', 'ComfyUI up and doing nothing says idle');
  const outside = comfyLine({ up: true, pending: 1, busy: { source: 'outside', model: 'MMH3', kind: 'video', seconds: 452 } });
  ok(outside?.text === 'Generating an MMH3 video in ComfyUI · 7 min 32s · started in ComfyUI · 1 more queued there',
    `a job started in ComfyUI says what it is making: ${outside?.text}`);
  const ours = comfyLine({ up: true, busy: { source: 'promptforge', model: 'Illustrious XL', kind: 'image', user: 'rin', node: 'KSampler', step: { value: 12, max: 30 }, seconds: 9 } });
  ok(ours?.text === 'Generating an Illustrious XL image in ComfyUI for rin · KSampler · step 12 of 30 · 9s',
    `a render from PromptForge names who, the node and the step: ${ours?.text}`);
  ok(comfyLine({ up: true, busy: { source: 'outside', model: null, kind: 'image', seconds: 3 } })?.text.startsWith('Generating an image in ComfyUI'),
    'an unrecognised model still says image');
}

// Row: LLM backend unreachable — badge red, Generate disabled, the spec's
// exact string when the server offers no detail of its own.
{
  const view = statusView({ llm: { ok: false, code: 'backend_unavailable', detail: null } });
  ok(view.dot === 'status-dot error', 'an unreachable backend goes red', view.dot);
  ok(view.generate === false, 'and Generate is disabled');
  ok(
    view.text === 'Model offline — check Ollama',
    'and says the words the spec asks for',
    view.text
  );
}

{
  const view = statusView({ llm: { ok: false, code: 'backend_unavailable', detail: 'connect ECONNREFUSED' } });
  ok(view.text === 'connect ECONNREFUSED', 'a real detail beats the generic string', view.text);
}

// Row: model loading — amber, and requests QUEUE rather than fail. Keeping
// Generate enabled is the whole point: server.mjs waits and retries before
// the first token, so disabling the button would deny the user that queue.
{
  const view = statusView({ llm: { ok: false, code: 'model_loading' } });
  ok(view.dot === 'status-dot loading', 'a loading model goes amber, not red', view.dot);
  ok(view.text === 'Loading model…', 'and says so', view.text);
  ok(view.generate === true, 'and Generate stays enabled so the request can queue');
}

// Not a spec row, but the one most likely to send someone debugging the
// wrong thing: the backend is fine, the tag is simply not pulled.
{
  const view = statusView({ llm: { ok: false, code: 'model_not_installed', model: 'qwen3:8b', detail: 'Run: ollama pull qwen3:8b' } });
  ok(view.text === 'qwen3:8b not pulled', 'an unpulled model says so, not "offline"', view.text);
  ok(view.title.includes('ollama pull'), 'and the tooltip carries the fix', view.title);
  ok(view.generate === false, 'and Generate is disabled');
}

// A tooltip left over from a previous state is worse than none: it would
// describe a failure that is no longer happening.
{
  const view = statusView({ llm: { ok: true, backend: 'ollama', model: 'x' } });
  ok(view.title === '', 'a recovered backend clears the tooltip', JSON.stringify(view.title));
}

// The page cannot reach its own server — distinct from the backend being
// down, and the user needs to know which.
ok(SERVER_UNREACHABLE.dot === 'status-dot offline', 'an unreachable server is its own state');
ok(SERVER_UNREACHABLE.generate === false, 'and Generate is disabled there too');

// A payload with no llm block at all must not throw — that would take the
// badge out entirely and leave the page with no status.
{
  let threw = null;
  try { statusView({}); statusView(undefined); } catch (err) { threw = err; }
  ok(threw === null, 'a malformed status payload degrades instead of throwing', String(threw));
  ok(statusView({}).generate === false, 'and does not leave Generate enabled on nothing');
}

// ── the offload countdown ────────────────────────────────────
//
// Moved out of the owner-gated GPU panel and into the topbar on 26 Aug 2026.
// Extracted as a pure function for the same reason statusView was: the
// version of that which wrote straight to the DOM had the model-loading row
// silently wrong for days, and every branch here is a state somebody has to
// be able to check without a browser.
//
// "Say nothing" is a real answer and there are four routes to it, so it gets
// the most coverage. A countdown that appeared when there was nothing to
// count would be worse than no countdown at all.
{
  const pinned = { value: '-1' };
  const fifteen = { value: '15m' };
  const idle = { running: 0 };
  const busy = { running: 1 };

  ok(offloadView({ resident: null }, fifteen, idle) === null,
    'a backend that cannot report residency shows nothing');
  ok(offloadView({ resident: [] }, fifteen, idle) === null,
    'nothing loaded means nothing to count down');
  ok(offloadView(undefined, undefined, undefined) === null,
    'a missing llm block degrades instead of throwing');
  ok(offloadView({ resident: [{ model: 'a', expires_in_seconds: null }] }, fifteen, idle) === null,
    'a resident model with no expiry shows nothing rather than guessing');

  // keep_alive -1 never unloads. A countdown there would tick toward a moment
  // that does not exist; Ollama also spells it as an expiry years out, so both
  // spellings have to land on the same answer.
  ok(offloadView({ resident: [{ expires_in_seconds: 900 }] }, pinned, idle).text === 'held',
    'a pinned model says held rather than counting');
  ok(offloadView({ resident: [{ expires_in_seconds: 9e8 }] }, fifteen, idle).text === 'held',
    'and an absurd expiry is read as pinned too, not rendered as a number');

  // While the card is working the clock restarts when the job finishes, so a
  // number would be counting toward the wrong moment.
  {
    const v = offloadView({ resident: [{ expires_in_seconds: 120 }] }, fifteen, busy);
    ok(v.text === 'in use', 'a running job replaces the countdown', v.text);
    ok(v.deadline === undefined, 'and gives the local tick nothing to count', String(v.deadline));
  }

  // The ordinary case.
  {
    const now = 1_000_000;
    const v = offloadView({ resident: [{ expires_in_seconds: 754 }] }, fifteen, idle, now);
    ok(v.text === '12:34', 'an ordinary expiry renders as m:ss', v.text);
    ok(v.deadline === now + 754_000, 'and carries a deadline for the local tick', String(v.deadline));
    ok(/pays a full model load/.test(v.title), 'the tooltip says what it costs', v.title);
    // The tooltip is written once per poll; the text ticks every second. A
    // number in the tooltip would be up to ten seconds behind the digits next
    // to it, which is what the first version did.
    ok(!/\d+:\d\d/.test(v.title), 'and does not restate the count, which would go stale', v.title);
  }

  // Two models resident: the soonest is the next thing that actually happens,
  // and it is the one somebody is waiting on.
  {
    const v = offloadView(
      { resident: [{ expires_in_seconds: 900 }, { expires_in_seconds: 60 }] },
      fifteen, idle, 0
    );
    ok(v.text === '1:00', 'with two models resident it counts the soonest', v.text);
  }

  // Formatting. Tabular digits in the CSS assume a stable width, and a bare
  // number of seconds in a topbar reads as a version string.
  ok(formatCountdown(0) === '0:00', 'zero is 0:00, not an empty string');
  ok(formatCountdown(9) === '0:09', 'seconds are padded', formatCountdown(9));
  ok(formatCountdown(59.6) === '1:00', 'and rounded rather than truncated', formatCountdown(59.6));
  ok(formatCountdown(3600) === '1:00h', 'an hour switches units', formatCountdown(3600));
  ok(formatCountdown(-5) === '0:00', 'a negative never renders as a minus', formatCountdown(-5));
}

// ── i18n: the two language lists cannot drift apart ──────────
//
// `LANGUAGES` in server/preferences.mjs is what the validator accepts and
// what /api/status offers the selector. The dictionaries in web/i18n.js are
// what actually exists. A language in the first and not the second gives you
// an interface that claims to be German and is entirely in English; a
// language in the second and not the first is a translation nobody can
// select. Neither fails loudly on its own.
{
  const { LANGUAGES } = await import('../server/preferences.mjs');
  const i18n = readFileSync(path.join(ROOT, 'web/i18n.js'), 'utf8');

  // The dictionary keys, read from the source rather than by importing it —
  // that module touches `document` and `localStorage` at call time.
  const block = i18n.slice(i18n.indexOf('const DICTIONARIES = {'), i18n.indexOf('\n};', i18n.indexOf('const DICTIONARIES = {')));
  const dicts = [...block.matchAll(/^ {2}([a-z]{2}): \{$/gm)].map((m) => m[1]);

  ok(dicts.length > 0, 'web/i18n.js declares at least one dictionary', dicts.join(', '));
  ok(LANGUAGES[0] === 'en',
    'English is first and is the source language, so it needs no dictionary',
    LANGUAGES.join(', '));
  for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
    ok(dicts.includes(lang),
      `${lang} is offered by the server and has a dictionary to back it`,
      `dictionaries: ${dicts.join(', ')}`);
  }
  for (const lang of dicts) {
    ok(LANGUAGES.includes(lang),
      `${lang} has a dictionary and is actually selectable`,
      `LANGUAGES: ${LANGUAGES.join(', ')}`);
  }

  // Every dictionary should carry roughly the same keys. A short one is a
  // half-translated interface, which reads as a rendering fault rather than
  // as a missing translation.
  const keyCount = (lang) => {
    const at = block.indexOf(`\n  ${lang}: {`);
    const end = block.indexOf('\n  },', at);
    return [...block.slice(at, end).matchAll(/^ {4}(?:'[^']+'|[A-Za-z][\w]*):/gm)].length;
  };
  const counts = dicts.map((l) => [l, keyCount(l)]);
  const biggest = Math.max(...counts.map(([, n]) => n));
  for (const [lang, n] of counts) {
    ok(n >= biggest * 0.9,
      `the ${lang} dictionary is not materially shorter than the fullest one`,
      `${lang}: ${n} keys against ${biggest}`);
  }

  // Content must never be translated. These are the three that would produce
  // a broken prompt rather than an odd label, so they are named explicitly.
  ok(/script, style, pre, code/.test(i18n),
    'verbatim output (pre/code) and script/style are opaque to the translator');
  ok(/data-no-i18n/.test(i18n),
    'and there is an explicit opt-out for content the observer would otherwise reach');

  // Segment labels are the model's output contract. Caught in a browser:
  // with the interface in French the panel read "Positive prompt / Prompt
  // négatif / Reasoning", because only one of the three was in the
  // dictionary. Half a translated contract reads as a rendering fault.
  const app = readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  // Windowed on the assignment rather than regexed to the next `textContent`:
  // one of the two sites carries a long explanatory comment between them, and
  // a tight window silently found only one — which is the failure mode where
  // a scan passes while covering half of what it claims to.
  const labelSites = [];
  for (let at = app.indexOf("className = 'segment-label';"); at !== -1;
       at = app.indexOf("className = 'segment-label';", at + 1)) {
    labelSites.push(app.slice(at, at + 1200));
  }
  ok(labelSites.length >= 2, 'both segment-label sites are found', String(labelSites.length));
  for (const [i, site] of labelSites.entries()) {
    ok(/dataset\.noI18n/.test(site),
      `segment label site ${i + 1} opts out of translation`,
      site.replace(/\s+/g, ' ').slice(0, 90));
  }
}

// ── every offered theme has a palette behind it ──────────────
//
// Same shape of trap as the language dictionaries: a theme the server accepts
// with no CSS behind it renders an unstyled page while claiming to be a
// scheme, and a palette nobody can select is dead weight. Neither fails
// loudly on its own.
//
// The stricter half is completeness. A theme that sets six variables and
// inherits nineteen looks right until someone changes a default, and then it
// is a different theme for reasons nobody can find — so each block is held to
// declaring the full palette.
{
  const { THEMES, FONTS, TEXT_SIZES } = await import('../server/preferences.mjs');
  const themes = readFileSync(path.join(ROOT, 'web/themes.css'), 'utf8');
  const bare = themes.replace(/\/\*[\s\S]*?\*\//g, '');
  const styles = readFileSync(path.join(ROOT, 'web/styles.css'), 'utf8');

  // The default palette is deliberately NOT in themes.css: it lives in
  // styles.css :root so a browser that never loads themes.css renders the app
  // exactly as it did before themes existed. Selecting it means removing the
  // attribute, which is why it has no block.
  ok(THEMES[0] === 'midnight', 'midnight is the default and comes first', THEMES.join(', '));
  ok(!/\[data-theme="midnight"\]/.test(bare),
    'and has no themes.css block, because it is the absence of one');

  const declared = [...bare.matchAll(/:root\[data-theme="([a-z]+)"\]/g)].map((m) => m[1]);
  for (const t of THEMES.filter((x) => x !== 'midnight')) {
    ok(declared.includes(t), `${t} is offered and has a palette`, declared.join(', '));
  }
  for (const t of [...new Set(declared)]) {
    ok(THEMES.includes(t), `${t} has a palette and is selectable`, THEMES.join(', '));
  }

  // Completeness, against the variables the default actually declares.
  // radius/mono/sans are structural rather than palette and are excluded —
  // sans is what the FONT blocks set, and a theme has no business changing it.
  const rootBlock = styles.slice(styles.indexOf(':root {'), styles.indexOf('\n}', styles.indexOf(':root {')));
  const palette = [...rootBlock.matchAll(/^\s*--([a-z-]+):/gm)]
    .map((m) => m[1])
    .filter((v) => !['radius', 'radius-lg', 'mono', 'sans'].includes(v));
  ok(palette.length > 15, 'the default palette was found and is substantial', String(palette.length));

  for (const t of [...new Set(declared)]) {
    const at = bare.indexOf(`:root[data-theme="${t}"]`);
    const block = bare.slice(at, bare.indexOf('}', at));
    const missing = palette.filter((v) => !new RegExp(`--${v}:`).test(block));
    ok(missing.length === 0,
      `the ${t} palette is complete rather than half-inherited`,
      missing.length ? `missing: ${missing.join(', ')}` : '');
  }

  // A light scheme has to tell the browser, or form controls, scrollbars and
  // the autofill background stay dark and fight the page. Variables cannot
  // reach those.
  ok(/color-scheme:\s*light/.test(bare),
    'the light scheme sets color-scheme, which variables cannot reach');

  // Fonts and sizes, same pairing.
  const fontBlocks = [...bare.matchAll(/:root\[data-font="([a-z]+)"\]/g)].map((m) => m[1]);
  for (const f of FONTS.filter((x) => x !== 'default')) {
    ok(fontBlocks.includes(f), `the ${f} typeface is offered and defined`, fontBlocks.join(', '));
  }
  ok(!/\[data-font="default"\]/.test(bare),
    'default is the absence of a font block, like midnight is for themes');
  for (const s of TEXT_SIZES.filter((x) => x !== 'normal')) {
    ok(new RegExp(`\\[data-textsize="${s}"\\]`).test(bare), `the ${s} text size is defined`);
  }

  // Nothing here may fetch a font. The tailnet has no route to Google Fonts
  // and the box may be offline; a face that silently fails to load is a worse
  // default than one nobody chose.
  ok(!/@import|@font-face|fonts\.googleapis|https?:/.test(bare),
    'no theme or typeface downloads anything');
}

// ── the length box has to fit four digits ────────────────────
//
// It shipped clipping them: "120" rendered as "12(" and 4000 would have lost
// its last digit too. Reported from a screenshot.
//
// **The cause was flex-shrink, not the declared width.** The box asked for
// `flex: 0 1 74px` — 74px wide, and *willing to shrink*. Beside it sat a
// select with `flex: 1 1 auto`, whose basis was its own content, and its
// longest option then read "tokens (hard cap)". The two together wanted
// ~190px of a 140px grid cell, so both shrank proportionally and the number
// box lost about 24px it could not spare. Widening it would not have fixed
// this; the box was always wide enough until something else asked for room.
//
// So flex-shrink is what gets pinned. The arithmetic is kept as a second
// check because box-sizing is border-box here — padding and border come OUT
// of the declared width — but it is the weaker of the two, and mutation
// testing showed why: restoring the shipped `flex: 0 1 74px` leaves 52px of
// content, which passes the arithmetic while clipping in a browser.
{
  const css = readFileSync(path.join(ROOT, 'web/styles.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf('.length-row input[type="number"] {');
  const block = at === -1 ? '' : bare.slice(at, bare.indexOf('}', at));

  // `flex: <grow> <shrink> <basis>`. The middle number is the whole bug.
  const flex = /flex:\s*(\d+)\s+(\d+)\s+([0-9.]+)px/.exec(block);
  ok(flex !== null, 'the length number box declares grow, shrink and basis explicitly',
    block.match(/flex:[^;]*/)?.[0] ?? 'no flex declaration');
  ok(flex && flex[2] === '0',
    'and refuses to shrink — a shrinking number box is what clipped the digits',
    flex ? `flex-shrink: ${flex[2]}` : 'unreadable');

  const num = (prop) => {
    const m = new RegExp(prop + ':\\s*(-?[0-9.]+)px').exec(block);
    return m ? Number(m[1]) : null;
  };
  const padL = num('padding-left');
  const padR = num('padding-right');
  const width = flex ? Number(flex[3]) : null;

  // "4000" in JetBrains Mono at 13px measures 28.6px in a browser. 32 is that
  // plus slack for a fallback font with wider digits — the fallback list is
  // what a box without the webfont loaded actually uses.
  const DIGITS_PX = 32;
  const BORDER_PX = 2;
  // Falls back to the generic input padding rather than to zero when this
  // block declares none. Mutation testing caught the zero version: padL and
  // padR came back null, coerced to 0, and the sum claimed 20px more content
  // than the browser had. An unknown padding is not a padding of nothing.
  const generic = /input,\s*textarea,\s*select[^{]*\{[^}]*padding:\s*[0-9.]+px\s+([0-9.]+)px/.exec(bare);
  const sidePad = (v) => (v === null ? (generic ? Number(generic[1]) : 10) : v);
  const content = width === null ? -1 : width - sidePad(padL) - sidePad(padR) - BORDER_PX;
  ok(content >= DIGITS_PX,
    'and leaves room for the 4000 ceiling after padding and border',
    `${content}px of content for ${DIGITS_PX}px of digits`);

  // The other half of the same bug: the spinner arrows are inside the box and
  // eat the content width, at a step of 10 nobody wants across a 10–4000
  // range. Removing this rule puts ~20px of clipping straight back.
  ok(/appearance:\s*textfield/.test(block),
    'the spinner arrows are off, since they eat the width they clipped');
  ok(/-webkit-(?:outer|inner)-spin-button/.test(bare),
    'including the WebKit pseudo-elements, which ignore the shorthand');
}

// ── the reference image block, structurally ──────────────────
//
// setupImageReference is DOM-bound and cannot be unit-tested here, but the
// thing most likely to break it can be: it is switched on by the PRESENCE of
// its block in the template, exactly as H3's uploader is, and there is no
// registry flag and no model name behind that decision. A fourth image
// template added later without the block would silently have no reference
// uploader and nothing else in the suite would notice.
//
// The pairing asserted is with `trait_block`, because the two belong together:
// a reference that recognises a character opens the traits panel, so a
// template offering one and not the other is half a feature.
{
  const dir = path.join(ROOT, 'web/templates');
  const files = ['booru.html', 'hybrid.html', 'natural-language.html',
                 'video-h3.html', 'video-wan.html', 'video-ltx.html', 'video-cog.html'];
  const src = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]));

  const withTraits = files.filter((f) => src[f].includes('data-bind="trait_block"'));
  const withImgref = files.filter((f) => src[f].includes('data-bind="image_reference"'));

  ok(withTraits.length === 3, 'three templates carry the tag builder and its traits panel',
    withTraits.join(', '));
  ok(withImgref.join() === withTraits.join(),
    'and exactly those three carry the reference image block',
    `imgref: ${withImgref.join(', ')} | traits: ${withTraits.join(', ')}`);

  // Each binding app.js reaches for has to exist, or the feature degrades to
  // an early return with no error anywhere.
  for (const f of withImgref) {
    for (const bind of ['imgref_upload', 'imgref_list', 'imgref_row', 'imgref_preview',
                        'imgref_role', 'imgref_fidelity', 'imgref_role_hint',
                        'imgref_character_field', 'imgref_character',
                        'imgref_character_suggestions', 'imgref_applies_field',
                        'imgref_applies',
                        'imgref_note', 'imgref_chips', 'imgref_title',
                        'imgref_add_all', 'imgref_remove', 'imgref_status']) {
      ok(src[f].includes(`data-bind="${bind}"`), `${f} binds ${bind}`);
    }
  }

  // Cards are cloned from a <template>, so an empty list is genuinely empty
  // rather than a bordered box sitting above the tag builder looking broken.
  // This replaced a `hidden` attribute on a single always-present panel when
  // references went from one to many on 26 Aug.
  for (const f of withImgref) {
    ok(/<template data-bind="imgref_row">/.test(src[f]),
      `${f} builds its cards from a template rather than from markup that is always there`);
    ok(/data-bind="imgref_upload"[^>]*\bmultiple\b/.test(src[f]),
      `${f} accepts more than one reference at a time`);
  }

  // Role and fidelity are registry-driven like every other selector. Options
  // written into the template would be a second copy of config that goes
  // stale the first time the owner reworded one.
  for (const f of withImgref) {
    const roleBlock = src[f].slice(src[f].indexOf('data-bind="imgref_role"'), src[f].indexOf('data-bind="imgref_role"') + 200);
    ok(!/<option/.test(roleBlock), `${f} leaves the role options to the registry`);
  }
}

// ── Upload limits, client side ───────────────────────────────
//
// The failure table's last in-scope row: "rejected client-side and
// server-side with the specific limit named". test-taggers covers the server
// half. The requirement is not merely that the file is refused — it is that
// the refusal says what the limit is, so the user knows what to do next.
// A message reading "invalid file" would satisfy a naive test and fail the
// spec, so every case here asserts the number or the type list is present.

const LIMITS = {
  max_image_mb: 20,
  allowed_image_types: ['image/png', 'image/jpeg', 'image/webp'],
};
const MB = 1024 * 1024;
const file = (type, mb, name = 'x') => ({ type, size: Math.round(mb * MB), name });

console.log('');
console.log('upload limits — refused, and the refusal names the limit');
console.log('');

ok(
  analysisValidate(file('image/png', 1), LIMITS) === null,
  'an accepted type inside the limit passes'
);
ok(
  analysisValidate(file('image/webp', 19.9), LIMITS) === null,
  'and so does one just under the limit'
);

{
  const msg = analysisValidate(file('image/gif', 1), LIMITS);
  ok(Boolean(msg), 'a wrong type is refused', String(msg));
  ok(msg.includes('image/gif'), 'the message names the type that was refused', msg);
  ok(
    msg.includes('image/png') && msg.includes('image/webp'),
    'and lists what would be accepted, so the user can act on it',
    msg
  );
}

{
  const msg = analysisValidate(file('image/png', 25), LIMITS);
  ok(Boolean(msg), 'an oversized file is refused', String(msg));
  ok(msg.includes('20'), 'the message names the limit', msg);
  ok(msg.includes('25.0'), 'and the size that broke it, not just the rule', msg);
}

// A file the browser cannot type at all — dragged from an odd source, or an
// extensionless file. It must still be refused with something readable
// rather than a message beginning with "undefined".
{
  const msg = analysisValidate(file('', 1), LIMITS);
  ok(Boolean(msg), 'a file with no type at all is refused', String(msg));
  ok(msg.startsWith('That file'), 'and reads as a sentence, not as "undefined"', msg);
}

// Type is checked before size, so the more actionable message wins when a
// file breaks both rules.
{
  const msg = analysisValidate(file('application/zip', 500), LIMITS);
  ok(msg.includes('not accepted'), 'a file breaking both rules reports the type first', msg);
}

// Degradation: if /api/taggers ever answers without limits, the validator
// must not start accepting a 4 GB file. 20 MB is the documented fallback.
{
  const msg = analysisValidate(file('image/png', 4096), {});
  ok(Boolean(msg), 'with no limits configured, the fallback still refuses', String(msg));
  ok(msg.includes('20'), 'and the fallback names 20 MB', msg);
  ok(
    analysisValidate(file('application/zip', 1), {}) === null,
    'with no allow-list configured, type is not guessed at'
  );
}

// Which config actually feeds this is not obvious, and getting it wrong makes
// the assertion decorative — the first version of this block read
// config/server.yaml, which nothing uses, so it passed while testing nothing.
// Both upload paths read TAGGERS.limits, which server/taggers.mjs builds from
// **config/taggers.yaml**.
{
  const t = YAML.parse(readFileSync(path.join(ROOT, 'config/taggers.yaml'), 'utf8'));
  const u = t.uploads ?? {};
  ok(
    typeof u.max_image_mb === 'number',
    'config/taggers.yaml is the live source of the image limit',
    String(u.max_image_mb)
  );
  ok(
    JSON.stringify(u.allowed_image_types) === JSON.stringify(LIMITS.allowed_image_types),
    'and allows exactly png, jpeg and webp',
    JSON.stringify(u.allowed_image_types)
  );
}

// server.yaml used to carry its own max_image_mb, with a different value and
// no reader, so tightening the limit there did nothing. Deleted 21 Aug on the
// owner's call. This keeps it deleted: a second copy would be silently
// authoritative-looking and silently ignored.
{
  const cfg = YAML.parse(readFileSync(path.join(ROOT, 'config/server.yaml'), 'utf8'));
  const stray = Object.keys(cfg.uploads ?? {}).filter((k) => k.includes('image'));
  ok(
    stray.length === 0,
    'config/server.yaml states no image limits — taggers.yaml owns them',
    stray.length ? `found ${stray.join(', ')}, which nothing reads` : ''
  );
}
// The three fallbacks that fire only when /api/taggers answers without a
// limit. They must agree, or the client lets through a file the server then
// refuses — which is what happened: the Tab 1 reference path fell back to 64
// while taggers.mjs fell back to 20.
{
  const src = readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  const server = readFileSync(path.join(ROOT, 'server/taggers.mjs'), 'utf8');
  const fallbacks = new Set();
  for (const text of [src, server]) {
    // Split rather than match: the literal is `max_image_mb ?? 20`, and a
    // regex for it needs escapes that are easy to mangle into a pattern that
    // silently matches nothing.
    for (const part of text.split('max_image_mb ?? ').slice(1)) {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) fallbacks.add(String(n));
    }
  }
  ok(
    fallbacks.size === 1,
    'client and server fall back to the same image limit',
    `found ${[...fallbacks].join(' and ')} MB`
  );
}

console.log('\npromptSegments — Copy all must not paste reasoning into a prompt box\n');

// The real shape, from the I2VA generation on 21 Aug that prompted this: three
// base-mode fields filled, three N/A, and a paragraph of the model explaining
// itself. What the DaSiWa Director wants is the three.
{
  const h3 = { meta_segments: ['Reasoning'] };
  const generated = [
    { label: 'Subject definitions', body: 'N/A' },
    { label: 'Summary', body: 'N/A' },
    { label: 'Retention analysis', body: 'N/A' },
    { label: 'Detailed description', body: 'integrated_multimodal_description: [Shot 1] …' },
    { label: 'Soundscape', body: 'A quiet indoor room tone persists throughout.' },
    { label: 'Music', body: 'N/A' },
    { label: 'Reasoning', body: '1,068 of 7,000 characters. I2VA mode selected per controls.' },
  ];
  const kept = promptSegments(generated, h3).map((s) => s.label);
  ok(
    kept.join(' | ') === 'Detailed description | Soundscape',
    'h3 base mode keeps only the fields that carry prompt content',
    kept.join(' | ')
  );
  ok(!kept.includes('Reasoning'), 'the reasoning paragraph is excluded');
  ok(!kept.includes('Music'), 'an N/A field is excluded — nothing to paste');
}

// Exclusion is registry-driven, not name-driven. wan calls its meta segments
// something different and there are two of them; ltx calls its something else
// again. A helper that knew the word "Reasoning" would get both wrong.
{
  const segs = (labels) => labels.map((l) => ({ label: l, body: 'text' }));
  const wan = { meta_segments: ['Layer breakdown', 'Reasoning'] };
  ok(
    promptSegments(segs(['Positive prompt', 'Negative prompt', 'Layer breakdown', 'Reasoning']), wan)
      .map((s) => s.label).join(' | ') === 'Positive prompt | Negative prompt',
    'wan drops both of its meta segments'
  );
  const ltx = { meta_segments: ['Improvement notes'] };
  ok(
    promptSegments(segs(['Enhanced paragraph', 'Improvement notes']), ltx)
      .map((s) => s.label).join(' | ') === 'Enhanced paragraph',
    'ltx drops a meta segment that is not called Reasoning'
  );
  // A model with nothing declared must not silently lose content.
  ok(
    promptSegments(segs(['Positive prompt', 'Reasoning']), {}).length === 2,
    'no meta_segments declared means nothing is dropped'
  );
  // Body variants: whitespace and case around N/A still count as empty.
  ok(
    promptSegments([{ label: 'Music', body: '  n/a  ' }], {}).length === 0,
    'N/A detection ignores case and surrounding whitespace'
  );
  ok(
    promptSegments([{ label: 'Music', body: 'N/A because the brief is silent' }], {}).length === 1,
    'a body that merely starts with N/A is real content and is kept'
  );
}

// Every registry model must declare meta_segments, or Copy all quietly starts
// pasting reasoning again for whichever one was forgotten.
{
  const reg = loadRegistry(ROOT, { warn: () => {} });
  const missing = reg.all().filter((m) => !Array.isArray(m.meta_segments) || !m.meta_segments.length);
  ok(missing.length === 0, 'every model declares meta_segments',
    missing.map((m) => m.key).join(', '));
}

console.log('\npresence - the active users panel\n');

// The server counts anyone inside a two-minute window as present, so every
// figure here is small. Under a minute reads as now: someone who made a
// request 40 seconds ago is, for any purpose this list serves, here.
ok(lastSeenLabel(0) === 'Active now', 'zero seconds is active now');
ok(lastSeenLabel(59) === 'Active now', 'under a minute is active now');
ok(lastSeenLabel(60) === '1 min ago', 'a minute is a minute, singular');
ok(lastSeenLabel(125) === '2 mins ago', 'past that it counts minutes', lastSeenLabel(125));
// Degradation, not a crash: presence is decoration and a malformed figure must
// not take the panel down with it.
ok(lastSeenLabel(undefined) === 'Active now', 'a missing figure degrades to active now');
ok(lastSeenLabel(-5) === 'Active now', 'a negative figure degrades to active now');

{
  const rows = presenceRows({
    you: 'owner',
    online: [
      { username: 'friendo', display_name: 'Friendo', is_owner: false, seconds_ago: 4 },
      { username: 'owner', display_name: 'Owner', is_owner: true, seconds_ago: 1 },
      { username: 'thirdwheel', display_name: '', is_owner: false, seconds_ago: 90 },
    ],
  });
  // You first, and marked. This is the difference between the panel and the
  // topbar chip: the chip shows other people only, because it answers "is
  // anyone else here". A panel headed "Active now" that omitted you would be
  // describing a room you are standing in.
  ok(rows[0].username === 'owner' && rows[0].you === true, 'your own row comes first and is marked');
  ok(rows.filter((r) => r.you).length === 1, 'exactly one row is you');
  ok(rows[0].owner === true, 'the owner is flagged');
  ok(rows.find((r) => r.username === 'friendo')?.owner === false, 'and everyone else is not');
  // display_name is optional and empty for anyone who never set one.
  ok(rows.find((r) => r.username === 'thirdwheel')?.name === 'thirdwheel',
    'an empty display name falls back to the username');
  ok(rows.find((r) => r.username === 'thirdwheel')?.seen === '1 min ago',
    'and carries its own freshness');
  ok(rows[1].username === 'friendo' && rows[2].username === 'thirdwheel',
    'the server order survives for everyone else');
}

// Signed out, accounts off, and a poll that has not landed: three states that
// mean different things and none of which may throw.
ok(presenceRows({ you: null, online: [] }).length === 0, 'nobody online is an empty list');
ok(presenceRows(undefined).length === 0, 'no presence payload at all is an empty list');
ok(presenceRows({ online: [{ username: 'solo', seconds_ago: 2 }] })[0].you === false,
  'with no "you" in the payload, nobody is you');

console.log('\nstylesheet - the active users panel must stay closable\n');

// A CSS-only bug that no assertion in this project could have caught, found by
// the owner within a minute of opening it: the panel opened and there was no
// way to shut it.
//
// Two overlaps, both invisible to a DOM test. The topbar is sticky at z-index
// 100, so a panel starting at top: 0 had its own Close button rendered
// underneath it. And the panel sat above the handle, so clicking "People" a
// second time hit the panel instead. Escape worked, which nobody should have
// to know.
//
// This reads the stylesheet as text. It cannot prove the panel is usable, but
// it does pin the two numbers whose relationship broke it — and either one
// silently regressing is exactly the kind of change that looks harmless in a
// diff.
{
  const css = readFileSync(path.join(ROOT, 'web/styles.css'), 'utf8');
  // Comments stripped first. The panel's own comment explains the bug and
  // contains the words "top: 0" while doing it, which the naive version
  // happily matched — a test that reads a stylesheet has to read the
  // stylesheet, not the prose around it.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => {
    const at = bare.indexOf(selector + ' {');
    return at === -1 ? '' : bare.slice(at, bare.indexOf('}', at));
  };
  const num = (block, prop) => {
    // Doubled backslash: this is a string, so \\s is what reaches the
    // regex. Written single it is swallowed and every lookup returns null.
    const m = new RegExp(prop + ':\\s*(-?[0-9.]+)').exec(block);
    return m ? Number(m[1]) : null;
  };

  const topbar = rule('.topbar');
  const panel = rule('.people-panel');
  const handle = rule('.people-tab');

  const topbarHeight = num(topbar, 'height');
  const topbarZ = num(topbar, 'z-index');
  const panelTop = num(panel, 'top');
  const panelZ = num(panel, 'z-index');
  const handleZ = num(handle, 'z-index');

  ok(topbarHeight === 56 && topbarZ === 100, 'the topbar is 56px tall and sits at z-index 100',
    `${topbarHeight}px / ${topbarZ}`);
  // The fix, and the reason for it: the topbar is painted over anything below
  // its z-index, so the panel has to start below it or lose its own head.
  ok(panelTop >= topbarHeight,
    'the panel starts below the topbar, so its Close button is not buried',
    `panel top ${panelTop}, topbar ${topbarHeight}`);
  // The handle is the only control that opens this, so it must never be the
  // thing the panel covers.
  ok(handleZ > panelZ, 'the handle sits above the panel and stays clickable while open',
    `handle ${handleZ}, panel ${panelZ}`);
  // And it moves aside by exactly the panel width, so it lands on the panel's
  // edge rather than over its contents or off under it.
  const openHandle = rule('.people-tab[aria-expanded="true"]');
  ok(num(openHandle, 'right') === num(panel, 'width'),
    'and when open it sits on the panel edge, not over it',
    `handle right ${num(openHandle, 'right')}, panel width ${num(panel, 'width')}`);
}

console.log('\nthe panel and what the box is doing\n');

{
  // Five people, one GPU. "1 running" tells nobody whose job it is.
  const jobs = jobsByUser({
    jobs: [
      { user: 'friendo', model: 'h3', state: 'running', seconds: 12 },
      { user: 'alex', model: 'illustrious', state: 'waiting', seconds: 3 },
      { user: null, model: 'pony', state: 'waiting', seconds: 1 },
    ],
  });
  ok(jobs.get('friendo')?.state === 'running', 'a running job is attributed to its user');
  ok(jobs.get('alex')?.state === 'waiting', 'and so is a queued one');
  ok(!jobs.has(null) && jobs.size === 2, 'a job with no account attached is not attributed to anyone');
}

{
  // Someone can hold one job and have another queued behind it. The running
  // one wins: that is the one holding the card.
  const jobs = jobsByUser({
    jobs: [
      { user: 'friendo', model: 'pony', state: 'waiting', seconds: 1 },
      { user: 'friendo', model: 'h3', state: 'running', seconds: 30 },
    ],
  });
  ok(jobs.get('friendo')?.model === 'h3', 'a running job outranks the same person queued behind it');
}

ok(jobsByUser(undefined).size === 0, 'no queue payload is no jobs');
ok(jobsByUser({ jobs: [] }).size === 0, 'an empty queue is no jobs');

{
  // Chat and prompt generation share one queue because they share one card,
  // so the row has to say which it is.
  const gen = doingLabel({ state: 'running', kind: 'prompt', seconds: 19 }, 'Illustrious XL');
  ok(gen.text === 'Generating · Illustrious XL · 19s', 'a prompt job reads as generating', gen.text);
  const chat = doingLabel({ state: 'running', kind: 'chat', seconds: 4 }, null);
  ok(chat.text === 'Chatting · 4s', 'a chat job reads as chatting, with no model to name', chat.text);
  const wait = doingLabel({ state: 'waiting', kind: 'prompt' }, 'Pony Diffusion V6');
  ok(wait.text === 'Waiting for the GPU · Pony Diffusion V6' && wait.waiting === true,
    'a queued job names what it is waiting to run', wait.text);
  ok(doingLabel(null) === null, 'somebody doing nothing gets no line');
}

ok(gb(14000000000) === '14.0 GB', 'bytes read as GB', String(gb(14000000000)));
ok(gb(0) === null && gb(undefined) === null, 'and nonsense sizes are dropped rather than shown');

{
  // The whole point of this line: a partial offload is the difference between
  // fast and unusably slow, and nothing else in the app says so.
  const partial = residentLine({ size_bytes: 14e9, vram_bytes: 9e9, expires_in_seconds: 900 });
  ok(/partly on CPU/.test(partial), 'a partial offload is called out', partial);
  ok(/15 min/.test(partial), 'and the unload countdown reads in minutes', partial);

  const whole = residentLine({ size_bytes: 5.2e9, vram_bytes: 5.2e9, expires_in_seconds: 45 });
  ok(!/partly on CPU/.test(whole), 'a fully offloaded model says nothing about the CPU', whole);
  ok(/45s/.test(whole), 'and a short countdown reads in seconds', whole);

  ok(residentLine({}) === '', 'an entry with nothing known produces no detail line');

  // The pinned case, which offloadView has always handled and this line did
  // not: keep_alive -1 comes back from ollama as an expiry centuries out, and
  // rendering it raw produced "unloads in 153722861 min" in the panel.
  ok(/held/.test(residentLine({ size_bytes: 17e9, vram_bytes: 17e9, expires_in_seconds: 9.2e9 })),
    'a pinned model says held rather than counting to the year 292277026596',
    residentLine({ size_bytes: 17e9, vram_bytes: 17e9, expires_in_seconds: 9.2e9 }));
  ok(!/d{5,}/.test(residentLine({ size_bytes: 17e9, vram_bytes: 17e9, expires_in_seconds: 9.2e9 })),
    '...and no runaway number survives into the line');
  ok(/unloads in 15 min/.test(residentLine({ size_bytes: 5e9, vram_bytes: 5e9, expires_in_seconds: 900 })),
    'an ordinary expiry still counts down normally');
}

console.log('\nchat retention - what the sidebar warns about\n');

{
  const DAY = 86400000;
  const now = Date.parse('2026-08-21T12:00:00Z');
  const chat = (daysAgo, locked = false) => ({
    updated_at: new Date(now - daysAgo * DAY).toISOString(),
    locked,
  });

  ok(daysUntilSwept(chat(0), 14, now) === 14, 'a conversation just used has the full window', String(daysUntilSwept(chat(0), 14, now)));
  ok(daysUntilSwept(chat(12), 14, now) === 2, 'and one nearly out has two days', String(daysUntilSwept(chat(12), 14, now)));
  ok(daysUntilSwept(chat(14), 14, now) === 0, 'one at the limit reads zero rather than going negative', String(daysUntilSwept(chat(14), 14, now)));
  ok(daysUntilSwept(chat(40), 14, now) === 0, 'and one long past it also reads zero', String(daysUntilSwept(chat(40), 14, now)));

  // Null means nothing is coming for it, which is what the sidebar checks
  // before showing any countdown at all.
  ok(daysUntilSwept(chat(40, true), 14, now) === null, 'a locked conversation has no deadline');
  ok(daysUntilSwept(chat(40), 0, now) === null, 'and neither does anything when retention is off');
  ok(daysUntilSwept(chat(40), undefined, now) === null, '...or unset');
  ok(daysUntilSwept({ updated_at: 'not a date' }, 14, now) === null,
    'an unreadable timestamp produces no deadline rather than a wrong one');
  ok(daysUntilSwept(undefined, 14, now) === null, 'and neither does nothing at all');
}

console.log('\ncitations - turning [1] into a link\n');

{
  const sources = [
    { n: 1, url: 'https://civitai.com/a', title: 'A guide', domain: 'civitai.com' },
    { n: 2, url: 'https://reddit.com/b', title: 'A thread', domain: 'reddit.com' },
  ];

  const parts = citationParts('Rank 128 is usual [1], though 64 also works [2].', sources);
  ok(parts.filter((p) => p.type === 'cite').length === 2, 'both markers become citations');
  ok(parts.find((p) => p.type === 'cite')?.url === 'https://civitai.com/a',
    'and carry the URL of the source they name');
  ok(parts.map((p) => (p.type === 'text' ? p.value : `[${p.n}]`)).join('') ===
    'Rank 128 is usual [1], though 64 also works [2].',
    'the text is preserved exactly around them');

  // Models write [1] for reasons that have nothing to do with citations.
  // A number nobody supplied is not a source.
  ok(citationParts('See index [7] for that.', sources).every((p) => p.type === 'text'),
    'a marker with no matching source stays as text');
  // And a bracket attached to a word is code, not a citation — `layers[1]`
  // must not become a link just because a source happens to be numbered 1.
  ok(citationParts('Use layers[1] and steps[2] there.', sources).every((p) => p.type === 'text'),
    'an array index is not a citation');
  ok(citationParts('as usual [1]', sources).some((p) => p.type === 'cite'),
    'but the same marker after a space is');
  ok(citationParts('(see [2])', sources).some((p) => p.type === 'cite'),
    'and so is one after punctuation');

  ok(citationParts('No markers at all.', sources).every((p) => p.type === 'text'),
    'an answer that cites nothing is all text');
  ok(citationParts('Cited [1] anyway.', []).every((p) => p.type === 'text'),
    'and with no sources, nothing is linked');
  ok(citationParts('', sources).length === 0, 'an empty answer produces no parts');
  ok(citationParts(undefined, undefined).length === 0, 'and neither does nothing at all');

  // The same source cited twice is two links, not one.
  ok(citationParts('First [1] and again [1].', sources).filter((p) => p.type === 'cite').length === 2,
    'a source cited twice produces two links');
}

console.log('\nwhich LLM writes the prompt\n');

{
  // Nobody has expressed a view: undefined, so the backend applies the
  // configured default. One place decides what the default is.
  ok(chooseModel({}, {}) === undefined, 'with no preference and no override, the config default stands');
  ok(chooseModel({}, { prompt_llm: '' }) === undefined, 'and an empty preference means the same');
  ok(chooseModel({}, { prompt_llm: '   ' }) === undefined, 'whitespace is not a choice');
  ok(chooseModel(undefined, undefined) === undefined, 'and neither is nothing at all');

  // The reason this control exists: the default model declines some of what
  // this group makes, and switching used to mean editing config for everyone.
  ok(chooseModel({}, { prompt_llm: 'some-uncensored:Q5' }) === 'some-uncensored:Q5',
    'a personal choice is used for a target with no opinion');

  // A target that pins its own LLM does so on measured grounds — the registry
  // wins, and the panel says so rather than silently ignoring the choice.
  ok(chooseModel({ llm_model: 'big:model' }, { prompt_llm: 'some-uncensored:Q5' }) === 'big:model',
    'a registry override beats a personal choice');
  ok(chooseModel({ default_llm_model: 'soft:27b' }, {}) === 'soft:27b',
    'a soft default is used when the user has no preference');
  ok(chooseModel({ default_llm_model: 'soft:27b' }, { prompt_llm: 'mine:Q5' }) === 'mine:Q5',
    'a soft default is overridden by a user choice');
  ok(chooseModel({ llm_model: 'hard:x', default_llm_model: 'soft:y' }, { prompt_llm: 'mine' }) === 'hard:x',
    'a hard pin still beats everything');
  ok(chooseModel({ llm_model: 'big:model' }, {}) === 'big:model',
    'and stands on its own when nobody chose anything');
}

{
  // The registry is the source of that rule, so check it has not quietly
  // changed shape: whichever targets pin a model, the frontend names them in
  // the account panel from this same field.
  const reg = loadRegistry(ROOT, { warn: () => {} });
  const pinned = reg.all().filter((m) => m.llm_model);
  ok(pinned.every((m) => typeof m.llm_model === 'string' && m.llm_model.length > 0),
    'every pinned llm_model is a real string', pinned.map((m) => m.key).join(','));
  ok(reg.all().some((m) => !m.llm_model),
    'and at least one target has no opinion, or the preference could never apply');
}

console.log('\nchat model selector - grouped by what is actually in VRAM\n');

{
  // The three sources /api/status carries, as Ollama reports them: the
  // installed list from /v1/models, what is resident from /api/ps, and the
  // sizes from /api/tags.
  const llm = {
    model: 'qwen3:8b',
    installed: ['qwen3:8b', 'qwen3:1.7b', 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL'],
    resident: [{ model: 'qwen3:8b', size_bytes: 5.2e9, vram_bytes: 5.2e9 }],
    catalog: [
      { model: 'qwen3:8b', size_bytes: 5.2e9 },
      { model: 'qwen3:1.7b', size_bytes: 1.4e9 },
      { model: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL', size_bytes: 17e9 },
    ],
  };

  const groups = chatModelGroups(llm);
  ok(groups.loaded.length === 1 && groups.loaded[0].model === 'qwen3:8b',
    'the resident model is the loaded group', JSON.stringify(groups.loaded.map((r) => r.model)));
  ok(groups.available.length === 2, 'and everything else installed is available',
    JSON.stringify(groups.available.map((r) => r.model)));
  ok(groups.available.every((r) => r.size_bytes > 0),
    'each carries its size, so a swap can be costed before the click');
  ok(groups.configured === 'qwen3:8b', 'and the configured default is named');

  // Ollama-only fields. A llama.cpp or vLLM box holds one model chosen at
  // start, so the selector degrades to names with no sizes rather than
  // showing an empty list.
  const bare = chatModelGroups({ model: 'local', installed: ['local'] });
  ok(bare.available.length === 1 && bare.available[0].size_bytes === null,
    'a backend that cannot report sizes still lists its model',
    JSON.stringify(bare.available));
  ok(chatModelGroups(undefined).loaded.length === 0,
    'and no status at all produces empty groups rather than throwing');

  // The note under the selector, which is the spec's "VRAM cost shown before
  // the swap".
  const loaded = chatModelNote('qwen3:8b', groups);
  ok(/Loaded/.test(loaded.text) && loaded.warm === false,
    'a resident model says so plainly', loaded.text);

  const cold = chatModelNote('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL', groups);
  ok(/17.0 GB/.test(cold.text), 'an unloaded one is costed in GB before the click', cold.text);
  ok(/may have to drop qwen3:8b/.test(cold.text),
    'and names what the card may have to drop for it', cold.text);
  ok(cold.warm === true, 'which is the one state worth colouring');

  // Deliberately "may". Ollama holds as many models as fit, and this page
  // cannot add up VRAM honestly enough to promise an eviction.
  ok(!/will unload|will be unloaded/.test(cold.text),
    'it does not promise an unload it cannot know about', cold.text);

  // A conversation started on a model since removed, or a page left open
  // across a pull. The next message would fail; saying so here is cheaper
  // than finding out at send time.
  const gone = chatModelNote('gemma3:27b', groups);
  ok(/not installed/.test(gone.text) && gone.warm === true,
    'a model that is gone is called out rather than silently reverted', gone.text);

  ok(chatModelNote(null, { loaded: [], available: [], configured: null }).text === '',
    'and with nothing known at all the note is empty, not a guess');
}

{
  // Since the chat model became selectable, a chat job carries the LLM tag it
  // is being answered on. "Chatting" without saying on what leaves the panel
  // unable to explain why the card is busy.
  const chat = doingLabel({ state: 'running', kind: 'chat', seconds: 6 }, 'qwen3:1.7b');
  ok(chat.text === 'Chatting · qwen3:1.7b · 6s', 'a chat job names the model answering it', chat.text);
}

console.log('\nwhich LLM writes the prompt - the Tab 1 control\n');

{
  // The ordinary case: a target with no opinion, and whatever the person
  // chose is in effect.
  const free = promptLlmState({ key: 'sdxl', label: 'SDXL 1.0' }, 'some-uncensored:Q5', 'qwen3:8b');
  ok(free.value === 'some-uncensored:Q5' && free.disabled === false,
    'a target with no opinion leaves the choice alone', JSON.stringify(free));
  // A note restating the dropdown back at the reader is noise on every render.
  ok(free.note === '', 'and says nothing, because there is nothing to say');

  const unset = promptLlmState({ key: 'pony', label: 'Pony Diffusion V6' }, '', 'qwen3:8b');
  ok(unset.value === '' && unset.disabled === false,
    'no choice made means the default entry is selected', JSON.stringify(unset));

  // The one that matters. h3 pins the 27B in the registry because the 8B
  // fails its base-mode discipline eight times in ten - a measured
  // requirement, not a preference, and a personal setting must not quietly
  // override it.
  const pinned = promptLlmState(
    { key: 'h3', label: 'MiniMax H3', llm_model: 'big:27b' },
    'some-uncensored:Q5',
    'qwen3:8b'
  );
  ok(pinned.value === 'big:27b', 'a pinned target shows the model it actually uses', pinned.value);
  ok(pinned.disabled === true, '...and does not offer a choice that would be ignored');
  ok(/always uses big:27b/.test(pinned.note) && /MiniMax H3/.test(pinned.note),
    '...and says so by name rather than silently ignoring the preference', pinned.note);

  // Nothing selected yet, before the first model loads.
  const nothing = promptLlmState(null, '', 'qwen3:8b');
  ok(nothing.disabled === false && nothing.value === '',
    'no target yet is not an error state', JSON.stringify(nothing));
}

console.log('\nqueue controls - why they are inert, when they are\n');

{
  // Reported as "moving up priority doesn't work". It did work; there was one
  // job in the line, so every control was correctly disabled and nothing said
  // why. Three greyed buttons with no explanation are indistinguishable from
  // a broken feature.
  const alone = queueNote(1, 1, true);
  ok(/nothing to reorder/i.test(alone), 'one waiting job explains that there is nothing to reorder', alone);
  ok(/cannot be moved/i.test(alone),
    '...and that the job holding the GPU is not movable, which is the other half of the confusion', alone);

  const many = queueNote(3, 1, true);
  ok(/reorder the waiting line/i.test(many), 'a real line explains what the controls do', many);

  // Everyone sees the line; only the owner gets buttons. A non-owner reading
  // "nothing to reorder" would be told about a control they do not have.
  const guest = queueNote(3, 1, false);
  ok(!/reorder/i.test(guest) && /Waiting for/i.test(guest),
    'a non-owner is told why they are waiting, not about controls they lack', guest);

  ok(queueNote(0, 0, true) === '', 'an empty line says nothing at all');
}

console.log('\nstale-process detection\n');

{
  // Three bug reports in one session on 22 Aug were all the same thing: a
  // server started before the fix. The static files are served fresh from
  // disk, so the page looks current while the API behind it is not, and
  // nothing anywhere said so.
  const watch = createVersionWatch(ROOT);
  const info = watch.info();

  ok(typeof info.stale === 'boolean', 'it always answers, even outside a checkout');
  ok(info.stale === false, 'a process booted from the current commit is not stale', JSON.stringify(info));
  ok(info.boot_commit === null || info.boot_commit.length === 7,
    'commits are reported short', String(info.boot_commit));
  ok(Boolean(Date.parse(info.booted_at)), 'and it records when it booted');

  // Unknown on either side must read as unknown, never as stale: a warning
  // that restarting cannot clear would be worse than no warning.
  const nowhere = createVersionWatch(path.join(ROOT, 'not-a-checkout'));
  ok(nowhere.info().stale === false, 'outside a git checkout it never cries stale',
    JSON.stringify(nowhere.info()));
  ok(headCommit(path.join(ROOT, 'not-a-checkout')) === null,
    'and an unreadable HEAD is null rather than a throw');
}

console.log('\nquality preset - None by default, and it follows you\n');

{
  const ill  = ['masterpiece', 'high_quality', 'standard'];
  const pony = ['standard_ladder', 'extended_ladder'];
  const sdxl = ['masterpiece', 'standard', 'none'];
  const p = presetForModel;

  // Rule 1, the one that must never break: a deliberate "no quality tags"
  // does not become tags because you changed model.
  ok(p('', -1, ill) === '', 'None stays None');
  ok(p('', -1, pony) === '', '...across a model with entirely different presets');
  // SDXL declares its own empty preset called `none`, so there the empty
  // choice is spelled with its key rather than ''.
  ok(p('', -1, sdxl, true) === 'none', '...and uses the registry key where one exists', p('', -1, sdxl, true));
  ok(p('none', 2, ill) === '', 'and the SDXL none key reads as None on a model without it');

  // Rule 2: an exact name wins. Illustrious, SDXL and Anima share vocabulary,
  // so most switches are exact.
  ok(p('masterpiece', 0, ill) === 'masterpiece', 'the same preset name is kept');
  ok(p('standard', 2, sdxl, true) === 'standard', '...even at a different position');

  // Rule 3: position carries intent where names cannot. Pony's presets are
  // score ladders with their own names, so nothing matches - and resetting to
  // None every time would mean re-picking a ladder on every switch.
  ok(p('high_quality', 1, pony) === 'extended_ladder',
    'second in one list becomes second in another', p('high_quality', 1, pony));
  ok(p('standard', 2, pony) === '',
    'a position the new model does not have falls back to None', p('standard', 2, pony));
  // A reload loses the index; falling back to None is the safe direction,
  // since it is the one that adds nothing you did not ask for.
  ok(p('high_quality', -1, pony) === '', 'an unknown position falls back to None');
}

console.log('\nclampDuration — the timeline and the request must agree\n');
{
  ok(clampDuration(5, 60) === 5, 'a value inside the range is untouched');
  ok(clampDuration(20, 60) === 20, '...including a long one');
  // The measured bug: 200 drew a 60s timeline and sent duration_seconds 200.
  ok(clampDuration(200, 60) === 60, 'past the ceiling comes back as the ceiling');
  ok(clampDuration(0, 60) === 0.5, 'zero becomes the floor, not a clip with no timeline');
  ok(clampDuration(-4, 60) === 0.5, '...and so does a negative');
  ok(clampDuration('', 60) === 0.5, 'an empty box is the floor rather than NaN');
  ok(clampDuration('abc', 60) === 0.5, '...and so is nonsense');
  ok(clampDuration('12.5', 60) === 12.5, 'the string a number input actually gives is parsed');
  ok(clampDuration(200, '') === 200, 'with no ceiling known, the value stands');
}

console.log('\nformatElapsed — the stamp must read like the counter did\n');
{
  ok(formatElapsed(0) === '0s', 'nothing yet');
  ok(formatElapsed(39017) === '39s', 'the measured final round, rounded to the second');
  ok(formatElapsed(59400) === '59s', 'under a minute reads in seconds alone');
  // Rounding, not truncation — 59.8s has ticked over to the minute already.
  ok(formatElapsed(59810) === '1m 00s', '...and rounds up into one when it is closer');
  ok(formatElapsed(62000) === '1m 02s', 'past a minute the seconds stay two digits');
  ok(formatElapsed(165000) === '2m 45s', 'the cold-prefix run from 5 Sep');
}

console.log('\ncontrols replaced by a custom widget must still be collected\n');
{
  // collectControls() skips anything inside [hidden] — that is how a first/last
  // frame picked before the mode changed stops riding along unseen. It also
  // means `hidden` is the wrong way to take a control OFF SCREEN while keeping
  // it live, and h3's Mode select is exactly that case: the Director panel's
  // pill row is the visible control and the select is what it writes into.
  //
  // Marking that label `hidden` cost nothing visible and silently dropped
  // `mode` from every h3 request — which picks the reference guide, the lane
  // limits and the resolved Auto detect. Caught in a browser, not by a test,
  // which is why there is now a test.
  const tplDir = path.join(ROOT, 'web/templates');
  const bad = [];
  for (const file of readdirSync(tplDir).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(path.join(tplDir, file), 'utf8');
    // Every element that both binds a collected control and carries a bare
    // `hidden` attribute on the SAME tag. A wrapper genuinely toggled at
    // runtime is a different thing and is not matched here.
    for (const tag of html.match(/<[^>]*data-bind="(?:mode|duration|aspect_ratio|style|quality_preset)"[^>]*>/g) ?? []) {
      if (/\shidden(?=[\s/>=])/.test(tag)) bad.push(`${file}: ${tag.trim().slice(0, 90)}`);
    }
    for (const tag of html.match(/<label[^>]*\shidden[^>]*>/g) ?? []) {
      // A hidden <label> whose binding name ends _field wraps a control. The
      // one that matters is mode_field; the pattern is what generalises.
      if (/data-bind="mode_field"/.test(tag)) bad.push(`${file}: ${tag.trim().slice(0, 90)}`);
    }
  }
  ok(
    bad.length === 0,
    'no collected control is hidden with the hidden attribute',
    bad.length ? `${bad.join('; ')}. Hide it with a class — collectControls() skips [hidden].` : ''
  );
}

// ── cancelling has to actually cancel ────────────────────────
//
// A source-level assertion, and deliberately so: the behaviour it guards took
// a live GPU and an instrumented server to see, and is invisible every other
// way.
//
// Measured on the P40, 5 Sep 2026. When a client goes away mid-generation
// `res` emits 'close' and `req` does NOT — the request stream ended long
// before, when its body was read. Every abort controller was wired to
// `req.on('close')`, so none of them ever fired: the upstream generation ran
// to completion on the GPU, and the handler never reached the `finally` that
// releases the queue ticket. Reported as Stop doing nothing, and then queueing
// behind your own abandoned job to wait out the rest of it.
//
// Nothing errored. No log line, and the queue correctly reported a job running
// because one genuinely was. That is why this is pinned to the source instead
// of being left to be rediscovered.
{
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const onReq = (src.match(/req\.on\('close'/g) ?? []).length;
  const onRes = (src.match(/res\.on\('close'/g) ?? []).length;
  const controllers = (src.match(/new AbortController\(\)/g) ?? []).length;

  ok(
    onReq === 0,
    "no 'close' handler is wired to req",
    onReq
      ? `${onReq} still on req — a client disconnect does not fire it, so the ` +
        'abort never runs and the queue ticket is never released. Use res.'
      : ''
  );
  ok(
    onRes >= controllers && controllers > 0,
    'every AbortController is paired with a res close handler',
    `${onRes} res handlers for ${controllers} controllers`
  );
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
