// The VRAM controls: how long a model stays loaded, and dropping it now.
//
//   node scripts/test-keepalive.mjs
//
// The parser and the runtime store are exercised directly. The routes run
// against a real server pointed at an Ollama-shaped stub, so "unload" can be
// observed as a request the backend actually received rather than assumed
// from a 200.
//
// Needs no Ollama, no GPU and no network.

import { freePort } from './lib/freeport.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseKeepAlive,
  keepAliveLabel,
  keepAliveWireValue,
  createRuntimeSettings,
  KEEP_ALIVE_PRESETS,
  keepAliveSeconds,
  createIdleOffload,
} from '../server/keepalive.mjs';
import { createQueue } from '../server/queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = await freePort(11499);
const APP_PORT = await freePort(8093);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const OWNER = 'owner';
const MODEL = 'qwen3:8b';

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

// ── the parser ───────────────────────────────────────────────
{
  // A bare number means minutes. Every preset is in minutes and it is the unit
  // anyone typing into the box is thinking in.
  check('a bare number is minutes', parseKeepAlive('5').value === '5m', parseKeepAlive('5').value);
  check('...and reads back in words', parseKeepAlive('5').label === '5 minutes');
  check('units are kept when given', parseKeepAlive('90s').value === '90s');
  check('hours too', parseKeepAlive('2h').value === '2h');
  check('and spelled-out units work', parseKeepAlive('1 minute').value === '1m');

  // The two special values in Ollama's vocabulary, named for what they do
  // rather than for the number - "0 minutes" reads like a mistake.
  check('0 is a single generation', parseKeepAlive('0').label === 'Single generation');
  check('-1 never unloads', parseKeepAlive('-1').label === 'Never unload');
  check('...and so does the word', parseKeepAlive('never').value === '-1');

  check('nothing typed is refused', parseKeepAlive('').ok === false);
  check('nonsense is refused', parseKeepAlive('abc').ok === false);
  check('...with a message naming what to type instead',
    /30s, 5m, 2h/.test(parseKeepAlive('abc').message), parseKeepAlive('abc').message);
  check('a negative that is not -1 is refused', parseKeepAlive('-5').ok === false);
  // A typo like 999999 should not become a setting nobody notices until the
  // card has been held for a year.
  check('an absurd duration is refused', parseKeepAlive('9999').ok === false);
  check('...and points at -1 instead', /-1/.test(parseKeepAlive('9999').message));

  // What goes on the wire. Ollama's duration parser rejects the string "-1"
  // — 400, `time: missing unit in duration "-1"` — and every request in the
  // app failed for a day because of it. The stored value stays a string; only
  // the two special values change shape on the way out.
  check('-1 goes out as a number', keepAliveWireValue('-1') === -1,
    JSON.stringify(keepAliveWireValue('-1')));
  check('0 goes out as a number', keepAliveWireValue('0') === 0,
    JSON.stringify(keepAliveWireValue('0')));
  check('a duration goes out untouched', keepAliveWireValue('15m') === '15m');
  check('unset stays unset', keepAliveWireValue(null) === null);
  check('...and a number set in config survives', keepAliveWireValue(-1) === -1);

  check('every preset parses', KEEP_ALIVE_PRESETS.every((p) => parseKeepAlive(p.value).ok));
  check('...and each preset label matches what the parser calls it',
    KEEP_ALIVE_PRESETS.every((p) => keepAliveLabel(p.value) === p.label));
}

// ── the idle unload on llama-swap ────────────────────────────
//
// llama-swap has no keep_alive and does not report a time left, so from
// 11 Sep 2026 PromptForge keeps the clock and does the unloading. Driven with
// a fake clock: seconds here are exact, not "about".
{
  check('5m holds for 300s', keepAliveSeconds('5m') === 300, String(keepAliveSeconds('5m')));
  check('a bare number is minutes here too', keepAliveSeconds('15') === 900);
  check('-1 holds forever', keepAliveSeconds('-1') === Infinity);
  check('0 holds for nothing', keepAliveSeconds('0') === 0);
  check('unset is no timer, not zero', keepAliveSeconds(null) === null);

  let t = 0;
  let busy = false;
  let keep = '5m';
  const unloads = [];
  const idle = createIdleOffload({
    getKeepAlive: () => keep,
    isBusy: () => busy,
    unloadAll: async () => {
      unloads.push(t);
      return { ok: true, unloaded: ['m'], failed: [] };
    },
    now: () => t,
    log: () => {},
  });

  check('the clock starts full', idle.secondsLeft() === 300, String(idle.secondsLeft()));
  t = 120_000;
  check('...and counts down', idle.secondsLeft() === 180, String(idle.secondsLeft()));
  await idle.tick();
  check('nothing unloads before time', unloads.length === 0);

  t = 300_000;
  busy = true;
  await idle.tick();
  check('nothing unloads while a job is running or queued', unloads.length === 0);

  busy = false;
  idle.touch();
  await idle.tick();
  check('a job finishing restarts the clock', unloads.length === 0 && idle.secondsLeft() === 300);

  t = 600_000;
  await idle.tick();
  check('idle past the keep-alive unloads', unloads.length === 1);
  t = 700_000;
  await idle.tick();
  check('...once per idle stretch, not every tick', unloads.length === 1);

  keep = '-1';
  idle.touch();
  t = 10_000_000;
  await idle.tick();
  check('"Never unload" never unloads and shows no countdown',
    unloads.length === 1 && idle.secondsLeft() === null);

  keep = '0';
  idle.touch();
  await idle.tick();
  check('"Single generation" unloads as soon as the queue is empty', unloads.length === 2);

  keep = '15m';
  idle.touch();
  check('changing the setting changes the countdown at once', idle.secondsLeft() === 900);

  // A failed unload must not leave the card held for good.
  let fail = true;
  let t2 = 0;
  const attempts = [];
  const retry = createIdleOffload({
    getKeepAlive: () => '1m',
    isBusy: () => false,
    unloadAll: async () => {
      attempts.push(t2);
      return fail
        ? { ok: false, unloaded: [], failed: [{ model: 'm', detail: 'boom' }] }
        : { ok: true, unloaded: ['m'], failed: [] };
    },
    now: () => t2,
    log: () => {},
  });
  t2 = 61_000;
  await retry.tick();
  fail = false;
  await retry.tick();
  check('a failed unload is retried on the next tick', attempts.length === 2, String(attempts.length));

  // Work outside the queue: Forge or another server loading a model through
  // llama-swap directly. Found 3 Oct 2026 as a 500 on a load the clock killed.
  let t3 = 0;
  let running = [];
  const outsideUnloads = [];
  const outside = createIdleOffload({
    getKeepAlive: () => '10m',
    isBusy: () => false,
    unloadAll: async () => { outsideUnloads.push(t3); return { ok: true, unloaded: ['m'], failed: [] }; },
    snapshot: async () => running,
    now: () => t3,
    log: () => {},
  });
  await outside.tick();
  t3 = 600_000;
  running = [{ model: 'm', state: 'starting' }];
  await outside.tick();
  check('a model still loading is never unloaded', outsideUnloads.length === 0 && outside.secondsLeft() === 600);
  t3 = 660_000;
  running = [{ model: 'm', state: 'ready' }];
  await outside.tick();
  check('a model coming up from outside restarts the clock', outsideUnloads.length === 0 && outside.secondsLeft() === 600);
  t3 = 1_260_000;
  await outside.tick();
  check('...and it still unloads once that stretch is idle', outsideUnloads.length === 1);
  running = [];
  t3 = 1_300_000;
  await outside.tick();
  check('a model going away is not activity', outsideUnloads.length === 1 && outside.secondsLeft() === 0);
  let t4 = 0;
  const unread = createIdleOffload({
    getKeepAlive: () => '1m', isBusy: () => false, snapshot: async () => null,
    unloadAll: async () => { outsideUnloads.push('unread'); return { ok: true, unloaded: [], failed: [] }; },
    now: () => t4, log: () => {},
  });
  t4 = 61_000;
  await unread.tick();
  check('llama-swap unreadable falls back to the queue clock', outsideUnloads.includes('unread'));

  // The queue is what restarts the clock, so it has to report both ends of a job.
  let pings = 0;
  const q = createQueue({ onActivity: () => { pings += 1; } });
  const ticket = q.enqueue({ user: 'x' });
  await ticket.started;
  ticket.release();
  check('the queue reports a job arriving and leaving', pings === 2, String(pings));
}

// ── the runtime store ────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-runtime-'));
  const config = { paths: { data: dir }, llm: { keep_alive: '15m' } };
  const store = createRuntimeSettings(ROOT, config);

  check('with nothing stored, the configured default is in force', store.keepAlive() === '15m');
  check('...and that is reported as not overridden', store.isOverridden() === false);

  store.setKeepAlive('3m');
  check('a stored value wins', store.keepAlive() === '3m');
  check('...and says so', store.isOverridden() === true);

  // The whole reason it is a file: setting this must survive npm start.
  const reopened = createRuntimeSettings(ROOT, config);
  check('and survives a restart', reopened.keepAlive() === '3m', reopened.keepAlive());

  check('the file is where it says it is', existsSync(reopened.file));
  const raw = JSON.parse(readFileSync(reopened.file, 'utf8'));
  check('...holding only what a human changed', raw.keep_alive === '3m' && Boolean(raw.updated_at),
    JSON.stringify(raw));

  rmSync(dir, { recursive: true, force: true });
}

// ── an Ollama-shaped backend that records what it was asked ──
const seen = { unloads: [], keepAlives: [], warmups: [] };
const stub = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/v1/models')) return send(200, { data: [{ id: MODEL }] });
  if (req.url.startsWith('/api/tags')) return send(200, { models: [{ name: MODEL, size: 5e9 }] });
  if (req.url.startsWith('/api/ps')) {
    return send(200, { models: [{ name: MODEL, size: 5e9, size_vram: 5e9 }] });
  }
  if (req.url.startsWith('/api/generate')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      // keep_alive 0 with no prompt IS the unload, so this is the only place
      // the server's intent is observable.
      if (parsed.keep_alive === 0) seen.unloads.push(parsed.model);
      send(200, { model: parsed.model, done: true });
    });
    return;
  }
  if (req.url.startsWith('/api/chat')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const chat = JSON.parse(body || '{}');
      seen.keepAlives.push(chat.keep_alive);
      // An empty messages array is the warmup shape - ollama loads the model
      // and returns without generating. Recorded separately so a test can ask
      // which model the Warm up button actually reached for.
      if (Array.isArray(chat.messages) && chat.messages.length === 0) {
        seen.warmups.push({ model: chat.model, num_ctx: chat.options?.num_ctx ?? null });
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'ok' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
    });
    return;
  }
  send(404, { error: 'not found' });
});

stub.listen(STUB_PORT, '127.0.0.1');
await once(stub, 'listening');

const usersDir = mkdtempSync(path.join(tmpdir(), 'pf-ka-users-'));
const dataDir = mkdtempSync(path.join(tmpdir(), 'pf-ka-data-'));

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_AUTH: 'off',
    PROMPTFORGE_LLM_BACKEND: 'ollama',
    PROMPTFORGE_LLM_MODEL: MODEL,
    // h3's pin is per machine since 20 Sep 2026 (llm.model_defaults), so the
    // test supplies one rather than relying on the shared registry.
    PROMPTFORGE_MODEL_DEFAULTS: 'h3=pinned-h3-model',
    PROMPTFORGE_LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    PROMPTFORGE_USERS_DIR: usersDir,
    PROMPTFORGE_DATA_DIR: dataDir,
    PROMPTFORGE_SEARCH: 'off',
  },
  stdio: 'ignore',
});

const as = (user, init = {}) => ({
  ...init,
  headers: { 'content-type': 'application/json', 'x-promptforge-user': user, ...(init.headers ?? {}) },
});

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error(`server did not start on ${APP_PORT}`);

  // ── the gate ──
  const nosy = await fetch(`${BASE}/api/admin/models/unload`,
    as('someone-else', { method: 'POST', body: JSON.stringify({ model: MODEL }) }));
  check('offload is closed to everyone but the owner', nosy.status === 403, String(nosy.status));
  const nosyKa = await fetch(`${BASE}/api/admin/models/keep-alive`,
    as('someone-else', { method: 'POST', body: JSON.stringify({ value: '5m' }) }));
  check('...and so is the unload timer', nosyKa.status === 403, String(nosyKa.status));

  // ── offload one ──
  const one = await fetch(`${BASE}/api/admin/models/unload`,
    as(OWNER, { method: 'POST', body: JSON.stringify({ model: MODEL }) }));
  check('the owner can offload a model', one.status === 200, String(one.status));
  check('...and the backend was actually asked to drop it',
    seen.unloads.includes(MODEL), JSON.stringify(seen.unloads));

  const nameless = await fetch(`${BASE}/api/admin/models/unload`,
    as(OWNER, { method: 'POST', body: JSON.stringify({}) }));
  check('offloading nothing in particular is refused', nameless.status === 400);

  // ── offload all ──
  seen.unloads.length = 0;
  const all = await fetch(`${BASE}/api/admin/models/unload`,
    as(OWNER, { method: 'POST', body: JSON.stringify({ all: true }) }));
  const allBody = await all.json();
  check('offload all works off what is resident', allBody.unloaded?.includes(MODEL),
    JSON.stringify(allBody));

  // ── the timer ──
  const set = await fetch(`${BASE}/api/admin/models/keep-alive`,
    as(OWNER, { method: 'POST', body: JSON.stringify({ value: '3' }) }));
  const setBody = await set.json();
  check('a bare number sets minutes', setBody.value === '3m', JSON.stringify(setBody));

  const status = await fetch(`${BASE}/api/status`, as(OWNER)).then((r) => r.json());
  check('status serves the value in force', status.keep_alive?.value === '3m',
    JSON.stringify(status.keep_alive));
  check('...and says it was set here rather than configured',
    status.keep_alive?.overridden === true);
  check('...and carries the presets the control is built from',
    (status.keep_alive?.presets ?? []).length === KEEP_ALIVE_PRESETS.length);

  // The point of all of it: the next request actually carries the new value.
  seen.keepAlives.length = 0;
  const turn = await fetch(`${BASE}/api/chat`,
    as(OWNER, { method: 'POST', body: JSON.stringify({ message: 'hi' }) }));
  await turn.text();
  check('and the next request to the backend carries it',
    seen.keepAlives.includes('3m'), JSON.stringify(seen.keepAlives));

  // ── warm up loads the model that is actually selected ──
  //
  // The button used to call warmup() bare, which loaded llm.model - the
  // deployment default - whichever model the picker was on. On a box whose
  // default is a 9B and whose picker is usually a 27B, that warmed the wrong
  // weights and took VRAM from the right ones, while reporting success.
  {
    seen.warmups.length = 0;
    const plain = await fetch(`${BASE}/api/warmup`, as(OWNER, { method: 'POST', body: '{}' }));
    check('warm up with no model named still works', plain.status === 200, String(plain.status));
    check('...and falls back to the configured default',
      seen.warmups.at(-1)?.model === MODEL, JSON.stringify(seen.warmups.at(-1)));

    // h3 declares its own LLM and its own context, both on measured grounds.
    seen.warmups.length = 0;
    const h3 = await fetch(`${BASE}/api/warmup`,
      as(OWNER, { method: 'POST', body: JSON.stringify({ model: 'h3' }) }));
    const warmed = seen.warmups.at(-1);
    check('naming a model warms what that model actually uses', h3.status === 200, String(h3.status));
    check('...which is what llm.model_defaults asks for, not the deployment default',
      warmed?.model === 'pinned-h3-model', JSON.stringify(warmed));
    // num_ctx is set at load time, so warming at the wrong one means ollama
    // reloads on the first real request and the warm bought nothing.
    check('...and at the context length that model loads with',
      warmed?.num_ctx === 16384, JSON.stringify(warmed));
  }

  const bad = await fetch(`${BASE}/api/admin/models/keep-alive`,
    as(OWNER, { method: 'POST', body: JSON.stringify({ value: 'soon' }) }));
  check('nonsense is refused with a message', bad.status === 400, String(bad.status));
  const after = await fetch(`${BASE}/api/status`, as(OWNER)).then((r) => r.json());
  check('...and leaves the previous value alone', after.keep_alive?.value === '3m',
    JSON.stringify(after.keep_alive));

  // "Never unload" end to end. This is the one that broke: the preset stores
  // the string "-1", and Ollama 400s on it unless it leaves as a number.
  const never = await fetch(`${BASE}/api/admin/models/keep-alive`,
    as(OWNER, { method: 'POST', body: JSON.stringify({ value: '-1' }) }));
  check('never-unload is accepted', never.status === 200, String(never.status));
  const neverStatus = await fetch(`${BASE}/api/status`, as(OWNER)).then((r) => r.json());
  check('...and is still spelled "-1" everywhere a human reads it',
    neverStatus.keep_alive?.value === '-1', JSON.stringify(neverStatus.keep_alive));

  seen.keepAlives.length = 0;
  const pinned = await fetch(`${BASE}/api/chat`,
    as(OWNER, { method: 'POST', body: JSON.stringify({ message: 'hi' }) }));
  await pinned.text();
  check('...but reaches Ollama as the number -1, which is the only form it takes',
    seen.keepAlives.some((v) => v === -1 && typeof v === 'number'),
    JSON.stringify(seen.keepAlives));
} catch (err) {
  failures.push(`suite threw — ${err.message}`);
} finally {
  app.kill();
  stub.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('\nVRAM controls: offload and the unload timer\n');
for (const f of failures) console.log(`  FAIL  ${f}`);
if (failures.length) {
  console.log(`\n${failures.length} of ${passed + failures.length} FAILED\n`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})\n`);
