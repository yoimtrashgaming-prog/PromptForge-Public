// Tagger setup from the owner's Setup panel (22 Sep 2026).
//
// The owner's brief: "as easy for a new user as possible". So nobody edits a
// YAML file or types six file paths:
//
//   - paste ONE folder (a ComfyUI install, a downloads folder) and it is
//     searched for the files each tagger needs, by their real names;
//   - or press Download for the two WD taggers, which are public (Apache-2.0,
//     no login) and land in the project's own taggers/ folder;
//   - animetimm cannot be one click - its repo is gated and it has to be
//     converted to ONNX first (docs/taggers-setup.md) - but a folder holding
//     the converted files is found like any other.
//
// What is found is saved to data/taggers.json (gitignored) and ranks between
// config/taggers.yaml and config/taggers.local.yaml, so a box that set its
// paths by hand (the P40) is never moved. Tagger sessions load lazily, so the
// caller rebuilds its tagger store after a save and no restart is needed.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, createWriteStream, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The two taggers that can be fetched without a login, and the exact sizes
// the group's own server has - a download of any other size is refused.
const DOWNLOADS = {
  wd14_eva02: {
    repo: 'SmilingWolf/wd-eva02-large-tagger-v3',
    files: { model: ['model.onnx', 1260435999], labels: ['selected_tags.csv', 308468] },
  },
  wd14_moat: {
    repo: 'SmilingWolf/wd-v1-4-moat-tagger-v2',
    files: { model: ['model.onnx', 326197340], labels: ['selected_tags.csv', 253906] },
  },
};

// Bounds on a folder search. A ComfyUI install is big but not this big; the
// caps stop a pasted drive root from walking the whole disk.
const MAX_DEPTH = 8;
const MAX_ENTRIES = 250000;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.cache', 'venv', '.venv']);

export function createTaggerSetup({ rootDir, dataDir }) {
  const settingFile = path.resolve(rootDir, dataDir, 'taggers.json');
  const taggersDir = path.resolve(rootDir, 'taggers');
  const downloads = new Map(); // key -> { state, received, total, error }

  function readSetting() {
    try {
      const s = JSON.parse(readFileSync(settingFile, 'utf8'));
      return s && typeof s.taggers === 'object' ? s : { taggers: {} };
    } catch {
      return { taggers: {} };
    }
  }

  function writeSetting(s) {
    mkdirSync(path.dirname(settingFile), { recursive: true });
    writeFileSync(settingFile, JSON.stringify(s, null, 2));
  }

  /**
   * Fold the saved paths into a merged taggers config. `localKeys` are the
   * dotted keys taggers.local.yaml set; any tagger it names keeps its paths.
   */
  function apply(config, localKeys = []) {
    const saved = readSetting().taggers;
    for (const [key, paths] of Object.entries(saved)) {
      const def = config?.taggers?.[key];
      if (!def) continue;
      if (localKeys.some((k) => k.startsWith(`taggers.${key}.`))) continue;
      if (paths.model) def.model = paths.model;
      if (paths.labels) def.labels = paths.labels;
    }
    return config;
  }

  function sourceOf(key, localKeys) {
    if (localKeys.some((k) => k.startsWith(`taggers.${key}.`))) return 'local_config';
    return readSetting().taggers[key] ? 'setting' : 'default';
  }

  /** What each tagger needs and whether this box has it. */
  function status(config, localKeys = []) {
    mkdirSync(taggersDir, { recursive: true });
    const rows = [];
    for (const [key, def] of Object.entries(config?.taggers ?? {})) {
      const model = def.model ? path.resolve(rootDir, def.model) : null;
      const labels = def.labels ? path.resolve(rootDir, def.labels) : null;
      const needs = [model, labels];
      // animetimm's weights sit in a second file beside the graph.
      if (model && /animetimm/i.test(path.basename(model))) needs.push(`${model}.data`);
      const missing = needs.filter((p) => !p || !existsSync(p)).map((p) => (p ? path.basename(p) : '(no path)'));
      rows.push({
        key,
        name: def.name ?? key,
        found: missing.length === 0,
        missing,
        model,
        labels,
        source: sourceOf(key, localKeys),
        downloadable: Boolean(DOWNLOADS[key]),
        download: downloads.get(key) ?? null,
      });
    }
    return { taggers_dir: taggersDir, taggers: rows };
  }

  /**
   * Search a folder for each tagger's files by name. Returns
   * { found: { key: { model, labels } }, searched } without saving.
   */
  function scan(folder, config) {
    const want = new Map(); // lowercased filename -> [{ key, role }]
    const add = (name, key, role) => {
      const n = name.toLowerCase();
      if (!want.has(n)) want.set(n, []);
      want.get(n).push({ key, role });
    };
    for (const [key, def] of Object.entries(config?.taggers ?? {})) {
      if (def.model) add(path.basename(def.model), key, 'model');
      if (def.labels) add(path.basename(def.labels), key, 'labels');
    }
    const hits = {};
    let searched = 0;
    const stack = [[path.resolve(folder), 0]];
    while (stack.length && searched < MAX_ENTRIES) {
      const [dir, depth] = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        searched += 1;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) stack.push([full, depth + 1]);
          continue;
        }
        for (const { key, role } of want.get(e.name.toLowerCase()) ?? []) {
          (hits[key] ??= {})[role] ??= full;
        }
      }
    }
    // Only a complete set counts: a model with no labels file, or animetimm
    // without its .onnx.data beside it, would load and then fail.
    const found = {};
    for (const [key, h] of Object.entries(hits)) {
      if (!h.model || !h.labels) continue;
      if (/animetimm/i.test(path.basename(h.model)) && !existsSync(`${h.model}.data`)) continue;
      found[key] = { model: h.model, labels: h.labels };
    }
    return { found, searched, capped: searched >= MAX_ENTRIES };
  }

  /** Save paths for some taggers, leaving the rest as they were. */
  function save(found) {
    const s = readSetting();
    for (const [key, paths] of Object.entries(found)) s.taggers[key] = paths;
    writeSetting(s);
  }

  /**
   * Fetch one WD tagger into taggers/ in the background. `onDone` runs after
   * both files are in place and saved, so the caller can reload.
   */
  function startDownload(key, config, onDone) {
    const spec = DOWNLOADS[key];
    const def = config?.taggers?.[key];
    if (!spec || !def) return { ok: false, message: 'That tagger cannot be downloaded from here.' };
    if (downloads.get(key)?.state === 'downloading') return { ok: true };

    const job = { state: 'downloading', received: 0, total: spec.files.model[1] + spec.files.labels[1], error: null };
    downloads.set(key, job);
    mkdirSync(taggersDir, { recursive: true });

    (async () => {
      const targets = {};
      for (const role of ['labels', 'model']) {
        const [remote, size] = spec.files[role];
        const dest = path.join(taggersDir, path.basename(def[role]));
        const part = `${dest}.part`;
        const res = await fetch(`https://huggingface.co/${spec.repo}/resolve/main/${remote}`);
        if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status} for ${remote}`);
        let got = 0;
        const counter = new TransformStream({
          transform(chunk, ctl) {
            got += chunk.byteLength;
            job.received += chunk.byteLength;
            ctl.enqueue(chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part));
        if (statSync(part).size !== size) {
          rmSync(part, { force: true });
          throw new Error(`${remote} arrived as ${got} bytes, expected ${size} - not used`);
        }
        renameSync(part, dest);
        targets[role] = dest;
      }
      save({ [key]: targets });
      job.state = 'done';
      onDone?.();
    })().catch((err) => {
      job.state = 'failed';
      job.error = err.message;
      console.warn(`[taggers] download of ${key} failed: ${err.message}`);
    });
    return { ok: true };
  }

  return { apply, status, scan, save, startDownload, settingFile };
}
