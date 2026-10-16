// Segment parser for the ===SEGMENT: Label=== output contract.
//
// Every prompt file specifies an exact output contract using these
// delimiters. This module splits on them, validates against the model's
// declared segment list, and feeds `segment` SSE events. When the model
// returns something unparseable it must surface a clear error rather than
// silently rendering raw text — a wrong-format prompt is a bug in the prompt
// file, and hiding it means nobody ever fixes it.
//
// Two contract wrinkles that are easy to get wrong:
//
//   1. `Refused` is accepted from every model even though no model lists it.
//      house-rules.md mandates it for policy refusals while also saying
//      "never emit a segment that is not in your list", so a strict reading
//      of the per-model list turns every refusal into a parse error.
//      A refusal satisfies the contract on its own.
//
//   2. `Reasoning` is not universal. Krea2 and Flux end with "What changed",
//      LTX with "Improvement notes". Nothing here may assume a label — the
//      expected list always comes from the registry.

import { REFUSAL_SEGMENT } from './registry.mjs';

const DELIMITER = /^===SEGMENT:\s*(.+?)\s*===\s*$/gm;

export class SegmentParseError extends Error {
  constructor(code, message, { raw = '', expected = [], found = [], misplaced = [] } = {}) {
    super(message);
    this.name = 'SegmentParseError';
    this.code = code;
    this.raw = raw;
    this.expected = expected;
    this.found = found;
    // Labels whose content arrived inside another segment rather than not at
    // all. Distinct from `found`, and worth keeping structured: a retry is
    // worth offering for these, where a genuine omission may not be.
    this.misplaced = misplaced;
  }
}

/**
 * Parse a complete model response into ordered segments.
 * @param {string} text  raw model output
 * @param {string[]} expected  the model's declared segment labels, in order
 * @returns {{segments: {label: string, body: string}[], refused: boolean}}
 */
export function parseSegments(text, expected, { discard = [], aliases = {} } = {}) {
  const raw = String(text ?? '');
  const matches = [...raw.matchAll(DELIMITER)];
  // `aliases` maps another name for a segment to its label - the registry's
  // segment_fields, read backwards. The h3 4B sometimes heads its music
  // `non_diegetic_music`, the official field name, and a whole continuation
  // failed over it (2 chains in 3, 12 Oct 2026).
  const labelOf = (name) => (Object.hasOwn(aliases, name) ? aliases[name] : name);

  if (matches.length === 0) {
    throw new SegmentParseError(
      'no_segments',
      'The model returned no ===SEGMENT: markers. Its system prompt defines an exact output contract that it did not follow.',
      { raw, expected }
    );
  }

  // Anything before the first marker violates "nothing before the first
  // ===SEGMENT: line". Tolerate whitespace; flag real preamble, since it
  // usually means the model prepended "Here is your prompt".
  const preamble = raw.slice(0, matches[0].index).trim();

  const segments = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    return { label: labelOf(m[1].trim()), body: raw.slice(start, end).trim() };
  });

  const found = segments.map((s) => s.label);

  // A refusal stands alone and satisfies the contract by itself.
  if (found.includes(REFUSAL_SEGMENT)) {
    return {
      segments: segments.filter((s) => s.label === REFUSAL_SEGMENT),
      refused: true,
      preamble,
    };
  }

  // `discard` is what the person switched OFF. Allowed but not required, and
  // dropped from the result either way.
  //
  // Both halves matter. Not required, because the whole point is that the
  // model stops writing it. Still allowed, because its own prompt file lists
  // that segment under "Segments to emit" and will often produce it anyway —
  // and a run that fails with unknown_segment because the model was too
  // obedient would be a worse feature than not having the switch.
  const dropped = new Set(discard);
  const allowed = new Set([...expected, ...dropped]);
  const unknown = found.filter((l) => !allowed.has(l));
  if (unknown.length) {
    throw new SegmentParseError(
      'unknown_segment',
      `The model emitted ${unknown.length === 1 ? 'a segment' : 'segments'} not in its contract: ${unknown.map((u) => `"${u}"`).join(', ')}.`,
      { raw, expected, found }
    );
  }

  const missing = expected.filter((l) => !found.includes(l));
  if (missing.length) {
    throw new SegmentParseError(
      'missing_segment',
      `The model omitted required ${missing.length === 1 ? 'segment' : 'segments'}: ${missing.map((m) => `"${m}"`).join(', ')}. Segments with no content should be "N/A", not dropped.`,
      { raw, expected, found }
    );
  }

  // Order matters — the panel renders in contract order.
  const outOfOrder = found.some((label, i) => label !== expected[i]);
  if (outOfOrder) {
    segments.sort((a, b) => expected.indexOf(a.label) - expected.indexOf(b.label));
  }

  return { segments, refused: false, preamble, outOfOrder };
}

/**
 * Incremental parser for streaming. Feed it token text; it emits each
 * segment as soon as the *next* delimiter proves that segment is complete,
 * which is what makes the output panel fill in progressively.
 */
export class SegmentStream {
  constructor(expected, { onSegment, fields = {}, discard = [] } = {}) {
    this.expected = expected;
    // Segments the person switched off. See the note in parseSegments: these
    // are allowed but never required, and never reach onSegment — a discarded
    // segment must not stream into the panel and then vanish at the end.
    this.discard = new Set(discard);
    // Segment label -> official field name, from the registry's
    // `segment_fields`. Used only to explain a missing segment accurately;
    // nothing is recovered or rewritten from it. See #locate().
    this.fields = fields;
    this.onSegment = onSegment ?? (() => {});
    this.buffer = '';
    this.current = null;      // { label, body }
    this.emitted = [];
    this.refused = false;
  }

  push(chunk) {
    this.buffer += chunk;

    // Only consume up to the last newline — a delimiter split across chunks
    // must not be matched half-formed.
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.#line(line);
    }
  }

  #line(line) {
    const m = /^===SEGMENT:\s*(.+?)\s*===\s*$/.exec(line);
    if (m) {
      this.#flush();
      this.current = { label: m[1].trim(), body: '' };
      if (this.current.label === REFUSAL_SEGMENT) this.refused = true;
      return;
    }
    if (this.current) this.current.body += line + '\n';
    // Text before the first delimiter is dropped here and caught by the
    // whole-response validation in end().
  }

  #flush() {
    if (!this.current) return;
    const seg = { label: this.current.label, body: this.current.body.trim() };
    this.current = null;
    // Swallowed before it is emitted OR streamed. The refusal segment is
    // never discardable — it is how a model declines, and hiding that would
    // turn a refusal into an empty panel.
    if (this.discard.has(seg.label) && seg.label !== REFUSAL_SEGMENT) return;
    this.emitted.push(seg);
    this.onSegment(seg);
  }

  /**
   * Which emitted segment, if any, contains `label`'s official field name as a
   * line prefix. Returns the containing segment's label, or null.
   *
   * Deliberately narrow: it matches `field_name:` at the start of a line, not
   * a mention anywhere in the text, so a description that merely discusses the
   * soundscape is not mistaken for one carrying the field.
   */
  #locate(label) {
    const field = this.fields?.[label];
    if (!field) return null;
    const re = new RegExp(`^\\s*${field}\\s*:`, 'im');
    return this.emitted.find((s) => re.test(s.body))?.label ?? null;
  }

  /** Finish the stream and validate the whole contract. Throws SegmentParseError. */
  end() {
    if (this.buffer.trim()) this.#line(this.buffer);
    this.buffer = '';
    this.#flush();

    if (this.refused) {
      return {
        segments: this.emitted.filter((s) => s.label === REFUSAL_SEGMENT),
        refused: true,
      };
    }

    if (this.emitted.length === 0) {
      throw new SegmentParseError(
        'no_segments',
        'The model returned no ===SEGMENT: markers. Its system prompt defines an exact output contract that it did not follow.',
        { expected: this.expected }
      );
    }

    const found = this.emitted.map((s) => s.label);
    // Discarded labels never reach `emitted`, so they cannot show up as
    // unknown here — but the set stays in the check so the rule reads the same
    // way in both parsers.
    const allowed = new Set([...this.expected, ...this.discard]);
    const unknown = found.filter((l) => !allowed.has(l));
    if (unknown.length) {
      throw new SegmentParseError(
        'unknown_segment',
        `The model emitted ${unknown.length === 1 ? 'a segment' : 'segments'} not in its contract: ${unknown.map((u) => `"${u}"`).join(', ')}.`,
        { expected: this.expected, found }
      );
    }
    const missing = this.expected.filter((l) => !found.includes(l));
    if (missing.length) {
      // "Omitted" is often not what happened. Measured on the 27B: h3 writes
      // the audio content inside `Detailed description` under the base guide's
      // own field names on roughly 10% of base-mode runs, because that guide
      // presents its three core fields as one block. Telling the user the model
      // dropped content it plainly wrote is a misleading error, and it points
      // them at the wrong fix.
      //
      // This only changes the message. Nothing is recovered or re-split: the
      // contract still failed, and silently repairing it would hide a real
      // format problem behind output that looked fine.
      const elsewhere = missing.filter((label) => this.#locate(label));
      const dropped = missing.filter((label) => !this.#locate(label));

      const parts = [];
      if (dropped.length) {
        parts.push(
          `The model omitted required ${dropped.length === 1 ? 'segment' : 'segments'}: ${dropped
            .map((m) => `"${m}"`)
            .join(', ')}. Segments with no content should be "N/A", not dropped.`
        );
      }
      if (elsewhere.length) {
        parts.push(
          `${elsewhere.map((m) => `"${m}"`).join(' and ')} ${elsewhere.length === 1 ? 'was' : 'were'} written inside "${this.#locate(elsewhere[0])}" instead of as ${elsewhere.length === 1 ? 'its own segment' : 'their own segments'} — the content is there, the format is wrong. Retrying usually fixes it.`
        );
      }

      throw new SegmentParseError('missing_segment', parts.join(' '), {
        expected: this.expected,
        found,
        misplaced: elsewhere,
      });
    }

    return { segments: this.emitted, refused: false };
  }
}

/**
 * Which of a model's segments a person is allowed to switch off.
 *
 * Two kinds, and no third. The `meta_segments` — Reasoning, What changed,
 * Improvement notes, Layer breakdown — are the model explaining itself, and
 * are already excluded from a copied prompt. And the negative prompt, on the
 * models that have one.
 *
 * Everything else is the thing the person came for. There is no switch that
 * turns off the Positive prompt.
 *
 * Derived rather than declared per model, so adding a model still costs one
 * registry entry. The negative is found by label because all three models that
 * have one call it "Negative prompt", and `has_negative: false` is what the
 * other three already say.
 */
export function optionalSegments(model) {
  const meta = model?.meta_segments ?? [];
  const negative =
    model?.has_negative === false
      ? []
      : (model?.segments ?? []).filter((l) => /negative/i.test(l));
  return [...new Set([...meta, ...negative])];
}

/**
 * Split a segment contract into what the model is asked for and what it is
 * allowed to write but will not be shown.
 *
 * `omit` is a list of labels, filtered against optionalSegments — a request to
 * drop "Positive prompt" is ignored rather than obeyed, because it is nonsense
 * and honouring it would produce an empty panel.
 *
 * The labels come from the person's stored preference, not from the request
 * body: this is a standing choice made once in the account panel, so a client
 * cannot ask for a segment layout the account did not choose.
 *
 * @param model     registry entry
 * @param omit      labels this account switched off, from its preferences
 * @param expected  the contract this request would otherwise have, which for
 *                  LTX Director is per-request rather than per-registry
 * @returns {{ required: string[], discard: string[] }}
 */
/**
 * What a person who has never touched the switches gets.
 *
 * Config decides, not code: `defaults.optional_segments_default` in
 * config/models.yaml is "off" or "on", and off means every optional segment
 * starts switched off.
 *
 * The caller passes the registry defaults rather than this reading them,
 * because segments.mjs is imported by registry.mjs and must not import back.
 */
export function defaultOmit(model, defaults) {
  return String(defaults?.optional_segments_default ?? 'on').toLowerCase() === 'off'
    ? optionalSegments(model)
    : [];
}

/**
 * The labels this account has switched off, falling back to the default.
 *
 * `undefined` and an empty array mean different things and must keep meaning
 * different things: no entry is "never touched, use the default", and an empty
 * entry is "ticked everything on". See the note in server/preferences.mjs.
 */
export function omitFor(model, prefs, defaults) {
  const stored = prefs?.omit_segments?.[model?.key];
  return Array.isArray(stored) ? stored : defaultOmit(model, defaults);
}

export function segmentPlan(model, omit, expected) {
  const optional = new Set(optionalSegments(model));
  const asked = Array.isArray(omit) ? omit : [];
  const discard = [...new Set(asked.filter((l) => optional.has(l)))];
  if (!discard.length) return { required: expected, discard: [] };
  return { required: expected.filter((l) => !discard.includes(l)), discard };
}
