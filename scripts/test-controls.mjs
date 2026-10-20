// The builder controls that change what the model is told, and what comes back.
//
//   node scripts/test-controls.mjs
//
// Three things, all added 22 Aug 2026:
//   - a custom positive that must survive verbatim
//   - "None" on the quality preset, which is a choice rather than an absence
//   - the aspect ratio leaking out of the controls and into the prompt
//
// The first two are only observable in the message the backend receives, so
// this runs against a stub that records it. The third is a pure function and
// is exercised directly.
//
// Needs no Ollama, no GPU and no network.

import { freePort } from './lib/freeport.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAspect } from '../server/aspect.mjs';
import { loadConfig } from '../server/config.mjs';
import {
  directorBlocks,
  expectedSegments,
  directorLines,
  directorKeyframes,
  fixDirectorSeams,
} from '../server/director.mjs';
import {
  createKeyframeCache,
  keyframeHash,
  keyframeLines,
  keyframeMessage,
  usableReading,
} from '../server/keyframes.mjs';
import { pastedStyle, pasteStyle } from '../server/style.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = await freePort(11496);
const APP_PORT = await freePort(8092);
const BASE = `http://127.0.0.1:${APP_PORT}`;
// The model the stub pretends to be.
//
// Not a constant, and this is not a detail. `reference_vision.vision_models`
// on the deployment box is a DECLARED list — every model started with a
// projector — and the gate treats absence from it as a real "cannot see", not
// a shrug. So a stub calling itself qwen3:8b is a model this box knows to be
// blind, and every assertion about a picture reaching the model fails on that
// box and passes on one with no list. That is the same trap as the tagger
// timings: right answer, wrong machine.
//
// So the name comes from the box's own config when it declares one. h3 is
// unaffected either way — its default_llm_model is already one of them.
const VISION_MODELS = loadConfig(ROOT, 'server').config?.reference_vision?.vision_models;
const MODEL = Array.isArray(VISION_MODELS) && VISION_MODELS.length ? VISION_MODELS[0] : 'qwen3:8b';

// A 1x1 PNG as the browser would send one. The server only checks the shape —
// data URI, allowed type, base64 body — so the smallest legal picture is the
// right fixture: what is being tested is whether a picture travels and how it
// is labelled, not what is in it.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

// ── LTX Director, directly ───────────────────────────────────
//
// The node concatenates global + every segment into one string, so the
// contract is "prose that survives being joined", not "timed shots". These
// hold the pure half of that to account.
{
  const ltx = {
    modes: ['Paragraph', 'Director'],
    segments: ['Enhanced paragraph', 'Improvement notes'],
    meta_segments: ['Improvement notes'],
    director_max_segments: 8,
  };
  const wan = { segments: ['Positive prompt'], meta_segments: [] };
  const timeline = [
    { start: 0, end: 2, brief: 'she turns from the window' },
    { start: 2, end: 5, brief: 'the camera drifts closer' },
  ];

  check('a model without Director never gets a timeline',
    directorBlocks(wan, { mode: 'Director', segments: timeline }) === null);
  check('...and nor does Paragraph mode on a model that has one',
    directorBlocks(ltx, { mode: 'Paragraph', segments: timeline }) === null);
  check('Director mode with an empty timeline is [] and not null',
    Array.isArray(directorBlocks(ltx, { mode: 'Director' })));

  // The segment contract has to follow the timeline, since the count is
  // whatever the user built.
  const expected = expectedSegments(ltx, { mode: 'Director', segments: timeline });
  check('the contract opens with the global prompt', expected[0] === 'Global prompt', expected.join(' | '));
  check('...then one segment per timeline block',
    expected[1] === 'Segment 1' && expected[2] === 'Segment 2', expected.join(' | '));
  check('...and keeps the model\'s meta segment last',
    expected[expected.length - 1] === 'Improvement notes', expected.join(' | '));
  check('Paragraph mode is still the registry contract',
    expectedSegments(ltx, { mode: 'Paragraph' }).join() === ltx.segments.join());
  check('a timeline longer than the model allows is capped',
    expectedSegments({ ...ltx, director_max_segments: 1 },
      { mode: 'Director', segments: timeline }).filter((s) => /^Segment /.test(s)).length === 1);

  // The instruction that matters most: the node joins the pieces, so nothing
  // may write a timecode into the text it returns.
  const lines = directorLines(ltx, {
    mode: 'Director', segments: timeline, duration_seconds: 5, frame_rate: 24,
  }).join('\n');
  check('the model is told the parts get joined', /joins your Global prompt/.test(lines), lines);
  check('...and told not to write timecodes', /Do NOT write timecodes/.test(lines), lines);
  check('...and each segment must continue the last',
    /carry on from the previous one/.test(lines), lines);
  check('the times are marked context only', /context only/.test(lines), lines);
  check('the clip duration and fps reach the model',
    /5 seconds at 24 fps/.test(lines), lines);
  check('a blank segment still gets an instruction',
    /left this one blank/.test(
      directorLines(ltx, { mode: 'Director', segments: [{ start: 0, end: 2, brief: '' }] }).join('\n')));
  check('Paragraph mode adds no lines at all',
    directorLines(ltx, { mode: 'Paragraph', segments: timeline }).length === 0);

  // The word budget is the JOINED text's, not each fragment's. Measured on
  // the P40 before this line existed: 174 words across a global and three
  // segments against a 60-120 band, because "split the budget" leaves the
  // division to a model writing the pieces one at a time.
  const budget = directorLines(
    { ...ltx, word_target: { min: 60, max: 120 } },
    { mode: 'Director', segments: timeline }
  ).join('\n');
  check('the joined word budget is divided for the model',
    /60–120 words total/.test(budget) && /roughly 20–40 words each/.test(budget), budget);
  check('a model with no word_target simply gets no sum',
    !/words total/.test(lines), lines);

  // Which punctuation rule the model is given depends on the count, because the
  // node's two join paths punctuate differently — both quoted in
  // server/director.mjs.
  const one = directorLines(ltx, { mode: 'Director', segments: timeline.slice(0, 1) }).join('\n');
  check('a multi-segment timeline is told to end each piece with a full stop',
    /every Segment with a full stop/.test(lines), lines);
  check('...and a single-segment one is told the node supplies it',
    /the node puts a comma between/.test(one), one);
  check('the delimiter label is spelled out',
    /A bare number is not the label/.test(lines), lines);
}

// ── the Director's keyframes, directly ───────────────────────
//
// He gives the frames and the beats; the model writes the motion between
// them. These hold the pure half: which blocks carry a picture, what the
// reader is and is not told, and how a reading reaches the prompt writer.
{
  const ltx = {
    modes: ['Paragraph', 'Director'],
    segments: ['Enhanced paragraph', 'Improvement notes'],
    meta_segments: ['Improvement notes'],
    director_max_segments: 8,
  };
  const PIC = PIXEL;
  const controls = {
    mode: 'Director',
    segments: [
      { start: 0, end: 2, brief: 'she crouches', image: PIC },
      { start: 2, end: 4, brief: 'she rises' },
      { start: 4, end: 6, brief: 'she steps forward', image: PIC },
    ],
  };

  const framed = directorKeyframes(ltx, controls);
  check('only the segments with a picture are keyframes', framed.length === 2, String(framed.length));
  check('...and each keeps its own segment number',
    framed[0].index === 1 && framed[1].index === 3, framed.map((b) => b.index).join(','));
  check('Paragraph mode has no keyframes even with pictures on the timeline',
    directorKeyframes(ltx, { ...controls, mode: 'Paragraph' }).length === 0);
  check('a blank image field is not a keyframe',
    directorKeyframes(ltx, { mode: 'Director', segments: [{ start: 0, end: 2, image: '' }] }).length === 0);

  // The cache key is the picture's content, because the same frame comes back
  // under a dozen filenames across a session.
  check('the same picture hashes the same', keyframeHash(PIC) === keyframeHash(PIC));
  check('...and a different one does not', keyframeHash(PIC) !== keyframeHash(`${PIC}x`));

  // What the reader is told. It gets the brief for context and nothing that
  // would let it report an answer back as an observation.
  const msg = keyframeMessage(framed[0], { brief: 'a woman on a rooftop' });
  check('the reader is given the brief', /a woman on a rooftop/.test(msg), msg);
  check('...and told it is looking at one instant', /keyframe/i.test(msg), msg);
  check('...and NOT told the segment number, which the cache would make wrong',
    !/segment/i.test(msg), msg);
  check('...and NOT told what the person said happens in that stretch',
    !/she crouches/.test(msg), msg);

  // UNAVAILABLE is the prompt's own "I cannot see this" and must never be
  // annotated onto a segment as if it were a scene.
  check('an unusable reading is null', usableReading('UNAVAILABLE') === null);
  check('...including with a full stop', usableReading('unavailable.') === null);
  check('...and an empty one', usableReading('   ') === null);
  check('a real reading survives', usableReading(' a woman crouches ') === 'a woman crouches');
  check('...and loses a trailing UNAVAILABLE line', usableReading('A woman.\n\nKept: her hair\n\nUNAVAILABLE') === 'A woman.\n\nKept: her hair');

  // The lines that reach the prompt writer.
  const readings = new Map([[1, 'She crouches at the parapet, weight forward.'], [3, 'UNAVAILABLE']]);
  const kf = keyframeLines(framed, readings).join('\n');
  check('a reading is numbered by its segment', /Segment 1 keyframe \(at 0s\)/.test(kf), kf);
  check('...and an unusable one is simply absent', !/Segment 3 keyframe/.test(kf), kf);
  check('the writer is told a keyframe is an instant, not the stretch',
    /OPENS on/.test(kf), kf);
  check('...and told not to copy the reading through',
    /not text to reuse/.test(kf), kf);
  check('no readings at all means no lines at all',
    keyframeLines(framed, new Map()).length === 0);
  check('and no keyframes means no lines either', keyframeLines([], readings).length === 0);

  // The cache: bounded, LRU, and emptied when the instruction that produced
  // its entries is reloaded.
  {
    const cache = createKeyframeCache({ max: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    check('a cached reading comes back', cache.get('a') === '1');
    cache.set('c', '3');
    check('the cap evicts, and it evicts the least recently used',
      cache.get('b') === null && cache.get('a') === '1' && cache.get('c') === '3');
    check('clear() reports what it dropped', cache.clear() === 2 && cache.size === 0);
  }
}

// ── the Director seams, directly ─────────────────────────────
//
// The model writes each fragment alone and never sees the joined result,
// which is the only thing LTX reads. These hold the repair to account: it
// edits the ends of a fragment and nothing else.
{
  const ltx = {
    modes: ['Paragraph', 'Director'],
    segments: ['Enhanced paragraph', 'Improvement notes'],
    meta_segments: ['Improvement notes'],
    director_max_segments: 8,
  };
  const controls = (n) => ({
    mode: 'Director',
    segments: Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, brief: 'x' })),
  });
  const segs = (...bodies) =>
    bodies.map((body, i) => ({ label: i === 0 ? 'Global prompt' : `Segment ${i}`, body }));
  const joined = (list) => list.map((s) => s.body).join(' ');

  // The measured defect: every fragment starting with ", " puts a space in
  // front of every comma once the node joins them.
  {
    const list = segs('A woman on a rooftop.', ', she crouches at the edge.', ', she rises.');
    const changed = fixDirectorSeams(ltx, controls(2), list);
    check('a leading comma goes and the piece opens its own sentence',
      joined(list) === 'A woman on a rooftop. She crouches at the edge. She rises.', joined(list));
    check('...and the pieces it touched are named', changed.length === 2, changed.join(', '));
  }

  // Every piece is whole sentences since 20 Oct 2026 (Lightricks' guide asks
  // for 4 to 8), so a comma between pieces becomes a full stop: the node adds
  // a space and nothing else, and two sentences would run together.
  {
    const list = segs('a woman on a rooftop,', 'She crouches at the edge,', 'She rises');
    fixDirectorSeams(ltx, controls(2), list);
    check('a comma between pieces becomes a full stop',
      joined(list) === 'A woman on a rooftop. She crouches at the edge. She rises.', joined(list));
  }
  {
    const list = segs('A woman on a rooftop.', 'She whispers, "Wait."', 'She rises.');
    check('a sentence ending inside its closing quote is already ended',
      fixDirectorSeams(ltx, controls(2), list).length === 0, joined(list));
  }

  // One segment and the node writes `", "` itself, so the global has to end
  // bare and the segment carries on its last sentence.
  {
    const list = segs('A woman on a rooftop.', ', she crouches');
    fixDirectorSeams(ltx, controls(1), list);
    check('a single-segment global ends bare, because the node adds the comma',
      list[0].body === 'A woman on a rooftop', list[0].body);
    check('...and its one segment still closes the paragraph',
      list[1].body === 'she crouches.', list[1].body);
  }

  // Already correct is left alone — a repair that rewrites clean output is a
  // repair nobody can tell from a bug.
  {
    const list = segs('A woman on a rooftop.', 'She crouches at the edge.', 'Then she rises.');
    const before = joined(list);
    check('clean output is not touched',
      fixDirectorSeams(ltx, controls(2), list).length === 0 && joined(list) === before, joined(list));
  }

  // Never the meta segment, and never any other model.
  {
    const list = [
      ...segs('a woman on a rooftop,', 'crouched at the edge.'),
      { label: 'Improvement notes', body: 'Dissolved the layers. 60 words.' },
    ];
    fixDirectorSeams(ltx, controls(1), list);
    check('the explaining segment is never touched',
      list[2].body === 'Dissolved the layers. 60 words.', list[2].body);
  }
  {
    const list = segs('a woman on a rooftop', ', crouched at the edge');
    check('Paragraph mode is not a Director result and is left alone',
      fixDirectorSeams(ltx, { mode: 'Paragraph', segments: [] }, list).length === 0);
    check('...and nor is a model without Director',
      fixDirectorSeams({ segments: ['Positive prompt'] }, controls(2), list).length === 0);
  }

  // A run that lost a piece failed its contract and the caller is about to
  // say so. Stitching the survivors together would hide which one went.
  {
    const list = [
      { label: 'Global prompt', body: 'a woman on a rooftop' },
      { label: 'Segment 2', body: ', she rises' },
    ];
    check('an incomplete result is reported, not repaired',
      fixDirectorSeams(ltx, controls(2), list).length === 0 && list[0].body === 'a woman on a rooftop');
  }
}

// ── the aspect strip, directly ───────────────────────────────
{
  const strip = (body, aspect, protectedText = []) => stripAspect(body, aspect, { protectedText });

  // The measured leak: qwen3:8b, brief "a girl standing in the rain at night",
  // Aspect "2:3 Portrait" -> a `2:3_portrait` tag on the end of the prompt.
  check('a leaked ratio tag is dropped',
    strip('masterpiece, 1girl, rain, 2:3_portrait', '2:3 Portrait').body === 'masterpiece, 1girl, rain');
  check('...and the plain ratio too',
    strip('1girl, rain, 2:3', '2:3 Portrait').body === '1girl, rain');
  // Measured on the second probe: "9:16 Tall" came back as `..., tall, 9_16`,
  // which the colon spellings alone missed.
  check('a colon written as an underscore is caught',
    strip('1girl, rain, standing, tall, 9_16', '9:16 Tall').body === '1girl, rain, standing',
    strip('1girl, rain, standing, tall, 9_16', '9:16 Tall').body);
  check('...and the orientation word beside it goes with it',
    strip('1girl, tall, 9_16, rain', '9:16 Tall').removed.includes('tall'));

  // The line this must not cross. "portrait" and "tall" are real things to ask
  // a picture for; removing them would change the composition.
  check('the orientation word ALONE is kept',
    strip('1girl, portrait, rain', '2:3 Portrait').body === '1girl, portrait, rain');
  check('...and so is "tall" on its own',
    strip('1girl, tall, rain', '9:16 Tall').body === '1girl, tall, rain');

  // Never edit what the person wrote.
  check('a ratio the person typed themselves is protected',
    strip('1girl, 9_16', '9:16 Tall', ['9_16']).body === '1girl, 9_16');
  // A brief about a television is not a leak.
  check('a ratio inside real prose is left alone',
    strip('a tv showing 16:9 content', '16:9 Wide').body === 'a tv showing 16:9 content');
  check('prose metadata in brackets is removed',
    strip('a girl in the rain (2:3 portrait)', '2:3 Portrait').body === 'a girl in the rain');

  check('nothing to do is a no-op', strip('1girl, rain', '2:3 Portrait').removed.length === 0);
  check('no aspect at all is a no-op', strip('1girl, rain', '').body === '1girl, rain');
  check('an empty body does not throw', strip('', '2:3 Portrait').body === '');
}

// ── the pasted style, directly ───────────────────────────────
{
  const block = 'Charcoal sketch, smudged shading, textured paper.';
  const krea = {
    style_placement: 'append',
    styles: { Charcoal: block, None: '' },
    default_style: 'None',
    segments: ['Enhanced prompt', 'What changed'],
    meta_segments: ['What changed'],
  };
  const segs = () => [
    { label: 'Enhanced prompt', body: 'A man walks his dog in the rain' },
    { label: 'What changed', body: 'Added rain.' },
  ];

  const one = segs();
  check('the block goes on the end of the prompt, word for word',
    pasteStyle(krea, { style: 'Charcoal' }, one) &&
      one[0].body === `A man walks his dog in the rain. ${block}`, one[0].body);
  check('...and never onto the commentary', one[1].body === 'Added rain.');

  pasteStyle(krea, { style: 'Charcoal' }, one);
  check('pasting again does not double it (Refine hands it back)',
    one[0].body.split(block).length === 2, one[0].body);

  const echoed = [{ label: 'Enhanced prompt', body: `A man walks his dog. ${block} The rain falls.` }];
  pasteStyle(krea, { style: 'Charcoal' }, echoed);
  check('a copy the model wrote mid-prompt moves to the end, once',
    echoed[0].body === `A man walks his dog. The rain falls. ${block}`, echoed[0].body);

  const none = segs();
  check('"None" pastes nothing',
    !pasteStyle(krea, { style: 'None' }, none) && none[0].body === 'A man walks his dog in the rain');
  check('a model without style_placement pastes nothing',
    pastedStyle({ ...krea, style_placement: undefined }, { style: 'Charcoal' }) === null);
  check('a tag list is not a block, so it is not pasted',
    pastedStyle({ ...krea, styles: { Charcoal: ['charcoal'] } }, { style: 'Charcoal' }) === null);
}

// ── a backend that records the message it was sent ───────────
let lastUserMessage = '';
// How many pictures were attached to the last request, which is the only
// thing that separates "the model was shown the reference" from "the model was
// told a reference exists".
let lastUserImages = 0;
// The whole request body too, because the length control's tokens half is not
// visible in the message at all — it is `options.num_predict`, and asserting
// on the instruction line alone would pass with the enforcement missing.
let lastRequest = {};
const stub = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/v1/models')) return send(200, { data: [{ id: MODEL }] });
  if (req.url.startsWith('/api/tags')) return send(200, { models: [{ name: MODEL, size: 5e9 }] });
  if (req.url.startsWith('/api/ps')) return send(200, { models: [] });
  if (req.url.startsWith('/api/chat')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw || '{}');
      lastRequest = parsed;
      // The pictures, however this backend carries them. This stub speaks
      // Ollama's native /api/chat, where server/llm.mjs has already split an
      // array message into `content` text plus an `images` array of bare
      // base64 — so counting only OpenAI-style `image_url` parts here reported
      // zero pictures for a request that was carrying two. The array branch
      // stays for the day this stub is pointed at the other shape.
      const userMsgs = (parsed.messages ?? []).filter((m) => m.role === 'user');
      lastUserImages = 0;
      lastUserMessage = userMsgs
        .map((m) => {
          lastUserImages += (m.images ?? []).length;
          if (typeof m.content === 'string') return m.content;
          const parts = Array.isArray(m.content) ? m.content : [];
          lastUserImages += parts.filter((p) => p?.type === 'image_url').length;
          return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
        })
        .join('\n');
      // A well-formed illustrious answer, with the ratio leaked into it so the
      // strip has something to do on the way out.
      const body =
        '===SEGMENT: Positive prompt===\nmasterpiece, 1girl, rain, 2:3_portrait\n\n' +
        '===SEGMENT: Negative prompt===\nworst_quality\n\n' +
        '===SEGMENT: Reasoning===\nBecause.\n';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: body }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
    });
    return;
  }
  send(404, { error: 'not found' });
});

stub.listen(STUB_PORT, '127.0.0.1');
await once(stub, 'listening');

const usersDir = mkdtempSync(path.join(tmpdir(), 'pf-controls-'));
const dataDir = mkdtempSync(path.join(tmpdir(), 'pf-controls-data-'));

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_AUTH: 'off',
    PROMPTFORGE_LLM_BACKEND: 'ollama',
    PROMPTFORGE_LLM_MODEL: MODEL,
    PROMPTFORGE_LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    PROMPTFORGE_USERS_DIR: usersDir,
    PROMPTFORGE_DATA_DIR: dataDir,
    PROMPTFORGE_SEARCH: 'off',
  },
  stdio: 'ignore',
});

async function generate(controls, model = 'illustrious') {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-promptforge-user': 'tester' },
    body: JSON.stringify({ model, brief: 'a girl in the rain', controls }),
  });
  const text = await res.text();
  const segments = {};
  for (const frame of text.split(String.fromCharCode(10, 10))) {
    const da = /^data: (.+)$/m.exec(frame);
    if (!da) continue;
    const d = JSON.parse(da[1]);
    // Read the `done` payload in preference to the streamed segments: the
    // server cleans after the last token, so the streamed copy is the raw one
    // by design. The panel repaints from `done` for the same reason.
    if (Array.isArray(d.segments)) for (const s2 of d.segments) segments[s2.label] = s2.body;
    else if (d.label && d.body != null) segments[d.label] ??= d.body;
  }
  return segments;
}

/** The status and JSON of a rejected generate, for the controls that 400. */
async function generateStatus(controls, model = 'illustrious') {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-promptforge-user': 'tester' },
    body: JSON.stringify({ model, brief: 'a girl in the rain', controls }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an SSE stream, not JSON */ }
  return { status: res.status, json, text };
}

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error(`server did not start on ${APP_PORT}`);

  // ── custom positive ──
  await generate({ positive: 'myloratrigger_v3, artist:someone' });
  check('a custom positive reaches the model', /myloratrigger_v3/.test(lastUserMessage), lastUserMessage);
  // The wording matters as much as the presence: a trigger word that gets
  // "improved" has been destroyed.
  check('...told to keep it exactly as written',
    /exactly as written/.test(lastUserMessage), lastUserMessage);

  // ── the quality preset, and its absence ──
  await generate({ quality_preset: 'masterpiece' });
  check('a chosen preset is named', /Preset: Masterpiece/.test(lastUserMessage), lastUserMessage);
  // Naming it was all that ever happened, and it was not enough. Every file in
  // prompts/image says the registry copy of the ladder is authoritative; until
  // 27 Aug 2026 the registry copy went to the frontend and stopped there, and
  // the model wrote whatever ladder it remembered. The owner's answer to a
  // question about Anima's score tags — "the score should come from the
  // quality preset" — is this line.
  check('...and the preset\'s ACTUAL tags are handed over',
    /masterpiece, best quality, absurdres/.test(lastUserMessage), lastUserMessage);
  check('...told they are the only ones allowed',
    /use exactly these quality tags and no others/.test(lastUserMessage), lastUserMessage);
  // A different preset must produce a different ladder, or the line is a
  // constant that happens to look right for one choice.
  await generate({ quality_preset: 'high_quality' });
  check('a different preset hands over different tags',
    /best quality, highres/.test(lastUserMessage) && !/absurdres/.test(lastUserMessage),
    lastUserMessage);
  // The registry's own empty preset. There is no ladder to hand over, so the
  // line must not end in a dangling colon promising one.
  await generate({ quality_preset: 'none' });
  check('an empty registry preset hands over no tag list',
    !/use exactly these quality tags/.test(lastUserMessage), lastUserMessage);

  await generate({ quality_preset: false });
  check('"None" is sent as an instruction, not as silence',
    /Quality preset: none/i.test(lastUserMessage), lastUserMessage);
  check('...saying what not to add',
    /no quality, score or aesthetic tags/i.test(lastUserMessage), lastUserMessage);
  check('...and does not also appear in the settings line',
    !/Preset: False/i.test(lastUserMessage), lastUserMessage);

  // ── the style, and its tags ──
  //
  // The quality-preset bug above, one control over, and it outlived the fix by
  // a week: `styles` was a list of bare LABELS, so "Style: Painterly" reached
  // the model and the model wrote whatever it remembered painterly meaning.
  // Reported by a user on 3 Sep 2026 as the style prompts not working — the
  // control fired the whole time, it just carried nothing. These assertions
  // are what makes "the registry copy is authoritative" true for styles too.
  await generate({ style: 'Cel shaded' }, 'anima');
  check('a chosen style is named', /Style: Cel shaded/.test(lastUserMessage), lastUserMessage);
  check("...and the style's ACTUAL tags are handed over",
    /include these tags: cel shading, hard cel shading/.test(lastUserMessage), lastUserMessage);
  // A different style must produce different tags, or the line is a constant
  // that happens to look right for one choice.
  await generate({ style: 'Watercolor' }, 'anima');
  check('a different style hands over different tags',
    /painterly brushstrokes|traditional media/.test(lastUserMessage)
      && !/cel shading/.test(lastUserMessage),
    lastUserMessage);
  // Styles are direction mixed into the tag block, NOT a closed set like the
  // quality ladder. Borrowing that wording would tell the model these are the
  // only tags it may write, which is the opposite of what a style is.
  check('...without claiming they are the only tags allowed',
    !/no others/.test(lastUserMessage), lastUserMessage);
  // The registry's empty style. Same rule as the empty quality preset: no
  // dangling promise of a list that is not coming.
  await generate({ style: 'None' }, 'anima');
  check('"None" injects no Style line at all',
    !/Style:/.test(lastUserMessage), lastUserMessage);
  // krea2 pastes its style in code (style_placement: append), so the model is
  // shown the block as its own line and told it is already there - never sent
  // it as a setting to rewrite. See server/style.mjs.
  await generate({ style: 'Chinese Ink' }, 'krea2');
  check('a pasted style reaches the model as its own line, block and all',
    /Style: Chinese Ink\. This style block is added to the end of your prompt word for word/.test(lastUserMessage) &&
      lastUserMessage.includes('Traditional Chinese ink drawing, expressive black ink strokes'),
    lastUserMessage);
  check('...and not as a setting too',
    !/Settings \([^\n]*Style:/.test(lastUserMessage) && !/carry this look/.test(lastUserMessage),
    lastUserMessage);
  await generate({ style: 'None' }, 'krea2');
  check('krea2 at "None" sends no style at all',
    !/Style:/.test(lastUserMessage), lastUserMessage);

  // ── the settings line ──
  await generate({ aspect_ratio: '2:3 Portrait', creativity: 'balanced' });
  check('settings are labelled as context rather than content',
    /never text to include/.test(lastUserMessage), lastUserMessage);

  // ── the detail slider ──
  //
  // Added 25 Aug 2026 alongside the creativity slider. The rule text lives in
  // config/models.yaml, so these assert on the shape and the escalation rather
  // than on exact wording the owner is free to reword.
  //
  // The ladder length is read from config rather than written here. It went
  // from five notches to ten on 4 Sep 2026 and the "of N" in the message is
  // now counted from the table — a test that spelled out "of 5" would have
  // passed while the model was being told the middle notch was the ceiling.
  // The ladders are read from GET /api/models rather than from config on disk,
  // because that payload is what the sliders are built from: a widening that
  // never reached the client is a failure worth catching here.
  const REG = await fetch(`${BASE}/api/models`, { headers: { 'x-promptforge-user': 'tester' } })
    .then((r) => r.json())
    .then((b) => b.defaults);
  const LEVELS = Object.keys(REG.detail_levels).length;
  const MID = REG.default_detail;
  const TOP = Math.max(...Object.keys(REG.detail_levels).map(Number));
  await generate({ detail: MID });
  check('the detail slider reaches the model',
    new RegExp(`Detail level ${MID} of ${LEVELS}`).test(lastUserMessage), lastUserMessage);
  check('...naming the level rather than only numbering it',
    lastUserMessage.includes(`Detail level ${MID} of ${LEVELS} - ${REG.detail_levels[MID].label}`),
    lastUserMessage);
  check('...and the count matches the ladder in config, not a number in code',
    LEVELS === 10, `config declares ${LEVELS} detail levels`);

  // The whole point of the two-axis split: mid notches defer to the model's
  // own format rules, the extremes are allowed to break them. If this stops
  // being true, the top notch becomes indistinguishable from the one below it
  // on every constrained model and the slider is decoration.
  await generate({ detail: MID });
  const mid = lastUserMessage;
  check('a mid notch defers to the model format',
    /stay inside this model's normal length and density rules/i.test(mid), mid);
  check('...and claims no override',
    !/overrides any (minimum|maximum)/i.test(mid), mid);

  await generate({ detail: TOP });
  check('the top notch overrides the model maximum',
    /overrides any maximum length or tag count/i.test(lastUserMessage), lastUserMessage);

  await generate({ detail: 1 });
  check('the bottom notch overrides the model minimum',
    /overrides any minimum length or tag count/i.test(lastUserMessage), lastUserMessage);

  // Every notch is reachable and distinct. Ten levels whose rules repeat are
  // ten labels and five settings, which is the failure the widening was meant
  // to avoid — so the rules are compared, not just counted.
  const seen = new Map();
  for (const level of Object.keys(REG.detail_levels).map(Number).sort((a, b) => a - b)) {
    await generate({ detail: level });
    const line = (lastUserMessage.split('\n').find((l) => l.startsWith('Detail level')) ?? '');
    check(`detail ${level} sends its own line`,
      new RegExp(`^Detail level ${level} of ${LEVELS} - `).test(line), line);
    seen.set(level, line.replace(/^Detail level \d+ of \d+ - /, ''));
  }
  check('no two detail notches send the same instruction',
    new Set(seen.values()).size === seen.size,
    [...seen.values()].join('\n'));

  // Creativity the same way: the ladder is config's, and a duplicated rule
  // means two notches that read differently and behave identically.
  const presets = Object.keys(REG.creativity_presets);
  const creativityLines = new Set();
  for (const preset of presets) {
    await generate({ creativity: preset });
    const line = (lastUserMessage.split('\n').find((l) => l.startsWith('Creativity - ')) ?? '');
    check(`creativity "${preset}" sends a rule`, line.length > 0, lastUserMessage);
    creativityLines.add(line.replace(/^Creativity - [^.]+\. /, ''));
  }
  check('every creativity preset has its own rule',
    creativityLines.size === presets.length, [...creativityLines].join('\n'));
  check('the creativity ladder is ten notches wide',
    presets.length === 10, presets.join(', '));

  // ── the lighting slider ──
  //
  // A user's scale, and the one control here whose default is OFF. Two
  // properties matter and both fail silently: level 0 must inject NOTHING, or
  // every prompt everyone writes gains a lighting sentence the day this ships;
  // and the video models must inject nothing at any level, because they opted
  // out in config and an opt-out that quietly stopped working would look
  // exactly like a working app.
  const lightingLine = () =>
    lastUserMessage.split('\n').find((l) => l.startsWith('Lighting level')) ?? '';

  await generate({ lighting: 0 });
  check('lighting 0 is off and injects nothing',
    lightingLine() === '',
    'a slider nobody touched must leave the prompt exactly as it was before this control existed');

  await generate({});
  check('...and so does sending no lighting control at all', lightingLine() === '');

  const lightKeys = Object.keys(REG.lighting_levels).map(Number).sort((a, b) => a - b);
  check('the lighting ladder is 0 through 10', lightKeys.length === 11 && lightKeys[0] === 0,
    lightKeys.join(','));

  const lightSeen = new Map();
  for (const level of lightKeys.filter((k) => k > 0)) {
    await generate({ lighting: level });
    const line = lightingLine();
    check(`lighting ${level} sends its own line`,
      new RegExp(`^Lighting level ${level} of 10 - `).test(line), line);
    lightSeen.set(level, line);
  }
  check('no two lighting notches send the same instruction',
    new Set([...lightSeen.values()].map((l) => l.replace(/^Lighting level \d+ of \d+ - /, ''))).size
      === lightSeen.size);

  await generate({ lighting: 7 });
  check('the authoritative rule rides along with the level',
    /LIGHTING LEVEL IS AUTHORITATIVE/.test(lightingLine()),
    'it lives with the lighting block so it costs nothing when lighting is off');
  check('...and never leaks into the Settings list',
    !/Lighting/.test(lastUserMessage.split('\n').find((l) => l.startsWith('Settings')) ?? ''),
    'that list is labelled as context that must never reach the output');

  for (const video of ['h3', 'wan', 'ltx']) {
    await generate({ lighting: 7 }, video);
    check(`${video} opted out of lighting and stays out`, lightingLine() === '',
      'config sets lighting_levels: {} — an empty table is not nullish and must survive the defaults merge');
  }

  // The instruction must not land in the Settings list, which is explicitly
  // labelled as context that may never reach the output. Telling the model to
  // write exhaustively inside a block it was told to ignore is a contradiction
  // the 8B loses.
  await generate({ detail: TOP, aspect_ratio: '2:3 Portrait' });
  const settingsLine = (lastUserMessage.split('\n').find((l) => l.startsWith('Settings')) ?? '');
  check('the detail rule stays out of the settings line',
    !/Detail/i.test(settingsLine), settingsLine);

  // An absent or nonsense value falls back rather than failing: saved library
  // entries and any client that has not reloaded will not carry this control.
  await generate({});
  check('an absent detail falls back to the default level',
    new RegExp(`Detail level ${MID} of ${LEVELS}`).test(lastUserMessage), lastUserMessage);
  await generate({ detail: 99 });
  check('an out-of-range detail falls back too',
    new RegExp(`Detail level ${MID} of ${LEVELS}`).test(lastUserMessage), lastUserMessage);
  // 3 was the default until 4 Sep 2026 and is a real level still, so a stale
  // client sending it is honoured rather than corrected — it just means Light
  // now instead of Standard.
  await generate({ detail: 3 });
  check('a level that moved meaning is still honoured, not silently defaulted',
    new RegExp(`Detail level 3 of ${LEVELS}`).test(lastUserMessage), lastUserMessage);

  // Creativity is still sent BY NAME. prompts/video/h3/SKILL.md teaches the
  // model what Precise and Wild mean by name, so a slider that sent a notch
  // index would leave that section describing values that never arrive.
  await generate({ creativity: 'wild' });
  check('creativity still arrives as a preset name',
    /Creativity: Wild/.test(lastUserMessage), lastUserMessage);

  // ── switching a segment off ──────────────────────────────
  //
  // A standing choice in the account panel, not a control on the request:
  // whether a Reasoning segment is worth its tokens does not change prompt to
  // prompt. Stored per model because what one is worth differs — krea2's
  // "What changed" says what it rewrote, Reasoning on a booru tag list
  // explains a list you can already read.
  //
  // The property that matters most is the LAST one here. The model's own
  // prompt file lists every segment under "Segments to emit", so it will often
  // write one anyway; a discarded segment therefore has to be allowed through
  // and dropped, never treated as a contract violation. The stub backend
  // returns the full set regardless of what it is asked, which is exactly the
  // too-obedient model this has to survive.
  const setOmit = (omit) =>
    fetch(`${BASE}/api/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-promptforge-user': 'tester' },
      body: JSON.stringify({ preferences: { omit_segments: omit } }),
    });

  {
    const labels = async (controls = {}) => Object.keys((await generate(controls)) ?? {});

    // The default changed on 5 Sep 2026: the switchable segments start OFF.
    // An account with no entry for a model gets config's
    // `optional_segments_default`, and every one of them is optional here.
    await setOmit({});
    const byDefault = await labels();
    check('the switchable segments are off by default',
      byDefault.length === 1 && byDefault.includes('Positive prompt'),
      JSON.stringify(byDefault));

    // **Empty is not absent**, and the difference is the whole reason the
    // validator stores an empty list. No entry means "never touched, use the
    // default"; an empty entry means "I ticked them all back on". If those
    // collapsed into one, switching a segment on would switch itself off again
    // on the next reload.
    await setOmit({ illustrious: [] });
    const allOn = await labels();
    check('an empty list means every segment, not the default',
      allOn.includes('Positive prompt') && allOn.includes('Negative prompt') && allOn.includes('Reasoning'),
      JSON.stringify(allOn));

    await setOmit({ illustrious: ['Reasoning'] });
    const noReasoning = await labels();
    check('a switched-off segment does not come back',
      !noReasoning.includes('Reasoning'), JSON.stringify(noReasoning));
    check('...and the rest are untouched',
      noReasoning.includes('Positive prompt') && noReasoning.includes('Negative prompt'),
      JSON.stringify(noReasoning));
    // The mechanism, and the reason this is not just a filter: the segment is
    // never DESCRIBED. There used to be a "Do NOT write ..." line contradicting
    // the model's own prompt file; the owner replaced it on 5 Sep 2026 with a
    // system prompt composed from one block per segment. Asserting on the
    // absence is what stops the contradiction creeping back.
    const systemOf = () => lastRequest?.messages?.find((m) => m.role === 'system')?.content ?? '';
    // Not "the word never appears": prompts/_shared/house-rules.md mentions
    // Reasoning in four places and is prepended to every model. That is a
    // style aside, not an instruction to emit one, and splitting the shared
    // file is a separate decision.
    //
    // What decides behaviour is the CONTRACT and the EXAMPLE, and neither may
    // carry it: the model has nothing telling it to write the segment and
    // nothing showing it what one looks like.
    check('a switched-off segment is not in the contract',
      !/^\d+\. `Reasoning`$/m.test(systemOf()), systemOf().slice(-400));
    check('...while the segments it IS writing are listed',
      /^\d+\. `Positive prompt`$/m.test(systemOf()), systemOf().slice(-400));
    check('...and no worked example shows one',
      !/===SEGMENT: Reasoning===/.test(systemOf()), systemOf().slice(-400));
    check('...and the model is not told not to write it either',
      !/Do NOT write/i.test(lastUserMessage + systemOf()), lastUserMessage);
    check('...while the segments it IS writing are still described',
      /Positive prompt/.test(systemOf()) && /Negative prompt/.test(systemOf()),
      systemOf().slice(-400));

    await setOmit({ illustrious: ['Reasoning', 'Negative prompt'] });
    const neither = await labels();
    check('both can be switched off at once',
      neither.length === 1 && neither.includes('Positive prompt'), JSON.stringify(neither));

    // The switch is per model, so an entry for one must not reach another.
    // wan has no entry here, so it gets the default — off — and the test is
    // that it followed ITS own resolution rather than illustrious's list.
    await setOmit({ illustrious: [] });
    const wan = Object.keys((await generate({}, 'wan')) ?? {});
    check('a preference on one model does not touch another',
      wan.length === 1 && wan.includes('Positive prompt'), JSON.stringify(wan));
    // Switching wan ON is not testable here: the stub answers every request
    // with illustrious's three segments, so wan would be missing the Layer
    // breakdown its contract requires and fail for the wrong reason. The
    // property above — that wan resolves its OWN default rather than
    // inheriting illustrious's entry — is the one that matters and it holds.

    // Nonsense is ignored rather than obeyed: honouring it would return an
    // empty panel and look like the model failed.
    await setOmit({ illustrious: ['Positive prompt'] });
    const positive = await labels();
    check('the primary output cannot be switched off',
      positive.includes('Positive prompt'), JSON.stringify(positive));

    await setOmit({ illustrious: [] });
    const restored = await labels();
    check('unticking is reversible',
      restored.includes('Reasoning') && restored.includes('Negative prompt'),
      JSON.stringify(restored));
  }

  // ── the manual length control ──
  //
  // Added 26 Aug 2026, replacing the word counter that scored the person's
  // BRIEF against `model.word_target` — the band for the model's OUTPUT.
  //
  // The property worth protecting above all others is the first one: OFF by
  // default. Every dialect measurement in this project was taken with no
  // length instruction, so a default creeping in here would invalidate all of
  // them silently, and no other assertion in this file would notice.
  await generate({});
  check('no length control means no length line at all',
    !/^Length:/m.test(lastUserMessage), lastUserMessage);
  check('...and no token ceiling on the request',
    lastRequest?.options?.num_predict === undefined,
    JSON.stringify(lastRequest?.options));

  await generate({ max_length: { unit: 'words', value: 60 } });
  check('a word limit reaches the model',
    /Length: approximately 60 words/.test(lastUserMessage), lastUserMessage);
  // Words is an instruction, not a guillotine. Capping num_predict AT the word
  // count would cut a segment in half to enforce something that was only ever
  // approximate, which trades a soft miss for a broken output contract. That
  // still holds and is the first assertion below.
  //
  // **What changed on 30 Aug 2026 is that "not a guillotine" had been built as
  // "no ceiling at all", and that hangs the server.** Measured: illustrious
  // asked for 250 words returned no usable prompt — a tag list running to the
  // 120s timeout, `wet_boots, rainboots, rubber_boots` through
  // `skincare_routine, cosmetics, vanity`, five hair colours at once. Nothing
  // on the words path could stop it, because num_predict was only ever sent
  // for the tokens path.
  //
  // So the contract is now both things at once: far enough above the request
  // that a real answer never reaches it, and present, so a runaway ends in
  // seconds instead of two minutes. 60 words -> 60 * (1/0.75) * 3 = 240.
  check('...and does NOT become a guillotine at the requested length',
    (lastRequest?.options?.num_predict ?? 0) > 60 / 0.75,
    JSON.stringify(lastRequest?.options));
  check('...but a runaway still has a ceiling to hit',
    lastRequest?.options?.num_predict === 240,
    JSON.stringify(lastRequest?.options));

  await generate({ max_length: { unit: 'tokens', value: 800 } });
  check('a token limit reaches the model as an instruction',
    /cut off at 800 tokens/.test(lastUserMessage), lastUserMessage);
  check('...with the rough word equivalent, since it cannot count tokens',
    /roughly 600 words/.test(lastUserMessage), lastUserMessage);
  check('...and IS enforced as num_predict',
    lastRequest?.options?.num_predict === 800,
    JSON.stringify(lastRequest?.options));

  // The detail slider's top notch claims it "overrides any maximum length".
  // A person who then typed a number meant the number: typing it is the more
  // deliberate act, and the two lines must not leave the model to guess.
  await generate({ detail: 5, max_length: { unit: 'words', value: 40 } });
  check('an explicit length is told to beat the detail level',
    /takes precedence over the detail level/.test(lastUserMessage), lastUserMessage);
  check('...and is stated after it, so the later instruction is the winning one',
    lastUserMessage.indexOf('Length:') > lastUserMessage.indexOf('Detail level'),
    lastUserMessage);

  // Refused loudly rather than quietly dropped. Every other control in this
  // file falls back to a default on a bad value, because those controls have
  // defaults; this one's default is OFF, so a value that silently vanished
  // would look identical to no limit and the person would never know.
  for (const [what, bad] of [
    ['a unit that is neither words nor tokens', { unit: 'letters', value: 60 }],
    ['a value below the floor', { unit: 'words', value: 3 }],
    ['a value above the ceiling', { unit: 'tokens', value: 99999 }],
    ['a fractional value', { unit: 'words', value: 60.5 }],
    ['a value that is not a number', { unit: 'words', value: 'lots' }],
    ['a bare number with no unit', 250],
  ]) {
    const { status, json } = await generateStatus({ max_length: bad });
    check(`${what} is refused`, status === 400, `status ${status}`);
    check(`...naming max_length`, /max_length/.test(json?.message ?? ''), json?.message);
  }

  // A 400 rather than an error event inside a stream the panel has already
  // started rendering into — the check runs before the SSE opens.
  {
    const { text } = await generateStatus({ max_length: { unit: 'words', value: 3 } });
    check('a refused length never opens an SSE stream',
      !/^event:/m.test(text), text.slice(0, 120));
  }

  // LTX Director with nothing on the timeline (11 Oct 2026). The model was
  // told to write "all 0 segments", wrote a Segment 1 anyway, and every run
  // died on unknown_segment. Refused before the stream, like a bad length.
  {
    const { status, json, text } = await generateStatus({ mode: 'Director' }, 'ltx');
    check('Director mode with an empty timeline is refused', status === 400, `status ${status} ${text.slice(0, 160)}`);
    check('...saying to add a segment', /at least one segment/.test(json?.message ?? ''), json?.message);
    const withOne = await generateStatus({ mode: 'Director', segments: [{ start: 0, end: 5, brief: 'she turns' }] }, 'ltx');
    check('...and a timeline with one segment still streams', withOne.status === 200 && /^event:/m.test(withOne.text),
      `status ${withOne.status}`);
    const paragraph = await generateStatus({ mode: 'Paragraph' }, 'ltx');
    check('...as does Paragraph mode, which has no timeline', paragraph.status === 200, `status ${paragraph.status}`);
  }

  // Absent, empty and false all mean the same thing: no limit. A saved library
  // entry from before this control existed carries none of these keys, and a
  // client that has not reloaded may send an empty one.
  for (const [what, value] of [['null', null], ['an empty string', ''], ['false', false]]) {
    await generate({ max_length: value });
    check(`${what} means no limit rather than an error`,
      !/^Length:/m.test(lastUserMessage), lastUserMessage);
  }

  // ── and the strip, end to end ──
  const segs = await generate({ aspect_ratio: '2:3 Portrait' });
  check('a leaked ratio never reaches the panel',
    !/2:3/.test(segs['Positive prompt'] ?? ''), segs['Positive prompt']);
  check('...and the rest of the prompt survives intact',
    /masterpiece, 1girl, rain/.test(segs['Positive prompt'] ?? ''), segs['Positive prompt']);

  // ── wan: one frame, or a first/last pair ──
  //
  // Two images is the ceiling the owner set. What matters in the message is
  // not that a second file exists but that it is named as an END STATE:
  // described as just another reference, a pair reads as two subjects and
  // both land in the subject layer, against the one continuous action wan.md
  // asks for.
  await generate({ i2v_reference: { description: 'rain, night, city street' } }, 'wan');
  check('a first frame reaches the model',
    /First frame: the user supplied/.test(lastUserMessage), lastUserMessage);
  check('...along with what a tagger read in it, when nothing can see it',
    /A tagger read it as: rain, night, city street/.test(lastUserMessage), lastUserMessage);
  check('...and the model is told plainly that it cannot see the frame',
    /You cannot see it/.test(lastUserMessage), lastUserMessage);
  check('...and no picture is attached, because none was sent',
    lastUserImages === 0, String(lastUserImages));
  check('...and a single image says nothing about a last frame',
    !/Last frame:/.test(lastUserMessage), lastUserMessage);

  await generate({
    i2v_reference: { description: 'a woman standing, arms at her sides' },
    i2v_last_reference: { description: 'a woman standing, arms raised' },
  }, 'wan');
  check('a last frame reaches the model',
    /Last frame: the user supplied/.test(lastUserMessage), lastUserMessage);
  check('...described separately from the first',
    /A tagger read it as: a woman standing, arms raised/.test(lastUserMessage), lastUserMessage);
  check('...and the first frame is still described as itself',
    /A tagger read it as: a woman standing, arms at her sides/.test(lastUserMessage), lastUserMessage);
  check('...and it is framed as motion rather than a second subject',
    /motion that carries the first frame into it/.test(lastUserMessage), lastUserMessage);

  // ── wan: the frame the model can actually look at ──
  //
  // The point of the whole feature, and the thing that was missing until
  // 9 Sep 2026: a first frame used to reach wan as a comma list of tagger
  // guesses and nothing else. A picture in the payload is what separates
  // "there is a reference" from "here is the reference".
  await generate({
    i2v_reference: { description: 'rain, night, city street', image: PIXEL },
  }, 'wan');
  check('a first frame with a picture is attached to the message',
    lastUserImages === 1, String(lastUserImages));
  check('...and the model is told to look at it',
    /it is attached to this message\. Look at it/.test(lastUserMessage), lastUserMessage);
  check('...and the tagger list is NOT repeated alongside it',
    !/A tagger read it as/.test(lastUserMessage), lastUserMessage);

  await generate({
    i2v_reference: { description: 'arms down', image: PIXEL },
    i2v_last_reference: { description: 'arms raised', image: PIXEL },
  }, 'wan');
  check('a frame pair sends both pictures',
    lastUserImages === 2, String(lastUserImages));
  check('...and which picture is which is stated, not left to position',
    /the first frame is the first picture, this is the second/.test(lastUserMessage), lastUserMessage);

  // A malformed data URI is dropped rather than forwarded — llama-server must
  // never be handed a URL off this box to fetch — and the frame still counts.
  await generate({
    i2v_reference: { description: 'rain', image: 'https://example.invalid/pic.jpg' },
  }, 'wan');
  check('a reference image that is not a data URI is dropped',
    lastUserImages === 0, String(lastUserImages));
  check('...and the message falls back to saying the model cannot see it',
    /You cannot see it/.test(lastUserMessage), lastUserMessage);

  // ── h3: the Director rows, with their pictures ──
  //
  // The lines say what each file is FOR in the node's pipeline — frame
  // anchor, style only — which is a job description and not a description.
  // The picture has to be named by the label its line got, or four pictures
  // under five references is a correspondence the model has to guess.
  await generate({
    mode: 'REF2VA',
    references: [
      { role: 'style', kind: 'image', image: PIXEL },
      { role: 'keyframe', kind: 'image', image: PIXEL },
      { role: 'motion', kind: 'video', duration_seconds: 4 },
    ],
  }, 'h3');
  check('h3 sends a picture for each image reference',
    lastUserImages === 2, String(lastUserImages));
  check('...and never for a video reference, which no projector can read',
    lastUserImages === 2, String(lastUserImages));
  check('...and each picture is named by the label its own line got',
    /The pictures for <Picture 1>, <Picture 2> are attached/.test(lastUserMessage), lastUserMessage);
  // The Director badges every image `Picture N` by slot, so a style picture is
  // still <Picture 1> and the keyframe after it <Picture 2> (18 Sep 2026).
  check('...and the Director lines still travel unchanged',
    /<Video 1> · motion/.test(lastUserMessage), lastUserMessage);

  // The picture is pinned at every Creativity notch on a video model (owner,
  // 18 Sep 2026: "it HAS TO use the input image as a reference"). Sent only
  // when there is a picture, so a text-only clip keeps its full creativity.
  const PINNED = /A reference picture is attached\. What it supplies/;
  await generate({ mode: 'I2VA', creativity: 'wild', references: [{ role: 'keyframe', kind: 'image', image: PIXEL }] }, 'h3');
  check('a video with a picture pins it under Creativity', PINNED.test(lastUserMessage), lastUserMessage);
  // An old result's reading must not survive removing one of its reference cards.
  const staleReading = 'Reference 1 — Character\nUSE: violet-haired former subject in a red coat.\nIGNORE: background, lighting, scenery and any identity not assigned to this reference role.';
  const staleRevision = await fetch(`${BASE}/api/revise`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-promptforge-user': 'tester' },
    body: JSON.stringify({ model: 'anima', brief: 'An empty garden.',
      controls: { image_references: [{ role: 'pose', image: PIXEL }], reference_analysis: staleReading },
      segments: [{ label: 'Positive prompt', body: 'An empty garden.' }] }),
  });
  const staleResponse = await staleRevision.text();
  check('removed-reference revision reaches the writer', staleRevision.status === 200 && /^event: done/m.test(staleResponse), staleResponse);
  check('revision drops an unverified reading after a reference is removed',
    !lastUserMessage.includes('violet-haired former subject'), lastUserMessage);
  check('a rejected reading does not suppress the remaining current picture', lastUserImages === 1, String(lastUserImages));
  const doneEvent = (text) => text.split('\n\n').filter(f => /^event: done$/m.test(f))
    .map(f => JSON.parse(/^data: (.+)$/m.exec(f)[1])).at(-1);
  check('revision explicitly clears rejected reading provenance',
    doneEvent(staleResponse)?.reference_analysis === '' && doneEvent(staleResponse)?.reference_analysis_identity === '', staleResponse);

  // Obtain provenance from the real generation route, not a test-built hash.
  const originalRefs = [{ role: 'character', image: PIXEL, note: 'old subject' }, { role: 'pose', image: PIXEL }];
  const generated = await generateStatus({ image_references: originalRefs });
  const originalRead = doneEvent(generated.text);
  check('generation returns the reading with a SHA-256 input identity',
    Boolean(originalRead?.reference_analysis) && /^[a-f0-9]{64}$/.test(originalRead?.reference_analysis_identity ?? ''), generated.text);
  for (const [name, refs, brief, accepts] of [
    ['unchanged selection', originalRefs, 'a girl in the rain', true],
    ['removed subject', originalRefs.slice(1), 'a girl in the rain', false],
    ['all removed', [], 'a girl in the rain', false],
    ['same count different image', [{ ...originalRefs[0], image: PIXEL.replace('base64,', 'base64,AA') }, originalRefs[1]], 'a girl in the rain', false],
    ['changed role', [{ ...originalRefs[0], role: 'outfit' }, originalRefs[1]], 'a girl in the rain', false],
    ['changed note', [{ ...originalRefs[0], note: 'only the coat' }, originalRefs[1]], 'a girl in the rain', false],
    ['changed brief', originalRefs, 'An empty garden.', false],
  ]) {
    const response = await fetch(`${BASE}/api/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-promptforge-user': 'tester' },
      body: JSON.stringify({ model: 'illustrious', brief,
        controls: { image_references: refs, reference_analysis: originalRead?.reference_analysis,
          reference_analysis_identity: originalRead?.reference_analysis_identity },
        segments: [{ label: 'Positive prompt', body: 'Author-written violet hair must remain editable.' },
          { label: 'Negative prompt', body: 'worst_quality' }, { label: 'Reasoning', body: 'Because.' }] }),
    });
    const text = await response.text();
    const done = doneEvent(text);
    check(`${name}: revision succeeds`, response.status === 200 && Boolean(done), text);
    check(`${name}: cached reading is ${accepts ? 'retained' : 'dropped'}`,
      done?.reference_analysis === (accepts ? originalRead?.reference_analysis : ''), text);
    check(`${name}: current pictures are ${accepts ? 'not resent' : 'attached'}`,
      lastUserImages === (accepts ? 0 : refs.length), String(lastUserImages));
    check(`${name}: arbitrary author text in the draft is not heuristically deleted`,
      lastRequest.messages.some(m => m.role === 'assistant' && m.content.includes('Author-written violet hair')), lastRequest);
  }
  await generate({ creativity: 'wild', i2v_reference: { image: PIXEL } }, 'wan');
  check('...on wan\'s first frame too', PINNED.test(lastUserMessage), lastUserMessage);
  await generate({ mode: 'T2VA', creativity: 'wild' }, 'h3');
  check('...and not on a text-only clip', !PINNED.test(lastUserMessage), lastUserMessage);
  await generate({ mode: 'REF2VA', creativity: 'wild', references: [{ role: 'voice', kind: 'audio' }] }, 'h3');
  check('...nor for a reference that is only sound', !PINNED.test(lastUserMessage), lastUserMessage);

  await generate({
    mode: 'REF2VA',
    references: [{ role: 'subject', kind: 'image' }],
  }, 'h3');
  check('an h3 reference with no picture attaches nothing',
    lastUserImages === 0, String(lastUserImages));
  check('...and claims no attached picture in the text',
    !/attached to this message/.test(lastUserMessage), lastUserMessage);

  // The registry is what offers the two modes; the frontend hides the second
  // field on "Single image" and clears it, so a stale last frame cannot ride
  // along. Here we can at least hold the registry to declaring both.
  {
    const res = await fetch(`${BASE}/api/models`, { headers: { 'x-promptforge-user': 'tester' } });
    const body = await res.json();
    const wan = (body.models ?? body).find?.((m) => m.key === 'wan')
      ?? (body.models ?? body).wan;
    check('wan offers both i2v modes',
      Array.isArray(wan?.i2v_modes) && wan.i2v_modes.length === 2, JSON.stringify(wan?.i2v_modes));
    check('...and defaults to the single image',
      /single/i.test(wan?.default_i2v_mode ?? ''), wan?.default_i2v_mode);
  }

  // A style of "None" must inject no Style line at all, not "Style: None".
  await generate({ style: "Painterly" }, "anima");
  check("a real style reaches the model", /Style: Painterly/.test(lastUserMessage), lastUserMessage);
  await generate({ style: "None" }, "anima");
  check("a None style injects no Style line", !/Style:/.test(lastUserMessage), lastUserMessage);

  // With no aspect chosen there is nothing to strip, so the same output stands.
  const untouched = await generate({});
  check('with no aspect chosen the output is not edited',
    /2:3[ _]portrait/.test(untouched['Positive prompt'] ?? ''), untouched['Positive prompt']);

  // A quality preset of "none" must reach the model as an instruction, not as
  // a setting, whichever of the two spellings the client sends. `false` comes
  // from the UI's injected None; the string "none" comes from a model whose
  // registry declares its own. Both mean the same thing and both were not
  // being handled — see the note in buildUserMessage.
  await generate({ quality_preset: false });
  check('a false preset asks for no quality tags',
    /Add no quality, score or aesthetic tags/.test(lastUserMessage), lastUserMessage);
  await generate({ quality_preset: 'none' });
  check('a "none" preset asks for the same thing',
    /Add no quality, score or aesthetic tags/.test(lastUserMessage), lastUserMessage);
  // Scoped to the Settings line on purpose. The instruction itself opens
  // "Quality preset: none." — matching that would be matching the fix.
  const presetSettings = lastUserMessage.split('\n').find((l) => l.startsWith('Settings')) ?? '';
  check('...and does not also arrive as a Preset setting',
    !/Preset:/i.test(presetSettings), presetSettings || '(no Settings line)');
  await generate({ quality_preset: 'masterpiece' });
  check('a real preset still arrives as a setting',
    /Preset: Masterpiece/.test(lastUserMessage), lastUserMessage);
  check('...and does not ask for no quality tags',
    !/Add no quality, score or aesthetic tags/.test(lastUserMessage), lastUserMessage);

  // "N/A" on the aspect selector, added 27 Aug 2026. It is a real choice
  // meaning "no ratio decided", and it has to behave like the None style: no
  // line goes out, rather than a line whose value is the string N/A.
  await generate({ aspect_ratio: '3:2 Landscape' });
  check('a real aspect reaches the model',
    /Aspect: 3:2 Landscape/.test(lastUserMessage), lastUserMessage);
  await generate({ aspect_ratio: 'N/A' });
  check('an N/A aspect injects no Aspect line at all',
    !/Aspect:/.test(lastUserMessage), lastUserMessage);
  check('...and does not send the letters N/A as a value',
    !/\bN\/A\b/.test(lastUserMessage), lastUserMessage);
  // And the stripper must not run on it. Building match patterns out of "N"
  // and "A" is exactly what server/aspect.mjs warns against, since it must
  // never edit what the person wrote.
  const naOut = await generate({ aspect_ratio: 'N/A' });
  check('an N/A aspect strips nothing from the output',
    /2:3[ _]portrait/.test(naOut['Positive prompt'] ?? ''), naOut['Positive prompt']);
} catch (err) {
  failures.push(`suite threw — ${err.message}`);
} finally {
  app.kill();
  stub.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('\nbuilder controls: custom positive, no preset, leaked aspect\n');
for (const f of failures) console.log(`  FAIL  ${f}`);
if (failures.length) {
  console.log(`\n${failures.length} of ${passed + failures.length} FAILED\n`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})\n`);
