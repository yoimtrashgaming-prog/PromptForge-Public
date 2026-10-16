/**
 * Download the H3 source documents this project reads but does not author.
 *
 * Two are MiniMax's official prompt-writing guides, into
 * prompts/video/h3/references/. H3 runs degraded without them: SKILL.md tells
 * the model to say so in Reasoning rather than guess at field names. They are
 * no longer loaded directly — scripts/section-h3-references.mjs slices them
 * into the per-mode files the registry names — so run that after a --force.
 *
 * The third is the DaSiWa MiniMax H3 Director documentation, into
 * docs/. Three code comments and config/models.yaml already cited that path
 * as the authority that settles disagreements with the official guides — the
 * node that consumes our output decides what is true — and the file none of
 * them pointed at had never been in the repository. The h3 panel's help
 * button serves it from there, so nothing in the UI sends anyone off the
 * tailnet.
 *
 * All three are gitignored: third-party documents, pulled locally to read
 * and not redistributed.
 *
 * Idempotent. Run: npm run fetch-h3-refs
 */
import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = 'prompts/video/h3/references';
const BASE = 'https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs';
const DASIWA =
  'https://raw.githubusercontent.com/darksidewalker/ComfyUI-DaSiWa-Nodes/main/docs';

// [directory to write into, filename to save as, full source URL]
const FILES = [
  [DIR, 'h3-base-official.md', `${BASE}/VIDEO_PROMPT_WRITING_GUIDE_base_en.md`],
  [DIR, 'h3-reference-official.md', `${BASE}/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md`],
  ['docs', 'minimax_h3_director.md', `${DASIWA}/minimax_h3_director.md`],
];

const force = process.argv.includes('--force');
let failed = 0;

await mkdir(DIR, { recursive: true });

for (const [dir, local, url] of FILES) {
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, local);

  if (!force) {
    try {
      const s = await stat(dest);
      if (s.size > 0) {
        console.log(`  skip   ${local} — already present (${s.size} bytes). --force to re-fetch.`);
        continue;
      }
    } catch {
      // not there yet; fall through and fetch
    }
  }

  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Normalise to LF: .gitattributes is eol=lf and this project migrates to
    // Linux. Written with fs, never PowerShell Set-Content — see CLAUDE.md.
    const text = (await res.text()).replace(/\r\n/g, '\n');
    if (!text.trim().startsWith('#')) {
      throw new Error('does not look like markdown — got an error page?');
    }

    await writeFile(dest, text, 'utf8');
    console.log(`  ok     ${local} — ${Buffer.byteLength(text)} bytes`);
  } catch (err) {
    failed++;
    console.error(`  FAIL   ${local} — ${err.message}`);
    console.error(`         source: ${url}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed. H3 will run degraded but the app still starts.`);
  console.error('Download them by hand per prompts/video/h3/references/README.md.');
  process.exit(1);
}
// Sliced straight away, as scripts/docker-start.sh does in a container. Until
// 3 Oct 2026 this printed "Now run: node scripts/section-h3-references.mjs",
// and the README only ever said to run this script, so an install without a
// container followed the instructions and got H3 in its reduced mode.
console.log('\nH3 references in place. Slicing them into the per-mode files...');
const section = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'section-h3-references.mjs')], { stdio: 'inherit' });
if (section.status !== 0) {
  console.error('\nSlicing failed. Run node scripts/section-h3-references.mjs by hand.');
  process.exit(1);
}
console.log('\nDone. Restart the server to load them.');
