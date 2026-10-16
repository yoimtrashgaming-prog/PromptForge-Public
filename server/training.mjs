/**
 * A thin proxy to a real TrainFlow instance, not a training backend of our
 * own. TrainFlow already has /api/train/start, /api/status and /api/train/stop
 * (internal/trainer/routes.go in the DaSiWa node pack's repo); this just forwards
 * to them so the owner can drive a real run from PromptForge's admin surface
 * instead of TrainFlow's own UI.
 *
 * Deliberately not the `stub` backend's replacement. `training.backend` must
 * be "trainflow" and `training.base_url` must point at a running instance -
 * both live in config/server.local.yaml on the box, never committed, because
 * this is testing scaffolding, not a shipped feature. Everyone else sees a
 * static "currently testing" message; this module is never reached for them,
 * since every route it backs sits under /api/admin/.
 *
 * It also owns dataset uploads, which TrainFlow cannot do at all - it has no
 * multipart handler and no upload route, only path fields naming files that
 * already exist on the box. Without this the only way in is scp, which is not
 * an answer for someone driving the app from a browser.
 */

import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

// What a dataset directory may be called, and what may be put in it. Both are
// allow-lists rather than an attempt to strip bad characters: these names
// become path segments, and the only safe way to build a path out of
// user-supplied text is to refuse anything that is not plainly a name.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATASET_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.txt', '.caption']);

export function createTraining(root, config) {
  const backend = config.training?.backend ?? 'stub';
  const baseUrl = (config.training?.base_url || '').replace(/\/$/, '');

  // Absolute, because these paths are shown to the person so they can paste
  // them into TrainFlow's own Dataset Path and Output Path fields, and
  // TrainFlow resolves them in its own working directory, not ours. An
  // absolute value in config is taken as-is; anything else is relative to the
  // install, which is what keeps the committed default portable while the box
  // points at plain folders in the owner's home.
  const abs = (v, fallback) => (v && path.isAbsolute(v) ? v : path.resolve(root, v || fallback));
  const datasetsDir = abs(config.training?.dataset_dir, 'data/training/promptforge-training-dataset');
  const outputDir = abs(config.training?.output_dir, 'data/training/promptforge-lora-output');
  const outputSlots = Math.max(1, Number(config.training?.output_slots ?? 5));
  const retentionDays = Number(config.training?.retention_days ?? 15);

  /**
   * The folders exist before anything asks for them, so the person can paste a
   * path into TrainFlow without having uploaded anything first, and so the
   * numbered output slots are a fixed, predictable set rather than something
   * that appears only after a run.
   */
  function ensureLayout() {
    mkdirSync(datasetsDir, { recursive: true });
    for (let i = 1; i <= outputSlots; i++) mkdirSync(path.join(outputDir, `lora-output${i}`), { recursive: true });
  }

  /** Newest mtime anywhere inside a directory, or 0 when it holds no files. */
  function newestMtime(dir) {
    let newest = 0;
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    };
    try { walk(dir); } catch { /* raced with a delete */ }
    return newest;
  }

  /**
   * Age out uploaded datasets and finished LoRA output.
   *
   * Age is the NEWEST file inside, not the folder's own timestamp: a dataset
   * still being uploaded, or an output folder a run is writing into, is young
   * by that measure and cannot be swept out from under itself. A folder's own
   * mtime would not give that guarantee.
   *
   * Datasets are removed entirely - the folder is named after what the person
   * uploaded, so an empty husk means nothing. Output slots are emptied but
   * kept, because they are a fixed set of numbered destinations and deleting
   * lora-output3 would quietly change what the person can pick.
   */
  function sweep() {
    if (!(retentionDays > 0)) return { datasets: [], outputs: [] };
    const cutoff = Date.now() - retentionDays * 86400000;
    const removed = { datasets: [], outputs: [] };

    if (existsSync(datasetsDir)) {
      for (const name of readdirSync(datasetsDir)) {
        const dir = path.join(datasetsDir, name);
        try {
          if (!statSync(dir).isDirectory()) continue;
          const newest = newestMtime(dir);
          if (newest && newest < cutoff) { rmSync(dir, { recursive: true, force: true }); removed.datasets.push(name); }
        } catch { /* gone already */ }
      }
    }

    for (let i = 1; i <= outputSlots; i++) {
      const slot = path.join(outputDir, `lora-output${i}`);
      try {
        if (!existsSync(slot)) { mkdirSync(slot, { recursive: true }); continue; }
        const newest = newestMtime(slot);
        if (newest && newest < cutoff) {
          for (const f of readdirSync(slot)) rmSync(path.join(slot, f), { recursive: true, force: true });
          removed.outputs.push(`lora-output${i}`);
        }
      } catch { /* gone already */ }
    }
    return removed;
  }

  const enabled = backend === 'trainflow' && Boolean(baseUrl);

  async function call(method, path, body) {
    if (!enabled) {
      return { ok: false, status: 503, message: 'training.backend is not "trainflow", or base_url is unset.' };
    }
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, message: data.message || `TrainFlow returned ${res.status}` };
      }
      return { ok: true, status: 200, data };
    } catch (err) {
      return { ok: false, status: 502, message: `Could not reach TrainFlow at ${baseUrl}: ${err.message}` };
    }
  }

  /** The directory for one dataset, or null if the name is not a plain name. */
  function datasetPath(name) {
    if (!SAFE_NAME.test(String(name ?? ''))) return null;
    const dir = path.join(datasetsDir, name);
    // Belt and braces. SAFE_NAME already excludes separators and dots-only
    // names, so this cannot currently fail - but containment should be a
    // property of the path, not of the regex staying correct forever.
    return dir.startsWith(datasetsDir + path.sep) ? dir : null;
  }

  return {
    enabled,
    // The reverse proxy in server.mjs needs the target itself, not just a
    // yes/no - it forwards raw HTML, CSS, JS and a WebSocket, none of which
    // go through call() below.
    baseUrl,
    datasetsDir,
    outputDir,
    ensureLayout,
    sweep,
    retentionDays,

    /**
     * What a run produced: LoRA checkpoints and any sample images, newest
     * first. Uploading a dataset but having no way to get the result back
     * left the useful half of the job on the box - the .safetensors IS the
     * deliverable, and scp is not an answer for someone working in a browser.
     */
    listOutput(slot) {
      if (!SAFE_NAME.test(String(slot ?? ''))) {
        return { ok: false, status: 400, message: 'Bad output slot.' };
      }
      const dir = path.join(outputDir, slot);
      if (!dir.startsWith(outputDir + path.sep) || !existsSync(dir)) {
        return { ok: false, status: 404, message: `No such output slot: ${slot}` };
      }
      const files = [];
      const walk = (abs, prefix) => {
        for (const f of readdirSync(abs)) {
          const p = path.join(abs, f);
          const st = statSync(p);
          // The resume "-state" folders are optimiser internals for continuing
          // a run, not something anyone downloads.
          if (st.isDirectory()) {
            if (!f.endsWith('-state')) walk(p, `${prefix}${f}/`);
          } else if (st.isFile()) {
            files.push({ name: `${prefix}${f}`, size: st.size, mtime: st.mtimeMs });
          }
        }
      };
      walk(dir, '');
      files.sort((a, b) => b.mtime - a.mtime);
      return { ok: true, status: 200, data: { slot, path: dir, files } };
    },

    /**
     * An absolute path inside an output slot, for streaming back to the
     * browser - or null when the name is not plainly a name. Returns the path
     * rather than the bytes because a LoRA is hundreds of megabytes and must
     * be streamed, not read into memory.
     */
    outputFilePath(slot, file) {
      if (!SAFE_NAME.test(String(slot ?? ''))) return null;
      const segs = String(file ?? '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
      if (!segs.length || !segs.every((s) => SAFE_NAME.test(s))) return null;
      const dir = path.join(outputDir, slot);
      const target = path.join(dir, ...segs);
      if (!target.startsWith(dir + path.sep) || !existsSync(target) || !statSync(target).isFile()) return null;
      return target;
    },

    /** The paths the person pastes into TrainFlow, and how long they last. */
    layout() {
      ensureLayout();
      const slots = [];
      for (let i = 1; i <= outputSlots; i++) {
        const dir = path.join(outputDir, `lora-output${i}`);
        let files = 0;
        try { files = readdirSync(dir).length; } catch { /* just created */ }
        slots.push({ name: `lora-output${i}`, path: dir, files });
      }
      return {
        ok: true,
        status: 200,
        data: { datasets_root: datasetsDir, output_root: outputDir, slots, retention_days: retentionDays },
      };
    },

    /**
     * What is already in a dataset, as {name: size}. The browser uses this to
     * skip files it has already sent, which is what makes a 9GB folder
     * survivable: a dropped connection or a closed tab resumes instead of
     * starting again. Sizes are compared too, so a half-written file from a
     * killed upload is re-sent rather than trusted.
     */
    listDataset(name) {
      const dir = datasetPath(name);
      if (!dir) return { ok: false, status: 400, message: 'Dataset names may use letters, numbers, dot, dash and underscore.' };
      // Walks sub-folders, keyed by the same relative path the browser sends,
      // so resume matches what an upload actually wrote. Keying on basenames
      // would report `input/2.txt` as `2.txt` and skip a file that was never
      // uploaded.
      const files = {};
      const walk = (abs, prefix) => {
        for (const f of readdirSync(abs)) {
          const st = statSync(path.join(abs, f));
          if (st.isDirectory()) walk(path.join(abs, f), `${prefix}${f}/`);
          else if (st.isFile()) files[`${prefix}${f}`] = st.size;
        }
      };
      if (existsSync(dir)) walk(dir, '');
      return { ok: true, status: 200, data: { name, path: dir, files, count: Object.keys(files).length } };
    },

    /** Every dataset that exists, newest first, for the picker. */
    listDatasets() {
      if (!existsSync(datasetsDir)) return { ok: true, status: 200, data: { root: datasetsDir, datasets: [] } };
      const datasets = readdirSync(datasetsDir)
        .filter((n) => SAFE_NAME.test(n) && statSync(path.join(datasetsDir, n)).isDirectory())
        .map((n) => {
          const dir = path.join(datasetsDir, n);
          const files = readdirSync(dir);
          const images = files.filter((f) => DATASET_EXT.has(path.extname(f).toLowerCase()) && !f.endsWith('.txt'));
          return { name: n, path: dir, files: files.length, images: images.length, mtime: statSync(dir).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return { ok: true, status: 200, data: { root: datasetsDir, datasets } };
    },

    /**
     * Write one file into a dataset. One request per file, raw bytes - the
     * same shape the image routes already use, and it keeps a multipart
     * parser out of a server that has no framework to bring one.
     *
     * Overwrites deliberately: a re-send is how a partial file gets repaired.
     */
    saveDatasetFile(name, filename, buf) {
      const dir = datasetPath(name);
      if (!dir) return { ok: false, status: 400, message: 'Bad dataset name.' };

      // Sub-folders are KEPT, not flattened. A training folder can hold both
      // `2.txt` and `input/2.txt` - flattening to the basename silently
      // overwrote one with the other and produced a quietly wrong dataset
      // rather than an error. sd-scripts' `N_concept` repeat folders are the
      // same shape, and collapsing those changes what gets trained.
      //
      // Every segment is checked the same way a dataset name is: an
      // allow-list, so "..", a drive letter or an absolute path cannot be a
      // segment at all.
      const rel = String(filename ?? '').replace(/\\/g, '/');
      const segs = rel.split('/').filter((s) => s !== '' && s !== '.');
      if (!segs.length) return { ok: false, status: 400, message: 'Missing file name.' };
      const base = segs[segs.length - 1];
      if (!segs.every((s) => SAFE_NAME.test(s))) {
        return { ok: false, status: 400, message: `"${filename}" has a folder or file name that is not a plain name.` };
      }
      if (!DATASET_EXT.has(path.extname(base).toLowerCase())) {
        return { ok: false, status: 400, message: `"${base}" is not an image or caption file.` };
      }

      const target = path.join(dir, ...segs);
      if (!target.startsWith(dir + path.sep)) return { ok: false, status: 400, message: 'Bad file name.' };
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, buf);
      return { ok: true, status: 200, data: { name: segs.join('/'), size: buf.length, path: target } };
    },

    async status() {
      return call('GET', '/api/status');
    },

    async start(settings) {
      return call('POST', '/api/train/start', settings);
    },

    async stop() {
      return call('POST', '/api/train/stop');
    },
  };
}
