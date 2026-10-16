// The owner's render catalogue: which model files belong to which
// PromptForge model, with their own presets, and what each LoRA is for.
//
// Stage 2 of docs/render-plan.md. Agreed 3 Oct 2026:
//   - the Model dropdown shows only files the owner has added here (1a),
//     because ComfyUI's models folders mix every model on the box;
//   - LoRAs are matched to a model by what the file says about itself, and
//     the owner can correct the match and the trigger words (2a);
//   - no Civitai lookups (3, owner's call: no outside requests).
//
// The owner is also the main user ("admin just need most control over
// everything"), so this is edited in the app, not in config: one JSON file in
// the data folder, written whole on every change.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEXT_MAX = 2000;
const TRIGGERS_MAX = 20;

function fail(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

/**
 * One model file's preset, cleaned. Every field is optional: what is left out
 * falls through to the PromptForge model's preset, then the workflow's own.
 */
function cleanFileEntry(raw, { modelKeys, samplers, schedulers }) {
  const e = raw ?? {};
  if (!modelKeys.includes(e.model)) throw fail(400, `Unknown model "${e.model}".`);
  const out = { model: e.model };
  const num = (v, lo, hi, what, int = false) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) throw fail(400, `${what} must be ${lo} to ${hi}.`);
    return n;
  };
  const steps = num(e.steps, 1, 200, 'Steps', true);
  const cfg = num(e.cfg, 0, 30, 'CFG');
  if (steps !== undefined) out.steps = steps;
  if (cfg !== undefined) out.cfg = cfg;
  for (const [k, list] of [['sampler', samplers], ['scheduler', schedulers]]) {
    if (!e[k]) continue;
    if (list?.length && !list.includes(e[k])) throw fail(400, `Unknown ${k} "${e[k]}".`);
    out[k] = String(e[k]);
  }
  for (const k of ['prefix', 'negative']) {
    const t = String(e[k] ?? '').trim();
    if (t.length > TEXT_MAX) throw fail(400, `The ${k} is capped at ${TEXT_MAX} characters.`);
    if (t) out[k] = t;
  }
  return out;
}

function cleanLoraEntry(raw, { modelKeys }) {
  const e = raw ?? {};
  const out = {};
  // `models` is the owner's override of the metadata match: an explicit list,
  // [] for "none of them", absent for "go by the file".
  if (Array.isArray(e.models)) {
    for (const m of e.models) if (!modelKeys.includes(m)) throw fail(400, `Unknown model "${m}".`);
    out.models = [...new Set(e.models)];
  }
  if (e.triggers !== undefined && e.triggers !== null) {
    const list = (Array.isArray(e.triggers) ? e.triggers : String(e.triggers).split(','))
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (list.length > TRIGGERS_MAX) throw fail(400, `At most ${TRIGGERS_MAX} trigger words.`);
    out.triggers = list;
  }
  return out;
}

export function createRenderModels(rootDir, dataDir) {
  const file = path.resolve(rootDir, dataDir, 'render-models.json');

  function read() {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return { files: j.files ?? {}, loras: j.loras ?? {} };
    } catch {
      return { files: {}, loras: {} };
    }
  }

  function write(data) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Write then rename, so a crash mid-write never leaves half a catalogue.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  }

  return {
    read,
    exists: () => existsSync(file),

    /** Add or replace one model file's entry. `installed` is what is on disk for its loader. */
    setFile(name, raw, ctx) {
      const f = String(name ?? '');
      if (!ctx.installed.includes(f)) throw fail(404, `"${f}" is not installed in ComfyUI.`);
      const data = read();
      data.files[f] = cleanFileEntry(raw, ctx);
      write(data);
      return data.files[f];
    },

    removeFile(name) {
      const data = read();
      if (!data.files[name]) throw fail(404, `"${name}" is not in the catalogue.`);
      delete data.files[name];
      write(data);
    },

    setLora(name, raw, ctx) {
      const f = String(name ?? '');
      if (!ctx.installed.includes(f)) throw fail(404, `"${f}" is not installed in ComfyUI.`);
      const data = read();
      const entry = cleanLoraEntry(raw, ctx);
      if (Object.keys(entry).length) data.loras[f] = entry;
      else delete data.loras[f];
      write(data);
      return data.loras[f] ?? {};
    },
  };
}
