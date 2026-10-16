// The brief randomizer: a thin wrapper around scripts/randomizer.py.
//
// The picking lives in Python at the owner's call, 5 Sep 2026. It is a
// separate process on purpose — nothing it does touches an LLM, the queue, or
// the GPU, so it has no business inside the request path that manages those.
// It reads config/randomizer.json and the tag database, prints JSON, exits.
//
// The precedent is server/media.mjs, which spawns ffprobe the same way and for
// the same reason: a self-contained job with a text answer.
//
// **Nothing here is load-bearing.** A missing Python, a broken config or a
// script that dies takes the randomizer panel down and nothing else. Every
// path answers with a message the panel can render rather than throwing into
// a request handler.

import { spawn } from 'node:child_process';
import path from 'node:path';

// Generous for what is one sqlite query, tight enough that a hung interpreter
// cannot pin an admin request open. Measured at well under a second on the
// P40 against the full 181k-row database.
const TIMEOUT_MS = 10000;

// A roll is a handful of short strings and the category list is eleven
// entries. Anything approaching this means something is wrong upstream, and
// reading an unbounded pipe into memory because a script went haywire is the
// kind of thing that takes a server down at 3am.
const MAX_OUTPUT = 512 * 1024;

export function createRandomizer(rootDir, config) {
  // The env var exists for one real case: this project is written on a
  // Windows box and only ever runs on Linux, and the interpreter is `python`
  // on the one and `python3` on the other. Config stays correct for the
  // deployment; the override is for whoever is editing.
  const python = process.env.PROMPTFORGE_RANDOMIZER_PYTHON || config.randomizer?.python || 'python3';
  const script = path.resolve(rootDir, 'scripts/randomizer.py');
  const configFile = path.resolve(rootDir, config.randomizer?.config ?? 'config/randomizer.json');

  // The category list changes only when the owner edits the config or the tag
  // database is rebuilt, and the panel asks for it every time it opens. Cached
  // with a short life so an edit shows up without a restart but five people
  // opening the panel do not spawn five interpreters.
  let cache = { at: 0, value: null };
  const CACHE_MS = 30000;

  function run(args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(python, [script, '--config', configFile, ...args], {
          windowsHide: true,
        });
      } catch (err) {
        return resolve({ ok: false, message: `Could not start ${python}: ${err.message}` });
      }

      let out = '';
      let err = '';
      let over = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, message: 'The randomizer took too long and was stopped.' });
      }, TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        if (out.length > MAX_OUTPUT) {
          over = true;
          return child.kill('SIGKILL');
        }
        out += chunk;
      });
      // Kept only to explain a failure. Python writes tracebacks here, and a
      // traceback in the panel is more use than "it did not work".
      child.stderr.on('data', (chunk) => { err += chunk; });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          message:
            e.code === 'ENOENT'
              ? `${python} is not installed, or not on this server's PATH.`
              : `Could not run the randomizer: ${e.message}`,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (over) return resolve({ ok: false, message: 'The randomizer returned too much output.' });
        let parsed = null;
        try {
          parsed = JSON.parse(out);
        } catch {
          // The script's own error path prints JSON, so unparseable output
          // means it died before reaching it — a syntax error, a missing
          // import, a Python too old. Say what actually came back.
          const detail = (err || out).trim().split('\n').pop() || `exit ${code}`;
          return resolve({ ok: false, message: `The randomizer failed: ${detail}` });
        }
        if (parsed?.error) return resolve({ ok: false, message: parsed.error });
        if (code !== 0) return resolve({ ok: false, message: `The randomizer exited ${code}.` });
        resolve({ ok: true, ...parsed });
      });
    });
  }

  async function categories() {
    if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
    const result = await run(['--list']);
    if (result.ok) cache = { at: Date.now(), value: result };
    return result;
  }

  /**
   * One roll.
   *
   * No dialect argument. The randomizer writes a brief, and every image model
   * reads either underscores or spaces perfectly well — so the brief stays in
   * the form a person would type, and the model converts when it writes the
   * actual prompt.
   */
  async function roll(ids, { seed = null, women = 0, men = 0, surprise = false, howMany = 0, limits = null } = {}) {
    const wanted = (Array.isArray(ids) ? ids : []).map((s) => String(s).trim()).filter(Boolean);
    // The cast counts are a choice rather than a draw, so a roll asking only
    // for a cast is a legitimate roll and must not be refused for having no
    // categories ticked.
    const count = (n) => (Number.isInteger(n) && n >= 1 && n <= 4 ? n : 0);
    const w = count(women);
    const m = count(men);
    // Surprise chooses its own categories, so an empty selection is expected.
    if (!wanted.length && !w && !m && !surprise) {
      return { ok: false, message: 'Pick at least one category, or set a character count.' };
    }
    // Ids go onto a command line. spawn takes an argv array so there is no
    // shell to inject into, but a comma inside an id would split one category
    // into two, so the shape is still checked.
    //
    // **Rejected, not filtered.** This dropped bad ids silently until it was
    // caught by a hand-written request: every id was wrong, the roll came
    // back short, and nothing said why. A selection that cannot be honoured
    // in full is an error, because the alternative is a roll quietly missing
    // the category the person cared about.
    const malformed = wanted.filter((s) => !/^[a-z0-9_]{1,64}$/i.test(s));
    if (malformed.length) {
      return { ok: false, message: `Not a category id: ${malformed.join(', ')}` };
    }
    const args = ['--roll', '--categories', wanted.join(',')];
    if (surprise) {
      args.push('--surprise');
      if (Number.isInteger(howMany) && howMany > 0) args.push('--surprise-count', String(howMany));
    }
    if (w) args.push('--women', String(w));
    if (m) args.push('--men', String(m));
    // box=n pairs. Ids are checked the same way the category ids are, so a
    // malformed key cannot reach the command line.
    if (limits && typeof limits === 'object') {
      const pairs = Object.entries(limits)
        .filter(([k, v]) => /^[a-z0-9_]{1,64}$/i.test(k) && Number.isInteger(v) && v > 0 && v <= 99)
        .map(([k, v]) => k + '=' + v);
      if (pairs.length) args.push('--limits', pairs.join(','));
    }
    if (Number.isInteger(seed)) args.push('--seed', String(seed));
    return run(args);
  }

  return { categories, roll };
}
