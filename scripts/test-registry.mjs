// Negative tests for registry validation.
//
// The spec's requirement is that a bad models.yaml "fails loudly at boot with
// the offending key named — not silently produce a broken dropdown". These
// cases prove it does, for each class of breakage.
//
// Each case builds a temp project root: a mutated config/models.yaml plus
// junctions back to the real prompts/ and web/ trees, so the actual config is
// never modified.
//
//   node scripts/test-registry.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadRegistry } from '../server/registry.mjs';
import { createPromptStore, runtimeContext } from '../server/prompts.mjs';
import { composeSystemPrompt } from './lib/system-prompt.mjs';
import { expectedSegments, segmentsOutsideMode } from '../server/director.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL = readFileSync(path.join(ROOT, 'config', 'models.yaml'), 'utf8');

let failures = 0;

function attempt(label, mutate, expectFragment) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-registry-'));
  try {
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'models.yaml'), mutate(ORIGINAL), 'utf8');
    // Junctions need no elevation on Windows and are a no-op cost on Linux.
    for (const d of ['prompts', 'web']) {
      symlinkSync(path.join(ROOT, d), path.join(dir, d), 'junction');
    }

    let message = null;
    try {
      loadRegistry(dir, { warn: () => {} });
    } catch (err) {
      message = err.message;
    }

    if (message === null) {
      console.log(`  FAIL  ${label} — loaded without error`);
      failures += 1;
    } else if (!message.includes(expectFragment)) {
      console.log(`  FAIL  ${label} — error did not mention "${expectFragment}"`);
      console.log(`        got: ${message.split('\n').slice(0, 3).join(' / ')}`);
      failures += 1;
    } else {
      const line = message.split('\n').find((l) => l.includes(expectFragment)) ?? '';
      console.log(`  PASS  ${label}`);
      console.log(`        ${line.trim().slice(0, 120)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nregistry validation — each of these must refuse to boot\n');

attempt(
  'unknown template name',
  (s) => s.replace('template: "video-ltx"', 'template: "video-lightning"'),
  'unknown template'
);

// A block for a segment the model does not have would never be appended, and
// would look like it was working.
attempt(
  'a segment block naming a segment that does not exist',
  // Relabels ltx's existing block rather than adding one: a second
  // `segment_blocks:` key would be a duplicate-key YAML error and would prove
  // the parser works instead of the rule.
  (s) => s.replace(
    '      "Improvement notes": "prompts/video/segments/ltx-improvement-notes.md"',
    '      "Reasoning": "prompts/video/segments/ltx-improvement-notes.md"'
  ),
  'not one of its segments'
);

// A block whose file is not on disk is never appended and never complained
// about, so the prompt silently loses a segment's instructions.
attempt(
  'a segment block pointing at nothing',
  (s) => s.replace(
    '      "Improvement notes": "prompts/video/segments/ltx-improvement-notes.md"',
    '      "Improvement notes": "prompts/video/segments/nope.md"'
  ),
  'not found'
);

// A per-mode contract naming a segment the model does not have would ask for
// something with no block and no label, in that mode only.
attempt(
  'a per-mode contract naming a segment that does not exist',
  (s) => s.replace(
    '"L2VA":  ["Detailed description", "Soundscape", "Music", "Reasoning"]',
    '"L2VA":  ["Detailed description", "Soundscape", "Score", "Reasoning"]'
  ),
  'not in its segments'
);

// The parser enforces order, so a reordered list fails every run in that mode.
attempt(
  'a per-mode contract out of order',
  (s) => s.replace(
    '"L2VA":  ["Detailed description", "Soundscape", "Music", "Reasoning"]',
    '"L2VA":  ["Soundscape", "Detailed description", "Music", "Reasoning"]'
  ),
  'out of order'
);

// A mode block that is not on disk is a mode silently missing its instructions.
attempt(
  'a mode block pointing at nothing',
  (s) => s.replace(
    '"REF2VA": ["prompts/video/h3/modes/ref2va.md"]',
    '"REF2VA": ["prompts/video/h3/modes/nope.md"]'
  ),
  'not found'
);

// The list the contract is generated from must not also be written in the
// prompt file. It was in both until 5 Sep 2026, and a leftover copy would
// contradict the generated contract the moment a segment is switched off —
// while still reading perfectly well on its own, which is what makes it hard
// to see. Asserted against the shipped files rather than a fixture, because
// these are the files that would actually drift.
{
  const stale = [];
  for (const [key, model] of Object.entries(YAML.parse(ORIGINAL).models ?? {})) {
    const text = readFileSync(path.join(ROOT, model.system_prompt), 'utf8');
    if (/^##\s+Segments to emit\s*$/m.test(text)) stale.push(`${key} (${model.system_prompt})`);
  }
  if (stale.length) {
    console.log(`  FAIL  a shipped prompt file still lists its own segments — ${stale.join(", ")}`);
    failures += 1;
  } else {
    console.log('  PASS  no shipped prompt file lists its own segments');
  }
}

attempt(
  'system prompt file missing',
  // Read out of the live registry rather than hardcoded. Pinning a filename
  // here made this assertion silently stop testing anything the day krea2's
  // system_prompt was repointed - the replace matched nothing, the config
  // stayed valid, and "loaded without error" was the failure message for a
  // test that had quietly become a no-op.
  (s) => s.replace(/system_prompt: "prompts\/image\/krea2[^"]*"/, 'system_prompt: "prompts/image/krea3.md"'),
  'system prompt not found'
);

attempt(
  'duplicate model key',
  (s) => `${s}\n  ltx:\n    name: "dupe"\n`,
  'YAML parse failed'
);

attempt(
  'negative segment declared with no negative_defaults',
  (s) => s.replace(/\n    negative_defaults: "worst quality[^\n]*\n/, '\n'),
  'no `negative_defaults`'
);

attempt(
  'model lists the reserved Refused segment',
  // Appends to whichever segment list comes first rather than naming one.
  // Pinned to flux's list until 2 Sep 2026, and when flux was removed the
  // replace matched nothing and the assertion became a no-op reporting
  // "loaded without error" - the same way the krea2 path case failed.
  (s) => s.replace(/segments: \[([^\]]*)\]/, (_m, inner) => `segments: [${inner}, "Refused"]`),
  'must not list'
);

// ── Reference files: required vs optional ─────────────────────────────────
//
// These load rather than refuse, so they need a different harness. The
// distinction is not cosmetic: a missing *required* guide makes prompts.mjs
// append a note telling the model it "worked without the official reference
// guides" and to work from its own instructions. h3's optional house-
// conventions file is absent by design — the README says to write it yourself
// — and before this split its absence fired that note on 100% of H3
// generations while both official guides were present in the prompt.

function inspect(label, mutate, check) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-registry-'));
  try {
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'models.yaml'), mutate(ORIGINAL), 'utf8');
    // NOTE: prompts/ and web/ are junctions to the real trees. Never create
    // files beneath them here — it would write into the actual project.
    for (const d of ['prompts', 'web']) {
      symlinkSync(path.join(ROOT, d), path.join(dir, d), 'junction');
    }
    const reg = loadRegistry(dir, { warn: () => {} });
    const detail = check(reg, dir);
    if (detail === true) {
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label} — ${detail}`);
      failures += 1;
    }
  } catch (err) {
    console.log(`  FAIL  ${label} — threw: ${err.message.split('\n')[0]}`);
    failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nreference files — required must be reported missing, optional must not\n');

inspect(
  'an absent optional reference file is not reported missing',
  (s) => s,
  (reg) => {
    const h3 = reg.get('h3');
    if (h3.missing_reference_files.length !== 0) {
      return `missing_reference_files was ${JSON.stringify(h3.missing_reference_files)}`;
    }
    return true;
  }
);

// The full quoted path, replaceAll, and both deliberate.
//
// This used to replace the bare basename, which broke on 3 Sep 2026 the moment
// a COMMENT above the paths mentioned the file by name: `String.replace` takes
// the first occurrence, so the mutation renamed the prose and left every real
// path intact. The test then passed a config with nothing missing and reported
// the absence of a note as a failure to report absence.
//
// replaceAll because h3's guides are now listed once per mode: renaming one
// occurrence would leave the file present in five other modes, which is not
// the thing being tested.
const GUIDE = '"prompts/video/h3/references/h3-base-modes.md"';
const NO_GUIDE = '"prompts/video/h3/references/h3-base-modes-nope.md"';

inspect(
  'an absent required reference file IS reported missing',
  (s) => s.replaceAll(GUIDE, NO_GUIDE),
  (reg) => {
    const h3 = reg.get('h3');
    // Both lists, because a gated model reports per mode and an ungated one
    // reports flat. The assertion is "it was reported", not "in which field".
    const missing = [
      ...(h3.missing_reference_files ?? []),
      ...Object.values(h3.missing_reference_files_by_mode ?? {}).flat(),
    ];
    if (!missing.some((m) => m.includes('h3-base-modes-nope'))) {
      return `nothing reported missing — flat ${JSON.stringify(
        h3.missing_reference_files
      )}, by mode ${JSON.stringify(h3.missing_reference_files_by_mode)}`;
    }
    return true;
  }
);

inspect(
  'an optional reference file that exists is loaded, after the required ones',
  (s) =>
    s.replace(
      '      - "prompts/video/h3/references/user-preferred-extensions.md"',
      '      - "prompts/video/h3/references/README.md"'
    ),
  (reg) => {
    const files = reg.get('h3').reference_files;
    const last = files[files.length - 1];
    if (!last.endsWith('README.md')) {
      return `optional file did not load last — got ${JSON.stringify(files)}`;
    }
    return true;
  }
);

// The behaviour the split actually exists to protect. Composed through the
// real prompt store, because "does the note appear" is a property of the
// finished prompt, not of the registry.
inspect(
  'no "worked without the official guides" note when only optional files are absent',
  (s) => s,
  (reg, dir) => {
    const cfg = { prompts: { shared_prefix: 'prompts/_shared/house-rules.md' } };
    const store = createPromptStore(dir, cfg, reg, { warn: () => {} });
    store.reload();
    const system = store.get('h3');
    if (system.includes('Note on reference material')) {
      return 'the degradation note fired anyway';
    }
    if (system.includes('Work from your own instructions')) {
      return 'the model is still being told to work from its own instructions';
    }
    return true;
  }
);

inspect(
  'the note still fires when a required guide really is absent',
  (s) => s.replaceAll(GUIDE, NO_GUIDE),
  (reg, dir) => {
    const cfg = { prompts: { shared_prefix: 'prompts/_shared/house-rules.md' } };
    const store = createPromptStore(dir, cfg, reg, { warn: () => {} });
    store.reload();
    if (!store.get('h3').includes('Note on reference material')) {
      return 'a genuinely missing official guide went unannounced';
    }
    return true;
  }
);

// ── Composition order ───────────────────────────────────────
//
// The order house rules / reference material / the model's own file is a
// measured result, not a preference. With SKILL.md ahead of the guides, 39,703
// characters of third-party reference sat between it and the answer, and the
// last line of a 56,100-character prompt was a worked example ending
// `non_diegetic_music: N/A`. Moving it last measured Soundscape 12/40 -> 2/40
// and Summary 22/40 -> 14/40 over 20 runs per brief.
//
// Until now a comment was the only thing protecting that. Every other test in
// this file passes with the push site moved back, so a refactor could revert
// the result and the only thing that would notice is a multi-minute GPU probe
// nobody runs by accident. These assertions cost milliseconds and need no
// backend.

const NL = String.fromCharCode(10);
const SEPARATOR = NL + NL + '---' + NL + NL;

console.log('');
console.log("composition order — house rules first, the model's own file last");
console.log('');

function composed(label, check) {
  try {
    const detail = check();
    if (detail === true) {
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label} — ${detail}`);
      failures += 1;
    }
  } catch (err) {
    console.log(`  FAIL  ${label} — threw: ${err.message.split(NL)[0]}`);
    failures += 1;
  }
}

// Composed through the same helper every probe uses, so this covers
// scripts/lib/system-prompt.mjs too, and reads the real config/server.yaml
// rather than a hand-built one.
const liveRegistry = loadRegistry(ROOT, { warn: () => {} });
const readTrimmed = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').trim();

composed('house rules open every model prompt', () => {
  const bad = [];
  for (const key of liveRegistry.keys()) {
    const { system, config } = composeSystemPrompt(ROOT, key);
    if (!system.startsWith(readTrimmed(config.prompts.shared_prefix))) bad.push(key);
  }
  return bad.length === 0 ? true : `did not open with house rules: ${bad.join(', ')}`;
});

// Followed only by the model's mode blocks, which exist to have the last word
// for one mode — h3's, since 10 Sep 2026. The ungated entry carries all of
// them; the gated entries are checked in the mode-gating section below.
composed("the model's own prompt file closes every model prompt, bar its mode blocks", () => {
  const bad = [];
  const SEP = NL + NL + '---' + NL + NL;
  for (const key of liveRegistry.keys()) {
    const model = liveRegistry.get(key);
    const { system } = composeSystemPrompt(ROOT, key);
    // Only the offered modes' blocks: a mode_variants key (h3's "REF2VA
    // labelled") is asked for by name and is kept out of the ungated entry.
    const offered = Object.entries(model.mode_blocks ?? {})
      .filter(([mode]) => !Array.isArray(model.modes) || model.modes.includes(mode))
      .flatMap(([, v]) => v);
    const blocks = [...new Set(offered)];
    const tail = [readTrimmed(model.system_prompt), ...blocks.map(readTrimmed)].join(SEP);
    if (!system.endsWith(tail)) bad.push(key);
  }
  return bad.length === 0
    ? true
    : `something is composed after the model's own file: ${bad.join(', ')}`;
});

composed('h3 reference material sits between them, never after SKILL.md', () => {
  const { system, referenceFiles } = composeSystemPrompt(ROOT, 'h3');
  if (referenceFiles.length === 0) return 'h3 composed with no reference files at all';
  // Located, not derived from the end — deriving it assumes the very thing
  // this is checking, and the check then passes under the regression.
  const skillStartsAt = system.indexOf(readTrimmed('prompts/video/h3/SKILL.md'));
  if (skillStartsAt === -1) return 'SKILL.md is not in the composed prompt verbatim';
  for (const rel of referenceFiles) {
    const at = system.indexOf(`# Reference: ${path.basename(rel)}`);
    if (at === -1) return `${path.basename(rel)} was not composed in at all`;
    if (at > skillStartsAt) return `${path.basename(rel)} was composed after SKILL.md`;
  }
  return true;
});

// ── Mode-gated reference files ──────────────────────────────
//
// h3 carried both official guides on every generation until 3 Sep 2026, which
// is how its prompt reached 12,692 tokens and stopped fitting a 12288 context.
// Gating them by mode halved that, and sectioning them on 4 Sep halved it
// again: scripts/section-h3-references.mjs slices the two official documents
// on their own heading boundaries into a shared core plus one file per mode
// family, so no mode carries another mode's instructions or worked examples.
//
// What must stay true: a gated mode drops only the guide it cannot use, every
// mode keeps the shared core, and anything unrecognised composes the full
// prompt rather than a quietly smaller one.

const BASE_GUIDE = 'h3-base-modes.md';
const REF_GUIDE = 'h3-ref2va.md';
const CORE = 'h3-core.md';
const carries = (system, name) => system.includes(`# Reference: ${name}`);

composed('a base mode drops the Full-reference guide it cannot use', () => {
  const bad = [];
  for (const mode of ['T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    const { system } = composeSystemPrompt(ROOT, 'h3', mode);
    if (!carries(system, BASE_GUIDE)) bad.push(`${mode} lost its own guide`);
    if (carries(system, REF_GUIDE)) bad.push(`${mode} still carries the reference guide`);
  }
  return bad.length === 0 ? true : bad.join('; ');
});

// Base guide section 4 — shots, camera vocabulary, dialogue tokens, the two
// audio fields — is mode-independent, so it moved out of the base guide and
// into a file every mode loads. A mode that lost it would still look plausible
// and would write shots with no camera or timestamp conventions at all.
composed('every mode carries the shared core, whatever else it drops', () => {
  const bad = [];
  for (const mode of ['REF2VA', 'Auto detect', 'T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    if (!carries(composeSystemPrompt(ROOT, 'h3', mode).system, CORE)) bad.push(mode);
  }
  if (!carries(composeSystemPrompt(ROOT, 'h3').system, CORE)) bad.push('the ungated fallback');
  return bad.length === 0 ? true : `no shared core in: ${bad.join(', ')}`;
});

// The sections that came out are meant to STAY out. Each of these three is a
// measured cost, not a tidy-up: the alignment line is written by the Director
// itself and duplicating it is a defect, and the worked examples teach the raw
// field-name format that segment_fields exists to clean up after.
composed('the dropped sections are really gone from every mode', () => {
  const bad = [];
  for (const mode of ['REF2VA', 'Auto detect', 'T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    const { system } = composeSystemPrompt(ROOT, 'h3', mode);
    // The base guide's four Cases and the reference guide's Complete Example.
    if (system.includes('## 5. Cases')) bad.push(`${mode}: base guide cases`);
    if (system.includes('## 7. Complete Example')) bad.push(`${mode}: reference example`);
    // Section 2.1, the alignment instruction the Director generates itself.
    if (system.includes('### 2.1 Part One Is the Instruction')) {
      bad.push(`${mode}: alignment instruction section`);
    }
  }
  return bad.length === 0 ? true : bad.join('; ');
});

// Base guide section 3, one part per frame mode (6 Oct 2026): each mode
// carries its own keyframe part and no other, and T2VA none.
composed('each base mode carries only its own keyframe section', () => {
  const own = { T2VA: null, I2VA: 'h3-i2va.md', FL2VA: 'h3-fl2va.md', L2VA: 'h3-l2va.md' };
  const parts = ['h3-i2va.md', 'h3-fl2va.md', 'h3-l2va.md'];
  const bad = [];
  for (const [mode, file] of Object.entries(own)) {
    const { system } = composeSystemPrompt(ROOT, 'h3', mode);
    for (const p of parts) {
      if (p === file && !carries(system, p)) bad.push(`${mode} lost ${p}`);
      if (p !== file && carries(system, p)) bad.push(`${mode} carries ${p}`);
    }
  }
  const ref = composeSystemPrompt(ROOT, 'h3', 'REF2VA').system;
  if (parts.some((p) => carries(ref, p))) bad.push('REF2VA carries a keyframe section');
  return bad.length === 0 ? true : bad.join('; ');
});

// The opening of the reference guide holds its one rule for
// detailed_description; slicing from "## 1." dropped it until 6 Oct 2026.
composed('Full reference keeps the guide\'s Description detail rule', () => {
  const { system } = composeSystemPrompt(ROOT, 'h3', 'REF2VA');
  return system.includes('Make `detailed_description` as detailed and explicit as possible') ? true : 'the Description detail paragraph is missing';
});

composed('Full reference drops the base guide, and keeps its own', () => {
  const { system } = composeSystemPrompt(ROOT, 'h3', 'REF2VA');
  if (!carries(system, REF_GUIDE)) return 'the reference guide is missing';
  if (carries(system, BASE_GUIDE)) return 'the base guide is still composed in';
  return true;
});

// Auto detect used to be the live default and the reason both guides loaded
// on nearly every run. resolveAutoMode() in server/references.mjs now settles
// it before the prompt store is asked, so nothing should arrive still saying
// "Auto detect" — but if something bypasses that, the entry must still compose
// a prompt that WORKS rather than one missing half its instructions.
composed('Auto detect still composes both guides, as the safety net it now is', () => {
  const { system } = composeSystemPrompt(ROOT, 'h3', 'Auto detect');
  if (!carries(system, BASE_GUIDE)) return 'the base guide was dropped';
  if (!carries(system, REF_GUIDE)) return 'the reference guide was dropped';
  return true;
});

// The failure that would be hardest to notice: a mode string the registry does
// not know composing a prompt with its guides quietly absent. The model would
// not error, it would just write worse. So the fallback is MORE material, not
// less — exactly what shipped before gating existed.
composed('an unknown mode falls back to the full prompt, never a smaller one', () => {
  const base = composeSystemPrompt(ROOT, 'h3').system;
  const typo = composeSystemPrompt(ROOT, 'h3', 'T2VAA').system;
  if (typo !== base) return 'an unrecognised mode composed something other than the base prompt';
  if (!carries(typo, BASE_GUIDE) || !carries(typo, REF_GUIDE)) {
    return 'the fallback prompt is missing a guide';
  }
  return true;
});

// Gating composes a fresh prompt per mode, so the ordering result the section
// above protects has to hold for every one of them, not just the base.
// Since 10 Sep 2026 the model's own file is followed by the block for its mode,
// so "closes with SKILL.md" became "closes with SKILL.md and then its own mode
// block, nothing else". Byte-for-byte, same reason as before.
composed('every gated mode opens with house rules and closes with SKILL.md plus its own block', () => {
  const bad = [];
  const skill = readTrimmed('prompts/video/h3/SKILL.md');
  const blocks = liveRegistry.get('h3').mode_blocks ?? {};
  const SEP = NL + NL + '---' + NL + NL;
  for (const mode of ['REF2VA', 'Auto detect', 'T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    const { system, config } = composeSystemPrompt(ROOT, 'h3', mode);
    if (!system.startsWith(readTrimmed(config.prompts.shared_prefix))) {
      bad.push(`${mode} does not open with house rules`);
    }
    const tail = [skill, ...(blocks[mode] ?? []).map(readTrimmed)].join(SEP);
    if (!system.endsWith(tail)) bad.push(`${mode} does not close with SKILL.md and its own mode block`);
  }
  return bad.length === 0 ? true : bad.join('; ');
});

// ── The mode split, 10 Sep 2026 ─────────────────────────────
//
// SKILL.md used to carry REF2VA's reference roles, its three extra sections
// and a REF2VA-shaped example into every base-mode generation, and told base
// modes to answer N/A in three segments that do not exist in their format.

const BASE_BLOCK = 'prompts/video/h3/modes/base.md';
const REF_BLOCK = 'prompts/video/h3/modes/ref2va.md';

composed('a base mode carries the base block and not REF2VA\'s, and REF2VA the reverse', () => {
  const bad = [];
  const base = readTrimmed(BASE_BLOCK);
  const ref = readTrimmed(REF_BLOCK);
  for (const mode of ['T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    const { system } = composeSystemPrompt(ROOT, 'h3', mode);
    if (!system.includes(base)) bad.push(`${mode} lost the base block`);
    if (system.includes(ref)) bad.push(`${mode} still carries the REF2VA block`);
    if (/every reference gets an explicit role/i.test(system)) bad.push(`${mode} still carries the reference-role rule`);
  }
  const { system } = composeSystemPrompt(ROOT, 'h3', 'REF2VA');
  if (!system.includes(ref)) bad.push('REF2VA lost its block');
  if (system.includes(base)) bad.push('REF2VA carries the base block');
  return bad.length === 0 ? true : bad.join('; ');
});

composed('h3 asks a base mode for its three fields and REF2VA for all seven', () => {
  const h3 = liveRegistry.get('h3');
  const bad = [];
  const want = ['Detailed description', 'Soundscape', 'Music', 'Reasoning'];
  for (const mode of ['T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    const got = expectedSegments(h3, { mode });
    if (got.join('|') !== want.join('|')) bad.push(`${mode}: ${got.join(', ')}`);
    const out = segmentsOutsideMode(h3, { mode });
    if (out.join('|') !== 'Subject definitions|Summary|Retention analysis') {
      bad.push(`${mode} drops ${out.join(', ') || 'nothing'}`);
    }
  }
  for (const mode of ['REF2VA', 'Auto detect', undefined]) {
    if (expectedSegments(h3, { mode }).length !== 7) bad.push(`${mode ?? 'no mode'} is not the full seven`);
    if (segmentsOutsideMode(h3, { mode }).length) bad.push(`${mode ?? 'no mode'} drops segments`);
  }
  return bad.length === 0 ? true : bad.join('; ');
});

// The Director and the base guide: "[Shot 1]" has no timestamp, and later
// shots open with their cut time as MM:SS.mmm. SKILL.md taught a range on
// every shot until 10 Sep 2026, and the model copies its examples closely.
composed('no h3 prompt file teaches a timestamp on [Shot 1] or a time range', () => {
  const bad = [];
  for (const rel of ['prompts/video/h3/SKILL.md', BASE_BLOCK, REF_BLOCK]) {
    const text = readTrimmed(rel);
    if (/\[Shot 1\][^\n\w]{0,3}(At\s+)?\d{2}:\d{2}/.test(text)) bad.push(`${rel}: [Shot 1] has a timestamp`);
    if (/\d{2}:\d{2}\s*[–-]\s*\d{2}:\d{2}/.test(text)) bad.push(`${rel}: a time range`);
    for (const m of text.matchAll(/\[Shot ([2-9])\]\s*(.{0,20})/g)) {
      // Mentions inside prose ("in [Shot 2].") are references, not shot openers.
      if (/^[.,)`]/.test(m[2])) continue;
      if (!/^At \d{2}:\d{2}\.\d{3},/.test(m[2])) bad.push(`${rel}: [Shot ${m[1]}] opens "${m[2]}"`);
    }
  }
  return bad.length === 0 ? true : bad.join('; ');
});

// The point of the exercise. Stated as a floor rather than an exact number so
// an edit to the guides does not fail this, but a change that quietly stops
// gating them does.
composed('gating actually removes material — a base mode is far smaller', () => {
  const base = composeSystemPrompt(ROOT, 'h3').system.length;
  const t2va = composeSystemPrompt(ROOT, 'h3', 'T2VA').system.length;
  if (t2va >= base) return `T2VA composed ${t2va} chars against a base of ${base}`;
  const saved = 1 - t2va / base;
  // Kept at 0.3. The fallback grew when the guides were sliced into three
  // files, so the RATIO barely moved even though a base mode lost ~1,900
  // tokens outright - the honest guard here is "gating still happens", and
  // the absolute win is asserted by the dropped-sections test above.
  return saved > 0.3
    ? true
    : `only ${Math.round(saved * 100)}% smaller — expected the reference guide and the examples to be gone`;
});

// Guards the other half of the old probe bug: a reference file the registry
// resolved but the prompt store then dropped would be invisible everywhere
// except a 40-run measurement.
composed('every reference file the registry resolved is really in the prompt', () => {
  for (const key of liveRegistry.keys()) {
    const { system, referenceFiles } = composeSystemPrompt(ROOT, key);
    for (const rel of referenceFiles) {
      // A substantial opening line identifies the file and survives edits to it.
      const head = readTrimmed(rel).split(NL).find((l) => l.trim().length > 20);
      if (head && !system.includes(head.trim())) {
        return `${key}: ${path.basename(rel)} resolved but its text is missing`;
      }
    }
  }
  return true;
});

// The composition change was meant to touch h3 alone. This is what makes that
// claim checkable without a GPU: the other nine must still be exactly two
// parts joined by the separator.
composed('models with no reference files compose house rules + own file, byte for byte', () => {
  const bad = [];
  let checked = 0;
  for (const key of liveRegistry.keys()) {
    const model = liveRegistry.get(key);
    // Skipped on what the prompt actually CARRIES, not on the flat field.
    // h3's guides moved to reference_files_by_mode on 3 Sep 2026, which
    // emptied `reference_files` and made h3 look reference-free to this loop —
    // it is not, and the byte-for-byte assertion rightly failed on it.
    const { system, config, referenceFiles, missingReferences } =
      composeSystemPrompt(ROOT, key);
    if (referenceFiles.length > 0 || missingReferences.length > 0) continue;
    checked += 1;
    const expected = [
      readTrimmed(config.prompts.shared_prefix),
      readTrimmed(model.system_prompt),
    ].join(SEPARATOR);
    if (system !== expected) bad.push(key);
  }
  if (checked === 0) return 'no reference-free models found — this proved nothing';
  return bad.length === 0 ? true : `composed something extra: ${bad.join(', ')}`;
});

// ── Settings that were measured, not chosen ────────────────────────
//
// Two config values contradict what a reader would otherwise reach for, and
// both were arrived at by measurement. A comment cannot stop someone
// "correcting" them; a failing test with the reason attached can.

console.log('');
console.log('settings that were measured — changing one should be deliberate');
console.log('');

composed('h3 still runs thinking: false, against what the spec asks for', () => {
  const h3 = liveRegistry.get('h3');
  if (h3.thinking !== false) {
    return [
      `h3.thinking is ${JSON.stringify(h3.thinking)}, expected false.`,
      'The spec says true. Measured on UD-Q3_K_XL that is unusable: SKILL.md',
      'says "Count it" about a 7,000 character limit, and with thinking on the',
      'model counts characters one at a time until the budget is gone — 12,450',
      'tokens of thinking, zero characters of answer. This is an',
      'instruction-following trap, not a capacity problem, so more VRAM does',
      'not fix it. If you are changing this on purpose, re-measure first and',
      'then update this test.',
    ].join(' ');
  }
  return true;
});

composed('llm.keep_alive is set, so the model is not reloaded every few minutes', () => {
  const { config } = composeSystemPrompt(ROOT, 'h3');
  const v = config.llm?.keep_alive;
  if (v == null || v === '') {
    return [
      'llm.keep_alive is unset, so Ollama falls back to its 5-minute default.',
      'That was the original state and it meant every generate after a pause',
      'paid a full model reload. "15m" assumes the GPU is shared with',
      'ComfyUI; "-1" never unloads, for a box that only runs this app.',
    ].join(' ');
  }
  return true;
});

console.log('\nand the real config must still load clean:');
try {
  const reg = loadRegistry(ROOT, { warn: () => {} });
  console.log(`  PASS  config/models.yaml loads — ${reg.keys().length} models`);
} catch (err) {
  console.log(`  FAIL  config/models.yaml no longer loads — ${err.message}`);
  failures += 1;
}

// ── chat is a separate surface from prompt assistance (22 Aug 2026) ──
//
// The bug this pins: house-rules.md is mostly an output contract — five
// references to `===SEGMENT:` including a worked example — and it used to be
// prepended to the chat prompt as well. chat/default.md says "The segment
// format does not apply here", and the 8B obeyed that, but the 1.7B followed
// the worked example and answered chat in segments, Negative prompt included.
//
// The two surfaces share a box and a list of installed LLMs. Nothing else.
{
  // The real config/server.yaml, via the same composer every probe uses.
  const liveConfig = composeSystemPrompt(ROOT, liveRegistry.keys()[0]).config;
  const store = createPromptStore(ROOT, liveConfig, liveRegistry, { warn: () => {} });
  const chat = store.chat();

  composed('the chat prompt exists', () => (chat ? true : 'chat() returned nothing'));

  // The whole point. If this fails, chat is being told how to emit segments.
  composed('chat carries no segment contract', () =>
    !chat.includes('===SEGMENT:')
      ? true
      : `chat prompt contains ${(chat.match(/===SEGMENT:/g) ?? []).length} segment references`
  );

  composed('chat does not open with the house rules', () =>
    !chat.startsWith(readTrimmed(liveConfig.prompts.shared_prefix))
      ? true
      : 'chat still begins with the shared prefix'
  );

  // Dropping the prefix must not drop the content rules. chat/default.md
  // carries its own, and that was checked before the prefix was removed —
  // this is what stops a later tidy-up from quietly removing them.
  composed('...but keeps content rules of its own', () =>
    /minor/i.test(chat) ? true : 'chat prompt no longer mentions the content boundary'
  );

  // The models are untouched. Byte-for-byte is the only claim worth making
  // here: composition order is a measured result worth 12/40 to 2/40 on one
  // h3 segment, and a change that "looked fine" is exactly how it would be
  // lost.
  composed('every model still opens with the house rules', () => {
    const bad = [];
    for (const key of liveRegistry.keys()) {
      const { system, config } = composeSystemPrompt(ROOT, key);
      if (!system.startsWith(readTrimmed(config.prompts.shared_prefix))) bad.push(key);
    }
    return bad.length === 0 ? true : `lost the house rules: ${bad.join(', ')}`;
  });

  // And the escape hatch still works, so this is a separation rather than a
  // hardcoded refusal.
  const withPrefix = createPromptStore(
    ROOT,
    { ...liveConfig, prompts: { ...liveConfig.prompts, chat_shared_prefix: liveConfig.prompts.shared_prefix } },
    liveRegistry,
    { warn: () => {} }
  ).chat();
  composed('chat_shared_prefix can put a prefix back if one is ever wanted', () =>
    withPrefix.startsWith(readTrimmed(liveConfig.prompts.shared_prefix))
      ? true
      : 'the configured chat prefix was not applied'
  );
}

console.log('\nruntime context - what the model cannot know\n');

{
  // Observed 22 Aug 2026: asked "what day is it", chat answered "Today is
  // April 5, 2024" - its training cutoff, stated with total confidence. The
  // same failure quietly poisons "which is the newest Illustrious version",
  // which is the sort of thing this group actually asks.
  const when = new Date('2026-08-22T14:32:00');
  const ctx = runtimeContext(when);

  composed('the date is stated in full', () =>
    /22 August 2026/.test(ctx) ? true : ctx);
  // "22/08/2026" reads as 8 August to half the people who might use this.
  composed('...with the weekday, and no ambiguous numeric form', () =>
    /Saturday/.test(ctx) && !/22[/]08/.test(ctx) ? true : ctx);
  composed('the time and zone are named', () =>
    /14:32/.test(ctx) && /[(].+[)]/.test(ctx) ? true : ctx);
  // Knowing the date is half of it. Knowing that its own knowledge is older
  // is what stops a confident answer about "the latest" version.
  composed('and it is told its training data is older than this', () =>
    /training data is older/i.test(ctx) ? true : ctx);

  // Injectable, or this could only be tested by waiting a day.
  const later = runtimeContext(new Date('2027-01-01T00:00:00'));
  composed('a different clock produces a different answer', () =>
    /1 January 2027/.test(later) ? true : later);

  // The failure that would make all of the above worthless: composed at boot
  // instead of per request. The store caches, so the check is that chat() has
  // no date in it and the server appends one.
  const liveCfg = composeSystemPrompt(ROOT, liveRegistry.keys()[0]).config;
  const cached = createPromptStore(ROOT, liveCfg, liveRegistry, { warn: () => {} }).chat();
  composed('the cached chat prompt carries no date of its own', () =>
    !/20\d\d/.test(cached.replace(/Aug 20\d\d/g, ''))
      ? true
      : 'a year appears in the cached prompt - is the date being baked in at boot?'
  );
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
