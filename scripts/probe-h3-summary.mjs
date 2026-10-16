// H3: which segments come back N/A, and how often?
//
// Measures a real per-segment rate so a fix can be argued from numbers, and so
// the same numbers can be taken again afterwards to show whether it worked.
//
// Two rounds of this have now been thrown away for measuring the wrong thing.
// The 19 Aug round was six runs of one brief and blamed `Summary`, which does
// not drop at all. The 20 Aug round was 20 runs per brief but built the system
// prompt by hand and so omitted the two official MiniMax guides — 16,397
// characters against the app's 56,100. Both sets of numbers are void. If this
// script and the app can disagree about what is being sent, they eventually
// will, so the prompt and the sampling now both come from the app's own
// sources rather than being restated here.
//
// Measures each segment separately rather than "did it hold". `Summary` is
// our own scaffolding and should never be N/A. `Subject definitions` and
// `Retention analysis` *should* be N/A in base modes — SKILL.md says so — and
// counting them proves the model is following that instruction rather than
// blanket-N/A-ing everything. `Soundscape` and `Music` are core base-format
// fields and matter most: they should be N/A only if a scene genuinely has
// neither.
//
// Runs at thinking:false, which is what config/models.yaml sets for h3 and is
// deliberate — see "The H3 counting loop" in the context doc.
//
//   node scripts/probe-h3-summary.mjs [--runs 20] [--brief "..."]
//
// Talks to Ollama directly rather than through the app: no server, no queue,
// no auth, and one less layer between the prompt and the measurement.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { composeSystemPrompt, describeSystemPrompt } from './lib/system-prompt.mjs';
import { keepAliveWireValue } from '../server/keepalive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = YAML.parse(readFileSync(path.join(ROOT, 'config/server.yaml'), 'utf8'));
const model = process.env.PROMPTFORGE_LLM_MODEL ?? cfg.llm.model;

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const RUNS = Math.max(1, Number(arg('--runs', 20)) || 20);
const BRIEF = arg('--brief', 'a pilot boards her ship in a hangar');

// Sampling comes from the registry, not from Ollama's defaults, so this
// reproduces a real request. Read from config/models.yaml rather than
// hardcoded, or the probe silently goes stale the day a preset is retuned.
const CREATIVITY = arg('--creativity', null);
const registryYaml = YAML.parse(
  readFileSync(path.join(ROOT, 'config/models.yaml'), 'utf8'),
  { uniqueKeys: true }
);
const defaults = registryYaml.defaults ?? registryYaml;
const h3 = (registryYaml.models ?? {}).h3 ?? {};
const presets = h3.creativity_presets ?? defaults.creativity_presets ?? {};
const presetName =
  CREATIVITY ?? h3.default_creativity ?? defaults.default_creativity ?? 'balanced';
const PRESET = presets[presetName];
if (!PRESET) {
  console.error(`FATAL: no creativity preset "${presetName}" in config/models.yaml`);
  process.exit(1);
}

const EXPECTED = [
  'Subject definitions', 'Summary', 'Retention analysis',
  'Detailed description', 'Soundscape', 'Music', 'Reasoning',
];

// SKILL.md tells base modes to write N/A for these two. They are expected
// here, and counting them separately is how we tell "following instructions"
// apart from "reaching for N/A generally".
const EXPECTED_NA = new Set(['Subject definitions', 'Retention analysis']);

// Composed by the server's own prompt store, not assembled here.
//
// This used to be house-rules + SKILL.md concatenated by hand, which left out
// the two official MiniMax guides that `server/prompts.mjs` appends for h3 —
// 16,397 characters where the app sends 56,100. The 20 Aug numbers were
// therefore taken against a prompt the app never sends, and the missing 39,703
// characters contain exactly the text that decides this question: the base
// guide's §4.6 gates `N/A` for the soundscape ("only when the user explicitly
// requests complete silence") while §4.7 leaves it open for music ("when there
// is no non-diegetic music").
//
// Same class of bug as the sampling one below, and the same fix: take it from
// where the app takes it rather than restating it. Going through the store
// also means a reference file added to models.yaml lands here automatically.
const composed = composeSystemPrompt(ROOT, 'h3');

// `--patch <file>` tries out a candidate prompt wording WITHOUT editing
// prompts/. The substitution is applied to the composed prompt in memory and
// nothing is written to disk, because tuning those files is the owner's call
// and a measurement should not require making the change first.
//
// Patch format, one or more blocks:
//
//   <<<FIND
//   the exact existing text
//   ===REPLACE
//   the candidate text
//   >>>
//
// A FIND that does not match is a FATAL error, never a warning. A silently
// unapplied patch would measure the unpatched prompt and report it as the
// candidate's result — which is precisely the class of bug that voided two
// earlier rounds of H3 numbers.
const PATCH = arg('--patch', null);
let system = composed.system;
let patchNote = '';

if (PATCH) {
  const raw = readFileSync(path.resolve(ROOT, PATCH), 'utf8');
  const blocks = [...raw.matchAll(/<<<FIND\r?\n([\s\S]*?)\r?\n===REPLACE\r?\n([\s\S]*?)\r?\n>>>/g)];
  if (!blocks.length) {
    console.error(`FATAL: no <<<FIND / ===REPLACE / >>> blocks in ${PATCH}`);
    process.exit(1);
  }
  for (const [i, [, find, replace]] of blocks.entries()) {
    const hits = system.split(find).length - 1;
    if (hits !== 1) {
      console.error(
        `FATAL: patch block ${i + 1} in ${PATCH} matched ${hits} times, expected exactly 1.\n` +
          `       The prompt was NOT patched, so any numbers from this run would be\n` +
          `       the unpatched prompt reported as the candidate's result.\n` +
          `       First line sought: ${find.split('\n')[0].slice(0, 80)}`
      );
      process.exit(1);
    }
    system = system.replace(find, replace);
  }
  patchNote =
    `PATCHED with ${PATCH} — ${blocks.length} block(s), ` +
    `${composed.system.length} → ${system.length} chars. Nothing written to prompts/.`;
}

// No reference supplied, so this is a base mode — the case where Summary was
// observed dropping. Measured both ways on 19 Aug; references are not
// implicated.
const user =
  `Brief: "${BRIEF}"\n` +
  'Workflow: Auto detect · Duration: 10 sec · Aspect: 16:9 · Creativity: Balanced';

const isNA = (body) => /^n\/?a\b/i.test(String(body).trim().replace(/^[a-z_]+:\s*/i, ''));

async function once() {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: true,
      think: false,
      keep_alive: keepAliveWireValue(cfg.llm.keep_alive ?? '15m'),
      // Must match what the app actually sends, or this measures a
      // configuration nobody uses. The first version of this probe omitted
      // temperature and top_p entirely and fell back to Ollama's defaults,
      // which are looser than the balanced preset — and top_p is exactly the
      // knob that decides how often a safe short answer like N/A wins.
      options: {
        num_ctx: cfg.llm.context_length,
        temperature: PRESET.temperature,
        top_p: PRESET.top_p,
      },
    }),
  });
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };

  let content = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const c = JSON.parse(line);
        if (c.message?.content) content += c.message.content;
      } catch { /* partial line */ }
    }
  }

  // Split on the segment delimiter the parser uses.
  const parts = content.split(/^===SEGMENT:\s*(.+?)\s*===\s*$/gm);
  const segments = {};
  for (let i = 1; i < parts.length; i += 2) segments[parts[i]] = (parts[i + 1] ?? '').trim();

  return { ok: true, content, segments, labels: Object.keys(segments) };
}

mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

console.log(`\nH3 segment N/A rates — ${model}`);
console.log(`${RUNS} runs, thinking:false, base mode (no reference)`);
console.log(`sampling: ${presetName} — temperature ${PRESET.temperature}, top_p ${PRESET.top_p}`);
// Printed so a future reader can tell at a glance whether the run measured the
// real prompt. A run showing ~16k characters and 0 reference files is the old
// hand-assembled bug and its numbers should be thrown away.
console.log(describeSystemPrompt(composed));
if (patchNote) console.log(patchNote);

// `--dry-run` validates a patch and exits without generating. Checking a new
// patch by running one generation costs a model load and, worse, contends with
// any measurement already in flight — which is how a long run gets perturbed by
// an unrelated one-line sanity check.
if (process.argv.includes('--dry-run')) {
  console.log('\n--dry-run: prompt composed and patch applied, nothing generated.');
  if (PATCH) {
    const start = system.indexOf('**Music.**');
    if (start !== -1) console.log(`\n${system.slice(start, start + 420)}`);
  }
  process.exit(0);
}
console.log(`brief: "${BRIEF}"`);
console.log('─'.repeat(66));

const naCount = Object.fromEntries(EXPECTED.map((l) => [l, 0]));
const missing = Object.fromEntries(EXPECTED.map((l) => [l, 0]));
const lengths = Object.fromEntries(EXPECTED.map((l) => [l, []]));
let incomplete = 0;

// Structure of the shot block, counted here rather than reconstructed from
// transcripts afterwards. `carries timecodes` is a dialect assertion that gets
// judged on three runs, which cannot tell 90% from 55% — the first time it
// mattered, the rate had to be recovered by re-parsing saved logs. Count it
// every run instead.
const structure = { timecodes: 0, shots: 0, counted: 0 };

// A segment whose delimiter never appeared is not necessarily a segment the
// model declined to write. Measured on the 27B: in runs scored as "Soundscape
// and Music missing", both were present — written inside Detailed description
// under the base guide's own field names, because that guide presents its
// three core fields as one block. Counting containers instead of content
// disqualified a candidate wording that had in fact worked.
//
// So when a segment's delimiter is absent, look for its official field name in
// Detailed description before calling it missing.
const FIELD_NAMES = {
  Soundscape: 'overall_soundscape',
  Music: 'non_diegetic_music',
  'Detailed description': 'integrated_multimodal_description',
};
const misplaced = Object.fromEntries(EXPECTED.map((l) => [l, 0]));
const transcripts = [];

for (let i = 1; i <= RUNS; i++) {
  const r = await once();
  if (!r.ok) {
    incomplete++;
    console.log(`  run ${String(i).padStart(2)}: FAILED — ${r.why}`);
    continue;
  }
  transcripts.push(`===== run ${i} =====\n${r.content}`);

  const flags = [];
  for (const label of EXPECTED) {
    if (!(label in r.segments)) {
      const field = FIELD_NAMES[label];
      const inDesc =
        field &&
        new RegExp(`^\\s*${field}\\s*:`, 'im').test(r.segments['Detailed description'] ?? '');
      if (inDesc) {
        // Written, just in the wrong container. A format problem, not a
        // refusal — and it must not be reported as the model declining.
        misplaced[label]++;
        flags.push(`${label}=MISPLACED`);
      } else {
        missing[label]++;
        flags.push(`${label}=MISSING`);
      }
      continue;
    }
    const body = r.segments[label];
    lengths[label].push(body.length);
    if (isNA(body)) {
      naCount[label]++;
      if (!EXPECTED_NA.has(label)) flags.push(`${label}=N/A`);
    }
  }
  if (r.labels.length !== EXPECTED.length) incomplete++;

  // Same two properties the dialect suite checks on Detailed description.
  const desc = r.segments['Detailed description'] ?? '';
  if (desc && !isNA(desc)) {
    structure.counted++;
    if (/\d{2}:\d{2}/.test(desc)) structure.timecodes++;
    else flags.push('no-timecodes');
    if (/\[Shot\s*\d/i.test(desc)) structure.shots++;
    else flags.push('no-[Shot N]');
  }

  console.log(
    `  run ${String(i).padStart(2)}: ${r.labels.length}/7 segments` +
      (flags.length ? `  ${flags.join(' ')}` : '  clean')
  );
}

writeFileSync(path.join(ROOT, 'logs', 'h3-summary-probe.txt'), transcripts.join('\n\n'), 'utf8');

console.log('─'.repeat(66));
console.log(
  `\n${'segment'.padEnd(22)} ${'N/A'.padStart(8)} ${'missing'.padStart(8)}` +
    ` ${'misplaced'.padStart(10)}   median chars`
);
for (const label of EXPECTED) {
  const lens = lengths[label].filter((n) => n > 0).sort((a, b) => a - b);
  const med = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const expected = EXPECTED_NA.has(label) ? '  (expected in base mode)' : '';
  console.log(
    `${label.padEnd(22)} ${String(naCount[label]).padStart(3)}/${RUNS}` +
      ` ${String(missing[label]).padStart(8)} ${String(misplaced[label] || '').padStart(10)}` +
      `   ${String(med).padStart(6)}${expected}`
  );
}

// Headline the two segments the base guide says to fill. `Summary` was the
// headline here once and turned out never to drop; leading with it again would
// re-tell a story the numbers already refused.
const pct = (n) => `${((n / RUNS) * 100).toFixed(0)}%`;
console.log(
  `\nShould be filled in base mode:` +
    `\n  Soundscape  N/A in ${naCount.Soundscape} of ${RUNS} (${pct(naCount.Soundscape)})` +
    `\n  Music       N/A in ${naCount.Music} of ${RUNS} (${pct(naCount.Music)})`
);
console.log(
  `Should be N/A in base mode:` +
    `\n  Subject definitions  N/A in ${naCount['Subject definitions']} of ${RUNS} (${pct(naCount['Subject definitions'])})` +
    `\n  Retention analysis   N/A in ${naCount['Retention analysis']} of ${RUNS} (${pct(naCount['Retention analysis'])})`
);
// Judged on three runs by the dialect suite, which cannot separate 90% from
// 55%. Reported here at the real sample size.
if (structure.counted) {
  const s = (n) => `${n}/${structure.counted} (${((n / structure.counted) * 100).toFixed(0)}%)`;
  console.log(
    `\nShot block structure, over ${structure.counted} runs with a real description:` +
      `\n  carries timecodes   ${s(structure.timecodes)}` +
      `\n  uses [Shot N]       ${s(structure.shots)}`
  );
}

console.log(`\nFull transcripts: logs/h3-summary-probe.txt`);
