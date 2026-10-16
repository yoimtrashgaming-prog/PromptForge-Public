/**
 * Preflight check. Run: npm run doctor
 *
 * Written for someone who is not a developer. Every failure says what is
 * wrong and exactly what to do about it, in plain words. Nothing here
 * changes any file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const results = [];
const ok = (what) => results.push({ state: 'ok', what });
const bad = (what, why, fix) => results.push({ state: 'bad', what, why, fix });
const warn = (what, why, fix) => results.push({ state: 'warn', what, why, fix });

// ── Node version ──
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node}`,
  'This project needs Node 22 or newer.',
  'Install the current LTS from https://nodejs.org and run this again.');

// ── Dependencies ──
if (existsSync('node_modules/yaml')) ok('Dependencies installed');
else bad('Dependencies missing', 'The one package this project needs is not installed.',
  'Run: npm install');

// ── Config loads ──
try {
  const { parse } = await import('yaml');
  const models = parse(readFileSync('config/models.yaml', 'utf8'));
  const n = Object.keys(models?.models ?? models ?? {}).length;
  ok(`config/models.yaml reads fine (${n} models)`);
} catch (err) {
  bad('config/models.yaml is broken', err.message,
    'If you edited it, undo that: git checkout config/models.yaml\n' +
    '       NEVER edit files in config/ or prompts/ with PowerShell Set-Content —\n' +
    '       it corrupts them. Use a normal text editor or Node.');
}

// ── H3 reference guides ──
const guides = [
  'prompts/video/h3/references/h3-base-official.md',
  'prompts/video/h3/references/h3-reference-official.md',
];
const missing = guides.filter((g) => !existsSync(g));
if (!missing.length) ok('H3 reference guides present');
else warn(`H3 reference guides missing (${missing.length} of 2)`,
  'The app still works. The MiniMax H3 model will produce weaker output and will say so.',
  'Run: npm run fetch-h3-refs');

// ── Image taggers ──
// Read through loadConfig so taggers.local.yaml counts - the base file alone
// is not what the server runs with, and checking it alone once made a working
// P40 look like it had lost two of its three taggers.
try {
  const { loadConfig } = await import('../server/config.mjs');
  const { config: tcfg } = loadConfig(process.cwd(), 'taggers');
  for (const [key, t] of Object.entries(tcfg?.taggers ?? {})) {
    const gone = [t.model, t.labels].filter((p) => p && !existsSync(p));
    if (!gone.length) ok(`Tagger ${key} ready`);
    else warn(`Tagger ${key} not installed`,
      `Image Analysis cannot use it. Missing: ${gone.join(', ')}`,
      'Follow docs/taggers-setup.md (or hand that file to an AI coding assistant).');
  }
} catch (err) {
  warn('config/taggers.yaml could not be read', err.message, 'Image Analysis will be unavailable.');
}

// ── Ollama ──
let tags = null;
try {
  const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) });
  tags = await res.json();
  ok('Ollama is running');
} catch {
  warn('Ollama is not running',
    'Only needed to actually generate prompts in the app. The contributor' +
    ' tasks in docs/contributor-handoff.md do NOT need it.',
    'Install it from https://ollama.com, then open a terminal and run: ollama serve\n' +
    '       Leave that window open.');
}

// ── The model itself ──
if (tags) {
  const have = (tags.models ?? []).map((m) => m.name);
  let want = 'qwen3:8b';
  try {
    const { parse } = await import('yaml');
    want = parse(readFileSync('config/server.yaml', 'utf8'))?.llm?.model ?? want;
    // The per-machine override, which is where a deployment names its real
    // model - config/server.yaml holds the shared default and the box that
    // serves this app usually does not run it. Without this, doctor on the
    // P40 asks for the Windows model and reports it missing on a machine
    // that is correctly configured. Same precedence the app itself uses.
    try {
      want = parse(readFileSync('config/server.local.yaml', 'utf8'))?.llm?.model ?? want;
    } catch { /* no local override on this box, which is the normal case */ }
  } catch { /* fall back to the default above */ }
  want = process.env.PROMPTFORGE_LLM_MODEL ?? want;

  // Ollama always reports the tag - `qwen3:8b`, `qwen3.8-27b-heretic:latest`
  // - while a configured name often omits it, since that is what a person
  // types and what `ollama run` accepts. So compare with the tag filled in on
  // both sides, the same normalisation the vision cross-check uses.
  //
  // NOT a family prefix. This read `h.startsWith(want.split(':')[0])`, which
  // accepted any model sharing a name before the colon: a box holding only
  // qwen3:1.7b was told that qwen3:8b was downloaded, and doctor finished with
  // "Everything is ready." A setup check that passes when the thing is absent
  // is worse than no check, because the failure surfaces later as a 404 from
  // ollama that reads like a broken URL.
  const tagged = (s) => (String(s).includes(':') ? String(s) : `${s}:latest`);
  if (have.some((h) => tagged(h) === tagged(want))) ok(`Model "${want}" is downloaded`);
  else warn(`Model "${want}" is not downloaded`,
    `Ollama is running but does not have it. It has: ${have.join(', ') || '(nothing)'}
         Not needed for the contributor tasks — only to generate prompts yourself.`,
    `Run: ollama pull ${want}\n       This downloads several GB and takes a while.`);
}

// ── Git identity ──
try {
  const name = execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const email = execSync('git config user.email', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (name && email) ok(`Git identity set (${name})`);
  else throw new Error('empty');
} catch {
  bad('Git identity not set',
    'Git refuses to save your work until it knows who you are.',
    'Run these two, with your own name and email:\n' +
    '       git config user.name "Your Name"\n' +
    '       git config user.email "you@example.com"');
}

// ── Report ──
const pad = (s) => s + ' '.repeat(Math.max(0, 46 - s.length));
console.log('\nPromptForge — setup check\n' + '─'.repeat(60));
for (const r of results) {
  const mark = r.state === 'ok' ? '  OK  ' : r.state === 'warn' ? ' WARN ' : ' FAIL ';
  console.log(`[${mark}] ${pad(r.what)}`);
  if (r.why) console.log(`         ${r.why}`);
  if (r.fix) console.log(`         → ${r.fix}`);
}

const fails = results.filter((r) => r.state === 'bad').length;
const warns = results.filter((r) => r.state === 'warn').length;
console.log('─'.repeat(60));
if (!fails && !warns) console.log('Everything is ready. Start it with:  npm start\n');
else if (!fails) console.log(`Ready to go — ${warns} thing(s) worth fixing but nothing blocking.\nStart it with:  npm start\n`);
else console.log(`${fails} thing(s) need fixing first. Do the → steps above, then run this again:\n  npm run doctor\n`);
process.exit(fails ? 1 : 0);
