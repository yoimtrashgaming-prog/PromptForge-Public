/**
 * Failure-table conformance tests.
 *
 * The Linux spec's failure table ("Failure states — required, not optional")
 * is a CLAUDE.md non-negotiable: every row needs a defined response. Reading
 * the code and agreeing it looks right is how a row quietly stops working —
 * the model-loading row was broken in both halves and still read fine.
 *
 * So this stands up a fake backend that misbehaves on demand, points a real
 * server at it, and asserts what actually comes out of /api/status and the
 * /api/generate SSE stream.
 *
 * Needs no Ollama and no model. Run: npm run test-failures
 *
 * Rows covered here are the ones in scope for phases 1-2. SearXNG (phase 3),
 * the training backend (phase 6) and upload limits (needs the phase 3 upload
 * handler) are out of scope and deliberately absent.
 */
import { freePort } from './lib/freeport.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STUB_PORT = await freePort(11497);
const APP_PORT = await freePort(8097);
const MODEL = 'qwen3:8b';
// Nothing this suite writes belongs in the live data directory. It records no
// runs today — every case fails before the counter — but it drives the real
// server under a fixture name, and the next case added here should not have
// to know that. See server/paths.mjs.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pf-failures-data-'));

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

// ───────────────────────── the misbehaving backend ─────────────────────────

let mode = 'ok';
let loadingUntil = 0;

const stub = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.url.startsWith('/v1/models')) return send(200, { data: [{ id: MODEL }] });

  if (req.url.startsWith('/api/chat')) {
    req.resume();
    req.on('end', () => {
      if (mode === 'hang') return; // never answer; exercises the timeout
      if (mode === 'oom') {
        return send(500, { error: 'CUDA error: out of memory trying to allocate 2.00 GiB on device 0' });
      }
      if (mode === 'loading' || (mode === 'loading-then-ok' && Date.now() < loadingUntil)) {
        return send(503, { error: 'loading model into memory, please retry' });
      }
      // A well-formed illustrious answer: all three declared segments.
      const body =
        '===SEGMENT: Positive prompt===\n1girl, solo\n\n' +
        '===SEGMENT: Negative prompt===\nworst quality\n\n' +
        '===SEGMENT: Reasoning===\nBecause.\n';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: body }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
      res.end();
    });
    return;
  }
  send(404, { error: 'not found' });
});

// ───────────────────────────── helpers ─────────────────────────────

async function sse(payload, { timeoutMs = 30000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const events = [];
  for (const block of text.split(/\n\n/)) {
    const ev = /^event: (.+)$/m.exec(block);
    const da = /^data: (.+)$/m.exec(block);
    if (ev && da) {
      try {
        events.push({ event: ev[1], data: JSON.parse(da[1]) });
      } catch { /* keep-alive or partial frame */ }
    }
  }
  return events;
}

const status = () => fetch(`http://127.0.0.1:${APP_PORT}/api/status`).then((r) => r.json());
const errorOf = (events) => events.find((e) => e.event === 'error')?.data;

// ───────────────────────────── run ─────────────────────────────

stub.listen(STUB_PORT, '127.0.0.1');
await once(stub, 'listening');

const app = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_LLM_BACKEND: 'ollama',
    PROMPTFORGE_LLM_MODEL: MODEL,
    PROMPTFORGE_LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    // Predates accounts and is not about them: run the pre-auth header
    // user model rather than teaching every case to log in.
    PROMPTFORGE_AUTH: 'off',
    PROMPTFORGE_DATA_DIR: DATA_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
app.stdout.on('data', (d) => {
  if (/listening on/i.test(String(d))) booted = true;
});

for (let i = 0; i < 100 && !booted; i++) await new Promise((r) => setTimeout(r, 100));
if (!booted) {
  console.error('server did not start — did PROMPTFORGE_PORT take effect?');
  app.kill();
  stub.close();
  process.exit(1);
}

console.log('\nFailure-table conformance\n' + '─'.repeat(58));

try {
  // ── GPU OOM: the backend's own words must survive ──
  mode = 'oom';
  {
    const err = errorOf(await sse({ model: 'illustrious', brief: 'a cat', controls: {} }));
    check('GPU OOM reports gpu_oom', err?.code === 'gpu_oom', `got ${err?.code}`);
    check(
      'GPU OOM surfaces the backend text verbatim',
      typeof err?.verbatim === 'string' && /out of memory/i.test(err.verbatim),
      `verbatim was ${JSON.stringify(err?.verbatim)}`
    );
  }

  // ── Model loading: queues rather than fails ──
  mode = 'loading-then-ok';
  loadingUntil = Date.now() + 6000;
  {
    const events = await sse({ model: 'illustrious', brief: 'a cat', controls: {} }, { timeoutMs: 60000 });
    const waited = events.some((e) => e.event === 'status' && e.data.state === 'model_loading');
    const done = events.find((e) => e.event === 'done');
    check('a loading model emits a model_loading status rather than an error', waited);
    check('a loading model eventually completes instead of failing', Boolean(done),
      `error was ${JSON.stringify(errorOf(events))}`);
    check('no error event once the model finishes loading', !errorOf(events));
  }

  // ── Generation timeout ──
  // Off by default: the only way to observe it is to actually wait out
  // llm.timeout_ms, which is 120s. Skipping it silently is the exact failure
  // this suite exists to prevent, so it announces itself either way.
  if (process.argv.includes('--slow')) {
    mode = 'hang';
    const started = Date.now();
    const err = errorOf(await sse({ model: 'illustrious', brief: 'a cat', controls: {} }, { timeoutMs: 200000 }));
    const elapsed = Date.now() - started;
    check('a hanging backend times out rather than hanging forever', err?.code === 'timeout', `got ${err?.code}`);
    check('the timeout message names the limit', /\d+ ?ms/.test(err?.message ?? ''), err?.message);
    check('the timeout waited roughly the configured budget',
      elapsed > 100000 && elapsed < 160000, `waited ${Math.round(elapsed / 1000)}s`);
  } else {
    console.log('  SKIP  generation timeout — run with --slow (takes ~2 minutes)');
  }

  // ── Backend unreachable: /api/status must say so ──
  await new Promise((r) => stub.close(r));
  {
    const s = await status();
    check('unreachable backend reports ok:false', s.llm?.ok === false, JSON.stringify(s.llm));
    check('unreachable backend reports backend_unavailable',
      s.llm?.code === 'backend_unavailable', `got ${s.llm?.code}`);
    check('unreachable backend names Ollama in the detail',
      /ollama/i.test(s.llm?.detail ?? ''), `detail was ${s.llm?.detail}`);

    const err = errorOf(await sse({ model: 'illustrious', brief: 'a cat', controls: {} }));
    check('generating against an unreachable backend errors cleanly',
      err?.code === 'backend_unavailable', `got ${err?.code}`);
    check('the error carries a partial field so the panel can keep output',
      err && 'partial' in err);
  }
} finally {
  app.kill();
  try { stub.close(); } catch { /* already closed */ }
  rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log('─'.repeat(58));
console.log(fail ? `${pass} passed, ${fail} FAILED\n` : `ALL PASSED (${pass})\n`);
process.exit(fail ? 1 : 0);
