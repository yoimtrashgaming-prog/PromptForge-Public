// Picture edits with Qwen Image 2.1 (4 Oct 2026, owner's ask).
//
// The Edit tab and chat's edit_picture tool both come through here: a
// picture (and up to three more as references) and a plain instruction go
// in, an LLM that can see the picture rewrites the instruction the way Qwen
// wants it — prompts/edit/qwen-image-2.1.md — and ComfyUI makes the edit.
//
// Not a registry model. config/models.yaml is the builder's list of prompt
// dialects, each with its own tab layout; an edit is a picture in and a
// picture out, so it has its own block in config/server.yaml (`edit:`) and
// its own fixed workflow, config/comfyui/qwen-edit.json, which is the
// official ComfyUI template with the prompt enhancer left out: our own LLM
// does that job, with the picker's model, in our house rules.
//
// The pure parts are here so the suite can test them without a GPU. The
// route is handleEdit in server.mjs.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The segment the writer emits, and the only one. */
export const EDIT_SEGMENT = 'Edit prompt';

/** Most pictures one edit takes: the one being edited plus references. Qwen takes ten; four keeps a phone's upload and the text encoder sane. */
export const EDIT_MAX_PICTURES = 4;

/** config.edit with its defaults, or null when editing is off. */
export function editSettings(config) {
  const e = config.edit ?? {};
  if (e.enabled === false || !config.comfyui?.enabled) return null;
  return {
    label: String(e.label ?? 'Qwen Image 2.1'),
    workflow: String(e.workflow ?? 'config/comfyui/qwen-edit.json'),
    systemPrompt: String(e.system_prompt ?? 'prompts/edit/qwen-image-2.1.md'),
    maxPictures: Math.min(10, Math.max(1, Number(e.max_pictures) || EDIT_MAX_PICTURES)),
    steps: Math.min(60, Math.max(1, Number(e.steps) || 25)),
    resolution: Math.min(2048, Math.max(512, Number(e.resolution) || 1024)),
    vramGb: Number(e.vram_gb) || Number(config.comfyui?.vram_gb) || 10,
    presets: (Array.isArray(e.presets) ? e.presets : [])
      .filter((p) => p && typeof p.name === 'string' && p.name.trim())
      .map((p) => ({
        name: p.name.trim(),
        steps: Math.min(60, Math.max(1, Number(p.steps) || Number(e.steps) || 25)),
        lora: typeof p.lora === 'string' && p.lora.trim() ? p.lora.trim() : null,
      })),
    about: editAbout(e.about),
    // Which installed files the Model / Text encoder / VAE pickers offer, by
    // name. Nothing is ever downloaded: these list what someone has put in
    // ComfyUI's folders themselves. The workflow's own file is always offered.
    match: {
      model: pattern(e.files_match?.model, 'qwen.?image.?2\\.1'),
      // The 8B only: Qwen Image 2.1 is built on Qwen3-VL-8B, and a box with
      // ComfyUI for other models also holds the 4B (Krea2) and 32B (H3) ones.
      text_encoder: pattern(e.files_match?.text_encoder, 'qwen3.?vl.?8b'),
      vae: pattern(e.files_match?.vae, 'qwen.?image.?2\\.1'),
    },
  };
}

function pattern(src, fallback) {
  try {
    return new RegExp(String(src ?? fallback), 'i');
  } catch {
    return new RegExp(fallback, 'i');
  }
}

/** The files a workflow names: its editor, text encoder and VAE. */
export function editWorkflowFiles(wf) {
  const node = (types) => Object.values(wf).find((n) => types.includes(n?.class_type));
  return {
    model: node(['UNETLoader'])?.inputs?.unet_name ?? null,
    text_encoder: node(['CLIPLoader'])?.inputs?.clip_name ?? null,
    vae: node(['VAELoader'])?.inputs?.vae_name ?? null,
  };
}

/**
 * The pickers' lists: the workflow's file first, then every installed file
 * whose name matches. `installed` is { model: [...], text_encoder: [...],
 * vae: [...] } — the folders as they are on disk.
 */
export function editFileChoices(settings, defaults, installed) {
  const pick = (slot) => [...new Set([defaults[slot], ...(installed[slot] ?? []).filter((f) => settings.match[slot].test(f))].filter(Boolean))];
  return { model: pick('model'), text_encoder: pick('text_encoder'), vae: pick('vae') };
}

/**
 * The tab's "About this editor": what model, which files, what it measured,
 * and smaller options. Plain strings only, so nothing in config reaches the
 * page as markup. Null when there is nothing to say.
 */
export function editAbout(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
  const about = { summary: text(raw.summary), needs: text(raw.needs), files: list(raw.files), measured: text(raw.measured), smaller: list(raw.smaller) };
  return about.summary || about.needs || about.files.length || about.measured || about.smaller.length ? about : null;
}

/**
 * The presets this server can run: those with no LoRA, and those whose LoRA
 * is installed. With none configured, one plain preset at the edit's steps.
 */
export function editPresets(settings, installedLoras = []) {
  const ok = settings.presets.filter((p) => !p.lora || installedLoras.includes(p.lora));
  return ok.length ? ok : [{ name: `${settings.steps} steps`, steps: settings.steps, lora: null }];
}

/**
 * The writer's system prompt: the house rules, then the edit file. Read per
 * request, so editing the prompt needs no restart. Null when the edit file
 * is missing — the caller says so rather than editing with no instructions.
 */
export function editSystemPrompt(rootDir, config, settings) {
  let own;
  try {
    own = readFileSync(path.join(rootDir, settings.systemPrompt), 'utf8').trim();
  } catch {
    return null;
  }
  let shared = '';
  try {
    if (config.prompts?.shared_prefix) shared = readFileSync(path.join(rootDir, config.prompts.shared_prefix), 'utf8').trim();
  } catch {
    /* the edit file stands alone */
  }
  return [shared, own].filter(Boolean).join('\n\n---\n\n');
}

/**
 * The user turn for the writer. The pictures ride beside it; this says how
 * many there are, which one is being edited, and whether the person drew on
 * it, because the model cannot tell a drawn circle from a painted one.
 */
export function editUserText({ instruction, count = 1, marked = false }) {
  const lines = [];
  if (count > 1) {
    lines.push(`${count} pictures are attached, in order: <image1> is the one being edited${count > 2 ? `; <image2> to <image${count}> are references` : '; <image2> is a reference'}.`);
  } else {
    lines.push('One picture is attached: the one being edited.');
  }
  if (marked) lines.push('The person drew red marks on the picture being edited, to show where the change goes.');
  lines.push('', 'What the person wants:', String(instruction ?? '').trim());
  return lines.join('\n');
}

/**
 * The instruction as Qwen should get it: one paragraph. The prompt asks for
 * that, and a small model breaks lines anyway; a stray leading label is
 * stripped for the same reason.
 */
export function cleanEditPrompt(text) {
  return String(text ?? '')
    .replace(/^\s*(edit prompt|instruction)\s*:\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The workflow with this edit written in. `images` are file names in
 * ComfyUI's input folder (as /upload/image returned them), the first being
 * the picture edited. A LoadImage node is added per picture and wired into
 * the encoder's numbered slots — `images.image_N`, the API form of the
 * encoder's growing input list.
 */
export function fillEditWorkflow(wf, { prompt, images, seed, steps, resolution, lora = null, files = {} }) {
  const api = structuredClone(wf);
  const ids = Object.keys(api);
  const find = (type) => ids.find((id) => api[id]?.class_type === type);
  // The files picked in the tab. No GGUF: none load in ComfyUI out of the
  // box today (measured 4 Oct 2026), so the pickers never list one.
  const unet = find('UNETLoader');
  if (files.model && unet) api[unet].inputs.unet_name = files.model;
  const clip = find('CLIPLoader');
  if (files.text_encoder && clip) api[clip].inputs.clip_name = files.text_encoder;
  const vae = find('VAELoader');
  if (files.vae && vae) api[vae].inputs.vae_name = files.vae;
  const encoder = find('TextEncodeQwenImage21');
  const sampler = find('KSampler');
  if (!encoder || !sampler) throw new Error('The edit workflow needs a TextEncodeQwenImage21 node and a KSampler.');
  if (!images?.length) throw new Error('An edit needs a picture.');
  Object.assign(api[encoder].inputs, { prompt, negative_prompt: '', resolution });
  for (const k of Object.keys(api[encoder].inputs)) if (/^images\.image_\d+$/.test(k)) delete api[encoder].inputs[k];
  let next = Math.max(0, ...ids.map(Number).filter(Number.isFinite)) + 1;
  images.forEach((name, i) => {
    const id = String(next++);
    api[id] = { inputs: { image: name }, class_type: 'LoadImage', _meta: { title: i === 0 ? 'Picture' : `Reference ${i}` } };
    api[encoder].inputs[`images.image_${i + 1}`] = [id, 0];
  });
  Object.assign(api[sampler].inputs, { seed, steps });
  // A speed LoRA goes between the editor's loader and whatever took the
  // loader's model, so everything downstream gets the LoRA'd one.
  if (lora) {
    if (!unet) throw new Error('The edit workflow needs a model loader to put a LoRA on.');
    const id = String(next++);
    for (const node of Object.values(api)) {
      for (const [k, v] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(v) && v[0] === unet && v[1] === 0) node.inputs[k] = [id, 0];
      }
    }
    api[id] = { inputs: { lora_name: lora, strength_model: 1, model: [unet, 0] }, class_type: 'LoraLoaderModelOnly', _meta: { title: 'Speed LoRA' } };
  }
  return api;
}

/** A data URL's bytes and type, or null. Only pictures. */
export function fromDataUrl(url) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(url ?? ''));
  if (!m) return null;
  return { type: m[1].toLowerCase(), bytes: Buffer.from(m[2], 'base64') };
}
