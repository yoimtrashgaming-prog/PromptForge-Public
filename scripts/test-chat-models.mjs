// The chat model selector, and the model requests that feed it.
//
//   node scripts/test-chat-models.mjs
//
// Two halves, one suite, because they are one feature: you pick from what the
// box has, and when it does not have the thing you need you ask for it.
//
// The store is exercised directly, in a throwaway directory. The routes run
// against a real server pointed at an Ollama-shaped stub — not the mock
// backend, because the whole point of the selector is a list of installed
// models, and the mock has none. The stub is what makes "that model is not
// installed" a case rather than a comment.
//
// Needs no Ollama, no GPU and no network.

import { freePort } from './lib/freeport.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestStore } from '../server/requests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = await freePort(11498);
const APP_PORT = await freePort(8095);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const OWNER = 'owner';           // config/server.yaml owner_username
const MODEL = 'qwen3:8b';          // what the stub says is installed
const OTHER = 'qwen3:1.7b';        // installed, never resident
const ABSENT = 'qwen3.8:27b';      // never installed — the rejection case

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

const usersDir = mkdtempSync(path.join(tmpdir(), 'pf-chatmodels-users-'));
const requestsDir = mkdtempSync(path.join(tmpdir(), 'pf-chatmodels-reqs-'));
// And everything else under data/, the run counter included: this suite sends
// real chat turns as MODEL, and those were being counted in the owner's usage
// panel as if a person had picked qwen3:8b. See server/paths.mjs.
const dataDir = mkdtempSync(path.join(tmpdir(), 'pf-chatmodels-data-'));

// ── the request store, directly ──────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-reqstore-'));
  const store = createRequestStore(ROOT, { paths: { requests: dir } });

  const first = store.create('alice', { tag: 'gemma3:27b', url: '', reason: 'better at prose' });
  check('a new request starts pending', first.status === 'pending', first.status);
  check('...and records who asked', first.user === 'alice', first.user);
  check('...and what for', first.reason === 'better at prose', first.reason);

  // The tag is the thing the owner pastes into a terminal, so it is checked
  // rather than trusted.
  const threw = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  };
  check(
    'a tag with a space is refused',
    threw(() => store.create('alice', { tag: 'gemma 3' }))?.statusCode === 400
  );
  check(
    'an empty tag is refused',
    threw(() => store.create('alice', { tag: '   ' }))?.statusCode === 400
  );
  // A real tag on this box. If the shape rule broke this, the one model the
  // project actually pulls from Hugging Face could not be asked for.
  const hf = store.create('alice', { tag: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL' });
  check('a hugging-face tag with slashes and dots is allowed', hf.status === 'pending', hf.tag);

  // Fails closed for the same reason the search parser does: this link is
  // rendered in the owner's panel, which is the account where it would matter
  // most.
  check(
    'a javascript: link is refused',
    threw(() => store.create('bob', { tag: 'llama4:8b', url: 'javascript:alert(1)' }))?.statusCode === 400
  );
  check(
    'so is something that is not a URL at all',
    threw(() => store.create('bob', { tag: 'llama4:8b', url: 'ollama.com/library' }))?.statusCode === 400
  );
  const linked = store.create('bob', {
    tag: 'llama4:8b',
    url: 'https://ollama.com/library/llama4',
  });
  check('an https link is kept', linked.url === 'https://ollama.com/library/llama4', linked.url);

  // A second ask for something already waiting is noise in the owner's list,
  // not a second vote — and it says who asked, because "someone already asked"
  // without a name reads as the app having lost the request.
  const dup = threw(() => store.create('carol', { tag: 'llama4:8b' }));
  check('a duplicate pending request is refused', dup?.statusCode === 409, String(dup?.statusCode));
  check('...naming who is already waiting on it', /bob/.test(dup?.message ?? ''), dup?.message);
  const own = threw(() => store.create('bob', { tag: 'llama4:8b' }));
  check('...and phrased differently when it is your own', /You already asked/.test(own?.message ?? ''), own?.message);

  const approved = store.decide(linked.id, 'approve', OWNER);
  check('approving settles it', approved.status === 'approved', approved.status);
  check('...recording who decided', approved.decided_by === OWNER, approved.decided_by);
  check('...and when', Boolean(approved.decided_at));

  // Two owners clicking at once must not produce a record that disagrees with
  // what either of them saw.
  check(
    'deciding a settled request again is refused',
    threw(() => store.decide(linked.id, 'deny', OWNER))?.statusCode === 409
  );
  // Once it is settled the model can be asked for again — a denial is not a
  // permanent ban on the subject.
  check('a settled tag can be requested again', store.create('carol', { tag: 'llama4:8b' }).status === 'pending');

  const denied = store.decide(first.id, 'deny', OWNER, 'Card is full.');
  check('denying settles it too', denied.status === 'denied', denied.status);
  check('...and keeps the note', denied.note === 'Card is full.', denied.note);

  check(
    'a pending request cannot be quietly cleared',
    threw(() => store.remove(hf.id))?.statusCode === 409
  );
  check('a settled one can', store.remove(denied.id) === true);
  check('clearing something that does not exist is false', store.remove('req_nope') === false);
  check('an unknown id is a 404', threw(() => store.decide('req_deadbeef1234', 'approve', OWNER))?.statusCode === 404);

  // Ids become filenames. Nothing was reachable through them, but the property
  // is asserted where the filename is built rather than assumed from routing.
  check(
    'an id shaped like a path is refused rather than resolved',
    store.get('../../config/server') === null
  );

  check('your own list is only yours', store.listFor('bob').every((r) => r.user === 'bob'));
  check(
    'the owner list puts pending first',
    store.list()[0].status === 'pending',
    store.list().map((r) => r.status).join(',')
  );
  check('and the count is reported', store.info().pending === store.list().filter((r) => r.status === 'pending').length);

  rmSync(dir, { recursive: true, force: true });
}

// ── an Ollama-shaped backend that holds two models ───────────
//
// Only one of them is resident, which is the split the selector groups on.
const stub = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/v1/models')) {
    return send(200, { data: [{ id: MODEL }, { id: OTHER }] });
  }
  if (req.url.startsWith('/api/tags')) {
    return send(200, {
      models: [
        { name: MODEL, size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
        { name: OTHER, size: 1_400_000_000, details: { parameter_size: '1.7B', quantization_level: 'Q4_K_M' } },
      ],
    });
  }
  // Capabilities live only on /api/show - one call per model, not on
  // /api/tags. MODEL sees, OTHER does not, which is the split that makes the
  // badge meaningful rather than decorative.
  if (req.url.startsWith('/api/show')) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const name = (() => { try { return JSON.parse(body).name; } catch { return ''; } })();
      if (name === MODEL) return send(200, { capabilities: ['completion', 'tools', 'thinking', 'vision'] });
      if (name === OTHER) return send(200, { capabilities: ['completion', 'tools', 'thinking'] });
      send(404, { error: 'not found' });
    });
    return;
  }
  if (req.url.startsWith('/api/ps')) {
    return send(200, {
      models: [{ name: MODEL, size: 5_200_000_000, size_vram: 5_200_000_000 }],
    });
  }
  if (req.url.startsWith('/api/chat')) {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Rank 8 is fine.' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
    });
    return;
  }
  send(404, { error: 'not found' });
});

stub.listen(STUB_PORT, '127.0.0.1');
await once(stub, 'listening');

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_AUTH: 'off',
    PROMPTFORGE_LLM_BACKEND: 'ollama',
    PROMPTFORGE_LLM_MODEL: MODEL,
    PROMPTFORGE_LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    PROMPTFORGE_USERS_DIR: usersDir,
    // Box-wide, so without this a test run would leave requests sitting in the
    // owner's real list.
    PROMPTFORGE_REQUESTS_DIR: requestsDir,
    PROMPTFORGE_DATA_DIR: dataDir,
    PROMPTFORGE_SEARCH: 'off',
  },
  stdio: 'ignore',
});

async function up() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const as = (user, init = {}) => ({
  ...init,
  headers: { 'content-type': 'application/json', 'x-promptforge-user': user, ...(init.headers ?? {}) },
});

// Reads one SSE stream to the end and groups its events by name.
async function chat(user, body) {
  const res = await fetch(`${BASE}/api/chat`, as(user, { method: 'POST', body: JSON.stringify(body) }));
  if (!res.ok) return { status: res.status, json: await res.json().catch(() => ({})), events: {} };
  const text = await res.text();
  const events = {};
  for (const frame of text.split(String.fromCharCode(10, 10))) {
    const ev = /^event: (.+)$/m.exec(frame);
    const da = /^data: (.+)$/m.exec(frame);
    if (!ev || !da) continue;
    (events[ev[1]] ??= []).push(JSON.parse(da[1]));
  }
  return { status: res.status, events };
}

try {
  if (!(await up())) throw new Error(`server did not start on ${APP_PORT}`);

  // ── what the selector is built from ──
  const status = await fetch(`${BASE}/api/status`, as('alice')).then((r) => r.json());
  check('status lists what the backend has installed', (status.llm?.installed ?? []).length === 2,
    JSON.stringify(status.llm?.installed));
  // Length first, then the sizes. `every` on an empty array is true, so the
  // obvious spelling of this passes with no catalog at all — which is exactly
  // what it did until the mutation test caught it.
  check('...with a size for each, so a swap can be costed before the click',
    (status.llm?.catalog ?? []).length === 2 &&
      status.llm.catalog.every((m) => Number(m.size_bytes) > 0),
    JSON.stringify(status.llm?.catalog));
  check('...and which of them is actually in VRAM',
    (status.llm?.resident ?? []).length === 1 && status.llm.resident[0].model === MODEL,
    JSON.stringify(status.llm?.resident));
  // ── what each model can do ──
  //
  // Read from the backend rather than written down here. A hardcoded list
  // would have been wrong on one of the two real boxes on 25 Aug 2026: the
  // dev machine had four models and none could see, the P40 had seven and six
  // could.
  const byName = new Map((status.llm?.catalog ?? []).map((m) => [m.model, m]));
  check('a vision-capable model is marked as one',
    byName.get(MODEL)?.vision === true, JSON.stringify(byName.get(MODEL)));
  check('...and a text-only one is not',
    byName.get(OTHER)?.vision === false, JSON.stringify(byName.get(OTHER)));
  check('...with the full capability list carried through, not just the flag',
    Array.isArray(byName.get(MODEL)?.capabilities) &&
      byName.get(MODEL).capabilities.includes('vision') &&
      !byName.get(OTHER).capabilities.includes('vision'),
    JSON.stringify(byName.get(MODEL)?.capabilities));


  // ── choosing one ──
  const good = await chat('alice', { message: 'What rank for a character LoRA?', model: OTHER });
  check('a turn on an installed model answers', good.events.done?.length === 1, JSON.stringify(good.json ?? {}));
  const chatId = good.events.chat?.[0]?.id;
  const stored = () => JSON.parse(readFileSync(path.join(usersDir, 'alice', 'chats', `${chatId}.json`), 'utf8'));
  check('...and the conversation records which model answered', stored().model === OTHER, stored().model);

  // The selector is populated from what is installed, so a name that is not
  // can only be a stale page or a hand-written request. Both deserve to be
  // told before anything is written or queued.
  const before = readdirSync(path.join(usersDir, 'alice', 'chats')).length;
  const bad = await chat('alice', { message: 'anything', model: ABSENT });
  check('a model that is not installed is refused', bad.status === 400, String(bad.status));
  check('...by name, saying what to do about it', /not installed/.test(bad.json?.message ?? ''), bad.json?.message);
  check('...before a conversation is created for it',
    readdirSync(path.join(usersDir, 'alice', 'chats')).length === before,
    `${before} -> ${readdirSync(path.join(usersDir, 'alice', 'chats')).length}`);

  // Switching mid-conversation is allowed and recorded, so reopening it puts
  // the selector back where it was left rather than on someone else's pick.
  await chat('alice', { id: chatId, message: 'and for a style?', model: MODEL });
  check('switching model mid-conversation is recorded', stored().model === MODEL, stored().model);

  // The same check for prompt writing (11 Oct 2026). A "Written by" choice
  // saved before the model was deleted ended every generation on "HTTP 404"
  // and the backend's raw JSON; chat has always said "not installed".
  {
    mkdirSync(path.join(usersDir, 'carol'), { recursive: true });
    writeFileSync(path.join(usersDir, 'carol', 'preferences.json'), JSON.stringify({ prompt_llm: ABSENT }));
    const gen = await fetch(`${BASE}/api/generate`, as('carol', {
      method: 'POST', body: JSON.stringify({ model: 'illustrious', brief: 'a cat on a roof' }),
    }));
    const genJson = await gen.json().catch(() => ({}));
    check('generate with a stored writer that is gone is refused', gen.status === 400, String(gen.status));
    check('...naming it and where to change it', /Written by, is not installed any more/.test(genJson.message ?? ''), genJson.message);
    const rev = await fetch(`${BASE}/api/revise`, as('carol', {
      method: 'POST',
      body: JSON.stringify({ model: 'illustrious', brief: 'a cat', segments: [{ label: 'Positive prompt', body: '1girl' }] }),
    }));
    check('...and so is a second pass', rev.status === 400, String(rev.status));
    writeFileSync(path.join(usersDir, 'carol', 'preferences.json'), JSON.stringify({ prompt_llm: OTHER }));
    const ok = await fetch(`${BASE}/api/generate`, as('carol', {
      method: 'POST', body: JSON.stringify({ model: 'illustrious', brief: 'a cat on a roof' }),
    }));
    await ok.text();
    check('a stored writer that is installed still streams', ok.status === 200, String(ok.status));
  }

  // Absent means "no opinion" — the server applies its configured default
  // rather than the page inventing one.
  const plain = await chat('bob', { message: 'hello' });
  check('a turn with no model named still answers', plain.events.done?.length === 1);

  // ── asking for one that is not there ──
  const post = (user, body) =>
    fetch(`${BASE}/api/model-requests`, as(user, { method: 'POST', body: JSON.stringify(body) }));

  const created = await post('alice', {
    tag: 'gemma3:27b',
    url: 'https://ollama.com/library/gemma3',
    reason: 'Longer context.',
  });
  check('anyone can ask for a model', created.status === 201, String(created.status));

  const refused = await post('alice', { tag: 'not a tag' });
  check('a bad tag comes back as an answer, not a crash', refused.status === 400, String(refused.status));

  const mine = await fetch(`${BASE}/api/model-requests`, as('alice')).then((r) => r.json());
  check('you can read back what you asked for', mine.requests.length === 1, JSON.stringify(mine.requests));
  check('...and what is already installed, so you do not ask for it twice',
    (mine.installed ?? []).includes(MODEL), JSON.stringify(mine.installed));
  const others = await fetch(`${BASE}/api/model-requests`, as('bob')).then((r) => r.json());
  check('and not what anyone else asked for', others.requests.length === 0, JSON.stringify(others.requests));

  // The gate is server-side on every /api/admin/ route, not a hidden button.
  const nosy = await fetch(`${BASE}/api/admin/requests`, as('bob'));
  check('the decision surface is closed to everyone but the owner', nosy.status === 403, String(nosy.status));

  const all = await fetch(`${BASE}/api/admin/requests`, as(OWNER)).then((r) => r.json());
  check('the owner sees every request', all.requests.length === 1, JSON.stringify(all.requests));
  const id = all.requests[0].id;

  const decided = await fetch(
    `${BASE}/api/admin/requests/${id}/approve`,
    as(OWNER, { method: 'POST', body: JSON.stringify({}) })
  );
  const decidedBody = await decided.json();
  check('the owner can approve', decidedBody.request?.status === 'approved', JSON.stringify(decidedBody));
  // Approving records the decision and hands over the command. It deliberately
  // does not start a multi-gigabyte download from a modal — that is Tab 6.
  check('...and is given the pull command rather than a download',
    decidedBody.pull_command === 'ollama pull gemma3:27b', String(decidedBody.pull_command));

  const gone = await fetch(
    `${BASE}/api/admin/requests/req_doesnotexist99/approve`,
    as(OWNER, { method: 'POST', body: JSON.stringify({}) })
  );
  check('deciding something that does not exist is a 404', gone.status === 404, String(gone.status));
} catch (err) {
  failures.push(`suite threw — ${err.message}`);
} finally {
  app.kill();
  stub.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(requestsDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('\nchat models + requests\n');
for (const f of failures) console.log(`  FAIL  ${f}`);
if (failures.length) {
  console.log(`\n${failures.length} of ${passed + failures.length} FAILED\n`);
  process.exit(1);
}
// The shape npm run check reads its count out of.
console.log(`ALL PASSED (${passed})\n`);
