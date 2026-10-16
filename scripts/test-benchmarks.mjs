// The benchmark sheets: the markdown renderer, and the allowlist.
//
//   node scripts/test-benchmarks.mjs
//
// Two things worth holding down here. The first is escaping — these sheets are
// full of angle brackets and shell fragments, and a renderer that lets one
// through is writing markup from a file. The second is the allowlist: the id
// in the URL must never be able to name a file outside the sheets folder.
//
// Needs no server, no backend and no network.

import { renderMarkdown, renderCompare, createBenchmarks, SHEETS, parseRunSheet, latestResults } from '../server/benchmarks.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The sheets live in data/benchmarks/ and are not in git (22 Sep 2026), so a
// fresh clone has none. The checks that read real sheets run only where the
// sheets are - the P40, the dev box - and the rest run everywhere.
const BENCH_DIR = path.join(ROOT, 'data', 'benchmarks');
const HAVE_SHEETS = fs.existsSync(path.join(BENCH_DIR, 'benchmarks.yaml'));

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

// ── escaping ─────────────────────────────────────────────────
{
  const out = renderMarkdown('A <script>alert(1)</script> in a paragraph.');
  check('markup in prose is escaped',
    !out.includes('<script>') && out.includes('&lt;script&gt;'), out);

  const table = renderMarkdown('| a | b |\n|---|---|\n| <img src=x> | ok |');
  check('markup in a table cell is escaped',
    !table.includes('<img src=x>') && table.includes('&lt;img'), table);

  const code = renderMarkdown('```\n<div class="x">\n```');
  check('markup in a code fence is escaped',
    !code.includes('<div class="x">') && code.includes('&lt;div'), code);
}

// ── tables, which are most of these documents ────────────────
{
  const out = renderMarkdown(
    '| Model | tok/s |\n|---|---:|\n| 27B | 16.4 |\n| 8B | 41.2 |\n\nAfter.'
  );
  check('a table becomes a table', /<table>/.test(out), out);
  check('...with its header in thead', /<thead><tr><th>Model<\/th>/.test(out), out);
  check('...and every body row', (out.match(/<tr>/g) ?? []).length === 3, out);
  check('...wrapped so a wide one scrolls itself',
    out.includes('<div class="table-wrap">'), out);
  check('the paragraph after the table is not swallowed',
    out.includes('<p>After.</p>'), out);
}

// ── inline, and the code-span rule ───────────────────────────
{
  const out = renderMarkdown('Use `**not bold**` here but **this is**.');
  check('emphasis inside a code span stays literal',
    out.includes('<code>**not bold**</code>'), out);
  check('...while emphasis outside one still applies',
    out.includes('<strong>this is</strong>'), out);

  const link = renderMarkdown('See [the sheet](https://example.com/x).');
  check('an http link is kept', /<a href="https:\/\/example.com\/x"/.test(link), link);
  const bad = renderMarkdown('See [x](javascript:alert(1)).');
  check('a javascript: link is dropped to plain text',
    !bad.includes('<a href') && bad.includes('x'), bad);
}

// ── headings, lists, rules ───────────────────────────────────
{
  const out = renderMarkdown('# One\n\n## Two\n\n- a\n- b\n\n---\n\ntail');
  check('headings render at their level',
    out.includes('<h1>One</h1>') && out.includes('<h2>Two</h2>'), out);
  check('a list renders', /<ul><li>a<\/li><li>b<\/li><\/ul>/.test(out), out);
  check('a horizontal rule renders', out.includes('<hr>'), out);
}

// ── the allowlist ────────────────────────────────────────────
{
  const bench = createBenchmarks(ROOT);
  const listed = bench.list();

  check('every listed sheet has a title, date and summary',
    listed.every((s) => s.title && s.date && s.summary), JSON.stringify(listed.map((s) => s.id)));
  check('...and reports its format',
    listed.every((s) => s.format === 'html' || s.format === 'markdown'), '');
  check(HAVE_SHEETS ? 'every known sheet on this box is listed' : 'a fresh clone lists no sheets',
    HAVE_SHEETS
      ? listed.filter((s) => !s.id.startsWith('local-') && s.id !== 'latest').length === SHEETS.length
      : listed.length === 0,
    `${listed.length} of ${SHEETS.length} — missing: ${SHEETS.filter((s) => !listed.find((l) => l.id === s.id)).map((s) => s.file).join(', ')}`);

  // The whole reason the id is looked up rather than joined onto a path.
  for (const evil of ['../config/server', '../../etc/passwd', 'status', 'security-plan', '']) {
    check(`"${evil}" resolves to nothing`, bench.render(evil) === null, '');
  }

  // Owner's call, 4 Sep 2026: this tab shows measurements of the serving box
  // and nothing else. On 11 Sep that box became P40 + V100, and the owner
  // asked for the two side by side — so the V100 sheet and the comparison are
  // in, and the retired RTX 5080 dev box is still out. model-eval stays on
  // disk because it holds the Phase 0 ground truth CLAUDE.md sends every new
  // session to check. Asserted rather than trusted to a comment, because
  // adding a row back is one line and looks harmless.
  check('the retired dev box sheet is not offered',
    !listed.some((s) => s.id === 'model-eval') && bench.render('model-eval') === null, '');
  // Only in the private master: the public copy leaves archive/ out.
  check('...but its file is still on disk',
    !fs.existsSync(path.join(ROOT, 'archive')) || fs.existsSync(path.join(ROOT, 'archive', 'docs', 'model-eval-2026-08-18.md')),
    'model-eval-2026-08-18.md is gone — it carries the Phase 0 ground truth');
  check('every listed sheet measures the serving box or is hardware-independent',
    listed.every((s) => s.id.startsWith('local-') || s.id === 'latest' ||
      ['p40-vs-v100', 'v100-candidates', 'v100-bench', 'p40-bench', 'engine-eval', 'traits-eval'].includes(s.id)),
    listed.map((s) => s.id).join(', '));
  if (HAVE_SHEETS) {
    // Sheets this box added itself (a Run benchmark result) go on top; of
    // the known ones, the comparison leads.
    const known = listed.filter((s) => !s.id.startsWith('local-') && s.id !== 'latest');
    check('the comparison leads the known sheets',
      known[0]?.id === 'p40-vs-v100', known[0]?.id);
  }

  for (const sheet of listed) {
    const html = bench.render(sheet.id);
    check(`${sheet.id} renders a whole document`,
      html.startsWith('<!doctype html>') && html.includes('</html>'), html?.slice(0, 60));
    check(`${sheet.id} carries its title`, html.includes(`<title>`), '');
  }

  // The hand-written sheet keeps its own stylesheet AND gets the remap after
  // it. Losing either would leave it unstyled or stuck on its own palette.
  const p40 = bench.render('p40-bench');
  if (p40) {
    check('the html sheet keeps its own styles', p40.includes('--track'), '');
    check('...and gets the app palette appended after them',
      p40.lastIndexOf('--bg:var(--bg-base') > p40.indexOf('<style>'), '');
  }

  // A markdown sheet must carry no colour of its own — that is what lets it
  // follow all seven themes.
  const md = bench.render('engine-eval');
  if (md) {
    check('a markdown sheet defines no hex palette of its own',
      !/:root\{--bg:#/.test(md), '');
    check('...and reads its colours from the app variables',
      md.includes('var(--bg-base'), '');
  }
}

// ── the master sheet: Latest results ─────────────────────────
//
// Drawn from every Run benchmark sheet, one row per model AND card. Built from
// sheets in the exact format server/benchrun.mjs writes.
{
  const sheet = (at, hw, rows) =>
    `# Benchmark run, ${at} UTC\n\n**Hardware:** ${hw}. **Backend:** llamacpp. \n\nprose\n\n` +
    '| Model | First reply (cold, s) | Prompt reading (tok/s) | Writing (tok/s) | Writing range | Runs |\n' +
    '|---|---:|---:|---:|---:|---:|\n' + rows.join('\n') + '\n';
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pf-latest-'));
  const V = 'Tesla V100 (32 GB)';
  const P = 'Tesla P40 (24 GB)';
  fs.writeFileSync(path.join(tmp, 'benchmark-20260922-0615.md'), sheet('2026-09-22 06:15', V, [
    '| model-a | 6.0 | 565 | **58.2** | 58.2–58.2 | 3 |',
    '| model-b | 30.1 | 200 | **16.4** | 16.3–16.5 | 3 |',
  ]));
  fs.writeFileSync(path.join(tmp, 'benchmark-20260923-0100.md'), sheet('2026-09-23 01:00', V, [
    '| model-a | 5.0 | 570 | **61.3** | 61.0–61.6 | 3 |',
    '| model-b | failed: out of memory | | | | 0 |',
    '| model-c | failed: will not load | | | | 0 |',
  ]));
  fs.writeFileSync(path.join(tmp, 'benchmark-20260924-0100.md'), sheet('2026-09-24 01:00', P, [
    '| model-a | 9.0 | 300 | **30.0** | 30.0–30.0 | 3 |',
  ]));

  const parsed = parseRunSheet(fs.readFileSync(path.join(tmp, 'benchmark-20260922-0615.md'), 'utf8'));
  check('a run sheet reads back', parsed?.hardware === V && parsed.rows.length === 2 && parsed.rows[0].decode_tps === 58.2,
    JSON.stringify(parsed));
  check('something that is not a run sheet reads as nothing', parseRunSheet('# Mine\n\ntext') === null, '');

  const b = createBenchmarks(ROOT, { dir: tmp });
  const l = b.list();
  check('the master sheet is listed first', l[0]?.id === 'latest' && l[0].date === '2026-09-24', JSON.stringify(l[0]));
  check('...and the dated runs stay listed below it', l.filter((s) => s.id.startsWith('local-benchmark-')).length === 3, '');

  const entries = latestResults(fs.readdirSync(tmp).map((n) => parseRunSheet(fs.readFileSync(path.join(tmp, n), 'utf8'))));
  const a = entries.find((e) => e.model === 'model-a' && e.hardware === V);
  check('a re-run model shows its newest numbers', a?.latest?.decode_tps === 61.3 && a.latest.at === '2026-09-23 01:00', JSON.stringify(a));
  check('...with the run before it kept for the change', a?.previous?.decode_tps === 58.2, '');
  check('the same model on another card is its own row, not an average',
    entries.find((e) => e.model === 'model-a' && e.hardware === P)?.latest?.decode_tps === 30.0, '');
  const bRow = entries.find((e) => e.model === 'model-b');
  check('a failed re-run keeps the last good numbers and says it failed',
    bRow?.latest?.decode_tps === 16.4 && bRow.lastFailed?.why === 'out of memory', JSON.stringify(bRow));

  const html = b.render('latest');
  check('the master sheet renders', html?.startsWith('<!doctype html>') && html.includes('Latest results'), '');
  check('...one section per card', html.includes(`<h2>${V}</h2>`) && html.includes(`<h2>${P}</h2>`), '');
  check('...with the change in writing speed', html.includes('(+3.1)'), '');
  check('...fastest first within a card', html.indexOf('model-a') < html.indexOf('model-b'), '');
  check('...and a model that only ever failed says so', /model-c<\/td><td>failed/.test(html), '');

  const empty = createBenchmarks(ROOT, { dir: path.join(tmp, 'none') });
  check('no runs, no master sheet', !empty.list().some((s) => s.id === 'latest') && empty.render('latest') === null, '');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── a sheet somebody drops into the folder ───────────────────
//
// Anyone measuring their own box can add a sheet without editing code. It is
// listed by its file name, and only ever matched against the folder's own
// listing: an id cannot climb out of the folder.
{
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pf-bench-'));
  fs.writeFileSync(path.join(tmp, 'my-rtx-4090_run.md'), '# Mine\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'not a sheet');
  fs.writeFileSync(path.join(tmp, 'no_heading.md'), 'Just a table.\n\n| a |\n|---|\n| 1 |');
  const b = createBenchmarks(ROOT, { dir: tmp });
  const all = b.list();
  const l = all.filter((s) => s.id === 'local-my-rtx-4090-run');
  check('dropped-in markdown files are listed',
    all.length === 2 && l.length === 1, JSON.stringify(all));
  check('...titled from their own heading', l[0]?.title === 'Mine', l[0]?.title);
  check('...or from the file name when there is none',
    all.find((s) => s.id === 'local-no-heading')?.title === 'no heading', JSON.stringify(all));
  check('...and renders', (b.render('local-my-rtx-4090-run') ?? '').includes('<table>'), '');
  check('a file that is not .md or .html is not listed', !l.some((s) => s.file === 'notes.txt'), '');
  for (const evil of ['local-../../config/server', 'local-notes', '../notes.txt']) {
    check(`"${evil}" resolves to nothing`, b.render(evil) === null, '');
  }
  const none = createBenchmarks(ROOT, { dir: path.join(tmp, 'missing') });
  check('a missing folder lists nothing and does not throw', none.list().length === 0, '');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── the results record ───────────────────────────────────────
//
// data/benchmarks/benchmarks.yaml is the sheets' numbers as data, so a second machine can
// be put beside the first. The assertions here are all about one property:
// a run must carry the conditions it was taken under. A tok/s figure whose
// context length is unknown cannot be compared with anything, and a
// comparison view that lines two of those up is worse than no view.
if (HAVE_SHEETS) {
  const raw = fs.readFileSync(path.join(BENCH_DIR, 'benchmarks.yaml'), 'utf8');
  const data = YAML.parse(raw);

  check('the record parses and has both blocks',
    !!data.machines && Array.isArray(data.runs), '');
  check('every run names a machine that exists',
    data.runs.every((r) => data.machines[r.machine]),
    data.runs.filter((r) => !data.machines[r.machine]).map((r) => r.id).join(', '));
  check('every run cites the sheet it came from',
    data.runs.every((r) => SHEETS.some((s) => s.id === r.sheet)),
    data.runs.filter((r) => !SHEETS.some((s) => s.id === r.sheet)).map((r) => r.id).join(', '));
  check('run ids are unique',
    new Set(data.runs.map((r) => r.id)).size === data.runs.length, '');

  // The rule the whole file exists for.
  const NEEDED = ['engine', 'context', 'kv_cache'];
  const naked = data.runs.filter((r) => NEEDED.some((k) => r.conditions?.[k] === undefined));
  check('every run states engine, context and kv cache',
    naked.length === 0, naked.map((r) => r.id).join(', '));

  check('every run carries at least one decode figure',
    data.runs.every((r) => Array.isArray(r.decode_tok_s) && r.decode_tok_s.length), '');
  check('...and they are all numbers',
    data.runs.every((r) => r.decode_tok_s.every((n) => typeof n === 'number' && n > 0)), '');

  // A machine with no measurements must say so, or its spec-sheet figures
  // will eventually be read as results.
  for (const [key, m] of Object.entries(data.machines)) {
    const has = data.runs.some((r) => r.machine === key);
    check(`machine "${key}" is either measured or marked unmeasured`,
      has || m.unmeasured === true,
      has ? '' : 'no runs and no unmeasured marker');
    if (m.unmeasured) {
      check(`...and "${key}" carries no results`, !has,
        'marked unmeasured but has runs — drop the marker');
    }
  }

  // ── pairs, which are what the comparison sheet draws ─────
  //
  // A pair is one row on each machine under the same id. Three rows, or two
  // on one card, would draw a comparison of nothing.
  const measures = data.measures ?? [];
  const [ka, kb] = Object.keys(data.machines);
  const pairs = new Map();
  for (const r of [...data.runs, ...measures]) {
    if (r.pair) pairs.set(r.pair, [...(pairs.get(r.pair) ?? []), r]);
  }
  const lopsided = [...pairs].filter(([, rs]) =>
    rs.length !== 2 || !rs.some((r) => r.machine === ka) || !rs.some((r) => r.machine === kb));
  check('every pair is one row on each machine', lopsided.length === 0,
    lopsided.map(([p]) => p).join(', '));

  const badMeasure = (m) =>
    !data.machines[m.machine] || !SHEETS.some((s) => s.id === m.sheet) ||
    typeof m.value !== 'number' || !m.unit || !['higher', 'lower'].includes(m.better) ||
    NEEDED.some((k) => m.conditions?.[k] === undefined);
  check('every measure names its machine, sheet, number, unit, direction and conditions',
    !measures.some(badMeasure), measures.filter(badMeasure).map((m) => m.id).join(', '));
  check('ids are unique across runs and measures',
    new Set([...data.runs, ...measures].map((r) => r.id)).size === data.runs.length + measures.length, '');

  const cmp = createBenchmarks(ROOT).render('p40-vs-v100') ?? '';
  const undrawn = [...pairs.keys()].filter((p) => !cmp.includes(`data-pair="${p}"`));
  check('the comparison draws every pair',
    cmp.startsWith('<!doctype html>') && undrawn.length === 0, undrawn.join(', '));
  check('...in the app palette, with none of its own',
    cmp.includes('var(--accent') && !/:root\{--bg:#/.test(cmp), '');

  // One-card rows: a model that cannot run on the other card is drawn alone,
  // but only when it says why. A `solo` row with a pair would be drawn twice.
  const solo = data.runs.filter((r) => r.solo);
  check('every solo run says why and has no pair',
    solo.every((r) => typeof r.solo === 'string' && r.solo.trim() && !r.pair),
    solo.filter((r) => !(typeof r.solo === 'string' && r.solo.trim()) || r.pair).map((r) => r.id).join(', '));
  const soloUndrawn = solo.filter((r) => !cmp.includes(`data-solo="${r.id}"`)).map((r) => r.id);
  check('the comparison draws every solo run', soloUndrawn.length === 0, soloUndrawn.join(', '));
}

// ── the comparison renderer, on data made up to break it ─────
{
  const html = renderCompare({
    machines: { a: { name: '<img src=x>', vram_mib: 100 }, b: { name: 'B', vram_mib: 200 } },
    runs: [
      { id: 'a1', pair: 'x', machine: 'a', sheet: 's', label: '<script>1</script>',
        decode_tok_s: [10], conditions: { engine: 'e', context: 1, kv_cache: 'f16', draft_head: 'MTP' } },
      { id: 'b1', pair: 'x', machine: 'b', sheet: 's',
        decode_tok_s: [20], conditions: { engine: 'e', context: 2, kv_cache: 'f16', draft_head: 'MTP' } },
      { id: 'b2', machine: 'b', sheet: 's', decode_tok_s: [5], conditions: {} },
    ],
  });
  check('names and labels from the data are escaped',
    !html.includes('<script>1') && !html.includes('<img src=x>'), '');
  check('a pair whose conditions differ says which one',
    html.includes('class="differs"') && html.includes('context: 1 / 2'), '');
  check('the multiplier is the second machine over the first', html.includes('2.00×'), '');
  check('a row with no pair is counted, not drawn',
    html.includes('1 recorded result has no counterpart') && !html.includes('data-pair="b2"'), '');
}

console.log();
console.log('benchmark sheets');
console.log();
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log();
  console.log(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
