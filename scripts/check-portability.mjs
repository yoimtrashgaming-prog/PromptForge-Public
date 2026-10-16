// Will this survive the move to Linux?
//
// The project is built on Windows and deployed to a Linux box via flash
// drive, and the migration is supposed to be a config edit rather than a
// port. The failures that would break that are all invisible on Windows,
// which is exactly why this has to be run here rather than discovered there:
//
//   1. Path case. Windows does not care that config says `SKILL.md` while
//      the file is `skill.md`; Linux does. existsSync() cannot catch this,
//      because it is case-insensitive on this filesystem — so every segment
//      is checked against a real directory listing instead.
//   2. CRLF in the index. A shell script committed with CRLF fails on Linux
//      as `/bin/bash^M: bad interpreter`, which reads like a broken script
//      rather than an encoding problem.
//   3. Absolute Windows paths in config. These are legitimate — the tagger
//      weights genuinely live in a ComfyUI install on this box — but each
//      one is a thing somebody must repoint on the other side, so they are
//      listed as migration work rather than failures.
//
//   node scripts/check-portability.mjs

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadRegistry } from '../server/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGS = ['config/server.yaml', 'config/models.yaml', 'config/taggers.yaml'];
let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

// ── 1. path case ──────────────────────────────────────────────

const absolute = [];
const refs = new Set();

// MIME types are not paths, and `image/png` otherwise reads as one. Written
// as prefixes rather than a regex: the alternation needs an escaped slash,
// and an escape that gets mangled turns this into a pattern matching nothing.
const MIME_PREFIXES = ['image/', 'application/', 'video/', 'audio/', 'text/'];
const looksLikePath = (v) =>
  v.includes('/') && !MIME_PREFIXES.some((m) => v.startsWith(m));

// Some values contain a slash and are not paths. Excluded by KEY rather than
// by shape, because guessing from the string is how `BetaDoggo/danbooru-tag-
// list` got reported as a missing directory.
const NOT_PATHS = new Set([
  'repo', 'branch', 'source', 'base_url', 'file_pattern', 'model',
  // An Ollama tag looks like a path and is not one:
  // hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL
  'llm_model',
  'default_llm_model',
  // "N/A" on the aspect selector, added 27 Aug 2026. It is a label a person
  // reads, not a path, and the slash is the whole reason it lands here — the
  // checker reported it as a missing directory called "N".
  'image_aspect_ratios',
  'default_image_aspect_ratio',
  'aspect_ratios',
  'default_aspect_ratio',
]);

// Databases the app builds when it first needs them. The file cannot be
// required to exist — on a fresh checkout none of them do — but its directory
// can, and the directory is where a case mistake would actually live. Keyed by
// config key rather than by filename, matching the rule above: guessing from
// the string is how a repo slug got reported as a missing directory.
//
// tags.sqlite was already in this position and only passed because this box
// happens to have run update-tags. Adding traits.sqlite is what surfaced it.
//
// dataset_dir and output_dir are the same shape: the server creates them at
// startup (server/training.mjs ensureLayout), and on a box that overrides
// them to somewhere else entirely the committed default never gets built at
// all - so the parent is the only thing that can honestly be required.
const CREATED_ON_DEMAND = new Set(['db_path', 'dataset_dir', 'output_dir']);
const onDemand = new Set();

const grab = (o, parentKey) => {
  // An `about:` block is prose a person reads (edit.about: the Edit tab's
  // "About this editor"). It names folders and Hugging Face repos with
  // slashes in them, and none of them is a path this app opens.
  if (parentKey === 'about') return;
  for (const [k, v] of Object.entries(o ?? {})) {
    if (typeof v === 'string') {
      if (v.startsWith('http')) continue;
      if (/^[A-Za-z]:/.test(v)) { absolute.push(v); continue; }
      // Everything under `paths:` is the app's own storage, made on first run:
      // a fresh clone has no data/users yet, and that is not a broken path.
      if ((CREATED_ON_DEMAND.has(k) || parentKey === 'paths') && looksLikePath(v)) { onDemand.add(v); refs.add(v); continue; }
      if (!NOT_PATHS.has(k) && looksLikePath(v)) refs.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x !== 'string') continue;
        if (/^[A-Za-z]:/.test(x)) absolute.push(x);
        else if (!NOT_PATHS.has(k) && looksLikePath(x)) refs.add(x);
      }
    } else if (v && typeof v === 'object') grab(v, k);
  }
};
for (const f of CONFIGS) grab(YAML.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')), null);

// h3's optional reference file is absent by design — the README there says to
// write it yourself. The registry already distinguishes the two, so ask it
// rather than hardcoding the exception.
const registry = loadRegistry(ROOT, { warn: () => {} });
const optional = new Set();
for (const key of registry.keys()) {
  const m = registry.get(key);
  for (const rel of m.reference_files ?? []) optional.add(rel);
}
const declaredOptional = new Set(
  CONFIGS.flatMap((f) => {
    const y = YAML.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    return Object.values(y.models ?? {}).flatMap((m) => m.optional_reference_files ?? []);
  })
);

/** Walk each segment against a real listing. existsSync would pass a name
 *  Linux will reject, because it is case-insensitive here. */
function caseExact(rel) {
  const parts = rel.split('/').filter(Boolean);
  let dir = ROOT;
  for (let i = 0; i < parts.length; i += 1) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return `no such directory: ${path.relative(ROOT, dir) || '.'}`;
    }
    if (!entries.includes(parts[i])) {
      const near = entries.find((e) => e.toLowerCase() === parts[i].toLowerCase());
      return near
        ? `CASE: config says "${parts[i]}", disk has "${near}" — works here, fails on Linux`
        : `missing: ${parts.slice(0, i + 1).join('/')}`;
    }
    dir = path.join(dir, parts[i]);
  }
  return null;
}

console.log('');
console.log('path case — every config path must match the disk character for character');
console.log('');

const checked = [...refs].sort();
const problems = [];
// Tagger weights are downloaded per install (docs/taggers-setup.md) and never
// in git, so a fresh clone has none of them - absent is normal. When they are
// there, the case check still applies: that is the Linux trap this catches.
const taggerFiles = new Set(
  Object.values(YAML.parse(fs.readFileSync(path.join(ROOT, 'config/taggers.yaml'), 'utf8')).taggers ?? {})
    .flatMap((t) => [t.model, t.labels])
    .filter(Boolean)
);
for (const rel of checked) {
  if (declaredOptional.has(rel) && !optional.has(rel)) continue; // absent by design
  if (taggerFiles.has(rel) && !fs.existsSync(path.join(ROOT, rel))) continue; // not installed here
  // Built on first use, so check the directory that must be right rather than
  // a file that legitimately may not be there yet.
  const target = onDemand.has(rel) && !fs.existsSync(path.join(ROOT, rel))
    ? path.posix.dirname(rel)
    : rel;
  const why = caseExact(target);
  if (why) problems.push(`${rel} — ${why}`);
}
ok(problems.length === 0, `${checked.length} config paths resolve exactly`, problems.join('; '));

// ── 2. line endings ─────────────────────────────────────────

console.log('');
console.log('line endings — nothing may carry CRLF into the index');
console.log('');

// A copy that is not a git checkout yet (the public export before its first
// commit) has no index to ask; there is nothing to carry CRLF into.
if (!fs.existsSync(path.join(ROOT, '.git'))) {
  ok(true, 'not a git checkout, so there is no index to check');
} else try {
  const out = execFileSync('git', ['ls-files', '--eol'], { cwd: ROOT }).toString();
  const lines = out.split(String.fromCharCode(10)).filter(Boolean);
  // `git ls-files --eol` puts the filename after a tab, so split on that
  // rather than on a whitespace regex — paths in this project contain spaces.
  const crlf = lines
    .filter((l) => l.includes('i/crlf'))
    .map((l) => l.split(String.fromCharCode(9)).pop().trim());
  ok(crlf.length === 0, `${lines.length} tracked files, none CRLF in the index`, crlf.slice(0, 5).join(', '));
} catch (err) {
  ok(false, 'could not read git line endings', err.message.split(String.fromCharCode(10))[0]);
}

// ── 3. what has to be repointed on the other side ─────────────────────

console.log('');
console.log('migration work — not failures, but not portable either');
console.log('');

const unique = [...new Set(absolute)];
if (unique.length === 0) {
  console.log('  none — no absolute Windows paths in config');
} else {
  console.log(`  ${unique.length} absolute Windows path(s) in config, each needing a new value on Linux:`);
  for (const a of unique) console.log(`    · ${a}`);
}

console.log('');
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
console.log('');
process.exit(failures === 0 ? 0 : 1);
