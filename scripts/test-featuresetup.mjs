// Rendering and LoRA training as chosen in the setup wizard: finding ComfyUI
// from one pasted folder, and the saved choice standing aside for a block set
// by hand in server.local.yaml.
//
//   node scripts/test-featuresetup.mjs
//
// No server, no ComfyUI. Folder layouts are faked through `exists`.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findComfy, cleanFolder, cleanUrl, createFeatureSetup } from '../server/featuresetup.mjs';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

// A fake disk: the set of paths that exist, written with forward slashes.
const disk = (...paths) => {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
};
const R = path.resolve('/srv');
const j = (...p) => path.join(R, ...p);

let r = findComfy(j('ComfyUI'), { platform: 'linux', exists: disk(j('ComfyUI'), j('ComfyUI', 'main.py'), j('ComfyUI', 'venv', 'bin', 'python')) });
check('the ComfyUI folder itself, venv inside', r.dir === j('ComfyUI') && r.python === j('ComfyUI', 'venv', 'bin', 'python'), JSON.stringify(r));

r = findComfy(R, { platform: 'linux', exists: disk(R, j('ComfyUI', 'main.py'), j('ComfyUI', 'venv', 'bin', 'python')) });
check('the folder above it (the installer layout)', r.dir === j('ComfyUI'), JSON.stringify(r));

r = findComfy(R, { platform: 'win32', exists: disk(R, j('ComfyUI', 'main.py'), j('python_embeded', 'python.exe')) });
check('the Windows portable build', r.python === j('python_embeded', 'python.exe'), JSON.stringify(r));

r = findComfy(j('ComfyUI'), { platform: 'win32', exists: disk(j('ComfyUI'), j('ComfyUI', 'main.py'), j('ComfyUI', 'venv', 'Scripts', 'python.exe')) });
check('a Windows venv is Scripts/python.exe', r.python === j('ComfyUI', 'venv', 'Scripts', 'python.exe'), JSON.stringify(r));

r = findComfy(j('ComfyUI'), { platform: 'linux', exists: disk(j('ComfyUI'), j('ComfyUI', 'main.py')) });
check('ComfyUI without a Python says so', /not its Python/.test(r.error ?? ''), JSON.stringify(r));

r = findComfy(j('stuff'), { platform: 'linux', exists: disk(j('stuff')) });
check('a folder with no ComfyUI says so', /No ComfyUI/.test(r.error ?? ''), JSON.stringify(r));
check('an empty paste is refused', Boolean(findComfy('  ').error));
check('a relative path is refused', /full path/.test(findComfy('ComfyUI').error ?? ''));
check('Copy-as-path quotes are stripped', cleanFolder('"C:\ComfyUI"') === 'C:\ComfyUI');

check('an address loses its trailing slash', cleanUrl('http://127.0.0.1:8188/') === 'http://127.0.0.1:8188');
check('a non-address is refused', cleanUrl('127.0.0.1:8188') === null && cleanUrl('ftp://x') === null);

// Saved choices, against a real throwaway data folder.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pf-featuresetup-'));
try {
  const fs = createFeatureSetup({ rootDir: tmp, dataDir: 'data' });
  const base = () => ({ comfyui: { enabled: false, url: 'http://127.0.0.1:8188', caps: { max_steps: 60 } }, training: { backend: 'stub', base_url: 'http://127.0.0.1:8900' } });
  check('nothing saved, nothing changed', JSON.stringify(fs.apply(base())) === JSON.stringify(base()));
  fs.write('comfyui', { enabled: true, dir: '/c', python: '/c/venv/bin/python', url: 'http://127.0.0.1:8188' });
  fs.write('training', { backend: 'trainflow', base_url: 'http://127.0.0.1:9000' });
  let c = fs.apply(base());
  check('a saved ComfyUI switches rendering on', c.comfyui.enabled === true && c.comfyui.dir === '/c');
  check('and keeps the rest of the block', c.comfyui.caps?.max_steps === 60);
  check('a saved TrainFlow switches training on', c.training.backend === 'trainflow' && c.training.base_url === 'http://127.0.0.1:9000');
  c = fs.apply(base(), ['comfyui.dir', 'training.backend']);
  check('server.local.yaml outranks both', c.comfyui.enabled === false && c.training.backend === 'stub');
  c = fs.apply(base(), ['server.bind']);
  check('an unrelated local key does not', c.comfyui.enabled === true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
