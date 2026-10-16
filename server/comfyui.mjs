// Render from PromptForge: send a finished prompt to ComfyUI on this box and
// bring the picture back. docs/render-plan.md is the plan this builds stage 1
// of — one workflow per image model, sampler settings, size, seed, progress,
// the picture inline.
//
// ComfyUI's own HTTP API, nothing installed on top of it:
//
//   POST /prompt        queue a workflow (API-format JSON)
//   /ws                 progress, per prompt id
//   GET  /history/<id>  which files a finished prompt wrote
//   GET  /view          fetch one of them
//   GET  /object_info   installed samplers and schedulers
//   POST /free          drop ComfyUI's models from the GPU
//
// ComfyUI listens on 127.0.0.1 only. PromptForge's server is its one client;
// nothing about it faces the network.
//
// Measured 3 Oct 2026 on the V100 (the plan's Measured section): cold start
// 8.7 s; the default 27B and an image model share the card (28.7 GB, peak
// 32.26 of 32.5), so the LLM stays loaded when there is room and is unloaded
// first only when there is not.

import { spawn, execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Short sides the Resolution control offers, the owner's own table. */
export const RESOLUTION_TIERS = [480, 720, 1080, 1440];

/**
 * Width and height for an aspect label and a resolution tier.
 *
 * Tier = the short side; both sides rounded to a multiple of 16, as in the
 * owner's resolution panel (1080p 2:3 is 1088 × 1616). Null when the aspect
 * names no ratio ("N/A"), which means "the workflow's own size".
 */
export function sizeFor(aspect, tier) {
  const m = /(\d+)\s*:\s*(\d+)/.exec(String(aspect ?? ''));
  const short = Number(tier);
  if (!m || !Number.isFinite(short) || short <= 0) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!a || !b) return null;
  const r16 = (v) => Math.max(16, Math.round(v / 16) * 16);
  const long = (short * Math.max(a, b)) / Math.min(a, b);
  return a >= b
    ? { width: r16(long), height: r16(short) }
    : { width: r16(short), height: r16(long) };
}

/** Loader classes whose file a preset may swap, and the input holding it. */
const MODEL_LOADERS = { CheckpointLoaderSimple: 'ckpt_name', UNETLoader: 'unet_name' };
/** Which ComfyUI models folder each loader reads, for listing what is installed. */
const LOADER_FOLDERS = { CheckpointLoaderSimple: 'checkpoints', UNETLoader: 'diffusion_models' };
const LORA_LOADER = 'Power Lora Loader (rgthree)';
/** Files the loaders accept. */
const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|sft)$/i;

/**
 * Every model file under one ComfyUI models folder, as ComfyUI names them:
 * the path relative to the folder, forward slashes. Follows symlinks — the
 * test LoRA and Illustrious are links into the training folders.
 */
export function listModelFiles(folder) {
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // a dangling link
      }
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory() && depth < 4) walk(full, r, depth + 1);
      else if (st.isFile() && MODEL_EXT.test(name)) out.push(r);
    }
  };
  walk(folder, '', 0);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * What a LoRA says about itself in its safetensors header: the architecture
 * it was trained for and its trigger words. sd-scripts (TrainFlow) writes
 * both — `modelspec.architecture` "stable-diffusion-xl-v1-base/lora",
 * `modelspec.trigger_phrase` "3sh," on the test LoRA, read 3 Oct 2026. Null
 * fields when the file says nothing; never throws.
 */
export function readLoraInfo(file) {
  const info = { architecture: null, trigger: null, base_model: null, title: null };
  let fd;
  try {
    fd = openSync(file, 'r');
    const len = Buffer.alloc(8);
    readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE());
    if (!(n > 0 && n < 50_000_000)) return info;
    const head = Buffer.alloc(n);
    readSync(fd, head, 0, n, 8);
    const meta = JSON.parse(head.toString('utf8'))?.__metadata__ ?? {};
    info.architecture = meta['modelspec.architecture'] ?? meta.ss_base_model_version ?? null;
    info.trigger = meta['modelspec.trigger_phrase'] ?? null;
    info.base_model = meta.ss_sd_model_name ?? null;
    info.title = meta['modelspec.title'] ?? null;
  } catch {
    /* not a safetensors file, or no header worth reading */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return info;
}

/** Does a LoRA's own architecture string match any of a model's patterns? Null when it says nothing. */
export function loraMatches(info, patterns) {
  const text = [info?.architecture, info?.base_model].filter(Boolean).join(' ').toLowerCase();
  if (!text) return null;
  return (patterns ?? []).some((p) => text.includes(String(p).toLowerCase()));
}

/**
 * The workflow's own pixel count at another aspect: what the model was set
 * up for, reshaped. SDXL-family checkpoints draw duplicates well above their
 * training size, so this — not 1080p — is the default. Null for "N/A".
 */
export function nativeSizeFor(aspect, width, height) {
  const m = /(\d+)\s*:\s*(\d+)/.exec(String(aspect ?? ''));
  if (!m || !(width > 0) || !(height > 0)) return null;
  const ratio = Number(m[1]) / Number(m[2]);
  if (!ratio) return null;
  const r16 = (v) => Math.max(16, Math.round(v / 16) * 16);
  const area = width * height;
  return { width: r16(Math.sqrt(area * ratio)), height: r16(Math.sqrt(area / ratio)) };
}

/**
 * The nodes PromptForge fills, found by following the sampler's links rather
 * than by title: the positive and negative text are whatever feeds KSampler's
 * positive and negative inputs, the size is its latent. That holds for any
 * single-KSampler workflow, the starter ones included, without asking anyone
 * to name a node a particular way.
 *
 * Returns { sampler, positive, negative, size, save } as node ids (strings),
 * or { error } naming what is missing.
 */
export function mapWorkflow(wf) {
  if (!wf || typeof wf !== 'object') return { error: 'The workflow is not an object.' };
  const ids = Object.keys(wf);
  const samplers = ids.filter((id) => wf[id]?.class_type === 'KSampler');
  if (samplers.length !== 1) {
    return { error: `Needs exactly one KSampler node; this workflow has ${samplers.length}.` };
  }
  const sampler = samplers[0];
  const link = (name) => {
    const v = wf[sampler].inputs?.[name];
    return Array.isArray(v) && wf[String(v[0])] ? String(v[0]) : null;
  };
  const textNode = (id) => (id && typeof wf[id].inputs?.text === 'string' ? id : null);
  const positive = textNode(link('positive'));
  const negative = textNode(link('negative'));
  const latent = link('latent_image');
  const size = latent && 'width' in (wf[latent].inputs ?? {}) && 'height' in (wf[latent].inputs ?? {}) ? latent : null;
  const save = ids.find((id) => wf[id]?.class_type === 'SaveImage') ?? null;
  // The loaders, each when there is exactly one to fill. All optional: a
  // checkpoint workflow has no separate text encoder or VAE, and a workflow
  // without a Power Lora Loader simply offers no LoRAs.
  const only = (pred) => {
    const found = ids.filter((id) => pred(wf[id]?.class_type));
    return found.length === 1 ? found[0] : null;
  };
  const loader = only((c) => MODEL_LOADERS[c]);
  const textEncoder = only((c) => c === 'CLIPLoader');
  const vae = only((c) => c === 'VAELoader');
  const lora = only((c) => c === LORA_LOADER);
  const missing = [
    !positive && 'a text node feeding the sampler\'s positive input',
    !negative && 'a text node feeding the sampler\'s negative input',
    !size && 'a latent with width and height feeding the sampler',
    !save && 'a Save Image node',
  ].filter(Boolean);
  if (missing.length) return { error: `The workflow is missing ${missing.join(', ')}.` };
  return {
    sampler,
    positive,
    negative,
    size,
    save,
    loader,
    loaderInput: loader ? MODEL_LOADERS[wf[loader].class_type] : null,
    loaderFolder: loader ? LOADER_FOLDERS[wf[loader].class_type] : null,
    textEncoder,
    vae,
    lora,
  };
}

/** The workflow's own values, which are the defaults until a preset or the person changes them. */
export function workflowDefaults(wf, map) {
  const s = wf[map.sampler].inputs;
  const z = wf[map.size].inputs;
  return {
    steps: s.steps,
    cfg: s.cfg,
    sampler: s.sampler_name,
    scheduler: s.scheduler,
    width: z.width,
    height: z.height,
    negative: wf[map.negative].inputs.text,
    model_file: map.loader ? wf[map.loader].inputs[map.loaderInput] : null,
    text_encoder: map.textEncoder ? wf[map.textEncoder].inputs.clip_name : null,
    vae: map.vae ? wf[map.vae].inputs.vae_name : null,
  };
}

/**
 * A ComfyUI binary websocket frame as a data URI, or null when it is not a
 * picture. Frame layout (ComfyUI server.py, BinaryEventTypes): a big-endian
 * uint32 event type, then for PREVIEW_IMAGE (1) a uint32 image type (1 JPEG,
 * 2 PNG) and the bytes; for PREVIEW_IMAGE_WITH_METADATA (4) a uint32 length,
 * that much JSON (which names the image type), then the bytes.
 */
export function previewFrame(data) {
  try {
    const buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (buf.length < 8) return null;
    const event = buf.readUInt32BE(0);
    let mime;
    let bytes;
    if (event === 1) {
      mime = buf.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg';
      bytes = buf.subarray(8);
    } else if (event === 4) {
      const len = buf.readUInt32BE(4);
      const meta = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
      mime = /png/i.test(meta?.image_type ?? '') ? 'image/png' : 'image/jpeg';
      bytes = buf.subarray(8 + len);
    } else {
      return null;
    }
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

// Which model family a file name belongs to, for saying what ComfyUI is
// making. First match wins, so the specific names go before the general.
const FAMILIES = [
  [/minimax[_-]?h3|mmh3/i, 'MMH3'],
  [/illustrious/i, 'Illustrious'],
  [/anima/i, 'Anima'],
  [/krea/i, 'Krea2'],
  [/ltx/i, 'LTX'],
  [/wan[_-]?2|wan2\.|\bwan_/i, 'Wan'],
  [/flux/i, 'Flux'],
  [/pony/i, 'Pony'],
  [/sdxl|sd_xl/i, 'SDXL'],
];
// Node types that make a video, or only exist in video workflows.
const VIDEO_NODE = /video|webm|animated|director|frames?combine|wan.*(i2v|t2v)|ltx/i;

/**
 * What a queued ComfyUI graph is making, as { model, kind }: the family of
 * the model files it loads ('MMH3', 'Illustrious', … or null when none is
 * recognised) and 'video' or 'image'. Read from the graph alone, so it works
 * for anything in ComfyUI's queue, PromptForge's renders or not.
 */
export function describeGraph(graph) {
  const nodes = Object.values(graph ?? {}).filter((n) => n && typeof n === 'object');
  const types = nodes.map((n) => String(n.class_type ?? ''));
  let model = null;
  if (types.some((t) => /MiniMaxH3/i.test(t))) model = 'MMH3';
  if (!model) {
    // Model loaders first: a text encoder's or LoRA's name says less.
    const files = [
      ...nodes.filter((n) => /checkpoint|unet|diffusion|gguf/i.test(n.class_type)).flatMap((n) => Object.values(n.inputs ?? {})),
      ...nodes.flatMap((n) => Object.values(n.inputs ?? {})),
    ].filter((v) => typeof v === 'string' && /\.(safetensors|gguf|ckpt|pt|pth|sft)$/i.test(v));
    for (const f of files) {
      const hit = FAMILIES.find(([re]) => re.test(f));
      if (hit) {
        model = hit[1];
        break;
      }
    }
  }
  const kind = types.some((t) => VIDEO_NODE.test(t)) || model === 'MMH3' || model === 'LTX' || model === 'Wan' ? 'video' : 'image';
  return { model, kind };
}

/** Most LoRAs one render may stack. Each is a load; more is a mistake, not a look. */
export const MAX_LORAS = 8;

/**
 * Check render settings against the caps and the installed lists. Returns
 * { ok, settings } with numbers coerced, or { ok: false, message } naming the
 * one thing wrong — the person fixes one field, not a list.
 */
export function validateSettings(raw, { caps, samplers, schedulers, modelFiles, textEncoders, vaes, loras }) {
  const s = raw ?? {};
  const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
  const steps = int(s.steps);
  const cfg = Number(s.cfg);
  const width = int(s.width);
  const height = int(s.height);
  const seed = int(s.seed);
  const maxSteps = caps.max_steps;
  const maxPixels = caps.max_megapixels * 1e6;
  if (!(steps >= 1 && steps <= maxSteps)) return { ok: false, message: `Steps must be 1 to ${maxSteps} on this server.` };
  if (!(cfg >= 0 && cfg <= 30)) return { ok: false, message: 'CFG must be between 0 and 30.' };
  if (!(width >= 256 && height >= 256 && width <= 4096 && height <= 4096) || width % 8 || height % 8) {
    return { ok: false, message: 'Width and height must be 256 to 4096, in multiples of 8.' };
  }
  if (width * height > maxPixels) {
    return { ok: false, message: `${width} × ${height} is over this server's ${caps.max_megapixels} MP cap. Pick a lower resolution.` };
  }
  if (!(seed >= 0 && seed <= Number.MAX_SAFE_INTEGER)) return { ok: false, message: 'Seed must be a whole number, 0 or more.' };
  // Only checked when the lists are known: before ComfyUI has ever answered,
  // there is nothing to check against, and ComfyUI itself refuses a bad name.
  if (samplers?.length && !samplers.includes(s.sampler)) return { ok: false, message: `Unknown sampler "${s.sampler}".` };
  if (schedulers?.length && !schedulers.includes(s.scheduler)) return { ok: false, message: `Unknown scheduler "${s.scheduler}".` };
  // Files only from the lists this model offers: the model files the owner
  // registered for it, and what is installed for the other loaders. A name
  // from anywhere else never reaches ComfyUI.
  const pick = (v, list, what) => {
    const f = v ? String(v) : null;
    if (f && !(list ?? []).includes(f)) return { error: `"${f}" is not ${what} this server offers for this model.` };
    return { file: f };
  };
  const modelFile = pick(s.model_file, modelFiles, 'a model file');
  if (modelFile.error) return { ok: false, message: modelFile.error };
  const textEncoder = pick(s.text_encoder, textEncoders, 'a text encoder');
  if (textEncoder.error) return { ok: false, message: textEncoder.error };
  const vae = pick(s.vae, vaes, 'a VAE');
  if (vae.error) return { ok: false, message: vae.error };

  const wanted = Array.isArray(s.loras) ? s.loras : [];
  if (wanted.length > MAX_LORAS) return { ok: false, message: `At most ${MAX_LORAS} LoRAs at once.` };
  const loraList = [];
  for (const l of wanted) {
    const f = pick(l?.file, loras, 'a LoRA');
    if (f.error || !f.file) return { ok: false, message: f.error ?? 'A LoRA row has no file picked.' };
    const strength = Number(l.strength);
    if (!(strength >= -3 && strength <= 3)) return { ok: false, message: 'LoRA strength must be between -3 and 3.' };
    loraList.push({ file: f.file, strength: Math.round(strength * 100) / 100 });
  }
  return {
    ok: true,
    settings: {
      steps,
      cfg,
      width,
      height,
      seed,
      sampler: String(s.sampler),
      scheduler: String(s.scheduler),
      model_file: modelFile.file,
      text_encoder: textEncoder.file,
      vae: vae.file,
      loras: loraList,
    },
  };
}

/**
 * The positive that goes to ComfyUI: the model file's prefix, then the
 * trigger words of the LoRAs switched on, then PromptForge's prompt.
 *
 * On a tag model a tag already in the prompt is kept once, not doubled
 * (agreed 3 Oct 2026); on prose only an exact phrase already present is
 * skipped. Comparison ignores case and underscores, the two ways the same
 * tag is spelled in this project.
 */
export function composePositive({ prompt, prefix = '', triggers = [], tagModel = false }) {
  const norm = (t) => String(t).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const body = String(prompt ?? '').trim();
  const have = new Set(tagModel ? body.split(',').map(norm).filter(Boolean) : []);
  const lower = norm(body);
  const extra = [];
  for (const item of [prefix, ...triggers].flatMap((t) => String(t ?? '').split(','))) {
    const n = norm(item);
    if (!n || have.has(n) || (!tagModel && lower.includes(n))) continue;
    have.add(n);
    extra.push(item.trim());
  }
  return extra.length ? `${extra.join(', ')}, ${body}` : body;
}

/**
 * The API workflow with this render's values written in, plus the UI
 * workflow with the same values in its widgets, so the PNG reopens in
 * ComfyUI showing what actually ran rather than the starter's blanks.
 */
export function fillWorkflow(wf, ui, map, { positive, negative, settings }) {
  const api = structuredClone(wf);
  api[map.positive].inputs.text = positive;
  api[map.negative].inputs.text = negative;
  Object.assign(api[map.sampler].inputs, {
    seed: settings.seed,
    steps: settings.steps,
    cfg: settings.cfg,
    sampler_name: settings.sampler,
    scheduler: settings.scheduler,
  });
  Object.assign(api[map.size].inputs, { width: settings.width, height: settings.height });
  if (settings.model_file && map.loader) api[map.loader].inputs[map.loaderInput] = settings.model_file;
  if (settings.text_encoder && map.textEncoder) api[map.textEncoder].inputs.clip_name = settings.text_encoder;
  if (settings.vae && map.vae) api[map.vae].inputs.vae_name = settings.vae;
  // Power Lora Loader takes any number of `lora_N: {on, lora, strength}`
  // (spike, 3 Oct 2026). Whatever the workflow carried is replaced: the Render
  // panel's list is the whole list.
  const loras = map.lora ? (settings.loras ?? []) : [];
  if (map.lora) {
    const inputs = api[map.lora].inputs;
    for (const k of Object.keys(inputs)) if (/^lora_\d+$/.test(k)) delete inputs[k];
    loras.forEach((l, i) => {
      inputs[`lora_${i + 1}`] = { on: true, lora: l.file, strength: l.strength };
    });
  }

  let editable = null;
  if (ui && Array.isArray(ui.nodes)) {
    editable = structuredClone(ui);
    const byId = new Map(editable.nodes.map((n) => [String(n.id), n]));
    const set = (id, i, v) => {
      const n = byId.get(id);
      if (n && Array.isArray(n.widgets_values) && i < n.widgets_values.length) n.widgets_values[i] = v;
    };
    set(map.positive, 0, positive);
    set(map.negative, 0, negative);
    // KSampler widgets: seed, control_after_generate, steps, cfg, sampler, scheduler, denoise.
    set(map.sampler, 0, settings.seed);
    set(map.sampler, 1, 'fixed');
    set(map.sampler, 2, settings.steps);
    set(map.sampler, 3, settings.cfg);
    set(map.sampler, 4, settings.sampler);
    set(map.sampler, 5, settings.scheduler);
    set(map.size, 0, settings.width);
    set(map.size, 1, settings.height);
    if (settings.model_file && map.loader) set(map.loader, 0, settings.model_file);
    if (settings.text_encoder && map.textEncoder) set(map.textEncoder, 0, settings.text_encoder);
    if (settings.vae && map.vae) set(map.vae, 0, settings.vae);
    // rgthree's widget list: [divider, header, ...one per LoRA, spacer, add
    // button]. Rows go after the header, replacing any that were there.
    const node = map.lora ? byId.get(map.lora) : null;
    if (node && Array.isArray(node.widgets_values)) {
      const w = node.widgets_values;
      const header = w.findIndex((v) => v?.type === 'PowerLoraLoaderHeaderWidget');
      if (header !== -1) {
        const rest = w.slice(header + 1).filter((v) => !(v && typeof v === 'object' && 'lora' in v));
        node.widgets_values = [
          ...w.slice(0, header + 1),
          ...loras.map((l) => ({ on: true, lora: l.file, strength: l.strength, strengthTwo: null })),
          ...rest,
        ];
      }
    }
  }
  return { api, ui: editable };
}

/**
 * The ComfyUI process, its API, and the renders kept on disk.
 *
 * `listGpuApps` and `fetchImpl` are injectable so the suite can run with no
 * GPU and no ComfyUI.
 */
export function createComfy(config, { rootDir, dataDir, log = console.log, fetchImpl = fetch, listGpuApps = null } = {}) {
  const cfg = config.comfyui ?? {};
  const enabled = cfg.enabled === true;
  const base = String(cfg.url ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
  const dir = cfg.dir ? path.resolve(rootDir, cfg.dir) : null;
  const caps = {
    max_steps: Number(cfg.caps?.max_steps) || 60,
    max_megapixels: Number(cfg.caps?.max_megapixels) || 2.1,
  };
  const idleMs = (Number(cfg.idle_stop_minutes) || 5) * 60_000;
  const startTimeoutMs = (Number(cfg.start_timeout_seconds) || 120) * 1000;
  const renderTimeoutMs = (Number(cfg.render_timeout_seconds) || 900) * 1000;
  const keepMs = (Number(cfg.keep_hours) || 24) * 3_600_000;
  const defaultVramGb = Number(cfg.vram_gb) || 10;
  const rendersDir = path.resolve(rootDir, dataDir, 'renders');
  const objectInfoCache = path.join(rendersDir, 'object-info.json');

  // Only a ComfyUI this server started is ever stopped by it. One already
  // running when a render arrives — the owner's own, started by hand — is
  // used and left alone.
  let child = null;
  let starting = null;
  let idleTimer = null;
  // ComfyUI keeps its last model on the card after a render, which is what
  // makes a second render fast. True from a render until a /free or a stop.
  let holding = false;
  // The render this server is running right now, for activity().
  let current = null;
  let lists = (() => {
    try {
      return JSON.parse(readFileSync(objectInfoCache, 'utf8'));
    } catch {
      return { samplers: [], schedulers: [] };
    }
  })();

  async function up() {
    try {
      return (await fetchImpl(`${base}/system_stats`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  }

  async function start() {
    if (await up()) return { started: false };
    if (starting) return starting;
    if (!dir || !existsSync(path.join(dir, 'main.py'))) {
      throw Object.assign(new Error('ComfyUI is not running, and comfyui.dir does not point at a ComfyUI folder to start it from.'), { code: 'comfyui_unavailable' });
    }
    starting = (async () => {
      const t0 = Date.now();
      const url = new URL(base);
      const python = cfg.python
        ? path.resolve(rootDir, cfg.python)
        : process.platform === 'win32'
          ? path.join(dir, 'venv', 'Scripts', 'python.exe')
          : path.join(dir, 'venv', 'bin', 'python');
      mkdirSync(path.resolve(rootDir, 'logs'), { recursive: true });
      const out = openSync(path.resolve(rootDir, 'logs', 'comfyui.log'), 'a');
      // Previews on, so the Render panel can show the picture forming. Only
      // a ComfyUI this server starts; one started by hand keeps its own flags.
      const previews = cfg.previews === false ? [] : ['--preview-method', 'auto'];
      child = spawn(python, ['main.py', '--listen', url.hostname, '--port', url.port || '8188', ...previews, ...(cfg.extra_args ?? [])], {
        cwd: dir,
        stdio: ['ignore', out, out],
      });
      closeSync(out); // the child has its own copy
      const proc = child;
      proc.on('exit', (code, signal) => {
        log(`[comfyui] exited (${signal ?? code})`);
        if (child === proc) {
          child = null;
          holding = false;
        }
      });
      proc.on('error', (err) => log(`[comfyui] could not start: ${err.message}`));
      while (Date.now() - t0 < startTimeoutMs) {
        if (await up()) {
          log(`[comfyui] started in ${((Date.now() - t0) / 1000).toFixed(1)} s (pid ${proc.pid})`);
          return { started: true, ms: Date.now() - t0 };
        }
        if (proc.exitCode !== null || proc.signalCode) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      proc.kill('SIGTERM');
      throw Object.assign(new Error('ComfyUI did not come up. Its log is logs/comfyui.log on the server.'), { code: 'comfyui_unavailable' });
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  function stop(reason) {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!child) return false;
    log(`[comfyui] stopping (${reason})`);
    child.kill('SIGTERM');
    return true;
  }

  /** After a render: stop the ComfyUI we started once nobody has rendered for idle_stop_minutes. */
  function armIdleStop() {
    clearTimeout(idleTimer);
    if (!child) return;
    idleTimer = setTimeout(() => stop(`idle ${idleMs / 60000} min`), idleMs);
    idleTimer.unref?.();
  }

  async function free() {
    try {
      await fetchImpl(`${base}/free`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(10_000),
      });
      holding = false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Free ComfyUI's models so an LLM can load: the ComfyUI this server is
   * holding, and also one somebody else started (by hand, or one a test
   * server left behind) when it is idle. Owner's call, 4 Oct 2026, after an
   * orphaned ComfyUI held 13 GB for hours and every 27B load failed beside it.
   *
   * Only ever an unload, never a stop, and never while its queue has
   * anything running or waiting: someone working in ComfyUI directly loses at
   * most a model reload on their next run. Returns true when it freed.
   */
  async function freeIfIdle() {
    if (!enabled) return false;
    if (!holding) {
      let q;
      try {
        q = await (await fetchImpl(`${base}/queue`, { signal: AbortSignal.timeout(1500) })).json();
      } catch {
        return false; // not running, or not answering: nothing to free
      }
      if (q?.queue_running?.length || q?.queue_pending?.length) return false;
    }
    return free();
  }

  /** Sampler and scheduler names from ComfyUI itself, cached on disk for when it is stopped. */
  async function refreshLists() {
    const ask = async (node) => {
      const res = await fetchImpl(`${base}/object_info/${encodeURIComponent(node)}`, { signal: AbortSignal.timeout(10_000) });
      return (await res.json())?.[node]?.input?.required ?? {};
    };
    try {
      const info = await ask('KSampler');
      const fresh = { ...lists, samplers: info.sampler_name?.[0] ?? [], schedulers: info.scheduler?.[0] ?? [] };
      // Installed files by folder, for a ComfyUI whose folder this server
      // cannot read (comfyui.dir unset). Each loader answers for its own.
      const files = {};
      for (const [node, input, folder] of [
        ['CheckpointLoaderSimple', 'ckpt_name', 'checkpoints'],
        ['UNETLoader', 'unet_name', 'diffusion_models'],
        ['CLIPLoader', 'clip_name', 'text_encoders'],
        ['VAELoader', 'vae_name', 'vae'],
        ['LoraLoader', 'lora_name', 'loras'],
      ]) {
        const list = (await ask(node).catch(() => ({})))[input]?.[0];
        if (Array.isArray(list)) files[folder] = list;
      }
      fresh.files = { ...(lists.files ?? {}), ...files };
      if (fresh.samplers.length && fresh.schedulers.length) {
        lists = fresh;
        mkdirSync(rendersDir, { recursive: true });
        writeFileSync(objectInfoCache, JSON.stringify(lists));
      }
    } catch {
      /* the cached lists stand */
    }
    return lists;
  }

  /**
   * Installed files in one ComfyUI models folder (checkpoints,
   * diffusion_models, text_encoders, vae, loras). Read from disk when this
   * server knows the folder — fresh, and no need to wake ComfyUI to fill a
   * dropdown — otherwise ComfyUI's own lists as last seen.
   */
  function installed(folder) {
    if (dir) return listModelFiles(path.join(dir, 'models', folder));
    return lists.files?.[folder] ?? [];
  }

  /**
   * One installed file's size in GB, one decimal, or null when this server
   * cannot see the folder. A file loads as about its own size, so the Edit
   * tab's pickers show it to say which choice is lighter. The name is checked
   * against the folder's own listing before it touches a path.
   */
  function sizeOf(folder, file) {
    if (!dir || !installed(folder).includes(file)) return null;
    try {
      return Math.round(statSync(path.join(dir, 'models', folder, file)).size / 1e8) / 10;
    } catch {
      return null;
    }
  }

  // Header reads are cheap but not free; keyed by name and mtime so a
  // retrained file is read again.
  const loraCache = new Map();
  /** What a LoRA says about itself, or an empty record when its file cannot be read here. */
  function loraInfo(file) {
    const empty = { architecture: null, trigger: null, base_model: null, title: null };
    if (!dir || !installed('loras').includes(file)) return empty;
    const full = path.join(dir, 'models', 'loras', file);
    let mtime = 0;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      return empty;
    }
    const hit = loraCache.get(file);
    if (hit?.mtime === mtime) return hit.info;
    const info = readLoraInfo(full);
    loraCache.set(file, { mtime, info });
    return info;
  }

  // ── VRAM ────────────────────────────────────────────────────

  /** GPU processes as { pid, mib }, or null without nvidia-smi. */
  function gpuApps() {
    if (listGpuApps) return listGpuApps();
    return new Promise((resolve) => {
      execFile(
        config.system?.nvidia_smi ?? 'nvidia-smi',
        ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
        { timeout: 5000 },
        (err, totalOut) => {
          if (err) return resolve(null);
          execFile(
            config.system?.nvidia_smi ?? 'nvidia-smi',
            ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
            { timeout: 5000 },
            (err2, out) => {
              if (err2) return resolve(null);
              const apps = out.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((r) => r.length === 2 && r[0])
                .map(([pid, mib]) => ({ pid: Number(pid), mib: Number(mib) }));
              resolve({ total_mib: Number(String(totalOut).split('\n')[0]) || 0, apps });
            }
          );
        }
      );
    });
  }

  const isComfyPid = (pid) => {
    if (child?.pid === pid) return true;
    if (!dir) return false;
    try {
      return path.resolve(readlinkSync(`/proc/${pid}/cwd`)) === dir;
    } catch {
      return false;
    }
  };

  /**
   * Is there room for this render beside whatever else is on the card?
   * Memory ComfyUI already holds counts as its own — it reuses it. Null when
   * it cannot be told (no nvidia-smi), which keeps the LLM loaded: the
   * measured default is that both fit.
   */
  async function roomFor(gb) {
    const gpu = await gpuApps();
    if (!gpu?.total_mib) return null;
    const others = gpu.apps.filter((a) => !isComfyPid(a.pid)).reduce((n, a) => n + a.mib, 0);
    return (gpu.total_mib - others) / 1024 >= gb;
  }

  // ── renders on disk ────────────────────────────────────────

  function sweep() {
    let entries = [];
    try {
      entries = readdirSync(rendersDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - keepMs;
    for (const f of entries) {
      if (!/^r_[a-f0-9]+\.(png|json)$/.test(f)) continue;
      const p = path.join(rendersDir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {
        /* gone already */
      }
    }
  }
  if (enabled) {
    sweep();
    setInterval(sweep, 3_600_000).unref?.();
  }

  /** A stored render's record and file, or null. The id is checked before it touches a path. */
  function readRender(id) {
    if (!/^r_[a-f0-9]{24}$/.test(String(id))) return null;
    const meta = path.join(rendersDir, `${id}.json`);
    const file = path.join(rendersDir, `${id}.png`);
    if (!existsSync(meta) || !existsSync(file)) return null;
    try {
      return { ...JSON.parse(readFileSync(meta, 'utf8')), file };
    } catch {
      return null;
    }
  }

  /** Delete one stored render, once its picture has been kept somewhere else (a chat edit). */
  function dropRender(id) {
    if (!/^r_[a-f0-9]{24}$/.test(String(id))) return;
    rmSync(path.join(rendersDir, `${id}.png`), { force: true });
    rmSync(path.join(rendersDir, `${id}.json`), { force: true });
  }

  /** Delete every render a user made — for when they clear their history. */
  function forgetUser(user) {
    let n = 0;
    let names = [];
    try {
      names = readdirSync(rendersDir);
    } catch {
      return 0;
    }
    for (const f of names) {
      if (!/^r_[a-f0-9]+\.json$/.test(f)) continue;
      const rec = readRender(f.slice(0, -5));
      if (rec?.user === user) {
        rmSync(rec.file, { force: true });
        rmSync(path.join(rendersDir, f), { force: true });
        n += 1;
      }
    }
    return n;
  }

  // ── one render ─────────────────────────────────────────────

  /**
   * Queue a filled workflow, follow it to the end, store the picture.
   *
   * `onEvent(name, data)` gets: status { state }, progress { value, max }.
   * Resolves with the stored record; rejects with an Error carrying `code`.
   * `signal` aborting removes the prompt from ComfyUI's queue, or interrupts
   * it if it is already running.
   */
  async function run({ api, ui, user, model, settings, positive, negative }, { onEvent = () => {}, signal } = {}) {
    clearTimeout(idleTimer);
    const clientId = randomUUID();
    const ws = new WebSocket(`ws://${new URL(base).host}/ws?clientId=${clientId}`);
    ws.binaryType = 'arraybuffer'; // preview frames, read by previewFrame
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(Object.assign(new Error('Could not open ComfyUI\'s progress socket.'), { code: 'comfyui_unavailable' }));
    });

    let promptId = null;
    const t0 = Date.now();
    try {
      const res = await fetchImpl(`${base}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: api, client_id: clientId, extra_data: ui ? { extra_pnginfo: { workflow: ui } } : {} }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.prompt_id) {
        // ComfyUI names the node and the input it refused; that is the useful part.
        const nodeErrors = Object.values(body.node_errors ?? {})
          .flatMap((n) => (n.errors ?? []).map((e) => `${n.class_type}: ${e.details || e.message}`));
        const why = nodeErrors.join('; ') || body.error?.message || `HTTP ${res.status}`;
        throw Object.assign(new Error(`ComfyUI refused the workflow: ${why}`), { code: 'workflow_refused' });
      }
      promptId = body.prompt_id;
      holding = true;
      // What the GPU panel says while this runs: whose, which model, and the
      // step. Cleared in the finally below.
      current = { prompt_id: promptId, user, model, node: null, value: null, max: null };

      const outcome = await new Promise((resolve) => {
        let started = false;
        const timer = setTimeout(() => resolve({ ok: false, code: 'render_timeout', message: `No picture after ${renderTimeoutMs / 60000} minutes.` }), renderTimeoutMs);
        const finish = (v) => {
          clearTimeout(timer);
          resolve(v);
        };
        signal?.addEventListener('abort', () => finish({ ok: false, code: 'cancelled', message: 'Cancelled.' }), { once: true });
        onEvent('status', { state: 'waiting' });
        // Which node is running, by the name the workflow gives it, so the
        // page can say "Text encoder" or "KSampler · step 12 of 30" the way
        // ComfyUI's own window does (4 Oct 2026, owner's ask).
        const nodeName = (id) => {
          const n = api?.[String(id)];
          return n ? String(n._meta?.title || n.class_type) : null;
        };
        let lastPreview = 0;
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') {
            // A preview of the picture forming. Only this client's socket
            // gets them, so they are this prompt's. Throttled: one a second
            // is plenty to watch, and each is a JPEG through the SSE stream.
            const now = Date.now();
            if (now - lastPreview < 1000) return;
            const image = previewFrame(ev.data);
            if (image) {
              lastPreview = now;
              onEvent('preview', { image });
            }
            return;
          }
          let m;
          try {
            m = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (m.data?.prompt_id !== promptId) return;
          if (m.type === 'execution_start' && !started) {
            started = true;
            onEvent('status', { state: 'loading' });
          } else if (m.type === 'executing' && m.data.node != null) {
            const name = nodeName(m.data.node);
            if (current) Object.assign(current, { node: name, value: null, max: null });
            if (name) onEvent('node', { id: String(m.data.node), name });
          } else if (m.type === 'progress') {
            const node = m.data.node != null ? nodeName(m.data.node) : null;
            if (current) Object.assign(current, { node: node ?? current.node, value: m.data.value, max: m.data.max });
            onEvent('progress', { value: m.data.value, max: m.data.max, node });
          } else if (m.type === 'execution_error') {
            finish({ ok: false, code: 'render_failed', message: `${m.data.node_type ?? 'A node'} failed: ${m.data.exception_message ?? 'unknown error'}`.trim() });
          } else if (m.type === 'execution_interrupted') {
            finish({ ok: false, code: 'cancelled', message: 'Interrupted in ComfyUI.' });
          } else if (m.type === 'execution_success' || (m.type === 'executing' && m.data.node === null)) {
            finish({ ok: true });
          }
        };
        ws.onclose = () => finish({ ok: false, code: 'comfyui_unavailable', message: 'ComfyUI went away mid-render.' });
      });

      if (!outcome.ok) {
        if (outcome.code === 'cancelled' || outcome.code === 'render_timeout') await cancel(promptId);
        throw Object.assign(new Error(outcome.message), { code: outcome.code });
      }

      onEvent('status', { state: 'saving' });
      const hist = (await (await fetchImpl(`${base}/history/${promptId}`)).json())?.[promptId];
      const image = Object.values(hist?.outputs ?? {}).flatMap((o) => o.images ?? []).find((i) => i.type === 'output');
      if (!image) throw Object.assign(new Error('ComfyUI finished but saved no picture.'), { code: 'render_failed' });
      const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: 'output' });
      const png = Buffer.from(await (await fetchImpl(`${base}/view?${q}`)).arrayBuffer());

      const id = `r_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      mkdirSync(rendersDir, { recursive: true });
      writeFileSync(path.join(rendersDir, `${id}.png`), png);
      const record = {
        id,
        user,
        model,
        created_at: new Date().toISOString(),
        ms: Date.now() - t0,
        settings,
        positive,
        negative,
      };
      writeFileSync(path.join(rendersDir, `${id}.json`), JSON.stringify(record));
      // PromptForge's copy is the one with a clock on it. ComfyUI's would
      // otherwise sit in its output folder forever, which is not what "kept
      // 24 hours" means. Only when we know where that folder is.
      if (dir) {
        const own = path.join(dir, 'output', image.subfolder ?? '', image.filename);
        if (path.resolve(own).startsWith(path.join(dir, 'output'))) rmSync(own, { force: true });
      }
      return record;
    } finally {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      armIdleStop();
      if (current?.prompt_id === promptId) current = null;
    }
  }

  /**
   * What ComfyUI is doing right now, for the GPU panel: null when rendering
   * is off; { up: false } when ComfyUI is not running; otherwise whether it
   * is busy, with what, and for how long. A job PromptForge sent carries its
   * person, model and step; one started in ComfyUI directly is described
   * from its graph (describeGraph). Cached for two seconds, because the
   * status poll is per person and five people would otherwise ask ComfyUI
   * five times a second-and-a-bit.
   */
  let activityCache = { at: 0, value: null };
  const firstSeen = new Map();
  async function activity() {
    if (!enabled) return null;
    if (Date.now() - activityCache.at < 2000) return activityCache.value;
    let value;
    try {
      const res = await fetchImpl(`${base}/queue`, { signal: AbortSignal.timeout(1500) });
      const q = await res.json();
      const running = q.queue_running?.[0];
      const pending = q.queue_pending?.length ?? 0;
      if (!running) {
        firstSeen.clear();
        value = { up: true, busy: null, pending };
      } else {
        const id = String(running[1] ?? '');
        if (!firstSeen.has(id)) {
          firstSeen.clear();
          firstSeen.set(id, Date.now());
        }
        const seconds = Math.round((Date.now() - firstSeen.get(id)) / 1000);
        const own = current?.prompt_id === id ? current : null;
        const described = describeGraph(running[2]);
        value = {
          up: true,
          pending,
          busy: {
            source: own ? 'promptforge' : 'outside',
            // A PromptForge render names its registry model key; the server
            // turns it into the label. Anything else is what its files say.
            model: own ? own.model : described.model,
            kind: described.kind,
            user: own?.user ?? null,
            node: own?.node ?? null,
            step: own?.max ? { value: own.value, max: own.max } : null,
            seconds,
          },
        };
      }
    } catch {
      value = { up: false };
    }
    activityCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Put a picture in ComfyUI's input folder for a LoadImage node, under a
   * subfolder of our own and a random name. Returns the name LoadImage takes
   * ("promptforge/<file>"). Edits only: a person's photo, so removeInput
   * deletes it again as soon as the edit is over.
   */
  async function upload(bytes, contentType = 'image/png') {
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[contentType] ?? 'png';
    const name = `e_${randomUUID().replace(/-/g, '').slice(0, 24)}.${ext}`;
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: contentType }), name);
    form.append('subfolder', 'promptforge');
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const res = await fetchImpl(`${base}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.name) {
      throw Object.assign(new Error(`ComfyUI would not take the picture (HTTP ${res.status}).`), { code: 'comfyui_unavailable' });
    }
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  /** Delete an uploaded picture from ComfyUI's input folder. Only ours, only when we know the folder. */
  function removeInput(name) {
    if (!dir || !/^promptforge\/e_[a-f0-9]{24}\.(png|jpg|webp)$/.test(String(name))) return;
    rmSync(path.join(dir, 'input', name), { force: true });
  }

  async function cancel(promptId) {
    const post = (route, body) =>
      fetchImpl(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
    await post('/queue', { delete: [promptId] });
    await post('/interrupt', { prompt_id: promptId });
  }

  return {
    enabled,
    caps,
    defaultVramGb,
    get holding() {
      return holding;
    },
    get lists() {
      return lists;
    },
    up,
    start,
    stop,
    free,
    freeIfIdle,
    refreshLists,
    activity,
    installed,
    sizeOf,
    loraInfo,
    roomFor,
    run,
    upload,
    removeInput,
    readRender,
    dropRender,
    forgetUser,
    sweep,
  };
}
