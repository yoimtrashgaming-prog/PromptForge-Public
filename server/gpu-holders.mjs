// Who else is on the GPU, and freeing the ComfyUIs among them that are idle.
//
// 5 Oct 2026: another ComfyUI, started on port 8191 for a test of the DaSiWa
// node pack, held 14.4 GB for three minutes. Every 27B load failed beside it,
// the live site's included, and the only thing anyone saw was llama-swap's
// "upstream command exited prematurely" as HTTP 500. comfy.freeIfIdle only
// knows the ComfyUI at comfyui.url, so it never looked.
//
// Two jobs, both small:
//   - before an LLM loads, a ComfyUI on any other port that holds the card
//     and has nothing queued is asked to unload (POST /free), the same rule
//     the owner set for the configured one on 4 Oct: unload, never stop, never
//     while it is working;
//   - when a load fails anyway, the error names what holds the card, so the
//     person knows it is not PromptForge and what to stop.
//
// Linux with nvidia-smi only. Anywhere else, or when a command fails, it
// reports nothing and frees nothing, which is how the app behaved before.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, out) => resolve(err ? '' : String(out)));
  });

/** `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` -> [{ pid, mib }]. */
export function parseComputeApps(text = '') {
  return String(text)
    .split('\n')
    .map((line) => line.split(',').map((v) => v.trim()))
    .filter(([pid, mib]) => /^\d+$/.test(pid ?? '') && /^\d+$/.test(mib ?? ''))
    .map(([pid, mib]) => ({ pid: Number(pid), mib: Number(mib) }));
}

/** `ss -ltnpH` -> Map(pid -> [port]). Only listeners this user can see the owner of. */
export function parseListeners(text = '') {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/);
    const port = Number((cols[3] ?? '').split(':').pop());
    if (!Number.isFinite(port) || port <= 0) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (!out.has(pid)) out.set(pid, []);
      if (!out.get(pid).includes(port)) out.get(pid).push(port);
    }
  }
  return out;
}

/** What a process is, from its command line. */
export function kindOf(cmd = '') {
  if (/llama-server/.test(cmd)) return 'llm';
  if (/\bmain\.py\b/.test(cmd) && /comfy/i.test(cmd)) return 'comfyui';
  return 'other';
}

/** "a ComfyUI on port 8191 (14.4 GB)" — what the person reads. */
export function describeHolder(h) {
  const gb = `${(h.mib / 1024).toFixed(1)} GB`;
  const port = h.ports?.length ? ` on port ${h.ports[0]}` : '';
  if (h.kind === 'comfyui') return `a ComfyUI${port} (${gb})`;
  if (h.kind === 'llm') return `a llama.cpp model${port} (${gb})`;
  const name = String(h.cmd ?? '').split(/\s+/)[0].split('/').pop() || 'a process';
  return `${name}, process ${h.pid}${port} (${gb})`;
}

/** Everything holding GPU memory: [{ pid, mib, cmd, kind, ports }]. */
export async function gpuHolders({ readCmdline = (pid) => readFileSync(`/proc/${pid}/cmdline`, 'utf8') } = {}) {
  if (process.platform !== 'linux') return [];
  const apps = parseComputeApps(await run('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits']));
  if (!apps.length) return [];
  const listeners = parseListeners(await run('ss', ['-ltnpH']));
  return apps.map((a) => {
    let cmd = '';
    try {
      cmd = readCmdline(a.pid).split('\0').join(' ').trim();
    } catch {
      /* gone, or not ours to read */
    }
    return { ...a, cmd, kind: kindOf(cmd), ports: listeners.get(a.pid) ?? [] };
  });
}

/**
 * Ask every idle ComfyUI on the card, other than the configured one (which
 * comfy.freeIfIdle handles), to unload. Returns { freed: [holder], busy: [holder] }.
 */
export async function freeOtherComfyUIs({ exceptPort, holders, fetchImpl = fetch } = {}) {
  const list = holders ?? (await gpuHolders());
  const freed = [];
  const busy = [];
  for (const h of list) {
    if (h.kind !== 'comfyui') continue;
    const port = h.ports.find((p) => p !== exceptPort);
    if (!port || h.ports.includes(exceptPort)) continue;
    const base = `http://127.0.0.1:${port}`;
    try {
      const q = await (await fetchImpl(`${base}/queue`, { signal: AbortSignal.timeout(1500) })).json();
      if (q?.queue_running?.length || q?.queue_pending?.length) {
        busy.push(h);
        continue;
      }
      await fetchImpl(`${base}/free`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(10_000),
      });
      freed.push(h);
    } catch {
      /* not a ComfyUI after all, or not answering: leave it alone */
    }
  }
  return { freed, busy };
}

/** A model load that failed for want of room, by the backend's own words. */
export const isLoadFailure = (text = '') =>
  /exited prematurely|failed to load model|out of memory|cudaMalloc failed|unable to allocate/i.test(String(text));

/**
 * The sentence to add to a failed load: what else holds the card. Null when
 * nothing but PromptForge's own models is there, or nothing can be seen.
 */
export async function explainLoadFailure(verbatim, { holders } = {}) {
  if (!isLoadFailure(verbatim)) return null;
  const list = (holders ?? (await gpuHolders())).filter((h) => h.kind !== 'llm' && h.mib >= 512);
  if (!list.length) return null;
  return `The model could not load because the GPU is held by ${list.map(describeHolder).join(', ')}. That is not this prompt's model: stop it, or wait for it to finish, and try again.`;
}
