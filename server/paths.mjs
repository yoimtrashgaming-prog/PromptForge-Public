// Moving the data directory, and everything that lives inside it.
//
// `PROMPTFORGE_DATA_DIR` exists so a test run writes its state into a
// throwaway directory instead of into the real one beside people's saved
// prompts. Until 8 Sep 2026 it rewrote `paths.data` and nothing else — which
// looked right, and was not, because every path under it is named separately
// in config/server.yaml:
//
//   data: "data"
//   users: "data/users"
//   queue: "data/queue"
//   requests: "data/requests"
//   usage: "data/usage.json"
//   training: "data/training"
//
// Those are literal strings, not joins against `paths.data`. Rewriting the
// first left the other five pointing at the live directory, so a suite that
// carefully redirected its data directory still wrote to the real one. The
// run counter is where it showed: the test suites drive the real server under
// fixture names, and 873 of 1,193 counted runs turned out to be
// `scripts/check.mjs` rather than a person. The panel was measuring itself.
//
// So the override moves the whole subtree. A path is moved when it genuinely
// resolves inside the old data directory — compared as resolved absolute
// paths, not as string prefixes, because `data` and `data-backup` share five
// characters and share nothing else. Anything outside is left exactly as it
// is: `web`, `logs` and `templates` are not data and do not move with it.
//
// The more specific overrides (PROMPTFORGE_USERS_DIR, PROMPTFORGE_REQUESTS_DIR)
// are applied AFTER this in server.mjs, so naming one still wins.
//
// Only `paths` moves. The two sqlite databases live under `data/tags/` but are
// named in their own config blocks (`tags.db_path`, `traits.db_path`), and
// that is left alone deliberately: they are a built asset rather than per-run
// state, nothing writes to them during a test, and a suite that redirected
// them would lose the tag database and fail for a reason that has nothing to
// do with what it was testing.

import path from 'node:path';

/**
 * Point `paths` at a new data directory, subtree included.
 *
 * Mutates and returns the object it was given, plus the list of keys that
 * actually moved — the caller logs those, and a config override that silently
 * did nothing is the failure this whole module is about.
 */
export function rebaseDataPaths(paths, dataDir, rootDir) {
  const from = path.resolve(rootDir, paths?.data ?? 'data');
  const moved = [];

  for (const [key, value] of Object.entries(paths ?? {})) {
    if (key === 'data' || typeof value !== 'string' || !value) continue;
    const rel = path.relative(from, path.resolve(rootDir, value));
    // Empty is the data directory itself; `..` and an absolute answer both
    // mean the path is somewhere else entirely.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    paths[key] = path.join(dataDir, rel);
    moved.push(key);
  }

  paths.data = dataDir;
  return { paths, moved };
}
