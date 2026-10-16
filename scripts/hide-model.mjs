/**
 * Add model name prefixes to `llm.hidden_models` in config/server.local.yaml.
 *
 *   node scripts/hide-model.mjs "hf.co/mradermacher/ToriiGate"
 *   node scripts/hide-model.mjs nomic-embed-text eleanor trace forge
 *   node scripts/hide-model.mjs --list
 *   node scripts/hide-model.mjs --remove eleanor
 *
 * Why this exists rather than "open the file and add a line": the list is
 * per-machine and lives in the gitignored local override, so it can only be
 * changed ON the box it applies to. That means it gets edited over SSH, in a
 * hurry, on a live box — which is the worst possible time to hand-edit YAML.
 *
 * Two rules from CLAUDE.md are load-bearing here and both are honoured:
 *
 *   1. **Never edit config/ through PowerShell Set-Content.** This is Node,
 *      which is UTF-8 by default, and the write is explicit about it.
 *   2. The file is parsed with `parseDocument`, not `parse`, so **comments and
 *      formatting survive**. A local override usually carries a note about why
 *      the bind address is what it is, and a round trip through plain
 *      parse/stringify would silently delete it.
 *
 * Matching is by PREFIX, exactly as server.mjs does it, so "ToriiGate" catches
 * every quant tag of it. The configured `llm.model` is never hidden — server
 * side guarantees that — but this refuses to add it anyway, because a list
 * that looks like it hides your own model is confusing to read later.
 *
 * Restart the service afterwards; nothing here touches a running process.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, 'config', 'server.local.yaml');
const TRACKED = path.join(ROOT, 'config', 'server.yaml');

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const list = args.includes('--list');
const prefixes = args.filter((a) => !a.startsWith('--'));

if (!list && !prefixes.length) {
  console.error('Usage: node scripts/hide-model.mjs [--remove|--list] <prefix> [prefix...]');
  console.error('Example: node scripts/hide-model.mjs "hf.co/mradermacher/ToriiGate"');
  process.exit(2);
}

// The tracked file is the source of the configured model; the local one only
// overrides. Read both so we can refuse to hide the model the app runs on.
const configuredModel = (() => {
  try {
    const tracked = YAML.parse(readFileSync(TRACKED, 'utf8'));
    const local = existsSync(LOCAL) ? YAML.parse(readFileSync(LOCAL, 'utf8')) : null;
    return local?.llm?.model ?? tracked?.llm?.model ?? null;
  } catch {
    return null;
  }
})();

// parseDocument, not parse — this is what keeps the comments.
const doc = existsSync(LOCAL)
  ? YAML.parseDocument(readFileSync(LOCAL, 'utf8'))
  : YAML.parseDocument('# Per-machine overrides for config/server.yaml.\n# Gitignored: this file belongs to THIS box, not to the repo.\n');

// Captured before the write, or the report below always says "Updated".
const existedBefore = existsSync(LOCAL);

const current = doc.getIn(['llm', 'hidden_models']);
const existing = current?.toJSON ? current.toJSON() : Array.isArray(current) ? current : [];

if (list) {
  console.log(existsSync(LOCAL) ? `${LOCAL}` : `${LOCAL} (does not exist yet)`);
  console.log(existing.length ? existing.map((e) => `  ${e}`).join('\n') : '  (nothing hidden)');
  process.exit(0);
}

const refused = prefixes.filter((p) => configuredModel && configuredModel.startsWith(p));
const usable = prefixes.filter((p) => !refused.includes(p));

for (const p of refused) {
  console.warn(`refused: "${p}" matches the configured model ${configuredModel} — not adding it`);
}

const next = remove
  ? existing.filter((e) => !usable.includes(e))
  : [...new Set([...existing, ...usable])];

if (JSON.stringify(next) === JSON.stringify(existing)) {
  console.log('No change — the list already says that.');
  process.exit(0);
}

doc.setIn(['llm', 'hidden_models'], next);

// Explicit UTF-8, no BOM. The whole reason this script exists.
writeFileSync(LOCAL, doc.toString(), 'utf8');

console.log(`${existedBefore ? 'Updated' : 'Created'} ${LOCAL}`);
console.log('  before:', existing.length ? existing.join(', ') : '(empty)');
console.log('  after: ', next.length ? next.join(', ') : '(empty)');
console.log('\nRestart to apply:  sudo systemctl restart promptforge');
