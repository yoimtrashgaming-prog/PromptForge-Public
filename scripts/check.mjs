// Everything that can be checked without a model loaded.
//
//   npm run check
//
// Twenty-four suites, each in its own process so one crashing does not take
// the rest with it. Nothing here needs Ollama, a GPU, or credentials, which is
// the whole selection rule: these are the checks that are always runnable,
// so there is never a reason to skip them.
//
// Deliberately NOT included, because each needs something this cannot
// promise:
//
//   smoke      needs a server already running, and credentials if it has
//              accounts on
//   dialect    needs a real model loaded to mean anything, and takes
//              minutes — it is the one that says whether a model swap broke
//              the app's real job, so it deserves to be run deliberately.
//              Its *pure predicates* are in, as dialect-helpers: those need
//              nothing, and a mangled escape in one of them is a silent pass
//              on a suite whose whole value is catching silent failures
//   probe-h3   same, plus it is a measurement rather than a test

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  ['registry', 'test-registry.mjs', 'bad models.yaml fails loudly; prompt composition order'],
  ['segments', 'test-segments.mjs', 'the ===SEGMENT: parser, including the streaming path'],
  ['failures', 'test-failures.mjs', 'the failure table, server side, against a broken backend'],
  ['taggers', 'test-taggers.mjs', 'upload validation and degradation; weights optional'],
  ['library', 'test-library.mjs', 'owner gate, library round trip, tag variants'],
  ['sharing', 'test-sharing.mjs', 'shared prompts, works-with, the standing instruction'],
  ['shared-images', 'test-shared-images.mjs', 'the image/prompt pairs, names as filenames, who may delete'],
  ['auth', 'test-auth.mjs', 'accounts, approval, the admin gate'],
  ['app', 'test-app.mjs', 'frontend pure helpers, the failure table UI, upload limits'],
  ['dead-config', 'dead-config.mjs', 'config keys nothing reads'],
  ['benchmarks', 'test-benchmarks.mjs', 'the markdown renderer escapes, and the sheet allowlist'],
  // The mechanism that lets one branch serve two machines. Every way it can
  // fail is silent, which is the whole reason it is in here.
  ['config', 'test-config.mjs', 'per-machine config overrides'],
  ['portability', 'check-portability.mjs', 'path case and line endings, for the Linux move'],
  // Fixtures and stubbed fetches throughout, so this needs no network even
  // though the feature it covers does.
  ['traits', 'test-traits.mjs', 'character trait ranking and degradation'],
  ['characters', 'test-characters.mjs', 'resolving a character from a brief, no network'],
  ['references', 'test-references.mjs', 'reference label classes, against the Director node'],
  ['h3-simple', 'test-h3-simple.mjs', 'the Director Simple prompt, against the node\'s own assembly'],
  ['picture-labels', 'test-picture-labels.mjs', 'h3 picture labels to cast, Auto detect and written segments'],
  ['gpu-holders', 'test-gpu-holders.mjs', 'who else holds the GPU, freeing idle ComfyUIs, the failed-load message'],
  ['shots', 'test-shots.mjs', 'h3 Shots control: the settings line and the count checked afterwards'],
  ['chat-prompt-tool', 'test-chat-prompt-tool.mjs', 'chat\'s write_prompt tool and the GPU names chat is told'],
  ['featuresetup', 'test-featuresetup.mjs', 'rendering and LoRA training from the setup wizard: finding ComfyUI, local config wins'],
  ['tagspacing', 'test-tagspacing.mjs', 'underscores out of a space-style model\'s tags, emoticons and score tags kept'],
  ['appearance', 'test-appearance.mjs', 'which tags describe a character and which describe the photo'],
  ['tagmerge', 'test-tagmerge.mjs', 'primary tagger plus a second opinion, and who wins a contradiction'],
  ['tagfilter', 'test-tagfilter.mjs', 'which danbooru tags are worth a row in the database'],
  ['parens', 'test-parens.mjs', 'literal parentheses escaped, weighting parentheses kept'],
  ['positive', 'test-positive.mjs', 'invented parenthesised tags and duplicates out, everything else left alone'],
  ['visiontags', 'test-visiontags.mjs', 'the vision cross-check: fails closed, and never adds an invented tag'],
  ['refblueprint', 'test-refblueprint.mjs', 'the look-first reference pass: numbering, role isolation, and what the analyst is not told'],
  ['tools', 'test-tools.mjs', 'the booru tag search tool: what the model is told, and that nothing throws'],
  ['candidates', 'test-candidates.mjs', 'brief to real tags with no model in the loop, and the noise that must not get in'],
  ['lexicon', 'test-lexicon.mjs', 'the paraphrase lexicon: the spec cases, reviewed tiers only, validated targets; SKIPs without the file'],
  ['tagpass', 'test-tagpass.mjs', 'the third pass: fake tags replaced or removed, modifiers and prose never touched'],
  ['media', 'test-media.mjs', 'ffmpeg probing and frame sampling; SKIPs without ffmpeg'],
  ['queue', 'test-queue.mjs', 'queue bookkeeping and who is generating what'],
  // A stub ComfyUI, websocket included, so what is SENT is asserted.
  ['render', 'test-render.mjs', 'render from PromptForge: workflow filling, caps, the grant, a render end to end'],
  // Its own temp file, unlike the suites it exists because of — those record
  // into the live counter, which is what the filter here is for.
  ['usage', 'test-usage.mjs', 'run counts, and showing only the models this box serves'],
  ['chat', 'test-chat.mjs', 'conversations: storage, routes, per-user separation'],
  // Runs against an Ollama-shaped stub rather than the mock backend: the
  // selector is a list of installed models, and the mock has none.
  ['chat-models', 'test-chat-models.mjs', 'the chat model selector and model requests'],
  // Observes the unload as a request the backend received, not as a 200.
  ['keepalive', 'test-keepalive.mjs', 'offload, offload all, and the unload timer'],
  // The stub records the user message, so what the model is TOLD is asserted
  // rather than inferred from what came back.
  ['controls', 'test-controls.mjs', 'custom positive, no quality preset, leaked aspect'],
  ['search', 'test-search.mjs', 'search parsers and every way a search can fail'],
  ['llm-finish', 'test-llm-finish.mjs', 'llama.cpp says when a token limit cut the answer off'],
  ['captions', 'test-captions.mjs', 'LoRA caption rules: trigger, excludes, spelling, MOSS JSON'],
  // The two entries that take arguments; the GPU half of both stays out.
  ['dialect-helpers', 'dialect-check.mjs', 'the dialect predicates, no server', ['--selftest']],
  // Same rule, same reason: this probe's two predicates are regexes whose
  // escapes were swallowed by a template literal the first time they were
  // written, and a broken one reports every generation clean — which reads
  // exactly like a prompt fix that worked.
  [
    'negative-leak',
    'probe-negative-leak.mjs',
    'the leak and example-echo predicates, no server',
    ['--selftest'],
  ],
];

const RULE = String.fromCharCode(0x2500).repeat(64);
const started = Date.now();
const results = [];

console.log('');
console.log('PromptForge — everything that needs no model');
console.log(RULE);

for (const [name, file, what, extraArgs] of SUITES) {
  const t0 = Date.now();
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', file), ...(extraArgs ?? [])], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const ms = Date.now() - t0;
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const passed = run.status === 0;

  // Suites report their own counts; surface it rather than re-deriving.
  // Read between the parentheses rather than with a regex — the pattern needs
  // escaped brackets, and a mangled escape silently matches nothing, which is
  // exactly what happened here the first time.
  const marker = 'ALL PASSED (';
  const at = output.indexOf(marker);
  const count = at === -1
    ? null
    : output.slice(at + marker.length, output.indexOf(')', at));
  const label = passed ? (count ? `ok, ${count} assertions` : 'ok') : 'FAILED';

  console.log(
    `  ${passed ? 'PASS' : 'FAIL'}  ${name.padEnd(15)} ${label.padEnd(20)} ${String(ms).padStart(5)}ms`
  );
  if (!passed) results.push([name, output]);
}

console.log(RULE);

if (results.length === 0) {
  console.log(`ALL PASSED — ${SUITES.length} suites in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('');
  console.log('Not covered here, and worth running deliberately:');
  console.log('  npm run smoke                 needs a running server');
  console.log('  npm run dialect -- --runs 3   needs a real model, and is the one');
  console.log('                                that says whether the models still');
  console.log('                                differ. --only narrows it to one.');
  console.log('');
  process.exit(0);
}

// Print the failing output rather than making someone re-run it to find out.
for (const [name, output] of results) {
  console.log('');
  console.log(`── ${name} ──`);
  const lines = output.split(String.fromCharCode(10)).filter((l) => l.trim());
  const interesting = lines.filter((l) => /FAIL|Error|error:/.test(l));
  for (const l of (interesting.length ? interesting : lines).slice(0, 15)) console.log(`  ${l}`);
}
console.log('');
console.log(`${results.length} of ${SUITES.length} suites FAILED`);
console.log('');
process.exit(1);
