// MiniMax H3 Director, Simple prompt mode: the whole prompt in one block.
//
// the DaSiWa Director node has two ways to take a prompt. Structured is
// what this app was built against: three fields (six in REF2VA), and the node
// adds the picture-alignment line and every field name itself before the
// prompt reaches H3. Simple is one text box, sent verbatim. From its
// helper_minimax_h3_prompt_builder.py:
//
//     simple_prompt = state.get("simple_prompt")
//     if isinstance(simple_prompt, str):
//         return simple_prompt.strip()
//
// Nothing is added. So a Simple prompt has to carry, as text, everything the
// node would have added in Structured mode — and our segments deliberately
// carry none of it, because the model is told the node writes those lines.
//
// This assembles that text in code rather than asking the model for it. The
// model's output is identical either way; what differs is only what the node
// would have wrapped around it, and that is mechanical. The target is the
// string the node's Structured mode sends, build_base_prompt and
// build_ref_prompt, quoted below where each rule comes from.
//
// One deliberate difference, the shot number in the FL2VA and L2VA alignment
// lines. The node hardcodes `Shot 2` and `[Shot 1]`; the official guide (base
// 2.1) writes `(from Shot N)`, the shot the end frame belongs to, and its own
// FL2VA worked example has one shot and says `Shot 1`. This takes the last
// `[Shot N]` in the description, which is the guide's rule and agrees with the
// node whenever the node happens to be right.
//
// Pure functions, no I/O.

import { resolveAutoMode } from './references.mjs';

/** Segment label to the node's field name, per format. Order is output order. */
const BASE_FIELDS = [
  ['Detailed description', 'integrated_multimodal_description'],
  ['Soundscape', 'overall_soundscape'],
  ['Music', 'non_diegetic_music'],
];
const REF_FIELDS = [
  ['Subject definitions', 'subject_definitions'],
  ['Summary', 'summary'],
  ['Retention analysis', 'retention_analysis'],
  ['Detailed description', 'detailed_description'],
  ['Soundscape', 'overall_soundscape'],
  ['Music', 'non_diegetic_music'],
];

const BASE_MODES = new Set(['T2VA', 'I2VA', 'FL2VA', 'L2VA']);

/**
 * The node's frame-snapped duration, as it writes it into an alignment line.
 *
 * A port of fmt_ss: the frame count is snapped UP to the 17k+5 grid at 24 fps
 * — always 24, whatever the node's frame_rate input says — and printed to two
 * places. The rounding is Python's round(), which is half-to-even, and it
 * matters here: 10 s snaps to 243 frames, 10.125 s, which Python prints as
 * 10.12 and Math.round would make 10.13. Checked against the node's own
 * module for every duration h3 offers: 5.17, 8.00, 10.12, 12.25, 15.08.
 *
 * null for a duration that is missing or not a positive number. Not a
 * default: NaN never satisfies the grid test, so without this guard the loop
 * below never ends, and any fallback number would be an end mark the clip
 * does not have.
 */
export function snappedSecondsText(seconds) {
  const n = Number(seconds);
  if (seconds == null || seconds === '' || !Number.isFinite(n) || n <= 0) return null;
  let frames = Math.max(5, Math.trunc(n * 24));
  while (frames % 17 !== 5) frames += 1;
  const x = (frames / 24) * 100;
  const floor = Math.floor(x);
  const frac = x - floor;
  const rounded = frac > 0.5 ? floor + 1 : frac < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  return (rounded / 100).toFixed(2);
}

/** The highest `[Shot N]` in a description, or 1 when it names none. */
export function lastShot(description) {
  let max = 0;
  for (const m of String(description ?? '').matchAll(/\[Shot\s+(\d+)\]/gi)) {
    max = Math.max(max, Number(m[1]));
  }
  return max || 1;
}

/**
 * The line the node puts ahead of the fields, or '' for a mode that has none.
 *
 * Wording is build_base_prompt's, character for character — including FL2VA's
 * `Picture 1 (from Shot 1)` without angle brackets, which is also how the
 * official guide writes it — apart from the shot number, see the top of this
 * file.
 *
 * null when the mode needs an end mark and there is no usable duration.
 */
export function alignmentLine(mode, { durationSeconds, shot = 1 } = {}) {
  if (mode === 'I2VA') {
    return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  }
  if (mode !== 'FL2VA' && mode !== 'L2VA') return '';
  const S = snappedSecondsText(durationSeconds);
  if (S == null) return null;
  if (mode === 'FL2VA') {
    return (
      'How the reference pictures align with the target video — ' +
      'Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; ' +
      `Picture 2 (from Shot ${shot}) aligns with the ${S}-second mark of the target video.`
    );
  }
  // L2VA, the only mode left by here.
  return (
    'How the reference pictures align with the target video — ' +
    `<Picture 1> (from [Shot ${shot}]) aligns with the ${S}-second mark of the target video.`
  );
}

/**
 * A segment body without the field name the model sometimes writes in front
 * of it. It is told not to, and does anyway on some runs — segment_fields in
 * config/models.yaml exists for exactly this. Left in, the assembled prompt
 * would read `overall_soundscape: overall_soundscape: …`.
 */
function bare(body, names) {
  const alts = names
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return String(body ?? '')
    .replace(new RegExp(`^\\s*(?:${alts})\\s*:\\s*`, 'i'), '')
    .trim();
}

/**
 * The Simple-mode prompt for a finished result, or null when there isn't one.
 *
 * null — not an empty string — for a model without `simple_prompt`, or a mode
 * the node does not have. The client shows the fields when this is null, so a
 * result that has no Simple form can never be shown as though it did.
 *
 * @param {object} model     registry entry
 * @param {object} controls  the request's controls; Auto detect is resolved here
 * @param {Array<{label:string, body:string}>} segments  the cleaned result
 */
export function simplePrompt(model, controls = {}, segments = []) {
  if (!model?.simple_prompt) return null;
  const mode = resolveAutoMode(controls.mode, controls.references);
  if (mode !== 'REF2VA' && !BASE_MODES.has(mode)) return null;

  const byLabel = new Map((segments ?? []).map((s) => [s.label, s.body]));
  const value = (label, field) =>
    bare(byLabel.get(label), [label, model.segment_fields?.[label], field]);

  if (mode === 'REF2VA') {
    // build_ref_prompt: each header on its own line, the body under it, and
    // music falls back to N/A when blank.
    return REF_FIELDS.map(([label, field]) => {
      const v = value(label, field);
      return `${field}:\n${field === 'non_diegetic_music' ? v || 'N/A' : v}`;
    }).join('\n\n');
  }

  // build_base_prompt: header and body on one line, the same N/A fallback.
  const body = BASE_FIELDS.map(([label, field]) => {
    const v = value(label, field);
    return `${field}: ${field === 'non_diegetic_music' ? v || 'N/A' : v}`;
  }).join('\n\n');
  const head = alignmentLine(mode, {
    durationSeconds: controls.duration ?? controls.duration_seconds,
    shot: lastShot(value('Detailed description', 'integrated_multimodal_description')),
  });
  // An end-anchored mode with no duration: no Simple form rather than a
  // prompt with a made-up end mark. The panel shows the fields instead.
  if (head === null) return null;
  return head ? `${head}\n\n${body}` : body;
}
