/**
 * Self-written system prompts, and the standing instruction.
 *
 * Both are user text that reaches the model, and each reaches it in a
 * different turn — which is the whole of why they are tested together:
 *
 *   1. A system prompt block REPLACES the prompt this repo ships, for
 *      whoever switches it on. It must reach the model, reach only them,
 *      and fall back to the shipped prompt at every step where it cannot.
 *   2. The standing instruction lands in the USER turn of every generation.
 *      It must not be able to change the segment contract, and it must not
 *      leak between accounts.
 *
 * An earlier version of this suite also covered sharing generated library
 * entries to the group. That feature was removed on 28 Aug 2026 — it was a
 * misreading of "share a prompt", which meant the instructions rather than
 * the output, and the system prompts below are what was actually wanted.
 *
 * Needs no Ollama, no model, no GPU: the server runs the mock backend.
 *
 * Run: npm run test-sharing
 */
import { freePort } from './lib/freeport.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import YAML from 'yaml';

const APP_PORT = await freePort(8097);
const BASE = `http://127.0.0.1:${APP_PORT}`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
};

const serverConfig = YAML.parse(readFileSync('config/server.yaml', 'utf8'));
const OWNER = serverConfig.owner_username;
if (!OWNER) throw new Error('config/server.yaml has no owner_username');

// Throwaway accounts, so a real person's library is never written to.
const alice = `testrunner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const bob = `testrunner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

async function api(method, path, { user, body } = {}) {
  const headers = {};
  if (user) headers['x-promptforge-user'] = user;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// A stub Ollama, so the USER TURN can be read back. The mock backend echoes
// the brief only, which cannot tell "the standing instruction was sent" from
// "it was silently dropped" — the failure this whole feature would have.
// Same technique as test-controls.mjs.
const STUB_PORT = await freePort(8096);
const MODEL = 'stub-model';
let lastUserMessage = '';
let lastSystemMessage = '';
const stub = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/v1/models')) return send(200, { data: [{ id: MODEL }] });
  if (req.url.startsWith('/api/tags')) return send(200, { models: [{ name: MODEL, size: 5e9 }] });
  if (req.url.startsWith('/api/ps')) return send(200, { models: [] });
  if (req.url.startsWith('/api/chat')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw || '{}');
      lastUserMessage = (parsed.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      // The system turn too, for the self-written prompt cases below: the
      // whole claim there is "this replaced the shipped file", and the only
      // place that is visible is what actually went to the model.
      lastSystemMessage = (parsed.messages ?? [])
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      const body =
        '===SEGMENT: Positive prompt===\nmasterpiece, 1girl, lighthouse\n\n' +
        '===SEGMENT: Negative prompt===\nworst_quality\n\n' +
        '===SEGMENT: Reasoning===\nBecause.\n';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: body }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
    });
    return;
  }
  send(404, { error: 'not found' });
});
stub.listen(STUB_PORT, '127.0.0.1');
await once(stub, 'listening');

// Throwaway directories. Sharing writes a file in the DATA dir and libraries
// live under the users dir; neither belongs in the real ones during a test.
const usersDir = mkdtempSync(path.join(tmpdir(), 'pf-sharing-users-'));
const dataDir = mkdtempSync(path.join(tmpdir(), 'pf-sharing-data-'));

const app = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_AUTH: 'off',
    PROMPTFORGE_LLM_BACKEND: 'ollama',
    PROMPTFORGE_LLM_MODEL: MODEL,
    PROMPTFORGE_LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    PROMPTFORGE_USERS_DIR: usersDir,
    PROMPTFORGE_DATA_DIR: dataDir,
    PROMPTFORGE_SEARCH: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
app.stdout.on('data', (d) => { if (/listening on/i.test(String(d))) booted = true; });
for (let i = 0; i < 100 && !booted; i++) await new Promise((r) => setTimeout(r, 100));
if (!booted) {
  console.error('server did not start');
  app.kill();
  process.exit(1);
}

console.log('\nShared prompts, and the standing instruction\n' + '─'.repeat(58));

try {
  // ── the standing instruction ──
  console.log('\nstanding instruction — per account, in the user turn only');
  await api('POST', '/api/account', {
    user: alice,
    body: { preferences: { custom_instruction: 'always frame it wide' } },
  });
  const mineNow = await api('GET', '/api/account', { user: alice });
  check('it saves against the account', mineNow.json?.preferences?.custom_instruction === 'always frame it wide',
    JSON.stringify(mineNow.json?.preferences?.custom_instruction));
  const theirs = await api('GET', '/api/account', { user: bob });
  check('...and does not reach anyone else', !theirs.json?.preferences?.custom_instruction,
    JSON.stringify(theirs.json?.preferences?.custom_instruction));

  const generate = async (user) => {
    const res = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-promptforge-user': user },
      body: JSON.stringify({ model: 'illustrious', brief: 'a lighthouse at dawn', controls: {} }),
    });
    return res.text();
  };

  const stream = await generate(alice);
  check('a generation still parses into segments with one set',
    stream.includes('event: segment') && !stream.includes('unknown_segment'),
    stream.slice(0, 200));
  check('...and the instruction reached the model, in the USER turn',
    lastUserMessage.includes('always frame it wide'),
    lastUserMessage.slice(-300));
  check('...labelled as a standing instruction rather than as part of the brief',
    /Standing instruction from this user/.test(lastUserMessage),
    lastUserMessage.slice(-300));
  check('...and told it cannot change the segments, which everything downstream needs',
    /never changes which segments you emit/.test(lastUserMessage),
    lastUserMessage.slice(-300));

  await generate(bob);
  check('somebody with no instruction sends no such line, so nothing changed for them',
    !/Standing instruction/.test(lastUserMessage),
    lastUserMessage.slice(-200));

  // ── system prompts people write themselves ──
  //
  // The feature the owner actually asked for: not sharing generated output,
  // but writing the INSTRUCTIONS — "the system prompt that would allow users
  // to inject into a model like how we do". A block replaces the shipped
  // file, so what this suite has to prove is that the replacement really
  // happens, that it happens only for the person who switched it on, and
  // that it degrades to the shipped prompt at every step.
  console.log('\nself-written system prompts — replacing the shipped file');

  const shipped = lastSystemMessage;
  check('the shipped prompt is what a generation uses by default',
    shipped.length > 500, `${shipped.length} chars`);

  const BODY = 'You are a test prompt. Emit ===SEGMENT: Positive prompt=== and nothing else.';
  const written = await api('POST', '/api/system-prompts', {
    user: alice,
    body: { title: 'Alice illustrious v1', models: ['illustrious', 'anima'], body: BODY },
  });
  check('writing one returns 201', written.status === 201, JSON.stringify(written.json)?.slice(0, 140));
  check('...attributed to whoever wrote it', written.json?.author === alice);

  check('an unknown model is refused',
    (await api('POST', '/api/system-prompts', {
      user: alice, body: { title: 'x', models: ['not_a_model'], body: BODY },
    })).status === 400);
  check('an empty body is refused',
    (await api('POST', '/api/system-prompts', {
      user: alice, body: { title: 'x', model: 'illustrious', body: '   ' },
    })).status === 400);

  check('one block can serve several models, so a booru prompt is written once',
    JSON.stringify(written.json?.models) === JSON.stringify(['illustrious', 'anima']),
    JSON.stringify(written.json?.models));
  check('...and an unknown key among good ones is dropped rather than stored',
    JSON.stringify((await api('POST', '/api/system-prompts', {
      user: alice,
      body: { title: 'mixed', models: ['anima', 'not_a_model'], body: BODY },
    })).json?.models) === JSON.stringify(['anima']));

  check('everyone can see it, because comparing prompt files is the point',
    (await api('GET', '/api/system-prompts', { user: bob })).json?.entries
      ?.some((e) => e.id === written.json.id));

  // Switching it on is a preference, so it is per account.
  await api('POST', '/api/account', {
    user: alice,
    body: { preferences: { system_prompts: { illustrious: written.json.id } } },
  });
  await generate(alice);
  check('the block replaces the shipped prompt for its author',
    lastSystemMessage.includes(BODY), lastSystemMessage.slice(-200));
  // Keyed to a string only illustrious.md carries. The model's NAME is no
  // good here — house-rules.md mentions Illustrious once, so an earlier
  // version of this assertion failed on the house rules it is supposed to
  // keep. `very_aesthetic` appears three times in illustrious.md and nowhere
  // in the shared prefix.
  check('...and the shipped model file is gone, not appended to',
    !/very_aesthetic/.test(lastSystemMessage),
    lastSystemMessage.slice(0, 200));
  check('...which makes the replacement much shorter than what it replaced',
    lastSystemMessage.length < shipped.length,
    `${lastSystemMessage.length} vs ${shipped.length}`);
  check('...while the house rules survive, since they are the segment contract',
    /===SEGMENT:/.test(lastSystemMessage), lastSystemMessage.slice(0, 200));

  await generate(bob);
  check('somebody who did not switch it on still gets the shipped prompt',
    !lastSystemMessage.includes(BODY) && lastSystemMessage.length > 500);

  // Editing, and who may.
  const edited = await api('POST', '/api/system-prompts', {
    user: alice,
    body: { id: written.json.id, title: 'Alice illustrious v2', models: ['illustrious', 'pony'], body: BODY },
  });
  check('the author can edit their own', edited.status === 201 && edited.json?.title === 'Alice illustrious v2',
    JSON.stringify(edited.json)?.slice(0, 120));
  const hijack = await api('POST', '/api/system-prompts', {
    user: bob,
    body: { id: written.json.id, title: 'mine now', models: ['illustrious', 'pony'], body: BODY },
  });
  check('somebody else cannot rewrite the instructions you are generating against',
    hijack.status === 403, `got ${hijack.status}`);
  const ownerEdit = await api('POST', '/api/system-prompts', {
    user: OWNER,
    body: { id: written.json.id, title: 'owner was here', models: ['illustrious', 'pony'], body: BODY },
  });
  check('...and the owner is deliberately not exempt from that',
    ownerEdit.status === 403, `got ${ownerEdit.status}`);

  const taken = await api('POST', `/api/system-prompts/${written.json.id}/copy`, { user: bob });
  check('copying gives you your own to change', taken.status === 201 && taken.json?.author === bob);
  check('...naming who wrote it', taken.json?.title.includes(alice), taken.json?.title);

  // Deleting, and the degradation that matters most.
  const gone2 = await api('DELETE', `/api/system-prompts/${written.json.id}`, { user: bob });
  check('a stranger cannot delete it', gone2.status === 403, `got ${gone2.status}`);
  check('the owner can', (await api('DELETE', `/api/system-prompts/${written.json.id}`, { user: OWNER })).status === 200);
  await generate(alice);
  check('a preference pointing at a deleted block falls back to the shipped prompt',
    !lastSystemMessage.includes(BODY) && lastSystemMessage.length > 500,
    lastSystemMessage.slice(0, 160));
} finally {
  app.kill();
  stub.close();
}

console.log('─'.repeat(58));
console.log(fail ? `${pass} passed, ${fail} FAILED\n` : `ALL PASSED (${pass})\n`);
process.exit(fail ? 1 : 0);
