// What ComfyUI wrote inside the PNG: seed, sampler settings, checkpoint, LoRAs.
//
// Asked for 19 Sep 2026, for the pinboard — somebody pins a picture they made
// and the settings that made it should come along without being retyped.
//
// ── How this works, because it looks like it should be harder ─────────────
//
// ComfyUI's SaveImage node writes two PNG `tEXt` chunks beside the pixels:
//
//   prompt     the graph in API form — every node, its class_type, and its
//              inputs, as JSON. This is the one worth reading.
//   workflow   the same graph in UI form: positions, link ids, collapsed
//              state. Four times the size and none of it is settings.
//
// So there is nothing to decode. Walk the chunks, find `prompt`, parse it.
// Verified against a real output PNG on the owner's own ComfyUI install
// (TrashGatcha3Dv2, a KSampler at seed 789106437980024 and an
// UltimateSDUpscale behind it), not against a hand-written fixture.
//
// No npm dependency, for the reason server/media.mjs states about ffmpeg:
// the platform already does this. `zlib` is in Node, a PNG chunk is a length,
// a type and a CRC, and the EXIF libraries that would otherwise show up here
// do not know what a ComfyUI graph is anyway.
//
// ── What it cannot do, and must say so rather than guess ──────────────────
//
// Only a PNG that ComfyUI itself saved carries this. A JPEG, a screenshot, a
// picture that went through an editor, or anything a chat app re-encoded has
// nothing to read — the chunks are dropped by every re-save. Each of those
// returns null, and the caller shows nothing rather than inventing a seed.
//
// This is also the reason the pinboard does not downscale an upload the way
// reference images are downscaled: re-encoding through a canvas would strip
// exactly this.

import zlib from 'node:zlib';

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// A graph this size is somebody's whole pipeline, not a picture's settings.
// Guards against a crafted PNG whose text chunk is a decompression bomb.
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * The PNG's text chunks as a plain object, or {} for anything that is not a
 * PNG. Handles all three text chunk types; ComfyUI writes tEXt, but a file
 * that has been through another tool may carry zTXt or iTXt instead.
 *
 * Never throws. A truncated or malformed file stops the walk and returns
 * whatever was read before the damage.
 */
export function readPngText(buf) {
  const out = {};
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return out;

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (len < 0 || end + 4 > buf.length) break;

    try {
      if (type === 'tEXt') {
        const data = buf.subarray(start, end);
        const z = data.indexOf(0);
        if (z > 0) out[data.toString('latin1', 0, z)] = data.toString('utf8', z + 1);
      } else if (type === 'zTXt') {
        const data = buf.subarray(start, end);
        const z = data.indexOf(0);
        // data[z + 1] is the compression method; 0 (deflate) is the only one
        // the spec defines and the only one worth attempting.
        if (z > 0 && data[z + 1] === 0) {
          const raw = zlib.inflateSync(data.subarray(z + 2), { maxOutputLength: MAX_TEXT_BYTES });
          out[data.toString('latin1', 0, z)] = raw.toString('utf8');
        }
      } else if (type === 'iTXt') {
        const data = buf.subarray(start, end);
        const z = data.indexOf(0);
        if (z > 0) {
          const compressed = data[z + 1] === 1;
          // keyword \0 flag method langtag \0 translated \0 text
          let p = z + 3;
          p = data.indexOf(0, p) + 1;
          p = data.indexOf(0, p) + 1;
          if (p > 0 && p <= data.length) {
            const body = data.subarray(p);
            out[data.toString('latin1', 0, z)] = compressed
              ? zlib.inflateSync(body, { maxOutputLength: MAX_TEXT_BYTES }).toString('utf8')
              : body.toString('utf8');
          }
        }
      }
    } catch {
      // One unreadable chunk is not a reason to lose the others.
    }

    if (type === 'IEND') break;
    off = end + 4;                    // skip the CRC
  }
  return out;
}

const SEED_KEYS = ['seed', 'noise_seed'];

// What makes a node a sampler.
//
// This asked "does it carry a literal seed" until 20 Sep 2026, and that was
// wrong in a way the owner's own workflow exposed immediately: his KSampler
// takes its seed from an rgthree `Seed` node, so the seed input is a LINK and
// not a number. The literal lived on the Seed node, which has nothing else on
// it — so the pinboard reported a seed, no steps, no cfg, no sampler, and no
// prompt, because every real setting was on a node this had skipped.
//
// Class names are no better: SamplerCustomAdvanced and UltimateSDUpscale both
// sample without being called KSampler, and KSamplerSelect is called one while
// only choosing an algorithm. So the test is structural — something that picks
// the algorithm or consumes a guider, AND something that says how hard to run
// it. KSamplerSelect has the first and not the second; BasicScheduler has the
// second and not the first; a real sampler has both.
const SAMPLER_MARKERS = ['sampler_name', 'guider', 'sigmas'];
const EFFORT_MARKERS = ['steps', 'cfg', 'denoise', 'guider', 'positive'];
const has = (node, keys) => keys.some((k) => node?.inputs?.[k] !== undefined);
const isSampler = (node) =>
  // Something that picks the algorithm, plus something that says how hard.
  (has(node, SAMPLER_MARKERS) && has(node, EFFORT_MARKERS)) ||
  // Or a seed next to a step count. Some samplers take the algorithm from a
  // wire rather than a widget and so carry no `sampler_name` of their own,
  // and this still excludes the two nodes that look closest: a seed provider
  // has the seed and no steps, a scheduler has the steps and no seed.
  (has(node, SEED_KEYS) && has(node, ['steps', 'cfg']));

/**
 * The seed for a sampler, whether it is written on the node or wired into it.
 *
 * Seed-provider nodes are near-universal in shared workflows — rgthree's
 * `Seed`, the various "global seed" nodes — because they let one control drive
 * several samplers. Following the wire is the only way to report the number
 * somebody would actually paste back.
 */
function resolveSeed(graph, node, depth = 0, seen = new Set()) {
  if (!node || depth > 6) return undefined;
  for (const key of SEED_KEYS) {
    const v = node.inputs?.[key];
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (Array.isArray(v) && v.length && !seen.has(String(v[0]))) {
      seen.add(String(v[0]));
      const found = resolveSeed(graph, graph[v[0]], depth + 1, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Quote long seed literals before parsing, so they survive as exact digits.
 *
 * ComfyUI's seed widgets go to 2^64-1. JSON.parse produces a double, which is
 * exact only to 2^53-1 — so a seed of 18446744073709551615 comes back as
 * 18446744073709552000 with no error and no warning. The whole point of this
 * feature is handing somebody a seed they can paste back, and a seed that is
 * quietly off by a few hundred is worse than no seed at all: it reproduces
 * nothing and looks right while doing it.
 *
 * Sixteen digits is the boundary — 2^53-1 is 9007199254740991, itself
 * sixteen — so anything that long is turned into a string and read as digits
 * rather than as a quantity. Nothing downstream does arithmetic on a seed.
 */
function quoteLongSeeds(raw) {
  return raw.replace(
    /"(seed|noise_seed)"\s*:\s*(\d{16,})/g,
    (_m, key, digits) => `"${key}": "${digits}"`
  );
}

/**
 * Follow a conditioning link back to the text somebody actually typed.
 *
 * Which CLIPTextEncode is the positive one is not a property of the node — it
 * is which KSampler input it is wired to. So this starts at `positive` or
 * `negative` on the sampler and walks back until it finds a node carrying a
 * literal `text`, which handles the common case of something sitting in
 * between: a ConditioningCombine, a zero-out, a style node.
 *
 * Bounded, and it returns the FIRST text it reaches. A graph that concatenates
 * four conditioning branches will give one of them rather than all four — a
 * wrong-but-plausible reconstruction of somebody's prompt is worse than a
 * partial one they can see is partial, and this is a pre-fill they edit.
 */
// Inputs that are a node's settings rather than somebody's words. Without
// this a chain of Text Concatenate nodes contributes ", " and "false" forty
// times over and calls it a prompt.
const CONTROL_KEYS = new Set([
  'delimiter', 'clean_whitespace', 'mode', 'seed', 'noise_seed',
  'strip_whitespace', 'separator', 'return_with_leading_comma',
  // Weight filenames. A CLIPTextEncode's `clip` input leads to the
  // checkpoint loader, whose `ckpt_name` is a string like any other — so
  // without this the negative prompt came back ending in
  // "TrashGatcha3Dv2.safetensors". Caught on screen, 20 Sep 2026.
  'ckpt_name', 'unet_name', 'vae_name', 'lora_name', 'clip_name',
  'model_name', 'style_model_name', 'control_net_name', 'upscale_model_name',
]);

// Inputs never worth following. Text comes down conditioning and string
// wires; a model, clip or vae wire leads to loaders and samplers, where
// everything that looks like a string is a filename or a setting.
const NOT_TEXT_LINKS = new Set([
  'clip', 'model', 'vae', 'images', 'image', 'latent_image', 'samples',
  'control_net', 'mask', 'sigmas', 'sampler',
]);

// Nodes that BUILD text at run time rather than holding it. A graph routing
// its prompt through one of these does not store the finished string
// anywhere, so whatever is collected is a fragment and has to say so.
const ASSEMBLES_TEXT = /concat|wildcard|switch|combine|join|dynamicprompt/i;

/**
 * Collect the words somebody actually typed, from a conditioning link.
 *
 * Returns `{ text, partial }` — partial when the chain passed through a node
 * that assembles text at run time.
 *
 * The owner's own workflow is why this is not a single lookup. His positive
 * conditioning is a CLIPTextEncode whose `text` is wired to a
 * StringConcatenate, one side of which is a literal and the other an
 * ImpactWildcardProcessor fed by forty-three Text Concatenate nodes. ComfyUI
 * records each node's INPUTS, not what it produced, so the finished prompt is
 * genuinely not in the file — only the pieces are.
 *
 * Reporting those pieces as "the prompt" would be the wrong-but-plausible
 * reconstruction this file has avoided from the start. Reporting them AS
 * pieces is useful: the literal half is the quality prefix he actually uses,
 * and this is a pre-fill he edits before saving.
 *
 * Text lives under different keys in different node packs — `text`, `value`,
 * `string`, `populated_text` — so the rule is "any string input that is not a
 * control", not a list of blessed key names that would go stale.
 */
function collectText(graph, link, depth = 0, seen = new Set(), out = { parts: [], partial: false }) {
  if (depth > 12 || !Array.isArray(link) || !link.length) return out;
  const id = String(link[0]);
  if (seen.has(id)) return out;
  seen.add(id);
  const node = graph[id];
  if (!node) return out;

  if (ASSEMBLES_TEXT.test(String(node.class_type ?? ''))) out.partial = true;

  for (const [key, v] of Object.entries(node.inputs ?? {})) {
    if (CONTROL_KEYS.has(key) || key.startsWith('Select')) continue;
    if (typeof v === 'string' && v.trim().length > 2) {
      const value = v.trim();
      if (!out.parts.includes(value)) out.parts.push(value);
    } else if (Array.isArray(v) && !NOT_TEXT_LINKS.has(key)) {
      collectText(graph, v, depth + 1, seen, out);
    }
  }
  return out;
}

/** The collected text as one string, or null when there was none. */
function textFrom(graph, link) {
  const { parts, partial } = collectText(graph, link);
  const text = parts.join(', ').trim();
  return text ? { text, partial } : null;
}

/**
 * Find the node that actually holds `positive` and `negative`.
 *
 * On a classic KSampler that is the sampler itself. On the newer split
 * layout — RandomNoise + KSamplerSelect + BasicScheduler + CFGGuider +
 * SamplerCustomAdvanced — the conditioning hangs off the guider instead, and
 * the sampler node has no `positive` input at all. Reported from the owner's
 * own screenshot on 20 Sep 2026: a pinned Anima picture came back with a seed
 * and a checkpoint and nothing else, because every other setting lives on a
 * different node in that shape.
 *
 * So this walks upstream from the sampler until it finds whichever node has
 * them, rather than assuming the sampler is it.
 */
function findConditioning(graph, nodeId, depth = 0, seen = new Set()) {
  if (depth > 6 || seen.has(nodeId)) return null;
  seen.add(nodeId);
  const node = graph[nodeId];
  if (!node) return null;
  if (node.inputs?.positive !== undefined || node.inputs?.negative !== undefined) {
    return node;
  }
  for (const v of Object.values(node.inputs ?? {})) {
    if (Array.isArray(v) && v.length) {
      const found = findConditioning(graph, String(v[0]), depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

// The settings worth hunting for across a split graph, and nothing else. A
// blanket "collect every scalar upstream" would sweep in tile sizes, clip
// layers and LoRA strengths and call them generation settings.
const SPLIT_KEYS = ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'];

/**
 * Fill in settings that live on sibling nodes rather than on the sampler.
 *
 * Only ever ADDS keys the sampler node does not already carry, so a classic
 * KSampler — which has all of them — is untouched and cannot be contaminated
 * by some other node's `steps`.
 *
 * Bounded to the subgraph upstream of this sampler, which is what keeps a
 * base pass and an upscale pass from borrowing each other's numbers.
 */
function fillSplitSettings(graph, nodeId, settings, depth = 0, seen = new Set()) {
  if (depth > 6 || seen.has(nodeId)) return settings;
  seen.add(nodeId);
  const node = graph[nodeId];
  if (!node) return settings;

  for (const key of SPLIT_KEYS) {
    const v = node.inputs?.[key];
    if (settings[key] === undefined && !Array.isArray(v) &&
        (typeof v === 'number' || typeof v === 'string')) {
      settings[key] = v;
    }
  }
  for (const v of Object.values(node.inputs ?? {})) {
    if (Array.isArray(v) && v.length) {
      fillSplitSettings(graph, String(v[0]), settings, depth + 1, seen);
    }
  }
  return settings;
}

/** Only the inputs that are values. An array input is a link to another node. */
function scalars(node) {
  const out = {};
  for (const [k, v] of Object.entries(node?.inputs ?? {})) {
    if (!Array.isArray(v) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * How far each node sits upstream of a saved image.
 *
 * A graph routinely holds more than one sampler — the owner's own test file
 * has a KSampler and an UltimateSDUpscale behind it — and "the seed" is then
 * an ambiguous question. Rather than pick one and be quietly wrong, every
 * sampler is reported in pipeline order, which is what this computes: a walk
 * backwards from SaveImage through the link inputs, recording depth.
 *
 * A graph with no SaveImage (a PreviewImage-only run, or a picture saved by
 * some other node) falls back to every node at depth 0, which keeps the
 * samplers in graph order rather than dropping them.
 */
function depthsFromSave(graph) {
  const terminals = Object.entries(graph)
    .filter(([, n]) => /SaveImage|SaveAnimated|Image Save/i.test(String(n?.class_type ?? '')))
    .map(([id]) => id);
  if (!terminals.length) return null;

  const depth = new Map();
  let frontier = terminals;
  let d = 0;
  // Bounded by node count: a cycle cannot make this run forever because a
  // node already seen is never re-queued.
  while (frontier.length && d < 1000) {
    const next = [];
    for (const id of frontier) {
      if (depth.has(id)) continue;
      depth.set(id, d);
      for (const v of Object.values(graph[id]?.inputs ?? {})) {
        if (Array.isArray(v) && v.length && graph[v[0]] && !depth.has(String(v[0]))) {
          next.push(String(v[0]));
        }
      }
    }
    frontier = next;
    d += 1;
  }
  return depth;
}

/**
 * The settings out of a ComfyUI PNG, or null when there are none to read.
 *
 * Null is the normal answer for most pictures — a JPEG, a screenshot,
 * anything re-encoded — and it is not an error. The caller shows nothing.
 */
export function readComfyMetadata(buf) {
  const text = readPngText(buf);
  const raw = text.prompt;
  if (!raw) return null;

  let graph;
  try {
    graph = JSON.parse(quoteLongSeeds(raw));
  } catch {
    // Present but unparseable. Say nothing rather than half of something.
    return null;
  }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return null;

  const depth = depthsFromSave(graph);
  const entries = Object.entries(graph).filter(([, n]) => n && typeof n === 'object');

  const samplers = entries
    .filter(([, n]) => isSampler(n))
    .map(([id, n]) => {
      // The node's own values first, then the seed followed through whatever
      // wire it came down, then anything still missing gathered from the
      // subgraph above it — which is where a split KSamplerSelect /
      // BasicScheduler / CFGGuider layout keeps the rest.
      const settings = scalars(n);
      const seed = resolveSeed(graph, n);
      if (seed !== undefined && settings.seed === undefined && settings.noise_seed === undefined) {
        settings.seed = seed;
      }
      fillSplitSettings(graph, id, settings);
      return {
        node: id,
        type: String(n.class_type ?? 'unknown'),
        depth: depth?.get(id) ?? 0,
        settings,
      };
    })
    // Furthest upstream first, so the base pass reads before the upscale that
    // consumes it. Ties fall back to node id, which is ComfyUI's own order.
    .sort((a, b) => b.depth - a.depth || String(a.node).localeCompare(String(b.node)));

  const checkpoints = entries
    .filter(([, n]) => /CheckpointLoader|UNETLoader|Checkpoint Loader/i.test(String(n.class_type ?? '')))
    .map(([, n]) => n.inputs?.ckpt_name ?? n.inputs?.unet_name)
    .filter((v) => typeof v === 'string');

  // ComfyUI stores a path as the OS wrote it, so a Windows install yields
  // `image-gen\Thing.safetensors`. Normalised, because the name goes on
  // screen next to four other people's Linux-shaped ones.
  const loraName = (v) => String(v ?? '').replace(/\\/g, '/');
  const num = (v) => (typeof v === 'number' ? v : null);

  const loras = [];
  for (const [, n] of entries) {
    if (!/LoraLoader|Lora Loader/i.test(String(n.class_type ?? ''))) continue;

    // The stock loaders: one LoRA per node, named inputs.
    if (typeof n.inputs?.lora_name === 'string') {
      loras.push({
        name: loraName(n.inputs.lora_name),
        model: num(n.inputs.strength_model),
        // LoraLoaderModelOnly has no clip strength at all, which is a null
        // rather than a zero — zero would read as "clip off deliberately".
        clip: num(n.inputs.strength_clip),
      });
      continue;
    }

    // rgthree's Power Lora Loader stacks them inside ONE node, as objects
    // under lora_1, lora_2, … each with its own enable switch:
    //
    //   "lora_1": { "on": false, "lora": "image-gen\\S4kur4.safetensors",
    //               "strength": 0.8 }
    //
    // Found on the owner's own pinned picture, 20 Sep 2026, which reported
    // zero LoRAs while plainly having one. The class name matched all along
    // — "Power Lora Loader (rgthree)" contains "Lora Loader" — and every
    // field this looked for was somewhere else entirely.
    //
    // `on: false` is skipped. A LoRA sitting switched off in somebody's
    // graph did not make the picture, and listing it as a resource would
    // send the next person to install something the image never used.
    for (const [key, slot] of Object.entries(n.inputs ?? {})) {
      if (!/^lora_\d+$/i.test(key)) continue;
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
      if (slot.on === false) continue;
      if (typeof slot.lora !== 'string' || !slot.lora.trim()) continue;
      loras.push({
        name: loraName(slot.lora),
        model: num(slot.strength),
        // rgthree splits the two strengths only when you ask it to; with one
        // slider `strengthTwo` is absent and both are the same number.
        clip: num(slot.strengthTwo) ?? num(slot.strength),
      });
    }
  }

  // Nothing recognisable in it. A ComfyUI graph with no sampler, no
  // checkpoint and no LoRA is a picture somebody loaded and saved again, and
  // reporting "from ComfyUI" with an empty body is worse than reporting
  // nothing at all.
  if (!samplers.length && !checkpoints.length && !loras.length) return null;

  // The headline pair the pinboard shows without being asked. First sampler
  // in pipeline order: on a base-plus-upscale graph that is the one whose
  // seed people mean.
  const lead = samplers[0] ?? null;
  // Which node holds the conditioning is not always the sampler — see
  // findConditioning. Resolved once, because both prompts hang off the same
  // node and walking to it twice is the same walk.
  const cond = lead ? findConditioning(graph, lead.node) : null;
  const positive = cond ? textFrom(graph, cond.inputs?.positive) : null;
  const negative = cond ? textFrom(graph, cond.inputs?.negative) : null;

  return {
    seed: lead ? (lead.settings.seed ?? lead.settings.noise_seed ?? null) : null,
    sampler: lead?.type ?? null,
    settings: lead?.settings ?? {},
    samplers,
    checkpoints: [...new Set(checkpoints)],
    loras,
    // The prompts somebody typed, positive and negative.
    //
    // This file refused to read these until 20 Sep 2026, on the grounds that
    // overwriting a prompt box somebody had filled in with whatever the graph
    // happened to contain would replace what they meant with what the file
    // says. That reasoning holds for overwriting and not for PRE-filling: the
    // owner asked for Civitai's behaviour, where picking the image fills the
    // form in and you edit it before saving. Which is only offered into an
    // EMPTY box — see the upload form in web/app.js.
    //
    // Positive and negative are told apart by which sampler input each is
    // wired to, not by anything about the node itself. There is no other way:
    // both are the same class, and the one called "negative" is negative only
    // because of where its wire goes.
    prompt: positive?.text ?? null,
    // True when the graph builds its prompt at run time, so what is above is
    // the pieces rather than the finished thing. The form says so rather than
    // letting somebody assume a short pre-fill is all they wrote.
    prompt_partial: Boolean(positive?.partial),
    negative: negative?.text ?? null,
    negative_partial: Boolean(negative?.partial),
    node_count: entries.length,
  };
}
