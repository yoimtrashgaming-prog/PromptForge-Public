// LTX Director mode: the timeline, and what the model is required to return.
//
// WhatDreamsCost's LTX Director node concatenates the global prompt and every
// segment prompt into ONE string before the text encoder sees it. From its
// prompt_relay.py:
//
//     prefixed_locals = [" " + lp for lp in local_prompts]
//     full_prompt = global_prompt + "".join(prefixed_locals)
//
// and the single-segment path in ltx_director.py:
//
//     active_prompt = f"{global_prompt.strip()}, {local_p.strip()}"
//
// Nothing separates the pieces — no labels, no markers, no timecodes. The
// timing is carried by token ranges, not by anything in the text. Two things
// follow, and both are load-bearing:
//
//   1. The joined result must read as continuous prose, so ltx.md's single
//      flowing paragraph and its forbidden words still apply per segment.
//   2. A timecode written into a segment would be concatenated verbatim into
//      the prompt. Times are context for how much happens in a stretch, never
//      text to reproduce.
//
// Pure functions, no I/O, so they can be tested without standing up a server.

/**
 * The timeline for this request, or null when Director does not apply.
 *
 * null rather than [] on purpose: callers need to tell "not a Director
 * request" from "a Director request with an empty timeline". The first is the
 * ordinary path for every other model and mode; the second is a user error.
 *
 * @param {object} model     registry entry
 * @param {object} controls  the request's controls
 * @returns {null | Array<{index:number,start:number,end:number,brief:string}>}
 */
export function directorBlocks(model, controls = {}) {
  if (!Array.isArray(model?.modes) || !model.modes.includes('Director')) return null;
  if (String(controls.mode ?? '').toLowerCase() !== 'director') return null;

  const raw = Array.isArray(controls.segments) ? controls.segments : [];
  const max = model.director_max_segments ?? 8;
  return raw.slice(0, max).map((s, i) => ({
    index: i + 1,
    start: Number(s?.start) || 0,
    end: Number(s?.end) || 0,
    brief: typeof s?.brief === 'string' ? s.brief.trim() : '',
    // The keyframe for this stretch, if the person attached one. A data URI
    // the browser already downscaled, same as every other reference lane.
    //
    // The picture is what the segment OPENS on, not what happens across it —
    // that distinction is the whole feature. The owner's model of it, 4 Sep
    // 2026: "taking an image and making it x amount of time and typing what's
    // going on in that and between frames... build out a base of what's going
    // on and then have the llm populate what's going on between it". He gives
    // the frames, the model writes the motion from one to the next.
    image: typeof s?.image === 'string' && s.image ? s.image : null,
  }));
}

/** The blocks carrying a keyframe, in timeline order. [] when none do. */
export function directorKeyframes(model, controls = {}) {
  return (directorBlocks(model, controls) ?? []).filter((b) => b.image);
}

/**
 * What the model must return.
 *
 * Usually just the registry's list. Director mode is the exception: the
 * segment count is whatever the user put on the timeline, so the contract
 * cannot be static. Everything downstream — the parser, the missing-segment
 * error, the ordering rule — reads this list rather than the registry, so
 * nothing else has to know Director exists.
 */
export function expectedSegments(model, controls = {}) {
  const blocks = directorBlocks(model, controls);
  // The other per-request contract: a mode that has fewer fields than the
  // model's full list. h3's base modes have three official fields where REF2VA
  // has six, so asking a base mode for all seven meant asking for three it
  // could only ever answer N/A.
  if (!blocks) return model.segments_by_mode?.[controls.mode] ?? model.segments;
  return [
    'Global prompt',
    ...blocks.map((_, i) => `Segment ${i + 1}`),
    ...(model.meta_segments ?? []),
  ];
}

/**
 * The model's segments that this request's mode does not ask for.
 *
 * Allowed and dropped rather than failed. A model that has been writing
 * `Subject definitions: N/A` in T2VA for weeks may keep doing it, and a run
 * that dies on unknown_segment for writing an empty section nobody asked for
 * would be a worse feature than asking for it. Same rule the switched-off
 * segments already follow. [] whenever no per-mode contract applies —
 * including Director, which builds its own.
 */
export function segmentsOutsideMode(model, controls = {}) {
  const byMode = model.segments_by_mode?.[controls.mode];
  if (!byMode || directorBlocks(model, controls)) return [];
  return (model.segments ?? []).filter((l) => !byMode.includes(l));
}

/**
 * The lines that tell the model what the timeline is and how it will be
 * joined. Returns [] when Director does not apply, so the caller can spread
 * it unconditionally.
 */
export function directorLines(model, controls = {}) {
  const blocks = directorBlocks(model, controls);
  if (!blocks) return [];

  const lines = ['', 'Director timeline. Write one fragment per segment, in order.'];
  if (controls.duration_seconds) {
    lines.push(
      `Clip duration: ${controls.duration_seconds} seconds at ${controls.frame_rate ?? 24} fps.`
    );
  }
  lines.push(
    'The node joins your Global prompt and every Segment with single spaces into ONE prompt. ' +
      'Each segment must continue the previous one so the joined text reads as a single flowing ' +
      'paragraph. Do NOT write timecodes, labels, segment numbers or field names into any segment.'
  );
  // What the two kinds of segment ARE. The joining rule above says how the
  // pieces are stuck together and never said what belongs in each, which left
  // the model to guess the difference between the global and the first beat —
  // and a Global prompt that opens with the first beat means beat one is
  // described twice in the joined text.
  //
  // The punctuation rule below carries more than tidiness. ltx.md's whole
  // argument is that LTX reads a sentence boundary as a potential cut, and the
  // node's join adds a space and nothing else — so a piece that ends in a full
  // stop puts a cut on a timeline boundary, which is the exact failure
  // Director mode exists to avoid.
  lines.push(
    'Global prompt: who and where, the setting, the light and the overall look — ' +
      'everything true for the whole clip. It is the opening of the paragraph, so do not ' +
      'describe the first beat in it.',
    'Each Segment: what changes across that stretch, written as a continuation of the ' +
      'clause before it. Start mid-flow, not with a capital letter and a new sentence.',
    // Where the comma goes, which the join makes a rule rather than taste.
    //
    // Measured on the P40, 9 Sep 2026: told only to continue the clause, the
    // 27B started each segment with ", " — the natural way to write a
    // continuation, and wrong here. The multi-segment join is `global + " " +
    // seg` per fragment, so a leading comma lands as `...fading sky ,
    // crouched near the parapet` with a space in front of every one. The
    // segments read perfectly one at a time and the seam is where it shows,
    // which is why the probe prints the joined string.
    //
    // The single-segment path is the opposite case and gets the opposite
    // rule: `f"{global.strip()}, {local.strip()}"` supplies the comma itself,
    // so a Global prompt ending in one gives `sky,, crouched`. Both quoted
    // from the node's source at the top of this file.
    ...(blocks.length > 1
      ? [
          'Punctuation at the joins: the node inserts a space and nothing else, so end the ' +
            'Global prompt and every Segment except the last with a comma, and never begin one ' +
            'with punctuation. The last Segment ends the paragraph and takes the full stop.',
        ]
      : [
          'Punctuation at the join: the node supplies the comma between the Global prompt and ' +
            'the Segment, so end the Global prompt with no punctuation at all and do not begin ' +
            'the Segment with any. The Segment ends the paragraph and takes the full stop.',
        ]),
    // The label, spelled out, because the model keeps abbreviating it.
    //
    // Measured on the P40, 9 Sep 2026: the 27B emitted `===SEGMENT: 1===` for
    // all three, and the parser rejected the run naming "1", "2", "3" as
    // segments not in the contract. Reasonable of it — `===SEGMENT: Segment
    // 1===` says the word twice — but the parser is exact by design and
    // normalising a bare number into `Segment N` here would be the silent
    // repair segments.mjs refuses to do everywhere else.
    //
    // It sits next to the "do NOT write labels into any segment" rule on
    // purpose. That rule is about the segment BODY, this one is about the
    // delimiter, and separating them by ten lines is how they get read as
    // contradicting each other.
    'Label the delimiters exactly `===SEGMENT: Segment 1===`, `===SEGMENT: Segment 2===` ' +
      'and so on — the word "Segment" then the number. A bare number is not the label.',
    'Your word target is for the JOINED result, not for each segment. Split that budget ' +
      'across the Global prompt and the segments — a longer timeline means shorter fragments, ' +
      'not a longer prompt.'
  );

  // The arithmetic, done here rather than left to the model.
  //
  // Told only that the budget is for the joined text, the 27B wrote 174 words
  // across a global and three segments against ltx.md's 60-120 — measured on
  // the P40, 9 Sep 2026. It is not disobedience: "split the budget" leaves the
  // division to a model that is writing the pieces one at a time and cannot
  // see the total until it is over. Dividing it here is [[script-it-dont-
  // prompt-it]] — a deterministic sum belongs in code, and the model's job is
  // writing the prose.
  //
  // The numbers come from the registry, never restated: change word_target in
  // config/models.yaml and this line changes with it. Absent, and the budget
  // line above stands alone, which is what Director had before this.
  const { min, max } = model.word_target ?? {};
  if (Number.isFinite(min) && Number.isFinite(max)) {
    const parts = blocks.length + 1;
    lines.push(
      `That budget is ${min}–${max} words total across the Global prompt and all ` +
        `${blocks.length} segment${blocks.length === 1 ? '' : 's'} — roughly ` +
        `${Math.round(min / parts)}–${Math.round(max / parts)} words each. Count as you go.`
    );
  }
  for (const b of blocks) {
    const span = `${b.start}s to ${b.end}s`;
    lines.push(
      b.brief
        ? `Segment ${b.index} (${span}, context only): ${b.brief}`
        : `Segment ${b.index} (${span}, context only): continue the action; the user left this one blank.`
    );
  }
  return lines;
}

/**
 * The prose pieces of a Director result, in the order the node joins them.
 *
 * `Global prompt` then `Segment 1..N`. The meta segments are deliberately not
 * in here — `Improvement notes` is the model explaining itself and never
 * reaches the node, so nothing below may touch it.
 *
 * Returns [] when Director does not apply, so the caller can loop
 * unconditionally.
 */
export function directorProse(model, controls = {}) {
  const blocks = directorBlocks(model, controls);
  if (!blocks?.length) return [];
  return ['Global prompt', ...blocks.map((b) => `Segment ${b.index}`)];
}

/**
 * Fix the punctuation at the seams, in place.
 *
 * The model writes each fragment on its own and cannot see the joined result,
 * which is the only thing LTX ever reads. Told to continue the previous
 * clause it starts each segment with ", " — the natural way to write a
 * continuation, and wrong here, because the multi-segment join is
 * `global + " " + seg` per fragment and a leading comma lands as
 * `...fading sky , crouched near the parapet`. Measured on the P40, 9 Sep
 * 2026: three runs of three before directorLines() said where the comma goes,
 * and still one in three after.
 *
 * So the instruction stays AND this runs. Same split as the repeated-comma
 * tidy and server/parens.mjs: a character-level rule with one decidable answer
 * belongs in code, and the prompt keeps the judgement. Nothing here reads the
 * prose or changes a word of it — it only edits the first and last characters
 * of a fragment, against a join whose exact shape is quoted at the top of this
 * file and which the model has no way to see.
 *
 * The single-segment path is the opposite case: the node supplies `", "`
 * itself, so the Global prompt must end bare rather than with a comma.
 *
 * @param {object} model     registry entry
 * @param {object} controls  the request's controls
 * @param {Array<{label:string, body:string}>} segments  parsed result segments
 * @returns {string[]} the labels that were changed, for the log line
 */
export function fixDirectorSeams(model, controls = {}, segments = []) {
  const order = directorProse(model, controls);
  if (order.length < 2) return [];

  const byLabel = new Map(segments.map((s) => [s.label, s]));
  const pieces = order.map((l) => byLabel.get(l)).filter(Boolean);
  // A partial result is not repaired. Missing a piece means the run failed its
  // contract and the caller is about to say so; stitching the survivors
  // together would hide which one went missing.
  if (pieces.length !== order.length) return [];

  // With one segment the node writes the comma. With more it writes a space,
  // so every piece but the last has to carry its own.
  const nodeSuppliesComma = order.length === 2;
  const changed = [];

  for (const [i, seg] of pieces.entries()) {
    const last = i === pieces.length - 1;
    // Leading punctuation always goes: the piece before it now ends with
    // whatever separator belongs there, and the node adds the space.
    let body = seg.body.replace(/^[\s,;:.—-]+/, '');
    // Trailing: a comma between pieces, a full stop at the end, and never both
    // — `...air.,` is what stripping without replacing produces.
    body = body.replace(/[\s,;:]+$/, '');
    if (last) {
      if (!/[.!?]$/.test(body)) body += '.';
    } else {
      body = body.replace(/[.!?]+$/, '');
      // The Global prompt of a single-segment timeline ends bare, because the
      // node is about to insert `", "` after it.
      if (!(i === 0 && nodeSuppliesComma)) body += ',';
    }
    if (body !== seg.body) {
      seg.body = body;
      changed.push(seg.label);
    }
  }
  return changed;
}
