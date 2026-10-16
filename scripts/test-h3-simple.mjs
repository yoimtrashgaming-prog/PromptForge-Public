// The h3 Director's Simple prompt, assembled from a result's segments.
//
//   node scripts/test-h3-simple.mjs
//
// No server, no model. The expected strings are what the DaSiWa Director's
// Structured mode sends — build_base_prompt and build_ref_prompt in its
// helper_minimax_h3_prompt_builder.py — because Simple mode sends its box
// verbatim and has to carry the same text. The snapped durations were printed
// by that module's own fmt_ss.

import { simplePrompt, snappedSecondsText, alignmentLine, lastShot } from '../server/h3-simple.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}
const eq = (what, got, want) => check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const h3 = {
  key: 'h3',
  simple_prompt: true,
  segment_fields: {
    Music: 'non_diegetic_music',
    Soundscape: 'overall_soundscape',
    'Detailed description': 'integrated_multimodal_description',
  },
};

const DESC = '[Shot 1] A wide shot.\n\n[Shot 2] At 00:03.000, the camera cuts to a close-up.';
const base = [
  { label: 'Detailed description', body: DESC },
  { label: 'Soundscape', body: 'Room tone.' },
  { label: 'Music', body: 'Sparse piano.' },
  { label: 'Reasoning', body: 'Why I did it.' },
];

// ── duration snapping, fmt_ss ────────────────────────────────
// Printed by the node's module, 14 Sep 2026. 10 s is the half-even case.
for (const [d, want] of [[5, '5.17'], [8, '8.00'], [10, '10.12'], [12, '12.25'], [15, '15.08'], ['10', '10.12']]) {
  eq(`fmt_ss(${JSON.stringify(d)})`, snappedSecondsText(d), want);
}

// ── shot counting ────────────────────────────────────────────
eq('last shot of two', lastShot(DESC), 2);
eq('no shots counts as Shot 1', lastShot('A single continuous take.'), 1);
eq('highest, not last written', lastShot('[Shot 3] a [Shot 1] b'), 3);

// ── the four base modes ──────────────────────────────────────
const FIELDS =
  'integrated_multimodal_description: ' + DESC + '\n\n' +
  'overall_soundscape: Room tone.\n\n' +
  'non_diegetic_music: Sparse piano.';

eq('T2VA has no alignment line', simplePrompt(h3, { mode: 'T2VA', duration: '10' }, base), FIELDS);
eq(
  'I2VA',
  simplePrompt(h3, { mode: 'I2VA', duration: '10' }, base),
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n' + FIELDS
);
eq(
  'FL2VA names the last shot and the snapped end',
  simplePrompt(h3, { mode: 'FL2VA', duration: '10' }, base),
  'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 10.12-second mark of the target video.\n\n' + FIELDS
);
eq(
  'L2VA names the last shot and the snapped end',
  simplePrompt(h3, { mode: 'L2VA', duration: '5' }, base),
  'How the reference pictures align with the target video — <Picture 1> (from [Shot 2]) aligns with the 5.17-second mark of the target video.\n\n' + FIELDS
);
check('Reasoning never reaches the prompt', !simplePrompt(h3, { mode: 'T2VA' }, base).includes('Why I did it'));

// ── what the model sometimes writes ──────────────────────────
const prefixed = [
  { label: 'Detailed description', body: 'integrated_multimodal_description: ' + DESC },
  { label: 'Soundscape', body: 'overall_soundscape: Room tone.' },
  { label: 'Music', body: 'Music: Sparse piano.' },
];
eq('field-name prefixes are not doubled', simplePrompt(h3, { mode: 'T2VA' }, prefixed), FIELDS);

const noMusic = base.map((s) => (s.label === 'Music' ? { ...s, body: '' } : s));
check(
  'blank music becomes N/A, as the node does',
  simplePrompt(h3, { mode: 'T2VA' }, noMusic).endsWith('non_diegetic_music: N/A')
);
check(
  'N/A written by the model stays N/A',
  simplePrompt(h3, { mode: 'T2VA' }, base.map((s) => (s.label === 'Music' ? { ...s, body: 'non_diegetic_music: N/A' } : s))).endsWith('non_diegetic_music: N/A')
);

// ── Auto detect is resolved, not passed through ──────────────
eq('Auto detect with no references is T2VA', simplePrompt(h3, { mode: 'Auto detect' }, base), FIELDS);
check(
  'Auto detect with one keyframe resolves to I2VA and gets its line',
  simplePrompt(h3, { mode: 'Auto detect', duration: '8', references: [{ role: 'keyframe' }] }, base)
    .startsWith('For the target video, at 0.00 seconds')
);
check(
  'Auto detect with two keyframes resolves to FL2VA',
  simplePrompt(h3, { mode: 'Auto detect', duration: '8', references: [{ role: 'keyframe' }, { role: 'keyframe' }] }, base)
    .includes('aligns with the 8.00-second mark')
);

// ── no duration ──────────────────────────────────────────────
// The bug the guard exists for: NaN never lands on the 17k+5 grid, so the
// snapping loop never ended and the whole suite hung on the first T2VA call.
eq('fmt_ss of nothing is null, not a hang', snappedSecondsText(undefined), null);
eq('fmt_ss of junk is null', snappedSecondsText('abc'), null);
eq('T2VA needs no duration', simplePrompt(h3, { mode: 'T2VA' }, base), FIELDS);
check('I2VA needs no duration', simplePrompt(h3, { mode: 'I2VA' }, base)?.startsWith('For the target video'));
eq('FL2VA without a duration has no Simple form', simplePrompt(h3, { mode: 'FL2VA' }, base), null);
eq('L2VA without a duration has no Simple form', simplePrompt(h3, { mode: 'L2VA' }, base), null);

// ── REF2VA: six headed sections ──────────────────────────────
const ref = [
  { label: 'Subject definitions', body: '<Subject 1> is the pilot in <Picture 1>.' },
  { label: 'Summary', body: '[reference generation] A 10-second sequence.' },
  { label: 'Retention analysis', body: '<Subject 1> (appears in [Shot 1]): fully_preserved.' },
  { label: 'Detailed description', body: 'detailed_description: ' + DESC },
  { label: 'Soundscape', body: 'Room tone.' },
  { label: 'Music', body: 'N/A' },
  { label: 'Reasoning', body: 'Why.' },
];
eq(
  'REF2VA',
  simplePrompt(h3, { mode: 'REF2VA', duration: '10' }, ref),
  'subject_definitions:\n<Subject 1> is the pilot in <Picture 1>.\n\n' +
    'summary:\n[reference generation] A 10-second sequence.\n\n' +
    'retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved.\n\n' +
    'detailed_description:\n' + DESC + '\n\n' +
    'overall_soundscape:\nRoom tone.\n\n' +
    'non_diegetic_music:\nN/A'
);

// ── when there is no Simple form ─────────────────────────────
eq('a model without simple_prompt gets null', simplePrompt({ key: 'ltx' }, { mode: 'T2VA' }, base), null);
eq('a mode the node does not have gets null', simplePrompt(h3, { mode: 'Image Inpaint' }, base), null);
eq('no mode at all gets null', simplePrompt(h3, {}, base), null);
eq('T2VA alignment line is empty', alignmentLine('T2VA', { durationSeconds: 10 }), '');

if (failures.length) {
  console.log(`
${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
// Bare count: check.mjs reads what is between the parentheses and appends
// "assertions" itself.
console.log(`ALL PASSED (${passed})`);
