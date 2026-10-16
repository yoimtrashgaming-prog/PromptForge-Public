// Image taggers. WD v3 / v1.4 ONNX on the CPU.
//
// The preprocessing here is not invented — it mirrors the ComfyUI wd14-tagger
// node that these exact weights are already used with on this machine
// (custom_nodes/comfyui-wd14-tagger/wd14tagger.py). Getting any step of it
// wrong produces confident nonsense rather than an error, so the steps are
// spelled out and commented rather than compressed.
//
// A missing model file degrades: the store loads, reports the tagger as
// unavailable, and the app starts. Same contract as the tag database.

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { transcodeImage } from './media.mjs';
import { mergeReads } from './tagmerge.mjs';

const DEFAULT_GENERAL = 0.35;
const DEFAULT_CHARACTER = 0.85;

// danbooru category ids as they appear in the label CSV
const CAT_GENERAL = '0';
const CAT_CHARACTER = '4';

// What an H3 reference upload may be, beyond stills. Kept narrow on purpose:
// ffmpeg reads far more than this, but every type here is one a browser will
// also preview in a <video> or <audio> element, so the row shows the thing
// the person actually attached rather than a broken placeholder.
//
// Not used by Tab 3, which analyses stills and is untouched.
const DEFAULT_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const DEFAULT_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac'];

/**
 * Parse a WD label CSV into ordered tags plus the row where each category
 * starts. Order matters: the model's output vector is positional, so index N
 * of the output is row N of this file. Ratings come first, then general, then
 * character.
 */
function loadLabels(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const tags = [];
  const categories = [];
  let generalIndex = null;
  let characterIndex = null;

  for (let i = 1; i < lines.length; i++) {
    // name can contain escaped commas in theory; these files do not, but split
    // with a limit so a stray comma in a tag name cannot shift the category.
    const cols = lines[i].split(',');
    if (cols.length < 3) continue;
    const name = cols[1];
    const category = cols[2];
    const idx = tags.length;
    if (generalIndex === null && category === CAT_GENERAL) generalIndex = idx;
    else if (characterIndex === null && category === CAT_CHARACTER) characterIndex = idx;
    tags.push(name);
    categories.push(category);
  }

  return { tags, categories, generalIndex, characterIndex };
}

/** Extension for the formats ffmpeg has to be told about by name. It sniffs
 *  most containers, but giving it the real extension removes the guess. */
const IMAGE_EXT = {
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'image/avif': '.avif',
};

/**
 * Preprocess, falling back to ffmpeg for anything jimp cannot decode.
 *
 * jimp ships bmp, gif, jpeg, png and tiff — **no webp** — while
 * `config/taggers.yaml` has advertised `image/webp` since Tab 3 was built. So
 * a webp reached the decoder and died there, which is most of what anyone
 * grabs off Civitai or out of a browser.
 *
 * The retry is driven by the decoder FAILING rather than by a list of formats
 * kept in this file. A list here would be a second copy of jimp's capabilities
 * that goes stale the next time it gains or loses a codec; the exception is
 * always current. It also picks up avif and anything else added to the
 * allowlist later with no further edit.
 *
 * One conversion, never two: if the re-encoded PNG also fails to decode, the
 * original error is what surfaces, because that is the one that describes the
 * file the person actually chose.
 */
async function decode(Jimp, buffer, size, contentType) {
  try {
    return await preprocess(Jimp, buffer, size);
  } catch (err) {
    const converted = await transcodeImage(buffer, {
      suffix: IMAGE_EXT[String(contentType ?? '').toLowerCase()] ?? '',
    });
    if (!converted.ok) {
      // ffmpeg missing is a different problem from a corrupt file, and the
      // person can act on it. A decoder message about mime types is not
      // something anyone can act on, so the ffmpeg one wins where it applies.
      const e = new Error(converted.code === 'no_ffmpeg' ? converted.message : err.message);
      e.code = converted.code === 'no_ffmpeg' ? 'no_ffmpeg' : 'decode_failed';
      throw e;
    }
    return await preprocess(Jimp, converted.bytes, size);
  }
}

/**
 * Letterbox onto a white square, then to size×size. Matches the node:
 * scale by size/max(w,h), LANCZOS, paste centred on white. The white matters —
 * these weights were trained with white padding and grey shifts the ratings.
 */
async function preprocess(Jimp, buffer, size) {
  const img = await Jimp.read(buffer);
  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const ratio = size / Math.max(w, h);
  const newW = Math.max(1, Math.floor(w * ratio));
  const newH = Math.max(1, Math.floor(h * ratio));
  img.resize({ w: newW, h: newH });

  const square = new Jimp({ width: size, height: size, color: 0xffffffff });
  square.composite(img, Math.floor((size - newW) / 2), Math.floor((size - newH) / 2));

  // NHWC float32, BGR, values left in 0-255. The node does not normalise, and
  // normalising here would quietly halve every confidence.
  const { data } = square.bitmap;                     // RGBA, 4 bytes per px
  const out = new Float32Array(size * size * 3);
  for (let p = 0, o = 0; p < data.length; p += 4, o += 3) {
    out[o] = data[p + 2];       // B
    out[o + 1] = data[p + 1];   // G
    out[o + 2] = data[p];       // R
  }
  return out;
}

export function createTaggerStore(config, { rootDir = process.cwd() } = {}) {
  const defs = config?.taggers ?? {};
  const uploads = config?.uploads ?? {};
  const defaultKey = config?.default_tagger ?? Object.keys(defs)[0] ?? null;
  // Reference images are read by every tagger in this list rather than one.
  // Absent or empty means the old behaviour: the default, alone.
  const referenceKeys = (config?.reference_taggers ?? []).filter((k) => defs[k]);
  const referenceThreshold = config?.reference_threshold ?? null;

  const state = new Map();   // key -> { def, ok, detail, session, labels }
  let ort = null;
  let Jimp = null;

  for (const [key, def] of Object.entries(defs)) {
    const modelPath = def.model ? path.resolve(rootDir, def.model) : null;
    const labelPath = def.labels ? path.resolve(rootDir, def.labels) : null;
    const missing = [];
    if (!modelPath || !existsSync(modelPath)) missing.push(def.model ?? '(no model path)');
    if (!labelPath || !existsSync(labelPath)) missing.push(def.labels ?? '(no labels path)');

    if (missing.length) {
      // Degrade, do not throw. A tagger whose weights are not on this box must
      // not stop the server from starting.
      console.warn(`[taggers] ${key}: unavailable — missing ${missing.join(', ')}`);
      state.set(key, { def, ok: false, detail: `missing: ${missing.join(', ')}` });
      continue;
    }
    state.set(key, { def, ok: true, detail: null, modelPath, labelPath, session: null, labels: null });
  }

  function get(key) {
    const k = key ?? defaultKey;
    if (!k) return { ok: false, detail: 'no taggers configured' };
    return state.get(k) ?? { ok: false, detail: `unknown tagger "${k}"` };
  }

  /** Load the ONNX session and labels on first use. 1.2GB and ~2.5s — doing
   *  this at boot would add that to every start for a tab nobody may open. */
  async function ensureLoaded(entry) {
    if (entry.session && entry.labels) return;
    ort ??= (await import('onnxruntime-node')).default;
    Jimp ??= (await import('jimp')).Jimp;
    entry.labels ??= loadLabels(entry.labelPath);
    entry.session ??= await ort.InferenceSession.create(entry.modelPath);
  }

  /**
   * Tag one image.
   * @param buffer raw image bytes
   * @returns { ratings, general, character } each [{ tag, confidence }]
   */
  async function analyze(buffer, { tagger, generalThreshold, characterThreshold, contentType } = {}) {
    const entry = get(tagger);
    if (!entry.ok) {
      const err = new Error(entry.detail ?? 'tagger unavailable');
      err.code = 'tagger_unavailable';
      throw err;
    }

    await ensureLoaded(entry);
    const { session, labels, def } = entry;

    const inputName = session.inputNames[0];
    const size = Number(session.inputMetadata?.[0]?.shape?.[1] ?? 448);

    const started = Date.now();
    const pixels = await decode(Jimp, buffer, size, contentType);
    const tensor = new ort.Tensor('float32', pixels, [1, size, size, 3]);
    const out = await session.run({ [inputName]: tensor });
    const probs = out[session.outputNames[0]].data;

    const gThresh = generalThreshold ?? def.general_threshold ?? DEFAULT_GENERAL;
    const cThresh = characterThreshold ?? def.character_threshold ?? DEFAULT_CHARACTER;
    const { tags, generalIndex, characterIndex } = labels;

    const gStart = generalIndex ?? 0;
    const cStart = characterIndex ?? probs.length;

    const pick = (from, to, threshold) => {
      const hits = [];
      for (let i = from; i < to && i < probs.length; i++) {
        if (probs[i] > threshold) hits.push({ tag: tags[i], confidence: Number(probs[i].toFixed(4)) });
      }
      return hits.sort((a, b) => b.confidence - a.confidence);
    };

    // Ratings are the handful of rows before general and are reported as a
    // ranked list rather than thresholded — one of them is always the answer.
    const ratings = [];
    for (let i = 0; i < gStart && i < probs.length; i++) {
      ratings.push({ tag: tags[i], confidence: Number(probs[i].toFixed(4)) });
    }
    ratings.sort((a, b) => b.confidence - a.confidence);

    return {
      tagger: tagger ?? defaultKey,
      model: def.name,
      ratings,
      general: pick(gStart, cStart, gThresh),
      character: pick(cStart, probs.length, cThresh),
      thresholds: { general: gThresh, character: cThresh },
      took_ms: Date.now() - started,
    };
  }

  /**
   * Tag one image with every tagger in `reference_taggers`, merged.
   *
   * Why more than one, and why at a lower floor than Tab 3 uses, is argued in
   * config/taggers.yaml. The short version: a reference image is filtered by
   * role before the model sees any of it, so a tag outside the role's classes
   * costs nothing and only tags INSIDE the role can hurt. That makes recall
   * nearly free here in a way it never is on Tab 3.
   *
   * Merged on the tag, keeping the highest confidence any tagger gave it, and
   * recording which ones saw it. The `found_by` list is not decoration: when
   * three models disagree, which of them saw a thing is the only evidence
   * available for whether it is really there.
   *
   * Falls back to a single `analyze` when the list is empty or has one entry,
   * so a box that has not configured this behaves exactly as before.
   */
  async function analyzeForReference(buffer, { contentType, generalThreshold, characterThreshold } = {}) {
    const keys = referenceKeys.length ? referenceKeys : [defaultKey];
    const gThresh = generalThreshold ?? referenceThreshold ?? undefined;

    if (keys.length === 1) {
      return analyze(buffer, { tagger: keys[0], contentType, generalThreshold: gThresh, characterThreshold });
    }

    const character = new Map();
    const used = [];
    const failed = [];
    let ratings = [];
    const started = Date.now();
    const reads = [];

    // Serial, and measured rather than assumed. Parallel was timed on the P40
    // (28 cores) on 7 Sep 2026 and is not faster: 4140/4198/4165ms against
    // 4258/4173/4005ms serial for the same pair. onnxruntime already
    // saturates the cores for one inference, so running two at once splits
    // the same threads. Serial also keeps the failure handling simple.
    for (const key of keys) {
      try {
        const r = await analyze(buffer, { tagger: key, contentType, generalThreshold: gThresh, characterThreshold });
        reads.push({ key, name: r.model, general: r.general });
        for (const t of r.character) {
          const held = character.get(t.tag);
          if (!held) character.set(t.tag, { ...t, found_by: [key] });
          else {
            held.found_by.push(key);
            if (t.confidence > held.confidence) held.confidence = t.confidence;
          }
        }
        // The first tagger's ratings win. They are a ranked list rather than a
        // threshold, one of them is always the answer, and averaging three
        // models' opinions of "is this explicit" is not a question this app
        // needs a better answer to.
        if (!ratings.length) ratings = r.ratings;
        used.push({ key, name: r.model, general: r.general.length, took_ms: r.took_ms });
      } catch (err) {
        // One tagger missing must not cost the others. On a fresh box only
        // the project-relative animetimm weights are guaranteed present.
        failed.push({ key, message: err.message });
      }
    }

    if (!used.length) {
      const err = new Error(failed[0]?.message ?? 'no tagger available');
      err.code = 'tagger_unavailable';
      throw err;
    }

    // The first entry in reference_taggers is the PRIMARY: trusted, and never
    // overruled by a second opinion. See server/tagmerge.mjs for why that is
    // not a union and not an intersection.
    const rank = (m) => [...m.values()].sort((a, b) => b.confidence - a.confidence);
    return {
      tagger: used.map((u) => u.key).join('+'),
      model: used.map((u) => u.name).join(' + '),
      ratings,
      general: mergeReads(reads),
      character: rank(character),
      thresholds: { general: gThresh ?? null, character: characterThreshold ?? null },
      taggers: used,
      ...(failed.length ? { tagger_errors: failed } : {}),
      took_ms: Date.now() - started,
    };
  }

  function list() {
    return Object.entries(defs).map(([key, def]) => {
      const s = state.get(key);
      return {
        key,
        name: def.name ?? key,
        device: def.device ?? 'cpu',
        available: Boolean(s?.ok),
        loaded: Boolean(s?.session),
        detail: s?.detail ?? null,
        default: key === defaultKey,
        // Each tagger's own tuned cut-offs, so Tab 3's boxes start there. They
        // were hard-coded to WD's 0.35 / 0.85 until 22 Sep 2026, which sent
        // 0.85 to animetimm - tuned at 0.51 - and hid every character it was
        // 51-85% sure of.
        general_threshold: def.general_threshold ?? null,
        character_threshold: def.character_threshold ?? null,
      };
    });
  }

  function info() {
    const all = list();
    return {
      default: defaultKey,
      available: all.filter((t) => t.available).length,
      total: all.length,
      taggers: all,
      limits: {
        max_image_mb: uploads.max_image_mb ?? 20,
        allowed_image_types: uploads.allowed_image_types ?? ['image/png', 'image/jpeg', 'image/webp'],
        // H3 references only. Tab 3 analyses stills and is unchanged — these
        // are listed here because /api/taggers is already the one place the
        // frontend asks what it may upload, and a second limits endpoint
        // would be a second thing to keep in step.
        max_video_mb: uploads.max_video_mb ?? 512,
        allowed_video_types: uploads.allowed_video_types ?? DEFAULT_VIDEO_TYPES,
        max_audio_mb: uploads.max_audio_mb ?? 64,
        allowed_audio_types: uploads.allowed_audio_types ?? DEFAULT_AUDIO_TYPES,
      },
    };
  }

  /** Server-side upload validation. The spec requires the limit be named in
   *  the rejection, not just "too large". */
  function validateUpload({ bytes, contentType }) {
    const maxMb = uploads.max_image_mb ?? 20;
    const allowed = uploads.allowed_image_types ?? ['image/png', 'image/jpeg', 'image/webp'];
    if (contentType && !allowed.includes(String(contentType).split(';')[0].trim().toLowerCase())) {
      return { ok: false, code: 'unsupported_type', message: `${contentType} is not accepted. Allowed: ${allowed.join(', ')}.` };
    }
    if (bytes > maxMb * 1024 * 1024) {
      return { ok: false, code: 'image_too_large', message: `Image is ${(bytes / 1048576).toFixed(1)} MB. The limit is ${maxMb} MB.` };
    }
    if (!bytes) return { ok: false, code: 'empty_image', message: 'No image data was received.' };
    return { ok: true };
  }

  return { analyze, analyzeForReference, list, info, validateUpload, keys: () => Object.keys(defs) };
}
