// The LTX Director's keyframes: read each picture once, cache it, and hand
// the prompt writer text.
//
// The owner's design, 4 Sep 2026, and his framing of what it is for: "taking
// an image and making it x amount of time and typing what's going on in that
// and between frames... build out a base of what's going on and then have the
// llm populate what's going on between it". He supplies the skeleton — a
// keyframe, a duration, a line about the beat — and the model writes the
// transitions.
//
// **Three decisions were settled when it was designed, and none is arbitrary.**
//
// 1. **Vision, never the tagger.** His call, and the stronger reason is that
//    a tagger describes STATES while this needs the DELTA. `standing` in
//    frame 1 and `standing` in frame 2 says nothing changed when she turned
//    and stepped forward. Booru tags are also the wrong dialect entirely for
//    a model whose output is one flowing paragraph.
//
// 2. **The pictures stay here.** PromptForge does not emit the node's
//    `timeline_data`, which is where WhatDreamsCost's node actually carries
//    per-segment images (`imageFile` / `imageB64`, `start`, `length`, `type`,
//    plus a comma-separated `guide_strength`). Emitting it would make this a
//    workflow generator, which archive/docs/status.md records as a line this project
//    deliberately does not cross — the same reason the node's audio, IC-LoRA
//    and guide-strength tracks are unmirrored. He wires the images into
//    ComfyUI himself; this only informs the text.
//
// 3. **Described once, not attached.** This is the part that separates it
//    from wan and h3, which attach their pictures to the generation call.
//    Measured on the P40, 9 Sep 2026: ONE picture took wan from 7.2s to 103s,
//    all of it prefill, and prefill is paid again on every re-roll. A
//    timeline can hold eight. Eight pictures on the compile call is not a
//    slow feature, it is an unusable one — so each is read once by itself,
//    the reading is cached by content hash, and the compile call gets text.
//    A re-roll then costs nothing, and so does moving a segment's boundary.
//
// Nothing here calls the model. The builders are pure so they can be tested
// without a GPU, and the streaming lives in server.mjs beside the other two
// passes that do the same thing.

import { createHash } from 'node:crypto';

/** Extraction, not writing — the same argument and the same number as
 *  BLUEPRINT_TEMPERATURE. A creative temperature here invents detail the
 *  prompt writer then cannot tell from something that was in the frame. */
export const KEYFRAME_TEMPERATURE = 0.2;

/**
 * How much room one keyframe reading gets.
 *
 * Small on purpose. This is one picture answered against one question, and
 * every token is wall-clock on a queue five people share — and unlike the
 * blueprint pass, N of these run per generation. The prompt asks for a short
 * paragraph; this is the ceiling that keeps a rambling one from spending the
 * compile call's context.
 */
export const KEYFRAME_BUDGET = 320;

/**
 * The cache key for a picture: its content, not its name.
 *
 * A hash rather than the filename because the same frame gets re-uploaded
 * under a dozen names across a session, and because a filename is the
 * person's, not the file's. Truncated to 32 hex characters — this is a
 * process-local Map key, not a security boundary.
 */
export function keyframeHash(dataUri) {
  return createHash('sha256').update(String(dataUri ?? '')).digest('hex').slice(0, 32);
}

/**
 * What the reader is told about one keyframe.
 *
 * Deliberately thin, and thinner than the blueprint pass's block. It gets the
 * brief for context and where the frame sits on the timeline. It does NOT get
 * the segment's own line — what the person typed about what happens across
 * that stretch is the thing the prompt writer is supposed to reconcile
 * AGAINST the picture, and a reader told the answer reports it back as an
 * observation. That is the same laundering the blueprint pass withholds the
 * picked tags to avoid.
 *
 * It is not told which segment number it is either. The reading is cached by
 * content hash and the same picture can sit on segment 1 today and segment 3
 * after a drag, so anything position-dependent in here would be a cache entry
 * that is quietly wrong.
 */
export function keyframeMessage(block, { brief = '' } = {}) {
  const lines = [];
  if (brief.trim()) lines.push(`The clip, in the person's words: ${brief.trim()}`);
  lines.push(
    'This picture is a keyframe: it is what the shot looks like at one instant, ' +
      'and the prompt writer will have to describe the motion that leads into and out of it.'
  );
  return lines.join('\n');
}

/**
 * A reading, or null.
 *
 * `UNAVAILABLE` is the prompt's own signal that the model was handed a
 * picture it could not see, and it must never be treated as a description —
 * a segment annotated "UNAVAILABLE" is worse than one with no annotation,
 * because the prompt writer has no way to know it is not a scene.
 */
export function usableReading(text) {
  // A 27B reader sometimes signs off a real description with the signal on a
  // line of its own (7 Oct 2026, three reads in a row): the description stands.
  // A Q6 once leaked its thinking into a raw reader call (12 Oct 2026): only
  // what follows the closing tag is the answer.
  const answer = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
  const t = answer.trim().replace(/\n\s*unavailable\.?$/i, '').trim();
  if (!t) return null;
  if (/^unavailable\.?$/i.test(t)) return null;
  return t;
}

/**
 * A bounded cache of readings, keyed by picture hash.
 *
 * In memory and process-local, which is the boring right answer for one box
 * serving five people: a reading is worth ~20 seconds, not worth a file
 * format, and a restart losing it costs one re-read. Oldest out first at the
 * cap, so a long session cannot grow it without limit.
 */
export function createKeyframeCache({ max = 64 } = {}) {
  const store = new Map();
  return {
    get(hash) {
      if (!store.has(hash)) return null;
      // Re-inserted so the recently used survive the eviction. Map iterates
      // in insertion order, which is what makes this three lines instead of
      // an LRU implementation.
      const value = store.get(hash);
      store.delete(hash);
      store.set(hash, value);
      return value;
    },
    set(hash, value) {
      if (store.has(hash)) store.delete(hash);
      store.set(hash, value);
      while (store.size > max) store.delete(store.keys().next().value);
    },
    /** Empty it, returning how many went. Called on a prompt reload, because
     *  every entry is the output of an instruction that just changed. */
    clear() {
      const n = store.size;
      store.clear();
      return n;
    },
    get size() {
      return store.size;
    },
  };
}

/**
 * The lines describing each keyframe, for the prompt writer.
 *
 * Numbered by SEGMENT, not by picture, because that is the correspondence
 * that matters: a reading floating free of the stretch it belongs to is a
 * scene the model has to guess the position of, and guessing wrong describes
 * the clip in the wrong order. The same rule as the video reference labels.
 *
 * Returns [] when nothing was read, so the caller can spread it
 * unconditionally.
 *
 * @param {Array<{index:number,start:number,end:number}>} blocks  keyframed blocks
 * @param {Map<number,string>|object} readings  segment index -> reading
 */
export function keyframeLines(blocks = [], readings = new Map()) {
  const get = (i) => (readings instanceof Map ? readings.get(i) : readings?.[i]);
  const kept = blocks.filter((b) => usableReading(get(b.index)));
  if (!kept.length) return [];

  const lines = [
    '',
    'Keyframes. The person attached a picture for some of these segments and somebody has ' +
      'looked at each one. A keyframe is what that stretch OPENS on — a single instant, not ' +
      'the whole stretch.',
    'Write the motion that carries each keyframe into the next one. Where a segment has both ' +
      'a keyframe and a line from the person, the picture is what is there and the line is ' +
      'what happens to it; they are not two descriptions of the same thing.',
    // The reading is a paragraph of prose about one photograph, and LTX's
    // dialect is not that. Said plainly, because the failure it prevents is
    // the readings being copied through into the prompt — which reads fine
    // and is the wrong length, the wrong voice, and full of the reader's
    // hedging.
    'These readings are notes to you, not text to reuse. Do not copy their wording, and do ' +
      'not carry over anything they say they are unsure about.',
  ];
  for (const b of kept) {
    lines.push(`Segment ${b.index} keyframe (at ${b.start}s): ${usableReading(get(b.index))}`);
  }
  return lines;
}
