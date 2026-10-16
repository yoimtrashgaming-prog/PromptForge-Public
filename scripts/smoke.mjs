// Phase 1 smoke test. Exercises the endpoints against whatever backend is
// configured — with llm.backend "mock" it needs nothing installed.
//
//   node scripts/smoke.mjs [baseUrl]

const BASE = process.argv[2] ?? 'http://127.0.0.1:8090';

// ── signing in ──
//
// Unlike the other suites, smoke runs against whatever server is already up
// rather than spawning its own — that is the point of it, it tests the real
// configured backend. Now that the app is behind login it has to sign in the
// way a browser does. Credentials come from the environment so no password
// lands in the repo:
//
//   PROMPTFORGE_SMOKE_USER=owner PROMPTFORGE_SMOKE_PASSWORD=... npm run smoke
//
// A server running with auth disabled needs neither.
let sessionCookie = null;
const rawFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  if (!sessionCookie) return rawFetch(url, init);
  const headers = new Headers(init.headers ?? {});
  headers.set('cookie', sessionCookie);
  return rawFetch(url, { ...init, headers });
};

async function signIn() {
  let me;
  try {
    me = await rawFetch(`${BASE}/api/auth/me`).then((r) => r.json());
  } catch {
    console.error(`\nFATAL: nothing answering at ${BASE}.`);
    console.error('smoke tests a running server — start one with `npm start` first.\n');
    process.exit(1);
  }
  if (!me.auth_enabled) return 'auth disabled on this server';

  const username = process.env.PROMPTFORGE_SMOKE_USER;
  const password = process.env.PROMPTFORGE_SMOKE_PASSWORD;
  if (!username || !password) {
    console.error('\nFATAL: this server has accounts enabled, so smoke needs to sign in.\n');
    console.error('  PROMPTFORGE_SMOKE_USER=<owner> PROMPTFORGE_SMOKE_PASSWORD=<password> npm run smoke\n');
    console.error('Or run a throwaway server without accounts:\n');
    console.error('  PROMPTFORGE_AUTH=off PROMPTFORGE_PORT=8099 npm start\n');
    process.exit(1);
  }

  const res = await rawFetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`\nFATAL: could not sign in as ${username} — ${res.status} ${body.message ?? ''}\n`);
    process.exit(1);
  }
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    if (pair.startsWith('pf_session=')) sessionCookie = pair;
  }
  if (!sessionCookie) {
    console.error('\nFATAL: login succeeded but returned no session cookie\n');
    process.exit(1);
  }
  return `signed in as ${username}`;
}

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

async function sse(body) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { httpError: res.status, json: await res.json().catch(() => null), events: [] };
  }

  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame);
      const da = /^data: (.+)$/m.exec(frame);
      if (ev && da) events.push({ event: ev[1], data: JSON.parse(da[1]) });
    }
  }
  return { events };
}

console.log(`\nPromptForge smoke test — ${BASE}`);
console.log(`${await signIn()}\n`);

// ── health & status ──
console.log('health / status / models');
const health = await fetch(`${BASE}/health`).then((r) => r.json());
ok(health.ok === true, 'GET /health');

const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
ok(typeof status.queue?.concurrency === 'number', 'GET /api/status reports queue');
ok(status.prompts?.shared_prefix_loaded === true, 'house rules are loaded');

const reg = await fetch(`${BASE}/api/models`).then((r) => r.json());
// Whatever this install has: the registry is config, and models come and go
// (ten until 30 Sep 2026, six since). Read from it, never counted here.
ok(reg.models?.length > 0 && new Set(reg.models.map((m) => m.key)).size === reg.models.length,
  'GET /api/models returns models, each key once', `got ${reg.models?.length}`);
ok(
  reg.models.every((m) => Array.isArray(m.segments) && m.segments.length),
  'every model declares its segment contract'
);
ok(
  !reg.models.some((m) => m.system_prompt),
  'server-side prompt paths are not leaked to the frontend'
);

// ── the models must not produce identical output ──
console.log('\ngeneration (the one job: per-model dialects must differ)');
const brief =
  'Fern from Frieren as a steampunk mechanic, covered in grease with goggles on her head';

const results = {};
for (const key of reg.models.map((m) => m.key)) {
  const { events } = await sse({
    model: key,
    brief,
    controls: { creativity: 'balanced' },
  });
  const done = events.find((e) => e.event === 'done');
  const error = events.find((e) => e.event === 'error');
  if (error) {
    ok(false, `${key} generated`, `${error.data.code}: ${error.data.message}`);
    continue;
  }
  const labels = done?.data.segments.map((s) => s.label) ?? [];
  // The optional segments (meta ones like Reasoning, and the negatives) are
  // off unless an account turns them on (optional_segments_default, see
  // optionalSegments in server/segments.mjs), so the check is: every required
  // segment, nothing outside the contract, in contract order.
  const entry = reg.models.find((m) => m.key === key);
  const contract = entry.segments;
  const optional = new Set([...(entry.meta_segments ?? []),
    ...(entry.has_negative === false ? [] : contract.filter((l) => /negative/i.test(l)))]);
  const required = contract.filter((l) => !optional.has(l));
  const inOrder = labels.every((l, i) => i === 0 || contract.indexOf(l) > contract.indexOf(labels[i - 1]));
  ok(
    required.every((l) => labels.includes(l)) && labels.every((l) => contract.includes(l)) && inOrder,
    `${key.padEnd(12)} segments match contract`,
    labels.join(' | ')
  );
  // Labels with the text: two models with the same words under different
  // segment names are still two dialects.
  results[key] = done?.data.segments.map((s) => `${s.label}\n${s.body}`).join('\n') ?? '';
}

const keys = Object.keys(results);
const same = keys.flatMap((a, i) => keys.slice(i + 1).filter((b) => results[a] === results[b]).map((b) => `${a} = ${b}`));
ok(
  keys.length === reg.models.length && !same.length,
  `all ${reg.models.length} models produced different outputs`,
  same.join(', ')
);
// Dialect assertions live in scripts/dialect-check.mjs, which tests what each
// prompt file actually asks for. Keeping them out of here means smoke stays a
// transport-and-contract check that any backend should pass.

const videoSegs = reg.models.filter((m) => m.type === 'video').map((m) => JSON.stringify(m.segments));
ok(new Set(videoSegs).size === videoSegs.length, `the ${videoSegs.length} video models have different segment shapes`);

// ── the Refused path ──
// __mock_refuse is a harness affordance of the mock backend, not a product
// feature — a real backend refuses because the content rules in
// house-rules.md fired, which is not something to provoke in a smoke test.
// So this block exercises the parser contract only where it can.
console.log('\nrefusal contract');
if (status.llm?.backend === 'mock') {
  const refused = await sse({ model: reg.models[0].key, brief: 'test', __mock_refuse: true });
  const rdone = refused.events.find((e) => e.event === 'done');
  const rerror = refused.events.find((e) => e.event === 'error');
  ok(!rerror, 'a Refused segment does not surface as a parse error', rerror?.data?.code ?? '');
  ok(rdone?.data.refused === true, 'done event carries refused: true');
  ok(
    rdone?.data.segments?.[0]?.label === 'Refused',
    'the Refused segment is the only segment returned'
  );
} else {
  console.log(`  SKIP  refusal path — mock-only harness flag (backend is "${status.llm?.backend}")`);
  console.log('        parser-level coverage lives in scripts/test-segments.mjs');
}

// ── failure states ──
console.log('\nfailure handling');
const unknown = await sse({ model: 'nope', brief: 'x' });
ok(unknown.httpError === 400, 'unknown model is rejected with 400', `got ${unknown.httpError}`);
const empty = await sse({ model: reg.models[0].key, brief: '   ' });
ok(empty.httpError === 400, 'empty brief is rejected with 400', `got ${empty.httpError}`);

// rawFetch deliberately: this asserts what happens with NO credentials, and
// smoke itself is signed in as the owner, who is allowed to reload. 401 with
// accounts on, 403 with them off — either way it is refused, which is the
// claim. Using the wrapped fetch here would test the owner's own access and
// pass for the wrong reason.
const noauth = await rawFetch(`${BASE}/api/prompts/reload`, { method: 'POST' });
ok(
  noauth.status === 401 || noauth.status === 403,
  'prompt reload refuses a caller with no credentials',
  `got ${noauth.status}`
);

// ── queue position reporting ──
console.log('\nqueue');
const concurrent = await Promise.all(
  [1, 2, 3].map(() => sse({ model: reg.models[0].key, brief, controls: {} }))
);
const sawQueued = concurrent.some((r) => r.events.some((e) => e.event === 'queued'));
ok(sawQueued, 'a request behind another receives a queued event with its position');
const positions = concurrent
  .flatMap((r) => r.events.filter((e) => e.event === 'queued').map((e) => e.data.position))
  .sort();
ok(positions.every((p) => p >= 1), 'queue positions are 1-based', positions.join(','));

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
