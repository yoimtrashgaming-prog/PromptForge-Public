// Chat: storage, the routes, and the contracts that keep a conversation honest.
//
//   node scripts/test-chat.mjs
//
// Stands up a real server on the mock backend, so no GPU and no model. What it
// cannot check is answer quality; what it can check is that a conversation
// survives a round trip, that the second turn carries the first, and that a
// conversation belongs to one person.

import { freePort } from './lib/freeport.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from '../server/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = await freePort(8094);
const BASE = `http://127.0.0.1:${APP_PORT}`;

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

const usersDir = mkdtempSync(path.join(tmpdir(), 'pf-chat-'));
// The rest of what the server writes. Chat records a run per turn, and
// without this those land in the live counter — see server/paths.mjs.
const dataDir = mkdtempSync(path.join(tmpdir(), 'pf-chat-data-'));

// ── storage, directly ────────────────────────────────────────
{
  const storage = createStorage(ROOT, { paths: { users: usersDir } });

  check(
    'a new conversation starts empty',
    storage.createChat('tester', {}).messages.length === 0
  );

  const chat = storage.createChat('tester', { model: 'mock' });
  check('...and untitled until someone speaks', chat.title === 'New chat', chat.title);

  // The first thing someone says is the best title available without asking a
  // model for one, which would cost a second generation on a box where the
  // first one is already the slow part.
  const after = storage.appendMessage('tester', chat.id, {
    role: 'user',
    content: 'What rank for a character LoRA?',
  });
  check(
    'the first user message titles the conversation',
    after.title === 'What rank for a character LoRA?',
    after.title
  );

  const long = storage.createChat('tester', {});
  const titled = storage.appendMessage('tester', long.id, {
    role: 'user',
    content: 'x'.repeat(200),
  });
  check(
    'a very long first message is cut rather than stored whole as a title',
    titled.title.length <= 61 && titled.title.endsWith('…'),
    `${titled.title.length} chars`
  );

  const multiline = storage.createChat('tester', {});
  const ml = storage.appendMessage('tester', multiline.id, {
    role: 'user',
    content: `first line${String.fromCharCode(10)}second line`,
  });
  check('and only its first line is used', ml.title === 'first line', ml.title);

  // The title comes from what the person asked, not from how the model opened.
  const named = storage.appendMessage('tester', chat.id, {
    role: 'assistant',
    content: 'Rank 8.',
  });
  check(
    'an assistant reply does not retitle the conversation',
    named.title === 'What rank for a character LoRA?',
    named.title
  );
  check(
    'both sides are stored in order',
    named.messages.map((m) => m.role).join(',') === 'user,assistant',
    named.messages.map((m) => m.role).join(',')
  );
  check('every message is timestamped', named.messages.every((m) => typeof m.at === 'string'));
  check('updated_at moves with the last message', named.updated_at === named.messages.at(-1).at);

  // Absent rather than null when nothing searched, so a stored conversation
  // says plainly whether a search happened. Search does not exist yet; this is
  // the field that will carry it.
  check(
    'a message with no search carries no searched field',
    named.messages.every((m) => !('searched' in m))
  );

  const list = storage.listChats('tester');
  check('the sidebar lists every conversation', list.length === 4, String(list.length));
  check('...newest first', list[0].updated_at >= list[1].updated_at);
  check('...with a message count', typeof list[0].message_count === 'number');
  // A hundred conversations of a hundred messages is a few megabytes, and the
  // sidebar needs none of it.
  check('...and no message bodies', !('messages' in list[0]), Object.keys(list[0]).join(','));

  // Per-user separation, the same property the library has.
  storage.createChat('someone-else', {});
  check('conversations are per user', storage.listChats('tester').length === 4);
  check('...another user sees only their own', storage.listChats('someone-else').length === 1);
  check('...and cannot open one by id', storage.getChat('someone-else', chat.id) === null);

  check('deleting returns true once', storage.deleteChat('tester', chat.id) === true);
  check('...and false the second time', storage.deleteChat('tester', chat.id) === false);
  check(
    '...and it leaves the list',
    !storage.listChats('tester').some((c) => c.id === chat.id)
  );

  let threw = null;
  try {
    storage.appendMessage('tester', 'chat_does_not_exist', { role: 'user', content: 'hi' });
  } catch (err) {
    threw = err;
  }
  check(
    'appending to a conversation that does not exist is a 404, not a new file',
    threw?.statusCode === 404,
    String(threw?.statusCode)
  );
}

// ── retention and the lock ───────────────────────────────────
//
// Conversations are deleted after `chats.retention_days` without a new
// message, and a locked one never is. `now` is injectable, so none of this
// waits a fortnight.
{
  const storage = createStorage(ROOT, { paths: { users: path.join(usersDir, 'sweep') } });
  const DAY = 86400000;
  const now = Date.now();

  // Ages are set by writing the file the same way the app does and then
  // rewriting updated_at, which is exactly what an old conversation is.
  const aged = (user, days, opts = {}) => {
    const chat = storage.createChat(user, {});
    storage.appendMessage(user, chat.id, { role: 'user', content: `${days} days old` });
    const file = path.join(usersDir, 'sweep', user, 'chats', `${chat.id}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.updated_at = new Date(now - days * DAY).toISOString();
    if (opts.locked) raw.locked = true;
    if (opts.brokenDate) raw.updated_at = 'not a date';
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
    return chat.id;
  };

  const old = aged('keeper', 20);
  const fresh = aged('keeper', 3);
  const edge = aged('keeper', 14.5);
  const lockedOld = aged('keeper', 40, { locked: true });
  const broken = aged('keeper', 99, { brokenDate: true });

  // Nothing happens when it is switched off, whatever the ages.
  check('retention 0 keeps everything', storage.sweepChats('keeper', 0, now).swept.length === 0);
  check('and so does a missing setting', storage.sweepChats('keeper', undefined, now).swept.length === 0);
  // Fail safe: a typo in config must never quietly delete history.
  check('and so does nonsense', storage.sweepChats('keeper', 'soon', now).swept.length === 0);

  const result = storage.sweepChats('keeper', 14, now);
  const sweptIds = result.swept.map((c) => c.id);

  check('a conversation older than the window is deleted', sweptIds.includes(old), sweptIds.join(','));
  check('...and one inside it is not', !sweptIds.includes(fresh));
  check('...counted from the last message, so 14.5 days goes', sweptIds.includes(edge));
  // The whole point of the lock.
  check('a locked conversation is never swept, however old', !sweptIds.includes(lockedOld));
  // An unparseable date is a reason to leave a file alone, not to delete it.
  check('a conversation with an unreadable date is left alone', !sweptIds.includes(broken));
  // Five went in, the 20-day and the 14.5-day went out: fresh, locked and
  // broken-date survive.
  check('the survivors are still listable', storage.listChats('keeper').length === 3,
    String(storage.listChats('keeper').length));
  check('the sweep reports what it kept', result.kept === 3, String(result.kept));

  // Sweeping again finds nothing new, which is what makes it safe on a timer.
  check('a second sweep is a no-op', storage.sweepChats('keeper', 14, now).swept.length === 0);

  // Everyone at once, for the server's timer.
  aged('other-person', 30);
  const all = storage.sweepAllChats(14, now);
  check('the whole-box sweep covers every account',
    all.length === 1 && all[0].user === 'other-person', JSON.stringify(all));

  // ── the lock, directly ──
  const keep = storage.createChat('locker', {});
  storage.appendMessage('locker', keep.id, { role: 'user', content: 'worth keeping' });
  const before = storage.getChat('locker', keep.id).updated_at;

  const locked = storage.setChatLocked('locker', keep.id, true);
  check('locking sets the flag', locked.locked === true);
  // Locking is not talking. If it counted as activity it would silently
  // restart the retention clock, which is a confusing way to be told it worked.
  check('...without counting as activity', locked.updated_at === before,
    `${before} -> ${locked.updated_at}`);
  check('...and the sidebar reports it',
    storage.listChats('locker')[0].locked === true);
  check('unlocking puts it back', storage.setChatLocked('locker', keep.id, false).locked === false);
  // A conversation written before locking existed has no flag at all.
  check('a conversation with no flag reads as unlocked',
    storage.listChats('locker')[0].locked === false);

  let lockThrew = null;
  try {
    storage.setChatLocked('locker', 'chat_nope', true);
  } catch (err) {
    lockThrew = err;
  }
  check('locking something that does not exist is a 404', lockThrew?.statusCode === 404);

  // A lock is not a delete guard. One you could not get rid of would be worse
  // than one that expires.
  storage.setChatLocked('locker', keep.id, true);
  check('a locked conversation can still be deleted by hand',
    storage.deleteChat('locker', keep.id) === true);
}

// ── the routes, against a running server ─────────────────────
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_AUTH: 'off',
    PROMPTFORGE_LLM_BACKEND: 'mock',
    PROMPTFORGE_USERS_DIR: usersDir,
    PROMPTFORGE_DATA_DIR: dataDir,
    // Never reach the network from a test. The search-requested path still
    // has to work with search switched off — that is a case, not a skip.
    PROMPTFORGE_SEARCH: 'off',
  },
  stdio: 'ignore',
});

async function up() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Reads one SSE stream to the end and groups its events by name.
async function sse(route, body) {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-promptforge-user': 'router' },
    body: JSON.stringify(body),
  });
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

const get = (route) =>
  fetch(BASE + route, { headers: { 'x-promptforge-user': 'router' } }).then(async (r) => ({
    status: r.status,
    json: await r.json().catch(() => ({})),
  }));

const del = (route) =>
  fetch(BASE + route, {
    method: 'DELETE',
    headers: { 'x-promptforge-user': 'router' },
  });

try {
  if (!(await up())) {
    console.error('server did not start — did PROMPTFORGE_PORT take effect?');
    process.exit(1);
  }

  {
    const empty = await sse('/api/chat', { message: '   ' });
    check(
      'an empty message is refused before a conversation is created',
      empty.status === 400,
      String(empty.status)
    );
  }

  {
    // A bad id must not quietly become a new conversation, or a client bug
    // scatters orphans nobody can find.
    const missing = await sse('/api/chat', { id: 'chat_nope', message: 'hello' });
    check(
      'a message to a conversation that does not exist is a 404',
      missing.status === 404,
      String(missing.status)
    );
  }

  let id = null;
  {
    const first = await sse('/api/chat', { message: 'What sampler for anime?' });
    id = first.events.chat?.[0]?.id;
    // The id arrives before any token, so a new conversation is navigable the
    // moment it exists rather than once it finishes.
    check('a new conversation announces its id first', Boolean(id), JSON.stringify(first.events.chat));
    check(
      '...and its title with it',
      first.events.chat?.[0]?.title === 'What sampler for anime?',
      first.events.chat?.[0]?.title
    );
    check(
      'tokens stream rather than arriving in one lump',
      (first.events.token ?? []).length > 1,
      String((first.events.token ?? []).length)
    );
    check(
      'and done carries exactly what streamed',
      first.events.done?.[0]?.content === (first.events.token ?? []).map((t) => t.text).join('')
    );
  }

  {
    const history = await get('/api/chat/history');
    check('the conversation appears in the history', history.json.chats?.some((c) => c.id === id));

    const one = await get(`/api/chat/${id}`);
    check('and can be reopened by id', one.status === 200 && one.json.id === id);
    check(
      '...with both sides of the exchange saved',
      one.json.messages?.map((m) => m.role).join(',') === 'user,assistant',
      one.json.messages?.map((m) => m.role).join(',')
    );
  }

  {
    // ── the lock, over HTTP ──
    const post = (route, body) =>
      fetch(BASE + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-promptforge-user': 'router' },
        body: JSON.stringify(body),
      });

    const history = await get('/api/chat/history');
    check('the history states the retention policy',
      typeof history.json.retention_days === 'number', String(history.json.retention_days));
    check('...and every conversation says whether it is locked',
      history.json.chats.every((c) => typeof c.locked === 'boolean'));

    const locked = await post(`/api/chat/${id}/lock`, { locked: true });
    check('a conversation can be locked', locked.status === 200, String(locked.status));
    check('...and the history says so',
      (await get('/api/chat/history')).json.chats.find((c) => c.id === id)?.locked === true);

    const unlocked = await post(`/api/chat/${id}/lock`, { locked: false });
    check('...and unlocked again', (await unlocked.json()).locked === false);
    // Lock again for the sweep to ignore later; also the default when no body
    // field is sent, since the button that calls this always means "lock".
    check('an empty body means lock', (await (await post(`/api/chat/${id}/lock`, {})).json()).locked === true);
    await post(`/api/chat/${id}/lock`, { locked: false });

    check('locking something that does not exist is a 404',
      (await post('/api/chat/chat_nope/lock', { locked: true })).status === 404);
    // The traversal guard applies here too — this route takes an id as well.
    check('...and a malformed id is refused rather than resolved',
      (await post('/api/chat/..%2F..%2Fother/lock', { locked: true })).status === 404);
  }

  {
    // The point of a conversation: the second turn has to carry the first.
    const second = await sse('/api/chat', { id, message: 'And why that one?' });
    check(
      'a second turn stays in the same conversation',
      second.events.chat?.[0]?.id === id,
      second.events.chat?.[0]?.id
    );
    const one = await get(`/api/chat/${id}`);
    check('...appending rather than replacing', one.json.messages.length === 4, String(one.json.messages.length));
    check('...and leaving the original title alone', one.json.title === 'What sampler for anime?', one.json.title);
  }

  {
    check('a conversation can be deleted', (await del(`/api/chat/${id}`)).status === 200);
    check('...and is then a 404', (await get(`/api/chat/${id}`)).status === 404);
    check('...and deleting it again is a 404, not a 500', (await del(`/api/chat/${id}`)).status === 404);
  }

  {
    // ── bleed-through ──
    //
    // The owner asked the right question: can one account reach another's
    // conversations? Everything below came back 404 when it was first tried,
    // but two of the reasons lived in code this project does not own — new
    // URL() strips dot segments, and a pathname keeps %2F encoded — so the
    // property is now enforced in storage.mjs where the filename is built, and
    // pinned here.
    const mine = await sse('/api/chat', { message: 'A private question.' });
    const privateId = mine.events.chat?.[0]?.id;

    const asOther = (route, method = 'GET') =>
      fetch(BASE + route, { method, headers: { 'x-promptforge-user': 'intruder' } });

    check(
      "another account's history does not contain it",
      !((await (await asOther('/api/chat/history')).json()).chats ?? []).some((c) => c.id === privateId)
    );
    check(
      '...cannot open it by id',
      (await asOther(`/api/chat/${privateId}`)).status === 404
    );
    check(
      '...cannot delete it',
      (await asOther(`/api/chat/${privateId}`, 'DELETE')).status === 404
    );

    // Writing into someone else's conversation is the worse half: it would put
    // words in their history that they never said.
    const injected = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-promptforge-user': 'intruder' },
      body: JSON.stringify({ id: privateId, message: 'injected' }),
    });
    check('...and cannot append to it', injected.status === 404, String(injected.status));

    // Three traversal encodings, because a guard that only catches the literal
    // one is the usual way this is got wrong.
    for (const attack of [
      `..%2F..%2Frouter%2Fchats%2F${privateId}`,
      `%2e%2e%2f%2e%2e%2frouter%2fchats%2f${privateId}`,
      `....//....//router/chats/${privateId}`,
    ]) {
      check(
        `a traversal attempt is refused: ${attack.slice(0, 24)}…`,
        (await asOther(`/api/chat/${attack}`)).status === 404
      );
    }

    // And the owner still has an intact conversation afterwards.
    const still = await get(`/api/chat/${privateId}`);
    check('the conversation itself is untouched by all of that',
      still.status === 200 && still.json.messages.length === 2,
      `${still.status} / ${still.json.messages?.length}`);
  }

  {
    // ── search, with it switched off ──
    //
    // The suite runs with PROMPTFORGE_SEARCH=off so it never touches the
    // network. That is not a gap: "someone pressed Search and the server
    // cannot search" is a real state, and the answer still has to arrive.
    const asked = await sse('/api/chat', { message: 'Anything current?', search: true });
    check('a search request announces itself before the answer',
      asked.events.searching?.[0]?.query === 'Anything current?',
      JSON.stringify(asked.events.searching));
    check('...and reports back that it found nothing',
      asked.events.searched?.[0]?.ok === false, JSON.stringify(asked.events.searched));
    check('...with a reason rather than a silent empty list',
      typeof asked.events.searched?.[0]?.detail === 'string');
    // The promise the whole feature rests on.
    check('...and the answer still arrives', Boolean(asked.events.done?.[0]?.content));
    check('...carrying no citations it cannot support',
      (asked.events.done?.[0]?.citations ?? []).length === 0);

    const stored = await get(`/api/chat/${asked.events.chat[0].id}`);
    const reply = stored.json.messages.at(-1);
    // Recorded either way, so a stored conversation says plainly whether its
    // answer had sources behind it.
    check('the stored answer records that a search was attempted',
      reply.searched?.query === 'Anything current?', JSON.stringify(reply.searched));
    check('...and stores no citations for a search that found nothing',
      !('citations' in reply), Object.keys(reply).join(','));

    // Not asking must remain the default: no search events at all.
    const quiet = await sse('/api/chat', { message: 'And without searching?' });
    check('a message with no search request searches nothing',
      quiet.events.searching === undefined && quiet.events.searched === undefined);
  }

  {
    const bad = await fetch(`${BASE}/api/chat/whatever`, {
      method: 'PUT',
      headers: { 'x-promptforge-user': 'router' },
    });
    check('an unsupported method on a conversation is 405', bad.status === 405, String(bad.status));
  }
} finally {
  server.kill();
  try {
    rmSync(usersDir, { recursive: true, force: true });
  } catch {
    // Windows will not remove a directory another process still holds open.
    // The temp dir is disposable either way.
  }
}

if (failures.length) {
  console.log(`${String.fromCharCode(10)}${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
