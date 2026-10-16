// Config loading, with a per-machine override file.
//
// One repo, one branch, two machines. This box is Windows with a 16GB RTX
// 5080 and ComfyUI's tagger weights at a C:/Users path; the deployment box is
// Linux with a 24GB Tesla P40 and nothing at that path. Roughly four settings
// differ and **no code does** — which is the whole premise of the project, and
// the reason a branch per OS would be the wrong tool.
//
// The friction that makes people reach for a branch anyway is that
// config/server.yaml is tracked: edit it on the second machine and every
// `git pull` there fights a local modification. So the tracked file holds the
// shared defaults, and each machine may keep a gitignored `*.local.yaml`
// beside it that is merged over the top.
//
//   config/server.yaml         committed, shared, the source of truth
//   config/server.local.yaml   gitignored, this machine only, wins
//
// Same mechanism for taggers.yaml, which is the one that will actually bite on
// Linux — those weight paths are absolute and Windows-shaped.
//
// Precedence, lowest to highest: committed file, local file, environment
// variables. Env stays on top because a throwaway test run overriding one
// setting must not require editing anything.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Merge `over` onto `base`, recursing into plain objects only.
 *
 * Arrays replace rather than concatenate. An override that meant to *replace*
 * the tagger list would otherwise end up appending to it, and the result — two
 * taggers where one was configured, the stale one first — is the kind of
 * failure that looks like the app ignoring the file.
 *
 * Null replaces too, deliberately: it is how a local file switches something
 * off that the shared file turns on.
 */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every top-level path in an object, dotted, so the boot log can name what a local file actually changed. */
export function changedKeys(over, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(over ?? {})) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...changedKeys(value, at));
    else out.push(at);
  }
  return out;
}

/**
 * Read `config/<name>.yaml`, then merge `config/<name>.local.yaml` over it.
 *
 * Returns `{ config, applied, error }` rather than throwing or exiting, so the
 * caller decides whether a missing or broken file is fatal — server.yaml is,
 * taggers.yaml is not, and that difference belongs to them and not here.
 *
 * A local file that fails to parse is an **error, never a silent skip**. The
 * whole point of it is to change behaviour, and quietly running with the
 * shared defaults after a YAML typo would mean the P40 box booting on the
 * Windows box's settings and appearing to work.
 */
export function loadConfig(rootDir, name) {
  const base = path.join(rootDir, 'config', `${name}.yaml`);
  const local = path.join(rootDir, 'config', `${name}.local.yaml`);

  if (!existsSync(base)) return { config: null, applied: [], error: `${base} not found` };

  let config;
  try {
    config = YAML.parse(readFileSync(base, 'utf8'), { uniqueKeys: true }) ?? {};
  } catch (err) {
    return { config: null, applied: [], error: `config/${name}.yaml failed to parse — ${err.message}` };
  }

  if (!existsSync(local)) return { config, applied: [], error: null };

  let overrides;
  try {
    overrides = YAML.parse(readFileSync(local, 'utf8'), { uniqueKeys: true }) ?? {};
  } catch (err) {
    return { config, applied: [], error: `config/${name}.local.yaml failed to parse — ${err.message}` };
  }

  return { config: deepMerge(config, overrides), applied: changedKeys(overrides), error: null };
}
