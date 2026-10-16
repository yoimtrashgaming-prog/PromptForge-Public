// CPU, RAM and VRAM for the top bar.
//
// On a box five people share and one GPU everybody queues for, "is something
// already hammering it" is a question asked constantly and answered until now
// by sshing in and running nvidia-smi. The queue panel says who holds the
// GPU; this says what the machine is actually doing, including the half of it
// PromptForge does not own — ComfyUI shares this card.
//
// Rides the existing 10s /api/status poll rather than adding a second one.
// That cadence is why CPU is sampled as a delta between calls: a point-in-time
// reading of /proc/stat is cumulative-since-boot and says nothing useful.
//
// **Nothing here is load-bearing.** Every reading is optional and every path
// answers null rather than throwing — a status response must not fail because
// nvidia-smi is missing, and this runs on a machine where it might be.

import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

// nvidia-smi costs ~50ms of process spawn. Five people polling every 10s is 30
// calls a minute for a number that barely moves between them, so it is cached
// just long enough to collapse the crowd without going stale on screen.
const GPU_CACHE_MS = 5000;

/** Percent, one decimal, or null. Guards the divide-by-zero on first sample. */
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : null);

export function createSysmon(config = {}) {
  const smi = config.system?.nvidia_smi ?? 'nvidia-smi';
  const enabled = config.system?.enabled !== false;

  // The previous CPU sample. Busy time and total time across all cores; the
  // percentage is the ratio of their deltas.
  let prev = null;
  let gpuCache = { at: 0, value: null };

  function cpu() {
    let busy = 0;
    let total = 0;
    for (const core of os.cpus()) {
      const t = core.times;
      busy += t.user + t.nice + t.sys + t.irq;
      total += t.user + t.nice + t.sys + t.irq + t.idle;
    }
    const last = prev;
    prev = { busy, total };
    // The first call has nothing to compare against and must not report 0% —
    // that reads as "idle" when it means "not known yet".
    if (!last) return { percent: null, cores: os.cpus().length };
    const dTotal = total - last.total;
    const dBusy = busy - last.busy;
    return {
      percent: dTotal > 0 ? Math.max(0, Math.min(100, pct(dBusy, dTotal))) : null,
      cores: os.cpus().length,
    };
  }

  /**
   * RAM used and total, in bytes.
   *
   * `os.freemem()` is read from MemFree on Linux, which excludes the page
   * cache — so on a box that has read a 17GB model off disk it reports almost
   * nothing free and the bar sits at 95% while the machine is fine. MemAvailable
   * is the kernel's own estimate of what a new process could actually get, and
   * it is the number `free -h` calls "available". Read it when it is there,
   * fall back to os when it is not.
   */
  function memory() {
    const total = os.totalmem();
    try {
      const text = readFileSync('/proc/meminfo', 'utf8');
      const kb = (key) => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
        return m ? Number(m[1]) * 1024 : null;
      };
      const memTotal = kb('MemTotal') ?? total;
      const available = kb('MemAvailable');
      if (available != null) {
        return { used: memTotal - available, total: memTotal, percent: pct(memTotal - available, memTotal) };
      }
    } catch {
      // Not Linux, or /proc unreadable. os is always there.
    }
    const used = total - os.freemem();
    return { used, total, percent: pct(used, total) };
  }

  /** Every NVIDIA GPU, or null when nvidia-smi is absent or unhappy. */
  function gpu() {
    if (Date.now() - gpuCache.at < GPU_CACHE_MS) return Promise.resolve(gpuCache.value);
    return new Promise((resolve) => {
      execFile(
        smi,
        ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
         '--format=csv,noheader,nounits'],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // Cached as null so a box without a GPU is not spawning a missing
            // binary every five seconds forever.
            gpuCache = { at: Date.now(), value: null };
            return resolve(null);
          }
          const rows = String(stdout)
            .trim()
            .split('\n')
            .map((line) => line.split(',').map((s) => s.trim()))
            .filter((c) => c.length >= 6)
            .map(([index, name, util, used, total, temp]) => ({
              index: Number(index),
              name,
              utilization: Number(util),
              // nounits gives MiB. Converted here so every size in the payload
              // is bytes and the frontend has one formatter, not two.
              used: Number(used) * 1024 * 1024,
              total: Number(total) * 1024 * 1024,
              percent: pct(Number(used), Number(total)),
              // Genuinely useful on this box: the P40 is passively cooled and
              // throttles, so a slow generation and a hot card are the same
              // story.
              temperature: Number.isFinite(Number(temp)) ? Number(temp) : null,
            }))
            .filter((g) => Number.isFinite(g.total) && g.total > 0);
          gpuCache = { at: Date.now(), value: rows.length ? rows : null };
          resolve(gpuCache.value);
        }
      );
    });
  }

  /** The whole reading. Never throws. */
  async function read() {
    if (!enabled) return null;
    try {
      return { cpu: cpu(), memory: memory(), gpu: await gpu() };
    } catch (err) {
      console.warn(`[sysmon] ${err.message}`);
      return null;
    }
  }

  /**
   * What cards are in the box, for telling chat what it runs on: name, VRAM
   * and architecture. [] when nvidia-smi is absent. Asked separately from
   * gpu() and cached for ten minutes, because cards do not change between
   * polls and an older driver that rejects compute_cap must not take the top
   * bar's readings down with it.
   */
  function hardware() {
    if (Date.now() - hardwareCache.at < HARDWARE_CACHE_MS) return Promise.resolve(hardwareCache.value);
    const ask = (fields) => new Promise((resolve) => {
      execFile(smi, [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'],
        { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
    });
    return (async () => {
      const out = (await ask('name,memory.total,compute_cap')) ?? (await ask('name,memory.total'));
      const cards = String(out ?? '').trim().split('\n').map((line) => line.split(',').map((s) => s.trim()))
        .filter((c) => c.length >= 2 && c[0])
        .map(([name, mib, cap]) => ({
          name,
          vram_gb: Math.round(Number(mib) / 1024),
          compute: cap && /^\d+\.\d+$/.test(cap) ? cap : null,
          architecture: architectureOf(cap),
        }));
      hardwareCache = { at: Date.now(), value: cards };
      return cards;
    })();
  }
  let hardwareCache = { at: 0, value: [] };

  return { read, hardware };
}

const HARDWARE_CACHE_MS = 10 * 60 * 1000;

/**
 * NVIDIA architecture from compute capability. The card's own name is not
 * enough: nvidia-smi calls this box's V100 "Tesla PG500-216", which tells a
 * model nothing about FP16 or flash attention, and "Volta" does.
 */
export function architectureOf(cap) {
  const n = Number(cap);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 10) return 'Blackwell';
  if (n >= 9) return 'Hopper';
  if (n >= 8.9) return 'Ada Lovelace';
  if (n >= 8) return 'Ampere';
  if (n >= 7.5) return 'Turing';
  if (n >= 7) return 'Volta';
  if (n >= 6) return 'Pascal';
  if (n >= 5) return 'Maxwell';
  return 'Kepler or older';
}
