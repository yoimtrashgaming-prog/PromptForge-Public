// Accounts, sessions, and the owner approval gate.
//
// Everyone has a password. Nobody has an email address.
//
// The spec's original model was "minimal, trust-based. No passwords", with
// tailnet membership as the whole of authentication. That was replaced
// because the owner wanted a real approval step — a friend is sent the URL,
// makes an account, and can do nothing until approved — and an approval gate
// built on a header the applicant can set is not a gate.
//
// A passwordless version was tried and rejected: without a secret, anyone
// could sign in as anyone else by typing their username, and saved prompt
// libraries would be separated by convention rather than enforcement.
//
// **No email is collected anywhere, deliberately.** In most systems an email
// address exists only to deliver a password reset link. Here the owner is the
// delivery mechanism: `resetPassword()` issues a temporary password, the owner
// reads it once and passes it on in chat. Nothing personal is stored — a
// username the person chose, a scrypt hash that cannot be reversed, and
// whatever free text they typed in the "how did you hear about us" box.
//
// The tailnet is still the security boundary, so there is deliberately no
// login rate limiting, no lockout and no CSRF machinery. What IS correct
// where it counts: scrypt with per-user salts, constant-time comparison,
// httpOnly cookies, and server-side enforcement on every route rather than a
// hidden button.
//
// Storage is one account.json per user under data/users/{username}/, beside
// the library that user already owns. No database, same reasoning as
// storage.mjs: five people, and a directory of JSON is inspectable and
// trivially backed up.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// ── password hashing ─────────────────────────────────────────
//
// Kept properly even though this is five friends on a private mesh: a
// password stored badly is worse than no password at all, because people
// reuse them elsewhere.
//
// scrypt from node:crypto rather than argon2id. Argon2 is the better KDF in
// the abstract, but every Node binding for it is a native module, and this
// project has three dependencies and moves between Windows and Linux on a
// flash drive. A native build step is a migration failure waiting to happen.
// scrypt is memory-hard, in the standard library, and far beyond adequate
// for a five-person tailnet app.
//
// Parameters are stored per-record, so raising them later does not
// invalidate existing passwords — an old hash keeps verifying with the
// parameters it was created under.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    // 128 * N * r is the scrypt working set: 16MB at these parameters. Node's
    // default maxmem is 32MB, so this fits, but state it rather than rely on
    // the default staying where it is.
    maxmem: 128 * params.N * params.r * 4,
  });
  return {
    algo: 'scrypt',
    ...params,
    salt: salt.toString('hex'),
    hash: key.toString('hex'),
  };
}

async function verifyPassword(password, rec) {
  if (!rec || rec.algo !== 'scrypt') return false;
  const params = {
    N: rec.N ?? SCRYPT.N,
    r: rec.r ?? SCRYPT.r,
    p: rec.p ?? SCRYPT.p,
    keylen: rec.keylen ?? SCRYPT.keylen,
  };
  let key;
  try {
    key = await scryptAsync(password, Buffer.from(rec.salt, 'hex'), params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 128 * params.N * params.r * 4,
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(rec.hash, 'hex');
  // Lengths must match before timingSafeEqual, which throws otherwise.
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

// ── validation ───────────────────────────────────────────────

/**
 * Usernames become directory names under data/users/, so the rule is the
 * same one storage.mjs enforces — but registration needs to say *why* a name
 * was refused rather than silently substituting a fallback.
 */
export function validateUsername(name) {
  const clean = String(name ?? '').trim().toLowerCase();
  if (!clean) return { ok: false, message: 'Pick a username.' };
  if (clean.length > 32) return { ok: false, message: 'Usernames are 32 characters or fewer.' };
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(clean)) {
    return {
      ok: false,
      message:
        'Usernames use lowercase letters, numbers, hyphens and underscores, and must start with a letter or number.',
    };
  }
  return { ok: true, username: clean };
}

/**
 * Deliberately lenient. A length floor catches the genuine accident — an
 * empty box, a stray keypress — and composition rules ("one capital, one
 * symbol") are well established to push people toward weaker, more
 * predictable passwords, not stronger ones. The tailnet is the boundary.
 */
export function validatePassword(password) {
  const pw = String(password ?? '');
  if (pw.length < 8) return { ok: false, message: 'Passwords need at least 8 characters.' };
  if (pw.length > 200) return { ok: false, message: 'Passwords are 200 characters or fewer.' };
  return { ok: true, password: pw };
}

const trimTo = (value, max) => String(value ?? '').trim().slice(0, max);

/**
 * A temporary password the owner reads off a screen and passes on in chat.
 * This is the whole of account recovery, and it is why the app collects no
 * email address: email exists in most systems only to deliver a reset link,
 * and here the owner is the delivery mechanism.
 *
 * No i/l/o/0/1 — this gets copied by hand and those get misread. Grouped in
 * fours for the same reason. 16 characters of a 31-symbol alphabet is ~79
 * bits, far more than a password with a short life needs.
 *
 * randomInt rather than randomBytes % length, which would bias the alphabet.
 */
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function temporaryPassword() {
  let out = '';
  for (let i = 0; i < 16; i++) out += TEMP_ALPHABET[randomInt(0, TEMP_ALPHABET.length)];
  return out.match(/.{1,4}/g).join('-');
}


// ── cookies ──────────────────────────────────────────────────

export const SESSION_COOKIE = 'pf_session';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// ── the store ────────────────────────────────────────────────

export function createAuth(rootDir, config) {
  const usersDir = path.resolve(rootDir, config.paths?.users ?? 'data/users');
  // A file, not a directory, so listAccounts() — which only looks at
  // directories — never mistakes it for a user. `_sessions` could not be a
  // username in any case: validateUsername refuses a leading underscore.
  const sessionsFile = path.join(usersDir, '_sessions.json');

  const authCfg = config.auth ?? {};
  const enabled = authCfg.enabled !== false;
  const ownerName = String(config.owner_username ?? '').toLowerCase();
  const sessionDays = Number(authCfg.session_days ?? 30);
  const SESSION_MS = Math.max(1, sessionDays) * 24 * 60 * 60 * 1000;

  mkdirSync(usersDir, { recursive: true });

  // ── accounts on disk ───────────────────────────────────────

  const accountFile = (username) => path.join(usersDir, username, 'account.json');

  function readAccount(username) {
    const file = accountFile(username);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      console.warn(`[auth] unreadable account record for ${username}`);
      return null;
    }
  }

  /** Write through a temp file so a crash mid-write cannot truncate an account. */
  function writeAccount(account) {
    const dir = path.join(usersDir, account.username);
    mkdirSync(dir, { recursive: true });
    const file = accountFile(account.username);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(account, null, 2), 'utf8');
    renameSync(tmp, file);
    return account;
  }

  function listAccounts() {
    if (!existsSync(usersDir)) return [];
    const out = [];
    for (const entry of readdirSync(usersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const acc = readAccount(entry.name);
      if (acc) out.push(acc);
    }
    // Pending first — that is the list the owner is opening this screen for —
    // then newest first within each group.
    const rank = (a) => (a.status === 'pending' ? 0 : 1);
    return out.sort(
      (a, b) => rank(a) - rank(b) || String(b.created_at).localeCompare(String(a.created_at))
    );
  }

  // The owner is whichever account carries is_owner, not the account named
  // owner_username. PR #1 let the first registration claim ownership under any
  // name, and a check that only read owner_username's record then answered
  // "no owner yet" forever on a fresh install - so every later registration
  // became an approved owner too. owner_username is now only the fast path.
  const findOwner = () => {
    const named = ownerName ? readAccount(ownerName) : null;
    if (named?.is_owner) return named;
    return listAccounts().find((a) => a.is_owner) ?? null;
  };
  const ownerExists = () => Boolean(findOwner());

  /** Never let a password record reach the frontend, even the owner's. */
  function publicAccount(acc) {
    if (!acc) return null;
    const { password, ...rest } = acc;
    // Always an array, even for records written before grants existed, so the
    // frontend never has to guard for undefined before asking what it holds.
    return { ...rest, grants: grantsOf(acc) };
  }

  // ── sessions ───────────────────────────────────────────────
  //
  // Persisted rather than memory-only so restarting the server does not sign
  // everyone out. The file is small — one line per active login.

  /** @type {Map<string, {username: string, created_at: string, expires_at: number}>} */
  const sessions = new Map();

  function loadSessions() {
    if (!existsSync(sessionsFile)) return;
    try {
      const raw = JSON.parse(readFileSync(sessionsFile, 'utf8'));
      const now = Date.now();
      for (const [token, s] of Object.entries(raw ?? {})) {
        if (s && Number(s.expires_at) > now) sessions.set(token, s);
      }
    } catch {
      console.warn('[auth] session file unreadable — starting with no active sessions');
    }
  }

  function saveSessions() {
    const tmp = `${sessionsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions), null, 2), 'utf8');
    renameSync(tmp, sessionsFile);
  }

  function newSession(username) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
      username,
      created_at: new Date().toISOString(),
      expires_at: Date.now() + SESSION_MS,
    });
    saveSessions();
    return token;
  }

  function dropSession(token) {
    if (!token || !sessions.has(token)) return false;
    sessions.delete(token);
    saveSessions();
    return true;
  }

  /** Every session belonging to a user, for when they are denied or disabled. */
  function dropSessionsFor(username) {
    let n = 0;
    for (const [token, s] of sessions) {
      if (s.username === username) {
        sessions.delete(token);
        n++;
      }
    }
    if (n) saveSessions();
    return n;
  }

  loadSessions();

  // ── operations ─────────────────────────────────────────────

  const fail = (statusCode, error, message) =>
    Object.assign(new Error(message), { statusCode, code: error });

  /**
   * Create an account. It lands in `pending` and can do nothing until the
   * owner approves it — with one bootstrap exception: if the owner has no
   * account yet, the first registration claims it, under any username, and
   * is approved immediately. Otherwise nobody could ever approve the first request.
   */
  async function register({ username, password, display_name, referral }) {
    const u = validateUsername(username);
    if (!u.ok) throw fail(400, 'invalid_username', u.message);

    if (readAccount(u.username)) {
      throw fail(409, 'username_taken', 'That username is already taken.');
    }

    const p = validatePassword(password);
    if (!p.ok) throw fail(400, 'invalid_password', p.message);

    // Bootstrap: the very first registration claims ownership regardless of
    // username, so a fresh install does not require knowing a pre-configured
    // owner name. Everyone after that lands in pending until approved.
    const claimingOwner = !ownerExists();
    const account = {
      username: u.username,
      display_name: trimTo(display_name, 60) || u.username,
      status: claimingOwner ? 'approved' : 'pending',
      is_owner: claimingOwner,
      // Free text from the registration form: "how did you hear about us".
      // Shown to the owner at the moment they decide, which is the whole
      // point of collecting it.
      referral: trimTo(referral, 500),
      created_at: new Date().toISOString(),
      decided_at: claimingOwner ? new Date().toISOString() : null,
      decided_by: claimingOwner ? u.username : null,
      last_login_at: null,
      password: await hashPassword(p.password),
    };
    // Checked again after the hash: two sign-ups racing on a fresh install
    // both saw "no owner" above, and only the first may keep the claim.
    if (claimingOwner && ownerExists()) {
      account.status = 'pending';
      account.is_owner = false;
      account.decided_at = null;
      account.decided_by = null;
    }
    writeAccount(account);
    return publicAccount(account);
  }

  async function login({ username, password }) {
    const u = validateUsername(username);
    const unknown = fail(401, 'unknown_account', 'No account with that username.');
    if (!u.ok) throw unknown;

    const account = readAccount(u.username);
    if (!account) throw unknown;
    if (!(await verifyPassword(password, account.password))) {
      throw fail(401, 'bad_password', 'That password is incorrect.');
    }

    if (account.status !== 'approved') {
      throw fail(403, `account_${account.status}`, statusMessage(account.status));
    }

    account.last_login_at = new Date().toISOString();
    writeAccount(account);
    return { account: publicAccount(account), token: newSession(account.username) };
  }

  function statusMessage(status) {
    if (status === 'pending') {
      return 'Your account is waiting to be approved by the owner.';
    }
    if (status === 'denied') return 'This account does not have access.';
    return 'This account cannot sign in.';
  }

  // ── presence ───────────────────────────────────────────────
  //
  // In memory on purpose. "Who is online" is a fact about right now, worth
  // nothing after a restart, and writing a timestamp to disk on every request
  // would be a lot of I/O for it. It also means the app keeps no history of
  // when anyone was using it, which is the correct default for a box the
  // owner does not want holding personal information.
  //
  // A session is not presence: sessions last 30 days, so someone who signed
  // in a fortnight ago and closed the tab still has one. This tracks the last
  // request actually made.

  /** @type {Map<string, number>} username → epoch ms of last request */
  const lastSeen = new Map();

  const PRESENCE_WINDOW_MS = 120000;

  /**
   * Everyone whose last request was recent enough to count as present. The
   * frontend polls /api/status every 10s, so an open tab keeps itself in this
   * list without doing anything — which is what "online" should mean here.
   */
  function onlineUsers(now = Date.now()) {
    const out = [];
    for (const [username, seen] of lastSeen) {
      if (now - seen > PRESENCE_WINDOW_MS) {
        lastSeen.delete(username);
        continue;
      }
      const account = readAccount(username);
      if (!account) continue;
      out.push({
        username,
        display_name: account.display_name || username,
        is_owner: Boolean(account.is_owner),
        seconds_ago: Math.round((now - seen) / 1000),
      });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
  }

  /**
   * Who is asking, from the session cookie. Returns null for anyone without a
   * valid session, and drops the session if the account was approved once but
   * has since been denied or removed — so revoking access takes effect on
   * the next request rather than whenever the cookie happens to expire.
   */
  function identify(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires_at <= Date.now()) {
      dropSession(token);
      return null;
    }
    const account = readAccount(session.username);
    if (!account || account.status !== 'approved') {
      dropSession(token);
      return null;
    }
    // Every gated request runs through here, so this is the one place that
    // sees all of them.
    lastSeen.set(account.username, Date.now());
    return { account, token };
  }

  /**
   * approve | deny, owner-only at the route layer.
   *
   * There is deliberately no separate "disable". It would produce the same end
   * state as deny — blocked from signing in — differing only in which state
   * the account came from, which is an implementation detail rather than
   * something the owner should have to choose between. Deny revokes an
   * approved account and rejects a pending one; approve restores either.
   */
  function decide(username, action, by) {
    const u = validateUsername(username);
    if (!u.ok) throw fail(400, 'invalid_username', u.message);
    const account = readAccount(u.username);
    if (!account) throw fail(404, 'not_found', `No account named ${u.username}.`);

    if (account.is_owner) {
      // The owner cannot lock themselves out of their own admin surface.
      throw fail(400, 'owner_immutable', 'The owner account cannot be changed here.');
    }

    const next = { approve: 'approved', deny: 'denied' }[action];
    if (!next) throw fail(400, 'unknown_action', `Unknown action "${action}".`);

    account.status = next;
    account.decided_at = new Date().toISOString();
    account.decided_by = by ?? null;
    writeAccount(account);

    // Losing approval must end any session already open.
    if (next !== 'approved') dropSessionsFor(account.username);

    return publicAccount(account);
  }

  // ── delegated permissions ────────────────────────────
  //
  // The admin surface belongs to the owner, with one exception the owner
  // asked for: offloading a model. It is the one admin action a friend has a
  // real reason to take — the card is shared with ComfyUI, and "give me the
  // GPU back" should not have to wait for the owner to be at a keyboard.
  //
  // A named-grant whitelist rather than roles. Five people and one delegable
  // action; a Set a route can check beats a hierarchy nobody will add a
  // second level to. keep_alive is deliberately NOT here — it is a standing
  // decision about a shared card that persists across restarts, where offload
  // is a momentary one that the next request undoes.
  //
  // `train` joined it 26 Sep 2026, at the owner's ask: Tab 2 (TrainFlow) is
  // hidden from everyone but the owner and the accounts he grants it to.
  //
  // `render` joined it 3 Oct 2026 (docs/render-plan.md): sending prompts to
  // ComfyUI takes the GPU for as long as a picture takes, so it is the
  // owner's to hand out.
  const GRANTS = new Set(['offload', 'train', 'render']);

  /** Only grants that still exist. A name removed from GRANTS stops counting. */
  const grantsOf = (acc) =>
    (Array.isArray(acc?.grants) ? acc.grants : []).filter((g) => GRANTS.has(g));

  /**
   * Does this account hold a permission?
   *
   * The owner holds every one implicitly and is never written a grants list,
   * so no edit to a file on disk can take their own admin surface away from
   * them. Approval is rechecked here even though identify() already refuses a
   * denied account: this is the last gate before a shared GPU gets taken.
   */
  function can(account, grant) {
    if (!account || account.status !== 'approved') return false;
    if (account.is_owner) return true;
    return grantsOf(account).includes(grant);
  }

  /**
   * Give or take one grant. Owner-only at the route layer, and deliberately
   * not itself delegable — whoever can hand out permissions is the owner.
   */
  function setGrant(username, grant, on, by) {
    const u = validateUsername(username);
    if (!u.ok) throw fail(400, 'invalid_username', u.message);
    if (!GRANTS.has(grant)) {
      throw fail(400, 'unknown_grant', `Unknown permission "${grant}".`);
    }
    const account = readAccount(u.username);
    if (!account) throw fail(404, 'not_found', `No account named ${u.username}.`);
    if (account.is_owner) {
      throw fail(400, 'owner_immutable', 'The owner already holds every permission.');
    }

    const held = new Set(grantsOf(account));
    if (on) held.add(grant);
    else held.delete(grant);
    account.grants = [...held];
    account.grants_changed_at = new Date().toISOString();
    account.grants_changed_by = by ?? null;
    writeAccount(account);
    // No session is dropped. A revoked grant is checked per request, so it
    // takes effect on the next click without signing anybody out.
    return publicAccount(account);
  }

  /**
   * Issue a temporary password for someone who is locked out.
   *
   * This is the app's entire account-recovery story, and it is deliberate:
   * collecting an email address purely to send reset links would mean holding
   * personal data about five friends, which the owner explicitly does not
   * want. Handing the owner a string to paste into chat achieves the same
   * thing and stores nothing.
   *
   * The plaintext is returned exactly once and never written to disk — only
   * the scrypt hash is stored, same as any other password. If the owner loses
   * it before passing it on, reset again.
   *
   * There is deliberately no "must change on next login" flow: that is a
   * state machine and a second UI for five people who can simply ask for
   * another reset.
   */
  async function resetPassword(username, by) {
    const u = validateUsername(username);
    if (!u.ok) throw fail(400, 'invalid_username', u.message);
    const account = readAccount(u.username);
    if (!account) throw fail(404, 'not_found', `No account named ${u.username}.`);

    const password = temporaryPassword();
    account.password = await hashPassword(password);
    account.password_reset_at = new Date().toISOString();
    account.password_reset_by = by ?? null;
    writeAccount(account);

    // Whoever holds the old password should stop being able to use it. This
    // includes the owner resetting their own — they will be signed out and
    // have to use the new one, which is the correct behaviour for a reset.
    dropSessionsFor(account.username);

    return { user: publicAccount(account), password };
  }

  /**
   * Change your own display name. The username is immutable — it is the
   * directory name under data/users/ and the key everything else hangs off,
   * so renaming it would mean moving a library and invalidating sessions for
   * no real gain. The display name is the part people actually see.
   */
  function updateDisplayName(username, displayName) {
    const account = readAccount(username);
    if (!account) throw fail(404, 'not_found', `No account named ${username}.`);
    const clean = trimTo(displayName, 60);
    if (!clean) throw fail(400, 'invalid_display_name', 'Pick a display name.');
    account.display_name = clean;
    writeAccount(account);
    return publicAccount(account);
  }

  /**
   * Change your own password. This is what makes an owner-issued reset a
   * complete story rather than a permanent sentence: the owner hands over a
   * generated string, and the person immediately replaces it with something
   * they will remember.
   *
   * The current password is required even though the caller already holds a
   * valid session — it costs nothing and means a walked-away-from screen
   * cannot be used to lock the real owner of the account out of it.
   */
  async function changePassword(username, { current_password, new_password }) {
    const account = readAccount(username);
    if (!account) throw fail(404, 'not_found', `No account named ${username}.`);

    if (!(await verifyPassword(current_password, account.password))) {
      throw fail(401, 'bad_password', 'Your current password is incorrect.');
    }
    const p = validatePassword(new_password);
    if (!p.ok) throw fail(400, 'invalid_password', p.message);

    account.password = await hashPassword(p.password);
    account.password_changed_at = new Date().toISOString();
    writeAccount(account);

    // Anyone holding the old password — including whoever the owner passed a
    // reset to — loses their session. The caller gets a fresh one so that
    // changing your password does not sign you out of the tab you did it in.
    dropSessionsFor(account.username);
    return { user: publicAccount(account), token: newSession(account.username) };
  }

  /**
   * Remove an account and everything under it. This deletes the person's
   * saved prompt library along with their credentials, because both live in
   * data/users/{username}/ — the route layer says so before doing it.
   *
   * Unlike deny, this frees the username for registration again.
   */
  function removeAccount(username) {
    const u = validateUsername(username);
    if (!u.ok) throw fail(400, 'invalid_username', u.message);
    const account = readAccount(u.username);
    if (!account) throw fail(404, 'not_found', `No account named ${u.username}.`);
    if (account.is_owner) {
      throw fail(400, 'owner_immutable', 'The owner account cannot be removed here.');
    }

    dropSessionsFor(account.username);
    // Guard against a crafted name escaping the users directory even though
    // validateUsername already refuses anything with a slash or a dot.
    const dir = path.join(usersDir, u.username);
    if (path.dirname(dir) !== usersDir) {
      throw fail(400, 'invalid_username', 'Refusing to delete outside the users directory.');
    }
    rmSync(dir, { recursive: true, force: true });
    return { removed: u.username, library_deleted: true };
  }

  function info() {
    const accounts = listAccounts();
    return {
      enabled,
      owner: findOwner()?.username ?? (ownerName || null),
      owner_registered: ownerExists(),
      accounts: accounts.length,
      pending: accounts.filter((a) => a.status === 'pending').length,
      sessions: sessions.size,
      session_days: sessionDays,
    };
  }

  return {
    enabled,
    get ownerName() { return findOwner()?.username ?? ownerName; },
    register,
    login,
    identify,
    decide,
    can,
    setGrant,
    grants: [...GRANTS],
    resetPassword,
    changePassword,
    updateDisplayName,
    removeAccount,
    listAccounts,
    onlineUsers,
    publicAccount,
    readAccount,
    ownerExists,
    logout: dropSession,
    sessionMaxAgeSeconds: Math.floor(SESSION_MS / 1000),
    info,
  };
}
