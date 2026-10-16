// Drive ComfyUI the way the planned Render feature will (docs/render-plan.md):
// start it if it is down, fill a starter workflow by node title, queue it,
// follow progress on the websocket, embed the editable workflow in the PNG.
//
// A reference and a quick check, not part of `npm run check`: it needs the
// server's ComfyUI. Run it on the server:
//
//   node scripts/comfyui-spike.mjs krea2 "a lighthouse at dusk" [lora.safetensors]
//
// It leaves ComfyUI running. Stop it by the PID that holds the port, never
// by pattern:  ss -ltnp | grep 127.0.0.1:8188   (check its cwd, then kill).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMFY = process.env.COMFYUI_DIR ?? '/mnt/ssd/comfyui';
const BASE = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188';
const [model = 'krea2', text = 'a lighthouse on a cliff at dusk, waves below', lora] = process.argv.slice(2);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function up() {
  try { return (await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

if (!(await up())) {
  spawn(`${COMFY}/venv/bin/python`, ['main.py', '--listen', '127.0.0.1', '--port', '8188'], {
    cwd: COMFY, detached: true, stdio: 'ignore',
  }).unref();
  console.log(`${at()} ComfyUI spawned`);
  while (!(await up())) await new Promise((r) => setTimeout(r, 250));
}
console.log(`${at()} ComfyUI answering`);

// Fill by node title: the starter workflows name their nodes for this.
const wf = JSON.parse(readFileSync(path.join(ROOT, 'config/comfyui', `${model}.json`), 'utf8'));
const ui = JSON.parse(readFileSync(path.join(ROOT, 'config/comfyui/ui', `${model}.json`), 'utf8'));
const node = Object.fromEntries(Object.values(wf).map((n) => [n._meta.title, n]));
node['✅ Positive Encode'].inputs.text = text;
node.KSampler.inputs.seed = Math.floor(Math.random() * 2 ** 32);
if (lora) node['Lora Loader'].inputs.lora_1 = { on: true, lora, strength: 0.8 };

const clientId = randomUUID();
const ws = new WebSocket(`ws://${new URL(BASE).host}/ws?clientId=${clientId}`);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

const res = await (await fetch(`${BASE}/prompt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: wf, client_id: clientId, extra_data: { extra_pnginfo: { workflow: ui } } }),
})).json();
if (!res.prompt_id) { console.log('refused:', JSON.stringify(res).slice(0, 400)); process.exit(1); }

const ok = await new Promise((done) => {
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return; // binary preview frames
    const m = JSON.parse(ev.data);
    if (m.data?.prompt_id !== res.prompt_id) return;
    if (m.type === 'progress') console.log(`${at()} step ${m.data.value}/${m.data.max}`);
    if (m.type === 'execution_error') { console.log(`${at()} error: ${m.data.exception_message}`); done(false); }
    if (m.type === 'executing' && m.data.node === null) done(true);
  };
});
ws.close();
const h = (await (await fetch(`${BASE}/history/${res.prompt_id}`)).json())[res.prompt_id];
const files = Object.values(h?.outputs ?? {}).flatMap((o) => o.images ?? []).map((i) => `${i.subfolder}/${i.filename}`);
console.log(`${at()} ${ok ? 'done' : 'FAILED'} -> ${files.join(', ')}  (under ${COMFY}/output)`);
