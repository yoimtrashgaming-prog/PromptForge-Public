// Per-machine config overrides: config/<name>.local.yaml merged over the
// tracked config/<name>.yaml.
//
//   node scripts/test-config.mjs
//
// No server, no backend, no network. This exists because the override file is
// the mechanism that lets one branch serve two machines, and every way it can
// go wrong is silent: a merge that replaces a whole block instead of one key,
// an array that appends instead of replacing, or a typo'd local file that is
// skipped so the deployment box boots on the dev box's settings and appears to
// work.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deepMerge, changedKeys, loadConfig } from '../server/config.mjs';
import { rebaseDataPaths } from '../server/paths.mjs';

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

// ── deepMerge ────────────────────────────────────────────────
{
  const base = {
    llm: { backend: 'ollama', model: 'qwen3:8b', context_length: 16384, keep_alive: '15m' },
    server: { bind: '127.0.0.1', port: 8090 },
  };

  const merged = deepMerge(base, { llm: { model: 'big:27b' } });
  check('an override replaces the key it names', merged.llm.model === 'big:27b', merged.llm.model);
  // The failure this guards: a shallow merge would take the whole llm block
  // down to one key, and the box would boot with no backend and no context.
  check('...and leaves the rest of that block alone',
    merged.llm.backend === 'ollama' && merged.llm.context_length === 16384,
    JSON.stringify(merged.llm));
  check('...and other blocks entirely', merged.server.port === 8090);

  check('the base is not mutated', base.llm.model === 'qwen3:8b', base.llm.model);

  // An override that meant to replace the tagger list must not append to it.
  // Two taggers where one was configured, stale one first, reads as the app
  // ignoring the file.
  const arrays = deepMerge({ list: ['a', 'b'] }, { list: ['c'] });
  check('arrays replace rather than concatenate', arrays.list.join(',') === 'c', arrays.list.join(','));

  // How a local file switches off something the shared file turns on.
  const nulled = deepMerge({ search: { enabled: true } }, { search: { enabled: null } });
  check('null replaces, so a local file can switch something off', nulled.search.enabled === null);

  const added = deepMerge({ a: 1 }, { b: { c: 2 } });
  check('a key the base never had is added', added.b.c === 2 && added.a === 1);

  check('nothing to merge leaves the base as it was',
    JSON.stringify(deepMerge(base, {})) === JSON.stringify(base));
}

// ── changedKeys, which is what the boot log prints ───────────
{
  const keys = changedKeys({ llm: { model: 'x', context_length: 1 }, server: { bind: '0.0.0.0' } });
  check('every overridden key is named, dotted',
    keys.join(' ') === 'llm.model llm.context_length server.bind', keys.join(' '));
  check('nothing overridden names nothing', changedKeys({}).length === 0);
}

// ── loadConfig against real files ────────────────────────────
{
  const root = mkdtempSync(path.join(tmpdir(), 'pf-config-'));
  mkdirSync(path.join(root, 'config'));
  const write = (name, text) => writeFileSync(path.join(root, 'config', name), text, 'utf8');

  write('server.yaml', 'llm:\n  model: "qwen3:8b"\n  context_length: 16384\nserver:\n  port: 8090\n');

  // Windows today: no local file at all. This is the case that must not
  // change, since every existing suite and the dev box run it.
  {
    const { config, applied, error } = loadConfig(root, 'server');
    check('with no local file the tracked one is used unchanged',
      config.llm.model === 'qwen3:8b' && config.server.port === 8090, JSON.stringify(config));
    check('...and nothing is reported as applied', applied.length === 0 && error === null);
  }

  // Linux tomorrow.
  write('server.local.yaml', 'llm:\n  model: "big:27b"\n  context_length: 12288\n');
  {
    const { config, applied, error } = loadConfig(root, 'server');
    check('a local file wins on the keys it names', config.llm.model === 'big:27b', config.llm.model);
    check('...and the rest survives', config.server.port === 8090);
    check('...and the boot log can name what changed',
      applied.join(',') === 'llm.model,llm.context_length', applied.join(','));
    check('...with no error', error === null);
  }

  // The dangerous one. A typo in the local file must not fall back to the
  // shared defaults silently: that is the P40 box booting on the dev box's
  // settings while looking healthy.
  write('server.local.yaml', 'llm:\n  model: "unclosed\n   nonsense: [\n');
  {
    const { error } = loadConfig(root, 'server');
    check('a local file that will not parse is an error, not a silent skip',
      Boolean(error) && /local\.yaml/.test(error), String(error));
  }

  // Duplicate keys are a parse error too — uniqueKeys is what catches a
  // setting pasted twice with different values, where the last one silently
  // wins.
  write('server.local.yaml', 'llm:\n  model: "a"\n  model: "b"\n');
  {
    const { error } = loadConfig(root, 'server');
    check('and so is the same key twice', Boolean(error), String(error));
  }

  rmSync(path.join(root, 'config', 'server.local.yaml'));
  {
    const { config, error } = loadConfig(root, 'server');
    check('deleting the local file goes straight back to the tracked one',
      config.llm.model === 'qwen3:8b' && error === null, config.llm.model);
  }

  const missing = loadConfig(root, 'taggers');
  check('a config that does not exist reports rather than throws',
    missing.config === null && Boolean(missing.error), String(missing.error));

  rmSync(root, { recursive: true, force: true });
}

// ── PROMPTFORGE_DATA_DIR moves the whole subtree ─────────────
//
// The other silent failure of the same family, found on 8 Sep 2026: the
// override rewrote `paths.data` while every path that actually gets written is
// named separately under it. A suite that redirected its data directory still
// wrote accounts, the queue and the run counter into the live one, and the
// usage panel ended up reporting `scripts/check.mjs` as its heaviest user.
{
  const root = path.resolve('/srv/app');
  const real = {
    data: 'data',
    users: 'data/users',
    queue: 'data/queue',
    requests: 'data/requests',
    usage: 'data/usage.json',
    training: 'data/training',
    templates: 'web/templates',
    web: 'web',
    logs: 'logs',
  };

  const { paths, moved } = rebaseDataPaths({ ...real }, '/tmp/throwaway', root);
  const under = (p) => !path.relative('/tmp/throwaway', path.resolve(root, p)).startsWith('..');

  check('the data directory itself moves', paths.data === '/tmp/throwaway', paths.data);
  check('...and so does every path inside it',
    ['users', 'queue', 'requests', 'usage', 'training'].every((k) => under(paths[k])),
    JSON.stringify(paths));
  check('...the counter above all, which is what caught this',
    under(paths.usage) && path.basename(paths.usage) === 'usage.json', paths.usage);
  check('...keeping its position within the subtree',
    path.basename(paths.users) === 'users' && path.dirname(paths.users) === path.normalize('/tmp/throwaway'),
    paths.users);
  check('and the move is reported rather than silent',
    moved.length === 5 && moved.includes('usage'), JSON.stringify(moved));

  // web/ and logs/ are not data and do not follow it. A test run that wrote
  // its templates into a temp directory would serve a blank app.
  check('what is not under data/ stays exactly where it was',
    paths.web === 'web' && paths.logs === 'logs' && paths.templates === 'web/templates',
    JSON.stringify([paths.web, paths.logs, paths.templates]));

  // Resolved paths, not string prefixes: `data` and `data-backup` share four
  // characters and nothing else.
  const sibling = rebaseDataPaths({ data: 'data', archive: 'data-backup/old' }, '/tmp/x', root);
  check('a sibling directory with a shared prefix is not swept up',
    sibling.paths.archive === 'data-backup/old', sibling.paths.archive);

  // An absolute path in a local config is somebody being deliberate about a
  // disk, and moving it would be overruling them.
  const pinned = rebaseDataPaths({ data: 'data', training: '/mnt/big/training' }, '/tmp/x', root);
  check('an absolute path outside the data directory is left alone',
    pinned.paths.training === '/mnt/big/training', pinned.paths.training);

  // The deployment case: an absolute data directory, moved to another one.
  const abs = rebaseDataPaths(
    { data: '/srv/app/data', usage: '/srv/app/data/usage.json' },
    '/tmp/y',
    root
  );
  check('an absolute data directory moves its subtree too',
    abs.paths.usage === path.join('/tmp/y', 'usage.json'), abs.paths.usage);
}

console.log('\nconfig overrides\n');
for (const f of failures) console.log(`  FAIL  ${f}`);
if (failures.length) {
  console.log(`\n${failures.length} of ${passed + failures.length} FAILED\n`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})\n`);
