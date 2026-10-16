/**
 * Owner gate, prompt library, and tag-variant conformance tests.
 *
 * Three surfaces that were previously verified only by someone clicking
 * through the app once:
 *
 *   1. POST /api/prompts/reload — CLAUDE.md calls the admin surface a
 *      non-negotiable ("enforced server-side, not just a hidden button").
 *      This is the one route that gate applies to today, and nothing
 *      asserted it.
 *   2. /api/library — the whole save/list/fetch/delete round trip, and the
 *      per-user separation the header-based user model depends on.
 *   3. /api/tags/search variant selection — archive/docs/status.md's claim that
 *      Pony gets served the wrong tag spelling was checked by hand once.
 *
 * Needs no Ollama, no model, no GPU: the server is started with
 * PROMPTFORGE_LLM_BACKEND=mock. The tag-variant section needs the tag
 * database; if it is not present, that section SKIPs with a reason and the
 * other two still run.
 *
 * Run: npm run test-library
 */
import { freePort } from './lib/freeport.mjs';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

const APP_PORT = await freePort(8098);
// Saved prompts, accounts, the run counter — all into a throwaway directory,
// so a library test leaves nothing beside the real ones. The tag databases are
// NOT redirected by this and must not be: the tag-variant cases below search
// the real one. See server/paths.mjs.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pf-library-data-'));
const BASE = `http://127.0.0.1:${APP_PORT}`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
};

// Read the owner name the same place the server does, so this test does not
// go stale the day config/server.yaml changes it.
const serverConfig = YAML.parse(readFileSync('config/server.yaml', 'utf8'));
const OWNER = serverConfig.owner_username;
if (!OWNER) throw new Error('config/server.yaml has no owner_username — cannot test the gate');

// Throwaway usernames so this run never writes into a real person's library
// under data/users/. safeUsername() requires lowercase [a-z0-9_-], <=32 chars.
const userA = `testrunner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const userB = `testrunner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

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
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
  return { status: res.status, json };
}

const sampleEntry = (title) => ({
  title,
  model: 'illustrious',
  brief: 'a steampunk mechanic',
  segments: [{ label: 'Positive prompt', body: '1girl, solo' }],
  tags: ['steampunk'],
});

// ───────────────────────────── boot ─────────────────────────────

const app = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_LLM_BACKEND: 'mock',
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
  process.exit(1);
}

console.log('\nOwner gate, library, and tag-variant conformance\n' + '─'.repeat(58));

const createdIds = [];

try {
  // ── 0. a Host header new URL() cannot read ──
  //
  // One request carrying `Host: [bad` used to kill the whole server: the URL
  // was parsed above the request handler's try, Node exits on an unhandled
  // rejection, and every generation in flight went with it. Reproduced on the
  // P40 on 11 Sep 2026. Raw socket, because fetch will not send a bad Host.
  console.log('\nrequest parsing — a Host header the URL parser rejects');
  {
    const { connect } = await import('node:net');
    const statusLine = await new Promise((resolve) => {
      let got = '';
      const s = connect(APP_PORT, '127.0.0.1', () =>
        s.write('GET /health HTTP/1.1\r\nHost: [bad\r\nConnection: close\r\n\r\n'));
      s.on('data', (d) => { got += d; });
      s.on('close', () => resolve(got.split('\r\n')[0]));
      s.on('error', () => resolve(''));
      setTimeout(() => { s.destroy(); resolve(got.split('\r\n')[0]); }, 3000);
    });
    check('a malformed Host is answered 400, not a crash', /\s400\s/.test(statusLine),
      statusLine || '(no reply)');
    const after = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
    check('...and the server is still up afterwards', after === 200, `health ${after}`);
  }

  // ── 1. the owner gate on POST /api/prompts/reload ──
  console.log('\nowner gate — POST /api/prompts/reload');
  {
    const noHeader = await api('POST', '/api/prompts/reload');
    check('no header is refused with 403', noHeader.status === 403, `got ${noHeader.status}`);
    check('the 403 body reports error: "forbidden"', noHeader.json?.error === 'forbidden',
      JSON.stringify(noHeader.json));
    check('the 403 body explains the refusal',
      typeof noHeader.json?.message === 'string' && noHeader.json.message.length > 0,
      JSON.stringify(noHeader.json));

    const notOwner = await api('POST', '/api/prompts/reload', { user: userA });
    check('a non-owner name is refused with 403', notOwner.status === 403, `got ${notOwner.status}`);
    check('...with the same forbidden body', notOwner.json?.error === 'forbidden',
      JSON.stringify(notOwner.json));

    const owner = await api('POST', '/api/prompts/reload', { user: OWNER });
    check('the owner is let through with 200', owner.status === 200, `got ${owner.status}`);
    check('...and the body reports a count of reloaded prompts',
      typeof owner.json?.count === 'number' && owner.json.count > 0,
      JSON.stringify(owner.json));
  }

  // ── 2. the library ──
  console.log('\nlibrary — round trip and per-user separation');
  {
    const saved = await api('POST', '/api/library', { user: userA, body: sampleEntry('round trip test') });
    check('saving returns 201', saved.status === 201, `got ${saved.status}`);
    check('...and the saved entry', typeof saved.json?.id === 'string', JSON.stringify(saved.json));
    const id = saved.json?.id;
    if (id) createdIds.push({ user: userA, id });

    const listed = await api('GET', '/api/library', { user: userA });
    check('the saved entry appears in that user\'s list', listed.status === 200 &&
      Array.isArray(listed.json?.entries) && listed.json.entries.some((e) => e.id === id),
      JSON.stringify(listed.json));

    const fetched = await api('GET', `/api/library/${id}`, { user: userA });
    check('fetching by id returns 200 with the entry', fetched.status === 200 && fetched.json?.id === id,
      JSON.stringify(fetched.json));

    const missing = await api('GET', '/api/library/does-not-exist', { user: userA });
    check('fetching an unknown id returns 404 not_found', missing.status === 404 &&
      missing.json?.error === 'not_found', JSON.stringify(missing.json));

    const wrongMethod = await api('PUT', '/api/library', { user: userA, body: {} });
    check('PUT /api/library is 405 method_not_allowed', wrongMethod.status === 405 &&
      wrongMethod.json?.error === 'method_not_allowed', JSON.stringify(wrongMethod.json));

    // ── per-user separation: an entry saved as A must not be visible as B ──
    const listedAsB = await api('GET', '/api/library', { user: userB });
    check('a different user\'s list does not contain it',
      Array.isArray(listedAsB.json?.entries) && !listedAsB.json.entries.some((e) => e.id === id),
      JSON.stringify(listedAsB.json));

    const fetchedAsB = await api('GET', `/api/library/${id}`, { user: userB });
    check('fetching the other user\'s entry by id is also 404, not a cross-user leak',
      fetchedAsB.status === 404, `got ${fetchedAsB.status}`);

    const deleted = await api('DELETE', `/api/library/${id}`, { user: userA });
    check('deleting returns 200 with the deleted id', deleted.status === 200 &&
      deleted.json?.deleted === id, JSON.stringify(deleted.json));
    if (id) createdIds.splice(createdIds.findIndex((e) => e.id === id), 1);

    const goneNow = await api('GET', `/api/library/${id}`, { user: userA });
    check('it is 404 after deletion', goneNow.status === 404, `got ${goneNow.status}`);

    const deleteAgain = await api('DELETE', `/api/library/${id}`, { user: userA });
    check('deleting an already-deleted id is 404, not a crash', deleteAgain.status === 404,
      `got ${deleteAgain.status}`);
  }

  // ── 2b. shared notes on the installed LLMs ──
  //
  // The mirror image of the library above: that one is per-user and must not
  // leak between people, this one is deliberately shared and must. What is
  // NOT shared is the right to delete, and that is the interesting case.
  console.log('\nllm notes — shared board, narrow delete');
  {
    // A tag with slashes and a colon in it, because that is what an hf.co
    // model is actually called and it is the shape that would break a route
    // splitting the model out of the path.
    const TAG = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL';

    const posted = await api('POST', '/api/llm-notes', {
      user: userA,
      body: { model: TAG, text: 'Holds h3. Slow with thinking on.' },
    });
    check('posting a note returns the entry', posted.status === 200 &&
      typeof posted.json?.entry?.id === 'string', JSON.stringify(posted.json));
    check('...stamped with who wrote it', posted.json?.entry?.author === userA,
      JSON.stringify(posted.json?.entry));
    check('...and when', typeof posted.json?.entry?.at === 'string',
      JSON.stringify(posted.json?.entry));
    const noteId = posted.json?.entry?.id;

    // The whole point: B sees what A wrote. This is the assertion that would
    // fail if someone ever 'fixed' this to match the library's isolation.
    const asB = await api('GET', '/api/llm-notes', { user: userB });
    check('another user sees it - the board is shared on purpose',
      (asB.json?.notes?.[TAG] ?? []).some((e) => e.id === noteId),
      JSON.stringify(asB.json?.notes?.[TAG]));

    const empty = await api('POST', '/api/llm-notes', { user: userA, body: { model: TAG, text: '   ' } });
    check('an empty note is refused', empty.status === 400, `got ${empty.status}`);

    const noModel = await api('POST', '/api/llm-notes', { user: userA, body: { text: 'orphan' } });
    check('a note about no model is refused', noModel.status === 400, `got ${noModel.status}`);

    const huge = await api('POST', '/api/llm-notes', {
      user: userA,
      body: { model: TAG, text: 'x'.repeat(601) },
    });
    check('a note past the cap is refused with the length in the message',
      huge.status === 400 && /601/.test(huge.json?.message ?? ''), JSON.stringify(huge.json));

    // Editing follows delete's rule: the author or the owner, nobody else.
    const noteUrl = `/api/llm-notes/${encodeURIComponent(noteId)}?model=${encodeURIComponent(TAG)}`;
    const edited = await api('PATCH', noteUrl, {
      user: userA, body: { text: 'Holds h3. Fast with thinking off.' },
    });
    check('an author can edit their own note', edited.status === 200 &&
      edited.json?.entry?.text === 'Holds h3. Fast with thinking off.', JSON.stringify(edited.json));
    check('...which stamps edited_at and keeps the original date',
      typeof edited.json?.entry?.edited_at === 'string' &&
      edited.json?.entry?.at === posted.json?.entry?.at, JSON.stringify(edited.json?.entry));

    const editNotYours = await api('PATCH', noteUrl, { user: userB, body: { text: 'hijacked' } });
    check('a different user cannot edit it', editNotYours.status === 403 &&
      editNotYours.json?.error === 'not_yours', JSON.stringify(editNotYours.json));

    const editEmpty = await api('PATCH', noteUrl, { user: userA, body: { text: '   ' } });
    check('an edit to empty is refused', editEmpty.status === 400, `got ${editEmpty.status}`);

    const editHuge = await api('PATCH', noteUrl, { user: userA, body: { text: 'x'.repeat(601) } });
    check('an edit past the cap is refused', editHuge.status === 400 &&
      /601/.test(editHuge.json?.message ?? ''), JSON.stringify(editHuge.json));

    const editGhost = await api('PATCH',
      `/api/llm-notes/note_nothinghere?model=${encodeURIComponent(TAG)}`,
      { user: userA, body: { text: 'nothing' } });
    check('editing an unknown note is 404', editGhost.status === 404, `got ${editGhost.status}`);

    const editByOwner = await api('PATCH', noteUrl, {
      user: OWNER, body: { text: 'Holds h3. Owner tidied this.' },
    });
    check('the owner can edit somebody else\'s note', editByOwner.status === 200 &&
      editByOwner.json?.entry?.author === userA, JSON.stringify(editByOwner.json));

    const afterEdits = await api('GET', '/api/llm-notes', { user: userB });
    check('...and everyone reads the edited text',
      (afterEdits.json?.notes?.[TAG] ?? []).some((e) => e.id === noteId &&
        e.text === 'Holds h3. Owner tidied this.'),
      JSON.stringify(afterEdits.json?.notes?.[TAG]));

    // Delete is where shared stops. B may read A's note and may not remove it.
    const notYours = await api('DELETE',
      `/api/llm-notes/${encodeURIComponent(noteId)}?model=${encodeURIComponent(TAG)}`,
      { user: userB });
    check('a different user cannot delete it', notYours.status === 403 &&
      notYours.json?.error === 'not_yours', JSON.stringify(notYours.json));

    const stillThere = await api('GET', '/api/llm-notes', { user: userB });
    check('...and the refused delete really did nothing',
      (stillThere.json?.notes?.[TAG] ?? []).some((e) => e.id === noteId),
      JSON.stringify(stillThere.json?.notes?.[TAG]));

    const ghost = await api('DELETE',
      `/api/llm-notes/note_nothinghere?model=${encodeURIComponent(TAG)}`, { user: userA });
    check('deleting an unknown note is 404, not a crash', ghost.status === 404, `got ${ghost.status}`);

    // The owner may remove anyone's, which is the same rule every other
    // destructive route here follows.
    const byOwner = await api('DELETE',
      `/api/llm-notes/${encodeURIComponent(noteId)}?model=${encodeURIComponent(TAG)}`,
      { user: OWNER });
    check('the owner can delete somebody else\'s note', byOwner.status === 200,
      JSON.stringify(byOwner.json));

    const gone = await api('GET', '/api/llm-notes', { user: userA });
    check('...and the model drops out of the board once its last note goes',
      !(gone.json?.notes ?? {})[TAG], JSON.stringify(gone.json?.notes));

    // An author deleting their own, the ordinary path.
    const mine = await api('POST', '/api/llm-notes', {
      user: userA, body: { model: TAG, text: 'mine to remove' },
    });
    const removedByAuthor = await api('DELETE',
      `/api/llm-notes/${encodeURIComponent(mine.json?.entry?.id)}?model=${encodeURIComponent(TAG)}`,
      { user: userA });
    check('an author can delete their own note', removedByAuthor.status === 200,
      JSON.stringify(removedByAuthor.json));

    const wrongMethod = await api('PUT', '/api/llm-notes', { user: userA, body: {} });
    check('PUT /api/llm-notes is 405', wrongMethod.status === 405, `got ${wrongMethod.status}`);
  }
  // ── 3. tag variants ──
  console.log('\ntag search — variant selection');
  {
    const info = await api('GET', '/api/tags/info');
    if (!info.json?.loaded) {
      console.log('  SKIP  tag variants — tag database not loaded on this box (run: npm run update-tags)');
    } else {
      // The negative-prompt cleanup asks the database "is this a real tag" and
      // compares in spaces, while the rows are underscored. When those two
      // disagreed, every multi-word tag looked invented and multiple_girls —
      // 1.5 million posts — got dropped from a negative as a hallucination.
      // Caught only by running a real generate; the unit test's stub was more
      // forgiving than the real lookup and hid it.
      {
        const { createTagStore } = await import('../server/tags.mjs');
        const root = process.cwd();
        const cfg = YAML.parse(readFileSync(path.join(root, 'config/server.yaml'), 'utf8'));
        const store = createTagStore(root, cfg, { warn() {} });
        const under = store.postCount('multiple_girls');
        const spaced = store.postCount('multiple girls');
        check('postCount finds an underscored tag', under > 0, String(under));
        check('and the same tag written with a space', spaced === under, spaced + ' vs ' + under);
        check('an invented tag reports zero posts', store.postCount('floating_mouth') === 0);
        store.close();
      }

      const models = await api('GET', '/api/models');
      const all = models.json?.models ?? [];
      const underscoreModel = all.find((m) => m.tag_style === 'underscore');
      // Explicitly `space`, not "anything but underscore" — prose models have
      // no tag_style at all and would otherwise be picked up here depending on
      // registry order.
      const spaceModel = all.find((m) => m.tag_style === 'space');

      const byUnderscore = await api('GET', '/api/tags/search?q=purple&variant=underscore');
      check('variant=underscore returns purple_hair',
        byUnderscore.json?.results?.some((r) => r.tag === 'purple_hair'),
        JSON.stringify(byUnderscore.json?.results?.slice(0, 5)));

      const byDash = await api('GET', '/api/tags/search?q=purple&variant=dash');
      check('variant=dash returns purple-hair',
        byDash.json?.results?.some((r) => r.tag === 'purple-hair'),
        JSON.stringify(byDash.json?.results?.slice(0, 5)));

      if (!underscoreModel) {
        console.log('  SKIP  model-derived underscore variant — no model in the registry declares tag_style: underscore');
      } else {
        const byModel = await api('GET', `/api/tags/search?q=purple&model=${encodeURIComponent(underscoreModel.key)}`);
        check(`a model with tag_style: underscore gets the underscore spelling`,
          byModel.json?.results?.some((r) => r.tag === 'purple_hair'),
          JSON.stringify(byModel.json?.results?.slice(0, 5)));
      }

      // `space` is synthetic — served out of the underscore rows, because the
      // dash list cannot be converted back. See the note in server/tags.mjs.
      const bySpace = await api('GET', '/api/tags/search?q=purple&variant=space');
      check('variant=space returns "purple hair"',
        bySpace.json?.results?.some((r) => r.tag === 'purple hair'),
        JSON.stringify(bySpace.json?.results?.slice(0, 5)));

      // The reason it must come from underscore rather than dash. A hyphen
      // inside a word and a word separator are the same character in the dash
      // list, so converting that list would give "t shirt" and "two tone
      // hair". These two assertions are the whole argument.
      const shirt = await api('GET', '/api/tags/search?q=t-shirt&variant=space');
      check('a word-internal hyphen survives: t-shirt stays "t-shirt"',
        shirt.json?.results?.some((r) => r.tag === 't-shirt'),
        JSON.stringify(shirt.json?.results?.slice(0, 5)));

      const twoTone = await api('GET', '/api/tags/search?q=two-tone hair&variant=space');
      check('separator and hyphen are told apart: "two-tone hair"',
        twoTone.json?.results?.some((r) => r.tag === 'two-tone hair'),
        JSON.stringify(twoTone.json?.results?.slice(0, 5)));

      // Typed with a space, matched against underscored rows.
      const typedSpace = await api('GET', '/api/tags/search?q=purple ha&variant=space');
      check('a query typed with a space matches the underscored row',
        typedSpace.json?.results?.some((r) => r.tag === 'purple hair'),
        JSON.stringify(typedSpace.json?.results?.slice(0, 5)));

      // The same forgiveness, for the underscore models. This was asymmetric
      // until 21 Aug: the normalisation was keyed on whether the model wanted
      // spaces, so Pony accepted both spellings while Illustrious returned
      // NOTHING for "purple hair" — the spelling a person types by habit.
      // Nothing was lost by fixing it: stored underscore rows never contain a
      // literal space, so a spaced query could only ever match zero rows.
      const typedSpaceUnderscore = await api('GET', '/api/tags/search?q=purple ha&variant=underscore');
      check('a space typed against an underscore model still finds the tag',
        typedSpaceUnderscore.json?.results?.some((r) => r.tag === 'purple_hair'),
        JSON.stringify(typedSpaceUnderscore.json?.results?.slice(0, 5)));

      // Both spellings must land on the same row, either way round.
      const uUnderscore = await api('GET', '/api/tags/search?q=purple_ha&variant=underscore');
      check('and typing the underscore directly is unchanged',
        uUnderscore.json?.results?.some((r) => r.tag === 'purple_hair'),
        JSON.stringify(uUnderscore.json?.results?.slice(0, 5)));

      // The hyphen argument again, on the underscore side: normalising spaces
      // must not touch a word-internal hyphen.
      const seeThrough = await api('GET', '/api/tags/search?q=see-through&variant=underscore');
      check('a word-internal hyphen is untouched on the underscore side',
        seeThrough.json?.results?.some((r) => r.tag === 'see-through_clothes'),
        JSON.stringify(seeThrough.json?.results?.slice(0, 5)));

      // Aliases are what make the box usable for someone who does not know
      // the danbooru spelling, and they run through the same needle.
      const alias = await api('GET', '/api/tags/search?q=boobs&variant=underscore');
      check('alias matching survives the normalisation: boobs finds breasts',
        alias.json?.results?.some((r) => r.tag === 'breasts'),
        JSON.stringify(alias.json?.results?.slice(0, 5)));
      if (!spaceModel) {
        console.log('  SKIP  model-derived space variant — no model in the registry declares tag_style: space');
      } else {
        const byModel = await api('GET', `/api/tags/search?q=purple&model=${encodeURIComponent(spaceModel.key)}`);
        check(`a model with tag_style: space gets the spaced spelling`,
          byModel.json?.results?.some((r) => r.tag === 'purple hair'),
          JSON.stringify(byModel.json?.results?.slice(0, 5)));
        check(`...and no longer gets the dash spelling`,
          !byModel.json?.results?.some((r) => r.tag === 'purple-hair'),
          JSON.stringify(byModel.json?.results?.slice(0, 5)));
      }
    }
  }
} finally {
  // Clean up anything left over from a failed assertion above.
  for (const { user, id } of createdIds) {
    await api('DELETE', `/api/library/${id}`, { user }).catch(() => {});
  }
  app.kill();

  // The API has no way to remove a user directory, and a leftover empty
  // testrunner_* would otherwise sit there forever. One removal covers it now
  // that the server writes everything under DATA_DIR — including the users
  // directory, which PROMPTFORGE_DATA_DIR moves along with the rest of the
  // subtree.
  rmSync(DATA_DIR, { recursive: true, force: true });
}


// ── deprecated tags ──────────────────────────────────────────
//
// The owner's report was "remove useless tags that are used 0 times or
// mistyped", and the first look at the database said there were none: 181,714
// rows, minimum post_count 50. Both facts were true and the conclusion was
// wrong.
//
// Danbooru DEPRECATES tags — misspellings, retired names, ones that got split
// — and zeroes their post count when it does. Our CSV is a snapshot from
// before that, so a deprecated tag still carries the count it had while it was
// alive. Measured 26 Aug 2026: 4,042 deprecated on danbooru, 398 of them here,
// including `black_footwear` at 284,390, `topless` at 72,862 and `night_sky`
// at 54,987 — all sitting at the TOP of autocomplete for their prefix.
{
  const { fetchDeprecated, markDeprecated, applyDeprecations, hasDeprecatedColumn } =
    await import('../server/deprecations.mjs');
  const { DatabaseSync } = await import('node:sqlite');

  // A throwaway database with the shape the importer builds.
  const build = (withColumn) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tags (
        tag TEXT NOT NULL, variant TEXT NOT NULL, category INTEGER NOT NULL,
        post_count INTEGER NOT NULL, aliases TEXT
        ${withColumn ? ', deprecated INTEGER NOT NULL DEFAULT 0' : ''}
      );
    `);
    const ins = db.prepare('INSERT INTO tags (tag, variant, category, post_count, aliases) VALUES (?,?,?,?,?)');
    for (const [tag, count] of [['black_footwear', 284390], ['black_shirt', 209036], ['purple_hair', 641566]]) {
      ins.run(tag, 'underscore', 0, count, '');
      ins.run(tag.replace(/_/g, '-'), 'dash', 0, count, '');
    }
    return db;
  };

  // ── the fetch degrades ──
  {
    const dead = async () => { throw new Error('ENOTFOUND'); };
    const r = await fetchDeprecated({ fetchImpl: dead });
    check('no network means an empty set and a reason, not a throw',
      r.ok === false && r.names.size === 0 && /could not reach/.test(r.reason), JSON.stringify(r.reason));
  }
  {
    const rejecting = async () => ({ ok: false, status: 503 });
    const r = await fetchDeprecated({ fetchImpl: rejecting });
    check('a rejecting danbooru is reported rather than retried forever',
      r.ok === false && /503/.test(r.reason), r.reason);
  }
  {
    // A partial list is still worth having: filtering 1,000 of 4,042 beats
    // filtering none, and the caller is told it is partial.
    let call = 0;
    const flaky = async () => {
      call += 1;
      if (call === 1) return { ok: true, json: async () => Array.from({ length: 1000 }, (_, i) => ({ name: `t${i}` })) };
      return { ok: false, status: 500 };
    };
    const r = await fetchDeprecated({ fetchImpl: flaky });
    check('a partial list is kept and flagged as partial',
      r.ok === true && r.names.size === 1000 && /500/.test(r.reason), `${r.names.size} / ${r.reason}`);
  }
  {
    // A short page is the last page. Running on to the ceiling would be four
    // wasted requests at someone else's expense.
    let calls = 0;
    const short = async () => {
      calls += 1;
      return { ok: true, json: async () => [{ name: 'only_one' }] };
    };
    const r = await fetchDeprecated({ fetchImpl: short });
    check('a short page ends the paging rather than running to the ceiling',
      calls === 1 && r.names.size === 1, `${calls} calls`);
  }
  {
    const junk = async () => ({ ok: true, json: async () => [{ name: 'good' }, {}, { name: '' }, null] });
    const r = await fetchDeprecated({ fetchImpl: junk });
    check('rows with no usable name are skipped rather than poisoning the set',
      r.names.size === 1 && r.names.has('good'), [...r.names].join(','));
  }

  // ── applying them ──
  {
    const db = build(false);
    check('a fresh database has no column', hasDeprecatedColumn(db) === false);
    const { flagged, scanned } = applyDeprecations(db, new Set(['black_footwear']));
    check('...and applying adds one', hasDeprecatedColumn(db) === true);
    // changes() counts BOTH variant rows: a tag is deprecated as a tag, and
    // the underscore and spaced spellings are the same tag.
    check('both spellings of a tag are flagged', flagged === 2, String(flagged));
    const dash = db.prepare('SELECT deprecated FROM tags WHERE tag = ?').get('black-footwear');
    check('...including the DASH spelling, which is a different string',
      dash?.deprecated === 1, JSON.stringify(dash));
    check('...and the scanned count is tags, not rows', scanned === 1, String(scanned));
    const live = db.prepare('SELECT tag FROM tags WHERE deprecated = 0 AND variant = ?').all('underscore');
    check('live tags are untouched', live.length === 2, live.map((r) => r.tag).join(','));
    db.close();
  }
  {
    const db = build(true);
    const { flagged } = markDeprecated(db, new Set(['nothing_matches_this']));
    check('a name that is not in our database flags nothing and does not throw', flagged === 0);
    db.close();
  }
}

console.log('─'.repeat(58));
console.log(fail ? `${pass} passed, ${fail} FAILED\n` : `ALL PASSED (${pass})\n`);
process.exit(fail ? 1 : 0);
