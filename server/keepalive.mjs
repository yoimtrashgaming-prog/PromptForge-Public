// How long a model stays in VRAM after a request, as a runtime setting.
//
// `llm.keep_alive` in config/server.yaml is the default. This module parses
// what a person typed or picked, and remembers the choice across restarts so
// that setting it is not undone by the next `npm start`.
//
// Stored in data/runtime.json rather than written back into the YAML: config
// files here carry a great deal of reasoning in comments, and a machine that
// rewrites them loses it. The file holds only what a human changed through the
// UI, and its absence means "use the configured default".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Ollama's own vocabulary: a duration string, "0" to drop it immediately, or
// "-1" to keep it forever. Everything below normalises to one of those.
export const KEEP_ALIVE_PRESETS = [
  // "Single generation" is 0: Ollama unloads as soon as the request that
  // loaded it finishes. Named for what it does rather than for the number,
  // because "0 minutes" reads like a mistake.
  { value: '0', label: 'Single generation' },
  { value: '1m', label: '1 minute' },
  { value: '3m', label: '3 minutes' },
  { value: '5m', label: '5 minutes' },
  { value: '10m', label: '10 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '-1', label: 'Never unload' },
];

/**
 * The value Ollama actually accepts on the wire.
 *
 * Ollama reads keep_alive as a Go duration when it is a string and as seconds
 * when it is a number. Go's duration parser rejects "-1" outright — every
 * request comes back HTTP 400 with `time: missing unit in duration "-1"` — so
 * "never unload" has to go out as the number -1, which is what Ollama's own
 * documentation says to send. "0" parses either way and goes out as a number
 * too, so the two special values travel the same road. Everything else is a
 * real duration string and is passed through untouched.
 *
 * Separate from the stored value on purpose: config/server.yaml, runtime.json
 * and the UI all go on saying "-1", because that is the vocabulary the presets,
 * the config comments and Ollama's docs are written in. Only the wire differs.
 */
export function keepAliveWireValue(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw === '-1') return -1;
  if (raw === '0') return 0;
  return raw;
}

/**
 * Turn what arrived into something Ollama accepts, or explain why not.
 *
 * Accepts what a person is likely to type as much as what the dropdown sends:
 * `5`, `5m`, `5 min`, `5 minutes`, `2h`, `90s`, `0`, `-1`. A bare number means
 * **minutes**, because that is the unit every preset is in and the unit anyone
 * typing into this box is thinking in.
 *
 * Returns { ok, value, label } or { ok: false, message }.
 */
export function parseKeepAlive(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return { ok: false, message: 'Say how long, or pick one of the presets.' };

  if (raw === '-1' || raw === 'never') {
    return { ok: true, value: '-1', label: 'Never unload' };
  }
  if (raw === '0' || raw === '0m' || raw === '0s') {
    return { ok: true, value: '0', label: 'Single generation' };
  }

  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/.exec(raw);
  if (!m) {
    return {
      ok: false,
      message: 'Expected a number of minutes, or something like 30s, 5m, 2h, 0, or -1.',
    };
  }

  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'That has to be a positive number.' };
  }

  const unit = (m[2] ?? 'm')[0];   // bare number means minutes
  // A ceiling on each unit, so a typo like 999999 does not become a setting
  // nobody notices until the card has been held for a year.
  const limits = { s: 86400, m: 1440, h: 24 };
  if (amount > limits[unit]) {
    return { ok: false, message: `That is longer than this accepts. Use -1 if you never want it unloaded.` };
  }

  const words = { s: 'second', m: 'minute', h: 'hour' };
  const rounded = Number.isInteger(amount) ? String(amount) : String(amount);
  return {
    ok: true,
    value: `${rounded}${unit}`,
    label: `${rounded} ${words[unit]}${amount === 1 ? '' : 's'}`,
  };
}

/**
 * How many seconds a keep_alive value holds a model for. -1 is forever
 * (Infinity), 0 is none, a duration is its length, and anything unreadable
 * is null — which the idle clock below treats as "no timer", never as zero.
 */
export function keepAliveSeconds(value) {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === '-1') return Infinity;
  if (raw === '0') return 0;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(raw);
  if (!m) {
    const parsed = parseKeepAlive(raw);
    return parsed.ok ? keepAliveSeconds(parsed.value) : null;
  }
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

/**
 * Unload the GPU after it has sat idle for the keep_alive time — on
 * llama-swap, where PromptForge has to do this itself.
 *
 * Ollama honours keep_alive on every request. llama-swap has no such field:
 * its only timer is a per-model `ttl` in its config file, which cannot be
 * changed at runtime and whose remaining time it does not report. So from
 * 11 Sep 2026 the keep_alive setting drives this clock instead, llama-swap's
 * ttl stays 0, and PromptForge unloads through llama-swap's unload route.
 * The owner's reason, in his words: "im not trying to have a gpu spun up
 * 24/7 it will eat my power cost thats the whole purpose of the offload".
 *
 * The clock restarts whenever a job enters or leaves the inference queue
 * (`touch`), which every generation, chat and reference read goes through.
 * It never unloads while the queue has work, and it unloads once per idle
 * stretch rather than on every tick. A failed unload is retried on the next
 * tick.
 *
 * The queue is not the only thing using llama-swap. The Forge panel in
 * ComfyUI calls it directly, and so does a test server on the same box, and
 * the queue sees neither. Found 3 Oct 2026: the clock ran out ten minutes
 * after a restart and unloaded a model another server was halfway through
 * loading, which failed that request with a 500. So `snapshot`, when given,
 * reads what llama-swap has running on every tick: a model that has started
 * loading or newly come up counts as activity, and nothing is unloaded while
 * any model is still starting. A long outside job on a model that was already
 * loaded is still invisible from here.
 *
 * `now` and `log` are injectable so the suite can drive it with a fake clock.
 */
export function createIdleOffload({ getKeepAlive, isBusy, unloadAll, snapshot = null, now = () => Date.now(), log = console.log }) {
  let lastActivity = now();
  let armed = true;
  let seen = new Set();

  /** True when llama-swap shows a load or a model this clock has not seen yet. */
  async function outsideActivity() {
    const running = snapshot ? await snapshot().catch(() => null) : null;
    if (!running) return false;
    const live = running.filter((m) => m.state === 'starting' || m.state === 'ready');
    const current = new Set(live.map((m) => `${m.model}|${m.state}`));
    const fresh = [...current].some((key) => !seen.has(key));
    seen = current;
    return fresh || live.some((m) => m.state === 'starting');
  }

  /** Seconds until the unload, or null when nothing is scheduled (never, unset). */
  function secondsLeft() {
    const hold = keepAliveSeconds(getKeepAlive());
    if (hold == null || hold === Infinity) return null;
    return Math.max(0, hold - (now() - lastActivity) / 1000);
  }

  return {
    touch() {
      lastActivity = now();
      armed = true;
    },
    secondsLeft,
    async tick() {
      if (await outsideActivity()) {
        lastActivity = now();
        armed = true;
        return null;
      }
      if (!armed || isBusy()) return null;
      const left = secondsLeft();
      if (left == null || left > 0) return null;
      armed = false;
      const result = await unloadAll();
      if (result?.unloaded?.length) {
        log(`[offload] idle for ${keepAliveLabel(getKeepAlive())} - unloaded ${result.unloaded.join(', ')}`);
      }
      if (result && result.ok === false) {
        armed = true;
        log(`[offload] idle unload failed, retrying: ${JSON.stringify(result.failed ?? result.detail)}`);
      }
      return result;
    },
  };
}

/** The label a stored value reads as, for the UI and the boot log. */
export function keepAliveLabel(value) {
  const preset = KEEP_ALIVE_PRESETS.find((p) => p.value === String(value));
  if (preset) return preset.label;
  const parsed = parseKeepAlive(value);
  return parsed.ok ? parsed.label : String(value ?? 'unset');
}

/**
 * The runtime store. One small JSON file, and every read falls back to the
 * configured default, so deleting it is a clean way back to config.
 */
export function createRuntimeSettings(rootDir, config) {
  const dir = path.resolve(rootDir, config.paths?.data ?? 'data');
  const file = path.join(dir, 'runtime.json');

  function read() {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf8')) ?? {};
    } catch {
      // A corrupt runtime file must not stop the server booting. The
      // configured defaults are always a working answer.
      console.warn('[runtime] data/runtime.json is unreadable — using configured defaults');
      return {};
    }
  }

  function write(patch) {
    mkdirSync(dir, { recursive: true });
    const merged = { ...read(), ...patch, updated_at: new Date().toISOString() };
    writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  return {
    file,
    /** The stored keep_alive, or the configured one when nothing was ever set. */
    keepAlive: () => read().keep_alive ?? config.llm?.keep_alive ?? null,
    setKeepAlive: (value) => write({ keep_alive: value }).keep_alive,
    /** Whether the value in force came from the UI rather than the config file. */
    isOverridden: () => read().keep_alive != null,
  };
}
