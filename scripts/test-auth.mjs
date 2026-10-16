/**
 * Accounts, approval and the owner gate.
 *
 * The gate this covers is the one the whole feature exists for: a friend is
 * sent the URL, makes an account, and can do *nothing* until the owner
 * approves it. That claim is worth asserting rather than clicking through
 * once, because every part of it is silent when wrong — a pending account
 * that can still reach /api/models looks exactly like one that cannot until
 * someone checks.
 *
 * Specifically covered:
 *
 *   1. The blanket gate — no session, no /api/, on a route that has nothing
 *      to do with users.
 *   2. Owner bootstrap — the first registration of owner_username claims the
 *      box; nobody else can, and it cannot be claimed twice.
 *   3. Pending accounts are inert: cannot log in, cannot reach the API.
 *   4. Approval, and that it takes effect.
 *   5. Revocation killing a session that was already open, which is the part
 *      a cookie-expiry-only implementation gets wrong.
 *   6. That x-promptforge-user no longer overrides identity — the old header
 *      was the reason passwords were added, so it must not still be a way in.
 *
 * Needs no Ollama, no model, no GPU: the server runs with
 * PROMPTFORGE_LLM_BACKEND=mock. Accounts are written to a throwaway directory
 * via PROMPTFORGE_USERS_DIR, so this never touches real data/users/.
 *
 * Run: npm run test-auth
 */
import { freePort } from './lib/freeport.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';

const APP_PORT = await freePort(8097);
const BASE = `http://127.0.0.1:${APP_PORT}`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
};

// Read the owner name where the server reads it, so this does not go stale
// the day config/server.yaml changes it.
const serverConfig = YAML.parse(readFileSync('config/server.yaml', 'utf8'));
const OWNER = serverConfig.owner_username;
if (!OWNER) throw new Error('config/server.yaml has no owner_username — cannot test the gate');

const USERS_DIR = mkdtempSync(path.join(tmpdir(), 'pf-auth-'));
// Everything else the server writes — the run counter above all, which this
// suite feeds every time it exercises a route that reaches a model. Without
// it the counts land in the live data/ and the owner's usage panel reports
// the test suite. See server/paths.mjs.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pf-auth-data-'));

/**
 * Node's fetch does not keep a cookie jar. Each "client" here is one, so a
 * test can hold several signed-in identities at once and prove they stay
 * separate.
 */
function client() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    clear() { cookie = null; },
    async call(method, p, { body, headers = {} } = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(`${BASE}${p}`, {
        method,
        headers: h,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
        const [pair] = c.split(';');
        if (pair.startsWith('pf_session=')) {
          cookie = pair.endsWith('=') ? null : pair;
        }
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON is a failure the caller asserts on */ }
      return { status: res.status, json, text };
    },
  };
}

const app = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_LLM_BACKEND: 'mock',
    PROMPTFORGE_AUTH: 'on',
    PROMPTFORGE_USERS_DIR: USERS_DIR,
    PROMPTFORGE_DATA_DIR: DATA_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
app.stdout.on('data', (d) => {
  if (/listening on/i.test(String(d))) booted = true;
});
app.stderr.on('data', (d) => process.stderr.write(String(d)));

async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    if (booted) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function shutdown() {
  app.kill();
  try { rmSync(USERS_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

try {
  if (!(await waitForBoot())) throw new Error('server did not start');

  console.log('\nAccounts, approval and the owner gate');
  console.log('─'.repeat(58));

  const owner = client();
  const friend = client();
  const stranger = client();

  // friendo's password changes when the reset section runs; later sections
  // sign in with whatever is current rather than the original literal.
  let FRIEND_PW = 'friend-password-1';

  // ── 1. the blanket gate ──────────────────────────────────
  console.log('\nthe gate');
  {
    const r = await stranger.call('GET', '/api/models');
    check('an unauthenticated request to /api/models is refused', r.status === 401, `got ${r.status}`);
    check('...as unauthenticated, not as a crash', r.json?.error === 'unauthenticated', JSON.stringify(r.json));

    const health = await stranger.call('GET', '/health');
    check('/health stays reachable — it is how you tell the box is up', health.status === 200);

    const me = await stranger.call('GET', '/api/auth/me');
    check('/api/auth/me is reachable without a session', me.status === 200);
    check('...and reports nobody signed in', me.json?.authenticated === false);
    check('...and reports the owner has not registered yet', me.json?.owner_registered === false);
  }

  // ── 2. owner bootstrap ───────────────────────────────────
  console.log('\nowner bootstrap');
  {
    const r = await owner.call('POST', '/api/auth/register', {
      body: { username: OWNER, password: 'owner-password-1', display_name: 'The Owner' },
    });
    check('the owner can register', r.status === 201, `got ${r.status} ${r.text.slice(0, 120)}`);
    check('...and is approved immediately', r.json?.user?.status === 'approved', JSON.stringify(r.json?.user));
    check('...and is flagged as the owner', r.json?.user?.is_owner === true);
    check('...and is signed in by that call', owner.cookie !== null);
    check('the password never comes back', r.json?.user?.password === undefined);

    const again = await stranger.call('POST', '/api/auth/register', {
      body: { username: OWNER, password: 'someone-elses-try' },
    });
    check('the owner name cannot be claimed twice', again.status === 409, `got ${again.status}`);
    check('...reported as username_taken', again.json?.error === 'username_taken');

    const me = await owner.call('GET', '/api/auth/me');
    check('the session identifies the owner', me.json?.user?.username === OWNER);
    check('...and now reports the owner is registered', me.json?.owner_registered === true);

    const models = await owner.call('GET', '/api/models');
    check('an approved session reaches /api/models', models.status === 200, `got ${models.status}`);
  }

  // ── 3. a pending account is inert ────────────────────────
  console.log('\na new account is pending and can do nothing');
  {
    const r = await friend.call('POST', '/api/auth/register', {
      body: {
        username: 'friendo',
        password: 'friend-password-1',
        display_name: 'Friendo',
        referral: 'so and so from discord gave me this',
      },
    });
    check('a friend can register', r.status === 201, `got ${r.status}`);
    check('...and lands in pending', r.json?.user?.status === 'pending', JSON.stringify(r.json?.user));
    check('...and is NOT signed in by registering', friend.cookie === null);

    const login = await friend.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: 'friend-password-1' },
    });
    check('a pending account cannot log in', login.status === 403, `got ${login.status}`);
    check('...and is told why', login.json?.error === 'account_pending', JSON.stringify(login.json));
    check('...and gets no session', friend.cookie === null);

    const models = await friend.call('GET', '/api/models');
    check('a pending account cannot reach the API', models.status === 401, `got ${models.status}`);
  }

  // ── 4. bad credentials and validation ────────────────────
  console.log('\ncredentials');
  {
    const wrong = await stranger.call('POST', '/api/auth/login', {
      body: { username: OWNER, password: 'not-the-password' },
    });
    check('a wrong password is refused', wrong.status === 401, `got ${wrong.status}`);
    check('...as bad_password', wrong.json?.error === 'bad_password', JSON.stringify(wrong.json));

    // A passwordless model was tried and rejected because this succeeded:
    // a username alone must never be enough to become someone.
    const none = await stranger.call('POST', '/api/auth/login', { body: { username: OWNER } });
    check('a username with no password does not sign you in', none.status === 401, `got ${none.status}`);
    check('...and no session is issued', stranger.cookie === null);

    const missing = await stranger.call('POST', '/api/auth/login', {
      body: { username: 'nobody-at-all', password: 'whatever-here' },
    });
    check('an unknown username is refused', missing.status === 401, `got ${missing.status}`);

    const badName = await stranger.call('POST', '/api/auth/register', {
      body: { username: '../escape', password: 'long-enough-1' },
    });
    check('a username that would escape the data directory is refused', badName.status === 400, `got ${badName.status}`);

    const shortPw = await stranger.call('POST', '/api/auth/register', {
      body: { username: 'shorty', password: 'abc' },
    });
    check('a too-short password is refused', shortPw.status === 400, `got ${shortPw.status}`);
    check('...naming the actual minimum', /8 characters/.test(shortPw.json?.message ?? ''), shortPw.json?.message);

    // Used by the removal section further down.
    const spare = await stranger.call('POST', '/api/auth/register', {
      body: { username: 'someone-else', password: 'spare-password-1' },
    });
    check('a spare account registers cleanly', spare.status === 201, `got ${spare.status}`);

    // No email is collected anywhere — that is the point of owner-issued
    // resets, so assert nothing ever asks for one.
    check('registration stores no email field', spare.json?.user?.email === undefined);
  }

  // ── 4b. owner-issued password reset, in place of email ───
  console.log('\npassword reset (the reason no email is collected)');
  {
    const before = await friend.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });
    check('the friend can sign in with their own password first', before.status === 403 || before.status === 200,
      `got ${before.status}`);

    const reset = await owner.call('POST', '/api/admin/users/friendo/reset');
    check('the owner can reset a password', reset.status === 200, `got ${reset.status} ${reset.text.slice(0, 120)}`);
    check('...and is handed the new one exactly once',
      typeof reset.json?.password === 'string' && reset.json.password.length >= 16,
      JSON.stringify(reset.json?.password));
    check('...which is not echoed back as a hash', reset.json?.user?.password === undefined);

    const temp = reset.json.password;
    const old = await stranger.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });
    check('the old password stops working', old.status === 401, `got ${old.status}`);

    // friendo is still pending at this point, so a correct password gets 403
    // rather than 200 — which is itself the proof that the new one verified.
    const withTemp = await stranger.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: temp },
    });
    check('the temporary password verifies', withTemp.status === 403, `got ${withTemp.status}`);
    check('...reaching the approval check rather than being rejected as wrong',
      withTemp.json?.error === 'account_pending', JSON.stringify(withTemp.json));

    const nobody = await owner.call('POST', '/api/admin/users/never-existed/reset');
    check('resetting an account that does not exist is 404', nobody.status === 404, `got ${nobody.status}`);

    // Put friendo back on a known password for the sections below.
    const again = await owner.call('POST', '/api/admin/users/friendo/reset');
    FRIEND_PW = again.json.password;
    check('a second reset issues a different password', again.json?.password !== temp);
  }

  // ── 5. the admin surface ─────────────────────────────────
  console.log('\nthe admin surface');
  {
    const list = await owner.call('GET', '/api/admin/users');
    check('the owner can list accounts', list.status === 200, `got ${list.status}`);
    const friendo = (list.json?.users ?? []).find((u) => u.username === 'friendo');
    check('...and sees the pending account', friendo?.status === 'pending');
    check('...including what they typed in the referral box',
      friendo?.referral === 'so and so from discord gave me this', friendo?.referral);
    check('no password hash reaches the admin list',
      (list.json?.users ?? []).every((u) => u.password === undefined));

    const anon = await stranger.call('GET', '/api/admin/users');
    check('an unauthenticated caller is refused the admin list', anon.status === 401, `got ${anon.status}`);

    const spoof = await stranger.call('GET', '/api/admin/users', {
      headers: { 'x-promptforge-user': OWNER },
    });
    check('the old x-promptforge-user header no longer opens the admin surface',
      spoof.status === 401, `got ${spoof.status} — the header still works, which is the bug this feature exists to fix`);
  }

  // ── 6. approval takes effect ─────────────────────────────
  console.log('\napproval');
  {
    const ok = await owner.call('POST', '/api/admin/users/friendo/approve');
    check('the owner can approve', ok.status === 200, `got ${ok.status} ${ok.text.slice(0, 120)}`);
    check('...and the account is approved', ok.json?.user?.status === 'approved');
    check('...recording who decided it', ok.json?.user?.decided_by === OWNER);

    const login = await friend.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });
    check('the friend can now sign in', login.status === 200, `got ${login.status}`);
    check('...and has a session', friend.cookie !== null);

    const models = await friend.call('GET', '/api/models');
    check('...and can reach the API', models.status === 200, `got ${models.status}`);

    const admin = await friend.call('GET', '/api/admin/users');
    check('an approved non-owner still cannot reach the admin surface', admin.status === 403, `got ${admin.status}`);

    const reload = await friend.call('POST', '/api/prompts/reload');
    check('...nor reload prompts', reload.status === 403, `got ${reload.status}`);

    // Queue reordering is an override, not a fairness mechanism: an override
    // everyone holds is just a race to click first. Gated by the same blanket
    // /api/admin/ check, so hiding the button is not what enforces it.
    const jump = await friend.call('POST', '/api/admin/queue/move', {
      body: { id: 1, direction: 'front' },
    });
    check('...nor move themselves up the queue', jump.status === 403, `got ${jump.status}`);
    check('...and is told why rather than 404ing', /owner/i.test(jump.json?.message ?? ''),
      JSON.stringify(jump.json));
  }

  // ── 7. identity comes from the session, not the header ───
  console.log('\nidentity cannot be spoofed by header');
  {
    const saved = await friend.call('POST', '/api/library', {
      headers: { 'x-promptforge-user': OWNER },
      body: {
        title: 'header spoof attempt',
        model: 'illustrious',
        brief: 'test',
        segments: [{ label: 'Positive prompt', body: 'a cat' }],
      },
    });
    check('a save succeeds', saved.status === 201, `got ${saved.status}`);
    check('...and is filed under the session user, not the header',
      saved.json?.entry?.user === 'friendo' || saved.json?.user === 'friendo',
      JSON.stringify(saved.json).slice(0, 200));

    const ownerList = await owner.call('GET', '/api/library');
    const leaked = (ownerList.json?.entries ?? ownerList.json ?? []).some?.(
      (e) => e.title === 'header spoof attempt'
    );
    check('the entry did not land in the owner library', leaked !== true);
  }

  // ── 8. revocation kills a live session ───────────────────
  console.log('\nrevocation');
  {
    const before = await friend.call('GET', '/api/models');
    check('the friend session is live before revocation', before.status === 200);

    // Deny doubles as revoke: there is deliberately no separate "disable",
    // because it would reach the same end state by a different name.
    const off = await owner.call('POST', '/api/admin/users/friendo/deny');
    check('deny revokes an already-approved account', off.status === 200, `got ${off.status}`);
    check('...and it reads as denied', off.json?.user?.status === 'denied');

    const after = await friend.call('GET', '/api/models');
    check('the already-open session stops working immediately', after.status === 401, `got ${after.status}`);

    const relogin = await friend.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });
    check('a denied account cannot log back in', relogin.status === 403, `got ${relogin.status}`);
    check('...and is told why', relogin.json?.error === 'account_denied', JSON.stringify(relogin.json));

    const back = await owner.call('POST', '/api/admin/users/friendo/approve');
    check('approve restores a denied account', back.status === 200 && back.json?.user?.status === 'approved');

    const gone = await owner.call('POST', '/api/admin/users/friendo/disable');
    check('disable is no longer an action at all', gone.status === 400, `got ${gone.status}`);
    check('...reported as unknown_action', gone.json?.error === 'unknown_action', JSON.stringify(gone.json));
  }

  // ── 7b. presence ─────────────────────────────────────────
  console.log('\nwho is online');
  {
    // The friend was signed in and hitting the API in the section above, so
    // both should be present. Presence is "made a request recently", not
    // "holds a session" — a 30-day session would otherwise report someone who
    // closed the tab a fortnight ago.
    const s = await owner.call('GET', '/api/status');
    const online = s.json?.presence?.online ?? [];
    const names = online.map((u) => u.username);

    check('status reports presence', Array.isArray(online), JSON.stringify(s.json?.presence));
    check('...including the caller', names.includes(OWNER), names.join(','));
    check('...and the friend who just made requests', names.includes('friendo'), names.join(','));
    check('...telling the caller which one they are', s.json?.presence?.you === OWNER);
    check('...with a freshness figure per person',
      online.every((u) => typeof u.seconds_ago === 'number'), JSON.stringify(online));
    check('no password hash rides along in presence',
      online.every((u) => u.password === undefined));

    // Nobody who never signed in should appear, session or not.
    check('a stranger who never signed in is not present', !names.includes('nobody-at-all'));
  }

  // ── 7c. your own account: display name and preferences ───
  console.log('\nyour account');
  {
    const anon = await stranger.call('GET', '/api/account');
    check('/api/account needs a session', anon.status === 401, `got ${anon.status}`);

    const got = await owner.call('GET', '/api/account');
    check('the owner can read their account', got.status === 200, `got ${got.status}`);
    check('...with preferences attached', typeof got.json?.preferences === 'object');
    check('...and no password hash', got.json?.user?.password === undefined);

    const named = await owner.call('POST', '/api/account', {
      body: { display_name: '  The Boss  ' },
    });
    check('display name can be changed', named.status === 200, `got ${named.status}`);
    check('...and is trimmed', named.json?.user?.display_name === 'The Boss',
      JSON.stringify(named.json?.user?.display_name));

    const blank = await owner.call('POST', '/api/account', { body: { display_name: '   ' } });
    check('a blank display name is refused', blank.status === 400, `got ${blank.status}`);

    // The username is the directory name and the key everything hangs off, so
    // it must not be settable through here even if someone sends it.
    await owner.call('POST', '/api/account', { body: { username: 'someone-new' } });
    const after = await owner.call('GET', '/api/account');
    check('username cannot be changed through /api/account',
      after.json?.user?.username === OWNER, after.json?.user?.username);

    // Asked of the running registry rather than named. Pinned to 'pony' until
    // 2 Sep 2026; when pony was removed from config/models.yaml the write path
    // correctly rejected it and this read as a bug in preferences saving.
    const someModel = ((await owner.call('GET', '/api/models')).json?.models ?? [])
      .map((m) => m.key)
      .find((k) => k !== 'illustrious') ?? 'illustrious';
    const prefs = await owner.call('POST', '/api/account', {
      body: { preferences: { default_model: someModel } },
    });
    check('preferences save', prefs.status === 200, `got ${prefs.status}`);
    check('...the default model stuck', prefs.json?.preferences?.default_model === someModel,
      JSON.stringify(prefs.json?.preferences));

    // One default across both groups, not one per type: a video model is a
    // perfectly good thing to open on, and the frontend derives the tab from
    // the model rather than storing it twice.
    const video = await owner.call('POST', '/api/account', {
      body: { preferences: { default_model: 'ltx' } },
    });
    check('a video model is a valid default', video.json?.preferences?.default_model === 'ltx',
      JSON.stringify(video.json?.preferences));

    // A model can be dropped from models.yaml; a saved default pointing at
    // one that no longer exists would otherwise select nothing on load.
    const junk = await owner.call('POST', '/api/account', {
      body: { preferences: { default_model: 'no-such-model' } },
    });
    check('an unknown model is rejected rather than stored',
      junk.json?.preferences?.default_model === 'ltx',
      JSON.stringify(junk.json?.preferences));

    // Preferences that belong to unbuilt phases are dropped rather than
    // stored, so no control is ever offered for something that does nothing.
    // chat_temperature is no longer one of them — chat reads it and the
    // account panel sets it — so it rides along here as the contrast.
    // `theme` was the example here until 26 Aug 2026, when it stopped being
    // one: there are seven now. keep_datasets_by_default took its place —
    // Tab 2 is built against the stub backend and has no dataset flow, so
    // nothing offers it and storing it would mean a control that does nothing.
    await owner.call('POST', '/api/account', {
      body: { preferences: { chat_temperature: 0.99, keep_datasets_by_default: true } },
    });
    const dropped = await owner.call('GET', '/api/account');
    check('a preference for an unbuilt phase is not persisted',
      dropped.json?.preferences?.keep_datasets_by_default !== true,
      JSON.stringify(dropped.json?.preferences?.keep_datasets_by_default));
    // And a theme, which now has seven of them, is.
    await owner.call('POST', '/api/account', { body: { preferences: { theme: 'gruvbox' } } });
    const themed = await owner.call('GET', '/api/account');
    check('...while a colour scheme, which now exists, is kept',
      themed.json?.preferences?.theme === 'gruvbox',
      JSON.stringify(themed.json?.preferences?.theme));
    // A palette with no CSS behind it would render an unstyled page while
    // claiming to be a theme — the same failure as an unbacked language.
    await owner.call('POST', '/api/account', { body: { preferences: { theme: 'chartreuse' } } });
    const badTheme = await owner.call('GET', '/api/account');
    check('...and one with no palette behind it is dropped',
      badTheme.json?.preferences?.theme === 'gruvbox',
      JSON.stringify(badTheme.json?.preferences?.theme));
    check('...but chat temperature, which chat reads, is',
      dropped.json?.preferences?.chat_temperature === 0.99,
      JSON.stringify(dropped.json?.preferences?.chat_temperature));

    // Out of range is dropped rather than clamped, so a hand-rolled request
    // asking for 4.0 does not come back looking like it was honoured.
    await owner.call('POST', '/api/account', {
      body: { preferences: { chat_temperature: 4 } },
    });
    const tooHot = await owner.call('GET', '/api/account');
    check('a chat temperature past the top of the band is dropped',
      tooHot.json?.preferences?.chat_temperature === 0.99,
      JSON.stringify(tooHot.json?.preferences?.chat_temperature));

    // ── language, and the gap that made it worth splitting out ──
    //
    // DEFAULT_PREFS in server/storage.mjs defined seven preferences and the
    // validator accepted four. The three left out returned 200 and stored
    // nothing — deliberate, documented, and a trap: adding a key needs an
    // edit in two files, and forgetting the second fails in the direction
    // that looks like success. The loop below is the guard, and it is the
    // reason UNACCEPTED is an exported list rather than a comment.
    {
      const langSet = await owner.call('POST', '/api/account', {
        body: { preferences: { language: 'fr' } },
      });
      check('a language reaches the account',
        langSet.json?.preferences?.language === 'fr',
        JSON.stringify(langSet.json?.preferences?.language));

      const stuck = await owner.call('GET', '/api/account');
      check('...and survives the round trip, so it follows to another device',
        stuck.json?.preferences?.language === 'fr',
        JSON.stringify(stuck.json?.preferences?.language));

      // A language with no dictionary would render an untranslated interface
      // while claiming to be in that language, which is worse than English.
      await owner.call('POST', '/api/account', {
        body: { preferences: { language: 'xx' } },
      });
      const bad = await owner.call('GET', '/api/account');
      check('a language with no dictionary is dropped rather than stored',
        bad.json?.preferences?.language === 'fr',
        JSON.stringify(bad.json?.preferences?.language));

      // The list the selector is built from and the list the validator
      // enforces must be the same one, or the control offers a value that
      // silently does not save.
      const status = await owner.call('GET', '/api/status');
      check('/api/status serves the language list the validator enforces',
        Array.isArray(status.json?.languages) && status.json.languages.includes('fr'),
        JSON.stringify(status.json?.languages));
      for (const lang of status.json?.languages ?? []) {
        await owner.call('POST', '/api/account', { body: { preferences: { language: lang } } });
        const got = await owner.call('GET', '/api/account');
        check(`...and every language it offers actually saves (${lang})`,
          got.json?.preferences?.language === lang,
          JSON.stringify(got.json?.preferences?.language));
      }
    }


    // A theme written by an older version. DEFAULT_PREFS said theme: "dark"
    // until 26 Aug 2026, and setPrefs writes the whole merged object, so every
    // account that ever saved anything has it on disk - including the owner's,
    // which is where this was found. There is no [data-theme="dark"] palette,
    // so it rendered the default by accident; it would stop being an accident
    // the day someone adds a theme by that name.
    {
      const before = await owner.call("GET", "/api/account");
      const path0 = before.json?.preferences;
      check("a legacy theme value never survives to the client",
        ["midnight","lime","nord","dracula","gruvbox","tokyo","sakura","paper"].includes(path0?.theme),
        JSON.stringify(path0?.theme));
    }

    // Every key storage defines is either round-trippable or named as
    // unaccepted, with a reason. Written as a loop over DEFAULT_PREFS so the
    // next person to add a preference cannot repeat the original mistake:
    // add it to storage alone and this fails, naming the key.
    {
      const { UNACCEPTED } = await import('../server/preferences.mjs');
      // Taken from what the API actually returns rather than by instantiating
      // storage: getPrefs merges the stored file over DEFAULT_PREFS, so every
      // key is present here, and this checks the surface a client really sees
      // instead of a module's private constant.
      const defaults = (await owner.call('GET', '/api/account')).json?.preferences ?? {};
      check('the account exposes a preferences object with keys in it',
        Object.keys(defaults).length > 3, JSON.stringify(Object.keys(defaults)));

      // A value that differs from the default for each key, so "it saved" is
      // distinguishable from "it was already that".
      const probes = {
        // Any registry model that is not the default, so "it saved" stays
        // distinguishable from "it was already that" without naming one.
        default_model: ((await owner.call('GET', '/api/models')).json?.models ?? [])
          .map((m) => m.key)
          .find((k) => k !== (defaults.default_model ?? 'illustrious')) ?? 'illustrious',
        default_tagger: 'wd14_moat',
        // The non-default arm, so a save that did nothing is visible. Accepted
        // whether or not this box can actually run it — see the note in
        // server/preferences.mjs about why the validator does not gate on that.
        reference_analysis: 'llm',
        // The non-default arm again, and a different question from the one
        // above it despite the names — that decides who produces the tags,
        // this decides which surface the builder shows.
        reference_mode: 'tags',
        prompt_llm: '',
        chat_temperature: 0.42,
        language: 'de',
        force_search: 'always',
        keep_datasets_by_default: true,
        theme: 'nord',
        font: 'serif',
        text_size: 'large',
        tour: 'declined',
        custom_instruction: 'always frame it wide',
        // An object, unlike every other preference here — see the comparison
        // below, which had to stop using === for that reason.
        system_prompts: { illustrious: 'sys_probe' },
        // Per model, like system_prompts above. "Reasoning" because it is
        // what illustrious actually declares as its meta segment — a label
        // the model does not offer is dropped by the validator, which would
        // make this probe silently test nothing.
        omit_segments: { illustrious: ['Reasoning'] },
      };

      // `username` rides along in the preferences object as identity, not as
      // a setting — getPrefs returns { username, ...DEFAULT_PREFS } so the
      // caller knows whose these are. It is not something anyone sets.
      for (const key of Object.keys(defaults).filter((k) => k !== 'username')) {
        if (key in UNACCEPTED) {
          check(`${key} is documented as unaccepted rather than silently ignored`,
            typeof UNACCEPTED[key] === 'string' && UNACCEPTED[key].length > 10,
            UNACCEPTED[key]);
          continue;
        }
        check(`${key} has a probe value, so this loop actually tests it`,
          key in probes, 'add one to `probes` when adding a preference');
        if (!(key in probes)) continue;
        await owner.call('POST', '/api/account', { body: { preferences: { [key]: probes[key] } } });
        const got = await owner.call('GET', '/api/account');
        // Compared as JSON rather than with ===, because system_prompts is an
        // object and === on objects compares identity, which is never true
        // across a round trip. Scalars stringify to themselves, so this is
        // the same assertion for every other key.
        check(`${key} round-trips, so the control behind it is not lying`,
          JSON.stringify(got.json?.preferences?.[key]) === JSON.stringify(probes[key]),
          `sent ${JSON.stringify(probes[key])}, got ${JSON.stringify(got.json?.preferences?.[key])}`);
      }

      // The standing instruction is free text going into every prompt this
      // person generates, so its length is enforced server-side and not only
      // by the textarea.
      await owner.call('POST', '/api/account', {
        body: { preferences: { custom_instruction: 'x'.repeat(501) } },
      });
      const capped = await owner.call('GET', '/api/account');
      check('a standing instruction over the cap is refused, not truncated',
        capped.json?.preferences?.custom_instruction === 'always frame it wide',
        JSON.stringify(capped.json?.preferences?.custom_instruction)?.slice(0, 60));
      await owner.call('POST', '/api/account', {
        body: { preferences: { custom_instruction: '   ' } },
      });
      const cleared = await owner.call('GET', '/api/account');
      check('...and whitespace clears it, which is how you turn it off',
        cleared.json?.preferences?.custom_instruction === '');

      // This loop writes to every accepted key, and the assertions after it
      // are written against 0.99. Put it back rather than reordering them:
      // those tests are about the temperature validator specifically, and
      // they read better next to each other than split around this.
      await owner.call('POST', '/api/account', {
        body: { preferences: { chat_temperature: 0.99 } },
      });
    }

    // The string an <input> carries is not a number. The panel converts, but
    // the validator must not accept it either way, or the two disagree about
    // what was stored.
    await owner.call('POST', '/api/account', {
      body: { preferences: { chat_temperature: '0.3' } },
    });
    const asString = await owner.call('GET', '/api/account');
    check('a chat temperature sent as a string is dropped',
      asString.json?.preferences?.chat_temperature === 0.99,
      JSON.stringify(asString.json?.preferences?.chat_temperature));

    // Zero is a real setting — fully repeatable — and must survive the
    // falsy check that a looser validator would write.
    await owner.call('POST', '/api/account', {
      body: { preferences: { chat_temperature: 0 } },
    });
    const cold = await owner.call('GET', '/api/account');
    check('zero is a valid chat temperature, not a missing one',
      cold.json?.preferences?.chat_temperature === 0,
      JSON.stringify(cold.json?.preferences?.chat_temperature));

    // The slider reads its bounds from here. If they ever drift from what the
    // validator enforces, the control offers values that will not save.
    const statusForRange = await owner.call('GET', '/api/status');
    const band = statusForRange.json?.chat?.temperature_range;
    check('/api/status serves the band the slider is drawn from',
      band?.min === 0 && band?.max === 1.5 && typeof band?.step === 'number',
      JSON.stringify(band));

    // Per-user, like the library.
    const friendAcct = await friend.call('GET', '/api/account');
    check('another user has their own preferences',
      friendAcct.json?.preferences?.default_model !== 'ltx',
      JSON.stringify(friendAcct.json?.preferences?.default_image_model));
  }

  // ── 8a. changing your own password ───────────────────────
  //
  // The half that makes an owner-issued reset survivable: without this,
  // whatever the owner generated is what the person is stuck with.
  console.log('\nchanging your own password');
  {
    // The revocation section above dropped this client's session on purpose;
    // sign back in so this section is testing password changes rather than
    // re-testing the gate.
    const back = await friend.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });
    check('the friend is signed in again for this section', back.status === 200, `got ${back.status}`);

    const anon = await stranger.call('POST', '/api/account/password', {
      body: { current_password: 'x', new_password: 'yyyyyyyy' },
    });
    check('changing a password needs a session', anon.status === 401, `got ${anon.status}`);

    const wrong = await friend.call('POST', '/api/account/password', {
      body: { current_password: 'not-my-password', new_password: 'brand-new-password' },
    });
    check('the current password must be right', wrong.status === 401, `got ${wrong.status}`);
    check('...reported as bad_password', wrong.json?.error === 'bad_password');

    const short = await friend.call('POST', '/api/account/password', {
      body: { current_password: FRIEND_PW, new_password: 'abc' },
    });
    check('the new password is length-checked', short.status === 400, `got ${short.status}`);

    const ok = await friend.call('POST', '/api/account/password', {
      body: { current_password: FRIEND_PW, new_password: 'chosen-by-friendo' },
    });
    check('a friend can change their own password', ok.status === 200, `got ${ok.status} ${ok.text.slice(0, 120)}`);
    check('...and no hash comes back', ok.json?.user?.password === undefined);

    const stillWorks = await friend.call('GET', '/api/models');
    check('...and they stay signed in on that tab', stillWorks.status === 200, `got ${stillWorks.status}`);

    const oldPw = await stranger.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });
    check('the reset password the owner issued stops working', oldPw.status === 401, `got ${oldPw.status}`);

    FRIEND_PW = 'chosen-by-friendo';
    const newPw = await stranger.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });
    check('...and the one they chose works', newPw.status === 200, `got ${newPw.status}`);

    // A friend must not be able to reach an admin route by another name.
    const sneaky = await friend.call('POST', '/api/admin/users/jen/reset');
    check('a friend still cannot reset someone else', sneaky.status === 403 || sneaky.status === 404,
      `got ${sneaky.status}`);
  }

  // ── 8b. removal is destructive and frees the name ────────
  console.log('\nremoving an account');
  {
    const before = await owner.call('GET', '/api/admin/users');
    check('the throwaway account from the validation section is listed',
      (before.json?.users ?? []).some((u) => u.username === 'someone-else'));

    const gone = await owner.call('POST', '/api/admin/users/someone-else/remove');
    check('the owner can remove an account', gone.status === 200, `got ${gone.status}`);
    check('...and is told the library went with it', gone.json?.library_deleted === true);

    const after = await owner.call('GET', '/api/admin/users');
    check('...and it is no longer listed',
      !(after.json?.users ?? []).some((u) => u.username === 'someone-else'));

    const dir = path.join(USERS_DIR, 'someone-else');
    check('...and the directory is actually gone from disk', !existsSync(dir), dir);

    // Unlike deny, removal frees the name. Worth asserting because the two
    // actions look similar in the UI and behave differently here.
    const reused = await stranger.call('POST', '/api/auth/register', {
      body: { username: 'someone-else', password: 'a-fresh-password-1' },
    });
    check('the username can be registered again after removal', reused.status === 201, `got ${reused.status}`);

    const missing = await owner.call('POST', '/api/admin/users/never-existed/remove');
    check('removing an account that does not exist is 404, not a crash', missing.status === 404, `got ${missing.status}`);

    const ownerGone = await owner.call('POST', `/api/admin/users/${OWNER}/remove`);
    check('the owner account cannot be removed', ownerGone.status === 400, `got ${ownerGone.status}`);
    check('...naming the reason', ownerGone.json?.error === 'owner_immutable');
  }

  // ── 9. the owner cannot lock themselves out ──────────────
  console.log('\nthe owner account is protected');
  {
    const r = await owner.call('POST', `/api/admin/users/${OWNER}/deny`);
    check('the owner cannot deny the owner account', r.status === 400, `got ${r.status}`);
    check('...naming the reason', r.json?.error === 'owner_immutable', JSON.stringify(r.json));

    const still = await owner.call('GET', '/api/admin/users');
    check('the owner session still works afterwards', still.status === 200);
  }

  // ── 9b. delegated permissions ──────────────────
  //
  // Offload is the one admin route the owner can hand to a named account. The
  // thing worth asserting is the shape of the hole: it opens for exactly one
  // route, for exactly the account named, and closes again on revoke — the
  // failure that matters is a grant that quietly widens into the rest of
  // /api/admin/.
  console.log('\ndelegated offload permission');
  {
    // The friend was denied and re-approved above, which dropped the session.
    await friend.call('POST', '/api/auth/login', {
      body: { username: 'friendo', password: FRIEND_PW },
    });

    const before = await friend.call('POST', '/api/admin/models/unload', { body: { all: true } });
    check('without the grant, offload is refused', before.status === 403, `got ${before.status}`);
    check('...naming the permission rather than dead-ending on "owner only"',
      /offload/i.test(before.json?.message ?? ''), JSON.stringify(before.json));

    const nope = await friend.call('POST', '/api/admin/users/friendo/grant', {
      body: { grant: 'offload', on: true },
    });
    check('a friend cannot grant it to themselves', nope.status === 403, `got ${nope.status}`);

    const given = await owner.call('POST', '/api/admin/users/friendo/grant', {
      body: { grant: 'offload', on: true },
    });
    check('the owner can grant it', given.status === 200, `got ${given.status} ${given.text.slice(0, 120)}`);
    check('...and it is on the account', (given.json?.user?.grants ?? []).includes('offload'),
      JSON.stringify(given.json?.user));
    check('...recording who gave it', given.json?.user?.grants_changed_by === OWNER);

    const after = await friend.call('POST', '/api/admin/models/unload', { body: { all: true } });
    check('the grant opens offload for that account', after.status !== 403, `got 403: ${after.text.slice(0, 120)}`);

    // The whole point of a named grant rather than a role: it opens one door.
    const users = await friend.call('GET', '/api/admin/users');
    check('...and nothing else on the admin surface', users.status === 403, `got ${users.status}`);
    const keep = await friend.call('POST', '/api/admin/models/keep-alive', { body: { value: '5m' } });
    check('...not even keep_alive, which is the same panel', keep.status === 403, `got ${keep.status}`);

    // A second approved account, because `stranger` is signed in as friendo
    // by this point in the file and would inherit the grant correctly.
    const bystander = client();
    await bystander.call('POST', '/api/auth/register', {
      body: { username: 'bystander', password: 'bystander-password-1' },
    });
    await owner.call('POST', '/api/admin/users/bystander/approve');
    await bystander.call('POST', '/api/auth/login', {
      body: { username: 'bystander', password: 'bystander-password-1' },
    });
    const other = await bystander.call('POST', '/api/admin/models/unload', { body: { all: true } });
    check('granting one account grants only that account', other.status === 403, `got ${other.status}`);

    const bogus = await owner.call('POST', '/api/admin/users/friendo/grant', {
      body: { grant: 'everything', on: true },
    });
    check('an invented permission name is refused', bogus.status === 400, `got ${bogus.status}`);
    check('...reported as unknown_grant', bogus.json?.error === 'unknown_grant', JSON.stringify(bogus.json));

    const self = await owner.call('POST', `/api/admin/users/${OWNER}/grant`, {
      body: { grant: 'offload', on: false },
    });
    check('the owner cannot revoke it from themselves', self.status === 400, `got ${self.status}`);
    check('...reported as owner_immutable', self.json?.error === 'owner_immutable');
    const ownerStill = await owner.call('POST', '/api/admin/models/unload', { body: { all: true } });
    check('...and the owner can still offload', ownerStill.status !== 403);

    const taken = await owner.call('POST', '/api/admin/users/friendo/grant', {
      body: { grant: 'offload', on: false },
    });
    check('the owner can revoke it', taken.status === 200 && !(taken.json?.user?.grants ?? []).includes('offload'),
      JSON.stringify(taken.json?.user));

    const closed = await friend.call('POST', '/api/admin/models/unload', { body: { all: true } });
    check('...and it closes on the next request, without a re-login', closed.status === 403, `got ${closed.status}`);
    const stillIn = await friend.call('GET', '/api/models');
    check('...while leaving the session alone', stillIn.status === 200, `got ${stillIn.status}`);
  }

  // ── 10. logout ───────────────────────────────────────────
  console.log('\nlogout');
  // ── the Secure flag, for `tailscale serve` ──
  //
  // Direct http on the tailnet must NOT set it, or the cookie is never sent
  // and nobody can sign in. Behind a TLS proxy it must, and the only thing
  // that says which is happening is x-forwarded-proto. Both directions are
  // asserted, because getting either one wrong is a silent lockout or a
  // silent loosening.
  {
    const raw = async (headers) => {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ username: OWNER, password: 'owner-password-1' }),
      });
      await res.text();
      return (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pf_session=')) ?? '';
    };

    const plain = await raw({});
    check('plain http sets no Secure flag, or the cookie would never be sent',
      plain.includes('HttpOnly') && !/;\s*Secure/i.test(plain), plain);

    const proxied = await raw({ 'x-forwarded-proto': 'https' });
    check('behind a TLS proxy it does', /;\s*Secure/i.test(proxied), proxied);

    // Proxies chain the header. The first entry is what the browser spoke.
    const chained = await raw({ 'x-forwarded-proto': 'https, http' });
    check('...and a chained header reads the first hop', /;\s*Secure/i.test(chained), chained);

    // A clear that omits an attribute the set used writes a different cookie
    // rather than removing the one that exists, and the session survives the
    // sign-out.
    const clearing = await fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https', cookie: proxied.split(';')[0] },
    });
    await clearing.text();
    const cleared = (clearing.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pf_session=')) ?? '';
    check('clearing the cookie carries the same attributes as setting it',
      /;\s*Secure/i.test(cleared) && cleared.includes('HttpOnly') && cleared.includes('SameSite=Lax'),
      cleared);
  }

  // ── static files are ungated, so containment is the only guard ──
  //
  // The login page cannot render without its own CSS and JS, so serveStatic
  // runs before anyone has a session. That makes it the one unauthenticated
  // file read in the app, and the containment check is all that stands behind
  // it.
  //
  // The attack is percent-encoded on purpose. `new URL()` normalises a
  // literal `../` away before the router ever sees it, but `%2e%2e%2f`
  // survives normalisation and serveStatic's own decodeURIComponent turns it
  // back into `../` — so this really does reach path.resolve and really does
  // land outside web/. What used to let it through was the guard: a bare
  // startsWith(webRoot) accepts any sibling whose name simply begins with
  // "web". This creates exactly such a sibling rather than trusting that none
  // will ever exist.
  {
    const probeDir = path.resolve('web-traversal-probe');
    const probeFile = path.join(probeDir, 'secret.txt');
    try {
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(probeFile, 'if you can read this, containment failed', 'utf8');

      const escaped = await fetch(`${BASE}/%2e%2e%2fweb-traversal-probe%2fsecret.txt`);
      const body = await escaped.text();
      check('a sibling directory starting with "web" is not reachable',
        escaped.status === 403, `got ${escaped.status}`);
      check('...and its contents never reach the client',
        !body.includes('containment failed'), body.slice(0, 80));

      // The ordinary case still has to work, or the guard is just an outage.
      const ok = await fetch(`${BASE}/index.html`);
      check('...while the real web root is still served', ok.status === 200, `got ${ok.status}`);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }

  {
    const out = await owner.call('POST', '/api/auth/logout');
    check('logout succeeds', out.status === 200, `got ${out.status}`);
    check('...and clears the cookie', owner.cookie === null);

    owner.clear();
    const after = await owner.call('GET', '/api/admin/users');
    check('...and the session no longer works', after.status === 401, `got ${after.status}`);
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail === 0 ? `ALL PASSED (${pass})` : `${fail} FAILED, ${pass} passed`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  fail++;
} finally {
  shutdown();
}

process.exit(fail === 0 ? 0 : 1);
