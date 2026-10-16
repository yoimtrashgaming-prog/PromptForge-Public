// Which keys in config/server.yaml does anything actually read?
//
// Written after config/server.yaml was found stating an image upload limit
// that nothing read, in a file where editing it looked like it would work.
// A dead key is worse than a missing one: it is a promise the code does not
// keep, and the person who edits it gets no feedback at all.
//
//   node scripts/dead-config.mjs
//
// Heuristic, deliberately. It looks for each leaf key's NAME in server/,
// scripts/ and server.mjs with comments stripped, so a key mentioned only in
// prose does not count as read. That can miss a key built dynamically, and it
// can be fooled by an unrelated identifier sharing the name — so it prints
// candidates for a human, and only fails on ones not in EXPECTED_DEAD.

// Keys that are dead on purpose: they configure Tab 2, which is Phase 6 and
// unbuilt. They describe agreed future work rather than lying about present
// behaviour, so they stay.
const EXPECTED_DEAD = new Map([
  // Tab 2 is Phase 6 and unbuilt. These describe agreed future work rather
  // than lying about present behaviour.
  ['server.training.temp_retention_days', 'Phase 6, Tab 2'],
  ['server.training.dataset_retention_hours', 'Phase 6, Tab 2'],
  ['server.training.max_concurrent_jobs', 'Phase 6, Tab 2'],
  ['server.uploads.max_dataset_mb', 'Phase 6, Tab 2'],
  ['server.uploads.max_dataset_files', 'Phase 6, Tab 2'],
  ['server.uploads.allowed_archive_types', 'Phase 6, Tab 2'],
]);

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const NL = String.fromCharCode(10);
// All three, not just server.yaml. models.yaml is the higher-traffic file —
// it is edited every time a model is added — so a key with no reader there is
// likelier to be believed.
const CONFIGS = [
  ['server', 'config/server.yaml'],
  ['models', 'config/models.yaml'],
  ['taggers', 'config/taggers.yaml'],
];

// Every source file that could plausibly read config.
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    // Skip this file. It names every key in EXPECTED_DEAD, so counting it as
    // a reader made the six Phase 6 placeholders look live — the tool marking
    // itself as the answer.
    if (path.resolve(dir, e.name) === SELF) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/[.](mjs|js|html)$/.test(e.name)) files.push(full);
  }
};
walk(path.join(ROOT, 'server'));
walk(path.join(ROOT, 'scripts'));
// web/ too: models.yaml keys reach the frontend through GET /api/models and
// are consumed there by name, including as data-bind attributes in the
// per-model templates.
walk(path.join(ROOT, 'web'));
files.push(path.join(ROOT, 'server.mjs'));

// Strip // and /* */ so a key named only in a comment does not count as read.
const BS = String.fromCharCode(92);
const stripped = files.map((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const a = src.split('');
  let i = 0, quote = null;
  const isAt = (j, t) => a.slice(j, j + t.length).join('') === t;
  while (i < a.length) {
    const c = a[i];
    if (quote) {
      if (c === BS) { i += 2; continue; }
      if (c === quote || (c === NL && quote !== '`')) quote = null;
      i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue; }
    if (isAt(i, '/*')) { let e = i; while (e < a.length && !isAt(e, '*/')) e += 1; for (let k = i; k < Math.min(a.length, e + 2); k++) if (a[k] !== NL) a[k] = ' '; i = e + 2; continue; }
    if (isAt(i, '//')) { let e = i; while (e < a.length && a[e] !== NL) e += 1; for (let k = i; k < e; k++) a[k] = ' '; i = e; continue; }
    i += 1;
  }
  return { f: path.relative(ROOT, f).split(path.sep).join('/'), code: a.join('') };
});

// Some maps are keyed by NAME rather than by setting: a model's key, a
// tagger's key, a quality or creativity preset's key. The code never names
// them — it iterates and passes them through to the UI — so testing them
// would report every model in the registry as dead.
//
// `styles` and `reference_files_by_mode` joined them on 3 Sep 2026 for exactly
// the same reason. A style's key is a label the person picks and the server
// looks up as `model.styles?.[value]`; a mode's key is the Mode control's own
// string, looked up as `${key}::${mode}`. Neither is ever written in the
// source, so without this every style and every gated mode reports as dead —
// and the ones that did NOT report were the accidents: "Painterly" only looked
// alive because krea2 lists it too, and "T2VA" because the MiniMax guides
// happen to spell it.
const NAME_MAPS = new Set([
  'models',
  'taggers',
  'quality_presets',
  'creativity_presets',
  'styles',
  'reference_files_by_mode',
]);

const dead = [];
let total = 0;

for (const [label, rel] of CONFIGS) {
  const cfg = YAML.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const leaves = [];

  const collect = (obj, trail, parent) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const at = [...trail, k];
      // Descend into a named entry, but do not ask whether its NAME is read.
      const isName = NAME_MAPS.has(parent);
      if (v && typeof v === 'object' && !Array.isArray(v)) collect(v, at, k);
      else if (!isName) leaves.push(at);
      if (isName) continue;
    }
  };
  collect(cfg, [], null);
  total += leaves.length;

  for (const trail of leaves) {
    const key = trail[trail.length - 1];
    if (stripped.some((f) => f.code.includes(key))) continue;
    // Drop the file's own top-level key so models.yaml's `models:` does not
    // print as models.models.
    const parts = trail[0] === label ? trail.slice(1) : trail;
    dead.push([label, ...parts].join('.'));
  }
}
const unexpected = dead.filter((d) => !EXPECTED_DEAD.has(d));
const expected = dead.filter((d) => EXPECTED_DEAD.has(d));

console.log('');
console.log(`${CONFIGS.map(([, r]) => r).join(', ')} — ${total} leaf keys`);
console.log('');

if (expected.length) {
  console.log(`  ${expected.length} dead on purpose:`);
  for (const d of expected) console.log(`    · ${d} — ${EXPECTED_DEAD.get(d)}`);
  console.log('');
}

if (unexpected.length === 0) {
  console.log('  PASS  every other key has a reader');
  console.log('');
  process.exit(0);
}

console.log(`  FAIL  ${unexpected.length} key(s) that nothing reads:`);
for (const d of unexpected) console.log(`    · ${d}`);
console.log('');
console.log('  Either wire it up, delete it, or add it to EXPECTED_DEAD with');
console.log('  a note saying why it is dead on purpose.');
console.log('');
process.exit(1);
