// The optional features from the setup wizard and the Setup panel (4 Oct 2026):
// rendering through ComfyUI and LoRA training through TrainFlow.
//
// The owner's brief: some people only want prompt writing and should never
// download anything else, and anyone can switch the rest on later. So both
// are off until chosen, and choosing one is pasting a folder or an address,
// never editing YAML.
//
// Saved to data/comfyui.json and data/training.json (gitignored). Where they
// rank: server.yaml < these < server.local.yaml < environment. A box that set
// either block by hand (the group's server does) is never moved by them.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const FILES = { comfyui: 'comfyui.json', training: 'training.json' };

/** Strip the quotes Windows' "Copy as path" puts around a folder. */
export function cleanFolder(raw) {
  return String(raw ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
}

/**
 * Find ComfyUI and the Python that runs it from one pasted folder. Accepts
 * the ComfyUI folder itself, the folder above it (the DaSiWa installer's and
 * the Windows portable build's layout), and the venv names in common use.
 * Returns { dir, python } or { error }.
 */
export function findComfy(folder, { platform = process.platform, exists = existsSync } = {}) {
  const root = cleanFolder(folder);
  if (!root) return { error: 'Paste the folder ComfyUI is in first.' };
  if (!path.isAbsolute(root)) return { error: 'Paste the full path, starting from the drive or /.' };
  if (!exists(root)) return { error: `There is no folder at ${root} on the server.` };

  const dir = [root, path.join(root, 'ComfyUI')].find((d) => exists(path.join(d, 'main.py')));
  if (!dir) return { error: `No ComfyUI in ${root}: neither it nor a ComfyUI folder inside it has main.py.` };

  const bin = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const parent = path.dirname(dir);
  const candidates = [
    path.join(dir, 'venv', ...bin),
    path.join(dir, '.venv', ...bin),
    path.join(parent, 'venv', ...bin),
    path.join(parent, '.venv', ...bin),
    // The Windows portable build: python_embeded beside the ComfyUI folder.
    path.join(parent, 'python_embeded', platform === 'win32' ? 'python.exe' : 'python'),
  ];
  const python = candidates.find((p) => exists(p));
  if (!python) {
    return {
      error: `Found ComfyUI at ${dir}, but not its Python (no venv folder). Start ComfyUI yourself and use "It is already running" instead.`,
    };
  }
  return { dir, python };
}

/** A pasted address, normalised, or null when it is not an http(s) URL. */
export function cleanUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? s : null;
  } catch {
    return null;
  }
}

export function createFeatureSetup({ rootDir, dataDir = 'data' }) {
  const file = (name) => path.resolve(rootDir, dataDir, FILES[name]);

  function read(name) {
    try {
      return JSON.parse(readFileSync(file(name), 'utf8'));
    } catch {
      return null;
    }
  }

  function write(name, value) {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), JSON.stringify(value, null, 2));
  }

  /**
   * Lay the saved choices over the shared defaults, skipping a block the
   * local config set any key of. `applied` is loadConfig's list of keys
   * server.local.yaml changed.
   */
  function apply(config, applied = []) {
    const local = (block) => applied.some((k) => k === block || k.startsWith(`${block}.`));
    const comfy = read('comfyui');
    if (comfy && !local('comfyui')) {
      config.comfyui = { ...(config.comfyui ?? {}), ...pick(comfy, ['enabled', 'dir', 'python', 'url']) };
    }
    const training = read('training');
    if (training && !local('training')) {
      config.training = { ...(config.training ?? {}), ...pick(training, ['backend', 'base_url']) };
    }
    return config;
  }

  return { apply, read, write, exists: (name) => existsSync(file(name)) };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}
